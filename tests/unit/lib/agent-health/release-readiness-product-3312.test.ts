/**
 * Issue #3312: the product-path check's final result in the release decision.
 * `fail` is a NO-GO ground; `unknown` and `not-run` are 要判断 (yellow); a
 * `skip` is 要判断 once it has lasted 3 days. Negative control: with no product
 * fact (stage 2 not set up) the verdict is what it was.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  decideReadiness,
  type ProductReadinessFact,
  type ReadinessFacts,
} from '@/lib/agent-health/release-readiness';

function facts(product?: ProductReadinessFact | null): ReadinessFacts {
  return {
    developCi: 'success',
    mergedToday: [{ number: 3060, title: 'fix', url: '', checks: 'success' }],
    audit: { current: 0, atLastRelease: 0 },
    dispatchStatus: 'sent',
    dispatched: [],
    prLookupOk: true,
    deferred: [],
    ...(product === undefined ? {} : { product }),
  };
}

const product = (status: ProductReadinessFact['status'], skipStreakDays = 0): ProductReadinessFact => ({
  status,
  reasons: [`実行: ${status}`],
  skipStreakDays,
});

describe('decideReadiness with the product-path check (Issue #3312)', () => {
  it('negative control: absent or null leaves GO as GO', () => {
    expect(decideReadiness(facts()).verdict).toBe('go');
    expect(decideReadiness(facts(null)).verdict).toBe('go');
  });

  it('pass keeps GO and says so', () => {
    const decision = decideReadiness(facts(product('pass')));
    expect(decision.verdict).toBe('go');
    expect(decision.reasons).toContain('製品の経路の確認（第 2 段）は pass');
  });

  it('fail is a NO-GO ground, with its reasons', () => {
    const decision = decideReadiness(facts(product('fail')));
    expect(decision.verdict).toBe('no-go');
    expect(decision.reasons.join('\n')).toContain('製品の経路の確認（第 2 段）が fail（実行: fail）');
  });

  it('unknown and not-run need a look (要判断), never GO', () => {
    expect(decideReadiness(facts(product('unknown'))).verdict).toBe('hold');
    const notRun = decideReadiness(facts(product('not-run')));
    expect(notRun.verdict).toBe('hold');
    expect(notRun.reasons.join('\n')).toContain('未実施');
  });

  it('a skip is a note for 2 days and needs action from the 3rd', () => {
    const two = decideReadiness(facts(product('skip', 2)));
    expect(two.verdict).toBe('go');
    expect(two.notes.join('\n')).toContain('skip');
    const three = decideReadiness(facts(product('skip', 3)));
    expect(three.verdict).toBe('hold');
    expect(three.reasons.join('\n')).toContain('3 日続けて skip（要対応）');
  });

  it('fail with another NO-GO ground lists both', () => {
    const decision = decideReadiness({ ...facts(product('fail')), developCi: 'failure' });
    expect(decision.verdict).toBe('no-go');
    expect(decision.reasons).toHaveLength(2);
  });
});
