'use client';

import { MessageSquare, TerminalSquare, Wrench } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { SurfaceMode } from '@/types/ui-state';

/**
 * Issue #2193: the two segments of the surface control, in render order. Same
 * shape (and same reason for holding i18n KEYS rather than labels) as
 * `SURFACE_MODE_SEGMENTS` in `TerminalSplitPane`; kept separate because the
 * phone's control is a full-width labelled segmented control while PC's is a
 * pair of icon buttons in a crowded header row.
 */
const MOBILE_SURFACE_SEGMENTS: readonly {
  mode: SurfaceMode;
  labelKey: string;
  icon: typeof TerminalSquare;
}[] = [
  { mode: 'terminal', labelKey: 'surfaceMode.terminal', icon: TerminalSquare },
  { mode: 'chat', labelKey: 'surfaceMode.chat', icon: MessageSquare },
] as const;

export interface MobileSurfaceModeToggleProps {
  surfaceMode: SurfaceMode;
  showSessionRow: boolean;
  directInputOpen: boolean;
  onSurfaceToggle: (mode: SurfaceMode) => void;
  showToolActivity: boolean;
  onToggleToolActivity: () => void;
}

export function MobileSurfaceModeToggle({
  surfaceMode,
  showSessionRow,
  directInputOpen,
  onSurfaceToggle,
  showToolActivity,
  onToggleToolActivity,
}: MobileSurfaceModeToggleProps) {
  const t = useTranslations('worktree');
  return (
    <div
      role="group"
      aria-label={t('surfaceMode.groupLabelMobile')}
      data-testid="mobile-surface-mode-toggle"
      // Issue #2357: `top-9` (36px = the 28px session row + the 8px gap the
      // pill already keeps) while the row is showing, so the pill sits over
      // the output as before rather than over the row.
      className={`pointer-events-none absolute right-2 z-30 flex items-center gap-0.5 rounded-full border border-border bg-surface-2/95 p-0.5 shadow-lg backdrop-blur ${
        showSessionRow ? 'top-9' : 'top-2'
      }`}
    >
      {MOBILE_SURFACE_SEGMENTS.map(({ mode, labelKey, icon: Icon }) => {
        const active = surfaceMode === mode;
        const label = t(labelKey);
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onSurfaceToggle(mode)}
            aria-pressed={active}
            aria-label={label}
            aria-disabled={directInputOpen ? true : undefined}
            title={label}
            data-testid={`mobile-surface-mode-${mode}`}
            className={`pointer-events-auto flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full transition-colors touch-manipulation ${
              active
                ? 'bg-accent-500/20 text-accent-600 dark:text-accent-400'
                : 'text-muted-foreground'
            } ${directInputOpen ? 'opacity-40' : ''}`}
          >
            <Icon size={18} aria-hidden="true" />
          </button>
        );
      })}
      {/* Issue #2821: the tool-activity toggle, on the chat surface only (the
          terminal has nothing to fold). The transcript's own copy sits under
          this pill, so it is withdrawn there (`hideCornerControls`) and drawn
          here instead. The rule keeps it visibly apart from the two surface
          segments, whose "selected" tint is close to its "on" tint. Not
          subject to `directInputOpen`: direct input only opens on the
          terminal surface, where this button is not drawn. */}
      {surfaceMode === 'chat' ? (
        <>
          <span aria-hidden="true" className="mx-0.5 h-6 w-px bg-border" />
          <button
            type="button"
            onClick={onToggleToolActivity}
            aria-pressed={showToolActivity}
            aria-label={
              showToolActivity
                ? t('chatTranscript.toolActivity.hide')
                : t('chatTranscript.toolActivity.show')
            }
            title={
              showToolActivity
                ? t('chatTranscript.toolActivity.hide')
                : t('chatTranscript.toolActivity.show')
            }
            data-testid="mobile-chat-tool-activity-toggle"
            className={`pointer-events-auto flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full transition-colors touch-manipulation ${
              showToolActivity
                ? 'bg-accent-500/15 text-accent-700 dark:text-accent-400'
                : 'text-muted-foreground'
            }`}
          >
            <Wrench size={18} aria-hidden="true" />
          </button>
        </>
      ) : null}
    </div>
  );
}
