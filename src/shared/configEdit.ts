import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, type Config, type ServerCfg } from "./config";
import { stripJsonc } from "./util";

/** RAW config — no env expansion. Mutations must never bake expanded secrets into the file. */
function rawConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) return { servers: {} };
  return { servers: (JSON.parse(stripJsonc(readFileSync(p, "utf8"))) as Config).servers ?? {} };
}

function save(cfg: Config): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const body = JSON.stringify(cfg, null, 2);
  writeFileSync(p, `// managed by mcpmux — edits survive, comments don't (rewritten on mux add/remove)\n${body}\n`);
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
