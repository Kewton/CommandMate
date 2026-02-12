# Issue #235 レビューレポート - Stage 7

**レビュー日**: 2026-02-11
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: 2
**ステージ**: 7/8（4段階レビューの最終レビューステージ）

---

## 前回指摘事項の対応確認

### Stage 3（影響範囲レビュー1回目）: 9件 -- 全件対応済み

| ID | カテゴリ | 対応状況 |
|----|---------|---------|
| MF-1 | テスト範囲（prompt-detector rawContent テスト） | 対応済み: 5項目の具体的テストケースを実装タスクに明記 |
| MF-2 | テスト範囲（response-poller DB保存テスト） | 対応済み: 2項目 + モック/統合テスト考慮を記載 |
| SF-1 | ANSI エスケープコード対処方針 | 対応済み: stripAnsi()適用タイミングとUnicode注意事項を明記 |
| SF-2 | 既存DBデータ後方互換性 | 対応済み: 受入条件に3項目追加 |
| SF-3 | auto-yes-manager.ts 型互換性分析 | 対応済み: 影響なしテーブルに型互換性分析を追記 |
| SF-4 | PromptMessage.tsx UIテスト | 対応済み: 3項目のテストケースを実装タスクに追加 |
| NTH-1 | CLAUDE.md ドキュメント更新タスク | 対応済み: 実装タスクに更新タスクセクション新設 |
| NTH-2 | rawContent サイズ パフォーマンス考慮 | 対応済み: パフォーマンス考慮サブセクション新設 |
| NTH-3 | prompt-response/route.ts 影響範囲テーブル | 対応済み: 影響なし確認済みテーブルに追加 |

### Stage 5（通常レビュー2回目）: 5件 -- 全件対応済み

| ID | カテゴリ | 対応状況 |
|----|---------|---------|
| SF-1 | 問題箇所の関数名誤記 | 対応済み: detectMultipleChoicePrompt()内インラインロジックに修正 |
| SF-2 | rawContent パフォーマンス記述の不正確さ | 対応済み: 10000行全体を含む可能性を明記 |
| NTH-1 | current-output/route.ts 影響なし理由の具体化 | 対応済み: 構造的型付けによるrawContent無視を明記 |
| NTH-2 | フォールバック比較ロジック未定義 | 対応済み: 4パターンの判定条件を明記 |
| NTH-3 | レビュー履歴へのStage 5結果追加 | 対応済み: Stage 5サマリーをレビュー履歴に記載 |

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |

---

## Should Fix（推奨対応）

### SF-1: extractResponse() 内の早期プロンプト検出パスのテスト対象明確化

**カテゴリ**: テスト範囲
**場所**: 実装タスク > テスト（response-poller.test.ts）

**問題**:
`response-poller.ts` にはプロンプトをDB保存する経路が実質2つ存在する。

1. `checkForResponse()` 内 L615-623（Issueで明記済み）
2. `extractResponse()` 内 L298-311 の早期プロンプト検出パス（`cliToolId === 'claude'` の場合）

後者のパスでは `extractResponse()` が `fullOutput` に対して `detectPromptWithOptions()` を呼び、プロンプト検出時に `response: stripAnsi(fullOutput)` を返す。その後 `checkForResponse()` 内で再度 `detectPromptWithOptions()` が呼ばれ、最終的に L615-623 を通過する。

このフローは「`extractResponse()` が返す `response` に対して `detectPromptWithOptions()` が2回呼ばれる」構造だが、`stripAnsi()` は冪等であるため問題はない。ただし、テスト戦略においてこのパスが明示的にカバーされていない。

**証拠**:
- `src/lib/response-poller.ts` L298-311: `cliToolId === 'claude'` の早期検出パス
- `src/lib/response-poller.ts` L609: `checkForResponse()` での再検出
- Issue のテスト戦略は「L618 の変更」のみを対象として記載

**推奨対応**:
以下のいずれかを行う:
1. テスト戦略に「`extractResponse()` の早期プロンプト検出パス（L298-311）は `rawContent` の変更を直接含まず、`checkForResponse()` L615-623 を経由するため、L618 のテストで間接的にカバーされる」旨を注記する
2. または、`extractResponse()` 経由のE2Eフローを統合テストケースに明記する

---

## Nice to Have（あれば良い）

### NTH-1: auto-yes-manager.ts の rawContent 無視に関するリグレッションテスト

**カテゴリ**: テスト範囲
**場所**: 影響範囲 > 影響なしの確認済みコンポーネント > auto-yes-manager.ts

**問題**:
`auto-yes-manager.ts` は L319 で `detectPrompt()` を呼び出し、戻り値に `rawContent` が含まれるようになるが、L321 で `isPrompt` と `promptData` のみ使用する。影響なしの分析は正確であるが、将来のリグレッション防止のため、auto-yes のポーリングテストで間接的にこの動作を検証するテストがあると安心。

**推奨対応**:
実装時の判断に委ねて良い。静的型分析で十分な安全性が確保されている。

---

### NTH-2: レビュー履歴への Stage 7 結果追加

**カテゴリ**: ドキュメント更新
**場所**: レビュー履歴セクション

**問題**:
レビュー履歴セクションに Stage 7（本レビュー）の結果サマリーを追加することで、4段階レビュー（Stage 1, 3, 5, 7）の完了を記録できる。

**推奨対応**:
Stage 7 の反映時にレビュー履歴セクションに以下のサマリーを追加:

```
### Stage 7 - 影響範囲レビュー 2回目 (2026-02-11)
- 前回指摘事項（Stage 3: 9件、Stage 5: 5件）の全14件が対応済みであることを確認
- [SF-1] response-poller.ts の extractResponse() 内早期プロンプト検出パス（L298-311）のテスト対象明確化を推奨
- [NTH-1] auto-yes-manager.ts の rawContent 無視リグレッションテストの検討提案
- [NTH-2] レビュー履歴に Stage 7 結果サマリーを追加
```

---

## 影響範囲分析の評価

### 変更対象ファイル

| ファイル | リスク | 評価 |
|---------|--------|------|
| `src/lib/prompt-detector.ts` | Low | optional フィールド追加のみ。型互換性破壊なし |
| `src/lib/response-poller.ts` | Medium | DB保存値変更。パフォーマンス考慮が正確に記載済み |
| `src/components/worktree/PromptMessage.tsx` | Medium | UI変更。フォールバックロジック4パターンが定義済み |

### 影響なし確認済みコンポーネント（10件）

全10件について、Issue内の影響なし理由がソースコードと一致することを確認した。

| コンポーネント | 確認結果 |
|-------------|---------|
| `auto-yes-manager.ts` | isPrompt/promptDataのみ使用（L321）。確認済み |
| `auto-yes-resolver.ts` | PromptData型のみ使用。確認済み |
| `status-detector.ts` | isPromptフラグのみ。確認済み |
| `claude-session.ts` | プロンプト検出に非関与。確認済み |
| `claude-poller.ts` | 到達不能コード（L234 TODO）。確認済み |
| `current-output/route.ts` | ローカル型注釈でrawContent無視。確認済み |
| `prompt-response/route.ts` | isPromptのみ参照（L79）。確認済み |
| `useAutoYes.ts` | PromptDataのみ使用。確認済み |
| `cli-tools/codex.ts` | 直接参照なし。確認済み |
| `MessageList.tsx` | message をそのまま渡すのみ。確認済み |

### テスト戦略の網羅性

| テスト対象 | 項目数 | 評価 |
|-----------|--------|------|
| prompt-detector.test.ts rawContent テスト | 5 | 全パターンカバー |
| response-poller.test.ts DB保存テスト | 2+注記 | 主要パスカバー（SF-1参照） |
| PromptMessage UIテスト | 3 | UI表示・フォールバック・長文カバー |

### パフォーマンス

rawContent サイズに関するリスク分析が正確に記載されている。captureSessionOutput の10000行上限、プロンプトメッセージの低頻度、SQLite TEXT型の制限なし、WebSocket broadcastへの影響が全て考慮されている。

### セキュリティ

dangerouslySetInnerHTML不使用、React デフォルトエスケープ依存の方針が明記されている。rawContent は stripAnsi() 済みであるためANSIコードによるXSSリスクはない。

---

## 総合評価

**品質**: 高い
**完全性**: 高い
**実装準備**: 完了

前回の Stage 3（影響範囲レビュー1回目）で指摘した Must Fix 2件、Should Fix 4件、Nice to Have 3件の全9件、および Stage 5（通常レビュー2回目）で指摘した Should Fix 2件、Nice to Have 3件の全5件が適切に反映されている。

今回の Stage 7（影響範囲レビュー2回目）では Must Fix は検出されず、Should Fix 1件（テストパスの明確化）と Nice to Have 2件にとどまる。Issue の影響範囲分析は包括的であり、変更対象・影響なし確認・テスト戦略・パフォーマンス・セキュリティ・後方互換性の全観点が網羅されている。

**4段階レビューの結果推移**:

| Stage | Must Fix | Should Fix | Nice to Have |
|-------|----------|-----------|--------------|
| Stage 1（通常1回目） | 1 | 4 | 2 |
| Stage 3（影響範囲1回目） | 2 | 4 | 3 |
| Stage 5（通常2回目） | 0 | 2 | 3 |
| Stage 7（影響範囲2回目） | 0 | 1 | 2 |

Must Fix が Stage 5 以降ゼロとなり、Should Fix も減少傾向にある。Issue は実装着手に十分な品質に達している。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/lib/prompt-detector.ts`: PromptDetectionResult型定義（L40-47）、detectPrompt()、detectMultipleChoicePrompt()、noPromptResult()
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/lib/response-poller.ts`: L618 DB保存ロジック、L298-311 早期プロンプト検出パス、detectPromptWithOptions()
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/components/worktree/PromptMessage.tsx`: L52 prompt.question表示（変更対象）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/lib/auto-yes-manager.ts`: L319-321 detectPrompt()使用箇所
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/lib/claude-poller.ts`: L234 到達不能コードTODO、L245 cleanContentによるDB保存
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/app/api/worktrees/[id]/current-output/route.ts`: L91 ローカル型注釈
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/app/api/worktrees/[id]/prompt-response/route.ts`: L72-79 isPromptのみ参照
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/lib/db.ts`: L64-78 chat_messagesスキーマ

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/tests/unit/prompt-detector.test.ts`: 既存テスト（1529行、cleanContentのみassert）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/tests/unit/lib/response-poller.test.ts`: 既存テスト（33行、cleanClaudeResponseのみ）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/CLAUDE.md`: prompt-detector.ts / response-poller.ts モジュール説明（実装完了時に更新必要）
