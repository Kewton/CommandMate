/**
 * Issue #4484: the split container's half of `?instance=X` (source `url`).
 *
 * The URL request now rides the header "+" placement path (#3514): it waits for
 * the roster, is marked handled per `${source}:${token}`, and reports an outcome.
 * What the URL adds (review P1-2 / P2-4): success is acknowledged only once the
 * COMMITTED selected split shows X (and is visible), not when `setSplitInstance`
 * accepted the change — its queued updater can still refuse it.
 *
 * Positive controls (red before the fix): the roster race below acknowledged with
 * D selected; a "+" request reusing the URL's token number was dropped; the
 * refusal was acknowledged as if applied. Negative controls: a "+" request still
 * places as before, and a programmatic focus of a new split is not a user pick.
 *
 * @vitest-environment jsdom
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { useSplitFocusAndPlacement } from '@/components/worktree/terminal-split-container/useSplitFocusAndPlacement';
import type { InstancePlacementRequest } from '@/components/worktree/terminal-split-container/types';
import { clearTerminalSplitsLocalStorage, mockTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import type { AgentInstance } from '@/lib/cli-tools/types';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const WT = 'w-4484-placement';
const inst = (id: string, cliTool: AgentInstance['cliTool'], order: number): AgentInstance => ({ id, cliTool, alias: id.toUpperCase(), order });
const A = inst('a', 'claude', 0);
const B = inst('b', 'codex', 1);
const C = inst('c', 'gemini', 2);
const X = inst('x', 'claude', 3);
const D = inst('d', 'copilot', 4);
const Y = inst('y', 'codex', 5);

type Applied = (token: number, ...rest: unknown[]) => void;
let api: {
  setInstances: (next: AgentInstance[]) => void;
  setRequest: (next: InstancePlacementRequest | null) => void;
} | null = null;

function Harness({ initial, onApplied, onUserSelectionChange }: {
  initial: AgentInstance[];
  onApplied: Applied;
  onUserSelectionChange?: () => void;
}) {
  const [instances, setInstances] = useState(initial);
  const [request, setRequest] = useState<InstancePlacementRequest | null>(null);
  api = { setInstances, setRequest };
  return (
    <TerminalSplitContainer
      worktreeId={WT}
      instances={instances}
      instancePlacementRequest={request}
      onInstancePlacementApplied={(token: number, ...rest: unknown[]) => {
        onApplied(token, ...rest);
        // The parent drops what was handled (as the controller / "+" hook do).
        setRequest((prev) => (prev?.token === token ? null : prev));
      }}
      onUserSelectionChange={onUserSelectionChange}
      renderPane={({ splitIndex, instanceId, onFocus, showFocusFrame }) => (
        <div data-split-index={splitIndex}>
          <span data-testid={`pane-${splitIndex}`}>{instanceId}</span>
          <span data-testid={`frame-${splitIndex}`}>{String(Boolean(showFocusFrame))}</span>
          <textarea data-testid={`ta-${splitIndex}`} onFocus={onFocus} />
        </div>
      )}
    />
  );
}

const shown = () => screen.queryAllByTestId(/^pane-\d+$/).map((el) => el.textContent ?? '');
const framed = () => screen.queryAllByTestId(/^frame-\d+$/).findIndex((el) => el.textContent === 'true');

beforeEach(() => clearTerminalSplitsLocalStorage());
afterEach(() => {
  clearTerminalSplitsLocalStorage();
  api = null;
});

describe('[#4484] a URL request is acknowledged only once the committed selection shows X', () => {
  it('X waits, the roster settles on [A,B,C] with split 3 selected, then [X,A,D] arrives: X ends selected, then the ack', () => {
    mockTerminalSplitsLocalStorage(WT, {
      splits: [
        { cliToolId: 'claude', instanceId: 'a' },
        { cliToolId: 'codex', instanceId: 'b' },
        { cliToolId: 'gemini', instanceId: 'c' },
      ],
      widths: [1 / 3, 1 / 3, 1 / 3],
    });
    const onApplied = vi.fn();
    render(<Harness initial={[A, B, C]} onApplied={onApplied} />);
    fireEvent.focus(screen.getByTestId('ta-2'));
    expect(framed()).toBe(2);

    act(() => api!.setRequest({ instanceId: 'x', placement: 'replace', token: 1, source: 'url' }));
    expect(onApplied).not.toHaveBeenCalled(); // not in the roster yet: kept

    // The reconcile (queued first) puts X in split 2; the placement read the
    // old splits and asked for split 3, which the queued updater refuses.
    act(() => api!.setInstances([X, A, D]));

    expect(shown()).toEqual(['a', 'x', 'd']);
    expect(framed()).toBe(1);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith(1, 'url', 'applied', 'x');
  });

  it('the token numbers of the URL and the "+" are counted apart: both requests with token 1 are applied', () => {
    const onApplied = vi.fn();
    render(<Harness initial={[A, B, X, Y]} onApplied={onApplied} />);
    act(() => api!.setRequest({ instanceId: 'x', placement: 'replace', token: 1, source: 'url' }));
    expect(shown()).toEqual(['x']);
    act(() => api!.setRequest({ instanceId: 'y', placement: 'replace', token: 1, source: 'add' }));
    expect(shown()).toEqual(['y']);
    expect(onApplied.mock.calls).toEqual([
      [1, 'url', 'applied', 'x'],
      [1, 'add', 'applied'],
    ]);
  });

  it('negative control: a "+" new-split still appends and focuses, as before', () => {
    const onApplied = vi.fn();
    render(<Harness initial={[A, B]} onApplied={onApplied} />);
    act(() => api!.setInstances([A, B, X]));
    act(() => api!.setRequest({ instanceId: 'x', placement: 'new-split', token: 1, source: 'add' }));
    expect(shown()).toEqual(['a', 'x']);
    expect(framed()).toBe(1);
    expect(onApplied).toHaveBeenCalledWith(1, 'add', 'applied');
  });
});

describe('[#4484] a user pick of another split is reported (it ends a waiting URL request)', () => {
  it('focusing another split reports; a programmatic focus of a just-added split does not', () => {
    const onUserSelectionChange = vi.fn();
    render(<Harness initial={[A, B]} onApplied={vi.fn()} onUserSelectionChange={onUserSelectionChange} />);
    fireEvent.click(screen.getByTestId('split-layout-2'));
    expect(framed()).toBe(1); // the new split took focus programmatically
    expect(onUserSelectionChange).not.toHaveBeenCalled();
    fireEvent.focus(screen.getByTestId('ta-1')); // the selected one again: no change
    expect(onUserSelectionChange).not.toHaveBeenCalled();
    fireEvent.focus(screen.getByTestId('ta-0'));
    expect(onUserSelectionChange).toHaveBeenCalledTimes(1);
  });
});

describe('[#4484] the refusal seam (P2-4): setSplitInstance answers false', () => {
  function run(source: 'url' | 'add') {
    const onApplied = vi.fn();
    const setFocusedSplitIndex = vi.fn();
    renderHook(() =>
      useSplitFocusAndPlacement({
        splits: [{ cliToolId: 'claude', instanceId: 'a' }],
        focusedSplitIndex: 0,
        setFocusedSplitIndex,
        setSplitInstance: () => false,
        openInstanceInNewSplit: () => false,
        maximizedIndex: null,
        toggleMaximize: vi.fn(),
        instances: [A, X],
        containerRef: { current: null },
        instancePlacementRequest: { instanceId: 'x', placement: 'replace', token: 1, source },
        onInstancePlacementApplied: onApplied,
      }),
    );
    return { onApplied, setFocusedSplitIndex };
  }

  it('a URL request is reported refused, with the instance the selected split still shows', () => {
    const { onApplied, setFocusedSplitIndex } = run('url');
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith(1, 'url', 'refused', 'a');
    expect(setFocusedSplitIndex).not.toHaveBeenCalled();
  });

  it('a "+" request is reported refused too', () => {
    const { onApplied } = run('add');
    expect(onApplied).toHaveBeenCalledWith(1, 'add', 'refused');
  });
});
