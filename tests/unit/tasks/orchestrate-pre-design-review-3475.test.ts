import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const orchestrate = readFileSync(join(process.cwd(), '.claude/commands/orchestrate.md'), 'utf-8');

function section(start: string, end: string): string {
  const s = orchestrate.indexOf(start);
  const e = orchestrate.indexOf(end, s + start.length);
  expect(s).toBeGreaterThanOrEqual(0);
  expect(e).toBeGreaterThan(s);
  return orchestrate.slice(s, e);
}

describe('orchestrate.md: 設計の事前レビュー（試行中の段）(#3475)', () => {
  const stage = section('### 2-4-4. 新しい仕組みの設計の事前レビュー', '### 2-5.');

  it('段の見出しが 2-4-3 の後・2-5 の前にあり、期限が書いてある', () => {
    const i243 = orchestrate.indexOf('### 2-4-3.');
    const i244 = orchestrate.indexOf('### 2-4-4. 新しい仕組みの設計の事前レビュー（試行中の段、2026-11-06 まで）');
    const i25 = orchestrate.indexOf('### 2-5.');
    expect(i243).toBeLessThan(i244);
    expect(i244).toBeLessThan(i25);
    expect(stage).toContain('2026-11-06 まで（4 週間）');
  });

  it('対象の条件（状態・副作用・寿命の変更）と、接頭辞で判定しないことが書いてある', () => {
    expect(stage).toContain('状態・副作用・寿命を変える');
    expect(stage).toContain('接頭辞（feat / fix）では判定しない');
    expect(stage).toContain('既存の動作の修正で新しい経路や状態の遷移を生むもの');
  });

  it('置き場所（バグは Phase 2.5 の後）と、書くもの・依頼の形が書いてある', () => {
    expect(stage).toContain('バグは Phase 2.5（原因の分析）の後');
    expect(stage).toContain('参照したコード（file:line）と未確認の事項を必ず書く');
    expect(stage).toContain('依頼文は送る前に利用者に見せる');
    expect(stage).toContain('5-2b は残す');
  });

  it('記録は consistency-review.md の表に列を足す形で、Phase 0 の一覧にも入っている', () => {
    expect(stage).toContain('「事前レビューの有無」の列');
    expect(orchestrate).toContain('| 処置 | 事前レビューの有無 |');
    expect(orchestrate).toContain('2-4-4 新しい仕組みの設計の事前レビュー');
  });

  it('5-2b に再指示の書き方と前回の指摘の解消の確認がある', () => {
    const s = section('### 5-2b.', '### 5-3.');
    expect(s).toContain('守るべき条件・全経路・対照のテストに言い換えて');
    expect(s).toContain('再レビューでは、前回の指摘が解消したかを先に確かめる');
  });
});
