import { configPath, loadConfig } from "./shared/config";
import { isTransportError, request, socketPath } from "./shared/ipc";
import { parseArgs, printResult } from "./cli/format";

function helpText(): string {
  return `mduct — one CLI in front of every MCP server + CLI tool.
Tool schemas stay OUT of your model context; you call them on demand through mduct.
A background daemon keeps connections (and OAuth sessions) warm between calls.

USAGE
  mduct <command> [args]

CALL & RUN
  call <server> <tool> [key=value …]   invoke an MCP tool. key=value = scalar (coerced);
       [key:=<json> …]                        key:=<json> = a JSON value (arrays/objects/typed);
       [--args '<json>' | - | @file]          --args merges an object (- = stdin, @file = a file)
       [--timeout <s>] [--raw] [--json]       --raw = full envelope; --json = only the JSON payload (pipe-ready)
       [--compact] [--full]                   --compact minifies output; --full bypasses the oversized-list guard
  run <tool> [args …]                  run a CLI tool (kubectl/aws/…) with its stored env/wrapping
  tools <server>                       list a server's tools (compact — no schemas)
  schema <server> <tool>               full JSON schema of one tool
  index                                the compact capability block (for prompts / hooks)

SERVERS
  servers                              configured MCP servers + connection state
  add                                  no args → interactive picker (↑↓, / search, ⏎ toggle)
  add <name> -- <cmd …>                add a stdio MCP server
  add <name> --url <url>               add an http MCP server
  add <ref>                            install from the public registry (version-pinned)
  add <name> --tool -- <cmd …>         add a CLI tool  [--check --setup --env K=V --note]
  remove | enable | disable <name>     remove / toggle a server or tool
  search <query>                       search the public MCP registry
  import [<name> …]                    import MCP servers from your Claude configs

CLI TOOLS
  tool status                          installed? + update hint for pinned npm tools
  tool setup <name>                    run a tool's installer
  tool update [<name>]                 bump a pinned npm tool to the latest version

SECRETS & AUTH
  secret set <NAME>                    store a secret (piped or hidden prompt) → ref as \${NAME}
  secret list | rm <NAME>              list names (never values) / remove one
  auth <server>                        OAuth sign-in for an http server (token stored, auto-refreshed)

DAEMON & SETUP
  status                               daemon up? + which instance (socket/config/secrets)
  logs [server]                        recent daemon activity (per server if named)
  shadow                               shadow nudges vs follow-up calls (did the redirect convert?)
  daemon [--stop | --install]          run in foreground / stop / install a systemd user unit
  hook install claude [--remove]       inject \`mduct index\` at session start + redirect mcp__* calls
  doctor                               report MCP servers attached directly that mduct already serves
  config [compact on|off]              show / set per-instance defaults (e.g. compact output)
  help                                 this help

INSTANCES
  A named instance is one env var: MDUCT_PROFILE=<name> → ~/.config/mduct-<name>/ with its own
  config, secrets, auth and daemon socket (mirrors ~/.claude vs ~/.claude-<profile>).
  No profile → the default ~/.config/mduct/. \`mduct status\` shows which instance answered.

PIPING (keep big outputs OUT of your context — lossless)
  --json emits ONLY the JSON payload (prose stripped), so \`| jq\` works on any
  server; only the filtered result lands in your context, the full blob never does.
  (--json also bypasses the oversized-list guard, since you're slimming it yourself.)
    # 20 issues as a few fields each, not full bodies (measured: 24.5k → 1.8k chars):
    mduct call linear-server list_issues limit=20 --json | jq -c '.issues|map({id,title,status})'
    # GitLab prefixes prose ("Found N …") — --json strips it so this still pipes clean:
    mduct call gitlab list_merge_requests project_id=grp/proj state=opened --json | jq -c 'map({iid,title,web_url})'
    # don't know the shape? peek once, then project the fields you need:
    mduct call <server> <tool> --json | jq 'if type=="array" then .[0] else . end | keys'
    # combine calls — list, then fetch each (project the second call too):
    mduct call <server> list_x --json | jq -r '.[].id' | while read i; do mduct call <server> get_x id=$i --json | jq -c '{id,title}'; done

EXAMPLES
  mduct call gitlab list_issues state=opened labels:='["bug"]'
  mduct call gitlab search_repositories search="parser" --timeout 30
  mduct run kubectl get pods -n default
  echo "\$TOKEN" | mduct secret set GITLAB_PAT
  mduct add com.linear/mcp --as linear
  MDUCT_PROFILE=office mduct servers

Config: ${configPath()}`;
}

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
    throw new Error(`daemon did not come up on ${sock} — try: mduct daemon (foreground) to see why`);
  }
}

/** After a failed `call`, fetch the tool's signature (or near-name suggestions) so the fix is obvious. */
async function callErrorHint(server: string, tool: string): Promise<string> {
  try {
    const { toolSignature } = await import("./cli/format");
    const tools = (await daemonRequest("tools", { server })) as { name: string; inputSchema?: unknown }[];
    const t = tools.find((x) => x.name === tool);
    if (t) return `\n  expected: ${tool}${toolSignature(t.inputSchema)}  (full schema: mduct schema ${server} ${tool})`;
    const near = tools.map((x) => x.name).filter((n) => n.includes(tool) || tool.includes(n)).slice(0, 5);
    return `\n  no tool "${tool}" on "${server}"${near.length ? ` — did you mean: ${near.join(", ")}` : ""}  (list: mduct tools ${server})`;
  } catch {
    return ""; // hint is best-effort; never mask the original error
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
      await startDaemon({ standalone: true }); // this process IS the daemon → force-exit on shutdown
      await new Promise(() => {}); // run forever
      return 0;
    }
    case "call": {
      const raw = boolFlag(argv, "--raw");
      const jsonOut = boolFlag(argv, "--json"); // emit only the JSON payload (prose stripped) — clean to pipe
      const full = boolFlag(argv, "--full"); // bypass the size guard: dump it all (human-readable)
      // compact: explicit --compact/--no-compact wins; otherwise the config default (mduct config compact on)
      const noCompact = boolFlag(argv, "--no-compact");
      const compactFlag = boolFlag(argv, "--compact");
      const defaults = loadConfig().defaults;
      const compact = noCompact ? false : compactFlag ? true : (defaults?.compact ?? false);
      const warnAbove = defaults?.warnAbove;
      const timeout = flag(argv, "--timeout");
      let argsJson = flag(argv, "--args");
      // --args - reads JSON from stdin; --args @file from a file — heredoc complex args with no shell quoting
      if (argsJson === "-") argsJson = await new Response(Bun.stdin.stream()).text();
      else if (argsJson?.startsWith("@")) { const { readFileSync } = await import("node:fs"); argsJson = readFileSync(argsJson.slice(1), "utf8"); }
      const [server, tool, ...pairs] = argv;
      if (!server || !tool) { console.error("usage: mduct call <server> <tool> [key=value ...] — see: mduct servers"); return 1; }
      let timeoutMs: number | undefined;
      if (timeout !== undefined) {
        const n = Number(timeout);
        if (!Number.isFinite(n) || n <= 0) { console.error(`bad --timeout "${timeout}" — seconds, e.g. --timeout 30`); return 1; }
        timeoutMs = n * 1000;
      }
      const ipcTimeout = timeoutMs ? timeoutMs + 10_000 : undefined; // IPC wait must outlast the tool timeout (#11)
      // only an ARGS / not-found error gets a signature hint — a domain failure (a tool that ran
      // and errored for its own reasons) shouldn't be nagged with "expected: <signature>"
      const ARGS_ERR = /-32602|validation|invalid arguments?|is required|missing|no tool|not found|unknown tool/i;
      try {
        const res = await daemonRequest("call", { server, tool, args: parseArgs(pairs, argsJson), timeoutMs }, ipcTimeout) as { content?: { type?: string; text?: string }[]; isError?: boolean };
        const code = printResult(res as any, { raw, json: jsonOut, compact, full, warnAbove, server, tool });
        if (code === 1 && !raw) { // real server/arg error only — the size guard (2) isn't one
          const text = (res.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(" ");
          if (ARGS_ERR.test(text)) process.stderr.write((await callErrorHint(server, tool)).replace(/^\n/, "") + "\n");
        }
        return code;
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        console.error(msg + (ARGS_ERR.test(msg) ? await callErrorHint(server, tool) : ""));
        return 1;
      }
    }
    case "tools": {
      const { toolSignature } = await import("./cli/format");
      const tools = (await daemonRequest("tools", { server: argv[0] })) as { name: string; description?: string; inputSchema?: unknown }[];
      // name + arg signature up front so you see calls AND args without a separate `mduct schema`
      for (const t of tools) console.log(`${(t.name + toolSignature(t.inputSchema)).padEnd(34)} — ${(t.description ?? "").split("\n")[0]}`);
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
    case "config": {
      const cfg = loadConfig();
      if (argv.length === 0) {
        console.log(`compact:   ${cfg.defaults?.compact ? "on" : "off"}   (minify JSON output of \`mduct call\`)`);
        console.log(`warnAbove: ${cfg.defaults?.warnAbove ? `${cfg.defaults.warnAbove} chars` : "off"}   (warn + suggest a jq projection instead of dumping an oversized list; --full bypasses)`);
        return 0;
      }
      if (argv[0] === "compact" && (argv[1] === "on" || argv[1] === "off")) {
        const { setDefault } = await import("./shared/configEdit");
        setDefault("compact", argv[1] === "on");
        console.log(`compact default → ${argv[1]}`);
        return 0;
      }
      if (argv[0] === "warnAbove" && argv[1]) {
        const { setDefault } = await import("./shared/configEdit");
        if (argv[1] === "off") { setDefault("warnAbove", undefined); console.log("warnAbove default → off"); return 0; }
        const n = Number(argv[1]);
        if (!Number.isInteger(n) || n <= 0) { console.error(`bad size "${argv[1]}" — chars (e.g. 25000) or off`); return 1; }
        setDefault("warnAbove", n);
        console.log(`warnAbove default → ${n} chars`);
        return 0;
      }
      console.error("usage: mduct config                  # show defaults\n       mduct config compact on|off       # minify JSON output by default\n       mduct config warnAbove <chars|off> # guard against oversized dumps (e.g. 25000)");
      return 1;
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
      console.error("usage: mduct hook install claude [--settings <file>] [--remove] | mduct hook run session-start|pre-tool-use");
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
    case "shadow": {
      // the only honest answer to "is the redirect worth its friction" is the log
      const { conversion, readEvents, logPath } = await import("./cli/shadow");
      const rows = conversion();
      if (!rows.length) { console.log(`keine shadow-Events bisher (${logPath()})`); return 0; }
      console.log("server         nudges  converted");
      for (const r of rows) console.log(`  ${r.server.padEnd(12)} ${String(r.nudges).padStart(6)} ${String(r.converted).padStart(10)}`);
      console.log(`\n${readEvents().length} Events — ${logPath()}`);
      return 0;
    }
    case "status": {
      const { secretsPath } = await import("./shared/secrets");
      const sock = socketPath();
      let up = false;
      try { up = (await request(sock, "ping", {}, 1500)) === "pong"; } catch { /* down */ }
      // print the full instance identity so it's obvious WHICH mduct (personal vs office etc.)
      console.log(`daemon:  ${up ? "up" : "down (lazy — autostarts on the next call)"}`);
      console.log(`socket:  ${sock}`);
      console.log(`config:  ${configPath()}`);
      console.log(`secrets: ${secretsPath()}`);
      return 0;
    }
    default: console.log(helpText()); return cmd === "help" ? 0 : 1;
  }
}

/**
 * Exit AFTER stdout/stderr have drained. process.exit() drops un-drained writes to a slow pipe —
 * a big `--json` result read by jq (which buffers before parsing) fills the ~64KB pipe buffer, and
 * exiting mid-write truncates it. The empty write's callback fires behind all prior chunks, so
 * awaiting it is a flush barrier.
 */
async function flushExit(code: number): Promise<void> {
  await Promise.all([
    new Promise<void>((r) => process.stdout.write("", () => r())),
    new Promise<void>((r) => process.stderr.write("", () => r())),
  ]);
  process.exit(code);
}
main().then(
  (code) => flushExit(code),
  (e) => { console.error(String((e as Error).message ?? e)); void flushExit(1); },
);
