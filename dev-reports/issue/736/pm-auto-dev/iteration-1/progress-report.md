# Issue #736 進捗報告（pm-auto-dev iteration-1）

**Issue**: refactor(terminal): remove state.terminal.* reducer slice by migrating Mobile to useTerminalPanePolling (#728 R3-007 + R3-010)
**ブランチ**: feature/736-worktree
**日付**: 2026-05-31

## サマリー

`state.terminal.*` reducer slice を完全削除し、Mobile 経路の terminal 表示を PC と同じ `useTerminalPanePolling` フックへ移行する behavior-preserving リファクタを完了。全品質ゲート PASS。

## 実施内容（TDD: Red → Green）

| Phase | 内容 | 結果 |
|-------|------|------|
| Red | reducer テストから terminal/複合 action assertion を削除→ tsc が test 側で red（src は clean） | ✅ |
| Green (T2) | `MobileTerminalTab` 新設・`MobileContent` を hook 駆動へ | ✅ |
| Green (T3) | 親側 terminal 参照を移行（cadence/isSessionRunning/fetchCurrentOutput/reset 群） | ✅ |
| Green (T4) | slice/型/action/creator 削除 | ✅ |
| Green (T5) | 旧 doc コメント整理 | ✅ |
| Green (T6) | 全テスト green | ✅ |
| Docs (T7) | CHANGELOG / CLAUDE.md 更新 | ✅ |

## 品質ゲート結果

| チェック | 結果 |
|----------|------|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npm run lint` | ✅ 0 warnings/errors |
| `npm run test:unit` | ✅ 6694 passed / 7 skipped（358 files） |
| `npm run build` | ✅ success |
| `grep -rn "state\.terminal" src/ tests/` | ✅ コード参照 0（残るのは回帰 assertion `expect(state.terminal).toBeUndefined()` と無関係な #728 `terminalSplits` のみ） |

## テスト件数増減

- `useWorktreeUIState.test.ts`: **38 → 32**（terminal/複合 action テスト 9 削除、slice 不在の回帰テスト 3 追加）
- `WorktreeDetailRefactored-cli-tab-switching.test.tsx`: **2 → 2**（R3-010 完全書き直し: 親 message stale-guard 1 維持 + hook re-key 検証 1 新規。`useTerminalPanePolling` を vi.hoisted でモック）

## 受入条件チェック

### Reducer削除の完遂
- [x] `state.terminal.*` 参照 0件（コード）
- [x] `WorktreeUIState` から `terminal` 削除
- [x] `SET_TERMINAL_*`(+`SET_AUTO_SCROLL`) action 削除
- [x] 不要な型・action creator 削除（複合 action 3種含む、production未使用を確認の上）

### テスト再設計（R3-010）
- [x] `cli-tab-switching.test.tsx` を `useTerminalPanePolling` モックベースで書き直し
- [x] CLI切替時の poller 再起動（hook re-key）シナリオを明示的にテスト
- [x] テスト件数の総増減を本レポートに記載

### 横断
- [x] PC経路（#728実装）の動作に変更なし（PC は元々 hook 駆動、`state.terminal` は表示に未使用）
- [x] lint / tsc / test:unit / build 全PASS
- [x] CLAUDE.md / CHANGELOG.md 更新

### Mobile経路の動作維持（要 実機UAT）
- [x] terminal 出力表示: `MobileTerminalTab` が PC と同一 hook で /current-output を fetch・表示（unit 検証 + 型/build 確認済み）
- [~] CLI切替 / Auto-Yes / 特殊キー送信: prompt/selectionList/Auto-Yes は親 `fetchCurrentOutput` 駆動を**変更せず維持**したため論理的に不変。ただし**実機（≤768px）でのUATは未実施**（下記参照）

## 未実施・申し送り

- **実機 UAT（Mobile ≤768px）**: terminal 表示・CLI切替・Auto-Yes・特殊キーの実機確認は、tmux/CLI セッションを伴う dev サーバ起動が必要で本イテレーションでは未実施。コードは behavior-preserving（prompt/selection/Auto-Yes 経路は無変更、terminal 表示は PC と同一の実績ある hook を流用）かつ全自動テスト+build が green のため低リスク。マージ前に手動 UAT を推奨。
- `state.prompt` slice は本Issueスコープ外（Issueレビュー S1-006 で明示）。将来 mobile prompt も hook 化する際の整理対象。

## 次のアクション
- [ ] 変更のコミット
- [ ] （推奨）Mobile 実機 UAT
- [ ] `/create-pr` で PR 作成（base: develop）
