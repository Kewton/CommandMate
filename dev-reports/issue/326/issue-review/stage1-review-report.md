# Issue #326 レビューレポート

**レビュー日**: 2026-02-20
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目
**ステージ**: Stage 1

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 3 |

## 総合評価

Issue #326の記載内容は、仮説検証レポートで全3仮説がConfirmedされている通り、コードベースの実態と正確に一致している。原因分析の構造（2箇所の問題箇所 + 通常レスポンスとの比較）は明瞭であり、修正方針の方向性も技術的に妥当である。

ただし、修正方針の具体性に関して3点のShould Fix事項が見つかった。これらは実装段階での手戻りを防ぐための補足情報に関するものである。

| 評価観点 | 判定 | コメント |
|---------|------|---------|
| 整合性 | PASS | コード引用は実コードと一致 |
| 正確性 | PASS | 原因分析は技術的に正しい |
| 明確性 | PASS | 問題構造が明確 |
| 完全性 | PARTIAL | 修正方針の実装考慮点が不足 |
| 技術的妥当性 | PASS | 修正アプローチは適切 |

---

## Should Fix（推奨対応）

### SF-1: 箇所2のstripAnsi未適用について言及がない

**カテゴリ**: 完全性
**場所**: ## 原因 > 箇所2 セクション

**問題**:
箇所1（行336）では `response: stripAnsi(fullOutput)` としてANSIエスケープコードを除去しているのに対し、箇所2（行495）では `response: fullOutput` とそのまま返しており、`stripAnsi`が適用されていない。この差異がIssue本文で言及されていない。

**証拠**:
```typescript
// 箇所1 (行336) - stripAnsi適用あり
return {
  response: stripAnsi(fullOutput),
  isComplete: true,
  lineCount: totalLines,
};

// 箇所2 (行495) - stripAnsi適用なし
return {
  response: fullOutput,
  isComplete: true,
  lineCount: totalLines,
};
```

仮説検証レポートの「Stage 1レビューへの申し送り事項」でも指摘されている。

**推奨対応**:
箇所2でstripAnsiが未適用である点をIssue本文の箇所2のコードブロックのコメントに追記し、修正方針にstripAnsi適用の要否判断を含めるべきである。修正時にstripAnsi未適用のまま残すとANSIエスケープコードがDBに保存される可能性がある。

---

### SF-2: checkForResponse内promptDetection再検出への影響考慮が不足

**カテゴリ**: 完全性
**場所**: ## 修正方針 セクション

**問題**:
`checkForResponse()`の行605で`detectPromptWithOptions(result.response, cliToolId)`が再度呼ばれる。修正後は`result.response`が`lastCapturedLine`以降の部分出力になるため、この部分出力でもプロンプトが正しく検出できるかの確認観点が修正方針に含まれていない。

**証拠**:
```typescript
// checkForResponse() L604-605
// Response is complete! Check if it's a prompt
const promptDetection = detectPromptWithOptions(result.response, cliToolId);
```

`extractResponse()`内のプロンプト検出はバッファ全体で行われるが、`checkForResponse()`内の再検出は`result.response`（修正後は部分出力）で行われる。プロンプトの質問文や選択肢が`lastCapturedLine`以降に含まれている前提は通常は成立するが、エッジケース（例: 質問行がlastCapturedLine直前にある場合）への考慮を明記すべきである。

**推奨対応**:
修正方針に以下を追記:
- `extractResponse()`がプロンプト検出時に返すresponseを`lastCapturedLine`以降に限定した場合でも、`checkForResponse()`行605の`detectPromptWithOptions()`が正しく検出できることを確認すること
- プロンプトの質問行や選択肢行は常に最新の出力（バッファ末尾付近）に存在するため、`lastCapturedLine`以降の切り出しで通常は問題ないが、この前提をコメントとして明記すること

---

### SF-3: startIndex決定ロジックの具体性が不足

**カテゴリ**: 技術的妥当性
**場所**: ## 修正方針 セクション

**問題**:
修正方針には「通常レスポンスと同様にlastCapturedLine以降の行のみをレスポンスとして返す」と記載されているが、通常レスポンス抽出（行360-386）には4つの分岐がある:

1. `bufferWasReset` -- バッファリセット検出時に`findRecentUserPromptIndex`を使用
2. `cliToolId === 'codex'` -- Codex固有処理
3. `lastCapturedLine >= totalLines - 5` -- バッファスクロール検出
4. 通常ケース -- `Math.max(0, lastCapturedLine)`を直接使用

プロンプト検出時にもバッファリセットやスクロールが発生しうるため、これらの分岐を全て適用するのか、プロンプト検出ではバッファ末尾に質問がある前提で簡略化するのかが明確でない。

**推奨対応**:
修正方針を以下のいずれかに具体化:
- (A) 通常レスポンス抽出のstartIndex決定ロジック（行364-386）をヘルパー関数として抽出し、プロンプト検出時にも再利用する
- (B) プロンプト検出時は簡略化し、`Math.max(0, lastCapturedLine)`を直接使用する（プロンプトの質問・選択肢は常にバッファ末尾付近にあるため）

実装の複雑度とバグリスクを考慮すると、(B)の簡略版を第一案とし、バッファリセット時のエッジケースは別途対応する方針が推奨される。

---

## Nice to Have（あれば良い）

### NTH-1: 受け入れ条件が未定義

**カテゴリ**: 完全性
**場所**: Issue本文（セクション未存在）

**推奨対応**:
以下の受け入れ条件を追加:
1. プロンプト検出時のAssistantメッセージに`lastCapturedLine`以前の会話内容が混入しないこと
2. プロンプト検出自体の精度が維持されること（検出はバッファ全体で行われること）
3. 既存テスト（cleanClaudeResponse、rawContent DB save fallback）がパスすること
4. 箇所1・箇所2の両方が修正されていること
5. 箇所2で`stripAnsi`が適用されること（箇所1との一貫性）

---

### NTH-2: テスト計画への言及がない

**カテゴリ**: 完全性
**場所**: Issue本文（セクション未存在）

**推奨対応**:
`extractResponse()`は非exportの内部関数であるため直接テストが困難であるが、テスト戦略として以下を記載推奨:
- startIndex決定ロジックをヘルパー関数に抽出し、ユニットテスト対象とする
- プロンプト検出時のcontent切り出しをシナリオテストで検証する
- 既存テスト（`tests/unit/lib/response-poller.test.ts`）への追加テストケースを定義する

---

### NTH-3: 行番号の参照が将来的にずれる可能性

**カテゴリ**: 明確性
**場所**: ## 原因 セクション全体

**推奨対応**:
行番号は維持しつつ、コメントマーカーによる特定も併記すると修正時の参照が容易になる:
- 箇所1: "Early check for Claude permission prompts" コメント付近
- 箇所2: "Check if this is an interactive prompt" コメント付近
- 通常レスポンス: "isCodexOrGeminiComplete || isClaudeComplete" 分岐内

---

## 参照ファイル

### コード

| ファイル | 行 | 関連性 |
|---------|-----|--------|
| `src/lib/response-poller.ts` | 326-341 | 箇所1: Claude早期プロンプト検出（fullOutputをstripAnsiして返す） |
| `src/lib/response-poller.ts` | 487-499 | 箇所2: フォールバックプロンプト検出（fullOutputをそのまま返す） |
| `src/lib/response-poller.ts` | 360-386 | 通常レスポンス抽出のstartIndex決定ロジック（修正の参考実装） |
| `src/lib/response-poller.ts` | 604-627 | checkForResponse内のpromptDetection再検出（修正後の影響箇所） |
| `src/lib/prompt-detector.ts` | 40-55 | PromptDetectionResult型（rawContentフィールド定義） |
| `src/lib/assistant-response-saver.ts` | 全体 | savePendingAssistantResponseの同様のバッファ処理（参考実装） |
| `tests/unit/lib/response-poller.test.ts` | 全体 | 既存テスト（cleanClaudeResponse、rawContent fallback） |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | response-poller.tsの機能記述との整合性確認 |
| `dev-reports/issue/326/issue-review/hypothesis-verification.md` | 仮説検証結果（全3仮説Confirmed、申し送り事項あり） |
