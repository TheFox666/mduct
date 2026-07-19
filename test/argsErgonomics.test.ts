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
