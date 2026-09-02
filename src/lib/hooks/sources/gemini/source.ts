/**
 * Gemini CLI's {@link AgentEventSource} (Issue #1762, Phase 4-4 of Epic #1720).
 *
 * ## Why the values below are what they are
 *
 * - **`noDecision: 'proceeds'`.** #1757 could not measure this: the account
 *   available to the spike was refused by the server with `IneligibleTierError`
 *   before any tool call happened, so §5.3.6 lists items 6 and 7 as unmeasured.
 *   It is not guessed either. gemini v0.55.1's shipped bundle decides whether a
 *   hook blocked a tool in `DefaultHookOutput`:
 *
 *   ```js
 *   isBlockingDecision() { return this.decision === "block" || this.decision === "deny"; }
 *   isAskDecision()      { return this.decision === "ask"; }
 *   shouldStopExecution(){ return this.continue === false; }
 *   ```
 *
 *   All three read fields that an empty or absent reply does not have, so
 *   silence cannot block, cannot escalate and cannot stop. Fail-open is a
 *   property of the parser rather than of a measurement — which is the stronger
 *   statement of the two, and the opposite of antigravity, where the same
 *   question has the opposite answer (`../antigravity/source`).
 *
 * - **`encodeVerdict` returns `{}` for every verdict, and this source
 *   adjudicates nothing.** Not a gap — gemini's hook protocol has no way to
 *   approve anything. Reading the scheduler in the same bundle:
 *
 *   ```js
 *   const hookResult = await evaluateBeforeToolHook(…);   // 1. the hook runs
 *   …
 *   const { decision: policyDecision } = await checkPolicy(…);  // 2. the Policy Engine
 *   let decision = policyDecision;
 *   if (hookDecision === "ask") decision = ASK_USER;             // 3. hook may only escalate
 *   ```
 *
 *   A hook can *deny* (step 1 returns an error outright), it can *escalate* an
 *   allow into a dialog (step 3), and it can do nothing. There is no branch in
 *   which a hook turns a `checkPolicy` verdict into an approval. So **on gemini,
 *   approval is the Policy Engine's job and only the Policy Engine's job**
 *   (`--approval-mode` / `--policy` / `-y, --yolo`), and Auto-Yes keeps exactly
 *   the one meaning it has today for this tool: the TUI path — detect the
 *   dialog, answer it. There is no second, hook-shaped approval channel for it
 *   to compete with, which is what Issue #1720 asked to be established before
 *   this Issue shipped. CommandMate passes none of those flags, so injecting
 *   hooks does not widen what a gemini session may do.
 *
 * - **`configScope: 'per-worktree'`.** `<worktree>/.gemini/settings.json`
 *   (#1757 §5.3.2). The user's `~/.gemini/settings.json` is never opened, which
 *   also keeps this source out of the tree antigravity occupies.
 *
 * - **`decisionTimeoutSeconds: 0`.** Not `null`. `null` means "waits forever",
 *   which is opencode's situation and would be a lie here: no gemini event ever
 *   waits on a CommandMate verdict, because none is ever asked for.
 *
 * @module lib/hooks/sources/gemini/source
 */

import { isValidInstanceId } from '@/lib/cli-tools/types';
import type { HookSettingsTarget } from '@/lib/hooks/hook-settings-generator';
import { definePushHookSource } from '../define-source';
import { fromNameTable } from '../event-mapper';
import { SESSION_ID_FIELDS } from '../hook-event-vocabulary';
import type { AgentEventSource, AgentLaunchContext, AgentLaunchPlan } from '../types';
import { extractGeminiEventDetail, GEMINI_HOOK_EVENT_NAMES } from './event-vocabulary';
import { buildGeminiLaunchCommand, writeGeminiHookSettings } from './settings-generator';
import { GEMINI_CLI_TOOL_ID } from './tool-id';

/**
 * Write this worktree's `.gemini/settings.json` and build the launch line
 * (S3 / S4 / S5).
 *
 * **This used to be the one thing {@link AgentEventSource} could not express.**
 * `prepareLaunch` took `(target, executablePath)`, gemini's config lives at
 * `<worktree>/.gemini/settings.json`, and an `AgentInstanceRef` carries no
 * filesystem path — so #1762 exported `injectGeminiHookSettings(worktreePath,
 * target)` beside the source and `cli-tools/gemini.ts` called both. One of the
 * six sources wrote its config from a different call site than the other five,
 * and a reader of this file could not tell that the config was written at all.
 *
 * Issue #1846 put `worktreePath` on {@link AgentLaunchContext} instead, so the
 * write happens here, `settingsPath` reports the file that was actually
 * written, and the second entry point is gone.
 *
 * Never throws — `writeGeminiHookSettings` swallows its own failures and answers
 * null, and a gemini session with no hooks is the pre-#1762 status quo.
 *
 * @param context - The instance, its executable, and the worktree it runs in
 * @returns The command, its environment, and the settings file when one landed
 */
export function prepareGeminiLaunch({
  target,
  executablePath,
  worktreePath,
}: AgentLaunchContext): AgentLaunchPlan {
  const settingsTarget: HookSettingsTarget = {
    worktreeId: target.worktreeId,
    instanceId: target.instanceId,
    cliToolId: GEMINI_CLI_TOOL_ID,
  };
  // Checked before the write as well as inside `buildGeminiLaunchCommand`: an
  // id the receiver would reject is an id no settings file should name either.
  const settingsPath = isValidInstanceId(target.instanceId ?? GEMINI_CLI_TOOL_ID)
    ? writeGeminiHookSettings(worktreePath, settingsTarget)
    : null;
  const { command, env } = buildGeminiLaunchCommand(executablePath, settingsTarget);
  return { command, settingsPath, env };
}

/**
 * Gemini CLI as an event source.
 *
 * Registered in `../registry`. Nothing outside this directory imports it by
 * name; callers ask the registry for the tool they are holding.
 */
export const geminiAgentEventSource: AgentEventSource = definePushHookSource({
  cliToolId: GEMINI_CLI_TOOL_ID,

  // Silence cannot block: `decision` and `continue` are both absent from an
  // empty reply, and both parsers test for a present value. See the module
  // comment for the three lines of gemini's own code this rests on.
  noDecision: { kind: 'proceeds' },

  capabilities: {
    // What CommandMate's injected config makes gemini emit. `pre_tool_use` and
    // `post_tool_use` are absent on purpose — the spellings are mapped, but the
    // hooks are not registered (see `./settings-generator`), so a caller waiting
    // for one from a CommandMate-started gemini session would wait for good.
    supportedEvents: ['session_start', 'user_prompt_submit', 'stop', 'notification', 'session_end'],
    configScope: 'per-worktree',
    // No gemini event waits on a verdict from CommandMate. See the module comment.
    decisionTimeoutSeconds: 0,
    // Issue #1924, §4 D3. The one source that registers no permission hook at
    // all: `../gemini/settings-generator` never writes one, so `PreToolUse` is
    // mapped and never registered and `reportPendingDialog` is unreachable for
    // this tool. There is no non-allow answer to read a forecast out of.
    permissionHookPredictsDialog: false,
    // Not audited. Default = Claude's current behaviour.
    sessionStartMayArriveLate: false,
    permissionReplyReleasesPrompt: false,
    eventIdentity: null,
    resync: 'none',
    // Issue #2197. Nobody but the screen scraper records gemini replies.
    transcriptHistory: null,
  },

  // gemini's own table, kept in gemini's own module: four of the seven are
  // spelled differently, and merging them into the shared CamelCase table would
  // teach Claude, codex and copilot to accept spellings none of them sends
  // (`docs/design/agent-event-source-interface.md` §5).
  mappers: fromNameTable(GEMINI_HOOK_EVENT_NAMES),

  nativeEventNameFields: ['hook_event_name'],
  conversationIdFields: SESSION_ID_FIELDS,
  // gemini publishes no per-tool-call correlation id: its `BeforeTool` payload
  // carries `tool_name` and `tool_input` and nothing resembling `tool_use_id`.
  toolCallIdFields: [],

  extractDetail: extractGeminiEventDetail,

  // gemini has no `PermissionRequest` event and no `AskUserQuestion` tool
  // (#1757 §8.1), so there is no payload of either kind to read. Null is the
  // honest answer and degrades to the behaviour of a machine without hooks.
  parsePermissionRequest: () => null,
  parseQuestion: () => null,

  // gemini hooks cannot approve — only deny, escalate to a dialog, or stop the
  // agent outright. CommandMate emits none of those: a denial from Auto-Yes
  // takes the choice away in the direction waiting cannot undo, and an
  // escalation would add dialogs the Policy Engine had already settled. So every
  // verdict encodes to the empty body, which the bundle reads as no opinion.
  encodeVerdict: () => ({}),

  // Config write and command line, both from here since #1846. `CM_HOOK_URL` is
  // the plan's `env` rather than a prefix on `command`.
  prepareLaunch: prepareGeminiLaunch,
});
