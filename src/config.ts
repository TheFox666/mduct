import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  const servers: Record<string, ServerCfg> = {};
  for (const [name, s0] of Object.entries(raw.servers ?? {})) {
    const s: ServerCfg = structuredClone(s0);
    if (!s.command && !s.url)
      throw new Error(`server "${name}": needs "command" (stdio) or "url" (http) — fix ${p}`);
    if (s.url) s.url = expandEnv(s.url);
    s.args = s.args?.map((a) => expandEnv(a));
    for (const rec of [s.env, s.headers])
      if (rec) for (const k of Object.keys(rec)) rec[k] = expandEnv(rec[k]!);
    servers[name] = s;
  }
  return { servers };
}
