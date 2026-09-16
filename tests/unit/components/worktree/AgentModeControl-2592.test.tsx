/**
 * The permission-mode control's gate and chip (Issue #2592, Phase 3).
 *
 * The gate is the reason this component is not just a button. `shift+tab` does
 * not mean "cycle the mode" while a permission dialog is on screen: on claude it
 * is bound to option 2, `Yes, allow all edits during this session (shift+tab)`
 * (`tests/fixtures/canary/permission-dialog.raw.txt:31`), and Command Code
 * spells its own the same way. So one tap on the wrong frame is a session-wide
 * grant of every edit, from a button whose cap says "Mode".
 *
 * Every refusal below is therefore asserted twice — the button is disabled AND
 * `fetch` was never called — because `disabled` alone is an attribute and the
 * thing that matters is that no key left the browser.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentModeControl, canCycleAgentMode } from '@/components/worktree/AgentModeControl';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { AGENT_MODE_TOOL_IDS } from '@/lib/detection/agent-mode';

// Real dictionary: this file asserts rendered wording, and the global echo mock
// would keep those assertions green for a key that does not exist.
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

/** The pane state of an idle claude session in plan mode — the enabled case. */
const AT_REST = {
  worktreeId: 'w-1',
  cliToolId: 'claude',
  agentMode: 'plan',
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

describe('[#2592] which tools get a control at all', () => {
  it.each([...AGENT_MODE_TOOL_IDS])('renders for %s', (cliToolId) => {
    renderControl({ cliToolId });
    expect(screen.getByTestId('agent-mode-control')).toBeTruthy();
  });

  it.each(['opencode', 'vibe-local', 'gemini'] as const)(
    'renders nothing at all for %s',
    (cliToolId) => {
      // opencode's `BTab` switches AGENTS and already has its own button
      // (#2046); vibe-local has no binding; gemini's footer was never measured.
      const { container } = renderControl({ cliToolId });
      expect(container).toBeEmptyDOMElement();
    },
  );

  it('covers every supported tool between those two lists', () => {
    const covered = [...AGENT_MODE_TOOL_IDS, 'opencode', 'vibe-local', 'gemini'];
    expect([...covered].sort()).toEqual([...CLI_TOOL_IDS].sort());
  });
});

describe('[#2592] the gate refuses every frame that is not at rest', () => {
  it('sends BTab when the pane is ready and nothing is on screen', async () => {
    renderControl();
    expect(button().hasAttribute('disabled')).toBe(false);

    fireEvent.click(button());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/worktrees/w-1/special-keys');
    expect(JSON.parse(String(init.body))).toEqual({ cliToolId: 'claude', keys: ['BTab'] });
  });

  /**
   * The four dialog flags, one at a time. Each one is a frame where `shift+tab`
   * means something else — and for the first two, what it means on claude and
   * Command Code is "allow every edit in this session".
   */
  it.each([
    ['a wait is on screen', { isPromptWaiting: true }],
    ['a selection list is on screen', { isSelectionListActive: true }],
    ['a dismiss-only panel is on screen', { isDismissablePanelActive: true }],
    ['the frame could not be classified', { isUnclassifiedActive: true }],
  ] as const)('refuses while %s', async (_why, override) => {
    renderControl(override);

    expect(button().hasAttribute('disabled')).toBe(true);
    fireEvent.click(button());
    // Not "eventually zero" — a send would be a fetch on this tick.
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['running', 'waiting', 'idle', ''] as const)(
    'refuses at sessionStatus=%s',
    async (sessionStatus) => {
      // `''` is "no frame has landed yet" (the pane's initial state), and it must
      // not be mistaken for any of the three real verdicts.
      renderControl({ sessionStatus });

      expect(button().hasAttribute('disabled')).toBe(true);
      fireEvent.click(button());
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('targets a non-primary instance when given one', async () => {
    renderControl({ instanceId: 'claude-2' });
    fireEvent.click(button());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      cliToolId: 'claude',
      keys: ['BTab'],
      instanceId: 'claude-2',
    });
  });

  it('omits instanceId for the primary instance, as every other control does', async () => {
    renderControl({ instanceId: 'claude' });
    fireEvent.click(button());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ cliToolId: 'claude', keys: ['BTab'] });
  });
});

describe('[#2592] canCycleAgentMode is the whole rule, on its own', () => {
  const REST = {
    sessionStatus: 'ready',
    isPromptWaiting: false,
    isSelectionListActive: false,
    isDismissablePanelActive: false,
    isUnclassifiedActive: false,
  };

  it('is true only at rest', () => {
    expect(canCycleAgentMode(REST)).toBe(true);
    expect(canCycleAgentMode({ ...REST, sessionStatus: 'running' })).toBe(false);
    expect(canCycleAgentMode({ ...REST, isPromptWaiting: true })).toBe(false);
    expect(canCycleAgentMode({ ...REST, isSelectionListActive: true })).toBe(false);
    expect(canCycleAgentMode({ ...REST, isDismissablePanelActive: true })).toBe(false);
    expect(canCycleAgentMode({ ...REST, isUnclassifiedActive: true })).toBe(false);
  });
});

describe('[#2592] the chip says only what the frame said', () => {
  it('shows the mode when one was read', () => {
    renderControl({ agentMode: 'accept-edits' });
    expect(screen.getByTestId('agent-mode-chip').textContent).toBe('accept edits');
  });

  it('is absent for `unknown` — and the button is NOT', () => {
    // codex spends its whole default mode here: it prints no badge at all, so
    // the mode cannot be read. Not being able to READ it is not a reason to
    // refuse to CHANGE it.
    renderControl({ cliToolId: 'codex', agentMode: 'unknown' });

    expect(screen.queryByTestId('agent-mode-chip')).toBeNull();
    expect(button().hasAttribute('disabled')).toBe(false);
  });

  it('is absent for a mode id this bundle does not know', () => {
    // The wire is not typechecked. A newer server's mode must not become a chip
    // with a raw token in it.
    renderControl({ agentMode: 'yolo' });
    expect(screen.queryByTestId('agent-mode-chip')).toBeNull();
  });

  it('names the current mode in the accessible label', () => {
    renderControl({ agentMode: 'plan' });
    expect(button().getAttribute('aria-label')).toBe(
      'Cycle the agent permission mode. Currently plan. (shift+tab)',
    );
  });

  it('falls back to a label that claims no mode when none was read', () => {
    renderControl({ cliToolId: 'copilot', agentMode: 'unknown' });
    expect(button().getAttribute('aria-label')).toBe(
      'Cycle the agent permission mode (shift+tab)',
    );
  });
});

describe('[#2592] the codex model-coupling caution', () => {
  /**
   * #2592 §「設計に効く事実」4: codex moves the model tier and reasoning effort
   * with the mode (xhigh <-> medium, measured), so a press does more than the
   * cap says. The first cut put that only in the button's `title`, and the UAT
   * on a phone found it invisible — a touch screen never hovers. It is now
   * printed beside the chip.
   */
  const FULL = 'Codex changes its model and reasoning effort along with the mode.';

  it('is printed on screen for codex, whatever the mode reads as', () => {
    for (const agentMode of ['plan', 'unknown'] as const) {
      const { unmount } = renderControl({ cliToolId: 'codex', agentMode });
      const note = screen.getByTestId('agent-mode-note');
      expect(note.textContent, agentMode).toBe('Also switches model');
      // Visible, not merely present: nothing on it hides it at any breakpoint.
      expect(note.className).not.toMatch(/(^|\s)(hidden|sr-only|invisible)(\s|$)/);
      unmount();
    }
  });

  it('keeps the full sentence for a pointer and for a screen reader', () => {
    renderControl({ cliToolId: 'codex', agentMode: 'plan' });
    const note = screen.getByTestId('agent-mode-note');
    expect(note.getAttribute('title')).toBe(FULL);
    expect(button().getAttribute('title')).toBe(FULL);

    // The button is described by the full sentence, and the short caption is
    // hidden from the accessibility tree so it is not read twice.
    const describedBy = button().getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(FULL);
    expect(note.getAttribute('aria-hidden')).toBe('true');
  });

  it.each(['claude', 'command-code', 'copilot', 'antigravity'] as const)(
    'is absent for %s, which declares no caution',
    (cliToolId) => {
      renderControl({ cliToolId });
      expect(screen.queryByTestId('agent-mode-note')).toBeNull();
      expect(button().getAttribute('title')).toBeNull();
      expect(button().getAttribute('aria-describedby')).toBeNull();
    },
  );
});
