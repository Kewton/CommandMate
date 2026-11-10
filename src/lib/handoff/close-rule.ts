/**
 * The one rule for making the hand-off dialog (G-4) go away (Issue #4227 G-PR2 pr2d,
 * design `mem-ui-4227.md` §4.1.1; PM decision in `pm-return-4227-pr2c-codex.md`).
 *
 * The invariant: a decide being sent or whose result is unknown is never dropped by any
 * path that makes the dialog go away without the person's choice (send it again / drop it),
 * and while there is one the dialog stays; once a cancel has started, no new decide is sent.
 * Every path — the person's (Esc, ×, the backdrop, "cancel the end", "close", "keep the
 * session"), the cancel's answer, the plain stop's end, a switch of worktree, and the page
 * opening another "end" — asks {@link askHandoffClose} with its name. The guard
 * `tests/unit/guards/handoff-close-paths-4227.test.ts` fails when a new way of closing
 * does not.
 *
 * The open dialog registers what it holds ({@link registerHandoffHold}); the page (the
 * worktree detail hook) reads it through the same function, so neither side has a copy
 * of the rule.
 *
 * @module lib/handoff/close-rule
 */

/** What the dialog holds now. */
export interface HandoffHold {
  /** The stop is being declared or run (`end` → the existing stop → `end/observe`). */
  stopping: boolean;
  /** A decide is being sent (it may come back unknown). */
  sending: boolean;
  /** A decide whose result is unknown is kept (of this worktree or another's). */
  unknown: boolean;
  /** The request's cancel has been sent and not answered. */
  cancelling?: boolean;
}

/**
 * Why the dialog may not go away now: `stopping`, `unknown` (being sent or unknown),
 * `cancelling`, or `null` (it may).
 */
export type HandoffCloseBlock = 'stopping' | 'unknown' | 'cancelling' | null;

export function handoffCloseBlock(state: HandoffHold): HandoffCloseBlock {
  if (state.stopping) return 'stopping';
  if (state.sending || state.unknown) return 'unknown';
  if (state.cancelling) return 'cancelling';
  return null;
}

/**
 * Every path that makes the dialog go away. `person`, `cancel-answer` and `plain-stop-done`
 * are the dialog's own; `worktree-switch` and `page-end` are the page's; `dialog` is the
 * page closing it when the dialog asked (the dialog has asked already, and the page asks again).
 */
export const HANDOFF_CLOSE_PATHS = ['person', 'cancel-answer', 'plain-stop-done', 'worktree-switch', 'page-end', 'dialog'] as const;
export type HandoffClosePath = (typeof HANDOFF_CLOSE_PATHS)[number];

/** The paths the page takes without the dialog having asked: a refusal is told to the dialog. */
const PAGE_PATHS: ReadonlySet<HandoffClosePath> = new Set(['worktree-switch', 'page-end']);

export interface HandoffHolder {
  read: () => HandoffHold;
  /** Told when a page path was refused, so the dialog can say why. */
  refused?: (path: HandoffClosePath, block: Exclude<HandoffCloseBlock, null>) => void;
}

const NO_HOLD: HandoffHold = { stopping: false, sending: false, unknown: false, cancelling: false };
let holder: HandoffHolder | null = null;

/** The mounted dialog registers what it holds; the returned function unregisters it. */
export function registerHandoffHold(next: HandoffHolder): () => void {
  holder = next;
  return () => {
    if (holder === next) holder = null;
  };
}

/** What the mounted dialog holds now (nothing when no dialog is mounted). */
export function currentHandoffHold(): HandoffHold {
  return holder ? holder.read() : NO_HOLD;
}

/**
 * Asks the rule for `path`. `hold` defaults to what the mounted dialog holds now. A page
 * path that is refused is told to the dialog.
 */
export function askHandoffClose(path: HandoffClosePath, hold: HandoffHold = currentHandoffHold()): HandoffCloseBlock {
  const block = handoffCloseBlock(hold);
  if (block !== null && PAGE_PATHS.has(path)) holder?.refused?.(path, block);
  return block;
}
