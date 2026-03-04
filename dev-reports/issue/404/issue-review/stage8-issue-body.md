> **Note**: このIssueは 2026-03-04 にStage 7レビュー結果（影響範囲レビュー2回目）を反映して更新されました。
> 詳細: dev-reports/issue/404/issue-review/

## 概要

長期運用時に蓄積するリソースリーク（孤立MCPプロセス・globalThis Mapメモリリーク）を一括で対処する。

## 背景・課題

### 1. 残留MCPプロセス（旧 #404）

- ターミナル切断やセッション異常終了時に、子プロセスとして起動されたMCPサーバーが孤立プロセスとして残留する
- 実測でNodeプロセスが43個稼働中、そのうち多数がcodex mcp-serverやplaywright-mcp
- 長期運用でプロセス数が蓄積し、メモリ消費が増加する

### 2. globalThis Mapメモリリーク（旧 #407）

- `auto-yes-manager.ts` (L133-138): `__autoYesStates`、`__autoYesPollerStates` Mapが削除されたworktreeのエントリを保持し続ける
  - **注**: `autoYesStates` には `.delete()` 呼び出しが一切存在しない（`disableAutoYes()` は `set()` で `enabled: false` に更新するのみでエントリ自体は残留する）。一方 `autoYesPollerStates` は `stopAutoYesPolling()` で `delete()` が存在する。`autoYesStates` の方がリーク確定度が高く、対処の優先度が明確に高い
- `schedule-manager.ts` (L106-109): `__scheduleManagerStates` Mapが削除されたworktreeのスケジュールエントリを保持し続ける
  - **注**: `schedules` MapのキーはworktreeIdではなくschedule IDである。`syncSchedules()` の60秒ポーリングサイクルで `getAllWorktrees()` から取得したworktree一覧に基づき、`activeScheduleIds` に含まれないスケジュールは自動的に `cronJob.stop()` と `schedules.delete()` される（L579-586）。つまり、worktreeがDB上で削除されれば次の `syncSchedules()` サイクル（最大60秒後）でスケジュールエントリは自動クリーンアップされる。ただし、worktree削除直後の最大60秒間はリークが発生し、またサーバー全体停止ではなくworktree単位でスケジュールを停止する関数が存在しない点が課題である
- `claude-executor.ts` (L212-226): `__scheduleActiveProcesses` Mapがプロセス終了後もエントリを保持する可能性がある
  - **注**: 子プロセスの `exit` イベントで `delete()` されるため通常運用ではリークしないが、プロセスが異常終了して `exit` イベントが発火しないケースではエントリが残留する可能性がある
- 長期運用でworktreeの作成・削除を繰り返すと、メモリ使用量が単調増加する
- 各リーク対象はタイマー参照（`setInterval`/`setTimeout`）を含むため、タイマーリークも併発

## 提案する解決策

### A. 孤立MCPプロセスのクリーンアップ

- サーバー起動時に孤立MCPプロセス（親プロセスがinit/launchdのcodex mcp-server等）を検出
- ユーザー確認なしで自動停止（or 警告ログ出力のみ）
- `stop.sh`にもMCPプロセスクリーンアップを追加（オプション）

### B. globalThis Mapクリーンアップ

- `session-cleanup.ts`のクリーンアップフローにglobalThis Mapのエントリ削除を追加
- `session-cleanup.ts` の `cleanupWorktreeSessions()` 内で `stopAllSchedules()` を呼んでいる箇所を、worktree単位の `stopScheduleForWorktree(worktreeId)` に変更する（現状は1つのworktreeのクリーンアップ時に全worktreeのスケジュールが停止される過剰動作）
  - **`stopAllSchedules()` との責務分担**: `stopAllSchedules()` はサーバーシャットダウン時専用とし、5つの責務（(1)グローバルポーリングタイマー停止、(2)全cronジョブ停止、(3)schedules.clear()、(4)cmateFileCache.clear()、(5)全activeProcessesのSIGKILL+clear()）を維持する。`stopScheduleForWorktree(worktreeId)` はworktree単位の停止に特化し、(1)グローバルタイマーや(5)全activeProcesses停止は行わない
- 24時間ごとにDBに存在しないworktreeのエントリを自動削除（セーフティネット）
  - **実装方針**: `src/lib/resource-cleanup.ts` を新規モジュールとして作成し、`setInterval` で24時間ごとにglobalThis Mapの孤立エントリを検出・削除する。`initScheduleManager()` の後（サーバー起動シーケンス内）でタイマーを開始し、graceful shutdown時に `clearInterval` で停止する。スキャン対象は `autoYesStates` と `autoYesPollerStates` とする（`schedule-manager.ts` の `schedules` Mapは `syncSchedules()` の60秒ポーリングで既に自動クリーンアップ済みのため対象外）

## 実装タスク

### 孤立MCPプロセス対策
- [ ] 孤立MCPプロセスの検出ロジック実装（`ppid=1`のcodex/playwright-mcpプロセス検索）
  - **注意（コンテナ環境での偽陽性リスク）**: `ppid=1` チェックはmacOS/Linux環境依存であり、以下の環境で偽陽性が発生する:
    - **Dockerコンテナ内**: PID 1はEntrypointプロセスであり、正規の子プロセスも `ppid=1` となる
    - **systemd環境**: subreaper機能により `ppid=1` 以外の値になる場合がある
  - **推奨**: `ppid=1` に加えてプロセス名パターン（`codex mcp-server`、`playwright-mcp`）のコマンドライン引数マッチングによる複合チェックを行い、偽陽性を低減すること
- [ ] `scripts/build-and-start.sh`起動時のクリーンアップ処理追加
- [ ] クリーンアップ対象プロセスのパターン定義（codex mcp-server、playwright-mcp等）
- [ ] ログ出力（停止したプロセス数の報告）

### globalThis Mapメモリリーク対策
- [ ] `auto-yes-manager.ts` に `deleteAutoYesState(worktreeId)` 関数を追加（`autoYesStates.delete()` 実行）
  - **注**: `autoYesPollerStates` は `stopAutoYesPolling()` で既に `delete()` されるが、`autoYesStates` には `.delete()` が存在しないため別途追加が必要
- [ ] `schedule-manager.ts` に `stopScheduleForWorktree(worktreeId)` 関数を追加（worktree単位のスケジュール停止・エントリ削除）
  - **責務範囲**: `stopScheduleForWorktree(worktreeId)` は以下の3つの責務を担う:
    - (a) 当該worktreeのcronジョブ停止 + `schedules` Mapエントリ削除
    - (b) 当該worktreeの `cmateFileCache` エントリ削除
    - (c) 当該worktreeで実行中の `activeProcesses` の停止（`__scheduleActiveProcesses` 内の該当worktreeのプロセスをSIGKILLし、エントリを削除する）
  - **`stopAllSchedules()` はサーバーシャットダウン時専用に整理**: `session-cleanup.ts` からの呼び出しは `stopScheduleForWorktree(worktreeId)` に完全に置き換え、`stopAllSchedules()` はサーバー全体停止時のみ使用する
  - **実装上の注意1**: `ManagerState.schedules` MapのキーはscheduleId（UUID）であり、worktreeIdによる直接ルックアップ（`Map.delete(worktreeId)`）は不可能。全エントリをイテレーション走査し、`ScheduleState.worktreeId` フィールドが一致するものをフィルタリングする実装が必要（エントリ数は `MAX_CONCURRENT_SCHEDULES=100` 以下のため性能問題なし）
  - **実装上の注意2**: `cmateFileCache` のキーはworktree pathであり、worktreeId -> path変換ロジックが必要。DB lookupで取得するか、`cleanupWorktreeSessions()` の呼び出し元からworktreePathを引数で渡す設計を検討すること
  - **実装上の注意3**: `__scheduleActiveProcesses` のキーはPID（`number`型）であり、値は `ChildProcess` オブジェクトである（`claude-executor.ts` L199: `activeProcesses.set(child.pid, child)`、L214: `Map<number, import('child_process').ChildProcess>`）。worktreeIdによる直接ルックアップは不可能。`stopScheduleForWorktree()` でworktree単位のプロセス停止を実現するには、以下のいずれかの方法を検討すること:
    - **(a)** `executeClaudeCommand()` の `activeProcesses` Mapを`Map<number, { child: ChildProcess, worktreeId: string }>`に拡張し、worktreeIdを記録する。呼び出し元の `executeSchedule()` (schedule-manager.ts L445) は `state.worktreeId` を保持しているが、現在の `executeClaudeCommand(message, cwd, cliToolId, permission, options)` のシグネチャにはworktreeIdパラメータが存在しない。`ExecuteCommandOptions` にworktreeId?フィールドを追加するか、新たな引数として追加する設計変更が必要
    - **(b)** `schedule-manager.ts` の `executeSchedule()` 内でchild.pidとworktreeIdの対応を別途管理するローカルMapを導入する（ただし `executeClaudeCommand()` は非同期でPromiseを返すため、子プロセスのPIDを直接取得する手段がない点に注意）
    - **(c)** `stopScheduleForWorktree()` ではactiveProcessesのworktree単位停止を責務外とし、子プロセスはexitイベントによる自然回収に委ねる（`cronJob.stop()` で新規実行は防止されるため、実行中プロセスの即座の停止が不要であれば許容可能。`EXECUTION_TIMEOUT_MS=5分` で最大待機時間も限定的）
- [ ] `session-cleanup.ts` の `cleanupWorktreeSessions()` から `stopAllSchedules()` を `stopScheduleForWorktree(worktreeId)` に変更
- [ ] `session-cleanup.ts` に `deleteAutoYesState(worktreeId)` 呼び出しを追加
  - **順序制約（レース防止）**: `deleteAutoYesState(worktreeId)` は必ず `stopAutoYesPolling(worktreeId)` の呼び出し後に実行すること。先に `autoYesStates` を削除すると、進行中の `pollAutoYes()` が `getAutoYesState()` で `null` を取得し、`stopAutoYesPolling()` が呼ばれる不要な経路が発生する。`stopAutoYesPolling()` でタイマークリア + `pollerState` 削除を完了してから `autoYesStates` を削除する順序が安全
- [ ] `response-poller.ts` の `tuiResponseAccumulator` Mapのworktreeエントリクリーンアップ確認
  - **注**: `stopPolling()` 内の `clearTuiAccumulator(pollerKey)` 呼び出し（L1284）で既にクリーンアップされる。ただし、ポーリングが開始されていないworktree（`activePollers.has()` がfalse）では `clearTuiAccumulator` が呼ばれない可能性があるため、念のため `tuiResponseAccumulator` の直接削除も検討すること
- [ ] `claude-executor.ts` の `__scheduleActiveProcesses` Mapの異常終了時リーク対策確認、必要に応じてクリーンアップ処理追加
- [ ] 定期クリーンアップ関数の実装（既存worktreeIDとMapキーの差分検出）
  - **実装場所**: `src/lib/resource-cleanup.ts`（新規モジュール）
  - **タイマー管理**: `setInterval` で24時間周期。サーバー起動時（`initScheduleManager()` 完了後）にタイマーを開始し、graceful shutdown時に `clearInterval` で停止する
  - **スキャン対象**: `autoYesStates` と `autoYesPollerStates`（`schedule-manager.ts` の `schedules` Mapは `syncSchedules()` の60秒ポーリングで既に自動クリーンアップ済みのため対象外）
  - **クリーンアップロジック**: `getAllWorktrees()` でDB上の有効なworktreeId一覧を取得し、各Mapのキーと差分を検出、孤立エントリを削除する
- [ ] Mapエントリ削除時のタイマー解放確認
- [ ] ユニットテスト
  - [ ] `session-cleanup.test.ts`: `cleanupWorktreeSessions()` が `stopAutoYesPolling()` -> `deleteAutoYesState()` -> `stopScheduleForWorktree()` の順序で呼び出すことの検証
  - [ ] `session-cleanup.test.ts`: `cleanupWorktreeSessions()` が `stopAllSchedules()` を呼ばないことの検証（回帰テスト）
  - [ ] `auto-yes-manager.test.ts`: `deleteAutoYesState(worktreeId)` が `autoYesStates` からエントリを削除し、`autoYesPollerStates` には影響しないことの確認
  - [ ] `schedule-manager.test.ts`: `stopScheduleForWorktree(worktreeId)` が当該worktreeのcronジョブのみ停止し、他worktreeのスケジュールに影響しないことの検証
  - [ ] `schedule-manager.test.ts`: `stopScheduleForWorktree(worktreeId)` が当該worktreeの `cmateFileCache` エントリのみ削除し、他worktreeのキャッシュに影響しないことの検証
  - [ ] `resource-cleanup.test.ts`: `initResourceCleanup()` で24時間タイマーが開始され、`stopResourceCleanup()` で `clearInterval` されることのライフサイクルテスト
  - [ ] `resource-cleanup.test.ts`: DBに存在しないworktreeIdの `autoYesStates`/`autoYesPollerStates` エントリが検出・削除されることの検証（孤立エントリDelta検出ロジック）

## 受入条件

- [ ] サーバー起動時に孤立MCPプロセスが検出・停止されること
- [ ] 正常に稼働中のMCPプロセス（現在のセッションに紐づくもの）に影響がないこと
- [ ] クリーンアップ結果がログに記録されること
- [ ] worktree削除後にglobalThis Mapから該当エントリが削除されること
- [ ] 削除されたエントリのタイマーが確実に解放されること
- [ ] 定期クリーンアップが孤立エントリを検出・削除すること
- [ ] 正常稼働中のworktreeに影響がないこと

## 影響範囲

| ファイル | 変更内容 |
|---------|---------|
| `scripts/build-and-start.sh` | 起動時MCPプロセスクリーンアップ追加 |
| `src/lib/session-cleanup.ts` | Mapエントリ削除処理追加、`stopAllSchedules()` を `stopScheduleForWorktree(worktreeId)` に変更 |
| `src/lib/auto-yes-manager.ts` | `deleteAutoYesState(worktreeId)` エクスポート関数追加 |
| `src/lib/schedule-manager.ts` | `stopScheduleForWorktree(worktreeId)` エクスポート関数追加（cronジョブ停止 + schedules/cmateFileCache/activeProcessesのworktree単位クリーンアップ） |
| `src/lib/claude-executor.ts` | `__scheduleActiveProcesses` Mapの異常終了時リーク対策確認、必要に応じてクリーンアップ処理追加 |
| `src/lib/response-poller.ts` | `tuiResponseAccumulator` Mapのworktreeエントリクリーンアップ（既存 `stopPolling()` の `clearTuiAccumulator()` 呼び出しで対応済みの確認、未カバーケースの補完） |
| `src/lib/resource-cleanup.ts` | **新規**: 24時間定期クリーンアップ（`autoYesStates`/`autoYesPollerStates` の孤立エントリ検出・削除、`setInterval`/`clearInterval` タイマー管理） |
| `src/app/api/repositories/route.ts` | `cleanupMultipleWorktrees()` の呼び出し元。worktree削除はリポジトリ単位削除（DELETE /api/repositories）経由でのみ実行され、個別worktree削除APIは現時点で存在しない |
| `server.ts` | `initResourceCleanup()` の呼び出し追加（`initScheduleManager()` の後）および `gracefulShutdown()` 内に `stopResourceCleanup()` 追加 |

## 統合元Issue

- #407 （このIssueに統合）

---

## レビュー履歴

### イテレーション 1 (2026-03-04)

**適用した指摘事項:**
- F1-001 (must_fix): `__scheduleActiveProcesses` の所在を `schedule-manager.ts` から `claude-executor.ts` (L212-226) に修正
- F1-002 (must_fix): `schedule-manager.ts` の行番号を L88-95 から L106-109 に修正
- F1-003 (must_fix): `schedule-manager.ts` の `syncSchedules()` 60秒ポーリングによる自動クリーンアップ機構の説明を追記、課題を明確化
- F1-004 (should_fix): `session-cleanup.ts` の `stopAllSchedules()` を worktree単位の `stopScheduleForWorktree(worktreeId)` に変更するタスクを追加
- F1-005 (should_fix): `autoYesStates` の `.delete()` 不在を明示し、`deleteAutoYesState(worktreeId)` 関数追加タスクを追加
- F1-006 (should_fix): 影響範囲テーブルに `src/lib/response-poller.ts` を追加（`tuiResponseAccumulator` Mapクリーンアップ）
- F1-010 (should_fix): 影響範囲テーブルに `src/lib/claude-executor.ts` を追加（`__scheduleActiveProcesses` Mapクリーンアップ）

### イテレーション 2 (2026-03-04) - Stage 3 影響範囲レビュー

**適用した指摘事項:**
- F3-001 (must_fix): 影響範囲テーブルに `src/app/api/repositories/route.ts` を追加（`cleanupMultipleWorktrees` の呼び出し元として記載、個別worktree削除APIが存在しない旨を明記）
- F3-002 (must_fix): `stopScheduleForWorktree(worktreeId)` 実装タスクに設計制約を追記（`schedules` MapのキーがscheduleId（UUID）のためイテレーション走査が必要、`cmateFileCache` のキーがworktree pathのためworktreeId->path変換ロジックが必要）
- F3-003 (should_fix): `deleteAutoYesState(worktreeId)` の実装タスクに順序制約を追記（`stopAutoYesPolling(worktreeId)` の後に実行、進行中ポーリングとのレース防止）
- F3-004 (should_fix): `response-poller.ts` の影響範囲テーブルと実装タスクを更新（`stopPolling()` 内の `clearTuiAccumulator()` で既に対応済みの確認 + 未カバーケースの補完）
- F3-005 (should_fix): 孤立MCPプロセス検出タスクにコンテナ環境での偽陽性リスク注記を追加（Docker/systemd環境の考慮、プロセス名パターンの複合チェック推奨）

### イテレーション 3 (2026-03-04) - Stage 5 通常レビュー2回目

**適用した指摘事項:**
- F5-001 (should_fix): `stopScheduleForWorktree(worktreeId)` の責務範囲を明確化。(a)cronジョブ停止+schedulesエントリ削除、(b)cmateFileCacheエントリ削除、(c)当該worktreeのactiveProcesses停止の3責務を明記。`stopAllSchedules()` はサーバーシャットダウン時専用に整理
- F5-002 (should_fix): 定期クリーンアップの実装方針を具体化。実装場所を `src/lib/resource-cleanup.ts`（新規モジュール）、タイマー管理を `setInterval` + graceful shutdown時 `clearInterval`、スキャン対象を `autoYesStates`/`autoYesPollerStates`（schedules Mapは既に自動クリーンアップ済みのため対象外）と明記。影響範囲テーブルにも追加

**スキップした指摘事項:**
- F5-003 (nice_to_have): 受入条件「正常に稼働中のMCPプロセスに影響がないこと」の検証方法具体化 - 実装タスクのコンテナ環境注記で実質カバーされており、実装者の混乱リスクは低いため
- F5-004 (nice_to_have): `stopScheduleForWorktree()` のcmateFileCache削除の推奨案絞り込み - 設計書レベルの詳細でありIssueの粒度としては許容範囲内のため

### イテレーション 4 (2026-03-04) - Stage 7 影響範囲レビュー2回目

**適用した指摘事項:**
- F7-001 (must_fix): `__scheduleActiveProcesses` のキーがworktreeIdであるという誤記を修正。実際のキーはPID（number型）であり、worktreeIdとの関連付けがMap上に存在しないことを正確に記載。worktree単位プロセス停止のための3つの実装アプローチ（(a) Map構造拡張、(b) ローカル対応Map導入、(c) 自然回収委任）を提示
- F7-002 (should_fix): ユニットテスト項目を7つの具体的なテストシナリオに展開（session-cleanup順序検証、回帰テスト、deleteAutoYesState副作用確認、stopScheduleForWorktree分離検証、cmateFileCache分離検証、resource-cleanupライフサイクル、孤立エントリ検出）
- F7-003 (nice_to_have): 影響範囲テーブルに `server.ts` を追加（`initResourceCleanup()` / `stopResourceCleanup()` の組み込み先）
