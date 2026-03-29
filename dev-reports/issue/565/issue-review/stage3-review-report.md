# Issue #565 影響範囲レビューレポート

**レビュー日**: 2026-03-28
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目（Stage 3）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 5 |
| Nice to Have | 3 |
| **合計** | **10** |

---

## Must Fix（必須対応）

### F3-001: tui-accumulator.ts の extractTuiContentLines がOpenCode専用で、Copilot用分岐メカニズムが未設計

**カテゴリ**: 波及効果
**場所**: src/lib/tui-accumulator.ts / Issue「必須1. Copilot用TuiAccumulator対応」

**問題**:
`tui-accumulator.ts` の `extractTuiContentLines()` は `normalizeOpenCodeLine()` と `OPENCODE_SKIP_PATTERNS` をハードコードで使用している。`response-poller.ts` L605-608 の `accumulateTuiContent(pollerKey, output)` 呼び出しは cliToolId パラメータを持たないため、CopilotのキャプチャにもOpenCodeのnormalize/skipが適用されてしまう。

Issueでは「`extractCopilotContentLines` 関数を新設」と記載しているが、`accumulateTuiContent()` がどちらの関数を呼ぶかの分岐メカニズムが明記されていない。

**証拠**:
- `tui-accumulator.ts` L154: `const contentLines = extractTuiContentLines(rawOutput);` （OpenCode固定）
- `response-poller.ts` L606-607: `accumulateTuiContent(pollerKey, output);` （cliToolId未渡し）

**推奨対応**:
`accumulateTuiContent()` のシグネチャに `cliToolId` パラメータを追加するか、pollerKey のフォーマット（`worktreeId:cliToolId`）から cliToolId を抽出する方式を明記する。

---

### F3-002: isFullScreenTui の共通フラグによるOpenCode既存動作への副作用リスク

**カテゴリ**: 波及効果
**場所**: src/lib/polling/response-poller.ts L637, L642, L650, L684, L749, L777

**問題**:
`isFullScreenTui = cliToolId === 'opencode' || cliToolId === 'copilot'` が5箇所で使用されている。特に L684 の「プロンプト検出時にポーリング停止しない」ロジックは、コメントに「Full-screen TUI tools (Copilot)」と記載されておりCopilot固有の理由だが、OpenCodeにも適用される。Copilot向けの変更（プロンプト重複防止ロジック追加等）を `isFullScreenTui` 分岐に追加すると、OpenCodeの既存動作に意図しない影響が生じるリスクがある。

**証拠**:
- L684: `if (!isFullScreenTui) { stopPolling(...); }` -- OpenCodeでもプロンプト時にポーリング継続
- L777: `if (isFullScreenTui) { stopPolling(...); }` -- レスポンス保存後にOpenCode/Copilot両方でポーリング停止

**推奨対応**:
Copilot固有のロジック（プロンプト重複防止、ポーリング継続）は `cliToolId === 'copilot'` で個別に分岐する設計を明記する。`isFullScreenTui` は line-count ベースの重複チェックスキップ等の共通ロジックのみに使用する方針を整理する。

---

## Should Fix（推奨対応）

### F3-003: 200ms遅延値のハードコードが3箇所に分散

**カテゴリ**: 互換性
**場所**: send/route.ts L262, terminal/route.ts L88, copilot.ts L278

**問題**:
Copilotのテキスト送信後のEnter遅延（200ms）が3箇所にハードコードされている。Issueの「必須3」で定数化を記載しているが、`copilot.ts` の `sendMessage()` 内の200ms遅延への言及がない。3箇所の値が今後不整合になるリスクがある。

**推奨対応**:
`config/` 配下に `COPILOT_SEND_ENTER_DELAY_MS` 定数を定義し、3箇所全てで参照する設計を明記する。

---

### F3-004: 既存TuiAccumulatorテストがOpenCode専用前提

**カテゴリ**: テスト
**場所**: tests/unit/lib/response-poller-tui-accumulator.test.ts

**問題**:
既存テストは `TEST_KEY = 'test-worktree:opencode'` で固定され、OpenCode TUI装飾のテストケースのみ。受け入れ条件にテスト関連の項目がない。

**推奨対応**:
受け入れ条件に「Copilot用TuiAccumulatorのユニットテストが追加されていること」を追加する。

---

### F3-005: Copilot完了検出が isCodexOrGeminiComplete に同居しており適切か不明

**カテゴリ**: 波及効果
**場所**: response-poller.ts extractResponse() L372

**問題**:
CopilotはL372で `isCodexOrGeminiComplete` の条件（`hasPrompt && !isThinking`）に含まれているが、alternate screenモードではプロンプト復帰時にレスポンス本文がキャプチャに含まれない可能性がある。完了検出時点でTuiAccumulatorの蓄積コンテンツを使用すべきか、OpenCodeのように独自完了検出が必要かの判断基準が不明確。

**推奨対応**:
Issueの「推奨4」を必須に格上げし、完了検出方式の判断基準を明記する。

---

### F3-006: SHA-256ハッシュベース重複防止のパフォーマンス設計が未記載

**カテゴリ**: パフォーマンス
**場所**: Issue「必須2. TUI向けプロンプト重複防止」

**問題**:
ポーリング2秒毎にDBクエリ + SHA-256計算が発生する。複数worktree同時実行時の累積負荷が未評価。

**推奨対応**:
インメモリキャッシュ（`Map<pollerKey, string>`）との比較を第一段階とする2層方式を検討する。chat-db.ts にハッシュカラムを追加するかどうかも明記する。

---

### F3-007: copilot.ts sendMessage() と send/route.ts の二重実装

**カテゴリ**: 互換性
**場所**: src/lib/cli-tools/copilot.ts L241-293, src/app/api/worktrees/[id]/send/route.ts L254-264

**問題**:
`copilot.ts` の `sendMessage()` と `send/route.ts` のCopilot分岐で、メッセージ送信ロジックが異なるフローで二重実装されている。`sendMessage()` は `waitForPrompt` + `detectAndResendIfPastedText` を含むが、`send/route.ts` はこれらを省略している。今回の安定化対策をどちらに適用すべきかの方針が不明確。

**推奨対応**:
(A) `copilot.ts` の `sendMessage()` を修正して `send/route.ts` から呼び出す方式、(B) `send/route.ts` のインライン実装を正とする方式、いずれかの方針を明記する。

---

## Nice to Have（あれば良い）

### F3-008: cleanCopilotResponse のテストが存在しない

**カテゴリ**: テスト
**場所**: src/lib/response-cleaner.ts L159-176

**問題**:
`cleanCopilotResponse()` のユニットテストが存在しない。本対応でCopilot固有のスキップパターンを追加した際のリグレッション防止テストがない。

**推奨対応**:
`cleanCopilotResponse` のユニットテストを新規作成する。

---

### F3-009: extractResponse L518 でCopilotがプロンプト検出スキップ対象外

**カテゴリ**: その他
**場所**: response-poller.ts extractResponse() L518

**問題**:
L518 で `cliToolId !== 'opencode'` のみスキップしているが、Copilotも alternate screen TUI であるため同様にスキップすべき可能性がある。L344の早期検出がfalseの場合にL518のパスに到達し得る。

**推奨対応**:
L518 の条件見直しを検討する。

---

### F3-010: CLAUDE.md のモジュールリファレンス更新

**カテゴリ**: その他
**場所**: CLAUDE.md

**問題**:
tui-accumulator.ts の説明がCopilot対応を反映していない。

**推奨対応**:
本Issue完了後に説明を更新する。

---

## 影響範囲マトリクス

| 変更対象ファイル | OpenCodeへの影響 | 他CLIツールへの影響 | DB変更 | 新規テスト必要 |
|-----------------|-----------------|-------------------|--------|--------------|
| tui-accumulator.ts | 高（関数シグネチャ変更の可能性） | なし | なし | 必要 |
| response-poller.ts | 中（isFullScreenTui共有） | なし | 重複防止でクエリ追加 | 必要 |
| cli-patterns.ts | なし | なし | なし | 必要 |
| response-cleaner.ts | なし | なし | なし | 必要 |
| send/route.ts | なし | なし | なし | 推奨 |
| terminal/route.ts | なし | なし | なし | 推奨 |
| copilot.ts | なし | なし | なし | 既存テスト更新 |
| chat-db.ts | なし | なし | ハッシュカラム追加の可能性 | 追加時に必要 |

## 参照ファイル

### コード
- `src/lib/tui-accumulator.ts`: Copilot用コンテンツ蓄積パターンの追加対象
- `src/lib/polling/response-poller.ts`: isFullScreenTuiフラグ5箇所、チェック/保存ロジック
- `src/lib/detection/cli-patterns.ts`: COPILOT_SKIP_PATTERNS（placeholder）
- `src/lib/response-cleaner.ts`: cleanCopilotResponse（placeholder）
- `src/app/api/worktrees/[id]/send/route.ts`: Copilot用200ms遅延
- `src/app/api/worktrees/[id]/terminal/route.ts`: Copilot用200ms遅延
- `src/lib/cli-tools/copilot.ts`: sendMessage二重実装、200ms遅延
- `src/lib/response-extractor.ts`: isOpenCodeComplete（Copilot用追加候補）
- `tests/unit/lib/response-poller-tui-accumulator.test.ts`: OpenCode専用テスト

### ドキュメント
- `CLAUDE.md`: モジュールリファレンス更新対象
