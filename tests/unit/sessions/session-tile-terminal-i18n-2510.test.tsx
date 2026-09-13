/**
 * Real-dictionary i18n for the tile's surface and History controls (Issue #2510).
 *
 * The controls reuse the worktree screen's own copy (`worktree.surfaceMode.*`,
 * `worktree.terminal.show/hideHistory`) rather than adding tile-only keys, so
 * the two screens name one surface one way. This pins that those keys resolve
 * through `locales/{en,ja}/worktree.json` — the global passthrough mock in
 * tests/setup.ts would echo a missing key back and stay green.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const locale = vi.hoisted(() => ({ current: 'en' }));

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: () => ({
    terminal: {
      output: 'hello',
      realtimeSnippet: 'hello',
      isRunning: true,
      isThinking: false,
      sessionStatus: 'ready',
      isSelectionListActive: false,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn() }),
}));

vi.mock('@/components/worktree/ChatSurface', () => ({
  ChatSurface: () => React.createElement('div', { 'data-testid': 'chat-surface' }),
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => React.createElement('div', { 'data-testid': 'history-pane' }),
}));

import { SessionTile } from '@/components/sessions/SessionTile';
import type { Worktree } from '@/types/models';

const WORKTREE = {
  id: 'wt-1',
  name: 'feature/test',
  path: '/path/to/wt',
  repositoryPath: '/path/to/repo',
  repositoryName: 'MyRepo',
  branch: 'feature/2510',
  selectedAgents: ['claude'],
} as Worktree;

beforeEach(() => {
  window.localStorage.clear();
  locale.current = 'en';
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe.each([
  {
    lang: 'en',
    group: 'Output surface',
    chat: 'Show conversation',
    terminal: 'Show terminal output',
    hide: 'Hide history',
    show: 'Show history',
  },
  {
    lang: 'ja',
    group: '出力面',
    chat: '会話を表示',
    terminal: 'ターミナル出力を表示',
    hide: '履歴を非表示',
    show: '履歴を表示',
  },
])('Issue #2510 i18n ($lang)', ({ lang, group, chat, terminal, hide, show }) => {
  beforeEach(() => {
    locale.current = lang;
  });

  it('labels the surface segments and their group', () => {
    render(<SessionTile worktree={WORKTREE} enabled />);

    expect(screen.getByRole('group', { name: group })).toBeDefined();
    expect(screen.getByRole('button', { name: chat })).toBeDefined();
    expect(screen.getByRole('button', { name: terminal })).toBeDefined();
  });

  it('labels the History toggle by what pressing it will do', () => {
    render(<SessionTile worktree={WORKTREE} enabled />);
    fireEvent.click(screen.getByRole('button', { name: terminal }));

    const toggle = screen.getByRole('button', { name: hide });
    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: show })).toBeDefined();
  });
});
