/**
 * Tests for ActivityBar (Issue #727, updated by Issue #730)
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Files, StickyNote } from 'lucide-react';
import { ActivityBar } from '@/components/worktree/ActivityBar';
import { ACTIVITIES } from '@/config/activity-bar-config';
import { TOOLTIP_DELAY_MS } from '@/components/common/Tooltip';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import { AuthProvider } from '@/contexts/AuthContext';

// Issue #1277: this file asserts rendered wording (tab aria-labels / tooltips
// resolved from ACTIVITIES[].labelKey), so it must go through the real
// dictionary. The global mock in tests/setup.ts echoes `worktree.<key>` back and
// would keep these assertions green even if the key did not exist.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

// Issue #747: ActivityBar now reads/controls the sidebar via useSidebarContext().
// Mock the hook so the component can render without a SidebarProvider and so the
// toggle behaviour (click → toggle, aria-expanded ← isOpen) can be asserted.
const sidebarMock = vi.hoisted(() => ({ isOpen: true, toggle: vi.fn() }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({ isOpen: sidebarMock.isOpen, toggle: sidebarMock.toggle }),
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

const themeMock = vi.hoisted(() => ({ theme: 'dark' as string | undefined, setTheme: vi.fn() }));
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: themeMock.theme, setTheme: themeMock.setTheme }),
}));

const localeMock = vi.hoisted(() => ({ switchLocale: vi.fn() }));
vi.mock('@/hooks/useLocaleSwitch', () => ({
  useLocaleSwitch: () => ({ currentLocale: 'en', switchLocale: localeMock.switchLocale }),
}));

describe('ActivityBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidebarMock.isOpen = true;
    themeMock.theme = 'dark';
  });

  it('renders all 10 activity tabs', () => {
    render(<ActivityBar active="files" onToggle={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(ACTIVITIES.length);
    // Issue #1816 added `verification` (9th); Issue #1968 added `env` (10th).
    // The literal is kept alongside ACTIVITIES.length on purpose: it is what
    // makes an accidental drop of an activity fail here instead of agreeing
    // with itself.
    expect(tabs).toHaveLength(10);
  });

  it('renders with role="tablist" and aria-orientation="vertical"', () => {
    render(<ActivityBar active="files" onToggle={() => {}} />);
    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('marks the active tab with aria-selected=true and others false', () => {
    render(<ActivityBar active="git" onToggle={() => {}} />);
    const gitTab = screen.getByTestId('activity-bar-button-git');
    const filesTab = screen.getByTestId('activity-bar-button-files');
    expect(gitTab).toHaveAttribute('aria-selected', 'true');
    expect(filesTab).toHaveAttribute('aria-selected', 'false');
  });

  it('every tab exposes aria-controls="worktree-activity-pane"', () => {
    render(<ActivityBar active="files" onToggle={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    for (const tab of tabs) {
      expect(tab).toHaveAttribute('aria-controls', 'worktree-activity-pane');
    }
  });

  it('container has id="worktree-activity-bar"', () => {
    render(<ActivityBar active="files" onToggle={() => {}} />);
    expect(document.getElementById('worktree-activity-bar')).not.toBeNull();
  });

  it('calls onToggle with the clicked activity id', () => {
    const onToggle = vi.fn();
    render(<ActivityBar active="files" onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('activity-bar-button-git'));
    expect(onToggle).toHaveBeenCalledWith('git');
  });

  it('re-clicking the active activity also calls onToggle (parent handles close)', () => {
    const onToggle = vi.fn();
    render(<ActivityBar active="files" onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('activity-bar-button-files'));
    expect(onToggle).toHaveBeenCalledWith('files');
  });

  describe('Keyboard navigation', () => {
    it('Enter key activates the focused tab', () => {
      const onToggle = vi.fn();
      render(<ActivityBar active="files" onToggle={onToggle} />);
      const gitTab = screen.getByTestId('activity-bar-button-git');
      fireEvent.keyDown(gitTab, { key: 'Enter' });
      expect(onToggle).toHaveBeenCalledWith('git');
    });

    it('Space key activates the focused tab', () => {
      const onToggle = vi.fn();
      render(<ActivityBar active="files" onToggle={onToggle} />);
      const notesTab = screen.getByTestId('activity-bar-button-notes');
      fireEvent.keyDown(notesTab, { key: ' ' });
      expect(onToggle).toHaveBeenCalledWith('notes');
    });

    it('ArrowDown moves focus to the next tab (wrap-around)', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const last = screen.getByTestId(`activity-bar-button-${ACTIVITIES[ACTIVITIES.length - 1].id}`);
      last.focus();
      fireEvent.keyDown(last, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(
        screen.getByTestId(`activity-bar-button-${ACTIVITIES[0].id}`)
      );
    });

    it('ArrowUp moves focus to the previous tab (wrap-around)', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const first = screen.getByTestId(`activity-bar-button-${ACTIVITIES[0].id}`);
      first.focus();
      fireEvent.keyDown(first, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(
        screen.getByTestId(`activity-bar-button-${ACTIVITIES[ACTIVITIES.length - 1].id}`)
      );
    });

    it('Home moves focus to the first tab', () => {
      render(<ActivityBar active="git" onToggle={() => {}} />);
      const mid = screen.getByTestId(`activity-bar-button-${ACTIVITIES[2].id}`);
      mid.focus();
      fireEvent.keyDown(mid, { key: 'Home' });
      expect(document.activeElement).toBe(
        screen.getByTestId(`activity-bar-button-${ACTIVITIES[0].id}`)
      );
    });

    it('End moves focus to the last tab', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const first = screen.getByTestId(`activity-bar-button-${ACTIVITIES[0].id}`);
      first.focus();
      fireEvent.keyDown(first, { key: 'End' });
      expect(document.activeElement).toBe(
        screen.getByTestId(`activity-bar-button-${ACTIVITIES[ACTIVITIES.length - 1].id}`)
      );
    });
  });

  describe('Sidebar toggle (Issue #747)', () => {
    it('renders the sidebar toggle button at the top with data-testid and aria-label', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const toggle = screen.getByTestId('activity-bar-toggle-sidebar');
      expect(toggle).toBeInTheDocument();
      expect(toggle).toHaveAttribute('aria-label', 'Toggle sidebar');
    });

    it('calls the sidebar context toggle when clicked', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      fireEvent.click(screen.getByTestId('activity-bar-toggle-sidebar'));
      expect(sidebarMock.toggle).toHaveBeenCalledTimes(1);
    });

    it('reflects the open sidebar state via aria-expanded=true', () => {
      sidebarMock.isOpen = true;
      render(<ActivityBar active="files" onToggle={() => {}} />);
      expect(screen.getByTestId('activity-bar-toggle-sidebar')).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    });

    it('reflects the closed sidebar state via aria-expanded=false', () => {
      sidebarMock.isOpen = false;
      render(<ActivityBar active="files" onToggle={() => {}} />);
      expect(screen.getByTestId('activity-bar-toggle-sidebar')).toHaveAttribute(
        'aria-expanded',
        'false'
      );
    });

    it('is NOT a tab and lives outside the tablist (tab count stays 10)', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const toggle = screen.getByTestId('activity-bar-toggle-sidebar');
      // Regression guard: keeping the toggle out of the tablist preserves the
      // roving-tabindex keyboard navigation and the WAI-ARIA tab count.
      expect(toggle).not.toHaveAttribute('role', 'tab');
      expect(screen.getByRole('tablist')).not.toContainElement(toggle);
      expect(screen.getAllByRole('tab')).toHaveLength(10);
    });

    it('does not trigger the activity onToggle when the sidebar toggle is clicked', () => {
      const onToggle = vi.fn();
      render(<ActivityBar active="files" onToggle={onToggle} />);
      fireEvent.click(screen.getByTestId('activity-bar-toggle-sidebar'));
      expect(onToggle).not.toHaveBeenCalled();
    });
  });

  it('handles active=null gracefully (no aria-selected=true anywhere)', () => {
    render(<ActivityBar active={null} onToggle={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    for (const tab of tabs) {
      expect(tab).toHaveAttribute('aria-selected', 'false');
    }
  });

  it('does not set native title attribute on tabs (Issue #730)', () => {
    render(<ActivityBar active="files" onToggle={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    for (const tab of tabs) {
      // Either no title attribute or empty
      const t = tab.getAttribute('title');
      expect(t === null || t === '').toBe(true);
    }
  });

  // Issue #2616: at 20px the single-sheet `File` the file tree used to show and
  // the `StickyNote` of notes were the same dog-eared page. This regression only
  // shows up visually, so the icons are pinned here: the config by identity, and
  // the rendered buttons by the `lucide-<name>` class lucide puts on the svg.
  describe('Icons (Issue #2616)', () => {
    /** The `lucide-<name>` class(es) of the svg the given tab draws. */
    function iconClassOf(tab: HTMLElement): string {
      const svg = tab.querySelector('svg');
      expect(svg).not.toBeNull();
      return Array.from(svg!.classList)
        .filter((c) => c.startsWith('lucide-'))
        .sort()
        .join(' ');
    }

    it('configures the file tree with the two-sheet `Files` icon', () => {
      const files = ACTIVITIES.find((a) => a.id === 'files');
      expect(files?.icon).toBe(Files);
    });

    it('keeps the file tree and notes on different icons', () => {
      const files = ACTIVITIES.find((a) => a.id === 'files');
      const notes = ACTIVITIES.find((a) => a.id === 'notes');
      expect(notes?.icon).toBe(StickyNote);
      expect(files?.icon).not.toBe(notes?.icon);
    });

    it('uses no icon twice across the activities', () => {
      const icons = ACTIVITIES.map((a) => a.icon);
      expect(new Set(icons).size).toBe(icons.length);
      expect(icons).toHaveLength(10);
    });

    it('draws lucide-files for the file tree and lucide-sticky-note for notes', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const filesTab = screen.getByTestId('activity-bar-button-files');
      const notesTab = screen.getByTestId('activity-bar-button-notes');
      expect(filesTab.querySelector('svg.lucide-files')).not.toBeNull();
      expect(notesTab.querySelector('svg.lucide-sticky-note')).not.toBeNull();
      expect(notesTab.querySelector('svg.lucide-files')).toBeNull();
      expect(iconClassOf(filesTab)).not.toBe(iconClassOf(notesTab));
    });

    it('draws a distinct icon on every rendered tab', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const classes = screen.getAllByRole('tab').map(iconClassOf);
      expect(classes).toHaveLength(10);
      for (const c of classes) expect(c).not.toBe('');
      expect(new Set(classes).size).toBe(classes.length);
    });
  });

  describe('Tooltip integration (Issue #730)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows a custom Tooltip with the activity label after hover delay', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const tab = screen.getByTestId('activity-bar-button-git');
      // Hover over the button (mouseenter bubbles up to the wrapper span)
      fireEvent.mouseEnter(tab);
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
      });
      const tooltip = screen.getByRole('tooltip', { hidden: true });
      expect(tooltip).toHaveAttribute('aria-hidden', 'true');
      expect(tooltip).toHaveTextContent(/git/i);
    });

    // Issue #1341: portalling the shared Tooltip must not regress the
    // ActivityBar, whose tooltips open to the `right` of the leftmost column
    // and were never clipped. The bubble now lives on document.body, but the
    // placement and the #730 a11y contract are unchanged.
    it('keeps placement="right" and the a11y contract after portalling', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const tab = screen.getByTestId('activity-bar-button-git');
      fireEvent.mouseEnter(tab);
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
      });
      const tooltip = screen.getByRole('tooltip', { hidden: true });
      expect(tooltip).toHaveAttribute('data-placement', 'right');
      expect(tooltip.parentElement).toBe(document.body);
      // The button keeps its own aria-label and gains no aria-describedby, so
      // screen readers announce the label exactly once.
      expect(tab).toHaveAttribute('aria-label');
      expect(tab).not.toHaveAttribute('aria-describedby');
    });
  });

  describe('Settings menu (Issue #2645)', () => {
    beforeAll(() => installRadixJsdomPolyfills());
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('renders the settings gear button outside tablist at the bottom', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const button = screen.getByTestId('activity-bar-settings');
      expect(button).toHaveAttribute('aria-label', 'Settings');
      expect(button).toHaveAttribute('aria-haspopup', 'menu');
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(button.querySelector('svg.lucide-settings')).not.toBeNull();

      expect(button).not.toHaveAttribute('role', 'tab');
      const tablist = screen.getByRole('tablist');
      expect(tablist).not.toContainElement(button);
      expect(screen.getAllByRole('tab')).toHaveLength(10);

      expect(tablist.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

      const mtAuto = button.closest('.mt-auto');
      expect(mtAuto).not.toBeNull();
      const activityBar = screen.getByTestId('activity-bar');
      expect(activityBar.lastElementChild).toBe(mtAuto);
    });

    it('opens the dropdown menu with items, radios, and default checked states', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const button = screen.getByTestId('activity-bar-settings');
      fireEvent.keyDown(button, { key: 'Enter' });

      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(button).toHaveAttribute('aria-expanded', 'true');

      const menuitems = screen.getAllByRole('menuitem').map((el) => el.textContent);
      expect(menuitems).toEqual(['Settings', 'Skills', 'GitHub']);

      const radios = screen.getAllByRole('menuitemradio').map((el) => el.textContent);
      expect(radios).toEqual(['Light', 'Dark', 'System', 'English', '日本語']);

      expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute('data-state', 'checked');
      expect(screen.getByRole('menuitemradio', { name: 'Light' })).toHaveAttribute('data-state', 'unchecked');
      expect(screen.getByRole('menuitemradio', { name: 'English' })).toHaveAttribute('data-state', 'checked');
    });

    it('marks System as checked when theme is undefined', () => {
      themeMock.theme = undefined;
      render(<ActivityBar active="files" onToggle={() => {}} />);
      fireEvent.keyDown(screen.getByTestId('activity-bar-settings'), { key: 'Enter' });

      expect(screen.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute('data-state', 'checked');
    });

    it('displays the app version when NEXT_PUBLIC_APP_VERSION is set', () => {
      vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '9.9.9');
      render(<ActivityBar active="files" onToggle={() => {}} />);
      fireEvent.keyDown(screen.getByTestId('activity-bar-settings'), { key: 'Enter' });

      expect(screen.getByTestId('activity-bar-settings-version')).toHaveTextContent('CommandMate v9.9.9');
    });

    it('handles navigation, theme change, locale change, and external link without triggering onToggle or toggleSidebar', () => {
      const onToggle = vi.fn();
      render(<ActivityBar active="files" onToggle={onToggle} />);
      const button = screen.getByTestId('activity-bar-settings');
      const openMenu = () => {
        fireEvent.keyDown(button, { key: 'Enter' });
      };

      // Settings
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
      expect(routerMock.push).toHaveBeenCalledWith('/more');

      // Skills
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Skills' }));
      expect(routerMock.push).toHaveBeenCalledWith('/skills');

      // Light & System
      openMenu();
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Light' }));
      expect(themeMock.setTheme).toHaveBeenCalledWith('light');

      openMenu();
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'System' }));
      expect(themeMock.setTheme).toHaveBeenCalledWith('system');

      // 日本語
      openMenu();
      fireEvent.click(screen.getByRole('menuitemradio', { name: '日本語' }));
      expect(localeMock.switchLocale).toHaveBeenCalledWith('ja');

      // GitHub
      openMenu();
      const githubItem = screen.getByRole('menuitem', { name: 'GitHub' });
      expect(githubItem.tagName).toBe('A');
      expect(githubItem).toHaveAttribute('href', 'https://github.com/kewton/MyCodeBranchDesk');
      expect(githubItem).toHaveAttribute('target', '_blank');
      expect(githubItem).toHaveAttribute('rel', 'noopener noreferrer');

      // Neither onToggle nor sidebarMock.toggle should have been called
      expect(onToggle).not.toHaveBeenCalled();
      expect(sidebarMock.toggle).not.toHaveBeenCalled();
    });

    it('does not show Logout item when AuthProvider is not present', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      fireEvent.keyDown(screen.getByTestId('activity-bar-settings'), { key: 'Enter' });
      expect(screen.queryByRole('menuitem', { name: 'Logout' })).toBeNull();
    });

    it('shows Logout item when authEnabled is true and logs out on click', async () => {
      const originalLocation = window.location;
      const hrefSetter = vi.fn();
      const locationObj = { ...originalLocation };
      Object.defineProperty(locationObj, 'href', {
        get: () => 'http://localhost/',
        set: (val: string) => {
          hrefSetter(val);
        },
        configurable: true,
      });
      Object.defineProperty(window, 'location', {
        writable: true,
        configurable: true,
        value: locationObj,
      });

      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      global.fetch = fetchMock as unknown as typeof fetch;

      try {
        render(
          <AuthProvider authEnabled>
            <ActivityBar active="files" onToggle={() => {}} />
          </AuthProvider>
        );
        fireEvent.keyDown(screen.getByTestId('activity-bar-settings'), { key: 'Enter' });
        const logoutItem = screen.getByRole('menuitem', { name: 'Logout' });
        expect(logoutItem).toBeInTheDocument();

        fireEvent.click(logoutItem);

        expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
        await waitFor(() => {
          expect(hrefSetter).toHaveBeenCalledWith('/login');
        });
      } finally {
        Object.defineProperty(window, 'location', {
          writable: true,
          configurable: true,
          value: originalLocation,
        });
      }
    });

    it('still navigates to /login even if logout fetch rejects', async () => {
      const originalLocation = window.location;
      const hrefSetter = vi.fn();
      const locationObj = { ...originalLocation };
      Object.defineProperty(locationObj, 'href', {
        get: () => 'http://localhost/',
        set: (val: string) => {
          hrefSetter(val);
        },
        configurable: true,
      });
      Object.defineProperty(window, 'location', {
        writable: true,
        configurable: true,
        value: locationObj,
      });

      const fetchMock = vi.fn().mockRejectedValue(new Error('Network failure'));
      global.fetch = fetchMock as unknown as typeof fetch;

      try {
        render(
          <AuthProvider authEnabled>
            <ActivityBar active="files" onToggle={() => {}} />
          </AuthProvider>
        );
        fireEvent.keyDown(screen.getByTestId('activity-bar-settings'), { key: 'Enter' });
        const logoutItem = screen.getByRole('menuitem', { name: 'Logout' });

        fireEvent.click(logoutItem);

        expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
        await waitFor(() => {
          expect(hrefSetter).toHaveBeenCalledWith('/login');
        });
      } finally {
        Object.defineProperty(window, 'location', {
          writable: true,
          configurable: true,
          value: originalLocation,
        });
      }
    });
  });
});
