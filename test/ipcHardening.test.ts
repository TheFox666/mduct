import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, serveIpc } from "../src/shared/ipc";

function sock(): string {
  return join(mkdtempSync(join(tmpdir(), "mduct-")), "d.sock");
}

test("garbage line does not crash the server handler (#9)", async () => {
  const s = sock();
  const srv = await serveIpc(s, async () => "ok");
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
  const srv = await serveIpc(s, async (_m, p) => p.blob);
  const echoed = (await request(s, "echo", { blob: big }, 20_000)) as string;
  expect(echoed.length).toBe(big.length);
  srv.stop();
});

test("multibyte UTF-8 survives chunk boundaries (#8)", async () => {
  const s = sock();
  // ~2MB of multibyte chars guarantees splits mid-codepoint across socket chunks
  const uni = "äöü😀🎉".repeat(300_000);
  const srv = await serveIpc(s, async (_m, p) => p.blob);
  const echoed = (await request(s, "echo", { blob: uni }, 20_000)) as string;
  expect(echoed).toBe(uni);
  srv.stop();
});

test("an unserializable handler result yields a prompt error, not a 120s hang (#5)", async () => {
  const s = sock();
  // a circular result makes JSON.stringify throw inside the success write — must still answer
  const srv = await serveIpc(s, async () => { const o: Record<string, unknown> = {}; o.self = o; return o; });
  await expect(request(s, "x", {}, 3000)).rejects.toThrow(/not serializable/i);
  srv.stop();
});

test("serveIpc over a LIVE socket does not clobber it (#2 cold-start race)", async () => {
  const s = sock();
  // real daemons answer ping→pong; socketAlive relies on it to detect a live socket
  const srv1 = await serveIpc(s, async (m) => (m === "ping" ? "pong" : "one"));
  // the loser of a cold-start race must NOT rmSync the winner's live socket. Whether Bun.listen
  // then throws or returns a dud, the invariant is: srv1 keeps its socket and stays the responder.
  let srv2: { stop(): void } | undefined;
  try { srv2 = await serveIpc(s, async (m) => (m === "ping" ? "pong" : "two")); } catch { /* EADDRINUSE = ideal */ }
  expect(await request(s, "x", {}, 3000)).toBe("one"); // winner still answering, not orphaned/clobbered
  srv2?.stop();
  srv1.stop();
});
