# Architecture Review: Issue #408 Stage 2 (整合性レビュー)

## Executive Summary

| 項目 | 値 |
|------|-----|
| Issue | #408 |
| Stage | 2 - 整合性レビュー |
| Status | conditionally_approved |
| Score | 4/5 |
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 3 |

設計方針書とコードベースの整合性は全体的に良好。7つの検証項目全てを確認し、重大な不整合は発見されなかった。唯一のshould_fix項目はSection 4.2のreturnパス一覧における行番号の微修正（3箇所で1行のずれ）のみ。

---

## 検証結果一覧

### 検証1: 型定義の整合性 -- 合格

`StatusDetectionResult`への`promptDetection: PromptDetectionResult`追加は、既存インターフェースと整合する。

現在の`StatusDetectionResult`（`/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/status-detector.ts` L42-L60）:

```typescript
export interface StatusDetectionResult {
  status: SessionStatus;
  confidence: StatusConfidence;
  reason: string;
  hasActivePrompt: boolean;
}
```

設計方針書で提案されているrequiredフィールド `promptDetection: PromptDetectionResult` の追加は、既存の4フィールドを保持しつつ1フィールドを追加する形式であり、構造的に整合する。`PromptDetectionResult`型は`prompt-detector.ts`から既にexportされており、importパスも`status-detector.ts`の既存import方向（`status-detector` -> `prompt-detector`）と一致するため循環依存リスクはない。

### 検証2: return パス数 -- 合格

設計方針書の「全8箇所」は、実際のコードと完全に一致する。

`detectSessionStatus()`内のreturn文（grep結果）:

| パス | 実際の行番号 | reason |
|------|-------------|--------|
| 1 | L147 | prompt_detected |
| 2 | L158 | thinking_indicator |
| 3 | L177 | opencode_processing_indicator |
| 4 | L212 | thinking_indicator (opencode) |
| 5 | L225 | opencode_response_complete |
| 6 | L239 | input_prompt |
| 7 | L252 | no_recent_output |
| 8 | L263 | default |

### 検証3: import削除の整合性 -- 合格

削除対象の4つのimportは全て`/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/app/api/worktrees/[id]/current-output/route.ts`に存在する。

| import | ファイル内の行 | 存在 |
|--------|--------------|------|
| `detectPrompt` from `@/lib/prompt-detector` | L9 | 確認済み |
| `buildDetectPromptOptions` from `@/lib/cli-patterns` | L13 | 確認済み |
| `stripBoxDrawing` from `@/lib/cli-patterns` | L13 | 確認済み |
| `stripAnsi` from `@/lib/cli-patterns` | L13 | 確認済み |

`stripAnsi`の使用箇所: L13（import）とL81（`const cleanOutput = stripAnsi(output)`）のみ。`cleanOutput`の参照箇所: L81（定義）、L98（初期化）、L101（detectPrompt引数）。L98-L102削除後、`cleanOutput`は未参照となり、`stripAnsi`も安全に削除可能。

### 検証4: コードスニペットの正確性 -- 概ね合格（軽微な差異あり）

Section 4.3の「変更前」コードは実際のコードと概ね一致する。ただし以下の軽微な差異がある:

- L98の`promptDetection`変数宣言において、設計方針書では型注釈が省略されている。実際のコードには `{ isPrompt: boolean; cleanContent: string; promptData?: unknown }` の明示的型注釈が付いている。
- L87-L98間にSF-001のコメントブロック（L90-L97、8行）が存在するが、設計方針書のスニペットでは省略されている。

いずれも削除対象コードの特定に影響しないため、実装上の問題にはならない。

### 検証5: PromptDetectionResult型定義 -- 合格

`/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/prompt-detector.ts` L54-L69:

```typescript
export interface PromptDetectionResult {
  isPrompt: boolean;
  promptData?: PromptData;
  cleanContent: string;
  rawContent?: string;
}
```

設計方針書Section 3.1 JSDocの記載:
- `isPrompt: boolean (always matches hasActivePrompt)` -- 一致
- `promptData?: PromptData (question, options, type etc.)` -- 一致
- `cleanContent: string` -- 一致
- `rawContent?: string (truncated, Issue #235)` -- 一致

4フィールド全て完全一致。

### 検証6: 行番号の正確性 -- 概ね合格（3箇所で1行のずれ）

Section 4.2のreturnパス一覧の行番号を検証:

| パス | 設計方針書 | 実際 | 差異 |
|------|-----------|------|------|
| 1 | L147 | L147 | 一致 |
| 2 | L159 | L158 | -1 |
| 3 | L178 | L177 | -1 |
| 4 | L213 | L212 | -1 |
| 5 | L225 | L225 | 一致 |
| 6 | L239 | L239 | 一致 |
| 7 | L252 | L252 | 一致 |
| 8 | L263 | L263 | 一致 |

パス2, 3, 4で1行のずれがある。Section 4.2は「概算」と注記しているが、修正が望ましい。return文の開始行（`return {`）の行番号で統一すべき。

### 検証7: 既存テストの整合性 -- 合格

設計方針書Section 7.3で言及された3つのテストファイルは全て存在する。

| テストファイル | 存在 | 内容確認 |
|--------------|------|---------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/__tests__/status-detector.test.ts` | 存在 | `detectSessionStatus`のテスト。モックオブジェクトに`promptDetection`追加が必要になる可能性あり（設計方針書の記載通り） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/tests/unit/lib/status-detector.test.ts` | 存在 | Issue #188以降のテスト。新テスト追加先として適切 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/tests/integration/current-output-thinking.test.ts` | 存在 | SF-001コメント関連のテスト |

補足: 既存テストでは`detectSessionStatus()`の戻り値を直接検証しており、`StatusDetectionResult`のモックオブジェクトを構築していない（関数を直接呼び出して結果を検証するスタイル）。そのため、requiredフィールド追加による既存テスト修正の必要性は低い（関数が自動的にフィールドを返すようになるため）。

---

## Detailed Findings

### DR2-001 [should_fix] Section 4.2 行番号の不一致

**場所**: 設計方針書 Section 4.2 return パス一覧

**説明**: パス2はL159と記載されているが実際はL158、パス3はL178と記載されているが実際はL177、パス4はL213と記載されているが実際はL212。いずれも1行分のずれ。

**提案**: パス2をL158、パス3をL177、パス4をL212に修正する。

### DR2-002 [nice_to_have] Section 4.3 型注釈の省略

**場所**: 設計方針書 Section 4.3 削除対象コード L98

**説明**: 実際のコードでは`promptDetection`変数に明示的な型注釈 `{ isPrompt: boolean; cleanContent: string; promptData?: unknown }` が付いているが、設計方針書では省略されている。

**提案**: 型注釈を追記するか、「型注釈省略」と注記する。削除対象のため低優先度。

### DR2-003 [nice_to_have] Section 4.3 コメントブロックの省略

**場所**: 設計方針書 Section 4.3 変更前コード（L87-102）

**説明**: L87のdetectSessionStatus呼び出しとL98の間にSF-001コメントブロック（L90-L97、8行）が存在するが、設計方針書では省略されている。

**提案**: コメントブロックの存在を注記する。削除対象の特定に影響しないため低優先度。

### DR2-004 [nice_to_have] Section 4.4 stripAnsi削除理由の因果関係

**場所**: 設計方針書 Section 4.4 stripAnsi削除理由

**説明**: 「L81のcleanOutput変数が不要になるため」と記載されているが、cleanOutputが不要になる理由（L98/L101の参照が消えること）の因果関係が暗黙的。

**提案**: 削除理由を「L98-L102の削除によりcleanOutputの参照箇所がなくなり、L81の定義自体が不要となるため」のように因果関係を明確化する。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 行番号のずれにより実装時の対象箇所特定に時間がかかる | Low | Low | P3 |
| セキュリティ | 設計方針書のセキュリティ関連記載（Section 5）は実コードと整合 | Low | Low | - |
| 運用リスク | 既存テストへの影響は軽微（関数直接呼び出しスタイルのため） | Low | Low | - |

---

## Approval Status

**conditionally_approved** -- should_fix 1件（DR2-001: 行番号修正）の対応を推奨する。nice_to_have 3件は対応任意。設計方針書の核心部分（型設計、return パス数、import削除対象、PromptDetectionResult構造、テストファイル存在）は全て実コードと整合しており、実装に進んで問題ない。

---

*Generated by architecture-review-agent for Issue #408 Stage 2*
*Date: 2026-03-03*
