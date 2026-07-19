import { describe, expect, test } from "bun:test";
import { stripJsonc, expandEnv } from "../src/shared/util";

describe("stripJsonc", () => {
  test("strips // and /* */ comments but not inside strings", () => {
    const s = `{
  // comment
  "a": "http://x", /* block */
  "b": 1
}`;
    expect(JSON.parse(stripJsonc(s))).toEqual({ a: "http://x", b: 1 });
  });
});

describe("expandEnv", () => {
  test("replaces ${VAR} from env and leaves unknown untouched", () => {
    expect(expandEnv("t-${FOO}-${NOPE}", { FOO: "x" })).toBe("t-x-${NOPE}");
  });
});
