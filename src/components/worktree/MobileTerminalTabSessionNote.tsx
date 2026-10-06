'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  SESSION_NOTE_OPEN_EVENT,
  SessionNoteInput,
  useSessionNote,
  type SessionNoteValue,
} from '@/components/worktree/TerminalSplitPane';

/** The session note value and its editor open/close state (Issue #2427). */
export function useMobileSessionNoteEditor(
  worktreeId: string,
  resolvedInstanceId: string
): {
  sessionNote: SessionNoteValue | null;
  noteEditing: boolean;
  openNoteEditor: () => void;
  closeNoteEditor: () => void;
  commitNote: (text: string) => void;
} {
  const { note: sessionNote, save: saveSessionNote } = useSessionNote(
    worktreeId,
    resolvedInstanceId
  );
  const [noteEditing, setNoteEditing] = useState(false);
  useEffect(() => {
    const open = () => setNoteEditing(true);
    window.addEventListener(SESSION_NOTE_OPEN_EVENT, open);
    return () => window.removeEventListener(SESSION_NOTE_OPEN_EVENT, open);
  }, []);
  // A different session is a different memo.
  useEffect(() => {
    setNoteEditing(false);
  }, [worktreeId, resolvedInstanceId]);
  const openNoteEditor = useCallback(() => setNoteEditing(true), []);
  const closeNoteEditor = useCallback(() => setNoteEditing(false), []);
  const commitNote = useCallback(
    (text: string) => {
      saveSessionNote(text);
      setNoteEditing(false);
    },
    [saveSessionNote]
  );
  return { sessionNote, noteEditing, openNoteEditor, closeNoteEditor, commitNote };
}

/**
 * Issue #2427: the note editor, overlaid rather than in the flex flow —
 * the same #2106 budget the surface pill obeys. It is anchored under the
 * session row when there is one and at the tab's top edge when there is
 * not, so it never covers the row it is editing.
 */
export function MobileSessionNoteEditor({
  showSessionRow,
  sessionNote,
  onCommit,
  onCancel,
}: {
  showSessionRow: boolean;
  sessionNote: SessionNoteValue | null;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('worktree');
  return (
    <div
      data-testid="mobile-session-note-editor"
      className={`absolute inset-x-2 z-40 rounded-md border border-border bg-surface p-2 shadow-lg ${
        showSessionRow ? 'top-9' : 'top-2'
      }`}
    >
      <SessionNoteInput
        initialText={sessionNote?.text ?? ''}
        onCommit={onCommit}
        onCancel={onCancel}
        ariaLabel={t('sessionNote.menuItem')}
        placeholder={t('sessionNote.placeholder')}
        testId="mobile-session-note-input"
      />
      <p className="mt-1 text-[10px] leading-tight text-muted-foreground">
        {t('sessionNote.hint')}
      </p>
    </div>
  );
}
