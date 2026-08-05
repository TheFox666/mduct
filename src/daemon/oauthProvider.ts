import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation, OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { authDir } from "../shared/paths";

type Persisted = {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationFull;
  codeVerifier?: string;
  /** When `tokens` was written. OAuth expiry is RELATIVE (expires_in), so without this there is
   *  no way to say whether a stored access token has lapsed. */
  savedAt?: number;
};

function authFilePath(server: string): string { return join(authDir(), `${server}.json`); }

function readPersisted(server: string): Persisted {
  try { return JSON.parse(readFileSync(authFilePath(server), "utf8")) as Persisted; }
  catch { return {}; } // missing or corrupt → no session, same handling
}

/**
 * What a status readout needs to answer "does this server still have a usable session", without a
 * network round trip: are there tokens, when does the access token lapse, can it self-refresh.
 *
 * Honest limits: a refresh token the provider has REVOKED still reads as usable here — revocation
 * is not observable locally, only on the next call. And a server that sends no `expires_in` yields
 * expiresAt null (unknown), not an expiry of now.
 */
export function readAuthState(server: string): { hasTokens: boolean; expiresAt: number | null; canRefresh: boolean } {
  const data = readPersisted(server);
  const t = data.tokens;
  if (!t?.access_token) return { hasTokens: false, expiresAt: null, canRefresh: false };
  // ponytail: tokens written before savedAt existed fall back to the file's mtime — the same
  // instant, minus the precision of whatever wrote the file since.
  const savedAt = data.savedAt ?? ((): number | null => {
    try { return statSync(authFilePath(server)).mtimeMs; } catch { return null; }
  })();
  return {
    hasTokens: true,
    expiresAt: t.expires_in != null && savedAt != null ? savedAt + t.expires_in * 1000 : null,
    canRefresh: !!t.refresh_token,
  };
}

/**
 * File-backed OAuth state per server, mirroring Claude Code's credentials.json approach:
 * one 0600 file per server holding tokens + registered client info. The daemon holds the
 * live provider; the SDK transport auto-refreshes access tokens from the stored refresh token,
 * so headless agents only ever meet valid sessions.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  constructor(private readonly server: string, private readonly redirect: string) {}

  filePath(): string { return authFilePath(this.server); }

  private read(): Persisted { return readPersisted(this.server); }

  private write(next: Persisted): void {
    const p = this.filePath();
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
    try { chmodSync(p, 0o600); } catch { /* best effort */ }
  }

  get redirectUrl(): string { return this.redirect; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "mduct",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformation | undefined { return this.read().clientInformation; }
  saveClientInformation(info: OAuthClientInformationFull): void { this.write({ ...this.read(), clientInformation: info }); }

  tokens(): OAuthTokens | undefined { return this.read().tokens; }
  saveTokens(tokens: OAuthTokens): void { this.write({ ...this.read(), tokens, savedAt: Date.now() }); }

  saveCodeVerifier(v: string): void { this.write({ ...this.read(), codeVerifier: v }); }
  codeVerifier(): string {
    const v = this.read().codeVerifier;
    if (!v) throw new Error(`no PKCE code verifier stored for ${this.server} — restart: mduct auth ${this.server}`);
    return v;
  }

  /** The daemon prints this URL; a human opens it. `mduct auth` captures the redirect. */
  redirectToAuthorization(url: URL): void { this.pendingAuthUrl = url; }
  pendingAuthUrl: URL | null = null;
}
