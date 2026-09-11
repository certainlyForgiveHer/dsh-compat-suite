---
'@miguel_tu/core': patch
'@miguel_tu/doctor': patch
'@miguel_tu/plugin': patch
---

Add C1 environment discovery and the `scan` command.

`@miguel_tu/core` now resolves host identity out-of-process (dsh binary,
realpath, npm package root and version, `@deepseek-ai/dsh-*` core package
versions) and reconciles a profile's manifest, pnpm lock v9 and
node_modules actual versions. Identity defects are reported with the
registry codes `host-version-skew`, `host-identity-unresolved`,
`version-skew-manifest-lock`, `version-skew-lock-actual`,
`package-missing`, `ambiguous-resolution` and
`scan-infrastructure-error`. Discovery alone never yields a green state.

`@miguel_tu/doctor` gains `scan --json`, which emits a report v1 document
with paths aliased and secrets stripped. The command accepts
`--profile <name|path>`, `--dsh-bin`, `--dsh-home`, `--json`, `--strict`
and `--expose-paths`, exits on the frozen advisory/strict exit-code table,
and works with dsh stopped or absent (reporting `scan_error` rather than
failing).

`@miguel_tu/plugin` is unchanged in behaviour; it is versioned in lockstep
with the other packages.

Read-only by construction: no profile writes, no install, no restart, no
arbitrary shell execution and no network access.
