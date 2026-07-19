import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-"));
const env = { ...process.env, MCPMUX_CONFIG: join(dir, "servers.jsonc"), MCPMUX_SECRETS: join(dir, "secrets.json") };
// a "present" tool (node) and a "missing" one; run echoes args + an env var
writeFileSync(env.MCPMUX_CONFIG, JSON.stringify({
  servers: {},
  tools: {
    say: { run: process.execPath, args: ["-e", "console.log(process.argv.slice(1).join(' ')+':'+(process.env.MUX_MARK??''))"], env: { MUX_MARK: "wrapped" }, check: `${process.execPath} -v`, note: "echo tool" },
    ghost: { run: "definitely-not-installed-xyz", check: "definitely-not-installed-xyz --version", note: "missing tool" },
  },
}));

async function mux(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("run passes args through, applies env/wrapping, forwards exit code", async () => {
  const r = await mux("run", "say", "hello", "world");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("hello world:wrapped"); // args passed + env applied
});

test("run forwards a non-zero exit code", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "mux-"));
  const env2 = { ...env, MCPMUX_CONFIG: join(dir2, "c.jsonc") };
  writeFileSync(env2.MCPMUX_CONFIG, JSON.stringify({ servers: {}, tools: { fail: { run: process.execPath, args: ["-e", "process.exit(3)"] } } }));
  const p = Bun.spawn([process.execPath, "src/main.ts", "run", "fail"], { env: env2, stdout: "pipe", stderr: "pipe" });
  expect(await p.exited).toBe(3);
});

test("run unknown tool exits 1 and names known tools", async () => {
  const r = await mux("run", "nope");
  expect(r.code).toBe(1);
  expect(r.err).toContain("say"); // suggests what exists
});

test("tool status reports installed vs missing", async () => {
  const r = await mux("tool", "status");
  expect(r.out).toMatch(/say.*(ok|installed|✓)/i);
  expect(r.out).toMatch(/ghost.*(missing|not|✗)/i);
});

test("index includes CLI tools alongside servers", async () => {
  const r = await mux("index");
  expect(r.out).toContain("say");
  expect(r.out).toContain("mux run"); // tells the agent how to invoke them
});
