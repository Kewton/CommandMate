import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8');
const orchestrate = read('.claude/commands/orchestrate.md');
const bugFix = read('.claude/commands/bug-fix.md');

describe('orchestrate.md: 対になる場所の探索と指摘の処置 (#3307)', () => {
  it('契約の雛形に、実装の前に対になる場所を探す項がある', () => {
    expect(orchestrate).toContain('対になる場所を探す');
    expect(orchestrate).toContain('同じ場所の別の条件');
  });

  it('「本文に無い指摘」を 1 件ずつ処置し、未処置の PR をマージしないと書いてある', () => {
    expect(orchestrate).toContain('未処置の指摘が残っている PR は、マージしない');
    expect(orchestrate).toContain('再指示する');
    expect(orchestrate).toContain('対応しない（理由を書く）');
  });

  it('2.5-4 に、ずれを検出するテストと各経路に当てるテストの決まりがある', () => {
    expect(orchestrate).toContain('欄の名前の一致だけでは足りない');
    expect(orchestrate).toContain('実際の応答');
    expect(orchestrate).toContain('同じ事例を各経路に当てるテスト');
  });

  it('8-4 に、意図して残した制限を Issue にする段がある', () => {
    expect(orchestrate).toContain('意図して残した制限を、追跡する Issue にする');
  });

  it('陰性対照: 既存の退避路の文言は残っている', () => {
    expect(orchestrate).toContain('本文に無い指摘: <file>:<line> <内容>');
  });
});

describe('bug-fix.md: 対になる場所の探索 (#3307)', () => {
  it('Phase 2 に探す段と写しのずれのテストの決まりがある', () => {
    expect(bugFix).toContain('対になる場所を探す');
    expect(bugFix).toContain('同じ事例を各経路に当てるテスト');
  });
});
