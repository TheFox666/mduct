import { existsSync, readFileSync } from "node:fs";
import { configPath } from "./paths";
import { read as readSecrets } from "./secrets";
import { expandEnv, stripJsonc } from "./util";

export { configPath } from "./paths"; // re-export so existing `from "./config"` imports keep working

/**
 * "This call could have been mine." The server declares which other tool calls it shadows and what
 * to say instead; mduct only matches and quotes. `pathIn` narrows to where the server is useful
 * (an index only shadows greps into repos it has indexed).
 */
export type ShadowRule = {
  tool?: string[]; bash?: string; pathIn?: string[]; hint: string;
  /** Bucket capacity — how many hints may land back to back. Default 1. */
  budget?: number;
  /** Minutes to refill one hint. 0 (default) never refills: one bucket per session, as before. */
  refillMin?: number;
};
export type ServerCfg = {
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>; auth?: "oauth";
  guard?: { allow?: string[]; deny?: string[] };
  shadow?: ShadowRule[];
  /** In-flight calls allowed at once for this server. Default 1 (strictly serialised). */
  maxConcurrent?: number;
  /** Force tool signatures in/out of the index block. Default: in, when the server has few enough. */
  indexTools?: boolean;
  /** Mirror this server's tools into the `mduct mcp` catalogue, so their names sit in the agent's
   *  tool namespace. Off by default — a 189-tool server there is the flood mduct exists to stop. */
  mcpCatalog?: boolean;
  idleTtlMin?: number; note?: string; disabled?: boolean;
};
/** A CLI capability (playwright, kubectl, aws): invoked via `mduct run <name>` with its env/wrapping. */
export type ToolCfg = {
  run: string; args?: string[]; env?: Record<string, string>;
  check?: string; setup?: string; note?: string; disabled?: boolean;
  /**
   * npm package the tool also exposes as a LIBRARY, e.g. "playwright@1.61.1". `mduct tool setup`
   * installs it into the cache dir and `mduct env <tool>` exports a NODE_PATH pointing at it — so
   * a script that needs the API, not the CLI, does not have to install anything of its own.
   */
  lib?: string;
};
/** Per-instance defaults applied to every call unless a flag overrides them. */
export type Defaults = { compact?: boolean; warnAbove?: number };
export type Config = { servers: Record<string, ServerCfg>; tools: Record<string, ToolCfg>; defaults?: Defaults };

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
    if (!s0 || typeof s0 !== "object" || Array.isArray(s0))
      throw new Error(`server "${name}": entry must be an object — fix ${p}`); // else structuredClone(null) → TypeError (L4)
    const s: ServerCfg = structuredClone(s0);
    if (!s.command && !s.url)
      throw new Error(`server "${name}": needs "command" (stdio) or "url" (http) — fix ${p}`);
    // Both set is a half-finished migration, and it used to pass silently: the connection picks
    // `command`, so the url is ignored and the config lies about which end you are talking to.
    if (s.command && s.url)
      throw new Error(`server "${name}": has BOTH "command" and "url" — a server is stdio or http, not both. Delete the one you stopped using — fix ${p}`);
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
  return { servers, tools, ...(raw.defaults ? { defaults: raw.defaults } : {}) };
}
