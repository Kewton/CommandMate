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
// Issue #782: stash + reset/revert (Phase 4/5 - Danger Zone)
// =============================================================================

/**
 * Maximum accepted `index` for the stash pop/apply/drop routes (Issue #782).
 * The index is validated to be `/^\d+$/` and <= this bound before it is
 * embedded into the `stash@{N}` argv (DoS / absurd-index defense). Mirrors the
 * MAX_GIT_FILES (#780) / MAX_BRANCH_REF_LENGTH (#781) bounding pattern.
 */
export const MAX_STASH_INDEX = 1000;

// =============================================================================
// Issue #783: network operations (Phase 5/5 - push / pull / fetch)
// =============================================================================

/**
 * Timeout (ms) for `git fetch`. Larger than the 1s `GIT_COMMAND_TIMEOUT_MS`
 * (status read) and the 30s `GIT_WRITE_TIMEOUT_MS` line: a fetch contacts the
 * remote and may run longer than a local index write. fetch is NOT serialized
 * (§6.1) — it only updates remote-tracking refs / packed-refs.
 */
export const GIT_FETCH_TIMEOUT_MS = 30000;

/**
 * Timeout (ms) for `git pull`. 60s because a pull does a fetch AND a merge/rebase
 * over the working tree (slower than a bare fetch). Serialized per worktree.
 */
export const GIT_PULL_TIMEOUT_MS = 60000;

/**
 * Timeout (ms) for `git push`. 60s because a push uploads objects to a remote
 * over the network (the slowest network op). Serialized per worktree.
 */
export const GIT_PUSH_TIMEOUT_MS = 60000;

/**
 * DR1-003: This is NOT a server progress-polling interval. There is NO server
 * progress endpoint; the route holds the git process until completion and the
 * awaited Promise is the only true state-transition source. This constant is an
 * OPTIONAL client-side elapsed-time tick (zero server round-trips) used only to
 * re-render the elapsed seconds while a network op is in-flight. A plain spinner
 * is sufficient, so this may go unused. The name is kept for compatibility with
 * the Issue body's "progress polling" wording (its true role is documented here).
 */
export const GIT_PROGRESS_POLL_INTERVAL_MS = 1000; // optional elapsed-time tick (in-flight only; NOT server progress)

// Issue #1277: the GitPane warning/guidance strings that used to live here
// (CHECKOUT_*_WARNING / RESET_HARD_HISTORY_LOSS_WARNING /
// DANGER_ZONE_RUNNING_SESSION_WARNING / PUSH_AUTH_FAILED_GUIDANCE /
// PUSH_PROTECTED_BRANCH_WARNING) were hardcoded Japanese rendered to every
// locale. They now live in the `worktree` dictionary under `git.*` and are
// resolved with useTranslations at the render site. Do not reintroduce
// user-facing prose in this config module.
