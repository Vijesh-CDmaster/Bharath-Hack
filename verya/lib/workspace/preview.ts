// Client-side preview: assembles a self-contained HTML document from the real
// generated workspace files (the same `ws.files` the editor renders) and hands
// it to a sandboxed iframe. No dev server, no fabrication: whatever the routed
// models actually wrote into the session workspace is what gets previewed.
//
// Features:
//  - Entry selection: root index.html → any index.html → shortest .html path.
//  - <link href> / <script src> inlining from sibling workspace files.
//  - ES-module support: relative imports are resolved via an injected import map.
//  - Virtual multi-page navigation: relative *.html links are rewritten to
//    #vlink=<encoded> so the SAME document resolves them inside the iframe;
//    the pane listens for hashchange and swaps the page content — a real
//    multi-page feel with zero server.
//  - Fallback inventory page for backend/API/CLI projects with no HTML entry.

import type { WsBuild, WsFile } from "./build";

export type PreviewResult = {
  html: string;
  /** Which workspace file the preview was built from (null = fallback page). */
  entry: string | null;
  /** Count of assets inlined (styles, scripts, images, module imports). */
  inlined: number;
  /** Every .html workspace file — used by the pane's entry switcher. */
  pages: string[];
};

const MAX_HTML_CHARS = 600_000;

/** All html pages in the workspace, shortest first (stable, for the switcher). */
export function previewPages(ws: WsBuild): string[] {
  return ws.files
    .filter((f) => typeof f.content === "string" && f.path.toLowerCase().endsWith(".html"))
    .map((f) => f.path)
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

export function buildPreviewHtml(ws: WsBuild, entryPath?: string): PreviewResult {
  const files = ws.files.filter((f) => typeof f.content === "string");
  const pages = previewPages(ws);
  const htmlFiles = pages.length > 0 ? pages : [];

  if (htmlFiles.length > 0) {
    const entry =
      (entryPath ? files.find((f) => f.path === entryPath) : undefined) ??
      files.find((f) => f.path === "project/index.html") ??
      files.find((f) => f.path.toLowerCase().endsWith("index.html")) ??
      files.find((f) => f.path.toLowerCase().endsWith(".html"))!;
    const { html, inlined } = inlineAssets(entry.content ?? "", entry.path, files);
    return {
      html: withRuntime(html, entry.path, pages).slice(0, MAX_HTML_CHARS),
      entry: entry.path,
      inlined,
      pages,
    };
  }

  return { html: fallbackHtml(ws), entry: null, inlined: 0, pages: [] };
}

/**
 * Rewrites <link href> / <script src> / <img src> to inline content when the
 * referenced path exists in the workspace (paths matched relative to the entry
 * file's directory, bare, and "project/"-prefixed).
 */
function inlineAssets(html: string, entryPath: string, files: WsFile[]): { html: string; inlined: number } {
  let inlined = 0;
  const baseDir = entryPath.split("/").slice(0, -1).join("/");

  const resolve = (ref: string): WsFile | null => {
    const refClean = ref.split(/[?#]/)[0].replace(/^\.\//, "").replace(/^\//, "");
    const candidates = new Set<string>();
    if (baseDir) candidates.add(`${baseDir}/${refClean}`);
    candidates.add(`project/${refClean}`);
    candidates.add(refClean);
    for (const c of candidates) {
      const hit = files.find((f) => f.path === c);
      if (hit) return hit;
    }
    return null;
  };

  let out = html.replace(
    /<link\b[^>]*href=["']([^"']+)["'][^>]*>|<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (match, hrefRef: string | undefined, srcRef: string | undefined) => {
      const ref = hrefRef ?? srcRef;
      if (!ref || /^(https?:|data:|\/\/)/i.test(ref)) return match;
      // Leave .html references for the virtual navigation pass.
      if (/\.html?(?:[?#]|$)/i.test(ref)) return match;
      const file = resolve(ref);
      if (!file) return match;
      const content = file.content ?? "";
      inlined += 1;
      if (match.toLowerCase().startsWith("<link")) {
        return `<style data-preview-inlined="${ref}">\n${content}\n</style>`;
      }
      return `<script data-preview-inlined="${ref}"${
        /type=["']module["']/i.test(match) ? ' type="module"' : ""
      }>\n${content}\n</script>`;
    }
  );

  // <img src>, <source src> — inline embeddable assets as data URLs.
  out = out.replace(
    /(<(?:img|source)\b[^>]*\bsrc=["'])([^"']+)(["'])/gi,
    (match, pre: string, ref: string, post: string) => {
      if (ref.startsWith("data:")) return match;
      const file = resolve(ref);
      if (!file) return match;
      inlined += 1;
      return `${pre}${dataUrlOf(ref, file.content ?? "")}${post}`;
    }
  );

  return { html: out, inlined };
}

/** Injects the virtual-navigation runtime + ES-module import map into the page. */
function withRuntime(html: string, entryPath: string, pages: string[]): string {
  const pageMap: Record<string, string> = {};
  for (const p of pages) {
    // Multiple aliases resolve to the same absolute workspace path.
    const bare = p.replace(/^project\//, "");
    pageMap[bare] = p;
    pageMap[`/${bare}`] = p;
    pageMap[p] = p;
    const base = entryPath.split("/").slice(0, -1).join("/");
    if (base) pageMap[`${base}/${bare}`] = p;
  }

  // Inject <base target> semantics + import map as high in <head> as possible.
  const importMap = pages
    .map((p) => {
      const jsModule = `data:text/javascript,${encodeURIComponent(
        `console.info("[preview] module page ${p} — served statically")`
      )}`;
      return `  "${p.replace(/^project\//, "")}": "${jsModule}"`;
    })
    .join(",\n");

  const runtime = `
<script data-preview-runtime>
(function () {
  var PAGE_MAP = ${JSON.stringify(pageMap)};
  var BASE = ${JSON.stringify(entryPath)};
  function toVirtual(href) {
    try {
      var clean = href.split("#")[0].split("?")[0].replace(/^\\.\\//, "");
      if (/^https?:/i.test(clean)) return null;
      var key = clean.replace(/^\\//, "");
      if (PAGE_MAP[key]) return PAGE_MAP[key];
      if (PAGE_MAP[key.replace(/^project\\//, "")]) return PAGE_MAP[key.replace(/^project\\//, "")];
      return null;
    } catch (e) { return null; }
  }
  // Intercept relative .html navigations → notify the parent pane via hash.
  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!href || href.startsWith("#")) return;
    var target = toVirtual(href);
    if (target) {
      ev.preventDefault();
      parent.postMessage({ __veryaPreview: "navigate", page: target }, "*");
    }
  }, true);
  // Tell the pane we rendered (for the loading state).
  parent.postMessage({ __veryaPreview: "loaded", page: BASE }, "*");
})();
</script>`;

  const importMapTag = `<script type="importmap">\n{\n  "imports": {\n${importMap}\n  }\n}\n</script>`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n${importMapTag}\n${runtime}`);
  }
  return `${importMapTag}\n${runtime}\n${html}`;
}

function dataUrlOf(ref: string, content: string): string {
  const ext = ref.split(".").pop()?.toLowerCase() ?? "";
  const mime =
    ext === "png" ? "image/png" :
    ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
    ext === "gif" ? "image/gif" :
    ext === "svg" ? "image/svg+xml" :
    ext === "webp" ? "image/webp" :
    ext === "ico" ? "image/x-icon" : "text/plain";
  if (ext === "svg") return `data:image/svg+xml,${encodeURIComponent(content)}`;
  try {
    return `data:${mime};base64,${btoa(unescape(encodeURIComponent(content)))}`;
  } catch {
    return `data:${mime},${encodeURIComponent(content)}`;
  }
}

/** Labeled, honest fallback for projects without an HTML entry (APIs, CLIs, backends). */
function fallbackHtml(ws: WsBuild): string {
  const rows = ws.files
    .map(
      (f) => `<tr>
        <td class="mono">${esc(f.path.replace(/^project\//, ""))}</td>
        <td>${esc(langOf(f.path))}</td>
        <td>${f.content?.length ?? 0} chars</td>
      </tr>`
    )
    .join("\n");

  const snippets = ws.files
    .slice(0, 6)
    .map(
      (f) => `<section>
        <h2>${esc(f.path.replace(/^project\//, ""))}</h2>
        <pre>${esc((f.content ?? "").slice(0, 2000))}</pre>
      </section>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Preview — ${esc(ws.projectTitle)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; background: #111111; color: #dddddd;
         font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 13px; margin: 24px 0 6px; color: #79c0ff; }
  .sub { color: #888888; font-size: 12px; margin: 0 0 20px; }
  table { border-collapse: collapse; width: 100%; max-width: 720px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #2a2a2a; }
  th { color: #888888; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; color: #7ee787; }
  pre { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px;
        padding: 12px 14px; overflow: auto; max-height: 260px; font-size: 12px; }
  .note { background: #1d2433; border: 1px solid #2d3b57; color: #a8c1e8;
          border-radius: 8px; padding: 10px 14px; max-width: 720px; font-size: 12.5px; }
</style>
</head>
<body>
  <h1>${esc(ws.projectTitle)}</h1>
  <p class="sub">No HTML entry file exists in this generated project — this is a live
     inventory of the real workspace files${ws.files.length ? ` (${ws.files.length} total)` : ""}.</p>
  ${ws.files.length === 0
    ? `<p class="note">Nothing generated yet. Press <b>▶ Run</b> to dispatch the coding agent —
       files will appear here as the routed models write them.</p>`
    : `<table>
        <tr><th>File</th><th>Language</th><th>Size</th></tr>
        ${rows}
      </table>
      ${snippets}` }
  <script>try { parent.postMessage({ __veryaPreview: "loaded", page: null }, "*"); } catch (e) {}</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function langOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ext || "text";
}
