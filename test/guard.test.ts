import { describe, expect, test } from "bun:test";
import { guardAllows } from "../src/daemon/guard";

describe("guardAllows", () => {
  test("no guard → allow", () => expect(guardAllows(undefined, "x")).toBe(true));
  test("deny wins over allow", () =>
    expect(guardAllows({ allow: ["*"], deny: ["admin_*"] }, "admin_delete")).toBe(false));
  test("allow list restricts", () => {
    const g = { allow: ["list_*", "get_*"] };
    expect(guardAllows(g, "list_issues")).toBe(true);
    expect(guardAllows(g, "create_issue")).toBe(false);
  });
  test("a present-but-empty allow denies all — fails CLOSED, not open (#3)", () => {
    expect(guardAllows({ allow: [] }, "anything")).toBe(false);
    expect(guardAllows({}, "anything")).toBe(true); // missing allow = allow all
    expect(guardAllows({ deny: ["x"] }, "anything")).toBe(true); // deny-only still allows the rest
  });
});
