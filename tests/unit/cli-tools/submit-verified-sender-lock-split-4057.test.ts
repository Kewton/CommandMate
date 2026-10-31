/**
 * Issue #4057: `sendUnderInputLock`'s complexity, measured the way the daily
 * metrics measure it (`scripts/agent-health/metrics-runners.ts`: ESLint's
 * `complexity` alone, `@typescript-eslint/parser`, the repo's config unused).
 *
 * Positive control: `sendUnderInputLock` is under 25 (it was 31 before the
 * split). Negative control: the same measurement still reports a function of
 * the file that is at 25 (`confirmPasteLanded`, untouched here), so a meter
 * that reads nothing cannot pass the positive control; and the functions the
 * split moved code into are each under 25.
 *
 * The source is read, never written; nothing is created on disk.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Linter } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';

const TARGET = join(process.cwd(), 'src/lib/cli-tools/submit-verified-sender.ts');
const LIMIT = 25;

/** Every function's complexity in `source`, by name (ESLint 8 `complexity` messages). */
function complexities(source: string): Map<string, number> {
  const linter = new Linter();
  linter.defineParser('ts', tsParser as unknown as Linter.ParserModule);
  const messages = linter.verify(source, {
    parser: 'ts',
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: { complexity: ['warn', 0] },
  });
  const byName = new Map<string, number>();
  for (const m of messages) {
    const match = /function '([^']+)' has a complexity of (\d+)/i.exec(m.message);
    if (match) byName.set(match[1], Number(match[2]));
  }
  return byName;
}

describe('[#4057] sendUnderInputLock split within submit-verified-sender.ts', () => {
  const measured = complexities(readFileSync(TARGET, 'utf8'));

  it('positive control: sendUnderInputLock is under 25', () => {
    expect(measured.get('sendUnderInputLock')).toBeDefined();
    expect(measured.get('sendUnderInputLock')).toBeLessThan(LIMIT);
  });

  it('negative control: the meter still reports confirmPasteLanded at 25', () => {
    expect(measured.get('confirmPasteLanded')).toBeGreaterThanOrEqual(LIMIT);
  });

  it('negative control: the functions split out are each under 25', () => {
    for (const name of [
      'resolveSubmitEnterCount',
      'pasteFailureMayHaveTyped',
      'shouldAwaitTypedBody',
      'promptReceiptFor',
      'settleAwaitedPromptReport',
      'rememberScreenOnlySubmit',
      'logClearInputFailed',
      'holdsResendEnter',
    ]) {
      expect(measured.get(name), name).toBeDefined();
      expect(measured.get(name), name).toBeLessThan(LIMIT);
    }
  });
});
