/**
 * The hooks CommandMate writes into `<worktree>/.gemini/settings.json`, and the
 * command that launches gemini against them (Issue #1762).
 *
 * gemini is the one tool of the five whose hook config is naturally scoped to a
 * worktree: `settings.setValue("Workspace", "hooks", …)` — which is what
 * `gemini hooks migrate` calls — writes the workspace file, and the user's
 * `~/.gemini/settings.json` is never opened (#1757 §5.3.2). So this generator
 * touches nothing global, and the *shared* `~/.gemini` tree that antigravity
 * lives in (`./shared-config-tree`) is out of reach by construction.
 *
 * What it does touch is a file inside the user's repository. Three consequences
 * shaped the code:
 *
 *  - **It merges, never replaces.** A checked-in `.gemini/settings.json` with
 *    the team's model, tool allowlist and their own hooks keeps every key; only
 *    CommandMate's own handlers are rewritten. `mergeGeminiHookSettings` is
 *    pure, so this is testable without a filesystem.
 *  - **The written command is deterministic.** gemini persists the exact command
 *    strings it has been trusted with in `trusted_hooks.json` and re-shows the
 *    disclosure banner when they change (#1757 §5.3.3), so a command that
 *    varied per launch would nag on every start. It also makes the merge
 *    idempotent: relaunching rewrites byte-identical entries.
 *  - **It does not carry the instance id.** One file serves `gemini` and
 *    `gemini-2` in the same worktree, so an instance baked into it would label
 *    both sessions with whichever started last. The instance rides in
 *    `CM_HOOK_URL` instead — see {@link buildGeminiLaunchCommand}.
 *
 * ## Which events are registered, and which are not
 *
 * `SessionStart` / `BeforeAgent` / `AfterAgent` / `Notification` / `SessionEnd`.
 * That is every gemini event with a consumer:
 * `user_prompt_submit` → `running`, `stop` → `ready`,
 * `notification(permission_prompt)` → `waiting`, `session_start` → generation
 * fence, `session_end` → recorded.
 *
 * `BeforeTool` / `AfterTool` are deliberately absent. gemini runs hooks
 * synchronously, so registering them buys two blocking round trips per tool call
 * — on a hot `read_file` loop that is the agent waiting on CommandMate, all day
 * — and buys nothing back: `pre_tool_use`/`post_tool_use` answer `running`,
 * which `user_prompt_submit` has already established and only `stop` clears, and
 * the one payload they are otherwise read for is `AskUserQuestion`, a tool
 * gemini does not have. The source still *maps* both spellings, because a user
 * may register them by hand in the same file.
 *
 * @module lib/hooks/sources/gemini/settings-generator
 */

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
import { isPlainObject } from '../event-mapper';
import { AGENT_EVENT_URL_ENV_VAR } from '../launch-command';
import { readJsonObjectFile, writeJsonObjectFile } from './shared-config-tree';
import { GEMINI_CLI_TOOL_ID } from './tool-id';

const logger = createLogger('lib/hooks/sources/gemini/settings-generator');

/** Directory gemini reads workspace configuration from, relative to the worktree. */
export const GEMINI_CONFIG_DIRNAME = '.gemini';

/**
 * Handler timeout, **in milliseconds** — gemini is the one tool that does not
 * count this in seconds.
 *
 * Measured, and measured the hard way. `timeout: 5` — the seconds figure every
 * other tool takes, and what #1757 §8.2 R13 recorded as "the unit is seconds
 * everywhere" — produced this on a live v0.55.1 session:
 *
 * ```
 * Hook execution error: Hook timed out after 5ms
 * Hook execution for SessionStart: 0 succeeded, 1 failed …, total duration: 8ms
 * ```
 *
 * The hook was registered, was disclosed in the banner, and ran — and was killed
 * before `curl` could open a socket, so **every event was lost while everything
 * looked correctly configured**. The bundle confirms it:
 * `DEFAULT_HOOK_TIMEOUT = 6e4` and the message is `Hook timed out after
 * ${timeout}ms`. gemini's default is therefore 60s where Claude's is 600s and
 * copilot's is ~10s.
 *
 * The value is {@link HOOK_TIMEOUT_SECONDS} converted, so the budget stays the
 * one number the rest of the codebase reasons about.
 */
export const GEMINI_HOOK_TIMEOUT_MS = HOOK_TIMEOUT_SECONDS * 1000;

/** Workspace settings file, relative to {@link GEMINI_CONFIG_DIRNAME}. */
export const GEMINI_SETTINGS_FILENAME = 'settings.json';

/**
 * The gemini events CommandMate registers, and the word each relay call reports.
 *
 * Ordered as the file is written, so a diff of two generated files reads in one
 * direction. See the module comment for why `BeforeTool` / `AfterTool` are not
 * here.
 */
export const GEMINI_REGISTERED_HOOKS: ReadonlyArray<readonly [string, AgentEventType]> = [
  ['SessionStart', 'session_start'],
  ['BeforeAgent', 'user_prompt_submit'],
  ['AfterAgent', 'stop'],
  ['Notification', 'notification'],
  ['SessionEnd', 'session_end'],
];

/** One handler in a gemini hook group. gemini accepts `type` / `command` / `timeout` only. */
export interface GeminiHookHandler {
  type: 'command';
  command: string;
  timeout: number;
}

/** One matcher group. gemini uses Claude's grouped shape. */
export interface GeminiHookMatcherGroup {
  matcher?: string;
  hooks: GeminiHookHandler[];
}

/** Absolute path of the workspace settings file for one worktree. */
export function getGeminiSettingsPath(worktreePath: string): string {
  return join(worktreePath, GEMINI_CONFIG_DIRNAME, GEMINI_SETTINGS_FILENAME);
}

/**
 * The relay invocation for one event.
 *
 * `type: "http"` is not an option here, or anywhere outside Claude: #1757 R7
 * measured all four new tools rejecting it, so `scripts/hooks/cmate-agent-event.sh`
 * is the only delivery mechanism gemini has.
 *
 * No `--url`. The endpoint comes from `CM_HOOK_URL`, which
 * {@link buildGeminiLaunchCommand} puts in the session's environment with the
 * instance baked in; passing `--url` here would override it from a file that
 * cannot know which instance it is serving. `--worktree-id` *is* baked in,
 * because the file already is per-worktree and a body that names the worktree
 * keeps working when the environment does not reach the hook.
 *
 * @param relayPath - Absolute path to the relay script
 * @param event - The word to report
 * @param worktreeId - CommandMate's worktree id
 */
export function buildGeminiHookCommand(
  relayPath: string,
  event: AgentEventType,
  worktreeId: string
): string {
  return [
    shellQuote(relayPath),
    '--tool',
    GEMINI_CLI_TOOL_ID,
    '--event',
    event,
    '--worktree-id',
    shellQuote(worktreeId),
    '--stdin-json',
  ].join(' ');
}

/**
 * Whether a command string is one CommandMate wrote for this worktree.
 *
 * Used to replace our own entries on rewrite instead of appending a duplicate
 * set at every launch. Three tokens have to be present together — the relay's
 * name, this tool, and this worktree id — so a hook the operator wrote for a
 * *different* worktree, or for another tool, or with their own script, is left
 * alone.
 *
 * A hand-configured hook from the #1549 guide that happens to match all three is
 * replaced, and that is the right outcome: it posts the same event for the same
 * instance to the same receiver, so the only thing lost is the duplicate.
 */
export function isCommandMateHookCommand(command: string, worktreeId: string): boolean {
  return (
    command.includes('cmate-agent-event.sh') &&
    command.includes(`--tool ${GEMINI_CLI_TOOL_ID}`) &&
    command.includes(`--worktree-id ${shellQuote(worktreeId)}`)
  );
}

/** Whether one entry of a `hooks[<Event>]` array is CommandMate's. */
function isCommandMateGroup(group: unknown, worktreeId: string): boolean {
  if (!isPlainObject(group)) return false;

  // The grouped shape gemini documents.
  const handlers = group.hooks;
  if (Array.isArray(handlers)) {
    return (
      handlers.length > 0 &&
      handlers.every(
        (handler) =>
          isPlainObject(handler) &&
          typeof handler.command === 'string' &&
          isCommandMateHookCommand(handler.command, worktreeId)
      )
    );
  }

  // A flat handler. Not what this generator emits, but cheap to recognise so an
  // older or hand-flattened entry of ours is replaced rather than duplicated.
  return typeof group.command === 'string' && isCommandMateHookCommand(group.command, worktreeId);
}

/**
 * The `hooks` entries CommandMate contributes, keyed by gemini's event name.
 *
 * @param relayPath - Absolute path to the relay script
 * @param target - The instance being started; only its worktree reaches the file
 * @returns One matcher group per registered event
 */
export function buildGeminiHookGroups(
  relayPath: string,
  target: HookSettingsTarget
): Record<string, GeminiHookMatcherGroup[]> {
  const groups: Record<string, GeminiHookMatcherGroup[]> = {};
  for (const [nativeName, event] of GEMINI_REGISTERED_HOOKS) {
    groups[nativeName] = [
      {
        hooks: [
          {
            type: 'command',
            command: buildGeminiHookCommand(relayPath, event, target.worktreeId),
            // Milliseconds. See GEMINI_HOOK_TIMEOUT_MS — this is the one field
            // whose unit differs from every other tool's, and getting it wrong
            // loses every event without an error anywhere the operator looks.
            timeout: GEMINI_HOOK_TIMEOUT_MS,
          },
        ],
      },
    ];
  }
  return groups;
}

/**
 * Put CommandMate's hooks into an existing settings object without disturbing
 * anything else in it.
 *
 * Pure, so the guarantee this module exists for is checked without a
 * filesystem. The rules:
 *
 *  - every top-level key other than `hooks` is passed through by identity, in
 *    its original position;
 *  - inside `hooks`, an event CommandMate does not register is passed through
 *    **by identity** — including values that are not arrays, which a
 *    hand-edited file can contain;
 *  - inside an event CommandMate does register, the user's groups are kept and
 *    ours are replaced.
 *
 * @param existing - The parsed settings file, or null when there is none
 * @param groups - What {@link buildGeminiHookGroups} produced
 * @param worktreeId - Identifies our own previous entries
 * @returns The object to serialise
 */
export function mergeGeminiHookSettings(
  existing: Record<string, unknown> | null,
  groups: Record<string, GeminiHookMatcherGroup[]>,
  worktreeId: string
): Record<string, unknown> {
  const existingHooks = isPlainObject(existing?.hooks) ? existing.hooks : {};
  const merged: Record<string, unknown> = {};

  for (const [nativeName, value] of Object.entries(existingHooks)) {
    if (!Array.isArray(value)) {
      merged[nativeName] = value;
      continue;
    }
    const kept = value.filter((group) => !isCommandMateGroup(group, worktreeId));
    // Identity when nothing of ours was in there, so an untouched event is
    // untouched down to the array instance.
    merged[nativeName] = kept.length === value.length ? value : kept;
  }

  for (const [nativeName, ours] of Object.entries(groups)) {
    const kept = merged[nativeName];
    merged[nativeName] = Array.isArray(kept) ? [...kept, ...ours] : [...ours];
  }

  return { ...existing, hooks: merged };
}

/**
 * Write `<worktree>/.gemini/settings.json`.
 *
 * @param worktreePath - Absolute path of the worktree gemini will run in
 * @param target - The instance being started
 * @returns The path written, or null when injection is off or not possible
 */
export function writeGeminiHookSettings(
  worktreePath: string,
  target: HookSettingsTarget
): string | null {
  if (!isHookInjectionEnabled()) return null;

  const relayPath = resolveRelayScriptPath();
  if (!relayPath) {
    // No inline-curl fallback, unlike Claude's `SessionStart`: that fallback
    // posts the agent's payload verbatim and relies on the URL to say which
    // tool sent it, and the URL here lives in an environment variable a
    // settings file cannot read. A gemini session with no hooks is the
    // pre-#1762 status quo; a gemini session posting events nothing can
    // attribute is worse.
    logger.warn('gemini-hook-relay-missing', { worktreeId: target.worktreeId });
    return null;
  }

  const settingsPath = getGeminiSettingsPath(worktreePath);
  try {
    const existing = readJsonObjectFile(settingsPath);
    const groups = buildGeminiHookGroups(relayPath, target);
    writeJsonObjectFile(settingsPath, mergeGeminiHookSettings(existing, groups, target.worktreeId));
    return settingsPath;
  } catch (error) {
    // Fail-open, like every other part of this path: the events are an
    // enhancement to a session that has to start regardless.
    logger.warn('gemini-hook-settings-write-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The command and environment that launch gemini for one instance.
 *
 * `CM_HOOK_URL` is the whole of the instance correlation, and it is an
 * environment variable rather than a flag in the settings file for a reason the
 * file cannot get around: `.gemini/settings.json` is per *worktree*, and
 * `gemini` and `gemini-2` share it. The relay reads `CM_HOOK_URL` itself — no
 * shell expansion inside the hook command is involved — and the receiver reads
 * `tool`, `worktreeId` and `instanceId` out of the query string, which is
 * exactly how Claude's injected `--settings` correlates.
 *
 * When the variable does not reach the hook, the relay falls back to its default
 * endpoint and the body's `--worktree-id` still resolves the worktree; the event
 * lands on the primary instance. That is a degradation, not a
 * misattribution.
 *
 * Returned as a `{ command, env }` pair since Issue #1846, instead of as one
 * string with the variable written onto the front of `gemini`. Three other
 * sources had built the same prefix by hand; `renderAgentLaunchCommand` now
 * writes it once, and the line a pane receives is byte-identical.
 *
 * Never throws, and returns the executable with an empty environment when
 * injection is off, so `CM_AGENT_HOOKS_INJECT=0` produces the byte-identical
 * command line this tool used before #1762.
 *
 * @param executablePath - `gemini`, or a resolved path to it
 * @param target - The instance being started
 * @returns The command to type into the pane and the environment it needs
 */
export function buildGeminiLaunchCommand(
  executablePath: string,
  target: HookSettingsTarget,
  options: HookSettingsOptions = {}
): { command: string; env: Record<string, string> } {
  if (!isHookInjectionEnabled()) return { command: executablePath, env: {} };
  if (!isValidInstanceId(resolveTargetInstanceId(target))) {
    // About to become a URL parameter the receiver re-validates; a value that
    // would be rejected there is not worth injecting.
    logger.warn('gemini-hook-invalid-instance-id', { worktreeId: target.worktreeId });
    return { command: executablePath, env: {} };
  }

  const url = buildAgentEventUrl({ ...target, cliToolId: GEMINI_CLI_TOOL_ID }, options);
  return { command: shellQuote(executablePath), env: { [AGENT_EVENT_URL_ENV_VAR]: url } };
}
