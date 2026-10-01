// Pipeline REST routes — the gated pipeline over the Fastify API.
import type { FastifyInstance } from "fastify";
import type { VeryaRequest } from "../app";
import { StartRequestSchema, GateActionSchema } from "../schemas/pipeline";
import { startPipeline, getPipeline, listPipelines, actOnPipeline } from "../services/pipeline";
import { recordToLedger } from "../services/ledger";
import { startExecution } from "../services/execution";
import { ensurePreviewEntry } from "../services/scaffold";
import { saveSession } from "../repositories/sessions";
import { sanitizeInput, rateLimitKey } from "../lib/middleware";
import { describeScan, scanInjection } from "../lib/security/injection";

export default async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  // Start a new pipeline session (runs the suitability gate).
  app.post("/pipeline", async (req, reply) => {
    const parsed = StartRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(422).send({
        error: "Validation failed",
        issues: parsed.error.issues.map((i) => i.message),
      });
    }
    const session = await startPipeline({
      orgId: req.auth.orgId,
      input: sanitizeInput(parsed.data.input),
      statedStack: sanitizeInput(parsed.data.statedStack ?? ""),
      policy: parsed.data.policy,
    });
    return { session };
  });

  // Fetch one session.
  app.get("/pipeline/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await getPipeline(req.auth.orgId, id);
    if (!session) return reply.status(404).send({ error: "Session not found" });
    return { session };
  });

  // List sessions (workflow history, F22).
  app.get("/pipeline", async (req: VeryaRequest) => {
    return { sessions: await listPipelines(req.auth.orgId, 50) };
  });

  // Apply a gate action (accept workflow, resolve flaws, pick stack/algorithm/model...).
  app.post("/pipeline/:id/action", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = GateActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(422).send({
        error: "Validation failed",
        issues: parsed.error.issues.map((i) => i.message),
      });
    }
    const session = await actOnPipeline(req.auth.orgId, id, parsed.data);
    return { session };
  });

  // Start execution without blocking: responds immediately with
  // gateStatus="running"; the loop runs in background (or via BullMQ worker when
  // Redis is configured) and the UI polls until review is ready.
  app.post("/pipeline/:id/execute", async (req) => {
    const { id } = req.params as { id: string };
    return startExecution(req.auth.orgId, id);
  });

  // On-demand preview entry generation: for sessions executed before the
  // guarantee existed (or whose entry generation failed), this backfills the
  // missing index.html so the workspace Preview can render the app.
  app.post("/pipeline/:id/preview-entry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await getPipeline(req.auth.orgId, id);
    if (!session) return reply.status(404).send({ error: "Session not found" });
    if ((session.workspaceFiles ?? []).length === 0) {
      return reply.status(409).send({ error: "Nothing generated yet — run the pipeline first." });
    }
    if ((session.workspaceFiles ?? []).some((f) => f.path.toLowerCase().endsWith(".html"))) {
      return reply.send({ ok: true, generated: false, reason: "A preview entry already exists." });
    }
    await ensurePreviewEntry(req.auth.orgId, session);
    await saveSession(req.auth.orgId, session);
    const generated = (session.workspaceFiles ?? []).some((f) => f.path.toLowerCase().endsWith(".html"));
    return reply.send({ ok: true, generated, session });
  });

  // File upload intake (F1.3): text-like files appended into the project input.
  // File upload intake (F1.3): server-side text extraction for text formats, PDF,
  // and DOCX. Extraction failures are reported clearly — never a silent empty analysis.
  app.post("/pipeline/upload", async (req, reply) => {
    const rl = rateLimitKey(`upload:${req.ip}`, 10, 60_000);
    if (!rl.ok) return reply.status(429).send({ error: "Rate limit exceeded." });

    const data = await (req as unknown as { file: () => Promise<UploadedFile | undefined> }).file?.();
    if (!data) return reply.status(400).send({ error: "multipart/form-data with a file field required" });

    const allowed = /\.(txt|md|csv|json|ya?ml|log|pdf|docx?|rtf)$/i;
    if (!allowed.test(data.filename)) {
      return reply
        .status(415)
        .send({ error: "Supported formats: txt, md, csv, json, yaml, log, pdf, doc, docx, rtf." });
    }
    const buf = await data.toBuffer();
    if (buf.length > 10 * 1024 * 1024) {
      return reply.status(413).send({ error: "File exceeds the 10MB limit." });
    }

    let text: string;
    try {
      text = await extractText(buf, data.filename);
    } catch (err) {
      req.log.warn({ err, filename: data.filename }, "extraction failed");
      return reply.status(422).send({
        error: `Could not extract text from "${data.filename}". If it is a scanned PDF it may contain no selectable text — try pasting the content directly.`,
      });
    }
    const trimmed = text.trim();
    if (trimmed.length < 20) {
      return reply.status(422).send({
        error: `"${data.filename}" contained no usable text (scanned documents are not supported yet). Please paste your description instead.`,
      });
    }

    // Optional typed description accompanies the document (F1: one input, many forms).
    const description = sanitizeInput((data.fields?.description as string) ?? "").slice(0, 20000);
    const combined = description
      ? `${description}\n\n--- ATTACHED DOCUMENT: ${data.filename} ---\n${trimmed.slice(0, 100000)}`
      : trimmed;
    // F40: uploaded documents are external, untrusted content — validate them before
    // they are passed to any model, and record the verdict in the ledger.
    const externalScan = scanInjection(trimmed);
    const session = await startPipeline({
      orgId: req.auth.orgId,
      input: combined.slice(0, 20000),
      statedStack: sanitizeInput((data.fields?.statedStack as string) ?? ""),
      policy: "balanced",
    });
    await recordToLedger({
      orgId: req.auth.orgId,
      sessionId: session.id,
      gate: "intake",
      eventType: externalScan.findings.length > 0 ? "external_content_flagged" : "external_content_scanned",
      actor: "system",
      detail: {
        summary: `Intake via file upload: ${data.filename} (${buf.length} bytes, ${trimmed.length} chars extracted). ${describeScan(externalScan)}`,
        risk: externalScan.risk,
        findings: externalScan.findings.map((f) => ({ rule: f.rule, category: f.category, severity: f.severity })),
      },
    });
    return { session };
  });
}

/** Server-side text extraction per file type (F1.3). */
async function extractText(buf: Buffer, filename: string): Promise<string> {
  if (/\.pdf$/i.test(filename)) {
    const pdfParse = (await import("pdf-parse")).default;
    const doc = await pdfParse(buf);
    return doc.text;
  }
  if (/\.docx$/i.test(filename)) {
    const mammoth = await import("mammoth");
    const res = await mammoth.extractRawText({ buffer: buf });
    return res.value;
  }
  if (/\.doc$/i.test(filename)) {
    // Legacy binary .doc: best-effort UTF-16LE / latin1 salvage.
    const utf16 = buf.toString("utf16le").replace(/[^\x20-\x7E\n\r\t\u00A0-\u024F]/g, " ");
    if (utf16.replace(/\s/g, "").length > 200) return utf16;
    return buf.toString("latin1").replace(/[^\x20-\x7E\n\r\t]/g, " ");
  }
  if (/\.rtf$/i.test(filename)) {
    // Minimal RTF strip: remove control words and braces.
    return buf
      .toString("latin1")
      .replace(/\\'([0-9a-fA-F]{2})/g, " ")
      .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
      .replace(/[{}]/g, "")
      .replace(/\\/g, "");
  }
  return buf.toString("utf8");
}

type UploadedFile = {
  filename: string;
  toBuffer: () => Promise<Buffer>;
  fields?: Record<string, unknown>;
};
