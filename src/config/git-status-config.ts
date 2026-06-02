/**
 * Git status polling configuration
 * Issue #779: git status API + GitPane Current Status (Phase 1/5)
 *
 * Semantic separation from file-polling-config: GitPane's Current Status
 * section polls `GET /api/worktrees/[id]/git/status` on its own cadence.
 */

/**
 * Polling interval (ms) for GitPane's Current Status section.
 * Issue #779: drives `useFilePolling` in GitPane (visibilitychange-aware).
 */
export const GIT_STATUS_POLL_INTERVAL_MS = 5000;

// =============================================================================
// Issue #780: stage / unstage / commit operations
// =============================================================================

/**
 * Timeout (ms) for git WRITE operations (add / restore --staged / commit) and
 * for the staged-status read used by those flows. Deliberately larger than the
 * 1s `GIT_COMMAND_TIMEOUT_MS` used by getGitStatus (#779) because write ops can
 * run pre-commit hooks and stage large numbers of files.
 */
export const GIT_WRITE_TIMEOUT_MS = 30000;

/**
 * Maximum number of file paths accepted in a single stage / unstage request.
 * Requests exceeding this are rejected with HTTP 400 to bound argv size and
 * per-request work.
 */
export const MAX_GIT_FILES = 1000;

/**
 * Maximum length (characters) of a commit message. Messages exceeding this are
 * rejected with HTTP 400.
 */
export const MAX_COMMIT_MESSAGE_LENGTH = 10000;

// =============================================================================
// Issue #781: branch checkout confirm-dialog warnings (GitPane)
// =============================================================================

/**
 * S3-001 history-loss warning shown in the GitPane checkout confirm dialog
 * (Issue #781). In-place checkout can rekey the worktree identity and CASCADE
 * delete chat history / memos / schedules on the next sync.
 *
 * Single source of truth: imported by both GitPane.tsx and its unit test so the
 * assertion verifies the rendered text byte-for-byte. Keep this string verbatim.
 */
export const CHECKOUT_HISTORY_LOSS_WARNING =
  '別ブランチへ切り替えると、このワークツリーに紐づくチャット履歴・メモ・スケジュールが次回同期時に失われる可能性があります';

/**
 * S3-002 running-session warning shown in the GitPane checkout confirm dialog
 * (Issue #781) when any `sessionStatusByCli[*].isRunning` is true. Switching
 * branches changes the working files a live session is operating on.
 *
 * Single source of truth: imported by both GitPane.tsx and its unit test.
 */
export const CHECKOUT_RUNNING_SESSION_WARNING =
  'このブランチに切り替えると、稼働中のセッションの作業ファイルが変化します。';

// =============================================================================
// Issue #782: stash + reset/revert (Phase 4/5 - Danger Zone)
// =============================================================================

/**
 * Maximum accepted `index` for the stash pop/apply/drop routes (Issue #782).
 * The index is validated to be `/^\d+$/` and <= this bound before it is
 * embedded into the `stash@{N}` argv (DoS / absurd-index defense). Mirrors the
 * MAX_GIT_FILES (#780) / MAX_BRANCH_REF_LENGTH (#781) bounding pattern.
 */
export const MAX_STASH_INDEX = 1000;

/**
 * S3-001 history-loss warning shown in the GitPane Danger Zone Reset confirm
 * dialog for `mode='hard'` (Issue #782). A hard reset discards uncommitted work
 * AND can move HEAD off committed work.
 *
 * Single source of truth: imported by both GitPane.tsx and its unit test so the
 * assertion verifies the rendered text byte-for-byte. Keep this string verbatim.
 */
export const RESET_HARD_HISTORY_LOSS_WARNING =
  'ハードリセットは未コミットの変更を完全に破棄し、HEAD を移動するとコミットも失われる可能性があります。この操作は取り消せません。';

/**
 * S3-006 running-session warning shown on the Danger Zone Reset (especially
 * hard) / Revert / Stash drop confirmations (Issue #782) when any
 * `sessionStatusByCli[*].isRunning` is true. A live CLI session is operating on
 * the working tree these operations rewrite.
 *
 * Single source of truth: imported by both GitPane.tsx and its unit test.
 */
export const DANGER_ZONE_RUNNING_SESSION_WARNING =
  'この危険な操作は、稼働中のセッションが編集中の作業ファイルを破壊的に書き換えます。';
