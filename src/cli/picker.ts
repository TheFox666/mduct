import { createInterface } from "node:readline";
import { loadConfig, type Config } from "../shared/config";
import { addServer, removeServer } from "../shared/configEdit";
import { refToName, searchRegistry, toServerCfg, type RegistryHit } from "../shared/registry";

export type PickerRow = {
  name: string;        // installed: the config name; available: the registry ref
  kind: "server" | "tool";
  installed: boolean;
  ref?: string;        // set for available rows
  label: string;
};

/** Pure: installed servers+tools first (marked), then registry hits not already installed. */
export function pickerRows(cfg: Config, hits: RegistryHit[]): PickerRow[] {
  const installed = new Set([...Object.keys(cfg.servers), ...Object.keys(cfg.tools)]);
  const rows: PickerRow[] = [];
  for (const [name, s] of Object.entries(cfg.servers))
    rows.push({ name, kind: "server", installed: true, label: `${name} — ${s.note ?? "MCP server"}` });
  for (const [name, t] of Object.entries(cfg.tools))
    rows.push({ name, kind: "tool", installed: true, label: `${name} — ${t.note ?? "CLI tool"}` });
  for (const h of hits) {
    if (installed.has(refToName(h.ref))) continue; // already installed under its default name
    rows.push({ name: h.ref, kind: "server", installed: false, ref: h.ref, label: `${h.ref} — ${h.description}` });
  }
  return rows;
}

/** Interactive `mux add` (TTY, no args): toggle installed servers off / install registry hits. */
export async function runPicker(): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error("mux add needs an argument (non-interactive): mux add <name> -- <cmd> | mux add <ref> | mux add <name> --tool -- <cmd>");
    return 1;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  let hits: RegistryHit[] = [];
  try {
    for (;;) {
      const rows = pickerRows(loadConfig(), hits);
      console.log("");
      rows.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${r.installed ? "✓" : "+"} ${r.label}`));
      console.log("  /<text> search registry   ·   <number> toggle   ·   q quit");
      const input = (await ask("> ")).trim();
      if (input === "" || input === "q") break;
      if (input.startsWith("/")) {
        const q = input.slice(1).trim();
        if (!q) continue;
        try { hits = await searchRegistry(q); if (!hits.length) console.log("(no registry results)"); }
        catch (e) { console.log(`registry error: ${(e as Error).message}`); }
        continue;
      }
      const n = Number(input);
      const row = Number.isInteger(n) ? rows[n - 1] : undefined;
      if (!row) { console.log("pick a listed number, /text, or q"); continue; }
      if (row.installed) {
        if ((await ask(`remove ${row.name}? [y/N] `)).trim().toLowerCase() === "y") {
          removeServer(row.name);
          console.log(`removed ${row.name}`);
        }
      } else {
        const hit = hits.find((h) => h.ref === row.ref)!;
        try {
          const { cfg, requiredEnv } = toServerCfg(hit);
          addServer(refToName(hit.ref), cfg);
          console.log(`installed ${refToName(hit.ref)} (${hit.ref})`);
          if (requiredEnv.length) console.log(`  needs: ${requiredEnv.map((v) => `mux secret set ${v}`).join(", ")}`);
        } catch (e) { console.log(`install failed: ${(e as Error).message}`); }
      }
    }
  } finally {
    rl.close();
  }
  return 0;
}
