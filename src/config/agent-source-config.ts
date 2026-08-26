/**
 * How the roster pane watches the machinery behind an agent pane (Issue #2054).
 *
 * @module config/agent-source-config
 */

/**
 * How often {@link AgentInstancesPane} re-reads which source is speaking for its
 * opencode rows, in ms.
 *
 * **The heartbeat's own cadence, not a UI preference.** opencode beats every
 * 10 s (#1758 §5.7.1) and the transport gives it 30 s before it calls the stream
 * dead (`OPENCODE_HEARTBEAT_TIMEOUT_MS`), so a slower poll would let a pane sit
 * on a dead stream for longer than the server took to notice, and a faster one
 * would ask three times per beat for an answer that cannot have changed.
 *
 * Only ever spent on a roster that actually contains an opencode instance — see
 * the effect that reads it — so a worktree of claude and codex panes issues no
 * request at all and the pane costs exactly what it cost before #2054.
 */
export const AGENT_SOURCE_POLL_INTERVAL_MS = 10_000;
