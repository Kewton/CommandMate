/**
 * 「設計」と「転記」の線引き、および Phase 2.5 のスキップ条件（Issue #2784）
 *
 * ## 何を固定するか
 *
 * 1. **1-2b の「設計」の行は、ワーカーが設計する場合に限る。** 以前の文面は成果物の形
 *    （「新規のガード・テストを 1 本まるごと」）だけを見ており、**本文にテスト全文がある Issue まで
 *    「難」に落とす**ように読めた。実測では、全文つきの新規ガードテストを 3 本とも
 *    Antigravity が再指示 0 で通している（#2770 / #2780 / #2781）。
 *
 * 2. **Phase 2.5 のスキップ条件。** 以前はラベルだけで振り分けており、原因が file:line で
 *    特定済みの `bug` Issue でも根本原因分析を委譲することになっていた。2.5 の成果物
 *    （再現パス・根本原因・対策案）が本文に既にあるなら、書き直させるだけである。
 *
 * どちらも散文の判定基準で、間違って読まれても何も落ちない。手順書は LLM が実行するので、
 * これが唯一の検出器になる（`orchestrate-merge-gate-consistency.test.ts` と同じ理由）。
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ORCHESTRATE_PATH = '.claude/commands/orchestrate.md';
const orchestrate = readFileSync(path.join(REPO_ROOT, ORCHESTRATE_PATH), 'utf-8');

/** The `| 観点 | 条件 |` row of the 1-2b difficulty table whose first cell is `label`. */
function criterionRow(label: string): string {
  const rows = orchestrate
    .split('\n')
    .filter((line) => line.startsWith(`| ${label} |`));
  expect(rows, `no 1-2b row labelled ${label}`).toHaveLength(1);
  return rows[0];
}

/** The body of `## <heading>`, up to the next `## ` heading. */
function phase(heading: string): string {
  const lines = orchestrate.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${heading}`));
  expect(start, `${ORCHESTRATE_PATH} has no \`## ${heading}\``).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n');
  expect(body.trim().length, `${heading} is empty`).toBeGreaterThan(200);
  return body;
}

describe('[#2784] 1-2b: the 設計 criterion is about who designs', () => {
  const row = criterionRow('設計');

  it('says the WORKER is the one designing', () => {
    expect(row).toMatch(/\*\*ワーカーが\*\*新規のガード・テスト/);
    expect(row).toMatch(/\*\*設計して\*\*書く/);
  });

  it('excludes transcription outright', () => {
    expect(row).toMatch(/本文にテスト全文があるなら転記であって設計ではない/);
    expect(row).toMatch(/この行には当てはまらない/);
  });

  it('keeps the existing carve-out for assert additions', () => {
    expect(row).toMatch(/既存テストへの assert 追加・書き換え/);
  });

  it('still names what designing actually means, so the row is not toothless', () => {
    expect(row).toMatch(/構造で対象を特定する/);
    expect(row).toMatch(/陽性\/陰性対照を置く/);
  });
});

describe('[#2784] 1-2b: the evidence for the line is recorded', () => {
  const body = orchestrate.slice(orchestrate.indexOf('### 1-2b.'), orchestrate.indexOf('### 1-3.'));

  it('names all three issues that landed with a full-text guard test', () => {
    for (const issue of ['#2770', '#2780', '#2781']) {
      expect(body, `${issue} missing from the 1-2b evidence`).toContain(issue);
    }
  });

  it('records that all three needed zero re-instructions', () => {
    const rows = body.split('\n').filter((l) => /^\| #27(70|80|81) \|/.test(l));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatch(/antigravity/);
      expect(row).toMatch(/再指示 0/);
    }
  });

  it('keeps the boundary that was NOT raised (designing a guard from scratch)', () => {
    expect(body).toMatch(/\*\*上げていない\*\*/);
    expect(body).toMatch(/新規ガードを 1 本まるごと書く/);
  });

  it('says who pays for the full text, so the line is not read as a loosening', () => {
    expect(body).toMatch(/全文を書くコストは起票側が負っている/);
    expect(body).toMatch(/全文が無い Issue は従来どおり「難」/);
  });
});

describe('[#2784] Phase 2.5: a bug whose cause is already known is skipped', () => {
  const body = phase('Phase 2.5');

  it('states the skip condition', () => {
    expect(body).toMatch(/`bug` ラベルでも、本文に原因（`file:line`）と対策が既に書かれているならスキップする/);
  });

  it('reuses 1-2b’s 原因 criterion rather than inventing a new one', () => {
    expect(body).toMatch(/1-2b の「原因」の観点と同じ基準/);
    expect(body).toContain('バグで、原因が file:line まで特定されていない');
  });

  it('says why: the three deliverables would only be rewritten', () => {
    expect(body).toMatch(/再現パスの特定・根本原因・対策案/);
    expect(body).toMatch(/書き直させるだけ/);
  });

  it('requires the skip to be recorded in plan.md', () => {
    expect(body).toMatch(/plan\.md に 1 行残す/);
  });

  it('keeps the original feature-issue skip', () => {
    expect(body).toMatch(/機能Issue（FEATURE_ISSUES）はこのフェーズをスキップする/);
  });
});

describe('[#2784] the 原因 criterion the skip leans on still exists', () => {
  it('1-2b still has the 原因 row, worded as the skip quotes it', () => {
    expect(criterionRow('原因')).toContain('バグで、原因が file:line まで特定されていない');
  });
});
