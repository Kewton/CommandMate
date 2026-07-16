/**
 * @vitest-environment jsdom
 *
 * Issue #1304: the worktree-level status dot in DesktopHeader used to read its
 * accessible label from a hardcoded English `label` on DESKTOP_STATUS_CONFIG.
 * It now resolves `DESKTOP_STATUS_LABEL_KEYS[status]` through the dictionary,
 * and `error` falls through to <StatusDot>'s own `common.status.error`.
 *
 * Backed by the REAL dictionary (tests/helpers/real-intl) rather than the global
 * echo mock: with the echo mock these assertions would pass against keys that do
 * not exist (#1197). Both locales are exercised, because the bug this migration
 * fixes is "English shown to a Japanese user".
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import type { WorktreeStatusType } from '@/config/status-colors';

const locale = vi.hoisted(() => ({ current: 'en' }));

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

const baseProps = {
  worktreeName: 'feature/1304-status-colors',
  repositoryName: 'CommandMate',
  onBackClick: vi.fn(),
  onInfoClick: vi.fn(),
};

/** Renders fresh each call so a test may sweep every status in one body. */
function statusLabel(status: WorktreeStatusType): string {
  cleanup();
  render(<DesktopHeader {...baseProps} status={status} />);
  return screen.getByTestId('desktop-status-indicator').getAttribute('aria-label') ?? '';
}

/** EN values are the pre-#1304 literals — the byte-identity bar. */
const EN: Record<WorktreeStatusType, string> = {
  idle: 'Idle - No active session',
  ready: 'Ready - Waiting for input',
  running: 'Running - Processing',
  waiting: 'Waiting - User input required',
  error: 'Error',
};

const JA: Record<WorktreeStatusType, string> = {
  idle: 'アイドル - セッションなし',
  ready: '準備完了 - 入力待ち',
  running: '実行中 - 処理しています',
  waiting: '待機中 - ユーザー入力が必要です',
  error: 'エラー',
};

describe('DesktopHeader worktree status label (Issue #1304)', () => {
  describe('en — byte-identical to the pre-migration hardcoded labels', () => {
    for (const [status, expected] of Object.entries(EN)) {
      it(`renders "${expected}" for ${status}`, () => {
        locale.current = 'en';
        expect(statusLabel(status as WorktreeStatusType)).toBe(expected);
      });
    }
  });

  describe('ja — the wording a Japanese user actually sees', () => {
    for (const [status, expected] of Object.entries(JA)) {
      it(`renders "${expected}" for ${status}`, () => {
        locale.current = 'ja';
        expect(statusLabel(status as WorktreeStatusType)).toBe(expected);
      });
    }

    it('shows no English for any status (the #1275/#1276/#1277 failure mode)', () => {
      locale.current = 'ja';
      for (const status of Object.keys(EN) as WorktreeStatusType[]) {
        expect(statusLabel(status)).not.toMatch(/[A-Za-z]/);
      }
    });
  });
});
