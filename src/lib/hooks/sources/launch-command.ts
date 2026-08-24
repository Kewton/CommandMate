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
 * The `CM_HOOK_*` variables CommandMate sets on a launch line.
 *
 * Enumerated so the launch-line pin (受入条件 S8) has one list to check rather
 * than a grep. A name that is here and not on the launch line is a hook reading
 * a value CommandMate never wrote.
 *
 * **This is a subset, not the launch line.** Issue #1942 read this list as
 * "the correlation variables", which it is not and has never been: the
 * measurement in `tests/unit/lib/agent-launch-plan-secrets-1933.test.ts` finds
 * six identity variables across the seven sources and only these two are in
 * CommandMate's `CM_HOOK_` namespace. The whole set is
 * {@link AGENT_CORRELATION_ENV_VARS}, and that is the list a caller asking
 * "what identifies this agent?" wants.
 *
 * What this list is still for is the namespace invariant: **every entry must
 * start with `CM_HOOK_`** (Issue #1942), because that prefix is what
 * `lib/security/env-sanitizer` strips without needing to know the name. A
 * `CM_HOOK_*` variable invented next year is covered by the prefix alone; one
 * invented outside it has to be added to {@link AGENT_CORRELATION_ENV_VARS} and
 * to the sanitizer's own copy, and the drift guard named below is what says so.
 */
export const COMMANDMATE_HOOK_ENV_VARS: readonly string[] = [
  AGENT_EVENT_URL_ENV_VAR,
  HOOK_PORT_ENV_VAR,
];

/**
 * Every variable an `AgentLaunchPlan.env` uses to say **which server this agent
 * reports to and as which instance** (Issue #1996).
 *
 * The four beyond {@link COMMANDMATE_HOOK_ENV_VARS} are spelled as literals here
 * rather than imported from the sources that write them (`codex/hooks-config`,
 * `copilot/hook-settings`, `antigravity/hooks-config`) because a plan is data,
 * not a schema: this module renders `plan.env`, it does not know how any source
 * built it. Importing three source modules to collect four strings would give
 * `launch-command` a dependency on every tool it renders for, which is the
 * coupling `AgentLaunchPlan` exists to avoid.
 *
 * What binds the literals to reality is a measurement, not the type system.
 * `tests/unit/lib/agent-launch-plan-secrets-1933.test.ts` builds all seven
 * plans and asserts their env keys are exactly this list plus
 * {@link AGENT_LAUNCH_CONFIG_ENV_VARS}. A source that adds a variable, drops
 * one, or renames one turns that test red and names it.
 *
 * `lib/security/env-sanitizer` keeps its own copy as
 * `AGENT_CORRELATION_ENV_KEYS` and strips all of them. The two are joined by a
 * test rather than an import, for the reason that file's module comment gives.
 * Sorted, so a set diff reads cleanly.
 */
export const AGENT_CORRELATION_ENV_VARS: readonly string[] = [
  'CM_AGENT_INSTANCE_ID',
  'CM_AGENT_TOOL',
  'CM_AGENT_WORKTREE_ID',
  HOOK_PORT_ENV_VAR,
  AGENT_EVENT_URL_ENV_VAR,
  'CM_PERMISSION_HOOK_URL',
];

/**
 * The other thing a launch line carries: where a tool reads its own settings.
 *
 * A per-tool HOME/config redirect, set by a source so the agent resolves the
 * same settings file CommandMate just wrote — codex's `CODEX_HOME` is the whole
 * of it today. Deliberately **not** stripped from CommandMate's child
 * processes: a redirect is neither a credential nor an identity, and a child
 * that inherits one is unaffected.
 *
 * **One name, measured, not three.** #1933's test carried a local allowlist of
 * `CODEX_HOME` / `COPILOT_HOME` / `XDG_CONFIG_HOME`; building the seven plans
 * shows only the first is ever written. `COPILOT_HOME` and `XDG_CONFIG_HOME` are
 * *read* from the ambient environment by `copilot/hook-settings` and the
 * antigravity config writer to decide where a file goes — they never reach
 * `plan.env`. An allowlist wide enough to admit them would wave through a source
 * that started setting one, which is the opposite of what this list is for.
 *
 * Enumerated for the same reason as the list above: so the drift guard can
 * subtract it and hold the remainder to an exact set.
 */
export const AGENT_LAUNCH_CONFIG_ENV_VARS: readonly string[] = ['CODEX_HOME'];

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
