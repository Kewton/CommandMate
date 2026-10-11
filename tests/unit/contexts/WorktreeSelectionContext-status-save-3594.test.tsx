/**
 * WorktreeSelectionContext's own fetches respect a status save (Issue #3594).
 *
 * Without an external source the provider fetches the list on mount, polls it,
 * and fetches a selected worktree's detail. A reply to a request that left
 * before a save was read from the server before it, so it must not put the old
 * status back; a request that left after the save carries the server value.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: {
      getAll: vi.fn(),
      getById: vi.fn(),
      markAsViewed: vi.fn().mockResolvedValue({ success: true }),
    },
  };
});

import { worktreeApi } from '@/lib/api-client';
import { WorktreeSelectionProvider, useWorktreeSelection } from '@/contexts/WorktreeSelectionContext';
import { __resetWorktreeStatusSaves, saveWorktreeStatus } from '@/lib/worktree-status';

const ID = 'wt-3594';
const WORKTREE = {
  id: ID,
  name: 'feature/3594',
  path: '/path/to/wt',
  repositoryPath: '/path/to/repo',
  repositoryName: 'MyRepo',
  status: 'ready',
} as Worktree;

function Consumer() {
  const context = useWorktreeSelection();
  return (
    <div>
      <span data-testid="list-status">{context.worktrees[0]?.status ?? 'none'}</span>
      <span data-testid="detail-status">{context.selectedWorktreeDetail?.status ?? 'none'}</span>
      <button data-testid="select" onClick={() => void context.selectWorktree(ID)}>
        select
      </button>
      <button data-testid="refresh" onClick={() => void context.refreshWorktrees()}>
        refresh
      </button>
    </div>
  );
}

type ListReply = (status: Worktree['status']) => void;

let listReplies: ListReply[];
let detailReplies: ListReply[];

beforeEach(() => {
  __resetWorktreeStatusSaves();
  listReplies = [];
  detailReplies = [];
  vi.mocked(worktreeApi.getAll).mockImplementation(
    () =>
      new Promise((resolve) =>
        listReplies.push((status) =>
          resolve({ worktrees: [{ ...WORKTREE, status }], repositories: [] } as never)
        )
      )
  );
  vi.mocked(worktreeApi.getById).mockImplementation(
    () => new Promise((resolve) => detailReplies.push((status) => resolve({ ...WORKTREE, status })))
  );
  global.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
    const status = JSON.parse(String(init?.body)).status;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...WORKTREE, status }) });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  __resetWorktreeStatusSaves();
  vi.restoreAllMocks();
});

function renderProvider() {
  return render(
    <WorktreeSelectionProvider>
      <Consumer />
    </WorktreeSelectionProvider>
  );
}

describe('[#3594] WorktreeSelectionContext and status saves', () => {
  it('keeps Done when the mount fetch and the first poll, sent before the save, answer Ready', async () => {
    renderProvider();
    // Mount fetch + the poll's first round are both on the wire.
    await waitFor(() => expect(listReplies.length).toBe(2));

    await act(async () => {
      await saveWorktreeStatus(ID, 'done');
    });
    await act(async () => {
      listReplies.forEach((reply) => reply('ready'));
    });
    expect(screen.getByTestId('list-status').textContent).toBe('done');
  });

  it('takes the server value from a list fetch sent after the save (negative control)', async () => {
    renderProvider();
    await waitFor(() => expect(listReplies.length).toBe(2));
    await act(async () => {
      await saveWorktreeStatus(ID, 'done');
    });
    await act(async () => {
      listReplies.forEach((reply) => reply('done'));
    });

    const before = listReplies.length;
    act(() => screen.getByTestId('refresh').click());
    await waitFor(() => expect(listReplies.length).toBe(before + 1));
    await act(async () => listReplies[before]('in_review'));
    expect(screen.getByTestId('list-status').textContent).toBe('in_review');
  });

  it('keeps Done when the selected worktree detail, fetched before the save, answers Ready', async () => {
    renderProvider();
    await waitFor(() => expect(listReplies.length).toBe(2));
    await act(async () => listReplies.forEach((reply) => reply('ready')));

    act(() => screen.getByTestId('select').click());
    await waitFor(() => expect(detailReplies.length).toBe(1));
    await act(async () => {
      await saveWorktreeStatus(ID, 'done');
    });
    await act(async () => detailReplies[0]('ready'));
    expect(screen.getByTestId('detail-status').textContent).toBe('done');
  });

  it('takes the server value from a detail fetch sent after the save (negative control)', async () => {
    renderProvider();
    await waitFor(() => expect(listReplies.length).toBe(2));
    await act(async () => listReplies.forEach((reply) => reply('ready')));
    await act(async () => {
      await saveWorktreeStatus(ID, 'done');
    });

    act(() => screen.getByTestId('select').click());
    await waitFor(() => expect(detailReplies.length).toBe(1));
    await act(async () => detailReplies[0]('in_review'));
    expect(screen.getByTestId('detail-status').textContent).toBe('in_review');
  });
});
