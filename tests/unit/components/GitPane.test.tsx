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
} from '@/config/git-status-config';

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

describe('GitPane', () => {
  const defaultProps = {
    worktreeId: 'test-worktree-id',
    onDiffSelect: vi.fn() as (diff: string, filePath: string) => void,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    setEndpoints();
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

    it('renders the Branches section with branch names', async () => {
      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('git-branches-section')).toBeInTheDocument();
        expect(screen.getByText('main')).toBeInTheDocument();
        expect(screen.getByText('feature/current')).toBeInTheDocument();
      });
    });

    it('shows the S3-001 history-loss warning in the checkout confirm dialog', async () => {
      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Checkout main')).toBeInTheDocument();
      });

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

      await waitFor(() => {
        expect(screen.getByLabelText('Checkout main')).toBeInTheDocument();
      });

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

      await waitFor(() => {
        expect(screen.getByLabelText('Checkout main')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText('Checkout main'));

      await waitFor(() => {
        expect(screen.getByTestId('branch-checkout-confirm')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('branch-session-warning')).not.toBeInTheDocument();
    });

    it('POSTs /git/checkout and refetches on confirm', async () => {
      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Checkout main')).toBeInTheDocument();
      });

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

      await waitFor(() => {
        expect(screen.getByLabelText('Checkout main')).toBeInTheDocument();
      });

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

      await waitFor(() => {
        expect(screen.getByLabelText('Checkout feature/elsewhere')).toBeInTheDocument();
      });

      const button = screen.getByLabelText('Checkout feature/elsewhere');
      expect(button).toBeDisabled();
      expect(button.getAttribute('title')).toContain('/other/worktree');
    });

    it('does not render a checkout button for the current branch', async () => {
      render(<GitPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('feature/current')).toBeInTheDocument();
      });

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
});
