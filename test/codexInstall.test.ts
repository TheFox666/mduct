import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBlock, codexConfigPath, renderBlock } from "../src/cli/codex";
import { loadConfig } from "../src/shared/config";

const dir = mkdtempSync(join(tmpdir(), "mduct-codex-"));
const cfgPath = join(dir, "servers.jsonc");
// in-process calls read the same env as the spawned ones — otherwise they silently test the real
// config. bun runs every test FILE in one process, so put it back afterwards or the next file
// inherits it (it did: cliShadow started reading this fixture's Codex path).
const savedEnv = { cfg: process.env.MDUCT_CONFIG, codex: process.env.MDUCT_CODEX_CONFIG };
process.env.MDUCT_CONFIG = cfgPath;
process.env.MDUCT_CODEX_CONFIG = join(dir, "config.toml");
afterAll(() => {
  for (const [k, v] of [["MDUCT_CONFIG", savedEnv.cfg], ["MDUCT_CODEX_CONFIG", savedEnv.codex]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
writeFileSync(cfgPath, JSON.stringify({
  servers: {
    kb: { command: "true", mcpCatalog: true, shadow: [{ tool: ["Grep"], bash: "grep", pathIn: [dir], hint: "ask kb" }] },
  },
}));

function run(toml: string, ...argv: string[]) {
  writeFileSync(join(dir, "config.toml"), toml);
  const p = Bun.spawnSync([process.execPath, "src/main.ts", "hook", "install", "codex", ...argv], {
    env: { ...process.env, MDUCT_CONFIG: cfgPath, MDUCT_CODEX_CONFIG: join(dir, "config.toml") },
  });
  return {
    code: p.exitCode,
    err: p.stderr.toString(),
    toml: readFileSync(join(dir, "config.toml"), "utf8"),
  };
}

test("writes hooks and the catalogue, leaving foreign tables alone", () => {
  const r = run(`model = "gpt-5"\n\n[mcp_servers.filesystem]\ncommand = "npx"\n`);
  expect(r.code).toBe(0);
  expect(r.toml).toContain(`model = "gpt-5"`);
  expect(r.toml).toContain("[mcp_servers.filesystem]");
  expect(r.toml).toContain("[[hooks.SessionStart]]");
  expect(r.toml).toContain("[[hooks.PreToolUse]]");
  expect(r.toml).toContain("[mcp_servers.mduct]");
  expect(r.toml).toContain("hook run pre-tool-use");
});

test("the matcher covers Codex's shell tools, not only Claude's Bash", () => {
  const m = renderBlock(loadConfig()).match(/matcher = "(.*)"/)![1];
  expect(m).toContain("shell_command");
  expect(m).toContain("exec_command");
  expect(m).toContain("mcp__.*");
  expect(m).toContain("Grep"); // a shadow rule's own tool list still reaches the matcher
});

test("re-installing replaces the block instead of stacking a second one", () => {
  const first = run("").toml;
  writeFileSync(join(dir, "config.toml"), first);
  const p = Bun.spawnSync([process.execPath, "src/main.ts", "hook", "install", "codex"], {
    env: { ...process.env, MDUCT_CONFIG: cfgPath, MDUCT_CODEX_CONFIG: join(dir, "config.toml") },
  });
  expect(p.exitCode).toBe(0);
  const twice = readFileSync(join(dir, "config.toml"), "utf8");
  expect(twice.match(/\[\[hooks\.SessionStart\]\]/g)!.length).toBe(1);
  expect(twice).toBe(first);
});

test("--remove takes ours out and nothing else", () => {
  const before = `model = "gpt-5"\n\n[mcp_servers.filesystem]\ncommand = "npx"\n`;
  const installed = run(before).toml;
  writeFileSync(join(dir, "config.toml"), installed);
  const p = Bun.spawnSync([process.execPath, "src/main.ts", "hook", "install", "codex", "--remove"], {
    env: { ...process.env, MDUCT_CONFIG: cfgPath, MDUCT_CODEX_CONFIG: join(dir, "config.toml") },
  });
  expect(p.exitCode).toBe(0);
  const after = readFileSync(join(dir, "config.toml"), "utf8");
  expect(after).not.toContain("mduct managed");
  expect(after).not.toContain("hooks.PreToolUse");
  expect(after.trim()).toBe(before.trim());
});

test("refuses rather than producing a config TOML would reject", () => {
  const r = run(`[mcp_servers.mduct]\ncommand = "something-else"\n`);
  expect(r.code).toBe(1);
  expect(r.err).toContain("[mcp_servers.mduct]");
  expect(r.toml).not.toContain("mduct managed"); // the file is untouched on refusal
});

test("no catalogued server means no MCP registration", () => {
  const bare = join(dir, "bare.jsonc");
  writeFileSync(bare, JSON.stringify({ servers: { kb: { command: "true" } } }));
  process.env.MDUCT_CONFIG = bare;
  try { expect(renderBlock(loadConfig())).not.toContain("[mcp_servers.mduct]"); }
  finally { process.env.MDUCT_CONFIG = cfgPath; }
});

test("the default path is the harness's own, and the sandbox is not the real home", () => {
  expect(codexConfigPath()).toBe(join(dir, "config.toml"));
  const clean = { ...process.env };
  delete clean.MDUCT_CODEX_CONFIG;
  const p = Bun.spawnSync([process.execPath, "-e", "import('./src/cli/codex').then(m => console.log(m.codexConfigPath()))"], { env: clean });
  const fallback = p.stdout.toString().trim();
  expect(fallback).toBe(join(process.env.HOME!, ".codex", "config.toml"));
  expect(fallback.startsWith(process.env.MDUCT_TEST_REAL_HOME!)).toBe(false); // the point of the sandbox
});

test("applyBlock on a file that has no block is a plain append", () => {
  expect(applyBlock("a = 1\n", "BLOCK\n")).toBe("a = 1\n\nBLOCK\n");
  expect(applyBlock("", "BLOCK\n")).toBe("BLOCK\n");
});

test("a Codex-shaped payload nudges: argv array, shell_command, cmd field", async () => {
  const call = (tool_name: string, tool_input: unknown) => {
    const p = Bun.spawnSync([process.execPath, "src/main.ts", "hook", "run", "pre-tool-use"], {
      env: { ...process.env, MDUCT_CONFIG: cfgPath, MDUCT_HOME: dir, MDUCT_CACHE: join(dir, "cache") },
      stdin: new TextEncoder().encode(JSON.stringify({ tool_name, tool_input, cwd: dir, session_id: `s-${tool_name}` })),
    });
    return p.stdout.toString();
  };
  expect(call("shell_command", { command: ["bash", "-lc", `grep -r foo ${dir}`] })).toContain("ask kb");
  expect(call("exec_command", { cmd: `grep -r foo ${dir}` })).toContain("ask kb");
  expect(call("Bash", { command: `grep -r foo ${dir}` })).toContain("ask kb");
});

test("the drift warning also reads the Codex block when Claude has no hook", () => {
  const settings = join(dir, "empty-settings.json");
  writeFileSync(settings, "{}");
  const sessionStart = (codexToml: string) => {
    writeFileSync(join(dir, "config.toml"), codexToml);
    return Bun.spawnSync([process.execPath, "src/main.ts", "hook", "run", "session-start"], {
      env: {
        ...process.env, MDUCT_CONFIG: cfgPath, MDUCT_HOME: dir, MDUCT_CACHE: join(dir, "cache"),
        MDUCT_CLAUDE_SETTINGS: settings, MDUCT_CODEX_CONFIG: join(dir, "config.toml"),
      },
    }).stdout.toString();
  };
  // installed and current → quiet
  const good = run("").toml;
  expect(sessionStart(good)).not.toContain("does not cover them");
  // installed but the matcher no longer covers the rules → warn
  expect(sessionStart(good.replace(/matcher = "[^"]*"/, 'matcher = "mcp__.*"'))).toContain("does not cover them");
});
