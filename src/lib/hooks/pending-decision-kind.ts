/**
 * Telling an approval from a question in the *retained* dialog record
 * (Issue #2040).
 *
 * `AgentEventSource.listPending()` answers with a `PendingDecision`, which
 * carries `kind: 'permission' | 'question'` because the source read it off the
 * agent's own payload. `structuredEvents.pendingDecisions` does not come from
 * there: it comes from `agent-event-state`'s retained record, which is written
 * from hook events and from the opencode ingest and has never carried a kind.
 * A reader of `capture --json` therefore could not tell "this worker is blocked
 * on `rm -rf`" from "this worker is being asked which colour" — two situations
 * an orchestrator answers completely differently.
 *
 * The kind is not stored, it is **recovered**, and this module is the one place
 * that says how. Both writers already mark the record: a question opens it with
 * a tool name of its own, and the two names below are the two markers in use.
 * Naming them here rather than repeating the strings is what keeps the writer
 * and the reader from drifting apart — {@link OPENCODE_QUESTION_TOOL_NAME} is
 * imported by `./sources/opencode/ingest`, which is what writes it.
 *
 * ## Why this is a derivation and not a new field
 *
 * Adding `kind` to `StructuredPendingDecision` would be the direct fix, and it
 * is the right one eventually. It is not this Issue's: the record is written on
 * five paths across `agent-event-state` and `permission-decision-service`, and a
 * field that four of them leave undefined is a field whose absence has to be
 * interpreted anyway. Deriving it from what the writers already record has the
 * same answer today and no half-filled column tomorrow.
 *
 * @module lib/hooks/pending-decision-kind
 */

import { ASK_USER_QUESTION_TOOL } from './permission-request-payload';

/**
 * The tool name the opencode ingest opens a `question.asked` record under.
 *
 * Not a tool at all — opencode's question is a first-class event rather than a
 * tool call, so there is no name to copy and this word is the marker CommandMate
 * chose. Exported so the writer and this reader cannot disagree about it.
 */
export const OPENCODE_QUESTION_TOOL_NAME = 'question';

/**
 * The tool names that mean "a human is being asked to choose", not "a human is
 * being asked to approve".
 *
 * Claude's is a real tool (`AskUserQuestion`, which raises a `PermissionRequest`
 * that is never allowed — allowing it does not dismiss the picker); opencode's
 * is the marker above.
 */
export const QUESTION_DECISION_TOOL_NAMES: readonly string[] = [
  ASK_USER_QUESTION_TOOL,
  OPENCODE_QUESTION_TOOL_NAME,
];

/** Which kind of thing a retained dialog record is waiting for. */
export type PendingDecisionKind = 'permission' | 'question';

/**
 * Recover the kind of one retained dialog record.
 *
 * `'permission'` is the default rather than a third "unknown" value, and that
 * asymmetry is deliberate: a record with no tool name is a `PermissionRequest`
 * this server declined to decide — the overwhelmingly common case — and a reader
 * that has to handle a third value would end up defaulting it to the same thing
 * with less information about why.
 *
 * @param toolName - `StructuredPendingDecision.toolName`, as retained
 */
export function pendingDecisionKind(toolName: string | null): PendingDecisionKind {
  return toolName !== null && QUESTION_DECISION_TOOL_NAMES.includes(toolName)
    ? 'question'
    : 'permission';
}
