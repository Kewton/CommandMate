/**
 * Real-dictionary i18n for Issue #2509's new copy.
 *
 * Backed by the actual `locales/{en,ja}/common.json`, so deleting one of the
 * `sessions.viewMode.*` / `sessions.tile*` keys fails here rather than shipping
 * a control labelled `sessions.viewMode.tile` (the global passthrough mock in
 * tests/setup.ts would echo exactly that and stay green). Same arrangement, and
 * the same reason, as `tests/unit/app/sessions/page-i18n.test.tsx`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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
      output: '',
      realtimeSnippet: '',
      isRunning: false,
      isThinking: false,
      sessionStatus: '',
      isSelectionListActive: false,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: true,
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

import { SessionsViewModeSelector } from '@/components/sessions/SessionsViewModeSelector';
import { SessionTile } from '@/components/sessions/SessionTile';
import type { Worktree } from '@/types/models';

const WORKTREE = {
  id: 'wt-1',
  name: 'feature/test',
  path: '/path/to/wt',
  repositoryPath: '/path/to/repo',
  repositoryName: 'MyRepo',
  branch: 'feature/2509',
  selectedAgents: ['claude', 'codex'],
} as Worktree;

beforeEach(() => {
  locale.current = 'en';
});

describe('Issue #2509 i18n', () => {
  describe('en', () => {
    it('labels the view-mode segments and their group', () => {
      render(<SessionsViewModeSelector value="list" onChange={vi.fn()} />);

      expect(screen.getByRole('group', { name: 'Session layout' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'List view' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Tile view' })).toBeDefined();
    });

    it('names the tile after its branch and labels the instance selector', () => {
      render(<SessionTile worktree={WORKTREE} enabled />);

      expect(screen.getByRole('region', { name: 'Session tile for feature/2509' })).toBeDefined();
      expect(screen.getByRole('combobox', { name: 'Agent instance shown in this tile' })).toBeDefined();
    });
  });

  describe('ja', () => {
    beforeEach(() => {
      locale.current = 'ja';
    });

    it('labels the view-mode segments and their group', () => {
      render(<SessionsViewModeSelector value="tile" onChange={vi.fn()} />);

      expect(screen.getByRole('group', { name: 'セッションの表示形式' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'リスト表示' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'タイル表示' })).toBeDefined();
    });

    it('names the tile after its branch and labels the instance selector', () => {
      render(<SessionTile worktree={WORKTREE} enabled />);

      expect(screen.getByRole('region', { name: 'feature/2509 のセッションタイル' })).toBeDefined();
      expect(
        screen.getByRole('combobox', { name: 'このタイルに表示するエージェントインスタンス' }),
      ).toBeDefined();
    });
  });
});
