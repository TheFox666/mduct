import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function unitPath(home = homedir()): string {
  return join(home, ".config", "systemd", "user", "mcpmux.service");
}

export function systemdUnit(muxBin: string): string {
  return `[Unit]
Description=mcpmux daemon (MCP multiplexer)
After=default.target

[Service]
Type=simple
ExecStart=${muxBin} daemon
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/** Resolve the absolute mux binary path (compiled binary → itself; dev → "bun /abs/main.ts"). */
function muxBin(): string {
  const entry = process.argv[1] ?? "";
  return entry.startsWith("/$bunfs") || entry === "" ? process.execPath : `${process.execPath} ${entry}`;
}

/** `mux daemon --install`: write the user unit and enable+start it (best effort on systemctl). */
export async function installSystemd(): Promise<number> {
  const path = unitPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, systemdUnit(muxBin()));
  console.log(`wrote ${path}`);
  const run = async (...args: string[]) =>
    (await Bun.spawn(["systemctl", "--user", ...args], { stdout: "inherit", stderr: "inherit" }).exited) === 0;
  if (!(await run("daemon-reload")) || !(await run("enable", "--now", "mcpmux.service"))) {
    console.error("systemctl step failed — enable manually: systemctl --user enable --now mcpmux.service");
    return 1;
  }
  console.log("mcpmux.service enabled and started (survives logout with lingering enabled)");
  return 0;
}
