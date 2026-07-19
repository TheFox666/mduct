# mcpmux Management Layer Plan (Plan 2 of 2)

> Execution notes for the same-session implementer. TDD red-green per task,
> commit per green cycle. Spec: `docs/specs/2026-07-19-mcpmux-design.md`.

**Goal:** Server management (add/remove/import/registry), doctor, Claude hooks,
native OAuth — everything scriptable without a TTY (AX = UX).

## Task 1 — config mutation (`src/shared/configEdit.ts`)
- `addServer(name, cfg)`, `removeServer(name)`, `setDisabled(name, bool)` —
  read-modify-write of servers.jsonc. Rewrites as pretty JSON with a generated
  header comment; hand comments are NOT preserved (documented in README).
  Refuses `addServer` over an existing name without `{replace:true}`.
- Tests: add→load roundtrip; remove unknown → error naming known servers;
  disable→loadConfig shows disabled; header comment present after rewrite.

## Task 2 — CLI add/remove/enable/disable (non-interactive)
- `mux add <name> -- <command…>` (+ `--env K=V…`, `--note`, `--url` variant),
  `mux remove/enable/disable <name>`. Daemon hot-reload makes changes live.
- e2e tests via spawned CLI like cli.test.ts.

## Task 3 — Claude config discovery + import (`src/shared/claudeConfigs.ts`)
- `discoverClaudeSources(home=~)`: `~/.claude*/.claude.json` + `~/.claude.json`
  + `$CLAUDE_CONFIG_DIR/.claude.json` + `./.mcp.json` — return
  `{source, servers: Record<name, {command,args,env}|{url,headers}>}[]`
  (mcpServers key in both file shapes; type:"http"/url entries mapped).
- `mux import --from-claude [--source <path>] [name…]`: no names → list
  candidates grouped by source (scriptable output `source\tname\tkind`);
  with names → addServer each. Collision → suffix or `--as <newname>`.
- Tests: fixture home dir with two fake config dirs + project .mcp.json.

## Task 4 — doctor (`src/cli/doctor.ts`)
- Sections: (a) overlap: servers in Claude sources ALSO served by mux →
  print removal commands per source; (b) dead servers: configured in mux but
  connect fails (daemon `probe` method with short timeout); (c) token
  estimate per direct-attached server: tools×~350 tokens heuristic.
- Exit 0 always (report, not gate). Tests: fixture overlap → expected lines.

## Task 5 — registry search/add (`src/shared/registry.ts`)
- `MCPMUX_REGISTRY` base URL override (tests use local fixture server).
  `searchRegistry(q)` → GET /v0/servers?search=… ; map entries to
  `{ref, name, description, install: {command,args,env[]} | {url}}`; verify the
  real API shape during implementation (WebFetch), keep the mapper tolerant.
- `mux search <q>` prints `ref\tdescription`. `mux add <ref>` fetches manifest,
  prompts for required env vars only when TTY (else requires `--env`).
- Bare `mux add` (TTY only): numbered list picker over search results +
  installed servers (toggle install/remove by number, `/term` filter, q quit).
  Plain readline — no raw-mode TUI in v1 (upgrade path noted).
- Tests: fixture registry (Bun.serve JSON) → search maps; add <ref> writes cfg.

## Task 6 — Claude hooks (`hooks/claude/` + `src/cli/hook.ts`)
- `mux hook install claude [--config-dir <dir>] [--settings <file>]`:
  1. writes `~/.config/mcpmux/hooks/session-start.sh` → emits `mux index` +
     overlap-nudge (doctor-lite) to stdout (SessionStart stdout = context).
  2. writes `pre-tool-use.sh` → stdin JSON, if tool_name matches `mcp__(<mux-served>)__`
     → JSON deny decision with `mux call <server> <tool>` replacement hint.
  3. idempotently patches target settings.json hooks section (SessionStart +
     PreToolUse matcher `mcp__.*`); `--remove` reverts.
- Tests: temp settings.json → patch idempotent (double install = one entry);
  pre-tool-use script fed fixture JSON → deny JSON with replacement; session
  script prints index.

## Task 7 — native OAuth (`src/daemon/auth.ts`, `mux auth <server>`)
- `FileOAuthProvider implements OAuthClientProvider` (sdk): tokens/client-info
  under `~/.config/mcpmux/auth/<server>.json` mode 0600; redirect to
  `http://127.0.0.1:<random>/cb` one-shot Bun.serve callback.
- http connections get `authProvider` when cfg `auth: "oauth"`; 401 →
  error "run: mux auth <server>". `mux auth <server>` drives the flow:
  prints URL (no auto-open), waits callback, exchanges, saves.
- Tests: mock OAuth AS + resource server (Bun.serve): metadata, code→token,
  refresh; provider persists round-trip. Live check vs Linear = manual.
- `mux daemon --install`: write systemd user unit (After=default.target,
  ExecStart=<abs mux> daemon, Restart=on-failure) + `systemctl --user enable --now`.

## Deferred (release chores, not code): npm package, brew formula, GitHub
release pipeline, macOS builds.
