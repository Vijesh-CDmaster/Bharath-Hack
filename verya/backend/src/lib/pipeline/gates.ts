// Verya — gate engine: advances the session through the gated pipeline.
// Runs AI stages, applies human gate actions, enforces the universal decision rule (F8),
// and appends every decision to the Trust Ledger (F10).

import type {
  GateAction,
  PipelineSession,
  StackCandidate,
  StackProposal,
  StackValidation,
  Workflow,
} from "../../schemas/pipeline";
import type { AlgorithmPlan, RoutingPlan, TaskModelRoute } from "../../schemas/pipeline";
import { needsTieBreak, CHEAP_MODEL_ID, STRONG_MODEL_ID, MODEL_IDS, modelCostOf } from "../../schemas/pipeline";
import type { StageAdapters } from "../ai/provider";
import { recordToLedger } from "../../services/ledger";
import { findSimilar } from "../../services/memory";
import { analyzeFlawsByConsensus } from "../../services/consensus";
import { refreshTaskFingerprints } from "./fingerprint";
import { timeStage } from "../metrics";
import { AsyncLocalStorage } from "node:async_hooks";

const ORG_ID = process.env.VERYA_ORG_ID || "default-org";
const orgContext = new AsyncLocalStorage<string>();
function currentOrg(): string { return orgContext.getStore() ?? ORG_ID; }

// ---------- F9: org memory → decision prompts ----------
/** Retrieve similar past tasks for a task title and format them as prompt context. */
async function memoryContextOf(taskTitle: string, category: string): Promise<string | undefined> {
  try {
    const similar = await findSimilar({
      orgId: currentOrg(),
      taskCategory: category || "other",
      query: taskTitle,
      limit: 4,
    });
    if (similar.length === 0) return undefined;
    return similar
      .map(
        (m) =>
          `- "${m.title}" [${m.taskCategory}] with ${m.model} → ${m.outcome}${m.similarity != null ? ` (similarity ${(m.similarity * 100).toFixed(0)}%)` : ""}`
      )
      .join("\n");
  } catch {
    return undefined; // memory retrieval must never break a gate
  }
}

/** Compact org outcome history per model×category, injected into routing prompts. */
async function memoryOutcomes(): Promise<string | undefined> {
  try {
    const rows = await queryOrgOutcomeHistory();
    if (rows.length === 0) return undefined;
    return rows
      .map(
        (r) =>
          `- ${r.model} × [${r.taskCategory}]: ${r.samples} past outcome(s), avg quality ${r.avgQuality}/100 → prefer/route ${r.outcome}`
      )
      .join("\n");
  } catch {
    return undefined;
  }
}

async function queryOrgOutcomeHistory(): Promise<
  Array<{ model: string; taskCategory: string; samples: number; avgQuality: number; outcome: string }>
> {
  const { getSkillMap } = await import("../../services/memory.js");
  const skill = await getSkillMap(currentOrg());
  return skill.slice(0, 20).map((s) => ({
    model: s.model,
    taskCategory: s.taskCategory,
    samples: s.samples,
    avgQuality: s.trustScore,
    outcome: s.trustScore >= 65 ? "this model has EARNED TRUST here" : "this model has STRUGGLED here",
  }));
}

/**
 * Kick off AI processing for the current gate. Called in the background after the
 * session is persisted with gateStatus="running" — the HTTP path returns immediately
 * and the UI polls until the gate reaches "awaiting_user" (or "failed").
 */
export async function processGate(
  session: PipelineSession,
  adapters: StageAdapters,
  orgId = ORG_ID
): Promise<PipelineSession> {
  // F19 is deterministic and backfills old sessions without changing their gate semantics.
  refreshTaskFingerprints(session);
  // F44: time the stage and record provider-vs-overhead split to the ledger.
  const gate = session.gate;
  return orgContext.run(orgId, () => timeStage(gate, { orgId, sessionId: session.id }, () => runGate(gate, session, adapters)));
}

async function runGate(
  gate: PipelineSession["gate"],
  session: PipelineSession,
  adapters: StageAdapters
): Promise<PipelineSession> {
  switch (gate) {
    case "suitability":
      return runSuitability(session, adapters);
    case "platform":
      return session;
    case "flaws":
      return runFlaws(session);
    case "stack":
      return runStack(session, adapters);
    case "algorithms":
      return runAlgorithms(session, adapters);
    case "models":
      return runRouting(session, adapters);
    case "intake":
    case "tasks":
    case "execution":
    case "review":
      // User-action-driven gates; nothing to precompute.
      return session;
  }
}

// ---------- Gate 2: Flaw detection (runs after the suitability decision) ----------
async function runFlaws(
  session: PipelineSession
): Promise<PipelineSession> {
  session.gateStatus = "running";
  const finalWorkflow = session.workflow;
  if (!finalWorkflow) {
    session.gateStatus = "failed";
    return session;
  }
  const consensus = await analyzeFlawsByConsensus({
    raw: session.input,
    workflow: finalWorkflow,
    targetPlatform: session.targetPlatform,
  });
  session.flawConsensus = consensus;
  const flaws = consensus.issues.map((issue) => ({
    id: issue.key,
    title: issue.title,
    category: issue.category,
    severity: issue.severity,
    description: issue.description,
    suggestedFix: issue.suggestedFix,
    relatedTaskIds: issue.relatedTaskIds,
  }));
  const overallRisk = flaws.reduce<"low" | "medium" | "high">(
    (risk, flaw) => (flaw.severity === "critical" || flaw.severity === "high" ? "high" : flaw.severity === "medium" || risk === "medium" ? "medium" : risk),
    "low"
  );
  const flawReport = {
    flaws,
    overallRisk,
    summary: consensus.consensusSummary,
  };
  session.flawReport = flawReport;
  session.gateStatus = "awaiting_user";
  await recordToLedger({
    orgId: currentOrg(),
    sessionId: session.id,
    gate: "flaws",
    eventType: "flaw_report",
    detail: {
      summary: `${flawReport.flaws.length} flaws found (${flawReport.overallRisk} risk)`,
      consensus: {
        providers: consensus.opinions.map((opinion) => ({
          provider: opinion.provider,
          status: opinion.status,
        })),
        completedProviders: consensus.completedProviders,
        issues: consensus.issues.map((issue) => ({
          key: issue.key,
          agreement: issue.agreement,
          confidence: issue.confidence,
        })),
      },
    },
  });
  return session;
}

// Deterministic repair for the understanding stage: models sometimes omit ids/titles or
// emit invalid enums — align positionally against N instead of failing the whole gate.
function repairWorkflow(wf: Workflow): void {
  wf.tasks = wf.tasks.slice(0, 20);
  wf.tasks.forEach((t, i) => {
    if (!t.id) t.id = `t${i + 1}`;
    if (!t.title) t.title = `Task ${i + 1}`;
    if (!wf.tasks.some((o) => o.id === t.id && o !== t)) return;
  });
  // de-duplicate ids defensively
  const seen = new Set<string>();
  for (const t of wf.tasks) {
    let id = t.id;
    while (seen.has(id)) id = `${id}-x`;
    t.id = id;
    seen.add(id);
  }
  // dependencies must reference surviving ids
  for (const t of wf.tasks) {
    t.dependsOn = (t.dependsOn ?? []).filter((d) => seen.has(d) && d !== t.id);
  }
}

// ---------- Gate 1: Suitability ----------
async function runSuitability(
  session: PipelineSession,
  adapters: StageAdapters
): Promise<PipelineSession> {
  session.gateStatus = "running";
  // Re-entry after "suggested" was chosen: re-extract the workflow with the
  // user-endorsed suggestion folded into the prompt, then hand off to flaws.
  if (session.suitability) {
    const wf = await adapters.understand(
      `${session.input}\n\nUse this improved workflow instead:\n${session.suitability.suggestedWorkflow ?? ""}`
    );
    repairWorkflow(wf);
    if (!wf.title) wf.title = "Untitled project";
    session.workflow = wf;
    await recordToLedger({
      orgId: currentOrg(),
      sessionId: session.id,
      gate: "suitability",
      eventType: "suggested_workflow_adopted",
      detail: { summary: "Re-extracted workflow from the suggested improvement" },
    });
    session.gate = "platform";
    session.gateStatus = "awaiting_user";
    return session;
  }
  const workflow: Workflow = await adapters.understand(session.input);
  repairWorkflow(workflow);
  if (!workflow.title) workflow.title = "Untitled project";
  const suitability = await adapters.checkSuitability({ raw: session.input, workflow });

  suitability.verdict ??= suitability.suitable
    ? "suitable"
    : suitability.confidence >= 0.55
      ? "workable"
      : "unsuitable";

  session.suitability = suitability;

  if (suitability.suitable) {
    session.workflow = workflow;
    session.gateStatus = "awaiting_user";
    await recordToLedger({
      orgId: currentOrg(),
      sessionId: session.id,
      gate: "suitability",
      eventType: "suitability_passed",
      detail: {
        summary: `Workflow suitable (confidence ${(suitability.confidence * 100).toFixed(0)}%)`,
        confidence: suitability.confidence,
      },
    });
    await recordToLedger({
      orgId: currentOrg(),
      sessionId: session.id,
      gate: "platform",
      eventType: "platform_selection_required",
      detail: { summary: "Choose the target mobile platform before flaw detection" },
    });
  } else {
    // Not suitable: keep the extraction as the baseline the user keeps or replaces.
    session.suggestedWorkflow = workflow;
    session.gateStatus = "awaiting_user";
    await recordToLedger({
      orgId: currentOrg(),
      sessionId: session.id,
      gate: "suitability",
      eventType: "suitability_flagged",
      detail: {
        summary: suitability.reason,
        suggested: Boolean(suitability.suggestedWorkflow),
      },
    });
  }
  return session;
}

// ---------- Gate 3: Stack ----------
async function runStack(
  session: PipelineSession,
  adapters: StageAdapters
): Promise<PipelineSession> {
  const hasStack = session.statedStack.trim().length > 0;

  if (hasStack) {
    const validation: StackValidation = await adapters.validateStack({
      raw: session.input,
      workflow: session.workflow!,
      statedStack: session.statedStack,
    });
    const layers = [
      "frontend",
      "backend",
      "database",
      "cache",
      "auth",
      "hosting",
      "jobs",
      "storage",
    ] as const;
    const proposal: StackProposal = {
      name: "Your stack",
      components: session.statedStack
        .split(/[,+|\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, layers.length)
        .map((choice, i) => ({
          layer: layers[i],
          choice,
          rationale: "",
        })),
      summary:
        validation.verdict === "fit"
          ? "Validated as provided."
          : "See validation notes and suggested changes.",
      confidence: validation.verdict === "fit" ? 0.9 : 0.55,
      tradeoffs: { cost: "Not assessed", learningCurve: "Not assessed", scalingCeiling: "Not assessed", ecosystem: "Not assessed" },
    };
    session.stackGate = {
      provided: true,
      validation,
      candidates: [
        { proposal, confidence: proposal.confidence, reason: "User-provided stack." },
      ],
      selected: proposal.name,
      tieBreakRequired: false,
    };
    await recordToLedger({
      orgId: currentOrg(),
      sessionId: session.id,
      gate: "stack",
      eventType: "stack_validated",
      detail: { summary: `Verdict: ${validation.verdict}`, verdict: validation.verdict },
    });
    session.gate = "tasks";
    session.gateStatus = "awaiting_user";
    return session;
  }

  let proposals: StackProposal[] = [];
  try {
    proposals = await adapters.proposeStacks({
      raw: session.input,
      workflow: session.workflow!,
    });
  } catch (err) {
    console.warn(`[stack] AI proposal failed, using rule-based fallback: ${err instanceof Error ? err.message : err}`);
  }
  // Drop degenerate candidates (no components) and fall back deterministically
  // when the AI returns nothing usable — this gate must never deadlock.
  proposals = proposals.filter((p) => p.components.length >= 3);
  if (proposals.length === 0) {
    proposals = [
      {
        name: "Next.js full-stack",
        components: [
          { layer: "frontend", choice: "Next.js (React) + Tailwind CSS", rationale: "One codebase for UI and API routes; fast iteration." },
          { layer: "backend", choice: "Next.js API routes (Node.js)", rationale: "Sufficient for CRUD-scale workflows at this size." },
          { layer: "database", choice: "Postgres (Neon)", rationale: "Relational integrity with a generous free tier." },
        ],
        summary: "Boring, proven full-stack default sized for small teams.",
        confidence: 0.6,
        tradeoffs: { cost: "low", learningCurve: "moderate", scalingCeiling: "high", ecosystem: "large" },
      },
    ];
  }
  const candidates: StackCandidate[] = proposals.map((p) => ({
    proposal: p,
    confidence: p.confidence ?? 0.6,
    reason: p.summary.slice(0, 200),
  }));

  const tie = needsTieBreak(candidates);
  const selected = tie
    ? null
    : [...candidates].sort((a, b) => b.confidence - a.confidence)[0].proposal.name;

  session.stackGate = {
    provided: false,
    validation: null,
    candidates,
    selected,
    tieBreakRequired: tie,
  };
  session.gateStatus = "awaiting_user";
  await recordToLedger({
    orgId: currentOrg(),
    sessionId: session.id,
    gate: "stack",
    eventType: tie ? "stack_tiebreak" : "stack_selected",
    detail: {
      summary: tie
        ? `${candidates.length} stack candidates too close to auto-pick — user must choose`
        : `Auto-selected "${selected}" (clear winner, reason shown)`,
      candidates: candidates.map((c) => `${c.proposal.name} (${(c.confidence * 100).toFixed(0)}%)`),
    },
  });
  return session;
}

// ---------- Gate 5: Algorithms ----------
async function runAlgorithms(
  session: PipelineSession,
  adapters: StageAdapters
): Promise<PipelineSession> {
  const categories = Array.from(new Set(session.workflow!.tasks.map((t) => t.category)));
  const memoryChunks = await Promise.all(
    categories.slice(0, 4).map(async (cat) => {
      const ctx = await memoryContextOf(session.workflow!.summary.slice(0, 400), cat);
      return ctx ? `[${cat}]\n${ctx}` : null;
    })
  );
  const memoryContext = memoryChunks.filter(Boolean).join("\n\n") || undefined;

  const plan = await adapters.recommendAlgorithms({
    workflow: session.workflow!,
    stack: stackTextOf(session),
    memoryContext,
  });
  repairAlgorithmPlan(plan, session.workflow!.tasks);
  session.algorithms = plan;
  const ties = plan.tasks.filter((t) => t.tieBreakRequired).length;
  await recordToLedger({
    orgId: currentOrg(),
    sessionId: session.id,
    gate: "algorithms",
    eventType: ties > 0 ? "algorithm_tiebreak" : "algorithm_selected",
    detail: {
      summary:
        ties > 0
          ? `${ties} task(s) need a human call on approach`
          : "Approach auto-selected for every task (reasons shown)",
      tieCount: ties,
    },
  });
  if (ties === 0) {
    // No human calls required: auto-advance into model routing instead of
    // deadlocking at "awaiting_user" with nothing to decide (F8 — ties alone
    // demand a human).
    session.gate = "models";
    session.gateStatus = "running";
    await recordToLedger({
      orgId: currentOrg(),
      sessionId: session.id,
      gate: "models",
      eventType: "routing_queued",
      detail: { summary: "Approaches auto-selected — model routing queued automatically" },
    });
  } else {
    session.gateStatus = "awaiting_user";
  }
  return session;
}

// ---------- Gate 6: Model routing ----------
async function runRouting(
  session: PipelineSession,
  adapters: StageAdapters
): Promise<PipelineSession> {
  // F9: inject the org's recorded model×category outcomes so history biases routing.
  const routingMemory = await memoryOutcomes();
  const plan = await adapters.routeModels({
    workflow: session.workflow!,
    algorithmPlan: session.algorithms!,
    stack: stackTextOf(session),
    memoryContext: routingMemory,
    taskFingerprints: session.taskFingerprints,
  });
  repairRoutingPlan(plan, session.algorithms!.tasks);

  // F7: apply the org routing policy on top of the router's raw ranking.
  // lowest_cost → flash unless pro is clearly safer; highest_accuracy → pro unless
  // flash wins decisively; balanced → leave the router's pick as-is.
  plan.policy = session.policy ?? "balanced";
  const cheap = CHEAP_MODEL_ID;
  const strong = STRONG_MODEL_ID;
  const approvedModels = new Set(
    (process.env.VERYA_APPROVED_MODELS || "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean)
  );
  if (plan.policy === "org_approved" && approvedModels.size === 0) {
    throw new Error(
      "Organization-approved routing is selected, but VERYA_APPROVED_MODELS is not configured."
    );
  }
  for (const route of plan.routes) {
    if (plan.policy === "lowest_cost" && route.selectedModel !== cheap) {
      const cheapConf = route.options.find((o) => o.model === cheap)?.confidence ?? 0.6;
      const chosenConf = route.options.find((o) => o.model === route.selectedModel)?.confidence ?? route.confidence;
      if (chosenConf - cheapConf < 0.25) {
        route.selectedModel = cheap;
        route.reason = `Policy lowest_cost: downgraded to ${cheap} (accuracy delta small). ${route.reason}`;
      }
    }
    if (plan.policy === "highest_accuracy" && route.selectedModel !== strong) {
      const strongConf = route.options.find((o) => o.model === strong)?.confidence ?? 0.7;
      if (strongConf >= 0.6) {
        route.selectedModel = strong;
        route.reason = `Policy highest_accuracy: upgraded to ${strong}. ${route.reason}`;
      }
    }
    if (plan.policy === "org_approved") {
      const approved = route.options
        .filter((option) => approvedModels.has(option.model))
        .sort((a, b) => b.confidence - a.confidence);
      if (approved.length === 0) {
        throw new Error(
          `No organization-approved model qualifies for task ${route.taskId}. Configure a matching model in VERYA_APPROVED_MODELS.`
        );
      }
      const selected = approved[0];
      route.selectedModel = selected.model;
      route.confidence = selected.confidence;
      route.reason = `Policy org_approved: selected ${selected.model} from the configured allowlist. ${route.reason}`;
    }
  }
  plan.estimatedCostUsd =
    plan.routes.reduce((s, r) => s + modelCostOf(r.selectedModel), 0) / Math.max(plan.routes.length, 1);

  session.routing = plan;
  session.gateStatus = "awaiting_user";
  // Explicit finalization state (Part 1): Models are SELECTED, not yet FINALIZED.
  // Execution is gated on modelsFinalized — see assertModelsFinalized in services/execution.ts.
  session.modelsFinalized = false;
  const ties = plan.routes.filter((r) => r.tieBreakRequired).length;
  await recordToLedger({
    orgId: currentOrg(),
    sessionId: session.id,
    gate: "models",
    eventType: ties > 0 ? "model_tiebreak" : "model_selected",
    detail: {
      summary:
        ties > 0
          ? `${ties} model choice(s) need a human call (policy: ${plan.policy})`
          : `Model auto-selected for every task (policy: ${plan.policy}, reasons shown)`,
      tieCount: ties,
      policy: plan.policy,
      estimatedCostUsd: plan.estimatedCostUsd,
    },
  });
  return session;
}

// Deterministic repair: align plan rows to the real workflow tasks positionally, fix
// invalid selected models, and force tie-breaks only where the decision rule demands.
function repairAlgorithmPlan(
  plan: AlgorithmPlan,
  tasks: { id?: string; title?: string }[]
): void {
  const byId = new Map(tasks.map((t) => [t.id ?? "", t]));
  plan.tasks = plan.tasks.slice(0, tasks.length);
  for (let i = 0; i < plan.tasks.length; i++) {
    const row = plan.tasks[i];
    const known = byId.get(row.taskId);
    if (!known && row.taskId) continue; // real id, just not one of ours — leave it
    const task = known ?? tasks[i];
    if (!task) continue;
    row.taskId = task.id ?? `t${i + 1}`;
    if (!row.taskTitle) row.taskTitle = (task.title ?? `Task ${i + 1}`).slice(0, 120);
    if (!row.selected) row.selected = [...row.options].sort((a, b) => b.confidence - a.confidence)[0].name;
  }
  // Fill any tasks the model skipped, with a deterministic single-option row.
  for (const t of tasks) {
    const tid = t.id ?? "";
    if (!plan.tasks.some((row) => row.taskId === tid)) {
      plan.tasks.push({
        taskId: tid,
        taskTitle: (t.title ?? tid).slice(0, 120),
        options: [{ name: "direct implementation", approach: "Straightforward build within the stack.", pros: ["simple"], cons: [], confidence: 0.75 }],
        selected: "direct implementation",
        tieBreakRequired: false,
        tieBreakReason: "",
      });
    }
  }
}

function repairRoutingPlan(
  plan: RoutingPlan,
  algos: { taskId?: string; taskTitle?: string }[]
): void {
  const validIds = new Set(MODEL_IDS);
  plan.routes = plan.routes.slice(0, algos.length);
  for (let i = 0; i < plan.routes.length; i++) {
    const row = plan.routes[i];
    const known = algos.find((a) => a.taskId === row.taskId);
    const task = known ?? algos[i];
    if (!task) continue;
    row.taskId = task.taskId ?? "";
    if (!row.taskTitle) row.taskTitle = (task.taskTitle ?? "").slice(0, 120);
    if (!validIds.has(row.selectedModel)) {
      row.selectedModel = (row.options.find((o) => validIds.has(o.model))?.model ?? CHEAP_MODEL_ID) as TaskModelRoute["selectedModel"];
    }
    for (const o of row.options) {
      if (!validIds.has(o.model)) o.model = row.selectedModel;
    }
  }
  for (const a of algos) {
    const aid = a.taskId ?? "";
    const atitle = a.taskTitle ?? "";
    if (!plan.routes.some((row) => row.taskId === aid)) {
      plan.routes.push({
        taskId: aid,
        taskTitle: atitle.slice(0, 120),
        options: [{ model: CHEAP_MODEL_ID, confidence: 0.7, estimatedCost: 1, estimatedLatencyMs: 2000, qualifiesBecause: "Fast default workhorse." }],
        selectedModel: CHEAP_MODEL_ID,
        reason: "Default route (router omitted this task).",
        confidence: 0.7,
        tieBreakRequired: false,
      });
    }
  }
  // Universal decision rule (F8): a row is a tie ONLY if its own options are close.
  for (const row of plan.routes) {
    const top = [...row.options].sort((a, b) => b.confidence - a.confidence);
    const gap = top.length > 1 ? top[0].confidence - top[1].confidence : 1;
    row.tieBreakRequired = top[0].confidence < 0.72 || gap < 0.12;
  }
}

export function stackTextOf(session: PipelineSession): string {
  const gate = session.stackGate;
  if (!gate) return session.statedStack || "unspecified";
  const chosen =
    gate.candidates.find((c) => c.proposal.name === gate.selected) ?? gate.candidates[0];
  return chosen.proposal.components.map((c) => `${c.layer}: ${c.choice}`).join("; ");
}

// ---------- Apply human gate actions ----------
export async function applyGateAction(
  session: PipelineSession,
  action: GateAction,
  adapters: StageAdapters,
  orgId = ORG_ID
): Promise<PipelineSession> {
  return orgContext.run(orgId, async () => {
  switch (action.action) {
    // Human recovery for a failed gate: clear the error, mark running, and let the
    // background processor re-run the same gate (providers are re-attempted; models
    // benched for quota errors stay benched, so the chain moves past dry models).
    case "retry_gate": {
      if (session.gateStatus !== "failed") {
        throw Object.assign(new Error("This gate is not in a failed state."), { statusCode: 409 });
      }
      session.gateStatus = "running";
      session.error = undefined;
      await recordToLedger({
        orgId: currentOrg(),
        sessionId: session.id,
        gate: session.gate,
        eventType: "gate_retry",
        actor: "human",
        detail: { summary: `Human requested a retry of the ${session.gate} gate` },
      });
      break;
    }

    case "suitability_choose": {
      if (session.gate !== "suitability") break;
      if (action.choice === "suggested") {
        // Re-extraction from the suggestion happens in runSuitability (background
        // via processGate — suitability already populated is the signal). Doing
        // the understand() call here blocked the HTTP response for 30-60s.
        session.gateStatus = "running";
      } else {
        session.workflow = session.suggestedWorkflow ?? session.workflow;
      }
      await recordToLedger({
        orgId: currentOrg(),
        sessionId: session.id,
        gate: "suitability",
        eventType: "human_decision",
        actor: "human",
        detail: {
          summary: `User ${action.choice === "suggested" ? "accepted the suggested workflow" : "kept the original workflow"}`,
        },
      });
      // "original": workflow is ready → advance to flaws directly (flaw detection
      // runs in background via processGate; the UI polls until the report is
      // ready). "suggested": the gate STAYS on suitability — processGate routes
      // back into runSuitability, whose populated-suitability re-entry branch
      // performs the re-extraction and THEN advances to flaws.
      if (action.choice !== "suggested") {
        session.gate = "platform";
        session.gateStatus = "awaiting_user";
      }
      break;
    }

    case "platform_choose": {
      if (session.gate !== "platform") break;
      session.targetPlatform = action.targetPlatform;
      session.gate = "flaws";
      session.gateStatus = "running";
      await recordToLedger({
        orgId: currentOrg(),
        sessionId: session.id,
        gate: "platform",
        eventType: "platform_selected",
        actor: "human",
        detail: {
          summary: `Target platform: ${
            action.targetPlatform === "both" ? "Android and iOS"
            : action.targetPlatform === "web" ? "Web application (browser)"
            : action.targetPlatform === "android" ? "Android"
            : "iOS"
          }`,
          targetPlatform: action.targetPlatform,
        },
      });
      break;
    }

    case "flaw_resolve": {
      if (session.gate !== "flaws" || !session.flawReport) break;
      session.flawResolutions = action.resolutions;
      const unresolvedCritical = session.flawReport.flaws.filter(
        (f) =>
          f.severity === "critical" &&
          !action.resolutions.some(
            (r) => r.flawId === f.id && (r.decision === "accepted" || r.decision === "edited")
          )
      );
      await recordToLedger({
        orgId: currentOrg(),
        sessionId: session.id,
        gate: "flaws",
        eventType: "human_decision",
        actor: "human",
        detail: {
          summary: `Flaw gate: ${action.resolutions.filter((r) => r.decision !== "rejected").length} fixes applied, ${action.resolutions.filter((r) => r.decision === "rejected").length} rejected`,
          resolutions: action.resolutions,
        },
        humanEdit: { resolutions: action.resolutions },
      });
      if (unresolvedCritical.length > 0) {
        session.gateStatus = "awaiting_user"; // F3: nothing moves forward until gate cleared
      } else {
        // Stack analysis (AI) runs in the background via processGate.
        session.gate = "stack";
        session.gateStatus = "running";
      }
      break;
    }

    case "stack_choose": {
      if (session.gate !== "stack" || !session.stackGate) break;
      const chosen = session.stackGate.candidates.find((c) => c.proposal.name === action.choice);
      if (!chosen) break;
      session.stackGate.selected = chosen.proposal.name;
      session.stackGate.tieBreakRequired = false;
      session.gate = "tasks";
      session.gateStatus = "awaiting_user";
      await recordToLedger({
        orgId: currentOrg(),
        sessionId: session.id,
        gate: "stack",
        eventType: "human_decision",
        actor: "human",
        detail: { summary: `User locked stack "${chosen.proposal.name}"` },
      });
      break;
    }

    case "tasks_edit": {
      if (session.gate !== "tasks" || !session.workflow) break;
      // Keep dependencies consistent with the surviving task ids.
      const ids = new Set(action.tasks.map((t) => t.id));
      for (const t of action.tasks) {
        t.dependsOn = (t.dependsOn ?? []).filter((d: string) => ids.has(d));
      }
      session.workflow.tasks = action.tasks;
      refreshTaskFingerprints(session);
      // Algorithm recommendation (AI) runs in the background via processGate.
      session.gate = "algorithms";
      session.gateStatus = "running";
      await recordToLedger({
        orgId: currentOrg(),
        sessionId: session.id,
        gate: "tasks",
        eventType: "human_decision",
        actor: "human",
        detail: { summary: `Task list confirmed with ${action.tasks.length} tasks` },
      });
      break;
    }

    case "retry_task": {
      if (session.gate !== "review" && session.gate !== "execution") {
        throw Object.assign(new Error("retry_task is only available during execution or review"), { statusCode: 409 });
      }
      const { retryTask } = await import("../../services/execution.js");
      const { session: restarted } = await retryTask(currentOrg(), session.id, action.taskId);
      // restartExecution saved + restarted the loop; adopt its state.
      session.gate = restarted.gate;
      session.gateStatus = restarted.gateStatus;
      session.executions = restarted.executions;
      session.workspaceFiles = restarted.workspaceFiles;
      break;
    }

    case "trust_budget_approve": {
      if (session.gate !== "execution" || session.trustBudget?.status !== "exhausted") break;
      session.trustBudget.remaining += action.amount;
      session.trustBudget.initial += action.amount;
      session.trustBudget.status = "active";
      session.gateStatus = "awaiting_user";
      await recordToLedger({
        orgId: currentOrg(),
        sessionId: session.id,
        gate: "execution",
        eventType: "trust_budget_approved",
        actor: "human",
        detail: { summary: `Human approved ${action.amount} additional trust units`, amount: action.amount },
      });
      break;
    }

    case "algorithm_choose": {
      if (session.gate !== "algorithms" || !session.algorithms) break;
      const task = session.algorithms.tasks.find((t) => t.taskId === action.taskId);
      if (!task) break;
      task.humanChoice = action.choice;
      task.selected = action.choice;
      task.tieBreakRequired = false;
      const stillWaiting = session.algorithms.tasks.filter((t) => t.tieBreakRequired);
      if (stillWaiting.length === 0) {
        // Model routing (AI) runs in the background via processGate.
        session.gate = "models";
        session.gateStatus = "running";
      }
      await recordToLedger({
        orgId: currentOrg(),
        sessionId: session.id,
        gate: "algorithms",
        eventType: "human_decision",
        actor: "human",
        taskId: action.taskId,
        detail: { summary: `User chose approach "${action.choice}" for ${task.taskTitle}` },
      });
      break;
    }

    case "model_choose": {
      if (session.gate !== "models" || !session.routing) break;
      const route = session.routing.routes.find((r) => r.taskId === action.taskId);
      if (!route) break;
      if (!route.options.some((option) => option.model === action.choice)) {
        throw Object.assign(new Error("Selected model is not an available option for this task"), { statusCode: 422 });
      }
      const wasTieBreak = route.tieBreakRequired;
      route.humanChoice = action.choice;
      route.selectedModel = action.choice;
      route.tieBreakRequired = false;
      const stillWaiting = session.routing.routes.filter((r) => r.tieBreakRequired);
      if (stillWaiting.length === 0) {
        session.gate = "execution";
        session.gateStatus = "pending";
        session.modelsFinalized = true;
        await recordToLedger({
          orgId: currentOrg(),
          sessionId: session.id,
          gate: "models",
          eventType: "models_finalized",
          actor: "human",
          detail: { summary: `Model routing finalized after the last human decision — Run unlocked`, routes: session.routing.routes.length },
        });
      }
      await recordToLedger({
        orgId: currentOrg(),
        sessionId: session.id,
        gate: "models",
        eventType: "human_decision",
        actor: "human",
        taskId: action.taskId,
        model: action.choice,
        detail: { summary: `User routed ${route.taskTitle} to ${action.choice}`, override: !wasTieBreak },
      });
      break;
    }

    case "finalize_models": {
      // Part 1/2: the explicit human handoff from planning into the coding workspace.
      // Refuses silently-resolvable states loudly instead of half-passing.
      if (!session.routing || !session.workflow || !session.algorithms) {
        throw Object.assign(new Error("Models cannot be finalized before model routing exists"), { statusCode: 409 });
      }
      if (session.gate !== "models" && session.gate !== "execution") {
        throw Object.assign(new Error("Models can only be finalized at the Models stage"), { statusCode: 409 });
      }
      const unresolvedTies = session.routing.routes.filter((r) => r.tieBreakRequired);
      if (unresolvedTies.length > 0) {
        throw Object.assign(
          new Error(`Cannot finalize: ${unresolvedTies.length} model tie-break(s) still require a human decision`),
          { statusCode: 409 }
        );
      }
      session.modelsFinalized = true;
      session.gate = "execution";
      session.gateStatus = "pending";
      await recordToLedger({
        orgId: currentOrg(),
        sessionId: session.id,
        gate: "models",
        eventType: "models_finalized",
        actor: "human",
        detail: { summary: "Human finalized model routing — coding workspace Run unlocked", routes: session.routing.routes.length },
      });
      break;
    }

    case "code_edit": {
      if (session.gate !== "review") break;
      const execution = session.executions.find((e) => e.taskId === action.taskId);
      if (!execution?.code) {
        throw Object.assign(new Error("This task has no editable code artifact"), { statusCode: 409 });
      }
      if (execution.code.version !== action.expectedVersion) {
        throw Object.assign(new Error("This code changed in another session. Reload before saving."), { statusCode: 409 });
      }
      execution.code.current = action.code;
      execution.code.version += 1;
      execution.code.updatedAt = new Date().toISOString();
      await recordToLedger({
        orgId: currentOrg(),
        sessionId: session.id,
        gate: "review",
        eventType: "code_edited",
        actor: "human",
        taskId: action.taskId,
        detail: { summary: `Saved manual code edit for ${execution.code.fileName}`, version: execution.code.version },
        humanEdit: { codeVersion: execution.code.version, codeChars: action.code.length },
      });
      break;
    }

    // F22 AI Battle Mode: run one task on two models side-by-side; the human verdict
    // feeds reputation (winner accepted, loser rejected) so routing learns from it.
    case "battle_run": {
      const { runBattle } = await import("../../services/battle.js");
      await runBattle({ session, taskId: action.taskId, modelA: action.modelA, modelB: action.modelB, orgId: currentOrg() });
      break;
    }
    case "battle_pick": {
      const { pickBattleWinner } = await import("../../services/battle.js");
      await pickBattleWinner({ session, taskId: action.taskId, winner: action.winner, orgId: currentOrg() });
      break;
    }
    }
    return session;
  });
}
