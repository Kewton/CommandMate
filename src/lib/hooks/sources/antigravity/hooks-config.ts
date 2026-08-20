/**
 * The hooks CommandMate writes into `~/.gemini/config/hooks.json`, and the
 * command that launches `agy` against them (Issue #1762).
 *
 * ## One file, for the whole machine
 *
 * antigravity has no per-workspace hook configuration. #1757 §5.4.2 put a
 * differently-sized `hooks.json` at each candidate path and read agy's own
 * `loaded N named hooks from M hooks.json file(s)` log line to see which one it
 * had picked: the documented `<workspace>/.agents/hooks.json` is **never read**,
 * even in a trusted workspace with a `.git` in it, and `~/.gemini/config/hooks.json`
 * is. Always exactly one file (`from 1 hooks.json file(s)`).
 *
 * So there is no per-worktree file to write and no per-instance one either, and
 * the two obvious escapes are both closed:
 *
 *  - **Swapping `HOME`** would move agy's own state — `~/.gemini/antigravity-cli/`
 *    holds its settings, its conversation database and its credentials — and
 *    hand every session a machine it has never seen.
 *  - **Rewriting the file per launch** would race two worktrees against each
 *    other, and the loser would be whichever session started first.
 *
 * **The resolution is that the file carries no correlation at all.** It says
 * "post this event, for tool `antigravity`, to whatever `CM_HOOK_URL` names",
 * and the worktree and instance travel in the environment of each launched
 * session — see {@link buildAntigravityLaunchCommand}. One global file therefore
 * serves any number of worktrees and instances at once, and a session started
 * outside CommandMate posts to the default endpoint with a `cwd` of
 * `~/.gemini/config`, which resolves to no worktree and is dropped. A dropped
 * event is the correct outcome there; a misattributed one would not be.
 *
 * ## Which events are registered
 *
 * `SessionStart`, `PostToolUse` and `Stop` go to the fire-and-forget event
 * receiver through the relay. `PreToolUse` goes somewhere else entirely, and
 * that split is the single most important thing in this module.
 *
 * The other three are safe *and measured to be safe*, which is not the same
 * claim twice:
 *
 *  - `PostToolUse`'s documented reply is "an empty JSON object `{}`", and the
 *    spike ran it against a server that answered exactly that while tools kept
 *    executing.
 *  - `Stop`'s `decision` is also documented as required, but "**any value other
 *    than `continue` allows the agent to stop**" — and the spike's `Stop` hook
 *    answered `{}` throughout a session that ended normally.
 *  - `SessionStart` is undocumented, fires anyway, and has no reply contract.
 *
 * ## Why `PreToolUse` is not on the relay (Issue #1779)
 *
 * agy's `PreToolUse` reply contract has a *required* `decision` field, and
 * #1757 P10 measured what "required" means: a hook that answers `{}` has every
 * tool call denied. Re-measured live for #1779 against agy **1.1.12**, in an
 * isolated `HOME`, in an interactive session — a hook answering `{}` prints
 * `⚠ Tool call denied by pre-tool hook:` and the command does not run.
 *
 * `scripts/hooks/cmate-agent-event.sh` writes **nothing** to stdout (`curl …
 * >/dev/null`). That is why #1762 registered no `PreToolUse` at all. #1779
 * measured the third case the two Issues before it had not: a hook that exits 0
 * having printed *nothing* is **not** treated as `{}` — agy 1.1.12 falls
 * through to its ordinary approval flow, exactly as with no hook installed. So
 * "empty reply" and "no reply" are opposites here, and only one of them is a
 * denial.
 *
 * Either way the relay cannot *adjudicate*, because it discards the response
 * body. So `PreToolUse` is built here as an inline `curl` whose stdout is the
 * verdict — the same shape codex's `PermissionRequest` and copilot's
 * `PreToolUse` already use ({@link buildAntigravityPermissionHookCommand}).
 *
 * @module lib/hooks/sources/antigravity/hooks-config
 */

import { homedir } from 'os';
import { join } from 'path';
import { isValidInstanceId } from '@/lib/cli-tools/types';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import {
  AUTH_TOKEN_ENV_VAR,
  buildAgentEventUrl,
  buildPermissionRequestUrl,
  HOOK_TIMEOUT_SECONDS,
  isHookInjectionEnabled,
  PERMISSION_REQUEST_TIMEOUT_SECONDS,
  resolveRelayScriptPath,
  resolveTargetInstanceId,
  shellQuote,
  type HookSettingsOptions,
  type HookSettingsTarget,
} from '@/lib/hooks/hook-settings-generator';
import { createLogger } from '@/lib/logger';
// The `~/.gemini` tree belongs to gemini; agy lives inside it. The merge that
// keeps the two from erasing each other is written once, there.
import { readJsonObjectFile, writeJsonObjectFile } from '../gemini/shared-config-tree';
import { AGENT_EVENT_URL_ENV_VAR } from '../launch-command';
import { ANTIGRAVITY_CLI_TOOL_ID } from './tool-id';

const logger = createLogger('lib/hooks/sources/antigravity/hooks-config');

/**
 * The top-level key CommandMate owns in agy's named-hook map.
 *
 * agy's `hooks.json` is `{ "<hook name>": { "<Event>": [...] } }` — two levels,
 * unlike every other tool's `{ "hooks": { "<Event>": [...] } }` — and its own
 * documentation says named hooks from different sources "are merged and executed
 * sequentially". So occupying one key is the whole of co-existing with whatever
 * the user has: their `lint-checker` and `safety-gate` keep running, in the same
 * file, untouched.
 */
export const ANTIGRAVITY_HOOK_NAME = 'commandmate';

/** Matcher for the grouped events. `*` is agy's spelling of "every tool". */
export const ANTIGRAVITY_TOOL_MATCHER = '*';

/**
 * The agy events CommandMate relays to the fire-and-forget event receiver.
 *
 * `PreToolUse` is deliberately absent from *this* list and registered
 * separately: its stdout is a verdict, not an observation. See
 * {@link ANTIGRAVITY_PERMISSION_HOOK_EVENT}.
 */
export const ANTIGRAVITY_REGISTERED_HOOKS: ReadonlyArray<readonly [string, AgentEventType]> = [
  ['SessionStart', 'session_start'],
  ['PostToolUse', 'post_tool_use'],
  ['Stop', 'stop'],
];

/**
 * agy's spelling of the event whose reply is a verdict (Issue #1779).
 *
 * agy has no `PermissionRequest`. `PreToolUse` is the approval gate, the same
 * way it is for copilot, so this one event is pointed at
 * `/api/hooks/permission-request` and never reaches the event store.
 */
export const ANTIGRAVITY_PERMISSION_HOOK_EVENT = 'PreToolUse';

/** Auto-Yes v2 receiver URL, with the correlation keys already in its query. */
export const ANTIGRAVITY_PERMISSION_URL_ENV_VAR = 'CM_PERMISSION_HOOK_URL';

/**
 * `curl --max-time` for the adjudication hook, in seconds.
 *
 * Strictly under {@link PERMISSION_REQUEST_TIMEOUT_SECONDS}, which is the
 * `timeout` written into the handler, so that **CommandMate decides what a slow
 * server means rather than agy does**. If curl were allowed to outlive the
 * handler, agy would kill the hook and the reply would be the empty string —
 * which on this tool is the one output that must never be produced by accident.
 */
export const ANTIGRAVITY_PERMISSION_CURL_TIMEOUT_SECONDS = 4;

/**
 * The `timeout` written into the adjudication handler, in seconds.
 *
 * agy's own default is 30 (its bundled `hooks.md`), and the units really are
 * seconds here — the same number in gemini's file means milliseconds. Shared
 * with every other tool's permission hook so one number bounds how long a wedged
 * server can hold up an approval anywhere.
 */
export const ANTIGRAVITY_PERMISSION_TIMEOUT_SECONDS = PERMISSION_REQUEST_TIMEOUT_SECONDS;

/**
 * What the adjudication hook prints when it has no verdict to report.
 *
 * **The most important string in this module.** `ask` is agy's own word for
 * "prompt the user for permission (respects the Always Allow cache)" — i.e. the
 * behaviour of a machine with no hook installed — and it is what every failure
 * path below falls back to: a server that is down, a server that is slow, a 4xx,
 * a body that is not JSON, a body with no `decision`, and an agy session
 * CommandMate did not start.
 *
 * It is emphatically **not** `{}`, which agy reads as a denial and which would
 * stop every tool call on the machine (#1757 P10, re-measured on 1.1.12 for
 * #1779). It is also emphatically **not** `allow`: this config file is global,
 * so an `allow` fallback would mean that stopping CommandMate silently
 * auto-approves every tool call in every agy session on the machine, including
 * ones CommandMate never started. Measured live for #1779: an `ask` reply draws
 * agy's ordinary `Do you want to proceed?` dialog.
 */
export const ANTIGRAVITY_ABSTAIN_BODY = '{"decision":"ask"}';

/** Events agy wraps in a `matcher` + `hooks` group; the rest are flat handler lists. */
const ANTIGRAVITY_GROUPED_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse']);

/** One handler. agy supports `type` (command only) / `command` / `timeout`. */
export interface AntigravityHookHandler {
  type: 'command';
  command: string;
  timeout: number;
}

/** A `PreToolUse` / `PostToolUse` entry. */
export interface AntigravityHookMatcherGroup {
  matcher: string;
  hooks: AntigravityHookHandler[];
}

/** One named hook's event map. Grouped for tool events, flat for the rest. */
export type AntigravityHookConfig = Record<
  string,
  AntigravityHookMatcherGroup[] | AntigravityHookHandler[]
>;

/**
 * The one file agy reads.
 *
 * Not overridable by an environment variable, deliberately: an override
 * CommandMate honoured and agy did not would produce a config nothing reads,
 * which is the failure this path is least able to notice. `options.path` exists
 * for tests, which are the only caller that may point it elsewhere.
 */
export function getAntigravityHooksConfigPath(options: { path?: string } = {}): string {
  return options.path ?? join(homedir(), '.gemini', 'config', 'hooks.json');
}

/**
 * The relay invocation for one event.
 *
 * No `--worktree-id`, no `--instance-id` and no `--url`: this file is shared by
 * every worktree on the machine, so a correlation key written into it would be
 * wrong for every session but one. `--event` is mandatory rather than optional —
 * agy's payloads carry no event-name field at all (#1757 R2), so this argument
 * is the only thing that says which event arrived.
 *
 * @param relayPath - Absolute path to the relay script
 * @param event - The word to report
 */
export function buildAntigravityHookCommand(relayPath: string, event: AgentEventType): string {
  return [
    shellQuote(relayPath),
    '--tool',
    ANTIGRAVITY_CLI_TOOL_ID,
    '--event',
    event,
    '--stdin-json',
  ].join(' ');
}

/**
 * The `PreToolUse` command, whose stdout **is** the verdict (Issue #1779).
 *
 * Never the relay: that script writes its response body to `/dev/null`, and the
 * body is the entire point here. The same reasoning — and very nearly the same
 * one-liner — as `codex/hooks-config`'s `buildCodexPermissionHookCommand` and
 * `copilot/hook-settings`'s `buildCopilotPermissionCommand`, with one
 * difference that inverts all of it:
 *
 * **Those two may print nothing when things go wrong. This one may not.**
 * codex and copilot read silence as "no opinion" and fall through to their own
 * approval flow, so `… || true` with no output is their fail-safe. agy reads an
 * *empty object* as a denial, and a hook that is killed mid-`curl` produces
 * whatever partial bytes it had written. So every path through this command
 * ends in a `printf` of either the server's verdict or
 * {@link ANTIGRAVITY_ABSTAIN_BODY}, and `curl` is bounded well inside the
 * handler's own timeout so that being killed is not one of the paths.
 *
 * Reading it in order:
 *
 *  1. **The guard.** `~/.gemini/config/hooks.json` is one file for the whole
 *     machine, so this command also runs in agy sessions CommandMate did not
 *     start. Those have no `CM_PERMISSION_HOOK_URL`, and the correct thing for
 *     them is to behave as though no hook existed — `cat >/dev/null` first, so
 *     the agent's write to the hook's stdin does not become an EPIPE, then the
 *     abstain body. This is also the whole of failure path 5.
 *  2. **The bearer header**, assembled with `set --` rather than `${VAR:+-H …}`
 *     because that expansion word-splits and sends `Authorization:` alone. The
 *     relay script and copilot's command solve it the same way.
 *  3. **`curl -f`**, so a 4xx or 5xx prints nothing and lands on the fallback:
 *     failure path 3. `2>/dev/null` keeps a connection error off the agent's
 *     stderr (path 1), and `-m` bounds the wait (path 2).
 *  4. **The shape check.** A reply is passed through only when it looks like a
 *     JSON object carrying a `decision`. Anything else — an empty string from
 *     paths 1-3, an HTML error page from a proxy, a JSON object from some other
 *     service, a truncated body — is failure path 4 and becomes the abstain
 *     body. Deliberately a `case` glob rather than a parser: there is no `jq` to
 *     depend on here, and the failure mode of guessing wrong is bounded by the
 *     fact that the *only* alternative to passing the body through is abstaining.
 */
export function buildAntigravityPermissionHookCommand(): string {
  const url = `"$${ANTIGRAVITY_PERMISSION_URL_ENV_VAR}"`;
  const abstain = `printf '%s' ${shellQuote(ANTIGRAVITY_ABSTAIN_BODY)}`;
  return (
    `if [ -z "\${${ANTIGRAVITY_PERMISSION_URL_ENV_VAR}:-}" ]; then ` +
    `cat >/dev/null; ${abstain}; exit 0; fi; ` +
    `set -- -sS -f -m ${ANTIGRAVITY_PERMISSION_CURL_TIMEOUT_SECONDS} -X POST ` +
    `-H 'Content-Type: application/json'; ` +
    `if [ -n "\${${AUTH_TOKEN_ENV_VAR}:-}" ]; then ` +
    `set -- "$@" -H "Authorization: Bearer $${AUTH_TOKEN_ENV_VAR}"; fi; ` +
    `out=$(curl "$@" --data-binary @- ${url} 2>/dev/null); ` +
    `case "$out" in '{'*'"decision"'*) printf '%s' "$out" ;; *) ${abstain} ;; esac`
  );
}

/**
 * CommandMate's named hook, ready to be merged into agy's config.
 *
 * @param relayPath - Absolute path to the relay script
 */
export function buildAntigravityHookConfig(relayPath: string): AntigravityHookConfig {
  const config: AntigravityHookConfig = {};
  for (const [nativeName, event] of ANTIGRAVITY_REGISTERED_HOOKS) {
    const handler: AntigravityHookHandler = {
      type: 'command',
      command: buildAntigravityHookCommand(relayPath, event),
      timeout: HOOK_TIMEOUT_SECONDS,
    };
    config[nativeName] = ANTIGRAVITY_GROUPED_EVENTS.has(nativeName)
      ? [{ matcher: ANTIGRAVITY_TOOL_MATCHER, hooks: [handler] }]
      : [handler];
  }
  // Issue #1779. Its own handler, its own receiver and its own timeout: this is
  // the only entry in the file whose stdout agy obeys.
  config[ANTIGRAVITY_PERMISSION_HOOK_EVENT] = [
    {
      matcher: ANTIGRAVITY_TOOL_MATCHER,
      hooks: [
        {
          type: 'command',
          command: buildAntigravityPermissionHookCommand(),
          timeout: PERMISSION_REQUEST_TIMEOUT_SECONDS,
        },
      ],
    },
  ];
  return config;
}

/**
 * Put CommandMate's named hook into an existing config without disturbing the
 * rest of it.
 *
 * Pure. One key is replaced; every other named hook is passed through by
 * identity, in its original position — including a previous `commandmate` key,
 * which is replaced rather than appended to, so relaunching does not accumulate
 * handlers.
 *
 * @param existing - The parsed `hooks.json`, or null when there is none
 * @param config - What {@link buildAntigravityHookConfig} produced
 */
export function mergeAntigravityHooksConfig(
  existing: Record<string, unknown> | null,
  config: AntigravityHookConfig
): Record<string, unknown> {
  return { ...existing, [ANTIGRAVITY_HOOK_NAME]: config };
}

/**
 * Write `~/.gemini/config/hooks.json`.
 *
 * @returns The path written, or null when injection is off or not possible
 */
export function writeAntigravityHooksConfig(options: { path?: string } = {}): string | null {
  if (!isHookInjectionEnabled()) return null;

  const relayPath = resolveRelayScriptPath();
  if (!relayPath) {
    logger.warn('antigravity-hook-relay-missing');
    return null;
  }

  const configPath = getAntigravityHooksConfigPath(options);
  try {
    const existing = readJsonObjectFile(configPath);
    writeJsonObjectFile(
      configPath,
      mergeAntigravityHooksConfig(existing, buildAntigravityHookConfig(relayPath))
    );
    return configPath;
  } catch (error) {
    // Fail-open. A session that starts without hooks is the pre-#1762 status
    // quo; a session that fails to start because a config file could not be
    // written is not.
    logger.warn('antigravity-hooks-config-write-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The command that launches `agy` for one instance.
 *
 * `CM_HOOK_URL` is not a convenience here the way it is for gemini — it is the
 * *only* correlation channel agy has. Its payloads carry no `cwd` and an empty
 * `workspacePaths` (#1757 R6), its hooks run with a working directory of
 * `~/.gemini/config`, and its config file is one per machine. The environment of
 * the process CommandMate started is the one thing that differs between two
 * concurrent agy sessions, so that is where the worktree and instance go. The
 * relay reads `CM_HOOK_URL` itself, so no shell expansion inside the hook
 * command is relied on.
 *
 * Two variables, not one, since Issue #1779: the observation events and the
 * adjudication go to different receivers with opposite contracts, and the
 * adjudication hook treats an absent
 * {@link ANTIGRAVITY_PERMISSION_URL_ENV_VAR} as "this session is not
 * CommandMate's, abstain". That guard is the only thing standing between the
 * machine-global config file and an agy the operator started in their own
 * terminal, so the variable is set here and nowhere else.
 *
 * The executable is quoted but not otherwise touched, so a caller may append its
 * own flags — `AntigravityTool.startSession` adds `--model` — after the rendered
 * line. Since Issue #1846 the two variables come back as `env` rather than as a
 * prefix on the command, which is also what keeps `--model` appendable: the
 * caller appends to the *rendered* line and the assignments stay in front of it
 * by construction rather than by the caller remembering to.
 *
 * Never throws, and returns the executable with an empty environment when
 * injection is off.
 *
 * @param executablePath - `agy`, or a resolved path to it
 * @param target - The instance being started
 * @returns The command to type into the pane and the environment it needs
 */
export function buildAntigravityLaunchCommand(
  executablePath: string,
  target: HookSettingsTarget,
  options: HookSettingsOptions = {}
): { command: string; env: Record<string, string> } {
  if (!isHookInjectionEnabled()) return { command: executablePath, env: {} };
  if (!isValidInstanceId(resolveTargetInstanceId(target))) {
    logger.warn('antigravity-hook-invalid-instance-id', { worktreeId: target.worktreeId });
    return { command: executablePath, env: {} };
  }

  const scoped = { ...target, cliToolId: ANTIGRAVITY_CLI_TOOL_ID };
  return {
    command: shellQuote(executablePath),
    env: {
      [AGENT_EVENT_URL_ENV_VAR]: buildAgentEventUrl(scoped, options),
      [ANTIGRAVITY_PERMISSION_URL_ENV_VAR]: buildPermissionRequestUrl(scoped, options),
    },
  };
}
