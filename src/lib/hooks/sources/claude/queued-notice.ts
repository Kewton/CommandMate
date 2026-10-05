/**
 * A `UserPromptSubmit` that is a queued notice joining the running turn
 * (Issue #3330).
 *
 * Claude Code queues the completion notice of a background task (a `Bash` run
 * with `run_in_background`, a subagent) and hands it to the model the next time
 * it can: after a tool result inside a running turn, or as the prompt of a turn
 * of its own when the session is idle. Either way it fires `UserPromptSubmit`
 * once per notice, and the prompt it reports is the notice — the text the
 * transcript records as `queue-operation` content, which starts with
 * `<task-notification>`.
 *
 * Measured on the server logs and transcripts of 2026-10-02 to 2026-10-05: of
 * the 188 Claude `user_prompt_submit`s applied while a turn of theirs was still
 * open, 178 matched a `queue-operation: remove` (`reason: absorbed_mid_turn`)
 * of a `<task-notification>` one for one. A prompt the operator typed into a
 * running turn is absorbed the same way but fires no hook at all (9 of 9
 * removes of other content had no delivery beside them).
 *
 * The answer is about the payload only. Whether there is a running turn to join
 * is the state's question (`applyTurnTransition`), and a notice that arrives
 * while the agent is idle opens its turn as before.
 */

/** The tag every queued background-task notice begins with. */
export const CLAUDE_TASK_NOTIFICATION_PREFIX = '<task-notification>';

/**
 * Whether this `UserPromptSubmit` payload is a queued background-task notice.
 *
 * Reads `prompt` and nothing else. A payload with no prompt — the relay
 * script's, which rebuilds the body and drops it — answers false, which is the
 * behaviour before this Issue.
 */
export function isClaudeQueuedNoticePrompt(payload: Record<string, unknown>): boolean {
  const prompt = payload.prompt;
  return typeof prompt === 'string' && prompt.trimStart().startsWith(CLAUDE_TASK_NOTIFICATION_PREFIX);
}
