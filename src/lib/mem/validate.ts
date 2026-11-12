/**
 * The checks every free-text field of mem goes through, on the server (Issue #4221,
 * design §6). One function, called by the mem routes and by the #2427 note route
 * when it writes a row of mem.
 *
 * Lengths count code points, as #2427 does. A refusal says which field, which rule
 * and the limit, and never the refused value or the part that matched (§7).
 *
 * @module lib/mem/validate
 */

import { lstatSync } from 'fs';
import path from 'path';
import { findSensitivePathSegment } from '@/lib/security/sensitive-file-guard';
import type { MemErrorCode, MemKind } from '@/types/mem';
import { findSecretRule, type MemSecretRule, MEM_SECRET_RULES } from './secret-scan';

export const MEM_LIMITS = {
  nowText: 100,
  text: 1000,
  quote: 500,
  evidenceItems: 5,
  evidence: 300,
  promoteTo: 300,
  reason: 300,
  key: 128,
} as const;

/** How far ahead of the server clock a quote may be dated. */
export const MEM_QUOTE_FUTURE_SLACK_MS = 5 * 60 * 1000;

export interface MemFieldError {
  code: MemErrorCode;
  field: string;
  rule?: string;
  limit?: number;
}

export type MemFieldResult<T> = { ok: true; value: T } | { ok: false; error: MemFieldError };

const fail = <T>(code: MemErrorCode, field: string, extra: Partial<MemFieldError> = {}): MemFieldResult<T> => ({
  ok: false,
  error: { code, field, ...extra },
});

const length = (text: string): number => Array.from(text).length;

const isC0 = (code: number): boolean => code < 0x20;
const DEL = 0x7f;
const isC1 = (code: number): boolean => code >= 0x80 && code <= 0x9f;
const isBidi = (code: number): boolean => (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
const BOM = 0xfeff;
const LF = 0x0a;
const TAB = 0x09;
const CR = 0x0d;

/** C1, a bidirectional control or a BOM: refused in every field, folded nowhere. */
function hasForbiddenControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isC1(code) || isBidi(code) || code === BOM) return true;
  }
  return false;
}

/** Fold C0, DEL and whitespace runs to one space, as `normalizeSessionNoteText` does. */
function foldToLine(text: string): string {
  let folded = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    folded += isC0(code) || code === DEL ? ' ' : char;
  }
  return folded.replace(/\s+/g, ' ').trim();
}

/** CR / CRLF become LF; any other C0 or DEL but those allowed is refused. */
function normalizeMultiline(text: string, allowTab: boolean): string | null {
  const unified = text.replace(/\r\n?/g, '\n');
  for (const char of unified) {
    const code = char.codePointAt(0) ?? 0;
    if (code === LF || (allowTab && code === TAB)) continue;
    if (isC0(code) || code === DEL || code === CR) return null;
  }
  return unified.trim();
}

/** No line break or control at all (structured fields). */
function isSingleLineClean(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isC0(code) || code === DEL) return false;
  }
  return true;
}

function checkSecret(field: string, value: string, rules: readonly MemSecretRule[]): MemFieldError | null {
  const rule = findSecretRule(value, rules);
  return rule ? { code: 'secret_like', field, rule } : null;
}

/** The text of a `now`: one line of at most 100, folded the #2427 way. */
export function validateNowText(raw: unknown, field = 'text', rules = MEM_SECRET_RULES): MemFieldResult<string> {
  if (typeof raw !== 'string') return fail('invalid_request', field);
  if (hasForbiddenControl(raw)) return fail('control_char', field);
  const text = foldToLine(raw);
  if (length(text) > MEM_LIMITS.nowText) return fail('too_long', field, { limit: MEM_LIMITS.nowText });
  const secret = checkSecret(field, text, rules);
  if (secret) return { ok: false, error: secret };
  return { ok: true, value: text };
}

/** The text of any other kind: LF and TAB stay, at most 1000. */
export function validateItemText(raw: unknown, field = 'text'): MemFieldResult<string> {
  if (typeof raw !== 'string') return fail('invalid_request', field);
  if (hasForbiddenControl(raw)) return fail('control_char', field);
  const text = normalizeMultiline(raw, true);
  if (text === null) return fail('control_char', field);
  if (text.length === 0) return fail('invalid_request', field);
  if (length(text) > MEM_LIMITS.text) return fail('too_long', field, { limit: MEM_LIMITS.text });
  const secret = checkSecret(field, text, MEM_SECRET_RULES);
  if (secret) return { ok: false, error: secret };
  return { ok: true, value: text };
}

export function validateQuote(raw: unknown): MemFieldResult<string> {
  if (typeof raw !== 'string') return fail('invalid_request', 'quote');
  if (hasForbiddenControl(raw)) return fail('control_char', 'quote');
  const text = normalizeMultiline(raw, false);
  if (text === null) return fail('control_char', 'quote');
  if (text.length === 0) return fail('invalid_request', 'quote');
  if (length(text) > MEM_LIMITS.quote) return fail('too_long', 'quote', { limit: MEM_LIMITS.quote });
  const secret = checkSecret('quote', text, MEM_SECRET_RULES);
  if (secret) return { ok: false, error: secret };
  return { ok: true, value: text };
}

/** `close --reason`: folded to one line like a note. */
export function validateReason(raw: unknown): MemFieldResult<string> {
  if (typeof raw !== 'string') return fail('invalid_request', 'reason');
  if (hasForbiddenControl(raw)) return fail('control_char', 'reason');
  const text = foldToLine(raw);
  if (length(text) > MEM_LIMITS.reason) return fail('too_long', 'reason', { limit: MEM_LIMITS.reason });
  const secret = checkSecret('reason', text, MEM_SECRET_RULES);
  if (secret) return { ok: false, error: secret };
  return { ok: true, value: text };
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 instant with its offset, as epoch ms; null when it is not one. */
export function parseIsoWithOffset(raw: string): number | null {
  if (!ISO_WITH_OFFSET.test(raw)) return null;
  const epoch = Date.parse(raw);
  return Number.isFinite(epoch) ? epoch : null;
}

export function validateQuoteAt(raw: unknown, now: number): MemFieldResult<number> {
  if (typeof raw !== 'string') return fail('invalid_quote_at', 'quoteAt');
  const epoch = parseIsoWithOffset(raw);
  if (epoch === null) return fail('invalid_quote_at', 'quoteAt');
  if (epoch > now + MEM_QUOTE_FUTURE_SLACK_MS) return fail('invalid_quote_at', 'quoteAt');
  return { ok: true, value: epoch };
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

export function validateKey(raw: unknown): MemFieldResult<string> {
  if (typeof raw !== 'string' || !IDEMPOTENCY_KEY.test(raw)) {
    return fail('invalid_key', 'key', { limit: MEM_LIMITS.key });
  }
  return { ok: true, value: raw };
}

// ---------------------------------------------------------------------------
// Paths (§6.2)
// ---------------------------------------------------------------------------

/**
 * A repository-relative path, normalized, with no symlink on the way (§6.2).
 *
 * @param root - The worktree root the path is relative to; null when the request has none
 * @param mustExist - `evidence` must point at something; `promote_to` may name what is to come
 * @returns The normalized relative path. The absolute path used to look is never returned.
 */
export function normalizeRepoPath(
  raw: string,
  root: string | null,
  field: string,
  mustExist: boolean
): MemFieldResult<string> {
  if (raw.length === 0) return fail(field === 'evidence' ? 'invalid_evidence' : 'invalid_promote_to', field);
  if (raw.startsWith('/') || raw.startsWith('~') || raw.includes('\u0000') || raw.includes('\\') || /^[A-Za-z]:/.test(raw)) {
    return fail('absolute_path', field);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.') {
    return fail('outside_repository', field);
  }
  if (findSensitivePathSegment(normalized)) return fail('sensitive_path', field);
  if (root === null) return fail('invalid_request', field);

  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      if (mustExist) return fail('invalid_evidence', field);
      break;
    }
    if (stat.isSymbolicLink()) return fail('symlink', field);
  }
  return { ok: true, value: normalized };
}

const TARGET = '(?:[A-Za-z0-9.-]+/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+)?';
const ISSUE_REF = new RegExp(`^(?:issue|pr):${TARGET}#[1-9][0-9]{0,9}$`);
const EVIDENCE_SIMPLE = [
  /^commit:[0-9a-f]{7,40}$/,
  ISSUE_REF,
  /^task:[A-Za-z0-9._:-]{1,128}$/,
  /^relay:[A-Za-z0-9._:-]{1,128}$/,
];

function validateStructured(
  raw: unknown,
  field: 'evidence' | 'promoteTo',
  root: string | null
): MemFieldResult<string> {
  const invalid: MemErrorCode = field === 'evidence' ? 'invalid_evidence' : 'invalid_promote_to';
  const limit = field === 'evidence' ? MEM_LIMITS.evidence : MEM_LIMITS.promoteTo;
  if (typeof raw !== 'string' || raw.length === 0) return fail(invalid, field);
  if (hasForbiddenControl(raw) || !isSingleLineClean(raw)) return fail('control_char', field);
  if (length(raw) > limit) return fail('too_long', field, { limit });
  const secret = checkSecret(field, raw, MEM_SECRET_RULES);
  if (secret) return { ok: false, error: secret };

  if (raw.startsWith('path:')) {
    const rest = raw.slice('path:'.length);
    const lineMatch = /^(.*?)(:[1-9][0-9]{0,6})?$/.exec(rest);
    const relative = lineMatch?.[1] ?? rest;
    const line = field === 'evidence' ? (lineMatch?.[2] ?? '') : '';
    const checked = normalizeRepoPath(field === 'evidence' ? relative : rest, root, field, field === 'evidence');
    if (!checked.ok) return checked;
    return { ok: true, value: `path:${checked.value}${line}` };
  }
  if (field === 'evidence') {
    if (raw.startsWith('url:')) {
      return /^url:https:\/\/[^\s]+$/.test(raw) ? { ok: true, value: raw } : fail(invalid, field);
    }
    if (EVIDENCE_SIMPLE.some((pattern) => pattern.test(raw))) return { ok: true, value: raw };
    if (/^\//.test(raw) || /^~/.test(raw)) return fail('absolute_path', field);
    return fail(invalid, field);
  }
  if (ISSUE_REF.test(raw)) return { ok: true, value: raw };
  if (/^\//.test(raw) || /^~/.test(raw)) return fail('absolute_path', field);
  return fail(invalid, field);
}

export function validateEvidence(raw: unknown, root: string | null): MemFieldResult<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > MEM_LIMITS.evidenceItems) {
    return fail('too_long', 'evidence', { limit: MEM_LIMITS.evidenceItems });
  }
  const out: string[] = [];
  for (const entry of list) {
    const checked = validateStructured(entry, 'evidence', root);
    if (!checked.ok) return checked;
    out.push(checked.value);
  }
  return { ok: true, value: out };
}

export function validatePromoteTo(raw: unknown, root: string | null): MemFieldResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  return validateStructured(raw, 'promoteTo', root);
}

/** What a write of an item carries once checked. */
export interface MemCheckedFields {
  text: string;
  quote: string | null;
  quoteAt: number | null;
  evidence: string[];
  promoteTo: string | null;
}

/**
 * Every free field of one write, in a fixed order so the first refusal is stable.
 *
 * @param input - Fields as received; undefined means not given
 * @param root - Worktree root for `path:` references; null when there is none
 */
export function validateMemFields(
  kind: MemKind,
  input: { text?: unknown; quote?: unknown; quoteAt?: unknown; evidence?: unknown; promoteTo?: unknown },
  root: string | null,
  now: number = Date.now()
): MemFieldResult<MemCheckedFields> {
  const text = kind === 'now' ? validateNowText(input.text) : validateItemText(input.text);
  if (!text.ok) return text;
  if (kind === 'now' && text.value.length === 0) return fail('invalid_request', 'text');

  let quote: string | null = null;
  let quoteAt: number | null = null;
  const hasQuote = input.quote !== undefined && input.quote !== null;
  const hasQuoteAt = input.quoteAt !== undefined && input.quoteAt !== null;
  if (hasQuote !== hasQuoteAt) return fail('invalid_request', hasQuote ? 'quoteAt' : 'quote');
  if (hasQuote) {
    const q = validateQuote(input.quote);
    if (!q.ok) return q;
    const at = validateQuoteAt(input.quoteAt, now);
    if (!at.ok) return at;
    quote = q.value;
    quoteAt = at.value;
  }

  const evidence = validateEvidence(input.evidence, root);
  if (!evidence.ok) return evidence;
  const promoteTo = validatePromoteTo(input.promoteTo, root);
  if (!promoteTo.ok) return promoteTo;

  return {
    ok: true,
    value: { text: text.value, quote, quoteAt, evidence: evidence.value, promoteTo: promoteTo.value },
  };
}
