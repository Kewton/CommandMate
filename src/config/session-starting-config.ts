/**
 * How long a session may be shown as "starting" (Issue #3179).
 *
 * `lib/session/session-starting-state` records when an agent's launch began and
 * clears the record when `BaseCLITool.startSession` returns or throws. These
 * bounds are the escape hatches for the launches that do neither in time:
 * several tools (antigravity, codex, gemini, copilot, Command Code) only LOG
 * when their readiness wait runs out and carry on, so a launch that never
 * became ready would otherwise be shown as starting for as long as the request
 * lingered. Past the bound the screen falls back to what it showed before
 * #3179 — the raw pane — so a human notices the stuck start.
 *
 * @module config/session-starting-config
 */

import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';

/**
 * Slack added on top of a tool's own readiness wait, so the starting display
 * outlives the wait it describes by a little rather than ending a beat before
 * the launch reports.
 */
export const SESSION_STARTING_GRACE_MS = 5_000;

/**
 * The default readiness wait a launch performs (antigravity / codex / gemini /
 * copilot / opencode / Command Code are all measured at about 30 s, counting
 * their initial settle delay and their prompt wait).
 */
export const SESSION_STARTING_DEFAULT_WAIT_MS = 30_000;

/**
 * Per-tool readiness waits that differ from the default. Claude waits for its
 * composer for up to `CLAUDE_INIT_TIMEOUT` (60 s); the literal is restated here
 * rather than imported so this config module stays free of the session graph.
 */
const SESSION_STARTING_WAIT_MS: Partial<Record<CLIToolType, number>> = {
  claude: 60_000,
};

/**
 * The longest a launch of `cliToolId` is shown as starting, in ms.
 *
 * @param cliToolId - The tool being launched
 * @returns Its readiness wait plus {@link SESSION_STARTING_GRACE_MS}
 */
export function getSessionStartingMaxMs(cliToolId: CLIToolType): number {
  return (SESSION_STARTING_WAIT_MS[cliToolId] ?? SESSION_STARTING_DEFAULT_WAIT_MS)
    + SESSION_STARTING_GRACE_MS;
}

/**
 * The longest {@link getSessionStartingMaxMs} over every tool, in ms.
 *
 * A send to a worktree with no session launches the agent inside the request,
 * so the client must wait at least this long (Issue #3194).
 */
export function getSessionStartingMaxMsAcrossTools(): number {
  return Math.max(...CLI_TOOL_IDS.map(getSessionStartingMaxMs));
}

/**
 * How long a dialog may stay on screen during a launch before it is treated as
 * one the server will NOT answer (a login, an unknown dialog) and the starting
 * display gives way to the raw pane.
 *
 * The dialogs the launch answers itself — the folder-trust screens of
 * antigravity / codex / copilot / claude — are answered within one poll of the
 * launch's readiness loop (≤ 1 s) plus the settle wait after the key, so they
 * never reach this bound.
 */
export const SESSION_STARTING_PROMPT_GRACE_MS = 5_000;

/**
 * After how long the client starts printing the elapsed time next to
 * "<agent> を起動中…".
 */
export const SESSION_STARTING_ELAPSED_THRESHOLD_MS = 5_000;
