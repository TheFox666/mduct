import { existsSync, watch } from "node:fs";
import { configPath, loadConfig, type Config } from "../shared/config";
import { ServerConnection } from "./connection";
import { serveIpc, socketPath } from "../shared/ipc";

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
        }));
      case "logs":
        return p?.server ? logs.filter((l) => l.includes(`${p.server}.`) || l.includes(` ${p.server} `)) : logs;
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
