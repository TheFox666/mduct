import { describe, expect, test } from "bun:test";
import { ServerConnection } from "../src/daemon/connection";

const fixtureCfg = { command: process.execPath, args: ["test/fixture-server.ts"] };

describe("ServerConnection", () => {
  test("lazy connect, cached listTools, call", async () => {
    const c = new ServerConnection("fix", fixtureCfg);
    expect(c.connectedSince).toBeNull(); // not yet connected
    const tools = await c.listTools();
    expect(tools.some((t) => t.name === "echo")).toBe(true);
    const again = await c.listTools();
    expect(again).toBe(tools); // same array = cache hit
    const res = await c.call("echo", { text: "yo" });
    expect((res.content as any)[0].text).toBe("yo");
    await c.close();
  });

  test("guard deny raises with next action", async () => {
    const c = new ServerConnection("fix", { ...fixtureCfg, guard: { deny: ["admin_*"] } });
    await expect(c.call("admin_delete", {})).rejects.toThrow(/guard.*admin_delete.*fix/);
    await c.close();
  });

  test("call timeout raises", async () => {
    const c = new ServerConnection("fix", fixtureCfg);
    await expect(c.call("sleep", { ms: 3000 }, 200)).rejects.toThrow(/timeout/i);
    await c.close();
  });
});
