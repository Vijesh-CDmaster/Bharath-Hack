// Client-side workspace UI state (Zustand, same store pattern as ui-store).
// Server state (session data) stays in TanStack Query; this store holds only
// what the IDE shell needs locally: tabs, dirty buffers, chat, panels.

import { create } from "zustand";

export type ChatMsg = {
  id: string;
  role: "user" | "agent";
  text: string;
  ts: number;
  /** Structured action/status trail for agent messages (no hidden chain-of-thought). */
  steps?: string[];
  pending?: boolean;
};

export type Buffer = {
  path: string;
  original: string; // last saved (server) content
  draft: string; // editor content
  language: string;
  artifact: { taskId: string; language: string; version: number };
  readOnly: string | null; // null = editable (review gate); otherwise why it's read-only
  dirty: boolean;
};

export type ActiveView = "explorer" | "search" | "changes" | "run" | "governance";

/** Center-area overlay: null shows the editor, "preview" shows the preview pane. */
export type CenterView = "editor" | "preview";

export type BottomTab = "terminal" | "problems" | "output" | "changes" | "tests" | "verification" | "events";

type WorkspaceState = {
  // Editor
  openPaths: string[];
  activePath: string | null;
  buffers: Record<string, Buffer>;
  search: string;

  // Activity bar + sidebar
  activeView: ActiveView;

  // Panels
  centerView: CenterView;
  bottomTab: BottomTab;
  bottomOpen: boolean;
  explorerOpen: boolean;
  chatOpen: boolean;

  // Command palette / quick open
  commandPaletteOpen: boolean;
  quickOpenOpen: boolean;

  // Chat
  messages: ChatMsg[];
  chatBusy: boolean;

  // Task inspector
  selectedTaskId: string | null;

  // Actions
  openFile: (f: {
    path: string;
    content: string;
    language: string;
    artifact: { taskId: string; language: string; version: number };
    readOnly: string | null;
  }) => void;
  closeTab: (path: string) => void;
  setActive: (path: string) => void;
  editBuffer: (path: string, content: string) => void;
  markSaved: (path: string, version: number) => void;
  setSearch: (q: string) => void;
  setActiveView: (view: ActiveView) => void;
  setCenterView: (view: CenterView) => void;
  setBottomTab: (tab: BottomTab) => void;
  toggleBottom: () => void;
  setExplorerOpen: (open: boolean) => void;
  setChatOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setQuickOpenOpen: (open: boolean) => void;
  addMsg: (m: Omit<ChatMsg, "id" | "ts">) => string;
  updateMsg: (id: string, patch: Partial<ChatMsg>) => void;
  setChatBusy: (b: boolean) => void;
  selectTask: (id: string | null) => void;
  reset: () => void;
};

let counter = 0;
function uid(): string {
  counter += 1;
  return `m${Date.now().toString(36)}${counter}`;
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  openPaths: [],
  activePath: null,
  buffers: {},
  search: "",

  activeView: "explorer",

  centerView: "editor" as CenterView,
  bottomTab: "output",
  bottomOpen: true,
  explorerOpen: true,
  chatOpen: true,

  commandPaletteOpen: false,
  quickOpenOpen: false,

  messages: [],
  chatBusy: false,

  selectedTaskId: null,

  openFile: (f) =>
    set((s) => {
      const existing = s.buffers[f.path];
      return {
        openPaths: s.openPaths.includes(f.path) ? s.openPaths : [...s.openPaths, f.path],
        activePath: f.path,
        buffers: {
          ...s.buffers,
          [f.path]: {
            path: f.path,
            // Never clobber local edits when reopening a tab.
            original: existing ? existing.original : f.content,
            draft: existing ? existing.draft : f.content,
            language: f.language,
            artifact: f.artifact,
            readOnly: f.readOnly,
            dirty: existing?.dirty ?? false,
          },
        },
      };
    }),

  closeTab: (path) =>
    set((s) => {
      const buffers = { ...s.buffers };
      if (buffers[path] && !buffers[path].dirty) delete buffers[path];
      const openPaths = s.openPaths.filter((p) => p !== path || buffers[p]);
      const activePath = s.activePath === path ? (openPaths[0] ?? null) : s.activePath;
      return { openPaths, activePath, buffers };
    }),

  setActive: (path) => set({ activePath: path }),

  editBuffer: (path, content) =>
    set((s) => {
      const b = s.buffers[path];
      if (!b || b.readOnly) return {};
      return { buffers: { ...s.buffers, [path]: { ...b, draft: content, dirty: content !== b.original } } };
    }),

  markSaved: (path, version) =>
    set((s) => {
      const b = s.buffers[path];
      if (!b) return {};
      return {
        buffers: { ...s.buffers, [path]: { ...b, original: b.draft, dirty: false, artifact: { ...b.artifact, version } } },
      };
    }),

  setSearch: (q) => set({ search: q }),
  setCenterView: (view) => set({ centerView: view }),
  setActiveView: (view) => set({ activeView: view, explorerOpen: true }),
  setBottomTab: (tab) => set({ bottomTab: tab, bottomOpen: true }),
  toggleBottom: () => set((s) => ({ bottomOpen: !s.bottomOpen })),
  setExplorerOpen: (open) => set({ explorerOpen: open }),
  setChatOpen: (open) => set({ chatOpen: open }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setQuickOpenOpen: (open) => set({ quickOpenOpen: open }),

  addMsg: (m) => {
    const id = uid();
    set((s) => ({ messages: [...s.messages, { ...m, id, ts: Date.now() }] }));
    return id;
  },
  updateMsg: (id, patch) => set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
  setChatBusy: (b) => set({ chatBusy: b }),

  selectTask: (id) => set({ selectedTaskId: id }),

  reset: () =>
    set({ openPaths: [], activePath: null, buffers: {}, messages: [], chatBusy: false, selectedTaskId: null, search: "", activeView: "explorer", centerView: "editor" as CenterView, commandPaletteOpen: false, quickOpenOpen: false }),
}));
