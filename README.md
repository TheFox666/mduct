# mduct

*because it glues shit together*

One binary. Any number of MCP servers and plain CLIs behind a single command,
none of their tool schemas anywhere near your model's context.

```sh
mduct call gitlab list_issues state=opened --json | jq '.[].title'
```

That's the whole idea. It is a duct. Things go through it.

---

## Why

An MCP client loads every connected server's full tool schemas up front. One
GitLab server is ~120 tools; three servers and you have spent a five-figure
token count before the model has read your question. You pay it again on every
context refresh, for tools that mostly go unused.

mduct puts a **one-line index per server** in the prompt and keeps the schemas
on disk until something actually calls a tool:

```
MCP tools via `mduct` (list: mduct tools <server>; call: mduct call <server> <tool> key=value):
  gitlab       — GitLab: MRs, pipelines, issues, repos
  kubectl      — read-only cluster access
```

~80 tokens instead of ~40k. The tool is still discoverable — it just isn't
sitting in the context being expensive.

Lazy-loading the schemas gets you the token bill but a worse failure mode: out
of context, out of mind. An agent forgets a capability it cannot see. The index
is small enough to always be there.

## What you get

| | |
|---|---|
| **Warm daemon** | Connections and OAuth sessions survive between calls. A stdio server isn't respawned and a remote isn't re-handshaked on every invocation. |
| **Pipe-ready** | `--json` strips the prose some servers wrap around results, so `\| jq` works. `--compact` minifies. Exit codes mean what you think. |
| **Guard in the daemon** | Per-server `allow`/`deny` patterns live where the model can't argue with them. |
| **Secrets out of config** | `${VAR}` refs resolve from a 0600 store. Plaintext tokens never touch `servers.jsonc`. |
| **MCP and plain CLIs** | `kubectl`, `playwright` and friends appear in the same list and are called the same way. Nobody cares which is which. |
| **Isolated instances** | One env var gives a second agent its own config, secrets, auth and daemon. |

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/TheFox666/mduct/main/install.sh | sh
```

Downloads the release binary, verifies its checksum, drops `mduct` into
`~/.local/bin`. From a checkout instead: `bun run build && cp dist/mduct ~/.local/bin/`.

## Quickstart

**Stash a token** — `${VAR}` refs resolve from a 0600 store, so it stays out of
the config file:

```sh
echo "$YOUR_GITLAB_PAT" | mduct secret set GITLAB_PAT
```

**Declare a server** in `~/.config/mduct/servers.jsonc`:

```jsonc
{
  "servers": {
    // local: mduct launches the process and talks stdio
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@yoda.digital/gitlab-mcp-server"],
      "env": { "GITLAB_PERSONAL_ACCESS_TOKEN": "${GITLAB_PAT}" },
      "guard": { "deny": ["delete_*"] },
      "note": "GitLab: MRs, pipelines, issues, repos"
    },
    // remote: nothing to install, mduct speaks HTTP to it
    "notes": { "url": "https://mcp.example.com/mcp", "auth": "oauth" }
  }
}
```

Hand-editing optional: `mduct add` opens a picker, `mduct import` lifts servers
out of existing Claude configs.

**Call things.** The daemon autostarts:

```sh
mduct servers                 # what's configured
mduct tools gitlab            # tool names + signatures, no schemas
mduct schema gitlab create_issue
mduct call gitlab create_issue project=42 title="it broke again"
mduct status                  # which instance answered, and from where
```

**Wire an agent to it** — for Claude Code there are hooks; for anything else,
paste `mduct index` into the system prompt:

```sh
mduct hook install claude
```

## How it works

```
  you / your agent
        │
        │  mduct call gitlab list_issues state=opened
        ▼
   ┌──────────┐        unix socket        ┌─────────────────────────┐
   │  mduct   │ ────────────────────────► │  daemon                 │
   │   CLI    │ ◄──────────────────────── │  · live MCP connections │
   └──────────┘        text / json        │  · OAuth sessions       │
                                          │  · guards               │
                                          └───────────┬─────────────┘
                                                      │ stdio / http
                                    ┌─────────────────┼─────────────────┐
                                    ▼                 ▼                 ▼
                                 gitlab            notes            kubectl
                              (npx, stdio)      (remote, oauth)    (plain CLI)
```

The CLI is a thin client. Everything with state — connections, tokens, guards —
lives in the daemon, out of reach of whatever the model talked itself into.

You never start it by hand:

```sh
mduct status              # up? which socket/config/secrets
mduct logs [server]       # recent activity
mduct daemon --stop       # next call restarts it
mduct daemon              # foreground, for when startup fails and you want to know why
mduct daemon --install    # systemd user unit, if you want it at login
```

## Arguments

httpie-style, because typing JSON on a command line is a punishment:

```sh
mduct call srv tool key=value                  # scalar (ints, floats, bools coerced)
mduct call srv tool ids:='[1,2,3]'             # := parses the value as JSON
mduct call srv tool --args '{"deep":{"x":1}}'  # whole object, wins on conflict
mduct call srv tool --raw                      # full MCP envelope instead of the text
mduct call srv tool --json | jq .              # strip the server's prose
```

More in the wiki: **[Arguments & output](../../wiki/Arguments-and-output)**.

## Configuration

`~/.config/mduct/servers.jsonc` — JSONC, so comments survive your future self.
Two sections, `servers` (MCP) and `tools` (plain CLIs), plus `defaults`.

```jsonc
"tools": {
  "kubectl": {
    "run": "kubectl",
    "args": ["--insecure-skip-tls-verify=true"],
    "env": { "KUBECONFIG": "${HOME}/.kube/test.yaml" },
    "check": "kubectl version --client",
    "note": "read-only cluster access"
  }
}
```

```sh
mduct run kubectl get pods -n default    # with the tool's env/wrapping applied
mduct tool status                        # installed / missing, + update hints for pinned npm tools
```

Full field reference in the wiki: **[Configuration](../../wiki/Configuration)**.

### Guard

```jsonc
"guard": { "allow": ["list_*", "get_*"] }   // read-only, whatever the model would prefer
```

Enforced in the daemon. A denied call fails the same way for a human and for an
agent having a bad day.

### Named instances

```sh
mduct servers                            # ~/.config/mduct/
MDUCT_PROFILE=ci mduct servers           # ~/.config/mduct-ci/, own socket, own secrets
```

| Variable | Effect |
|---|---|
| `MDUCT_PROFILE` | named instance → `~/.config/mduct-<profile>/` + its own socket |
| `MDUCT_CONFIG` | config path |
| `MDUCT_SECRETS` | secret store |
| `MDUCT_SOCKET` | daemon socket |

## Shadowing

A server can declare which *other* tool calls it could have served, and mduct
says so at the moment of the call — a token bucket decides how often, and the
answer is never "no":

```jsonc
"shadow": [{
  "tool": ["Grep"],
  "bash": "(?:^|[\\n;]|&&)\\s*(grep|rg|ugrep)\\b",
  "pathIn": ["~/src/bigrepo"],
  "hint": "That repo is indexed — `mduct call codeindex search query=…` is faster.",
  "budget": 2,
  "refillMin": 30
}]
```

Because a prompt block is read once and then loses to habit. Measured on one
two-day session: 21 calls to a code-index server against 270 greps into the
repos it had indexed, with the index block present the entire time.

`mduct shadow` reports nudges against follow-up calls, so you can tell whether
it earns its friction or is just being annoying. Details and tuning:
**[Shadowing](../../wiki/Shadowing)**.

## Secrets & OAuth

```sh
echo "$TOKEN" | mduct secret set GITLAB_PAT   # or a hidden prompt
mduct secret list                             # names, never values
mduct auth notes                              # browser consent once; daemon refreshes after that
```

`mduct add --env` and `mduct import` move literal values into the store and
leave a `${ref}` behind.

## Import & registry

```sh
mduct add                              # picker: ↑↓/jk, / to search the registry, ⏎ toggle, q quit
mduct import                           # MCP servers found in existing Claude configs
mduct search gitlab                    # the public registry
mduct add com.gitlab/mcp --as gitlab   # install by ref, version-pinned
mduct doctor                           # servers attached directly AND served here (you want zero)
```

## Wiki

* **[Cookbook](../../wiki/Cookbook)** — recipes: jq pipelines, batch calls, CI, read-only agents, second instance
* **[Configuration](../../wiki/Configuration)** — every field, with defaults
* **[Arguments & output](../../wiki/Arguments-and-output)** — argument forms, output contract, exit codes
* **[Agent integration](../../wiki/Agent-integration)** — Claude hooks, prompt block, other harnesses
* **[Shadowing](../../wiki/Shadowing)** — nudge rules, buckets, measurement
* **[Troubleshooting](../../wiki/Troubleshooting)** — when the daemon sulks

## Not built yet

npm and Homebrew channels. Until then: `install.sh` (release binary + checksum)
or `bun run build`.

MIT.
