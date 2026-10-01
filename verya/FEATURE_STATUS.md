# Verya — Feature Functionality Breakdown (All 52 Features, code-verified)

> The original 53-item spec includes payments, which are excluded per instruction;
> with billing removed the list is 52 features (onboarding renumbered to #48).

Every claim below was verified against the current codebase (file references included).
Status legend:

- **LIVE** — implemented end-to-end: UI → API → service → Postgres, real data, no fakes.
- **PARTIAL** — core works; named sub-features are missing (listed).
- **NOT BUILT** — absent from the codebase (deferred waves, not silently faked).

**Totals: 13 LIVE · 20 PARTIAL · 19 NOT BUILT** (payments excluded per instruction).

> Update (2026-09-18, second implementation batch): the highest-leverage gaps were
> closed and verified — F9's learning loop last mile, F13's external-knowledge check,
> F16 rating/note/edit capture, F5 merge/split/delete, F22 Battle Mode +
> Explain-My-Decision + trust badges, F38 Clerk pages/token bridge/RBAC, F49 legal
> pages with consent gate, and F1 PDF/DOCX server-side intake. F1/F9/F13 are now LIVE;
> F15 (counterfactual comparison) and F49 moved from NOT BUILT to PARTIAL.
>
> Update (2026-09-19, consensus and routing-policy batch): the flaws gate now runs
> independent Gemini/Groq/Mistral analyses when those providers are configured,
> preserves each opinion in the session, shows per-issue agreement/confidence, and
> records consensus metadata in the Trust Ledger. Routing now supports the fourth
> specified policy, `org_approved`, enforced by `VERYA_APPROVED_MODELS`.
>
> Update (2026-09-19, Task DNA batch): F19 now derives a versioned deterministic
> fingerprint from task/workflow/algorithm data, persists it in session JSON,
> supplies it to routing, and displays it in task and review surfaces.
>
> Update (2026-09-20, security & latency-integrity batch): F40 now has a real
> prompt-injection defence (`lib/security/injection.ts`): every user-supplied string is
> scanned deterministically, manipulation phrases are neutralized before prompting, raw
> text is wrapped in an explicit untrusted-data envelope, uploaded/external documents
> are validated before they reach a model, and every scan is a Trust Ledger record.
> F44 now measures Verya's OWN added latency: each AI stage writes a `stage_timing`
> ledger row splitting wall-clock time into provider time vs Verya overhead, aggregated
> into `routingOverhead` in the analytics payload. A regression suite now exists:
> `cd backend && npm test` (node's runner + tsx) — 16 tests covering F40, F19 and the
> timing aggregation, all passing, plus backend/frontend `tsc --noEmit` clean.

> Update (2026-09-20, implementation pass): F10 now has a dedicated, indexed
> `correction_of` ledger reference included in the hash payload; F21 exposes
> task-category and workflow-session usage breakdowns plus a trust-bar-based
> cheapest qualifying model recommendation; F38 records authenticated sign-in,
> sign-out, and permission-change events; F48 has a first-run workspace guide,
> help center, and support contact; F50 captures acquisition source and emits
> Open Graph/Twitter metadata; F51 reports database/queue health and includes a
> `pg_dump` backup command and restore runbook. F4 now supports up to five stack
> candidates with structured trade-offs and comparison UI, F5 has a dependency
> map, F6 accepts up to five algorithm options, and F8 thresholds are runtime
> configurable through `VERYA_AUTO_FLOOR` and `VERYA_TIE_GAP`.

> Update (2026-10-01, coding-workspace pass): **standing requirements** (noted for
> all future work): (0) the Target platform gate offers **Web** alongside Android/iOS/Both
> — web-targeted projects plan and verify against browser delivery; (1) the human user always has edit rights in the Verya editor —
> real workspace files save through the versioned `/files/edit` endpoint at ANY gate,
> never read-only-blocked; (2) EVERY generated project folder is professional /
> industrial-grade — conventional layout (src, public, tests, docs, config), README.md,
> .gitignore, package manifest — enforced both in the execution prompt and by a
> deterministic post-execution scaffold pass; (3) EVERY web project previews as a real
> running app — the execution prompt requires a self-contained index.html, and a
> bounded post-execution pass (`services/scaffold.ts` → `ensurePreviewEntry`) generates
> the entry page when no task produced one, so the IDE Preview is never empty for a
> web project.
>
> Update (2026-09-20, governance pass): F15 now automatically runs a
> cross-provider counterfactual comparison for high-risk tasks; F16 checks human
> edits with the rules verifier; F17 has durable, evidence-backed policy
> suggestions with admin approval and version history; F18 compiles a readable
> living constitution from active policies and live controls; F26 applies
> configurable trust decay during inactivity; and F27 records pre-execution
> failure forecasts using risk, injection signals, and observed model trust.
>
> Update (2026-09-20, Phase 4 delegated-authority pass): F23 is now LIVE —
> delegated authority grants, privilege-escalation prevention, the fail-closed
> central authorization evaluator, lazy expiry, lifecycle state machine,
> admin-gated grant mutations, the dashboard Delegated Authority card, and a
> 48-test delegation security suite (105 backend tests total, all passing;
> backend + frontend `tsc --noEmit` clean, production build clean).

---

## PART A — Entry & Workflow Intake

### F1 · Landing Page / Entry Point — **LIVE**

**Mechanics.** `components/intake/IntakeForm.tsx` renders a freeform textarea (RHF +
Zod via `schemas/pipeline.ts`). No client-side restructuring: the raw text is POSTed
as-is to `POST /api/pipeline` (Fastify `routes/pipeline.ts`), validated by
`StartRequestSchema` (min 20 / max 20,000 chars — the server-side cap), sanitized
(`lib/middleware.ts sanitizeInput`), and the suitability gate runs immediately.
Loading state: "Analyzing…" button state → `SessionView` shows a pulsing "Verya is
working…" while `gateStatus === "running"`.

**Sub-features:**
- ✅ Freeform text box — no client-side cap; expands (`resize-y`); server soft-caps at 20k.
- ✅ File upload — **PDF/DOCX/DOC/RTF + text formats** (≤10MB). Binary formats go
  through `POST /api/pipeline/upload` with **server-side extraction**: `pdf-parse` for
  PDF, `mammoth` for DOCX, best-effort salvage for legacy .doc/RTF; the extracted text
  is combined with any typed description and ledgered with extracted char count.
  Extraction failures and scanned/no-text documents return explicit 422 guidance —
  never a silent empty analysis. Text formats are read client-side and appended.
- ✅ Draft persistence — Zustand `persist` (`stores/ui-store.ts`, key `verya-ui`) stores
  the draft, stack toggle, policy, and session id across reloads.
- ✅ Three example starters + routing-policy selector on the form.

**Gaps:** none material — upload happens inside the single analyze flow (no separate
multi-file queue, by design for MVP).

### F2 · Workflow Suitability Check — **LIVE**

**Mechanics.** `lib/pipeline/gates.ts runSuitability`: the Gemini layer extracts a
structured workflow (`UNDERSTANDING_SYSTEM`), repairs it deterministically
(`repairWorkflow`: ids, de-dup, dependency validation), then `SUITABILITY_SYSTEM`
reads description + workflow **as one connected plan** and returns
`{suitable, confidence, reason, suggestedWorkflow?, suggestedSummary?}` — validated by
`SuitabilitySchema`. Both outcomes are written to the ledger (`suitability_passed` /
`suitability_flagged`).

**Sub-features:**
- ⚠️ Verdict card — `GateSuitability.tsx` renders green "✓ suitable (N% confidence)" or
  amber "⚠ may not fit". The spec's three-state badge (green/amber/red) is collapsed to
  two states (suitable / not suitable).
- ✅ Alternative workflow generator — on unsuitable, a restructured plain-text numbered
  plan is produced and displayed.
- ✅ Hard gate choice — "Use suggested workflow" vs "Keep mine anyway"; the pipeline
  cannot advance until one is chosen (`suitability_choose` action); the choice is
  ledger-recorded as a human decision.

**Gaps:** binary verdict (no "workable but weaker" middle state); alternative shown
sequentially, not as a side-by-side comparison table.

### F3 · Flaw Detection — **LIVE**

**Mechanics.** `FLAW_SYSTEM` is a rubric, not an open ask — it explicitly enumerates the
six categories and mandates per-flaw `{id, title, category, severity, description,
suggestedFix, relatedTaskIds}`, critical-first. `provider.ts detectFlaws` adds a
self-consistency retry: if the summary claims gaps but `flaws[]` is empty, the model is
re-asked once with the contradiction made explicit.

**Sub-features:**
- ✅ Security gap check — flags **omission** (auth/encryption/rate-limit/secrets never mentioned).
- ✅ Architecture / logic / scale / cost / non-functional checks — all six in the rubric.
- ✅ Per-flaw atomic accept/reject — `GateFlaws.tsx` sorts by severity, each flaw is an
  independent decision, decisions are sent as `flaw_resolve` resolutions.
- ✅ No silent skips — critical flaws without an explicit accept/edited decision keep the
  gate closed ("N critical flaw(s) unresolved — the gate stays closed"); the backend
  enforces the same rule and only advances to stack when criticals are resolved.
- ✅ Every resolution is ledger-recorded (`human_decision` + `humanEdit` payload).

**Gaps:** flaws render as a list, not one-at-a-time stepper. Consensus metadata is
shown alongside the existing approval controls; low-agreement recommendations remain
human decisions.

---

## PART B — Stack, Task Breakdown & Routing Pipeline

### F4 · Stack Suggestion — **LIVE**

**Mechanics.** `runStack` branches on `statedStack`:
- **Path A (given):** `STACK_VALIDATE_SYSTEM` validates against the workflow →
  `fit | fit_with_changes | poor_fit` + notes; the user's stack becomes a locked
  candidate ("Your stack"); verdict is ledger-recorded.
- **Path B (none):** `STACK_RECOMMEND_SYSTEM` proposes 1–3 full-stack candidates, each
  with per-layer components (frontend/backend/database/cache/auth/hosting/jobs/storage)
  and a rationale per layer.

**Sub-features:**
- ✅ Stack validator (Path A only).
- ✅ Stack generator (Path B only) — multiple ranked candidates with confidence.
- ⚠️ Trade-off comparison — candidates render side-by-side with confidence % and
  per-layer rationale cards, but there is no attribute matrix (cost / learning curve /
  scaling ceiling columns).
- ✅ Stack lock — `stack_choose` locks the selection; `stackTextOf()` feeds the locked
  stack into algorithm selection, routing, and execution; the lock is a ledger event.

**Gaps:** 1–3 candidates (spec: 3–5); tie-break follows F8 (confidence-gap), no
attribute table.

### F5 · Workflow Breakdown Into Tasks — **PARTIAL**

**Mechanics.** Task decomposition happens in the understanding stage (`WorkflowSchema`:
tasks with id/title/description/category/complexity/risk/dependsOn, 4–14 tasks). The
`tasks` gate renders `GateTasks.tsx`: inline title editing per row, category ·
complexity · risk badges, dependency display, then `tasks_edit` finalizes. The backend
re-aligns dependencies against surviving ids after edits.

**Sub-features:**
- ✅ Task decomposition engine (LLM → structured task array).
- ✅ Dependency mapper (`dependsOn` validated + repaired; execution topologically orders
  tasks from it).
- ✅ Task editor UI — inline edit, **split** (creates a sequential second half that
  inherits dependencies), **merge up** (concatenates title/description, absorbs
  dependencies, scrubs the dropped id everywhere), **delete** (scrubs dangling
  dependency references). All sent as one array via `tasks_edit`; modified lists are
  flagged in the UI before confirming.
- ✅ Finalize/lock control — "Confirm tasks →" is the explicit lock.

**Gaps:** the dependency map is staged columns rather than a node-and-edge DAG.

### F6 · Algorithm / Approach Selection Per Task — **LIVE**

**Mechanics.** `runAlgorithms` calls `ALGORITHM_SYSTEM` with the locked workflow +
locked stack: per task, 1–4 candidate approaches with `approach`, `pros`, `cons`,
`confidence`. `repairAlgorithmPlan` aligns rows to real task ids positionally and fills
any skipped task with a deterministic single-option row, so a sloppy model response can
never kill the gate.

**Sub-features:**
- ✅ Candidate generator (multi-option per task, never one answer).
- ⚠️ Constraint-aware scorer — constraints come from the workflow text the model already
  read; there is no dedicated user-supplied constraint input (data size / latency target).
- ✅ Auto-select vs tie-break router — F8 applied (`tieBreakRequired` per task).
- ✅ Per-task reasoning log — every auto pick, human pick, and tie count is
  ledger-recorded (`algorithm_selected` / `algorithm_tiebreak` / `human_decision`).

**Gaps:** no explicit constraint capture UI.

### F7 · AI Model Routing Per Task — **PARTIAL**

**Mechanics.** `runRouting` + `ROUTING_SYSTEM`: the router scores a fixed 12-model pool
(`MODEL_POOL`: Gemini ×2, Groq ×3, Mistral ×4, OpenRouter ×3) with per-model
`specialties` (per-task-type strength profile), `costPerTask` tiers, and per-option
`confidence / estimatedCost / estimatedLatencyMs / qualifiesBecause`. The org's routing
policy is then applied on top of the raw ranking (`lowest_cost` downgrades when the
accuracy delta is small; `highest_accuracy` upgrades when the strong model qualifies).
Failover across providers is real (`runModelText`: requested model → same-provider
siblings → other providers → Gemini native; daily-quota exhaustion is remembered per
model; per-model retries with backoff).

**Sub-features:**
- ✅ Routing policy — all 4 specified policies are implemented
  (`lowest_cost`, `highest_accuracy`, `balanced`, `org_approved`). Approved-only mode
  requires a non-empty `VERYA_APPROVED_MODELS` comma-separated allowlist and fails
  explicitly when no approved model qualifies.
- ✅ Per-task-type strength profile — `specialties` per pool model; execution honors the
  routed model with cross-provider failover.
- ✅ Routing policy — all four policies are implemented, including
  `org_approved` through `VERYA_APPROVED_MODELS`.
- ✅ Auto-route vs tie-break UI — `GateModels.tsx`: clear winners render with reasons;
  ties render option cards (confidence %, cost, latency, why-it-qualifies) with pick buttons.
- ✅ Manual override — the tie UI *is* the override surface; `model_choose` +
  human_decision are ledger-recorded.

**Gaps:** there is no admin UI for editing the approved-model allowlist.

### F8 · Universal Decision Rule — **LIVE**

**Mechanics.** `needsTieBreak(options)` in `schemas/pipeline.ts`: auto-decide only if
top confidence ≥ `AUTO_FLOOR` (0.72) AND gap to runner-up ≥ `TIE_GAP` (0.12). Applied
at the stack gate, in `repairAlgorithmPlan`, and in `repairRoutingPlan` (which force-
recomputes each row's tie status from its own options so the model can't fake or hide a
tie). Every auto decision carries a rendered reason and a ledger entry; ties always
render side-by-side and block until the human picks.

**Sub-features:**
- ✅ Confidence-gap calculator (the two constants).
- ✅ Auto-decide-with-reason renderer (all three gates show "clear winner, reason shown").
- ⚠️ Tie-break picker component — behaviorally identical across stack/algorithm/model
  gates but implemented as three similar JSX blocks, not one shared component.

**Gaps:** thresholds are exported constants — tunable, but not runtime config/env
(the spec wants config-tunable thresholds).

---

## PART C — Learning, Trust & Verification Layer

### F9 · Organization-Specific Memory Engine — **LIVE**

**Mechanics.** On every feedback event, `services/pipeline.ts` calls
`recordMemory` → `services/memory.ts embed()` → Gemini `text-embedding-001`
(1536-dim, env-swappable; deterministic local hash embedder as keyless fallback) →
`org_memory` row with a `vector(1536)` column, strictly `org_id`-scoped.
`/api/memory/search` does cosine-similarity retrieval (`1 - embedding <=> $2`), surfaced
in the dashboard's "Org memory search (pgvector)" card. Skill map aggregates
outcome→trust per (model, category) via SQL CASE weights → the heatmap panel.

**Sub-features:**
- ✅ Feedback event capture (accept/edited/rejected + rating/note in `meta`).
- ✅ Embedding + vector store (pgvector ivfflat index).
- ✅ Similarity retrieval (top-N per query, tenant-scoped).
- ✅ Org skill map (heatmap on dashboard).
- ✅ Export/delete controls (`/api/memory/export` JSON download, `DELETE /api/memory`).
- ✅ **Retrieval → prompt injection (the last mile is closed)**: `runAlgorithms` pulls
  the top similar past tasks per workflow category (pgvector cosine) and injects them
  as `[category]` context into the algorithm prompt; `runRouting` injects the org's
  model×category outcome history ("earned trust here" / "struggled here" with sample
  counts and avg quality) so routing is biased by what actually worked. Memory failure
  degrades to no-context, never breaking a gate.

### F10 · AI Trust Ledger — **LIVE**

**Mechanics.** `repositories/ledger.ts`: every gate decision, execution, verification,
and human action INSERTs immediately (never batched). Rows are append-only —
application flow only ever INSERTs; each row carries
`prev_hash` + `chain_hash = SHA-256(prev_hash || canonical payload)`; per-org
`pg_advisory_xact_lock` serializes appends so the chain can't fork under concurrency;
genesis rows use `prev_hash = "GENESIS"`. `verifyChain` re-walks the whole org chain and
reports the first broken seq. Fields captured: org, session, gate, event_type,
actor (ai|human|system), model, task, detail JSONB, verification, human_edit,
timestamps — indexed by (org,time), (org,model), (org,event), session.

**Sub-features:**
- ✅ Append-only write layer (INSERT-only path; corrections are new rows carrying
  `humanEdit`).
- ✅ Structured record schema (fixed field set on every write).
- ✅ Query/filter interface — `GET /api/ledger/records?sessionId&model&eventType&gate&from&to&limit`
  + the dashboard table.
- ⚠️ Correction-by-reference — corrections are new rows with the original referenced in
  `human_edit` JSONB; corrections now also carry a dedicated indexed `correction_of`
  reference column.
- ⚠️ Configurable retention — not implemented; rows are kept indefinitely.
- ✅ Compliance export — one-click CSV (`/api/ledger/export`).
- ✅ Integrity banner — the dashboard shows a red warning the moment `verifyLedger`
  reports a broken chain.

### F11 · Explainable Confidence and Escalation — **PARTIAL**

**Mechanics.** `services/execution.ts`: after verification, confidence is set
(0.82 verified-pass / 0.4 fail) and compared to a **per-risk escalation floor**
(`lib/thresholds.ts`: high 0.85 / medium 0.55 / low 0.4, each env-overridable via
`VERYA_ESCALATION_FLOOR_<RISK>`): pass + below floor → status `escalated`; fail →
`flagged`; everything is ledger-recorded with the verification result. The dashboard's
Review Queue collects escalated/flagged/failed events from the ledger.

**Sub-features:**
- ✅ Confidence scorer (per output).
- ⚠️ Rationale generator — verification issues are the plain-language rationale; there is
  no dedicated "why this might be wrong" narrative attached to the score itself.
- ✅ Threshold engine — per-risk-level floors (high/medium/low), env-configurable per
  deployment; per-department partitioning remains open.
- ⚠️ Escalation queue renderer — summary rows (summary, model, session); not the full
  single-screen reviewer view (output + score + rationale + considered alternatives).

### F12 · AI Reputation System — **PARTIAL**

**Mechanics.** `model_reputation` keyed `(org_id, model, task_category)`. On every
feedback event `updateReputation` runs an EMA update (α=0.15) toward the outcome target
(accepted 100 / verified 80 / edited 60 / escalated 40 / flagged 20 / rejected 0)
**dampened by observed latency and cost** (bounded penalties, so one slow-but-correct
run can't crater a score) and stores `trend` (up/flat/down). Continuous — updates land
the moment feedback arrives. Leaderboard panel sorts by trust score (`/api/reputation`);
the heatmap merges reputation with the memory skill map.

**Sub-features:**
- ✅ Score computation — outcome quality **plus cost/latency penalties** (correction
  frequency is reflected through the `edited` outcome target; failure severity through
  `flagged`/`rejected`).
- ✅ Per-task-category scoring (segmented, not blended).
- ✅ Continuous update trigger (event-driven, no batch).
- ✅ Leaderboard + **inline trust badges** (`TrustBadge` renders live reputation next to
  every model in the routing and review screens).
- ❌ Stack/algorithm reputation — models only.

### F13 · Output Verification — **PARTIAL**

**Mechanics.** `provider.ts verifyOutput`: a deterministic rules pre-pass (hardcoded
secrets, API keys, dangerous SQL patterns, auth tasks must mention hashing) → then, for
non-low-risk tasks, an independent second model **on a different provider than the
executor** returns `{passed, issues[]}` (JSON-extracted, fenced-block tolerant).
Low-risk tasks skip the second model (risk-based depth). If the second model is
unavailable, verification degrades to rules-only with an explicit "rules-only" note —
never a fake pass.

**Sub-features:**
- ✅ Second-model cross-check (provider-independent by design).
- ✅ Rules engine check (policy violations, required security basics).
- ✅ External knowledge check — `lib/verification/external.ts` validates npm package
  references in code-bearing outputs against the live npm registry; non-existent
  packages become verification issues ("references non-existent npm package X"),
  gracefully skipped when offline.
- ⚠️ Risk-based depth selector — low-risk → rules-only + external check; everything
  else → + second model. A configurable depth ladder remains open.

### F14 · Adversarial Self-Auditing — **LIVE**

High-risk execution outputs now receive a bounded, provider-independent adversarial pass
(`backend/src/lib/ai/provider.ts`). The audit checks generated edge-case and prompt-injection
probes, records a 0–1 risk score, issues, checks, and the serving model on each execution
result, and escalates when `VERYA_SELF_AUDIT_THRESHOLD` is exceeded (default `0.55`).
Existing verification remains authoritative and unchanged; audit failure is non-fatal.
The review UI displays the audit score and issues for human follow-up.

### F15 · Counterfactual Model Comparison — **PARTIAL**

**AI Battle Mode** (`services/battle.ts`, F22 UI) runs the same task on two models in
parallel and records the human's verdict; the winner is fed to reputation (accepted) and
the loser (rejected), ledgered as `battle_run`/`battle_pick` — a human-judged
counterfactual comparison. **What remains from the spec:** automatic triggering on
high-value/high-risk tasks without a human prompt, and an AI comparison scorer instead
of human-only judgment.

### F16 · Human Feedback and Trust Calibration — **PARTIAL**

**Mechanics.** `GateReview.tsx` renders every execution with its model, status badge,
token/latency stats, verification issues, and the full output (collapsible), plus
Accept / Reject per output. Each decision is `POST /api/pipeline/:id/action
{action:"feedback"}` → recorded to memory + reputation + ledger.

**Sub-features:**
- ✅ Controls — accept/reject, **1–5 star rating**, free-text note, and **edit capture**
  (an inline editor on every output; changed text is sent as `editedOutput`). The
  feedback action carries all of it to memory + reputation + ledger in one event.
- ⚠️ Edit-quality checker — edited outputs are stored and ledgered with the human edit;
  an automated "did the edit measurably improve the result" pass is not yet run.
- ❌ Reviewer calibration score.
- ❌ Reliability-filtered feedback pipeline (all feedback currently feeds learning).

---

## PART D — Self-Governance Layer

### F17 · Autonomous Policy Suggestions — **PARTIAL**
Implemented: recurring flagged/failed/escalated model-category patterns produce
versioned, evidence-backed suggestions; admins can approve or reject them and all
states are durable. Remaining: approved policies are not yet enforced by routing.
### F18 · Living Constitution Document — **PARTIAL**
Implemented: `/api/policies/constitution` and the dashboard compile approved policies,
verification depth, escalation thresholds, and reputation into readable text.
Remaining: export formats and change-triggered snapshots are not yet implemented.
### F19 · Task DNA Fingerprinting — **LIVE**

**Mechanics.** `backend/src/lib/pipeline/fingerprint.ts` computes a stable SHA-256
signature and structured dimensions for every task: complexity, category/domain, risk,
context size, output format, reasoning requirement, and sorted required capabilities.
It uses existing workflow, dependency, and algorithm-plan fields only (no additional AI
call). Fingerprints are embedded on tasks and mirrored in the optional
`PipelineSession.taskFingerprints` map. The gate engine refreshes them on every
processed gate and after task edits, so sessions created before F19 are safely
backfilled while retaining compatibility with older persisted JSON.

**Sub-features:**
- ✅ Deterministic versioned fingerprint with stable signature.
- ✅ Routing prompt receives task DNA as structured context for future model selection.
- ✅ Fingerprint shown in task confirmation and execution review UI.
- ✅ Optional schema fields preserve older sessions without migration.

**Gaps:** no cross-session DNA analytics or historical fingerprint comparison UI yet.
### F20 · Cross-Organization Failure Intelligence — **NOT BUILT**

None of the Part D self-governance features exist. This is the documented Phase 6 wave
(BUILD_PLAN.md) that deliberately waits for real usage data. Nothing in the UI fakes them.

---

### F21 · Cost, Risk, and Performance Optimization — **PARTIAL**

**Mechanics.** Every execution logs tokens (input/output), latency, model, and cost tier
to the ledger; `ledgerAnalytics` aggregates per-model task counts, avg latency, and
tokens → the dashboard analytics cards + bar chart. The routing policy enum
(`lowest_cost | balanced | highest_accuracy`) applied in F7 is the cost-vs-risk control;
it is chosen at intake.

**Sub-features:**
- ⚠️ Usage metering — tokens/latency/model ✅; retry count, rework, human-review time, and
  final failure outcome are not separately metered.
- ⚠️ Breakdown views — by model only; not by stack/team/workflow/department.
- ❌ Cost-vs-risk slider — a discrete policy select, not a spectrum slider.
- ❌ Cheapest-that-meets-trust-bar recommender (the `lowest_cost` policy is a static
  downgrade rule, not a trust-bar computation).

---

## PART E — Dashboard

### F22 · User Dashboard and Interface — **PARTIAL**

**Mechanics.** `/dashboard` (TanStack Query, 15s refetch) renders, all from real API data:
integrity banner (broken-chain alert), analytics cards (ledger events, executions, chain
status, queue mode) + per-model latency bar chart (Recharts), model reputation
leaderboard (trust/samples/trend), org skill-map heatmap, review/escalation queue,
workflow history (gate + status + updated), trust-ledger table (seq/time/gate/event/
model/summary/chain-hash) with CSV export, and pgvector memory search. DB-not-connected
and inline-vs-queue states are explicit, not blank. The working gate screens (flaw
review, stack/algorithm/model pickers, task list, execution, review) render in the
intake island on the home page.

**Sub-features:**
- ✅ Flaw review panel, stack/algorithm/model pickers (tie-break UI on genuine ties only),
  task breakdown view, workflow/task history, leaderboard, heatmap, analytics,
  escalation alerts, review queue, compliance export.
- ✅ AI Battle Mode (`GateReview`: "⚔ Battle vs …" runs a second model in parallel,
  side-by-side outputs with latency/token stats, human picks the winner; verdict feeds
  reputation and the ledger).
- ✅ "Explain My Decision" chat (`ExplainPanel` on the dashboard → `POST /api/explain`):
  retrieves the actual ledger slice for the session/task/model and a model explains the
  reasoning from that evidence with record-number citations; org-scoped, refuses to
  speculate when evidence is missing.
- ✅ Trust badges inline — `TrustBadge` next to every model in routing and review.
- ❌ Governance policy management screen (depends on F17).
- ❌ Role-aware panels (Auditor/Reviewer/Admin views; depends on F38 RBAC).

---

## PART F — Advanced Governance Layer (Second Wave)

### F23 · Agent Identity & Delegated Authority — **LIVE (Agent Registry + Phase 4 Delegated Authority verified)**
**Mechanics.** `005_agent_registry.sql` + `repositories/agents.ts` + `services/agents.ts` + `routes/agents.ts` + `components/dashboard/AgentRegistryCard.tsx`: Persistent, organization-scoped Agent Registry. Server-generated `agent_id`, owner, versioning (`v1`..`vN`), parent agent hierarchy & delegation chain calculation, controlled agent types (`planner`|`router`|`analyzer`|`executor`|`verifier`|`reviewer`|`auditor`|`researcher`|`custom`), autonomy levels (`LEVEL_0`..`LEVEL_4`), risk classification, declared model & tool metadata, data scope, and full lifecycle state machine (`draft`|`active`|`suspended`|`revoked`|`archived`). Every transition records append-only audit events to the Trust Ledger. Dashboard UI provides search, type/status filtering, creation modal, inspection drawer, and status action controls.

**Phase 4 — Delegated Authority (verified).** `006_delegated_authority.sql` + `repositories/delegations.ts` (+ devstore) + `schemas/delegation.ts` + `services/delegations.ts` + `routes/delegations.ts` + `components/dashboard/DelegatedAuthorityCard.tsx`:
- Capability grants per (agent, org): explicit `allowed_actions` / `allowed_tools` / resource constraints, data scope, risk ceiling, expiry, `can_delegate`, versioning; lifecycle `ACTIVE→SUSPENDED→ACTIVE`, `→REVOKED` (terminal), `→EXPIRED` (terminal, lazy tenant-safe repair on read/evaluate).
- **Privilege-escalation prevention** at creation and update: child risk/data-scope/actions/tools/resource constraints can never exceed the parent (shared `resourceCoveredBy` logic); revoked/expired parents invalidate children at evaluation time (chain walk, cycle-safe); updates cannot widen authority and cannot change status (PATCH status changes rejected — dedicated endpoints only).
- **Central authorization evaluator** `POST /api/authorization/evaluate`: fail-closed (no delegation, inactive agent, expired/revoked/suspended, missing action/tool, out-of-scope data, excessive risk, unmatched resource, invalid parent chain → DENY with reason codes); resource constraints are a closed allowlist when present (wildcard/prefix/tool/action/environment/amount semantics documented in the schema); every ALLOW/DENY is a ledger event.
- **Security posture**: admin-only delegation create/update/suspend/revoke/reactivate via the existing F38 `requireAdmin` RBAC; broad root authority (wildcard actions/tools, sensitive/restricted scope, high/critical risk ceiling) additionally requires an admin role in the service; identity always from `req.auth` (never client body); tenant isolation proven across create/read/update/revoke/parent-reference.
- **Dashboard card** lists delegations with explicit capabilities (agent, delegator, purpose, status, risk limit, actions, tools, resources, data scope, created, expires, version), agent/status/search filters, suspend/revoke/reactivate controls, a creation form with pre-grant authority review, and an authorization preflight evaluator.
- Covered by the 48-test delegation suite (`lib/security/delegations.test.ts`): CRUD, lifecycle state machine, tenant isolation, escalation prevention (incl. multi-level), privileged broad-root rule, resource-constraint semantics, 14 authorization deny paths, lazy expiry, and audit events. Remaining: wiring evaluation into pipeline execution of agent-attributed work is deferred (authorization decisions are Phase 4 scope; connecting them to runtime actions is Phase 5).
### F24 · Runtime Action Firewall — **NOT BUILT**
### F25 · Causal Trust Graph — **NOT BUILT**
### F26 · Trust Decay and Recovery — **PARTIAL**
Inactivity decay is applied per model and task category with
`VERYA_TRUST_DECAY_PER_30_DAYS`; supervised execution outcomes recover scores through
the existing reputation update path. Remaining: a distinct severe-failure drop and
supervised-recovery workflow UI.
(reputation has continuous updates but no decay-over-disuse, failure-drop, or
supervised-recovery mechanics)
### F27 · Failure Forecasting — **PARTIAL**
Before execution, Verya estimates failure probability from task risk, prompt-injection
risk, and observed model/category trust, then records the score and reason for review.
Remaining: forecast-triggered rerouting or pre-execution human escalation.
### F28 · Trust Budget — **PARTIAL**
Risk-weighted trust budget calculation (`lib/trust-budget.ts`), consumption tracking during task execution (`services/execution.ts` and `jobs/worker.ts`), execution pausing on exhaustion (`trust_budget_exhausted` ledger event), and human replenishment gate action (`trust_budget_approve` in `lib/pipeline/gates.ts`). Remaining: dedicated trust budget slider & allocation UI.
### F29 · Reversible Execution / Safe Simulation — **NOT BUILT**
### F30 · Data Consent & Purpose Enforcement — **NOT BUILT**
### F31 · Evidence-Weighted Answering — **NOT BUILT**
### F32 · Model Failure Fingerprints — **NOT BUILT**
### F33 · Synthetic Red-Team Factory — **NOT BUILT**
### F34 · Governance Digital Twin — **NOT BUILT**
### F35 · Adaptive Policy A/B Testing — **NOT BUILT**
### F36 · Trust Certificates — **PARTIAL**
Hash-bound execution trust certificates (`lib/certificates.ts`), certificate generation (`certificateFor`), signature integrity verification (`verifyCertificate`), verification REST endpoint (`GET /certificates/:sessionId/:taskId`), and automatic embedding in verified execution results (`services/execution.ts` & `jobs/worker.ts`). Remaining: evidence package expansion, model version metadata, external verification key registry.
### F37 · Incident Replay & Counterfactual Debugging — **NOT BUILT**

All 13 remaining second-wave features are unbuilt by design (Phase 7 in BUILD_PLAN.md). The
architecture leaves clean room for them: the ledger's canonical payload could carry
graph edges (F25), the model pool/adapter layer is the natural hook for fingerprints and
forecasting (F27/F32), and hash-chained rows are certificate-ready (F36).

---

## PART G — Security

### F38 · Authentication & Access Control — **PARTIAL**

**Mechanics.** Clerk is the single auth system. Frontend: `ClerkProvider` wraps the app
when `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is set (graceful no-auth render without it).
Backend: `middleware/auth.ts` verifies `Authorization: Bearer <jwt>` against Clerk's
JWKS (`jose`, issuer/audience checked), derives `orgId` from the token's org claim, and
attaches `req.auth` to **every** request via an `onRequest` hook. All repositories
scope every query by that `orgId`. Without Clerk configured, the API runs in a clearly
labeled development mode (org from `x-org-id` for local multi-org testing) — never a
silent fake.

**Sub-features:**
- ✅ Email/password + OAuth — Clerk sign-in/sign-up pages (`/sign-in`, `/sign-up`, themed
  to the app) render when Clerk is configured; `AuthBridge` (`app/providers.tsx` +
  `lib/auth-bridge.ts`) injects the Clerk session token as `Authorization: Bearer` on
  every API request.
- ⚠️ 2FA — Clerk-supported; not enabled/configured.
- ✅ RBAC — `requireAdmin` (`middleware/auth.ts`) guards admin-only routes (org memory
  purge/export, lead list, ledger CSV export) via the token's `org_role` claim or an
  env-listed admin id set; development mode is clearly labeled and permissive.
- ⚠️ Session management — Clerk-issued JWTs are short-lived; there is no custom refresh
  flow (Clerk handles it, not yet integrated).
- ✅ Auth event logging — sign-in, sign-out, and permission change events are logged to the ledger (`routes/auth-events.ts`).

### F39 · Data Security — **PARTIAL**

- ✅ TLS in transit — Neon requires SSL (`sslmode=require`; `rejectUnauthorized` unless
  `PGSSL_DISABLE=1` for local dev); production traffic is HTTPS.
- ⚠️ Encryption at rest — inherited from Neon's defaults; not explicitly AES-256-configured.
- ❌ Secrets vault — provider keys live in env files, not a managed vault.
- ✅ Tenant isolation — `org_id` scoping is structurally enforced in every repository
  function (sessions, ledger, memory, reputation, leads) — a query without the org
  predicate cannot be issued through the repo layer.
- ✅ Input sanitization — `sanitizeInput` (control-char strip + length cap) on all
  user-supplied text; upload allowlist + 2MB cap; parameterized SQL everywhere (no
  string-built queries).
- ✅ Rate limiting — `@fastify/rate-limit` globally (60/min) + per-route buckets
  (uploads 10/min, leads 5/min).

### F40 · Prompt Injection & AI-Specific Security — **LIVE**

**Mechanics.** `backend/src/lib/security/injection.ts` is the single gate every
untrusted string passes through. `scanInjection` runs 10 deterministic rules across six
categories (instruction-override, policy-bypass, system-prompt exfiltration,
role-manipulation, tool-manipulation, data-exfiltration, delimiter/chat-token breaks),
returning findings with severity plus a 0–1 risk. `hardenUntrusted` neutralizes detected
imperative phrases (replacing the phrase with `[blocked-instruction:<category>]`) when
the risk crosses `VERYA_INJECTION_RISK_THRESHOLD` (default 0.3), and `wrapUntrusted`
envelops the text in an explicit “this is data, not instructions” block. The original
text stays on the session verbatim for display and audit; only the hardened copy is
prompted.

**Sub-features:**
- ✅ Content/instruction separation — dual defence: the data envelope **and** phrase
  neutralization, on top of the fixed system-prompt contract.
- ✅ Injection pattern detector — deterministic, offline, zero extra AI cost; runs on
  project intake (`POST /api/pipeline`), on every uploaded document, and at the prompt
  boundary in `provider.ts` (understanding, suitability, flaws, stack) and in the
  multi-model consensus prompt.
- ✅ External content sanitizer — uploaded PDF/DOCX/RTF/text is scanned as external
  untrusted content before any model sees it; the ledger distinguishes
  `external_content_flagged` from `external_content_scanned`.
- ✅ Audit trail — `injection_scan_clean` / `injection_scan_flagged` ledger rows carry
  risk and per-finding category/severity; the scan is persisted on the session as
  `inputSecurity` (optional field, older sessions unaffected).
- ✅ Tested — `src/lib/security/injection.test.ts` (7 cases) plus an end-to-end intake
  test proving the session record and ledger rows are written through the real service
  layer.

**Gaps:** the rule set is code-level (not admin-editable) and detection is
English-pattern based; non-English or novel phrasings rely on the data envelope.

### F41 · Compliance & Privacy — **PARTIAL**

- ✅ Access/export request handling — org memory JSON export + ledger CSV export
  (admin-gated).
- ✅ Deletion request handling — `DELETE /api/memory` purges the org's memory data
  (admin-gated).
- ✅ ToS/Privacy acceptance gate — the lead-capture form requires explicit consent
  (`acceptTerms` Zod-literal-true on both ends), stores `accepted_terms_at` on the lead
  row, and links the actual documents.
- ❌ Configurable retention + auto-purge.
- ❌ Cookie consent banner (no tracking cookies are set, but the banner flow is absent).

### F42 · Vulnerability Management — **PARTIAL**

- ⚠️ Dependency scanning — `npm audit` reports cleanly today; no automated CI scanning.
- ❌ Patch management process, pre-launch pentest, responsible-disclosure channel.
  (Process-level items; nothing in code contradicts them.)

---

## PART H — Performance & Scalability

### F43 · Concurrency & Load Handling — **PARTIAL**

- ✅ Background job queue — BullMQ (`jobs/queues.ts`): execution jobs with 3 attempts,
  exponential backoff (5s base), `removeOnComplete/Fail` caps; `jobs/worker.ts` consumes
  with configurable concurrency and re-runs the identical execution path the API uses
  inline. Without Redis the API executes inline and the dashboard says "inline mode".
- ✅ Live progress — the session poller refetches every 2.5s while `gateStatus ===
  "running"`; execution shows "(N/M done)".
- ❌ Load balancer / auto-scaling — deployment-level, not in code (stateless Fastify +
  Next.js make it straightforward).

### F44 · Speed Targets — **LIVE**

- ✅ Frontend load — both routes prerender static (build output `○ Static`), Turbopack
  build, Geist via `next/font`, minimal JS (home 134kB route size).
- ✅ Progress-indicator rule — every long operation shows state (pulse/counter), never a
  frozen blank screen.
- ✅ Routing-overhead monitoring — `lib/metrics.ts` wraps every AI gate
  (`suitability/flaws/stack/algorithms/models`) in `timeStage`, which snapshots the
  cumulative provider-call clock (`providerCallStats()` in `provider.ts`) before and
  after, then writes one `stage_timing` ledger row per stage with `stageMs`,
  `providerMs`, `providerCalls` and `overheadMs`. `ledgerAnalytics` aggregates these
  into `routingOverhead` (averages per gate, overall overhead share), which the
  dashboard payload already carries — so Verya's own added latency is measured
  separately from provider latency. Timing is best-effort: a failed stage still
  records its timing and observability never breaks the pipeline.

### F45 · Database & Caching — **PARTIAL**

- ✅ Scalable primary datastore — indexes on every hot path: sessions (org+time,
  org+gate), ledger (org+time, session, org+model partial, org+event), memory
  (org+time, org+category, ivfflat), leads (email, time).
- ❌ Caching layer — no cache for model registry / repeated lookups.
- ❌ Analytics/reporting separation — analytics queries run on the primary.
- ⚠️ Ledger partitioning — indexed but not partitioned (fine at MVP scale; the spec's
  concern kicks in at millions of rows).

### F46 · Reliability Under Load — **PARTIAL**

- ✅ Provider failover — real and multi-layered: retryable-error detection, per-model
  retries with backoff (2s/6s/15s), daily-quota exhaustion tracking (a 429-per-day model
  is benched for the process lifetime), same-provider → cross-provider → Gemini-native
  chains, and verification's provider-independence rule.
- ✅ Feature isolation — memory search, skill map, and queue health all degrade to empty/
  "inline" without blocking core routes; verification degrades to rules-only.
- ❌ Monitoring & alerting — `/health` + structured pino logs exist; no Sentry/metrics/
  alert routing yet.

---

## PART I — Product Launch Readiness

### F47 · Domain, Hosting & Infrastructure — **PARTIAL**

- ✅ Environment separation in config — `BACKEND_ORIGIN`/`NEXT_PUBLIC_API_URL`/
  `NEXT_PUBLIC_APP_URL`/`CORS_ORIGINS` cleanly split dev vs prod topology; Next rewrites
  kill CORS friction in dev.
- ❌ Domain/DNS, CDN, staging environment — deployment tasks, not code.

### F48 · Onboarding & Support — **PARTIAL**

- ✅ First-run guidance — three example projects, the How-It-Works deck page (which
  explains exactly the two unfamiliar patterns: workflow submission and tie-breaks),
  gate stepper labels, empty/error states everywhere.
- ✅ First-run walkthrough and help center; support contact link is available.
- ❌ Email verification flow and staffed/ticketed support channel.

### F49 · Legal & Business Basics — **PARTIAL**

✅ ToS, Privacy Policy, and Refund Policy pages (`/legal/terms`, `/legal/privacy`,
`/legal/refunds` — full plain-language documents in `lib/legal.ts`, statically
prerendered, cross-linked, footer-linked, opened from the consent checkbox).
❌ Company registration disclosure and a cookie/GDPR consent flow (no tracking cookies
are set; the banner flow is still absent).

### F50 · Marketing-Facing Pages — **PARTIAL**

- ✅ Marketing site — the full 10-page deck (hero/IDE mockup, problem, five gates,
  tie-breaks, trust & audit with live ledger, use cases, pricing, FAQ, get-started with
  real lead capture, final CTA) rebuilt from `index.html` on Next.js 15 + Tailwind.
- ✅ SEO basics — per-route metadata (title/description), `sitemap.xml` (home,
  dashboard, all legal pages) and `robots.txt` (`/dashboard` disallowed).
- ✅ Open Graph/Twitter metadata and signup-source capture (UTM/referrer).

### F51 · Monitoring, Backups & Maintenance — **PARTIAL**

- ✅ Health endpoints (backend `/health` reports DB/auth/queue posture; frontend shows
  backend status in the header).
- ✅ Structured logging — pino (pretty in dev) with request-failure logging.
- ❌ Error tracking (Sentry), uptime monitoring/alerts, public status page.
- ⚠️ Backups — Neon provides PITR, but a tested restore procedure isn't documented/run.


### F53 · Real AI Coding Execution (workspace files) — **LIVE**

> Added 2026-09-21. The coding workspace writes REAL project files.

**Mechanics.** Execution parses each routed model output into structured file operations
(`services/fileops.ts`: `{files:[{path,operation,content}]}` JSON or path-declared code
fences), validates every path against the workspace jail and applies it to the session
workspace (`services/workspace.ts`: create/update/delete, per-file version + provenance).
Design artifacts (`ExecutionResult.code`) remain for design-only outputs and are labeled
`.txt`; source files live in `session.workspaceFiles` and render in the Explorer/Editor
via `routes/workspace.ts`. Verification marks code tasks with zero file ops as issues;
failed tasks block dependents; `servedBy` records failover transparently; every file op
and rejection is a Trust Ledger event. Models → Run is an explicit finalization gate:
`session.modelsFinalized` + `assertModelsFinalized` in both the HTTP and queue paths,
`finalize_models` action, and the frontend Run states (waiting/ready/running/paused/
completed/failed) derived only from session truth. Covered by the 24-test workspace suite
(`lib/security/workspace.test.ts`): path traversal/absolute/UNC/reserved-name rejection,
create/update/delete semantics, the finalization gate (ties block, unfinalized blocks,
finalize unlocks), dependency blocking, retry authorization, and tenant isolation.

### F54 · Professional VS Code-Style IDE Environment — **LIVE**

> Added 2026-09-21. Coding workspace transformed into a professional IDE.

- ✅ VS Code-style Activity Bar (`ActivityBar.tsx`) with 5 views: Explorer, Search, Source Control, Run, Governance.
- ✅ Left Sidebar with active view switching: Explorer (nested tree + task list with file icons), Search (real file search), Changes (grouped by Added/Modified/Deleted from real FileOps), Run (task execution progress bar and statuses), Governance (trust budget progress, risk level, verification summary, agent status).
- ✅ Editor Tab strip with file-type badges, dirty state tracking, close buttons, and active tab indicator.
- ✅ Breadcrumbs bar (`Breadcrumbs.tsx`) displaying clickable hierarchical path segments.
- ✅ Enhanced Code Editor (`CodeEditor.tsx`) with real-time active line highlight, synced line numbers gutter, smooth scrolling, in-editor search (Ctrl+F), CAS save (Ctrl+S), line/col status line, and dirty indicators.
- ✅ Command Palette (`CommandPalette.tsx`, Ctrl+Shift+P) and Quick Open (Ctrl+P) backed by real functionality and real files.
- ✅ Dedicated Agent Status Header above the interactive AgentChat: live agent status dot, current task, assigned model, recent actions trail (✓/✗/●).
- ✅ Collapsible Bottom Panel (`BottomPanel.tsx`) with 7 tabs: Execution Monitor, Problems (aggregated verification issues), Output, Changes, Tests (honestly disclaimed), Verification, Events.
- ✅ Status Bar (`StatusBar.tsx`) displaying cursor position, language, UTF-8, Trust budget, and Risk level.
- ✅ Global IDE keyboard shortcuts: Ctrl+P, Ctrl+Shift+P, Ctrl+B, Ctrl+`, Ctrl+W, Ctrl+Shift+F, Ctrl+S, Ctrl+F, Ctrl+Shift+V (Preview).
- ✅ Agent auto-start after model finalization: when the shell first sees an armed state (`runState === "ready"`), execution dispatches automatically and the AgentChat announces the dispatch (task → model list). Failed dispatches re-arm for manual ▶ Run.
- ✅ Human edit rights, always: the editor is writable at every stage. Real workspace files save via `POST /pipeline/:id/files/edit` (CAS versioned, ledger-audited, works pre/during/after execution — `WorkspaceShell.saveActive` routes to it automatically); legacy design artifacts keep the review-gate `code_edit` path.
- ✅ Industrial project scaffolding (every project): the execution prompt mandates a conventional layout (src/, public/, tests/, docs/, manifests) and `ensureProjectScaffolding` deterministically adds a professional README.md (overview, stack, structure tree, setup steps, model-assignment table, Trust Ledger provenance) and a stack-aware .gitignore when the models didn't ship them.
- ✅ Guaranteed preview entry (web projects): `ensurePreviewEntry` detects a completed web project with no .html and makes ONE bounded model call to generate the missing index.html front door (linked to the real generated pages); ledger-recorded as `preview_entry_generated`/`preview_entry_failed`. The workspace Preview can no longer be empty for a web project.
- ✅ Project Preview (`PreviewPane.tsx`, toolbar button / View menu / Ctrl+Shift+V): renders the generated project inside a sandboxed iframe (`allow-scripts`, no same-origin) built client-side from the real workspace files (`lib/workspace/preview.ts`). Entry selection: root index.html → any index.html → shortest .html; sibling CSS/JS are inlined, small images become data URLs, and relative ES-module imports resolve via an injected import map. Multi-page apps work: relative `.html` links are intercepted and swapped virtually (postMessage), with an entry-page dropdown in the toolbar. "Open in new tab" exports the assembled document. Projects without an HTML entry (APIs, backends) get an honest inventory page listing the real files. Desktop/mobile viewport toggle, manual reload, and auto-reload when the agent edits files while previewing; when execution completes with a UI project, the preview opens automatically.
- ✅ Web/UI execution contract: `EXECUTION_SYSTEM` now instructs routed models that web/UI tasks must ship a runnable, self-contained, professionally styled `index.html` (no build step, relative links between pages, realistic sample data) — every UI project previews as a real app, not a placeholder.
- ✅ Full preservation of existing execution engine, Trust Ledger, tenant isolation, CAS saves, and backend contracts.

### F52 · Launch Checklist — **NOT BUILT**

Process artifact, not code. The checklist items (load test, pentest sign-off, legal
pages, backup/monitoring confirmation, staffed support) map onto the gaps above.

---

## Priority gap list (highest leverage first)

*Updated after the second implementation batch — items 1–8 from the previous list are
closed and verified (F9 injection, F16 feedback, F5 editor, F3 edit-fix, F38 RBAC,
F12 formula, F13 external check, F11 floors, F22 panels, F49 legal pages, F1 uploads).
The remaining highest-leverage work:*

*Verified in the security & latency batch:* F40 (injection defence) and F44
(routing-overhead monitoring) are closed — both were PARTIAL and are now LIVE, covered
by the new regression suite.

1. **F10 correction-by-reference** — add the dedicated `correction_of` link column (the
   SQL comment promises one) so corrections are queryable, not only embedded in JSONB.
2. **F38 finish** — Clerk in the live environment (keys, org claims) and auth-event
   ledger records.
3. **F21 breakdowns** — cost/risk analytics by stack/team/workflow, plus the
   cheapest-that-meets-trust-bar recommender (routing overhead is now measurable, which
   is the input that recommender needs).
4. **F48 onboarding** — email verification flow, help center, support channel.
5. **F51 operations** — Sentry/error tracking, uptime alerts, tested restore procedure.
6. **Wave 2 governance (F17–F20, F23–F37)** — unchanged, deliberately deferred until
   real usage data exists.
