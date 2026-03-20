# Architecture Review: Issue #526 - 設計原則レビュー (Stage 1)

**Issue**: #526 - syncWorktreesToDB() tmuxセッションクリーンアップ
**Focus**: 設計原則 (SOLID / KISS / YAGNI / DRY)
**Stage**: 1 (通常レビュー)
**Date**: 2026-03-20
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

設計方針書は全体として高品質であり、方針(B)「戻り値返却」の採用判断は SRP および DIP の観点から適切である。worktrees.ts にセッション管理の依存を追加しないという決定は、既存アーキテクチャの責務分離を維持している。

主要な改善ポイントは DRY 原則に関する1件で、5箇所以上の呼び出し元で同一の「sync + cleanup」パターンが重複する設計になっている点について、共通ヘルパー関数の導入を推奨する。

---

## Design Principles Checklist

### SOLID Principles

| 原則 | 判定 | 評価 |
|------|------|------|
| SRP (単一責務) | PASS | worktrees.ts は Git+DB 同期の責務を維持。session-cleanup.ts への killWorktreeSession 共通化も Facade の責務範囲内。 |
| OCP (開放閉鎖) | PASS (注意あり) | 新 CLI ツール追加時は CLI_TOOL_IDS に追加するだけで対応可能。ただし設計書のコード例で isRunning() の非同期性が不明確。 |
| LSP (リスコフ置換) | N/A | 継承関係を使用していないため該当なし。 |
| ISP (インターフェース分離) | PASS | KillSessionFn 型が適切に分離されており、呼び出し元は不要な依存を持たない。 |
| DIP (依存性逆転) | PASS | cleanupMultipleWorktrees が killSessionFn を引数で受け取る設計は DIP に準拠。 |

### Other Principles

| 原則 | 判定 | 評価 |
|------|------|------|
| KISS | PASS | イベント駆動方式を不採用とし、既存パターン踏襲で複雑性を抑制。 |
| YAGNI | PASS (注意あり) | upsertedCount は現時点で使用箇所がなく、追加の必要性を再検討すべき。 |
| DRY | 要改善 | 5箇所以上で同一パターンが重複。共通ヘルパー関数の導入で改善可能。 |

---

## Detailed Findings

### Must Fix (1件)

#### MF-001: クリーンアップ呼び出しパターンの重複 [DRY]

**問題**: 設計書 Section 4-3 ~ 4-7 で、以下の同一パターンが5箇所以上で繰り返される。

```typescript
const syncResult = syncWorktreesToDB(db, worktrees);
if (syncResult.deletedIds.length > 0) {
  await cleanupMultipleWorktrees(syncResult.deletedIds, killWorktreeSession);
}
```

**影響ファイル**:
- `src/app/api/repositories/sync/route.ts`
- `src/app/api/repositories/scan/route.ts`
- `src/app/api/repositories/restore/route.ts`
- `src/lib/git/clone-manager.ts`
- `server.ts`

**推奨**: `session-cleanup.ts` に以下のようなヘルパー関数を追加する。

```typescript
export async function syncWorktreesAndCleanup(
  db: Database.Database,
  worktrees: Worktree[],
  killSessionFn: KillSessionFn
): Promise<{ syncResult: SyncResult; cleanupResult?: CleanupResult }> {
  const syncResult = syncWorktreesToDB(db, worktrees);
  let cleanupResult: CleanupResult | undefined;
  if (syncResult.deletedIds.length > 0) {
    cleanupResult = await cleanupMultipleWorktrees(syncResult.deletedIds, killSessionFn);
  }
  return { syncResult, cleanupResult };
}
```

これにより worktrees.ts の責務は変わらず、session-cleanup.ts が「同期後クリーンアップ」の協調ロジックを担う形になる。方針(B)の本質（責務分離）を維持しつつ DRY 違反を解消できる。

---

### Should Fix (4件)

#### SF-001: SyncResult 型の配置場所 [SRP]

SyncResult を worktrees.ts に定義する設計は、現時点では妥当だが、型がクリーンアップ連携で使われる以上、将来的に `src/types/` への移動を検討すべき。現在の規模では許容範囲。

#### SF-002: excludedPaths 処理と sync 処理のクリーンアップ順序の不一致 [SRP]

設計書 Section 4-7 において:
- **excludedPaths 処理**: cleanup を先に実行してから DB 削除
- **sync 処理**: syncWorktreesToDB 内で DB 削除が行われた後に cleanup

この順序の不一致が設計書に明記されていない。sync 側では DB 削除後に cleanup が失敗しても次回 sync で再試行可能という設計は妥当だが、その理由を設計書に記載すべき。

#### SF-003: 並列化変更の影響範囲の明示 [KISS]

Section 6 で `cleanupMultipleWorktrees` の内部ループを `Promise.allSettled` に変更する提案があるが、この関数は既存の `DELETE /api/repositories` でも使われている。既存呼び出し元への影響を設計書に明記すべき。

#### SF-004: killWorktreeSession コード例の非同期性 [OCP]

設計書 Section 3 のコード例では `isRunning()` に `await` がないが、現在の `repositories/route.ts` の実装（L36）では `const isRunning = await cliTool.isRunning(worktreeId)` と非同期呼び出しになっている。設計書のコード例を修正すべき。

---

### Consider (3件)

#### C-001: upsertedCount の必要性 [YAGNI]

SyncResult の `upsertedCount` フィールドは現時点で使用箇所がない。YAGNI 原則に従い、実際の使用ユースケースが発生するまで追加を見送ることを検討する。ただしログ出力やレスポンスに含める計画があれば許容範囲。

#### C-002: 全体タイムアウトの実装方針が未詳細 [KISS]

Section 6 の「全体タイムアウト: 60秒」について、`Promise.race` パターン等の具体的な実装方針が示されていない。Step 7（パフォーマンス改善）で別途設計することを明記するか、本設計書に詳細を追加すべき。

#### C-003: cleanupWarnings レスポンスフィールドの一貫性 [DRY]

Section 5 で sync API のレスポンスに `cleanupWarnings` を追加するが、scan/restore API でも同様のフィールドが必要になる。共通レスポンス型の定義を検討すべき。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | DRY違反による保守コスト増大 | Medium | High | P2 |
| 技術的リスク | クリーンアップ順序の不一致による混乱 | Low | Medium | P3 |
| セキュリティ | 新たなセキュリティリスクなし（既存パターン踏襲） | Low | Low | - |
| 運用リスク | 大量削除時のAPI応答遅延 | Medium | Low | P3 |

---

## Positive Aspects

1. **方針(B)の選定根拠が明確**: 方針(A)/(C)/イベント駆動との比較表が記載されており、判断の透明性が高い。
2. **既存パターンの踏襲**: repositories/route.ts の既存パターンを基盤としており、コードベースの一貫性を維持。
3. **部分的成功の許容**: cleanupMultipleWorktrees の既存のエラーハンドリングパターンを活用し、sync 処理の信頼性を確保。
4. **実装順序の段階的設計**: 型定義 -> 戻り値変更 -> テスト -> 共通化 -> 各呼び出し元、という順序が適切。
5. **killWorktreeSession の共通化**: 4箇所で同一パターンが使われているローカル関数を共通化する判断は DRY に適合。

---

## Approval

**Status: Conditionally Approved**

MF-001（DRY違反の解消）を設計に反映した上で実装に進むことを推奨する。SF-001 ~ SF-004 は実装フェーズで対応可能。

---

*Reviewed by: architecture-review-agent*
*Review type: Design Principles (Stage 1)*
