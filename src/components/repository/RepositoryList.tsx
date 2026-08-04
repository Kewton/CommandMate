/**
 * RepositoryList Component
 *
 * Issue #644: Repository list display and inline display_name edit UI.
 * Issue #690: Adds a Visibility column with a toggle switch that flips
 *             the `visible` flag immediately (optimistic update) and
 *             rolls back + surfaces a feedback banner on failure.
 * Issue #1658: Adds a Scan column whose toggle flips `enabled` — the
 *             non-destructive way to take a repository out of the scan set.
 * Issue #1662: Flags rows that are the SAME git repository as another scan root
 *             (sibling worktrees registered separately), and routes the user
 *             from that flag to the Issue #1658 Scan toggle, which is the fix.
 *
 * Renders a table of all registered repositories (enabled & disabled) with
 * inline editing of the display_name (alias). Refetches when `refreshKey`
 * changes, which is bumped by RepositoryManager's add/sync callbacks so the
 * list stays in sync with repository mutations.
 *
 * Client-side concerns:
 * - Enter saves, Escape cancels in edit mode
 * - Empty string / whitespace clears the alias (name falls back for display)
 * - 100 char limit is enforced using MAX_DISPLAY_NAME_LENGTH from
 *   @/config/repository-config (shared with the API route so client and
 *   server stay in sync)
 * - Dark mode support via Tailwind CSS
 *
 * Two toggles, two concepts — do not merge them (Issue #690, Issue #1658):
 *   - The Visibility toggle controls ONLY `visible` (sidebar display). It must
 *     NEVER touch `enabled`.
 *   - The Scan toggle controls ONLY `enabled` (inclusion in `git worktree list`
 *     scans). It must NEVER touch `visible`, so re-enabling gives the user back
 *     their own visibility choice rather than a guess.
 *   Keeping the columns orthogonal is why disabling does not hide the
 *   repository's worktrees from the sidebar; the confirmation body says so, and
 *   points at the Visibility toggle for that.
 *
 * Deliberately NOT wired here: `repositoryApi.delete()` (`DELETE
 * /api/repositories`), which is exclude **and purge** — it kills every tmux
 * session under the repository and deletes its worktree rows together with all
 * their child data. The screen offers only the non-destructive operation.
 */

'use client';

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, Input, Skeleton, StatusDot } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import {
  handleApiError,
  repositoryApi,
  type RepositoryListItem,
} from '@/lib/api-client';
import { MAX_DISPLAY_NAME_LENGTH } from '@/config/repository-config';

export interface RepositoryListProps {
  /** Incrementing value that triggers a refetch when changed. */
  refreshKey: number;
  /**
   * Called after a successful display_name update (e.g. to refresh other
   * screens via parent state). Optional.
   */
  onChanged?: () => void;
}

interface EditState {
  /** Repository ID currently being edited, or null when no row is in edit mode. */
  id: string | null;
  /** Draft value in the input box. */
  value: string;
  /** Validation error, or null when the draft is valid. */
  error: string | null;
  /** Save-in-progress flag. */
  saving: boolean;
}

const INITIAL_EDIT: EditState = {
  id: null,
  value: '',
  error: null,
  saving: false,
};

/**
 * Which rows the table shows (Issue #1658).
 *
 * `disabled` answers "what did I take out of the scan set?" — the list the
 * Issue asks for. It filters the rows already loaded by `GET /api/repositories`
 * (which returns enabled AND disabled repositories) rather than calling
 * `GET /api/repositories/excluded`: that endpoint returns a strict subset of
 * the same rows, so wiring it here would mean two sources of truth for one
 * table and a second round trip for data already in hand.
 */
type RepositoryFilter = 'all' | 'disabled';

/**
 * Repository list with inline alias editing.
 *
 * @example
 * ```tsx
 * const [refreshKey, setRefreshKey] = useState(0);
 * <RepositoryList
 *   refreshKey={refreshKey}
 *   onChanged={() => setRefreshKey((k) => k + 1)}
 * />
 * ```
 */
/** Shared by the loaded table and the loading skeleton (Issue #1118). */
function RepositoryTableHead() {
  return (
    <thead className="bg-muted border-b border-border">
      <tr>
        <th className="px-4 py-2 text-left font-medium text-foreground">
          Name
        </th>
        <th className="px-4 py-2 text-left font-medium text-foreground">
          Display name
        </th>
        {/* Issue #690: Visibility column placed before Path so it is always reachable on narrow screens */}
        <th className="px-4 py-2 text-left font-medium text-foreground">
          Visibility
        </th>
        <th className="px-4 py-2 text-left font-medium text-foreground">
          Path
        </th>
        <th className="px-4 py-2 text-left font-medium text-foreground">
          Worktrees
        </th>
        {/* Issue #1658: was a read-only "Status" cell; the same enabled flag is
            now the Scan toggle, so the header names what it controls. */}
        <th className="px-4 py-2 text-left font-medium text-foreground">
          Scan
        </th>
        <th className="px-4 py-2 text-left font-medium text-foreground">
          Actions
        </th>
      </tr>
    </thead>
  );
}

function RepositoryListInner({ refreshKey, onChanged }: RepositoryListProps) {
  const t = useTranslations('common');
  const [repositories, setRepositories] = useState<RepositoryListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>(INITIAL_EDIT);
  const [feedback, setFeedback] = useState<
    { type: 'success' | 'error'; message: string } | null
  >(null);
  // Issue #690: Track which rows currently have a visibility toggle in flight
  // so we can disable the control to prevent double-clicks and to render a
  // pending state. Uses a Set keyed by repository ID.
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  // Issue #1658: same idea for the Scan toggle, tracked separately so a
  // visibility request in flight never greys out the scan control (or the
  // other way round) on the same row.
  const [scanPendingIds, setScanPendingIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<RepositoryFilter>('all');
  /** Row awaiting confirmation of a disable, or null when no dialog is open. */
  const [pendingDisable, setPendingDisable] = useState<RepositoryListItem | null>(null);
  /**
   * Scan toggles by repository id (Issue #1662), so the duplicate badge can
   * hand focus to the control that resolves what it is warning about. Telling
   * someone "two roots are the same repository" is only useful if the fix is
   * one keystroke away.
   */
  const scanToggleRefs = useRef(new Map<string, HTMLButtonElement | null>());

  const registerScanToggle = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) {
      scanToggleRefs.current.set(id, node);
    } else {
      scanToggleRefs.current.delete(id);
    }
  }, []);

  const focusScanToggle = useCallback((id: string) => {
    scanToggleRefs.current.get(id)?.focus();
  }, []);

  const fetchRepositories = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await repositoryApi.list();
      setRepositories(response.repositories);
    } catch (err) {
      setLoadError(handleApiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRepositories();
  }, [fetchRepositories, refreshKey]);

  const handleStartEdit = useCallback((repo: RepositoryListItem) => {
    setEdit({
      id: repo.id,
      value: repo.displayName ?? '',
      error: null,
      saving: false,
    });
    setFeedback(null);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEdit(INITIAL_EDIT);
  }, []);

  const handleChangeValue = useCallback((value: string) => {
    setEdit((prev) => {
      if (prev.id === null) {
        return prev;
      }
      const error =
        value.length > MAX_DISPLAY_NAME_LENGTH
          ? `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or less`
          : null;
      return { ...prev, value, error };
    });
  }, []);

  const handleSave = useCallback(
    async (repo: RepositoryListItem) => {
      const trimmed = edit.value.trim();

      if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
        setEdit((prev) => ({
          ...prev,
          error: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or less`,
        }));
        return;
      }

      setEdit((prev) => ({ ...prev, saving: true, error: null }));

      try {
        // Empty string clears the alias (API normalizes empty string to null).
        const payload = trimmed.length === 0 ? null : trimmed;
        const result = await repositoryApi.updateDisplayName(repo.id, payload);

        // Merge the returned row (no worktreeCount) back into state, preserving
        // the local worktreeCount so the row count badge does not flicker.
        setRepositories((prev) =>
          prev.map((r) =>
            r.id === repo.id
              ? { ...r, ...result.repository }
              : r
          )
        );
        setEdit(INITIAL_EDIT);
        setFeedback({ type: 'success', message: 'Display name updated' });
        if (onChanged) {
          onChanged();
        }
      } catch (err) {
        // Resolve the error message once and reuse it for both the inline
        // editor error and the top-level feedback banner to keep the two
        // surfaces in sync and avoid calling handleApiError twice.
        const errorMessage = handleApiError(err);
        setEdit((prev) => ({
          ...prev,
          saving: false,
          error: errorMessage,
        }));
        setFeedback({ type: 'error', message: errorMessage });
      }
    },
    [edit.value, onChanged]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>, repo: RepositoryListItem) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void handleSave(repo);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        handleCancelEdit();
      }
    },
    [handleCancelEdit, handleSave]
  );

  /**
   * Toggle the sidebar visibility for a single repository (Issue #690).
   *
   * Optimistic update flow:
   *   1. Flip the row in local state immediately.
   *   2. PUT /api/repositories/[id] { visible }.
   *   3. On success: replace the row with the API response (preserves
   *      worktreeCount because the API does not return it).
   *   4. On failure: roll back the local change and surface a feedback
   *      banner with the API error message.
   */
  const handleToggleVisibility = useCallback(
    async (repo: RepositoryListItem) => {
      // Prevent double-clicks while a request is in flight for this row.
      if (togglingIds.has(repo.id)) {
        return;
      }

      const nextVisible = !repo.visible;
      const previousRepo = repo;

      // Mark in-flight
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.add(repo.id);
        return next;
      });

      // Optimistic local update
      setRepositories((prev) =>
        prev.map((r) =>
          r.id === repo.id ? { ...r, visible: nextVisible } : r
        )
      );
      setFeedback(null);

      try {
        const result = await repositoryApi.updateVisibility(repo.id, nextVisible);

        // Merge API response while preserving worktreeCount.
        setRepositories((prev) =>
          prev.map((r) =>
            r.id === repo.id ? { ...r, ...result.repository } : r
          )
        );

        if (onChanged) {
          onChanged();
        }
      } catch (err) {
        // Rollback the optimistic update
        setRepositories((prev) =>
          prev.map((r) => (r.id === repo.id ? { ...previousRepo } : r))
        );
        setFeedback({ type: 'error', message: handleApiError(err) });
      } finally {
        setTogglingIds((prev) => {
          const next = new Set(prev);
          next.delete(repo.id);
          return next;
        });
      }
    },
    [onChanged, togglingIds]
  );

  /**
   * Mark / unmark a row as having a scan-flag request in flight.
   */
  const setScanPending = useCallback((id: string, pending: boolean) => {
    setScanPendingIds((prev) => {
      const next = new Set(prev);
      if (pending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  /**
   * Take a repository out of the scan set (Issue #1658).
   *
   * Non-destructive by construction: the request is a one-column PUT. No
   * worktree row is deleted, no child data (chat history, tasks, verification
   * runs, …) is touched, and no tmux session is killed — sessions under this
   * repository keep running, which is what the confirmation body promises.
   *
   * Not optimistic: the user has just confirmed a dialog, so a flip that has to
   * roll back would read as the dialog having lied. The row moves only once the
   * server has agreed.
   */
  const applyDisable = useCallback(
    async (repo: RepositoryListItem) => {
      setScanPending(repo.id, true);
      setFeedback(null);

      try {
        const result = await repositoryApi.updateEnabled(repo.id, false);
        setRepositories((prev) =>
          prev.map((r) => {
            // Issue #1662: an excluded root is no longer scanned, so it is no
            // longer half of a duplicate — for itself OR for its partners. The
            // parent screen also bumps `refreshKey` (which refetches the
            // authoritative flags), but the row the user was just looking at
            // must not keep claiming a conflict that the click resolved.
            if (r.id === repo.id) {
              return { ...r, ...result.repository, duplicateOf: [] };
            }
            const remaining = (r.duplicateOf ?? []).filter((p) => p !== repo.path);
            return remaining.length === (r.duplicateOf ?? []).length
              ? r
              : { ...r, duplicateOf: remaining };
          })
        );
        setFeedback({
          type: 'success',
          message: t('repositories.disableSuccess', { name: repo.name }),
        });
        if (onChanged) {
          onChanged();
        }
      } catch (err) {
        setFeedback({ type: 'error', message: handleApiError(err) });
      } finally {
        setScanPending(repo.id, false);
      }
    },
    [onChanged, setScanPending, t]
  );

  /**
   * Put a repository back into the scan set (Issue #1658).
   *
   * Uses `PUT /api/repositories/restore` rather than the plain `enabled: true`
   * PUT because restore also re-scans the repository, so its worktrees are back
   * in the list on the same click instead of after the next Sync All. The
   * response carries no repository row, hence the refetch.
   */
  const applyEnable = useCallback(
    async (repo: RepositoryListItem) => {
      setScanPending(repo.id, true);
      setFeedback(null);

      try {
        const result = await repositoryApi.restore(repo.path);
        await fetchRepositories();
        setFeedback({
          type: result.warning ? 'error' : 'success',
          message:
            result.warning ??
            t('repositories.enableSuccess', {
              name: repo.name,
              count: result.worktreeCount,
            }),
        });
        if (onChanged) {
          onChanged();
        }
      } catch (err) {
        setFeedback({ type: 'error', message: handleApiError(err) });
      } finally {
        setScanPending(repo.id, false);
      }
    },
    [fetchRepositories, onChanged, setScanPending, t]
  );

  /**
   * Scan toggle click handler. Disabling asks first (it changes what the app
   * discovers); enabling does not (it only adds back).
   */
  const handleToggleScan = useCallback(
    (repo: RepositoryListItem) => {
      if (scanPendingIds.has(repo.id)) {
        return;
      }
      if (repo.enabled) {
        setPendingDisable(repo);
        return;
      }
      void applyEnable(repo);
    },
    [applyEnable, scanPendingIds]
  );

  const handleConfirmDisable = useCallback(() => {
    const target = pendingDisable;
    setPendingDisable(null);
    if (target) {
      void applyDisable(target);
    }
  }, [applyDisable, pendingDisable]);

  const disabledCount = useMemo(
    () => repositories.filter((r) => !r.enabled).length,
    [repositories]
  );

  const visibleRows = useMemo(
    () => (filter === 'disabled' ? repositories.filter((r) => !r.enabled) : repositories),
    [filter, repositories]
  );

  if (loading && repositories.length === 0) {
    // [Issue #1118] First-load skeleton: real table header + placeholder rows
    // so the loaded table appears without a layout shift.
    return (
      <Card padding="none">
        <div
          className="overflow-x-auto"
          data-testid="repository-list-loading"
          role="status"
          aria-label={t('repositories.loading')}
        >
          <table className="min-w-full text-sm">
            <RepositoryTableHead />
            <tbody>
              {[0, 1, 2].map((i) => (
                <tr key={i} className="border-b border-border">
                  <td className="px-4 py-3 align-top"><Skeleton className="h-4 w-24" /></td>
                  <td className="px-4 py-3 align-top"><Skeleton className="h-4 w-20" /></td>
                  <td className="px-4 py-3 align-top"><Skeleton className="h-4 w-16" /></td>
                  <td className="px-4 py-3 align-top"><Skeleton className="h-4 w-48" /></td>
                  <td className="px-4 py-3 align-top"><Skeleton className="h-4 w-10" /></td>
                  <td className="px-4 py-3 align-top"><Skeleton className="h-4 w-14" /></td>
                  <td className="px-4 py-3 align-top"><Skeleton className="h-4 w-20" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card padding="lg">
        <div className="space-y-3">
          <p className="text-sm text-danger-foreground">
            Failed to load repositories: {loadError}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void fetchRepositories()}>
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {feedback && (
        <div
          role="status"
          className={`p-3 rounded-lg text-sm ${
            feedback.type === 'success'
              ? 'bg-success-subtle border border-success-border text-success-foreground'
              : 'bg-danger-subtle border border-danger-border text-danger-foreground'
          }`}
        >
          {feedback.message}
        </div>
      )}

      {/* Issue #1658: the "what have I excluded?" list. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={filter === 'all' ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={filter === 'all'}
          data-testid="repository-filter-all"
          onClick={() => setFilter('all')}
        >
          {t('repositories.filterAll', { count: repositories.length })}
        </Button>
        <Button
          variant={filter === 'disabled' ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={filter === 'disabled'}
          data-testid="repository-filter-disabled"
          onClick={() => setFilter('disabled')}
        >
          {t('repositories.filterDisabled', { count: disabledCount })}
        </Button>
      </div>

      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <RepositoryTableHead />
            <tbody>
              {visibleRows.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-6 text-center text-muted-foreground"
                  >
                    {filter === 'disabled'
                      ? t('repositories.emptyDisabled')
                      : t('repositories.empty')}
                  </td>
                </tr>
              )}
              {visibleRows.map((repo) => {
                const isEditing = edit.id === repo.id;
                return (
                  <tr
                    key={repo.id}
                    className={cn(
                      'border-b border-border',
                      // Excluded rows read as inactive without hiding anything.
                      !repo.enabled && 'bg-muted/40'
                    )}
                    data-testid={`repository-row-${repo.id}`}
                  >
                    {/* Issue #1662: the duplicate-scan-root warning hangs off
                        the name, which is what a user scans the table by. */}
                    <td className="px-4 py-3 align-top text-foreground">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {repo.name}
                        <DuplicateScanRootBadge
                          repo={repo}
                          onNavigateToScanToggle={focusScanToggle}
                        />
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      {isEditing ? (
                        <div className="space-y-1">
                          <Input
                            aria-label={`Edit display name for ${repo.name}`}
                            type="text"
                            value={edit.value}
                            disabled={edit.saving}
                            maxLength={MAX_DISPLAY_NAME_LENGTH + 1}
                            onChange={(e) => handleChangeValue(e.target.value)}
                            onKeyDown={(e) => handleKeyDown(e, repo)}
                          />
                          {edit.error && (
                            <p className="text-xs text-danger-foreground">
                              {edit.error}
                            </p>
                          )}
                        </div>
                      ) : repo.displayName ? (
                        <span className="text-foreground">{repo.displayName}</span>
                      ) : (
                        <span className="text-muted-foreground" aria-hidden="true">
                          &mdash;
                        </span>
                      )}
                    </td>
                    {/* Issue #690: Visibility toggle placed before Path for narrow-screen accessibility */}
                    <td className="px-4 py-3 align-top">
                      <VisibilityToggle
                        repo={repo}
                        pending={togglingIds.has(repo.id)}
                        onToggle={handleToggleVisibility}
                      />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span
                        className="block max-w-[240px] truncate font-mono text-xs text-muted-foreground"
                        title={repo.path}
                      >
                        {repo.path}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top text-foreground">
                      {repo.worktreeCount}
                    </td>
                    {/* Issue #1658: the scan-inclusion flag, now interactive. */}
                    <td className="px-4 py-3 align-top">
                      <ScanToggle
                        repo={repo}
                        pending={scanPendingIds.has(repo.id)}
                        onToggle={handleToggleScan}
                        registerRef={registerScanToggle}
                      />
                    </td>
                    <td className="px-4 py-3 align-top">
                      {isEditing ? (
                        <div className="flex gap-2">
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => void handleSave(repo)}
                            disabled={edit.saving || edit.error !== null}
                          >
                            {edit.saving ? 'Saving...' : 'Save'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleCancelEdit}
                            disabled={edit.saving}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="px-2"
                          onClick={() => handleStartEdit(repo)}
                          aria-label={`Edit display name for ${repo.name}`}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/*
        Issue #1658: disabling is confirmed, and the body spells out what the
        operation does NOT do. Users arriving here have only ever known
        "removing a repository" as the purging DELETE, so the promise that
        history and running sessions survive has to be made explicitly.
        variant="default", not "danger": nothing is destroyed.
      */}
      <ConfirmDialog
        isOpen={pendingDisable !== null}
        title={t('repositories.disableConfirmTitle')}
        description={t('repositories.disableConfirmBody', {
          name: pendingDisable?.name ?? '',
          count: pendingDisable?.worktreeCount ?? 0,
        })}
        confirmLabel={t('repositories.disableConfirmAction')}
        variant="default"
        onConfirm={handleConfirmDisable}
        onCancel={() => setPendingDisable(null)}
      />
    </div>
  );
}

/**
 * VisibilityToggle (Issue #690)
 *
 * Renders an accessible switch button that flips the sidebar visibility
 * for the given repository. The button uses `role="switch"` and
 * `aria-checked` so screen readers announce the toggle state. While a
 * request is in flight (`pending`), the button is disabled and shows a
 * subtle visual cue.
 *
 * NOTE on accessibility: per ARIA, `role="switch"` uses `aria-checked`
 * (not `aria-pressed`). `aria-pressed` is for `role="button"` toggles.
 */
function VisibilityToggle({
  repo,
  pending,
  onToggle,
}: {
  repo: RepositoryListItem;
  pending: boolean;
  onToggle: (repo: RepositoryListItem) => void;
}) {
  const isVisible = repo.visible;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isVisible}
      aria-label={
        isVisible
          ? `Hide ${repo.name} from sidebar`
          : `Show ${repo.name} in sidebar`
      }
      data-testid={`visibility-toggle-${repo.id}`}
      onClick={() => onToggle(repo)}
      disabled={pending}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
        'text-muted-foreground transition-colors',
        'hover:bg-muted hover:text-foreground',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:opacity-60 disabled:cursor-not-allowed'
      )}
    >
      <StatusDot
        status={isVisible ? 'ready' : 'idle'}
        size="sm"
        label={isVisible ? 'Visible' : 'Hidden'}
        aria-hidden="true"
      />
      {isVisible ? 'Visible' : 'Hidden'}
    </button>
  );
}

/**
 * ScanToggle (Issue #1658)
 *
 * Flips `enabled` — whether this repository is scanned for worktrees at all.
 * Deliberately shaped like {@link VisibilityToggle} but never confusable with
 * it: different column, different wording (Enabled/Disabled vs Visible/Hidden),
 * different aria-label, and its own `data-testid` prefix. Both are switches, so
 * `role="switch"` + `aria-checked` per ARIA (`aria-pressed` is for
 * `role="button"`).
 *
 * The click does not itself mutate anything — turning scanning OFF routes
 * through a confirmation first (see `handleToggleScan`).
 */
function ScanToggle({
  repo,
  pending,
  onToggle,
  registerRef,
}: {
  repo: RepositoryListItem;
  pending: boolean;
  onToggle: (repo: RepositoryListItem) => void;
  /** Issue #1662: lets the duplicate badge hand focus to this control. */
  registerRef: (id: string, node: HTMLButtonElement | null) => void;
}) {
  const isEnabled = repo.enabled;
  return (
    <button
      ref={(node) => registerRef(repo.id, node)}
      type="button"
      role="switch"
      aria-checked={isEnabled}
      aria-label={
        isEnabled
          ? `Exclude ${repo.name} from repository scans`
          : `Include ${repo.name} in repository scans`
      }
      data-testid={`scan-toggle-${repo.id}`}
      onClick={() => onToggle(repo)}
      disabled={pending}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
        'text-muted-foreground transition-colors',
        'hover:bg-muted hover:text-foreground',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:opacity-60 disabled:cursor-not-allowed'
      )}
    >
      <StatusDot
        status={isEnabled ? 'ready' : 'idle'}
        size="sm"
        label={isEnabled ? 'Enabled' : 'Disabled'}
        aria-hidden="true"
      />
      {isEnabled ? 'Enabled' : 'Disabled'}
    </button>
  );
}

/**
 * DuplicateScanRootBadge (Issue #1662)
 *
 * Marks a row whose scan root is the SAME git repository as another registered
 * root — i.e. two worktrees of one repository registered separately. Both roots
 * enumerate the same worktrees, so every sync upserts each of them twice and
 * `worktrees.repository_path` alternates between the roots; that configuration
 * is what produced the #1659 ID churn.
 *
 * It is a BUTTON, not a static badge, because the fix is one column to the
 * right: pressing it moves focus to this row's Scan toggle (Issue #1658), which
 * takes the root out of the scan set without deleting anything. A warning whose
 * remedy the user has to go find is a warning most people ignore.
 *
 * Renders nothing when there is no duplicate, which is the normal case — two
 * worktrees of two DIFFERENT repositories never land here.
 */
function DuplicateScanRootBadge({
  repo,
  onNavigateToScanToggle,
}: {
  repo: RepositoryListItem;
  onNavigateToScanToggle: (id: string) => void;
}) {
  const t = useTranslations('common');
  const duplicates = repo.duplicateOf ?? [];

  if (duplicates.length === 0) {
    return null;
  }

  // The visible label has to stay short enough to sit next to a name, so the
  // paths — the part that actually identifies the other root — are carried by
  // the accessible name and the tooltip rather than being truncated away.
  const detail = t('repositories.duplicateRowDetail', { paths: duplicates.join(', ') });

  return (
    <button
      type="button"
      data-testid={`duplicate-scan-root-${repo.id}`}
      onClick={() => onNavigateToScanToggle(repo.id)}
      title={detail}
      aria-label={detail}
      className={cn(
        'rounded-full',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
    >
      <Badge variant="warning">{t('repositories.duplicateRowBadge')}</Badge>
    </button>
  );
}

export const RepositoryList = memo(RepositoryListInner);
