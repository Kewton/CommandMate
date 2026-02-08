# Issue #187 影響分析レビュー (Stage 3)

**Issue**: #187 - セッション初回メッセージ送信信頼性改善
**レビュー種別**: 影響範囲分析 (Stage 3)
**日付**: 2026-02-08
**ステータス**: conditionally_approved
**スコア**: 4/5

---

## 1. レビュー概要

設計方針書の Section 9（影響範囲）の網羅性と正確性を検証した。対象は以下の3観点:

1. **sendMessageToClaude の呼び出し元は全て特定されているか**
2. **waitForPrompt の呼び出し元は全て特定されているか**
3. **stripAnsi を使用するファイルは全て列挙されているか**
4. **エラー伝播パスは正しく文書化されているか**

---

## 2. 検証結果

### 2.1 sendMessageToClaude の呼び出し元

**設計書の記載**: `src/lib/cli-tools/claude.ts`、`src/app/api/worktrees/[id]/send/route.ts`

**実際のコードベース検索結果**:
- `src/lib/claude-session.ts` L360 - 関数定義
- `src/lib/cli-tools/claude.ts` L66 - ClaudeTool.sendMessage() から呼び出し
- `tests/unit/lib/claude-session.test.ts` - ユニットテスト
- `tests/integration/api-send-cli-tool.test.ts` L17 - モック

**判定**: 直接的な呼び出し元2件は正確に特定されている。ただし `send/route.ts` は `ClaudeTool.sendMessage()` 経由の間接呼び出し（`cliTool.sendMessage()` L141）であり、直接 `sendMessageToClaude` をインポートしているわけではない点を明確にすべき。

### 2.2 waitForPrompt の呼び出し元

**設計書の記載**: `sendMessageToClaude()` 内部（暗黙的）

**実際のコードベース検索結果**:
- `src/lib/claude-session.ts` L239 - 関数定義
- `src/lib/claude-session.ts` L382 - sendMessageToClaude() から呼び出し（唯一の使用箇所）
- `startClaudeSession()` は独自のポーリングループで同等処理を実施（waitForPrompt 自体は呼び出していない）

**判定**: 使用箇所は正確。ただし設計書で明示的に列挙されていないため、レビュアーが独自に確認する必要がある。

### 2.3 stripAnsi を使用するファイル

**設計書の記載（P2間接影響）**: `status-detector.ts`, `auto-yes-manager.ts`, `response-poller.ts`, `assistant-response-saver.ts`, `prompt-response/route.ts`, `current-output/route.ts`（計6件）

**実際のコードベース検索結果（ソースファイルのみ）**:
| ファイル | 使用箇所数 | 設計書記載 |
|---------|-----------|----------|
| `src/lib/cli-patterns.ts` | 1（定義） | 直接修正として記載 |
| `src/lib/claude-session.ts` | 3 | 直接修正として記載 |
| `src/lib/response-poller.ts` | 9 | 記載あり |
| `src/lib/auto-yes-manager.ts` | 1 | 記載あり |
| `src/lib/status-detector.ts` | 1 | 記載あり |
| `src/lib/assistant-response-saver.ts` | 1 | 記載あり |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 2 | 記載あり |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | 1 | 記載あり |
| `src/app/api/worktrees/route.ts` | 0（detectSessionStatus経由で間接使用） | **欠落** |
| `src/app/api/worktrees/[id]/route.ts` | 0（detectSessionStatus経由で間接使用） | **欠落** |
| `tests/unit/lib/cli-patterns.test.ts` | 3 | **欠落** |

**判定**: 直接使用する6ファイルは全て記載されている。ただし `detectSessionStatus()` 経由で間接的に影響を受ける worktree ルート2件と、stripAnsi のテストファイル1件が欠落している。

### 2.4 エラー伝播パス

**設計書の記載**: S2-F-12で「タイムアウトエラーが sendMessageToClaude() から伝播」「claude.ts の sendMessage() および send/route.ts でエラーが適切にキャッチされ HTTP 500 として返却されることを確認」と推奨。

**実際のエラー伝播チェーン**:
```
waitForPrompt() throws Error('Prompt detection timeout (10000ms)')
  -> sendMessageToClaude() [P1-2でtry-catch削除、エラーそのまま伝播]
    -> ClaudeTool.sendMessage() [try-catchなし、エラーそのまま伝播]
      -> send/route.ts L140-148 [try-catchでキャッチ、HTTP 500返却]
```

**判定**: エラー伝播パスは実質的に正しい。ただし `ClaudeTool.sendMessage()` に try-catch がなくエラーを透過している点が設計書に明示されていない。

---

## 3. 指摘事項

### S3-F-1 [must_fix] インテグレーションテストの影響欠落

**カテゴリ**: missing_impact

`tests/integration/api-send-cli-tool.test.ts` が Section 9 の間接影響ファイルリストに欠落している。このテストファイルは `sendMessageToClaude` をモック（L17）しており、P1-2 のエラースロー変更後にエラーケースをカバーするテストの追加が必要。`send/route.ts` の L140-148 の try-catch が HTTP 500 を返す動作を検証するインテグレーションテストがないと、エラー伝播の正当性を確認できない。

**推奨**: Section 9 に `tests/integration/api-send-cli-tool.test.ts` を追加し、S2-F-12 の確認事項としてインテグレーションテスト追加を明記する。

### S3-F-2 [should_fix] P2間接影響ファイルの不足

**カテゴリ**: missing_impact

P2-2 の `ANSI_PATTERN` 拡張時に影響を受けるファイルとして、以下が欠落:
- `src/app/api/worktrees/route.ts` - `detectSessionStatus()` 経由
- `src/app/api/worktrees/[id]/route.ts` - `detectSessionStatus()` 経由
- `tests/unit/lib/cli-patterns.test.ts` - `stripAnsi` テストケース（L165-174）

### S3-F-3 [should_fix] エラー伝播チェーンの可視化

**カテゴリ**: missing_impact

`ClaudeTool.sendMessage()`（`src/lib/cli-tools/claude.ts` L65-67）に try-catch がなく、`sendMessageToClaude()` からのエラーをそのまま上位に伝播する。この設計判断（意図的な透過）が Section 9 に記載されていない。

### S3-F-4 [should_fix] response-poller.ts のstripAnsi高密度使用

**カテゴリ**: incorrect_impact

`response-poller.ts` は `stripAnsi` を9箇所で使用しており、P2-2 の影響が最も集中するファイルである。Section 3.6 で「基本的に正の効果」と評価しているが、この高密度使用に対するリグレッションテスト方針が記載されていない。

### S3-F-5 [nice_to_have] waitForPrompt使用箇所の明示

**カテゴリ**: missing_impact

`waitForPrompt()` は `sendMessageToClaude()` L382 でのみ使用されている。`startClaudeSession()` は独自のポーリングループで同等処理を実施する。この確認結果を Section 9 に明示することでレビュー効率が向上する。

### S3-F-6 [nice_to_have] claude-poller.ts の影響なし判定

**カテゴリ**: missing_impact

`claude-poller.ts` は `claude-session.ts` から `captureClaudeOutput` と `isClaudeRunning` をインポートしているが、Issue #187 の変更対象関数（`sendMessageToClaude`, `waitForPrompt`, `startClaudeSession`）は使用していない。この「影響なし」判断を明示することで、レビュアーの確認工数を削減できる。

### S3-F-7 [nice_to_have] P1-1後のテストファイルインポート扱い

**カテゴリ**: test_coverage

`tests/unit/lib/claude-session.test.ts` L46 で `CLAUDE_SEPARATOR_PATTERN` をインポートし、L89-92 で独立テストが存在する。P1-1 で `claude-session.ts` からのインポート削除後も、テストファイル自体は `cli-patterns.ts` から直接インポートするため残存可能。しかし、テストの意味が変わる（「claude-session.ts での使用を検証」から「パターン自体の正当性検証」へ）点を明確にすべき。

### S3-F-8 [should_fix] P0安定化待機のauto-yes-manager.ts非影響の明示

**カテゴリ**: missing_impact

`auto-yes-manager.ts` の `pollAutoYes()` は `sendKeys` を直接呼び出し（L312）、`sendMessageToClaude()` を経由しない。P0 の 500ms 安定化待機はこのパスに影響しない。Section 3.5 で P2-1 の Ctrl+U について「auto-yes-manager には不要」と言及しているが、P0 についても同様の「影響なし」判断を明示すべき。

---

## 4. リスク評価

| リスク種別 | レベル | 根拠 |
|-----------|-------|------|
| 技術的リスク | low | 変更対象が限定的（主に claude-session.ts）、既存のエラーハンドリング機構で P1-2 のエラー伝播をカバー |
| セキュリティリスク | low | P2-1 の Ctrl+U 送信は sendSpecialKey 経由で型安全、P2-2 は stripAnsi の除去範囲拡大のみ |
| 運用リスク | low | 500ms の追加遅延は Claude CLI の応答時間と比較して無視できるレベル |

---

## 5. 総合評価

設計書の影響範囲分析は実用的なレベルで正確であり、主要な直接修正ファイル4件と間接影響ファイルの記載は適切である。must_fix 1件（インテグレーションテストの影響欠落）を修正し、should_fix 4件（P2間接影響ファイル不足、エラー伝播チェーン可視化、response-poller高密度使用への方針、P0非影響の明示）を反映することで、実装時の見落としリスクをさらに低減できる。

---

*Generated by architecture-review-agent for Issue #187 Stage 3 (2026-02-08)*
