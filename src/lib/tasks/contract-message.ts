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
  SCOPE_GATE_ID,
  VERIFY_CONFIG_RELATIVE_PATH,
  WORK_EVIDENCE_GATE_ID,
  type VerifyConfig,
} from '@/lib/verification/verify-config';
import type { TaskContract } from './contract-parser';

/** How the built-in gates read in the preamble; they run git plumbing, not shell commands. */
const WORK_EVIDENCE_LABEL = `${WORK_EVIDENCE_GATE_ID}（commit または未 commit の変更が存在すること）`;
const SCOPE_LABEL = `${SCOPE_GATE_ID}（変更ファイルが scope.allow の内側に収まっていること）`;

/**
 * The gate ids a contract asks for, or null for "every gate".
 *
 * The `success` flags — not the `verify.gates` list — decide whether the built-in
 * gates run. A contract that required work evidence or a clean scope while
 * listing only `[lint, unit]` would otherwise declare rules that nothing
 * checked: the flags would read as enforced and the gates would never run.
 */
export function resolveContractGateIds(contract: TaskContract): string[] | null {
  const gates = contract.verify.gates;
  if (!gates) return null;

  const builtIns = [
    [WORK_EVIDENCE_GATE_ID, contract.success.requireWorkEvidence],
    [SCOPE_GATE_ID, contract.success.requireScopeClean],
  ] as const;

  // Built-ins are listed first and in their execution order even when the
  // contract already named one, so the resolved list reads as the order the run
  // will actually take rather than the order the contract happened to type.
  const selected = builtIns
    .filter(([id, required]) => required || gates.includes(id))
    .map(([id]) => id as string);
  const rest = gates.filter((id) => !builtIns.some(([builtIn]) => builtIn === id));

  return [...selected, ...rest];
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

  const known = new Set<string>([
    WORK_EVIDENCE_GATE_ID,
    SCOPE_GATE_ID,
    ...config.gates.map((gate) => gate.id),
  ]);
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

  const builtInLabels = new Map<string, string>([
    [WORK_EVIDENCE_GATE_ID, WORK_EVIDENCE_LABEL],
    [SCOPE_GATE_ID, SCOPE_LABEL],
  ]);

  const selected = resolveContractGateIds(contract);
  if (!selected) {
    // An omitted gates list runs every gate, and the built-ins are still governed
    // by the success flags rather than by the (absent) list.
    const builtIns = [WORK_EVIDENCE_LABEL];
    if (contract.success.requireScopeClean) builtIns.push(SCOPE_LABEL);
    return [...builtIns, ...config.gates.map((gate) => gate.command)];
  }

  const byId = new Map(config.gates.map((gate) => [gate.id, gate.command] as const));
  return selected.map((id) => builtInLabels.get(id) ?? (byId.get(id) as string));
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
