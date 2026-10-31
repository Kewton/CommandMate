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
