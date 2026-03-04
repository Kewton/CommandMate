# Issue #404 レビューレポート - Stage 7

**レビュー日**: 2026-03-04
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 1 |
| Nice to Have | 1 |

---

## 前回指摘事項（Stage 3）の対応状況

| ID | 重要度 | ステータス | 確認内容 |
|----|--------|-----------|---------|
| F3-001 | must_fix | resolved | 影響範囲テーブルに `src/app/api/repositories/route.ts` が追加済み。個別worktree削除APIが存在しない旨も明記 |
| F3-002 | must_fix | resolved | `stopScheduleForWorktree()` の実装上の注意1・2に `schedules` MapのキーがscheduleId（UUID）である制約と `cmateFileCache` のworktree path変換ロジックが必要な点を明記済み |
| F3-003 | should_fix | resolved | `deleteAutoYesState(worktreeId)` の順序制約（`stopAutoYesPolling()` の後に実行）が実装タスクに追記済み。レース防止の理由も説明されている |
| F3-004 | should_fix | resolved | `response-poller.ts` の記述が「`stopPolling()` 内の `clearTuiAccumulator()` で既に対応済みの確認 + 未カバーケースの補完」に更新済み |
| F3-005 | should_fix | partially_resolved | コンテナ環境の偽陽性リスク注記が追加されたが、Docker環境検出時のスキップ等の追加防御策は反映されていない。実用上は十分であり、Issueの粒度としては許容可能 |

---

## Must Fix（必須対応）

### F7-001: `__scheduleActiveProcesses` のキーがworktreeIdであるという記述が事実と異なる

**カテゴリ**: 正確性
**場所**: 実装タスク > globalThis Mapメモリリーク対策 > `stopScheduleForWorktree(worktreeId)` > 実装上の注意3

**問題**:

Issue本文の実装上の注意3に以下の記述がある:

> `__scheduleActiveProcesses` のキーはworktreeId（`executeClaudeCommand()` のL212参照）であるため、`activeProcesses.get(worktreeId)` で直接ルックアップが可能

しかし、`claude-executor.ts` のコードを確認すると:

```typescript
// L212-214: 型宣言
var __scheduleActiveProcesses: Map<number, import('child_process').ChildProcess> | undefined;

// L199: Mapへのセット
activeProcesses.set(child.pid, child);

// L202: Mapからの削除
activeProcesses.delete(child.pid!);
```

キーは `child.pid`（number型）であり、worktreeIdではない。`executeClaudeCommand()` は `worktreeId` 情報を `cwd` 引数として受け取るが、`activeProcesses` Mapには記録しない。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/src/lib/claude-executor.ts` L199: `activeProcesses.set(child.pid, child)` -- キーはPID
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/src/lib/claude-executor.ts` L214: `Map<number, import('child_process').ChildProcess>` -- 型もnumber
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/src/lib/schedule-manager.ts` L657-658: `stopAllSchedules()` も `for (const [pid] of activeProcesses)` でPIDキーを使用

**影響**:

この誤記に基づいて `stopScheduleForWorktree()` を実装すると、`activeProcesses.get(worktreeId)` がundefinedを返し、当該worktreeの子プロセス停止が無効になる。TypeScriptの型チェックでキーの型不一致（string vs number）が検出される可能性はあるが、ランタイムでは `Map.get()` はundefinedを返すだけでエラーにならないため、静かなバグとなるリスクがある。

**推奨対応**:

実装上の注意3を以下のように修正する:

> `__scheduleActiveProcesses` のキーはPID（number型）であり、値はChildProcessオブジェクトである（`claude-executor.ts` L199, L214参照）。worktreeIdによる直接ルックアップは不可能。`stopScheduleForWorktree()` でworktree単位のプロセス停止を実現するには、以下のいずれかの方法を検討すること:
>   (a) `executeClaudeCommand()` から `activeProcesses` MapをMap<number, { child: ChildProcess, worktreeId: string }>に拡張する
>   (b) `schedule-manager.ts` の `executeSchedule()` 内で `child.pid` と `worktreeId` の対応を別途管理するローカルMapを導入する
>   (c) `stopScheduleForWorktree()` では `activeProcesses` のworktree単位停止を責務外とし、子プロセスは `exit` eventによる自然回収に委ねる（`cronJob.stop()` で新規実行は防止されるため、実行中プロセスの即座の停止が不要であれば許容可能）

---

## Should Fix（推奨対応）

### F7-002: resource-cleanup.tsとstopScheduleForWorktree()の責務拡大に対応するテストシナリオが未反映

**カテゴリ**: テスト
**場所**: 実装タスク > ユニットテスト、受入条件

**問題**:

Stage 5/6で明確化された以下の設計変更に対応するテストシナリオが、実装タスクのユニットテスト項目（単一のチェックボックスのみ）に反映されていない:

1. `stopScheduleForWorktree()` の3責務（cronジョブ停止、cmateFileCache削除、activeProcesses停止）の個別検証
2. `resource-cleanup.ts` 新規モジュールの24時間タイマーライフサイクル
3. `session-cleanup.ts` の変更後の呼び出し順序検証

既存の `session-cleanup.test.ts`（L11-13）は `response-poller` のみモックしており、`auto-yes-manager` と `schedule-manager` のモックが不足している。Issue #404の変更後に大幅なモック追加が必要。

**推奨対応**:

実装タスクのユニットテスト項目を以下のように具体化する:

```
- [ ] session-cleanup.test.ts: cleanupWorktreeSessions()がstopAutoYesPolling() -> deleteAutoYesState() -> stopScheduleForWorktree()の順序で呼び出すことの検証
- [ ] session-cleanup.test.ts: cleanupWorktreeSessions()がstopAllSchedules()を呼ばないことの検証（回帰テスト）
- [ ] schedule-manager.test.ts: stopScheduleForWorktree(worktreeId)が当該worktreeのcronジョブのみ停止し、他worktreeのスケジュールに影響しないことの検証
- [ ] schedule-manager.test.ts: stopScheduleForWorktree(worktreeId)が当該worktreeのcmateFileCacheエントリのみ削除することの検証
- [ ] auto-yes-manager.test.ts: deleteAutoYesState(worktreeId)がautoYesStatesからエントリを削除しautoYesPollerStatesには影響しないことの確認
- [ ] resource-cleanup.test.ts: 24時間タイマーの開始・停止ライフサイクルテスト
- [ ] resource-cleanup.test.ts: DBに存在しないworktreeIdの孤立エントリが検出・削除されることの検証
```

---

## Nice to Have（あれば良い）

### F7-003: resource-cleanup.tsのserver.ts統合が影響範囲テーブルに未記載

**カテゴリ**: 影響範囲
**場所**: 影響範囲テーブル

**問題**:

Issue本文の実装タスクでは「サーバー起動時（`initScheduleManager()` 完了後）にタイマーを開始し、graceful shutdown時に `clearInterval` で停止する」と記載されているが、影響範囲テーブルに `server.ts` が含まれていない。

`server.ts` の変更内容:
- L259の `initScheduleManager()` の直後に `initResourceCleanup()` 呼び出し追加
- L275-281の `gracefulShutdown()` 内に `stopResourceCleanup()` 呼び出し追加
- import文追加

変更自体は軽微（import追加 + 関数呼び出し2箇所）であるが、影響範囲テーブルの完全性のため追加が望ましい。

**推奨対応**:

影響範囲テーブルに以下を追加する:

| `server.ts` | `initResourceCleanup()` の呼び出し追加（`initScheduleManager()` の後）および `gracefulShutdown()` 内に `stopResourceCleanup()` 追加 |

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/src/lib/claude-executor.ts` (L196-226) | `__scheduleActiveProcesses` Map<number, ChildProcess> -- キーはchild.pid。F7-001の根拠 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/src/lib/schedule-manager.ts` (L24, L421-463, L634-669) | executeClaudeCommand/getActiveProcesses import、executeSchedule()、stopAllSchedules() |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/src/lib/session-cleanup.ts` (L10-12, L61-120) | stopAllSchedules import、cleanupWorktreeSessions() -- Issue #404変更対象 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/src/lib/auto-yes-manager.ts` (L132-138, L252-266, L779-791) | autoYesStates/autoYesPollerStates宣言、disableAutoYes()、stopAutoYesPolling() |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/src/lib/response-poller.ts` (L184, L339-341, L1273-1285) | tuiResponseAccumulator、clearTuiAccumulator()、stopPolling()内クリーンアップ |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/src/app/api/repositories/route.ts` (L15, L92) | cleanupMultipleWorktrees呼び出し元 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/server.ts` (L45, L258-259, L274-281) | initScheduleManager/stopAllSchedules import、ライフサイクル管理 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-404/tests/unit/session-cleanup.test.ts` | 既存テスト -- response-pollerのみモック、Issue #404変更後に追加必要 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | 各モジュール概要（session-cleanup、auto-yes-manager、schedule-manager、claude-executor、response-poller） |
