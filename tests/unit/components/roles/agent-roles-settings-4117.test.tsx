/**
 * Roles in the settings and the repository list (Issue #4117), through the sections
 * the PC dialog and `/more` mount.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SettingsGeneralSection } from '@/components/settings';
import { RepositoryList } from '@/components/repository/RepositoryList';
import { repositoryApi, type RepositoryListItem } from '@/lib/api-client';
import { roleEditExample } from '@tests/integration/fixtures/agent-roles-api-examples';
import { FakeRoleServer, MARKETER, REVIEWER } from './fake-role-server';

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
    fireEvent.click(screen.getByTestId('agent-role-edit-submit'));

    await waitFor(() => expect(screen.getByTestId(`agent-role-row-${MARKETER.id}`).textContent).toContain('新しい名前'));
    expect(server.writes('PUT', `/api/roles/${MARKETER.id}`)[0].expectedBodyVersion).toBe(MARKETER.bodyVersion);
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
    fireEvent.click(screen.getByTestId('agent-role-edit-submit'));
    await waitFor(() => expect(screen.getByTestId('agent-role-edit-error').textContent).toContain('別の場所'));
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

  it('explains how a role differs from an OpenCode persona', async () => {
    await renderSettings();
    expect(screen.getByTestId('agent-roles-persona-note').textContent).toContain('ペルソナ');
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
