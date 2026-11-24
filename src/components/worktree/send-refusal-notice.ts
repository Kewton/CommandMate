/**
 * Issue #4535 (段 2 §3): the reasons a send was stopped before or while it was typed, read off the
 * server's answer for the screen — the role refusal (#4385, `role-refusal-notice`) and the send
 * fence's 409 `SEND_TARGET_CHANGED` (#4534: the target the send resolved is no longer the one it
 * would reach). The sentences are in the `worktree` dictionary of both languages.
 *
 * The fence's body is `{ error, code: 'SEND_TARGET_CHANGED', reason, target, current, requestId,
 * sendOutcome }` (`src/lib/session/send-fence-outcome.ts` `sendTargetChangedBody`). `sendOutcome`
 * is `not_sent` (nothing was typed: the text may go back) or `unknown` (it may already be in the
 * session: never handed back, never said to be "not sent"). Anything but `not_sent` reads as
 * `unknown`.
 *
 * Kept free of `@/lib/api-client` and React (read by shape), like `role-refusal-notice`.
 *
 * @module components/worktree/send-refusal-notice
 */

/** The fence's 409 code (`SEND_TARGET_CHANGED_CODE`, `src/lib/session/send-fence-outcome.ts`). */
export const SEND_TARGET_CHANGED_CODE = 'SEND_TARGET_CHANGED';

/** Why the fence stopped the send (`FenceRefusalReason`, `terminal-fence.ts`), `other` for anything else. */
export type SendTargetChangedReason =
  | 'worktree-gone'
  | 'target-gone'
  | 'tool-changed'
  | 'dispatch-changed'
  | 'unreadable'
  | 'other';

/** Where the stopped send was going (the entry's resolved triple). */
export interface SendTargetTriple {
  worktreeId: string;
  instanceId: string;
  cliToolId: string;
}

export interface SendTargetChangedRefusal {
  reason: SendTargetChangedReason;
  /** `not_sent` only when the answer says so; anything else may already be in the session. */
  sendOutcome: 'not_sent' | 'unknown';
  /** The original target, when the answer names it whole. */
  target: SendTargetTriple | null;
}

const KEY_PREFIX = 'conversation.sendTargetChanged';

export const SEND_TARGET_CHANGED_REASON_KEYS: Readonly<Record<SendTargetChangedReason, string>> = {
  'worktree-gone': `${KEY_PREFIX}.reason.worktreeGone`,
  'target-gone': `${KEY_PREFIX}.reason.targetGone`,
  'tool-changed': `${KEY_PREFIX}.reason.toolChanged`,
  'dispatch-changed': `${KEY_PREFIX}.reason.dispatchChanged`,
  unreadable: `${KEY_PREFIX}.reason.unreadable`,
  other: `${KEY_PREFIX}.reason.other`,
};

/** The `worktree` dictionary keys of the fence's sentences (`{reason}`, `{target}`, `{original}`, `{current}`). */
export const SEND_TARGET_CHANGED_KEYS = {
  notSent: `${KEY_PREFIX}.notSent`,
  textReturned: `${KEY_PREFIX}.textReturned`,
  textNotReturned: `${KEY_PREFIX}.textNotReturned`,
  unknown: `${KEY_PREFIX}.unknown`,
  retargetConfirm: `${KEY_PREFIX}.retargetConfirm`,
  retargetConfirmYes: `${KEY_PREFIX}.retargetConfirmYes`,
  retargetConfirmNo: `${KEY_PREFIX}.retargetConfirmNo`,
} as const;

/** The `worktree` dictionary key of a fence reason's sentence. */
export function sendTargetChangedReasonKey(reason: SendTargetChangedReason): string {
  return SEND_TARGET_CHANGED_REASON_KEYS[reason];
}

function readReason(value: unknown): SendTargetChangedReason {
  switch (value) {
    case 'worktree-gone':
    case 'target-gone':
    case 'tool-changed':
    case 'dispatch-changed':
    case 'unreadable':
      return value;
    default:
      return 'other';
  }
}

function readTarget(value: unknown): SendTargetTriple | null {
  if (typeof value !== 'object' || value === null) return null;
  const { worktreeId, instanceId, cliToolId } = value as Record<string, unknown>;
  return typeof worktreeId === 'string' && typeof instanceId === 'string' && typeof cliToolId === 'string'
    ? { worktreeId, instanceId, cliToolId }
    : null;
}

/** The fence's refusal from a response's status and JSON body, or null when it is not one. */
export function readSendTargetChangedBody(status: unknown, body: unknown): SendTargetChangedRefusal | null {
  if (status !== 409 || typeof body !== 'object' || body === null) return null;
  const data = body as Record<string, unknown>;
  if (data.code !== SEND_TARGET_CHANGED_CODE) return null;
  return {
    reason: readReason(data.reason),
    sendOutcome: data.sendOutcome === 'not_sent' ? 'not_sent' : 'unknown',
    target: readTarget(data.target),
  };
}

/** The fence's refusal from the error `fetchApi` threw (`ApiError`: `status`, `data`), or null. */
export function readSendTargetChanged(error: unknown): SendTargetChangedRefusal | null {
  if (typeof error !== 'object' || error === null) return null;
  const { status, data } = error as { status?: unknown; data?: unknown };
  return readSendTargetChangedBody(status, data);
}

/** How a target is named to the person: its instance and its tool (`tool-changed` keeps the id). */
export function describeSendTarget(target: { instanceId: string; cliToolId: string }): string {
  return `${target.instanceId} (${target.cliToolId})`;
}

/** Whether two targets are the same — the instance and the tool both (段 2 §3.2). */
export function isSameSendTarget(
  a: { instanceId: string; cliToolId: string },
  b: { instanceId: string; cliToolId: string },
): boolean {
  return a.instanceId === b.instanceId && a.cliToolId === b.cliToolId;
}
