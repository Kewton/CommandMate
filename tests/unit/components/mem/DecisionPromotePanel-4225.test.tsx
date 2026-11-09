/**
 * The one screen of the promote path (Issue #4225, design §4.1): the warning of a
 * decision recorded but not reflected, the diff shown before anything is written, and
 * every write carrying the screen's mark. Nothing is written until "承認して書く".
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DecisionPromotePanel } from '@/components/mem/DecisionPromotePanel';
import { SCREEN_CLIENT_HEADER } from '@/lib/security/screen-request';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

const view = (id: string, state: string) => ({
  id,
  kind: 'decision',
  state,
  text: `決定 ${id}`,
  closeWhen: null,
  promoteTo: 'issue:#1',
  quote: null,
  quoteAt: null,
  evidence: [],
  closeNote: null,
  owner: {},
  createdBy: 'agent',
  updatedBy: 'agent',
  version: 1,
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
  closedAt: null,
  closeReason: null,
  stale: false,
  frozen: false,
});

const PREVIEW = {
  id: 'p1',
  operationId: 'op1',
  itemId: 'd-open',
  itemVersion: 1,
  destination: { kind: 'issue_comment', ref: 'issue', host: 'github.com', owner: 'o', repo: 'r', number: 1 },
  baseFingerprint: 'b',
  body: '<!-- commandmate-promote:op=op1; item=d-open -->\n本文の全文',
  bodySha256: 's',
  effect: 'spec',
  quoteOrigin: 'none',
  invisibleReplaced: false,
  acknowledgedOperationIds: [],
  poster: { id: 1, login: 'a' },
  createdAt: '2026-11-09T00:00:00.000Z',
  expiresAt: '2026-11-09T00:30:00.000Z',
};

let calls: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }>;
/** Added to the list's body (5-2b P2-2: the unsettled operations of a closed or purged item). */
let listExtra: Record<string, unknown>;
/** Answers a POST instead of the default (PM review): undefined → the default answer. */
let postAnswer: ((url: string, body: unknown) => Promise<{ status: number; body: unknown } | undefined>) | undefined;

beforeEach(() => {
  calls = [];
  listExtra = {};
  postAnswer = undefined;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          mode: 'on',
          branch: 'feature/x',
          decisions: [
            { item: view('d-open', 'open'), unreflected: false, operations: [] },
            { item: view('d-rec', 'recorded'), unreflected: true, operations: [] },
          ],
          worktrees: [{ id: 'wt', path: '/w', name: 'wt', branch: 'feature/x' }],
          ...listExtra,
        }),
      } as Response;
    }
    const answered = postAnswer ? await postAnswer(url, init?.body ? JSON.parse(String(init.body)) : null) : undefined;
    if (answered) return { ok: answered.status < 300, status: answered.status, json: async () => answered.body } as Response;
    if (url.endsWith('/preview')) return { ok: true, status: 201, json: async () => ({ ok: true, preview: PREVIEW }) } as Response;
    return { ok: true, status: 200, json: async () => ({ ok: true, operation: { id: 'op1', state: 'succeeded' }, item: null }) } as Response;
  }) as unknown as typeof fetch;
});

describe('DecisionPromotePanel', () => {
  it('warns that a recorded decision is not reflected', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    expect(await screen.findByTestId('decision-unreflected-d-rec')).toHaveTextContent('未反映');
    expect(screen.queryByTestId('decision-unreflected-d-open')).toBeNull();
  });

  it('shows the whole body before writing; only "承認して書く" approves, with the mark and what was shown', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    const card = await screen.findByTestId('decision-d-open');
    fireEvent.click(card.querySelector('button')!);
    const buttons = await waitFor(() => {
      const all = screen.getAllByRole('button', { name: '差分を作る' });
      expect(all.length).toBeGreaterThan(1);
      return all;
    });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(await screen.findByTestId('decision-preview-d-open')).toHaveTextContent('本文の全文');
    expect(calls.filter((call) => call.url.endsWith('/approve'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '承認して書く' }));
    await waitFor(() => expect(calls.filter((call) => call.url.endsWith('/approve'))).toHaveLength(1));
    const approve = calls.find((call) => call.url.endsWith('/approve'))!;
    expect(approve.headers[SCREEN_CLIENT_HEADER]).toBe('screen');
    expect(approve.body).toEqual({ previewId: 'p1', itemVersion: 1, baseFingerprint: 'b', bodySha256: 's', acknowledgedOperationIds: [] });
    for (const call of calls.filter((entry) => entry.method !== 'GET')) expect(call.headers[SCREEN_CLIENT_HEADER]).toBe('screen');
  });

  it('"やめる" writes nothing', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    const card = await screen.findByTestId('decision-d-open');
    fireEvent.click(card.querySelector('button')!);
    const buttons = await waitFor(() => screen.getAllByRole('button', { name: '差分を作る' }));
    fireEvent.click(buttons[buttons.length - 1]);
    await screen.findByTestId('decision-preview-d-open');
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByTestId('decision-preview-d-open')).toBeNull();
    expect(calls.filter((call) => call.url.endsWith('/approve'))).toHaveLength(0);
  });

  it('5-2b P2-2: an unknown write of a purged item and a pending one of a closed item stay on the screen with their buttons', async () => {
    const operation = (id: string, itemId: string, state: string, transitionPending: boolean) => ({
      id,
      itemId,
      state,
      destinationKind: 'issue_comment',
      destination: PREVIEW.destination,
      effect: 'spec',
      resultRef: null,
      transitionPending,
      transitionReason: transitionPending ? 'state_forbids' : null,
      concurrentEdit: false,
      unknownReason: transitionPending ? null : 'timeout',
      decidedBy: null,
      approvedAt: '2026-11-09T00:00:00.000Z',
      settledAt: null,
    });
    listExtra = {
      unresolved: [
        { operation: operation('op-gone', 'd-gone', 'unknown', false), item: null, itemVersion: null },
        { operation: operation('op-closed', 'd-closed', 'succeeded', true), item: view('d-closed', 'closed'), itemVersion: 2 },
      ],
    };
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    const section = await screen.findByTestId('decision-unresolved');
    expect(section).toHaveTextContent('項目は削除されました（d-gone）');
    expect(section).toHaveTextContent('項目は閉じられています（d-closed）');
    const gone = screen.getByTestId('decision-operation-op-gone');
    fireEvent.click(gone.querySelector('button')!);
    await waitFor(() => expect(calls.filter((call) => call.url.endsWith('/operations/op-gone/reconcile'))).toHaveLength(1));
    expect(screen.getByTestId('decision-operation-op-closed')).toHaveTextContent('記録済みとして扱う');
  });

  it('5-2b P2-2 (control): a list without unsettled operations of a gone item shows no such section', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    await screen.findByTestId('decision-d-open');
    expect(screen.queryByTestId('decision-unresolved')).toBeNull();
  });

  describe('5-2c: what the screen offers is what the API accepts', () => {
    const operation = (id: string, itemId: string, state: string, transitionPending: boolean) => ({
      id,
      itemId,
      state,
      destinationKind: 'issue_comment',
      destination: PREVIEW.destination,
      effect: 'spec',
      resultRef: null,
      transitionPending,
      transitionReason: transitionPending ? 'disabled' : null,
      concurrentEdit: false,
      unknownReason: transitionPending ? null : 'timeout',
      decidedBy: null,
      approvedAt: '2026-11-09T00:00:00.000Z',
      settledAt: null,
    });
    const posts = () => calls.filter((call) => call.method === 'POST');

    it('P2-3: a closed or purged item’s pending write offers only the acknowledgement, which sends no transition', async () => {
      listExtra = {
        unresolved: [
          { operation: operation('op-closed', 'd-closed', 'succeeded', true), item: view('d-closed', 'closed'), itemVersion: 2 },
          { operation: operation('op-gone', 'd-gone', 'succeeded', true), item: null, itemVersion: null },
        ],
      };
      render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
      for (const id of ['op-closed', 'op-gone']) {
        const line = await screen.findByTestId(`decision-operation-${id}`);
        expect(line.querySelector('input[type="checkbox"]')).toBeNull();
        const buttons = line.querySelectorAll('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0]).toHaveTextContent('閉じた項目は進めません');
      }
      fireEvent.click(screen.getByTestId('decision-operation-op-closed').querySelector('button')!);
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0].url).toBe('/api/repositories/repo/mem/decisions/operations/op-closed/settle-transition');
      expect(posts()[0].body).toEqual({ acknowledgeItemClosed: true });
      expect(posts()[0].headers[SCREEN_CLIENT_HEADER]).toBe('screen');
    });

    it('P2-3 (control): an open item’s pending write still offers the transition with its version and worktree', async () => {
      listExtra = {
        decisions: [{ item: view('d-open', 'open'), unreflected: false, operations: [operation('op-open', 'd-open', 'succeeded', true)] }],
      };
      render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
      const line = await screen.findByTestId('decision-operation-op-open');
      expect(line).not.toHaveTextContent('閉じた項目は進めません');
      fireEvent.click(screen.getByRole('button', { name: '記録済みとして扱う' }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0].body).toEqual({ worktreeId: 'wt', ifVersion: 1, acknowledgeDiff: false });
    });

    it('P2-1: the roots disagree → the warning, no decisions, and the unsettled writes with their reconcile only', async () => {
      listExtra = {
        mode: 'ambiguous',
        ambiguous: { reason: 'root-settings-differ', roots: [{ repositoryId: 'repo', name: 'root-a' }, { repositoryId: 'repo-b', name: 'root-b' }] },
        decisions: [],
        unresolved: [
          { operation: operation('op-unknown', 'd-open', 'unknown', false), item: view('d-open', 'open'), itemVersion: 1 },
          { operation: operation('op-pending', 'd-open2', 'succeeded', true), item: view('d-open2', 'open'), itemVersion: 1 },
        ],
      };
      render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
      expect(await screen.findByTestId('decision-ambiguous')).toHaveTextContent('root-a, root-b');
      expect(screen.queryByText('記録待ちの決定はありません')).toBeNull();
      const section = screen.getByTestId('decision-unresolved');
      expect(section).toHaveTextContent('項目は開いています（d-open）');
      expect(screen.getByTestId('decision-operation-op-pending').querySelectorAll('button')).toHaveLength(0);
      fireEvent.click(screen.getByTestId('decision-operation-op-unknown').querySelector('button')!);
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0].url).toBe('/api/repositories/repo/mem/decisions/operations/op-unknown/reconcile');
    });
  });
});

describe('PM review (2026-11-09): what is approved is what is shown', () => {
  const WORKTREES = [
    { id: 'wt', path: '/w', name: 'wt', branch: 'feature/x' },
    { id: 'wt2', path: '/w2', name: 'wt2', branch: 'feature/x' },
  ];
  const DOC_PREVIEW = {
    ...PREVIEW,
    destination: {
      kind: 'worktree_doc',
      repositoryId: 'repo',
      branch: 'feature/x',
      worktreeId: 'wt',
      worktreeIncarnation: 'inc',
      path: 'docs/d.md',
      head: { branch: 'feature/x', commonDir: '/c' },
    },
    poster: null,
  };
  const quoted = (id: string, quote: string) => ({ ...view(id, 'open'), quote, quoteAt: '2026-11-09T00:00:00.000Z' });
  const posts = () => calls.filter((call) => call.method === 'POST');

  /** Select the item and make its preview; returns the preview's area. */
  async function openPreview(itemId = 'd-open'): Promise<HTMLElement> {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    fireEvent.click(await screen.findByTestId(`decision-select-${itemId}`));
    const card = screen.getByTestId(`decision-${itemId}`);
    const buttons = await waitFor(() => {
      const all = card.querySelectorAll('button');
      expect(all.length).toBeGreaterThan(1);
      return all;
    });
    fireEvent.click(buttons[buttons.length - 1]);
    return screen.findByTestId(`decision-preview-${itemId}`);
  }

  it('P2: the preview shows the resolved repository and number, and the account that posts', async () => {
    await openPreview();
    expect(screen.getByTestId('decision-preview-destination-d-open')).toHaveTextContent('Issue github.com/o/r#1');
    expect(screen.getByTestId('decision-preview-poster-d-open')).toHaveTextContent('a');
  });

  it('P2: a document’s preview shows the worktree, its branch and the path (no poster)', async () => {
    postAnswer = async (url) => (url.endsWith('/preview') ? { status: 201, body: { ok: true, preview: DOC_PREVIEW } } : undefined);
    await openPreview();
    expect(screen.getByTestId('decision-preview-destination-d-open')).toHaveTextContent('wt (feature/x): docs/d.md');
    expect(screen.queryByTestId('decision-preview-poster-d-open')).toBeNull();
  });

  it('P2: changing the worktree drops the preview; nothing can be approved from it', async () => {
    listExtra = { worktrees: WORKTREES };
    await openPreview();
    fireEvent.change(screen.getByTestId('decision-worktree'), { target: { value: 'wt2' } });
    await waitFor(() => expect(screen.queryByTestId('decision-preview-d-open')).toBeNull());
    expect(screen.queryByRole('button', { name: '承認して書く' })).toBeNull();
    expect(posts().filter((call) => call.url.endsWith('/approve'))).toHaveLength(0);
  });

  it('P2: changing the effect drops the preview', async () => {
    await openPreview();
    fireEvent.change(screen.getByDisplayValue('仕様を変える決定（書けたら記録済み・反映待ち）'), { target: { value: 'record_only' } });
    await waitFor(() => expect(screen.queryByTestId('decision-preview-d-open')).toBeNull());
  });

  it('P2: ticking the quote’s check drops a preview made without it', async () => {
    listExtra = { decisions: [{ item: quoted('d-open', '原文の一節'), unreflected: false, operations: [] }] };
    await openPreview();
    fireEvent.click(screen.getByRole('checkbox', { name: '引用を原文と照らして確かめた' }));
    await waitFor(() => expect(screen.queryByTestId('decision-preview-d-open')).toBeNull());
  });

  it('P2: an answer of a preview asked before the worktree changed is not shown', async () => {
    listExtra = { worktrees: WORKTREES };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    postAnswer = async (url) => {
      if (!url.endsWith('/preview')) return undefined;
      await gate;
      return { status: 201, body: { ok: true, preview: PREVIEW } };
    };
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    fireEvent.click(await screen.findByTestId('decision-select-d-open'));
    const buttons = screen.getByTestId('decision-d-open').querySelectorAll('button');
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(posts().filter((call) => call.url.endsWith('/preview'))).toHaveLength(1));
    fireEvent.change(screen.getByTestId('decision-worktree'), { target: { value: 'wt2' } });
    release();
    // The answer came (the button is enabled again) and was not shown.
    await waitFor(() => expect(buttons[buttons.length - 1]).not.toBeDisabled());
    expect(screen.queryByTestId('decision-preview-d-open')).toBeNull();
  });

  it('P2 (control): nothing changed → the preview stays and is approved as shown', async () => {
    listExtra = { worktrees: WORKTREES };
    await openPreview();
    fireEvent.click(screen.getByRole('button', { name: '承認して書く' }));
    await waitFor(() => expect(posts().filter((call) => call.url.endsWith('/approve'))).toHaveLength(1));
  });

  it('P3-1: the quote is shown beside its check, and the check does not follow to another item', async () => {
    listExtra = {
      decisions: [
        { item: quoted('d-a', '項目 A の引用'), unreflected: false, operations: [] },
        { item: quoted('d-b', '項目 B の引用'), unreflected: false, operations: [] },
      ],
    };
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    fireEvent.click(await screen.findByTestId('decision-select-d-a'));
    expect(screen.getByTestId('decision-quote-d-a')).toHaveTextContent('項目 A の引用');
    fireEvent.click(screen.getByRole('checkbox', { name: '引用を原文と照らして確かめた' }));
    fireEvent.click(screen.getByTestId('decision-select-d-b'));
    expect(screen.getByTestId('decision-quote-d-b')).toHaveTextContent('項目 B の引用');
    expect(screen.getByRole('checkbox', { name: '引用を原文と照らして確かめた' })).not.toBeChecked();
    const buttons = screen.getByTestId('decision-d-b').querySelectorAll('button');
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(posts().filter((call) => call.url.endsWith('/preview'))).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({ quoteConfirmed: false });
  });

  it('P3-1 (control): the check ticked on the item itself is sent with its preview', async () => {
    listExtra = { decisions: [{ item: quoted('d-a', '項目 A の引用'), unreflected: false, operations: [] }] };
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    fireEvent.click(await screen.findByTestId('decision-select-d-a'));
    fireEvent.click(screen.getByRole('checkbox', { name: '引用を原文と照らして確かめた' }));
    const buttons = screen.getByTestId('decision-d-a').querySelectorAll('button');
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(posts().filter((call) => call.url.endsWith('/preview'))).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({ quoteConfirmed: true });
  });

  const pendingOp = (id: string, itemId: string) => ({
    id,
    itemId,
    state: 'succeeded',
    destinationKind: 'issue_comment',
    destination: PREVIEW.destination,
    effect: 'spec',
    resultRef: null,
    transitionPending: true,
    transitionReason: 'version_conflict',
    concurrentEdit: false,
    unknownReason: null,
    decidedBy: null,
    approvedAt: '2026-11-09T00:00:00.000Z',
    settledAt: null,
  });

  it('P3-1: the difference checked for one operation is not sent with another’s "treat as recorded"', async () => {
    listExtra = {
      decisions: [
        { item: view('d-a', 'open'), unreflected: false, operations: [pendingOp('op-a', 'd-a')] },
        { item: view('d-b', 'open'), unreflected: false, operations: [pendingOp('op-b', 'd-b')] },
      ],
    };
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    const a = await screen.findByTestId('decision-operation-op-a');
    fireEvent.click(a.querySelector('input[type="checkbox"]')!);
    const b = screen.getByTestId('decision-operation-op-b');
    expect(b.querySelector('input[type="checkbox"]')).not.toBeChecked();
    fireEvent.click(b.querySelector('button')!);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toContain('/operations/op-b/settle-transition');
    expect(posts()[0].body).toMatchObject({ acknowledgeDiff: false });
  });

  it('P3-1 (control): the difference checked for the operation itself is sent with it', async () => {
    listExtra = { decisions: [{ item: view('d-a', 'open'), unreflected: false, operations: [pendingOp('op-a', 'd-a')] }] };
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    const a = await screen.findByTestId('decision-operation-op-a');
    fireEvent.click(a.querySelector('input[type="checkbox"]')!);
    fireEvent.click(a.querySelector('button')!);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({ acknowledgeDiff: true });
  });

  const unknownOp = (id: string, unknownReason: string) => ({ ...pendingOp(id, 'd-a'), state: 'unknown', transitionPending: false, transitionReason: null, unknownReason });

  it('P3-2: body_differs → a warning; the reconcile shows what was found beside what was meant; "treat as written" sends the reason shown', async () => {
    listExtra = { decisions: [{ item: view('d-a', 'open'), unreflected: false, operations: [unknownOp('op-u', 'body_differs')] }] };
    postAnswer = async (url) =>
      url.endsWith('/reconcile')
        ? {
            status: 200,
            body: {
              ok: true,
              operation: unknownOp('op-u', 'body_differs'),
              item: null,
              finding: { reason: 'body_differs', found: '見つかった本文（編集後）', intended: '承認した本文' },
            },
          }
        : undefined;
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    const line = await screen.findByTestId('decision-operation-op-u');
    expect(screen.getByTestId('decision-mark-found-op-u')).toHaveTextContent('もう一度書かれます');
    expect(screen.queryByRole('button', { name: '書かれていたとして扱う' })).toBeNull();
    fireEvent.click(line.querySelector('button')!);
    const finding = await screen.findByTestId('decision-finding-op-u');
    expect(finding).toHaveTextContent('見つかった本文（編集後）');
    expect(finding).toHaveTextContent('承認した本文');
    fireEvent.click(screen.getByRole('button', { name: '書かれていたとして扱う' }));
    await waitFor(() => expect(posts().filter((call) => call.url.endsWith('/accept-found'))).toHaveLength(1));
    const accept = posts().find((call) => call.url.endsWith('/accept-found'))!;
    expect(accept.url).toBe('/api/repositories/repo/mem/decisions/operations/op-u/accept-found');
    expect(accept.body).toEqual({ ifState: 'unknown', ifReason: 'body_differs' });
    expect(accept.headers[SCREEN_CLIENT_HEADER]).toBe('screen');
  });

  it('Codex review 5 P2-2: a finding whose found body could not be read offers no "treat as written" (only reconcile again)', async () => {
    listExtra = { decisions: [{ item: view('d-a', 'open'), unreflected: false, operations: [unknownOp('op-u', 'block_altered')] }] };
    postAnswer = async (url) =>
      url.endsWith('/reconcile')
        ? {
            status: 200,
            body: { ok: true, operation: unknownOp('op-u', 'block_altered'), item: null, finding: { reason: 'block_altered', found: null, intended: '承認した本文' } },
          }
        : undefined;
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    const line = await screen.findByTestId('decision-operation-op-u');
    fireEvent.click(line.querySelector('button')!);
    const finding = await screen.findByTestId('decision-finding-op-u');
    expect(finding).toHaveTextContent('読めませんでした');
    expect(screen.queryByRole('button', { name: '書かれていたとして扱う' })).toBeNull();
    expect(screen.getByRole('button', { name: '照合する' })).toBeInTheDocument();
    expect(posts().filter((call) => call.url.endsWith('/accept-found'))).toHaveLength(0);
  });

  it('P3-2 (control): an unknown of another reason shows no warning and no "treat as written", even after the reconcile', async () => {
    listExtra = { decisions: [{ item: view('d-a', 'open'), unreflected: false, operations: [unknownOp('op-u', 'not_found_yet')] }] };
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    const line = await screen.findByTestId('decision-operation-op-u');
    expect(screen.queryByTestId('decision-mark-found-op-u')).toBeNull();
    fireEvent.click(line.querySelector('button')!);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(screen.queryByTestId('decision-finding-op-u')).toBeNull();
    expect(screen.queryByRole('button', { name: '書かれていたとして扱う' })).toBeNull();
  });
});
