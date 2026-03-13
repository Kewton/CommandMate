# Architecture Review Report: Issue #479 Stage 3 (Impact Analysis)

**Issue**: #479 refactor: 巨大ファイル分割 (R-1)
**Stage**: 3 - 影響分析レビュー
**Date**: 2026-03-13
**Status**: conditionally_approved
**Score**: 4/5

---

## Executive Summary

Issue #479の設計方針書について、影響範囲（依存関係の波及、テスト影響、ドキュメント影響、実行時整合性、ビルド/CI影響）の観点でレビューを実施した。

バレルファイル戦略により主要消費者のimportパス変更を回避する方針は妥当であり、86件の消費者を持つdb.tsや20件の消費者を持つauto-yes-manager.tsへの影響を最小化する設計となっている。should_fixが4件、nice_to_haveが4件検出されたが、must_fixレベルの致命的欠落はない。

---

## Impact Scope Analysis

### Affected Files Summary

| Category | Module | src/ Consumers | tests/ Consumers | Barrel Strategy | Import Change Required |
|----------|--------|---------------|------------------|-----------------|----------------------|
| Direct Split | db.ts | 52 | 34 | Yes | No (barrel) |
| Direct Split | response-poller.ts | 6 | 7 | Yes | No (barrel) |
| Direct Split | auto-yes-manager.ts | 14 | 6 | Yes | No (barrel) |
| Direct Split | claude-session.ts | 5 | 2 | No | Partial |
| Direct Split | prompt-detector.ts | 7 | 5 | No | Partial |
| Direct Split | schedule-manager.ts | 4 | 2 | No | Partial |
| Direct Split | WorktreeDetailRefactored.tsx | 3 | 4 | N/A (component) | No |
| Direct Split | MarkdownEditor.tsx | 1 | 0 | N/A (component) | No |
| Direct Split | FileTreeView.tsx | 2 | 0 | N/A (component) | No |
| Function Move | isValidWorktreeId | 11 (API routes) | 5 (test files) | No (direct change) | Yes |
| Indirect Impact | session-cleanup.ts | - | - | N/A | Depends on phase |
| Indirect Impact | resource-cleanup.ts | - | - | N/A | Depends on phase |

### Test Mock Impact

vi.mock patterns that reference affected modules:

| Mock Target | Test File Count | Impact |
|-------------|----------------|--------|
| `@/lib/db` | 20+ files | Barrel maintains compatibility, but mock return values need verification |
| `@/lib/auto-yes-manager` | 5 files | Barrel maintains import path, mock internals may need update |
| `@/lib/response-poller` | 4 files | Barrel maintains import path |
| `@/lib/claude-session` | 2 files | Non-barrel, potential import path change |
| `@/lib/prompt-detector` | 2 files | Non-barrel, potential import path change |
| `@/lib/schedule-manager` | 2 files | Non-barrel, potential import path change |

---

## Detailed Findings

### D3-001 [should_fix] vi.mockパス更新が必要なテストファイルの網羅的特定が不完全

**Category**: テスト
**Location**: セクション7. テスト戦略

設計方針書のテストファイル対応表はresponse-poller.tsとauto-yes-manager.tsについて記載があるが、db.tsをvi.mockしているテストファイルが20件以上存在し、バレルファイル経由のmockが分割後も正常に動作することの検証計画がない。

**Suggestion**: vi.mock('@/lib/db')を使用している全テストファイルをリストアップし、バレルファイル経由のmockが分割後も正常に動作することを検証計画に含めること。

---

### D3-002 [should_fix] session-cleanup.tsとresource-cleanup.tsへの波及影響が未分析

**Category**: 依存関係
**Location**: セクション8. 実施フェーズ

session-cleanup.tsはresponse-poller.ts、auto-yes-manager.ts、schedule-manager.tsから関数をimportするファサードモジュールであり、resource-cleanup.tsはauto-yes-manager.tsの内部状態に直接アクセスしている。これらのモジュールへの波及影響分析が設計書に含まれていない。

**Suggestion**: session-cleanup.tsとresource-cleanup.tsを各フェーズの影響ファイルリストに追加し、特にresource-cleanup.tsがauto-yes-manager.tsからimportしている関数の分割先を明記すること。

---

### D3-003 [should_fix] auto-yes-manager.tsのglobalThisパターン分割時の状態整合性設計が不十分

**Category**: 実行時
**Location**: セクション4-3. auto-yes-manager.ts分割設計

globalThis.__autoYesStatesとglobalThis.__autoYesPollerStatesの2つの状態をauto-yes-state.tsとauto-yes-poller.tsに分離する際、globalThisキー名の不変性保証とモジュール初期化順序への言及がない。

**Suggestion**: globalThisキー名が分割前後で変わらないこと、lazy初期化パターン（??=）が維持されることを設計書に明記すること。

---

### D3-004 [should_fix] response-poller.tsのモジュールレベルMap分割時のライフサイクル整合性が曖昧

**Category**: 実行時
**Location**: セクション4-2. response-poller.ts分割設計

response-poller.tsの3つのMap状態（activePollers, pollingStartTimes, tuiResponseAccumulator）はglobalThisではなくモジュールスコープ変数であり、auto-yes-manager.tsとは異なるパターンである。この差異と分割後の影響について設計書で言及がない。

**Suggestion**: モジュールスコープ変数のまま分割する方針を明記し、ホットリロード時の状態永続化が不要であることを確認すること。

---

### D3-005 [nice_to_have] CLAUDE.md更新対象にpath-validator.tsの説明更新が含まれていない

**Category**: ドキュメント
**Location**: セクション10. CLAUDE.md更新方針

path-validator.tsへのisValidWorktreeId移動後のCLAUDE.mdエントリ更新が、更新対象として明示されていない。

---

### D3-006 [nice_to_have] Phase 1分割対象のCLAUDE.md更新影響が未特定

**Category**: ドキュメント
**Location**: セクション10. CLAUDE.md更新方針

Phase 1で新規作成される6モジュールのCLAUDE.md追加エントリが具体的に特定されていない。

---

### D3-007 [nice_to_have] Phase間でのビルド検証手順にnpm run buildが含まれていない

**Category**: ビルド
**Location**: セクション7. テスト戦略, セクション12. 受け入れ基準

検証コマンドにnpm run buildが含まれておらず、受け入れ基準にもビルド成功の明示がない。

---

### D3-008 [nice_to_have] isValidWorktreeId移動の影響テストファイルが一部欠落

**Category**: 依存関係
**Location**: セクション7. テスト戦略

auto-yes-manager.test.tsとauto-yes-manager-cleanup.test.tsのisValidWorktreeId importパス変更がテストファイル対応表に記載されていない。

---

## Risk Assessment

| Risk Type | Description | Impact | Probability | Priority |
|-----------|-------------|--------|-------------|----------|
| Technical | vi.mock patterns breaking after barrel file split | Medium | Low | P2 |
| Technical | globalThis state inconsistency after module split | Medium | Low | P2 |
| Technical | Module-scope Map state not persisting across hot reload | Low | Low | P3 |
| Operational | CLAUDE.md update omissions causing developer confusion | Low | Medium | P3 |
| Build | Barrel files preventing tree-shaking optimization | Low | High (expected) | P3 |

---

## Improvement Recommendations

### Must Fix (0 items)

None.

### Should Fix (4 items)

1. **D3-001**: vi.mock('@/lib/db')を使用する20件以上のテストファイルのバレル互換性検証計画を追加
2. **D3-002**: session-cleanup.tsとresource-cleanup.tsの波及影響をフェーズ別に分析・記載
3. **D3-003**: globalThisキー名の不変性保証とlazy初期化パターンの維持を明記
4. **D3-004**: response-poller.tsのモジュールスコープ変数とglobalThisパターンの差異を明記

### Consider (4 items)

5. **D3-005**: path-validator.tsのCLAUDE.md説明更新を更新対象に追加
6. **D3-006**: Phase 1のCLAUDE.md更新エントリを具体化
7. **D3-007**: 検証コマンドにnpm run buildを追加
8. **D3-008**: テストファイル対応表にauto-yes-manager関連テストのimport変更を追加

---

## Approval Status

**Status**: conditionally_approved

should_fix 4件の改善を設計書に反映した上での実装着手を推奨する。いずれも実装時に解決可能な範囲であり、設計の根本的な見直しは不要である。

---

*Review conducted by architecture-review-agent for Issue #479, Stage 3*
