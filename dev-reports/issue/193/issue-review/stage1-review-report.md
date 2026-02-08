# Issue #193 レビューレポート（Stage 1）

**レビュー日**: 2026-02-08
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目
**仮説検証レポート**: `dev-reports/issue/193/issue-review/hypothesis-verification.md`

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 4 |
| Nice to Have | 3 |

Issue全体の構成は良く整理されており、再現手順・期待動作・実際の動作のセクションは明確である。Phase 1（前提条件確認）を設けて調査結果に基づく条件分岐型の対策案にしている点は適切な設計判断である。

一方、仮説検証の結果、以下の重要な不整合が確認された。

---

## Must Fix（必須対応）

### MF-1: CLAUDE_CHOICE_INDICATOR_PATTERN はコードベースに存在しない

**カテゴリ**: 整合性
**場所**: 対策案 ケースA / 影響範囲 変更対象ファイル

**問題**:
Issue記載の`CLAUDE_CHOICE_INDICATOR_PATTERN`というパターン名はコードベースのどこにも存在しない。選択肢検出パターンは`src/lib/prompt-detector.ts`内に以下の名前でハードコードされている。

- `DEFAULT_OPTION_PATTERN` (L182): `/^\s*\u276F\s*(\d+)\.\s*(.+)$/`
- `NORMAL_OPTION_PATTERN` (L189): `/^\s*(\d+)\.\s*(.+)$/`

また変更対象ファイル欄で`cli-patterns.ts`への変更が示唆されているが、`cli-patterns.ts`には選択肢検出に関するパターンは一切定義されていない。

**証拠**:
```bash
$ grep -r 'CLAUDE_CHOICE_INDICATOR_PATTERN' src/
# 結果: 該当なし（dev-reports/ 内のドキュメントのみヒット）
```

`src/lib/cli-patterns.ts`のexport一覧:
- `CLAUDE_SPINNER_CHARS`
- `CLAUDE_THINKING_PATTERN`
- `CLAUDE_PROMPT_PATTERN`
- `CLAUDE_SEPARATOR_PATTERN`
- `CODEX_THINKING_PATTERN` / `CODEX_PROMPT_PATTERN` / `CODEX_SEPARATOR_PATTERN`
- `GEMINI_PROMPT_PATTERN`
- `detectThinking()` / `getCliToolPatterns()` / `stripAnsi()`

選択肢インジケータに関するパターンは含まれていない。

**推奨対応**:
1. `CLAUDE_CHOICE_INDICATOR_PATTERN`への参照を全て`DEFAULT_OPTION_PATTERN`（`prompt-detector.ts` L182）に修正する
2. 変更対象ファイル欄の`cli-patterns.ts`の行を削除するか、`prompt-detector.ts`に置き換える
3. ケースAの説明を「`cli-patterns.ts`のパターン修正」から「`prompt-detector.ts`の`DEFAULT_OPTION_PATTERN` / `NORMAL_OPTION_PATTERN`の修正」に変更する

---

### MF-2: Layer 4 (hasDefaultIndicator) が根本原因分析から欠落

**カテゴリ**: 正確性
**場所**: 根本原因の仮説 / 対策案 ケースB

**問題**:
Issue の根本原因分析では Pass 1 の `DEFAULT_OPTION_PATTERN` 検索のみが問題箇所として特定されているが、実際には Layer 4 にも同等のブロッキングが存在する。

```typescript
// prompt-detector.ts L344-350
const hasDefaultIndicator = options.some(opt => opt.isDefault);
if (options.length < 2 || !hasDefaultIndicator) {
  return {
    isPrompt: false,
    cleanContent: output.trim(),
  };
}
```

このチェックにより、**仮に Pass 1 を緩和して `\u276F` なしの選択肢を収集できるようにしても**、全ての options が `isDefault: false` となるため、Layer 4 で依然として `isPrompt: false` が返却される。

つまり、ケースB（`\u276F` マーカーなしの選択肢形式）を解決するには、Pass 1 **と** Layer 4 の**両方**の修正が必要であるが、Issue の対策案ではこの点が明示されていない。

**推奨対応**:
1. 根本原因セクションに「Layer 4: `hasDefaultIndicator` チェックも同時に修正が必要」を明記する
2. ケースBの `DetectPromptOptions` interface に `requireDefaultIndicator` パラメータを含める場合、そのパラメータが Pass 1 と Layer 4 の**両方**に影響することを設計で明示する
3. 処理フローの図にLayer 4 のブロッキングポイントを追加する:

```
Pass 1: DEFAULT_OPTION_PATTERN 検索 --> マッチなし --> return false  [*ここだけでなく*]
Pass 2: options 収集
Layer 3: 連番検証
Layer 4: hasDefaultIndicator チェック --> false --> return false  [*ここも*]
```

---

### MF-3: response-poller.ts の ANSI 未ストリップ問題の記述が不正確

**カテゴリ**: 正確性
**場所**: 対策案 Phase 3 response-poller.ts

**問題**:
Issue では「L442とL556ではANSI未ストリップの生出力をdetectPrompt()に渡している」と記載しているが、データフローの分析が不十分である。

実際のデータフロー:

1. **L248** (Claude専用ガード): `stripAnsi()` が適用されている（正しい実装）
2. **L442**: `extractResponse()` 内の `lines` 変数は `output.split('\n')` から生成されており（L197）、ANSI コードが残存している。ただし、このコードパスに到達する条件は以下の通り:
   - Claude の場合: L244-258 のClaude専用早期チェックで prompt 検出に**失敗した**後
   - Codex/Gemini の場合: L244 の `if (cliToolId === 'claude')` をスキップして直接到達
3. **L556**: `result.response` は `extractResponse()` の戻り値。`extractResponse()` 内部の主要レスポンス抽出パス（L462-472）では `lines[i]` をそのまま push しており、ANSI コードが残存する

**推奨対応**:
Issue の記述をデータフローに基づいて正確に修正する:
- L442: 「Claude の場合はL248で先にストリップ済み検出を試み、失敗後にL442に到達する。非Claude CLIツールではL442が最初のプロンプト検出となるため、`stripAnsi()` の追加が必要」
- L556: 「`extractResponse()` の戻り値 `result.response` にはANSIコードが残存する可能性がある。`detectPrompt()` 呼び出し前に `stripAnsi()` を適用する」

---

## Should Fix（推奨対応）

### SF-1: DetectPromptOptions の設計精度不足

**カテゴリ**: 技術的妥当性
**場所**: 対策案 ケースB

**問題**:
ケースBの `DetectPromptOptions` interface で `requireDefaultIndicator` パラメータのみが提案されているが、このパラメータが制御する範囲が不明確である。`detectMultipleChoicePrompt()` には以下の独立したゲートがある:

| ゲート | 位置 | 制御対象 |
|--------|------|----------|
| Pass 1 | L274-288 | `DEFAULT_OPTION_PATTERN` (U+276F) の存在チェック |
| Layer 4 | L344-350 | `options.some(opt => opt.isDefault)` チェック |

`requireDefaultIndicator: false` が Pass 1 のスキップだけを意味するのか、Layer 4 のスキップも含むのかが曖昧である。

**推奨対応**:
`DetectPromptOptions` の設計を以下のように明確化する:

```typescript
interface DetectPromptOptions {
  /**
   * When false, skip both Pass 1 (existence check)
   * and Layer 4 (hasDefaultIndicator validation).
   * Default: true (current behavior)
   */
  requireDefaultIndicator?: boolean;
}
```

---

### SF-2: claude-poller.ts の ANSI 未ストリップをフォローアップではなく本Issue対象に

**カテゴリ**: 完全性
**場所**: 影響範囲 関連コンポーネント（動作確認）

**問題**:
`claude-poller.ts` L164 の ANSI 未ストリップ問題が「フォローアップ候補」として記載されているが、`response-poller.ts` L442 と同一の問題構造を持つ。

```typescript
// claude-poller.ts L47-52: ANSI ストリップなし
const rawLines = output.split('\n');
const lines = rawLines.slice(0, trimmedLength);

// L163-164: ANSI コード残存のまま detectPrompt() に渡される
const fullOutput = lines.join('\n');
const promptDetection = detectPrompt(fullOutput);
```

`response-poller.ts` L442 の修正と同時に `claude-poller.ts` L164 と L232 も修正すべきである。同じ問題を別Issueに分割する合理的理由がない。

**推奨対応**:
`claude-poller.ts` L164 と L232 を変更対象ファイルテーブルに昇格させる。

---

### SF-3: 受入条件のリグレッションテスト要件不足

**カテゴリ**: 明確性
**場所**: 受入条件

**問題**:
「Claude Codeの既存の選択肢検出・応答機能に影響がないこと」は受入条件として記載されているが、検証方法が明確でない。既存テストの多くが `detectPrompt` をモックしているため、パターンマッチのリグレッションは検出できない。

- `tests/unit/api/prompt-response-verification.test.ts` L49-51: `detectPrompt` をモック
- `tests/unit/lib/auto-yes-manager.test.ts` L431: `detectPrompt` をモック

**推奨対応**:
受入条件に以下を追加する:
- 「`tests/unit/prompt-detector.test.ts` の既存 `multiple_choice` テストケースが全てパスすること」
- 「新規テストケースとして、U+276F マーカー付き標準形式の選択肢が引き続き正しく検出されることを確認するリグレッションテストを追加すること」

---

### SF-4: current-output/route.ts のパラメータ伝搬に関する記述不足

**カテゴリ**: 完全性
**場所**: 対策案 Phase 3 current-output/route.ts

**問題**:
`current-output/route.ts` L88 の `detectPrompt()` 呼び出しは thinking ガード内にあり、条件分岐を含む複雑なコードパスとなっている。

```typescript
// L83
const thinking = detectThinkingState(cliToolId, lastSection);
// L88
const promptDetection = thinking
  ? { isPrompt: false, cleanContent: cleanOutput }
  : detectPrompt(cleanOutput);
```

ケースBで `detectPrompt()` のシグネチャを変更する場合、この三項演算子内での options 引数の渡し方に注意が必要である。`cliToolId` は L66 付近で `worktree.cliToolId` から取得済みであることが明記されていない。

**推奨対応**:
Phase 3 の `current-output/route.ts` セクションに `cliToolId` の取得元と thinking ガード内での options 伝搬方法を記載する。

---

## Nice to Have（あれば良い）

### NTH-1: respond/route.ts の動作確認目的の明確化

**カテゴリ**: 完全性
**場所**: 影響範囲 関連コンポーネント（動作確認）

`respond/route.ts` が関連コンポーネントに記載されているが、`detectPrompt()` を呼び出していない。動作確認の目的（メッセージIDベースのプロンプト応答APIとしての整合性確認など）を明記すると理解しやすくなる。

---

### NTH-2: スクリーンショットのテキスト形式解析

**カテゴリ**: 完全性
**場所**: スクリーンショット / 対策案 Phase 1

スクリーンショットは画像のみで、選択肢のテキスト形式（行頭のインデント、番号後のピリオド有無、各行の区切り文字など）が記載されていない。可能であれば画像から読み取れるパターンの特徴を記載することで、Phase 1 の調査効率が向上する。

---

### NTH-3: Issue #161 多層防御との設計整合性

**カテゴリ**: 完全性
**場所**: 対策案 ケースB

ケースBを採用した場合、Issue #161 で確立された多層防御（Layer 1: thinking skip, Layer 2: 2-pass detection, Layer 3: consecutive validation）のうち Layer 2 を緩和することになる。`requireDefaultIndicator: false` の場合に通常の番号付きリストと選択肢プロンプトをどう区別するかの戦略（Layer 1 と Layer 3 だけで十分か）の検討を記載すると、実装時の判断材料になる。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/lib/prompt-detector.ts` | 選択肢検出ロジックの中核（L182, L189, L264-391, L344-350） |
| `src/lib/cli-patterns.ts` | `CLAUDE_CHOICE_INDICATOR_PATTERN` 不在の確認元、`stripAnsi()` 提供元 |
| `src/lib/status-detector.ts` | `STATUS_CHECK_LINE_COUNT=15` の制約（L50, L83, L87） |
| `src/lib/response-poller.ts` | ANSI未ストリップの `detectPrompt()` 呼び出し（L442, L556） |
| `src/lib/claude-poller.ts` | 同上（L164, L232）。フォローアップではなく本Issue対象とすべき |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | `cliToolId` 取得済み（L50）、`detectPrompt()` 呼び出し（L75） |
| `src/app/api/worktrees/[id]/current-output/route.ts` | thinking ガード付き `detectPrompt()` 呼び出し（L88） |
| `src/lib/auto-yes-manager.ts` | `stripAnsi()` 適用済みの正しい実装（L279, L290） |
| `src/lib/auto-yes-resolver.ts` | `isDefault` フラグ依存のauto-answer判定（L23-36） |
| `tests/unit/prompt-detector.test.ts` | 既存 multiple_choice テスト |
| `tests/unit/api/prompt-response-verification.test.ts` | `detectPrompt` モック依存（L49-51） |
| `tests/unit/lib/auto-yes-manager.test.ts` | `detectPrompt` モック依存（L431） |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | Issue #161 の設計原則（2パス検出方式、CLIツール非依存性） |
