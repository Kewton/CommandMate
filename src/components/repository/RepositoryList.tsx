/**
 * RepositoryList Component
 *
 * Issue #644: Repository list display and inline display_name edit UI.
 * Issue #690: Adds a Visibility column with a toggle switch that flips
 *             the `visible` flag immediately (optimistic update) and
 *             rolls back + surfaces a feedback banner on failure.
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
 * Visibility independence (Issue #690):
 *   - The toggle controls ONLY `visible`. It must NEVER touch `enabled`.
 *   - `enabled` continues to be governed by the existing disable/restore
 *     flow (Issue #190).
 */

'use client';

import React, { memo, useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card } from '@/components/ui';
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
function RepositoryListInner({ refreshKey, onChanged }: RepositoryListProps) {
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

  if (loading && repositories.length === 0) {
    return (
      <Card padding="lg">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Loading repositories...
        </p>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card padding="lg">
        <div className="space-y-3">
          <p className="text-sm text-red-800 dark:text-red-300">
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
              ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-300'
              : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'
          }`}
        >
          {feedback.message}
        </div>
      )}

      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-gray-700 dark:text-gray-200">
                  Name
                </th>
                <th className="px-4 py-2 text-left font-medium text-gray-700 dark:text-gray-200">
                  Display name
                </th>
                <th className="px-4 py-2 text-left font-medium text-gray-700 dark:text-gray-200">
                  Path
                </th>
                <th className="px-4 py-2 text-left font-medium text-gray-700 dark:text-gray-200">
                  Worktrees
                </th>
                <th className="px-4 py-2 text-left font-medium text-gray-700 dark:text-gray-200">
                  Status
                </th>
                {/* Issue #690: Visibility column with sidebar visibility toggle */}
                <th className="px-4 py-2 text-left font-medium text-gray-700 dark:text-gray-200">
                  Visibility
                </th>
                <th className="px-4 py-2 text-left font-medium text-gray-700 dark:text-gray-200">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {repositories.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-6 text-center text-gray-500 dark:text-gray-400"
                  >
                    No repositories registered yet.
                  </td>
                </tr>
              )}
              {repositories.map((repo) => {
                const isEditing = edit.id === repo.id;
                return (
                  <tr
                    key={repo.id}
                    className="border-b border-gray-100 dark:border-gray-800"
                    data-testid={`repository-row-${repo.id}`}
                  >
                    <td className="px-4 py-3 align-top text-gray-900 dark:text-gray-100">
                      {repo.name}
                    </td>
                    <td className="px-4 py-3 align-top">
                      {isEditing ? (
                        <div className="space-y-1">
                          <input
                            aria-label={`Edit display name for ${repo.name}`}
                            type="text"
                            value={edit.value}
                            disabled={edit.saving}
                            maxLength={MAX_DISPLAY_NAME_LENGTH + 1}
                            onChange={(e) => handleChangeValue(e.target.value)}
                            onKeyDown={(e) => handleKeyDown(e, repo)}
                            className="input w-full text-sm"
                          />
                          {edit.error && (
                            <p className="text-xs text-red-600 dark:text-red-400">
                              {edit.error}
                            </p>
                          )}
                        </div>
                      ) : (
                        <span
                          className={
                            repo.displayName
                              ? 'text-gray-900 dark:text-gray-100'
                              : 'text-gray-400 dark:text-gray-500 italic'
                          }
                        >
                          {repo.displayName ?? '(none)'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top text-xs font-mono text-gray-500 dark:text-gray-400 break-all">
                      {repo.path}
                    </td>
                    <td className="px-4 py-3 align-top text-gray-700 dark:text-gray-300">
                      {repo.worktreeCount}
                    </td>
                    <td className="px-4 py-3 align-top">
                      {repo.enabled ? (
                        <Badge variant="success">Enabled</Badge>
                      ) : (
                        <Badge variant="gray">Disabled</Badge>
                      )}
                    </td>
                    {/* Issue #690: Visibility toggle. Independent of `enabled`. */}
                    <td className="px-4 py-3 align-top">
                      <VisibilityToggle
                        repo={repo}
                        pending={togglingIds.has(repo.id)}
                        onToggle={handleToggleVisibility}
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
                          variant="secondary"
                          size="sm"
                          onClick={() => handleStartEdit(repo)}
                          aria-label={`Edit display name for ${repo.name}`}
                        >
                          Edit
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
      className={`
        inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium
        border transition-colors
        focus:outline-none focus:ring-2 focus:ring-cyan-500
        disabled:opacity-60 disabled:cursor-not-allowed
        ${
          isVisible
            ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 border-green-300 dark:border-green-800'
            : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-700'
        }
      `}
    >
      <span
        aria-hidden="true"
        className={`
          inline-block w-2 h-2 rounded-full
          ${isVisible ? 'bg-green-500' : 'bg-gray-400'}
        `}
      />
      {isVisible ? 'Visible' : 'Hidden'}
    </button>
  );
}

export const RepositoryList = memo(RepositoryListInner);
