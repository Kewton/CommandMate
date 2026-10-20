/**
 * The slot the lone split's session controls are portalled into (Issue #3592),
 * moved out of TerminalSplitContainer (Issue #3603).
 */

'use client';

import React from 'react';

export function ActionBarSessionSlot({
  slotRef,
  folded,
}: {
  slotRef: (el: HTMLDivElement | null) => void;
  folded: boolean;
}) {
  return (
    <div
      ref={slotRef}
      data-testid="split-action-bar-session"
      data-folded={folded ? 'true' : undefined}
      className={`flex min-w-0 items-center${folded ? ' max-w-full group/bar-session' : ' ml-1'}`}
    />
  );
}
