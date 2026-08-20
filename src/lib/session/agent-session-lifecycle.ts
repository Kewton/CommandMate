/**
 * The one call every agent's `startSession` makes when it creates a pane
 * (Issue #1759, seam S8).
 *
 * `beginAgentEventGeneration` fences a recreated session off from the previous
 * process's events: the state is keyed by (worktree, tool, instance), a key the
 * new session reuses verbatim, so without the fence the *old* process's last
 * `user_prompt_submit` reads as the new one's and a freshly started session
 * publishes `running` before anybody has typed into it (#1723).
 *
 * Before this Issue there was exactly one call to it in the entire codebase —
 * `claude-session.ts`, on the creation path. Every other tool starts through
 * its own `startSession` in `src/lib/cli-tools/<tool>.ts` and has no fence at
 * all. That was invisible while Claude was the only tool emitting events, and
 * becomes a real defect the moment Phase 4-2 lands: codex would inherit the
 * previous codex process's verdict on every restart.
 *
 * So the fence is a helper a `startSession` can call without knowing anything
 * about the event system, and Claude's call now goes through it. Adding a tool
 * means adding this one line to that tool's creation path — see
 * `docs/design/agent-event-source-interface.md`.
 *
 * ## Where it goes in `startSession`
 *
 * On the **creation** path only, and **before** the pane is created:
 *
 *  - not on the reuse path — a `startSession` that finds a healthy session and
 *    returns is the same generation, and fencing there would throw away a
 *    still-valid verdict on every reconnect;
 *  - before creation, so there is no window in which a live pane is judged
 *    against a stale generation;
 *  - unconditionally, even if the launch then fails — falling back to the
 *    screen scraper is always safe, and trusting a dead session's events is
 *    not.
 *
 * @module lib/session/agent-session-lifecycle
 */

import { getAgentEventSource, renderAgentLaunchCommand } from '@/lib/hooks/sources';
import type { AgentInstanceRef, AgentLaunchContext, AgentLaunchPlan } from '@/lib/hooks/sources';
import { beginAgentEventGeneration } from '@/lib/session/agent-event-state';
import { createLogger } from '@/lib/logger';

const logger = createLogger('lib/session/agent-session-lifecycle');

/**
 * Open a new event generation for an agent instance that is about to start.
 *
 * Safe to call for a tool that emits nothing: the fence is a timestamp, and a
 * tool with no events simply never has any to fence.
 *
 * @param target - The instance being created
 * @param at - Epoch ms; defaults to now
 */
export function beginAgentSession(target: AgentInstanceRef, at: number = Date.now()): void {
  beginAgentEventGeneration(target.worktreeId, target.cliToolId, target.instanceId, at);

  const source = getAgentEventSource(target.cliToolId);
  logger.info('agent-session-generation-begun', {
    worktreeId: target.worktreeId,
    cliToolId: target.cliToolId,
    instanceId: target.instanceId ?? target.cliToolId,
    transport: source.transport,
  });
}

/**
 * The command that starts this agent, with whatever config it needs written
 * first (S3 / S4).
 *
 * A thin pass-through to the tool's source, and the reason a session module
 * does not import a settings generator: which file gets written, and whether
 * one gets written at all, is the source's business.
 *
 * Never throws — see `AgentEventSource.prepareLaunch`. A tool whose config
 * could not be written starts bare, which is the pre-#1722 status quo.
 *
 * @param context - The instance, its executable, and the worktree it runs in
 * @returns The command, its environment, and the config file when one landed
 */
export function prepareAgentLaunch(context: AgentLaunchContext): AgentLaunchPlan {
  return getAgentEventSource(context.target.cliToolId).prepareLaunch(context);
}

/**
 * The single line a `startSession` types into its pane (Issue #1846).
 *
 * `prepareAgentLaunch` returns a plan whose environment is *data*; this is the
 * one function that turns that data into shell assignments. Before #1846 four
 * sources each wrote their own `NAME=value ` prefix onto `plan.command`, so
 * "does this launcher apply the environment?" was answered four times, by
 * accident, and a fifth source that forgot would have produced a session whose
 * hooks fire and cannot be attributed — no error, events landing on the wrong
 * instance.
 *
 * Callers that need the settings path as well should call
 * {@link prepareAgentLaunch} and render the plan themselves; every caller in
 * `src/lib/cli-tools/` wants only the line.
 *
 * @param context - The instance, its executable, and the worktree it runs in
 * @returns `NAME='value' … command`, ready for `sendKeys`
 */
export function buildAgentLaunchCommandLine(context: AgentLaunchContext): string {
  return renderAgentLaunchCommand(prepareAgentLaunch(context));
}
