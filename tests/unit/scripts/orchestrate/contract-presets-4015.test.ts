/**
 * scripts/orchestrate/contract.mjs — what the generator adds before the worker
 * trips on it (Issue #4015): fixture-scan rule, companion scope files, and the
 * two refactor rules from #4074. Pure functions only; nothing is written.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_GOAL_LENGTH,
  MAX_SCOPE_PATTERNS,
  buildContract,
  normalizeConfig,
} from '../../../../scripts/orchestrate/contract.mjs';

const base = {
  issue: 4015,
  title: '契約の先回り',
  kind: 'feature',
  agent: 'claude',
  model: 'opus',
  scope: ['scripts/orchestrate/**'],
};
const OVERRIDE = 'tests/unit/lib/slash-command-description-override.test.ts';
const SYNC_MAP = '.claude/skills/sync-map.json';
const FIXTURE_LEAD = '`tests/fixtures/` の下に足すので、fixture を走査するテスト';

const count = (list: string[], item: string) => list.filter((entry) => entry === item).length;
const goalOf = (config: Record<string, unknown>) => buildContract(normalizeConfig(config)).goal;

describe('fixture-scan rule (decision 1)', () => {
  it('enters the goal when the scope reaches tests/fixtures/', () => {
    for (const pattern of ['tests/fixtures/x-4000/**', 'tests/fixtures/a.txt', 'tests/fixtures']) {
      const goal = goalOf({ ...base, scope: [pattern] });
      expect(goal).toContain(FIXTURE_LEAD);
      expect(goal).toContain('走査するテストは scope に入れておく');
      expect(goal).not.toMatch(/\n{3,}/);
    }
  });

  it('stays out when the scope does not reach tests/fixtures/', () => {
    expect(goalOf(base)).not.toContain(FIXTURE_LEAD);
    expect(goalOf({ ...base, scope: ['tests/unit/fixtures-like/**', 'tests/fixturesX/a.ts'] })).not.toContain(FIXTURE_LEAD);
  });

  it('is one line even when two patterns match', () => {
    const goal = goalOf({ ...base, scope: ['tests/fixtures/a/**', 'tests/fixtures/b/**'] });
    expect(goal.split(FIXTURE_LEAD).length - 1).toBe(1);
  });
});

describe('catalog override test (decision 3)', () => {
  it('is added when the scope has the catalog', () => {
    const config = normalizeConfig({ ...base, scope: ['src/config/slash-commands-catalog.json'] });
    expect(config.scope).toContain(OVERRIDE);
  });

  it('is not added otherwise', () => {
    expect(normalizeConfig(base).scope).not.toContain(OVERRIDE);
    expect(normalizeConfig({ ...base, scope: ['src/config/other.json'] }).scope).not.toContain(OVERRIDE);
  });

  it('does not duplicate one the config already wrote', () => {
    const config = normalizeConfig({ ...base, scope: ['src/config/slash-commands-catalog.json', OVERRIDE] });
    expect(count(config.scope, OVERRIDE)).toBe(1);
  });

  it('is allowed in a refactor (a file, not a glob)', () => {
    const config = normalizeConfig({
      ...base,
      kind: 'refactor',
      refactor: { mergesCopies: false },
      scope: ['src/config/slash-commands-catalog.json'],
    });
    expect(config.scope).toContain(OVERRIDE);
  });
});

describe('sync-map.json (decision 5)', () => {
  it('is added when a pattern is under .claude/skills/', () => {
    for (const pattern of ['.claude/skills/**', '.claude/skills/rebuild/SKILL.md', '.claude/skills/x/scripts/**', '.claude/skills']) {
      expect(normalizeConfig({ ...base, scope: [pattern] }).scope).toContain(SYNC_MAP);
    }
  });

  it('is added when only one of several patterns matches', () => {
    expect(normalizeConfig({ ...base, scope: ['src/a.ts', '.claude/skills/x/SKILL.md'] }).scope).toContain(SYNC_MAP);
  });

  it('is not added for other .claude paths or lookalikes', () => {
    for (const pattern of ['.claude/commands/orchestrate.md', '.claude/skills-extra/a.md', 'docs/.claude/skills/a.md']) {
      expect(normalizeConfig({ ...base, scope: [pattern] }).scope).not.toContain(SYNC_MAP);
    }
  });

  it('does not duplicate when the config already has it', () => {
    expect(count(normalizeConfig({ ...base, scope: ['.claude/skills/**', SYNC_MAP] }).scope, SYNC_MAP)).toBe(1);
    expect(count(normalizeConfig({ ...base, scope: [SYNC_MAP] }).scope, SYNC_MAP)).toBe(0 + 1 - 0 === 1 ? 1 : 1);
  });

  it('keeps the fragment last-added and once', () => {
    const scope = normalizeConfig({ ...base, scope: ['.claude/skills/**', 'changelog.d/4015.md'] }).scope;
    expect(count(scope, 'changelog.d/4015.md')).toBe(1);
    expect(count(scope, SYNC_MAP)).toBe(1);
  });
});

describe('MAX_SCOPE_PATTERNS counts the added files', () => {
  const many = (n: number, first: string[] = []) => [...first, ...Array.from({ length: n - first.length }, (_, i) => `src/m${i}.ts`)];

  it('accepts exactly the limit including the fragment', () => {
    // 199 written + fragment = 200.
    expect(normalizeConfig({ ...base, scope: many(MAX_SCOPE_PATTERNS - 1) }).scope).toHaveLength(MAX_SCOPE_PATTERNS);
  });

  it('rejects when the added sync-map pushes it over (positive control)', () => {
    // 199 written (one under .claude/skills) + sync-map + fragment = 201.
    const scope = many(MAX_SCOPE_PATTERNS - 1, ['.claude/skills/x/SKILL.md']);
    expect(() => normalizeConfig({ ...base, scope })).toThrow(/at most 200 patterns \(got 201\)/);
  });

  it('accepts the same size when the sync-map was already written (no double count)', () => {
    const scope = many(MAX_SCOPE_PATTERNS - 1, ['.claude/skills/x/SKILL.md', SYNC_MAP]);
    expect(normalizeConfig({ ...base, scope }).scope).toHaveLength(MAX_SCOPE_PATTERNS);
  });

  it('rejects when both companions push it over', () => {
    const scope = many(MAX_SCOPE_PATTERNS - 1, ['src/config/slash-commands-catalog.json', '.claude/skills/x/a.md']);
    expect(() => normalizeConfig({ ...base, scope })).toThrow(/at most 200 patterns \(got 202\)/);
  });
});

describe('the two refactor rules from #4074 (decision 4)', () => {
  const ASYNC = '`await` を含む処理を async 関数へ切り出すのも、`await` を足すことに当たる（呼び手が再開するまでの継続が 1 段増える）。待ちは元の関数に残し、待った後の判定だけを同期関数に分ける。';
  const NEGATIVE = '複雑度・行数を測るテストで、計測が働いていることの陰性対照に、この Issue と無関係な既存の関数の実測値を固定しない（テストの中に置いた小さな fixture を使う）。関数をファイルで探すときは、元のファイルと分割先（同じディレクトリの `<元の名前>-*.ts`、`tests/unit/guards/split-family.ts`）の両方を探す。';
  const refactor = { ...base, kind: 'refactor', scope: ['src/lib/x/**'] };

  it.each([true, false])('enters a refactor goal with mergesCopies: %s', (mergesCopies) => {
    const goal = goalOf({ ...refactor, refactor: { mergesCopies } });
    expect(goal).toContain(ASYNC);
    expect(goal).toContain(NEGATIVE);
    // The async sentence follows the await rule; the other keeps ordinary regression tests allowed.
    expect(goal.indexOf('- **`await` を足さない。**')).toBeLessThan(goal.indexOf(ASYNC));
    expect(goal).toContain('公開の振る舞いを保つ、ふつうの回帰テストは禁じない');
  });

  it.each(['feature', 'bug', 'docs'])('stays out of a %s goal', (kind) => {
    const goal = goalOf({ ...base, kind });
    expect(goal).not.toContain('async 関数へ切り出す');
    expect(goal).not.toContain('split-family.ts');
  });
});

describe('the goal limit (8,000 characters)', () => {
  it('still generates for a long Issue that fits, with the new rules in', () => {
    const refactor = { ...base, kind: 'refactor', scope: ['src/lib/x/**'], refactor: { mergesCopies: true } };
    const baseline = goalOf(refactor).length;
    const room = MAX_GOAL_LENGTH - baseline - 20;
    const goal = goalOf({ ...refactor, issueBody: 'あ'.repeat(room) });
    expect(goal.length).toBeLessThanOrEqual(MAX_GOAL_LENGTH);
    expect(goal.length).toBeGreaterThan(MAX_GOAL_LENGTH - 100);
  });

  it('still rejects an input above the limit', () => {
    const refactor = { ...base, kind: 'refactor', scope: ['src/lib/x/**'], refactor: { mergesCopies: true } };
    const room = MAX_GOAL_LENGTH - goalOf(refactor).length;
    expect(() => goalOf({ ...refactor, issueBody: 'あ'.repeat(room + 50) })).toThrow(/exceeds 8000/);
  });

  it('counts the fixture rule too (a long body that fit without it is refused)', () => {
    const plain = { ...base, scope: ['src/a.ts'] };
    const room = MAX_GOAL_LENGTH - goalOf(plain).length - 30;
    expect(() => goalOf({ ...plain, issueBody: 'あ'.repeat(room) })).not.toThrow();
    expect(() => goalOf({ ...plain, scope: ['tests/fixtures/x/**'], issueBody: 'あ'.repeat(room) })).toThrow(/exceeds 8000/);
  });
});
