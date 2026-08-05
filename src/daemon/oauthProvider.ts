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
  // ponytail: tokens written before savedAt existed fall back to the file's mtime. write() stamps
  // that mtime into the file before it can be lost, so this only runs for a file nothing has
  // touched since the upgrade.
  const savedAt = data.savedAt ?? mtimeOf(authFilePath(server));
  // The file is provider-supplied JSON read through a cast, so neither field is guaranteed to be a
  // number. Arithmetic on a string is not an error in JS: "yesterday" + 3600000 produced the
  // timestamp "yesterday3600000", and new Date(NaN).toISOString() THREW, taking the whole readout
  // down over one bad file. An unusable stamp means the expiry is unknown, which is what null says.
  const lifetime = Number(t.expires_in);
  const stamp = savedAt == null ? NaN : Number(savedAt); // Number(null) is 0 — do not let it pass as a date
  return {
    hasTokens: true,
    expiresAt: Number.isFinite(lifetime) && Number.isFinite(stamp) ? stamp + lifetime * 1000 : null,
    canRefresh: !!t.refresh_token,
  };
}

function mtimeOf(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
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
    // A pre-savedAt file dates its tokens by its own mtime, and this write is about to move it.
    // `mduct auth` stores a PKCE verifier BEFORE the browser step, so an abandoned re-auth used to
    // reset the derived expiry to now — a dead session then read as `valid`, which is exactly the
    // lie the status output exists to prevent. Carry the old instant over first.
    if (next.tokens && next.savedAt == null) {
      const was = mtimeOf(p);
      if (was != null) next = { ...next, savedAt: was };
    }
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
