/**
 * `scan` entry point: resolve the host, discover the profile inventory, and
 * assemble a report v1 document.
 *
 * Runs entirely out-of-process. It does not require a running dsh, does not
 * write to the profile, and makes no network request.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { buildReport, exitCodeFor, scanProfile } from './report.js';
import { resolveHost } from './host.js';
import type { HostIdentity, ProfileLayout, Report, RunMetadata } from './inventory-types.js';
import type { Policy } from './report.js';

const DOCTOR_VERSION = '0.0.0';

/** Fixed run metadata for deterministic output (golden diffs, tests). */
export const FIXED_RUN: RunMetadata = Object.freeze({
  id: '00000000-0000-4000-8000-000000000000',
  startedAt: '2026-01-01T00:00:00Z',
  mode: 'scan',
  doctorVersion: DOCTOR_VERSION,
});

export interface RunScanOptions {
  /** Absolute or relative path to the profile directory. */
  readonly profile: string;
  /**
   * Either host resolver options (a binary path) or an already resolved
   * identity. Injecting an identity keeps tests free of the local dsh install.
   */
  readonly host?: { readonly binary?: string } | HostIdentity;
  /** Explicit run metadata; when omitted a fresh id/timestamp is generated. */
  readonly run?: RunMetadata;
  readonly dshHome?: string;
  readonly tmpPaths?: readonly string[];
  readonly exposePaths?: boolean;
  readonly policy?: Policy;
  /** Override where profile artifacts are looked for (tests use synthetic fixtures). */
  readonly layout?: ProfileLayout;
}

export interface RunScanResult {
  readonly report: Report;
  readonly json: string;
  readonly exitCode: number;
  readonly policy: Policy;
}

function defaultDshHome(): string {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
}

function isResolvedHost(value: RunScanOptions['host']): value is HostIdentity {
  return typeof value === 'object' && value !== null && 'resolved' in value;
}

function makeRunMetadata(): RunMetadata {
  if (process.env.DSH_COMPAT_FIXED_RUN === '1') return FIXED_RUN;
  return {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    mode: 'scan',
    doctorVersion: DOCTOR_VERSION,
  };
}

export function runScan(options: RunScanOptions): RunScanResult {
  const policy: Policy = options.policy ?? 'advisory';
  const profilePath = path.resolve(options.profile);
  const dshHome = options.dshHome ?? defaultDshHome();

  const host: HostIdentity = isResolvedHost(options.host)
    ? options.host
    : resolveHost({ binary: options.host?.binary ?? 'dsh' });

  const scan = scanProfile(profilePath, {
    dshHome,
    tmpPaths: options.tmpPaths ?? [os.tmpdir()],
    exposePaths: options.exposePaths ?? false,
    ...(options.layout === undefined ? {} : { layout: options.layout }),
  });

  const run = options.run ?? makeRunMetadata();
  const built = buildReport({ scan, host, run });

  return {
    report: built.report,
    json: built.json,
    exitCode: exitCodeFor(built.report.summary.status, policy),
    policy,
  };
}

export { DOCTOR_VERSION };
