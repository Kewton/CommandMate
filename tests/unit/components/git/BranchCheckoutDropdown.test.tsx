/**
 * Tests for BranchCheckoutDropdown positioning (Issue #1363).
 *
 * The menu used to be `absolute top-full z-20` inside the Git pane's
 * `overflow-y-auto` scroll container: it was clipped by that ancestor, ran off
 * the bottom of the viewport when the trigger sat low (no flip), and sat below
 * other overlays. These tests pin the portal + flip + clamp behavior.
 *
 * jsdom has no layout engine, so `getBoundingClientRect` is stubbed per element
 * (discriminated by data-testid) to simulate the trigger position and the
 * menu's rendered size.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BranchCheckoutDropdown } from '@/components/worktree/git/BranchCheckoutDropdown';
import type { BranchInfo } from '@/types/git';

const VIEWPORT_HEIGHT = 800;
const VIEWPORT_WIDTH = 1000;

/** Height the stubbed menu reports (matches the `max-h-64` = 256px cap). */
const MENU_HEIGHT = 256;
const MENU_WIDTH = 192;

function branch(name: string, overrides: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name,
    isCurrent: false,
    isRemote: false,
    isDefault: false,
    upstream: null,
    aheadBehind: null,
    checkedOutWorktreePath: null,
    ...overrides,
  };
}

const BRANCHES: BranchInfo[] = [
  branch('main', { isDefault: true }),
  branch('feature/x'),
  branch('current', { isCurrent: true }),
];

/**
 * Stubs layout: the trigger sits at `triggerTop` (24px tall, `left` px from the
 * left edge); the menu always reports MENU_HEIGHT x MENU_WIDTH.
 */
function stubLayout({ triggerTop, left = 100 }: { triggerTop: number; left?: number }): void {
  window.innerHeight = VIEWPORT_HEIGHT;
  window.innerWidth = VIEWPORT_WIDTH;

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ): DOMRect {
    const testid = this.dataset.testid;
    if (testid === 'branch-checkout-dropdown') {
      return { top: triggerTop, bottom: triggerTop + 24, left, right: left + 80, width: 80, height: 24 } as DOMRect;
    }
    if (testid === 'branch-checkout-menu') {
      return { top: 0, bottom: MENU_HEIGHT, left: 0, right: MENU_WIDTH, width: MENU_WIDTH, height: MENU_HEIGHT } as DOMRect;
    }
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
  });
}

function renderDropdown(props: Partial<React.ComponentProps<typeof BranchCheckoutDropdown>> = {}) {
  return render(
    <BranchCheckoutDropdown
      branches={BRANCHES}
      busy={false}
      actionError={null}
      hasRunningSession={false}
      isMobile={false}
      onCheckout={vi.fn()}
      {...props}
    />
  );
}

function openMenu(): HTMLElement {
  fireEvent.click(screen.getByTestId('branch-checkout-dropdown-toggle'));
  return screen.getByTestId('branch-checkout-menu');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BranchCheckoutDropdown positioning (Issue #1363)', () => {
  it('renders the menu through a portal to document.body, outside the clipping ancestor', () => {
    stubLayout({ triggerTop: 100 });
    // A scroll container standing in for the Git pane's `overflow-y-auto`.
    const { container } = renderDropdown();

    const menu = openMenu();

    // The regression: while the menu lived inside the component subtree, the
    // pane's overflow clipped it.
    expect(menu.closest('[data-testid="branch-checkout-dropdown"]')).toBeNull();
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
  });

  it('positions the menu below the trigger when it fits', () => {
    stubLayout({ triggerTop: 100 });
    renderDropdown();

    const menu = openMenu();

    // trigger.bottom (124) + gap (4)
    expect(menu.style.top).toBe('128px');
    expect(menu.style.left).toBe('100px');
  });

  it('flips the menu above the trigger when it would overflow the bottom edge', () => {
    // trigger.bottom = 724; 800 - 724 = 76px below < 256 needed, and 700px above.
    stubLayout({ triggerTop: 700 });
    renderDropdown();

    const menu = openMenu();

    // trigger.top (700) - menu height (256) - gap (4)
    expect(menu.style.top).toBe('440px');
    // Never runs past the bottom edge.
    expect(parseFloat(menu.style.top) + MENU_HEIGHT).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
  });

  it('keeps the menu inside the viewport when there is no room above or below', () => {
    // Tall-menu / short-viewport case: 300px viewport, trigger near the bottom.
    window.innerHeight = 300;
    window.innerWidth = VIEWPORT_WIDTH;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ): DOMRect {
      const testid = this.dataset.testid;
      if (testid === 'branch-checkout-dropdown') {
        return { top: 260, bottom: 284, left: 100, right: 180, width: 80, height: 24 } as DOMRect;
      }
      if (testid === 'branch-checkout-menu') {
        return { top: 0, bottom: MENU_HEIGHT, left: 0, right: MENU_WIDTH, width: MENU_WIDTH, height: MENU_HEIGHT } as DOMRect;
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
    });
    renderDropdown();

    const menu = openMenu();

    // Flip up would put it at 260 - 256 - 4 = 0; clamped to the 8px margin.
    expect(menu.style.top).toBe('8px');
  });

  it('clamps the menu horizontally when the trigger sits near the right edge', () => {
    stubLayout({ triggerTop: 100, left: 950 });
    renderDropdown();

    const menu = openMenu();

    // 1000 - 192 - 8 = 800
    expect(menu.style.left).toBe('800px');
    expect(parseFloat(menu.style.left) + MENU_WIDTH).toBeLessThanOrEqual(VIEWPORT_WIDTH);
  });

  it('uses a fixed, above-the-pane z-index rather than the clipped z-20 stacking', () => {
    stubLayout({ triggerTop: 100 });
    renderDropdown();

    const menu = openMenu();

    expect(menu.className).toContain('fixed');
    expect(menu.className).toContain('z-50');
    expect(menu.className).not.toContain('z-20');
    expect(menu.className).not.toContain('absolute');
  });

  it('repositions the menu when an ancestor scrolls', () => {
    stubLayout({ triggerTop: 100 });
    renderDropdown();

    const menu = openMenu();
    expect(menu.style.top).toBe('128px');

    // The Git pane scrolls: the trigger moves up, and the fixed menu must follow.
    vi.restoreAllMocks();
    stubLayout({ triggerTop: 40 });
    fireEvent.scroll(window);

    expect(menu.style.top).toBe('68px');
  });

  it('removes the menu from the DOM when closed', () => {
    stubLayout({ triggerTop: 100 });
    renderDropdown();

    openMenu();
    fireEvent.click(screen.getByTestId('branch-checkout-dropdown-toggle'));

    expect(screen.queryByTestId('branch-checkout-menu')).toBeNull();
  });

  it('still opens the checkout confirm dialog from a portaled menu item', () => {
    stubLayout({ triggerTop: 100 });
    const onCheckout = vi.fn();
    renderDropdown({ onCheckout });

    openMenu();
    // The global next-intl mock echoes keys, so every row shares an aria-label;
    // select by menu role instead. Order follows `branches` minus the current one.
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    fireEvent.click(items[0]);

    expect(screen.getByTestId('branch-checkout-confirm')).toBeInTheDocument();
    // Selecting a branch closes the menu, so the portal and the dialog never
    // stack against each other.
    expect(screen.queryByTestId('branch-checkout-menu')).toBeNull();

    fireEvent.click(screen.getByTestId('branch-checkout-confirm-button'));
    expect(onCheckout).toHaveBeenCalledWith(expect.objectContaining({ name: 'main' }), false);
  });
});
