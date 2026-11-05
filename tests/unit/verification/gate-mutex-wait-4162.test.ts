/**
 * `mutexWaitSec`: the mutex wait counted apart from `timeoutSec` (Issue #4162).
 * The loader and the contract parser here; the runner in gate-mutex.test.ts.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import {
  MAX_MUTEX_WAIT_SEC,
  mutexWaitBudgetSec,
  validateGateEntries,
} from '@/lib/verification/verify-config';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const load = (fields: Record<string, unknown>) => {
  const issues: string[] = [];
  const gates = validateGateEntries([{ id: 'e2e', command: 'true', timeoutSec: 60, ...fields }], 'gates', issues);
  return { gate: gates[0], issues };
};

describe('the loader', () => {
  it('keeps a declared wait budget, longer or shorter than timeoutSec', () => {
    const { gate } = load({ mutex: 'cpu.heavy', mutexWaitSec: 14400 });
    expect(gate.mutexWaitSec).toBe(14400);
    expect(mutexWaitBudgetSec(gate)).toBe(14400);
    expect(mutexWaitBudgetSec({ timeoutSec: 600, mutexWaitSec: 5 })).toBe(5);
  });

  it('negative control: no key means timeoutSec, and no key is written into the gate', () => {
    const { gate } = load({ mutex: 'cpu.heavy' });
    expect('mutexWaitSec' in gate).toBe(false);
    expect(mutexWaitBudgetSec(gate)).toBe(60);
  });

  it('rejects a wait budget without a mutex, out of range, or not an integer', () => {
    expect(load({ mutexWaitSec: 60 }).issues[0]).toContain('requires mutex');
    expect(load({ mutex: 'a', mutexWaitSec: 0 }).issues[0]).toContain(`must be 1..${MAX_MUTEX_WAIT_SEC}`);
    expect(load({ mutex: 'a', mutexWaitSec: MAX_MUTEX_WAIT_SEC + 1 }).issues[0]).toContain(`must be 1..${MAX_MUTEX_WAIT_SEC}`);
    expect(load({ mutex: 'a', mutexWaitSec: 'soon' }).issues[0]).toContain('must be an integer');
  });
});

describe('a contract gate', () => {
  it('takes the same key, because it goes through the same validation', () => {
    const contract = parseTaskContract(
      [
        'version: 1',
        'title: t',
        'goal: g',
        'scope:',
        '  allow:',
        '    - "src/**"',
        'verify:',
        '  gates: [unit-related]',
        '  gateDefinitions:',
        '    - id: unit-related',
        '      command: "true"',
        '      mutex: cpu.heavy',
        '      mutexWaitSec: 14400',
      ].join('\n'),
      'test'
    );
    expect(contract.verify.gateDefinitions[0].mutexWaitSec).toBe(14400);
  });
});

describe('.commandmate/verify.yaml and the standalone runner', () => {
  it('declares only keys verify-run.sh reads, which refuses the whole file on any other', () => {
    const runner = readFileSync(path.join(REPO_ROOT, '.claude/skills/cmate-verify/scripts/verify-run.sh'), 'utf8');
    expect(runner).toContain('unknown gate key');
    const known = new Set([...runner.matchAll(/KV_K == "([A-Za-z]+)"/g)].map((match) => match[1]));
    const yaml = parse(readFileSync(path.join(REPO_ROOT, '.commandmate/verify.yaml'), 'utf8'));
    const declared = new Set<string>(yaml.gates.flatMap((gate: Record<string, unknown>) => Object.keys(gate)));
    expect([...declared].filter((key) => !known.has(key))).toEqual([]);
  });
});
