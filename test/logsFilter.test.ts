import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "../src/shared/ipc";
import { startDaemon } from "../src/daemon/daemon";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

test("logs <server> does not leak another server's lines (#19/N6)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mux-"));
  process.env.MCPMUX_CONFIG = join(dir, "servers.jsonc");
  process.env.MCPMUX_SOCKET = join(dir, "d.sock");
  const line = (n: string) => `"${n}":{"command":"${process.execPath}","args":["test/fixture-server.ts"]}`;
  writeFileSync(process.env.MCPMUX_CONFIG, `{"servers":{${line("lab")},${line("gitlab")}}}`);
  const d = await startDaemon();
  stop = d.stop;
  await request(process.env.MCPMUX_SOCKET, "call", { server: "gitlab", tool: "echo", args: { text: "x" } });
  const labLogs = (await request(process.env.MCPMUX_SOCKET, "logs", { server: "lab" })) as string[];
  // "lab" is a substring of "gitlab" — the old filter leaked gitlab's call line
  expect(labLogs.some((l) => l.includes("gitlab.echo"))).toBe(false);
  const gitlabLogs = (await request(process.env.MCPMUX_SOCKET, "logs", { server: "gitlab" })) as string[];
  expect(gitlabLogs.some((l) => l.includes("gitlab.echo"))).toBe(true);
});
