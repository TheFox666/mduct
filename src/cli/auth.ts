import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadConfig } from "../shared/config";
import { FileOAuthProvider } from "../daemon/oauthProvider";

/**
 * `mux auth <server>` — interactive OAuth for an http server. Runs the flow once: prints the
 * authorization URL, captures the redirect on a local callback port, exchanges the code, and
 * persists tokens. The daemon refreshes them automatically thereafter.
 */
export async function cmdAuth(argv: string[]): Promise<number> {
  const name = argv[0];
  const cfg = loadConfig();
  const server = name ? cfg.servers[name] : undefined;
  if (!name || !server) {
    const http = Object.entries(cfg.servers).filter(([, s]) => s.url).map(([n]) => n).join(", ") || "(none)";
    console.error(`usage: mux auth <server> — http servers: ${http}`);
    return 1;
  }
  if (!server.url) { console.error(`"${name}" is a stdio server — OAuth applies to http servers only`); return 1; }

  // one-shot local callback server on an ephemeral port
  let resolveCode: (code: string) => void;
  const codePromise = new Promise<string>((r) => { resolveCode = r; });
  const cbServer = Bun.serve({
    port: 0,
    fetch(req) {
      const code = new URL(req.url).searchParams.get("code");
      if (!code) return new Response("missing ?code", { status: 400 });
      resolveCode(code);
      return new Response("mcpmux: authorized — you can close this tab.", { headers: { "content-type": "text/plain" } });
    },
  });
  const redirect = `http://127.0.0.1:${cbServer.port}/cb`;
  const provider = new FileOAuthProvider(name, redirect);

  try {
    // first auth() call discovers metadata, registers the client, and yields the auth URL
    const result = await auth(provider, { serverUrl: server.url });
    if (result === "AUTHORIZED") { console.log(`${name}: already authorized`); return 0; }
    if (!provider.pendingAuthUrl) { console.error("OAuth server did not provide an authorization URL"); return 1; }
    console.log(`\nOpen this URL to authorize mcpmux for "${name}":\n\n  ${provider.pendingAuthUrl.toString()}\n\nWaiting for the redirect…`);

    const code = await Promise.race([
      codePromise,
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timed out after 5min waiting for authorization")), 300_000)),
    ]);
    // second auth() call exchanges the code for tokens (saved via the provider)
    const done = await auth(provider, { serverUrl: server.url, authorizationCode: code });
    if (done !== "AUTHORIZED") { console.error(`authorization did not complete (${done})`); return 1; }
    console.log(`✓ ${name}: authorized — tokens stored, the daemon will refresh them automatically`);
    return 0;
  } catch (e) {
    console.error(`auth failed for ${name}: ${(e as Error).message}`);
    return 1;
  } finally {
    cbServer.stop(true);
  }
}
