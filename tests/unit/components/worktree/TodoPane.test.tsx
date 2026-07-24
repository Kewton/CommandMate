/**
 * Unit tests for the branch-scoped TodoPane (Issue #1015).
 *
 * Verifies the shared component actually renders and drives the worktree ToDo
 * CRUD via `worktreeTodoApi` ([S3-002]: the component must really render, not be
 * silently dropped by the Partial<Record> activityContent map). Covers load,
 * add, toggle, delete, and scope-by-worktreeId.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TodoPane } from '@/components/worktree/TodoPane';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { worktreeTodoApi, type WorktreeTodoItem } from '@/lib/api/todo-api';

// Hoisted so the vi.mock factory (itself hoisted above imports) can reference it.
const { mockCopyToClipboard } = vi.hoisted(() => ({ mockCopyToClipboard: vi.fn() }));

vi.mock('@/lib/api/todo-api', () => ({
  WORKTREE_TODO_STATUSES: ['todo', 'doing', 'done'],
  worktreeTodoApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
  },
}));

// CopyButton delegates to copyToClipboard; mock it so the detail copy is observable.
vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: mockCopyToClipboard,
}));

const mockedApi = vi.mocked(worktreeTodoApi);

const TODOS: WorktreeTodoItem[] = [
  { id: 't1', worktreeId: 'wt-1', content: 'first task', detail: '', status: 'todo', done: false, position: 0 },
  { id: 't2', worktreeId: 'wt-1', content: 'second task', detail: 'some notes', status: 'done', done: true, position: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.list.mockResolvedValue(TODOS);
  mockCopyToClipboard.mockResolvedValue(undefined);
});

/** aria-label the CopyButton exposes for the detail copy action (mocked i18n key). */
const COPY_DETAIL_LABEL = 'worktree.todo.copyDetail';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TodoPane', () => {
  it('renders the todo list loaded for the worktree', async () => {
    render(<TodoPane worktreeId="wt-1" />);

    expect(await screen.findByText('first task')).toBeInTheDocument();
    expect(screen.getByText('second task')).toBeInTheDocument();
    expect(mockedApi.list).toHaveBeenCalledWith('wt-1');
  });

  it('shows the empty state when there are no todos', async () => {
    mockedApi.list.mockResolvedValue([]);
    render(<TodoPane worktreeId="wt-1" />);

    expect(await screen.findByTestId('todo-empty')).toBeInTheDocument();
  });

  it('adds a todo via worktreeTodoApi.create', async () => {
    mockedApi.list.mockResolvedValue([]);
    mockedApi.create.mockResolvedValue({
      id: 't-new',
      worktreeId: 'wt-1',
      content: 'brand new',
      detail: '',
      status: 'todo',
      done: false,
      position: 0,
    });

    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByTestId('todo-empty');

    fireEvent.change(screen.getByTestId('todo-input'), { target: { value: 'brand new' } });
    fireEvent.click(screen.getByTestId('todo-add-button'));

    await waitFor(() => {
      expect(mockedApi.create).toHaveBeenCalledWith('wt-1', 'brand new');
    });
    expect(await screen.findByText('brand new')).toBeInTheDocument();
  });

  it('cycles a todo status (todo -> doing) via worktreeTodoApi.update', async () => {
    mockedApi.update.mockResolvedValue({ ...TODOS[0], status: 'doing' });
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    // t1 starts as 'todo'; one click advances it to 'doing'.
    const statusButtons = screen.getAllByTestId('todo-status');
    fireEvent.click(statusButtons[0]);

    await waitFor(() => {
      expect(mockedApi.update).toHaveBeenCalledWith('wt-1', 't1', { status: 'doing' });
    });
  });

  it('cycles a done todo back to todo via worktreeTodoApi.update', async () => {
    mockedApi.update.mockResolvedValue({ ...TODOS[1], status: 'todo', done: false });
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('second task');

    // t2 starts as 'done'; one click wraps around to 'todo'.
    const statusButtons = screen.getAllByTestId('todo-status');
    fireEvent.click(statusButtons[1]);

    await waitFor(() => {
      expect(mockedApi.update).toHaveBeenCalledWith('wt-1', 't2', { status: 'todo' });
    });
  });

  it('shows per-status counts (todo/doing/done)', async () => {
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    // Fixture: t1 = 'todo', t2 = 'done', none 'doing'.
    expect(screen.getByTestId('todo-count-todo')).toHaveTextContent('1');
    expect(screen.getByTestId('todo-count-doing')).toHaveTextContent('0');
    expect(screen.getByTestId('todo-count-done')).toHaveTextContent('1');
  });

  it('deletes a todo via worktreeTodoApi.remove after the ConfirmDialog is confirmed (Issue #1487)', async () => {
    mockedApi.remove.mockResolvedValue(undefined);
    render(
      <ConfirmProvider>
        <TodoPane worktreeId="wt-1" />
      </ConfirmProvider>,
    );
    await screen.findByText('first task');

    const deleteButtons = screen.getAllByTestId('todo-delete');
    fireEvent.click(deleteButtons[0]);

    // A confirmation dialog must appear before any API call is made.
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(mockedApi.remove).toHaveBeenCalledWith('wt-1', 't1');
    });
    await waitFor(() => {
      expect(screen.queryByText('first task')).not.toBeInTheDocument();
    });
  });

  it('does not delete when the ConfirmDialog is cancelled (Issue #1487)', async () => {
    mockedApi.remove.mockResolvedValue(undefined);
    render(
      <ConfirmProvider>
        <TodoPane worktreeId="wt-1" />
      </ConfirmProvider>,
    );
    await screen.findByText('first task');

    fireEvent.click(screen.getAllByTestId('todo-delete')[0]);
    fireEvent.click(await screen.findByTestId('confirm-dialog-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    });
    expect(mockedApi.remove).not.toHaveBeenCalled();
    // The item is still present because the delete was aborted.
    expect(screen.getByText('first task')).toBeInTheDocument();
  });

  it('reorders todos via worktreeTodoApi.reorder when moving down', async () => {
    mockedApi.reorder.mockResolvedValue(undefined);
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    // Move the first item down -> new order [t2, t1].
    fireEvent.click(screen.getAllByTestId('todo-move-down')[0]);

    await waitFor(() => {
      expect(mockedApi.reorder).toHaveBeenCalledWith('wt-1', ['t2', 't1']);
    });
  });

  it('reloads the authoritative order when reorder fails', async () => {
    mockedApi.reorder.mockRejectedValue(new Error('reorder boom'));
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    fireEvent.click(screen.getAllByTestId('todo-move-down')[0]);

    await waitFor(() => {
      expect(mockedApi.reorder).toHaveBeenCalled();
    });
    // On failure the component re-fetches the authoritative order (rollback).
    await waitFor(() => {
      expect(mockedApi.list).toHaveBeenCalledTimes(2);
    });
  });

  it('shows an error state when the initial load fails', async () => {
    mockedApi.list.mockRejectedValue(new Error('load failed'));
    render(<TodoPane worktreeId="wt-1" />);

    expect(await screen.findByTestId('todo-error')).toHaveTextContent('load failed');
    expect(screen.getByTestId('todo-empty')).toBeInTheDocument();
  });

  it('marks items that have a detail with an indicator (Issue #1034)', async () => {
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    // Fixture: only t2 has a non-empty detail.
    expect(screen.getAllByTestId('todo-detail-indicator')).toHaveLength(1);
  });

  it('opens the edit modal prefilled with content and detail on item click', async () => {
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('second task');

    // t2 is the second item; click its content to open the editor.
    fireEvent.click(screen.getAllByTestId('todo-content')[1]);

    const contentInput = await screen.findByTestId('todo-edit-content');
    const detailInput = screen.getByTestId('todo-edit-detail');
    expect(contentInput).toHaveValue('second task');
    expect(detailInput).toHaveValue('some notes');
  });

  it('saves edited content and detail via worktreeTodoApi.update (Issue #1034)', async () => {
    mockedApi.update.mockResolvedValue({
      ...TODOS[0],
      content: 'first task edited',
      detail: 'brand new detail',
    });
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    fireEvent.click(screen.getAllByTestId('todo-content')[0]);
    await screen.findByTestId('todo-edit-content');

    fireEvent.change(screen.getByTestId('todo-edit-content'), {
      target: { value: 'first task edited' },
    });
    fireEvent.change(screen.getByTestId('todo-edit-detail'), {
      target: { value: 'brand new detail' },
    });
    fireEvent.click(screen.getByTestId('todo-edit-save'));

    await waitFor(() => {
      expect(mockedApi.update).toHaveBeenCalledWith('wt-1', 't1', {
        content: 'first task edited',
        detail: 'brand new detail',
      });
    });
    expect(await screen.findByText('first task edited')).toBeInTheDocument();
  });

  it('does not save when the title is emptied in the editor', async () => {
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    fireEvent.click(screen.getAllByTestId('todo-content')[0]);
    await screen.findByTestId('todo-edit-content');

    fireEvent.change(screen.getByTestId('todo-edit-content'), { target: { value: '   ' } });
    const saveButton = screen.getByTestId('todo-edit-save');
    expect(saveButton).toBeDisabled();
  });

  it('discards edits on cancel without calling update', async () => {
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    fireEvent.click(screen.getAllByTestId('todo-content')[0]);
    await screen.findByTestId('todo-edit-content');

    fireEvent.change(screen.getByTestId('todo-edit-content'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByTestId('todo-edit-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('todo-edit-content')).not.toBeInTheDocument();
    });
    expect(mockedApi.update).not.toHaveBeenCalled();
  });

  it('copies the detail from the editor via CopyButton (Issue #1036)', async () => {
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('second task');

    // t2 carries detail 'some notes'; open its editor.
    fireEvent.click(screen.getAllByTestId('todo-content')[1]);
    await screen.findByTestId('todo-edit-detail');

    fireEvent.click(screen.getByRole('button', { name: COPY_DETAIL_LABEL }));

    await waitFor(() => {
      expect(mockCopyToClipboard).toHaveBeenCalledWith('some notes');
    });
  });

  it('hides the copy button when the edited detail is empty (Issue #1036)', async () => {
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    // t1 has an empty detail; the copy affordance must not appear.
    fireEvent.click(screen.getAllByTestId('todo-content')[0]);
    await screen.findByTestId('todo-edit-content');

    expect(screen.queryByRole('button', { name: COPY_DETAIL_LABEL })).not.toBeInTheDocument();
  });

  it('reveals the copy button once a detail is typed for an empty todo (Issue #1036)', async () => {
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    fireEvent.click(screen.getAllByTestId('todo-content')[0]);
    await screen.findByTestId('todo-edit-detail');
    expect(screen.queryByRole('button', { name: COPY_DETAIL_LABEL })).not.toBeInTheDocument();

    // Copy targets the live editor value, not just the persisted detail.
    fireEvent.change(screen.getByTestId('todo-edit-detail'), { target: { value: 'freshly typed' } });

    fireEvent.click(await screen.findByRole('button', { name: COPY_DETAIL_LABEL }));

    await waitFor(() => {
      expect(mockCopyToClipboard).toHaveBeenCalledWith('freshly typed');
    });
  });
});
