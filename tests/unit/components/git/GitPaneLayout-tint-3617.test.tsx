/**
 * The Git pane's read groups are a faint sky tint, not an opaque info fill
 * (Issue #3617).
 *
 * #818 B tinted the read groups (`git-group-read`, `git-group-history`) with
 * `bg-sky-50/40 dark:bg-sky-950/20` and `/30` + `/10`. #1140 swapped both for
 * the opaque `bg-info-subtle`, so in dark the pane — mostly the `flex-1`
 * history group — turned solid blue-950. The groups now carry an opacity
 * modifier again; `--info-subtle` itself is untouched, so the Toast (an info
 * alert surface, the token's own use) keeps the opaque fill.
 *
 * @vitest-environment jsdom
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import React from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GitPaneLayout } from '@/components/worktree/git/GitPaneLayout';
import { GitPaneProvider, type GitPaneContextValue } from '@/components/worktree/git/GitPaneContext';
import { Toast } from '@/components/common/Toast';

/** Every `bg-info-subtle…` utility in a class string (with its variant prefix). */
function infoSubtleBackgrounds(classes: string): string[] {
  return classes.split(/\s+/).filter((c) => /^(dark:)?bg-info-subtle(\/\d+)?$/.test(c));
}

/** True when the class string paints the opaque token (no opacity modifier). */
function paintsOpaqueInfoSubtle(classes: string): boolean {
  return infoSubtleBackgrounds(classes).some((c) => !c.includes('/'));
}

function renderDesktop() {
  const value: GitPaneContextValue = { isMobile: false, onDiffSelect: vi.fn(), onInsertToMessage: vi.fn() };
  return render(
    <GitPaneProvider value={value}>
      <GitPaneLayout
        activeTab="status"
        onTabChange={vi.fn()}
        statusSection={<div />}
        quickActionsSection={<div />}
        changesSection={<div />}
        historySection={<div />}
        advancedSection={<div />}
      />
    </GitPaneProvider>,
  );
}

describe('GitPaneLayout read groups — faint tint (Issue #3617)', () => {
  it.each(['git-group-read', 'git-group-history'])(
    '%s uses bg-info-subtle with an opacity modifier in light and dark',
    (testId) => {
      renderDesktop();
      const classes = screen.getByTestId(testId).className;
      expect(paintsOpaqueInfoSubtle(classes)).toBe(false);
      const tints = infoSubtleBackgrounds(classes);
      expect(tints.some((c) => /^bg-info-subtle\/\d+$/.test(c))).toBe(true);
      expect(tints.some((c) => /^dark:bg-info-subtle\/\d+$/.test(c))).toBe(true);
    },
  );

  it('keeps the dark tint fainter than the light one (dark ≤ 20%)', () => {
    renderDesktop();
    for (const testId of ['git-group-read', 'git-group-history']) {
      const dark = infoSubtleBackgrounds(screen.getByTestId(testId).className).find((c) =>
        c.startsWith('dark:'),
      )!;
      expect(Number(dark.split('/')[1])).toBeLessThanOrEqual(20);
    }
  });

  it('leaves the write / advanced groups on their neutral muted tint', () => {
    renderDesktop();
    expect(screen.getByTestId('git-group-write').className).toContain('bg-muted/70 dark:bg-muted/30');
    expect(screen.getByTestId('git-group-advanced').className).toContain('bg-muted/50 dark:bg-muted/40');
  });
});

describe('controls for the opaque-fill check (Issue #3617)', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('flags the pre-fix classes (positive) and passes the fixed ones (negative), on a tmp copy', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-tint-3617-'));
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/components/worktree/git/GitPaneLayout.tsx'),
      'utf8',
    );
    const prefix = path.join(tmp, 'GitPaneLayout.prefix.tsx');
    fs.writeFileSync(
      prefix,
      src.replace(/bg-info-subtle\/\d+ dark:bg-info-subtle\/\d+/g, 'bg-info-subtle'),
    );
    const classStrings = (file: string) =>
      [...fs.readFileSync(file, 'utf8').matchAll(/className="([^"]*bg-info-subtle[^"]*)"/g)].map((m) => m[1]);

    const before = classStrings(prefix);
    expect(before).toHaveLength(2);
    expect(before.every(paintsOpaqueInfoSubtle)).toBe(true);

    const fixedCopy = path.join(tmp, 'GitPaneLayout.fixed.tsx');
    fs.writeFileSync(fixedCopy, src);
    const after = classStrings(fixedCopy);
    expect(after).toHaveLength(2);
    expect(after.some(paintsOpaqueInfoSubtle)).toBe(false);
  });

  it('leaves the info Toast on the opaque bg-info-subtle (the token’s own use)', () => {
    render(<Toast id="t-3617" message="info" type="info" onClose={vi.fn()} duration={0} />);
    const toast = screen.getByTestId('toast-t-3617');
    expect(paintsOpaqueInfoSubtle(toast.className)).toBe(true);
  });
});
