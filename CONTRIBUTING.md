# Contributing

## Before changing files

Read [`AGENTS.md`](AGENTS.md), the collaboration protocol, and the relevant
design document. Normal implementation work requires a `status:ready` Issue,
a confirmed claim, an exact write scope, and an isolated branch/worktree. G0
bootstrap work may use the documented maintainer-directed bootstrap exception.

## Local checks

Use the pinned package manager and install from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Do not run checks against a real DSH profile, real process-manager state,
credentials, sessions, plugin storage, or unredacted logs. Use synthetic or
disposable fixtures.

## Commits and pull requests

Every commit message must include a machine-readable `Agent-ID: <agent_id>`
trailer. Pull requests must use the repository template, identify their
implementation Issue and claim, describe deliberately unchanged areas, and
map acceptance criteria to verification evidence.

The project uses MIT licensing. New dependencies, third-party fixtures, public
package metadata, schema changes, and release workflow changes require the
corresponding design and security review.
