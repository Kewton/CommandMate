/**
 * Issue #3651 (second pass): what the removed `WorktreeCard` left behind.
 *
 * - The English UI/UX guide names the other-sessions trigger as the English
 *   screen draws it ("[N more ▾]", `worktree.agentStatus.otherSessions`).
 * - The sidebar status doc no longer points at `WorktreeCard`.
 * - The `worktree.card.*` keys only `WorktreeCard` read are gone, from en and ja.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = process.cwd();
const UI_UX_GUIDE_EN = path.join(ROOT, 'docs/en/UI_UX_GUIDE.md');
const STATUS_DOC = path.join(ROOT, 'docs/features/sidebar-status-indicator.md');
const worktreeDict = (locale: string): string => path.join(ROOT, `locales/${locale}/worktree.json`);

/** The "[N … ▾]" labels a doc writes for the other-sessions trigger. */
function otherSessionsLabels(file: string): string[] {
  return fs.readFileSync(file, 'utf8').match(/\[N [^\]\n]*▾\]/g) ?? [];
}

function mentionsWorktreeCard(file: string): boolean {
  return /\bWorktreeCard\b/.test(fs.readFileSync(file, 'utf8'));
}

function hasCardGroup(file: string): boolean {
  return 'card' in (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>);
}

describe('WorktreeCard leftovers (Issue #3651)', () => {
  let tmp: string | null = null;

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  function tmpFile(name: string, text: string): string {
    tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-card-3651-'));
    const file = path.join(tmp, name);
    fs.writeFileSync(file, text);
    return file;
  }

  it('the English UI/UX guide writes "[N more ▾]" for the session field', () => {
    const labels = otherSessionsLabels(UI_UX_GUIDE_EN);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(new Set(labels)).toEqual(new Set(['[N more ▾]']));
  });

  it('the sidebar status doc does not point at the removed WorktreeCard', () => {
    expect(mentionsWorktreeCard(STATUS_DOC)).toBe(false);
  });

  it.each(['en', 'ja'])('the %s worktree dictionary has no card group', (locale) => {
    expect(hasCardGroup(worktreeDict(locale))).toBe(false);
  });

  it('flags the former wording, mention and keys (positive control)', () => {
    expect(otherSessionsLabels(tmpFile('guide.md', '[current session][N others ▾][+]\n'))).toEqual([
      '[N others ▾]',
    ]);
    expect(mentionsWorktreeCard(tmpFile('status.md', 'サイドバー行と `WorktreeCard` に出す\n'))).toBe(true);
    expect(hasCardGroup(tmpFile('worktree.json', '{"card":{"main":"Main"},"detail":{}}'))).toBe(true);
  });

  it('accepts the current wording, text and keys (negative control)', () => {
    expect(otherSessionsLabels(tmpFile('guide.md', '[current session][N more ▾][+]\n'))).toEqual([
      '[N more ▾]',
    ]);
    expect(mentionsWorktreeCard(tmpFile('status.md', 'サイドバー行と詳細ヘッダーに出す\n'))).toBe(false);
    expect(hasCardGroup(tmpFile('worktree.json', '{"detail":{}}'))).toBe(false);
  });
});
