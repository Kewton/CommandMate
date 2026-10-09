import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { loadVerifyConfig } from '@/lib/verification/verify-config';

const orchestrate = readFileSync(join(process.cwd(), '.claude/commands/orchestrate.md'), 'utf-8');

/** The body of one `### <heading>` section, up to the next `### `. */
const section = (heading: string): string => {
  const start = orchestrate.indexOf(`### ${heading}`);
  expect(start, `section ${heading} not found`).toBeGreaterThanOrEqual(0);
  const end = orchestrate.indexOf('\n### ', start + 4);
  return orchestrate.slice(start, end === -1 ? undefined : end);
};

describe('orchestrate.md: shellcheck の手元のゲート (#3478)', () => {
  it('2-4: .sh を触る Issue の契約に lint-sh を選ばせる', () => {
    const body = section('2-4. 実行契約の起案');
    expect(body).toContain('`.sh` を触る Issue');
    expect(body).toContain('gates: [lint, lint-sh, typecheck, unit-related]');
  });

  it('2-4 が名指す lint-sh は verify.yaml に宣言されている', () => {
    const ids = (loadVerifyConfig(process.cwd())?.gates ?? []).map((gate) => gate.id);
    expect(ids).toContain('lint-sh');
  });

  it('5-1: CI との突き合わせのガードと lint-sh を書く', () => {
    const body = section('5-1. 検証ゲートの実行');
    expect(body).toContain('tests/unit/guards/ci-steps-local-coverage-3478.test.ts');
    expect(body).toContain('scripts/run-lint-sh-if-changed.mjs');
    expect(body).toContain('#3477');
  });
});
