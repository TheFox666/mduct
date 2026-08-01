import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argHint, catalogEntries, catalogFingerprint, watchTargets } from "../src/cli/mcpCatalog";
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

describe("hot reload", () => {
  test("the fingerprint changes only when the rendered catalogue does", () => {
    const a = catalogEntries(cfg({ kb: { mcpCatalog: true } }));
    expect(catalogFingerprint(a)).toBe(catalogFingerprint(catalogEntries(cfg({ kb: { mcpCatalog: true } }))));
    // a server joining the catalogue is a change
    expect(catalogFingerprint(catalogEntries(cfg({ kb: { mcpCatalog: true }, huge: { mcpCatalog: true } }))))
      .not.toBe(catalogFingerprint(a));
    // ...and a tool gaining a description is too, since that is what the client sees
    writeToolCache("kb", [{ name: "find_symbol", sig: "(name, repo?)", desc: "now with a note" }]);
    expect(catalogFingerprint(catalogEntries(cfg({ kb: { mcpCatalog: true } })))).not.toBe(catalogFingerprint(a));
  });

  test("watches the config dir and THIS config's cache dir, not its parent", () => {
    const t = watchTargets();
    expect(t).toContain(cache);                                   // config lives directly here
    // the hashed per-config directory: a non-recursive watch on `tools` would miss writes inside it
    expect(t.some((p) => p.startsWith(join(cache, "tools", "")) && p !== join(cache, "tools"))).toBe(true);
  });
});

test("the running server announces a changed catalogue instead of waiting for a restart", async () => {
  const d = mkdtempSync(join(tmpdir(), "mduct-hot-"));
  const cfgPath = join(d, "c.jsonc");
  writeFileSync(cfgPath, JSON.stringify({ servers: { kb: { command: "true", mcpCatalog: true } } }));
  const env = { ...process.env, MDUCT_CONFIG: cfgPath, MDUCT_CACHE: join(d, "cache") };
  // seed one tool so the catalogue is non-empty to begin with
  const seed = Bun.spawnSync([process.execPath, "-e",
    'const {writeToolCache}=require("./src/shared/toolCache");writeToolCache("kb",[{name:"a",sig:"(x)"}]);'], { env });
  expect(seed.exitCode).toBe(0);

  const p = Bun.spawn([process.execPath, "src/main.ts", "mcp"], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const w = (o: unknown) => p.stdin.write(JSON.stringify(o) + "\n");
  w({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await Bun.sleep(400);
  w({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  const notified = (async () => {
    const reader = p.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      if (buf.includes("notifications/tools/list_changed")) return true;
    }
    return false;
  })();

  await Bun.sleep(800);
  writeFileSync(cfgPath, JSON.stringify({ servers: { kb: { command: "true", mcpCatalog: true }, two: { command: "true", mcpCatalog: true } } }));
  const seed2 = Bun.spawnSync([process.execPath, "-e",
    'const {writeToolCache}=require("./src/shared/toolCache");writeToolCache("two",[{name:"b",sig:"(y)"}]);'], { env });
  expect(seed2.exitCode).toBe(0);

  expect(await notified).toBe(true);
  p.kill();
}, 30_000);

test("rewriting the cache with identical content does NOT wake the client", async () => {
  const d = mkdtempSync(join(tmpdir(), "mduct-quiet-"));
  const cfgPath = join(d, "c.jsonc");
  writeFileSync(cfgPath, JSON.stringify({ servers: { kb: { command: "true", mcpCatalog: true } } }));
  const env = { ...process.env, MDUCT_CONFIG: cfgPath, MDUCT_CACHE: join(d, "cache") };
  const seed = () => Bun.spawnSync([process.execPath, "-e",
    'const {writeToolCache}=require("./src/shared/toolCache");writeToolCache("kb",[{name:"a",sig:"(x)"}]);'], { env });
  expect(seed().exitCode).toBe(0);

  const p = Bun.spawn([process.execPath, "src/main.ts", "mcp"], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
  await Bun.sleep(600);

  let saw = false;
  const reader = p.stdout.getReader();
  const dec = new TextDecoder();
  void (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (dec.decode(value).includes("list_changed")) saw = true;
    }
  })();

  seed(); seed(); seed();          // same content, three times — the file mtime moves, the catalogue does not
  await Bun.sleep(1500);           // well past the 300 ms debounce
  expect(saw).toBe(false);
  p.kill();
}, 30_000);


test("a server learning its tools notifies too — not just a config edit", async () => {
  const d = mkdtempSync(join(tmpdir(), "mduct-cachehot-"));
  const cfgPath = join(d, "c.jsonc");
  writeFileSync(cfgPath, JSON.stringify({ servers: { kb: { command: "true", mcpCatalog: true } } }));
  const env = { ...process.env, MDUCT_CONFIG: cfgPath, MDUCT_CACHE: join(d, "cache") };
  const seed = (tools: string) => Bun.spawnSync([process.execPath, "-e",
    `const {writeToolCache}=require("./src/shared/toolCache");writeToolCache("kb",${tools});`], { env });
  expect(seed('[{name:"a",sig:"(x)"}]').exitCode).toBe(0);

  const p = Bun.spawn([process.execPath, "src/main.ts", "mcp"], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
  await Bun.sleep(600);

  let saw = false;
  const reader = p.stdout.getReader();
  const dec = new TextDecoder();
  void (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (dec.decode(value).includes("list_changed")) saw = true;
    }
  })();

  // ONLY the cache changes — the config file is untouched
  seed('[{name:"a",sig:"(x)"},{name:"b",sig:"(y)"}]');
  await Bun.sleep(1500);
  expect(saw).toBe(true);
  p.kill();
}, 30_000);
