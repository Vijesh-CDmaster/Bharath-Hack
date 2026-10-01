// BullMQ worker — consumes execution jobs, writes results + ledger entries.
// Run: npm run worker   (requires REDIS_URL; the API degrades to inline execution without it)
import "dotenv/config";
import { Worker } from "bullmq";
import { EXECUTION_QUEUE } from "./queues";
import { getSession, saveSession } from "../repositories/sessions";
import { geminiAdapters } from "../lib/ai/provider";
import { stackTextOf } from "../lib/pipeline/gates";
import { recordToLedger } from "../services/ledger";
import { checkExternalReferences } from "../lib/verification/external";
import { escalationFloorFor, verificationDepthFor } from "../lib/thresholds";
import { updateFromOutcome } from "../services/reputation";
import { alternateModelOf, modelCostOf } from "../schemas/pipeline";
import { forecastTaskFailure } from "../services/forecast";
import { initialTrustBudget, trustCostFor } from "../lib/trust-budget";
import { certificateFor } from "../lib/certificates";
import { codeArtifactOf, type ExecutionResult, type PipelineSession } from "../schemas/pipeline";
import { applyFileOpToSession } from "../services/workspace";
import { extractFileOps } from "../services/fileops";
import { assertModelsFinalized, ensureBudgetSizedToPlan } from "../services/execution";
import { ensurePreviewEntry, ensureProjectScaffolding } from "../services/scaffold";

async function executeSession(orgId: string, sessionId: string): Promise<void> {
  const session: PipelineSession | null = await getSession(orgId, sessionId);
  if (!session || !session.routing || !session.workflow || !session.algorithms) return;
  // Same explicit Models-finalized gate as the inline HTTP path — no bypass via the queue.
  assertModelsFinalized(session);
  session.trustBudget ??= { initial: initialTrustBudget(), remaining: initialTrustBudget(), consumed: 0, status: "active" };
  await ensureBudgetSizedToPlan(orgId, sessionId, session);

  const stackText = stackTextOf(session);
  const done = new Set(session.executions.map((e) => e.taskId));
  const ordered: typeof session.workflow.tasks = [];
  const all = [...session.workflow.tasks];
  let guard = 0;
  while (ordered.length < all.length && guard++ < all.length * 2) {
    for (const t of all) {
      if (done.has(t.id)) continue;
      if ((t.dependsOn ?? []).every((d) => done.has(d))) {
        ordered.push(t);
        done.add(t.id);
      }
    }
  }

  session.gate = "execution";
  session.gateStatus = "running";
  await saveSession(orgId, session);

  for (const task of ordered) {
    if (session.executions.some((r) => r.taskId === task.id)) continue;
    const budgetCost = trustCostFor(task.risk);
    if (session.trustBudget.remaining < budgetCost) {
      session.trustBudget.status = "exhausted";
      session.gateStatus = "awaiting_user";
      await recordToLedger({ orgId, sessionId, gate: "execution", eventType: "trust_budget_exhausted", actor: "system", detail: { summary: `Trust budget paused before ${task.title}`, required: budgetCost, budget: session.trustBudget } });
      // Paused ≠ broken: scaffold + preview entry must exist for the workspace too.
      await ensureProjectScaffolding(orgId, session);
      await ensurePreviewEntry(orgId, session);
      await saveSession(orgId, session);
      return;
    }
    session.trustBudget.remaining -= budgetCost;
    session.trustBudget.consumed += budgetCost;
    await recordToLedger({ orgId, sessionId, gate: "execution", eventType: "trust_budget_consumed", actor: "system", taskId: task.id, detail: { summary: `${budgetCost} trust units consumed by ${task.title}`, risk: task.risk, remaining: session.trustBudget.remaining } });
    const route = session.routing.routes.find((r) => r.taskId === task.id);
    const algo = session.algorithms.tasks.find((a) => a.taskId === task.id);
    const model = route?.selectedModel ?? "openai/gpt-oss-20b";
    const algorithm = algo?.selected ?? "direct implementation";
    const started = Date.now();
    try {
      const challengerModel = task.risk === "high" ? alternateModelOf(model) : undefined;
      const failureForecast = await forecastTaskFailure({ orgId, model, taskCategory: task.category, risk: task.risk });
      const [exec, challenger] = await Promise.all([
        geminiAdapters.executeTask({ task, algorithm, stack: stackText, workflow: session.workflow, model, targetPlatform: session.targetPlatform }),
        challengerModel
          ? geminiAdapters.executeTask({ task, algorithm, stack: stackText, workflow: session.workflow, model: challengerModel, targetPlatform: session.targetPlatform })
          : Promise.resolve(undefined),
      ]);

      // Real file operations (same pipeline as the inline executor).
      const ops = extractFileOps(exec.output);
      const appliedFileOps: ExecutionResult["fileOps"] = [];
      for (const op of ops) {
        const res = applyFileOpToSession(session, op, { taskId: task.id, model });
        appliedFileOps.push(
          res.ok
            ? { path: res.op.path, operation: res.op.operation, rejected: false }
            : { path: op.path, operation: op.operation, rejected: true, reason: res.reason.slice(0, 300) }
        );
      }

      const verificationDepth = verificationDepthFor(task.risk);
      const needsSecondModel = verificationDepth === "second_model";
      const verification = needsSecondModel
        ? await geminiAdapters.verifyOutput({ task, algorithm, output: exec.output, model })
        : await geminiAdapters.verifyRulesOnly({ task, output: exec.output });

      // File-aware check (same rule as the inline executor): a coding task whose
      // output contained no file operations cannot count as "verified".
      if (ops.length === 0 && task.category !== "documentation") {
        verification.passed = false;
        verification.issues = [
          ...verification.issues,
          "No structured file operations found in model output (expected {files:[...]} JSON or path-declared code blocks).",
        ].slice(0, 12);
        verification.checkedBy = `${verification.checkedBy} + fileops`;
      }

      const external = await checkExternalReferences(exec.output);
      if (!external.passed) {
        verification.passed = false;
        verification.issues = [
          ...verification.issues,
          ...external.unsupported.map((p) => `References non-existent npm package "${p}" (registry check).`),
        ].slice(0, 12);
        verification.checkedBy = `${verification.checkedBy} + npm_registry`;
      }

      const floor = escalationFloorFor(task.risk);
      const confidence = verification.passed ? 0.82 : 0.4;
      const status: ExecutionResult["status"] = verification.passed
        ? confidence >= floor ? "verified" : "escalated"
        : "flagged";
      const result: ExecutionResult = {
        taskId: task.id,
        model,
        output: exec.output,
        code: codeArtifactOf(exec.output, task.title),
        fileOps: appliedFileOps,
        servedBy: exec.servedBy,
        verification: {
          method: needsSecondModel ? "second_model" : "rules",
          passed: verification.passed,
          issues: verification.issues,
          checkedBy: verification.checkedBy || "rules",
        },
        status,
        confidence,
        rationale: verification.passed
          ? `Verification passed at the ${task.risk}-risk escalation floor (${floor}).`
          : `Flagged because verification found ${verification.issues.length} issue(s).`,
        alternatives: [],
        battleA: challenger ? { model, output: exec.output, latencyMs: exec.latencyMs, tokens: exec.tokens } : undefined,
        battleB: challenger && challengerModel ? { model: challengerModel, output: challenger.output, latencyMs: challenger.latencyMs, tokens: challenger.tokens } : undefined,
        failureForecast,
        latencyMs: exec.latencyMs,
        tokens: exec.tokens,
      };
      result.certificate = certificateFor(session, result);
      session.executions.push(result);

      const outcome: "verified" | "flagged" | "escalated" | "rejected" =
        status === "verified" ? "verified" : status === "flagged" ? "flagged" : status === "escalated" ? "escalated" : "rejected";
      await updateFromOutcome({ orgId, model, taskCategory: task.category, outcome }).catch(() => undefined);

      await recordToLedger({
        orgId,
        sessionId,
        gate: "execution",
        eventType: "task_execution",
        taskId: task.id,
        model,
        detail: {
          summary: `${task.title} executed by ${exec.servedBy ?? model} — ${status}`,
          latencyMs: exec.latencyMs,
          tokens: exec.tokens,
          servedBy: exec.servedBy ?? model,
          costUnits: modelCostOf(model),
          externalChecked: external.checked.length,
          externalUnsupported: external.unsupported,
          escalationFloor: floor,
          verificationDepth,
          battleAuto: Boolean(challenger),
          failureForecast,
        },
        verification: { passed: verification.passed, issues: verification.issues },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Task failed";
      const failed: ExecutionResult = {
        taskId: task.id,
        model,
        output: "",
        verification: { method: "rules", passed: false, issues: [message], checkedBy: "rules" },
        status: "failed",
        confidence: 0,
        rationale: `Execution failed before verification: ${message}`,
        alternatives: [],
        latencyMs: Date.now() - started,
        tokens: { input: 0, output: 0 },
      };
      session.executions.push(failed);
      await updateFromOutcome({ orgId, model, taskCategory: task.category, outcome: "rejected" }).catch(() => undefined);
      await recordToLedger({
        orgId,
        sessionId,
        gate: "execution",
        eventType: "task_failed",
        taskId: task.id,
        model,
        detail: { summary: `${task.title} failed: ${message}`, latencyMs: Date.now() - started },
        verification: { passed: false, issues: [message] },
      });
    }
    await saveSession(orgId, session);
  }

  // Same post-pass as the inline executor: industrial scaffolding + guaranteed
  // preview entry for web projects (best-effort, never fails the run).
  await ensureProjectScaffolding(orgId, session);
  await ensurePreviewEntry(orgId, session);

  session.gate = "review";
  session.gateStatus = "awaiting_user";
  await saveSession(orgId, session);
}

export function startWorker(): Worker {
  const worker = new Worker(
    EXECUTION_QUEUE,
    async (job) => {
      const { sessionId, orgId } = job.data as { sessionId: string; orgId: string };
      console.log(`[worker] executing session ${sessionId}`);
      await executeSession(orgId, sessionId);
      console.log(`[worker] finished session ${sessionId}`);
    },
    { connection: { url: process.env.REDIS_URL! }, concurrency: Number(process.env.WORKER_CONCURRENCY || 2) }
  );
  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err.message);
  });
  return worker;
}

if (require.main === module) {
  if (!process.env.REDIS_URL) {
    console.error("[worker] REDIS_URL is not set. The worker requires Redis. The API runs inline execution without it.");
    process.exit(1);
  }
  startWorker();
  console.log("[worker] execution worker running");
}
