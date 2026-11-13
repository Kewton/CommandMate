/**
 * Issue #4345 1c 再指示 1: `readRunningInstances` of `@/lib/api-client-agent-roles` (through its private
 * `readWorktree`), for a caller a worktree page owns (the role rows, the update card, the page's kill):
 * the same request (`GET /api/worktrees/:id` with the same deadline) sent through the page's gateway
 * (`fetchForHandoffPage`), so its 401 reaches the registry before it is folded into `null`. The same
 * answers as the originals; with no owner the originals themselves are called (nothing changes).
 * Kept outside `src/lib/handoff` (whose sources hold no timer but the screen client's —
 * `handoff-no-resident-4227`): the deadline here is the roles client's own.
 *
 * @module hooks/page-owned-reads
 */

import { readRunningInstances, ROLE_REQUEST_TIMEOUT_MS } from '@/lib/api-client-agent-roles';
import { fetchForHandoffPage, type HandoffPageOwner } from '@/lib/handoff/page-owner';

/** The same test as `api-client-agent-roles`' own (arrays included). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `readWorktree` of `api-client-agent-roles`, through the gateway. */
async function readWorktreeForPage(owner: HandoffPageOwner, worktreeId: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROLE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchForHandoffPage(owner, `/api/worktrees/${worktreeId}`, { signal: controller.signal });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `readRunningInstances`, owned by the page when `owner` holds a registration. */
export async function readRunningInstancesForPage(owner: HandoffPageOwner | null | undefined, worktreeId: string): Promise<Record<string, boolean> | null> {
  if (!owner?.current) return readRunningInstances(worktreeId);
  const body = await readWorktreeForPage(owner, worktreeId);
  if (!body || !isRecord(body.sessionStatusByInstance)) return null;
  const running: Record<string, boolean> = {};
  for (const [instanceId, status] of Object.entries(body.sessionStatusByInstance)) {
    if (isRecord(status) && status.isRunning === true) running[instanceId] = true;
  }
  return running;
}
