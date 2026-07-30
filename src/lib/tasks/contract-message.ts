/**
 * Turn an execution contract into the message the agent actually receives, and
 * cross-check it against the repository's verify.yaml (Issue #1545, Phase 2-1).
 *
 * Canonical spec: docs/design/task-contract.md §5
 *
 * The preamble spells the completion criterion out as the *real commands* the
 * gates will run. A gate id alone tells the agent nothing about what will be
 * executed, so a contract sent that way declares a criterion the recipient
 * cannot evaluate.
 *
 * Server-only: consumes a loaded VerifyConfig.
 *
 * @module lib/tasks/contract-message
 */

import {
  VERIFY_CONFIG_RELATIVE_PATH,
  WORK_EVIDENCE_GATE_ID,
  type VerifyConfig,
} from '@/lib/verification/verify-config';
import type { TaskContract } from './contract-parser';

/** How the built-in gate reads in the preamble; it runs git plumbing, not a shell command. */
const WORK_EVIDENCE_LABEL = `${WORK_EVIDENCE_GATE_ID}（commit または未 commit の変更が存在すること）`;

/**
 * The gate ids a contract asks for, or null for "every gate".
 *
 * `success.requireWorkEvidence` — not the `verify.gates` list — decides whether
 * the built-in work-evidence gate runs. A contract that required work evidence
 * while listing only `[lint, unit]` would otherwise declare a rule that nothing
 * checked: the flag would read as enforced and the gate would never run.
 */
export function resolveContractGateIds(contract: TaskContract): string[] | null {
  const gates = contract.verify.gates;
  if (!gates) return null;
  if (!contract.success.requireWorkEvidence || gates.includes(WORK_EVIDENCE_GATE_ID)) {
    return gates;
  }
  return [WORK_EVIDENCE_GATE_ID, ...gates];
}

/**
 * Check that every gate the contract names can actually be resolved.
 *
 * A contract pointing at a gate id that does not exist would only be caught at
 * verification time, by which point the agent has already been told a
 * completion criterion that cannot be evaluated. Reporting it here makes
 * "the contract was accepted" and "the contract's gates exist" the same moment.
 *
 * @returns issue strings, empty when the contract resolves cleanly
 */
export function validateContractAgainstVerifyConfig(
  contract: TaskContract,
  config: VerifyConfig | null
): string[] {
  const gates = contract.verify.gates;
  if (!gates) return [];

  if (!config) {
    return [
      `verify.gates: declared ${gates.join(', ')}, but ${VERIFY_CONFIG_RELATIVE_PATH} ` +
        'is missing or unreadable in this worktree, so the gate ids cannot be resolved',
    ];
  }

  const known = new Set<string>([WORK_EVIDENCE_GATE_ID, ...config.gates.map((gate) => gate.id)]);
  const unknown = gates.filter((id) => !known.has(id));
  if (unknown.length === 0) return [];

  return [
    `verify.gates: unknown gate id(s) ${unknown.join(', ')}. ` +
      `Declared in ${VERIFY_CONFIG_RELATIVE_PATH}: ${[...known].join(', ')}`,
  ];
}

/**
 * The commands the contract's gates will run, in the order they will run.
 *
 * Only ever called after {@link validateContractAgainstVerifyConfig} has
 * accepted the contract, so an unresolvable id cannot reach here.
 */
export function resolveGateCommands(
  contract: TaskContract,
  config: VerifyConfig | null
): string[] {
  if (!config) return [];

  const selected = resolveContractGateIds(contract);
  if (!selected) {
    return [WORK_EVIDENCE_LABEL, ...config.gates.map((gate) => gate.command)];
  }

  const byId = new Map(config.gates.map((gate) => [gate.id, gate.command] as const));
  return selected.map((id) =>
    id === WORK_EVIDENCE_GATE_ID ? WORK_EVIDENCE_LABEL : (byId.get(id) as string)
  );
}

/**
 * Compose the message sent to the agent: contract preamble, then the goal.
 *
 * Every line states an obligation the pipeline can later check, so the agent is
 * not asked to infer the rules from the goal text.
 */
export function composeContractMessage(
  contract: TaskContract,
  config: VerifyConfig | null
): string {
  const lines: string[] = ['## 実行契約'];

  lines.push(
    contract.scope.allow.length > 0
      ? `- 変更してよいのは次のパスのみ: ${contract.scope.allow.join(', ')}`
      : '- 変更パスの制限: なし（scope.allow が未宣言）'
  );
  if (contract.scope.deny.length > 0) {
    lines.push(`- 変更してはならないパス: ${contract.scope.deny.join(', ')}`);
  }

  lines.push('- 作業完了後は必ず commit すること（未 commit の作業は未完了とみなされる）');

  const commands = resolveGateCommands(contract, config);
  lines.push(
    commands.length > 0
      ? `- 完了条件: 次の検証コマンドがすべて成功すること: ${commands.join(' / ')}`
      : `- 完了条件: ${VERIFY_CONFIG_RELATIVE_PATH} に検証ゲートが宣言されていないため、検証コマンドは無い`
  );

  return `${lines.join('\n')}\n\n## タスク\n${contract.goal}`;
}
