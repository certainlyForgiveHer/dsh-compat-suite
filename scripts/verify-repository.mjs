import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedRemote = 'https://github.com/certainlyForgiveHer/dsh-compat-suite.git';
const expectedScope = '@miguel_tu/';
const packageDirs = ['core', 'cli', 'dsh-plugin'];
const failures = [];

const fail = (message) => failures.push(message);
const rel = (filePath) => path.relative(root, filePath) || '.';

async function readText(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function readJson(relativePath) {
  try {
    return JSON.parse(await readText(relativePath));
  } catch (error) {
    fail(`${relativePath}: invalid JSON (${error.message})`);
    return null;
  }
}

async function walk(relativeDir, predicate, results = []) {
  const absoluteDir = path.join(root, relativeDir);
  if (!existsSync(absoluteDir)) return results;
  for (const entry of await readdir(absoluteDir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      await walk(relativePath, predicate, results);
    } else if (predicate(relativePath)) {
      results.push(relativePath);
    }
  }
  return results;
}

const requiredPaths = [
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  '.gitattributes',
  'LICENSE',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  '.github/CODEOWNERS',
  '.github/ISSUE_TEMPLATE/implementation.yml',
  '.github/pull_request_template.md',
  '.github/workflows/pr.yml',
  '.github/workflows/controlled-smoke.yml',
  '.github/workflows/nightly.yml',
  '.github/workflows/release.yml',
  '.changeset/config.json',
  '.changeset/README.md',
  'schemas/fixture-source-lock.schema.json',
  'fixtures/sources.lock.json',
  'scripts/verify-repository.mjs'
];

for (const requiredPath of requiredPaths) {
  if (!existsSync(path.join(root, requiredPath))) fail(`missing required path: ${requiredPath}`);
}

const rootPackage = await readJson('package.json');
if (rootPackage) {
  if (rootPackage.private !== true) fail('root package.json must be private');
  if (rootPackage.packageManager !== 'pnpm@11.21.0') fail('root package.json must pin pnpm@11.21.0');
  if (rootPackage.license !== 'MIT') fail('root package.json must declare MIT');
  for (const script of ['build', 'typecheck', 'test', 'verify:g0', 'verify', 'changeset', 'version-packages']) {
    if (typeof rootPackage.scripts?.[script] !== 'string') fail(`root package.json missing script: ${script}`);
  }
}

const workspace = await readText('pnpm-workspace.yaml').catch(() => '');
if (!/packages:\s*\n\s*-\s+packages\/\*/m.test(workspace)) {
  fail('pnpm-workspace.yaml must include packages/*');
}

const packageMetadata = {};
for (const packageDir of packageDirs) {
  const relativePath = `packages/${packageDir}/package.json`;
  const metadata = await readJson(relativePath);
  if (!metadata) continue;
  packageMetadata[packageDir] = metadata;
  const expectedName = `${expectedScope}${packageDir === 'cli' ? 'doctor' : packageDir === 'dsh-plugin' ? 'plugin' : 'core'}`;
  if (metadata.name !== expectedName) fail(`${relativePath} must use ${expectedName}`);
  if (metadata.version !== '0.0.0') fail(`${relativePath} must remain an unreleased 0.0.0 scaffold`);
  if (metadata.license !== 'MIT') fail(`${relativePath} must declare MIT`);
  if (metadata.repository?.url !== `git+${expectedRemote}`) fail(`${relativePath} has the wrong repository URL`);
  if (metadata.repository?.directory !== `packages/${packageDir}`) fail(`${relativePath} has the wrong repository directory`);
  if (metadata.publishConfig?.access !== 'public') fail(`${relativePath} must set public publish access`);
  for (const script of ['build', 'typecheck', 'test']) {
    if (typeof metadata.scripts?.[script] !== 'string') fail(`${relativePath} missing script: ${script}`);
  }
  for (const requiredPath of [`packages/${packageDir}/tsconfig.json`, `packages/${packageDir}/src/index.ts`, `packages/${packageDir}/test/smoke.test.mjs`]) {
    if (!existsSync(path.join(root, requiredPath))) fail(`missing package scaffold path: ${requiredPath}`);
  }
}

if (packageMetadata.core && Object.keys(packageMetadata.core.dependencies ?? {}).length > 0) {
  fail('core must not depend on another workspace package');
}
for (const packageDir of ['cli', 'dsh-plugin']) {
  const metadata = packageMetadata[packageDir];
  if (metadata?.dependencies?.[`${expectedScope}core`] !== 'workspace:*') {
    fail(`${packageDir} must depend on ${expectedScope}core through workspace:*`);
  }
}

const lockfiles = await walk('.', (filePath) => /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(filePath));
if (lockfiles.length !== 1 || lockfiles[0] !== 'pnpm-lock.yaml') {
  fail(`expected only root pnpm-lock.yaml, found: ${lockfiles.join(', ') || 'none'}`);
}

const nestedGit = await walk('.', (filePath) => filePath.endsWith('/.git') || filePath === '.git');
if (nestedGit.some((filePath) => filePath !== '.git')) fail(`nested Git metadata found: ${nestedGit.join(', ')}`);

const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
if (remote.status !== 0 || remote.stdout.trim() !== expectedRemote) {
  fail(`origin must be ${expectedRemote}, got ${remote.stdout.trim() || remote.stderr.trim() || 'unavailable'}`);
}

const changesetConfig = await readJson('.changeset/config.json');
if (changesetConfig) {
  const fixedPackages = changesetConfig.fixed?.[0] ?? [];
  for (const packageName of [`${expectedScope}core`, `${expectedScope}doctor`, `${expectedScope}plugin`]) {
    if (!fixedPackages.includes(packageName)) fail(`Changesets fixed group missing ${packageName}`);
  }
  if (changesetConfig.access !== 'public' || changesetConfig.baseBranch !== 'main') {
    fail('Changesets must use public access and main as base branch');
  }
}

const fixtureLock = await readJson('fixtures/sources.lock.json');
if (fixtureLock && (fixtureLock.schemaVersion !== 1 || !Array.isArray(fixtureLock.sources))) {
  fail('fixtures/sources.lock.json must start at schemaVersion 1 with a sources array');
}

const workflowPaths = ['.github/workflows/pr.yml', '.github/workflows/controlled-smoke.yml', '.github/workflows/nightly.yml', '.github/workflows/release.yml'];
for (const workflowPath of workflowPaths) {
  const workflow = await readText(workflowPath).catch(() => '');
  if (!workflow.includes('permissions:\n  contents: read')) fail(`${workflowPath} must use read-only contents permissions`);
  if (workflow.includes('npm publish')) fail(`${workflowPath} must not publish npm packages during G0`);
}
const prWorkflow = await readText('.github/workflows/pr.yml').catch(() => '');
if (!prWorkflow.includes('pull_request') || !prWorkflow.includes('pnpm install --frozen-lockfile')) {
  fail('PR workflow must run on pull_request with frozen installation');
}

const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
if (tracked.status === 0) {
  const trackedPaths = tracked.stdout.split('\0').filter(Boolean);
  const forbiddenPath = trackedPaths.find((filePath) => /(?:^|\/)(?:node_modules|\.pm2|DSH_HOME)(?:\/|$)/i.test(filePath));
  if (forbiddenPath) fail(`forbidden runtime data path is tracked: ${forbiddenPath}`);
  const secretPattern = /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA|OPENSSH|EC|DSA|PRIVATE) KEY-----|AKIA[0-9A-Z]{16})/;
  for (const trackedPath of trackedPaths) {
    const content = await readText(trackedPath).catch(() => '');
    if (secretPattern.test(content)) fail(`possible credential material in tracked file: ${trackedPath}`);
  }
}

if (failures.length > 0) {
  console.error('G0 repository verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('G0 repository verification passed.');
  console.log(`- root: ${rel(root)}`);
  console.log(`- npm scope: ${expectedScope}`);
  console.log('- packages: core, doctor, plugin');
  console.log('- workflows: PR, controlled-smoke preflight, nightly preflight, release preflight');
  console.log('- lockfiles: root pnpm-lock.yaml only');
}
