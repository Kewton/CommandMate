/**
 * Mod+B opens / closes the PC sidebar (Issue #3512).
 *
 * Mounted by AppShell's desktop branch only; the phone keeps its drawer (#3515).
 * Stands down when something earlier claimed the key (`defaultPrevented`),
 * while the command palette or another modal is open, and in text entry / the terminal pane
 * (`isSidebarShortcutBlockedTarget`), where Ctrl+B belongs to the editor or tmux.
 *
 * @module components/layout/useSidebarToggleShortcut
 */

'use client';

import { useEffect, useRef } from 'react';
import { useCommandPalette } from '@/contexts/CommandPaletteContext';
import { isAnyModalOpen } from '@/lib/new-task/modal-open';
import { isSidebarShortcutBlockedTarget, isToggleSidebarChord } from '@/lib/sidebar-utils';

export function useSidebarToggleShortcut(enabled: boolean, toggle: () => void): void {
  const { open: paletteOpen } = useCommandPalette();

  // Read by the listener so it is not re-added on every palette / toggle change.
  const paletteOpenRef = useRef(paletteOpen);
  const toggleRef = useRef(toggle);
  useEffect(() => {
    paletteOpenRef.current = paletteOpen;
    toggleRef.current = toggle;
  }, [paletteOpen, toggle]);

  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (!isToggleSidebarChord(event)) return;
      if (paletteOpenRef.current || isAnyModalOpen()) return;
      if (isSidebarShortcutBlockedTarget(event.target)) return;
      event.preventDefault();
      toggleRef.current();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
