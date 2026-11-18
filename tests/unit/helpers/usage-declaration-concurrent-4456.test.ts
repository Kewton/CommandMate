/**
 * Issue #4456 item 6: `withUsageDeclaration` sets a process-wide variable, so two
 * tests using it at the same time would restore each other's value (one test's
 * `afterEach` deletes the declaration while the other still runs, and that test's
 * premise silently goes away). The helper now refuses that use loudly instead:
 * a concurrent test, or a second test claiming it while the first still holds
 * it, throws in `beforeEach`. Sequential use (and nesting inside one test) is
 * unchanged.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USAGE_DECLARATION_ENV } from '@/lib/tool-policy/policy';
import { usageDeclarationHooks, withUsageDeclaration } from '@tests/helpers/usage-declaration';

const A = { id: 'task-a', name: 'a' };
const B = { id: 'task-b', name: 'b' };

let outer: string | undefined;
beforeEach(() => {
  outer = process.env[USAGE_DECLARATION_ENV];
  delete process.env[USAGE_DECLARATION_ENV];
});
afterEach(() => {
  if (outer === undefined) delete process.env[USAGE_DECLARATION_ENV];
  else process.env[USAGE_DECLARATION_ENV] = outer;
});

describe('usageDeclarationHooks (4456)', () => {
  it('positive: a second test claiming it while the first holds it throws, and the first keeps its value (4456)', () => {
    const hooks = usageDeclarationHooks('api-key');
    hooks.before(A);
    expect(() => hooks.before(B)).toThrow(/concurren/i);
    // B never claimed, so its afterEach restores nothing: A's premise holds.
    hooks.after(B);
    expect(process.env[USAGE_DECLARATION_ENV]).toBe('api-key');
    hooks.after(A);
    expect(process.env[USAGE_DECLARATION_ENV]).toBeUndefined();
  });

  it('positive: a test marked concurrent throws before anything is set (4456)', () => {
    const hooks = usageDeclarationHooks('enterprise');
    expect(() => hooks.before({ ...A, concurrent: true })).toThrow(/concurren/i);
    expect(process.env[USAGE_DECLARATION_ENV]).toBeUndefined();
    hooks.after({ ...A, concurrent: true });
    expect(process.env[USAGE_DECLARATION_ENV]).toBeUndefined();
  });

  it('negative: sequential tests each get the value and restore what was there (4456)', () => {
    process.env[USAGE_DECLARATION_ENV] = 'personal';
    const hooks = usageDeclarationHooks('api-key');
    hooks.before(A);
    expect(process.env[USAGE_DECLARATION_ENV]).toBe('api-key');
    hooks.after(A);
    expect(process.env[USAGE_DECLARATION_ENV]).toBe('personal');
    hooks.before(B);
    expect(process.env[USAGE_DECLARATION_ENV]).toBe('api-key');
    hooks.after(B);
    expect(process.env[USAGE_DECLARATION_ENV]).toBe('personal');
  });

  it('negative: nested declarations inside one test still stack and unwind (4456)', () => {
    const outerHooks = usageDeclarationHooks('api-key');
    const innerHooks = usageDeclarationHooks('enterprise');
    outerHooks.before(A);
    innerHooks.before(A);
    expect(process.env[USAGE_DECLARATION_ENV]).toBe('enterprise');
    innerHooks.after(A);
    expect(process.env[USAGE_DECLARATION_ENV]).toBe('api-key');
    outerHooks.after(A);
    expect(process.env[USAGE_DECLARATION_ENV]).toBeUndefined();
    // Released: another test can claim it now.
    outerHooks.before(B);
    outerHooks.after(B);
  });
});

describe('withUsageDeclaration in a sequential describe (4456)', () => {
  withUsageDeclaration('enterprise');
  it('declares for the test (4456)', () => {
    expect(process.env[USAGE_DECLARATION_ENV]).toBe('enterprise');
  });
  it('and again for the next one (4456)', () => {
    expect(process.env[USAGE_DECLARATION_ENV]).toBe('enterprise');
  });
});
