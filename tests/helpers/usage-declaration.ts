/**
 * Declaring an antigravity usage plan for the tests that need one (Issue #4436).
 *
 * The suite runs with the production default — no `CM_ANTIGRAVITY_USAGE`, so
 * `personal`, under which the tool policy refuses antigravity's unattended runs
 * and Auto-Yes answering (`tests/setup.ts` deletes the variable). A test whose
 * subject presupposes a declared plan — the ledger and wait mechanics of an
 * antigravity Auto-Yes answer, say — declares one with this, inside the
 * `describe` (or file) that needs it and nowhere else.
 *
 * It registers its own `beforeEach`/`afterEach` and restores whatever was there
 * before, so the declaration never leaks into the next test. Not for
 * `describe.concurrent` / `it.concurrent`: the variable is process-wide.
 * Issue #4456: that is enforced, not only written here — a concurrent test, or a
 * second test claiming the declaration while another still holds it, throws in
 * `beforeEach` (rather than one test's `afterEach` silently taking the other's
 * premise away). Nesting inside one test is fine.
 *
 * @module tests/helpers/usage-declaration
 */

import { afterEach, beforeEach } from 'vitest';
import { USAGE_DECLARATION_ENV } from '@/lib/tool-policy/policy';

/** The part of a Vitest task the helper reads. */
export interface UsageDeclarationTask {
  id: string;
  name?: string;
  concurrent?: boolean;
}

/** The test holding the declaration now, and how many nested declarations it made. */
let holder: { id: string; name?: string; depth: number } | null = null;

function refuse(task: UsageDeclarationTask, why: string): never {
  throw new Error(
    `withUsageDeclaration is not for concurrent tests (${why}): ${USAGE_DECLARATION_ENV} is process-wide. ` +
      `Test: ${task.name ?? task.id}`,
  );
}

/**
 * The two hook bodies `withUsageDeclaration` registers, apart from the
 * registration so the sequential-use rule can be tested alone (Issue #4456).
 */
export function usageDeclarationHooks(value: 'api-key' | 'enterprise'): {
  before: (task: UsageDeclarationTask) => void;
  after: (task: UsageDeclarationTask) => void;
} {
  // Per task: one closure serves every test of its describe.
  const saved = new Map<string, string | undefined>();
  return {
    before(task) {
      if (task.concurrent) refuse(task, 'the test runs concurrently');
      if (holder !== null && holder.id !== task.id) {
        refuse(task, `"${holder.name ?? holder.id}" still holds the declaration`);
      }
      holder = holder === null ? { id: task.id, name: task.name, depth: 1 } : { ...holder, depth: holder.depth + 1 };
      saved.set(task.id, process.env[USAGE_DECLARATION_ENV]);
      process.env[USAGE_DECLARATION_ENV] = value;
    },
    after(task) {
      // A test whose `before` refused never set anything: nothing to restore.
      if (!saved.has(task.id)) return;
      const previous = saved.get(task.id);
      saved.delete(task.id);
      if (previous === undefined) delete process.env[USAGE_DECLARATION_ENV];
      else process.env[USAGE_DECLARATION_ENV] = previous;
      if (holder !== null && holder.id === task.id) {
        holder = holder.depth > 1 ? { ...holder, depth: holder.depth - 1 } : null;
      }
    },
  };
}

/**
 * Run each test of the enclosing `describe` (or file) under
 * `CM_ANTIGRAVITY_USAGE=<value>`.
 *
 * @param value - The declared plan (`api-key` or `enterprise`)
 */
export function withUsageDeclaration(value: 'api-key' | 'enterprise'): void {
  const hooks = usageDeclarationHooks(value);
  beforeEach((context) => hooks.before(context.task));
  afterEach((context) => hooks.after(context.task));
}
