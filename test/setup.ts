import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Preloaded before every test file (see bunfig.toml). Two jobs: make the developer's own files
 * unreachable, and fail the run if a test reaches them anyway. Per-test discipline was tried and
 * leaked three times, so this is not advisory.
 */

const realHome = homedir();
const sandbox = mkdtempSync(join(tmpdir(), "mduct-test-home-"));
mkdirSync(join(sandbox, ".config"), { recursive: true });
mkdirSync(join(sandbox, ".cache"), { recursive: true });

// Everything mduct resolves goes through homedir() or an XDG variable, and homedir() follows $HOME
// on Linux. Redirecting them covers the default path of every command, in this process AND in the
// subprocesses tests spawn with {...process.env}.
process.env.HOME = sandbox;
process.env.XDG_CONFIG_HOME = join(sandbox, ".config");
process.env.XDG_CACHE_HOME = join(sandbox, ".cache");
process.env.XDG_RUNTIME_DIR = join(sandbox, "run");
mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });

// A leftover MDUCT_* in the developer's shell would aim tests straight back at real state, and it
// also crosses between files: bun evaluates them all in ONE process.
for (const k of Object.keys(process.env)) if (k.startsWith("MDUCT_")) delete process.env[k];

// Tests that legitimately need to know where the real home was (to assert they did NOT touch it).
process.env.MDUCT_TEST_REAL_HOME = realHome;

/**
 * Second layer: an absolute path typed by hand walks straight past the sandbox. Watch for it.
 *
 * Two tiers, because one of them was flaky in the only place it runs often. Nothing writes a
 * config file behind your back, so a change there is a test and the run fails. The logs and the
 * tool cache are written by ANY live mduct on the machine — a colleague's shell, an agent's shadow
 * nudge — and failing on those made the guard cry wolf on a developer box. Those warn instead.
 * A guard that is red for innocent reasons gets ignored, which costs more than it catches.
 */
const HARD = [
  join(realHome, ".config/mduct/servers.jsonc"),
  join(realHome, ".config/mduct/secrets.json"),
  join(realHome, ".claude/settings.json"),
  join(realHome, ".claude.json"),
  join(realHome, ".codex/config.toml"),
];
const SOFT = [
  join(realHome, ".cache/mduct/shadow.jsonl"),
  join(realHome, ".cache/mduct/tools"),
];
const watched = [...HARD, ...SOFT];
const fingerprint = () =>
  watched.map((p) => {
    try { const s = statSync(p); return `${p}:${s.size}:${s.mtimeMs}`; } catch { return `${p}:absent`; }
  });
let before = fingerprint();

// A preload's afterAll runs after EVERY test file, so the blame lands on the file that caused it.
// (process.on("exit") never fires under the bun test runner.)
afterAll(() => {
  const after = fingerprint();
  const touched = watched.filter((_, i) => before[i] !== after[i]);
  before = after; // report once, then keep going — the next file gets a clean baseline
  const soft = touched.filter((p) => SOFT.includes(p));
  if (soft.length) console.error(`\n⚠ real state changed during this file: ${soft.join(", ")} — a test, or just live mduct use on this machine.`);
  const hard = touched.filter((p) => HARD.includes(p));
  if (hard.length) {
    throw new Error(
      `a test in this file wrote to the developer's real config: ${hard.join(", ")}\n` +
      "Find the absolute path and point it at a tmpdir — the sandbox home only covers defaults.",
    );
  }
});

export {};
