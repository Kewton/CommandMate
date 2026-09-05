/**
 * The hooks CommandMate writes into `<worktree>/.commandcode/settings.local.json`,
 * and the environment that launches Command Code against them (Issue #2251,
 * Epic #2249 Phase B).
 *
 * The file shape is Claude's — `{"hooks":{"<Event>":[{matcher, hooks:[{type,
 * command, timeout}]}]}}` — so this is gemini's generator with four differences,
 * every one of which was measured against **v1.40.1** rather than inferred from
 * the shape.
 *
 * ## 1. There are exactly four events, and the validator says so
 *
 * `dist/cli.mjs` carries `["PreToolUse","PostToolUse","Stop","SessionStart"]` as
 * the list `isHookEvent` tests against, and `loadOne` warns and *skips* anything
 * else (`unknown hook event "…" — skipped`). That is a stronger statement than
 * the spike's "we configured `SessionEnd` and never saw one": the word is not
 * merely unemitted, it is rejected at load. See
 * {@link COMMAND_CODE_REGISTERED_HOOKS}.
 *
 * ## 2. `matcher` must be the EMPTY STRING, and `"*"` silently kills two events
 *
 * The single most consequential line in this module, and the one that fails with
 * no error anywhere. Command Code selects handlers with:
 *
 * ```js
 * for (const h of hooks) if (h.event === event) {
 *   if (h.matcher) {                 // ← an empty string is FALSY
 *     if (!toolName) continue;       // ← SessionStart/Stop run with toolName ""
 *     …regex test…
 *   }
 *   selected.push(h)
 * }
 * ```
 *
 * `SessionStart` and `Stop` are invoked with `toolName: ""`, so **any non-empty
 * matcher removes them entirely** — including `"*"`, which the *loader* accepts
 * (it is special-cased to a match-everything regex, so no warning is printed).
 * Measured live, two runs in an isolated tmux socket against the same session:
 *
 * ```text
 * matcher ""   → ◼ Ran 2 session start hooks   (both layers fired)
 * matcher "*"  → ◼ Ran 1 session start hook    (only the "" layer fired)
 * ```
 *
 * So {@link COMMAND_CODE_MATCH_ALL_MATCHER} is `''`, and it is not the same
 * choice antigravity made (`'*'`, where the matcher is a tool-name glob and
 * every registered event carries a tool name).
 *
 * ## 3. The three config layers are UNIONED, not overridden
 *
 * `loadSettingsHooks` reads `<cwd>/.commandcode/settings.local.json`, then
 * `<cwd>/.commandcode/settings.json`, then `~/.commandcode/settings.json`, and
 * appends every handler from all three into one flat list — deduplicated only by
 * `${event}:${matcher}:${command}`. Measured: two layers registering
 * *different* commands for `SessionStart` both ran (`Ran 2 session start hooks`).
 *
 * This is why the file below is `settings.local.json` and not `settings.json`:
 *
 *  - **A user's hooks cannot be lost either way.** Union across layers means a
 *    `settings.json` CommandMate never touches keeps firing, and the in-file
 *    merge below keeps the ones in the file it *does* touch.
 *  - **`settings.json` is the shared, reviewable file** — the one a team checks
 *    in, and the one Command Code's own settings writer labels `projectShared`.
 *    Putting an absolute, machine-local relay path into it would put CommandMate
 *    installation details into someone's code review.
 *  - **`settings.local.json` is Command Code's own machine-local scope**
 *    (`projectLocal`), and its worktree helper *copies* the file into a new
 *    worktree rather than relying on git to carry it — i.e. the tool itself
 *    treats it as untracked.
 *
 * ## 4. It does not make the worktree dirty in a way Command Code does not
 *
 * `.commandcode/` is **not** ignored by git — measured in this repository and in
 * a throwaway `git init`, `git status` reports `?? .commandcode/`. That is the
 * answer to Epic #2249's 未確定事項 4, and it is not caused by this file:
 * Command Code writes `.commandcode/taste/taste.md` itself on the first launch,
 * so the directory is untracked-and-present the moment the agent runs at all.
 * What this module adds is one more file inside a directory the tool already
 * created. gemini has the same property (`<worktree>/.gemini/settings.json`) and
 * the same resolution: write the smallest thing, merge rather than replace, and
 * leave the ignoring to the operator.
 *
 * ## What the reply may say, and why the relay is safe on all four
 *
 * `resolveHookExit` treats **exit code 2 on `PreToolUse` or `Stop` as a block**,
 * and a `decision: "block"` on `PostToolUse`/`Stop` as a retry request.
 * `scripts/hooks/cmate-agent-event.sh` writes nothing to stdout and exits 0 on
 * every delivery failure, so neither path is reachable from a server that is
 * down — which is what makes registering `Stop` on the relay safe here even
 * though its reply can prevent a turn from ending.
 *
 * @module lib/hooks/sources/command-code/hooks-config
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
// Generic non-destructive JSON config IO. It lives under `gemini/` because that
// is the tree it was written for, but nothing in it is gemini-specific and
// `antigravity/hooks-config` already reaches for it across the same edge. A
// second copy here would be a second implementation of "we do not clobber the
// user's file", which is the one thing this module must not get wrong twice.
import { readJsonObjectFile, writeJsonObjectFile } from '../gemini/shared-config-tree';
import { COMMAND_CODE_CLI_TOOL_ID } from './tool-id';

const logger = createLogger('lib/hooks/sources/command-code/hooks-config');

/** Directory Command Code reads project configuration from, relative to the worktree. */
export const COMMAND_CODE_CONFIG_DIRNAME = '.commandcode';

/**
 * The layer CommandMate writes.
 *
 * `settings.local.json`, not `settings.json` — see the module comment's §3 for
 * the three reasons and the measurement behind each.
 */
export const COMMAND_CODE_SETTINGS_FILENAME = 'settings.local.json';

/**
 * The matcher every handler carries: **the empty string**.
 *
 * Not cosmetic and not a placeholder. `''` is the only value that leaves
 * `SessionStart` and `Stop` firing, because Command Code's handler selection
 * tests `if (handler.matcher)` and then requires a tool name — and those two
 * events run with none. `'*'` loads without a warning and removes both. See §2
 * of the module comment for the two live runs.
 */
export const COMMAND_CODE_MATCH_ALL_MATCHER = '';

/**
 * The Command Code events CommandMate registers, and the word each relay call
 * reports.
 *
 * All four of them, which is *every* event the tool has: its bundled
 * `isHookEvent` tests against exactly `PreToolUse` / `PostToolUse` / `Stop` /
 * `SessionStart` and skips anything else with a warning. There is no
 * `UserPromptSubmit`, no `Notification` and no `SessionEnd` to leave out.
 *
 * `PreToolUse` is on this list and NOT pointed at the permission receiver, which
 * is the opposite of what copilot and antigravity do with the same spelling.
 * Epic #2249 決定 3 is why: Command Code fires `PreToolUse` **after** the
 * approval dialog has been answered (measured — dialog drawn 00:11:37, answered
 * 00:11:46, hook fired 00:11:46), so its reply cannot forecast a dialog, cannot
 * dismiss one, and is only an observation. Registered as an observation, then.
 *
 * Ordered as the file is written, so a diff of two generated files reads in one
 * direction.
 */
export const COMMAND_CODE_REGISTERED_HOOKS: ReadonlyArray<readonly [string, AgentEventType]> = [
  ['SessionStart', 'session_start'],
  ['PreToolUse', 'pre_tool_use'],
  ['PostToolUse', 'post_tool_use'],
  ['Stop', 'stop'],
];

/**
 * Handler timeout, **in seconds** — the unit gemini does not use.
 *
 * Command Code's own validator is explicit about the range: `translateHandler`
 * skips a handler whose `timeout` is not a number in `(0, 600]`, with the
 * warning `timeout must be a number in (0, 600]`. The default when the field is
 * absent is 30. {@link HOOK_TIMEOUT_SECONDS} is 5, well inside it, and is the
 * same number every other seconds-denominated tool uses so the budget stays one
 * figure.
 */
export const COMMAND_CODE_HOOK_TIMEOUT_SECONDS = HOOK_TIMEOUT_SECONDS;

/** One handler. Command Code accepts `type` (command only) / `command` / `timeout`. */
export interface CommandCodeHookHandler {
  type: 'command';
  command: string;
  timeout: number;
}

/**
 * One matcher group.
 *
 * `matcher` is required rather than optional here even though the tool treats an
 * absent one the same as an empty one: writing the field makes
 * {@link COMMAND_CODE_MATCH_ALL_MATCHER}'s comment reachable from the generated
 * file, and an operator reading their own `settings.local.json` sees the value
 * that is load-bearing rather than an omission they might "tidy up" into `"*"`.
 */
export interface CommandCodeHookMatcherGroup {
  matcher: string;
  hooks: CommandCodeHookHandler[];
}

/** Absolute path of the settings layer CommandMate writes for one worktree. */
export function getCommandCodeSettingsPath(worktreePath: string): string {
  return join(worktreePath, COMMAND_CODE_CONFIG_DIRNAME, COMMAND_CODE_SETTINGS_FILENAME);
}

/**
 * The relay invocation for one event.
 *
 * `--event` is passed explicitly even though Command Code's payload carries
 * `hook_event_name` in the CamelCase dialect the relay already maps: an argument
 * the generator wrote cannot drift with the tool's spelling, and it removes the
 * one path in `cmate-agent-event.sh` that `die`s (exit 2) on an unrecognised
 * name — which on `PreToolUse` and `Stop` is how Command Code spells *block*.
 *
 * No `--url`. The endpoint comes from `CM_HOOK_URL`, which
 * {@link buildCommandCodeLaunchEnvironment} puts in the session's environment
 * with the instance baked in; passing `--url` here would override it from a file
 * that cannot know which instance it is serving. `--worktree-id` *is* baked in,
 * because the file already is per-worktree and a body that names the worktree
 * keeps working when the environment does not reach the hook.
 *
 * @param relayPath - Absolute path to the relay script
 * @param event - The word to report
 * @param worktreeId - CommandMate's worktree id
 */
export function buildCommandCodeHookCommand(
  relayPath: string,
  event: AgentEventType,
  worktreeId: string
): string {
  return [
    shellQuote(relayPath),
    '--tool',
    COMMAND_CODE_CLI_TOOL_ID,
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
 * The same predicate gemini uses, and it matters more here: Command Code
 * deduplicates identical handlers across its three layers by
 * `${event}:${matcher}:${command}`, so an accumulated duplicate inside one file
 * would *not* be folded away — the strings are identical, but they would be
 * identical entries in the same array, and the dedup set is keyed on the string
 * so the second copy is dropped. What accumulation would still cost is a file
 * that grows without bound.
 */
export function isCommandMateHookCommand(command: string, worktreeId: string): boolean {
  return (
    command.includes('cmate-agent-event.sh') &&
    command.includes(`--tool ${COMMAND_CODE_CLI_TOOL_ID}`) &&
    command.includes(`--worktree-id ${shellQuote(worktreeId)}`)
  );
}

/** Whether one entry of a `hooks[<Event>]` array is CommandMate's. */
function isCommandMateGroup(group: unknown, worktreeId: string): boolean {
  if (!isPlainObject(group)) return false;

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

  // A flat handler. Command Code rejects that shape (`translateGroups` requires
  // `hooks` to be an array and warns otherwise), so this is not something we
  // could have written — but recognising it costs one line and means a
  // hand-flattened copy of ours is replaced rather than left to be skipped
  // forever with a warning the operator never reads.
  return typeof group.command === 'string' && isCommandMateHookCommand(group.command, worktreeId);
}

/**
 * The `hooks` entries CommandMate contributes, keyed by Command Code's event name.
 *
 * @param relayPath - Absolute path to the relay script
 * @param target - The instance being started; only its worktree reaches the file
 * @returns One matcher group per registered event
 */
export function buildCommandCodeHookGroups(
  relayPath: string,
  target: HookSettingsTarget
): Record<string, CommandCodeHookMatcherGroup[]> {
  const groups: Record<string, CommandCodeHookMatcherGroup[]> = {};
  for (const [nativeName, event] of COMMAND_CODE_REGISTERED_HOOKS) {
    groups[nativeName] = [
      {
        // The empty string, and it has to be. See COMMAND_CODE_MATCH_ALL_MATCHER.
        matcher: COMMAND_CODE_MATCH_ALL_MATCHER,
        hooks: [
          {
            type: 'command',
            command: buildCommandCodeHookCommand(relayPath, event, target.worktreeId),
            // Seconds. Command Code's validator rejects anything outside (0, 600].
            timeout: COMMAND_CODE_HOOK_TIMEOUT_SECONDS,
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
 * filesystem. The rules, which are gemini's:
 *
 *  - every top-level key other than `hooks` is passed through by identity, in
 *    its original position — `permissions`, `disabledSkills`, `mods` and
 *    whatever else Command Code grows next;
 *  - inside `hooks`, an event CommandMate does not register is passed through
 *    **by identity**, including values that are not arrays;
 *  - inside an event CommandMate does register, the user's groups are kept and
 *    ours are replaced.
 *
 * @param existing - The parsed settings file, or null when there is none
 * @param groups - What {@link buildCommandCodeHookGroups} produced
 * @param worktreeId - Identifies our own previous entries
 * @returns The object to serialise
 */
export function mergeCommandCodeHookSettings(
  existing: Record<string, unknown> | null,
  groups: Record<string, CommandCodeHookMatcherGroup[]>,
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
 * Write `<worktree>/.commandcode/settings.local.json`.
 *
 * @param worktreePath - Absolute path of the worktree Command Code will run in
 * @param target - The instance being started
 * @returns The path written, or null when injection is off or not possible
 */
export function writeCommandCodeHookSettings(
  worktreePath: string,
  target: HookSettingsTarget
): string | null {
  if (!isHookInjectionEnabled()) return null;

  const relayPath = resolveRelayScriptPath();
  if (!relayPath) {
    // No inline-`curl` fallback, for gemini's reason: a fallback would post the
    // agent's payload verbatim and rely on the URL to say which tool sent it,
    // and the URL here lives in an environment variable a settings file cannot
    // read. A Command Code session with no hooks is the Phase A status quo; one
    // posting events nothing can attribute is worse.
    logger.warn('command-code-hook-relay-missing', { worktreeId: target.worktreeId });
    return null;
  }

  const settingsPath = getCommandCodeSettingsPath(worktreePath);
  try {
    const existing = readJsonObjectFile(settingsPath);
    const groups = buildCommandCodeHookGroups(relayPath, target);
    writeJsonObjectFile(
      settingsPath,
      mergeCommandCodeHookSettings(existing, groups, target.worktreeId)
    );
    return settingsPath;
  } catch (error) {
    // Fail-open, like every other part of this path: the events are an
    // enhancement to a session that has to start regardless.
    logger.warn('command-code-hook-settings-write-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The command and environment that launch Command Code for one instance.
 *
 * `CM_HOOK_URL` is the whole of the instance correlation, and it is an
 * environment variable rather than a value baked into the settings file for the
 * reason the file cannot get around: `.commandcode/settings.local.json` is per
 * *worktree*, and `command-code` and `command-code-2` share it. Measured, not
 * assumed, that this reaches the handler: the spike's relay printed
 * `CM_HOOK_URL=http://127.0.0.1:9/probe` from inside the hook process on all
 * seven captured events, so the launching shell's environment does propagate.
 * Command Code also injects `COMMANDCODE_SESSION_ID` / `COMMANDCODE_PROJECT_DIR`
 * / `COMMANDCODE_HOOK_EVENT` / `COMMANDCODE_PERMISSION_MODE` of its own, none of
 * which CommandMate reads — the payload on stdin carries the same facts.
 *
 * A `{ command, env }` pair rather than one prefixed string (#1846), so
 * `renderAgentLaunchCommand` is the only thing that writes a shell assignment
 * and `CommandCodeTool` can append `--trust --skip-onboarding --no-auto-update`
 * after the rendered line without the assignments moving.
 *
 * Never throws, and returns the executable with an empty environment when
 * injection is off, so `CM_AGENT_HOOKS_INJECT=0` produces the byte-identical
 * command line Phase A shipped.
 *
 * @param executablePath - `commandcode`, or a resolved path to it
 * @param target - The instance being started
 * @returns The command to type into the pane and the environment it needs
 */
export function buildCommandCodeLaunchEnvironment(
  executablePath: string,
  target: HookSettingsTarget,
  options: HookSettingsOptions = {}
): { command: string; env: Record<string, string> } {
  if (!isHookInjectionEnabled()) return { command: executablePath, env: {} };
  if (!isValidInstanceId(resolveTargetInstanceId(target))) {
    // About to become a URL parameter the receiver re-validates; a value that
    // would be rejected there is not worth injecting.
    logger.warn('command-code-hook-invalid-instance-id', { worktreeId: target.worktreeId });
    return { command: executablePath, env: {} };
  }

  const url = buildAgentEventUrl({ ...target, cliToolId: COMMAND_CODE_CLI_TOOL_ID }, options);
  return { command: shellQuote(executablePath), env: { [AGENT_EVENT_URL_ENV_VAR]: url } };
}
