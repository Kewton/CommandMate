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
  type VerifyGate,
} from '@/lib/verification/verify-config';
import type { TaskContract } from './contract-parser';

/**
 * How the built-in gates read in the preamble; they run git plumbing, not shell
 * commands.
 *
 * work-evidence has two readings because it has two behaviours. Leaving it on
 * the permissive wording while `requireCommit` is in force would tell the agent
 * a criterion the run does not apply — and stating the strict wording while it
 * is not in force is the D-4 defect (#1628) this Issue closes.
 */
const WORK_EVIDENCE_ANY_CHANGE_LABEL = `${WORK_EVIDENCE_GATE_ID}（commit または未 commit の変更が存在すること）`;
const WORK_EVIDENCE_COMMIT_LABEL = `${WORK_EVIDENCE_GATE_ID}（commit が存在すること。未 commit の変更は作業証跡として数えない）`;
const SCOPE_LABEL = `${SCOPE_GATE_ID}（変更ファイルが scope.allow の内側に収まっていること）`;

/** The obligation line, in the two forms the pipeline can actually enforce. */
const COMMIT_REQUIRED_LINE =
  '- 作業完了後は必ず commit すること（未 commit の作業は未完了とみなされる）';
const COMMIT_EXPECTED_LINE =
  '- 作業完了後は commit すること（ただし work-evidence は未 commit の変更も作業証跡として' +
  '認めるため、commit の有無そのものは検査されない）';

/** Named so a failing gate can say which declaration put it there. */
export const REQUIRE_COMMIT_SOURCE_CONFIG = `options.requireCommit (${VERIFY_CONFIG_RELATIVE_PATH})`;
export const REQUIRE_COMMIT_SOURCE_CONTRACT = 'success.requireCommit (task contract)';

/** Whether a commit is required, and which declaration(s) said so. */
export interface RequireCommitDecision {
  required: boolean;
  /** Empty when nothing required it; both entries when both did. */
  sources: string[];
}

/**
 * Combine the repository-wide and per-delegation commit requirements (#1642).
 *
 * OR, deliberately, rather than "the nearer declaration wins". The whole point
 * of the contract-side flag is to stop a rule from being declared and never
 * checked; letting a contract answer `false` to a repository that answered
 * `true` would reopen exactly that hole one delegation at a time. A contract can
 * only ever tighten.
 *
 * Lives here rather than in gate-runner because both callers need the same
 * answer: this module writes the sentence the agent reads, gate-runner reaches
 * the verdict, and the two disagreeing is the defect being fixed.
 */
export function resolveRequireCommit(
  contract: TaskContract | null,
  config: VerifyConfig | null
): RequireCommitDecision {
  const sources: string[] = [];
  if (config?.options.requireCommit) sources.push(REQUIRE_COMMIT_SOURCE_CONFIG);
  if (contract?.success.requireCommit) sources.push(REQUIRE_COMMIT_SOURCE_CONTRACT);
  return { required: sources.length > 0, sources };
}

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
 * The gates this contract defines itself (#1791).
 *
 * Read through a helper because `contract` also arrives from
 * `tasks.contract_json`, and a row written before the field existed parses back
 * as `undefined` rather than an empty list. Every consumer reads it here so
 * "an old task" and "a task that defines no gates" cannot behave differently.
 */
export function contractGateDefinitions(contract: TaskContract): VerifyGate[] {
  return contract.verify.gateDefinitions ?? [];
}

/**
 * Check that the contract's gates can actually be resolved, and that its own
 * definitions do not collide with the repository's.
 *
 * A contract pointing at a gate id that does not exist would only be caught at
 * verification time, by which point the agent has already been told a
 * completion criterion that cannot be evaluated. Reporting it here makes
 * "the contract was accepted" and "the contract's gates exist" the same moment.
 *
 * The collision check is the same discipline pointed the other way (#1791). A
 * contract that redefined an id `.commandmate/verify.yaml` already declares
 * would replace the repository's own definition of passing with one written per
 * delegation — silently, since both spell the same id in the report. Reserved
 * ids (`work-evidence` / `scope` / `env-clean`) are refused one step earlier, by
 * the shared gate validator in the parser; both refusals happen at send.
 *
 * @returns issue strings, empty when the contract resolves cleanly
 */
export function validateContractAgainstVerifyConfig(
  contract: TaskContract,
  config: VerifyConfig | null
): string[] {
  const gates = contract.verify.gates;
  const definitions = contractGateDefinitions(contract);
  const issues: string[] = [];

  if (!config) {
    // Fail-closed for definitions too: the runner refuses to start a run at all
    // without a config, so accepting the contract would promise a criterion that
    // can never be evaluated — the exact thing this function exists to prevent.
    if (definitions.length > 0) {
      issues.push(
        `verify.gateDefinitions: declared ${definitions.map((gate) => gate.id).join(', ')}, ` +
          `but ${VERIFY_CONFIG_RELATIVE_PATH} is missing or unreadable in this worktree, ` +
          'so no verification run can execute them'
      );
    }
    if (gates) {
      issues.push(
        `verify.gates: declared ${gates.join(', ')}, but ${VERIFY_CONFIG_RELATIVE_PATH} ` +
          'is missing or unreadable in this worktree, so the gate ids cannot be resolved'
      );
    }
    return issues;
  }

  const configIds = config.gates.map((gate) => gate.id);
  const collisions = definitions
    .map((gate) => gate.id)
    .filter((id) => configIds.includes(id));
  if (collisions.length > 0) {
    issues.push(
      `verify.gateDefinitions: gate id(s) ${collisions.join(', ')} are already declared in ` +
        `${VERIFY_CONFIG_RELATIVE_PATH}. A contract may add gates, never redefine the ` +
        "repository's own — rename the contract gate."
    );
  }

  if (gates) {
    const known = new Set<string>([WORK_EVIDENCE_GATE_ID, SCOPE_GATE_ID, ...configIds]);
    const defined = new Set(definitions.map((gate) => gate.id));
    const unknown = gates.filter((id) => !known.has(id) && !defined.has(id));
    if (unknown.length > 0) {
      const sources = [`Declared in ${VERIFY_CONFIG_RELATIVE_PATH}: ${[...known].join(', ')}`];
      if (defined.size > 0) {
        sources.push(`in verify.gateDefinitions: ${[...defined].join(', ')}`);
      }
      issues.push(`verify.gates: unknown gate id(s) ${unknown.join(', ')}. ${sources.join('; ')}`);
    }
  }

  return issues;
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

  const workEvidenceLabel = resolveRequireCommit(contract, config).required
    ? WORK_EVIDENCE_COMMIT_LABEL
    : WORK_EVIDENCE_ANY_CHANGE_LABEL;
  const builtInLabels = new Map<string, string>([
    [WORK_EVIDENCE_GATE_ID, workEvidenceLabel],
    [SCOPE_GATE_ID, SCOPE_LABEL],
  ]);

  // Contract-defined gates run after the repository's own, so the preamble
  // lists them in that order too — the line claims to be "the commands that
  // will run", and an order it invents would be the first thing to drift.
  const declared = [...config.gates, ...contractGateDefinitions(contract)];

  const selected = resolveContractGateIds(contract);
  if (!selected) {
    // An omitted gates list runs every gate, and the built-ins are still governed
    // by the success flags rather than by the (absent) list.
    const builtIns = [workEvidenceLabel];
    if (contract.success.requireScopeClean) builtIns.push(SCOPE_LABEL);
    return [...builtIns, ...declared.map((gate) => gate.command)];
  }

  const byId = new Map(declared.map((gate) => [gate.id, gate.command] as const));
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

  // The sentence follows the verdict, never the other way round: this line used
  // to be a constant asserting "未 commit の作業は未完了とみなされる" while the
  // gate passed on an uncommitted change alone (#1628 D-4, measured in the
  // Epic #1585 acceptance run).
  lines.push(
    resolveRequireCommit(contract, config).required ? COMMIT_REQUIRED_LINE : COMMIT_EXPECTED_LINE
  );

  const commands = resolveGateCommands(contract, config);
  lines.push(
    commands.length > 0
      ? `- 完了条件: 次の検証コマンドがすべて成功すること: ${commands.join(' / ')}`
      : `- 完了条件: ${VERIFY_CONFIG_RELATIVE_PATH} に検証ゲートが宣言されていないため、検証コマンドは無い`
  );

  return `${lines.join('\n')}\n\n## タスク\n${contract.goal}`;
}
