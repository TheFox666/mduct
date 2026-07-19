import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "../src/ipc";
import { startDaemon } from "../src/daemon";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

async function boot(extraServers = ""): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mux-"));
  const sock = join(dir, "d.sock");
  const cfg = join(dir, "servers.jsonc");
  writeFileSync(cfg, `{"servers":{"fix":{"command":"${process.execPath}","args":["test/fixture-server.ts"]}${extraServers}}}`);
  process.env.MCPMUX_CONFIG = cfg;
  process.env.MCPMUX_SOCKET = sock;
  const d = await startDaemon();
  stop = d.stop;
  return sock;
}

test("call + tools + schema through the daemon", async () => {
  const sock = await boot();
  const res: any = await request(sock, "call", { server: "fix", tool: "echo", args: { text: "hi" } });
  expect(res.content[0].text).toBe("hi");
  const tools: any = await request(sock, "tools", { server: "fix" });
  expect(tools.map((t: any) => t.name)).toContain("sleep");
  const schema: any = await request(sock, "schema", { server: "fix", tool: "echo" });
  expect(JSON.stringify(schema)).toContain("text");
});

test("unknown server error names config path and known servers", async () => {
  const sock = await boot();
  await expect(request(sock, "call", { server: "nope", tool: "x", args: {} }))
    .rejects.toThrow(/unknown server "nope".*fix/);
});

test("servers reports connection state", async () => {
  const sock = await boot();
  let s: any = await request(sock, "servers", {});
  expect(s[0]).toMatchObject({ name: "fix", connected: false });
  await request(sock, "call", { server: "fix", tool: "echo", args: { text: "x" } });
  s = await request(sock, "servers", {});
  expect(s[0].connected).toBe(true);
});
