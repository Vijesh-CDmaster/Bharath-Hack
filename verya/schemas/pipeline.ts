import { z } from "zod";

/**
 * Shared frontend schemas — mirror the backend's contract.
 * The authoritative definitions live in backend/src/schemas/pipeline.ts;
 * these power React Hook Form + client-side validation without importing server code.
 */

export const RoutingPolicySchema = z.enum(["lowest_cost", "highest_accuracy", "balanced", "org_approved"]);
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

export const StartRequestSchema = z.object({
  input: z.string().min(20, "Describe your project in at least 20 characters").max(20000),
  statedStack: z.string().max(2000).default(""),
  policy: RoutingPolicySchema.default("balanced"),
});
export type StartRequest = z.infer<typeof StartRequestSchema>;

export const IntakeFormSchema = z.object({
  input: StartRequestSchema.shape.input,
  hasStack: z.boolean(),
  statedStack: z.string().max(2000),
  policy: RoutingPolicySchema,
});
export type IntakeFormValues = z.infer<typeof IntakeFormSchema>;

// ---- Session shape (subset the UI renders; backend remains authoritative) ----
export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const GateIdSchema = z.enum([
  "intake",
  "suitability",
  "platform",
  "flaws",
  "stack",
  "tasks",
  "algorithms",
  "models",
  "execution",
  "review",
]);
export type GateId = z.infer<typeof GateIdSchema>;
export const TargetPlatformSchema = z.enum(["web", "android", "ios", "both"]);
export type TargetPlatform = z.infer<typeof TargetPlatformSchema>;

export const GateStatusSchema = z.enum(["pending", "running", "awaiting_user", "cleared", "failed"]);
export type GateStatus = z.infer<typeof GateStatusSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  input: z.string(),
  statedStack: z.string(),
  policy: RoutingPolicySchema,
  uploads: z.array(z.object({ name: z.string(), chars: z.number() })).default([]),
  gate: GateIdSchema,
  gateStatus: GateStatusSchema,
  error: z.string().optional(),
  suitability: z
    .object({
      suitable: z.boolean(),
      verdict: z.enum(["suitable", "workable", "unsuitable"]).optional(),
      confidence: z.number(),
      reason: z.string(),
      suggestedWorkflow: z.string().nullish(),
      suggestedSummary: z.string().nullish(),
    })
    .nullish(),
  suggestedWorkflow: z.unknown().nullish(),
  workflow: z
    .object({
      title: z.string(),
      summary: z.string(),
      tasks: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          description: z.string().default(""),
          category: z.string(),
          dependsOn: z.array(z.string()).default([]),
          complexity: z.enum(["low", "medium", "high"]).default("medium"),
          risk: z.enum(["low", "medium", "high"]).default("medium"),
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
        })
      ),
    })
    .nullish(),
  taskFingerprints: z.record(z.string(), z.object({
    version: z.literal(1),
    complexity: z.enum(["low", "medium", "high"]),
    domain: z.string(),
    risk: z.enum(["low", "medium", "high"]),
    contextSize: z.enum(["small", "medium", "large"]),
    outputFormat: z.enum(["text", "structured-data", "code", "analysis"]),
    reasoningRequirement: z.enum(["direct", "standard", "evaluative", "deep"]),
    requiredCapabilities: z.array(z.string()),
    signature: z.string().length(16),
  })).optional(),
  flawReport: z
    .object({
      summary: z.string(),
      overallRisk: SeveritySchema,
      flaws: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          category: z.string(),
          severity: SeveritySchema,
          description: z.string(),
          suggestedFix: z.string(),
          relatedTaskIds: z.array(z.string()).default([]),
        })
      ),
    })
    .nullish(),
  flawConsensus: z
    .object({
      opinions: z.array(
        z.object({
          provider: z.enum(["gemini", "groq", "mistral"]),
          status: z.enum(["completed", "failed"]),
          report: z.unknown().optional(),
          error: z.string().optional(),
        })
      ),
      issues: z.array(
        z.object({
          key: z.string(),
          title: z.string(),
          category: z.string(),
          severity: SeveritySchema,
          description: z.string(),
          suggestedFix: z.string(),
          relatedTaskIds: z.array(z.string()),
          votes: z.object({ gemini: z.boolean(), groq: z.boolean(), mistral: z.boolean() }),
          agreement: z.number(),
          confidence: z.enum(["high", "medium", "low"]),
        })
      ),
      completedProviders: z.number(),
      consensusSummary: z.string(),
    })
    .nullish(),
  flawResolutions: z
    .array(z.object({ flawId: z.string(), decision: z.enum(["accepted", "rejected", "edited"]), editedFix: z.string().optional() }))
    .default([]),
  stackGate: z.unknown().nullish(),
  algorithms: z.unknown().nullish(),
  routing: z.unknown().nullish(),
  /** Explicit Models-stage finalization (backend Part 1). Run is gated on this. */
  modelsFinalized: z.boolean().optional(),
  trustBudget: z.object({
    initial: z.number(),
    remaining: z.number(),
    consumed: z.number(),
    status: z.enum(["active", "exhausted"]),
  }).optional(),
  executions: z
    .array(
      z.object({
        taskId: z.string(),
        code: z
          .object({
            language: z.string(),
            fileName: z.string(),
            original: z.string(),
            current: z.string(),
            version: z.number(),
            updatedAt: z.string(),
          })
          .optional(),
        model: z.string(),
        output: z.string(),
        humanRating: z.number().min(1).max(5).optional(),
        humanNote: z.string().max(400).optional(),
        battleA: z
          .object({
            model: z.string(),
            output: z.string(),
            latencyMs: z.number(),
            tokens: z.object({ input: z.number(), output: z.number() }),
          })
          .optional(),
        battleB: z
          .object({
            model: z.string(),
            output: z.string(),
            latencyMs: z.number(),
            tokens: z.object({ input: z.number(), output: z.number() }),
          })
          .optional(),
        battleWinner: z.enum(["a", "b"]).optional(),
        verification: z.object({
          method: z.string(),
          passed: z.boolean(),
          issues: z.array(z.string()).default([]),
          checkedBy: z.string(),
        }),
        selfAudit: z.object({
          riskScore: z.number().min(0).max(1),
          issues: z.array(z.string()).default([]),
          checks: z.array(z.string()).default([]),
          checkedBy: z.string(),
        }).optional(),
        status: z.enum(["pending", "running", "verified", "flagged", "failed", "escalated"]),
        confidence: z.number(),
        latencyMs: z.number(),
        tokens: z.object({ input: z.number(), output: z.number() }),
        /** Structured file operations applied to the generated workspace (Part 5/18). */
        fileOps: z
          .array(
            z.object({
              path: z.string(),
              operation: z.enum(["create", "update", "delete"]),
              rejected: z.boolean().default(false),
              reason: z.string().optional(),
            })
          )
          .optional(),
        /** The model that ACTUALLY served the task (differs from `model` on failover). */
        servedBy: z.string().optional(),
      })
    )
    .default([]),
  /** Generated-project source files (real code execution wrote). Optional for
   *  backward compatibility with pre-workspace sessions. */
  workspaceFiles: z
    .array(
      z.object({
        path: z.string(),
        content: z.string(),
        original: z.string(),
        taskId: z.string(),
        model: z.string(),
        updatedAt: z.string(),
        version: z.number(),
      })
    )
    .optional(),
  targetPlatform: TargetPlatformSchema.optional(),
  humanFeedback: z.object({ ratings: z.record(z.string(), z.unknown()) }).default({ ratings: {} }),
});
export type Session = z.infer<typeof SessionSchema>;
