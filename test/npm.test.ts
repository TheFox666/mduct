import { afterAll, describe, expect, test } from "bun:test";
import { isNewer, npmLatest, parseNpmSpec } from "../src/shared/npm";
import type { ToolCfg } from "../src/shared/config";

describe("parseNpmSpec", () => {
  const t = (run: string, args?: string[]): ToolCfg => ({ run, args });
  test("bunx pkg@version → pinned", () => {
    expect(parseNpmSpec(t("bunx", ["playwright@1.61.1"]))).toEqual({ pkg: "playwright", version: "1.61.1" });
  });
  test("npx -y scoped pkg without version → unpinned", () => {
    expect(parseNpmSpec(t("npx", ["-y", "@yoda.digital/gitlab-mcp-server"]))).toEqual({ pkg: "@yoda.digital/gitlab-mcp-server", version: undefined });
  });
  test("bunx scoped pkg@version", () => {
    expect(parseNpmSpec(t("bunx", ["@scope/pkg@2.3.4"]))).toEqual({ pkg: "@scope/pkg", version: "2.3.4" });
  });
  test("direct binary (kubectl) → null", () => {
    expect(parseNpmSpec(t("kubectl"))).toBeNull();
  });
  test("@latest counts as unpinned", () => {
    expect(parseNpmSpec(t("bunx", ["playwright@latest"]))).toEqual({ pkg: "playwright", version: undefined });
  });
});

describe("isNewer", () => {
  test("compares semver numerically", () => {
    expect(isNewer("1.62.0", "1.61.1")).toBe(true);
    expect(isNewer("1.61.1", "1.61.1")).toBe(false);
    expect(isNewer("1.9.0", "1.10.0")).toBe(false); // 10 > 9
    expect(isNewer("2.0.0", "1.99.99")).toBe(true);
  });
});

describe("npmLatest", () => {
  const fixture = Bun.serve({
    port: 0,
    fetch(req) {
      const m = new URL(req.url).pathname.match(/^\/(.+)\/latest$/);
      const pkg = m ? decodeURIComponent(m[1]!) : "";
      if (pkg === "playwright") return Response.json({ version: "1.62.0" });
      return new Response("not found", { status: 404 });
    },
  });
  process.env.MCPMUX_NPM_REGISTRY = `http://localhost:${fixture.port}`;
  afterAll(() => fixture.stop(true));

  test("returns the latest version", async () => {
    expect(await npmLatest("playwright")).toBe("1.62.0");
  });
  test("unknown package → null", async () => {
    expect(await npmLatest("nonexistent-xyz")).toBeNull();
  });
});
