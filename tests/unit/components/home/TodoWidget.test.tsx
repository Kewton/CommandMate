/**
 * Unit tests for the Home TodoWidget (Issue #907).
 *
 * Verifies the cross-repository behavior:
 * - the list is loaded via todoApi.listAll() (not scoped to the dropdown),
 * - changing the dropdown does NOT refetch/filter the list,
 * - toggle/delete operate on each todo's own repositoryId,
 * - add uses the selected dropdown repository and refreshes via listAll().
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TodoWidget } from '@/components/home/TodoWidget';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { todoApi, type TodoItem } from '@/lib/api/todo-api';

// Issue #1274: this component's wording resolves through the `home` namespace.
// Back it with the real dictionary so the English assertions prove the keys
// exist rather than echoing the global mock.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('@/lib/api/todo-api', () => ({
  todoApi: {
    list: vi.fn(),
    listAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));

const mockedApi = vi.mocked(todoApi);

const REPOS = [
  { id: 'repo-a', path: '/path/a', name: 'Alpha' },
  { id: 'repo-b', path: '/path/b', name: 'Beta' },
];

const TODOS: TodoItem[] = [
  {
    id: 't1',
    repositoryId: 'repo-a',
    repositoryName: 'Alpha',
    content: 'alpha task',
    done: false,
    position: 0,
  },
  {
    id: 't2',
    repositoryId: 'repo-b',
    repositoryName: 'Beta',
    content: 'beta task',
    done: false,
    position: 0,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/worktrees')) {
      return { ok: true, json: async () => ({ repositories: REPOS }) } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
  mockedApi.listAll.mockResolvedValue(TODOS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TodoWidget (Issue #907)', () => {
  it('loads all todos via listAll and shows todos from every repository', async () => {
    render(<TodoWidget />);

    await waitFor(() => expect(mockedApi.listAll).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('alpha task')).toBeInTheDocument();
    expect(screen.getByText('beta task')).toBeInTheDocument();
    expect(mockedApi.list).not.toHaveBeenCalled();

    // Each row carries a repository badge for cross-repo disambiguation.
    const badges = screen
      .getAllByTestId('todo-repo-badge')
      .map((b) => b.textContent);
    expect(badges).toContain('Alpha');
    expect(badges).toContain('Beta');
  });

  it('does not refetch/filter the list when the target repository dropdown changes', async () => {
    render(<TodoWidget />);
    await waitFor(() => expect(mockedApi.listAll).toHaveBeenCalledTimes(1));
    await screen.findByText('alpha task');

    const select = screen.getByTestId('todo-repo-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'repo-b' } });

    // The list stays fully populated and listAll is not called again.
    expect(mockedApi.listAll).toHaveBeenCalledTimes(1);
    expect(mockedApi.list).not.toHaveBeenCalled();
    expect(screen.getByText('alpha task')).toBeInTheDocument();
    expect(screen.getByText('beta task')).toBeInTheDocument();
  });

  it('toggles a todo using its own repositoryId', async () => {
    mockedApi.update.mockResolvedValue(TODOS[1]);
    render(<TodoWidget />);
    await screen.findByText('beta task');

    // Second checkbox corresponds to the Beta (repo-b) todo.
    const checkboxes = screen.getAllByTestId('todo-checkbox');
    fireEvent.click(checkboxes[1]);

    await waitFor(() =>
      expect(mockedApi.update).toHaveBeenCalledWith('repo-b', 't2', { done: true }),
    );
  });

  it('deletes a todo using its own repositoryId after confirmation (Issue #1487)', async () => {
    mockedApi.remove.mockResolvedValue(undefined);
    render(
      <ConfirmProvider>
        <TodoWidget />
      </ConfirmProvider>,
    );
    await screen.findByText('alpha task');

    // First delete button corresponds to the Alpha (repo-a) todo.
    const deleteButtons = screen.getAllByTestId('todo-delete');
    fireEvent.click(deleteButtons[0]);
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

    await waitFor(() =>
      expect(mockedApi.remove).toHaveBeenCalledWith('repo-a', 't1'),
    );
  });

  it('does not delete a todo when the ConfirmDialog is cancelled (Issue #1487)', async () => {
    mockedApi.remove.mockResolvedValue(undefined);
    render(
      <ConfirmProvider>
        <TodoWidget />
      </ConfirmProvider>,
    );
    await screen.findByText('alpha task');

    fireEvent.click(screen.getAllByTestId('todo-delete')[0]);
    fireEvent.click(await screen.findByTestId('confirm-dialog-cancel'));

    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(mockedApi.remove).not.toHaveBeenCalled();
    expect(screen.getByText('alpha task')).toBeInTheDocument();
  });

  it('creates a todo for the selected dropdown repository and refreshes via listAll', async () => {
    mockedApi.create.mockResolvedValue(TODOS[1]);
    render(<TodoWidget />);
    await waitFor(() => expect(mockedApi.listAll).toHaveBeenCalledTimes(1));
    await screen.findByText('alpha task');

    const select = screen.getByTestId('todo-repo-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'repo-b' } });

    const input = screen.getByTestId('todo-input');
    fireEvent.change(input, { target: { value: 'new task' } });
    fireEvent.click(screen.getByTestId('todo-add-button'));

    await waitFor(() =>
      expect(mockedApi.create).toHaveBeenCalledWith('repo-b', 'new task'),
    );
    // The post-add refresh re-uses the cross-repo listAll, never the per-repo list.
    await waitFor(() => expect(mockedApi.listAll).toHaveBeenCalledTimes(2));
    expect(mockedApi.list).not.toHaveBeenCalled();
  });
});

describe('TodoWidget mobile layout (Issue #909)', () => {
  it('keeps the delete button visible on mobile and hover-reveal only on desktop', async () => {
    render(<TodoWidget />);
    await screen.findByText('alpha task');

    for (const btn of screen.getAllByTestId('todo-delete')) {
      const classes = btn.className.split(/\s+/);
      // Always visible on touch screens (no :hover available).
      expect(classes).toContain('opacity-100');
      // Hover-reveal restored only at >= sm so desktop is unchanged.
      expect(classes).toContain('sm:opacity-0');
      expect(classes).toContain('sm:group-hover:opacity-100');
      // Must NOT carry the pre-#909 mobile-hiding tokens.
      expect(classes).not.toContain('opacity-0');
      expect(classes).not.toContain('group-hover:opacity-100');
    }
  });

  it('renders rows as a responsive two-row (mobile) / single-row (desktop) layout', async () => {
    render(<TodoWidget />);
    await screen.findByText('alpha task');

    for (const item of screen.getAllByTestId('todo-item')) {
      const classes = item.className.split(/\s+/);
      expect(classes).toContain('flex-col'); // stacked on mobile
      expect(classes).toContain('sm:flex-row'); // single row on desktop
    }
  });

  it('gives the checkbox and delete button a ~44px touch target on mobile', async () => {
    render(<TodoWidget />);
    await screen.findByText('alpha task');

    for (const btn of screen.getAllByTestId('todo-delete')) {
      const classes = btn.className.split(/\s+/);
      expect(classes).toContain('min-h-[44px]');
      expect(classes).toContain('min-w-[44px]');
      // Compact again on desktop so the single row stays tight.
      expect(classes).toContain('sm:min-h-0');
      expect(classes).toContain('sm:min-w-0');
    }

    for (const cb of screen.getAllByTestId('todo-checkbox')) {
      const label = cb.closest('label');
      expect(label).not.toBeNull();
      const classes = label!.className.split(/\s+/);
      expect(classes).toContain('min-h-[44px]');
      expect(classes).toContain('min-w-[44px]');
      expect(classes).toContain('sm:min-h-0');
      expect(classes).toContain('sm:min-w-0');
    }
  });

  it('stacks the repository selector row on mobile and aligns it on desktop', async () => {
    render(<TodoWidget />);
    await screen.findByText('alpha task');

    const classes = screen.getByTestId('todo-selector-row').className.split(/\s+/);
    expect(classes).toContain('flex-col');
    expect(classes).toContain('sm:flex-row');
  });

  it('still toggles and deletes via each todo own repositoryId after the layout change', async () => {
    mockedApi.update.mockResolvedValue(TODOS[1]);
    mockedApi.remove.mockResolvedValue(undefined);
    render(
      <ConfirmProvider>
        <TodoWidget />
      </ConfirmProvider>,
    );
    await screen.findByText('beta task');

    fireEvent.click(screen.getAllByTestId('todo-checkbox')[1]);
    await waitFor(() =>
      expect(mockedApi.update).toHaveBeenCalledWith('repo-b', 't2', { done: true }),
    );

    fireEvent.click(screen.getAllByTestId('todo-delete')[0]);
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() =>
      expect(mockedApi.remove).toHaveBeenCalledWith('repo-a', 't1'),
    );
  });

  it('shows skeleton rows while loading, then the loaded list (Issue #1118)', async () => {
    let resolveList!: (todos: TodoItem[]) => void;
    mockedApi.listAll.mockReturnValue(
      new Promise<TodoItem[]>((resolve) => {
        resolveList = resolve;
      }),
    );

    render(<TodoWidget />);

    // While listAll is pending: pulse skeleton rows, no naked "Loading…" text
    const loading = await screen.findByTestId('todo-loading');
    expect(loading.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText('Loading…')).toBeNull();

    resolveList(TODOS);

    expect(await screen.findByText('alpha task')).toBeInTheDocument();
    expect(screen.queryByTestId('todo-loading')).toBeNull();
  });
});
