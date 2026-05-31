# Issue #743 マルチステージレビュー完了報告

**対象**: fix(terminal): missing AI agent status indicator in PC per-split header (#728 follow-up)
**実施日**: 2026-05-31
**レビュアー**: Claude opus（Stage 1-4）／ Codex委任（Stage 5-8）はユーザー方針によりスキップ

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| H1 | `TerminalSplitPane.tsx` header に status indicator がない | Confirmed |
| H2 | `TerminalSplitPaneContent.tsx` が `headerExtras` を渡していない | Confirmed |
| H3 | Mobile版（L1947-1974）にのみ status indicator がある | Confirmed |
| H4 | `deriveCliStatus` は `@/lib/sidebar-utils` | **Rejected**（正: `@/types/sidebar`） |
| H5 | `SIDEBAR_STATUS_CONFIG` は `@/config/status-config` | **Rejected**（正: `@/config/status-colors`、status-config.tsは存在しない） |
| H6 | `statusConfig.colorClass` | **Rejected**（正: `className`） |
| H7 | `cliStatus === 'processing'` でspinner判定 | **Rejected**（'processing'は無い。`statusConfig.type === 'spinner'`） |
| H8 | `useWorktreeStatusByCli` hookを使う | **Rejected**（存在しない。親propagate方式） |
| H9 | `<Spinner/>` componentを使う | **Rejected**（存在しない。インラインspan） |
| H10 | `sessionStatusByCli[cliToolId]` = `{isRunning, isWaitingForResponse, isProcessing}` | Confirmed |
| H11 | `useTerminalPanePolling` から status取得可 | **Rejected**（isWaitingForResponse/isProcessing 無し→親propagate必須） |
| H12 | `TerminalSplitPane.tsx` は変更不要 | Confirmed（headerExtras描画位置の注記あり） |

**結論**: 根本原因の診断（H1/H2/H3）は100%正確。一方「対応方針」のコードサンプルは6件の参照誤りを含んでいたため、Stage 1-4で全面修正した。

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 0.5 | 仮説検証 | 12検証（Confirmed 4 / Rejected 7 / 注記1） | - | 完了 |
| 1 | 通常レビュー（1回目） | 10（Must 5 / Should 3 / Nice 2） | - | 完了 |
| 2 | 指摘事項反映（1回目） | - | 10 | 完了 |
| 3 | 影響範囲レビュー（1回目） | 6（Must 1 / Should 4 / Nice 1） | - | 完了 |
| 4 | 指摘事項反映（1回目） | - | 6 | 完了 |
| 5-8 | 2回目イテレーション（Codex） | - | - | **スキップ**（ユーザー方針） |

**Must Fix 合計**: 6件（全件反映済み）

## 主な改善点

1. **対応方針の誤参照を全面修正**（Stage 1-2）: 誤importパス2件、存在しないhook/component 2件、誤フィールド名、存在しないstatus値 `'processing'` → 実コードの正準パターン（Mobile L1947-1974 + #740 propagate）に書き換え。
2. **再レンダリング回避設計を明記**（Stage 3-4, Must Fix S3-001）: 親 `renderSplitPane` で `worktree` 全体を依存に入れると毎ポーリングで全split再renderが発生。→ **prop を導出済み `cliStatus: BranchStatus`（文字列）に絞り `deriveCliStatus(...)` を親で計算して渡す**設計に確定。
3. **後方互換の担保**（S3-002）: 新prop `cliStatus?` は optional（未指定時 idle フォールバック）で既存8テストを無改修温存。
4. **Mobile非影響の明示**（S3-004）: L1947-1974 は不変更、新規importは TerminalSplitPaneContent のみ。
5. **テスト方針の具体化**（S3-005）: 状態別描画・未指定フォールバック・per-split独立・`data-testid=split-status-indicator-${splitIndex}` assert。
6. **アクセシビリティ整合**（S3-006）: Mobile正準に合わせ `title` のみ（aria-label二重読み上げ回避）。

## 次のアクション

- [x] Issueの最終確認（本文更新済み）
- [ ] /work-plan で作業計画立案（Phase 4）
- [ ] /pm-auto-dev でTDD実装（Phase 5）
