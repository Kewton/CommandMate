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
 *
 * Issue #3994: on 2026-10-29 command-code 1.84.0 refused every turn the same
 * way (`⚠ Error: Authentication failed. …` / `401 … Invalid 'Authorization'`).
 * The refusal rows are now per tool (the probe spec's `modelAuthFailureRows`),
 * the approval dialog that never appeared goes through {@link judgeTurnCheck},
 * and a hooks tool's `hook-correlation` through {@link judgeHookCorrelation}
 * (only `stop` missing after `session_start` arrived).
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
import {
  correlateHookDeliveries,
  evaluateHookCorrelation,
  type HookCorrelationExpectation,
  type HookDelivery,
} from './hook-correlation';
import { paneEvidence } from './report';
import { evaluateScreen, type ScreenCheckId, type ScreenVerdict } from './screen-checks';
import type { AgentHealthCheck } from './types';

/**
 * The rows a tool prints when its model provider refused the credentials.
 * Each pattern is one whole row (anchored, matched per line), so a refusal
 * quoted inside the request box (`┃ …`, `❯ …`) is not counted. Kept in the
 * tool's probe spec (`modelAuthFailureRows` in scripts/agent-health/tool-table.ts).
 */
export type ModelAuthFailureRows = readonly RegExp[];

/** opencode v2.0.18 (and v1): `Error: Unauthorized` alone on its row (#3420). */
export const OPENCODE_MODEL_AUTH_FAILURE_ROWS: ModelAuthFailureRows = [/^[ \t]*Error: Unauthorized[ \t]*$/];

/**
 * command-code 1.84.0, 2026-10-29 (Issue #3994, #3988〜#3990):
 * `⚠ Error: Authentication failed. Your API key may be invalid or expired. …`
 * and the taste call behind it,
 * `⚠ taste learning failed: POST /alpha/generate → 401 error: Invalid 'Authorization' header or token.`
 * Both start with the tool's own `⚠` mark; the request echo starts with `❯`.
 */
export const COMMAND_CODE_MODEL_AUTH_FAILURE_ROWS: ModelAuthFailureRows = [
  /^[ \t]*⚠[ \t]*Error: Authentication failed\.(?:[ \t].*)?$/,
  /^[ \t]*⚠[ \t]*.*\b401\b.*\bInvalid 'Authorization'.*$/,
];

/** The refusal rows the frame shows (ANSI stripped here), trimmed, top to bottom. */
export function findModelAuthFailures(
  frame: string,
  rows: ModelAuthFailureRows = OPENCODE_MODEL_AUTH_FAILURE_ROWS
): string[] {
  return stripAnsi(frame)
    .split('\n')
    .filter((line) => rows.some((row) => row.test(line)))
    .map((line) => line.trim());
}

/** How many refusal rows the frame shows (ANSI stripped here). */
export function countModelAuthFailures(
  frame: string,
  rows: ModelAuthFailureRows = OPENCODE_MODEL_AUTH_FAILURE_ROWS
): number {
  return findModelAuthFailures(frame, rows).length;
}

/**
 * The refusal row `after` shows that `before` (the frame before the request)
 * did not — the turn's own, the lowest one — or null.
 */
export function newModelAuthFailure(
  before: string,
  after: string,
  rows: ModelAuthFailureRows = OPENCODE_MODEL_AUTH_FAILURE_ROWS
): string | null {
  const seen = findModelAuthFailures(after, rows);
  return seen.length > countModelAuthFailures(before, rows) ? (seen[seen.length - 1] ?? null) : null;
}

/** True when `after` shows a refusal row that `before` (the frame before the request) did not. */
export function turnEndedUnauthorized(
  before: string,
  after: string,
  rows: ModelAuthFailureRows = OPENCODE_MODEL_AUTH_FAILURE_ROWS
): boolean {
  return newModelAuthFailure(before, after, rows) !== null;
}

function excuse(check: AgentHealthCheck, row = 'Error: Unauthorized'): AgentHealthCheck {
  return {
    ...skipCheck(
      check.checkId,
      'signed-out',
      `検査不能: モデルの呼び出しが認可エラー（${row}）で終わった`,
      `モデル（provider）の資格情報で認可されず、ターンが応答なしで終わったため判定できない。判定していれば: ${check.summary}`
    ),
    ...(check.evidence !== undefined ? { evidence: check.evidence } : {}),
  };
}

/**
 * Any check judged on a turn's frame: a `fail` on a turn whose refusal row is
 * new since `before` becomes a `signed-out` skip (Issue #3994: also the
 * approval dialog that never appeared); anything else is returned unchanged.
 */
export function judgeTurnCheck(
  check: AgentHealthCheck,
  frame: string,
  before: string,
  rows: ModelAuthFailureRows = OPENCODE_MODEL_AUTH_FAILURE_ROWS
): AgentHealthCheck {
  if (check.status !== 'fail') return check;
  const row = newModelAuthFailure(before, frame, rows);
  return row === null ? check : excuse(check, row);
}

/**
 * A `screen-*` check judged on a turn's frame.
 *
 * @param before - the frame looked at just before the request was sent
 * @param options.rows - the tool's refusal rows (default: opencode's)
 */
export function judgeTurnScreen(
  checkId: ScreenCheckId,
  verdict: ScreenVerdict,
  frame: string,
  before: string,
  options: { note?: string; rows?: ModelAuthFailureRows } = {}
): AgentHealthCheck {
  return judgeTurnCheck(
    { checkId, ...evaluateScreen(checkId, verdict, frame, options.note) },
    frame,
    before,
    options.rows
  );
}

/**
 * A hooks tool's `hook-correlation` for a run whose turns may have been
 * refused by the provider (Issue #3994). Only a fail whose sole missing event
 * is `stop` — `session_start` arrived, every key matched — becomes a
 * `signed-out` skip: a refused turn never ends, so it never stops. Without
 * `session_start` the hook itself may be broken, and that still fails.
 *
 * @param options.unauthorizedFrame - the frame of a turn that ended in the
 *   tool's refusal row (new in that turn), or null when none did
 */
export function judgeHookCorrelation(
  deliveries: readonly HookDelivery[],
  expectation: HookCorrelationExpectation,
  options: { unauthorizedFrame: string | null; rows?: ModelAuthFailureRows }
): AgentHealthCheck {
  const check: AgentHealthCheck = {
    checkId: 'hook-correlation',
    ...evaluateHookCorrelation(deliveries, expectation),
  };
  if (check.status !== 'fail' || options.unauthorizedFrame === null) return check;
  const { mismatched, missing, received } = correlateHookDeliveries(deliveries, expectation);
  const onlyStopMissing =
    mismatched.length === 0 &&
    missing.length === 1 &&
    missing[0] === 'stop' &&
    expectation.expectedEvents.includes('session_start') &&
    received.includes('session_start');
  if (!onlyStopMissing) return check;
  const rows = findModelAuthFailures(options.unauthorizedFrame, options.rows);
  return {
    ...excuse(check, rows[rows.length - 1]),
    // The pane, not the hook JSON: the refusal is what explains the missing stop.
    evidence: paneEvidence(options.unauthorizedFrame),
  };
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
