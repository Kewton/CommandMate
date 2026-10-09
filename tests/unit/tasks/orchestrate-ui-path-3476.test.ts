import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const orchestrate = readFileSync(join(process.cwd(), '.claude/commands/orchestrate.md'), 'utf-8');
// Since #3481 the worked example lives in docs/orchestrate/; 2-4 points there.
const contractEvidence = readFileSync(join(process.cwd(), 'docs/orchestrate/contract.md'), 'utf-8');

describe('orchestrate.md: 画面・CLI に見える変化を含む Issue の契約 (#3476)', () => {
  it('2-4 に小見出しがあり、2-4-1 より前にある', () => {
    const h = orchestrate.indexOf('#### 画面・CLI に見える変化を含む Issue');
    expect(h).toBeGreaterThan(orchestrate.indexOf('### 2-4. 実行契約の起案'));
    expect(h).toBeLessThan(orchestrate.indexOf('### 2-4-1.'));
  });

  it('経路図・変更する段だけの scope・経路ごとの表示の確認・実際の応答が書いてある', () => {
    expect(orchestrate).toContain('経路図を goal に書き、変更が要る段だけを `scope.allow` に入れる');
    expect(orchestrate).toContain('読むだけの段は入れない');
    expect(orchestrate).toContain('経路ごとの表示の確認');
    expect(orchestrate).toContain('親から通して描画される');
    expect(orchestrate).toContain('部品だけのテストでは足りない');
    expect(orchestrate).toContain('サーバーが実際に返す応答');
  });

  it('#3397 の例がある', () => {
    const evidence = `${orchestrate}\n${contractEvidence}`;
    expect(evidence).toContain('例（#3397');
    expect(evidence).toContain('useTerminalPanePolling');
    expect(evidence).toContain('TerminalSplitPaneContent');
  });

  it('2-4-2 の対になる場所に「表示されない条件」の項目がある', () => {
    const start = orchestrate.indexOf('#### 対になる場所を探す');
    const block = orchestrate.slice(start, start + 1500);
    expect(block).toContain('**表示されない条件**');
  });
});
