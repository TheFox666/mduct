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
  return { servers: raw.servers ?? {}, tools: raw.tools ?? {}, ...(raw.defaults ? { defaults: raw.defaults } : {}) }; // preserve tools + defaults across edits
}

function save(cfg: Config): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  // omit empty sections so a server-only config stays clean
  const out: Partial<Config> = { servers: cfg.servers };
  if (Object.keys(cfg.tools ?? {}).length) out.tools = cfg.tools;
  if (cfg.defaults && Object.keys(cfg.defaults).length) out.defaults = cfg.defaults;
  const body = JSON.stringify(out, null, 2);
  // atomic write: a crash mid-write must not corrupt the config (and the daemon watcher
  // must never read a half-written file) (#18)
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `// managed by mcpmux — edits survive, comments don't (rewritten on mux add/remove)\n${body}\n`);
  renameSync(tmp, p);
}

/** Set (or clear, with undefined) a per-instance default like `compact`. */
export function setDefault(key: "compact", value: boolean | undefined): void {
  const cfg = rawConfig();
  cfg.defaults ??= {};
  if (value === undefined) delete cfg.defaults[key];
  else cfg.defaults[key] = value;
  save(cfg);
}

export function addServer(name: string, server: ServerCfg, opts: { replace?: boolean } = {}): void {
  const cfg = rawConfig();
  if (cfg.servers[name] && !opts.replace)
    throw new Error(`server "${name}" exists — use --replace to overwrite, or mux remove ${name} first`);
  cfg.servers[name] = server;
  save(cfg);
}

/** Re-pin an npm-backed tool: replace `pkg@oldVer` with `pkg@newVer` across run/args/check/setup. */
export function updateToolPin(name: string, pkg: string, oldVer: string, newVer: string): void {
  const cfg = rawConfig();
  const t = cfg.tools[name];
  if (!t) throw new Error(`unknown tool "${name}"`);
  const swap = (s: string) => s.split(`${pkg}@${oldVer}`).join(`${pkg}@${newVer}`);
  t.run = swap(t.run);
  if (t.args) t.args = t.args.map(swap);
  if (t.check) t.check = swap(t.check);
  if (t.setup) t.setup = swap(t.setup);
  cfg.tools[name] = t;
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

// Keys that hold credentials — only these move to the secret store. Wrapping/config env like
// PATH, NODE_PATH, HOST, URL stay LITERAL (not secrets; moving them pollutes the store + breaks
// nested ${refs}). Long words match as substrings; short ambiguous ones (PAT, KEY, PW) only as a
// whole underscore-separated segment so NODE_PATH (segment "PATH") is NOT mistaken for "PAT".
const SECRET_WORDS = ["TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "APIKEY", "PRIVATEKEY"];
const SECRET_SEGMENTS = new Set(["PAT", "KEY", "AUTH", "PW", "APIKEY"]);
function isSecretKey(k: string): boolean {
  const up = k.toUpperCase();
  if (SECRET_WORDS.some((w) => up.includes(w))) return true;
  return up.split(/[^A-Z0-9]+/).some((seg) => SECRET_SEGMENTS.has(seg));
}

/**
 * Move literal values of SECRET-looking env/header keys into the secret store, replacing each
 * with a ${NAME_KEY} reference. Values already written as ${...} references, and non-secret
 * keys, are left alone. Keeps plaintext credentials out of servers.jsonc (N1, #26).
 */
function externalizeRecord(owner: string, rec: Record<string, string> | undefined, isHeader = false): void {
  if (!rec) return;
  for (const [k, v] of Object.entries(rec)) {
    if (/\$\{[\w]+\}/.test(v)) continue; // already contains a reference — leave it
    if (!isHeader && !isSecretKey(k)) continue; // env: only credential-looking keys
    const ref = `${owner}_${k}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    setSecret(ref, v);
    rec[k] = `\${${ref}}`;
  }
}

export function externalizeSecrets(serverName: string, server: ServerCfg): ServerCfg {
  const s = structuredClone(server);
  externalizeRecord(serverName, s.env);
  externalizeRecord(serverName, s.headers, true); // headers (Authorization: Bearer …) are always sensitive
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
