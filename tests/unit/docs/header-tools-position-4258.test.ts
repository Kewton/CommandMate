/**
 * #4258 / #3574: the docs describe the header as it is after #4218 (tools right
 * after the identity group) and #4219 (the pane can sit on either side), and
 * the dictionary no longer carries the unused `agentStatus.overflowTrigger`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf-8');

/** Stale phrasings: the tools described as sitting at the right of the header. */
const STALE_PATTERNS: RegExp[] = [
  /ヘッダー右の道具/,
  /ヘッダー右のアイコン/,
  /tools at the right of the header/i,
  /icons at the right of the header/i,
  /Tools at the right of the header/,
  /at the right of the header\b(?!.*session)/i,
];

function staleLines(text: string): string[] {
  return text.split('\n').filter((l) => STALE_PATTERNS.some((re) => re.test(l)));
}

const DOCS = [
  'docs/UI_UX_GUIDE.md',
  'docs/en/UI_UX_GUIDE.md',
  'docs/user-guide/webapp-guide.md',
  'docs/en/user-guide/webapp-guide.md',
  'docs/architecture.md',
  'docs/en/architecture.md',
];

describe('header tools position in docs (#4258)', () => {
  it('positive control: the checker flags the old wording', () => {
    expect(staleLines('ヘッダー右の道具の「エージェント」')).toHaveLength(1);
    expect(staleLines('in the Agent tool at the right of the header.')).toHaveLength(1);
  });

  it('negative control: the new wording is not flagged', () => {
    expect(staleLines('tools right after the header\'s identity group')).toHaveLength(0);
    expect(staleLines('ヘッダー右端の［セッション N ▾］の一覧')).toHaveLength(0);
  });

  it.each(DOCS)('%s has no stale "tools at the right of the header"', (doc) => {
    expect(staleLines(read(doc))).toEqual([]);
  });

  it('webapp-guide and UI_UX_GUIDE mention that the pane can move sideways (ja and en)', () => {
    expect(read('docs/UI_UX_GUIDE.md')).toContain('左に移す');
    expect(read('docs/en/UI_UX_GUIDE.md')).toContain('Move to left');
    expect(read('docs/user-guide/webapp-guide.md')).toContain('左に移す');
    expect(read('docs/en/user-guide/webapp-guide.md')).toContain('Move to left');
  });

  it('the pane-side button labels in the docs exist in the dictionary', () => {
    const ja = JSON.parse(read('locales/ja/worktree.json'));
    const en = JSON.parse(read('locales/en/worktree.json'));
    expect(ja.desktopLayout.movePaneLeft).toBe('左に移す');
    expect(en.desktopLayout.movePaneLeft).toBe('Move to left');
  });

  it.each(['ja', 'en'])('locales/%s/worktree.json has no unused agentStatus.overflowTrigger', (l) => {
    const dict = JSON.parse(read(`locales/${l}/worktree.json`));
    expect(dict.agentStatus).not.toHaveProperty('overflowTrigger');
    expect(dict.agentStatus).toHaveProperty('sessions');
  });
});
