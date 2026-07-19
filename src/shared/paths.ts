import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Instance path resolution. A named instance is selected with MCPMUX_PROFILE and lives under
 * ~/.config/mcpmux-<profile>/ (config, secrets, auth) with its own socket — mirroring Claude's
 * ~/.claude vs ~/.claude-agent-office. No profile → the default ~/.config/mcpmux/. Running a
 * second isolated daemon is thus ONE env var (MCPMUX_PROFILE=office), not three paths.
 *
 * The explicit MCPMUX_CONFIG / MCPMUX_SECRETS / MCPMUX_SOCKET overrides still win (used by tests
 * and any bespoke wiring); the profile just derives sensible defaults.
 */
function profileSuffix(): string {
  const p = process.env.MCPMUX_PROFILE?.trim();
  return p ? `-${p}` : "";
}

/** Base dir for the active instance: ~/.config/mcpmux[-<profile>]. */
export function configDir(): string {
  return join(homedir(), ".config", `mcpmux${profileSuffix()}`);
}

export function configPath(): string {
  return process.env.MCPMUX_CONFIG ?? join(configDir(), "servers.jsonc");
}

export function secretsPath(): string {
  return process.env.MCPMUX_SECRETS ?? join(configDir(), "secrets.json");
}

export function authDir(): string {
  return join(configDir(), "auth");
}

export function socketPath(): string {
  if (process.env.MCPMUX_SOCKET) return process.env.MCPMUX_SOCKET;
  const run = process.env.XDG_RUNTIME_DIR ?? join(homedir(), ".cache", "mcpmux");
  return join(run, `mcpmux${profileSuffix()}.sock`);
}
