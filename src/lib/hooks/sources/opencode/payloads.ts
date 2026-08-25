/**
 * Reading opencode's approval and question payloads (Issue #1763, seam S7).
 *
 * Both shapes are taken from captured frames — `permission-asked.json` and
 * `question-asked.json` in `tests/fixtures/hooks/opencode/` — and both are
 * parsed into the vocabulary the tool-independent adjudicator already speaks,
 * so `permission-decision-service` and `agent-event-state` need no opencode
 * branch.
 *
 * ## The tool name is not in the approval payload
 *
 * `permission.asked` carries `permission` (the *kind* of approval:
 * `external_directory`, …), `patterns`, `metadata` and `tool.callID` — but no
 * tool name (#1758 §5.4). Auto-Yes matches deny patterns against what is being
 * asked for, so the name has to come from somewhere: the `message.part.updated`
 * frame for the same `callID` carries `part.tool` (`bash`), and it arrives
 * first, so the subscription records the correlation as it goes and this module
 * looks it up. When the correlation is missing the approval kind is used
 * instead — an unknown tool name makes `collectToolInputMatchTexts` fall back
 * to the serialised input, which contains the command, so the matching surface
 * never silently empties.
 *
 * ## What the deny patterns see
 *
 * `metadata` verbatim (it holds `command` for `bash` approvals), plus the
 * approval kind and its patterns. Nothing from the pane and nothing from an
 * earlier request can reach it — the property #1699 was opened about.
 *
 * @module lib/hooks/sources/opencode/payloads
 */

import {
  parseAskUserQuestionToolInput,
  type AskUserQuestionSpec,
} from '@/lib/hooks/ask-user-question-payload';
import type { PermissionRequestPayload } from '@/lib/hooks/permission-request-payload';
import { isPlainObject, readNestedString, readStringField } from '../event-mapper';
import type { PendingDecision } from '../types';

/**
 * Cap on remembered `callID -> tool name` pairs.
 *
 * One per tool call, and a long session makes thousands, so the map is bounded
 * and the oldest is dropped. Forgetting costs a less specific tool name on an
 * approval, never a wrong one.
 */
export const MAX_TRACKED_TOOL_CALLS = 256;

/**
 * The correlation table, on `globalThis` for the reason every shared map in
 * this codebase is (Issue #1736): a module-scoped copy would be written by the
 * subscription's bundle and read as empty by the receiver's.
 */
declare global {
  // eslint-disable-next-line no-var
  var __opencodeToolCallNames: Map<string, string> | undefined;
}

const toolCallNames = (globalThis.__opencodeToolCallNames ??= new Map<string, string>());

/** Record that a tool call has a name, seen on a `message.part.updated` frame. */
export function rememberOpencodeToolCall(callId: string, toolName: string): void {
  toolCallNames.delete(callId);
  toolCallNames.set(callId, toolName);
  while (toolCallNames.size > MAX_TRACKED_TOOL_CALLS) {
    const oldest = toolCallNames.keys().next();
    if (oldest.done) break;
    toolCallNames.delete(oldest.value);
  }
}

/** The tool behind a `callID`, or null when it has not been seen. */
export function lookupOpencodeToolName(callId: string | null): string | null {
  if (!callId) return null;
  return toolCallNames.get(callId) ?? null;
}

/** Forget every correlation. Test seam. */
export function resetOpencodeToolCalls(): void {
  toolCallNames.clear();
}

/**
 * The object an approval or question lives in.
 *
 * Two callers hand this module two different shapes and both are legitimate:
 * the SSE frame `{ id, type, properties }`, and the bare object
 * `GET /permission` returns when a missed event is being recovered. Unwrapping
 * here is what lets the reconnect path reuse the live path's parsing.
 */
function unwrap(payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof payload.type === 'string' && isPlainObject(payload.properties)) {
    return payload.properties;
  }
  return payload;
}

/** `tool.callID`, present on both approvals and questions. */
function toolCallId(properties: Record<string, unknown>): string | null {
  return readNestedString(properties, ['tool', 'callID']);
}

/**
 * Read a `permission.asked` frame, or a pending entry from `GET /permission`.
 *
 * @param payload - The frame or the bare permission object
 * @returns The payload the adjudicator judges, or null when this is not an
 *   approval this server can read — which every caller must treat as "no
 *   decision", i.e. leave it for the human
 */
export function parseOpencodePermissionRequest(
  payload: Record<string, unknown>
): PermissionRequestPayload | null {
  const properties = unwrap(payload);

  const permissionId = readStringField(properties, 'id');
  const sessionId = readStringField(properties, 'sessionID');
  // Both are required: the id is what a verdict is addressed to, and without a
  // session there is nothing to attribute the request to.
  if (!permissionId || !sessionId) return null;
  // `question.asked` shares the envelope; it is answered with choices, never
  // adjudicated as an approval.
  if (Array.isArray(properties.questions)) return null;

  const kind = readStringField(properties, 'permission');
  const metadata = isPlainObject(properties.metadata) ? properties.metadata : {};

  return {
    toolName: lookupOpencodeToolName(toolCallId(properties)) ?? kind ?? 'permission',
    toolInput: {
      permission: kind,
      patterns: Array.isArray(properties.patterns) ? properties.patterns : [],
      ...metadata,
    },
    // `per_…` is what the reply URL takes, and it is stable for the life of the
    // request — the correlation key Claude spells `prompt_id`.
    promptId: permissionId,
    sessionId,
    // opencode has no equivalent of Claude's permission mode: the dialog is
    // drawn unconditionally (§5.5.3), so there is no "do not ask me" state that
    // would make a no-decision non-blocking.
    permissionMode: null,
    // `always` is the rule that would be saved by answering `always`. Recorded
    // for the audit trail, never a decision input — it is opencode's suggestion,
    // which is the thing being judged.
    permissionSuggestions: Array.isArray(properties.always) ? properties.always : null,
  };
}

/**
 * Read a `question.asked` frame (#1758 §5.2.4).
 *
 * The one place opencode is *better* structured than Claude: the choices arrive
 * as data, where Claude's `AskUserQuestion` picker had to be read off the
 * screen. The inner shape — `{ question, header, options: [{ label,
 * description }] }` — is identical to Claude's `tool_input.questions`, so the
 * existing strict parser is reused rather than re-derived.
 *
 * @returns The spec, or null when this is not a readable question
 */
export function parseOpencodeQuestion(
  payload: Record<string, unknown>
): AskUserQuestionSpec | null {
  const properties = unwrap(payload);
  const questionId = readStringField(properties, 'id');
  if (!questionId) return null;

  const questions = parseAskUserQuestionToolInput({ questions: properties.questions });
  if (questions === null) return null;

  return { questions, promptId: questionId };
}

/**
 * Turn an approval into the transport-independent {@link PendingDecision}.
 *
 * @param payload - A `permission.asked` frame or a `GET /permission` entry
 * @param askedAt - Epoch ms
 */
export function toOpencodePendingPermission(
  payload: Record<string, unknown>,
  askedAt: number
): PendingDecision | null {
  const parsed = parseOpencodePermissionRequest(payload);
  if (!parsed || !parsed.promptId) return null;
  return {
    kind: 'permission',
    id: parsed.promptId,
    conversationId: parsed.sessionId,
    subject: { kind: 'permission', toolName: parsed.toolName, toolInput: parsed.toolInput },
    raw: payload,
    askedAt,
  };
}

/**
 * What an approval is ABOUT, for the surfaces that have to show it
 * (Issue #2031).
 *
 * Read back off {@link toOpencodePendingPermission} rather than re-parsed from
 * the frame, and that is the point rather than an economy: the pending decision
 * is what the adjudicator judges and what `Allow always` is delivered against,
 * so a panel describing a *differently* parsed view of the same frame could
 * tell the user one thing while the verdict did another. One parse, two
 * readers.
 *
 * The tool name is the `message.part.updated` correlation
 * ({@link lookupOpencodeToolName}) with the approval kind behind it, because
 * `permission.asked` carries no tool name of its own (#1758 §5.4).
 *
 * `patterns` comes back as `toolInput.patterns`, which is NOT always the
 * frame's top-level `properties.patterns`: `parseOpencodePermissionRequest`
 * spreads `metadata` last, so an approval whose metadata carries its own
 * `patterns` shadows the outer list. That is the behaviour to keep, not a wart
 * to route around — the shadowed list is what the adjudicator judged and what
 * `Allow always` is delivered against, and a panel showing the other one would
 * describe a verdict nobody is about to take. Pinned in
 * `opencode-permission-subject-2031`.
 *
 * `patterns` is left unbounded here on purpose. It is bounded where it is
 * *retained* — `boundDecisionPatterns` in `lib/session/provisional-turn`,
 * beside the bounds on `message` and `toolName` — so there is one place the
 * footprint of a stored decision is decided, and a second bound here would be a
 * second number to keep in step with it.
 *
 * @param payload - A `permission.asked` frame or a `GET /permission` entry
 * @param askedAt - Epoch ms
 * @returns The subject, or null when this is not an approval this server reads
 */
export function readOpencodePermissionSubject(
  payload: Record<string, unknown>,
  askedAt: number
): { toolName: string | null; patterns: readonly unknown[] } | null {
  const pending = toOpencodePendingPermission(payload, askedAt);
  if (!pending || pending.subject.kind !== 'permission') return null;
  const patterns = (pending.subject.toolInput as { patterns?: unknown }).patterns;
  return {
    toolName: pending.subject.toolName,
    patterns: Array.isArray(patterns) ? patterns : [],
  };
}

/** Turn a question into a {@link PendingDecision}. */
export function toOpencodePendingQuestion(
  payload: Record<string, unknown>,
  askedAt: number
): PendingDecision | null {
  const properties = unwrap(payload);
  const questionId = readStringField(properties, 'id');
  const spec = parseOpencodeQuestion(payload);
  if (!questionId || !spec) return null;
  return {
    kind: 'question',
    id: questionId,
    conversationId: readStringField(properties, 'sessionID'),
    subject: { kind: 'question', spec },
    raw: payload,
    askedAt,
  };
}
