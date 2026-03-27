# Architecture Review: Issue #547 - Stage 1 (通常レビュー / 設計原則)

**Date**: 2026-03-27
**Issue**: #547 Copilot CLIのデフォルトスラッシュコマンドと選択ウィンドウ対応
**Focus**: SOLID / KISS / YAGNI / DRY

---

## Overview

Issue #547 の設計方針書に対し、設計原則（SOLID, KISS, YAGNI, DRY）の観点からレビューを実施した。設計方針書は全体的に既存アーキテクチャとの整合性が高く、YAGNI の適用判断（ハードコード vs 汎用機構）は適切である。一方で、DRY 違反リスクのある箇所と、既存コードの構造的課題を助長する設計が一部確認された。

---

## Findings Summary

| Severity | Count |
|----------|-------|
| must_fix | 1 |
| should_fix | 3 |
| nice_to_have | 3 |
| **Total** | **7** |

---

## Must Fix

### DR1-004: isSelectionListActive の OR 条件増殖 (DRY)

**対象**: 設計方針書 Section 3-5 / `current-output/route.ts` L108-110

設計方針書では `isSelectionListActive` の条件に `STATUS_REASON.COPILOT_SELECTION_LIST` を OR で追加する方針を示している。現在の実装は既に2条件（OPENCODE + CLAUDE）で OR 結合されており、Copilot 追加で3条件になる。ツール追加のたびに OR 条件が増殖する構造的問題がある。

**推奨対応**: `STATUS_REASON` に `SELECTION_LIST_REASONS` セット定数を定義し、`isSelectionListActive` の判定を `SELECTION_LIST_REASONS.has(statusResult.reason)` とする。新ツール追加時はSet定義に1行追加するだけで済む。

---

## Should Fix

### DR1-001: Copilot選択リスト検出がClaude検出のコピーになる懸念 (DRY)

**対象**: 設計方針書 Section 3-3 / `status-detector.ts` L199-211

Step 1.5（Claude選択リスト検出）と Step 1.6（Copilot選択リスト検出）がほぼ同一構造のif文になる。現時点では2ツールのみのため許容範囲だが、設計方針書に「3ツール目追加時にパターンマッピングへの移行を検討する」旨のトレードオフ記載を追加すべき。

### DR1-003: placeholderパターンの完了判定基準がない (KISS)

**対象**: 設計方針書 Section 4, Section 7

TUI調査フェーズの完了基準が明記されておらず、実装者がいつ placeholder から本番パターンに切り替えるべきか判断に迷う。以下の基準を追加すべき:
- 3状態（アイドル/処理中/選択ウィンドウ）のスナップショット取得
- 正例/負例テスト通過
- 確定不可の場合はplaceholderのまま残しIssueに記録

### DR1-006: getSlashCommandGroups() のソース数増加 (SRP)

**対象**: 設計方針書 Section 3-1 / `slash-commands.ts` L453-474

getSlashCommandGroups() は既に4種類のソースを扱っており、ビルトインコマンドで5ソース目。即時リファクタリングは YAGNI だが、将来の分離可能性について設計方針書に言及すべき。

---

## Nice to Have

### DR1-002: switch 文の OCP 課題 (SOLID/OCP)

cli-patterns.ts の複数 switch 文は既に6ケースあり、D1-003原則（7ツール目でレジストリ移行）は適切に設定されている。Issue #547 のスコープ外だが、変更対象の switch 分岐箇所をリストアップしておくと移行時に有用。

### DR1-005: category 設定の判断根拠 (YAGNI)

/model コマンドの `category: 'standard-config'` は適切。コード例にコメントとして判断根拠を記載しておくと将来の拡張時に一貫性を保てる。

### DR1-007: promptInput 条件の依存関係記載漏れ (DRY)

status-detector.ts の promptInput 条件分岐に copilot が既に Issue #545 で含まれている事実が設計方針書に記載されていない。「変更不要」の明示記載を推奨。

---

## Positive Observations

1. **YAGNI の適切な適用**: ハードコード定義 vs 汎用機構の判断が妥当。Copilot のビルトインコマンドが少数・安定的であることを根拠に、シンプルなアプローチを選択している。
2. **既存アーキテクチャとの整合性**: Claude 方式のパターンマッチ検出を基本とし、OpenCode のような複雑な TUI 解析を避ける判断は、Copilot CLI の特性に合致している。
3. **D1-003 原則の遵守**: 7ツール目追加時のレジストリパターン移行閾値が制約条件に明記されており、将来の拡張に対する意識が設計に反映されている。
4. **セキュリティ設計**: ReDoS 防止、`/g` フラグ禁止、gray-matter の JS エンジン無効化など、既存のセキュリティ慣行を踏襲している。
5. **テスト設計**: 新規パターンの正例/負例テスト、既存テストへの回帰確認が計画に含まれている。

---

## Review Metadata

- **Reviewer**: architecture-review-agent
- **Design Document**: `dev-reports/design/issue-547-copilot-slash-commands-design-policy.md`
- **Result File**: `dev-reports/issue/547/multi-stage-design-review/stage1-review-result.json`
- **Key Source Files Reviewed**:
  - `src/lib/slash-commands.ts`
  - `src/lib/detection/cli-patterns.ts`
  - `src/lib/detection/status-detector.ts`
  - `src/lib/command-merger.ts`
  - `src/lib/cli-tools/types.ts`
  - `src/app/api/worktrees/[id]/current-output/route.ts`
