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

import { getServerPort } from '@/lib/env';
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
 * The variable a CommandMate CLI run inside an agent resolves its server from
 * (Issue #2403).
 *
 * `src/cli/utils/server-url.ts` resolves a destination as `process.env` first,
 * `~/.commandmate/.env` second — the documented precedence from #1743, which is
 * what makes `CM_PORT=3011 commandmate ls` work. #2403 measured what that
 * precedence costs when two servers share one tmux server: the tmux server's
 * *global* environment carries whichever `CM_PORT` the server that started it
 * had, every pane's `-zsh` inherits it, and an agent launched by the OTHER
 * server therefore types `commandmate` at a destination that is not the server
 * that launched it. The measured split was hooks on 60301 and the CLI on 3000 —
 * `whoami` right (it reads the tmux session name), `ls` and `instances` wrong,
 * and `ask` returning exit 0 from the wrong database, so no caller could tell.
 *
 * The launch line is the one place that outranks the inherited environment, so
 * the launching server states its own port there. {@link resolveAgentLaunchEnv}
 * is what writes it and carries the rule about when.
 *
 * Listed here, beside `CODEX_HOME`, rather than in
 * {@link AGENT_CORRELATION_ENV_VARS}: see that decision below.
 */
export const SERVER_PORT_ENV_VAR = 'CM_PORT';

/**
 * The other thing a launch line carries: config the agent — and everything it
 * spawns — is meant to keep.
 *
 * Two names, and the same test: neither is a credential and neither is an
 * *identity*, so both are deliberately **not** stripped from CommandMate's own
 * child processes by `lib/security/env-sanitizer`.
 *
 *  - `CODEX_HOME` is a per-tool HOME/config redirect, set by a source so the
 *    agent resolves the same settings file CommandMate just wrote. A child that
 *    inherits one is unaffected.
 *  - {@link SERVER_PORT_ENV_VAR} says which CommandMate server this process
 *    belongs to. #2403 put it here rather than on the correlation list on
 *    purpose, and the reason is inheritance: a correlation variable answers
 *    "which agent is this?", which a child is not, and #1996 strips all six
 *    precisely so a relay firing from a grandchild cannot claim the agent's
 *    identity. `CM_PORT` answers "which server do I dial?", and the right
 *    answer for a descendant is *the same one* — a `commandmate send` typed by
 *    a shell the agent spawned must reach the server that launched the agent.
 *    Stripping it would recreate the bug one level down, and would also delete
 *    an operator-facing variable (#1743) from every child of the server.
 *
 *    Measured, not assumed: because `CM_PORT` is on this list,
 *    `sanitizeEnvForChildProcess()` is byte-identical to what it returned
 *    before #2403, so none of its six call sites
 *    (`assistant/non-interactive-runner`, `updates/agent-updater`,
 *    `cli-tools/copilot-executable`, `slash-command-catalog`,
 *    `detection/version-probes`, `session/claude-executor`) can change
 *    behaviour. `tests/unit/security/child-process-server-port-2403.test.ts`
 *    asserts that with a real child process.
 *
 * **Still not `COPILOT_HOME` or `XDG_CONFIG_HOME`.** #1933's test carried a
 * local allowlist of `CODEX_HOME` / `COPILOT_HOME` / `XDG_CONFIG_HOME`;
 * building the seven plans shows only the first is ever written. `COPILOT_HOME` and `XDG_CONFIG_HOME` are
 * *read* from the ambient environment by `copilot/hook-settings` and the
 * antigravity config writer to decide where a file goes — they never reach
 * `plan.env`. An allowlist wide enough to admit them would wave through a source
 * that started setting one, which is the opposite of what this list is for.
 *
 * Enumerated for the same reason as the list above: so the drift guard can
 * subtract it and hold the remainder to an exact set.
 */
export const AGENT_LAUNCH_CONFIG_ENV_VARS: readonly string[] = [
  'CODEX_HOME',
  SERVER_PORT_ENV_VAR,
];

/**
 * The environment a launch line actually carries: the plan's own, plus this
 * server's port (Issue #2403).
 *
 * A source's `prepareLaunch` builds `plan.env` out of what it knows about *its
 * tool*. Which server is running is not that — it is the same fact for all
 * seven sources, and seven copies of it would be seven chances to forget one.
 * Two sources would have had to grow an environment they do not otherwise have
 * (claude keeps its correlation keys inside the `--settings` file, opencode
 * puts its port in argv), and those two are exactly where the reported failure
 * was found. So it belongs at the one place that already exists for
 * "everything a launch line carries", which is this module.
 *
 * **`getServerPort()`, unconditionally.** The same call the hook URL on the
 * same line is built from (#1722), so the two cannot name different servers —
 * including in the degenerate case where `CM_PORT` is unusable and both fall
 * back to 3000 together. Writing it when nothing was configured is not a guess:
 * a server given no `CM_PORT` really is listening on 3000, and the pane it
 * launches an agent into really can have inherited some other server's port
 * from the tmux server's global environment. A pin that only fired when
 * `CM_PORT` was set would leave that case — the unconfigured server as the
 * *victim* — broken.
 *
 * **Appended, never overriding.** A source that names `CM_PORT` itself has said
 * something more specific than "the server that launched me", and keeps it.
 * Appending also leaves every existing assignment in its existing position, so
 * codex's `CODEX_HOME` is still the first thing on its line and the correlation
 * URLs are still where a reader of a `ps` line expects them.
 *
 * @param plan - What the source's `prepareLaunch` returned
 * @returns A copy of `plan.env` with {@link SERVER_PORT_ENV_VAR} appended,
 *   unless the plan named it first
 */
export function resolveAgentLaunchEnv(plan: AgentLaunchPlan): Record<string, string> {
  if (SERVER_PORT_ENV_VAR in plan.env) return plan.env;
  return { ...plan.env, [SERVER_PORT_ENV_VAR]: String(getServerPort()) };
}

/**
 * Turn a plan into the line a shell can run.
 *
 * Assignments come out in declaration order — `Record` preserves insertion
 * order for string keys — so a plan that puts `CODEX_HOME` first still renders
 * it first, which is what keeps this a refactor rather than a change of bytes.
 * Values are quoted; names are not, because a name that needed quoting would
 * not be a name a shell would assign.
 *
 * Since #2403 the environment rendered is {@link resolveAgentLaunchEnv}'s, not
 * `plan.env` directly — the difference is this server's own `CM_PORT`, added
 * last.
 *
 * The empty-assignment branch survives because the renderer is a total
 * function on plans, not because any plan reaches it: since #2403 every
 * resolved environment names at least the port.
 *
 * @param plan - What the source's `prepareLaunch` returned
 * @returns `NAME='value' … command`, or just `command` when there is no
 *   environment to apply
 */
export function renderAgentLaunchCommand(plan: AgentLaunchPlan): string {
  const assignments = Object.entries(resolveAgentLaunchEnv(plan)).map(
    ([name, value]) => `${name}=${shellQuote(value)}`
  );
  if (assignments.length === 0) return plan.command;
  return `${assignments.join(' ')} ${plan.command}`;
}
