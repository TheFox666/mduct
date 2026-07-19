import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, type Config, type ServerCfg, type ToolCfg } from "./config";
import { setSecret } from "./secrets";
import { stripJsonc } from "./util";

/** RAW config — no env expansion. Mutations must never bake expanded secrets into the file. */
function rawConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) return { servers: {}, tools: {} };
  const raw = JSON.parse(stripJsonc(readFileSync(p, "utf8"))) as Config;
  return { servers: raw.servers ?? {}, tools: raw.tools ?? {} }; // preserve tools across server edits
}

function save(cfg: Config): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  // omit an empty tools section so a server-only config stays clean
  const out: Partial<Config> = { servers: cfg.servers };
  if (Object.keys(cfg.tools ?? {}).length) out.tools = cfg.tools;
  const body = JSON.stringify(out, null, 2);
  // atomic write: a crash mid-write must not corrupt the config (and the daemon watcher
  // must never read a half-written file) (#18)
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `// managed by mcpmux — edits survive, comments don't (rewritten on mux add/remove)\n${body}\n`);
  renameSync(tmp, p);
}

export function addServer(name: string, server: ServerCfg, opts: { replace?: boolean } = {}): void {
  const cfg = rawConfig();
  if (cfg.servers[name] && !opts.replace)
    throw new Error(`server "${name}" exists — use --replace to overwrite, or mux remove ${name} first`);
  cfg.servers[name] = server;
  save(cfg);
}

export function addTool(name: string, tool: ToolCfg, opts: { replace?: boolean } = {}): void {
  const cfg = rawConfig();
  if (cfg.tools[name] && !opts.replace)
    throw new Error(`tool "${name}" exists — use --replace to overwrite, or mux remove ${name} first`);
  cfg.tools[name] = tool;
  save(cfg);
}

/** Remove a server OR a tool by name (they share the `mux remove` command and one namespace). */
export function removeServer(name: string): void {
  const cfg = rawConfig();
  if (cfg.servers[name]) delete cfg.servers[name];
  else if (cfg.tools[name]) delete cfg.tools[name];
  else {
    const known = [...Object.keys(cfg.servers), ...Object.keys(cfg.tools)].join(", ") || "(none)";
    throw new Error(`unknown server "${name}" — configured: ${known}`);
  }
  save(cfg);
}

/**
 * Move literal values of an env/header record into the secret store, replacing each with a
 * ${NAME_KEY} reference. Values already written as ${...} references are left alone. Keeps
 * plaintext credentials out of servers.jsonc (import path N1, manual --env #26).
 */
function externalizeRecord(owner: string, rec: Record<string, string> | undefined): void {
  if (!rec) return;
  for (const [k, v] of Object.entries(rec)) {
    if (/^\$\{[\w]+\}$/.test(v)) continue; // already a reference
    const ref = `${owner}_${k}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    setSecret(ref, v);
    rec[k] = `\${${ref}}`;
  }
}

export function externalizeSecrets(serverName: string, server: ServerCfg): ServerCfg {
  const s = structuredClone(server);
  externalizeRecord(serverName, s.env);
  externalizeRecord(serverName, s.headers);
  return s;
}

export function externalizeToolSecrets(toolName: string, tool: ToolCfg): ToolCfg {
  const t = structuredClone(tool);
  externalizeRecord(toolName, t.env);
  return t;
}

export function setDisabled(name: string, disabled: boolean): void {
  const cfg = rawConfig();
  const s = cfg.servers[name];
  if (!s) {
    const known = Object.keys(cfg.servers).join(", ") || "(none)";
    throw new Error(`unknown server "${name}" — configured: ${known}`);
  }
  if (disabled) s.disabled = true;
  else delete s.disabled;
  save(cfg);
}
