/**
 * GitPane Component
 * Issue #447: Git tab - commit history & diff display
 *
 * Displays commit history, changed files per commit, and file diffs.
 * Uses execFile-based API endpoints for security.
 *
 * PC: Clicking a file triggers onDiffSelect to show diff in the right pane.
 * Mobile: Diff is displayed inline within this component.
 */

'use client';

import React, { useEffect, useState, useCallback, memo } from 'react';
import type {
  CommitInfo,
  ChangedFile,
  GitStagedResponse,
  BranchInfo,
  BranchInclude,
  StashInfo,
  GitResetMode,
} from '@/types/git';
import type { GitStatus, Worktree } from '@/types/models';
import { useFilePolling } from '@/hooks/useFilePolling';
import { useGitPaneNetworkOps } from '@/hooks/useGitPaneNetworkOps';
import { useLocalStorageState } from '@/hooks/useLocalStorageState';
import type { GitNetworkOperation } from '@/types/git';
import { BranchCheckoutDropdown } from '@/components/worktree/git/BranchCheckoutDropdown';
import { AdvancedSection } from '@/components/worktree/git/AdvancedSection';
import {
  GIT_STATUS_POLL_INTERVAL_MS,
  RESET_HARD_HISTORY_LOSS_WARNING,
  DANGER_ZONE_RUNNING_SESSION_WARNING,
  PUSH_PROTECTED_BRANCH_WARNING,
} from '@/config/git-status-config';

// ============================================================================
// Types
// ============================================================================

interface GitPaneProps {
  worktreeId: string;
  /** Called when a diff is selected (PC: displays in right pane) */
  onDiffSelect: (diff: string, filePath: string) => void;
  /** When true, shows diff inline instead of calling onDiffSelect */
  isMobile?: boolean;
  /**
   * The worktree this pane belongs to (Issue #781). Optional; only its
   * sessionStatusByCli is read, to surface the S3-002 running-session warning in
   * the checkout confirm dialog. When omitted, no session warning is shown.
   */
  worktree?: Pick<Worktree, 'sessionStatusByCli'>;
  className?: string;
}

// The S3-001 history-loss / S3-002 running-session warning strings live in
// @/config/git-status-config (single source of truth, also imported by the test).

// ============================================================================
// Status -> color mapping (Issue #780)
// Exhaustive Record over ChangedFile['status']; untracked/unmerged get distinct
// colors so they never silently fall back to the modified yellow.
// ============================================================================

const STATUS_TEXT_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-green-600 dark:text-green-400',
  modified: 'text-yellow-600 dark:text-yellow-400',
  deleted: 'text-red-600 dark:text-red-400',
  renamed: 'text-blue-600 dark:text-blue-400',
  untracked: 'text-teal-600 dark:text-teal-400',
  unmerged: 'text-orange-600 dark:text-orange-400',
};

// ============================================================================
// Sub-components
// ============================================================================

const RefreshIcon = memo(function RefreshIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
});

/**
 * Render a single diff line with appropriate color
 */
const DiffLine = memo(function DiffLine({ line }: { line: string }) {
  let className = 'whitespace-pre font-mono text-xs';

  if (line.startsWith('+') && !line.startsWith('+++')) {
    className += ' text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20';
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    className += ' text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20';
  } else if (line.startsWith('@@')) {
    className += ' text-blue-600 dark:text-blue-400';
  } else {
    className += ' text-gray-700 dark:text-gray-300';
  }

  return <div className={className}>{line}</div>;
});

/**
 * Inline error display for sub-section errors
 */
const InlineError = memo(function InlineError({ message }: { message: string }) {
  return (
    <div className="px-3 py-2 text-xs text-red-600 dark:text-red-400" role="alert">
      {message}
    </div>
  );
});

// ============================================================================
// Current Status section (Issue #779)
// ============================================================================

interface CurrentStatusSectionProps {
  gitStatus: GitStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  isMobile: boolean;
  onRefresh: () => void;
}

/**
 * Current Status section displayed at the top of GitPane (Issue #779).
 *
 * Shows the current branch chip, an "uncommitted" dirty badge, ahead/behind
 * counts (only when aheadBehind is non-null), a branch-mismatch warning, and a
 * dedicated refresh button. Failures are surfaced inline and never affect the
 * commit history / diff sections below.
 */
const CurrentStatusSection = memo(function CurrentStatusSection({
  gitStatus,
  statusLoading,
  statusError,
  isMobile,
  onRefresh,
}: CurrentStatusSectionProps) {
  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2 border-b border-gray-200 dark:border-gray-700"
      data-testid="git-status-section"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          Current Status
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded"
          aria-label="Refresh git status"
        >
          <RefreshIcon />
        </button>
      </div>

      {/* Loading: only show the spinner before the first successful load */}
      {statusLoading && !gitStatus && (
        <div className="flex items-center gap-2 py-1" role="status">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-500" />
          <span className="sr-only">Loading git status...</span>
        </div>
      )}

      {/* Error (does not affect commit history / diff) */}
      {statusError && !gitStatus && (
        <div
          className="text-xs text-red-600 dark:text-red-400"
          role="alert"
          data-testid="git-status-error"
        >
          {statusError}
        </div>
      )}

      {gitStatus && (
        <>
          <div className={`flex items-center flex-wrap ${isMobile ? 'gap-1.5' : 'gap-2'}`}>
            {/* Branch chip */}
            <span
              className="inline-flex items-center max-w-full truncate rounded px-2 py-0.5 text-xs font-mono bg-cyan-50 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300"
              data-testid="git-status-branch-chip"
              title={gitStatus.currentBranch}
            >
              {gitStatus.currentBranch}
            </span>

            {/* Dirty badge */}
            {gitStatus.isDirty && (
              <span
                className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-yellow-50 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300"
                data-testid="git-status-dirty-badge"
              >
                uncommitted
              </span>
            )}

            {/* Ahead/behind (only when non-null) */}
            {gitStatus.aheadBehind && (
              <span
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-mono bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                data-testid="git-status-ahead-behind"
              >
                <span title="commits ahead of upstream">↑{gitStatus.aheadBehind.ahead}</span>
                <span title="commits behind upstream">↓{gitStatus.aheadBehind.behind}</span>
              </span>
            )}
          </div>

          {/* Branch mismatch warning */}
          {gitStatus.isBranchMismatch && (
            <div
              className="flex items-center gap-1.5 rounded px-2 py-1 text-xs bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800/40"
              role="alert"
              data-testid="git-status-mismatch-warning"
            >
              <span aria-hidden="true">⚠</span>
              <span>
                Branch changed from{' '}
                <span className="font-medium">{gitStatus.initialBranch}</span>
                {' '}to{' '}
                <span className="font-medium">{gitStatus.currentBranch}</span>
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
});

// ============================================================================
// Network operations section (Issue #783): explicit Pull / Push / Fetch
// ============================================================================

interface NetworkOperationsSectionProps {
  /** 3-value progress state from useGitPaneNetworkOps. */
  progressState: 'idle' | 'running' | 'error';
  /** The in-flight operation tag (for the spinner label), or null. */
  operation: GitNetworkOperation | null;
  /** Friendly error message (mapped by reason), or null. */
  error: string | null;
  /** Pull conflict flag (HTTP 200 quasi-error, DR1-010). */
  conflict: boolean;
  /** Files in conflict after a pull. */
  conflictFiles: string[];
  /** True when the current status has no upstream (chip absent). */
  hasUpstream: boolean;
  isMobile: boolean;
  /**
   * Issue #815: Fetch was demoted to "Advanced operations". When omitted, the
   * Fetch button is not rendered here (Pull/Push stay as the core Quick actions).
   */
  onFetch?: () => void;
  onPull: () => void;
  onPush: () => void;
  onAbort: () => void;
  /**
   * Issue #815: optional slot rendered alongside Pull/Push in the button row
   * (e.g. the core BranchCheckoutDropdown), keeping checkout beside Quick actions.
   */
  extraActions?: React.ReactNode;
}

/**
 * NetworkOperationsSection (Issue #783, §7.2). Renders the MVP's only required
 * entry point: explicit Pull / Push / Fetch buttons. The Push button works even
 * when upstream is unset (the GitPane body passes setUpstream when there is no
 * upstream). DR1-005: the ahead/behind chip stays visual-only (no click
 * dropdown — deferred).
 *
 * Progress UI (§7.4): while running, a spinner (role=status) + an abort button
 * are shown. DR3-005: the OPTIONAL elapsed-seconds tick lives in THIS section's
 * own useState — never in the GitPane body — so a 60s push re-renders only this
 * section once per second, not the 5 memo sections.
 *
 * DR3-007: on mobile the progress bar is rendered sticky (z-40, BELOW the z-50
 * confirm modals) inside the GitPane scroll container so the modals still stack
 * above it.
 */
const NetworkOperationsSection = memo(function NetworkOperationsSection({
  progressState,
  operation,
  error,
  conflict,
  conflictFiles,
  hasUpstream,
  isMobile,
  onFetch,
  onPull,
  onPush,
  onAbort,
  extraActions,
}: NetworkOperationsSectionProps) {
  const running = progressState === 'running';

  // DR3-005: elapsed-seconds tick isolated to this section. A plain spinner is
  // sufficient, but the elapsed seconds reassure the user during a long op. The
  // tick state lives here so it does not re-render the GitPane body or the 5
  // memo sections every second.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2 border-b border-gray-200 dark:border-gray-700"
      data-testid="git-network-section"
    >
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
        Quick actions
      </span>

      <div className={`flex items-center ${isMobile ? 'flex-wrap gap-1.5' : 'gap-2'}`}>
        {/* Fetch is rendered here only when onFetch is provided; Issue #815 moved
            the core Fetch button into the collapsed Advanced operations group. */}
        {onFetch && (
          <button
            type="button"
            onClick={onFetch}
            disabled={running}
            className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            data-testid="git-fetch-button"
          >
            Fetch
          </button>
        )}
        <button
          type="button"
          onClick={onPull}
          disabled={running}
          className="px-2 py-1 text-xs rounded border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50"
          data-testid="git-pull-button"
        >
          Pull
        </button>
        <button
          type="button"
          onClick={onPush}
          disabled={running}
          className="px-2 py-1 text-xs rounded border border-green-300 dark:border-green-700 text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30 disabled:opacity-50"
          data-testid="git-push-button"
          title={hasUpstream ? undefined : 'No upstream — will set upstream on push'}
        >
          Push
        </button>
        {/* Issue #815: core BranchCheckoutDropdown slotted beside Quick actions. */}
        {extraActions}
      </div>

      {/* Progress / abort bar (sticky on mobile, z-40 < confirm modals z-50) */}
      {running && (
        <div
          className={`flex items-center gap-2 rounded px-2 py-1 text-xs bg-cyan-50 text-cyan-800 dark:bg-cyan-900/20 dark:text-cyan-300 ${
            isMobile ? 'sticky top-0 z-40' : ''
          }`}
          data-testid="git-network-progress-bar"
        >
          <span className="flex items-center gap-2" role="status" data-testid="git-network-operation-spinner">
            <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-500" aria-hidden="true" />
            <span>
              {operation === 'push' ? 'Pushing' : operation === 'pull' ? 'Pulling' : 'Fetching'}… {elapsed}s
            </span>
          </span>
          <button
            type="button"
            onClick={onAbort}
            className="ml-auto px-1.5 py-0.5 rounded border border-cyan-400 dark:border-cyan-600 hover:bg-cyan-100 dark:hover:bg-cyan-900/40"
            data-testid="git-network-abort-button"
          >
            Abort
          </button>
        </div>
      )}

      {/* Error (role=alert) — pull conflict is surfaced as a quasi-error here */}
      {progressState === 'error' && error && (
        <div
          className="text-xs text-red-600 dark:text-red-400"
          role="alert"
          data-testid="git-network-operation-error"
        >
          {error}
        </div>
      )}

      {/* Pull conflict (HTTP 200 quasi-error, DR1-010): list files + terminal guidance */}
      {conflict && (
        <div
          className="text-xs text-orange-600 dark:text-orange-400"
          role="status"
          data-testid="git-network-conflict"
        >
          Pull produced conflicts: {conflictFiles.join(', ')}. Resolve them in the terminal.
        </div>
      )}
    </div>
  );
});

// ============================================================================
// Changes section (Issue #780): staged / unstaged / untracked + commit form
// ============================================================================

/**
 * Working-tree diff mode for the Changes section (Issue #780). Identifies which
 * git working-tree diff the per-file Diff button should request.
 */
type ChangesDiffMode = 'staged' | 'unstaged' | 'untracked';

interface ChangedFileListProps {
  title: string;
  testId: string;
  files: ChangedFile[];
  /** Action label for the per-file toggle button (e.g. 'Stage' / 'Unstage') */
  actionLabel: string;
  /** Which working-tree diff this list's Diff button should request */
  mode: ChangesDiffMode;
  defaultOpen: boolean;
  busy: boolean;
  onDiff: (filePath: string, mode: ChangesDiffMode) => void;
  onToggleStage: (filePath: string) => void;
}

/**
 * A single collapsible list of changed files (Staged / Unstaged / Untracked).
 * Each row shows the status badge, the path, a diff button, and a
 * stage/unstage toggle button.
 */
const ChangedFileList = memo(function ChangedFileList({
  title,
  testId,
  files,
  actionLabel,
  mode,
  defaultOpen,
  busy,
  onDiff,
  onToggleStage,
}: ChangedFileListProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-t border-gray-100 dark:border-gray-800" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
      >
        <span className="w-4 text-center">{open ? '▼' : '▶'}</span>
        {title} ({files.length})
      </button>
      {open && files.length === 0 && (
        <div className="px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500">None</div>
      )}
      {open && files.length > 0 && (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {files.map((file) => (
            <li key={`${file.status}:${file.path}`} className="flex items-center gap-2 px-3 py-1.5">
              <span className={`inline-block w-16 shrink-0 text-xs font-medium ${STATUS_TEXT_COLOR[file.status]}`}>
                {file.status}
              </span>
              <span className="flex-1 truncate font-mono text-xs text-gray-700 dark:text-gray-300" title={file.path}>
                {file.path}
              </span>
              <button
                type="button"
                onClick={() => onDiff(file.path, mode)}
                className="shrink-0 px-1.5 py-0.5 text-xs text-cyan-600 dark:text-cyan-400 hover:underline"
                aria-label={`Show diff for ${file.path}`}
                data-testid="git-changes-diff-button"
              >
                Diff
              </button>
              <button
                type="button"
                onClick={() => onToggleStage(file.path)}
                disabled={busy}
                className="shrink-0 px-1.5 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                aria-label={`${actionLabel} ${file.path}`}
                data-testid="git-changes-toggle-button"
              >
                {actionLabel}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

interface ChangesSectionProps {
  staged: GitStagedResponse | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  commitMessage: string;
  amend: boolean;
  committing: boolean;
  commitError: string | null;
  isMobile: boolean;
  onRefresh: () => void;
  onDiff: (filePath: string, mode: ChangesDiffMode) => void;
  onStage: (filePath: string) => void;
  onUnstage: (filePath: string) => void;
  onCommitMessageChange: (value: string) => void;
  onAmendChange: (value: boolean) => void;
  onCommit: () => void;
}

/**
 * Changes section (Issue #780). Rendered directly below the #779 Current Status
 * section and above Commit History. Shows three collapsible lists
 * (Staged / Unstaged / Untracked) plus a commit message textarea, an amend
 * checkbox, and a commit button. On mobile the sub-lists default-collapse.
 */
const ChangesSection = memo(function ChangesSection({
  staged,
  loading,
  error,
  busy,
  commitMessage,
  amend,
  committing,
  commitError,
  isMobile,
  onRefresh,
  onDiff,
  onStage,
  onUnstage,
  onCommitMessageChange,
  onAmendChange,
  onCommit,
}: ChangesSectionProps) {
  const stagedFiles = staged?.staged ?? [];
  const unstagedFiles = staged?.unstaged ?? [];
  const untrackedFiles = staged?.untracked ?? [];

  // Commit is allowed when there are staged changes, OR when amending (which can
  // rewrite the previous commit without new staged content).
  const canCommit = !committing && commitMessage.trim().length > 0 && (stagedFiles.length > 0 || amend);
  // Sub-lists default open on PC, collapsed on mobile.
  const defaultOpen = !isMobile;

  return (
    <div
      className="flex flex-col border-b border-gray-200 dark:border-gray-700"
      data-testid="git-changes-section"
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Changes</span>
        <button
          type="button"
          onClick={onRefresh}
          className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded"
          aria-label="Refresh changes"
        >
          <RefreshIcon />
        </button>
      </div>

      {loading && !staged && (
        <div className="flex items-center gap-2 px-3 pb-2" role="status">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-500" />
          <span className="sr-only">Loading changes...</span>
        </div>
      )}

      {error && !staged && (
        <div
          className="px-3 pb-2 text-xs text-red-600 dark:text-red-400"
          role="alert"
          data-testid="git-changes-error"
        >
          {error}
        </div>
      )}

      {staged && (
        <>
          <ChangedFileList
            title="Staged"
            testId="git-staged-list"
            files={stagedFiles}
            actionLabel="Unstage"
            mode="staged"
            defaultOpen={defaultOpen}
            busy={busy}
            onDiff={onDiff}
            onToggleStage={onUnstage}
          />
          <ChangedFileList
            title="Unstaged"
            testId="git-unstaged-list"
            files={unstagedFiles}
            actionLabel="Stage"
            mode="unstaged"
            defaultOpen={defaultOpen}
            busy={busy}
            onDiff={onDiff}
            onToggleStage={onStage}
          />
          <ChangedFileList
            title="Untracked"
            testId="git-untracked-list"
            files={untrackedFiles}
            actionLabel="Stage"
            mode="untracked"
            defaultOpen={defaultOpen}
            busy={busy}
            onDiff={onDiff}
            onToggleStage={onStage}
          />

          {/* Commit form */}
          <div className="flex flex-col gap-2 px-3 py-2 border-t border-gray-100 dark:border-gray-800">
            <textarea
              value={commitMessage}
              onChange={(e) => onCommitMessageChange(e.target.value)}
              placeholder="Commit message"
              rows={isMobile ? 2 : 3}
              className="w-full resize-y rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              data-testid="git-commit-message"
              aria-label="Commit message"
            />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={amend}
                  onChange={(e) => onAmendChange(e.target.checked)}
                  data-testid="git-amend-checkbox"
                />
                Amend
              </label>
              <button
                type="button"
                onClick={onCommit}
                disabled={!canCommit}
                className="px-3 py-1 text-xs font-medium rounded bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="git-commit-button"
              >
                {committing ? 'Committing...' : 'Commit'}
              </button>
            </div>
            {commitError && (
              <div
                className="text-xs text-red-600 dark:text-red-400"
                role="alert"
                data-testid="git-commit-error"
              >
                {commitError}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
});

// ============================================================================
// Branches section (Issue #781): list / create / delete
// Issue #815: checkout was extracted to the core BranchCheckoutDropdown; this
// section (now under "Advanced operations") keeps create/delete only.
// ============================================================================

interface BranchesSectionProps {
  branches: BranchInfo[];
  include: BranchInclude;
  loading: boolean;
  error: string | null;
  busy: boolean;
  /** Inline error from a checkout/create/delete mutation (shared state). */
  actionError: string | null;
  isMobile: boolean;
  onIncludeChange: (include: BranchInclude) => void;
  onRefresh: () => void;
  onCreate: (name: string, from: string | undefined) => void;
  onDelete: (name: string, force: boolean) => void;
}

/**
 * Branches section (Issue #781). Provides local/remote tabs, a create modal, and
 * a per-branch delete confirm modal. Issue #815 demoted this under the collapsed
 * "Advanced operations" group and moved checkout to the core
 * BranchCheckoutDropdown, so this section no longer renders checkout. On mobile
 * the whole section default-collapses.
 */
const BranchesSection = memo(function BranchesSection({
  branches,
  include,
  loading,
  error,
  busy,
  actionError,
  isMobile,
  onIncludeChange,
  onRefresh,
  onCreate,
  onDelete,
}: BranchesSectionProps) {
  // Mobile default-collapses the entire section (#780 same approach).
  const [open, setOpen] = useState(!isMobile);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createFrom, setCreateFrom] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<BranchInfo | null>(null);
  const [deleteForce, setDeleteForce] = useState(false);

  const confirmCreate = useCallback(() => {
    if (createName.trim().length === 0) return;
    onCreate(createName.trim(), createFrom.trim() || undefined);
    setShowCreate(false);
    setCreateName('');
    setCreateFrom('');
  }, [createName, createFrom, onCreate]);

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    onDelete(deleteTarget.name, deleteForce);
    setDeleteTarget(null);
    setDeleteForce(false);
  }, [deleteTarget, deleteForce, onDelete]);

  return (
    <div
      className="flex flex-col border-b border-gray-200 dark:border-gray-700"
      data-testid="git-branches-section"
    >
      <div className="flex items-center justify-between px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
        >
          <span className="text-xs w-4 text-center">{open ? '▼' : '▶'}</span>
          Branches
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="px-2 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            data-testid="git-branch-create-open"
          >
            + New
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded"
            aria-label="Refresh branches"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      {open && (
        <>
          {/* Local / remote tabs */}
          <div className="flex items-center gap-1 px-3 pb-2">
            {(['local', 'remote', 'all'] as BranchInclude[]).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => onIncludeChange(tab)}
                className={`px-2 py-0.5 text-xs rounded ${
                  include === tab
                    ? 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-200'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
                data-testid={`git-branches-tab-${tab}`}
              >
                {tab}
              </button>
            ))}
          </div>

          {loading && branches.length === 0 && (
            <div className="flex items-center gap-2 px-3 pb-2" role="status">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-500" />
              <span className="sr-only">Loading branches...</span>
            </div>
          )}

          {error && (
            <div
              className="px-3 pb-2 text-xs text-red-600 dark:text-red-400"
              role="alert"
              data-testid="git-branches-error"
            >
              {error}
            </div>
          )}

          {actionError && (
            <div
              className="px-3 pb-2 text-xs text-red-600 dark:text-red-400"
              role="alert"
              data-testid="git-branches-action-error"
            >
              {actionError}
            </div>
          )}

          {!loading && !error && branches.length === 0 && (
            <div className="px-3 pb-2 text-xs text-gray-400 dark:text-gray-500">No branches</div>
          )}

          {branches.length > 0 && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800 max-h-64 overflow-y-auto">
              {branches.map((branch) => {
                const deleteDisabled = busy || branch.isCurrent || branch.isDefault;
                return (
                  <li
                    key={`${branch.isRemote ? 'r' : 'l'}:${branch.name}`}
                    className="flex items-center gap-2 px-3 py-1.5"
                    data-testid="git-branch-row"
                  >
                    <span
                      className="flex-1 truncate font-mono text-xs text-gray-700 dark:text-gray-300"
                      title={branch.name}
                    >
                      {branch.isCurrent && <span className="text-cyan-600 dark:text-cyan-400 mr-1">●</span>}
                      {branch.name}
                      {branch.isDefault && (
                        <span className="ml-1.5 text-[10px] text-gray-400 dark:text-gray-500">default</span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteForce(false);
                        setDeleteTarget(branch);
                      }}
                      disabled={deleteDisabled}
                      className="shrink-0 px-1.5 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 text-red-600 dark:text-red-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label={`Delete ${branch.name}`}
                    >
                      Delete
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {/* Create-branch modal */}
      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          data-testid="branch-create-modal"
        >
          <div className="w-full max-w-md rounded-lg bg-white dark:bg-gray-800 p-4 shadow-xl flex flex-col gap-3">
            <h3 className="text-sm font-medium text-gray-800 dark:text-gray-200">Create branch</h3>
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="branch name (e.g. feature/123-foo)"
              className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              data-testid="branch-create-name-input"
              aria-label="New branch name"
            />
            <select
              value={createFrom}
              onChange={(e) => setCreateFrom(e.target.value)}
              className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              data-testid="branch-create-from-select"
              aria-label="Base branch"
            >
              <option value="">(current HEAD)</option>
              {branches.map((b) => (
                <option key={`from:${b.isRemote ? 'r' : 'l'}:${b.name}`} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmCreate}
                disabled={busy || createName.trim().length === 0}
                className="px-3 py-1 text-xs font-medium rounded bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="branch-create-submit"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          data-testid="branch-delete-confirm"
        >
          <div className="w-full max-w-md rounded-lg bg-white dark:bg-gray-800 p-4 shadow-xl flex flex-col gap-3">
            <h3 className="text-sm font-medium text-gray-800 dark:text-gray-200">
              Delete <span className="font-mono">{deleteTarget.name}</span>?
            </h3>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
              <input
                type="checkbox"
                checked={deleteForce}
                onChange={(e) => setDeleteForce(e.target.checked)}
                data-testid="branch-delete-force"
              />
              Force delete (-D) — unmerged commits will be lost
            </label>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={busy}
                className="px-3 py-1 text-xs font-medium rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                data-testid="branch-delete-confirm-button"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

// ----------------------------------------------------------------------------
// Stash section (Issue #782)
// ----------------------------------------------------------------------------

interface StashSectionProps {
  stashes: StashInfo[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  actionError: string | null;
  conflictNotice: string | null;
  hasRunningSession: boolean;
  isMobile: boolean;
  onRefresh: () => void;
  onPush: (message: string, includeUntracked: boolean) => void;
  onPop: (index: number) => void;
  onApply: (index: number) => void;
  onDrop: (index: number) => void;
}

/**
 * Stash section (Issue #782). Lists stashes and exposes push / pop / apply /
 * drop. Self-fetched on mount + after a mutation only (NO 5s poll, S3-004).
 * Mobile-collapsed by default like the Changes / Branches sections.
 */
const StashSection = memo(function StashSection({
  stashes,
  loading,
  error,
  busy,
  actionError,
  conflictNotice,
  hasRunningSession,
  isMobile,
  onRefresh,
  onPush,
  onPop,
  onApply,
  onDrop,
}: StashSectionProps) {
  const [open, setOpen] = useState(!isMobile);
  const [pushMessage, setPushMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [dropConfirm, setDropConfirm] = useState<number | null>(null);

  return (
    <div
      className="border-b border-gray-200 dark:border-gray-700"
      data-testid="git-stash-section"
    >
      <div className="flex items-center justify-between px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer hover:text-gray-900 dark:hover:text-gray-100"
        >
          <span className="text-xs w-4 text-center">{open ? '▼' : '▶'}</span>
          Stash {stashes.length > 0 && <span className="text-xs text-gray-400">({stashes.length})</span>}
        </button>
        <button
          type="button"
          onClick={onRefresh}
          className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded"
          aria-label="Refresh stash list"
        >
          <RefreshIcon />
        </button>
      </div>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {error && (
            <div className="text-xs text-red-600 dark:text-red-400" role="alert" data-testid="git-stash-error">
              {error}
            </div>
          )}
          {actionError && (
            <div className="text-xs text-red-600 dark:text-red-400" role="alert" data-testid="git-stash-action-error">
              {actionError}
            </div>
          )}
          {conflictNotice && (
            <div className="text-xs text-orange-600 dark:text-orange-400" role="status" data-testid="git-stash-conflict">
              {conflictNotice}
            </div>
          )}

          {/* Push form */}
          <div className="flex flex-col gap-1.5">
            <input
              type="text"
              value={pushMessage}
              onChange={(e) => setPushMessage(e.target.value)}
              placeholder="Stash message (optional)"
              className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              data-testid="git-stash-push-message"
            />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={includeUntracked}
                  onChange={(e) => setIncludeUntracked(e.target.checked)}
                  data-testid="git-stash-include-untracked"
                />
                Include untracked
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onPush(pushMessage, includeUntracked);
                  setPushMessage('');
                  setIncludeUntracked(false);
                }}
                className="px-2 py-1 text-xs rounded bg-cyan-600 hover:bg-cyan-700 text-white disabled:opacity-50"
                data-testid="stash-push-button"
              >
                Stash
              </button>
            </div>
          </div>

          {/* Stash list */}
          {loading ? (
            <div className="py-3 text-center text-xs text-gray-500 dark:text-gray-400" role="status">
              Loading stashes...
            </div>
          ) : stashes.length === 0 ? (
            <div className="py-3 text-center text-xs text-gray-500 dark:text-gray-400">No stashes</div>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {stashes.map((stash) => (
                <li key={stash.index} className="py-1.5" data-testid="git-stash-row">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-mono text-xs text-cyan-600 dark:text-cyan-400">
                        stash@{'{'}{stash.index}{'}'}
                      </span>
                      <span className="ml-2 text-xs text-gray-700 dark:text-gray-300 truncate">
                        {stash.message}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onApply(stash.index)}
                        className="px-1.5 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                        data-testid="stash-apply-button"
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onPop(stash.index)}
                        className="px-1.5 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                        data-testid="stash-pop-button"
                      >
                        Pop
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setDropConfirm(stash.index)}
                        className="px-1.5 py-0.5 text-xs rounded border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
                        data-testid="stash-drop-button"
                      >
                        Drop
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Drop confirm dialog */}
      {dropConfirm !== null && (
        <div
          className="px-3 py-3 border-t border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20"
          data-testid="git-stash-drop-confirm"
          role="dialog"
        >
          <p className="text-xs text-red-700 dark:text-red-300">
            stash@{'{'}{dropConfirm}{'}'} を完全に削除します。この操作は取り消せません。
          </p>
          {hasRunningSession && (
            <p
              className="mt-1 text-xs text-red-700 dark:text-red-300"
              data-testid="git-stash-drop-session-warning"
            >
              {DANGER_ZONE_RUNNING_SESSION_WARNING}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onDrop(dropConfirm);
                setDropConfirm(null);
              }}
              className="px-2 py-1 text-xs rounded bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
              data-testid="git-stash-drop-confirm-button"
            >
              Drop
            </button>
            <button
              type="button"
              onClick={() => setDropConfirm(null)}
              className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

// ----------------------------------------------------------------------------
// Danger Zone section (Issue #782)
// ----------------------------------------------------------------------------

interface DangerZoneSectionProps {
  /** The currently selected commit (full %H) from the Commit History list. */
  selectedCommit: string | null;
  busy: boolean;
  actionError: string | null;
  conflictNotice: string | null;
  currentBranch: string | null;
  hasRunningSession: boolean;
  isMobile: boolean;
  onReset: (target: string, mode: GitResetMode, confirmBranch: string | undefined) => void;
  onRevert: (commitHash: string, noCommit: boolean) => void;
  /**
   * Issue #783: force-push the current branch. `--force-with-lease` is the
   * default (forceWithLease=true); the lease check is a second safety net. The
   * server refuses a force push to the default branch with 409 protected_branch
   * (PUSH_PROTECTED_BRANCH_WARNING). When omitted, the force-push UI is hidden.
   */
  onForcePush?: (forceWithLease: boolean) => void;
}

/**
 * Danger Zone section (Issue #782). Collapsed by default (red styling), at the
 * very bottom of the pane. Hosts the Reset modal (target / mode radio / hard
 * branch-confirm input + running-session + history-loss warnings) and the
 * Revert modal (commit hash display + noCommit). target/commitHash are sourced
 * from the Commit History selectedCommit (full %H), S3-003.
 */
const DangerZoneSection = memo(function DangerZoneSection({
  selectedCommit,
  busy,
  actionError,
  conflictNotice,
  currentBranch,
  hasRunningSession,
  isMobile,
  onReset,
  onRevert,
  onForcePush,
}: DangerZoneSectionProps) {
  const [open, setOpen] = useState(false); // default closed
  const [resetMode, setResetMode] = useState<GitResetMode>('mixed');
  const [resetUseHead, setResetUseHead] = useState(true);
  const [confirmBranch, setConfirmBranch] = useState('');
  const [showResetModal, setShowResetModal] = useState(false);
  const [showRevertModal, setShowRevertModal] = useState(false);
  const [revertNoCommit, setRevertNoCommit] = useState(false);
  // Issue #783: force-push. --force-with-lease is preferred (the lease check is
  // a second safety net); the lease-less --force escape hatch is opt-in.
  const [showForcePushModal, setShowForcePushModal] = useState(false);
  const [forceWithLease, setForceWithLease] = useState(true);

  // Reset target: literal HEAD, or the selected commit (full hash).
  const resetTarget = resetUseHead ? 'HEAD' : selectedCommit;
  const resetTargetMissing = !resetUseHead && !selectedCommit;

  return (
    <div
      className="border-t-2 border-red-300 dark:border-red-800"
      data-testid="git-danger-zone-section"
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full flex items-center gap-1 px-3 py-2 text-sm font-medium text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 cursor-pointer hover:bg-red-100 dark:hover:bg-red-900/30"
        data-testid="git-danger-zone-toggle"
      >
        <span className="text-xs w-4 text-center">{open ? '▼' : '▶'}</span>
        Danger Zone
      </button>

      {open && (
        <div className="px-3 py-3 space-y-2 bg-red-50/50 dark:bg-red-900/10">
          {actionError && (
            <div className="text-xs text-red-600 dark:text-red-400" role="alert" data-testid="git-danger-zone-error">
              {actionError}
            </div>
          )}
          {conflictNotice && (
            <div className="text-xs text-orange-600 dark:text-orange-400" role="status" data-testid="git-danger-zone-conflict">
              {conflictNotice}
            </div>
          )}
          <div className={`flex ${isMobile ? 'flex-col' : 'flex-row'} gap-2`}>
            <button
              type="button"
              onClick={() => setShowResetModal(true)}
              className="px-2 py-1 text-xs rounded border border-red-400 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30"
              data-testid="git-danger-zone-reset-open"
            >
              Reset…
            </button>
            <button
              type="button"
              disabled={!selectedCommit}
              onClick={() => setShowRevertModal(true)}
              className="px-2 py-1 text-xs rounded border border-red-400 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-50"
              data-testid="git-danger-zone-revert-open"
            >
              Revert…
            </button>
            {onForcePush && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setShowForcePushModal(true)}
                className="px-2 py-1 text-xs rounded border border-red-400 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-50"
                data-testid="git-force-push-open"
              >
                Force Push…
              </button>
            )}
          </div>
          {!selectedCommit && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Select a commit in Commit History to enable revert / reset-to-commit.
            </p>
          )}
        </div>
      )}

      {/* Reset modal */}
      {showResetModal && (
        <div
          className="px-3 py-3 border-t border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20"
          data-testid="reset-confirm"
          role="dialog"
        >
          <p className="text-sm font-medium text-red-700 dark:text-red-300 mb-2">Reset</p>

          {/* Target selection */}
          <div className="flex flex-col gap-1 mb-2">
            <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
              <input
                type="radio"
                name="reset-target"
                checked={resetUseHead}
                onChange={() => setResetUseHead(true)}
                data-testid="reset-target-head"
              />
              HEAD
            </label>
            <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
              <input
                type="radio"
                name="reset-target"
                checked={!resetUseHead}
                disabled={!selectedCommit}
                onChange={() => setResetUseHead(false)}
                data-testid="reset-target-commit"
              />
              Selected commit {selectedCommit ? `(${selectedCommit.slice(0, 7)})` : '(none selected)'}
            </label>
          </div>

          {/* Mode radio */}
          <div className="flex flex-col gap-1 mb-2">
            {(['soft', 'mixed', 'hard'] as GitResetMode[]).map((m) => (
              <label key={m} className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
                <input
                  type="radio"
                  name="reset-mode"
                  checked={resetMode === m}
                  onChange={() => setResetMode(m)}
                  data-testid={`reset-mode-${m}`}
                />
                {m}
              </label>
            ))}
          </div>

          {/* Hard-mode warnings + branch confirm */}
          {resetMode === 'hard' && (
            <div className="mb-2 space-y-1">
              <p
                className="text-xs text-red-700 dark:text-red-300"
                data-testid="reset-hard-history-loss-warning"
              >
                {RESET_HARD_HISTORY_LOSS_WARNING}
              </p>
              {hasRunningSession && (
                <p
                  className="text-xs text-red-700 dark:text-red-300"
                  data-testid="reset-hard-session-warning"
                >
                  {DANGER_ZONE_RUNNING_SESSION_WARNING}
                </p>
              )}
              <input
                type="text"
                value={confirmBranch}
                onChange={(e) => setConfirmBranch(e.target.value)}
                placeholder={`Type "${currentBranch ?? ''}" to confirm`}
                className="w-full px-2 py-1 text-xs border border-red-300 dark:border-red-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                data-testid="reset-hard-branch-input"
              />
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={
                busy ||
                resetTargetMissing ||
                (resetMode === 'hard' && confirmBranch !== (currentBranch ?? ''))
              }
              onClick={() => {
                if (!resetTarget) return;
                onReset(resetTarget, resetMode, resetMode === 'hard' ? confirmBranch : undefined);
                setShowResetModal(false);
                setConfirmBranch('');
              }}
              className="px-2 py-1 text-xs rounded bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
              data-testid="reset-confirm-button"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => {
                setShowResetModal(false);
                setConfirmBranch('');
              }}
              className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Revert modal */}
      {showRevertModal && selectedCommit && (
        <div
          className="px-3 py-3 border-t border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20"
          data-testid="revert-confirm"
          role="dialog"
        >
          <p className="text-sm font-medium text-red-700 dark:text-red-300 mb-2">Revert</p>
          <p className="text-xs text-gray-700 dark:text-gray-300 mb-2">
            Revert commit <span className="font-mono">{selectedCommit.slice(0, 7)}</span>
          </p>
          {hasRunningSession && (
            <p
              className="mb-2 text-xs text-red-700 dark:text-red-300"
              data-testid="revert-session-warning"
            >
              {DANGER_ZONE_RUNNING_SESSION_WARNING}
            </p>
          )}
          <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300 mb-2">
            <input
              type="checkbox"
              checked={revertNoCommit}
              onChange={(e) => setRevertNoCommit(e.target.checked)}
              data-testid="revert-no-commit"
            />
            No commit (leave staged)
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onRevert(selectedCommit, revertNoCommit);
                setShowRevertModal(false);
                setRevertNoCommit(false);
              }}
              className="px-2 py-1 text-xs rounded bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
              data-testid="revert-confirm-button"
            >
              Revert
            </button>
            <button
              type="button"
              onClick={() => {
                setShowRevertModal(false);
                setRevertNoCommit(false);
              }}
              className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Force push modal (Issue #783, §7.3) */}
      {showForcePushModal && onForcePush && (
        <div
          className="px-3 py-3 border-t border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20"
          data-testid="force-push-confirm"
          role="dialog"
        >
          <p className="text-sm font-medium text-red-700 dark:text-red-300 mb-2">Force Push</p>
          <p
            className="mb-2 text-xs text-red-700 dark:text-red-300"
            data-testid="force-push-protected-branch-warning"
          >
            {PUSH_PROTECTED_BRANCH_WARNING}
          </p>
          {hasRunningSession && (
            <p
              className="mb-2 text-xs text-red-700 dark:text-red-300"
              data-testid="force-push-session-warning"
            >
              {DANGER_ZONE_RUNNING_SESSION_WARNING}
            </p>
          )}
          <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300 mb-2">
            <input
              type="checkbox"
              checked={forceWithLease}
              onChange={(e) => setForceWithLease(e.target.checked)}
              data-testid="force-push-with-lease"
            />
            Use --force-with-lease (recommended — refuses if the remote moved)
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onForcePush(forceWithLease);
                setShowForcePushModal(false);
              }}
              className="px-2 py-1 text-xs rounded bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
              data-testid="force-push-confirm-button"
            >
              Force Push
            </button>
            <button
              type="button"
              onClick={() => setShowForcePushModal(false)}
              className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

// ============================================================================
// Main Component
// ============================================================================

export const GitPane = memo(function GitPane({
  worktreeId,
  onDiffSelect,
  isMobile = false,
  worktree,
  className = '',
}: GitPaneProps) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Collapsible section states
  const [commitListOpen, setCommitListOpen] = useState(true);
  const [changedFilesOpen, setChangedFilesOpen] = useState(true);
  const [diffOpen, setDiffOpen] = useState(true);

  // Issue #815: "Advanced operations" group (Fetch / Branches create+delete /
  // Stash / Danger Zone) open-state, default closed and persisted to localStorage
  // (key `commandmate:gitPane:advancedOpen`). SSR-safe via useLocalStorageState
  // (starts closed, hydrates on mount).
  const { value: advancedOpen, setValue: setAdvancedOpen } = useLocalStorageState<boolean>({
    key: 'commandmate:gitPane:advancedOpen',
    defaultValue: false,
    validate: (v): v is boolean => typeof v === 'boolean',
  });
  const toggleAdvanced = useCallback(() => setAdvancedOpen((prev) => !prev), [setAdvancedOpen]);

  // Issue #779: Current Status (self-fetched, independent of commit history)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Issue #780: Changes (staged / unstaged / untracked) + commit form
  const [staged, setStaged] = useState<GitStagedResponse | null>(null);
  const [stagedLoading, setStagedLoading] = useState(true);
  const [stagedError, setStagedError] = useState<string | null>(null);
  const [opBusy, setOpBusy] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [changesCommitError, setChangesCommitError] = useState<string | null>(null);

  // Issue #781: Branches (list / checkout / create / delete)
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchInclude, setBranchInclude] = useState<BranchInclude>('local');
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchActionError, setBranchActionError] = useState<string | null>(null);

  // Issue #782: Stash (list / push / pop / apply / drop)
  const [stashes, setStashes] = useState<StashInfo[]>([]);
  const [stashLoading, setStashLoading] = useState(true);
  const [stashError, setStashError] = useState<string | null>(null);
  const [stashBusy, setStashBusy] = useState(false);
  const [stashActionError, setStashActionError] = useState<string | null>(null);
  const [stashConflictNotice, setStashConflictNotice] = useState<string | null>(null);

  // Issue #782: Danger Zone (reset / revert)
  const [dangerBusy, setDangerBusy] = useState(false);
  const [dangerActionError, setDangerActionError] = useState<string | null>(null);
  const [dangerConflictNotice, setDangerConflictNotice] = useState<string | null>(null);

  // S3-002: any running CLI session for this worktree makes the working-tree
  // checkout risky; the confirm dialog surfaces a warning when this is true.
  const hasRunningSession = Object.values(worktree?.sessionStatusByCli ?? {}).some(
    (s) => s?.isRunning === true
  );

  /**
   * Fetch current git status (branch / dirty / ahead-behind). Issue #779.
   * Read-only and idempotent; the status section never affects commits/diff.
   */
  const fetchStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/status`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setStatusError(data.error || 'Failed to fetch git status');
        return;
      }
      const data: GitStatus = await response.json();
      setGitStatus(data);
    } catch {
      setStatusError('Failed to fetch git status');
    } finally {
      setStatusLoading(false);
    }
  }, [worktreeId]);

  // Mount fetch for current status
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // NOTE (Issue #783, DR3-006): the 5s status poll is registered LATER in this
  // component (search "useFilePolling") so its `enabled` can be gated on the
  // network-op progressState (paused while a push/pull is in-flight).

  /**
   * Fetch the working-tree changes (staged / unstaged / untracked). Issue #780.
   * Read-only; failures surface inline and never affect commits/diff.
   */
  const fetchStaged = useCallback(async () => {
    setStagedError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/staged`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setStagedError(data.error || 'Failed to fetch changes');
        return;
      }
      const data: GitStagedResponse = await response.json();
      setStaged(data);
    } catch {
      setStagedError('Failed to fetch changes');
    } finally {
      setStagedLoading(false);
    }
  }, [worktreeId]);

  // Mount fetch for changes
  useEffect(() => {
    fetchStaged();
  }, [fetchStaged]);

  /**
   * Fetch commit history
   */
  const fetchCommits = useCallback(async () => {
    setIsLoading(true);
    setCommitError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/log`);
      if (!response.ok) {
        const data = await response.json();
        setCommitError(data.error || 'Failed to fetch commit history');
        return;
      }
      const data = await response.json();
      setCommits(data.commits);
    } catch {
      setCommitError('Failed to fetch commit history');
    } finally {
      setIsLoading(false);
    }
  }, [worktreeId]);

  /**
   * Fetch changed files for a commit
   */
  const fetchChangedFiles = useCallback(async (commitHash: string) => {
    setIsLoadingFiles(true);
    setChangedFiles([]);
    setSelectedFile(null);
    setDiffContent(null);
    setDetailError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/show/${commitHash}`);
      if (!response.ok) {
        const data = await response.json();
        setDetailError(data.error || 'Failed to fetch commit details');
        return;
      }
      const data = await response.json();
      setChangedFiles(data.files);
    } catch {
      setDetailError('Failed to fetch commit details');
    } finally {
      setIsLoadingFiles(false);
    }
  }, [worktreeId]);

  /**
   * Fetch diff for a specific file
   */
  const fetchDiff = useCallback(async (commitHash: string, filePath: string) => {
    setIsLoadingDiff(true);
    setDiffContent(null);
    setDetailError(null);
    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/git/diff?commit=${commitHash}&file=${encodeURIComponent(filePath)}`
      );
      if (!response.ok) {
        const data = await response.json();
        setDetailError(data.error || 'Failed to fetch diff');
        return;
      }
      const data = await response.json();
      setDiffContent(data.diff);
      onDiffSelect(data.diff, filePath);
    } catch {
      setDetailError('Failed to fetch diff');
    } finally {
      setIsLoadingDiff(false);
    }
  }, [worktreeId, onDiffSelect]);

  // Fetch commits on mount
  useEffect(() => {
    fetchCommits();
  }, [fetchCommits]);

  /**
   * Handle commit selection
   */
  const handleCommitSelect = useCallback((commitHash: string) => {
    setSelectedCommit(commitHash);
    fetchChangedFiles(commitHash);
  }, [fetchChangedFiles]);

  /**
   * Handle file selection
   */
  const handleFileSelect = useCallback((filePath: string) => {
    if (!selectedCommit) return;
    setSelectedFile(filePath);
    fetchDiff(selectedCommit, filePath);
  }, [selectedCommit, fetchDiff]);

  /**
   * Handle refresh
   */
  const handleRefresh = useCallback(() => {
    setSelectedCommit(null);
    setChangedFiles([]);
    setSelectedFile(null);
    setDiffContent(null);
    setDetailError(null);
    fetchCommits();
  }, [fetchCommits]);

  /**
   * Handle current-status refresh (Issue #779)
   */
  const handleStatusRefresh = useCallback(() => {
    fetchStatus();
  }, [fetchStatus]);

  // ------------------------------------------------------------------------
  // Issue #780: Changes handlers (stage / unstage / commit + diff)
  // ------------------------------------------------------------------------

  /**
   * Stage one or more files, then immediately refetch the changes list.
   */
  const handleStage = useCallback(async (filePath: string) => {
    setOpBusy(true);
    setStagedError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [filePath] }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setStagedError(data.error || 'Failed to stage file');
        return;
      }
      await fetchStaged();
    } catch {
      setStagedError('Failed to stage file');
    } finally {
      setOpBusy(false);
    }
  }, [worktreeId, fetchStaged]);

  /**
   * Unstage one or more files, then immediately refetch the changes list.
   */
  const handleUnstage = useCallback(async (filePath: string) => {
    setOpBusy(true);
    setStagedError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/unstage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [filePath] }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setStagedError(data.error || 'Failed to unstage file');
        return;
      }
      await fetchStaged();
    } catch {
      setStagedError('Failed to unstage file');
    } finally {
      setOpBusy(false);
    }
  }, [worktreeId, fetchStaged]);

  /**
   * Create a commit. On success: clear the message, refetch changes, AND
   * refetch commit history + current status immediately (do not wait for the
   * 5s poll). The /git/log refresh button (handleRefresh) is deliberately NOT
   * wired here so the existing GitPane test stays intact.
   */
  const handleCommit = useCallback(async () => {
    setCommitting(true);
    setChangesCommitError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMessage, amend }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setChangesCommitError(data.error || 'Failed to commit');
        return;
      }
      setCommitMessage('');
      setAmend(false);
      await fetchStaged();
      await fetchCommits();
      await fetchStatus();
    } catch {
      setChangesCommitError('Failed to commit');
    } finally {
      setCommitting(false);
    }
  }, [worktreeId, commitMessage, amend, fetchStaged, fetchCommits, fetchStatus]);

  /**
   * Show the diff for a working-tree file (Issue #780). Uses the dedicated
   * working-tree diff endpoint (NOT the commit-scoped /git/diff route), passing
   * the list's mode (staged / unstaged / untracked). Routes the result through
   * onDiffSelect, the same display path as commit diffs (mobile inline reuse
   * works because setDiffContent feeds the inline viewer). Failures are kept
   * non-fatal, though they should not occur for valid files.
   */
  const handleChangesDiff = useCallback(async (filePath: string, mode: ChangesDiffMode) => {
    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/git/working-diff?file=${encodeURIComponent(filePath)}&mode=${mode}`
      );
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      if (typeof data.diff === 'string') {
        setDiffContent(data.diff);
        onDiffSelect(data.diff, filePath);
      }
    } catch {
      // Diff failures for working-tree files are non-fatal; ignored.
    }
  }, [worktreeId, onDiffSelect]);

  // ------------------------------------------------------------------------
  // Issue #781: Branches handlers (list / checkout / create / delete)
  // ------------------------------------------------------------------------

  /**
   * Fetch the branch list for the current include filter. Read-only; failures
   * surface inline and never affect the other sections. NO new 5s poll (S3-005):
   * fetched on mount + on include change + after a mutation.
   */
  const fetchBranches = useCallback(async (include: BranchInclude) => {
    setBranchesError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/branches?include=${include}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setBranchesError(data.error || 'Failed to fetch branches');
        return;
      }
      const data = await response.json();
      setBranches(Array.isArray(data.branches) ? data.branches : []);
    } catch {
      setBranchesError('Failed to fetch branches');
    } finally {
      setBranchesLoading(false);
    }
  }, [worktreeId]);

  // Mount fetch + refetch when the include tab changes.
  useEffect(() => {
    fetchBranches(branchInclude);
  }, [fetchBranches, branchInclude]);

  const handleBranchIncludeChange = useCallback((include: BranchInclude) => {
    setBranchInclude(include);
  }, []);

  const handleBranchesRefresh = useCallback(() => {
    fetchBranches(branchInclude);
  }, [fetchBranches, branchInclude]);

  /**
   * Checkout a branch. On success run the S3-005 cascade (status + staged +
   * branches + commit history) so every dependent section reflects the new HEAD.
   */
  const handleCheckout = useCallback(async (branch: BranchInfo, force: boolean) => {
    setBranchBusy(true);
    setBranchActionError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: branch.name, force }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setBranchActionError(data.error || 'Failed to checkout branch');
        return;
      }
      // S3-005 cascade: HEAD changed -> refetch everything affected.
      await Promise.all([
        fetchStatus(),
        fetchStaged(),
        fetchBranches(branchInclude),
        fetchCommits(),
      ]);
    } catch {
      setBranchActionError('Failed to checkout branch');
    } finally {
      setBranchBusy(false);
    }
  }, [worktreeId, branchInclude, fetchStatus, fetchStaged, fetchBranches, fetchCommits]);

  /**
   * Create a branch (no checkout). On success only the branch list changes
   * (HEAD unchanged), so refetch branches only (S3-005).
   */
  const handleBranchCreate = useCallback(async (name: string, from: string | undefined) => {
    setBranchBusy(true);
    setBranchActionError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/branch/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, from }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setBranchActionError(data.error || 'Failed to create branch');
        return;
      }
      await fetchBranches(branchInclude);
    } catch {
      setBranchActionError('Failed to create branch');
    } finally {
      setBranchBusy(false);
    }
  }, [worktreeId, branchInclude, fetchBranches]);

  /**
   * Delete a branch. On success only the branch list changes (HEAD unchanged),
   * so refetch branches only (S3-005).
   */
  const handleBranchDelete = useCallback(async (name: string, force: boolean) => {
    setBranchBusy(true);
    setBranchActionError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/branch/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, force }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setBranchActionError(data.error || 'Failed to delete branch');
        return;
      }
      await fetchBranches(branchInclude);
    } catch {
      setBranchActionError('Failed to delete branch');
    } finally {
      setBranchBusy(false);
    }
  }, [worktreeId, branchInclude, fetchBranches]);

  // ------------------------------------------------------------------------
  // Issue #782: Stash handlers (list / push / pop / apply / drop)
  // ------------------------------------------------------------------------

  /**
   * Fetch the stash list. Read-only; failures surface inline. NO new 5s poll
   * (S3-004): fetched on mount + after a stash mutation only.
   */
  const fetchStash = useCallback(async () => {
    setStashError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/stash`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setStashError(data.error || 'Failed to fetch stashes');
        return;
      }
      const data = await response.json();
      setStashes(Array.isArray(data.stashes) ? data.stashes : []);
    } catch {
      setStashError('Failed to fetch stashes');
    } finally {
      setStashLoading(false);
    }
  }, [worktreeId]);

  // Mount fetch for stash list (no poll).
  useEffect(() => {
    fetchStash();
  }, [fetchStash]);

  /**
   * Shared stash-mutation cascade (S3-004): a stash op changes the working tree,
   * so refetch the stash list + status + staged.
   */
  const stashCascade = useCallback(async () => {
    await Promise.all([fetchStash(), fetchStatus(), fetchStaged()]);
  }, [fetchStash, fetchStatus, fetchStaged]);

  const runStashOp = useCallback(
    async (url: string, init: RequestInit, failMessage: string) => {
      setStashBusy(true);
      setStashActionError(null);
      setStashConflictNotice(null);
      try {
        const response = await fetch(url, init);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setStashActionError(data.error || failMessage);
          return;
        }
        // pop/apply can succeed (HTTP 200) yet leave conflict markers; the API
        // returns { conflict, conflictFiles, stashRetained } in that case. Surface
        // it like the Danger Zone revert path instead of silently cascading.
        if (data.conflict) {
          const files = Array.isArray(data.conflictFiles) ? data.conflictFiles.join(', ') : '';
          const retained = data.stashRetained ? ' (stash retained)' : '';
          setStashConflictNotice(`Stash operation produced conflicts: ${files}${retained}`);
        }
        await stashCascade();
      } catch {
        setStashActionError(failMessage);
      } finally {
        setStashBusy(false);
      }
    },
    [stashCascade]
  );

  const handleStashPush = useCallback(
    (message: string, includeUntracked: boolean) => {
      void runStashOp(
        `/api/worktrees/${worktreeId}/git/stash/push`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: message || undefined, includeUntracked }),
        },
        'Failed to stash changes'
      );
    },
    [worktreeId, runStashOp]
  );

  const handleStashPop = useCallback(
    (index: number) => {
      void runStashOp(
        `/api/worktrees/${worktreeId}/git/stash/pop`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index }),
        },
        'Failed to pop stash'
      );
    },
    [worktreeId, runStashOp]
  );

  const handleStashApply = useCallback(
    (index: number) => {
      void runStashOp(
        `/api/worktrees/${worktreeId}/git/stash/apply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index }),
        },
        'Failed to apply stash'
      );
    },
    [worktreeId, runStashOp]
  );

  const handleStashDrop = useCallback(
    (index: number) => {
      void runStashOp(
        `/api/worktrees/${worktreeId}/git/stash/${index}`,
        { method: 'DELETE' },
        'Failed to drop stash'
      );
    },
    [worktreeId, runStashOp]
  );

  // ------------------------------------------------------------------------
  // Issue #782: Danger Zone handlers (reset / revert)
  // ------------------------------------------------------------------------

  /**
   * Shared reset/revert cascade (S3-005): HEAD moved, so refetch status +
   * staged + branches (ahead/behind freshness) + commit history.
   */
  const dangerCascade = useCallback(async () => {
    await Promise.all([
      fetchStatus(),
      fetchStaged(),
      fetchBranches(branchInclude),
      fetchCommits(),
    ]);
  }, [fetchStatus, fetchStaged, fetchBranches, branchInclude, fetchCommits]);

  const handleReset = useCallback(
    async (target: string, mode: GitResetMode, confirmBranch: string | undefined) => {
      setDangerBusy(true);
      setDangerActionError(null);
      setDangerConflictNotice(null);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}/git/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, mode, confirmBranch }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setDangerActionError(data.error || 'Failed to reset');
          return;
        }
        await dangerCascade();
      } catch {
        setDangerActionError('Failed to reset');
      } finally {
        setDangerBusy(false);
      }
    },
    [worktreeId, dangerCascade]
  );

  const handleRevert = useCallback(
    async (commitHash: string, noCommit: boolean) => {
      setDangerBusy(true);
      setDangerActionError(null);
      setDangerConflictNotice(null);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}/git/revert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commitHash, noCommit }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setDangerActionError(data.error || 'Failed to revert');
          return;
        }
        const data = await response.json().catch(() => ({}));
        if (data.conflict) {
          const files = Array.isArray(data.conflictFiles) ? data.conflictFiles.join(', ') : '';
          setDangerConflictNotice(`Revert produced conflicts: ${files}`);
        }
        await dangerCascade();
      } catch {
        setDangerActionError('Failed to revert');
      } finally {
        setDangerBusy(false);
      }
    },
    [worktreeId, dangerCascade]
  );

  // ========================================================================
  // Issue #783: network operations (fetch / pull / push)
  // ========================================================================

  /**
   * Cascade re-fetch after a network op settles (§7.5). Scope is GitPane's own
   * self-fetched data only; worktree.gitStatus (header/sidebar) is left to the
   * next worktree poll (S3-010). fetch->status+branches; pull->+staged+commits;
   * push->status+branches.
   */
  const handleNetworkCascade = useCallback(
    (op: GitNetworkOperation) => {
      fetchStatus();
      fetchBranches(branchInclude);
      if (op === 'pull') {
        fetchStaged();
        fetchCommits();
      }
    },
    [fetchStatus, fetchBranches, branchInclude, fetchStaged, fetchCommits]
  );

  const {
    operation: networkOperation,
    progressState: networkProgressState,
    error: networkError,
    conflict: networkConflict,
    conflictFiles: networkConflictFiles,
    runFetch: runNetworkFetch,
    runPull: runNetworkPull,
    runPush: runNetworkPush,
    abort: abortNetworkOp,
  } = useGitPaneNetworkOps(worktreeId, { onCascade: handleNetworkCascade });

  // DR3-004: a push/pull holds the per-worktree writeChain up to 60s; disable
  // sibling section writes while in-flight by composing this lock into each
  // section's existing busy. fetch is EXEMPT (not serialized).
  const networkWriteLock =
    networkProgressState === 'running' &&
    (networkOperation === 'push' || networkOperation === 'pull');

  // hasUpstream drives the Push button's setUpstream: getAheadBehind is null when
  // no upstream is set, so the ahead/behind chip is absent and push must use -u.
  const hasUpstream = gitStatus?.aheadBehind != null;

  // DR3-006: the 5s status poll is paused while a network op is in-flight so it
  // does not re-fetch (and flicker) stale ahead/behind; it resumes on settle,
  // and the cascade refreshes the final state. (visibilitychange-aware; #779.)
  useFilePolling({
    intervalMs: GIT_STATUS_POLL_INTERVAL_MS,
    enabled: networkProgressState !== 'running',
    onPoll: fetchStatus,
  });

  // ========================================================================
  // Render
  // ========================================================================

  return (
    <div className={`flex flex-col overflow-hidden ${className}`}>
      {/* Current Status (Issue #779) - top of the pane, above Commit History */}
      <CurrentStatusSection
        gitStatus={gitStatus}
        statusLoading={statusLoading}
        statusError={statusError}
        isMobile={isMobile}
        onRefresh={handleStatusRefresh}
      />

      {/* Quick actions (Issue #783 Pull/Push + Issue #815 checkout dropdown) -
          core, directly under Current Status. Fetch was demoted to Advanced. */}
      <NetworkOperationsSection
        progressState={networkProgressState}
        operation={networkOperation}
        error={networkError}
        conflict={networkConflict}
        conflictFiles={networkConflictFiles}
        hasUpstream={hasUpstream}
        isMobile={isMobile}
        onPull={() => runNetworkPull({})}
        onPush={() => runNetworkPush({ setUpstream: !hasUpstream })}
        onAbort={abortNetworkOp}
        extraActions={
          <BranchCheckoutDropdown
            branches={branches}
            busy={branchBusy || networkWriteLock}
            actionError={branchActionError}
            hasRunningSession={hasRunningSession}
            isMobile={isMobile}
            onCheckout={handleCheckout}
          />
        }
      />

      {/* Changes (Issue #780) - core, below Quick actions, above Commit History */}
      <ChangesSection
        staged={staged}
        loading={stagedLoading}
        error={stagedError}
        busy={opBusy || networkWriteLock}
        commitMessage={commitMessage}
        amend={amend}
        committing={committing}
        commitError={changesCommitError}
        isMobile={isMobile}
        onRefresh={fetchStaged}
        onDiff={handleChangesDiff}
        onStage={handleStage}
        onUnstage={handleUnstage}
        onCommitMessageChange={setCommitMessage}
        onAmendChange={setAmend}
        onCommit={handleCommit}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={() => setCommitListOpen((prev) => !prev)}
          className="flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer hover:text-gray-900 dark:hover:text-gray-100"
        >
          <span className="text-xs w-4 text-center">{commitListOpen ? '▼' : '▶'}</span>
          Commit History
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded"
          aria-label="Refresh commit history"
        >
          <RefreshIcon />
        </button>
      </div>

      {/* Loading state */}
      {commitListOpen && isLoading && (
        <div className="flex items-center justify-center py-8" role="status">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-cyan-500" />
          <span className="sr-only">Loading commit history...</span>
        </div>
      )}

      {/* Commit-level error state */}
      {commitListOpen && commitError && !isLoading && (
        <div className="px-3 py-4 text-sm text-red-600 dark:text-red-400" role="alert">
          {commitError}
        </div>
      )}

      {/* Empty state */}
      {commitListOpen && !isLoading && !commitError && commits.length === 0 && (
        <div className="px-3 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No commits found
        </div>
      )}

      {/* Commit list + detail split layout */}
      {!isLoading && !commitError && commits.length > 0 && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {/* Upper: Commit list (scrollable, max 40% when open) */}
          {commitListOpen && (
            <div className={`overflow-y-auto ${selectedCommit ? 'max-h-[40%] shrink-0' : 'flex-1'}`}>
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {commits.map((commit) => (
                  <li key={commit.hash}>
                    <button
                      type="button"
                      onClick={() => handleCommitSelect(commit.hash)}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${
                        selectedCommit === commit.hash
                          ? 'bg-cyan-50 dark:bg-cyan-900/30'
                          : ''
                      }`}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-xs text-cyan-600 dark:text-cyan-400 shrink-0">
                          {commit.shortHash}
                        </span>
                        <span className="truncate text-gray-800 dark:text-gray-200">
                          {commit.message}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        <span>{commit.author}</span>
                        <span>{new Date(commit.date).toLocaleDateString()}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Lower: Changed files + Diff (scrollable) */}
          {selectedCommit && (
            <div className="flex-1 overflow-y-auto min-h-0 border-t border-gray-200 dark:border-gray-700">
              {/* Changed files header */}
              <button
                type="button"
                onClick={() => setChangedFilesOpen((prev) => !prev)}
                className="w-full flex items-center gap-1 px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 sticky top-0 z-10 cursor-pointer hover:text-gray-700 dark:hover:text-gray-200"
              >
                <span className="w-4 text-center">{changedFilesOpen ? '▼' : '▶'}</span>
                Changed Files
              </button>

              {changedFilesOpen && (
                <>
                  {/* Detail-level error (files/diff) - shown inline */}
                  {detailError && <InlineError message={detailError} />}

                  {isLoadingFiles && (
                    <div className="flex items-center justify-center py-4" role="status">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-500" />
                      <span className="sr-only">Loading changed files...</span>
                    </div>
                  )}
                  {!isLoadingFiles && !detailError && changedFiles.length === 0 && (
                    <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                      No changed files
                    </div>
                  )}
                  {!isLoadingFiles && changedFiles.length > 0 && (
                    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                      {changedFiles.map((file) => (
                        <li key={file.path}>
                          <button
                            type="button"
                            onClick={() => handleFileSelect(file.path)}
                            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${
                              selectedFile === file.path
                                ? 'bg-cyan-50 dark:bg-cyan-900/30'
                                : ''
                            }`}
                          >
                            <span className={`inline-block w-14 font-medium ${STATUS_TEXT_COLOR[file.status]}`}>
                              {file.status}
                            </span>
                            <span className="font-mono text-gray-700 dark:text-gray-300">
                              {file.path}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}

              {/* Inline diff viewer (mobile only) */}
              {isMobile && selectedFile && (
                <div className="border-t border-gray-200 dark:border-gray-700">
                  <button
                    type="button"
                    onClick={() => setDiffOpen((prev) => !prev)}
                    className="w-full flex items-center gap-1 px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 sticky top-0 z-10 cursor-pointer hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    <span className="w-4 text-center">{diffOpen ? '▼' : '▶'}</span>
                    Diff: {selectedFile}
                  </button>
                  {diffOpen && (
                    <>
                      {isLoadingDiff && (
                        <div className="flex items-center justify-center py-4" role="status">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-500" />
                          <span className="sr-only">Loading diff...</span>
                        </div>
                      )}
                      {!isLoadingDiff && diffContent && (
                        <div className="overflow-x-auto p-2">
                          <pre className="text-xs">
                            <code>
                              {diffContent.split('\n').map((line, index) => (
                                <DiffLine key={index} line={line} />
                              ))}
                            </code>
                          </pre>
                        </div>
                      )}
                      {!isLoadingDiff && !diffContent && !detailError && (
                        <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                          No diff available
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* PC: show selected file indicator */}
              {!isMobile && selectedFile && !detailError && (
                <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700">
                  {isLoadingDiff ? 'Loading diff...' : `Diff displayed in file panel: ${selectedFile}`}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Advanced operations (Issue #815) - collapsed by default, below Commit
          History. Wraps Fetch + Branches(create/delete) + Stash + Danger Zone. */}
      <AdvancedSection open={advancedOpen} onToggle={toggleAdvanced}>
        {/* Fetch (Issue #783 op, decoupled from Pull/Push per Issue #815) */}
        <div
          className="flex flex-col gap-1.5 px-3 py-2 border-b border-gray-200 dark:border-gray-700"
          data-testid="git-advanced-fetch"
        >
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Remote</span>
          <div>
            <button
              type="button"
              onClick={() => runNetworkFetch({})}
              disabled={networkProgressState === 'running'}
              className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
              data-testid="git-fetch-button"
            >
              Fetch
            </button>
          </div>
        </div>

        {/* Branches create/delete (Issue #781; checkout extracted to core #815) */}
        <BranchesSection
          branches={branches}
          include={branchInclude}
          loading={branchesLoading}
          error={branchesError}
          busy={branchBusy || networkWriteLock}
          actionError={branchActionError}
          isMobile={isMobile}
          onIncludeChange={handleBranchIncludeChange}
          onRefresh={handleBranchesRefresh}
          onCreate={handleBranchCreate}
          onDelete={handleBranchDelete}
        />

        {/* Stash (Issue #782) */}
        <StashSection
          stashes={stashes}
          loading={stashLoading}
          error={stashError}
          busy={stashBusy || networkWriteLock}
          actionError={stashActionError}
          conflictNotice={stashConflictNotice}
          hasRunningSession={hasRunningSession}
          isMobile={isMobile}
          onRefresh={fetchStash}
          onPush={handleStashPush}
          onPop={handleStashPop}
          onApply={handleStashApply}
          onDrop={handleStashDrop}
        />

        {/* Danger Zone (Issue #782) */}
        <DangerZoneSection
          selectedCommit={selectedCommit}
          busy={dangerBusy || networkWriteLock}
          actionError={dangerActionError}
          conflictNotice={dangerConflictNotice}
          currentBranch={gitStatus?.currentBranch ?? null}
          hasRunningSession={hasRunningSession}
          isMobile={isMobile}
          onReset={handleReset}
          onRevert={handleRevert}
          onForcePush={(forceWithLease) =>
            runNetworkPush(forceWithLease ? { forceWithLease: true } : { force: true })
          }
        />
      </AdvancedSection>
    </div>
  );
});

export default GitPane;
