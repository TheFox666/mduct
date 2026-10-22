import { describe, expect, test } from "bun:test";
import { reportsExpiredToken } from "../src/daemon/connection";

// LaunchDarkly's remote MCP server answers an expired access token with a normal tool result
// (isError + {"code":"token_expired"}), not an HTTP 401, so the SDK's refresh never ran (2026-10-22).
describe("reportsExpiredToken", () => {
  const result = (text: string, isError = true) => ({ isError, content: [{ type: "text", text }] });
  test("an error result naming an expired token", () => {
    expect(reportsExpiredToken(result('{"error":"LaunchDarkly access token has expired.","code":"token_expired","status":401}'))).toBe(true);
  });
  test("an ordinary tool error is not an auth problem", () => {
    expect(reportsExpiredToken(result('{"error":"flag not found","status":404}'))).toBe(false);
  });
  test("a successful result that mentions the words is not one either", () => {
    expect(reportsExpiredToken(result("docs: token_expired means re-authenticate", false))).toBe(false);
  });
});
