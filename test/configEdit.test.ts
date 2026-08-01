import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/shared/config";
import { addServer, addTool, externalizeSecrets, removeServer, secretRef, setDisabled } from "../src/shared/configEdit";
import { read as readSecrets, setSecret } from "../src/shared/secrets";

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

describe("secretRef — the name a lifted credential gets", () => {
  beforeEach(() => {
    const d = mkdtempSync(join(tmpdir(), "mduct-sec-"));
    process.env.MDUCT_CONFIG = join(d, "servers.jsonc");
    process.env.MDUCT_SECRETS = join(d, "secrets.json");
  });

  test("drops the stutter when the key already names the owner", () => {
    // weather + WEATHER_KEY was WEATHER_WEATHER_KEY
    expect(secretRef("weather", "WEATHER_KEY")).toBe("WEATHER_KEY");
    expect(secretRef("gitlab", "GITLAB_PERSONAL_ACCESS_TOKEN")).toBe("GITLAB_PERSONAL_ACCESS_TOKEN");
  });

  test("keeps the prefix when the key says nothing about the owner", () => {
    expect(secretRef("notes", "API_KEY")).toBe("NOTES_API_KEY");
    expect(secretRef("my-server", "TOKEN")).toBe("MY_SERVER_TOKEN");
  });

  test("a one-letter owner never eats the prefix", () => {
    expect(secretRef("x", "XYZ_TOKEN")).toBe("X_XYZ_TOKEN");
  });

  test("falls back to the prefixed name when the short one is taken by another value", () => {
    setSecret("WEATHER_KEY", "first-server-value");
    expect(secretRef("weather", "WEATHER_KEY", "a-different-value")).toBe("WEATHER_WEATHER_KEY");
    // same value = the same import running again, not a clash
    expect(secretRef("weather", "WEATHER_KEY", "first-server-value")).toBe("WEATHER_KEY");
  });

  test("end to end: importing a server leaves a readable ref and no plaintext", () => {
    const s = externalizeSecrets("weather", { command: "npx", env: { WEATHER_KEY: "sk-123", HOST: "example.com" } });
    expect(s.env!.WEATHER_KEY).toBe("${WEATHER_KEY}");
    expect(s.env!.HOST).toBe("example.com");        // not credential-looking, left alone
    expect(readSecrets().WEATHER_KEY).toBe("sk-123");
  });
});
