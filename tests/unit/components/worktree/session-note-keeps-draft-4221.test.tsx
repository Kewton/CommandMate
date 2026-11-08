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

import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
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
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function renderPc() {
  return render(
    <TerminalSplitPane
      worktreeId={WT}
      splitIndex={0}
      cliToolId="claude"
      instanceId="claude"
      instance={claude}
      availableInstances={[claude]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      terminal={<div />}
      footer={<div />}
    />
  );
}

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

function Phone() {
  const { sessionNote, noteEditing, openNoteEditor, closeNoteEditor, commitNote } = useMobileSessionNoteEditor(WT, 'claude');
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
