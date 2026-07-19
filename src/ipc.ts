import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function socketPath(): string {
  if (process.env.MCPMUX_SOCKET) return process.env.MCPMUX_SOCKET;
  const run = process.env.XDG_RUNTIME_DIR;
  return run ? join(run, "mcpmux.sock") : join(homedir(), ".cache", "mcpmux", "daemon.sock");
}

export type Handler = (method: string, params: any) => Promise<unknown>;

export function serveIpc(path: string, handler: Handler): { stop(): void } {
  mkdirSync(dirname(path), { recursive: true });
  const server = Bun.listen<{ buf: string }>({
    unix: path,
    socket: {
      open(sock) { sock.data = { buf: "" }; },
      data(sock, chunk) {
        sock.data.buf += chunk.toString();
        let nl: number;
        while ((nl = sock.data.buf.indexOf("\n")) >= 0) {
          const line = sock.data.buf.slice(0, nl);
          sock.data.buf = sock.data.buf.slice(nl + 1);
          if (!line.trim()) continue;
          const { id, method, params } = JSON.parse(line);
          handler(method, params).then(
            (result) => sock.write(JSON.stringify({ id, result }) + "\n"),
            (e) => sock.write(JSON.stringify({ id, error: { message: String((e as Error).message ?? e) } }) + "\n"),
          );
        }
      },
    },
  });
  return { stop: () => server.stop(true) };
}

export async function request(path: string, method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let buf = "";
    let sock: { end(): void } | undefined;
    const timer = setTimeout(() => {
      reject(new Error(`daemon did not answer within ${timeoutMs}ms — check: mux status`));
      sock?.end();
    }, timeoutMs);
    Bun.connect({
      unix: path,
      socket: {
        open(s) { sock = s; s.write(JSON.stringify({ id, method, params }) + "\n"); },
        data(s, chunk) {
          buf += chunk.toString();
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          clearTimeout(timer);
          const msg = JSON.parse(buf.slice(0, nl));
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
          s.end();
        },
        error(_s, e) { clearTimeout(timer); reject(e); },
      },
    }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}
