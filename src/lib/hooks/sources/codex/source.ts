/**
 * codex CLI's {@link AgentEventSource} — Phase 4-2 of Epic #1720 (Issue #1760),
 * and the first tool added through the #1759 abstraction rather than by copying
 * Claude's seams.
 *
 * Everything below is a value measured against codex-cli **0.147.0**, either by
 * the #1757 spike or by this Issue's own live runs. The four that would fail
 * silently if guessed:
 *
 *  - **`noDecision: 'proceeds'`.** Driven live: a `PermissionRequest` hook that
 *    answered `{}` produced codex's ordinary "Would you like to run the
 *    following command?" dialog, and so did a receiver that was not running.
 *    Abstaining costs a dialog here, which is what makes Auto-Yes safe to leave
 *    undecided — a sentence that is false for antigravity and for opencode (C3).
 *  - **No `notification`.** codex's own review screen enumerates eleven events
 *    and `Notification` is not one of them (#1757 §5.1.1); a hook registered for
 *    it is dropped without a word. Anything waiting for one would wait forever,
 *    so {@link AgentSourceCapabilities.supportedEvents} says it cannot come.
 *  - **`session_start` is not a launch signal.** It fires when the first *turn*
 *    starts, ~68 s after the process on the spike's machine (#1757 §5.1.8).
 *    Nothing may treat it as "codex is ready".
 *  - **`session_end` is not an exit signal.** `/quit` emits one; a `kill-session`
 *    does not. Process death stays tmux's job, for every tool.
 *
 * The payload dialect is Claude's — same CamelCase `hook_event_name`, same
 * `session_id`, same `tool_use_id`, same subtype fields — so this source reuses
 * the shared vocabulary instead of restating it. That is a measurement too
 * (#1757 §8.1), not an assumption: gemini renames four of the seven and
 * antigravity ships no event name at all, and both of those bring their own
 * mappers.
 *
 * @module lib/hooks/sources/codex/source
 */

import { parsePermissionRequestPayload } from '@/lib/hooks/permission-request-payload';
import { definePushHookSource } from '../define-source';
import { fromNameTable } from '../event-mapper';
import {
  CAMEL_CASE_HOOK_EVENT_NAMES,
  extractSnakeCaseEventDetail,
  SESSION_ID_FIELDS,
  TOOL_CALL_ID_FIELDS,
} from '../hook-event-vocabulary';
import type { AgentEventSource, AgentInstanceRef, AgentLaunchPlan, Verdict } from '../types';
import {
  buildCodexLaunchCommand,
  CODEX_PERMISSION_REQUEST_EVENT,
  CODEX_SUPPORTED_EVENTS,
  getCodexHooksPath,
} from './hooks-config';
import { CODEX_CLI_TOOL_ID } from './tool-id';

/** No opinion. Measured to be indistinguishable from having no hook (#1757 §5.1.6). */
const NO_DECISION_BODY: Record<string, unknown> = {};

/**
 * codex's decision wire format (S6 / #1757 §5.1.6).
 *
 * Three of the verdicts collapse to no-decision, for the reasons Claude's
 * source gives at length: `allowAlways` has no measured spelling (codex's
 * dialog has a "don't ask again" option, but no hook body was observed to
 * produce it, and approximating it would write a persistent rule nobody asked
 * for); `answer` belongs to a question picker codex does not have.
 *
 * `deny` is spelled out rather than collapsed, because unlike on Claude it was
 * measured end to end: the command did not run, the TUI printed
 * `• PermissionRequest hook (blocked)`, and the `message` was handed to the
 * agent verbatim, which reported being refused. Nothing in CommandMate produces
 * a deny today — `lib/hooks/permission-decision-service` explains why Auto-Yes
 * must not — so this is the honest encoding of a verdict that is currently
 * unreachable, not a new behaviour.
 */
export function encodeCodexVerdict(verdict: Verdict): Record<string, unknown> {
  if (verdict.kind === 'allowOnce') {
    return {
      hookSpecificOutput: {
        hookEventName: CODEX_PERMISSION_REQUEST_EVENT,
        decision: { behavior: 'allow' },
      },
    };
  }
  if (verdict.kind === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: CODEX_PERMISSION_REQUEST_EVENT,
        decision: { behavior: 'deny', message: verdict.message ?? '' },
      },
    };
  }
  return NO_DECISION_BODY;
}

/**
 * codex CLI as an event source.
 *
 * Registered in `../registry`. Nothing outside this directory imports it by
 * name; callers ask the registry for the tool they are holding.
 */
export const codexAgentEventSource: AgentEventSource = definePushHookSource({
  cliToolId: CODEX_CLI_TOOL_ID,

  // Measured, not inherited from Claude. See the module comment.
  noDecision: { kind: 'proceeds' },

  capabilities: {
    // What this server's config can actually produce — see CODEX_REGISTERED_EVENTS
    // for why `notification`, `pre_tool_use` and `post_tool_use` are absent.
    supportedEvents: CODEX_SUPPORTED_EVENTS,
    // One file for the machine: codex has no `--settings` and no per-launch
    // config flag, so the correlation keys travel in the environment instead.
    configScope: 'global-singleton',
    // What the generated `PermissionRequest` handler writes. codex's own default
    // is 600 s; the receiver decides from in-memory state, so the budget it
    // needs is small and the failure it bounds is a wedged server.
    decisionTimeoutSeconds: 5,
  },

  // Same CamelCase dialect as Claude and copilot (#1757 §8.1). The table is
  // shared, the choice to use it is this source's.
  mappers: fromNameTable(CAMEL_CASE_HOOK_EVENT_NAMES),

  nativeEventNameFields: ['hook_event_name'],
  conversationIdFields: SESSION_ID_FIELDS,
  toolCallIdFields: TOOL_CALL_ID_FIELDS,

  // Issue #1783. Same spelling as Claude, but on every event except `SessionEnd`
  // rather than on `SessionStart` alone — verified against the fixtures, where
  // only `session-end.json` lacks the key. codex therefore keeps its model
  // visible through a restart of this server, which claude does not.
  modelFields: ['model'],

  extractDetail: extractSnakeCaseEventDetail,

  // The captured `PermissionRequest` payload is Claude-shaped field for field —
  // `hook_event_name`, `tool_name`, `tool_input`, `session_id`,
  // `permission_mode` — so the same strict parser reads it, and the fixture is
  // asserted against it rather than the resemblance being assumed.
  //
  // `prompt_id` is absent: codex's nearest field is `turn_id`, which identifies
  // a *turn* and is therefore shared by every approval inside one. Mapping it
  // onto `promptId` would give two approvals the same decision id, so it is
  // left null and the receiver mints a unique id per request.
  parsePermissionRequest: (payload) => parsePermissionRequestPayload(payload),

  // codex has no `AskUserQuestion` tool, so there is no structured question to
  // read. Null degrades to the behaviour of a machine without hooks: the picker
  // is scraped off the screen exactly as it was before this Issue.
  parseQuestion: () => null,

  encodeVerdict: encodeCodexVerdict,

  // S3 / S4 / S5. The whole of the config generation lives in `./hooks-config`,
  // which never throws — a session that starts without hooks is the status quo,
  // a session that fails to start is not.
  prepareLaunch: (target: AgentInstanceRef, executablePath: string): AgentLaunchPlan => {
    const command = buildCodexLaunchCommand(executablePath, target);
    // Reported only when the command actually reflects an injection. Both
    // `CM_AGENT_HOOKS_INJECT=0` and a file that could not be written return the
    // bare executable, and claiming a settings file then would name a file this
    // launch is not using.
    const settingsPath = command === executablePath ? null : getCodexHooksPath();
    return { command, settingsPath };
  },
});
