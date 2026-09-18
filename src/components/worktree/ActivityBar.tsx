/**
 * ActivityBar Component (Issue #727, updated by Issue #730)
 *
 * VS Code-style vertical 48px Activity Bar. Hosts 7 activity icons.
 *
 * Behavior:
 *   - Clicking an inactive icon switches to that activity.
 *   - Re-clicking the active icon toggles the ActivityPane closed.
 *   - Keyboard: Tab focuses each tab; ArrowUp/ArrowDown move focus within
 *     the tablist; Enter/Space activate the focused tab.
 *
 * Accessibility:
 *   - role="tablist" + aria-orientation="vertical"
 *   - Each button: role="tab", aria-selected, aria-label, aria-controls
 *   - id="worktree-activity-bar"
 *
 * Issue #730:
 *   - The native `title` attribute is replaced with a custom `Tooltip`
 *     component so styling matches the dark UI and shows after a 100ms
 *     hover delay. `aria-label` is kept as the primary accessible name and
 *     the Tooltip is `aria-hidden="true"` to avoid duplicate announcements.
 *   - The Tooltip wraps each button in a `<span tabindex="-1">`, so the
 *     internal `buttonRefs` still point at the actual `<button>` and the
 *     ArrowUp/ArrowDown/Home/End keyboard navigation keeps working.
 *
 * Issue #747:
 *   - The sidebar (Branches list) open/close toggle (hamburger) now lives at
 *     the TOP of the ActivityBar, replacing the one that used to sit in the
 *     DesktopHeader. It reads/controls the sidebar via `useSidebarContext()`.
 *   - The toggle is rendered OUTSIDE the `role="tablist"` element so it is not
 *     part of the roving-tabindex Arrow/Home/End navigation and does not change
 *     the tab count or WAI-ARIA tablist semantics.
 *
 * Issue #2645:
 *   - The settings menu button (gear) lives at the BOTTOM of the ActivityBar
 *     (pinned via `mt-auto`). Rendered OUTSIDE the `role="tablist"` element.
 */

'use client';

import React, { memo, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { Menu, Settings } from 'lucide-react';
import { ACTIVITIES, type ActivityId } from '@/config/activity-bar-config';
import { Tooltip } from '@/components/common/Tooltip';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { useAuthEnabled } from '@/contexts/AuthContext';
import { useLocaleSwitch } from '@/hooks/useLocaleSwitch';
import { useViewTransitionRouter } from '@/components/providers/ViewTransitionsProvider';
import { LOCALE_LABELS, SUPPORTED_LOCALES } from '@/config/i18n-config';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';

export interface ActivityBarProps {
  /** Currently active activity, or null when ActivityPane is closed. */
  active: ActivityId | null;
  /**
   * Called when the user wants to "toggle" an activity:
   * - If the clicked activity is already active → close (parent should pass null to its state).
   * - Else → set the clicked activity as active.
   * Implementations typically delegate to `useActivityBarState().toggle`.
   */
  onToggle: (activity: ActivityId) => void;
  /** Optional extra className for the root element. */
  className?: string;
}

const ACTIVITY_BAR_ID = 'worktree-activity-bar';
const ACTIVITY_PANE_ID = 'worktree-activity-pane';

const GITHUB_URL = 'https://github.com/kewton/MyCodeBranchDesk';

/**
 * Issue #2645: the settings menu at the bottom of the ActivityBar.
 *
 * Outside the tablist for the same reason as the sidebar toggle (#747): it is
 * not an activity, so it must not join the roving-tabindex navigation or the
 * tab count. Local to this file on purpose.
 */
function ActivityBarSettingsMenu() {
  const t = useTranslations('worktree');
  const router = useViewTransitionRouter();
  const { theme, setTheme } = useTheme();
  const { currentLocale, switchLocale } = useLocaleSwitch();
  const authEnabled = useAuthEnabled();
  const label = t('activityBar.settings');
  // Read at render time (not module scope) so a test can stub it.
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION;

  // Same flow as LogoutButton: always land on /login, even if the call fails.
  const handleLogout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    } catch {
      window.location.href = '/login';
    }
  }, []);

  return (
    <DropdownMenu>
      <Tooltip content={label} placement="right">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="activity-bar-settings"
            aria-label={label}
            className="flex items-center justify-center h-12 w-12 text-muted-foreground transition-colors hover:text-surface-foreground hover:bg-muted-foreground/10 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-inset"
          >
            <Settings size={20} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent side="right" align="end" className="w-56">
        <DropdownMenuLabel data-testid="activity-bar-settings-version">
          {t('activityBar.settingsMenu.version', {
            version: appVersion ? `v${appVersion}` : '-',
          })}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => router.push('/more')}>
          {t('activityBar.settingsMenu.settings')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push('/skills')}>
          {t('activityBar.settingsMenu.skills')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('activityBar.settingsMenu.theme')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={(value) => setTheme(value)}>
          <DropdownMenuRadioItem value="light">{t('activityBar.settingsMenu.themeLight')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">{t('activityBar.settingsMenu.themeDark')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">{t('activityBar.settingsMenu.themeSystem')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuLabel>{t('activityBar.settingsMenu.language')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={currentLocale} onValueChange={(value) => switchLocale(value)}>
          {SUPPORTED_LOCALES.map((locale) => (
            <DropdownMenuRadioItem key={locale} value={locale}>
              {LOCALE_LABELS[locale]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            {t('activityBar.settingsMenu.github')}
          </a>
        </DropdownMenuItem>
        {authEnabled && (
          <DropdownMenuItem onSelect={() => { void handleLogout(); }}>
            {t('activityBar.settingsMenu.logout')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const ActivityBar = memo(function ActivityBar({
  active,
  onToggle,
  className = '',
}: ActivityBarProps) {
  const t = useTranslations('worktree');
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Issue #747: the Branches-sidebar toggle is hosted at the top of the
  // ActivityBar and drives the sidebar directly via SidebarContext.
  const { isOpen: isSidebarOpen, toggle: toggleSidebar } = useSidebarContext();

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, index: number, activity: ActivityId) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggle(activity);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = (index + 1) % ACTIVITIES.length;
        buttonRefs.current[next]?.focus();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = (index - 1 + ACTIVITIES.length) % ACTIVITIES.length;
        buttonRefs.current[prev]?.focus();
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        buttonRefs.current[0]?.focus();
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        buttonRefs.current[ACTIVITIES.length - 1]?.focus();
        return;
      }
    },
    [onToggle]
  );

  return (
    <div
      data-testid="activity-bar"
      className={`flex flex-col items-stretch w-12 flex-shrink-0 bg-muted border-r border-border ${className}`.trim()}
    >
      {/* Issue #747: Sidebar (Branches) toggle. Rendered OUTSIDE the tablist so
          it is excluded from the roving-tabindex Arrow/Home/End navigation and
          does not change the tab count or WAI-ARIA tablist semantics. */}
      <Tooltip content={t('activityBar.toggleSidebar')} placement="right">
        <button
          type="button"
          data-testid="activity-bar-toggle-sidebar"
          onClick={toggleSidebar}
          aria-label={t('activityBar.toggleSidebar')}
          aria-expanded={isSidebarOpen}
          className="flex items-center justify-center h-12 w-12 text-muted-foreground transition-colors hover:text-surface-foreground hover:bg-muted-foreground/10 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-inset"
        >
          <Menu size={20} aria-hidden="true" />
        </button>
      </Tooltip>
      {/* Separator between the sidebar toggle and the activity tabs */}
      <div
        className="mx-2 my-1 border-b border-border"
        aria-hidden="true"
      />
      <div
        id={ACTIVITY_BAR_ID}
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('activityBar.label')}
        className="flex flex-col items-stretch"
      >
        {ACTIVITIES.map((activity, index) => {
          const Icon = activity.icon;
          const isActive = active === activity.id;
          // Issue #1277: ACTIVITIES stores a translation key (t() cannot be
          // called at the module scope where the list is defined).
          const label = t(activity.labelKey);
          return (
            <Tooltip key={activity.id} content={label} placement="right">
              <button
                ref={(el) => {
                  buttonRefs.current[index] = el;
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={label}
                aria-controls={ACTIVITY_PANE_ID}
                tabIndex={isActive || (active === null && index === 0) ? 0 : -1}
                onClick={() => onToggle(activity.id)}
                onKeyDown={(e) => handleKeyDown(e, index, activity.id)}
                data-testid={`activity-bar-button-${activity.id}`}
                className="group flex items-center justify-center h-12 w-12 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-inset"
              >
                {/* Issue #1079: active state is a soft accent-tinted rounded pill
                    (bg-accent-500/10) instead of a full-cell bar + white fill. */}
                <span
                  aria-hidden="true"
                  className={`flex items-center justify-center h-9 w-9 rounded-md transition-colors ${
                    isActive
                      ? 'bg-accent-500/10 text-accent-600 dark:text-accent-400'
                      : 'text-muted-foreground group-hover:text-surface-foreground group-hover:bg-muted-foreground/10'
                  }`}
                >
                  <Icon size={20} aria-hidden="true" />
                </span>
              </button>
            </Tooltip>
          );
        })}
      </div>
      {/* Issue #2645: settings menu, pinned to the bottom of the bar. */}
      <div className="mt-auto">
        <ActivityBarSettingsMenu />
      </div>
    </div>
  );
});

export default ActivityBar;
