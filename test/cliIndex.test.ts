import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderIndex } from "../src/cli/format";
import { readToolCache, writeToolCache } from "../src/shared/toolCache";

describe("renderIndex — tool signatures from the cache", () => {
  const cache = mkdtempSync(join(tmpdir(), "mduct-idx-"));
  process.env.MDUCT_CACHE = cache;
  process.env.MDUCT_CONFIG = join(cache, "servers.jsonc");
  // through the API, not by hand: the on-disk layout is the cache's business, and a test that
  // reimplements it stops testing the thing it claims to
  const write = (server: string, n: number) =>
    writeToolCache(server, Array.from({ length: n }, (_, i) => ({ name: `t${i}`, sig: "(a, b?)" })));

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

describe("tool cache is namespaced by config, not just by server name", () => {
  test("two configs with the same server name never see each other's tools", () => {
    const cache = mkdtempSync(join(tmpdir(), "mduct-ns-"));
    process.env.MDUCT_CACHE = cache;
    const a = join(cache, "a.jsonc"), b = join(cache, "b.jsonc");
    writeFileSync(a, "{}"); writeFileSync(b, "{}");

    // the real config learns gitlab's tools
    process.env.MDUCT_CONFIG = a;
    writeToolCache("gitlab", [{ name: "list_issues", sig: "(project)" }]);

    // a throwaway config uses the SAME name for a fixture — this is what poisoned the index
    process.env.MDUCT_CONFIG = b;
    writeToolCache("gitlab", [{ name: "boom", sig: "" }]);
    expect(readToolCache("gitlab")).toEqual([{ name: "boom", sig: "" }]);

    // ...and the real one is untouched
    process.env.MDUCT_CONFIG = a;
    expect(readToolCache("gitlab")).toEqual([{ name: "list_issues", sig: "(project)" }]);
  });
});
