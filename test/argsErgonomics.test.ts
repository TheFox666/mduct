import { describe, expect, test } from "bun:test";
import { parseArgs, toolSignature } from "../src/cli/format";

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
