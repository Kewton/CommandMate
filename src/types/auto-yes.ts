/**
 * Shared auto-yes types (Issue #314, relocated in Issue #756).
 *
 * `AutoYesToggleParams` originally lived in `AutoYesToggle.tsx` (a TSX file).
 * It is moved here — a plain `.ts` module — so non-TSX consumers compiled under
 * `tsconfig.server.json` (which includes the `src/types` tree but does not set
 * `--jsx`) can import it without triggering TS6142. `AutoYesToggle.tsx`
 * re-exports it for backward compatibility, so existing import sites that pull
 * `AutoYesToggleParams` from the component keep working unchanged.
 */

import type { AutoYesDuration, AutoYesStopReason } from '@/config/auto-yes-config';
import type { AutoYesAnswerMode } from './auto-yes-answer-mode';

// Issue #3821: re-exported from here so every program that reads the shared
// models also reads the `autoYesDecision` field `./auto-yes-decision` declares.
export type {
  AutoYesDecisionPublished,
  AutoYesDecisionReason,
  AutoYesDecisionState,
} from './auto-yes-decision';

// Issue #3863: the answer mode, declared dependency-free for the CLI build.
export {
  AUTO_YES_ANSWER_MODES,
  DEFAULT_AUTO_YES_ANSWER_MODE,
  isAutoYesAnswerMode,
  type AutoYesAnswerMode,
} from './auto-yes-answer-mode';

/** Parameters for auto-yes toggle callback (Issue #314) */
export interface AutoYesToggleParams {
  enabled: boolean;
  duration?: AutoYesDuration;
  stopPattern?: string;
  /**
   * Issue #3863: the answer mode chosen when turning it on. Omitted means the
   * default (`recommended`) — `AutoYesToggle` names a mode only when it is not
   * the default; the worktree screen's handler sends the default explicitly.
   */
  answerMode?: AutoYesAnswerMode;
}

/**
 * One instance's Auto-Yes state as the worktree list carries it (Issue #2512).
 *
 * The same `{ enabled, expiresAt }` pair `GET /api/worktrees/:id/auto-yes`
 * answers per instance, so a surface reading the list and one reading the
 * single-worktree route cannot disagree about the shape. `expiresAt` is null
 * whenever `enabled` is false.
 */
export interface AutoYesInstanceSummary {
  enabled: boolean;
  /** Epoch ms the state expires at, or null when not enabled. */
  expiresAt: number | null;
  /**
   * Issue #3723: true when the contract governing this instance says
   * `autoYes.mode: 'off'`, so the armed poller will answer nothing. Omitted —
   * not false — otherwise, so a row with no contract is the shape it was.
   */
  blockedByContract?: boolean;
  /**
   * Issue #3730: on a DISABLED instance, why — today only `server-restart`
   * (the grant was live when the previous server process shut down). Omitted
   * otherwise. The worktree list does not put it here (its map holds armed
   * instances only) but beside it, in `autoYesStopReasonByInstance`; the
   * single-worktree `GET .../auto-yes` map and the browser's per-instance
   * state carry it in this field.
   */
  stopReason?: AutoYesStopReason;
  /**
   * Issue #3863: the answer mode of an ENABLED instance (`recommended` /
   * `careful`), on the browser's per-instance state. Omitted when not enabled,
   * and by a server older than the field. The worktree list's entries do not
   * carry it (their shape is pinned, #2512); `GET .../auto-yes` answers it
   * in `answerModeByInstance`.
   */
  answerMode?: AutoYesAnswerMode;
}
