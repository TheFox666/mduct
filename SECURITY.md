# Security

## Reporting

Do not open a public issue for anything that touches credentials, the guard, or
the secret store.

Use [private vulnerability reporting](https://github.com/TheFox666/mduct/security/advisories/new),
or mail the address on my GitHub profile. Both reach only me.

This is a one-maintainer project. I will confirm that I read your report, and I
will tell you what I intend to do about it and roughly when. I am not going to
promise a response time I cannot keep.

## Supported versions

The latest release. While the project is 0.x there are no backports — a fix
ships in the next version, and the advisory says which one.

## What is in scope

mduct holds live MCP connections, OAuth sessions and a secret store, and it
decides which tool calls are allowed to run. Things worth reporting:

- A guard or shadow rule that can be bypassed, or a `block: true` rule that lets
  a call through.
- A secret reaching somewhere it should not — a log line, an error message, a
  tool argument, the index block, the catalogue.
- The daemon socket accepting instructions it should not, or an instance reading
  another instance's config, secrets or auth.
- An OAuth token that survives `secret rm`, `--remove` or a profile switch.
- A crafted server response that makes mduct write outside its own config,
  cache or socket paths.

## What is not

The daemon runs as you, with your privileges, and holds what you configured it
to hold. Anyone who already has your shell has your secrets with or without
mduct. So these are the design, not a vulnerability:

- Reading the socket, config or cache as the same user.
- A configured server being able to do what its own credentials allow.
- `mduct call` running a tool you allowed to run.

The threat model is the model, not the user. Guards exist because an agent
should not be able to reach past them, and they live in the daemon for exactly
that reason — a guard the model could reach would not be a guard. Reports about
that boundary are welcome; reports that assume an attacker already has your user
account are not a vulnerability in mduct.
