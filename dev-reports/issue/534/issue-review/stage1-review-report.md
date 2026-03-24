# Issue #534 レビューレポート

**レビュー日**: 2026-03-24
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目（Stage 1）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 3 |

Issue全体として、機能の目的・背景・UIイメージは明確に記載されている。DBスキーマやAPIエンドポイント、既存コンポーネントへの統合方針も概ね具体的。ただし、リソースクリーンアップの考慮漏れと、エッジケースの仕様不足が主な問題点として挙げられる。

---

## Must Fix（必須対応）

### MF-1: session-cleanup.tsにタイマー停止処理の考慮が欠如

**カテゴリ**: 整合性
**場所**: ## 影響範囲 セクション

**問題**:
影響範囲の変更対象ファイル一覧に `src/lib/session-cleanup.ts` が含まれていない。このファイルはworktree削除時やセッション停止時のリソースクリーンアップを一元管理するFacadeであり、既にresponse-poller、auto-yes-poller、schedule-managerの停止処理を統合している。timer-managerの停止処理が漏れると、削除されたworktreeに対してタイマーが発火し、存在しないworktreeへのメッセージ送信が試行される。

**証拠**:
- `src/lib/session-cleanup.ts` の既存import:
  - `stopPolling` (response-poller)
  - `stopAutoYesPollingByWorktree` (auto-yes-manager)
  - `stopScheduleForWorktree` (schedule-manager)
- 同様のパターンで `stopTimersForWorktree` 等の統合が必要

**推奨対応**:
`session-cleanup.ts` を変更対象ファイルに追加し、worktreeクリーンアップ時にタイマーをキャンセルする処理を実装タスクに含めること。

---

### MF-2: サーバー再起動時の過去時刻タイマーの扱いが未定義

**カテゴリ**: 技術的妥当性
**場所**: ## 提案する解決策 > バックエンド

**問題**:
「サーバー再起動時: 未送信タイマーをDBから復元し再スケジュール」とあるが、再起動時に `scheduled_send_time` が既に過去になっているタイマーの扱いが未定義。例えば、サーバーが1時間ダウンしていた場合、その間に発火すべきだったタイマーを即座に送信するのか、破棄するのかで挙動が大きく異なる。

**証拠**:
- DBスキーマに `scheduled_send_time` フィールドが存在
- 受入条件「サーバー再起動後も未送信タイマーが復元される」は「復元」の定義が曖昧

**推奨対応**:
受入条件に以下のいずれかを明記:
- (a) 過去時刻のタイマーは即座に送信する
- (b) 過去時刻のタイマーは期限切れとしてstatus='expired'に更新する
- (c) 一定時間以内（例: 5分以内）なら送信、超過なら破棄

---

## Should Fix（推奨対応）

### SF-1: delayed_messagesとscheduled_executionsの責務分離が不明確

**カテゴリ**: 整合性
**場所**: ## 実装タスク > DBマイグレーション

**問題**:
既存の `scheduled_executions` テーブル（v17マイグレーション）はcron定期実行用、新規の `delayed_messages` はワンショットタイマー用という目的の違いがあるが、Issue本文にその区別が明記されていない。テーブル名も「delayed」と「scheduled」で意味が近く、将来のメンテナンス時に混乱を招く可能性がある。

**証拠**:
- `scheduled_executions`: `cron_expression TEXT` 列あり、定期実行目的
- `delayed_messages`: `delay_ms`, `scheduled_send_time` 列予定、ワンショット目的

**推奨対応**:
- Issue本文に両テーブルの責務の違いを明記
- テーブル名を `timer_messages` や `one_shot_messages` などに変更を検討（`scheduled_executions` との混同回避）

---

### SF-2: モバイル対応の実装方針が不明確

**カテゴリ**: 明確性
**場所**: ## 実装タスク > モバイル対応

**問題**:
「モバイル対応」とだけ記載されており、具体的な実装方針がない。MobileTabBarの `MobileTab` 型は既に5種類（terminal, history, files, memo, info）あり、タブを直接追加するとモバイルでの操作性が悪化する。TimerはNotesAndLogsPane内のサブタブとしてmemoタブ経由でアクセスする形が既存パターンと整合するが、その方針が明記されていない。

**証拠**:
- `MobileTabBar.tsx`: `type MobileTab = 'terminal' | 'history' | 'files' | 'memo' | 'info'`
- 既に5タブでモバイル幅のタブバーが密集している

**推奨対応**:
「モバイルではmemoタブ内のNotesAndLogsPaneサブタブとしてTimerにアクセスする（MobileTabBarへの直接タブ追加は行わない）」等の方針を明記。

---

### SF-3: i18n対応の具体的な追加先が未記載

**カテゴリ**: 完全性
**場所**: ## 実装タスク > i18n対応

**問題**:
i18nで追加すべき翻訳キーの名前空間や、既存の `schedule` 名前空間に含めるのか新規名前空間を作るのかが未記載。新規名前空間を追加する場合は `src/i18n.ts` のimport/merge処理の変更も必要になる。

**証拠**:
- `NotesAndLogsPane.tsx` は `useTranslations('schedule')` を使用
- `src/i18n.ts` で7つの名前空間を明示的にロード・マージしている

**推奨対応**:
`schedule` 名前空間に `timer` プレフィックスで翻訳キーを追加する方針を記載（例: `schedule.timer.title`, `schedule.timer.addButton`）。または新規名前空間を作る場合は `src/i18n.ts` を変更対象に追加。

---

### SF-4: timer-manager.tsのglobalThisパターンに関する記載がない

**カテゴリ**: 技術的妥当性
**場所**: ## 提案する解決策 > バックエンド

**問題**:
Next.jsの開発モードではHot Reloadによりモジュールが再読み込みされ、setTimeoutで設定したタイマーハンドルが失われる。既存のschedule-manager.tsやauto-yes-manager.tsは `globalThis` パターンでこの問題を回避しているが、timer-manager.tsの設計にこの考慮が記載されていない。

**証拠**:
- `schedule-manager.ts`: `globalThis.__scheduleManagerStates` でHot Reload永続化
- コメント: "globalThis for hot reload persistence (same as auto-yes-manager.ts)"

**推奨対応**:
timer-manager.tsの設計に「globalThisパターンでHot Reload永続化を行う（schedule-manager.tsと同様）」を明記。

---

## Nice to Have（あれば良い）

### NTH-1: Issue #292との差分がより具体的であると良い

**カテゴリ**: 完全性
**場所**: ## 概要

**問題**:
「これを対応すればIssue #292は対応不要」とあるが、#292は「前の命令完了後に次を自動送信」（イベント駆動）、#534は「指定時間後にメッセージ送信」（時間駆動）でトリガー条件が異なる。#534で#292のユースケースが十分カバーできる理由の説明があると良い。

**推奨対応**:
「#292のユースケース（順次タスク実行）は、各タスクの推定完了時刻を見積もってタイマーを設定することで代替可能」等の説明を追加。

---

### NTH-2: タイマー登録時のバリデーション詳細

**カテゴリ**: 完全性
**場所**: ## 実装タスク

**推奨対応**:
以下のバリデーションルールの記載があると実装時の指針になる:
- メッセージ最大長: 既存terminal APIの `MAX_COMMAND_LENGTH=10000` と合わせる
- 空メッセージの拒否
- エージェント未選択時の挙動（デフォルトエージェント使用 or エラー）

---

### NTH-3: タイマー送信後の通知方法

**カテゴリ**: 完全性
**場所**: ## 受入条件

**推奨対応**:
タイマー発火後のフィードバック方法（タイマー一覧のステータス更新、Toast通知など）の記載があると完全性が高まる。statusカラム（pending/sent/cancelled/expired/failed）の状態遷移図があるとなお良い。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/NotesAndLogsPane.tsx` | SUB_TABS配列・SubTab型の拡張対象 |
| `src/lib/db/db-migrations.ts` | CURRENT_SCHEMA_VERSION=22、v23追加対象 |
| `src/lib/schedule-manager.ts` | globalThisパターン・ポーリング管理の参考実装 |
| `src/config/auto-yes-config.ts` | 時間選択パターンの参考（ALLOWED_DURATIONS） |
| `src/lib/session-cleanup.ts` | worktreeクリーンアップFacade（タイマー停止統合が必要） |
| `src/app/api/worktrees/[id]/terminal/route.ts` | メッセージ送信API（MAX_COMMAND_LENGTH=10000） |
| `src/components/mobile/MobileTabBar.tsx` | MobileTab型（既に5タブ） |
| `src/i18n.ts` | 名前空間ロード処理（7名前空間） |
| `src/lib/db/db.ts` | バレルエクスポート（timer-db追加が必要） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト構造・モジュール一覧の整合性確認 |
