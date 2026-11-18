/**
 * Which tools agent-health may check, under the tool policy (Issue #4436).
 *
 * agent-health is an unattended run — a Schedule starts `daily.sh`, which starts
 * `run.ts` — so it is the `schedule` operation of `src/lib/tool-policy/policy.ts`.
 * Under the default usage declaration (`personal`) that refuses antigravity:
 *
 * - the default `--tools` (none given) leaves it out, so no probe runs and
 *   `agy --version` is not read either; the run still counts as the daily run
 *   (all probed tools selected), so the version-only rows are read as before;
 * - an explicit `--tools` naming it is refused as an argument error (exit 2),
 *   with the reason code and the FAQ link in the report.
 *
 * `CM_ANTIGRAVITY_USAGE=api-key|enterprise` in the environment of the run lifts
 * both, as it does on the server. Pure: the declaration is an argument.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { AgentHealthTool } from '@/lib/agent-health/types';
import {
  decideToolPolicy,
  TOOL_POLICY_DENIED_MESSAGE,
  USAGE_DECLARATION_ENV,
  type ToolPolicyDecision,
  type UsageDeclaration,
} from '@/lib/tool-policy/policy';

/** The tools to probe, and the ones the policy took out of the default list. */
export type AgentHealthToolSelection =
  | { ok: true; tools: AgentHealthTool[]; refused: AgentHealthTool[] }
  | { ok: false; error: string };

/** Whether `argv` names `--tools` itself (`--tools x` or `--tools=x`). */
function namesTools(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--tools' || arg.startsWith('--tools='));
}

/** The policy's answer for one agent-health tool (a `schedule` run). */
export function decideAgentHealthTool(tool: AgentHealthTool, declaration: UsageDeclaration): ToolPolicyDecision {
  // Every agent-health tool is a CLI tool id; this assignment fails the build if not.
  const cliToolId: CLIToolType = tool;
  return decideToolPolicy({ tool: cliToolId, operation: 'schedule', origin: 'schedule', declaration });
}

/** Why a tool was refused (code, reason, how to lift it, the FAQ); empty when allowed. */
export function describeAgentHealthRefusal(decision: ToolPolicyDecision): string {
  if (decision.allowed) return '';
  return (
    `${decision.code} (${decision.reason}) — ${TOOL_POLICY_DENIED_MESSAGE} ` +
    `Set ${USAGE_DECLARATION_ENV}=api-key (or enterprise) only if you use an API key or an enterprise plan. ` +
    `FAQ: ${decision.links.faq}`
  );
}

/**
 * Apply the policy to the parsed `--tools`.
 *
 * @param argv - The arguments as given (to tell the default from an explicit list)
 * @param tools - `parseAgentHealthArgs(argv).options.tools`
 * @param declaration - The usage declaration (`readUsageDeclaration()`)
 */
export function selectAgentHealthTools(
  argv: readonly string[],
  tools: readonly AgentHealthTool[],
  declaration: UsageDeclaration
): AgentHealthToolSelection {
  const refusals = tools
    .map((tool) => ({ tool, decision: decideAgentHealthTool(tool, declaration) }))
    .filter(({ decision }) => !decision.allowed);
  if (refusals.length === 0) return { ok: true, tools: [...tools], refused: [] };

  if (namesTools(argv)) {
    return {
      ok: false,
      error: `--tools: ${refusals.map(({ tool, decision }) => `${tool}: ${describeAgentHealthRefusal(decision)}`).join(' / ')}`,
    };
  }
  const refused = refusals.map(({ tool }) => tool);
  return { ok: true, tools: tools.filter((tool) => !refused.includes(tool)), refused };
}
