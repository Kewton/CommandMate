/**
 * Issue #4132: a role chosen in the roster pane (PC and phone render the same section)
 * applies to the roster it was chosen from.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { InstanceRolesSection } from '@/components/roles/InstanceRolesSection';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { clearRosterSnapshot, getRosterSnapshot } from '@/hooks/useInstanceRoleSettings';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { FakeRoleServer, REVIEWER } from './fake-role-server';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

const WT = 'wt-4132-pane';
const CLAUDE: AgentInstance = { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 };
const CODEX: AgentInstance = { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 };

describe('[#4132] the role of a session, and the roster it was read with', () => {
  let server: FakeRoleServer;
  const select = (id: string) => screen.getByTestId(`instance-role-select-${id}`) as HTMLSelectElement;

  beforeEach(async () => {
    server = new FakeRoleServer([CLAUDE, CODEX]);
    global.fetch = server.fetch as unknown as typeof fetch;
    clearRosterSnapshot(WT);
    render(
      <ConfirmProvider>
        <InstanceRolesSection worktreeId={WT} rosterKey="k" />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByTestId('instance-roles-toggle'));
    await screen.findByTestId('instance-role-select-codex');
    await waitFor(() => expect(within(select('codex')).getByText(REVIEWER.name)).toBeInTheDocument());
  });
  afterEach(() => {
    clearRosterSnapshot(WT);
    vi.restoreAllMocks();
  });

  it('sends the revision of the rows on screen', async () => {
    fireEvent.change(select('codex'), { target: { value: 'none' } });
    await waitFor(() => expect(select('codex').value).toBe('none'));
    expect(server.writes('PUT', '/instances/roles')).toEqual([
      { instanceId: 'codex', role: { state: 'none' }, expectedRosterRevision: 'rev-1' },
    ]);
    expect(screen.queryByTestId('instance-role-error-codex')).toBeNull();
  });

  it('positive: the roster moved after the read: nothing saved, it says so, and the rows follow', async () => {
    server.changeRosterElsewhere([CLAUDE, { ...CODEX, alias: 'Moved' }]);
    fireEvent.change(select('codex'), { target: { value: 'none' } });

    const error = await screen.findByTestId('instance-role-error-codex');
    expect(error.textContent).toContain('名簿');
    expect(server.stored.codex).toBeUndefined();
    expect(select('codex').value).toBe('inherit');
    await waitFor(() => expect(screen.getByTestId('instance-role-row-codex').textContent).toContain('Moved'));
    expect(getRosterSnapshot(WT)?.revision).toBe('rev-2');

    // What is on screen is current now, so choosing again goes through.
    fireEvent.change(select('codex'), { target: { value: 'none' } });
    await waitFor(() => expect(server.stored.codex).toEqual({ state: 'none' }));
    await waitFor(() => expect(screen.queryByTestId('instance-role-error-codex')).toBeNull());
  });

  it('negative: another refusal keeps its own message', async () => {
    const passOn = global.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? ({ ok: false, status: 404, json: async () => ({ success: false, error: 'not_found', message: 'x' }) } as Response)
        : (passOn as typeof fetch)(url, init),
    ) as unknown as typeof fetch;
    fireEvent.change(select('codex'), { target: { value: 'none' } });
    const error = await screen.findByTestId('instance-role-error-codex');
    expect(error.textContent).not.toContain('名簿');
  });
});
