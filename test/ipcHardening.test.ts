import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, serveIpc } from "../src/shared/ipc";

function sock(): string {
  return join(mkdtempSync(join(tmpdir(), "mux-")), "d.sock");
}

test("garbage line does not crash the server handler (#9)", async () => {
  const s = sock();
  const srv = serveIpc(s, async () => "ok");
  // send a non-JSON line directly, then a valid request — the server must survive
  await new Promise<void>((resolve) => {
    Bun.connect({
      unix: s,
      socket: {
        open(so) { so.write("this is not json\n"); so.end(); resolve(); },
        data() {},
      },
    });
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(await request(s, "anything", {})).toBe("ok"); // server still answering
  srv.stop();
});

test("large payload (>1MB) round-trips intact (#10)", async () => {
  const s = sock();
  const big = "x".repeat(3_000_000);
  const srv = serveIpc(s, async (_m, p) => p.blob);
  const echoed = (await request(s, "echo", { blob: big }, 20_000)) as string;
  expect(echoed.length).toBe(big.length);
  srv.stop();
});

test("multibyte UTF-8 survives chunk boundaries (#8)", async () => {
  const s = sock();
  // ~2MB of multibyte chars guarantees splits mid-codepoint across socket chunks
  const uni = "äöü😀🎉".repeat(300_000);
  const srv = serveIpc(s, async (_m, p) => p.blob);
  const echoed = (await request(s, "echo", { blob: uni }, 20_000)) as string;
  expect(echoed).toBe(uni);
  srv.stop();
});
