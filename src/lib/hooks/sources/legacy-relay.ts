/**
 * The source used for a tool that has no source yet (Issue #1759).
 *
 * `POST /api/hooks/agent-event` has accepted `{"tool":"codex","event":"stop"}`
 * since #1549, from hooks operators wired up by hand following
 * `docs/user-guide/agent-event-hooks.md`. Those requests work today, and Phase
 * 4-1 is a refactor: if asking the registry for an unregistered tool returned
 * nothing, every one of them would start failing on the day this abstraction
 * landed, for a reason that has nothing to do with what changed.
 *
 * So an unregistered tool gets this: the CamelCase name table and the
 * snake_case subtype extraction that the receiver applied to every tool before
 * the abstraction existed, which is exactly the behaviour being preserved. It
 * is *not* a claim that the table is right for that tool — gemini spells four
 * of the seven differently and antigravity spells none of them — only that a
 * hook posting `{"event":"stop"}` keeps working while its tool waits for Phase
 * 4-2…4-5.
 *
 * Its capabilities say so: `supportedEvents` is empty, which is the honest
 * answer to "what does this tool emit?" when nobody has measured it. A caller
 * that consults capabilities gets "unknown", not a confident wrong answer.
 *
 * Registering a real source for a tool replaces this automatically; there is no
 * list to remove it from.
 *
 * @module lib/hooks/sources/legacy-relay
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { parseAskUserQuestionPayload } from '@/lib/hooks/ask-user-question-payload';
import { parsePermissionRequestPayload } from '@/lib/hooks/permission-request-payload';
import { encodeClaudeVerdict } from './claude/source';
import { definePushHookSource } from './define-source';
import { fromNameTable } from './event-mapper';
import {
  CAMEL_CASE_HOOK_EVENT_NAMES,
  extractSnakeCaseEventDetail,
  SESSION_ID_FIELDS,
  TOOL_CALL_ID_FIELDS,
} from './hook-event-vocabulary';
import type { AgentEventSource, AgentLaunchPlan } from './types';

/**
 * Build the compatibility source for one tool.
 *
 * @param cliToolId - The tool nobody has written a source for yet
 */
export function createLegacyRelaySource(cliToolId: CLIToolType): AgentEventSource {
  return definePushHookSource({
    cliToolId,

    // The conservative reading, and the one that is true of the relay path this
    // stands in for: a hook whose server does not answer is fail-open on every
    // tool measured so far (#1757 §1.2). It is stated rather than inherited so
    // that a tool where it is false — antigravity — cannot quietly ride on it;
    // that tool gets a real source in Phase 4-4, with its own value.
    noDecision: { kind: 'proceeds' },

    capabilities: {
      // Deliberately empty. Nothing has been measured for this tool through
      // this path, and an empty list reads as "unknown" where a copy of
      // Claude's list would read as a promise.
      supportedEvents: [],
      configScope: 'none',
      decisionTimeoutSeconds: null,
      // Issue #1924. Same reasoning as `supportedEvents` above: nothing has been
      // measured for this tool through this path, so every capability answers
      // the value that makes the state machine do what it does today for a tool
      // it knows nothing about. `permissionHookPredictsDialog: false` in
      // particular is deliberately NOT Claude's `true` — forecasting a dialog
      // for a tool whose permission hook nobody has seen would publish
      // `waiting` for a prompt that may not exist.
      permissionHookPredictsDialog: false,
      sessionStartMayArriveLate: false,
      permissionReplyReleasesPrompt: false,
      eventIdentity: null,
      resync: 'none',
      // Issue #2197. A tool on the compatibility relay has no reader, which
      // is the same "nobody has measured this" the empty event list states.
      transcriptHistory: null,
    },

    mappers: fromNameTable(CAMEL_CASE_HOOK_EVENT_NAMES),
    nativeEventNameFields: ['hook_event_name'],
    conversationIdFields: SESSION_ID_FIELDS,
    toolCallIdFields: TOOL_CALL_ID_FIELDS,
    extractDetail: extractSnakeCaseEventDetail,

    // Both receivers applied these parsers to every tool before #1759, so both
    // stay wired here. They are strict — a payload that is not in Claude's
    // shape answers null, which becomes "no structured data" / "no decision" —
    // so applying them to a tool whose shape is unknown costs nothing and
    // changes no behaviour that existed on the day this file landed.
    parsePermissionRequest: (payload) => parsePermissionRequestPayload(payload),
    parseQuestion: (payload) => parseAskUserQuestionPayload(payload),

    // Likewise the verdict body: the permission receiver emitted Claude's shape
    // for whatever tool reached it. **A real source must override this.**
    // antigravity in particular reads an empty object as a denial and stops the
    // tool call (#1757 P10), so Phase 4-4 has to encode abstention positively
    // rather than inherit anything from here.
    encodeVerdict: encodeClaudeVerdict,

    // CommandMate does not inject config for these tools; their `startSession`
    // in `src/lib/cli-tools/<tool>.ts` launches them bare.
    prepareLaunch: ({ executablePath }): AgentLaunchPlan => ({
      command: executablePath,
      settingsPath: null,
      env: {},
    }),
  });
}
