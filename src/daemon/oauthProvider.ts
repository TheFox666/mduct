import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation, OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

function authDir(): string {
  const base = process.env.MCPMUX_CONFIG ? dirname(process.env.MCPMUX_CONFIG) : join(homedir(), ".config", "mcpmux");
  return join(base, "auth");
}

type Persisted = {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationFull;
  codeVerifier?: string;
};

/**
 * File-backed OAuth state per server, mirroring Claude Code's credentials.json approach:
 * one 0600 file per server holding tokens + registered client info. The daemon holds the
 * live provider; the SDK transport auto-refreshes access tokens from the stored refresh token,
 * so headless agents only ever meet valid sessions.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  constructor(private readonly server: string, private readonly redirect: string) {}

  filePath(): string { return join(authDir(), `${this.server}.json`); }

  private read(): Persisted {
    const p = this.filePath();
    if (!existsSync(p)) return {};
    try { return JSON.parse(readFileSync(p, "utf8")) as Persisted; } catch { return {}; }
  }

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
      client_name: "mcpmux",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformation | undefined { return this.read().clientInformation; }
  saveClientInformation(info: OAuthClientInformationFull): void { this.write({ ...this.read(), clientInformation: info }); }

  tokens(): OAuthTokens | undefined { return this.read().tokens; }
  saveTokens(tokens: OAuthTokens): void { this.write({ ...this.read(), tokens }); }

  saveCodeVerifier(v: string): void { this.write({ ...this.read(), codeVerifier: v }); }
  codeVerifier(): string {
    const v = this.read().codeVerifier;
    if (!v) throw new Error(`no PKCE code verifier stored for ${this.server} — restart: mux auth ${this.server}`);
    return v;
  }

  /** The daemon prints this URL; a human opens it. `mux auth` captures the redirect. */
  redirectToAuthorization(url: URL): void { this.pendingAuthUrl = url; }
  pendingAuthUrl: URL | null = null;
}
