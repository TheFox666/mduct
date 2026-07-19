import { describe, expect, test } from "bun:test";
import { normalizeArgs } from "../src/daemon/connection";

const schema = {
  type: "object",
  properties: {
    project_id: { type: "string" },
    nickname: { type: ["string", "null"] },
    limit: { type: "integer" },
    ratio: { type: "number" },
    active: { type: "boolean" },
    id_or_num: { type: ["string", "integer"] }, // union → leave the CLI's value
    name: { type: "string" },
  },
};

describe("normalizeArgs (schema-aware coercion)", () => {
  test("string param, number value → string (the project_id -32602 fix)", () => {
    expect(normalizeArgs({ project_id: 38077343 }, schema).project_id).toBe("38077343");
  });
  test("nullable string param ([string,null]), number → string", () => {
    expect(normalizeArgs({ nickname: 42 }, schema).nickname).toBe("42");
  });
  test("integer param, numeric string → number; already-number stays", () => {
    expect(normalizeArgs({ limit: "20" }, schema).limit).toBe(20);
    expect(normalizeArgs({ limit: 20 }, schema).limit).toBe(20);
    expect(normalizeArgs({ ratio: "1.5" }, schema).ratio).toBe(1.5);
  });
  test("boolean param, 'true'/'false' string → bool", () => {
    expect(normalizeArgs({ active: "true" }, schema).active).toBe(true);
    expect(normalizeArgs({ active: "false" }, schema).active).toBe(false);
  });
  test("union [string,integer] → leave the value untouched (already valid)", () => {
    expect(normalizeArgs({ id_or_num: 5 }, schema).id_or_num).toBe(5);
    expect(normalizeArgs({ id_or_num: "5" }, schema).id_or_num).toBe("5");
  });
  test("string param, non-numeric string → unchanged", () => {
    expect(normalizeArgs({ name: "hello" }, schema).name).toBe("hello");
  });
  test("integer param, non-numeric string → left as-is (don't force a bad value)", () => {
    expect(normalizeArgs({ limit: "abc" }, schema).limit).toBe("abc");
  });
  test("no schema / param absent from schema → args unchanged", () => {
    expect(normalizeArgs({ x: 1, y: "z" }, undefined)).toEqual({ x: 1, y: "z" });
    expect(normalizeArgs({ unknown: 7 }, schema).unknown).toBe(7);
  });
  test("explicit :=/array values pass through (non-string, not coerced)", () => {
    const labels = ["bug", "p1"];
    expect(normalizeArgs({ project_id: 1, labels }, schema).labels).toBe(labels);
  });
});
