/**
 * Unit tests for contract → agent message composition (Issue #1545, Phase 2-1).
 *
 * Canonical spec: docs/design/task-contract.md §5
 *
 * The preamble must name real commands. A test that only checked "the message
 * contains the gate ids" would pass for a message that told the agent nothing
 * about what would actually be run.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  composeContractMessage,
  resolveContractGateIds,
  resolveGateCommands,
  validateContractAgainstVerifyConfig,
} from '@/lib/tasks/contract-message';
import { parseTaskContract, type TaskContract } from '@/lib/tasks/contract-parser';
import { DEFAULT_MAX_LOG_TAIL_BYTES, DEFAULT_TIMEOUT_SEC, type VerifyConfig } from '@/lib/verification/verify-config';

const CONFIG: VerifyConfig = {
  version: 1,
  gates: [
    { id: 'lint', command: 'npm run lint', timeoutSec: DEFAULT_TIMEOUT_SEC },
    { id: 'unit', command: 'npm run test:unit', timeoutSec: DEFAULT_TIMEOUT_SEC },
  ],
  options: {
    baseRef: 'origin/develop',
    skipInPrimaryCheckout: true,
    maxLogTailBytes: DEFAULT_MAX_LOG_TAIL_BYTES,
  },
};

function contract(extra = ''): TaskContract {
  return parseTaskContract(
    `version: 1
title: t
goal: |
  Implement the loader.
scope:
  allow: ["src/lib/tasks/**", "tests/unit/tasks/**"]
${extra}`,
    'task.yaml'
  );
}

describe('validateContractAgainstVerifyConfig', () => {
  it('accepts a contract that names no gates', () => {
    expect(validateContractAgainstVerifyConfig(contract(), CONFIG)).toEqual([]);
  });

  it('accepts declared gate ids and the built-in gates', () => {
    // The built-ins cannot appear in verify.yaml (RESERVED_GATE_IDS rejects
    // them), so a contract naming one has to be accepted from this list alone.
    const issues = validateContractAgainstVerifyConfig(
      contract('verify:\n  gates: [work-evidence, scope, lint]\n'),
      CONFIG
    );
    expect(issues).toEqual([]);
  });

  it('rejects a gate id that verify.yaml does not declare', () => {
    const issues = validateContractAgainstVerifyConfig(
      contract('verify:\n  gates: [lint, e2e]\n'),
      CONFIG
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('unknown gate id(s) e2e');
    expect(issues[0]).toContain('lint');
  });

  it('rejects declared gates when the worktree has no verify.yaml at all', () => {
    const issues = validateContractAgainstVerifyConfig(contract('verify:\n  gates: [lint]\n'), null);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('.commandmate/verify.yaml');
    expect(issues[0]).toContain('cannot be resolved');
  });

  it('accepts a gate-less contract even without verify.yaml (scope-only contracts)', () => {
    expect(validateContractAgainstVerifyConfig(contract(), null)).toEqual([]);
  });
});

describe('resolveContractGateIds', () => {
  it('returns null for a contract that names no gates', () => {
    expect(resolveContractGateIds(contract())).toBeNull();
  });

  it('adds the built-in gates when the contract requires them but forgot to list them', () => {
    // A contract that says requireWorkEvidence / requireScopeClean while listing
    // only [lint] would otherwise declare rules no gate checks.
    expect(resolveContractGateIds(contract('verify:\n  gates: [lint]\n'))).toEqual([
      'work-evidence',
      'scope',
      'lint',
    ]);
  });

  it('does not duplicate a built-in gate the contract already lists', () => {
    expect(
      resolveContractGateIds(contract('verify:\n  gates: [work-evidence, lint]\n'))
    ).toEqual(['work-evidence', 'scope', 'lint']);
  });

  it('lists the built-in gates in execution order, not in the order the contract typed them', () => {
    // The list is what resolveGateCommands turns into "the commands that will
    // run, in order", so a contract's typing order must not misreport the run.
    expect(
      resolveContractGateIds(contract('verify:\n  gates: [lint, scope, work-evidence]\n'))
    ).toEqual(['work-evidence', 'scope', 'lint']);
  });

  it('keeps a built-in the contract listed even when its success flag is off', () => {
    expect(
      resolveContractGateIds(
        contract('verify:\n  gates: [scope, lint]\nsuccess:\n  requireWorkEvidence: false\n')
      )
    ).toEqual(['scope', 'lint']);
  });

  it('leaves the list alone when neither built-in gate is required', () => {
    expect(
      resolveContractGateIds(
        contract(
          'verify:\n  gates: [lint]\nsuccess:\n  requireWorkEvidence: false\n  requireScopeClean: false\n'
        )
      )
    ).toEqual(['lint']);
  });

  it('adds only the built-in gate whose flag is set', () => {
    expect(
      resolveContractGateIds(
        contract('verify:\n  gates: [lint]\nsuccess:\n  requireWorkEvidence: false\n')
      )
    ).toEqual(['scope', 'lint']);
    expect(
      resolveContractGateIds(
        contract('verify:\n  gates: [lint]\nsuccess:\n  requireScopeClean: false\n')
      )
    ).toEqual(['work-evidence', 'lint']);
  });
});

describe('resolveGateCommands', () => {
  it('expands the selected gate ids into their commands, in the declared order', () => {
    expect(
      resolveGateCommands(
        contract(
          'verify:\n  gates: [unit, lint]\nsuccess:\n  requireWorkEvidence: false\n  requireScopeClean: false\n'
        ),
        CONFIG
      )
    ).toEqual(['npm run test:unit', 'npm run lint']);
  });

  it('expands an omitted gates list into the built-in gates plus every gate', () => {
    const commands = resolveGateCommands(contract(), CONFIG);
    expect(commands[0]).toContain('work-evidence');
    expect(commands[1]).toContain('scope');
    expect(commands.slice(2)).toEqual(['npm run lint', 'npm run test:unit']);
  });

  it('names the required built-in gates even when the contract omitted them', () => {
    const commands = resolveGateCommands(contract('verify:\n  gates: [lint]\n'), CONFIG);
    expect(commands[0]).toContain('work-evidence');
    expect(commands[1]).toContain('scope');
    expect(commands[2]).toBe('npm run lint');
  });

  it('leaves the scope gate unnamed when the contract does not require a clean scope', () => {
    // Naming a gate that will skip would tell the agent a completion criterion
    // the run does not apply.
    const commands = resolveGateCommands(
      contract('success:\n  requireScopeClean: false\n'),
      CONFIG
    );
    expect(commands.some((command) => command.includes('scope'))).toBe(false);
    expect(commands.slice(1)).toEqual(['npm run lint', 'npm run test:unit']);
  });
});

describe('composeContractMessage', () => {
  it('states the allowed paths, the commit obligation, the real commands, then the goal', () => {
    const message = composeContractMessage(contract('verify:\n  gates: [lint]\n'), CONFIG);

    expect(message).toContain('## 実行契約');
    expect(message).toContain('- 変更してよいのは次のパスのみ: src/lib/tasks/**, tests/unit/tasks/**');
    expect(message).toContain('必ず commit');
    expect(message).toContain('npm run lint');
    expect(message).toContain('## タスク\nImplement the loader.');
    // The goal must come last: everything above it is the frame it is read in.
    expect(message.indexOf('## 実行契約')).toBeLessThan(message.indexOf('## タスク'));
  });

  it('omits the deny line when the contract declares no deny patterns', () => {
    expect(composeContractMessage(contract(), CONFIG)).not.toContain('変更してはならないパス');
  });

  it('states the deny paths when they are declared', () => {
    const withDeny = parseTaskContract(
      `version: 1
title: t
goal: g
scope:
  allow: ["src/**"]
  deny: ["src/generated/**"]
`,
      'task.yaml'
    );
    expect(composeContractMessage(withDeny, CONFIG)).toContain(
      '- 変更してはならないパス: src/generated/**'
    );
  });

  it('says the path restriction is absent rather than pretending there is one', () => {
    const unscoped = parseTaskContract(
      'version: 1\ntitle: t\ngoal: g\nsuccess:\n  requireScopeClean: false\n',
      'task.yaml'
    );
    const message = composeContractMessage(unscoped, CONFIG);
    expect(message).toContain('- 変更パスの制限: なし');
    expect(message).not.toContain('変更してよいのは次のパスのみ');
  });

  it('does not claim a completion criterion when the repository declares no gates', () => {
    const message = composeContractMessage(contract(), null);
    expect(message).toContain('検証ゲートが宣言されていない');
    expect(message).not.toContain('次の検証コマンドがすべて成功すること');
  });
});
