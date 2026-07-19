# mcpmux Core Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `mux` CLI + daemon that calls tools on any configured MCP server (stdio + HTTP) with zero schemas in model context.

**Architecture:** One TypeScript/bun binary with two roles: a daemon holding persistent MCP client connections (lazy connect, idle TTL, per-server queue, guard) reachable over a Unix socket, and thin CLI subcommands that autostart the daemon. Spec: `docs/specs/2026-07-19-mcpmux-design.md`.

**Tech Stack:** bun (runtime, test runner, `bun build --compile`), `@modelcontextprotocol/sdk` (client + fixture server), `zod` (fixture tool schemas; already an sdk dependency).

## Global Constraints

- Repo root: `~/dev/mcpmux`. All paths below are repo-relative.
- No dependencies beyond `@modelcontextprotocol/sdk` and `zod`. No CLI framework — hand-rolled argv parsing.
- Every error message names the next action (spec "error contract").
- Env overrides for testability: `MCPMUX_SOCKET` (socket path), `MCPMUX_CONFIG` (config file path). Both default as in Task 2/5.
- All management ops must work without a TTY (AX requirement). Plan 1 has no interactive UI at all.
- Commit after every green test cycle. Commit messages in English, conventional prefix (`feat:`, `test:`, `chore:`).

---

### Task 1: Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/util.ts`, `test/util.test.ts`

**Interfaces:**
- Produces: `stripJsonc(s: string): string`, `expandEnv(s: string, env?: Record<string,string|undefined>): string` (used by Task 2).

- [ ] **Step 1: Write scaffold files**

`package.json`:
```json
{
  "name": "mcpmux",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "scripts": {
    "test": "bun test",
    "build": "bun build --compile --outfile dist/mux src/main.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": { "@types/bun": "latest", "typescript": "^5.5.0" }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "types": ["bun"]
  },
  "include": ["src", "test"]
}
```

`.gitignore`:
```
node_modules/
dist/
```

- [ ] **Step 2: Install deps**

Run: `cd ~/dev/mcpmux && ~/.bun/bin/bun install`
Expected: lockfile created, sdk + zod installed. (bun is NOT on PATH on this machine — always `~/.bun/bin/bun`.)

- [ ] **Step 3: Write failing util tests**

`test/util.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { stripJsonc, expandEnv } from "../src/util";

describe("stripJsonc", () => {
  test("strips // and /* */ comments but not inside strings", () => {
    const s = `{
  // comment
  "a": "http://x", /* block */
  "b": 1
}`;
    expect(JSON.parse(stripJsonc(s))).toEqual({ a: "http://x", b: 1 });
  });
});

describe("expandEnv", () => {
  test("replaces ${VAR} from env and leaves unknown untouched", () => {
    expect(expandEnv("t-${FOO}-${NOPE}", { FOO: "x" })).toBe("t-x-${NOPE}");
  });
});
```

Run: `~/.bun/bin/bun test test/util.test.ts`
Expected: FAIL — `Cannot find module '../src/util'`.

- [ ] **Step 4: Implement `src/util.ts`**

```ts
/** Strip // and both-slash block comments from JSONC — string-aware, no dep. */
export function stripJsonc(s: string): string {
  let out = "", inStr = false, inLine = false, inBlock = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!, n = s[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) { out += c; if (c === "\\") { out += n ?? ""; i++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

/** Expand ${VAR} references; unknown vars stay literal so errors are visible downstream. */
export function expandEnv(s: string, env: Record<string, string | undefined> = process.env): string {
  return s.replace(/\$\{(\w+)\}/g, (m, name: string) => env[name] ?? m);
}
```

- [ ] **Step 5: Run tests, expect PASS, commit**

Run: `~/.bun/bin/bun test test/util.test.ts`
Expected: 2 pass.

```bash
git add -A && git commit -m "feat: scaffold bun project + jsonc/env utils"
```

---

### Task 2: Config loading

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type ServerCfg = {
    command?: string; args?: string[]; env?: Record<string, string>;
    url?: string; headers?: Record<string, string>;
    guard?: { allow?: string[]; deny?: string[] };
    idleTtlMin?: number; note?: string; disabled?: boolean;
  };
  type Config = { servers: Record<string, ServerCfg> };
  configPath(): string            // $MCPMUX_CONFIG ?? ~/.config/mcpmux/servers.jsonc
  loadConfig(): Config            // missing file → { servers: {} }; env-expanded; validated
  ```
- Consumes: `stripJsonc`, `expandEnv` from Task 1.

- [ ] **Step 1: Write failing tests**

`test/config.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

function withCfg(content: string): Config0 {
  const dir = mkdtempSync(join(tmpdir(), "mux-"));
  const p = join(dir, "servers.jsonc");
  writeFileSync(p, content);
  process.env.MCPMUX_CONFIG = p;
  return loadConfig();
}
type Config0 = ReturnType<typeof loadConfig>;

describe("loadConfig", () => {
  test("missing file yields empty servers", () => {
    process.env.MCPMUX_CONFIG = "/nonexistent/servers.jsonc";
    expect(loadConfig()).toEqual({ servers: {} });
  });

  test("parses jsonc, expands env in env/headers/args/url", () => {
    process.env.TESTTOKEN = "s3cret";
    const cfg = withCfg(`{
      // demo
      "servers": {
        "fix": { "command": "bun", "args": ["run", "\${TESTTOKEN}"], "env": { "T": "\${TESTTOKEN}" } },
        "web": { "url": "https://x/\${TESTTOKEN}", "headers": { "Authorization": "Bearer \${TESTTOKEN}" } }
      }
    }`);
    expect(cfg.servers.fix!.env!.T).toBe("s3cret");
    expect(cfg.servers.fix!.args).toEqual(["run", "s3cret"]);
    expect(cfg.servers.web!.url).toBe("https://x/s3cret");
    expect(cfg.servers.web!.headers!.Authorization).toBe("Bearer s3cret");
  });

  test("rejects server with neither command nor url, naming the server", () => {
    expect(() => withCfg(`{"servers":{"bad":{}}}`)).toThrow(/bad.*command.*url/);
  });
});
```

Run: `~/.bun/bin/bun test test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `src/config.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandEnv, stripJsonc } from "./util";

export type ServerCfg = {
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
  guard?: { allow?: string[]; deny?: string[] };
  idleTtlMin?: number; note?: string; disabled?: boolean;
};
export type Config = { servers: Record<string, ServerCfg> };

export function configPath(): string {
  return process.env.MCPMUX_CONFIG ?? join(homedir(), ".config", "mcpmux", "servers.jsonc");
}

export function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) return { servers: {} };
  const raw = JSON.parse(stripJsonc(readFileSync(p, "utf8"))) as Config;
  const servers: Record<string, ServerCfg> = {};
  for (const [name, s0] of Object.entries(raw.servers ?? {})) {
    const s: ServerCfg = structuredClone(s0);
    if (!s.command && !s.url)
      throw new Error(`server "${name}": needs "command" (stdio) or "url" (http) — fix ${p}`);
    if (s.url) s.url = expandEnv(s.url);
    s.args = s.args?.map((a) => expandEnv(a));
    for (const rec of [s.env, s.headers])
      if (rec) for (const k of Object.keys(rec)) rec[k] = expandEnv(rec[k]!);
    servers[name] = s;
  }
  return { servers };
}
```

- [ ] **Step 3: Run tests, expect 3 pass, commit**

```bash
git add -A && git commit -m "feat: servers.jsonc config loading with env expansion"
```

---

### Task 3: Fixture MCP server

**Files:**
- Create: `test/fixture-server.ts`, `test/fixture.test.ts`

**Interfaces:**
- Produces: a stdio MCP server started via `bun test/fixture-server.ts` exposing tools:
  `echo {text} → text`, `sleep {ms} → "slept <ms>"`, `boom {} → tool error`,
  `admin_delete {} → "deleted"` (exists to test guard deny).

- [ ] **Step 1: Implement the fixture (no TDD — it IS the test double)**

`test/fixture-server.ts`:
```ts
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
await server.connect(new StdioServerTransport());
```

(If the installed sdk version has deprecated `server.tool(...)`, use
`server.registerTool(name, { description, inputSchema }, handler)` — same shape.)

- [ ] **Step 2: Write a direct-SDK smoke test**

`test/fixture.test.ts`:
```ts
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("fixture serves echo over stdio", async () => {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["test/fixture-server.ts"],
  }));
  const tools = await client.listTools();
  expect(tools.tools.map((t) => t.name).sort()).toEqual(["admin_delete", "boom", "echo", "sleep"]);
  const res = await client.callTool({ name: "echo", arguments: { text: "hi" } });
  expect((res.content as any)[0].text).toBe("hi");
  await client.close();
});
```

- [ ] **Step 3: Run, expect PASS, commit**

Run: `~/.bun/bin/bun test test/fixture.test.ts`
Expected: 1 pass (proves sdk plumbing + fixture before any mux code exists).

```bash
git add -A && git commit -m "test: stdio fixture MCP server + sdk smoke test"
```

---

### Task 4: Guard + ServerConnection

**Files:**
- Create: `src/guard.ts`, `src/connection.ts`, `test/guard.test.ts`, `test/connection.test.ts`

**Interfaces:**
- Produces:
  ```ts
  guardAllows(guard: {allow?: string[]; deny?: string[]} | undefined, tool: string): boolean
  class ServerConnection {
    constructor(name: string, cfg: ServerCfg)
    listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]>  // cached
    call(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<CallResult>
    close(): Promise<void>
    readonly connectedSince: number | null
  }
  type CallResult = { content: unknown[]; isError?: boolean }
  ```
- Consumes: `ServerCfg` (Task 2).

- [ ] **Step 1: Failing guard tests**

`test/guard.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { guardAllows } from "../src/guard";

describe("guardAllows", () => {
  test("no guard → allow", () => expect(guardAllows(undefined, "x")).toBe(true));
  test("deny wins over allow", () =>
    expect(guardAllows({ allow: ["*"], deny: ["admin_*"] }, "admin_delete")).toBe(false));
  test("allow list restricts", () => {
    const g = { allow: ["list_*", "get_*"] };
    expect(guardAllows(g, "list_issues")).toBe(true);
    expect(guardAllows(g, "create_issue")).toBe(false);
  });
});
```

- [ ] **Step 2: Implement `src/guard.ts`**

```ts
const match = (pat: string, name: string): boolean =>
  pat === "*" ? true : pat.endsWith("*") ? name.startsWith(pat.slice(0, -1)) : name === pat;

/** deny beats allow; empty/missing allow = allow all. */
export function guardAllows(g: { allow?: string[]; deny?: string[] } | undefined, tool: string): boolean {
  if (!g) return true;
  if (g.deny?.some((p) => match(p, tool))) return false;
  if (g.allow && g.allow.length > 0) return g.allow.some((p) => match(p, tool));
  return true;
}
```

Run: `~/.bun/bin/bun test test/guard.test.ts` → 3 pass.

- [ ] **Step 3: Failing connection tests**

`test/connection.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { ServerConnection } from "../src/connection";

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
```

- [ ] **Step 4: Implement `src/connection.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ServerCfg } from "./config";
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
    // tool list changes invalidate the cache
    client.setNotificationHandler?.(
      { method: "notifications/tools/list_changed" } as any,
      () => { this.tools = null; },
    );
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
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`timeout after ${timeoutMs}ms calling ${this.name}.${tool} — retry with --timeout <s>`)), timeoutMs),
      );
      return (await Promise.race([call, timeout])) as CallResult;
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
```

(If `setNotificationHandler` needs a zod schema in the installed sdk version, wrap in try/catch and skip — cache invalidation on notification is best-effort in v1.)

- [ ] **Step 5: Run tests, expect all pass, commit**

Run: `~/.bun/bin/bun test test/connection.test.ts test/guard.test.ts`

```bash
git add -A && git commit -m "feat: per-server MCP connection with guard, cache, queue, timeout"
```

---

### Task 5: Unix-socket IPC

**Files:**
- Create: `src/ipc.ts`, `test/ipc.test.ts`

**Interfaces:**
- Produces:
  ```ts
  socketPath(): string  // $MCPMUX_SOCKET ?? $XDG_RUNTIME_DIR/mcpmux.sock ?? ~/.cache/mcpmux/daemon.sock
  type Handler = (method: string, params: any) => Promise<unknown>
  serveIpc(path: string, handler: Handler): { stop(): void }
  request(path: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown>
  ```
  Wire format: one JSON object per line: `{id,method,params}` → `{id,result}` | `{id,error:{message}}`.
- Consumes: nothing from earlier tasks (standalone).

- [ ] **Step 1: Failing tests**

`test/ipc.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, serveIpc } from "../src/ipc";

test("round-trip and error propagation", async () => {
  const sock = join(mkdtempSync(join(tmpdir(), "mux-")), "d.sock");
  const srv = serveIpc(sock, async (method, params) => {
    if (method === "add") return (params.a as number) + (params.b as number);
    throw new Error(`unknown method ${method}`);
  });
  expect(await request(sock, "add", { a: 2, b: 3 })).toBe(5);
  await expect(request(sock, "nope", {})).rejects.toThrow(/unknown method/);
  srv.stop();
});
```

- [ ] **Step 2: Implement `src/ipc.ts`**

```ts
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function socketPath(): string {
  if (process.env.MCPMUX_SOCKET) return process.env.MCPMUX_SOCKET;
  const run = process.env.XDG_RUNTIME_DIR;
  return run ? join(run, "mcpmux.sock") : join(homedir(), ".cache", "mcpmux", "daemon.sock");
}

export type Handler = (method: string, params: any) => Promise<unknown>;

export function serveIpc(path: string, handler: Handler): { stop(): void } {
  mkdirSync(dirname(path), { recursive: true });
  const server = Bun.listen<{ buf: string }>({
    unix: path,
    socket: {
      open(sock) { sock.data = { buf: "" }; },
      data(sock, chunk) {
        sock.data.buf += chunk.toString();
        let nl: number;
        while ((nl = sock.data.buf.indexOf("\n")) >= 0) {
          const line = sock.data.buf.slice(0, nl);
          sock.data.buf = sock.data.buf.slice(nl + 1);
          if (!line.trim()) continue;
          const { id, method, params } = JSON.parse(line);
          handler(method, params).then(
            (result) => sock.write(JSON.stringify({ id, result }) + "\n"),
            (e) => sock.write(JSON.stringify({ id, error: { message: String((e as Error).message ?? e) } }) + "\n"),
          );
        }
      },
    },
  });
  return { stop: () => server.stop(true) };
}

export async function request(path: string, method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let buf = "";
    const timer = setTimeout(() => { reject(new Error(`daemon did not answer within ${timeoutMs}ms — check: mux status`)); sock?.end(); }, timeoutMs);
    let sock: any;
    Bun.connect({
      unix: path,
      socket: {
        open(s) { sock = s; s.write(JSON.stringify({ id, method, params }) + "\n"); },
        data(s, chunk) {
          buf += chunk.toString();
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          clearTimeout(timer);
          const msg = JSON.parse(buf.slice(0, nl));
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
          s.end();
        },
        error(_s, e) { clearTimeout(timer); reject(e); },
      },
    }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}
```

- [ ] **Step 3: Run tests, expect pass, commit**

```bash
git add -A && git commit -m "feat: newline-JSON IPC over unix socket"
```

---

### Task 6: Daemon

**Files:**
- Create: `src/daemon.ts`, `test/daemon.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`configPath` (2), `ServerConnection` (4), `serveIpc`/`socketPath` (5).
- Produces: `startDaemon(): Promise<{ stop(): Promise<void> }>` handling IPC methods:
  - `call {server, tool, args, timeoutMs?}` → `CallResult`
  - `tools {server}` → `ToolInfo[]`
  - `schema {server, tool}` → `unknown` (the tool's inputSchema)
  - `servers {}` → `{ name, connected: boolean, disabled: boolean, note?: string, toolCount: number|null }[]`
  - `logs {server?}` → `string[]` (ring buffer, newest last)
  - `ping {}` → `"pong"`; `shutdown {}` → stops daemon.
  Unknown server → error `unknown server "x" — configured: a, b (config: <path>)`.
  Config hot reload: file watcher reloads config; removed/changed servers are closed (lazily reconnected on next call). Idle TTL: connections idle > `idleTtlMin` (default 30) are closed by a 60s sweep timer.

- [ ] **Step 1: Failing tests**

`test/daemon.test.ts`:
```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "../src/ipc";
import { startDaemon } from "../src/daemon";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

async function boot(extraServers = ""): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mux-"));
  const sock = join(dir, "d.sock");
  const cfg = join(dir, "servers.jsonc");
  writeFileSync(cfg, `{"servers":{"fix":{"command":"${process.execPath}","args":["test/fixture-server.ts"]}${extraServers}}}`);
  process.env.MCPMUX_CONFIG = cfg;
  process.env.MCPMUX_SOCKET = sock;
  const d = await startDaemon();
  stop = d.stop;
  return sock;
}

test("call + tools + schema through the daemon", async () => {
  const sock = await boot();
  const res: any = await request(sock, "call", { server: "fix", tool: "echo", args: { text: "hi" } });
  expect(res.content[0].text).toBe("hi");
  const tools: any = await request(sock, "tools", { server: "fix" });
  expect(tools.map((t: any) => t.name)).toContain("sleep");
  const schema: any = await request(sock, "schema", { server: "fix", tool: "echo" });
  expect(JSON.stringify(schema)).toContain("text");
});

test("unknown server error names config path and known servers", async () => {
  const sock = await boot();
  await expect(request(sock, "call", { server: "nope", tool: "x", args: {} }))
    .rejects.toThrow(/unknown server "nope".*fix/);
});

test("servers reports connection state", async () => {
  const sock = await boot();
  let s: any = await request(sock, "servers", {});
  expect(s[0]).toMatchObject({ name: "fix", connected: false });
  await request(sock, "call", { server: "fix", tool: "echo", args: { text: "x" } });
  s = await request(sock, "servers", {});
  expect(s[0].connected).toBe(true);
});
```

- [ ] **Step 2: Implement `src/daemon.ts`**

```ts
import { watch } from "node:fs";
import { existsSync } from "node:fs";
import { configPath, loadConfig, type Config } from "./config";
import { ServerConnection } from "./connection";
import { serveIpc, socketPath } from "./ipc";

const LOG_CAP = 500;

export async function startDaemon(): Promise<{ stop(): Promise<void> }> {
  let config: Config = loadConfig();
  const conns = new Map<string, ServerConnection>();
  const lastUsed = new Map<string, number>();
  const logs: string[] = [];
  const log = (line: string) => {
    logs.push(`${new Date().toISOString()} ${line}`);
    if (logs.length > LOG_CAP) logs.shift();
  };

  const conn = (name: string): ServerConnection => {
    const cfg = config.servers[name];
    if (!cfg || cfg.disabled) {
      const known = Object.keys(config.servers).join(", ") || "(none)";
      throw new Error(`unknown server "${name}" — configured: ${known} (config: ${configPath()})`);
    }
    let c = conns.get(name);
    if (!c) { c = new ServerConnection(name, cfg); conns.set(name, c); }
    lastUsed.set(name, Date.now());
    return c;
  };

  // hot reload: close everything on config change; connections re-establish lazily
  const watcher = existsSync(configPath())
    ? watch(configPath(), () => {
        try {
          config = loadConfig();
          for (const [n, c] of conns) void c.close().then(() => conns.delete(n));
          log("config reloaded");
        } catch (e) { log(`config reload FAILED: ${(e as Error).message}`); }
      })
    : null;

  // idle sweep
  const sweep = setInterval(() => {
    for (const [n, c] of conns) {
      const ttlMin = config.servers[n]?.idleTtlMin ?? 30;
      if (c.connectedSince && Date.now() - (lastUsed.get(n) ?? 0) > ttlMin * 60_000) {
        log(`idle-closing ${n}`);
        void c.close();
      }
    }
  }, 60_000);

  let stopFn: () => Promise<void>;
  const srv = serveIpc(socketPath(), async (method, p) => {
    switch (method) {
      case "ping": return "pong";
      case "call": {
        log(`call ${p.server}.${p.tool}`);
        try { return await conn(p.server).call(p.tool, p.args ?? {}, p.timeoutMs); }
        catch (e) { log(`call ${p.server}.${p.tool} FAILED: ${(e as Error).message}`); throw e; }
      }
      case "tools": return await conn(p.server).listTools();
      case "schema": {
        const tools = await conn(p.server).listTools();
        const t = tools.find((x) => x.name === p.tool);
        if (!t) throw new Error(`unknown tool "${p.tool}" on "${p.server}" — see: mux tools ${p.server}`);
        return t.inputSchema ?? {};
      }
      case "servers":
        return Object.entries(config.servers).map(([name, cfg]) => ({
          name,
          connected: conns.get(name)?.connectedSince != null,
          disabled: !!cfg.disabled,
          note: cfg.note,
          toolCount: null as number | null, // filled only when connected — cheap by design
        }));
      case "logs": return p?.server ? logs.filter((l) => l.includes(` ${p.server}.`) || l.includes(`${p.server} `)) : logs;
      case "shutdown": setTimeout(() => void stopFn(), 20); return "bye";
      default: throw new Error(`unknown method ${method}`);
    }
  });

  stopFn = async () => {
    clearInterval(sweep);
    watcher?.close();
    srv.stop();
    await Promise.all([...conns.values()].map((c) => c.close()));
  };
  log("daemon up");
  return { stop: stopFn };
}

if (import.meta.main) void startDaemon();
```

- [ ] **Step 3: Run all tests, expect pass, commit**

Run: `~/.bun/bin/bun test`
Expected: all suites pass (util, config, fixture, guard, connection, ipc, daemon).

```bash
git add -A && git commit -m "feat: daemon — lazy connections, hot reload, idle sweep, ring log"
```

---

### Task 7: CLI (`mux`) with daemon autostart

**Files:**
- Create: `src/main.ts`, `src/cliFormat.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `request`/`socketPath` (5), daemon methods (6), `configPath` (2).
- Produces: the `mux` command surface of plan 1:
  `call <server> <tool> [k=v…] [--args json] [--timeout s] [--raw]`,
  `tools <server>`, `schema <server> <tool>`, `servers`, `index`, `logs [server]`,
  `status`, `daemon`, `help`. Exit 0/1; errors on stderr.

- [ ] **Step 1: Failing e2e test (drives the whole surface)**

`test/cli.test.ts`:
```ts
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-"));
const env = {
  ...process.env,
  MCPMUX_SOCKET: join(dir, "d.sock"),
  MCPMUX_CONFIG: join(dir, "servers.jsonc"),
};
writeFileSync(env.MCPMUX_CONFIG!, JSON.stringify({
  servers: { fix: { command: process.execPath, args: ["test/fixture-server.ts"], note: "test fixture" } },
}));

async function mux(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

afterAll(async () => { await mux("daemon", "--stop"); });

test("call autostarts daemon and prints text content", async () => {
  const r = await mux("call", "fix", "echo", "text=hello");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("hello");
});

test("--args json wins for nested payloads", async () => {
  const r = await mux("call", "fix", "echo", "--args", '{"text":"json way"}');
  expect(r.out.trim()).toBe("json way");
});

test("tool error → stderr + exit 1", async () => {
  const r = await mux("call", "fix", "boom");
  expect(r.code).toBe(1);
  expect(r.err).toContain("kaboom");
});

test("tools prints compact lines", async () => {
  const r = await mux("tools", "fix");
  expect(r.out).toMatch(/echo\s+— echoes text back/);
});

test("index prints one line per server with note", async () => {
  const r = await mux("index");
  expect(r.out).toContain("fix");
  expect(r.out).toContain("test fixture");
});

test("unknown server error names the fix", async () => {
  const r = await mux("call", "nope", "x");
  expect(r.code).toBe(1);
  expect(r.err).toContain('unknown server "nope"');
});
```

- [ ] **Step 2: Implement `src/cliFormat.ts` (result → stdout contract)**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Print a CallResult per the output contract. Returns process exit code. */
export function printResult(res: { content: unknown[]; isError?: boolean }, raw: boolean): number {
  if (raw) { console.log(JSON.stringify(res, null, 2)); return res.isError ? 1 : 0; }
  const lines: string[] = [];
  for (const [i, c0] of (res.content ?? []).entries()) {
    const c = c0 as any;
    if (c.type === "text") lines.push(c.text);
    else if (c.data && c.mimeType) {
      const ext = String(c.mimeType).split("/")[1]?.split("+")[0] ?? "bin";
      const dir = join(tmpdir(), "mcpmux");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${Date.now()}-${i}.${ext}`);
      writeFileSync(file, Buffer.from(c.data, "base64"));
      lines.push(file);
    } else lines.push(JSON.stringify(c));
  }
  const text = lines.join("\n");
  if (res.isError) { console.error(text); return 1; }
  console.log(text);
  return 0;
}

/** k=v pairs + optional --args JSON → tool arguments. JSON wins on key conflict. */
export function parseArgs(pairs: string[], argsJson?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq < 1) throw new Error(`bad argument "${p}" — use key=value or --args '<json>'`);
    const v = p.slice(eq + 1);
    out[p.slice(0, eq)] = v === "true" ? true : v === "false" ? false : v !== "" && !isNaN(Number(v)) ? Number(v) : v;
  }
  return argsJson ? { ...out, ...JSON.parse(argsJson) } : out;
}
```

- [ ] **Step 3: Implement `src/main.ts`**

```ts
import { existsSync, rmSync } from "node:fs";
import { configPath, loadConfig } from "./config";
import { request, socketPath } from "./ipc";
import { parseArgs, printResult } from "./cliFormat";

const HELP = `mcpmux — MCP multiplexer. Commands:
  mux call <server> <tool> [k=v ...] [--args '<json>'] [--timeout <s>] [--raw]
  mux tools <server>          mux schema <server> <tool>
  mux servers                 mux index
  mux logs [server]           mux status
  mux daemon [--stop]         mux help
Config: ${configPath()}`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
function boolFlag(argv: string[], name: string): boolean {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}

/** Entry path that works both under `bun src/main.ts` and inside a compiled binary. */
function selfCmd(extra: string[]): string[] {
  const entry = process.argv[1] ?? "";
  return entry.startsWith("/$bunfs") || entry === "" ? [process.execPath, ...extra] : [process.execPath, entry, ...extra];
}

async function daemonRequest(method: string, params: unknown): Promise<unknown> {
  const sock = socketPath();
  try { return await request(sock, method, params); }
  catch {
    if (existsSync(sock)) rmSync(sock, { force: true }); // stale socket
    Bun.spawn(selfCmd(["daemon"]), { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { return await request(sock, method, params); } catch { /* not up yet */ }
    }
    throw new Error(`daemon did not come up on ${sock} — try: mux daemon (foreground) to see why`);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv.shift() ?? "help";
  switch (cmd) {
    case "daemon": {
      if (boolFlag(argv, "--stop")) { await request(socketPath(), "shutdown", {}).catch(() => {}); return 0; }
      const { startDaemon } = await import("./daemon");
      await startDaemon();
      await new Promise(() => {}); // run forever
      return 0;
    }
    case "call": {
      const raw = boolFlag(argv, "--raw");
      const timeout = flag(argv, "--timeout");
      const argsJson = flag(argv, "--args");
      const [server, tool, ...pairs] = argv;
      if (!server || !tool) { console.error("usage: mux call <server> <tool> [k=v ...] — see: mux servers"); return 1; }
      const res = await daemonRequest("call", {
        server, tool, args: parseArgs(pairs, argsJson),
        timeoutMs: timeout ? Number(timeout) * 1000 : undefined,
      });
      return printResult(res as any, raw);
    }
    case "tools": {
      const tools = (await daemonRequest("tools", { server: argv[0] })) as { name: string; description?: string }[];
      for (const t of tools) console.log(`${t.name.padEnd(28)} — ${(t.description ?? "").split("\n")[0]}`);
      return 0;
    }
    case "schema":
      console.log(JSON.stringify(await daemonRequest("schema", { server: argv[0], tool: argv[1] }), null, 2));
      return 0;
    case "servers": {
      const list = (await daemonRequest("servers", {})) as any[];
      for (const s of list)
        console.log(`${s.name.padEnd(16)} ${s.disabled ? "disabled" : s.connected ? "connected" : "idle"}${s.note ? `  — ${s.note}` : ""}`);
      return 0;
    }
    case "index": {
      const cfg = loadConfig(); // no daemon needed: index must work in hooks even when cold
      const names = Object.entries(cfg.servers).filter(([, s]) => !s.disabled);
      if (names.length === 0) return 0;
      console.log("MCP tools available via `mux` CLI (details: mux tools <server>; call: mux call <server> <tool> key=value):");
      for (const [name, s] of names) console.log(`  ${name.padEnd(12)} — ${s.note ?? "MCP server"}`);
      return 0;
    }
    case "logs": console.log(((await daemonRequest("logs", { server: argv[0] })) as string[]).join("\n")); return 0;
    case "status": {
      try { await request(socketPath(), "ping", {}, 1500); console.log(`daemon: up (${socketPath()})`); }
      catch { console.log(`daemon: down (${socketPath()})`); }
      return 0;
    }
    default: console.log(HELP); return cmd === "help" ? 0 : 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => { console.error(String((e as Error).message ?? e)); process.exit(1); },
);
```

- [ ] **Step 4: Run e2e tests, expect pass**

Run: `~/.bun/bin/bun test test/cli.test.ts`
Expected: 6 pass. If the autostarted daemon lingers, `--stop` in afterAll cleans it.

- [ ] **Step 5: Run FULL suite + commit**

Run: `~/.bun/bin/bun test`

```bash
git add -A && git commit -m "feat: mux CLI — call/tools/schema/servers/index/logs/status with daemon autostart"
```

---

### Task 8: Binary build + install.sh + README

**Files:**
- Create: `install.sh`, `README.md`
- Modify: none

**Interfaces:**
- Consumes: everything; this task packages it.

- [ ] **Step 1: Build and smoke-test the compiled binary**

Run:
```bash
cd ~/dev/mcpmux && ~/.bun/bin/bun run build
MCPMUX_SOCKET=/tmp/mux-smoke.sock MCPMUX_CONFIG=/tmp/mux-smoke.jsonc ./dist/mux help
```
Expected: help text prints; binary is self-contained (`file dist/mux` → ELF executable).

- [ ] **Step 2: Write `install.sh`**

```sh
#!/usr/bin/env sh
# mcpmux installer: puts the mux binary into ~/.local/bin.
set -eu
REPO="${MCPMUX_REPO:-OWNER/mcpmux}"   # set on first GitHub release
BIN_DIR="${MCPMUX_BIN_DIR:-$HOME/.local/bin}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"; [ "$ARCH" = "aarch64" ] && ARCH="arm64"; [ "$ARCH" = "x86_64" ] && ARCH="x64"
URL="https://github.com/$REPO/releases/latest/download/mux-$OS-$ARCH"
mkdir -p "$BIN_DIR"
curl -fsSL "$URL" -o "$BIN_DIR/mux"
chmod +x "$BIN_DIR/mux"
echo "installed: $BIN_DIR/mux ($("$BIN_DIR/mux" --version 2>/dev/null || echo 'run: mux help'))"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "NOTE: add $BIN_DIR to PATH";; esac
```

- [ ] **Step 3: Write `README.md`**

Content requirements (write it out, ~60 lines): what mcpmux is (one paragraph, the
context-flooding problem + daemon), quickstart (config example with one stdio and one
HTTP server incl. `${ENV}` secret reference, `mux call`, `mux index`), the output
contract, guard example, env overrides table (`MCPMUX_SOCKET`, `MCPMUX_CONFIG`),
roadmap section pointing at the spec (registry picker, --from-claude, OAuth,
hooks, npm/brew — "Plan 2").

- [ ] **Step 4: Commit**

```bash
chmod +x install.sh
git add -A && git commit -m "chore: compiled binary build, installer, README"
```

---

### Task 9: Live acceptance against a real server (manual gate)

**Files:** none (verification task)

- [ ] **Step 1: Configure the GitLab MCP server for real**

Write `~/.config/mcpmux/servers.jsonc` (real config, NOT the test one):
```jsonc
{
  "servers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@yoda.digital/gitlab-mcp-server"],
      "env": { "GITLAB_PERSONAL_ACCESS_TOKEN": "${GITLAB_PAT}", "GITLAB_URL": "https://gitlab.com" },
      "guard": { "deny": ["delete_*"] },
      "note": "GitLab: MRs, Pipelines, Issues, Repos"
    }
  }
}
```

- [ ] **Step 2: Acceptance checks**

```bash
export GITLAB_PAT=<echter Token>
mux tools gitlab | head -20        # compact list, no schemas
mux call gitlab get_current_user   # returns the GitLab user JSON as text
mux index                          # one gitlab line, ~20 tokens
mux status && mux logs gitlab
```
Expected: all four behave; second `mux call` is noticeably faster (connection reuse — THE reason the daemon exists). Record timings in the commit message.

- [ ] **Step 3: Commit any fixes found, tag**

```bash
git add -A && git commit -m "test: live acceptance vs gitlab MCP — connection reuse verified" --allow-empty
git tag v0.1.0
```

---

## Deferred to Plan 2 (per spec, unchanged)

`mux add` (registry ref + `-- command` + interactive picker), `mux search`,
`--from-claude` multi-config import, `mux remove/enable/disable`, `mux auth`
(native OAuth), `mux doctor`, `mux hook install claude` (SessionStart index
injection, PreToolUse redirect, migration nudge), systemd `--install`,
npm/brew distribution, macOS/arm64 release builds.
