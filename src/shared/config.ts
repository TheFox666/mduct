import { existsSync, readFileSync } from "node:fs";
import { configPath } from "./paths";
import { read as readSecrets } from "./secrets";
import { expandEnv, stripJsonc } from "./util";

export { configPath } from "./paths"; // re-export so existing `from "./config"` imports keep working

export type ServerCfg = {
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>; auth?: "oauth";
  guard?: { allow?: string[]; deny?: string[] };
  idleTtlMin?: number; note?: string; disabled?: boolean;
};
/** A CLI capability (playwright, kubectl, aws): invoked via `mux run <name>` with its env/wrapping. */
export type ToolCfg = {
  run: string; args?: string[]; env?: Record<string, string>;
  check?: string; setup?: string; note?: string; disabled?: boolean;
};
export type Config = { servers: Record<string, ServerCfg>; tools: Record<string, ToolCfg> };

export function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) return { servers: {}, tools: {} };
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
  const tools: Record<string, ToolCfg> = {};
  for (const [name, t0] of Object.entries(raw.tools ?? {})) {
    const t: ToolCfg = structuredClone(t0);
    if (!t.run) throw new Error(`tool "${name}": needs a "run" command — fix ${p}`);
    t.run = exp(t.run);
    t.args = t.args?.map(exp);
    if (t.env) for (const k of Object.keys(t.env)) t.env[k] = exp(t.env[k]!);
    tools[name] = t;
  }
  return { servers, tools };
}
