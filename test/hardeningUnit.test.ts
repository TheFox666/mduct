import { describe, expect, test } from "bun:test";
import { guardAllows } from "../src/daemon/guard";
import { parseArgs } from "../src/cli/format";
import { stripJsonc } from "../src/shared/util";

describe("guard glob (#13)", () => {
  test("leading and mid * now match", () => {
    expect(guardAllows({ deny: ["*_delete"] }, "admin_delete")).toBe(false);
    expect(guardAllows({ deny: ["*delete*"] }, "hard_delete_now")).toBe(false);
    expect(guardAllows({ allow: ["*_read"] }, "data_read")).toBe(true);
    expect(guardAllows({ allow: ["*_read"] }, "data_write")).toBe(false);
  });
  test("trailing * still works, exact still works", () => {
    expect(guardAllows({ deny: ["admin_*"] }, "admin_delete")).toBe(false);
    expect(guardAllows({ allow: ["get_x"] }, "get_x")).toBe(true);
    expect(guardAllows({ allow: ["get_x"] }, "get_y")).toBe(false);
  });
});

describe("parseArgs coercion (#12)", () => {
  test("big ids and leading-zero stay strings", () => {
    expect(parseArgs(["id=12345678901234567890"]).id).toBe("12345678901234567890");
    expect(parseArgs(["ref=007"]).ref).toBe("007");
  });
  test("blank and non-plain-number stay strings", () => {
    expect(parseArgs(["x= "]).x).toBe(" ");
    expect(parseArgs(["x=1e5"]).x).toBe("1e5");
    expect(parseArgs(["x=0x10"]).x).toBe("0x10");
  });
  test("plain safe integers and decimals still coerce; bools still coerce", () => {
    expect(parseArgs(["n=42"]).n).toBe(42);
    expect(parseArgs(["n=-3.5"]).n).toBe(-3.5);
    expect(parseArgs(["b=true"]).b).toBe(true);
  });
  test("value with = is preserved", () => {
    expect(parseArgs(["q=a=b"]).q).toBe("a=b");
  });
});

describe("stripJsonc trailing commas (#21)", () => {
  test("object and array trailing commas parse", () => {
    expect(JSON.parse(stripJsonc(`{ "a": 1, "b": [1, 2,], }`))).toEqual({ a: 1, b: [1, 2] });
  });
  test("comma inside a string is untouched", () => {
    expect(JSON.parse(stripJsonc(`{ "a": "x,]" }`))).toEqual({ a: "x,]" });
  });
});
