# G1 static and synthetic fixture evidence

状态：Issue #3 已实现，等待 PR 评审；G1 未验收。
Status: Issue #3 implemented, pending PR review; G1 is not accepted.

日期 / Date: 2026-09-07

## Scope and traceability

- Parent: [G1 #2](https://github.com/certainlyForgiveHer/dsh-compat-suite/issues/2)
- Implementation: [#3](https://github.com/certainlyForgiveHer/dsh-compat-suite/issues/3)
- Claim: `issue-3-20260907T014838Z-codex-g1-03`, scope revision `1`
- [Maintainer-authorized confirmation](https://github.com/certainlyForgiveHer/dsh-compat-suite/issues/3#issuecomment-5563872381)
- Base: `9935ed86f3186bc03f26fde1e2ea40e94472c7fa`
- Branch: `feat/3-collaboration-validation`
- Implementation agent: `codex-g1-03`

The maintainer explicitly authorized readiness and confirmation in the session.
The implementing agent recorded those events on the maintainer's behalf; this
does not constitute independent specification or security review.

## Reproduce

Run `pnpm install --frozen-lockfile --ignore-scripts`, then `pnpm verify`.
The new `pnpm verify:collaboration` runs the repository checks and all Node
tests in `tests/collaboration/verify-collaboration.test.mjs`.
It is inherited by existing CI through the root verification command.
No dependencies, lockfile, package exports, or workflow files changed.

| Evidence | Result |
| --- | --- |
| Initial test baseline before implementation | Failed with missing verifier module |
| Synthetic lifecycle, negative mutations, scope and PR assertions | Passed |
| Static repository and unsafe-material negative checks | Passed |
| G0 gate, workspace build, typecheck, three package smoke tests | Passed locally |
| Frozen dependency installation with lifecycle scripts disabled | Passed; initial offline attempt lacked cached package access |
| Diff whitespace and scope inspection | Passed |
| Independent specification/security review | Pending |

## Model and coverage

`fixtures/collaboration/lifecycle.json` is explicitly synthetic. The test file
derives independent negative cases by mutating that baseline, and constructs
release, blocked/recovery, abandonment, race rejection, audited expiry,
baseline drift, scope-change and handoff timelines. No real Issue free text is
parsed or executed. Every result reports `authorization: false`, including a
valid synthetic claimed state.

The record envelope contains unique event IDs and an initial state and final
label projection. It represents normalized fixture data, not the complete
wire format of GitHub comments. Readiness and abandonment use explicit
coordinator `decision` records because v1 lists no corresponding event names.
Amendments can append a clarification referencing an earlier event; they
cannot replace events or modify authority. Authority changes use the specific
scope, expiry or handoff events. History immutability cannot be established
from a single snapshot; duplicate IDs and explicit rewrite markers are rejected.

Path comparison uses exact files and directory component boundaries. Generated
outputs and semantic contracts must be named consistently in `shared_interfaces`;
matching declarations cause conflict even for disjoint source paths. The model
cannot infer an undeclared semantic dependency from source code. Ambiguous path
syntax, wildcards, absolute paths, traversal and missing scope are rejected.

PR fixtures bind Issue, claim ID, agent, revision, confirmation URL and scope;
they reject out-of-scope diffs, absent verification, missing declared reviews,
and author self-approval. Schema/core/rule paths also require specification and
security review, and release workflow paths require release review. Review
identities and evidence strings are synthetic assertions, not authenticated
GitHub reviews or independently verified test results.

Static checks cover protocol event names, required Issue Form field blocks,
duplicate field IDs, template fields, no-lock authority wording, suspicious
claim mechanism filenames, symlinks, and representative credential/runtime/
absolute-path patterns in fixture and evidence files. These checks are not a
general YAML parser, a full Markdown/Mermaid validator, a secret scanner, or a
semantic proof that arbitrary text is sanitized. Human inspection is retained.

## Review and remaining G1 acceptance

Self-review checked path component boundaries, claim/request binding, duplicate
confirmation failure, fixed-SHA handoff, scope revisions, deadline behavior,
PR review identity checks, and the absence of network/process execution in the
verifier. Installation and test execution occurred in the isolated worktree.

The parent G1 still requires the real controlled two-identity rehearsal,
non-overlapping worktree/PR integration, handoff recovery evidence, current
GitHub capability evidence, and coordinator acceptance. This static gate does
not parse live PR metadata or automatically enforce claims against contributors.
It does not establish a GitHub/file lock or complete G1.

Rollback: revert the isolated implementation commit through a reviewed PR.
The original checkout and production runtime are outside this change.
