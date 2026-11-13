/**
 * Issue #4227 G10 (design `mem-ui-4227.md` §4.1.1): the store's live opening a page of a worktree
 * takes back — this worktree's own (with or without a unit), or another worktree's while it holds a
 * decide being sent or unknown. Another worktree's opening without a unit is not taken (its stop or
 * cancel ends by its own answer).
 *
 * Issue #4317 PR2: one condition for two readers — the page's first render and its effect
 * (`useWorktreeDetailController`), and the host beside the shell (`HandoffDialogHost`) while no page
 * of the route is registered (the route's Loading): the host keeps drawing exactly what the page
 * will take back, and nothing it will not.
 *
 * Reads the store only (no writer of `@/lib/handoff/close-rule` is imported). The CLI tool's check is
 * the caller's (`isTool`, `isCliToolType`): `src/lib/handoff/**` loads nothing of the CLI tools (the
 * guard `handoff-no-kill-4227`).
 *
 * @module lib/handoff/take-back
 */

import { handoffStoreSnapshot, handoffUnitsOf, type HandoffOpeningToken, type HandoffStoreState } from '@/lib/handoff/close-rule';

export interface HandoffTakeBack<Tool extends string> {
  /** The worktree the opening was opened for (another's: shown as foreign). */
  readonly worktreeId: string;
  readonly target: { cliToolId: Tool; instanceId: string; label: string };
  readonly token: HandoffOpeningToken;
}

export function handoffTakeBackOf<Tool extends string>(
  worktreeId: string,
  isTool: (cliToolId: string) => cliToolId is Tool,
  snapshot: HandoffStoreState = handoffStoreSnapshot()
): HandoffTakeBack<Tool> | null {
  const live = snapshot.opening;
  if (live === null || live.closed) return null;
  const liveTool = live.target.cliToolId;
  if (liveTool === undefined || !isTool(liveTool)) return null;
  if (live.worktreeId !== worktreeId) {
    const units = snapshot.units[live.worktreeId] ?? handoffUnitsOf(live.worktreeId);
    if (units.inflight === null && units.pending === null) return null;
  }
  return { worktreeId: live.worktreeId, target: { ...live.target, cliToolId: liveTool }, token: live.token };
}
