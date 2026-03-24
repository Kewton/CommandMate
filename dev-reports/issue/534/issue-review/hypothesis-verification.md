# Issue #534 仮説検証レポート

## 検証日時
- 2026-03-24

## 検証結果サマリー

| # | 前提条件/主張 | 判定 | 根拠 |
|---|-------------|------|------|
| 1 | NotesAndLogsPane.tsxにSUB_TABSが存在しTimer追加可能 | Confirmed | SUB_TABS配列定義あり、SubTab型拡張可能 |
| 2 | POST /api/worktrees/[id]/terminal APIが再利用可能 | Confirmed | cliToolId+command受付、6層セキュリティ |
| 3 | schedule-manager.tsが参考実装として利用可能 | Confirmed | グローバル状態管理・ポーリングパターン |
| 4 | auto-yes-config.tsに時間選択パターン参考可能 | Confirmed | ALLOWED_DURATIONS, DURATION_LABELS, isAllowedDuration |
| 5 | db-migrations.tsにマイグレーション機構あり（v23対応可能） | Confirmed | 現在v22、Migration型定義済み |
| 6 | WorktreeDetailRefactored.tsxにタブ状態管理あり | Confirmed | LeftPaneTab/MobileTab/SUB_TABS 3系統 |
| 7 | MobileTabBar.tsxにモバイルタブあり | Confirmed | TabConfig拡張可能構造 |
| 8 | 変更対象ファイルすべて存在 | Confirmed | NotesAndLogsPane, db-migrations, db.ts |

## 詳細

- **DBバージョン**: 現在v22。Issueではv23と記載 → 正確
- **SUB_TABS型**: `type SubTab = 'notes' | 'logs' | 'agent'` → `'timer'` 追加可能
- **terminal API**: `{ cliToolId, command }` で統一メッセージ送信可能
- **scheduled_executionsテーブル（v17）**: cron用。タイマーは別テーブルが適切

## Stage 1レビューへの申し送り事項

- Issueでは `delayed_messages` テーブルとしているが、既存の `scheduled_executions` との命名・責務分離を確認すべき
- モバイル対応: MobileTabBarに直接タブ追加 vs NotesAndLogsPane内サブタブ、どちらが適切か
