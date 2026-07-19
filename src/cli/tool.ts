import { loadConfig, type ToolCfg } from "../shared/config";
import { updateToolPin } from "../shared/configEdit";
import { isNewer, npmLatest, parseNpmSpec } from "../shared/npm";

function known(): Record<string, ToolCfg> {
  return loadConfig().tools;
}

/** `mux run <tool> [args…]` — exec the tool with its stored args-prefix + env/wrapping,
 *  inheriting stdio and forwarding the exit code. This is what makes a CLI tool feel identical
 *  to an MCP tool to an agent: one discoverable entry point, wrapping applied centrally. */
export async function cmdRun(argv: string[]): Promise<number> {
  const name = argv[0];
  const tools = known();
  if (!name) { console.error(`usage: mux run <tool> [args…] — tools: ${Object.keys(tools).join(", ") || "(none)"}`); return 1; }
  const t = tools[name];
  if (!t || t.disabled) {
    console.error(`unknown tool "${name}" — configured: ${Object.keys(tools).filter((n) => !tools[n]!.disabled).join(", ") || "(none)"} (see: mux tool status)`);
    return 1;
  }
  const proc = Bun.spawn([t.run, ...(t.args ?? []), ...argv.slice(1)], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
    env: { ...process.env, ...t.env },
  });
  return await proc.exited;
}

/** Run a tool's `check` quietly; true if it exits 0. */
async function isInstalled(t: ToolCfg): Promise<boolean> {
  if (!t.check) return true; // no check defined → assume present
  const p = Bun.spawn(["sh", "-c", t.check], { stdout: "ignore", stderr: "ignore", env: { ...process.env, ...t.env } });
  return (await p.exited) === 0;
}

/** `mux tool status` — installed/missing per tool; `mux tool setup <name>` — run its installer. */
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
        if (latest && isNewer(latest, spec.version)) upd = `  ↑ update ${spec.version} → ${latest} (mux tool update ${name})`;
      }
      console.log(`${name.padEnd(14)} ${ok ? "✓ installed" : "✗ missing"}${t.setup && !ok ? `  → mux tool setup ${name}` : ""}${t.note ? `  — ${t.note}` : ""}${upd}`);
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
    if (bumped) console.log(`\n${bumped} tool(s) re-pinned — run \`mux tool setup <name>\` if a new browser/binary is needed`);
    return 0;
  }
  if (sub === "setup") {
    const name = argv[1];
    const t = name ? tools[name] : undefined;
    if (!t) { console.error(`usage: mux tool setup <name> — tools: ${Object.keys(tools).join(", ") || "(none)"}`); return 1; }
    if (!t.setup) { console.error(`tool "${name}" has no setup command — install it manually`); return 1; }
    console.log(`setting up ${name}: ${t.setup}`);
    const p = Bun.spawn(["sh", "-c", t.setup], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...t.env } });
    const code = await p.exited;
    console.log(code === 0 ? `✓ ${name} set up` : `✗ setup failed (exit ${code})`);
    return code === 0 ? 0 : 1;
  }
  console.error("usage: mux tool status | mux tool setup <name> | mux tool update [name]");
  return 1;
}
