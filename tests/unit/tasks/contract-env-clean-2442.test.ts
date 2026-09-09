/**
 * Issue #2442: `env-clean` becomes reachable from a task contract.
 *
 * Canonical spec: docs/design/task-contract.md §2.6
 *
 * #1740 built the gate and wired it to `options.requireEnvClean` in verify.yaml,
 * but left three seams closed because the files were outside that delegation's
 * scope: the parser rejected `success.requireEnvClean` as an unknown key, the
 * send-time cross-check rejected `verify.gates: [env-clean]` as an unknown id,
 * and — the one that would have been easy to open badly — the route that records
 * the baseline read only the two booleans. Opening the gate id without the third
 * would have produced a gate that runs against a baseline nobody wrote: UNKNOWN
 * on every delegation that used it, forever.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_GATE_ORDER,
  composeContractMessage,
  resolveContractGateIds,
  resolveGateCommands,
  runsEnvCleanGate,
  validateContractAgainstVerifyConfig,
} from '@/lib/tasks/contract-message';
import { parseTaskContract, TaskContractError } from '@/lib/tasks/contract-parser';
import {
  resolveRequireEnvClean,
  REQUIRE_ENV_CLEAN_SOURCE_CONFIG,
  REQUIRE_ENV_CLEAN_SOURCE_CONTRACT,
} from '@/lib/verification/env-clean-gate';
import {
  DEFAULT_MAX_LOG_TAIL_BYTES,
  DEFAULT_TIMEOUT_SEC,
  ENV_CLEAN_GATE_ID,
  SCOPE_GATE_ID,
  WORK_EVIDENCE_GATE_ID,
  type VerifyConfig,
} from '@/lib/verification/verify-config';

const MINIMAL = `version: 1
title: t
goal: |
  Do the work.
scope:
  allow: ["src/**"]
`;

function contract(extra = '') {
  return parseTaskContract(`${MINIMAL}${extra}`, 'task.yaml');
}

function config(requireEnvClean: boolean): VerifyConfig {
  return {
    version: 1,
    gates: [
      { id: 'lint', command: 'npm run lint', timeoutSec: DEFAULT_TIMEOUT_SEC },
      { id: 'unit', command: 'npm run test:unit', timeoutSec: DEFAULT_TIMEOUT_SEC },
    ],
    options: {
      baseRef: 'origin/develop',
      skipInPrimaryCheckout: true,
      maxLogTailBytes: DEFAULT_MAX_LOG_TAIL_BYTES,
      requireCommit: false,
      requireEnvClean,
    },
  };
}

const CONFIG_OFF = config(false);
const CONFIG_ON = config(true);

function issuesFor(source: string): string[] {
  try {
    parseTaskContract(source, 'task.yaml');
    return [];
  } catch (error) {
    if (error instanceof TaskContractError) return error.issues;
    throw error;
  }
}

// =============================================================================
// The parser
// =============================================================================

describe('success.requireEnvClean — parsing', () => {
  it('defaults to false when omitted', () => {
    // The default has to be inert: with both declarations off, #1740's design
    // promises no gate row, no probe and no baseline file. A default of true would
    // change the verdict of every contract written before this key existed.
    expect(contract().success.requireEnvClean).toBe(false);
  });

  it('defaults to false even when the success block exists but says nothing', () => {
    expect(contract('success:\n  requireCommit: false\n').success.requireEnvClean).toBe(false);
  });

  it.each([['true'], ['"true"']])('accepts %s', (literal) => {
    expect(
      contract(`success:\n  requireEnvClean: ${literal}\n`).success.requireEnvClean
    ).toBe(true);
  });

  it.each([['false'], ['"false"']])('accepts %s', (literal) => {
    expect(
      contract(`success:\n  requireEnvClean: ${literal}\n`).success.requireEnvClean
    ).toBe(false);
  });

  it.each([
    ['yes', 'a truthy-looking string'],
    ['1', 'a number'],
    ['"on"', 'a quoted word'],
    ['[]', 'a list'],
    ['{}', 'a mapping'],
  ])('rejects %s (%s) instead of coercing it', (literal) => {
    // Coercion is the failure this parser exists to prevent: a contract that
    // *looks* like it asked for the gate and silently did not is worse than one
    // that was refused at send.
    const issues = issuesFor(`${MINIMAL}success:\n  requireEnvClean: ${literal}\n`);

    expect(issues.some((issue) => issue.startsWith('success.requireEnvClean:'))).toBe(true);
    expect(issues.join('\n')).toContain('must be true or false');
  });

  it('rejects null rather than reading it as "unset"', () => {
    // `requireEnvClean:` with no value parses as null. Accepting it as the default
    // would make a truncated edit indistinguishable from a deliberate omission —
    // but here it is a value that was typed, so it has to be a boolean.
    expect(issuesFor(`${MINIMAL}success:\n  requireEnvClean:\n`)).toEqual([
      'success.requireEnvClean: must be true or false (got null)',
    ]);
  });

  it('keeps the unknown-key check strict around the new key', () => {
    // A misspelling must not parse as "the gate is off", which is exactly what an
    // ignore-unknown-keys parser would do.
    const issues = issuesFor(`${MINIMAL}success:\n  requireEnvCleanup: true\n`);

    expect(issues.join('\n')).toContain('requireEnvCleanup');
  });

  it('does not disturb its siblings', () => {
    const success = contract(
      'success:\n  requireEnvClean: true\n  requireCommit: true\n  autoVerifyOnStop: true\n'
    ).success;

    expect(success).toEqual({
      requireWorkEvidence: true,
      requireScopeClean: true,
      requireCommit: true,
      requireEnvClean: true,
      autoVerifyOnStop: true,
    });
  });
});

// =============================================================================
// OR resolution
// =============================================================================

describe('repository option OR contract success', () => {
  it.each([
    [false, false, false, []],
    [true, false, true, [REQUIRE_ENV_CLEAN_SOURCE_CONFIG]],
    [false, true, true, [REQUIRE_ENV_CLEAN_SOURCE_CONTRACT]],
    [
      true,
      true,
      true,
      [REQUIRE_ENV_CLEAN_SOURCE_CONFIG, REQUIRE_ENV_CLEAN_SOURCE_CONTRACT],
    ],
  ])(
    'config=%s contract=%s -> required=%s',
    (repositoryOn, contractOn, required, sources) => {
      const decision = resolveRequireEnvClean(
        contract(`success:\n  requireEnvClean: ${contractOn}\n`),
        repositoryOn ? CONFIG_ON : CONFIG_OFF
      );

      expect(decision.required).toBe(required);
      expect(decision.sources).toEqual(sources);
    }
  );

  it('cannot be switched off by a contract that answers false', () => {
    // The whole point of the per-delegation flag is that a rule cannot be
    // declared and then quietly unenforced. A contract may only ever tighten —
    // the same trade `requireCommit` makes.
    const decision = resolveRequireEnvClean(
      contract('success:\n  requireEnvClean: false\n'),
      CONFIG_ON
    );

    expect(decision.required).toBe(true);
    expect(decision.sources).toEqual([REQUIRE_ENV_CLEAN_SOURCE_CONFIG]);
  });

  it('reads a contract row written before the key existed as off', () => {
    // `tasks.contract_json` rows predate the field; they parse back with it
    // absent, and must behave exactly like `false`.
    const legacy = { ...contract(), success: { ...contract().success } } as Record<string, unknown>;
    delete (legacy.success as Record<string, unknown>).requireEnvClean;

    expect(
      resolveRequireEnvClean(legacy as unknown as ReturnType<typeof contract>, CONFIG_OFF).required
    ).toBe(false);
  });
});

// =============================================================================
// verify.gates: [env-clean]
// =============================================================================

describe('verify.gates may name env-clean', () => {
  it('accepts it against a config that cannot possibly declare it', () => {
    // `env-clean` is a reserved id, so it never appears in verify.yaml's gate
    // list. Leaving it out of the known set is what made it an unknown id.
    expect(
      validateContractAgainstVerifyConfig(
        contract('verify:\n  gates: [env-clean, lint]\n'),
        CONFIG_OFF
      )
    ).toEqual([]);
  });

  it('lists it as a resolvable id in the error for a genuinely unknown one', () => {
    const issues = validateContractAgainstVerifyConfig(
      contract('verify:\n  gates: [env-clea]\n'),
      CONFIG_OFF
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('unknown gate id(s) env-clea');
    expect(issues[0]).toContain(ENV_CLEAN_GATE_ID);
  });

  it('still refuses a contract that tries to REDEFINE the built-in', () => {
    // Selecting the built-in and replacing it are different asks. A contract that
    // supplied its own command for `env-clean` would replace the repository's
    // definition of passing, silently, since both spell the same id in the report.
    const issues = issuesFor(
      `${MINIMAL}verify:\n  gateDefinitions:\n    - id: env-clean\n      command: "true"\n`
    );

    expect(issues.join('\n')).toContain('env-clean');
  });

  it('orders the resolved ids the way the run will execute them', () => {
    // The preamble presents this list as "the commands that will run", so a
    // contract that typed `[lint, env-clean]` must not be handed that order back.
    expect(
      resolveContractGateIds(contract('verify:\n  gates: [lint, env-clean, unit]\n'))
    ).toEqual([WORK_EVIDENCE_GATE_ID, SCOPE_GATE_ID, ENV_CLEAN_GATE_ID, 'lint', 'unit']);
  });

  it('adds the gate from the success flag alone, without it being listed', () => {
    expect(
      resolveContractGateIds(
        contract('verify:\n  gates: [lint]\nsuccess:\n  requireEnvClean: true\n')
      )
    ).toEqual([WORK_EVIDENCE_GATE_ID, SCOPE_GATE_ID, ENV_CLEAN_GATE_ID, 'lint']);
  });

  it('leaves it out when nothing asked for it', () => {
    expect(resolveContractGateIds(contract('verify:\n  gates: [lint]\n'))).toEqual([
      WORK_EVIDENCE_GATE_ID,
      SCOPE_GATE_ID,
      'lint',
    ]);
  });

  it('states the built-in execution order once', () => {
    expect(BUILT_IN_GATE_ORDER).toEqual([WORK_EVIDENCE_GATE_ID, SCOPE_GATE_ID, ENV_CLEAN_GATE_ID]);
  });
});

// =============================================================================
// Baseline selection — the seam that had to move with the gate id
// =============================================================================

describe('runsEnvCleanGate — what makes the route record a baseline', () => {
  it.each([
    ['nothing', '', CONFIG_OFF, false],
    ['the repository option', '', CONFIG_ON, true],
    ['the contract success flag', 'success:\n  requireEnvClean: true\n', CONFIG_OFF, true],
    ['the contract naming the gate', 'verify:\n  gates: [env-clean]\n', CONFIG_OFF, true],
    [
      'the contract naming the gate alongside others',
      'verify:\n  gates: [lint, env-clean]\n',
      CONFIG_OFF,
      true,
    ],
    ['both booleans false and the gate unnamed', 'verify:\n  gates: [lint]\n', CONFIG_OFF, false],
  ])('%s -> %s', (_label, extra, verifyConfig, expected) => {
    expect(runsEnvCleanGate(contract(extra), verifyConfig)).toBe(expected);
  });

  it('answers true for the case the two booleans alone would have missed', () => {
    // The regression this function exists for: `verify.gates: [env-clean]` with
    // both booleans false. `selectGates` runs the gate; without this, nothing
    // wrote a baseline and the gate reported UNKNOWN every single time.
    const selected = contract('verify:\n  gates: [env-clean]\n');

    expect(resolveRequireEnvClean(selected, CONFIG_OFF).required).toBe(false);
    expect(runsEnvCleanGate(selected, CONFIG_OFF)).toBe(true);
  });

  it('still honours the contract flag with no verify.yaml in the worktree', () => {
    // Unchanged from #1740: the contract-side switch does not consult the config.
    // A run in that worktree fails on the missing config before any gate executes,
    // so writing a baseline is harmless — and refusing to write one here would
    // make the flag's meaning depend on a file it does not read.
    expect(runsEnvCleanGate(contract('success:\n  requireEnvClean: true\n'), null)).toBe(true);
    expect(runsEnvCleanGate(contract(), null)).toBe(false);
  });

  it('is unreachable for a gate-named contract with no verify.yaml', () => {
    // Not because this function says so, but because the send is refused one step
    // earlier: a contract naming gates with no config cannot resolve them.
    expect(
      validateContractAgainstVerifyConfig(contract('verify:\n  gates: [env-clean]\n'), null)
    ).toHaveLength(1);
  });
});

// =============================================================================
// The sentence the agent reads
// =============================================================================

describe('the preamble names env-clean whenever it will run', () => {
  it('never resolves the gate to the literal string "undefined"', () => {
    // `resolveGateCommands` looks each selected id up in a map of built-in labels
    // and then in the declared gates. `env-clean` is in neither by construction,
    // so before #2442 a contract naming it produced `undefined` in the list of
    // commands the agent was told to pass.
    const commands = resolveGateCommands(
      contract('verify:\n  gates: [env-clean, lint]\n'),
      CONFIG_OFF
    );

    expect(commands).not.toContain(undefined);
    for (const command of commands) expect(typeof command).toBe('string');
    expect(commands.some((command) => command.startsWith(ENV_CLEAN_GATE_ID))).toBe(true);
  });

  it('names it when the repository option switched it on and gates are omitted', () => {
    const message = composeContractMessage(contract(), CONFIG_ON);

    expect(message).toContain(ENV_CLEAN_GATE_ID);
    expect(message).toContain('tmux セッション');
  });

  it('names it when the repository option switched it on and gates are listed', () => {
    // The contract cannot see `options.requireEnvClean`, so this is the case where
    // the resolved id list and the run disagree unless the config is folded in.
    const commands = resolveGateCommands(contract('verify:\n  gates: [lint]\n'), CONFIG_ON);

    expect(commands.filter((command) => command.startsWith(ENV_CLEAN_GATE_ID))).toHaveLength(1);
  });

  it('names it exactly once when every declaration asks for it', () => {
    const commands = resolveGateCommands(
      contract('verify:\n  gates: [env-clean, lint]\nsuccess:\n  requireEnvClean: true\n'),
      CONFIG_ON
    );

    expect(commands.filter((command) => command.startsWith(ENV_CLEAN_GATE_ID))).toHaveLength(1);
  });

  it('lists it after scope and before the command gates', () => {
    const commands = resolveGateCommands(
      contract('verify:\n  gates: [lint, env-clean]\n'),
      CONFIG_OFF
    );

    expect(commands.map((command) => command.split('（')[0].split(' ')[0])).toEqual([
      WORK_EVIDENCE_GATE_ID,
      SCOPE_GATE_ID,
      ENV_CLEAN_GATE_ID,
      'npm',
    ]);
  });

  it('says nothing about it while it is off', () => {
    // The inert default, asserted on the sentence and not just on the flag.
    expect(composeContractMessage(contract(), CONFIG_OFF)).not.toContain(ENV_CLEAN_GATE_ID);
  });
});
