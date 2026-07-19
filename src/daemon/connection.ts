import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ServerCfg } from "../shared/config";
import { guardAllows } from "./guard";

export type ToolInfo = { name: string; description?: string; inputSchema?: unknown };
export type CallResult = { content: unknown[]; isError?: boolean };

export class ServerConnection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private tools: ToolInfo[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private active = 0; // in-flight or queued calls — the idle sweep must skip a busy connection (#23)
  connectedSince: number | null = null;

  constructor(readonly name: string, readonly cfg: ServerCfg) {}

  /** True while any call is queued or running — checked by the daemon's idle sweep. */
  get busy(): boolean { return this.active > 0; }

  private drop(): void {
    this.client = null;
    this.connecting = null;
    this.tools = null;
    this.connectedSince = null;
  }

  /** Memoized connect: concurrent first-callers share ONE client, no orphaned children (#3). */
  private ensure(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({ name: "mcpmux", version: "0.1.0" });
      const transport = this.cfg.command
        ? new StdioClientTransport({
            command: this.cfg.command,
            args: this.cfg.args ?? [],
            env: { ...process.env, ...this.cfg.env } as Record<string, string>,
          })
        : new StreamableHTTPClientTransport(new URL(this.cfg.url!), { requestInit: { headers: this.cfg.headers } });
      // transport death → drop the dead client so the next call reconnects transparently (#5)
      transport.onclose = () => { if (this.client === client) this.drop(); };
      await client.connect(transport);
      this.client = client;
      this.connectedSince = Date.now();
      return client;
    })();
    this.connecting.catch(() => { if (!this.client) this.connecting = null; });
    return this.connecting;
  }

  async listTools(): Promise<ToolInfo[]> {
    if (this.tools) return this.tools;
    const client = await this.ensure();
    const res = await client.listTools();
    this.tools = res.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    return this.tools;
  }

  /**
   * Serialized per server (MCP servers are not uniformly reentrant). The caller may time out,
   * but the QUEUE SLOT is held until the underlying call actually settles — otherwise the next
   * call would hit a still-busy server (#4). A failed call drops the client to force reconnect (#5).
   */
  call(tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<CallResult> {
    if (!guardAllows(this.cfg.guard, tool))
      return Promise.reject(new Error(`guard: tool "${tool}" is blocked for server "${this.name}" — edit its guard in the config to change this`));

    this.active++;
    const real = this.queue.then(async () => {
      const client = await this.ensure();
      try {
        return (await client.callTool({ name: tool, arguments: args })) as CallResult;
      } catch (e) {
        this.drop(); // a failed call may mean a dead transport — force reconnect next time
        throw e;
      }
    });
    this.queue = real.catch(() => {}); // next call waits for THIS one's real completion
    real.finally(() => { this.active--; }).catch(() => {}); // decrement + swallow (caller sees the error via the race below)

    // caller-facing timeout: races real completion, but never cancels the queue slot
    return new Promise<CallResult>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(`timeout after ${timeoutMs}ms calling ${this.name}.${tool} — retry with --timeout <s>`));
      }, timeoutMs);
      real.then(
        (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } },
        (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
      );
    });
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.drop();
  }
}
