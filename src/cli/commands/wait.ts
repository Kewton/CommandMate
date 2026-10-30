/**
 * wait Command - Block until agent completion or prompt detection
 * Issue #518: [DR1-08] Factory pattern
 *
 * Exit codes [DR1-03]:
 * - 0: SUCCESS (agent completed)
 * - 10: PROMPT_DETECTED (agent waiting for user input, including arrow-key
 *       selection lists — Issue #1628 — and interactive frames the detection
 *       layer could not classify at all — Issue #1708. Both are reported as
 *       exit 10 with a distinguishing `type` rather than a new exit code, so
 *       callers that already branch on 10 keep working. Issue #2463: a prompt
 *       the target's own Auto-Yes is answering is held for --auto-yes-grace
 *       seconds before it is reported.)
 * - 11: UPSTREAM_FAULT (--fail-on-upstream-fault only, Issue #1839: the agent
 *       came back to its composer with an upstream API failure on the frame)
 * - 124: TIMEOUT (--timeout exceeded)
 * Issue #1544 adds --verify / --require-work, which can turn a detected
 * completion into 20 (VERIFY_FAILED) or 21 (NOT_STARTED).
 * Issue #1628 also returns 21 without --verify when the session was never
 * running: a wait with nothing to wait for must not report success.
 * Infrastructure errors use ExitCode (1, 2, 99)
 */

import { Command } from 'commander';
import { ExitCode, VerifyExitCode, WaitExitCode } from '../types';
import type { WaitOptions } from '../types';
import type {
  CurrentOutputObservedResponse,
  CurrentOutputResponse,
  PromptData,
  WaitPromptOutput,
} from '../types/api-responses';
import { ApiClient, ApiError, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { WAIT_INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import { isPromptObservation, observedCurrentOutputPath } from './prompt';
import {
  readPromptView,
  UNCLASSIFIED_PROMPT_VIEW_TYPE,
  type PromptView,
} from '../../lib/session/prompt-view';
import {
  isInstanceSelector,
  INSTANCE_ALIAS_HELP_SUFFIX,
  INSTANCE_SELECTOR_ERROR,
} from './instances';
import {
  DeadlineReached,
  nextPollWithinDeadlines,
  POLL_INTERVAL_MS,
  readWithinDeadlines,
  sleep,
} from './wait-timing';
import {
  activeSuppression,
  decisionWithheldReason,
  describePaneObstruction,
  formatEnterFallbackNotice,
  formatRestartReleaseNotice,
  formatSuppressionNotice,
} from './wait-notices';
import {
  COMPLETION_BASIS,
  describeTurnClose,
  outstandingPrompt,
  PENDING_PROMPT_HOLD_MS,
  pendingSelfResumeStop,
  publishesTurnRecord,
  type PromptLedgerRead,
  readNewestPromptAt,
  reportsTurnBoundaries,
  SELF_RESUME_HOLD_MS,
  SELF_RESUME_PENDING_DETAIL,
  turnSettled,
} from './wait-turn-boundary';
import type { PollContext, PollState, PollWorktreeOptions } from './wait-poll-state';
import {
  faultFrameHasStop,
  HOOK_STOP_SETTLE_MAX_MS,
  settleAfterHookStop,
} from './wait-hook-stop-settle';
import { mergeExitCode, resolveWaitedTaskId, shouldVerify, verifyAfterWait, verifyRequested } from './wait-verify';
import { resolveWaitInstance, waitCommandTarget } from './wait-instance';
import { dialogCaptureCommand, followUpCommand } from '../utils/follow-up-command';
import {
  adoptAndPublishTurn,
  noteAutoYesPromptCleared,
  releaseMovedSelfResumeHold,
  trackPollActivity,
} from './wait-poll-bookkeeping';

// Issue #3964: the split-out modules' exports, re-exported so every import of
// `./wait` keeps working.
export { formatRestartReleaseNotice } from './wait-notices';
export {
  SELF_RESUME_CAPABILITY,
  SELF_RESUME_HOLD_MS,
  SELF_RESUME_PENDING_DETAIL,
  TURN_OPENING_EVENT_TYPES,
} from './wait-turn-boundary';
export type { PollWorktreeOptions } from './wait-poll-state';
export {
  HOOK_STOP_SETTLE_INTERVAL_MS,
  HOOK_STOP_SETTLE_MAX_MS,
  settleCurrentOutputPath,
} from './wait-hook-stop-settle';

/**
 * `type` reported for a blocked-on-a-human frame that carries no parsable prompt
 * (Issue #1628). Arrow-key menus — Codex's pager and `/model`, antigravity's
 * permission menu, OpenCode's `/models` overlay — are deliberately published as
 * selection lists rather than prompts so the UI renders NavigationButtons, which
 * left `wait` with no signal at all for them: it polled until the timeout while
 * the agent sat stopped. They are not answerable as a prompt, so the payload
 * names the state instead of inventing options.
 */
const SELECTION_LIST_PROMPT_TYPE = 'selection_list';

/**
 * `type` reported for an interactive frame the detection layer could not
 * classify at all (Issue #1708).
 *
 * Rides the existing exit 10 rather than a new code on purpose: every caller
 * that already branches on PROMPT_DETECTED (the `--auto-yes` dispatch runner
 * among them) keeps working and simply meets a kind it does not recognise,
 * whereas a new exit code reads as an infrastructure error to all of them.
 */
//
// Issue #3184: the value comes from `lib/session/prompt-view` rather than a copy
// here — that module has no imports, so the CLI build compiles it.
const UNCLASSIFIED_PROMPT_TYPE = UNCLASSIFIED_PROMPT_VIEW_TYPE;

/**
 * How the prompt reported on exit 10 is answered (Issue #3184): `screen` = the
 * option number or y/n typed at the pane (`respond`), `api` = a decision
 * delivered over the agent's own API (`respond <id> <number>`, no keys sent),
 * `terminal` = nothing to offer, a human answers at the pane. Read off the
 * shared view so `wait` and the browser cannot reach different conclusions.
 */
function waitAnswerVia(view: PromptView | null): 'screen' | 'api' | 'terminal' {
  if (view?.kind === 'screen-choices') return 'screen';
  if (view?.kind === 'api-choices') return 'api';
  return 'terminal';
}

/**
 * How long `isUnclassifiedActive` must hold before `wait` treats it as a stop
 * reason (Issue #1708).
 *
 * The flag is a single-poll observation of "interactive, but unparsed", and a
 * frame captured mid-repaint can raise it once and clear on the next poll — so
 * stopping on the instantaneous value would abort healthy runs. 60s is 12
 * consecutive POLL_INTERVAL_MS polls: far past any repaint, far short of the
 * 900s timeout this exists to pre-empt.
 *
 * Intentionally a constant with no flag. Two consequences, both intended:
 *   - `--timeout`/`--stall-timeout` below 60s always win, so a caller that asks
 *     for a short deadline still gets 124 rather than a delayed 10. The dwell
 *     pre-empts long waits; it does not extend short ones.
 *   - There is no way to tune it per call. Add one only if a real pane is found
 *     that legitimately sits unclassified for a minute — a flag here is a knob
 *     for working around a detector bug, and the bug is the thing to fix.
 */
const UNCLASSIFIED_DWELL_MS = 60_000;

/**
 * How long `--on-prompt agent` holds a prompt the target's own Auto-Yes is
 * answering before reporting it anyway, in seconds (Issue #2463).
 *
 * Measured 2026-09-09 with Command Code 1.51.3 delegating to Antigravity over
 * `ask`: the target's permission dialog for `git log && npm test` ended the ask
 * with exit 10 on the spot, the delegating agent stopped and reported to its
 * human — which is what exit 10 tells it to do — and the target's Auto-Yes then
 * answered the dialog and finished the turn with nobody waiting for it. A take
 * without Auto-Yes was right to exit 10; the only difference was a flag `wait`
 * did not read.
 *
 * The server's Auto-Yes poller re-reads the pane every 2 s and sits out 5 s
 * after each answer (`POLLING_INTERVAL_MS` / `COOLDOWN_INTERVAL_MS` in
 * `src/lib/auto-yes-state.ts`), so a prompt it can answer is gone within one or
 * two of this command's 5 s polls. 30 s is several times that, and short enough
 * that a prompt Auto-Yes has no answer for — free text, a type it does not
 * resolve — still reaches a human in half a minute.
 */
const AUTO_YES_GRACE_DEFAULT_SECONDS = 30;

/**
 * Parse `--auto-yes-grace <seconds>` (Issue #2463).
 *
 * A whole number of seconds, 0 or more. Anything else parses to NaN, which the
 * action refuses with exit 2 like every other malformed argument here. Not
 * `parseInt` like the neighbouring options: it accepts `2.5` and `30s` by
 * truncating them, and a grace other than the one asked for quietly moves when
 * exit 10 arrives.
 */
function parseGraceSeconds(raw: string): number {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/**
 * The exit-10 payload for a prompt the detection layer parsed. `suppressed` is
 * {@link activeSuppression}'s reading of the same poll.
 */
function buildPromptOutput(
  worktreeId: string,
  data: CurrentOutputResponse,
  promptData: PromptData,
  suppressed: ReturnType<typeof activeSuppression>,
): WaitPromptOutput {
  // Issue #1898: the degraded `unclassified` payload carries no `options`
  // — by construction, because nothing parsed the screen — but for a
  // source whose approvals are answered by decision id it does carry
  // `decisionOptions`, which ARE answerable (`respond <id> 1`). Reporting
  // an empty list there told the caller a dialog was open and gave it
  // nothing to do about it, which is the whole of #1898-3 seen from the
  // pipeline's side.
  //
  // Issue #3184: and a QUESTION answered by decision id (OpenCode V2,
  // #2100) carries neither — its choices are `askUserQuestion.labels`,
  // numbered by position. The panel offered them as buttons while this
  // reported `[]`. Which of these applies is the shared view's call
  // (`readPromptView`), not a third reading of the raw fields here.
  const promptView = readPromptView(data);
  const promptOptions =
    (promptData.options as unknown[])?.length
      ? (promptData.options as unknown[])
      : promptData.decisionOptions?.length
        ? promptData.decisionOptions
        : promptView?.apiTarget === 'question'
          ? promptView.choices.map((choice) => ({
              number: Number(choice.answer),
              label: choice.label,
            }))
          : [];
  const promptOutput: WaitPromptOutput = {
    worktreeId,
    cliToolId: data.cliToolId || 'claude',
    type: promptData.type || 'unknown',
    question: promptData.question || '',
    options: promptOptions,
    status: promptData.status || 'pending',
    answerVia: waitAnswerVia(promptView),
    ...(promptData.approvalTarget !== undefined && {
      approvalTarget: promptData.approvalTarget,
    }),
    // Issue #3881: whether that target is the whole request (a `deny-pattern-
    // unusable` verdict below is read against it), and what the screen was
    // read as, when the server sent them.
    ...(promptData.approvalTargetCompleteness !== undefined && {
      approvalTargetCompleteness: promptData.approvalTargetCompleteness,
    }),
    ...(promptData.reading !== undefined && { reading: promptData.reading }),
    ...(suppressed && {
      autoYesSuppression: {
        reason: suppressed.suppression.reason,
        mode: suppressed.suppression.mode,
        promptType: suppressed.suppression.promptType,
        ...(suppressed.suppression.pattern !== undefined && {
          pattern: suppressed.suppression.pattern,
        }),
        ageSeconds: suppressed.ageSeconds,
        // Issue #3863: the answer mode in effect, when the server publishes it.
        ...(suppressed.answerMode !== undefined && { answerMode: suppressed.answerMode }),
      },
    }),
  };
  return promptOutput;
}

/** The exit-10 payload for an arrow-key selection list (Issue #1628). */
function buildSelectionListOutput(worktreeId: string, data: CurrentOutputResponse): WaitPromptOutput {
  return {
    worktreeId,
    cliToolId: data.cliToolId || 'claude',
    type: SELECTION_LIST_PROMPT_TYPE,
    question: data.sessionStatusReason ?? SELECTION_LIST_PROMPT_TYPE,
    options: [],
    status: 'pending',
  };
}

/**
 * What `wait` says about a frame that stayed unclassified for the whole dwell
 * (Issue #1708): the stderr line, and the `question` of its exit-10 payload.
 */
function describeUnclassifiedFrame(
  worktreeId: string,
  data: CurrentOutputResponse,
  dwellMs: number,
  options: Pick<WaitOptions, 'instance'>,
): string {
  const dwellSeconds = Math.round(dwellMs / 1000);
  return (
    `Unclassified interactive frame on ${worktreeId} for ${dwellSeconds}s ` +
    `(status=${data.sessionStatus ?? 'unknown'}/${data.sessionStatusReason ?? 'unknown'}). ` +
    `The detection layer could not parse it; inspect the raw pane with ` +
    // Issue #3982: the instance waited on, and enough of its pane for a dialog.
    `\`${dialogCaptureCommand(worktreeId, waitCommandTarget(options))}\`.` +
    // Issue #2095: the sidebar is exactly this frame's reason, and the
    // one recovery is a keystroke in the pane. Riding the message keeps
    // the exit-code table (10, `type: unclassified`) unchanged for every
    // caller that already branches on it.
    describePaneObstruction(data)
  );
}

/** The exit-10 payload for a persistently unclassified frame (Issue #1708). */
function buildUnclassifiedOutput(
  worktreeId: string,
  data: CurrentOutputResponse,
  question: string,
): WaitPromptOutput {
  return {
    worktreeId,
    cliToolId: data.cliToolId || 'claude',
    type: UNCLASSIFIED_PROMPT_TYPE,
    question,
    options: [],
    status: 'pending',
    answerVia: 'terminal',
  };
}

/**
 * The exit-10 result with the poll's prompt observation added as `observation`
 * (Issue #3755), or the result untouched.
 *
 * Only words added to a payload that is reported anyway: no exit code, hold or
 * grace reads the observation, and a daemon older than the field (no
 * `promptObservation`) gets the payload it always got. `autoYesSuppression`
 * keeps its #1699 meaning beside it; the observation is where the poller's
 * record and the contract's re-evaluation are told apart.
 */
function withObservation(result: PollResult, data: CurrentOutputObservedResponse): PollResult {
  if (result.exitCode !== WaitExitCode.PROMPT_DETECTED || !result.output) return result;
  if (!isPromptObservation(data.promptObservation)) return result;
  return { ...result, output: { ...result.output, observation: data.promptObservation } };
}

/** The stderr line for a session this wait never saw running (Issue #1628). */
function describeNotStarted(
  worktreeId: string,
  data: CurrentOutputResponse,
  options: WaitOptions,
): string {
  return (
    `Not started: ${worktreeId} has no running ${data.cliToolId ?? 'agent'} session` +
    `${options.instance ? ` for instance ${options.instance}` : ''}` +
    // Issue #1884: name the stage that chose the agent above. `wait` has
    // no --agent to correct a mis-resolution with, so "no running claude
    // session for instance opencode" was the entire evidence an operator
    // got for a live agent reported as absent. `worktree-default` here
    // means the instance is neither in the roster nor named after a
    // tool; `client-fallback`, that the server is too old to resolve.
    `${data.resolvedBy ? ` (resolvedBy=${data.resolvedBy})` : ''}.`
  );
}

/** What {@link pollWorktree} resolves to. */
type PollResult = Awaited<ReturnType<typeof pollWorktree>>;

/**
 * What one stage of a poll tells {@link pollWorktree} to do: `exit` ends the
 * wait with `result`, `wait` sleeps one interval and polls again, and `next`
 * says the stage does not apply to this frame, so the next one is asked.
 */
type StageOutcome =
  | { kind: 'exit'; result: PollResult }
  | { kind: 'wait' }
  | { kind: 'next' };

/**
 * The {@link StageOutcome} of a stage that never holds the poll: `exit` or
 * `next`. {@link pollWorktree} asks such a stage for `exit` alone, and this type
 * is what keeps a `wait` from passing there as `next`.
 */
type ExitOrNextOutcome = Exclude<StageOutcome, { kind: 'wait' }>;

/** The outcome that ends the wait with `result`. */
function exitWith(result: PollResult): Extract<StageOutcome, { kind: 'exit' }> {
  return { kind: 'exit', result };
}

/**
 * Stage: `--timeout` and `--stall-timeout`, asked at the top of every poll,
 * before its request. Exit 124.
 */
function deadlineStage(poll: PollContext, state: PollState): ExitOrNextOutcome {
  const { worktreeId, options, startTime } = poll;

  // Check timeout
  if (options.timeout) {
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= options.timeout) {
      console.error(`Timeout: ${worktreeId} exceeded ${options.timeout}s`);
      return exitWith({ exitCode: WaitExitCode.TIMEOUT });
    }
  }

  // Check stall-timeout
  if (options.stallTimeout) {
    const stallElapsed = (Date.now() - state.lastActivityTime) / 1000;
    if (stallElapsed >= options.stallTimeout) {
      console.error(`Stall timeout: ${worktreeId} no output for ${options.stallTimeout}s`);
      return exitWith({ exitCode: WaitExitCode.TIMEOUT });
    }
  }

  return { kind: 'next' };
}

/**
 * Stage: a prompt the detection layer parsed. Exit 10, unless it is held for a
 * human (`--on-prompt human`) or for the target's Auto-Yes (Issue #2463).
 */
function promptStage(poll: PollContext, state: PollState, data: CurrentOutputResponse): StageOutcome {
  const { worktreeId, options, startTime, autoYesGraceSeconds, autoYesGraceMs } = poll;

  // Prompt detected
  if (data.isPromptWaiting && data.promptData) {
    // Issue #1699: report a policy suppression on both exits — the human one
    // keeps polling and would otherwise say nothing about why nobody
    // answered, and the agent one is read by pipelines that never see stderr.
    const suppressed = activeSuppression(data, Date.now());
    // Issue #3821: withheld by the server's decision, with no suppression to say so.
    const decisionWithheld = suppressed ? null : decisionWithheldReason(data);
    const decisionNotice = decisionWithheld === null
      ? null
      : `  auto-yes is not answering this prompt (reason=${decisionWithheld}); it is a human's to answer.`;

    // [DR1-03] Prompt detection exit code
    if (options.onPrompt === 'human') {
      // Block and continue polling - user handles prompt manually
      console.error(`Prompt detected on ${worktreeId}. Waiting for human response...`);
      if (suppressed) {
        console.error(formatSuppressionNotice(suppressed.suppression, suppressed.ageSeconds, suppressed.answerMode));
      }
      if (decisionNotice) console.error(decisionNotice);
      // Issue #3397: and whether Auto-Yes already pressed Enter on it.
      const enterNotice = formatEnterFallbackNotice(data, Date.now());
      if (enterNotice) console.error(enterNotice);
      // Issue #3730: and whether a restart is why nothing is answering it.
      const restartNotice = formatRestartReleaseNotice(worktreeId, data, poll.options.instance);
      if (restartNotice) console.error(restartNotice);
      return { kind: 'wait' };
    }

    // Issue #2463: the one case `decidePromptPush()` stays quiet about —
    // Auto-Yes is on and has not withheld this answer — is a prompt Auto-Yes
    // is about to answer, and exit 10 there hands a delegation back to a
    // human for a dialog nobody had to see. Hold it for the grace window; a
    // poll that shows no prompt ends the hold below and completion is judged
    // as usual. A withheld answer (`suppressed`) and Auto-Yes being off are
    // the gate's other two branches and still exit 10 at once.
    // Issue #3821: nor does a prompt the server says Auto-Yes left to a human.
    if (!suppressed && decisionWithheld === null && data.autoYes?.enabled === true && autoYesGraceMs > 0) {
      const now = Date.now();
      if (state.autoYesAnsweringSince === null) {
        state.autoYesAnsweringSince = now;
        // stderr only: stdout is the exit-10 payload and nothing else.
        console.error(
          "Prompt detected; the target's Auto-Yes is answering, waiting up to " +
            `${autoYesGraceSeconds}s… (${worktreeId})`,
        );
      }
      const heldMs = now - state.autoYesAnsweringSince;
      if (
        heldMs < autoYesGraceMs &&
        nextPollWithinDeadlines(options, startTime, state.lastActivityTime, now)
      ) {
        return { kind: 'wait' };
      }
      console.error(
        heldMs < autoYesGraceMs
          ? `Note: the prompt on ${worktreeId} is still open after ${Math.round(heldMs / 1000)}s ` +
              'under Auto-Yes, and the next poll would pass --timeout/--stall-timeout; reporting it now.'
          : `Note: the target's Auto-Yes did not answer the prompt on ${worktreeId} within ` +
              `${autoYesGraceSeconds}s; reporting it.`,
      );
    } else if (state.autoYesAnsweringSince !== null && !suppressed && decisionWithheld === null) {
      console.error(`Note: Auto-Yes is no longer enabled on ${worktreeId}; reporting the prompt.`);
    }

    // Default (agent mode): output prompt info and exit 10
    const promptOutput = buildPromptOutput(worktreeId, data, data.promptData, suppressed);
    if (suppressed) {
      console.error(formatSuppressionNotice(suppressed.suppression, suppressed.ageSeconds, suppressed.answerMode));
    }
    if (decisionNotice) console.error(decisionNotice);
    // Issue #3397: stderr only, like the notice above; the exit-10 payload is unchanged.
    const enterNotice = formatEnterFallbackNotice(data, Date.now());
    if (enterNotice) console.error(enterNotice);
    // Issue #3730: stderr only as well.
    const restartNotice = formatRestartReleaseNotice(worktreeId, data, poll.options.instance);
    if (restartNotice) console.error(restartNotice);

    return exitWith({ exitCode: WaitExitCode.PROMPT_DETECTED, output: promptOutput });
  }

  return { kind: 'next' };
}

/** Stage: an arrow-key selection list (Issue #1628). Exit 10, or held under `--on-prompt human`. */
function selectionListStage(poll: PollContext, data: CurrentOutputResponse): StageOutcome {
  const { worktreeId, options } = poll;

  // Issue #1628: an arrow-key menu is the agent blocked on a human just as much
  // as a numbered prompt is, but it is published with isPromptWaiting=false so
  // the UI can render NavigationButtons instead of PromptPanel. Treat it as a
  // prompt here — otherwise `wait` polls a stopped agent until --timeout.
  if (data.isSelectionListActive) {
    if (options.onPrompt === 'human') {
      console.error(
        `Selection list active on ${worktreeId} (${data.sessionStatusReason ?? 'selection_list'}). ` +
          'Waiting for human response...',
      );
      // Issue #1699: the poller parses frames status-detector publishes as
      // selection lists, so a policy can be the reason this one is stuck too.
      const suppressed = activeSuppression(data, Date.now());
      if (suppressed) {
        console.error(formatSuppressionNotice(suppressed.suppression, suppressed.ageSeconds, suppressed.answerMode));
      }
      // Issue #3730
      const restartNotice = formatRestartReleaseNotice(worktreeId, data, poll.options.instance);
      if (restartNotice) console.error(restartNotice);
      return { kind: 'wait' };
    }

    // Issue #3730: stderr only; the exit-10 payload is unchanged.
    const restartNotice = formatRestartReleaseNotice(worktreeId, data, poll.options.instance);
    if (restartNotice) console.error(restartNotice);
    return exitWith({
      exitCode: WaitExitCode.PROMPT_DETECTED,
      output: buildSelectionListOutput(worktreeId, data),
    });
  }

  return { kind: 'next' };
}

/**
 * Stage: an interactive frame nothing could parse, once it has stayed up for the
 * whole dwell (Issue #1708). Exit 10, or held under `--on-prompt human`.
 */
function unclassifiedStage(poll: PollContext, state: PollState, data: CurrentOutputResponse): StageOutcome {
  const { worktreeId, options } = poll;

  // Issue #1708: the frame is interactive but nothing could parse it. The
  // detection layer is the single entry point every downstream safeguard
  // hangs off, so a frame that slips past it disables Auto-Yes, the exit-10
  // handoff and the contract's autoYes policy all at once — and `wait` used
  // to burn its whole --timeout without ever mentioning it. Treat a
  // PERSISTENT unclassified frame as a stop reason of its own.
  //
  // The dwell deliberately spans ALL THREE states that raise this flag, and
  // the completion check below is suppressed while it is up. That is the
  // whole point, and it is worth spelling out because the obvious reading is
  // the wrong one. The server's definition (`isUnclassifiedFrame` in
  // `src/lib/session/status-evidence.ts`, restated there by Issue #2011):
  //
  //   isUnclassifiedActive =
  //     running && (default | unknown_frame | no_recent_output)
  //
  // `no_recent_output` is there because a static unrecognised overlay
  // DEGRADES into it — once the Auto-Yes poller stamps
  // lastServerResponseTimestamp, a frame that stopped changing flips from
  // `running`/`default` after STALE_OUTPUT_THRESHOLD_MS (5s). `unknown_frame`
  // is the same floor for a tool that opts out of the generic composer check
  // (copilot, opencode), and says "this tool's own rules looked and read
  // nothing". Both arrive about twelve times faster than this dwell. Letting
  // the completion check claim one turned a stalled worker into `Completed`,
  // which is worse than the timeout Issue #1708 complained about: exit 124
  // stops a pipeline, exit 0 lets it merge. Measured before this guard: two
  // unclassified polls followed by the degraded state returned SUCCESS.
  //
  // What is deliberately NOT in the set is `ready`/`input_prompt` with
  // `statusEvidence: 'none'` — the agent back at its composer on a frame no
  // tool-specific idle rule could vouch for. That frame WAS classified; what
  // is missing is positive proof, which is a different question and §4 D1's
  // to answer. Issue #1927 folded the two together and every idle Claude pane
  // stopped completing (#2011). Whether `wait` should hold for evidence as
  // well as classification is open, and any answer belongs in the same place
  // as the rollout that produces the evidence — not here.
  if (data.isUnclassifiedActive === true) {
    if (state.unclassifiedSince === null) state.unclassifiedSince = Date.now();
    const dwellMs = Date.now() - state.unclassifiedSince;
    if (dwellMs >= UNCLASSIFIED_DWELL_MS) {
      const question = describeUnclassifiedFrame(worktreeId, data, dwellMs, poll.options);

      // Issue #3730: why Auto-Yes is not there to answer it, if a restart is why.
      const restartNotice = formatRestartReleaseNotice(worktreeId, data, poll.options.instance);
      if (options.onPrompt === 'human') {
        console.error(question);
        if (restartNotice) console.error(restartNotice);
        console.error('Waiting for human response...');
        return { kind: 'wait' };
      }

      console.error(question);
      if (restartNotice) console.error(restartNotice);
      return exitWith({
        exitCode: WaitExitCode.PROMPT_DETECTED,
        output: buildUnclassifiedOutput(worktreeId, data, question),
      });
    }
  } else {
    state.unclassifiedSince = null;
  }

  return { kind: 'next' };
}

/**
 * Stage: the session is not running (Path A). Exit 21 when this wait never saw
 * it alive (Issue #1628), exit 0 when it went away after it had been seen.
 */
function notRunningStage(
  poll: PollContext,
  state: PollState,
  data: CurrentOutputResponse,
  selfResumeSuffix: () => string,
): ExitOrNextOutcome {
  const { worktreeId, options } = poll;

  // Completion check [DR1-04]:
  // Path A: the tmux session went away after we had seen it alive — the agent
  //         finished and its session was stopped.
  // Path B: agent completed task (sessionStatus === 'ready', input prompt detected)
  // Both indicate "no more work in progress" from wait command's perspective.
  // (This stage handles Path A only; Path B is checked in `readyStage`.)
  //
  // Issue #1628 narrowed Path A: a session that was NEVER seen running is
  // "nothing to wait for" (NOT_STARTED), not a completion. See `everRunning`.
  if (!data.isRunning && !state.everRunning) {
    console.error(describeNotStarted(worktreeId, data, options));
    return exitWith({ exitCode: VerifyExitCode.NOT_STARTED });
  }

  if (!data.isRunning) {
    console.error(
      `Completed: ${worktreeId} (basis=${COMPLETION_BASIS.SESSION_GONE}${selfResumeSuffix()})`,
    );
    return exitWith({ exitCode: WaitExitCode.SUCCESS });
  }

  return { kind: 'next' };
}

/**
 * The upstream fault on the frame that `--fail-on-upstream-fault` reports, or
 * null (Issue #1839). Prints nothing, so a caller can decide which frame the
 * verdict is on before {@link upstreamFaultStage} reports it (Issue #3956).
 */
function reportableUpstreamFault(
  poll: PollContext,
  data: CurrentOutputResponse,
): NonNullable<CurrentOutputResponse['upstreamFault']> | null {
  if (!poll.options.failOnUpstreamFault) return null;
  return data.upstreamFault ?? null;
}

/**
 * Stage of a `ready` frame: an upstream fault on the frame, under
 * `--fail-on-upstream-fault` (Issue #1839). Exit 11, with its diagnosis on
 * stderr.
 */
function upstreamFaultStage(poll: PollContext, data: CurrentOutputResponse): StageOutcome {
  const { worktreeId, options } = poll;

  // Issue #1839: the agent is back at its composer with an upstream
  // failure on the frame. Checked BEFORE the turn-boundary gate below,
  // because it is the answer to the question that gate can only ask: the
  // turn did not end, and this is why. Without it the same session runs
  // to --timeout and reports 124, which says nothing about the cause.
  const fault = reportableUpstreamFault(poll, data);
  if (fault) {
    console.error(
      `Upstream fault on ${worktreeId}: id=${fault.id} — the agent is back at its ` +
        'composer with an upstream API failure on screen, so this turn did not run. ' +
        `Matched: ${JSON.stringify(fault.matchedText)}`,
    );
    if (fault.id === 'context-limit') {
      // A retry into the same session hits the same wall (Issue #3011).
      console.error(
        'The session\'s conversation is over the model\'s context limit. Start a fresh ' +
          `session and send again: commandmate instances ${worktreeId} kill ` +
          `${options.instance ?? '<instance>'}`,
      );
    }
    return exitWith({
      exitCode: WaitExitCode.UPSTREAM_FAULT,
      upstreamFault: { id: fault.id, matchedText: fault.matchedText },
    });
  }

  return { kind: 'next' };
}

/**
 * The chat-ledger read of a poll, bounded by `--timeout` / `--stall-timeout`
 * (Issue #3974).
 *
 * On an ordinary poll, a ledger that does not answer in time ends the wait
 * ({@link DeadlineReached} back to {@link deadlineStage}, exit 124), not
 * "unreadable". On the frame a settle returned (`judgingSettledFrame`) it does
 * not: that frame was read inside the deadlines and is judged even after them
 * (#3956), so the ledger is reported unreadable and the frame decides alone —
 * as {@link faultFrameHasStop} treats a ledger cut by the same deadlines.
 */
async function readLedgerWithinDeadlines(
  poll: PollContext,
  state: PollState,
  data: CurrentOutputResponse,
  judgingSettledFrame: boolean,
): Promise<PromptLedgerRead> {
  const { client, worktreeId, options, startTime } = poll;
  try {
    // Quiet when aborted: what the deadline leads to is said here (settled
    // frame) or by deadlineStage (124), not "judged from the frame alone".
    return await readWithinDeadlines(options, startTime, state.lastActivityTime, signal =>
      readNewestPromptAt(client, worktreeId, options, data, signal, true),
    );
  } catch (error) {
    if (!judgingSettledFrame || !(error instanceof DeadlineReached)) throw error;
    console.error(
      `Note: the message ledger for ${worktreeId} could not be read within --timeout/--stall-timeout; ` +
        'judging the settled frame alone.',
    );
    return { readable: false };
  }
}

/**
 * How long `wait` holds an orphan turn — see {@link releaseOrphanTurn} — before
 * completing on the `Stop` that answered the newest prompt (Issue #3429).
 *
 * The same 60 s {@link PENDING_PROMPT_HOLD_MS} gives a lost `Stop` on the other
 * side of a prompt. It starts after the server has already closed the turn on
 * the screen's word (`scraper_evidence` takes consecutive positive polls), and
 * is restarted by any change to the frame, so a pane that is still drawing is
 * never released. `--timeout` and `--stall-timeout` below it still win.
 */
const ORPHAN_TURN_HOLD_MS = PENDING_PROMPT_HOLD_MS;

/**
 * Whether the unsettled turn this wait adopted is an orphan the agent will never
 * send a `Stop` for, held for {@link ORPHAN_TURN_HOLD_MS} (Issue #3429).
 *
 * Measured 2026-10-08 on claude 2.1.294: the agent's `Stop` landed at
 * 23:41:32.759Z, and a `pre_tool_use(AskUserQuestion)` hook landed 3 s after it
 * (23:41:35.219Z) with no prompt in between and no dialog on the screen. That
 * event opened a turn, `wait` adopted it, and no `Stop` ever came for it; the
 * server closed it as `scraper_evidence` ~11 s later, but #1839's gate has no
 * bound, so the wait polled the composer for 3 hours and exited 124.
 *
 * All of these, or the gate holds as before:
 *  - the server publishes the turn record and closed this very turn on a reason
 *    that is not the agent's (`scraper_evidence` / `stale`): the server itself
 *    stopped believing the turn was running;
 *  - the newest prompt in the chat ledger was answered: `lastStopEventAt` is at
 *    or after it. This is what separates the orphan from #1839's 529, whose
 *    prompt has no `Stop` after it — that one keeps holding to `--timeout`;
 *  - the frame has not changed for {@link ORPHAN_TURN_HOLD_MS}.
 */
async function releaseOrphanTurn(
  poll: PollContext,
  state: PollState,
  data: CurrentOutputResponse,
  judgingSettledFrame: boolean,
): Promise<boolean> {
  const { worktreeId } = poll;
  const events = data.structuredEvents;
  const closedByScreen = events?.closedBy === 'scraper_evidence' || events?.closedBy === 'stale';
  if (
    !events ||
    !publishesTurnRecord(data) ||
    !reportsTurnBoundaries(data) ||
    events.closedAt == null ||
    events.openedAt == null ||
    !closedByScreen ||
    events.openedAt !== state.turnStartedAt ||
    !state.promptLedgerReadable
  ) {
    state.orphanTurnHold = null;
    return false;
  }

  // Issue #3974: bounded by --timeout / --stall-timeout.
  const ledger = await readLedgerWithinDeadlines(poll, state, data, judgingSettledFrame);
  state.promptLedgerReadable = ledger.readable;
  if (!ledger.readable || ledger.submittedAt === null || outstandingPrompt(data, ledger.submittedAt)) {
    state.orphanTurnHold = null;
    return false;
  }

  const now = Date.now();
  const openedAt = events.openedAt;
  const hold =
    state.orphanTurnHold?.openedAt === openedAt ? state.orphanTurnHold : { openedAt, since: now };
  state.orphanTurnHold = hold;
  const quietMs = now - Math.max(hold.since, state.lastActivityTime);
  if (quietMs < ORPHAN_TURN_HOLD_MS) return false;

  console.error(
    `Note: ${worktreeId} answered its newest prompt with a stop ` +
      `(lastStopEventAt=${data.lastStopEventAt}), and the turn opened after it ` +
      `(turnStartedAt=${state.turnStartedAt}, ${describeTurnClose(data)}) has had no prompt, ` +
      `no stop and no new output for ${Math.round(quietMs / 1000)}s; completing on that stop.`,
  );
  return true;
}

/**
 * Stage of a `ready` frame: the agent has not reported the end of the turn this
 * wait adopted (Issue #1839). Held, except for an orphan turn (Issue #3429).
 */
async function unsettledTurnStage(
  poll: PollContext,
  state: PollState,
  data: CurrentOutputResponse,
  judgingSettledFrame: boolean,
): Promise<StageOutcome> {
  const { worktreeId } = poll;

  // Issue #1839: `ready` off the terminal frame is the agent's composer,
  // not the agent's verdict. Measured 2026-08-20 against a stub upstream
  // answering 529: Claude returns to the composer ~3 s after the send
  // having executed nothing, and never sends `Stop`. When this instance's
  // hooks ARE reporting — the only case in which `turnStartedAt` is
  // non-null — that missing `Stop` is the difference between "finished"
  // and "never ran", and it is the only signal that carries it.
  if (!turnSettled(data, state.turnStartedAt)) {
    if (await releaseOrphanTurn(poll, state, data, judgingSettledFrame)) return { kind: 'next' };
    console.error(
      `Waiting: ${worktreeId} is back at its composer, but its agent has not reported ` +
        `the end of this turn (turnStartedAt=${state.turnStartedAt}, ` +
        `lastStopEventAt=${data.lastStopEventAt ?? 'none'}, ${describeTurnClose(data)}). ` +
        'Not reporting completion; inspect with ' +
        `\`${followUpCommand('capture', worktreeId, waitCommandTarget(poll.options), undefined, '--json')}\`.`,
    );
    return { kind: 'wait' };
  }

  return { kind: 'next' };
}

/**
 * Stage of a `ready` frame: the turn ended on a `stop` that said the agent will
 * resume by itself (Issue #2614). Held, up to {@link SELF_RESUME_HOLD_MS}.
 */
function selfResumeHoldStage(
  poll: PollContext,
  state: PollState,
  data: CurrentOutputResponse,
  selfResumeStopAt: number | null,
): StageOutcome {
  const { worktreeId } = poll;

  // Issue #2614: the turn did end — the agent said so — but it also said
  // that work of its own is still running in the background (a `schedule`
  // timer, a backgrounded command), and that work wakes it with nobody
  // typing anything. Measured 2026-09-17 on antigravity 1.2.4: four such
  // stops ~58 s before each self-wake, and the first one was reported as
  // `Completed (basis=hook_stop)` and verified five minutes before the
  // work was done. So this `stop` is held until it is no longer the newest
  // word (see `selfResumeStopAt` above), or until the bound.
  //
  // The bound is measured from whichever is further along: the `stop`
  // itself (server clock — a negative age is skew, and the max discards
  // it) or this wait's first sight of it. A session that said so hours ago
  // and never woke is not held again.
  if (selfResumeStopAt !== null) {
    const now = Date.now();
    if (state.selfResumeHold === null) state.selfResumeHold = { stopAt: selfResumeStopAt, since: now };
    const heldMs = now - state.selfResumeHold.since;
    const elapsedMs = Math.max(heldMs, now - selfResumeStopAt);
    if (elapsedMs < SELF_RESUME_HOLD_MS) {
      state.selfResumeHeld = true;
      console.error(
        `Waiting: ${worktreeId} ended its turn with background work still running ` +
          `(stoppedAt=${new Date(selfResumeStopAt).toISOString()}, ` +
          `lastEventDetail=${SELF_RESUME_PENDING_DETAIL}, ${describeTurnClose(data)}); ` +
          'it resumes by itself when that work finishes. Not reporting completion ' +
          `(held ${Math.round(heldMs / 1000)}s, at most ${SELF_RESUME_HOLD_MS / 1000}s ` +
          'after the stop).',
      );
      return { kind: 'wait' };
    }
    console.error(
      `Note: ${worktreeId} said at its stop ${Math.round(elapsedMs / 1000)}s ` +
        'ago that background work was still running, and has not resumed since; ' +
        'completing on that stop.',
    );
  }

  return { kind: 'next' };
}

/**
 * Stage of a `ready` frame: the chat ledger shows a prompt the agent has not
 * reported the end of (Issue #1975). Held, up to {@link PENDING_PROMPT_HOLD_MS}.
 * `next` carries whether the newest prompt was answered, which
 * {@link completionStage} needs for its basis.
 */
async function promptLedgerStage(
  poll: PollContext,
  state: PollState,
  data: CurrentOutputResponse,
  judgingSettledFrame: boolean,
): Promise<{ kind: 'wait' } | { kind: 'next'; answeredNewestPrompt: boolean }> {
  const { worktreeId, startTime } = poll;

  // Issue #1975: the same frame, one question further back. #1839's gate
  // above can only fire once a turn has been ADOPTED, and `send` leaves a
  // window ~1s wide in which nothing has been: the newest structured event
  // is still the previous turn's `stop`, so `adoptTurnStart` takes nothing,
  // `turnSettled` reads null as "settled", and the composer the agent has
  // not touched yet is read as the composer it came back to. Measured
  // 2026-08-22 against copilot 1.0.80 on an isolated server: 3 of 5
  // send-then-wait runs came back in ~0.3s with `basis=scraper_ready` and
  // no artefact on disk.
  //
  // So ask the ledger instead of the clock: has this instance been handed
  // a prompt that the agent has not reported the end of? See
  // {@link outstandingPrompt} for why that comparison is the one that
  // separates "not started" from "finished", and
  // {@link reportsTurnBoundaries} for why a tool that posts no hooks never
  // reaches it.
  let answeredNewestPrompt = false;
  if (state.turnStartedAt === null && state.promptLedgerReadable && reportsTurnBoundaries(data)) {
    // Issue #3974: bounded by --timeout / --stall-timeout.
    const ledger = await readLedgerWithinDeadlines(poll, state, data, judgingSettledFrame);
    // One notice, then stop asking: a ledger that failed once will fail
    // every poll, and the point of degrading is to stop paying for it.
    state.promptLedgerReadable = ledger.readable;
    if (ledger.readable && ledger.submittedAt !== null) {
      if (outstandingPrompt(data, ledger.submittedAt)) {
        const heldMs = Date.now() - startTime;
        if (heldMs < PENDING_PROMPT_HOLD_MS) {
          console.error(
            `Waiting: ${worktreeId} is at its composer, but the newest prompt sent to it ` +
              `has no reported end (sentAt=${new Date(ledger.submittedAt).toISOString()}, ` +
              `lastStopEventAt=${data.lastStopEventAt ?? 'none'}, ${describeTurnClose(data)}). ` +
              'Not reporting completion: the agent has not started this turn yet.',
          );
          return { kind: 'wait' };
        }
        console.error(
          `Note: ${worktreeId} has been at its composer for ` +
            `${Math.round(heldMs / 1000)}s with the newest prompt still unreported by its ` +
            'agent. Its hooks are not answering; completing on the frame alone.',
        );
      } else {
        answeredNewestPrompt = true;
      }
    }
  }

  return { kind: 'next', answeredNewestPrompt };
}

/**
 * The basis of a completion on a `ready` frame (Issue #1839).
 *
 * `hook_stop` on both branches that have one, and they are the same statement
 * made from two records: the agent reported the end of the turn this wait is
 * about. `scraper_ready` keeps its documented meaning — "the screen said so and
 * nothing corroborated it" — which is now exactly the set of cases that reach it.
 */
function readyCompletionBasis(
  state: PollState,
  answeredNewestPrompt: boolean,
): (typeof COMPLETION_BASIS)[keyof typeof COMPLETION_BASIS] {
  return state.turnStartedAt !== null || answeredNewestPrompt
    ? COMPLETION_BASIS.HOOK_STOP
    : COMPLETION_BASIS.SCRAPER_READY;
}

/** Last stage of a `ready` frame: the completion line with its basis. Exit 0. */
function completionStage(
  poll: PollContext,
  state: PollState,
  answeredNewestPrompt: boolean,
  selfResumeSuffix: () => string,
): StageOutcome {
  const { worktreeId } = poll;
  const basis = readyCompletionBasis(state, answeredNewestPrompt);
  console.error(`Completed: ${worktreeId} (basis=${basis}${selfResumeSuffix()})`);
  return exitWith({ exitCode: WaitExitCode.SUCCESS });
}

/**
 * What {@link readyStage} answers instead of a {@link StageOutcome} when a
 * `hook_stop` frame was settled (Issue #3956): {@link pollWorktree} judges
 * `data` as its next poll, with no settle of its own and no sleep before it.
 */
interface SettledFrameOutcome {
  kind: 'settled';
  data: CurrentOutputObservedResponse;
}

/**
 * Stage: the agent is back at its composer on a frame that was understood. Asks
 * the stages of a `ready` frame in order; the first that applies decides.
 *
 * `judgingSettledFrame` is true when `data` is the frame a settle returned
 * (Issue #3956): it is judged as it stands and never settled again.
 */
async function readyStage(
  poll: PollContext,
  state: PollState,
  data: CurrentOutputObservedResponse,
  selfResumeStopAt: number | null,
  selfResumeSuffix: () => string,
  judgingSettledFrame: boolean,
): Promise<StageOutcome | SettledFrameOutcome> {
  // Issue #1708 narrowed Path B: `ready` is only a completion when the frame
  // was actually understood. A structured `hook_stop` over an unreadable
  // pane is the degraded form of an overlay nobody could parse (see the note
  // above), and reporting it as `Completed` is how a stalled worker gets
  // merged. Path A is untouched — a session that went away really is
  // finished, and carries no flag anyway.
  if (data.sessionStatus === 'ready' && data.isUnclassifiedActive !== true) {
    // Issue #3956: one bound for everything a `Stop` poll's settle waits on —
    // the ledger read that confirms the `Stop` and the re-reads — measured
    // from this poll, so the verdict comes at most HOOK_STOP_SETTLE_MAX_MS
    // after it (`--timeout` is applied on top, where each wait is bounded).
    const settleDeadline = Date.now() + HOOK_STOP_SETTLE_MAX_MS;
    if (reportableUpstreamFault(poll, data) !== null) {
      // Issue #3956: a fault on the frame of a `Stop` poll is on a pane that
      // may still be drawing, as much as a clean one is; it is judged on the
      // settled frame too. Without a `Stop` it is #1839's case, reported now.
      // Nothing is printed before that is decided: the diagnosis is for the
      // frame the verdict is on.
      if (!judgingSettledFrame && (await faultFrameHasStop(poll, state, data, settleDeadline))) {
        return { kind: 'settled', data: await settleAfterHookStop(poll, state, data, settleDeadline) };
      }
      return upstreamFaultStage(poll, data);
    }

    const turnOutcome = await unsettledTurnStage(poll, state, data, judgingSettledFrame);
    if (turnOutcome.kind !== 'next') return turnOutcome;

    const holdOutcome = selfResumeHoldStage(poll, state, data, selfResumeStopAt);
    if (holdOutcome.kind !== 'next') return holdOutcome;

    const ledgerOutcome = await promptLedgerStage(poll, state, data, judgingSettledFrame);
    if (ledgerOutcome.kind !== 'next') return ledgerOutcome;

    // Issue #3956: the `Stop` can land before the end of the reply is on the
    // pane, so a `hook_stop` completion is judged again on the settled frame —
    // as a poll of its own, so a prompt or a new turn drawn meanwhile is not
    // read as this completion. Only under the flag: a plain `wait` reads no
    // fault and waits no longer.
    if (
      !judgingSettledFrame &&
      poll.options.failOnUpstreamFault &&
      readyCompletionBasis(state, ledgerOutcome.answeredNewestPrompt) === COMPLETION_BASIS.HOOK_STOP
    ) {
      return { kind: 'settled', data: await settleAfterHookStop(poll, state, data, settleDeadline) };
    }

    return completionStage(poll, state, ledgerOutcome.answeredNewestPrompt, selfResumeSuffix);
  }

  return { kind: 'next' };
}

/**
 * Poll a single worktree until completion, prompt, or timeout.
 *
 * Exported since Issue #2376 so `ask` can do the WAITING half of its round trip
 * with this function rather than a second implementation of it. `ask` is
 * `send` + `wait` + "read the reply", and a private copy of the turn-boundary
 * rules here (#1839's `basis`, #1975's unanswered-prompt hold, #1708's
 * unclassified dwell) is a copy that would drift into reporting a completion
 * this one refuses. #2463's Auto-Yes hold is shared the same way: `ask` passes
 * no `autoYesGrace` and holds for the default.
 *
 * `options.instance` must already be a resolved instance ID — see
 * {@link resolveWaitInstance}.
 */
export async function pollWorktree(
  client: ApiClient,
  worktreeId: string,
  options: PollWorktreeOptions,
): Promise<{
  exitCode: number;
  output?: WaitPromptOutput;
  /** Set with exit 11: which upstream fault was on the frame (Issue #3011). */
  upstreamFault?: { id: string; matchedText: string };
}> {
  const startTime = Date.now();
  const state: PollState = {
    lastActivityTime: Date.now(),
    lastContent: '',
    everRunning: false,
    unclassifiedSince: null,
    turnStartedAt: null,
    promptLedgerReadable: true,
    autoYesAnsweringSince: null,
    selfResumeHold: null,
    selfResumeHeldMs: 0,
    selfResumeHeld: false,
    orphanTurnHold: null,
  };
  const autoYesGraceSeconds = options.autoYesGrace ?? AUTO_YES_GRACE_DEFAULT_SECONDS;
  const autoYesGraceMs = autoYesGraceSeconds * 1000;
  const poll: PollContext = { client, worktreeId, options, startTime, autoYesGraceSeconds, autoYesGraceMs };
  /**
   * What the completion line adds when this wait held for a self-resume, or ''
   * (Issue #2614). `basis=` keeps its word: the verdict is still the agent's own
   * `Stop`, the hold only decided which one.
   */
  const selfResumeSuffix = (): string => {
    if (!state.selfResumeHeld) return '';
    const total = state.selfResumeHeldMs + (state.selfResumeHold ? Date.now() - state.selfResumeHold.since : 0);
    return `, heldForSelfResume=${Math.round(total / 1000)}s`;
  };

  /**
   * The frame a settle returned, judged as the next poll (Issue #3956). It was
   * read inside the deadlines the settle kept to, so that poll does not ask
   * {@link deadlineStage} again: a turn that completed in time is not a 124.
   */
  let settledFrame: CurrentOutputObservedResponse | null = null;

  while (true) {
    const judgingSettledFrame = settledFrame !== null;
    if (!judgingSettledFrame) {
      const deadlineOutcome = deadlineStage(poll, state);
      if (deadlineOutcome.kind === 'exit') return deadlineOutcome.result;
    }

    try {
      // Issue #868: scope polling to a specific agent instance when provided.
      // Issue #3755: `observe=1` so an exit 10 carries the observation of the
      // very capture it was decided on (see {@link withObservation}).
      const data =
        settledFrame ??
        // Issue #3974: bounded by --timeout / --stall-timeout, so a server that
        // does not answer cannot hold the wait past them.
        (await readWithinDeadlines(options, startTime, state.lastActivityTime, signal => {
          const path = observedCurrentOutputPath(worktreeId, options.instance);
          return signal
            ? client.get<CurrentOutputObservedResponse>(path, { signal })
            : client.get<CurrentOutputObservedResponse>(path);
        }));
      settledFrame = null;

      trackPollActivity(state, data);

      // Issue #3179: the agent is still launching. Work in progress, so keep
      // polling: no prompt or selection list is read off the launch's frame,
      // the unclassified dwell does not run, and a pane that does not exist yet
      // is not "never started". `everRunning` is deliberately left alone — a
      // launch that then fails leaves no session, which is NOT_STARTED, not a
      // completion. The server bounds the launch, so this cannot hold forever.
      if (typeof data.startingSince === 'number') {
        state.unclassifiedSince = null;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      adoptAndPublishTurn(state, data, startTime, options);

      // Issue #2614: a self-resume hold is about one `stop`, and ends the first
      // time that `stop` is no longer the newest word — the agent woke (a
      // turn-opening event) or stopped again. Checked on every poll, ahead of
      // every exit, because the wake usually lands on a `running` frame that
      // never reaches the hold itself.
      const selfResumeStopAt = pendingSelfResumeStop(data);
      releaseMovedSelfResumeHold(worktreeId, state, selfResumeStopAt);

      const promptOutcome = promptStage(poll, state, data);
      if (promptOutcome.kind === 'exit') return withObservation(promptOutcome.result, data);
      if (promptOutcome.kind === 'wait') {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Issue #2463: the prompt the hold was waiting on has gone. Who answered it
      // is not on the wire — Auto-Yes, or a human at the pane — so the line says
      // only that it cleared; what the agent does next is for the checks below.
      noteAutoYesPromptCleared(worktreeId, state);

      const selectionListOutcome = selectionListStage(poll, data);
      if (selectionListOutcome.kind === 'exit') return withObservation(selectionListOutcome.result, data);
      if (selectionListOutcome.kind === 'wait') {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const unclassifiedOutcome = unclassifiedStage(poll, state, data);
      if (unclassifiedOutcome.kind === 'exit') return withObservation(unclassifiedOutcome.result, data);
      if (unclassifiedOutcome.kind === 'wait') {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const notRunningOutcome = notRunningStage(poll, state, data, selfResumeSuffix);
      if (notRunningOutcome.kind === 'exit') return notRunningOutcome.result;

      const readyOutcome = await readyStage(
        poll,
        state,
        data,
        selfResumeStopAt,
        selfResumeSuffix,
        judgingSettledFrame,
      );
      if (readyOutcome.kind === 'exit') return readyOutcome.result;
      if (readyOutcome.kind === 'settled') {
        settledFrame = readyOutcome.data;
        continue;
      }
      if (readyOutcome.kind === 'wait') {
        // Issue #3974: the settled frame skipped deadlineStage, and its ledger
        // read may have been cut by the deadline; ask it now rather than one
        // interval late. With time left, the next poll comes as before.
        if (judgingSettledFrame) {
          const deadlineOutcome = deadlineStage(poll, state);
          if (deadlineOutcome.kind === 'exit') return deadlineOutcome.result;
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Progress indicator on stderr [DR1-05]
      console.error(`Waiting: ${worktreeId} (status=${data.sessionStatus}, running=${data.isRunning}, prompt=${data.isPromptWaiting})`);
    } catch (error) {
      // Issue #3974: a read ended by --timeout / --stall-timeout. Not a failed
      // poll: straight back to deadlineStage, which exits 124.
      if (error instanceof DeadlineReached) continue;
      if (error instanceof ApiError) {
        throw error;
      }
      console.error(`Poll error for ${worktreeId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

export function createWaitCommand(): Command {
  const cmd = new Command('wait');
  cmd
    .description('Wait for agent completion (1 worktree per CLI instance recommended)')
    .argument('<worktree-ids...>', 'Worktree ID(s) to wait on')
    .option('--timeout <seconds>', 'Maximum wait time in seconds', parseInt)
    .option('--on-prompt <mode>', 'Prompt handling: agent (default) exits 10 with a prompt JSON payload on stdout (read it before re-capturing); human keeps waiting for a human reply')
    .option('--stall-timeout <seconds>', 'Maximum time without output change', parseInt)
    .option('--instance <id>', `${WAIT_INSTANCE_OPTION_DESCRIPTION} ${INSTANCE_ALIAS_HELP_SUFFIX}`)
    .option('--verify', 'After completion, run every verification gate; exit 20 when a gate fails, 21 when there is nothing to verify')
    .option('--require-work', 'After completion, run only the work-evidence gate; exit 21 when the worktree has no commits and no uncommitted changes')
    .option('--fail-on-upstream-fault', 'Exit 11 instead of 0 when the agent returns to its composer with an upstream API failure (529/limit/API Error) on the frame')
    .option(
      '--auto-yes-grace <seconds>',
      "With --on-prompt agent, how long a prompt the target's Auto-Yes is answering may stay open before exit 10 (default: 30; 0 exits 10 at once)",
      parseGraceSeconds,
    )
    .option('--token <token>', TOKEN_WARNING)
    // Issue #1926 (design 規約 3): the unclassified dwell is a stop reason with
    // no flag of its own, so `--help` is the only place a caller can find out
    // that it exists — and the only place the interaction with --stall-timeout
    // and --timeout can be stated. Leaving it to the guide means an operator
    // debugging an unexpected exit 10 has nowhere local to look.
    .addHelpText('after', `
Unclassified frames (exit 10, Issue #1708):
  A frame that is interactive but that the detection layer could not parse
  raises isUnclassifiedActive. It is not an immediate stop reason: a capture
  taken mid-repaint raises it for a single poll. Only after it has held for
  60 s does wait exit 10 with {"type":"unclassified"}, and --on-prompt human
  keeps waiting through it like any other prompt.

  Distinct from statusEvidence: 'none', which says the verdict rests on no
  positive proof — an idle composer no tool-specific rule vouched for is
  classified but unproven, and wait completes on it (Issue #2011).

  The 60 s dwell is a constant, not a flag. --timeout and --stall-timeout below
  60 s therefore always win and return 124 instead: the dwell pre-empts long
  waits, it never extends short ones. Inspect the raw pane with
  \`commandmate capture <id> --pane\`; see also statusEvidence /
  sessionStatusReason / lastKnownStatus in \`commandmate capture <id> --json\`.

A prompt the agent has not answered yet (Issue #1975):
  A composer frame right after a send looks exactly like a composer frame the
  agent came back to. When the tool's event source declares it reports both
  ends of a turn, wait therefore checks the chat ledger: if the newest prompt
  sent to this instance postdates the agent's last reported Stop, the turn has
  not been answered and wait keeps polling rather than reporting completion.

  Like the dwell above this is a constant, not a flag: the hold ends after 60 s
  with a note on stderr and a completion of basis=scraper_ready, so hooks that
  stop answering cannot make wait hang, and --timeout / --stall-timeout below
  60 s still win and return 124. A tool that posts no hooks (supportedEvents is
  empty) never enters this path at all. The completion line says which record
  decided it: basis=hook_stop when the agent reported the end of that turn.

A turn the agent will resume by itself (Issue #2614):
  An agent can end its turn while work of its own is still running in the
  background — antigravity's schedule timer, a command it sent to the
  background — and that work wakes it later with nobody typing anything. When
  the tool's event source declares stopReportsSelfResume and the agent's stop
  carries lastEventDetail=self_resume_pending, wait does not report that stop
  as completion. It keeps polling until the agent wakes (a new turn opens) and
  judges the stop that ends that turn instead; the completion line then adds
  heldForSelfResume=<seconds>.

  The hold is a constant 1800 s after the stop, not a flag: an agent that never
  wakes is completed on its stop with a note, and --timeout / --stall-timeout
  below that still win and return 124. Every wake starts a new hold, so an
  agent that keeps rescheduling is waited for until it stops for good.

A prompt the target's Auto-Yes is answering (Issue #2463):
  With --on-prompt agent, a prompt on a session whose Auto-Yes is on is not
  reported at once: Auto-Yes answers it within seconds, and exit 10 would hand
  the delegation back to a human for a prompt nobody had to see. wait keeps
  polling for up to --auto-yes-grace seconds (default: 30), says so in one
  stderr line and leaves stdout empty. If the prompt clears, completion is
  judged as usual; \`commandmate ask\` shares this poller and does the same.

  exit 10 still comes back when the grace runs out with the prompt open, and at
  once when the Auto-Yes policy withheld the answer (the payload then carries
  autoYesSuppression) or Auto-Yes is off. A --timeout / --stall-timeout that
  would lapse during the grace ends it early with exit 10, not 124.
  --auto-yes-grace 0 restores the immediate exit; --on-prompt human is
  unchanged.

The observation on exit 10 (Issue #3755):
  The exit-10 payload also carries "observation": the same payload
  \`commandmate prompt <id> --json\` prints, read off the capture the exit was
  decided on — the screen's kind, an observation token, and Auto-Yes as two
  separate items (the poller's record, the contract re-evaluated now). It
  changes no exit code, hold or grace. autoYesSuppression keeps its meaning
  (the record of this wait: the same waiting-episode id when the record and
  the server both name one, else a record under a minute old; either way not
  one written before Auto-Yes answered this wait, as the push gate reads it);
  a missing record does not mean Auto-Yes can answer.
`)
    .action(async (worktreeIds: string[], options: PollWorktreeOptions) => {
      try {
        // [SEC4-04] Validate all worktree IDs
        for (const id of worktreeIds) {
          if (!isValidWorktreeId(id)) {
            console.error(`Error: Invalid worktree ID format: ${id}`);
            process.exit(ExitCode.CONFIG_ERROR);
            return;
          }
        }

        // Issue #868 / #2376: an instance id or a roster alias.
        if (options.instance && !isInstanceSelector(options.instance)) {
          console.error(INSTANCE_SELECTOR_ERROR);
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        // Issue #2463: see parseGraceSeconds.
        if (options.autoYesGrace !== undefined && Number.isNaN(options.autoYesGrace)) {
          console.error('Error: --auto-yes-grace must be a whole number of seconds (0 or more).');
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        const client = new ApiClient({ token: options.token });

        // Issue #2376: resolve the selector PER worktree. `wait a b --instance
        // "Codex 2"` is one alias against two rosters, and the id behind it can
        // legitimately differ — resolving once and reusing the answer would poll
        // the wrong session on the second worktree.
        const perWorktreeOptions = await Promise.all(
          worktreeIds.map(id => resolveWaitInstance(client, id, options))
        );

        // Issue #1620: resolved before any polling starts. Once the agent stops
        // there is no reliable way left to tell which contract this wait was
        // about — the agent's own verification may have closed it by then.
        const boundTaskIds = verifyRequested(options)
          ? await Promise.all(worktreeIds.map(id => resolveWaitedTaskId(client, id)))
          : worktreeIds.map(() => undefined);

        if (worktreeIds.length === 1) {
          // Single worktree
          const result = await pollWorktree(client, worktreeIds[0], perWorktreeOptions[0]);
          if (result.output) {
            // stdout for result (JSON output)
            console.log(JSON.stringify(result.output));
          }
          // Issue #1544: only a detected completion is worth verifying — a
          // prompt or a timeout means the agent never claimed to be done.
          const exitCode = shouldVerify(result.exitCode, options)
            ? mergeExitCode(
                result.exitCode,
                await verifyAfterWait(client, worktreeIds[0], options, boundTaskIds[0]),
              )
            : result.exitCode;
          process.exit(exitCode);
          return;
        }

        // [DR1-07] Multiple worktrees: Promise.allSettled for error isolation
        const results = await Promise.allSettled(
          worktreeIds.map((id, index) => pollWorktree(client, id, perWorktreeOptions[index]))
        );

        // Collect results
        const outputs: WaitPromptOutput[] = [];
        let finalExitCode: number = WaitExitCode.SUCCESS;
        const verifyTargets: Array<{ id: string; taskId: string | undefined }> = [];

        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            if (result.value.output) {
              outputs.push(result.value.output);
            }
            if (shouldVerify(result.value.exitCode, options)) {
              verifyTargets.push({ id: worktreeIds[index], taskId: boundTaskIds[index] });
              // Issue #1628: fold NOT_STARTED in before verification so a green
              // gate run cannot promote "no session was ever running" to success.
              finalExitCode = mergeExitCode(finalExitCode, result.value.exitCode);
              return;
            }
            finalExitCode = mergeExitCode(finalExitCode, result.value.exitCode);
          } else {
            const err = result.reason;
            finalExitCode = mergeExitCode(
              finalExitCode,
              err instanceof ApiError ? err.exitCode : ExitCode.UNEXPECTED_ERROR,
            );
          }
        });

        // Issue #1544: serial on purpose. The server caps concurrent runs
        // process-wide, so firing them together only queues them behind each
        // other while every gate competes for the same machine.
        for (const target of verifyTargets) {
          finalExitCode = mergeExitCode(
            finalExitCode,
            await verifyAfterWait(client, target.id, options, target.taskId),
          );
        }

        if (outputs.length > 0) {
          console.log(JSON.stringify(outputs));
        }
        process.exit(finalExitCode);
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
