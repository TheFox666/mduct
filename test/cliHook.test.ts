import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mduct-"));
const settings = join(dir, "settings.json");
writeFileSync(settings, JSON.stringify({ model: "opus" })); // pre-existing user settings survive
const env = { ...process.env, MDUCT_CONFIG: join(dir, "servers.jsonc"), MDUCT_CLAUDE_MCP_CONFIG: join(dir, ".claude.json") };
writeFileSync(env.MDUCT_CONFIG!, JSON.stringify({
  servers: { fix: { command: process.execPath, args: ["test/fixture-server.ts"], note: "fixture" } },
}));

async function mduct(stdin: string | null, ...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], {
    env, stdout: "pipe", stderr: "pipe", stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("hook run pre-tool-use denies mduct-served MCP tools with replacement", async () => {
  const r = await mduct(JSON.stringify({ tool_name: "mcp__fix__echo" }), "hook", "run", "pre-tool-use");
  expect(r.code).toBe(0);
  const decision = JSON.parse(r.out);
  expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("mduct call fix echo");
});

test("hook run pre-tool-use stays silent for non-mduct and non-mcp tools", async () => {
  const a = await mduct(JSON.stringify({ tool_name: "mcp__unknown__x" }), "hook", "run", "pre-tool-use");
  expect(a.code).toBe(0);
  expect(a.out.trim()).toBe("");
  const b = await mduct(JSON.stringify({ tool_name: "Bash" }), "hook", "run", "pre-tool-use");
  expect(b.out.trim()).toBe("");
});

test("hook run session-start prints the index", async () => {
  const r = await mduct(null, "hook", "run", "session-start");
  expect(r.code).toBe(0);
  expect(r.out).toContain("mduct call <server> <tool>");
  expect(r.out).toContain("fix");
});

test("hook install patches settings idempotently; --remove reverts", async () => {
  const r = await mduct(null, "hook", "install", "claude", "--settings", settings);
  expect(r.code).toBe(0);
  await mduct(null, "hook", "install", "claude", "--settings", settings); // second install
  const s = JSON.parse(readFileSync(settings, "utf8"));
  expect(s.model).toBe("opus"); // untouched
  expect(s.hooks.SessionStart).toHaveLength(1); // no duplicates
  expect(s.hooks.PreToolUse).toHaveLength(1);
  expect(JSON.stringify(s.hooks)).toContain("hook run session-start");
  const rm = await mduct(null, "hook", "install", "claude", "--settings", settings, "--remove");
  expect(rm.code).toBe(0);
  const s2 = JSON.parse(readFileSync(settings, "utf8"));
  expect(s2.hooks?.SessionStart ?? []).toHaveLength(0);
});

describe("hook install also registers the MCP catalogue", () => {
  const d = mkdtempSync(join(tmpdir(), "mduct-mcpreg-"));
  const settings = join(d, "settings.json");
  const claudeJson = join(d, ".claude.json");
  const cfgPath = join(d, "servers.jsonc");
  const base = { ...process.env, MDUCT_CONFIG: cfgPath, MDUCT_CLAUDE_MCP_CONFIG: claudeJson };
  const write = (mcpCatalog: boolean) =>
    writeFileSync(cfgPath, JSON.stringify({ servers: { kb: { command: "true", ...(mcpCatalog ? { mcpCatalog: true } : {}) } } }));
  const install = async (...extra: string[]) => {
    const p = Bun.spawn([process.execPath, "src/main.ts", "hook", "install", "claude", "--settings", settings, ...extra],
      { env: base, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  };
  const registered = () => {
    const j = JSON.parse(readFileSync(claudeJson, "utf8")) as { mcpServers?: Record<string, { args?: string[] }> };
    return j.mcpServers?.mduct;
  };

  test("a config with mcpCatalog gets the server registered, in the right file", async () => {
    writeFileSync(claudeJson, JSON.stringify({ existingKey: "must survive", mcpServers: { other: { command: "x" } } }));
    write(true);
    const out = await install();
    expect(out).toContain("registered the mduct MCP catalogue");
    // compiled binary → ["mcp"]; from source → [".../main.ts", "mcp"]. The invariant is the verb.
    expect(registered()!.args!.at(-1)).toBe("mcp");
    const j = JSON.parse(readFileSync(claudeJson, "utf8"));
    expect(j.existingKey).toBe("must survive");   // Claude's own config is not ours to rewrite
    expect(j.mcpServers.other).toBeDefined();     // nor anyone else's server
  }, 30_000);

  test("--remove takes it back out and leaves the rest alone", async () => {
    const out = await install("--remove");
    expect(out).toContain("removed the mduct MCP catalogue");
    expect(registered()).toBeUndefined();
    expect(JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers.other).toBeDefined();
  }, 30_000);

  test("no server opted in → nothing is registered", async () => {
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }));
    write(false);
    await install();
    expect(registered()).toBeUndefined();
  }, 30_000);

  test("an install from a config WITHOUT a catalogue leaves an existing registration alone", async () => {
    // the bug this pins: the test suite ran `hook install` against temp configs and silently
    // unregistered the real catalogue, because "no catalogue here" was read as "remove it"
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { mduct: { command: "/somewhere/mduct", args: ["mcp"] } } }));
    write(false);
    await install();
    expect(registered()).toBeDefined();
    // ...and --remove is still the way to actually get rid of it
    await install("--remove");
    expect(registered()).toBeUndefined();
  }, 30_000);
});
