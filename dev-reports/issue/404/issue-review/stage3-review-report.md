# Issue #404 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-04
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |

---

## Must Fix（必須対応）

### F3-001: worktree個別削除APIが存在しない -- cleanupWorktreeSessionsの呼び出しパスが不完全

**カテゴリ**: 影響範囲
**場所**: 受入条件セクション、影響範囲テーブル

**問題**:

Issue本文では「worktree削除後にglobalThis Mapから該当エントリが削除されること」を受入条件としている。しかし、コードベースにはworktree個別削除のDELETEエンドポイント（`DELETE /api/worktrees/[id]`）が存在しない。

実際のworktree削除はリポジトリ単位の削除（`DELETE /api/repositories`）経由でのみ実行される:

```
DELETE /api/repositories
  -> cleanupMultipleWorktrees(worktreeIds, killFn)  [L92]
    -> for each worktreeId:
      -> cleanupWorktreeSessions(worktreeId, killFn)  [L137]
        -> stopResponsePolling()  [L90]
        -> stopAutoYesPolling()   [L101]
        -> stopAllSchedules()     [L111]  <-- 全worktree停止（問題）
```

ファイルパス: `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/src/app/api/repositories/route.ts`（L92）

**影響**:

- 影響範囲テーブルに `src/app/api/repositories/route.ts` が含まれていない
- worktree個別削除のユースケースが存在しないことが明記されていない
- 将来worktree個別削除APIが追加された場合に `cleanupWorktreeSessions` 呼び出しが漏れるリスクがある

**推奨対応**:

影響範囲テーブルに `src/app/api/repositories/route.ts` を追加し、worktree削除が `cleanupMultipleWorktrees` 経由でのみ実行される旨を明記する。

---

### F3-002: stopScheduleForWorktree()の実装にschedules MapのキーがscheduleId（UUID）である制約の考慮が必要

**カテゴリ**: 影響範囲
**場所**: 実装タスク「schedule-manager.tsにstopScheduleForWorktree(worktreeId)関数を追加」

**問題**:

`schedule-manager.ts` の `ManagerState.schedules` Map は以下の構造を持つ:

```typescript
// キー: scheduleId（UUID）  -- worktreeIdではない
schedules: Map<string, ScheduleState>

interface ScheduleState {
  scheduleId: string;    // UUID
  worktreeId: string;    // これでフィルタリングが必要
  cronJob: Cron;
  isExecuting: boolean;
  entry: ScheduleEntry;
}
```

ファイルパス: `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/src/lib/schedule-manager.ts`（L43-54, L61）

`stopScheduleForWorktree(worktreeId)` を実装する際、全エントリをイテレーションして `worktreeId` が一致するものを探す必要がある。

さらに、`cmateFileCache` のキーは **worktree path** であり（L79）、worktreeId からpathへの変換にDB参照が必要になる:

```typescript
cmateFileCache: Map<string, number>  // キー: worktree path
```

**推奨対応**:

実装タスクに以下の設計制約を追記する:
1. `schedules` Map はイテレーション走査で `worktreeId` フィルタリングを行う
2. `cmateFileCache` のキーは worktree path であるため、worktreeId -> path 変換が必要（DB lookupまたは `cleanupWorktreeSessions` 呼び出し元から worktreePath を引数で渡す設計を検討）

---

## Should Fix（推奨対応）

### F3-003: autoYesStates.delete()とactiveなpollAutoYes()のレース条件

**カテゴリ**: 並行処理
**場所**: 実装タスク「session-cleanup.tsにdeleteAutoYesState(worktreeId)呼び出しを追加」

**問題**:

`cleanupWorktreeSessions()` 内で `deleteAutoYesState(worktreeId)` を呼ぶタイミングによっては、非同期実行中の `pollAutoYes()` がawaitポイントの後に `getAutoYesState()` を呼び、`null` を受け取る可能性がある。

Node.js はシングルスレッドであるため、同期コード内では割り込みが発生しないが、`pollAutoYes()` 内には複数のawaitポイントがある（`captureAndCleanOutput()`、`detectAndRespondToPrompt()`）。

現在のコードフロー:
```
session-cleanup.ts:
  1. stopAutoYesPolling(worktreeId)  -- L101: clearTimeout + pollerStates.delete
  2. stopAllSchedules()             -- L111
  -> 提案: deleteAutoYesState(worktreeId)を追加
```

ファイルパス: `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/src/lib/auto-yes-manager.ts`（L652-693, L779-791）

**分析**:

`stopAutoYesPolling()` がタイマーを `clearTimeout()` するため、次回の `pollAutoYes()` はスケジュールされない。しかし、既に実行中（await中）の `pollAutoYes()` インスタンスは `clearTimeout` では中断できない。`validatePollingContext()` がpollerStateの存在を確認しており（L481）、`stopAutoYesPolling()` がpollerStatesから削除済みのため `'stopped'` を返して早期リターンする。実害はないが、順序保証を明記すべき。

**推奨対応**:

Issue本文に `cleanupWorktreeSessions()` 内の呼び出し順序を明記する:
1. `stopAutoYesPolling(worktreeId)` -- タイマークリア + pollerState削除
2. `deleteAutoYesState(worktreeId)` -- autoYesStates削除

---

### F3-004: response-poller.tsのtuiResponseAccumulatorはstopPolling()で既にクリーンアップ済み

**カテゴリ**: 影響範囲
**場所**: 実装タスク「response-poller.tsのtuiResponseAccumulator Mapからworktreeエントリを削除する処理をsession-cleanup.tsに追加」

**問題**:

`stopPolling()` の実装を確認すると、内部で `clearTuiAccumulator(pollerKey)` が既に呼ばれている:

```typescript
// /Users/maenokota/share/work/github_kewton/commandmate-issue-404/src/lib/response-poller.ts L1273-1285
export function stopPolling(worktreeId: string, cliToolId: CLIToolType): void {
  const pollerKey = getPollerKey(worktreeId, cliToolId);
  const timerId = activePollers.get(pollerKey);

  if (timerId) {
    clearTimeout(timerId);
    activePollers.delete(pollerKey);
    pollingStartTimes.delete(pollerKey);
  }

  // Clean up TUI accumulator if present
  clearTuiAccumulator(pollerKey);  // <-- L1284
}
```

`session-cleanup.ts` は全CLI_TOOL_IDsに対して `stopResponsePolling(worktreeId, cliToolId)` を呼んでいるため（L90）、`tuiResponseAccumulator` のクリーンアップは既に行われている。

ただし、`activePollers` にエントリがない場合（ポーリング未開始状態）でも `clearTuiAccumulator()` は条件外で呼ばれるため（L1284はif文の外）、確実に削除される。

**影響**:

`tuiResponseAccumulator` と `activePollers` / `pollingStartTimes` はモジュールスコープ変数であり globalThis ではないため、hot reload時にリセットされる。本番環境でのみリーク対象となるが、`stopPolling()` で既に対応済み。

**推奨対応**:

実装タスクの「response-poller.tsのtuiResponseAccumulator Mapからworktreeエントリを削除する処理をsession-cleanup.tsに追加」を「stopPolling()内のclearTuiAccumulator()で既にクリーンアップ済みであることを確認」に変更するか、タスクを削除する。

---

### F3-005: 孤立MCPプロセスのppid=1チェックはコンテナ環境で偽陽性リスクがある

**カテゴリ**: セキュリティ
**場所**: 実装タスク「孤立MCPプロセスの検出ロジック実装（ppid=1のcodex/playwright-mcpプロセス検索）」

**問題**:

ppid=1 による孤立プロセス検出は以下の環境で偽陽性を引き起こす:

| 環境 | ppid=1の意味 | 偽陽性リスク |
|------|------------|------------|
| macOS（ネイティブ） | launchdに再親化された孤立プロセス | 低（意図通り） |
| Docker/コンテナ | コンテナ内のEntrypointプロセスの正規子プロセス | 高 |
| systemd（subreaper有効） | systemdに再親化されたプロセス（ppid != 1の場合あり） | 検出漏れ |

受入条件に「正常に稼働中のMCPプロセスに影響がないこと」があるため、コンテナ環境での偽陽性は受入条件違反となる。

**推奨対応**:

多段階検出ロジックの記載を推奨:
1. ppid=1チェック
2. プロセス起動時刻とCommandMate起動時刻の比較
3. コマンドライン引数のパターンマッチング
4. Docker環境検出時（`/.dockerenv` ファイル存在等）はppid=1チェックをスキップ

---

### F3-006: テスト計画の具体的シナリオ不足

**カテゴリ**: テスト
**場所**: 実装タスク「ユニットテスト」

**問題**:

「ユニットテスト」とのみ記載されており、具体的なテストシナリオが列挙されていない。以下の既存テストに影響がある:

| テストファイル | 影響内容 |
|-------------|---------|
| `tests/unit/session-cleanup.test.ts` | `stopAutoYesPolling` / `stopAllSchedules` のモック検証に加え、`deleteAutoYesState` / `stopScheduleForWorktree` の呼び出し検証が必要 |
| `tests/unit/lib/auto-yes-manager.test.ts` | `deleteAutoYesState()` の新規テストケース追加が必要 |
| `tests/unit/lib/schedule-manager.test.ts` | `stopScheduleForWorktree()` の新規テストケース追加が必要 |

ファイルパス:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/tests/unit/session-cleanup.test.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/tests/unit/lib/auto-yes-manager.test.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/tests/unit/lib/schedule-manager.test.ts`

**推奨対応**:

テストシナリオを具体化する:

```
auto-yes-manager.test.ts:
- deleteAutoYesState() 正常系: delete後にgetAutoYesState()がnull返却
- deleteAutoYesState() 存在しないworktreeId: エラーなく完了
- deleteAutoYesState() pollerStatesに影響しないこと

schedule-manager.test.ts:
- stopScheduleForWorktree() worktree単位でcronJob.stop() + schedules.delete()
- stopScheduleForWorktree() 他worktreeのスケジュールに非影響
- stopScheduleForWorktree() cmateFileCacheの部分削除

session-cleanup.test.ts:
- cleanupWorktreeSessions()がdeleteAutoYesState()を呼出
- cleanupWorktreeSessions()がstopScheduleForWorktree()を呼出
- stopAllSchedules()が呼ばれないこと
```

---

## Nice to Have（あれば良い）

### F3-007: 定期クリーンアップ（24時間ごと）の実装場所と起動タイミングが未定義

**カテゴリ**: 影響範囲
**場所**: 提案する解決策B

`schedule-manager.ts` の `syncSchedules()` は60秒ポーリングで既にDB存在チェックを行い、存在しないworktreeのスケジュールを自動クリーンアップする。定期クリーンアップの対象はautoYesStatesとautoYesPollerStatesに限定される可能性がある。実装モジュール、起動タイミング、graceful shutdown時の停止方法を記載すると良い。

---

### F3-008: cleanupMultipleWorktrees()のforループ動作変更の明記

**カテゴリ**: 影響範囲
**場所**: 実装タスク「stopAllSchedules()をstopScheduleForWorktree(worktreeId)に変更」

現在の動作: forループ内の1回目のcleanupWorktreeSessions()でstopAllSchedules()が呼ばれ、全worktreeの全スケジュールが停止。2回目以降は空のMapに対して操作。

変更後の動作: 各worktreeのスケジュールのみが個別に停止。他worktreeへの影響なし。

この動作改善を明記すると、レビュアーの理解が促進される。

---

## 参照ファイル

### コード

| ファイル | 行番号 | 関連内容 |
|---------|--------|---------|
| `src/lib/session-cleanup.ts` | L61-120 | cleanupWorktreeSessions() -- stopAllSchedules()の全スケジュール停止問題 |
| `src/lib/auto-yes-manager.ts` | L132-138, L252-266, L779-791 | autoYesStates Map、disableAutoYes()、stopAutoYesPolling() |
| `src/lib/schedule-manager.ts` | L43-54, L61, L79, L478-591, L634-669 | ScheduleState構造、schedules Map、cmateFileCache、syncSchedules()、stopAllSchedules() |
| `src/lib/response-poller.ts` | L184, L339-341, L350-355, L1273-1285 | tuiResponseAccumulator、clearTuiAccumulator()、activePollers、stopPolling() |
| `src/lib/claude-executor.ts` | L196-206, L212-226 | __scheduleActiveProcesses Map、exit イベントハンドラー |
| `src/app/api/repositories/route.ts` | L57-167 | DELETE /api/repositories -- cleanupMultipleWorktrees()呼び出し元 |

### テスト

| ファイル | 関連内容 |
|---------|---------|
| `tests/unit/session-cleanup.test.ts` | 既存テスト -- 新規関数呼び出し検証の追加が必要 |
| `tests/unit/lib/auto-yes-manager.test.ts` | 既存テスト -- deleteAutoYesState()テスト追加が必要 |
| `tests/unit/lib/schedule-manager.test.ts` | 既存テスト -- stopScheduleForWorktree()テスト追加が必要 |

### ドキュメント

| ファイル | 関連内容 |
|---------|---------|
| `CLAUDE.md` | 各モジュールの概要記述 |
