import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argHint, catalogEntries } from "../src/cli/mcpCatalog";
import { writeToolCache } from "../src/shared/toolCache";

const cache = mkdtempSync(join(tmpdir(), "mduct-cat-"));
process.env.MDUCT_CACHE = cache;
process.env.MDUCT_CONFIG = join(cache, "servers.jsonc");
writeFileSync(process.env.MDUCT_CONFIG, "{}");
writeToolCache("kb", [{ name: "find_symbol", sig: "(name, repo?)", desc: "where a symbol is defined" }]);
writeToolCache("huge", Array.from({ length: 189 }, (_, i) => ({ name: `t${i}`, sig: "(a)" })));

const cfg = (servers: Record<string, unknown>) => ({ servers, tools: {} }) as never;

describe("catalogEntries", () => {
  test("only mirrors servers that opted in — the flood is the thing we are avoiding", () => {
    expect(catalogEntries(cfg({ kb: {}, huge: {} }))).toEqual([]);
    const only = catalogEntries(cfg({ kb: { mcpCatalog: true }, huge: {} }));
    expect(only.map((e) => e.name)).toEqual(["mduct__HOWTO", "kb__find_symbol"]);
  });

  test("the description IS the shell command, with a runnable argument shape", () => {
    const e = catalogEntries(cfg({ kb: { mcpCatalog: true } })).find((x) => x.name === "kb__find_symbol")!;
    expect(e.description).toStartWith("$ mduct call kb find_symbol name=… repo=…");
    expect(e.description).toContain("where a symbol is defined");
    expect(e.server).toBe("kb");
    expect(e.tool).toBe("find_symbol");
  });

  test("the how-to appears once, not per entry — repeated boilerplate is paid for every time", () => {
    const all = catalogEntries(cfg({ kb: { mcpCatalog: true }, huge: { mcpCatalog: true } }));
    expect(all.filter((e) => e.name === "mduct__HOWTO")).toHaveLength(1);
    expect(all.filter((e) => e.description.includes("not callable tools"))).toHaveLength(1);
    expect(all).toHaveLength(1 + 1 + 189);
  });

  test("no opted-in server means no catalogue at all, not a lone how-to", () => {
    expect(catalogEntries(cfg({ kb: {} }))).toEqual([]);
  });

  test("argHint turns a signature into something you can type", () => {
    expect(argHint("(name, repo?)")).toBe("name=… repo=…");
    expect(argHint("()")).toBe("");
    expect(argHint("")).toBe("");
  });
});
