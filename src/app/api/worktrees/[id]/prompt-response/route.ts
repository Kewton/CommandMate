/**
 * API Route: POST /api/worktrees/[id]/prompt-response
 * Send response to CLI tool prompt detected from terminal output
 * This is a lightweight endpoint that doesn't require a database message ID
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, recordAnsweredPrompt } from '@/lib/db';
import { broadcastMessage } from '@/lib/ws-server';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { isCliToolType, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutputFresh } from '@/lib/session/cli-session';
import type { PromptDetectionResult } from '@/lib/detection/prompt-detector';
import { assessPromptAnswerability } from '@/lib/polling/auto-yes-dialog-gate';
import {
  sendPromptAnswer,
  PromptAnswerRejectedError,
  FreeTextAnswerRejectedError,
  FreeTextAtChoiceOnlyPromptError,
  MultiSelectAnswerRejectedError,
} from '@/lib/prompt-answer-sender';
import { resolvePromptAnswer, PromptAnswerResolutionError, type AnswerResolution } from '@/lib/prompt-answer-semantic';
import { getAskUserQuestion } from '@/lib/session/agent-event-state';
import { answerStructuredDecision } from '@/lib/hooks/structured-decision-response';
import {
  applyAskUserQuestion,
  resolveAskUserQuestionAnswer,
} from '@/lib/session/ask-user-question-prompt';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import type { PromptType, SubmitMode } from '@/types/models';
import { isValidSubmitMode } from '@/types/models';
import { createLogger } from '@/lib/logger';
import { checkSessionOwnership, foreignSessionErrorBody } from '@/lib/cli-tools/session-ownership';
import { startPolling } from '@/lib/polling/response-poller';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/prompt-response');

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

interface PromptResponseRequest {
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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    if (!isValidWorktreeId(id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const body: PromptResponseRequest = await req.json();
    const { answer, cliTool: cliToolParam, instanceId: instanceParam, promptType: bodyPromptType, defaultOptionNumber: bodyDefaultOptionNumber, submitMode: bodySubmitMode } = body;
    const useDefault = body.useDefault === true;

    // Issue #2755: is this a checkbox answer, and is its SHAPE usable? Decided
    // here, above every other validation, because the two branches below need
    // different things of the same fields — `answers: [2]` has no `answer` at
    // all, and `answer: "1,3"` must not reach `resolvePromptAnswer`, which
    // would pass it through as free text.
    const selection = parseSelectionSet(body);
    if (selection !== null && !selection.ok) {
      return NextResponse.json({ error: selection.error }, { status: 400 });
    }
    const selectionNumbers = selection === null ? null : selection.numbers;

    // Issue #616: Allowlist validation for submitMode
    const validSubmitMode: SubmitMode | undefined =
      isValidSubmitMode(bodySubmitMode) ? bodySubmitMode : undefined;

    // Validation (Issue #1681: exactly one of answer / useDefault)
    if (!answer && !useDefault && selectionNumbers === null) {
      return NextResponse.json(
        { error: 'answer is required' },
        { status: 400 }
      );
    }
    if (answer && useDefault) {
      return NextResponse.json(
        { error: 'answer and useDefault are mutually exclusive' },
        { status: 400 }
      );
    }

    if (cliToolParam && !isCliToolType(cliToolParam)) {
      return NextResponse.json(
        { error: `Invalid cliTool: '${cliToolParam}'` },
        { status: 400 }
      );
    }

    // Issue #868: validate the optional instance selector (embedded in session name).
    if (instanceParam !== undefined && !isValidInstanceId(instanceParam)) {
      return NextResponse.json(
        { error: 'Invalid instanceId parameter' },
        { status: 400 }
      );
    }
    const instanceId = instanceParam;

    const db = getDbInstance();

    // Get worktree to verify it exists
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    // Determine CLI tool ID
    const cliToolId: CLIToolType = (cliToolParam && isCliToolType(cliToolParam))
      ? cliToolParam
      : (worktree.cliToolId || 'claude');

    // Get CLI tool instance from manager
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);

    // Issue #2865: a same-named session another CommandMate server created is
    // never answered, on either the structured or the keystroke path below.
    const ownedSessionName = cliTool.getSessionName(id, instanceId);
    const ownership = await checkSessionOwnership(ownedSessionName, worktree.path);
    if (ownership.verdict === 'foreign') {
      return NextResponse.json(foreignSessionErrorBody(ownedSessionName, ownership.sessionPath), { status: 409 });
    }

    // Check if session is running (Issue #868: per-instance)
    const running = await cliTool.isRunning(id, instanceId);
    if (!running) {
      return NextResponse.json(
        { error: `${cliTool.name} session is not running` },
        { status: 400 }
      );
    }

    // Issue #1898: answer the approval the agent is actually holding, before
    // going anywhere near the pane.
    //
    // `respond` has only ever been able to press a key, so a dialog the
    // detectors cannot read was unanswerable — which on opencode is every
    // approval: `wait` reported it (exit 10) and told the operator to run
    // `respond`, and `respond` then answered `prompt_no_longer_active`. The
    // structured layer knows the decision by id and can reply to it over the
    // agent's own API.
    //
    // Declines to `not-applicable` for every source with no decision identity
    // and for every session holding no approval, which is where the keystroke
    // path below carries on unchanged. The id is never taken from the caller —
    // see the module comment for why that closes DR4-003 by construction.
    const structuredDecision = await answerStructuredDecision({
      worktreeId: id,
      cliToolId,
      instanceId,
      answer,
      useDefault,
    });
    if (structuredDecision.kind === 'refused') {
      logger.info('prompt-response-refused', {
        worktreeId: id,
        cliToolId,
        instanceId,
        reason: structuredDecision.reason,
      });
      return NextResponse.json({
        success: false,
        reason: structuredDecision.reason,
        message: structuredDecision.message,
        answer: answer ?? '',
      });
    }
    if (structuredDecision.kind === 'answered') {
      const { option, decisionId, delivered } = structuredDecision;
      // Issue #1548: a person answered, attributed exactly as the keystroke
      // path attributes it.
      applyEventToActiveTask(db, id, cliToolId, instanceId ?? cliToolId, 'prompt_answered_human', {
        promptType: 'multiple_choice',
      });
      startPolling(id, cliToolId, instanceId);
      void broadcastTerminalSnapshotAfterInteraction(id, cliToolId, instanceId);
      return NextResponse.json({
        success: delivered,
        answer: String(option.number),
        ...(delivered ? {} : { reason: 'decision_not_delivered' }),
        resolved: {
          via: 'structured-decision',
          optionNumber: option.number,
          optionLabel: option.label,
          decisionId,
        },
      });
    }

    // Get session name for the CLI tool (Issue #868: per-instance)
    const sessionName = cliTool.getSessionName(id, instanceId);

    // Issue #161: Re-verify that a prompt is still active before sending keys.
    // This prevents a race condition where the prompt disappears between
    // detection (in current-output API) and sending (here), causing "1" to
    // be typed at the Claude user input prompt instead of a tool permission prompt.
    let promptCheck: PromptDetectionResult | null = null;
    // Issue #2033: kept outside the try so the answerMode guard below judges the
    // SAME frame this verification passed, rather than taking a second capture
    // of a screen that may have moved on.
    let verifiedFrame: string | null = null;
    // Issue #2522: whether THIS prompt came from Command Code's question reader.
    // Kept outside the try for the same reason `verifiedFrame` is — the free-text
    // guard below has to know it about the frame that was actually verified, not
    // about a screen that may have moved on.
    let isCommandCodeQuestion = false;
    // Issue #2755: whether the re-verification below could not be done at all.
    // Every other answer keeps the #1699 policy of carrying on (see the catch),
    // and a checkbox answer is the one exception — see
    // {@link MULTI_SELECT_UNVERIFIED_MESSAGES}.
    let verificationFailed = false;
    try {
      const currentOutput = await captureSessionOutputFresh(id, cliToolId, undefined, instanceId);
      verifiedFrame = currentOutput;
      // Issue #2870: the reading is `assessPromptAnswerability`, the SAME one
      // the status API publishes as `promptAnswerable`, so the UI never offers
      // Send for a frame this route would refuse (#2868). In order: the tool's
      // own reader first — agy's `↑/↓ Navigate` dialog (#2364) and Command
      // Code's footer-less question, read off the capture itself (#2522) — then
      // the generic parser, then the shared presence gate the response poller
      // saves through (#2457, handed the capture, not the cleaned text), then
      // the refusal that says WHICH of "gone" and "unverifiable" it is (#2486).
      // This is the FRESH frame the answer is about to be sent at, which is the
      // whole point of re-verifying here.
      //
      // A Command Code question that is up and could not be read comes back as
      // `unsupported_dialog_layout` before the generic parser runs (確定仕様 B):
      // its partial list is exactly what must not reach a keystroke. Its
      // `presence` is unvouched, so the log line below still says `vouched: false`.
      const assessment = assessPromptAnswerability(cliToolId, currentOutput);
      const { presence, refusal } = assessment;
      isCommandCodeQuestion = assessment.isCommandCodeQuestion;
      promptCheck = assessment.promptCheck;
      if (refusal) {
        logger.info('prompt-response-refused', {
          worktreeId: id,
          cliToolId,
          instanceId,
          reason: refusal.reason,
          vouched: presence.present,
        });
        return NextResponse.json({
          success: false,
          reason: refusal.reason,
          ...(refusal.message ? { message: refusal.message } : {}),
          answer: answer ?? '',
        });
      }
    } catch {
      // If capture fails, proceed with caution - don't block manual responses
      verificationFailed = true;
      logger.warn('failed-to-verify-prompt');
    }

    // Issue #1726: replace the screen-parsed options with the ones the agent
    // itself reported for this `AskUserQuestion`, when the payload can be lined
    // up against this exact screen. `applyAskUserQuestion` answers null for
    // everything it cannot vouch for — the confirmation screen, any other
    // prompt, any session with no hooks — and the pre-#1726 path then runs
    // unchanged.
    const askUserQuestion = getAskUserQuestion(id, cliToolId, instanceId);
    const structuredPromptData =
      promptCheck?.promptData && askUserQuestion
        ? applyAskUserQuestion(promptCheck.promptData, askUserQuestion.spec)
        : null;
    const effectivePromptData = structuredPromptData ?? promptCheck?.promptData;

    // Issue #2755 確定仕様 5: a checkbox answer is judged here, against the
    // frame that was just re-verified, and is refused with NOTHING sent unless
    // all four hold — the capture worked, a prompt is still up, it is still a
    // checkbox question, and every number is on it. The refusals are ordered
    // most-general first so the operator is told the true reason rather than
    // "out of range" for a screen that is no longer there.
    let selectionResolution: AnswerResolution | null = null;
    if (selectionNumbers !== null) {
      const refuse = (
        detail: keyof typeof MULTI_SELECT_UNVERIFIED_MESSAGES,
      ): NextResponse => {
        logger.info('prompt-response-refused', {
          worktreeId: id,
          cliToolId,
          instanceId,
          reason: MULTI_SELECT_UNVERIFIED_REASON,
          detail,
        });
        return NextResponse.json({
          success: false,
          reason: MULTI_SELECT_UNVERIFIED_REASON,
          message: MULTI_SELECT_UNVERIFIED_MESSAGES[detail],
          answer: selectionNumbers.join(','),
        });
      };

      if (verificationFailed || promptCheck === null) return refuse('capture-failed');
      if (!promptCheck.isPrompt || !effectivePromptData) return refuse('prompt-gone');
      if (
        effectivePromptData.type !== 'multiple_choice' ||
        effectivePromptData.multiSelect !== true
      ) {
        // A single-select prompt handed a list of numbers. 400 rather than the
        // refusal body above: the request itself is wrong for this screen, and
        // 確定仕様 5 asks for it by name.
        return NextResponse.json(
          {
            error:
              'That prompt takes one option, not a list. Answer with a single option number.',
          },
          { status: 400 },
        );
      }
      const valid = new Set(effectivePromptData.options.map((option) => option.number));
      const outOfRange = selectionNumbers.filter((n) => !valid.has(n));
      if (outOfRange.length > 0) {
        return NextResponse.json(
          {
            error: `Invalid choice: ${outOfRange.join(', ')}. Valid options are: ${[...valid].join(', ')}`,
          },
          { status: 400 },
        );
      }
      selectionResolution = { input: selectionNumbers.join(',') };
    }

    // With the agent's own option list in hand, an answer can be judged before
    // any key is sent: a number outside the list cannot be right, and a word
    // that matches no label cannot be resolved. This is where `respond <id> no`
    // stops being able to arrive as an approval (Issue #1681) — typed text is
    // not a selection on a cursor-navigated picker, the Enter after it takes
    // whatever is highlighted.
    let effectiveAnswer = answer;
    let structuredResolution: AnswerResolution['resolved'];
    if (selectionResolution === null && structuredPromptData && !useDefault && answer !== undefined) {
      const checked = resolveAskUserQuestionAnswer(structuredPromptData, answer);
      if (!checked.ok) {
        logger.info('prompt-response-refused', {
          worktreeId: id,
          cliToolId,
          instanceId,
          reason: checked.reason,
        });
        return NextResponse.json({
          success: false,
          reason: checked.reason,
          message: checked.message,
          answer,
        });
      }
      effectiveAnswer = checked.input;
      structuredResolution = checked.resolved;
    }

    // Issue #1681: resolve semantic yes/no answers (and --default) to a concrete
    // option number BEFORE sending. On cursor-navigated menus a raw "no" + Enter
    // degrades into selecting the highlighted default option, so unresolvable
    // answers are refused without sending anything.
    let resolution: AnswerResolution;
    try {
      // Issue #2755: a verified selection set bypasses this resolution. It is
      // neither a semantic answer nor free text — `resolvePromptAnswer` would
      // hand `"1,3"` straight back as text, which is exactly what the guards
      // downstream are built to refuse.
      resolution = selectionResolution ?? resolvePromptAnswer({
        answer: effectiveAnswer,
        useDefault,
        promptData: effectivePromptData,
        fallbackPromptType: bodyPromptType,
      });
    } catch (error: unknown) {
      if (error instanceof PromptAnswerResolutionError) {
        return NextResponse.json({
          success: false,
          reason: 'unresolvable_answer',
          message: error.message,
          answer: answer ?? '',
        });
      }
      throw error;
    }

    // Issue #2522 確定仕様 D: a bare number must never be used to "confirm" a row
    // that is a TEXT FIELD.
    //
    // Command Code draws `Type something...` as the last row of the list and the
    // measured `QuestionPrompt` renders it as a separate `TextInput`, not as a
    // choice its `SelectInput` can select. So a digit sent at it selects
    // nothing, and — with `answer_only` suppressing the Enter — quietly does
    // nothing at all while this route reports success. `respond <id> --default`
    // on a screen whose `❯` rests there is the realistic way in.
    //
    // Refused before any key is sent, with the reason code `respond` already
    // treats as "the terminal is untouched". Scoped to a prompt THIS reader
    // produced: the free-text rows other tools' pickers draw are reached by
    // cursor navigation, where Enter does open the field, and nothing here
    // changes that.
    if (isCommandCodeQuestion && effectivePromptData?.type === 'multiple_choice' && /^\d+$/.test(resolution.input)) {
      const target = effectivePromptData.options.find(
        (option) => option.number === Number(resolution.input),
      );
      if (target?.requiresTextInput === true) {
        logger.info('prompt-response-refused', {
          worktreeId: id,
          cliToolId,
          instanceId,
          reason: 'unresolvable_answer',
          optionNumber: target.number,
        });
        return NextResponse.json({
          success: false,
          reason: 'unresolvable_answer',
          message: COMMAND_CODE_FREE_TEXT_OPTION_MESSAGE,
          answer: answer ?? '',
        });
      }
    }

    // Send answer to tmux
    // Issue #287 Bug2: Uses shared sendPromptAnswer() to unify logic
    // with auto-yes-manager.ts, including fallback handling.
    try {
      await sendPromptAnswer({
        sessionName,
        answer: resolution.input,
        cliToolId,
        promptData: effectivePromptData,
        fallbackPromptType: bodyPromptType,
        fallbackDefaultOptionNumber: bodyDefaultOptionNumber,
        fallbackSubmitMode: validSubmitMode,
        // Issue #2033: the frame the prompt was re-verified against, raw. Undefined
        // only when that capture failed, where the sender reads the pane itself.
        frame: verifiedFrame ?? undefined,
      });
    } catch (error: unknown) {
      // Issue #2033: a refusal is not a transport failure. Nothing was typed and
      // the dialog is untouched, so it is reported the same way this route's
      // other pre-send refusals are — `success: false` with a reason code — and
      // not as a 500 that would leave the operator unsure whether a key landed.
      if (error instanceof PromptAnswerRejectedError) {
        logger.info('prompt-response-refused', {
          worktreeId: id,
          cliToolId,
          instanceId,
          reason: error.reason,
          dialogKind: error.dialogKind,
          answerMode: error.answerMode,
        });
        return NextResponse.json({
          success: false,
          reason: error.reason,
          message: error.message,
          answer: answer ?? '',
        });
      }
      // Issue #2573: the same guarantee for text aimed at a menu row — the
      // "No, tell … what to do differently" row PromptPanel used to send the
      // reason at. Issue #2583 extends it to the dialog with no such row at all
      // (claude's and agy's Bash approvals), where a refusal typed as free text
      // used to answer `success: true` and run the command. Both are refused
      // before a key, so the dialog is still up and the operator can answer it
      // with the option number. They share a reason code on purpose; what
      // differs is only the evidence each can log.
      // Issue #2755: the checkbox arm gave up. Unlike the three above it does
      // not always promise an untouched pane — ticking boxes is the first half
      // of this answer — so `keysSent` is logged and the message says which of
      // the two the operator is looking at. What it does promise is that the
      // question was never submitted, which is why this is a refusal and not a
      // 500.
      if (error instanceof MultiSelectAnswerRejectedError) {
        logger.info('prompt-response-refused', {
          worktreeId: id,
          cliToolId,
          instanceId,
          reason: error.reason,
          stage: error.stage,
          keysSent: error.keysSent,
        });
        return NextResponse.json({
          success: false,
          reason: error.reason,
          message: error.message,
          answer: resolution.input,
        });
      }
      if (error instanceof FreeTextAnswerRejectedError || error instanceof FreeTextAtChoiceOnlyPromptError) {
        logger.info('prompt-response-refused', {
          worktreeId: id,
          cliToolId,
          instanceId,
          reason: error.reason,
          ...(error instanceof FreeTextAnswerRejectedError
            ? { optionNumbers: error.optionNumbers }
            : { optionCount: error.optionCount }),
        });
        return NextResponse.json({
          success: false,
          reason: error.reason,
          message: error.message,
          answer: answer ?? '',
        });
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return NextResponse.json(
        { error: `Failed to send answer to tmux: ${errorMessage}` },
        { status: 500 }
      );
    }

    // Issue #1548: a person answered. Attributed to the instance that was asked
    // — `instanceId` is undefined for the primary, which `getActiveTaskForInstance`
    // expects to be named by the tool id.
    //
    // Caveat: the browser-side Auto-Yes fallback (`useAutoYes`) posts here too,
    // and is recorded as human. It only runs when the server poller is absent,
    // which is also when nothing else would record the answer at all — an
    // over-count is preferable to a gap in the log.
    applyEventToActiveTask(db, id, cliToolId, instanceId ?? cliToolId, 'prompt_answered_human', {
      promptType: effectivePromptData?.type,
    });

    // Issue #1685: persist question/options/answer for the audit trail. Skipped
    // when the pre-send capture failed (promptCheck null) — there is nothing
    // trustworthy to record. Shares the useAutoYes attribution caveat above.
    if (promptCheck?.isPrompt && effectivePromptData) {
      try {
        // Issue #1681 resolved semantic answers to a concrete input before
        // sending — record what actually reached the terminal. Issue #1726: with
        // the agent's own labels, so the audit trail says which choice was made
        // rather than which line the pane happened to be showing.
        const record = recordAnsweredPrompt(db, {
          worktreeId: id,
          cliToolId,
          instanceId: instanceId ?? cliToolId,
          promptData: effectivePromptData,
          answer: resolution.input,
          answeredBy: 'human',
          content: promptCheck.rawContent || promptCheck.cleanContent,
        });
        broadcastMessage(record.created ? 'message' : 'message_updated', {
          worktreeId: id,
          message: record.message,
        });
      } catch (recordError) {
        // Audit persistence must never fail a response that already reached tmux.
        logger.warn('prompt-audit-record-failed', {
          error: recordError instanceof Error ? recordError.message : String(recordError),
        });
      }
    }

    // The prompt poller normally stops while waiting for input. Resume response
    // persistence and independently push the TUI redraw after this interaction.
    startPolling(id, cliToolId, instanceId);
    void broadcastTerminalSnapshotAfterInteraction(id, cliToolId, instanceId);

    return NextResponse.json({
      success: true,
      answer: resolution.input,
      // Issue #1681: audit trail — which option a semantic/default answer
      // selected. Issue #1726 adds the label match against the agent's own
      // options, which resolves before `resolvePromptAnswer` ever sees the
      // answer and therefore has to be merged in here.
      ...(structuredResolution ?? resolution.resolved
        ? { resolved: structuredResolution ?? resolution.resolved }
        : {}),
    });
  } catch (error: unknown) {
    logger.error('failed-to-respond-to-prompt:', { error: error instanceof Error ? error.message : String(error) });
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
