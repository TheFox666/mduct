import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderIndex } from "../src/cli/format";

describe("renderIndex — tool signatures from the cache", () => {
  const cache = mkdtempSync(join(tmpdir(), "mduct-idx-"));
  process.env.MDUCT_CACHE = cache;
  mkdirSync(join(cache, "tools"), { recursive: true });
  const write = (server: string, n: number) =>
    writeFileSync(join(cache, "tools", `${server}.json`),
      JSON.stringify(Array.from({ length: n }, (_, i) => ({ name: `t${i}`, sig: "(a, b?)" }))));

  const cfg = (servers: Record<string, unknown>) => ({ servers, tools: {} }) as never;

  test("a server with no cache yet shows only its summary line", () => {
    const out = renderIndex(cfg({ fresh: { note: "never called" } })).join("\n");
    expect(out).toContain("fresh");
    expect(out).not.toContain("(a, b?)");
  });

  test("a small server carries its signatures", () => {
    write("small", 3);
    const out = renderIndex(cfg({ small: { note: "x" } })).join("\n");
    expect(out).toContain("t0(a, b?)");
    expect(out).toContain("t2(a, b?)");
  });

  test("a big one collapses to a count and a pointer — the whole point of the limit", () => {
    write("big", 186);
    const out = renderIndex(cfg({ big: { note: "x" } })).join("\n");
    expect(out).toContain("186 tools — mduct tools big");
    expect(out).not.toContain("t0(a, b?)");
  });

  test("indexTools overrides the limit in both directions", () => {
    write("big2", 186);
    write("small2", 3);
    expect(renderIndex(cfg({ big2: { indexTools: true } })).join("\n")).toContain("t0(a, b?)");
    expect(renderIndex(cfg({ small2: { indexTools: false } })).join("\n")).toContain("3 tools — mduct tools small2");
  });
});
