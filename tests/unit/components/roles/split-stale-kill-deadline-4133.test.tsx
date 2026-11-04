/**
 * Issue #4133, the screen's half: the split header says when what it shows may be old
 * (3), and a kill-session that gets no answer still ends in a read and a notice (6).
 *
 * From the parents down: the split pane holding `SplitRoleStatus`, and the roster pane
 * whose restart is what fails to read back. Both share the one store.
 *
 * Positive controls: the mark and the deadline fail on the code before this Issue.
 * Negative controls: no failure no mark, a first read that fails claims nothing, and a
 * kill that is answered behaves as it did.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { SplitRoleStatus } from '@/components/roles/SplitRoleStatus';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import { FakeRoleServer, launched } from './fake-role-server';
import ja from '../../../../locales/ja/common.json';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

beforeAll(() => installRadixJsdomPolyfills());

const INITIAL: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
];

let server: FakeRoleServer;
let seq = 0;
let worktreeId: string;

beforeEach(() => {
  seq += 1;
  worktreeId = `w-4133-${seq}`;
  server = new FakeRoleServer(INITIAL);
  global.fetch = server.fetch as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

function Split({ isRunning = true }: { isRunning?: boolean }) {
  return (
    <TerminalSplitPane
      worktreeId={worktreeId}
      splitIndex={0}
      cliToolId="claude"
      instanceId="claude"
      instance={INITIAL[0]}
      availableInstances={INITIAL}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      status="ready"
      onEndSession={vi.fn()}
      roleStatus={
        <SplitRoleStatus
          worktreeId={worktreeId}
          instanceId="claude"
          splitIndex={0}
          sessionStatus="ready"
          isRunning={isRunning}
          onRestart={vi.fn()}
        />
      }
      terminal={<div />}
      footer={<div />}
    />
  );
}

function RosterPane() {
  return (
    <AgentInstancesPane
      worktreeId={worktreeId}
      instances={INITIAL}
      onInstancesChange={vi.fn()}
      vibeLocalModel={null}
      onVibeLocalModelChange={vi.fn()}
    />
  );
}

const mark = () => screen.queryByTestId('split-role-stale-0');
const pendingRestart = () => {
  server.running.claude = true;
  server.application.claude = { launched: launched({ roleName: 'PM' }), restartPending: 'yes' };
};
async function restartFromRosterPane(): Promise<void> {
  fireEvent.click(screen.getByTestId('instance-roles-toggle'));
  fireEvent.click(await screen.findByTestId('instance-role-restart-claude'));
  fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
}

describe('[#4133] the split header when a read fails', () => {
  it('a restart whose read afterwards fails: a short mark, the whole sentence in its title', async () => {
    pendingRestart();
    render(
      <ConfirmProvider>
        <Split />
        <RosterPane />
      </ConfirmProvider>,
    );
    await screen.findByTestId('split-role-status-0');
    expect(mark()).toBeNull();
    server.refuseSettingsRead = true;
    await restartFromRosterPane();
    await waitFor(() => expect(mark()).not.toBeNull());
    expect(mark()).toHaveAttribute('title', ja.agentRoles.savedStale);
    expect(mark()).toHaveAttribute('aria-label', ja.agentRoles.savedStale);
    // Old, not gone: what was shown stays beside the mark, and the restart with it.
    expect(screen.getByTestId('split-role-status-0')).toBeInTheDocument();
    expect(screen.getByTestId('split-role-restart-0')).toBeInTheDocument();
  });

  it('goes when a read succeeds', async () => {
    pendingRestart();
    render(
      <ConfirmProvider>
        <Split />
        <RosterPane />
      </ConfirmProvider>,
    );
    await screen.findByTestId('split-role-status-0');
    server.refuseSettingsRead = true;
    await restartFromRosterPane();
    await waitFor(() => expect(mark()).not.toBeNull());
    server.refuseSettingsRead = false;
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(mark()).toBeNull());
  });

  it("the split's own read, when the session moved, fails: the mark too", async () => {
    pendingRestart();
    const { rerender } = render(<ConfirmProvider><Split isRunning={false} /></ConfirmProvider>);
    await screen.findByTestId('split-role-status-0');
    server.refuseSettingsRead = true;
    rerender(<ConfirmProvider><Split isRunning /></ConfirmProvider>);
    await waitFor(() => expect(mark()).not.toBeNull());
  });

  it('a split with no role shown still marks it: the old answer may be why (positive control)', async () => {
    server.application.claude = { effectiveNext: { kind: 'none', source: 'fallback', cliToolId: 'claude', repositoryId: null, repositoryIds: [], reason: 'no-default', injectionFingerprint: null } };
    const { rerender } = render(<ConfirmProvider><Split isRunning={false} /></ConfirmProvider>);
    await waitFor(() => expect(server.calls.some((c) => c.url.endsWith('/instances/roles'))).toBe(true));
    await act(async () => {});
    expect(screen.queryByTestId('split-role-status-0')).toBeNull();
    server.refuseSettingsRead = true;
    rerender(<ConfirmProvider><Split isRunning /></ConfirmProvider>);
    await waitFor(() => expect(mark()).not.toBeNull());
    expect(screen.queryByTestId('split-role-status-0')).toBeNull();
  });

  it('nothing failed: no mark (negative control)', async () => {
    pendingRestart();
    render(<ConfirmProvider><Split /></ConfirmProvider>);
    await screen.findByTestId('split-role-status-0');
    await act(async () => {});
    expect(mark()).toBeNull();
  });

  it('the first read failing claims nothing old: nothing was shown (negative control)', async () => {
    server.refuseSettingsRead = true;
    render(<ConfirmProvider><Split /></ConfirmProvider>);
    await waitFor(() => expect(server.calls.some((c) => c.url.endsWith('/instances/roles'))).toBe(true));
    await act(async () => {});
    expect(mark()).toBeNull();
  });
});

describe('[#4133] kill-session with a deadline', () => {
  const KILL = '/kill-session';
  const settingsReads = () => server.calls.filter((c) => c.method === 'GET' && c.url.endsWith('/instances/roles')).length;

  /** The kill goes nowhere: pending until the request's signal fires, as a real fetch is. */
  function stallKill(): { query: () => string | null; signal: () => AbortSignal | undefined } {
    let url: string | null = null;
    let signal: AbortSignal | undefined;
    const passOn = global.fetch;
    global.fetch = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      if (!input.split('?')[0].endsWith(KILL)) return (passOn as unknown as typeof server.fetch)(input, init);
      url = input;
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    return { query: () => url && url.slice(url.indexOf('?') + 1), signal: () => signal };
  }

  function answerKill(status: number): void {
    const passOn = global.fetch;
    global.fetch = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      if (!input.split('?')[0].endsWith(KILL)) return (passOn as unknown as typeof server.fetch)(input, init);
      return new Response(JSON.stringify({}), { status });
    }) as unknown as typeof fetch;
  }

  const expire = () => act(async () => void (await vi.advanceTimersByTimeAsync(15000)));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  it('no answer, the session still running: after 15 seconds it reads again and says so', async () => {
    pendingRestart();
    const kill = stallKill();
    render(<ConfirmProvider><RosterPane /></ConfirmProvider>);
    await restartFromRosterPane();
    await waitFor(() => expect(kill.query()).not.toBeNull());
    await act(async () => void (await vi.advanceTimersByTimeAsync(14000)));
    expect(kill.signal()?.aborted).toBe(false);
    expect(screen.queryByTestId('instance-role-error-claude')).toBeNull();
    const before = settingsReads();
    await expire();
    await waitFor(() => expect(screen.getByTestId('instance-role-error-claude').textContent).toBe(ja.agentRoles.instances.restartError));
    await waitFor(() => expect(settingsReads()).toBeGreaterThan(before));
  });

  it('no answer, and the session did end: it reads again and reports no failure', async () => {
    pendingRestart();
    const kill = stallKill();
    render(<ConfirmProvider><RosterPane /></ConfirmProvider>);
    await restartFromRosterPane();
    await waitFor(() => expect(kill.query()).not.toBeNull());
    const before = settingsReads();
    server.running.claude = false;
    await expire();
    await waitFor(() => expect(settingsReads()).toBeGreaterThan(before));
    await act(async () => {});
    expect(screen.queryByTestId('instance-role-error-claude')).toBeNull();
  });

  it('the kill still names the tool and the instance (without them it ends every session)', async () => {
    pendingRestart();
    const kill = stallKill();
    render(<ConfirmProvider><RosterPane /></ConfirmProvider>);
    await restartFromRosterPane();
    await waitFor(() => expect(kill.query()).toBe('cliTool=claude&instance=claude'));
    await expire();
  });

  it('answered: no error, and the deadline does not fire later (negative control)', async () => {
    pendingRestart();
    const fetchSpy = vi.spyOn(server, 'fetch');
    render(<ConfirmProvider><RosterPane /></ConfirmProvider>);
    await restartFromRosterPane();
    await waitFor(() => expect(fetchSpy.mock.calls.some(([url]) => String(url).includes(KILL))).toBe(true));
    const before = settingsReads();
    await expire();
    expect(screen.queryByTestId('instance-role-error-claude')).toBeNull();
    expect(settingsReads()).toBeGreaterThanOrEqual(before);
  });

  it('a 404 is already ended, which is the goal (negative control)', async () => {
    pendingRestart();
    answerKill(404);
    render(<ConfirmProvider><RosterPane /></ConfirmProvider>);
    await restartFromRosterPane();
    await act(async () => {});
    expect(screen.queryByTestId('instance-role-error-claude')).toBeNull();
  });

  it('a refusal says it failed, without asking whether the session ended (negative control)', async () => {
    pendingRestart();
    answerKill(403);
    render(<ConfirmProvider><RosterPane /></ConfirmProvider>);
    await restartFromRosterPane();
    await waitFor(() => expect(screen.getByTestId('instance-role-error-claude').textContent).toBe(ja.agentRoles.instances.restartError));
  });

  it('a 500 may have ended it: read as an answer that says nothing', async () => {
    pendingRestart();
    answerKill(500);
    render(<ConfirmProvider><RosterPane /></ConfirmProvider>);
    await restartFromRosterPane();
    await waitFor(() => expect(screen.getByTestId('instance-role-error-claude').textContent).toBe(ja.agentRoles.instances.restartError));
  });
});
