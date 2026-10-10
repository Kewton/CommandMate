/**
 * NewTaskDialogHost (Issue #3511)
 *
 * Mounted once by AppShell, next to the command palette. Owns the global
 * Mod+Shift+O listener and mounts the dialog only while it is open: the dialog
 * reads the router and fetches the branch list, and neither should happen on
 * every screen for a dialog nobody opened.
 *
 * Unlike `?`, the chord also works while typing — it produces no character,
 * and "New task" from inside a composer is exactly the ChatGPT gesture this
 * copies. It stands down when something earlier already claimed the key
 * (`defaultPrevented`, e.g. the direct-input keyboard) and while the command
 * palette is open, so the two never stack.
 */

'use client';

import React, { useEffect, useRef } from 'react';
import { useNewTask } from '@/contexts/NewTaskContext';
import { useCommandPalette } from '@/contexts/CommandPaletteContext';
import { isOpenNewTaskChord } from '@/lib/new-task/new-task-shortcut';
import { NewTaskDialog } from './NewTaskDialog';

export function NewTaskDialogHost() {
  const { isOpen, openNewTask } = useNewTask();
  const { open: paletteOpen } = useCommandPalette();

  const paletteOpenRef = useRef(paletteOpen);
  useEffect(() => {
    paletteOpenRef.current = paletteOpen;
  }, [paletteOpen]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (!isOpenNewTaskChord(event)) return;
      if (paletteOpenRef.current) return;
      event.preventDefault();
      openNewTask();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openNewTask]);

  return isOpen ? <NewTaskDialog /> : null;
}

export default NewTaskDialogHost;
