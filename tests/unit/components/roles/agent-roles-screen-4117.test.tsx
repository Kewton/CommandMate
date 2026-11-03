/**
 * Roles on the worktree screen (Issue #4117), from the parents down: the desktop
 * header's "+", the roster pane and the split header on PC, and the Tools tab's
 * `NotesAndLogsPane` on a phone. Responses have the shapes of the role API examples.
 *
 * Positive controls: everything about POST, the revision and the role section fails
 * on the code before this Issue. Negative controls: with no role settings readable the
 * "+" and the pane write the old PATCH with no condition.
 *
 * @vitest-environment jsdom
 */

import React, { useState } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { AgentAddMenu } from '@/components/worktree/AgentAddMenu';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { NotesAndLogsPane } from '@/components/worktree/NotesAndLogsPane';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { SplitRoleStatus } from '@/components/roles/SplitRoleStatus';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { enqueueRosterWrite } from '@/hooks/useAgentInstancesRoster';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import { FakeRoleServer, MARKETER, REVIEWER, launched } from './fake-role-server';

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
  worktreeId = `w-4117-${seq}`;
  server = new FakeRoleServer(INITIAL);
  global.fetch = server.fetch as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

/** The PC screen's relevant part: the header, the roster pane, one split. */
function Desktop({ onAdded, onEndSession }: { onAdded?: (i: AgentInstance) => void; onEndSession?: () => void }) {
  const [instances, setInstances] = useState<AgentInstance[]>(INITIAL);
  return (
    <ConfirmProvider>
      <DesktopHeader
        worktreeName="feature/4117"
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
      <TerminalSplitPane
        worktreeId={worktreeId}
        splitIndex={0}
        cliToolId="claude"
        instanceId="claude"
        instance={instances[0]}
        availableInstances={instances}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        status="ready"
        onEndSession={onEndSession}
        roleStatus={
          <SplitRoleStatus
            worktreeId={worktreeId}
            instanceId="claude"
            splitIndex={0}
            sessionStatus="ready"
            isRunning={onEndSession !== undefined}
            onRestart={onEndSession}
          />
        }
        terminal={<div />}
        footer={<div />}
      />
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

async function openAdd(): Promise<void> {
  fireEvent.click(screen.getByTestId('agent-add-button'));
  await waitFor(() => expect(screen.getByTestId('agent-add-tool')).not.toBeDisabled());
}

function select(testId: string): HTMLSelectElement {
  return screen.getByTestId(testId) as HTMLSelectElement;
}

function selectedLabel(testId: string): string {
  const element = select(testId);
  return element.options[element.selectedIndex].text;
}

describe('[#4117] the add dialog', () => {
  it('shows each tool its default and where it comes from', async () => {
    render(<Desktop />);
    await openAdd();
    expect(selectedLabel('agent-add-role')).toBe('既定（マーケター）');
    expect(screen.getByTestId('agent-add-role-source').textContent).toBe('継承中: マーケター［システム］');

    fireEvent.change(select('agent-add-tool'), { target: { value: 'codex' } });
    expect(selectedLabel('agent-add-role')).toBe('既定（レビュー担当）');
    expect(screen.getByTestId('agent-add-role-source').textContent).toBe('継承中: レビュー担当［リポジトリ］');

    fireEvent.change(select('agent-add-tool'), { target: { value: 'opencode' } });
    expect(selectedLabel('agent-add-role')).toBe('既定（なし）');
    expect(screen.getByTestId('agent-add-role-source').textContent).toBe('継承中: なし［リポジトリで明示］');
    expect(screen.getByTestId('agent-add-form').textContent).toContain('ペルソナ');

    fireEvent.change(select('agent-add-tool'), { target: { value: 'copilot' } });
    expect(screen.getByTestId('agent-add-role-source').textContent).toBe('継承中: なし［既定なし］');
  });

  it('gives the reason when the membership or the settings leave it open', async () => {
    render(<Desktop />);
    await openAdd();
    fireEvent.change(select('agent-add-tool'), { target: { value: 'command-code' } });
    const text = screen.getByTestId('agent-add-role-source').textContent ?? '';
    expect(text).toContain('複数のリポジトリで設定が異なります');
    expect(text).toContain('/repos/app-wt');
  });

  it('offers no role on a tool outside the roles', async () => {
    render(<Desktop />);
    await openAdd();
    fireEvent.change(select('agent-add-tool'), { target: { value: 'gemini' } });
    expect(select('agent-add-role')).toBeDisabled();
    expect(screen.getByTestId('agent-add-role-unsupported')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-add-submit'));
    await waitFor(() => expect(server.writes('POST', '/instances/roles')).toHaveLength(1));
    expect(server.writes('POST', '/instances/roles')[0].role).toEqual({ state: 'inherit' });
  });

  it('warns that a tool whose adapter is off refuses a resolved role', async () => {
    render(<Desktop />);
    await openAdd();
    fireEvent.change(select('agent-add-tool'), { target: { value: 'antigravity' } });
    expect(screen.getByTestId('agent-add-role-adapter-off')).toBeInTheDocument();
  });

  it('creates through the role route, with the role and the revision it read', async () => {
    const onAdded = vi.fn();
    render(<Desktop onAdded={onAdded} />);
    await openAdd();
    fireEvent.change(select('agent-add-role'), { target: { value: REVIEWER.id } });
    fireEvent.change(screen.getByTestId('agent-add-name'), { target: { value: 'レビュー' } });
    fireEvent.click(screen.getByTestId('agent-add-submit'));

    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(server.writes('POST', '/instances/roles')).toEqual([
      {
        instance: { id: 'claude-2', cliTool: 'claude', alias: 'レビュー' },
        role: { state: 'role', roleId: REVIEWER.id },
        expectedRosterRevision: 'rev-1',
      },
    ]);
    expect(server.writes('PATCH')).toEqual([]);
    expect(onAdded.mock.calls[0][0]).toMatchObject({ id: 'claude-2', alias: 'レビュー', order: 2 });
    expect(screen.getByTestId('roster').textContent).toContain('claude-2:レビュー');
    await waitFor(() => expect(screen.queryByTestId('agent-add-form')).toBeNull());
  });

  it('stays open, with what was typed, when the role cannot be saved', async () => {
    const onAdded = vi.fn();
    render(<Desktop onAdded={onAdded} />);
    await openAdd();
    fireEvent.change(screen.getByTestId('agent-add-name'), { target: { value: 'レビュー' } });
    fireEvent.change(select('agent-add-role'), { target: { value: MARKETER.id } });
    server.refuseNextCreate = { status: 404, error: 'not_found' };
    fireEvent.click(screen.getByTestId('agent-add-submit'));

    await waitFor(() => expect(screen.getByTestId('agent-add-error').textContent).toContain('見つかりません'));
    expect(screen.getByTestId('agent-add-form')).toBeInTheDocument();
    expect((screen.getByTestId('agent-add-name') as HTMLInputElement).value).toBe('レビュー');
    expect(onAdded).not.toHaveBeenCalled();
    expect(server.roster.map((i) => i.id)).toEqual(['claude', 'codex']);
  });

  it('negative control: when the settings cannot be read it adds by PATCH, with no condition', async () => {
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/settings/default-agents')) {
        return Promise.resolve({ ok: true, json: async () => ({ installed: ['claude'] }) });
      }
      return server.fetch(init?.method === 'PATCH' ? url : '/unknown', init);
    }) as unknown as typeof fetch;
    const onAdded = vi.fn();
    render(<Desktop onAdded={onAdded} />);
    await openAdd();
    expect(screen.getByTestId('agent-add-role-unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-add-submit'));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(server.writes('POST')).toEqual([]);
    expect(server.writes('PATCH')[0]).not.toHaveProperty('expectedRosterRevision');
  });
});

describe('[#4117] the queue', () => {
  it('a rename and a reorder issued while a create is saving keep the instance and its role', async () => {
    render(<Desktop />);
    await openAdd();
    fireEvent.change(select('agent-add-role'), { target: { value: REVIEWER.id } });
    server.holdWrites = true;
    fireEvent.click(screen.getByTestId('agent-add-submit'));
    await waitFor(() => expect(server.heldCount).toBe(1));

    const alias = screen.getByTestId('agent-instance-alias-codex');
    fireEvent.change(alias, { target: { value: 'Lead' } });
    fireEvent.blur(alias);
    fireEvent.keyDown(screen.getByTestId('agent-instance-menu-claude'), { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('agent-instance-move-down-claude'));

    await act(async () => server.release());
    for (let i = 0; i < 2; i += 1) {
      await waitFor(() => expect(server.heldCount).toBe(1));
      await act(async () => server.release());
    }
    server.holdWrites = false;

    await waitFor(() => expect(server.writes('PATCH')).toHaveLength(2));
    await waitFor(() => expect(server.roster.map((i) => i.id)).toEqual(['codex', 'claude', 'claude-2']));
    expect(server.roster.find((i) => i.id === 'codex')?.alias).toBe('Lead');
    expect(server.stored['claude-2']).toMatchObject({ state: 'role', roleId: REVIEWER.id });
    // Each one was sent against the revision the previous one answered.
    expect(server.writes('PATCH').map((body) => body.expectedRosterRevision)).toEqual(['rev-2', 'rev-3']);
    await waitFor(() => expect(screen.getByTestId('roster').textContent).toBe('codex:Lead,claude:Claude,claude-2:Claude 2'));
  });

  it('a stale pane save is refused, rebuilt on what is there, and loses nothing', async () => {
    render(<Desktop />);
    // The split header has read the roster, so the pane holds a revision.
    await waitFor(() => expect(server.calls.some((c) => c.url.endsWith('/instances/roles'))).toBe(true));
    await screen.findByTestId('agent-instance-alias-codex');
    await act(async () => {});

    server.changeRosterElsewhere([...INITIAL, { id: 'copilot', cliTool: 'copilot', alias: 'Copilot', order: 2 }]);
    const alias = screen.getByTestId('agent-instance-alias-codex');
    fireEvent.change(alias, { target: { value: 'Lead' } });
    fireEvent.blur(alias);

    await waitFor(() => expect(server.writes('PATCH')).toHaveLength(2));
    const [refused, retried] = server.writes('PATCH');
    expect(refused.expectedRosterRevision).toBe('rev-1');
    expect(retried.expectedRosterRevision).toBe('rev-2');
    expect(server.roster.map((i) => `${i.id}:${i.alias}`)).toEqual(['claude:Claude', 'codex:Lead', 'copilot:Copilot']);
    await waitFor(() => expect(screen.getByTestId('roster').textContent).toContain('copilot:Copilot'));
  });

  it('a create racing another writer takes a free id and keeps the other row', async () => {
    render(<Desktop />);
    await openAdd();
    server.changeRosterElsewhere([...INITIAL, { id: 'claude-2', cliTool: 'claude', alias: 'Other', order: 2 }]);
    fireEvent.click(screen.getByTestId('agent-add-submit'));
    await waitFor(() => expect(server.roster.map((i) => i.id)).toEqual(['claude', 'codex', 'claude-2', 'claude-3']));
    expect(server.writes('POST', '/instances/roles')).toHaveLength(2);
  });

  it('gives up with a failure rather than saving blind when the roster cannot be read again', async () => {
    const onSaved = vi.fn();
    const responses = [{ ok: false, status: 409, json: async () => ({}) }];
    global.fetch = vi.fn(async () => responses.shift() ?? { ok: false, status: 500, json: async () => ({}) }) as unknown as typeof fetch;
    const result = await enqueueRosterWrite(`${worktreeId}-x`, () => INITIAL, (base) => [...base], onSaved);
    expect(result).toEqual({ status: 'failed', error: 'roster_changed' });
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('negative control: with no revision known nothing extra is sent', async () => {
    const onSaved = vi.fn();
    const result = await enqueueRosterWrite(`${worktreeId}-y`, () => INITIAL, (base) => [...base], onSaved);
    expect(result.status).toBe('saved');
    expect(server.calls).toHaveLength(1);
    expect(server.writes('PATCH')[0]).toEqual({ agentInstances: INITIAL });
  });
});

describe('[#4117] the split header', () => {
  const header = () => screen.getByTestId('split-role-status-0');

  it('says nothing when no role is involved', async () => {
    server.application.claude = { effectiveNext: { kind: 'none', source: 'fallback', cliToolId: 'claude', repositoryId: null, repositoryIds: [], reason: 'no-default', injectionFingerprint: null } };
    render(<Desktop onEndSession={vi.fn()} />);
    await waitFor(() => expect(server.calls.some((c) => c.url.endsWith('/instances/roles'))).toBe(true));
    await act(async () => {});
    expect(screen.queryByTestId('split-role-status-0')).toBeNull();
  });

  it('pending: start and next apart, with the restart, which is the end-session action', async () => {
    server.application.claude = { launched: launched({ roleName: 'レビュー担当' }), restartPending: 'yes' };
    server.stored.claude = { state: 'role', roleId: MARKETER.id, roleName: 'PM' };
    const onEndSession = vi.fn();
    render(<Desktop onEndSession={onEndSession} />);
    await waitFor(() => expect(header().textContent).toBe('起動時: レビュー担当／次回: PM／適用待ち'));
    expect(header()).toHaveAttribute('data-pending', 'true');
    fireEvent.click(screen.getByTestId('split-role-restart-0'));
    expect(onEndSession).toHaveBeenCalledTimes(1);
  });

  it('unknown: never claims applied or pending when the setting has only just changed', async () => {
    server.application.claude = { launched: null, restartPending: 'unknown' };
    server.stored.claude = { state: 'role', roleId: MARKETER.id, roleName: 'PM' };
    render(<Desktop onEndSession={vi.fn()} />);
    await waitFor(() => expect(header().textContent).toBe('起動時: 不明／次回: PM'));
    expect(header()).not.toHaveAttribute('data-pending');
    expect(document.body.textContent).not.toContain('適用済み');
    expect(document.body.textContent).not.toContain('適用待ち');
  });

  it('settled: only what it was started with', async () => {
    server.application.claude = { launched: launched({ roleName: 'PM' }), restartPending: 'no' };
    render(<Desktop onEndSession={vi.fn()} />);
    await waitFor(() => expect(header().textContent).toBe('起動時: PM'));
    expect(screen.queryByTestId('split-role-restart-0')).toBeNull();
  });

  it('no session: only what the next start would use', async () => {
    render(<Desktop />);
    await waitFor(() => expect(header().textContent).toBe('次回: マーケター'));
    expect(screen.queryByTestId('split-role-restart-0')).toBeNull();
  });
});

describe('[#4117] the roster pane on PC', () => {
  it('reads nothing about roles until opened (#2054)', async () => {
    render(
      <AgentInstancesPane
        worktreeId={worktreeId}
        instances={INITIAL}
        onInstancesChange={vi.fn()}
        vibeLocalModel={null}
        onVibeLocalModelChange={vi.fn()}
      />,
    );
    await act(async () => {});
    expect(server.calls.filter((c) => !c.url.startsWith('/api/relays'))).toEqual([]);
    fireEvent.click(screen.getByTestId('instance-roles-toggle'));
    await screen.findByTestId('instance-role-select-claude');
  });

  it('a change shows in the split header at once, without saying it applied', async () => {
    server.application.claude = { launched: launched({ roleName: 'PM' }), restartPending: 'no' };
    render(<Desktop onEndSession={vi.fn()} />);
    fireEvent.click(screen.getByTestId('instance-roles-toggle'));
    await screen.findByTestId('instance-role-select-claude');
    server.application.claude = { launched: launched({ roleName: 'PM' }), restartPending: 'yes' };
    await waitFor(() => expect(within(select('instance-role-select-claude')).getByText(REVIEWER.name)).toBeInTheDocument());
    fireEvent.change(select('instance-role-select-claude'), { target: { value: REVIEWER.id } });
    await waitFor(() =>
      expect(screen.getByTestId('split-role-status-0').textContent).toBe('起動時: PM／次回: レビュー担当／適用待ち'),
    );
  });
});

describe('[#4117] on a phone, through the Tools tab', () => {
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

  async function openRoles(): Promise<void> {
    const agentTab = screen.queryByTestId('instance-roles-toggle')
      ? null
      : screen.getAllByRole('button').find((button) => /agent|エージェント/i.test(button.textContent ?? ''));
    if (agentTab) fireEvent.click(agentTab);
    fireEvent.click(await screen.findByTestId('instance-roles-toggle'));
  }

  it('sets inherit, none and a role on a derived primary without saving a roster', async () => {
    server.rosterSaved = false;
    render(<Phone />);
    await openRoles();
    await screen.findByTestId('instance-role-select-claude');
    await waitFor(() => expect(within(select('instance-role-select-claude')).getByText(MARKETER.name)).toBeInTheDocument());
    expect(screen.getByTestId('instance-role-source-claude').textContent).toBe('継承中: マーケター［システム］');
    expect(selectedLabel('instance-role-select-claude')).toBe('既定（マーケター［システム］）');

    fireEvent.change(select('instance-role-select-claude'), { target: { value: 'none' } });
    await waitFor(() =>
      expect(screen.getByTestId('instance-role-source-claude').textContent).toBe('指定中: なし［このセッションで明示］'),
    );

    fireEvent.change(select('instance-role-select-claude'), { target: { value: REVIEWER.id } });
    await waitFor(() =>
      expect(screen.getByTestId('instance-role-source-claude').textContent).toBe('指定中: レビュー担当［このセッション］'),
    );

    fireEvent.change(select('instance-role-select-claude'), { target: { value: 'inherit' } });
    await waitFor(() =>
      expect(screen.getByTestId('instance-role-source-claude').textContent).toBe('継承中: マーケター［システム］'),
    );
    expect(server.writes('PUT', '/instances/roles').map((body) => body.role)).toEqual([
      { state: 'none' },
      { state: 'role', roleId: REVIEWER.id },
      { state: 'inherit' },
    ]);
    expect(server.writes('PATCH')).toEqual([]);
    expect(server.rosterSaved).toBe(false);
  });

  it('holds the revision without opening anything, so a rename is checked', async () => {
    render(<Phone />);
    const agentTab = screen.queryByTestId('agent-instance-alias-codex')
      ? null
      : screen.getAllByRole('button').find((button) => /agent|エージェント/i.test(button.textContent ?? ''));
    if (agentTab) fireEvent.click(agentTab);
    const alias = await screen.findByTestId('agent-instance-alias-codex');
    await waitFor(() => expect(server.calls.some((c) => c.url.endsWith('/instances/roles'))).toBe(true));
    await act(async () => {});
    fireEvent.change(alias, { target: { value: 'Lead' } });
    fireEvent.blur(alias);
    await waitFor(() => expect(server.writes('PATCH')).toHaveLength(1));
    expect(server.writes('PATCH')[0].expectedRosterRevision).toBe('rev-1');
  });

  it('offers the restart with both of its scopes, and shows a failed save', async () => {
    server.running.claude = true;
    server.application.claude = { launched: launched({ roleName: 'PM' }), restartPending: 'yes' };
    render(<Phone />);
    await openRoles();
    fireEvent.click(await screen.findByTestId('instance-role-restart-claude'));
    expect(server.calls.some((c) => c.url.includes('/kill-session'))).toBe(false);
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(server.calls.some((c) => c.url.includes('/kill-session'))).toBe(true));
    const kill = server.calls.find((c) => c.url.includes('/kill-session'));
    expect(kill?.url).toContain('cliTool=claude');
    expect(kill?.url).toContain('instance=claude');

    server.refusePut = true;
    fireEvent.change(select('instance-role-select-claude'), { target: { value: 'none' } });
    await screen.findByTestId('instance-role-error-claude');
    expect(select('instance-role-select-claude').value).toBe('inherit');
  });

  it('a tool outside the roles has no selector', async () => {
    server.roster = [...INITIAL, { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 2 }];
    render(<Phone />);
    await openRoles();
    await screen.findByTestId('instance-role-unsupported-gemini');
    expect(screen.queryByTestId('instance-role-select-gemini')).toBeNull();
  });
});
