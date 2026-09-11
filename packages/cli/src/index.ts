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

import { PACKAGE_NAME as CORE_PACKAGE_NAME, runScan } from '@miguel_tu/core';

export const PACKAGE_NAME = '@miguel_tu/doctor' as const;
export const PACKAGE_VERSION = '0.0.0' as const;
export const CORE_DEPENDENCY = CORE_PACKAGE_NAME;

const EXIT_CONTRACT_ERROR = 3;
const EXIT_INTERNAL_ERROR = 70;

interface ScanCliOptions {
  readonly profile: string;
  readonly binary: string;
  readonly json: boolean;
  readonly strict: boolean;
  readonly exposePaths: boolean;
}

const USAGE = `dsh-compat-doctor ${PACKAGE_VERSION}

Usage:
  dsh-compat-doctor scan [--profile <path>] [--json] [--strict] [--dsh <binary>] [--expose-paths]

Options:
  --profile <path>   Profile directory to scan. Defaults to $DSH_HOME/profiles/web.
  --dsh <binary>     dsh executable to resolve. Defaults to "dsh" on PATH.
  --json             Emit the report v1 document on stdout.
  --strict           Use strict exit codes (degraded and unknown become 2).
  --expose-paths     Do not alias absolute user paths (unsafe; for local debugging).
  -h, --help         Show this help.
`;

function parseScanArgs(argv: readonly string[]): ScanCliOptions | { readonly error: string } {
  let profile: string | undefined;
  let binary = 'dsh';
  let json = false;
  let strict = false;
  let exposePaths = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--profile':
      case '--dsh': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) return { error: `${arg} requires a value` };
        if (arg === '--profile') profile = value;
        else binary = value;
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

  const dshHome = process.env.DSH_HOME;
  const resolvedProfile = profile ?? (dshHome === undefined ? undefined : `${dshHome}/profiles/web`);
  if (resolvedProfile === undefined) {
    return { error: 'no profile given and DSH_HOME is not set; pass --profile <path>' };
  }

  return { profile: resolvedProfile, binary, json, strict, exposePaths };
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
      ...(process.env.DSH_HOME === undefined ? {} : { dshHome: process.env.DSH_HOME }),
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
