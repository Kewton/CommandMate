/**
 * How Auto-Yes answers a question the agent asks (Issue #3863).
 *
 * - `recommended` (おまかせ, the default) — a single-select question on the
 *   screen is answered too: the option whose title ends in a recommendation
 *   marker (`(Recommended)` / `（推奨）` / `(推奨)`), or the default (the
 *   cursor, else option 1) when none does. A question it cannot read that far
 *   (two markers, a marker on a free-text or multi-select row, a title it
 *   cannot tell from its description) is left to a human.
 * - `careful` (慎重) — a question is never answered; it is left to a human
 *   (`question-left-to-human`).
 *
 * The two differ only there. Permissions are answered alike (the one "allow
 * this call once" row, #3822), and what a contract's `autoYes` block withholds
 * stays withheld under either (the contract is the ceiling; the answer mode is
 * below it).
 *
 * Set each time Auto-Yes is turned on (worktree × instance). Turning it on
 * from off — or after it ran out — starts at `recommended` unless a mode is
 * given; turning it on again while it is on keeps the mode it has.
 *
 * Dependency-free so the CLI build (`tsconfig.cli.json`, no path aliases) can
 * import it by a relative path.
 *
 * @module types/auto-yes-answer-mode
 */

/** Auto-Yes's answer mode (Issue #3863). */
export type AutoYesAnswerMode = 'recommended' | 'careful';

/** Every {@link AutoYesAnswerMode}, the default first. */
export const AUTO_YES_ANSWER_MODES: readonly AutoYesAnswerMode[] = ['recommended', 'careful'];

/** The mode of a grant that names none: one turned on without a mode, or kept from before the field. */
export const DEFAULT_AUTO_YES_ANSWER_MODE: AutoYesAnswerMode = 'recommended';

/** Type guard for a value read off a request body or the wire. */
export function isAutoYesAnswerMode(value: unknown): value is AutoYesAnswerMode {
  return value === 'recommended' || value === 'careful';
}
