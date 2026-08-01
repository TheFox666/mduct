<p align="center"><img src="docs/banner.png" alt="mduct — because it glues shit together" width="100%"></p>

One binary in front of any number of MCP servers and plain CLIs, with none of
their tool schemas in your model's context.

<p align="center"><img src="docs/demo.gif" alt="mduct demo: list servers, inspect tools, call one, pipe it through jq, get denied by a guard" width="100%"></p>

```sh
mduct call gitlab list_issues state=opened --json | jq '.[].title'
```

It is a duct. Things go through it.

## Why

An MCP client loads every connected server's tool schemas up front, all of them.
Measured on one GitLab server: 186 tools, about 168 kB of JSON Schema, roughly
40k tokens spent before the model has read your question. You pay it again on
every context refresh, mostly for tools nobody calls.

mduct puts a few lines per server in the prompt and leaves the schemas on disk
until something calls a tool:

```
MCP tools via `mduct` CLI (list+args: mduct tools <server>; call: mduct call <server> <tool> key=value):
  notes        — shared notes
      search(query, limit?)  get(id)  put(id, body)
  gitlab       — GitLab: MRs, pipelines, issues, repos
      189 tools — mduct tools gitlab
CLI tools via `mduct` CLI (what it can do: mduct tools <tool>; run: mduct run <tool> [args…]):
  kubectl      — read-only cluster access
```

A server small enough to carry its signatures brings them along, so an agent can
see the call instead of remembering to ask for it. A 189-tool server collapses to
a count and a pointer, because 16 kB of names in every context is the thing this
exists to prevent. Measured on a real seven-server setup: 2.9 kB in total.

The signatures come from a cache the daemon fills as a side effect of use, so the
index never connects and works cold in a session hook. `mduct index --refresh`
fills it on purpose; `indexTools` per server overrides the threshold either way.

Loading schemas lazily instead would fix the token bill and introduce a worse
problem: out of context, out of mind. An agent will not use a capability it
cannot see, and this is the whole reason the index exists at all.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/TheFox666/mduct/main/install.sh | sh
```

Fetches the release binary, checks its sha256, puts `mduct` in `~/.local/bin`.
From a checkout: `bun run build && cp dist/mduct ~/.local/bin/`.

## Quickstart

**Stash a token.** `${VAR}` refs resolve from a 0600 store, so it never reaches
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

You don't have to hand-edit it. `mduct add` opens a picker and `mduct import`
lifts servers out of an existing Claude config.

**Call things.** The daemon autostarts:

```sh
mduct servers                 # what's configured
mduct tools gitlab            # tool names + signatures, no schemas
mduct schema gitlab create_issue
mduct call gitlab create_issue project=42 title="it broke again"
mduct status                  # which instance answered, and from where
```

**Wire an agent to it.** Claude Code has hooks for this. Anything else: paste
`mduct index` into the system prompt.

```sh
mduct hook install claude
```

## How it works

```mermaid
flowchart TD
    A["you / your agent<br/><code>mduct call gitlab list_issues</code>"] -->|unix socket| D
    D["daemon<br/>live MCP connections · OAuth sessions · guards"] --> G["gitlab<br/><i>npx, stdio</i>"]
    D --> N["notes<br/><i>remote, oauth</i>"]
    D --> K["kubectl<br/><i>plain CLI</i>"]
    D -->|text / json| A
```

The CLI is a thin client. Everything with state lives in the daemon:
connections, tokens, guards. That is deliberate. A guard the model could reach
would be a suggestion.

You never start the daemon by hand:

```sh
mduct status              # up? which socket/config/secrets
mduct logs [server]       # recent activity
mduct daemon --stop       # next call restarts it
mduct daemon              # foreground, for when startup fails and you want to know why
mduct daemon --install    # systemd user unit, if you want it at login
```

## What else is in there

| | |
|---|---|
| Warm daemon | Connections and OAuth sessions survive between calls. A stdio server isn't respawned and a remote isn't re-handshaked every time you invoke it. |
| Pipe-ready output | `--json` strips the prose some servers wrap around their payload. `--compact` minifies. Exit codes mean what you think they mean. |
| Guards in the daemon | Per-server `allow`/`deny` patterns, living somewhere the model cannot argue with them. |
| Secrets out of the config | `${VAR}` refs resolve from a 0600 store. Plaintext tokens never touch `servers.jsonc`. |
| MCP and plain CLIs | `kubectl`, `playwright` and friends show up in the same list and are called the same way. Nobody has to care which is which. |
| Isolated instances | One env var gives a second agent its own config, secrets, auth and daemon. |
| Oversized-result guard | A result past `warnAbove` characters prints a ready-made `jq` projection instead of quietly costing you 40k characters. |

## Arguments

httpie-style, because typing JSON on a command line is a punishment:

```sh
mduct call srv tool key=value                  # scalar (ints, floats, bools coerced)
mduct call srv tool ids:='[1,2,3]'             # := parses the value as JSON
mduct call srv tool --args '{"deep":{"x":1}}'  # whole object, wins on conflict
mduct call srv tool --raw                      # full MCP envelope instead of the text
mduct call srv tool --json | jq .              # strip the server's prose
```

More argument forms and the output contract: [Arguments & output](../../wiki/Arguments-and-output).

## Configuration

`~/.config/mduct/servers.jsonc`, in JSONC so your comments survive. Two
sections that behave the same from outside, `servers` for MCP and `tools` for
plain CLIs, plus `defaults`.

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
mduct tools kubectl                      # what it can do — the tool's own help, through its wrapper
mduct run kubectl get pods -n default    # with the tool's env/wrapping applied
mduct tool status                        # installed / missing, + update hints for pinned npm tools
```

`mduct tools <name>` answers for both kinds. For an MCP server it lists tool
signatures; for a CLI tool it runs that tool's help. Otherwise the only way to
discover a CLI tool's surface is to already know it.

A CLI is not always enough — sometimes a script needs the library behind it.
Declare it, and mduct keeps a pinned copy and hands you the environment:

```jsonc
"playwright": { "run": "bunx", "args": ["playwright@1.61.1"], "lib": "playwright@1.61.1" }
```

```sh
mduct tool setup playwright      # installs the library into the instance cache
eval "$(mduct env playwright)"   # NODE_PATH, plus whatever env the tool declares
node screenshot.js               # require("playwright") resolves, at the pinned version
```

Every field with its default: [Configuration](../../wiki/Configuration).

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

### Parallel calls

One call at a time per server, because the failure path closes the transport and
not every MCP server is reentrant. If yours is, say so and calls overlap:

```jsonc
"gitlab": { "command": "…", "maxConcurrent": 5 }
```

Measured with a 300 ms tool, five calls at once: 1561 ms serialised, 360 ms with
`maxConcurrent: 5`. Start at 3 or 4 rather than a big number, and watch the
server's own rate limit rather than mduct's.

## The tool namespace

The prompt block is prose, and prose competes with habit. Tool *selection*
happens in the namespace, and nothing written into a prompt lands there.

`mduct mcp` is a second face for exactly that: an MCP server whose `tools/list`
mirrors the real tools, so their names sit where an agent looks. It does not
execute. Each entry's description is the shell command to run:

```
hive__find_symbol   $ mduct call hive find_symbol name=… repo=… — where a symbol is defined
```

Calls stay in the shell, because the shell is the part worth keeping: `--json |
jq`, redirection, loops. Running results back through MCP would hand every
payload straight into the context.

```jsonc
"kb": { "command": "…", "mcpCatalog": true }   // opt in, per server
```

```sh
mduct hook install claude              # registers the catalogue too
```

Hooks live in `settings.json` and MCP servers in `.claude.json`, so the install
touches both — leaving the second to you is an install that half-works and a
catalogue nobody sees. `--remove` takes it back out, and session start says so
if a server declares `mcpCatalog` while the server is not registered.

### Which servers to mirror

Not the ones you talk about. "Look at the GitLab MR" or "file a Linear ticket"
names the server, and the request drags the tool in by itself. The ones worth
the namespace are the servers **no request ever names** — a code index, a
knowledge base, anything an agent is supposed to reach for on its own initiative
while doing something else. That is exactly where a prose line loses to habit.

Cost keeps the list short: a catalogue entry runs about six times the prose line
for the same tool. Measured on one setup — 15 tools are 2.5 kB as a catalogue
against 0.75 kB as signatures in the index; a 189-tool server would be 29 kB. A
catalogued server drops its signatures from the prompt block, so you never pay
for both.

## Shadowing

A server can declare which *other* tool calls it could have served, and mduct
says so at the moment of the call. The call still runs — the note rides along
with its result — and a token bucket decides how often it speaks:

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

This exists because a prompt block is read once and then loses to habit.
Measured on one two-day session: 21 calls to a code-index server against 270
greps into the repos that server had indexed, with the index block sitting in
context the entire time. The agent knew. It reached for grep anyway.

The note arrives as `additionalContext`, never as an approval: a nudge must not
widen permissions, so a call that would have asked still asks. A rule that really
must stop something sets `block: true` and gets the old denial back.

`mduct shadow` counts nudges against follow-up calls, so you can tell whether the
hint changes anything. Tuning and details: [Shadowing](../../wiki/Shadowing).

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

| | |
|---|---|
| [Cookbook](../../wiki/Cookbook) | jq pipelines, batching, CI, read-only agents, a second instance |
| [Configuration](../../wiki/Configuration) | every field, with defaults and failure modes |
| [Arguments & output](../../wiki/Arguments-and-output) | argument forms, the output contract, exit codes |
| [Agent integration](../../wiki/Agent-integration) | Claude hooks, the prompt block, other harnesses |
| [Shadowing](../../wiki/Shadowing) | nudge rules, buckets, measurement |
| [Troubleshooting](../../wiki/Troubleshooting) | when the daemon sulks |

## Not built yet

npm and Homebrew channels. For now it is `install.sh` (release binary plus
checksum) or `bun run build`.

MIT.
