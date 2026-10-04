/**
 * The prompt-response route's resolution of the answer to the input it sends
 * (Issue #3171, split out of the route; the behaviour is Issues #1681, #1726,
 * #2522 and #2755).
 *
 * Every refusal here is decided before any key is sent.
 *
 * @module app/api/worktrees/[id]/prompt-response/answer-resolution
 */

import { NextResponse } from 'next/server';
import type { PromptData } from '@/types/models';
import { resolvePromptAnswer, PromptAnswerResolutionError, type AnswerResolution } from '@/lib/prompt-answer-semantic';
import { getAskUserQuestion } from '@/lib/session/agent-event-state';
import {
  applyAskUserQuestion,
  resolveAskUserQuestionAnswer,
} from '@/lib/session/ask-user-question-prompt';
import { logRefused, type PromptResponseContext, type StageResult } from './context';
import type { ValidatedPromptResponse } from './request-validation';
import type { VerifiedPrompt } from './frame-verification';

/**
 * The refusal text for an answer aimed at a free-text row (Issue #2522 確定仕様 D).
 *
 * `Type something...` is the last row of Command Code's question list and it is
 * a `TextInput`, not a choice: a digit sent at it selects nothing. See the guard
 * below for when this is raised.
 */
const COMMAND_CODE_FREE_TEXT_OPTION_MESSAGE =
  'That option is a free-text field on this screen, not a choice a number selects, so no key was ' +
  'sent. Send the text you want to answer with, or type it in the terminal.';

/**
 * The reason code for a checkbox answer this route would not let through
 * (Issue #2755).
 *
 * Distinct from the sender's {@link MULTI_SELECT_NOT_COMMITTED_REASON}, which
 * means "keys may have been sent and the question was not submitted". This one
 * is the stronger promise the Issue asks for: **nothing at all was sent**,
 * because the screen the answer was aimed at could not be re-verified.
 */
const MULTI_SELECT_UNVERIFIED_REASON = 'multi_select_unverified';

/**
 * Why a checkbox answer was refused before any key (Issue #2755 確定仕様 5).
 *
 * Every other answer on this route keeps the #1699 policy — a capture that
 * fails is logged and the manual answer goes through anyway, because blocking
 * it takes away the operator's only way out. A checkbox answer cannot have that
 * policy: it is a SET, and the keys that deliver it are toggles computed
 * against the boxes that are ticked right now. Sent at a screen nobody could
 * re-read, the same request turns boxes OFF as readily as on. So this is the
 * one answer shape where "could not verify" means "send nothing".
 */
const MULTI_SELECT_UNVERIFIED_MESSAGES: Record<string, string> = {
  'capture-failed':
    'The screen could not be re-read, so no key was sent. A checkbox answer is delivered as toggles '
    + 'against the boxes that are ticked right now, and sending it blind could untick what you meant to keep. '
    + 'Retry once the pane responds, or answer it in the terminal.',
  // Defence in depth: `judgePromptResponse` above already refuses a frame with
  // no prompt on it (`prompt_no_longer_active`, sending nothing), so this is
  // the narrower case it cannot see — a prompt that was read but carries no
  // payload to range-check the numbers against.
  'prompt-gone':
    'The question is no longer on screen, so no key was sent.',
};

/** The answer as it will be sent, and what it was resolved against. */
export interface ResolvedAnswer {
  resolution: AnswerResolution;
  /** Issue #1726: the label match against the agent's own options, when there was one. */
  structuredResolution: AnswerResolution['resolved'];
  effectivePromptData: PromptData | undefined;
}

function refuseUnverifiedSelection(
  ctx: PromptResponseContext,
  selectionNumbers: number[],
  detail: keyof typeof MULTI_SELECT_UNVERIFIED_MESSAGES,
): NextResponse {
  logRefused(ctx, { reason: MULTI_SELECT_UNVERIFIED_REASON, detail });
  return NextResponse.json({
    success: false,
    reason: MULTI_SELECT_UNVERIFIED_REASON,
    message: MULTI_SELECT_UNVERIFIED_MESSAGES[detail],
    answer: selectionNumbers.join(','),
  });
}

/**
 * Issue #2755 確定仕様 5: a checkbox answer is judged here, against the frame
 * that was just re-verified, and is refused with NOTHING sent unless all four
 * hold — the capture worked, a prompt is still up, it is still a checkbox
 * question, and every number is on it. The refusals are ordered most-general
 * first so the operator is told the true reason rather than "out of range" for
 * a screen that is no longer there. The value is null when this is not a
 * checkbox answer.
 */
function verifySelectionSet(
  ctx: PromptResponseContext,
  selectionNumbers: number[] | null,
  verified: VerifiedPrompt,
  effectivePromptData: PromptData | undefined,
): StageResult<AnswerResolution | null> {
  if (selectionNumbers === null) return { value: null };
  const { promptCheck } = verified;
  if (verified.verificationFailed || promptCheck === null) {
    return { response: refuseUnverifiedSelection(ctx, selectionNumbers, 'capture-failed') };
  }
  if (!promptCheck.isPrompt || !effectivePromptData) {
    return { response: refuseUnverifiedSelection(ctx, selectionNumbers, 'prompt-gone') };
  }
  if (
    effectivePromptData.type !== 'multiple_choice' ||
    effectivePromptData.multiSelect !== true
  ) {
    // A single-select prompt handed a list of numbers. 400 rather than the
    // refusal body above: the request itself is wrong for this screen, and
    // 確定仕様 5 asks for it by name.
    return {
      response: NextResponse.json(
        {
          error:
            'That prompt takes one option, not a list. Answer with a single option number.',
        },
        { status: 400 },
      ),
    };
  }
  const valid = new Set(effectivePromptData.options.map((option) => option.number));
  const outOfRange = selectionNumbers.filter((n) => !valid.has(n));
  if (outOfRange.length > 0) {
    return {
      response: NextResponse.json(
        {
          error: `Invalid choice: ${outOfRange.join(', ')}. Valid options are: ${[...valid].join(', ')}`,
        },
        { status: 400 },
      ),
    };
  }
  return { value: { input: selectionNumbers.join(',') } };
}

/**
 * With the agent's own option list in hand, an answer can be judged before
 * any key is sent: a number outside the list cannot be right, and a word
 * that matches no label cannot be resolved. This is where `respond <id> no`
 * stops being able to arrive as an approval (Issue #1681) — typed text is
 * not a selection on a cursor-navigated picker, the Enter after it takes
 * whatever is highlighted.
 */
function resolveAgainstAgentOptions(
  ctx: PromptResponseContext,
  request: ValidatedPromptResponse,
  structuredPromptData: ReturnType<typeof applyAskUserQuestion>,
): StageResult<{ effectiveAnswer: string | undefined; structuredResolution: AnswerResolution['resolved'] }> {
  const { answer, useDefault } = request;
  if (!structuredPromptData || useDefault || answer === undefined) {
    return { value: { effectiveAnswer: answer, structuredResolution: undefined } };
  }
  const checked = resolveAskUserQuestionAnswer(structuredPromptData, answer);
  if (!checked.ok) {
    logRefused(ctx, { reason: checked.reason });
    return {
      response: NextResponse.json({
        success: false,
        reason: checked.reason,
        message: checked.message,
        answer,
      }),
    };
  }
  return { value: { effectiveAnswer: checked.input, structuredResolution: checked.resolved } };
}

/**
 * Issue #1681: resolve semantic yes/no answers (and --default) to a concrete
 * option number BEFORE sending. On cursor-navigated menus a raw "no" + Enter
 * degrades into selecting the highlighted default option, so unresolvable
 * answers are refused without sending anything.
 *
 * @throws anything `resolvePromptAnswer` throws other than its resolution error
 */
function resolveSemanticAnswer(
  request: ValidatedPromptResponse,
  effectiveAnswer: string | undefined,
  effectivePromptData: PromptData | undefined,
): StageResult<AnswerResolution> {
  try {
    return {
      value: resolvePromptAnswer({
        answer: effectiveAnswer,
        useDefault: request.useDefault,
        promptData: effectivePromptData,
        fallbackPromptType: request.bodyPromptType,
      }),
    };
  } catch (error: unknown) {
    if (error instanceof PromptAnswerResolutionError) {
      return {
        response: NextResponse.json({
          success: false,
          reason: 'unresolvable_answer',
          message: error.message,
          answer: request.answer ?? '',
        }),
      };
    }
    throw error;
  }
}

/**
 * Issue #2522 確定仕様 D: a bare number must never be used to "confirm" a row
 * that is a TEXT FIELD.
 *
 * Command Code draws `Type something...` as the last row of the list and the
 * measured `QuestionPrompt` renders it as a separate `TextInput`, not as a
 * choice its `SelectInput` can select. So a digit sent at it selects
 * nothing, and — with `answer_only` suppressing the Enter — quietly does
 * nothing at all while this route reports success. `respond <id> --default`
 * on a screen whose `❯` rests there is the realistic way in.
 *
 * Refused before any key is sent, with the reason code `respond` already
 * treats as "the terminal is untouched". Scoped to a prompt THIS reader
 * produced: the free-text rows other tools' pickers draw are reached by
 * cursor navigation, where Enter does open the field, and nothing here
 * changes that.
 */
function refuseFreeTextRow(
  ctx: PromptResponseContext,
  answer: string | undefined,
  isCommandCodeQuestion: boolean,
  effectivePromptData: PromptData | undefined,
  input: string,
): NextResponse | null {
  if (!isCommandCodeQuestion || effectivePromptData?.type !== 'multiple_choice' || !/^\d+$/.test(input)) {
    return null;
  }
  const target = effectivePromptData.options.find(
    (option) => option.number === Number(input),
  );
  if (target?.requiresTextInput !== true) return null;
  logRefused(ctx, { reason: 'unresolvable_answer', optionNumber: target.number });
  return NextResponse.json({
    success: false,
    reason: 'unresolvable_answer',
    message: COMMAND_CODE_FREE_TEXT_OPTION_MESSAGE,
    answer: answer ?? '',
  });
}

/**
 * Resolve the request's answer against the verified prompt to the input that
 * is sent, or refuse it with nothing sent.
 */
export function resolveAnswerToSend(
  ctx: PromptResponseContext,
  request: ValidatedPromptResponse,
  verified: VerifiedPrompt,
): StageResult<ResolvedAnswer> {
  const { promptCheck } = verified;
  // Issue #1726: replace the screen-parsed options with the ones the agent
  // itself reported for this `AskUserQuestion`, when the payload can be lined
  // up against this exact screen. `applyAskUserQuestion` answers null for
  // everything it cannot vouch for — the confirmation screen, any other
  // prompt, any session with no hooks — and the pre-#1726 path then runs
  // unchanged.
  const askUserQuestion = getAskUserQuestion(ctx.id, ctx.cliToolId, ctx.instanceId);
  const structuredPromptData =
    promptCheck?.promptData && askUserQuestion
      ? applyAskUserQuestion(promptCheck.promptData, askUserQuestion.spec)
      : null;
  const effectivePromptData = structuredPromptData ?? promptCheck?.promptData;

  const selection = verifySelectionSet(ctx, request.selectionNumbers, verified, effectivePromptData);
  if ('response' in selection) return selection;
  const selectionResolution = selection.value;

  const agentOptions = selectionResolution === null
    ? resolveAgainstAgentOptions(ctx, request, structuredPromptData)
    : { value: { effectiveAnswer: request.answer, structuredResolution: undefined } };
  if ('response' in agentOptions) return agentOptions;
  const { effectiveAnswer, structuredResolution } = agentOptions.value;

  // Issue #2755: a verified selection set bypasses the semantic resolution. It
  // is neither a semantic answer nor free text — `resolvePromptAnswer` would
  // hand `"1,3"` straight back as text, which is exactly what the guards
  // downstream are built to refuse.
  const resolved = selectionResolution !== null
    ? { value: selectionResolution }
    : resolveSemanticAnswer(request, effectiveAnswer, effectivePromptData);
  if ('response' in resolved) return resolved;
  const resolution = resolved.value;

  const freeTextRefusal = refuseFreeTextRow(
    ctx, request.answer, verified.isCommandCodeQuestion, effectivePromptData, resolution.input,
  );
  if (freeTextRefusal) return { response: freeTextRefusal };

  return { value: { resolution, structuredResolution, effectivePromptData } };
}
