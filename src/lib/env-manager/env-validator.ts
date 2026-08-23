/**
 * Env Manager — content validation (Issue #1968).
 *
 * Runs on BOTH sides of the wire: the pane calls it to show inline errors while
 * the user types, and the API route calls it again before writing, because a
 * client-side check is a convenience and never a control.
 *
 * Like {@link EnvIssue}, everything this module produces is value-free: a line
 * number, a code, and at most a key name. The rendered message is looked up
 * from the code in the UI's locale files, so a value can never reach a log, an
 * error body or a translation parameter.
 */

import {
  isValidEnvKey,
  parseEnvContent,
  type EnvIssue,
  type EnvEntry,
} from './env-parser';

/** Refuse anything larger than this. An env file is a few KB; 256KB is generous. */
export const ENV_MAX_SIZE_BYTES = 256 * 1024;

/** Refuse a file with more entries than this (a paste accident, not a config). */
export const ENV_MAX_ENTRIES = 1000;

/**
 * C0/C1 control characters that must never appear in an env file.
 *
 * Tab (0x09), LF (0x0A) and CR (0x0D) are excluded — they are the legal
 * whitespace of the format. Everything else in 0x00–0x1F plus DEL (0x7F) is
 * refused: a NUL truncates the file for any C-based reader, and ESC (0x1B)
 * turns a value into a terminal escape sequence the moment anything prints it.
 */
export const DANGEROUS_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

export interface EnvValidationResult {
  /** True when no `severity: 'error'` issue was found. Warnings do not block a save. */
  valid: boolean;
  issues: EnvIssue[];
  /** Entries recovered from the content (empty when the content could not be parsed). */
  entries: EnvEntry[];
}

/**
 * Validate the full text of an env file.
 *
 * @param raw - Complete file content as the user would save it.
 * @returns Whether it may be written, plus every problem found, in line order.
 */
export function validateEnvContent(raw: string): EnvValidationResult {
  const issues: EnvIssue[] = [];

  if (typeof raw !== 'string') {
    return { valid: false, issues: [{ line: null, code: 'invalid-syntax', severity: 'error' }], entries: [] };
  }

  // TextEncoder rather than Buffer: this module is imported by the pane as
  // well as the route, and `Buffer` is not a browser global.
  const byteLength = new TextEncoder().encode(raw).length;
  if (byteLength > ENV_MAX_SIZE_BYTES) {
    // Bail out early: parsing a multi-megabyte paste to report line numbers
    // nobody will read is work the request does not need to do.
    return { valid: false, issues: [{ line: null, code: 'too-large', severity: 'error' }], entries: [] };
  }

  // Control characters are located per line so the editor can point at them.
  // The matched character itself is never reported — only that the line has one.
  const lines = raw.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i += 1) {
    if (DANGEROUS_CONTROL_CHAR_PATTERN.test(lines[i])) {
      issues.push({ line: i + 1, code: 'control-character', severity: 'error' });
    }
  }

  const parsed = parseEnvContent(raw);
  issues.push(...parsed.issues);

  if (parsed.entries.length > ENV_MAX_ENTRIES) {
    issues.push({ line: null, code: 'too-many-entries', severity: 'error' });
  }

  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    entries: parsed.entries,
  };
}

/**
 * Validate one Key-Value row before it is serialized.
 *
 * Split out from {@link validateEnvContent} so the pane can mark a single row
 * red without re-validating the whole file on every keystroke.
 *
 * @returns The issue codes that apply to this row, in a stable order.
 */
export function validateEnvPair(key: string, value: string): EnvIssue['code'][] {
  const codes: EnvIssue['code'][] = [];
  if (!isValidEnvKey(key)) codes.push('invalid-key');
  if (DANGEROUS_CONTROL_CHAR_PATTERN.test(value)) codes.push('control-character');
  return codes;
}
