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

describe('docs/orchestrate/team.md (#4418)', () => {
  const team = read('docs/orchestrate/team.md');

  it('§3: PM sends only through pm-send.ts, with --note, and the brief closes with DONE / WAIT / STOP', () => {
    const s3 = section(team, '## 3. PM から開発リーダーへのブリーフ');
    expect(s3).toContain('npx tsx scripts/orchestrate/pm-send.ts <worktree-id> --instance <id> --note "<待つもの>" "<本文>"');
    expect(s3).toContain('--reply-to self --note');
    expect(s3).toMatch(/`--note` が無い・空なら exit 2 で何も送らない/);
    expect(s3).toMatch(CLOSING);
    expect(s3).toContain('WAIT: <了承・判断待ちの内容>');
  });

  it('§4 step 2: claude-3 is sent to through pm-send.ts with the token, not claude3-reserve send directly', () => {
    const s4 = section(team, '## 4. agent-health の依頼とブリーフが重なったとき');
    const step2 = s4.split('\n').find((l) => l.startsWith('2. **送信**')) ?? '';
    expect(step2).toContain('npx tsx scripts/orchestrate/pm-send.ts mycodebranchdesk --instance claude-3 --token <token> --note "<待つもの>" "<本文>"');
    expect(step2).toContain('--reply-to self --note');
    expect(s4).toContain('`claude-3` へは `npx tsx scripts/orchestrate/pm-send.ts … --token <token>` だけで送る');
    // The old form (a send with no note) is no longer the instruction.
    expect(s4).not.toMatch(/`send --token <token> "<本文>"`/);
  });

  it('§8: requests close with DONE / WAIT / STOP and are sent through pm-send.ts', () => {
    const s8 = section(team, '## 8. 依頼ごとの完了の見張り');
    expect(s8).toContain('pm-send.ts');
    expect(s8).toMatch(CLOSING);
    expect(s8).toContain('`WAIT:`');
  });
});

describe('request templates (#4418)', () => {
  it('orchestrate.md names the rule and the entry, within the size limit', () => {
    const o = read('.claude/commands/orchestrate.md');
    expect(o).toContain('最後の行は `DONE:` / `WAIT:`（了承・判断待ち）/ `STOP:` のどれか');
    expect(section(o, '## Phase 7: UAT')).toContain('PM は `pm-send.ts` で送る（team.md §3）');
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
