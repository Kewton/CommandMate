/**
 * The one place an {@link AgentLaunchPlan}'s environment is applied
 * (Issue #1846, 申し送り 2).
 *
 * Before this module, four of the six sources — codex, copilot, gemini,
 * antigravity — each wrote their own `NAME=value ` prefix onto the front of
 * `AgentLaunchPlan.command` and trusted the caller to paste the result into a
 * shell. Four implementations, four independently written prefixes, one
 * assumption none of them declared: that the launcher is a shell.
 *
 * The assumption holds today, because every one of those launchers is
 * `sendKeys(sessionName, line, true)` typing into a tmux pane. It is still the
 * wrong place for the knowledge:
 *
 *  - a source whose executable is argv rather than a shell word cannot use the
 *    trick at all, and the seventh tool is as likely to be that as not;
 *  - a caller that wants to log or display the command has no way to take the
 *    assignments back off, and those values are URLs with correlation keys in
 *    them;
 *  - quoting is a shell property, and four copies of it is four chances to get
 *    a worktree path with a space in it wrong.
 *
 * So the plan declares `env` as data and this renders it, once. A source that
 * needs no environment declares `{}` and renders to its bare command, byte for
 * byte what it produced before.
 *
 * @module lib/hooks/sources/launch-command
 */

import { shellQuote } from '@/lib/hooks/hook-settings-generator';
import type { AgentLaunchPlan } from './types';

/**
 * The variable `scripts/hooks/cmate-agent-event.sh` reads its endpoint from.
 *
 * One constant since Issue #1846. codex, gemini and antigravity each carried
 * their own `'CM_HOOK_URL'` literal, which is three places for the relay's one
 * contract to drift — and the failure mode of a drifted name is a relay that
 * silently falls back to its default endpoint and attributes every event to the
 * primary instance.
 */
export const AGENT_EVENT_URL_ENV_VAR = 'CM_HOOK_URL';

/**
 * Turn a plan into the line a shell can run.
 *
 * Assignments come out in declaration order — `Record` preserves insertion
 * order for string keys — so a plan that puts `CODEX_HOME` first still renders
 * it first, which is what keeps this a refactor rather than a change of bytes.
 * Values are quoted; names are not, because a name that needed quoting would
 * not be a name a shell would assign.
 *
 * @param plan - What the source's `prepareLaunch` returned
 * @returns `NAME='value' … command`, or just `command` when `env` is empty
 */
export function renderAgentLaunchCommand(plan: AgentLaunchPlan): string {
  const assignments = Object.entries(plan.env).map(
    ([name, value]) => `${name}=${shellQuote(value)}`
  );
  if (assignments.length === 0) return plan.command;
  return `${assignments.join(' ')} ${plan.command}`;
}
