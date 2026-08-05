import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `mduct status --json` / `mduct servers --json` — the machine-readable half of the state the CLI
 * only ever printed for humans. An app that shows "is this server connected, is its login still
 * good" had to scrape padded columns; the point of these tests is that the SHAPE is a contract.
 */

const dir = mkdtempSync(join(tmpdir(), "mduct-state-"));
const cfgFile = join(dir, "servers.jsonc");
const env = {
  ...process.env,
  MDUCT_SOCKET: join(dir, "d.sock"), // nothing listens here: the daemon is down for these tests
  MDUCT_CONFIG: cfgFile,
  MDUCT_SECRETS: join(dir, "secrets.json"),
};

writeFileSync(cfgFile, JSON.stringify({
  servers: {
    local: { command: process.execPath, args: ["test/fixture-server.ts"], note: "test fixture" },
    keyed: { url: "https://api.example.com/mcp", headers: { authorization: "Bearer x" } },
    fresh: { url: "https://fresh.example.com/mcp", auth: "oauth" },
    stale: { url: "https://stale.example.com/mcp", auth: "oauth" },
    revoked: { url: "https://revoked.example.com/mcp", auth: "oauth" },
    never: { url: "https://never.example.com/mcp", auth: "oauth" },
    off: { url: "https://off.example.com/mcp", disabled: true },
  },
}));

const HOUR = 3_600_000;
const authFile = (server: string, p: unknown) => {
  mkdirSync(join(dir, "auth"), { recursive: true });
  writeFileSync(join(dir, "auth", `${server}.json`), JSON.stringify(p));
};
// tokens carry a RELATIVE expires_in, so the saved-at stamp is what makes an expiry absolute
authFile("fresh", { savedAt: Date.now(), tokens: { access_token: "a", token_type: "Bearer", expires_in: 3600, refresh_token: "r" } });
authFile("stale", { savedAt: Date.now() - 2 * HOUR, tokens: { access_token: "a", token_type: "Bearer", expires_in: 3600, refresh_token: "r" } });
authFile("revoked", { savedAt: Date.now() - 2 * HOUR, tokens: { access_token: "a", token_type: "Bearer", expires_in: 3600 } });
// "never" gets no file at all — configured for OAuth, never signed in

type Auth = { kind: string; state: string; expiresAt: string | null; fix: string | null };
type ServerState = {
  name: string; transport: string; state: string; enabled: boolean; connected: boolean;
  note: string | null; auth: Auth;
};

async function mduct(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

const byName = (list: ServerState[]) => Object.fromEntries(list.map((s) => [s.name, s]));

// none of these commands should start a daemon; stop one anyway, so a regression here does not
// leave a stray daemon (and its MCP children) behind for the rest of the suite
afterAll(async () => { await mduct("daemon", "--stop"); });

test("servers --json is a parseable array on stdout, no prose mixed in", async () => {
  const r = await mduct("servers", "--json");
  expect(r.code).toBe(0);
  const list = JSON.parse(r.out) as ServerState[]; // throws if a header line leaked into stdout
  expect(list.map((s) => s.name).sort()).toEqual(["fresh", "keyed", "local", "never", "off", "revoked", "stale"]);
});

test("servers --json reports transport, enabled and connection state per server", async () => {
  const s = byName(JSON.parse((await mduct("servers", "--json")).out) as ServerState[]);
  expect(s.local).toMatchObject({ transport: "stdio", enabled: true, connected: false, note: "test fixture" });
  expect(s.keyed).toMatchObject({ transport: "http", enabled: true });
  expect(s.off).toMatchObject({ enabled: false, connected: false });
  expect(s.local!.note).toBe("test fixture");
  expect(s.keyed!.note).toBeNull(); // absent note is null, not undefined — a key an app can read
});

test("state names idle apart from disabled, so a dashboard doesn't paint idle as broken", async () => {
  const s = byName(JSON.parse((await mduct("servers", "--json")).out) as ServerState[]);
  // no live session and no daemon here — that is idle, the resting state, not a failure
  expect(s.local!.state).toBe("idle");
  expect(s.off!.state).toBe("disabled");
});

test("auth state distinguishes valid, refreshable, re-auth-needed and never-signed-in", async () => {
  const s = byName(JSON.parse((await mduct("servers", "--json")).out) as ServerState[]);
  expect(s.fresh!.auth).toMatchObject({ kind: "oauth", state: "valid", fix: null });
  expect(typeof s.fresh!.auth.expiresAt).toBe("string");
  // expired access token + refresh token = the daemon fixes it on the next call, no human needed
  expect(s.stale!.auth).toMatchObject({ kind: "oauth", state: "refreshable", fix: null });
  // expired and nothing to refresh with → a human must sign in again, and the command says how
  expect(s.revoked!.auth).toMatchObject({ kind: "oauth", state: "expired", fix: "mduct auth revoked" });
  expect(s.never!.auth).toMatchObject({ kind: "oauth", state: "unauthorized", fix: "mduct auth never" });
  // nothing to authorize: a stdio child, or an http server carrying a static header
  expect(s.local!.auth).toMatchObject({ kind: "none", state: "n/a" });
  expect(s.keyed!.auth).toMatchObject({ kind: "headers", state: "n/a" });
});

test("status --json reports the instance identity and a down daemon", async () => {
  const r = await mduct("status", "--json");
  expect(r.code).toBe(0);
  const st = JSON.parse(r.out) as {
    version: string; profile: string | null; daemon: { up: boolean; socket: string };
    config: string; secrets: string; servers: ServerState[];
  };
  expect(st.daemon.up).toBe(false); // no daemon on this socket, and status must not start one
  expect(st.daemon.socket).toBe(env.MDUCT_SOCKET!);
  expect(st.config).toBe(cfgFile);
  expect(st.secrets).toBe(env.MDUCT_SECRETS!);
  expect(st.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(st.profile).toBeNull();
  expect(st.servers.length).toBe(7); // the same per-server objects, so one poll answers everything
});

test("status --json does not autostart a daemon", async () => {
  await mduct("status", "--json");
  const { socketAlive } = await import("../src/shared/ipc");
  expect(await socketAlive(env.MDUCT_SOCKET!)).toBe(false);
});

test("status --json names the profile instance it answered for", async () => {
  const p = Bun.spawn([process.execPath, "src/main.ts", "status", "--json"], {
    env: { ...env, MDUCT_PROFILE: "office" }, stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  expect((JSON.parse(out) as { profile: string | null }).profile).toBe("office");
});
