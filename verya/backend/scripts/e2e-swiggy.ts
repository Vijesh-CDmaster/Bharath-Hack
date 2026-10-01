// E2E fidelity probe — drives a fresh (or resumed) "clone of Swiggy" session through
// ALL gates with the real AI pool, then reports whether the output resembles Swiggy.
// Run from verya/backend:
//   node --import tsx scripts/e2e-swiggy.ts              # start fresh
//   node --import tsx scripts/e2e-swiggy.ts <sessionId>  # resume an existing session
// Isolated in org "e2e-fidelity-org" so the user's session list is untouched.
import "../src/config/env.js";
import { query } from "../src/db/pool.js";

const ORG = "e2e-fidelity-org";

function log(msg: string, obj?: unknown): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (obj === undefined) console.log(line);
  else if (typeof obj === "string") console.log(line, obj);
  else console.log(line, JSON.stringify(obj));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // Test tenant must exist before sessions can reference it (sessions_org_id_fkey).
  await query("INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [
    ORG,
    "E2E Fidelity Test Org",
  ]);

  const { startPipeline, getPipeline, actOnPipeline } = await import("../src/services/pipeline.js");
  const { startExecution } = await import("../src/services/execution.js");
  type AnySession = Record<string, any>;

  const act = async (s: AnySession, action: Record<string, unknown>, why: string): Promise<AnySession> => {
    log(`[action] ${action.action} (${why})`);
    const next = await actOnPipeline(ORG, s.id, action as never);
    return next as AnySession;
  };

  // Poll until the gate stops "running" AND the expected data for `ready` exists.
  const waitGate = async (
    id: string,
    timeoutMs: number,
    label: string,
    ready?: (s: AnySession) => boolean
  ): Promise<AnySession> => {
    const deadline = Date.now() + timeoutMs;
    let last: AnySession | null = null;
    while (Date.now() < deadline) {
      last = (await getPipeline(ORG, id)) as AnySession | null;
      if (!last) throw new Error("session vanished from DB");
      if (last.gateStatus === "failed") return last;
      if (last.gateStatus !== "running" && (!ready || ready(last))) return last;
      await sleep(4000);
    }
    throw new Error(`${label}: timed out with gateStatus=${last?.gateStatus} gate=${last?.gate}`);
  };

  const must = (s: AnySession, label: string): AnySession => {
    if (s.gateStatus === "failed") throw new Error(`${label} FAILED: ${s.error}`);
    return s;
  };

  const RESUME_ID = process.argv[2];
  const PROMPT =
    "Build a clone of Swiggy, the Indian food delivery app. Users browse nearby restaurants, " +
    "open a restaurant to see its menu with dish photos and prices in rupees, add dishes to a cart, " +
    "and place a delivery order they can track. It should look and feel like the real Swiggy app.";

  let s: AnySession;
  if (RESUME_ID) {
    s = (await getPipeline(ORG, RESUME_ID)) as AnySession | null;
    if (!s) throw new Error(`resume: session ${RESUME_ID} not found in org ${ORG}`);
    log(`[resume] session ${s.id} at gate=${s.gate}/${s.gateStatus}`);
  } else {
    log("[1] starting fresh session (understanding gate)…");
    s = (await startPipeline({ orgId: ORG, input: PROMPT, statedStack: "", policy: "balanced" })) as AnySession;
    log("session id:", s.id);
  }

  // ---- Gate 1: suitability (extract + verdict) ----
  if (!s.suitability) {
    s = must(await waitGate(s.id, 240_000, "suitability", (x) => Boolean(x.suitability)), "suitability");
  }
  const tasks = s.workflow?.tasks ?? [];
  log(`[checkpoint] workflow title: ${s.workflow?.title}`);
  log(`[checkpoint] ${tasks.length} planned tasks (fidelity of the plan):`);
  for (const t of tasks) log(`   - [${t.category}] ${t.title}`);
  log(`[checkpoint] UI/frontend tasks: ${tasks.filter((t: any) => t.category === "frontend").length}`);

  // ---- Human suitability decision (this is what flips gate → platform) ----
  if (s.gate === "suitability") {
    const choice = s.suitability?.suitable ? "original" : "suggested";
    s = await act(s, { action: "suitability_choose", choice }, `verdict=${s.suitability?.verdict}`);
    if (choice === "suggested") {
      s = must(await waitGate(s.id, 240_000, "suitability re-extract", (x) => x.gate === "platform"), "re-extract");
    }
  }

  // ---- Gate 2: platform (explicit human choice) ----
  if (s.gate === "platform") {
    s = await act(s, { action: "platform_choose", targetPlatform: "web" }, "web target");
  }

  // ---- Gate 3: flaws ----
  s = must(await waitGate(s.id, 300_000, "flaws", (x) => Boolean(x.flawReport)), "flaws");
  const flaws = s.flawReport?.flaws ?? [];
  log(`[checkpoint] flaw report: ${flaws.length} flaws detected`);
  if (s.gate === "flaws") {
    s = await act(
      s,
      { action: "flaw_resolve", resolutions: flaws.map((f: any) => ({ flawId: f.id, decision: "accepted" })) },
      "accept all fixes"
    );
  }

  // ---- Gate 4: stack ----
  s = must(
    await waitGate(s.id, 300_000, "stack", (x) => Boolean(x.stackGate?.candidates?.length)),
    "stack"
  );
  const stackName = s.stackGate.candidates[0].proposal.name;
  log(`[checkpoint] stack candidates: ${s.stackGate.candidates.map((c: any) => c.proposal.name).join(" | ")}`);
  if (s.gate === "stack") {
    s = await act(s, { action: "stack_choose", choice: stackName }, `chose "${stackName}"`);
  }

  // ---- Gate 5: tasks confirm ----
  if (s.gate === "tasks") {
    s = await act(s, { action: "tasks_edit", tasks: s.workflow.tasks }, `confirm ${s.workflow.tasks.length} tasks`);
  }

  // ---- Gate 6: algorithms ----
  s = must(await waitGate(s.id, 300_000, "algorithms", (x) => Boolean(x.algorithms?.tasks?.length)), "algorithms");
  const algTies = (s.algorithms.tasks ?? []).filter((t: any) => t.tieBreakRequired && !t.humanChoice);
  log(`[checkpoint] algorithm tie-breaks needing human choice: ${algTies.length}/${s.algorithms.tasks.length}`);
  for (const t of algTies) {
    const choice: string = t.options[0]?.name || t.selected || "Approach 1";
    s = await act(s, { action: "algorithm_choose", taskId: t.taskId, choice }, `tie for "${t.taskTitle}"`);
  }
  if (s.gate === "algorithms") {
    s = must(await waitGate(s.id, 300_000, "models-ready", (x) => Boolean(x.routing)), "models-ready");
  }

  // ---- Gate 7: model routing ----
  const routes = s.routing?.routes ?? [];
  log(
    "[checkpoint] model routing:",
    routes.map((r: any) => `${r.taskTitle} → ${r.selectedModel ?? "(tie)"}`).join("; ")
  );
  for (const r of routes.filter((x: any) => x.tieBreakRequired && !x.humanChoice)) {
    s = await act(s, { action: "model_choose", taskId: r.taskId, choice: r.options[0].model }, `tie for "${r.taskTitle}"`);
    if (s.gateStatus === "running") s = await waitGate(s.id, 120_000, "routing", (x) => Boolean(x.routing));
  }
  if (s.gate === "models") {
    s = await act(s, { action: "finalize_models" }, "handoff to workspace");
  }

  // ---- Execution: the real build ----
  log("[6] RUN — executing all tasks with real models (long step)…");
  s = ((await startExecution(ORG, s.id)) as any).session;
  s = must(await waitGate(s.id, 30 * 60_000, "execution"), "execution");
  if (s.gate === "execution" && s.trustBudget?.status === "exhausted") {
    log("NOTE trust budget exhausted before review", { consumed: s.trustBudget.consumed, remaining: s.trustBudget.remaining });
  }

  // ---------------- FIDELITY REPORT ----------------
  const files = s.workspaceFiles ?? [];
  log(`[result] terminal state: gate=${s.gate}/${s.gateStatus}, files=${files.length}, executions=${s.executions.length}`);
  for (const f of files) log(`   file ${f.path} (${f.content.length} chars, task=${f.taskId}, model=${f.model})`);

  const all = files.map((f: any) => f.content).join("\n");
  const stubHits = all.match(/\/\/\s*(implement|todo|fixme|placeholder)[^\n]*/gi) ?? [];
  const swiggySignals = {
    swiggyOrange_hex_or_name: /#ff5722|#fc8019|swiggy\s*orange/i.test(all),
    rupee_prices: /₹/.test(all),
    real_dishes: /biryani|dosa|paneer|butter\s*chicken|masala|idli|vada/i.test(all),
    ratings_present: /4\.\d|rating/i.test(all),
    add_to_cart: /add\s*to\s*cart/i.test(all),
    eta_delivery: /\b\d+\s*(min|mins|minutes)\b|delivery\s*time|eta/i.test(all),
  };
  log("[result] stub/placeholder comments found:", stubHits.length === 0 ? "NONE ✓" : stubHits.slice(0, 8));
  log("[result] lorem-ipsum content:", /lorem\s+ipsum/i.test(all) ? "PRESENT ✗" : "none ✓");
  log("[result] Swiggy signal scan:", swiggySignals);

  log(
    "[result] verification summary:",
    s.executions.map((e: any) => ({
      taskId: e.taskId,
      status: e.status,
      model: e.model,
      topIssues: (e.verification?.issues ?? []).slice(0, 2),
    }))
  );

  const entry = files.find((f: any) => /(^|\/)index\.html$/i.test(f.path));
  if (entry) log("[result] entry index.html (first 600 chars):", entry.content.slice(0, 600));
  else log("[result] ✗ NO index.html entry file generated");

  log("E2E DONE", { sessionId: s.id, files: files.length, executions: s.executions.length });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("E2E FAILED:", err);
    process.exit(1);
  });
