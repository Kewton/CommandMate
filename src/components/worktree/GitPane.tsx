/**
 * GitPane Component
 * Issue #447: Git tab - commit history & diff display
 *
 * Displays commit history, changed files per commit, and file diffs.
 * Uses execFile-based API endpoints for security.
 *
 * PC: Clicking a file triggers onDiffSelect to show diff in the right pane.
 * Mobile: Diff is displayed inline within this component.
 *
 * Issue #922: this file used to be a ~3.1k-line god-component. Its presentation
 * was split into panel components under `git/panels/`, its data + side effects
 * into focused hooks (`useGitStatus` / `useCommitHistory` / `useChanges` /
 * `useBranches` / `useStash` / `useDangerZone`, plus the pre-existing
 * `useGitPaneNetworkOps` / `useGitPaneTabState`), and the responsive layout into
 * `GitPaneLayout`. What remains here is the COORDINATOR: it instantiates the
 * hooks in topological order, wires the cross-section refetch cascades (a commit
 * refreshes history + status; a checkout / reset / pull refreshes everything),
 * composes the network write-lock, provides the ambient GitPaneContext, and
 * hands the assembled sections to GitPaneLayout. Behavior and the external props
 * are unchanged.
 */

'use client';

import { memo, useCallback, useMemo } from 'react';
import type { GitNetworkOperation } from '@/types/git';
import type { Worktree } from '@/types/models';
import { useFilePolling } from '@/hooks/useFilePolling';
import { useGitPaneNetworkOps } from '@/hooks/useGitPaneNetworkOps';
import { useGitPaneTabState } from '@/hooks/useGitPaneTabState';
import { useGitStatus } from '@/hooks/useGitStatus';
import { useCommitHistory } from '@/hooks/useCommitHistory';
import { useChanges } from '@/hooks/useChanges';
import { useBranches } from '@/hooks/useBranches';
import { useStash } from '@/hooks/useStash';
import { useDangerZone } from '@/hooks/useDangerZone';
import { GIT_STATUS_POLL_INTERVAL_MS } from '@/config/git-status-config';
import { BranchCheckoutDropdown } from '@/components/worktree/git/BranchCheckoutDropdown';
import { AdvancedSection } from '@/components/worktree/git/AdvancedSection';
import {
  GitPaneProvider,
  type GitPaneContextValue,
} from '@/components/worktree/git/GitPaneContext';
import { GitPaneLayout } from '@/components/worktree/git/GitPaneLayout';
import { GitCurrentStatusBar } from '@/components/worktree/git/panels/GitCurrentStatusBar';
import { GitNetworkOperationsBar } from '@/components/worktree/git/panels/GitNetworkOperationsBar';
import { GitChangesPanel } from '@/components/worktree/git/panels/GitChangesPanel';
import { GitCommitHistoryPanel } from '@/components/worktree/git/panels/GitCommitHistoryPanel';
import { GitBranchPanel } from '@/components/worktree/git/panels/GitBranchPanel';
import { GitStashPanel } from '@/components/worktree/git/panels/GitStashPanel';
import { GitDangerZonePanel } from '@/components/worktree/git/panels/GitDangerZonePanel';

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
  /**
   * Issue #817: pre-populate the active CLI tab's MessageInput composer with an
   * "Ask AI" prompt (no auto-send). Wired to the parent's `handleInsertToMessage`
   * (the same `pendingInsertTextMap` path History / Memo panes use). When
   * omitted, the "Ask AI" buttons are hidden (graceful degradation).
   */
  onInsertToMessage?: (text: string) => void;
  className?: string;
}

// ============================================================================
// GitPane (coordinator)
// ============================================================================

export const GitPane = memo(function GitPane({
  worktreeId,
  onDiffSelect,
  isMobile = false,
  worktree,
  onInsertToMessage,
  className = '',
}: GitPaneProps) {
  // Issue #818: consolidated GitPane UI persistence — mobile active tab plus the
  // Commit History / Advanced collapse states. SSR-safe (defaults, hydrate on mount).
  const {
    activeTab,
    setActiveTab,
    historyOpen: commitListOpen,
    toggleHistory: toggleCommitList,
    advancedOpen,
    toggleAdvanced,
  } = useGitPaneTabState();

  // S3-002: any running CLI session for this worktree makes the working-tree
  // checkout risky; the confirm dialog surfaces a warning when this is true.
  const hasRunningSession = Object.values(worktree?.sessionStatusByCli ?? {}).some(
    (s) => s?.isRunning === true
  );

  // --------------------------------------------------------------------------
  // Hooks in topological order: each cross-section cascade is composed only from
  // fetchers already instantiated above it, so there are no circular deps.
  // --------------------------------------------------------------------------

  // Issue #779: Current Status (self-fetched, independent of commit history).
  const { gitStatus, statusLoading, statusError, fetchStatus } = useGitStatus(worktreeId);

  // Issue #447/#816: Commit History (list / detail / inline accordion / diff).
  const {
    commits,
    selectedCommit,
    changedFiles,
    inlineDiffCommit,
    inlineFiles,
    inlineFilesLoading,
    inlineFilesError,
    selectedFile,
    diffContent,
    isLoading,
    isLoadingFiles,
    isLoadingDiff,
    commitError,
    detailError,
    setDiffContent,
    fetchCommits,
    handleCommitSelect,
    handleFileSelect,
    handleToggleInlineDiff,
    handleInlineDiffFile,
    handleRefresh,
  } = useCommitHistory(worktreeId, onDiffSelect);

  // A commit refreshes commit history + current status (the changes list is
  // refreshed inside useChanges itself).
  const onCommitted = useCallback(async () => {
    await fetchCommits();
    await fetchStatus();
  }, [fetchCommits, fetchStatus]);

  // The Changes section's working-tree Diff button feeds both the mobile inline
  // viewer (setDiffContent) and the PC file pane (onDiffSelect), as the former
  // god-component did inline.
  const onWorkingDiff = useCallback(
    (diff: string, filePath: string) => {
      setDiffContent(diff);
      onDiffSelect(diff, filePath);
    },
    [setDiffContent, onDiffSelect]
  );

  // Issue #780: Changes (staged / unstaged / untracked) + commit form.
  const {
    staged,
    stagedLoading,
    stagedError,
    opBusy,
    commitMessage,
    setCommitMessage,
    amend,
    setAmend,
    committing,
    changesCommitError,
    fetchStaged,
    handleStage,
    handleUnstage,
    handleChangesDiff,
    fetchWorkingDiffText,
    commit: handleCommit,
    commitAndPush,
  } = useChanges(worktreeId, { onWorkingDiff, onCommitted });

  // A checkout moves HEAD: refresh status + changes + commit history (branches
  // refetched inside useBranches itself). S3-005.
  const onCheckoutCascade = useCallback(async () => {
    await Promise.all([fetchStatus(), fetchStaged(), fetchCommits()]);
  }, [fetchStatus, fetchStaged, fetchCommits]);

  // Issue #781: Branches (list / checkout / create / delete).
  const {
    branches,
    branchInclude,
    branchesLoading,
    branchesError,
    branchBusy,
    branchActionError,
    fetchBranches,
    handleBranchIncludeChange,
    handleBranchesRefresh,
    handleCheckout,
    handleBranchCreate,
    handleBranchDelete,
  } = useBranches(worktreeId, { onCheckoutCascade });

  // A stash op changes the working tree: refresh status + changes (stash list
  // refetched inside useStash itself). S3-004.
  const onStashMutated = useCallback(async () => {
    await Promise.all([fetchStatus(), fetchStaged()]);
  }, [fetchStatus, fetchStaged]);

  // Issue #782: Stash (list / push / pop / apply / drop).
  const {
    stashes,
    stashLoading,
    stashError,
    stashBusy,
    stashActionError,
    stashConflictNotice,
    fetchStash,
    handleStashPush,
    handleStashPop,
    handleStashApply,
    handleStashDrop,
  } = useStash(worktreeId, { onStashMutated });

  // A reset / revert moves HEAD: refresh status + changes + branches + history. S3-005.
  const onHeadMoved = useCallback(async () => {
    await Promise.all([
      fetchStatus(),
      fetchStaged(),
      fetchBranches(branchInclude),
      fetchCommits(),
    ]);
  }, [fetchStatus, fetchStaged, fetchBranches, branchInclude, fetchCommits]);

  // Issue #782: Danger Zone (reset / revert).
  const { dangerBusy, dangerActionError, dangerConflictNotice, handleReset, handleRevert } =
    useDangerZone(worktreeId, { onHeadMoved });

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

  /**
   * Issue #816 (A): commit, then push in one action. The push runs ONLY if the
   * commit succeeds; commitAndPush owns the `committing` flag. Defined here
   * (after the network hook) so runNetworkPush / hasUpstream are in scope.
   */
  const handleCommitAndPush = useCallback(
    () => commitAndPush(() => runNetworkPush({ setUpstream: !hasUpstream })),
    [commitAndPush, runNetworkPush, hasUpstream]
  );

  // DR3-006: the 5s status poll is paused while a network op is in-flight so it
  // does not re-fetch (and flicker) stale ahead/behind; it resumes on settle,
  // and the cascade refreshes the final state. (visibilitychange-aware; #779.)
  useFilePolling({
    intervalMs: GIT_STATUS_POLL_INTERVAL_MS,
    enabled: networkProgressState !== 'running',
    onPoll: fetchStatus,
  });

  // ========================================================================
  // Ambient config + section assembly
  // ========================================================================

  // Memoized so memo'd panels reading the context only re-render when one of the
  // three values actually changes.
  const contextValue = useMemo<GitPaneContextValue>(
    () => ({ isMobile, onDiffSelect, onInsertToMessage }),
    [isMobile, onDiffSelect, onInsertToMessage]
  );

  // Current Status (Issue #779) - orientation header (read).
  const statusSection = (
    <GitCurrentStatusBar
      gitStatus={gitStatus}
      statusLoading={statusLoading}
      statusError={statusError}
      onRefresh={fetchStatus}
    />
  );

  // Quick actions (Issue #783 Pull/Push + Issue #815 checkout dropdown).
  const quickActionsSection = (
    <GitNetworkOperationsBar
      progressState={networkProgressState}
      operation={networkOperation}
      error={networkError}
      conflict={networkConflict}
      conflictFiles={networkConflictFiles}
      hasUpstream={hasUpstream}
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
  );

  // Changes (Issue #780) - staged/unstaged/untracked + commit form.
  const changesSection = (
    <GitChangesPanel
      staged={staged}
      loading={stagedLoading}
      error={stagedError}
      busy={opBusy || networkWriteLock}
      commitMessage={commitMessage}
      amend={amend}
      committing={committing}
      commitError={changesCommitError}
      onRefresh={fetchStaged}
      onDiff={handleChangesDiff}
      onPreview={fetchWorkingDiffText}
      onStage={handleStage}
      onUnstage={handleUnstage}
      onCommitMessageChange={setCommitMessage}
      onAmendChange={setAmend}
      onCommit={handleCommit}
      onCommitAndPush={handleCommitAndPush}
    />
  );

  // Commit History (Issue #447/#816) - read. Collapse state persisted (Issue #818 C).
  const historySection = (
    <GitCommitHistoryPanel
      commits={commits}
      isLoading={isLoading}
      commitError={commitError}
      commitListOpen={commitListOpen}
      onToggleCommitList={toggleCommitList}
      onRefresh={handleRefresh}
      selectedCommit={selectedCommit}
      onCommitSelect={handleCommitSelect}
      inlineDiffCommit={inlineDiffCommit}
      inlineFiles={inlineFiles}
      inlineFilesLoading={inlineFilesLoading}
      inlineFilesError={inlineFilesError}
      onToggleInlineDiff={handleToggleInlineDiff}
      onInlineDiffFile={handleInlineDiffFile}
      changedFiles={changedFiles}
      isLoadingFiles={isLoadingFiles}
      detailError={detailError}
      selectedFile={selectedFile}
      onFileSelect={handleFileSelect}
      diffContent={diffContent}
      isLoadingDiff={isLoadingDiff}
    />
  );

  // Advanced operations (Issue #815) - Fetch + Branches(create/delete) + Stash
  // + Danger Zone. Collapsed by default; open-state persisted (Issue #818 C).
  const advancedSection = (
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
      <GitBranchPanel
        branches={branches}
        include={branchInclude}
        loading={branchesLoading}
        error={branchesError}
        busy={branchBusy || networkWriteLock}
        actionError={branchActionError}
        onIncludeChange={handleBranchIncludeChange}
        onRefresh={handleBranchesRefresh}
        onCreate={handleBranchCreate}
        onDelete={handleBranchDelete}
      />

      {/* Stash (Issue #782) */}
      <GitStashPanel
        stashes={stashes}
        loading={stashLoading}
        error={stashError}
        busy={stashBusy || networkWriteLock}
        actionError={stashActionError}
        conflictNotice={stashConflictNotice}
        hasRunningSession={hasRunningSession}
        onRefresh={fetchStash}
        onPush={handleStashPush}
        onPop={handleStashPop}
        onApply={handleStashApply}
        onDrop={handleStashDrop}
      />

      {/* Danger Zone (Issue #782) */}
      <GitDangerZonePanel
        selectedCommit={selectedCommit}
        busy={dangerBusy || networkWriteLock}
        actionError={dangerActionError}
        conflictNotice={dangerConflictNotice}
        currentBranch={gitStatus?.currentBranch ?? null}
        aheadCount={gitStatus?.aheadBehind?.ahead ?? null}
        hasRunningSession={hasRunningSession}
        onReset={handleReset}
        onRevert={handleRevert}
        onForcePush={(forceWithLease) =>
          runNetworkPush(forceWithLease ? { forceWithLease: true } : { force: true })
        }
      />
    </AdvancedSection>
  );

  return (
    <GitPaneProvider value={contextValue}>
      <GitPaneLayout
        activeTab={activeTab}
        onTabChange={setActiveTab}
        className={className}
        statusSection={statusSection}
        quickActionsSection={quickActionsSection}
        changesSection={changesSection}
        historySection={historySection}
        advancedSection={advancedSection}
      />
    </GitPaneProvider>
  );
});

export default GitPane;
