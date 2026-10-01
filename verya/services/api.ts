// Typed API client — the ONLY place the frontend talks to the backend.
// Base URL: Next.js rewrites proxy /api/* to the Fastify backend in dev;
// in production set NEXT_PUBLIC_API_URL to the backend origin directly.
// When Clerk is active, the auth bridge supplies a Bearer token per request (F38).
import { getAuthToken } from "@/lib/auth-bridge";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly issues?: string[]
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const BASE = process.env.NEXT_PUBLIC_API_URL || "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      // Only declare a JSON content-type when there IS a body — Fastify rejects
      // application/json with an empty body (FST_ERR_CTP_EMPTY_JSON_BODY).
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.trim() || `Request failed (${res.status})` };
    }
  }
  if (!res.ok) {
    const err = body as { error?: string; issues?: string[] };
    const message =
      res.status === 500 && err.error === "Internal Server Error"
        ? "The Verya backend is unavailable. Start it with `npm run dev` from the backend folder."
        : err.error ?? `Request failed (${res.status})`;
    throw new ApiError(message, res.status, err.issues);
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean; auth: string }>("/health"),

  startPipeline: (payload: { input: string; statedStack: string; policy: string }) =>
    request<{ session: unknown }>("/api/pipeline", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // F1.3: file upload intake — server-side extraction (pdf/docx/text), optionally
  // combined with a typed description.
  uploadPipeline: (file: File, opts?: { description?: string; statedStack?: string }) => {
    const fd = new FormData();
    fd.append("file", file);
    if (opts?.description) fd.append("description", opts.description);
    if (opts?.statedStack) fd.append("statedStack", opts.statedStack);
    return fetch(`${BASE}/api/pipeline/upload`, { method: "POST", body: fd })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { error?: string; session?: unknown };
        if (!res.ok) throw new ApiError(body.error ?? `Upload failed (${res.status})`, res.status);
        return body as { session: unknown };
      });
  },

  getPipeline: (id: string) => request<{ session: unknown }>(`/api/pipeline/${id}`),

  act: (id: string, action: unknown) =>
    request<{ session: unknown }>(`/api/pipeline/${id}/action`, {
      method: "POST",
      body: JSON.stringify(action),
    }),

  execute: (id: string) =>
    request<{ session: unknown }>(`/api/pipeline/${id}/execute`, { method: "POST" }),

  // On-demand preview entry generation for sessions that lack an index.html
  // (executed before the guarantee, or whose generation failed).
  generatePreviewEntry: (id: string) =>
    request<{ ok: boolean; generated: boolean; reason?: string; session?: unknown }>(
      `/api/pipeline/${id}/preview-entry`,
      { method: "POST" }
    ),

  // Human edit of a REAL generated workspace file — works at any stage (the
  // editor is always writable), versioned for CAS and audited in the ledger.
  editWorkspaceFile: (id: string, payload: { path: string; content: string; expectedVersion: number }) =>
    request<{ ok: boolean; version: number }>(`/api/pipeline/${id}/files/edit`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  dashboard: () => request<Record<string, unknown>>("/api/dashboard"),

  verifyLedger: () => request<{ valid: boolean; checked: number }>("/api/ledger/verify"),

  ledgerRecords: (sessionId?: string) =>
    request<{ records: Array<Record<string, unknown>> }>(
      `/api/ledger/records${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`
    ),

  createLead: (lead: { name: string; email: string; phone?: string; acceptTerms: true; source?: string }) =>
    request<{ ok: boolean; message: string }>("/api/leads", {
      method: "POST",
      body: JSON.stringify(lead),
    }),

  memorySearch: (query: string, category?: string) =>
    request<{ results: Array<Record<string, unknown>> }>(
      `/api/memory/search?q=${encodeURIComponent(query)}${category ? `&category=${encodeURIComponent(category)}` : ""}`
    ),

  reputation: () =>
    request<{
      entries: Array<{
        model: string;
        taskCategory: string;
        trustScore: number;
        samples: number;
        trend: "up" | "flat" | "down";
      }>;
    }>("/api/reputation"),

  explain: (payload: { question: string; sessionId?: string }) =>
    request<{ answer: string; recordsUsed: number }>("/api/explain", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  recordAuthEvent: (payload: {
    eventType: "sign_in" | "sign_out" | "permission_changed";
    previousRole?: string;
    nextRole?: string;
    detail?: Record<string, unknown>;
  }) =>
    request<{ ok: boolean; seq: number }>("/api/auth/events", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  policySuggestions: () => request<{ suggestions: Array<Record<string, unknown>> }>("/api/policies/suggestions"),

  detectPolicySuggestions: () => request<{ suggestions: Array<Record<string, unknown>> }>("/api/policies/suggestions/detect", { method: "POST" }),

  decidePolicySuggestion: (id: number, decision: "approved" | "rejected") =>
    request<{ suggestion: Record<string, unknown> }>(`/api/policies/suggestions/${id}/${decision}`, { method: "POST" }),

  constitution: () => request<{ generatedAt: string; text: string }>("/api/policies/constitution"),

  certificate: (sessionId: string, taskId: string) => request<{ certificate: Record<string, unknown>; valid: boolean }>(`/api/certificates/${encodeURIComponent(sessionId)}/${encodeURIComponent(taskId)}`),

  // F23 Phase 4: Delegated Authority
  listDelegations: (agentId?: string, status?: string) => {
    const params = new URLSearchParams();
    if (agentId) params.set("agentId", agentId);
    if (status) params.set("status", status);
    const qs = params.toString();
    return request<{ delegations: Array<Record<string, unknown>> }>(`/api/delegations${qs ? `?${qs}` : ""}`);
  },

  createDelegation: (payload: {
    agentId: string;
    purpose: string;
    allowedActions: string[];
    allowedTools: string[];
    maximumRisk: string;
    dataScope: string;
    canDelegate: boolean;
    expiresAt: string;
    parentDelegationId?: string;
  }) =>
    request<{ delegation: Record<string, unknown> }>("/api/delegations", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  suspendDelegation: (id: string) =>
    request<{ delegation: Record<string, unknown> }>(`/api/delegations/${encodeURIComponent(id)}/suspend`, { method: "POST" }),

  revokeDelegation: (id: string) =>
    request<{ delegation: Record<string, unknown> }>(`/api/delegations/${encodeURIComponent(id)}/revoke`, { method: "POST" }),

  reactivateDelegation: (id: string) =>
    request<{ delegation: Record<string, unknown> }>(`/api/delegations/${encodeURIComponent(id)}/reactivate`, { method: "POST" }),

  evaluateAuthorization: (payload: {
    agentId: string;
    action: string;
    tool: string;
    resource: string;
    risk?: string;
    dataScope?: string;
    environment?: string;
    amount?: number;
  }) =>
    request<{ evaluation: Record<string, unknown> }>("/api/authorization/evaluate", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
