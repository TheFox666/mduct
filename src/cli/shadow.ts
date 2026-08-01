import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cacheDir } from "../shared/paths";
import type { Config, ShadowRule } from "../shared/config";

/**
 * Shadowing: a server may declare which *other* tool calls it could have served better, and mduct
 * says so once, at the moment of the call.
 *
 * Why here and not in a prompt block: the session-start index is read once and then loses against
 * habit — measured on a real session, 21 calls to a code-index server vs 270 greps into the repos it
 * had indexed, the index block present throughout. A PreToolUse denial is the only channel that lands
 * the wrong tool is chosen.
 *
 * Why a budget: the note is context, and context repeated on every grep is noise. The bucket keeps
 * it occasional. It no longer limits DAMAGE — the hint rides along with the tool result and the
 * command runs regardless — so the budget is about attention, not about getting out of the way.
 *
 * mduct knows nothing about what any server does — it matches the patterns the server declared and
 * prints the server's own hint. Remove the server from the config and the mechanism is inert.
 */

export type Hit = { server: string; rule: number; hint: string; budget: number; refillMin: number; block: boolean };

const expandHome = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** Does one rule cover this call? `pathIn` is an extra gate, not a matcher on its own. */
export function ruleMatches(rule: ShadowRule, toolName: string, command: string, cwd: string): boolean {
  const byTool = rule.tool?.includes(toolName) ?? false;
  let byBash = false;
  if (rule.bash && toolName === "Bash") {
    try { byBash = new RegExp(rule.bash).test(command); } catch { byBash = false; } // a bad regex must not break the hook
  }
  if (!byTool && !byBash) return false;
  if (!rule.pathIn?.length) return true;

  const here = effectiveCwd(command, cwd);
  const gates = rule.pathIn.map(expandHome);
  const under = (p: string) => gates.some((g) => p === g || p.startsWith(g.endsWith("/") ? g : `${g}/`));

  // What the command actually reads beats where the shell happens to stand. A session's cwd is
  // usually a fixed project root, so gating on it alone fires for calls that reach somewhere else
  // entirely (`grep -n x ~/.config/foo` while sitting in an indexed repo — a real false positive).
  const targets = commandTargets(command, here);
  if (targets.length) return targets.some(under);

  // Nothing nameable to check (no path arguments, or none that exist): fall back to where it runs,
  // plus a plain text match so a path that doesn't exist yet still counts.
  return under(here) || gates.some((g) => command.includes(g));
}

/**
 * Path arguments a command actually touches, resolved and filtered to those that EXIST.
 *
 * Existence is the trick that separates a target from a pattern: `grep -rn "a/b" app/` has two
 * slash-bearing tokens and only one of them is a directory. Guessing by position or by quoting gets
 * this wrong in both directions; asking the filesystem does not.
 */
export function commandTargets(command: string, cwd: string): string[] {
  const out: string[] = [];
  for (const raw of command.match(/("[^"]*"|'[^']*'|\S+)/g) ?? []) {
    const t = raw.replace(/^["']|["']$/g, "");
    if (t.startsWith("-") || !/[/~]/.test(t) || t.includes("*")) continue; // flags, non-paths, globs
    const p = t.startsWith("~") || t.startsWith("/") ? expandHome(t) : join(cwd, t);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/** Where the command actually runs: the last `cd <path>` it performs, else the session cwd. */
export function effectiveCwd(command: string, cwd: string): string {
  let target: string | undefined;
  for (const m of command.matchAll(/(?:^|[;&|]\s*)cd\s+(?:-{1,2}\S+\s+)*("[^"]+"|'[^']+'|[^\s;&|]+)/g))
    target = m[1]!.replace(/^["']|["']$/g, "");
  if (!target || target === "-") return cwd;
  const p = expandHome(target);
  return p.startsWith("/") ? p : join(cwd, p); // relative cd stays relative to the session cwd
}

/** First matching rule across all enabled servers, or null. */
export function findHit(cfg: Config, toolName: string, command: string, cwd: string): Hit | null {
  for (const [server, s] of Object.entries(cfg.servers)) {
    if (s.disabled || !s.shadow?.length) continue;
    for (const [i, rule] of s.shadow.entries())
      if (ruleMatches(rule, toolName, command, cwd))
        return { server, rule: i, hint: rule.hint, budget: rule.budget ?? 1, refillMin: rule.refillMin ?? 0, block: rule.block ?? false };
  }
  return null;
}

/** Tool names a matcher must cover for the declared rules to ever fire. */
export function shadowMatcher(cfg: Config): string | null {
  const names = new Set<string>();
  for (const s of Object.values(cfg.servers)) {
    if (s.disabled) continue;
    for (const rule of s.shadow ?? []) {
      for (const t of rule.tool ?? []) names.add(t);
      if (rule.bash) names.add("Bash");
    }
  }
  return names.size ? [...names].sort().join("|") : null;
}

export type Event = { ts: string; session: string; kind: "nudge" | "use"; server: string; rule?: number; tool?: string };

export function logPath(): string {
  return join(cacheDir(), "shadow.jsonl");
}

/** Append-only, trimmed lazily — it is the only record of whether the nudge converts. */
export function record(ev: Event): void {
  const p = logPath();
  mkdirSync(cacheDir(), { recursive: true });
  if (existsSync(p) && statSync(p).size > 200_000)
    writeFileSync(p, readEvents().slice(-1000).map((e) => JSON.stringify(e)).join("\n") + "\n");
  appendFileSync(p, JSON.stringify(ev) + "\n");
}

export function readEvents(): Event[] {
  const p = logPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as Event]; } catch { return []; }
  });
}

/**
 * Token bucket, replayed from the log — no separate state to keep in sync.
 *
 * A per-session budget sounds right until you look at a real session: this one ran two days and 816
 * tool calls. One hint at call 5 and silence for the remaining 800 is not a lesson, it is an
 * accident. So the bucket holds `capacity` hints and refills one every `refillMin` minutes: a short
 * burst is allowed, then it goes quiet, then it comes back.
 *
 * `refillMin: 0` never refills — that IS the old fixed budget, kept as the default so a rule without
 * the field behaves exactly as before.
 */
export function available(
  events: Event[], session: string, server: string, rule: number,
  capacity: number, refillMin: number, now: number,
): number {
  const refillMs = refillMin * 60_000;
  const stamps = events
    .filter((e) => e.kind === "nudge" && e.session === session && e.server === server && e.rule === rule)
    .map((e) => Date.parse(e.ts))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  let tokens = capacity, last: number | null = null;
  const refill = (until: number) => {
    if (last !== null && refillMs > 0)
      tokens = Math.min(capacity, tokens + Math.floor((until - last) / refillMs));
  };
  for (const t of stamps) {
    refill(t);
    tokens -= 1;
    last = t;
  }
  refill(now);
  return tokens;
}

/** A `mduct call <server>` in a Bash command — the conversion signal for a nudge. */
export function muxCallServer(command: string): string | null {
  return /\bmux\s+(?:call|run)\s+([\w.-]+)/.exec(command)?.[1] ?? null;
}

/**
 * nudge → use per session and server: did the redirect change the next move?
 * A nudge counts as converted when a call to that server follows it in the same session.
 */
export function conversion(events: Event[] = readEvents()): { server: string; nudges: number; converted: number }[] {
  const per = new Map<string, { nudges: number; converted: number }>();
  const nudged = new Set<string>();
  for (const e of events) {
    const key = `${e.session}::${e.server}`;
    const row = per.get(e.server) ?? { nudges: 0, converted: 0 };
    if (e.kind === "nudge") {
      row.nudges++;
      nudged.add(key);
    } else if (nudged.has(key)) {
      row.converted++;
      nudged.delete(key); // count one conversion per nudged session, not every later call
    }
    per.set(e.server, row);
  }
  return [...per.entries()].map(([server, r]) => ({ server, ...r })).sort((a, b) => b.nudges - a.nudges);
}
