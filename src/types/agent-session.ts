/**
 * What the browser is told about the conversation an instance is in (#2042).
 *
 * A structural copy of `lib/hooks/agent-session-telemetry`'s two records rather
 * than an import of them, for a mechanical reason: that module reaches the
 * agent's own server, so its module graph pulls in `fs` and `crypto` and it
 * cannot be imported from a `'use client'` component. The shapes are the wire's,
 * so they are declared where the wire is read.
 *
 * Every field is optional or nullable and the reason is the same one the CLI
 * mirror gives: this describes what a *server* answered, and the server may be
 * older than the page talking to it.
 *
 * @module types/agent-session
 */

/** The token counts as the agent reports them, flattened. Nulls are "not said". */
export interface AgentSessionTokensView {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /**
   * The agent's own total, or null.
   *
   * Null on every record a server writes today — opencode declares `total` on an
   * assistant message and not on a `Session` — and deliberately not filled in by
   * the server from the other five. {@link sumAgentSessionTokens} is where the
   * display layer does that sum, and says so.
   */
  total: number | null;
}

/** `structuredEvents.session` — the agent's own description of its session. */
export interface AgentSessionView {
  id: string | null;
  title: string | null;
  /** The persona driving the session (opencode's `build` / `plan` / …). */
  agent: string | null;
  model: string | null;
  provider: string | null;
  /** Cumulative for the session, in the agent's own unit (USD for opencode). */
  cost: number | null;
  /** **Cumulative for the session.** See {@link AgentSessionContextView}. */
  tokens: AgentSessionTokensView;
  at: number;
}

/**
 * `structuredEvents.sessionContext` — how full the window is.
 *
 * Not the same quantity as {@link AgentSessionView.tokens}, which is what the
 * session has spent in total. This is the last finished assistant turn's
 * footprint, which is what opencode's own footer shows as `8.5K (1%)`.
 */
export interface AgentSessionContextView {
  tokens: number | null;
  limit: number | null;
  percent: number | null;
  sessionAt: number;
  at: number;
}

/** The pair, as one pane reports it. Either half may be missing. */
export interface AgentSessionSnapshot {
  session: AgentSessionView | null;
  context: AgentSessionContextView | null;
}

/**
 * The tokens this session has spent in total, or null.
 *
 * **This is the display layer summing five numbers the server publishes
 * separately, and it is the only place that does.** The server refuses to: a
 * `total` it invented would be a number no agent stands behind, and
 * `AgentSessionTokensView.total` stays the agent's own declaration (null today).
 * Here the sum is a rendering decision with a checkable answer — it is what
 * `opencode stats` prints for the same session, measured at `input 6 / output 11
 * / cache.read 8482 / cache.write 8500` → `17.0K`.
 *
 * Nulls are skipped rather than counted as zero, and an all-null usage answers
 * null rather than `0`: a session that has not run a turn has not spent nothing,
 * it has not said.
 */
export function sumAgentSessionTokens(tokens: AgentSessionTokensView | null | undefined): number | null {
  if (!tokens) return null;
  if (tokens.total !== null) return tokens.total;
  const parts = [
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cacheRead,
    tokens.cacheWrite,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (parts.length === 0) return null;
  return parts.reduce((sum, value) => sum + value, 0);
}
