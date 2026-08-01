import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { loadConfig, type ToolCfg } from "../shared/config";
import { cacheDir } from "../shared/paths";
import { updateToolPin } from "../shared/configEdit";
import { isNewer, npmLatest, parseNpmSpec } from "../shared/npm";

function known(): Record<string, ToolCfg> {
  return loadConfig().tools;
}

/** Where a tool's `lib` package is installed: one directory per tool, under the instance cache. */
export function libDir(name: string): string {
  return join(cacheDir(), "lib", name.replace(/[^\w.-]/g, "_"));
}

/**
 * The environment a tool actually runs under: its own `env`, plus a NODE_PATH for its `lib` when
 * one is configured.
 *
 * The gap this closes: `mduct run playwright screenshot …` gives you the CLI, and a CLI cannot do
 * everything the library can. Without this, the answer to "I need the API" is to npm-install a
 * second copy somewhere and hope the versions match.
 */
export function toolEnv(name: string, t: ToolCfg): Record<string, string> {
  const env: Record<string, string> = { ...(t.env ?? {}) };
  if (t.lib) {
    const mods = join(libDir(name), "node_modules");
    env.NODE_PATH = [mods, process.env.NODE_PATH].filter(Boolean).join(delimiter);
  }
  return env;
}

/** `mduct env <tool>` — the tool's environment as shell exports, for scripts that need its library. */
export function cmdToolEnv(name: string | undefined): number {
  const tools = known();
  const t = name ? tools[name] : undefined;
  if (!t || t.disabled) {
    console.error(`usage: mduct env <tool> — tools: ${Object.keys(tools).filter((n) => !tools[n]!.disabled).join(", ") || "(none)"}`);
    return 1;
  }
  const env = toolEnv(name!, t);
  if (!Object.keys(env).length) { console.error(`tool "${name}" declares no env or lib — nothing to export`); return 1; }
  for (const [k, v] of Object.entries(env)) console.log(`export ${k}='${v.replace(/'/g, `'\\''`)}'`);
  return 0;
}

/** `mduct run <tool> [args…]` — exec the tool with its stored args-prefix + env/wrapping,
 *  inheriting stdio and forwarding the exit code. This is what makes a CLI tool feel identical
 *  to an MCP tool to an agent: one discoverable entry point, wrapping applied centrally. */
export async function cmdRun(argv: string[]): Promise<number> {
  const name = argv[0];
  const tools = known();
  if (!name) { console.error(`usage: mduct run <tool> [args…] — tools: ${Object.keys(tools).join(", ") || "(none)"}`); return 1; }
  const t = tools[name];
  if (!t || t.disabled) {
    console.error(`unknown tool "${name}" — configured: ${Object.keys(tools).filter((n) => !tools[n]!.disabled).join(", ") || "(none)"} (see: mduct tool status)`);
    return 1;
  }
  const proc = Bun.spawn([t.run, ...(t.args ?? []), ...argv.slice(1)], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
    env: { ...process.env, ...toolEnv(name, t) },
  });
  return await proc.exited;
}

/**
 * `mduct tools <cliTool>` — the CLI-tool half of discovery.
 *
 * For an MCP server, `mduct tools` answers "what can this do". For a CLI tool it used to answer
 * `unknown server "playwright"`, so the only way to find out was to already know that
 * `mduct run <tool> --help` exists. A capability nobody can enumerate is a capability nobody uses.
 */
export async function cmdToolHelp(name: string): Promise<number> {
  const t = known()[name];
  if (!t || t.disabled) return 1; // caller falls back to its own error
  console.error(`# ${name} — ${t.note ?? "CLI tool"} (run: mduct run ${name} …)`);
  const proc = Bun.spawn([t.run, ...(t.args ?? []), "--help"], {
    stdout: "inherit", stderr: "inherit", env: { ...process.env, ...t.env },
  });
  const code = await proc.exited;
  if (code !== 0) console.error(`(\`${t.run} --help\` exited ${code} — try: mduct run ${name} help)`);
  return 0;
}

/** Run a tool's `check` quietly; true if it exits 0. */
async function isInstalled(t: ToolCfg): Promise<boolean> {
  if (!t.check) return true; // no check defined → assume present
  const p = Bun.spawn(["sh", "-c", t.check], { stdout: "ignore", stderr: "ignore", env: { ...process.env, ...t.env } });
  return (await p.exited) === 0;
}

/** `mduct tool status` — installed/missing per tool; `mduct tool setup <name>` — run its installer. */
export async function cmdTool(argv: string[]): Promise<number> {
  const sub = argv[0];
  const tools = known();
  if (sub === "status" || sub === undefined) {
    for (const [name, t] of Object.entries(tools)) {
      if (t.disabled) { console.log(`${name.padEnd(14)} disabled`); continue; }
      const ok = await isInstalled(t);
      // best-effort update hint for pinned npm-backed tools (skips silently when offline)
      let upd = "";
      const spec = parseNpmSpec(t);
      if (spec?.version) {
        const latest = await npmLatest(spec.pkg);
        if (latest && isNewer(latest, spec.version)) upd = `  ↑ update ${spec.version} → ${latest} (mduct tool update ${name})`;
      }
      console.log(`${name.padEnd(14)} ${ok ? "✓ installed" : "✗ missing"}${t.setup && !ok ? `  → mduct tool setup ${name}` : ""}${t.note ? `  — ${t.note}` : ""}${upd}`);
    }
    return 0;
  }
  if (sub === "update") {
    const target = argv[1] ? [argv[1]] : Object.keys(tools);
    let bumped = 0;
    for (const name of target) {
      const t = tools[name];
      if (!t) { console.error(`unknown tool "${name}"`); return 1; }
      const spec = parseNpmSpec(t);
      if (!spec) { if (argv[1]) console.log(`${name}: not an npm-backed tool — nothing to update (OS-managed)`); continue; }
      const latest = await npmLatest(spec.pkg);
      if (!latest) { console.log(`${name}: could not reach the npm registry`); continue; }
      if (!spec.version) { console.log(`${name}: tracks latest (currently ${latest})`); continue; }
      if (isNewer(latest, spec.version)) {
        updateToolPin(name, spec.pkg, spec.version, latest);
        console.log(`${name}: ${spec.version} → ${latest} ✓`);
        bumped++;
      } else {
        console.log(`${name}: up to date (${spec.version})`);
      }
    }
    if (bumped) console.log(`\n${bumped} tool(s) re-pinned — run \`mduct tool setup <name>\` if a new browser/binary is needed`);
    return 0;
  }
  if (sub === "setup") {
    const name = argv[1];
    const t = name ? tools[name] : undefined;
    if (!t) { console.error(`usage: mduct tool setup <name> — tools: ${Object.keys(tools).join(", ") || "(none)"}`); return 1; }
    if (!t.setup && !t.lib) { console.error(`tool "${name}" has no setup command or lib — install it manually`); return 1; }
    if (t.lib) {
      // its own directory, so the library version is pinned by the config rather than by whatever
      // happens to sit in the caller's node_modules
      const dir = libDir(name!);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const spec = t.lib;
      const at = spec.lastIndexOf("@");
      const [pkg, ver] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, "latest"];
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `mduct-lib-${name}`, private: true, dependencies: { [pkg]: ver } }, null, 2) + "\n");
      console.log(`installing library ${spec} → ${dir}`);
      const inst = Bun.spawn(["sh", "-c", "bun install --no-save 2>/dev/null || npm install --silent"], {
        cwd: dir, stdin: "inherit", stdout: "inherit", stderr: "inherit",
      });
      if ((await inst.exited) !== 0) { console.log(`✗ library install failed`); return 1; }
      console.log(`✓ library ready — scripts: eval "$(mduct env ${name})"`);
    }
    if (!t.setup) return 0;
    console.log(`setting up ${name}: ${t.setup}`);
    const p = Bun.spawn(["sh", "-c", t.setup], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...toolEnv(name!, t) } });
    const code = await p.exited;
    console.log(code === 0 ? `✓ ${name} set up` : `✗ setup failed (exit ${code})`);
    return code === 0 ? 0 : 1;
  }
  console.error("usage: mduct tool status | mduct tool setup <name> | mduct tool update [name]");
  return 1;
}
