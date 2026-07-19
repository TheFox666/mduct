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

/** Print a CallResult per the output contract. Returns process exit code. */
export function printResult(res: { content: unknown[]; isError?: boolean }, raw: boolean): number {
  if (raw) { console.log(JSON.stringify(res, null, 2)); return res.isError ? 1 : 0; }
  const lines: string[] = [];
  let dir: string | null = null;
  for (const [i, c0] of (res.content ?? []).entries()) {
    const c = c0 as any;
    if (c.type === "text") lines.push(c.text);
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

/** k=v pairs + optional --args JSON → tool arguments. JSON wins on key conflict. */
export function parseArgs(pairs: string[], argsJson?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq < 1) throw new Error(`bad argument "${p}" — use key=value or --args '<json>'`);
    const v = p.slice(eq + 1);
    out[p.slice(0, eq)] = coerce(v);
  }
  return argsJson ? { ...out, ...JSON.parse(argsJson) } : out;
}
