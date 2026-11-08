/**
 * A refused (400) or stale (409) note keeps what was typed, on the PC split and on the
 * phone (Issue #4221, 2nd review 1); a saved one closes the editor as before. The note
 * also sends back the version it was read at.
 *
 * The phone is driven through its real hook and editor (`MobileTerminalTabSessionNote`),
 * which close at Enter: the shared hook reopens them with the draft.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

const { cacheState } = vi.hoisted(() => ({
  cacheState: { value: null as null | { worktrees: unknown[]; refresh: () => Promise<void> } },
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => cacheState.value,
  useWorktreesCacheContext: () => cacheState.value,
  WorktreesCacheProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { resetSessionNoteHandoffForTests, TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { MobileSessionNoteEditor, useMobileSessionNoteEditor } from '@/components/worktree/MobileTerminalTabSessionNote';
import type { AgentInstance } from '@/lib/cli-tools/types';

beforeAll(() => installRadixJsdomPolyfills());

const WT = 'wt-4221';
const claude: AgentInstance = { id: 'claude', cliTool: 'claude', alias: 'claude', order: 0 };
let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number): void {
  fetchMock.mockResolvedValue({ ok: status < 400, status, json: async () => ({ code: status === 400 ? 'secret_like' : 'version_conflict' }) });
}

beforeEach(() => {
  cacheState.value = {
    worktrees: [{ id: WT, sessionNotes: { claude: { text: '前のメモ', updatedAt: 1, version: 7, mem: null } } }],
    refresh: vi.fn(async () => undefined),
  };
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cacheState.value = null;
  resetSessionNoteHandoffForTests();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

const codex: AgentInstance = { id: 'codex', cliTool: 'codex', alias: 'codex', order: 1 };

function pcPane(instance: AgentInstance = claude) {
  return (
    <TerminalSplitPane
      worktreeId={WT}
      splitIndex={0}
      cliToolId={instance.cliTool}
      instanceId={instance.id}
      instance={instance}
      availableInstances={[claude, codex]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      terminal={<div />}
      footer={<div />}
    />
  );
}

const renderPc = () => render(pcPane());

function typeAndEnter(testId: string, text: string): void {
  const input = screen.getByTestId(testId);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('PC split', () => {
  it.each([
    [400, '保存できない文字列'],
    [409, '他で更新されました'],
  ])('reopens with the draft and the reason on %i', async (status, message) => {
    respond(status);
    renderPc();
    fireEvent.click(screen.getByTestId('split-session-note-0'));
    typeAndEnter('split-session-note-input-0', '模擬の秘密を含む下書き');
    await settle();
    expect(screen.getByTestId('split-session-note-input-0')).toHaveValue('模擬の秘密を含む下書き');
    expect(screen.getByTestId('split-session-note-input-0-error').textContent).toContain(message);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ instanceId: 'claude', text: '模擬の秘密を含む下書き', baseVersion: 7 });
  });

  it('closes on success (control)', async () => {
    respond(200);
    renderPc();
    fireEvent.click(screen.getByTestId('split-session-note-0'));
    typeAndEnter('split-session-note-input-0', '通常の文');
    await settle();
    expect(screen.queryByTestId('split-session-note-input-0')).toBeNull();
  });
});

function Phone({ instanceId = 'claude' }: { instanceId?: string }) {
  const { sessionNote, noteEditing, openNoteEditor, closeNoteEditor, commitNote } = useMobileSessionNoteEditor(WT, instanceId);
  return (
    <div>
      <button data-testid="open" onClick={openNoteEditor}>
        open
      </button>
      {noteEditing && (
        <MobileSessionNoteEditor showSessionRow={false} sessionNote={sessionNote} onCommit={commitNote} onCancel={closeNoteEditor} />
      )}
    </div>
  );
}

describe('phone', () => {
  it('opens the editor again with the draft and the reason on 400', async () => {
    respond(400);
    render(<Phone />);
    fireEvent.click(screen.getByTestId('open'));
    typeAndEnter('mobile-session-note-input', 'スマホの下書き');
    await waitFor(() => expect(screen.getByTestId('mobile-session-note-input')).toHaveValue('スマホの下書き'));
    expect(screen.getByTestId('mobile-session-note-input-error').textContent).toContain('保存できない文字列');
  });

  it('closes on success, and a later open starts from the saved note, with no reason (control)', async () => {
    respond(200);
    render(<Phone />);
    fireEvent.click(screen.getByTestId('open'));
    typeAndEnter('mobile-session-note-input', '通常の文');
    await settle();
    expect(screen.queryByTestId('mobile-session-note-input')).toBeNull();
    fireEvent.click(screen.getByTestId('open'));
    // The saved text is shown until the list confirms it (the #2427 override).
    expect(screen.getByTestId('mobile-session-note-input')).toHaveValue('通常の文');
    expect(screen.queryByTestId('mobile-session-note-input-error')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration review P2-2・P2-3
// ---------------------------------------------------------------------------

/** A server that answers like the note route: 409 unless `baseVersion` is the stored one. */
let serverVersion: number;
function serveByVersion(): void {
  fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { baseVersion?: number };
    const ok = body.baseVersion === serverVersion;
    return { ok, status: ok ? 200 : 409, json: async () => ({ code: ok ? undefined : 'version_conflict' }) };
  });
}

/** A CLI write reaching the list cache while the editor is open. */
function cliUpdate(): void {
  serverVersion = 8;
  cacheState.value = {
    worktrees: [
      {
        id: WT,
        sessionNotes: {
          claude: { text: 'CLI が書いた', updatedAt: 2, version: 8, mem: { itemId: 'i', createdBy: 'agent', updatedBy: 'agent' } },
        },
      },
    ],
    refresh: vi.fn(async () => undefined),
  };
}

function deferredFetch(status: number): () => void {
  let release!: () => void;
  fetchMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: status < 400, status, json: async () => ({ code: 'version_conflict' }) });
      })
  );
  return () => release();
}

describe('P2-2: the version is the one the edit started from', () => {
  beforeEach(() => {
    serverVersion = 7;
    serveByVersion();
  });

  it('PC: a CLI update during the edit makes the save 409, keeping the draft', async () => {
    const view = render(pcPane());
    fireEvent.click(screen.getByTestId('split-session-note-0'));
    cliUpdate();
    view.rerender(pcPane());
    typeAndEnter('split-session-note-input-0', '古い版からの下書き');
    await settle();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).baseVersion).toBe(7);
    expect(screen.getByTestId('split-session-note-input-0')).toHaveValue('古い版からの下書き');
    expect(screen.getByTestId('split-session-note-input-0-error').textContent).toContain('他で更新されました');
  });

  it('PC (control): without an update the save lands', async () => {
    const view = render(pcPane());
    fireEvent.click(screen.getByTestId('split-session-note-0'));
    view.rerender(pcPane());
    typeAndEnter('split-session-note-input-0', '下書き');
    await settle();
    expect(fetchMock.mock.results.length).toBe(1);
    expect(screen.queryByTestId('split-session-note-input-0')).toBeNull();
  });

  it('phone: a CLI update during the edit makes the save 409, keeping the draft', async () => {
    const view = render(<Phone />);
    fireEvent.click(screen.getByTestId('open'));
    cliUpdate();
    view.rerender(<Phone />);
    typeAndEnter('mobile-session-note-input', 'スマホの古い下書き');
    await waitFor(() => expect(screen.getByTestId('mobile-session-note-input')).toHaveValue('スマホの古い下書き'));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).baseVersion).toBe(7);
    expect(screen.getByTestId('mobile-session-note-input-error').textContent).toContain('他で更新されました');
  });

  it('phone (control): without an update the save lands and the editor closes', async () => {
    const view = render(<Phone />);
    fireEvent.click(screen.getByTestId('open'));
    view.rerender(<Phone />);
    typeAndEnter('mobile-session-note-input', 'スマホの下書き');
    await settle();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).baseVersion).toBe(7);
    expect(screen.queryByTestId('mobile-session-note-input')).toBeNull();
  });
});

describe('P2-3: a late failure stays with the session it was typed for', () => {
  beforeEach(() => {
    const worktrees = [{ id: WT, sessionNotes: { claude: { text: 'A のメモ', updatedAt: 1, version: 7 }, codex: { text: 'B のメモ', updatedAt: 1, version: 3 } } }];
    cacheState.value = { worktrees, refresh: vi.fn(async () => undefined) };
  });

  it('phone: A’s 409 after switching to B neither opens B’s editor nor fills it', async () => {
    const release = deferredFetch(409);
    const view = render(<Phone instanceId="claude" />);
    fireEvent.click(screen.getByTestId('open'));
    typeAndEnter('mobile-session-note-input', 'A の下書き');
    view.rerender(<Phone instanceId="codex" />);
    release();
    await settle();
    expect(screen.queryByTestId('mobile-session-note-input')).toBeNull();
    fireEvent.click(screen.getByTestId('open'));
    expect(screen.getByTestId('mobile-session-note-input')).toHaveValue('B のメモ');
    expect(screen.queryByTestId('mobile-session-note-input-error')).toBeNull();
  });

  it('phone (control): without the switch the same late 409 reopens A with its draft', async () => {
    const release = deferredFetch(409);
    render(<Phone instanceId="claude" />);
    fireEvent.click(screen.getByTestId('open'));
    typeAndEnter('mobile-session-note-input', 'A の下書き');
    release();
    await waitFor(() => expect(screen.getByTestId('mobile-session-note-input')).toHaveValue('A の下書き'));
  });

  it('PC: A’s 409 after the split switched to B does not open B’s editor with A’s draft', async () => {
    const release = deferredFetch(409);
    const view = render(pcPane(claude));
    fireEvent.click(screen.getByTestId('split-session-note-0'));
    typeAndEnter('split-session-note-input-0', 'A の下書き');
    view.rerender(pcPane(codex));
    release();
    await settle();
    expect(screen.queryByTestId('split-session-note-input-0')).toBeNull();
  });

  it('PC (control): without the switch the late 409 reopens with A’s draft', async () => {
    const release = deferredFetch(409);
    render(pcPane(claude));
    fireEvent.click(screen.getByTestId('split-session-note-0'));
    typeAndEnter('split-session-note-input-0', 'A の下書き');
    release();
    await settle();
    expect(screen.getByTestId('split-session-note-input-0')).toHaveValue('A の下書き');
  });
});
