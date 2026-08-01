import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/shared/config";

type Config0 = ReturnType<typeof loadConfig>;

function withCfg(content: string): Config0 {
  const dir = mkdtempSync(join(tmpdir(), "mduct-"));
  const p = join(dir, "servers.jsonc");
  writeFileSync(p, content);
  process.env.MDUCT_CONFIG = p;
  return loadConfig();
}

describe("loadConfig", () => {
  test("missing file yields empty servers", () => {
    process.env.MDUCT_CONFIG = "/nonexistent/servers.jsonc";
    expect(loadConfig()).toEqual({ servers: {}, tools: {} });
  });

  test("parses jsonc, expands env in env/headers/args/url", () => {
    process.env.TESTTOKEN = "s3cret";
    const cfg = withCfg(`{
      // demo
      "servers": {
        "fix": { "command": "bun", "args": ["run", "\${TESTTOKEN}"], "env": { "T": "\${TESTTOKEN}" } },
        "web": { "url": "https://x/\${TESTTOKEN}", "headers": { "Authorization": "Bearer \${TESTTOKEN}" } }
      }
    }`);
    expect(cfg.servers.fix!.env!.T).toBe("s3cret");
    expect(cfg.servers.fix!.args).toEqual(["run", "s3cret"]);
    expect(cfg.servers.web!.url).toBe("https://x/s3cret");
    expect(cfg.servers.web!.headers!.Authorization).toBe("Bearer s3cret");
  });

  test("rejects server with neither command nor url, naming the server", () => {
    expect(() => withCfg(`{"servers":{"bad":{}}}`)).toThrow(/bad.*command.*url/);
  });

  test("a null / non-object server entry gives a clear error, not a TypeError (L4)", () => {
    expect(() => withCfg(`{"servers":{"foo":null}}`)).toThrow(/foo.*must be an object/);
    expect(() => withCfg(`{"servers":{"foo":"just a string"}}`)).toThrow(/foo.*must be an object/);
  });
});
