/**
 * Roles in the settings and the repository list (Issue #4117), through the sections
 * the PC dialog and `/more` mount.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SettingsGeneralSection } from '@/components/settings';
import { RepositoryList } from '@/components/repository/RepositoryList';
import { InstanceRolesSection } from '@/components/roles/InstanceRolesSection';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { repositoryApi, type RepositoryListItem } from '@/lib/api-client';
import { roleEditExample } from '@tests/integration/fixtures/agent-roles-api-examples';
import { FakeRoleServer, MARKETER, REVIEWER, loseNextAnswer } from './fake-role-server';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

let server: FakeRoleServer;

beforeEach(() => {
  server = new FakeRoleServer([]);
  global.fetch = server.fetch as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

function field(testId: string): HTMLInputElement & HTMLSelectElement {
  return screen.getByTestId(testId) as HTMLInputElement & HTMLSelectElement;
}

describe('[#4117] roles in the settings', () => {
  async function renderSettings(): Promise<void> {
    render(<SettingsGeneralSection />);
    await screen.findByTestId(`agent-role-row-${MARKETER.id}`);
  }

  it('creates a role with a multi-line body, and the list and the default options follow', async () => {
    await renderSettings();
    fireEvent.click(screen.getByTestId('agent-role-new'));
    fireEvent.change(field('agent-role-create-name'), { target: { value: 'PM' } });
    fireEvent.change(field('agent-role-create-body'), { target: { value: '一行目\n二行目' } });
    expect(screen.getByTestId('agent-role-create-bytes').textContent).toContain('19');
    fireEvent.click(screen.getByTestId('agent-role-create-submit'));

    await waitFor(() => expect(screen.getAllByText('PM').length).toBeGreaterThan(0));
    expect(server.writes('POST', '/api/roles')).toEqual([{ name: 'PM', body: '一行目\n二行目' }]);
    expect(within(screen.getByTestId('agent-role-system-default-claude')).getByText('PM')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-role-create-form')).toBeNull();
  });

  it('keeps the form with its message when the name is taken', async () => {
    await renderSettings();
    fireEvent.click(screen.getByTestId('agent-role-new'));
    fireEvent.change(field('agent-role-create-name'), { target: { value: MARKETER.name } });
    fireEvent.change(field('agent-role-create-body'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('agent-role-create-submit'));
    await waitFor(() => expect(screen.getByTestId('agent-role-create-error').textContent).toContain('同じ名前'));
    expect(field('agent-role-create-name').value).toBe(MARKETER.name);
  });

  it('refuses a body over the limit before sending it', async () => {
    await renderSettings();
    fireEvent.click(screen.getByTestId('agent-role-new'));
    fireEvent.change(field('agent-role-create-name'), { target: { value: 'big' } });
    fireEvent.change(field('agent-role-create-body'), { target: { value: 'あ'.repeat(6000) } });
    expect(screen.getByTestId('agent-role-create-submit')).toBeDisabled();
  });

  it('edits against the version it read, and says what the edit reaches', async () => {
    await renderSettings();
    fireEvent.click(screen.getByTestId(`agent-role-edit-${MARKETER.id}`));
    await waitFor(() => expect(field('agent-role-edit-body').value).toBe('あなたはマーケターです。'));
    fireEvent.change(field('agent-role-edit-name'), { target: { value: '新しい名前' } });
    fireEvent.change(field('agent-role-edit-body'), { target: { value: '新しい本文' } });
    fireEvent.click(screen.getByTestId('agent-role-edit-submit'));

    await waitFor(() => expect(screen.getByTestId(`agent-role-row-${MARKETER.id}`).textContent).toContain('新しい名前'));
    expect(server.writes('PUT', `/api/roles/${MARKETER.id}`)).toEqual([
      { name: '新しい名前', body: '新しい本文', expectedBodyVersion: MARKETER.bodyVersion },
    ]);
    const { instances, repositories, system } = roleEditExample.affected;
    expect(screen.getByTestId('agent-roles-notice').textContent).toContain(
      String(instances.length + repositories.length + system.length),
    );
    expect(screen.getByTestId('agent-roles-notice').textContent).toContain('次の起動から');
  });

  it('shows a stale edit as such', async () => {
    await renderSettings();
    fireEvent.click(screen.getByTestId(`agent-role-edit-${MARKETER.id}`));
    await waitFor(() => expect(field('agent-role-edit-body').value).not.toBe(''));
    server.roles = server.roles.map((role) => (role.id === MARKETER.id ? { ...role, bodyVersion: 99 } : role));
    fireEvent.change(field('agent-role-edit-body'), { target: { value: '古い画面からの本文' } });
    fireEvent.click(screen.getByTestId('agent-role-edit-submit'));
    await waitFor(() => expect(screen.getByTestId('agent-role-edit-error').textContent).toContain('別の場所'));
    expect(server.bodies[MARKETER.id]).not.toBe('古い画面からの本文');
  });

  describe('sends only what the form changed', () => {
    async function openEdit(): Promise<void> {
      await renderSettings();
      fireEvent.click(screen.getByTestId(`agent-role-edit-${MARKETER.id}`));
      await waitFor(() => expect(field('agent-role-edit-body').value).not.toBe(''));
    }
    const renameElsewhere = (name: string): void => {
      server.roles = server.roles.map((role) => (role.id === MARKETER.id ? { ...role, name } : role));
    };
    const puts = () => server.writes('PUT', `/api/roles/${MARKETER.id}`);

    it('a body save from a form opened before a rename elsewhere keeps that rename', async () => {
      await openEdit();
      renameElsewhere('別の画面の名前');
      fireEvent.change(field('agent-role-edit-body'), { target: { value: '新しい本文' } });
      fireEvent.click(screen.getByTestId('agent-role-edit-submit'));
      await waitFor(() => expect(puts()).toHaveLength(1));
      expect(puts()[0]).toEqual({ body: '新しい本文', expectedBodyVersion: MARKETER.bodyVersion });
      await waitFor(() => expect(screen.getByTestId(`agent-role-row-${MARKETER.id}`).textContent).toContain('別の画面の名前'));
      expect(server.bodies[MARKETER.id]).toBe('新しい本文');
    });

    it('a rename does not send the body or its version, and does not move the version', async () => {
      await openEdit();
      fireEvent.change(field('agent-role-edit-name'), { target: { value: '新しい名前' } });
      fireEvent.click(screen.getByTestId('agent-role-edit-submit'));
      await waitFor(() => expect(puts()).toEqual([{ name: '新しい名前' }]));
      expect(server.roles.find((role) => role.id === MARKETER.id)?.bodyVersion).toBe(MARKETER.bodyVersion);
    });

    it('a rename over a rename elsewhere is refused before it is sent', async () => {
      await openEdit();
      renameElsewhere('別の画面の名前');
      fireEvent.change(field('agent-role-edit-name'), { target: { value: '新しい名前' } });
      fireEvent.click(screen.getByTestId('agent-role-edit-submit'));
      await waitFor(() => expect(screen.getByTestId('agent-role-edit-error').textContent).toContain('別の場所'));
      expect(puts()).toEqual([]);
      expect(server.roles.find((role) => role.id === MARKETER.id)?.name).toBe('別の画面の名前');
    });

    it('name and body together over a body edit elsewhere change nothing', async () => {
      await openEdit();
      server.roles = server.roles.map((role) => (role.id === MARKETER.id ? { ...role, bodyVersion: 99 } : role));
      fireEvent.change(field('agent-role-edit-name'), { target: { value: '新しい名前' } });
      fireEvent.change(field('agent-role-edit-body'), { target: { value: '新しい本文' } });
      fireEvent.click(screen.getByTestId('agent-role-edit-submit'));
      await waitFor(() => expect(screen.getByTestId('agent-role-edit-error').textContent).toContain('別の場所'));
      expect(server.roles.find((role) => role.id === MARKETER.id)?.name).toBe(MARKETER.name);
    });

    it('negative control: nothing changed sends nothing and closes the form', async () => {
      await openEdit();
      fireEvent.click(screen.getByTestId('agent-role-edit-submit'));
      await waitFor(() => expect(screen.queryByTestId('agent-role-edit-form')).toBeNull());
      expect(puts()).toEqual([]);
    });
  });

  it('a read that left first and answers last does not put back the older list', async () => {
    let release: () => void = () => {};
    let held = false;
    const real = server.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const answer = await real(url, init);
      if (url === '/api/roles' && !init?.method && !held) {
        held = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return answer;
    }) as unknown as typeof fetch;
    render(<SettingsGeneralSection />);
    await waitFor(() => expect(held).toBe(true));

    fireEvent.click(screen.getByTestId('agent-role-new'));
    fireEvent.change(field('agent-role-create-name'), { target: { value: 'PM' } });
    fireEvent.change(field('agent-role-create-body'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('agent-role-create-submit'));
    await waitFor(() => expect(screen.getAllByText('PM').length).toBeGreaterThan(0));

    await act(async () => release());
    await act(async () => {});
    expect(screen.getAllByText('PM').length).toBeGreaterThan(0);
  });

  it('a role in use lists what the 409 says, and goes only on the second decision', async () => {
    server.references[MARKETER.id] = roleEditExample.affected;
    server.system.claude = { state: 'role', roleId: MARKETER.id, roleName: MARKETER.name };
    await renderSettings();
    await waitFor(() => expect(field('agent-role-system-default-claude').value).toBe(MARKETER.id));

    fireEvent.click(screen.getByTestId(`agent-role-delete-${MARKETER.id}`));
    expect(server.writes('DELETE')).toEqual([]);
    fireEvent.click(screen.getByTestId(`agent-role-delete-confirm-${MARKETER.id}`));

    const list = await screen.findByTestId('agent-role-references');
    expect(list.textContent).toContain('wt-1');
    expect(list.textContent).toContain('codex-2');
    expect(list.textContent).toContain('/repos/app');
    expect(list.textContent).toContain('Claude');
    expect(server.roles.some((role) => role.id === MARKETER.id)).toBe(true);

    fireEvent.click(screen.getByTestId(`agent-role-force-delete-${MARKETER.id}`));
    await waitFor(() => expect(screen.queryByTestId(`agent-role-row-${MARKETER.id}`)).toBeNull());
    expect(server.calls.some((call) => call.method === 'DELETE' && call.url.includes('force=true'))).toBe(true);
    // The default that pointed at it follows.
    await waitFor(() => expect(field('agent-role-system-default-claude').value).toBe(''));
  });

  it('a role in no use goes on the first decision', async () => {
    await renderSettings();
    fireEvent.click(screen.getByTestId(`agent-role-delete-${REVIEWER.id}`));
    fireEvent.click(screen.getByTestId(`agent-role-delete-confirm-${REVIEWER.id}`));
    await waitFor(() => expect(screen.queryByTestId(`agent-role-row-${REVIEWER.id}`)).toBeNull());
    expect(server.calls.some((call) => call.url.includes('force=true'))).toBe(false);
  });

  it('sets and clears the system default, and has no "none" there', async () => {
    await renderSettings();
    const select = () => field('agent-role-system-default-claude');
    await waitFor(() => expect(within(select()).getByText(REVIEWER.name)).toBeInTheDocument());
    expect(within(select()).queryByText('なし')).toBeNull();
    fireEvent.change(select(), { target: { value: REVIEWER.id } });
    await waitFor(() => expect(select().value).toBe(REVIEWER.id));
    fireEvent.change(select(), { target: { value: '' } });
    await waitFor(() => expect(select().value).toBe(''));
    expect(server.writes('PUT', '/agent-role-defaults').map((body) => body.roleId)).toEqual([REVIEWER.id, null]);
  });

  it('a role change whose system defaults cannot be read back says it could not read', async () => {
    await renderSettings();
    const real = server.fetch;
    global.fetch = vi.fn((url: string, init?: RequestInit) =>
      url === '/api/settings/agent-role-defaults' && !init?.method
        ? Promise.resolve({ ok: false, status: 500, json: async () => ({ success: false, error: 'internal_error' }) })
        : real(url, init),
    ) as unknown as typeof fetch;
    fireEvent.click(screen.getByTestId(`agent-role-delete-${REVIEWER.id}`));
    fireEvent.click(screen.getByTestId(`agent-role-delete-confirm-${REVIEWER.id}`));
    await waitFor(() => expect(screen.getByTestId('agent-roles-load-error')).toBeInTheDocument());
    expect(screen.getByTestId('agent-roles-notice')).toBeInTheDocument();
  });

  it('explains how a role differs from an OpenCode persona', async () => {
    await renderSettings();
    expect(screen.getByTestId('agent-roles-persona-note').textContent).toContain('ペルソナ');
  });
});

describe('[#4117] a change in the settings reaches what is open elsewhere', () => {
  const REPO: RepositoryListItem = {
    id: 'repo-1',
    name: 'app',
    displayName: null,
    path: '/repos/app',
    enabled: true,
    visible: true,
    worktreeCount: 1,
  };
  const INSTANCES = [{ id: 'claude', cliTool: 'claude' as const, alias: 'Claude', order: 0 }];
  const select = () => field('repository-role-select-repo-1-claude');
  const source = () => screen.getByTestId('repository-role-source-repo-1-claude').textContent;
  let worktreeSeq = 0;

  async function renderAll(): Promise<void> {
    server.roster = INSTANCES;
    worktreeSeq += 1;
    vi.spyOn(repositoryApi, 'list').mockResolvedValue({ success: true, repositories: [REPO] } as never);
    render(
      <ConfirmProvider>
        <SettingsGeneralSection />
        <RepositoryList refreshKey={0} />
        <InstanceRolesSection worktreeId={`w-4117-settings-${worktreeSeq}`} rosterKey="claude" />
      </ConfirmProvider>,
    );
    await screen.findByTestId(`agent-role-row-${MARKETER.id}`);
    fireEvent.click(await screen.findByTestId('repository-roles-toggle-repo-1'));
    fireEvent.click(screen.getByTestId('instance-roles-toggle'));
    await waitFor(() => expect(within(select()).getByText(REVIEWER.name)).toBeInTheDocument());
    await waitFor(() =>
      expect(within(field('instance-role-select-claude')).getByText(REVIEWER.name)).toBeInTheDocument(),
    );
  }

  it('a forced delete: the open repository and session go back to inherit', async () => {
    server.repositoryStored.claude = { state: 'role', roleId: REVIEWER.id, roleName: REVIEWER.name };
    server.stored.claude = { state: 'role', roleId: REVIEWER.id, roleName: REVIEWER.name };
    server.references[REVIEWER.id] = roleEditExample.affected;
    await renderAll();
    await waitFor(() => expect(source()).toBe('指定中: レビュー担当［リポジトリ］'));

    fireEvent.click(screen.getByTestId(`agent-role-delete-${REVIEWER.id}`));
    fireEvent.click(screen.getByTestId(`agent-role-delete-confirm-${REVIEWER.id}`));
    fireEvent.click(await screen.findByTestId(`agent-role-force-delete-${REVIEWER.id}`));

    await waitFor(() => expect(source()).toBe('継承中: マーケター［システム］'));
    expect(select().value).toBe('inherit');
    expect(within(select()).queryByText(REVIEWER.name)).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('instance-role-source-claude').textContent).toBe('継承中: マーケター［システム］'),
    );
    expect(within(field('instance-role-select-claude')).queryByText(REVIEWER.name)).toBeNull();
  });

  it('a system default: what inherits it, in the repository and the session, names the new one', async () => {
    await renderAll();
    await waitFor(() => expect(source()).toBe('継承中: マーケター［システム］'));
    fireEvent.change(field('agent-role-system-default-claude'), { target: { value: REVIEWER.id } });
    await waitFor(() => expect(source()).toBe('継承中: レビュー担当［システム］'));
    await waitFor(() =>
      expect(screen.getByTestId('instance-role-source-claude').textContent).toBe('継承中: レビュー担当［システム］'),
    );
  });

  it('a rename and a new role: the open selectors follow', async () => {
    server.repositoryStored.claude = { state: 'role', roleId: REVIEWER.id, roleName: REVIEWER.name };
    await renderAll();
    await waitFor(() => expect(source()).toBe('指定中: レビュー担当［リポジトリ］'));

    fireEvent.click(screen.getByTestId(`agent-role-edit-${REVIEWER.id}`));
    await waitFor(() => expect(field('agent-role-edit-name').value).toBe(REVIEWER.name));
    fireEvent.change(field('agent-role-edit-name'), { target: { value: '校閲' } });
    fireEvent.click(screen.getByTestId('agent-role-edit-submit'));
    await waitFor(() => expect(source()).toBe('指定中: 校閲［リポジトリ］'));
    await waitFor(() => expect(within(field('instance-role-select-claude')).getByText('校閲')).toBeInTheDocument());
  });

  it('coming back from another tab reads the open repository again', async () => {
    await renderAll();
    await waitFor(() => expect(source()).toBe('継承中: マーケター［システム］'));
    server.repositoryStored.claude = { state: 'none' };
    await act(async () => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(source()).toBe('指定中: なし［リポジトリで明示］'));
  });

  it('a change whose reads afterwards fail: the open session says so, and the repository says it could not read', async () => {
    await renderAll();
    await waitFor(() => expect(source()).toBe('継承中: マーケター［システム］'));
    server.refuseSettingsRead = true;
    const real = server.fetch;
    global.fetch = vi.fn((url: string, init?: RequestInit) =>
      String(url).endsWith('/role-defaults') && !init?.method
        ? Promise.resolve({ ok: false, status: 500, json: async () => ({ success: false, error: 'internal_error' }) })
        : real(url, init),
    ) as unknown as typeof fetch;
    fireEvent.change(field('agent-role-system-default-claude'), { target: { value: REVIEWER.id } });
    await waitFor(() => expect(screen.getByTestId('instance-roles-stale')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('repository-roles-error-repo-1')).toBeInTheDocument());
    expect(server.system.claude).toMatchObject({ state: 'role', roleId: REVIEWER.id });
    expect(screen.queryByTestId('agent-roles-default-error')).toBeNull();
  });

  it('a repository save a read overtook, whose read afterwards fails: says to reload, with no save error', async () => {
    await renderAll();
    await waitFor(() => expect(source()).toBe('継承中: マーケター［システム］'));
    let releasePut: () => void = () => {};
    let refuse = false;
    const real = server.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (refuse && String(url).endsWith('/role-defaults') && !init?.method) {
        return { ok: false, status: 500, json: async () => ({ success: false, error: 'internal_error' }) };
      }
      const answer = await real(url, init);
      if (String(url).endsWith('/role-defaults') && init?.method === 'PUT') {
        await new Promise<void>((resolve) => {
          releasePut = resolve;
        });
      }
      return answer;
    }) as unknown as typeof fetch;
    fireEvent.change(select(), { target: { value: 'none' } });
    await waitFor(() => expect(server.writes('PUT', '/role-defaults')).toHaveLength(1));
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => {});
    refuse = true;
    await act(async () => releasePut());
    await waitFor(() => expect(screen.getByTestId('repository-roles-stale-repo-1').textContent).toContain('再読み込み'));
    expect(screen.queryByTestId('repository-roles-save-error-repo-1')).toBeNull();

    // A refused save says nothing new about what is shown, so the warning stays.
    refuse = false;
    global.fetch = vi.fn((url: string, init?: RequestInit) =>
      String(url).endsWith('/role-defaults') && init?.method === 'PUT'
        ? Promise.resolve({ ok: false, status: 400, json: async () => ({ success: false, error: 'internal_error' }) })
        : real(url, init),
    ) as unknown as typeof fetch;
    fireEvent.change(select(), { target: { value: REVIEWER.id } });
    await screen.findByTestId('repository-roles-save-error-repo-1');
    expect(screen.getByTestId('repository-roles-stale-repo-1')).toBeInTheDocument();

    // A save whose answer is taken is the current state: the warning goes.
    global.fetch = real as unknown as typeof fetch;
    fireEvent.change(select(), { target: { value: REVIEWER.id } });
    await waitFor(() => expect(source()).toBe('指定中: レビュー担当［リポジトリ］'));
    expect(screen.queryByTestId('repository-roles-stale-repo-1')).toBeNull();
  });

  it('a read that left before a repository save does not put the old value back', async () => {
    await renderAll();
    await waitFor(() => expect(source()).toBe('継承中: マーケター［システム］'));
    let release: () => void = () => {};
    let held = false;
    const real = server.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const answer = await real(url, init);
      if (String(url).endsWith('/role-defaults') && !init?.method && !held) {
        held = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return answer;
    }) as unknown as typeof fetch;
    await act(async () => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(held).toBe(true));
    fireEvent.change(select(), { target: { value: 'none' } });
    await waitFor(() => expect(source()).toBe('指定中: なし［リポジトリで明示］'));
    await act(async () => release());
    await act(async () => {});
    expect(source()).toBe('指定中: なし［リポジトリで明示］');
  });

  it('a save that a read overtook reads again, so it does not show the value from before it', async () => {
    await renderAll();
    await waitFor(() => expect(source()).toBe('継承中: マーケター［システム］'));
    server.holdPutAnswers = false;
    let releasePut: () => void = () => {};
    const real = server.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const answer = await real(url, init);
      if (String(url).endsWith('/role-defaults') && init?.method === 'PUT') {
        await new Promise<void>((resolve) => {
          releasePut = resolve;
        });
      }
      return answer;
    }) as unknown as typeof fetch;
    fireEvent.change(select(), { target: { value: 'none' } });
    await waitFor(() => expect(server.writes('PUT', '/role-defaults')).toHaveLength(1));
    await act(async () => window.dispatchEvent(new Event('focus')));
    server.repositoryStored.claude = { state: 'role', roleId: REVIEWER.id, roleName: REVIEWER.name };
    await act(async () => releasePut());
    await waitFor(() => expect(source()).toBe('指定中: レビュー担当［リポジトリ］'));
  });
});

describe('[#4117] a role write whose answer was lost', () => {
  const REPO: RepositoryListItem = {
    id: 'repo-1',
    name: 'app',
    displayName: null,
    path: '/repos/app',
    enabled: true,
    visible: true,
    worktreeCount: 1,
  };
  const INSTANCES = [{ id: 'claude', cliTool: 'claude' as const, alias: 'Claude', order: 0 }];
  let seq = 0;
  const reads = (pathEnd: string) => server.calls.filter((c) => c.method === 'GET' && c.url.endsWith(pathEnd)).length;

  async function renderAll(): Promise<void> {
    server.roster = INSTANCES;
    seq += 1;
    vi.spyOn(repositoryApi, 'list').mockResolvedValue({ success: true, repositories: [REPO] } as never);
    render(
      <ConfirmProvider>
        <SettingsGeneralSection />
        <RepositoryList refreshKey={0} />
        <InstanceRolesSection worktreeId={`w-4117-lost-${seq}`} rosterKey="claude" />
      </ConfirmProvider>,
    );
    await screen.findByTestId(`agent-role-row-${MARKETER.id}`);
    fireEvent.click(await screen.findByTestId('repository-roles-toggle-repo-1'));
    fireEvent.click(screen.getByTestId('instance-roles-toggle'));
    await waitFor(() => expect(within(field('repository-role-select-repo-1-claude')).getByText(REVIEWER.name)).toBeInTheDocument());
    await waitFor(() => expect(within(field('instance-role-select-claude')).getByText(REVIEWER.name)).toBeInTheDocument());
  }

  describe.each([
    ['it happened', true],
    ['it did not', false],
  ])('%s', (_label, committed) => {
    it('a session\'s role: the row shows what was read, and says it could not tell', async () => {
      await renderAll();
      loseNextAnswer(server, 'PUT', '/instances/roles', '500', { committed });
      fireEvent.change(field('instance-role-select-claude'), { target: { value: 'none' } });
      await waitFor(() => expect(screen.getByTestId('instance-role-error-claude').textContent).toContain('確かめられません'));
      await waitFor(() => expect(field('instance-role-select-claude').value).toBe(committed ? 'none' : 'inherit'));
      expect(screen.queryByTestId('instance-roles-stale')).toBeNull();
    });

    it('a repository\'s default: the same', async () => {
      await renderAll();
      loseNextAnswer(server, 'PUT', '/role-defaults', '500', { committed });
      fireEvent.change(field('repository-role-select-repo-1-claude'), { target: { value: 'none' } });
      await waitFor(() => expect(screen.getByTestId('repository-roles-save-error-repo-1').textContent).toContain('確かめられません'));
      await waitFor(() => expect(field('repository-role-select-repo-1-claude').value).toBe(committed ? 'none' : 'inherit'));
      expect(screen.queryByTestId('repository-roles-stale-repo-1')).toBeNull();
    });

    it('the system default: the same, and the sessions read again', async () => {
      await renderAll();
      const before = reads('/instances/roles');
      loseNextAnswer(server, 'PUT', '/api/settings/agent-role-defaults', '500', { committed });
      fireEvent.change(field('agent-role-system-default-claude'), { target: { value: REVIEWER.id } });
      await waitFor(() => expect(screen.getByTestId('agent-roles-default-error').textContent).toContain('確かめられません'));
      await waitFor(() => expect(field('agent-role-system-default-claude').value).toBe(committed ? REVIEWER.id : ''));
      await waitFor(() => expect(reads('/instances/roles')).toBeGreaterThan(before));
    });

    it('a new role: the list shows what was read, and pressing again adds no second one', async () => {
      await renderAll();
      fireEvent.click(screen.getByTestId('agent-role-new'));
      fireEvent.change(field('agent-role-create-name'), { target: { value: 'PM' } });
      fireEvent.change(field('agent-role-create-body'), { target: { value: 'x' } });
      loseNextAnswer(server, 'POST', '/api/roles', '500', { committed });
      fireEvent.click(screen.getByTestId('agent-role-create-submit'));
      await waitFor(() => expect(screen.getByTestId('agent-role-create-error').textContent).toContain('確かめられません'));
      await waitFor(() => expect(screen.getByTestId('agent-role-create-submit')).not.toBeDisabled());
      expect(screen.queryAllByText('PM').length > 0).toBe(committed);

      fireEvent.click(screen.getByTestId('agent-role-create-submit'));
      if (committed) {
        await waitFor(() => expect(screen.getByTestId('agent-role-create-error').textContent).toContain('同じ名前'));
      } else {
        await waitFor(() => expect(screen.queryByTestId('agent-role-create-form')).toBeNull());
      }
      expect(server.roles.filter((role) => role.name === 'PM')).toHaveLength(1);
    });

    it('an edit: the list shows what was read, and says it could not tell', async () => {
      await renderAll();
      fireEvent.click(screen.getByTestId(`agent-role-edit-${MARKETER.id}`));
      await screen.findByTestId('agent-role-edit-name');
      fireEvent.change(field('agent-role-edit-name'), { target: { value: 'PM' } });
      loseNextAnswer(server, 'PUT', `/api/roles/${MARKETER.id}`, '500', { committed });
      fireEvent.click(screen.getByTestId('agent-role-edit-submit'));
      await waitFor(() => expect(screen.getByTestId('agent-role-edit-error').textContent).toContain('確かめられません'));
      await waitFor(() => expect(within(field('agent-role-system-default-claude')).queryByText('PM') !== null).toBe(committed));
    });

    it('a delete: the row goes if it happened, and says it could not tell if it stays', async () => {
      await renderAll();
      fireEvent.click(screen.getByTestId(`agent-role-delete-${REVIEWER.id}`));
      loseNextAnswer(server, 'DELETE', `/api/roles/${REVIEWER.id}`, '500', { committed });
      fireEvent.click(screen.getByTestId(`agent-role-delete-confirm-${REVIEWER.id}`));
      if (committed) {
        await waitFor(() => expect(screen.queryByTestId(`agent-role-row-${REVIEWER.id}`)).toBeNull());
      } else {
        await waitFor(() => expect(screen.getByTestId(`agent-role-delete-panel-${REVIEWER.id}`).textContent).toContain('確かめられません'));
      }
    });
  });

  it('a session\'s role with nothing readable after it: says the rows may be behind', async () => {
    await renderAll();
    loseNextAnswer(server, 'PUT', '/instances/roles', 'network', { committed: true });
    server.refuseSettingsRead = true;
    fireEvent.change(field('instance-role-select-claude'), { target: { value: 'none' } });
    await screen.findByTestId('instance-role-error-claude');
    await waitFor(() => expect(screen.getByTestId('instance-roles-stale').textContent).toContain('再読み込み'));
    expect(screen.getByTestId('instance-roles-stale').textContent).not.toContain('完了');
  });

  it('a repository\'s default with nothing readable after it: the same', async () => {
    await renderAll();
    loseNextAnswer(server, 'PUT', '/role-defaults', 'network', { committed: true });
    const lost = global.fetch;
    global.fetch = vi.fn((url: string, init?: RequestInit) =>
      String(url).endsWith('/role-defaults') && !init?.method
        ? Promise.resolve({ ok: false, status: 500, json: async () => ({ success: false, error: 'internal_error' }) })
        : (lost as typeof fetch)(url, init),
    ) as unknown as typeof fetch;
    fireEvent.change(field('repository-role-select-repo-1-claude'), { target: { value: 'none' } });
    await waitFor(() => expect(screen.getByTestId('repository-roles-stale-repo-1')).toBeInTheDocument());
    expect(screen.getByTestId('repository-roles-save-error-repo-1').textContent).toContain('確かめられません');
  });

  it('negative control: a refusal is what it says, and reads nothing to find out', async () => {
    await renderAll();
    const before = reads('/role-defaults');
    const real = global.fetch;
    global.fetch = vi.fn((url: string, init?: RequestInit) =>
      String(url).endsWith('/role-defaults') && init?.method === 'PUT'
        ? Promise.resolve({ ok: false, status: 400, json: async () => ({ success: false, error: 'invalid_request' }) })
        : (real as typeof fetch)(url, init),
    ) as unknown as typeof fetch;
    fireEvent.change(field('repository-role-select-repo-1-claude'), { target: { value: 'none' } });
    await waitFor(() => expect(screen.getByTestId('repository-roles-save-error-repo-1').textContent).toContain('保存できませんでした'));
    expect(reads('/role-defaults')).toBe(before);
  });
});

describe('[#4117] roles in the repository list', () => {
  const REPO: RepositoryListItem = {
    id: 'repo-1',
    name: 'app',
    displayName: null,
    path: '/repos/app',
    enabled: true,
    visible: true,
    worktreeCount: 1,
  };

  function mockList(items: RepositoryListItem[]): void {
    vi.spyOn(repositoryApi, 'list').mockResolvedValue({ success: true, repositories: items } as never);
  }

  const select = () => field('repository-role-select-repo-1-claude');
  const source = () => screen.getByTestId('repository-role-source-repo-1-claude').textContent;

  it('reads nothing until opened, then shows and saves the three states', async () => {
    mockList([REPO]);
    render(<RepositoryList refreshKey={0} />);
    fireEvent.click(await screen.findByTestId('repository-roles-toggle-repo-1'));
    expect(server.calls.length).toBeGreaterThan(0);

    await waitFor(() => expect(source()).toBe('継承中: マーケター［システム］'));
    expect(select().options[select().selectedIndex].text).toBe('システムの既定を使う');
    await waitFor(() => expect(within(select()).getByText(REVIEWER.name)).toBeInTheDocument());

    fireEvent.change(select(), { target: { value: 'none' } });
    await waitFor(() => expect(source()).toBe('指定中: なし［リポジトリで明示］'));

    fireEvent.change(select(), { target: { value: REVIEWER.id } });
    await waitFor(() => expect(source()).toBe('指定中: レビュー担当［リポジトリ］'));

    fireEvent.change(select(), { target: { value: 'inherit' } });
    await waitFor(() => expect(source()).toBe('継承中: マーケター［システム］'));
    expect(server.writes('PUT', '/role-defaults').map((body) => body.role)).toEqual([
      { state: 'none' },
      { state: 'role', roleId: REVIEWER.id },
      { state: 'inherit' },
    ]);
  });

  it('says an excluded repository keeps its defaults', async () => {
    mockList([{ ...REPO, enabled: false }]);
    render(<RepositoryList refreshKey={0} />);
    const note = await screen.findByTestId('repository-roles-kept-note');
    expect(note.textContent).toContain('ロールの既定は残り');
  });

  it('negative control: no note with nothing excluded, and no read with nothing opened', async () => {
    mockList([REPO]);
    render(<RepositoryList refreshKey={0} />);
    await screen.findByTestId('repository-roles-toggle-repo-1');
    expect(screen.queryByTestId('repository-roles-kept-note')).toBeNull();
    expect(server.calls).toEqual([]);
  });
});
