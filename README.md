# mcpmux

One binary (`mux`) that multiplexes any number of MCP servers behind a plain
CLI — agents and humans call MCP tools **without loading a single tool schema
into model context**.

MCP tool schemas flood LLM context (a GitLab server alone ships ~120 tools).
Lazy/deferred loading fixes the token bill but creates a worse failure mode:
out of context = out of mind — agents forget the capability exists. mcpmux
keeps a ~80-token index in the prompt and everything else on demand, with a
persistent daemon so stateful servers (OAuth sessions, connection reuse)
survive between calls.

## Quickstart

```sh
# 1. install (or: bun run build && cp dist/mux ~/.local/bin/)
curl -fsSL https://raw.githubusercontent.com/OWNER/mcpmux/main/install.sh | sh

# 2. configure servers — ~/.config/mcpmux/servers.jsonc
```

```jsonc
{
  "servers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@yoda.digital/gitlab-mcp-server"],
      "env": { "GITLAB_PERSONAL_ACCESS_TOKEN": "${GITLAB_PAT}", "GITLAB_URL": "https://gitlab.com" },
      "guard": { "deny": ["delete_*"] },
      "note": "GitLab: MRs, pipelines, issues, repos"
    },
    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
  }
}
```

```sh
# 3. use it — the daemon autostarts and keeps connections warm
mux call gitlab get_current_user
mux call gitlab list_issues state=opened --timeout 30
mux tools gitlab            # compact list, no schemas
mux schema gitlab create_issue
mux index                   # the prompt block for your agent
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
| `MCPMUX_CONFIG` | config path (default `~/.config/mcpmux/servers.jsonc`) |
| `MCPMUX_SOCKET` | daemon socket (default `$XDG_RUNTIME_DIR/mcpmux.sock`) |

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
mux tool status                # installed / missing per tool
mux tool setup playwright      # run its installer
mux add kubectl --tool --check "kubectl version --client" -- kubectl
```

`mux run` applies the stored env/wrapping, so a tool with a special setup works
identically everywhere — no per-environment lock-in.

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

## Import & registry

```sh
mux import                  # list MCP servers across all Claude configs (~/.claude*, .mcp.json)
mux import linear           # copy one into mux (secrets externalized)
mux search gitlab           # the public MCP registry
mux add com.gitlab/mcp --as gitlab   # install by registry ref (version-pinned)
mux doctor                  # overlap report: servers attached directly AND served by mux
```

## Install

```sh
mux daemon --install        # optional systemd user unit (warm daemon, Restart=on-failure)
```

## Deliberately not built (v1)

Interactive `mux add` picker — the non-interactive `mux search` + `mux add
<ref>` covers both humans and agents, so a raw-mode TUI wasn't worth the
surface. npm/Homebrew distribution channels are release chores.

MIT.
