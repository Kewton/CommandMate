/**
 * Auto-Yes poller: synchronous steps of `detectAndRespondToPrompt` that decide
 * whether a read prompt is left alone (Issue #3781) (Issue #3783: split out of
 * `auto-yes-poller.ts`).
 *
 * Does not statically import `auto-yes-poller.ts` (no cycle outside the
 * baseline in `import-cycles-baseline-3482`, which does not count dynamic
 * `import()`).
 *
 * @module lib/polling/auto-yes-poller-steps
 */

import { policyLookupMode, resolveAutoAnswerWithPolicy } from './auto-yes-resolver';
import { getSessionAutoYesPolicy } from './auto-yes-policy';
import type { checkWorktreeSessionOwnership } from '../cli-tools/worktree-session-ownership';
import {
  PARTIAL_ANSWER_SUPPRESSION_REASON,
  POLICY_LOOKUP_FAILED_SUPPRESSION_REASON,
  QUESTION_CONFIRM_PAGE_SUPPRESSION_REASON,
} from './auto-yes-suppression-reason';
import { getAutoYesState } from '../auto-yes-state';
import { isAutoYesQuestionPrompt } from './auto-yes-dialog-gate';
import {
  forgetPartialAnswer,
  getPartialAnswer,
  hasMovedSendInFlight,
  warnOncePerFrame,
} from './auto-yes-poller-state';
import { suppressAndWarnOnce, truncateForLog, type JudgedPrompt } from './auto-yes-prompt-suppression';
import { withholdLedgerConfirmation } from './auto-yes-confirmation-ledger';

/**
 * Step 2.5 of `detectAndRespondToPrompt`: whether an earlier send to this
 * screen keeps the prompt from being answered now.
 *
 * @returns true when the prompt is withheld (the caller returns `no_answer`)
 */
export function withheldForEarlierSend(judged: JudgedPrompt, screenKey: string, epoch: number): boolean {
  const { worktreeId, cliToolId, instanceId, compositeKey, pollerState, promptData, frameKey } = judged;
  const partial = getPartialAnswer(compositeKey, epoch);
  if (partial !== null) {
    if (partial.screenKey === screenKey) {
      suppressAndWarnOnce(
        judged,
        {
          reason: PARTIAL_ANSWER_SUPPRESSION_REASON,
          mode: null,
          promptType: promptData.type,
        },
        `${frameKey}\u0000partial-answer`,
        'poller:auto-yes-skipped-partial-answer',
        { promptType: promptData.type, stoppedAt: partial.at },
      );
      return true;
    }
    // Another prompt is on screen: only the sends at the forgotten one's
    // screen go with it (#3713) — one in flight at this screen keeps its hold.
    forgetPartialAnswer(compositeKey, partial.screenKey);
  }
  // Issue #3713: a worktree ID move carried an answer still being sent to
  // this session's key. Its keys may already be on the pane, and how its send
  // ends is not known yet — so this screen gets no keys until it comes back
  // (recorded as a partial answer above, or gone).
  if (hasMovedSendInFlight(compositeKey, epoch, screenKey)) {
    // Issue #3820: a stop the policy record never carries — the ledger's own reason.
    withholdLedgerConfirmation(judged, 'moved-send-in-flight');
    warnOncePerFrame(
      pollerState,
      `${frameKey}\u0000moved-send-in-flight`,
      'poller:auto-yes-skipped-moved-send-in-flight',
      { worktreeId, cliToolId, instanceId, promptType: promptData.type },
    );
    return true;
  }
  return false;
}

/**
 * Step 3.7 of `detectAndRespondToPrompt` (Issue #3822): a question to the
 * operator is the human's to answer, not Auto-Yes's — Auto-Yes answers
 * permissions only. Judged on a frame the tool's own rules read
 * ({@link isAutoYesQuestionPrompt}); a `legacy` tool is unchanged (#3823).
 *
 * Not a contract verdict, so `allowPromptTypes` cannot bring it back: an
 * `allow-listed` contract naming `multiple_choice` delegates permission
 * dialogs, not the operator's questions.
 *
 * Recorded as `question-confirm-page` — the reason for the question family's
 * confirm page (#3748), whose meaning ("a question Auto-Yes leaves to a
 * human") this shares; the WARN has its own event name.
 *
 * @returns true when the prompt is withheld (the caller returns `no_answer`)
 */
export function withheldAsQuestion(judged: JudgedPrompt): boolean {
  const { promptData, frameKey, dialogGate } = judged;
  if (dialogGate === undefined || !isAutoYesQuestionPrompt(promptData, dialogGate)) return false;
  suppressAndWarnOnce(
    judged,
    { reason: QUESTION_CONFIRM_PAGE_SUPPRESSION_REASON, mode: null, promptType: promptData.type },
    `${frameKey}\u0000question`,
    'poller:auto-yes-skipped-question',
    {
      reason: QUESTION_CONFIRM_PAGE_SUPPRESSION_REASON,
      promptType: promptData.type,
      dialogKind: dialogGate.dialog?.kind ?? null,
      question: truncateForLog(promptData.question),
    },
  );
  return true;
}

/**
 * The last look before a key (Issue #3822): is the answer still Auto-Yes's to
 * send? Asked after the last wait before the send (the ownership check, or the
 * Enter fallback's fresh capture), so nothing it reads can change before the
 * first key goes out.
 *
 * - With a `generation` (a poller tick), Auto-Yes must still be on and inside
 *   its window. `getAutoYesState` disables an expired grant on read, the
 *   boundary the hook and the next tick see. Without one (direct callers,
 *   tests) the grant is not checked, as the tick checks nothing then (#3706).
 * - The contract is read again past the policy cache, so a switched contract,
 *   an `off`, or a deny pattern added since the tick's lookup withholds the
 *   key. A read that fails is "contract unknown" (`policy-lookup-failed`), as
 *   in step 4, and so is a grant that cannot be read.
 *
 * The `PermissionRequest` hook is not asked this: its `allow` IS the answer,
 * decided against the grant and the contract when the hook is answered, and
 * nothing is typed afterwards for a later look to stop.
 *
 * @param checkGrant - Whether the grant is checked (a tick with a generation)
 * @returns true when the key is withheld (the caller returns `no_answer`)
 */
export function withheldAtSend(judged: JudgedPrompt, checkGrant: boolean): boolean {
  const { worktreeId, cliToolId, instanceId, pollerState, promptData, frameKey } = judged;
  if (checkGrant) {
    let grant: ReturnType<typeof getAutoYesState>;
    try {
      grant = getAutoYesState(worktreeId, cliToolId, instanceId);
    } catch {
      return withholdAsUnknown(judged);
    }
    if (!grant?.enabled) {
      // Auto-Yes is off: nothing is recorded as withheld (the poller stops on
      // its next tick and the state says why), only that the key was not sent.
      warnOncePerFrame(pollerState, `${frameKey}\u0000at-send-disabled`, 'poller:auto-yes-withheld-at-send', {
        worktreeId,
        cliToolId,
        instanceId,
        reason: grant?.stopReason === 'expired' ? 'expired' : 'auto-yes-disabled',
        promptType: promptData.type,
      });
      return true;
    }
  }

  const policy = getSessionAutoYesPolicy(worktreeId, cliToolId, instanceId, { fresh: true });
  const resolution = resolveAutoAnswerWithPolicy(promptData, policy);
  if (resolution.suppressedBy) {
    const mode = policyLookupMode(policy);
    suppressAndWarnOnce(
      judged,
      { reason: resolution.suppressedBy, mode, promptType: promptData.type, pattern: resolution.pattern },
      `${frameKey}\u0000${resolution.suppressedBy}\u0000${mode ?? ''}\u0000${resolution.pattern ?? ''}`,
      'poller:auto-yes-suppressed-by-policy',
      {
        reason: resolution.suppressedBy,
        mode,
        pattern: resolution.pattern,
        promptType: promptData.type,
        atSend: true,
      },
    );
    return true;
  }
  return false;
}

function withholdAsUnknown(judged: JudgedPrompt): boolean {
  const { promptData, frameKey } = judged;
  suppressAndWarnOnce(
    judged,
    { reason: POLICY_LOOKUP_FAILED_SUPPRESSION_REASON, mode: null, promptType: promptData.type },
    `${frameKey}\u0000${POLICY_LOOKUP_FAILED_SUPPRESSION_REASON}\u0000at-send`,
    'poller:auto-yes-suppressed-by-policy',
    { reason: POLICY_LOOKUP_FAILED_SUPPRESSION_REASON, mode: null, promptType: promptData.type, atSend: true },
  );
  return true;
}

/**
 * Step 4 of `detectAndRespondToPrompt`: the auto answer under the execution
 * contract's policy, recording the suppression when the policy withholds it.
 *
 * @returns The answer to send, or null when there is none
 */
export function resolveAnswerUnderPolicy(judged: JudgedPrompt): string | null {
  const { worktreeId, cliToolId, instanceId, promptData, frameKey } = judged;
  // Issue #3822: a failed lookup reaches the resolver as unknown and withholds.
  const policy = getSessionAutoYesPolicy(worktreeId, cliToolId, instanceId);
  const resolution = resolveAutoAnswerWithPolicy(promptData, policy);
  if (resolution.suppressedBy) {
    const mode = policyLookupMode(policy);
    // Issue #1684: the log line alone leaves a CLI-driven pipeline blind to
    // why its worker stalled. Record the suppression so buildCurrentOutput
    // can publish it (`autoYes.lastSuppression` in capture --json).
    suppressAndWarnOnce(
      judged,
      {
        reason: resolution.suppressedBy,
        mode,
        promptType: promptData.type,
        pattern: resolution.pattern,
      },
      `${frameKey}\u0000${resolution.suppressedBy}\u0000${mode ?? ''}\u0000${resolution.pattern ?? ''}`,
      'poller:auto-yes-suppressed-by-policy',
      {
        reason: resolution.suppressedBy,
        mode,
        pattern: resolution.pattern,
        promptType: promptData.type,
      },
    );
  }
  return resolution.answer;
}

/**
 * Issue #2865: whether the session is not this server's to type into (another
 * server created it, or the worktree is gone), warning once per frame.
 *
 * @returns true when the caller returns `no_answer`
 */
export function skippedForUnownedSession(
  judged: JudgedPrompt,
  sessionName: string,
  ownership: Awaited<ReturnType<typeof checkWorktreeSessionOwnership>>,
): boolean {
  const { worktreeId, cliToolId, instanceId, pollerState, frameKey } = judged;
  if (ownership === null || ownership.verdict === 'foreign') {
    // Issue #3820: as above, the ledger's own reason.
    withholdLedgerConfirmation(judged, 'foreign-session');
    warnOncePerFrame(
      pollerState,
      `${frameKey}\u0000${sessionName}\u0000${ownership ? 'foreign' : 'worktree_not_found'}`,
      'poller:auto-yes-skipped-foreign-session',
      {
        worktreeId,
        cliToolId,
        instanceId,
        sessionName,
        sessionPath: ownership?.sessionPath ?? null,
        reason: ownership ? 'foreign' : 'worktree_not_found',
      },
    );
    return true;
  }
  return false;
}
