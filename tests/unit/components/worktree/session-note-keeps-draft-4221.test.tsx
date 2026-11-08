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
import type Database from 'better-sqlite3';
import path from 'path';
import { writeScreenNote } from '@/lib/db/mem-db';
import { openMigratedFileDb } from '@tests/helpers/migrated-file-db';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

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
/** The next request is refused (400) before its version is read. */
let rejectNext = false;
function serveByVersion(): void {
  fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { baseVersion?: number };
    if (rejectNext) {
      rejectNext = false;
      return { ok: false, status: 400, json: async () => ({ code: 'secret_like' }) };
    }
    const ok = body.baseVersion === serverVersion;
    return {
      ok,
      status: ok ? 200 : 409,
      json: async () => (ok ? {} : { code: 'version_conflict', current: { text: 'CLI が書いた', version: serverVersion, updatedAt: 2 } }),
    };
  });
}

/** A CLI write reaching the list cache while the editor is open. */
function cliUpdate(version = 8): void {
  serverVersion = version;
  cacheState.value = {
    worktrees: [
      {
        id: WT,
        sessionNotes: {
          claude: { text: 'CLI が書いた', updatedAt: 2, version, mem: { itemId: 'i', createdBy: 'agent', updatedBy: 'agent' } },
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
    rejectNext = false;
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

// ---------------------------------------------------------------------------
// 2nd integration review P2-1・P2-2
// ---------------------------------------------------------------------------

const sentBase = (call: number) => JSON.parse(String(fetchMock.mock.calls[call][1].body)).baseVersion;

describe('2nd review P2-1: a returned draft keeps the version it names', () => {
  beforeEach(() => {
    rejectNext = false;
    serverVersion = 7;
    serveByVersion();
  });

  it('PC: 400 → a CLI update while fixing → the save again is 409 (the start’s version is kept)', async () => {
    rejectNext = true;
    const view = render(pcPane());
    fireEvent.click(screen.getByTestId('split-session-note-0'));
    typeAndEnter('split-session-note-input-0', '秘密を含む下書き');
    await settle();
    expect(screen.getByTestId('split-session-note-input-0-error').textContent).toContain('保存できない文字列');
    cliUpdate();
    view.rerender(pcPane());
    typeAndEnter('split-session-note-input-0', '直した下書き');
    await settle();
    expect(sentBase(1)).toBe(7);
    expect(screen.getByTestId('split-session-note-input-0')).toHaveValue('直した下書き');
    expect(screen.getByTestId('split-session-note-input-0-error').textContent).toContain('他で更新されました');
  });

  it('PC (control): 400 → fixing with no update → the save again lands', async () => {
    rejectNext = true;
    const view = render(pcPane());
    fireEvent.click(screen.getByTestId('split-session-note-0'));
    typeAndEnter('split-session-note-input-0', '秘密を含む下書き');
    await settle();
    view.rerender(pcPane());
    typeAndEnter('split-session-note-input-0', '直した下書き');
    await settle();
    expect(sentBase(1)).toBe(7);
    expect(screen.queryByTestId('split-session-note-input-0')).toBeNull();
  });

  it('PC: after a 409 the next save names the conflict’s version; a later update is 409 again, none lands', async () => {
    const view = render(pcPane());
    fireEvent.click(screen.getByTestId('split-session-note-0'));
    cliUpdate(8);
    view.rerender(pcPane());
    typeAndEnter('split-session-note-input-0', '一回目');
    await settle();
    cliUpdate(9);
    view.rerender(pcPane());
    typeAndEnter('split-session-note-input-0', '二回目');
    await settle();
    expect(sentBase(1)).toBe(8);
    expect(screen.getByTestId('split-session-note-input-0-error').textContent).toContain('他で更新されました');
    typeAndEnter('split-session-note-input-0', '三回目');
    await settle();
    expect(sentBase(2)).toBe(9);
    expect(screen.queryByTestId('split-session-note-input-0')).toBeNull();
  });

  it('phone: 400 → a CLI update while fixing → the save again is 409', async () => {
    rejectNext = true;
    const view = render(<Phone />);
    fireEvent.click(screen.getByTestId('open'));
    typeAndEnter('mobile-session-note-input', '秘密を含む下書き');
    await waitFor(() => expect(screen.getByTestId('mobile-session-note-input-error').textContent).toContain('保存できない文字列'));
    cliUpdate();
    view.rerender(<Phone />);
    typeAndEnter('mobile-session-note-input', '直した下書き');
    await waitFor(() => expect(screen.getByTestId('mobile-session-note-input-error').textContent).toContain('他で更新されました'));
    expect(sentBase(1)).toBe(7);
    expect(screen.getByTestId('mobile-session-note-input')).toHaveValue('直した下書き');
  });

  it('phone (control): 400 → fixing with no update → the save again lands; after a 409 the conflict’s version is named', async () => {
    rejectNext = true;
    const view = render(<Phone />);
    fireEvent.click(screen.getByTestId('open'));
    typeAndEnter('mobile-session-note-input', '秘密を含む下書き');
    await waitFor(() => expect(screen.getByTestId('mobile-session-note-input-error')).toBeTruthy());
    view.rerender(<Phone />);
    typeAndEnter('mobile-session-note-input', '直した下書き');
    await settle();
    expect(sentBase(1)).toBe(7);
    expect(screen.queryByTestId('mobile-session-note-input')).toBeNull();

    cliUpdate(8);
    view.rerender(<Phone />);
    serverVersion = 9; // the server moved again, and the list has not seen it
    fireEvent.click(screen.getByTestId('open'));
    typeAndEnter('mobile-session-note-input', '競合する文');
    await waitFor(() => expect(screen.getByTestId('mobile-session-note-input-error').textContent).toContain('他で更新されました'));
    expect(sentBase(2)).toBe(8);
    typeAndEnter('mobile-session-note-input', '競合の後の文');
    await settle();
    expect(sentBase(3)).toBe(9);
    expect(screen.queryByTestId('mobile-session-note-input')).toBeNull();
  });
});

describe('2nd review P2-2: a late failure of an unmounted hook opens no editor', () => {
  beforeEach(() => {
    const worktrees = [{ id: WT, sessionNotes: { claude: { text: 'A のメモ', updatedAt: 1, version: 7 }, codex: { text: 'B のメモ', updatedAt: 1, version: 3 } } }];
    cacheState.value = { worktrees, refresh: vi.fn(async () => undefined) };
  });

  /** The phone's tabs: the history tab unmounts the terminal and its hook. */
  function Tabs({ tab, instanceId }: { tab: 'terminal' | 'history'; instanceId: string }) {
    return tab === 'terminal' ? <Phone key={`t-${instanceId}`} instanceId={instanceId} /> : <div data-testid="history" />;
  }

  it('A saves → history → back to the terminal on B → A’s late 409: B’s editor stays closed', async () => {
    const release = deferredFetch(409);
    const view = render(<Tabs tab="terminal" instanceId="claude" />);
    fireEvent.click(screen.getByTestId('open'));
    typeAndEnter('mobile-session-note-input', 'A の下書き');
    view.rerender(<Tabs tab="history" instanceId="claude" />);
    view.rerender(<Tabs tab="terminal" instanceId="codex" />);
    release();
    await settle();
    expect(screen.queryByTestId('mobile-session-note-input')).toBeNull();
    fireEvent.click(screen.getByTestId('open'));
    expect(screen.getByTestId('mobile-session-note-input')).toHaveValue('B のメモ');
    expect(screen.queryByTestId('mobile-session-note-input-error')).toBeNull();
  });

  it('(control) A saves → history → the late 409 while still in history: nothing opens; A’s hook alive opens A', async () => {
    const release = deferredFetch(409);
    const view = render(<Tabs tab="terminal" instanceId="claude" />);
    fireEvent.click(screen.getByTestId('open'));
    typeAndEnter('mobile-session-note-input', 'A の下書き');
    view.rerender(<Tabs tab="history" instanceId="claude" />);
    release();
    await settle();
    expect(screen.queryByTestId('mobile-session-note-input')).toBeNull();
    view.rerender(<Tabs tab="terminal" instanceId="claude" />);
    expect(screen.queryByTestId('mobile-session-note-input')).toBeNull();

    // The same save with its hook alive does open A with the draft.
    const again = deferredFetch(409);
    fireEvent.click(screen.getByTestId('open'));
    typeAndEnter('mobile-session-note-input', 'A の二つ目');
    again();
    await waitFor(() => expect(screen.getByTestId('mobile-session-note-input')).toHaveValue('A の二つ目'));
  });
});

// ---------------------------------------------------------------------------
// 3rd integration review P2-1: a 409 that says "no row" (`current: null`)
// ---------------------------------------------------------------------------

describe('3rd review P2-1: a draft restored after another deleted the note saves (the version of "no row" is 0)', () => {
  // The fake route answers through the real slot rule (`writeScreenNote`), so the
  // version the hook sends and the one the store accepts are checked together.
  let sandbox: string;
  let noteDb: Database.Database;

  const store = (text: string, baseVersion: number | undefined) =>
    writeScreenNote(noteDb, { worktreeId: WT, instanceId: 'claude', text, baseVersion, memWrite: null, alive: null });
  const stored = () =>
    (noteDb.prepare("SELECT note FROM session_notes WHERE worktree_id = ? AND instance_id = 'claude'").get(WT) as { note: string } | undefined)?.note;
  const listShows = (version: number) => {
    cacheState.value = {
      worktrees: [{ id: WT, sessionNotes: { claude: { text: '前のメモ', updatedAt: 1, version, mem: null } } }],
      refresh: vi.fn(async () => undefined),
    };
  };

  beforeEach(() => {
    sandbox = makeTempDir('session-note-3rd-p2-1-');
    noteDb = openMigratedFileDb(path.join(sandbox, 'cm.db'), { foreignKeys: true });
    noteDb
      .prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`)
      .run(WT, WT, path.join(sandbox, 'wt'), path.join(sandbox, 'root'));
    const first = store('前のメモ', undefined);
    if (!first.ok || !first.row) throw new Error('seed failed');
    listShows(first.row.version);
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { text: string; baseVersion?: number };
      const result = store(body.text, body.baseVersion);
      if (result.ok) return { ok: true, status: 200, json: async () => ({ note: result.row }) };
      const current = 'current' in result && result.current ? { text: result.current.text, version: result.current.version, updatedAt: result.current.updatedAt } : null;
      return { ok: false, status: 409, json: async () => ({ code: 'version_conflict', current }) };
    });
  });
  afterEach(() => {
    noteDb.close();
    removeTempDir(sandbox);
  });

  const deletedByAnother = () => {
    const row = noteDb.prepare("SELECT version FROM session_notes WHERE instance_id = 'claude'").get() as { version: number };
    expect(store('', row.version).ok).toBe(true);
  };

  it('PC: deleted while editing → 409 (no row) → Enter again saves the draft', async () => {
    render(pcPane());
    fireEvent.click(screen.getByTestId('split-session-note-0'));
    deletedByAnother();
    typeAndEnter('split-session-note-input-0', '残した下書き');
    await settle();
    expect(screen.getByTestId('split-session-note-input-0-error').textContent).toContain('他で更新されました');
    typeAndEnter('split-session-note-input-0', '残した下書き');
    await settle();
    expect(sentBase(1)).toBe(0);
    expect(screen.queryByTestId('split-session-note-input-0')).toBeNull();
    expect(stored()).toBe('残した下書き');
  });

  it('PC (control): a note written again after the delete still makes the restored draft 409, and is kept', async () => {
    render(pcPane());
    fireEvent.click(screen.getByTestId('split-session-note-0'));
    deletedByAnother();
    typeAndEnter('split-session-note-input-0', '残した下書き');
    await settle();
    expect(store('他の人が書き直した', 0).ok).toBe(true);
    typeAndEnter('split-session-note-input-0', '残した下書き');
    await settle();
    expect(sentBase(1)).toBe(0);
    expect(screen.getByTestId('split-session-note-input-0-error').textContent).toContain('他で更新されました');
    expect(stored()).toBe('他の人が書き直した');
  });

  it('phone: deleted while editing → 409 (no row) → the reopened draft saves', async () => {
    render(<Phone />);
    fireEvent.click(screen.getByTestId('open'));
    deletedByAnother();
    typeAndEnter('mobile-session-note-input', 'スマホの下書き');
    await waitFor(() => expect(screen.getByTestId('mobile-session-note-input-error').textContent).toContain('他で更新されました'));
    typeAndEnter('mobile-session-note-input', 'スマホの下書き');
    await settle();
    expect(sentBase(1)).toBe(0);
    expect(screen.queryByTestId('mobile-session-note-input')).toBeNull();
    expect(stored()).toBe('スマホの下書き');
  });

  it('phone (control): a note written again after the delete makes the reopened draft 409, and is kept', async () => {
    render(<Phone />);
    fireEvent.click(screen.getByTestId('open'));
    deletedByAnother();
    typeAndEnter('mobile-session-note-input', 'スマホの下書き');
    await waitFor(() => expect(screen.getByTestId('mobile-session-note-input-error')).toBeTruthy());
    expect(store('他の人が書き直した', 0).ok).toBe(true);
    typeAndEnter('mobile-session-note-input', 'スマホの下書き');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await settle();
    expect(sentBase(1)).toBe(0);
    expect(screen.getByTestId('mobile-session-note-input-error').textContent).toContain('他で更新されました');
    expect(stored()).toBe('他の人が書き直した');
  });
});
