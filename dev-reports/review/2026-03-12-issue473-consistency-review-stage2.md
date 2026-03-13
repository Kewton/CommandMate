# Issue #473 Stage 2: 整合性レビュー

## レビュー概要

| 項目 | 内容 |
|------|------|
| Issue | #473 OpenCode TUI選択リストのキーボードナビゲーション対応 |
| 対象 | 設計方針書 `dev-reports/design/issue-473-opencode-tui-navigation-design-policy.md` |
| レビュータイプ | 整合性レビュー（設計書 vs コードベース実装） |
| 日付 | 2026-03-12 |
| ステージ | Stage 2 / 4 |

## レビューサマリー

設計方針書は既存コードベースとの整合性が概ね良好である。設計書で参照している関数・型・定数はすべて実在し、提案されている実装パターン（terminal/route.ts踏襲、status-detector.tsのpriority 2.5ブロック拡張）は既存コードの慣例に合致している。

一方で、5件の指摘事項を検出した。特に、current-output APIのステータスフラグ数カウントの不正確さ（DR2-001）は、設計書内の閾値管理の根拠に影響するため修正が必要である。

## 統計

| 重要度 | 件数 |
|--------|------|
| must_fix | 1 |
| should_fix | 3 |
| nice_to_have | 1 |
| **合計** | **5** |

---

## 指摘事項

### DR2-001 [must_fix] current-output APIのステータスフラグ数が設計書の記載と不一致

**カテゴリ:** current-output APIレスポンスフラグ数の整合性

**設計書の記載:** セクション12（DR1-007対応）で、isSelectionListActive追加後のフラグ数を「6個（isRunning, isGenerating, isPromptWaiting, thinking, autoYes, isSelectionListActive）」と記載。

**実際のコード:** `src/app/api/worktrees/[id]/current-output/route.ts` L104-129 のレスポンスには以下のフィールドが含まれる:
- boolean型ステータスフラグ: `isRunning`, `isComplete`, `isGenerating`, `thinking`, `isPromptWaiting` (5個)
- その他: `cliToolId`, `content`, `fullOutput`, `realtimeSnippet`, `lineCount`, `lastCapturedLine`, `thinkingMessage`, `promptData`, `autoYes`(オブジェクト型), `lastServerResponseTimestamp`

**問題:** autoYesはオブジェクト型（`{enabled, expiresAt, stopReason}`）であり、booleanフラグではない。isCompleteが列挙から漏れている。フラグカウントの定義基準が曖昧であり、ISPの閾値判断の根拠として不十分。

**改善提案:** boolean型ステータスフラグのみをカウント対象とする定義を明記する。現状5個 + isSelectionListActive = 6個となることを正確に記載し、autoYesはカウント対象外であることを明示する。

---

### DR2-002 [should_fix] sendSpecialKeys+invalidateCacheパターンの分散箇所カウントが不正確

**カテゴリ:** sendSpecialKeys+invalidateCache分散箇所の整合性

**設計書の記載:** セクション9.2で「sendSpecialKeys()+invalidateCache()の呼び出しパターンが既に以下の3箇所に分散している」として、(1) terminal/route.ts、(2) prompt-answer-sender.ts、(3) special-keys/route.ts を列挙。

**実際のコード:**
- `terminal/route.ts` L79,83: `sendKeys()` + `invalidateCache()` を使用（sendSpecialKeysではない）
- `prompt-answer-sender.ts` L90,97,111: `sendSpecialKeys()` + `invalidateCache()` を使用

**問題:** (1)は `sendKeys()` であって `sendSpecialKeys()` ではない。設計書は異なるAPI（sendKeys vs sendSpecialKeys）を同列に扱ってラッパー関数の必要性を論じている。sendSpecialKeys+invalidateCacheの既存パターンは prompt-answer-sender.ts の1箇所のみであり、special-keys/route.ts 追加で2箇所になる。

**改善提案:** sendKeysとsendSpecialKeysを明確に区別して記載する。sendSpecialKeysAndInvalidate()ラッパーの適用対象は prompt-answer-sender.ts と special-keys/route.ts の2箇所であることを正確に記載する。セクション9.2末尾の「sendKeysAndInvalidate()ラッパー」への言及は別の関数であり、本セクションの主題（sendSpecialKeysAndInvalidate）との混同を避けるべき。

---

### DR2-003 [should_fix] reason文字列のハードコードによるtypoリスク

**カテゴリ:** isSelectionListActive判定ロジックの実装可能性

**設計書の記載:** セクション5.2で `statusResult.status === 'waiting' && statusResult.reason === 'opencode_selection_list'` による判定を提案。

**実際のコード:** `src/lib/status-detector.ts` L53 で `reason` は `string` 型として定義されている。current-output/route.ts L83 では `statusResult.reason === 'thinking_indicator'` のように既にハードコード文字列比較が使用されている。

**問題:** reason文字列の参照箇所がstatus-detector.ts（設定側）とcurrent-output/route.ts（参照側）に分散しており、typoによる検出失敗のリスクがある。本Issueで新たなreason値が追加されることで、このパターンの脆弱性が増す。

**改善提案:** StatusDetectionResult.reason型をstring型からunion literal型（`'prompt_detected' | 'thinking_indicator' | 'opencode_processing_indicator' | ...`）に変更するか、少なくとも `isSelectionListActive` 判定で使用する reason 文字列を定数として定義して両側で参照する。この変更は本Issueスコープ外としてもよいが、設計書に将来の型安全化方針として記載すべき。

---

### DR2-004 [should_fix] ALLOWED_SPECIAL_KEYSエクスポート時のmutability問題

**カテゴリ:** ALLOWED_SPECIAL_KEYSエクスポートの記述精度

**設計書の記載:** セクション2で「ALLOWED_SPECIAL_KEYS exportのみ」、セクション8.2で `export const ALLOWED_SPECIAL_KEYS = new Set([...])` からのimportを提案。

**実際のコード:** `src/lib/tmux.ts` L236 で `const ALLOWED_SPECIAL_KEYS = new Set([...])` が非exportとして定義。同ファイルL438ではALLOWED_SINGLE_SPECIAL_KEYSも `new Set<string>(SPECIAL_KEY_VALUES)` として定義されているが、こちらも非export。

**問題:** `Set` はmutableオブジェクトであり、exportすると外部から `ALLOWED_SPECIAL_KEYS.add('malicious')` や `.clear()` が可能になる。セキュリティ防御定数としてのALLOWED_SPECIAL_KEYSをmutableなSetとしてexportすることは防御層の脆弱化につながる。

**改善提案:** 以下のいずれかの方法でimmutabilityを確保する:
1. `tmux.ts` に `isAllowedSpecialKey(key: string): boolean` 関数を追加し、Setを直接公開しない
2. 配列を `export const ALLOWED_SPECIAL_KEY_VALUES = [...] as const` としてexportし、route.ts側でSetを生成する（SPECIAL_KEY_VALUESと同様のパターン）
3. `Object.freeze()` を適用してexportする

既存の `SPECIAL_KEY_VALUES` / `ALLOWED_SINGLE_SPECIAL_KEYS` パターン（L424,438）に倣い、方法2が最も既存コードとの一貫性が高い。

---

### DR2-005 [nice_to_have] 選択リスト検出で使用する出力ウィンドウの未指定

**カテゴリ:** OpenCode固有ブロック内の選択リスト検出位置の整合性

**設計書の記載:** セクション6.1でpriority 2.5内の(C) selection_listの位置を定義しているが、検出に使用する出力ウィンドウ（変数）が明示されていない。

**実際のコード:** `src/lib/status-detector.ts` L202-264 のOpenCode固有ブロックでは以下の変数を使い分けている:
- `lastLines`: 最後15行（L152, フッター含む）
- `contentThinkingWindow`: footerBoundary上のコンテンツ最後5行（L237-239）
- `contentCheckWindow`: footerBoundary上のコンテンツ最後15行（L251-253）
- `cleanOutput` / `strippedForOpenCode`: 全出力

**問題:** 選択リストのTUI表示はOpenCodeのコンテンツ領域に表示されるため、フッターを除外した `contentCheckWindow` または `contentCandidates` を使用すべきだが、設計書では検出ウィンドウの選択が明示されていない。

**改善提案:** セクション6.1または6.2に、選択リスト検出で使用する出力ウィンドウを明記する。既存の(D) response_completeが `contentCheckWindow` を使用していることから、(C)も同じウィンドウを使用するのが自然であり、その旨を設計書に記載すべき。

---

## 整合性確認チェックリスト

| 確認項目 | 結果 | 備考 |
|---------|------|------|
| sendSpecialKeys() 関数の実在 | OK | `src/lib/tmux.ts` L257 にexport済み |
| ALLOWED_SPECIAL_KEYS 定数の実在 | OK | `src/lib/tmux.ts` L236 に非exportで存在。export追加が必要 |
| hasSession() 関数の実在 | OK | `src/lib/tmux.ts` L68 にexport済み |
| invalidateCache() 関数の実在 | OK | `src/lib/tmux-capture-cache.ts` L185 にexport済み |
| isCliToolType() 関数の実在 | OK | `src/lib/cli-tools/types.ts` L100 にexport済み |
| getWorktreeById() 関数の実在 | OK | `src/lib/db.ts` からimport（terminal/route.ts L17で確認） |
| detectSessionStatus() 関数の実在 | OK | `src/lib/status-detector.ts` L136 にexport済み |
| StatusDetectionResult 型の実在 | OK | `src/lib/status-detector.ts` L47 にexport済み |
| SessionStatus 型に 'waiting' 含む | OK | `src/lib/status-detector.ts` L35 `'idle' \| 'ready' \| 'running' \| 'waiting'` |
| CLIToolManager の実在 | OK | terminal/route.ts L16で使用確認 |
| terminal/route.ts の4層防御パターン | OK | L33-76で確認。設計書の記述と一致 |
| current-output/route.ts のstatusResult使用パターン | OK | L82-93で確認。reason比較パターン使用済み |
| status-detector.ts のpriority 2.5ブロック | OK | L202-264で確認。(A)(B)(D)の順序が設計書と一致 |
| cli-patterns.ts のOPENCODE系パターン | OK | OPENCODE_PROMPT_PATTERN, OPENCODE_THINKING_PATTERN等が実在 |
| prompt-answer-sender.ts のsendSpecialKeys使用 | OK | L90,97で確認。invalidateCache L111で確認 |
| WorktreeDetailRefactored.tsx の構造 | OK | 'use client'、hooks使用、コンポーネント分割パターン確認 |
| ファイル配置（components/worktree/配下） | OK | 既存パターンと一致 |
| API配置（api/worktrees/[id]/配下） | OK | 既存パターンと一致 |
| Issue #473 の要件との整合性 | OK | 設計書はIssueの全受け入れ基準をカバーしている |

---

## 結論

設計方針書は既存コードベースとの整合性が高く、参照している関数・型・定数はすべて実在する。提案されている実装パターン（terminal/route.tsの4層防御踏襲、status-detector.tsのpriority 2.5ブロック拡張、current-output APIレスポンス拡張）は、いずれも既存コードの慣例に合致しており、実装可能性は高い。

must_fix 1件（フラグ数カウント不正確）と should_fix 3件（パターン分散カウント不正確、reason型安全性、Set mutability）は、設計書の記述精度に関する指摘であり、実装の方向性自体には影響しない。ただし、設計書が将来の閾値判断や設計根拠として参照されることを考慮すると、正確な記載への修正が望ましい。

---

*Generated by architecture-review-agent for Issue #473 Stage 2*
