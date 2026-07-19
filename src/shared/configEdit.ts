import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, type Config, type ServerCfg } from "./config";
import { setSecret } from "./secrets";
import { stripJsonc } from "./util";

/** RAW config — no env expansion. Mutations must never bake expanded secrets into the file. */
function rawConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) return { servers: {} };
  return { servers: (JSON.parse(stripJsonc(readFileSync(p, "utf8"))) as Config).servers ?? {} };
}

function save(cfg: Config): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(cfg, null, 2);
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

export function removeServer(name: string): void {
  const cfg = rawConfig();
  if (!cfg.servers[name]) {
    const known = Object.keys(cfg.servers).join(", ") || "(none)";
    throw new Error(`unknown server "${name}" — configured: ${known}`);
  }
  delete cfg.servers[name];
  save(cfg);
}

/**
 * Move a server's literal env/header secret values into the secret store, replacing each with
 * a ${SERVER_KEY} reference. Values that are already ${...} references are left alone. Keeps
 * plaintext credentials out of servers.jsonc (import path N1, manual --env #26).
 */
export function externalizeSecrets(serverName: string, server: ServerCfg): ServerCfg {
  const s = structuredClone(server);
  for (const rec of [s.env, s.headers]) {
    if (!rec) continue;
    for (const [k, v] of Object.entries(rec)) {
      if (/^\$\{[\w]+\}$/.test(v)) continue; // already a reference
      const ref = `${serverName}_${k}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      setSecret(ref, v);
      rec[k] = `\${${ref}}`;
    }
  }
  return s;
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
