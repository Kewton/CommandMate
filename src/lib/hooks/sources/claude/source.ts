/**
 * Claude Code's {@link AgentEventSource} — the first implementation of the
 * Issue #1759 abstraction, and the one that has to keep behaving exactly as it
 * did before the abstraction existed.
 *
 * Everything here was already in the codebase; what changed is where it lives.
 * The event-name table and the subtype extraction came out of
 * `agent-event-types` (S1/S2), the verdict shape out of the permission receiver
 * (S6), the payload parsers were already their own modules (S7), and the
 * settings/launch generation stays in `hook-settings-generator` and is reached
 * through {@link prepareLaunch} (S3/S4/S5). No spelling, no field name and no
 * emitted byte is different from before — `buildAgentHookSettings` is untouched
 * and the receiver's decision body is produced by the same code path.
 *
 * ## Why the values below are what they are
 *
 * - `noDecision: 'proceeds'` — measured, not assumed. #1721 D5 drove a live
 *   session with a hook that answered `{}` and watched the ordinary TUI
 *   approval dialog appear, indistinguishable from a machine with no hook at
 *   all. This is what makes "when in doubt, abstain" a safe rule *for Claude*;
 *   it is not a safe rule for antigravity or opencode (C3).
 * - `configScope: 'per-instance'` — `--settings <file>` is per launch, so
 *   `claude` and `claude-2` in one worktree get different files with different
 *   correlation keys baked into the URLs. Most tools cannot do this;
 *   antigravity reads one global file and nothing else (#1757 P8).
 * - `decisionTimeoutSeconds` — `PERMISSION_REQUEST_TIMEOUT_SECONDS`, the number
 *   the generator writes into the hook. copilot's equivalent is ≈10s and
 *   codex's 600s, which is why the number is a capability rather than a
 *   constant somebody reads once.
 *
 * @module lib/hooks/sources/claude/source
 */

import { AGENT_EVENT_TYPES } from '@/lib/hooks/agent-event-types';
import { parseAskUserQuestionPayload } from '@/lib/hooks/ask-user-question-payload';
import {
  buildClaudeLaunchCommand,
  getHookSettingsPath,
  isHookInjectionEnabled,
  PERMISSION_REQUEST_TIMEOUT_SECONDS,
} from '@/lib/hooks/hook-settings-generator';
import {
  parsePermissionRequestPayload,
  PERMISSION_REQUEST_EVENT_NAME,
} from '@/lib/hooks/permission-request-payload';
import { definePushHookSource } from '../define-source';
import { fromNameTable } from '../event-mapper';
import {
  CAMEL_CASE_HOOK_EVENT_NAMES,
  extractSnakeCaseEventDetail,
  SESSION_ID_FIELDS,
  TOOL_CALL_ID_FIELDS,
} from '../hook-event-vocabulary';
import type { AgentEventSource, AgentInstanceRef, AgentLaunchPlan, Verdict } from '../types';
import { CLAUDE_CLI_TOOL_ID } from './tool-id';

/**
 * The no-decision body, byte for byte what the #1721 spike returned for D5.
 *
 * Empty is not "an error we swallowed": it is the documented way to say
 * "CommandMate has no opinion", and Claude responds to it by doing what it
 * would have done with no hook installed.
 */
const NO_DECISION_BODY: Record<string, unknown> = {};

/**
 * Encode a verdict the way §5.4 of the verification report measured Claude
 * obeying (S6).
 *
 * `hookEventName` is required alongside `decision`; without it the body is
 * ignored in silence.
 *
 * Three of the five verdicts collapse to no-decision, and that is the design
 * rather than a gap:
 *
 *  - `allowAlways` has no Claude spelling. `permission_suggestions` offers
 *    `addRules` candidates, but writing a persistent rule from a hook is a
 *    different and much larger promise than approving one call, so this source
 *    declines instead of approximating.
 *  - `deny` is never emitted at all. `lib/hooks/permission-decision-service`
 *    explains why: a denial from Auto-Yes takes the choice away from the human
 *    in the direction that cannot be undone by waiting, and every case that
 *    wants one is better served by letting the dialog appear.
 *  - `answer` belongs to `AskUserQuestion`, whose picker is drawn regardless of
 *    what a `PermissionRequest` hook says (#1721 §5.6) — answering here would
 *    be answering a question the human is about to be shown anyway.
 */
export function encodeClaudeVerdict(verdict: Verdict): Record<string, unknown> {
  if (verdict.kind !== 'allowOnce') return NO_DECISION_BODY;
  return {
    hookSpecificOutput: {
      hookEventName: PERMISSION_REQUEST_EVENT_NAME,
      decision: { behavior: 'allow' },
    },
  };
}

/**
 * Claude Code as an event source.
 *
 * Registered in `../registry`. Nothing outside this directory imports it by
 * name; callers ask the registry for the tool they are holding.
 */
export const claudeAgentEventSource: AgentEventSource = definePushHookSource({
  cliToolId: CLAUDE_CLI_TOOL_ID,

  // #1721 D5: an unanswered or empty `PermissionRequest` lands in the ordinary
  // approval flow. Abstaining is free here — and only here plus codex/copilot.
  noDecision: { kind: 'proceeds' },

  capabilities: {
    // Claude is the one tool that emits all seven (#1757 §8.1). It is still not
    // a licence to treat `session_end` as "the process exited": `/clear` emits
    // one too, with `reason: "clear"`, and the pane keeps running.
    supportedEvents: AGENT_EVENT_TYPES,
    configScope: 'per-instance',
    decisionTimeoutSeconds: PERMISSION_REQUEST_TIMEOUT_SECONDS,
  },

  // S1. A plain name table is enough *for this tool* — one native name, one
  // word, no predicates — so it is expressed as rules built from the table
  // rather than as a table, and a source that needs conditions (opencode) adds
  // them to the same list.
  mappers: fromNameTable(CAMEL_CASE_HOOK_EVENT_NAMES),

  nativeEventNameFields: ['hook_event_name'],
  conversationIdFields: SESSION_ID_FIELDS,
  toolCallIdFields: TOOL_CALL_ID_FIELDS,

  // S2.
  extractDetail: extractSnakeCaseEventDetail,

  // S7. Both parsers are strict and answer null for anything they cannot vouch
  // for; the callers turn null into "no structured data", which degrades to the
  // behaviour of a machine without hooks rather than into a guess.
  parsePermissionRequest: (payload) => parsePermissionRequestPayload(payload),
  parseQuestion: (payload) => parseAskUserQuestionPayload(payload),

  // S6.
  encodeVerdict: encodeClaudeVerdict,

  // S3 / S4 / S5. Delegated rather than reimplemented: `buildClaudeLaunchCommand`
  // writes the settings file, falls back to the bare path on any failure, and is
  // covered byte-for-byte by `tests/unit/hooks/hook-settings-generator.test.ts`.
  prepareLaunch: (target: AgentInstanceRef, executablePath: string): AgentLaunchPlan => {
    const command = buildClaudeLaunchCommand(executablePath, {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId,
      cliToolId: target.cliToolId,
    });
    // The path is reported only when the command actually names it. Injection
    // can be switched off (`CM_AGENT_HOOKS_INJECT=0`) or fail to write, and both
    // return the bare executable — claiming a settings file in that case would
    // be telling the caller about a file that is not there.
    const settingsPath =
      isHookInjectionEnabled() && command !== executablePath
        ? getHookSettingsPath({
            worktreeId: target.worktreeId,
            instanceId: target.instanceId,
            cliToolId: target.cliToolId,
          })
        : null;
    return { command, settingsPath };
  },
});
