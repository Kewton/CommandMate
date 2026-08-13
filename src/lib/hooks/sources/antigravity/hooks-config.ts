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
 * ## Which events are registered, and which are not
 *
 * `SessionStart`, `PostToolUse` and `Stop`. **`PreToolUse` is deliberately
 * absent, and that is the single most important line in this module.**
 *
 * agy's `PreToolUse` reply contract has a *required* `decision` field, and
 * #1757 P10 measured what "required" means: a hook that answers `{}` has every
 * tool call denied — `run_command`, `list_dir` and `search_web` all refused,
 * with the agent reporting "all tool executions were denied by the environment's
 * system policy" and going looking for workarounds. A control run with the
 * hooks file moved aside ran the same prompt normally.
 *
 * `scripts/hooks/cmate-agent-event.sh` writes **nothing** to stdout (`curl …
 * >/dev/null`), which is the reply an agy `PreToolUse` reads as a denial. Since
 * that relay is the only delivery mechanism agy has (`type: "http"` does not
 * exist for it) and this Issue does not change the relay, registering
 * `PreToolUse` would mean shipping a hook that stops every tool call on the
 * machine. It is not registered.
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
 * @module lib/hooks/sources/antigravity/hooks-config
 */

import { homedir } from 'os';
import { join } from 'path';
import { isValidInstanceId } from '@/lib/cli-tools/types';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import {
  buildAgentEventUrl,
  HOOK_TIMEOUT_SECONDS,
  isHookInjectionEnabled,
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
 * The agy events CommandMate registers, and the word each relay call reports.
 *
 * See the module comment for why `PreToolUse` is not here.
 */
export const ANTIGRAVITY_REGISTERED_HOOKS: ReadonlyArray<readonly [string, AgentEventType]> = [
  ['SessionStart', 'session_start'],
  ['PostToolUse', 'post_tool_use'],
  ['Stop', 'stop'],
];

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
 * The executable is quoted but not otherwise touched, so a caller may append its
 * own flags — `AntigravityTool.startSession` adds `--model` — after the value
 * this returns.
 *
 * Never throws, and returns the executable unchanged when injection is off.
 *
 * @param executablePath - `agy`, or a resolved path to it
 * @param target - The instance being started
 * @returns The command line to type into the pane
 */
export function buildAntigravityLaunchCommand(
  executablePath: string,
  target: HookSettingsTarget,
  options: HookSettingsOptions = {}
): string {
  if (!isHookInjectionEnabled()) return executablePath;
  if (!isValidInstanceId(resolveTargetInstanceId(target))) {
    logger.warn('antigravity-hook-invalid-instance-id', { worktreeId: target.worktreeId });
    return executablePath;
  }

  const url = buildAgentEventUrl({ ...target, cliToolId: ANTIGRAVITY_CLI_TOOL_ID }, options);
  return `CM_HOOK_URL=${shellQuote(url)} ${shellQuote(executablePath)}`;
}
