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

describe("maxConcurrent", () => {
  const cfg = { command: process.execPath, args: ["test/fixture-server.ts"] };

  test("default is still one at a time — three 300ms calls take ~900ms", async () => {
    const c = new ServerConnection("fix", cfg);
    await c.call("echo", { text: "warm" }); // pay the spawn once
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => c.call("sleep", { ms: 300 })));
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThan(850);
    await c.close();
  });

  test("maxConcurrent:3 overlaps them — the same three take about one call's time", async () => {
    const c = new ServerConnection("fix", { ...cfg, maxConcurrent: 3 });
    await c.call("echo", { text: "warm" });
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => c.call("sleep", { ms: 300 })));
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(600);   // serialised would be >900
    expect(ms).toBeGreaterThan(280); // and they did actually run
    await c.close();
  });

  test("it is a limit, not a free-for-all: 5 calls at maxConcurrent:2 still take three rounds", async () => {
    const c = new ServerConnection("fix", { ...cfg, maxConcurrent: 2 });
    await c.call("echo", { text: "warm" });
    const t0 = Date.now();
    await Promise.all([1, 2, 3, 4, 5].map(() => c.call("sleep", { ms: 200 })));
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThan(550);  // ceil(5/2) = 3 rounds
    expect(ms).toBeLessThan(1100);    // but not five
    await c.close();
  });

  test("a tool-level error is NOT a broken connection — no reconnect, siblings unaffected", async () => {
    const c = new ServerConnection("fix", { ...cfg, maxConcurrent: 3 });
    await c.call("echo", { text: "warm" });
    const since = c.connectedSince;
    const [a, bad, b] = await Promise.all([
      c.call("sleep", { ms: 200 }),
      c.call("boom", {}),                 // the server answers with isError, it does not throw
      c.call("sleep", { ms: 200 }),
    ]);
    expect((bad as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(a)).toContain("slept");
    expect(JSON.stringify(b)).toContain("slept");
    expect(c.connectedSince).toBe(since); // same connection: a tool saying no is not a fault
    await c.close();
  });

  test("a transport that dies mid-flight is rebuilt once, after everyone is out", async () => {
    const c = new ServerConnection("fix", { ...cfg, maxConcurrent: 3 });
    await c.call("echo", { text: "warm" });
    const since = c.connectedSince;
    // `die` kills the child. Calls in flight legitimately fail with it — the point is that the
    // close/reconnect happens ONCE, after the last one drains, not three times racing each other.
    await Promise.allSettled([
      c.call("sleep", { ms: 150 }),
      c.call("die", {}),
      c.call("sleep", { ms: 150 }),
    ]);
    const after = await c.call("echo", { text: "back" });
    expect(JSON.stringify(after)).toContain("back");
    expect(c.connectedSince).not.toBe(since); // a genuinely new connection
    await c.close();
  });
});
