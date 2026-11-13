/**
 * Issue #4345 1c-2: the page's file operations (create file / directory, rename, delete, move,
 * upload) when the page's registration is lapsed (another entry's 401 was taken): the gate refuses
 * them before they leave (`HandoffPageOperationRefusedError`, nothing sent). The callers show no
 * failure (no alert, no toast), send nothing (fetch 0), and keep what the person entered (the
 * new-file dialog comes back, the move dialog stays).
 *
 * Positive controls: red before 1c-2 (the refusal was told as "failed to create / rename / ..."),
 * negative controls: an ordinary failure (500) is still told as before.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewFileDialog } from '@/components/worktree/NewFileDialog';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-a',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true, width: 288, isMobileDrawerOpen: false, toggle: vi.fn(),
    setWidth: vi.fn(), openMobileDrawer: vi.fn(), closeMobileDrawer: vi.fn(),
  }),
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => ({ worktrees: [], repositories: [], isLoading: false, error: null, refresh: vi.fn() }),
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as Array<[string, string | undefined]> }));
vi.mock('@/components/common/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/common/Toast')>();
  return { ...actual, useToast: () => ({ showToast: (message: string, type?: string) => toasts.push([message, type]), toasts: [], removeToast: () => undefined }) };
});
vi.mock('@/components/ui/ConfirmDialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/ConfirmDialog')>();
  return { ...actual, useConfirm: () => async () => true };
});

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import { beginHandoffPageRequest, currentHandoffPage, reportHandoffPageResponse, resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';

const A = 'wt-a';
type Entry = 'new-file' | 'new-dir' | 'rename' | 'delete' | 'move' | 'upload';
const ENTRIES: Entry[] = ['new-file', 'new-dir', 'rename', 'delete', 'move', 'upload'];

let calls: Record<Entry, number>;
let status: number | undefined;
/** When set, the next create answers only when this is called (the answer is pending meanwhile). */
let heldCreates: Array<(status: number) => void>;
let holdCreate: boolean;
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
const detailBody = { id: A, name: A, path: '/p', repositoryPath: '/r', repositoryName: 'R', sessionStatusByInstance: {} };

function entryOf(rest: string, method: string, body: unknown): Entry | null {
  if (rest.startsWith('/upload/')) return 'upload';
  if (rest.startsWith('/files/')) {
    const parsed = typeof body === 'string' ? (JSON.parse(body) as { type?: string; action?: string }) : {};
    if (method === 'DELETE') return 'delete';
    if (method === 'POST') return parsed.type === 'directory' ? 'new-dir' : 'new-file';
    if (method === 'PATCH') return parsed.action === 'move' ? 'move' : 'rename';
  }
  return null;
}

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  calls = Object.fromEntries(ENTRIES.map((e) => [e, 0])) as Record<Entry, number>;
  status = undefined;
  heldCreates = [];
  holdCreate = false;
  toasts.length = 0;
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
  vi.spyOn(window, 'prompt').mockImplementation(() => 'renamed.md');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const match = /^\/api\/worktrees\/([^/?]+)(.*)$/.exec(url);
    const rest = match ? match[2] : url;
    if (rest.startsWith('/mem/mode')) return json(200, { ok: true, mode: 'off', features: { popup: false } });
    const entry = entryOf(rest, init?.method ?? 'GET', init?.body);
    if (entry) {
      calls[entry] += 1;
      if (entry === 'new-file' && holdCreate) {
        return new Promise<Response>((resolve) =>
          heldCreates.push((code) => resolve(code === 200 ? json(200, { success: true }) : json(code, { success: false, error: 'e' }))),
        );
      }
      if (status !== undefined) return json(status, { error: `e${status}`, success: false });
      return json(200, { success: true, filename: 'a.png' });
    }
    if (match && rest === '') return json(200, detailBody);
    return json(404, {});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

let page: ReturnType<typeof useWorktreeDetailController>;
function Page() {
  page = useWorktreeDetailController({ worktreeId: A });
  // The real dialog, wired as the page wires it (PC and phone draw the same one with these props).
  return (
    <NewFileDialog
      isOpen={page.showNewFileDialog}
      parentPath={page.newFileParentPath}
      onConfirm={page.handleNewFileConfirm}
      onCancel={page.handleNewFileCancel}
    />
  );
}
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

async function drawn(): Promise<void> {
  render(<Page />);
  await waitFor(() => expect(page.loading).toBe(false));
  await settle();
}
function lapse(): void {
  act(() => {
    reportHandoffPageResponse(beginHandoffPageRequest(currentHandoffPage()!.id), { status: 401 });
  });
}

const DRIVE: Record<Entry, () => Promise<void>> = {
  'new-file': async () => page.handleNewFileConfirm('a.md'),
  'new-dir': async () => page.handleNewDirectory(''),
  rename: async () => page.handleRename('a.md'),
  delete: async () => page.handleDelete('a.md'),
  move: async () => page.handleMoveConfirm('dir'),
  upload: async () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    await page.handleFileInputChange({ target: { files: [file], value: '' } } as unknown as React.ChangeEvent<HTMLInputElement>);
  },
};
async function drive(entry: Entry): Promise<void> {
  if (entry === 'move') {
    act(() => page.handleMove('a.md', 'file'));
    await settle();
  }
  await act(async () => DRIVE[entry]());
  await settle();
}

describe('[#4345 1c-2] a refused file operation shows no failure and sends nothing', () => {
  it.each(ENTRIES)('%s: no alert, no toast, fetch 0', async (entry) => {
    await drawn();
    lapse();
    await drive(entry);
    expect(calls[entry]).toBe(0);
    expect(window.alert).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  it('new file (real NewFileDialog): refused, the dialog stays with the typed name and extension', async () => {
    await drawn();
    act(() => page.handleNewFile(''));
    await settle();
    fireEvent.change(await screen.findByTestId('new-file-name-input'), { target: { value: 'notes' } });
    fireEvent.change(screen.getByTestId('new-file-ext-select'), { target: { value: '.txt' } });
    lapse();
    fireEvent.click(screen.getByTestId('new-file-confirm-button'));
    await settle();
    await settle();
    expect(calls['new-file']).toBe(0);
    expect(window.alert).not.toHaveBeenCalled();
    expect(page.showNewFileDialog).toBe(true);
    expect((screen.getByTestId('new-file-name-input') as HTMLInputElement).value).toBe('notes');
    expect((screen.getByTestId('new-file-ext-select') as HTMLSelectElement).value).toBe('.txt');
  });

  it('(negative) new file with no lapse: created and the dialog closes', async () => {
    await drawn();
    act(() => page.handleNewFile(''));
    await settle();
    fireEvent.change(await screen.findByTestId('new-file-name-input'), { target: { value: 'notes' } });
    fireEvent.click(screen.getByTestId('new-file-confirm-button'));
    await waitFor(() => expect(calls['new-file']).toBe(1));
    await settle();
    expect(page.showNewFileDialog).toBe(false);
  });

  it('(negative) new file answering 500: the alert and the dialog closes', async () => {
    await drawn();
    act(() => page.handleNewFile(''));
    await settle();
    fireEvent.change(await screen.findByTestId('new-file-name-input'), { target: { value: 'notes' } });
    status = 500;
    fireEvent.click(screen.getByTestId('new-file-confirm-button'));
    await waitFor(() => expect(window.alert).toHaveBeenCalledTimes(1));
    expect(page.showNewFileDialog).toBe(false);
  });

  it('move: the dialog stays for the person to retry', async () => {
    await drawn();
    lapse();
    await drive('move');
    expect(page.isMoveDialogOpen).toBe(true);
    expect(page.moveTarget).toEqual({ path: 'a.md', type: 'file' });
  });
});

describe('[#4345 1c-2] (negative controls) an ordinary failure is still told', () => {
  it.each(['new-file', 'new-dir', 'rename', 'delete'] as const)('%s answering 500: the alert', async (entry) => {
    await drawn();
    status = 500;
    await drive(entry);
    expect(calls[entry]).toBe(1);
    expect(window.alert).toHaveBeenCalledTimes(1);
  });

  it('upload answering 500: the error toast', async () => {
    await drawn();
    status = 500;
    await drive('upload');
    expect(toasts.some(([, type]) => type === 'error')).toBe(true);
  });

  it('move answering 500: the error toast and the dialog closes', async () => {
    await drawn();
    status = 500;
    await drive('move');
    expect(toasts.some(([, type]) => type === 'error')).toBe(true);
    expect(page.isMoveDialogOpen).toBe(false);
  });
});

describe('[#4345 1c-2] a create answered after the dialog was cancelled and opened again', () => {
  const openAndType = async (name: string) => {
    act(() => page.handleNewFile(''));
    await settle();
    fireEvent.change(await screen.findByTestId('new-file-name-input'), { target: { value: name } });
  };

  it.each([200, 500])('answer %s of an earlier opening: the later opening stays open with its input', async (code) => {
    await drawn();
    holdCreate = true;
    await openAndType('first');
    fireEvent.click(screen.getByTestId('new-file-confirm-button'));
    await waitFor(() => expect(heldCreates.length).toBe(1));
    // Cancelled while the answer is awaited, then a new create is opened and typed into.
    act(() => page.handleNewFileCancel());
    await settle();
    holdCreate = false;
    await openAndType('second');
    expect(page.showNewFileDialog).toBe(true);
    await act(async () => heldCreates[0](code));
    await settle();
    await settle();
    expect(page.showNewFileDialog).toBe(true);
    expect((screen.getByTestId('new-file-name-input') as HTMLInputElement).value).toBe('second');
    // The later opening can still send its own create.
    fireEvent.click(screen.getByTestId('new-file-confirm-button'));
    await waitFor(() => expect(calls['new-file']).toBe(2));
  });

  it('(negative) without an opening in between, the answer closes the dialog as before', async () => {
    await drawn();
    holdCreate = true;
    await openAndType('only');
    fireEvent.click(screen.getByTestId('new-file-confirm-button'));
    await waitFor(() => expect(heldCreates.length).toBe(1));
    expect(page.showNewFileDialog).toBe(true);
    await act(async () => heldCreates[0](200));
    await settle();
    expect(page.showNewFileDialog).toBe(false);
  });
});
