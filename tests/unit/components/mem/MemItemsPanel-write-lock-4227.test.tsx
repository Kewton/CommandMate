/**
 * Rule (4)(e) of the screen (Issue #4227, design `mem-ui-4227.md` §2.4.1 and §11.11; the PM's
 * rule after Codex review-4227-pr1e P2): while a unit is being sent or its result is unknown,
 * no write other than that unit's own resend or drop can be made, and the unit's fields do not
 * change. Reading again and changing the selection stay (they only read); a selection off the
 * unit's destination still cannot resend it (rule (4)(a)).
 *
 * Not one scenario per review: a table of the operation of the unit (add・edit・close) × its
 * state (sending・unknown) × the other operation (add・edit・close・a change of the unit's field・
 * a change of the selection・a read again). Every row checks that no write but the unit's own is
 * sent, that the unit's field shows what was sent, and that the resend sends the same request
 * to the same place.
 *
 * Positive control: on f2f3e2d28 the rows "unknown × add/edit/close" sent the other write, and
 * "sending × input" showed the changed add while resending the one sent (Codex review-4227-pr1e
 * P2). Removing the guard (`lock` always null) fails the rows — checked by hand, see the commit.
 * The negative control (after the unit settles, the other writes work again) is the last describe.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemItemsPanel } from '@/components/mem/MemItemsPanel';
import { publishMemWriteLock } from '@/components/mem/mem-write-lock';
import type { MemItemView } from '@/types/mem';

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
/** The next write of this op is applied, then its answer waits for `release` and is lost. */
let hold: Op | null;
let release: (() => void) | null;
/** The next write of this op is applied and its answer lost at once. */
let loseAnswer: Op | null;
const byKey = new Map<string, MemItemView>();
/** Issue #4227 G-PR2 (PM P3-3): the branch's mode on the server; a write while it is not `on` is refused. */
let serverMode: 'on' | 'off' = 'on';

const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;
const find = (id: string) => items.find((entry) => entry.id === id)!;
const put = (next: MemItemView) => (items = items.map((entry) => (entry.id === next.id ? next : entry)));

beforeEach(() => {
  items = [item('n1', 'note', 'first note'), item('d3', 'decision', 'open one')];
  writes = [];
  hold = null;
  release = null;
  loseAnswer = null;
  byKey.clear();
  serverMode = 'on';
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.startsWith('/api/worktrees?')) {
      return json(200, {
        repositories: [{ id: 'repo-1', path: '/repos/app', name: 'app' }],
        worktrees: [
          { id: 'wt-1', name: 'wt-1', repositoryPath: '/repos/app', branch: 'feat/x', agentInstances: [{ id: 'claude', cliTool: 'claude' }] },
          { id: 'wt-2', name: 'wt-2', repositoryPath: '/repos/app', branch: 'feat/x', agentInstances: [{ id: 'codex', cliTool: 'codex' }] },
        ],
      });
    }
    if (url.includes('/mem/mode')) return json(200, { ok: true, mode: serverMode, source: { level: 'fallback' } });
    if (url.includes('/mem/notices')) return json(200, { ok: true, notices: [] });
    if (method === 'GET' && url.includes('/mem?')) {
      return json(200, { ok: true, mode: 'on', branch: 'feat/x', items: items.filter((entry) => entry.state !== 'closed'), now: [], warnings: [] });
    }
    const answer = async (op: Op, response: Response) => {
      writes.push({ op, url, body });
      if (serverMode !== 'on') return json(409, { ok: false, code: 'disabled', mode: serverMode });
      if (hold === op) {
        hold = null;
        await new Promise<void>((resolve) => (release = resolve));
        throw new TypeError('Failed to fetch');
      }
      if (loseAnswer === op) {
        loseAnswer = null;
        throw new TypeError('Failed to fetch');
      }
      return response;
    };
    if (method === 'POST' && url.endsWith('/mem/screen/items')) {
      const key = `${url}|${String(body.instanceId)}|${String(body.key)}`;
      const again = byKey.get(key);
      if (again) return answer('add', json(200, { ok: true, item: again, replayed: true, warnings: [] }));
      const added = item(`a${items.length}`, body.kind as MemItemView['kind'], String(body.text), { createdBy: 'human', updatedBy: 'human' });
      byKey.set(key, added);
      items = [...items, added];
      return answer('add', json(201, { ok: true, item: added, replayed: false, warnings: [] }));
    }
    const patch = /\/mem\/screen\/items\/([^/]+)$/.exec(url);
    if (method === 'PATCH' && patch) {
      const target = find(patch[1]);
      if (target.version !== body.ifVersion) return answer('update', json(409, { ok: false, code: 'version_conflict', currentVersion: target.version, item: target }));
      const next: MemItemView = {
        ...target,
        ...(body.text !== undefined ? { text: String(body.text) } : {}),
        version: target.version + 1,
        updatedBy: 'human',
      };
      put(next);
      return answer('update', json(200, { ok: true, item: next }));
    }
    const close = /\/mem\/screen\/items\/([^/]+)\/close$/.exec(url);
    if (method === 'POST' && close) {
      const target = find(close[1]);
      if (target.version !== body.ifVersion) return answer('close', json(409, { ok: false, code: 'version_conflict', currentVersion: target.version, item: target }));
      const next: MemItemView = { ...target, state: 'closed', version: target.version + 1, updatedBy: 'human' };
      put(next);
      return answer('close', json(201, { ok: true, item: next }));
    }
    return json(404, { ok: false, code: 'not_found' });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  release?.();
  vi.restoreAllMocks();
});

const renderPanel = () => render(<MemItemsPanel repositoryId="repo-1" branch="feat/x" worktreeId={null} />);
const readAgain = () =>
  act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
const writesOf = (op: Op) => writes.filter((write) => write.op === op);
const button = (testId: string) => screen.queryByTestId(testId) as HTMLButtonElement | null;
/** Presses a button if it is there (a disabled one sends nothing). */
const press = (testId: string) => {
  const target = button(testId);
  if (target) fireEvent.click(target);
};
const type = (testId: string, value: string) => {
  const target = screen.queryByTestId(testId);
  if (target) fireEvent.change(target, { target: { value } });
};

type UnitOp = 'add' | 'edit' | 'close';
type State = 'sending' | 'unknown';
type Other = 'add' | 'edit' | 'close' | 'input' | 'select' | 'reload';

/** Where each unit's field and resend are, and the op its writes are. */
const UNIT: Record<UnitOp, { op: Op; field: string; resend: string }> = {
  add: { op: 'add', field: 'mem-items-add-text', resend: 'mem-items-add-submit' },
  edit: { op: 'update', field: 'mem-item-edit-text-n1', resend: 'mem-item-save-n1' },
  close: { op: 'close', field: 'mem-item-close-reason-n1', resend: 'mem-item-close-confirm-n1' },
};

/** Sends the unit's first request with the field set to 'A'. */
async function startUnit(unit: UnitOp, state: State) {
  const spec = UNIT[unit];
  if (state === 'sending') hold = spec.op;
  else loseAnswer = spec.op;
  if (unit === 'add') {
    // Another item's edit is open before the add: its save is the "other edit" to try.
    press('mem-item-edit-d3');
    type('mem-item-edit-text-d3', 'other edit');
  } else if (unit === 'edit') {
    press('mem-item-edit-n1');
  } else {
    press('mem-item-close-n1');
  }
  type(spec.field, 'A');
  press(spec.resend);
  if (state === 'sending') {
    await waitFor(() => expect(release).not.toBeNull());
    expect(screen.getByTestId('mem-items-write-locked').textContent).toContain('送信中');
  } else {
    await waitFor(() => expect(screen.getByTestId('mem-items-notice').textContent).toContain('結果が分かりません'));
    expect(screen.getByTestId('mem-items-write-locked').textContent).toContain('結果が分からない要求');
  }
}

/** The other operation, tried as a person would: every write it could make is pressed. */
async function tryOther(unit: UnitOp, other: Other) {
  switch (other) {
    case 'add':
      type('mem-items-add-text', 'other add');
      if (unit !== 'add') press('mem-items-add-submit');
      break;
    case 'edit':
      // d3's edit: opened now (an edit or close unit), or open since before the add.
      press('mem-item-edit-d3');
      type('mem-item-edit-text-d3', 'other edit');
      press('mem-item-save-d3');
      break;
    case 'close':
      press('mem-item-close-d3');
      press('mem-item-close-confirm-d3');
      break;
    case 'input':
      type(UNIT[unit].field, 'B');
      break;
    case 'select':
      fireEvent.change(screen.getByTestId('mem-items-worktree'), { target: { value: 'wt-2' } });
      await waitFor(() => expect((screen.getByTestId('mem-items-worktree') as HTMLSelectElement).value).toBe('wt-2'));
      break;
    case 'reload':
      await readAgain();
      break;
  }
}

const UNITS: UnitOp[] = ['add', 'edit', 'close'];
const STATES: State[] = ['sending', 'unknown'];
const OTHERS: Other[] = ['add', 'edit', 'close', 'input', 'select', 'reload'];
const ROWS = UNITS.flatMap((unit) => STATES.flatMap((state) => OTHERS.map((other) => [unit, state, other] as const)));

describe('[#4227] rule (4)(e): while a unit is sent or unknown, nothing else is written (the PM rule, Codex review-4227-pr1e P2)', () => {
  it.each(ROWS)('unit %s × %s × other %s: only the unit’s own request is sent, as it was, and its field does not change', async (unit, state, other) => {
    const spec = UNIT[unit];
    renderPanel();
    await screen.findByTestId('mem-item-edit-d3');
    await startUnit(unit, state);
    const first = writes[0];
    expect(writes).toHaveLength(1);

    await tryOther(unit, other);
    // Nothing but the unit's own request was sent.
    expect(writes).toHaveLength(1);
    if (unit === 'add' && state === 'sending' && (other === 'input' || other === 'add')) {
      // Before the answer (rule (4)(e), the add's own field while sending): read-only, still the value sent.
      const sendingField = screen.getByTestId(spec.field) as HTMLInputElement;
      expect(sendingField.disabled).toBe(true);
      expect(sendingField.value).toBe('A');
    }
    if (other === 'select') {
      // Off the unit's destination it cannot be resent (rule (4)(a)): pressing sends nothing.
      press(spec.resend);
      expect(writes).toHaveLength(1);
    }

    if (state === 'sending') {
      await act(async () => release?.());
      await waitFor(() => expect(screen.getByTestId('mem-items-notice').textContent).toContain('結果が分かりません'));
    }
    if (other === 'select') {
      press(`mem-items-pending-return-${unit === 'add' ? 'add' : `${spec.op}:n1`}`);
      await waitFor(() => expect((screen.getByTestId('mem-items-worktree') as HTMLSelectElement).value).toBe('wt-1'));
    }
    expect(writes).toHaveLength(1);
    // The unit's field shows what was sent and stays read-only (Codex review-4227-pr1e P2: it showed 'B').
    const field = screen.getByTestId(spec.field) as HTMLInputElement;
    expect(field.value).toBe('A');
    expect(field.disabled).toBe(true);
    type(spec.field, 'C');
    expect((screen.getByTestId(spec.field) as HTMLInputElement).value).toBe('A');

    // The resend sends the same request to the same place; no other write went in between.
    press(spec.resend);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.map((write) => write.op)).toEqual([spec.op, spec.op]);
    expect(writes[1].url).toBe(first.url);
    expect(writes[1].body).toEqual(first.body);
    expect(find('d3')).toMatchObject({ text: 'open one', state: 'open', version: 1 });
    expect(items.filter((entry) => entry.text === 'other add')).toHaveLength(0);
  });
});

describe('[#4227] rule (4)(e) (controls): what the lock leaves, and what comes back after it', () => {
  it('without a unit nothing is locked: no reason is shown, and another item’s edit and the add both write', async () => {
    renderPanel();
    await screen.findByTestId('mem-item-edit-d3');
    expect(screen.queryByTestId('mem-items-write-locked')).toBeNull();
    press('mem-item-edit-d3');
    type('mem-item-edit-text-d3', 'free edit');
    press('mem-item-save-d3');
    await waitFor(() => expect(find('d3').text).toBe('free edit'));
    type('mem-items-add-text', 'free add');
    press('mem-items-add-submit');
    await waitFor(() => expect(items.some((entry) => entry.text === 'free add')).toBe(true));
  });

  it('the unit’s own drop stays pressable while it is unknown; after it the lock is gone and the other writes work', async () => {
    renderPanel();
    await screen.findByTestId('mem-item-edit-d3');
    await startUnit('close', 'unknown');
    expect(button('mem-item-unit-discard-close:n1')?.disabled).toBe(false);
    expect(button('mem-item-edit-d3')?.disabled).toBe(true);
    expect(button('mem-items-add-submit')?.disabled).toBe(true);
    press('mem-item-unit-discard-close:n1');
    await waitFor(() => expect(screen.queryByTestId('mem-items-write-locked')).toBeNull());
    press('mem-item-edit-d3');
    type('mem-item-edit-text-d3', 'after the drop');
    press('mem-item-save-d3');
    await waitFor(() => expect(find('d3').text).toBe('after the drop'));
    expect(writes.map((write) => write.op)).toEqual(['close', 'update']);
  });

  it('"save on top" and "close again" of a comparison wait for a unit too (PM review P3-3), and work once it is resent', async () => {
    renderPanel();
    await screen.findByTestId('mem-item-edit-d3');
    // A comparison on n1 (another writer moved it).
    press('mem-item-edit-n1');
    type('mem-item-edit-text-n1', 'mine');
    put({ ...find('n1'), text: 'theirs', version: 2 });
    press('mem-item-save-n1');
    await screen.findByTestId('mem-item-conflict-n1');
    // A unit on d3's close.
    loseAnswer = 'close';
    press('mem-item-close-d3');
    press('mem-item-close-confirm-d3');
    await waitFor(() => expect(screen.getByTestId('mem-items-notice').textContent).toContain('結果が分かりません'));
    expect(button('mem-item-rebase-n1')?.disabled).toBe(true);
    press('mem-item-rebase-n1');
    expect(writes.map((write) => write.op)).toEqual(['update', 'close']);
    press('mem-item-close-confirm-d3');
    await screen.findByTestId('mem-item-close-conflict-d3');
    // The unit settled into a comparison (not a unit): "save on top" is pressable and saves.
    await waitFor(() => expect(button('mem-item-rebase-n1')?.disabled).toBe(false));
    press('mem-item-rebase-n1');
    await waitFor(() => expect(find('n1').text).toBe('mine'));
  });

  it('"save on top" cannot be pressed with a selection that cannot write (PM review P3-3)', async () => {
    renderPanel();
    await screen.findByTestId('mem-item-edit-n1');
    press('mem-item-edit-n1');
    type('mem-item-edit-text-n1', 'mine');
    put({ ...find('n1'), text: 'theirs', version: 2 });
    press('mem-item-save-n1');
    await screen.findByTestId('mem-item-conflict-n1');
    fireEvent.change(screen.getByTestId('mem-items-worktree'), { target: { value: '' } });
    await waitFor(() => expect(button('mem-item-rebase-n1')?.disabled).toBe(true));
    press('mem-item-rebase-n1');
    expect(writesOf('update')).toHaveLength(1);
  });
});

/**
 * Issue #4227 G-PR2 (PM P3-3): the hand-off's approval (G-4) writes items too, so its decide being
 * sent or unknown is a unit of the same lock: the panel writes nothing while it is there, and writes
 * again once it settles. The rows are the other screen's state × the panel's writes. The decide's
 * own side (the panel's unit locks approve / discard) is `SessionHandoffDialog-4227.test.tsx`.
 * A notice's acknowledgement and the mode's settings stay outside the lock (they write no item).
 */
describe('[#4227] rule (4)(e) across screens: the hand-off’s decide locks the panel (PM P3-3)', () => {
  afterEach(() => publishMemWriteLock('handoff', null));

  const ACROSS = (['sending', 'unknown'] as const).flatMap((state) => (['add', 'edit', 'close'] as const).map((other) => [state, other] as const));

  it.each(ACROSS)('the decide %s × the panel’s %s: nothing is sent, the reason is shown; after it settles the write goes', async (state, other) => {
    renderPanel();
    await screen.findByTestId('mem-item-edit-d3');
    act(() => publishMemWriteLock('handoff', state));
    await screen.findByTestId('mem-items-write-locked');
    expect(screen.getByTestId('mem-items-write-locked').textContent).toContain('引き継ぎ');
    // The panel's own writes, as a person would press them (`edit` here only picks which ones `tryOther` presses).
    await tryOther('edit', other);
    expect(writes).toHaveLength(0);
    act(() => publishMemWriteLock('handoff', null));
    await waitFor(() => expect(screen.queryByTestId('mem-items-write-locked')).toBeNull());
    press('mem-item-edit-n1');
    type('mem-item-edit-text-n1', 'after the decide');
    press('mem-item-save-n1');
    await waitFor(() => expect(find('n1').text).toBe('after the decide'));
  });

  it('the mode set off while a unit is unknown: the resend is refused by the server (disabled) and the reason is shown', async () => {
    renderPanel();
    await screen.findByTestId('mem-item-edit-d3');
    await startUnit('close', 'unknown');
    serverMode = 'off';
    press(UNIT.close.resend);
    await waitFor(() => expect(writes).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('mem-items-notice').textContent).toContain('on ではありません'));
    expect(find('n1').state).toBe('closed');
  });
});
