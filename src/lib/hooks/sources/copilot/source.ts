/**
 * GitHub Copilot CLI's {@link AgentEventSource} (Issue #1761, Epic #1720 Phase
 * 4-3).
 *
 * Issue #1761 was filed as conditional — "copilot 1.0.77 may have no hooks at
 * all; if it does not, withdraw this Issue" — on the evidence that
 * `copilot --help` never says the word. The #1757 spike then found the feature
 * documented in `copilot help config`, drove six events out of a live session,
 * and captured them into `tests/fixtures/hooks/copilot/`. The premise is
 * inverted: of the four tools Phase 4 adds, **copilot's payloads are the
 * closest to Claude Code's**, and this file is correspondingly short.
 *
 * What it does *not* share with Claude is where the config goes, how a verdict
 * gets back, and how long there is to send one. All three live in
 * `./hook-settings`; the module comment there is the one to read before
 * changing anything about delivery.
 *
 * ## The four values that are not Claude's
 *
 *  - **`configScope: 'global-singleton'`.** There is no `--settings`. One file,
 *    `~/.copilot/settings.json`, for every session on the machine — so the
 *    correlation keys cannot be baked into it and ride in the environment
 *    instead.
 *  - **`decisionTimeoutSeconds: 10`**, against Claude's 600 (#1757 §5.2.3). A
 *    decision path budgeted for Claude misses copilot's window entirely and the
 *    tool call proceeds unadjudicated.
 *  - **`supportedEvents` omits `notification` and `pre_tool_use`.** See below;
 *    both omissions are deliberate and neither is a gap in the mapping.
 *  - **`encodeVerdict` speaks `permissionDecision`**, not Claude's
 *    `decision.behavior`, and copilot can express a denial that Claude cannot.
 *
 * ## Why `pre_tool_use` is not in `supportedEvents`
 *
 * Copilot has no `PermissionRequest`. `PreToolUse` *is* its approval gate: the
 * hook's stdout decides whether the call runs (#1757 §5.2.4, re-measured for
 * this Issue against 1.0.79 — `deny` prints `Denied by preToolUse hook: …` and
 * the command does not execute). CommandMate therefore points that one event at
 * `/api/hooks/permission-request`, which adjudicates and does not record.
 *
 * So `pre_tool_use` never reaches `agent-event-state` for copilot, and
 * `supportedEvents` is a promise about what does: listing it would leave a
 * caller waiting for an event that is being answered somewhere else. The mapper
 * still recognises the spelling — a hand-configured hook from #1549 pointed at
 * the event route keeps working — which is why the omission is in
 * `capabilities` and not in `mappers`.
 *
 * `notification` is omitted for the opposite reason: it was configured during
 * the spike and **never fired once**, so there is no captured payload and no
 * evidence about what `notification_type` would even contain. Prompt detection
 * for copilot stays with the screen scraper (#1723), which is where it already
 * is.
 *
 * ## Why `session_start` is not a "the agent is up" signal
 *
 * Copilot fires `UserPromptSubmit` **before** `SessionStart` — 20.813Z against
 * 20.915Z, measured. Anything ordering-sensitive built on these two words is
 * wrong for this tool specifically, which is why the fence in
 * `beginAgentSession` is a timestamp rather than a state machine.
 *
 * @module lib/hooks/sources/copilot/source
 */

import { MAX_TOOL_NAME_LENGTH, type PermissionRequestPayload } from '@/lib/hooks/permission-request-payload';
import { readPermissionToolInput } from '@/lib/hooks/tool-input-normalization';
import { definePushHookSource } from '../define-source';
import { fromNameTable, isPlainObject, readStringField } from '../event-mapper';
import {
  CAMEL_CASE_HOOK_EVENT_NAMES,
  extractSnakeCaseEventDetail,
  SESSION_ID_FIELDS,
  TOOL_CALL_ID_FIELDS,
} from '../hook-event-vocabulary';
import type { AgentEventSource, AgentLaunchContext, AgentLaunchPlan, Verdict } from '../types';
import {
  buildCopilotLaunchCommand,
  COPILOT_HOOK_TIMEOUT_SECONDS,
  COPILOT_PERMISSION_HOOK_EVENT,
} from './hook-settings';
import { COPILOT_CLI_TOOL_ID } from './tool-id';

/**
 * No opinion, byte-for-byte the reply the spike measured copilot treating as
 * "carry on" (#1757 §5.2.4).
 *
 * The same object Claude reads the same way — which is a coincidence worth
 * naming, because it is emphatically not true of antigravity, where `{}` is a
 * denial (#1757 P10).
 */
const NO_DECISION_BODY: Record<string, unknown> = {};

/**
 * Read copilot's `PreToolUse` payload as a permission request (S7).
 *
 * Deliberately not `parsePermissionRequestPayload`: that one insists on
 * `hook_event_name === 'PermissionRequest'`, an event copilot does not have, so
 * reusing it would answer null for every request copilot ever makes and
 * Auto-Yes would abstain on all of them — silently, and looking exactly like a
 * working feature with nothing to approve.
 *
 * Strict in the same way and for the same reason: anything unvouchable becomes
 * null, the caller turns null into no-decision, and the fallback is a dialog
 * rather than an execution.
 *
 * `promptId` is always null — copilot sends no correlation id on this payload
 * (nor on `PreToolUse`/`PostToolUse`; #1757 R5) — so the permission route mints
 * its own id for the in-flight request.
 *
 * @param body - Whatever was posted to `/api/hooks/permission-request`
 */
export function parseCopilotPermissionRequest(body: unknown): PermissionRequestPayload | null {
  if (!isPlainObject(body)) return null;
  if (body.hook_event_name !== COPILOT_PERMISSION_HOOK_EVENT) return null;

  const toolName = readStringField(body, 'tool_name');
  if (!toolName || toolName.length > MAX_TOOL_NAME_LENGTH) return null;

  // No usable `tool_input` means nothing for the deny patterns to be judged
  // against, which makes the request unadjudicatable rather than harmless.
  //
  // Issue #1902: this used to be `isPlainObject(body.tool_input)`, and that was
  // the bug. Copilot 1.0.80's `Edit` sends the apply-patch envelope as a bare
  // *string*, so the object check answered null for every file edit copilot
  // ever made — null became `unknown-payload`, `unknown-payload` is a
  // no-decision, and Auto-Yes v2 abstained on the whole edit family while
  // working perfectly on `Read` and `Bash`, whose inputs are objects. The
  // string is now read as a patch and the rewrite is reported rather than done
  // in silence; see `lib/hooks/tool-input-normalization`.
  const input = readPermissionToolInput(body.tool_input);
  if (!input) return null;

  return {
    toolName,
    toolInput: input.toolInput,
    toolInputNormalization: input.normalization,
    promptId: null,
    sessionId: readStringField(body, 'session_id'),
    permissionMode: null,
    permissionSuggestions: null,
  };
}

/**
 * Encode a verdict in copilot's wire form (S6).
 *
 * `hookSpecificOutput.permissionDecision`, verified end to end against copilot
 * 1.0.79: `allow` ran a shell command that would otherwise have prompted,
 * `deny` refused it and printed the reason, and `{}` fell through to the
 * ordinary flow.
 *
 * `deny` is encoded rather than collapsed — this is the one place copilot is
 * *more* expressive than Claude, whose source has no spelling for it. Nothing
 * produces one today (`permission-decision-service` answers allow or
 * no-decision and never denies, on purpose), so this branch is a capability
 * being stated honestly, not a behaviour being switched on.
 *
 * `allowAlways` and `answer` collapse to no-decision: copilot's
 * `permissionDecision` has no persistent form, and approving one call is not
 * the same promise as writing a standing rule.
 */
export function encodeCopilotVerdict(verdict: Verdict): Record<string, unknown> {
  if (verdict.kind === 'allowOnce') {
    return {
      hookSpecificOutput: {
        hookEventName: COPILOT_PERMISSION_HOOK_EVENT,
        permissionDecision: 'allow',
      },
    };
  }
  if (verdict.kind === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: COPILOT_PERMISSION_HOOK_EVENT,
        permissionDecision: 'deny',
        permissionDecisionReason: verdict.message ?? 'denied by CommandMate',
      },
    };
  }
  return NO_DECISION_BODY;
}

/**
 * GitHub Copilot CLI as an event source.
 *
 * Registered in `../registry`. Nothing outside this directory imports it by
 * name; callers ask the registry for the tool they are holding.
 */
export const copilotAgentEventSource: AgentEventSource = definePushHookSource({
  cliToolId: COPILOT_CLI_TOOL_ID,

  // #1757 §5.2.4, re-confirmed here: an empty reply, an unreachable server and
  // a late reply all land in copilot's ordinary approval flow. Abstaining costs
  // a dialog and nothing else — true for Claude, codex and copilot, false for
  // antigravity and opencode (C3).
  noDecision: { kind: 'proceeds' },

  capabilities: {
    // Five of the seven. `pre_tool_use` is answered by the permission receiver
    // rather than recorded, and `notification` has never been observed to fire.
    // Both are explained at the top of this file; neither is an oversight.
    supportedEvents: [
      'stop',
      'session_start',
      'session_end',
      'user_prompt_submit',
      'post_tool_use',
    ],
    // One file for the whole machine. See `./hook-settings`.
    configScope: 'global-singleton',
    decisionTimeoutSeconds: COPILOT_HOOK_TIMEOUT_SECONDS,
    // Issue #1924, §4 D3. copilot DOES register a permission hook — this is the
    // row where registration and prediction come apart. It fires on every tool
    // call and copilot executes most of them straight away (#1901), so reading a
    // non-allow as "a dialog is coming" files a prompt that never appears and
    // leaves the pane `waiting` until the provisional record expires.
    permissionHookPredictsDialog: false,
    // The one `true` in this column, and a stopwatch rather than an inference:
    // `UserPromptSubmit` at 20.813Z, `SessionStart` at 20.915Z (#1903). See the
    // module comment above.
    sessionStartMayArriveLate: true,
    permissionReplyReleasesPrompt: false,
    // Not audited. No captured copilot payload carries a `tool_use_id`, so
    // `'tool-call-id'` would be a guess; whether one exists is still to be
    // measured. Default = Claude's fallback, the time window.
    eventIdentity: null,
    resync: 'none',
  },

  // The same CamelCase dialect as Claude and codex — measured against six
  // captured payloads (#1757 §8.1), not assumed from the resemblance. Shared
  // rather than copied: `hook-event-vocabulary` exists to be the dialect these
  // three tools agree on, and a private copy here would be a second place for
  // the same spelling to drift.
  mappers: fromNameTable(CAMEL_CASE_HOOK_EVENT_NAMES),

  nativeEventNameFields: ['hook_event_name'],
  conversationIdFields: SESSION_ID_FIELDS,
  // No captured copilot payload carries one, so this answers null in practice;
  // it is wired anyway so that a future release which adds `tool_use_id` is
  // correlated rather than ignored.
  toolCallIdFields: TOOL_CALL_ID_FIELDS,

  // snake_case throughout, exactly as Claude spells it: `source` on
  // `SessionStart`, `reason` on `SessionEnd`, `tool_name` on the tool events.
  extractDetail: extractSnakeCaseEventDetail,

  parsePermissionRequest: parseCopilotPermissionRequest,

  // Copilot has no `AskUserQuestion` tool and no captured payload resembling
  // one. Null is "no structured data", which degrades to the behaviour of a
  // machine without hooks rather than to a guess.
  parseQuestion: () => null,

  encodeVerdict: encodeCopilotVerdict,

  prepareLaunch: ({ target, executablePath }: AgentLaunchContext): AgentLaunchPlan =>
    buildCopilotLaunchCommand(executablePath, target),
});
