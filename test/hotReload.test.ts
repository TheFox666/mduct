import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "../src/shared/ipc";
import { startDaemon } from "../src/daemon/daemon";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

const fixtureLine = (name: string) =>
  `"${name}":{"command":"${process.execPath}","args":["test/fixture-server.ts"]}`;

async function boot(initial: string): Promise<{ sock: string; cfg: string }> {
  const dir = mkdtempSync(join(tmpdir(), "mduct-"));
  const cfg = join(dir, "servers.jsonc");
  const sock = join(dir, "d.sock");
  writeFileSync(cfg, initial);
  process.env.MDUCT_CONFIG = cfg;
  process.env.MDUCT_SOCKET = sock;
  const d = await startDaemon();
  stop = d.stop;
  return { sock, cfg };
}

async function waitFor(fn: () => Promise<boolean>, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
}

test("a server added after boot becomes usable without restart (#6b)", async () => {
  const { sock, cfg } = await boot(`{"servers":{${fixtureLine("a")}}}`);
  // b does not exist yet
  await expect(request(sock, "call", { server: "b", tool: "echo", args: { text: "x" } })).rejects.toThrow(/unknown server "b"/);
  writeFileSync(cfg, `{"servers":{${fixtureLine("a")},${fixtureLine("b")}}}`);
  const ok = await waitFor(async () => {
    try { await request(sock, "call", { server: "b", tool: "echo", args: { text: "x" } }); return true; } catch { return false; }
  });
  expect(ok).toBe(true);
});

test("boot with NO config file, then first add works (#6b)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mduct-"));
  const cfg = join(dir, "servers.jsonc");
  process.env.MDUCT_CONFIG = cfg;
  process.env.MDUCT_SOCKET = join(dir, "d.sock");
  const d = await startDaemon(); // no file exists yet
  stop = d.stop;
  writeFileSync(cfg, `{"servers":{${fixtureLine("a")}}}`);
  const ok = await waitFor(async () => {
    try { await request(process.env.MDUCT_SOCKET!, "tools", { server: "a" }); return true; } catch { return false; }
  });
  expect(ok).toBe(true);
});

test("editing one server does not disturb an unrelated live connection (#7)", async () => {
  const { sock, cfg } = await boot(`{"servers":{${fixtureLine("a")},${fixtureLine("b")}}}`);
  await request(sock, "call", { server: "a", tool: "echo", args: { text: "warm" } }); // a is connected
  const before: any = await request(sock, "servers", {});
  expect(before.find((s: any) => s.name === "a").connected).toBe(true);
  // change ONLY b (add a note); a must stay connected
  writeFileSync(cfg, `{"servers":{${fixtureLine("a")},"b":{"command":"${process.execPath}","args":["test/fixture-server.ts"],"note":"changed"}}}`);
  await new Promise((r) => setTimeout(r, 500));
  const after: any = await request(sock, "servers", {});
  expect(after.find((s: any) => s.name === "a").connected).toBe(true); // untouched
});
