/**
 * The phone header's worktree dot can draw "cannot tell" (Issue #2810), and it
 * asks the question through the same helper the PC header does.
 *
 * Two halves: `MobileHeader` renders the ring for the flag it is handed (and
 * refuses it for anything but `ready`), and `isWorktreeStatusUnclassified`
 * reads the flag off the one per-CLI entry `deriveWorktreeStatus` read. The
 * wiring between them — `WorktreeDetailRefactored` passing the helper's answer
 * — is pinned in `WorktreeDetailRefactored-mobile-header-unclassified-2810`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { UNCLASSIFIED_STATUS_DOT_CLASS } from '@/components/sidebar/BranchStatusIndicator';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

import { MobileHeader } from '@/components/mobile/MobileHeader';
import {
  deriveWorktreeStatus,
  isWorktreeStatusUnclassified,
} from '@/components/worktree/WorktreeDetailSubComponents';
import type { Worktree } from '@/types/models';

type Entry = NonNullable<Worktree['sessionStatusByCli']>['codex'];

const BASE = {
  isRunning: true,
  isWaitingForResponse: false,
  waitingKind: null,
  waitingSince: null,
  awaitingInstruction: false,
} as const;

const UNCLASSIFIED: Entry = {
  ...BASE,
  isProcessing: false,
  statusEvidence: 'none',
  sessionStatusReason: 'default',
  isUnclassified: true,
};

const THINKING: Entry = {
  ...BASE,
  isProcessing: true,
  statusEvidence: 'positive',
  sessionStatusReason: 'thinking_indicator',
};

afterEach(() => cleanup());

describe('[#2810] MobileHeader status dot', () => {
  it('draws the "cannot tell" ring, labelled 不明, for an unclassified ready', () => {
    render(<MobileHeader worktreeName="fix/2810" status="ready" statusUnclassified />);

    const dot = screen.getByTestId('status-indicator');
    expect(dot).toHaveAttribute('data-unclassified', 'true');
    for (const cls of UNCLASSIFIED_STATUS_DOT_CLASS.split(' ')) {
      expect(dot.className).toContain(cls);
    }
    expect(dot.className).not.toContain('bg-success');
    expect(dot.className).not.toMatch(/animate-status/);
    expect(dot.className).toContain('mr-2');
    expect(dot.getAttribute('aria-label')).toBe('不明');
  });

  it('never redraws a running dot, whatever the caller passes', () => {
    render(<MobileHeader worktreeName="fix/2810" status="running" statusUnclassified />);

    const dot = screen.getByTestId('status-indicator');
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.className).toMatch(/animate-status-glow/);
    expect(dot.getAttribute('aria-label')).toBe('実行中');
  });

  it('renders the plain ready dot when the flag is absent', () => {
    render(<MobileHeader worktreeName="fix/2810" status="ready" />);

    const dot = screen.getByTestId('status-indicator');
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.className).toContain('bg-success');
    expect(dot.getAttribute('aria-label')).toBe('準備完了');
  });
});

describe('[#2810] isWorktreeStatusUnclassified', () => {
  function worktree(sessionStatusByCli: Worktree['sessionStatusByCli']): Worktree {
    return { id: 'wt', name: 'wt', path: '/p', repositoryPath: '/r', repositoryName: 'r', sessionStatusByCli } as Worktree;
  }

  it('is true for the tool the dot was derived from, when that entry is unclassified', () => {
    const wt = worktree({ codex: UNCLASSIFIED });
    const status = deriveWorktreeStatus(wt, false, 'codex');

    expect(status).toBe('ready');
    expect(isWorktreeStatusUnclassified(status, wt.sessionStatusByCli, 'codex')).toBe(true);
  });

  it('reads only that tool: another tool being unclassified does not annotate this dot', () => {
    const wt = worktree({ codex: UNCLASSIFIED, claude: { ...BASE, isProcessing: false } });
    const status = deriveWorktreeStatus(wt, false, 'claude');

    expect(status).toBe('ready');
    expect(isWorktreeStatusUnclassified(status, wt.sessionStatusByCli, 'claude')).toBe(false);
  });

  it('is false for a running with positive evidence', () => {
    const wt = worktree({ codex: THINKING });
    const status = deriveWorktreeStatus(wt, false, 'codex');

    expect(status).toBe('running');
    expect(isWorktreeStatusUnclassified(status, wt.sessionStatusByCli, 'codex')).toBe(false);
  });

  it('never redraws an error dot, even over an unclassified entry', () => {
    const wt = worktree({ codex: UNCLASSIFIED });

    expect(isWorktreeStatusUnclassified('error', wt.sessionStatusByCli, 'codex')).toBe(false);
  });

  it('is false with no tool to read', () => {
    expect(isWorktreeStatusUnclassified('ready', { codex: UNCLASSIFIED }, undefined)).toBe(false);
  });
});
