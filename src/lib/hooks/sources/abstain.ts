/**
 * What it costs to not decide (Issue #1759, constraint C3).
 *
 * Auto-Yes v2 abstains constantly — it is off, the worktree has no policy, the
 * payload did not parse, the tool is `AskUserQuestion`. On Claude that is free:
 * #1721 D5 measured an empty reply as indistinguishable from having no hook, so
 * the dialog appears and a human answers it. The rule the codebase learned from
 * that measurement is "when in doubt, say nothing", and it is written into
 * comments in several files.
 *
 * **That rule is false on two of the six tools.**
 *
 * - opencode waits, with no timeout at all. #1758 §5.5.3 left a permission
 *   unanswered for 10 minutes 19 seconds and it was still pending; the session
 *   does not fall through to a TUI prompt, because the TUI prompt and the API
 *   request are the same pending object. Abstaining stops the agent silently.
 * - antigravity reads an empty `{}` as a *denial* and refuses the tool call
 *   (#1757 P10, confirmed against a hooks-free control run). Its `PreToolUse`
 *   `decision` field is required, and "required" turns out to mean fail-closed.
 *
 * Neither failure produces an error anywhere. The session just stops, which is
 * the same thing a thinking agent looks like. So abstention has to be a
 * decision the caller makes knowingly, and this module is the thing that makes
 * it knowing: it reads {@link AgentEventSource.noDecision} and says, in one
 * struct, whether silence is safe and what to tell the operator when it is not.
 *
 * @module lib/hooks/sources/abstain
 */

import type { AgentEventSource, NoDecisionBehavior } from './types';

/** What abstaining does to this source's agent. */
export interface AbstainOutcome {
  /**
   * Whether the agent carries on by itself.
   *
   * `false` means abstaining is an action with a consequence — the caller owes
   * the operator a visible signal, because nothing else will produce one.
   */
  safe: boolean;
  /** How long the agent waits before giving up, or null when it never does. */
  blocksForMs: number | null;
  /** One line, for a log or a warning banner. */
  summary: string;
}

/**
 * Judge one {@link NoDecisionBehavior}.
 *
 * Split from {@link describeAbstain} so a source can be judged before it exists
 * — Phase 4-2…4-5 tests a spec's declared value without constructing anything.
 */
export function describeNoDecision(behavior: NoDecisionBehavior): AbstainOutcome {
  switch (behavior.kind) {
    case 'proceeds':
      return {
        safe: true,
        blocksForMs: 0,
        summary: 'the agent continues with its own approval flow',
      };
    case 'blocks':
      return {
        safe: false,
        blocksForMs: null,
        summary: 'the agent waits indefinitely; nothing else will unblock it',
      };
    case 'blocksUntil':
      return {
        safe: false,
        blocksForMs: behavior.timeoutMs,
        summary: `the agent waits up to ${behavior.timeoutMs}ms before continuing`,
      };
  }
}

/**
 * What happens if this source is given no verdict.
 *
 * @param source - The source about to be abstained on
 * @returns Whether silence is safe, and the sentence to log when it is not
 */
export function describeAbstain(source: AgentEventSource): AbstainOutcome {
  return describeNoDecision(source.noDecision);
}

/**
 * Shorthand for the common guard.
 *
 * @returns Whether abstaining leaves the agent able to make progress
 */
export function isAbstainSafe(source: AgentEventSource): boolean {
  return describeAbstain(source).safe;
}
