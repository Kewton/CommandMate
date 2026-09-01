/**
 * The vocabulary shared by the hook receiver, the injected settings generator
 * and the in-memory session state (Issue #1722).
 *
 * Split out of `agent-event-service` so the pieces that only need the words —
 * the settings generator, `lib/session/agent-event-state` — can have them
 * without pulling in SQLite, the task state machine and the verification
 * runner. `agent-event-service` re-exports everything here, so existing
 * importers are unaffected.
 *
 * **Nothing here names a tool.** It used to: `CLAUDE_HOOK_EVENT_NAMES` and
 * `extractClaudeEventDetail` lived beside the words until Issue #1759 moved
 * them to `lib/hooks/sources/hook-event-vocabulary`, where a source *selects*
 * them. One tool's spellings sitting in the module every tool-agnostic consumer
 * imports is how the next tool ends up appended to the same table instead of
 * bringing its own — the copy-paste Epic #1720 exists to stop.
 *
 * @module lib/hooks/agent-event-types
 */

/**
 * Event kinds accepted by `POST /api/hooks/agent-event`.
 *
 * `stop` is the only one that moves anything. The rest are accepted, recorded
 * and exposed for observation; wiring them into `sessionStatus` / `wait` /
 * Auto-Yes is Issue #1723's job, deliberately kept separate so a change to the
 * completion verdict is never a side effect of adding a receiver (#1549).
 *
 * `pre_tool_use` / `post_tool_use` (Issue #1726) are the two events received for
 * a *specific* tool rather than for the session: the injected hooks carry
 * `matcher: "AskUserQuestion"`, so they bracket the agent asking the human a
 * question — the first carries the question and its options in `tool_input`, the
 * second says the call is over. Both are observations; this receiver never
 * answers either with a decision.
 */
export const AGENT_EVENT_TYPES = [
  'stop',
  'notification',
  'session_start',
  'user_prompt_submit',
  'session_end',
  'pre_tool_use',
  'post_tool_use',
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export function isAgentEventType(value: unknown): value is AgentEventType {
  return typeof value === 'string' && (AGENT_EVENT_TYPES as readonly string[]).includes(value);
}

/** Bound on the stored `detail`; every observed value is a short enum-ish word. */
export const MAX_EVENT_DETAIL_LENGTH = 128;

/**
 * The `notification` detail meaning "the approval dialog has been answered"
 * (Issue #1898).
 *
 * A fourth word beside `permission_prompt` / `idle_prompt` / an error, and the
 * only one that is *not* a report that something needs a human — it is the
 * report that something no longer does. Named here rather than in a source's
 * own file because two unrelated callers have to agree on it: the source that
 * maps the agent's own "somebody replied" frame, and the adjudicator that
 * delivered a verdict itself. `lib/session/agent-event-state` keys its
 * prompt-waiting release off exactly this string.
 *
 * Nothing here names a tool, and this does not either: any source that can
 * observe an approval being answered may publish it. Whether observing one
 * settles anything is the source's
 * `AgentSourceCapabilities.permissionReplyReleasesPrompt` to declare.
 */
export const PERMISSION_REPLIED_DETAIL = 'permission_replied';

/**
 * Who writes conversation history for a tool, besides the screen scraper
 * (Issue #2197).
 *
 * The scraper in `lib/polling/response-checker` has always been the only writer
 * of `chat_messages`, because for most tools the terminal is the only place the
 * reply exists. Two tools now have a second, better-informed writer, and they
 * differ in the one way that decides how the poller has to ask about them:
 *
 *  - `'push'` — the agent's own server is already streaming the reply into
 *    History, so the only question is whether that connection is live.
 *    opencode, since #2041.
 *  - `'pull'` — the agent keeps its own transcript on disk and nothing reads it
 *    until something asks, so the question is "record this turn now, and tell me
 *    whether you did". claude since #2121, codex since this Issue.
 *  - `null` — nobody but the scraper. The answer for a tool nobody has written a
 *    reader for, and the answer the compatibility relay gives.
 *
 * A word rather than a boolean because the two shapes are asked *different
 * questions* by `lib/polling/structured-history-gate`, and a boolean would make
 * the gate guess which one from the tool id — which is the branch this word
 * exists to delete.
 */
export type TranscriptHistoryMode = 'pull' | 'push' | null;

declare module './sources/types' {
  /**
   * `transcriptHistory`, declared here rather than beside the other seven
   * capabilities.
   *
   * The word and the field move together: a source that declares `'pull'` is
   * promising that `structured-history-gate` has a reader to dispatch to, and
   * the gate reads the word out of this module. Keeping the two in one file is
   * what stops a later tool declaring a mode the gate has never heard of.
   *
   * Declaration merging rather than a plain field because `./sources/types`
   * imports {@link AgentEventType} from here — the vocabulary is upstream of the
   * source contract, and reversing that to put the word next to the field would
   * make the tool-agnostic module depend on the source interface.
   */
  interface AgentSourceCapabilities {
    /**
     * Which writer, other than the scraper, records this tool's replies
     * (Issue #2197).
     *
     * Pinned by value for every source in
     * `tests/unit/hooks/sources/capabilities.test.ts`; flipping codex to `null`
     * puts its replies back on the scraped pane, which is what the mutation
     * check in that file's sibling asserts.
     */
    readonly transcriptHistory: TranscriptHistoryMode;
  }
}
