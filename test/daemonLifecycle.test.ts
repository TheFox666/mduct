import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "../src/shared/ipc";
import { startDaemon } from "../src/daemon/daemon";

let stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const s of stops) await s().catch(() => {}); stops = []; });

function bootEnv(): string {
  const dir = mkdtempSync(join(tmpdir(), "mux-"));
  process.env.MCPMUX_CONFIG = join(dir, "servers.jsonc");
  process.env.MCPMUX_SOCKET = join(dir, "d.sock");
  writeFileSync(process.env.MCPMUX_CONFIG, `{"servers":{"fix":{"command":"${process.execPath}","args":["test/fixture-server.ts"]}}}`);
  return process.env.MCPMUX_SOCKET;
}

test("second startDaemon over a live daemon refuses instead of hijacking the socket (#15)", async () => {
  const sock = bootEnv();
  const d1 = await startDaemon();
  stops.push(d1.stop);
  await expect(startDaemon()).rejects.toThrow(/already running/i);
  // the first daemon is still the one answering
  expect(await request(sock, "ping", {})).toBe("pong");
});

test("startDaemon cleans a stale socket left by a crashed daemon (#22)", async () => {
  const sock = bootEnv();
  const d1 = await startDaemon();
  // simulate a crash: stop the listener but the file logic is exercised by starting again
  await d1.stop();
  writeFileSync(sock, ""); // leave a stale socket file behind
  const d2 = await startDaemon(); // must NOT throw EADDRINUSE
  stops.push(d2.stop);
  expect(await request(sock, "ping", {})).toBe("pong");
});
