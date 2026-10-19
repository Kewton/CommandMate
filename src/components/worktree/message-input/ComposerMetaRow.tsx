/**
 * The composer's meta row (Auto-Yes + keyboard hints), moved out of
 * MessageInput (Issue #3606).
 */

'use client';

import React, { type ReactNode } from 'react';
import { Kbd } from '@/components/ui/Kbd';

export interface ComposerMetaRowProps {
  autoYesSlot?: ReactNode;
  isMobile: boolean;
  commandsHint: string;
  newlineHint: string;
}

export function ComposerMetaRow({ autoYesSlot, isMobile, commandsHint, newlineHint }: ComposerMetaRowProps): React.ReactElement {
  return (
    <>
      {/* Issue #1080: composer meta row — Auto-Yes (left) + keyboard hints (right).
          Renders when Auto-Yes is embedded (mobile + desktop) or on desktop for
          the hint pills (mobile Enter inserts a newline, so no Shift+Enter hint). */}
      {/* Issue #2598: on a PC the row is its own `@container`, and the hints
          are drawn only where the composer is wide enough for them AND the
          Auto-Yes toggle. In a narrow split pane they used to wrap to a
          second line and, being `flex-shrink-0`, squeeze the toggle beside
          them to nothing. Keep the literal in sync with
          COMPOSER_HINTS_MIN_CONTAINER_PX. */}
      {(autoYesSlot || !isMobile) && (
        <div
          className={`${isMobile ? '' : '@container '}flex items-center justify-between gap-2 min-w-0`}
          data-testid="composer-meta-row"
        >
          {/* PC: `whitespace-nowrap` — a narrow pane scrolls the Auto-Yes
              label (and its countdown) sideways instead of wrapping it onto a
              second line of meta row. */}
          <div
            className={`flex items-center gap-2 min-w-0 overflow-x-auto scrollbar-hide${isMobile ? '' : ' whitespace-nowrap'}`}
            data-testid="composer-auto-yes"
          >
            {autoYesSlot}
          </div>
          {!isMobile && (
            <div
              className="hidden @min-[420px]:flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground select-none"
              data-testid="composer-hints"
            >
              <Kbd>/</Kbd>
              <span>{commandsHint}</span>
              <span aria-hidden="true" className="opacity-50">·</span>
              <Kbd>⇧</Kbd>
              <Kbd>↵</Kbd>
              <span>{newlineHint}</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
