import test from 'node:test';
import assert from 'node:assert/strict';

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
  const corpus = createHostCorpus({
    '@deepseek-ai/dsh-a/index.d.ts': 'export declare function alphaOne(): void;',
    '@deepseek-ai/dsh-b/index.d.ts': 'export declare function betaTwo(): void;',
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
        { service: 'sessions', method: 'list', file: 'dist/index.js' },
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
