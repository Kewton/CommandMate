# Issue #111 Stage 7 Review Report

**Review Date**: 2026-02-02
**Focus Area**: 影響範囲レビュー（2回目）
**Iteration**: 2

---

## Summary

| Category | Count |
|----------|-------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |
| Quality Score | 5.0/5 |

Stage 3 で指摘された影響範囲関連の全 6 件は全て適切に対応されている。新たな Must Fix は発見されなかった。

---

## Previous Findings Status

### Addressed (6 items)

| ID | Original Issue | Evidence |
|----|----------------|----------|
| Stage3-MF-1 | セッション開始ロジックの initial_branch 保存タイミング | Issue本文で「send/route.ts 内の startSession() 呼び出し直後」と明記 |
| Stage3-MF-2 | git コマンドエラーハンドリング未定義 | 「git コマンドエラーハンドリング」テーブルで detached HEAD / 失敗 / タイムアウト時の動作を定義 |
| Stage3-SF-1 | git コマンド実行のオーバーヘッド未評価 | 「パフォーマンス対策」セクションで 1秒タイムアウト・キャッシュ値返却を明記 |
| Stage3-SF-2 | BranchMismatchAlert 再表示条件不明確 | previousBranch state 管理方式を明記 |
| Stage3-SF-3 | Worktree 型変更による既存コンポーネント影響 | gitStatus をオプショナルフィールドとして追加し後方互換性維持 |
| Stage3-SF-4 | テスト影響範囲が広い | 影響を受けるテスト3件、新規テスト4件を表形式で記載 |

---

## New Findings

### Should Fix (2 items)

#### SF-1: send/route.ts への initial_branch 保存処理の挿入位置

**Category**: 実装整合性

**Issue**:
現在の send/route.ts の L97-107 周辺で startSession() が呼び出された後、すぐに savePendingAssistantResponse() と sendMessage() が続く。initial_branch 保存処理を追加する場所が明確でない。

**Affected Files**:
- `src/app/api/worktrees/[id]/send/route.ts`

**Recommendation**:
実装タスク Task 3 で「!running 時のみ initial_branch を保存する」条件分岐を明示的に記載することを検討。

```typescript
// Example implementation pattern
if (!running) {
  await cliTool.startSession(params.id, worktree.path);
  await saveInitialBranch(db, params.id);  // Add here
}
```

---

#### SF-2: GitStatus と Worktree の関係性

**Category**: 型定義整合性

**Issue**:
GitStatus interface を src/types/models.ts に追加し、Worktree 型に gitStatus フィールドを追加すると記載されている。しかし、API レスポンスでのみ gitStatus を付与する設計かどうかが不明確。

**Affected Files**:
- `src/types/models.ts`
- `src/app/api/worktrees/[id]/route.ts`

**Recommendation**:
以下の2つの設計パターンのどちらを採用するか明記することを検討:

1. **Worktree interface に追加**: `gitStatus?: GitStatus` をオプショナルフィールドとして追加
2. **API レスポンス型を分離**: `WorktreeWithGitStatus` を別途定義

---

### Nice to Have (2 items)

#### NTH-1: CLAUDE.md への更新

**Category**: ドキュメント整合性

**Issue**:
新機能追加時は CLAUDE.md の「最近の実装機能」セクションを更新する慣習があるが、影響範囲テーブルに CLAUDE.md が含まれていない。

**Recommendation**:
影響範囲テーブルに以下を追加:

| ファイル | 変更内容 |
|---------|---------|
| `CLAUDE.md` | Issue #111 ブランチ可視化機能を「最近の実装機能」セクションに追加 |

---

#### NTH-2: キャッシュ機構の検討状況

**Category**: 将来の最適化

**Issue**:
Stage 3 で Nice to Have として提案された「git status キャッシュ機構」の検討状況が備考セクションに記載されていない。

**Recommendation**:
備考セクションに以下を追記:
> git status キャッシュ機構は将来の最適化として別 Issue で対応予定

---

## Impact Analysis Summary

### Affected Files Verification

| File | Current State | Required Changes | Impact |
|------|---------------|------------------|--------|
| `src/lib/db-migrations.ts` | VERSION=14, Migration #14 まで定義 | Migration #15 追加、VERSION を 15 に更新 | 既存データ影響なし |
| `src/types/models.ts` | GitStatus 未定義 | GitStatus interface 追加、Worktree に gitStatus? 追加 | オプショナルで影響最小 |
| `src/lib/db.ts` | initial_branch 関連関数なし | saveInitialBranch(), getInitialBranch() 追加 | 新規関数のみ |
| `src/app/api/worktrees/[id]/route.ts` | gitStatus なし | gitStatus フィールド追加、git コマンド実行追加 | 破壊的変更なし |
| `src/app/api/worktrees/[id]/send/route.ts` | startSession() 後にポーリング開始 | initial_branch 保存処理追加 | 非同期処理順序に注意 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | ブランチ情報なし | ブランチ表示追加、BranchMismatchAlert 統合 | UI 拡張のみ |
| `src/components/mobile/MobileHeader.tsx` | ブランチ情報なし | ブランチ表示追加（省スペース版） | Props 追加、後方互換 |

### New Files

| File | Purpose |
|------|---------|
| `src/components/worktree/BranchMismatchAlert.tsx` | ブランチ不一致警告コンポーネント |

### Breaking Changes

| Area | Status |
|------|--------|
| API | なし（gitStatus はオプショナル） |
| Database | なし（initial_branch は NULL 許容） |
| Types | なし（gitStatus はオプショナル） |
| UI | なし（拡張のみ） |

### Test Coverage Plan

**Existing Tests (3 files affected)**:
- `tests/integration/api-worktrees.test.ts` - オプショナルフィールドのため影響最小
- `tests/integration/api-worktrees-cli-tool.test.ts` - オプショナルとして扱う
- `tests/unit/worktrees.test.ts` - 新規関数のテスト追加

**New Tests Required (4 files)**:
- `tests/unit/db-migrations.test.ts` - Migration #15 テスト
- `tests/unit/git-utils.test.ts` - git コマンド・タイムアウト・エラーハンドリング
- `tests/unit/components/BranchMismatchAlert.test.tsx` - 表示条件・再表示ロジック
- `tests/integration/api-worktrees-git-status.test.ts` - gitStatus レスポンス検証

---

## Conclusion

Issue #111 の影響範囲分析は完成度が高く、実装フェーズへの移行を推奨する。

**Key Strengths**:
1. 破壊的変更なし - オプショナルフィールドによる段階的実装
2. 既存テストへの影響最小 - 型変更がオプショナルフィールドのため
3. 移行パスが明確 - 既存ワークツリーは initial_branch = NULL で動作
4. エラーハンドリングが網羅的 - detached HEAD / 失敗 / タイムアウト全ケース定義

**Minor Improvements Suggested**:
- send/route.ts への initial_branch 保存処理の挿入位置を明確化
- GitStatus と Worktree の型設計の明確化
- CLAUDE.md 更新を影響範囲に追加
