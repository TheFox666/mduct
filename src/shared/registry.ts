import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerCfg } from "./config";
import { cacheDir } from "./paths";

/** Shape per registry.modelcontextprotocol.io v0 (verified live 2026-07-19). */
type RegistryEntry = {
  server: {
    name: string; description?: string; version?: string;
    remotes?: { type: string; url: string }[];
    packages?: {
      registryType: string; identifier: string; version?: string; runtimeHint?: string;
      environmentVariables?: { name: string; description?: string; isRequired?: boolean; isSecret?: boolean }[];
    }[];
  };
  _meta?: { "io.modelcontextprotocol.registry/official"?: { isLatest?: boolean } };
};

export type RegistryHit = {
  ref: string;
  description: string;
  entry: RegistryEntry["server"];
};

function baseUrl(): string {
  return process.env.MDUCT_REGISTRY ?? "https://registry.modelcontextprotocol.io";
}

/** Default local name for a registry ref (com.gitlab/mcp → mcp). */
export function refToName(ref: string): string {
  return ref.split("/").pop()!.replace(/[^a-z0-9-]/gi, "-");
}

/**
 * Who published a ref, derived from its namespace. The registry ENFORCES namespace
 * ownership (verified live 2026-07-20 against the official registry docs): domain
 * namespaces (com.slack) require proving control of the domain via DNS TXT or an
 * https://<domain>/.well-known/mcp-registry-auth key; io.github.<acct> requires
 * GitHub OAuth as that account. So the namespace is a trustworthy identity of the
 * publisher — NOT a safety rating: com.pulsemcp is verifiably pulsemcp.com, which
 * is a third party, not Slack. The user still judges whether to trust that identity.
 */
export function publisher(ref: string): { kind: "domain" | "github" | "other"; who: string } {
  const ns = ref.split("/")[0] ?? ref;
  if (ns.startsWith("io.github.")) return { kind: "github", who: `github.com/${ns.slice("io.github.".length)}` };
  const parts = ns.split(".");
  if (parts.length >= 2) return { kind: "domain", who: parts.reverse().join(".") };
  return { kind: "other", who: ns };
}

const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // registry listings change slowly; a day-old list is fine

/** dedupe registry entries (one per version, ascending) to one hit per ref, keeping isLatest. */
function dedupe(servers: RegistryEntry[]): RegistryHit[] {
  const byRef = new Map<string, { hit: RegistryHit; latest: boolean }>();
  for (const e of servers) {
    const isLatest = !!e._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest;
    const cur = byRef.get(e.server.name);
    if (!cur || isLatest || !cur.latest)
      byRef.set(e.server.name, {
        hit: { ref: e.server.name, description: e.server.description ?? "", entry: e.server },
        latest: isLatest,
      });
  }
  return [...byRef.values()].map((v) => v.hit);
}

function cacheFile(query: string): string {
  // slack/Slack return identical data server-side, so normalize case → one shared entry.
  const key = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "_all";
  return join(cacheDir(), "registry", `${key}.json`);
}

function readCache(file: string): RegistryHit[] | null {
  try { return JSON.parse(readFileSync(file, "utf8")) as RegistryHit[]; } catch { return null; }
}

/**
 * Search the public MCP registry. Results are cached per query (24h) so repeated
 * lookups skip the network — the registry rate-limits hard (a few requests, then
 * it blackholes and hangs to the timeout). On a fetch failure we fall back to a
 * stale cache if we have one: last-known results beat a timeout error.
 */
export async function searchRegistry(query: string): Promise<RegistryHit[]> {
  const file = cacheFile(query);
  const fresh = (() => { try { return Date.now() - statSync(file).mtimeMs < CACHE_TTL_MS; } catch { return false; } })();
  if (fresh) { const c = readCache(file); if (c) return c; }

  const url = `${baseUrl()}/v0/servers?search=${encodeURIComponent(query)}&limit=30`;
  if (process.env.MDUCT_DEBUG) console.error("[registry] GET", url);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`registry answered HTTP ${res.status} — is ${baseUrl()} reachable?`);
  } catch (e) {
    const stale = readCache(file); // serve last-known results rather than fail on a flaky registry
    if (stale) { if (process.env.MDUCT_DEBUG) console.error("[registry] fetch failed, serving stale cache:", (e as Error).message); return stale; }
    if ((e as Error)?.name === "TimeoutError")
      throw new Error(`registry timed out after ${TIMEOUT_MS / 1000}s — it rate-limits, wait a moment and retry`);
    throw e;
  }

  const data = (await res.json()) as { servers?: RegistryEntry[] };
  const hits = dedupe(data.servers ?? []);
  try { mkdirSync(join(cacheDir(), "registry"), { recursive: true }); writeFileSync(file, JSON.stringify(hits)); } catch { /* cache is best-effort */ }
  return hits;
}

/**
 * Map a registry hit to a mduct ServerCfg. Preference: remote (http) → npm/pypi
 * package (stdio). Required env vars land in cfg.env as ${VAR} references —
 * the user provides the value via environment, never as a literal in the file.
 */
export function toServerCfg(hit: RegistryHit): { cfg: ServerCfg; requiredEnv: string[] } {
  const note = hit.description || hit.ref;
  // http remotes only — an "sse" remote needs a different transport we don't wire yet (N2)
  const remote = hit.entry.remotes?.find((r) => ["streamable-http", "http"].includes(r.type));
  if (remote) return { cfg: { url: remote.url, note }, requiredEnv: [] };

  const pkg = hit.entry.packages?.find((p) => p.registryType === "npm")
    ?? hit.entry.packages?.find((p) => p.registryType === "pypi");
  if (!pkg) throw new Error(`"${hit.ref}" has no usable install method (no http remote, no npm/pypi package) — add it manually: mduct add <name> -- <command…>`);

  // identifier is registry-controlled → validate before it becomes argv: a leading '-' would
  // be parsed by npx/uvx as a flag (injection) (#16)
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(pkg.identifier))
    throw new Error(`registry package identifier "${pkg.identifier}" is not a plain package name — refusing to install`);
  // pin to the registry version so what `mduct search` showed is what runs, not npx latest (#16)
  const spec = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;

  const required = (pkg.environmentVariables ?? []).filter((v) => v.isRequired).map((v) => v.name);
  const env: Record<string, string> = {};
  for (const v of required) env[v] = `\${${v}}`;
  const cfg: ServerCfg =
    pkg.registryType === "npm"
      ? { command: "npx", args: ["-y", spec], ...(required.length ? { env } : {}), note }
      : { command: "uvx", args: [spec], ...(required.length ? { env } : {}), note };
  return { cfg, requiredEnv: required };
}
