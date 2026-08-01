import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisher, searchRegistry, toServerCfg } from "../src/shared/registry";

// isolate the per-query cache so it starts empty and never touches ~/.cache.
process.env.MDUCT_CACHE = mkdtempSync(join(tmpdir(), "mduct-cache-"));

// Fixture registry serving the real v0 shape (verified 2026-07-19 against
// registry.modelcontextprotocol.io). Counts requests so tests can assert cache hits.
let requests = 0;
const fixture = Bun.serve({
  port: 0,
  fetch(req) {
    requests++;
    const url = new URL(req.url);
    if (url.pathname !== "/v0/servers") return new Response("nf", { status: 404 });
    const q = url.searchParams.get("search") ?? "";
    const all = [
      {
        server: {
          name: "com.gitlab/mcp", description: "Official GitLab MCP Server", version: "0.0.1",
          remotes: [{ type: "streamable-http", url: "https://gitlab.com/api/v4/mcp" }],
        },
      },
      {
        server: {
          name: "io.example/fs", description: "Filesystem via npm", version: "0.1.2",
          packages: [{
            registryType: "npm", identifier: "remote-filesystem-mcp-server", version: "0.1.2",
            runtimeHint: "npx", transport: { type: "stdio" },
            environmentVariables: [
              { name: "GCS_BUCKET", isRequired: true, description: "bucket" },
              { name: "GCS_ROOT_PATH", description: "optional prefix" },
            ],
          }],
        },
      },
      { server: { name: "io.cachetest/srv", description: "cache probe" } },
      // same ref published three times, ascending, isLatest on the last (real v0 ordering)
      { server: { name: "io.dupe/multi", description: "old desc", version: "1.0.0" },
        _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } } },
      { server: { name: "io.dupe/multi", description: "mid desc", version: "1.5.0" },
        _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } } },
      { server: { name: "io.dupe/multi", description: "latest desc", version: "2.0.0" },
        _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } } },
    ];
    const servers = all.filter((s) => s.server.name.includes(q) || s.server.description.includes(q));
    return Response.json({ servers, metadata: {} });
  },
});
process.env.MDUCT_REGISTRY = `http://localhost:${fixture.port}`;
afterAll(() => fixture.stop(true));

describe("searchRegistry", () => {
  test("maps remote entries to url configs", async () => {
    const hits = await searchRegistry("gitlab");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ref: "com.gitlab/mcp", description: "Official GitLab MCP Server" });
    expect(toServerCfg(hits[0]!).cfg).toMatchObject({ url: "https://gitlab.com/api/v4/mcp" });
  });

  test("maps npm packages to npx stdio configs, PINNED to the registry version (#16)", async () => {
    const hits = await searchRegistry("Filesystem");
    const { cfg, requiredEnv } = toServerCfg(hits[0]!);
    expect(cfg).toMatchObject({ command: "npx", args: ["-y", "remote-filesystem-mcp-server@0.1.2"] });
    expect(requiredEnv).toEqual(["GCS_BUCKET"]);
    expect(cfg.env).toMatchObject({ GCS_BUCKET: "${GCS_BUCKET}" });
  });

  test("collapses repeated versions of a ref to one hit, keeping isLatest", async () => {
    const hits = await searchRegistry("io.dupe/multi");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ref: "io.dupe/multi", description: "latest desc" });
    expect(hits[0]!.entry.version).toBe("2.0.0");
  });

  test("rejects a package identifier that looks like a flag (#16 injection)", async () => {
    const hit = { ref: "x/y", description: "", entry: { name: "x/y", packages: [{ registryType: "npm", identifier: "-rf", version: "1.0.0" }] } };
    expect(() => toServerCfg(hit as any)).toThrow(/identifier/i);
  });

  test("publisher() reads the verified identity from the namespace", () => {
    expect(publisher("io.github.jtalk22/slack-mcp-server")).toEqual({ kind: "github", who: "github.com/jtalk22" });
    expect(publisher("io.github.CSOAI-ORG/slack-enterprise-mcp")).toEqual({ kind: "github", who: "github.com/CSOAI-ORG" });
    expect(publisher("com.pulsemcp/slack")).toEqual({ kind: "domain", who: "pulsemcp.com" });
    expect(publisher("ai.waystation/slack")).toEqual({ kind: "domain", who: "waystation.ai" });
    expect(publisher("plainname")).toEqual({ kind: "other", who: "plainname" });
  });

  test("caches per query (case-normalized) — a repeat lookup skips the network", async () => {
    const before = requests;
    const first = await searchRegistry("cachetest");
    expect(requests).toBe(before + 1); // hit the fixture once
    expect(first[0]).toMatchObject({ ref: "io.cachetest/srv" });
    const again = await searchRegistry("CacheTest"); // same key → served from fresh cache
    expect(requests).toBe(before + 1); // no second network call
    expect(again).toEqual(first);
  });

  test("serves a stale cache when the fetch fails, instead of erroring", async () => {
    const good = await searchRegistry("cachetest"); // ensure cache is populated
    const file = join(process.env.MDUCT_CACHE!, "registry", "cachetest.json");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000); // age past the 24h TTL
    utimesSync(file, old, old);
    const base = process.env.MDUCT_REGISTRY;
    process.env.MDUCT_REGISTRY = "http://127.0.0.1:1"; // connection refused → fast failure
    try {
      const stale = await searchRegistry("cachetest");
      expect(stale).toEqual(good); // last-known results, not a thrown error
    } finally {
      process.env.MDUCT_REGISTRY = base;
    }
  });
});
