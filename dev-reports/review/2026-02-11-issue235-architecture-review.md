# Architecture Review Report: Issue #235 - rawContent導入設計

**Issue**: #235 - プロンプト検出時の指示メッセージ保持
**Focus Area**: 設計原則 (Design Principles)
**Stage**: 1 - 通常レビュー
**Status**: Conditionally Approved
**Score**: 4/5
**Date**: 2026-02-11

---

## Executive Summary

Issue #235の設計方針書は、`PromptDetectionResult`にoptionalな`rawContent`フィールドを追加し、プロンプト検出時の完全な出力テキストを保持する設計を提案している。全体としてSOLID/KISS/YAGNI/DRY原則に高い準拠度を示し、後方互換性を維持しつつ最小限の変更で課題を解決する設計となっている。

主な評価ポイント:
- **高い後方互換性**: optionalフィールド追加のみで既存コードへの影響が最小
- **変更範囲の限定性**: 3ファイルへの限定的な修正
- **影響分析の正確性**: auto-yes-manager等への非影響が実コードと照合して確認済み
- **条件付き承認の理由**: multiple_choiceパターンのrawContentサイズ制限が未定義(MF-001)

---

## Detailed Findings

### SOLID原則チェック

#### S - Single Responsibility Principle: PASS

各モジュールの責務分離が明確に維持されている。

| モジュール | 責務 | rawContentの影響 |
|-----------|------|-----------------|
| `prompt-detector.ts` | プロンプト検出と結果構造化 | rawContent生成を追加（検出責務の範囲内） |
| `response-poller.ts` | レスポンスポーリングとDB保存 | content値の選択ロジック変更（保存責務の範囲内） |
| `PromptMessage.tsx` | プロンプトUI表示 | 表示コンテンツの拡張（表示責務の範囲内） |

rawContentの追加は各モジュールの既存責務を逸脱しない。

#### O - Open/Closed Principle: PASS

`PromptDetectionResult`インターフェースにoptionalフィールドを追加する設計は、拡張に対してopenであり、既存コードの修正に対してclosedである。既存の`cleanContent`消費者は何も変更せずに動作し続ける。

```typescript
// 既存コード（変更不要）
if (promptDetection.isPrompt) {
  // cleanContentを使用するコードはそのまま動作
}

// 新規コード（拡張）
content: promptDetection.rawContent || promptDetection.cleanContent
```

#### L - Liskov Substitution Principle: PASS

`rawContent`はoptionalフィールドであるため、rawContentが存在する`PromptDetectionResult`と存在しない`PromptDetectionResult`は、どちらも同じインターフェースを満たす。既存のconsumerコードにおいて、rawContentの有無にかかわらず正しく動作する。

#### I - Interface Segregation Principle: PASS

`PromptDetectionResult`のconsumerを実コードで確認した結果:

| Consumer | 使用フィールド | rawContent依存 |
|----------|-------------|---------------|
| `auto-yes-manager.ts` (L319-328) | `isPrompt`, `promptData` | なし |
| `auto-yes-resolver.ts` | `PromptData`型のみ | なし |
| `status-detector.ts` | `isPrompt`フラグのみ | なし |
| `response-poller.ts` (L618) | `cleanContent`, `promptData` | 新規追加 |

不要なフィールドへの強制的な依存は発生しない。

#### D - Dependency Inversion Principle: PASS

変更は具象実装レベルで完結しており、抽象インターフェースの依存方向に変更なし。`prompt-detector.ts`から`response-poller.ts`への依存は既存のimportパスを使用。

---

### KISS原則チェック: CONDITIONAL PASS

設計全体のアプローチ（optionalフィールド追加 + フォールバック）は十分にシンプル。ただし以下の懸念あり:

**[MF-001] rawContentサイズ制限の欠如**

設計書Section 7.1で認識されているとおり、`multiple_choice`パターンでは`output.trim()`をそのまま`rawContent`に格納する。`captureSessionOutput()`は最大10000行をキャプチャするため、理論上10000行のテキストがDBに保存される。

```
captureSessionOutput() → 最大10000行
  → detectMultipleChoicePrompt(output) → rawContent = output.trim()
    → response-poller.ts → content = rawContent → DB保存
```

設計書ではパフォーマンス影響度をLowと評価しているが、これはプロンプトの発生頻度が低いという前提に基づく。KISS原則の観点から、rawContentのサイズ上限を設計レベルで明確にすべき。

---

### YAGNI原則チェック: PASS

設計書が明示的にYAGNI原則に従っている点を確認:

- DBスキーマ変更なし
- 新しいコンポーネント作成なし
- 新しい抽象化層の導入なし
- rawContentはoptionalで必要な箇所のみに追加

特に、Section 9.2で不採用案（方針A: cleanContent全文化、方針C: promptData埋め込み）との比較がなされており、設計判断が妥当。

---

### DRY原則チェック: PASS

rawContent返却ロジックは以下の3箇所に存在するが、各箇所のソースが異なるため重複ではない:

| パターン | rawContentソース | 理由 |
|---------|-----------------|------|
| multiple_choice | `output.trim()` | 完全なプロンプト出力が必要 |
| Yes/No | `lastLines.trim()` | 末尾10行のスキャン範囲に対応 |
| Approve | `lastLines.trim()` | 同上 |

`response-poller.ts`でのフォールバック判定 (`rawContent || cleanContent`) は単一箇所で実装され、重複なし。

---

### 設計パターンの適切性

**フォールバックパターン**: `rawContent || cleanContent` は標準的なnullish coalescyパターンを使用しており、直感的で理解しやすい。

**getDisplayContent()関数**: プレゼンテーション層での表示判定ロジックを純粋関数として分離する設計は適切。テスタビリティが高い。

```typescript
function getDisplayContent(content: string | undefined | null, question: string): string | null {
  if (!content?.trim()) return null;
  if (content.trim() === question.trim()) return null;
  return content;
}
```

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | rawContentサイズによるDB肥大化 | Low | Low | P2 |
| 技術的リスク | claude-poller.tsとの不整合 | Low | Low | P3 |
| セキュリティ | XSS（rawContentのHTML注入） | Low | Low | -- (React標準エスケープで対応済み) |
| 運用リスク | 既存データとの表示不整合 | Low | Medium | P3 |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix): 1件

#### MF-001: multiple_choiceパターンのrawContentサイズ制限

**問題**: `multiple_choice`パターンで`output.trim()`（最大10000行）をそのまま`rawContent`に格納する設計により、大量のテキストがDBに保存される可能性がある。

**推奨対応**: rawContentの最大行数（例: 200行）または最大文字数（例: 5000文字）の上限を設計書に追記し、実装時にtruncateロジックを含める。

**対象ファイル**: `src/lib/prompt-detector.ts` (設計書 Section 4.1.1)

---

### 推奨改善項目 (Should Fix): 3件

#### SF-001: claude-poller.tsへの対応方針の明確化

**問題**: `src/lib/claude-poller.ts` L245で`promptDetection.cleanContent`をDB保存しており、到達不能コードとの記載があるが、設計書での根拠が薄い。

**推奨対応**: 設計書Section 11のclaude-poller.ts行に、L234のTODOコメント（「このコードパスは到達不能」）への参照を追記する。

#### SF-002: getDisplayContentのテスト網羅性向上

**問題**: `getDisplayContent()`の4つの分岐パスのうち、「contentにquestionが含まれるケース」のテストが未記載。

**推奨対応**: テスト戦略(Section 6.2)に以下のテストケースを追加:
- content="指示テキスト\n質問文"、question="質問文" --> content全体が表示される

#### SF-003: Yes/No・ApproveパターンのrawContentソース範囲

**問題**: `multiple_choice`では出力全体、`Yes/No`と`Approve`では末尾10行と、rawContentのソース範囲に不一致がある。

**推奨対応**: 技術的理由（Yes/Noパターンの検出対象がlastLinesに限定されている）を設計書に明記するか、rawContent取得範囲を拡大してUI体験を統一する。

---

### 検討事項 (Consider): 3件

#### C-001: rawContentの命名精度

rawContentは`stripAnsi()`適用済みであり、真の意味での「raw」ではない。`fullContent`や`completeContent`の方が実態を正確に反映する。ただし、既存の`cleanContent`との対比として`rawContent`は直感的に理解可能であるため、JSDocコメントでの補足で対応可能。

#### C-002: 将来的なcleanContentの廃止検討

rawContentとcleanContentの2フィールド共存は、設計書Section 9.1でトレードオフとして認識済み。長期的にはrawContentに統一し、cleanContentをdeprecatedとする方向性を将来Issueとして検討。

#### C-003: noPromptResult()のrawContent非設定

設計書Section 4.1.4でisPrompt=falseの場合にrawContentを設定しない設計は適切。テスト項目でも検証対象として記載されている。特に変更不要。

---

## Approval Status

**Status: Conditionally Approved**

MF-001（rawContentサイズ制限の設計レベルでの定義）への対応を条件として承認する。他の指摘事項(SF-001~SF-003)は実装フェーズでの対応で問題ない。

設計全体として、SOLID原則への準拠度が高く、KISS/YAGNI/DRY原則にも忠実な設計方針である。影響範囲の分析も正確であり、後方互換性を維持した最小限の変更で課題を解決するアプローチは高く評価できる。

---

*Generated by architecture-review-agent*
*Date: 2026-02-11*
