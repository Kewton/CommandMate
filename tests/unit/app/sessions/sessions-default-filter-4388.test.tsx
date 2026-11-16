/**
 * /sessions default filter on the page (Issue #4388): the saved default is applied when
 * the page opens (PC modal and mobile sheet alike), deleted roles raise a notice instead of
 * widening to everything, the filter button's mark, "make this the default", "back to
 * default", clear (does not save), and a rejected save.
 *
 * Positive control: red before #4388 (the page never read the default; no buttons, no mark).
 * Negative control: nothing saved / the read failed → the page is as before (I4).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import React from 'react';
import type { SessionsFilterCondition } from '@/types/sessions-default-filter';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

let mockIsMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mockIsMobile, MOBILE_BREAKPOINT: 768 }));

let mockWorktrees: Array<Record<string, unknown>> = [];
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useWorktreesCacheContext: () => ({
    worktrees: mockWorktrees,
    repositories: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

let mockRoles: Array<{ id: string; name: string }> | null = [];
let mockRolesStatus: 'loading' | 'ok' | 'error' = 'ok';
let mockRoleSource: { roleByWorktree: Record<string, Record<string, unknown>>; rolesUnavailable?: boolean } | null = null;
vi.mock('@/hooks/useSessionsRoles', () => ({
  useSessionsRoles: () => ({
    roles: mockRoles,
    rolesStatus: mockRolesStatus,
    source: mockRoleSource,
    reload: vi.fn(),
  }),
}));

type GetReply = { ok: true; body: unknown } | { ok: false; error: unknown };
let getReply: GetReply;
/** When set, each GET waits here until the test answers it (I7). */
let getQueue: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> | null = null;
let putReply: (body: SessionsFilterCondition) => Promise<unknown>;
const putBodies: SessionsFilterCondition[] = [];

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    sessionsApi: {
      ...actual.sessionsApi,
      getDefaultFilter: vi.fn(async () => {
        if (getQueue) {
          return new Promise((resolve, reject) => getQueue!.push({ resolve, reject }));
        }
        if (getReply.ok) return getReply.body;
        throw getReply.error;
      }),
      putDefaultFilter: vi.fn(async (body: SessionsFilterCondition) => {
        putBodies.push(body);
        return putReply(body);
      }),
    },
  };
});

import { ApiError } from '@/lib/api-client';
import SessionsPage from '@/app/sessions/page';

const EMPTY: SessionsFilterCondition = { branchPattern: '', roleIds: [], includeNoRole: false, includeAmbiguous: false };
const cond = (over: Partial<SessionsFilterCondition>): SessionsFilterCondition => ({ ...EMPTY, ...over });
const saved = (filter: SessionsFilterCondition) => ({ ok: true as const, body: { success: true as const, filter, configured: true } });

const idle = { isRunning: false, isWaitingForResponse: false, isProcessing: false };
const row = (id: string, name: string) => ({
  id, name, path: `/tmp/${id}`, repositoryPath: '/tmp/repo', repositoryName: 'Repo',
  selectedAgents: ['claude', 'codex'],
  agentInstances: [
    { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
    { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
  ],
  sessionStatusByCli: { claude: idle, codex: idle },
  sessionStatusByInstance: { claude: idle, codex: idle },
  gitStatus: { currentBranch: name, initialBranch: name, isBranchMismatch: false, commitHash: 'x', isDirty: false },
});
const role = (roleId: string, roleName: string) => ({ kind: 'role', roleId, roleName, basis: 'launched' });

beforeEach(() => {
  mockIsMobile = false;
  mockWorktrees = [row('1', 'feature/1-a'), row('2', 'feature/2-b'), row('3', 'main')];
  mockRoles = [
    { id: 'review', name: 'レビュー担当' },
    { id: 'impl', name: '実装担当' },
  ];
  mockRolesStatus = 'ok';
  mockRoleSource = {
    roleByWorktree: {
      '1': { claude: role('review', 'レビュー担当'), codex: { kind: 'none' } },
      '2': { claude: role('impl', '実装担当'), codex: { kind: 'none' } },
      '3': { claude: role('review', 'レビュー担当'), codex: { kind: 'none' } },
    },
  };
  getReply = { ok: true, body: { success: true, filter: EMPTY, configured: false } };
  putReply = async (body) => ({ success: true, filter: body, configured: true });
  putBodies.length = 0;
  getQueue = null;
});
afterEach(() => cleanup());

async function renderPage() {
  const view = render(<SessionsPage />);
  // Let the default's read settle.
  await act(async () => {});
  return view;
}
const shown = () =>
  ['1', '2', '3'].filter((id) => screen.queryByTestId(`session-item-${id}`) !== null);
const mark = () => screen.queryByTestId('sessions-filter-differs');
const openPanel = () => fireEvent.click(screen.getByTestId('sessions-filter-button'));

describe('[#4388] /sessions default filter on the page', () => {
  it('control (I4): nothing saved — every row, no mark, no notice; "back to default" is off', async () => {
    await renderPage();
    expect(shown()).toEqual(['1', '2', '3']);
    expect(mark()).toBeNull();
    expect(screen.queryByTestId('sessions-default-filter-dropped-roles')).toBeNull();
    openPanel();
    expect(screen.getByTestId('sessions-default-filter-reset')).toBeDisabled();
  });

  it('control (I4): the read failed — the page is as before', async () => {
    getReply = { ok: false, error: new ApiError('Internal server error', 500) };
    await renderPage();
    expect(shown()).toEqual(['1', '2', '3']);
    expect(mark()).toBeNull();
    expect(screen.queryByTestId('sessions-filter-count')).toBeNull();
  });

  it('applies the saved default when the page opens (PC)', async () => {
    getReply = saved(cond({ branchPattern: '^feature/', roleIds: ['review'] }));
    await renderPage();
    expect(shown()).toEqual(['1']);
    expect(screen.getByTestId('sessions-filter-count')).toHaveTextContent('2');
    expect(mark()).toBeNull();
    openPanel();
    expect(screen.getByTestId('sessions-branch-filter')).toHaveValue('^feature/');
    expect(screen.getByTestId('sessions-role-filter-role-review')).toBeChecked();
  });

  it('the same default applies on mobile, and the sheet carries the same buttons', async () => {
    mockIsMobile = true;
    getReply = saved(cond({ branchPattern: '^feature/', roleIds: ['review'] }));
    await renderPage();
    expect(shown()).toEqual(['1']);
    openPanel();
    const sheet = screen.getByTestId('sessions-filter-sheet');
    expect(within(sheet).getByTestId('sessions-default-filter-save')).toHaveTextContent('この条件をデフォルトにする');
    expect(within(sheet).getByTestId('sessions-default-filter-reset')).toHaveTextContent('デフォルトに戻す');
    expect(within(sheet).getByTestId('sessions-filter-clear')).toHaveTextContent('クリア');
  });

  it('a deleted role: left out with a notice, the rest still filters (not widened to everything)', async () => {
    getReply = saved(cond({ branchPattern: '^feature/', roleIds: ['gone', 'review'] }));
    await renderPage();
    expect(screen.getByTestId('sessions-default-filter-dropped-roles')).toHaveTextContent(
      '削除されたロールが含まれていました'
    );
    expect(shown()).toEqual(['1']);
    expect(mark()).toBeNull();
  });

  it('every role of the default deleted: notice, and the branch condition still applies', async () => {
    getReply = saved(cond({ branchPattern: '^feature/', roleIds: ['gone'] }));
    await renderPage();
    expect(screen.getByTestId('sessions-default-filter-dropped-roles')).toBeTruthy();
    expect(shown()).toEqual(['1', '2']);
  });

  it('I2: roles could not be read — no "deleted" notice, the stored roles are kept', async () => {
    mockRoles = null;
    mockRolesStatus = 'error';
    mockRoleSource = { roleByWorktree: {}, rolesUnavailable: true };
    getReply = saved(cond({ roleIds: ['review'] }));
    await renderPage();
    expect(screen.queryByTestId('sessions-default-filter-dropped-roles')).toBeNull();
    // The role condition is kept (counted as wanted, shown as unusable by #4389's notice).
    openPanel();
    expect(screen.getByTestId('sessions-role-filter-unavailable')).toBeTruthy();
    expect(mark()).toBeNull();
  });

  it('I2: while roles are still loading the default waits; it applies once they are read', async () => {
    mockRolesStatus = 'loading';
    mockRoles = null;
    getReply = saved(cond({ branchPattern: '^feature/', roleIds: ['gone'] }));
    const view = await renderPage();
    expect(shown()).toEqual(['1', '2', '3']);
    expect(screen.queryByTestId('sessions-default-filter-dropped-roles')).toBeNull();
    mockRolesStatus = 'ok';
    mockRoles = [{ id: 'review', name: 'レビュー担当' }];
    view.rerender(<SessionsPage />);
    await act(async () => {});
    expect(shown()).toEqual(['1', '2']);
    expect(screen.getByTestId('sessions-default-filter-dropped-roles')).toBeTruthy();
  });

  it('the mark appears when the condition differs from the default, and "back to default" removes it', async () => {
    getReply = saved(cond({ branchPattern: '^feature/' }));
    await renderPage();
    expect(mark()).toBeNull();
    openPanel();
    fireEvent.change(screen.getByTestId('sessions-branch-filter'), { target: { value: 'main' } });
    expect(mark()).not.toBeNull();
    expect(shown()).toEqual(['3']);
    fireEvent.click(screen.getByTestId('sessions-default-filter-reset'));
    expect(mark()).toBeNull();
    expect(screen.getByTestId('sessions-branch-filter')).toHaveValue('^feature/');
    expect(shown()).toEqual(['1', '2']);
    expect(putBodies).toEqual([]);
  });

  it('clear empties the condition and does not save; the mark shows it differs from the default', async () => {
    getReply = saved(cond({ branchPattern: '^feature/', roleIds: ['review'] }));
    await renderPage();
    openPanel();
    fireEvent.click(screen.getByTestId('sessions-filter-clear'));
    expect(shown()).toEqual(['1', '2', '3']);
    expect(mark()).not.toBeNull();
    expect(putBodies).toEqual([]);
  });

  it('"make this the default" saves the current condition; the mark goes away', async () => {
    await renderPage();
    openPanel();
    fireEvent.change(screen.getByTestId('sessions-branch-filter'), { target: { value: '^feature/' } });
    fireEvent.click(screen.getByTestId('sessions-role-filter-role-impl'));
    expect(mark()).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('sessions-default-filter-save'));
    });
    expect(putBodies).toEqual([cond({ branchPattern: '^feature/', roleIds: ['impl'] })]);
    expect(screen.getByTestId('sessions-default-filter-saved')).toBeTruthy();
    expect(mark()).toBeNull();
    expect(screen.getByTestId('sessions-default-filter-reset')).not.toBeDisabled();
  });

  it('a 400 on save shows the reason and keeps the condition and the default', async () => {
    getReply = saved(cond({ branchPattern: '^feature/' }));
    putReply = async () => {
      throw new ApiError('"branchPattern" is not a valid regular expression', 400);
    };
    await renderPage();
    openPanel();
    fireEvent.change(screen.getByTestId('sessions-branch-filter'), { target: { value: '(' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('sessions-default-filter-save'));
    });
    expect(screen.getByTestId('sessions-default-filter-save-error')).toHaveTextContent(
      'デフォルトにできませんでした: "branchPattern" is not a valid regular expression'
    );
    expect(screen.getByTestId('sessions-branch-filter')).toHaveValue('(');
    expect(mark()).not.toBeNull();
    fireEvent.click(screen.getByTestId('sessions-default-filter-reset'));
    expect(screen.getByTestId('sessions-branch-filter')).toHaveValue('^feature/');
  });

  it('a network failure on save shows a generic message', async () => {
    putReply = async () => {
      throw new ApiError('Failed to fetch', 0);
    };
    await renderPage();
    openPanel();
    fireEvent.change(screen.getByTestId('sessions-branch-filter'), { target: { value: 'x' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('sessions-default-filter-save'));
    });
    expect(screen.getByTestId('sessions-default-filter-save-error')).toHaveTextContent(
      'デフォルトを保存できませんでした'
    );
  });

  it('changes are not saved: leaving and coming back starts from the default again', async () => {
    getReply = saved(cond({ branchPattern: '^feature/' }));
    const first = await renderPage();
    openPanel();
    fireEvent.change(screen.getByTestId('sessions-branch-filter'), { target: { value: 'main' } });
    expect(shown()).toEqual(['3']);
    first.unmount();
    await renderPage();
    expect(shown()).toEqual(['1', '2']);
    expect(mark()).toBeNull();
    expect(putBodies).toEqual([]);
  });

  it('I1: a change made before the default arrives is kept', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reply = saved(cond({ branchPattern: '^feature/' }));
    const { sessionsApi } = await import('@/lib/api-client');
    vi.mocked(sessionsApi.getDefaultFilter).mockImplementationOnce(async () => {
      await gate;
      return reply.body;
    });
    render(<SessionsPage />);
    openPanel();
    fireEvent.change(screen.getByTestId('sessions-branch-filter'), { target: { value: 'main' } });
    await act(async () => release());
    expect(screen.getByTestId('sessions-branch-filter')).toHaveValue('main');
    expect(shown()).toEqual(['3']);
    expect(mark()).not.toBeNull();
  });

  describe('I6: every chosen role deleted does not widen the list', () => {
    it('the default chose only a deleted role: notice, 0 rows (not every row), no mark', async () => {
      getReply = saved(cond({ roleIds: ['gone'] }));
      await renderPage();
      expect(screen.getByTestId('sessions-default-filter-dropped-roles')).toHaveTextContent(
        '削除されたロールが含まれていました'
      );
      expect(shown()).toEqual([]);
      expect(screen.getByTestId('sessions-filter-count')).toHaveTextContent('1');
      expect(mark()).toBeNull();
      // Clear widens on purpose, and that is a difference from the default.
      openPanel();
      fireEvent.click(screen.getByTestId('sessions-filter-clear'));
      expect(shown()).toEqual(['1', '2', '3']);
      expect(mark()).not.toBeNull();
      fireEvent.click(screen.getByTestId('sessions-default-filter-reset'));
      expect(shown()).toEqual([]);
      expect(mark()).toBeNull();
    });

    it('control: a default with no role chosen from the start filters nothing', async () => {
      getReply = saved(EMPTY);
      await renderPage();
      expect(shown()).toEqual(['1', '2', '3']);
      expect(screen.queryByTestId('sessions-default-filter-dropped-roles')).toBeNull();
      expect(mark()).toBeNull();
    });

    it('choosing a role that exists replaces the deleted one (it is not saved back)', async () => {
      getReply = saved(cond({ roleIds: ['gone'] }));
      await renderPage();
      openPanel();
      fireEvent.click(screen.getByTestId('sessions-role-filter-role-review'));
      expect(shown()).toEqual(['1', '3']);
      await act(async () => {
        fireEvent.click(screen.getByTestId('sessions-default-filter-save'));
      });
      expect(putBodies).toEqual([cond({ roleIds: ['review'] })]);
    });
  });

  describe('I7: under StrictMode an older GET reply never replaces the newer one', () => {
    async function openStrictWithTwoReads() {
      getQueue = [];
      render(<SessionsPage />, { reactStrictMode: true });
      await act(async () => {});
      expect(getQueue).toHaveLength(2);
      await act(async () => getQueue![1].resolve(saved(cond({ branchPattern: '^feature/' })).body));
      expect(shown()).toEqual(['1', '2']);
      return getQueue!;
    }
    const expectSecondReadKept = () => {
      expect(shown()).toEqual(['1', '2']);
      expect(mark()).toBeNull();
      openPanel();
      expect(screen.getByTestId('sessions-branch-filter')).toHaveValue('^feature/');
      expect(screen.getByTestId('sessions-default-filter-reset')).not.toBeDisabled();
    };

    it('the first read fails late', async () => {
      const queue = await openStrictWithTwoReads();
      await act(async () => queue[0].reject(new ApiError('Internal server error', 500)));
      expectSecondReadKept();
    });

    it('the first read succeeds late with an older value', async () => {
      const queue = await openStrictWithTwoReads();
      await act(async () => queue[0].resolve(saved(cond({ branchPattern: 'main' })).body));
      expectSecondReadKept();
    });
  });
});
