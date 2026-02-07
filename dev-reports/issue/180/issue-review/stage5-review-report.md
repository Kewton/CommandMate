# Issue #180 レビューレポート (Stage 5)

**レビュー日**: 2026-02-07
**フォーカス**: 通常レビュー（2回目）
**イテレーション**: 2回目
**ステージ**: 5

## サマリー

Stage 1 で指摘した10件の問題は全て適切に修正されていることを確認した。Issue 全体の構造・内容は大幅に改善されており、設計方針書の作成に十分な情報量を持っている。

今回の Stage 5 レビューでは、新たに追加されたコンテンツ（detectPrompt() コールマップ、方式A/B/C、受け入れ条件）の技術的正確性を重点的に検証した結果、must_fix レベルの問題は発見されなかったが、行番号の不正確さやコールマップの呼び出し箇所の漏れなど、should_fix レベルの問題が6件検出された。

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 6 |
| Nice to Have | 3 |

---

## Stage 1 指摘事項の解決確認

全10件が適切に解決されている。

| ID | 内容 | 状態 |
|----|------|------|
| S1-001 | タイトルのスコープ | 解決済み - 全プラットフォーム共通の問題として修正 |
| S1-002 | [id]/route.ts の漏れ | 解決済み - 影響範囲に追加 |
| S1-003 | 修正案の整理 | 解決済み - 軸1/軸2 + 方式A/B/Cに整理 |
| S1-004 | 検索階層の明確化 | 解決済み - 2段階構造を明記 |
| S1-005 | 受け入れ条件の欠如 | 解決済み - 14項目の具体的条件を追加 |
| S1-006 | auto-yes-manager の言及 | 解決済み - 影響範囲に追加、Layer 1 防御を注記 |
| S1-007 | 優先順位変更のトレードオフ | 解決済み - エッジケースを記載 |
| S1-008 | スクリーンショット | 解決済み - 「なし」と明記 |
| S1-009 | 関連Issue | 解決済み - #161, #152 を追加 |
| S1-010 | 修正方式の明確化 | 解決済み - 方式A/B/C を定義、影響ファイル一覧付き |

---

## Should Fix（推奨対応）

### S5-001: response-poller.ts のコールマップ呼び出し箇所の漏れ

**カテゴリ**: 正確性
**場所**: ## detectPrompt() コールマップ

**問題**:
response-poller.ts の detectPrompt() 呼び出し箇所が2箇所（行248, 行442）と記載されているが、実際には3箇所ある。行556の `checkForResponse()` 関数内で `detectPrompt(result.response)` として呼び出されており、完了レスポンスがプロンプトかどうかを再判定する用途で使用されている。

**証拠**:
```
$ grep -n 'detectPrompt' src/lib/response-poller.ts
248:    const promptDetection = detectPrompt(cleanFullOutput);
442:  const promptDetection = detectPrompt(fullOutput);
556:    const promptDetection = detectPrompt(result.response);
```

**推奨対応**:
コールマップに行556の呼び出しを追加し、用途を「完了レスポンスのプロンプト再判定」と記載する。

---

### S5-002: current-output/route.ts の入力説明の不正確さ

**カテゴリ**: 正確性
**場所**: ## detectPrompt() コールマップ > current-output/route.ts 行

**問題**:
入力内容を「cleanOutput（thinkingスキップ後）」と記載しているが、実際には detectPrompt() に渡される cleanOutput 自体は全文であり加工されていない。thinking が検出された場合は detectPrompt() の呼び出し自体がスキップされる（三項演算子により）。「thinkingスキップ後」は入力データが加工されたように誤解される。

**証拠**:
```typescript
// src/app/api/worktrees/[id]/current-output/route.ts 行88
const promptDetection = thinking
  ? { isPrompt: false, cleanContent: cleanOutput }
  : detectPrompt(cleanOutput);  // cleanOutput は全文
```

**推奨対応**:
「cleanOutput（全文、ただしthinking検出時はdetectPrompt自体をスキップ）」に修正する。

---

### S5-003: route.ts のコールマップ行番号の不正確さ

**カテゴリ**: 正確性
**場所**: ## detectPrompt() コールマップ > route.ts / [id]/route.ts 行番号

**問題**:
コールマップで route.ts と [id]/route.ts の detectPrompt() 呼び出し箇所を「行47付近」と記載しているが、実際の detectPrompt(cleanOutput) は行62にある。行47は for ループの開始行である。

**証拠**:
```
$ grep -n 'detectPrompt' src/app/api/worktrees/route.ts
62:              const promptDetection = detectPrompt(cleanOutput);
$ grep -n 'detectPrompt' src/app/api/worktrees/[id]/route.ts
62:          const promptDetection = detectPrompt(cleanOutput);
```

**推奨対応**:
コールマップの行番号を「行62」に修正する。

---

### S5-004: 現在のロジック・コードスニペットの行番号範囲

**カテゴリ**: 正確性
**場所**: ## 修正案 > 現在のロジック（問題あり）コードスニペット

**問題**:
コメントに「route.ts (行47-111)」と記載されているが、コードスニペットに示されているステータス検出ロジック（detectPrompt -> detectThinking -> promptPattern のフロー）は行56-84の if(isRunning) ブロック内に対応する。行47-111 は for ループ全体（セッションステータスの構築とフラグ集約を含む）の範囲であり、示されているスニペットよりはるかに広い。

**推奨対応**:
コメントを「route.ts (行56-84)」に修正するか、「route.ts (行47-111、うちスニペット該当部分は行56-84)」と補足する。

---

### S5-006: response-poller.ts の方式B影響分析の不足

**カテゴリ**: 技術的妥当性
**場所**: ## 修正案 > 各方式の影響ファイル一覧

**問題**:
response-poller.ts には detectPrompt() の呼び出しが3箇所（行248, 行442, 行556）あるが、それぞれの用途が異なる。行248は `cleanFullOutput`（stripAnsi後の全文）、行442は `fullOutput`（全文）、行556は `result.response`（抽出済みレスポンス）を入力としている。方式Bで検索範囲を制限した場合、行556の `result.response` は既にレスポンス部分のみに抽出されたテキストであるため、更に末尾N行に制限すると意図しない動作になる可能性がある。

**推奨対応**:
方式Bの影響分析で response-poller.ts の3つの呼び出しを個別に評価する必要がある旨を記載する。

---

### S5-009: status-detector.ts のコールマップ前処理パイプライン記載

**カテゴリ**: 正確性
**場所**: ## detectPrompt() コールマップ > status-detector.ts 行

**問題**:
コールマップで status-detector.ts の入力を「lastLines（最後15行）」と記載しているが、status-detector.ts 内部では stripAnsi(output) を適用後に split/slice/join を行って lastLines を生成している（行74-76）。route.ts では stripAnsi 適用済みの cleanOutput を detectPrompt() に直接渡している。方式Aを選択して status-detector.ts を参照実装とする場合、この前処理パイプラインの違いは設計上の重要な情報である。

**証拠**:
```typescript
// status-detector.ts 行74-76
const cleanOutput = stripAnsi(output);
const lines = cleanOutput.split('\n');
const lastLines = lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');
// route.ts 行59, 62
const cleanOutput = stripAnsi(output);
const promptDetection = detectPrompt(cleanOutput);  // 全文を渡す
```

**推奨対応**:
コールマップの status-detector.ts 行に「stripAnsi適用後の最後15行の結合文字列」と前処理を含めた記載にする。

---

## Nice to Have（あれば良い）

### S5-005: auto-yes-manager.ts の行番号表記の一貫性

**カテゴリ**: 完全性
**場所**: ## detectPrompt() コールマップ / ## 影響範囲

**問題**:
auto-yes-manager.ts の detectPrompt() 呼び出しを「行290付近」と表記しているが、実際の行は正確に行290である。detectThinking() は「行284」と正確に表記されている。

**推奨対応**:
「行290付近」を「行290」に修正する。

---

### S5-007: 受け入れ条件と共通関数化提案の整合性

**カテゴリ**: 整合性
**場所**: ## 受け入れ条件 > 機能要件

**問題**:
受け入れ条件の項目6「route.ts と [id]/route.ts の両方に修正が適用されていること」は、共通関数化が実施された場合には1箇所の修正で自動的に満たされる。修正案セクションで共通関数化を提案しているため、受け入れ条件にもこのケースを想定した記載があると良い。

**推奨対応**:
「共通関数化により1箇所での修正で両方に反映される場合はそれで可」と補足する。

---

### S5-008: status-detector.ts が未使用である経緯

**カテゴリ**: 完全性
**場所**: ## 修正案 > 軸1: 検出優先順位の変更

**問題**:
status-detector.ts が「アプリケーション内で一切使用されていない（テストのみ）」と記載されているが、この状態になった経緯（Issue #54で作成されたが統合されなかった等）が不明。設計方針書でこのモジュールの活用可否を判断する際に有用な背景情報。

**推奨対応**:
可能であれば status-detector.ts が未使用のままである経緯を補足する。

---

## 参照ファイル

### コード（全て実際のコードを確認済み）

| ファイル | 確認内容 |
|---------|---------|
| `src/app/api/worktrees/route.ts` | detectPrompt() 行62、detectThinking() 行71、promptPattern.test() 行77 |
| `src/app/api/worktrees/[id]/route.ts` | detectPrompt() 行62、ステータス検出ロジックが route.ts と完全一致 |
| `src/lib/prompt-detector.ts` | detectPrompt() 行44、slice(-10) 行48、detectMultipleChoicePrompt 行56 |
| `src/lib/status-detector.ts` | detectSessionStatus() 行68、detectPrompt(lastLines) 行80、STATUS_CHECK_LINE_COUNT=15 行44 |
| `src/lib/auto-yes-manager.ts` | detectThinking() 行284、detectPrompt() 行290、cleanOutput全文を渡す |
| `src/app/api/worktrees/[id]/current-output/route.ts` | detectPrompt() 行88（三項演算子内）、thinking時スキップ |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | detectPrompt() 行75、5000行キャプチャ |
| `src/lib/response-poller.ts` | detectPrompt() 行248（cleanFullOutput）、行442（fullOutput）、行556（result.response）|
| `src/lib/claude-poller.ts` | detectPrompt() 行164（fullOutput）、行232（result.response） |
| `src/types/sidebar.ts` | deriveCliStatus() 行30-38 |

### テストファイル（全て存在確認済み）

| ファイル | パス |
|---------|------|
| prompt-detector.test.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/tests/unit/prompt-detector.test.ts` |
| auto-yes-manager.test.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/tests/unit/lib/auto-yes-manager.test.ts` |
| prompt-response-verification.test.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/tests/unit/api/prompt-response-verification.test.ts` |
| status-detector.test.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/__tests__/status-detector.test.ts` |
| cli-patterns.test.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/__tests__/cli-patterns.test.ts` |

---

## 総合評価

Issue #180 は Stage 1 以降の複数回のレビューと修正を経て、技術的に正確かつ包括的な内容になっている。以下の点が特に評価できる:

1. **問題分析の深さ**: 根本原因を3つの問題に分解し、それぞれの検出メカニズムとの関係を明確にしている
2. **修正方式の比較**: 方式A/B/Cの影響ファイル一覧付き比較は、設計方針書の作成に直接活用できる
3. **受け入れ条件の充実**: 機能要件、テスト要件、UI表示確認の3カテゴリ14項目は具体的で検証可能
4. **コールマップ**: detectPrompt() の全呼び出し箇所を一覧化しており、影響範囲の把握に有用

今回検出された should_fix 6件は主に行番号の正確性とコールマップの詳細度に関するものであり、Issue の構造や方向性に影響する問題ではない。修正は比較的軽微である。
