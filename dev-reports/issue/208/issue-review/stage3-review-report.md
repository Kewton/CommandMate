# Issue #208 影響範囲レビューレポート

**レビュー日**: 2026-02-09
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目（Stage 3）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |

Issue #208の影響範囲は、Issueに記載されている `auto-yes-manager.ts` と `status-detector.ts` の2つのパスだけでなく、`response-poller.ts` とクライアント側 `useAutoYes.ts` を含む計7ファイル12箇所の `detectPrompt()` 呼び出しパスに波及する。特に `response-poller.ts` はAuto-Yesの有無に関係なく偽promptメッセージをDBに保存する可能性があり、影響範囲の記載から完全に欠落している。

---

## Must Fix（必須対応）

### MF-1: response-poller.tsの影響パスが完全に欠落

**カテゴリ**: 影響ファイル
**場所**: ## 影響範囲 セクション

**問題**:
`response-poller.ts` 内の `detectPromptWithOptions()` は3箇所で `detectPrompt()` を呼び出しており、いずれも `buildDetectPromptOptions('claude')` 経由で `requireDefaultIndicator: false` が適用される。しかし、Issue #208の影響範囲セクションにはこのファイルが一切記載されていない。

このファイルの影響は **Auto-Yesモードの有無に関係なく発生する** 点で重要である。

**影響パスの詳細**:

1. **extractResponse() L297-310 (early check)**: Claude CLI用にfullOutput全文をdetectPromptWithOptions()に渡す。番号付きリストが誤検出されると `isComplete: true` で偽レスポンスが返り、後続の処理でDBへの保存やWebSocketブロードキャストが実行される

2. **checkForResponse() L488-498**: 完了判定がまだ出ていない場合のフォールバックとして、fullOutput全文をdetectPromptWithOptions()に渡す。誤検出するとDB上に `messageType='prompt'` の偽メッセージが作成される

3. **checkForResponse() L608**: 完了済みレスポンスに対して再度detectPromptWithOptions()で検査。誤検出するとpromptメッセージとして保存される

**証拠**:
```typescript
// response-poller.ts L297-310
if (cliToolId === 'claude') {
  const fullOutput = lines.join('\n');
  const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);
  if (promptDetection.isPrompt) {
    return {
      response: stripAnsi(fullOutput),
      isComplete: true,
      lineCount: totalLines,
    };
  }
}
```

```typescript
// response-poller.ts detectPromptWithOptions() L95-101
function detectPromptWithOptions(output: string, cliToolId: CLIToolType): PromptDetectionResult {
  const promptOptions = buildDetectPromptOptions(cliToolId);
  return detectPrompt(stripAnsi(output), promptOptions);
}
```

**推奨対応**:
影響範囲セクションに `response-poller.ts` の3つの `detectPromptWithOptions()` 呼び出しパスを追記する。特にAuto-Yesモードの有無に関係なく影響が発生する点を明記する。

---

## Should Fix（推奨対応）

### SF-1: claude-poller.tsの整合性チェック対象としての記載欠落

**カテゴリ**: 影響ファイル
**場所**: ## 関連コード セクション

**問題**:
`claude-poller.ts` は `response-poller.ts` によってsupersededとされているが、コード上は依然として到達可能であり、L166とL236で `detectPrompt()` を `buildDetectPromptOptions()` なしで呼び出している。

現時点では `requireDefaultIndicator` がデフォルト `true` として適用されるため、本Issueのバグは発生しない。しかし、修正時にこのファイルの存在を見落とすと、将来的に不整合が生じる可能性がある。

**証拠**:
```typescript
// claude-poller.ts L162-166
// TODO [Issue #193]: This code path is unreachable (claude-poller.ts is superseded by response-poller.ts).
// When refactoring/removing claude-poller.ts, apply stripAnsi() + buildDetectPromptOptions() here.
if (!isThinking) {
    const fullOutput = lines.join('\n');
    const promptDetection = detectPrompt(fullOutput);
```

**推奨対応**:
関連コードテーブルに `claude-poller.ts` L166, L236を追記し、修正時の整合性チェック対象として明記する。

---

### SF-2: テスト範囲の記載が完全に欠落

**カテゴリ**: テスト範囲
**場所**: Issue本文全体

**問題**:
Issueにテスト範囲に関する記載が一切ない。本Issueの修正は複数のモジュールに影響するため、以下の回帰テストが必要である。

**必要なテスト一覧**:

| テスト対象 | テスト内容 | テスト種別 |
|-----------|-----------|-----------|
| `prompt-detector.ts` | `requireDefaultIndicator=false` + 番号付きリスト（question行あり/なし）の誤検出防止 | 単体テスト |
| `prompt-detector.ts` | `requireDefaultIndicator=false` + Claude Codeの正規選択肢プロンプトの正常検出（Issue #193回帰） | 単体テスト |
| `auto-yes-manager.ts` | 番号付きリストを含むtmux出力に対するpollAutoYes()の自動応答発生有無 | 結合テスト |
| `status-detector.ts` | 15行ウィンドウ内に番号付きリストが存在する場合のステータス判定 | 単体テスト |
| `response-poller.ts` | 番号付きリストを含むfullOutputでのextractResponse()結果（偽prompt検出防止） | 単体テスト |

**推奨対応**:
影響範囲セクションまたは新規セクションとして「テスト対象」を追加し、各影響パスに対する回帰テストの必要性を明記する。

---

### SF-3: useAutoYes.tsクライアント側フォールバックの影響パス未記載

**カテゴリ**: 依存関係
**場所**: ## 影響範囲 セクション

**問題**:
`useAutoYes.ts` はクライアント側のAuto-Yesフォールバック実装であり、`current-output` APIから取得した `isPromptWaiting` と `promptData` に依存して自動応答を送信する。

影響の連鎖は以下の通り:

1. `current-output/route.ts` の `detectSessionStatus()` が番号付きリストを `waiting` と誤検出
2. `isPromptWaiting = statusResult.hasActivePrompt` が `true` になる
3. `detectPrompt(cleanOutput, promptOptions)` がpromptDataを返す
4. APIレスポンスに `isPromptWaiting: true` と `promptData: { type: 'multiple_choice', ... }` が含まれる
5. `useAutoYes.ts` が `resolveAutoAnswer(promptData)` を呼び出し「1」を送信
6. `prompt-response/route.ts` が送信前検証で再度 `detectPrompt()` を呼び出し、誤検出により送信を許可

サーバー側 `auto-yes-manager.ts` の応答から3秒以上経過した場合、クライアント側でも重複送信が発生する。

**推奨対応**:
影響範囲セクションにクライアント側の影響パスを追記する。ただし、`current-output/route.ts` の15行ウィンドウ（statusResult.hasActivePrompt）により、`auto-yes-manager.ts` の5000行バッファ（内部50行スキャン）よりも検出範囲が狭いため、サーバー側単独より発生頻度が低い点も付記する。

---

## Nice to Have（あれば良い）

### NTH-1: ドキュメント更新対象の列挙

**カテゴリ**: ドキュメント更新
**場所**: ## 影響範囲 セクション

**問題**:
修正完了後に更新が必要なドキュメントの列挙がない。

**更新対象ドキュメント**:
- `CLAUDE.md` の Issue #193 セクション（防御層の挙動変更に伴う記述更新）
- `dev-reports/design/issue-193-multiple-choice-prompt-detection-design-policy.md`
- `dev-reports/design/issue-161-auto-yes-false-positive-design-policy.md`

---

### NTH-2: Issue #193回帰リスクの明示

**カテゴリ**: 破壊的変更
**場所**: ## 対策案の方向性 セクション

**問題**:
対策案の方向性に、Issue #193で対応したClaude Codeの選択肢プロンプト検出が回帰するリスクの評価が含まれていない。

修正方針によっては、以下の正常ケースが阻害される可能性がある:
- Claude Codeが実際に表示する選択肢プロンプト（質問行あり、番号付き選択肢、マーカーなし）
- `requireDefaultIndicator: false` が設計意図どおりに機能するケース

各対策案に対してIssue #193の回帰リスク評価を追記することを推奨する。

---

## 影響範囲マップ

### detectPrompt()呼び出しの全パス一覧

以下は `buildDetectPromptOptions('claude')` 経由で `requireDefaultIndicator: false` が適用される全呼び出しパスである。

| # | ファイル | 行 | 入力データ | ウィンドウ | 影響 |
|---|---------|-----|-----------|-----------|------|
| 1 | `auto-yes-manager.ts` | L318 | cleanOutput全文（5000行） | 内部50行 | "1"自動送信（主要バグ） |
| 2 | `status-detector.ts` | L135 | lastLines（15行ウィンドウ） | 15行 | サイドバーwaitingステータス誤表示 |
| 3 | `response-poller.ts` | L299 | fullOutput（trimmed全文） | 内部50行 | 偽promptとしてisComplete=true返却 |
| 4 | `response-poller.ts` | L489 | fullOutput（trimmed全文） | 内部50行 | 偽promptメッセージDB保存+ブロードキャスト |
| 5 | `response-poller.ts` | L608 | result.response | 内部50行 | 偽promptメッセージDB保存+ブロードキャスト |
| 6 | `current-output/route.ts` | L94 | cleanOutput全文 | 内部50行 | isPromptWaiting=true, promptData返却 |
| 7 | `prompt-response/route.ts` | L76 | cleanOutput全文 | 内部50行 | 送信前検証の正確性低下 |

### detectPrompt()呼び出し（requireDefaultIndicator未指定=true）

| # | ファイル | 行 | 備考 |
|---|---------|-----|------|
| 8 | `claude-poller.ts` | L166 | superseded but reachable. Pass 1有効のため本バグ不発生 |
| 9 | `claude-poller.ts` | L236 | 同上 |

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/lib/prompt-detector.ts`: detectMultipleChoicePrompt()の全防御層（修正の中心対象）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/lib/cli-patterns.ts`: buildDetectPromptOptions()（問題の起点）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/lib/auto-yes-manager.ts`: pollAutoYes()（主要誤検出パス）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/lib/auto-yes-resolver.ts`: resolveAutoAnswer()（間接的影響）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/lib/status-detector.ts`: detectSessionStatus()（15行ウィンドウ経由）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/lib/response-poller.ts`: detectPromptWithOptions() 3箇所（**Issueに未記載の影響パス**）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/app/api/worktrees/[id]/current-output/route.ts`: promptData返却パス
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/app/api/worktrees/[id]/prompt-response/route.ts`: 送信前検証パス
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/app/api/worktrees/route.ts`: detectSessionStatus()経由の間接パス
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/app/api/worktrees/[id]/route.ts`: detectSessionStatus()経由の間接パス
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/hooks/useAutoYes.ts`: クライアント側Auto-Yesフォールバック
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/lib/claude-poller.ts`: 整合性チェック対象（superseded but reachable）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/CLAUDE.md`: Issue #161, #193の実装詳細。修正後の更新対象
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/dev-reports/design/issue-193-multiple-choice-prompt-detection-design-policy.md`: requireDefaultIndicator: false導入の設計根拠
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/dev-reports/design/issue-161-auto-yes-false-positive-design-policy.md`: 2パス検出方式の設計根拠
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/dev-reports/design/issue-188-thinking-indicator-false-detection-design-policy.md`: ウィンドウイング設計

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/tests/unit/prompt-detector.test.ts`: 既存prompt-detectorテスト（回帰テスト追加対象）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/tests/unit/lib/auto-yes-manager.test.ts`: 既存auto-yes-managerテスト（結合テスト追加対象）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/tests/unit/lib/auto-yes-resolver.test.ts`: 既存auto-yes-resolverテスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/tests/unit/lib/status-detector.test.ts`: 既存status-detectorテスト（ウィンドウ内番号リストテスト追加対象）
