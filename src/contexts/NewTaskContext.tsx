/**
 * NewTaskContext (Issue #3511)
 *
 * Open/closed state of the one New task dialog, mounted by AppShell so every
 * screen under the shell — the lists and the worktree screen — shares it.
 * `openNewTask()` is the entry point any button can call (the sidebar / icon
 * rail buttons are Issue #3512's); Mod+Shift+O is the other
 * (`NewTaskDialogHost`).
 *
 * Two contexts rather than one: the worktree screen reports "the worktree and
 * agent I am showing" through a setter that never changes identity, so that
 * heavy screen does not re-render each time the dialog opens or closes.
 *
 * Shaped like SettingsDialogContext: non-throwing defaults, so a component (or
 * an isolated test) rendered without the provider simply gets a dialog that
 * never opens.
 */

'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { NewTaskTarget } from '@/lib/new-task/recent-targets';

export interface NewTaskContextValue {
  /** Whether the dialog is open. */
  isOpen: boolean;
  /** The destination `openNewTask(target)` asked for, or null. */
  requestedTarget: NewTaskTarget | null;
  /** The worktree and agent the current screen shows, or null on a list screen. */
  screenTarget: NewTaskTarget | null;
  /** Open the dialog, optionally on a given destination. No-op without a provider. */
  openNewTask: (target?: NewTaskTarget) => void;
  /** Close it. No-op without a provider. */
  closeNewTask: () => void;
}

/** Reports the screen's current destination; `null` when it goes away. */
export type SetNewTaskScreenTarget = (target: NewTaskTarget | null) => void;

const noop = (): void => {};

/** Value seen by consumers rendered without NewTaskProvider. */
export const NEW_TASK_DEFAULT_VALUE: NewTaskContextValue = {
  isOpen: false,
  requestedTarget: null,
  screenTarget: null,
  openNewTask: noop,
  closeNewTask: noop,
};

const NewTaskContext = createContext<NewTaskContextValue>(NEW_TASK_DEFAULT_VALUE);
const NewTaskScreenTargetContext = createContext<SetNewTaskScreenTarget>(noop);

export function NewTaskProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [requestedTarget, setRequestedTarget] = useState<NewTaskTarget | null>(null);
  const [screenTarget, setScreenTargetState] = useState<NewTaskTarget | null>(null);

  const openNewTask = useCallback((target?: NewTaskTarget) => {
    setRequestedTarget(target ?? null);
    setIsOpen(true);
  }, []);
  const closeNewTask = useCallback(() => setIsOpen(false), []);

  // Keeps the previous object when nothing changed, so a re-report does not
  // re-render the dialog's consumers.
  const setScreenTarget = useCallback<SetNewTaskScreenTarget>((target) => {
    setScreenTargetState((prev) => {
      if (prev === null && target === null) return prev;
      if (prev && target && prev.worktreeId === target.worktreeId && prev.instanceId === target.instanceId) {
        return prev;
      }
      return target;
    });
  }, []);

  const value = useMemo<NewTaskContextValue>(
    () => ({ isOpen, requestedTarget, screenTarget, openNewTask, closeNewTask }),
    [isOpen, requestedTarget, screenTarget, openNewTask, closeNewTask],
  );

  return (
    <NewTaskScreenTargetContext.Provider value={setScreenTarget}>
      <NewTaskContext.Provider value={value}>{children}</NewTaskContext.Provider>
    </NewTaskScreenTargetContext.Provider>
  );
}

/** App-wide New task dialog state. Outside the provider this never opens. */
export function useNewTask(): NewTaskContextValue {
  return useContext(NewTaskContext);
}

/** The stable setter `useNewTaskScreenTarget` reports through. */
export function useSetNewTaskScreenTarget(): SetNewTaskScreenTarget {
  return useContext(NewTaskScreenTargetContext);
}
