# Issue #326 Stage 3 影響範囲レビューレポート

**レビュー日**: 2026-02-20
**フォーカス**: 影響範囲レビュー
**ステージ**: 3（影響範囲レビュー 1回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |

---

## Must Fix（必須対応）

### MF-1: auto-yes-manager.tsへの間接影響が影響範囲に未記載

**カテゴリ**: 影響ファイル
**場所**: ## 影響範囲 セクション

**問題**:
`auto-yes-manager.ts`の`pollAutoYes()`関数（行529付近）は、`response-poller.ts`の`extractResponse()`を経由せず、独自にtmuxバッファをキャプチャして`detectPrompt()`を直接呼び出している。そのためコード変更の直接影響は受けないが、`response-poller.ts`のDB保存contentが変わること（バッファ全体 -> lastCapturedLine以降）により、Auto-Yesの重複判定ロジック（`lastAnsweredPromptKey`、Issue #306）に間接的な影響が生じる可能性がある。

**証拠**:

`/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/auto-yes-manager.ts` L529:
```typescript
const promptDetection = detectPrompt(cleanOutput, promptOptions);
```

Auto-Yesは`extractResponse()`を使わず独自にプロンプトを検出するが、`response-poller.ts`がDB保存するpromptメッセージのcontent長が変わるため、`lastAnsweredPromptKey`（`prompt-key.ts`の`generatePromptKey()`）で生成されるキーが変わる可能性がある。

**推奨対応**:
影響範囲セクションに`auto-yes-manager.ts`を追加し、以下を記載:
- コード変更の直接影響はなし（`extractResponse()`を経由しないため）
- DB保存contentの変化による`lastAnsweredPromptKey`への間接影響を確認要

---

## Should Fix（推奨対応）

### SF-1: extractResponse()のプロンプト検出パスに対するテストが存在しない

**カテゴリ**: テスト範囲
**場所**: ## 影響範囲 セクション（テスト範囲の不在）

**問題**:
現在のテスト（`/Users/maenokota/share/work/github_kewton/commandmate-issue-326/tests/unit/lib/response-poller.test.ts`）は`cleanClaudeResponse()`テスト3件と`rawContent` fallbackテスト2件のみをカバーしている。修正対象である`extractResponse()`のプロンプト検出パス（箇所1: Claude早期プロンプト検出、箇所2: フォールバックプロンプト検出）に対するテストが一切存在しない。

`extractResponse()`は`function`宣言で`export`されていない内部関数のため、直接テストが不可能。

**推奨対応**:
以下のいずれかのテスト戦略をIssueに記載:
- **(A)** startIndex決定ロジックをヘルパー関数として抽出・exportしてユニットテスト
- **(B)** `checkForResponse()`レベルの結合テスト（DB/tmux/cli-sessionモック付き）
- **(C)** `extractResponse`をテスト用にexport（`@internal`アノテーション付き）

---

### SF-2: checkForResponse()のpromptDetection再検出でのrawContent影響が未分析

**カテゴリ**: 依存関係
**場所**: ## 影響範囲 セクション

**問題**:
`checkForResponse()`のL605で`detectPromptWithOptions(result.response, cliToolId)`を呼び出し、その結果の`rawContent`をDB保存（L615: `promptDetection.rawContent || promptDetection.cleanContent`）している。

修正後は`result.response`がlastCapturedLine以降の部分出力になるため、`detectPrompt()`が返す`rawContent`（`prompt-detector.ts` L583: `truncateRawContent(output.trim())`）もlastCapturedLine以降の内容のみとなる。

これはIssue #235で意図した「完全なプロンプト出力をDB保存」の設計との整合性を確認する必要がある。

**証拠**:

`/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/prompt-detector.ts` L583:
```typescript
rawContent: truncateRawContent(output.trim()),  // Issue #235: complete prompt output (truncated) [MF-001]
```

`/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/response-poller.ts` L614-615:
```typescript
// Issue #235: rawContent優先でDB保存 (rawContent contains complete prompt output)
content: promptDetection.rawContent || promptDetection.cleanContent,
```

**推奨対応**:
影響範囲に「rawContentの内容がバッファ全体からlastCapturedLine以降に縮小する」点を明記し、Issue #235の設計意図との整合性を検討する。実際のプロンプト表示（質問文+選択肢）は応答末尾に位置するため問題ない可能性が高いが、明示的な確認が必要。

---

### SF-3: assistant-response-saver.tsの影響除外が未記載

**カテゴリ**: 影響ファイル
**場所**: ## 影響範囲 セクション

**問題**:
`assistant-response-saver.ts`は`response-poller.ts`から`cleanClaudeResponse`と`cleanGeminiResponse`をimportしている（L24）。今回の修正は`extractResponse()`内部の変更であり、export関数のシグネチャ・動作は変更されないため破壊的変更はない。しかし影響範囲セクションにこの依存関係と「影響なし」の判定が記載されていない。

**証拠**:

`/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/assistant-response-saver.ts` L24:
```typescript
import { cleanClaudeResponse, cleanGeminiResponse } from './response-poller';
```

**推奨対応**:
影響範囲セクションに以下を追加:
- `assistant-response-saver.ts` - 影響なし（`cleanClaudeResponse`/`cleanGeminiResponse`は変更対象外のexport関数）
- `session-cleanup.ts`, `cli-tools/manager.ts` - 影響なし（`stopPolling`のみimport、API変更なし）
- APIルート（`respond/route.ts`, `send/route.ts`, `start-polling/route.ts`）- 影響なし（`startPolling`のみimport、API変更なし）

---

## Nice to Have（あれば良い）

### NTH-1: テスト変更が必要なファイル一覧がIssueに未記載

**カテゴリ**: テスト範囲
**場所**: ## 影響範囲 セクション（テスト関連の不在）

**推奨対応**:
以下のテストファイルへの影響を整理して記載:

| テストファイル | 状態 | 理由 |
|-------------|------|------|
| `tests/unit/lib/response-poller.test.ts` | 新規テスト追加推奨 | extractResponseのプロンプト検出パスのテスト |
| `tests/unit/prompt-detector.test.ts` | 変更不要 | prompt-detector自体に変更なし |
| `src/lib/__tests__/assistant-response-saver.test.ts` | 変更不要 | import先のexport関数に変更なし |

---

### NTH-2: DB保存済みメッセージへの影響が未記載

**カテゴリ**: 移行考慮
**場所**: ## 影響範囲 セクション

**推奨対応**:
修正後、新しく保存されるpromptメッセージのcontent長が短くなる（バッファ全体 -> lastCapturedLine以降）。既にDBに保存されている既存のpromptメッセージ（バッファ全体を含むもの）との表示上の一貫性が変わるが、これは期待された動作改善（不要な会話履歴の混入防止）であり、DBマイグレーション等の移行処理は不要であることを明記すると良い。

---

## 影響範囲分析サマリー

### Codex/Geminiへの影響

| CLIツール | 影響度 | 説明 |
|----------|--------|------|
| Codex | Low | 箇所2（フォールバックプロンプト検出）はCLIツール共通で実行されるが、Codexは通常`isCodexOrGeminiComplete`パス（行354）で先に検出されるため箇所2に到達する頻度は低い |
| Gemini | Negligible | one-shot実行モードのためインタラクティブプロンプトの発生可能性が極めて低い。箇所1はcliToolId === 'claude'条件で限定されておりGeminiには影響しない |

### 破壊的変更の有無

**破壊的変更なし**。response-poller.tsのexport関数（`startPolling`, `stopPolling`, `stopAllPolling`, `getActivePollers`, `cleanClaudeResponse`, `cleanGeminiResponse`）のシグネチャ・動作に変更はない。変更は内部関数`extractResponse()`の返却値のみ。

### パフォーマンスリスク

**Negligible**。修正は主にレスポンスの切り出し範囲（startIndex決定）の変更であり、計算コストの変化はO(1)程度。`lines.slice()`のコストは既存の通常レスポンス抽出パスと同等。`detectPromptWithOptions()`がバッファ全体で呼ばれる箇所は維持されるため、`detectPrompt()`の呼び出し回数に変化なし。

### 副作用リスク

| リスク | 発生可能性 | 緩和策 |
|--------|-----------|--------|
| checkForResponse再検出でプロンプト検出失敗 | Low | プロンプトは応答末尾に表示されるためlastCapturedLine以降に含まれる。extractResponseの箇所1・2で既にバッファ全体で検出済み |
| rawContentが不完全になる | Low | truncateRawContent()は最大200行/5000文字。通常のプロンプトは20行以内。lastCapturedLine以降でも十分 |

---

## 参照ファイル

### コード（直接影響）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/response-poller.ts`: extractResponse() 2箇所 + checkForResponse()
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/prompt-detector.ts`: rawContent生成ロジック（truncateRawContent）

### コード（間接影響）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/auto-yes-manager.ts`: pollAutoYes()のdetectPrompt独立パス
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/assistant-response-saver.ts`: cleanClaudeResponse/cleanGeminiResponse import（影響なし）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/session-cleanup.ts`: stopPolling import（影響なし）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/cli-tools/manager.ts`: stopPolling import（影響なし）

### コード（影響なし）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/status-detector.ts`: response-pollerをimportしていない
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/cli-patterns.ts`: API/動作に変更なし
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/app/api/worktrees/[id]/respond/route.ts`: startPolling import（API変更なし）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/app/api/worktrees/[id]/send/route.ts`: startPolling import（API変更なし）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/app/api/worktrees/[id]/start-polling/route.ts`: startPolling import（API変更なし）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/app/api/worktrees/[id]/current-output/route.ts`: response-pollerをimportしていない
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/app/api/worktrees/[id]/prompt-response/route.ts`: response-pollerをimportしていない

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/tests/unit/lib/response-poller.test.ts`: 既存テスト（extractResponseテストなし）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/tests/unit/prompt-detector.test.ts`: 変更不要
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/__tests__/assistant-response-saver.test.ts`: 変更不要

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/CLAUDE.md`: response-poller.ts, auto-yes-manager.tsの記述との整合性確認
