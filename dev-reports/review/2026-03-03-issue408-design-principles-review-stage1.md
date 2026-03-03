# Architecture Review: Issue #408 - Stage 1 (Design Principles)

## Executive Summary

| Item | Value |
|------|-------|
| Issue | #408: detectPrompt二重呼び出し解消 |
| Stage | 1 - 通常レビュー（設計原則） |
| Status | Conditionally Approved |
| Score | 4/5 |
| Date | 2026-03-03 |

設計方針書は全体的に高品質であり、DRY違反の解消方針は合理的かつ最小侵襲な設計となっている。主要な指摘は `promptDetection` フィールドを optional ではなく required にすべきという型安全性に関する改善提案で、これにより将来の return パス追加時にコンパイラレベルでの安全性が保証される。

---

## Review Scope

### Design Document
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/dev-reports/design/issue-408-detect-prompt-dedup-design-policy.md`

### Reviewed Source Files
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/status-detector.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/app/api/worktrees/[id]/current-output/route.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/prompt-detector.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/app/api/worktrees/[id]/route.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/app/api/worktrees/route.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/auto-yes-manager.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/__tests__/status-detector.test.ts`

---

## Design Principles Evaluation

### SOLID Principles

#### SRP (Single Responsibility Principle)

**評価: 適切（軽微なSRP緩和を受容、妥当な判断）**

`StatusDetectionResult` に `promptDetection` フィールドを追加することは、status-detector モジュールがプロンプト検出結果の「運搬」も担うことになり、厳密にはSRP緩和となる。しかし、以下の理由から受容可能と判断する:

1. **依存方向は既に一方向**: `status-detector.ts` は既に `prompt-detector.ts` の `detectPrompt()` を内部で呼び出している（L24, L145）。型の追加インポートは新たな依存方向を生まない。
2. **PromptDetectionResult は安定型**: `PromptDetectionResult` インタフェースは Issue #235 以降安定しており、変更頻度が低い。
3. **optional/required いずれでも影響は最小**: 他の呼び出し元（`worktrees/route.ts`, `worktrees/[id]/route.ts`）は `promptDetection` フィールドを単に無視するだけで、既存コードの変更は不要。

#### OCP (Open/Closed Principle)

**評価: 良好**

既存の `StatusDetectionResult` インタフェースにフィールドを追加する形であり、既存の呼び出し元コードの修正は不要（optional フィールドの追加のため）。`current-output/route.ts` のみが新フィールドを参照する変更を行う。

### DRY Principle

**評価: 改善達成（本Issueの主目的を適切に達成）**

変更前:
- `detectPrompt()` が `detectSessionStatus()` 内部で1回、`current-output/route.ts` で1回、計2回呼び出される
- 前処理パイプライン（`stripAnsi` -> `stripBoxDrawing`）も重複

変更後:
- `detectPrompt()` は `detectSessionStatus()` 内部の1回のみ
- 前処理パイプラインの重複も解消
- `stripAnsi`, `stripBoxDrawing`, `buildDetectPromptOptions`, `detectPrompt` の4つの import が `current-output/route.ts` から削除可能

設計方針書 Section 5.1 で前処理パイプラインの同一性を確認している点も適切。

### KISS Principle

**評価: 良好**

- 変更は `StatusDetectionResult` インタフェースへの1フィールド追加と、8箇所の return 文への `promptDetection` プロパティ追加のみ
- 案B（新関数追加）や案C（アウトパラメータ）を不採用とした判断は適切で、複雑性の増加を回避している
- `current-output/route.ts` からは約20行のコード削除と4つの import 削除で、コードの簡素化に寄与

### YAGNI Principle

**評価: 良好**

- 必要最小限の変更に留まっている
- `auto-yes-manager.ts` の類似パターンや `response-poller.ts` はスコープ外として明確に除外されている
- 将来の拡張のための過剰な抽象化は行われていない

---

## Detailed Findings

### DR1-001: promptDetection を required フィールドにすべき [Should Fix]

**カテゴリ**: 型安全性

**問題**: `promptDetection` が optional (`?`) で定義されているため、return 文への追加漏れが TypeScript コンパイラで検出されない。設計方針書 Section 4.1 でも「optionalフィールドのため追加忘れがTypeScriptの型エラーにならない」と認識されている。テストのみに依存する防御は defense-in-depth として不十分。

**該当箇所**: `src/lib/status-detector.ts` - `StatusDetectionResult` interface

**根拠**: `detectSessionStatus()` 内で `promptDetection` 変数は L145 で定義され、全8箇所の return パスのスコープ内にある。つまり、required にしても全 return 文で `promptDetection` を設定可能。

```typescript
// 現在の設計（optional）
export interface StatusDetectionResult {
  // ...
  promptDetection?: PromptDetectionResult;  // 追加漏れが検出されない
}

// 推奨設計（required）
export interface StatusDetectionResult {
  // ...
  promptDetection: PromptDetectionResult;   // 追加漏れでコンパイルエラー
}
```

**他の呼び出し元への影響**:
- `worktrees/route.ts` (L58): `statusResult.status` と `statusResult.hasActivePrompt` のみ参照 -> 影響なし
- `worktrees/[id]/route.ts` (L68): 同上 -> 影響なし
- 既存テスト: `promptDetection` を検証していないテストは、フィールドが存在しても壊れない -> 影響なし

### DR1-003: 設計方針書内の return パス数の不整合 [Should Fix]

**カテゴリ**: DRY（ドキュメント整合性）

**問題**: Section 4.1 で「全9箇所のreturn文」と記載されているが、実際のソースコード（`status-detector.ts`）の return パスは8箇所で、Section 4.2 のテーブルも8行（パス1-8）。

**該当箇所**: `dev-reports/design/issue-408-detect-prompt-dedup-design-policy.md` Section 4.1

**提案**: 「全9箇所」を「全8箇所」に修正する。

### DR1-006: promptDetection アクセスの optional chaining [Should Fix]

**カテゴリ**: 型安全性

**問題**: Section 4.3 で `statusResult.promptDetection?.promptData ?? null` としている。DR1-001 を採用して required にすれば optional chaining は不要。optional のまま維持する場合は、undefined のケースが設計上発生しないことのコメントが必要。

**該当箇所**: `dev-reports/design/issue-408-detect-prompt-dedup-design-policy.md` Section 4.3

**提案**:
- DR1-001 採用時: `statusResult.promptDetection.promptData ?? null` に修正
- DR1-001 不採用時: コメントで「promptDetection が undefined のケースは設計上発生しないが、defense-in-depth として optional chaining を使用」と明記

### DR1-002: SF-001 resolved コメントへの将来ガイドライン追加 [Nice to Have]

**カテゴリ**: SOLID

**問題**: SRP 緩和を受容した判断は適切だが、将来の見直し条件が文書化されていない。

**該当箇所**: `dev-reports/design/issue-408-detect-prompt-dedup-design-policy.md` Section 9.1

**提案**: JSDoc コメントに以下を追記:
```
 * [Future review trigger]: If PromptDetectionResult gains high-frequency
 * changes or large structural modifications, consider re-evaluating this
 * coupling via a minimal DTO/projection type.
```

### DR1-004: 削除対象コードの明示化 [Nice to Have]

**カテゴリ**: KISS

**問題**: `current-output/route.ts` L98 の `promptDetection` 変数宣言自体が削除対象であることが設計方針書で暗黙的にしか表現されていない。

**該当箇所**: `src/app/api/worktrees/[id]/current-output/route.ts` L98

**提案**: Section 4.3 に「L98-L102 の promptDetection 変数宣言、初期化、if ブロック全体が削除対象」と明記する。

### DR1-005: YAGNI 適合の確認 [Nice to Have]

**カテゴリ**: YAGNI

**評価**: 指摘なし。設計は必要最小限の変更に留まっており、YAGNI 原則に完全に適合。案B/案C を不採用とした判断は適切な設計判断として記録する。

### DR1-007: stripAnsi 削除の実装時検証手順 [Nice to Have]

**カテゴリ**: その他

**問題**: `stripAnsi` の削除可能性に関する分析は丁寧だが、`cleanOutput` 変数が他の箇所で使われていないことの確認が設計方針書の記載のみに依存している。

**該当箇所**: `dev-reports/design/issue-408-detect-prompt-dedup-design-policy.md` Section 4.4

**提案**: 実装手順に「cleanOutput の全参照箇所を grep で確認し、削除安全性を検証する」ステップを追加する。

### DR1-008: auto-yes-manager スコープ外の根拠補足 [Nice to Have]

**カテゴリ**: DRY

**問題**: `auto-yes-manager.ts` も `detectPrompt()` を直接呼び出しているが、スコープ外としている。判断自体は妥当（auto-yes-manager は独自のポーリングコンテキストで `detectPrompt()` を使用し、`detectSessionStatus()` を経由しないため同一パターンではない）。

**該当箇所**: `dev-reports/design/issue-408-detect-prompt-dedup-design-policy.md` Section 1.2

**提案**: Section 1.2 の「含まない」欄に、auto-yes-manager.ts が独立した `detectPrompt()` 呼び出しを持つ理由を1行追記する。

---

## Risk Assessment

| Risk Type | Content | Impact | Probability | Priority |
|-----------|---------|--------|-------------|----------|
| Technical | return パスへの promptDetection 追加漏れ（optional 型の場合） | Medium | Low | P2 |
| Technical | 前処理パイプラインの非同一性（設計上は同一確認済み） | Low | Very Low | P3 |
| Security | APIレスポンスJSON形状に変更なし、セキュリティリスクなし | None | None | - |
| Operational | 後方互換性あり、既存テストは壊れない | None | None | - |

---

## Improvement Recommendations

### Must Fix (0 items)

なし。

### Should Fix (3 items)

1. **DR1-001**: `promptDetection` を required フィールドにする。TypeScript コンパイラによる追加漏れ検出を有効化。
2. **DR1-003**: 設計方針書の return パス数を「全9箇所」から「全8箇所」に修正。
3. **DR1-006**: DR1-001 の採用に応じて optional chaining の要否を調整。

### Consider (5 items)

1. **DR1-002**: SF-001 resolved コメントに将来の見直しガイドラインを追記。
2. **DR1-004**: 削除対象コードの行番号を設計方針書に明記。
3. **DR1-005**: YAGNI 適合は確認済み（指摘なし）。
4. **DR1-007**: stripAnsi 削除時の grep 検証手順を追加。
5. **DR1-008**: auto-yes-manager スコープ外の根拠を補足。

---

## Approval Status

**Conditionally Approved** - Should Fix 3件を設計方針書に反映した上で実装に進むことを推奨。特に DR1-001（promptDetection を required にする変更）は型安全性の大幅な向上に寄与するため、設計方針書の修正を推奨する。

---

*Reviewed by: architecture-review-agent*
*Date: 2026-03-03*
