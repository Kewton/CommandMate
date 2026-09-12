'use client';

/**
 * SessionsViewModeSelector — the list / tile switch on `/sessions` (Issue #2509).
 *
 * A two-segment control rather than a `<select>` (which is what
 * `RepositoryTabBarModeSelector` uses for its three-way preference): with two
 * mutually exclusive values both can be on screen at once, and it sits in a row
 * that is already a strip of square icon buttons — the sort-direction toggle
 * next to it is the same 36px box.
 *
 * `aria-pressed` rather than a radiogroup, for the same reason the sort-direction
 * control is a button: these are toggles that take effect immediately, not a
 * choice that is submitted.
 *
 * The preference itself — where it is stored, what a corrupted value resolves to
 * — belongs to {@link useSessionsViewMode}; this component only renders it.
 *
 * @module components/sessions/SessionsViewModeSelector
 */

import { memo } from 'react';
import { LayoutGrid, List } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SESSIONS_VIEW_MODES, type SessionsViewMode } from '@/hooks/useSessionsViewMode';

/**
 * The segments, in render order.
 *
 * `labelKey` rather than a label: this is module scope, where `t()` cannot be
 * called, and a literal here would pin the control to English (Issue #1271).
 */
const VIEW_MODE_SEGMENTS: ReadonlyArray<{
  mode: SessionsViewMode;
  labelKey: string;
  icon: typeof List;
}> = [
  { mode: 'list', labelKey: 'sessions.viewMode.list', icon: List },
  { mode: 'tile', labelKey: 'sessions.viewMode.tile', icon: LayoutGrid },
];

export interface SessionsViewModeSelectorProps {
  value: SessionsViewMode;
  onChange: (mode: SessionsViewMode) => void;
}

export const SessionsViewModeSelector = memo(function SessionsViewModeSelector({
  value,
  onChange,
}: SessionsViewModeSelectorProps) {
  const t = useTranslations('common');

  return (
    <div
      className="flex shrink-0 items-center gap-1 rounded-md border border-input bg-surface p-0.5"
      role="group"
      aria-label={t('sessions.viewMode.groupAriaLabel')}
      data-testid="sessions-view-mode"
    >
      {VIEW_MODE_SEGMENTS.map(({ mode, labelKey, icon: Icon }) => {
        const isActive = value === mode;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            aria-pressed={isActive}
            aria-label={t(labelKey)}
            title={t(labelKey)}
            data-testid={`sessions-view-mode-${mode}`}
            className={`rounded p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isActive
                ? 'bg-accent-100 text-accent-700 dark:bg-accent-900/30 dark:text-accent-400'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon size={16} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
});

export default SessionsViewModeSelector;

// Re-exported so a caller that renders the control does not also have to reach
// into the hook module for the value type it hands back.
export { SESSIONS_VIEW_MODES };
