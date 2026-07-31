import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { available, conversion, effectiveCwd, findHit, ruleMatches, shadowMatcher, type Event } from "../src/cli/shadow";
import type { Config } from "../src/shared/config";

const RULE = {
  tool: ["Grep"],
  bash: "\\b(grep|rg|find)\\b",
  pathIn: ["/repo/indexed"],
  hint: "mux call idx search_code query=…",
};
const cfg = { servers: { idx: { command: "x", shadow: [RULE] } }, tools: {} } as unknown as Config;

test("ruleMatches: the tool list and the bash regex both fire, pathIn gates both", () => {
  expect(ruleMatches(RULE, "Grep", "", "/repo/indexed")).toBe(true);
  expect(ruleMatches(RULE, "Bash", "cd /repo/indexed && grep -n foo x.ts", "")).toBe(true);
  // right tool, wrong place — the index has nothing to say about it
  expect(ruleMatches(RULE, "Bash", "grep -n foo /etc/hosts", "/tmp")).toBe(false);
  // right place, but not a search at all
  expect(ruleMatches(RULE, "Bash", "cd /repo/indexed && bun test", "")).toBe(false);
  expect(ruleMatches(RULE, "Read", "", "/repo/indexed")).toBe(false);
});

test("ruleMatches: a broken regex is inert instead of throwing in the hook", () => {
  expect(ruleMatches({ bash: "([", hint: "x" }, "Bash", "grep foo", "")).toBe(false);
});

test("findHit skips disabled servers and servers without rules", () => {
  expect(findHit(cfg, "Grep", "", "/repo/indexed")?.server).toBe("idx");
  const off = { servers: { idx: { ...cfg.servers.idx!, disabled: true } }, tools: {} } as unknown as Config;
  expect(findHit(off, "Grep", "", "/repo/indexed")).toBeNull();
  const bare = { servers: { other: { command: "x" } }, tools: {} } as unknown as Config;
  expect(findHit(bare, "Grep", "", "/repo/indexed")).toBeNull();
});

test("shadowMatcher covers exactly the declared tools — and is null without rules", () => {
  expect(shadowMatcher(cfg)).toBe("Bash|Grep");
  expect(shadowMatcher({ servers: { a: { command: "x" } }, tools: {} } as unknown as Config)).toBeNull();
});

test("conversion: a nudge counts once, and only a later call in the SAME session converts it", () => {
  const ev = (kind: Event["kind"], session: string, server = "idx"): Event =>
    ({ ts: "t", session, kind, server });
  // nudged in s1, reached for the server afterwards → converted
  expect(conversion([ev("nudge", "s1"), ev("use", "s1")])).toEqual([{ server: "idx", nudges: 1, converted: 1 }]);
  // nudged in s1, used in s2 → the nudge did not convert
  expect(conversion([ev("nudge", "s1"), ev("use", "s2")])).toEqual([{ server: "idx", nudges: 1, converted: 0 }]);
  // two calls after one nudge are still one conversion
  expect(conversion([ev("nudge", "s1"), ev("use", "s1"), ev("use", "s1")]))
    .toEqual([{ server: "idx", nudges: 1, converted: 1 }]);
});

// --- the behaviour that matters: deny ONCE, then get out of the way -------------------------

const dir = mkdtempSync(join(tmpdir(), "mux-shadow-"));
const env = { ...process.env, MCPMUX_CONFIG: join(dir, "servers.jsonc"), MCPMUX_CACHE: join(dir, "cache") };
writeFileSync(env.MCPMUX_CONFIG!, JSON.stringify({
  servers: {
    idx: {
      command: process.execPath, args: ["test/fixture-server.ts"], note: "index",
      shadow: [{ tool: ["Grep"], bash: "\\bgrep\\b", pathIn: [dir], hint: "mux call idx search_code query=…" }],
    },
  },
}));

async function hook(input: unknown): Promise<{ out: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", "hook", "run", "pre-tool-use"], {
    env, stdout: "pipe", stderr: "pipe", stdin: new TextEncoder().encode(JSON.stringify(input)),
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { out, code };
}
const grepCall = (session: string) =>
  ({ tool_name: "Bash", tool_input: { command: `cd ${dir} && grep -n foo x.ts` }, cwd: dir, session_id: session });

test("first shadowed grep is redirected with the server's own hint", async () => {
  const r = await hook(grepCall("s-once"));
  expect(r.code).toBe(0);
  const d = JSON.parse(r.out);
  expect(d.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(d.hookSpecificOutput.permissionDecisionReason).toContain("mux call idx search_code");
  // the message states the bucket state and that the tool is not banned
  expect(d.hookSpecificOutput.permissionDecisionReason).toContain("0/1 Hinweise übrig");
  expect(d.hookSpecificOutput.permissionDecisionReason).toContain("nicht gesperrt");
});

test("the SECOND identical grep in that session runs untouched — a redirect, not a ban", async () => {
  const again = await hook(grepCall("s-once"));
  expect(again.out.trim()).toBe("");
  // a fresh session gets the one hint again
  const other = await hook(grepCall("s-other"));
  expect(other.out.trim()).not.toBe("");
});

test("a mux call is logged as the conversion signal, never denied", async () => {
  const r = await hook({ tool_name: "Bash", tool_input: { command: "mux call idx search_code query=x" }, cwd: dir, session_id: "s-conv" });
  expect(r.out.trim()).toBe("");
  const p = Bun.spawn([process.execPath, "src/main.ts", "shadow"], { env, stdout: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  expect(out).toContain("idx");
});

test("an unshadowed path stays silent even for the same tool", async () => {
  const r = await hook({ tool_name: "Bash", tool_input: { command: "grep -n foo /etc/hosts" }, cwd: "/tmp", session_id: "s-elsewhere" });
  expect(r.out.trim()).toBe("");
});

test("SessionStart warns when the installed matcher does not cover declared rules", async () => {
  const settings = join(dir, "settings.json");
  const withEnv = (matcher: string | null) => {
    writeFileSync(settings, JSON.stringify(matcher === null ? {} : {
      hooks: { PreToolUse: [{ matcher, hooks: [{ type: "command", command: "mux hook run pre-tool-use" }] }] },
    }));
    return { ...env, MCPMUX_CLAUDE_SETTINGS: settings };
  };
  const start = async (e: Record<string, string>) => {
    const p = Bun.spawn([process.execPath, "src/main.ts", "hook", "run", "session-start"], { env: e, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  };
  // narrow matcher → the rules would never fire, so say so
  expect(await start(withEnv("mcp__.*"))).toContain("Shadow-Regeln deklariert");
  // wide enough → silent
  expect(await start(withEnv("mcp__.*|Bash|Grep"))).not.toContain("Shadow-Regeln deklariert");
  // hook not installed at all is a different problem — no warning
  expect(await start(withEnv(null))).not.toContain("Shadow-Regeln deklariert");
});

test("effectiveCwd: a leading cd moves the call out of the session cwd (the live false positive)", () => {
  const R = { bash: "grep", pathIn: ["/home/k/dev/indexed"], hint: "x" };
  // exactly what fired wrongly: session sits in an indexed repo, the grep goes elsewhere
  expect(ruleMatches(R, "Bash", "cd /home/k/dev/other && grep -n foo src/main.ts", "/home/k/dev/indexed")).toBe(false);
  // no cd → the session cwd is where it runs
  expect(ruleMatches(R, "Bash", "grep -rn foo app/", "/home/k/dev/indexed")).toBe(true);
  // the command names the indexed path itself, from anywhere
  expect(ruleMatches(R, "Bash", "grep -rn foo /home/k/dev/indexed/app", "/tmp")).toBe(true);
  // cd INTO the indexed repo from elsewhere
  expect(ruleMatches(R, "Bash", "cd /home/k/dev/indexed && grep -n foo x", "/tmp")).toBe(true);
  // a later cd wins over an earlier one
  expect(effectiveCwd("cd /a && cd /b && grep x", "/cwd")).toBe("/b");
  // relative and `cd -` fall back sanely
  expect(effectiveCwd("cd sub && grep x", "/cwd")).toBe("/cwd/sub");
  expect(effectiveCwd("cd - && grep x", "/cwd")).toBe("/cwd");
  expect(effectiveCwd("grep x", "/cwd")).toBe("/cwd");
});

describe("available — the bucket", () => {
  const T0 = Date.parse("2026-07-31T12:00:00Z");
  const min = (n: number) => T0 + n * 60_000;
  const nudge = (at: number): Event => ({ ts: new Date(at).toISOString(), session: "s", kind: "nudge", server: "idx", rule: 0 });
  const avail = (evs: Event[], now: number, cap = 2, refill = 30) => available(evs, "s", "idx", 0, cap, refill, now);

  test("starts full and each hint costs one", () => {
    expect(avail([], min(0))).toBe(2);
    expect(avail([nudge(min(0))], min(0))).toBe(1);
    expect(avail([nudge(min(0)), nudge(min(1))], min(1))).toBe(0);   // burst allowed
  });

  test("empty stays empty until the refill interval has passed", () => {
    const burst = [nudge(min(0)), nudge(min(1))];
    expect(avail(burst, min(29))).toBe(0);   // 29 min later: still quiet
    expect(avail(burst, min(31))).toBe(1);   // one refilled
    expect(avail(burst, min(61))).toBe(2);   // and the second
  });

  test("never overfills past capacity, however long the pause", () => {
    expect(avail([nudge(min(0))], min(10_000))).toBe(2);
  });

  test("refillMin 0 is the old fixed budget — spent stays spent", () => {
    const evs = [nudge(min(0))];
    expect(available(evs, "s", "idx", 0, 1, 0, min(10_000))).toBe(0);
  });

  test("buckets are per session, server and rule — they never share", () => {
    const evs = [nudge(min(0)), nudge(min(1))];
    expect(available(evs, "other-session", "idx", 0, 2, 30, min(1))).toBe(2);
    expect(available(evs, "s", "otherserver", 0, 2, 30, min(1))).toBe(2);
    expect(available(evs, "s", "idx", 1, 2, 30, min(1))).toBe(2);
  });

  test("a corrupt timestamp in the log is skipped, not counted as now", () => {
    const bad: Event = { ts: "nope", session: "s", kind: "nudge", server: "idx", rule: 0 };
    expect(avail([bad, nudge(min(0))], min(0))).toBe(1);
  });
});
