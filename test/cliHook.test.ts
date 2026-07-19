import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-"));
const settings = join(dir, "settings.json");
writeFileSync(settings, JSON.stringify({ model: "opus" })); // pre-existing user settings survive
const env = { ...process.env, MCPMUX_CONFIG: join(dir, "servers.jsonc") };
writeFileSync(env.MCPMUX_CONFIG!, JSON.stringify({
  servers: { fix: { command: process.execPath, args: ["test/fixture-server.ts"], note: "fixture" } },
}));

async function mux(stdin: string | null, ...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], {
    env, stdout: "pipe", stderr: "pipe", stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("hook run pre-tool-use denies mux-served MCP tools with replacement", async () => {
  const r = await mux(JSON.stringify({ tool_name: "mcp__fix__echo" }), "hook", "run", "pre-tool-use");
  expect(r.code).toBe(0);
  const decision = JSON.parse(r.out);
  expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("mux call fix echo");
});

test("hook run pre-tool-use stays silent for non-mux and non-mcp tools", async () => {
  const a = await mux(JSON.stringify({ tool_name: "mcp__unknown__x" }), "hook", "run", "pre-tool-use");
  expect(a.code).toBe(0);
  expect(a.out.trim()).toBe("");
  const b = await mux(JSON.stringify({ tool_name: "Bash" }), "hook", "run", "pre-tool-use");
  expect(b.out.trim()).toBe("");
});

test("hook run session-start prints the index", async () => {
  const r = await mux(null, "hook", "run", "session-start");
  expect(r.code).toBe(0);
  expect(r.out).toContain("mux call <server> <tool>");
  expect(r.out).toContain("fix");
});

test("hook install patches settings idempotently; --remove reverts", async () => {
  const r = await mux(null, "hook", "install", "claude", "--settings", settings);
  expect(r.code).toBe(0);
  await mux(null, "hook", "install", "claude", "--settings", settings); // second install
  const s = JSON.parse(readFileSync(settings, "utf8"));
  expect(s.model).toBe("opus"); // untouched
  expect(s.hooks.SessionStart).toHaveLength(1); // no duplicates
  expect(s.hooks.PreToolUse).toHaveLength(1);
  expect(JSON.stringify(s.hooks)).toContain("hook run session-start");
  const rm = await mux(null, "hook", "install", "claude", "--settings", settings, "--remove");
  expect(rm.code).toBe(0);
  const s2 = JSON.parse(readFileSync(settings, "utf8"));
  expect(s2.hooks?.SessionStart ?? []).toHaveLength(0);
});
