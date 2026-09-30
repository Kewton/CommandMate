/**
 * The mode button on an OpenCode V2 pane (Issue #3038).
 *
 * OpenCode V2's `shift+tab` toggles the Build ⇄ Plan AGENT. #3038 moved it from
 * the quick-key strip (terminal screen only, folded on the phone) to this
 * control, which every surface draws beside the composer. What is pinned here:
 * the control renders for `opencode-v2`, a press sends `BTab` for that tool,
 * the chip says `build` / `plan` as the pane does, the agent-switch note is
 * printed, and the #2592 gate refuses the same frames it refuses elsewhere.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentModeControl } from '@/components/worktree/AgentModeControl';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AT_REST = {
  worktreeId: 'w-1',
  cliToolId: 'opencode-v2',
  agentMode: 'build',
  sessionStatus: 'ready',
  isPromptWaiting: false,
  isSelectionListActive: false,
  isDismissablePanelActive: false,
  isUnclassifiedActive: false,
} as const;

function renderControl(
  props: Partial<React.ComponentProps<typeof AgentModeControl>> = {},
) {
  return render(<AgentModeControl {...AT_REST} {...props} />);
}

const button = () => screen.getByTestId('agent-mode-cycle-button');

const FULL = 'OpenCode V2 switches between the Build (edits files) and Plan (read-only) agents.';

describe('[#3038] AgentModeControl on opencode-v2', () => {
  it('renders, and a press sends BTab for opencode-v2', async () => {
    renderControl();
    expect(screen.getByTestId('agent-mode-control')).toBeTruthy();
    fireEvent.click(button());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/worktrees/w-1/special-keys');
    expect(JSON.parse(String(init.body))).toEqual({ cliToolId: 'opencode-v2', keys: ['BTab'] });
  });

  it.each([
    ['build', 'build'],
    ['plan', 'plan'],
  ] as const)('shows the %s agent as "%s"', (agentMode, label) => {
    renderControl({ agentMode });
    expect(screen.getByTestId('agent-mode-chip').textContent).toBe(label);
    expect(button().getAttribute('aria-label')).toContain(`Currently ${label}`);
  });

  it('draws no chip when the agent row could not be read', () => {
    renderControl({ agentMode: 'unknown' });
    expect(screen.queryByTestId('agent-mode-chip')).toBeNull();
  });

  it('prints the agent-switch note, short on screen and full for a reader', () => {
    renderControl();
    const note = screen.getByTestId('agent-mode-note');
    expect(note.textContent).toBe('Switches agent');
    expect(note.getAttribute('title')).toBe(FULL);
    expect(button().getAttribute('title')).toBe(FULL);
    const describedBy = button().getAttribute('aria-describedby');
    expect(document.getElementById(describedBy!)?.textContent).toBe(FULL);
  });

  it.each([
    ['an approval or question is waiting', { isPromptWaiting: true }],
    ['a picker / the question list is open', { isSelectionListActive: true }],
    ['the frame could not be classified', { isUnclassifiedActive: true }],
    ['the palette is open (detector says waiting)', { sessionStatus: 'waiting' }],
    ['a turn is running', { sessionStatus: 'running' }],
  ] as const)('refuses while %s', async (_why, override) => {
    renderControl(override);
    expect(button().hasAttribute('disabled')).toBe(true);
    fireEvent.click(button());
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
