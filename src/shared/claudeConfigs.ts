import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerCfg } from "./config";

export type ClaudeSource = { source: string; servers: Record<string, ServerCfg> };

type RawEntry = {
  command?: string; args?: string[]; env?: Record<string, string>;
  type?: string; url?: string; headers?: Record<string, string>;
};

function mapEntry(e: RawEntry): ServerCfg | null {
  if (e.url) return { url: e.url, ...(e.headers ? { headers: e.headers } : {}) };
  if (e.command) return { command: e.command, ...(e.args ? { args: e.args } : {}), ...(e.env ? { env: e.env } : {}) };
  return null;
}

function readSource(path: string): ClaudeSource | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, RawEntry> };
    const servers: Record<string, ServerCfg> = {};
    for (const [name, e] of Object.entries(raw.mcpServers ?? {})) {
      const cfg = mapEntry(e);
      if (cfg) servers[name] = cfg;
    }
    return Object.keys(servers).length ? { source: path, servers } : null;
  } catch {
    return null; // unreadable/broken configs are skipped — discovery is best-effort
  }
}

/**
 * Claude configs are a LIST of sources, not a singleton: the user config, every
 * ~/.claude*-style config dir (multi-config setups like a separate agent seat),
 * $CLAUDE_CONFIG_DIR, and the project-level .mcp.json.
 */
export function discoverClaudeSources(opts: { home?: string; cwd?: string; extra?: string[] } = {}): ClaudeSource[] {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const candidates = new Set<string>([join(home, ".claude.json"), join(cwd, ".mcp.json")]);
  if (process.env.CLAUDE_CONFIG_DIR) candidates.add(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"));
  for (const p of opts.extra ?? []) candidates.add(p);
  try {
    for (const entry of readdirSync(home)) {
      if (!entry.startsWith(".claude")) continue;
      const dir = join(home, entry);
      if (statSync(dir).isDirectory() && existsSync(join(dir, ".claude.json"))) candidates.add(join(dir, ".claude.json"));
    }
  } catch { /* home unreadable — fall through with what we have */ }
  const out: ClaudeSource[] = [];
  for (const path of candidates) {
    const s = readSource(path);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.source.localeCompare(b.source));
}
