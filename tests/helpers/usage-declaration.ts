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
 *
 * @module tests/helpers/usage-declaration
 */

import { afterEach, beforeEach } from 'vitest';
import { USAGE_DECLARATION_ENV } from '@/lib/tool-policy/policy';

/**
 * Run each test of the enclosing `describe` (or file) under
 * `CM_ANTIGRAVITY_USAGE=<value>`.
 *
 * @param value - The declared plan (`api-key` or `enterprise`)
 */
export function withUsageDeclaration(value: 'api-key' | 'enterprise'): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[USAGE_DECLARATION_ENV];
    process.env[USAGE_DECLARATION_ENV] = value;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[USAGE_DECLARATION_ENV];
    else process.env[USAGE_DECLARATION_ENV] = saved;
  });
}
