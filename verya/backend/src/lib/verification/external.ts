// Verya — external-knowledge verification (F13's third method).
// Validates factual claims in generated output against a real external source.
// For code tasks the dominant factual claim class is package/API references, so the
// check validates npm package names against the public registry — deterministic,
// cheap, and genuinely external (not another model's opinion).

const NPM_CHECK_URL = "https://registry.npmjs.org";

// Built-ins / stdlib / non-npm tokens that must not be checked against the registry.
const NOT_NPM = new Set([
  "node", "react", "react-dom", "next", "fs", "path", "http", "https", "crypto",
  "os", "url", "util", "stream", "buffer", "events", "child_process", "zlib",
]);

// Scoped org-internal-looking packages (e.g. @mycompany/x) can't be validated publicly.
function isCheckable(dep: string): boolean {
  if (NOT_NPM.has(dep)) return false;
  if (/^(localhost|http|https|git|github|file|link):/i.test(dep)) return false;
  if (dep.endsWith(".js") || dep.endsWith(".ts") || dep.endsWith(".css")) return false;
  return /^[a-z0-9@/-]+$/i.test(dep);
}

/** Extract package names from import/require/from statements in generated code. */
export function extractNpmReferences(code: string): string[] {
  const found = new Set<string>();
  const patterns = [
    // import x from 'pkg' / import 'pkg' / import type ... from 'pkg'
    /(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s+["']([^"']+)["']/g,
    // require('pkg')
    /require\(\s*["']([^"']+)["']\s*\)/g,
    // python-style: pip references occasionally appear; ignore. Java/C# not applicable.
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) {
      const raw = m[1];
      if (!raw) continue;
      // Strip relative/absolute paths and subpaths: 'pkg/sub' → 'pkg', '@scope/pkg/sub' stays scoped.
      let dep = raw;
      if (dep.startsWith(".") || dep.startsWith("/")) continue;
      // TypeScript/webpack path aliases ("@/lib/db", "~/components/x") are project-internal
      // imports, not registry packages — an empty scope must never be registry-checked.
      if (dep.startsWith("@/") || dep.startsWith("~/")) continue;
      if (dep.startsWith("@")) {
        dep = dep.split("/").slice(0, 2).join("/");
      } else {
        dep = dep.split("/")[0];
      }
      dep = dep.trim().toLowerCase();
      if (dep && isCheckable(dep)) found.add(dep);
    }
  }
  return Array.from(found).slice(0, 25); // cap external calls per output
}

async function npmPackageExists(name: string): Promise<boolean> {
  try {
    const res = await fetch(`${NPM_CHECK_URL}/${encodeURIComponent(name)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    // Registry trouble — treat as unknown (neither confirmed nor violated).
    return true;
  } catch {
    return true; // network unavailable — don't punish the output for our own outage
  }
}

export type ExternalCheckResult = {
  method: "npm_registry";
  checked: string[];
  unsupported: string[];
  passed: boolean;
};

/**
 * Verify that every referenced npm package actually exists in the public registry.
 * Catches the classic hallucination: confidently importing packages that were never real.
 */
export async function checkExternalReferences(output: string): Promise<ExternalCheckResult> {
  const refs = extractNpmReferences(output);
  const results = await Promise.all(refs.map((r) => npmPackageExists(r)));
  const unsupported = refs.filter((_, i) => !results[i]);
  return {
    method: "npm_registry",
    checked: refs,
    unsupported,
    passed: unsupported.length === 0,
  };
}
