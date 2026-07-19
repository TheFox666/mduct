import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mux-home-"));
// Claude config that ALSO carries "fix" (overlap) and "other" (no overlap)
writeFileSync(join(home, ".claude.json"), JSON.stringify({
  mcpServers: {
    fix: { command: "whatever", args: [] },
    other: { command: "x" },
  },
}));

const dir = mkdtempSync(join(tmpdir(), "mux-"));
const env = { ...process.env, MCPMUX_SOCKET: join(dir, "d.sock"), MCPMUX_CONFIG: join(dir, "servers.jsonc"), MCPMUX_HOME: home };
writeFileSync(env.MCPMUX_CONFIG!, JSON.stringify({
  servers: {
    fix: { command: process.execPath, args: ["test/fixture-server.ts"] },
    dead: { command: "false" },
  },
}));

async function mux(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

afterAll(async () => { await mux("daemon", "--stop"); });

test("doctor reports overlap with removal hint, dead server, and stays exit 0", async () => {
  const r = await mux("doctor");
  expect(r.code).toBe(0);
  // overlap section: fix is in a Claude config AND mux-served
  expect(r.out).toContain("fix");
  expect(r.out).toContain("claude mcp remove fix");
  expect(r.out).toContain(home); // names the source
  // non-overlapping claude server is NOT flagged
  expect(r.out).not.toContain("claude mcp remove other");
  // dead server section
  expect(r.out).toMatch(/dead.*(unreachable|FAILED|failed)/);
}, 30_000);
