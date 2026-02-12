# Architecture Review: Issue #235 - Stage 2 整合性レビュー

## Executive Summary

Issue #235 の設計方針書「プロンプト検出時の指示メッセージ保持（rawContent導入）」に対して、整合性（Consistency）の観点からレビューを実施した。

設計書は全体的に高品質であり、既存実装との整合性が良好に保たれている。行番号参照も概ね正確で、影響範囲分析も的確である。ただし、**lastLines 変数のスコープ変更方法の不明確さ**（MF-S2-001）と、**current-output/route.ts の影響なし判定の技術的根拠不足**（MF-S2-002）の2件を Must Fix として指摘する。

**判定: 条件付き承認（Conditionally Approved）**
**スコア: 4/5**

---

## 1. レビュー対象

| 項目 | 内容 |
|------|------|
| Issue | #235 |
| 設計書 | `dev-reports/design/issue-235-prompt-rawcontent-design-policy.md` |
| レビュー観点 | 整合性（Consistency） |
| ステージ | Stage 2 |

### レビュー対象ファイル

| ファイル | 用途 |
|---------|------|
| `src/lib/prompt-detector.ts` | プロンプト検出ロジック（主要変更対象） |
| `src/lib/response-poller.ts` | レスポンスポーリング（DB保存ロジック変更対象） |
| `src/components/worktree/PromptMessage.tsx` | プロンプト表示コンポーネント（UI変更対象） |
| `src/lib/claude-poller.ts` | 旧ポーラー（到達不能コード確認） |
| `src/lib/auto-yes-manager.ts` | Auto-Yes管理（影響なし確認） |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 出力取得API（影響なし確認） |
| `src/types/models.ts` | 型定義（ChatMessage型確認） |

---

## 2. 整合性検証結果

### 2.1 型定義とコード実装の整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| `PromptDetectionResult` 型拡張 | `rawContent?: string` フィールド追加（Section 3.1） | 現在の型定義（L40-47）に `isPrompt`, `promptData?`, `cleanContent` の3フィールドのみ | 差異なし（optional追加は後方互換） |
| `ChatMessage` 型 | 変更なし（Section 3.3） | `src/types/models.ts` L181-196 で `content: string` を保持 | 差異なし |
| `PromptData` 型 | 変更なし（Section 3.3） | 設計書通り変更不要 | 差異なし |

**判定**: 型定義の整合性は良好。optional フィールド追加により既存コードへの影響は皆無。

### 2.2 データフローの整合性

設計書 Section 2.1 のデータフロー図を実装と照合した。

| フロー段階 | 設計書の記載 | 実装確認結果 | 差異 |
|-----------|------------|------------|------|
| tmux output -> extractResponse | `response-poller.ts` の `extractResponse` | L244-538 で実装確認 | 差異なし |
| extractResponse -> detectPromptWithOptions | `response-poller.ts` 内ヘルパー関数経由 | L95-101 の `detectPromptWithOptions()` で `stripAnsi()` + `detectPrompt()` を呼び出し | 差異なし |
| detectPrompt -> truncateRawContent | 新規追加（Section 4.1.5） | 未実装（設計段階） | N/A |
| isPrompt -> content: rawContent or cleanContent | `response-poller.ts` L618 を変更 | 現在 L618 で `promptDetection.cleanContent` を使用中 | 差異なし（設計書の変更箇所と一致） |
| DB保存 -> WebSocket broadcast | L625-626 | 実装確認済み | 差異なし |
| PromptMessage.tsx 表示 | `message.content` を表示 | 現在は `prompt.question` のみ表示（L51-53） | 設計書の新規追加と整合 |

**判定**: データフローは設計書と既存実装の間で整合している。変更箇所の特定も正確。

### 2.3 行番号参照の整合性

設計書内で参照されている行番号を実装コードと突合した。

| 設計書の行番号 | 対象ファイル | 実際の行番号 | 差異 |
|-------------|------------|------------|------|
| L488-509 (multiple_choice return) | `prompt-detector.ts` | L488-509 | **一致** |
| L120-131 (Yes/No return) | `prompt-detector.ts` | L120-131 | **一致** |
| L143-153 (Approve return) | `prompt-detector.ts` | L143-152 | **1行ずれ** |
| L157-160 (非検出 return) | `prompt-detector.ts` | L157-160 | **一致** |
| L615-623 (response-poller DB保存) | `response-poller.ts` | L615-623 | **一致** |
| L618 (content値変更) | `response-poller.ts` | L618 | **一致** |
| L234付近 (claude-poller TODO) | `claude-poller.ts` | L234 | **一致** |
| L245付近 (claude-poller content) | `claude-poller.ts` | L245 | **一致** |

**判定**: 行番号の精度は高い（8箇所中7箇所が完全一致、1箇所が1行のずれのみ）。

### 2.4 影響範囲分析の整合性

設計書 Section 11 の「影響なし確認済みコンポーネント」を実装コードで検証した。

| コンポーネント | 設計書の判定 | 実装確認結果 | 整合性 |
|-------------|------------|------------|--------|
| `auto-yes-manager.ts` | 影響なし（isPrompt/promptDataのみ使用） | L319付近で `promptDetection.isPrompt` と `.promptData` のみ参照。cleanContent/rawContent は未使用 | **整合** |
| `auto-yes-resolver.ts` | 影響なし（PromptData型のみ） | PromptDetectionResult を import していない | **整合** |
| `status-detector.ts` | 影響なし（isPromptフラグのみ） | detectPrompt() を呼び出すが isPrompt のみ参照 | **整合** |
| `claude-session.ts` | 影響なし | prompt-detector を import していない | **整合** |
| `claude-poller.ts` | 到達不能コード [SF-001] | L162, L234 に TODO [Issue #193] コメントあり | **整合** |
| `current-output/route.ts` | 影響なし（ローカル型注釈） | L91 にローカル型注釈あり。rawContent なしでも TypeScript 代入は成功 | **整合（補足要）** |
| `prompt-response/route.ts` | 影響なし（isPromptフラグのみ） | PromptDetectionResult を import するが isPrompt と promptData のみ使用 | **整合** |
| `useAutoYes.ts` | 影響なし（PromptDataのみ） | PromptDetectionResult を import していない | **整合** |
| `cli-tools/codex.ts` | 間接的恩恵 | response-poller.ts 経由 | **整合** |

**判定**: 影響範囲分析は全9コンポーネントで正確。current-output/route.ts のみ技術的根拠の補足を推奨。

### 2.5 設計書内の記述の一貫性

| 検証項目 | 結果 |
|---------|------|
| rawContent のセマンティクス | Section 3.1 の JSDoc と Section 3.2 のソース定義表で一貫。「stripAnsi適用済み」の説明が両セクションで整合 |
| truncate ルール | Section 3.2 [MF-001] と Section 4.1.5 のコード例が完全一致。定数名・値・ロジックに矛盾なし |
| [SF-003] の末尾20行拡張 | Section 3.2, 4.1.2, 4.1.3, 7.1, 9.1 で一貫して「末尾20行」と記載 |
| テスト項目数 | Section 6.1 で7項目、Section 6.2 で4項目、Section 14 のチェックリストと一致 |
| 実装順序 | Section 10 の10ステップが Section 14 のチェックリスト13項目と整合（チェックリストはより細粒度） |

**判定**: 設計書内の記述に矛盾なし。セクション間の相互参照も正確。

---

## 3. 指摘事項

### 3.1 Must Fix（必須改善）

#### MF-S2-001: lastLines 変数のスコープ変更方法の不明確さ

**重要度**: medium

**詳細**: 設計書 Section 4.1.2 および 4.1.3 の変更後コードでは、各パターン内で `const lastLines = lines.slice(-20).join('\n');` と新たに定義するように記載されている。しかし、既存実装では `detectPrompt()` 関数の L97 で `const lastLines = lines.slice(-10).join('\n');` が定義され、この変数は Yes/No パターン（L117）と Approve パターン（L137）の両方で共有されている。

設計書のコード例を素直に読むと、各パターンのブロック内で lastLines を再定義する（シャドウイングする）ように見えるが、これは以下の疑問を生む：

1. L97 の既存 `lastLines` を `lines.slice(-20)` に変更するのか（全体に影響）
2. 各パターン内で `const lastLines` を再定義するのか（ブロックスコープ）
3. 新しい変数名（例: `extendedLastLines`）を使うのか

**該当箇所**:
- `src/lib/prompt-detector.ts` L97: `const lastLines = lines.slice(-10).join('\n');`
- 設計書 Section 4.1.2, 4.1.3

**推奨対応**: 設計書の実装手順（Section 10 Step 4）に、L97 の既存 `lastLines` を `lines.slice(-20)` に変更するか、各パターン内で新変数を定義するかを明記する。実装者の解釈に委ねないこと。

#### MF-S2-002: current-output/route.ts の影響なし判定の技術的根拠不足

**重要度**: medium

**詳細**: 設計書 Section 11 では current-output/route.ts について「ローカル型注釈に rawContent が含まれないため無視される」と記載している。技術的にはTypeScriptの構造的部分型により代入は問題ないが、**なぜこのルートでは rawContent を使用しなくてよいのか**の理由が欠けている。

実装を確認すると、このルートは `promptDetection` の結果を以下の目的でのみ使用している：
- `isPromptWaiting` フラグの判定（L99: `statusResult.hasActivePrompt`）
- `promptData` のAPI応答への含有（L126）

つまり DB 保存処理を持たないため rawContent は不要だが、設計書にはこの根拠が記載されていない。

**該当箇所**:
- `src/app/api/worktrees/[id]/current-output/route.ts` L91
- 設計書 Section 11

**推奨対応**: Section 11 の current-output/route.ts の説明に「このルートは promptDetection の結果をDB保存に使用しない（isPromptWaiting と promptData のみAPI応答に含める）ため、rawContent の有無は動作に影響しない」という技術的根拠を補足する。

### 3.2 Should Fix（推奨改善）

#### SF-S2-001: detectMultipleChoicePrompt の return 文のコード例精度

設計書 Section 4.1.1 のコード例で `promptData: { ... }` と省略されているが、実装では `options` フィールドに `collectedOptions.map()` 処理が含まれる。設計書のコード例が簡略表現であることを注記すべき。

#### SF-S2-002: Approve パターンの行番号1行ずれ

設計書 Section 4.1.3 で「L143-153」と記載しているが、実装は L143-152。行番号を修正する。

#### SF-S2-003: noPromptResult() ヘルパーの設計書への明記

Section 4.1.4 で非検出パスを記載しているが、`noPromptResult()` ヘルパー関数（L204-208）の存在と、この関数が rawContent を含まない設計であることを明記すべき。テスト戦略 Section 6.1 の「noPromptResult()」テストケースとの関連も記載する。

#### SF-S2-004: PromptMessage.tsx のJSX変更差分の具体化

設計書 Section 4.3.2 の UIレイアウト図は分かりやすいが、既存コードの `{/* Question */}` セクション（L49-54）に対してどの位置にどのような JSX を挿入するのかの具体的な差分が欠けている。

#### SF-S2-005: response-poller.ts L618 変更時のコメント追記

実装時に L618 付近に変更理由のコメント（`// Issue #235: rawContent 優先` 等）を追加することを推奨。

### 3.3 Consider（将来検討事項）

#### C-S2-001: auto-yes-manager.ts の将来的な rawContent 使用リスク

現時点では影響なし。将来 auto-yes-manager が content 保存に関与する場合のみ再検討が必要。

#### C-S2-002: claude-poller.ts の到達不能コード記載の正確性

設計書の記載は正確。将来到達可能になった場合の対応方針も適切に記載済み。

#### C-S2-003: テストファイルのフルパス記載

設計書のテスト戦略セクションにテストファイルのフルパス（`tests/unit/prompt-detector.test.ts`、`tests/unit/lib/response-poller.test.ts`）と、`PromptMessage.test.tsx` の新規作成が必要であることを明記すると実装者の利便性が向上する。

---

## 4. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | lastLines スコープ変更の解釈違いによるバグ | Low | Med | P2 |
| 技術的リスク | PromptMessage.tsx のJSX挿入位置の曖昧さ | Low | Low | P3 |
| セキュリティ | rawContent を dangerouslySetInnerHTML で表示するリスク | Low | Low | P3 (設計書で明示的に禁止済み) |
| 運用リスク | 既存DBデータとの後方互換性 | Low | Low | P3 (マイグレーション不要設計) |

---

## 5. 総合評価

| 評価項目 | スコア | コメント |
|---------|-------|---------|
| 型定義の整合性 | 5/5 | optional フィールド追加で後方互換性を維持。問題なし |
| データフローの整合性 | 5/5 | 設計書のフロー図と実装の変更箇所が正確に対応 |
| 行番号の正確性 | 4/5 | 8箇所中7箇所が完全一致。1箇所に1行のずれ |
| 影響範囲の正確性 | 4/5 | 9コンポーネント全てで判定が正確。1箇所に根拠補足が必要 |
| 設計書内の一貫性 | 5/5 | セクション間の相互参照に矛盾なし |
| 実装指示の明確性 | 3/5 | lastLines スコープ変更とJSX差分の具体性に改善余地 |

**総合スコア: 4/5**

---

## 6. 承認ステータス

**条件付き承認（Conditionally Approved）**

以下の2件の Must Fix を対応後、実装に着手可能：

1. **MF-S2-001**: lastLines 変数のスコープ変更方法を明確化
2. **MF-S2-002**: current-output/route.ts の影響なし判定に技術的根拠を補足

---

*Reviewed by: Architecture Review Agent*
*Date: 2026-02-11*
*Focus: 整合性 (Consistency)*
*Design Document: dev-reports/design/issue-235-prompt-rawcontent-design-policy.md*
