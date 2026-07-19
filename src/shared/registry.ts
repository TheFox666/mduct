import type { ServerCfg } from "./config";

/** Shape per registry.modelcontextprotocol.io v0 (verified live 2026-07-19). */
type RegistryEntry = {
  server: {
    name: string; description?: string; version?: string;
    remotes?: { type: string; url: string }[];
    packages?: {
      registryType: string; identifier: string; runtimeHint?: string;
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

export async function searchRegistry(query: string): Promise<RegistryHit[]> {
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
  const remote = hit.entry.remotes?.find((r) => ["streamable-http", "http", "sse"].includes(r.type));
  if (remote) return { cfg: { url: remote.url, note }, requiredEnv: [] };

  const pkg = hit.entry.packages?.find((p) => p.registryType === "npm")
    ?? hit.entry.packages?.find((p) => p.registryType === "pypi");
  if (!pkg) throw new Error(`"${hit.ref}" has no usable install method (no http remote, no npm/pypi package) — add it manually: mux add <name> -- <command…>`);

  const required = (pkg.environmentVariables ?? []).filter((v) => v.isRequired).map((v) => v.name);
  const env: Record<string, string> = {};
  for (const v of required) env[v] = `\${${v}}`;
  const cfg: ServerCfg =
    pkg.registryType === "npm"
      ? { command: "npx", args: ["-y", pkg.identifier], ...(required.length ? { env } : {}), note }
      : { command: "uvx", args: [pkg.identifier], ...(required.length ? { env } : {}), note };
  return { cfg, requiredEnv: required };
}
