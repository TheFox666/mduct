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

```sh
# 1. version, then the four targets + checksums
#    (dist/ is gitignored — the binaries only exist as release assets)
$EDITOR package.json                       # "version": "0.5.0"
bun run release
cd dist && for f in mduct-linux-x64 mduct-linux-arm64 mduct-darwin-x64 mduct-darwin-arm64; do
  sha256sum "$f" > "$f.sha256"
done && cd ..

# 2. commit, tag, push both
git commit -am "chore: bump version to 0.5.0"
git tag -a v0.5.0 -m "v0.5.0 — <the one-line reason>"
git push origin main && git push origin v0.5.0

# 3. publish with the notes from a file
gh release create v0.5.0 --title "v0.5.0 — <same one-liner>" --notes-file notes.md \
  dist/mduct-linux-x64{,.sha256} dist/mduct-linux-arm64{,.sha256} \
  dist/mduct-darwin-x64{,.sha256} dist/mduct-darwin-arm64{,.sha256}
```

## Homebrew tap

The formula points at release assets, so it can only be regenerated once the
release exists — after `gh release create`, never before:

```sh
bun run formula                    # reads the published .sha256 files, writes ~/dev/homebrew-tap
cd ~/dev/homebrew-tap && git commit -am "mduct 0.5.1" && git push
```

It fetches the checksums from GitHub rather than from `dist/`, so a formula can
never describe a build that was not published. Forgetting this step leaves
`brew install thefox666/tap/mduct` on the previous version, silently.

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

## Before you tag

- `bun test` and `bunx tsc --noEmit` green.
- Wiki updated for anything user-facing (it is a separate repo:
  `git@github.com:TheFox666/mduct.wiki.git`).
- README updated if a flag, command or config field changed.
- Working tree clean, so the tag points at what you built.

## After publishing

- `bun run formula`, then commit and push the tap.
- Install the published binary over the local one, so what you run is what users get.
