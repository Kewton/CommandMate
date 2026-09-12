/**
 * @vitest-environment jsdom
 *
 * Issue #2481: the desktop header fits its width instead of pushing the
 * right-hand controls out of the worktree screen's `overflow-hidden` frame.
 *
 * At 1470px with the sidebar open the identity (name, branch, verification
 * chip), four labelled agent pills and the controls no longer fit in one row,
 * and the display-size selector and the Info button were cut off with no way
 * to scroll to them. The fix has two halves, and this file pins both:
 *
 * - **Who gives way** is a CSS contract: the identity group is `min-w-0` and
 *   truncates, the controls group never shrinks. Asserted on the classes,
 *   because jsdom has no layout.
 * - **What gives way once truncating is not enough** is the fit: labelled
 *   pills fold into the existing "+N" menu (#1078), one at a time, until the
 *   identity group's content fits its box; with none left to fold, the
 *   identity group clips. jsdom cannot measure, so a small width model below
 *   stands in for the browser — the fit only reads `scrollWidth` /
 *   `clientWidth` (of the identity group and of what is inside it), and the
 *   model derives them from what the header actually rendered.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

type InstanceStatusMap = NonNullable<Worktree['sessionStatusByInstance']>;

const running = { isRunning: true, isWaitingForResponse: false, isProcessing: true };

function roster(n: number): AgentInstance[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `claude-${i}`,
    cliTool: 'claude' as CLIToolType,
    alias: `Agent ${i}`,
    order: i,
  }));
}

function allRunning(instances: AgentInstance[]): InstanceStatusMap {
  return Object.fromEntries(instances.map((inst) => [inst.id, running])) as InstanceStatusMap;
}

const LONG_CHIP_TITLE = 'a much longer task title';

// =============================================================================
// Width model (jsdom has no layout)
// =============================================================================

/**
 * The browser's arithmetic, reduced to the parts the fit reacts to: the
 * controls group keeps its full width and the identity group gets the rest.
 * The identity group's content cannot be narrower than `identityMin` (back
 * link, dot, the name's floor and the chip's badges), so below that it
 * overflows — which is the signal the fit folds on.
 */
const WIDTH = {
  controls: 300,
  pill: 100,
  overflowTrigger: 40,
  endButton: 50,
  identityMin: 400,
  longChipExtra: 100,
  /** A chip's badges: they get what the identity group has beyond this. */
  identityBesideBadges: 300,
  badges: 150,
};

let headerWidth = 1600;

function renderedControlsWidth(): number {
  const row = document.querySelector('[data-testid="desktop-agent-status-row"]');
  // Labelled pills carry a native `title`; idle dots and "+N" do not.
  const pills = row ? row.querySelectorAll('button[title]').length : 0;
  return (
    WIDTH.controls +
    pills * WIDTH.pill +
    (document.querySelector('[data-testid="desktop-agent-status-overflow"]') ? WIDTH.overflowTrigger : 0) +
    (document.querySelector('[data-testid="desktop-kill-session"]') ? WIDTH.endButton : 0)
  );
}

function identityContentMin(): number {
  return WIDTH.identityMin + (screen.queryByText(LONG_CHIP_TITLE) ? WIDTH.longChipExtra : 0);
}

const isIdentityGroup = (el: Element) =>
  el.getAttribute('data-testid') === 'desktop-header-identity';

/** The badges row inside {@link badgesChip}; it spills when the chip is squeezed. */
const isChipBadges = (el: Element) => el.getAttribute('data-testid') === 'fake-chip-badges';

function identityAvailable(): number {
  return Math.max(0, headerWidth - renderedControlsWidth());
}

function badgesAvailable(): number {
  return Math.max(0, identityAvailable() - WIDTH.identityBesideBadges);
}

/** Stand-in for ResizeObserver: tests fire it with the header's new width. */
const observers: FakeResizeObserver[] = [];
class FakeResizeObserver {
  private targets: Element[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.targets = [];
  }
  fire(width: number): void {
    const entries = this.targets.map(
      (target) => ({ target, contentRect: { width, height: 56 } }) as unknown as ResizeObserverEntry
    );
    if (entries.length > 0) this.callback(entries, this as unknown as ResizeObserver);
  }
}

/** The window or the sidebar changed the header's width. */
function resizeHeader(width: number): void {
  headerWidth = width;
  act(() => {
    observers.forEach((observer) => observer.fire(width));
  });
}

let restoreSpies: Array<() => void> = [];

beforeEach(() => {
  headerWidth = 1600;
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const clientWidth = vi
    .spyOn(Element.prototype, 'clientWidth', 'get')
    .mockImplementation(function (this: Element) {
      if (isIdentityGroup(this)) return identityAvailable();
      if (isChipBadges(this)) return badgesAvailable();
      return 0;
    });
  const scrollWidth = vi
    .spyOn(Element.prototype, 'scrollWidth', 'get')
    .mockImplementation(function (this: Element) {
      if (isIdentityGroup(this)) return Math.max(identityAvailable(), identityContentMin());
      if (isChipBadges(this)) return Math.max(badgesAvailable(), WIDTH.badges);
      return 0;
    });
  restoreSpies = [() => clientWidth.mockRestore(), () => scrollWidth.mockRestore()];
});

afterEach(() => {
  restoreSpies.forEach((restore) => restore());
  vi.unstubAllGlobals();
});

// =============================================================================
// Fixtures
// =============================================================================

const baseProps = {
  worktreeName: 'feature/2481-worktree',
  repositoryName: 'CommandMate',
  status: 'running' as const,
  onBackClick: vi.fn(),
  onInfoClick: vi.fn(),
  onWorktreeStatusChange: vi.fn(),
  worktreeStatus: 'in_progress' as const,
};

function chip(title = 'Issue #2481') {
  return <span data-testid="fake-verification-chip">{title}</span>;
}

/**
 * A chip whose badges row can be squeezed below its content while the
 * identity group itself still fits — the real chip then paints its badges over
 * its own ⓘ toggle. `overflowX` says whether that row spills (`visible`) or
 * clips on purpose, the way a `truncate` span does (`hidden`).
 */
function badgesChip(overflowX: 'visible' | 'hidden') {
  return (
    <span data-testid="fake-verification-chip">
      <span data-testid="fake-chip-badges" style={{ overflowX }}>
        pending · RESULT Failed
      </span>
    </span>
  );
}

/** Renders the header at `width` with six working instances (the Issue's roster). */
function renderSixWorking(
  width: number,
  extra: Partial<React.ComponentProps<typeof DesktopHeader>> = {}
) {
  headerWidth = width;
  const instances = roster(6);
  return render(
    <DesktopHeader
      {...baseProps}
      instances={instances}
      activeInstanceId="claude-0"
      sessionStatusByInstance={allRunning(instances)}
      verificationChip={chip()}
      {...extra}
    />
  );
}

function inlinePillIds(): string[] {
  const row = screen.getByTestId('desktop-agent-status-row');
  return Array.from(row.querySelectorAll('button[title]')).map(
    (el) => el.getAttribute('data-testid') ?? ''
  );
}

function expectControlsReachable(): void {
  const controls = screen.getByTestId('desktop-header-controls');
  for (const testId of ['desktop-info-button', 'desktop-status-dropdown', 'pc-display-size-select']) {
    const el = screen.getByTestId(testId);
    expect(controls.contains(el)).toBe(true);
  }
  // Nothing on the controls side is ever clipped — only the identity group
  // and the agent row may be.
  expect(controls.className).not.toContain('overflow');
}

// =============================================================================
// Who gives way: the CSS contract
// =============================================================================

describe('DesktopHeader width contract (Issue #2481)', () => {
  it('lets the identity group shrink and keeps the controls group at full width', () => {
    renderSixWorking(1600);
    expect(screen.getByTestId('desktop-header-identity').className).toMatch(/\bmin-w-0\b/);
    expect(screen.getByTestId('desktop-header-controls').className).toMatch(/\bflex-shrink-0\b/);
  });

  it('truncates the name, repository, branch and chip instead of widening the row', () => {
    render(
      <DesktopHeader
        {...baseProps}
        gitStatus={{ currentBranch: 'feature/2481-worktree', isDirty: false } as Worktree['gitStatus']}
        verificationChip={chip()}
      />
    );
    expect(screen.getByRole('heading', { level: 1 }).className).toMatch(/\btruncate\b/);
    expect(screen.getByText('CommandMate').className).toMatch(/\btruncate\b/);
    expect(screen.getByTestId('desktop-branch-name').className).toMatch(/\btruncate\b/);
    // The chip's slot may shrink below its content; the chip truncates its title.
    expect(screen.getByTestId('fake-verification-chip').parentElement?.className).toMatch(/\bmin-w-0\b/);
  });

  it('never shrinks the back link, the Info button or the status dropdown', () => {
    renderSixWorking(1600);
    for (const testId of ['worktree-back-button', 'desktop-info-button', 'desktop-status-dropdown']) {
      expect(screen.getByTestId(testId).className).toMatch(/\bflex-shrink-0\b/);
    }
  });

  it('makes the agent row, not the controls, the part of the right group that can yield', () => {
    renderSixWorking(1600);
    const row = screen.getByTestId('desktop-agent-status-row');
    expect(row.className).toMatch(/\bmin-w-0\b/);
    expect(row.className).not.toMatch(/\bflex-shrink-0\b/);
  });
});

// =============================================================================
// What gives way: the fit
// =============================================================================

describe('DesktopHeader fit to width (Issue #2481)', () => {
  it('keeps the #1078 ceiling of four labelled pills when the header is wide enough', () => {
    renderSixWorking(1600);
    expect(inlinePillIds()).toHaveLength(4);
    expect(screen.getByTestId('desktop-agent-status-overflow').textContent).toContain('+2');
    expect(screen.getByTestId('desktop-header-identity').className).not.toContain('overflow-x-clip');
  });

  it('folds labelled pills into "+N" until the identity fits, and the controls stay', () => {
    // 1000px: two pills leave the identity group its 400px, three would not.
    renderSixWorking(1000);
    expect(inlinePillIds()).toEqual(['desktop-agent-status-claude-0', 'desktop-agent-status-claude-1']);
    expect(screen.getByTestId('desktop-agent-status-overflow').textContent).toContain('+4');
    expect(screen.getByTestId('desktop-header-identity').className).not.toContain('overflow-x-clip');
    expectControlsReachable();
  });

  it('keeps the active instance inline when pills fold (the #1078 ranking)', () => {
    renderSixWorking(1000, { activeInstanceId: 'claude-4' });
    expect(inlinePillIds()).toEqual(['desktop-agent-status-claude-0', 'desktop-agent-status-claude-4']);
  });

  it('clips the identity side once no pill is left to fold, never the controls', () => {
    // 700px: even with every pill folded the identity group gets 360px < 400px.
    renderSixWorking(700);
    expect(inlinePillIds()).toEqual([]);
    expect(screen.getByTestId('desktop-agent-status-overflow').textContent).toContain('+6');
    expect(screen.getByTestId('desktop-header-identity').className).toContain('overflow-x-clip');
    expect(screen.getByTestId('desktop-agent-status-row').className).toContain('overflow-x-clip');
    expectControlsReachable();
  });

  it('gives the pills back when the header widens, and folds again when it narrows', () => {
    renderSixWorking(700);
    expect(screen.getByTestId('desktop-header-identity').className).toContain('overflow-x-clip');

    resizeHeader(1600);
    expect(inlinePillIds()).toHaveLength(4);
    expect(screen.getByTestId('desktop-header-identity').className).not.toContain('overflow-x-clip');

    resizeHeader(1000);
    expect(inlinePillIds()).toHaveLength(2);
  });

  it('re-fits from the ceiling when the row itself needs less room', () => {
    // 1060px with the End button: two pills. Without it, three fit — but only
    // a fit that starts over (not one that keeps folding) finds that out.
    const instances = roster(6);
    const props = {
      ...baseProps,
      instances,
      activeInstanceId: 'claude-0',
      sessionStatusByInstance: allRunning(instances),
      verificationChip: chip(),
    };
    headerWidth = 1060;
    const { rerender } = render(<DesktopHeader {...props} onKillSession={vi.fn()} />);
    expect(screen.getByTestId('desktop-kill-session')).toBeDefined();
    expect(inlinePillIds()).toHaveLength(2);

    rerender(<DesktopHeader {...props} onKillSession={undefined} />);
    expect(screen.queryByTestId('desktop-kill-session')).toBeNull();
    expect(inlinePillIds()).toHaveLength(3);
  });

  it('re-measures when the verification chip grows, and folds a pill for it', () => {
    const instances = roster(6);
    const props = {
      ...baseProps,
      instances,
      activeInstanceId: 'claude-0',
      sessionStatusByInstance: allRunning(instances),
    };
    headerWidth = 1060;
    const { rerender } = render(<DesktopHeader {...props} verificationChip={chip()} />);
    expect(inlinePillIds()).toHaveLength(3);

    rerender(<DesktopHeader {...props} verificationChip={chip(LONG_CHIP_TITLE)} />);
    expect(inlinePillIds()).toHaveLength(2);
  });

  it('folds a pill when content collides inside the identity group, not only at its edge', () => {
    // 1060px, three pills: the identity group gets 420px, enough for its box,
    // but the chip's badges get 120px of the 150px they need.
    renderSixWorking(1060, { verificationChip: badgesChip('visible') });
    expect(inlinePillIds()).toHaveLength(2);
  });

  it('ignores content that clips on purpose, like a truncated title', () => {
    renderSixWorking(1060, { verificationChip: badgesChip('hidden') });
    expect(inlinePillIds()).toHaveLength(3);
  });

  it('keeps the awaiting-instruction badge when every pill is folded (#1787)', () => {
    const instances = roster(6);
    renderSixWorking(700, {
      sessionStatusByInstance: {
        ...allRunning(instances),
        'claude-5': { ...running, awaitingInstruction: true },
      } as InstanceStatusMap,
    });
    expect(inlinePillIds()).toEqual([]);
    expect(screen.getByTestId('desktop-awaiting-instruction-badge')).toBeDefined();
  });

  it('does not fold idle instances: their dots cost no budget', () => {
    // One working, five idle, at a width that holds a single pill.
    const instances = roster(6);
    headerWidth = 840;
    render(
      <DesktopHeader
        {...baseProps}
        instances={instances}
        activeInstanceId="claude-0"
        sessionStatusByInstance={{ 'claude-0': running } as InstanceStatusMap}
        verificationChip={chip()}
      />
    );
    expect(inlinePillIds()).toEqual(['desktop-agent-status-claude-0']);
    expect(screen.queryByTestId('desktop-agent-status-overflow')).toBeNull();
    for (let i = 1; i < 6; i += 1) {
      expect(screen.getByTestId(`desktop-agent-status-claude-${i}`)).toBeDefined();
    }
  });
});
