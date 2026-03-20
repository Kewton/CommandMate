# Issue #526 影響分析レビュー (Stage 3)

## レビュー概要

| 項目 | 内容 |
|------|------|
| Issue | #526 |
| 設計方針書 | issue-526-sync-tmux-cleanup-design-policy.md |
| レビュータイプ | 影響範囲（変更の波及効果分析） |
| 判定 | 条件付き承認 (conditionally_approved) |
| スコア | 4/5 |
| レビュー日 | 2026-03-20 |

## エグゼクティブサマリー

設計方針書の影響範囲分析は概ね妥当であり、直接変更対象の8ファイルと変更内容が明確に定義されている。しかし、間接的に影響を受けるテストファイルの詳細な変更計画が不足している点と、server.ts への新規依存追加の明示が不十分な点が指摘事項として挙がった。セキュリティリスクは低く、CI/CDへの影響も最小限である。

---

## 1. syncWorktreesToDB() 戻り値変更による全呼び出し元への波及効果

### 直接呼び出し元一覧（ソースコード確認済み）

| 呼び出し元 | 現在の戻り値使用 | 変更の影響 |
|-----------|----------------|-----------|
| `src/app/api/repositories/sync/route.ts` L48 | 戻り値未使用 | syncWorktreesAndCleanup() に置換。async/await 追加が必要 |
| `src/app/api/repositories/scan/route.ts` L53 | 戻り値未使用 | syncWorktreesAndCleanup() に置換。async/await 追加が必要 |
| `src/app/api/repositories/restore/route.ts` L61 | 戻り値未使用 | syncWorktreesAndCleanup() に置換。async/await 追加が必要 |
| `src/lib/git/clone-manager.ts` L534 | 戻り値未使用 | syncWorktreesAndCleanup() に置換。既に async メソッド内 |
| `server.ts` L239 | 戻り値未使用 | syncWorktreesAndCleanup() に置換。既に async 関数内 |

**評価**: 全5箇所とも戻り値を使用していないため、void -> SyncResult への変更自体は TypeScript コンパイルエラーを引き起こさない（戻り値の無視は TypeScript で許可）。ただし全箇所を syncWorktreesAndCleanup() に置換する設計のため、実質的な影響は「新ヘルパー関数への置換 + await 追加」となる。sync/route.ts, scan/route.ts, restore/route.ts の POST/PUT ハンドラは既に async なので await 追加に問題はない。

---

## 2. killWorktreeSession() 共通化による既存コードへの影響

### 現在の定義箇所

`src/app/api/repositories/route.ts` L30-44 にローカル関数として定義。

### 共通化後の影響

| 影響対象 | 変更内容 | リスク |
|---------|---------|-------|
| `src/app/api/repositories/route.ts` | ローカル関数を削除、import に変更 | 低: 機能的に同等 |
| `src/lib/session-cleanup.ts` | 新規エクスポート関数追加 | 低: 既存関数に影響なし |
| `tests/integration/api-repository-delete.test.ts` | モック定義に killWorktreeSession 追加が必要 | 中: 修正しないとテスト失敗 |
| `tests/integration/repository-exclusion.test.ts` | モック定義に killWorktreeSession 追加が必要 | 中: 修正しないとテスト失敗 |

**動作差異**: 現在のローカル版は getTool() が throw した場合にエラーが cleanupMultipleWorktrees まで伝播する。共通化版は try-catch で false を返す。結果として、セッションキルエラーのログ内容が変わりうる。

---

## 3. syncWorktreesAndCleanup() ヘルパー導入の import 依存関係への影響

### 新規依存グラフ

```
session-cleanup.ts (既存)
  +-- polling/response-poller
  +-- polling/auto-yes-manager
  +-- schedule-manager
  +-- tmux/tmux-capture-cache
  +-- cli-tools/types
  +-- errors
  +-- logger
  +-- [NEW] git/worktrees (syncWorktreesToDB)
  +-- [NEW] cli-tools/manager (CLIToolManager)
  +-- [NEW] tmux/tmux (killSession)
```

### 循環依存リスク

現時点で `worktrees.ts` は `session-cleanup.ts` に依存していないため、循環依存は発生しない。しかし将来的に worktrees.ts がセッション情報を参照する拡張を行った場合、循環依存が生まれるリスクがある。設計書 C-C01 で認識されているが、検出手段が未定義。

### 呼び出し元の import 変更

| ファイル | 変更前の import | 変更後の import |
|---------|----------------|----------------|
| sync/route.ts | `from '@/lib/git/worktrees'` | `from '@/lib/session-cleanup'` (syncWorktreesAndCleanup) |
| scan/route.ts | `from '@/lib/git/worktrees'` | `from '@/lib/session-cleanup'` (syncWorktreesAndCleanup) |
| restore/route.ts | `from '@/lib/git/worktrees'` | `from '@/lib/session-cleanup'` (syncWorktreesAndCleanup) |
| clone-manager.ts | `from './worktrees'` | `from '../session-cleanup'` (syncWorktreesAndCleanup) |
| server.ts | `from './src/lib/git/worktrees'` | `from './src/lib/session-cleanup'` (syncWorktreesAndCleanup) |
| repositories/route.ts | ローカル関数 | `from '@/lib/session-cleanup'` (killWorktreeSession) |

**注意**: sync/scan/restore/clone-manager では syncWorktreesToDB の直接 import がなくなる（ヘルパー経由になる）ため、worktrees.ts からの import 項目が減る。ただし scanWorktrees や getRepositoryPaths は引き続き worktrees.ts から import する。

---

## 4. cleanupMultipleWorktrees() の並列化変更による既存 DELETE handler への影響

### 既存呼び出し元

`src/app/api/repositories/route.ts` L93-96:
```typescript
const cleanupResult = await cleanupMultipleWorktrees(
  worktreeIds,
  killWorktreeSession
);
```

### 並列化の影響分析

| 観点 | 評価 |
|------|------|
| 機能的互換性 | Promise.allSettled は全ての Promise が settle するまで待つため、逐次実行と同じく全 worktree のクリーンアップが完了する |
| 結果の順序 | Promise.allSettled は入力配列と同じ順序で結果を返すため、results 配列の順序は変わらない |
| warnings の集約 | 並列実行でもエラーは同様に収集される。ただし warnings の出現順序が変わりうる |
| tmux 操作の競合 | 設計書 SF-003 で安全性根拠が明記されている。各 worktree のセッション名は一意 |
| パフォーマンス | 改善方向。大量削除時の所要時間が大幅に短縮される |

**テストへの影響**: tests/unit/session-cleanup.test.ts の「should aggregate all warnings」テスト（L131-141）は mockResolvedValueOnce チェーンの順序に依存しており、並列実行時に意図しない結果になる可能性がある。

---

## 5. テスト影響範囲

### 変更が必要な既存テストファイル

| テストファイル | 影響理由 | 必要な変更 | 優先度 |
|--------------|---------|-----------|-------|
| `src/lib/__tests__/worktrees-sync.test.ts` | syncWorktreesToDB の戻り値型変更 | deletedIds, upsertedCount の検証追加が望ましい | Should Fix |
| `tests/unit/worktrees.test.ts` | syncWorktreesToDB のシグネチャ確認テスト | 戻り値型の検証追加 | Consider |
| `tests/unit/session-cleanup.test.ts` | cleanupMultipleWorktrees の並列化 | mockResolvedValueOnce を条件分岐モックに変更 | Should Fix |
| `tests/integration/api-repository-delete.test.ts` | killWorktreeSession の共通化 | モック定義に killWorktreeSession 追加 | Should Fix |
| `tests/integration/repository-exclusion.test.ts` | killWorktreeSession の共通化 | モック定義に killWorktreeSession 追加 | Should Fix |

### 新規テストの追加

| テスト対象 | ファイル | テスト内容 |
|-----------|---------|-----------|
| killWorktreeSession() | tests/unit/session-cleanup.test.ts | 実行中/非実行/getTool例外の3パターン |
| syncWorktreesAndCleanup() | tests/unit/session-cleanup.test.ts | 正常系/削除なし/クリーンアップ失敗の3パターン |
| syncWorktreesToDB() 戻り値 | src/lib/__tests__/worktrees-sync.test.ts | deletedIds 検証の2パターン |

---

## 6. CI/CD パイプラインへの影響

| CI ステップ | 影響 | 詳細 |
|------------|------|------|
| `npm run lint` | 影響なし | 新規 ESLint ルール違反は発生しない |
| `npx tsc --noEmit` | 影響なし | void -> SyncResult の変更は後方互換（戻り値の無視は許可） |
| `npm run test:unit` | 影響あり | session-cleanup.test.ts の並列化対応、worktrees-sync.test.ts の拡張が必要 |
| `npm run test:integration` | 影響あり | モック定義の更新が必要（killWorktreeSession 追加） |
| `npm run build` | 影響なし | 新規パッケージ追加なし |

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | テスト修正漏れによる CI 失敗 | Medium | Medium | P1 |
| 技術的リスク | clone-manager の onCloneSuccess 内エラーハンドリング | Medium | Low | P2 |
| 技術的リスク | session-cleanup.ts -> worktrees.ts 循環依存リスク | Low | Low | P3 |
| セキュリティリスク | 新たなセキュリティリスクなし | Low | Low | - |
| 運用リスク | sync API レスポンスの変更による既存クライアント影響 | Low | Low | P3 |

---

## 指摘事項サマリー

### Must Fix (2件)

1. **IA-MF-001**: server.ts から session-cleanup.ts への新規依存が設計書のレイヤー構成図に未記載
2. **IA-MF-002**: clone-manager.ts の onCloneSuccess() 内で syncWorktreesAndCleanup() を呼ぶ際のエラーハンドリング設計が不足

### Should Fix (5件)

1. **IA-SF-001**: 既存テスト（worktrees-sync.test.ts, worktrees.test.ts）の変更計画が未詳細
2. **IA-SF-002**: cleanupMultipleWorktrees() 並列化による session-cleanup.test.ts の既存テスト修正が未言及
3. **IA-SF-003**: integration テストのモック定義更新（killWorktreeSession 追加）が未言及
4. **IA-SF-004**: sync/scan/restore 各 API レスポンスフォーマット変更の後方互換性が未整理
5. **IA-SF-005**: session-cleanup.ts -> worktrees.ts の水平依存に対する循環依存検出手段が未定義

### Consider (3件)

1. **IA-C-001**: gracefulShutdown と syncWorktreesAndCleanup の競合可能性
2. **IA-C-002**: CI/CD パイプラインへの影響は最小限（特別な対応不要）
3. **IA-C-003**: repositories/route.ts の killWorktreeSession 共通化時のエラーログ出力変化

---

*Generated by architecture-review-agent for Issue #526*
*Stage 3: 影響分析レビュー*
*Date: 2026-03-20*
