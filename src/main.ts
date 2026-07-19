import { configPath, loadConfig } from "./shared/config";
import { isTransportError, request, socketPath } from "./shared/ipc";
import { parseArgs, printResult } from "./cli/format";

const HELP = `mcpmux — MCP multiplexer. Commands:
  mux call <server> <tool> [k=v ...] [--args '<json>'] [--timeout <s>] [--raw]
  mux tools <server>          mux schema <server> <tool>
  mux servers                 mux index
  mux add <name> --url <u> | -- <cmd…>   mux remove/enable/disable <name>
  mux import [name…]          mux search <query>
  mux secret set/list/rm <NAME>   mux doctor
  mux auth <server>          mux hook install claude [--remove]
  mux run <tool> [args…]      mux tool status / setup <name>
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

/** Entry command that works under `bun src/main.ts` AND inside a compiled binary. */
function selfCmd(extra: string[]): string[] {
  const entry = process.argv[1] ?? "";
  return entry.startsWith("/$bunfs") || entry === "" ? [process.execPath, ...extra] : [process.execPath, entry, ...extra];
}

async function daemonRequest(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
  const sock = socketPath();
  try { return await request(sock, method, params, timeoutMs); }
  catch (e) {
    if (!isTransportError(e)) throw e; // application error — daemon is fine, don't respawn (#1)
    Bun.spawn(selfCmd(["daemon"]), { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { return await request(sock, method, params, timeoutMs); }
      catch (e2) { if (!isTransportError(e2)) throw e2; /* daemon up, real error — surface it (N3) */ }
    }
    throw new Error(`daemon did not come up on ${sock} — try: mux daemon (foreground) to see why`);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv.shift() ?? "help";
  switch (cmd) {
    case "daemon": {
      if (boolFlag(argv, "--stop")) { await request(socketPath(), "shutdown", {}, 3000).catch(() => {}); return 0; }
      if (boolFlag(argv, "--install")) { const { installSystemd } = await import("./cli/systemd"); return await installSystemd(); }
      const { startDaemon } = await import("./daemon/daemon");
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
      let timeoutMs: number | undefined;
      if (timeout !== undefined) {
        const n = Number(timeout);
        if (!Number.isFinite(n) || n <= 0) { console.error(`bad --timeout "${timeout}" — seconds, e.g. --timeout 30`); return 1; }
        timeoutMs = n * 1000;
      }
      // IPC wait must outlast the tool timeout, or a legit long call is killed at the 120s default (#11)
      const ipcTimeout = timeoutMs ? timeoutMs + 10_000 : undefined;
      const res = await daemonRequest("call", { server, tool, args: parseArgs(pairs, argsJson), timeoutMs }, ipcTimeout);
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
      const list = (await daemonRequest("servers", {})) as { name: string; connected: boolean; disabled: boolean; note?: string }[];
      // instance header on stderr so it's visible to humans but stdout stays clean for parsing
      process.stderr.write(`# instance: ${configPath()}\n`);
      for (const s of list)
        console.log(`${s.name.padEnd(16)} ${s.disabled ? "disabled" : s.connected ? "connected" : "idle"}${s.note ? `  — ${s.note}` : ""}`);
      return 0;
    }
    case "index": {
      const { renderIndex } = await import("./cli/format");
      for (const line of renderIndex(loadConfig())) console.log(line); // no daemon needed — works cold in hooks
      return 0;
    }
    case "run": {
      const { cmdRun } = await import("./cli/tool");
      return await cmdRun(argv);
    }
    case "tool": {
      const { cmdTool } = await import("./cli/tool");
      return await cmdTool(argv);
    }
    case "add": {
      if (argv.length === 0) { const { runPicker } = await import("./cli/picker"); return await runPicker(); }
      const { cmdAdd } = await import("./cli/manage");
      return await cmdAdd(argv);
    }
    case "search": {
      const { cmdSearch } = await import("./cli/manage");
      return await cmdSearch(argv[0]);
    }
    case "secret": {
      const { cmdSecret } = await import("./cli/secret");
      return await cmdSecret(argv);
    }
    case "auth": {
      const { cmdAuth } = await import("./cli/auth");
      return await cmdAuth(argv);
    }
    case "hook": {
      const sub = argv.shift();
      const { hookInstall, hookRunPreToolUse, hookRunSessionStart } = await import("./cli/hook");
      if (sub === "install" && argv[0] === "claude") { argv.shift(); return hookInstall(argv); }
      if (sub === "run" && argv[0] === "session-start") return hookRunSessionStart();
      if (sub === "run" && argv[0] === "pre-tool-use") return await hookRunPreToolUse();
      console.error("usage: mux hook install claude [--settings <file>] [--remove] | mux hook run session-start|pre-tool-use");
      return 1;
    }
    case "doctor": {
      const { cmdDoctor } = await import("./cli/doctor");
      return await cmdDoctor();
    }
    case "import": {
      const { cmdImport } = await import("./cli/importCmd");
      return cmdImport(argv);
    }
    case "remove": {
      const { cmdRemove } = await import("./cli/manage");
      return cmdRemove(argv[0]);
    }
    case "enable":
    case "disable": {
      const { cmdSetDisabled } = await import("./cli/manage");
      return cmdSetDisabled(argv[0], cmd === "disable");
    }
    case "logs": console.log(((await daemonRequest("logs", { server: argv[0] })) as string[]).join("\n")); return 0;
    case "status": {
      const { secretsPath } = await import("./shared/secrets");
      const sock = socketPath();
      let up = false;
      try { up = (await request(sock, "ping", {}, 1500)) === "pong"; } catch { /* down */ }
      // print the full instance identity so it's obvious WHICH mux (personal vs office etc.)
      console.log(`daemon:  ${up ? "up" : "down"}`);
      console.log(`socket:  ${sock}`);
      console.log(`config:  ${configPath()}`);
      console.log(`secrets: ${secretsPath()}`);
      return 0;
    }
    default: console.log(HELP); return cmd === "help" ? 0 : 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => { console.error(String((e as Error).message ?? e)); process.exit(1); },
);
