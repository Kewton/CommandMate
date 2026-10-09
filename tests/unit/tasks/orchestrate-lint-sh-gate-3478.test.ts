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

/**
 * Declared gates deliberately left out of the 3-3 fallback list, with why.
 * Empty today: the fallback exists to run the same verdict without completion
 * detection, so it names every gate verify.yaml declares.
 */
const FALLBACK_EXCLUDED: readonly { id: string; reason: string }[] = [];

describe('orchestrate.md 3-3: 完了検出の退避経路の --gates 一覧 (#3478)', () => {
  /** The `--gates` value of the fallback command, with its line continuation joined. */
  const fallbackGates = (): string[] => {
    expect(orchestrate, 'fallback paragraph not found').toContain('**完了検出が壊れているときは `verify --gates` へ退避する。**');
    // Since #3481 (2 本目) the fallback command lives in docs/orchestrate/workers.md; 3-3 points there.
    const workers = readFileSync(join(process.cwd(), 'docs/orchestrate/workers.md'), 'utf-8');
    const start = workers.indexOf('\n## 3-3 完了検出が壊れたときの退避\n');
    expect(start, 'fallback section not found in docs/orchestrate/workers.md').toBeGreaterThanOrEqual(0);
    const block = /```bash\n([\s\S]*?)```/.exec(workers.slice(start));
    expect(block, 'fallback code block not found').not.toBeNull();
    const joined = (block?.[1] ?? '').replace(/\\\n/g, '');
    const match = /commandmatedev verify "\$WT" --gates (\S+)/.exec(joined);
    expect(match, '--gates not found in the fallback command').not.toBeNull();
    return (match?.[1] ?? '').split(',');
  };

  it('names every declared gate, except the reasoned exclusions', () => {
    const declared = (loadVerifyConfig(process.cwd())?.gates ?? []).map((gate) => gate.id);
    expect(declared.length).toBeGreaterThan(5);
    const excluded = new Set(FALLBACK_EXCLUDED.map(({ id }) => id));
    expect(fallbackGates().sort()).toEqual(declared.filter((id) => !excluded.has(id)).sort());
  });

  it('includes lint-sh', () => {
    expect(fallbackGates()).toContain('lint-sh');
  });

  it('keeps the exclusions real and reasoned', () => {
    const declared = new Set((loadVerifyConfig(process.cwd())?.gates ?? []).map((gate) => gate.id));
    for (const { id, reason } of FALLBACK_EXCLUDED) {
      expect(declared.has(id), `${id} is not a declared gate`).toBe(true);
      expect(reason.trim()).not.toBe('');
      expect(fallbackGates()).not.toContain(id);
    }
  });
});
