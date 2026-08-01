import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, type Config, type ServerCfg, type ToolCfg } from "./config";
import { read as readSecrets, setSecret } from "./secrets";
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
  // 0600: the config CAN hold a plaintext credential (a non-wordlist env key, a token in a URL, a
  // hand-edited value that externalization didn't catch), so lock it down like the secret store —
  // the 0700 dir alone doesn't help if it pre-existed 0755 (H1). mode on write + chmod belt.
  writeFileSync(tmp, `// managed by mduct — edits survive, comments don't (rewritten on mduct add/remove)\n${body}\n`, { mode: 0o600 });
  renameSync(tmp, p);
  try { chmodSync(p, 0o600); } catch { /* best effort */ }
}

// Server/tool names become JSON keys AND filesystem paths (authDir/<name>.json, tmp files). Reject
// anything that could escape the config dir — the realistic vector is `mduct import` pulling a server
// key verbatim from an untrusted repo's .mcp.json (M2). Legit names (github, my-server_2) pass.
function validateName(name: string): void {
  if (!name || name.length > 128 || name === "." || name === ".." || name.includes("..") || /[/\\\x00]/.test(name))
    throw new Error(`invalid name "${name}" — no path separators, "..", or control characters`);
}

/** Set (or clear, with undefined) a per-instance default (`compact`, `warnAbove`). */
export function setDefault(key: "compact" | "warnAbove", value: boolean | number | undefined): void {
  const cfg = rawConfig();
  cfg.defaults ??= {};
  if (value === undefined) delete cfg.defaults[key];
  else (cfg.defaults as Record<string, unknown>)[key] = value;
  save(cfg);
}

export function addServer(name: string, server: ServerCfg, opts: { replace?: boolean } = {}): void {
  validateName(name);
  const cfg = rawConfig();
  if (cfg.servers[name] && !opts.replace)
    throw new Error(`server "${name}" exists — use --replace to overwrite, or mduct remove ${name} first`);
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
  validateName(name);
  const cfg = rawConfig();
  if (cfg.tools[name] && !opts.replace)
    throw new Error(`tool "${name}" exists — use --replace to overwrite, or mduct remove ${name} first`);
  cfg.tools[name] = tool;
  save(cfg);
}

/** Remove a server OR a tool by name (they share the `mduct remove` command and one namespace). */
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
    const ref = secretRef(owner, k, v);
    setSecret(ref, v);
    rec[k] = `\${${ref}}`;
  }
}

/**
 * Name for a secret lifted out of a config: `<OWNER>_<KEY>`, minus the stutter.
 *
 * `weather` + `WEATHER_KEY` was becoming `WEATHER_WEATHER_KEY`, which nobody wants to read or
 * type. When the key already carries the owner's name, the prefix adds nothing and is dropped —
 * unless that shorter name is already taken by a DIFFERENT value, in which case the prefixed
 * form is the safe answer. Same owner and value re-importing is not a clash, it is an overwrite.
 */
export function secretRef(owner: string, key: string, value?: string): string {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const o = norm(owner), k = norm(key), full = `${o}_${k}`;
  if (!k.startsWith(o) || o.length < 2) return full;
  const existing = readSecrets()[k];
  return existing === undefined || existing === value ? k : full;
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
