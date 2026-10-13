/**
 * ContextMenu marks itself as an open floating layer (Issue #3589).
 *
 * The overlaid activity pane must not close on the press that dismisses the
 * file tree's context menu. The menu is `role="menu"` without Radix's
 * `data-state`, so `isAnyModalOpen()` (shared with New task) deliberately does
 * not count it; it says so through `data-floating-layer="open"` instead, which
 * `usePaneOverlayDismiss` reads via `OPEN_FLOATING_LAYER_SELECTOR`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContextMenu } from '@/components/worktree/ContextMenu';
import { OPEN_FLOATING_LAYER_SELECTOR } from '@/hooks/useActivityPaneOverlay';
import { isAnyModalOpen } from '@/lib/new-task/modal-open';

function menu(isOpen: boolean) {
  return (
    <ContextMenu
      isOpen={isOpen}
      position={{ x: 10, y: 10 }}
      targetPath="src/a.ts"
      targetType="file"
      onClose={vi.fn()}
      onRename={vi.fn()}
    />
  );
}

describe('ContextMenu — floating layer mark (Issue #3589)', () => {
  it('is an open floating layer while open', () => {
    render(menu(true));
    expect(screen.getByTestId('context-menu')).toHaveAttribute('data-floating-layer', 'open');
    expect(document.querySelector(OPEN_FLOATING_LAYER_SELECTOR)).toBe(screen.getByTestId('context-menu'));
  });

  it('is not one when closed (negative control)', () => {
    render(menu(false));
    expect(document.querySelector(OPEN_FLOATING_LAYER_SELECTOR)).toBeNull();
  });

  it('does not change what New task counts as a modal (modal-open is unchanged)', () => {
    render(menu(true));
    expect(isAnyModalOpen()).toBe(false);
  });
});
