/**
 * `docs/design/send-foreground-check-4300.md` 改訂 4 (Issue #4304).
 *
 * 改訂 3 stopped on a P1 (review-4300d ①: the user's rc exec'ing another
 * interactive shell) and six P2s. #4304's contract asks 改訂 4 to carry the
 * human decisions (H1-a / H2 / H3), the nine items of the enabler's §2.2, the
 * relation to #4303-A, and "implementation only after 改訂 4 is approved".
 * A worker sent to PR2a/PR2b reads this document as the 正本, so a 改訂 4 that
 * silently drops one of those items sends the worker back to 改訂 3's open P1.
 *
 * This pins presence inside the 改訂 4 section only (a label elsewhere in the
 * document — §11, §12 — does not count) and the revision history line. It does
 * not judge the content.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DOC = resolve(__dirname, '../../../docs/design/send-foreground-check-4300.md');

/** What 改訂 4 must name inside its own section. */
const REQUIRED_IN_REV4: readonly string[] = [
  // human decisions (2026-11-13 14:47)
  'H1-a',
  'H2',
  'H3',
  // enabler §2.2, nine items
  '② 準備の証拠の世代',
  '③ cwd',
  '④ ps の不明',
  '⑤ 最後の画面の世代',
  '⑥ prompt-response の API 配送',
  '⑦ 開始窓の前倒し',
  '#4304 のコメントの 3 経路',
  '行番号の取り直し',
  'Auto-Yes と世代',
  // relation and gating
  '#4303-A',
  '改訂 4 の承認の後',
];

function rev4Section(text: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex(line => /^## 改訂 4/.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^## /.test(line));
  return lines.slice(start, end < 0 ? undefined : start + 1 + end).join('\n');
}

function auditRev4(text: string): string[] {
  const missing: string[] = [];
  const history = rev4History(text);
  if (history === null) missing.push('## 改訂の履歴 に 改訂 4 の行');
  const section = rev4Section(text);
  if (section === null) return [...missing, '## 改訂 4'];
  for (const label of REQUIRED_IN_REV4) {
    if (!section.includes(label)) missing.push(label);
  }
  return missing;
}

function rev4History(text: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex(line => /^## 改訂の履歴/.test(line));
  if (start < 0) return null;
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    if (/改訂 4/.test(line)) return line;
  }
  return null;
}

describe('send-foreground-check-4300.md 改訂 4 (#4304)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tmpDoc(text: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'rev4-4304-'));
    dirs.push(dir);
    const path = join(dir, 'doc.md');
    writeFileSync(path, text);
    return readFileSync(path, 'utf8');
  }

  it('names the decisions, the nine items, #4303-A and the approval gate inside the 改訂 4 section', () => {
    expect(auditRev4(readFileSync(DOC, 'utf8'))).toEqual([]);
  });

  it('positive control: the same document without the 改訂 4 section and history is reported', () => {
    const text = readFileSync(DOC, 'utf8');
    const section = rev4Section(text);
    expect(section).not.toBeNull();
    const stripped = tmpDoc(text.replace(section as string, '').replace(/^## 改訂の履歴[\s\S]*?(?=^## )/m, ''));
    const missing = auditRev4(stripped);
    expect(missing).toContain('## 改訂 4');
    expect(missing).toContain('## 改訂の履歴 に 改訂 4 の行');
  });

  it('positive control: a label that sits outside the 改訂 4 section does not count', () => {
    const labels = REQUIRED_IN_REV4.join('\n');
    const doc = tmpDoc(
      ['# t', '', '## 改訂の履歴', '- 改訂 4: x', '', '## 改訂 4（x）', '', 'H1-a', '', '## 12. other', labels, ''].join('\n')
    );
    const missing = auditRev4(doc);
    expect(missing).toContain('#4303-A');
    expect(missing).not.toContain('H1-a');
  });

  it('negative control: a minimal document with every label in the section passes', () => {
    const doc = tmpDoc(
      ['# t', '', '## 改訂の履歴', '- 改訂 4: x', '', '## 改訂 4（x）', ...REQUIRED_IN_REV4, '', '## 0. next', ''].join('\n')
    );
    expect(auditRev4(doc)).toEqual([]);
  });
});

/**
 * 改訂 5 (Issue #4304, the 2-4-4 re-review of 改訂 4 by codex-2): the four
 * invariants, the decisions on the remaining P1 and P2s, the 要決定 rows and
 * the per-defence red tests have to be in the 改訂 5 section. Presence only.
 */
const REQUIRED_IN_REV5: readonly string[] = [
  'I1',
  'I2',
  'I3',
  'I4',
  'ps -o args= -p <pane_pid>',
  'Enter 省略',
  '#4303-A',
  'nonce',
  'vibe-local.ts:249',
  'D1',
  'D2',
  'D3',
  '防御を 1 つずつ外した',
  '改訂 5 の承認の後',
];

function sectionStartingWith(text: string, heading: RegExp): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex(line => heading.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^## /.test(line));
  return lines.slice(start, end < 0 ? undefined : start + 1 + end).join('\n');
}

function auditRev5(text: string): string[] {
  const missing: string[] = [];
  const history = sectionStartingWith(text, /^## 改訂の履歴/);
  if (history === null || !/^- 改訂 5/m.test(history)) missing.push('## 改訂の履歴 に 改訂 5 の行');
  const section = sectionStartingWith(text, /^## 改訂 5/);
  if (section === null) return [...missing, '## 改訂 5'];
  for (const label of REQUIRED_IN_REV5) {
    if (!section.includes(label)) missing.push(label);
  }
  return missing;
}

describe('send-foreground-check-4300.md 改訂 5 (#4304)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tmpDoc(text: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'rev5-4304-'));
    dirs.push(dir);
    const path = join(dir, 'doc.md');
    writeFileSync(path, text);
    return readFileSync(path, 'utf8');
  }

  it('names the invariants, the decisions, the open choices and the red tests inside the 改訂 5 section', () => {
    expect(auditRev5(readFileSync(DOC, 'utf8'))).toEqual([]);
  });

  it('positive control: the document without the 改訂 5 section and history line is reported', () => {
    const text = readFileSync(DOC, 'utf8');
    const section = sectionStartingWith(text, /^## 改訂 5/);
    expect(section).not.toBeNull();
    const stripped = tmpDoc(text.replace(section as string, '').replace(/^- 改訂 5.*\n/m, ''));
    const missing = auditRev5(stripped);
    expect(missing).toContain('## 改訂 5');
    expect(missing).toContain('## 改訂の履歴 に 改訂 5 の行');
  });

  it('negative control: a minimal document with every label in the section passes', () => {
    const doc = tmpDoc(
      ['# t', '', '## 改訂の履歴', '- 改訂 5: x', '', '## 改訂 5（x）', ...REQUIRED_IN_REV5, '', '## 0. next', ''].join('\n')
    );
    expect(auditRev5(doc)).toEqual([]);
  });
});
