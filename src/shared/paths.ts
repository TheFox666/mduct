import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * $HOME wins over the passwd entry, the way every unix tool resolves it — `HOME=/tmp/x cmd` is a
 * contract, not a suggestion. It also gives the test suite a real sandbox: bun caches os.homedir()
 * at process start, so a preload that sets HOME would otherwise only reach spawned children, and
 * in-process code would keep reading the developer's own config. It did, three times.
 */
export function home(): string {
  return process.env.HOME || homedir();
}

/**
 * Instance path resolution. A named instance is selected with MDUCT_PROFILE and lives under
 * ~/.config/mduct-<profile>/ (config, secrets, auth) with its own socket — mirroring Claude's
 * ~/.claude vs ~/.claude-<profile>. No profile → the default ~/.config/mduct/. Running a
 * second isolated daemon is thus ONE env var (MDUCT_PROFILE=office), not three paths.
 *
 * The explicit MDUCT_CONFIG / MDUCT_SECRETS / MDUCT_SOCKET overrides still win (used by tests
 * and any bespoke wiring); the profile just derives sensible defaults.
 */
function profileSuffix(): string {
  const p = process.env.MDUCT_PROFILE?.trim();
  return p ? `-${p}` : "";
}

/** Base dir for the active instance: ~/.config/mduct[-<profile>]. */
export function configDir(): string {
  return join(home(), ".config", `mduct${profileSuffix()}`);
}

export function configPath(): string {
  return process.env.MDUCT_CONFIG ?? join(configDir(), "servers.jsonc");
}

export function secretsPath(): string {
  return process.env.MDUCT_SECRETS ?? join(configDir(), "secrets.json");
}

export function authDir(): string {
  // always next to the active config, so an explicit MDUCT_CONFIG override keeps auth alongside it
  return join(dirname(configPath()), "auth");
}

export function socketPath(): string {
  if (process.env.MDUCT_SOCKET) return process.env.MDUCT_SOCKET;
  const run = process.env.XDG_RUNTIME_DIR ?? join(home(), ".cache", "mduct");
  return join(run, `mduct${profileSuffix()}.sock`);
}

/** Cache dir for the active instance: $MDUCT_CACHE, else ~/.cache/mduct[-<profile>]. */
export function cacheDir(): string {
  if (process.env.MDUCT_CACHE) return process.env.MDUCT_CACHE;
  const base = process.env.XDG_CACHE_HOME ?? join(home(), ".cache");
  return join(base, `mduct${profileSuffix()}`);
}
