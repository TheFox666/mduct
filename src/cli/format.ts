import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Private, per-invocation dir for binary content — NOT a shared, predictable /tmp path (#14). */
function mediaDir(): string {
  const base = process.env.XDG_RUNTIME_DIR ?? join(homedir(), ".cache", "mcpmux");
  const root = join(base, "media");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(root, "r-"));
}

/** Minify a string IF it's valid JSON (strips pretty-print whitespace, lossless); else return as-is. */
function minifyIfJson(s: string): string {
  const t = s.trimStart();
  if (t[0] !== "{" && t[0] !== "[") return s; // cheap gate — most prose isn't JSON
  try { return JSON.stringify(JSON.parse(s)); } catch { return s; }
}

/** Print a CallResult per the output contract. Returns process exit code.
 *  raw → the full envelope as COMPACT json (token-efficient; pipe to `jq .` if you want it pretty).
 *  compact → losslessly minify any JSON-parseable text content (strips server pretty-print). */
export function printResult(res: { content: unknown[]; isError?: boolean }, opts: { raw?: boolean; compact?: boolean }): number {
  if (opts.raw) { console.log(JSON.stringify(res)); return res.isError ? 1 : 0; }
  const lines: string[] = [];
  let dir: string | null = null;
  for (const [i, c0] of (res.content ?? []).entries()) {
    const c = c0 as any;
    if (c.type === "text") lines.push(opts.compact ? minifyIfJson(c.text) : c.text);
    else if (c.data && c.mimeType) {
      const ext = String(c.mimeType).split("/")[1]?.split("+")[0] ?? "bin";
      dir ??= mediaDir();
      const file = join(dir, `${i}.${ext}`);
      writeFileSync(file, Buffer.from(c.data, "base64"), { mode: 0o600 });
      lines.push(file);
    } else lines.push(JSON.stringify(c));
  }
  const text = lines.join("\n");
  if (res.isError) { console.error(text); return 1; }
  console.log(text);
  return 0;
}

/**
 * Coerce a k=v string value. Only true/false and PLAIN safe integers/decimals convert;
 * everything else stays a string. Leading-zero ("007"), big ints past safe range, blanks,
 * hex/exp notation, and the literal words stay verbatim so IDs are never corrupted (#12).
 */
function coerce(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v) && !/^-?0\d/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  } else if (/^-?\d+\.\d+$/.test(v)) {
    return Number(v);
  }
  return v;
}

/** The prompt/index block — MCP servers + CLI tools — shared by `mux index` and the SessionStart hook. */
export function renderIndex(cfg: { servers: Record<string, { note?: string; disabled?: boolean }>; tools: Record<string, { note?: string; disabled?: boolean }> }): string[] {
  const out: string[] = [];
  const servers = Object.entries(cfg.servers).filter(([, s]) => !s.disabled);
  const tools = Object.entries(cfg.tools).filter(([, t]) => !t.disabled);
  if (servers.length) {
    out.push("MCP tools via `mux` CLI (list+args: mux tools <server>; call: mux call <server> <tool> key=value key:=<json>):");
    for (const [name, s] of servers) out.push(`  ${name.padEnd(12)} — ${s.note ?? "MCP server"}`);
  }
  if (tools.length) {
    out.push("CLI tools via `mux` CLI (run: mux run <tool> [args…]):");
    for (const [name, t] of tools) out.push(`  ${name.padEnd(12)} — ${t.note ?? "CLI tool"}`);
  }
  return out;
}

/** Compact call signature from a tool's inputSchema: `(required, optional?)`. Empty when none. */
export function toolSignature(inputSchema: unknown): string {
  const s = inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  const props = s?.properties ? Object.keys(s.properties) : [];
  if (props.length === 0) return "";
  const req = new Set(s?.required ?? []);
  return `(${props.map((k) => (req.has(k) ? k : `${k}?`)).join(", ")})`;
}

/**
 * key=value pairs → tool arguments. Two forms, httpie-style:
 *   key=value    scalar (coerced: plain int/float/bool; everything else, incl. big ids, stays string)
 *   key:=json    the value is parsed as JSON (arrays/objects/typed) — mix nested args without --args
 * `--args '<json>'` still merges a whole object on top (wins on key conflict).
 */
export function parseArgs(pairs: string[], argsJson?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq < 1) throw new Error(`bad argument "${p}" — use key=value, key:=<json>, or --args '<json>'`);
    const rawKey = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (rawKey.endsWith(":")) {
      // key:=json — value is a JSON literal
      try { out[rawKey.slice(0, -1)] = JSON.parse(v); }
      catch { throw new Error(`bad argument "${p}" — the value after ':=' must be valid JSON (e.g. labels:='["a","b"]')`); }
    } else {
      out[rawKey] = coerce(v);
    }
  }
  return argsJson ? { ...out, ...JSON.parse(argsJson) } : out;
}
