// Verya — gated pipeline type definitions
// Pipeline: Intake → Suitability Gate → Flaw Gate → Stack Gate → Task Gate
//           → Algorithm Gate → Model Gate → Execution → Verification → Feedback

import { z } from "zod";

export type Severity = "critical" | "high" | "medium" | "low";
export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export const TargetPlatformSchema = z.enum(["web", "android", "ios", "both"]);
export type TargetPlatform = z.infer<typeof TargetPlatformSchema>;

// Gemini 3.x quirks: explicit null for absent optionals, and arrays sometimes arrive as
// comma-joined strings (or a single bare string). These preprocessors absorb all of it.
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const nullTo = <V>(fallback: V, inner: z.ZodType<V, any, any>) =>
  z.preprocess((v) => (v == null ? fallback : v), inner);
const coerceStringArray = (v: unknown): unknown => {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "" || s === "null") return [];
    return s.split(/[,;]/).map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
  }
  return v;
};
const arr = (item: z.ZodType<string>, max = 50) =>
  z.preprocess(
    coerceStringArray,
    z.array(item as z.ZodType<string>).max(max) as unknown as z.ZodType<string[]>
  );

// Gemini 3.x sometimes double-encodes arrays of objects as a JSON string
// (e.g. flaws: "[{...}]"). Decode once before validating, and default null→[].
const decodeJsonPre = (v: unknown): unknown => {
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[") || s.startsWith("{")) {
      try {
        return JSON.parse(s);
      } catch {
        return v;
      }
    }
    return [];
  }
  return v == null ? [] : v;
};
const objArr = <T extends z.ZodTypeAny>(item: T, min = 0, max = 50) =>
  z.preprocess(decodeJsonPre, z.array(item).min(min).max(max));

// ---------- Gate 1: Suitability ----------
export const SuitabilitySchema = z.object({
  suitable: nullTo(false, z.boolean()),
  verdict: z.enum(["suitable", "workable", "unsuitable"]).nullish(),
  confidence: nullTo(0.6, z.number().min(0).max(1)),
  reason: nullTo("", z.string().max(600)),
  suggestedWorkflow: z.string().max(3000).nullish(),
  suggestedSummary: z.string().max(400).nullish(),
});
export type Suitability = z.infer<typeof SuitabilitySchema>;

// ---------- Workflow (shared across gates) ----------
export type TaskCategory =
  | "frontend"
  | "backend"
  | "database"
  | "auth"
  | "integration"
  | "devops"
  | "ai"
  | "other";

export const TaskSchema = z.object({
  // Tolerant: models occasionally omit fields; runSuitability repairs positionally.
  id: nullTo("", z.string().max(80)),
  title: nullTo("", z.string().max(120)),
  description: nullTo("", z.string().max(600)),
  category: nullTo("other" as const, z.enum([
    "frontend",
    "backend",
    "database",
    "auth",
    "integration",
    "devops",
    "ai",
    "other",
  ] as const)),
  dependsOn: arr(z.string()),
  agentId: z.string().optional(),
  complexity: nullTo("medium" as const, z.enum(["low", "medium", "high"])),
  risk: nullTo("medium" as const, z.enum(["low", "medium", "high"])),
  fingerprint: z.object({
    version: z.literal(1),
    complexity: z.enum(["low", "medium", "high"]),
    domain: z.string(),
    risk: z.enum(["low", "medium", "high"]),
    contextSize: z.enum(["small", "medium", "large"]),
    outputFormat: z.enum(["text", "structured-data", "code", "analysis"]),
    reasoningRequirement: z.enum(["direct", "standard", "evaluative", "deep"]),
    requiredCapabilities: z.array(z.string()),
    signature: z.string().length(16),
  }).optional(),
});
export type Task = z.infer<typeof TaskSchema>;
export type TaskFingerprint = NonNullable<Task["fingerprint"]>;

export const WorkflowSchema = z.object({
  title: nullTo("", z.string().max(120)),
  summary: nullTo("", z.string().max(800)),
  tasks: objArr(TaskSchema, 1, 30),
  ambiguities: arr(z.string(), 20),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

// ---------- Gate 2: Flaw Detection ----------
export const FlawSchema = z.object({
  id: nullTo("", z.string().max(40)),
  title: nullTo("", z.string().max(140)),
  category: nullTo("logic" as const, z.enum([
    "security",
    "architecture",
    "logic",
    "scale",
    "cost",
    "nonfunctional",
  ] as const)),
  severity: nullTo("medium" as const, SeveritySchema),
  description: nullTo("", z.string().max(700)),
  suggestedFix: nullTo("", z.string().max(700)),
  relatedTaskIds: arr(z.string()),
});
export const FlawReportSchema = z.object({
  flaws: objArr(FlawSchema, 0, 40),
  overallRisk: nullTo("medium" as const, z.enum(["low", "medium", "high"])),
  summary: nullTo("", z.string().max(500)),
});
export type Flaw = z.infer<typeof FlawSchema>;
export type FlawReport = z.infer<typeof FlawReportSchema>;

export const ModelOpinionSchema = z.object({
  provider: z.enum(["gemini", "groq", "mistral"]),
  status: z.enum(["completed", "failed"]),
  report: FlawReportSchema.optional(),
  error: z.string().optional(),
});
export const ConsensusIssueSchema = z.object({
  key: z.string(),
  title: z.string(),
  category: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  description: z.string(),
  suggestedFix: z.string(),
  relatedTaskIds: z.array(z.string()),
  votes: z.object({ gemini: z.boolean(), groq: z.boolean(), mistral: z.boolean() }),
  agreement: z.number().min(0).max(1),
  confidence: z.enum(["high", "medium", "low"]),
});
export const FlawConsensusSchema = z.object({
  opinions: z.array(ModelOpinionSchema),
  issues: z.array(ConsensusIssueSchema),
  completedProviders: z.number().int().min(0).max(3),
  consensusSummary: z.string(),
});
export type FlawConsensus = z.infer<typeof FlawConsensusSchema>;

export type FlawDecision = "accepted" | "rejected" | "edited";
export type FlawResolution = {
  flawId: string;
  decision: FlawDecision;
  editedFix?: string;
};

// ---------- Gate 3: Stack ----------
export const StackComponentSchema = z.object({
  layer: nullTo("backend" as const, z.enum([
    "frontend",
    "backend",
    "database",
    "cache",
    "auth",
    "hosting",
    "jobs",
    "storage",
  ] as const)),
  choice: nullTo("", z.string().max(80)),
  rationale: nullTo("", z.string().max(300)),
});
export const StackProposalSchema = z.object({
  name: z.string().max(80).default("Proposed stack"),
  components: objArr(StackComponentSchema, 1, 9),
  summary: nullTo("", z.string().max(400)),
  confidence: z.number().min(0).max(1).default(0.7),
  tradeoffs: z.object({
    cost: nullTo("", z.string().max(120)),
    learningCurve: nullTo("", z.string().max(120)),
    scalingCeiling: nullTo("", z.string().max(120)),
    ecosystem: nullTo("", z.string().max(120)),
  }).default({ cost: "", learningCurve: "", scalingCeiling: "", ecosystem: "" }),
});
export type StackProposal = z.infer<typeof StackProposalSchema>;

export const StackValidationSchema = z.object({
  verdict: nullTo("fit" as const, z.enum(["fit", "fit_with_changes", "poor_fit"])),
  notes: arr(z.string(), 16),
  changes: objArr(
    z.object({
      layer: nullTo("", z.string().max(40)),
      from: nullTo("", z.string().max(80)),
      to: nullTo("", z.string().max(80)),
      why: nullTo("", z.string().max(300)),
    }),
    0,
    8
  ),
});
export type StackValidation = z.infer<typeof StackValidationSchema>;

// A stack candidate carries an optional name + trust/confidence for tie handling.
export const StackCandidateSchema = z.object({
  proposal: StackProposalSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300).default(""),
});
export type StackCandidate = z.infer<typeof StackCandidateSchema>;

export const StackGateSchema = z.object({
  provided: z.boolean(),
  validation: StackValidationSchema.nullable(),
  candidates: objArr(StackCandidateSchema, 1, 5),
  selected: z.string().nullable(), // proposal name of chosen candidate
  tieBreakRequired: z.boolean(),
});
// note: StackProposal.confidence/rationale already tolerate null via nullish/default above
export type StackGate = z.infer<typeof StackGateSchema>;

// ---------- Gate 5: Algorithms (per task) ----------
export const AlgorithmOptionSchema = z.object({
  name: nullTo("", z.string().max(80)),
  approach: nullTo("", z.string().max(400)),
  pros: arr(z.string(), 8),
  cons: arr(z.string(), 8),
  confidence: nullTo(0.6, z.number().min(0).max(1)),
});
export const TaskAlgorithmSchema = z.object({
  // Tolerant defaults: gates.ts repairs missing ids/title positionally against the
  // known workflow tasks, so a sloppy model response can never kill the gate.
  taskId: nullTo("", z.string().max(80)),
  taskTitle: nullTo("", z.string().max(120)),
  options: objArr(AlgorithmOptionSchema, 1, 5),
  selected: nullTo("", z.string().max(80)),
  tieBreakRequired: nullTo(false, z.boolean()),
  tieBreakReason: nullTo("", z.string().max(300)),
  humanChoice: z.string().max(80).nullish(),
});
export const AlgorithmPlanSchema = z.object({
  // min 0: models sometimes return an empty list; repairAlgorithmPlan rebuilds
  // every row deterministically from the known workflow tasks.
  tasks: objArr(TaskAlgorithmSchema, 0, 40),
});
export type AlgorithmOption = z.infer<typeof AlgorithmOptionSchema>;
export type TaskAlgorithm = z.infer<typeof TaskAlgorithmSchema>;
export type AlgorithmPlan = z.infer<typeof AlgorithmPlanSchema>;

// ---------- Gate 6: Model routing ----------
// Multi-provider pool: the four configured API keys (Gemini, Groq, OpenRouter, Mistral)
// form ONE routing pool. The router picks per-task by specialty, cost tier, and latency;
// provider.ts owns how each id maps to a real API call (incl. cross-provider failover).
// All ids verified live against each provider's model list.
export const MODEL_IDS = [
  // Gemini (key 1) — native structured output, strong reasoning tier
  "gemini-3.6-flash",
  "gemini-3.1-pro-preview",
  // Groq (key 2) — lowest latency, strong open-weights general models
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
  // Mistral (key 3) — codestral is a dedicated code model
  "codestral-latest",
  "magistral-medium-latest",
  "mistral-medium-latest",
  "ministral-8b-latest",
  // OpenRouter (key 4) — free tier, its own per-model daily quota
  "z-ai/glm-5.2:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export type ProviderName = "gemini" | "groq" | "openrouter" | "mistral";
export type PoolTier = "strong" | "standard" | "fast" | "free";

export type PoolModel = {
  id: ModelId;
  provider: ProviderName;
  tier: PoolTier;
  costPerTask: number; // relative cost units (free tier = 0, flash-class ≈ 1, pro-class ≈ 4)
  specialties: TaskCategory[]; // task categories this model is routed to preferentially
};

export const MODEL_POOL: PoolModel[] = [
  { id: "gemini-3.6-flash", provider: "gemini", tier: "standard", costPerTask: 1, specialties: ["frontend", "backend", "database", "auth"] },
  { id: "gemini-3.1-pro-preview", provider: "gemini", tier: "strong", costPerTask: 4, specialties: ["backend", "database", "devops"] },
  { id: "openai/gpt-oss-120b", provider: "groq", tier: "standard", costPerTask: 1, specialties: ["backend", "ai", "integration"] },
  { id: "openai/gpt-oss-20b", provider: "groq", tier: "fast", costPerTask: 1, specialties: ["frontend", "other"] },
  { id: "qwen/qwen3.8-27b", provider: "groq", tier: "standard", costPerTask: 1, specialties: ["ai", "other"] },
  { id: "codestral-latest", provider: "mistral", tier: "standard", costPerTask: 1, specialties: ["frontend", "backend"] },
  { id: "magistral-medium-latest", provider: "mistral", tier: "strong", costPerTask: 2, specialties: ["backend", "auth", "database"] },
  { id: "mistral-medium-latest", provider: "mistral", tier: "standard", costPerTask: 1, specialties: ["integration", "devops"] },
  { id: "ministral-8b-latest", provider: "mistral", tier: "fast", costPerTask: 1, specialties: ["frontend", "other"] },
  { id: "z-ai/glm-5.2:free", provider: "openrouter", tier: "free", costPerTask: 0, specialties: ["frontend", "backend", "database"] },
  { id: "google/gemma-4-31b-it:free", provider: "openrouter", tier: "free", costPerTask: 0, specialties: ["frontend", "other"] },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", provider: "openrouter", tier: "free", costPerTask: 0, specialties: ["backend", "ai"] },
];

export function poolModelOf(id: string): PoolModel | undefined {
  return MODEL_POOL.find((m) => m.id === id);
}

export const STRONG_MODEL_ID: ModelId = "gemini-3.1-pro-preview";
export const CHEAP_MODEL_ID: ModelId = "openai/gpt-oss-20b"; // fastest + cheapest default workhorse

export function modelCostOf(id: string): number {
  return poolModelOf(id)?.costPerTask ?? 1;
}

export function alternateModelOf(id: string): ModelId | undefined {
  const provider = poolModelOf(id)?.provider;
  return MODEL_POOL.find((model) => model.id !== id && model.provider !== provider)?.id;
}

export const TaskModelRouteSchema = z.object({
  taskId: nullTo("", z.string().max(80)),
  taskTitle: nullTo("", z.string().max(120)),
  options: z
    .array(
      z.object({
        model: z.enum(MODEL_IDS),
        confidence: z.number().min(0).max(1),
        estimatedCost: z.number().min(0),
        estimatedLatencyMs: z.number().min(0),
        qualifiesBecause: nullTo("", z.string().max(200)),
      })
    )
    .min(1)
    .max(4),
  selectedModel: z.enum(MODEL_IDS),
  reason: nullTo("", z.string().max(300)),
  confidence: nullTo(0.6, z.number().min(0).max(1)),
  tieBreakRequired: nullTo(false, z.boolean()),
  humanChoice: z.string().max(40).nullish(),
});
export const RoutingPlanSchema = z.object({
  // min 0: repairRoutingPlan synthesizes default routes for any missing tasks.
  routes: objArr(TaskModelRouteSchema, 0, 40),
  policy: z.enum(["lowest_cost", "highest_accuracy", "balanced", "org_approved"]).default("balanced"),
  estimatedCostUsd: z.number().min(0),
  notes: z.string().max(400).default(""),
});
export type RoutingPolicy = "lowest_cost" | "highest_accuracy" | "balanced" | "org_approved";
export type TaskModelRoute = z.infer<typeof TaskModelRouteSchema>;
export type RoutingPlan = z.infer<typeof RoutingPlanSchema>;

// ---------- Execution & Verification ----------
export type ExecutionStatus =
  | "pending"
  | "running"
  | "verified"
  | "flagged"
  | "failed"
  | "escalated";

export type CodeArtifact = {
  language: string;
  fileName: string;
  original: string;
  current: string;
  version: number;
  updatedAt: string;
};

export function codeArtifactOf(output: string, taskTitle: string): CodeArtifact {
  const fenced = output.match(/```([a-zA-Z0-9+#.-]*)\s*\n([\s\S]*?)```/);
  const language = (fenced?.[1] || "text").toLowerCase();
  const source = (fenced?.[2] ?? output).trim();
  const extension =
    language.includes("typescript") || language === "tsx" ? "tsx" :
    language === "javascript" || language === "jsx" ? "jsx" :
    language === "python" ? "py" :
    language === "kotlin" ? "kt" :
    language === "swift" ? "swift" :
    language === "java" ? "java" :
    language === "json" ? "json" :
    language === "sql" ? "sql" : "txt";
  const safeTitle = taskTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "generated-code";
  return {
    language,
    fileName: `${safeTitle}.${extension}`,
    original: source.slice(0, 60000),
    current: source.slice(0, 60000),
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}

export const ExecutionResultSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().optional(),
  model: z.enum(MODEL_IDS),
  output: z.string().max(60000),
  code: z
    .object({
      language: z.string().max(40),
      fileName: z.string().max(160),
      original: z.string().max(60000),
      current: z.string().max(60000),
      version: z.number().int().min(1),
      updatedAt: z.string(),
    })
    .optional(),
  humanRating: z.number().min(1).max(5).optional(),
  humanNote: z.string().max(400).optional(),
  battleA: z
    .object({
      model: z.enum(MODEL_IDS),
      output: z.string(),
      latencyMs: z.number().min(0),
      tokens: z.object({ input: z.number(), output: z.number() }),
    })
    .optional(),
  battleB: z
    .object({
      model: z.enum(MODEL_IDS),
      output: z.string(),
      latencyMs: z.number().min(0),
      tokens: z.object({ input: z.number(), output: z.number() }),
    })
    .optional(),
  battleWinner: z.enum(["a", "b"]).optional(),
  verification: z.object({
    method: z.enum(["rules", "second_model"]),
    passed: z.boolean(),
    issues: z.array(z.string().max(300)).default([]),
    checkedBy: z.string().max(60),
  }),
  selfAudit: z.object({
    riskScore: z.number().min(0).max(1),
    issues: z.array(z.string().max(300)).max(8),
    checks: z.array(z.string().max(180)).max(6),
    checkedBy: z.string().max(80),
  }).optional(),
  editQuality: z.object({
    passed: z.boolean(),
    improved: z.boolean(),
    issues: z.array(z.string().max(300)).max(12),
    checkedBy: z.string().max(60),
  }).optional(),
  failureForecast: z.object({
    probability: z.number().min(0).max(1),
    reason: z.string().max(500),
    basedOnSamples: z.number().int().min(0),
  }).optional(),
  certificate: z.object({
    version: z.literal(1),
    sessionId: z.string(),
    taskId: z.string(),
    model: z.enum(MODEL_IDS),
    outputHash: z.string().length(64),
    verification: z.object({ method: z.enum(["rules", "second_model"]), passed: z.boolean(), issues: z.array(z.string()), checkedBy: z.string() }),
    confidence: z.number().min(0).max(1),
    status: z.enum(["pending", "running", "verified", "flagged", "failed", "escalated"]),
    humanApproved: z.boolean(),
    issuedAt: z.string(),
    certificateHash: z.string().length(64),
  }).optional(),
  status: z.enum([
    "pending",
    "running",
    "verified",
    "flagged",
    "failed",
    "escalated",
  ]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(800).default(""),
  alternatives: z.array(z.string().max(120)).max(4).default([]),
  latencyMs: z.number().min(0),
  tokens: z.object({ input: z.number(), output: z.number() }).default({ input: 0, output: 0 }),
  // Real file operations applied to the generated-project workspace (may be empty
  // for design-only outputs). Distinguishes SOURCE changes from the legacy design
  // artifact in `code`.
  fileOps: z
    .array(
      z.object({
        path: z.string().max(200),
        operation: z.enum(["create", "update", "delete"]),
        rejected: z.boolean().default(false),
        reason: z.string().max(300).optional(),
      })
    )
    .max(20)
    .optional(),
  /** The model actually served by failover (differs from `model` when fallback fired). */
  servedBy: z.string().max(120).optional(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

import type { InjectionFinding } from "../lib/security/injection";

// ---------- Session state (the whole gated pipeline) ----------
export type GateId =
  | "intake"
  | "suitability"
  | "platform"
  | "flaws"
  | "stack"
  | "tasks"
  | "algorithms"
  | "models"
  | "execution"
  | "review";

export type GateStatus = "pending" | "running" | "awaiting_user" | "cleared" | "failed";

export type PipelineSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  input: string;
  statedStack: string;
  policy: RoutingPolicy;
  uploads: { name: string; chars: number }[];
  gate: GateId; // current gate
  gateStatus: GateStatus;
  targetPlatform?: TargetPlatform;
  error?: string;
  suitability: Suitability | null;
  suggestedWorkflow: Workflow | null;
  workflow: Workflow | null; // final workflow (user-approved)
  flawReport: FlawReport | null;
  flawConsensus?: FlawConsensus | null;
  flawResolutions: FlawResolution[];
  stackGate: StackGate | null;
  algorithms: AlgorithmPlan | null;
  routing: RoutingPlan | null;
  /** Explicit Models-stage state (Part 1): execution is gated on this, not on routing
   *  merely existing. False until the last tie-break resolves or the human finalizes.
   *  Optional so sessions created before this field remain valid. */
  modelsFinalized?: boolean;
  trustBudget?: { initial: number; remaining: number; consumed: number; status: "active" | "exhausted" };
  /** Derived DNA, optional so sessions created before F19 remain valid. */
  taskFingerprints?: Record<string, TaskFingerprint>;
  /** F40 prompt-injection scan of the untrusted intake text (audit evidence). */
  inputSecurity?: {
    risk: number;
    findings: InjectionFinding[];
    neutralized: boolean;
    scannedAt: string;
  };
  executions: ExecutionResult[];
  /** Generated-project source files (real code artifacts written by execution).
   *  Optional for backward compatibility with sessions created before this field. */
  workspaceFiles?: WorkspaceFile_[];
  humanFeedback: {
    ratings: Record<string, { accepted: boolean; rating?: number; note?: string }>;
  };
};

/** Mirror of services/workspace.ts WorkspaceFile — defined here so the session type
 *  stays self-contained for the repositories. */
export type WorkspaceFile_ = {
  path: string;
  content: string;
  original: string;
  taskId: string;
  model: string;
  updatedAt: string;
  version: number;
};

// ---------- Universal decision rule (F8) ----------
export type PipelineStageId =
  | "understanding"
  | "suitability"
  | "flaws"
  | "stack"
  | "algorithms"
  | "routing";

export const TIE_GAP = 0.12; // top-two confidence gap below which it's a "genuine tie"
export const AUTO_FLOOR = 0.72; // below this, never auto-decide

function configuredThreshold(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

export function decisionThresholds(): { tieGap: number; autoFloor: number } {
  return {
    tieGap: configuredThreshold("VERYA_TIE_GAP", TIE_GAP),
    autoFloor: configuredThreshold("VERYA_AUTO_FLOOR", AUTO_FLOOR),
  };
}

export function needsTieBreak(options: { confidence: number }[]): boolean {
  if (options.length === 0) return true;
  const sorted = [...options].sort((a, b) => b.confidence - a.confidence);
  const { tieGap, autoFloor } = decisionThresholds();
  if (sorted[0].confidence < autoFloor) return true;
  if (sorted.length > 1 && sorted[0].confidence - sorted[1].confidence < tieGap) return true;
  return false;
}

// ---------- Session validation for API ----------
export const StartRequestSchema = z.object({
  input: z.string().min(20).max(20000),
  statedStack: z.string().max(2000).default(""),
  policy: z.enum(["lowest_cost", "highest_accuracy", "balanced", "org_approved"]).default("balanced"),
});
export const GateActionSchema = z.discriminatedUnion("action", [
  // Human recovery for a failed AI gate (e.g. all providers errored): clears the
  // error and re-enters processing. Available on any failed gate.
  z.object({
    action: z.literal("retry_gate"),
  }),
  z.object({
    action: z.literal("suitability_choose"),
    choice: z.enum(["original", "suggested"]),
  }),
  z.object({
    action: z.literal("platform_choose"),
    targetPlatform: TargetPlatformSchema,
  }),
  z.object({
    action: z.literal("flaw_resolve"),
    resolutions: z
      .array(
        z.object({
          flawId: z.string(),
          decision: z.enum(["accepted", "rejected", "edited"]),
          editedFix: z.string().max(700).optional(),
        })
      )
      .min(0),
  }),
  z.object({
    action: z.literal("stack_choose"),
    choice: z.string().min(1),
  }),
  z.object({
    action: z.literal("tasks_edit"),
    tasks: z.array(TaskSchema).min(1).max(40),
  }),
  z.object({
    action: z.literal("algorithm_choose"),
    taskId: z.string().min(1),
    choice: z.string().min(1),
  }),
  z.object({
    action: z.literal("model_choose"),
    taskId: z.string().min(1),
    choice: z.enum(MODEL_IDS),
  }),
  z.object({
    action: z.literal("run_execution"),
  }),
  // Part 1/2: explicit human finalization of the Models stage — the handoff into
  // the coding workspace. Refuses when tie-breaks remain (409 with the count).
  z.object({
    action: z.literal("finalize_models"),
  }),
  z.object({
    action: z.literal("trust_budget_approve"),
    amount: z.number().min(1).max(1000),
  }),
  // Re-run one failed task through the existing execution architecture.
  z.object({
    action: z.literal("retry_task"),
    taskId: z.string().min(1),
  }),
  z.object({
    action: z.literal("feedback"),
    taskId: z.string().min(1),
    accepted: z.boolean(),
    rating: z.number().min(1).max(5).optional(),
    note: z.string().max(400).optional(),
    editedOutput: z.string().max(60000).optional(),
  }),
  z.object({
    action: z.literal("code_edit"),
    taskId: z.string().min(1),
    code: z.string().max(60000),
    expectedVersion: z.number().int().min(1),
  }),
  z.object({
    action: z.literal("battle_run"),
    taskId: z.string().min(1),
    modelA: z.enum(MODEL_IDS),
    modelB: z.enum(MODEL_IDS),
  }),
  z.object({
    action: z.literal("battle_pick"),
    taskId: z.string().min(1),
    winner: z.enum(["a", "b"]),
  }),
]);
export type GateAction = z.infer<typeof GateActionSchema>;
