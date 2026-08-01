import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { cacheDir, configPath } from "./paths";

/**
 * Tool signatures, on disk, per server.
 *
 * The index block is the one thing always in the model's context, and one line per server only
 * says a server exists. Listing its tools means asking the server, which needs a connection —
 * far too slow for a session-start hook that must be instant and work cold.
 *
 * So the daemon writes what it already learned: every successful listTools drops names and
 * signatures here (no descriptions, no schemas — those are the expensive part). The index reads
 * the cache and never connects. A server that has not been called yet simply shows its summary
 * line until it has, or until `mduct index --refresh` fills it in.
 */
/** `desc` is the first line of the server's description, capped — enough for a catalogue entry,
 *  nowhere near the schema it came from. */
export type CachedTool = { name: string; sig: string; desc?: string };

/**
 * Namespaced by the CONFIG the entries came from, not just by the instance.
 *
 * Keying on the server name alone was wrong in a way that poisons the prompt: any run with a
 * different MDUCT_CONFIG — a throwaway benchmark, a test — writes its servers into the same
 * directory, and a fixture server that happens to be called "gitlab" then advertises `boom` and
 * `admin_delete` in the index of the real one. An index that lies is worse than no index.
 */
export function toolCacheDir(): string {
  let key = "default";
  try {
    const h = createHash("sha1").update(configPath()).digest("hex").slice(0, 10);
    key = h;
  } catch { /* fall back to a shared bucket rather than losing the cache entirely */ }
  return join(cacheDir(), "tools", key);
}

function file(server: string): string {
  return join(toolCacheDir(), `${server.replace(/[^\w.-]/g, "_")}.json`);
}

export function writeToolCache(server: string, tools: CachedTool[]): void {
  try {
    mkdirSync(toolCacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(file(server), JSON.stringify(tools), { mode: 0o600 });
  } catch { /* a cache that cannot be written must never break a call */ }
}

export function readToolCache(server: string): CachedTool[] | null {
  try {
    const p = file(server);
    if (!existsSync(p)) return null;
    const v = JSON.parse(readFileSync(p, "utf8")) as CachedTool[];
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** Drop cached servers that are no longer configured, so a removed server stops showing up. */
export function pruneToolCache(configured: string[]): void {
  try {
    if (!existsSync(toolCacheDir())) return;
    const keep = new Set(configured.map((s) => `${s.replace(/[^\w.-]/g, "_")}.json`));
    for (const f of readdirSync(toolCacheDir())) if (!keep.has(f)) writeFileSync(join(toolCacheDir(), f), "[]");
  } catch { /* best effort */ }
}
