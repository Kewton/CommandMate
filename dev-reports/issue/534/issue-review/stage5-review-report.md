# Issue #534 レビューレポート

**レビュー日**: 2026-03-24
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 2回目

## 前回指摘事項の反映確認

### Stage 1（通常レビュー 1回目）の指摘反映状況

| ID | 指摘内容 | 反映状況 |
|----|---------|---------|
| MF-1 | session-cleanup.tsにタイマー停止処理の考慮が欠如 | 反映済み |
| MF-2 | サーバー再起動時の過去時刻タイマー処理が未記載 | 反映済み |
| SF-1 | テーブル名・責務分離が不明確 | 反映済み（timer_messagesに変更） |
| SF-2 | モバイル対応の実装方針が不明確 | 反映済み |
| SF-3 | i18n対応の具体的な追加先が未記載 | 反映済み |
| SF-4 | globalThisパターン使用の記載がない | 反映済み |

前回の Must Fix 2件、Should Fix 4件は全て適切に反映されている。

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 2 |
| Nice to Have | 2 |

---

## Must Fix（必須対応）

### MF-1: 時間範囲の上限値とミリ秒値の不整合

**カテゴリ**: 正確性
**場所**: 概要、受入条件、実装タスク > timer-constants.ts

**問題**:
Issue本文の複数箇所で「5分後から8時間50分後まで5分単位で指定可能」と記載されているが、実装タスクのtimer-constants.tsでは `300000ms〜31500000ms` と記載されている。

**証拠**:
- 31500000ms / 60000 = 525分 = **8時間45分**
- 8時間50分 = 530分 = 31800000ms

テキストの「8時間50分」とミリ秒値の「31500000ms（= 8時間45分）」に5分のずれがある。

**推奨対応**:
どちらが正しい意図かを確認し、テキスト表記とミリ秒値を一致させる。
- 8時間45分が正の場合: テキストを「8時間45分」に修正
- 8時間50分が正の場合: ミリ秒値を `31800000ms` に修正

---

## Should Fix（推奨対応）

### SF-1: タイマー発火時のエラーハンドリング方針が未記載

**カテゴリ**: 完全性
**場所**: ## 提案する解決策 > バックエンド

**問題**:
setTimeoutのコールバック内でtmux sendKeysが失敗した場合（セッション未起動、tmux接続不可など）のエラーハンドリング方針が定義されていない。

**証拠**:
- Issue本文には「ステータス表示の更新（sent/failed）で結果を通知」とUIレベルの記載はある
- しかしサーバー側でfailed時のDB更新やリトライポリシーが未定義
- `job-executor.ts` は `executeSchedule()` 内で try/catch し、成功時 completed、失敗時 failed を DB に記録する方式を採用している

**推奨対応**:
以下を明記する:
1. 送信失敗時は DB の status を `failed` に更新する
2. リトライは行わない（ワンショットの性質上、失敗は記録のみ）
3. `job-executor.ts` の既存パターンを踏襲する

---

### SF-2: UIタブ表記と実際のi18nラベルの軽微な不一致

**カテゴリ**: 整合性
**場所**: ## 提案する解決策 > UI

**問題**:
Issue内で「(Notes | Logs | Agent | Timer)」と表記されているが、実際のi18nラベルでは「Logs」タブのラベルは「Schedules」である。

**証拠**:
- `locales/en/schedule.json`: `"notes": "Notes"`, `"logs": "Schedules"`, `"agentTab": "Agent"`
- Issueの「Logs」表記は内部のSubTab ID（`'logs'`）と混同されている可能性がある

**推奨対応**:
- Issue内の表記を「(Notes | Schedules | Agent | Timer)」に修正するか、内部ID表記であることを明示する
- Timerタブの具体的なi18nキー名（例: `timerTab`）を実装タスクのi18n対応に記載する

---

## Nice to Have（あれば良い）

### NTH-1: カウントダウン表示のポーリング方式の詳細

**カテゴリ**: 完全性
**場所**: ## 実装タスク > TimerPane.tsx

カウントダウン表示にはクライアント側のsetInterval（1秒間隔）が必要。`auto-yes-config.ts` の `formatTimeRemaining()` 関数を再利用可能。タブが非アクティブ時の `visibilitychange` 対応（`useFilePolling.ts` のパターン）についても言及があるとより完全。

---

### NTH-2: Timer API の DELETE エンドポイント設計

**カテゴリ**: 完全性
**場所**: ## 実装タスク > Timer CRUD API

個別タイマー削除時のルーティング設計（クエリパラメータ方式 vs 動的ルート方式）を明記しておくと、実装時に迷わない。既存パターンでは単一 `route.ts` ファイル + クエリパラメータが一般的。

---

## 参照ファイル

### コード
- `src/config/auto-yes-config.ts`: formatTimeRemaining() 関数（L125）、ALLOWED_DURATIONS の設計パターン
- `locales/en/schedule.json`: 既存タブラベルとの整合性確認
- `src/lib/job-executor.ts`: タイマー発火時のエラーハンドリングパターンの参考
- `src/components/worktree/NotesAndLogsPane.tsx`: SUB_TABS 配列・SubTab 型の拡張対象
- `src/hooks/useFilePolling.ts`: visibilitychange 対応パターンの参考

### ドキュメント
- `CLAUDE.md`: プロジェクト構造・モジュール一覧の整合性確認
