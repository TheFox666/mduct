import { expect, test } from "bun:test";
import { join } from "node:path";
import { home } from "../src/shared/paths";

/**
 * The sandbox from test/setup.ts, asserted rather than assumed.
 *
 * These checks strip MDUCT_* themselves instead of demanding a clean global environment: bun
 * evaluates every test file in one process, so what other files leave behind is not something a
 * single test can police. What it can prove is that nothing reaches the real home.
 */

const realHome = process.env.MDUCT_TEST_REAL_HOME!;

/** A child process with every mduct override removed — the true "fresh machine" defaults. */
function withoutOverrides(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("MDUCT_") && v) env[k] = v;
  return env;
}

test("the preload replaced the home directory", () => {
  expect(realHome).toBeTruthy();
  expect(home()).not.toBe(realHome);
  expect(home()).toStartWith("/tmp/");
});

test("with no overrides, every default path lands in the sandbox", () => {
  const probe = `
    const p = await import("./src/shared/paths");
    const { codexConfigPath } = await import("./src/cli/codex");
    console.log(JSON.stringify({
      home: p.home(), configDir: p.configDir(), configPath: p.configPath(),
      secretsPath: p.secretsPath(), socketPath: p.socketPath(), cacheDir: p.cacheDir(),
      codex: codexConfigPath(),
    }));`;
  const r = Bun.spawnSync([process.execPath, "-e", probe], { env: withoutOverrides() });
  const paths = JSON.parse(r.stdout.toString()) as Record<string, string>;
  expect(Object.keys(paths).length).toBe(7); // fail loudly if the probe stops resolving something
  for (const [name, p] of Object.entries(paths)) {
    expect(`${name}=${p}`).toStartWith(`${name}=${home()}`);
    expect(p.startsWith(realHome)).toBe(false);
  }
});

test("no env var points a test at the developer's real state", () => {
  const dangerous = [
    join(realHome, ".config", "mduct"), join(realHome, ".cache", "mduct"),
    join(realHome, ".claude"), join(realHome, ".codex"),
  ];
  const offenders = Object.entries(process.env)
    .filter(([k]) => k !== "MDUCT_TEST_REAL_HOME")
    .filter(([, v]) => v && dangerous.some((d) => v.startsWith(d)))
    .map(([k, v]) => `${k}=${v}`);
  expect(offenders).toEqual([]);
});

test("a spawned mduct reads the sandbox, not the real config", () => {
  const r = Bun.spawnSync([process.execPath, "src/main.ts", "status"], { env: withoutOverrides() });
  const out = r.stdout.toString() + r.stderr.toString();
  expect(out).not.toContain(realHome);
  expect(out).toContain(home());
});

test("a test cannot reach a running daemon of the developer's", () => {
  // A test that forgets MDUCT_SOCKET would otherwise talk to whichever daemon is up under
  // /run/user/<uid>/, and a live daemon answers with the real config — green, and meaningless.
  const probe = 'import("./src/shared/paths").then(p => console.log(p.socketPath()))';
  const sock = Bun.spawnSync([process.execPath, "-e", probe], { env: withoutOverrides() }).stdout.toString().trim();
  expect(sock).toStartWith(home());
  expect(sock).not.toStartWith("/run/user/");
});
