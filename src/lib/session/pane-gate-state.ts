/**
 * What a surface holds about its agent's frame, and the value of all of it
 * before anything has arrived (Issue #3304).
 *
 * Two hooks poll `/current-output` and keep these facts: the pane hook
 * (`useTerminalPanePolling` — every PC split, the phone's terminal tab, the
 * `/sessions` tiles) and the worktree screen's controller
 * (`useWorktreeDetailController`, which feeds the phone's docked composer and
 * pads). The facts gate controls whose keys mean something else on the wrong
 * frame — `shift+tab` on a permission dialog is "allow every edit this session"
 * (#2592) — so a surface that starts looking at a DIFFERENT agent must stop
 * believing them until that agent has answered.
 *
 * Both hooks used to spell "nothing has arrived" themselves, and the controller's
 * copy put back `isSelectionListActive` alone: for one round trip after a tool
 * switch, and until the next poll after an instance switch, the phone's mode
 * button stayed enabled on the previous agent's `ready`.
 *
 * This module is the one list. A field added to {@link PaneGateState} is
 * initialised and reset on both surfaces by construction: the pane hook's state
 * extends this interface and spreads the constant, and the controller's state
 * is this shape (plus the one fact it derives because it keeps no frame).
 */

import { AGENT_MODE_UNKNOWN } from '@/types/cli-tool-contracts';

/**
 * The per-target frame facts both surfaces hold.
 *
 * Each field is documented where it is read — `PaneTerminalState` in
 * `useTerminalPanePolling` carries the long form. What they have in common is
 * that every one of them describes ONE (worktree, tool, instance) and is wrong
 * for any other.
 */
export interface PaneGateState {
  /** The merged status verdict, or `''` before a frame has landed (#2238). */
  sessionStatus: string;
  /** The permission mode read off the frame, or `'unknown'` (#2592). */
  agentMode: string;
  /** A selection list / picker is on screen (#473). */
  isSelectionListActive: boolean;
  /** Codex pager / edit-previous mode, a subset of the selection list (#1017). */
  isPagerActive: boolean;
  /** A dismiss-only overlay is on screen (#2369). */
  isDismissablePanelActive: boolean;
  /** The frame is on screen and nobody could classify it (#1017). */
  isUnclassifiedActive: boolean;
  /** Epoch ms the agent began launching, while it is still starting (#3179). */
  startingSince: number | null;
}

/**
 * {@link PaneGateState} before anything has arrived for the current target.
 *
 * No value here claims anything about a frame: `''` is not `'ready'`, so the
 * mode button is disabled; `'unknown'` draws no chip; and no flag says a dialog
 * is up, so no pad or card is drawn for a frame nobody has seen.
 */
export const PANE_GATE_NOTHING_ARRIVED = Object.freeze({
  sessionStatus: '',
  agentMode: AGENT_MODE_UNKNOWN,
  isSelectionListActive: false,
  isPagerActive: false,
  isDismissablePanelActive: false,
  isUnclassifiedActive: false,
  startingSince: null,
} as const satisfies PaneGateState);

/**
 * Whether two gate states say the same thing, field by field.
 *
 * For a holder that keeps the state as one object: a poll that repeats the
 * previous answer — most of them — can then keep the previous object and
 * re-render nobody.
 */
export function isSamePaneGateState<T extends PaneGateState>(a: T, b: T): boolean {
  return (Object.keys(a) as Array<keyof T>).every((key) => Object.is(a[key], b[key]));
}
