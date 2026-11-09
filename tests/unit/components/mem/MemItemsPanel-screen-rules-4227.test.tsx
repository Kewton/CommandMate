/**
 * The screen's five rules, per entrance (Issue #4227, design `mem-ui-4227.md` §2.4 the
 * table "画面の入口ごとの規則"; Codex 5-2b P2 ×5 and the PM review P2-1・P2-2・P3-1・P3-2・P3-4):
 *
 * (1) the version and every field as read are kept; (2) only the fields the person
 * changed are sent (an emptied evidence is `[]`); (3) the version read when the edit or
 * the close was opened is sent, and a conflict goes back to a comparison and an explicit
 * confirmation; (4) an unknown result (a timeout, a lost connection) keeps the request —
 * its content and its key — for the next press; (5) the buttons are read off the
 * transition table.
 *
 * The fake server applies what it is sent the way the store does (an omitted field is
 * kept, `[]` clears, the same key is the same item) and can apply a write and then lose
 * the answer. Each test fails on the screen of 8ccd61971 (the positive control, named
 * per test); the negative controls are in `MemItemsPanel-4227.test.tsx`, unchanged.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemItemsPanel, CLOSE_WHEN_REQUIRED_KINDS, editChanges, readSnapshot } from '@/components/mem/MemItemsPanel';
import { CLOSE_WHEN_DEFAULTS } from '@/lib/mem/close-when';
import { memScreenActions, memTransition } from '@/lib/mem/transitions';
import type { MemItemView, MemKind, MemState } from '@/types/mem';

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
  evidence: [],
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

type Op = 'add' | 'update' | 'close';
let items: MemItemView[];
let writes: Array<{ op: Op; url: string; body: Record<string, unknown> }>;
/** The next write of this op is applied and its answer lost (fetch rejects). */
let loseAnswer: Op | null;
/** The next add is refused with this body. */
let refuseAdd: { status: number; body: Record<string, unknown> } | null;
const byKey = new Map<string, MemItemView>();

const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;
const find = (id: string) => items.find((entry) => entry.id === id)!;
const put = (next: MemItemView) => (items = items.map((entry) => (entry.id === next.id ? next : entry)));
/** Another writer (an agent through A's API) changes an item while the screen is open. */
const agentWrites = (id: string, change: Partial<MemItemView>) => put({ ...find(id), ...change, version: find(id).version + 1, updatedBy: 'agent' });

beforeEach(() => {
  items = [
    item('n1', 'note', 'first note', { evidence: ['#10'] }),
    item('d1', 'decision', 'recorded one', { state: 'recorded', version: 2 }),
    item('d2', 'decision', 'reflected one', { state: 'promoted', version: 3 }),
    item('d3', 'decision', 'open one'),
  ];
  writes = [];
  loseAnswer = null;
  refuseAdd = null;
  byKey.clear();
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.startsWith('/api/worktrees?')) {
      return json(200, {
        repositories: [{ id: 'repo-1', path: '/repos/app', name: 'app' }],
        worktrees: [{ id: 'wt-1', name: 'wt-1', repositoryPath: '/repos/app', branch: 'feat/x', agentInstances: [{ id: 'claude', cliTool: 'claude' }] }],
      });
    }
    if (url.includes('/mem/mode')) return json(200, { ok: true, mode: 'on', source: { level: 'fallback' } });
    if (url.includes('/mem/notices')) return json(200, { ok: true, notices: [] });
    if (method === 'GET' && url.includes('/mem?')) {
      return json(200, { ok: true, mode: 'on', branch: 'feat/x', items: items.filter((entry) => entry.state !== 'closed'), now: [], warnings: [] });
    }
    const lose = (op: Op, answer: Response) => {
      writes.push({ op, url, body });
      if (loseAnswer === op) {
        loseAnswer = null;
        throw new TypeError('Failed to fetch');
      }
      return answer;
    };
    if (method === 'POST' && url.endsWith('/mem/screen/items')) {
      if (refuseAdd) {
        const refusal = refuseAdd;
        refuseAdd = null;
        writes.push({ op: 'add', url, body });
        return json(refusal.status, refusal.body);
      }
      const key = String(body.key);
      const again = byKey.get(key);
      if (again) return lose('add', json(200, { ok: true, item: again, replayed: true, warnings: [] }));
      const added = item(`a${items.length}`, body.kind as MemItemView['kind'], String(body.text), { createdBy: 'human', updatedBy: 'human' });
      byKey.set(key, added);
      items = [...items, added];
      return lose('add', json(201, { ok: true, item: added, replayed: false, warnings: [] }));
    }
    const patch = /\/mem\/screen\/items\/([^/]+)$/.exec(url);
    if (method === 'PATCH' && patch) {
      const target = find(patch[1]);
      if (target.version !== body.ifVersion) return lose('update', json(409, { ok: false, code: 'version_conflict', currentVersion: target.version, item: target }));
      // As the store: an omitted field is kept, `[]` clears.
      const next: MemItemView = {
        ...target,
        ...(body.text !== undefined ? { text: String(body.text) } : {}),
        ...(body.evidence !== undefined ? { evidence: body.evidence as string[] } : {}),
        version: target.version + 1,
        updatedBy: 'human',
      };
      put(next);
      return lose('update', json(200, { ok: true, item: next }));
    }
    const close = /\/mem\/screen\/items\/([^/]+)\/close$/.exec(url);
    if (method === 'POST' && close) {
      const target = find(close[1]);
      if (target.version !== body.ifVersion) return lose('close', json(409, { ok: false, code: 'version_conflict', currentVersion: target.version, item: target }));
      if (target.state === 'recorded' && body.confirmUnreflected !== true) return lose('close', json(409, { ok: false, code: 'confirmation_required' }));
      const next: MemItemView = { ...target, state: 'closed', version: target.version + 1, updatedBy: 'human' };
      put(next);
      return lose('close', json(201, { ok: true, item: next }));
    }
    return json(404, { ok: false, code: 'not_found' });
  }) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

const renderPanel = () => render(<MemItemsPanel repositoryId="repo-1" branch="feat/x" worktreeId={null} />);
const readAgain = () =>
  act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
const writesOf = (op: Op) => writes.filter((write) => write.op === op);

describe('[#4227] rule (1)・(2): the fields as read, and only the changed ones are sent (edit)', () => {
  it('a text-only edit sends no evidence; the evidence an agent added meanwhile survives the conflict and the save on top (P2-1, Codex P2 #2)', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('mem-item-edit-n1'));
    fireEvent.change(screen.getByTestId('mem-item-edit-text-n1'), { target: { value: 'mine' } });
    agentWrites('n1', { evidence: ['#10', '#11'] });
    fireEvent.click(screen.getByTestId('mem-item-save-n1'));
    await screen.findByTestId('mem-item-conflict-n1');
    // The conflict shows the evidence too, and what saving on top would send.
    expect(screen.getByTestId('mem-conflict-evidence-read').textContent).toContain('#10');
    expect(screen.getByTestId('mem-conflict-evidence-current').textContent).toContain('#11');
    expect(screen.getByTestId('mem-conflict-sends-n1').textContent).toContain('本文');
    expect(screen.getByTestId('mem-conflict-sends-n1').textContent).not.toContain('根拠');
    fireEvent.click(screen.getByTestId('mem-item-rebase-n1'));
    await waitFor(() => expect(screen.getByTestId('mem-item-text-n1').textContent).toBe('mine'));
    // 8ccd61971 sent `evidence: ['#10']` both times and erased the agent's #11.
    for (const write of writesOf('update')) expect(write.body).not.toHaveProperty('evidence');
    expect(writesOf('update').map((write) => write.body.ifVersion)).toEqual([1, 2]);
    expect(find('n1').evidence).toEqual(['#10', '#11']);
  });

  it('emptying the evidence sends `evidence: []` and clears it (Codex P2 #4)', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('mem-item-edit-n1'));
    fireEvent.change(screen.getByTestId('mem-item-edit-evidence-n1'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('mem-item-save-n1'));
    await waitFor(() => expect(find('n1').version).toBe(2));
    // 8ccd61971 omitted it, and the store kept #10 while the screen said "saved".
    expect(writesOf('update')[0].body).toEqual({ instanceId: 'claude', ifVersion: 1, evidence: [] });
    expect(find('n1').evidence).toEqual([]);
  });

  it('editChanges: unchanged → nothing; each changed field alone; the condition only when written', () => {
    const read = readSnapshot(item('x', 'note', 'body', { evidence: ['a', 'b'], version: 4 }));
    const draft = { itemId: 'x', read, ifVersion: 4, text: 'body', closeWhen: '', evidence: 'a, b' };
    expect(editChanges(draft)).toEqual({});
    expect(editChanges({ ...draft, text: 'other' })).toEqual({ text: 'other' });
    expect(editChanges({ ...draft, evidence: 'a' })).toEqual({ evidence: ['a'] });
    expect(editChanges({ ...draft, evidence: ' ' })).toEqual({ evidence: [] });
    expect(editChanges({ ...draft, closeWhen: ' manual ' })).toEqual({ closeWhen: 'manual' });
  });
});

describe('[#4227] rule (3): the version read when it was opened; a conflict goes back to an explicit confirmation', () => {
  it('edit: a read again while the editor is open does not replace its version (the save is a conflict, not a silent overwrite)', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('mem-item-edit-n1'));
    fireEvent.change(screen.getByTestId('mem-item-edit-text-n1'), { target: { value: 'mine' } });
    agentWrites('n1', { text: 'theirs' });
    await readAgain();
    await screen.findByTestId('mem-item-changed-n1');
    fireEvent.click(screen.getByTestId('mem-item-save-n1'));
    await screen.findByTestId('mem-item-conflict-n1');
    expect(writesOf('update')[0].body.ifVersion).toBe(1);
    expect(find('n1').text).toBe('theirs');
  });

  it('close: sends the version of when "close" was opened; a conflict shows both and closes only after "close again" (P3-1, Codex P2 #1)', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('mem-item-close-n1'));
    agentWrites('n1', { text: 'changed while confirming' });
    await readAgain();
    await screen.findByTestId('mem-item-changed-n1');
    fireEvent.click(screen.getByTestId('mem-item-close-confirm-n1'));
    await screen.findByTestId('mem-item-close-conflict-n1');
    // 8ccd61971 sent the row's version after the read (2) and closed what the person had not seen.
    expect(writesOf('close')[0].body.ifVersion).toBe(1);
    expect(find('n1').state).toBe('open');
    expect(screen.getByTestId('mem-close-conflict-read').textContent).toContain('first note');
    expect(screen.getByTestId('mem-close-conflict-current').textContent).toContain('changed while confirming');
    fireEvent.click(screen.getByTestId('mem-item-close-again-n1'));
    expect(writesOf('close')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('mem-item-close-confirm-n1'));
    await waitFor(() => expect(find('n1').state).toBe('closed'));
    expect(writesOf('close')[1].body.ifVersion).toBe(2);
  });

  it('close of a recorded decision: the steps start again after a conflict', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('mem-item-close-d1'));
    fireEvent.click(screen.getByTestId('mem-item-close-step1-d1'));
    // The version moved (a promote that failed and was put back, any write) while confirming.
    put({ ...find('d1'), version: 3 });
    fireEvent.click(screen.getByTestId('mem-item-close-confirm-d1'));
    fireEvent.click(await screen.findByTestId('mem-item-close-again-d1'));
    expect(screen.getByTestId('mem-item-close-step1-d1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mem-item-close-step1-d1'));
    fireEvent.click(screen.getByTestId('mem-item-close-confirm-d1'));
    await waitFor(() => expect(find('d1').state).toBe('closed'));
    expect(writesOf('close').map((write) => [write.body.ifVersion, write.body.confirmUnreflected])).toEqual([
      [2, true],
      [3, true],
    ]);
  });
});

describe('[#4227] rule (4): an unknown result keeps the request — its content and its key', () => {
  it('add: the answer is lost after the store wrote it → the next press sends the same content and key → one item (P2-2, Codex P2 #3)', async () => {
    renderPanel();
    await screen.findByTestId('mem-items-add');
    fireEvent.change(screen.getByTestId('mem-items-add-text'), { target: { value: 'once only' } });
    loseAnswer = 'add';
    fireEvent.click(screen.getByTestId('mem-items-add-submit'));
    await screen.findByTestId('mem-items-add-pending');
    expect(screen.getByTestId('mem-items-notice').textContent).toContain('結果が分かりません');
    // The input is held: what is sent again is the request that was sent.
    expect((screen.getByTestId('mem-items-add-text') as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('mem-items-add-submit'));
    await waitFor(() => expect(screen.queryByTestId('mem-items-add-pending')).toBeNull());
    const [first, second] = writesOf('add');
    // 8ccd61971 made a new key on the second press: a second item.
    expect(second.body).toEqual(first.body);
    expect(items.filter((entry) => entry.text === 'once only')).toHaveLength(1);
    expect((screen.getByTestId('mem-items-add-text') as HTMLTextAreaElement).value).toBe('');
  });

  it('add (control): a definite refusal is not "unknown" — the next press is a new request with a new key', async () => {
    renderPanel();
    await screen.findByTestId('mem-items-add');
    fireEvent.change(screen.getByTestId('mem-items-add-text'), { target: { value: 'refused first' } });
    refuseAdd = { status: 400, body: { ok: false, code: 'secret_like' } };
    fireEvent.click(screen.getByTestId('mem-items-add-submit'));
    await waitFor(() => expect(screen.getByTestId('mem-items-notice').textContent).toContain('秘密らしい'));
    expect(screen.queryByTestId('mem-items-add-pending')).toBeNull();
    fireEvent.click(screen.getByTestId('mem-items-add-submit'));
    await waitFor(() => expect(writesOf('add')).toHaveLength(2));
    expect(writesOf('add')[1].body.key).not.toBe(writesOf('add')[0].body.key);
  });

  it('edit: the answer is lost after the store wrote it → the same body is sent again and its own write is not shown as a conflict', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('mem-item-edit-n1'));
    fireEvent.change(screen.getByTestId('mem-item-edit-text-n1'), { target: { value: 'saved once' } });
    loseAnswer = 'update';
    fireEvent.click(screen.getByTestId('mem-item-save-n1'));
    await waitFor(() => expect(screen.getByTestId('mem-items-notice').textContent).toContain('結果が分かりません'));
    fireEvent.click(screen.getByTestId('mem-item-save-n1'));
    await waitFor(() => expect(screen.queryByTestId('mem-item-editor-n1')).toBeNull());
    expect(writesOf('update')[1].body).toEqual(writesOf('update')[0].body);
    expect(screen.queryByTestId('mem-item-conflict-n1')).toBeNull();
    expect(find('n1')).toMatchObject({ text: 'saved once', version: 2 });
  });

  it('close of a recorded decision: the answer is lost → the same request (its version and confirmUnreflected) is sent again', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('mem-item-close-d1'));
    fireEvent.click(screen.getByTestId('mem-item-close-step1-d1'));
    loseAnswer = 'close';
    fireEvent.click(screen.getByTestId('mem-item-close-confirm-d1'));
    await waitFor(() => expect(screen.getByTestId('mem-items-notice').textContent).toContain('結果が分かりません'));
    fireEvent.click(screen.getByTestId('mem-item-close-confirm-d1'));
    await waitFor(() => expect(screen.queryByTestId('mem-item-close-conflict-d1')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('mem-item-d1')).toBeNull());
    expect(writesOf('close')[1].body).toEqual(writesOf('close')[0].body);
    expect(writesOf('close')[0].body).toMatchObject({ ifVersion: 2, confirmUnreflected: true });
  });
});

describe('[#4227] rule (5): the buttons are read off the transition table (P3-2, Codex P2 #5)', () => {
  it('a recorded decision has no edit; a promoted one closes as "close"; an open one withdraws', async () => {
    renderPanel();
    // The write buttons come once the worktree and its roster are read.
    await screen.findByTestId('mem-item-edit-d3');
    // 8ccd61971 offered an edit the store always refuses (state_forbids).
    expect(screen.queryByTestId('mem-item-edit-d1')).toBeNull();
    expect(screen.queryByTestId('mem-item-edit-d2')).toBeNull();
    // 8ccd61971 called the promoted decision's close a withdrawal (it is `manual`).
    expect(screen.getByTestId('mem-item-close-d2').textContent).toBe('close');
    expect(screen.getByTestId('mem-item-close-d3').textContent).toBe('取り下げる');
    expect(screen.getByTestId('mem-item-close-d1').textContent).toBe('取り下げる');
    fireEvent.click(screen.getByTestId('mem-item-close-d2'));
    expect(screen.getByTestId('mem-item-close-confirm-d2').textContent).toBe('close');
  });

  it('memScreenActions agrees with memTransition for every kind and state', () => {
    const kinds: MemKind[] = ['waiting', 'decision', 'next', 'external', 'note', 'now'];
    const states: MemState[] = ['open', 'recorded', 'promoted', 'closed'];
    for (const kind of kinds) {
      for (const state of states) {
        const actions = memScreenActions(kind, state);
        if (kind === 'now') {
          expect(actions).toEqual({ edit: false, close: null });
          continue;
        }
        expect(actions.edit).toBe(memTransition(kind, state, 'update').ok);
        const close = memTransition(kind, state, 'close');
        const recorded = memTransition(kind, state, 'withdraw-recorded');
        expect(actions.close !== null).toBe(close.ok || (kind === 'decision' && recorded.ok));
        if (actions.close) {
          const step = actions.close.transition === 'close' ? close : recorded;
          expect(step.ok && step.reason === 'withdrawn').toBe(actions.close.withdraw);
        }
      }
    }
  });
});

describe('[#4227] the close condition a kind needs (P3-4)', () => {
  it('the screen’s required kinds are A’s kinds without a default', () => {
    const required = (Object.keys(CLOSE_WHEN_DEFAULTS) as MemKind[]).filter((kind) => CLOSE_WHEN_DEFAULTS[kind] === null).sort();
    expect([...CLOSE_WHEN_REQUIRED_KINDS].sort()).toEqual(required);
  });

  it('marks the field required for waiting, not for note; a refusal says a condition is required', async () => {
    renderPanel();
    await screen.findByTestId('mem-items-add');
    expect(screen.queryByTestId('mem-items-add-close-when-required')).toBeNull();
    fireEvent.change(screen.getByTestId('mem-items-add-kind'), { target: { value: 'waiting' } });
    expect(screen.getByTestId('mem-items-add-close-when-required').textContent).toContain('必須');
    expect(screen.getByTestId('mem-items-add-close-when').getAttribute('placeholder')).toContain('必須');
    fireEvent.change(screen.getByTestId('mem-items-add-text'), { target: { value: 'wait for it' } });
    refuseAdd = { status: 400, body: { ok: false, code: 'invalid_close_when', field: 'closeWhen', reason: 'required' } };
    fireEvent.click(screen.getByTestId('mem-items-add-submit'));
    await waitFor(() => expect(screen.getByTestId('mem-items-notice').textContent).toContain('閉じる条件が要ります'));
  });
});
