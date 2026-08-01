import { discoverClaudeSources } from "../shared/claudeConfigs";
import { loadConfig } from "../shared/config";
import { request, socketAlive, socketPath } from "../shared/ipc";

/**
 * `mduct doctor` — report, never a gate (always exit 0). A read-only report must not spin up a
 * daemon as a side effect (N4): it queries the daemon only if one is ALREADY running.
 *  1. overlap: servers attached directly in a Claude config AND served by mduct + removal commands.
 *  2. dead servers: mduct-configured but not connectable (only checked when a daemon is up).
 *  3. token estimate per overlapping server (tool count × ~350 tk heuristic).
 */
export async function cmdDoctor(): Promise<number> {
  const home = process.env.MDUCT_HOME;
  const sources = discoverClaudeSources(home ? { home } : {});
  const mduct = loadConfig().servers;
  const muxNames = new Set(Object.keys(mduct).filter((n) => !mduct[n]!.disabled));
  const daemonUp = await socketAlive(socketPath());
  const ask = (method: string, params: unknown) =>
    daemonUp ? request(socketPath(), method, params, 8000) : Promise.reject(new Error("daemon not running"));

  let overlaps = 0;
  for (const s of sources) {
    const both = Object.keys(s.servers).filter((n) => muxNames.has(n));
    if (!both.length) continue;
    overlaps += both.length;
    console.log(`⚠ ${s.source} verbindet MCP-Server direkt, die mduct schon bedient:`);
    for (const n of both) {
      let estimate = "";
      try {
        const tools = (await ask("tools", { server: n })) as unknown[];
        estimate = ` (~${tools.length} Tools ≈ ${Math.round((tools.length * 350) / 1000)}k Tokens/Session)`;
      } catch { /* estimate is best-effort; no daemon → no count */ }
      console.log(`  ${n}${estimate} → entfernen: claude mcp remove ${n}   # in dieser Config`);
    }
  }
  if (overlaps === 0) console.log("✓ keine Überlappung: kein direkt verbundener MCP-Server, den mduct schon bedient");

  if (!daemonUp) {
    console.log("ⓘ Daemon läuft nicht — Server-Erreichbarkeit übersprungen (starte einen Call oder `mduct daemon`).");
    return 0;
  }
  let dead = 0;
  for (const name of muxNames) {
    try {
      await ask("tools", { server: name });
    } catch (e) {
      dead++;
      console.log(`✗ ${name}: unreachable — ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (dead === 0) console.log(`✓ alle ${muxNames.size} mduct-Server erreichbar`);
  return 0;
}
