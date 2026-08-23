/**
 * Env Manager — dotenv parser / serializer (Issue #1968).
 *
 * WHY NOT THE `dotenv` PACKAGE
 * ----------------------------
 * `dotenv` is already a dependency of this repository, so using it would have
 * added nothing to install. It was still not used, for two reasons that matter
 * to an *editor* (as opposed to a loader):
 *
 *   1. `dotenv.parse()` returns a plain `Record<string, string>`. It reports no
 *      line numbers and no syntax errors — it silently drops a malformed line.
 *      The issue requires "不正な構文 … の入力時に適切なバリデーションエラー",
 *      which is exactly the information that return type throws away.
 *   2. It discards comments, blank lines and ordering, so a Key-Value edit that
 *      round-tripped through it would rewrite the user's file and delete every
 *      comment in it.
 *
 * So this module parses to a *positional* model (`EnvEntry.line` / `.endLine`)
 * that keeps the raw text authoritative, and the Raw view stays byte-exact
 * unless the user edits it. No new dependency was added.
 *
 * The grammar implemented here is dotenv's, restricted to what a human writes:
 *   - `KEY=value`, optionally prefixed with `export `
 *   - `KEY="value"` — escapes `\n` `\r` `\t` `\\` `\"`, may span physical lines
 *   - `KEY='value'` — literal, no escapes, may span physical lines
 *   - `# comment` and blank lines are preserved by position
 *   - an unquoted value ends at an inline ` #` comment
 */

/** A key/value pair recovered from the file, with its position in it. */
export interface EnvEntry {
  /** Variable name (already validated against {@link ENV_KEY_PATTERN}). */
  key: string;
  /** Decoded value — quotes removed, escapes resolved. */
  value: string;
  /** 1-based line the entry starts on. */
  line: number;
  /** 1-based line the entry ends on (equals `line` unless the value is quoted across lines). */
  endLine: number;
  /** True when the source line carried an `export ` prefix. */
  exported: boolean;
  /** The quote character the value was written with, or null when unquoted. */
  quote: '"' | "'" | null;
}

/** Machine-readable identity of a parse problem. Never carries a value. */
export type EnvIssueCode =
  | 'invalid-syntax'
  | 'invalid-key'
  | 'unterminated-quote'
  | 'duplicate-key'
  | 'control-character'
  | 'too-large'
  | 'too-many-entries';

/**
 * A single problem found in the file.
 *
 * DELIBERATELY VALUE-FREE (issue requirement 3): an issue carries a line
 * number, a code and — at most — a KEY name. Never a value, because these
 * objects are returned by the API, rendered in the UI and logged on the server.
 */
export interface EnvIssue {
  /** 1-based line, or null for whole-file problems (size, entry count). */
  line: number | null;
  code: EnvIssueCode;
  severity: 'error' | 'warning';
  /** Key name, when the problem is about one. Never a value. */
  key?: string;
}

export interface EnvParseResult {
  entries: EnvEntry[];
  issues: EnvIssue[];
}

/** POSIX-ish variable name: letter/underscore first, then word characters. */
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether `key` is a syntactically valid environment variable name. */
export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key);
}

/**
 * Split raw text into physical lines without losing a trailing empty line.
 * Handles CRLF and lone-CR files.
 */
function splitLines(raw: string): string[] {
  return raw.split(/\r\n|\n|\r/);
}

/** Resolve the escape sequences legal inside a double-quoted dotenv value. */
function unescapeDoubleQuoted(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '\\' || i === text.length - 1) {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    i += 1;
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case '\\':
        out += '\\';
        break;
      case '"':
        out += '"';
        break;
      default:
        // Unknown escape: keep both characters, matching dotenv's leniency.
        out += `\\${next}`;
    }
  }
  return out;
}

/**
 * Find the index of the closing quote in `text`, or -1.
 * Backslash escaping only applies to double quotes (dotenv semantics).
 */
function findClosingQuote(text: string, quote: '"' | "'", from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (quote === '"' && text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

/**
 * Strip a trailing inline comment from an unquoted value.
 *
 * dotenv only treats `#` as a comment when preceded by whitespace, so
 * `KEY=a#b` keeps the `#` while `KEY=a # b` does not.
 */
function stripInlineComment(text: string): string {
  const match = /\s#/.exec(text);
  return match ? text.slice(0, match.index) : text;
}

/**
 * Parse the contents of an env file.
 *
 * Never throws: anything it cannot understand becomes an {@link EnvIssue} so
 * the caller can show the user *where* the problem is instead of failing whole.
 *
 * @param raw - The complete file text.
 * @returns The entries in file order plus every problem found.
 */
export function parseEnvContent(raw: string): EnvParseResult {
  const lines = splitLines(raw);
  const entries: EnvEntry[] = [];
  const issues: EnvIssue[] = [];
  const seenKeys = new Map<string, number>();

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const exported = /^export\s+/.test(trimmed);
    const body = exported ? trimmed.replace(/^export\s+/, '') : trimmed;

    const eq = body.indexOf('=');
    if (eq === -1) {
      issues.push({ line: lineNo, code: 'invalid-syntax', severity: 'error' });
      continue;
    }

    const key = body.slice(0, eq).trim();
    if (!isValidEnvKey(key)) {
      issues.push({
        line: lineNo,
        code: 'invalid-key',
        severity: 'error',
        // Reporting the offending *name* is intentional and safe; it is the
        // half of the line the user has to fix. The value never leaves here.
        ...(key.length > 0 && key.length <= 64 ? { key } : {}),
      });
      continue;
    }

    const rawValue = body.slice(eq + 1).replace(/^[ \t]+/, '');
    let value: string;
    let quote: '"' | "'" | null = null;
    let endLine = lineNo;

    if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      quote = rawValue[0] as '"' | "'";
      let buffer = rawValue.slice(1);
      let closing = findClosingQuote(buffer, quote, 0);

      // A quote left open continues onto the following physical lines.
      while (closing === -1 && index + 1 < lines.length) {
        index += 1;
        endLine = index + 1;
        buffer += `\n${lines[index]}`;
        closing = findClosingQuote(buffer, quote, 0);
      }

      if (closing === -1) {
        issues.push({ line: lineNo, code: 'unterminated-quote', severity: 'error', key });
        continue;
      }

      const inner = buffer.slice(0, closing);
      value = quote === '"' ? unescapeDoubleQuoted(inner) : inner;
    } else {
      value = stripInlineComment(rawValue).replace(/[ \t]+$/, '');
    }

    const previous = seenKeys.get(key);
    if (previous !== undefined) {
      issues.push({ line: lineNo, code: 'duplicate-key', severity: 'warning', key });
    }
    seenKeys.set(key, lineNo);

    entries.push({ key, value, line: lineNo, endLine, exported, quote });
  }

  return { entries, issues };
}

/**
 * Characters that force a value to be quoted on the way out.
 *
 * Whitespace, `#`, both quote characters, `\`, `$` and a backtick. `$` and the
 * backtick are included not because this parser expands them but because some
 * loaders (`dotenv-expand`, `set -a; source .env`) do — quoting is the shape
 * that survives both.
 */
const NEEDS_QUOTING_PATTERN = /[\s#'"$`\\]/;

/** Whether {@link serializeEnvEntries} would wrap this value in quotes. */
export function needsQuoting(value: string): boolean {
  return NEEDS_QUOTING_PATTERN.test(value);
}

/** Render one value as it should appear on the right of the `=`. */
export function formatEnvValue(value: string): string {
  if (!needsQuoting(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/**
 * Render a Key-Value edit back to file text.
 *
 * Round-trips with {@link parseEnvContent}: parsing the output yields the same
 * keys and the same values (pinned by
 * `tests/unit/lib/env-manager/env-parser.test.ts`). Comments are NOT preserved
 * here — the Key-Value view has no place to hold them, which is precisely why
 * the Raw view exists and why the UI only serializes when the user actually
 * edited a key or a value.
 */
export function serializeEnvEntries(
  entries: ReadonlyArray<Pick<EnvEntry, 'key' | 'value'> & Partial<Pick<EnvEntry, 'exported'>>>,
): string {
  const body = entries
    .map((entry) => `${entry.exported ? 'export ' : ''}${entry.key}=${formatEnvValue(entry.value)}`)
    .join('\n');
  return body.length > 0 ? `${body}\n` : '';
}

/**
 * One row of the Key-Value editor.
 *
 * `sourceLine` is the link back into the raw text: the 1-based start line of
 * the entry this row was seeded from, or null for a row the user just added.
 * It is what lets {@link applyEnvRows} write an edit back *in place* instead of
 * regenerating the file.
 */
export interface EnvRow {
  key: string;
  value: string;
  sourceLine: number | null;
}

/**
 * Merge Key-Value edits back into the raw file text.
 *
 * The point of this function is COMMENT PRESERVATION. Regenerating the file
 * from the rows (`serializeEnvEntries`) would silently delete every comment and
 * blank line the user wrote, which is a destructive edit nobody asked for. So
 * instead each row is written back over the exact line range it came from, rows
 * whose entry no longer has a row are deleted, and brand-new rows are appended
 * at the end. Everything the parser classified as a comment or blank line is
 * copied through untouched.
 *
 * @param raw - The text the rows were derived from.
 * @param entries - `parseEnvContent(raw).entries`, i.e. what `sourceLine` indexes.
 * @param rows - The rows as edited, in display order.
 * @returns The merged file text.
 */
export function applyEnvRows(
  raw: string,
  entries: ReadonlyArray<EnvEntry>,
  rows: ReadonlyArray<EnvRow>,
): string {
  const lines = splitLines(raw);
  const entryByLine = new Map<number, EnvEntry>(entries.map((entry) => [entry.line, entry]));
  const rowByLine = new Map<number, EnvRow>();
  const appended: EnvRow[] = [];

  for (const row of rows) {
    if (row.sourceLine !== null && entryByLine.has(row.sourceLine)) {
      rowByLine.set(row.sourceLine, row);
    } else {
      appended.push(row);
    }
  }

  const out: string[] = [];
  let skipUntil = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    if (lineNo <= skipUntil) continue;

    const entry = entryByLine.get(lineNo);
    if (!entry) {
      out.push(lines[i]);
      continue;
    }

    // A multi-line quoted value occupies line..endLine; consume all of it.
    skipUntil = entry.endLine;

    const row = rowByLine.get(lineNo);
    // No row for this entry -> the user deleted it.
    if (!row) continue;

    out.push(`${entry.exported ? 'export ' : ''}${row.key}=${formatEnvValue(row.value)}`);
  }

  // Drop a single trailing empty line so appends land before it, then restore
  // the file-final newline at the end.
  if (out.length > 0 && out[out.length - 1] === '') out.pop();
  for (const row of appended) {
    out.push(`${row.key}=${formatEnvValue(row.value)}`);
  }

  if (out.length === 0) return '';
  return `${out.join('\n')}\n`;
}
