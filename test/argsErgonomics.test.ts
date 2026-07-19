import { describe, expect, test } from "bun:test";
import { formatResult, parseArgs, toolSignature } from "../src/cli/format";

// formatResult is pure → test its returned {out,err,code} directly (no console capture). Normalise
// the optional out/err to "" so the existing assertions read cleanly.
function fmt(content: unknown[], opts: Parameters<typeof formatResult>[1]) {
  const r = formatResult({ content }, opts);
  return { out: r.out ?? "", err: r.err ?? "", code: r.code };
}

describe("formatResult output compaction", () => {
  test("--compact losslessly minifies JSON-parseable text content", () => {
    expect(fmt([{ type: "text", text: '{\n  "a": 1,\n  "b": [1, 2]\n}' }], { compact: true }).out).toBe('{"a":1,"b":[1,2]}');
  });
  test("--compact leaves prose (non-JSON) untouched", () => {
    expect(fmt([{ type: "text", text: "just some prose" }], { compact: true }).out).toBe("just some prose");
  });
  test("--raw emits a compact envelope (no pretty-print indentation)", () => {
    const s = fmt([{ type: "text", text: "x" }], { raw: true }).out;
    expect(s).not.toMatch(/\n\s+/); // no indented lines
    expect(JSON.parse(s)).toEqual({ content: [{ type: "text", text: "x" }] });
  });
});

describe("formatResult oversized-list guard (warnAbove)", () => {
  const big = JSON.stringify({ issues: Array.from({ length: 40 }, (_, i) => ({ id: `X-${i}`, title: `t${i}`, status: "open", description: "d".repeat(200) })) });
  const call = (opts: Record<string, unknown>) => fmt([{ type: "text", text: big }], { compact: true, warnAbove: 200, server: "lin", tool: "list_issues", ...opts });

  test("over threshold: warns to stderr with a real projection, prints nothing, returns 2", () => {
    const r = call({});
    expect(r.code).toBe(2);
    expect(r.out).toBe(""); // the blob never reaches stdout / context
    expect(r.err).toContain("too big");
    expect(r.err).toContain(".issues|map({"); // dominant array projected
    expect(r.err).toMatch(/id.*title.*status/); // short/id-like fields kept
    expect(r.err).toContain("description"); // long field named as dropped
    expect(r.err).toContain("--json"); // the pipe-clean recipe
    expect(r.err).toContain("--full"); // the dump-it-all escape hatch
  });

  // GitLab returns TWO text blocks: a prose summary + the JSON. The guard must find the JSON among
  // the blocks (not in the joined text) and --json must strip the prose so the pipe stays clean.
  const gitlabBlocks = [
    { type: "text", text: "Found 40 merge requests" },
    { type: "text", text: JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: i, iid: 1000 + i, title: `MR ${i}`, web_url: `https://x/${i}`, state: "opened", description: "d".repeat(200) }))) },
  ];
  test("guard fires on a prose-prefixed two-block result (GitLab-style)", () => {
    const r = fmt(gitlabBlocks, { compact: true, warnAbove: 200, server: "gitlab", tool: "list_merge_requests" });
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("map({"); // top-level array → no ".issues" prefix
    expect(r.err).toMatch(/iid.*title.*web_url/); // id-like incl. the link kept
    expect(r.err).toContain("description"); // dropped
  });
  test("--json emits only the JSON payload, stripping the prose block", () => {
    const r = fmt(gitlabBlocks, { json: true });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).not.toContain("Found 40"); // prose gone
    expect(JSON.parse(r.out)).toHaveLength(40); // clean, parseable payload
  });
  test("--full bypasses the guard: prints the (compact) blob, returns 0", () => {
    const r = call({ full: true });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toBe(big); // already minified (compact); lossless
  });
  test("over threshold but not JSON/projectable → prints normally (never cry wolf)", () => {
    const r = fmt([{ type: "text", text: "x".repeat(500) }], { warnAbove: 200, server: "s", tool: "t" });
    expect(r.code).toBe(0);
    expect(r.out).toBe("x".repeat(500));
    expect(r.err).toBe("");
  });
  test("under threshold → prints normally", () => {
    const r = fmt([{ type: "text", text: '{"a":1}' }], { compact: true, warnAbove: 200 });
    expect(r.code).toBe(0);
    expect(r.out).toBe('{"a":1}');
  });
  test("no warnAbove set → guard is inert", () => {
    const r = call({ warnAbove: undefined });
    expect(r.code).toBe(0);
    expect(r.out).toBe(big);
  });
  test("--json with no JSON payload fails LOUD on stderr, never prints prose to stdout (#4)", () => {
    const r = fmt([{ type: "text", text: "# Markdown\n- not json at all" }], { json: true });
    expect(r.code).toBe(2);
    expect(r.out).toBe(""); // must not silently feed prose into a downstream `| jq`
    expect(r.err).toContain("no JSON payload");
  });
  test("guard quotes non-identifier field names so the pasted jq parses (#7)", () => {
    // no id-like keys → falls back to short scalars incl. hyphen/dot keys, which jq shorthand rejects
    const items = Array.from({ length: 40 }, (_, i) => ({ "web-url": `https://x/${i}`, "a-b": "v", description: "d".repeat(200) }));
    const r = fmt([{ type: "text", text: JSON.stringify(items) }], { warnAbove: 200, server: "s", tool: "t" });
    expect(r.code).toBe(2);
    expect(r.err).toContain('"web-url":.["web-url"]'); // explicit form, not bare `{web-url}`
    expect(r.err).toContain('"a-b":.["a-b"]');
  });
});

describe("toolSignature", () => {
  test("required plain, optional with ?", () => {
    const schema = { type: "object", properties: { name: {}, repo: {} }, required: ["name"] };
    expect(toolSignature(schema)).toBe("(name, repo?)");
  });
  test("no properties → empty", () => {
    expect(toolSignature({ type: "object" })).toBe("");
    expect(toolSignature(undefined)).toBe("");
  });
  test("all optional", () => {
    expect(toolSignature({ properties: { a: {}, b: {} } })).toBe("(a?, b?)");
  });
});

describe("parseArgs :=  (httpie-style JSON values)", () => {
  test("key:=json parses the value as JSON; key=value stays scalar/coerced", () => {
    const out = parseArgs(['state=open', 'labels:=["bug","p1"]', 'limit=5', 'nested:={"a":1}']);
    expect(out).toEqual({ state: "open", labels: ["bug", "p1"], limit: 5, nested: { a: 1 } });
  });
  test("key:= with a bad JSON value throws a helpful error", () => {
    expect(() => parseArgs(['x:=[oops'])).toThrow(/x:=.*JSON/i);
  });
  test("plain scalar coercion unchanged (big ids stay strings)", () => {
    expect(parseArgs(['id=12345678901234567890', 'n=3', 'ok=true'])).toEqual({ id: "12345678901234567890", n: 3, ok: true });
  });
});
