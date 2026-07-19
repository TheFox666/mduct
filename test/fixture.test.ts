import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("fixture serves echo over stdio", async () => {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["test/fixture-server.ts"],
  }));
  const tools = await client.listTools();
  expect(tools.tools.map((t) => t.name).sort()).toEqual(["admin_delete", "boom", "die", "echo", "sleep"]);
  const res = await client.callTool({ name: "echo", arguments: { text: "hi" } });
  expect((res.content as any)[0].text).toBe("hi");
  await client.close();
});
