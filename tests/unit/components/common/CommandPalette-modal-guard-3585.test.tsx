/**
 * @vitest-environment jsdom
 */

/**
 * ⌘K does not open the palette over another modal or an open Radix menu
 * (Issue #3585) — the same `isAnyModalOpen()` rule as New task and Mod+B.
 * Closing the palette with ⌘K while it is open is unchanged.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('@/contexts/PcDisplaySizeContext', () => ({
  usePcDisplaySizeContext: () => ({ size: 'medium', setSize: vi.fn(), isMobile: false, factor: 1, isAvailable: false }),
}));

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => null,
}));

vi.mock('@/hooks/useLocaleSwitch', () => ({
  useLocaleSwitch: () => ({ currentLocale: 'en', switchLocale: vi.fn() }),
}));

import { CommandPalette } from '@/components/common/CommandPalette';
import { ToastProvider } from '@/components/common/Toast';
import { ViewTransitionsProvider } from '@/components/providers/ViewTransitionsProvider';
import { CommandPaletteProvider } from '@/contexts/CommandPaletteContext';

function renderPalette() {
  return render(
    <ToastProvider>
      <ViewTransitionsProvider>
        <CommandPaletteProvider>
          <CommandPalette />
        </CommandPaletteProvider>
      </ViewTransitionsProvider>
    </ToastProvider>,
  );
}

// cmdk needs these; jsdom has neither (same stubs as CommandPalette.test.tsx).
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  window.localStorage.clear();
});

function mount(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

const pressK = () => fireEvent.keyDown(window, { key: 'k', metaKey: true });

describe('CommandPalette: ⌘K stands down over other modals (Issue #3585)', () => {
  const cases: Array<[string, string]> = [
    ['a settings modal', '<div role="dialog" aria-modal="true" data-testid="settings"></div>'],
    ['the help (?) modal', '<div role="dialog" aria-modal="true" data-testid="help"></div>'],
    ['an open Radix menu', '<div role="menu" data-state="open"></div>'],
  ];

  it.each(cases)('does not open while %s is shown, opens once it is gone', (_name, html) => {
    renderPalette();
    const el = mount(html);
    pressK();
    expect(screen.queryByTestId('command-palette')).toBeNull();

    el.remove();
    pressK();
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
  });

  it('still closes the palette with ⌘K while it is open (negative control)', () => {
    renderPalette();
    pressK();
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
    pressK();
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });
});
