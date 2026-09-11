/**
 * Redaction and path aliasing for report output.
 *
 * Normative rules live in docs/07-m0-contract.md section 6: absolute user
 * paths are aliased to <dsh-home> / <profile> / <tmp>, and tokens, credentials,
 * ANSI escapes and bidirectional control characters must never appear in a
 * report or log line.
 *
 * The aliasing order is significant: the profile path is a child of the dsh
 * home, so it must be replaced first or it would be swallowed by the dsh home
 * alias.
 */

export interface RedactorInput {
  /** Absolute dsh home directory, e.g. /Users/me/.dsh */
  dshHome: string;
  /** Absolute profile directory, e.g. /Users/me/.dsh/profiles/web */
  profilePath: string;
  /** Temporary roots used by smoke runs, e.g. /var/folders/xx/T */
  tmpPaths: readonly string[];
  /** Escape hatch mirroring the CLI --expose-paths flag. Off by default. */
  exposePaths?: boolean;
}

export type Redactor = (value: string) => string;

const REDACTED = '<redacted>';

const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nqry=><]/g;
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/g;
const OTHER_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Bearer tokens, API keys and common provider key shapes. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9._-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** Query parameter names whose values must never survive into a report. */
const SENSITIVE_PARAM = /^(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|token|secret|password|passwd|pwd|credential|signature|sig|code|session|key)$/i;

/** Assignment shapes such as `access_token=zzz` outside a real URL. */
const SECRET_ASSIGNMENT = /([?&;,\s]|^)((?:access[_-]?token|api[_-]?key|apikey|auth|authorization|token|secret|password|passwd|pwd|credential|signature|sig|session|key))(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&;,"']+)/gi;

function scrubSecrets(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, REDACTED);

  // URL-shaped strings: drop sensitive query values via a real parser.
  output = output.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      let touched = false;
      for (const name of [...url.searchParams.keys()]) {
        if (SENSITIVE_PARAM.test(name)) {
          url.searchParams.set(name, REDACTED);
          touched = true;
        }
      }
      if (url.username || url.password) {
        url.username = '';
        url.password = '';
        touched = true;
      }
      return touched ? url.toString() : candidate;
    } catch {
      return candidate;
    }
  });

  // Non-URL assignments: `token=...`, `Authorization: ...`.
  output = output.replace(SECRET_ASSIGNMENT, (_match, lead: string, name: string, separator: string) => {
    return `${lead}${name}${separator}${REDACTED}`;
  });

  return output;
}

function stripControlCharacters(input: string): string {
  return input.replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(BIDI_CONTROLS, '').replace(OTHER_CONTROLS, '');
}

function normalizeAlias(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}

/**
 * Build a redactor for one scan run. Untrusted text (READMEs, error messages,
 * package comments) is data only: this function never executes or interprets it.
 */
export function createRedactor(input: RedactorInput): Redactor {
  const aliases: Array<[string, string]> = [];
  const profile = normalizeAlias(input.profilePath ?? '');
  const dshHome = normalizeAlias(input.dshHome ?? '');
  const tmpPaths = (input.tmpPaths ?? []).map(normalizeAlias).filter((p) => p.length > 1);

  if (profile.length > 1) aliases.push([profile, '<profile>']);
  if (dshHome.length > 1) aliases.push([dshHome, '<dsh-home>']);
  for (const tmp of tmpPaths) aliases.push([tmp, '<tmp>']);

  // Longest prefix first so /a/b/profile wins over /a/b.
  aliases.sort((a, b) => b[0].length - a[0].length);

  // Also alias any remaining absolute path under a home-like directory, so a
  // report never leaks a user directory tree even for paths outside the
  // configured roots. macOS uses /Users, Linux uses /home; CI runners use both.
  const homeLike = /\/(?:Users|home)\/[^/\s"']+/g;

  return (value: string): string => {
    if (typeof value !== 'string') return value;
    let output = stripControlCharacters(value);

    if (!input.exposePaths) {
      for (const [from, to] of aliases) {
        if (output.includes(from)) output = output.split(from).join(to);
      }
      output = output.replace(homeLike, '<dsh-home>');
    }

    return scrubSecrets(output);
  };
}
