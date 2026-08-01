import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mduct-"));
const env = {
  ...process.env,
  MDUCT_CONFIG: join(dir, "servers.jsonc"),
  MDUCT_SECRETS: join(dir, "secrets.json"),
};

async function mduct(stdin: string | null, ...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([process.execPath, "src/main.ts", ...argv], {
    env, stdout: "pipe", stderr: "pipe", stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("secret set (piped) then list shows the name, not the value", async () => {
  const set = await mduct("glpat-topsecret\n", "secret", "set", "GITLAB_PAT");
  expect(set.code).toBe(0);
  const list = await mduct(null, "secret", "list");
  expect(list.out).toContain("GITLAB_PAT");
  expect(list.out).not.toContain("glpat-topsecret");
});

test("secret rm removes it", async () => {
  await mduct("v\n", "secret", "set", "TMP");
  await mduct(null, "secret", "rm", "TMP");
  const list = await mduct(null, "secret", "list");
  expect(list.out).not.toContain("TMP");
});

test("add --env with a literal value stores a secret and writes a ${ref} (#26)", async () => {
  const r = await mduct(null, "add", "gl", "--env", "GITLAB_PAT=glpat-literal", "--", "npx", "gitlab-mcp");
  expect(r.code).toBe(0);
  const cfg = readFileSync(env.MDUCT_CONFIG!, "utf8");
  expect(cfg).toContain("${"); // a reference, not the literal
  expect(cfg).not.toContain("glpat-literal");
  const secrets = readFileSync(env.MDUCT_SECRETS!, "utf8");
  expect(secrets).toContain("glpat-literal"); // stored in the 0600 file instead
});

test("wrapping env like NODE_PATH stays literal — not treated as a secret", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "mduct-"));
  const env2 = { ...env, MDUCT_CONFIG: join(dir2, "c.jsonc"), MDUCT_SECRETS: join(dir2, "s.json") };
  const p = Bun.spawn([process.execPath, "src/main.ts", "add", "pw", "--tool", "--env", "NODE_PATH=/opt/pw", "--", "npx", "playwright"], { env: env2, stdout: "pipe", stderr: "pipe" });
  expect(await p.exited).toBe(0);
  const cfg = readFileSync(env2.MDUCT_CONFIG!, "utf8");
  expect(cfg).toContain("/opt/pw"); // NODE_PATH kept in the config, not moved to the store
  expect(cfg).not.toContain("${"); // no secret ref generated for a non-secret key
});

test("import normalizes a plaintext token from a Claude config into the store (N1)", async () => {
  const home = mkdtempSync(join(tmpdir(), "mduct-home-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    mcpServers: { gh: { command: "npx", args: ["gh-mcp"], env: { GH_TOKEN: "ghp_plaintext" } } },
  }));
  const p = Bun.spawn([process.execPath, "src/main.ts", "import", "gh"], {
    env: { ...env, MDUCT_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  expect(err).toBe("");
  const cfg = readFileSync(env.MDUCT_CONFIG!, "utf8");
  expect(cfg).not.toContain("ghp_plaintext"); // config keeps a ${ref}
  const secrets = readFileSync(env.MDUCT_SECRETS!, "utf8");
  expect(secrets).toContain("ghp_plaintext"); // stored in the 0600 file
});
