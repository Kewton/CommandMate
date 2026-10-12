/**
 * The worktree status from the branch row's "…" (Issue #3594).
 *
 *   - The row data carries the lifecycle status in its own field
 *     (`worktreeStatus`), never mixed into the CLI `status`.
 *   - "…" → Status → five choices, the current one beside "Status". The save is
 *     `PATCH /api/worktrees/<row id>` — any row, not only the one on screen —
 *     followed by a list re-fetch.
 *   - A failed save says so in a toast and puts the old value back.
 *   - Any status but "Not set" puts a small pill on the row that shrinks to a
 *     dot while the row is narrow, so the branch name stays readable.
 *   - The header lost its status select; the Info field keeps one.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import React from 'react';
import fs from 'fs';
import path from 'path';
import { BranchListItem, __resetMouseEnterSuppression } from '@/components/sidebar/BranchListItem';
import { DesktopHeader, WorktreeInfoFields } from '@/components/worktree/WorktreeDetailSubComponents';
import { ToastProvider } from '@/components/common/Toast';
import { toBranchItem, type SidebarBranchItem } from '@/types/sidebar';
import type { Worktree } from '@/types/models';
import {
  __resetWorktreeStatusSaves,
  currentWorktreeStatusGeneration,
  markWorktreeListFetched,
} from '@/lib/worktree-status';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const refresh = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/components/providers/WorktreesCacheProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/providers/WorktreesCacheProvider')>()),
  useOptionalWorktreesCacheContext: () => ({
    worktrees: [],
    repositories: [],
    isLoading: false,
    error: null,
    refresh,
  }),
}));

const base: SidebarBranchItem = {
  id: 'wt-other',
  name: 'feature/not-on-screen',
  repositoryName: 'Repo',
  status: 'idle',
  hasUnread: false,
  cliStatus: { claude: 'idle' },
  worktreePath: '/repos/app/wt-other',
  worktreeStatus: 'in_review',
};

function renderRow(branch: SidebarBranchItem = base, isSelected = false) {
  return render(
    <ToastProvider>
      <BranchListItem branch={branch} isSelected={isSelected} onClick={vi.fn()} />
    </ToastProvider>
  );
}

/** Hover the row, open "…", then open the Status submenu. */
function openStatusSubmenu(): HTMLElement {
  fireEvent.pointerEnter(screen.getByTestId('branch-list-row'));
  fireEvent.keyDown(screen.getByTestId('branch-row-actions'), { key: 'Enter' });
  const trigger = screen.getByTestId('branch-row-status');
  fireEvent.click(trigger);
  return trigger;
}

function mockFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => response.body ?? {},
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeAll(() => installRadixJsdomPolyfills());

beforeEach(() => {
  __resetMouseEnterSuppression();
  __resetWorktreeStatusSaves();
  refresh.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('row data (Issue #3594)', () => {
  const worktree = {
    id: 'wt-1',
    name: 'feature/a',
    path: '/repos/app/wt-1',
    repositoryPath: '/repos/app',
    repositoryName: 'app',
    status: 'in_review',
    isSessionRunning: true,
    isWaitingForResponse: false,
    isProcessing: true,
  } as Worktree;

  it('carries the lifecycle status in its own field', () => {
    expect(toBranchItem(worktree).worktreeStatus).toBe('in_review');
  });

  it('keeps the CLI status apart from it (negative control)', () => {
    const item = toBranchItem(worktree);
    expect(item.status).not.toBe('in_review');
    expect(['idle', 'ready', 'running', 'waiting', 'generating']).toContain(item.status);
  });

  it('reads "Not set" as null', () => {
    expect(toBranchItem({ ...worktree, status: undefined }).worktreeStatus).toBeNull();
    expect(toBranchItem({ ...worktree, status: null }).worktreeStatus).toBeNull();
  });
});

describe('row pill (Issue #3594)', () => {
  it('shows a set status beside the name', () => {
    renderRow();
    const pill = screen.getByTestId('branch-worktree-status');
    expect(pill).toHaveAttribute('data-status', 'in_review');
    expect(pill).toHaveAttribute('title', 'In Review');
    expect(within(pill).getByTestId('branch-worktree-status-label')).toHaveTextContent('In Review');
  });

  it('shows nothing for "Not set" (negative control)', () => {
    renderRow({ ...base, worktreeStatus: null });
    expect(screen.queryByTestId('branch-worktree-status')).not.toBeInTheDocument();
  });

  it('puts the name first: the pill never grows, and shrinks to a dot while the row is narrow', () => {
    renderRow();
    const name = screen.getByText('feature/not-on-screen');
    expect(name.className).toMatch(/\bflex-1\b/);
    expect(name.className).toMatch(/\btruncate\b/);
    const pill = screen.getByTestId('branch-worktree-status');
    expect(pill.className).toMatch(/\bflex-shrink-0\b/);
    // The row is the size container the pill answers to.
    expect(pill.parentElement?.className).toMatch(/(^|\s)@container(\s|$)/);
    const dot = screen.getByTestId('branch-worktree-status-dot');
    expect(dot.className).toContain('@min-[17rem]:hidden');
    const label = screen.getByTestId('branch-worktree-status-label');
    expect(label.className).toMatch(/(^|\s)sr-only(\s|$)/);
    expect(label.className).toContain('@min-[17rem]:not-sr-only');
    expect(label.className).toContain('@min-[17rem]:max-w-[5.5rem]');
  });
});

describe('row "…" → Status (Issue #3594)', () => {
  it('shows the current value beside "Status" and offers the five choices', () => {
    renderRow();
    const trigger = openStatusSubmenu();
    expect(within(trigger).getByTestId('branch-row-status-current')).toHaveTextContent('In Review');
    const radios = screen.getAllByRole('menuitemradio').map((el) => el.textContent);
    expect(radios).toEqual(['Not set', 'Ready', 'In Progress', 'In Review', 'Done']);
    expect(screen.getByRole('menuitemradio', { name: 'In Review' })).toHaveAttribute('aria-checked', 'true');
  });

  it('is reachable from the selected row on a touch screen (its "…" is always there)', () => {
    renderRow(base, true);
    const actions = screen.getByTestId('branch-row-actions');
    expect(actions.className).not.toMatch(/hover:none\)\]:hidden/);
    fireEvent.keyDown(actions, { key: 'Enter' });
    expect(screen.getByTestId('branch-row-status')).toBeInTheDocument();
  });

  it('saves with the ROW id, shows the pick at once and re-fetches the list', async () => {
    const fetchMock = mockFetch({ ok: true, body: { id: 'wt-other', status: 'done' } });
    renderRow();
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/worktrees/wt-other');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ status: 'done' });
    expect(screen.getByTestId('branch-worktree-status')).toHaveAttribute('data-status', 'done');
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('can clear the status ("Not set" travels as null)', async () => {
    const fetchMock = mockFetch({ ok: true, body: { id: 'wt-other', status: null } });
    renderRow();
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Not set' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ status: null });
    expect(screen.queryByTestId('branch-worktree-status')).not.toBeInTheDocument();
  });

  it('does not save when the current value is picked again (negative control)', () => {
    const fetchMock = mockFetch({ ok: true });
    renderRow();
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'In Review' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tells the user and puts the old value back when the save fails', async () => {
    mockFetch({ ok: false, status: 500 });
    renderRow();
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' }));

    expect(await screen.findByText('Could not change the status')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('branch-worktree-status')).toHaveAttribute('data-status', 'in_review')
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('puts the old value back when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    renderRow();
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Ready' }));
    expect(await screen.findByText('Could not change the status')).toBeInTheDocument();
    expect(screen.getByTestId('branch-worktree-status')).toHaveAttribute('data-status', 'in_review');
  });

  it('follows a new value from the list (set elsewhere)', () => {
    const { rerender } = renderRow();
    rerender(
      <ToastProvider>
        <BranchListItem branch={{ ...base, worktreeStatus: 'in_progress' }} isSelected={false} onClick={vi.fn()} />
      </ToastProvider>
    );
    expect(screen.getByTestId('branch-worktree-status')).toHaveAttribute('data-status', 'in_progress');
  });
});

describe('where the status select lives (Issue #3594)', () => {
  it('is gone from the PC header', () => {
    // The props that used to draw it are passed anyway: a caller that still
    // hands them over must not bring the select back.
    const legacy = { worktreeStatus: 'in_progress', onWorktreeStatusChange: vi.fn() } as object;
    render(
      <DesktopHeader worktreeName="feature/a" repositoryName="Repo" status="idle" onInfoClick={vi.fn()} {...legacy} />
    );
    expect(screen.queryByTestId('desktop-status-dropdown')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Worktree status' })).not.toBeInTheDocument();
  });

  it('stays in the Info field (negative control)', () => {
    const worktree = {
      id: 'wt-1',
      name: 'feature/a',
      path: '/repos/app/wt-1',
      repositoryPath: '/repos/app',
      repositoryName: 'app',
      status: 'in_progress',
    } as Worktree;
    render(
      <WorktreeInfoFields
        worktreeId="wt-1"
        worktree={worktree}
        cardClassName=""
        descriptionEditor={{
          isEditing: false,
          text: '',
          setText: vi.fn(),
          isSaving: false,
          handleSave: vi.fn(),
          handleCancel: vi.fn(),
          startEditing: vi.fn(),
        } as unknown as React.ComponentProps<typeof WorktreeInfoFields>['descriptionEditor']}
        showLogs={false}
        onToggleLogs={vi.fn()}
      />
    );
    const select = screen.getByTestId('mobile-status-dropdown') as HTMLSelectElement;
    expect(select.value).toBe('in_progress');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Not set',
      'Ready',
      'In Progress',
      'In Review',
      'Done',
    ]);
  });
});

describe('two picks in a row (Issue #3594, review follow-up)', () => {
  beforeEach(() => __resetWorktreeStatusSaves());
  afterEach(() => __resetWorktreeStatusSaves());

  it('PATCHes the later pick only after the earlier one settles, so Done is the last save', async () => {
    const replies: Array<() => void> = [];
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((resolve) => {
          const status = JSON.parse(String(init?.body)).status;
          bodies.push(status);
          replies.push(() => resolve({ ok: true, status: 200, json: async () => ({ id: 'wt-other', status }) }));
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    renderRow();
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Ready' }));
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodies).toEqual(['ready']);
    expect(screen.getByTestId('branch-worktree-status')).toHaveAttribute('data-status', 'done');

    replies[0]();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodies).toEqual(['ready', 'done']);
    replies[1]();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe('the last pick holds until its own save and re-fetch (Issue #3594, re-review)', () => {
  /**
   * A row whose data is really re-fetched: `refresh` reads the server's value
   * (what the PATCHes left) into the row and records the fetch as succeeded,
   * like the list cache does. `failRefresh(n)` makes the n-th (1-based)
   * re-fetch fail: like useWorktreesCache it still resolves, but nothing moves.
   */
  function renderLiveRow({ failRefresh = (_n: number): boolean => false } = {}) {
    let server: SidebarBranchItem['worktreeStatus'] = base.worktreeStatus;
    let setRow!: (status: SidebarBranchItem['worktreeStatus']) => void;
    function LiveRow() {
      const [status, setStatus] = React.useState(base.worktreeStatus);
      setRow = setStatus;
      return (
        <ToastProvider>
          <BranchListItem branch={{ ...base, worktreeStatus: status }} isSelected={false} onClick={vi.fn()} />
        </ToastProvider>
      );
    }
    const replies: Array<() => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((resolve) => {
            const status = JSON.parse(String(init?.body)).status;
            replies.push(() => {
              server = status;
              resolve({ ok: true, status: 200, json: async () => ({ id: 'wt-other', status }) });
            });
          })
      )
    );
    let refreshes = 0;
    /** One successful list fetch: the server's value lands in the row. */
    const fetchList = () => {
      const startedAt = currentWorktreeStatusGeneration();
      act(() => setRow(server));
      markWorktreeListFetched(startedAt);
    };
    refresh.mockImplementation(async () => {
      refreshes += 1;
      if (failRefresh(refreshes)) return;
      fetchList();
    });
    render(<LiveRow />);
    return {
      replies,
      fetchList,
      setElsewhere: (status: SidebarBranchItem['worktreeStatus']) => act(() => setRow(status)),
    };
  }

  const pill = () => screen.getByTestId('branch-worktree-status');

  afterEach(() => refresh.mockImplementation(async () => {}));

  it('keeps Done while the re-fetch after the Ready save lands during the Done save', async () => {
    const { replies } = renderLiveRow();
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Ready' }));
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' }));
    await waitFor(() => expect(replies).toHaveLength(1));

    // Ready is saved and the list re-fetch brings Ready while Done is on the wire.
    await act(async () => replies[0]());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(replies).toHaveLength(2));
    expect(pill()).toHaveAttribute('data-status', 'done');

    await act(async () => replies[1]());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(pill()).toHaveAttribute('data-status', 'done');
  });

  it('follows the list again once the last pick has settled (negative control)', async () => {
    const { replies, setElsewhere } = renderLiveRow();
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' }));
    await waitFor(() => expect(replies).toHaveLength(1));
    await act(async () => replies[0]());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(pill()).toHaveAttribute('data-status', 'done');

    // Set to In Progress elsewhere; the list brings it and the row follows.
    setElsewhere('in_progress');
    expect(pill()).toHaveAttribute('data-status', 'in_progress');
  });

  it('keeps Done when the save went through but the re-fetch after it failed', async () => {
    // The Ready re-fetch lands; the Done save succeeds and only its re-fetch fails.
    const { replies, fetchList, setElsewhere } = renderLiveRow({ failRefresh: (n) => n === 2 });
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Ready' }));
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' }));
    await waitFor(() => expect(replies).toHaveLength(1));
    await act(async () => replies[0]());
    await waitFor(() => expect(replies).toHaveLength(2));
    await act(async () => replies[1]());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    // The list still says Ready (from the first re-fetch); the row keeps Done.
    expect(pill()).toHaveAttribute('data-status', 'done');

    // The next successful fetch brings Done and releases the pick: the row
    // follows the list again afterwards.
    fetchList();
    expect(pill()).toHaveAttribute('data-status', 'done');
    setElsewhere('in_progress');
    expect(pill()).toHaveAttribute('data-status', 'in_progress');
  });

  it('releases the pick once the re-fetch after the last save succeeds (negative control)', async () => {
    const { replies, setElsewhere } = renderLiveRow();
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Ready' }));
    openStatusSubmenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' }));
    await waitFor(() => expect(replies).toHaveLength(1));
    await act(async () => replies[0]());
    await waitFor(() => expect(replies).toHaveLength(2));
    await act(async () => replies[1]());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(pill()).toHaveAttribute('data-status', 'done');

    // Released: the list value is what shows now.
    setElsewhere('ready');
    expect(pill()).toHaveAttribute('data-status', 'ready');
  });
});

describe('WorktreeCard says where the status is changed (Issue #3594)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/components/worktree/WorktreeCard.tsx'), 'utf8');

  it('points at the row "…" Status menu and the Info field', () => {
    expect(source).toContain('branch row "…" → Status menu or the Info field');
  });

  it('no longer points at the detail header, which lost its select', () => {
    expect(source).not.toContain('editable in detail header');
  });
});

describe('Info field status select — failed save (Issue #3613)', () => {
  beforeEach(() => __resetWorktreeStatusSaves());
  afterEach(() => {
    __resetWorktreeStatusSaves();
    vi.unstubAllGlobals();
  });

  function renderInfoField(onWorktreeUpdate = vi.fn()) {
    const worktree = {
      id: 'wt-1',
      name: 'w',
      path: '/p',
      repositoryPath: '/r',
      status: 'in_progress',
    } as Worktree;
    render(
      <ToastProvider>
        <WorktreeInfoFields
          worktreeId="wt-1"
          worktree={worktree}
          cardClassName=""
          descriptionEditor={{
            isEditing: false,
            text: '',
            setText: vi.fn(),
            isSaving: false,
            handleSave: vi.fn(),
            handleCancel: vi.fn(),
            startEditing: vi.fn(),
          } as unknown as React.ComponentProps<typeof WorktreeInfoFields>['descriptionEditor']}
          showLogs={false}
          onToggleLogs={vi.fn()}
          onWorktreeUpdate={onWorktreeUpdate}
        />
      </ToastProvider>
    );
    return screen.getByTestId('mobile-status-dropdown') as HTMLSelectElement;
  }

  it('shows a toast and puts the old value back when the PATCH fails (positive)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const onUpdate = vi.fn();
    const select = renderInfoField(onUpdate);
    fireEvent.change(select, { target: { value: 'done' } });
    expect(await screen.findByText('Could not change the status')).toBeTruthy();
    expect(select.value).toBe('in_progress');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('shows no toast when the PATCH succeeds (negative)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'wt-1', status: 'done' }) }))
    );
    const onUpdate = vi.fn();
    const select = renderInfoField(onUpdate);
    fireEvent.change(select, { target: { value: 'done' } });
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Could not change the status')).toBeNull();
  });
});
