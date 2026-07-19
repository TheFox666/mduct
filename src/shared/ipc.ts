import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { socketPath } from "./paths";

export { socketPath } from "./paths"; // re-export so existing `from "./ipc"` imports keep working

export type Handler = (method: string, params: any) => Promise<unknown>;

/** Tag connect-level failures so callers tell "daemon down" (respawn) from an application error. */
function markTransport(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  (err as Error & { transport?: boolean }).transport = true;
  return err;
}

export function isTransportError(e: unknown): boolean {
  return !!(e as { transport?: boolean } | null)?.transport;
}

/** Backpressure-safe write: keep writing until every byte is flushed, resuming on `drain`. */
function makeWriter(sock: { write(data: Uint8Array): number }, queueDrain: (fn: () => void) => void) {
  return (text: string): void => {
    const bytes = new TextEncoder().encode(text);
    let off = 0;
    const pump = () => {
      while (off < bytes.length) {
        const n = sock.write(bytes.subarray(off));
        if (n <= 0) { queueDrain(pump); return; } // buffer full — Bun calls drain later (#10)
        off += n;
      }
    };
    pump();
  };
}

/** Is a live daemon already answering on this socket? (probe before we consider it stale) */
export async function socketAlive(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try { return (await request(path, "ping", {}, 1500)) === "pong"; }
  catch { return false; }
}

export async function serveIpc(path: string, handler: Handler): Promise<{ stop(): void }> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Only remove a DEAD socket. A crashed daemon leaves a stale file (safe to clear), but under a
  // cold-start RACE two daemons both pass startDaemon's socketAlive guard; if the loser then
  // unconditionally rmSync'd the winner's LIVE socket and rebound, the winner would be orphaned
  // (listening on an unlinked path, holding its MCP children forever). So probe again here: if a
  // live socket remains, leave it — Bun.listen then throws EADDRINUSE and this daemon exits clean.
  if (existsSync(path) && !(await socketAlive(path))) rmSync(path, { force: true });
  const server = Bun.listen<{ buf: string; dec: TextDecoder; drains: (() => void)[] }>({
    unix: path,
    socket: {
      open(sock) { sock.data = { buf: "", dec: new TextDecoder(), drains: [] }; },
      drain(sock) { const d = sock.data.drains; sock.data.drains = []; for (const fn of d) fn(); },
      data(sock, chunk) {
        const write = makeWriter(sock, (fn) => sock.data.drains.push(fn));
        sock.data.buf += sock.data.dec.decode(chunk, { stream: true }); // stream: no mid-codepoint split (#8)
        let nl: number;
        while ((nl = sock.data.buf.indexOf("\n")) >= 0) {
          const line = sock.data.buf.slice(0, nl);
          sock.data.buf = sock.data.buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: { id: unknown; method: string; params: unknown };
          try { msg = JSON.parse(line); } catch {
            write(JSON.stringify({ id: null, error: { message: "malformed request (not JSON)" } }) + "\n");
            continue; // one bad line never crashes the daemon (#9)
          }
          handler(msg.method, msg.params).then(
            (result) => {
              // JSON.stringify can THROW (a pathologically deep/circular result from a hostile or
              // buggy MCP server) — if it did here the response frame would never be written and the
              // caller would hang the full timeout. Serialize inside the try, fall back to an error.
              let frame: string;
              try { frame = JSON.stringify({ id: msg.id, result }) + "\n"; }
              catch (e) { frame = JSON.stringify({ id: msg.id, error: { message: `result not serializable: ${String((e as Error).message ?? e)}` } }) + "\n"; }
              write(frame);
            },
            (e) => write(JSON.stringify({ id: msg.id, error: { message: String((e as Error).message ?? e) } }) + "\n"),
          );
        }
      },
    },
  });
  try { chmodSync(path, 0o600); } catch { /* best effort; dir is already 0700 */ }
  return { stop: () => server.stop(true) };
}

export async function request(path: string, method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let buf = "";
    const dec = new TextDecoder();
    let opened = false; // after open, a socket error is NOT a connect failure — never respawn/retry (#1)
    let drains: (() => void)[] = [];
    let sock: { end(): void; write(d: Uint8Array): number } | undefined;
    const timer = setTimeout(() => {
      reject(markTransport(new Error(`daemon did not answer within ${timeoutMs}ms — check: mux status`)));
      sock?.end();
    }, timeoutMs);
    Bun.connect({
      unix: path,
      socket: {
        open(s) {
          opened = true; sock = s;
          makeWriter(s, (fn) => drains.push(fn))(JSON.stringify({ id, method, params }) + "\n");
        },
        drain() { const d = drains; drains = []; for (const fn of d) fn(); },
        data(s, chunk) {
          buf += dec.decode(chunk, { stream: true });
          const nl = buf.indexOf("\n");
          if (nl < 0) return; // response line incomplete — keep buffering (#10)
          clearTimeout(timer);
          let msg: { error?: { message: string }; result?: unknown };
          try { msg = JSON.parse(buf.slice(0, nl)); } catch (e) { reject(e); s.end(); return; }
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
          s.end();
        },
        error(_s, e) { clearTimeout(timer); reject(opened ? (e instanceof Error ? e : new Error(String(e))) : markTransport(e)); },
      },
    }).catch((e) => { clearTimeout(timer); reject(markTransport(e)); });
  });
}
