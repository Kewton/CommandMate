/**
 * Unit tests for GitPane component
 * Issue #447: Git tab feature
 * Issue #779: Current Status section (branch / dirty / ahead-behind / refresh)
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { GitPane } from '@/components/worktree/GitPane';
import {
  CHECKOUT_HISTORY_LOSS_WARNING,
  CHECKOUT_RUNNING_SESSION_WARNING,
  RESET_HARD_HISTORY_LOSS_WARNING,
  PUSH_AUTH_FAILED_GUIDANCE,
} from '@/config/git-status-config';
// Issue #817: SSOT prompt builders — imported so the "Ask AI" wiring tests
// assert the right builder/context without duplicating the ja wording here.
import {
  branchCreatePrompt,
  branchDeletePrompt,
  resetPrompt,
  revertPrompt,
} from '@/lib/git-ai-prompt-templates';

// ----------------------------------------------------------------------------
// URL-discriminating fetch mock (Issue #779 hard gate)
// Mount now performs 2 fetches: /git/log + /git/status. The mock branches on the
// URL so /git/status returns a Current Status shape, /git/log returns commits,
// and /git/show / /git/diff return their respective shapes.
// ----------------------------------------------------------------------------

const mockFetch = vi.fn();
global.fetch = mockFetch;

/** Default JSON payloads per endpoint; override per-test via setEndpoints(). */
interface EndpointConfig {
  status?: { ok: boolean; json: unknown };
  staged?: { ok: boolean; json: unknown };
  log?: { ok: boolean; json: unknown };
  show?: { ok: boolean; json: unknown };
  diff?: { ok: boolean; json: unknown };
  workingDiff?: { ok: boolean; json: unknown };
  stage?: { ok: boolean; json: unknown };
  unstage?: { ok: boolean; json: unknown };
  commit?: { ok: boolean; json: unknown };
  branches?: { ok: boolean; json: unknown };
  checkout?: { ok: boolean; json: unknown };
  branchCreate?: { ok: boolean; json: unknown };
  branchDelete?: { ok: boolean; json: unknown };
  // Issue #782
  stash?: { ok: boolean; json: unknown };
  stashPush?: { ok: boolean; json: unknown };
  stashPop?: { ok: boolean; json: unknown };
  stashApply?: { ok: boolean; json: unknown };
  stashDrop?: { ok: boolean; json: unknown };
  reset?: { ok: boolean; json: unknown };
  revert?: { ok: boolean; json: unknown };
  // Issue #783: network operations
  netFetch?: { ok: boolean; json: unknown };
  pull?: { ok: boolean; json: unknown };
  push?: { ok: boolean; json: unknown };
}

const DEFAULT_STATUS = {
  currentBranch: 'feature/test',
  initialBranch: 'main',
  isBranchMismatch: false,
  commitHash: 'abc1234',
  isDirty: false,
  aheadBehind: null,
};

const DEFAULT_STAGED = {
  staged: [] as Array<{ path: string; status: string }>,
  unstaged: [] as Array<{ path: string; status: string }>,
  untracked: [] as Array<{ path: string; status: string }>,
};

const DEFAULT_BRANCHES = {
  branches: [
    {
      name: 'main',
      isCurrent: false,
      isRemote: false,
      isDefault: true,
      upstream: 'origin/main',
      aheadBehind: { ahead: 0, behind: 0 },
      checkedOutWorktreePath: null,
    },
    {
      name: 'feature/current',
      isCurrent: true,
      isRemote: false,
      isDefault: false,
      upstream: null,
      aheadBehind: null,
      checkedOutWorktreePath: null,
    },
  ],
};

let endpoints: EndpointConfig = {};

function makeResponse(entry: { ok: boolean; json: unknown }) {
  return Promise.resolve({
    ok: entry.ok,
    json: () => Promise.resolve(entry.json),
  });
}

/**
 * Install the URL-discriminating mock implementation. Tests may pass overrides
 * for any endpoint; unspecified endpoints fall back to sensible defaults.
 *
 * Note: branch on POST endpoints (stage/unstage/commit) BEFORE the GET-shape
 * endpoints. /git/staged is checked before /git/stage substring overlap is
 * avoided by checking the more specific path first.
 */
function setEndpoints(config: EndpointConfig = {}) {
  endpoints = config;
  mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/git/staged')) {
      return makeResponse(endpoints.staged ?? { ok: true, json: DEFAULT_STAGED });
    }
    if (url.includes('/git/stage') && method === 'POST') {
      return makeResponse(endpoints.stage ?? { ok: true, json: { success: true } });
    }
    if (url.includes('/git/unstage') && method === 'POST') {
      return makeResponse(endpoints.unstage ?? { ok: true, json: { success: true } });
    }
    if (url.includes('/git/commit') && method === 'POST') {
      return makeResponse(endpoints.commit ?? { ok: true, json: { success: true, commit: null } });
    }
    if (url.includes('/git/checkout') && method === 'POST') {
      return makeResponse(endpoints.checkout ?? { ok: true, json: { success: true, currentBranch: 'main', isDirty: false } });
    }
    if (url.includes('/git/branch/create') && method === 'POST') {
      return makeResponse(endpoints.branchCreate ?? { ok: true, json: { success: true, branch: { name: 'new' } } });
    }
    if (url.includes('/git/branch/delete') && method === 'POST') {
      return makeResponse(endpoints.branchDelete ?? { ok: true, json: { success: true, deleted: 'gone' } });
    }
    if (url.includes('/git/branches')) {
      return makeResponse(endpoints.branches ?? { ok: true, json: DEFAULT_BRANCHES });
    }
    // Issue #782: stash + reset/revert. Order matters — more specific paths first.
    if (url.includes('/git/stash/push') && method === 'POST') {
      return makeResponse(endpoints.stashPush ?? { ok: true, json: { success: true } });
    }
    if (url.includes('/git/stash/pop') && method === 'POST') {
      return makeResponse(endpoints.stashPop ?? { ok: true, json: { success: true, conflict: false } });
    }
    if (url.includes('/git/stash/apply') && method === 'POST') {
      return makeResponse(endpoints.stashApply ?? { ok: true, json: { success: true, conflict: false } });
    }
    if (method === 'DELETE' && /\/git\/stash\/\d+/.test(url)) {
      return makeResponse(endpoints.stashDrop ?? { ok: true, json: { success: true, dropped: 0 } });
    }
    if (url.includes('/git/stash')) {
      return makeResponse(endpoints.stash ?? { ok: true, json: { stashes: [] } });
    }
    if (url.includes('/git/reset') && method === 'POST') {
      return makeResponse(endpoints.reset ?? { ok: true, json: { success: true, currentBranch: 'feature/test', isDirty: false } });
    }
    if (url.includes('/git/revert') && method === 'POST') {
      return makeResponse(endpoints.revert ?? { ok: true, json: { success: true, conflict: false } });
    }
    // Issue #783: network operations (POST). Checked before the GET-shape
    // endpoints; /git/fetch must precede /git/staged-style substring fallbacks.
    if (url.includes('/git/fetch') && method === 'POST') {
      return makeResponse(endpoints.netFetch ?? { ok: true, json: { success: true } });
    }
    if (url.includes('/git/pull') && method === 'POST') {
      return makeResponse(endpoints.pull ?? { ok: true, json: { success: true } });
    }
    if (url.includes('/git/push') && method === 'POST') {
      return makeResponse(endpoints.push ?? { ok: true, json: { success: true } });
    }
    if (url.includes('/git/status')) {
      return makeResponse(endpoints.status ?? { ok: true, json: DEFAULT_STATUS });
    }
    if (url.includes('/git/show')) {
      return makeResponse(
        endpoints.show ?? {
          ok: true,
          json: {
            commit: { hash: 'abc1234', shortHash: 'abc1234', message: 'test', author: 'a', date: '2026-01-01' },
            files: [{ path: 'src/file.ts', status: 'modified' }],
          },
        }
      );
    }
    if (url.includes('/git/working-diff')) {
      return makeResponse(endpoints.workingDiff ?? { ok: true, json: { diff: '' } });
    }
    if (url.includes('/git/diff')) {
      return makeResponse(endpoints.diff ?? { ok: true, json: { diff: '' } });
    }
    // /git/log (default)
    return makeResponse(endpoints.log ?? { ok: true, json: { commits: [] } });
  });
}

/**
 * Issue #815: expand the collapsed "Advanced operations" group (Fetch / Branches
 * create+delete / Stash / Danger Zone). The toggle header is always rendered.
 */
function openAdvanced() {
  fireEvent.click(screen.getByTestId('git-advanced-toggle'));
}

/**
 * Issue #815: open the core branch-checkout dropdown menu. The trigger is
 * disabled until the mount /git/branches fetch populates the list, so we wait
 * for it to enable before opening.
 */
async function openCheckoutMenu() {
  const toggle = screen.getByTestId('branch-checkout-dropdown-toggle');
  await waitFor(() => expect(toggle).not.toBeDisabled());
  fireEvent.click(toggle);
}

/**
 * Issue #815: Danger Zone now lives under the collapsed Advanced group AND keeps
 * its own collapsed toggle. Expand both to reach Reset/Revert/Force-push.
 */
async function openDangerZone() {
  await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
  openAdvanced();
  await waitFor(() => expect(screen.getByTestId('git-danger-zone-toggle')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('git-danger-zone-toggle'));
}

describe('GitPane', () => {
  const defaultProps = {
    worktreeId: 'test-worktree-id',
    onDiffSelect: vi.fn() as (diff: string, filePath: string) => void,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    setEndpoints();
    // Issue #815: GitPane persists the Advanced group open-state to localStorage.
    // jsdom shares localStorage across tests in a file, so reset it to keep the
    // default-collapsed precondition deterministic per test.
    window.localStorage.clear();
  });

  describe('Loading state', () => {
    it('should show loading indicator on mount', () => {
      mockFetch.mockReturnValue(new Promise(() => {})); // Never resolves
      render(<GitPane {...defaultProps} />);

      // Commit-history loading spinner (role=status) is present on mount
      expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    });
  });

  describe('Empty state', () => {
    it('should show empty message when no commits', async () => {
      setEndpoints({ log: { ok: true, json: { commits: [] } } });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('No commits found')).toBeInTheDocument();
      });
    });
  });

  describe('Error state', () => {
    it('should show commit error message on fetch failure', async () => {
      setEndpoints({ log: { ok: false, json: { error: 'Not a git repository' } } });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Not a git repository')).toBeInTheDocument();
      });
    });

    it('should show error on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Failed to fetch commit history')).toBeInTheDocument();
      });
    });
  });

  describe('Commit list', () => {
    it('should display commit list', async () => {
      setEndpoints({
        log: {
          ok: true,
          json: {
            commits: [
              { hash: 'abc1234', shortHash: 'abc1234', message: 'feat: add feature', author: 'Author', date: '2026-03-08T00:00:00Z' },
              { hash: 'def5678', shortHash: 'def5678', message: 'fix: resolve bug', author: 'Author2', date: '2026-03-07T00:00:00Z' },
            ],
          },
        },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('feat: add feature')).toBeInTheDocument();
        expect(screen.getByText('fix: resolve bug')).toBeInTheDocument();
      });
    });
  });

  describe('Refresh button', () => {
    it('should have a refresh button', async () => {
      setEndpoints({ log: { ok: true, json: { commits: [] } } });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Refresh commit history')).toBeInTheDocument();
      });
    });

    it('should refetch commits on refresh click', async () => {
      setEndpoints({ log: { ok: true, json: { commits: [] } } });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('No commits found')).toBeInTheDocument();
      });

      // Mount = 2 fetches (log + status). After refresh, log is fetched once more.
      const beforeRefresh = mockFetch.mock.calls.length;
      fireEvent.click(screen.getByLabelText('Refresh commit history'));

      await waitFor(() => {
        expect(mockFetch.mock.calls.length).toBe(beforeRefresh + 1);
      });
      // Verify the extra call was the commit-log endpoint
      const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(lastUrl).toContain('/git/log');
    });
  });

  describe('Commit selection', () => {
    it('should fetch changed files when commit is clicked', async () => {
      setEndpoints({
        log: {
          ok: true,
          json: {
            commits: [
              { hash: 'abc1234', shortHash: 'abc1234', message: 'test', author: 'a', date: '2026-01-01' },
            ],
          },
        },
        show: {
          ok: true,
          json: {
            commit: { hash: 'abc1234', shortHash: 'abc1234', message: 'test', author: 'a', date: '2026-01-01' },
            files: [{ path: 'src/file.ts', status: 'modified' }],
          },
        },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('test')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('test'));

      await waitFor(() => {
        expect(screen.getByText('Changed Files')).toBeInTheDocument();
        expect(screen.getByText('src/file.ts')).toBeInTheDocument();
      });
    });
  });

  describe('Header', () => {
    it('should show Commit History title', async () => {
      setEndpoints({ log: { ok: true, json: { commits: [] } } });

      render(<GitPane {...defaultProps} />);

      expect(screen.getByText('Commit History')).toBeInTheDocument();
    });
  });

  describe('Custom className', () => {
    it('should apply custom className', () => {
      mockFetch.mockReturnValue(new Promise(() => {}));
      const { container } = render(<GitPane {...defaultProps} className="custom-class" />);

      expect(container.firstChild).toHaveClass('custom-class');
    });
  });

  // --------------------------------------------------------------------------
  // Issue #779: Current Status section
  // --------------------------------------------------------------------------
  describe('Current Status (Issue #779)', () => {
    it('should render the branch chip from /git/status', async () => {
      setEndpoints({
        status: {
          ok: true,
          json: { ...DEFAULT_STATUS, currentBranch: 'feature/awesome' },
        },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('git-status-branch-chip')).toHaveTextContent('feature/awesome');
      });
    });

    it('should self-fetch the /git/status endpoint on mount', async () => {
      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        const calledStatus = mockFetch.mock.calls.some(
          (call) => typeof call[0] === 'string' && call[0].includes('/git/status')
        );
        expect(calledStatus).toBe(true);
      });
    });

    it('should show the dirty badge when isDirty is true', async () => {
      setEndpoints({
        status: { ok: true, json: { ...DEFAULT_STATUS, isDirty: true } },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('git-status-dirty-badge')).toBeInTheDocument();
      });
    });

    it('should NOT show the dirty badge when isDirty is false', async () => {
      setEndpoints({
        status: { ok: true, json: { ...DEFAULT_STATUS, isDirty: false } },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('git-status-branch-chip')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('git-status-dirty-badge')).not.toBeInTheDocument();
    });

    it('should show ahead/behind counts when aheadBehind is non-null', async () => {
      setEndpoints({
        status: {
          ok: true,
          json: { ...DEFAULT_STATUS, aheadBehind: { ahead: 2, behind: 1 } },
        },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        const ab = screen.getByTestId('git-status-ahead-behind');
        expect(ab).toHaveTextContent('2');
        expect(ab).toHaveTextContent('1');
      });
    });

    it('should hide ahead/behind when aheadBehind is null', async () => {
      setEndpoints({
        status: { ok: true, json: { ...DEFAULT_STATUS, aheadBehind: null } },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('git-status-branch-chip')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('git-status-ahead-behind')).not.toBeInTheDocument();
    });

    it('should show branch mismatch warning when isBranchMismatch is true', async () => {
      setEndpoints({
        status: {
          ok: true,
          json: {
            ...DEFAULT_STATUS,
            currentBranch: 'feature/x',
            initialBranch: 'main',
            isBranchMismatch: true,
          },
        },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('git-status-mismatch-warning')).toBeInTheDocument();
      });
    });

    it('should show an error indicator when /git/status fails (without blocking commits)', async () => {
      setEndpoints({
        status: { ok: false, json: { error: 'Failed' } },
        log: {
          ok: true,
          json: {
            commits: [
              { hash: 'abc1234', shortHash: 'abc1234', message: 'still here', author: 'a', date: '2026-01-01' },
            ],
          },
        },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('git-status-error')).toBeInTheDocument();
      });
      // Commit history is unaffected
      expect(screen.getByText('still here')).toBeInTheDocument();
    });

    it('should have its own refresh button for current status', async () => {
      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Refresh git status')).toBeInTheDocument();
      });
    });

    it('should refetch /git/status when the status refresh button is clicked', async () => {
      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Refresh git status')).toBeInTheDocument();
      });

      const statusCallsBefore = mockFetch.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('/git/status')
      ).length;

      fireEvent.click(screen.getByLabelText('Refresh git status'));

      await waitFor(() => {
        const statusCallsAfter = mockFetch.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].includes('/git/status')
        ).length;
        expect(statusCallsAfter).toBe(statusCallsBefore + 1);
      });
    });

    it('should render compact current status in mobile mode', async () => {
      setEndpoints({
        status: { ok: true, json: { ...DEFAULT_STATUS, currentBranch: 'feature/mobile', isDirty: true } },
      });

      render(<GitPane {...defaultProps} isMobile />);

      await waitFor(() => {
        expect(screen.getByTestId('git-status-branch-chip')).toHaveTextContent('feature/mobile');
        expect(screen.getByTestId('git-status-dirty-badge')).toBeInTheDocument();
      });
    });
  });

  // --------------------------------------------------------------------------
  // Issue #780: Changes section (staged / unstaged / untracked + commit form)
  // --------------------------------------------------------------------------
  describe('Changes (Issue #780)', () => {
    const STAGED_PAYLOAD = {
      staged: [{ path: 'src/staged.ts', status: 'modified' }],
      unstaged: [{ path: 'src/unstaged.ts', status: 'modified' }],
      untracked: [{ path: 'src/new.ts', status: 'untracked' }],
    };

    it('should self-fetch /git/staged on mount', async () => {
      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        const calledStaged = mockFetch.mock.calls.some(
          (call) => typeof call[0] === 'string' && call[0].includes('/git/staged')
        );
        expect(calledStaged).toBe(true);
      });
    });

    it('should render the three Changes lists', async () => {
      setEndpoints({ staged: { ok: true, json: STAGED_PAYLOAD } });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('git-changes-section')).toBeInTheDocument();
        expect(screen.getByTestId('git-staged-list')).toBeInTheDocument();
        expect(screen.getByTestId('git-unstaged-list')).toBeInTheDocument();
        expect(screen.getByTestId('git-untracked-list')).toBeInTheDocument();
      });

      expect(screen.getByText('src/staged.ts')).toBeInTheDocument();
      expect(screen.getByText('src/unstaged.ts')).toBeInTheDocument();
      expect(screen.getByText('src/new.ts')).toBeInTheDocument();
    });

    it('should render distinct status labels including untracked and unmerged', async () => {
      setEndpoints({
        staged: {
          ok: true,
          json: {
            staged: [{ path: 'a.ts', status: 'added' }],
            unstaged: [{ path: 'c.ts', status: 'unmerged' }],
            untracked: [{ path: 'd.ts', status: 'untracked' }],
          },
        },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('unmerged')).toBeInTheDocument();
        expect(screen.getByText('untracked')).toBeInTheDocument();
        expect(screen.getByText('added')).toBeInTheDocument();
      });
    });

    it('should POST /git/stage and refetch on stage click', async () => {
      setEndpoints({ staged: { ok: true, json: STAGED_PAYLOAD } });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Stage src/unstaged.ts')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText('Stage src/unstaged.ts'));

      await waitFor(() => {
        const stageCall = mockFetch.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('/git/stage') &&
            (call[1] as { method?: string } | undefined)?.method === 'POST'
        );
        expect(stageCall).toBeTruthy();
      });
    });

    it('should POST /git/unstage on unstage click', async () => {
      setEndpoints({ staged: { ok: true, json: STAGED_PAYLOAD } });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Unstage src/staged.ts')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText('Unstage src/staged.ts'));

      await waitFor(() => {
        const unstageCall = mockFetch.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('/git/unstage') &&
            (call[1] as { method?: string } | undefined)?.method === 'POST'
        );
        expect(unstageCall).toBeTruthy();
      });
    });

    it('should disable the commit button when the message is empty', async () => {
      setEndpoints({ staged: { ok: true, json: STAGED_PAYLOAD } });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('git-commit-button')).toBeInTheDocument();
      });

      expect(screen.getByTestId('git-commit-button')).toBeDisabled();
    });

    it('should POST /git/commit and refetch commits + status on commit', async () => {
      setEndpoints({ staged: { ok: true, json: STAGED_PAYLOAD } });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('git-commit-message')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('git-commit-message'), {
        target: { value: 'feat: my change' },
      });
      fireEvent.click(screen.getByTestId('git-commit-button'));

      await waitFor(() => {
        const commitCall = mockFetch.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('/git/commit') &&
            (call[1] as { method?: string } | undefined)?.method === 'POST'
        );
        expect(commitCall).toBeTruthy();
      });

      // After a successful commit, the commit history (/git/log) is refetched.
      await waitFor(() => {
        const logCalls = mockFetch.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].includes('/git/log')
        );
        // mount(1) + post-commit refetch(1)
        expect(logCalls.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('should surface a commit error inline', async () => {
      setEndpoints({
        staged: { ok: true, json: STAGED_PAYLOAD },
        commit: { ok: false, json: { error: 'No staged changes to commit' } },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('git-commit-message')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('git-commit-message'), {
        target: { value: 'feat: nope' },
      });
      fireEvent.click(screen.getByTestId('git-commit-button'));

      await waitFor(() => {
        expect(screen.getByTestId('git-commit-error')).toHaveTextContent('No staged changes to commit');
      });
    });

    it('should show an inline error when /git/staged fails', async () => {
      setEndpoints({ staged: { ok: false, json: { error: 'Not a git repository' } } });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('git-changes-error')).toBeInTheDocument();
      });
    });

    it('should fetch /git/working-diff with mode=unstaged when an unstaged Diff button is clicked', async () => {
      const onDiffSelect = vi.fn();
      setEndpoints({
        staged: { ok: true, json: STAGED_PAYLOAD },
        workingDiff: { ok: true, json: { diff: 'diff --git a/u b/u\n+x' } },
      });

      render(<GitPane {...defaultProps} onDiffSelect={onDiffSelect} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Show diff for src/unstaged.ts')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText('Show diff for src/unstaged.ts'));

      await waitFor(() => {
        const wdCall = mockFetch.mock.calls.find(
          (call) => typeof call[0] === 'string' && (call[0] as string).includes('/git/working-diff')
        );
        expect(wdCall).toBeTruthy();
        const url = wdCall![0] as string;
        expect(url).toContain('mode=unstaged');
        expect(url).toContain(`file=${encodeURIComponent('src/unstaged.ts')}`);
      });

      // Diff is surfaced through the same onDiffSelect path as commit diffs.
      await waitFor(() => {
        expect(onDiffSelect).toHaveBeenCalledWith('diff --git a/u b/u\n+x', 'src/unstaged.ts');
      });
    });

    it('should fetch /git/working-diff with mode=staged for a staged Diff button', async () => {
      setEndpoints({
        staged: { ok: true, json: STAGED_PAYLOAD },
        workingDiff: { ok: true, json: { diff: 'staged diff' } },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Show diff for src/staged.ts')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText('Show diff for src/staged.ts'));

      await waitFor(() => {
        const wdCall = mockFetch.mock.calls.find(
          (call) => typeof call[0] === 'string' && (call[0] as string).includes('/git/working-diff')
        );
        expect(wdCall).toBeTruthy();
        expect(wdCall![0] as string).toContain('mode=staged');
      });
    });

    it('should fetch /git/working-diff with mode=untracked for an untracked Diff button', async () => {
      setEndpoints({
        staged: { ok: true, json: STAGED_PAYLOAD },
        workingDiff: { ok: true, json: { diff: 'untracked diff' } },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Show diff for src/new.ts')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText('Show diff for src/new.ts'));

      await waitFor(() => {
        const wdCall = mockFetch.mock.calls.find(
          (call) => typeof call[0] === 'string' && (call[0] as string).includes('/git/working-diff')
        );
        expect(wdCall).toBeTruthy();
        expect(wdCall![0] as string).toContain('mode=untracked');
      });
    });
  });

  // --------------------------------------------------------------------------
  // Issue #781: Branches section (list / checkout / create / delete)
  // --------------------------------------------------------------------------
  describe('Branches (Issue #781)', () => {
    // S3-001 history-loss warning text (Japanese) that MUST appear in the checkout
    // confirm dialog. Imported from the single source of truth so this assertion
    // tracks the component verbatim (no drift between a test-local copy and the UI).
    const HISTORY_LOSS_TEXT = CHECKOUT_HISTORY_LOSS_WARNING;

    it('self-fetches /git/branches on mount', async () => {
      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        const called = mockFetch.mock.calls.some(
          (call) => typeof call[0] === 'string' && call[0].includes('/git/branches')
        );
        expect(called).toBe(true);
      });
    });

    it('renders the Branches section (create/delete) under Advanced operations', async () => {
      render(<GitPane {...defaultProps} />);

      // Issue #815: Branches moved under the collapsed Advanced group.
      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      expect(screen.queryByTestId('git-branches-section')).not.toBeInTheDocument();

      openAdvanced();

      await waitFor(() => {
        expect(screen.getByTestId('git-branches-section')).toBeInTheDocument();
        expect(screen.getByText('main')).toBeInTheDocument();
        expect(screen.getByText('feature/current')).toBeInTheDocument();
      });
    });

    it('shows the S3-001 history-loss warning in the checkout confirm dialog', async () => {
      render(<GitPane {...defaultProps} />);

      // Issue #815: checkout is now a core dropdown beside Quick actions.
      await openCheckoutMenu();
      fireEvent.click(screen.getByLabelText('Checkout main'));

      await waitFor(() => {
        expect(screen.getByTestId('branch-checkout-confirm')).toBeInTheDocument();
        expect(screen.getByTestId('branch-history-loss-warning')).toHaveTextContent(HISTORY_LOSS_TEXT);
      });
    });

    it('shows the S3-002 running-session warning when a session is running', async () => {
      const worktree = {
        sessionStatusByCli: {
          claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
        },
      };
      render(<GitPane {...defaultProps} worktree={worktree as never} />);

      await openCheckoutMenu();
      fireEvent.click(screen.getByLabelText('Checkout main'));

      await waitFor(() => {
        expect(screen.getByTestId('branch-session-warning')).toHaveTextContent(
          CHECKOUT_RUNNING_SESSION_WARNING
        );
      });
    });

    it('does NOT show the running-session warning when no session is running', async () => {
      const worktree = {
        sessionStatusByCli: {
          claude: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
        },
      };
      render(<GitPane {...defaultProps} worktree={worktree as never} />);

      await openCheckoutMenu();
      fireEvent.click(screen.getByLabelText('Checkout main'));

      await waitFor(() => {
        expect(screen.getByTestId('branch-checkout-confirm')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('branch-session-warning')).not.toBeInTheDocument();
    });

    it('POSTs /git/checkout and refetches on confirm', async () => {
      render(<GitPane {...defaultProps} />);

      await openCheckoutMenu();
      fireEvent.click(screen.getByLabelText('Checkout main'));

      await waitFor(() => {
        expect(screen.getByTestId('branch-checkout-confirm-button')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('branch-checkout-confirm-button'));

      await waitFor(() => {
        const checkoutCall = mockFetch.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('/git/checkout') &&
            (call[1] as { method?: string } | undefined)?.method === 'POST'
        );
        expect(checkoutCall).toBeTruthy();
      });

      // S3-005 cascade: status + staged + branches + log all refetch after checkout.
      await waitFor(() => {
        const logCalls = mockFetch.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].includes('/git/log')
        );
        const branchCalls = mockFetch.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].includes('/git/branches')
        );
        expect(logCalls.length).toBeGreaterThanOrEqual(2);
        expect(branchCalls.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('surfaces a checkout error using the reason from the API', async () => {
      setEndpoints({
        checkout: {
          ok: false,
          json: { error: 'Working tree has uncommitted changes', reason: 'dirty' },
        },
      });

      render(<GitPane {...defaultProps} />);

      await openCheckoutMenu();
      fireEvent.click(screen.getByLabelText('Checkout main'));

      await waitFor(() => {
        expect(screen.getByTestId('branch-checkout-confirm-button')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('branch-checkout-confirm-button'));

      await waitFor(() => {
        expect(screen.getByTestId('branch-checkout-error')).toBeInTheDocument();
      });
    });

    it('disables checkout for a branch checked out in another worktree (with a tooltip)', async () => {
      setEndpoints({
        branches: {
          ok: true,
          json: {
            branches: [
              {
                name: 'feature/elsewhere',
                isCurrent: false,
                isRemote: false,
                isDefault: false,
                upstream: null,
                aheadBehind: null,
                checkedOutWorktreePath: '/other/worktree',
              },
            ],
          },
        },
      });

      render(<GitPane {...defaultProps} />);

      await openCheckoutMenu();

      const button = screen.getByLabelText('Checkout feature/elsewhere');
      expect(button).toBeDisabled();
      expect(button.getAttribute('title')).toContain('/other/worktree');
    });

    it('does not offer the current branch in the checkout dropdown', async () => {
      render(<GitPane {...defaultProps} />);

      await openCheckoutMenu();
      // The menu lists checkout-able branches; the current branch is excluded.
      expect(screen.getByLabelText('Checkout main')).toBeInTheDocument();
      expect(screen.queryByLabelText('Checkout feature/current')).not.toBeInTheDocument();
    });

    it('switches to the remote tab and lists remote branches', async () => {
      setEndpoints({
        branches: {
          ok: true,
          json: {
            branches: [
              {
                name: 'origin/release/1.0',
                isCurrent: false,
                isRemote: true,
                isDefault: false,
                upstream: null,
                aheadBehind: null,
                checkedOutWorktreePath: null,
              },
            ],
          },
        },
      });

      render(<GitPane {...defaultProps} />);

      // Issue #815: the local/remote/all tabs live in the Advanced Branches section.
      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();

      await waitFor(() => {
        expect(screen.getByTestId('git-branches-tab-remote')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('git-branches-tab-remote'));

      await waitFor(() => {
        const remoteCall = mockFetch.mock.calls.find(
          (call) => typeof call[0] === 'string' && (call[0] as string).includes('include=remote')
        );
        expect(remoteCall).toBeTruthy();
      });
    });

    it('opens the create-branch modal and POSTs /git/branch/create', async () => {
      render(<GitPane {...defaultProps} />);

      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();

      await waitFor(() => {
        expect(screen.getByTestId('git-branch-create-open')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('git-branch-create-open'));

      await waitFor(() => {
        expect(screen.getByTestId('branch-create-name-input')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('branch-create-name-input'), {
        target: { value: 'feature/created' },
      });
      fireEvent.click(screen.getByTestId('branch-create-submit'));

      await waitFor(() => {
        const createCall = mockFetch.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('/git/branch/create') &&
            (call[1] as { method?: string } | undefined)?.method === 'POST'
        );
        expect(createCall).toBeTruthy();
      });
    });

    it('opens the delete confirm modal and POSTs /git/branch/delete', async () => {
      render(<GitPane {...defaultProps} />);

      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();

      await waitFor(() => {
        expect(screen.getByLabelText('Delete main')).toBeInTheDocument();
      });

      // 'main' is the default branch -> delete should be disabled.
      expect(screen.getByLabelText('Delete main')).toBeDisabled();
    });

    it('confirms deletion of a deletable branch and POSTs /git/branch/delete', async () => {
      setEndpoints({
        branches: {
          ok: true,
          json: {
            branches: [
              {
                name: 'feature/old',
                isCurrent: false,
                isRemote: false,
                isDefault: false,
                upstream: null,
                aheadBehind: null,
                checkedOutWorktreePath: null,
              },
            ],
          },
        },
      });

      render(<GitPane {...defaultProps} />);

      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();

      await waitFor(() => {
        expect(screen.getByLabelText('Delete feature/old')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText('Delete feature/old'));

      await waitFor(() => {
        expect(screen.getByTestId('branch-delete-confirm-button')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('branch-delete-confirm-button'));

      await waitFor(() => {
        const delCall = mockFetch.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('/git/branch/delete') &&
            (call[1] as { method?: string } | undefined)?.method === 'POST'
        );
        expect(delCall).toBeTruthy();
      });
    });
  });

  // --------------------------------------------------------------------------
  // Issue #782: Stash + Danger Zone
  // --------------------------------------------------------------------------

  describe('Stash (Issue #782)', () => {
    it('renders the stash section and fetches the stash list on mount', async () => {
      render(<GitPane {...defaultProps} />);
      // Issue #815: stash is fetched on mount even while Advanced stays collapsed.
      await waitFor(() => {
        const stashCall = mockFetch.mock.calls.some(
          (call) => typeof call[0] === 'string' && call[0].includes('/git/stash') && !call[0].match(/\/git\/stash\/\d/)
        );
        expect(stashCall).toBe(true);
      });
      // The section itself lives under Advanced operations.
      expect(screen.queryByTestId('git-stash-section')).not.toBeInTheDocument();
      openAdvanced();
      await waitFor(() => {
        expect(screen.getByTestId('git-stash-section')).toBeInTheDocument();
      });
    });

    it('does NOT poll the stash list (mount + mutation only, S3-004)', async () => {
      vi.useFakeTimers();
      try {
        render(<GitPane {...defaultProps} />);
        // Flush the mount microtasks.
        await vi.advanceTimersByTimeAsync(0);
        const before = mockFetch.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].includes('/git/stash')
        ).length;
        // Advance well past the 5s status poll interval.
        await vi.advanceTimersByTimeAsync(15000);
        const after = mockFetch.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].includes('/git/stash')
        ).length;
        expect(after).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    });

    it('lists stashes returned by the API', async () => {
      setEndpoints({
        stash: {
          ok: true,
          json: {
            stashes: [
              { index: 0, message: 'WIP on main: a', branch: 'main', date: '2026-01-01', sha: 'sha0' },
            ],
          },
        },
      });
      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();
      await waitFor(() => {
        expect(screen.getByTestId('git-stash-row')).toBeInTheDocument();
      });
      expect(screen.getByTestId('stash-pop-button')).toBeInTheDocument();
      expect(screen.getByTestId('stash-apply-button')).toBeInTheDocument();
      expect(screen.getByTestId('stash-drop-button')).toBeInTheDocument();
    });

    it('pushes a stash via the push button', async () => {
      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();
      await waitFor(() => {
        expect(screen.getByTestId('stash-push-button')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('stash-push-button'));
      await waitFor(() => {
        const pushCall = mockFetch.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('/git/stash/push') &&
            (call[1] as { method?: string } | undefined)?.method === 'POST'
        );
        expect(pushCall).toBeTruthy();
      });
    });

    it('drop requires confirmation then dispatches DELETE', async () => {
      setEndpoints({
        stash: {
          ok: true,
          json: {
            stashes: [{ index: 0, message: 'WIP on main: a', branch: 'main', date: '2026-01-01', sha: 'sha0' }],
          },
        },
      });
      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();
      await waitFor(() => {
        expect(screen.getByTestId('stash-drop-button')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('stash-drop-button'));
      await waitFor(() => {
        expect(screen.getByTestId('git-stash-drop-confirm-button')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('git-stash-drop-confirm-button'));
      await waitFor(() => {
        const dropCall = mockFetch.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            /\/git\/stash\/0$/.test(call[0]) &&
            (call[1] as { method?: string } | undefined)?.method === 'DELETE'
        );
        expect(dropCall).toBeTruthy();
      });
    });

    it('surfaces a conflict notice when pop returns 200 with conflict (parity with revert)', async () => {
      setEndpoints({
        stash: {
          ok: true,
          json: {
            stashes: [{ index: 0, message: 'WIP on main: a', branch: 'main', date: '2026-01-01', sha: 'sha0' }],
          },
        },
        stashPop: {
          ok: true,
          json: { success: true, conflict: true, conflictFiles: ['a.ts'], stashRetained: true },
        },
      });
      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();
      await waitFor(() => {
        expect(screen.getByTestId('stash-pop-button')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('stash-pop-button'));
      await waitFor(() => {
        expect(screen.getByTestId('git-stash-conflict')).toBeInTheDocument();
      });
      expect(screen.getByTestId('git-stash-conflict').textContent).toContain('a.ts');
      expect(screen.getByTestId('git-stash-conflict').textContent).toContain('stash retained');
    });
  });

  describe('Danger Zone (Issue #782)', () => {
    it('renders the Danger Zone section collapsed by default', async () => {
      render(<GitPane {...defaultProps} />);
      // Issue #815: Danger Zone lives under the collapsed Advanced group.
      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      expect(screen.queryByTestId('git-danger-zone-section')).not.toBeInTheDocument();
      openAdvanced();
      await waitFor(() => {
        expect(screen.getByTestId('git-danger-zone-section')).toBeInTheDocument();
      });
      // Collapsed: the Reset/Revert open buttons are not rendered yet.
      expect(screen.queryByTestId('git-danger-zone-reset-open')).not.toBeInTheDocument();
    });

    it('opens the Reset modal and shows the hard-mode warnings + branch confirm input', async () => {
      render(<GitPane {...defaultProps} />);
      await openDangerZone();
      fireEvent.click(screen.getByTestId('git-danger-zone-reset-open'));
      await waitFor(() => {
        expect(screen.getByTestId('reset-confirm')).toBeInTheDocument();
      });
      // Switch to hard mode -> warnings + confirm input appear.
      fireEvent.click(screen.getByTestId('reset-mode-hard'));
      expect(screen.getByTestId('reset-hard-history-loss-warning')).toHaveTextContent(
        RESET_HARD_HISTORY_LOSS_WARNING
      );
      expect(screen.getByTestId('reset-hard-branch-input')).toBeInTheDocument();
    });

    it('keeps the hard Reset button disabled until the branch confirmation matches', async () => {
      render(<GitPane {...defaultProps} />);
      await openDangerZone();
      fireEvent.click(screen.getByTestId('git-danger-zone-reset-open'));
      fireEvent.click(screen.getByTestId('reset-mode-hard'));
      const confirmButton = screen.getByTestId('reset-confirm-button');
      expect(confirmButton).toBeDisabled();
      // DEFAULT_STATUS.currentBranch is 'feature/test'.
      fireEvent.change(screen.getByTestId('reset-hard-branch-input'), {
        target: { value: 'feature/test' },
      });
      expect(screen.getByTestId('reset-confirm-button')).not.toBeDisabled();
    });

    it('dispatches a soft reset with target HEAD', async () => {
      render(<GitPane {...defaultProps} />);
      await openDangerZone();
      fireEvent.click(screen.getByTestId('git-danger-zone-reset-open'));
      fireEvent.click(screen.getByTestId('reset-mode-soft'));
      fireEvent.click(screen.getByTestId('reset-confirm-button'));
      await waitFor(() => {
        const resetCall = mockFetch.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('/git/reset') &&
            (call[1] as { method?: string } | undefined)?.method === 'POST'
        );
        expect(resetCall).toBeTruthy();
        const body = JSON.parse((resetCall?.[1] as { body: string }).body);
        expect(body).toMatchObject({ target: 'HEAD', mode: 'soft' });
      });
    });

    it('Revert button is disabled until a commit is selected', async () => {
      setEndpoints({
        log: {
          ok: true,
          json: {
            commits: [
              { hash: 'deadbeef0000000000000000000000000000abcd', shortHash: 'deadbee', message: 'm', author: 'a', date: '2026-01-01' },
            ],
          },
        },
      });
      render(<GitPane {...defaultProps} />);
      await openDangerZone();
      expect(screen.getByTestId('git-danger-zone-revert-open')).toBeDisabled();

      // Select a commit, then the revert open button becomes enabled.
      fireEvent.click(screen.getByText('m'));
      await waitFor(() => {
        expect(screen.getByTestId('git-danger-zone-revert-open')).not.toBeDisabled();
      });
      fireEvent.click(screen.getByTestId('git-danger-zone-revert-open'));
      await waitFor(() => expect(screen.getByTestId('revert-confirm')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('revert-confirm-button'));
      await waitFor(() => {
        const revertCall = mockFetch.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('/git/revert') &&
            (call[1] as { method?: string } | undefined)?.method === 'POST'
        );
        expect(revertCall).toBeTruthy();
        const body = JSON.parse((revertCall?.[1] as { body: string }).body);
        expect(body.commitHash).toBe('deadbeef0000000000000000000000000000abcd');
      });
    });
  });

  // --------------------------------------------------------------------------
  // Issue #783: Network operations (push / pull / fetch) — Phase 5/5
  // --------------------------------------------------------------------------
  describe('Network operations (Issue #783)', () => {
    /** Count fetch calls to a given path with an optional method filter. */
    const countCalls = (path: string, method?: string) =>
      mockFetch.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes(path) &&
          (method === undefined ||
            (call[1] as { method?: string } | undefined)?.method === method)
      ).length;

    const findCall = (path: string, method = 'POST') =>
      mockFetch.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes(path) &&
          (call[1] as { method?: string } | undefined)?.method === method
      );

    it('renders core Pull / Push buttons and the Advanced Fetch button', async () => {
      render(<GitPane {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId('git-pull-button')).toBeInTheDocument();
        expect(screen.getByTestId('git-push-button')).toBeInTheDocument();
      });
      // Issue #815: Fetch was demoted to the collapsed Advanced group.
      expect(screen.queryByTestId('git-fetch-button')).not.toBeInTheDocument();
      openAdvanced();
      await waitFor(() => {
        expect(screen.getByTestId('git-fetch-button')).toBeInTheDocument();
      });
    });

    it('POSTs /git/fetch when the Fetch button is clicked', async () => {
      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();
      await waitFor(() => expect(screen.getByTestId('git-fetch-button')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('git-fetch-button'));
      await waitFor(() => {
        expect(findCall('/git/fetch')).toBeTruthy();
      });
    });

    it('POSTs /git/pull when the Pull button is clicked', async () => {
      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-pull-button')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('git-pull-button'));
      await waitFor(() => {
        expect(findCall('/git/pull')).toBeTruthy();
      });
    });

    it('POSTs /git/push (with setUpstream when no upstream) when the Push button is clicked', async () => {
      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-push-button')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('git-push-button'));
      await waitFor(() => {
        const pushCall = findCall('/git/push');
        expect(pushCall).toBeTruthy();
        const body = JSON.parse((pushCall?.[1] as { body: string }).body);
        // No ahead/behind chip in DEFAULT_STATUS (aheadBehind null) => setUpstream.
        expect(body.setUpstream).toBe(true);
      });
    });

    it('shows the spinner + abort button while an operation is in-flight', async () => {
      // Make /git/push hang so we can observe the running state.
      let resolvePush: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
        if (url.includes('/git/push') && init?.method === 'POST') {
          return new Promise((res) => {
            resolvePush = () => res({ ok: true, json: () => Promise.resolve({ success: true }) });
          });
        }
        if (url.includes('/git/status')) return makeResponse({ ok: true, json: DEFAULT_STATUS });
        if (url.includes('/git/staged')) return makeResponse({ ok: true, json: DEFAULT_STAGED });
        if (url.includes('/git/branches')) return makeResponse({ ok: true, json: DEFAULT_BRANCHES });
        if (url.includes('/git/stash')) return makeResponse({ ok: true, json: { stashes: [] } });
        return makeResponse({ ok: true, json: { commits: [] } });
      });

      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-push-button')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('git-push-button'));

      await waitFor(() => {
        expect(screen.getByTestId('git-network-operation-spinner')).toBeInTheDocument();
        expect(screen.getByTestId('git-network-abort-button')).toBeInTheDocument();
      });

      // Resolve to clean up.
      resolvePush?.(undefined);
      await waitFor(() =>
        expect(screen.queryByTestId('git-network-operation-spinner')).not.toBeInTheDocument()
      );
    });

    it('disables sibling write buttons (Stage/Unstage) during a push and re-enables after (DR3-004)', async () => {
      let resolvePush: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
        if (url.includes('/git/push') && init?.method === 'POST') {
          return new Promise((res) => {
            resolvePush = () => res({ ok: true, json: () => Promise.resolve({ success: true }) });
          });
        }
        if (url.includes('/git/staged')) {
          return makeResponse({
            ok: true,
            json: {
              staged: [{ path: 'src/staged.ts', status: 'modified' }],
              unstaged: [],
              untracked: [],
            },
          });
        }
        if (url.includes('/git/status')) return makeResponse({ ok: true, json: DEFAULT_STATUS });
        if (url.includes('/git/branches')) return makeResponse({ ok: true, json: DEFAULT_BRANCHES });
        if (url.includes('/git/stash')) return makeResponse({ ok: true, json: { stashes: [] } });
        return makeResponse({ ok: true, json: { commits: [] } });
      });

      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-push-button')).toBeInTheDocument());

      // The toggle is rendered from /git/staged, which resolves independently of the
      // /git/status fetch the push button waits on — wait for it before asserting.
      await waitFor(() =>
        expect(screen.getByTestId('git-changes-toggle-button')).toBeInTheDocument()
      );

      // The staged file's Unstage toggle is enabled (busy=false) initially.
      const toggleBefore = screen.getByTestId('git-changes-toggle-button');
      expect(toggleBefore).not.toBeDisabled();

      fireEvent.click(screen.getByTestId('git-push-button'));

      await waitFor(() =>
        expect(screen.getByTestId('git-changes-toggle-button')).toBeDisabled()
      );

      resolvePush?.(undefined);
      await waitFor(() =>
        expect(screen.getByTestId('git-changes-toggle-button')).not.toBeDisabled()
      );
    });

    it('does NOT disable sibling write buttons during a fetch (fetch exempt, DR3-004)', async () => {
      let resolveFetch: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
        if (url.includes('/git/fetch') && init?.method === 'POST') {
          return new Promise((res) => {
            resolveFetch = () => res({ ok: true, json: () => Promise.resolve({ success: true }) });
          });
        }
        if (url.includes('/git/staged')) {
          return makeResponse({
            ok: true,
            json: {
              staged: [{ path: 'src/staged.ts', status: 'modified' }],
              unstaged: [],
              untracked: [],
            },
          });
        }
        if (url.includes('/git/status')) return makeResponse({ ok: true, json: DEFAULT_STATUS });
        if (url.includes('/git/branches')) return makeResponse({ ok: true, json: DEFAULT_BRANCHES });
        if (url.includes('/git/stash')) return makeResponse({ ok: true, json: { stashes: [] } });
        return makeResponse({ ok: true, json: { commits: [] } });
      });

      render(<GitPane {...defaultProps} />);
      // Issue #815: Fetch lives under the collapsed Advanced group.
      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();
      await waitFor(() => expect(screen.getByTestId('git-fetch-button')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('git-fetch-button'));

      // Spinner appears (fetch in-flight) but the Unstage toggle stays enabled.
      await waitFor(() =>
        expect(screen.getByTestId('git-network-operation-spinner')).toBeInTheDocument()
      );
      // Same race as above: the toggle comes from /git/staged, not from the fetch
      // the spinner tracks, so its presence must be awaited before asserting on it.
      await waitFor(() =>
        expect(screen.getByTestId('git-changes-toggle-button')).toBeInTheDocument()
      );
      expect(screen.getByTestId('git-changes-toggle-button')).not.toBeDisabled();

      resolveFetch?.(undefined);
      await waitFor(() =>
        expect(screen.queryByTestId('git-network-operation-spinner')).not.toBeInTheDocument()
      );
    });

    it('pauses the 5s status poll while a push is in-flight and resumes after (DR3-006)', async () => {
      let resolvePush: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
        if (url.includes('/git/push') && init?.method === 'POST') {
          return new Promise((res) => {
            resolvePush = () => res({ ok: true, json: () => Promise.resolve({ success: true }) });
          });
        }
        if (url.includes('/git/status')) return makeResponse({ ok: true, json: DEFAULT_STATUS });
        if (url.includes('/git/staged')) return makeResponse({ ok: true, json: DEFAULT_STAGED });
        if (url.includes('/git/branches')) return makeResponse({ ok: true, json: DEFAULT_BRANCHES });
        if (url.includes('/git/stash')) return makeResponse({ ok: true, json: { stashes: [] } });
        return makeResponse({ ok: true, json: { commits: [] } });
      });

      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-push-button')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('git-push-button'));
      await waitFor(() =>
        expect(screen.getByTestId('git-network-operation-spinner')).toBeInTheDocument()
      );

      // While in-flight, the status poll is paused: the only /git/status calls
      // are the cascade + mount fetch, not a growing poll. We assert the count
      // is stable across a tick.
      const statusCallsDuring = countCalls('/git/status', 'GET');
      await new Promise((r) => setTimeout(r, 50));
      expect(countCalls('/git/status', 'GET')).toBe(statusCallsDuring);

      resolvePush?.(undefined);
      await waitFor(() =>
        expect(screen.queryByTestId('git-network-operation-spinner')).not.toBeInTheDocument()
      );
    });

    it('runs the cascade (re-fetch status + branches) after a fetch completes (§7.5)', async () => {
      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();
      await waitFor(() => expect(screen.getByTestId('git-fetch-button')).toBeInTheDocument());

      // GET reads in GitPane use fetch(url) with no `method`, so count without a
      // method filter (the cascade re-fetches status + branches after settle).
      const statusBefore = countCalls('/git/status');
      const branchesBefore = countCalls('/git/branches');

      fireEvent.click(screen.getByTestId('git-fetch-button'));

      await waitFor(() => {
        expect(countCalls('/git/status')).toBeGreaterThan(statusBefore);
        expect(countCalls('/git/branches')).toBeGreaterThan(branchesBefore);
      });
    });

    it('surfaces the auth_failed guidance when push is rejected', async () => {
      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-push-button')).toBeInTheDocument());
      setEndpoints({
        push: { ok: false, json: { error: 'Authentication failed', reason: 'auth_failed' } },
      });
      fireEvent.click(screen.getByTestId('git-push-button'));
      await waitFor(() => {
        expect(screen.getByTestId('git-network-operation-error')).toHaveTextContent(
          PUSH_AUTH_FAILED_GUIDANCE
        );
      });
    });

    it('renders the Mobile progress bar as a sticky (z<50) element, below confirm modals (DR3-007)', async () => {
      let resolvePush: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
        if (url.includes('/git/push') && init?.method === 'POST') {
          return new Promise((res) => {
            resolvePush = () => res({ ok: true, json: () => Promise.resolve({ success: true }) });
          });
        }
        if (url.includes('/git/status')) return makeResponse({ ok: true, json: DEFAULT_STATUS });
        if (url.includes('/git/staged')) return makeResponse({ ok: true, json: DEFAULT_STAGED });
        if (url.includes('/git/branches')) return makeResponse({ ok: true, json: DEFAULT_BRANCHES });
        if (url.includes('/git/stash')) return makeResponse({ ok: true, json: { stashes: [] } });
        return makeResponse({ ok: true, json: { commits: [] } });
      });

      render(<GitPane {...defaultProps} isMobile />);
      await waitFor(() => expect(screen.getByTestId('git-push-button')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('git-push-button'));

      await waitFor(() =>
        expect(screen.getByTestId('git-network-progress-bar')).toBeInTheDocument()
      );
      const bar = screen.getByTestId('git-network-progress-bar');
      expect(bar.className).toContain('sticky');
      // Below the z-50 confirm modals (must NOT be z-50 or higher).
      expect(bar.className).not.toContain('z-50');

      resolvePush?.(undefined);
      await waitFor(() =>
        expect(screen.queryByTestId('git-network-operation-spinner')).not.toBeInTheDocument()
      );
    });

    it('keeps the core section data-testids visible and gates the Advanced ones', async () => {
      render(<GitPane {...defaultProps} />);
      // Core sections are always visible (Issue #815 2-tier design).
      await waitFor(() => {
        expect(screen.getByTestId('git-status-section')).toBeInTheDocument();
        expect(screen.getByTestId('git-network-section')).toBeInTheDocument();
        expect(screen.getByTestId('git-changes-section')).toBeInTheDocument();
      });
      // Advanced sections are hidden until the group is expanded.
      expect(screen.queryByTestId('git-branches-section')).not.toBeInTheDocument();
      expect(screen.queryByTestId('git-stash-section')).not.toBeInTheDocument();
      expect(screen.queryByTestId('git-danger-zone-section')).not.toBeInTheDocument();
      openAdvanced();
      await waitFor(() => {
        expect(screen.getByTestId('git-branches-section')).toBeInTheDocument();
        expect(screen.getByTestId('git-stash-section')).toBeInTheDocument();
        expect(screen.getByTestId('git-danger-zone-section')).toBeInTheDocument();
      });
    });

    it('force-pushes via the Danger Zone with --force-with-lease by default (§7.3)', async () => {
      render(<GitPane {...defaultProps} />);

      // Open Advanced + the Danger Zone, then the Force Push modal (Issue #815).
      await openDangerZone();
      fireEvent.click(screen.getByTestId('git-force-push-open'));
      await waitFor(() => expect(screen.getByTestId('force-push-confirm')).toBeInTheDocument());

      // --force-with-lease is checked by default; confirm POSTs /git/push.
      expect(screen.getByTestId('force-push-with-lease')).toBeChecked();
      fireEvent.click(screen.getByTestId('force-push-confirm-button'));

      await waitFor(() => {
        const pushCall = findCall('/git/push');
        expect(pushCall).toBeTruthy();
        const body = JSON.parse((pushCall?.[1] as { body: string }).body);
        expect(body.forceWithLease).toBe(true);
        expect(body.force).toBe(false);
      });
    });

    it('force-pushes with a lease-less --force when the lease checkbox is unticked', async () => {
      render(<GitPane {...defaultProps} />);
      await openDangerZone();
      fireEvent.click(screen.getByTestId('git-force-push-open'));
      await waitFor(() => expect(screen.getByTestId('force-push-confirm')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('force-push-with-lease')); // untick
      fireEvent.click(screen.getByTestId('force-push-confirm-button'));

      await waitFor(() => {
        const pushCall = findCall('/git/push');
        const body = JSON.parse((pushCall?.[1] as { body: string }).body);
        expect(body.force).toBe(true);
        expect(body.forceWithLease).toBe(false);
      });
    });
  });

  // --------------------------------------------------------------------------
  // Issue #815: 2-tier information design (core always-visible + Advanced)
  // --------------------------------------------------------------------------
  describe('2-tier information design (Issue #815)', () => {
    const ADVANCED_KEY = 'commandmate:gitPane:advancedOpen';

    it('shows only the core sections by default and hides the complex ops', async () => {
      render(<GitPane {...defaultProps} />);

      // Core, always visible: Current Status / Quick actions (Pull+Push) /
      // Changes / Commit History.
      await waitFor(() => {
        expect(screen.getByTestId('git-status-section')).toBeInTheDocument();
        expect(screen.getByTestId('git-pull-button')).toBeInTheDocument();
        expect(screen.getByTestId('git-push-button')).toBeInTheDocument();
        expect(screen.getByTestId('git-changes-section')).toBeInTheDocument();
        expect(screen.getByText('Commit History')).toBeInTheDocument();
      });

      // The "Advanced operations" header is present but collapsed by default, so
      // none of Fetch / Branches / Stash / Danger Zone render.
      expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument();
      expect(screen.queryByTestId('git-fetch-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('git-branches-section')).not.toBeInTheDocument();
      expect(screen.queryByTestId('git-stash-section')).not.toBeInTheDocument();
      expect(screen.queryByTestId('git-danger-zone-section')).not.toBeInTheDocument();
    });

    it('expands Fetch / Branches / Stash / Danger Zone when Advanced is clicked', async () => {
      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());

      openAdvanced();

      await waitFor(() => {
        expect(screen.getByTestId('git-fetch-button')).toBeInTheDocument();
        expect(screen.getByTestId('git-branches-section')).toBeInTheDocument();
        expect(screen.getByTestId('git-stash-section')).toBeInTheDocument();
        expect(screen.getByTestId('git-danger-zone-section')).toBeInTheDocument();
      });
    });

    it('persists the Advanced open-state to localStorage on toggle', async () => {
      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());

      // Default closed: nothing persisted yet.
      expect(window.localStorage.getItem(ADVANCED_KEY)).not.toBe('true');

      openAdvanced();
      await waitFor(() => {
        expect(window.localStorage.getItem(ADVANCED_KEY)).toBe('true');
      });

      // Toggling again persists the closed state.
      openAdvanced();
      await waitFor(() => {
        expect(window.localStorage.getItem(ADVANCED_KEY)).toBe('false');
      });
    });

    it('restores the expanded Advanced state from localStorage on mount', async () => {
      window.localStorage.setItem(ADVANCED_KEY, 'true');

      render(<GitPane {...defaultProps} />);

      // Hydrated open on mount: the advanced sections render without a click.
      await waitFor(() => {
        expect(screen.getByTestId('git-branches-section')).toBeInTheDocument();
        expect(screen.getByTestId('git-danger-zone-section')).toBeInTheDocument();
      });
    });

    it('renders the core branch-checkout dropdown beside Quick actions', async () => {
      render(<GitPane {...defaultProps} />);

      // The checkout dropdown is core (always visible), even while Advanced is
      // collapsed. It enables once /git/branches has loaded.
      const toggle = await screen.findByTestId('branch-checkout-dropdown-toggle');
      await waitFor(() => expect(toggle).not.toBeDisabled());

      // Branches section (its old home) is still collapsed under Advanced.
      expect(screen.queryByTestId('git-branches-section')).not.toBeInTheDocument();

      fireEvent.click(toggle);
      await waitFor(() => {
        expect(screen.getByLabelText('Checkout main')).toBeInTheDocument();
      });
    });
  });

  // --------------------------------------------------------------------------
  // Issue #816: UX Phase 2 — action shortcuts
  //   A. Changes "Commit + Push" compound button
  //   B. Commit History inline "View diff" accordion
  //   C. Changes unstaged-diff inline preview caret
  // --------------------------------------------------------------------------
  describe('UX Phase 2 action shortcuts (Issue #816)', () => {
    const STAGED_PAYLOAD = {
      staged: [{ path: 'src/staged.ts', status: 'modified' }],
      unstaged: [{ path: 'src/unstaged.ts', status: 'modified' }],
      untracked: [{ path: 'src/new.ts', status: 'untracked' }],
    };

    const findCall = (path: string, method = 'POST') =>
      mockFetch.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes(path) &&
          (call[1] as { method?: string } | undefined)?.method === method
      );

    // ------------------------------------------------------------------ A
    describe('A. Commit + Push compound button', () => {
      it('renders a "Commit + Push" button beside the Commit button', async () => {
        setEndpoints({ staged: { ok: true, json: STAGED_PAYLOAD } });
        render(<GitPane {...defaultProps} />);

        await waitFor(() => {
          expect(screen.getByTestId('git-commit-push-button')).toBeInTheDocument();
        });
        // Existing single Commit button is preserved.
        expect(screen.getByTestId('git-commit-button')).toBeInTheDocument();
      });

      it('disables Commit + Push when the message is empty', async () => {
        setEndpoints({ staged: { ok: true, json: STAGED_PAYLOAD } });
        render(<GitPane {...defaultProps} />);

        await waitFor(() => {
          expect(screen.getByTestId('git-commit-push-button')).toBeInTheDocument();
        });
        expect(screen.getByTestId('git-commit-push-button')).toBeDisabled();
      });

      it('POSTs /git/commit then /git/push in sequence on click', async () => {
        setEndpoints({ staged: { ok: true, json: STAGED_PAYLOAD } });
        render(<GitPane {...defaultProps} />);

        await waitFor(() => {
          expect(screen.getByTestId('git-commit-message')).toBeInTheDocument();
        });

        fireEvent.change(screen.getByTestId('git-commit-message'), {
          target: { value: 'feat: ship it' },
        });
        fireEvent.click(screen.getByTestId('git-commit-push-button'));

        await waitFor(() => {
          expect(findCall('/git/commit')).toBeTruthy();
          expect(findCall('/git/push')).toBeTruthy();
        });

        // The commit must precede the push (commit succeeds before pushing).
        const urls = mockFetch.mock.calls
          .filter((c) => typeof c[0] === 'string')
          .map((c) => c[0] as string);
        const commitIdx = urls.findIndex((u) => u.includes('/git/commit'));
        const pushIdx = urls.findIndex((u) => u.includes('/git/push'));
        expect(commitIdx).toBeGreaterThanOrEqual(0);
        expect(pushIdx).toBeGreaterThan(commitIdx);
      });

      it('does NOT push when the commit fails', async () => {
        setEndpoints({
          staged: { ok: true, json: STAGED_PAYLOAD },
          commit: { ok: false, json: { error: 'No staged changes to commit' } },
        });
        render(<GitPane {...defaultProps} />);

        await waitFor(() => {
          expect(screen.getByTestId('git-commit-message')).toBeInTheDocument();
        });

        fireEvent.change(screen.getByTestId('git-commit-message'), {
          target: { value: 'feat: nope' },
        });
        fireEvent.click(screen.getByTestId('git-commit-push-button'));

        // The commit error surfaces and no push is attempted.
        await waitFor(() => {
          expect(screen.getByTestId('git-commit-error')).toHaveTextContent(
            'No staged changes to commit'
          );
        });
        expect(findCall('/git/push')).toBeFalsy();
      });
    });

    // ------------------------------------------------------------------ B
    describe('B. Commit History inline View diff', () => {
      const LOG_PAYLOAD = {
        commits: [
          { hash: 'abc1234', shortHash: 'abc1234', message: 'feat: one', author: 'a', date: '2026-01-01' },
        ],
      };
      const SHOW_PAYLOAD = {
        commit: { hash: 'abc1234', shortHash: 'abc1234', message: 'feat: one', author: 'a', date: '2026-01-01' },
        files: [{ path: 'src/inline.ts', status: 'modified' }],
      };

      it('renders a "View diff" button on each commit row', async () => {
        setEndpoints({ log: { ok: true, json: LOG_PAYLOAD } });
        render(<GitPane {...defaultProps} />);

        await waitFor(() => {
          expect(screen.getByTestId('git-commit-view-diff-button')).toBeInTheDocument();
        });
        expect(screen.getByLabelText('View diff for abc1234')).toBeInTheDocument();
      });

      it('expands an inline accordion file list (GET /git/show) on click', async () => {
        setEndpoints({
          log: { ok: true, json: LOG_PAYLOAD },
          show: { ok: true, json: SHOW_PAYLOAD },
        });
        render(<GitPane {...defaultProps} />);

        await waitFor(() => {
          expect(screen.getByTestId('git-commit-view-diff-button')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByTestId('git-commit-view-diff-button'));

        await waitFor(() => {
          expect(screen.getByTestId('git-commit-inline-files')).toBeInTheDocument();
          expect(screen.getByLabelText('Show commit diff for src/inline.ts')).toBeInTheDocument();
        });

        const showCall = mockFetch.mock.calls.find(
          (call) => typeof call[0] === 'string' && (call[0] as string).includes('/git/show/abc1234')
        );
        expect(showCall).toBeTruthy();
      });

      it('collapses the inline accordion when View diff is clicked again', async () => {
        setEndpoints({
          log: { ok: true, json: LOG_PAYLOAD },
          show: { ok: true, json: SHOW_PAYLOAD },
        });
        render(<GitPane {...defaultProps} />);

        await waitFor(() => {
          expect(screen.getByTestId('git-commit-view-diff-button')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByTestId('git-commit-view-diff-button'));
        await waitFor(() => {
          expect(screen.getByTestId('git-commit-inline-files')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByTestId('git-commit-view-diff-button'));
        await waitFor(() => {
          expect(screen.queryByTestId('git-commit-inline-files')).not.toBeInTheDocument();
        });
      });

      it('routes an inline file click through onDiffSelect (the existing diff path)', async () => {
        const onDiffSelect = vi.fn();
        setEndpoints({
          log: { ok: true, json: LOG_PAYLOAD },
          show: { ok: true, json: SHOW_PAYLOAD },
          diff: { ok: true, json: { diff: 'diff --git a/inline b/inline\n+x' } },
        });
        render(<GitPane {...defaultProps} onDiffSelect={onDiffSelect} />);

        await waitFor(() => {
          expect(screen.getByTestId('git-commit-view-diff-button')).toBeInTheDocument();
        });
        fireEvent.click(screen.getByTestId('git-commit-view-diff-button'));

        await waitFor(() => {
          expect(screen.getByLabelText('Show commit diff for src/inline.ts')).toBeInTheDocument();
        });
        fireEvent.click(screen.getByLabelText('Show commit diff for src/inline.ts'));

        await waitFor(() => {
          expect(onDiffSelect).toHaveBeenCalledWith('diff --git a/inline b/inline\n+x', 'src/inline.ts');
        });
      });

      it('keeps the existing commit-select detail path (backwards compat)', async () => {
        setEndpoints({
          log: { ok: true, json: LOG_PAYLOAD },
          show: { ok: true, json: SHOW_PAYLOAD },
        });
        render(<GitPane {...defaultProps} />);

        await waitFor(() => {
          expect(screen.getByText('feat: one')).toBeInTheDocument();
        });

        // Clicking the commit row (not the View diff button) still opens the
        // lower Changed Files detail section.
        fireEvent.click(screen.getByText('feat: one'));
        await waitFor(() => {
          expect(screen.getByText('Changed Files')).toBeInTheDocument();
        });
      });
    });

    // ------------------------------------------------------------------ C
    describe('C. Changes unstaged-diff inline preview', () => {
      // 27-line diff so the 20-line preview truncates.
      const PREVIEW_DIFF = [
        'diff --git a/src/unstaged.ts b/src/unstaged.ts',
        '@@ -1 +1 @@',
        ...Array.from({ length: 25 }, (_, i) => `+L${i + 1}`),
      ].join('\n');

      it('renders an expand caret on each changed-file row', async () => {
        setEndpoints({ staged: { ok: true, json: STAGED_PAYLOAD } });
        render(<GitPane {...defaultProps} />);

        await waitFor(() => {
          expect(
            screen.getByLabelText('Toggle diff preview for src/unstaged.ts')
          ).toBeInTheDocument();
        });
      });

      it('fetches /git/working-diff and shows the first 20 lines inline on caret click', async () => {
        setEndpoints({
          staged: { ok: true, json: STAGED_PAYLOAD },
          workingDiff: { ok: true, json: { diff: PREVIEW_DIFF } },
        });
        render(<GitPane {...defaultProps} />);

        await waitFor(() => {
          expect(
            screen.getByLabelText('Toggle diff preview for src/unstaged.ts')
          ).toBeInTheDocument();
        });

        fireEvent.click(screen.getByLabelText('Toggle diff preview for src/unstaged.ts'));

        await waitFor(() => {
          expect(screen.getByTestId('git-changes-inline-preview')).toBeInTheDocument();
        });

        // working-diff requested with mode=unstaged for this list.
        const wdCall = mockFetch.mock.calls.find(
          (call) => typeof call[0] === 'string' && (call[0] as string).includes('/git/working-diff')
        );
        expect(wdCall).toBeTruthy();
        expect(wdCall![0] as string).toContain('mode=unstaged');

        // First lines are shown; lines past the 20-line cap are not.
        expect(screen.getByText('+L1')).toBeInTheDocument();
        expect(screen.queryByText('+L19')).not.toBeInTheDocument();
        // A "open full diff" affordance is offered when truncated.
        expect(screen.getByTestId('git-changes-preview-more')).toBeInTheDocument();
      });

      it('collapses the preview when the caret is clicked again', async () => {
        setEndpoints({
          staged: { ok: true, json: STAGED_PAYLOAD },
          workingDiff: { ok: true, json: { diff: PREVIEW_DIFF } },
        });
        render(<GitPane {...defaultProps} />);

        const caretLabel = 'Toggle diff preview for src/unstaged.ts';
        await waitFor(() => expect(screen.getByLabelText(caretLabel)).toBeInTheDocument());

        fireEvent.click(screen.getByLabelText(caretLabel));
        await waitFor(() => {
          expect(screen.getByTestId('git-changes-inline-preview')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByLabelText(caretLabel));
        await waitFor(() => {
          expect(screen.queryByTestId('git-changes-inline-preview')).not.toBeInTheDocument();
        });
      });

      it('preserves the existing full-diff "Diff" button (onDiffSelect)', async () => {
        const onDiffSelect = vi.fn();
        setEndpoints({
          staged: { ok: true, json: STAGED_PAYLOAD },
          workingDiff: { ok: true, json: { diff: PREVIEW_DIFF } },
        });
        render(<GitPane {...defaultProps} onDiffSelect={onDiffSelect} />);

        await waitFor(() => {
          expect(screen.getByLabelText('Show diff for src/unstaged.ts')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByLabelText('Show diff for src/unstaged.ts'));
        await waitFor(() => {
          expect(onDiffSelect).toHaveBeenCalledWith(PREVIEW_DIFF, 'src/unstaged.ts');
        });
      });
    });
  });

  // --------------------------------------------------------------------------
  // Issue #817: "Ask AI" buttons pre-populate the composer (no auto-send)
  // --------------------------------------------------------------------------
  describe("'Ask AI' buttons (Issue #817)", () => {
    /** True if any fetch call hit `path` (optionally with the given method). */
    function postedTo(path: string, method = 'POST') {
      return mockFetch.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes(path) &&
          ((call[1] as { method?: string } | undefined)?.method ?? 'GET') === method
      );
    }

    it('drafts a create+checkout prompt into the composer and closes the modal (no POST)', async () => {
      const onInsertToMessage = vi.fn();
      render(<GitPane {...defaultProps} onInsertToMessage={onInsertToMessage} />);

      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();
      await waitFor(() => expect(screen.getByTestId('git-branch-create-open')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('git-branch-create-open'));
      await waitFor(() => expect(screen.getByTestId('branch-create-name-input')).toBeInTheDocument());

      fireEvent.change(screen.getByTestId('branch-create-name-input'), {
        target: { value: 'feature/created' },
      });
      fireEvent.click(screen.getByTestId('branch-create-ask-ai'));

      expect(onInsertToMessage).toHaveBeenCalledTimes(1);
      expect(onInsertToMessage).toHaveBeenCalledWith(branchCreatePrompt('feature/created', ''));
      // Modal closed; the create API was NOT called (delegated to the agent).
      expect(screen.queryByTestId('branch-create-name-input')).not.toBeInTheDocument();
      expect(postedTo('/git/branch/create')).toBe(false);
    });

    it('disables the create Ask AI button until a branch name is entered', async () => {
      const onInsertToMessage = vi.fn();
      render(<GitPane {...defaultProps} onInsertToMessage={onInsertToMessage} />);

      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();
      fireEvent.click(screen.getByTestId('git-branch-create-open'));
      await waitFor(() => expect(screen.getByTestId('branch-create-ask-ai')).toBeInTheDocument());

      expect(screen.getByTestId('branch-create-ask-ai')).toBeDisabled();
      fireEvent.change(screen.getByTestId('branch-create-name-input'), {
        target: { value: 'feature/y' },
      });
      expect(screen.getByTestId('branch-create-ask-ai')).not.toBeDisabled();
    });

    it('drafts a delete prompt into the composer and closes the modal (no POST)', async () => {
      const onInsertToMessage = vi.fn();
      setEndpoints({
        branches: {
          ok: true,
          json: {
            branches: [
              {
                name: 'feature/old',
                isCurrent: false,
                isRemote: false,
                isDefault: false,
                upstream: null,
                aheadBehind: null,
                checkedOutWorktreePath: null,
              },
            ],
          },
        },
      });
      render(<GitPane {...defaultProps} onInsertToMessage={onInsertToMessage} />);

      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();
      await waitFor(() => expect(screen.getByLabelText('Delete feature/old')).toBeInTheDocument());
      fireEvent.click(screen.getByLabelText('Delete feature/old'));
      await waitFor(() => expect(screen.getByTestId('branch-delete-ask-ai')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('branch-delete-ask-ai'));

      expect(onInsertToMessage).toHaveBeenCalledWith(branchDeletePrompt('feature/old', false));
      expect(screen.queryByTestId('branch-delete-ask-ai')).not.toBeInTheDocument();
      expect(postedTo('/git/branch/delete')).toBe(false);
    });

    it('drafts a stash cleanup prompt listing the current stashes', async () => {
      const onInsertToMessage = vi.fn();
      setEndpoints({
        stash: {
          ok: true,
          json: {
            stashes: [{ index: 0, message: 'WIP on main: a', branch: 'main', date: '2026-01-01', sha: 'sha0' }],
          },
        },
      });
      render(<GitPane {...defaultProps} onInsertToMessage={onInsertToMessage} />);

      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();
      await waitFor(() => expect(screen.getByTestId('stash-cleanup-ask-ai')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('stash-cleanup-ask-ai'));

      expect(onInsertToMessage).toHaveBeenCalledTimes(1);
      const inserted = onInsertToMessage.mock.calls[0][0] as string;
      expect(inserted).toContain('古い stash entry');
      expect(inserted).toContain('stash@{0}: WIP on main: a');
    });

    it('hides the stash cleanup Ask AI button when there are no stashes', async () => {
      const onInsertToMessage = vi.fn();
      render(<GitPane {...defaultProps} onInsertToMessage={onInsertToMessage} />);

      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();
      await waitFor(() => expect(screen.getByTestId('git-stash-section')).toBeInTheDocument());
      expect(screen.queryByTestId('stash-cleanup-ask-ai')).not.toBeInTheDocument();
    });

    it('offers a conflict-resolution Ask AI prompt after a stash pop conflict', async () => {
      const onInsertToMessage = vi.fn();
      setEndpoints({
        stash: {
          ok: true,
          json: {
            stashes: [{ index: 0, message: 'WIP on main: a', branch: 'main', date: '2026-01-01', sha: 'sha0' }],
          },
        },
        stashPop: {
          ok: true,
          json: { success: true, conflict: true, conflictFiles: ['a.ts'], stashRetained: true },
        },
      });
      render(<GitPane {...defaultProps} onInsertToMessage={onInsertToMessage} />);

      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      openAdvanced();
      await waitFor(() => expect(screen.getByTestId('stash-pop-button')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('stash-pop-button'));
      await waitFor(() => expect(screen.getByTestId('stash-conflict-ask-ai')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('stash-conflict-ask-ai'));

      const inserted = onInsertToMessage.mock.calls[0][0] as string;
      expect(inserted).toContain('conflict を解決してから commit してください。');
      expect(inserted).toContain('a.ts');
    });

    it('drafts a reset prompt and closes the Reset modal (no POST)', async () => {
      const onInsertToMessage = vi.fn();
      render(<GitPane {...defaultProps} onInsertToMessage={onInsertToMessage} />);

      await openDangerZone();
      fireEvent.click(screen.getByTestId('git-danger-zone-reset-open'));
      await waitFor(() => expect(screen.getByTestId('reset-ask-ai')).toBeInTheDocument());

      // Default target HEAD + mixed mode.
      fireEvent.click(screen.getByTestId('reset-ask-ai'));

      expect(onInsertToMessage).toHaveBeenCalledWith(resetPrompt('mixed', 'HEAD'));
      expect(screen.queryByTestId('reset-confirm')).not.toBeInTheDocument();
      expect(postedTo('/git/reset')).toBe(false);
    });

    it('includes a git reflog recovery note for a hard reset Ask AI prompt', async () => {
      const onInsertToMessage = vi.fn();
      render(<GitPane {...defaultProps} onInsertToMessage={onInsertToMessage} />);

      await openDangerZone();
      fireEvent.click(screen.getByTestId('git-danger-zone-reset-open'));
      await waitFor(() => expect(screen.getByTestId('reset-mode-hard')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('reset-mode-hard'));
      // Ask AI is not gated by the hard-confirm branch input (only the real Reset is).
      fireEvent.click(screen.getByTestId('reset-ask-ai'));

      const inserted = onInsertToMessage.mock.calls[0][0] as string;
      expect(inserted).toContain('git reflog から復旧');
      expect(postedTo('/git/reset')).toBe(false);
    });

    it('drafts a revert prompt for the selected commit', async () => {
      const onInsertToMessage = vi.fn();
      setEndpoints({
        log: {
          ok: true,
          json: {
            commits: [
              { hash: 'abc1234def', shortHash: 'abc1234', message: 'pick me', author: 'a', date: '2026-01-01' },
            ],
          },
        },
      });
      render(<GitPane {...defaultProps} onInsertToMessage={onInsertToMessage} />);

      await waitFor(() => expect(screen.getByText('pick me')).toBeInTheDocument());
      fireEvent.click(screen.getByText('pick me')); // select the commit

      await openDangerZone();
      await waitFor(() => expect(screen.getByTestId('git-danger-zone-revert-open')).not.toBeDisabled());
      fireEvent.click(screen.getByTestId('git-danger-zone-revert-open'));
      await waitFor(() => expect(screen.getByTestId('revert-ask-ai')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('revert-ask-ai'));

      expect(onInsertToMessage).toHaveBeenCalledWith(revertPrompt('abc1234def'));
      expect(postedTo('/git/revert')).toBe(false);
    });

    it('drafts a force-push prompt and closes the modal (no POST)', async () => {
      const onInsertToMessage = vi.fn();
      render(<GitPane {...defaultProps} onInsertToMessage={onInsertToMessage} />);

      await openDangerZone();
      fireEvent.click(screen.getByTestId('git-force-push-open'));
      await waitFor(() => expect(screen.getByTestId('force-push-ask-ai')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('force-push-ask-ai'));

      const inserted = onInsertToMessage.mock.calls[0][0] as string;
      expect(inserted).toContain('force-with-lease');
      // DEFAULT_STATUS.currentBranch is 'feature/test'.
      expect(inserted).toContain('feature/test');
      expect(screen.queryByTestId('force-push-confirm')).not.toBeInTheDocument();
      expect(postedTo('/git/push')).toBe(false);
    });

    it('hides every Ask AI button when no onInsertToMessage handler is wired', async () => {
      render(<GitPane {...defaultProps} />);

      await openDangerZone();
      fireEvent.click(screen.getByTestId('git-danger-zone-reset-open'));
      await waitFor(() => expect(screen.getByTestId('reset-confirm')).toBeInTheDocument());
      expect(screen.queryByTestId('reset-ask-ai')).not.toBeInTheDocument();

      // Branch create modal also has no Ask AI affordance.
      fireEvent.click(screen.getByTestId('git-branch-create-open'));
      await waitFor(() => expect(screen.getByTestId('branch-create-name-input')).toBeInTheDocument());
      expect(screen.queryByTestId('branch-create-ask-ai')).not.toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // Issue #818: mobile tab UI + desktop visual grouping + persistence
  // --------------------------------------------------------------------------
  describe('Mobile tab UI (Issue #818 A)', () => {
    const COMMITS = {
      ok: true,
      json: {
        commits: [
          { hash: 'abc1234', shortHash: 'abc1234', message: 'feat: add feature', author: 'A', date: '2026-03-08T00:00:00Z' },
        ],
      },
    };

    it('renders the 4-tab strip on mobile and defaults to the Status tab', async () => {
      render(<GitPane {...defaultProps} isMobile />);

      await waitFor(() => expect(screen.getByTestId('git-pane-mobile-tabs')).toBeInTheDocument());
      expect(screen.getByTestId('git-tab-status')).toBeInTheDocument();
      expect(screen.getByTestId('git-tab-changes')).toBeInTheDocument();
      expect(screen.getByTestId('git-tab-history')).toBeInTheDocument();
      expect(screen.getByTestId('git-tab-advanced')).toBeInTheDocument();

      // Status tab pairs Current Status with Quick actions.
      expect(screen.getByTestId('git-status-section')).toBeInTheDocument();
      expect(screen.getByTestId('git-network-section')).toBeInTheDocument();
      expect(screen.getByTestId('git-pane-mobile-panel')).toHaveAttribute('data-active-tab', 'status');
    });

    it('mounts only the active tab group (non-active groups unmount)', async () => {
      render(<GitPane {...defaultProps} isMobile />);

      await waitFor(() => expect(screen.getByTestId('git-status-section')).toBeInTheDocument());
      // Changes / Advanced groups are NOT in the DOM while Status is active.
      expect(screen.queryByTestId('git-changes-section')).not.toBeInTheDocument();
      expect(screen.queryByTestId('git-advanced-section')).not.toBeInTheDocument();
    });

    it('switches to the Changes tab and unmounts the Status group', async () => {
      render(<GitPane {...defaultProps} isMobile />);
      await waitFor(() => expect(screen.getByTestId('git-status-section')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('git-tab-changes'));

      await waitFor(() => expect(screen.getByTestId('git-changes-section')).toBeInTheDocument());
      expect(screen.queryByTestId('git-status-section')).not.toBeInTheDocument();
      expect(screen.queryByTestId('git-network-section')).not.toBeInTheDocument();
    });

    it('shows the commit history on the History tab', async () => {
      setEndpoints({ log: COMMITS });
      render(<GitPane {...defaultProps} isMobile />);
      await waitFor(() => expect(screen.getByTestId('git-tab-history')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('git-tab-history'));

      await waitFor(() => expect(screen.getByText('feat: add feature')).toBeInTheDocument());
      expect(screen.queryByTestId('git-status-section')).not.toBeInTheDocument();
    });

    it('shows the Advanced operations on the Advanced tab', async () => {
      render(<GitPane {...defaultProps} isMobile />);
      await waitFor(() => expect(screen.getByTestId('git-tab-advanced')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('git-tab-advanced'));

      await waitFor(() => expect(screen.getByTestId('git-advanced-section')).toBeInTheDocument());
      // Advanced group is already expanded as its own panel content.
      expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument();
    });

    it('persists the last active tab and restores it on remount', async () => {
      const { unmount } = render(<GitPane {...defaultProps} isMobile />);
      await waitFor(() => expect(screen.getByTestId('git-tab-changes')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('git-tab-changes'));
      await waitFor(() =>
        expect(screen.getByTestId('git-pane-mobile-panel')).toHaveAttribute('data-active-tab', 'changes')
      );
      unmount();

      render(<GitPane {...defaultProps} isMobile />);
      await waitFor(() =>
        expect(screen.getByTestId('git-pane-mobile-panel')).toHaveAttribute('data-active-tab', 'changes')
      );
    });

    it('does not render the mobile tab strip on desktop', async () => {
      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-pane-desktop')).toBeInTheDocument());
      expect(screen.queryByTestId('git-pane-mobile-tabs')).not.toBeInTheDocument();
    });
  });

  describe('Desktop visual grouping (Issue #818 B)', () => {
    it('separates the pane into read / write / advanced groups', async () => {
      render(<GitPane {...defaultProps} />);

      await waitFor(() => expect(screen.getByTestId('git-group-read')).toBeInTheDocument());
      expect(screen.getByTestId('git-group-write')).toBeInTheDocument();
      expect(screen.getByTestId('git-group-history')).toHaveAttribute('data-git-group', 'read');
      expect(screen.getByTestId('git-group-advanced')).toBeInTheDocument();

      // The three categories are present (read appears for both status + history).
      const groups = screen.getAllByTestId(/^git-group-/);
      const categories = new Set(groups.map((el) => el.getAttribute('data-git-group')));
      expect(categories).toEqual(new Set(['read', 'write', 'advanced']));
    });

    it('gives the Advanced group a visual divider border', async () => {
      render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-group-advanced')).toBeInTheDocument());
      expect(screen.getByTestId('git-group-advanced').className).toMatch(/border/);
    });

    it('keeps every core section visible on desktop (no tab gating)', async () => {
      render(<GitPane {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByTestId('git-status-section')).toBeInTheDocument();
        expect(screen.getByTestId('git-network-section')).toBeInTheDocument();
        expect(screen.getByTestId('git-changes-section')).toBeInTheDocument();
      });
    });
  });

  describe('Collapse persistence (Issue #818 C)', () => {
    const COMMITS = {
      ok: true,
      json: {
        commits: [
          { hash: 'abc1234', shortHash: 'abc1234', message: 'feat: add feature', author: 'A', date: '2026-03-08T00:00:00Z' },
        ],
      },
    };

    it('persists the collapsed Commit History state across remounts', async () => {
      setEndpoints({ log: COMMITS });
      const { unmount } = render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByText('feat: add feature')).toBeInTheDocument());

      // Collapse via the Commit History toggle header.
      fireEvent.click(screen.getByText('Commit History'));
      await waitFor(() => expect(screen.queryByText('feat: add feature')).not.toBeInTheDocument());
      // Collapsed state is persisted under the consolidated key.
      expect(window.localStorage.getItem('commandmate:gitPane:historyOpen')).toBe('false');
      unmount();

      setEndpoints({ log: COMMITS });
      render(<GitPane {...defaultProps} />);
      // Restored collapsed: the toggle arrow flips to the collapsed indicator.
      await waitFor(() =>
        expect(screen.getByText('Commit History').textContent).toContain('▶')
      );
      expect(screen.queryByText('feat: add feature')).not.toBeInTheDocument();
    });

    it('persists the Advanced open state across remounts (Phase 1 key reused)', async () => {
      const { unmount } = render(<GitPane {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('git-advanced-toggle')).toBeInTheDocument());
      // Default collapsed → Fetch button hidden.
      expect(screen.queryByTestId('git-fetch-button')).not.toBeInTheDocument();

      openAdvanced();
      await waitFor(() => expect(screen.getByTestId('git-fetch-button')).toBeInTheDocument());
      unmount();

      render(<GitPane {...defaultProps} />);
      // Restored expanded from localStorage.
      await waitFor(() => expect(screen.getByTestId('git-fetch-button')).toBeInTheDocument());
    });
  });
});
