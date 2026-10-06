/**
 * The `AskUserQuestion` call an agent instance has in flight (Issue #1726).
 *
 * Split out of `agent-event-state` (Issue #3375), which re-exports the public
 * names and applies the transition from `recordAgentEvent`.
 *
 * @module lib/session/agent-event-ask-user-question
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';
// Issue #2100: the shared list of tool names that mean "a human is being asked
// to CHOOSE". Pure — its own only import is `permission-request-payload`, which
// this module already reached for `ASK_USER_QUESTION_TOOL` — and importing it
// here rather than repeating `'question'` is what keeps the release rule below
// and `pendingDecisionKind`'s reader from drifting apart.
import { QUESTION_DECISION_TOOL_NAMES } from '@/lib/hooks/pending-decision-kind';
import type { AgentEventRecord } from '@/lib/session/agent-event-record';
import { generationStartedAt } from '@/lib/session/agent-event-turn';
import { STRUCTURED_STATE_MAX_AGE_MS } from '@/lib/session/agent-event-structured-state';
import { getOrInitGlobal } from '../global-state';

// The maps below live on `globalThis`; see the note above `declare global` in
// `agent-event-state` for why (Issue #1736).
declare global {
  // eslint-disable-next-line no-var
  var __agentEventAskUserQuestion: Map<string, AskUserQuestionEpisode> | undefined;
}

/** compositeKey -> the `AskUserQuestion` call currently in flight (#1726). */
export const askUserQuestion = getOrInitGlobal('__agentEventAskUserQuestion', () => new Map<string, AskUserQuestionEpisode>());

/**
 * The `AskUserQuestion` call the agent has in flight (Issue #1726).
 *
 * Held apart from {@link StructuredPromptWaitingState} because it answers a
 * different question. That one says *whether* a human is blocked, and decides
 * `sessionStatus`; this one says *what they were asked*, and decides nothing —
 * it only supplies option text to a prompt some other layer has already
 * established is on screen. The split is what keeps the role table from the
 * Issue honest: the scraper detects the screen (#1708), this record describes
 * its contents.
 */
export interface AskUserQuestionEpisode {
  /** Epoch ms the invocation was reported. */
  at: number;
  /** The questions and their options, verbatim from `tool_input`. */
  spec: AskUserQuestionSpec;
}

/**
 * When the in-flight question is released (Issue #1726).
 *
 * | event                             | effect on the question |
 * |-----------------------------------|------------------------|
 * | `pre_tool_use(AskUserQuestion)`   | unchanged (this IS it) |
 * | `pre_tool_use(any other tool)`    | release                |
 * | `post_tool_use`                   | release                |
 * | `notification(permission_prompt)` | **unchanged**          |
 * | `notification(idle_prompt)`       | release                |
 * | `notification(other)`             | unchanged              |
 * | `stop`                            | release                |
 * | `user_prompt_submit`              | release                |
 * | `session_start` / `session_end`   | release                |
 *
 * `PostToolUse` is the precise release — "this tool call is over" — and `Stop`
 * is the backstop for a delivery that never arrives. Issue #1726's text proposed
 * `PostToolUse` and the #1721 spike recorded it as never observed, so this Issue
 * measured it directly on a live v2.1.223 session (2026-08-06):
 *
 * ```
 * 15:36:04.112  PreToolUse   AskUserQuestion
 * 15:36:28.643  PostToolUse  AskUserQuestion   <- the human answered
 * 15:36:29.992  Stop
 * ```
 *
 * It fires, 1.3 s ahead of `Stop` here — and much further ahead whenever the
 * agent keeps working after the answer, which is the case that matters: `Stop`
 * alone would leave a finished question in place for the whole rest of the turn.
 *
 * A `PostToolUse` for any other tool releases as well: the agent could not have
 * finished another tool call while this question was still on screen.
 *
 * **`Notification(permission_prompt)` keeping the question is a live
 * measurement, not a guess.** The #1721 report says the picker emits no events
 * while it is displayed (§5.6), and a first cut of this module read that as "any
 * event means the picker is gone". Driving a real v2.1.223 session through the
 * server on 2026-08-06 disproved it:
 *
 * ```
 * 15:29:18.099  PreToolUse(AskUserQuestion)
 * 15:29:18.109  PermissionRequest(AskUserQuestion) -> no decision
 * 15:29:24.128  Notification(permission_prompt)      <- picker still on screen
 * ```
 *
 * The notification lands ~6 s after the dialog is drawn (§5.5's timing exactly),
 * which is *inside* the window §5.6 was counting rather than outside it. Under
 * the first rule it deleted the question six seconds after it arrived, and the
 * options went back to being the screen's — which is the whole feature, silently
 * off, on every real session.
 *
 * `idle_prompt` still releases: the agent reporting it is sitting at the
 * composer is the agent saying no picker is in front of it. An unrecognised
 * notification type changes nothing, because nothing is known about it.
 */
export function applyAskUserQuestionTransition(key: string, record: AgentEventRecord): void {
  switch (record.event) {
    case 'pre_tool_use':
      // A `PreToolUse` for anything else means the agent has moved on to another
      // tool, so whatever question was in flight has been answered. Only
      // reachable when the operator's own settings.json registers a wider
      // matcher than the injected `AskUserQuestion` one — the two files are
      // concatenated, not substituted (#1722).
      //
      // Issue #2100: the exemption is the whole QUESTION vocabulary, not
      // Claude's one spelling. opencode names its question tool `question`, and
      // it publishes a tool part for the same call: measured on 1.18.23 in an
      // isolated HOME, `question.asked` and
      // `message.part.updated(tool=question, status=running)` arrive **in the
      // same millisecond**, in that order (§27.3). Under the old test the
      // second frame read as "the agent moved on to another tool" and deleted
      // the episode 1 ms after the ingest recorded it, which is why
      // `pendingDecisions[].questionOptions` and `promptData.askUserQuestion`
      // were null for every opencode question. Claude is unaffected —
      // `AskUserQuestion` is the first member of the same list — and the cost
      // is that a hook tool literally named `question` no longer releases the
      // episode, which is the same name `pendingDecisionKind` already reads as
      // "this record is a question" for every tool.
      if (!QUESTION_DECISION_TOOL_NAMES.includes(record.detail ?? '')) {
        askUserQuestion.delete(key);
      }
      return;
    case 'notification':
      if (record.detail === 'idle_prompt') askUserQuestion.delete(key);
      return;
    case 'post_tool_use':
    case 'stop':
    case 'user_prompt_submit':
    case 'session_start':
    case 'session_end':
      askUserQuestion.delete(key);
      return;
    default:
      // exhaustive check: a new AgentEventType must decide its transition here
      record.event satisfies never;
      return;
  }
}

/**
 * Record the `AskUserQuestion` invocation reported for one instance.
 *
 * Idempotent by construction: the same call is reported twice on every session
 * — once by `PreToolUse` and once by the `PermissionRequest` that
 * `AskUserQuestion` also raises with a byte-identical `tool_input` — and the
 * second delivery simply overwrites the first with the same content.
 *
 * @param at - Epoch ms; defaults to now
 */
export function recordAskUserQuestion(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  spec: AskUserQuestionSpec,
  at: number = Date.now(),
): void {
  askUserQuestion.set(buildCompositeKey(worktreeId, cliToolId, instanceId), { at, spec });
}

/**
 * The `AskUserQuestion` call in flight for this instance, or null.
 *
 * Bounded exactly like {@link getStructuredSessionState}: a record from a
 * previous generation belongs to a Claude process that no longer exists, and one
 * older than {@link STRUCTURED_STATE_MAX_AGE_MS} has outlived the screen it
 * describes. There is no provisional bound — unlike a `PermissionRequest`, a
 * `PreToolUse(AskUserQuestion)` is not a prediction that a dialog *might*
 * appear: allowing the permission request does not dismiss the picker (§5.6), so
 * the picker is drawn unconditionally.
 *
 * @param now - Epoch ms; defaults to now
 */
export function getAskUserQuestion(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now(),
): AskUserQuestionEpisode | null {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const episode = askUserQuestion.get(key);
  if (!episode) return null;

  const generation = generationStartedAt.get(key);
  if (generation !== undefined && episode.at < generation) return null;

  if (now - episode.at >= STRUCTURED_STATE_MAX_AGE_MS) return null;

  return episode;
}

/** Drop the in-flight question for one instance. */
export function clearAskUserQuestion(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): void {
  askUserQuestion.delete(buildCompositeKey(worktreeId, cliToolId, instanceId));
}
