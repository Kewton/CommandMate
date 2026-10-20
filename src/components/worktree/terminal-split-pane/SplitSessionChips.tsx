/**
 * The chips after the instance selector in a split's header: output-surface control,
 * model, usage, session note (Issue #3592).
 */

'use client';

import React from 'react';
import { MessageSquare, StickyNote, TerminalSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { SurfaceMode } from '@/types/ui-state';
import { Tooltip } from '@/components/common/Tooltip';

/**
 * Issue #2193: the two segments of the output-surface control, in render order.
 *
 * Declared at module scope with i18n KEYS rather than resolved labels, for the
 * reason `ACTIVITIES` in `activity-bar-config.ts` gives: `t()` cannot be called
 * outside a component, so the label is resolved at render time. A third entry
 * (`xterm`) is expected here eventually — nothing in this file switches
 * exhaustively on {@link SurfaceMode}, so adding one is a one-line change.
 */
const SURFACE_MODE_SEGMENTS: readonly {
  mode: SurfaceMode;
  labelKey: string;
  /** Issue #3514: the visible word on the segment ("Terminal" / "Chat"). */
  textKey: string;
  icon: typeof TerminalSquare;
}[] = [
  { mode: 'terminal', labelKey: 'surfaceMode.showTerminal', textKey: 'surfaceMode.terminal', icon: TerminalSquare },
  { mode: 'chat', labelKey: 'surfaceMode.showChat', textKey: 'surfaceMode.chat', icon: MessageSquare },
] as const;

export interface SplitSessionChipsProps {
  splitIndex: number;
  splitLabel: string;
  inActionBar: boolean;
  surfaceMode: SurfaceMode;
  onSurfaceModeChange?: (mode: SurfaceMode) => void;
  agentModel?: string | null;
  agentUsage?: string | null;
  agentUsageDetail?: string | null;
  sessionNote: { text: string } | null | undefined;
  noteStamp: string;
  noteLabel: string;
  noteEditLabel: string;
  openNoteEditor: () => void;
}

export function SplitSessionChips({
  splitIndex,
  splitLabel,
  inActionBar,
  surfaceMode,
  onSurfaceModeChange,
  agentModel,
  agentUsage,
  agentUsageDetail,
  sessionNote,
  noteStamp,
  noteLabel,
  noteEditLabel,
  openNoteEditor,
}: SplitSessionChipsProps): React.ReactElement {
  const t = useTranslations('worktree');
  return (
    <>
      {/* Issue #2193: the output-surface control, directly beside the session
          title so it reads as "what this session is showing" rather than a
          global view switch -- each split owns its own mode. Rendered only
          when the parent wired `onSurfaceModeChange`.

          Always visible (never hover-revealed): a hover-only affordance is
          invisible on a touch screen, and this is the only way back from the
          chat surface. Both segments stay mounted so the control's width does
          not change when the mode does. */}
      {onSurfaceModeChange ? (
        <div
          role="group"
          aria-label={t('surfaceMode.groupLabel', { split: splitLabel })}
          data-testid={`surface-mode-toggle-${splitIndex}`}
          className="flex flex-shrink-0 items-center gap-0.5 rounded border border-border bg-surface p-0.5"
        >
          {SURFACE_MODE_SEGMENTS.map(({ mode, labelKey, textKey, icon: Icon }) => {
            const active = surfaceMode === mode;
            const label = t(labelKey);
            return (
              <Tooltip key={mode} content={label} placement="bottom">
                <button
                  type="button"
                  onClick={() => onSurfaceModeChange(mode)}
                  aria-pressed={active}
                  aria-label={label}
                  data-testid={`surface-mode-${mode}-${splitIndex}`}
                  className={`flex items-center justify-center rounded px-1.5 py-0.5 touch-manipulation transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    active
                      ? 'bg-accent-500/15 text-accent-600 dark:text-accent-400'
                      : 'text-muted-foreground hover:bg-muted hover:text-surface-foreground'
                  }`}
                >
                  <Icon size={14} aria-hidden="true" />
                  {/* Issue #3514: a word beside the icon, so the two surfaces
                      are told apart without hovering. */}
                  <span className="ml-1 text-[11px] leading-none">{t(textKey)}</span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      ) : null}

      {/* Issue #1783: the model the agent itself reported, as muted small
          text after the alias. A sibling of the selector rather than a child
          of its trigger: the trigger is already `max-w-[12rem]` with a
          truncated alias and a chevron, and folding a second string into it
          would eat the alias to make room for the model. Rendered only when a
          model is actually known — see `agentModel`. `truncate` + `title` keep
          a long id from pushing the search button off the row. */}
      {/* Issue #2427: the model is also the label that gives way. When a note
          is present its cap drops from 10rem to 5rem and it shrinks four times
          as fast as the note, so a narrow split spends its width on what the
          operator wrote — which changes with every instruction — rather than
          on a model id that is fixed for the session and readable in the
          tooltip either way. */}
      {agentModel && (
        <span
          data-testid={`split-agent-model-${splitIndex}`}
          title={t('agentModel.modelLabel', { model: agentModel })}
          className={`min-w-0 truncate text-[11px] leading-none text-muted-foreground ${
            sessionNote ? 'max-w-[5rem] shrink-[4]' : 'max-w-[10rem]'
          }`}
        >
          {agentModel}
        </span>
      )}

      {/* Issue #2042: cost / context, as a sibling chip of the model rather
          than an extension of it. Two strings, because they answer different
          questions and go stale at different rates — the model is fixed for
          the session while these move every turn — and because a reader
          comparing this row against the agent's own footer is comparing the
          second half only. `tabular-nums` so a changing count does not jitter
          the row; `truncate` + `title` keep a long detail off the layout. */}
      {agentUsage && (
        <span
          data-testid={`split-agent-usage-${splitIndex}`}
          title={agentUsageDetail ?? t('agentSession.chipLabel', { usage: agentUsage })}
          className="min-w-0 max-w-[10rem] truncate text-[11px] leading-none tabular-nums text-muted-foreground"
        >
          {agentUsage}
        </span>
      )}

      {/* Issue #2427: the memo, as a sibling of the model and usage chips and
          under the same rule — rendered ONLY when there is one, so an empty
          note leaves the header exactly as it was before this Issue. It is a
          button because clicking it is how the note is edited; `truncate` +
          `title` keep a 100-character memo from pushing the search button off
          the row, and `shrink` (1, against the model's 4) is what makes the
          model give way first. */}
      {sessionNote && (
        <button
          type="button"
          onClick={openNoteEditor}
          aria-label={noteEditLabel}
          title={noteLabel}
          data-testid={`split-session-note-${splitIndex}`}
          className="flex min-w-0 max-w-[16rem] shrink items-center gap-1 rounded px-1 py-0.5 text-[11px] leading-none text-muted-foreground hover:bg-muted-foreground/10 hover:text-surface-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <StickyNote size={11} aria-hidden="true" className="shrink-0 opacity-70" />
          <span className="min-w-0 truncate">{sessionNote.text}</span>
          <span
            data-testid={`split-session-note-time-${splitIndex}`}
            className="shrink-0 tabular-nums opacity-70"
          >
            {noteStamp}
          </span>
        </button>
      )}

      {/* Issue #3592: in the action bar an empty note still gets a small edit
          entry beside the selector — the bar has the room the 30px title bar
          did not, and the menu item alone is two presses deep. The title bar
          keeps the #2427 rule (an empty note adds nothing). */}
      {inActionBar && !sessionNote ? (
        <Tooltip content={t('sessionNote.menuItem')} placement="bottom" className="flex-shrink-0">
          <button
            type="button"
            onClick={openNoteEditor}
            aria-label={noteEditLabel}
            data-testid={`split-session-note-edit-${splitIndex}`}
            className="flex flex-shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:bg-muted-foreground/10 hover:text-surface-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <StickyNote size={12} aria-hidden="true" />
          </button>
        </Tooltip>
      ) : null}
    </>
  );
}
