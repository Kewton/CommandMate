/**
 * Unit tests for git-ai-prompt-templates (Issue #817, localized by #1307).
 *
 * These are the SSOT prompt builders for the GitPane "Ask AI" buttons. They are
 * pure functions that take the caller's `t`, so they are exercised here against
 * a REAL next-intl translator over the REAL dictionary — not a mock.
 *
 * Why not `tests/helpers/real-intl.ts`: that helper interpolates with a naive
 * `String.replace('{k}', v)`, so it cannot prove a message survives real ICU
 * parsing (an unbalanced brace, or a stray `'` escaping the rest of the string,
 * would pass there and break in production). `createTranslator` is the same
 * code path `useTranslations` runs, so a message that formats here formats in
 * the app. `onError` rethrows so a missing key fails loudly instead of
 * silently echoing the key path back — the #1197 / #1273 blind spot.
 */

import { describe, it, expect, vi } from 'vitest';

// tests/setup.ts mocks next-intl globally (and does not export createTranslator).
// Restore the real module here: the whole point is to run production's formatter.
vi.mock('next-intl', async (importOriginal) =>
  await importOriginal<typeof import('next-intl')>()
);

import { createTranslator } from 'next-intl';
import {
  branchCreatePrompt,
  branchDeletePrompt,
  stashCleanupPrompt,
  stashConflictPrompt,
  resetPrompt,
  revertPrompt,
  forcePushPrompt,
  type GitPromptTranslator,
} from '@/lib/git-ai-prompt-templates';
import enWorktree from '../../../locales/en/worktree.json';
import jaWorktree from '../../../locales/ja/worktree.json';

/** Real ICU translator bound exactly the way the panels bind it: t('worktree'). */
function makeT(locale: 'en' | 'ja'): GitPromptTranslator {
  return createTranslator({
    locale,
    messages: { worktree: locale === 'en' ? enWorktree : jaWorktree },
    namespace: 'worktree',
    onError: (error) => {
      throw error;
    },
  }) as unknown as GitPromptTranslator;
}

const ja = makeT('ja');
const en = makeT('en');

const CJK = /[぀-ヿ一-龯]/;

describe('git-ai-prompt-templates', () => {
  /**
   * Issue #1307: this wording shipped hardcoded in the builder source. The
   * expectations below are pinned to the pre-migration literals as emitted by
   * the builders at 3fad6d9c — NOT to the dictionary this change authored, which
   * would only prove the dictionary equals itself. Byte-equal here means the ja
   * draft the user sends is provably unchanged by the migration.
   */
  describe('ja output is byte-identical to the pre-migration hardcoded prompts', () => {
    it('branchCreatePrompt', () => {
      expect(branchCreatePrompt(ja, 'feature/123-foo', 'develop')).toBe(
        '`develop` から `feature/123-foo` ブランチを作成して checkout してください。'
      );
      expect(branchCreatePrompt(ja, 'feature/x', undefined)).toBe(
        '現在の HEAD から `feature/x` ブランチを作成して checkout してください。'
      );
      expect(branchCreatePrompt(ja, 'feature/x', '   ')).toBe(
        '現在の HEAD から `feature/x` ブランチを作成して checkout してください。'
      );
      expect(branchCreatePrompt(ja, '  feature/y  ', '  main  ')).toBe(
        '`main` から `feature/y` ブランチを作成して checkout してください。'
      );
    });

    it('branchDeletePrompt', () => {
      expect(branchDeletePrompt(ja, 'feature/old', false)).toBe(
        '`feature/old` ブランチを削除してください。'
      );
      expect(branchDeletePrompt(ja, 'feature/old', true)).toBe(
        '`feature/old` ブランチを削除してください。（マージされていないコミットがあっても -D で強制削除してください）'
      );
    });

    it('stashCleanupPrompt', () => {
      expect(stashCleanupPrompt(ja, [])).toBe(
        '古い stash entry をリストアップし、不要なものを削除する提案をしてください。'
      );
      expect(
        stashCleanupPrompt(ja, [
          { index: 0, message: 'WIP on main: a' },
          { index: 1, message: 'WIP on dev: b' },
        ])
      ).toBe(
        '古い stash entry をリストアップし、不要なものを削除する提案をしてください。\n\n' +
          '現在の stash:\n- stash@{0}: WIP on main: a\n- stash@{1}: WIP on dev: b'
      );
    });

    it('stashConflictPrompt', () => {
      expect(stashConflictPrompt(ja, null)).toBe(
        'stash の pop / apply で conflict が発生しました。conflict を解決してから commit してください。'
      );
      expect(stashConflictPrompt(ja, 'a.ts でコンフリクト (stash retained)')).toBe(
        'stash の pop / apply で conflict が発生しました。conflict を解決してから commit してください。\n\n' +
          'a.ts でコンフリクト (stash retained)'
      );
    });

    it('resetPrompt', () => {
      expect(resetPrompt(ja, 'soft', 'HEAD')).toBe(
        '`HEAD` に対して soft reset を行いたいです。安全に実行してください。'
      );
      expect(resetPrompt(ja, 'mixed', 'HEAD')).toBe(
        '`HEAD` に対して mixed reset を行いたいです。安全に実行してください。'
      );
      expect(resetPrompt(ja, 'hard', 'abc1234')).toBe(
        '`abc1234` に対して hard reset を行いたいです。安全に実行してください。 hard reset は作業内容を失う可能性があります。' +
          'もし直前の hard reset を取り消したい場合は git reflog から復旧してください。'
      );
    });

    it('revertPrompt', () => {
      expect(revertPrompt(ja, 'abc1234def5678')).toBe('コミット `abc1234` を revert してください。');
    });

    it('forcePushPrompt', () => {
      expect(forcePushPrompt(ja, { branch: 'feature/x', ahead: 3 })).toBe(
        '`feature/x`（↑3） を force-with-lease で push したいです。' +
          '事前に upstream（`origin/feature/x`）との差分を確認し、安全な場合のみ push してください。'
      );
      expect(forcePushPrompt(ja, { branch: 'feature/x', ahead: null })).toBe(
        '`feature/x` を force-with-lease で push したいです。' +
          '事前に upstream（`origin/feature/x`）との差分を確認し、安全な場合のみ push してください。'
      );
      expect(forcePushPrompt(ja, { branch: 'feature/x', ahead: 0 })).toBe(
        '`feature/x` を force-with-lease で push したいです。' +
          '事前に upstream（`origin/feature/x`）との差分を確認し、安全な場合のみ push してください。'
      );
      expect(forcePushPrompt(ja, { branch: null, ahead: null })).toBe(
        '現在のブランチ を force-with-lease で push したいです。' +
          '事前に upstream（`origin/<branch>`）との差分を確認し、安全な場合のみ push してください。'
      );
    });
  });

  /**
   * The bug #1307 fixes: an English user pressing "Ask AI" got a Japanese draft
   * dropped into their composer. Assert the real English wording, not just
   * "not Japanese" — and that context still interpolates.
   */
  describe('en renders an English draft with the context interpolated', () => {
    it('branchCreatePrompt names the branch and the base', () => {
      expect(branchCreatePrompt(en, 'feature/123-foo', 'develop')).toBe(
        'Create branch `feature/123-foo` from `develop` and check it out.'
      );
      expect(branchCreatePrompt(en, 'feature/x', undefined)).toBe(
        'Create branch `feature/x` from the current HEAD and check it out.'
      );
    });

    it('branchDeletePrompt adds the -D note only when forced', () => {
      expect(branchDeletePrompt(en, 'feature/old', false)).toBe('Delete branch `feature/old`.');
      const forced = branchDeletePrompt(en, 'feature/old', true);
      expect(forced).toContain('Delete branch `feature/old`.');
      expect(forced).toContain('-D');
    });

    it('stashCleanupPrompt keeps the stash list verbatim under an English head', () => {
      const out = stashCleanupPrompt(en, [{ index: 0, message: 'WIP on main: a' }]);
      expect(out).toContain('List the old stash entries');
      expect(out).toContain('Current stashes:');
      // `stash@{0}` must survive: ICU would treat a bare `{0}` in a *message* as
      // an argument, so this proves the list is passed as data, not as wording.
      expect(out).toContain('- stash@{0}: WIP on main: a');
    });

    it('stashConflictPrompt appends the notice', () => {
      expect(stashConflictPrompt(en, null)).toBe(
        'A conflict occurred while running stash pop / apply. Please resolve the conflict and then commit.'
      );
      expect(stashConflictPrompt(en, 'a.ts conflicted')).toContain('\n\na.ts conflicted');
    });

    it('resetPrompt carries the mode, and only hard gets the reflog note', () => {
      expect(resetPrompt(en, 'soft', 'HEAD')).toBe(
        'I want to run a soft reset onto `HEAD`. Please do it safely.'
      );
      expect(resetPrompt(en, 'soft', 'HEAD')).not.toContain('reflog');
      const hard = resetPrompt(en, 'hard', 'abc1234');
      expect(hard).toContain('hard reset onto `abc1234`');
      expect(hard).toContain('git reflog');
    });

    it('revertPrompt uses the short hash', () => {
      expect(revertPrompt(en, 'abc1234def5678')).toBe('Please revert commit `abc1234`.');
    });

    it('forcePushPrompt references branch, ahead count, and upstream', () => {
      const out = forcePushPrompt(en, { branch: 'feature/x', ahead: 3 });
      expect(out).toContain('`feature/x` (↑3)');
      expect(out).toContain('force-with-lease');
      expect(out).toContain('`origin/feature/x`');
      expect(forcePushPrompt(en, { branch: 'feature/x', ahead: null })).not.toContain('↑');
      expect(forcePushPrompt(en, { branch: 'feature/x', ahead: 0 })).not.toContain('↑');
      const noBranch = forcePushPrompt(en, { branch: null, ahead: null });
      expect(noBranch).toContain('the current branch');
      expect(noBranch).toContain('origin/<branch>');
    });

    it('no en prompt leaks Japanese or an unresolved placeholder', () => {
      const outputs = [
        branchCreatePrompt(en, 'feature/x', 'develop'),
        branchCreatePrompt(en, 'feature/x', undefined),
        branchDeletePrompt(en, 'b', true),
        branchDeletePrompt(en, 'b', false),
        stashCleanupPrompt(en, [{ index: 0, message: 'm' }]),
        stashCleanupPrompt(en, []),
        stashConflictPrompt(en, null),
        resetPrompt(en, 'soft', 'HEAD'),
        resetPrompt(en, 'hard', 'HEAD'),
        revertPrompt(en, 'abc1234def'),
        forcePushPrompt(en, { branch: 'x', ahead: 2 }),
        forcePushPrompt(en, { branch: null, ahead: null }),
      ];
      for (const out of outputs) {
        expect(CJK.test(out), `en prompt carries CJK: ${out}`).toBe(false);
        // A message whose value went missing echoes its key path back.
        expect(out).not.toContain('aiPrompts');
      }
    });
  });
});
