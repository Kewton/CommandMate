/**
 * Issue #3651: the English web app guide names the header's session field the
 * way the English screen draws it.
 *
 * Issue #4218: the trigger now counts every session and reads
 * `worktree.agentStatus.sessions` ("Sessions {count}" / 「セッション {count}」),
 * so the guides write "[Sessions N ▾]" / 「［セッション N ▾］」 — the former
 * "[N more ▾]" (`agentStatus.otherSessions`, now removed) is what the controls
 * flag. The `it` names below are kept from #3651; the label they quote is the
 * one the screen drew then, and each body says what it pins now.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const GUIDE = path.join(process.cwd(), 'docs/en/user-guide/webapp-guide.md');
const GUIDE_JA = path.join(process.cwd(), 'docs/user-guide/webapp-guide.md');
const worktreeDict = (locale: string): string =>
  path.join(process.cwd(), `locales/${locale}/worktree.json`);

/**
 * The "[… N … ▾]" labels a guide writes for the sessions trigger (half- or
 * full-width brackets, so the ja guide's 「［セッション N ▾］」 is read too; returned
 * with half-width brackets so the two widths compare as one label).
 */
function otherSessionsLabels(file: string): string[] {
  const found = fs.readFileSync(file, 'utf8').match(/[[［][^[\]［］\n]*\bN\b[^[\]［］\n]*▾[\]］]/g) ?? [];
  return found.map((label) => `[${label.slice(1, -1)}]`);
}

/** The trigger's label as the screen draws it, with N for the count. */
function screenLabel(locale: 'en' | 'ja' = 'en'): string {
  const dict = JSON.parse(fs.readFileSync(worktreeDict(locale), 'utf8')) as {
    agentStatus: { sessions: string };
  };
  const text = dict.agentStatus.sessions.replace('{count}', 'N');
  return `[${text} ▾]`;
}

describe('English web app guide matches the session field (Issue #3651)', () => {
  let tmp: string | null = null;

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  function copyOf(text: string): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webapp-guide-3651-'));
    const file = path.join(tmp, 'webapp-guide.md');
    fs.writeFileSync(file, text);
    return file;
  }

  // Since #4218: the screen draws "[Sessions N ▾]" (agentStatus.sessions).
  it('the screen draws "[N more ▾]"', () => {
    expect(screenLabel()).toBe('[Sessions N ▾]');
    expect(screenLabel('ja')).toBe('[セッション N ▾]');
  });

  it('the removed other-sessions key is gone from both dictionaries (Issue #4218)', () => {
    for (const locale of ['en', 'ja']) {
      const dict = JSON.parse(fs.readFileSync(worktreeDict(locale), 'utf8')) as {
        agentStatus: Record<string, unknown>;
      };
      expect(dict.agentStatus).not.toHaveProperty('otherSessions');
    }
  });

  it('writes the screen label wherever it names the trigger', () => {
    const labels = otherSessionsLabels(GUIDE);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(new Set(labels)).toEqual(new Set([screenLabel()]));
  });

  it('the Japanese guide writes the Japanese screen label (Issue #4218)', () => {
    const labels = otherSessionsLabels(GUIDE_JA);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(new Set(labels)).toEqual(new Set([screenLabel('ja')]));
  });

  // Since #4218 the former wording is #3651's "[N more ▾]" (and 「［ほか N ▾］」).
  it('flags the former "[N others ▾]" wording (positive control)', () => {
    const file = copyOf('the session field ([current session][N more ▾])\n');
    expect(otherSessionsLabels(file)).not.toContain(screenLabel());
    expect(otherSessionsLabels(file)).toEqual(['[N more ▾]']);
    const ja = copyOf('セッションの欄（［今のセッション］［ほか N ▾］）\n');
    expect(otherSessionsLabels(ja)).not.toContain(screenLabel('ja'));
    expect(otherSessionsLabels(ja)).toEqual(['[ほか N ▾]']);
  });

  it('accepts the screen wording (negative control)', () => {
    const file = copyOf('the [+] right after [Sessions N ▾] at the right end of the header\n');
    expect(otherSessionsLabels(file)).toEqual([screenLabel()]);
    const ja = copyOf('ヘッダー右端の［セッション N ▾］のすぐ右の［＋］\n');
    expect(otherSessionsLabels(ja)).toEqual([screenLabel('ja')]);
  });
});
