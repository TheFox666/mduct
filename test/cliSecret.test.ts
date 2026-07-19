import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-"));
const env = {
  ...process.env,
  MCPMUX_CONFIG: join(dir, "servers.jsonc"),
  MCPMUX_SECRETS: join(dir, "secrets.json"),
};

async function mux(stdin: string | null, ...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], {
    env, stdout: "pipe", stderr: "pipe", stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("secret set (piped) then list shows the name, not the value", async () => {
  const set = await mux("glpat-topsecret\n", "secret", "set", "GITLAB_PAT");
  expect(set.code).toBe(0);
  const list = await mux(null, "secret", "list");
  expect(list.out).toContain("GITLAB_PAT");
  expect(list.out).not.toContain("glpat-topsecret");
});

test("secret rm removes it", async () => {
  await mux("v\n", "secret", "set", "TMP");
  await mux(null, "secret", "rm", "TMP");
  const list = await mux(null, "secret", "list");
  expect(list.out).not.toContain("TMP");
});

test("add --env with a literal value stores a secret and writes a ${ref} (#26)", async () => {
  const r = await mux(null, "add", "gl", "--env", "GITLAB_PAT=glpat-literal", "--", "npx", "gitlab-mcp");
  expect(r.code).toBe(0);
  const cfg = readFileSync(env.MCPMUX_CONFIG!, "utf8");
  expect(cfg).toContain("${"); // a reference, not the literal
  expect(cfg).not.toContain("glpat-literal");
  const secrets = readFileSync(env.MCPMUX_SECRETS!, "utf8");
  expect(secrets).toContain("glpat-literal"); // stored in the 0600 file instead
});

test("import normalizes a plaintext token from a Claude config into the store (N1)", async () => {
  const home = mkdtempSync(join(tmpdir(), "mux-home-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    mcpServers: { gh: { command: "npx", args: ["gh-mcp"], env: { GH_TOKEN: "ghp_plaintext" } } },
  }));
  const p = Bun.spawn([process.execPath, "src/main.ts", "import", "gh"], {
    env: { ...env, MCPMUX_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  expect(err).toBe("");
  const cfg = readFileSync(env.MCPMUX_CONFIG!, "utf8");
  expect(cfg).not.toContain("ghp_plaintext"); // config keeps a ${ref}
  const secrets = readFileSync(env.MCPMUX_SECRETS!, "utf8");
  expect(secrets).toContain("ghp_plaintext"); // stored in the 0600 file
});
