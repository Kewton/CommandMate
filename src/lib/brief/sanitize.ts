/**
 * The exit check every free-text value of the brief goes through, whatever source it
 * came from (Issue #4223, design §3.3).
 *
 * The rule is #4221's: {@link validateItemText} (C1, bidirectional controls and the BOM
 * refused; C0 but LF / TAB refused; the length; the secret-like rules). It is called,
 * not copied. The text, `--json`, `--all` and the provider's rebuilt body all read the
 * value this module answered, so they cannot disagree.
 *
 * @module lib/brief/sanitize
 */

import { validateItemText } from '@/lib/mem/validate';
import type { BriefWithheld } from '@/types/brief';
import { BRIEF_FIXED_LIMITS } from '@/types/brief';

/**
 * Characters a reader does not see but a model reads (review P2-1, 2026-11-09): Unicode
 * Tags, zero-width characters, directional marks and overrides, the Arabic letter mark,
 * the invisible operators, and the line / paragraph separators. #4221's check refuses
 * only some of them (C1, U+202A〜U+202E, U+2066〜U+2069, the BOM).
 */
const INVISIBLE = /[\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|\uDB40[\uDC00-\uDC7F]/g;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const JOINS_AFTER = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F]/u;
const ZWJ = '\u200D';

/**
 * The value with every invisible character replaced by a visible `[U+XXXX]` (never
 * removed silently, so the reader sees that something was there). The one exception is
 * a zero-width joiner between two pictographs, which is how an emoji sequence (👩‍💻) is
 * spelled: it is kept, so ordinary emoji do not change.
 */
export function revealInvisible(value: string): string {
  return value.replace(INVISIBLE, (char, offset: number, whole: string) => {
    if (char === ZWJ) {
      const before = Array.from(whole.slice(0, offset)).at(-1) ?? '';
      const after = Array.from(whole.slice(offset + 1))[0] ?? '';
      if (JOINS_AFTER.test(before) && PICTOGRAPH.test(after)) return char;
    }
    return `[U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}]`;
  });
}

export type SanitizedField =
  | { kind: 'ok'; value: string }
  | { kind: 'withheld'; withheld: BriefWithheld }
  /** Over #4221's length: never shown, even with `--all` (it could not be checked). */
  | { kind: 'too_long'; bytes: number };

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

export function sanitizeBriefField(value: string, field: string): SanitizedField {
  if (value.length === 0) return { kind: 'ok', value: '' };
  const checked = validateItemText(value, field);
  if (checked.ok) return { kind: 'ok', value: revealInvisible(checked.value) };
  const { code, rule } = checked.error;
  if (code === 'too_long') return { kind: 'too_long', bytes: bytesOf(value) };
  if (code === 'secret_like') return { kind: 'withheld', withheld: { code: 'secret_like', field, ...(rule ? { rule } : {}) } };
  // control_char, and invalid_request for a value that is only whitespace / controls.
  if (code === 'invalid_request') return { kind: 'ok', value: '' };
  return { kind: 'withheld', withheld: { code: 'control_char', field } };
}

/** The branch of the fixed part (design §2.2・§2.6): its value, or why it is replaced. */
export type SanitizedBranch =
  | { kind: 'ok'; value: string }
  | { kind: 'omitted'; bytes: number; reason: 'too_long' | 'control_char' | 'secret_like' };

export function sanitizeBranch(branch: string): SanitizedBranch {
  const bytes = bytesOf(branch);
  if (bytes > BRIEF_FIXED_LIMITS.branchBytes) return { kind: 'omitted', bytes, reason: 'too_long' };
  const checked = sanitizeBriefField(branch, 'branch');
  if (checked.kind === 'withheld') return { kind: 'omitted', bytes, reason: checked.withheld.code };
  if (checked.kind === 'too_long') return { kind: 'omitted', bytes, reason: 'too_long' };
  // A branch the check had to change (a fold, a trim) is not the branch: replace it.
  if (checked.value !== branch || /\s/.test(branch)) return { kind: 'omitted', bytes, reason: 'control_char' };
  return { kind: 'ok', value: branch };
}

/** An id of the fixed part (ASCII of a known shape, design §2.6), or null when it is not one. */
export function fixedId(value: string, maxChars: number): string | null {
  return value.length <= maxChars && /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}
