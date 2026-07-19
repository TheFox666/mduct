import type { ServerCfg } from "../shared/config";
import { addServer, removeServer, setDisabled } from "../shared/configEdit";

/** `mux add <name> [--url u | -- cmd…] [--env K=V…] [--note n] [--replace]` — AX path, no TTY. */
export function cmdAdd(argv: string[]): number {
  const dashdash = argv.indexOf("--");
  const command = dashdash >= 0 ? argv.slice(dashdash + 1) : [];
  const head = dashdash >= 0 ? argv.slice(0, dashdash) : [...argv];

  const take = (flag: string): string | undefined => {
    const i = head.indexOf(flag);
    if (i < 0) return undefined;
    const v = head[i + 1];
    head.splice(i, 2);
    return v;
  };
  const takeBool = (flag: string): boolean => {
    const i = head.indexOf(flag);
    if (i < 0) return false;
    head.splice(i, 1);
    return true;
  };

  const url = take("--url");
  const note = take("--note");
  const replace = takeBool("--replace");
  const env: Record<string, string> = {};
  let e: string | undefined;
  while ((e = take("--env"))) {
    const eq = e.indexOf("=");
    if (eq < 1) { console.error(`bad --env "${e}" — use --env KEY=VALUE`); return 1; }
    env[e.slice(0, eq)] = e.slice(eq + 1);
  }
  const name = head[0];
  if (!name || (!url && command.length === 0)) {
    console.error("usage: mux add <name> --url <url> | mux add <name> -- <command…>  [--env K=V] [--note text] [--replace]");
    return 1;
  }
  const cfg: ServerCfg = url
    ? { url, ...(Object.keys(env).length ? { headers: env } : {}), ...(note ? { note } : {}) }
    : { command: command[0]!, args: command.slice(1), ...(Object.keys(env).length ? { env } : {}), ...(note ? { note } : {}) };
  addServer(name, cfg, { replace });
  console.log(`added: ${name} — try: mux tools ${name}`);
  return 0;
}

export function cmdRemove(name: string | undefined): number {
  if (!name) { console.error("usage: mux remove <server>"); return 1; }
  removeServer(name);
  console.log(`removed: ${name}`);
  return 0;
}

export function cmdSetDisabled(name: string | undefined, disabled: boolean): number {
  if (!name) { console.error(`usage: mux ${disabled ? "disable" : "enable"} <server>`); return 1; }
  setDisabled(name, disabled);
  console.log(`${disabled ? "disabled" : "enabled"}: ${name}`);
  return 0;
}
