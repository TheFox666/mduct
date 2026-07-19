import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/shared/config";

let cfgPath: string;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "mux-"));
  cfgPath = join(dir, "servers.jsonc");
  process.env.MCPMUX_CONFIG = cfgPath;
  process.env.MCPMUX_SECRETS = join(dir, "secrets.json");
});

describe("loadConfig tools section", () => {
  test("parses tools with env expansion; no tools → empty", () => {
    process.env.PW_PATH = "/opt/pw";
    writeFileSync(cfgPath, `{
      "servers": {},
      "tools": {
        "playwright": { "run": "npx", "args": ["playwright"], "env": { "NODE_PATH": "\${PW_PATH}" }, "note": "browser", "check": "node -v" }
      }
    }`);
    const cfg = loadConfig();
    expect(cfg.tools.playwright!.run).toBe("npx");
    expect(cfg.tools.playwright!.env!.NODE_PATH).toBe("/opt/pw");
    expect(cfg.tools.playwright!.note).toBe("browser");
  });

  test("a tool needs a run command", () => {
    writeFileSync(cfgPath, `{"tools":{"bad":{"note":"x"}}}`);
    expect(() => loadConfig()).toThrow(/bad.*run/);
  });
});
