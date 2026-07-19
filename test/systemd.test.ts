import { expect, test } from "bun:test";
import { systemdUnit, unitPath } from "../src/cli/systemd";

test("unit points ExecStart at an absolute mux binary and restarts on failure", () => {
  const unit = systemdUnit("/home/x/.local/bin/mux");
  expect(unit).toContain("ExecStart=/home/x/.local/bin/mux daemon");
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("[Install]");
});

test("unit path is under the user systemd dir", () => {
  expect(unitPath("/home/x")).toBe("/home/x/.config/systemd/user/mcpmux.service");
});
