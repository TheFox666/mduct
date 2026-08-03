## What changes, and why

<!-- The reason, not the diff. If it is obvious from reading the change, one line. -->

## The test that fails without it

<!-- Name it. The check from CONTRIBUTING.md:
       git stash -- src/ && bun test   # the new test must FAIL here
       git stash pop  && bun test      # and pass here
     A change that cannot break does not need one — say that instead of leaving
     this empty. -->

## Checks

- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run build && ./dist/mduct help`
- [ ] A new or renamed command, flag or subcommand appears in `mduct help`

<!-- Not required: changelog entry, sign-off, squash.
     Worth two minutes before an afternoon of work:
     CONTRIBUTING.md → "What gets rejected" -->
