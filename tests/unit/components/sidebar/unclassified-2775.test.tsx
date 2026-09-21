/**
 * The sidebar draws an unreadable frame as "cannot tell", never as the green
 * glow of work in progress (Issue #2775).
 *
 * The payloads below are the shape `detectWorktreeSessionStatus` publishes for
 * each case — `worktree-status-unclassified-2775.test.ts` pins that side — and
 * they go through the real `toBranchItem` into the real `BranchListItem`, so
 * what is asserted is the rendered dot, not an intermediate value.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { BranchListItem, __resetMouseEnterSuppression } from '@/components/sidebar/BranchListItem';
import {
  BranchStatusIndicator,
  UNCLASSIFIED_STATUS_DOT_CLASS,
  resolveUnclassifiedDot,
} from '@/components/sidebar/BranchStatusIndicator';
import {
  formatCliStatusBreakdown,
  isBranchUnclassified,
  toBranchItem,
  UNCLASSIFIED_STATUS_WORD,
} from '@/types/sidebar';
import type { Worktree } from '@/types/models';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

type Entry = NonNullable<Worktree['sessionStatusByInstance']>[string];

/** What the helper publishes for a frame that fell to one of the three floors. */
function unclassified(reason: string): Entry {
  return {
    isRunning: true,
    isWaitingForResponse: false,
    isProcessing: false,
    waitingKind: null,
    waitingSince: null,
    awaitingInstruction: false,
    statusEvidence: 'none',
    sessionStatusReason: reason,
    isUnclassified: true,
  };
}

/** What it publishes for a thinking indicator — positive evidence. */
const THINKING: Entry = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: true,
  waitingKind: null,
  waitingSince: null,
  awaitingInstruction: false,
  statusEvidence: 'positive',
  sessionStatusReason: 'thinking_indicator',
};

/** An idle composer a rule read positively. */
const COMPOSER: Entry = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: false,
  waitingKind: null,
  waitingSince: null,
  awaitingInstruction: false,
  statusEvidence: 'positive',
  sessionStatusReason: 'input_prompt',
};

function worktree(byInstance: Record<string, Entry>): Worktree {
  const entries = Object.values(byInstance);
  return {
    id: 'wt-2775',
    name: 'feature/2775',
    path: '/repo/wt',
    repositoryPath: '/repo',
    repositoryName: 'repo',
    // An empty alias falls back to the tool's display name ("Codex").
    agentInstances: Object.keys(byInstance).map((id, order) => ({
      id,
      cliTool: id.replace(/-\d+$/, '') as 'codex' | 'claude',
      alias: '',
      order,
    })),
    isSessionRunning: entries.some((e) => e?.isRunning),
    isWaitingForResponse: entries.some((e) => e?.isWaitingForResponse),
    isProcessing: entries.some((e) => e?.isProcessing),
    sessionStatusByCli: byInstance,
    sessionStatusByInstance: byInstance,
  } as Worktree;
}

function renderRow(wt: Worktree) {
  render(<BranchListItem branch={toBranchItem(wt)} isSelected={false} onClick={() => {}} />);
  return screen.getByTestId('status-indicator');
}

const FLOOR_REASONS = ['default', 'unknown_frame', 'no_recent_output'] as const;

beforeEach(() => {
  cleanup();
  __resetMouseEnterSuppression();
});

describe('[#2775] BranchListItem: an unclassified session', () => {
  it.each(FLOOR_REASONS)('%s: is not a green glow, and reads "unknown"', (reason) => {
    const dot = renderRow(worktree({ codex: unclassified(reason) }));

    expect(dot.className).not.toMatch(/animate-status-glow/);
    expect(dot.className).not.toMatch(/bg-success/);
    expect(dot.className).toContain('bg-transparent');
    expect(dot.className).toContain('border-muted-foreground');
    expect(dot).toHaveAttribute('data-unclassified', 'true');
    expect(dot.getAttribute('title')).toBe('Codex: unknown');
    expect(dot.getAttribute('aria-label')).toBe('Codex: unknown');
  });

  it('the tooltip says unknown and offers no next action', async () => {
    renderRow(worktree({ codex: unclassified('default') }));

    fireEvent.mouseEnter(screen.getByTestId('branch-list-item'));
    const tooltip = await screen.findByRole('tooltip');

    expect(tooltip.textContent).toContain(`Status: ${UNCLASSIFIED_STATUS_WORD}`);
    expect(tooltip.textContent).not.toContain('Status: ready');
    expect(tooltip.textContent).not.toContain('Next:');
  });

  it('a working sibling wins: the row glows, and only the blind one reads unknown', () => {
    const dot = renderRow(worktree({ codex: unclassified('default'), claude: THINKING }));

    expect(dot.className).toMatch(/animate-status-glow/);
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.getAttribute('title')).toBe('Codex: unknown, Claude: running');
  });

  it('an idle sibling does not hide it: the blind spot outranks a plain ready', () => {
    const dot = renderRow(worktree({ codex: unclassified('default'), claude: COMPOSER }));

    expect(dot).toHaveAttribute('data-unclassified', 'true');
    expect(dot.getAttribute('title')).toBe('Codex: unknown, Claude: ready');
  });
});

describe('[#2775] BranchListItem: a running with positive evidence is unchanged', () => {
  it('still glows green, labelled running', () => {
    const dot = renderRow(worktree({ codex: THINKING }));

    expect(dot.className).toMatch(/animate-status-glow/);
    expect(dot.className).toMatch(/bg-success/);
    expect(dot.className).not.toContain('bg-transparent');
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.getAttribute('title')).toBe('Codex: running');
  });

  it('a plain ready is still the static green dot', () => {
    const dot = renderRow(worktree({ codex: COMPOSER }));

    expect(dot.className).toMatch(/bg-success/);
    expect(dot.className).not.toMatch(/animate-status-glow/);
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.getAttribute('title')).toBe('Codex: ready');
  });
});

describe('[#2775] BranchStatusIndicator', () => {
  it('draws the ring for an unclassified ready, with the Unknown label by default', () => {
    render(<BranchStatusIndicator status="ready" unclassified />);
    const dot = screen.getByTestId('status-indicator');

    for (const cls of UNCLASSIFIED_STATUS_DOT_CLASS.split(' ')) {
      expect(dot.className).toContain(cls);
    }
    expect(dot.className).not.toMatch(/animate-/);
    expect(dot.getAttribute('aria-label')).toBe('Unknown');
  });

  it('never redraws a running dot, whatever the caller passes', () => {
    render(<BranchStatusIndicator status="running" unclassified />);
    const dot = screen.getByTestId('status-indicator');

    expect(dot.className).toMatch(/animate-status-glow/);
    expect(dot.className).not.toContain('bg-transparent');
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.getAttribute('aria-label')).toBe('Running');
  });

  it('resolveUnclassifiedDot honours the flag for ready only', () => {
    expect(resolveUnclassifiedDot('ready', true)).toBe(true);
    for (const status of ['idle', 'running', 'generating', 'waiting', 'error']) {
      expect(resolveUnclassifiedDot(status, true)).toBe(false);
    }
    expect(resolveUnclassifiedDot('ready', false)).toBe(false);
    expect(resolveUnclassifiedDot('ready', undefined)).toBe(false);
  });
});

describe('[#2775] sidebar types', () => {
  it('toBranchItem lists the unclassified instances and leaves cliStatus at ready', () => {
    const item = toBranchItem(worktree({ codex: unclassified('default'), claude: COMPOSER }));

    expect(item.cliStatus).toEqual({ codex: 'ready', claude: 'ready' });
    expect(item.unclassifiedInstanceIds).toEqual(['codex']);
    expect(item.nextActionKey).toBeUndefined();
  });

  it('toBranchItem lists nothing, and keeps the next action, for readable sessions', () => {
    const item = toBranchItem(worktree({ codex: THINKING }));

    expect(item.unclassifiedInstanceIds).toEqual([]);
    expect(item.nextActionKey).toBe('nextAction.running');
  });

  it('the legacy per-CLI path (no sessionStatusByInstance) reads the flag too', () => {
    const wt = worktree({ codex: unclassified('default') });
    const item = toBranchItem({
      ...wt,
      sessionStatusByInstance: undefined,
      agentInstances: undefined,
      selectedAgents: ['codex'],
    });

    expect(item.unclassifiedInstanceIds).toEqual(['codex']);
  });

  it('an unclassified instance outside the roster is still surfaced', () => {
    const wt = worktree({ claude: COMPOSER });
    const item = toBranchItem({
      ...wt,
      sessionStatusByInstance: { claude: COMPOSER, 'codex-2': unclassified('default') },
    });

    expect(item.cliStatus?.['codex-2']).toBe('ready');
    expect(item.unclassifiedInstanceIds).toEqual(['codex-2']);
  });

  it('isBranchUnclassified: waiting > running > cannot tell > ready', () => {
    expect(isBranchUnclassified({ codex: 'ready' }, ['codex'])).toBe(true);
    expect(isBranchUnclassified({ codex: 'ready', claude: 'ready' }, ['codex'])).toBe(true);
    expect(isBranchUnclassified({ codex: 'ready', claude: 'running' }, ['codex'])).toBe(false);
    expect(isBranchUnclassified({ codex: 'ready', claude: 'waiting' }, ['codex'])).toBe(false);
    expect(isBranchUnclassified({ codex: 'ready' }, [])).toBe(false);
    expect(isBranchUnclassified({ codex: 'ready' }, undefined)).toBe(false);
    // An id whose entry is not `ready` cannot make the row read unknown.
    expect(isBranchUnclassified({ codex: 'idle', claude: 'ready' }, ['codex'])).toBe(false);
  });

  it('formatCliStatusBreakdown rewrites only a ready entry', () => {
    const ids = new Set(['codex', 'claude']);
    expect(formatCliStatusBreakdown({ codex: 'ready', claude: 'running' }, undefined, undefined, ids)).toBe(
      'Codex: unknown, Claude: running'
    );
    // Without the set, byte-identical to before.
    expect(formatCliStatusBreakdown({ codex: 'ready', claude: 'running' })).toBe(
      'Codex: ready, Claude: running'
    );
  });
});
