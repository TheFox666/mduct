# mduct — design spec (2026-07-19)

One binary (`mduct`) that multiplexes any number of MCP servers behind a plain CLI,
so agents and humans call MCP tools without loading a single tool schema into
model context. Persistent daemon for stateful/OAuth servers, discovery on
demand, hooks that keep the capability *salient* to agents instead of merely
available.

## Problem

MCP tool schemas flood model context (a GitLab server alone ≈ 120 tools).
Deferred/lazy tool loading fixes the token cost but creates a worse failure
mode in practice: out of context = out of mind — agents forget the tools exist.
Existing OSS CLIs (f/mcptools, chrishayuk/mcp-cli) spawn the server per call
(kills OAuth/browser sessions) and take the full server command on every
invocation (unusable for a model). mcpc requires an account. None solve
discoverability.

## Goals

1. Zero MCP schemas in model context; capability stays discoverable.
2. Stateful by design: daemon holds server connections and OAuth sessions.
3. General-purpose: any agent harness or human shell, not just the office.
4. Server management as easy as the Claude CLI: interactive picker over the
   public MCP registry, import from existing Claude configs (plural), hot
   reload from config.
5. Single self-contained binary, trivial setup, shareable (MIT).

## Non-goals

- No hosted service, no accounts, no telemetry.
- No own server catalog — the official registry (registry.modelcontextprotocol.io)
  is consumed read-only.
- Not a replacement for purpose-built native CLIs where those are better
  (e.g. Playwright stays a real CLI).

## CLI surface

```
mduct call <server> <tool> [--args '<json>' | key=value …] [--timeout s] [--raw]
mduct tools <server>              # compact list: name — one-liner (cached)
mduct schema <server> <tool>      # full JSON schema, on demand only
mduct index [--format md]         # ~80-token per-server digest for prompts
mduct servers                     # configured servers + connection status
mduct add [<registry-ref>] [-- <command…>] [--from-claude]   # bare `mduct add` = picker
mduct remove <server> | enable | disable
mduct auth <server>               # interactive OAuth (prints URL, local callback)
mduct doctor                      # overlap/dead-server/token-cost analysis
mduct status | logs [server] | daemon [--install]
mduct hook install claude        # SessionStart + PreToolUse adapters
```

Output contract (agents are the primary reader):

- Tool result text → stdout. Binary content (images…) → temp file, path on stdout.
- Errors → stderr, exit 1, and every error names the next action
  ("session expired → run: mduct auth linear", "unknown tool → mduct tools gitlab").
- `key=value` for flat args, `--args '<json>'` for nested; `--raw` = full
  JSON-RPC result envelope.

## Architecture

One binary, two roles. `mduct daemon` is the long-runner; every other command is
a thin client over a Unix socket (`$XDG_RUNTIME_DIR/mduct.sock`, fallback
`~/.cache/mduct/`; JSON-RPC). If no socket answers, the client spawns the
daemon detached and retries briefly — no hard systemd dependency.
`mduct daemon --install` optionally writes a systemd user unit (Restart=always).

Daemon ↔ MCP servers via the official TypeScript MCP SDK:

- stdio servers as child processes; HTTP/streamable with OAuth session.
- Lazy connect on first call; idle disconnect per server (`idleTtl`,
  default 30 min — npx server startup is expensive); reconnect with backoff.
- Tool lists cached at connect, invalidated on `listChanged` notification.
- Calls to different servers run concurrently; per-server queue (MCP servers
  are not uniformly reentrant). Per-call timeout (default 60 s).
- Ring-buffer logs in the daemon (`mduct logs`), no separate log daemon.
- Config hot reload: daemon watches `servers.jsonc`; added servers are
  available on next call, removed ones are disconnected. No restart.

## OAuth

Daemon owns token sessions (`~/.config/mduct/auth/`, mode 0600). First-time
auth is interactive: `mduct auth <server>` prints the URL, listens on a local
callback port. Headless agents only ever meet valid sessions; when a refresh
token dies the call fails loudly with the fix command instead of hanging.

## Config

`~/.config/mduct/servers.jsonc` — per server: `command`/`args`/`env` (stdio)
or `url` (HTTP), plus `guard` (allow/deny tool-name patterns), `idleTtl`,
`note` (the one-liner used by `mduct index`; auto-distilled from tool
descriptions on first connect, manually overridable). Secrets are `${ENV_VAR}`
references, never literals.

Claude configs are a *list* of sources, not a singleton: auto-discovered
`~/.claude*` directories, `$CLAUDE_CONFIG_DIR`, project-level `.mcp.json`,
extendable. `mduct add --from-claude` imports selectively, grouped by source.
`mduct doctor` checks every source for servers that mduct also serves.

## Registry / marketplace

`mduct search <query>` queries the official MCP registry. Bare `mduct add` opens
an interactive picker (list, `/` filter, Enter toggles install/uninstall,
installed entries marked) — human UI only; agents use the non-interactive
forms which do exactly the same. That parity is a hard requirement, not a
convenience: every management operation (search/add/remove/auth-status/doctor)
MUST be fully scriptable without a TTY, so an agent can install and manage MCP
servers end to end — UX and AX (agent experience) are co-equal interfaces. Registry manifests prompt for required env
vars on install.

## Guard

Per-server allow/deny patterns enforced in the daemon (not the prompt):
e.g. verifier setups allow `list_*|get_*` and deny the rest. Combined with
shell allowlists on the consumer side (`mduct call gitlab list_*` is a plain
argv prefix — finer-grained than MCP tool permissions ever were).

## Discoverability (the actual product)

Schemas out of context is the easy half; agents forgetting the capability is
the failure mode that kills lazy-loading approaches. Countermeasures:

1. `mduct index` — generated, compressed, one line per server (~80 tokens
   total). Designed to sit permanently in a system prompt / CLAUDE.md.
2. `mduct hook install claude`:
   - **SessionStart hook** injects `mduct index` output as additionalContext —
     structural, always current, no hand-maintained prompt block.
   - **PreToolUse hook** intercepts `mcp__<server>__<tool>` calls and rejects
     with the literal replacement command. Token-neutral (schemas already
     loaded if the server is attached) — this is the migration/consistency
     tool, not the savings. The savings come from removing servers from the
     agent config; then there is nothing left to intercept.
   - **Migration nudge**: at session start, when direct MCP servers overlap
     with mduct-served ones, inject a one-time notice with the exact
     `claude mcp remove <name>` commands and the honest caveat that the
     current session's schemas are already paid for. Never auto-remove —
     config mutation stays a user decision.
3. `mduct doctor` — the same analysis on demand, for humans.

Hooks are harness-specific adapters shipped next to the harness-agnostic core
(`hooks/claude/`); other harnesses can follow.

## Packaging & distribution

- `bun build --compile` → single self-contained executable per platform
  (Linux x64/arm64, macOS; ~60–90 MB, acceptable for a dev tool).
- v1: GitHub releases + `curl -fsSL …/install.sh | sh` → `~/.local/bin/mduct`.
- Later (explicitly planned, not v1): npm package (`npx mduct`) and a
  Homebrew formula, so no curl is needed.
- Repo `~/dev/mduct`, standalone, MIT, no office references — the office is
  just a consumer (removes gitlab/sentry/linear from agent `--mcp-config`,
  appends `mduct index` to system prompts).

## Testing

- In-repo fixture: a ~30-line stdio MCP server (echo / sleep / fail tools).
  Integration tests cover CLI→socket→daemon→child end to end: call, timeout,
  crash+reconnect, idle disconnect, guard deny, hot reload.
- Unit: config parsing/merging across Claude sources, index compression,
  arg parsing (`key=value` vs `--args`).
- OAuth: token-refresh path mocked in tests; live Linear flow is a manual
  acceptance check.

## v1 scope

In: daemon, stdio + HTTP transports, call/tools/schema/index/servers/add
(incl. picker + --from-claude)/remove/auth/doctor/status/logs, guard, Claude
hooks, install.sh, fixture-server test suite.

Out (later): npm/brew distribution, non-Claude hook adapters, resources/
prompts surfaces (tools only in v1), remote daemon (TCP), Windows.

## Open questions

- None blocking. Registry manifest format details get verified against the
  live registry during implementation; if the registry API shifts, `mduct add
  -- <command>` and `--from-claude` are unaffected fallbacks.
