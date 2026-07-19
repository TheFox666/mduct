import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function secretsPath(): string {
  return process.env.MCPMUX_SECRETS ?? join(homedir(), ".config", "mcpmux", "secrets.json");
}

export function read(): Record<string, string> {
  const p = secretsPath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>; } catch { return {}; }
}

function write(all: Record<string, string>): void {
  const p = secretsPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p); // atomic
  try { chmodSync(p, 0o600); } catch { /* best effort */ }
}

export function getSecret(name: string): string | undefined { return read()[name]; }
export function listSecretNames(): string[] { return Object.keys(read()).sort(); }

export function setSecret(name: string, value: string): void {
  const all = read();
  all[name] = value;
  write(all);
}

export function rmSecret(name: string): void {
  const all = read();
  delete all[name];
  write(all);
}
