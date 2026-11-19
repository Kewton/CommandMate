/**
 * Worker allocation: easy and middle go to Command Code, hard goes to Claude opus
 * (Issue #4507, decided 2026-11-19).
 *
 * The runbook is executed by an LLM, so a rule that says one thing in 1-2b and
 * another in 3-5 / Phase 0 / 8-2 changes nothing at run time. This pins the
 * three parts of the decision:
 *
 *  1. Command Code takes everything that is not one of the hard criteria; the
 *     middle tier (a judgment or a design closed in the body) moves to Command
 *     Code too, and the old "every replacement code is fixed in the body"
 *     condition stops being the gate. The hard criteria themselves stay.
 *  2. Two worker-caused failures raise a Command Code Issue to opus. sonnet is
 *     only a stand-in for a Command Code that cannot start or send, with the
 *     reason in the lead-return.
 *  3. Before starting, the enabler closes the Issue on options, procedure and
 *     acceptance criteria; the 60-80% target and the per-Sprint model mix are
 *     counted in the lead-return and the ledger.
 *
 * Controls run against copies under os.tmpdir(); the repository files are never
 * rewritten.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

interface Docs {
  orchestrate: string;
  difficulty: string;
  commandCode: string;
  team: string;
}

const DOC_PATHS = {
  orchestrate: '.claude/commands/orchestrate.md',
  difficulty: 'docs/orchestrate/difficulty.md',
  commandCode: 'docs/orchestrate/command-code.md',
  team: 'docs/orchestrate/team.md',
} as const;

function readDocs(root: string): Docs {
  return {
    orchestrate: fs.readFileSync(path.join(root, DOC_PATHS.orchestrate), 'utf8'),
    difficulty: fs.readFileSync(path.join(root, DOC_PATHS.difficulty), 'utf8'),
    commandCode: fs.readFileSync(path.join(root, DOC_PATHS.commandCode), 'utf8'),
    team: fs.readFileSync(path.join(root, DOC_PATHS.team), 'utf8'),
  };
}

/** The body of `### <id>. …`, up to the next `### ` heading. */
function section(markdown: string, id: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`### ${id}.`));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('### '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** The `| <label> | …` row of 1-2b's criteria table, or '' when the row is gone. */
function tableRow(markdown: string, label: string): string {
  return markdown.split('\n').find((line) => line.startsWith(`| ${label} |`)) ?? '';
}

/** What the 2026-11-19 decision requires, as a list of problems (empty when the docs agree). */
function allocationProblems(docs: Docs): string[] {
  const problems: string[] = [];
  const body = section(docs.orchestrate, '1-2b');
  const phase0 = docs.orchestrate.slice(docs.orchestrate.indexOf('## Phase 0'), docs.orchestrate.indexOf('## Phase 1'));
  const raise = section(docs.orchestrate, '3-5');
  const workerRow = docs.team.split('\n').find((line) => line.startsWith('| ワーカー')) ?? '';

  if (!body) return ['orchestrate.md has no 1-2b section'];

  // 1. The middle tier is Command Code, and closure — not a fixed diff — is the condition.
  if (!/^\| 中 \| command-code \| —/m.test(body)) problems.push('the middle tier is not command-code');
  if (/^\| 中 \| claude \| sonnet/m.test(body)) problems.push('the middle tier still goes to sonnet');
  if (!body.includes('選択肢か手順と受入条件が本文で閉じている')) problems.push('the closed-body condition is missing');
  if (body.includes('変更する全箇所が `file:line` ＋「置換後のコード」')) {
    problems.push('the old fixed-diff condition still gates Command Code');
  }

  // Pin the hard criteria as the table rows themselves. Matching a bare word
  // let 「閉じた設計」 keep 「設計」 alive after the row was gone (#4507 review).
  const hardRows: Array<[string, string]> = [
    ['危険な領域', '`src/lib/tmux/**`'],
    ['危険な領域', 'セッション'],
    ['危険な領域', '`src/lib/detection/**`'],
    ['危険な領域', '`src/lib/polling/**`'],
    ['危険な領域', 'hooks'],
    ['危険な領域', '`src/lib/security/**`'],
    ['危険な領域', 'DB migration'],
    ['危険な領域', '`src/lib/cli-tools/**`'],
    ['危険な領域', 'ws-server'],
    ['判断の余地', '本文に選択肢か手順と受入条件が閉じていない判断が 1 つでもある'],
    ['設計', '新規のガード・テストを 1 本まるごと**設計して**書く'],
    ['原因', '原因が file:line まで特定されていない'],
    ['未決事項', '「要調査」「未決」「実機で決める」などが残っている'],
    ['検証', '画面・実機でしか決まらない'],
    ['依存', '同じ関数の書き換えを伴う'],
    ['新規 export', '新しいモジュールや公開関数を作り'],
  ];
  for (const [label, condition] of hardRows) {
    const row = tableRow(body, label);
    if (!row) problems.push(`the hard criterion row is missing: ${label}`);
    else if (!row.includes(condition)) {
      problems.push(`the hard criterion row lost its condition: ${label}: ${condition}`);
    }
  }

  // A closed judgment is the middle tier; a design (a whole new guard or test)
  // stays opus under the 設計 row. The bullet that says what Command Code takes
  // must not read 「判断・設計」 either (the review's P1, orchestrate.md:187).
  const bullet = body
    .split('\n')
    .find((line) => line.startsWith('- **選択肢か手順と受入条件が本文で閉じている**')) ?? '';
  if (!bullet) problems.push('the closed-body bullet is missing');
  if (bullet.includes('設計')) problems.push('the Command Code bullet admits a design');
  const middle = tableRow(body, '中');
  if (!middle.includes('「閉じた判断」')) problems.push('the middle tier does not take a closed judgment');
  if (middle.includes('閉じた設計')) problems.push('the middle tier admits a closed design');
  if (!middle.includes('「設計」')) problems.push('the middle tier does not exclude design');

  if (!body.includes('逸脱時の退避路')) problems.push('the retreat rule is missing');

  // 3. The enabler closes the body, and the target share is counted.
  if (!body.includes('イネーブラー')) problems.push('1-2b does not name the enabler stage');
  if (!body.includes('選択肢・手順・受入条件')) problems.push('the enabler stage does not close options/procedure/acceptance');
  if (!body.includes('6〜8 割')) problems.push('the 60-80% target is missing');
  if (!body.includes('lead-return') || !body.includes('台帳')) problems.push('the share is not counted in the lead-return and the ledger');

  // 2. Two failures raise to opus; sonnet is only the startup/send stand-in.
  if (!raise.includes('opus')) problems.push('3-5 does not raise to opus');
  if (!raise.includes('2 回')) problems.push('3-5 does not name the two-failure threshold');
  if (!raise.includes('起動・送信')) problems.push('3-5 does not limit sonnet to a startup/send stand-in');
  if (!raise.includes('lead-return')) problems.push('3-5 does not record the sonnet reason in the lead-return');
  if (!phase0.includes('易・中 → `--instance command-code`')) problems.push('Phase 0 does not send easy and middle to command-code');
  if (!phase0.includes('Command Code がワーカー起因で 2 回不合格になったら opus に上げる')) {
    problems.push('Phase 0 does not raise Command Code to opus');
  }

  // The rationale is kept, and the new reason and measurements are added.
  if (!docs.difficulty.includes('2026-11-19 に変えた理由')) problems.push('difficulty.md has no 2026-11-19 reason');
  for (const kept of ['確定 diff', '#2605', '#2622', '道具']) {
    if (!docs.difficulty.includes(kept)) problems.push(`difficulty.md dropped the old rationale: ${kept}`);
  }
  if (!docs.difficulty.includes('変えた後に測るもの')) problems.push('difficulty.md does not say what to measure');

  // The other two documents say the same.
  if (!workerRow.includes('易・中＝Command Code')) problems.push('team.md does not give easy and middle to Command Code');
  if (!workerRow.includes('難＝Claude opus')) problems.push('team.md does not give hard to Claude opus');
  if (!docs.commandCode.includes('opus')) problems.push('command-code.md does not mention opus');
  if (!docs.commandCode.includes('中')) problems.push('command-code.md does not cover the middle tier');

  return problems;
}

describe('Issue #4507: the allocation rule', () => {
  it('the repository documents follow the 2026-11-19 decision', () => {
    expect(allocationProblems(readDocs(REPO_ROOT))).toEqual([]);
  });

  describe('controls (copies under os.tmpdir())', () => {
    let root: string | undefined;

    afterEach(() => {
      if (root) fs.rmSync(root, { recursive: true, force: true });
      root = undefined;
    });

    /** Write the four documents under a temporary root, with `orchestrate` optionally replaced. */
    function copyDocs(orchestrate?: (text: string) => string): Docs {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-worker-policy-4507-'));
      const docs = readDocs(REPO_ROOT);
      const written: Docs = {
        orchestrate: orchestrate ? orchestrate(docs.orchestrate) : docs.orchestrate,
        difficulty: docs.difficulty,
        commandCode: docs.commandCode,
        team: docs.team,
      };
      for (const [key, relative] of Object.entries(DOC_PATHS) as [keyof Docs, string][]) {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, written[key]);
      }
      return readDocs(root);
    }

    it('positive: putting the middle tier back on sonnet is reported', () => {
      const docs = copyDocs((text) => text.replace('| 中 | command-code | —', '| 中 | claude | sonnet |'));
      expect(allocationProblems(docs)).toContain('the middle tier still goes to sonnet');
    });

    it('positive: dropping the enabler stage is reported', () => {
      const docs = copyDocs((text) => text.replace(/イネーブラー/g, '担当者'));
      expect(allocationProblems(docs)).toContain('1-2b does not name the enabler stage');
    });

    it('positive: dropping the dangerous areas is reported', () => {
      const docs = copyDocs((text) => text.replace('src/lib/tmux/**', 'tmux'));
      expect(allocationProblems(docs)).toContain('the hard criterion row lost its condition: 危険な領域: `src/lib/tmux/**`');
    });

    it('positive: dropping the 設計 row is reported', () => {
      const docs = copyDocs((text) => text.replace(/^\| 設計 \|.*\n/m, ''));
      expect(allocationProblems(docs)).toContain('the hard criterion row is missing: 設計');
    });

    it('positive: admitting a closed design to the middle tier is reported', () => {
      const docs = copyDocs((text) => text.replace('**「閉じた判断」だけ**', '**「閉じた判断」「閉じた設計」だけ**'));
      expect(allocationProblems(docs)).toContain('the middle tier admits a closed design');
    });

    it('positive: admitting a design in the Command Code bullet is reported', () => {
      const docs = copyDocs((text) => text.replace('本文に閉じた判断も', '本文に閉じた判断・設計も'));
      expect(allocationProblems(docs)).toContain('the Command Code bullet admits a design');
    });
  });
});
