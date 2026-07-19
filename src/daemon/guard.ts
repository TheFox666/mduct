/** Glob match: `*` anywhere is a wildcard (leading/mid/trailing), everything else literal. */
function match(pat: string, name: string): boolean {
  if (!pat.includes("*")) return name === pat;
  const re = new RegExp("^" + pat.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(name);
}

/** deny beats allow; empty/missing allow = allow all. */
export function guardAllows(g: { allow?: string[]; deny?: string[] } | undefined, tool: string): boolean {
  if (!g) return true;
  if (g.deny?.some((p) => match(p, tool))) return false;
  if (g.allow && g.allow.length > 0) return g.allow.some((p) => match(p, tool));
  return true;
}
