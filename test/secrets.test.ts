import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSecret, listSecretNames, rmSecret, setSecret, secretsPath } from "../src/shared/secrets";
import { loadConfig } from "../src/shared/config";

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "mux-"));
  process.env.MCPMUX_SECRETS = join(dir, "secrets.json");
  process.env.MCPMUX_CONFIG = join(dir, "servers.jsonc");
});

describe("secret store", () => {
  test("set/get/list/rm roundtrip, file is 0600", () => {
    setSecret("GITLAB_PAT", "glpat-xxx");
    expect(getSecret("GITLAB_PAT")).toBe("glpat-xxx");
    expect(listSecretNames()).toContain("GITLAB_PAT");
    expect(statSync(secretsPath()).mode & 0o777).toBe(0o600);
    rmSecret("GITLAB_PAT");
    expect(getSecret("GITLAB_PAT")).toBeUndefined();
  });

  test("list returns only names, never values", () => {
    setSecret("A", "secret-a");
    expect(JSON.stringify(listSecretNames())).not.toContain("secret-a");
  });
});

describe("loadConfig resolves ${VAR} against the secret store", () => {
  test("secret fills a ${VAR} that is not in the environment", () => {
    delete process.env.MY_TOKEN;
    setSecret("MY_TOKEN", "from-store");
    writeFileSync(process.env.MCPMUX_CONFIG!, `{"servers":{"g":{"url":"https://x","headers":{"Authorization":"Bearer \${MY_TOKEN}"}}}}`);
    expect(loadConfig().servers.g!.headers!.Authorization).toBe("Bearer from-store");
  });

  test("process.env wins over the store", () => {
    process.env.MY_TOKEN = "from-env";
    setSecret("MY_TOKEN", "from-store");
    writeFileSync(process.env.MCPMUX_CONFIG!, `{"servers":{"g":{"command":"x","env":{"T":"\${MY_TOKEN}"}}}}`);
    expect(loadConfig().servers.g!.env!.T).toBe("from-env");
    delete process.env.MY_TOKEN;
  });
});
