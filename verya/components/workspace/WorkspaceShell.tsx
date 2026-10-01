"use client";

// VS Code IDE Structure:
// TITLE / MENU BAR (35px)
//   ↓
// ACTIVITY BAR (48px) | PRIMARY SIDEBAR (270px) | EDITOR (DOMINANT) | SECONDARY SIDEBAR (320px)
//                                     ↓
//                                 BOTTOM PANEL (200px)
//                                     ↓
//                                 STATUS BAR (22px)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { buildWorkspace, buildTree, languageOf } from "@/lib/workspace/build";
import type { WsBuild } from "@/lib/workspace/build";
import type { Session } from "@/schemas/pipeline";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGateAction, useExecute } from "@/hooks/use-session";
import { CodeEditor } from "./CodeEditor";
import { PreviewPane } from "./PreviewPane";
import { FileExplorer } from "./Sidebar";
import { AgentChat } from "./AgentChat";
import { BottomPanel } from "./BottomPanel";
import { TaskInspector } from "./TaskInspector";
import { ActivityBar } from "./ActivityBar";
import { StatusBar } from "./StatusBar";
import { Breadcrumbs } from "./Breadcrumbs";
import { CommandPalette } from "./CommandPalette";
import { api, ApiError } from "@/services/api";

export function WorkspaceShell({
  session,
  onReset,
  onBack,
}: {
  session: Session;
  onReset: () => void;
  onBack?: () => void;
}) {
  const ws = useMemo(() => buildWorkspace(session), [session]);
  const act = useGateAction(session.id);
  const execute = useExecute(session.id);
  const qc = useQueryClient();

  const openPaths = useWorkspaceStore((s) => s.openPaths);
  const activePath = useWorkspaceStore((s) => s.activePath);
  const buffers = useWorkspaceStore((s) => s.buffers);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const markSaved = useWorkspaceStore((s) => s.markSaved);
  const explorerOpen = useWorkspaceStore((s) => s.explorerOpen);
  const setExplorerOpen = useWorkspaceStore((s) => s.setExplorerOpen);
  const chatOpen = useWorkspaceStore((s) => s.chatOpen);
  const setChatOpen = useWorkspaceStore((s) => s.setChatOpen);
  const activeView = useWorkspaceStore((s) => s.activeView);
  const setActiveView = useWorkspaceStore((s) => s.setActiveView);
  const resetWs = useWorkspaceStore((s) => s.reset);
  const setCommandPaletteOpen = useWorkspaceStore((s) => s.setCommandPaletteOpen);
  const setQuickOpenOpen = useWorkspaceStore((s) => s.setQuickOpenOpen);
  const toggleBottom = useWorkspaceStore((s) => s.toggleBottom);
  const centerView = useWorkspaceStore((s) => s.centerView);
  const setCenterView = useWorkspaceStore((s) => s.setCenterView);
  const [saving, setSaving] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const menuBarRef = useRef<HTMLDivElement>(null);

  // Preview pane toggle (Ctrl+Shift+V): swaps the editor area for the project preview.
  const togglePreview = useCallback(() => {
    setCenterView(useWorkspaceStore.getState().centerView === "preview" ? "editor" : "preview");
  }, [setCenterView]);

  const projectTitle = ws.context.target.title || session.workflow?.title || "Project";
  const isRunning = ws.runState === "running" || session.gateStatus === "running";

  const performBack = useCallback(() => {
    if (onBack) {
      onBack();
    } else if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("view", "project");
      window.location.href = url.toString();
    }
  }, [onBack]);

  const handleBackClick = useCallback(() => {
    if (isRunning) {
      setShowLeaveConfirm(true);
    } else {
      performBack();
    }
  }, [isRunning, performBack]);

  // Auto-open first file
  useEffect(() => {
    const state = useWorkspaceStore.getState();
    if (ws.files.length > 0 && state.openPaths.length === 0) {
      const first = ws.files.find((f) => typeof f.content === "string") ?? ws.files[0];
      const loaded = fileContent(first.path);
      if (!loaded) return;
      openFile({
        path: first.path,
        content: loaded.content,
        language: loaded.language,
        artifact: loaded.artifact,
        readOnly: null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.files]);

  // Click outside to close menu dropdowns
  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, []);

  // Global keyboard shortcuts (Ctrl+B, Ctrl+J, Ctrl+P, Ctrl+Shift+P, Ctrl+W)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setCommandPaletteOpen(true);
      } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuickOpenOpen(true);
      } else if (ctrl && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setExplorerOpen(!useWorkspaceStore.getState().explorerOpen);
      } else if (ctrl && (e.key.toLowerCase() === "j" || e.key === "`")) {
        e.preventDefault();
        toggleBottom();
      } else if (ctrl && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const ap = useWorkspaceStore.getState().activePath;
        if (ap) closeTab(ap);
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setActiveView("search");
        setExplorerOpen(true);
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        setCenterView(useWorkspaceStore.getState().centerView === "preview" ? "editor" : "preview");
      } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        handleBackClick();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Auto-start: models finalized ⇒ the routed agent starts coding NOW ----
  // Fires once per session when the shell first sees an armed ("ready") state;
  // a failed dispatch re-arms so the user can fix the cause and press Run again.
  const autoStartArmed = useRef(true);
  const autoStartTried = useRef<string | null>(null);
  useEffect(() => {
    if (!autoStartArmed.current || ws.runState !== "ready") return;
    if (autoStartTried.current === session.id) return; // don't retry a failed dispatch in a render loop
    autoStartTried.current = session.id;
    autoStartArmed.current = false;
    useWorkspaceStore.getState().addMsg({
      role: "agent",
      text: `Models finalized — dispatching ${ws.tasks.length} task(s) to the routed models. Generated files will stream into the editor as they are written.`,
      steps: ws.tasks.slice(0, 4).map((t) => `${t.title} → ${t.model ?? "auto"}`),
      pending: true,
    });
    execute.mutateAsync().catch((err: unknown) => {
      autoStartArmed.current = true; // re-arm for a manual ▶ Run retry
      useWorkspaceStore.getState().addMsg({
        role: "agent",
        text: `Auto-start failed: ${err instanceof Error ? err.message : "unknown error"}. Press ▶ Run to retry.`,
        steps: [],
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.runState, session.id]);

  // When execution completes and the generated project has a UI (HTML entry),
  // surface the Preview pane automatically — the result is the point.
  const prevRunState = useRef(ws.runState);
  useEffect(() => {
    const was = prevRunState.current;
    prevRunState.current = ws.runState;
    if (was !== "completed" && ws.runState === "completed" && ws.files.some((f) => f.path.toLowerCase().endsWith(".html"))) {
      setCenterView("preview");
    }
  }, [ws.runState, ws.files, setCenterView]);

  // Build Log: stream agent activity into the Terminal tab while running.
  useEffect(() => {
    if (ws.runState !== "running") return;
    useWorkspaceStore.getState().setBottomTab("terminal");
    const store = useWorkspaceStore.getState();
    const done = new Set<string>();
    for (const t of ws.tasks) {
      if (t.status === "pending") continue;
      done.add(t.id);
      if (t.status === "running") {
        store.addMsg({ role: "agent", text: `▶ ${t.title} — executing on ${t.servedBy ?? t.model ?? "routed model"}` });
      } else if (t.status === "verified") {
        store.addMsg({ role: "agent", text: `✓ ${t.title} — verified` });
      } else if (t.status === "failed") {
        store.addMsg({ role: "agent", text: `✗ ${t.title} — failed${t.verification?.issues[0] ? `: ${t.verification.issues[0]}` : ""}` });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.runState]);

  const busy = act.isPending || execute.isPending || session.gateStatus === "running";

  const fileContent = useCallback((path: string) => {
    const file = ws.files.find((f) => f.path === path);
    if (!file) return null;
    if (typeof file.content === "string") {
      return {
        content: file.content,
        language: languageOf(path),
        artifact: { taskId: file.taskId ?? "", language: languageOf(path), version: file.version ?? 1 },
      };
    }
    if (!file.artifact) return null;
    const task = ws.tasks.find((t) => t.id === file.artifact!.taskId);
    const code = task?.execution?.output;
    if (code === undefined) return null;
    return { content: code, language: languageOf(path), artifact: file.artifact };
  }, [ws.files, ws.tasks]);

  const saveActive = async () => {
    if (!activePath) return;
    const buf = buffers[activePath];
    if (!buf?.dirty) return;
    setSaving(true);
    try {
      // Human edit rights: files that exist in the REAL workspace store save through
      // the versioned workspace endpoint (works at ANY stage — never blocked by a gate).
      // Legacy design artifacts keep the review-gate `code_edit` path.
      const wsFile = ws.files.find((f) => f.path === activePath && typeof f.content === "string");
      if (wsFile) {
        const res = await api.editWorkspaceFile(session.id, {
          path: activePath.replace(/^project\//, ""),
          content: buf.draft,
          expectedVersion: buf.artifact.version,
        });
        markSaved(activePath, res.version);
        void qc.invalidateQueries({ queryKey: ["session", session.id] });
      } else {
        const res = await api.act(session.id, {
          action: "code_edit",
          taskId: buf.artifact.taskId,
          code: buf.draft,
          expectedVersion: buf.artifact.version,
        });
        const s = res.session as Session;
        const exec = s.executions.find((e) => e.taskId === buf.artifact.taskId);
        markSaved(activePath, exec?.code?.version ?? buf.artifact.version + 1);
      }
    } catch (err) {
      const detail = err instanceof ApiError ? err.message : "Save failed";
      useWorkspaceStore.getState().addMsg({
        role: "agent",
        text: `Could not save ${activePath.replace("project/", "")}: ${detail}. Draft preserved.`,
        steps: [],
      });
    } finally {
      setSaving(false);
    }
  };

  const canExecute =
    session.gate === "execution" &&
    (session.gateStatus === "pending" || session.gateStatus === "failed" || session.gateStatus === "awaiting_user");

  const runDisabled = ws.runState === "waiting" || ws.runState === "running" || ws.runState === "completed" || busy;

  const runFeedback = (payload: { taskId: string; accepted: boolean; rating?: number; note?: string }) => {
    void act.mutateAsync({ action: "feedback", ...payload }).catch(() => undefined);
  };

  type MenuItem = { label: string; shortcut?: string; action?: () => void };

  // VS Code Menu hierarchy
  const MENUS: { name: string; items: MenuItem[] }[] = [
    {
      name: "File",
      items: [
        { label: "New Analysis...", action: () => { resetWs(); onReset(); } },
        { label: "Save", shortcut: "Ctrl+S", action: () => void saveActive() },
        { label: "Close Editor", shortcut: "Ctrl+W", action: () => { if (activePath) closeTab(activePath); } },
        { label: "Return to Project", shortcut: "Alt+Left", action: handleBackClick },
        { label: "Exit Workspace", action: handleBackClick },
      ],
    },
    {
      name: "Edit",
      items: [
        { label: "Find in File", shortcut: "Ctrl+F", action: () => { /* Find trigger */ } },
        { label: "Command Palette...", shortcut: "Ctrl+Shift+P", action: () => setCommandPaletteOpen(true) },
        { label: "Quick Open...", shortcut: "Ctrl+P", action: () => setQuickOpenOpen(true) },
      ],
    },
    {
      name: "Selection",
      items: [
        { label: "Select All", shortcut: "Ctrl+A", action: () => {} },
      ],
    },
    {
      name: "View",
      items: [
        { label: "Explorer", shortcut: "Ctrl+Shift+E", action: () => { setActiveView("explorer"); setExplorerOpen(true); } },
        { label: "Search", shortcut: "Ctrl+Shift+F", action: () => { setActiveView("search"); setExplorerOpen(true); } },
        { label: "Source Control", action: () => { setActiveView("changes"); setExplorerOpen(true); } },
        { label: "Run View", action: () => { setActiveView("run"); setExplorerOpen(true); } },
        { label: "Project Preview", shortcut: "Ctrl+Shift+V", action: togglePreview },
        { label: "Toggle Primary Sidebar", shortcut: "Ctrl+B", action: () => setExplorerOpen(!explorerOpen) },
        { label: "Toggle Bottom Panel", shortcut: "Ctrl+J", action: () => toggleBottom() },
        { label: "Toggle Secondary Sidebar", action: () => setChatOpen(!chatOpen) },
      ],
    },
    {
      name: "Go",
      items: [
        { label: "Go to File...", shortcut: "Ctrl+P", action: () => setQuickOpenOpen(true) },
        { label: "Return to Project Overview", shortcut: "Alt+Left", action: handleBackClick },
      ],
    },
    {
      name: "Run",
      items: [
        { label: "Execute Pipeline", action: () => { if (canExecute && !runDisabled) execute.mutateAsync().catch(() => undefined); } },
        { label: "Show Run Status", action: () => { setActiveView("run"); setExplorerOpen(true); } },
      ],
    },
    {
      name: "Terminal",
      items: [
        { label: "Execution Monitor", action: () => useWorkspaceStore.getState().setBottomTab("terminal") },
        { label: "Ledger Events", action: () => useWorkspaceStore.getState().setBottomTab("events") },
      ],
    },
    {
      name: "Help",
      items: [
        { label: "About Verya IDE", action: () => window.open("https://verya.io", "_blank") },
      ],
    },
  ];

  const activeBuffer = activePath ? buffers[activePath] : null;

  return (
    <div className="ide-workspace fixed inset-0 z-50 flex min-h-0 flex-col bg-[#1e1e1e] text-[#cccccc] font-sans overflow-hidden select-none">
      {/* 1. VS Code Title & Menu Bar (35px) */}
      <header className="flex h-[35px] shrink-0 items-center justify-between border-b border-[#2d2d2d] bg-[#181818] px-2 text-[12px]">
        {/* Left: Brand + Back/Return + Project Name + Menus */}
        <div ref={menuBarRef} className="flex items-center gap-1.5 min-w-0">
          {/* Freebuff-style window lights (purely aesthetic, like a native editor) */}
          <div className="mr-1 flex shrink-0 items-center gap-[6px] select-none" aria-hidden>
            <span className="h-[10px] w-[10px] rounded-full bg-[#ff5f57]" />
            <span className="h-[10px] w-[10px] rounded-full bg-[#febc2e]" />
            <span className="h-[10px] w-[10px] rounded-full bg-[#28c840]" />
          </div>

          {/* Verya Brand Icon */}
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-[#007acc] text-[10px] font-bold text-white shadow-xs select-none">
            V
          </span>

          {/* VS Code-style Back / Return Control */}
          <button
            type="button"
            onClick={handleBackClick}
            className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded text-[#999999] hover:bg-[#2a2d2e] hover:text-white transition-colors cursor-pointer"
            title="Return to Project (View planning and gates)"
            aria-label="Return to Project"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
          </button>

          {/* Project Breadcrumb / Title */}
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#cccccc] pl-0.5 pr-2.5 mr-0.5 border-r border-[#2d2d2d] shrink-0 select-none">
            <span className="text-white font-semibold">Verya</span>
            <span className="text-[#666666]">/</span>
            <span className="max-w-[140px] sm:max-w-[200px] truncate text-[#cccccc]" title={projectTitle}>
              {projectTitle}
            </span>
          </div>

          {/* Menus: File, Edit, Selection, View, Go, Run, Terminal, Help */}
          <div className="flex items-center">
            {MENUS.map((menu) => (
              <div key={menu.name} className="relative">
                <button
                  type="button"
                  onClick={() => setOpenMenu(openMenu === menu.name ? null : menu.name)}
                  onMouseEnter={() => { if (openMenu) setOpenMenu(menu.name); }}
                  className={`px-2 py-0.5 rounded text-[12px] text-[#cccccc] hover:bg-[#2a2d2e] transition-colors ${
                    openMenu === menu.name ? "bg-[#2a2d2e] text-white" : ""
                  }`}
                >
                  {menu.name}
                </button>

                {/* Menu Dropdown */}
                {openMenu === menu.name && (
                  <div className="absolute left-0 top-[28px] z-50 min-w-[200px] rounded bg-[#252526] py-1 border border-[#3c3c3c] shadow-2xl">
                    {menu.items.map((item, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          item.action?.();
                          setOpenMenu(null);
                        }}
                        className="flex w-full items-center justify-between px-3 py-1 text-left text-[11px] text-[#cccccc] hover:bg-[#04395e] hover:text-white"
                      >
                        <span>{item.label}</span>
                        {item.shortcut && (
                          <span className="ml-4 font-mono text-[10px] text-[#858585]">{item.shortcut}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Center: Quiet Window Title / Quick Open bar */}
        <button
          type="button"
          onClick={() => setQuickOpenOpen(true)}
          className="hidden md:flex items-center justify-center gap-2 h-[22px] px-3 rounded bg-[#252526] hover:bg-[#2a2d2e] border border-[#333333] text-[11px] text-[#858585] hover:text-[#cccccc] transition-colors max-w-[340px] truncate"
          title="Search files or run commands (Ctrl+P)"
        >
          <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <span className="truncate">{projectTitle} — Verya</span>
        </button>

        {/* Right: Layout toggles, Run status & Window controls */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Trust budget pill if available */}
          {session.trustBudget && (
            <span className="hidden xl:flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#252526] border border-[#333333] text-[10px] text-[#858585]">
              <span className="text-[#007acc]">Trust</span>
              <span>{session.trustBudget.remaining.toFixed(0)}/{session.trustBudget.initial.toFixed(0)}</span>
            </span>
          )}

          {/* Execution state badge */}
          {ws.runState === "running" ? (
            <span className="flex items-center gap-1.5 text-[11px] text-amber-400">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              Running…
            </span>
          ) : ws.runState === "completed" ? (
            <span className="text-[11px] text-[#73c991]">● Build Complete</span>
          ) : ws.runState === "failed" ? (
            <span className="text-[11px] text-red-400">● Build Failed</span>
          ) : (
            <button
              type="button"
              disabled={runDisabled}
              onClick={() => { void execute.mutateAsync().catch(() => undefined); }}
              className="flex h-[22px] items-center gap-1 rounded bg-[#007acc] px-2 text-[11px] font-medium text-white hover:bg-[#0062a3] disabled:opacity-30 cursor-pointer"
              title="Run Workflow"
            >
              ▶ Run
            </button>
          )}

          {/* Project Preview toggle */}
          <button
            type="button"
            onClick={togglePreview}
            className={`flex h-[22px] items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors cursor-pointer ${
              centerView === "preview" ? "bg-[#04395e] text-white" : "bg-[#252526] text-[#cccccc] hover:bg-[#2a2d2e]"
            }`}
            title="Toggle Project Preview (Ctrl+Shift+V) — renders the generated app from the live workspace files"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Preview
          </button>

          {/* Panel Layout Toggles */}
          <div className="flex items-center border-l border-[#2d2d2d] pl-1.5 ml-1 gap-0.5">
            <button
              type="button"
              onClick={() => setExplorerOpen(!explorerOpen)}
              className={`p-1 rounded hover:bg-[#2a2d2e] cursor-pointer ${explorerOpen ? "text-white" : "text-[#858585]"}`}
              title="Toggle Primary Sidebar (Ctrl+B)"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16" />
              </svg>
            </button>
            <button
              type="button"
              onClick={toggleBottom}
              className="p-1 rounded hover:bg-[#2a2d2e] text-[#858585] hover:text-white cursor-pointer"
              title="Toggle Bottom Panel (Ctrl+J)"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M3 15h18" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setChatOpen(!chatOpen)}
              className={`p-1 rounded hover:bg-[#2a2d2e] cursor-pointer ${chatOpen ? "text-white" : "text-[#858585]"}`}
              title="Toggle Secondary Sidebar (Agent)"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M15 4v16" />
              </svg>
            </button>
          </div>

          {/* Window control action */}
          <div className="flex items-center border-l border-[#2d2d2d] pl-1 ml-0.5">
            <button
              type="button"
              onClick={handleBackClick}
              className="flex h-[22px] w-[22px] items-center justify-center rounded hover:bg-red-600/80 hover:text-white text-[#858585] transition-colors cursor-pointer text-[11px]"
              title="Close Workspace (Return to Project)"
              aria-label="Close Workspace"
            >
              ✕
            </button>
          </div>
        </div>
      </header>

      {/* 2. Main Workbench Area: Activity Bar | Primary Sidebar | Dominant Editor | Secondary Sidebar */}
      <div className="flex min-h-0 flex-1">
        {/* Activity Bar (48px) */}
        <ActivityBar />

        {/* Primary Sidebar (270px) */}
        {explorerOpen && (
          <aside className="flex w-[270px] min-h-0 shrink-0 flex-col border-r border-[#2d2d2d] bg-[#252526]">
            {/* Sidebar View Header */}
            <div className="flex h-[35px] shrink-0 items-center justify-between border-b border-[#2d2d2d] px-3 text-[11px] font-semibold uppercase tracking-wider text-[#bbbbbb]">
              <span>{activeView === "explorer" ? "Explorer" : activeView === "search" ? "Search" : activeView === "changes" ? "Source Control" : activeView === "run" ? "Run" : "Governance"}</span>
              <button
                type="button"
                onClick={() => setExplorerOpen(false)}
                className="p-0.5 text-[#858585] hover:text-[#cccccc]"
                title="Hide Primary Sidebar (Ctrl+B)"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
              </button>
            </div>

            {/* Sidebar Body */}
            <div className="min-h-0 flex-1 overflow-y-auto ide-scroll">
              {activeView === "explorer" && (
                <div className="py-0.5">
                  <div className="flex h-[22px] items-center px-2 text-[11px] font-bold text-[#bbbbbb] tracking-wider">
                    <span>▾ PROJECT</span>
                  </div>
                  <FileExplorer tree={buildTree(ws.files)} fileContent={fileContent} readOnly={null} />
                </div>
              )}

              {activeView === "search" && (
                <SidebarSearch ws={ws} fileContent={fileContent} />
              )}
              {activeView === "changes" && (
                <SidebarChanges ws={ws} />
              )}
              {activeView === "run" && (
                <SidebarRun ws={ws} />
              )}
              {activeView === "governance" && (
                <SidebarGovernance ws={ws} />
              )}
            </div>
          </aside>
        )}

        {/* Center: DOMINANT Code Editor + Bottom Panel */}
        <main className="flex min-w-0 flex-1 flex-col bg-[#1e1e1e]">
          {/* Tab Strip (35px) */}
          {openPaths.length > 0 && (
            <div className="flex h-[35px] shrink-0 items-center overflow-x-auto border-b border-[#2d2d2d] bg-[#181818]">
              {openPaths.map((p) => {
                const b = buffers[p];
                const name = p.split("/").pop() ?? p;
                const isActive = activePath === p;
                return (
                  <div
                    key={p}
                    className={`group relative flex h-full items-center gap-2 border-r border-[#2d2d2d] px-3 text-[12px] cursor-pointer transition-colors ${
                      isActive
                        ? "bg-[#1e1e1e] text-white before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] before:bg-[#007acc]"
                        : "bg-[#2d2d2d]/25 text-[#969696] hover:bg-[#2d2d2d]/50 hover:text-[#cccccc]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setActive(p)}
                      className="flex items-center gap-1.5 font-mono truncate outline-none"
                    >
                      <span className="max-w-[140px] truncate">{name}</span>
                    </button>
                    {b?.dirty && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Unsaved changes" />
                    )}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); closeTab(p); }}
                      className="rounded-sm p-0.5 text-[#858585] hover:text-white hover:bg-[#383838] transition-colors"
                      title="Close (Ctrl+W)"
                      aria-label={`Close ${name}`}
                    >
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Breadcrumbs (24px) */}
          <Breadcrumbs />

          {/* Code Editor Canvas: DOMINATES 55-65%+ OF SCREEN */}
          <div className="relative min-h-0 flex-1">
            {centerView === "preview" ? (
              <PreviewPane ws={ws} sessionId={session.id} onClose={togglePreview} />
            ) : activeBuffer ? (
              <CodeEditor
                path={activeBuffer.path}
                content={activeBuffer.draft}
                language={activeBuffer.language}
                dirty={activeBuffer.dirty}
                readOnly={activeBuffer.readOnly}
                onSave={() => void saveActive()}
                saving={saving}
              />
            ) : (
              <div className="flex h-full items-center justify-center select-none">
                <div className="max-w-xs text-center">
                  <span className="text-[32px] font-bold text-[#333333]">V</span>
                  <p className="mt-1 text-[13px] font-medium text-[#cccccc]">Verya Editor</p>
                  <p className="mt-1 text-[11px] text-[#666666]">
                    Open a file from the Explorer or press <kbd className="px-1.5 py-0.5 rounded bg-[#252526] border border-[#3c3c3c] text-[#858585]">Ctrl+P</kbd>
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Bottom Panel (200px, Collapsible) */}
          <BottomPanel ws={ws} sessionId={session.id} />
        </main>

        {/* Secondary Sidebar: AI Agent (320px) */}
        {chatOpen ? (
          <aside className="flex w-[320px] min-h-0 shrink-0 flex-col border-l border-[#2d2d2d] bg-[#252526]">
            {/* Header */}
            <div className="flex h-[35px] shrink-0 items-center justify-between border-b border-[#2d2d2d] px-3 text-[11px] font-semibold uppercase tracking-wider text-[#bbbbbb]">
              <span>Verya Agent</span>
              <button
                type="button"
                onClick={() => setChatOpen(false)}
                className="p-0.5 text-[#858585] hover:text-[#cccccc]"
                title="Hide Secondary Sidebar"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Streamlined Assistant Chat */}
            <AgentChat
              ws={ws}
              sessionId={session.id}
              onExecute={() => {
              execute.mutateAsync().catch((err) => {
                useWorkspaceStore.getState().addMsg({
                  role: "agent",
                  text: `Could not start execution: ${err instanceof Error ? err.message : "unknown error"}`,
                  steps: [],
                });
              });
            }}
              canExecute={canExecute}
            />
          </aside>
        ) : null}
      </div>

      {/* 3. Status Bar (22px) */}
      <StatusBar ws={ws} />

      {/* Overlays */}
      <TaskInspector ws={ws} busy={busy} onFeedback={runFeedback} />
      <CommandPalette
        ws={ws}
        fileContent={fileContent}
        onExecute={() => { void execute.mutateAsync().catch(() => undefined); }}
        canExecute={canExecute}
      />
      {/* Safe Execution Leave Confirmation Modal */}
      {showLeaveConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-xs">
          <div className="w-[360px] rounded-lg border border-[#3c3c3c] bg-[#252526] p-4 text-[#cccccc] shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-400">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
              </div>
              <div>
                <h4 className="text-[13px] font-semibold text-white">Execution is still running</h4>
                <p className="mt-1 text-[12px] text-[#858585] leading-relaxed">
                  Execution is still running. Leave workspace? Tasks will continue safely in the background.
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowLeaveConfirm(false)}
                className="rounded px-3 py-1.5 text-[12px] text-[#cccccc] hover:bg-[#3c3c3c] transition-colors cursor-pointer"
              >
                Stay
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowLeaveConfirm(false);
                  performBack();
                }}
                className="rounded bg-[#007acc] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#0062a3] transition-colors cursor-pointer"
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Secondary Views for Primary Sidebar ---

function SidebarSearch({ ws, fileContent }: { ws: WsBuild; fileContent: (path: string) => { content: string; language: string; artifact: { taskId: string; language: string; version: number } } | null }) {
  const [query, setQuery] = useState("");
  const openFile = useWorkspaceStore((s) => s.openFile);
  const results = useMemo(() => {
    if (!query.trim()) return ws.files;
    const q = query.toLowerCase();
    return ws.files.filter((f) => f.path.toLowerCase().includes(q));
  }, [query, ws.files]);

  return (
    <div className="p-3">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search files by name..."
        className="mb-2 h-[26px] w-full rounded bg-[#1e1e1e] px-2 font-mono text-[11px] text-[#cccccc] outline-none border border-[#3c3c3c] focus:border-[#007acc]"
        autoFocus
      />
      <p className="mb-2 text-[10px] text-[#858585]">{results.length} result{results.length === 1 ? "" : "s"}</p>
      <div className="space-y-0.5">
        {results.map((f) => (
          <button
            key={f.path}
            type="button"
            onClick={() => {
              const fc = fileContent(f.path);
              if (fc) openFile({ path: f.path, ...fc, readOnly: null });
            }}
            className="flex h-[22px] w-full items-center gap-2 px-1.5 text-left text-[11px] font-mono text-[#cccccc] hover:bg-[#2a2d2e] rounded transition-colors"
          >
            <span className="truncate">{f.path.replace(/^project\//, "")}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SidebarChanges({ ws }: { ws: WsBuild }) {
  const applied = ws.tasks.flatMap((t) =>
    (t.execution?.fileOps ?? [])
      .filter((f) => !f.rejected)
      .map((f) => ({ ...f, taskTitle: t.title, model: t.model }))
  );
  return (
    <div className="p-3 text-[11px]">
      <p className="mb-2 text-[10px] uppercase font-semibold text-[#858585]">Modified Files ({applied.length})</p>
      {applied.length === 0 && <p className="text-[#666666]">No changes applied yet.</p>}
      <div className="space-y-1 font-mono">
        {applied.map((f, i) => (
          <div key={i} className="flex items-center gap-2 py-0.5">
            <span className={`text-[10px] font-bold ${f.operation === "create" ? "text-[#73c991]" : "text-[#e2c08d]"}`}>
              {f.operation === "create" ? "U" : "M"}
            </span>
            <span className="truncate text-[#cccccc]">{f.path}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SidebarRun({ ws }: { ws: WsBuild }) {
  const completedCount = ws.tasks.filter((t) => t.status === "verified" || t.status === "flagged").length;
  return (
    <div className="p-3 text-[11px] space-y-3">
      <div>
        <div className="flex justify-between text-[#858585] mb-1 text-[10px]">
          <span>EXECUTION PROGRESS</span>
          <span>{completedCount}/{ws.tasks.length}</span>
        </div>
        <div className="h-[3px] rounded bg-[#1e1e1e] overflow-hidden">
          <div className="h-full bg-[#007acc] transition-all" style={{ width: `${ws.tasks.length > 0 ? (completedCount / ws.tasks.length) * 100 : 0}%` }} />
        </div>
      </div>
      <div className="space-y-1">
        {ws.tasks.map((t) => (
          <div key={t.id} className="flex items-center gap-2 py-0.5">
            <span className={t.status === "verified" ? "text-[#73c991]" : t.status === "running" ? "text-sky-400 animate-pulse" : t.status === "failed" ? "text-red-400" : "text-[#666666]"}>
              {t.status === "verified" ? "✓" : t.status === "running" ? "◐" : t.status === "failed" ? "✗" : "○"}
            </span>
            <span className="truncate text-[#cccccc]">{t.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SidebarGovernance({ ws }: { ws: WsBuild }) {
  const v = ws.governance.verification;
  return (
    <div className="p-3 text-[11px] space-y-3 select-none">
      <div>
        <span className="text-[10px] uppercase font-semibold text-[#858585]">Trust Budget</span>
        {ws.governance.trustBudget ? (
          <div className="mt-1">
            <div className="flex justify-between text-[#cccccc]">
              <span>Remaining</span>
              <span>{Math.round(ws.governance.trustBudget.remaining)}/{Math.round(ws.governance.trustBudget.initial)}</span>
            </div>
            <div className="mt-1 h-[3px] rounded bg-[#1e1e1e] overflow-hidden">
              <div className="h-full bg-[#73c991]" style={{ width: `${(ws.governance.trustBudget.remaining / ws.governance.trustBudget.initial) * 100}%` }} />
            </div>
          </div>
        ) : (
          <p className="text-[#666666]">Ready</p>
        )}
      </div>
      <div>
        <span className="text-[10px] uppercase font-semibold text-[#858585]">Verification</span>
        <div className="mt-1 space-y-0.5 text-[#cccccc]">
          <p><span className="text-[#73c991]">✓</span> Verified: {v.verified}</p>
          <p><span className="text-[#e2c08d]">⚠</span> Flagged: {v.flagged}</p>
          <p><span className="text-red-400">✗</span> Failed: {v.failed}</p>
        </div>
      </div>
    </div>
  );
}
