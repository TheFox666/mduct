/** Glob match: `*` anywhere is a wildcard (leading/mid/trailing), everything else literal. */
function match(pat: string, name: string): boolean {
  if (!pat.includes("*")) return name === pat;
  const re = new RegExp("^" + pat.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(name);
}

/** deny beats allow; a PRESENT allow-list is authoritative (empty = deny all); a MISSING allow = allow all.
 *  A guard must fail CLOSED: `allow: []` means "nothing", not "everything" (the old `.length > 0` fell open). */
export function guardAllows(g: { allow?: string[]; deny?: string[] } | undefined, tool: string): boolean {
  if (!g) return true;
  if (g.deny?.some((p) => match(p, tool))) return false;
  if (g.allow) return g.allow.some((p) => match(p, tool)); // [] ⇒ no match ⇒ deny all (fail closed)
  return true;
}
