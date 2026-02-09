# Issue #191 レビューレポート

**レビュー日**: 2026-02-08
**フォーカス**: 通常レビュー
**イテレーション**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 3 |

**総評**: Issue #191は原因分析が正確かつ詳細であり、仮説検証レポートでも全仮説がConfirmedとなっている。根本原因の特定（`detectThinking()`の検索範囲の非対称性）は的確である。一方、推奨する修正方針（案1: 末尾20行限定）の具体的なパラメータの根拠に不足があり、また既存の`status-detector.ts`が既に同種の問題を回避する実装を持っていることへの言及が欠けている。

---

## Must Fix（必須対応）

なし

Issue本文の技術的記述に重大な誤りは確認されなかった。仮説検証で全5項目がConfirmedであり、根本原因の分析、パターンマッチの検証、影響ファイルの特定はすべて正確である。

---

## Should Fix（推奨対応）

### SF-1: 案1の末尾20行パラメータの根拠不足

**カテゴリ**: 技術的妥当性
**場所**: 修正方針の候補 > 案1

**問題**:
推奨案1では`cleanOutput.split('\n').slice(-20)`と20行を提案しているが、この値の根拠が示されていない。現在のコードベースでは以下の検索範囲が使われている。

| モジュール | 関数 | 検索範囲 |
|-----------|------|---------|
| `status-detector.ts` L83 | `detectSessionStatus()` | 末尾15行 |
| `prompt-detector.ts` L48 | `detectPrompt()` (yes/no) | 末尾10行 |
| `prompt-detector.ts` L268 | `detectMultipleChoicePrompt()` | 末尾50行 |

20行という値は`detectMultipleChoicePrompt()`の50行ウィンドウより小さい。Claude CLIがthinking状態を示すスピナー行を出力し、その直後に（20行目以降に）multiple_choiceプロンプトの選択肢が表示される場合、thinking行がウィンドウ外になり検出できなくなる。Issue #161のLayer 1防御（thinking中はプロンプト検出をスキップ）が意図通り機能しないシナリオが生じうる。

**推奨対応**:
- `status-detector.ts`と同じ15行、または`detectPrompt`の最大ウィンドウ50行に合わせる根拠を明記する
- 末尾N行の値選定に関するトレードオフ（狭すぎるとLayer 1防御漏れ、広すぎると本Issue再発）を記載する

---

### SF-2: 案2・案3の却下理由が未記載

**カテゴリ**: 完全性
**場所**: 修正方針の候補 > 案2, 案3

**問題**:
3つの修正方針候補が示されているが、案2と案3を採用しない理由やトレードオフが記載されていない。

特に注目すべき点として、`status-detector.ts`の`detectSessionStatus()`は**既にプロンプト検出をthinking検出より優先**して実行している（L85-106）。これは案2のアプローチそのものであり、`status-detector.ts`では問題が発生していない。

```
// status-detector.ts の優先順位:
1. detectPrompt(lastLines)      -- プロンプト検出が最優先
2. detectThinking(cliToolId, lastLines)  -- thinking検出は2番目
3. promptPattern.test(lastLines) -- 入力プロンプト検出
```

```
// auto-yes-manager.ts の優先順位（現行/問題あり）:
1. detectThinking(cliToolId, cleanOutput)  -- thinking検出が最優先
2. detectPrompt(cleanOutput)               -- プロンプト検出は2番目
```

この不整合が本Issueの一因であることを明記し、案2が既存実装との整合性が高いことに言及すべきである。

**推奨対応**:
- 案2: 既存のstatus-detector.tsと同じ優先順位であるメリットを記載。ただし、Issue #161で意図的にthinkingを先に配置した経緯（thinking中の番号付きリスト誤検出防止）との兼ね合いを記載
- 案3: Claude CLIバージョンアップでサマリー行のフォーマットが変更された場合にメンテナンスコストが増加するデメリットを記載

---

### SF-3: status-detector.tsとの不整合に関する言及不足

**カテゴリ**: 整合性
**場所**: 根本原因 > 問題の非対称性

**問題**:
Issue本文の「問題の非対称性」テーブルでは`detectThinking()`と`detectPrompt()`の検索範囲の差異のみを記載しているが、`status-detector.ts`では**既にdetectThinking()を末尾15行に限定して実行している**事実に言及がない。

```typescript
// status-detector.ts L81-83, L99
const lastLines = lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n'); // 15行
if (detectThinking(cliToolId, lastLines)) { // <-- 末尾15行のみ
```

これは`auto-yes-manager.ts`だけがバッファ全体を渡している異常な状態であることを示しており、修正の正当性と方向性をさらに強く裏付ける根拠となる。

**推奨対応**:
「問題の非対称性」テーブルに以下の行を追加する。

| 関数 | 検索範囲 | 備考 |
|------|---------|------|
| `detectThinking()` (auto-yes-manager.ts) | バッファ全体（5000行） | 古い出力にもマッチ |
| `detectThinking()` (status-detector.ts) | 末尾15行のみ | 問題なし |
| `detectPrompt()` | 末尾10-50行のみ | 最新の状態のみ検索 |

---

### SF-4: 受け入れ条件にstatus-detector.tsとの一貫性検証が不足

**カテゴリ**: 受け入れ条件
**場所**: 受け入れ条件

**問題**:
現在の受け入れ条件は修正の基本的な正しさを確認するものだが、以下の観点が欠けている。

1. **status-detector.tsとの一貫性**: 修正後のdetectThinking()呼び出しパターンがstatus-detector.tsの実装と一貫していること
2. **回帰テストケース**: 「5000行バッファにサマリー行（例: `· Simmering...`）を含み、末尾にyes/noプロンプトがある場合にプロンプトが正常検出される」テストケース

**推奨対応**:
以下の受け入れ条件を追加する。
- `[ ]` detectThinking()の検索範囲がstatus-detector.tsの実装と一貫していること
- `[ ]` バッファ中間にthinkingサマリー行が残存し、末尾にプロンプトがある場合のテストケースが追加されていること

---

## Nice to Have（あれば良い）

### NTH-1: 影響ファイルテーブルにstatus-detector.tsの追加

**カテゴリ**: 完全性
**場所**: 影響ファイル

影響ファイルテーブルにstatus-detector.ts（L99）を「参照（整合性確認）」として追加すると、修正者が設計の一貫性を確認しやすくなる。

---

### NTH-2: `to interrupt)` パターンの残存リスクへの注記

**カテゴリ**: 完全性
**場所**: 根本原因 > マッチしてしまう残存出力の例

`CLAUDE_THINKING_PATTERN`の後半部分 `to interrupt)` もバッファ全体を検索した場合に過去の出力にマッチする可能性がある（例: Claude CLIが `(esc to interrupt)` と表示した後に処理を完了し、次のプロンプトを表示する場合）。ただし、このパターンはthinking状態の表示に付随するため、残存リスクはスピナー行よりは低い。テーブルに注記として追加しておくとより網羅的になる。

---

### NTH-3: 再現手順のプロンプトフォーマット明確化

**カテゴリ**: 明確性
**場所**: 再現手順 ステップ4

再現手順に「Do you want to proceed? プロンプトを表示」とあるが、これが具体的にどのプロンプトパターン（`(y/n)`付きなのか、`❯ 1. Yes / 2. No` 形式なのか）として検出されるかが不明瞭である。`detectPrompt()`のパターンマッチとの対応を明記すると、再現検証の精度が向上する。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/auto-yes-manager.ts` (L276-287): バグの発生箇所。detectThinking()にバッファ全体を渡している
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/cli-patterns.ts` (L26-29, L73-95): CLAUDE_THINKING_PATTERN定義とdetectThinking()関数
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/prompt-detector.ts` (L44-63, L264-268): detectPrompt()の検索範囲
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/status-detector.ts` (L81-106): 既にdetectThinking()を末尾15行に限定している参照実装
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/tests/unit/lib/auto-yes-manager.test.ts` (L427-499): Issue #161のthinking stateスキップテスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/tests/unit/lib/cli-patterns.test.ts` (L142-163): detectThinking()の既存テスト

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/CLAUDE.md`: Issue #161のAuto-Yes誤検出修正の記載との整合性確認

### 仮説検証
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/dev-reports/issue/191/issue-review/hypothesis-verification.md`: 全5仮説がConfirmed。原因分析は正確
