/**
 * Issue #4385: the sentence the screen shows for a send the server refused because of its role
 * (409 `roleRefusal`, nothing typed) — the composer's notice right after the send and the failed
 * row in the history. The sentences say what the CLI's (`send` exit 32, `cli/utils/role-failure.ts`)
 * say — nothing was sent, why, and what to do next (stop the session and start it again) — in the
 * `worktree` dictionary of both languages, and never quote the agent's own output.
 *
 * Kept free of `@/lib/api-client` (read by shape, not by class) so the composer's and the
 * history's many suites that replace that module keep working unchanged.
 *
 * @module components/worktree/role-refusal-notice
 */

import type { SendRoleRefusalReason } from '@/types/models';

export const SEND_ROLE_REFUSAL_KEYS: Readonly<Record<SendRoleRefusalReason, string>> = {
  'not-applied': 'conversation.roleRefusal.notApplied',
  'not-confirmed': 'conversation.roleRefusal.notConfirmed',
  'artifact-failed': 'conversation.roleRefusal.artifactFailed',
  other: 'conversation.roleRefusal.other',
};

/** The `worktree` dictionary key of a role refusal's sentence. */
export function sendRoleRefusalMessageKey(reason: SendRoleRefusalReason): string {
  return SEND_ROLE_REFUSAL_KEYS[reason];
}

/**
 * The role reason of a send the server refused with 409 and `roleRefusal` (nothing was typed;
 * `send-failure.ts` / `send-session-start.ts` / `send-role.ts`), or null when it is not one. Read
 * from the response body an `ApiError` carries in `data` (`fetchApi`); the response's shape is
 * the server's, unchanged.
 */
export function readSendRoleRefusal(error: unknown): SendRoleRefusalReason | null {
  if (typeof error !== 'object' || error === null) return null;
  const { status, data } = error as { status?: unknown; data?: unknown };
  if (status !== 409 || typeof data !== 'object' || data === null) return null;
  const roleRefusal = (data as { roleRefusal?: unknown }).roleRefusal;
  if (typeof roleRefusal !== 'string') return null;
  switch (roleRefusal) {
    case 'not-applied':
    case 'not-confirmed':
    case 'artifact-failed':
      return roleRefusal;
    default:
      return 'other';
  }
}
