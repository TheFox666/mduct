import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ServerCfg } from "../shared/config";
import { guardAllows } from "./guard";

export type ToolInfo = { name: string; description?: string; inputSchema?: unknown };
export type CallResult = { content: unknown[]; isError?: boolean };

export class ServerConnection {
  private client: Client | null = null;
  private tools: ToolInfo[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  connectedSince: number | null = null;

  constructor(readonly name: string, readonly cfg: ServerCfg) {}

  private async ensure(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: "mcpmux", version: "0.1.0" });
    const transport = this.cfg.command
      ? new StdioClientTransport({
          command: this.cfg.command,
          args: this.cfg.args ?? [],
          env: { ...process.env, ...this.cfg.env } as Record<string, string>,
        })
      : new StreamableHTTPClientTransport(new URL(this.cfg.url!), {
          requestInit: { headers: this.cfg.headers },
        });
    await client.connect(transport);
    // tool-list change notifications invalidate the cache (best-effort across sdk versions)
    try {
      (client as any).fallbackNotificationHandler = async (n: { method?: string }) => {
        if (n.method === "notifications/tools/list_changed") this.tools = null;
      };
    } catch { /* cache then only refreshes on reconnect */ }
    this.client = client;
    this.connectedSince = Date.now();
    return client;
  }

  async listTools(): Promise<ToolInfo[]> {
    if (this.tools) return this.tools;
    const client = await this.ensure();
    const res = await client.listTools();
    this.tools = res.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    return this.tools;
  }

  /** Serialized per server; MCP servers are not uniformly reentrant. */
  call(tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<CallResult> {
    if (!guardAllows(this.cfg.guard, tool))
      return Promise.reject(new Error(`guard: tool "${tool}" is blocked for server "${this.name}" — edit its guard in the config to change this`));
    const run = async (): Promise<CallResult> => {
      const client = await this.ensure();
      const call = client.callTool({ name: tool, arguments: args });
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timeout after ${timeoutMs}ms calling ${this.name}.${tool} — retry with --timeout <s>`)), timeoutMs);
      });
      try {
        return (await Promise.race([call, timeout])) as CallResult;
      } finally {
        clearTimeout(timer!);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = null;
    this.tools = null;
    this.connectedSince = null;
  }
}
