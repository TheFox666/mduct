import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mduct-"));
const env = { ...process.env, MDUCT_CONFIG: join(dir, "servers.jsonc"), MDUCT_SECRETS: join(dir, "secrets.json") };
// a "present" tool (node) and a "missing" one; run echoes args + an env var
writeFileSync(env.MDUCT_CONFIG, JSON.stringify({
  servers: {},
  tools: {
    say: { run: process.execPath, args: ["-e", "console.log(process.argv.slice(1).join(' ')+':'+(process.env.MUX_MARK??''))"], env: { MUX_MARK: "wrapped" }, check: `${process.execPath} -v`, note: "echo tool" },
    ghost: { run: "definitely-not-installed-xyz", check: "definitely-not-installed-xyz --version", note: "missing tool" },
  },
}));

async function mduct(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("run passes args through, applies env/wrapping, forwards exit code", async () => {
  const r = await mduct("run", "say", "hello", "world");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("hello world:wrapped"); // args passed + env applied
});

test("run forwards a non-zero exit code", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "mduct-"));
  const env2 = { ...env, MDUCT_CONFIG: join(dir2, "c.jsonc") };
  writeFileSync(env2.MDUCT_CONFIG, JSON.stringify({ servers: {}, tools: { fail: { run: process.execPath, args: ["-e", "process.exit(3)"] } } }));
  const p = Bun.spawn([process.execPath, "src/main.ts", "run", "fail"], { env: env2, stdout: "pipe", stderr: "pipe" });
  expect(await p.exited).toBe(3);
});

test("run unknown tool exits 1 and names known tools", async () => {
  const r = await mduct("run", "nope");
  expect(r.code).toBe(1);
  expect(r.err).toContain("say"); // suggests what exists
});

test("tool status reports installed vs missing", async () => {
  const r = await mduct("tool", "status");
  expect(r.out).toMatch(/say.*(ok|installed|✓)/i);
  expect(r.out).toMatch(/ghost.*(missing|not|✗)/i);
});

test("index includes CLI tools alongside servers", async () => {
  const r = await mduct("index");
  expect(r.out).toContain("say");
  expect(r.out).toContain("mduct run"); // tells the agent how to invoke them
});

describe("mduct tools <cliTool> — discovery for the non-MCP half", () => {
  const d = mkdtempSync(join(tmpdir(), "mduct-cli-help-"));
  const cfg = join(d, "servers.jsonc");
  writeFileSync(cfg, JSON.stringify({
    servers: { srv: { command: "true" } },
    // `echo --help` prints "--help" and exits 0: enough to prove the wrapper ran the right binary
    tools: { fake: { run: "echo", args: ["SUBCOMMANDS:"], note: "a pretend tool" } },
  }));
  const env = { ...process.env, MDUCT_CONFIG: cfg, MDUCT_SOCKET: join(d, "s.sock") };
  const run = async (...argv: string[]) => {
    const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    return { out, err };
  };

  test("a CLI tool answers with its own help instead of 'unknown server'", async () => {
    const { out, err } = await run("tools", "fake");
    expect(err).toContain("a pretend tool");          // the note, so you know what it is
    expect(err).toContain("mduct run fake");          // and how to call it
    expect(out).toContain("SUBCOMMANDS:");            // the tool's own output, through its wrapper
    expect(err).not.toContain("unknown server");
  }, 30_000);

  // `tools <name>` falls through to the daemon when no CLI tool matches, which autostarts one on
  // this block's own socket. Nothing else stops it, and it outlives the whole run.
  afterAll(async () => { await run("daemon", "--stop"); });

  test("a name that is neither names both kinds, not just servers", async () => {
    const { err } = await run("tools", "nope");
    expect(err).toContain("unknown server");
    expect(err).toContain("srv");                     // the servers
    expect(err).toContain("fake");                    // ...and the CLI tools it would otherwise hide
  }, 30_000);
});

describe("lib — a CLI tool that also exposes a library", () => {
  const d = mkdtempSync(join(tmpdir(), "mduct-lib-"));
  const cfg = join(d, "servers.jsonc");
  writeFileSync(cfg, JSON.stringify({
    servers: {},
    tools: {
      withlib: { run: "echo", lib: "left-pad@1.3.0", note: "tiny" },
      plain:   { run: "echo", env: { FOO: "bar" }, note: "no lib" },
      bare:    { run: "echo", note: "nothing at all" },
    },
  }));
  const env = { ...process.env, MDUCT_CONFIG: cfg, MDUCT_CACHE: join(d, "cache"), MDUCT_SOCKET: join(d, "s.sock") };
  const run = async (...argv: string[]) => {
    const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };

  test("setup installs the library into the tool's own directory", async () => {
    const { out, code } = await run("tool", "setup", "withlib");
    expect(code).toBe(0);
    expect(out).toContain("library ready");
    expect(existsSync(join(d, "cache", "lib", "withlib", "node_modules", "left-pad"))).toBe(true);
  }, 120_000);

  test("env exports a NODE_PATH that actually resolves the package", async () => {
    const { out } = await run("env", "withlib");
    expect(out).toMatch(/^export NODE_PATH='.*\/lib\/withlib\/node_modules'$/m);
    const nodePath = out.match(/NODE_PATH='([^']+)'/)![1]!;
    const p = Bun.spawn([process.execPath, "-e", 'require("left-pad"); console.log("resolved")'],
      { env: { ...process.env, NODE_PATH: nodePath }, stdout: "pipe" });
    expect(await new Response(p.stdout).text()).toContain("resolved");
  }, 60_000);

  test("a tool without a lib still exports its plain env, and one with nothing says so", async () => {
    const plain = await run("env", "plain");
    expect(plain.out).toContain("export FOO='bar'");
    expect(plain.out).not.toContain("NODE_PATH");
    const bare = await run("env", "bare");
    expect(bare.code).toBe(1);
    expect(bare.err).toContain("no env or lib");
  }, 30_000);
});
