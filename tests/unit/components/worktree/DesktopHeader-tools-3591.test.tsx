/**
 * @vitest-environment jsdom
 *
 * Issue #3591: the vertical activity bar's column is gone; its tools sit at the
 * right of the PC worktree header, and the activity pane opens from the right.
 *
 * - `DesktopHeader` draws `HeaderToolBar` in its controls group (which never
 *   shrinks) when given `onActivityToggle`, and nothing when not (every other
 *   caller keeps the pre-#3591 header).
 * - The header's width fit (`useDesktopHeaderFit`) folds the trailing tools
 *   behind "…" one at a time before the identity group clips. jsdom has no
 *   layout, so a small width model (as in DesktopHeader-fit-2481) stands in.
 * - `WorktreeDesktopLayout` puts the pane on the right: an overlay from the
 *   right edge, or — pinned — a column after the body with its resizer first.
 * - `focusActivityEntry` hands focus back to the tool, to "…" holding it, or to
 *   the Verification chip / the second row's "…".
 * - The screen no longer mounts the ActivityBar (a source check, with a
 *   positive control on a temporary copy of the old wiring).
 */

import React from 'react';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import { WorktreeDesktopLayout } from '@/components/worktree/WorktreeDesktopLayout';
import { focusActivityEntry } from '@/components/worktree/WorktreeDetailDesktop';
import { HEADER_TOOLS } from '@/config/activity-bar-config';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

// =============================================================================
// Width model
// =============================================================================

const WIDTH = {
  /** Info and the rest of the controls group, tools aside. */
  controls: 300,
  /** One header tool, and the "…" button: both 32px. */
  tool: 32,
  /** The identity group's content cannot get narrower than this. */
  identityMin: 400,
};

let headerWidth = 1600;

function renderedControlsWidth(): number {
  const tools = HEADER_TOOLS.filter((t) =>
    document.querySelector(`[data-testid="header-tool-${t.id}"]`)
  ).length;
  const more = document.querySelector('[data-testid="header-tool-more"]') ? 1 : 0;
  return WIDTH.controls + (tools + more) * WIDTH.tool;
}

function identityAvailable(): number {
  return Math.max(0, headerWidth - renderedControlsWidth());
}

const isIdentityGroup = (el: Element) =>
  el.getAttribute('data-testid') === 'desktop-header-identity';

let restoreSpies: Array<() => void> = [];

beforeEach(() => {
  headerWidth = 1600;
  const clientWidth = vi
    .spyOn(Element.prototype, 'clientWidth', 'get')
    .mockImplementation(function (this: Element) {
      return isIdentityGroup(this) ? identityAvailable() : 0;
    });
  const scrollWidth = vi
    .spyOn(Element.prototype, 'scrollWidth', 'get')
    .mockImplementation(function (this: Element) {
      return isIdentityGroup(this) ? Math.max(identityAvailable(), WIDTH.identityMin) : 0;
    });
  restoreSpies = [() => clientWidth.mockRestore(), () => scrollWidth.mockRestore()];
});

afterEach(() => {
  restoreSpies.forEach((restore) => restore());
  document.body.innerHTML = '';
});

const baseProps = {
  worktreeName: 'feature/3591-tools',
  repositoryName: 'CommandMate',
  status: 'idle' as const,
  onInfoClick: vi.fn(),
};

function renderHeader(width: number, withTools = true) {
  headerWidth = width;
  const onActivityToggle = vi.fn();
  render(
    <DesktopHeader
      {...baseProps}
      activeActivity={withTools ? 'env' : undefined}
      onActivityToggle={withTools ? onActivityToggle : undefined}
    />
  );
  return { onActivityToggle };
}

function visibleToolCount(): number {
  return HEADER_TOOLS.filter((t) => screen.queryByTestId(`header-tool-${t.id}`)).length;
}

function identityClipped(): boolean {
  return /\boverflow-x-clip\b/.test(screen.getByTestId('desktop-header-identity').className);
}

// =============================================================================
// DesktopHeader
// =============================================================================

describe('DesktopHeader draws the worktree tools (Issue #3591)', () => {
  it('puts every tool in the controls group, after Info, when the header has room', () => {
    const { onActivityToggle } = renderHeader(1600);
    const controls = screen.getByTestId('desktop-header-controls');
    const bar = screen.getByTestId('header-tool-bar');
    expect(controls.contains(bar)).toBe(true);
    expect(screen.getByTestId('desktop-header-identity').contains(bar)).toBe(false);
    expect(controls.lastElementChild).toBe(bar);
    expect(visibleToolCount()).toBe(HEADER_TOOLS.length);
    expect(screen.queryByTestId('header-tool-more')).toBeNull();
    expect(screen.getByTestId('header-tool-env')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByTestId('header-tool-git'));
    expect(onActivityToggle).toHaveBeenCalledWith('git');
  });

  it('draws no tools without onActivityToggle (the pre-#3591 header)', () => {
    renderHeader(1600, false);
    expect(screen.queryByTestId('header-tool-bar')).toBeNull();
  });
});

describe('useDesktopHeaderFit folds the tools before clipping (Issue #3591)', () => {
  it('folds nothing when everything fits', () => {
    renderHeader(1000); // 1000 - 300 - 9×32 = 412 ≥ 400
    expect(visibleToolCount()).toBe(9);
    expect(identityClipped()).toBe(false);
  });

  it('folds the trailing tools one at a time until the identity fits, without clipping', () => {
    // 900 - 300 = 600 for the identity and the tools: 400 + 6 × 32 = 592 fits
    // (5 tools + "…").
    renderHeader(900);
    expect(visibleToolCount()).toBe(5);
    expect(screen.getByTestId('header-tool-more')).toBeInTheDocument();
    expect(identityClipped()).toBe(false);
    // The open tool (env) is folded: "…" carries the mark.
    expect(screen.getByTestId('header-tool-more')).toHaveAttribute('data-active', 'true');
  });

  it('clips the identity only once every tool has folded', () => {
    renderHeader(500);
    expect(visibleToolCount()).toBe(0);
    expect(screen.getByTestId('header-tool-more')).toBeInTheDocument();
    expect(identityClipped()).toBe(true);
  });

  it('negative control: without tools, a narrow header clips straight away (pre-#3591)', () => {
    renderHeader(500, false);
    expect(identityClipped()).toBe(true);
  });
});

// =============================================================================
// WorktreeDesktopLayout — the pane on the right
// =============================================================================

function renderLayout(pinned: boolean, onActivityPaneResize?: (n: number) => void) {
  return render(
    <WorktreeDesktopLayout
      activityPane={<div data-testid="pane" />}
      rightPane={<div data-testid="body" />}
      activityPanePinned={pinned}
      activityPaneWidth={20}
      onActivityPaneResize={onActivityPaneResize}
    />
  );
}

describe('WorktreeDesktopLayout opens the pane from the right (Issue #3591)', () => {
  it('lays an unpinned pane over the body from the right edge', () => {
    renderLayout(false);
    const slot = screen.getByTestId('activity-pane-slot');
    expect(slot.className).toMatch(/\bright-0\b/);
    expect(slot.className).toMatch(/\bborder-l\b/);
    expect(slot.className).not.toMatch(/\bleft-0\b/);
  });

  it('puts a pinned pane after the body, its resizer between them', () => {
    renderLayout(true);
    const order = Array.from(screen.getByTestId('desktop-layout').children).map(
      (el) => el.getAttribute('data-testid') ?? el.getAttribute('role')
    );
    expect(order).toEqual(['right-pane-slot', 'separator', 'activity-pane-slot']);
  });

  it('narrows a pinned pane when its resizer is dragged right', () => {
    const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
    const onResize = vi.fn();
    renderLayout(true, onResize);
    const resizer = screen.getByRole('separator');
    fireEvent.mouseDown(resizer, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 600 });
    fireEvent.mouseUp(document);
    offset.mockRestore();
    expect(onResize).toHaveBeenCalled();
    expect(onResize.mock.calls[0][0]).toBeLessThan(20);
  });
});

// =============================================================================
// focusActivityEntry
// =============================================================================

function mount(html: string): void {
  document.body.innerHTML = html;
}

describe('focusActivityEntry hands focus back to what opened the pane (Issue #3591)', () => {
  it('focuses the visible header tool', () => {
    mount('<button data-activity-entry="git" id="git"></button><button data-testid="header-tool-more"></button>');
    focusActivityEntry('git');
    expect(document.activeElement?.id).toBe('git');
  });

  it('falls back to the header "…" when the tool is folded', () => {
    mount('<button data-activity-entry="files"></button><button data-testid="header-tool-more" id="more"></button>');
    focusActivityEntry('env');
    expect(document.activeElement?.id).toBe('more');
  });

  it('focuses the Verification chip button inside its marked root', () => {
    mount(
      '<div data-activity-entry="verification"><button id="chip"></button><button id="reason"></button></div>' +
        '<button data-testid="split-action-bar-items-overflow"></button>'
    );
    focusActivityEntry('verification');
    expect(document.activeElement?.id).toBe('chip');
  });

  it('falls back to the second row "…" when the chip is folded there', () => {
    mount(
      '<button data-testid="header-tool-more" id="header-more"></button>' +
        '<button data-testid="split-action-bar-items-overflow" id="bar-more"></button>'
    );
    focusActivityEntry('verification');
    expect(document.activeElement?.id).toBe('bar-more');
  });
});

// =============================================================================
// The screen no longer mounts the vertical bar
// =============================================================================

const DESKTOP_SOURCE = path.resolve(__dirname, '../../../../src/components/worktree/WorktreeDetailDesktop.tsx');

/** Whether a worktree-screen source mounts the vertical ActivityBar column. */
function mountsVerticalActivityBar(source: string): boolean {
  return /from '@\/components\/worktree\/ActivityBar'/.test(source) || /<ActivityBar\b/.test(source);
}

describe('the PC worktree screen has no vertical activity bar column (Issue #3591)', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('positive control: the pre-#3591 wiring is detected', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3591-'));
    const file = path.join(tmpDir, 'WorktreeDetailDesktop.tsx');
    fs.writeFileSync(
      file,
      [
        "import { ActivityBar } from '@/components/worktree/ActivityBar';",
        'const activityBarMemo = useMemo(',
        '  () => <ActivityBar active={activeActivity} onToggle={onActivityToggle} />,',
        '  [activeActivity, onActivityToggle]',
        ');',
      ].join('\n')
    );
    expect(mountsVerticalActivityBar(fs.readFileSync(file, 'utf-8'))).toBe(true);
  });

  it('WorktreeDetailDesktop does not mount it', () => {
    expect(mountsVerticalActivityBar(fs.readFileSync(DESKTOP_SOURCE, 'utf-8'))).toBe(false);
  });
});
