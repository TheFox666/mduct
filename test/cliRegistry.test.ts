import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v0/servers") return new Response("nf", { status: 404 });
    return Response.json({
      servers: [
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
              registryType: "npm", identifier: "fs-mcp", transport: { type: "stdio" },
              environmentVariables: [{ name: "FS_ROOT", isRequired: true }],
            }],
          },
        },
      ],
      metadata: {},
    });
  },
});
afterAll(() => fixture.stop(true));

const dir = mkdtempSync(join(tmpdir(), "mux-"));
const env = {
  ...process.env,
  MCPMUX_CONFIG: join(dir, "servers.jsonc"),
  MCPMUX_REGISTRY: `http://localhost:${fixture.port}`,
};

async function mux(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("search prints ref<TAB>description", async () => {
  const r = await mux("search", "gitlab");
  expect(r.code).toBe(0);
  expect(r.out).toContain("com.gitlab/mcp\tOfficial GitLab MCP Server");
});

test("add by registry ref installs http remote under --as name", async () => {
  const r = await mux("add", "com.gitlab/mcp", "--as", "gitlab");
  expect(r.code).toBe(0);
  const idx = await mux("index");
  expect(idx.out).toContain("gitlab");
});

test("add npm-package ref reports required env vars", async () => {
  const r = await mux("add", "io.example/fs", "--as", "fs");
  expect(r.code).toBe(0);
  expect(r.out).toContain("FS_ROOT"); // named so the user knows what to export
});

test("add unknown ref exits 1", async () => {
  const r = await mux("add", "does.not/exist");
  expect(r.code).toBe(1);
  expect(r.err.length).toBeGreaterThan(0);
});
