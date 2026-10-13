/**
 * SettingsMenu — the one settings popover (Issue #3510).
 *
 * The sidebar footer and the icon-rail gear (`SidebarRail`; the ActivityBar
 * gear until #3512) both open this menu, so the
 * entries that used to be spread over those two places and the global Header
 * live in one list: Settings… · Skills · theme · language · display size ·
 * repository-tab strip · GitHub · version · logout.
 *
 * Not here on purpose: `ConnectionStatusIndicator` and `AppUpdateButton`. Both
 * must stay visible without opening anything (where they go is #3512).
 *
 * Built on `ui/DropdownMenu` (Radix), which already gives what the Issue asks
 * for: Esc closes, focus returns to the trigger, arrow keys reach every item.
 *
 * "Settings…" keeps the #2709 split: the PC opens the settings modal, the
 * phone goes to `/more` (a two-column dialog has nowhere to go at 390px). It is
 * an `<a href="/more">`, so a modified / middle click opens /more in a new tab
 * as the old Header link did (#3512).
 *
 * @module components/layout/SettingsMenu
 */

'use client';

import React, { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useAuthEnabled } from '@/contexts/AuthContext';
import { useLocaleSwitch } from '@/hooks/useLocaleSwitch';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useViewTransitionRouter } from '@/components/providers/ViewTransitionsProvider';
import { useSettingsDialog } from '@/contexts/SettingsDialogContext';
import { useOptionalSidebarContext } from '@/contexts/SidebarContext';
import { usePcDisplaySizeContext } from '@/contexts/PcDisplaySizeContext';
import { PC_DISPLAY_SIZE_ORDER, isPcDisplaySize } from '@/hooks/usePcDisplaySize';
import { REPO_TAB_BAR_MODES, isValidRepoTabBarMode } from '@/lib/sidebar-utils';
import { LOCALE_LABELS, SUPPORTED_LOCALES } from '@/config/i18n-config';
import { logout } from '@/components/common/LogoutButton';
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

const GITHUB_URL = 'https://github.com/kewton/MyCodeBranchDesk';

/**
 * A click the browser should handle itself on a link: anything but a plain
 * primary-button click (⌘/Ctrl/Shift/Alt, middle button).
 */
function isModifiedClick(event: React.MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/** Wrap the host's button in this (with `asChild`) to make it the menu trigger. */
export const SettingsMenuTrigger = DropdownMenuTrigger;

export interface SettingsMenuProps {
  /** The trigger: a `<SettingsMenuTrigger asChild>` around the host's button. */
  children: React.ReactNode;
  /** Prefix for the test ids inside the menu (`<prefix>-version`). */
  testIdPrefix: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /**
   * Show the PC chrome preferences (display size, repository-tab strip).
   * They are hidden on the phone regardless, like their Header selectors.
   */
  showDisplayPreferences?: boolean;
  /** Called when an item navigates away (the sidebar closes its mobile drawer). */
  onNavigate?: () => void;
}

/**
 * Display size + repository-tab strip. A component of its own so the contexts
 * are read only where the section is shown.
 */
function DisplayPreferenceItems() {
  const t = useTranslations('common');
  const { size, setSize } = usePcDisplaySizeContext();
  // Optional for the same reason as RepositoryTabBarModeSelector: a preference
  // control must not be the reason a tree without the provider throws.
  const sidebar = useOptionalSidebarContext();

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t('displaySize.ariaLabel')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={size}
        onValueChange={(value) => {
          if (isPcDisplaySize(value)) setSize(value);
        }}
      >
        {PC_DISPLAY_SIZE_ORDER.map((option) => (
          <DropdownMenuRadioItem key={option} value={option}>
            {t(`displaySize.${option}`)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {sidebar && (
        <>
          <DropdownMenuLabel>{t('repoTabBar.settingLabel')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sidebar.repoTabBarMode}
            onValueChange={(value) => {
              if (isValidRepoTabBarMode(value)) sidebar.setRepoTabBarMode(value);
            }}
          >
            {REPO_TAB_BAR_MODES.map((mode) => (
              <DropdownMenuRadioItem key={mode} value={mode}>
                {t(`repoTabBar.mode.${mode}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </>
      )}
    </>
  );
}

/**
 * The shared settings menu.
 *
 * @example
 * ```tsx
 * <SettingsMenu testIdPrefix="sidebar-rail-settings" side="right" align="end">
 *   <SettingsMenuTrigger asChild><button aria-label="Settings">…</button></SettingsMenuTrigger>
 * </SettingsMenu>
 * ```
 */
export function SettingsMenu({
  children,
  testIdPrefix,
  side = 'top',
  align = 'end',
  showDisplayPreferences = false,
  onNavigate,
}: SettingsMenuProps) {
  // The wording predates this menu (the ActivityBar gear, #2645) and is pinned by the
  // worktree key test, so it stays under `worktree.activityBar.settingsMenu`.
  const t = useTranslations('worktree');
  const router = useViewTransitionRouter();
  const { theme, setTheme } = useTheme();
  const { currentLocale, switchLocale } = useLocaleSwitch();
  const authEnabled = useAuthEnabled();
  const isMobile = useIsMobile();
  const { open: openSettings } = useSettingsDialog();
  // Issue #2709: raised by the Settings item, read once the menu has closed.
  // The modal must open AFTER Radix has restored focus to the trigger, not
  // instead of it: the modal's focus trap records whatever is focused at open
  // time as the element to return to when it closes. Suppressing Radix's
  // restore would leave that as <body> and lose the way back.
  const openSettingsAfterClose = useRef(false);
  // Issue #3512: the click on "Settings…" being handled, read by the onSelect
  // Radix calls from inside that same click.
  const settingsClick = useRef<React.MouseEvent<HTMLAnchorElement> | null>(null);
  // Read at render time (not module scope) so a test can stub it.
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION;

  const navigate = (href: string) => {
    onNavigate?.();
    router.push(href);
  };

  return (
    <DropdownMenu>
      {children}
      <DropdownMenuContent
        side={side}
        align={align}
        collisionPadding={8}
        // The caps are what let Radix keep the menu on screen at 390px: the
        // list is taller than a phone's free space above the footer.
        className="w-56 max-w-[calc(100vw-16px)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
        onCloseAutoFocus={() => {
          if (!openSettingsAfterClose.current) return;
          openSettingsAfterClose.current = false;
          // Radix's own onCloseAutoFocus handler (which focuses the trigger)
          // runs right after this one in the same task — composeEventHandlers
          // would skip it entirely if we called preventDefault() here. The
          // microtask therefore lands after the trigger has focus, which is
          // what the modal's focus trap records as the element to return to.
          queueMicrotask(openSettings);
        }}
      >
        <DropdownMenuLabel data-testid={`${testIdPrefix}-version`}>
          {t('activityBar.settingsMenu.version', {
            version: appVersion ? `v${appVersion}` : '-',
          })}
        </DropdownMenuLabel>
        {/* Issue #3512: a real link to /more, like the old Header entry (#2709).
            A ⌘/Ctrl/Shift/Alt or non-primary click is left to the browser (new
            tab / window) and selects nothing. A plain click (Enter is turned
            into one by Radix) runs onSelect, which stops the browser's own
            navigation there: preventing it in the link's onClick would also
            make Radix skip its select handler, and the menu would stay open. */}
        <DropdownMenuItem
          asChild
          onSelect={() => {
            const click = settingsClick.current;
            settingsClick.current = null;
            if (click && isModifiedClick(click)) return;
            click?.preventDefault();
            if (isMobile) {
              navigate('/more');
              return;
            }
            openSettingsAfterClose.current = true;
          }}
        >
          <a
            href="/more"
            data-testid={`${testIdPrefix}-settings`}
            onClick={(event) => {
              settingsClick.current = event;
            }}
          >
            {t('activityBar.settingsMenu.settings')}
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/skills')}>
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
        {showDisplayPreferences && !isMobile && <DisplayPreferenceItems />}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            {t('activityBar.settingsMenu.github')}
          </a>
        </DropdownMenuItem>
        {authEnabled && (
          <DropdownMenuItem onSelect={() => { void logout(); }}>
            {t('activityBar.settingsMenu.logout')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default SettingsMenu;
