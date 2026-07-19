import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = Bun.serve({
  port: 0,
  fetch(req) {
    const m = new URL(req.url).pathname.match(/^\/(.+)\/latest$/);
    const pkg = m ? decodeURIComponent(m[1]!) : "";
    if (pkg === "playwright") return Response.json({ version: "1.62.0" });
    return new Response("nf", { status: 404 });
  },
});
afterAll(() => fixture.stop(true));

const dir = mkdtempSync(join(tmpdir(), "mux-"));
const cfgPath = join(dir, "servers.jsonc");
const env = { ...process.env, MCPMUX_CONFIG: cfgPath, MCPMUX_SECRETS: join(dir, "s.json"), MCPMUX_NPM_REGISTRY: `http://localhost:${fixture.port}` };
writeFileSync(cfgPath, JSON.stringify({
  servers: {},
  tools: {
    playwright: { run: "bunx", args: ["playwright@1.61.1"], check: "bunx playwright@1.61.1 --version", setup: "bunx playwright@1.61.1 install chromium", note: "browser" },
    kubectl: { run: "kubectl", note: "k8s" },
  },
}));

async function mux(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("tool status flags an available update for a pinned npm tool", async () => {
  const r = await mux("tool", "status");
  expect(r.out).toMatch(/playwright.*1\.61\.1.*1\.62\.0/); // update 1.61.1 → 1.62.0
  expect(r.out).not.toMatch(/kubectl.*→/); // non-npm tool: no update line
});

test("tool update re-pins the config to the latest version everywhere", async () => {
  const r = await mux("tool", "update", "playwright");
  expect(r.code).toBe(0);
  expect(r.out).toContain("1.61.1 → 1.62.0");
  const cfg = readFileSync(cfgPath, "utf8");
  expect(cfg).toContain("playwright@1.62.0");
  expect(cfg).not.toContain("playwright@1.61.1"); // bumped in args AND check AND setup
});

test("tool update with nothing newer says up to date", async () => {
  const r = await mux("tool", "update", "playwright"); // now already 1.62.0
  expect(r.out).toMatch(/up to date|1\.62\.0/);
});
