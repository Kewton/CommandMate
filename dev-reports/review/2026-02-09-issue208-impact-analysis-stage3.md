# Architecture Review: Issue #208 - Stage 3 Impact Analysis

**Issue**: #208 Auto-Yes 番号付きリスト誤検出防止
**Stage**: 3 (影響分析レビュー)
**Date**: 2026-02-09
**Status**: approved
**Score**: 5/5

---

## Executive Summary

Issue #208 の設計方針書に対する Stage 3 影響分析レビューを実施した。変更対象は `src/lib/prompt-detector.ts` の1ファイルのみであり、8箇所の `detectPrompt()` 呼び出し元に対する波及効果を全て検証した。結論として、本修正は全ての呼び出し元に対して正の影響（誤検出防止）を与え、負の影響（回帰）はないことを確認した。Codex/Gemini 等の既存 CLI ツールは `requireDefaultIndicator: true` で動作するため、SEC-001b ガードの影響範囲外である。パフォーマンスへの影響も無視できるレベルである。

---

## 1. 変更の波及効果分析

### 1.1 変更の概要

| 項目 | 内容 |
|------|------|
| 変更ファイル | `src/lib/prompt-detector.ts` のみ |
| 変更内容 | Layer 5 SEC-001b ガード追加、`isQuestionLikeLine()` 関数追加、`QUESTION_KEYWORD_PATTERN` 定数追加 |
| 変更の性質 | 既存 Layer 5 SEC-001 ガードの条件厳格化（`!requireDefault` ブロック内のみ） |
| 公開 API 変更 | なし（`detectPrompt()` のシグネチャ・戻り値型に変更なし） |

### 1.2 変更のスコープ制御

本修正は `if (!requireDefault)` ブロック内にのみ SEC-001b ガードを追加する設計であるため、影響範囲は以下に限定される:

- `requireDefaultIndicator: false` で `detectPrompt()` を呼び出すコードパス **のみ**
- 現状では `buildDetectPromptOptions('claude')` が `{ requireDefaultIndicator: false }` を返す **Claude CLI 専用パス** のみ

`requireDefaultIndicator: true`（デフォルト）または `undefined` で呼び出すコードパスには一切影響しない。

---

## 2. 呼び出し元への影響分析（全8箇所）

### 2.1 影響マトリクス

| # | ファイル | 行 | requireDefaultIndicator | SEC-001b 適用 | 影響 |
|---|---------|-----|------------------------|---------------|------|
| 1 | `src/lib/auto-yes-manager.ts` | L318 | false (Claude) | Yes | Positive |
| 2 | `src/lib/status-detector.ts` | L135 | false (Claude) | Yes | Positive |
| 3 | `src/lib/response-poller.ts` | L99 (via detectPromptWithOptions) | false (Claude) | Yes | Positive |
| 4 | `src/lib/response-poller.ts` | L489 (via detectPromptWithOptions) | false (Claude) | Yes | Positive |
| 5 | `src/lib/response-poller.ts` | L608 (via detectPromptWithOptions) | false (Claude) | Yes | Positive |
| 6 | `src/app/api/.../current-output/route.ts` | L94 | false (Claude) | Yes | Positive |
| 7 | `src/app/api/.../prompt-response/route.ts` | L76 | false (Claude) | Yes | Positive |
| 8 | `src/lib/claude-poller.ts` | L166, L236 | true (default) | No | None |

### 2.2 各呼び出し元の詳細分析

#### 呼び出し元 1: auto-yes-manager.ts (L318) -- 主要誤検出パス

```typescript
// L317-318
const promptOptions = buildDetectPromptOptions(cliToolId);
const promptDetection = detectPrompt(cleanOutput, promptOptions);
```

**修正前の動作**: サブエージェント完了後の番号付きリスト（例: "Recommendations:\n1. Add tests\n2. Update docs"）が `multiple_choice` として検出される。`resolveAutoAnswer()` が "1" を返し、`sendKeys()` で tmux に送信される。

**修正後の動作**: SEC-001b ガードにより `isQuestionLikeLine("Recommendations:")` が false を返し、`isPrompt: false` が返される。`pollAutoYes()` は L320-323 で `scheduleNextPoll()` にフォールスルーし、不要な自動応答は送信されない。

**コード変更の必要性**: なし。呼び出し引数に変更なし。

#### 呼び出し元 2: status-detector.ts (L135)

```typescript
// L134-135
const promptOptions = buildDetectPromptOptions(cliToolId);
const promptDetection = detectPrompt(lastLines, promptOptions);
```

**修正前の動作**: 15行ウィンドウ（`STATUS_CHECK_LINE_COUNT`）内に番号付きリストがある場合、`detectPrompt()` が `isPrompt: true` を返し、`hasActivePrompt: true` + `status: 'waiting'` が返される。サイドバーに偽の waiting 表示が出る。

**修正後の動作**: SEC-001b で番号付きリストの質問行が拒否され、`isPrompt: false` が返される。status-detector は次の優先順位（thinking、input prompt、time-based）で正しいステータスを判定する。

**コード変更の必要性**: なし。

#### 呼び出し元 3-5: response-poller.ts (detectPromptWithOptions経由)

```typescript
// L95-101 (ヘルパー関数)
function detectPromptWithOptions(output: string, cliToolId: CLIToolType): PromptDetectionResult {
  const promptOptions = buildDetectPromptOptions(cliToolId);
  return detectPrompt(stripAnsi(output), promptOptions);
}
```

3箇所の呼び出しポイント:
- **L299** (`extractResponse()` 内、Claude permission prompt の early check): 修正後、番号付きリストが `isPrompt: true` を返さなくなるため、偽の `isComplete: true` が防止される。
- **L489** (`extractResponse()` 終了後の prompt check): 同上。偽の prompt メッセージ保存が防止される。
- **L608** (`checkForResponse()` 内の prompt detection): 同上。

**コード変更の必要性**: なし。`detectPromptWithOptions()` は `stripAnsi()` + `buildDetectPromptOptions()` + `detectPrompt()` の薄いラッパーであり、内部で本修正の恩恵を自動的に受ける。

#### 呼び出し元 6: current-output/route.ts (L94)

```typescript
// L93-94
const promptOptions = buildDetectPromptOptions(cliToolId);
promptDetection = detectPrompt(cleanOutput, promptOptions);
```

**修正前の動作**: `isPromptWaiting: true` + 偽の `promptData` がクライアントに返される。`useAutoYes.ts` フックがこれを受けて自動応答を試みる（二重送信問題）。

**修正後の動作**: `detectPrompt()` が `isPrompt: false` を返すため、L99 の `isPromptWaiting` は `statusResult.hasActivePrompt`（status-detector 経由で同じく false）となり、L126 の `promptData` も null となる。クライアント側の不要な自動応答は発生しない。

**コード変更の必要性**: なし。

#### 呼び出し元 7: prompt-response/route.ts (L76)

```typescript
// L75-76
const promptOptions = buildDetectPromptOptions(cliToolId);
const promptCheck = detectPrompt(cleanOutput, promptOptions);
```

**修正前の動作**: 番号付きリストが偽プロンプトとして検出され、`promptCheck.isPrompt` が true を返す。キー送信が許可される。

**修正後の動作**: SEC-001b で拒否され、`promptCheck.isPrompt` が false を返す。L78-84 でレスポンスとして `{ success: false, reason: 'prompt_no_longer_active' }` が返され、不要なキー送信が防止される。

**コード変更の必要性**: なし。

#### 呼び出し元 8: claude-poller.ts (L166, L236) -- レガシーコード

```typescript
// L166 (options なし)
const promptDetection = detectPrompt(fullOutput);
// L236 (options なし)
const promptDetection = detectPrompt(result.response);
```

**分析**: `options` 引数が未指定のため `requireDefaultIndicator` はデフォルト値 `true` が適用される。SEC-001b ガードは `if (!requireDefault)` ブロック内にのみ追加されるため、このファイルのコードパスは一切影響を受けない。

さらに、ファイル内の TODO コメント（L162-163, L234-235）が明示するように、`claude-poller.ts` は `response-poller.ts` によって置き換え済みであり、実行時にこのコードパスに到達する可能性は極めて低い。

**コード変更の必要性**: なし。

---

## 3. 既存機能への影響

### 3.1 CLI ツール別影響分析

| CLI ツール | requireDefaultIndicator | Pass 1 Gate | SEC-001b 適用 | 影響 |
|-----------|------------------------|-------------|---------------|------|
| Claude | false | Skip | Yes | 正の影響（誤検出防止） |
| Codex | true (default) | Active | No | 影響なし |
| Gemini | true (default) | Active | No | 影響なし |

**Codex への影響**: `buildDetectPromptOptions('codex')` は `undefined` を返す（`/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/lib/cli-patterns.ts` L218-225）。`detectMultipleChoicePrompt()` 内で `requireDefault = options?.requireDefaultIndicator ?? true` により `true` が設定される。Pass 1 で cursor indicator（U+276F）の存在がチェックされるため、SEC-001b に到達するコードパスが存在しない。既存の Codex 動作に変更なし。

**Gemini への影響**: Codex と同様。`buildDetectPromptOptions('gemini')` は `undefined` を返す。既存の Gemini 動作に変更なし。

### 3.2 requireDefaultIndicator=true パスの分析

`requireDefaultIndicator: true`（デフォルト）で `detectPrompt()` が呼び出される場合のフロー:

```
detectMultipleChoicePrompt(output, { requireDefaultIndicator: true })
  |
  +-- requireDefault = true
  +-- Pass 1: cursor indicator 存在チェック (L321-337)
  |     +-- hasDefaultLine = false -> return isPrompt: false (ここで終了)
  |     +-- hasDefaultLine = true -> Pass 2 へ進む
  +-- Pass 2: オプション収集 (L343-381)
  +-- Layer 3: 連番検証 (L384-390)
  +-- Layer 4: 選択肢数 + cursor チェック (L394-400)
  +-- Layer 5 SEC-001: if (!requireDefault) ブロック (L402-411)
  |     +-- requireDefault = true のためこのブロックに**入らない**
  |     +-- SEC-001b は一切実行されない
  +-- 質問テキスト抽出 (L414-428)
  +-- return isPrompt: true
```

Layer 5 の `if (!requireDefault)` ブロックは `requireDefault = true` の場合スキップされるため、SEC-001b ガードは実行されない。これにより、cursor indicator 付きの正規プロンプト（Codex/Gemini パス）は既存と全く同じロジックで処理される。

### 3.3 requireDefaultIndicator=false + 正規プロンプトの分析

Claude Code が表示する実際の選択肢プロンプトが SEC-001b で誤って拒否されないことを検証する。

**ケース 1: 疑問符終端の質問**
```
Which option would you like?
  1. Yes
  2. No
```
- `questionEndIndex` -> "Which option would you like?" の行
- `isQuestionLikeLine("Which option would you like?")` -> `line.endsWith('?')` = true
- 結果: SEC-001b 通過 -> `isPrompt: true` (正常動作維持)

**ケース 2: 選択キーワード + コロンの質問**
```
Select a mode:
  1. Development
  2. Production
```
- `isQuestionLikeLine("Select a mode:")` -> `line.endsWith(':')` = true, `QUESTION_KEYWORD_PATTERN.test("Select a mode:")` = true ("select" マッチ)
- 結果: SEC-001b 通過 -> `isPrompt: true` (正常動作維持)

**ケース 3: Bash ツールのインデント付き質問**
```
  Allow this command?
  1. Yes
  2. No
```
- `isContinuationLine()` の `!line.endsWith('?')` 除外により、"Allow this command?" は continuation line として**扱われない**
- `questionEndIndex` -> "Allow this command?" の行
- `isQuestionLikeLine("Allow this command?")` -> `line.endsWith('?')` = true
- 結果: SEC-001b 通過 -> `isPrompt: true` (正常動作維持)

---

## 4. パフォーマンスへの影響

### 4.1 追加処理コスト

| 処理 | 条件 | 計算量 | 実行頻度 |
|------|------|--------|---------|
| `isQuestionLikeLine()` | `!requireDefault && questionEndIndex >= 0` の場合のみ | O(n), n = 1行の長さ（通常50文字以下） | detectPrompt() 呼び出しごとに最大1回 |
| `QUESTION_KEYWORD_PATTERN.test()` | `line.endsWith(':')` の場合のみ | O(m), m = パターン長（固定、約100文字） | isQuestionLikeLine() 内で最大1回 |

### 4.2 ReDoS リスク

`QUESTION_KEYWORD_PATTERN` は `(?:keyword1|keyword2|...)` 形式の単純な OR パターンであり、ネストされた量指定子やバックトラッキングを引き起こす構造を含まない。ReDoS リスクはない。

### 4.3 ポーリングループへの影響

`auto-yes-manager.ts` と `response-poller.ts` は 2 秒間隔のポーリングループで `detectPrompt()` を呼び出す。追加される `isQuestionLikeLine()` の処理時間はマイクロ秒オーダーであり、2 秒のポーリング間隔に対して無視できるレベルである。

### 4.4 結論

パフォーマンスへの影響は事実上ゼロ。最適化は不要。

---

## 5. テストカバレッジの影響

### 5.1 現状のテストカバレッジ

`tests/unit/prompt-detector.test.ts` は 1233 行、以下の領域をカバー:

| テスト領域 | テスト数 | カバー範囲 |
|-----------|---------|-----------|
| yes/no パターン (Pattern 1-5) | 16 | detectPrompt() の非 multiple_choice パス |
| Issue #161 回帰テスト | 7 | Pass 1, Layer 2-4 防御 |
| Issue #161 防御層境界テスト | 5 | 各 Layer の独立検証 |
| Issue #181 multiline continuation | 6 | isContinuationLine() |
| Issue #161 50行ウィンドウ | 3 | スキャンウィンドウ境界 |
| Issue #193 requireDefaultIndicator | 10 | Pass 1 スキップ、Layer 4、SEC-001 |
| Bash tool インデント検出 | 4 | isContinuationLine() の ? 除外 |
| trailing empty lines | 2 | effectiveEnd 計算 |
| getAnswerInput | 17 | 入力変換 |
| buildDetectPromptOptions | 3 | CLI ツール別オプション生成 |

### 5.2 追加テスト計画の評価

設計方針書のテスト計画 T1-T14 は以下をカバー:

| テスト ID | カテゴリ | 検証内容 |
|-----------|---------|---------|
| T1-T4 | False positive 防止 | 通常の番号付きリスト -> isPrompt: false |
| T5-T7 | 正規プロンプト維持 | 質問行 + 番号選択肢 -> isPrompt: true |
| T8 | SEC-001a 回帰 | 質問行なし -> isPrompt: false (既存) |
| T9-T10 | requireDefault=true 回帰 | デフォルト動作維持 |
| T11 | isQuestionLikeLine 単体 | 各パターンの true/false 検証 |
| T12 | 全角疑問符 | エッジケース |
| T13 | 長い出力 | パフォーマンス/境界 |
| T14 | Bash ツール連携 | isContinuationLine との相互作用 |

### 5.3 テストカバレッジの評価

**十分にカバーされている領域**:
- SEC-001b ガードの false positive 防止（T1-T4）
- 正規プロンプトの検出維持（T5-T7）
- 既存防御層の回帰テスト（T8-T10）
- isQuestionLikeLine() の個別パターン検証（T11）
- エッジケース（T12-T14）

**間接的にカバーされている領域**:
- response-poller.ts 経由のパス: `detectPromptWithOptions()` は `detectPrompt()` の薄いラッパーであるため、prompt-detector.ts の単体テストでカバー
- current-output/route.ts、prompt-response/route.ts: API レイヤーは `buildDetectPromptOptions()` + `detectPrompt()` の組み合わせを使用し、個別テスト済み
- status-detector.ts: `detectPrompt()` を内部で呼び出すが、status-detector 自体のテストは本修正のスコープ外

**テスト不足のリスク**: 低い。全ての呼び出し元が `detectPrompt()` の同一公開 API を使用しており、API シグネチャに変更がないため、単体テストレベルの検証で十分である。

---

## 6. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | requireDefault=true パスへの予期しない影響 | Low | Low | P3 |
| セキュリティリスク | QUESTION_KEYWORD_PATTERN が不十分で正規プロンプトを見逃す | Low | Low | P3 |
| 運用リスク | 既存 Auto-Yes ユーザーの動作変更 | Low | Low | P3 |
| 回帰リスク | Codex/Gemini の既存動作への影響 | Low | Very Low | P3 |

### 6.1 技術的リスクの詳細

SEC-001b ガードは `if (!requireDefault)` ブロック内にのみ追加されるため、`requireDefault=true` パスに影響するリスクは構造的に排除されている。これはコード構造レベルの保証であり、テストのみに依存しない。

### 6.2 False Negative リスクの詳細

Claude Code が将来的に QUESTION_KEYWORD_PATTERN に含まれないキーワードで質問する可能性がある。しかし:
- `?` で終わる質問は無条件で許可されるため、疑問文形式のプロンプトは見逃さない
- 防御的追加キーワード（how, where, type, specify, approve, accept, reject, decide, preference, option）により、未観測パターンへのカバレッジが確保されている
- 万が一 False Negative が発生した場合、Auto-Yes が機能しないだけであり、ユーザーが手動で応答すれば正常に処理される（安全側に倒れる）

---

## 7. 改善推奨事項

### 7.1 Should Fix

| ID | カテゴリ | タイトル | 推奨事項 |
|----|---------|---------|---------|
| IA-001 | legacy_code | claude-poller.ts のレガシーコード認識 | 設計方針書のセクション9.3に記載済み。現時点で追加アクション不要。将来的な claude-poller.ts 削除時に本修正のコンテキストを考慮する。 |
| IA-002 | test_coverage | response-poller.ts 経由の間接テスト | prompt-detector.ts の単体テストで十分。統合テストの追加はオプション。 |

### 7.2 Consider

| ID | カテゴリ | タイトル | 検討事項 |
|----|---------|---------|---------|
| IA-003 | performance | isQuestionLikeLine() の計算コスト | パフォーマンス懸念なし。 |
| IA-004 | edge_case | trust dialog との相互作用 | 現時点で影響なし。 |

---

## 8. 結論

本設計方針書の影響範囲は適切に制御されており、以下の点が確認された:

1. **変更の局所性**: `prompt-detector.ts` の1ファイルのみの変更で、公開 API に変更なし
2. **波及効果の制御**: `if (!requireDefault)` ブロック内への追加により、影響範囲が Claude CLI パスに限定
3. **既存機能の保全**: Codex/Gemini の `requireDefaultIndicator: true` パスは構造的に影響範囲外
4. **正の波及効果**: 8箇所全ての呼び出し元で誤検出防止効果が自動的に適用
5. **パフォーマンス無影響**: 追加処理コストはマイクロ秒オーダー
6. **テストカバレッジ**: T1-T14 の計画により、直接変更・間接影響の両方を網羅

**評価**: approved (5/5)

---

## 9. レビューメタデータ

| 項目 | 値 |
|------|-----|
| レビュー対象 | Issue #208 設計方針書 |
| レビューステージ | Stage 3: 影響分析レビュー |
| レビュー日 | 2026-02-09 |
| レビューアー | Architecture Review Agent |
| レビュー対象ファイル数 | 12 |
| 指摘事項 | Must Fix: 0, Should Fix: 2, Consider: 2 |
