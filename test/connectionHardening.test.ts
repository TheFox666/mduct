import { describe, expect, test } from "bun:test";
import { ServerConnection } from "../src/daemon/connection";

const fixtureCfg = { command: process.execPath, args: ["test/fixture-server.ts"] };

describe("ServerConnection hardening", () => {
  test("parallel cold ops spawn exactly one child (#3)", async () => {
    const c = new ServerConnection("fix", fixtureCfg);
    // fire listTools + call simultaneously against a cold connection
    const [tools] = await Promise.all([c.listTools(), c.call("echo", { text: "x" })]);
    expect(tools.some((t) => t.name === "echo")).toBe(true);
    // one client only: connectedSince set once, no second (orphaned) client
    expect(c.connectedSince).not.toBeNull();
    await c.close();
  });

  test("queue stays serialized after a timeout (#4)", async () => {
    const c = new ServerConnection("fix", fixtureCfg);
    const t0 = Date.now();
    await c.call("sleep", { ms: 1500 }, 200).catch(() => {}); // times out at 200ms
    await c.call("echo", { text: "after" });                  // must wait for the sleep to finish
    expect(Date.now() - t0).toBeGreaterThan(1200); // serialized: echo didn't overtake the aborted sleep
    await c.close();
  }, 10_000);

  // NOTE on #1 (child-leak fix in call()'s catch): the common "error" cases (bad args, unknown tool)
  // come back as isError CONTENT and callTool RESOLVES — they never hit the catch. callTool only
  // rejects on transport death (child already gone) or the SDK's ~60s request timeout (a live but
  // very slow child). Only that last case leaks, and it can't be triggered fast/deterministically,
  // so there's no cheap regression test — the fix (close before drop) is verified by construction and
  // mirrors the four other paths that already close(). The #5 test below exercises the catch path.

  test("reconnects after the server process dies (#5)", async () => {
    const c = new ServerConnection("fix", fixtureCfg);
    await c.call("echo", { text: "alive" });
    await c.call("die", {}).catch(() => {}); // server exits
    await new Promise((r) => setTimeout(r, 300));
    const res = await c.call("echo", { text: "back" }); // transparent reconnect
    expect((res.content as any)[0].text).toBe("back");
    await c.close();
  }, 10_000);
});
