/**
 * The decision panel on a PC (Issue #4355 PR2, design `docs/design/mem-decisions-ux-4355.md`
 * §3.1.4・§3.2・§5・I6・I9):
 *
 * - the counts above the list (awaiting approval, awaiting reflection), "unknown" — never 0 —
 *   when the roots disagree, and "cannot approve" when the mode is not `on`;
 * - the recorded and the reflected folded (closed by default), the open never folded;
 * - "awaiting approval only" hides the folds, never an item whose operation is unknown, in
 *   flight or waiting for its transition (I9);
 * - `?item=` opens that item without choosing anything for it (no preview is made), unfolds
 *   a folded one, and says when the item is not this branch's or is gone.
 *
 * Positive control: before PR2 the panel had no counts line, no folds, no switch and no
 * `focusItem`, so each of these fails there. Negative control: the open item's buttons and
 * the #4225 tests (`DecisionPromotePanel-4225.test.tsx`) are unchanged.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DecisionPromotePanel } from '@/components/mem/DecisionPromotePanel';

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
  createdAt: '2026-11-13T00:00:00.000Z',
  updatedAt: '2026-11-13T00:00:00.000Z',
  closedAt: null,
  closeReason: null,
  stale: false,
  frozen: false,
});

const operation = (id: string, itemId: string, state: string, transitionPending = false) => ({
  id,
  itemId,
  state,
  destinationKind: 'issue_comment',
  destination: { kind: 'issue_comment', ref: 'issue', host: 'github.com', owner: 'o', repo: 'r', number: 1 },
  effect: 'spec',
  resultRef: null,
  transitionPending,
  transitionReason: transitionPending ? 'version_conflict' : null,
  concurrentEdit: false,
  unknownReason: state === 'unknown' ? 'timeout' : null,
  decidedBy: null,
  approvedAt: '2026-11-13T00:00:00.000Z',
  settledAt: null,
});

let calls: Array<{ method: string; url: string }>;
let listBody: Record<string, unknown>;

const DECISIONS = [
  { item: view('d-open', 'open'), unreflected: false, operations: [] },
  { item: view('d-rec', 'recorded'), unreflected: true, operations: [] },
  { item: view('d-pro', 'promoted'), unreflected: false, operations: [] },
];

beforeEach(() => {
  calls = [];
  listBody = {
    ok: true,
    mode: 'on',
    branch: 'feature/x',
    counts: { mode: 'on', approvable: true, open: 1, recorded: 1 },
    decisions: DECISIONS,
    unresolved: [],
    worktrees: [{ id: 'wt', path: '/w', name: 'wt', branch: 'feature/x' }],
  };
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input) });
    return { ok: true, status: 200, json: async () => listBody } as Response;
  }) as unknown as typeof fetch;
});

const fold = (state: string) => screen.queryByTestId(`decision-fold-${state}`) as HTMLDetailsElement | null;
const inFold = (state: string, id: string) => fold(state)?.contains(screen.getByTestId(`decision-${id}`)) ?? false;

describe('§3.2: the counts above the list', () => {
  it('awaiting approval and awaiting reflection, from the list’s counts (I6)', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    const counts = await screen.findByTestId('decision-counts');
    expect(counts).toHaveTextContent('承認待ち 1 件・反映待ち 1 件');
    expect(counts).toHaveAttribute('data-open', '1');
    expect(counts).not.toHaveTextContent('承認できない');
  });

  it('the roots disagree: "unknown", never 0', async () => {
    listBody = { ...listBody, mode: 'ambiguous', counts: { mode: 'ambiguous', approvable: false, open: null, recorded: null }, decisions: [] };
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    const counts = await screen.findByTestId('decision-counts');
    expect(counts).toHaveTextContent('件数は不明');
    expect(counts).not.toHaveTextContent('0 件');
    expect(counts).toHaveAttribute('data-open', 'unknown');
  });

  it('mode off: counted, with "cannot approve"', async () => {
    listBody = { ...listBody, mode: 'off', counts: { mode: 'off', approvable: false, open: 1, recorded: 1 } };
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    expect(await screen.findByTestId('decision-counts')).toHaveTextContent('承認できない（mode off）');
  });

  it('an older server without `counts`: the same shared count over the list', async () => {
    const { counts: _dropped, ...rest } = listBody;
    void _dropped;
    listBody = rest;
    const seen: unknown[] = [];
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" onCounts={(counts) => seen.push(counts)} />);
    expect(await screen.findByTestId('decision-counts')).toHaveTextContent('承認待ち 1 件・反映待ち 1 件');
    expect(seen).toEqual([{ mode: 'on', approvable: true, open: 1, recorded: 1 }]);
  });
});

describe('§3.2: folds and "awaiting approval only"', () => {
  it('the recorded and the reflected are folded and closed by default; the open is not folded', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    await screen.findByTestId('decision-d-open');
    expect(fold('recorded')!.open).toBe(false);
    expect(fold('promoted')!.open).toBe(false);
    expect(inFold('recorded', 'd-rec')).toBe(true);
    expect(inFold('promoted', 'd-pro')).toBe(true);
    expect(screen.getByTestId('decision-list').contains(screen.getByTestId('decision-d-open'))).toBe(true);
  });

  it('(negative control) the open item keeps its buttons: choosing it shows the effect and the diff button', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    fireEvent.click(await screen.findByTestId('decision-select-d-open'));
    expect(screen.getByTestId('decision-make-preview-d-open')).toHaveTextContent('差分を作る');
  });

  it('"awaiting approval only" hides the folds and keeps the open', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    fireEvent.click(await screen.findByTestId('decision-pending-only'));
    expect(fold('recorded')).toBeNull();
    expect(fold('promoted')).toBeNull();
    expect(screen.getByTestId('decision-d-open')).toBeInTheDocument();
  });

  it.each([
    ['unknown', 'recorded', operation('op-u', 'd-x', 'unknown')],
    ['in flight', 'promoted', operation('op-f', 'd-x', 'in_flight')],
    ['approved (on its way)', 'recorded', operation('op-a', 'd-x', 'approved')],
    ['written, transition pending', 'recorded', operation('op-p', 'd-x', 'succeeded', true)],
  ])('I9: a %s operation keeps its %s item unfolded and shown under "awaiting approval only"', async (_name, state, op) => {
    listBody = { ...listBody, decisions: [...DECISIONS, { item: view('d-x', state), unreflected: false, operations: [op] }] };
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    await screen.findByTestId('decision-d-x');
    expect(inFold(state, 'd-x')).toBe(false);
    fireEvent.click(screen.getByTestId('decision-pending-only'));
    expect(screen.getByTestId('decision-d-x')).toBeInTheDocument();
    expect(screen.getByTestId(`decision-operation-${op.id}`)).toBeInTheDocument();
  });

  it('I9 (control): a settled operation does not keep a recorded item out of its fold', async () => {
    listBody = { ...listBody, decisions: [...DECISIONS, { item: view('d-x', 'recorded'), unreflected: true, operations: [operation('op-s', 'd-x', 'succeeded')] }] };
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    await screen.findByTestId('decision-d-x');
    expect(inFold('recorded', 'd-x')).toBe(true);
  });

  it('I9: the unsettled operations of a closed item stay shown under "awaiting approval only"', async () => {
    listBody = { ...listBody, unresolved: [{ operation: operation('op-gone', 'd-gone', 'unknown'), item: null, itemVersion: null }] };
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    fireEvent.click(await screen.findByTestId('decision-pending-only'));
    expect(screen.getByTestId('decision-operation-op-gone')).toBeInTheDocument();
  });
});

describe('§3.1.4: `?item=`', () => {
  it('an open item of this branch is opened, and nothing is chosen or made for it', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" focusItem={{ id: 'd-open', where: 'here' }} />);
    expect(await screen.findByTestId('decision-make-preview-d-open')).toBeInTheDocument();
    expect(screen.queryByTestId('decision-preview-d-open')).toBeNull();
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  it('a folded item is unfolded, with "awaiting approval only" lifted', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" focusItem={{ id: 'd-rec', where: 'here' }} />);
    await screen.findByTestId('decision-d-rec');
    await waitFor(() => expect(fold('recorded')!.open).toBe(true));
    expect(fold('promoted')!.open).toBe(false);
  });

  it.each([
    ['elsewhere', 'このブランチの決定ではありません（d-else）'],
    ['gone', '見つかりません（閉じたか削除されました: d-else）'],
  ] as const)('an item that is %s is not shown and the screen says so (the branch is not switched)', async (where, text) => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" focusItem={{ id: 'd-else', where }} />);
    expect(await screen.findByTestId('decision-focus-missing')).toHaveTextContent(text);
    expect(calls.every((call) => call.url.includes('branch=feature%2Fx'))).toBe(true);
  });

  it('(positive control, 5-2b P2) `?item=` changed to another item on the same branch opens that one too', async () => {
    const shown = render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" focusItem={{ id: 'd-open', where: 'here' }} />);
    await screen.findByTestId('decision-make-preview-d-open');
    fireEvent.click(screen.getByTestId('decision-pending-only'));
    expect(fold('recorded')).toBeNull();
    // The same panel (its key is repository + branch), only `?item=` changed: A → B.
    shown.rerender(<DecisionPromotePanel repositoryId="repo" branch="feature/x" focusItem={{ id: 'd-rec', where: 'here' }} />);
    await waitFor(() => expect(fold('recorded')?.open).toBe(true));
    expect((screen.getByTestId('decision-pending-only') as HTMLInputElement).checked).toBe(false);
    expect(inFold('recorded', 'd-rec')).toBe(true);
  });

  it('(negative control) a redraw with the same `?item=` does not scroll again', async () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push((this as HTMLElement).dataset.decisionId ?? '');
    };
    try {
      const shown = render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" focusItem={{ id: 'd-rec', where: 'here' }} />);
      await waitFor(() => expect(scrolled).toEqual(['d-rec']));
      shown.rerender(<DecisionPromotePanel repositoryId="repo" branch="feature/x" focusItem={{ id: 'd-rec', where: 'here' }} />);
      shown.rerender(<DecisionPromotePanel repositoryId="repo" branch="feature/x" focusItem={{ id: 'd-rec' }} />);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(scrolled).toEqual(['d-rec']);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('(negative control) without `?item=` nothing is said and nothing is opened', async () => {
    render(<DecisionPromotePanel repositoryId="repo" branch="feature/x" />);
    await screen.findByTestId('decision-d-open');
    expect(screen.queryByTestId('decision-focus-missing')).toBeNull();
    expect(screen.queryByTestId('decision-make-preview-d-open')).toBeNull();
  });
});
