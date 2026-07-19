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

/** The JSON payload inside a call result, wherever it sits. A server may return the data in its own
 *  text block alongside a prose summary block (GitLab: "Found 3275 merge requests" + the JSON), so
 *  we can't just parse the joined output — scan the text blocks and take the largest that parses. */
function jsonPayload(res: { content?: unknown[] }): unknown | undefined {
  let best: { data: unknown; len: number } | undefined;
  for (const c0 of res.content ?? []) {
    const c = c0 as { type?: string; text?: string };
    if (c.type !== "text" || typeof c.text !== "string") continue;
    const t = c.text.trimStart();
    if (t[0] !== "{" && t[0] !== "[") continue;
    try { const data = JSON.parse(c.text); if (!best || c.text.length > best.len) best = { data, len: c.text.length }; } catch { /* not JSON */ }
  }
  return best?.data;
}

/** A projectable list found inside a call result: the dominant array + which item fields are worth
 *  keeping (short scalars / id-like) vs dropping (long strings, nested). Null when there's nothing
 *  to slim (no array, or no short fields — don't cry wolf on data we can't help with). */
type Recipe = { path: string; keep: string[]; drop: string[]; count: number };
const ID_LIKE = /^(id|iid|key|identifier|name|title|state|status|url|web_url|weburl|href|link|permalink|slug|number|priority|type|label)s?$/i;
function projectionRecipe(data: unknown): Recipe | null {
  // dominant array = the value itself, or the object property holding the most items
  let arr: unknown[] | null = null, path = ".";
  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === "object") {
    let best: { k: string; a: unknown[] } | null = null;
    for (const [k, v] of Object.entries(data))
      if (Array.isArray(v) && (!best || v.length > best.a.length)) best = { k, a: v };
    if (best) { arr = best.a; path = `.${best.k}`; }
  }
  if (!arr || arr.length === 0) return null;
  const objs = arr.filter((x) => x && typeof x === "object" && !Array.isArray(x)).slice(0, 30) as Record<string, unknown>[];
  if (objs.length === 0) return null;
  const keys = new Set<string>();
  for (const o of objs) for (const k of Object.keys(o)) keys.add(k);
  // classify: id-like scalars are the identity/summary fields agents actually want; other short
  // scalars are a fallback; long strings + nested objects are the space hogs to drop. Keeping
  // "every short scalar" is the trap — it drags in 15 timestamps/ids and slims nothing.
  const idLike: string[] = [], shortScalar: string[] = [], heavy: string[] = [];
  for (const k of keys) {
    let maxLen = 0, scalar = true;
    for (const o of objs) {
      const v = o[k];
      if (v == null) continue;
      if (typeof v === "object") { scalar = false; break; }
      maxLen = Math.max(maxLen, String(v).length);
    }
    if (!scalar) heavy.push(k);              // nested object/array
    else if (ID_LIKE.test(k)) idLike.push(k); // identity/summary — keep even if longish (title, url)
    else if (maxLen <= 40) shortScalar.push(k);
    else heavy.push(k);                       // long non-id string = description/body-like
  }
  // prefer the id-like set; only fall back to short scalars when there are no id-like fields at all
  const keep = (idLike.length ? idLike : shortScalar).slice(0, 8);
  if (keep.length === 0) return null;
  const drop = [...heavy, ...idLike, ...shortScalar].filter((k) => !keep.includes(k));
  return { path, keep, drop, count: arr.length };
}

/** The stderr warning shown in place of an oversized dump: size, a ready --json|jq projection with
 *  the real field names, what got dropped, and the escape hatches (narrow / --full). Uses --json
 *  (clean JSON payload) so the pipe works even when the server prefixes prose (GitLab). */
function oversizeWarning(chars: number, server: string, tool: string, r: Recipe): string {
  const proj = `${r.path === "." ? "" : `${r.path}|`}map({${r.keep.join(",")}})`;
  const dropNote = r.drop.length ? `   dropped (long/nested): ${r.drop.slice(0, 8).join(" ")}` : "";
  return [
    `⚠ ${r.count} items, ~${Math.round(chars / 1024)} KB — too big for context. Slim it, don't dump it:`,
    `  project fields:  mux call ${server} ${tool} … --json | jq -c '${proj}'`,
    `  fields kept:     ${r.keep.join(" ")}${dropNote}`,
    `  or narrow:       add filter args (limit=/state=/query=…) — mux schema ${server} ${tool}`,
    `  or full anyway:  re-run with --full`,
  ].join("\n");
}

/** Print a CallResult per the output contract. Returns process exit code.
 *  raw → the full envelope as COMPACT json (token-efficient; pipe to `jq .` if you want it pretty).
 *  json → ONLY the JSON payload (the data block, prose stripped), minified — clean to pipe to jq
 *    on any server; falls back to the text output when the result holds no JSON.
 *  compact → losslessly minify any JSON-parseable text content (strips server pretty-print).
 *  warnAbove (chars) → when the printed output exceeds it and holds a projectable list, print a
 *    slim-it-first warning to stderr instead of the blob (return 2); --full/--json bypass the guard. */
export function printResult(res: { content: unknown[]; isError?: boolean }, opts: { raw?: boolean; json?: boolean; compact?: boolean; full?: boolean; warnAbove?: number; server?: string; tool?: string }): number {
  if (opts.raw) { console.log(JSON.stringify(res)); return res.isError ? 1 : 0; }
  if (opts.json && !res.isError) {
    const payload = jsonPayload(res);
    if (payload !== undefined) { console.log(JSON.stringify(payload)); return 0; }
    // no JSON in the result → fall through to normal text output (nothing to pipe)
  }
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
  // size guard: keep an oversized dump out of the caller's context (only when we can suggest a
  // projection — otherwise printing is the only useful thing we can do). Find the JSON among the
  // content blocks, not in the joined text, so a prose-prefixed result (GitLab) still triggers.
  if (!opts.full && !opts.json && opts.warnAbove && text.length > opts.warnAbove) {
    const r = projectionRecipe(jsonPayload(res));
    if (r) { process.stderr.write(`${oversizeWarning(text.length, opts.server ?? "<server>", opts.tool ?? "<tool>", r)}\n`); return 2; }
  }
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
