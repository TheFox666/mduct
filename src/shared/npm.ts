import { basename } from "node:path";
import type { ToolCfg } from "./config";

export type NpmSpec = { pkg: string; version: string | undefined };

/**
 * If a tool runs an npm package via bunx/npx, extract {pkg, version}. Direct binaries
 * (kubectl, aws) return null. A `@latest` or absent version counts as unpinned (version undefined).
 */
export function parseNpmSpec(tool: ToolCfg): NpmSpec | null {
  const runner = basename(tool.run);
  if (runner !== "bunx" && runner !== "npx") return null;
  const token = (tool.args ?? []).find((a) => !a.startsWith("-")); // skip -y and flags
  if (!token) return null;
  // split pkg@version, honoring a leading @scope
  const at = token.indexOf("@", token.startsWith("@") ? 1 : 0);
  const pkg = at > 0 ? token.slice(0, at) : token;
  const rawVersion = at > 0 ? token.slice(at + 1) : undefined;
  const version = !rawVersion || rawVersion === "latest" ? undefined : rawVersion;
  return { pkg, version };
}

/** Numeric semver-ish comparison: is `a` a newer version than `b`? */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

function registryBase(): string {
  return process.env.MCPMUX_NPM_REGISTRY ?? "https://registry.npmjs.org";
}

/** Latest published version of an npm package, or null if unknown/unreachable. */
export async function npmLatest(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`${registryBase()}/${encodeURIComponent(pkg)}/latest`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return ((await res.json()) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}
