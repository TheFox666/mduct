import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, serveIpc } from "../src/ipc";

test("round-trip and error propagation", async () => {
  const sock = join(mkdtempSync(join(tmpdir(), "mux-")), "d.sock");
  const srv = serveIpc(sock, async (method, params) => {
    if (method === "add") return (params.a as number) + (params.b as number);
    throw new Error(`unknown method ${method}`);
  });
  expect(await request(sock, "add", { a: 2, b: 3 })).toBe(5);
  await expect(request(sock, "nope", {})).rejects.toThrow(/unknown method/);
  srv.stop();
});
