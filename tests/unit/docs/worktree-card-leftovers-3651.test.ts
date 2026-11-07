/**
 * Issue #3651 (second pass): what the removed `WorktreeCard` left behind.
 *
 * - The English UI/UX guide names the sessions trigger as the English screen
 *   draws it. Issue #4218: "[Sessions N ▾]" (`worktree.agentStatus.sessions`,
 *   every session counted); the former "[N more ▾]" (`agentStatus.otherSessions`,
 *   removed) is what the controls flag. The `it` names are kept from #3651.
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
const UI_UX_GUIDE_JA = path.join(ROOT, 'docs/UI_UX_GUIDE.md');
const worktreeDict = (locale: string): string => path.join(ROOT, `locales/${locale}/worktree.json`);

/** The "[… N … ▾]" labels a doc writes for the sessions trigger (half- or full-width brackets,
 * read as half-width). */
function otherSessionsLabels(file: string): string[] {
  const found = fs.readFileSync(file, 'utf8').match(/[[［][^[\]［］\n]*\bN\b[^[\]［］\n]*▾[\]］]/g) ?? [];
  return found.map((label) => `[${label.slice(1, -1)}]`);
}

/** The trigger's label as the screen draws it (`agentStatus.sessions`), with N for the count. */
function screenLabel(locale: 'en' | 'ja'): string {
  const dict = JSON.parse(fs.readFileSync(worktreeDict(locale), 'utf8')) as {
    agentStatus: { sessions: string };
  };
  const text = dict.agentStatus.sessions.replace('{count}', 'N');
  return `[${text} ▾]`;
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

  // Since #4218: the label is the screen's "[Sessions N ▾]".
  it('the English UI/UX guide writes "[N more ▾]" for the session field', () => {
    expect(screenLabel('en')).toBe('[Sessions N ▾]');
    const labels = otherSessionsLabels(UI_UX_GUIDE_EN);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(new Set(labels)).toEqual(new Set([screenLabel('en')]));
  });

  it('the Japanese UI/UX guide writes the Japanese screen label (Issue #4218)', () => {
    expect(screenLabel('ja')).toBe('[セッション N ▾]');
    const labels = otherSessionsLabels(UI_UX_GUIDE_JA);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(new Set(labels)).toEqual(new Set([screenLabel('ja')]));
  });

  it('the sidebar status doc does not point at the removed WorktreeCard', () => {
    expect(mentionsWorktreeCard(STATUS_DOC)).toBe(false);
  });

  it.each(['en', 'ja'])('the %s worktree dictionary has no card group', (locale) => {
    expect(hasCardGroup(worktreeDict(locale))).toBe(false);
  });

  it('flags the former wording, mention and keys (positive control)', () => {
    // Since #4218 the former wording is "[N more ▾]" / 「［ほか N ▾］」.
    expect(otherSessionsLabels(tmpFile('guide.md', '[current session][N more ▾][+]\n'))).toEqual([
      '[N more ▾]',
    ]);
    expect(otherSessionsLabels(tmpFile('guide-ja.md', '［今のセッション］［ほか N ▾］［＋］\n'))).not.toContain(
      screenLabel('ja'),
    );
    expect(mentionsWorktreeCard(tmpFile('status.md', 'サイドバー行と `WorktreeCard` に出す\n'))).toBe(true);
    expect(hasCardGroup(tmpFile('worktree.json', '{"card":{"main":"Main"},"detail":{}}'))).toBe(true);
  });

  it('accepts the current wording, text and keys (negative control)', () => {
    expect(otherSessionsLabels(tmpFile('guide.md', '[Sessions N ▾][+][End][Update][Info]\n'))).toEqual([
      screenLabel('en'),
    ]);
    expect(otherSessionsLabels(tmpFile('guide-ja.md', '［セッション N ▾］［＋］［終了］\n'))).toEqual([
      screenLabel('ja'),
    ]);
    expect(mentionsWorktreeCard(tmpFile('status.md', 'サイドバー行と詳細ヘッダーに出す\n'))).toBe(false);
    expect(hasCardGroup(tmpFile('worktree.json', '{"detail":{}}'))).toBe(false);
  });
});
