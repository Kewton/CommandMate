/**
 * A turn the model provider refused (Issue #3420, also #3421 / #3422).
 *
 * On 2026-10-08 opencode-v2's model (`Mistral Large 4`, Ollama Cloud) answered
 * every probe turn with `Error: Unauthorized` within a few hundred ms. With no
 * model reply there is no running screen, no finished reply below the quoted
 * dialog and no `session.execution.succeeded` — three fails that say nothing
 * about CommandMate's detection or its SSE mapping, and that no code change
 * can fix (the provider's credentials are the user's).
 *
 * So a check that *would fail* on a turn that visibly ended in that error is
 * reported as a `signed-out` skip (the kind gemini's "cannot sign in" uses)
 * instead. Nothing is relaxed:
 * - a check that holds still passes;
 * - the error must be new in the judged turn (counted against the frame
 *   before the request), on its own row — not inside the `┃` request box;
 * - for the SSE check, the server must also have said the execution failed
 *   (`session.execution.failed`) and only `succeeded` may be missing;
 * - other model errors (#3021's "No models loaded" came from the probe's own
 *   state isolation and was fixed in the probe) still fail.
 */

import { stripAnsi } from '@/lib/detection/ansi';
import { skipCheck } from './coverage';
import {
  evaluateServerEvents,
  OPENCODE_V2_EXECUTION_FAILED_EVENT_TYPE,
  OPENCODE_V2_REQUIRED_EVENT_TYPES,
  OPENCODE_V2_SUCCEEDED_EVENT_TYPE,
  type ReceivedServerEvent,
} from './server-events';
import { evaluateScreen, type ScreenCheckId, type ScreenVerdict } from './screen-checks';
import type { AgentHealthCheck } from './types';

/** The row the provider's refusal leaves on the pane (opencode v2.0.18). */
const MODEL_AUTH_FAILURE_ROW = /^[ \t]*Error: Unauthorized[ \t]*$/gm;

/** How many refusal rows the frame shows (ANSI stripped here). */
export function countModelAuthFailures(frame: string): number {
  return [...stripAnsi(frame).matchAll(MODEL_AUTH_FAILURE_ROW)].length;
}

/** True when `after` shows a refusal row that `before` (the frame before the request) did not. */
export function turnEndedUnauthorized(before: string, after: string): boolean {
  return countModelAuthFailures(after) > countModelAuthFailures(before);
}

const SKIP_SUMMARY = '検査不能: モデルの呼び出しが認可エラー（Error: Unauthorized）で終わった';

function excuse(check: AgentHealthCheck): AgentHealthCheck {
  return {
    ...skipCheck(
      check.checkId,
      'signed-out',
      SKIP_SUMMARY,
      `モデル（provider）の資格情報で認可されず、ターンが応答なしで終わったため判定できない。判定していれば: ${check.summary}`
    ),
    ...(check.evidence !== undefined ? { evidence: check.evidence } : {}),
  };
}

/**
 * A `screen-*` check judged on a turn's frame.
 *
 * @param before - the frame looked at just before the request was sent
 */
export function judgeTurnScreen(
  checkId: ScreenCheckId,
  verdict: ScreenVerdict,
  frame: string,
  before: string,
  note?: string
): AgentHealthCheck {
  const check: AgentHealthCheck = { checkId, ...evaluateScreen(checkId, verdict, frame, note) };
  return check.status === 'fail' && turnEndedUnauthorized(before, frame) ? excuse(check) : check;
}

/**
 * opencode-v2's `hook-correlation` (the SSE check) for a run whose turn may
 * have been refused by the provider.
 *
 * @param options.unauthorized - the turn the window covers (or, without a
 *   window, any turn) ended in the refusal row on the pane
 */
export function judgeServerEvents(
  events: readonly ReceivedServerEvent[],
  options: {
    window?: { from: number; to: number };
    streamError?: string | null;
    unauthorized: boolean;
  }
): AgentHealthCheck {
  const check: AgentHealthCheck = {
    checkId: 'hook-correlation',
    ...evaluateServerEvents(events, { window: options.window, streamError: options.streamError }),
  };
  if (check.status !== 'fail' || options.streamError || !options.unauthorized) return check;
  const window = options.window;
  const inWindow = window
    ? events.filter((event) => event.receivedAt >= window.from && event.receivedAt <= window.to)
    : events;
  const has = (type: string) => inWindow.some((event) => event.type === type);
  // Only the success is missing, and the server itself said the run failed.
  const missing = OPENCODE_V2_REQUIRED_EVENT_TYPES.filter((type) => !has(type));
  const executionFailed =
    missing.length === 1 &&
    missing[0] === OPENCODE_V2_SUCCEEDED_EVENT_TYPE &&
    has(OPENCODE_V2_EXECUTION_FAILED_EVENT_TYPE);
  return executionFailed ? excuse(check) : check;
}
