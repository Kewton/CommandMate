/**
 * GitDangerZonePanel (Issue #782, extracted in #922)
 *
 * Collapsed by default (red styling), at the very bottom of the pane. Hosts the
 * Reset modal (target / mode radio / hard branch-confirm input + running-session
 * + history-loss warnings), the Revert modal (commit hash display + noCommit),
 * and the Force Push modal. target/commitHash are sourced from the Commit
 * History selectedCommit (full %H), S3-003. `isMobile` and the "Ask AI" handler
 * are read from GitPaneContext.
 */

'use client';

import { memo, useState } from 'react';
import type { GitResetMode } from '@/types/git';
import { resetPrompt, revertPrompt, forcePushPrompt } from '@/lib/git-ai-prompt-templates';
import {
  RESET_HARD_HISTORY_LOSS_WARNING,
  DANGER_ZONE_RUNNING_SESSION_WARNING,
  PUSH_PROTECTED_BRANCH_WARNING,
} from '@/config/git-status-config';
import { AskAiButton } from '@/components/worktree/git/gitPaneShared';
import { useGitPaneContext } from '@/components/worktree/git/GitPaneContext';
import { Checkbox, RadioGroup, RadioGroupItem } from '@/components/ui';

export interface GitDangerZonePanelProps {
  /** The currently selected commit (full %H) from the Commit History list. */
  selectedCommit: string | null;
  busy: boolean;
  actionError: string | null;
  conflictNotice: string | null;
  currentBranch: string | null;
  /** Issue #817: commits ahead of upstream, for the force-push Ask AI prompt. */
  aheadCount?: number | null;
  hasRunningSession: boolean;
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

export const GitDangerZonePanel = memo(function GitDangerZonePanel({
  selectedCommit,
  busy,
  actionError,
  conflictNotice,
  currentBranch,
  aheadCount,
  hasRunningSession,
  onReset,
  onRevert,
  onForcePush,
}: GitDangerZonePanelProps) {
  const { isMobile, onInsertToMessage: onAskAi } = useGitPaneContext();
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
            <p className="text-xs text-muted-foreground">
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
          <RadioGroup
            value={resetUseHead ? 'head' : 'commit'}
            onValueChange={(v) => setResetUseHead(v === 'head')}
            name="reset-target"
            className="flex flex-col gap-1 mb-2"
          >
            <label className="flex items-center gap-1 text-xs text-foreground">
              <RadioGroupItem value="head" data-testid="reset-target-head" />
              HEAD
            </label>
            <label className="flex items-center gap-1 text-xs text-foreground">
              <RadioGroupItem
                value="commit"
                disabled={!selectedCommit}
                data-testid="reset-target-commit"
              />
              Selected commit {selectedCommit ? `(${selectedCommit.slice(0, 7)})` : '(none selected)'}
            </label>
          </RadioGroup>

          {/* Mode radio */}
          <RadioGroup
            value={resetMode}
            onValueChange={(v) => setResetMode(v as GitResetMode)}
            name="reset-mode"
            className="flex flex-col gap-1 mb-2"
          >
            {(['soft', 'mixed', 'hard'] as GitResetMode[]).map((m) => (
              <label key={m} className="flex items-center gap-1 text-xs text-foreground">
                <RadioGroupItem value={m} data-testid={`reset-mode-${m}`} />
                {m}
              </label>
            ))}
          </RadioGroup>

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
                className="w-full px-2 py-1 text-xs border border-red-300 dark:border-red-600 rounded bg-surface dark:bg-surface-2 text-foreground"
                data-testid="reset-hard-branch-input"
              />
            </div>
          )}

          <div className="flex items-center gap-2">
            {onAskAi && (
              <AskAiButton
                className="mr-auto"
                testId="reset-ask-ai"
                disabled={resetTargetMissing}
                onClick={() => {
                  if (!resetTarget) return;
                  onAskAi(resetPrompt(resetMode, resetTarget));
                  setShowResetModal(false);
                  setConfirmBranch('');
                }}
              />
            )}
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
              className="px-2 py-1 text-xs rounded border border-border hover:bg-muted"
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
          <p className="text-xs text-foreground mb-2">
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
          <label className="flex items-center gap-1 text-xs text-foreground mb-2">
            <Checkbox
              checked={revertNoCommit}
              onCheckedChange={(checked) => setRevertNoCommit(checked === true)}
              data-testid="revert-no-commit"
            />
            No commit (leave staged)
          </label>
          <div className="flex items-center gap-2">
            {onAskAi && (
              <AskAiButton
                className="mr-auto"
                testId="revert-ask-ai"
                onClick={() => {
                  onAskAi(revertPrompt(selectedCommit));
                  setShowRevertModal(false);
                  setRevertNoCommit(false);
                }}
              />
            )}
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
              className="px-2 py-1 text-xs rounded border border-border hover:bg-muted"
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
          <label className="flex items-center gap-1 text-xs text-foreground mb-2">
            <Checkbox
              checked={forceWithLease}
              onCheckedChange={(checked) => setForceWithLease(checked === true)}
              data-testid="force-push-with-lease"
            />
            Use --force-with-lease (recommended — refuses if the remote moved)
          </label>
          <div className="flex items-center gap-2">
            {onAskAi && (
              <AskAiButton
                className="mr-auto"
                testId="force-push-ask-ai"
                onClick={() => {
                  onAskAi(forcePushPrompt({ branch: currentBranch, ahead: aheadCount ?? null }));
                  setShowForcePushModal(false);
                }}
              />
            )}
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
              className="px-2 py-1 text-xs rounded border border-border hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

export default GitDangerZonePanel;
