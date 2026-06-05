/**
 * Unit tests for git-ai-prompt-templates (Issue #817).
 *
 * These are the SSOT prompt builders for the GitPane "Ask AI" buttons. They are
 * pure functions, so we assert the exact ja wording / context interpolation
 * here and let the component tests assert only that the right builder is wired.
 */

import { describe, it, expect } from 'vitest';
import {
  branchCreatePrompt,
  branchDeletePrompt,
  stashCleanupPrompt,
  stashConflictPrompt,
  resetPrompt,
  revertPrompt,
  forcePushPrompt,
} from '@/lib/git-ai-prompt-templates';

describe('git-ai-prompt-templates', () => {
  describe('branchCreatePrompt', () => {
    it('uses the given base branch when `from` is provided', () => {
      const out = branchCreatePrompt('feature/123-foo', 'develop');
      expect(out).toBe('`develop` から `feature/123-foo` ブランチを作成して checkout してください。');
    });

    it('falls back to the current HEAD when `from` is empty/undefined', () => {
      expect(branchCreatePrompt('feature/x', undefined)).toBe(
        '現在の HEAD から `feature/x` ブランチを作成して checkout してください。'
      );
      expect(branchCreatePrompt('feature/x', '   ')).toContain('現在の HEAD から');
    });

    it('trims whitespace around the name and base', () => {
      expect(branchCreatePrompt('  feature/y  ', '  main  ')).toBe(
        '`main` から `feature/y` ブランチを作成して checkout してください。'
      );
    });
  });

  describe('branchDeletePrompt', () => {
    it('builds a plain delete prompt when not forced', () => {
      expect(branchDeletePrompt('feature/old', false)).toBe(
        '`feature/old` ブランチを削除してください。'
      );
    });

    it('adds a -D force note when forced', () => {
      const out = branchDeletePrompt('feature/old', true);
      expect(out).toContain('`feature/old` ブランチを削除してください。');
      expect(out).toContain('-D で強制削除');
    });
  });

  describe('stashCleanupPrompt', () => {
    it('returns just the head when there are no stashes', () => {
      expect(stashCleanupPrompt([])).toBe(
        '古い stash entry をリストアップし、不要なものを削除する提案をしてください。'
      );
    });

    it('lists the current stash entries when present', () => {
      const out = stashCleanupPrompt([
        { index: 0, message: 'WIP on main: a' },
        { index: 1, message: 'WIP on dev: b' },
      ]);
      expect(out).toContain('現在の stash:');
      expect(out).toContain('- stash@{0}: WIP on main: a');
      expect(out).toContain('- stash@{1}: WIP on dev: b');
    });
  });

  describe('stashConflictPrompt', () => {
    it('asks to resolve the conflict before commit', () => {
      expect(stashConflictPrompt(null)).toContain('conflict を解決してから commit してください。');
    });

    it('appends the conflict notice when provided', () => {
      const out = stashConflictPrompt('a.ts でコンフリクト (stash retained)');
      expect(out).toContain('conflict を解決してから commit してください。');
      expect(out).toContain('a.ts でコンフリクト (stash retained)');
    });
  });

  describe('resetPrompt', () => {
    it('builds a soft/mixed reset prompt without the reflog note', () => {
      const soft = resetPrompt('soft', 'HEAD');
      expect(soft).toBe('`HEAD` に対して soft reset を行いたいです。安全に実行してください。');
      expect(soft).not.toContain('reflog');
    });

    it('adds a git reflog recovery note for hard reset', () => {
      const hard = resetPrompt('hard', 'abc1234');
      expect(hard).toContain('`abc1234` に対して hard reset を行いたいです。');
      expect(hard).toContain('git reflog から復旧');
    });
  });

  describe('revertPrompt', () => {
    it('uses the short (7-char) commit hash', () => {
      expect(revertPrompt('abc1234def5678')).toBe('コミット `abc1234` を revert してください。');
    });
  });

  describe('forcePushPrompt', () => {
    it('references the branch, ahead count, and upstream', () => {
      const out = forcePushPrompt({ branch: 'feature/x', ahead: 3 });
      expect(out).toContain('`feature/x`');
      expect(out).toContain('（↑3）');
      expect(out).toContain('force-with-lease');
      expect(out).toContain('`origin/feature/x`');
    });

    it('omits the ahead note when ahead is null or 0', () => {
      expect(forcePushPrompt({ branch: 'feature/x', ahead: null })).not.toContain('↑');
      expect(forcePushPrompt({ branch: 'feature/x', ahead: 0 })).not.toContain('↑');
    });

    it('falls back gracefully when branch is null', () => {
      const out = forcePushPrompt({ branch: null, ahead: null });
      expect(out).toContain('現在のブランチ');
      expect(out).toContain('origin/<branch>');
    });
  });
});
