import { describe, expect, test } from "bun:test";
import { pickerRows } from "../src/cli/picker";
import type { Config } from "../src/shared/config";
import type { RegistryHit } from "../src/shared/registry";

const cfg: Config = {
  servers: { gitlab: { url: "https://x", note: "GL" }, notes: { command: "bun", note: "Notes" } },
  tools: { kubectl: { run: "kubectl", note: "k8s" } },
};
const hits: RegistryHit[] = [
  { ref: "com.gitlab/mcp", description: "GitLab official", entry: { name: "com.gitlab/mcp" } },
  { ref: "io.linear/mcp", description: "Linear", entry: { name: "io.linear/mcp" } },
  { ref: "io.github.someone/slack", description: "community slack", entry: { name: "io.github.someone/slack", repository: { url: "https://github.com/someone/slack" } } as any },
];

describe("pickerRows", () => {
  test("installed servers + tools come first, marked installed", () => {
    const rows = pickerRows(cfg, []);
    expect(rows.map((r) => r.name)).toEqual(["gitlab", "notes", "kubectl"]); // servers in config order, then tools
    expect(rows.every((r) => r.installed)).toBe(true);
    expect(rows.find((r) => r.name === "kubectl")!.kind).toBe("tool");
  });

  test("registry hits appended as available, carrying their ref", () => {
    const rows = pickerRows(cfg, hits);
    const linear = rows.find((r) => r.name === "io.linear/mcp");
    expect(linear).toBeDefined();
    expect(linear!.installed).toBe(false);
    expect(linear!.ref).toBe("io.linear/mcp");
  });

  test("available rows carry the verified publisher and repo url", () => {
    const rows = pickerRows(cfg, hits);
    const gl = rows.find((r) => r.name === "com.gitlab/mcp")!;
    expect(gl.pub).toEqual({ kind: "domain", who: "gitlab.com" });
    const sl = rows.find((r) => r.name === "io.github.someone/slack")!;
    expect(sl.pub).toEqual({ kind: "github", who: "github.com/someone" });
    expect(sl.repo).toBe("https://github.com/someone/slack");
  });

  test("a registry hit whose ref suffix matches an installed server is not duplicated as available", () => {
    // gitlab already installed; com.gitlab/mcp would suggest name 'mcp' — not a dup of 'gitlab',
    // so it still shows. But an exact-name overlap must be hidden.
    const cfg2: Config = { servers: { mcp: { url: "https://x" } }, tools: {} };
    const rows = pickerRows(cfg2, hits);
    // 'com.gitlab/mcp' → default name 'mcp' which IS installed → not listed as available
    expect(rows.filter((r) => !r.installed && r.name === "com.gitlab/mcp").length).toBe(0);
  });
});
