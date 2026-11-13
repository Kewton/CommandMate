/**
 * The decision screen's top: the repository, then the branch (Issue #4355 PR2, design
 * `docs/design/mem-decisions-ux-4355.md` §3.1.1・I4・I6・§7.1).
 *
 * - I4: the URL keeps its shape. A link `/repositories/<id>/mem/decisions?branch=<name>`
 *   opens with that repository and branch chosen; a branch the list does not hold is shown
 *   marked and chosen; a link without `branch` opens too.
 * - Choosing a repository goes to it without the branch; choosing a branch adds `?branch=`.
 * - The branch select's rows carry the branch names only (5-2b, PM's disposal): the one count
 *   of decisions awaiting approval on the screen is the panel's, from its one list read — a
 *   late branches answer never shows another read's count.
 * - `?item=` (§3.1.4) is not in PR2: the page does not read it.
 * - §7.1: two repositories share a branch's name; the earlier repository's list answered
 *   after the switch is not shown (the response order is reversed here).
 *
 * Positive control: before PR2 the top was a text input (`decision-branch-input`), so
 * every select below is missing there. Negative control: the panel is still keyed by
 * repository and branch (`page.tsx`, #4225), so its state is dropped on a switch.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const nav = vi.hoisted(() => ({ id: 'repo-a', search: '', push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: nav.id }),
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

import MemDecisionsPage from '@/app/repositories/[id]/mem/decisions/page';

type Answer = { status?: number; body: unknown };
/** Per URL path: the answer, or a promise the test resolves (to reverse the order). */
let answers: Record<string, Answer | (() => Promise<Answer>)>;
let calls: string[];

const BRANCHES_A = [
  { branch: 'feature/x', mode: 'on', approvable: true, open: 3, recorded: 1 },
  { branch: 'feature/off', mode: 'off', approvable: false, open: 2, recorded: 0 },
  { branch: 'feature/amb', mode: 'ambiguous', approvable: false, open: null, recorded: null },
];
const BRANCHES_B = [{ branch: 'feature/x', mode: 'on', approvable: true, open: 7, recorded: 0 }];

const listOf = (branch: string) => ({
  ok: true,
  mode: 'on',
  branch,
  counts: { mode: 'on', approvable: true, open: 0, recorded: 0 },
  decisions: [],
  unresolved: [],
  worktrees: [],
});

beforeEach(() => {
  nav.id = 'repo-a';
  nav.search = '';
  nav.push = vi.fn();
  calls = [];
  answers = {
    '/api/repositories': {
      body: {
        success: true,
        repositories: [
          { id: 'repo-a', name: 'repo-a', displayName: null },
          { id: 'repo-b', name: 'repo-b', displayName: 'Repo B' },
        ],
      },
    },
    '/api/repositories/repo-a/mem/decisions/branches': { body: { ok: true, branches: BRANCHES_A } },
    '/api/repositories/repo-b/mem/decisions/branches': { body: { ok: true, branches: BRANCHES_B } },
    '/api/repositories/repo-a/mem/decisions': { body: listOf('feature/x') },
    '/api/repositories/repo-b/mem/decisions': { body: listOf('feature/x') },
  };
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const entry = answers[url.split('?')[0]];
    const answer = typeof entry === 'function' ? await entry() : (entry ?? { status: 404, body: { ok: false, code: 'not_found' } });
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.body } as Response;
  }) as unknown as typeof fetch;
});

const repositorySelect = () => screen.getByTestId('decision-repository-select') as HTMLSelectElement;
const branchSelect = () => screen.getByTestId('decision-branch-select') as HTMLSelectElement;
const optionTexts = () => Array.from(branchSelect().options).map((option) => option.textContent);

describe('I4: the URL keeps its shape and opens chosen', () => {
  it('an existing link opens with the repository and the branch chosen, and the panel shown', async () => {
    nav.search = 'branch=feature%2Fx';
    render(<MemDecisionsPage />);
    await waitFor(() => expect(branchSelect().disabled).toBe(false));
    expect(repositorySelect().value).toBe('repo-a');
    expect(branchSelect().value).toBe('feature/x');
    expect(await screen.findByTestId('decision-promote-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('decision-branch-input')).toBeNull();
  });

  it('a branch the list does not hold is shown marked and chosen (an old link is not left empty)', async () => {
    nav.search = 'branch=old%2Fbranch';
    render(<MemDecisionsPage />);
    await waitFor(() => expect(branchSelect().disabled).toBe(false));
    expect(branchSelect().value).toBe('old/branch');
    expect(screen.getByTestId('decision-branch-not-listed')).toHaveTextContent('old/branch（一覧にありません・mem が on でない）');
    expect(await screen.findByTestId('decision-promote-panel')).toBeInTheDocument();
  });

  it('a link without `branch` opens: both selects, no panel until a branch is chosen', async () => {
    render(<MemDecisionsPage />);
    await waitFor(() => expect(branchSelect().disabled).toBe(false));
    expect(branchSelect().value).toBe('');
    expect(screen.queryByTestId('decision-promote-panel')).toBeNull();
  });

  it('a repository the list does not hold (yet) is still the chosen one', async () => {
    nav.id = 'repo-z';
    answers['/api/repositories/repo-z/mem/decisions/branches'] = { body: { ok: true, branches: [] } };
    render(<MemDecisionsPage />);
    await waitFor(() => expect(repositorySelect().value).toBe('repo-z'));
    expect(await screen.findByTestId('decision-no-branches')).toBeInTheDocument();
  });
});

describe('§3.1.1: choosing', () => {
  it('another repository: its path, without the branch (a same-named branch is not carried over)', async () => {
    nav.search = 'branch=feature%2Fx';
    render(<MemDecisionsPage />);
    await waitFor(() => expect(Array.from(repositorySelect().options).map((option) => option.value)).toEqual(['repo-a', 'repo-b']));
    fireEvent.change(repositorySelect(), { target: { value: 'repo-b' } });
    expect(nav.push).toHaveBeenCalledWith('/repositories/repo-b/mem/decisions');
  });

  it('a branch: the same path with `?branch=`', async () => {
    render(<MemDecisionsPage />);
    await waitFor(() => expect(branchSelect().disabled).toBe(false));
    fireEvent.change(branchSelect(), { target: { value: 'feature/off' } });
    expect(nav.push).toHaveBeenCalledWith('/repositories/repo-a/mem/decisions?branch=feature%2Foff');
  });

  it('5-2b: each row is the branch’s name only, in the answer’s order (no count from the branches read)', async () => {
    render(<MemDecisionsPage />);
    await waitFor(() => expect(branchSelect().disabled).toBe(false));
    expect(optionTexts()).toEqual(['ブランチを選ぶ', 'feature/x', 'feature/off', 'feature/amb']);
  });

  it('the branches that cannot be read: said, not shown as none', async () => {
    answers['/api/repositories/repo-a/mem/decisions/branches'] = { status: 500, body: { ok: false, code: 'internal_error' } };
    render(<MemDecisionsPage />);
    expect(await screen.findByTestId('decision-branches-error')).toBeInTheDocument();
    expect(screen.queryByTestId('decision-no-branches')).toBeNull();
  });
});

describe('§7.1: a list answered for a repository no longer chosen is not shown', () => {
  it('A’s branches answered after the switch to B (same branch name): only B’s branches', async () => {
    let releaseA: (answer: Answer) => void = () => undefined;
    answers['/api/repositories/repo-a/mem/decisions/branches'] = () => new Promise<Answer>((resolve) => (releaseA = resolve));
    nav.search = 'branch=feature%2Fx';
    const view = render(<MemDecisionsPage />);
    await waitFor(() => expect(calls).toContain('/api/repositories/repo-a/mem/decisions/branches'));

    nav.id = 'repo-b';
    view.rerender(<MemDecisionsPage />);
    await waitFor(() => expect(optionTexts()).toEqual(['feature/x']));

    await act(async () => {
      releaseA({ body: { ok: true, branches: BRANCHES_A } });
      await Promise.resolve();
    });
    expect(optionTexts()).toEqual(['feature/x']);
    expect(repositorySelect().value).toBe('repo-b');
  });

  it('(negative control) the panel is keyed by repository and branch: a switch reads the new list', async () => {
    nav.search = 'branch=feature%2Fx';
    const view = render(<MemDecisionsPage />);
    await screen.findByTestId('decision-promote-panel');
    nav.id = 'repo-b';
    view.rerender(<MemDecisionsPage />);
    await waitFor(() => expect(calls).toContain('/api/repositories/repo-b/mem/decisions?branch=feature%2Fx'));
  });
});

describe('§3.1.4: `?item=` is not in PR2 (5-2b, PM\'s disposal: moved to PR3 or another PR)', () => {
  it('(negative control) a link with `?item=` opens the branch as without it: the branches are read without the item', async () => {
    nav.search = 'branch=feature%2Fx&item=d-else';
    render(<MemDecisionsPage />);
    expect(await screen.findByTestId('decision-promote-panel')).toBeInTheDocument();
    expect(branchSelect().value).toBe('feature/x');
    expect(calls.filter((url) => url.includes('/branches'))).toEqual(['/api/repositories/repo-a/mem/decisions/branches']);
    expect(calls.some((url) => url.includes('item='))).toBe(false);
  });
});

describe('5-2b: the count awaiting approval is the panel’s list’s only (one read)', () => {
  const item = (state: 'open' | 'recorded') => ({
    id: 'd-1',
    kind: 'decision',
    state,
    text: '決定 d-1',
    closeWhen: null,
    promoteTo: 'issue:#1',
    quote: null,
    quoteAt: null,
    evidence: [],
    closeNote: null,
    owner: {},
    createdBy: 'agent',
    updatedBy: 'agent',
    version: state === 'open' ? 1 : 2,
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
    closedAt: null,
    closeReason: null,
    stale: false,
    frozen: false,
  });
  const countsFor = (state: 'open' | 'recorded') => ({ mode: 'on', approvable: true, open: state === 'open' ? 1 : 0, recorded: state === 'recorded' ? 1 : 0 });

  it('(positive control) approved: the list says 0, the count says 0; a branches answer read before the approval and returned late changes nothing', async () => {
    let state: 'open' | 'recorded' = 'open';
    let releaseBranches: () => void = () => undefined;
    answers['/api/repositories/repo-a/mem/decisions/branches'] = () => {
      // The answer is what the server read when the request came: before the approval.
      const body = { ok: true, branches: [{ branch: 'feature/x', ...countsFor(state) }] };
      return new Promise<Answer>((resolve) => (releaseBranches = () => resolve({ body })));
    };
    answers['/api/repositories/repo-a/mem/decisions'] = () =>
      Promise.resolve({
        body: {
          ok: true,
          mode: 'on',
          branch: 'feature/x',
          counts: countsFor(state),
          decisions: [{ item: item(state), unreflected: state === 'recorded', operations: [] }],
          unresolved: [],
          worktrees: [{ id: 'wt', path: '/w', name: 'wt', branch: 'feature/x' }],
        },
      });
    answers['/api/repositories/repo-a/mem/decisions/d-1/preview'] = {
      status: 201,
      body: {
        ok: true,
        preview: {
          id: 'p-1',
          operationId: 'op-1',
          itemId: 'd-1',
          itemVersion: 1,
          destination: { kind: 'issue_comment', ref: 'issue', host: 'github.com', owner: 'o', repo: 'r', number: 1 },
          baseFingerprint: 'b',
          body: 'body',
          bodySha256: 's',
          effect: 'spec',
          quoteOrigin: 'human',
          invisibleReplaced: false,
          acknowledgedOperationIds: [],
          poster: null,
          createdAt: '2026-11-13T00:00:00.000Z',
          expiresAt: '2026-11-13T00:30:00.000Z',
        },
      },
    };
    answers['/api/repositories/repo-a/mem/decisions/d-1/approve'] = () => {
      state = 'recorded';
      return Promise.resolve({ body: { ok: true, operation: { id: 'op-1', state: 'succeeded' }, item: item('recorded') } });
    };
    nav.search = 'branch=feature%2Fx';
    render(<MemDecisionsPage />);
    await waitFor(() => expect(calls).toContain('/api/repositories/repo-a/mem/decisions/branches'));

    fireEvent.click(await screen.findByTestId('decision-select-d-1'));
    fireEvent.click(await screen.findByTestId('decision-make-preview-d-1'));
    fireEvent.click(await screen.findByTestId('decision-approve-d-1'));
    await waitFor(() => expect(screen.getByTestId('decision-counts')).toHaveAttribute('data-open', '0'));

    await act(async () => {
      releaseBranches();
      await Promise.resolve();
    });
    await waitFor(() => expect(branchSelect().disabled).toBe(false));
    // The one count is the list's: 0, and no other read's count (the branches said open 1) is on the screen.
    expect(screen.getByTestId('decision-counts')).toHaveAttribute('data-open', '0');
    expect(screen.getByTestId('decision-counts')).toHaveTextContent('承認待ち 0 件・反映待ち 1 件');
    expect(optionTexts()).toEqual(['feature/x']);
    expect(document.body.textContent).not.toMatch(/承認待ち 1/);
  });

  it('the other order: a branches answer read after the list (other counts) returned late does not change the count either', async () => {
    let releaseBranches: () => void = () => undefined;
    let releaseList: () => void = () => undefined;
    answers['/api/repositories/repo-a/mem/decisions/branches'] = () =>
      new Promise<Answer>((resolve) => (releaseBranches = () => resolve({ body: { ok: true, branches: BRANCHES_A } })));
    answers['/api/repositories/repo-a/mem/decisions'] = () =>
      new Promise<Answer>((resolve) => (releaseList = () => resolve({ body: listOf('feature/x') })));
    nav.search = 'branch=feature%2Fx';
    render(<MemDecisionsPage />);
    await waitFor(() => expect(calls).toContain('/api/repositories/repo-a/mem/decisions/branches'));
    await waitFor(() => expect(calls).toContain('/api/repositories/repo-a/mem/decisions?branch=feature%2Fx'));
    await act(async () => {
      releaseList();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('decision-counts')).toHaveAttribute('data-open', '0'));
    await act(async () => {
      releaseBranches();
      await Promise.resolve();
    });
    await waitFor(() => expect(branchSelect().disabled).toBe(false));
    // The branches said feature/x has 3 awaiting; the screen shows only the list's 0.
    expect(screen.getByTestId('decision-counts')).toHaveAttribute('data-open', '0');
    expect(screen.getByTestId('decision-counts')).toHaveTextContent('承認待ち 0 件・反映待ち 0 件');
    expect(optionTexts()).toEqual(['feature/x', 'feature/off', 'feature/amb']);
    expect(document.body.textContent).not.toMatch(/承認待ち 3|open 2/);
  });
});
