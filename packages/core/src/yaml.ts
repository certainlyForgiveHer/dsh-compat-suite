/**
 * Minimal YAML subset parser for the files this suite reads:
 * `pnpm-lock.yaml` (v9), profile `package.json` companions and
 * `cordis.patch.yml`.
 *
 * Deliberately dependency-free and strict: it supports the block/flow shapes
 * those files use and *rejects* malformed input rather than guessing. A
 * corrupted lockfile must surface as a scan error (docs/07 finding code
 * `scan-infrastructure-error`), never as a silently wrong inventory, so
 * leniency here would be a correctness bug.
 *
 * Supported: block mappings and sequences, nested indentation, flow mappings
 * `{a: b}`, flow sequences `[a, b]`, single/double quoted scalars, block
 * scalars (`|` and `>`, with chomping and explicit indentation), comments,
 * `null`/`~`, booleans, integers, floats and empty values.
 *
 * Not supported (rejected): tabs for indentation, duplicate keys in one block,
 * keys with neither a value nor a nested block, unterminated quotes or flow
 * collections, anchors, aliases and multi-document streams. A tag such as
 * `!!js` is never evaluated: it stays part of the scalar text, so a patch file
 * carrying an expression is read as data and the expression is never run.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export class YamlParseError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} (line ${line + 1})`);
    this.name = 'YamlParseError';
    this.line = line;
  }
}

interface Line {
  readonly indent: number;
  readonly content: string;
  readonly number: number;
}

const FLOW_START = /^[{[]/;

function stripComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === '#' && !inSingle && !inDouble) {
      if (index === 0 || /\s/.test(text[index - 1])) return text.slice(0, index);
    }
  }
  return text;
}

/**
 * Block scalar header: `|` or `>` optionally followed by a chomping indicator
 * and/or an explicit indentation digit (`|`, `|-`, `|+`, `|2`, `>-2`).
 *
 * Every shipped `cordis.patch.yml` uses one of these for its multi-line
 * configuration values, so a reader that rejected them could not read a real
 * patch file at all.
 */
const BLOCK_HEADER = /(^|\s)([|>])([+-]?)(\d?)$/;

/** Whether a candidate header prefix leaves a quote open (so it is not a header). */
function hasUnbalancedQuote(text: string): boolean {
  let single = 0;
  let double = 0;
  for (const char of text) {
    if (char === "'") single += 1;
    else if (char === '"') double += 1;
  }
  return single % 2 === 1 || double % 2 === 1;
}

/**
 * Fold a `>` block scalar's content lines.
 *
 * A single break between two plain lines folds into a space, a blank line
 * becomes a line break, and a more-indented line keeps its own break — the
 * folding rules the shipped patch files rely on.
 */
function foldBlockLines(lines: readonly string[]): string {
  let out = '';
  let pendingBreaks = 0;
  let started = false;
  let previousIndented = false;
  for (const line of lines) {
    if (line === '') {
      pendingBreaks += 1;
      continue;
    }
    const indented = /^[ \t]/.test(line);
    if (!started) {
      out = line;
      started = true;
    } else if (pendingBreaks > 0) {
      out += '\n'.repeat(pendingBreaks) + line;
    } else if (indented || previousIndented) {
      out += `\n${line}`;
    } else {
      out += ` ${line}`;
    }
    previousIndented = indented;
    pendingBreaks = 0;
  }
  return out;
}

/**
 * Consume a block scalar starting after its header line.
 *
 * `next` is the first raw line the scalar did not consume, so trailing blank
 * lines are counted for chomping and the following key is left for the normal
 * line loop. Content is taken verbatim: a `#` inside a block scalar is data,
 * not a comment.
 */
function readBlockScalar(
  rawLines: readonly string[],
  headerIndex: number,
  parentIndent: number,
  header: RegExpMatchArray,
): { value: string; next: number } {
  const literal = header[2] === '|';
  const chomping = header[3] === '-' ? 'strip' : header[3] === '+' ? 'keep' : 'clip';
  const explicit = header[4] === '' ? null : Number(header[4]);

  const collected: string[] = [];
  let pendingBlanks = 0;
  let next = rawLines.length;
  let baseIndent = explicit === null ? -1 : parentIndent + explicit;

  for (let index = headerIndex + 1; index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    if (raw.trim() === '') {
      pendingBlanks += 1;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (baseIndent === -1) {
      if (indent <= parentIndent) {
        next = index;
        break;
      }
      baseIndent = indent;
    } else if (indent < baseIndent) {
      next = index;
      break;
    }
    for (let blank = 0; blank < pendingBlanks; blank += 1) collected.push('');
    pendingBlanks = 0;
    collected.push(raw.slice(baseIndent));
  }

  const body = literal ? collected.join('\n') : foldBlockLines(collected);
  let value: string;
  if (collected.length === 0) value = chomping === 'keep' ? '\n'.repeat(pendingBlanks) : '';
  else if (chomping === 'strip') value = body;
  else if (chomping === 'keep') value = `${body}\n${'\n'.repeat(pendingBlanks)}`;
  else value = `${body}\n`;
  return { value, next };
}

function tokenize(source: string): Line[] {
  const lines: Line[] = [];
  const rawLines = source.split(/\r?\n/);
  let index = 0;
  while (index < rawLines.length) {
    const raw = rawLines[index];
    if (/^\t|^ *\t/.test(raw)) throw new YamlParseError('tab indentation is not allowed in YAML', index);
    const withoutComment = stripComment(raw);
    const trimmed = withoutComment.trim();
    if (trimmed === '' || trimmed === '---' || trimmed === '...') {
      index += 1;
      continue;
    }
    const indent = withoutComment.length - withoutComment.trimStart().length;

    const header = trimmed.match(BLOCK_HEADER);
    const headerText = header === null ? '' : header[2] + header[3] + header[4];
    const prefix = header === null ? '' : trimmed.slice(0, trimmed.length - headerText.length);
    if (header !== null && !hasUnbalancedQuote(prefix)) {
      const scalar = readBlockScalar(rawLines, index, indent, header);
      // The scalar becomes one quoted line, so every other rule (indentation
      // checks, duplicate keys, strict rejection) applies to it unchanged.
      lines.push({ indent, content: `${prefix}${JSON.stringify(scalar.value)}`, number: index });
      index = scalar.next;
      continue;
    }

    lines.push({ indent, content: trimmed, number: index });
    index += 1;
  }
  return lines;
}

/** Find the index of the `:` that separates a block key from its value. */
function findKeySeparator(content: string): number {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') depth -= 1;
      else if (char === ':' && depth === 0) {
        const next = content[index + 1];
        if (next === undefined || next === ' ' || next === '\t') return index;
      }
    }
  }
  return -1;
}

function parseScalar(text: string, line: number): YamlValue {
  const value = text.trim();
  if (value === '' || value === '~' || value === 'null' || value === 'Null' || value === 'NULL') return null;
  if (value === 'true' || value === 'True' || value === 'TRUE') return true;
  if (value === 'false' || value === 'False' || value === 'FALSE') return false;

  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw new YamlParseError('unterminated double-quoted scalar', line);
    try {
      return JSON.parse(value) as string;
    } catch {
      throw new YamlParseError('invalid double-quoted scalar escape', line);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new YamlParseError('unterminated single-quoted scalar', line);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (FLOW_START.test(value)) return parseFlow(value, line).value;

  if (/^[+-]?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : value;
  }
  if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value;
}

function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

/**
 * Scan a single flow entry starting at `from`, returning where it ends.
 *
 * Quoted regions are skipped wholesale so a `,` or `:` inside a quoted scalar
 * (for example the engine range `'>=20'`, or a peer range containing `||`) is
 * never mistaken for a delimiter. Nesting depth is tracked so an inner flow
 * collection is consumed as one entry.
 */
function scanFlowEntry(text: string, from: number, line: number): { end: number; topLevelColon: number } {
  let cursor = from;
  let depth = 0;
  let colon = -1;

  while (cursor < text.length) {
    const char = text[cursor];

    if (char === '"' || char === "'") {
      const quote = char;
      cursor += 1;
      for (;;) {
        if (cursor >= text.length) throw new YamlParseError('unterminated quoted scalar', line);
        if (quote === "'" && text[cursor] === "'" && text[cursor + 1] === "'") {
          cursor += 2;
          continue;
        }
        if (text[cursor] === quote) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      continue;
    }

    if (char === '{' || char === '[') {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      if (depth === 0) break;
      depth -= 1;
      cursor += 1;
      continue;
    }
    if (depth === 0 && char === ',') break;
    if (depth === 0 && char === ':' && colon === -1) {
      const next = text[cursor + 1];
      if (next === undefined || next === ' ' || next === '\t' || next === ',' || next === '}' || next === ']') {
        colon = cursor;
      }
    }
    cursor += 1;
  }

  return { end: cursor, topLevelColon: colon };
}

function parseFlow(text: string, line: number): { value: YamlValue; end: number } {
  const start = text[0];
  const close = start === '{' ? '}' : ']';
  const isMap = start === '{';
  let cursor = skipWhitespace(text, 1);
  const result: YamlValue = isMap ? {} : [];

  for (;;) {
    if (cursor >= text.length) throw new YamlParseError('unterminated flow collection', line);
    if (text[cursor] === close) {
      cursor += 1;
      break;
    }

    const scanner = scanFlowEntry(text, cursor, line);
    const rawEntry = text.slice(cursor, scanner.end);

    if (isMap) {
      if (scanner.topLevelColon === -1) {
        throw new YamlParseError(`expected ":" in flow mapping entry "${rawEntry.trim()}"`, line);
      }
      const rawKey = text.slice(cursor, scanner.topLevelColon);
      const key = String(parseScalar(rawKey, line));
      let valueStart = skipWhitespace(text, scanner.topLevelColon + 1);
      let value: YamlValue;
      if (text[valueStart] === '{' || text[valueStart] === '[') {
        const nested = parseFlow(text.slice(valueStart), line);
        value = nested.value;
        valueStart += nested.end;
      } else {
        value = parseScalar(text.slice(valueStart, scanner.end), line);
      }
      (result as Record<string, YamlValue>)[key] = value;
    } else {
      if (scanner.topLevelColon !== -1) {
        throw new YamlParseError('unexpected ":" in flow sequence entry', line);
      }
      if (text[cursor] === '{' || text[cursor] === '[') {
        const nested = parseFlow(text.slice(cursor), line);
        (result as YamlValue[]).push(nested.value);
      } else {
        (result as YamlValue[]).push(parseScalar(rawEntry, line));
      }
    }

    cursor = skipWhitespace(text, scanner.end);
    if (text[cursor] === ',') {
      cursor = skipWhitespace(text, cursor + 1);
      continue;
    }
    if (text[cursor] === close) {
      cursor += 1;
      break;
    }
    if (cursor >= text.length) throw new YamlParseError('unterminated flow collection', line);
    throw new YamlParseError(`expected "," or "${close}" in flow collection`, line);
  }

  return { value: result, end: cursor };
}

function isSequenceEntry(content: string): boolean {
  return content === '-' || content.startsWith('- ');
}

function parseBlock(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const first = lines[start];
  if (first === undefined) return { value: null, next: start };

  if (isSequenceEntry(first.content)) {
    const items: YamlValue[] = [];
    let cursor = start;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlParseError('unexpected indentation in sequence', line.number);
      if (!isSequenceEntry(line.content)) break;

      const inline = line.content === '-' ? '' : line.content.slice(2).trim();
      if (inline === '') {
        const child = lines[cursor + 1];
        if (child !== undefined && child.indent > indent) {
          const parsed = parseBlock(lines, cursor + 1, child.indent);
          items.push(parsed.value);
          cursor = parsed.next;
        } else {
          items.push(null);
          cursor += 1;
        }
      } else {
        const separator = findKeySeparator(inline);
        if (separator === -1 || FLOW_START.test(inline)) {
          items.push(parseScalar(inline, line.number));
          cursor += 1;
        } else {
          // "- key: value" starts a mapping whose first key sits on this line.
          // Parse it from a local view (synthetic first key plus the following
          // more-indented lines) without mutating the shared line array.
          const syntheticIndent = indent + 2;
          const synthetic: Line = { indent: syntheticIndent, content: inline, number: line.number };
          const view: Line[] = [synthetic];
          let lookahead = cursor + 1;
          while (lookahead < lines.length && lines[lookahead].indent >= syntheticIndent) {
            view.push(lines[lookahead]);
            lookahead += 1;
          }
          const parsed = parseBlock(view, 0, syntheticIndent);
          items.push(parsed.value);
          cursor = lookahead;
        }
      }
    }
    return { value: items, next: cursor };
  }

  const mapping: Record<string, YamlValue> = {};
  let cursor = start;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlParseError('unexpected indentation in mapping', line.number);
    if (isSequenceEntry(line.content)) break;

    const separator = findKeySeparator(line.content);
    if (separator === -1) throw new YamlParseError(`expected "key: value" but found "${line.content}"`, line.number);

    const rawKey = line.content.slice(0, separator).trim();
    if (rawKey === '') throw new YamlParseError('empty mapping key', line.number);
    const key = rawKey.startsWith('"') || rawKey.startsWith("'")
      ? String(parseScalar(rawKey, line.number))
      : rawKey;
    if (Object.prototype.hasOwnProperty.call(mapping, key)) {
      throw new YamlParseError(`duplicate mapping key "${key}"`, line.number);
    }

    const inlineValue = line.content.slice(separator + 1).trim();
    if (inlineValue !== '') {
      mapping[key] = parseScalar(inlineValue, line.number);
      cursor += 1;
      continue;
    }

    const child = lines[cursor + 1];
    if (child !== undefined && child.indent > indent) {
      const parsed = parseBlock(lines, cursor + 1, child.indent);
      mapping[key] = parsed.value;
      cursor = parsed.next;
    } else {
      // A bare `key:` with no nested block is malformed for the shapes we read;
      // pnpm lockfiles always nest a mapping or sequence under such a key.
      throw new YamlParseError(`key "${key}" has no value and no nested block`, line.number);
    }
  }

  return { value: mapping, next: cursor };
}

export function parseYaml(source: string): YamlValue {
  const lines = tokenize(source);
  if (lines.length === 0) return null;
  const parsed = parseBlock(lines, 0, lines[0].indent);
  if (parsed.next < lines.length) {
    throw new YamlParseError('unexpected trailing content', lines[parsed.next].number);
  }
  return parsed.value;
}
