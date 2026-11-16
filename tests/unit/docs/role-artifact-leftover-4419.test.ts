/**
 * Issue #4419 (event 2, PR2, docs only): deleting a role leaves the Antigravity
 * definition it generated (`~/.gemini/config/agents/cm-role-<namespace>-<role id>-<fingerprint>/agent.md`).
 * The guides say so and how to remove it by hand; the design records why nothing
 * cleans it up automatically. Positive control: a text without the sentences fails;
 * negative control: a text that carries them passes and does not promise automatic cleanup.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

const GUIDES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  [
    'docs/user-guide/cli-operations-guide.md',
    ['cm-role-<名前空間>-<ロール id>-<指紋>/agent.md', '~/.gemini/config/agents/', '自動では消えません', '使う instance をすべて止め', 'Schedule', '`commandmate roles list`', 'SHA-256 の先頭 8 桁', '特定できないもの', '目印にはなりません'],
  ],
  [
    'docs/en/user-guide/cli-operations-guide.md',
    ['cm-role-<namespace>-<role id>-<fingerprint>/agent.md', '~/.gemini/config/agents/', 'is not removed automatically', 'stop every instance that uses the role', 'Schedule', '`commandmate roles list`', 'SHA-256 of the DB path', 'cannot identify', 'is not a marker'],
  ],
  ['docs/user-guide/webapp-guide.md', ['~/.gemini/config/agents/', '自動では消えません', 'Schedule', '特定できないものは消しません']],
  ['docs/en/user-guide/webapp-guide.md', ['~/.gemini/config/agents/', 'not removed automatically', 'Schedule', 'leave anything you cannot identify']],
  ['docs/design/agy-role-default-4385.md', ['削除時に片付けない理由', '別 Issue', 'Schedule', '名前で特定できないものは消さない']],
];

/** Words a guide must carry and must not (the cleanup is not automatic). */
export function findings(text: string, required: ReadonlyArray<string>): string[] {
  const missing = required.filter((w) => !text.includes(w));
  const promises = /ロールの削除で[^。]*(自動で|まとめて)消え|deleting a role removes the definition/i.test(text);
  return promises ? [...missing, 'promises automatic cleanup'] : missing;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('#4419 role artifact leftover is documented', () => {
  for (const [file, words] of GUIDES) {
    it(`${file} says the artifact stays and how to remove it`, () => {
      expect(findings(fs.readFileSync(path.join(ROOT, file), 'utf8'), words)).toEqual([]);
    });
  }

  it('positive control: a text without the sentences is reported', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-4419-'));
    dirs.push(dir);
    const f = path.join(dir, 'g.md');
    fs.writeFileSync(f, 'roles rm removes the role.\n');
    expect(findings(fs.readFileSync(f, 'utf8'), GUIDES[1][1]).length).toBeGreaterThan(0);
  });

  it('negative control: a text that promises automatic cleanup is reported', () => {
    expect(findings('ロールの削除で自動で消えます', [])).toEqual(['promises automatic cleanup']);
    expect(findings('fine', [])).toEqual([]);
  });
});
