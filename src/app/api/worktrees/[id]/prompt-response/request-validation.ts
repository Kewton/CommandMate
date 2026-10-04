/**
 * The prompt-response request body and its validation (Issue #3171).
 *
 * Everything here is decided from the body alone, before the database or the
 * session is touched, and in the order the route has always checked it: the
 * first failing check is the 400 the caller sees.
 *
 * @module app/api/worktrees/[id]/prompt-response/request-validation
 */

import { NextResponse } from 'next/server';
import { isCliToolType, isValidInstanceId } from '@/lib/cli-tools/types';
import type { PromptType, SubmitMode } from '@/types/models';
import { isValidSubmitMode } from '@/types/models';
import { isPlanReviewAction, type PlanReviewAction } from '@/lib/cli-tools/command-code-plan-review';
import type { StageResult } from './context';

export interface PromptResponseRequest {
  answer?: string;
  /**
   * Issue #2755: the option numbers to tick on a CHECKBOX question.
   *
   * The explicit spelling of a multi-select answer, and the reason a one-item
   * one (`[2]`) can never be confused with a single-select `answer: "2"`: the
   * field itself says which of the two the caller means. `answer: "1,3"` is
   * accepted as well — `commandmate respond <id> "1,3"` has one positional
   * argument and no way to send an array — and a comma is unambiguous on its
   * own. Both are normalised to the same ascending, de-duplicated set before
   * anything is verified or sent.
   */
  answers?: number[];
  /** Issue #1681: explicitly select the prompt's default option (`respond --default`). */
  useDefault?: boolean;
  cliTool?: string;
  /** Issue #868: target a specific agent instance (defaults to the primary). */
  instanceId?: string;
  /** Issue #287: Prompt type from client-side detection (fallback when promptCheck fails) */
  promptType?: PromptType;
  /** Issue #287: Default option number from client-side detection (fallback when promptCheck fails) */
  defaultOptionNumber?: number;
  /** Issue #616: Submit mode from client-side detection (fallback when promptCheck fails) */
  submitMode?: string;
  /**
   * Issue #3125: what to do on Command Code's plan review overlay —
   * `comment` (the answer text), `submit` (Submit review, ctrl+r, after the
   * answer text as a comment when one is given), `approve` (ctrl+a) or `cancel`
   * (esc). Omitted, an answer at that overlay is a comment.
   */
  planReviewAction?: string;
}

/** A request that passed every body-only check. */
export interface ValidatedPromptResponse {
  answer: string | undefined;
  useDefault: boolean;
  /** The caller's `cliTool`, already known to be a CLI tool type when present. */
  cliToolParam: string | undefined;
  instanceId: string | undefined;
  bodyPromptType: PromptType | undefined;
  bodyDefaultOptionNumber: number | undefined;
  /** Issue #616: the allowlisted submit mode, undefined for anything else. */
  validSubmitMode: SubmitMode | undefined;
  planReviewAction: PlanReviewAction | undefined;
  /** Issue #2755: the checkbox answer's numbers, null for every other answer. */
  selectionNumbers: number[] | null;
  /** Issue #3125: a comma refusal held until the screen is known not to be a plan review. */
  deferredSelectionError: string | null;
}

/**
 * The requested selection SET, when this request is a checkbox answer
 * (Issue #2755 確定仕様 5).
 *
 * Shape only — whether the screen is really a checkbox question, and whether
 * the numbers exist on it, are decided later against the FRESH frame. Returns
 * `null` for every request that is not a multi-select answer, which is the
 * pre-#2755 path byte for byte.
 */
function parseSelectionSet(
  body: PromptResponseRequest,
): { ok: true; numbers: number[] } | { ok: false; error: string } | null {
  const { answers, answer } = body;
  if (answers !== undefined) {
    if (
      !Array.isArray(answers) ||
      answers.length === 0 ||
      answers.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 1)
    ) {
      return { ok: false, error: 'answers must be a non-empty array of positive integers' };
    }
    if (answer !== undefined) {
      return { ok: false, error: 'answer and answers are mutually exclusive' };
    }
    if (body.useDefault === true) {
      return { ok: false, error: 'answers and useDefault are mutually exclusive' };
    }
    return { ok: true, numbers: [...new Set(answers)].sort((a, b) => a - b) };
  }
  if (typeof answer !== 'string' || !answer.includes(',')) return null;
  if (!/^\s*\d+(?:\s*,\s*\d+)*\s*$/.test(answer)) {
    return { ok: false, error: 'A comma-separated answer must be option numbers, e.g. "1,3"' };
  }
  const numbers = answer.split(',').map((part) => Number(part.trim()));
  if (numbers.some((n) => !Number.isInteger(n) || n < 1)) {
    return { ok: false, error: 'A comma-separated answer must be option numbers, e.g. "1,3"' };
  }
  return { ok: true, numbers: [...new Set(numbers)].sort((a, b) => a - b) };
}

/**
 * Issue #2755: is this a checkbox answer, and is its SHAPE usable? Decided
 * above every other validation, because the two branches downstream need
 * different things of the same fields — `answers: [2]` has no `answer` at all,
 * and `answer: "1,3"` must not reach `resolvePromptAnswer`, which would pass it
 * through as free text.
 */
function readSelection(
  body: PromptResponseRequest,
): { error: string } | { selectionNumbers: number[] | null; deferredSelectionError: string | null } {
  const selection = parseSelectionSet(body);
  // Issue #3125: a comma in a text `answer` is refused only once the screen is
  // known not to be Command Code's plan review, where it is a comment
  // (`divide(a, b)`). The `answers` array is refused here as before.
  const deferredSelectionError =
    selection !== null && !selection.ok && body.answers === undefined ? selection.error : null;
  if (selection !== null && !selection.ok && deferredSelectionError === null) {
    return { error: selection.error };
  }
  const selectionNumbers = selection === null || !selection.ok ? null : selection.numbers;
  return { selectionNumbers, deferredSelectionError };
}

/**
 * Issue #3125: the plan review action is a closed set, and only Command Code
 * draws the overlay it names.
 */
function planReviewActionError(planReviewAction: string | undefined, cliToolParam: string | undefined): string | null {
  if (planReviewAction !== undefined && !isPlanReviewAction(planReviewAction)) {
    return 'planReviewAction must be one of: comment, submit, approve, cancel';
  }
  if (planReviewAction !== undefined && cliToolParam !== undefined && cliToolParam !== 'command-code') {
    return 'planReviewAction is only valid for command-code';
  }
  return null;
}

/** The checks after the selection and the plan review action, in the route's order. */
function answerAndTargetError(
  body: PromptResponseRequest,
  useDefault: boolean,
  selectionNumbers: number[] | null,
): string | null {
  const { answer, cliTool: cliToolParam, instanceId: instanceParam } = body;
  // Validation (Issue #1681: exactly one of answer / useDefault)
  if (!answer && !useDefault && selectionNumbers === null && body.planReviewAction === undefined) {
    return 'answer is required';
  }
  if (answer && useDefault) {
    return 'answer and useDefault are mutually exclusive';
  }
  if (cliToolParam && !isCliToolType(cliToolParam)) {
    return `Invalid cliTool: '${cliToolParam}'`;
  }
  // Issue #868: validate the optional instance selector (embedded in session name).
  if (instanceParam !== undefined && !isValidInstanceId(instanceParam)) {
    return 'Invalid instanceId parameter';
  }
  return null;
}

/**
 * Validate `body` the way the route always has: the first failing check is a
 * 400 `{ error }`, and nothing outside the body is consulted.
 */
export function validatePromptResponseRequest(
  body: PromptResponseRequest,
): StageResult<ValidatedPromptResponse> {
  const { answer, cliTool: cliToolParam, instanceId: instanceParam, promptType: bodyPromptType, defaultOptionNumber: bodyDefaultOptionNumber, submitMode: bodySubmitMode } = body;
  const useDefault = body.useDefault === true;
  const selection = readSelection(body);
  if ('error' in selection) {
    return { response: NextResponse.json({ error: selection.error }, { status: 400 }) };
  }

  // Issue #616: Allowlist validation for submitMode
  const validSubmitMode: SubmitMode | undefined =
    isValidSubmitMode(bodySubmitMode) ? bodySubmitMode : undefined;

  const error = planReviewActionError(body.planReviewAction, cliToolParam)
    ?? answerAndTargetError(body, useDefault, selection.selectionNumbers);
  if (error !== null) {
    return { response: NextResponse.json({ error }, { status: 400 }) };
  }

  return {
    value: {
      answer,
      useDefault,
      cliToolParam,
      instanceId: instanceParam,
      bodyPromptType,
      bodyDefaultOptionNumber,
      validSubmitMode,
      planReviewAction: body.planReviewAction as PlanReviewAction | undefined,
      selectionNumbers: selection.selectionNumbers,
      deferredSelectionError: selection.deferredSelectionError,
    },
  };
}
