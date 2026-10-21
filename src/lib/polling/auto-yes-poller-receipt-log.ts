/**
 * Auto-Yes poller: the agy hook-receipt bookkeeping and its withheld log lines
 * (Issue #3783: split out of `auto-yes-poller.ts`, which re-exports the public
 * names).
 *
 * Does not statically import `auto-yes-poller.ts` (no cycle outside the
 * baseline in `import-cycles-baseline-3482`, which does not count dynamic
 * `import()`).
 *
 * @module lib/polling/auto-yes-poller-receipt-log
 */

import type { CLIToolType } from '../cli-tools/types';
import {
  ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS,
  getAntigravityReceiptVerdict,
  judgeAntigravityPermissionReceipt,
  getAntigravityAcceptedReceiptAt,
  markAntigravityAnswerSent,
  type AntigravityReceiptVerdict,
} from './antigravity-receipt-episodes';
import { ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS } from './antigravity-permission-receipts';
import { policyLookupMode, resolveAutoAnswerWithPolicy } from './auto-yes-resolver';
import { getSessionAutoYesPolicyLookupEntry } from './auto-yes-policy';
import type { PromptDetectionResult } from '../detection/types';
import { createLogger } from '@/lib/logger';
import { getOrInitGlobal } from '../global-state';
import {
  CONTRACT_SUPPRESSION_REASONS,
  NO_HOOK_RECEIPT_SUPPRESSION_REASON,
  PARTIAL_ANSWER_SUPPRESSION_REASON,
  POLICY_LOOKUP_FAILED_SUPPRESSION_REASON,
} from './auto-yes-suppression-reason';
import {
  forgetPolicySuppression,
  getLastPolicySuppression,
  recordPolicySuppression,
} from './auto-yes-suppression-state';

const logger = createLogger('auto-yes-poller');

declare global {
  // eslint-disable-next-line no-var
  var __autoYesWithheldNoReceiptLoggedAt: Map<string, number> | undefined;
}

/**
 * When `antigravity-autoyes-withheld-no-hook-receipt` was last logged, per
 * compositeKey (Issue #2857). The poller re-reads a static pane every 2s, so the
 * line is limited to one per {@link WITHHELD_NO_RECEIPT_LOG_INTERVAL_MS} per
 * instance. globalThis for the same reason as the poller states above.
 */
export const withheldNoReceiptLoggedAt = getOrInitGlobal('__autoYesWithheldNoReceiptLoggedAt', () => new Map<string, number>());

/**
 * Least gap between two `antigravity-autoyes-withheld-no-hook-receipt` lines for
 * one instance. `antigravity-autoyes-withheld-by-policy` (Issue #3724) shares it.
 */
const WITHHELD_NO_RECEIPT_LOG_INTERVAL_MS = 60_000;

/**
 * Say, once a minute, that Auto-Yes left an agy dialog alone for want of a hook
 * receipt (Issue #2857).
 *
 * `detectPromptOnCleanFrame` hands a frame the receipt gate (#2849) withholds
 * back as an ordinary `isPrompt: false`, so the poller cannot tell "no dialog on
 * the pane" from "a dialog agy never asked us about" by looking at the result.
 * The gate is the ONLY thing `receiptScope` changes, so the same frame read
 * without it answering a prompt is exactly the withheld case. That second
 * reading is taken only after the cheap tests: no receipt for this instance in
 * the window (with one, the gate let the frame through and a no-prompt result is
 * a real one) and no line for it in the last minute.
 *
 * Why it is worth a line: a machine whose `~/.gemini/config/hooks.json` points at
 * another server (#2622) never sends us the question, and every real dialog then
 * waits for a human with no sign of why. The line names the file to look at.
 *
 * A stale receipt does not always mean that, though (Issue #3724): a dialog the
 * contract's autoYes withheld got its receipt, the server answered `ask`, and
 * the dialog outlived the window. When `resolveAutoAnswerWithPolicy` on the
 * ungated reading suppresses the answer by contract (the base rules would have
 * answered it), the line is `antigravity-autoyes-withheld-by-policy` instead,
 * naming the reason, the mode and the task. Both share the limit.
 * The response-checker's own `antigravity-dialog-no-recent-receipt` stays at
 * debug — it prints on every tick the same pane is read again.
 *
 * @param compositeKey - The instance's key, for the once-a-minute limit
 * @param readWithoutGate - The same frame read without `receiptScope`
 */
export function logIfWithheldForWantOfReceipt(
  worktreeId: string,
  instanceId: string | undefined,
  compositeKey: string,
  readWithoutGate: () => PromptDetectionResult,
): void {
  // Issue #3767: the gate's own verdict for this tick's candidate. Null means it
  // never saw one (no dialog), `ok` that it let the frame through.
  let verdict = getAntigravityReceiptVerdict(worktreeId, instanceId);
  if (verdict?.ok) return;

  const now = Date.now();
  const ungated = readWithoutGate();
  if (!ungated.isPrompt || !ungated.promptData) return;
  // The gate was not consulted (the gated reading declined the frame on screen
  // grounds alone) yet the frame reads as a prompt: judge it here.
  verdict ??= judgeAntigravityPermissionReceipt(worktreeId, instanceId, now);
  if (verdict.ok) return;

  // Issue #3724: a contract that withholds the answer makes the server reply
  // `ask`, so the dialog stays up past the receipt window. The cause is then the
  // contract, not a hooks.json that points elsewhere. Judged exactly as the tick
  // judges a prompt it can read — the base rules first, then the contract — so
  // a prompt the base rules never answer (a checkbox, a typed option) is not
  // blamed on the contract. Policy and task id come from one lookup.
  // Issue #3822: a failed lookup stays unknown here, as it is for the tick, so
  // this re-judgement withholds too instead of reading "no contract" and
  // dropping the `policy-lookup-failed` record the tick made.
  const { policy, taskId } = getSessionAutoYesPolicyLookupEntry(worktreeId, 'antigravity', instanceId);
  const mode = policyLookupMode(policy);
  const resolution = resolveAutoAnswerWithPolicy(ungated.promptData, policy);
  // Issue #3767: `answered` is the dialog the gate already let through on this
  // receipt, still up past the window. Unless the contract withheld it, that is
  // not a missing receipt: neither recorded nor logged, nor counted for the limit.
  // Issue #3789: `answered` is also a dialog accepted but never sent to (the
  // tick recorded its own reason, if any, and that record is kept). One the
  // poller DID send keys to and still up past the grace is `outlived`, which is
  // recorded and logged like the others, so the stop is not a silent one.
  // Issue #3796: the reason the poller recorded for this dialog (partial-answer,
  // the contract, …) while it could still read it inside the window was not
  // re-stamped once the window closed — the gated reading stopped seeing the
  // prompt — so `cmate wait` dropped it as stale a minute later with the dialog
  // still up. Re-stamped here on every tick the dialog stays — only while it
  // still holds under this tick's evaluation — and kept over a `no-hook-receipt`
  // for it: it is the more exact reason.
  const keptPartialAnswer = refreshEpisodeSuppression(worktreeId, instanceId, verdict, resolution);
  // Issue #3796 review D: a contract that withholds the prompt now is published
  // whatever was recorded before — none at all (the window closed before the
  // tick could read it, or an ended contract's record was dropped and a new one
  // withholds it again) or another reason. Without it `cmate wait` read no
  // reason and held the prompt as one Auto-Yes was answering. Only a partial
  // answer still on screen comes first, as it does on the tick (step 2.5).
  if (resolution.suppressedBy && !keptPartialAnswer) {
    recordPolicySuppression(worktreeId, 'antigravity', instanceId, {
      reason: resolution.suppressedBy,
      mode,
      promptType: ungated.promptData.type,
      ...(resolution.pattern !== undefined ? { pattern: resolution.pattern } : {}),
    });
  }
  if (!resolution.suppressedBy && (verdict.cause === 'answered' || keptPartialAnswer)) return;

  const lastLoggedAt = withheldNoReceiptLoggedAt.get(compositeKey);
  const logDue = lastLoggedAt === undefined || now - lastLoggedAt >= WITHHELD_NO_RECEIPT_LOG_INTERVAL_MS;
  if (logDue) {
    for (const [key, loggedAt] of withheldNoReceiptLoggedAt) {
      if (now - loggedAt >= WITHHELD_NO_RECEIPT_LOG_INTERVAL_MS) withheldNoReceiptLoggedAt.delete(key);
    }
    withheldNoReceiptLoggedAt.set(compositeKey, now);
  }
  if (resolution.suppressedBy) {
    if (!logDue) return;
    logger.info('antigravity-autoyes-withheld-by-policy', {
      worktreeId,
      instanceId: instanceId ?? 'antigravity',
      reason: resolution.suppressedBy,
      mode,
      taskId,
      hint:
        resolution.suppressedBy === POLICY_LOOKUP_FAILED_SUPPRESSION_REASON
          ? '契約の照会に失敗したので答えていない。サーバーログの policy-lookup-failed を確認'
          : '契約の autoYes が答えを止めている。契約の autoYes を確認',
    });
    return;
  }
  // Issue #3767: recorded on every tick (the record's `at` follows the prompt
  // while it stays up), logged once a minute.
  recordPolicySuppression(worktreeId, 'antigravity', instanceId, {
    reason: NO_HOOK_RECEIPT_SUPPRESSION_REASON,
    mode: null,
    promptType: ungated.promptData.type,
  });
  if (!logDue) return;
  logger.info('antigravity-autoyes-withheld-no-hook-receipt', {
    worktreeId,
    instanceId: instanceId ?? 'antigravity',
    windowMs: ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS,
    hint: noHookReceiptHint(verdict, now),
  });
}

/**
 * Issue #3796: keep the suppression the poller recorded during this dialog's
 * episode current while the dialog it accepted (`answered` / `outlived`) is
 * still up. Only a record made since the dialog was first read, and never the
 * receipt gate's own `no-hook-receipt` (the caller records that itself). A
 * record is kept only while its reason still holds NOW:
 *
 * - `partial-answer` remembers an event: it holds for as long as the dialog
 *   the keys went to stays up (this episode), and is re-stamped here;
 * - a contract reason is the contract's verdict on the prompt, re-evaluated on
 *   every tick (`resolution`): no verdict (the contract ended, or now answers
 *   it) drops the record — the dialog is then `answered` / `outlived` like any
 *   other. A verdict is recorded by the caller (review D), whatever was here;
 * - any other reason is left as it was recorded.
 *
 * @returns true when a `partial-answer` that still holds was re-stamped
 */
function refreshEpisodeSuppression(
  worktreeId: string,
  instanceId: string | undefined,
  verdict: AntigravityReceiptVerdict,
  resolution: ReturnType<typeof resolveAutoAnswerWithPolicy>,
): boolean {
  if (verdict.cause !== 'answered' && verdict.cause !== 'outlived') return false;
  const own = getLastPolicySuppression(worktreeId, 'antigravity', instanceId);
  if (own === null || own.reason === NO_HOOK_RECEIPT_SUPPRESSION_REASON || !(own.at >= verdict.firstSeenAt)) {
    return false;
  }
  if (own.reason === PARTIAL_ANSWER_SUPPRESSION_REASON) {
    // The memory is the episode's: the dialog the keys went to is still the one
    // up (same episode, accepted on the same receipt). Not `getPartialAnswer`:
    // the tick forgets it as soon as the gated reading stops seeing the prompt,
    // which past the window is every tick.
    const { at: _recordedAt, ...suppression } = own;
    recordPolicySuppression(worktreeId, 'antigravity', instanceId, suppression);
    return true;
  }
  if (CONTRACT_SUPPRESSION_REASONS.has(own.reason) && !resolution.suppressedBy) {
    forgetPolicySuppression(worktreeId, 'antigravity', instanceId);
  }
  return false;
}

/**
 * Issue #3789: keys for an agy dialog the receipt gate accepted reached tmux.
 * Only here does the gate start the grace after which a dialog still up is
 * reported as `outlived`; the tick's `no_answer` exits (another server's session,
 * a partial answer, the base rules or the contract not answering) never get
 * here, so their own records are not overwritten by `no-hook-receipt`.
 *
 * Issue #3796: `interrupted` — the send began and was cut short (stopped
 * part-way, or failed). Its keys may be on the pane and the receipt is spent,
 * so the grace starts here too; without it the dialog stayed `answered`, and
 * silent, for as long as it stayed up.
 */
export function noteAnswerSent(
  cliToolId: CLIToolType,
  worktreeId: string,
  instanceId: string | undefined,
  interrupted = false,
  forReceiptAt?: number | null,
): void {
  if (cliToolId !== 'antigravity') return;
  markAntigravityAnswerSent(worktreeId, instanceId, Date.now(), {
    interrupted,
    ...(forReceiptAt !== undefined ? { forReceiptAt } : {}),
  });
}

/**
 * Issue #3796 review: the agy episode a send is about to go to, read before
 * its first await; null for other tools. Given back to {@link noteAnswerSent}
 * however the send came back — whole, failed or cut short (review E) — so that
 * only that episode is marked — the same
 * idea as the Enter record's generation check in `tryEnterFallback`.
 */
export function receiptEpisodeOfSend(
  cliToolId: CLIToolType,
  worktreeId: string,
  instanceId: string | undefined,
): number | null {
  return cliToolId === 'antigravity' ? getAntigravityAcceptedReceiptAt(worktreeId, instanceId) : null;
}

/**
 * The hint for `antigravity-autoyes-withheld-no-hook-receipt` (Issue #3767):
 * which of the withheld cases it was decides where to look.
 */
export function noHookReceiptHint(verdict: AntigravityReceiptVerdict, now: number = Date.now()): string {
  const seconds = verdict.ageMs === null ? null : Math.round(verdict.ageMs / 1000);
  // `lapsed` says how long ago, so from now: the line repeats once a minute.
  const secondsAgo = verdict.lastReceiptAt === null ? null : Math.round((now - verdict.lastReceiptAt) / 1000);
  switch (verdict.cause) {
    case 'never':
      return 'hook の受信が一度も無いため Auto-Yes は答えなかった。~/.gemini/config/hooks.json の向き先（#2622）を確認';
    case 'late':
      return `最後の受信から ${seconds} 秒後に確認が出た（窓 ${ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS / 1000} 秒の外）ため答えなかった。人が答える（auto-yes --disable → prompt --json → respond --expect-screen）。続くなら ~/.gemini/config/hooks.json の向き先（#2622）も確認`;
    case 'lapsed':
      return `最後の受信は ${secondsAgo} 秒前で途絶えている（hook が届かなくなった）。hooks.json の向き先（#2622）と agy の再起動を確認`;
    case 'predates':
      return '確認は最後の受信より前から画面に出ていた（引用か別の確認）ため答えなかった。人が答える';
    case 'used':
      return '最後の受信は直前の確認に使い済み。この確認に対する受信は無いため答えなかった。人が答える';
    case 'outlived':
      if (verdict.answerInterrupted === true) {
        return `Auto-Yes が最後の受信の確認へ答えを送る途中で送信が止まり（キーの一部が入力に残っている可能性がある）、${ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS / 1000} 秒を過ぎても確認が画面に残っている。未使用の受信が無いため、もう一度は答えない。人が答える（auto-yes --disable → prompt --json → respond --expect-screen）`;
      }
      return `Auto-Yes が最後の受信の確認へキーを送ってから ${ANTIGRAVITY_ANSWERED_DIALOG_GRACE_MS / 1000} 秒を過ぎても、確認が画面に残っている。キーで確認が閉じなかったか、新しい受信の無い別の確認と入れ替わった（画面からは区別できない）。未使用の受信が無いため、もう一度は答えない。人が答える（auto-yes --disable → prompt --json → respond --expect-screen）`;
    default:
      return 'hook の受信記録が直近に無いため Auto-Yes は答えなかった。~/.gemini/config/hooks.json の向き先（#2622）を確認';
  }
}
