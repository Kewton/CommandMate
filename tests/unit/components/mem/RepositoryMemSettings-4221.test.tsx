/**
 * The mem settings screen, rendered from its parent (`RepositoryList`), as the PC and
 * the phone open it (Issue #4221, design §11.1). Every write carries the screen's mark.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RepositoryList } from '@/components/repository/RepositoryList';
import { repositoryApi, type RepositoryListItem } from '@/lib/api-client';
import { SCREEN_CLIENT_HEADER } from '@/lib/security/screen-request';
import type { MemRepositorySettings } from '@/types/mem';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

const REPO: RepositoryListItem = {
  id: 'repo-1',
  name: 'app',
  displayName: null,
  path: '/repos/app',
  enabled: true,
  visible: true,
  worktreeCount: 1,
};

let settings: MemRepositorySettings;
let writes: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }>;

beforeEach(() => {
  settings = {
    repositoryId: 'repo-1',
    version: 0,
    features: { injectOnStart: false, promptOnEvents: false, popup: false },
    rules: [],
    overrides: [],
  };
  writes = [];
  vi.spyOn(repositoryApi, 'list').mockResolvedValue({ success: true, repositories: [REPO] } as never);
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      writes.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body });
      if (url.endsWith('/mem-settings') && method === 'PUT') {
        settings = { ...settings, version: settings.version + 1, rules: body.rules, features: body.features };
      } else if (url.includes('/branches') && method === 'PUT') {
        settings = {
          ...settings,
          version: settings.version + 1,
          overrides: [{ branch: body.branch, mode: body.mode, injectOnStart: null, promptOnEvents: null, popup: null }],
        };
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, settings }) } as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

describe('[#4221] mem settings from the repository list', () => {
  it('opens from the row, adds a rule and saves it with the screen mark and the version read', async () => {
    render(<RepositoryList refreshKey={0} />);
    fireEvent.click(await screen.findByTestId('repository-mem-toggle-repo-1'));
    await screen.findByTestId('repository-mem-repo-1');
    expect(screen.getByText('規則はありません（すべて off）。')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('repository-mem-rule-add-repo-1'));
    fireEvent.change(screen.getByTestId('repository-mem-rule-pattern-repo-1-0'), { target: { value: 'main' } });
    fireEvent.change(screen.getByTestId('repository-mem-rule-mode-repo-1-0'), { target: { value: 'on' } });
    fireEvent.click(screen.getByTestId('repository-mem-save-repo-1'));

    await waitFor(() => expect(screen.getByTestId('repository-mem-status-repo-1').textContent).toBe('保存しました。'));
    expect(writes[0]).toMatchObject({
      method: 'PUT',
      url: '/api/repositories/repo-1/mem-settings',
      headers: { [SCREEN_CLIENT_HEADER]: 'screen' },
      body: { version: 0, rules: [{ match: 'glob', pattern: 'main', mode: 'on' }] },
    });
  });

  it('adds a branch override against the current version', async () => {
    render(<RepositoryList refreshKey={0} />);
    fireEvent.click(await screen.findByTestId('repository-mem-toggle-repo-1'));
    await screen.findByTestId('repository-mem-repo-1');
    fireEvent.change(screen.getByTestId('repository-mem-override-branch-repo-1'), { target: { value: 'feat/x' } });
    fireEvent.change(screen.getByTestId('repository-mem-override-mode-repo-1'), { target: { value: 'derived' } });
    fireEvent.click(screen.getByTestId('repository-mem-override-add-repo-1'));
    await waitFor(() => expect(screen.getByText('feat/x')).toBeInTheDocument());
    expect(writes[0]).toMatchObject({ method: 'PUT', url: '/api/repositories/repo-1/mem-settings/branches', body: { version: 0, branch: 'feat/x', mode: 'derived' } });
  });

  it('says so when the settings moved, and shows the newer ones', async () => {
    render(<RepositoryList refreshKey={0} />);
    fireEvent.click(await screen.findByTestId('repository-mem-toggle-repo-1'));
    await screen.findByTestId('repository-mem-repo-1');
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ ok: false, code: 'version_conflict', settings: { ...settings, version: 5 } }),
    }));
    fireEvent.click(screen.getByTestId('repository-mem-save-repo-1'));
    await waitFor(() => expect(screen.getByTestId('repository-mem-status-repo-1').textContent).toContain('他で変更されていました'));
  });
});
