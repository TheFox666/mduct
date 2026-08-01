import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/shared/config";
import { addServer, addTool, removeServer, setDisabled } from "../src/shared/configEdit";

beforeEach(() => {
  process.env.MDUCT_CONFIG = join(mkdtempSync(join(tmpdir(), "mduct-")), "servers.jsonc");
});

describe("configEdit", () => {
  test("addServer → loadConfig roundtrip, creates file with header comment", () => {
    addServer("fix", { command: "bun", args: ["x.ts"], note: "n" });
    expect(loadConfig().servers.fix).toMatchObject({ command: "bun", note: "n" });
    expect(readFileSync(process.env.MDUCT_CONFIG!, "utf8")).toContain("// managed by mduct");
  });

  test("addServer refuses existing name without replace", () => {
    addServer("fix", { command: "bun" });
    expect(() => addServer("fix", { command: "other" })).toThrow(/exists.*--replace/);
    addServer("fix", { command: "other" }, { replace: true });
    expect(loadConfig().servers.fix!.command).toBe("other");
  });

  test("removeServer unknown → error names known servers", () => {
    addServer("a", { command: "x" });
    expect(() => removeServer("nope")).toThrow(/unknown server "nope".*a/);
    removeServer("a");
    expect(loadConfig().servers).toEqual({});
  });

  test("setDisabled toggles", () => {
    addServer("a", { command: "x" });
    setDisabled("a", true);
    expect(loadConfig().servers.a!.disabled).toBe(true);
    setDisabled("a", false);
    expect(loadConfig().servers.a!.disabled).toBeUndefined();
  });

  test("config file is written 0600 — it can hold a plaintext credential (H1)", () => {
    addServer("a", { command: "x", env: { WEIRD_CREDS: "sk-live-not-a-wordlist-key" } });
    expect(statSync(process.env.MDUCT_CONFIG!).mode & 0o777).toBe(0o600);
  });

  test("rejects a name with path traversal — the `mduct import` untrusted-repo vector (M2)", () => {
    expect(() => addServer("../../../tmp/evil", { command: "x" })).toThrow(/invalid name/);
    expect(() => addServer("a/b", { command: "x" })).toThrow(/invalid name/);
    expect(() => addTool("..", { run: "x" })).toThrow(/invalid name/);
    addServer("my-server_2", { command: "x" }); // legit names still pass
    expect(loadConfig().servers["my-server_2"]).toBeDefined();
  });

  test("env expansion stays a load-time concern: rewrite never bakes secrets", () => {
    process.env.SOMEVAR = "SECRET-VALUE";
    addServer("a", { command: "x", env: { T: "${SOMEVAR}" } });
    setDisabled("a", true); // read-modify-write MUST use the raw file, not loadConfig()
    const raw = readFileSync(process.env.MDUCT_CONFIG!, "utf8");
    expect(raw).toContain("${SOMEVAR}");
    expect(raw).not.toContain("SECRET-VALUE");
  });
});
