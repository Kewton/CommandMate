/**
 * @vitest-environment jsdom
 */

/**
 * Sidebar preferences that survive a reload (Issue #2374).
 *
 * Phase 1 of the Issue: the open/closed state joins sort / view-mode / width in
 * localStorage. Until now a user who collapsed the sidebar got it back on every
 * reload — which is also why the repository tab bar's default rule ("only while
 * collapsed") would have been unreachable after F5.
 *
 * A remount with a fresh `SidebarProvider` is what "reload" means here: the
 * provider reads localStorage in a mount effect, so unmounting and mounting a
 * new one exercises exactly the code path a page load does.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import React from 'react';
import {
  SidebarProvider,
  useSidebarContext,
  SIDEBAR_OPEN_STORAGE_KEY,
  REPO_TAB_BAR_MODE_STORAGE_KEY,
  DEFAULT_REPO_TAB_BAR_MODE,
} from '@/contexts/SidebarContext';
import { SIDEBAR_GROUP_ORDER_CACHE_STORAGE_KEY } from '@/lib/sidebar-utils';

function Consumer() {
  const ctx = useSidebarContext();
  return (
    <div>
      <span data-testid="isOpen">{String(ctx.isOpen)}</span>
      <span data-testid="mode">{ctx.repoTabBarMode}</span>
      <span data-testid="order">{ctx.repositoryOrder.join(',')}</span>
      <button data-testid="toggle" onClick={ctx.toggle}>
        toggle
      </button>
      <button data-testid="hide" onClick={() => ctx.setRepoTabBarMode('hidden')}>
        hide
      </button>
      <button
        data-testid="reorder"
        onClick={() => ctx.setRepositoryOrder(['beta', 'alpha'])}
      >
        reorder
      </button>
    </div>
  );
}

function mount() {
  return render(
    <SidebarProvider>
      <Consumer />
    </SidebarProvider>
  );
}

describe('sidebar open state persistence (Issue #2374)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('still defaults to open when nothing has been stored', () => {
    mount();
    expect(screen.getByTestId('isOpen').textContent).toBe('true');
  });

  it('writes the collapsed state to localStorage when the user closes it', () => {
    mount();
    act(() => {
      screen.getByTestId('toggle').click();
    });
    expect(screen.getByTestId('isOpen').textContent).toBe('false');
    expect(localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY)).toBe('false');
  });

  it('comes back collapsed on the next mount', () => {
    mount();
    act(() => {
      screen.getByTestId('toggle').click();
    });
    cleanup();

    mount();
    expect(screen.getByTestId('isOpen').textContent).toBe('false');
  });

  it('comes back open once the user re-opens it', () => {
    localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, 'false');
    mount();
    expect(screen.getByTestId('isOpen').textContent).toBe('false');
    act(() => {
      screen.getByTestId('toggle').click();
    });
    cleanup();

    mount();
    expect(screen.getByTestId('isOpen').textContent).toBe('true');
  });

  it('ignores a corrupted stored value instead of collapsing', () => {
    localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, '{"isOpen":false}');
    mount();
    expect(screen.getByTestId('isOpen').textContent).toBe('true');
  });
});

describe('repository tab bar mode persistence (Issue #2374)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to the collapsed-only rule', () => {
    mount();
    expect(screen.getByTestId('mode').textContent).toBe(DEFAULT_REPO_TAB_BAR_MODE);
  });

  it('persists and restores the chosen mode', () => {
    mount();
    act(() => {
      screen.getByTestId('hide').click();
    });
    expect(localStorage.getItem(REPO_TAB_BAR_MODE_STORAGE_KEY)).toBe('hidden');
    cleanup();

    mount();
    expect(screen.getByTestId('mode').textContent).toBe('hidden');
  });

  it('falls back to the default for an unknown stored mode', () => {
    localStorage.setItem(REPO_TAB_BAR_MODE_STORAGE_KEY, 'sometimes');
    mount();
    expect(screen.getByTestId('mode').textContent).toBe(DEFAULT_REPO_TAB_BAR_MODE);
  });
});

describe('repository order shared through the context (Issue #2374)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('primes itself from the cache so the tabs paint in order on the first frame', () => {
    localStorage.setItem(
      SIDEBAR_GROUP_ORDER_CACHE_STORAGE_KEY,
      JSON.stringify(['beta', 'alpha'])
    );
    mount();
    expect(screen.getByTestId('order').textContent).toBe('beta,alpha');
  });

  /**
   * The write-through is what makes a sidebar drag survive a reload without the
   * Sidebar component re-fetching first — the cache is read synchronously at
   * provider construction, above.
   */
  it('writes through to the cache when the order changes', () => {
    mount();
    act(() => {
      screen.getByTestId('reorder').click();
    });
    expect(screen.getByTestId('order').textContent).toBe('beta,alpha');
    expect(localStorage.getItem(SIDEBAR_GROUP_ORDER_CACHE_STORAGE_KEY)).toBe(
      JSON.stringify(['beta', 'alpha'])
    );
  });
});
