/**
 * Issue #3332: the container tells each split's body whether a sibling's
 * maximize hides it, without unmounting it (#2261).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { useTerminalSplitHidden } from '@/components/worktree/TerminalSplitHiddenContext';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import { CLI_TOOL_IDS, getCliToolDisplayName, type AgentInstance } from '@/lib/cli-tools/types';

/**
 * Issue #3514: the Action bar's "+ / -" stepper became layout icons (1-4). One
 * more / one fewer split is the icon for the current count +/- 1.
 */
function clickAddSplit(): void {
  const n = screen.queryAllByTestId(/^split-wrapper-\d+$/).length;
  fireEvent.click(screen.getByTestId(`split-layout-${n + 1}`));
}


const ROSTER: AgentInstance[] = CLI_TOOL_IDS.map((cliTool, order) => ({
  id: cliTool,
  cliTool,
  alias: getCliToolDisplayName(cliTool),
  order,
}));

function Body({ idx, onToggleMaximize }: { idx: number; onToggleMaximize: () => void }) {
  const hidden = useTerminalSplitHidden();
  return (
    <div data-split-index={idx}>
      <span data-testid={`hidden-${idx}`}>{String(hidden)}</span>
      <button type="button" data-testid={`max-${idx}`} onClick={onToggleMaximize}>
        max
      </button>
    </div>
  );
}

describe('[#3332] TerminalSplitContainer hidden flag', () => {
  beforeEach(() => clearTerminalSplitsLocalStorage());
  afterEach(() => clearTerminalSplitsLocalStorage());

  it('is true only for the splits a maximize hides, and false again on restore', () => {
    render(
      <TerminalSplitContainer
        worktreeId="w-1"
        instances={ROSTER}
        renderPane={({ splitIndex, onToggleMaximize }) => (
          <Body idx={splitIndex} onToggleMaximize={onToggleMaximize} />
        )}
      />,
    );
    clickAddSplit();
    clickAddSplit();
    expect(screen.getByTestId('hidden-0')).toHaveTextContent('false');
    expect(screen.getByTestId('hidden-1')).toHaveTextContent('false');

    fireEvent.click(screen.getByTestId('max-1'));
    expect(screen.getByTestId('hidden-0')).toHaveTextContent('true');
    expect(screen.getByTestId('hidden-1')).toHaveTextContent('false');
    expect(screen.getByTestId('hidden-2')).toHaveTextContent('true');

    fireEvent.click(screen.getByTestId('max-1'));
    expect(screen.getByTestId('hidden-0')).toHaveTextContent('false');
    expect(screen.getByTestId('hidden-2')).toHaveTextContent('false');
  });
});
