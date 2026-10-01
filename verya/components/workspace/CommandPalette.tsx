"use client";

// Command Palette (Ctrl+Shift+P) and Quick Open (Ctrl+P).
// Only commands backed by real functionality.

import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { WsBuild } from "@/lib/workspace/build";

type Command = {
  id: string;
  label: string;
  shortcut?: string;
  action: () => void;
};

export function CommandPalette({
  ws,
  fileContent,
  onExecute,
  canExecute,
}: {
  ws: WsBuild;
  fileContent: (path: string) => { content: string; language: string; artifact: { taskId: string; language: string; version: number } } | null;
  onExecute: () => void;
  canExecute: boolean;
}) {
  const paletteOpen = useWorkspaceStore((s) => s.commandPaletteOpen);
  const setPaletteOpen = useWorkspaceStore((s) => s.setCommandPaletteOpen);
  const quickOpen = useWorkspaceStore((s) => s.quickOpenOpen);
  const setQuickOpen = useWorkspaceStore((s) => s.setQuickOpenOpen);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const setActiveView = useWorkspaceStore((s) => s.setActiveView);
  const toggleBottom = useWorkspaceStore((s) => s.toggleBottom);
  const setBottomTab = useWorkspaceStore((s) => s.setBottomTab);
  const setExplorerOpen = useWorkspaceStore((s) => s.setExplorerOpen);
  const setChatOpen = useWorkspaceStore((s) => s.setChatOpen);
  const setCenterView = useWorkspaceStore((s) => s.setCenterView);

  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isOpen = paletteOpen || quickOpen;
  const mode = quickOpen ? "file" : "command";

  const commands: Command[] = useMemo(
    () => [
      { id: "explorer", label: "Show Explorer", shortcut: "Ctrl+Shift+E", action: () => { setActiveView("explorer"); setExplorerOpen(true); } },
      { id: "search", label: "Search Files", shortcut: "Ctrl+Shift+F", action: () => { setActiveView("search"); setExplorerOpen(true); } },
      { id: "changes", label: "Show Source Control", action: () => { setActiveView("changes"); setExplorerOpen(true); } },
      { id: "run", label: "Show Run View", action: () => { setActiveView("run"); setExplorerOpen(true); } },
      { id: "governance", label: "Show Governance", action: () => { setActiveView("governance"); setExplorerOpen(true); } },
      { id: "toggle-sidebar", label: "Toggle Sidebar", shortcut: "Ctrl+B", action: () => setExplorerOpen(!useWorkspaceStore.getState().explorerOpen) },
      { id: "toggle-panel", label: "Toggle Bottom Panel", shortcut: "Ctrl+`", action: () => toggleBottom() },
      { id: "toggle-agent", label: "Toggle Agent Panel", action: () => setChatOpen(!useWorkspaceStore.getState().chatOpen) },
      { id: "preview", label: "Preview: Toggle Project Preview", shortcut: "Ctrl+Shift+V", action: () => setCenterView(useWorkspaceStore.getState().centerView === "preview" ? "editor" : "preview") },
      { id: "problems", label: "Show Problems", action: () => setBottomTab("problems") },
      { id: "output", label: "Show Output", action: () => setBottomTab("output") },
      { id: "events", label: "Show Events", action: () => setBottomTab("events") },
      { id: "verification", label: "Show Verification", action: () => setBottomTab("verification") },
      ...(canExecute ? [{ id: "execute", label: "Run: Execute All Tasks", action: onExecute }] : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canExecute]
  );

  const fileItems = useMemo(
    () =>
      ws.files.map((f) => ({
        path: f.path,
        label: f.path.replace(/^project\//, ""),
      })),
    [ws.files]
  );

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    if (mode === "file") {
      return fileItems.filter((f) => f.label.toLowerCase().includes(q)).slice(0, 20);
    }
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [query, mode, fileItems, commands]);

  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => setSelected(0), [query]);

  const execute = (idx: number) => {
    if (mode === "file") {
      const item = filtered[idx] as { path: string; label: string } | undefined;
      if (item) {
        const fc = fileContent(item.path);
        if (fc) openFile({ path: item.path, ...fc, readOnly: null });
      }
    } else {
      const cmd = filtered[idx] as Command | undefined;
      cmd?.action();
    }
    setPaletteOpen(false);
    setQuickOpen(false);
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex justify-center pt-[15vh]"
      onClick={() => { setPaletteOpen(false); setQuickOpen(false); }}
    >
      <div
        className="flex h-fit max-h-[50vh] w-full max-w-lg flex-col overflow-hidden rounded-md border border-[#3c3c3c] bg-[#252526] shadow-2xl select-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center border-b border-[#2d2d2d] bg-[#1e1e1e] px-3 py-2">
          {mode === "command" && <span className="mr-1.5 text-[12px] font-bold text-[#007acc]">&gt;</span>}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setPaletteOpen(false); setQuickOpen(false); }
              if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, filtered.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
              if (e.key === "Enter") { e.preventDefault(); execute(selected); }
            }}
            placeholder={mode === "file" ? "Search files by name…" : "Type a command…"}
            className="flex-1 bg-transparent text-[12px] text-white outline-none placeholder:text-[#666666]"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto ide-scroll py-1">
          {filtered.length === 0 && (
            <p className="px-3 py-3 text-[11px] text-[#858585]">No matching results.</p>
          )}
          {filtered.map((item, i) => (
            <button
              key={mode === "file" ? (item as { path: string }).path : (item as Command).id}
              type="button"
              onClick={() => execute(i)}
              className={`flex w-full items-center justify-between px-3 py-1 text-left text-[12px] ${
                selected === i ? "bg-[#04395e] text-white" : "text-[#cccccc] hover:bg-[#2a2d2e]"
              }`}
            >
              <span className="truncate font-mono text-[11px]">
                {mode === "file" ? (item as { label: string }).label : (item as Command).label}
              </span>
              {mode === "command" && (item as Command).shortcut && (
                <span className="ml-2 shrink-0 text-[10px] text-[#858585]">
                  {(item as Command).shortcut}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
