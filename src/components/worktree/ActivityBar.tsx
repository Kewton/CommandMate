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
 *
 * Issue #2709:
 *   - 歯車メニューの「設定」は `/more` へ遷移せず設定モーダルを開く。開くのは
 *     `onCloseAutoFocus` の `queueMicrotask` で、Radix がフォーカスを歯車へ戻した後。
 *
 * Issue #3510:
 *   - 歯車メニューの中身は共通の `SettingsMenu`（サイドバー下部と同じ部品）。
 *
 * Issue #3512:
 *   - The #747 sidebar toggle is gone from the top of the bar. The sidebar's
 *     open/close button now sits at the top-left of the sidebar itself and, when
 *     it is closed, at the top of the app-wide icon rail (`SidebarRail`), which
 *     stands to the left of this bar. Roles: the rail (56px) moves between
 *     screens; this bar (48px) moves between the panes of one worktree.
 */

'use client';

import React, { memo, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Settings } from 'lucide-react';
import { ACTIVITIES, type ActivityId } from '@/config/activity-bar-config';
import { Tooltip } from '@/components/common/Tooltip';
import { SettingsMenu, SettingsMenuTrigger } from '@/components/layout/SettingsMenu';

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

/**
 * Issue #2645: the settings menu at the bottom of the ActivityBar.
 *
 * Outside the tablist: it is not an activity, so it must not join the roving-tabindex navigation or the
 * tab count.
 *
 * Issue #3510: the menu itself is the shared `SettingsMenu`, the same one the
 * sidebar footer opens; only the gear button is local to this file.
 */
function ActivityBarSettingsMenu() {
  const t = useTranslations('worktree');
  const label = t('activityBar.settings');

  return (
    <SettingsMenu testIdPrefix="activity-bar-settings" side="right" align="end">
      <Tooltip content={label} placement="right">
        <SettingsMenuTrigger asChild>
          <button
            type="button"
            data-testid="activity-bar-settings"
            aria-label={label}
            className="flex items-center justify-center h-12 w-12 text-muted-foreground transition-colors hover:text-surface-foreground hover:bg-muted-foreground/10 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-inset"
          >
            <Settings size={20} aria-hidden="true" />
          </button>
        </SettingsMenuTrigger>
      </Tooltip>
    </SettingsMenu>
  );
}

export const ActivityBar = memo(function ActivityBar({
  active,
  onToggle,
  className = '',
}: ActivityBarProps) {
  const t = useTranslations('worktree');
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
