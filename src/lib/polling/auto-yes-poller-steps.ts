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
import { PARTIAL_ANSWER_SUPPRESSION_REASON } from './auto-yes-suppression-reason';
import {
  forgetPartialAnswer,
  getPartialAnswer,
  hasMovedSendInFlight,
  warnOncePerFrame,
} from './auto-yes-poller-state';
import { suppressAndWarnOnce, type JudgedPrompt } from './auto-yes-prompt-suppression';

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
        ...(resolution.policyLookupFailed ? { policyLookupFailed: true as const } : {}),
      },
      `${frameKey}\u0000${resolution.suppressedBy}\u0000${mode ?? ''}\u0000${resolution.pattern ?? ''}\u0000${resolution.policyLookupFailed ? 'lookup-failed' : ''}`,
      'poller:auto-yes-suppressed-by-policy',
      {
        reason: resolution.suppressedBy,
        mode,
        pattern: resolution.pattern,
        promptType: promptData.type,
        ...(resolution.policyLookupFailed ? { policyLookupFailed: true } : {}),
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
