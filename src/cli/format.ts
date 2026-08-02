import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { readToolCache } from "../shared/toolCache";
import { join } from "node:path";
import { home } from "../shared/paths";

/** Write to stdout SYNCHRONOUSLY and COMPLETELY (fd 1). Traps this avoids: (1) console.log is async
 *  on a pipe, so process.exit() drops the un-drained tail of a big payload; (2) a single writeSync
 *  only pushes one pipe buffer (~64KB) and returns a SHORT count — loop until every byte is out;
 *  (3) fd 1 is non-blocking, so a full pipe throws EAGAIN — sleep 1ms and retry, never a hot spin
 *  (a stalled-but-open reader would otherwise pin a core); (4) a closed reader (`| head`) throws
 *  EPIPE — stop cleanly like every other Unix tool instead of erroring. */
function emit(s: string): void {
  const buf = Buffer.from(`${s}\n`);
  let off = 0;
  while (off < buf.length) {
    try { off += writeSync(1, buf, off, buf.length - off); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") { Bun.sleepSync(1); continue; } // pipe full → yield, don't burn a core
      if (code === "EPIPE") return; // reader closed the pipe (e.g. `| head`) → done, cleanly
      throw e;
    }
  }
}

/** Private, per-invocation dir for binary content — NOT a shared, predictable /tmp path (#14). */
function mediaDir(): string {
  const base = process.env.XDG_RUNTIME_DIR ?? join(home(), ".cache", "mduct");
  const root = join(base, "media");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // reap prior invocations' media dirs (>1h old). Each mduct call mkdtemps a fresh dir and emits the
  // file PATH — the agent reads it AFTER this process exits, so we can't clean at exit; sweep old
  // ones here instead, or the ~/.cache fallback (not tmpfs-cleared) grows without bound (#3).
  try {
    const cutoff = Date.now() - 3_600_000;
    for (const name of readdirSync(root)) {
      const p = join(root, name);
      try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true }); } catch { /* racing sweep / in-use */ }
    }
  } catch { /* first run: root just created, nothing to reap */ }
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
  // jq object shorthand `{id}` only works for bare-identifier keys; a hyphen/dot/unicode key
  // (e.g. web-url) needs the explicit `"k": .["k"]` form or the pasted command is a jq syntax error.
  const fields = r.keep.map((k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `${JSON.stringify(k)}:.[${JSON.stringify(k)}]`)).join(",");
  const proj = `${r.path === "." ? "" : `${r.path}|`}map({${fields}})`;
  const dropNote = r.drop.length ? `   dropped (long/nested): ${r.drop.slice(0, 8).join(" ")}` : "";
  return [
    `⚠ ${r.count} items, ~${Math.round(chars / 1024)} KB — too big for context. Slim it, don't dump it:`,
    `  project fields:  mduct call ${server} ${tool} … --json | jq -c '${proj}'`,
    `  fields kept:     ${r.keep.join(" ")}${dropNote}`,
    `  or narrow:       add filter args (limit=/state=/query=…) — mduct schema ${server} ${tool}`,
    `  or full anyway:  re-run with --full`,
  ].join("\n");
}

export type CallOpts = { raw?: boolean; json?: boolean; compact?: boolean; full?: boolean; warnAbove?: number; server?: string; tool?: string };
export type Formatted = { out?: string; err?: string; code: number };

/** Compute a call result's output per the contract — PURE except for writing embedded media to disk.
 *  Returns what goes to stdout (out) / stderr (err) + the exit code; the CLI writes it, tests read it.
 *  raw → the full envelope as COMPACT json (pipe to `jq .` to pretty it).
 *  json → ONLY the JSON payload (data block, prose stripped), minified — clean to pipe on any server;
 *    falls back to text output when the result holds no JSON.
 *  compact → losslessly minify any JSON-parseable text content (strips server pretty-print).
 *  warnAbove (chars) → oversized + projectable list → a slim-it-first warning on stderr (code 2)
 *    instead of the blob; --full/--json bypass the guard. */
export function formatResult(res: { content: unknown[]; isError?: boolean }, opts: CallOpts): Formatted {
  if (opts.raw) return { out: JSON.stringify(res), code: res.isError ? 1 : 0 };
  if (opts.json && !res.isError) {
    const payload = jsonPayload(res);
    if (payload !== undefined) return { out: JSON.stringify(payload), code: 0 };
    // no JSON in the result (e.g. a markdown-only server) → fail LOUD on stderr instead of quietly
    // printing prose to stdout, which would feed a `| jq` garbage while mduct exits 0 (#4).
    return { err: "--json: this result has no JSON payload (server returned text/markdown) — re-run without --json", code: 2 };
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
  if (res.isError) return { err: text, code: 1 };
  // size guard: keep an oversized dump out of the caller's context (only when we can suggest a
  // projection). Find the JSON among the content blocks, not in the joined text, so a prose-prefixed
  // result (GitLab: "Found N …" + the JSON in a separate block) still triggers.
  if (!opts.full && !opts.json && opts.warnAbove && text.length > opts.warnAbove) {
    const r = projectionRecipe(jsonPayload(res));
    if (r) return { err: oversizeWarning(text.length, opts.server ?? "<server>", opts.tool ?? "<tool>", r), code: 2 };
  }
  return { out: text, code: 0 };
}

/** Print a call result: stdout SYNC via emit() (never truncates a big --json under a slow pipe),
 *  stderr for warnings/errors. Returns the exit code. */
export function printResult(res: { content: unknown[]; isError?: boolean }, opts: CallOpts): number {
  const { out, err, code } = formatResult(res, opts);
  if (out !== undefined) emit(out);
  if (err !== undefined) process.stderr.write(`${err}\n`);
  return code;
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

/** The prompt/index block — MCP servers + CLI tools — shared by `mduct index` and the SessionStart hook. */
/**
 * The prompt block. One line per capability by default; for a server whose tools are cached and
 * few enough to be worth carrying, the tool signatures come along.
 *
 * The threshold matters: a 186-tool server would put 16 kB in every context, which is the very
 * thing this tool exists to avoid. Small servers are the opposite case — their whole surface fits
 * in a few hundred bytes, and an agent that can SEE `search_code(query, repo?)` uses it, while one
 * that only sees the server's name has to remember to ask.
 */
const INDEX_TOOL_LIMIT = 25;

export function renderIndex(cfg: {
  servers: Record<string, { note?: string; disabled?: boolean; indexTools?: boolean; mcpCatalog?: boolean }>;
  tools: Record<string, { note?: string; disabled?: boolean }>;
}): string[] {
  const out: string[] = [];
  const servers = Object.entries(cfg.servers).filter(([, s]) => !s.disabled);
  const tools = Object.entries(cfg.tools).filter(([, t]) => !t.disabled);
  if (servers.length) {
    out.push("MCP tools via `mduct` CLI (list+args: mduct tools <server>; call: mduct call <server> <tool> key=value key:=<json>):");
    for (const [name, s] of servers) {
      out.push(`  ${name.padEnd(12)} — ${s.note ?? "MCP server"}`);
      const cached = readToolCache(name);
      if (!cached?.length) continue;
      // already mirrored into the tool namespace by `mduct mcp` — printing the signatures here too
      // pays for the same information twice
      if (s.mcpCatalog) { out.push(`      ${cached.length} tools — in the mduct MCP catalogue`); continue; }
      const show = s.indexTools ?? cached.length <= INDEX_TOOL_LIMIT;
      if (show) out.push(`      ${cached.map((t) => t.name + t.sig).join("  ")}`);
      else out.push(`      ${cached.length} tools — mduct tools ${name}`);
    }
  }
  if (tools.length) {
    out.push("CLI tools via `mduct` CLI (what it can do: mduct tools <tool>; run: mduct run <tool> [args…]):");
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
    // A leading dash means an option, never an argument — whether or not it carries a value. Both
    // shapes reached here before: `--jsonn` was reported as a bad *argument*, pointing at the wrong
    // fix, and `--timeout=5` was accepted as a tool field called "--timeout", so the call went out
    // with an extra key and no timeout and nothing on stderr.
    if (p.startsWith("-")) throw new Error(`unknown option "${p.split("=")[0]}" — see: mduct help`);
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
