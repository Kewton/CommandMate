/**
 * Issue #3514 (review): a placement request is applied once and is not
 * re-applied when the split container REMOUNTS.
 *
 * The real path: add an agent with "new split" -> go back to 1 split -> open
 * the first file. Opening it makes FilePanelSplit change the DOM hierarchy,
 * which remounts TerminalSplitContainer; its token guard is a ref, so a request
 * the parent still held would be applied again and the closed split would come
 * back. The harness reproduces the remount with a `key` change, and wires the
 * parent half through the same `useTerminalSplitPlacement` hook
 * WorktreeDetailDesktop uses.
 *
 * @vitest-environment jsdom
 */

import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { useTerminalSplitPlacement } from '@/hooks/useTerminalSplitPlacement';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import type { AgentInstance } from '@/lib/cli-tools/types';

const BASE: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
];
const ADDED: AgentInstance = { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 2 };

let api: {
  add: () => void;
  remount: () => void;
} | null = null;

function Harness({ onApplied }: { onApplied?: (token: number) => void }) {
  const [instances, setInstances] = useState(BASE);
  const [mountKey, setMountKey] = useState(0);
  const { request, requestPlacement, handleApplied } = useTerminalSplitPlacement();
  api = {
    add: () => {
      // What AgentAddMenu + WorktreeDetailDesktop do on a saved add.
      setInstances([...BASE, ADDED]);
      requestPlacement(ADDED.id, 'new-split');
    },
    remount: () => setMountKey((k) => k + 1),
  };
  return (
    <div key={mountKey}>
      <TerminalSplitContainer
        worktreeId="w-3514-remount"
        instances={instances}
        instancePlacementRequest={request}
        onInstancePlacementApplied={(token) => {
          onApplied?.(token);
          handleApplied(token);
        }}
        renderPane={({ splitIndex, instanceId }) => (
          <div data-split-index={splitIndex}>
            <span data-testid={`pane-instance-${splitIndex}`}>{instanceId}</span>
          </div>
        )}
      />
    </div>
  );
}

function shown(): string[] {
  return screen.queryAllByTestId(/^pane-instance-\d+$/).map((el) => el.textContent ?? '');
}

describe('[#3514] placement survives a container remount without re-applying', () => {
  beforeEach(() => clearTerminalSplitsLocalStorage());
  afterEach(() => {
    clearTerminalSplitsLocalStorage();
    api = null;
  });

  it('new split -> back to 1 split -> remount: the closed split stays closed', () => {
    render(<Harness />);
    act(() => api!.add());
    expect(shown()).toEqual(['claude', 'claude-2']);

    fireEvent.click(screen.getByTestId('split-layout-1'));
    expect(shown()).toEqual(['claude']);

    act(() => api!.remount());
    expect(shown()).toEqual(['claude']);
  });

  it('a plain add (no remount) is applied exactly once (negative control)', () => {
    const onApplied = vi.fn();
    render(<Harness onApplied={onApplied} />);
    act(() => api!.add());
    expect(shown()).toEqual(['claude', 'claude-2']);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith(1);
  });
});
