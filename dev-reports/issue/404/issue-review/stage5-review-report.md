# Issue #404 レビューレポート（Stage 5）

**レビュー日**: 2026-03-04
**フォーカス**: 通常レビュー（2回目）
**ステージ**: Stage 5

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

Stage 1で指摘した5件の重要指摘（must_fix 3件 + should_fix 2件）は全て適切に対応されており、Issue全体の技術的正確性と完全性は大幅に改善された。Issue全体としての読みやすさ・一貫性は良好であり、実装者が作業に着手できる品質に達している。

---

## 前回指摘の対応状況

| ID | 重要度 | ステータス | 確認内容 |
|----|--------|-----------|---------|
| F1-001 | must_fix | **resolved** | `__scheduleActiveProcesses` の所在が `claude-executor.ts (L212-226)` に正しく修正されている |
| F1-002 | must_fix | **resolved** | `schedule-manager.ts` の行番号が `L106-109` に正しく修正されている |
| F1-003 | must_fix | **resolved** | `syncSchedules()` の60秒ポーリングによる自己クリーンアップ機構が詳細に説明されている。`schedules` MapのキーがscheduleIdであること、最大60秒間のリーク窓、worktree単位停止関数の不在が明確に記述されている |
| F1-004 | should_fix | **resolved** | `stopScheduleForWorktree(worktreeId)` の追加が実装タスクと提案解決策の両方に含まれている |
| F1-005 | should_fix | **resolved** | `autoYesStates` の `.delete()` 不在が背景セクションで明示され、`deleteAutoYesState(worktreeId)` 関数追加が実装タスクに含まれている |

---

## Should Fix（推奨対応）

### F5-001: stopScheduleForWorktree()がstopAllSchedules()のタイマー停止・activeProcesses停止機能を代替しない設計制約の明示不足

**カテゴリ**: 完全性
**場所**: 実装タスク > globalThis Mapメモリリーク対策 > `stopScheduleForWorktree(worktreeId)` 関連タスク

**問題**:

現在の `stopAllSchedules()` は以下の5つの責務を担っている:

1. グローバルポーリングタイマーの停止 (`clearInterval(manager.timerId)`)
2. 全cronジョブの停止
3. `schedules.clear()`
4. `cmateFileCache.clear()`
5. 全activeProcessesの `SIGKILL` + `clear()` (`claude-executor.ts` の `getActiveProcesses()` 経由)

`session-cleanup.ts` から `stopAllSchedules()` を `stopScheduleForWorktree(worktreeId)` に置き換える際、上記(5)の子プロセス停止機能が失われる。当該worktreeで実行中のスケジュールの子プロセス停止を `stopScheduleForWorktree()` の責務に含めるか、別途対処するか、設計判断が必要である。

**証拠**:

`src/lib/schedule-manager.ts` L634-665で `stopAllSchedules()` は `getActiveProcesses()` 経由で全PIDs `SIGKILL` を行っている。`stopScheduleForWorktree()` がこの機能を持たない場合、worktree削除時に実行中のスケジュールの子プロセスが孤立する。

**推奨対応**:

実装タスクに `stopScheduleForWorktree(worktreeId)` の責務範囲を明記する:
- (a) 当該worktreeのcronジョブ停止 + schedules Mapエントリ削除
- (b) 当該worktreeのcmateFileCacheエントリ削除
- (c) 当該worktreeで実行中のactiveProcessesの停止（該当する場合）
- `stopAllSchedules()` はサーバーシャットダウン時専用として整理する

---

### F5-002: 定期クリーンアップ（24時間）の実装場所・タイマー管理が依然として未定義

**カテゴリ**: 整合性
**場所**: 実装タスク > globalThis Mapメモリリーク対策 > 定期クリーンアップ関数の実装

**問題**:

「提案する解決策 > B」に「24時間ごとにDBに存在しないworktreeのエントリを自動削除（セーフティネット）」と記載されているが、実装タスクでは「定期クリーンアップ関数の実装（既存worktreeIDとMapキーの差分検出）」としか書かれておらず、以下が不明のままである:

- (a) タイマー管理の場所（新規モジュール or 既存schedule-managerのsyncSchedules()への相乗り or server.ts起動時のsetInterval）
- (b) タイマーのライフサイクル（サーバーシャットダウン時のclearInterval）
- (c) 24時間の間隔の根拠

**推奨対応**:

以下のいずれかを追記する:

**(A) 具体化案**: 「schedule-manager.tsの `syncSchedules()` （60秒ポーリング）に24時間カウンター（`lastCleanupTimestamp`）を追加し、24時間経過時にglobalThis全Mapの孤立エントリ削除を実行する。既存タイマーに相乗りするため新規setIntervalは不要」

**(B) スコープ委任案**: 「定期クリーンアップのタイマー管理方法は実装設計で決定する。設計書でタイマーライフサイクル（開始・停止タイミング）を明示すること」

---

## Nice to Have（あれば良い）

### F5-003: 受入条件「正常に稼働中のMCPプロセスに影響がないこと」の検証方法

**カテゴリ**: 明確性
**場所**: 受入条件 > 2番目の項目

**問題**:

受入条件の「正常に稼働中のMCPプロセス（現在のセッションに紐づくもの）に影響がないこと」は、孤立プロセスとの区別基準が実装タスクの注記で補足されている（ppid=1 + プロセス名パターンの複合チェック）ものの、受入条件自体には検証方法が明示されていない。

**推奨対応**:

「ppid=1以外のMCPプロセス（活動中のtmuxセッションの子プロセス）が停止されないこと」のように具体化する。

---

### F5-004: stopScheduleForWorktree()のcmateFileCache削除のworktreeId->path変換の解法推奨案

**カテゴリ**: 完全性
**場所**: 実装タスク > globalThis Mapメモリリーク対策 > stopScheduleForWorktree 実装上の注意2

**問題**:

実装タスクの注意2に「DB lookupで取得するか、`cleanupWorktreeSessions()` の呼び出し元から `worktreePath` を引数で渡す設計を検討すること」と2つの選択肢が併記されているが、推奨案が不明である。

**推奨対応**:

推奨案を一方に絞るか、「設計書で決定する」と明記する。例: 「`cleanupWorktreeSessions()` のシグネチャ変更を最小限にするため、`stopScheduleForWorktree()` 内でDB lookupする方式を推奨する」

---

## 参照ファイル

### コード

| ファイル | 行番号 | 関連性 |
|---------|--------|--------|
| `src/lib/schedule-manager.ts` | L56-80, L106-124, L478-591, L634-669 | ManagerState型、globalThis宣言、syncSchedules()自己クリーンアップ、stopAllSchedules()の5責務 |
| `src/lib/claude-executor.ts` | L195-226 | `__scheduleActiveProcesses` MapのPID追跡、exitイベントでのdelete() |
| `src/lib/auto-yes-manager.ts` | L125-138, L252-266, L272-274, L779-789 | autoYesStates/autoYesPollerStates宣言、disableAutoYes()、stopAutoYesPolling() |
| `src/lib/session-cleanup.ts` | L61-120 | cleanupWorktreeSessions() - stopAllSchedules()呼び出し箇所（L111） |
| `src/lib/response-poller.ts` | L184, L339, L1273-1285 | tuiResponseAccumulator Map、clearTuiAccumulator()、stopPolling() |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | session-cleanup.ts, auto-yes-manager.ts, schedule-manager.ts, claude-executor.ts のモジュール説明 |

---

## 総合評価

Issue #404は、Stage 1〜4を経て技術的正確性・整合性・完全性の面で十分な品質に達した。前回のmust_fix 3件は全て解消されており、影響範囲レビュー（Stage 3）の指摘も適切に反映されている。

残る2件のshould_fixは設計フェーズで解決可能な範囲であり、Issueの承認を妨げるものではない。実装者がスムーズに作業を開始できる状態である。
