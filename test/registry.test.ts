import { afterAll, describe, expect, test } from "bun:test";
import { searchRegistry, toServerCfg } from "../src/shared/registry";

// Fixture registry serving the real v0 shape (verified 2026-07-19 against
// registry.modelcontextprotocol.io).
const fixture = Bun.serve({
  port: 0,
  fetch(req) {
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
    ];
    const servers = all.filter((s) => s.server.name.includes(q) || s.server.description.includes(q));
    return Response.json({ servers, metadata: {} });
  },
});
process.env.MCPMUX_REGISTRY = `http://localhost:${fixture.port}`;
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

  test("rejects a package identifier that looks like a flag (#16 injection)", async () => {
    const hit = { ref: "x/y", description: "", entry: { name: "x/y", packages: [{ registryType: "npm", identifier: "-rf", version: "1.0.0" }] } };
    expect(() => toServerCfg(hit as any)).toThrow(/identifier/i);
  });
});
