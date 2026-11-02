/**
 * Where the `respond` a server-side guidance sentence names has to go
 * (Issue #4049).
 *
 * #4031 gave the PROMPT_WAITING refusal and the structured-dialog question a
 * ` --instance <id>` when the request named an instance. A request that named
 * only a tool (`send … --agent codex`) still got a bare `commandmate respond
 * <id> <answer>`, and the CLI resolves a bare `respond` to the worktree's
 * default tool — so the answer could reach a different agent than the one that
 * is waiting.
 *
 * Type-only imports and string building, like `structured-prompt`, so the
 * client bundle that reads that module can read this one too.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * The flags that aim a `respond` (or `send`) at the waiting session, by the
 * CLI's own order (`targetFlags` in `src/cli/utils/follow-up-command.ts`): an
 * instance first, else a tool, else nothing — the sentence as it was before.
 *
 * @param instanceId - The instance the request named, if any
 * @param agent - The tool to name when no instance was named (see {@link respondAgentFor})
 */
export function respondTargetFlags(instanceId?: string, agent?: CLIToolType): string {
  if (instanceId) return ` --instance ${instanceId}`;
  if (agent) return ` --agent ${agent}`;
  return '';
}

/**
 * The tool a guidance `respond` must name, or undefined when a bare one already
 * reaches the waiting session.
 *
 * Only a request that named a tool explicitly and no instance gets one, and
 * only when that tool is not what an unqualified request resolves to (the
 * worktree default): `--agent claude` on a claude worktree, and a request that
 * named nothing, keep the sentence they had (#4031's "primary and default are
 * unchanged").
 *
 * @param requestedCliTool - The tool the request named explicitly, if any
 * @param instanceId - The instance the request named, if any
 * @param unqualifiedCliTool - The tool a request naming nothing resolves to
 */
export function respondAgentFor(
  requestedCliTool: CLIToolType | undefined,
  instanceId: string | undefined,
  unqualifiedCliTool: CLIToolType | undefined,
): CLIToolType | undefined {
  if (instanceId || !requestedCliTool) return undefined;
  return requestedCliTool === unqualifiedCliTool ? undefined : requestedCliTool;
}

/**
 * Why `send` stops at the plan review overlay (Issue #3125).
 *
 * The overlay replaces the composer until a human decides, so waiting for the
 * composer only ran out the clock (`prompt not ready` after the full timeout).
 * Its comments, Submit review, approval and cancel go through `respond`.
 *
 * Issue #4049: a function, not a constant. The constant named a
 * `<worktree-id>` placeholder and no instance, so on `command-code-2` the
 * `respond` it showed went to the primary instance. The primary instance
 * (no id, or the tool's own id — #868) gets no `--instance`.
 *
 * Issue #4063: and the tool, by {@link respondTargetFlags}' rule, when the
 * request named Command Code on a worktree whose default is another tool
 * ({@link respondAgentFor}). `CommandCodeTool.sendMessage` does not know the
 * request, so the routes (send, terminal) rebuild the sentence with the `agent`
 * they resolved; the tool's own throw leaves it out. Kept here, with no import
 * beyond types, so those routes do not load the tool module.
 *
 * @param worktreeId - The worktree whose session is showing the review
 * @param instanceId - The instance the send was for, if any
 * @param agent - The tool the `respond` must name when no instance is (see `respondAgentFor`)
 */
export function commandCodePlanReviewSendMessage(
  worktreeId: string,
  instanceId?: string,
  agent?: CLIToolType,
): string {
  const target = respondTargetFlags(instanceId && instanceId !== 'command-code' ? instanceId : undefined, agent);
  return (
    'Command Code is showing a plan review (REVIEW), which takes review comments, not messages. ' +
    `Comment with \`commandmate respond ${worktreeId} "<text>"${target}\`, then \`--plan-review submit\` (ctrl+r), ` +
    '`--plan-review approve` (ctrl+a) or `--plan-review cancel` (esc).'
  );
}
