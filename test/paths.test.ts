import { afterEach, expect, test } from "bun:test";
import { configDir, configPath, secretsPath, socketPath } from "../src/shared/paths";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["MCPMUX_PROFILE", "MCPMUX_CONFIG", "MCPMUX_SECRETS", "MCPMUX_SOCKET", "XDG_RUNTIME_DIR"]) delete process.env[k];
  Object.assign(process.env, saved);
});

test("no profile → default ~/.config/mcpmux", () => {
  delete process.env.MCPMUX_PROFILE;
  delete process.env.MCPMUX_CONFIG;
  expect(configDir()).toMatch(/\.config\/mcpmux$/);
  expect(configPath()).toMatch(/\.config\/mcpmux\/servers\.jsonc$/);
});

test("MCPMUX_PROFILE picks a named sibling dir + socket", () => {
  process.env.MCPMUX_PROFILE = "office";
  delete process.env.MCPMUX_CONFIG;
  delete process.env.MCPMUX_SECRETS;
  delete process.env.MCPMUX_SOCKET;
  process.env.XDG_RUNTIME_DIR = "/run/user/1001";
  expect(configDir()).toMatch(/\.config\/mcpmux-office$/);
  expect(configPath()).toMatch(/\.config\/mcpmux-office\/servers\.jsonc$/);
  expect(secretsPath()).toMatch(/\.config\/mcpmux-office\/secrets\.json$/);
  expect(socketPath()).toBe("/run/user/1001/mcpmux-office.sock");
});

test("explicit MCPMUX_CONFIG/SOCKET override the profile", () => {
  process.env.MCPMUX_PROFILE = "office";
  process.env.MCPMUX_CONFIG = "/tmp/custom/servers.jsonc";
  process.env.MCPMUX_SOCKET = "/tmp/custom/d.sock";
  expect(configPath()).toBe("/tmp/custom/servers.jsonc");
  expect(socketPath()).toBe("/tmp/custom/d.sock");
});
