/**
 * @vitest-environment jsdom
 *
 * Issue #3651 (consistency re-review): the "…" panel wraps its items, but the
 * lone split's session controls are ONE flex row of their own
 * (`split-bar-session-0`): selector, Terminal / Chat, model, the note with its
 * time, and End. In a panel capped from the body (~272px at 768px with a 480px
 * sidebar, worse at the large display size) that row must wrap too, or a note
 * from an earlier day and a running session's End overrun one another.
 *
 * jsdom does no layout: the bar's fit is modelled, and what is checked is the
 * rendered markup the wrapping rule keys on — the folded slot is a
 * `group/bar-session` with `data-folded="true"`, and the row carries the class
 * whose CSS (`:where(.group\/bar-session)[data-folded="true"] *`) sets
 * `flex-wrap: wrap`. The e2e spec checks the real boxes.
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const WORKTREE_ID = 'w-3651';
/** A note written the day before: its stamp carries the date ("9/7 14:32"). */
const YESTERDAY_1432 = new Date(2026, 8, 7, 14, 32, 0).getTime();

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => ({
    worktrees: [
      {
        id: 'w-3651',
        sessionNotes: { claude: { text: 'waiting on the review of the migration', updatedAt: YESTERDAY_1432 } },
      },
    ],
    refresh: () => Promise.resolve(),
  }),
  useWorktreesCacheContext: () => null,
  WorktreesCacheProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import type { AgentInstance } from '@/lib/cli-tools/types';

beforeAll(() => installRadixJsdomPolyfills());

const INSTANCES: AgentInstance[] = [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }];

/** The selector the wrapping rule's CSS keys on (Tailwind's group-data variant). */
const FOLDED_GROUP = '.group\\/bar-session[data-folded="true"]';
const ROW_WRAP_CLASS = 'group-data-[folded=true]/bar-session:flex-wrap';

let leftPx = 2000;
const saved = {
  scroll: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth'),
  client: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
};

beforeEach(() => {
  clearTerminalSplitsLocalStorage();
  leftPx = 2000;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('data-testid') === 'split-action-bar-left' ? leftPx : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute('data-testid') !== 'split-action-bar-left') return 0;
      return 160 + (this.querySelector('[data-testid="split-bar-session-0"]') ? 420 : 0);
    },
  });
  vi.stubGlobal('innerWidth', 768);
});

afterEach(() => {
  cleanup();
  clearTerminalSplitsLocalStorage();
  if (saved.scroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', saved.scroll);
  if (saved.client) Object.defineProperty(HTMLElement.prototype, 'clientWidth', saved.client);
  vi.unstubAllGlobals();
});

/** A running session: the End button is the pane's `headerExtras`. */
function renderBar() {
  return render(
    <TerminalSplitContainer
      worktreeId={WORKTREE_ID}
      instances={INSTANCES}
      renderPane={({ splitIndex, cliToolId, instanceId, instance, availableInstances, onInstanceChange, onFocus }) => (
        <TerminalSplitPane
          worktreeId={WORKTREE_ID}
          splitIndex={splitIndex}
          cliToolId={cliToolId}
          instanceId={instanceId}
          instance={instance}
          availableInstances={availableInstances}
          onInstanceChange={onInstanceChange}
          onFocus={onFocus}
          onSurfaceModeChange={vi.fn()}
          agentModel="claude-opus-4"
          headerExtras={
            <button type="button" data-testid={`terminal-end-session-button-${splitIndex}`}>
              End
            </button>
          }
          terminal={<div />}
          footer={<div />}
        />
      )}
    />,
  );
}

const CONTROLS = [
  'cli-selector-0',
  'surface-mode-terminal-0',
  'surface-mode-chat-0',
  'split-session-note-0',
  'split-session-note-time-0',
  'terminal-end-session-button-0',
];

describe('folded session row wraps inside the narrow "…" panel (Issue #3651)', () => {
  it('marks the folded slot and lets its row wrap, with every control in it (positive)', () => {
    leftPx = 200;
    renderBar();
    fireEvent.click(screen.getByTestId('split-action-bar-items-overflow'));
    const panel = screen.getByTestId('split-action-bar-items-panel');

    const slot = within(panel).getByTestId('split-action-bar-session');
    expect(slot).toHaveAttribute('data-folded', 'true');
    expect(slot.className.split(/\s+/)).toContain('group/bar-session');

    const row = within(panel).getByTestId('split-bar-session-0');
    expect(row.className.split(/\s+/)).toContain(ROW_WRAP_CLASS);
    // The CSS rule's own selector matches: the row is under the folded group.
    expect(row.closest(FOLDED_GROUP)).toBe(slot);

    for (const id of CONTROLS) {
      expect(row.contains(within(panel).getByTestId(id))).toBe(true);
    }
    // A note from an earlier day carries its date.
    expect(within(panel).getByTestId('split-session-note-time-0').textContent).toMatch(/\d+\/\d+ \d{2}:\d{2}/);
  });

  it('keeps the row one line on the bar while it fits (negative)', () => {
    renderBar();
    expect(screen.queryByTestId('split-action-bar-items-overflow')).toBeNull();
    const slot = screen.getByTestId('split-action-bar-session');
    expect(slot).not.toHaveAttribute('data-folded');
    expect(slot.className).toBe('flex min-w-0 items-center ml-1');

    const row = screen.getByTestId('split-bar-session-0');
    expect(row.closest(FOLDED_GROUP)).toBeNull();
    // No unconditional wrap: the bar's row stays exactly as before.
    expect(row.className.split(/\s+/)).not.toContain('flex-wrap');
    expect(row.className).toContain('relative flex min-w-0 items-center gap-1.5');
    for (const id of CONTROLS) {
      expect(row.contains(screen.getByTestId(id))).toBe(true);
    }
  });
});
