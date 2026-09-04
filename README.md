# dsh Compatibility Suite

[English](README.md) · [中文](README.zh-CN.md)

The dsh Compatibility Suite is a design and validation baseline for finding, explaining, and preventing compatibility failures between DeepSeek Harness (`dsh`) hosts and plugins.

## What it defines

The project has two planned user-facing surfaces:

- **`dsh-compat-doctor` CLI** — an out-of-process safety gate for pre-upgrade checks, environment inventory, candidate-version analysis, and isolated startup validation.
- **dsh Compatibility plugin** — a read-only UI for inspecting, explaining, and exporting scan results inside a healthy dsh host.

Both surfaces share the same scanning core and versioned report contract. The CLI must remain usable even when another plugin prevents the dsh host from starting.

## Safety boundaries

- Read-only by default.
- The MVP does not install, upgrade, downgrade, or remove plugins, restart the dsh host or service, or alter its process-supervisor configuration.
- Candidate packages are unpacked in temporary directories; lifecycle scripts are not executed.
- Real DSH profiles, credentials, sessions, process-supervisor state (including PM2 state where applicable), and unredacted logs are outside the repository and scan scope.
- Insufficient evidence produces `unknown`; startup validation does not claim that every plugin feature has passed.

## Project status

This repository currently contains the public design baseline and governance templates. Implementation packages and runtime fixtures are not included yet. Git is initialized, while the `G0` bootstrap and `G1` multi-agent readiness gates remain to be completed.

## Documentation

- [CLI design](docs/01-cli-design.md)
- [dsh plugin design](docs/02-plugin-design.md)
- [Milestones and dependencies](docs/03-milestones.md)
- [Validation and release acceptance](docs/04-validation-plan.md)
- [Git, versioning, and ecosystem release governance](docs/05-repository-governance.md)
- [Multi-agent collaboration protocol](docs/06-multi-agent-collaboration.md)
- [ADR-0001: GitHub Issues are a coordination ledger, not a lock](docs/adr/0001-issue-ledger-not-lock.md)
- [Agent instructions](AGENTS.md)

The detailed documents are the authoritative design baseline. Changes to compatibility boundaries, state semantics, exit codes, repository boundaries, version policy, collaboration rules, or acceptance criteria must update the relevant document and record the reason.
