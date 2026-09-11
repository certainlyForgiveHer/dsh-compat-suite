#!/usr/bin/env node
/**
 * dsh-compat-doctor — out-of-process compatibility checks for dsh hosts.
 *
 * C1 implements `scan` only: environment discovery plus a report v1 document.
 * `check-update`, `smoke` and `explain` belong to C3/C4/C5.
 *
 * Exit codes are the frozen table in docs/07-m0-contract.md section 3:
 * 0 ok (advisory), 1 incompatible, 2 degraded/unknown under strict,
 * 3 input/profile/report contract error, 4 scan_error, 5 smoke indeterminate,
 * 70 internal error.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { PACKAGE_NAME as CORE_PACKAGE_NAME, runScan } from '@miguel_tu/core';

export const PACKAGE_NAME = '@miguel_tu/doctor' as const;
export const PACKAGE_VERSION = '0.0.0' as const;
export const CORE_DEPENDENCY = CORE_PACKAGE_NAME;

const EXIT_CONTRACT_ERROR = 3;
const EXIT_INTERNAL_ERROR = 70;

interface ScanCliOptions {
  readonly profile: string;
  readonly binary: string;
  readonly dshHome: string | undefined;
  readonly json: boolean;
  readonly strict: boolean;
  readonly exposePaths: boolean;
}

const USAGE = `dsh-compat-doctor ${PACKAGE_VERSION}

Usage:
  dsh-compat-doctor scan [--profile <name|path>] [--json] [--strict] [--dsh-bin <path>] [--dsh-home <path>]

Options:
  --profile <name|path>  Profile name under <dsh-home>/profiles, or a profile
                         directory path. Defaults to the "web" profile.
  --dsh-bin <path>       dsh executable to resolve. Defaults to "dsh" on PATH.
  --dsh-home <path>      dsh home directory. Defaults to $DSH_HOME or ~/.dsh.
  --json                 Emit the report v1 document on stdout.
  --strict               Use strict exit codes (degraded and unknown become 2).
  --expose-paths         Do not alias absolute user paths (unsafe; local debugging only).
  -h, --help             Show this help.
`;

const SAFE_PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;

function parseScanArgs(argv: readonly string[]): ScanCliOptions | { readonly error: string } {
  let profile: string | undefined;
  let binary = 'dsh';
  let dshHome = process.env.DSH_HOME;
  let json = false;
  let strict = false;
  let exposePaths = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--profile':
      case '--dsh-bin':
      case '--dsh-home': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) return { error: `${arg} requires a value` };
        if (arg === '--profile') profile = value;
        else if (arg === '--dsh-bin') binary = value;
        else dshHome = value;
        index += 1;
        break;
      }
      case '--json':
        json = true;
        break;
      case '--strict':
        strict = true;
        break;
      case '--expose-paths':
        exposePaths = true;
        break;
      default:
        return { error: `unknown argument: ${arg}` };
    }
  }

  // Accept either a directory path or a bare profile name resolved under the
  // dsh home, matching the documented `--profile web` form.
  let resolvedProfile = profile;
  if (resolvedProfile !== undefined && !resolvedProfile.includes('/') && !resolvedProfile.includes(path.sep)) {
    if (!SAFE_PROFILE_NAME.test(resolvedProfile)) {
      return { error: `profile name must match ${SAFE_PROFILE_NAME.source}` };
    }
    if (dshHome === undefined) {
      return { error: 'profile name given but --dsh-home is not set and DSH_HOME is empty' };
    }
    resolvedProfile = path.join(dshHome, 'profiles', resolvedProfile);
  }
  if (resolvedProfile === undefined) {
    if (dshHome === undefined) {
      return { error: 'no profile given and no dsh home known; pass --profile or --dsh-home' };
    }
    resolvedProfile = path.join(dshHome, 'profiles', 'web');
  }

  return { profile: resolvedProfile, binary, dshHome, json, strict, exposePaths };
}

function renderSummary(jsonOutput: string, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${jsonOutput}\n`);
    return;
  }
  const report = JSON.parse(jsonOutput) as {
    summary: { status: string; blocking: number; review: number };
    profile: { name: string };
    plugins: readonly { name: string; status: string }[];
  };
  const lines = [
    `dsh-compat-doctor scan — profile ${report.profile.name}`,
    `status: ${report.summary.status}  blocking: ${report.summary.blocking}  review: ${report.summary.review}`,
  ];
  for (const plugin of report.plugins) lines.push(`  - ${plugin.name}: ${plugin.status}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const [command, ...rest] = argv;

  if (command === undefined || command === '-h' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command !== 'scan') {
    process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
    return EXIT_CONTRACT_ERROR;
  }

  const parsed = parseScanArgs(rest);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return EXIT_CONTRACT_ERROR;
  }

  if (!existsSync(parsed.profile)) {
    process.stderr.write(`profile directory does not exist: ${parsed.profile}\n`);
    return EXIT_CONTRACT_ERROR;
  }

  try {
    const result = runScan({
      profile: parsed.profile,
      host: { binary: parsed.binary },
      policy: parsed.strict ? 'strict' : 'advisory',
      exposePaths: parsed.exposePaths,
      ...(parsed.dshHome === undefined ? {} : { dshHome: parsed.dshHome }),
    });
    renderSummary(result.json, parsed.json);
    return result.exitCode;
  } catch (error) {
    process.stderr.write(`internal error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_INTERNAL_ERROR;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  process.exitCode = main();
}
