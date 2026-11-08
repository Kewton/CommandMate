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

export type SanitizedField =
  | { kind: 'ok'; value: string }
  | { kind: 'withheld'; withheld: BriefWithheld }
  /** Over #4221's length: never shown, even with `--all` (it could not be checked). */
  | { kind: 'too_long'; bytes: number };

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

export function sanitizeBriefField(value: string, field: string): SanitizedField {
  if (value.length === 0) return { kind: 'ok', value: '' };
  const checked = validateItemText(value, field);
  if (checked.ok) return { kind: 'ok', value: checked.value };
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
