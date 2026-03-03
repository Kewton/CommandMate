# Issue #408: Stage 4 Security Review - detectPrompt二重呼び出し解消

| 項目 | 内容 |
|------|------|
| Issue | #408 |
| Stage | 4 (セキュリティレビュー) |
| ステータス | approved |
| スコア | 5/5 |
| 日付 | 2026-03-03 |

---

## Executive Summary

Issue #408の設計方針書をセキュリティ観点からレビューした。この変更は`StatusDetectionResult`に`promptDetection: PromptDetectionResult`フィールドを追加し、`current-output/route.ts`での`detectPrompt()`二重呼び出しを解消するリファクタリングである。

セキュリティ上の必須改善項目および推奨改善項目は**なし**。この変更はAPIレスポンスのJSON形状を変更せず、既存の認証・IP制限ミドルウェアに影響を与えず、新たなregexパターンも導入しない。セキュリティリスクは極めて低い。

---

## OWASP Top 10 チェックリスト

### A01: Broken Access Control

**判定**: PASS

`promptDetection`フィールドは`StatusDetectionResult`のサーバーサイド内部構造に追加されるものであり、APIレスポンスには直接露出しない。APIレスポンスで返されるのは従来通り`promptData`フィールドのみである（L133: `promptData: isPromptWaiting ? statusResult.promptDetection.promptData ?? null : null`）。

呼び出し元の分析:

| 呼び出し元 | promptDetection参照 | 影響 |
|-----------|-------------------|------|
| `current-output/route.ts` | `.promptDetection.promptData`のみ | APIレスポンス形状変更なし |
| `worktrees/route.ts` | 参照なし（`.status`, `.hasActivePrompt`のみ） | 影響なし |
| `worktrees/[id]/route.ts` | 参照なし（`.status`, `.hasActivePrompt`のみ） | 影響なし |

### A03: Injection (ReDoS)

**判定**: PASS

Issue #408ではregexパターンの追加・変更は行われない。`detectPrompt()`内で使用される全regexパターンは既にReDoS安全性の分析とアノテーションが完了している:

- `DEFAULT_OPTION_PATTERN`: アンカー付き、ReDoS safe (S4-001)
- `NORMAL_OPTION_PATTERN`: アンカー付き、ReDoS safe (S4-001)
- `SEPARATOR_LINE_PATTERN`: アンカー付き、ReDoS safe (S4-001)
- `QUESTION_KEYWORD_PATTERN`: 交替のみ、ネスト量指定子なし、ReDoS safe (SEC-S4-002)
- `YES_NO_PATTERNS`: 各パターンがアンカー付き
- `truncateRawContent()`: regex未使用、ReDoSリスクなし (SF-S4-002)

### A04: Insecure Design

**判定**: PASS

型の不変条件 `hasActivePrompt === promptDetection.isPrompt` は設計上の構造により保証される:

1. `promptDetection`変数は`detectSessionStatus()`のL145で**一度だけ**計算される
2. L146の`if (promptDetection.isPrompt)` 分岐:
   - **true**: `hasActivePrompt: true`と共にreturn（パス1のみ）
   - **false**: 全後続パス（パス2-8）で`hasActivePrompt: false`と共にreturn
3. `promptDetection`がrequiredフィールド（DR1-001）であるため、TypeScriptコンパイラが全returnパスでの設定を強制

この不変条件は分岐構造により演繹的に保証されており、ランタイムアサーションは不要である。

### A05: Security Misconfiguration

**判定**: PASS

設定ファイル、環境変数、ミドルウェア設定に変更なし。

### A07: Cross-Site Scripting (XSS)

**判定**: PASS

APIレスポンスのJSON形状に変更なし。`promptData`内の`question`、`instructionText`等のフィールドはtmux出力由来だが、これは変更前から同様である。クライアント側ではReactのJSXエスケープにより自動的にXSS防止が適用される。

---

## セキュリティ重点レビュー項目

### 1. データ漏洩リスク

**評価**: リスクなし

`StatusDetectionResult`に`promptDetection`フィールドを含めることで、内部的には`cleanContent`（stripAnsi適用済み出力）と`rawContent`（最大200行/5000文字トランケート済み）がサーバーサイドの呼び出し元からアクセス可能になる。

しかし、以下の理由によりリスクは存在しない:

1. **既存の情報露出が上回る**: `current-output/route.ts`は既に`fullOutput`（生のtmux出力全体、L121）をAPIレスポンスに含めている。`cleanContent`/`rawContent`はこの`fullOutput`のサブセット（前処理済み + トランケート済み）に過ぎない
2. **他の呼び出し元は参照しない**: `worktrees/route.ts`と`worktrees/[id]/route.ts`は`statusResult.status`と`statusResult.hasActivePrompt`のみを使用し、`promptDetection`フィールドには一切アクセスしない
3. **APIレスポンスへの直接露出なし**: `cleanContent`/`rawContent`はAPIレスポンスのJSONに含まれない。返されるのは`promptDetection.promptData`のみ

### 2. 入力バリデーション

**評価**: 問題なし

`promptData`は`detectPrompt()`関数内部で構造化データとして生成される。外部からの直接入力ではなく、tmux出力（信頼された内部データソース）のregexマッチ結果から構築される。

APIレスポンスに含まれる`promptData`の構造は`PromptData`型（`YesNoPromptData | MultipleChoicePromptData`）により型安全に制約されており、任意のフィールドが追加される余地はない。

### 3. 前処理パイプラインの同一性

**評価**: 同一性が保証される

設計方針書 Section 5.1 の記載を実コードで検証した:

| 箇所 | コード | インポート元 |
|------|--------|------------|
| `status-detector.ts` L120 | `const cleanOutput = stripAnsi(output)` | `./cli-patterns` |
| `status-detector.ts` L145 | `detectPrompt(stripBoxDrawing(cleanOutput), promptOptions)` | `./cli-patterns` |
| `route.ts` L81 | `const cleanOutput = stripAnsi(output)` | `@/lib/cli-patterns` |
| `route.ts` L101 | `detectPrompt(stripBoxDrawing(cleanOutput), promptOptions)` | `@/lib/cli-patterns` |

両者は同一モジュール（`cli-patterns.ts`）から同一関数（`stripAnsi`, `stripBoxDrawing`）をインポートし、同一の入力（`output`パラメータ）に対して同一の順序で適用している。`buildDetectPromptOptions(cliToolId)`も同一関数・同一引数で呼び出されている。前処理の結果は等価であり、安全に統一できる。

### 4. promptDetection.cleanContentのレスポンス非露出確認

**評価**: 確認済み

`current-output/route.ts`のAPIレスポンス構築（L117-142）において、`promptDetection`オブジェクトから抽出されるのは`promptData`フィールドのみ（L133）:

```typescript
promptData: isPromptWaiting ? statusResult.promptDetection.promptData ?? null : null,
```

`cleanContent`、`rawContent`、`isPrompt`はAPIレスポンスに含まれない。これは変更前と同一の動作である。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| データ漏洩 | promptDetection内のcleanContent/rawContentの不意な露出 | Low | Low | P3 |
| ReDoS | detectPrompt()内の既存regexパターン | Low | Low | 対応不要（既に分析済み） |
| 不変条件違反 | hasActivePrompt !== promptDetection.isPrompt | Low | Very Low | 対応不要（構造的保証） |

---

## 改善推奨事項

### 必須改善項目 (Must Fix)

なし。

### 推奨改善項目 (Should Fix)

なし。

### 検討事項 (Consider)

| ID | カテゴリ | 概要 | 推奨 |
|----|---------|------|------|
| SEC4-001 | 情報露出 | 将来の新規呼び出し元がpromptDetection内のデータを不用意にAPIレスポンスに含めるリスク | コードレビューで確認。現時点では対応不要 |
| SEC4-002 | defense-in-depth | promptData.instructionText内のtmux出力由来テキストのサニタイズ | 既存アーキテクチャ（React JSXエスケープ）で対応済み。現時点では対応不要 |

---

## 総評

Issue #408の設計方針書はセキュリティ観点から**承認**する。

この変更は純粋なリファクタリングであり、以下の点でセキュリティへの影響が極めて限定的:

1. **APIレスポンス形状の不変**: クライアントに返されるデータ構造に変更なし
2. **新規regexの不在**: ReDoSリスクの追加なし
3. **認証・認可への影響なし**: ミドルウェア、IP制限に変更なし
4. **前処理の等価性**: 統合前後で`detectPrompt()`への入力が同一であることを実コードレベルで確認
5. **型安全性の向上**: requiredフィールドによるコンパイラ強制（DR1-001）はセキュリティ上もdefense-in-depthとして有効

セキュリティ上の懸念事項は発見されなかった。

---

*Reviewed by: Architecture Review Agent (Stage 4 - Security)*
*Date: 2026-03-03*
