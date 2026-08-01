import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mduct-"));
const env = { ...process.env, MDUCT_CONFIG: join(dir, "servers.jsonc"), MDUCT_SOCKET: join(dir, "d.sock") };
async function mduct(...argv: string[]) {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}
afterAll(async () => { await mduct("daemon", "--stop"); });

test("config compact on|off persists and shows", async () => {
  expect((await mduct("config")).out).toMatch(/compact:\s*off/i);
  expect((await mduct("config", "compact", "on")).code).toBe(0);
  expect((await mduct("config")).out).toMatch(/compact:\s*on/i);
  await mduct("config", "compact", "off");
  expect((await mduct("config")).out).toMatch(/compact:\s*off/i);
});
