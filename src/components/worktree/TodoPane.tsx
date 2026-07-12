/**
 * TodoPane Component (Issue #1015, 3-state status Issue #1032)
 *
 * Branch (worktree)-scoped ToDo list. Shared by both surfaces:
 *   - PC: Activity Bar `ToDo` activity (WorktreeDetailDesktop.activityContent).
 *   - Mobile: `Tools` tab sub-tab (NotesAndLogsPane).
 *
 * Receives only `worktreeId` and manages its own state via `worktreeTodoApi`.
 * Each item has a three-state status (todo -> doing -> done) surfaced as a
 * colored chip that cycles on click; the header shows per-status counts.
 * Add / delete / reorder (up/down) mirror the Home TodoWidget conventions.
 */

'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  worktreeTodoApi,
  WORKTREE_TODO_STATUSES,
  type WorktreeTodoItem,
  type WorktreeTodoStatus,
} from '@/lib/api/todo-api';
import { MAX_TODO_CONTENT_LENGTH, MAX_TODO_DETAIL_LENGTH } from '@/config/todo-config';
import { Modal } from '@/components/ui/Modal';
import { CopyButton } from '@/components/common/CopyButton';

/**
 * Restyle CopyButton for the light/dark TodoPane modal — its defaults assume a
 * dark code-block surface. `!` wins over the component's own base color classes.
 */
const COPY_DETAIL_BUTTON_CLASS =
  '!border-gray-300 !bg-white !text-gray-600 hover:!bg-gray-50 dark:!border-gray-600 dark:!bg-gray-900 dark:!text-gray-300 dark:hover:!bg-gray-800';

export interface TodoPaneProps {
  /** Worktree ID to scope the todo list to. */
  worktreeId: string;
  /** Additional CSS classes for the root container. */
  className?: string;
}

/** Chip styling per status (border + text/background), light and dark. */
const STATUS_CHIP_CLASS: Record<WorktreeTodoStatus, string> = {
  todo: 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-300',
  doing:
    'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-500/60 dark:bg-amber-500/10 dark:text-amber-300',
  done: 'border-green-500 bg-green-50 text-green-700 dark:border-green-500/60 dark:bg-green-500/10 dark:text-green-300',
};

function nextStatus(status: WorktreeTodoStatus): WorktreeTodoStatus {
  const index = WORKTREE_TODO_STATUSES.indexOf(status);
  return WORKTREE_TODO_STATUSES[(index + 1) % WORKTREE_TODO_STATUSES.length];
}

export const TodoPane = React.memo(function TodoPane({
  worktreeId,
  className = '',
}: TodoPaneProps) {
  const t = useTranslations('worktree');
  const [todos, setTodos] = useState<WorktreeTodoItem[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Item being edited in the modal (title + detail); null when closed (Issue #1034).
  const [editing, setEditing] = useState<WorktreeTodoItem | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editDetail, setEditDetail] = useState('');
  const [saving, setSaving] = useState(false);

  const statusLabel = useCallback(
    (status: WorktreeTodoStatus) => {
      switch (status) {
        case 'doing':
          return t('todo.statusDoing');
        case 'done':
          return t('todo.statusDone');
        default:
          return t('todo.statusTodo');
      }
    },
    [t],
  );

  const loadTodos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await worktreeTodoApi.list(worktreeId);
      setTodos(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('todo.loadError'));
      setTodos([]);
    } finally {
      setLoading(false);
    }
  }, [worktreeId, t]);

  useEffect(() => {
    // Reload only when the worktree changes; loadTodos' identity churns with the
    // translation function, and depending on it would re-fire on every render.
    void loadTodos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId]);

  const handleAdd = useCallback(async () => {
    const content = input.trim();
    if (!content || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const todo = await worktreeTodoApi.create(worktreeId, content);
      setTodos((prev) => [...prev, todo]);
      setInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('todo.addError'));
    } finally {
      setBusy(false);
    }
  }, [input, busy, worktreeId, t]);

  const handleCycleStatus = useCallback(
    async (todo: WorktreeTodoItem) => {
      const next = nextStatus(todo.status);
      // Optimistic update for snappy feedback; `done` derives from status.
      setTodos((prev) =>
        prev.map((item) =>
          item.id === todo.id
            ? { ...item, status: next, done: next === 'done' }
            : item,
        ),
      );
      setError(null);
      try {
        await worktreeTodoApi.update(worktreeId, todo.id, { status: next });
      } catch (err) {
        setError(err instanceof Error ? err.message : t('todo.updateError'));
        void loadTodos();
      }
    },
    [worktreeId, loadTodos, t],
  );

  const handleDelete = useCallback(
    async (todo: WorktreeTodoItem) => {
      setError(null);
      try {
        await worktreeTodoApi.remove(worktreeId, todo.id);
        setTodos((prev) => prev.filter((item) => item.id !== todo.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : t('todo.deleteError'));
      }
    },
    [worktreeId, t],
  );

  const openEditor = useCallback((todo: WorktreeTodoItem) => {
    setEditing(todo);
    setEditContent(todo.content);
    setEditDetail(todo.detail);
    setError(null);
  }, []);

  const closeEditor = useCallback(() => {
    setEditing(null);
    setSaving(false);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editing) {
      return;
    }
    const content = editContent.trim();
    // Title is required (mirrors the add form); detail may be empty.
    if (!content || saving) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await worktreeTodoApi.update(worktreeId, editing.id, {
        content,
        detail: editDetail,
      });
      setTodos((prev) => prev.map((item) => (item.id === editing.id ? updated : item)));
      closeEditor();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('todo.updateError'));
      setSaving(false);
    }
  }, [editing, editContent, editDetail, saving, worktreeId, closeEditor, t]);

  const handleMove = useCallback(
    async (index: number, direction: -1 | 1) => {
      const target = index + direction;
      if (target < 0 || target >= todos.length) {
        return;
      }
      const next = [...todos];
      [next[index], next[target]] = [next[target], next[index]];
      setTodos(next);
      setError(null);
      try {
        await worktreeTodoApi.reorder(worktreeId, next.map((item) => item.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : t('todo.reorderError'));
        void loadTodos();
      }
    },
    [todos, worktreeId, loadTodos, t],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Guard against IME composition (Enter confirms candidate, not submit).
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void handleAdd();
      }
    },
    [handleAdd],
  );

  const counts = useMemo(
    () => ({
      todo: todos.filter((item) => item.status === 'todo').length,
      doing: todos.filter((item) => item.status === 'doing').length,
      done: todos.filter((item) => item.status === 'done').length,
    }),
    [todos],
  );

  return (
    <div
      data-testid="todo-pane"
      className={`flex flex-col h-full overflow-y-auto p-4 ${className}`.trim()}
    >
      {/* Add form */}
      <div className="flex items-center gap-2 mb-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleInputKeyDown}
          maxLength={MAX_TODO_CONTENT_LENGTH}
          placeholder={t('todo.addPlaceholder')}
          data-testid="todo-input"
          className="flex-1 min-w-0 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={busy || input.trim().length === 0}
          data-testid="todo-add-button"
          className="shrink-0 rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-700 disabled:opacity-50"
        >
          {t('todo.add')}
        </button>
      </div>

      {/* Per-status counts */}
      <div className="mb-2 flex justify-end gap-2 text-xs text-gray-400 dark:text-gray-500">
        <span data-testid="todo-count-todo">
          {statusLabel('todo')} {counts.todo}
        </span>
        <span data-testid="todo-count-doing">
          {statusLabel('doing')} {counts.doing}
        </span>
        <span data-testid="todo-count-done">
          {statusLabel('done')} {counts.done}
        </span>
      </div>

      {error && (
        <p className="mb-2 text-xs text-red-600 dark:text-red-400" data-testid="todo-error">
          {error}
        </p>
      )}

      {/* Todo list */}
      {loading ? (
        <p className="text-sm text-gray-400 dark:text-gray-500" data-testid="todo-loading">
          {t('todo.loading')}
        </p>
      ) : todos.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="todo-empty">
          {t('todo.empty')}
        </p>
      ) : (
        <ul className="space-y-1" data-testid="todo-list">
          {todos.map((todo, index) => (
            <li
              key={todo.id}
              className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/40 group"
              data-testid="todo-item"
            >
              <button
                type="button"
                onClick={() => handleCycleStatus(todo)}
                data-testid="todo-status"
                data-status={todo.status}
                aria-label={t('todo.cycleStatus', { status: statusLabel(todo.status) })}
                title={t('todo.cycleStatus', { status: statusLabel(todo.status) })}
                className={`shrink-0 inline-flex min-h-[44px] items-center justify-center rounded-full border px-2 py-0.5 text-xs font-medium sm:min-h-0 ${STATUS_CHIP_CLASS[todo.status]}`}
              >
                {statusLabel(todo.status)}
              </button>
              <button
                type="button"
                onClick={() => openEditor(todo)}
                data-testid="todo-content"
                aria-label={t('todo.edit')}
                title={t('todo.edit')}
                className="group/content flex min-h-[44px] min-w-0 flex-1 items-center gap-1.5 text-left sm:min-h-0"
              >
                <span
                  className={`min-w-0 break-words text-sm ${
                    todo.status === 'done'
                      ? 'line-through text-gray-400 dark:text-gray-500'
                      : 'text-gray-800 dark:text-gray-200 group-hover/content:text-accent-700 dark:group-hover/content:text-accent-300'
                  }`}
                >
                  {todo.content}
                </span>
                {todo.detail.trim() !== '' && (
                  <svg
                    data-testid="todo-detail-indicator"
                    aria-label={t('todo.hasDetail')}
                    className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <title>{t('todo.hasDetail')}</title>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h10" />
                  </svg>
                )}
              </button>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleMove(index, -1)}
                  disabled={index === 0}
                  aria-label={t('todo.moveUp')}
                  data-testid="todo-move-up"
                  className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-30"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => handleMove(index, 1)}
                  disabled={index === todos.length - 1}
                  aria-label={t('todo.moveDown')}
                  data-testid="todo-move-down"
                  className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-30"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(todo)}
                  aria-label={t('todo.delete')}
                  data-testid="todo-delete"
                  className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-gray-300 opacity-100 transition-opacity hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 sm:min-h-0 sm:min-w-0 sm:opacity-0 sm:group-hover:opacity-100"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Edit modal: title + detail (Issue #1034). Reuses the shared Modal. */}
      <Modal
        isOpen={editing !== null}
        onClose={closeEditor}
        title={t('todo.editTitle')}
        size="md"
      >
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              {t('todo.contentLabel')}
            </span>
            <input
              type="text"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              maxLength={MAX_TODO_CONTENT_LENGTH}
              placeholder={t('todo.contentPlaceholder')}
              data-testid="todo-edit-content"
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                {t('todo.detailLabel')}
              </span>
              {editDetail.trim() !== '' && (
                <CopyButton
                  text={editDetail}
                  label={t('todo.copyDetail')}
                  className={COPY_DETAIL_BUTTON_CLASS}
                />
              )}
            </span>
            <textarea
              value={editDetail}
              onChange={(e) => setEditDetail(e.target.value)}
              maxLength={MAX_TODO_DETAIL_LENGTH}
              rows={6}
              placeholder={t('todo.detailPlaceholder')}
              data-testid="todo-edit-detail"
              className="w-full resize-y rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={closeEditor}
              data-testid="todo-edit-cancel"
              className="rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              {t('todo.cancel')}
            </button>
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={saving || editContent.trim().length === 0}
              data-testid="todo-edit-save"
              className="rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-700 disabled:opacity-50"
            >
              {t('todo.save')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
});

export default TodoPane;
