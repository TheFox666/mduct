import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ServerCfg } from "../shared/config";
import { guardAllows } from "./guard";
import { FileOAuthProvider } from "./oauthProvider";

/**
 * A child MCP server inherits the daemon's cwd unless told otherwise. The daemon is lazily
 * autostarted by the first `mduct` call, so its cwd is that caller's dir — for a short-lived
 * turn, an ephemeral per-task git worktree. Once the worktree is torn down, inheriting that
 * dead path makes posix_spawn fail with ENOENT for every fresh server, fleet-wide. So: keep
 * inheriting while the cwd is alive (relative-path server commands still resolve as before),
 * and only fall back to a guaranteed-live dir when it's gone. `process.cwd()` itself throws
 * once the dir is deleted — that's the clearest "it's dead" signal.
 */
function childSpawnCwd(): string | undefined {
  try {
    return existsSync(process.cwd()) ? undefined : homedir();
  } catch {
    return homedir();
  }
}

export type ToolInfo = { name: string; description?: string; inputSchema?: unknown };
export type CallResult = { content: unknown[]; isError?: boolean };

/**
 * Refine the CLI's heuristically-coerced scalar args against the tool's DECLARED param types — the
 * inputSchema is the authoritative source, so a numeric id a server wants as a STRING (GitLab's
 * project_id) is sent as "38077343" not the number 38077343 (which would -32602). Only acts when the
 * declared type is unambiguous about scalar kind; a union like ["string","integer"] keeps the CLI's
 * value (already a valid member). Args from `:=`/`--args` are non-string JSON and pass through.
 */
export function normalizeArgs(args: Record<string, unknown>, inputSchema: unknown): Record<string, unknown> {
  const props = (inputSchema as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties;
  if (!props || !args || typeof args !== "object") return args;
  const out: Record<string, unknown> = { ...args };
  for (const [k, v] of Object.entries(out)) {
    const t = props[k]?.type;
    const types = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
    if (types.length === 0) continue;
    const has = (x: string) => types.includes(x);
    const numeric = has("integer") || has("number");
    if (has("string") && !numeric) { if (typeof v === "number" || typeof v === "boolean") out[k] = String(v); }
    else if (numeric && !has("string") && typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v) && Number.isFinite(Number(v))) out[k] = Number(v);
    else if (has("boolean") && !has("string") && (v === "true" || v === "false")) out[k] = v === "true";
  }
  return out;
}

export class ServerConnection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private tools: ToolInfo[] | null = null;
  private running = 0;                  // calls actually in flight
  private waiters: (() => void)[] = []; // calls holding for a slot (or for a poisoned drain)
  private poisoned = false;             // a call failed: reconnect once everyone is out
  connectedSince: number | null = null;

  constructor(readonly name: string, readonly cfg: ServerCfg) {}

  /** How many calls may be in flight at once. 1 = the old strict queue, and still the default. */
  private get limit(): number {
    return Math.max(1, this.cfg.maxConcurrent ?? 1);
  }

  /** True while any call is running or waiting — checked by the daemon's idle sweep (#23). */
  get busy(): boolean { return this.running > 0 || this.waiters.length > 0; }

  private acquire(): Promise<void> {
    if (this.running < this.limit && !this.poisoned) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((r) => this.waiters.push(r)).then(() => this.acquire());
  }

  /**
   * Give the slot back, and handle the case the strict queue used to make impossible: a call
   * failed while siblings were still in flight. Closing the transport there would kill THEIR
   * calls too, so the failure only marks the connection; the last one out does the close, and
   * nobody new starts until then.
   */
  private release(): void {
    this.running--;
    if (this.poisoned && this.running === 0) {
      void this.client?.close().catch(() => {});
      this.drop();
      this.poisoned = false;
    }
    if (this.poisoned) return; // still draining — waiters stay parked
    const wake = this.waiters.splice(0, this.limit - this.running);
    for (const w of wake) w();
  }

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
      const client = new Client({ name: "mduct", version: "0.1.0" });
      const transport = this.cfg.command
        ? new StdioClientTransport({
            command: this.cfg.command,
            args: this.cfg.args ?? [],
            env: { ...process.env, ...this.cfg.env } as Record<string, string>,
            // inherit the (live) cwd, or fall back to homedir() when it's a torn-down worktree
            ...((): { cwd?: string } => { const cwd = childSpawnCwd(); return cwd ? { cwd } : {}; })(),
          })
        : new StreamableHTTPClientTransport(new URL(this.cfg.url!), {
            requestInit: { headers: this.cfg.headers },
            // oauth servers: the SDK auto-uses/refreshes stored tokens; a 401 with no valid
            // session surfaces as an error telling the user to run `mduct auth <server>`
            ...(this.cfg.auth === "oauth" ? { authProvider: new FileOAuthProvider(this.name, "http://127.0.0.1:0/cb") } : {}),
          });
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
   * One in-flight call per server by default: MCP servers are not uniformly reentrant, and the
   * failure path below closes the transport, which is only safe when nothing else is using it.
   * `maxConcurrent` raises the limit for a server you know handles it — the protocol itself has
   * request ids and does not care.
   *
   * The caller may time out, but the SLOT is held until the underlying call actually settles;
   * otherwise the next call would hit a still-busy server (#4).
   */
  call(tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<CallResult> {
    if (!guardAllows(this.cfg.guard, tool))
      return Promise.reject(new Error(`guard: tool "${tool}" is blocked for server "${this.name}" — edit its guard in the config to change this`));

    const real = this.acquire().then(async () => {
      const client = await this.ensure();
      // schema-aware coercion: type each scalar arg by the tool's declared param type (cached
      // listTools). Fail-safe — if the schema can't be fetched, args pass through unchanged.
      const schema = await this.listTools().then((ts) => ts.find((t) => t.name === tool)?.inputSchema).catch(() => undefined);
      try {
        return (await client.callTool({ name: tool, arguments: normalizeArgs(args, schema) })) as CallResult;
      } catch (e) {
        // The child must be closed, not just dereferenced: drop() only nulls refs, so dropping
        // alone orphans the process and the next call spawns a second one (child leak). With
        // siblings in flight the close waits for the drain — see release().
        this.poisoned = true;
        throw e;
      }
    });
    real.finally(() => { this.release(); }).catch(() => {}); // free the slot, swallow (the caller sees the error via the race below)

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
