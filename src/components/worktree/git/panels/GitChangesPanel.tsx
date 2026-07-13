/**
 * GitChangesPanel (Issue #780, extracted in #922)
 *
 * Shows three collapsible lists (Staged / Unstaged / Untracked) plus a commit
 * message textarea, an amend checkbox, and commit / commit+push buttons. On
 * mobile the sub-lists default-collapse. `isMobile` is read from GitPaneContext.
 */

'use client';

import { memo, useCallback, useState } from 'react';
import type { ChangedFile, GitStagedResponse } from '@/types/git';
import {
  STATUS_TEXT_COLOR,
  DiffLine,
  RefreshIcon,
  CHANGES_PREVIEW_LINES,
  type ChangesDiffMode,
} from '@/components/worktree/git/gitPaneShared';
import { useGitPaneContext } from '@/components/worktree/git/GitPaneContext';
import { Checkbox, Spinner } from '@/components/ui';

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
  /**
   * Issue #816 (C): fetch the raw working-tree diff text for the inline preview
   * caret. Returns the unified diff (or null on failure / no diff). Distinct from
   * onDiff, which routes the FULL diff through onDiffSelect (the existing modal).
   */
  onPreview: (filePath: string, mode: ChangesDiffMode) => Promise<string | null>;
}

/**
 * A single collapsible list of changed files (Staged / Unstaged / Untracked).
 * Each row shows the status badge, the path, an inline-preview caret
 * (Issue #816, C), a diff button, and a stage/unstage toggle button.
 *
 * Issue #816 (C): the caret expands a short inline preview (first
 * CHANGES_PREVIEW_LINES lines) of the file's unified diff directly under the
 * row. The existing "Diff" button still opens the full diff via onDiffSelect, so
 * the current behavior is preserved.
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
  onPreview,
}: ChangedFileListProps) {
  const [open, setOpen] = useState(defaultOpen);

  // Issue #816 (C): inline preview state. Only one row is previewed at a time.
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const togglePreview = useCallback(
    async (filePath: string) => {
      // Collapse if the same row's caret is clicked again.
      if (previewPath === filePath) {
        setPreviewPath(null);
        setPreviewText(null);
        setPreviewError(null);
        return;
      }
      setPreviewPath(filePath);
      setPreviewText(null);
      setPreviewError(null);
      setPreviewLoading(true);
      try {
        const text = await onPreview(filePath, mode);
        setPreviewText(text ?? '');
      } catch {
        setPreviewError('Failed to load preview');
      } finally {
        setPreviewLoading(false);
      }
    },
    [previewPath, onPreview, mode]
  );

  return (
    <div className="border-t border-border" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <span className="w-4 text-center">{open ? '▼' : '▶'}</span>
        {title} ({files.length})
      </button>
      {open && files.length === 0 && (
        <div className="px-3 py-1.5 text-xs text-muted-foreground">None</div>
      )}
      {open && files.length > 0 && (
        <ul className="divide-y divide-border">
          {files.map((file) => {
            const previewOpen = previewPath === file.path;
            return (
              <li key={`${file.status}:${file.path}`} className="flex flex-col">
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <span className={`inline-block w-16 shrink-0 text-xs font-medium ${STATUS_TEXT_COLOR[file.status]}`}>
                    {file.status}
                  </span>
                  <span className="flex-1 truncate font-mono text-xs text-foreground" title={file.path}>
                    {file.path}
                  </span>
                  <button
                    type="button"
                    onClick={() => togglePreview(file.path)}
                    className="shrink-0 w-5 text-center text-xs text-muted-foreground hover:text-foreground"
                    aria-label={`Toggle diff preview for ${file.path}`}
                    aria-expanded={previewOpen}
                    data-testid="git-changes-preview-toggle"
                  >
                    {previewOpen ? '▼' : '▶'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDiff(file.path, mode)}
                    className="shrink-0 px-1.5 py-0.5 text-xs text-accent-600 dark:text-accent-400 hover:underline"
                    aria-label={`Show diff for ${file.path}`}
                    data-testid="git-changes-diff-button"
                  >
                    Diff
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleStage(file.path)}
                    disabled={busy}
                    className="shrink-0 px-1.5 py-0.5 text-xs rounded border border-input text-foreground hover:bg-muted disabled:opacity-50"
                    aria-label={`${actionLabel} ${file.path}`}
                    data-testid="git-changes-toggle-button"
                  >
                    {actionLabel}
                  </button>
                </div>
                {previewOpen && (
                  <div
                    className="px-3 pb-2 bg-muted/40"
                    data-testid="git-changes-inline-preview"
                  >
                    {previewLoading && (
                      <div className="flex items-center gap-2 py-2" role="status">
                        <Spinner size="xs" variant="accent" />
                        <span className="sr-only">Loading diff preview...</span>
                      </div>
                    )}
                    {previewError && (
                      <div className="py-2 text-xs text-red-600 dark:text-red-400" role="alert">
                        {previewError}
                      </div>
                    )}
                    {!previewLoading && !previewError && previewText !== null && (
                      previewText.trim() === '' ? (
                        <div className="py-2 text-xs text-muted-foreground">No diff available</div>
                      ) : (
                        <div className="overflow-x-auto">
                          <pre className="text-xs">
                            <code>
                              {previewText.split('\n').slice(0, CHANGES_PREVIEW_LINES).map((line, index) => (
                                <DiffLine key={index} line={line} />
                              ))}
                            </code>
                          </pre>
                          {previewText.split('\n').length > CHANGES_PREVIEW_LINES && (
                            <button
                              type="button"
                              onClick={() => onDiff(file.path, mode)}
                              className="mt-1 text-xs text-accent-600 dark:text-accent-400 hover:underline"
                              data-testid="git-changes-preview-more"
                            >
                              … truncated — open full diff
                            </button>
                          )}
                        </div>
                      )
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

export interface GitChangesPanelProps {
  staged: GitStagedResponse | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  commitMessage: string;
  amend: boolean;
  committing: boolean;
  commitError: string | null;
  onRefresh: () => void;
  onDiff: (filePath: string, mode: ChangesDiffMode) => void;
  /** Issue #816 (C): fetch raw working-diff text for the inline preview caret. */
  onPreview: (filePath: string, mode: ChangesDiffMode) => Promise<string | null>;
  onStage: (filePath: string) => void;
  onUnstage: (filePath: string) => void;
  onCommitMessageChange: (value: string) => void;
  onAmendChange: (value: boolean) => void;
  onCommit: () => void;
  /**
   * Issue #816 (A): commit then push in one action. Inherits the same
   * commit-message / amend / staged guards as onCommit (canCommit). Disabled
   * while a network op is in-flight (busy).
   */
  onCommitAndPush: () => void;
}

export const GitChangesPanel = memo(function GitChangesPanel({
  staged,
  loading,
  error,
  busy,
  commitMessage,
  amend,
  committing,
  commitError,
  onRefresh,
  onDiff,
  onPreview,
  onStage,
  onUnstage,
  onCommitMessageChange,
  onAmendChange,
  onCommit,
  onCommitAndPush,
}: GitChangesPanelProps) {
  const { isMobile } = useGitPaneContext();
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
      className="flex flex-col border-b border-border"
      data-testid="git-changes-section"
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-medium text-foreground">Changes</span>
        <button
          type="button"
          onClick={onRefresh}
          className="p-1 text-muted-foreground hover:text-foreground rounded"
          aria-label="Refresh changes"
        >
          <RefreshIcon />
        </button>
      </div>

      {loading && !staged && (
        <div className="flex items-center gap-2 px-3 pb-2" role="status">
          <Spinner size="sm" variant="accent" />
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
            onPreview={onPreview}
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
            onPreview={onPreview}
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
            onPreview={onPreview}
            onToggleStage={onStage}
          />

          {/* Commit form */}
          <div className="flex flex-col gap-2 px-3 py-2 border-t border-border">
            <textarea
              value={commitMessage}
              onChange={(e) => onCommitMessageChange(e.target.value)}
              placeholder="Commit message"
              rows={isMobile ? 2 : 3}
              className="w-full resize-y rounded border border-input bg-surface dark:bg-surface-2 px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid="git-commit-message"
              aria-label="Commit message"
            />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  checked={amend}
                  onCheckedChange={(checked) => onAmendChange(checked === true)}
                  data-testid="git-amend-checkbox"
                />
                Amend
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onCommit}
                  disabled={!canCommit}
                  className="px-3 py-1 text-xs font-medium rounded bg-accent-600 text-white hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="git-commit-button"
                >
                  {committing ? 'Committing...' : 'Commit'}
                </button>
                {/* Issue #816 (A): one-shot commit + push. The push runs only if
                    the commit succeeds; if the push then fails, the commit is
                    already saved (no rollback) — the title makes that explicit. */}
                <button
                  type="button"
                  onClick={onCommitAndPush}
                  disabled={!canCommit || busy}
                  title="Commit, then push. If the push fails the commit is already saved — just retry Push."
                  className="px-3 py-1 text-xs font-medium rounded border border-accent-600 text-accent-700 dark:text-accent-300 hover:bg-accent-50 dark:hover:bg-accent-900/30 disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="git-commit-push-button"
                >
                  Commit + Push
                </button>
              </div>
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

export default GitChangesPanel;
