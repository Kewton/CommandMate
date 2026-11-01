/**
 * The work HEAD is defined once, in docs/orchestrate/run-log.md 1-5 (#4076,
 * #4085): a merge the worker resolved, or any commit with its own `verify`
 * record, can be the work HEAD. Other places only point there; they must not
 * keep the older wording ("the worker's last commit", "the file rule alone"),
 * which tells the reader M's own records are never needed.
 *
 * Positive control: the same check on the files as they were in 2969949
 * (read with `git show`, nothing in the repo is rewritten) finds the stale
 * wording. Negative control: run-log.md still holds the definition.
 *
 * @vitest-environment node
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
const BEFORE = '2969949ea';

const STALE: Record<string, RegExp> = {
  'docs/design/task-contract.md': /workHeads` はファイルの規則だけで判定/,
  '.claude/commands/uat-fix-loop.md': /ワーカーの最後のコミット（作業の HEAD）/,
  'scripts/orchestrate/pr-common.mjs': /file rule alone/,
};

const REFERENCE: Record<string, RegExp> = {
  'docs/design/task-contract.md': /run-log\.md#1-5-/,
  '.claude/commands/uat-fix-loop.md': /run-log\.md` 1-5/,
  'scripts/orchestrate/pr-common.mjs': /run-log\.md 1-5/,
};

function current(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

function before(file: string): string | null {
  try {
    return execFileSync('git', ['show', `${BEFORE}:${file}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // shallow clone without 2969949: the control cannot run
  }
}

describe('work HEAD wording points at run-log.md 1-5 (#4085)', () => {
  for (const file of Object.keys(STALE)) {
    it(`${file} has no stale wording and refers to the definition`, () => {
      const text = current(file);
      expect(text).not.toMatch(STALE[file]);
      expect(text).toMatch(REFERENCE[file]);
    });

    it(`${file} had the stale wording before the fix (positive control)`, () => {
      const old = before(file);
      if (old === null) return;
      expect(old).toMatch(STALE[file]);
    });
  }

  it('run-log.md 1-5 still defines merges and verify records as work HEADs (negative control)', () => {
    const text = current('docs/orchestrate/run-log.md');
    expect(text).toMatch(/## 1-5 記録の中身と next の決まり/);
    expect(text).toMatch(/そのコミット自身に `verify` の記録/);
    expect(text).toMatch(/M 自身の `verify` \/ `review` \/ `findings` が要る/);
  });
});
