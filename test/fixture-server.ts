import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.tool("echo", "echoes text back", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text }],
}));
server.tool("sleep", "sleeps ms", { ms: z.number() }, async ({ ms }) => {
  await new Promise((r) => setTimeout(r, ms));
  return { content: [{ type: "text", text: `slept ${ms}` }] };
});
server.tool("boom", "always fails", {}, async () => ({
  content: [{ type: "text", text: "kaboom" }], isError: true,
}));
server.tool("admin_delete", "guarded destructive op", {}, async () => ({
  content: [{ type: "text", text: "deleted" }],
}));
server.tool("die", "crashes the server process", {}, async () => {
  setTimeout(() => process.exit(1), 10);
  return { content: [{ type: "text", text: "dying" }] };
});
await server.connect(new StdioServerTransport());
