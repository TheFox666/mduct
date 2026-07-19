import { describe, expect, test } from "bun:test";
import { parseArgs, printResult, toolSignature } from "../src/cli/format";

function capture(fn: () => void): string {
  const out: string[] = [];
  const orig = console.log;
  console.log = (s?: unknown) => { out.push(String(s)); };
  try { fn(); } finally { console.log = orig; }
  return out.join("\n");
}

describe("printResult output compaction", () => {
  test("--compact losslessly minifies JSON-parseable text content", () => {
    const s = capture(() => printResult({ content: [{ type: "text", text: '{\n  "a": 1,\n  "b": [1, 2]\n}' }] }, { compact: true }));
    expect(s).toBe('{"a":1,"b":[1,2]}');
  });
  test("--compact leaves prose (non-JSON) untouched", () => {
    const s = capture(() => printResult({ content: [{ type: "text", text: "just some prose" }] }, { compact: true }));
    expect(s).toBe("just some prose");
  });
  test("--raw emits a compact envelope (no pretty-print indentation)", () => {
    const s = capture(() => printResult({ content: [{ type: "text", text: "x" }] }, { raw: true }));
    expect(s).not.toMatch(/\n\s+/); // no indented lines
    expect(JSON.parse(s)).toEqual({ content: [{ type: "text", text: "x" }] });
  });
});

function run(fn: () => number): { out: string; err: string; code: number } {
  const out: string[] = [], err: string[] = [];
  const ol = console.log, oe = process.stderr.write;
  console.log = (s?: unknown) => { out.push(String(s)); };
  (process.stderr as unknown as { write: (s: unknown) => boolean }).write = (s: unknown) => { err.push(String(s)); return true; };
  let code = 0;
  try { code = fn(); } finally { console.log = ol; process.stderr.write = oe; }
  return { out: out.join("\n"), err: err.join(""), code };
}

describe("printResult oversized-list guard (warnAbove)", () => {
  const big = JSON.stringify({ issues: Array.from({ length: 40 }, (_, i) => ({ id: `X-${i}`, title: `t${i}`, status: "open", description: "d".repeat(200) })) });
  const call = (opts: Record<string, unknown>) => run(() => printResult({ content: [{ type: "text", text: big }] }, { compact: true, warnAbove: 200, server: "lin", tool: "list_issues", ...opts }));

  test("over threshold: warns to stderr with a real projection, prints nothing, returns 2", () => {
    const r = call({});
    expect(r.code).toBe(2);
    expect(r.out).toBe(""); // the blob never reaches stdout / context
    expect(r.err).toContain("too big");
    expect(r.err).toContain(".issues|map({"); // dominant array projected
    expect(r.err).toMatch(/id.*title.*status/); // short/id-like fields kept
    expect(r.err).toContain("description"); // long field named as dropped
    expect(r.err).toContain("--full");
  });
  test("--full bypasses the guard: prints the (compact) blob, returns 0", () => {
    const r = call({ full: true });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toBe(big); // already minified (compact); lossless
  });
  test("over threshold but not JSON/projectable → prints normally (never cry wolf)", () => {
    const r = run(() => printResult({ content: [{ type: "text", text: "x".repeat(500) }] }, { warnAbove: 200, server: "s", tool: "t" }));
    expect(r.code).toBe(0);
    expect(r.out).toBe("x".repeat(500));
    expect(r.err).toBe("");
  });
  test("under threshold → prints normally", () => {
    const r = run(() => printResult({ content: [{ type: "text", text: '{"a":1}' }] }, { compact: true, warnAbove: 200 }));
    expect(r.code).toBe(0);
    expect(r.out).toBe('{"a":1}');
  });
  test("no warnAbove set → guard is inert", () => {
    const r = call({ warnAbove: undefined });
    expect(r.code).toBe(0);
    expect(r.out).toBe(big);
  });
});

describe("toolSignature", () => {
  test("required plain, optional with ?", () => {
    const schema = { type: "object", properties: { name: {}, repo: {} }, required: ["name"] };
    expect(toolSignature(schema)).toBe("(name, repo?)");
  });
  test("no properties → empty", () => {
    expect(toolSignature({ type: "object" })).toBe("");
    expect(toolSignature(undefined)).toBe("");
  });
  test("all optional", () => {
    expect(toolSignature({ properties: { a: {}, b: {} } })).toBe("(a?, b?)");
  });
});

describe("parseArgs :=  (httpie-style JSON values)", () => {
  test("key:=json parses the value as JSON; key=value stays scalar/coerced", () => {
    const out = parseArgs(['state=open', 'labels:=["bug","p1"]', 'limit=5', 'nested:={"a":1}']);
    expect(out).toEqual({ state: "open", labels: ["bug", "p1"], limit: 5, nested: { a: 1 } });
  });
  test("key:= with a bad JSON value throws a helpful error", () => {
    expect(() => parseArgs(['x:=[oops'])).toThrow(/x:=.*JSON/i);
  });
  test("plain scalar coercion unchanged (big ids stay strings)", () => {
    expect(parseArgs(['id=12345678901234567890', 'n=3', 'ok=true'])).toEqual({ id: "12345678901234567890", n: 3, ok: true });
  });
});
