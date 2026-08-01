import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mduct-"));
const env = {
  ...process.env,
  MDUCT_SOCKET: join(dir, "d.sock"),
  MDUCT_CONFIG: join(dir, "servers.jsonc"),
};

async function mduct(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("add -- command, then servers lists it", async () => {
  const r = await mduct("add", "fix", "--note", "fixture", "--", process.execPath, "test/fixture-server.ts");
  expect(r.code).toBe(0);
  const s = await mduct("servers");
  expect(s.out).toContain("fix");
  expect(s.out).toContain("fixture");
});

test("add --url variant", async () => {
  const r = await mduct("add", "web", "--url", "https://example.com/mcp");
  expect(r.code).toBe(0);
});

test("duplicate add fails with hint, --replace works", async () => {
  const r = await mduct("add", "fix", "--", "echo");
  expect(r.code).toBe(1);
  expect(r.err).toContain("--replace");
  const r2 = await mduct("add", "fix", "--replace", "--note", "neu", "--", process.execPath, "test/fixture-server.ts");
  expect(r2.code).toBe(0);
});

test("disable hides from index, enable restores", async () => {
  await mduct("disable", "web");
  let idx = await mduct("index");
  expect(idx.out).not.toContain("web");
  await mduct("enable", "web");
  idx = await mduct("index");
  expect(idx.out).toContain("web");
});

test("remove deletes; unknown remove exits 1", async () => {
  const r = await mduct("remove", "web");
  expect(r.code).toBe(0);
  const r2 = await mduct("remove", "web");
  expect(r2.code).toBe(1);
  expect(r2.err).toContain('unknown server "web"');
});
