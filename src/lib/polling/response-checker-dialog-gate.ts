/**
 * The two gates a prompt candidate passes before it is treated as a live
 * dialog: agy's permission receipt and the tool's own dialog rules
 * (Issue #3374 split from response-checker.ts).
 */

import type { PromptDetectionResult } from '@/lib/detection/prompt-detector';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('response-poller');

import { hasRecentAntigravityPermissionReceipt } from './antigravity-permission-receipts';
// Issue #2457: the same rollout table, `hasDialogRules` cross-check and
// `detectDialog` seam Auto-Yes reads, reached through the presence helper rather
// than through `evaluateAutoYesDialogGate` — see `isNumberedDialogVouched`.
import { evaluateDialogPresence } from './auto-yes-dialog-gate';

/**
 * Whose frame an automatic answer would go to (Issue #2849).
 *
 * `instanceId` is left out for the primary session, the way every Auto-Yes
 * caller spells it.
 */
export interface AntigravityReceiptScope {
  worktreeId: string;
  instanceId?: string;
}

/**
 * Should an agy frame that reads as a prompt be treated as no prompt because
 * agy asked CommandMate about no tool call lately? (Issue #2849)
 *
 * agy asks (`PreToolUse`) before it draws ANY approval dialog and waits for the
 * reply, so a dialog that is really open follows a question a moment before it,
 * and one that is only quoted in a reply follows nothing. The frame carries no
 * tool name, so the check is time-only.
 *
 * Not gated (false) when there is no scope: a caller that only shows the frame —
 * the status API, the response poller's stored `prompt` row, the notification —
 * must keep showing a real dialog on a machine whose hook is not installed or
 * did not reach us. Only the caller that ANSWERS the frame opts in, because for
 * it a missed answer costs a human a keystroke and a wrong one is sent as an
 * utterance nobody asked for.
 *
 * `debug`, not `info`: the poller re-reads a static pane every 2s, so a
 * quotation left on screen would print this on every tick.
 */
export function isWithheldForWantOfReceipt(scope: AntigravityReceiptScope | undefined): boolean {
  if (scope === undefined) return false;
  if (hasRecentAntigravityPermissionReceipt(scope.worktreeId, 'antigravity', scope.instanceId)) return false;
  logger.debug('antigravity-dialog-no-recent-receipt', {
    worktreeId: scope.worktreeId,
    instanceId: scope.instanceId ?? 'antigravity',
  });
  return true;
}

/**
 * Is the generic parser's numbered-list candidate a dialog the tool vouches for?
 * (Issue #2457)
 *
 * ## The candidate this removes
 *
 * `detectPrompt` classifies a frame as `multiple_choice` from the ROWS alone,
 * and for Claude `buildDetectPromptOptions` returns
 * `requireDefaultIndicator: false` — so a reply that happens to answer in
 * Markdown ("1. …  2. …  3. …") is a candidate with no `❯` anywhere near it.
 * Every one of those was stored as a `prompt` message, and the chat surface drew
 * a tool-approval chip over an ordinary answer.
 *
 * ## Why the whole frame, and only the frame
 *
 * `detectDialog` decides by POSITION and CHROME — where the option block sits
 * relative to the transcript tail, what (if anything) is drawn under it. None of
 * that survives being handed the extracted response, the question string or a
 * tail window, so the caller passes the same capture the candidate came off, as
 * captured: `evaluateDialogPresence` documents why the box drawing must still be
 * on it.
 *
 * ## What a `false` means downstream
 *
 * Not "there is no output here" — only "this is not a prompt". The caller falls
 * through to the ordinary completion/partial reading, so a real reply is still
 * saved by the normal path and a half-written one still reports
 * `isComplete: false`.
 *
 * @param cliToolId - CLI tool the frame came from
 * @param promptDetection - What the generic parser (or a tool reader) answered
 * @param frame - The whole capture this tick made, as captured
 * @returns True when the candidate may be treated as a live prompt
 */
export function isNumberedDialogVouched(
  cliToolId: CLIToolType,
  promptDetection: PromptDetectionResult,
  frame: string,
): boolean {
  const presence = evaluateDialogPresence(
    cliToolId,
    promptDetection.promptData?.type,
    frame,
  );
  if (presence.present) return true;

  // `debug`, not `info`: the poller re-reads a static idle pane every 2s, so a
  // reply carrying a numbered list would print this on every tick for as long as
  // it stays on screen. The suppression is not silent where it matters — nothing
  // is stored, so History simply shows the reply the ordinary path saves.
  logger.debug('prompt-candidate-not-vouched', {
    cliToolId,
    promptType: promptDetection.promptData?.type,
    gateMode: presence.mode,
  });
  return false;
}
