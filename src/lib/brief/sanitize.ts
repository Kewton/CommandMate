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
 * What a reader does not see but a model reads (PM review P2-1 and its re-review,
 * 2026-11-09): an allow-list, not a list of ranges. Every Default_Ignorable_Code_Point,
 * every format (Cf), line / paragraph separator (Zl / Zp) and private-use (Co) code point,
 * and every variation selector is replaced — #4221's check refuses only some of them.
 * `tests/unit/lib/brief/brief-invisible-4223.test.ts` walks every code point against it.
 */
export const BRIEF_INVISIBLE =
  /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Zl}\p{Zp}\p{Co}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;

const ZWJ = 0x200d;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
const EMOJI = /\p{Emoji}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const MODIFIER = /\p{Emoji_Modifier}/u;
/** The RGI tag sequences (subdivision flags): 🏴 + these tags + CANCEL TAG. Any other tag run is replaced. */
export const BRIEF_RGI_TAG_FLAGS: readonly string[] = ['gbeng', 'gbsct', 'gbwls'];

const charOf = (code: number | undefined): string => (code === undefined ? '' : String.fromCodePoint(code));

/**
 * Whether what stands before the ZWJ at `index` is an emoji element that stays as it is
 * (codex re-review P2, 2026-11-09): a pictograph, optionally followed by a skin tone and a
 * VS16 that is itself kept. A VS16 that is replaced (after a letter) is no ground for
 * keeping the ZWJ: `a\u{FE0F}\u{200D}😀` shows both.
 */
function joinsAfterEmoji(codes: readonly number[], index: number, kept: ReadonlySet<number>): boolean {
  let i = index - 1;
  if (i >= 0 && codes[i] === VS16) {
    if (!kept.has(i)) return false;
    i -= 1;
  }
  if (i >= 0 && MODIFIER.test(String.fromCodePoint(codes[i]))) i -= 1;
  return i >= 0 && PICTOGRAPH.test(String.fromCodePoint(codes[i]));
}

/**
 * The exceptions, and only these (the PM decision): inside an emoji sequence, a ZWJ
 * between two emoji, VS15 / VS16 right after an emoji character (a keycap's digit
 * included), and the tags of an RGI subdivision flag. Skin tones are not invisible
 * (So), so they never needed one. Returns which positions are kept.
 */
export function keptInvisible(codes: readonly number[]): Set<number> {
  const kept = new Set<number>();
  codes.forEach((code, index) => {
    const before = charOf(codes[index - 1]);
    const after = charOf(codes[index + 1]);
    if (code === ZWJ && PICTOGRAPH.test(after) && joinsAfterEmoji(codes, index, kept)) kept.add(index);
    if ((code === VS15 || code === VS16) && before !== '' && EMOJI.test(before) && !BRIEF_INVISIBLE.test(before)) kept.add(index);
    if (code === BLACK_FLAG) {
      let end = index + 1;
      let name = '';
      while (end < codes.length && codes[end] >= 0xe0020 && codes[end] < CANCEL_TAG) name += String.fromCodePoint(codes[end++] - 0xe0000);
      if (codes[end] === CANCEL_TAG && BRIEF_RGI_TAG_FLAGS.includes(name)) for (let i = index + 1; i <= end; i += 1) kept.add(i);
    }
  });
  return kept;
}

/**
 * The value with every invisible code point replaced by a visible `[U+XXXX]` (never
 * removed silently, so a reader sees that something was there), but for the exceptions
 * of {@link keptInvisible}.
 *
 * The price of the allow-list (PM re-review P3-1, accepted): a Persian ZWNJ (U+200C), the
 * ZWJ / ZWNJ of Indic scripts, a variation selector after a non-emoji character (CJK
 * ideographic variants) and the tag flags other than the RGI three show as `[U+XXXX]`.
 */
export function revealInvisible(value: string, keep: (codes: readonly number[]) => Set<number> = keptInvisible): string {
  const codes = Array.from(value, (char) => char.codePointAt(0) ?? 0);
  if (!codes.some((code) => BRIEF_INVISIBLE.test(String.fromCodePoint(code)))) return value;
  const kept = keep(codes);
  return codes
    .map((code, index) => {
      const char = String.fromCodePoint(code);
      if (!BRIEF_INVISIBLE.test(char) || kept.has(index)) return char;
      return `[U+${code.toString(16).toUpperCase().padStart(4, '0')}]`;
    })
    .join('');
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
