import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createHostCorpus, createRulesProfile, RULES_LAYOUT } from './helpers/rules-profile.mjs';

const CORE_DIST = new URL('../dist/index.js', import.meta.url).href;

const {
  buildHostApiIndex,
  extractPluginApiUsage,
  evaluateApiSurface,
  DEFAULT_API_LIMITS,
} = await import(CORE_DIST);

const DTS_CORPUS = {
  '@deepseek-ai/dsh-subagent/index.d.ts': [
    'export interface SubagentsService {',
    '  registerSetup(options: RegisterSetupOptions): void;',
    '  listSessions(): readonly string[];',
    '}',
    'export declare function registerSetup(options: RegisterSetupOptions): void;',
  ].join('\n'),
};

// ------------------------------------------------------------------ index

test('buildHostApiIndex collects declared member and function names from declarations', () => {
  const corpus = createHostCorpus(DTS_CORPUS);
  try {
    const index = buildHostApiIndex([corpus.root]);
    assert.equal(index.filesScanned, 1);
    assert.equal(index.truncated, false);
    assert.equal(index.trusted, true);
    assert.ok(index.methods.has('registerSetup'));
    assert.ok(index.methods.has('listSessions'));
    assert.ok(!index.methods.has('registerContinuableSetup'), 'absent method must not be invented');
  } finally {
    corpus.cleanup();
  }
});

test('buildHostApiIndex skips minified files and marks the index untrusted', () => {
  const corpus = createHostCorpus({
    ...DTS_CORPUS,
    '@deepseek-ai/dsh-cli/dist/index.min.js': `!function(){const a="${'x'.repeat(2000)}";}();`,
  });
  try {
    const index = buildHostApiIndex([corpus.root]);
    assert.equal(index.skippedMinified, 1, 'a single very long line is treated as minified');
    assert.equal(index.trusted, false, 'an index with skipped files must not ground incompatible claims');
  } finally {
    corpus.cleanup();
  }
});

test('buildHostApiIndex stops at the file limit and reports truncation', () => {
  // All three files share one directory, so the per-entry limit check inside a
  // single readdir batch is exercised, not just the cross-directory path.
  const corpus = createHostCorpus({
    'flat/a.ts': 'export declare function alphaOne(): void;',
    'flat/b.ts': 'export declare function betaTwo(): void;',
    'flat/c.ts': 'export declare function gammaThree(): void;',
  });
  try {
    const index = buildHostApiIndex([corpus.root], { maxFiles: 1 });
    assert.equal(index.truncated, true);
    assert.ok(index.filesScanned <= 1);
    assert.equal(index.trusted, false);
  } finally {
    corpus.cleanup();
  }
});

test('byte limits stop the walk mid-directory as well', () => {
  const corpus = createHostCorpus({
    'flat/a.ts': 'export declare function alphaOne(): void;',
    'flat/b.ts': `export declare function betaTwo(): void; ${'x'.repeat(200)}`,
  });
  try {
    const index = buildHostApiIndex([corpus.root], { maxTotalBytes: 60 });
    assert.equal(index.truncated, true, 'total-byte stop marks truncation');
    assert.equal(index.trusted, false);
  } finally {
    corpus.cleanup();
  }
});

test('buildHostApiIndex never descends into nested node_modules or dot directories', () => {
  const corpus = createHostCorpus({
    '@deepseek-ai/dsh-a/index.d.ts': 'export declare function alphaOne(): void;',
    '@deepseek-ai/dsh-a/node_modules/transitive/index.js': 'module.exports.runAway = () => "do not scan";',
    '@deepseek-ai/dsh-a/.hidden/secret.js': 'module.exports.hidden = () => "do not scan";',
  });
  try {
    const index = buildHostApiIndex([corpus.root]);
    assert.equal(index.filesScanned, 1);
    assert.ok(!index.methods.has('runAway'));
    assert.ok(!index.methods.has('hidden'));
  } finally {
    corpus.cleanup();
  }
});

// ------------------------------------------------------------------- usage

test('extractPluginApiUsage finds static ctx service method calls', () => {
  const fixture = createRulesProfile([
    {
      name: 'plugin-a',
      version: '1.0.0',
      files: {
        'dist/index.js': [
          'export function activate(ctx) {',
          '  ctx.subagents.registerContinuableSetup({ id: "x" });',
          '  ctx.sessions.list(() => {});',
          '}',
        ].join('\n'),
      },
    },
  ]);
  try {
    const usage = extractPluginApiUsage([fixture.pluginDir('plugin-a')]);
    assert.equal(usage.references.length, 2);
    assert.deepEqual(
      usage.references.map((r) => `${r.service}.${r.method}`).sort(),
      ['sessions.list', 'subagents.registerContinuableSetup'],
    );
    assert.equal(usage.dynamicUsage, false);
  } finally {
    fixture.cleanup();
  }
});

test('extractPluginApiUsage flags computed member access as dynamic', () => {
  const fixture = createRulesProfile([
    {
      name: 'plugin-dyn',
      version: '1.0.0',
      files: { 'dist/index.js': 'const name = "subagents"; ctx[name].registerSetup(); ctx.sessions["list"]();' },
    },
  ]);
  try {
    const usage = extractPluginApiUsage([fixture.pluginDir('plugin-dyn')]);
    assert.equal(usage.dynamicUsage, true, 'computed access must not be judged statically');
  } finally {
    fixture.cleanup();
  }
});

test('extractPluginApiUsage respects the total byte limit and reports truncation', () => {
  const fixture = createRulesProfile([
    {
      name: 'plugin-big',
      version: '1.0.0',
      files: {
        'dist/a.js': `ctx.a.one(); ${'pad;'.repeat(200)}`,
        'dist/b.js': 'ctx.b.two();',
      },
    },
  ]);
  try {
    const usage = extractPluginApiUsage([fixture.pluginDir('plugin-big')], { maxTotalBytes: 50 });
    assert.equal(usage.truncated, true);
  } finally {
    fixture.cleanup();
  }
});


test('an oversized single file is skipped and marks the corpus untrusted', () => {
  const fixture = createRulesProfile([
    { name: 'plugin-huge', version: '1.0.0', files: { 'dist/heavy.js': `ctx.a.one(); ${'x'.repeat(600)}\nctx.a.two();` } },
  ]);
  try {
    const dir = fixture.pluginDir('plugin-huge');
    const index = buildHostApiIndex([dir], { maxFileBytes: 100 });
    assert.equal(index.truncated, true);
    assert.equal(index.trusted, false);
    assert.equal(index.filesScanned, 0, 'the oversized file must not enter the corpus');
  } finally {
    fixture.cleanup();
  }
});


test('a statizable but unreadable file leaves the corpus without accusing anyone', (t) => {
  if (process.platform === 'win32' || (process.getuid?.() ?? 1) === 0) {
    return t.skip('cannot enforce a POSIX permission denial on this platform/user');
  }
  const corpus = createHostCorpus({
    '@deepseek-ai/dsh-open/index.d.ts': 'export declare function openOne(): void;',
  });
  t.after(() => {
    fs.chmodSync(path.join(corpus.root, '@deepseek-ai', 'dsh-locked', 'locked.js'), 0o644);
    corpus.cleanup();
  });
  const lockedFile = path.join(corpus.root, '@deepseek-ai', 'dsh-locked', 'locked.js');
  fs.mkdirSync(path.dirname(lockedFile), { recursive: true });
  fs.writeFileSync(lockedFile, 'ctx.locked.one();');
  fs.chmodSync(lockedFile, 0o000);
  const index = buildHostApiIndex([corpus.root]);
  assert.ok(!index.methods.has('one'), 'unreadable content must not enter the corpus');
  assert.equal(index.trusted, false, 'content the scanner could not read leaves doubt');
  const usage = extractPluginApiUsage([corpus.root]);
  assert.ok(usage.references.every((ref) => ref.service !== 'locked'), 'usage extraction hits the same guard');
});

test('minified plugin files are skipped in the usage walk and reported', () => {
  const fixture = createRulesProfile([
    { name: 'plugin-min', version: '1.0.0', files: { 'dist/bundle.min.js': `!function(){ctx.a.one();${'x'.repeat(800)}}();` } },
  ]);
  try {
    const usage = extractPluginApiUsage([fixture.pluginDir('plugin-min')]);
    assert.equal(usage.skippedMinified, 1);
    assert.deepEqual(usage.references, [], 'minified code yields no claims');
  } finally {
    fixture.cleanup();
  }
});

test('an unreadable subtree is skipped without inventing API surface', (t) => {
  if (process.platform === 'win32' || (process.getuid?.() ?? 1) === 0) {
    return t.skip('cannot enforce a POSIX permission denial on this platform/user');
  }
  const corpus = createHostCorpus({
    '@deepseek-ai/dsh-open/index.d.ts': 'export declare function openOne(): void;',
  });
  t.after(() => {
    fs.chmodSync(path.join(corpus.root, 'lockeddir'), 0o755);
    corpus.cleanup();
  });
  const locked = path.join(corpus.root, 'lockeddir');
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, 'index.js'), 'ctx.locked.one();');
  fs.chmodSync(locked, 0o000);
  const usage = extractPluginApiUsage([corpus.root]);
  assert.ok(usage.references.every((ref) => ref.service !== 'locked'), 'unreadable trees must not contribute references');
});

test('DEFAULT_API_LIMITS bound resource use before any scan starts', () => {
  assert.ok(DEFAULT_API_LIMITS.maxFiles > 0);
  assert.ok(DEFAULT_API_LIMITS.maxFileBytes > 0);
  assert.ok(DEFAULT_API_LIMITS.maxTotalBytes > DEFAULT_API_LIMITS.maxFileBytes);
});

// --------------------------------------------------------------- evaluation

test('a referenced method absent from the host corpus is a missing host API', () => {
  const corpus = createHostCorpus(DTS_CORPUS);
  try {
    const index = buildHostApiIndex([corpus.root]);
    const usage = {
      references: [
        { service: 'subagents', method: 'registerContinuableSetup', file: 'dist/index.js' },
        { service: 'subagents', method: 'listSessions', file: 'dist/index.js' },
      ],
      dynamicUsage: false,
      filesScanned: 1,
      skippedMinified: 0,
      truncated: false,
    };
    const result = evaluateApiSurface(index, usage);
    assert.deepEqual(
      result.missing.map((m) => `${m.service}.${m.method}`),
      ['subagents.registerContinuableSetup'],
    );
    assert.equal(result.incomplete, false);
  } finally {
    corpus.cleanup();
  }
});

test('methods present in the corpus produce no claim in either direction', () => {
  const corpus = createHostCorpus(DTS_CORPUS);
  try {
    const index = buildHostApiIndex([corpus.root]);
    const usage = {
      references: [{ service: 'subagents', method: 'registerSetup', file: 'dist/index.js' }],
      dynamicUsage: false,
      filesScanned: 1,
      skippedMinified: 0,
      truncated: false,
    };
    const result = evaluateApiSurface(index, usage);
    assert.deepEqual(result.missing, [], 'presence is not compatibility; absence of finding only');
    assert.equal(result.incomplete, false);
  } finally {
    corpus.cleanup();
  }
});

test('an untrusted or absent index degrades to incomplete instead of claiming missing', () => {
  const usage = {
    references: [{ service: 'subagents', method: 'registerContinuableSetup', file: 'dist/index.js' }],
    dynamicUsage: false,
    filesScanned: 1,
    skippedMinified: 0,
    truncated: false,
  };
  const absent = evaluateApiSurface(null, usage);
  assert.deepEqual(absent.missing, []);
  assert.equal(absent.incomplete, true, 'no corpus means no verdict, never a missing claim');

  const corpus = createHostCorpus(DTS_CORPUS);
  try {
    const truncatedIndex = buildHostApiIndex([corpus.root], { maxFiles: 0 });
    const degraded = evaluateApiSurface(truncatedIndex, usage);
    assert.deepEqual(degraded.missing, []);
    assert.equal(degraded.incomplete, true);
  } finally {
    corpus.cleanup();
  }
});

test('dynamic usage is always incomplete regardless of the index', () => {
  const corpus = createHostCorpus(DTS_CORPUS);
  try {
    const index = buildHostApiIndex([corpus.root]);
    const usage = {
      references: [],
      dynamicUsage: true,
      filesScanned: 1,
      skippedMinified: 0,
      truncated: false,
    };
    const result = evaluateApiSurface(index, usage);
    assert.deepEqual(result.missing, []);
    assert.equal(result.incomplete, true);
  } finally {
    corpus.cleanup();
  }
});

test('no references produce no finding and no incompleteness', () => {
  const corpus = createHostCorpus(DTS_CORPUS);
  try {
    const index = buildHostApiIndex([corpus.root]);
    const result = evaluateApiSurface(index, {
      references: [],
      dynamicUsage: false,
      filesScanned: 0,
      skippedMinified: 0,
      truncated: false,
    });
    assert.deepEqual(result.missing, []);
    assert.equal(result.incomplete, false);
  } finally {
    corpus.cleanup();
  }
});

test('missing references are deduplicated and sorted for stable findings', () => {
  const corpus = createHostCorpus({
    '@deepseek-ai/dsh-core/index.d.ts': 'export interface CoreService {\n  keep(): void;\n}',
  });
  try {
    const index = buildHostApiIndex([corpus.root]);
    const usage = {
      references: [
        { service: 'b', method: 'missingTwo', file: 'b.js' },
        { service: 'a', method: 'missingOne', file: 'a.js' },
        { service: 'a', method: 'missingOne', file: 'a.js' },
      ],
      dynamicUsage: false,
      filesScanned: 3,
      skippedMinified: 0,
      truncated: false,
    };
    const result = evaluateApiSurface(index, usage);
    assert.deepEqual(result.missing.map((m) => `${m.service}.${m.method}`), ['a.missingOne', 'b.missingTwo']);
  } finally {
    corpus.cleanup();
  }
});
