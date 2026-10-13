/**
 * @vitest-environment jsdom
 *
 * Issue #3593: the split container publishes the SELECTED split — its index,
 * the instance it shows, and every split's instance — so the header's current
 * session and End / Auto Yes read one value. A session picked in the header
 * goes to the selected split (it went to split 0 before), and a drop selects
 * the split it landed in.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  TerminalSplitContainer,
  type SelectedSplit,
} from '@/components/worktree/TerminalSplitContainer';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import type { AgentInstance } from '@/lib/cli-tools/types';

const ROSTER: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
  { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 2 },
];

function clickLayout(count: number): void {
  fireEvent.click(screen.getByTestId(`split-layout-${count}`));
}

function setup() {
  const onSelectedSplitChange = vi.fn<(selection: SelectedSplit) => void>();
  const showToast = vi.fn();
  function Harness() {
    const [sel, setSel] = React.useState<{ instanceId: string; token: number } | null>(null);
    const tokenRef = React.useRef(0);
    return (
      <>
        {ROSTER.map((inst) => (
          <button
            key={inst.id}
            type="button"
            data-testid={`hdr-select-${inst.id}`}
            onClick={() => {
              tokenRef.current += 1;
              setSel({ instanceId: inst.id, token: tokenRef.current });
            }}
          >
            {inst.id}
          </button>
        ))}
        <TerminalSplitContainer
          worktreeId="w-3593"
          instances={ROSTER}
          headerInstanceSelection={sel}
          showToast={showToast}
          onSelectedSplitChange={onSelectedSplitChange}
          renderPane={({ splitIndex, instanceId, onFocus, onDropInstance }) => (
            <div data-split-index={splitIndex}>
              <span data-testid={`pane-inst-${splitIndex}`}>{instanceId}</span>
              <textarea data-testid={`ta-${splitIndex}`} onFocus={onFocus} />
              {ROSTER.map((inst) => (
                <button
                  key={inst.id}
                  type="button"
                  data-testid={`drop-${inst.id}-${splitIndex}`}
                  onClick={() => onDropInstance(inst.id)}
                >
                  drop
                </button>
              ))}
            </div>
          )}
        />
      </>
    );
  }
  render(<Harness />);
  const last = () => onSelectedSplitChange.mock.calls[onSelectedSplitChange.mock.calls.length - 1]?.[0];
  return { onSelectedSplitChange, showToast, last };
}

beforeEach(() => clearTerminalSplitsLocalStorage());
afterEach(() => clearTerminalSplitsLocalStorage());

describe('[#3593] TerminalSplitContainer publishes the selected split', () => {
  it('publishes on mount, and again when the selected split changes', () => {
    const { last } = setup();
    expect(last()).toEqual({ index: 0, instanceId: 'claude', splitInstanceIds: ['claude'] });

    clickLayout(2);
    fireEvent.focus(screen.getByTestId('ta-0'));
    expect(last()).toEqual({ index: 0, instanceId: 'claude', splitInstanceIds: ['claude', 'codex'] });

    fireEvent.focus(screen.getByTestId('ta-1'));
    expect(last()).toEqual({ index: 1, instanceId: 'codex', splitInstanceIds: ['claude', 'codex'] });
  });

  it('does not publish again when nothing it carries changed', () => {
    const { onSelectedSplitChange } = setup();
    const before = onSelectedSplitChange.mock.calls.length;
    fireEvent.focus(screen.getByTestId('ta-0'));
    expect(onSelectedSplitChange.mock.calls.length).toBe(before);
  });
});

describe('[#3593] a header pick goes to the selected split', () => {
  it('shows an unshown session in the selected split (split 2 selected → split 2 changes)', () => {
    const { last } = setup();
    clickLayout(2);
    fireEvent.focus(screen.getByTestId('ta-1'));

    fireEvent.click(screen.getByTestId('hdr-select-gemini'));

    expect(screen.getByTestId('pane-inst-0').textContent).toBe('claude');
    expect(screen.getByTestId('pane-inst-1').textContent).toBe('gemini');
    expect(last()).toEqual({ index: 1, instanceId: 'gemini', splitInstanceIds: ['claude', 'gemini'] });
  });

  it('selects the split that already shows the session (no reassignment)', () => {
    const { last } = setup();
    clickLayout(2);
    fireEvent.focus(screen.getByTestId('ta-1'));

    fireEvent.click(screen.getByTestId('hdr-select-claude'));

    expect(screen.getByTestId('pane-inst-0').textContent).toBe('claude');
    expect(screen.getByTestId('pane-inst-1').textContent).toBe('codex');
    expect(last()).toEqual({ index: 0, instanceId: 'claude', splitInstanceIds: ['claude', 'codex'] });
  });

  it('negative control: with split 1 selected the pick still lands in split 1', () => {
    setup();
    clickLayout(2);
    fireEvent.focus(screen.getByTestId('ta-0'));
    fireEvent.click(screen.getByTestId('hdr-select-gemini'));
    expect(screen.getByTestId('pane-inst-0').textContent).toBe('gemini');
    expect(screen.getByTestId('pane-inst-1').textContent).toBe('codex');
  });
});

describe('[#3593] the drop rules are unchanged, and a drop selects its split', () => {
  it('apply: an unshown session dropped on split 2 shows there and split 2 becomes selected', () => {
    const { last, showToast } = setup();
    clickLayout(2);
    fireEvent.focus(screen.getByTestId('ta-0'));

    fireEvent.click(screen.getByTestId('drop-gemini-1'));

    expect(screen.getByTestId('pane-inst-1').textContent).toBe('gemini');
    expect(showToast).toHaveBeenLastCalledWith('Moved Gemini to Split 2', 'success');
    expect(last()).toEqual({ index: 1, instanceId: 'gemini', splitInstanceIds: ['claude', 'gemini'] });
  });

  it('reject: a session another split shows is refused with a toast; the selection stays', () => {
    const { last, showToast } = setup();
    clickLayout(2);
    fireEvent.focus(screen.getByTestId('ta-0'));

    fireEvent.click(screen.getByTestId('drop-claude-1'));

    expect(screen.getByTestId('pane-inst-1').textContent).toBe('codex');
    expect(showToast).toHaveBeenLastCalledWith('Claude is already in use by split 1', 'warning');
    expect(last()?.index).toBe(0);
  });

  it('no-op: a session dropped on the split already showing it changes nothing', () => {
    const { last, showToast } = setup();
    clickLayout(2);
    fireEvent.focus(screen.getByTestId('ta-0'));
    showToast.mockClear();

    fireEvent.click(screen.getByTestId('drop-codex-1'));

    expect(showToast).not.toHaveBeenCalled();
    expect(last()?.index).toBe(0);
  });
});
