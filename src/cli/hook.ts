import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverClaudeSources } from "../shared/claudeConfigs";
import { loadConfig } from "../shared/config";

/**
 * Hook handlers ARE mux subcommands — no script files to install or drift.
 * `mux hook install claude` only patches the target settings.json.
 */

// Identifies our entries for idempotency/removal. Deliberately NOT "mux hook run":
// in dev mode the command is "bun src/main.ts hook run …" — no "mux" in it.
const MARKER = " hook run ";

function selfBin(): string {
  // compiled binary → its own path; dev mode → "bun src/main.ts"
  const entry = process.argv[1] ?? "";
  return entry.startsWith("/$bunfs") || entry === "" ? process.execPath : `${process.execPath} ${entry}`;
}

export function hookRunSessionStart(): number {
  const cfg = loadConfig();
  const names = Object.entries(cfg.servers).filter(([, s]) => !s.disabled);
  if (names.length) {
    console.log("MCP tools available via `mux` CLI (details: mux tools <server>; call: mux call <server> <tool> key=value):");
    for (const [name, s] of names) console.log(`  ${name.padEnd(12)} — ${s.note ?? "MCP server"}`);
  }
  // migration nudge: direct-attached servers that mux already serves
  const muxNames = new Set(names.map(([n]) => n));
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
  const m = toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (!m) return 0;
  const [, server, tool] = m;
  const cfg = loadConfig();
  if (!server || !cfg.servers[server] || cfg.servers[server].disabled) return 0; // not ours — stay silent
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

  const strip = (arr: HookEntry[] | undefined): HookEntry[] =>
    (arr ?? []).filter((e) => !e.hooks.some((h) => h.command.includes(MARKER)));
  hooks.SessionStart = strip(hooks.SessionStart);
  hooks.PreToolUse = strip(hooks.PreToolUse);

  if (!remove) {
    hooks.SessionStart.push({ hooks: [{ type: "command", command: `${selfBin()} hook run session-start` }] });
    hooks.PreToolUse.push({ matcher: "mcp__.*", hooks: [{ type: "command", command: `${selfBin()} hook run pre-tool-use` }] });
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`${remove ? "removed from" : "installed into"}: ${settingsPath}`);
  if (!remove) console.log("Hinweis: wirkt ab der nächsten Claude-Session.");
  return 0;
}
