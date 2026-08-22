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
 * The port CommandMate's own server is listening on, read by a hook when it
 * fires rather than baked into the file it was configured from (Issue #1904,
 * 設計方針書 §10.8).
 *
 * Only copilot needs it today, and only because its configuration is one file
 * for the whole machine: a port fixed at write time makes every copilot session
 * on the machine post to whichever server started last. It is deliberately
 * *just the port*. Scheme, host and the relay script's path stay literals in
 * the generated command, because those are what decide **where** a hook's
 * bearer token goes and **which program runs**; moving them into the
 * environment would delegate both to whoever can set a variable.
 *
 * Consumers must reject a value that is not a run of digits and not fire at
 * all — never fall back to a default port. See §10.8 決定 1 and 3.
 */
export const HOOK_PORT_ENV_VAR = 'CM_HOOK_PORT';

/**
 * Every `CM_HOOK_*` variable CommandMate sets on a launch line.
 *
 * Enumerated so the launch-line pin (受入条件 S8) has one list to check rather
 * than a grep. A name that is here and not on the launch line is a hook reading
 * a value CommandMate never wrote.
 *
 * **Every entry must start with `CM_HOOK_`** (Issue #1942). That prefix is what
 * `lib/security/env-sanitizer` strips out of a child process's environment, so
 * a name outside the namespace would be declared here and still ride along into
 * `claude -p` and the CLI probes. `lib/security` does not import this list —
 * the dependency between the two packages already runs hooks → security — so
 * the invariant is held by `tests/unit/security/child-process-hook-env-1942.test.ts`
 * rather than by the type system.
 */
export const COMMANDMATE_HOOK_ENV_VARS: readonly string[] = [
  AGENT_EVENT_URL_ENV_VAR,
  HOOK_PORT_ENV_VAR,
];

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
