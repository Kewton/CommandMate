/**
 * Real-dictionary i18n guard for the worktree git / panel / dialog surface (Issue #1277).
 *
 * The global next-intl mock in tests/setup.ts echoes `namespace.key` back, so a
 * component test renders `worktree.git.stash.empty` and still passes with the key
 * missing from the dictionary. Only a real-dictionary assert like this one stops a
 * raw key string from reaching the UI — the blind spot #1197 and #1273 both hit.
 *
 * `tests/helpers/real-intl.ts` closes half of it (the component tests that use it
 * load `en` only), so a key present in en but MISSING FROM ja stays green there.
 * The ja-side parity asserts below are the only thing covering that half.
 *
 * Scope: every key the worktree/git/** panels, the worktree/ panels + dialogs, and
 * common/ConnectionStatusIndicator resolve at runtime.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function load(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, `${namespace}.json`), 'utf-8')
  );
}

function leafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return leafKeys(value as Record<string, unknown>, full);
    }
    return [full];
  });
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);
}

/**
 * Keys resolved through a lookup table / string concat rather than a literal
 * `t('...')` argument. A grep-based sweep of the source cannot see these, and a
 * component test only catches them if that exact branch happens to render — so
 * they are enumerated by hand.
 */
const DYNAMIC: Record<string, string[]> = {
  // GitPaneMobileTabs TAB_LABEL_KEYS
  worktree: [
    'git.tabs.status',
    'git.tabs.changes',
    'git.tabs.history',
    'git.tabs.advanced',
    // GitBranchPanel include-filter tabs
    'git.branches.filterLocal',
    'git.branches.filterRemote',
    'git.branches.filterAll',
    // GitDangerZonePanel reset-mode radios
    'git.danger.modeSoft',
    'git.danger.modeMixed',
    'git.danger.modeHard',
    // ActivityBar <- ACTIVITIES[].labelKey (src/config/activity-bar-config.ts)
    'activityBar.files',
    'activityBar.git',
    'activityBar.notes',
    'activityBar.schedules',
    'activityBar.agent',
    'activityBar.timer',
    'activityBar.todo',
    'activityBar.skills',
    // WorktreeInfoFields / DesktopHeader <- WORKTREE_STATUS_OPTIONS[].labelKey
    'worktreeStatus.notSet',
    'worktreeStatus.ready',
    'worktreeStatus.inProgress',
    'worktreeStatus.inReview',
    'worktreeStatus.done',
  ],
  // Agent-status pills: tCommon(`status.${BranchStatus}`) in
  // WorktreeDetailSubComponents / WorktreeDetailRefactored. #1277 requires reusing
  // these generic keys (#1273) instead of SIDEBAR_STATUS_CONFIG[].label, so the
  // BranchStatus union must stay a subset of common.status.*.
  common: ['status.idle', 'status.ready', 'status.running', 'status.waiting', 'status.generating'],
};

/** Keys resolved by a literal `t('...')` in the migrated components. */
const REQUIRED: Record<string, string[]> = {
  worktree: [
    'git.uncommittedChanges',
    'git.askAi',
    'git.askAiTooltip',
    'git.advancedOperations',
    'git.remote',
    'git.paneSections',
    'git.checkout.action',
    'git.checkout.ariaLabel',
    'git.checkout.noBranches',
    'git.checkout.checkoutBranch',
    'git.checkout.checkedOutElsewhere',
    'git.checkout.defaultBadge',
    'git.checkout.confirmTitlePrefix',
    'git.checkout.confirmTitleSuffix',
    'git.checkout.forceLabel',
    'git.checkout.historyLossWarning',
    'git.checkout.runningSessionWarning',
    'git.branches.title',
    'git.branches.newButton',
    'git.branches.refresh',
    'git.branches.loading',
    'git.branches.empty',
    'git.branches.defaultBadge',
    'git.branches.deleteBranch',
    'git.branches.delete',
    'git.branches.createTitle',
    'git.branches.namePlaceholder',
    'git.branches.nameLabel',
    'git.branches.baseLabel',
    'git.branches.currentHead',
    'git.branches.create',
    'git.branches.deleteTitlePrefix',
    'git.branches.deleteTitleSuffix',
    'git.branches.forceDeleteLabel',
    'git.changes.title',
    'git.changes.refresh',
    'git.changes.loading',
    'git.changes.listHeader',
    'git.changes.empty',
    'git.changes.togglePreview',
    'git.changes.showDiff',
    'git.changes.diff',
    'git.changes.fileAction',
    'git.changes.loadingPreview',
    'git.changes.previewFailed',
    'git.changes.noDiff',
    'git.changes.truncated',
    'git.changes.staged',
    'git.changes.unstaged',
    'git.changes.untracked',
    'git.changes.stage',
    'git.changes.unstage',
    'git.changes.commitMessage',
    'git.changes.amend',
    'git.changes.commit',
    'git.changes.committing',
    'git.changes.commitAndPush',
    'git.changes.commitAndPushTooltip',
    'git.history.title',
    'git.history.refresh',
    'git.history.loading',
    'git.history.empty',
    'git.history.viewDiffFor',
    'git.history.viewDiff',
    'git.history.hideDiff',
    'git.history.loadingChangedFiles',
    'git.history.noChangedFiles',
    'git.history.showCommitDiff',
    'git.history.changedFiles',
    'git.history.diffLabel',
    'git.history.loadingDiff',
    'git.history.noDiff',
    'git.history.diffInFilePanel',
    'git.currentStatus.title',
    'git.currentStatus.refresh',
    'git.currentStatus.loading',
    'git.currentStatus.uncommitted',
    'git.currentStatus.aheadTooltip',
    'git.currentStatus.behindTooltip',
    'git.danger.title',
    'git.danger.resetOpen',
    'git.danger.revertOpen',
    'git.danger.forcePushOpen',
    'git.danger.selectCommitHint',
    'git.danger.resetTitle',
    'git.danger.resetTargetHead',
    'git.danger.resetTargetSelectedPrefix',
    'git.danger.resetTargetSelectedHash',
    'git.danger.resetTargetNoneSelected',
    'git.danger.resetHardWarning',
    'git.danger.runningSessionWarning',
    'git.danger.confirmPlaceholder',
    'git.danger.reset',
    'git.danger.revertTitle',
    'git.danger.revertBodyPrefix',
    'git.danger.revertNoCommit',
    'git.danger.revert',
    'git.danger.forcePushTitle',
    'git.danger.protectedBranchWarning',
    'git.danger.forceWithLease',
    'git.danger.forcePush',
    'git.network.quickActions',
    'git.network.fetch',
    'git.network.pull',
    'git.network.push',
    'git.network.noUpstreamTooltip',
    'git.network.pushing',
    'git.network.pulling',
    'git.network.fetching',
    'git.network.progress',
    'git.network.abort',
    'git.network.conflicts',
    'git.network.authFailedGuidance',
    'git.network.failed',
    'git.stash.titlePrefix',
    'git.stash.count',
    'git.stash.refresh',
    'git.stash.messagePlaceholder',
    'git.stash.includeUntracked',
    'git.stash.push',
    'git.stash.loading',
    'git.stash.empty',
    'git.stash.apply',
    'git.stash.pop',
    'git.stash.drop',
    'git.stash.dropConfirmSuffix',
    // Issue #1307: Ask AI draft prompts (src/lib/git-ai-prompt-templates.ts).
    // The builders pick the key, so a grep of the panels cannot see these.
    'git.aiPrompts.branchCreate',
    'git.aiPrompts.branchCreateBaseHead',
    'git.aiPrompts.branchDelete',
    'git.aiPrompts.branchDeleteForce',
    'git.aiPrompts.stashCleanup',
    'git.aiPrompts.stashCleanupCurrent',
    'git.aiPrompts.stashConflict',
    'git.aiPrompts.reset',
    'git.aiPrompts.resetHard',
    'git.aiPrompts.revert',
    'git.aiPrompts.forcePush',
    'git.aiPrompts.forcePushAhead',
    'git.aiPrompts.forcePushCurrentBranch',
    'activityBar.toggleSidebar',
    'activityBar.label',
    'branchMismatch.changedFrom',
    'branchMismatch.to',
    'branchMismatch.dismiss',
    'contextMenu.label',
    'contextMenu.uploadFile',
    'contextMenu.rename',
    'contextMenu.move',
    'contextMenu.delete',
    'fileTree.newFile',
    'fileTree.newDirectory',
    'navigation.toolbarLabel',
    'navigation.caption',
    'navigation.quitPager',
    'newFileDialog.title',
    'newFileDialog.fileNameLabel',
    'newFileDialog.placeholder',
    'newFileDialog.create',
    'paneResizer.label',
    'paneResizer.arrowsHorizontal',
    'paneResizer.arrowsVertical',
    'desktopLayout.activityPane',
    'desktopLayout.terminalPane',
    'card.main',
    'card.description',
    'card.link',
    'card.openLink',
    'card.updated',
    'detail.worktree',
    'detail.repository',
    'detail.copyRepositoryPath',
    'detail.copyWorktreePath',
    'detail.copyPath',
    'detail.copied',
    'detail.path',
    'detail.status',
    'detail.worktreeStatusLabel',
    'detail.description',
    'detail.addNotesPlaceholder',
    'detail.noDescription',
    'detail.link',
    'detail.lastUpdated',
    'detail.logs',
    'detail.hide',
    'detail.show',
    'detail.goBack',
    'detail.home',
    'detail.viewInfo',
    'detail.info',
    'detail.infoModalTitle',
    'detail.loading',
    'detail.loadingInfo',
    'detail.errorLoading',
    'detail.uploadFile',
    'detail.unknownRepository',
    'detail.loadingEditor',
    'detail.agentInstanceSelection',
    'detail.statusPill',
    'detail.subTabMessage',
    'detail.subTabGit',
  ],
  schedule: [
    'memoAdd',
    'memoRemaining',
    'memoDefaultTitle',
    'memoTitlePlaceholder',
    'memoInsertToMessage',
    'memoCopyContent',
    'memoDelete',
    'memoContentPlaceholder',
    'memoLoading',
    'memoSearchToggle',
    'memoEmpty',
    'memoEmptyHint',
    'memoNoMatch',
    'memoSearchLabel',
    'memoSearchPlaceholder',
    'memoSearchInputLabel',
    'memoSearchPrev',
    'memoSearchNext',
    'memoSearchClose',
    // Issue #1307: Ask AI draft prompts (src/lib/schedule-ai-prompt-templates.ts).
    // The builders pick the key, so a grep of the dialog cannot see these.
    'edit.aiPrompts.cron',
    'edit.aiPrompts.cronRefine',
    'edit.aiPrompts.messageDraft',
    'edit.aiPrompts.messageDraftNamed',
  ],
  common: [
    'connection.reconnecting',
    'connection.offline',
    'connection.reconnectingTooltip',
    'connection.offlineTooltip',
    'repositories.loading',
  ],
};

const ALL: Record<string, string[]> = Object.fromEntries(
  [...new Set([...Object.keys(REQUIRED), ...Object.keys(DYNAMIC)])].map((ns) => [
    ns,
    [...(REQUIRED[ns] ?? []), ...(DYNAMIC[ns] ?? [])],
  ])
);

describe('worktree git/panel i18n keys (Issue #1277)', () => {
  describe.each(Object.entries(ALL))('%s namespace', (namespace, keys) => {
    it.each(LOCALES)('%s resolves every required key to a non-empty string', (locale) => {
      const dict = load(locale, namespace);
      for (const key of keys) {
        const value = resolve(dict, key);
        expect(typeof value, `${locale}/${namespace}.json: ${key}`).toBe('string');
      }
    });

    it('en and ja expose the identical set of keys (parity)', () => {
      expect(leafKeys(load('en', namespace)).sort()).toEqual(
        leafKeys(load('ja', namespace)).sort()
      );
    });
  });

  /**
   * `git.checkout.confirmTitlePrefix` is deliberately EMPTY in ja (the words move
   * to the suffix so `<prefix>{branch}<suffix>` reads correctly in both locales),
   * so a blanket non-empty assert would be wrong. Everything else must be non-empty.
   */
  const INTENTIONALLY_EMPTY = new Set([
    'worktree:git.checkout.confirmTitlePrefix',
    'worktree:git.branches.deleteTitlePrefix',
  ]);

  it('no required key is an empty string (except the documented prefix pair)', () => {
    for (const locale of LOCALES) {
      for (const [namespace, keys] of Object.entries(ALL)) {
        const dict = load(locale, namespace);
        for (const key of keys) {
          if (INTENTIONALLY_EMPTY.has(`${namespace}:${key}`)) continue;
          expect(resolve(dict, key), `${locale}/${namespace}: ${key}`).not.toBe('');
        }
      }
    }
  });

  it('no value is a verbatim echo of its own key path', () => {
    for (const locale of LOCALES) {
      for (const [namespace, keys] of Object.entries(ALL)) {
        const dict = load(locale, namespace);
        for (const key of keys) {
          const value = resolve(dict, key);
          expect(value, `${locale}/${namespace}: ${key}`).not.toBe(key);
          expect(value, `${locale}/${namespace}: ${key}`).not.toBe(`${namespace}.${key}`);
        }
      }
    }
  });

  it.each([
    ['worktree', 'git.checkout.checkoutBranch', ['{name}']],
    ['worktree', 'git.checkout.checkedOutElsewhere', ['{path}']],
    ['worktree', 'git.branches.deleteBranch', ['{name}']],
    ['worktree', 'git.changes.listHeader', ['{title}', '{count}']],
    ['worktree', 'git.changes.fileAction', ['{action}', '{path}']],
    ['worktree', 'git.changes.togglePreview', ['{path}']],
    ['worktree', 'git.history.viewDiffFor', ['{hash}']],
    ['worktree', 'git.history.diffInFilePanel', ['{file}']],
    ['worktree', 'git.danger.confirmPlaceholder', ['{branch}']],
    ['worktree', 'git.danger.resetTargetSelectedHash', ['{hash}']],
    ['worktree', 'git.network.progress', ['{operation}', '{elapsed}']],
    ['worktree', 'git.network.conflicts', ['{files}']],
    ['worktree', 'git.stash.count', ['{count}']],
    ['worktree', 'paneResizer.label', ['{arrows}']],
    ['worktree', 'card.updated', ['{time}']],
    ['worktree', 'detail.statusPill', ['{label}', '{status}']],
    ['schedule', 'memoRemaining', ['{count}']],
    // Issue #1307: the Ask AI drafts interpolate context (branch, target, cron
    // input) mid-sentence, and en/ja order those clauses differently. A locale
    // that drops a placeholder silently ships a draft missing its context.
    ['worktree', 'git.aiPrompts.branchCreate', ['{base}', '{name}']],
    ['worktree', 'git.aiPrompts.branchDelete', ['{name}']],
    ['worktree', 'git.aiPrompts.branchDeleteForce', ['{name}']],
    ['worktree', 'git.aiPrompts.reset', ['{target}', '{mode}']],
    ['worktree', 'git.aiPrompts.resetHard', ['{target}']],
    ['worktree', 'git.aiPrompts.revert', ['{commit}']],
    ['worktree', 'git.aiPrompts.forcePush', ['{branchRef}', '{upstream}']],
    ['worktree', 'git.aiPrompts.forcePushAhead', ['{branchRef}', '{upstream}', '{ahead}']],
    ['schedule', 'edit.aiPrompts.cronRefine', ['{current}']],
    ['schedule', 'edit.aiPrompts.messageDraftNamed', ['{name}']],
  ])('%s.%s keeps its placeholders in every locale', (namespace, key, placeholders) => {
    for (const locale of LOCALES) {
      const value = resolve(load(locale, namespace), key) as string;
      for (const ph of placeholders) {
        expect(value, `${locale}/${namespace}: ${key} lost ${ph}`).toContain(ph);
      }
    }
  });

  /**
   * Issue #1277: these strings shipped as hardcoded Japanese and rendered verbatim
   * for English users. The ja values are pinned to the pre-migration literals (taken
   * from the source at eabfefbc, NOT from the dictionary this change authored — an
   * expectation written against my own output would prove nothing) so ja rendering
   * is provably unchanged, while en is now real English.
   */
  it('pins ja to the pre-migration Japanese wording (was hardcoded, rendered to en users)', () => {
    const ja = load('ja', 'worktree');
    // src/config/git-status-config.ts (constants deleted by #1277)
    expect(resolve(ja, 'git.checkout.historyLossWarning')).toBe(
      '別ブランチへ切り替えると、このワークツリーに紐づくチャット履歴・メモ・スケジュールが次回同期時に失われる可能性があります'
    );
    expect(resolve(ja, 'git.checkout.runningSessionWarning')).toBe(
      'このブランチに切り替えると、稼働中のセッションの作業ファイルが変化します。'
    );
    expect(resolve(ja, 'git.danger.resetHardWarning')).toBe(
      'ハードリセットは未コミットの変更を完全に破棄し、HEAD を移動するとコミットも失われる可能性があります。この操作は取り消せません。'
    );
    expect(resolve(ja, 'git.danger.runningSessionWarning')).toBe(
      'この危険な操作は、稼働中のセッションが編集中の作業ファイルを破壊的に書き換えます。'
    );
    expect(resolve(ja, 'git.network.authFailedGuidance')).toBe(
      'ターミナルで一度 push/pull して認証情報を設定してください。'
    );
    expect(resolve(ja, 'git.danger.protectedBranchWarning')).toBe(
      'デフォルトブランチへの force push は禁止されています。'
    );
    // gitPaneShared.tsx:84 / GitStashPanel.tsx:214 (inline JSX literals)
    expect(resolve(ja, 'git.askAiTooltip')).toBe(
      '現在の状況を AI チャットに下書きします（自動送信はされません）'
    );
    expect(resolve(ja, 'git.stash.dropConfirmSuffix')).toBe(
      ' を完全に削除します。この操作は取り消せません。'
    );
  });

  it('pins ja ConnectionStatusIndicator to its pre-migration Japanese wording', () => {
    const ja = load('ja', 'common');
    expect(resolve(ja, 'connection.reconnecting')).toBe('再接続中');
    expect(resolve(ja, 'connection.offline')).toBe('オフライン');
    expect(resolve(ja, 'connection.reconnectingTooltip')).toBe(
      'ライブ接続を再確立しています（ポーリングで動作中）'
    );
    expect(resolve(ja, 'connection.offlineTooltip')).toBe('ライブ接続なし（ポーリングで動作中）');
  });

  /**
   * The whole point of #1270: an en dictionary carrying CJK means an English user
   * is reading Japanese. Sweeps every namespace, not just the ones touched here.
   */
  it.each(fs.readdirSync(path.join(LOCALES_DIR, 'en')))(
    'en/%s carries no CJK text',
    (file) => {
      const dict = load('en', file.replace(/\.json$/, ''));
      for (const key of leafKeys(dict)) {
        const value = resolve(dict, key);
        if (typeof value !== 'string') continue;
        expect(/[぀-ヿ一-龯]/.test(value), `en/${file}: ${key} = ${value}`).toBe(false);
      }
    }
  );
});
