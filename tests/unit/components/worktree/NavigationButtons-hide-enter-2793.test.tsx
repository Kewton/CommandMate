/**
 * NavigationButtons の `hideEnterKey`（Issue #2793）
 *
 * Command Code の Plan review では、`Enter` が本文上ではコメント欄を開き、アクション一覧に
 * フォーカスがあると `❯ Approve` を実行する。チャット面のカードからはどちらになるか
 * 見えないので、矢印パッドから `Enter` を外す。ボタンだけでなく、ツールバーが
 * 横取りしている Enter キーも外れていなければ、キーボードから同じ事故が起きる。
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NavigationButtons } from '@/components/worktree/NavigationButtons';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sentKeys = (): string[][] =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).keys);

describe('NavigationButtons hideEnterKey (Issue #2793)', () => {
  it('既定では Enter ボタンがある（対照）', () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="command-code" />);
    expect(screen.getByRole('button', { name: 'Enter' })).toBeInTheDocument();
  });

  it('hideEnterKey で Enter ボタンだけが消え、Left / Up / Down / Right / Esc は残る', () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="command-code" hideEnterKey />);
    expect(screen.queryByRole('button', { name: 'Enter' })).not.toBeInTheDocument();
    for (const name of ['Left', 'Up', 'Down', 'Right', 'Escape']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('ページャキーと併用しても Enter は出ない', () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="codex" hideEnterKey showPagerKeys />);
    expect(screen.queryByRole('button', { name: 'Enter' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Page Up' })).toBeInTheDocument();
  });

  it('既定ではツールバー上の Enter キーが Enter を送る（対照: キーボード経路は生きている）', async () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="command-code" />);
    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'Enter' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentKeys()).toEqual([['Enter']]);
  });

  it('hideEnterKey ではツールバー上の Enter キーも送らない（矢印キーは送る）', async () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="command-code" hideEnterKey />);
    const toolbar = screen.getByRole('toolbar');

    fireEvent.keyDown(toolbar, { key: 'Enter' });
    fireEvent.keyDown(toolbar, { key: 'ArrowDown' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentKeys()).toEqual([['Down']]);
  });

  it('hideEnterKey では Enter キーを横取りしない（フォーカス中のボタンの既定動作に任せる）', () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="command-code" hideEnterKey />);
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    screen.getByRole('button', { name: 'Up' }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
