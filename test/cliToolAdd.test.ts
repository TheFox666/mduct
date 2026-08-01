import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mduct-"));
const env = { ...process.env, MDUCT_CONFIG: join(dir, "servers.jsonc"), MDUCT_SECRETS: join(dir, "secrets.json") };

async function mduct(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("add --tool registers a CLI tool that run/index then see", async () => {
  const r = await mduct("add", "kubectl", "--tool", "--note", "read-only k8s",
    "--check", "kubectl version --client", "--", "kubectl");
  expect(r.code).toBe(0);
  const idx = await mduct("index");
  expect(idx.out).toContain("kubectl");
  expect(idx.out).toContain("mduct run");
  const st = await mduct("tool", "status");
  expect(st.out).toContain("kubectl");
});

test("remove drops a tool too", async () => {
  await mduct("add", "tmptool", "--tool", "--", "echo");
  const r = await mduct("remove", "tmptool");
  expect(r.code).toBe(0);
  const st = await mduct("tool", "status");
  expect(st.out).not.toContain("tmptool");
});
