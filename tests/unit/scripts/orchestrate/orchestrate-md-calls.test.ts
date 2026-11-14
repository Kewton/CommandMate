/**
 * orchestrate.md calls the PR 2 scripts instead of hand-written commands (Issue #3477).
 *
 * The runbook is executed by an LLM, so a flag the script does not accept fails
 * only during a run. This reads the bash blocks of 3-3 / 5-1 / 6-1-1, checks they
 * parse, and feeds each script call's flags to the script's own parser.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseArgs as parseWaitVerifyArgs } from '../../../../scripts/orchestrate/wait-verify.mjs';
import { parseArgs as parsePrecheckArgs } from '../../../../scripts/orchestrate/precheck.mjs';
import { parseArgs as parsePublishArgs } from '../../../../scripts/orchestrate/publish-pr.mjs';
import { parseArgs as parseMergeArgs } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { parseArgs as parseFlowWipArgs } from '../../../../scripts/orchestrate/flow-wip.mjs';

const orchestrate = fs.readFileSync(path.resolve(__dirname, '../../../../.claude/commands/orchestrate.md'), 'utf8');

/** The body of `### <id>. …`, up to the next `### ` heading. */
function section(id: string): string {
  const lines = orchestrate.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`### ${id}.`));
  expect(start, `no ### ${id}. heading`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('### '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

const bashBlocks = (body: string): string[] => [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);

/** The arguments of `node <script> …` in a block, continuation lines joined and quotes dropped. */
function scriptArgs(block: string, script: string): string[] {
  const joined = block.replace(/\\\n/g, ' ');
  const line = joined.split('\n').find((l) => l.includes(`node ${script} `));
  expect(line, `no call of ${script}`).toBeDefined();
  const rest = (line ?? '').slice((line ?? '').indexOf(script) + script.length).split('#')[0];
  return (rest.match(/"[^"]*"|\S+/g) ?? []).map((token) => token.replace(/^"|"$/g, ''));
}

function parses(block: string): void {
  const result = spawnSync('bash', ['-n'], { input: block, encoding: 'utf-8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

describe('3-3 waits through wait-verify.mjs', () => {
  const block = bashBlocks(section('3-3')).find((b) => b.includes('scripts/orchestrate/wait-verify.mjs')) ?? '';

  it('has a bash block that calls the script and parses', () => {
    expect(block).not.toBe('');
    parses(block);
  });

  it('passes flags the script accepts', () => {
    const parsed = parseWaitVerifyArgs(scriptArgs(block, 'scripts/orchestrate/wait-verify.mjs'));
    expect(parsed.error).toBeUndefined();
    expect(parsed.options).toMatchObject({ instance: '$AGENT', wt: '$WT', taskId: '$TASK_ID' });
  });

  it('no longer hand-writes the wait --verify loop', () => {
    expect(section('3-3')).not.toContain('for each worktree:');
    expect(block).not.toMatch(/commandmatedev wait /);
  });

  it('reads tasks.tsv in the column order 3-1 writes it', () => {
    expect(section('3-1')).toContain(`printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$issue" "$WT" "$AGENT" "$TASK_ID" "$MODEL"`);
    expect(block).toContain('read -r issue WT AGENT TASK_ID MODEL <&3');
  });
});

describe('6-1-1 checks through precheck.mjs before the PR', () => {
  const block = bashBlocks(section('6-1-1')).find((b) => b.includes('scripts/orchestrate/precheck.mjs')) ?? '';

  it('has a bash block that calls the script and parses', () => {
    expect(block).not.toBe('');
    parses(block);
  });

  it('passes flags the script accepts', () => {
    const parsed = parsePrecheckArgs(scriptArgs(block, 'scripts/orchestrate/precheck.mjs'));
    expect(parsed.error).toBeUndefined();
  });

  it('keeps the PR ahead of the slow gates', () => {
    const body = section('6-1-1');
    expect(body).toContain('verify（3-3）→ review（5-2b）→ findings（5-3）→ precheck → PR → CI');
    expect(body).toContain('CI と並走させる');
  });
});

describe('5-1 records a contract-less verify', () => {
  it('appends the verify stage with the HEAD, and the block parses', () => {
    const block = bashBlocks(section('5-1')).find((b) => b.includes('commandmatedev verify "$WT"')) ?? '';
    parses(block);
    expect(block).toContain('scripts/orchestrate/run-log.mjs append');
    expect(block).toContain('--stage verify');
    expect(block).toContain('--head "$(git -C "$WT_DIR" rev-parse HEAD)"');
  });
});

describe('build moved to CI: the merge waits for it (#3477 review 3)', () => {
  it('6-1-1 says build runs beside CI and points at the merge condition', () => {
    const body = section('6-1-1');
    expect(body).toContain('**build は PR の前の確認に入れない（CI の `Build` と並走させる）。**');
    expect(body).toContain('6-2・6-3');
  });

  it('6-2 and 6-3 both require Build pass, or a build=ok precheck for the HEAD being merged', () => {
    for (const id of ['6-2', '6-3']) {
      const body = section(id);
      expect(body, id).toMatch(/`Build` (が|のチェックも) `pass` になってからマージする/);
      expect(body, id).toContain('`build=ok`');
    }
  });

  it('6-3 checks it with a block that parses and reads the run record of this HEAD', () => {
    const block = bashBlocks(section('6-3')).find((b) => b.includes('select(.name == "Build" and .bucket == "pass")')) ?? '';
    expect(block).not.toBe('');
    parses(block);
    expect(block).toContain('.stage == "precheck"');
    expect(block).toContain('.head == $h');
    expect(block).toContain('NOT mergeable');
  });

  it('6-1-1 passes --build through flags precheck.mjs accepts', () => {
    expect(parsePrecheckArgs(['--run-dir', 'r', '--issues', '1', '--issue', '1', '--worktree', '/w', '--build']).options?.build).toBe(true);
  });
});

describe('3-3 says the verdict is confirmed and never reused (#3477 review 1, 2, 4)', () => {
  const body = section('3-3');

  it('documents exit 3 here and in the 3-4 table', () => {
    expect(body).toContain('**3 は「裁定を作業の終わりに結び付けられない」**');
    expect(section('3-4').split('\n').some((line) => line.startsWith('| `3` |'))).toBe(true);
  });

  it('does not offer reuse or --force any more', () => {
    expect(body).toContain('**合格の記録は再利用しない。**');
    expect(body).not.toContain('`--force`');
  });

  it('names the Auto-Yes read-back and the recovery call', () => {
    expect(body).toContain('`autoYes.enabled`');
    expect(body).toContain('wait-verify.mjs --auto-yes-off');
    expect(parseWaitVerifyArgs(['--auto-yes-off', '--wt', 'w', '--instance', 'claude']).error).toBeUndefined();
  });
});

describe('6-1 opens the PR through publish-pr.mjs, 6-2 merges through merge-pr.mjs (#3477 PR 3)', () => {
  const publish = bashBlocks(section('6-1')).find((b) => b.includes('scripts/orchestrate/publish-pr.mjs')) ?? '';
  const merge = bashBlocks(section('6-2')).find((b) => b.includes('scripts/orchestrate/merge-pr.mjs')) ?? '';

  it('has bash blocks that call the scripts and parse', () => {
    expect(publish).not.toBe('');
    expect(merge).not.toBe('');
    parses(publish);
    parses(merge);
  });

  it('passes flags the scripts accept', () => {
    const p = parsePublishArgs(scriptArgs(publish, 'scripts/orchestrate/publish-pr.mjs'));
    expect(p.error).toBeUndefined();
    expect(p.options).toMatchObject({ issue: '$issue', worktree: '$WT_DIR', label: 'feature' });
    const m = parseMergeArgs(scriptArgs(merge, 'scripts/orchestrate/merge-pr.mjs'));
    expect(m.error).toBeUndefined();
    expect(m.options).toMatchObject({ issue: '$issue', worktree: '$WT_DIR', close: '$issue' });
  });

  it('6-2 no longer hand-writes the refresh, and names the flags its comment offers', () => {
    expect(section('6-2')).not.toMatch(/^git fetch origin && git merge origin\/develop/m);
    expect(merge).toContain('--last');
    expect(merge).toContain('--close -');
    expect(parseMergeArgs(['--run-dir', 'r', '--issues', '1', '--issue', '1', '--worktree', '/w', '--last', '--close', '-']).error).toBeUndefined();
  });

  it('Phase 6 states the stop conditions and the no-double-run rule', () => {
    const phase6 = orchestrate.slice(orchestrate.indexOf('## Phase 6'), orchestrate.indexOf('### 6-1.'));
    expect(phase6).toContain('**止まる条件。**');
    expect(phase6).toContain('`review` 段に `skip` を記録しておく');
    expect(phase6).toContain('**二重に実行しない。**');
  });

  it('6-4 reads the fragment from the run directory copy publish-pr.mjs makes', () => {
    expect(section('6-4')).toContain('cat "workspace/orchestration/runs/$DATE/module-reference-<N>.md"');
  });
});

describe('Phase 6 after the review of PR 3 (#3477)', () => {
  it('names the precheck of the published HEAD, the shared rule and the body references', () => {
    const phase6 = orchestrate.slice(orchestrate.indexOf('## Phase 6'), orchestrate.indexOf('### 6-1.'));
    expect(phase6).toContain('**公開する HEAD**');
    expect(phase6).toContain('`unmetStage`');
    expect(phase6).toContain('`Closes #<N>`');
  });

  it('6-3 waives Build only with the three build steps, in a block that still parses', () => {
    const block = bashBlocks(section('6-3')).find((b) => b.includes('NOT mergeable')) ?? '';
    parses(block);
    for (const step of ['build=ok', 'build-cli=ok', 'build-server=ok']) expect(block).toContain(step);
  });

  it('6-2 waits for Unit Tests on a contract that did not run the whole suite', () => {
    expect(section('6-2')).toContain('整理の契約（`lint`・`typecheck` だけ、2-4-3）も同じ');
    expect(section('6-2')).toContain('`vitest related --dir tests/unit`');
  });
});

describe('1-5 asks flow-wip once, before assign.tsv takes a new lane (#4368 PR1, R7)', () => {
  const docs = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../../../docs/orchestrate', file), 'utf8');
  /** The `## <heading>` section of a document, up to the next `## `. */
  const docSection = (text: string, heading: string): string => {
    const start = text.indexOf(`\n## ${heading}\n`);
    expect(start, `no ## ${heading}`).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n## ', start + 1);
    return text.slice(start, end === -1 ? undefined : end);
  };
  const plan = section('1-5');
  const block = bashBlocks(plan).find((b) => b.includes('scripts/orchestrate/flow-wip.mjs')) ?? '';
  const workers = docSection(docs('workers.md'), '1-5 WIP の照会');
  /** The flags up to the redirection of stdout. */
  const flags = (b: string) => {
    const all = scriptArgs(b, 'scripts/orchestrate/flow-wip.mjs');
    const end = all.indexOf('>');
    return end === -1 ? all : all.slice(0, end);
  };
  const exitCodes = docSection(docs('exit-codes.md'), '1-5 flow-wip check の 60 / 61 / 2');

  it('has a bash block in 1-5 that calls check and parses', () => {
    expect(block).not.toBe('');
    parses(block);
  });

  it('passes flags flow-wip.mjs accepts: check, --worktree ., --json', () => {
    const parsed = parseFlowWipArgs(flags(block));
    expect('error' in parsed).toBe(false);
    expect(parsed).toEqual({ options: expect.objectContaining({ command: 'check', worktree: '.', json: true }) });
  });

  it('1-5 is the only reader: 2-2, 3-1 and 3-3 do not call it, and no run-log record stands for it', () => {
    for (const id of ['2-2', '3-1', '3-3']) expect(section(id), id).not.toContain('flow-wip');
    expect(orchestrate.split('flow-wip.mjs check').length - 1).toBe(1);
    expect(orchestrate).not.toMatch(/--note "wip=/);
    expect(workers).not.toMatch(/run-log\.mjs append/);
  });

  it('1-5 says anything but 0 keeps every new lane out of assign.tsv and into plan.md 見送り', () => {
    expect(plan).toContain('assign.tsv に入れる前に 1 回だけ');
    expect(plan).toContain('0 は助言（許可・予約ではない）。0 以外は新しいレーンを入れず plan.md の「見送り」へ');
    expect(section('2-2')).toContain('assign.tsv の各 Issue（見送りは除く）');
  });

  it('workers.md: the block parses, any non-zero exit is no room, and the guarantee is stated', () => {
    const wblock = bashBlocks(workers).find((b) => b.includes('flow-wip.mjs check')) ?? '';
    parses(wblock);
    expect(wblock).toContain('ROOM=0');
    expect(parseFlowWipArgs(flags(wblock))).not.toHaveProperty('error');
    expect(workers).toContain('**助言で、許可・予約ではない**');
    expect(workers).toContain('**同時の照会の上限は保証しない**');
    expect(workers).toContain('Issue・担当・モデル');
    expect(workers).toContain('次の計画（1-5）で、`check` をやり直してから');
    expect(workers).toContain('**すべて** `assign.tsv` に入れない');
  });

  it('2-2 creates worktrees only for the first column of assign.tsv, not for the whole issue_numbers (review P2)', () => {
    const setup = bashBlocks(section('2-2')).find((b) => b.includes('/worktree-setup')) ?? '';
    expect(setup).toContain('/worktree-setup $(cut -f1 "workspace/orchestration/runs/$DATE/assign.tsv")');
    expect(section('2-2')).not.toContain('{issue_numbers}');
    parses(setup);
    expect(section('2-4')).toContain('assign.tsv の各 Issue について');
  });

  it('Phase 2.5 sends the analysis only for bug Issues still in assign.tsv (review P3)', () => {
    const phase25 = orchestrate.slice(orchestrate.indexOf('## Phase 2.5'), orchestrate.indexOf('### 2.5-1.'));
    expect(phase25).toContain('分類されたIssue（見送りは除く）');
    // The block holds `## Issue内容` inside the fence, so read it from the whole document.
    const send = bashBlocks(docs('workers.md')).find((b) => b.includes('for bug_issue in $BUG_ISSUES')) ?? '';
    expect(send).not.toBe('');
    parses(send);
    const filter = send.indexOf('cut -f1 "workspace/orchestration/runs/$DATE/assign.tsv"');
    expect(filter).toBeGreaterThan(-1);
    expect(filter).toBeLessThan(send.indexOf('for bug_issue in $BUG_ISSUES'));
    expect(workers).toContain('2.5 の分析の送信・3-1・3-3）に入らない');
  });

  it('exit-codes.md has a row for 0, 60, 61, 2 and the rest', () => {
    for (const code of ['0', '60', '61', '2', '1']) {
      expect(exitCodes.split('\n').some((line) => line.startsWith(`| \`${code}\``)), code).toBe(true);
    }
  });
});
