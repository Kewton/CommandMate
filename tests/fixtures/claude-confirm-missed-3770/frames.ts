/**
 * Claude `AskUserQuestion` confirmation pages that `isClaudeAskUserQuestionConfirmPage`
 * (Issue #3748) does NOT recognise today (Issue #3770, item 1).
 *
 * SYNTHETIC, not captured: built by hand from the shape of the live 2.1.268
 * page (`../claude-live-2486/tabs-preview-review.txt`) with one thing changed
 * each. Nothing here is evidence of how Claude really draws these cases; they
 * are the scaffold for loosening the predicate once a live capture exists.
 * Until then the predicate is deliberately strict, and a test pins that.
 */

const TAB_ROW = '←  ☒ Goal  ☒ Scope  ✔ Submit  →';
const QUESTION = 'Ready to submit your answers?';
const OPTIONS = ['❯ 1. Submit answers', '  2. Cancel'];

function page(parts: { head?: string[]; question?: string; tail?: string[] }): string {
  return [
    ...(parts.head ?? [TAB_ROW, '', '● Your answers', '  → one']),
    '',
    parts.question ?? QUESTION,
    '',
    ...OPTIONS,
    ...(parts.tail ?? []),
    '',
  ].join('\n');
}

/** Control: the shape the predicate reads (must stay true). */
export const CONFIRM_PAGE_CONTROL = page({});

/** The tab bar wrapped onto two rows (narrow pane or long headings): `✔ Submit` is on the second. */
export const CONFIRM_PAGE_TAB_ROW_WRAPPED = page({
  head: ['←  ☒ A very long first heading  ☒ A very long second heading', '☒ Third  ✔ Submit  →', '', '● Your answers', '  → one'],
});

/** The tab bar more than 200 rows above the question. */
export const CONFIRM_PAGE_TAB_ROW_FAR_ABOVE = page({
  head: [TAB_ROW, ...Array.from({ length: 205 }, (_, i) => `  answer line ${i}`)],
});

/** An unknown footer under `2. Cancel`. */
export const CONFIRM_PAGE_UNKNOWN_FOOTER = page({ tail: ['', 'Enter to select · ↑/↓ to navigate · Esc to cancel · Tab to amend'] });

/** The question row carries more than the exact sentence. */
export const CONFIRM_PAGE_QUESTION_REWORDED = page({ question: 'Ready to submit your answers? (2 questions)' });

/** Scrolled so the head, tab bar included, is cut off. */
export const CONFIRM_PAGE_HEAD_SCROLLED_OFF = ['  → one', '', QUESTION, '', ...OPTIONS, ''].join('\n');
