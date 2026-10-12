/**
 * Where the dark Git pane's blue does NOT come from (Issue #3617).
 *
 * Traced in a real browser (dark scheme, 1440×900): the blue that filled the
 * Git pane was the opaque `bg-info-subtle` (`--info-subtle` = blue-950 in dark)
 * on GitPaneLayout's read groups — `git-group-read` and `git-group-history`,
 * the latter `flex-1`, so it covered most of the pane. Those groups now carry
 * an opacity modifier (pinned in tests/unit/components/git/
 * GitPaneLayout-tint-3617.test.tsx). The frames around the pane paint the
 * neutral `--surface`. These tests pin that the frames stay neutral and that
 * ActivityPane adds no background of its own, so the Files pane (which has no
 * tinted groups) keeps the normal background in both themes.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorktreeDesktopLayout } from '@/components/worktree/WorktreeDesktopLayout';
import { ActivityPane } from '@/components/worktree/ActivityPane';

const BG_CLASS = /(^|\s)(dark:)?bg-[^\s]+/g;

function backgrounds(el: HTMLElement): string[] {
  return (el.className.match(BG_CLASS) ?? []).map((c) => c.trim());
}

function renderPane(pinned: boolean, active: 'git' | 'files') {
  return render(
    <WorktreeDesktopLayout
      activityPane={
        <ActivityPane
          active={active}
          activities={{
            git: <div data-testid="git-content" />,
            files: <div data-testid="files-content" />,
          }}
        />
      }
      rightPane={<div data-testid="body" />}
      activityPanePinned={pinned}
    />,
  );
}

describe('Git pane background — the frames stay neutral (Issue #3617)', () => {
  it('paints the unpinned overlay slot with the neutral surface token only', () => {
    renderPane(false, 'git');
    expect(backgrounds(screen.getByTestId('activity-pane-slot'))).toEqual(['bg-surface']);
  });

  it('gives the pinned column no background (the page shows through), as before #3591', () => {
    renderPane(true, 'git');
    expect(backgrounds(screen.getByTestId('activity-pane-slot'))).toEqual([]);
  });

  it.each(['git', 'files'] as const)('adds no background of its own around the %s content', (active) => {
    renderPane(false, active);
    const pane = screen.getByTestId('activity-pane');
    expect(pane).toHaveAttribute('data-active', active);
    expect(backgrounds(pane)).toEqual([]);
  });
});
