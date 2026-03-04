# Issue #404 レビューレポート - 通常レビュー（1回目）

**レビュー日**: 2026-03-04
**フォーカス**: 通常レビュー（Consistency & Correctness）
**ステージ**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 7 |
| Nice to Have | 2 |

Issue #404は長期運用時のリソースリーク問題（孤立MCPプロセス + globalThis Mapメモリリーク）を適切に特定しているが、背景セクションの技術詳細に複数の不正確な記載がある。特にglobalThis Mapの所在ファイル・行番号・変数名の誤記は実装者の誤誘導リスクがあり、must_fixとして修正が必要である。

---

## Must Fix（必須対応）

### F1-001: `__scheduleActiveProcesses` はschedule-manager.tsではなくclaude-executor.tsに存在する

**カテゴリ**: 正確性
**場所**: 背景・課題 > 2. globalThis Mapメモリリーク

**問題**:
Issue本文で「`schedule-manager.ts` (L88-95): `__scheduleManagerStates`、`__scheduleActiveProcesses` Mapも同様」と記載されているが、`__scheduleActiveProcesses` は `claude-executor.ts` (L212-226) で宣言・管理されている。`schedule-manager.ts` には存在しない。

**証拠**:
```typescript
// claude-executor.ts L212-226
declare global {
  var __scheduleActiveProcesses: Map<number, import('child_process').ChildProcess> | undefined;
}

export function getActiveProcesses(): Map<number, import('child_process').ChildProcess> {
  if (!globalThis.__scheduleActiveProcesses) {
    globalThis.__scheduleActiveProcesses = new Map();
  }
  return globalThis.__scheduleActiveProcesses;
}
```

`schedule-manager.ts` は `getActiveProcesses()` を `claude-executor.ts` からimportして使用しているのみ（L24, L657）。

**推奨対応**:
以下のように2つに分けて正確に記載する:
- 「`schedule-manager.ts` (L106-109): `__scheduleManagerStates` Map」
- 「`claude-executor.ts` (L212-226): `__scheduleActiveProcesses` Map」

---

### F1-002: schedule-manager.tsの行番号L88-95が実コードと不一致

**カテゴリ**: 正確性
**場所**: 背景・課題 > 2. globalThis Mapメモリリーク

**問題**:
Issue本文で `schedule-manager.ts (L88-95)` と記載されているが、L88-95はDB行形状インターフェース定義の位置である。

**証拠**:
```typescript
// 実際のL88-95
interface ScheduleIdNameRow { id: string; name: string; }
interface ScheduleIdRow { id: string; }

// globalThis宣言の実際の位置: L106-109
declare global {
  var __scheduleManagerStates: ManagerState | undefined;
}
```

**推奨対応**:
行番号を L106-109 に修正する。

---

### F1-003: schedule-manager.tsのschedules MapのキーはworktreeIdではなくscheduleId / 既存の自己クリーンアップ機構への言及漏れ

**カテゴリ**: 正確性
**場所**: 背景・課題 > 2. globalThis Mapメモリリーク

**問題**:
Issue本文では「削除されたworktreeのエントリを保持し続ける」と記載しているが、`__scheduleManagerStates.schedules` MapのキーはscheduleIDである。さらに、`syncSchedules()` の60秒ポーリングサイクルで、`getAllWorktrees()` に含まれないworktreeのスケジュールは自動的にクリーンアップされる既存機構がある。

**証拠**:
```typescript
// schedule-manager.ts L579-586
// Clean up schedules that no longer exist in CMATE.md
for (const [scheduleId, state] of manager.schedules) {
  if (!activeScheduleIds.has(scheduleId)) {
    state.cronJob.stop();
    manager.schedules.delete(scheduleId);
    console.log(`[schedule-manager] Removed stale schedule ${state.entry.name}`);
  }
}
```

**推奨対応**:
既存の自己クリーンアップ機構を正確に記述し、「worktree削除直後の最大60秒間のリーク」と「worktree単位のスケジュール停止関数が存在しない点」を明確な課題として記述する。

---

## Should Fix（推奨対応）

### F1-004: session-cleanup.tsの既存問題 - stopAllSchedules()が全スケジュールを停止する過剰動作

**カテゴリ**: 完全性
**場所**: 実装タスク / 影響範囲テーブル

**問題**:
`session-cleanup.ts` L111で `cleanupWorktreeSessions()` 内から `stopAllSchedules()` を呼んでおり、1つのworktreeのクリーンアップ時に全worktreeのスケジュールが停止される。

**証拠**:
```typescript
// session-cleanup.ts L109-117
// 3. Stop schedule-manager (Issue #294)
try {
  stopAllSchedules();  // <-- 全スケジュールを停止してしまう
  result.pollersStopped.push('schedule-manager');
} catch (error) { ... }
```

`schedule-manager.ts` には `stopScheduleForWorktree(worktreeId)` のようなworktree単位の停止関数が存在しない。

**推奨対応**:
実装タスクに「`schedule-manager.ts` に `stopScheduleForWorktree(worktreeId)` 関数を追加し、`session-cleanup.ts` からworktree単位で呼び出すよう修正」を追加する。

---

### F1-005: autoYesStatesのdelete()不在が最重要リークであることの明示不足

**カテゴリ**: 完全性
**場所**: 実装タスク > globalThis Mapメモリリーク対策

**問題**:
`autoYesStates` Mapには `.delete()` 呼び出しが一切存在しない。`disableAutoYes()` は `set()` のみ実行。一方、`autoYesPollerStates` には `stopAutoYesPolling()` で `delete()` が存在する。Issue本文では両者を同列に記載しており、対処の優先度差が読み取れない。

**証拠**:
```typescript
// disableAutoYes() L264 - set()のみ
autoYesStates.set(worktreeId, state);

// stopAutoYesPolling() L789 - delete()あり
autoYesPollerStates.delete(worktreeId);
```

codebase全体で `autoYesStates.delete()` の呼び出しはゼロ件。

**推奨対応**:
実装タスクを具体化する:
- `auto-yes-manager.ts` に `deleteAutoYesState(worktreeId)` 関数を追加
- `session-cleanup.ts` の `cleanupWorktreeSessions()` から呼び出し

---

### F1-006: response-poller.tsのmodule-scope Mapが影響範囲テーブルに含まれていない

**カテゴリ**: 完全性
**場所**: 影響範囲テーブル

**問題**:
`response-poller.ts` の `tuiResponseAccumulator` Map (L184) はmodule-scopeだが、worktree削除時のクリーンアップ対象として検討されていない。`stopPolling()` は `activePollers` / `pollingStartTimes` の `delete()` を実行するが、`tuiResponseAccumulator` は `clearTuiAccumulator()` で個別にクリアされるのみで、worktree削除時の一括クリーンアップは未保証。

**推奨対応**:
影響範囲テーブルに追記するか、スコープ外として除外理由を明示する。

---

### F1-007: 「24時間ごとの定期クリーンアップ」の実装場所・方法が未記載

**カテゴリ**: 整合性
**場所**: 提案する解決策 > B / 実装タスク

**問題**:
「24時間ごとにDBに存在しないworktreeのエントリを自動削除（セーフティネット）」の実装詳細が不明。

**推奨対応**:
以下を明記する:
1. タイマー管理場所（新規モジュール or 既存schedule-managerへの相乗り）
2. 24時間間隔の根拠
3. タイマーのライフサイクル管理方法
4. 影響範囲テーブルへの該当ファイル追加

---

### F1-008: 孤立MCPプロセス検出のクロスプラットフォーム・コンテナ対応が未考慮

**カテゴリ**: 実現可能性
**場所**: 提案する解決策 > A / 実装タスク

**問題**:
`ppid=1` のプロセス検索はLinux/macOSで概ね機能するが、プロセス検索コマンドの差異やコンテナ環境での `ppid=1` 正常プロセス誤検出リスクが考慮されていない。

**推奨対応**:
- 対象OS (Linux/macOS) のプロセス検索方法統一案
- コンテナ環境での誤検出防止策
- プロセス名パターンの厳密定義（コマンドライン引数マッチング条件）

---

### F1-009: 受入条件「正常稼働中MCPプロセスに影響なし」の検証方法が不明

**カテゴリ**: 整合性
**場所**: 受入条件 > 2番目

**問題**:
コードベースにMCPプロセスのPID追跡・セッション紐付けロジックが存在しないため、「正常稼働中」と「孤立」の判定基準が受入条件から読み取れない。

**推奨対応**:
判定基準を明示する。例: 「ppid がCommandMateサーバープロセスのPIDであるMCPプロセスは停止対象から除外されること」

---

### F1-010: claude-executor.tsの`__scheduleActiveProcesses`が影響範囲テーブルに欠落

**カテゴリ**: 完全性
**場所**: 影響範囲テーブル

**問題**:
`claude-executor.ts` (L212-226) に `globalThis.__scheduleActiveProcesses` Map が存在する。子プロセスの `exit` イベントで `delete()` されるが、異常終了でイベント未発火時にエントリが残留する可能性がある。

**推奨対応**:
影響範囲テーブルに `claude-executor.ts` を追加する。

---

## Nice to Have（あれば良い）

### F1-011: auto-yes-manager.tsの行番号微修正

**カテゴリ**: 完全性
**場所**: 背景・課題 > auto-yes-manager.ts (L133-138)

Issue本文の行番号 L133-138 は概ね正確だが、declare global 部分 (L125-130) を含めた L125-138 がより正確な範囲。

---

### F1-012: 実装タスクにテスト戦略の具体化が不足

**カテゴリ**: 完全性
**場所**: 実装タスク > ユニットテスト

MCPプロセス検出のテスト方針（外部コマンドモック戦略）やglobalThis Mapクリーンアップのテスト方針が不明確。`clearAllAutoYesStates()` の既存パターンに倣った具体的テスト設計指針があると望ましい。

---

## 参照ファイル

### コード
| ファイル | 関連箇所 | 説明 |
|---------|----------|------|
| `src/lib/auto-yes-manager.ts` | L125-138, L252-266, L272-274, L779-791 | autoYesStates / autoYesPollerStates のglobalThis Map宣言と操作関数 |
| `src/lib/schedule-manager.ts` | L56-79, L106-124, L478-591, L634-660 | ManagerState型、globalThis宣言、syncSchedules()、stopAllSchedules() |
| `src/lib/claude-executor.ts` | L196-204, L210-226 | `__scheduleActiveProcesses` Mapの実際の所在地 |
| `src/lib/session-cleanup.ts` | L61-120 | cleanupWorktreeSessions() -- stopAllSchedules()の過剰呼び出し |
| `src/lib/response-poller.ts` | L184, L350, L355, L1273-1285 | module-scope Maps と stopPolling() |
| `src/app/api/repositories/route.ts` | L15, L92 | cleanupMultipleWorktrees()の呼び出し元 |
| `scripts/build-and-start.sh` | 全体 | MCPクリーンアップ追加先（存在確認済み） |

### ドキュメント
| ファイル | 説明 |
|---------|------|
| `CLAUDE.md` | 各モジュールの説明・依存関係の確認に使用 |
