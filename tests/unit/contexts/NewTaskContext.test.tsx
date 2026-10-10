/**
 * NewTaskContext (Issue #3511).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  NEW_TASK_DEFAULT_VALUE,
  NewTaskProvider,
  useNewTask,
} from '@/contexts/NewTaskContext';
import { useNewTaskScreenTarget } from '@/hooks/useNewTaskScreenTarget';

function Probe() {
  const { isOpen, requestedTarget, screenTarget, openNewTask, closeNewTask } = useNewTask();
  return (
    <div>
      <span data-testid="state">
        {JSON.stringify({ isOpen, requestedTarget, screenTarget })}
      </span>
      <button type="button" onClick={() => openNewTask()}>open</button>
      <button type="button" onClick={() => openNewTask({ worktreeId: 'wt', instanceId: 'codex' })}>
        open-on
      </button>
      <button type="button" onClick={closeNewTask}>close</button>
    </div>
  );
}

function Screen({ worktreeId, instanceId }: { worktreeId: string; instanceId: string | null }) {
  useNewTaskScreenTarget(worktreeId, instanceId);
  return null;
}

function state() {
  return JSON.parse(screen.getByTestId('state').textContent ?? '{}');
}

describe('[#3511] NewTaskContext', () => {
  it('never opens without a provider', () => {
    render(<Probe />);
    fireEvent.click(screen.getByText('open'));
    expect(state()).toEqual({ isOpen: false, requestedTarget: null, screenTarget: null });
    expect(NEW_TASK_DEFAULT_VALUE.isOpen).toBe(false);
  });

  it('opens, optionally on a destination, and closes', () => {
    render(
      <NewTaskProvider>
        <Probe />
      </NewTaskProvider>,
    );
    fireEvent.click(screen.getByText('open-on'));
    expect(state()).toMatchObject({ isOpen: true, requestedTarget: { worktreeId: 'wt', instanceId: 'codex' } });
    fireEvent.click(screen.getByText('close'));
    fireEvent.click(screen.getByText('open'));
    expect(state()).toMatchObject({ isOpen: true, requestedTarget: null });
  });

  it('carries the screen target while the screen is mounted, and drops it after', () => {
    const { rerender } = render(
      <NewTaskProvider>
        <Screen worktreeId="wt-1" instanceId="claude" />
        <Probe />
      </NewTaskProvider>,
    );
    expect(state().screenTarget).toEqual({ worktreeId: 'wt-1', instanceId: 'claude' });

    rerender(
      <NewTaskProvider>
        <Screen worktreeId="wt-1" instanceId="codex-2" />
        <Probe />
      </NewTaskProvider>,
    );
    expect(state().screenTarget).toEqual({ worktreeId: 'wt-1', instanceId: 'codex-2' });

    rerender(
      <NewTaskProvider>
        <Probe />
      </NewTaskProvider>,
    );
    expect(state().screenTarget).toBeNull();
  });

  it('reports nothing for a screen with no agent selected yet', () => {
    render(
      <NewTaskProvider>
        <Screen worktreeId="wt-1" instanceId={null} />
        <Probe />
      </NewTaskProvider>,
    );
    expect(state().screenTarget).toBeNull();
  });
});
