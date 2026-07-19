import type { ServerCfg } from "./config";

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
};

export type RegistryHit = {
  ref: string;
  description: string;
  entry: RegistryEntry["server"];
};

function baseUrl(): string {
  return process.env.MCPMUX_REGISTRY ?? "https://registry.modelcontextprotocol.io";
}

/** Default local name for a registry ref (com.gitlab/mcp → mcp). */
export function refToName(ref: string): string {
  return ref.split("/").pop()!.replace(/[^a-z0-9-]/gi, "-");
}

export async function searchRegistry(query: string): Promise<RegistryHit[]> {
  if (process.env.MCPMUX_DEBUG) console.error("[registry] GET", `${baseUrl()}/v0/servers?search=${encodeURIComponent(query)}&limit=30`);
  const res = await fetch(`${baseUrl()}/v0/servers?search=${encodeURIComponent(query)}&limit=30`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`registry answered HTTP ${res.status} — is ${baseUrl()} reachable?`);
  const data = (await res.json()) as { servers?: RegistryEntry[] };
  return (data.servers ?? []).map((e) => ({
    ref: e.server.name,
    description: e.server.description ?? "",
    entry: e.server,
  }));
}

/**
 * Map a registry hit to a mux ServerCfg. Preference: remote (http) → npm/pypi
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
  if (!pkg) throw new Error(`"${hit.ref}" has no usable install method (no http remote, no npm/pypi package) — add it manually: mux add <name> -- <command…>`);

  // identifier is registry-controlled → validate before it becomes argv: a leading '-' would
  // be parsed by npx/uvx as a flag (injection) (#16)
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(pkg.identifier))
    throw new Error(`registry package identifier "${pkg.identifier}" is not a plain package name — refusing to install`);
  // pin to the registry version so what `mux search` showed is what runs, not npx latest (#16)
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
