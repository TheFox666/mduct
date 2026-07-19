import { discoverClaudeSources } from "../shared/claudeConfigs";
import { addServer } from "../shared/configEdit";

/**
 * `mux import` — list candidates from all Claude configs (source\tname\tkind).
 * `mux import <name…> [--as <newname>] [--replace] [--source <path>]` — copy into mux config.
 */
export function cmdImport(argv: string[]): number {
  const take = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const replace = argv.includes("--replace");
  if (replace) argv.splice(argv.indexOf("--replace"), 1);
  const as = take("--as");
  const sourceFilter = take("--source");

  const home = process.env.MCPMUX_HOME; // test seam; defaults to real home
  let sources = discoverClaudeSources(home ? { home } : {});
  if (sourceFilter) sources = sources.filter((s) => s.source.includes(sourceFilter));

  if (argv.length === 0) {
    for (const s of sources)
      for (const [name, cfg] of Object.entries(s.servers))
        console.log(`${s.source}\t${name}\t${cfg.url ? "http" : "stdio"}`);
    return 0;
  }
  if (as && argv.length > 1) {
    console.error("--as works with exactly one name");
    return 1;
  }
  for (const name of argv) {
    const hit = sources.flatMap((s) => (s.servers[name] ? [{ source: s.source, cfg: s.servers[name]! }] : []))[0];
    if (!hit) {
      const known = [...new Set(sources.flatMap((s) => Object.keys(s.servers)))].join(", ") || "(none)";
      console.error(`"${name}" not found in any Claude config — candidates: ${known}`);
      return 1;
    }
    addServer(as ?? name, hit.cfg, { replace });
    console.log(`imported: ${as ?? name} (from ${hit.source})`);
  }
  return 0;
}
