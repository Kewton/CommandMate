# Issue #740 開発進捗レポート（iteration-1）

**Issue**: fix(terminal): missing AutoYesToggle in PC per-split footer breaks per-Agent Auto-Yes selection (#728 follow-up)
**ブランチ**: `feature/740-worktree`
**実装コミット**: `b9f9d21d`
**日付**: 2026-05-31

---

## フェーズ別結果

| Phase | 内容 | ステータス | 備考 |
|-------|------|-----------|------|
| 1 | Issue情報収集 | ✅ | 受入条件8件・実装タスク6件を抽出 |
| 2 | TDD実装（opus） | ✅ | Red→Green→Refactor、テスト4件追加 |
| 3 | 受入テスト（opus） | ✅ | 8/8 criteria PASS、build成功 |
| 4 | リファクタリング（opus） | ✅ | no_change_needed（既にクリーン） |
| 5 | ドキュメント最新化 | ✅ | CHANGELOG + CLAUDE.md 更新 |
| 6 | 実機UAT | ⏭️ スキップ | ユーザー判断（ユニット+build+静的解析で網羅検証済み、live CLIセッション前提のため） |
| 7 | 進捗報告 | ✅ | 本レポート |

---

## 実装サマリー

PC版の各ターミナル split footer に `AutoYesToggle` を復活し、CLI 単位で独立した Auto-Yes ON/OFF を実現。

### 変更ファイル
- `src/components/worktree/WorktreeDetailRefactored.tsx`
  - `handleAutoYesToggle` を `makeAutoYesToggleHandler(cliToolId)` カリー化（`useCallback`, dep: `worktreeId`）
  - API body の `cliToolId` と `setAutoYesStateMap` キーを引数値に
  - `handleAutoYesToggle = makeAutoYesToggleHandler(activeCliTab)` の薄いラッパで Mobile 後方互換維持
  - `renderSplitPane` で各 split に per-CLI `enabled`/`expiresAt`/`onAutoYesToggle` を配布
  - `prevAutoYesEnabledRef` は activeCliTab 一致時のみ更新（#314 stop-reason トーストスコープ保護）
- `src/components/worktree/TerminalSplitPaneContent.tsx`
  - props 追加（`autoYesExpiresAt` / `lastAutoResponse` / `onAutoYesToggle`）
  - footer 先頭に `<AutoYesToggle cliToolName={cliToolId} inline />` 描画
  - `useAutoYes` は呼ばない（client-side auto-response は #501 サーバー poller 委譲）
  - JSDoc を per-CLI トグル対応へ更新
- `tests/unit/components/worktree/TerminalSplitPaneContent.test.tsx`
  - AutoYesToggle 描画 / onAutoYesToggle 呼び出し / PromptPanel 抑制 / per-split 独立性の4テスト追加
- `CHANGELOG.md` / `CLAUDE.md` 更新

---

## 品質メトリクス

| 項目 | 結果 |
|------|------|
| TerminalSplitPaneContent.test.tsx | 9 passed / 9（既存5 + 新規4） |
| 関連回帰テスト（cli-tab-switching / mobile-overflow / AutoYesToggle） | 22 passed / 22 |
| `npm run test:unit`（全体） | 6703 passed / 7 skipped / **0 failed** |
| `npx tsc --noEmit` | 0 errors |
| `npm run lint` | clean |
| `npm run build` | success（32/32 pages、exit 0） |

---

## スコープ外（別Issue候補）

- 非アクティブ split のサーバー主導 Auto-Yes 同期（expiry/stop_pattern/consecutive_errors の即時反映）→ 全 split ポーリング化を別Issueで検討
- `useAutoYes` 自体の per-split key 化リファクタ
- `renderSplitPane` 内インラインアロー由来の memo churn（#740 以前からの既存事象、本Issueでは非対応）

---

## 次のアクション

- [ ] PR作成（`/create-pr`）→ develop 向け
