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

## Roadmap

See `docs/specs/2026-07-19-mcpmux-design.md`: registry marketplace with
interactive picker (`mux add`), import from Claude configs (`--from-claude`,
multiple config dirs), native OAuth (`mux auth`), `mux doctor`, Claude hooks
(SessionStart index injection, PreToolUse redirect), npm/Homebrew distribution.

MIT.
