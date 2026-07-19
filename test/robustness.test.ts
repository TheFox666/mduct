import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function mux(env: Record<string, string | undefined>, stdin: string | null, ...argv: string[]) {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], {
    env, stdout: "pipe", stderr: "pipe", stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("hook install preserves a foreign hook that shares the same array (N5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mux-"));
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "othertool hook run its-thing" }] }],
      PreToolUse: [{ hooks: [] }], // malformed-ish entry with empty hooks array must not crash
    },
  }));
  const env = { ...process.env, MCPMUX_CONFIG: join(dir, "servers.jsonc") };
  const r = await mux(env, null, "hook", "install", "claude", "--settings", settings);
  expect(r.code).toBe(0);
  const s = JSON.parse(readFileSync(settings, "utf8"));
  expect(JSON.stringify(s)).toContain("othertool hook run its-thing"); // foreign hook survived
  const rm = await mux(env, null, "hook", "install", "claude", "--settings", settings, "--remove");
  expect(rm.code).toBe(0);
  const s2 = JSON.parse(readFileSync(settings, "utf8"));
  expect(JSON.stringify(s2)).toContain("othertool hook run its-thing"); // still there after remove
});

test("session-start hook exits 0 with a warning on a broken config (#24)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mux-"));
  const cfg = join(dir, "servers.jsonc");
  writeFileSync(cfg, "{ this is not valid json");
  const r = await mux({ ...process.env, MCPMUX_CONFIG: cfg }, null, "hook", "run", "session-start");
  expect(r.code).toBe(0); // never noise up a Claude session start
});

test("doctor does not autostart a daemon (N4)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mux-"));
  const sock = join(dir, "d.sock");
  const env = { ...process.env, MCPMUX_CONFIG: join(dir, "servers.jsonc"), MCPMUX_SOCKET: sock, MCPMUX_HOME: dir };
  writeFileSync(env.MCPMUX_CONFIG, "{\"servers\":{}}");
  const r = await mux(env, null, "doctor");
  expect(r.code).toBe(0);
  const st = await mux(env, null, "status");
  expect(st.out).toContain("down"); // doctor left no daemon behind
});
