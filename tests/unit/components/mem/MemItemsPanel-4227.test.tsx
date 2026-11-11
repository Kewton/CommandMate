/**
 * The items screen (Issue #4227, design `mem-ui-4227.md` §2.2・§2.4): the list, add,
 * edit, close, the conflict laid side by side, the stale mark, the mode's freeze and
 * the notices. A fake server in `fetch` keeps the items and their versions.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemItemsPanel } from '@/components/mem/MemItemsPanel';
import { SCREEN_CLIENT_HEADER } from '@/lib/security/screen-request';
import type { MemItemView, MemMode } from '@/types/mem';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

const owner = {
  repositoryId: 'repo-1',
  branch: 'feat/x',
  worktreeId: 'wt-1',
  worktreeIncarnation: 'wi',
  instanceId: 'claude',
  cliToolId: 'claude',
  incarnation: 'ii',
  sessionGeneration: null,
};
const item = (id: string, kind: MemItemView['kind'], text: string, extra: Partial<MemItemView> = {}): MemItemView => ({
  id,
  kind,
  state: 'open',
  text,
  closeWhen: null,
  owner,
  createdBy: 'agent',
  updatedBy: 'agent',
  version: 1,
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
  closedAt: null,
  closeReason: null,
  stale: false,
  frozen: false,
  ...extra,
});

let mode: MemMode;
let items: MemItemView[];
let writes: Array<{ method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> }>;
/** The next PATCH answers 409 with this item instead of saving. */
let conflictOnce: MemItemView | null;

const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;

beforeEach(() => {
  mode = 'on';
  items = [item('n1', 'note', 'first note'), item('d1', 'decision', 'recorded one', { state: 'recorded', version: 2 })];
  writes = [];
  conflictOnce = null;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method !== 'GET') writes.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body });
    if (url.startsWith('/api/worktrees?')) {
      return json(200, {
        repositories: [{ id: 'repo-1', path: '/repos/app', name: 'app' }],
        worktrees: [
          { id: 'wt-1', name: 'wt-1', repositoryPath: '/repos/app', branch: 'feat/x', agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude' }] },
          { id: 'wt-other', name: 'other', repositoryPath: '/elsewhere', branch: 'feat/x' },
        ],
      });
    }
    if (url.includes('/mem/mode')) {
      return json(200, { ok: true, mode, source: { level: 'rule', repositoryId: 'repo-1', branch: null, rulePosition: 0, pattern: 'feat/*' } });
    }
    if (url.includes('/mem/notices') && method === 'GET') {
      return json(200, { ok: true, notices: [{ id: 'nt1', itemId: 'w9', endReason: 'pr-merged', outcome: 'success', version: 3, uncertain: false }] });
    }
    if (url.includes('/acknowledge')) return json(200, { ok: true });
    if (method === 'GET' && url.includes('/mem?')) {
      if (mode === 'off') return json(409, { ok: false, code: 'disabled', mode: 'off' });
      return json(200, { ok: true, mode, branch: 'feat/x', items: items.map((entry) => ({ ...entry, frozen: mode === 'derived' })), now: [], warnings: [] });
    }
    if (method === 'POST' && url.endsWith('/mem/screen/items')) {
      const added = item(`a${items.length}`, body.kind as MemItemView['kind'], String(body.text), { createdBy: 'human', updatedBy: 'human' });
      items = [...items, added];
      return json(201, { ok: true, item: added, replayed: false, warnings: [] });
    }
    const patch = /\/mem\/screen\/items\/([^/]+)$/.exec(url);
    if (method === 'PATCH' && patch) {
      if (conflictOnce) {
        const current = conflictOnce;
        conflictOnce = null;
        return json(409, { ok: false, code: 'version_conflict', currentVersion: current.version, item: current });
      }
      const target = items.find((entry) => entry.id === patch[1])!;
      if (target.version !== body.ifVersion) return json(409, { ok: false, code: 'version_conflict', item: target });
      const next = { ...target, text: String(body.text), version: target.version + 1, updatedBy: 'human' as const };
      items = items.map((entry) => (entry.id === target.id ? next : entry));
      return json(200, { ok: true, item: next });
    }
    const close = /\/mem\/screen\/items\/([^/]+)\/close$/.exec(url);
    if (method === 'POST' && close) {
      const target = items.find((entry) => entry.id === close[1])!;
      const next = { ...target, state: 'closed' as const, version: target.version + 1 };
      items = items.filter((entry) => entry.id !== target.id);
      return json(201, { ok: true, item: next });
    }
    return json(404, { ok: false, code: 'not_found' });
  }) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

const renderPanel = () => render(<MemItemsPanel repositoryId="repo-1" branch="feat/x" worktreeId={null} />);

describe('[#4227] the items screen', () => {
  it('lists by kind, picks the worktree of this branch and repository, and marks a recorded decision unreflected', async () => {
    renderPanel();
    await screen.findByTestId('mem-item-n1');
    expect(screen.getByTestId('mem-items-section-note')).toBeInTheDocument();
    expect(screen.getByTestId('mem-item-unreflected-d1').textContent).toContain('未反映');
    await waitFor(() => expect((screen.getByTestId('mem-items-worktree') as HTMLSelectElement).value).toBe('wt-1'));
    expect(screen.getByTestId('mem-items-mode').textContent).toContain('feat/*');
    // Only the worktrees of this repository are offered.
    expect(within(screen.getByTestId('mem-items-worktree')).queryByText(/other/)).toBeNull();
  });

  it('adds with the mark, a key and the branch shown; the writer is the person', async () => {
    renderPanel();
    await screen.findByTestId('mem-items-add');
    fireEvent.change(screen.getByTestId('mem-items-add-text'), { target: { value: 'person note' } });
    fireEvent.click(screen.getByTestId('mem-items-add-submit'));
    await screen.findByText('person note');
    expect(writes[0]).toMatchObject({
      method: 'POST',
      url: '/api/worktrees/wt-1/mem/screen/items',
      headers: { [SCREEN_CLIENT_HEADER]: 'screen' },
      body: { instanceId: 'claude', kind: 'note', text: 'person note', expectBranch: 'feat/x' },
    });
    expect(String(writes[0].body.key)).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  });

  it('edits with the version read', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('mem-item-edit-n1'));
    fireEvent.change(screen.getByTestId('mem-item-edit-text-n1'), { target: { value: 'edited' } });
    fireEvent.click(screen.getByTestId('mem-item-save-n1'));
    await waitFor(() => expect(screen.getByTestId('mem-item-text-n1').textContent).toBe('edited'));
    expect(writes[0]).toMatchObject({ method: 'PATCH', url: '/api/worktrees/wt-1/mem/screen/items/n1', headers: { [SCREEN_CLIENT_HEADER]: 'screen' }, body: { ifVersion: 1, text: 'edited' } });
  });

  it('a conflict lays the draft, the value read and the value now side by side; saving again is the person’s press', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('mem-item-edit-n1'));
    fireEvent.change(screen.getByTestId('mem-item-edit-text-n1'), { target: { value: 'mine' } });
    conflictOnce = { ...items[0], text: 'theirs', version: 2 };
    items = items.map((entry) => (entry.id === 'n1' ? { ...entry, text: 'theirs', version: 2 } : entry));
    fireEvent.click(screen.getByTestId('mem-item-save-n1'));
    await screen.findByTestId('mem-item-conflict-n1');
    expect(screen.getByTestId('mem-conflict-draft').textContent).toBe('mine');
    expect(screen.getByTestId('mem-conflict-read').textContent).toBe('first note');
    expect(screen.getByTestId('mem-conflict-current').textContent).toBe('theirs');
    expect(writes).toHaveLength(1);
    fireEvent.click(screen.getByTestId('mem-item-rebase-n1'));
    await waitFor(() => expect(screen.getByTestId('mem-item-text-n1').textContent).toBe('mine'));
    expect(writes[1]).toMatchObject({ method: 'PATCH', body: { ifVersion: 2, text: 'mine' } });
  });

  it('discarding the draft after a conflict sends nothing', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('mem-item-edit-n1'));
    conflictOnce = { ...items[0], text: 'theirs', version: 2 };
    fireEvent.click(screen.getByTestId('mem-item-save-n1'));
    fireEvent.click(await screen.findByTestId('mem-item-discard-n1'));
    expect(screen.queryByTestId('mem-item-conflict-n1')).toBeNull();
    expect(writes).toHaveLength(1);
  });

  it('a recorded decision closes only after the two-step confirmation, with confirmUnreflected', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('mem-item-close-d1'));
    expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByTestId('mem-item-close-step1-d1'));
    expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByTestId('mem-item-close-confirm-d1'));
    await waitFor(() => expect(screen.queryByTestId('mem-item-d1')).toBeNull());
    expect(writes[0]).toMatchObject({ method: 'POST', url: '/api/worktrees/wt-1/mem/screen/items/d1/close', body: { ifVersion: 2, confirmUnreflected: true } });
  });

  it('an open item closes without the unreflected confirmation', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('mem-item-close-n1'));
    fireEvent.click(screen.getByTestId('mem-item-close-confirm-n1'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.confirmUnreflected).toBeUndefined();
  });

  it('derived: frozen, no write buttons', async () => {
    mode = 'derived';
    renderPanel();
    await screen.findByTestId('mem-item-n1');
    expect(screen.getByText(/凍結中/)).toBeInTheDocument();
    expect(screen.queryByTestId('mem-item-edit-n1')).toBeNull();
    expect(screen.queryByTestId('mem-items-add')).toBeNull();
  });

  it('off: no list, says the items are kept', async () => {
    mode = 'off';
    renderPanel();
    await screen.findByText(/項目は保持されていますが表示しません/);
    expect(screen.queryByTestId('mem-items-list')).toBeNull();
  });

  it('read again on focus: a row whose version moved is marked updated', async () => {
    renderPanel();
    await screen.findByTestId('mem-item-n1');
    expect(screen.queryByTestId('mem-item-changed-n1')).toBeNull();
    items = items.map((entry) => (entry.id === 'n1' ? { ...entry, text: 'by the agent', version: 2 } : entry));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await screen.findByTestId('mem-item-changed-n1');
    expect(screen.getByTestId('mem-item-text-n1').textContent).toBe('by the agent');
  });

  it('takes an undelivered notice with the mark and its version', async () => {
    renderPanel();
    const row = await screen.findByTestId('mem-notice-nt1');
    fireEvent.click(within(row).getByRole('button'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ url: '/api/repositories/repo-1/mem/notices/nt1/acknowledge', headers: { [SCREEN_CLIENT_HEADER]: 'screen' }, body: { ifVersion: 3 } });
  });
});

// G-PR3: the panel's units live in the hand-off's module store now; each test starts from an empty one.
afterEach(() => resetHandoffStoreForTests());
