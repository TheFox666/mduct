import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverClaudeSources } from "../src/shared/claudeConfigs";

function fixtureHome(): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "mux-home-"));
  // user-level ~/.claude.json
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    mcpServers: { gitlab: { command: "npx", args: ["-y", "gitlab-mcp"], env: { TOKEN: "x" } } },
  }));
  // a second config dir (the office pattern): ~/.claude-office/.claude.json
  mkdirSync(join(home, ".claude-office"));
  writeFileSync(join(home, ".claude-office", ".claude.json"), JSON.stringify({
    mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
  }));
  // project-level .mcp.json
  const cwd = mkdtempSync(join(tmpdir(), "mux-proj-"));
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({
    mcpServers: { hive: { command: "bun", args: ["hive.ts"] } },
  }));
  return { home, cwd };
}

describe("discoverClaudeSources", () => {
  test("finds user config, extra .claude-* dirs, and project .mcp.json", () => {
    const { home, cwd } = fixtureHome();
    const sources = discoverClaudeSources({ home, cwd });
    const byName = Object.fromEntries(sources.map((s) => [s.source, s.servers]));
    const paths = Object.keys(byName);
    expect(paths.some((p) => p.endsWith("/.claude.json") && !p.includes(".claude-office"))).toBe(true);
    expect(paths.some((p) => p.includes(".claude-office"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/.mcp.json"))).toBe(true);
  });

  test("maps stdio and http entries to ServerCfg shape", () => {
    const { home, cwd } = fixtureHome();
    const sources = discoverClaudeSources({ home, cwd });
    const all = Object.assign({}, ...sources.map((s) => s.servers));
    expect(all.gitlab).toMatchObject({ command: "npx", args: ["-y", "gitlab-mcp"], env: { TOKEN: "x" } });
    expect(all.linear).toMatchObject({ url: "https://mcp.linear.app/mcp" });
    expect(all.hive).toMatchObject({ command: "bun" });
  });

  test("missing/broken files are skipped silently", () => {
    const home = mkdtempSync(join(tmpdir(), "mux-empty-"));
    writeFileSync(join(home, ".claude.json"), "NOT JSON");
    expect(discoverClaudeSources({ home, cwd: home })).toEqual([]);
  });
});
