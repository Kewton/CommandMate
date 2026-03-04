# Architecture Review: Issue #404 長期運用時のリソースリーク対策

**Issue**: #404
**Stage**: 1 - 通常レビュー
**Focus Area**: 設計原則 (SOLID/KISS/YAGNI/DRY)
**Status**: 条件付き承認 (Conditionally Approved)
**Score**: 4/5
**Date**: 2026-03-04

---

## Executive Summary

設計方針書は全体として堅実であり、SOLID/KISS/YAGNI原則に対する配慮が随所に見られる。特にactiveProcessesの方式(c)自然回収採用やschedule-managerとの責務分離は妥当な判断である。ただし、DRY原則違反のMCPプロセス検出ロジックのshell/TypeScript二重実装が必須修正として存在する。推奨修正3件、検討事項3件を含め、計7件の指摘を行う。

---

## Detailed Findings

### 必須改善項目 (Must Fix) - 1件

#### R1-001: MCPプロセス検出ロジックのshell/TypeScript二重実装 [DRY]

**Severity**: must_fix
**Location**: 設計方針書 Section 3.1 + Section 3.6、Section 6 トレードオフ表

**問題**:

設計方針書Section 3.1の`cleanupOrphanedMcpProcesses()`（TypeScript、`execFile('ps', ...)`）とSection 3.6の`cleanup_orphaned_mcp_processes()`（bash、`ps -eo pid,ppid,args | awk`）が同一のビジネスロジックを異なる言語で二重実装している。

- TypeScript側: `MCP_PROCESS_PATTERNS = ['codex mcp-server', 'playwright-mcp']`
- bash側: `patterns=("codex mcp-server" "playwright-mcp")`

設計方針書Section 6でも「トレードオフ: 重複コード」と自認しているが、パターン追加・変更時の同期漏れリスクは実運用上の問題となりうる。

**根拠**:

`server.ts`の起動シーケンスを確認すると、`initResourceCleanup()`は`server.listen()`コールバック内で呼ばれ、この時点でNode.jsプロセスは完全に起動済みである。`build-and-start.sh`は`npm run build:all`の後に`npm start`を実行する構成であり、ビルド済みのTypeScriptモジュールを呼び出すことが可能である。

**修正案**:

`build-and-start.sh`のbash関数を廃止し、代わりにビルド済みTypeScriptモジュールを直接呼び出す。

```bash
# build-and-start.sh: build完了後、npm start前に実行
echo "=== Cleaning up orphaned MCP processes ==="
node -e "require('./dist/lib/resource-cleanup').cleanupOrphanedMcpProcesses().then(r => { if(r.killed > 0) console.log('[MCP Cleanup] Stopped ' + r.killed + ' orphaned MCP process(es)') })" || echo "WARNING: MCP cleanup failed, continuing" >&2
```

---

### 推奨改善項目 (Should Fix) - 3件

#### R1-002: resource-cleanup.tsの2責務混在の明確な責務分離 [SRP]

**Severity**: should_fix
**Location**: 設計方針書 Section 3.1 責務の記載

**問題**:

`resource-cleanup.ts`は以下の2つの異なる関心事を持つ。

1. 孤立MCPプロセスの検出・停止 -- 外部プロセスの管理（OS操作）
2. globalThis Map孤立エントリの定期クリーンアップ -- Node.jsプロセス内のメモリ管理

これらの変更理由は異なる。MCPプロセスのパターン変更はCLIツール追加時に、Mapクリーンアップは新しいglobalThis Mapの追加時に発生する。

**修正案**:

現時点では1ファイル内の2関数として実装する判断は許容範囲だが、以下を推奨する。

- ファイル内のセクション区切りコメントで責務境界を明確にする
- `initResourceCleanup()`はオーケストレーターとして設計し、各責務は独立してテスト可能にする
- JSDocに将来の分離ポイントを記載する

```typescript
// =============================================================================
// Section A: Orphaned MCP Process Cleanup (startup-only)
// Future split candidate: src/lib/mcp-process-cleanup.ts
// =============================================================================

// =============================================================================
// Section B: GlobalThis Map Periodic Cleanup (24h interval)
// Future split candidate: src/lib/map-entry-cleanup.ts
// =============================================================================

// =============================================================================
// Section C: Lifecycle Orchestrator
// =============================================================================
```

---

#### R1-003: stopScheduleForWorktree()のworktreePath?オプション引数の設計改善 [インターフェース]

**Severity**: should_fix
**Location**: 設計方針書 Section 3.3 インターフェース定義、Section 3.4 呼び出しコード

**問題**:

`stopScheduleForWorktree(worktreeId: string, worktreePath?: string)`の`worktreePath`オプション引数について、実際の呼び出し元を分析すると以下の状況が確認される。

1. `session-cleanup.ts`の`cleanupWorktreeSessions()`は`worktreeId`のみを引数に持つ（Section 3.4のコード例でも`stopScheduleForWorktree(worktreeId)`と呼んでいる）
2. `worktreePath`が省略された場合、関数内部でDB lookupが発生する
3. オプション引数の存在が関数の動作を暗黙的に分岐させる

**修正案**:

方式(B)を推奨: `worktreePath`を関数シグネチャから除去し、内部実装でDB lookupを行う。

```typescript
// Before
export function stopScheduleForWorktree(worktreeId: string, worktreePath?: string): void;

// After (KISS)
export function stopScheduleForWorktree(worktreeId: string): void {
  // Internal: DB lookup for cmateFileCache key
  const worktree = db.prepare('SELECT path FROM worktrees WHERE id = ?')
    .get(worktreeId) as { path: string } | undefined;

  if (worktree) {
    manager.cmateFileCache.delete(worktree.path);
  }
  // ... schedule cleanup ...
}
```

`cmateFileCache`のキーがpath、`schedules`のキーがscheduleIdであるため、DB lookupは避けられない。この1回のDB lookupのコストは、worktree削除というまれな操作において無視できる。

---

#### R1-004: session-cleanup.tsの既存stopAllSchedules()呼び出しの計算量 [OCP]

**Severity**: should_fix
**Location**: 設計方針書 Section 3.3 実装上の制約、Section 3.4 変更箇所

**問題**:

現在の`session-cleanup.ts`（L109-117）で`stopAllSchedules()`を呼び出している箇所を`stopScheduleForWorktree()`に置換する変更は正しい修正方向だが、`schedules` MapのキーがscheduleIdのため、worktreeId逆引きに全エントリのイテレーションが必要（O(M)、M=全スケジュール数）。`cleanupMultipleWorktrees()`がN個のworktreeを順次処理すると、合計O(N*M)の計算量になる。

**修正案**:

`MAX_CONCURRENT_SCHEDULES=100`と小さいため実運用上の問題にはならないが、設計方針書に以下を追記することを推奨する。

- 現在のO(N*M)計算量が許容範囲である根拠（MAX_CONCURRENT_SCHEDULES=100）
- 将来的にworktreeId -> Set<scheduleId>の逆引きインデックス追加が有効になるケースの記載

---

### 検討事項 (Consider) - 3件

#### R1-005: getAutoYesStateWorktreeIds()/getAutoYesPollerWorktreeIds()のカプセル化 [YAGNI/ISP]

**Severity**: nice_to_have
**Location**: 設計方針書 Section 3.2 新規エクスポート関数

**問題**:

`@internal` exportとはいえ、auto-yes-manager.tsの公開APIが3関数増加する。定期クリーンアップ専用の関数をexportするのではなく、クリーンアップ責務自体をauto-yes-manager.ts内に閉じ込める方がカプセル化の観点で優れている。

**修正案**:

```typescript
// auto-yes-manager.ts に追加
/**
 * Remove orphaned entries not in the given valid worktree ID set.
 * @internal Exported for resource-cleanup periodic scanning.
 */
export function cleanupOrphanedEntries(validWorktreeIds: Set<string>): {
  statesRemoved: number;
  pollersRemoved: number;
} {
  let statesRemoved = 0;
  let pollersRemoved = 0;

  for (const worktreeId of autoYesStates.keys()) {
    if (!validWorktreeIds.has(worktreeId)) {
      autoYesStates.delete(worktreeId);
      statesRemoved++;
    }
  }
  for (const worktreeId of autoYesPollerStates.keys()) {
    if (!validWorktreeIds.has(worktreeId)) {
      stopAutoYesPolling(worktreeId); // timer cleanup
      pollersRemoved++;
    }
  }

  return { statesRemoved, pollersRemoved };
}
```

これにより`getAutoYesStateWorktreeIds()`/`getAutoYesPollerWorktreeIds()`のexportが不要になり、resource-cleanup.tsはDB照会で有効なworktreeId一覧を取得してこの関数に渡すだけになる。

---

#### R1-006: コンテナ環境検出ロジックの簡素化検討 [KISS]

**Severity**: nice_to_have
**Location**: 設計方針書 Section 3.1 孤立MCPプロセス検出ロジック、Section 4 セキュリティ設計

**問題**:

`/proc/1/cgroup`存在チェックによるDocker環境検出は、以下の点でKISS原則に反する可能性がある。

- LXC、systemd-nspawnなど他のコンテナランタイムでも`/proc/1/cgroup`は存在する
- macOS環境では`/proc`が存在しないため常に非コンテナと判定される
- コンテナ内でもMCPプロセスクリーンアップが必要なケースがある

**修正案**:

CommandMateの実際のデプロイメントパターンを確認し、コンテナ環境が想定されない場合はこのロジックを省略する。想定される場合は、環境変数`CM_SKIP_MCP_CLEANUP=true`のような明示的なオプトアウト機構の方がシンプルで確実である。

---

#### R1-007: resource-cleanup.tsの依存方向の将来設計 [DIP]

**Severity**: nice_to_have
**Location**: 設計方針書 Section 3.1 インターフェース、Section 2.2 変更対象モジュール

**問題**:

`resource-cleanup.ts`は`auto-yes-manager.ts`と`schedule-manager.ts`に直接依存する。現時点のクリーンアップ対象は2つだが、将来的に`response-poller`のMap等が追加される可能性がある。

**修正案**:

現時点では直接依存で問題ない（YAGNI原則を優先）。将来クリーンアップ対象が3つ以上になった場合に備え、コメントで拡張ポイントを示す。

```typescript
// Future: If cleanup targets exceed 3, consider CleanupTarget interface:
// interface CleanupTarget {
//   getOrphanedEntryCount(validIds: Set<string>): number;
//   cleanupOrphaned(validIds: Set<string>): number;
// }
```

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | MCPパターン二重管理の同期漏れ | Medium | Medium | P1 (R1-001で対処) |
| 技術的リスク | stopScheduleForWorktree()のschedules Map全走査 | Low | Low | P3 (MAX_CONCURRENT_SCHEDULES=100で緩和済み) |
| セキュリティリスク | 誤プロセスkill | Low | Low | P3 (ppid=1+パターンマッチ複合チェックで緩和済み) |
| 運用リスク | 24時間間隔の孤立エントリ残留 | Low | Medium | P3 (disabled状態のため実害なし) |

---

## Design Principle Compliance Checklist

| 原則 | 評価 | 備考 |
|------|------|------|
| SRP (単一責任) | OK (条件付き) | resource-cleanup.tsの2責務は上位概念で束ねられるが、責務境界の明示を推奨 (R1-002) |
| OCP (開放閉鎖) | OK | 既存モジュールへの追加は関数追加のみで既存動作を変更しない |
| LSP (リスコフ置換) | OK | 新関数の型・インターフェースは既存パターンと一貫性がある |
| ISP (インターフェース分離) | OK (条件付き) | getAutoYesStateWorktreeIds等のexportはカプセル化改善で不要にできる (R1-005) |
| DIP (依存性逆転) | OK | 依存方向は上位→下位で適切 |
| KISS (単純性) | OK | activeProcesses方式(c)自然回収は好例。コンテナ検出は簡素化余地あり (R1-006) |
| YAGNI (不要機能排除) | Good | activeProcessesのMap構造拡張を見送った判断は優秀 |
| DRY (重複排除) | NG | MCP検出ロジックの二重実装は必須修正 (R1-001) |

---

## Approval Status

**条件付き承認 (Conditionally Approved)**

以下の条件を満たした上で実装に進むことを推奨する。

1. **必須**: R1-001 MCPプロセス検出ロジックのTypeScript一本化によるDRY原則準拠
2. **推奨**: R1-003 stopScheduleForWorktree()のシグネチャ簡素化（worktreePath引数除去）

---

## Reviewed Files

| ファイル | 確認内容 |
|---------|---------|
| `dev-reports/design/issue-404-resource-leak-cleanup-design-policy.md` | 設計方針書（レビュー対象） |
| `src/lib/session-cleanup.ts` | 既存Facadeパターン、stopAllSchedules()呼び出し箇所 |
| `src/lib/auto-yes-manager.ts` | globalThis Map構造、既存export関数パターン |
| `src/lib/schedule-manager.ts` | schedules Map構造、cmateFileCache、stopAllSchedules()実装 |
| `src/lib/claude-executor.ts` | activeProcesses Map構造、ExecuteCommandOptions型 |
| `server.ts` | 起動シーケンス、gracefulShutdown実装 |
| `scripts/build-and-start.sh` | 起動スクリプト構成 |
| `src/app/api/repositories/route.ts` | cleanupMultipleWorktrees呼び出し元 |
