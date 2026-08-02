import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * `mduct help` against what main.ts actually dispatches. A command or flag that exists but is
 * documented nowhere is invisible, and the drift is silent — `hook install codex` shipped, worked,
 * and stayed out of the help for a day.
 *
 * The check is deliberately dumb: it reads the source for what the dispatcher compares against and
 * greps the rendered help for it. It cannot verify that a description is *true*, only that the
 * thing is mentioned at all. That is the failure that keeps happening.
 */

const src = readFileSync("src/main.ts", "utf8");
const dispatch = src.slice(src.indexOf("function flag(")); // everything after helpText()
const help = Bun.spawnSync([process.execPath, "src/main.ts", "help"]).stdout.toString();

/** Mentioned as a word, so "on" does not match inside "connection". */
const mentions = (token: string) =>
  new RegExp(`(^|[^\\w-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`, "m").test(help);

const uniq = (re: RegExp) => [...new Set([...dispatch.matchAll(re)].map((m) => m[1]!))].sort();

test("every dispatched command is in the help", () => {
  const commands = uniq(/^\s+case "([a-z-]+)":/gm);
  expect(commands.length).toBeGreaterThan(20); // the extraction itself must not silently find nothing
  expect(commands.filter((c) => !mentions(c))).toEqual([]);
});

test("every flag main.ts reads is in the help", () => {
  const flags = [
    ...uniq(/(?:boolFlag|flag)\(argv, "(--[a-z-]+)"\)/g),
    ...uniq(/argv\.includes\("(--[a-z-]+)"\)/g),
  ].sort();
  expect(flags.length).toBeGreaterThan(8);
  expect(flags.filter((f) => !mentions(f))).toEqual([]);
});

test("every subcommand main.ts compares against is in the help", () => {
  // `on`/`off` are values of `config compact`, not commands; the help documents them as
  // `compact on|off`, which the word check sees.
  const subs = uniq(/(?:sub|argv\[0\]|argv\[1\]) === "([a-z-]+)"/g);
  expect(subs.length).toBeGreaterThan(5);
  expect(subs.filter((s) => !mentions(s))).toEqual([]);
});

test("the help is not lying about commands that do not exist", () => {
  // A help entry is the two-column shape: `  <command> …   <description>`. Prose and the example
  // block have no such column, which is what keeps this from reading `echo "$TOKEN" | …` as a
  // command. Catches a renamed command whose old name stayed in the text.
  // NB literal spaces, not \s — \s would match the newline and read the NEXT line as the
  // description column, which turned every prose line into a "command".
  const documented = [...help.matchAll(/^ {2}([a-z][a-z-]+)[^\n]*? {3,}\S/gm)].map((m) => m[1]!);
  const known = new Set(uniq(/^\s+case "([a-z-]+)":/gm)).add("help"); // `help` falls through to default
  const phantom = [...new Set(documented)].filter((c) => !known.has(c));
  expect(phantom).toEqual([]);
});

/**
 * The project speaks English. German output shipped three times because it reads fine to the
 * person writing it — a word list is crude, but it fails on the words that actually slipped
 * ("Hinweis: wirkt ab der nächsten Session", "keine shadow-Events bisher").
 */
test("no German in user-facing strings", () => {
  const GERMAN = /\b(nicht|keine?|kein|wirkt|Hinweis|Fehler|Datei|läuft|schon|noch|einmal|neu|bereits|ungültig|abgebrochen|Servern?|Sitzung)\b/;
  const offenders: string[] = [];
  for (const f of new Bun.Glob("src/**/*.ts").scanSync(".")) {
    const text = readFileSync(f, "utf8");
    text.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments may say whatever they like
      for (const m of line.matchAll(/"([^"\\]{8,})"|`([^`\\]{8,})`/g)) {
        const lit = m[1] ?? m[2]; // a template literal lands in group 2 — reading only group 1 made this test pass on German
        if (lit && GERMAN.test(lit) && /[äöüß]|\s/.test(lit)) offenders.push(`${f}:${i + 1}  ${lit.slice(0, 60)}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});

/**
 * Conventions a shell user assumes without reading anything. Each of these was broken.
 */
test("--name=value is read as a flag, not passed to the tool", () => {
  // The dispatcher must strip it; parseArgs is the backstop that refuses whatever survives.
  expect(src).toContain("a.startsWith(`${name}=`)");
});

test("a mistyped option is an error, not a tool argument", async () => {
  const { parseArgs } = await import("../src/cli/format");
  expect(() => parseArgs(["--jsonn"])).toThrow(/unknown option/);
  expect(() => parseArgs(["-x"])).toThrow(/unknown option/);
  expect(() => parseArgs(["--as=x"])).toThrow(/unknown option/);
  expect(parseArgs(["text=hi"])).toEqual({ text: "hi" }); // and a real argument still parses
});

test("--version prints a version, and asking for help is not an error", () => {
  const run = (...a: string[]) => {
    const p = Bun.spawnSync([process.execPath, "src/main.ts", ...a]);
    return { out: p.stdout.toString().trim(), code: p.exitCode };
  };
  const v = run("--version");
  expect(v.code).toBe(0);
  expect(v.out).toMatch(/^\d+\.\d+\.\d+$/);
  expect(v.out).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
  expect(run("-V").out).toBe(v.out);
  for (const h of ["-h", "--help", "help"]) expect(run(h).code).toBe(0);
  expect(run("nosuchcommand").code).toBe(1); // an unknown command still is one
});
