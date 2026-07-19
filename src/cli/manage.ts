import type { ServerCfg } from "../shared/config";
import { addServer, externalizeSecrets, removeServer, setDisabled } from "../shared/configEdit";
import { searchRegistry, toServerCfg } from "../shared/registry";

export async function cmdSearch(query: string | undefined): Promise<number> {
  if (!query) { console.error("usage: mux search <query>"); return 1; }
  const hits = await searchRegistry(query);
  if (!hits.length) { console.log("(no results)"); return 0; }
  for (const h of hits) console.log(`${h.ref}\t${h.description}`);
  return 0;
}

/** Registry install: `mux add <ref-with-slash> [--as name] [--replace]`. */
async function addFromRegistry(ref: string, as: string | undefined, replace: boolean): Promise<number> {
  const hits = await searchRegistry(ref);
  // exact ref only — silently installing "the closest hit" would be a supply-chain foot-gun
  const hit = hits.find((h) => h.ref === ref);
  if (!hit) {
    const near = hits.slice(0, 5).map((h) => h.ref).join(", ");
    console.error(`"${ref}" not found in registry${near ? ` — did you mean: ${near}` : ""} — try: mux search <query>`);
    return 1;
  }
  const { cfg, requiredEnv } = toServerCfg(hit);
  const name = as ?? ref.split("/").pop()!.replace(/[^a-z0-9-]/gi, "-");
  addServer(name, cfg, { replace });
  console.log(`added: ${name} (${hit.ref})`);
  if (requiredEnv.length)
    console.log(`required env vars (referenced as \${VAR} in the config — export before use): ${requiredEnv.join(", ")}`);
  console.log(`try: mux tools ${name}`);
  return 0;
}

/**
 * `mux add <name> [--url u | -- cmd…] [--env K=V…] [--note n] [--replace]` — manual, AX path.
 * `mux add <ref-with-slash> [--as name]` — registry install (refs look like com.gitlab/mcp).
 */
export async function cmdAdd(argv: string[]): Promise<number> {
  if (argv[0]?.includes("/")) {
    const asIdx = argv.indexOf("--as");
    const as = asIdx >= 0 ? argv[asIdx + 1] : undefined;
    return addFromRegistry(argv[0], as, argv.includes("--replace"));
  }
  return cmdAddManual(argv);
}

function cmdAddManual(argv: string[]): number {
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
  // literal --env/--header values go to the secret store; the config keeps ${refs} (#26)
  addServer(name, externalizeSecrets(name, cfg), { replace });
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
