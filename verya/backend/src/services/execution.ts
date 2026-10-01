// Execution service — runs a session's tasks inline (HTTP path when Redis is absent).
// REAL FILE EXECUTION: the routed model's output is parsed into structured file
// operations (create/update/delete), every path is validated against the workspace
// jail, accepted operations are written to the session's generated-project file
// store, and verification + status reflect what actually happened. Dependent tasks
// of a FAILED task are BLOCKED, not run. `servedBy` records the model that actually
// responded when provider failover substituted one.
import { getSession, saveSession } from "../repositories/sessions";
import { geminiAdapters } from "../lib/ai/provider";
import { stackTextOf } from "../lib/pipeline/gates";
import { recordToLedger } from "./ledger";
import { checkExternalReferences } from "../lib/verification/external";
import { escalationFloorFor, selfAuditThreshold, verificationDepthFor } from "../lib/thresholds";
import { updateFromOutcome } from "./reputation";
import { alternateModelOf, modelCostOf } from "../schemas/pipeline";
import { codeArtifactOf, type ExecutionResult, type PipelineSession, type Task } from "../schemas/pipeline";
import { forecastTaskFailure } from "./forecast";
import { initialTrustBudget, trustCostFor } from "../lib/trust-budget";
import { certificateFor } from "../lib/certificates";
import { applyFileOpToSession, type FileOp } from "./workspace";
import { extractFileOps } from "./fileops";
import { ensurePreviewEntry, ensureProjectScaffolding } from "./scaffold";

/** Sessions whose execution loop is currently running in this process. */
const executing = new Set<string>();

/**
 * Kick off execution WITHOUT blocking the HTTP response — the route returns the
 * session with gateStatus="running" and the UI polls until review is ready.
 * Prevents double-starts from repeated clicks (the loop itself also skips
 * already-executed tasks).
 */
export async function startExecution(orgId: string, sessionId: string): Promise<{ session: PipelineSession }> {
  const session = await getSession(orgId, sessionId);
  if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
  if (!session.routing || !session.workflow || !session.algorithms) {
    throw Object.assign(new Error("Pipeline not ready for execution"), { statusCode: 409 });
  }
  assertModelsFinalized(session);
  session.gate = "execution";
  session.gateStatus = "running";
  session.trustBudget ??= { initial: initialTrustBudget(), remaining: initialTrustBudget(), consumed: 0, status: "active" };
  await ensureBudgetSizedToPlan(orgId, sessionId, session);
  await saveSession(orgId, session);

  // With Redis configured, actOnPipeline already enqueued this session to BullMQ —
  // the worker owns the run; running inline here too would execute tasks twice.
  if (process.env.REDIS_URL) {
    return { session };
  }

  if (!executing.has(sessionId)) {
    executing.add(sessionId);
    void runExecution(orgId, sessionId)
      .catch(async (err) => {
        console.error(`[execution] failed for ${sessionId}:`, err);
        try {
          const s = await getSession(orgId, sessionId);
          if (s) {
            s.gateStatus = "failed";
            await saveSession(orgId, s);
          }
        } catch {
          /* best-effort failure marker */
        }
      })
      .finally(() => executing.delete(sessionId));
  }
  return { session };
}

/**
 * Size the trust budget to the APPROVED plan: the task list was explicitly confirmed
 * by the human at the Tasks gate, so it — not a generic default — defines the cost.
 * A fresh run must never die mid-build just because the plan has more (riskier) tasks
 * than the default allowance (e.g. 9 tasks ≈ 145 units vs the default 100).
 * Only applies to a fresh run (nothing executed, nothing consumed yet).
 */
export async function ensureBudgetSizedToPlan(
  orgId: string,
  sessionId: string,
  session: PipelineSession
): Promise<void> {
  if (!session.trustBudget || !session.workflow) return;
  if (session.executions.length > 0 || session.trustBudget.consumed > 0) return;
  const planCost = session.workflow.tasks.reduce((sum, t) => sum + trustCostFor(t.risk), 0);
  const sized = Math.max(session.trustBudget.initial, planCost);
  if (sized === session.trustBudget.initial) return;
  session.trustBudget = { ...session.trustBudget, initial: sized, remaining: sized };
  await recordToLedger({
    orgId,
    sessionId,
    gate: "execution",
    eventType: "trust_budget_sized",
    actor: "system",
    detail: {
      summary: `Trust budget sized to the approved plan: ${sized} units for ${session.workflow.tasks.length} task(s)`,
      budget: session.trustBudget,
    },
  });
}

/** Re-run exactly one failed task (Part 16): clears its result, restarts the loop. */
export async function retryTask(orgId: string, sessionId: string, taskId: string): Promise<{ session: PipelineSession }> {
  const session = await getSession(orgId, sessionId);
  if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
  const exec = session.executions.find((e) => e.taskId === taskId);
  if (!exec) throw Object.assign(new Error("Task has not executed yet"), { statusCode: 404 });
  if (exec.status !== "failed" && exec.status !== "flagged") {
    throw Object.assign(new Error("Only failed or flagged tasks can be retried"), { statusCode: 409 });
  }
  session.executions = session.executions.filter((e) => e.taskId !== taskId);
  // Dependent results of a retried task are stale — drop them so they re-run too.
  const stale = new Set<string>([taskId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of session.workflow?.tasks ?? []) {
      if (stale.has(t.id)) continue;
      if ((t.dependsOn ?? []).some((d) => stale.has(d))) {
        stale.add(t.id);
        grew = true;
      }
    }
  }
  session.executions = session.executions.filter((e) => !stale.has(e.taskId));
  await recordToLedger({
    orgId,
    sessionId,
    gate: "execution",
    eventType: "task_retry",
    actor: "human",
    taskId,
    detail: { summary: `Human requested a retry of ${taskId} (${stale.size} task(s) re-queued)` },
  });
  return startExecution(orgId, sessionId);
}

export async function runExecution(orgId: string, sessionId: string): Promise<{ session: PipelineSession }> {
  const session = await getSession(orgId, sessionId);
  if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
  if (!session.routing || !session.workflow || !session.algorithms) {
    throw Object.assign(new Error("Pipeline not ready for execution"), { statusCode: 409 });
  }
  assertModelsFinalized(session);

  const stackText = stackTextOf(session);
  // Dependency-respecting order. FAILED tasks BLOCK their dependents (Part 17):
  // only tasks whose dependencies all finished successfully are eligible.
  const statusOf = new Map(session.executions.map((e) => [e.taskId, e.status]));
  const succeeded = new Set([...statusOf.entries()].filter(([, s]) => s === "verified" || s === "escalated" || s === "flagged").map(([id]) => id));
  const failed = new Set([...statusOf.entries()].filter(([, s]) => s === "failed").map(([id]) => id));
  const blocked = new Set<string>();
  {
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of session.workflow.tasks) {
        if (blocked.has(t.id) || failed.has(t.id) || succeeded.has(t.id)) continue;
        const failingDeps = (t.dependsOn ?? []).filter((d) => failed.has(d) || blocked.has(d));
        if (failingDeps.length > 0) {
          blocked.add(t.id);
          grew = true;
        }
      }
    }
  }
  const pending = session.workflow.tasks.filter((t) => !succeeded.has(t.id) && !failed.has(t.id) && !blocked.has(t.id));
  const ordered: Task[] = [];
  {
    const done = new Set([...session.executions.map((e) => e.taskId), ...blocked]);
    const all = [...pending];
    const remaining = new Set(all.map((t) => t.id));
    let guard = 0;
    while (ordered.length < all.length && guard++ < all.length * 2) {
      for (const t of all) {
        if (!remaining.has(t.id)) continue;
        if ((t.dependsOn ?? []).every((d) => done.has(d) || !remaining.has(d))) {
          ordered.push(t);
          remaining.delete(t.id);
          done.add(t.id);
        }
      }
    }
  }

  session.gate = "execution";
  session.gateStatus = "running";
  await saveSession(orgId, session);

  if (ordered.length > 0 && session.executions.length === 0) {
    await recordToLedger({
      orgId,
      sessionId,
      gate: "execution",
      eventType: "execution_started",
      actor: "system",
      detail: { summary: `Execution started: ${ordered.length} task(s) queued, ${blocked.size} blocked` },
    });
  }

  for (const task of ordered) {
    if (session.executions.some((r) => r.taskId === task.id)) continue;
    const budgetCost = trustCostFor(task.risk);
    if (!session.trustBudget || session.trustBudget.remaining < budgetCost) {
      session.trustBudget = { ...(session.trustBudget ?? { initial: initialTrustBudget(), remaining: 0, consumed: 0 }), status: "exhausted" };
      session.gateStatus = "awaiting_user";
      await recordToLedger({ orgId, sessionId, gate: "execution", eventType: "trust_budget_exhausted", actor: "system", detail: { summary: `Trust budget paused before ${task.title}`, required: budgetCost, budget: session.trustBudget } });
      // Paused ≠ broken: whatever exists so far must still be previewable and
      // properly scaffolded when the user opens the workspace.
      await ensureProjectScaffolding(orgId, session);
      await ensurePreviewEntry(orgId, session);
      await saveSession(orgId, session);
      return { session };
    }
    session.trustBudget.remaining -= budgetCost;
    session.trustBudget.consumed += budgetCost;
    await recordToLedger({ orgId, sessionId, gate: "execution", eventType: "trust_budget_consumed", actor: "system", taskId: task.id, detail: { summary: `${budgetCost} trust units consumed by ${task.title}`, risk: task.risk, remaining: session.trustBudget.remaining } });
    await recordToLedger({ orgId, sessionId, gate: "execution", eventType: "task_started", actor: "system", taskId: task.id, detail: { summary: `Starting ${task.title}` } });
    const route = session.routing.routes.find((r) => r.taskId === task.id);
    const algo = session.algorithms.tasks.find((a) => a.taskId === task.id);
    const model = route?.selectedModel ?? "openai/gpt-oss-20b";
    const algorithm = algo?.selected ?? "direct implementation";
    const started = Date.now();
    try {
      const challengerModel = task.risk === "high" ? alternateModelOf(model) : undefined;
      const failureForecast = await forecastTaskFailure({ orgId, model, taskCategory: task.category, risk: task.risk, injectionRisk: session.inputSecurity?.risk });
      const [exec, challenger] = await Promise.all([
        geminiAdapters.executeTask({ task, algorithm, stack: stackText, workflow: session.workflow, model, targetPlatform: session.targetPlatform }),
        challengerModel
          ? geminiAdapters.executeTask({ task, algorithm, stack: stackText, workflow: session.workflow, model: challengerModel, targetPlatform: session.targetPlatform })
          : Promise.resolve(undefined),
      ]);

      // ---------- REAL FILE OPERATIONS (the heart of the coding agent) ----------
      const ops: FileOp[] = extractFileOps(exec.output);
      const appliedFileOps: ExecutionResult["fileOps"] = [];
      for (const op of ops) {
        const result = applyFileOpToSession(session, op, { taskId: task.id, model });
        if (result.ok) {
          appliedFileOps.push({ path: result.op.path, operation: result.op.operation, rejected: false });
          await recordToLedger({
            orgId,
            sessionId,
            gate: "execution",
            eventType: result.op.operation === "delete" ? "file_deleted" : result.op.operation === "update" ? "file_modified" : "file_created",
            actor: "ai",
            taskId: task.id,
            model,
            detail: { summary: `${result.op.operation === "delete" ? "Deleted" : result.op.operation === "update" ? "Modified" : "Created"} ${result.op.path} (${op.content.length} chars)`, path: result.op.path },
          });
        } else {
          // Path-security rejections are AUDIT EVENTS, not silent drops (Part 6).
          appliedFileOps.push({ path: op.path, operation: op.operation, rejected: true, reason: result.reason.slice(0, 300) });
          await recordToLedger({
            orgId,
            sessionId,
            gate: "execution",
            eventType: "file_op_rejected",
            actor: "system",
            taskId: task.id,
            model,
            detail: { summary: `Rejected file operation for ${task.title}: ${result.reason}`, path: op.path, reason: result.reason },
          });
        }
      }
      const filesChanged = appliedFileOps.filter((f) => !f.rejected).length;

      // ---------- VERIFICATION (unchanged pipeline + file-aware rules) ----------
      const verificationDepth = verificationDepthFor(task.risk);
      const needsSecondModel = verificationDepth === "second_model";
      const verification = needsSecondModel
        ? await geminiAdapters.verifyOutput({ task, algorithm, output: exec.output, model })
        : await geminiAdapters.verifyRulesOnly({ task, output: exec.output });
      // File-aware check: a task that produced NO usable file operations while its
      // approach expects deliverables cannot be "verified" as a coding task.
      if (filesChanged === 0 && ops.length === 0 && task.category !== "documentation") {
        verification.passed = false; // a coding task that produced no files is a failure, not a pass
        verification.issues = [
          ...verification.issues,
          "No structured file operations found in model output (expected {files:[...]} JSON or path-declared code blocks).",
        ].slice(0, 12);
        verification.checkedBy = `${verification.checkedBy} + fileops`;
      }
      // F14: high-risk outputs get a bounded, provider-independent adversarial pass.
      const selfAudit = task.risk === "high"
        ? await geminiAdapters.selfAudit({ task, output: exec.output, executorModel: model })
        : undefined;

      // F13 third method: external-knowledge check (npm registry) for code-bearing outputs.
      const external = await checkExternalReferences(exec.output);
      if (!external.passed) {
        verification.passed = false;
        verification.issues = [
          ...verification.issues,
          ...external.unsupported.map((p) => `References non-existent npm package \"${p}\" (registry check).`),
        ].slice(0, 12);
        verification.checkedBy = `${verification.checkedBy} + npm_registry`;
      }

      // F11: per-risk escalation floor (env-tunable per department/workflow type).
      const floor = escalationFloorFor(task.risk);
      const confidence = verification.passed ? 0.82 : 0.4;
      const auditEscalated = selfAudit !== undefined && selfAudit.riskScore >= selfAuditThreshold();
      const status: ExecutionResult["status"] = auditEscalated
        ? "escalated"
        : verification.passed
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
        selfAudit,
        status,
        confidence,
        rationale: auditEscalated
          ? `Escalated because the adversarial audit risk ${(selfAudit?.riskScore ?? 0) * 100}% exceeded the configured threshold.`
          : verification.passed
            ? `Verification passed at the ${task.risk}-risk escalation floor (${floor}).`
            : `Flagged because verification found ${verification.issues.length} issue(s).`,
        alternatives: (route?.options ?? []).filter((option) => option.model !== model).map((option) => option.model).slice(0, 4),
        battleA: challenger ? { model, output: exec.output, latencyMs: exec.latencyMs, tokens: exec.tokens } : undefined,
        battleB: challenger && challengerModel ? { model: challengerModel, output: challenger.output, latencyMs: challenger.latencyMs, tokens: challenger.tokens } : undefined,
        failureForecast,
        latencyMs: exec.latencyMs,
        tokens: exec.tokens,
      };
      result.certificate = certificateFor(session, result);
      session.executions.push(result);

      // F12: reputation updates continuously from execution outcomes, not just feedback.
      const outcome: "verified" | "flagged" | "escalated" | "rejected" =
        status === "verified" ? "verified" : status === "flagged" ? "flagged" : status === "escalated" ? "escalated" : "rejected";
      await updateFromOutcome({ orgId, model, taskCategory: task.category, outcome }).catch(() => undefined);

      const costUnits = modelCostOf(model);
      const fallbackUsed = exec.servedBy !== undefined && exec.servedBy !== model;
      await recordToLedger({
        orgId,
        sessionId,
        gate: "execution",
        eventType: fallbackUsed ? "model_fallback" : "task_execution",
        taskId: task.id,
        model: fallbackUsed ? exec.servedBy! : model,
        detail: {
          summary: fallbackUsed
            ? `${task.title}: requested ${model} but failover served ${exec.servedBy} — ${status}`
            : `${task.title} executed by ${model} — ${status} · ${filesChanged} file op(s)`,
          latencyMs: exec.latencyMs,
          tokens: exec.tokens,
          servedBy: exec.servedBy ?? model,
          requestedModel: model,
          fileOps: appliedFileOps,
          costUnits,
          taskCategory: task.category,
          verificationDepth,
          battleAuto: Boolean(challenger),
          failureForecast,
          externalChecked: external.checked.length,
          externalUnsupported: external.unsupported,
          escalationFloor: floor,
          selfAudit: selfAudit
            ? { riskScore: selfAudit.riskScore, issues: selfAudit.issues, checks: selfAudit.checks, threshold: selfAuditThreshold() }
            : undefined,
        },
        verification: { passed: verification.passed, issues: verification.issues },
      });
      await recordToLedger({
        orgId,
        sessionId,
        gate: "execution",
        eventType: "task_completed",
        actor: "system",
        taskId: task.id,
        detail: { summary: `${task.title} → ${status}`, status, filesChanged },
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
        alternatives: (route?.options ?? []).filter((option) => option.model !== model).map((option) => option.model).slice(0, 4),
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
        detail: { summary: `${task.title} failed: ${message}`, latencyMs: Date.now() - started, taskCategory: task.category, costUnits: modelCostOf(model) },
        verification: { passed: false, issues: [message] },
      });
    }
    await saveSession(orgId, session);
  }

  // Blocked tasks are recorded so the UI can show WHY they never ran (Part 17).
  for (const task of session.workflow.tasks.filter((t) => blocked.has(t.id))) {
    if (session.executions.some((e) => e.taskId === task.id)) continue;
    const failingDep = (task.dependsOn ?? []).find((d) => failed.has(d) || blocked.has(d));
    session.executions.push({
      taskId: task.id,
      model: session.routing.routes.find((r) => r.taskId === task.id)?.selectedModel ?? "openai/gpt-oss-20b",
      output: "",
      verification: { method: "rules", passed: false, issues: [`Blocked by failed dependency: ${failingDep ?? "unknown"}`], checkedBy: "dependency" },
      status: "failed",
      confidence: 0,
      rationale: `Blocked: dependency ${failingDep} did not succeed.`,
      alternatives: [],
      latencyMs: 0,
      tokens: { input: 0, output: 0 },
    });
    await recordToLedger({
      orgId,
      sessionId,
      gate: "execution",
      eventType: "task_blocked",
      actor: "system",
      taskId: task.id,
      detail: { summary: `${task.title} blocked by failed dependency ${failingDep}` },
    });
  }

  // Post-pass (best-effort, never fails the run): industrial scaffolding for every
  // project + a guaranteed preview entry for web projects so the IDE Preview
  // always renders the real app.
  await ensureProjectScaffolding(orgId, session);
  await ensurePreviewEntry(orgId, session);

  const anyFailed = session.executions.some((e) => e.status === "failed");
  session.gate = "review";
  session.gateStatus = "awaiting_user";
  await recordToLedger({
    orgId,
    sessionId,
    gate: "review",
    eventType: "execution_completed",
    actor: "system",
    detail: {
      summary: anyFailed
        ? `Execution finished with failures: ${session.executions.filter((e) => e.status === "failed").length} failed task(s)`
        : `Execution completed: ${session.executions.length} task(s), ${listWorkspaceFilesCount(session)} workspace file(s)`,
      outcome: anyFailed ? "failed" : "completed",
    },
  });
  await saveSession(orgId, session);
  return { session };
}

function listWorkspaceFilesCount(session: PipelineSession): number {
  return session.workspaceFiles?.length ?? 0;
}

/**
 * Part 1 — the Models → execution gate, as an explicit state check.
 * Run requires: planning complete (routing + tasks + approaches) AND models FINALIZED
 * (last tie-break resolved or the human called finalize_models). Routing merely existing
 * is NOT sufficient — tie-breaks must be resolved. Legacy sessions without the
 * modelsFinalized flag are accepted only when no unresolved tie-break remains.
 */
export function assertModelsFinalized(session: PipelineSession): void {
  if (!session.routing || !session.workflow || !session.algorithms) {
    throw Object.assign(new Error("Pipeline not ready for execution"), { statusCode: 409 });
  }
  const pendingTieBreaks = session.routing.routes.filter((r) => r.tieBreakRequired).length;
  if (pendingTieBreaks > 0) {
    throw Object.assign(
      new Error(`Cannot run: ${pendingTieBreaks} model tie-break(s) still require a human decision`),
      { statusCode: 409 }
    );
  }
  if (session.modelsFinalized === false) {
    throw Object.assign(new Error("Models are not finalized yet — finalize model routing to unlock Run"), { statusCode: 409 });
  }
}
