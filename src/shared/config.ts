import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { read as readSecrets } from "./secrets";
import { expandEnv, stripJsonc } from "./util";

export type ServerCfg = {
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
  guard?: { allow?: string[]; deny?: string[] };
  idleTtlMin?: number; note?: string; disabled?: boolean;
};
export type Config = { servers: Record<string, ServerCfg> };

export function configPath(): string {
  return process.env.MCPMUX_CONFIG ?? join(homedir(), ".config", "mcpmux", "servers.jsonc");
}

export function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) return { servers: {} };
  const raw = JSON.parse(stripJsonc(readFileSync(p, "utf8"))) as Config;
  // ${VAR} resolves against process.env FIRST (CI/ad-hoc override), then the secret store —
  // so the normal case needs no shell exports; the store is daemon-independent (no env-inheritance trap)
  const lookup = { ...readSecrets(), ...process.env };
  const exp = (v: string) => expandEnv(v, lookup);
  const servers: Record<string, ServerCfg> = {};
  for (const [name, s0] of Object.entries(raw.servers ?? {})) {
    const s: ServerCfg = structuredClone(s0);
    if (!s.command && !s.url)
      throw new Error(`server "${name}": needs "command" (stdio) or "url" (http) — fix ${p}`);
    if (s.url) s.url = exp(s.url);
    s.args = s.args?.map(exp);
    for (const rec of [s.env, s.headers])
      if (rec) for (const k of Object.keys(rec)) rec[k] = exp(rec[k]!);
    servers[name] = s;
  }
  return { servers };
}
