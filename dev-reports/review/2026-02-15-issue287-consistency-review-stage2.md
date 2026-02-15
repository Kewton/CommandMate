# Architecture Review: Issue #287 - Stage 2 整合性 (Consistency) Review

**Issue**: #287 - 選択肢プロンプト送信のフォールバック不備修正
**Focus Area**: 整合性 (Consistency between design document and implementation)
**Date**: 2026-02-15
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

Issue #287 の設計方針書は、既存コードベースとの整合性が高い水準で維持されている。データフロー図、ファイルパス、行番号参照、型定義の全てが実際の実装と一致していることを確認した。コード重複（route.ts と auto-yes-manager.ts のカーソルキー送信ロジック）の存在も設計方針書の記載通りであり、MF-001 による共通化の根拠は正当である。

ただし、1件の Must Fix と3件の Should Fix が発見された。特に MF-S2-001（handlePromptRespond 内の cliTool 取得方法の不整合）は、C-004 の useRef パターン適用時に混乱を招く可能性がある。

---

## Detailed Findings

### 1. データフロー図の正確性

**結果: 正確**

設計方針書 Section 2 の Mermaid データフロー図を実装と照合した結果:

| フロー | 設計書の記載 | 実装の実態 | 差異 |
|--------|------------|-----------|------|
| PM/PP/MPS -> handlePromptRespond | `onRespond(answer)` | `onRespond: (answer: string) => Promise<void>` (PromptPanel.tsx L46, PromptMessage.tsx L18, MobilePromptSheet.tsx L44) | なし |
| state.prompt.data -> handlePromptRespond | promptType, defaultOptionNumber 導出 | `state.prompt.data` は WorktreeDetailRefactored.tsx L1437 で useAutoYes に渡されている。handlePromptRespond (L1126-1148) では現在未使用 | 設計通り（新規追加予定） |
| handlePromptRespond -> API | POST {answer, cliTool} | L1130-1134 で `JSON.stringify({ answer, cliTool: activeCliTab })` | 設計通り（promptType, defaultOptionNumber を追加予定） |
| useAutoYes -> API | POST {answer, cliTool} | L86-89 で `JSON.stringify({ answer, cliTool })` | 設計通り（promptType, defaultOptionNumber を追加予定） |
| API -> promptCheck 判定 | captureSessionOutput -> detectPrompt | route.ts L73-78 | なし |
| isClaudeMultiChoice -> sendSpecialKeys/sendKeys | カーソルキー or テキスト | route.ts L96-158 | なし |

### 2. ファイルパスの正確性

**結果: 全て正確**

| 設計書記載パス | 実在確認 |
|--------------|---------|
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | 確認済み |
| `src/lib/auto-yes-manager.ts` | 確認済み |
| `src/hooks/useAutoYes.ts` | 確認済み |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 確認済み |
| `src/types/models.ts` | 確認済み |
| `src/lib/prompt-detector.ts` | 確認済み |
| `src/components/worktree/PromptMessage.tsx` | 確認済み |
| `src/components/worktree/PromptPanel.tsx` | 確認済み |
| `src/components/mobile/MobilePromptSheet.tsx` | 確認済み |
| `tests/unit/api/prompt-response-verification.test.ts` | 確認済み |
| `tests/integration/worktree-detail-integration.test.tsx` | 確認済み |

新規作成予定ファイル (`src/lib/cursor-key-sender.ts`, `src/lib/prompt-response-utils.ts`) は未存在で正しい。

### 3. 行番号の正確性

**結果: 全て正確**

| 設計書の行番号参照 | 実際の行番号 | 一致 |
|------------------|------------|------|
| route.ts L17-20 (PromptResponseRequest) | L17-20: `interface PromptResponseRequest { answer: string; cliTool?: CLIToolType; }` | 一致 |
| route.ts L86-89 (catch節) | L86-89: `catch { console.warn(...) }` | 一致 |
| route.ts L96-158 (カーソルキー送信ロジック) | L96-158: isClaudeMultiChoice 判定から sendKeys まで | 一致 |
| route.ts L110 (multi-select検出) | L110: `const isMultiSelect = mcOptions.some(...)` | 一致 |
| auto-yes-manager.ts L343-399 (重複ロジック) | L343-399: isClaudeMultiChoice 判定からカーソルキー送信まで | 一致 |
| prompt-response-verification.test.ts L163-177 (captureSessionOutput失敗テスト) | L163-177: `it('should proceed with send when capture fails...')` | 一致 |

### 4. 型定義の整合性

**結果: 整合（注意事項あり）**

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| PromptResponseRequest 拡張 | `promptType?: 'yes_no' \| 'multiple_choice'`, `defaultOptionNumber?: number` | 現行は `answer: string`, `cliTool?: CLIToolType` のみ | 設計通り（新規追加予定） |
| PromptData union 型 | `YesNoPromptData \| MultipleChoicePromptData` | `src/types/models.ts` L178: `type PromptData = YesNoPromptData \| MultipleChoicePromptData` | 一致 |
| MultipleChoiceOption.isDefault | `boolean` | `src/types/models.ts` L161: `isDefault?: boolean` | 一致（optional） |
| MultipleChoiceOption.number | `number` | `src/types/models.ts` L157: `number: number` | 一致 |
| defaultOptionNumber 導出 | `promptData.options.find(o => o.isDefault)?.number` | route.ts L103: `mcOptions.find(o => o.isDefault)?.number ?? 1` | 一致 |

**注意**: `PromptType` 型 (models.ts L121) には `'approval' | 'choice' | 'input' | 'continue'` も含まれるが、`PromptData` union 型には含まれない。設計方針書の `promptType` フィールドは `'yes_no' | 'multiple_choice'` のみを対象としており、`PromptData.type` と一致するため問題ない。

### 5. 設計決定と実装制約の整合性

| 決定事項 | 設計書の根拠 | 実装での確認 | 整合性 |
|---------|------------|------------|--------|
| D-2: 非破壊的アプローチ | `onRespond` シグネチャ不変 | 全3コンポーネントで `(answer: string) => Promise<void>` 確認 | 整合 |
| D-3: promptCheck 優先 | リアルタイム出力の信頼性 | route.ts L72-89 で promptCheck 取得、L86 catch で null に | 整合 |
| D-5: `?? 1` フォールバック | 既存コードとの一貫性 | route.ts L104, auto-yes-manager.ts L351 で `?? 1` 使用済み | 整合 |
| D-6: multi-select は promptCheck 依存 | options データ必要 | route.ts L102, L110 で promptCheck.promptData.options 使用 | 整合 |
| D-10: useRef パターン | activeCliTabRef との一貫性 | WorktreeDetailRefactored.tsx L940-941 で activeCliTabRef 使用済み | 整合 |

### 6. コード重複の検証

**結果: 重複確認済み（MF-001 の根拠は正当）**

route.ts L96-158 と auto-yes-manager.ts L343-399 を比較:

- `isClaudeMultiChoice` 判定条件: 同一ロジック
- `offset = targetNum - defaultNum` 計算: 同一
- `isMultiSelect` 判定 (`/^\[[ x]\] /.test(o.label)`): 同一
- multi-select のキー配列構築ロジック: 同一
- single-select のキー配列構築ロジック: 同一
- テキスト送信パターン (`sendKeys` + 100ms wait + Enter): 同一

唯一の差異は変数名（`promptCheck?.promptData` vs `promptDetection.promptData`）のみで、ロジックは完全に重複している。

### 7. 変更不要ファイルの検証

**結果: 確認済み**

| ファイル | 設計書の判断 | 検証結果 |
|---------|------------|---------|
| PromptMessage.tsx | onRespond シグネチャ不変 | `onRespond: (answer: string) => Promise<void>` (L18) - 変更不要 |
| PromptPanel.tsx | 同上 | `onRespond: (answer: string) => Promise<void>` (L46, L55) - 変更不要 |
| MobilePromptSheet.tsx | 同上 | `onRespond: (answer: string) => Promise<void>` (L44, L195) - 変更不要 |
| tmux.ts | 送信関数自体は変更不要 | sendKeys/sendSpecialKeys は引数変更なし - 変更不要 |
| prompt-detector.ts | 検出ロジック自体は変更不要 | detectPrompt, PromptDetectionResult は変更不要 - 確認済み |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | handlePromptRespond の cliTool 取得方法の不整合 (MF-S2-001) | Medium | High | P2 |
| 技術的リスク | buildCursorKeys の cliToolId パラメータ欠落 (SF-S2-003) | Medium | Medium | P2 |
| 運用リスク | 行番号参照の無効化 (SF-S2-001) | Low | High | P3 |
| セキュリティ | なし | Low | Low | - |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix) - 1件

**MF-S2-001: handlePromptRespond の cliTool 取得方法の明確化**

設計方針書 Section 10 のコードサンプルでは:
```typescript
const handlePromptRespond = useCallback(async (answer: string) => {
  const promptData = promptDataRef.current;
  const body = buildPromptResponseBody(answer, cliTool, promptData);
  // ...
}, [/* state.prompt.data は不要 */]);
```

ここで `cliTool` が何を指すかが不明確。現行実装 (WorktreeDetailRefactored.tsx L1133) では `activeCliTab` を直接使用し、依存配列にも含めている (L1147)。一方、fetchMessages/fetchCurrentOutput では `activeCliTabRef.current` を使用している。

buildPromptResponseBody の第2引数として `activeCliTab` を使用するなら依存配列にそのまま含める必要があり、`activeCliTabRef.current` を使用するなら依存配列から除外できる。C-004 との組み合わせでどちらを採用するかを明記すべき。

### 推奨改善項目 (Should Fix) - 3件

**SF-S2-001**: 行番号参照に「実装前ベースライン」の注記を追加する。

**SF-S2-002**: useAutoYes.ts は promptData をフック引数として受け取るため useRef 化は不要であることを設計方針書に明記する。

**SF-S2-003**: CursorKeySendOptions インターフェースに cliToolId フィールドを追加するか、isClaudeMultiChoice 判定の責務を呼び出し側に置くかを設計方針書で明確にする。現在の設計では buildCursorKeys が isClaudeMultiChoice 判定も行う設計だが、cliToolId が引数にないため実装時に混乱する。

### 検討事項 (Consider) - 2件

**C-S2-001**: PromptType 型の拡張性について、promptType バリデーションで未知の値が来た場合のフォールバック動作を明記する。

**C-S2-002**: sendPromptAnswer() のインターフェース定義を追加するか、buildCursorKeys() で十分であれば言及を整理する。

---

## Approval Status

**Conditionally Approved (条件付き承認)**

設計方針書は既存コードベースとの整合性が高く、データフロー、ファイルパス、行番号、型定義、コード重複の全てにおいて正確である。MF-S2-001 (cliTool 取得方法の明確化) を修正した上で実装に進むことを推奨する。

---

*Generated by architecture-review-agent for Issue #287 Stage 2*
*Review type: 整合性 (Consistency)*
