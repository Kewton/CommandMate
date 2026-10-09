import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const orchestrate = readFileSync(join(process.cwd(), '.claude/commands/orchestrate.md'), 'utf-8');

describe('orchestrate.md: 数字だけを合わせる変更の防止 (#3483)', () => {
  it('数え方を変えない決まりがある', () => {
    expect(orchestrate).toContain('数え方を変えない');
    expect(orchestrate).toContain('計測のコード・除外の一覧・抑止のコメント');
  });

  it('どう届いたかをコミット本文に書かせる', () => {
    expect(orchestrate).toContain('どう届いたかを書く');
    expect(orchestrate).toContain('言い換え・書き方の変更だけで数が変わった箇所');
  });

  it('計測が起票した Issue はまず内訳を確かめる', () => {
    expect(orchestrate).toContain('計測が起票した Issue');
    expect(orchestrate).toContain('増分の内訳');
    expect(orchestrate).toContain('#3270');
  });

  it('機械的な確認と 5-3 の流れがある', () => {
    expect(orchestrate).toContain('scripts/count-suppressions.mjs --base');
    expect(orchestrate).toContain('計測の誤りは、別の Issue');
  });
});
