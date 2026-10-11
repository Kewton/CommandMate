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
 *
 * Issue #3593: the labelled pills and the "+N" menu became a fixed-width
 * session field (the current session + "N others ▾"), so the fit has no pill
 * to fold: past truncating, the identity group clips. The width model counts
 * the field as one fixed width.
 *
 * Issue #3590: the header is one 44px row and the verification chip moved to
 * the second row — the split action bar (`TerminalSplitContainer`), next to
 * the layout icons. The chip's half of the fit moved with it: that bar has its
 * own fit (`useSplitActionBarFit`), pinned at the end of this file with the
 * same width model — the History / Files toggles drop their labels first, then
 * the bar's left group clips; the toggles and the chip stay reachable.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import { VerificationStatusChip } from '@/components/worktree/VerificationStatusChip';
import { makeAppUpdateValue, makeUpdateInfo } from '@tests/helpers/app-update-context';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

// Issue #2654: the Update button joins the controls group, so its width is part
// of the arithmetic below. Steered from the context rather than a prop.
const mockUseAppUpdate = vi.fn();
vi.mock('@/contexts/AppUpdateContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/AppUpdateContext')>()),
  useAppUpdate: () => mockUseAppUpdate(),
}));

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
 * The identity group's content cannot be narrower than `identityMin` (dot,
 * the name's floor, the marks and the repository's floor), so below that it
 * overflows — which is the signal the fit folds on.
 *
 * Issue #3590: the second row's half — the split action bar. Its panel
 * toggles keep their width (`toggles`, or `togglesCompact` once their labels
 * are dropped) and the left group gets the rest; the left group's content
 * cannot be narrower than the layout ops plus the chip's floor (its badges and
 * ⓘ; a long title adds `longChipExtra`).
 */
const WIDTH = {
  controls: 300,
  /** Issue #3593: the current session + "N others ▾" + "+", whatever the sessions. */
  sessionField: 300,
  endButton: 50,
  identityMin: 400,
  longChipExtra: 100,
  /** A chip's badges: they get what the identity group has beyond this. */
  identityBesideBadges: 300,
  badges: 150,
  /** Issue #2654: the "Update v{version}" button, when an update is available. */
  updateButton: 120,
  /** Issue #3590: the action bar's History / Files toggles, with and without labels. */
  toggles: 180,
  togglesCompact: 70,
  /** Issue #3590: layout icons + Equal + Maximize. */
  layoutOps: 160,
  /** Issue #3590: the chip's floor — its badges and ⓘ. */
  chipMin: 220,
  /** Issue #3590: the "…" button the items fold behind. */
  itemsOverflow: 30,
};

let headerWidth = 1600;
let barWidth = 1600;

function renderedControlsWidth(): number {
  // Issue #3593: the agent row is a fixed-width session field.
  const row = document.querySelector('[data-testid="desktop-agent-status-row"]');
  return (
    WIDTH.controls +
    (row ? WIDTH.sessionField : 0) +
    (document.querySelector('[data-testid="desktop-kill-session"]') ? WIDTH.endButton : 0) +
    (document.querySelector('[data-testid="app-update-button"]') ? WIDTH.updateButton : 0)
  );
}

function identityContentMin(): number {
  return WIDTH.identityMin;
}

const isIdentityGroup = (el: Element) =>
  el.getAttribute('data-testid') === 'desktop-header-identity';

/** Issue #3590: the action bar's left group (layout ops + the chip slot). */
const isBarLeftGroup = (el: Element) =>
  el.getAttribute('data-testid') === 'split-action-bar-left';

function renderedTogglesWidth(): number {
  // Labelled toggles carry a visible text node besides the icon.
  const history = document.querySelector('[data-testid="toggle-history-pane"]');
  return history && history.textContent ? WIDTH.toggles : WIDTH.togglesCompact;
}

function barLeftAvailable(): number {
  const overflow = document.querySelector('[data-testid="split-action-bar-items-overflow"]')
    ? WIDTH.itemsOverflow
    : 0;
  return Math.max(0, barWidth - renderedTogglesWidth() - overflow);
}

function barLeftContentMin(): number {
  // Only a chip still on the bar counts; a folded one is in the floating panel.
  const chip = document.querySelector(
    '[data-testid="split-action-bar-left"] [data-testid="fake-verification-chip"]'
  );
  if (!chip) return WIDTH.layoutOps;
  return (
    WIDTH.layoutOps +
    WIDTH.chipMin +
    (screen.queryByText(LONG_CHIP_TITLE) ? WIDTH.longChipExtra : 0)
  );
}

/** The badges row inside {@link badgesChip}; it spills when the chip is squeezed. */
const isChipBadges = (el: Element) => el.getAttribute('data-testid') === 'fake-chip-badges';

function identityAvailable(): number {
  return Math.max(0, headerWidth - renderedControlsWidth());
}

function badgesAvailable(): number {
  // Issue #3590: the chip's badges sit in the action bar's left group now.
  return Math.max(0, barLeftAvailable() - WIDTH.identityBesideBadges);
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
  fire(width: number, testId: string): void {
    const entries = this.targets
      .filter((target) => target.getAttribute('data-testid') === testId)
      .map(
      (target) => ({ target, contentRect: { width, height: 56 } }) as unknown as ResizeObserverEntry
    );
    if (entries.length > 0) this.callback(entries, this as unknown as ResizeObserver);
  }
}

/** The window or the sidebar changed the header's width. */
function resizeHeader(width: number): void {
  headerWidth = width;
  act(() => {
    observers.forEach((observer) => observer.fire(width, 'desktop-header'));
  });
}

/** Issue #3590: the window or the sidebar changed the action bar's width. */
function resizeBar(width: number): void {
  barWidth = width;
  act(() => {
    observers.forEach((observer) => observer.fire(width, 'split-action-bar'));
  });
}

let restoreSpies: Array<() => void> = [];

beforeEach(() => {
  headerWidth = 1600;
  barWidth = 1600;
  observers.length = 0;
  clearTerminalSplitsLocalStorage();
  mockUseAppUpdate.mockReturnValue(makeAppUpdateValue());
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const clientWidth = vi
    .spyOn(Element.prototype, 'clientWidth', 'get')
    .mockImplementation(function (this: Element) {
      if (isIdentityGroup(this)) return identityAvailable();
      if (isBarLeftGroup(this)) return barLeftAvailable();
      if (isChipBadges(this)) return badgesAvailable();
      return 0;
    });
  const scrollWidth = vi
    .spyOn(Element.prototype, 'scrollWidth', 'get')
    .mockImplementation(function (this: Element) {
      if (isIdentityGroup(this)) return Math.max(identityAvailable(), identityContentMin());
      if (isBarLeftGroup(this)) return Math.max(barLeftAvailable(), barLeftContentMin());
      if (isChipBadges(this)) return Math.max(badgesAvailable(), WIDTH.badges);
      return 0;
    });
  restoreSpies = [() => clientWidth.mockRestore(), () => scrollWidth.mockRestore()];
});

afterEach(() => {
  restoreSpies.forEach((restore) => restore());
  vi.unstubAllGlobals();
  clearTerminalSplitsLocalStorage();
});

// =============================================================================
// Fixtures
// =============================================================================

const baseProps = {
  worktreeName: 'feature/2481-worktree',
  repositoryName: 'CommandMate',
  status: 'running' as const,
  onInfoClick: vi.fn(),
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

/**
 * Issue #3590: renders the second row — the split action bar — at `width`
 * with `items` in its slot (the worktree screen passes the chip there).
 */
function renderBar(width: number, items: React.ReactNode = chip()) {
  barWidth = width;
  const instances = roster(2);
  const all = {
    worktreeId: 'w-3590',
    instances,
    renderPane: () => <div />,
  };
  const utils = render(<TerminalSplitContainer {...all} actionBarItems={items} />);
  return {
    ...utils,
    rerenderBar: (next: React.ReactNode) =>
      utils.rerender(<TerminalSplitContainer {...all} actionBarItems={next} />),
  };
}

function toggleLabelsShown(): boolean {
  return Boolean(screen.getByTestId('toggle-history-pane').textContent);
}

function expectBarControlsReachable(): void {
  // The toggles sit outside the group that may clip.
  const left = screen.getByTestId('split-action-bar-left');
  for (const testId of ['toggle-history-pane', 'toggle-file-panel']) {
    expect(left.contains(screen.getByTestId(testId))).toBe(false);
    expect(screen.getByTestId(testId).className).toMatch(/\bflex-shrink-0\b/);
  }
  // The chip is either on the bar, or behind the "…" button (outside the
  // clipping group, never shrinking) in a panel portalled out of the bar.
  const overflow = screen.queryByTestId('split-action-bar-items-overflow');
  if (!overflow) {
    expect(left.contains(screen.getByTestId('fake-verification-chip'))).toBe(true);
    return;
  }
  expect(left.contains(overflow)).toBe(false);
  expect(overflow.className).toMatch(/\bflex-shrink-0\b/);
  expect(screen.queryByTestId('fake-verification-chip')).toBeNull();
  fireEvent.click(overflow);
  const panel = screen.getByTestId('split-action-bar-items-panel');
  expect(panel.parentElement).toBe(document.body);
  expect(panel.contains(screen.getByTestId('fake-verification-chip'))).toBe(true);
  fireEvent.click(overflow);
  expect(screen.queryByTestId('split-action-bar-items-panel')).toBeNull();
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
  // Issue #3513: the display-size selector left this group for the settings menu.
  // Issue #3594: so did the status select (set from the branch row's "…").
  for (const testId of ['desktop-info-button']) {
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
    // Issue #3590: the branch is drawn only when it differs from the name.
    render(
      <DesktopHeader
        {...baseProps}
        gitStatus={{ currentBranch: 'feature/2481-switched', isDirty: false } as Worktree['gitStatus']}
      />
    );
    expect(screen.getByRole('heading', { level: 1 }).className).toMatch(/\btruncate\b/);
    expect(screen.getByText('CommandMate').className).toMatch(/\btruncate\b/);
    expect(screen.getByTestId('desktop-branch-name').className).toMatch(/\btruncate\b/);
    // Issue #3590: the chip is on the second row. Its slot may shrink below its
    // content; the chip truncates its title.
    renderBar(1600);
    expect(screen.getByTestId('fake-verification-chip').parentElement?.className).toMatch(/\bmin-w-0\b/);
    expect(screen.getByTestId('split-action-bar-left').className).toMatch(/\bmin-w-0\b/);
  });

  it('never shrinks the Info button or the status dropdown', () => {
    renderSixWorking(1600);
    // Issue #3594: the header no longer has a status select; the Info button stays.
    for (const testId of ['desktop-info-button']) {
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

// Issue #3593: the agent pills became a fixed-width session field — the
// current session plus "N others ▾" — so there is nothing left to fold. The
// tests below keep their #2481 names; what each pins now is the same promise
// in the new layout: the controls stay reachable, the identity group clips as
// the last resort, and the fit re-measures on the same edges.
describe('DesktopHeader fit to width (Issue #2481)', () => {
  it('keeps the #1078 ceiling of four labelled pills when the header is wide enough', () => {
    // #3593: one labelled pill (the current session); the rest are listed.
    renderSixWorking(1600);
    expect(inlinePillIds()).toEqual(['desktop-agent-status-claude-0']);
    expect(screen.getByTestId('desktop-agent-status-overflow').textContent).toContain('5');
    expect(screen.getByTestId('desktop-header-identity').className).not.toContain('overflow-x-clip');
  });

  it('folds labelled pills into "+N" until the identity fits, and the controls stay', () => {
    // 1000px: the identity group gets 400px beside the session field.
    renderSixWorking(1000);
    expect(inlinePillIds()).toEqual(['desktop-agent-status-claude-0']);
    expect(screen.getByTestId('desktop-agent-status-overflow').textContent).toContain('5');
    expect(screen.getByTestId('desktop-header-identity').className).not.toContain('overflow-x-clip');
    expectControlsReachable();
  });

  it('keeps the active instance inline when pills fold (the #1078 ranking)', () => {
    renderSixWorking(1000, { activeInstanceId: 'claude-4' });
    expect(inlinePillIds()).toEqual(['desktop-agent-status-claude-4']);
  });

  it('clips the identity side once no pill is left to fold, never the controls', () => {
    // 700px: the identity group gets 100px < 400px.
    renderSixWorking(700);
    expect(inlinePillIds()).toEqual(['desktop-agent-status-claude-0']);
    expect(screen.getByTestId('desktop-header-identity').className).toContain('overflow-x-clip');
    expect(screen.getByTestId('desktop-agent-status-row').className).toContain('overflow-x-clip');
    expectControlsReachable();
  });

  it('gives the pills back when the header widens, and folds again when it narrows', () => {
    renderSixWorking(700);
    expect(screen.getByTestId('desktop-header-identity').className).toContain('overflow-x-clip');

    resizeHeader(1600);
    expect(screen.getByTestId('desktop-header-identity').className).not.toContain('overflow-x-clip');

    resizeHeader(900);
    expect(screen.getByTestId('desktop-header-identity').className).toContain('overflow-x-clip');
    // The session field is the same at every width.
    expect(inlinePillIds()).toEqual(['desktop-agent-status-claude-0']);
  });

  it('re-fits from the ceiling when the row itself needs less room', () => {
    // 1040px with the End button: 390px for the identity, it clips. Without
    // it, 440px fit — but only a fit that starts over finds that out.
    const instances = roster(6);
    const props = {
      ...baseProps,
      instances,
      activeInstanceId: 'claude-0',
      sessionStatusByInstance: allRunning(instances),
    };
    headerWidth = 1040;
    const { rerender } = render(<DesktopHeader {...props} onKillSession={vi.fn()} />);
    expect(screen.getByTestId('desktop-kill-session')).toBeDefined();
    expect(screen.getByTestId('desktop-header-identity').className).toContain('overflow-x-clip');

    rerender(<DesktopHeader {...props} onKillSession={undefined} />);
    expect(screen.queryByTestId('desktop-kill-session')).toBeNull();
    expect(screen.getByTestId('desktop-header-identity').className).not.toContain('overflow-x-clip');
  });

  it('keeps the awaiting-instruction badge when every pill is folded (#1787)', () => {
    const instances = roster(6);
    renderSixWorking(700, {
      sessionStatusByInstance: {
        ...allRunning(instances),
        'claude-5': { ...running, awaitingInstruction: true },
      } as InstanceStatusMap,
    });
    expect(screen.getByTestId('desktop-header-identity').className).toContain('overflow-x-clip');
    expect(screen.getByTestId('desktop-awaiting-instruction-badge')).toBeDefined();
  });

  /**
   * Issue #2654: the Update button lands in the controls group, which never
   * shrinks. The button appears when the update check resolves, long after the
   * header first rendered, so this pins that the header re-measures on that
   * edge rather than letting the identity group collide. #3593: with no pill
   * to fold, the identity group clips to make the room.
   */
  it('folds a pill to make room for the Update button, and gives it back afterwards', () => {
    const instances = roster(6);
    const props = {
      ...baseProps,
      instances,
      activeInstanceId: 'claude-0',
      sessionStatusByInstance: allRunning(instances),
    };
    headerWidth = 1000;
    // The context is mocked as a plain function, so the memoized header only
    // re-renders on a new prop; in the app the context change does that.
    const { rerender } = render(<DesktopHeader {...props} onInfoClick={vi.fn()} />);
    expect(screen.queryByTestId('app-update-button')).toBeNull();
    expect(screen.getByTestId('desktop-header-identity').className).not.toContain('overflow-x-clip');

    mockUseAppUpdate.mockReturnValue(
      makeAppUpdateValue({ updateInfo: makeUpdateInfo({ installType: 'global' }) })
    );
    rerender(<DesktopHeader {...props} onInfoClick={vi.fn()} />);
    expect(screen.getByTestId('app-update-button')).toBeDefined();
    expect(screen.getByTestId('desktop-header-identity').className).toContain('overflow-x-clip');
    expectControlsReachable();

    mockUseAppUpdate.mockReturnValue(makeAppUpdateValue());
    rerender(<DesktopHeader {...props} onInfoClick={vi.fn()} />);
    expect(screen.queryByTestId('app-update-button')).toBeNull();
    expect(screen.getByTestId('desktop-header-identity').className).not.toContain('overflow-x-clip');
  });

  it('does not fold idle instances: their dots cost no budget', () => {
    // #3593: one working and five idle take the same field as six working.
    const instances = roster(6);
    headerWidth = 1000;
    render(
      <DesktopHeader
        {...baseProps}
        instances={instances}
        activeInstanceId="claude-0"
        sessionStatusByInstance={{ 'claude-0': running } as InstanceStatusMap}
      />
    );
    expect(inlinePillIds()).toEqual(['desktop-agent-status-claude-0']);
    expect(screen.getByTestId('desktop-agent-status-overflow').textContent).toContain('5');
    expect(screen.getByTestId('desktop-header-identity').className).not.toContain('overflow-x-clip');
    for (let i = 1; i < 6; i += 1) {
      expect(screen.getByTestId(`desktop-agent-status-claude-${i}`)).toBeDefined();
    }
  });
});

// =============================================================================
// Issue #3590: the second row (split action bar) fits its width the same way
// =============================================================================

describe('Split action bar fit to width (Issue #3590)', () => {
  it('keeps the labels and does not clip when the bar is wide enough', () => {
    renderBar(1600);
    expect(toggleLabelsShown()).toBe(true);
    expect(screen.getByTestId('split-action-bar-left').className).not.toContain('overflow-x-clip');
    expectBarControlsReachable();
  });

  it('re-measures when the verification chip grows, and drops the toggle labels for it', () => {
    // 600px: 420px left of the labelled toggles holds the ops and a short
    // chip (380px) but not a long one (480px); dropping the labels (530px) does.
    const { rerenderBar } = renderBar(600);
    expect(toggleLabelsShown()).toBe(true);

    rerenderBar(chip(LONG_CHIP_TITLE));
    expect(toggleLabelsShown()).toBe(false);
    expect(screen.getByTestId('split-action-bar-left').className).not.toContain('overflow-x-clip');
    // The labels are only visual: the toggles keep their accessible names.
    expect(screen.getByTestId('toggle-history-pane').getAttribute('aria-label')).toBeTruthy();
    expect(screen.getByTestId('toggle-file-panel').getAttribute('aria-label')).toBeTruthy();
    expectBarControlsReachable();
  });

  it('drops the toggle labels when content collides inside the left group, not only at its edge', () => {
    // 560px: the left group gets 380px, enough for its box, but the chip's
    // badges get 80px of the 150px they need. Without the labels they get 190px.
    renderBar(560, badgesChip('visible'));
    expect(toggleLabelsShown()).toBe(false);
  });

  it('ignores content that clips on purpose, like a truncated title', () => {
    renderBar(560, badgesChip('hidden'));
    expect(toggleLabelsShown()).toBe(true);
  });

  it('folds the items behind "…" once the labels are gone, and the chip stays reachable', () => {
    // 400px (a file panel beside a narrow terminal): even without labels the
    // left group gets 330px < 380px. With the chip folded it needs 160px of 300px.
    renderBar(400);
    expect(toggleLabelsShown()).toBe(false);
    expect(screen.getByTestId('split-action-bar-items-overflow')).toBeInTheDocument();
    expect(screen.queryByTestId('split-action-bar-items')).toBeNull();
    expect(screen.getByTestId('split-action-bar-left').className).not.toContain('overflow-x-clip');
    expectBarControlsReachable();
  });

  it('moves focus into the "…" panel on open, and back to "…" on Escape', () => {
    renderBar(
      400,
      <span data-testid="fake-verification-chip">
        <VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} popover="floating" />
      </span>
    );
    const overflow = screen.getByTestId('split-action-bar-items-overflow');
    overflow.focus();
    // Enter on a focused button is a click.
    fireEvent.click(overflow);
    expect(document.activeElement).toBe(screen.getByTestId('verification-status-chip'));

    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByTestId('split-action-bar-items-panel')).toBeNull();
    expect(document.activeElement).toBe(overflow);
  });

  it('does not take focus back to "…" when a press outside closes the panel', () => {
    renderBar(
      400,
      <span data-testid="fake-verification-chip">
        <VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} popover="floating" />
      </span>
    );
    const overflow = screen.getByTestId('split-action-bar-items-overflow');
    fireEvent.click(overflow);
    const outside = screen.getByTestId('split-layout-1');
    outside.focus();
    fireEvent.mouseDown(outside);
    expect(screen.queryByTestId('split-action-bar-items-panel')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it('opens the reason from the folded chip, out of the bar and kept open by a press in it', () => {
    renderBar(
      400,
      <span data-testid="fake-verification-chip">
        <VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} popover="floating" />
      </span>
    );
    fireEvent.click(screen.getByTestId('split-action-bar-items-overflow'));
    fireEvent.click(screen.getByTestId('verification-chip-reason-toggle'));
    const reason = screen.getByTestId('verification-chip-reason-popover');
    // Portalled to <body> and fixed: no clipping ancestor between it and the page.
    expect(reason.parentElement).toBe(document.body);
    expect(reason.className).toMatch(/\bfixed\b/);
    // A press inside the reason is not "outside" for the panel or the chip.
    fireEvent.mouseDown(reason);
    expect(screen.getByTestId('split-action-bar-items-panel')).toBeInTheDocument();
    expect(screen.getByTestId('verification-chip-reason-popover')).toBeInTheDocument();
    // A press elsewhere closes both.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('split-action-bar-items-panel')).toBeNull();
    expect(screen.queryByTestId('verification-chip-reason-popover')).toBeNull();
  });

  it('clips the layout ops only as the last resort, never the toggles or "…"', () => {
    // 200px (the terminal at its 20% minimum): 100px left for 160px of ops.
    renderBar(200);
    expect(screen.getByTestId('split-action-bar-left').className).toContain('overflow-x-clip');
    expectBarControlsReachable();
  });

  it('gives the labels back when the bar widens, and drops them again when it narrows', () => {
    renderBar(200);
    expect(screen.getByTestId('split-action-bar-left').className).toContain('overflow-x-clip');

    resizeBar(1600);
    expect(toggleLabelsShown()).toBe(true);
    expect(screen.queryByTestId('split-action-bar-items-overflow')).toBeNull();
    expect(screen.getByTestId('split-action-bar-items')).toBeInTheDocument();
    expect(screen.getByTestId('split-action-bar-left').className).not.toContain('overflow-x-clip');

    resizeBar(400);
    expect(toggleLabelsShown()).toBe(false);
    expect(screen.getByTestId('split-action-bar-items-overflow')).toBeInTheDocument();
  });

  it('does not give anything up without a slotted item (the pre-#3590 bar)', () => {
    renderBar(400, null);
    expect(screen.queryByTestId('split-action-bar-items')).toBeNull();
    expect(toggleLabelsShown()).toBe(true);
    expect(screen.getByTestId('split-action-bar-left').className).not.toContain('overflow-x-clip');
  });
});
