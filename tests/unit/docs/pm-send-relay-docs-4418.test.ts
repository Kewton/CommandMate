/**
 * Issue #4418 (L3): team.md and the request templates point at PM's one entry
 * (scripts/orchestrate/pm-send.ts) and close with DONE: / WAIT: / STOP:.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

function section(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = doc.indexOf('\n## ', start + heading.length);
  return next < 0 ? doc.slice(start) : doc.slice(start, next);
}

const CLOSING = /最後の行は `?DONE:.*`?WAIT:.*`?STOP:/;

describe('docs/design/pm-send-relay-4418.md after #4420', () => {
  const design = read('docs/design/pm-send-relay-4418.md');

  it('the re-request after a relayed answer goes through; the ceiling is 10 replies in 30 minutes (RELAY_HOPS_EXCEEDED)', () => {
    const s = section(design, '## 返事を受けた後の再依頼');
    expect(s).toContain('#4420 で解消');
    expect(s).toMatch(/旗なしで通り/);
    expect(s).toContain('RELAY_HOPS_EXCEEDED');
    expect(s).toMatch(/直近 30 分.*10 本/);
    expect(s).toMatch(/PM は多くの相手.*10 本に当たりうる/);
    expect(s).toMatch(/素の send には落とさない/);
    expect(s).toMatch(/exit をそのまま返す/);
    expect(s).toMatch(/待つか人に返す/);
    // The old fact is history, not the instruction.
    expect(s).not.toMatch(/今の `pm-send` は付けないので、\*\*返事を受けた後の 2 回目の送信で止まる/);
  });

  it('the relay watch stays record-only after #4420, with why, until #4517 (flow-relay-watch-4418.md §5.1)', () => {
    const watch = read('docs/design/flow-relay-watch-4418.md');
    expect(watch).toMatch(/#4420 の後も `false` のまま/);
    expect(watch).toContain('#4517');
    expect(watch).toMatch(/毎朝の自動依頼/);
    expect(watch).toMatch(/照会できなかった/);
    expect(read('.commandmate/flow.yaml')).toMatch(/^  notifyNoRelay: false$/m);
  });
});

describe('request templates (#4418)', () => {
  it('orchestrate.md names the rule and the entry, within the size limit', () => {
    const o = read('.claude/commands/orchestrate.md');
    expect(o).toContain('最後の行は `DONE:` / `WAIT:`（了承・判断待ち）/ `STOP:` のどれか');
    // Phase 7 is develop's as it is (claude-8's §7; team.md §3 says how PM sends).
    expect(section(o, '## Phase 7: UAT')).not.toContain('pm-send.ts');
    expect(section(o, '## Phase 4: 設計突合')).toContain('最後の行は DONE: / WAIT: / STOP: のどれか'); // 4-3 の修正指示
    expect(Buffer.byteLength(o, 'utf8')).toBeLessThanOrEqual(118_000);
  });

  it('the analysis request (workers.md 2.5-1) and the pre-review request (trials.md 2-4-4) close the same way', () => {
    expect(read('docs/orchestrate/workers.md')).toMatch(/最後の行は DONE: <要約> \/ WAIT: <了承・判断待ちの内容> \/ STOP: <理由> のどれか/);
    expect(section(read('docs/orchestrate/trials.md'), '## 2-4-4 事前レビューの書き方と記録')).toMatch(CLOSING);
  });

  it('the entry the docs name exists', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'scripts/orchestrate/pm-send.ts'))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), 'docs/design/pm-send-relay-4418.md'))).toBe(true);
  });
});
