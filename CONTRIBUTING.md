# Contributing

One maintainer, two runtime dependencies, 234 tests. That shapes what is easy to
accept and what is not, so here is the honest version rather than the polite one.

## Before a big change, open an issue

Not a formality — I would rather say "no, and here is why" to a paragraph than to
an afternoon of your work. Small fixes can skip this and go straight to a PR.

## What gets rejected

These are the constraints the tool is built on. A change that crosses one is not
a matter of code review, it is a different tool:

- **Calls stay in the shell.** mduct can broker a server, catalogue it, nudge
  toward it — it must never execute a call through MCP and hand the result back
  into a model's context. The shell in the middle, where you can pipe and filter
  before anything becomes context, is most of the value.
- **No server becomes a dependency.** Anything mduct knows about a particular
  server lives in that server's config entry. Delete the entry, and the feature
  is inert. There is no `if (server === "gitlab")` anywhere and there should not
  be one.
- **New dependencies need an argument.** There are two, and the SDK is one of
  them. "It saves 20 lines" is not enough; a supply chain is not free.
- **Nothing self-updates, nothing phones home.** No telemetry, no update check,
  no network call the user did not ask for.

## The test rule

A change that can break carries a test that fails without it. Not "there are
tests" — *that* test, the one that goes red when you undo the change. The
cheapest way to check is to undo it and watch:

```sh
# make the change, write the test, then:
git stash -- src/ && bun test   # the new test must FAIL here
git stash pop && bun test       # and pass here
```

This catches the two things a green suite hides: a test that asserts the wrong
thing, and a test that would pass without the code. Both have happened in this
repo, which is why the rule exists.

Tests must not touch anything outside their own temp directory. `test/setup.ts`
is preloaded before every file and enforces it: `HOME` and the XDG variables
point at a throwaway directory, every inherited `MDUCT_*` is deleted, and the
files a test could plausibly clobber are fingerprinted, so a run that changes one
fails. `test/isolation.test.ts` asserts those properties; if you change how paths
resolve, that is the file that will tell you.

Set `MDUCT_CONFIG` and `MDUCT_SOCKET` anyway. The sandbox covers defaults, and a
test that names its own paths is easier to read than one that relies on them.

## The loop

```sh
bun install
bun test
bunx tsc --noEmit
bun run build && ./dist/mduct help
```

CI runs the same three plus all four compile targets. Nothing else is required
of you: no changelog entry, no sign-off, no squash policy.

## Comments

There is roughly one comment per eight lines, and they are not describing what
the code does — they say why it is that way, usually naming the failure that
shaped it. If your change has a reason that is not obvious from reading it,
write the reason down. If it is obvious, don't.

## What would actually help

- **A node port.** `Bun.listen`, `Bun.connect` and `Bun.serve` are the unix
  socket and the OAuth callback; replacing them with `net` and `http` is roughly
  150 lines and makes `npx mduct` possible without installing anything. It is the
  single change that would open the tool to the most people.
- **Windows**, which follows from the same work plus a named-pipe transport.
- **Bug reports with `mduct status` in them.** More useful than they sound: half
  of what looks like a bug is a second instance answering.

## Security

Please do not open a public issue for anything that touches credentials, the
guard, or the secret store. Mail the address on my GitHub profile instead.
