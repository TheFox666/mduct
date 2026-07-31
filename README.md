# mcpmux

One binary (`mux`) that multiplexes any number of MCP servers behind a plain
CLI — agents and humans call MCP tools **without loading a single tool schema
into model context**.

What you get:

- **Context stays tiny** — a ~80-token index in the prompt instead of every server's full tool schemas (a GitLab server alone is ~120 tools).
- **Schemas on demand** — `mux tools <server>` lists tools with no schemas; `mux schema <server> <tool>` pulls one when you actually need it.
- **Pipe-ready output** — `--json` strips prose so `| jq` just works, even on servers that wrap results in chatter; `--compact` minifies it.
- **Warm daemon** — connections and OAuth sessions survive between calls, so stateful servers don't re-handshake every invocation.
- **Guard in the daemon, not the prompt** — per-server `allow`/`deny` patterns the model can't talk its way around.
- **Secrets stay out of config** — `${VAR}` refs resolve from a 0600 store; plaintext tokens never land in `servers.jsonc`.
- **One interface for MCP *and* plain CLIs** — playwright, kubectl, aws show up in the same capability list, called the same way.
- **Isolated instances** — one env var gives an agent its own config, secrets, auth and daemon.

Why not just lazy-load schemas? Deferred loading fixes the token bill but
creates a worse failure mode: out of context = out of mind — the agent forgets
the capability exists. The always-present index keeps the tool discoverable
while its schema stays out of context until called.

## Quickstart

**1. Install** — downloads the release binary, verifies its checksum, drops
`mux` into `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/TheFox666/mcpmux/main/install.sh | sh
```

Make sure `~/.local/bin` is on your `PATH` (the installer warns if it isn't).
From a source checkout instead: `bun run build && cp dist/mux ~/.local/bin/`.

**2. Add a secret** — `${VAR}` refs resolve from a 0600 store, so tokens stay
out of the config file (→ [Secrets](#secrets)):

```sh
echo "$YOUR_GITLAB_PAT" | mux secret set GITLAB_PAT
```

**3. Configure servers** — edit `~/.config/mcpmux/servers.jsonc`:

```jsonc
{
  "servers": {
    // local server — mux launches this process and talks to it over stdio
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@yoda.digital/gitlab-mcp-server"],
      "env": { "GITLAB_PERSONAL_ACCESS_TOKEN": "${GITLAB_PAT}", "GITLAB_URL": "https://gitlab.com" },
      "guard": { "deny": ["delete_*"] },
      "note": "GitLab: MRs, pipelines, issues, repos"
    },
    // remote server — mux talks to a hosted MCP endpoint over HTTP (nothing to install)
    "my-remote": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${REMOTE_TOKEN}" } }
  }
}

// each server is either `command`+`args` (local process) or `url` (remote HTTP) — the name is yours to pick
```

Prefer not to hand-edit? `mux add` opens an interactive picker and `mux import`
pulls servers out of existing Claude configs (→ [Import & registry](#import--registry)).

**4. Use it** — the daemon autostarts on the first call and keeps connections warm:

```sh
mux call gitlab get_current_user
mux call gitlab list_issues state=opened --timeout 30
mux tools gitlab            # compact tool list, no schemas
mux schema gitlab create_issue
mux status                  # resolved socket/config/secrets paths
```

**5. Wire it into Claude** *(optional, only for Claude Code)* — a SessionStart
hook injects the `mux index` prompt block and a PreToolUse hook redirects
`mcp__*` calls through mux (→ [Claude hooks](#claude-hooks)):

```sh
mux hook install claude
```

Not using Claude? Paste `mux index` into your agent's system prompt yourself
(→ [The prompt block](#the-prompt-block)).

## The daemon

Everything runs through a background daemon — it holds the live MCP connections
and OAuth sessions so they survive between calls (a stdio server isn't
re-spawned and a remote isn't re-handshaked on every `mux call`). It also
enforces the guards, out of reach of the model.

You never start it by hand. The first `mux call` spawns it, and it stays warm
for subsequent calls; each instance ([profile](#named-instances)) gets its own.
Managing it is rarely needed:

```sh
mux status              # is it up? which instance answered (socket/config/secrets)
mux logs [server]       # recent daemon activity, optionally for one server
mux daemon --stop       # stop it (the next call restarts it)
mux daemon              # run in the foreground — use this to see why startup fails
```

By default the daemon lives only as long as it's used. For a daemon that starts
at login and restarts on failure, install the optional systemd user unit:

```sh
mux daemon --install    # systemd user unit, Restart=on-failure
```

## The prompt block

`mux index` prints one line per server — put it in your system prompt or
CLAUDE.md (a SessionStart hook that injects it automatically ships with
plan 2):

```
MCP tools available via `mux` CLI (details: mux tools <server>; call: mux call <server> <tool> key=value):
  gitlab       — GitLab: MRs, pipelines, issues, repos
```

## Output contract (agents are the primary reader)

- Text content → stdout. Binary content (screenshots, files) → written to
  `$TMPDIR/mcpmux/`, path printed on stdout.
- Errors → stderr, exit 1, and every error names the next action
  (`unknown tool "x" — see: mux tools gitlab`).
- `key=value` for flat arguments, `--args '<json>'` for nested, `--raw` for
  the full result envelope.

## Guard

Per-server allow/deny patterns, enforced in the daemon — not in the prompt:

```jsonc
"guard": { "allow": ["list_*", "get_*"] }   // read-only server, whatever the model wants
```

## Environment

| Variable | Effect |
|---|---|
| `MCPMUX_PROFILE` | named instance → `~/.config/mcpmux-<profile>/` + its own socket (see below) |
| `MCPMUX_CONFIG` | config path (default `~/.config/mcpmux[-<profile>]/servers.jsonc`) |
| `MCPMUX_SECRETS` | secret store (default `~/.config/mcpmux[-<profile>]/secrets.json`) |
| `MCPMUX_SOCKET` | daemon socket (default `$XDG_RUNTIME_DIR/mcpmux[-<profile>].sock`) |

`mux status` prints the resolved socket/config/secrets paths, so it's always
obvious which instance answered.

## Named instances

Run several fully isolated muxes — each its own config, secrets, auth and daemon
— with a single env var, mirroring Claude's `~/.claude` vs `~/.claude-<profile>`:

```sh
mux servers                           # default instance → ~/.config/mcpmux/
MCPMUX_PROFILE=office mux servers      # a separate instance → ~/.config/mcpmux-office/
```

Each profile has its own daemon (`…/mcpmux-<profile>.sock`), its own credentials,
and its own server set — so one agent/account can't see or use another's. The
explicit `MCPMUX_CONFIG`/`MCPMUX_SECRETS`/`MCPMUX_SOCKET` overrides still win when
you need a bespoke path.

## CLI tools (not just MCP)

A `tools` section sits beside `servers`, so plain CLIs (playwright, kubectl,
aws) become discoverable and invokable through the *same* entry point — an
agent sees one capability list, no MCP-vs-CLI distinction:

```jsonc
"tools": {
  "playwright": {
    "run": "npx", "args": ["playwright"],
    "env": { "NODE_PATH": "${PLAYWRIGHT_NODE_PATH}" },   // special setup, applied centrally
    "check": "node -e \"require('playwright')\"",
    "setup": "npm i -g playwright && playwright install chromium",
    "note": "headless browser for UI smoke"
  }
}
```

```sh
mux run playwright test.js     # exec with the tool's env/wrapping, stdio + exit code passthrough
mux tool status                # installed / missing per tool (+ update hint for pinned npm tools)
mux tool setup playwright      # run its installer
mux tool update [name]         # re-pin an npm-backed tool to the latest published version
mux add kubectl --tool --check "kubectl version --client" -- kubectl
```

`mux run` applies the stored env/wrapping, so a tool with a special setup works
identically everywhere — no per-environment lock-in. For an npm-backed tool
(`bunx pkg@version`), `mux tool status` shows `↑ update X → Y` when a newer
version is out, and `mux tool update` bumps the pin; unpinned (`@latest`) tracks
latest already.

## Secrets

`${VAR}` in a config resolves against `process.env` first, then a 0600 secret
store — so the normal case needs no shell exports:

```sh
echo "$TOKEN" | mux secret set GITLAB_PAT     # or a hidden TTY prompt
mux secret list                               # names only, never values
```

`mux add --env` and `mux import` move literal secret values into the store
automatically and leave a `${ref}` in the config — plaintext tokens never land
in `servers.jsonc`.

## OAuth servers

```sh
mux auth linear     # one-time browser consent; tokens stored 0600, daemon auto-refreshes
```

Set `"auth": "oauth"` on an http server; the daemon then uses and refreshes the
stored token automatically. A dead session fails with `run: mux auth <server>`.

## Claude hooks

```sh
mux hook install claude     # SessionStart injects `mux index`; PreToolUse redirects mcp__* calls
```

## Shadowing — "this call could have been mine"

A session-start index is read once and then loses against habit. Measured on a
real two-day session: 21 calls to an indexed-code server against 270 greps into
the very repos it had indexed, with the index block in context the whole time.

So a server may declare which *other* tool calls it shadows, and mux says so at
the moment of the call — once per session, then it gets out of the way:

```jsonc
"hive": {
  "command": "…",
  "shadow": [{
    "tool": ["Grep", "Glob"],                       // tool names, matched exactly
    "bash": "\\b(grep|rg|ugrep)\\b",                // regex against a Bash command
    "pathIn": ["~/dev/zepnext", "~/dev/zepmaster"], // gate: only where this server is useful
    "hint": "This repo is indexed — try `mux call hive search_code query=…` first.",
    "budget": 2,                                    // bucket capacity (default 1)
    "refillMin": 30                                 // one hint back every 30 min (0 = never)
  }]
}
```

A token bucket, not a per-session counter — because a session is a bad unit of
time: a real one here ran two days and 816 tool calls, and a single hint at call
5 is an accident, not a lesson. `budget` allows a short burst, `refillMin` brings
hints back while the session keeps running. `refillMin: 0` is the plain fixed
budget and stays the default.

A redirect, not a ban: with the bucket empty the rule is silent, and re-running
the same grep simply works — the message says so. mux knows
nothing about what a server does — it matches the declared patterns and quotes
the server's own `hint`. No `shadow` block anywhere means no extra process per
Bash call, because `hook install` derives the PreToolUse matcher from the config
(and session start warns when the installed matcher no longer covers the rules).

Whether the redirect earns its friction is a measurement, not an opinion:

```sh
mux shadow      # nudges vs follow-up calls to that server, per server
```

## Import & registry

```sh
mux add                     # interactive TUI picker (arrow keys, / to search the registry, ⏎ toggle)
mux import                  # list MCP servers across all Claude configs (~/.claude*, .mcp.json)
mux import linear           # copy one into mux (secrets externalized)
mux search gitlab           # the public MCP registry
mux add com.gitlab/mcp --as gitlab   # install by registry ref (version-pinned)
mux doctor                  # overlap report: servers attached directly AND served by mux
```

Bare `mux add` on a terminal opens a raw-mode picker — ↑↓/jk to move, `/` to
search the registry, ⏎ to install a hit or remove an installed server, `q` to
quit. Non-interactive (piped/agent) use passes explicit args instead.

## Not built yet

npm (`npx mcpmux`) and Homebrew distribution channels — the `install.sh`
(GitHub-release binary + checksum) is the supported install route until then;
`bun run build` builds from source.

MIT.
