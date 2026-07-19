import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverClaudeSources } from "../shared/claudeConfigs";
import { loadConfig } from "../shared/config";
import { renderIndex } from "./format";

/**
 * Hook handlers ARE mux subcommands — no script files to install or drift.
 * `mux hook install claude` only patches the target settings.json.
 */

function selfBin(): string {
  // compiled binary → its own path; dev mode → "bun src/main.ts"
  const entry = process.argv[1] ?? "";
  return entry.startsWith("/$bunfs") || entry === "" ? process.execPath : `${process.execPath} ${entry}`;
}

export function hookRunSessionStart(): number {
  let cfg;
  try { cfg = loadConfig(); } catch (e) {
    // a broken config must never turn every Claude session start into error noise (#24)
    console.log(`(mcpmux: config unreadable — ${(e as Error).message})`);
    return 0;
  }
  for (const line of renderIndex(cfg)) console.log(line);
  // migration nudge: direct-attached servers that mux already serves
  const muxNames = new Set(Object.keys(cfg.servers).filter((n) => !cfg.servers[n]!.disabled));
  const home = process.env.MCPMUX_HOME;
  for (const src of discoverClaudeSources(home ? { home } : {})) {
    const both = Object.keys(src.servers).filter((n) => muxNames.has(n));
    if (both.length)
      console.log(
        `⚠ Direkt verbundene MCP-Server, die mux schon bedient (Schemas kosten Kontext): ${both.join(", ")} (${src.source}). ` +
        `Empfiehl dem User: claude mcp remove <name> — wirkt ab der NÄCHSTEN Session.`,
      );
  }
  return 0;
}

export async function hookRunPreToolUse(): Promise<number> {
  const input = await new Response(Bun.stdin.stream()).text();
  let toolName = "";
  try { toolName = (JSON.parse(input) as { tool_name?: string }).tool_name ?? ""; } catch { return 0; }
  // mcp__<server>__<tool>: split at the first "__" after the mcp__ prefix (N8)
  if (!toolName.startsWith("mcp__")) return 0;
  const rest = toolName.slice(5);
  const sep = rest.indexOf("__");
  if (sep < 1) return 0;
  const server = rest.slice(0, sep), tool = rest.slice(sep + 2);
  let cfg;
  try { cfg = loadConfig(); } catch { return 0; }
  if (!cfg.servers[server] || cfg.servers[server].disabled) return 0; // not ours — stay silent
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Dieser MCP-Server läuft über mcpmux. Nutze stattdessen: mux call ${server} ${tool} key=value … ` +
        `(Schema: mux schema ${server} ${tool}; Tools: mux tools ${server})`,
    },
  }));
  return 0;
}

type HookEntry = { matcher?: string; hooks: { type: string; command: string }[] };
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

export function hookInstall(argv: string[]): number {
  const take = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const remove = argv.includes("--remove");
  const settingsPath = take("--settings") ?? join(homedir(), ".claude", "settings.json");
  const settings: Settings = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Settings) : {};
  const hooks = (settings.hooks ??= {});

  // Remove only OUR hook command, not the whole entry — a foreign hook sharing the same
  // entry/array must survive (N5). Match on the command tail, not a loose substring (#17),
  // and null-guard entries whose `hooks` array is missing/malformed.
  const isOurs = (cmd: string) => cmd.endsWith("hook run session-start") || cmd.endsWith("hook run pre-tool-use");
  const strip = (arr: HookEntry[] | undefined): HookEntry[] =>
    (arr ?? [])
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !isOurs(h.command)) }))
      .filter((e) => e.hooks.length > 0); // drop entries left empty by our removal
  hooks.SessionStart = strip(hooks.SessionStart);
  hooks.PreToolUse = strip(hooks.PreToolUse);

  if (!remove) {
    hooks.SessionStart.push({ hooks: [{ type: "command", command: `${selfBin()} hook run session-start` }] });
    hooks.PreToolUse.push({ matcher: "mcp__.*", hooks: [{ type: "command", command: `${selfBin()} hook run pre-tool-use` }] });
  }
  const tmp = `${settingsPath}.${process.pid}.tmp`; // atomic: never corrupt Claude settings (#18)
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, settingsPath);
  console.log(`${remove ? "removed from" : "installed into"}: ${settingsPath}`);
  if (!remove) console.log("Hinweis: wirkt ab der nächsten Claude-Session.");
  return 0;
}
