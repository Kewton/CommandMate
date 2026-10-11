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
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { BranchListItem, __resetMouseEnterSuppression } from '@/components/sidebar/BranchListItem';
import { DesktopHeader, WorktreeInfoFields } from '@/components/worktree/WorktreeDetailSubComponents';
import { ToastProvider } from '@/components/common/Toast';
import { toBranchItem, type SidebarBranchItem } from '@/types/sidebar';
import type { Worktree } from '@/types/models';
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
