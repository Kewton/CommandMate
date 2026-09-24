/**
 * Short-lived record of the `PreToolUse` questions agy asked CommandMate
 * (Issue #2849).
 *
 * ## Why this exists
 *
 * agy registers its permission hook on every tool call and waits for the reply
 * before it either draws an approval dialog or runs the tool (#2848). A dialog
 * that is really open on the pane therefore always follows a request that
 * reached `POST /api/hooks/permission-request` a moment earlier. A dialog that
 * agy only QUOTED in a reply — `Do you want to proceed?` and its four options
 * in the model's prose — follows nothing. That asymmetry is the whole signal:
 * "did agy ask us about a tool call just now" is a fact the screen cannot fake.
 *
 * ## Why no existing record can be used instead
 *
 * - `reportPermissionRequestPending` is not called for antigravity when
 *   `permissionHookPredictsDialog` is false, which is the ordinary case;
 * - `pendingByInstance` is emptied by `closeDecisionSlot` the moment CommandMate
 *   answers, and the answer and the dialog belong to one causal chain — by the
 *   time the dialog is on the pane the slot is already gone.
 *
 * ## What is kept
 *
 * ONE entry per instance: the tool name and the arrival time of the most recent
 * question. A second question replaces the first, because the only thing asked
 * of this record is "was there one lately".
 *
 * The screen carries no tool name (only the option labels), so the caller that
 * reads a frame asks {@link hasRecentAntigravityPermissionReceipt} without one
 * and gets a time-only answer. The name is still stored and comparable, for a
 * caller that does know it.
 *
 * In-memory and per-process, like the Auto-Yes state it is read beside: a server
 * restart empties it, and the cost is that a dialog opened within
 * {@link ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS} of the restart is left to a
 * human — never that a quotation is answered.
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * globalThis pattern for hot reload persistence — Issue #153, as used by
 * auto-yes-state.ts and `detection/unclassified-frame-tracker.ts`.
 *
 * The hook route (a Next.js route bundle) and the Auto-Yes poller (the server's)
 * can each hold their own copy of this module, and a module-local Map would then
 * be a different Map in each: the receipt would be written into one and looked
 * for in the other, and the gate would refuse every real dialog without any
 * visible fault.
 */
declare global {
  // eslint-disable-next-line no-var
  var __antigravityPermissionReceipts: Map<string, PermissionReceipt> | undefined;
}

/**
 * How long after a `PreToolUse` question a dialog still counts as its dialog.
 *
 * The hook's own timeout is 5 seconds, and the frame the poller reads can lag the
 * pane by a capture interval on top, so 8 seconds is the hook timeout plus the
 * margin for that lag. A `PreToolUse` that timed out never produced a dialog at
 * all (agy proceeds without one), so the window does not need to be longer to
 * cover it.
 */
export const ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS = 8_000;

interface PermissionReceipt {
  /** The tool the question named. */
  toolName: string;
  /** Epoch ms the question arrived. */
  at: number;
}

const receipts = globalThis.__antigravityPermissionReceipts ??
  (globalThis.__antigravityPermissionReceipts = new Map<string, PermissionReceipt>());

/**
 * How long an entry is kept before it is dropped on the next write.
 *
 * Far beyond the window on purpose: an entry older than the window is already
 * useless to the reader, so this only bounds the Map for sessions nobody asks
 * about again (a removed worktree, a killed instance).
 */
const RECEIPT_IDLE_TTL_MS = 60 * 60 * 1000;

function pruneExpiredReceipts(now: number): void {
  for (const [key, receipt] of receipts) {
    if (now - receipt.at > RECEIPT_IDLE_TTL_MS) receipts.delete(key);
  }
}

/**
 * Record that agy asked CommandMate about a tool call.
 *
 * A null `toolName` is not recorded: the payload could not be read, so there is
 * nothing to say the request was a `PreToolUse` at all.
 *
 * @param worktreeId - Worktree the request resolved to
 * @param cliToolId - CLI tool the request came from
 * @param instanceId - Agent instance id (the tool id itself for the primary)
 * @param toolName - Tool the request named, or null when the payload had none
 * @param at - Epoch ms the request arrived
 */
export function recordAntigravityPermissionReceipt(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string,
  toolName: string | null,
  at: number = Date.now(),
): void {
  if (toolName === null) return;
  pruneExpiredReceipts(at);
  receipts.set(buildCompositeKey(worktreeId, cliToolId, instanceId), { toolName, at });
}

/**
 * Did agy ask CommandMate about a tool call, for this instance, within
 * {@link ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS}?
 *
 * @param worktreeId - Worktree the frame belongs to
 * @param cliToolId - CLI tool the frame belongs to
 * @param instanceId - Agent instance id; the tool id itself or `undefined` for
 *   the primary (the spelling the Auto-Yes poller carries)
 * @param toolName - When given, the question must have named this tool. Omit it
 *   to ask only "was there one lately" — a frame carries no tool name.
 * @param now - Epoch ms to measure against
 */
export function hasRecentAntigravityPermissionReceipt(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  toolName?: string,
  now: number = Date.now(),
): boolean {
  const receipt = receipts.get(buildCompositeKey(worktreeId, cliToolId, instanceId));
  if (!receipt) return false;
  if (toolName !== undefined && receipt.toolName !== toolName) return false;
  return now - receipt.at <= ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS;
}

/** Empty the record. Tests only: production entries age out on their own. */
export function resetAntigravityPermissionReceiptsForTests(): void {
  receipts.clear();
}
