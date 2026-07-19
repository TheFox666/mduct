import { discoverClaudeSources } from "../shared/claudeConfigs";
import { loadConfig } from "../shared/config";

/**
 * `mux doctor` — report, never a gate (always exit 0):
 *  1. overlap: servers attached directly in a Claude config AND served by mux
 *     (their schemas cost context tokens every session) + removal commands.
 *  2. dead servers: mux-configured but not connectable right now.
 *  3. token estimate per overlapping server (tool count × ~350 tk heuristic).
 */
export async function cmdDoctor(daemonRequest: (method: string, params: unknown) => Promise<unknown>): Promise<number> {
  const home = process.env.MCPMUX_HOME;
  const sources = discoverClaudeSources(home ? { home } : {});
  const mux = loadConfig().servers;
  const muxNames = new Set(Object.keys(mux).filter((n) => !mux[n]!.disabled));

  let overlaps = 0;
  for (const s of sources) {
    const both = Object.keys(s.servers).filter((n) => muxNames.has(n));
    if (!both.length) continue;
    overlaps += both.length;
    console.log(`⚠ ${s.source} verbindet MCP-Server direkt, die mux schon bedient:`);
    for (const n of both) {
      let estimate = "";
      try {
        const tools = (await daemonRequest("tools", { server: n })) as unknown[];
        estimate = ` (~${tools.length} Tools ≈ ${Math.round((tools.length * 350) / 1000)}k Tokens/Session)`;
      } catch { /* estimate is best-effort */ }
      console.log(`  ${n}${estimate} → entfernen: claude mcp remove ${n}   # in dieser Config`);
    }
  }
  if (overlaps === 0) console.log("✓ keine Überlappung: kein direkt verbundener MCP-Server, den mux schon bedient");

  let dead = 0;
  for (const name of muxNames) {
    try {
      await daemonRequest("tools", { server: name });
    } catch (e) {
      dead++;
      console.log(`✗ ${name}: unreachable — ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (dead === 0) console.log(`✓ alle ${muxNames.size} mux-Server erreichbar`);
  return 0;
}
