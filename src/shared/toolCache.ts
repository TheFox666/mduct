import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./paths";

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
export type CachedTool = { name: string; sig: string };

function dir(): string {
  return join(cacheDir(), "tools");
}

function file(server: string): string {
  return join(dir(), `${server.replace(/[^\w.-]/g, "_")}.json`);
}

export function writeToolCache(server: string, tools: CachedTool[]): void {
  try {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
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
    if (!existsSync(dir())) return;
    const keep = new Set(configured.map((s) => `${s.replace(/[^\w.-]/g, "_")}.json`));
    for (const f of readdirSync(dir())) if (!keep.has(f)) writeFileSync(join(dir(), f), "[]");
  } catch { /* best effort */ }
}
