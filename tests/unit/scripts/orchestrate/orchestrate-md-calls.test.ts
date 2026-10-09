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
