import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const orchestrate = readFileSync(join(process.cwd(), '.claude/commands/orchestrate.md'), 'utf-8');

describe('orchestrate.md: 整合性レビュー（試行中の段）(#3392)', () => {
  it('節があり、期限・対象・再レビューの上限・数え方が書いてある', () => {
    expect(orchestrate).toContain('### 5-2b. 整合性レビュー（試行中の段、2026-10-20 まで）');
    expect(orchestrate).toContain('2026-10-20 まで（2 週間）');
    expect(orchestrate).toContain('除外した PR からも、run ごとに 1 本を抜き出してレビューし');
    expect(orchestrate).toContain('自動は 3 回まで');
    expect(orchestrate).toContain('止めて人の判断へ');
    expect(orchestrate).toContain('動作／説明／テスト');
    expect(orchestrate).toContain('新規／既存');
  });

  it('記録の様式と集計の手順が書いてある', () => {
    expect(orchestrate).toContain('consistency-review.md');
    expect(orchestrate).toContain('| # | Issue | 担当 | 依頼した HEAD |');
    expect(orchestrate).toContain('consistency-review-trial.md');
    expect(orchestrate).toContain('Codex のレビューを受ける');
  });
});
