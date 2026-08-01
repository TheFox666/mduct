import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileOAuthProvider } from "../src/daemon/oauthProvider";

beforeEach(() => {
  process.env.MDUCT_CONFIG = join(mkdtempSync(join(tmpdir(), "mduct-")), "servers.jsonc");
});

describe("FileOAuthProvider", () => {
  test("token round-trip persists to a 0600 file scoped by server", async () => {
    const p = new FileOAuthProvider("linear", "http://127.0.0.1:9/cb");
    expect(await p.tokens()).toBeUndefined();
    await p.saveTokens({ access_token: "at", token_type: "bearer", refresh_token: "rt", expires_in: 3600 } as any);
    const back = await p.tokens();
    expect(back!.access_token).toBe("at");
    expect(back!.refresh_token).toBe("rt");
    expect(statSync(p.filePath()).mode & 0o777).toBe(0o600);
  });

  test("client info and code verifier persist and reload", async () => {
    const p = new FileOAuthProvider("linear", "http://127.0.0.1:9/cb");
    await p.saveClientInformation({ client_id: "cid", client_secret: "csec" } as any);
    expect((await p.clientInformation())!.client_id).toBe("cid");
    await p.saveCodeVerifier("verifier-123");
    expect(await p.codeVerifier()).toBe("verifier-123");
  });

  test("two servers keep separate token files", async () => {
    const a = new FileOAuthProvider("a", "http://127.0.0.1:9/cb");
    const b = new FileOAuthProvider("b", "http://127.0.0.1:9/cb");
    await a.saveTokens({ access_token: "AAA", token_type: "bearer" } as any);
    await b.saveTokens({ access_token: "BBB", token_type: "bearer" } as any);
    expect((await a.tokens())!.access_token).toBe("AAA");
    expect((await b.tokens())!.access_token).toBe("BBB");
    expect(a.filePath()).not.toBe(b.filePath());
  });
});
