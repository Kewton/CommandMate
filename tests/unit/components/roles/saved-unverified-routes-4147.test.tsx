/**
 * Every screen route that reads `saved_unverified` (Issue #4147), from the parents down.
 *
 * The routes (`grep -rn saved_unverified src`): `AgentAddMenu` (the header's "+") and
 * `AgentInstancesPane` (PC, and the phone through `NotesAndLogsPane`) each read the result of
 * `useAgentInstancesRoster`. Each has two notes: "saved, but could not be read back" (no
 * `unconfirmed`) and "could not be confirmed" (`unconfirmed`). The requests go through the
 * real `src/lib/api-client-agent-roles.ts` and the instance-creation client; only `fetch`
 * is the fake server's.
 *
 * @vitest-environment jsdom
 */

import React, { useState } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AgentAddMenu } from '@/components/worktree/AgentAddMenu';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { NotesAndLogsPane } from '@/components/worktree/NotesAndLogsPane';
import { SplitRoleStatus } from '@/components/roles/SplitRoleStatus';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { clearRosterSnapshot, refreshInstanceRoleSettings } from '@/hooks/useInstanceRoleSettings';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import { FakeRoleServer, duringTheCheck, loseNextAnswer } from './fake-role-server';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

beforeAll(() => installRadixJsdomPolyfills());

const INITIAL: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
];
const ROLES_PATH = '/instances/roles';

let server: FakeRoleServer;
let seq = 0;
let worktreeId: string;

beforeEach(() => {
  seq += 1;
  worktreeId = `w-4147-${seq}`;
  server = new FakeRoleServer(INITIAL);
  global.fetch = server.fetch as unknown as typeof fetch;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Desktop({ onAdded }: { onAdded?: (i: AgentInstance) => void }) {
  const [instances, setInstances] = useState<AgentInstance[]>(INITIAL);
  return (
    <ConfirmProvider>
      <DesktopHeader
        worktreeName="feature/4147"
        repositoryName="CommandMate"
        status="running"
        onInfoClick={vi.fn()}
        instances={instances}
        activeInstanceId="claude"
        agentAddControl={
          <AgentAddMenu
            worktreeId={worktreeId}
            instances={instances}
            splitCount={1}
            onInstancesChange={setInstances}
            onAdded={onAdded}
          />
        }
      />
      {/* The split header is what reads the role settings, and so the revision the pane writes against. */}
      <SplitRoleStatus worktreeId={worktreeId} instanceId="claude" splitIndex={0} sessionStatus="ready" isRunning={false} />
      <AgentInstancesPane
        worktreeId={worktreeId}
        instances={instances}
        onInstancesChange={setInstances}
        vibeLocalModel={null}
        onVibeLocalModelChange={vi.fn()}
      />
      <output data-testid="roster">{instances.map((i) => `${i.id}:${i.alias}`).join(',')}</output>
    </ConfirmProvider>
  );
}

function Phone() {
  const [instances, setInstances] = useState<AgentInstance[]>(INITIAL);
  return (
    <ConfirmProvider>
      <NotesAndLogsPane
        worktreeId={worktreeId}
        selectedAgents={['claude', 'codex']}
        onSelectedAgentsChange={vi.fn()}
        vibeLocalModel={null}
        onVibeLocalModelChange={vi.fn()}
        useInstanceManagement
        instances={instances}
        onInstancesChange={setInstances}
        visibleInstanceIds={['claude', 'codex']}
        onToggleInstanceVisible={vi.fn()}
        verification={{} as never}
      />
      <output data-testid="roster">{instances.map((i) => `${i.id}:${i.alias}`).join(',')}</output>
    </ConfirmProvider>
  );
}

const settingsReads = () => server.calls.filter((c) => c.method === 'GET' && c.url.endsWith(ROLES_PATH)).length;
const expire = () => act(async () => void (await vi.advanceTimersByTimeAsync(15000)));
const ids = () => server.roster.map((i) => i.id);

async function rendered(ui: React.ReactElement, open: () => Promise<void> = async () => {}): Promise<void> {
  render(ui);
  await open();
  await waitFor(() => expect(settingsReads()).toBeGreaterThan(0));
  await act(async () => {});
}

async function openAdd(): Promise<void> {
  fireEvent.click(screen.getByTestId('agent-add-button'));
  await waitFor(() => expect(screen.getByTestId('agent-add-tool')).not.toBeDisabled());
}

async function openPhoneAgents(): Promise<void> {
  const tab = screen.queryByTestId('agent-instance-add')
    ? null
    : screen.getAllByRole('button').find((button) => /agent|エージェント/i.test(button.textContent ?? ''));
  if (tab) fireEvent.click(tab);
  await screen.findByTestId('agent-instance-add');
}

/** Something newer is taken between the two settlings of a lost write's check. */
function newerAnswerBeforeSecondSettling(): void {
  duringTheCheck('before-second-settling', async () => {
    server.changeRosterElsewhere(server.roster.map((i) => (i.id === 'claude-2' ? { ...i, alias: 'Renamed' } : i)));
    await refreshInstanceRoleSettings(worktreeId);
  });
}

const SAVED = '保存しました';
const UNKNOWN = '確かめられませんでした';

describe('[#4147] the header "+" through the role route (POST)', () => {
  it('a newer answer taken during the check: says it was added, not that it is unknown', async () => {
    const onAdded = vi.fn();
    await rendered(<Desktop onAdded={onAdded} />);
    await openAdd();
    loseNextAnswer(server, 'POST', ROLES_PATH, '500', { committed: true });
    newerAnswerBeforeSecondSettling();
    fireEvent.click(screen.getByTestId('agent-add-submit'));
    await waitFor(() => expect(server.writes('POST', ROLES_PATH)).toHaveLength(1));
    await expire();

    const note = await screen.findByTestId('agent-add-saved-unverified');
    expect(note.textContent).toContain('追加は保存しました');
    expect(note.textContent).not.toContain(UNKNOWN);
    expect(screen.queryByTestId('agent-add-error')).toBeNull();
    expect(screen.getByTestId('agent-add-submit')).toBeDisabled();
    expect(onAdded).not.toHaveBeenCalled();
    expect(ids()).toEqual(['claude', 'codex', 'claude-2']);
  });

  it('negative control: with nothing newer in between it is saved, and no note shows', async () => {
    const onAdded = vi.fn();
    await rendered(<Desktop onAdded={onAdded} />);
    await openAdd();
    loseNextAnswer(server, 'POST', ROLES_PATH, '500', { committed: true });
    fireEvent.click(screen.getByTestId('agent-add-submit'));
    await waitFor(() => expect(server.writes('POST', ROLES_PATH)).toHaveLength(1));
    await expire();
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('agent-add-saved-unverified')).toBeNull();
  });
});

describe('[#4147] the header "+" falling back to the roster PATCH', () => {
  it('nothing readable after a lost PATCH: says it could not be confirmed, and cannot be pressed again', async () => {
    const onAdded = vi.fn();
    server.refuseSettingsRead = true;
    await rendered(<Desktop onAdded={onAdded} />);
    await openAdd();
    loseNextAnswer(server, 'PATCH', worktreeId, '500', { committed: true });
    // Readable up to the send (the write needs the roster), and not after it.
    const lost = global.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const answer = await (lost as typeof fetch)(url, init);
      if (init?.method === 'PATCH') server.refuseWorktreeRead = true;
      return answer;
    }) as unknown as typeof fetch;
    fireEvent.click(screen.getByTestId('agent-add-submit'));
    await waitFor(() => expect(server.writes('PATCH')).toHaveLength(1));
    await expire();

    const note = await screen.findByTestId('agent-add-saved-unverified');
    expect(note.textContent).toContain(UNKNOWN);
    expect(note.textContent).not.toContain(SAVED);
    expect(screen.queryByTestId('agent-add-error')).toBeNull();
    expect(screen.getByTestId('agent-add-submit')).toBeDisabled();
    expect(onAdded).not.toHaveBeenCalled();
    expect(server.writes('PATCH')).toHaveLength(1);
  });

  it('a newer answer taken during the check: says it was added', async () => {
    const onAdded = vi.fn();
    server.refuseSettingsRead = true;
    await rendered(<Desktop onAdded={onAdded} />);
    await openAdd();
    loseNextAnswer(server, 'PATCH', worktreeId, '500', { committed: true });
    // The role route is down, so the newer answer is the roster's own read.
    duringTheCheck('before-second-settling', async () => {
      server.changeRosterElsewhere(server.roster.map((i) => (i.id === 'claude-2' ? { ...i, alias: 'Renamed' } : i)));
      clearRosterSnapshot(worktreeId);
    });
    fireEvent.click(screen.getByTestId('agent-add-submit'));
    await waitFor(() => expect(server.writes('PATCH')).toHaveLength(1));
    await expire();

    const note = await screen.findByTestId('agent-add-saved-unverified');
    expect(note.textContent).toContain('追加は保存しました');
    expect(note.textContent).not.toContain(UNKNOWN);
    expect(screen.getByTestId('agent-add-submit')).toBeDisabled();
    expect(onAdded).not.toHaveBeenCalled();
  });
});

describe.each([
  ['PC', () => <Desktop />, async () => {}],
  ['phone (Tools tab)', () => <Phone />, openPhoneAgents],
] as const)('[#4147] the roster pane on %s', (_name, screenOf, open) => {
  const pressAdd = () => fireEvent.click(screen.getByTestId('agent-instance-add'));

  it('a newer answer taken during the check: says it was saved, not that it is unknown', async () => {
    await rendered(screenOf(), open);
    loseNextAnswer(server, 'PATCH', worktreeId, '500', { committed: true });
    newerAnswerBeforeSecondSettling();
    pressAdd();
    await waitFor(() => expect(server.writes('PATCH')).toHaveLength(1));
    await expire();

    const note = await screen.findByTestId('agent-instances-saved-unverified');
    expect(note.textContent).toContain(SAVED);
    expect(note.textContent).not.toContain(UNKNOWN);
    expect(screen.queryByTestId('agent-instances-error')).toBeNull();
    expect(screen.getByTestId('agent-instance-add')).toBeDisabled();
    expect(screen.getByTestId('roster').textContent).toBe('claude:Claude,codex:Codex');
  });

  it('nothing readable after a lost PATCH: says it could not be confirmed', async () => {
    await rendered(screenOf(), open);
    loseNextAnswer(server, 'PATCH', worktreeId, '500', { committed: true });
    server.refuseWorktreeRead = true;
    server.refuseSettingsRead = true;
    pressAdd();
    await waitFor(() => expect(server.writes('PATCH')).toHaveLength(1));
    await expire();

    const note = await screen.findByTestId('agent-instances-saved-unverified');
    expect(note.textContent).toContain(UNKNOWN);
    expect(note.textContent).not.toContain(SAVED);
    expect(screen.queryByTestId('agent-instances-error')).toBeNull();
    expect(screen.getByTestId('agent-instance-add')).toBeDisabled();
  });

  it('negative control: a refused PATCH is an error, with no unverified note', async () => {
    await rendered(screenOf(), open);
    const passOn = global.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? ({ ok: false, status: 400, json: async () => ({ error: 'bad' }) } as Response)
        : (passOn as typeof fetch)(url, init),
    ) as unknown as typeof fetch;
    pressAdd();
    await screen.findByTestId('agent-instances-error');
    expect(screen.queryByTestId('agent-instances-saved-unverified')).toBeNull();
  });
});
