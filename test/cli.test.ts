import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-"));
const env = {
  ...process.env,
  MCPMUX_SOCKET: join(dir, "d.sock"),
  MCPMUX_CONFIG: join(dir, "servers.jsonc"),
};
writeFileSync(env.MCPMUX_CONFIG!, JSON.stringify({
  servers: { fix: { command: process.execPath, args: ["test/fixture-server.ts"], note: "test fixture" } },
}));

async function mux(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

afterAll(async () => { await mux("daemon", "--stop"); });

test("call autostarts daemon and prints text content", async () => {
  const r = await mux("call", "fix", "echo", "text=hello");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("hello");
});

test("unknown tool → error suggests near tools + list command", async () => {
  const r = await mux("call", "fix", "ech"); // typo for echo
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/no tool "ech" on "fix"/);
  expect(r.err).toMatch(/did you mean: echo/);
});

test("--args - reads JSON args from stdin (heredoc-friendly, no shell quoting)", async () => {
  const p = Bun.spawn([process.execPath, "src/main.ts", "call", "fix", "echo", "--args", "-"], {
    env, stdin: new Response('{"text":"from stdin"}'), stdout: "pipe", stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  expect(code).toBe(0);
  expect(out.trim()).toBe("from stdin");
});

test("--args json wins for nested payloads", async () => {
  const r = await mux("call", "fix", "echo", "--args", '{"text":"json way"}');
  expect(r.out.trim()).toBe("json way");
});

test("tool error → stderr + exit 1", async () => {
  const r = await mux("call", "fix", "boom");
  expect(r.code).toBe(1);
  expect(r.err).toContain("kaboom");
});

test("tools prints compact lines with arg signatures", async () => {
  const r = await mux("tools", "fix");
  expect(r.out).toMatch(/echo\(text\)\s+— echoes text back/); // signature up front
  expect(r.out).toMatch(/sleep\(ms\)/);
});

test("index prints one line per server with note", async () => {
  const r = await mux("index");
  expect(r.out).toContain("fix");
  expect(r.out).toContain("test fixture");
});

test("unknown server error names the fix", async () => {
  const r = await mux("call", "nope", "x");
  expect(r.code).toBe(1);
  expect(r.err).toContain('unknown server "nope"');
});
