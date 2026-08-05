import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileOAuthProvider, readAuthState } from "../src/daemon/oauthProvider";

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

/**
 * `readAuthState` answers "does this server still have a usable session" from disk alone, and it is
 * read by a status command an app polls. Every one of these cases came from a review of that
 * command: the input is provider-supplied JSON, and the file is also written for reasons that have
 * nothing to do with tokens.
 */
describe("readAuthState", () => {
  const HOUR = 3_600_000;
  /** Write an auth file by hand — the shape a previous version, or a provider, left behind. */
  const writeAuth = (server: string, data: unknown): string => {
    const p = join(dirname(process.env.MDUCT_CONFIG!), "auth", `${server}.json`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(data));
    return p;
  };

  test("a non-numeric expires_in yields no expiry instead of an Invalid Date", () => {
    // provider-supplied JSON, cast not validated: "soon" used to reach new Date(NaN) and throw
    writeAuth("junk", { savedAt: Date.now(), tokens: { access_token: "a", token_type: "Bearer", expires_in: "soon" } });
    expect(readAuthState("junk")).toEqual({ hasTokens: true, expiresAt: null, canRefresh: false });
  });

  test("a non-numeric savedAt yields no expiry", () => {
    writeAuth("junk2", { savedAt: "yesterday", tokens: { access_token: "a", token_type: "Bearer", expires_in: 3600 } });
    expect(readAuthState("junk2").expiresAt).toBeNull();
  });

  test("no expires_in at all means unknown, not expired-now", () => {
    writeAuth("noexp", { savedAt: Date.now() - 10 * HOUR, tokens: { access_token: "a", token_type: "Bearer", refresh_token: "r" } });
    expect(readAuthState("noexp")).toEqual({ hasTokens: true, expiresAt: null, canRefresh: true });
  });

  test("a file with no savedAt dates its tokens by the file's mtime", () => {
    const p = writeAuth("legacy", { tokens: { access_token: "a", token_type: "Bearer", expires_in: 3600 } });
    const threeHoursAgo = (Date.now() - 3 * HOUR) / 1000;
    utimesSync(p, threeHoursAgo, threeHoursAgo);
    const st = readAuthState("legacy");
    expect(st.expiresAt).toBeLessThan(Date.now()); // lapsed two hours ago, and readable as such
  });

  test("a write that leaves the tokens alone must not move their expiry", async () => {
    // The mtime fallback is only evidence until something else writes the file. `mduct auth` stores
    // a PKCE verifier before the browser step, which rewrites it with the old tokens intact — and
    // that used to reset the derived expiry to now, so a dead session read as valid.
    const p = writeAuth("legacy2", { tokens: { access_token: "a", token_type: "Bearer", expires_in: 3600 } });
    const threeHoursAgo = (Date.now() - 3 * HOUR) / 1000;
    utimesSync(p, threeHoursAgo, threeHoursAgo);
    const before = readAuthState("legacy2").expiresAt!;

    await new FileOAuthProvider("legacy2", "http://127.0.0.1:9/cb").saveCodeVerifier("v");

    const after = readAuthState("legacy2").expiresAt!;
    expect(after).toBe(before);
    expect(after).toBeLessThan(Date.now()); // still lapsed, still honest about it
  });
});
