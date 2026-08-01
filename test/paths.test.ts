import { afterEach, expect, test } from "bun:test";
import { configDir, configPath, secretsPath, socketPath } from "../src/shared/paths";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["MDUCT_PROFILE", "MDUCT_CONFIG", "MDUCT_SECRETS", "MDUCT_SOCKET", "XDG_RUNTIME_DIR"]) delete process.env[k];
  Object.assign(process.env, saved);
});

test("no profile → default ~/.config/mduct", () => {
  delete process.env.MDUCT_PROFILE;
  delete process.env.MDUCT_CONFIG;
  expect(configDir()).toMatch(/\.config\/mduct$/);
  expect(configPath()).toMatch(/\.config\/mduct\/servers\.jsonc$/);
});

test("MDUCT_PROFILE picks a named sibling dir + socket", () => {
  process.env.MDUCT_PROFILE = "office";
  delete process.env.MDUCT_CONFIG;
  delete process.env.MDUCT_SECRETS;
  delete process.env.MDUCT_SOCKET;
  process.env.XDG_RUNTIME_DIR = "/run/user/1001";
  expect(configDir()).toMatch(/\.config\/mduct-office$/);
  expect(configPath()).toMatch(/\.config\/mduct-office\/servers\.jsonc$/);
  expect(secretsPath()).toMatch(/\.config\/mduct-office\/secrets\.json$/);
  expect(socketPath()).toBe("/run/user/1001/mduct-office.sock");
});

test("explicit MDUCT_CONFIG/SOCKET override the profile", () => {
  process.env.MDUCT_PROFILE = "office";
  process.env.MDUCT_CONFIG = "/tmp/custom/servers.jsonc";
  process.env.MDUCT_SOCKET = "/tmp/custom/d.sock";
  expect(configPath()).toBe("/tmp/custom/servers.jsonc");
  expect(socketPath()).toBe("/tmp/custom/d.sock");
});
