"use client";

// VS Code "Simple Browser"-style preview: renders the generated project's HTML
// (with workspace CSS/JS inlined, relative imports resolved) inside a sandboxed
// iframe. The sandbox has scripts but NOT same-origin — the preview can never
// touch the app's cookies, storage, or DOM. Includes desktop/mobile viewport
// toggle, entry-page switcher (multi-page apps), "open in new tab" export,
// manual reload, and auto-reload while the agent writes new code.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { WsBuild } from "@/lib/workspace/build";
import { buildPreviewHtml, previewPages } from "@/lib/workspace/preview";
import { api, ApiError } from "@/services/api";

type Device = "desktop" | "mobile";

export function PreviewPane({ ws, sessionId, onClose }: { ws: WsBuild; sessionId: string; onClose: () => void }) {
  const [device, setDevice] = useState<Device>("desktop");
  const [reloadKey, setReloadKey] = useState(0);
  const [entryOverride, setEntryOverride] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const qc = useQueryClient();

  const pages = useMemo(() => previewPages(ws), [ws]);
  const preview = useMemo(
    () => buildPreviewHtml(ws, entryOverride ?? undefined),
    [ws, entryOverride]
  );

  // Workspace content fingerprint: changes when the agent edits files.
  const filesStamp = useMemo(
    () => ws.files.reduce((acc, f) => acc + (f.content?.length ?? 0) + f.path.length * 7, ws.files.length),
    [ws.files]
  );
  const [seenStamp, setSeenStamp] = useState<number | null>(null);
  const stale = seenStamp !== null && seenStamp !== filesStamp;

  // Auto-refresh when workspace content changes while previewing.
  useEffect(() => {
    if (seenStamp === null) {
      setSeenStamp(filesStamp);
    } else if (seenStamp !== filesStamp) {
      setSeenStamp(filesStamp);
      setReloadKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesStamp]);

  // Virtual navigation messages from the sandboxed page (relative link clicks).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { __veryaPreview?: string; page?: string } | null;
      if (!d || typeof d !== "object" || !d.__veryaPreview) return;
      if (d.__veryaPreview === "navigate" && d.page) {
        setEntryOverride(d.page);
        setReloadKey((k) => k + 1);
      } else if (d.__veryaPreview === "loaded") {
        setLoaded(true);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // Reset loaded flag whenever we rebuild; hard-timeout so the loading overlay
  // can NEVER cover the frame (e.g. documents that block scripts).
  useEffect(() => {
    setLoaded(false);
    const t = setTimeout(() => setLoaded(true), 1200);
    return () => clearTimeout(t);
  }, [preview.html, reloadKey]);

  // Always preview the FRESHEST server state: the session query may hold a stale
  // snapshot (e.g. after an agent/backfill writes new files while this pane was
  // closed and the session was not in its 800ms running-poll window).
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ["session", sessionId] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const openExternal = useCallback(() => {
    const blob = new Blob([preview.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, [preview.html]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const width = device === "mobile" ? 390 : 0;

  // Backfill: ask the agent to generate the missing preview entry page.
  const generateEntry = useCallback(async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      await api.generatePreviewEntry(sessionId);
      await qc.invalidateQueries({ queryKey: ["session", sessionId] });
      setReloadKey((k) => k + 1);
    } catch (err) {
      setGenerateError(err instanceof ApiError ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }, [sessionId, qc]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1e1e1e] select-none">
      {/* Toolbar */}
      <div className="flex h-[35px] shrink-0 items-center gap-2 border-b border-[#2d2d2d] bg-[#181818] px-2 text-[11px]">
        <span className="flex h-4 w-4 items-center justify-center rounded-sm bg-[#007acc] text-[8px] font-bold text-white">V</span>
        <span className="font-medium text-[#cccccc]">Preview</span>

        {/* Entry page switcher (multi-page apps) */}
        {pages.length > 0 && (
          <select
            value={preview.entry ?? ""}
            onChange={(e) => {
              setEntryOverride(e.target.value);
              setReloadKey((k) => k + 1);
            }}
            className="h-[22px] max-w-[220px] rounded border border-[#3c3c3c] bg-[#1e1e1e] px-1.5 font-mono text-[10px] text-[#cccccc] outline-none focus:border-[#007acc] cursor-pointer"
            title="Preview entry page"
          >
            {pages.map((p) => (
              <option key={p} value={p}>
                {p.replace(/^project\//, "")}
              </option>
            ))}
          </select>
        )}
        {pages.length === 0 && (
          <span className="max-w-[240px] truncate font-mono text-[10px] text-[#858585]">
            project inventory (no HTML entry)
          </span>
        )}
        {preview.inlined > 0 && (
          <span className="rounded bg-[#252526] px-1.5 py-0.5 text-[10px] text-[#858585]">
            {preview.inlined} asset{preview.inlined === 1 ? "" : "s"} inlined
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {/* Device toggle */}
          <div className="flex overflow-hidden rounded border border-[#3c3c3c]">
            <button
              type="button"
              onClick={() => setDevice("desktop")}
              className={`flex items-center gap-1 px-2 py-[3px] text-[10px] ${device === "desktop" ? "bg-[#04395e] text-white" : "bg-transparent text-[#858585] hover:bg-[#2a2d2e] hover:text-[#cccccc]"}`}
              title="Desktop viewport"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="2" y="4" width="20" height="13" rx="2" />
                <path d="M8 21h8m-4-4v4" />
              </svg>
              Desktop
            </button>
            <button
              type="button"
              onClick={() => setDevice("mobile")}
              className={`flex items-center gap-1 px-2 py-[3px] text-[10px] ${device === "mobile" ? "bg-[#04395e] text-white" : "bg-transparent text-[#858585] hover:bg-[#2a2d2e] hover:text-[#cccccc]"}`}
              title="Mobile viewport (390px)"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="7" y="2" width="10" height="20" rx="2" />
                <path d="M11 18h2" />
              </svg>
              Mobile
            </button>
          </div>

          <button
            type="button"
            onClick={reload}
            className="rounded p-1 text-[#858585] hover:bg-[#2a2d2e] hover:text-white"
            title="Reload preview (rebuilds from current workspace files)"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 9A8 8 0 005.6 5.6L4 9m16 6l-1.6 3.4A8 8 0 014 15" />
            </svg>
          </button>
          <button
            type="button"
            onClick={openExternal}
            className="rounded p-1 text-[#858585] hover:bg-[#2a2d2e] hover:text-white"
            title="Open preview in a new browser tab"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[#858585] hover:bg-[#383838] hover:text-white"
            title="Close preview (Ctrl+Shift+V)"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Sandboxed frame */}
      <div className="relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-[#141414]">
        {!loaded && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#141414]">
            <div className="flex items-center gap-2 text-[12px] text-[#858585]">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[#007acc]" />
              Rendering preview…
            </div>
          </div>
        )}
        <iframe
          key={reloadKey}
          title="Project preview"
          srcDoc={preview.html}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          className="h-full border-0 bg-white"
          style={width ? { width, maxWidth: "100%" } : { width: "100%" }}
        />

        {/* No HTML entry: offer agent-backed backfill instead of a dead end. */}
        {pages.length === 0 && ws.files.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
            <div className="pointer-events-auto flex flex-col items-center gap-1.5 rounded-lg border border-[#3c3c3c] bg-[#252526]/95 px-4 py-3 shadow-2xl">
              <button
                type="button"
                disabled={generating}
                onClick={() => void generateEntry()}
                className="flex h-[28px] items-center gap-2 rounded bg-[#007acc] px-3 text-[12px] font-medium text-white hover:bg-[#0062a3] disabled:opacity-40 cursor-pointer"
              >
                {generating ? (
                  <>
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                    The agent is designing the app screen…
                  </>
                ) : (
                  <>
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                    </svg>
                    Generate app preview with the agent
                  </>
                )}
              </button>
              <p className="max-w-[360px] text-center text-[10px] leading-snug text-[#858585]">
                {generateError ?? "This project has no HTML entry — the agent will design one from the delivered files."}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
