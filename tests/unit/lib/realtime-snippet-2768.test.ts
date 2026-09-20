/**
 * realtimeSnippet の行選択（Issue #2768）
 */
import { describe, it, expect } from 'vitest';
import {
  REALTIME_SNIPPET_ROW_COUNT,
  buildRealtimeSnippet,
  selectRealtimeSnippetRows,
} from '@/lib/realtime-snippet';

const rows = (count: number, label: string): string[] =>
  Array.from({ length: count }, (_, i) => `${label}-${i + 1}`);
const blanks = (count: number): string[] => Array.from({ length: count }, () => '');
// `String.fromCharCode` rather than a `\u` escape: `gh issue view` rewrites those
// escapes to caret notation, and this file was specified in an Issue.
const ESC = String.fromCharCode(0x1b);

describe('[#2768] 末尾 100 行に内容があるフレームは、従来と 1 バイトも変わらない', () => {
  it('下端寄せ（末尾まで内容）', () => {
    const lines = rows(1000, 'row');
    expect(selectRealtimeSnippetRows(lines)).toEqual(lines.slice(-100));
  });

  it('末尾 100 行のうち 1 行だけ内容がある', () => {
    const lines = [...rows(900, 'row'), ...blanks(99), 'footer'];
    expect(selectRealtimeSnippetRows(lines)).toEqual(lines.slice(-100));
  });

  it('内容が末尾 100 行の途中で終わる（後ろは空行のまま返す）', () => {
    const lines = [...rows(950, 'row'), ...blanks(50)];
    expect(selectRealtimeSnippetRows(lines)).toEqual(lines.slice(-100));
  });

  it('100 行未満の capture はそのまま返す', () => {
    const lines = rows(12, 'row');
    expect(selectRealtimeSnippetRows(lines)).toEqual(lines);
  });
});

describe('[#2768] 末尾 100 行がすべて空行のときだけ、内容の末尾へ窓を寄せる', () => {
  it('上端寄せ（173 行の内容 + 827 行の空行）は、内容の最後の 100 行を返す', () => {
    const content = rows(173, 'row');
    const result = selectRealtimeSnippetRows([...content, ...blanks(827)]);
    expect(result).toHaveLength(REALTIME_SNIPPET_ROW_COUNT);
    expect(result).toEqual(content.slice(-100));
    expect(result[result.length - 1]).toBe('row-173');
  });

  it('内容が 100 行に満たなければ、ある分だけ返す', () => {
    const content = rows(9, 'row');
    expect(selectRealtimeSnippetRows([...content, ...blanks(991)])).toEqual(content);
  });

  it('ANSI だけの行・空白だけの行は空行として数える', () => {
    const lines = ['top', ...Array.from({ length: 200 }, () => `${ESC}[0m   ${ESC}[39m`)];
    expect(selectRealtimeSnippetRows(lines)).toEqual(['top']);
  });

  it('何も描かれていないペインは従来どおり（空行 100 本）', () => {
    const lines = blanks(1000);
    expect(selectRealtimeSnippetRows(lines)).toEqual(lines.slice(-100));
  });

  it('入力の配列を書き換えない', () => {
    const lines = [...rows(5, 'row'), ...blanks(300)];
    const copy = [...lines];
    selectRealtimeSnippetRows(lines);
    expect(lines).toEqual(copy);
  });
});

describe('[#2768] buildRealtimeSnippet', () => {
  it('上端寄せの 1000 行フレームで、内容の末尾（フッタ）が snippet の最終行に来る', () => {
    const content = [
      '─'.repeat(200),
      '',
      'Plan review: sample · ~/.commandcode/plans/sample.md · v1',
      '   1   # sample',
      '',
      ' REVIEW ',
      'Approve ctrl+a   executes the plan',
      'Cancel esc',
      '',
      'type + enter to comment',
    ];
    const frame = [...content, ...blanks(1000 - content.length)].join('\n');
    expect(frame.split('\n')).toHaveLength(1000);
    // 修正前の式は空行しか返さない。
    expect(frame.split('\n').slice(-100).join('').trim()).toBe('');

    const snippet = buildRealtimeSnippet(frame).split('\n');
    expect(snippet).toEqual(content);
    expect(snippet[snippet.length - 1]).toBe('type + enter to comment');
  });

  it('split して選んで join するだけ（行の中身には触らない）', () => {
    const frame = [`${ESC}[1mbold${ESC}[0m`, 'plain'].join('\n');
    expect(buildRealtimeSnippet(frame)).toBe(frame);
  });
});
