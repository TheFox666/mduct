import { loadConfig, type Config } from "../shared/config";
import { addServer, removeServer } from "../shared/configEdit";
import { publisher, refToName, searchRegistry, toServerCfg, type RegistryHit } from "../shared/registry";

export type PickerRow = {
  name: string;        // installed: the config name; available: the registry ref
  kind: "server" | "tool";
  installed: boolean;
  ref?: string;        // set for available rows
  label: string;
  pub?: { kind: "domain" | "github" | "other"; who: string }; // available rows: verified publisher
  repo?: string;       // available rows: source repository URL
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
    rows.push({
      name: h.ref, kind: "server", installed: false, ref: h.ref, label: `${h.ref} — ${h.description}`,
      pub: publisher(h.ref), repo: (h.entry as { repository?: { url?: string } }).repository?.url,
    });
  }
  return rows;
}

// ── ANSI helpers ────────────────────────────────────────────────────────────
const A = {
  clear: "\x1b[2J\x1b[3J\x1b[H", hideCur: "\x1b[?25l", showCur: "\x1b[?25h",
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", magenta: "\x1b[35m", gray: "\x1b[90m",
  invBlue: "\x1b[30;46m",
};

/** Interactive `mux add` (TTY, no args): a raw-mode TUI to install registry servers / remove installed ones. */
export async function runPicker(): Promise<number> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    console.error("mux add needs an argument (non-interactive): mux add <name> -- <cmd> | mux add <ref> | mux add <name> --tool -- <cmd>");
    return 1;
  }

  let hits: RegistryHit[] = [];
  let cursor = 0;
  let mode: "list" | "search" = "list";
  let query = "";
  let flash = "";
  let searching = false;

  const out = (s: string) => process.stdout.write(s);
  const render = () => {
    const rows = pickerRows(loadConfig(), hits);
    if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1);
    const lines: string[] = [
      "",
      `  ${A.bold}${A.magenta}mcpmux${A.reset}${A.bold} · add servers${A.reset}`,
      "",
    ];
    if (rows.length === 0) {
      lines.push(`  ${A.dim}no servers yet — press ${A.reset}${A.cyan}/${A.reset}${A.dim} to search the registry${A.reset}`);
    }
    rows.forEach((r, i) => {
      const sel = i === cursor;
      const pointer = sel ? `${A.cyan}▸${A.reset}` : " ";
      const mark = r.installed ? `${A.green}✓${A.reset}` : `${A.cyan}+${A.reset}`;
      const label = sel ? `${A.bold}${r.label}${A.reset}` : r.installed ? r.label : `${A.dim}${r.label}${A.reset}`;
      // verified-publisher tag leads each candidate: domain (cyan) = proved domain ownership,
      // github (gray) = proved that GitHub account. It's an identity, not a safety rating.
      const tag = r.pub ? `${r.pub.kind === "domain" ? A.cyan : A.gray}⟨${r.pub.who}⟩${A.reset} ` : "";
      lines.push(`  ${pointer} ${mark} ${tag}${label}`);
      if (sel && r.repo) lines.push(`        ${A.gray}↳ ${r.repo}${A.reset}`);
    });
    lines.push("");
    if (mode === "search") {
      lines.push(`  ${A.cyan}search:${A.reset} ${query}${A.invBlue} ${A.reset}   ${A.dim}${searching ? "…searching" : "⏎ run · esc cancel"}${A.reset}`);
    } else {
      lines.push(`  ${A.gray}↑↓${A.reset} move   ${A.gray}⏎${A.reset} install/remove   ${A.gray}/${A.reset} search   ${A.gray}q${A.reset} quit`);
      lines.push(`  ${A.dim}⟨${A.reset}${A.cyan}domain${A.reset}${A.dim}⟩ verified vendor · ⟨${A.reset}${A.gray}github.com/user${A.reset}${A.dim}⟩ an individual — check ↳ repo before installing (it runs their code)${A.reset}`);
    }
    if (flash) lines.push(`  ${A.yellow}${flash}${A.reset}`);
    out(A.clear + A.hideCur + lines.join("\n") + "\n");
  };

  const toggle = () => {
    const rows = pickerRows(loadConfig(), hits);
    const row = rows[cursor];
    if (!row) return;
    if (row.installed) {
      removeServer(row.name);
      flash = `removed ${row.name}`;
    } else {
      const hit = hits.find((h) => h.ref === row.ref);
      if (!hit) return;
      try {
        const { cfg, requiredEnv } = toServerCfg(hit);
        const name = refToName(hit.ref);
        addServer(name, cfg, { replace: true });
        flash = `installed ${name}${requiredEnv.length ? ` — set secrets: ${requiredEnv.join(", ")}` : ""}`;
      } catch (e) {
        flash = `install failed: ${(e as Error).message}`;
      }
    }
  };

  const cleanup = () => { try { stdin.setRawMode(false); } catch { /* */ } stdin.pause(); out(A.showCur + "\n"); };

  stdin.setRawMode(true);
  stdin.resume();
  render();
  try {
    for await (const chunk of stdin) {
      const k = chunk.toString();
      flash = "";
      if (k === "\x03") break; // Ctrl-C
      if (mode === "search") {
        if (k === "\r" || k === "\n") {
          mode = "list"; cursor = 0;
          if (query.trim()) {
            searching = true; render();
            try { hits = await searchRegistry(query.trim()); flash = hits.length ? "" : "no registry results"; }
            catch (e) { flash = `registry error: ${(e as Error).message}`; }
            searching = false;
          }
        } else if (k === "\x1b") { mode = "list"; query = ""; }
        else if (k === "\x7f" || k === "\b") { query = query.slice(0, -1); }
        else if (k >= " " && !k.startsWith("\x1b")) { query += k; }
        render();
        continue;
      }
      // list mode
      if (k === "q" || k === "\x1b") break;
      else if (k === "/") { mode = "search"; query = ""; }
      else if (k === "\x1b[A" || k === "k") cursor = Math.max(0, cursor - 1);
      else if (k === "\x1b[B" || k === "j") cursor++;
      else if (k === "\r" || k === "\n" || k === " ") toggle();
      render();
    }
  } finally {
    cleanup();
  }
  return 0;
}
