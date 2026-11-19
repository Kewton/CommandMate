/**
 * Issue #4438 (stage B): the Antigravity usage notice where an instance is added.
 *
 * Both entry points — the header "+" form (`AgentAddMenu`) and the roster editor
 * (`AgentInstancesPane`, which the phone renders through
 * `MobileAgentInstancesPane`) — show the notice once when antigravity is chosen,
 * with the two links from the tool policy (L0). The notice is guidance: it never
 * stops the add (the server refuses what it must, #4436).
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentAddMenu } from '@/components/worktree/AgentAddMenu';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { MobileAgentInstancesPane } from '@/components/worktree/MobileAgentInstancesPane';
import { ANTIGRAVITY_NOTICE_TEST_ID } from '@/components/worktree/antigravity-usage-notice';
import { clearRosterSnapshot, recordRosterSaved } from '@/hooks/useInstanceRoleSettings';
import { ANTIGRAVITY_FAQ_URL, ANTIGRAVITY_TERMS_URL } from '@/lib/tool-policy/policy';
import { CLI_TOOL_IDS, type AgentInstance } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

const ROSTER: AgentInstance[] = [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }];

function mockFetch(worktreeId: string): void {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    if (url === `/api/worktrees/${worktreeId}` && !init?.method) {
      return Promise.resolve({ ok: true, json: async () => ({ agentInstances: ROSTER, rosterRevision: 'rev-test' }) });
    }
    if (url.startsWith('/api/settings/default-agents')) {
      return Promise.resolve({ ok: true, json: async () => ({ installed: [...CLI_TOOL_IDS] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }) as unknown as typeof fetch;
}

function patchCalls(): unknown[] {
  return (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method === 'PATCH' || (call[1] as RequestInit | undefined)?.method === 'POST',
  );
}

function notice(): HTMLElement | null {
  return screen.queryByTestId(ANTIGRAVITY_NOTICE_TEST_ID);
}

function expectLinks(): void {
  const box = notice() as HTMLElement;
  const links = Array.from(box.querySelectorAll('a'));
  expect(links.map((a) => a.getAttribute('href'))).toEqual([ANTIGRAVITY_TERMS_URL, ANTIGRAVITY_FAQ_URL]);
  for (const a of links) {
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  }
}

beforeAll(() => installRadixJsdomPolyfills());

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('[#4438] AgentAddMenu: the notice when adding antigravity', () => {
  beforeEach(() => {
    clearRosterSnapshot('w-4438');
    mockFetch('w-4438');
  });

  function renderMenu(): { onAdded: ReturnType<typeof vi.fn> } {
    const onAdded = vi.fn();
    render(
      <AgentAddMenu worktreeId="w-4438" instances={ROSTER} splitCount={1} onInstancesChange={vi.fn()} onAdded={onAdded} />,
    );
    return { onAdded };
  }

  async function openForm(): Promise<void> {
    fireEvent.click(screen.getByTestId('agent-add-button'));
    await waitFor(() => expect(screen.getByTestId('agent-add-tool')).not.toBeDisabled());
  }

  it('shows nothing for any other tool (I5)', async () => {
    renderMenu();
    await openForm();
    for (const tool of CLI_TOOL_IDS.filter((id) => id !== 'antigravity')) {
      fireEvent.change(screen.getByTestId('agent-add-tool'), { target: { value: tool } });
      expect(notice()).toBeNull();
    }
  });

  it('shows once with the policy links, and not after it was closed (I6, I7)', async () => {
    renderMenu();
    await openForm();
    fireEvent.change(screen.getByTestId('agent-add-tool'), { target: { value: 'antigravity' } });
    expect(notice()).not.toBeNull();
    expectLinks();
    fireEvent.click(screen.getByTestId(`${ANTIGRAVITY_NOTICE_TEST_ID}-dismiss`));
    expect(notice()).toBeNull();
    // Still in the form: closing the notice is not a submit.
    expect(screen.getByTestId('agent-add-form')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('agent-add-tool'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByTestId('agent-add-tool'), { target: { value: 'antigravity' } });
    expect(notice()).toBeNull();
  });

  it('shows when the storage cannot be read (I6)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    renderMenu();
    await openForm();
    fireEvent.change(screen.getByTestId('agent-add-tool'), { target: { value: 'antigravity' } });
    expect(notice()).not.toBeNull();
  });

  it('does not stop the add while the notice is up (I9)', async () => {
    renderMenu();
    await openForm();
    fireEvent.change(screen.getByTestId('agent-add-tool'), { target: { value: 'antigravity' } });
    expect(notice()).not.toBeNull();
    expect(screen.getByTestId('agent-add-submit')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('agent-add-submit'));
    await waitFor(() => expect(patchCalls().length).toBeGreaterThan(0));
    const body = JSON.parse(String((patchCalls()[0] as [string, RequestInit])[1].body));
    expect(JSON.stringify(body)).toContain('antigravity');
  });
});

const paneProps = {
  worktreeId: 'w-4438p',
  onInstancesChange: vi.fn(),
  vibeLocalModel: null as string | null,
  onVibeLocalModelChange: vi.fn(),
  vibeLocalContextWindow: null as number | null,
  onVibeLocalContextWindowChange: vi.fn(),
};

describe('[#4438] AgentInstancesPane (PC) and MobileAgentInstancesPane (phone)', () => {
  beforeEach(() => {
    clearRosterSnapshot('w-4438p');
    recordRosterSaved('w-4438p', ROSTER, 'rev-test');
    mockFetch('w-4438p');
  });

  const surfaces: Array<[string, () => void]> = [
    ['PC', () => render(<AgentInstancesPane {...paneProps} instances={ROSTER} />)],
    [
      'phone',
      () =>
        render(
          <MobileAgentInstancesPane
            {...paneProps}
            instances={ROSTER}
            visibleInstanceIds={['claude']}
            onToggleInstanceVisible={vi.fn()}
          />,
        ),
    ],
  ];

  for (const [surface, mount] of surfaces) {
    it(`${surface}: nothing for other tools; antigravity once with the links; closed stays closed (I5–I7)`, () => {
      mount();
      for (const tool of CLI_TOOL_IDS.filter((id) => id !== 'antigravity')) {
        fireEvent.change(screen.getByTestId('agent-instance-add-tool'), { target: { value: tool } });
        expect(notice()).toBeNull();
      }
      fireEvent.change(screen.getByTestId('agent-instance-add-tool'), { target: { value: 'antigravity' } });
      expect(notice()).not.toBeNull();
      expectLinks();
      fireEvent.click(screen.getByTestId(`${ANTIGRAVITY_NOTICE_TEST_ID}-dismiss`));
      expect(notice()).toBeNull();
      fireEvent.change(screen.getByTestId('agent-instance-add-tool'), { target: { value: 'codex' } });
      fireEvent.change(screen.getByTestId('agent-instance-add-tool'), { target: { value: 'antigravity' } });
      expect(notice()).toBeNull();
    });

    it(`${surface}: the add still goes through with the notice up (I9)`, async () => {
      mount();
      fireEvent.change(screen.getByTestId('agent-instance-add-tool'), { target: { value: 'antigravity' } });
      expect(notice()).not.toBeNull();
      expect(screen.getByTestId('agent-instance-add')).not.toBeDisabled();
      fireEvent.click(screen.getByTestId('agent-instance-add'));
      await waitFor(() => expect(patchCalls().length).toBeGreaterThan(0));
      const body = JSON.parse(String((patchCalls()[0] as [string, RequestInit])[1].body));
      expect(JSON.stringify(body)).toContain('antigravity');
    });
  }
});
