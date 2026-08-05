---
name: release
description: Use when cutting a mduct release — bumping the version, building the four platform binaries, writing the release notes, publishing to GitHub, and verifying the published artefact. Covers what belongs in notes and what does not. Applies whenever the user says "release", "ship it", "neues Release", or asks for a version bump.
---

# Releasing mduct

## Notes: the format, and what it is for

Release notes are read in a list view by someone deciding whether to upgrade.
They are not a write-up. One line per change, effect first, cause only if it
changes what the reader should do.

```markdown
### Breaking
- `mduct env` now requires a tool name; the bare form printed the wrong instance's env.

### Added
- `maxConcurrent` per server — overlapping calls where the server tolerates them (4 GitLab calls: 6.0s → 2.8s).
- `mduct tools <cliTool>` prints the tool's own help instead of "unknown server".

### Fixed
- Tool cache was shared across configs, so a test fixture could appear as another server's tools.

**Full changelog**: https://github.com/TheFox666/mduct/compare/v0.4.1...v0.5.0
```

Rules, in order of how often they are broken:

1. **One line per item.** If a change needs a paragraph, the paragraph belongs
   in the commit message or the wiki, and the note links there.
2. **Sections only if non-empty.** `Breaking` / `Added` / `Changed` / `Fixed`,
   in that order. No `Misc`, no `Other`.
3. **Lead with the effect on the user**, not the mechanism. "Calls to one server
   can overlap" beats "replaced the promise chain with a semaphore".
4. **Numbers instead of adjectives.** A measurement is worth three sentences of
   claim, and it has to be one you actually took.
5. **Breaking means breaking**: an upgrade that changes a path, a default, a
   command name, or rejects a config that used to load. Say what to do about it,
   in one line.
6. **No narrative.** How the bug was found, what you assumed, what surprised you
   — none of that belongs here. It belongs in the commit, where the next person
   to touch the code will read it.
7. **No marketing.** No "powerful", no "seamless", no emoji headers.

Write them in English, like the rest of the repo.

## Version

While 0.x: a new flag, command or config field is a minor bump; a fix on its own
is a patch. Something that breaks an existing config or install is still a minor
— say so under `Breaking` rather than pretending otherwise.

Check `git log --oneline vLAST..HEAD` first; the bump follows the changes, not
the other way around.

## Steps

CI does the mechanical half. You do the two parts that are decisions:

```sh
# 1. version — the bump follows the changes, see above
$EDITOR package.json

# 2. notes — first line is the release title, then a blank line, then the sections
$EDITOR notes/v0.5.2.md

# 3. tag and push. Everything after this is .github/workflows/release.yml
git commit -am "chore: bump version to 0.5.2"
git tag -a v0.5.2 -m "v0.5.2 — <the one-line reason>"
git push origin main && git push origin v0.5.2
```

The workflow refuses to publish when the tag and `package.json` disagree, or
when `notes/<tag>.md` is missing — both are mistakes that are easier to catch
before a release exists than after.

It then builds the four targets, writes the checksums, creates the release, and
installs the published binary the way a user would to exercise it.

The Homebrew formula is not updated from here. `TheFox666/homebrew-tap` has its
own workflow that reads the public releases and writes to itself, so it needs no
token — a cross-repo push would have needed a PAT, and an expired PAT shows up
as brew silently serving an old version. It polls every six hours; press
`workflow_dispatch` in the tap if you want it immediately.

Doing it by hand is still fine — the commands are in
`.github/workflows/release.yml` and they are the same ones. The only part that
is genuinely easier in CI is the install check, because the runner has no daemon
of its own.

## Verify the published artefact, not the local one

A green suite says the code is right; it says nothing about what people download.

```sh
D=$(mktemp -d)
MDUCT_BIN_DIR=$D/bin sh -c 'curl -fsSL https://raw.githubusercontent.com/TheFox666/mduct/main/install.sh | sh'
```

Then exercise **the specific thing the release claims**, against that binary,
with **both** `MDUCT_CONFIG` *and* `MDUCT_SOCKET` pointed at the temp dir.

> Without its own socket the running daemon answers with ITS config and the check
> proves nothing. This has produced a false "looks good" twice.

Finally align the local install so it matches what users get:

```sh
cp dist/mduct-linux-x64 ~/.local/bin/mduct.new && chmod +x ~/.local/bin/mduct.new
mv -f ~/.local/bin/mduct.new ~/.local/bin/mduct
sha256sum ~/.local/bin/mduct dist/mduct-linux-x64   # must match
```

`make install` rebuilds from source instead and produces a different hash — fine
day to day, wrong when you want to be sure the release works.

## Documentation ships with the release, not after it

The docs drift because "I'll write it up later" survives a release and nobody
notices until someone reads the wrong thing and believes it. So this is a step,
not a good intention: walk `git log --oneline vLAST..HEAD` and for every commit
that changed something a user can see, name the page it lands on. A commit with
no page is either not user-facing, or not finished.

**Three surfaces, three jobs. They are not copies of each other.**

| | Its job | Wrong when |
|---|---|---|
| `mduct help` | every command and flag, one screen | a flag exists and is not listed — `test/cliContract.test.ts` fails the build for exactly this |
| `README.md` | what mduct is, and why. **Stays short** | it starts explaining fields, states or edge cases. Cut that to one line and link the wiki |
| the wiki | the full reference, the recipes, the edges | it says something the code does not do |

The README is the page people skim once. Every paragraph added to it is a
paragraph nobody reads and everybody maintains — detail belongs in the wiki,
which is where someone goes when they actually need it.

**Which wiki page.** Separate repo, plain git, branch `master`:

```sh
git clone git@github.com:TheFox666/mduct.wiki.git   # gh is not involved
```

| Changed | Page |
|---|---|
| a command, a flag, an exit code | `Commands.md`, the reference — and check its opening list of commands that never autostart the daemon |
| a `servers.jsonc` field | `Configuration.md` |
| something worth pasting | `Cookbook.md` |
| a new way to be confused, or a new failure | `Troubleshooting.md` |
| stdout/stderr, arguments, output shape | `Arguments-and-output.md` |
| how an agent is wired | `Agent-integration.md` · `Shadowing.md` |

**Then check the docs against the binary, not against your memory.** Both of
these went wrong in one afternoon: a documented field table that was missing a
field, and a stated limitation that was wrong in half its cases.

```sh
# every documented field against what actually comes out — a field table drifts silently
mduct status --json | jq -r 'keys_unsorted[]'
mduct status --json | jq -r '.servers[0], .servers[0].auth | keys_unsorted[]'
```

Every example JSON block goes through `jq` before it is committed, and every
behavioural claim gets run once. "Documented, therefore true" is how a page
starts lying.

Anchors: keep wiki headings plain words (`### Machine-readable state` →
`#machine-readable-state`). Backticks or `·` in a heading make the slug
unguessable, and a dead in-page link looks perfectly fine in the editor. One
command to be sure, after pushing:

```sh
curl -s https://github.com/TheFox666/mduct/wiki/Commands | grep -o 'id="user-content-machine-readable-state"'
```

## Before you tag

- `bun test` and `bunx tsc --noEmit` green.
- The documentation step above done, and the wiki **pushed** — separate repo, so
  a clean working tree in this one proves nothing about it.
- Working tree clean, so the tag points at what you built.

## After publishing

- Install the published binary over the local one, so what you run is what users get.
