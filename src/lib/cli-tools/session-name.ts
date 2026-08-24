/**
 * tmux session naming for CLI tool instances.
 *
 * ## Issue #1984: なぜ独立したモジュールなのか
 *
 * セッション名の決め方は `BaseCLITool.getSessionName()` の中にあり、7 つの具象ツールは
 * どれもこれを override していない（実装は base の 1 本きり）。にもかかわらず
 * 「名前が欲しいだけ」の呼び出し側は `CLIToolManager.getInstance().getTool(id)` を
 * 経由するしかなく、そのために 7 ツールの実装（と、そこから伸びる tmux / child_process
 * / composer spec のグラフ）を**モジュールロード時に**引かされていた。
 *
 * `ws-server.ts` がまさにそれで、`getTool()` を呼ぶのは
 * ハンドラの中（terminal subscribe / `migrateWorktreeRooms`）だけなのに、
 * `@/lib/cli-tools/manager` を静的 import していた。実測でこの 1 辺が
 * `import('@/lib/ws-server')` の 458ms のうち 234ms を占めていた。
 *
 * 規則そのものは 1 箇所に保つ — `BaseCLITool.getSessionName()` はこの関数へ委譲する。
 */

import { deriveSessionSuffix, type CLIToolType } from './types';
import { validateSessionName } from './validation';

/**
 * Resolve the tmux session name for a (worktree, CLI tool, instance) triple.
 *
 * Format (Issue #868):
 * - Primary instance (`instanceId` omitted or `=== cliToolId`):
 *   `mcbd-{cli_tool_id}-{worktree_id}` — the backward-compatible anchor
 * - Additional instance: `mcbd-{cli_tool_id}-{worktree_id}-{suffix}`
 *
 * T2.3 (MF4-001): the result is validated to keep shell metacharacters out of
 * the tmux command line.
 *
 * @param cliToolId - CLI tool ID
 * @param worktreeId - Worktree ID
 * @param instanceId - Agent instance ID (defaults to the primary instance)
 * @returns Session name
 * @throws Error if the resulting session name is invalid
 *
 * @example
 * ```typescript
 * resolveSessionName('claude', 'wt-1');            // 'mcbd-claude-wt-1'
 * resolveSessionName('claude', 'wt-1', 'claude-2'); // 'mcbd-claude-wt-1-2'
 * ```
 */
export function resolveSessionName(
  cliToolId: CLIToolType,
  worktreeId: string,
  instanceId?: string
): string {
  const base = `mcbd-${cliToolId}-${worktreeId}`;
  if (!instanceId || instanceId === cliToolId) {
    validateSessionName(base);
    return base;
  }
  const suffix = deriveSessionSuffix(instanceId, cliToolId);
  const sessionName = suffix ? `${base}-${suffix}` : base;
  validateSessionName(sessionName);
  return sessionName;
}
