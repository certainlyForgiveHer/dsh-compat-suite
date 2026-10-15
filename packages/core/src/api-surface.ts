/**
 * API surface checking (docs/01 section 9).
 *
 * Purpose: catch the "installs fine, semver looks right, but the plugin calls
 * a host method that does not exist" failure — the AgentTeams
 * `ctx.subagents.registerContinuableSetup` incident.
 *
 * Method (docs/01 section 9.2):
 * 1. build a host index from the installed host packages' runtime code and
 *    declarations — the set of method names the host actually declares;
 * 2. extract static `ctx.<service>.<method>(...)` references from the plugin's
 *    distributed JS, plus a dynamic-usage signal for computed access;
 * 3. a referenced method absent from the corpus is `missing-host-api` —
 *    incompatible evidence; a method found in the corpus proves nothing in
 *    either direction ("未发现缺失方法不能反向证明兼容");
 * 4. an absent/untrusted corpus or dynamic usage degrades to
 *    `analysis-incomplete` — unknown, never a verdict.
 *
 * Static only: nothing is executed, no AST plugin runs, and every walk is
 * bounded (file count, per-file bytes, total bytes) so a hostile package
 * cannot exhaust the scanner. Minified files are skipped and reported, because
 * renaming destroys the signal this check relies on.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ApiScanLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_API_LIMITS: ApiScanLimits = Object.freeze({
  maxFiles: 2000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

export interface HostApiIndex {
  /** Every method name declared anywhere in the scanned corpus. */
  readonly methods: ReadonlySet<string>;
  readonly filesScanned: number;
  readonly skippedMinified: number;
  /** Files that existed but could not be read (permission, vanished mid-walk). */
  readonly unreadable: number;
  readonly truncated: boolean;
  /**
   * Whether the index may ground a `missing-host-api` claim. An index that hit
   * a limit, skipped minified files or could not read a file cannot prove
   * absence of an API.
   */
  readonly trusted: boolean;
}

export interface ApiReference {
  readonly service: string;
  readonly method: string;
  readonly file: string;
}

export interface PluginApiUsage {
  readonly references: readonly ApiReference[];
  readonly dynamicUsage: boolean;
  readonly filesScanned: number;
  readonly skippedMinified: number;
  readonly unreadable: number;
  readonly truncated: boolean;
}

export interface ApiSurfaceEvaluation {
  /** Referenced methods absent from a trusted corpus, deduplicated and sorted. */
  readonly missing: readonly ApiReference[];
  readonly incomplete: boolean;
}

const SCAN_SUFFIXES = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

/** A single line this long is treated as minified output, not reviewable source. */
const MINIFIED_LINE_THRESHOLD = 500;

function resolveLimits(limits?: Partial<ApiScanLimits>): ApiScanLimits {
  return { ...DEFAULT_API_LIMITS, ...limits };
}

function isSourceFile(entry: fs.Dirent): boolean {
  return entry.isFile() && SCAN_SUFFIXES.has(path.extname(entry.name));
}

function looksMinified(content: string): boolean {
  return content.split('\n').some((line) => line.length > MINIFIED_LINE_THRESHOLD);
}

/**
 * Depth-first collection of source files under `root`, skipping nested
 * `node_modules`, dot directories and `dist` siblings of the scanner itself.
 * Returns files plus whether any of the three limits ended the walk early.
 */
function collectSourceFiles(
  root: string,
  limits: ApiScanLimits,
): { files: string[]; truncated: boolean; totalBytes: number } {
  const files: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  const stack: string[] = [root];
  while (stack.length > 0) {
    if (files.length >= limits.maxFiles || totalBytes >= limits.maxTotalBytes) {
      truncated = true;
      break;
    }
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // unreadable subtree: absent from the corpus, never invented
    }
    for (const entry of entries) {
      if (files.length >= limits.maxFiles || totalBytes >= limits.maxTotalBytes) {
        truncated = true;
        break;
      }
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!isSourceFile(entry)) continue;
      let size = 0;
      try {
        size = fs.statSync(entryPath).size;
      } catch {
        continue;
      }
      if (size > limits.maxFileBytes) {
        truncated = true;
        continue;
      }
      if (totalBytes + size > limits.maxTotalBytes) {
        truncated = true;
        continue;
      }
      totalBytes += size;
      files.push(entryPath);
    }
  }
  return { files, truncated, totalBytes };
}

/**
 * Declaration-shaped identifiers: interface/object members and standalone
 * functions. Over-approximation is safe — a larger index can only produce
 * fewer `missing` claims, never more.
 */
const DECLARATION_PATTERNS = [
  /^[ \t]*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:readonly\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/,
  /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
];

function methodNamesIn(content: string): string[] {
  const names: string[] = [];
  for (const line of content.split('\n')) {
    for (const pattern of DECLARATION_PATTERNS) {
      const match = pattern.exec(line);
      if (match !== null && match[1] !== 'if' && match[1] !== 'for' && match[1] !== 'while' && match[1] !== 'switch' && match[1] !== 'catch' && match[1] !== 'function') {
        names.push(match[1]);
        break;
      }
    }
  }
  return names;
}

/** Build the host API index from one or more installed package directories. */
export function buildHostApiIndex(
  directories: readonly string[],
  limits?: Partial<ApiScanLimits>,
): HostApiIndex {
  const resolved = resolveLimits(limits);
  const methods = new Set<string>();
  let filesScanned = 0;
  let skippedMinified = 0;
  let unreadable = 0;
  let truncated = false;

  for (const directory of directories) {
    const collected = collectSourceFiles(directory, resolved);
    truncated = truncated || collected.truncated;
    for (const file of collected.files) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        unreadable += 1;
        continue;
      }
      if (looksMinified(content)) {
        skippedMinified += 1;
        continue;
      }
      filesScanned += 1;
      for (const name of methodNamesIn(content)) methods.add(name);
    }
  }

  return {
    methods,
    filesScanned,
    skippedMinified,
    unreadable,
    truncated,
    trusted: !truncated && skippedMinified === 0 && unreadable === 0,
  };
}

const STATIC_CALL = /\bctx\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
const DYNAMIC_ACCESS = /\bctx\s*\[|\bctx\.[\w$]+\s*\[/;

/** Extract the plugin's static host API references from its distributed code. */
export function extractPluginApiUsage(
  directories: readonly string[],
  limits?: Partial<ApiScanLimits>,
): PluginApiUsage {
  const resolved = resolveLimits(limits);
  const references: ApiReference[] = [];
  const seen = new Set<string>();
  let dynamicUsage = false;
  let filesScanned = 0;
  let skippedMinified = 0;
  let unreadable = 0;
  let truncated = false;

  for (const directory of directories) {
    const collected = collectSourceFiles(directory, resolved);
    truncated = truncated || collected.truncated;
    for (const file of collected.files) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        unreadable += 1;
        continue;
      }
      if (looksMinified(content)) {
        skippedMinified += 1;
        continue;
      }
      filesScanned += 1;
      if (DYNAMIC_ACCESS.test(content)) dynamicUsage = true;

      for (const match of content.matchAll(STATIC_CALL)) {
        const key = `${match[1]}.${match[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        references.push({ service: match[1], method: match[2], file: path.basename(file) });
      }
    }
  }

  references.sort((left, right) =>
    left.service === right.service
      ? left.method.localeCompare(right.method)
      : left.service.localeCompare(right.service),
  );
  return { references, dynamicUsage, filesScanned, skippedMinified, unreadable, truncated };
}

/**
 * Judge plugin usage against a host index. Absence of findings is not
 * compatibility; the only definite claim here is a missing method on a
 * trusted corpus, which the caller grades as `missing-host-api`.
 */
export function evaluateApiSurface(index: HostApiIndex | null, usage: PluginApiUsage): ApiSurfaceEvaluation {
  if (usage.dynamicUsage) return { missing: [], incomplete: true };
  if (usage.references.length === 0) return { missing: [], incomplete: false };
  if (index === null || !index.trusted) return { missing: [], incomplete: true };

  const missing: ApiReference[] = [];
  const seen = new Set<string>();
  for (const reference of usage.references) {
    const key = `${reference.service}.${reference.method}`;
    if (seen.has(key)) continue;
    if (index.methods.has(reference.method)) continue;
    seen.add(key);
    missing.push(reference);
  }
  missing.sort((left, right) =>
    left.service === right.service
      ? left.method.localeCompare(right.method)
      : left.service.localeCompare(right.service),
  );
  return { missing, incomplete: false };
}
