import { loadConfig, type ServerCfg } from "../shared/config";
import { configPath, secretsPath, socketPath } from "../shared/paths";
import { request } from "../shared/ipc";
import { readAuthState } from "../daemon/oauthProvider";
import pkg from "../../package.json" with { type: "json" };

/**
 * The state of an instance as DATA, for `--json`. The human readouts stay as they are; this is the
 * same facts in a shape an app can poll and render without parsing padded columns — which is the
 * only reason anything here is duplicated at all.
 */
export type AuthState =
  | "n/a"           // nothing to authorize: a stdio child, or an http server with a static header
  | "unauthorized"  // OAuth configured, no tokens stored yet → a human must sign in
  | "valid"         // tokens stored, access token not past its expiry (or the server sends none)
  | "refreshable"   // access token lapsed, refresh token present → the daemon renews it on the next call
  | "expired";      // lapsed with nothing to refresh from → a human must sign in again

export type AuthInfo = {
  kind: "none" | "headers" | "oauth";
  state: AuthState;
  /** ISO stamp when the access token lapses; null when unknown (no expires_in) or not applicable. */
  expiresAt: string | null;
  /** The command that fixes it, when a human has to act. null while nothing is needed. */
  fix: string | null;
};

export type ServerState = {
  name: string;
  transport: "stdio" | "http";
  /**
   * The three states the text output has always shown. `idle` is the RESTING state — a healthy
   * server with no session open right now, because nothing called it yet or the daemon's idle
   * sweep closed it. Rendering "not connected" as a fault would flag a whole idle instance as
   * broken, which is why this field exists next to the boolean.
   */
  state: "connected" | "idle" | "disabled";
  enabled: boolean;
  /** A live MCP session right now. False whenever the daemon is down — nothing is connected then. */
  connected: boolean;
  note: string | null;
  auth: AuthInfo;
};

export type InstanceState = {
  version: string;
  /** MDUCT_PROFILE, or null for the default instance. */
  profile: string | null;
  daemon: { up: boolean; socket: string };
  config: string;
  secrets: string;
  servers: ServerState[];
};

function authInfo(name: string, cfg: ServerCfg): AuthInfo {
  if (cfg.auth !== "oauth")
    return { kind: cfg.headers ? "headers" : "none", state: "n/a", expiresAt: null, fix: null };
  const { hasTokens, expiresAt, canRefresh } = readAuthState(name);
  const signIn = `mduct auth ${name}`;
  if (!hasTokens) return { kind: "oauth", state: "unauthorized", expiresAt: null, fix: signIn };
  const lapsed = expiresAt != null && expiresAt <= Date.now();
  const state: AuthState = !lapsed ? "valid" : canRefresh ? "refreshable" : "expired";
  return {
    kind: "oauth",
    state,
    expiresAt: expiresAt != null ? new Date(expiresAt).toISOString() : null,
    fix: state === "expired" ? signIn : null,
  };
}

/**
 * Which servers hold a live session. Deliberately NOT the autostarting `daemonRequest` the other
 * commands use: an app polling for state must never be the thing that spawns a daemon. Down →
 * null, and every server reads as disconnected, which is the truth.
 */
async function connectedNames(): Promise<Set<string> | null> {
  try {
    const list = (await request(socketPath(), "servers", {}, 1500)) as { name: string; connected: boolean }[];
    return new Set(list.filter((s) => s.connected).map((s) => s.name));
  } catch {
    return null;
  }
}

export async function collectState(): Promise<InstanceState> {
  const cfg = loadConfig();
  const live = await connectedNames();
  return {
    version: (pkg as { version: string }).version,
    profile: process.env.MDUCT_PROFILE?.trim() || null,
    daemon: { up: live !== null, socket: socketPath() },
    config: configPath(),
    secrets: secretsPath(),
    servers: Object.entries(cfg.servers).map(([name, s]) => {
      const connected = live?.has(name) ?? false;
      return {
        name,
        transport: s.command ? "stdio" : "http",
        state: s.disabled ? "disabled" : connected ? "connected" : "idle",
        enabled: !s.disabled,
        connected,
        note: s.note ?? null,
        auth: authInfo(name, s),
      };
    }),
  };
}
