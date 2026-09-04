## Outcome

<!-- State the observable result, not only the files changed. -->

## Coordination record

- Implementation Issue: Closes #
- `claim_id`:
- Implementation `agent_id`:
- Claim confirmation URL:
- Confirmed `scope_revision`:
- Confirmed `write_scope`:
- Confirmed scope-change URL, if any: none

## Changes

-

## Deliberately unchanged

-

## Shared interfaces

<!-- List schemas, exports, rules formats, lockfiles, CI/release workflows, and cross-package contracts affected. Write "none" only after checking. -->

-

## Verification

| Check | Command or evidence URL | Result |
| --- | --- | --- |
| Tests |  |  |
| Type/lint/schema |  |  |
| Negative/failure path |  |  |
| Security/privacy |  |  |
| Clean worktree / generated files |  |  |

## Safety and rollback

- Production DSH/PM2 impact:
- Credential/session/storage exposure:
- Destructive or external actions:
- Rollback procedure:

## Review requirements

- [ ] The diff is within the confirmed Issue `write_scope`.
- [ ] No unrelated or unexplained changes are included.
- [ ] Acceptance criteria are mapped to verification evidence.
- [ ] Documentation and Changeset requirements are satisfied.
- [ ] Generated output and tracked files contain no real DSH/PM2 data, credentials, sessions, tokens, or unauthorized absolute paths.
- [ ] Required specification review is complete or marked not applicable with a reason.
- [ ] Required security/quality review is complete or marked not applicable with a reason.
- [ ] Self-review is not described as independent review.

## Handoff and residual work

- Remaining work:
- Follow-up Issues:
- Known risks or `unknown` evidence:
- Suggested next owner/reviewer:

> The Issue, claim event, and this PR are coordination and acceptance records. They do not constitute a file or branch lock.
