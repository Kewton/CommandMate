/**
 * Unit tests for CommandPalette (Issue #1053)
 *
 * Covers: open/close via ⌘K / Ctrl+K, the typing-context guard, Escape,
 * focus-on-open + focus-restore-on-close, Navigation / Worktrees / Actions
 * groups, incremental search filtering, the empty & loading states, the
 * shared-cache data source (including the error fallback), and the mobile
 * bottom-nav trigger.
 *
 * next-intl is globally mocked (tests/setup.ts) to echo the full key, so
 * assertions reference keys like `common.nav.sessions`. Nav labels moved from
 * the `commandPalette` namespace to the shared `common` one in Issue #1197 so
 * Home's quick actions and the palette resolve the same strings.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// --- Mocks -----------------------------------------------------------------

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => '/',
}));

let currentTheme = 'dark';
const setThemeMock = vi.fn((value: string) => {
  currentTheme = value;
});
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: currentTheme, setTheme: setThemeMock }),
}));

const setSizeMock = vi.fn();
let ctxIsMobile = false;
vi.mock('@/contexts/PcDisplaySizeContext', () => ({
  usePcDisplaySizeContext: () => ({
    size: 'medium',
    setSize: setSizeMock,
    isMobile: ctxIsMobile,
    factor: 1,
    isAvailable: false,
  }),
}));

interface MockCache {
  worktrees: Array<Record<string, unknown>>;
  repositories: unknown[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
}
let mockCache: MockCache | null;
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => mockCache,
}));

// Enhancements (Issue #1077): repository sync + language switch actions.
const { repositorySyncMock, switchLocaleMock } = vi.hoisted(() => ({
  repositorySyncMock: vi.fn(),
  switchLocaleMock: vi.fn(),
}));
vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    repositoryApi: { ...actual.repositoryApi, sync: repositorySyncMock },
  };
});
vi.mock('@/hooks/useLocaleSwitch', () => ({
  useLocaleSwitch: () => ({ currentLocale: 'en', switchLocale: switchLocaleMock }),
}));

import { CommandPalette, isTypingTarget } from '@/components/common/CommandPalette';
import { CommandPaletteProvider } from '@/contexts/CommandPaletteContext';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { KeyboardShortcutsOverlay } from '@/components/common/KeyboardShortcutsOverlay';
import { GlobalMobileNav } from '@/components/mobile/GlobalMobileNav';
import { Header } from '@/components/layout/Header';

const SAMPLE_WORKTREES = [
  { id: 'wt-login', name: 'feature/login', branch: 'feature/login', repositoryName: 'MyApp' },
  { id: 'wt-dark', name: 'feature/dark-mode', branch: 'feature/dark-mode', repositoryName: 'MyApp' },
];

function makeCache(overrides: Partial<MockCache> = {}): MockCache {
  return {
    worktrees: SAMPLE_WORKTREES,
    repositories: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  };
}

function renderPalette() {
  return render(
    <CommandPaletteProvider>
      <CommandPalette />
    </CommandPaletteProvider>
  );
}

function pressKey(target: EventTarget, init: KeyboardEventInit) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
}

describe('CommandPalette (Issue #1053)', () => {
  beforeEach(() => {
    currentTheme = 'dark';
    ctxIsMobile = false;
    mockCache = makeCache();
    pushMock.mockClear();
    setThemeMock.mockClear();
    setSizeMock.mockClear();
    switchLocaleMock.mockClear();
    repositorySyncMock.mockReset();
    repositorySyncMock.mockResolvedValue({
      success: true,
      message: '',
      worktreeCount: 0,
      repositoryCount: 0,
      repositories: [],
    });
    localStorage.clear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // --- isTypingTarget --------------------------------------------------------

  describe('isTypingTarget', () => {
    it('treats form fields, contentEditable and the terminal log as typing targets', () => {
      const input = document.createElement('input');
      const textarea = document.createElement('textarea');
      const select = document.createElement('select');
      const editable = document.createElement('div');
      Object.defineProperty(editable, 'isContentEditable', { value: true });
      const terminal = document.createElement('div');
      terminal.setAttribute('role', 'log');
      const inner = document.createElement('span');
      terminal.appendChild(inner);

      expect(isTypingTarget(input)).toBe(true);
      expect(isTypingTarget(textarea)).toBe(true);
      expect(isTypingTarget(select)).toBe(true);
      expect(isTypingTarget(editable)).toBe(true);
      expect(isTypingTarget(terminal)).toBe(true);
      expect(isTypingTarget(inner)).toBe(true); // nested inside role="log"
    });

    it('does not treat plain elements or null as typing targets', () => {
      expect(isTypingTarget(document.createElement('div'))).toBe(false);
      expect(isTypingTarget(document.createElement('button'))).toBe(false);
      expect(isTypingTarget(null)).toBe(false);
    });
  });

  // --- Open / close ----------------------------------------------------------

  it('renders nothing when closed', () => {
    renderPalette();
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('opens on Cmd+K and closes on a second Cmd+K (toggle)', () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();

    pressKey(window, { key: 'k', metaKey: true });
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('opens on Ctrl+K (Windows)', () => {
    renderPalette();
    pressKey(window, { key: 'k', ctrlKey: true });
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
  });

  it('closes on Escape', () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
    pressKey(window, { key: 'Escape' });
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('closes when the backdrop is clicked', () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    const overlay = screen.getByTestId('command-palette').firstChild as HTMLElement;
    fireEvent.click(overlay);
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('does NOT open while an input is focused (no shortcut hijack)', () => {
    renderPalette();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    pressKey(input, { key: 'k', metaKey: true });
    expect(screen.queryByTestId('command-palette')).toBeNull();
    input.remove();
  });

  it('does NOT open while the terminal log pane is focused', () => {
    renderPalette();
    const terminal = document.createElement('div');
    terminal.setAttribute('role', 'log');
    terminal.tabIndex = 0;
    document.body.appendChild(terminal);
    terminal.focus();
    pressKey(terminal, { key: 'k', metaKey: true });
    expect(screen.queryByTestId('command-palette')).toBeNull();
    terminal.remove();
  });

  // --- Focus management ------------------------------------------------------

  it('focuses the search input on open so the keyboard works immediately', () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('command-palette-input'));
  });

  it('restores focus to the previously focused element on close', () => {
    renderPalette();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    pressKey(window, { key: 'k', metaKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('command-palette-input'));

    pressKey(window, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  // --- Navigation group ------------------------------------------------------

  it('renders navigation items and pushes the route on select', () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });

    const sessions = screen.getByText('common.nav.sessions');
    fireEvent.click(sessions);

    expect(pushMock).toHaveBeenCalledWith('/sessions');
    // palette closes after running a command
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('keyboard nav works after open without a click (auto-focused input + Enter)', async () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });

    const input = screen.getByTestId('command-palette-input') as HTMLInputElement;
    // The input is auto-focused, so keystrokes reach cmdk without a click.
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'sessions' } });
    await waitFor(() => {
      expect(screen.queryByText('common.nav.home')).toBeNull();
    });

    // Enter on the focused element selects the single filtered item.
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(pushMock).toHaveBeenCalledWith('/sessions');
  });

  it('filters items by the search query', async () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    const input = screen.getByTestId('command-palette-input');
    fireEvent.change(input, { target: { value: 'sessions' } });

    await waitFor(() => {
      expect(screen.getByText('common.nav.sessions')).toBeInTheDocument();
      expect(screen.queryByText('common.nav.home')).toBeNull();
    });
  });

  it('shows the empty state when nothing matches', async () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    const input = screen.getByTestId('command-palette-input');
    fireEvent.change(input, { target: { value: 'zzz-no-match-zzz' } });

    await waitFor(() => {
      expect(screen.getByTestId('command-palette-empty')).toBeInTheDocument();
    });
  });

  // --- Worktrees group (shared cache) ---------------------------------------

  it('renders worktrees from the shared cache and navigates on select', () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });

    const branch = screen.getByText('feature/login');
    fireEvent.click(branch);
    expect(pushMock).toHaveBeenCalledWith('/worktrees/wt-login');
  });

  it('reflects a later cache update (new worktree becomes searchable)', () => {
    mockCache = makeCache({
      worktrees: [
        ...SAMPLE_WORKTREES,
        { id: 'wt-new', name: 'feature/added-later', branch: 'feature/added-later', repositoryName: 'MyApp' },
      ],
    });
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    expect(screen.getByText('feature/added-later')).toBeInTheDocument();
  });

  it('falls back to Navigation-only when the cache reports an error', () => {
    mockCache = makeCache({ worktrees: [], error: new Error('boom') });
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });

    expect(screen.getByText('common.nav.sessions')).toBeInTheDocument();
    expect(screen.queryByText('feature/login')).toBeNull();
    expect(screen.queryByText('commandPalette.groups.worktrees')).toBeNull();
  });

  it('hides worktrees on cache error even if stale data is present', () => {
    mockCache = makeCache({ error: new Error('boom') }); // worktrees still populated
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    expect(screen.queryByText('feature/login')).toBeNull();
  });

  it('shows a loading row while the cache is loading with no data yet', () => {
    mockCache = makeCache({ worktrees: [], isLoading: true });
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    expect(screen.getByTestId('command-palette-loading')).toBeInTheDocument();
  });

  it('degrades gracefully when no cache provider is present (null context)', () => {
    mockCache = null;
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    // Navigation still works; no worktrees group
    expect(screen.getByText('common.nav.sessions')).toBeInTheDocument();
    expect(screen.queryByText('commandPalette.groups.worktrees')).toBeNull();
  });

  // --- Actions group ---------------------------------------------------------

  it('toggles the theme from the Actions group', () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    // dark theme -> offers "switch to light"
    fireEvent.click(screen.getByText('commandPalette.actions.toLight'));
    expect(setThemeMock).toHaveBeenCalledWith('light');
  });

  it('offers PC display-size actions on desktop and applies them', () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    // label: "commandPalette.actions.displaySizePrefix: common.displaySize.small"
    fireEvent.click(
      screen.getByText(/displaySizePrefix.*common\.displaySize\.small/)
    );
    expect(setSizeMock).toHaveBeenCalledWith('small');
  });

  it('hides display-size actions on mobile', () => {
    ctxIsMobile = true;
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    expect(screen.queryByText(/common\.displaySize\.small/)).toBeNull();
    // theme action is still available on mobile
    expect(screen.getByText('commandPalette.actions.toLight')).toBeInTheDocument();
  });

  // --- Mobile trigger --------------------------------------------------------

  it('opens the palette from the mobile bottom-nav trigger', () => {
    render(
      <CommandPaletteProvider>
        <GlobalMobileNav />
        <CommandPalette />
      </CommandPaletteProvider>
    );
    expect(screen.queryByTestId('command-palette')).toBeNull();
    fireEvent.click(screen.getByTestId('mobile-command-palette-trigger'));
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
  });

  // --- Enhancements (Issue #1077) -------------------------------------------

  it('renders the keyboard-hint footer', () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    expect(screen.getByText('commandPalette.footer.navigate')).toBeInTheDocument();
    expect(screen.getByText('commandPalette.footer.select')).toBeInTheDocument();
    expect(screen.getByText('commandPalette.footer.close')).toBeInTheDocument();
  });

  it('opens the palette from the header search pill', () => {
    render(
      <CommandPaletteProvider>
        <Header />
        <CommandPalette />
      </CommandPaletteProvider>
    );
    expect(screen.queryByTestId('command-palette')).toBeNull();
    fireEvent.click(screen.getByTestId('header-command-palette-trigger'));
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
  });

  it('opens the keyboard-shortcuts overlay from the Actions group (Issue #1130)', () => {
    render(
      <CommandPaletteProvider>
        <KeyboardShortcutsProvider>
          <CommandPalette />
          <KeyboardShortcutsOverlay />
        </KeyboardShortcutsProvider>
      </CommandPaletteProvider>
    );
    pressKey(window, { key: 'k', metaKey: true });
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();

    fireEvent.click(screen.getByText('commandPalette.actions.keyboardShortcuts'));
    // Palette closes and the overlay opens.
    expect(screen.queryByTestId('command-palette')).toBeNull();
    expect(screen.getByTestId('keyboard-shortcuts-overlay')).toBeInTheDocument();
  });

  it('syncs repositories from the Actions group and shows a success toast', async () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });

    fireEvent.click(screen.getByText('commandPalette.actions.syncRepositories'));
    expect(repositorySyncMock).toHaveBeenCalledTimes(1);
    // The toast survives the palette closing (persistent ToastContainer).
    expect(
      await screen.findByText('commandPalette.actions.syncSuccess')
    ).toBeInTheDocument();
  });

  it('records an executed command and surfaces it in the Recent group on reopen', () => {
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    fireEvent.click(screen.getByText('common.nav.sessions'));
    expect(pushMock).toHaveBeenCalledWith('/sessions');

    // Reopen: the executed command now appears under the Recent group too.
    pressKey(window, { key: 'k', metaKey: true });
    expect(screen.getByText('commandPalette.groups.recent')).toBeInTheDocument();
    expect(
      screen.getAllByText('common.nav.sessions').length
    ).toBeGreaterThanOrEqual(2);
  });

  it('ignores a recent entry whose worktree no longer exists', () => {
    localStorage.setItem(
      'cm.palette.recents',
      JSON.stringify([{ kind: 'worktree', id: 'wt-gone' }])
    );
    renderPalette();
    pressKey(window, { key: 'k', metaKey: true });
    // The only recent entry is a dead worktree → no Recent group at all.
    expect(screen.queryByText('commandPalette.groups.recent')).toBeNull();
  });
});
