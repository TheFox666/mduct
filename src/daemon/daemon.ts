import { mkdirSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { configPath, loadConfig, type Config } from "../shared/config";
import { ServerConnection } from "./connection";
import { serveIpc, socketAlive, socketPath } from "../shared/ipc";

const LOG_CAP = 500;

export async function startDaemon(opts: { standalone?: boolean } = {}): Promise<{ stop(): Promise<void> }> {
  // Refuse to start over a live daemon — otherwise a racing autostart would bind a
  // second listener and orphan the first (with its MCP children) (#15).
  if (await socketAlive(socketPath())) throw new Error(`daemon already running on ${socketPath()}`);
  let config: Config = loadConfig();
  const conns = new Map<string, ServerConnection>();
  const lastUsed = new Map<string, number>();
  // structured ring buffer: each entry tags its server (or null) so `mduct logs <server>`
  // filters exactly instead of substring-matching ("lab" matched "gitlab.") (#19/N6)
  const logs: { ts: string; server: string | null; line: string }[] = [];
  const log = (line: string, server: string | null = null) => {
    logs.push({ ts: new Date().toISOString(), server, line });
    if (logs.length > LOG_CAP) logs.shift();
  };
  const renderLogs = (server?: string): string[] =>
    logs.filter((e) => !server || e.server === server).map((e) => `${e.ts} ${e.line}`);

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

  // Hot reload: watch the DIRECTORY (not the file) so it survives editor rename-replace and
  // works even when the config doesn't exist at boot (#6). Only close connections whose config
  // actually changed or was removed — an unrelated edit must not disturb a live connection (#7).
  const cfgFile = configPath();
  mkdirSync(dirname(cfgFile), { recursive: true, mode: 0o700 }); // watcher needs the dir to exist
  const reload = () => {
    let next: Config;
    try { next = loadConfig(); } catch (e) { log(`config reload FAILED: ${(e as Error).message}`); return; }
    const closed: string[] = [];
    for (const [n, c] of [...conns]) {
      const before = JSON.stringify(config.servers[n]);
      const after = JSON.stringify(next.servers[n]);
      if (before !== after) { conns.delete(n); lastUsed.delete(n); void c.close(); closed.push(n); } // delete BEFORE close (#7 race)
    }
    config = next;
    log(`config reloaded${closed.length ? ` (reconnecting: ${closed.join(", ")})` : ""}`);
  };
  const watcher = watch(dirname(cfgFile), (_evt, fname) => {
    if (fname === null || fname === basename(cfgFile)) reload();
  });

  // idle sweep
  const sweep = setInterval(() => {
    for (const [n, c] of conns) {
      const ttlMin = config.servers[n]?.idleTtlMin ?? 30;
      // never close a connection with queued/running calls, even past the TTL (#23)
      if (!c.busy && c.connectedSince && Date.now() - (lastUsed.get(n) ?? 0) > ttlMin * 60_000) {
        log(`idle-closing ${n}`, n);
        void c.close();
      }
    }
  }, 60_000);

  let stopFn: () => Promise<void>;
  const srv = await serveIpc(socketPath(), async (method, p) => {
    switch (method) {
      case "ping": return "pong";
      case "call": {
        log(`call ${p.server}.${p.tool}`, p.server);
        try { return await conn(p.server).call(p.tool, p.args ?? {}, p.timeoutMs); }
        catch (e) { log(`call ${p.server}.${p.tool} FAILED: ${(e as Error).message}`, p.server); throw e; }
      }
      case "tools": return await conn(p.server).listTools();
      case "schema": {
        const tools = await conn(p.server).listTools();
        const t = tools.find((x) => x.name === p.tool);
        if (!t) throw new Error(`unknown tool "${p.tool}" on "${p.server}" — see: mduct tools ${p.server}`);
        return t.inputSchema ?? {};
      }
      case "servers":
        return Object.entries(config.servers).map(([name, cfg]) => ({
          name,
          connected: conns.get(name)?.connectedSince != null,
          disabled: !!cfg.disabled,
          note: cfg.note,
        }));
      case "logs": return renderLogs(p?.server);
      case "shutdown": setTimeout(() => void stopFn(), 20); return "bye";
      default: throw new Error(`unknown method ${method}`);
    }
  });

  stopFn = async () => {
    clearInterval(sweep);
    watcher?.close();
    srv.stop();
    await Promise.all([...conns.values()].map((c) => c.close()));
    // ponytail: as the standalone daemon process, force exit after the graceful close — a lingering
    // child-MCP pipe handle must never keep it alive past shutdown (was the test-daemon leak; also
    // any prod bounce). NOT when embedded in-process (tests) — that would kill the caller.
    if (opts.standalone) process.exit(0);
  };
  log("daemon up");
  return { stop: stopFn };
}

if (import.meta.main) void startDaemon({ standalone: true });
