# G0 Bootstrap Acceptance Record

状态：技术 bootstrap 验收通过；GitHub required-check/branch-protection 快照以远端设置记录为准。

验证日期：2026-09-04

## Identity and boundary decisions

- Canonical remote：`https://github.com/certainlyForgiveHer/dsh-compat-suite.git`
- Default branch：`main`
- Package scope：`@miguel_tu/*`
- npm scope evidence：维护者提供的 `npm whoami --registry=https://registry.npmjs.org/` 输出为 `miguel_tu`；仓库不保存 npm token、密码或配置文件。
- License：MIT；根 LICENSE 和三个 package metadata 均声明 `MIT`。
- Runtime boundary：G0 只创建空包骨架和静态验证入口，不读取或写入真实 DSH、进程管理器/服务监督器、凭据、会话或插件 storage。

## Local verification

| Check | Command | Result |
| --- | --- | --- |
| Repository gate | `pnpm run verify:g0` | pass |
| Frozen install | `pnpm install --frozen-lockfile --ignore-scripts --offline` | pass |
| Build | `pnpm run build` | pass |
| Typecheck | `pnpm run typecheck` | pass |
| Bootstrap tests | `pnpm run test` | pass; 3 package smoke tests |
| Combined gate | `pnpm run verify` | pass |
| Package metadata | `pnpm -r pack --dry-run` | pass; no workspace dependency or local path escaped |
| YAML syntax | Ruby YAML parser over `.github/**/*.yml` | pass |
| JSON syntax | Node JSON parser over manifests, schema and fixture lock | pass |
| Diff whitespace | `git diff --check` | pass |

## Implemented G0 surface

- Root private package, fixed pnpm version, workspace and single lockfile;
- `core`, `doctor`, and `plugin` package skeletons with lockstep `0.0.0` development versions;
- MIT, security, contribution, changelog, CODEOWNERS and repository hygiene files;
- PR, controlled-smoke preflight, nightly preflight and release preflight workflows;
- public Changesets lockstep configuration;
- fixture source-lock schema and empty initial source list;
- deterministic repository boundary and dependency-direction verifier at `scripts/verify-repository.mjs`.

## Remaining non-G0 work

G1 collaboration readiness, M0 contract freeze, implementation packages, runtime fixtures, real DSH smoke, release publishing, provenance/SBOM, and awesome-list submission remain out of scope for G0.
