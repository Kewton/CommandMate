# Architecture Review: Issue #208 - Stage 1 設計原則レビュー

| 項目 | 内容 |
|------|------|
| **Issue** | #208 Auto-Yes 番号付きリスト誤検出防止 |
| **Stage** | Stage 1: 通常レビュー（設計原則） |
| **対象** | 設計方針書 |
| **ステータス** | Approved |
| **スコア** | 5/5 |
| **レビュー日** | 2026-02-09 |

---

## Executive Summary

Issue #208の設計方針書は、SOLID/KISS/YAGNI/DRY の各設計原則に高い水準で準拠している。既存のLayer 5（SEC-001）を拡張するアプローチにより、変更範囲を `prompt-detector.ts` 単一ファイルに限定し、呼び出し元への影響をゼロに抑えている。新規関数 `isQuestionLikeLine()` は単一責任・純粋関数として設計されており、テスト容易性が高い。必須改善項目はなく、2件の推奨事項と2件の検討事項を指摘する。

---

## 設計原則評価

### SOLID原則

#### S - 単一責任の原則 (SRP): PASS (5/5)

**評価**: 優れた責任分離が実現されている。

- `isQuestionLikeLine()` は「質問行か否かの判定」という単一の責任のみを持つ純粋関数として設計
- `QUESTION_KEYWORD_PATTERN` は「質問キーワードの定義」という単一責任の定数
- Layer 5内の SEC-001a（質問行存在チェック）と SEC-001b（質問行妥当性検証）が明確に分離
- 設計方針書セクション3.1のコード例で、各ガードが独立した `if` 文として記述されており、責任境界が視覚的にも明確

**根拠（実装コード対照）**:
- 現行の `prompt-detector.ts` は `detectMultipleChoicePrompt()` 内で各防御層（Layer 1-5）を順序立てて処理しており、新規SEC-001bの追加もこのパターンに沿っている
- `isConsecutiveFromOne()`（L230-237）、`isContinuationLine()`（L264-277）と同様に、`isQuestionLikeLine()` も独立したヘルパー関数として配置される設計

#### O - 開放閉鎖の原則 (OCP): PASS (4/5)

**評価**: 拡張に対して開かれた設計。

- `QUESTION_KEYWORD_PATTERN` の正規表現にキーワードを追加するだけで、新しい質問フレーズへの対応が可能（セクション7.3）
- 判定ロジック本体（Pattern 1: `?`終端、Pattern 2: キーワード+`:`終端）の変更なしにキーワードセットを拡張可能
- 既存の `DetectPromptOptions` インターフェースに新規プロパティを追加する必要がなく、呼び出し側コードの修正が不要

**軽微な懸念**: 将来、全く新しい判定パターン（Pattern 3）が必要になった場合は `isQuestionLikeLine()` 自体の修正が必要。ただし、これは設計方針書セクション8.1で「トレードオフ」として認識・記録されている。

#### L - リスコフの置換原則 (LSP): PASS (5/5)

**評価**: 適用対象外であり問題なし。

- 本設計はクラス継承やインターフェース実装を使用しない関数ベースの設計
- `detectPrompt()` の呼び出しシグネチャ（`output: string, options?: DetectPromptOptions`）に変更がないため、既存の全呼び出し元との互換性が維持される

#### I - インターフェース分離の原則 (ISP): PASS (5/5)

**評価**: インターフェースの肥大化を適切に回避。

- `DetectPromptOptions` インターフェースに新規プロパティを追加しない設計判断は正しい
- `isQuestionLikeLine()` をモジュール内部関数（非export）として設計し、公開APIの表面積を増やさない
- 呼び出し元の `auto-yes-manager.ts`、`status-detector.ts`、`response-poller.ts` 等に変更が不要（セクション2.3）

#### D - 依存性逆転の原則 (DIP): PASS (5/5)

**評価**: 依存方向が適切。

- `isQuestionLikeLine()` は外部モジュールへの依存を持たない純粋関数
- `QUESTION_KEYWORD_PATTERN` はモジュールスコープ定数であり、外部状態への依存なし
- Layer 5の修正は `detectMultipleChoicePrompt()` 内部で完結し、上位モジュール（auto-yes-manager.ts等）に逆方向の依存を作らない

---

### KISS原則: PASS (4/5)

**評価**: シンプルかつ理解しやすい設計。

**良い点**:
- 新規防御層の追加ではなく、既存Layer 5の拡張という最もシンプルなアプローチを選択
- `isQuestionLikeLine()` のロジックは2パターンのみ（`?`終端 / キーワード+`:`終端）で明快
- セクション4.1の5つの誤検出シナリオ分析が、判定ロジックの動作を直感的に理解させる
- 代替案との比較（セクション8.2）で、より複雑な案を正当な理由で却下

**軽微な懸念**:
- `QUESTION_KEYWORD_PATTERN` に16個のキーワードが含まれており、一部（`how`, `where`, `type`, `specify`, `approve`, `accept`, `reject`, `decide`, `preference`, `option`）はClaude Codeの実プロンプトで観測されているか不明。より少数のキーワードで開始し、観測に基づいて追加する方がシンプル（SF-001参照）

---

### YAGNI原則: PASS (4/5)

**評価**: 必要最小限の実装範囲を適切に設定。

**良い点**:
- 変更ファイルを `prompt-detector.ts` と `prompt-detector.test.ts` の2ファイルのみに限定
- 呼び出し元への変更を回避し、不要な修正を排除
- `DetectPromptOptions` への新規プロパティ追加を見送り（既存のSF-001コメントの設計方針に準拠）
- セクション2.1で3つの代替案を却下し、過剰な実装を防止

**軽微な懸念**:
- 前述のキーワード数の件に加え、全角疑問符（`？`）対応はセクション4.2で「防御的措置」として位置づけられているが、Claude Code/CLIの質問プロンプトは英語で表示されるとの記述もあり、実需要が不明確。ただし、コストが `line.endsWith('？')` の1行追加のみであるため、防御的措置として許容範囲内。

---

### DRY原則: PASS (4/5)

**評価**: ロジック重複なし。

**良い点**:
- `isQuestionLikeLine()` として判定ロジックを1箇所に集約
- 既存のLayer 5ガード（SEC-001a）と新規ガード（SEC-001b）が同一の制御フロー内に配置され、分散を防止
- テスト計画（セクション6）で `isQuestionLikeLine()` の単体テスト（T11）と統合テスト（T1-T10, T12-T14）を分離し、テストロジックの重複を回避

**軽微な懸念**:
- 設計方針書内で全角疑問符判定がセクション3.2（基本実装）とセクション4.2（追加対応）に分離記述されている。実装時にセクション4.2を見落とすリスクがある（SF-002参照）

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | QUESTION_KEYWORD_PATTERNの未知キーワードによるFalse Negative | Low | Low | P3 |
| セキュリティ | Auto-Yes誤送信（現バグの残存） | Low | Low | - |
| 運用リスク | キーワードパターンの保守負荷 | Low | Low | P3 |

**総合リスク評価**: Low

設計方針書で識別されたリスク（False Positive / False Negative）に対する対策が適切に設計されており、トレードオフが明確に記録されている。

---

## 改善提案

### 推奨改善項目 (Should Fix)

#### SF-001: QUESTION_KEYWORD_PATTERNのキーワード精査

**カテゴリ**: KISS/YAGNI
**重要度**: Low
**優先度**: P3

QUESTION_KEYWORD_PATTERN に含まれる16個のキーワードのうち、Claude Codeの実プロンプトで実際に観測されたものとそうでないものを区別する。観測されていないキーワードについては以下のいずれかを選択する:

1. 削除して、観測時に追加する（YAGNI優先）
2. 残すが、コメントで「防御的追加: 実プロンプト未観測」と明記する（トレーサビリティ優先）

現在の設計方針書の記載:
```typescript
const QUESTION_KEYWORD_PATTERN = /(?:select|choose|pick|which|what|how|where|enter|type|specify|confirm|approve|accept|reject|decide|preference|option)/i;
```

推奨（最小限の開始セット案）:
```typescript
// Core: Claude Codeの実プロンプトで観測済み
// select, choose, pick, which, what, enter, confirm
// Defensive: 未観測だが高確率で使用されうる
// approve, type, specify
const QUESTION_KEYWORD_PATTERN = /(?:select|choose|pick|which|what|enter|confirm|approve|type|specify)/i;
```

#### SF-002: 全角疑問符判定の統合

**カテゴリ**: DRY
**重要度**: Low
**優先度**: P3

セクション3.2の `isQuestionLikeLine()` 定義に全角疑問符判定を統合し、セクション4.2を「補足説明」に降格する。

修正前（セクション3.2）:
```typescript
if (line.endsWith('?')) return true;
```

修正後（セクション3.2に統合）:
```typescript
if (line.endsWith('?') || line.endsWith('\uFF1F')) return true;
```

---

### 検討事項 (Consider)

#### C-001: QUESTION_KEYWORD_PATTERNの将来拡張設計メモ

既存の `DetectPromptOptions` の SF-001 コメント（`prompt-detector.ts` L15-21）に倣い、`QUESTION_KEYWORD_PATTERN` にも将来拡張メモを追加することを検討する。例:

```typescript
/**
 * [Future extension memo (SF-002)]
 * If a future requirement arises to use different keyword sets per CLI tool,
 * move this pattern into DetectPromptOptions or a per-tool configuration.
 * Per YAGNI, a single shared pattern is maintained for now.
 */
```

#### C-002: 全角コロン判定の将来対応

セクション4.1の日本語シナリオ分析で、全角コロン `：` が `endsWith(':')` にマッチしないことが正しく記述されている。将来的にCLIツールが全角コロンで質問を表示する可能性は極めて低いが、観測された場合に対応する設計余地は存在する。YAGNI原則に従い現時点では対応不要。

---

## テスト計画の評価

設計方針書セクション6のテスト計画は以下の点で適切:

| 評価項目 | 結果 | 詳細 |
|---------|------|------|
| 新規テストカバレッジ | 良好 | T1-T4: 誤検出防止、T5-T7: 正常検出、T8-T10: 回帰 |
| 単体テスト | 良好 | T11: isQuestionLikeLine()の入出力網羅（13パターン） |
| エッジケース | 良好 | T12: 全角疑問符、T13: 長出力、T14: インデント付き選択肢 |
| 回帰テスト | 良好 | T8-T10: 既存動作の維持を確認 |
| テスト数 | 適切 | 14件で十分な網羅性 |

---

## 承認判定

| 評価項目 | 結果 |
|---------|------|
| SOLID原則 | 全項目Pass（平均 4.8/5） |
| KISS原則 | Pass（4/5） |
| YAGNI原則 | Pass（4/5） |
| DRY原則 | Pass（4/5） |
| 必須改善項目 | 0件 |
| 推奨改善項目 | 2件（いずれもP3/Low） |
| 検討事項 | 2件 |
| リスク評価 | Low |

**判定: Approved**

設計方針書は全ての設計原則に高い水準で準拠しており、実装を進めて問題ない。推奨改善項目は実装時に対応するか、対応しない場合もその判断根拠をコメントとして残すことを推奨する。
