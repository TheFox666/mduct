const match = (pat: string, name: string): boolean =>
  pat === "*" ? true : pat.endsWith("*") ? name.startsWith(pat.slice(0, -1)) : name === pat;

/** deny beats allow; empty/missing allow = allow all. */
export function guardAllows(g: { allow?: string[]; deny?: string[] } | undefined, tool: string): boolean {
  if (!g) return true;
  if (g.deny?.some((p) => match(p, tool))) return false;
  if (g.allow && g.allow.length > 0) return g.allow.some((p) => match(p, tool));
  return true;
}
