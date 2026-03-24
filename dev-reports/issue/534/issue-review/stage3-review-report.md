# Issue #534 影響範囲レビューレポート

**レビュー日**: 2026-03-24
**フォーカス**: 影響範囲レビュー
**ステージ**: Stage 3（影響範囲レビュー 1回目）
**前提**: Stage 1-2のレビュー指摘（9件）はすべて反映済み

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 3 |
| Nice to Have | 2 |

---

## Must Fix（必須対応）

### MF-1: server.tsが変更対象ファイルに含まれていない

**カテゴリ**: 影響ファイル
**場所**: ## 影響範囲 > 変更対象ファイル

**問題**:
timer-managerはサーバー起動時にDBから未送信タイマーを復元し、シャットダウン時にすべてのsetTimeoutをクリアする必要がある。`server.ts`はこのライフサイクル管理の中心であり、`initTimerManager()`と`stopAllTimers()`の呼び出しを追加する必要があるが、変更対象ファイルに記載されていない。

**証拠**:
- `server.ts` L44: `import { initScheduleManager, stopAllSchedules } from './src/lib/schedule-manager';`
- `server.ts` L278: `initScheduleManager();` （サーバー起動後、initializeWorktrees()の直後）
- `server.ts` L303: `stopAllSchedules();` （gracefulShutdown内）
- timer-managerも全く同じパターンでinit/stopを統合しなければ、再起動時の未送信タイマー復元が行われず、シャットダウン時にsetTimeoutが残留してプロセスが終了しない。

**推奨対応**:
変更対象ファイルにserver.tsを追加し、以下を明記:
1. `initTimerManager()`: `initScheduleManager()`の直後に呼び出し（DB復元処理を実行）
2. `stopAllTimers()`: gracefulShutdown()内の`stopAllSchedules()`の直後に呼び出し

---

### MF-2: resource-cleanup.tsが変更対象ファイルに含まれていない

**カテゴリ**: 影響ファイル
**場所**: ## 影響範囲 > 変更対象ファイル

**問題**:
`resource-cleanup.ts`の`cleanupOrphanedMapEntries()`は24時間周期で実行され、globalThis上のMap（auto-yes-state, auto-yes-poller, schedule-manager）から、DBに存在しないworktreeIdのエントリを検出・削除している。timer-managerもglobalThisパターンを使用するため、同じ孤立検出ロジックの追加が必要。

**証拠**:
- `resource-cleanup.ts` L217-280: `cleanupOrphanedMapEntries()`がautoYesStates, autoYesPollerStates, scheduleManagerの3つのMapを検証
- `CleanupMapResult`型に`deletedScheduleWorktreeIds`フィールドがあり、timer-manager用の`deletedTimerWorktreeIds`の追加が必要
- この修正を行わない場合、worktreeが削除されてもtimer-managerのglobalThis Map上にエントリが残り続ける（24時間以上のメモリリーク）

**推奨対応**:
1. `resource-cleanup.ts`を変更対象ファイルに追加
2. timer-managerから`getTimerWorktreeIds()`関数をエクスポートし、`cleanupOrphanedMapEntries()`でschedule-managerと同じパターンで孤立検出を行う

---

## Should Fix（推奨対応）

### SF-1: テスト範囲の具体的なファイル・シナリオが未特定

**カテゴリ**: テスト範囲
**場所**: ## 実装タスク > ユニットテスト

**問題**:
実装タスクに「ユニットテスト」とだけ記載されており、具体的なテストファイル・シナリオが不明。特に、既存テストファイルへの修正が必要なケースが特定されていない。

**証拠**:
- `tests/unit/lib/session-cleanup.test.ts`: `cleanupWorktreeSessions()`のテストが存在。timer-manager停止処理の追加で`pollersStopped`配列の要素数が変わり、既存のアサーションが失敗する可能性がある。
- `tests/unit/lib/resource-cleanup.test.ts`: `cleanupOrphanedMapEntries()`のテストが存在。戻り値型の変更で既存アサーションに影響する可能性がある。

**推奨対応**:
以下のテストファイルを実装タスクに明記:
- `tests/unit/lib/timer-manager.test.ts`（新規）: setTimeout登録/キャンセル/DB復元/globalThisパターン/過去時刻の即時送信
- `tests/unit/lib/db/timer-db.test.ts`（新規）: CRUD操作、ステータス遷移
- `tests/unit/config/timer-constants.test.ts`（新規）: 時間選択肢の定数バリデーション
- `tests/unit/lib/session-cleanup.test.ts`（既存修正）: timer-manager停止の検証追加
- `tests/unit/lib/resource-cleanup.test.ts`（既存修正）: timer-managerのorphaned検出追加

---

### SF-2: timer-managerからメッセージ送信への依存方法が未明確

**カテゴリ**: 依存関係
**場所**: ## 提案する解決策 > バックエンド

**問題**:
Issueには「既存のTerminal API（POST /api/worktrees/[id]/terminal）を再利用」と記載されているが、サーバーサイドのtimer-managerからAPI Routeを「再利用」する方法が不明確。API Route（NextRequest/NextResponse）はHTTPリクエスト経由で呼ばれることを前提としており、サーバー内部から直接呼ぶのは不自然。

**証拠**:
- `src/app/api/worktrees/[id]/terminal/route.ts`: NextRequest/NextResponseを使うAPI Route
- `src/lib/session/claude-executor.ts`: schedule-managerのjob-executor.tsが使用する内部モジュール（execFile方式）
- `src/lib/tmux/tmux.ts`: `sendKeys()`関数がtmuxセッションへの直接送信を提供

**推奨対応**:
「Terminal APIの再利用」を以下のいずれかに明確化:
- (a) `tmux.ts`の`sendKeys()`を直接呼ぶ（推奨: 依存が明確、HTTP往復不要）
- (b) `session-key-sender.ts`の既存ロジックを使う
- Terminal APIのHTTPエンドポイントをlocalhostで呼ぶ方式は非推奨（不必要なオーバーヘッド、認証トークンの内部転送が必要）

---

### SF-3: CLAUDE.md・docs/module-reference.mdへの追記が必要

**カテゴリ**: ドキュメント更新
**場所**: ## 影響範囲

**問題**:
CLAUDE.mdの「主要モジュール一覧」は全モジュールが列挙されており、Claude Codeがコードベースを理解する際の基盤となっている。新規モジュール追加時に更新しないと、以降のClaude Code操作で新モジュールが認識されない。

**推奨対応**:
影響範囲に以下のドキュメント更新を追加:
- `CLAUDE.md`: 主要モジュール一覧にtimer-manager.ts, timer-db.ts, timer-constants.ts, TimerPane.tsxを追記
- `docs/module-reference.md`: 新規モジュールの関数シグネチャを追記

---

## Nice to Have（あれば良い）

### NTH-1: NotesAndLogsPaneの4タブ化によるUI幅の確認

**カテゴリ**: 破壊的変更
**場所**: ## 影響範囲 > 関連コンポーネント

**問題**:
SUB_TABSが3タブから4タブに増えることで、各タブが`flex-1`（25%幅）になる。特に狭い画面（モバイルのmemoタブ経由表示）で「Agent」「Timer」などのラベルが収まるかの確認が望ましい。

**推奨対応**:
実装時にモバイル画面幅（320px-375px）でのタブ表示を確認し、必要に応じてタブラベルの短縮やアイコン表示を検討。

---

### NTH-2: DBマイグレーションv23のロールバック定義

**カテゴリ**: 移行考慮
**場所**: ## 実装タスク > DBマイグレーション

**問題**:
db-migrations.tsのMigration型はdown関数（ロールバック）をオプションで定義可能だが、v23のロールバック方針が未記載。

**推奨対応**:
v23マイグレーションにdown関数（`DROP TABLE IF EXISTS timer_messages;`）を定義しておくと、問題発生時のロールバックが容易。

---

## 影響範囲の全体マップ

```
server.ts (init/shutdown lifecycle)
  |
  +-- timer-manager.ts [新規] (globalThis + setTimeout + DB復元)
  |     |
  |     +-- timer-db.ts [新規] (CRUD操作)
  |     |     |
  |     |     +-- db-migrations.ts (v23マイグレーション)
  |     |     +-- db.ts (バレルエクスポート追加)
  |     |
  |     +-- tmux/tmux.ts (sendKeys -- メッセージ送信)
  |     +-- cli-tools/manager.ts (セッション名解決)
  |     +-- timer-constants.ts [新規] (定数定義)
  |
  +-- session-cleanup.ts (worktree削除時のタイマーキャンセル)
  +-- resource-cleanup.ts (孤立エントリの定期検出)
  |
  +-- NotesAndLogsPane.tsx (SUB_TABSにTimer追加)
        |
        +-- TimerPane.tsx [新規] (UI: フォーム + カウントダウン + 一覧)
        |
        +-- locales/en/schedule.json (翻訳キー追加)
        +-- locales/ja/schedule.json (翻訳キー追加)

API:
  +-- /api/worktrees/[id]/timers/route.ts [新規] (POST/GET/DELETE)

テスト（影響あり）:
  +-- tests/unit/lib/session-cleanup.test.ts (既存修正)
  +-- tests/unit/lib/resource-cleanup.test.ts (既存修正)
  +-- tests/unit/lib/timer-manager.test.ts [新規]
  +-- tests/unit/lib/db/timer-db.test.ts [新規]

ドキュメント:
  +-- CLAUDE.md (モジュール一覧更新)
  +-- docs/module-reference.md (モジュールリファレンス更新)
```

## 再利用可能な既存リソース

| リソース | 再利用内容 |
|---------|-----------|
| `schedule-manager.ts` | globalThisパターン、initライフサイクル、stopForWorktreeパターン |
| `auto-yes-config.ts` | `formatTimeRemaining()`関数をカウントダウン表示で再利用可能 |
| `terminal/route.ts` | バリデーションパターン（MAX_COMMAND_LENGTH, isCliToolType） |
| `session-cleanup.ts` | クリーンアップ統合パターン（try-catch + pollersStopped配列） |
| `resource-cleanup.ts` | 孤立エントリ検出パターン（getDbWorktreeIds + Map走査） |

---

## 参照ファイル

### コード
- `server.ts`: サーバー初期化・シャットダウンライフサイクル（timer-manager統合が必要）
- `src/lib/session-cleanup.ts`: worktreeクリーンアップ（timer-manager停止処理の追加が必要）
- `src/lib/resource-cleanup.ts`: 孤立エントリ検出（timer-managerのMap検出追加が必要）
- `src/lib/schedule-manager.ts`: globalThisパターンの参考実装
- `src/components/worktree/NotesAndLogsPane.tsx`: SubTab型・SUB_TABS配列の拡張対象
- `src/lib/db/db-migrations.ts`: CURRENT_SCHEMA_VERSION=22、v23追加対象
- `src/app/api/worktrees/[id]/terminal/route.ts`: メッセージ送信パターンの参考

### ドキュメント
- `CLAUDE.md`: 主要モジュール一覧の更新が必要
- `docs/module-reference.md`: モジュールリファレンスの更新が必要
