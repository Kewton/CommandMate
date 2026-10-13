/**
 * @vitest-environment jsdom
 *
 * Issue #3590: the worktree header is one 44px row, and the Verification chip
 * moved to the second row (the split action bar), next to the layout icons.
 *
 * - What the old second line showed, and when (the Issue's table): the
 *   repository always, right of the name; the checked-out branch only when it
 *   differs from the worktree name (never `(unknown)`); `*` and `?` on their
 *   pre-#3590 condition, beside the name, whether or not the branch is drawn.
 * - The memo is not drawn; its full text is in the name's tooltip.
 * - The chip keeps its behaviour: tapping it opens the pane, ⓘ opens the
 *   reason popover.
 *
 * The 44px itself is measured in the browser (tests/e2e/worktree-header-one-row-3590.spec.ts);
 * here the class that sets it is pinned.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import {
  TerminalSplitContainer,
  clampOverflowPanelLeft,
} from '@/components/worktree/TerminalSplitContainer';
import { VerificationStatusChip } from '@/components/worktree/VerificationStatusChip';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import type { AgentInstance } from '@/lib/cli-tools/types';
import type { GitStatus } from '@/types/models';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const NAME = 'feature/3590-header';
const LONG_MEMO =
  'A memo much longer than the fifty characters the old second line kept — the rest used to be cut off with an ellipsis.';

const baseProps = {
  worktreeName: NAME,
  repositoryName: 'CommandMate',
  status: 'idle' as const,
  onInfoClick: vi.fn(),
};

function git(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    currentBranch: NAME,
    initialBranch: NAME,
    isBranchMismatch: false,
    commitHash: 'abc1234',
    isDirty: false,
    ...overrides,
  } as GitStatus;
}

function renderHeader(gitStatus?: GitStatus, description?: string) {
  return render(<DesktopHeader {...baseProps} gitStatus={gitStatus} description={description} />);
}

describe('DesktopHeader is one row (Issue #3590)', () => {
  it('is 44px tall (h-11) with no vertical padding', () => {
    renderHeader(git());
    const header = screen.getByTestId('desktop-header');
    expect(header.className).toMatch(/\bh-11\b/);
    expect(header.className).not.toMatch(/\bpy-\d/);
  });

  it('puts dot, name, repository and branch on the identity group itself, not in a second line', () => {
    renderHeader(git({ currentBranch: 'feature/other' }));
    const identity = screen.getByTestId('desktop-header-identity');
    for (const testId of [
      'desktop-status-indicator',
      'desktop-worktree-name',
      'desktop-repository-name',
      'desktop-branch-name',
    ]) {
      expect(screen.getByTestId(testId).parentElement).toBe(identity);
    }
    // Name first, then the repository, then the branch.
    const order = Array.from(identity.children).map((el) => el.getAttribute('data-testid'));
    expect(order.indexOf('desktop-worktree-name')).toBeLessThan(order.indexOf('desktop-repository-name'));
    expect(order.indexOf('desktop-repository-name')).toBeLessThan(order.indexOf('desktop-branch-name'));
  });

  it('links the repository name to the Repositories screen', () => {
    renderHeader(git());
    const repo = screen.getByTestId('desktop-repository-name');
    expect(repo.tagName).toBe('A');
    expect(repo.getAttribute('href')).toBe('/repositories');
    expect(repo.getAttribute('title')).toContain('CommandMate');
  });
});

describe('DesktopHeader git facts (Issue #3590 table)', () => {
  // [currentBranch, isDirty, statusUnknown] → [branch drawn, `*`, `?`]
  const cases: Array<{
    name: string;
    branch: string;
    dirty: boolean;
    unknown: boolean;
    expectBranch: boolean;
    expectDirty: boolean;
    expectUnknown: boolean;
  }> = [
    { name: 'same name, clean', branch: NAME, dirty: false, unknown: false, expectBranch: false, expectDirty: false, expectUnknown: false },
    { name: 'same name, dirty', branch: NAME, dirty: true, unknown: false, expectBranch: false, expectDirty: true, expectUnknown: false },
    { name: 'same name, status unknown', branch: NAME, dirty: false, unknown: true, expectBranch: false, expectDirty: false, expectUnknown: true },
    { name: 'other branch, clean', branch: 'hotfix/x', dirty: false, unknown: false, expectBranch: true, expectDirty: false, expectUnknown: false },
    { name: 'other branch, dirty', branch: 'hotfix/x', dirty: true, unknown: false, expectBranch: true, expectDirty: true, expectUnknown: false },
    { name: 'other branch, status unknown', branch: 'hotfix/x', dirty: false, unknown: true, expectBranch: true, expectDirty: false, expectUnknown: true },
    // `(unknown)` was never drawn, and neither were its marks (pre-#3590 condition).
    { name: '(unknown), dirty', branch: '(unknown)', dirty: true, unknown: false, expectBranch: false, expectDirty: false, expectUnknown: false },
    { name: '(unknown), status unknown', branch: '(unknown)', dirty: false, unknown: true, expectBranch: false, expectDirty: false, expectUnknown: false },
  ];

  for (const c of cases) {
    it(`${c.name}`, () => {
      renderHeader(git({ currentBranch: c.branch, isDirty: c.dirty, statusUnknown: c.unknown }));
      const branch = screen.queryByTestId('desktop-branch-name');
      expect(branch !== null).toBe(c.expectBranch);
      if (branch) expect(branch.textContent).toBe(c.branch);
      expect(screen.queryByTestId('desktop-git-dirty') !== null).toBe(c.expectDirty);
      expect(screen.queryByTestId('desktop-git-status-unknown') !== null).toBe(c.expectUnknown);
    });
  }

  it('draws `*` and `?` right after the name, before the repository', () => {
    renderHeader(git({ isDirty: true, statusUnknown: true }));
    const order = Array.from(screen.getByTestId('desktop-header-identity').children).map((el) =>
      el.getAttribute('data-testid')
    );
    const name = order.indexOf('desktop-worktree-name');
    expect(order.indexOf('desktop-git-dirty')).toBe(name + 1);
    expect(order.indexOf('desktop-git-status-unknown')).toBe(name + 2);
    expect(order.indexOf('desktop-repository-name')).toBe(name + 3);
  });

  it('keeps the uncommitted / unknown wording on the marks (negative control)', () => {
    renderHeader(git({ isDirty: true, statusUnknown: true }));
    expect(screen.getByTestId('desktop-git-dirty').getAttribute('title')).toBe('Uncommitted changes');
    expect(screen.getByTestId('desktop-git-status-unknown').getAttribute('title')).toBeTruthy();
  });

  it('draws no git facts without a git status', () => {
    renderHeader(undefined);
    expect(screen.queryByTestId('desktop-branch-name')).toBeNull();
    expect(screen.queryByTestId('desktop-git-dirty')).toBeNull();
    expect(screen.queryByTestId('desktop-git-status-unknown')).toBeNull();
    expect(screen.getByTestId('desktop-repository-name')).toBeInTheDocument();
  });
});

describe('DesktopHeader memo (Issue #3590)', () => {
  it('does not draw the memo, and puts its full text in the name tooltip', () => {
    renderHeader(git(), LONG_MEMO);
    expect(screen.queryByText(LONG_MEMO)).toBeNull();
    expect(screen.queryByText(/A memo much longer/)).toBeNull();
    const name = screen.getByTestId('worktree-breadcrumb-name');
    expect(name.textContent).toBe(NAME);
    expect(name.getAttribute('title')).toBe(LONG_MEMO);
  });

  it('adds no tooltip when there is no memo', () => {
    renderHeader(git());
    expect(screen.queryByTestId('worktree-breadcrumb-name')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(NAME);
  });
});

// =============================================================================
// The chip on the second row
// =============================================================================

const INSTANCES: AgentInstance[] = [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }];

describe('Verification chip on the split action bar (Issue #3590)', () => {
  beforeEach(() => clearTerminalSplitsLocalStorage());
  afterEach(() => clearTerminalSplitsLocalStorage());

  function renderBarWithChip(onOpen = vi.fn()) {
    render(
      <TerminalSplitContainer
        worktreeId="w-3590"
        instances={INSTANCES}
        renderPane={() => <div />}
        actionBarItems={<VerificationStatusChip task={null} latestRun={null} onOpen={onOpen} />}
      />
    );
    return onOpen;
  }

  it('sits right after the layout ops, before the History / Files toggles', () => {
    renderBarWithChip();
    const left = screen.getByTestId('split-action-bar-left');
    const picker = screen.getByTestId('split-layout-picker');
    const items = screen.getByTestId('split-action-bar-items');
    expect(picker.parentElement).toBe(left);
    expect(items.parentElement).toBe(left);
    expect(within(items).getByTestId('verification-status-chip')).toBeInTheDocument();
    // DOM order: picker → items → History toggle.
    const history = screen.getByTestId('toggle-history-pane');
    expect(picker.compareDocumentPosition(items) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(items.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the chip behaviour: tap opens the pane, ⓘ opens the reason', () => {
    const onOpen = renderBarWithChip();
    fireEvent.click(screen.getByTestId('verification-status-chip'));
    expect(onOpen).toHaveBeenCalledTimes(1);

    expect(screen.queryByTestId('verification-chip-reason-popover')).toBeNull();
    fireEvent.click(screen.getByTestId('verification-chip-reason-toggle'));
    expect(screen.getByTestId('verification-chip-reason-popover')).toBeInTheDocument();
  });

  it('is a 36px bar with no vertical padding, so the 32px ⓘ is not cut', () => {
    renderBarWithChip();
    const bar = screen.getByTestId('split-action-bar');
    expect(bar.className).toMatch(/\bh-9\b/);
    // h-9 is rem and shrinks with the display size (28.1px at xsmall); the
    // chip is px (32px ⓘ + 2px border). The floor keeps 34px inside the 1px border.
    expect(bar.className).toContain('min-h-[35px]');
    expect(bar.className).not.toMatch(/\bpy-\d/);
    expect(bar.className).not.toMatch(/overflow-(hidden|clip|y-)/);
  });

  it('renders the pre-#3590 bar without a slotted item (negative control)', () => {
    render(
      <TerminalSplitContainer worktreeId="w-3590" instances={INSTANCES} renderPane={() => <div />} />
    );
    expect(screen.queryByTestId('split-action-bar-items')).toBeNull();
    expect(screen.getByTestId('split-layout-picker')).toBeInTheDocument();
    expect(screen.getByTestId('toggle-history-pane').textContent).toContain('History');
  });
});

describe('Verification chip reason popover placement (Issue #3590)', () => {
  it('floats the reason out of every clipping ancestor when asked to', () => {
    render(
      <div style={{ overflow: 'hidden', width: 40 }}>
        <VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} popover="floating" />
      </div>
    );
    fireEvent.click(screen.getByTestId('verification-chip-reason-toggle'));
    const reason = screen.getByTestId('verification-chip-reason-popover');
    expect(reason.parentElement).toBe(document.body);
    expect(reason.className).toMatch(/\bfixed\b/);
    expect(reason.getAttribute('data-floating-layer')).toBe('true');
    // Kept inside the viewport.
    expect(parseFloat(reason.style.left)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(reason.style.left) + parseFloat(reason.style.width)).toBeLessThanOrEqual(
      window.innerWidth - 8
    );
    // Same toggle and dismissal rules.
    fireEvent.mouseDown(reason);
    expect(screen.getByTestId('verification-chip-reason-popover')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('verification-chip-reason-popover')).toBeNull();
  });

  it('keeps the inline popover by default (the mobile shell, negative control)', () => {
    const { container } = render(
      <VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId('verification-chip-reason-toggle'));
    const reason = screen.getByTestId('verification-chip-reason-popover');
    expect(container.contains(reason)).toBe(true);
    expect(reason.className).toMatch(/\babsolute\b/);
  });
});

describe('"…" panel position (Issue #3590)', () => {
  it('keeps the left edge inside the viewport when the chip is wider than the room left of "…"', () => {
    // Sidebar closed, terminal at 20%: "…" ends 150px from the left, the chip is 300px.
    expect(clampOverflowPanelLeft(150, 300, 1440)).toBe(8);
  });

  it('stays right-aligned with "…" when there is room (negative control)', () => {
    expect(clampOverflowPanelLeft(900, 300, 1440)).toBe(600);
  });

  it('keeps the right edge inside too, and pins a too-wide panel to the left margin', () => {
    expect(clampOverflowPanelLeft(1440, 300, 1440)).toBe(1132);
    expect(clampOverflowPanelLeft(500, 1500, 1000)).toBe(8);
  });
});

describe('Floating reason follows the chip (Issue #3590)', () => {
  let rect = { left: 100, top: 40, right: 400, bottom: 74, width: 300, height: 34 };
  let frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;

  beforeEach(() => {
    rect = { left: 100, top: 40, right: 400, bottom: 74, width: 300, height: 34 };
    frames = new Map();
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ ...rect, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect
    );
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      nextId += 1;
      frames.set(nextId, cb);
      return nextId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function nextFrame() {
    const pending = Array.from(frames.values());
    frames = new Map();
    act(() => pending.forEach((cb) => cb(0)));
  }

  it('moves under the chip when the chip moves while it is open (e.g. a maximize label appears)', () => {
    render(<VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} popover="floating" />);
    fireEvent.click(screen.getByTestId('verification-chip-reason-toggle'));
    const reason = () => screen.getByTestId('verification-chip-reason-popover');
    expect(reason().style.left).toBe('100px');
    expect(reason().style.top).toBe('78px');

    // The bar gains "Split 1 maximized" left of the chip: it shifts right.
    rect = { ...rect, left: 260, right: 560 };
    nextFrame();
    expect(reason().style.left).toBe('260px');
    expect(reason().style.top).toBe('78px');
  });

  it('stays put while nothing moves (negative control)', () => {
    render(<VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} popover="floating" />);
    fireEvent.click(screen.getByTestId('verification-chip-reason-toggle'));
    const before = screen.getByTestId('verification-chip-reason-popover').getAttribute('style');
    nextFrame();
    nextFrame();
    expect(screen.getByTestId('verification-chip-reason-popover').getAttribute('style')).toBe(before);
  });

  it('stops following once closed', () => {
    render(<VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} popover="floating" />);
    fireEvent.click(screen.getByTestId('verification-chip-reason-toggle'));
    fireEvent.click(screen.getByTestId('verification-chip-reason-toggle'));
    expect(frames.size).toBe(0);
  });
});
