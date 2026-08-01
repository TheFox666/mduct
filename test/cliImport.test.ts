import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mduct-home-"));
writeFileSync(join(home, ".claude.json"), JSON.stringify({
  mcpServers: { gitlab: { command: "npx", args: ["-y", "gitlab-mcp"] } },
}));
mkdirSync(join(home, ".claude-office"));
writeFileSync(join(home, ".claude-office", ".claude.json"), JSON.stringify({
  mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
}));

const dir = mkdtempSync(join(tmpdir(), "mduct-"));
const env = { ...process.env, MDUCT_CONFIG: join(dir, "servers.jsonc"), MDUCT_HOME: home };

async function mduct(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("import without names lists candidates as source<TAB>name<TAB>kind", async () => {
  const r = await mduct("import");
  expect(r.code).toBe(0);
  const lines = r.out.trim().split("\n");
  expect(lines.some((l) => l.includes("\tgitlab\tstdio"))).toBe(true);
  expect(lines.some((l) => l.includes("\tlinear\thttp"))).toBe(true);
});

test("import by name writes the server into mduct config", async () => {
  const r = await mduct("import", "linear");
  expect(r.code).toBe(0);
  const idx = await mduct("index");
  expect(idx.out).toContain("linear");
});

test("import unknown name exits 1 with candidates", async () => {
  const r = await mduct("import", "nope");
  expect(r.code).toBe(1);
  expect(r.err).toContain("gitlab");
});
