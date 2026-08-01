import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../shared/config";
import { configPath } from "../shared/paths";
import { readToolCache, toolCacheDir } from "../shared/toolCache";

/**
 * `mduct mcp` — a catalogue, not a proxy.
 *
 * The prompt block is prose: an agent has to notice it. The tool namespace is where tool selection
 * actually happens, and nothing an external process writes into a prompt lands there. So mduct can
 * wear a second face: an MCP server whose tools/list mirrors the real ones, purely so the names and
 * signatures sit where they get looked at.
 *
 * It does NOT execute. Running calls through MCP would hand every result straight into the context,
 * and the shell in between — `--json | jq`, redirection, loops — is most of what makes mduct worth
 * having. So a catalogue entry answers with the command to run and nothing else. The description
 * says so too, so the usual case is that it never gets called at all.
 *
 * Opt-in per server (`mcpCatalog: true`): a 189-tool server in the namespace is the flood this
 * project exists to prevent.
 */

const EMPTY_SCHEMA = { type: "object" as const, properties: {}, additionalProperties: false };

export type CatalogEntry = { name: string; server: string; tool: string; description: string };

/** Mirror of the cached tools of every server that opted in. Pure — the tests use it directly. */
export function catalogEntries(cfg: ReturnType<typeof loadConfig>): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const [server, s] of Object.entries(cfg.servers)) {
    if (s.disabled || !s.mcpCatalog) continue;
    for (const t of readToolCache(server) ?? []) {
      const call = `mduct call ${server} ${t.name}${t.sig ? " " + argHint(t.sig) : ""}`;
      out.push({
        name: `${server}__${t.name}`,
        server,
        tool: t.name,
        // The command IS the description. The explanation of why these are not callable lives once
        // in the mduct__HOWTO entry, not 17 times over — repeated boilerplate is context nobody
        // reads twice and everybody pays for.
        description: `$ ${call}${t.desc ? ` — ${t.desc.slice(0, 80)}` : ""}`,
      });
    }
  }
  if (out.length) out.unshift({
    name: "mduct__HOWTO", server: "", tool: "",
    description: "$ prefixed entries are SHELL commands, not callable tools — run them with Bash. " +
      "Pipe instead of dumping: `mduct call <server> <tool> --json | jq -c '…'`. " +
      "Full list incl. servers not mirrored here: `mduct index`, `mduct tools <server>`.",
  });
  return out;
}

/** `(name, repo?)` → `name=… repo=…`, so the description shows a runnable shape. */
export function argHint(sig: string): string {
  return sig.replace(/^\(|\)$/g, "").split(",").map((a) => a.trim()).filter(Boolean)
    .map((a) => `${a.replace(/\?$/, "")}=…`).join(" ");
}

/** Stable fingerprint of what the catalogue currently is, so a watcher can tell real change from noise. */
export function catalogFingerprint(entries: CatalogEntry[]): string {
  return entries.map((e) => `${e.name}\u0000${e.description}`).join("\u0001");
}

export async function runCatalogServer(): Promise<number> {
  // listChanged: the catalogue is data, and the data moves — a server gets its first call and its
  // tools appear in the cache, someone flips mcpCatalog. Without the notification the namespace
  // holds whatever was true when the session started, and the client has no reason to ask again.
  const server = new Server({ name: "mduct", version: "0" }, { capabilities: { tools: { listChanged: true } } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // re-read per request: the cache grows as servers get used, and a long-lived session should
    // pick that up without a restart
    tools: catalogEntries(loadConfig()).map((e) => ({
      name: e.name, description: e.description, inputSchema: EMPTY_SCHEMA,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const hit = catalogEntries(loadConfig()).find((e) => e.name === req.params.name);
    const cmd = hit ? `mduct call ${hit.server} ${hit.tool}` : `mduct tools <server>`;
    return {
      content: [{
        type: "text" as const,
        text: `This is a catalogue entry, not a callable tool. Run it in the shell:\n\n  ${cmd} key=value\n\n` +
              `Pipe big results instead of dumping them: ${cmd} --json | jq -c '…'`,
      }],
      isError: true, // so the model treats it as "wrong move", not as a result
    };
  });

  await server.connect(new StdioServerTransport());

  // Watch the two things the catalogue is made of: the config (which servers opted in) and the
  // tool cache (what those servers can do). Debounced, and only when the rendered result actually
  // differs — a cache rewrite with identical content must not make the client re-fetch.
  let last = catalogFingerprint(safeEntries());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = catalogFingerprint(safeEntries());
      if (now === last) return;
      last = now;
      void server.sendToolListChanged().catch(() => {}); // a closed client is not our problem
    }, 300);
  };
  for (const dir of watchTargets()) {
    try { watch(dir, check); } catch { /* a missing dir just means nothing to watch yet */ }
  }

  return await new Promise<number>(() => {}); // stdio server runs until the client closes it
}

function safeEntries(): CatalogEntry[] {
  try { return catalogEntries(loadConfig()); } catch { return []; } // mid-write config: keep serving the last good one
}

/**
 * The config's directory and this config's tool-cache directory.
 *
 * The cache dir is the hashed per-config one, not its parent: a non-recursive watch on the parent
 * never sees a write one level down, which meant a server learning its tools — the most common
 * change there is — notified nobody. It is created up front so the watch has something to attach to.
 */
export function watchTargets(): string[] {
  const out = [dirname(configPath())];
  try {
    mkdirSync(toolCacheDir(), { recursive: true, mode: 0o700 });
    out.push(toolCacheDir());
  } catch { /* unwritable cache: config changes still reload */ }
  return out;
}
