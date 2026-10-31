/**
 * Issue #4057: `sendUnderInputLock`'s complexity, measured the way the daily
 * metrics measure it (`scripts/agent-health/metrics-runners.ts`: ESLint's
 * `complexity` alone, `@typescript-eslint/parser`, the repo's config unused).
 *
 * Positive control: `sendUnderInputLock` is under 25 (it was 31 before the
 * split), and so is each function the split moved code into. Each is looked up
 * by name in `submit-verified-sender.ts` and the pieces split off it
 * (`submit-verified-sender-*.ts`, `tests/unit/guards/split-family.ts`), so a
 * later split of the file (#4056) does not break this test; a name found
 * nowhere fails.
 *
 * Negative control: a fixture of complexity 25 written in this test is
 * reported at 25 or more by the same measurement, so a meter that reads
 * nothing cannot pass the positive control.
 *
 * The sources are read, never written; nothing is created on disk.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Linter } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import { inFamily } from '../guards/split-family';

const ORIGIN = 'src/lib/cli-tools/submit-verified-sender.ts';
const LIMIT = 25;

/** `ORIGIN` and every piece split off it, repo-relative. */
function familyFiles(): string[] {
  const dir = 'src/lib/cli-tools';
  return readdirSync(join(process.cwd(), dir))
    .map((name) => `${dir}/${name}`)
    .filter((file) => inFamily(file, ORIGIN));
}

/** A function of complexity 25 (1 + 24 `if`s), for the negative control. */
const FIXTURE_NAME = 'fixtureAtTwentyFive';
const FIXTURE = `export function ${FIXTURE_NAME}(n: number): number {\n${Array.from(
  { length: LIMIT - 1 },
  (_, i) => `  if (n === ${i}) return ${i};\n`
).join('')}  return -1;\n}\n`;

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
  /** Each function's complexity, by name, with the file it was found in. */
  const measured = new Map<string, { file: string; value: number }>();
  for (const file of familyFiles()) {
    for (const [name, value] of complexities(readFileSync(join(process.cwd(), file), 'utf8'))) {
      measured.set(name, { file, value });
    }
  }

  it('positive control: sendUnderInputLock and the functions split out are each under 25', () => {
    for (const name of [
      'sendUnderInputLock',
      'resolveSubmitEnterCount',
      'pasteFailureMayHaveTyped',
      'shouldAwaitTypedBody',
      'promptReceiptFor',
      'settleAwaitedPromptReport',
      'rememberScreenOnlySubmit',
      'logClearInputFailed',
      'holdsResendEnter',
    ]) {
      const found = measured.get(name);
      expect(found, `${name} not found in ${ORIGIN} or its split pieces`).toBeDefined();
      expect(found?.value, `${name} (${found?.file})`).toBeLessThan(LIMIT);
    }
  });

  it('negative control: the same measurement reports a fixture of complexity 25 at 25 or more', () => {
    expect(complexities(FIXTURE).get(FIXTURE_NAME)).toBeGreaterThanOrEqual(LIMIT);
  });
});
