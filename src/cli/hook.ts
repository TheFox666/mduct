import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverClaudeSources } from "../shared/claudeConfigs";
import { loadConfig } from "../shared/config";
import { codexConfigPath } from "./codex";
import { renderIndex } from "./format";
import { available, findHit, mductCallServer, readEvents, record, shadowMatcher } from "./shadow";
import { home } from "../shared/paths";

/**
 * Hook handlers ARE mduct subcommands — no script files to install or drift.
 * `mduct hook install claude|codex` only patches the target settings file.
 */

function selfBin(): string {
  // compiled binary → its own path; dev mode → "bun src/main.ts"
  const entry = process.argv[1] ?? "";
  return entry.startsWith("/$bunfs") || entry === "" ? process.execPath : `${process.execPath} ${entry}`;
}

/** Same resolution, split for a place that wants command and args separately (MCP registration). */
function selfExec(extra: string[]): { command: string; args: string[] } {
  const entry = process.argv[1] ?? "";
  return entry.startsWith("/$bunfs") || entry === ""
    ? { command: process.execPath, args: extra }
    : { command: process.execPath, args: [entry, ...extra] };
}

/**
 * Where user-scope MCP servers live: `~/.claude.json`, a different file from settings.json.
 *
 * Derived from the settings path rather than resolved independently, because `--settings` means
 * "operate on THAT Claude installation" and a second path that ignores it is a trap. It was one:
 * a test running `hook install --remove --settings <tmpdir>` unregistered the real catalogue from
 * the developer's own home. Twice, in different forms. An explicit --settings now keeps everything
 * it touches in one place.
 */
function mcpConfigPath(settingsPath?: string): string {
  if (process.env.MDUCT_CLAUDE_MCP_CONFIG) return process.env.MDUCT_CLAUDE_MCP_CONFIG;
  const dflt = join(home(), ".claude", "settings.json");
  return settingsPath && settingsPath !== dflt
    ? join(dirname(settingsPath), ".claude.json")
    : join(home(), ".claude.json");
}

function catalogueWanted(): boolean {
  try { return Object.values(loadConfig().servers).some((s) => s.mcpCatalog && !s.disabled); }
  catch { return false; }
}

function mcpRegistered(): boolean {
  try {
    const j = JSON.parse(readFileSync(mcpConfigPath(), "utf8")) as { mcpServers?: Record<string, unknown> };
    return !!j.mcpServers?.mduct;
  } catch { return false; }
}

/**
 * Register (or drop) the catalogue server alongside the hooks.
 *
 * Two files, one install: hooks go to settings.json, MCP servers to .claude.json. Leaving the
 * second to the user means an install that half-works and a catalogue nobody sees.
 */
function syncMcpRegistration(remove: boolean, settingsPath: string): string | null {
  const p = mcpConfigPath(settingsPath);
  let j: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (existsSync(p)) {
    try { j = JSON.parse(readFileSync(p, "utf8")) as typeof j; }
    catch { return `⚠ ${p} is not readable JSON — register manually: claude mcp add mduct -- mduct mcp`; }
  }
  const had = !!j.mcpServers?.mduct;
  // Only --remove deletes. Removing it merely because THIS config declares no catalogue would tear
  // out a registration that another config (another profile, a test, a one-off MDUCT_CONFIG) put
  // there — which is exactly what happened: the test suite quietly unregistered the real one.
  if (remove) {
    if (!had) return null;
    delete j.mcpServers!.mduct;
  } else if (!catalogueWanted()) {
    return null; // nothing to add, nothing of ours to take away
  } else {
    const { command, args } = selfExec(["mcp"]);
    j.mcpServers = { ...(j.mcpServers ?? {}), mduct: { type: "stdio", command, args, env: {} } };
  }
  const tmp = `${p}.${process.pid}.tmp`; // atomic: never corrupt Claude's own config
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n");
  renameSync(tmp, p);
  return remove ? `removed the mduct MCP catalogue from ${p}` : `registered the mduct MCP catalogue in ${p}`;
}

export function hookRunSessionStart(): number {
  let cfg;
  try { cfg = loadConfig(); } catch (e) {
    // a broken config must never turn every Claude session start into error noise (#24)
    console.log(`(mduct: config unreadable — ${(e as Error).message})`);
    return 0;
  }
  for (const line of renderIndex(cfg)) console.log(line);
  // Shadow rules only fire if the installed PreToolUse matcher covers their tools. Editing the
  // config can't reach settings.json, so the drift is checked HERE instead of being a silent no-op.
  // same drift check for the catalogue: declared in servers.jsonc, registered in .claude.json
  if (catalogueWanted() && !mcpRegistered())
    console.log("⚠ mduct: a server declares mcpCatalog, but the mduct MCP server is not registered — run `mduct hook install <claude|codex>` once.");
  const needed = shadowMatcher(cfg);
  if (needed && !installedMatcherCovers(needed))
    console.log(`⚠ mduct: shadow rules are declared, but the installed PreToolUse matcher does not cover them (${needed}) — run \`mduct hook install <claude|codex>\` again.`);
  // migration nudge: direct-attached servers that mduct already serves
  const muxNames = new Set(Object.keys(cfg.servers).filter((n) => !cfg.servers[n]!.disabled));
  const home = process.env.MDUCT_HOME;
  for (const src of discoverClaudeSources(home ? { home } : {})) {
    const both = Object.keys(src.servers).filter((n) => muxNames.has(n));
    if (both.length)
      console.log(
        `⚠ MCP servers attached directly while mduct already serves them (you pay for those schemas): ${both.join(", ")} (${src.source}). ` +
        `Tell the user: claude mcp remove <name> — effective from the NEXT session.`,
      );
  }
  return 0;
}

type PreToolUseInput = {
  tool_name?: string;
  tool_input?: { command?: string | string[]; cmd?: string | string[] };
  cwd?: string;
  session_id?: string;
};

/**
 * Claude passes a shell command as a string; Codex's shell tools pass argv (`["bash","-lc","grep …"]`)
 * and `exec_command` calls the field `cmd`. Joining argv is enough for rule matching — a `bash` regex
 * looks for the program name, and it is in there either way.
 */
function commandOf(input: PreToolUseInput["tool_input"]): string {
  const v = input?.command ?? input?.cmd;
  return Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : "";
}

export async function hookRunPreToolUse(): Promise<number> {
  const input = await new Response(Bun.stdin.stream()).text();
  let ev: PreToolUseInput = {};
  try { ev = JSON.parse(input) as PreToolUseInput; } catch { return 0; }
  const toolName = ev.tool_name ?? "";
  // mcp__<server>__<tool>: split at the first "__" after the mcp__ prefix (N8)
  if (!toolName.startsWith("mcp__")) return shadowBranch(ev, toolName);
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
        `This MCP server runs through mduct. Use instead: mduct call ${server} ${tool} key=value … ` +
        `(schema: mduct schema ${server} ${tool}; tools: mduct tools ${server})`,
    },
  }));
  return 0;
}

/**
 * Does the installed hook entry already listen for these tools? Unreadable settings → assume yes
 * (stay quiet). Checked for whichever harness is actually installed: no Claude hook and no Codex
 * block means the drift warning has nothing to say.
 */
function installedMatcherCovers(needed: string): boolean {
  const wants = needed.split("|");
  const p = process.env.MDUCT_CLAUDE_SETTINGS ?? join(home(), ".claude", "settings.json");
  let entries: HookEntry[] = [];
  try { entries = (JSON.parse(readFileSync(p, "utf8")) as Settings).hooks?.PreToolUse ?? []; } catch { /* fall through to Codex */ }
  const ours = entries.filter((e) => (e.hooks ?? []).some((h) => h.command.endsWith("hook run pre-tool-use")));
  if (ours.length) return wants.every((tool) => ours.some((e) => (e.matcher ?? "").split("|").includes(tool)));

  // Codex: one managed block, one matcher line, read as text — a TOML parser for this would be silly.
  try {
    const toml = readFileSync(codexConfigPath(), "utf8");
    if (!toml.includes("hook run pre-tool-use")) return true;
    const m = toml.match(/matcher = "([^"]*)"/);
    return !!m && wants.every((tool) => m[1]!.split("|").includes(tool));
  } catch { return true; } // installed nowhere — that's a different problem, not this warning's
}

/**
 * The other half of PreToolUse: a call mduct did NOT get, but a configured server could have served.
 * A token bucket decides how often it may say so — a redirect, never a ban, and grep works on the
 * retry. Every fire is logged, and so is every later `mduct call`, because "does the redirect convert"
 * is a question only the log can answer.
 */
function shadowBranch(ev: PreToolUseInput, toolName: string): number {
  const command = commandOf(ev.tool_input);
  const session = ev.session_id ?? "unknown";
  let cfg;
  try { cfg = loadConfig(); } catch { return 0; }

  // conversion signal: the agent reached for a mduct server on its own (or after a nudge)
  const used = mductCallServer(command);
  if (used && cfg.servers[used]) {
    record({ ts: new Date().toISOString(), session, kind: "use", server: used });
    return 0;
  }

  const hit = findHit(cfg, toolName, command, ev.cwd ?? "");
  if (!hit) return 0;
  // bucket empty → stay out of the way until it refills
  const tokens = available(readEvents(), session, hit.server, hit.rule, hit.budget, hit.refillMin, Date.now());
  if (tokens < 1) return 0;
  record({ ts: new Date().toISOString(), session, kind: "nudge", server: hit.server, rule: hit.rule, tool: toolName });
  const left = tokens - 1;
  const bucket = hit.refillMin
    ? `${left}/${hit.budget} left, +1 every ${hit.refillMin} min`
    : `${left}/${hit.budget} left this session`;

  // A hint does not have to cost a turn. `additionalContext` rides along with the tool result, so
  // the command RUNS and the note arrives anyway — the friction the deny-and-retry version charged
  // for every single nudge simply is not needed. Deliberately no permissionDecision: "allow" would
  // auto-approve a call that should have asked, and a nudge must never widen permissions.
  const note = `${hit.hint}\n\n(mduct, server "${hit.server}" — ${bucket}. This ran; the note is for the next one.)`;
  console.log(JSON.stringify(
    hit.block
      ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: note } }
      : { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: note } },
  ));
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
  const settingsPath = take("--settings") ?? join(home(), ".claude", "settings.json");
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
    // Shadowed tool names come from the config, so the matcher stays as narrow as the rules require —
    // no config declaring shadows means no extra process per Bash/Grep call, exactly as before.
    let matcher = "mcp__.*";
    try {
      const extra = shadowMatcher(loadConfig());
      if (extra) matcher = `mcp__.*|${extra}`;
    } catch { /* broken config: install the base hook rather than nothing */ }
    hooks.PreToolUse.push({ matcher, hooks: [{ type: "command", command: `${selfBin()} hook run pre-tool-use` }] });
  }
  const tmp = `${settingsPath}.${process.pid}.tmp`; // atomic: never corrupt Claude settings (#18)
  mkdirSync(dirname(settingsPath), { recursive: true }); // a machine that never ran Claude has no ~/.claude
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, settingsPath);
  console.log(`${remove ? "removed from" : "installed into"}: ${settingsPath}`);
  const mcp = syncMcpRegistration(remove, settingsPath);
  if (mcp) console.log(mcp);
  if (!remove) console.log("Takes effect in the next Claude session.");
  return 0;
}
