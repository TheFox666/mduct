/** Strip // and block comments AND trailing commas from JSONC — string-aware, no dep. */
export function stripJsonc(s: string): string {
  let out = "", inStr = false, inLine = false, inBlock = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!, n = s[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) { out += c; if (c === "\\") { out += n ?? ""; i++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    // trailing comma: a comma followed only by whitespace before } or ] — drop it
    if (c === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (s[j] === "}" || s[j] === "]") continue; // skip the comma, keep the whitespace
    }
    out += c;
  }
  return out;
}

/** Expand ${VAR} references; unknown vars stay literal so errors are visible downstream. */
export function expandEnv(s: string, env: Record<string, string | undefined> = process.env): string {
  return s.replace(/\$\{(\w+)\}/g, (m, name: string) => env[name] ?? m);
}
