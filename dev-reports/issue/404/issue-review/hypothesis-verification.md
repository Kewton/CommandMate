# Issue #404 仮説検証レポート

## 検証日時
- 2026-03-04

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | ターミナル切断・セッション異常終了時に子プロセス（MCP）が孤立残留する | Confirmed | OS動作として既知の挙動（ppid=1へのリペアレント）で、コード上に起動したプロセスの追跡・回収ロジックが存在しない |
| 2 | `auto-yes-manager.ts` L133-138 の `__autoYesStates` Mapが削除worktreeのエントリを保持し続ける | Confirmed | `autoYesStates.delete(worktreeId)` 呼び出しが存在しない。`disableAutoYes()` は `set()` のみ実行 |
| 3 | `auto-yes-manager.ts` の `__autoYesPollerStates` Mapが削除worktreeのエントリを保持し続ける | Partially Confirmed | `stopAutoYesPolling()` (L789) で `autoYesPollerStates.delete(worktreeId)` は存在するが、worktree削除時に確実に呼ばれる経路が不明確 |
| 4 | `schedule-manager.ts` L88-95 の `__scheduleManagerStates`・`__scheduleActiveProcesses` Mapが削除worktreeのエントリを保持し続ける | Partially Confirmed | 行番号・構造が実コードと乖離あり（後述）。`manager.schedules` Mapにはworktree削除時の個別エントリ削除パスが存在しない |

## 詳細検証

### 仮説 1: 孤立MCPプロセスの残留

**Issue内の記述**: 「ターミナル切断やセッション異常終了時に、子プロセスとして起動されたMCPサーバーが孤立プロセスとして残留する」「実測でNodeプロセスが43個稼働中」

**検証手順**:
1. `src/lib/` 配下でMCPプロセス管理コードを検索
2. tmux.ts / claude-session.ts / codex.ts のプロセス起動・終了ロジックを確認

**判定**: Confirmed

**根拠**:
- コードベース内でMCPサーバー起動後のプロセスPID追跡・グレースフルシャットダウンロジックが存在しない
- OSの動作として、親プロセスが異常終了した場合、子プロセスはppid=1（init/launchd）にリペアレントされる
- 「43個」の実測値はコードから検証不可だが、プロセス残留の機構は確認済み

**Issueへの影響**: 仮説は正しい。実装タスクに矛盾なし。

---

### 仮説 2: `autoYesStates` Mapメモリリーク

**Issue内の記述**: 「`auto-yes-manager.ts` (L133-138): `__autoYesStates`、`__autoYesPollerStates` Mapが削除されたworktreeのエントリを保持し続ける」

**検証手順**:
1. `src/lib/auto-yes-manager.ts` L133-138 を確認（実際はL133-134, L136-138）
2. `autoYesStates.delete()` の呼び出し箇所を検索
3. `disableAutoYes()` の実装を確認（L252-265）

**判定**: Confirmed（`autoYesStates`については完全に確認）

**根拠**:
```typescript
// L133-134
const autoYesStates = globalThis.__autoYesStates ??
  (globalThis.__autoYesStates = new Map<string, AutoYesState>());

// disableAutoYes() L264: set()のみ、delete()なし
autoYesStates.set(worktreeId, state);

// 全ファイル内でautoYesStates.delete()の呼び出しはゼロ件
```
- `autoYesStates` に対して `delete(worktreeId)` は一度も呼ばれていない
- worktree削除後も `enabled: false` の状態エントリが永続的に残留する

**Issueへの影響**: 記述内容は正確。ただし行番号はL133-138ではなくL133-134が正確（軽微）。

---

### 仮説 3: `autoYesPollerStates` Mapメモリリーク

**検証手順**:
1. `stopAutoYesPolling()` の実装を確認（L779-791）
2. `session-cleanup.ts` での呼び出しを確認

**判定**: Partially Confirmed

**根拠**:
```typescript
// L789: delete()は存在する
autoYesPollerStates.delete(worktreeId);

// session-cleanup.ts L101: worktreeクリーンアップ時に呼ばれる
stopAutoYesPolling(worktreeId);
```
- `stopAutoYesPolling()` は削除パスを持つが、worktree削除APIルートが `cleanupWorktreeSessions()` を呼ぶ保証は別途要確認
- ポーリング中でない（タイマーなし）worktreeのPollerStatesエントリは別の経路で残留する可能性あり

---

### 仮説 4: `schedule-manager.ts` Mapメモリリーク（行番号・構造の乖離）

**Issue内の記述**: 「`schedule-manager.ts` (L88-95): `__scheduleManagerStates`、`__scheduleActiveProcesses` Mapも同様」

**検証手順**:
1. `src/lib/schedule-manager.ts` L88-95, L106-124 を確認
2. グローバル変数宣言・初期化箇所を確認

**判定**: Partially Confirmed（機能的な懸念は正しいが、詳細記述に乖離）

**根拠**:
```typescript
// 実際のL88-95はDB行形状インターフェース定義
interface ScheduleIdNameRow { id: string; name: string; }
interface ScheduleIdRow { id: string; }

// globalThis宣言はL106-109
declare global {
  var __scheduleManagerStates: ManagerState | undefined;
}

// __scheduleActiveProcesses は存在しない
// claude-executor.ts から getActiveProcesses() をimport
```

**Issueへの影響**:
- 行番号（L88-95）は実コードと一致しない（L106-109が正しい）
- `__scheduleActiveProcesses` という変数名は存在しない（`getActiveProcesses()` in `claude-executor.ts`）
- ただし機能的な懸念（worktree削除時にスケジュールエントリが残留する）は正しい

**修正提案**: Issue本文のファイルパス・行番号・変数名を正確な情報に更新すべき

---

## Stage 1レビューへの申し送り事項

1. **Partially Confirmed（仮説4）**: `schedule-manager.ts`の行番号L88-95は不正確（実際はL106-109）、`__scheduleActiveProcesses`という変数名は存在しない。Issue本文の影響範囲表に記載されている変更内容を再確認すること

2. **Partially Confirmed（仮説3）**: `autoYesPollerStates`については削除パスは存在するが、worktree削除時のAPI経路から確実に呼ばれるかどうかをレビュー時に指摘すること

3. **実装スコープの確認**: 「`scripts/build-and-start.sh`へのMCPクリーンアップ追加」が実装タスクに含まれているが、このファイルが存在するかどうかを確認すること
