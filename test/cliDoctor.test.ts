import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mduct-home-"));
// Claude config that ALSO carries "fix" (overlap) and "other" (no overlap)
writeFileSync(join(home, ".claude.json"), JSON.stringify({
  mcpServers: {
    fix: { command: "whatever", args: [] },
    other: { command: "x" },
  },
}));

const dir = mkdtempSync(join(tmpdir(), "mduct-"));
const env = { ...process.env, MDUCT_SOCKET: join(dir, "d.sock"), MDUCT_CONFIG: join(dir, "servers.jsonc"), MDUCT_HOME: home };
writeFileSync(env.MDUCT_CONFIG!, JSON.stringify({
  servers: {
    fix: { command: process.execPath, args: ["test/fixture-server.ts"] },
    dead: { command: "false" },
  },
}));

async function mduct(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

afterAll(async () => { await mduct("daemon", "--stop"); });

test("overlap report works WITHOUT a daemon and does not start one (N4)", async () => {
  const r = await mduct("doctor");
  expect(r.code).toBe(0);
  expect(r.out).toContain("fix");
  expect(r.out).toContain("claude mcp remove fix");
  expect(r.out).toContain(home); // names the source
  expect(r.out).not.toContain("claude mcp remove other"); // non-overlapping not flagged
  expect(r.out).toContain("Daemon läuft nicht"); // dead-server probe skipped, no autostart
  const st = await mduct("status");
  expect(st.out).toContain("down");
}, 30_000);

test("with a daemon up, doctor reports the dead server and stays exit 0", async () => {
  await mduct("call", "fix", "echo", "text=warm"); // autostart a daemon
  const r = await mduct("doctor");
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/dead.*(unreachable|FAILED|failed)/);
}, 30_000);
