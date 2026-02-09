# Issue #208: Auto-Yes 番号付きリスト誤検出防止 設計方針書

## 1. 概要

### 1.1 問題の要約

Auto-Yesモード有効時、Claude CLIの通常出力（サブエージェント完了後等）に含まれる番号付きリスト（例：「1. ファイルを作成」「2. テストを実行」）が `multiple_choice` プロンプトとして誤検出され、"1"が定期的に自動送信される。

### 1.2 根本原因

Issue #193で導入された `requireDefaultIndicator: false` により、Issue #161の主要防御ポイントである Pass 1ゲート（Layer 2: ❯インジケーター存在チェック）が無効化された。その結果、通常の番号付きリストと実際の選択肢プロンプトの区別ができなくなった。

### 1.3 防御層の現状分析

```
detectMultipleChoicePrompt(output, { requireDefaultIndicator: false })
│
├─ Layer 1: thinking検出（auto-yes-manager.ts側）
│  └─ サブエージェント完了後は thinking 状態でないため → 無効
│
├─ Pass 1 (Layer 2): ❯インジケーター存在チェック
│  └─ requireDefaultIndicator: false で → 完全スキップ ← 主要防御崩壊ポイント
│
├─ Pass 2: 番号パターン収集（逆順スキャン）
│  └─ NORMAL_OPTION_PATTERN: /^\s*(\d+)\.\s*(.+)$/ で通常リストもマッチ
│
├─ Layer 3: 連番検証（isConsecutiveFromOne）
│  └─ 通常の番号付きリストも 1,2,3... で → 通過
│
├─ Layer 4: 選択肢数 + ❯チェック
│  └─ requireDefault=false で ❯不要 → 通過
│
└─ Layer 5 (SEC-001): question行存在チェック
   └─ 番号リスト上部にテキスト行がある場合 questionEndIndex >= 0 → 通過
```

---

## 2. アーキテクチャ設計

### 2.1 設計方針: Layer 5（SEC-001）の厳格化

**選択した方針**: Issue本文の「案1: プロンプトと通常出力の構造的な差異を利用」をベースとし、Layer 5の質問行検出条件を厳格化する。

**選択理由**:
1. **既存アーキテクチャとの親和性**: 既存のLayer 5 SEC-001ガード（Issue #193で導入）を拡張する形で実装でき、新規防御層の追加が不要
2. **Issue #193回帰リスク最小**: Claude Codeの実プロンプトは通常question行（`?`や`:`で終わる行）を含むため、question行検出の厳格化は正当なプロンプトには影響しにくい
3. **テスト基盤の再利用**: Issue #193で作成済みのSEC-001テスト群（prompt-detector.test.ts L942-985）を拡張するだけで回帰テストが完成
4. **単一ファイル変更**: 主要変更は `prompt-detector.ts` のみで完結し、呼び出し元の変更が不要

**却下した方針**:
- **案2（追加防御層導入）**: requireDefaultIndicator=false時の新しい判定ロジックは、Claude Codeプロンプトとの互換性が不確実で回帰リスクが中程度
- **案3（出力の文脈判定強化）**: 前後のコンテキスト参照は実装が複雑で、未知の文脈パターンに対応できない

### 2.2 修正対象ファイル

```
src/lib/prompt-detector.ts     ← 主要変更（Layer 5厳格化）
tests/unit/prompt-detector.test.ts  ← テスト追加
```

### 2.3 変更が不要なファイル

以下のファイルは `detectPrompt()` の呼び出し元であるが、修正は不要：
- `src/lib/auto-yes-manager.ts` - 呼び出し引数の変更なし
- `src/lib/status-detector.ts` - 同上
- `src/lib/response-poller.ts` - 同上
- `src/app/api/worktrees/[id]/current-output/route.ts` - 同上
- `src/app/api/worktrees/[id]/prompt-response/route.ts` - 同上
- `src/hooks/useAutoYes.ts` - クライアント側（影響なし）
- `src/lib/cli-patterns.ts` - buildDetectPromptOptions()の変更なし

---

## 3. 詳細設計

### 3.1 Layer 5 厳格化: question行の妥当性検証

**現在の実装** (`prompt-detector.ts:402-411`):

```typescript
// Layer 5 [SEC-001]: questionEndIndex guard for requireDefaultIndicator=false.
if (!requireDefault && questionEndIndex === -1) {
  return { isPrompt: false, cleanContent: output.trim() };
}
```

**修正後の設計**:

```typescript
// Layer 5 [SEC-001]: Enhanced question line validation for requireDefaultIndicator=false.
if (!requireDefault) {
  // SEC-001a: 質問行が存在しない場合は拒否（既存ガード）
  if (questionEndIndex === -1) {
    return { isPrompt: false, cleanContent: output.trim() };
  }

  // SEC-001b: 質問行が実際に質問/選択を求める文であることを検証（新規ガード）
  const questionLine = lines[questionEndIndex]?.trim() ?? '';
  if (!isQuestionLikeLine(questionLine)) {
    return { isPrompt: false, cleanContent: output.trim() };
  }
}
```

**既存コードとの差分の適用方法** (IC-002):

既存コード（L402-411）は以下の形式である:

```typescript
// 既存 (L402-411):
// Layer 5 [SEC-001]: questionEndIndex guard for requireDefaultIndicator=false.
if (!requireDefault && questionEndIndex === -1) {
  return { isPrompt: false, cleanContent: output.trim() };
}
```

この既存コードを上記の修正後コードに**置換**する。具体的な差分:

1. L406の `if (!requireDefault && questionEndIndex === -1)` を `if (!requireDefault)` に変更し、ブロック全体を包含する形にリファクタリングする
2. 既存の `questionEndIndex === -1` 条件は、ブロック内部の SEC-001a として**そのまま維持**する（条件の意味は変わらない）
3. SEC-001a の直後、L414（質問テキスト抽出処理）の前に SEC-001b ガードを**新規挿入**する
4. `if (!requireDefault)` ブロックの閉じ括弧は、SEC-001b の直後に配置する（L414以降の処理はブロック外）

注意: 既存のL406の条件を「内包」する形でリファクタリングするため、単純な行挿入ではなく既存ブロックの構造変更を伴う。

### 3.2 isQuestionLikeLine() 関数の設計

```typescript
/**
 * question行が実際に質問や選択を求める文であるかを検証する。
 * 通常の見出し行（"Recommendations:", "Steps:"等）と
 * 実際の質問文（"Which option?", "Select a mode:"等）を区別する。
 *
 * 制御文字耐性 (SEC-S4-004): line パラメータは lines[questionEndIndex]?.trim() 経由で
 * 渡されるため、tmux capture-pane 出力に含まれる制御文字（stripAnsi() で除去しきれない
 * 8-bit CSI (0x9B) や DEC private modes 等）が残留する可能性がある。
 * ただし、endsWith('?') / endsWith(':') は末尾1文字のみを検査し、
 * QUESTION_KEYWORD_PATTERN.test() は英字キーワードのみにマッチするため、
 * 残留する制御文字はいずれのパターンにもマッチせず false を返す。
 * したがって、制御文字が残留していても安全に動作する（false-safe）。
 *
 * @param line - 検証対象の行（トリム済み）
 * @returns true: 質問/選択を求める文と判定, false: 通常のテキスト行
 */
function isQuestionLikeLine(line: string): boolean {
  // 空行は質問ではない
  if (line.length === 0) return false;

  // Pattern 1: 疑問符で終わる行（日本語・英語の疑問文）
  // 全角疑問符（？）にも対応（防御的措置: Claude Code/CLIの質問は英語表示だが、
  // 将来の多言語対応やサードパーティツール連携を考慮）
  if (line.endsWith('?') || line.endsWith('\uff1f')) return true;

  // Pattern 2: 選択/入力を求めるキーワードを含み、コロンで終わる行
  // 例: "Select an option:", "Choose a mode:", "Pick one:"
  if (line.endsWith(':')) {
    if (QUESTION_KEYWORD_PATTERN.test(line)) return true;
  }

  return false;
}
```

### 3.3 QUESTION_KEYWORD_PATTERN の設計

```typescript
/**
 * 選択・入力を求めるキーワードパターン。
 * CLI ツールが選択肢プロンプトの直前に表示する典型的なフレーズを検出する。
 *
 * キーワード分類:
 *   [観測済み] select, choose, pick, which, what, enter, confirm
 *     - Claude Code / CLI ツールの実プロンプトで使用が確認されたキーワード
 *   [防御的追加] how, where, type, specify, approve, accept, reject, decide, preference, option
 *     - 現時点で実プロンプトでの使用は未確認だが、質問文で一般的に使われる
 *       語彙として防御的に追加。False Negative リスクを低減する意図。
 *     - YAGNI観点ではやや過剰だが、追加による False Positive リスクは
 *       極めて低い（これらのキーワードは通常のリスト見出しに現れにくい）
 *     - 将来的に未使用が確定した場合は削除を検討する
 *
 * ReDoS safe (SEC-S4-002): Alternation-only pattern with no nested quantifiers.
 * 非キャプチャグループ内の OR（alternation）のみで構成されており、
 * バックトラッキングが発生しない線形時間構造（O(n)）である。
 * 既存パターン（DEFAULT_OPTION_PATTERN, NORMAL_OPTION_PATTERN）の
 * 'ReDoS safe (S4-001)' 注釈に準拠。
 */
const QUESTION_KEYWORD_PATTERN = /(?:select|choose|pick|which|what|how|where|enter|type|specify|confirm|approve|accept|reject|decide|preference|option)/i;
```

**設計根拠**:
- Claude Codeが表示する実際の質問文は、選択を求めるキーワード（select, choose, which等）を含む
- 通常の番号付きリストの見出し（"Recommendations:", "Steps:", "Changes:"等）はこれらのキーワードを含まない
- `?`で終わる行は無条件で質問として扱う（言語に依存しない汎用的な判定）
- 防御的追加キーワードはFalse Positiveリスクが極めて低いため、KISS/YAGNI原則との兼ね合いで許容する（レビュー SF-001）

**単語境界なしのトレードオフ** (IC-004):

QUESTION_KEYWORD_PATTERNの正規表現には単語境界（`\b`）を含めていない。これにより、例えば `"Selections:"` という行が `select` に部分一致し、isQuestionLikeLine() が true を返す可能性がある。

- **リスク評価**: 実運用上のリスクは極めて低い。`"Selections:"` のような見出しの後に1始まり連番リストが続くケースは、実際にはプロンプト（選択肢提示）である可能性が高く、false positive ではなく true positive として正しく機能する蓋然性が高い
- **単語境界を追加しない理由**: 単語境界を追加すると、CLIツールが将来 `"Reselect:"` や `"Preselect:"` のような複合語で質問する場合に false negative が発生するリスクがある。部分一致の方が防御的である
- **将来方針**: 実運用で部分一致による明確な false positive が観測された場合に、単語境界の追加を再検討する

### 3.4 既存ロジックとの整合性

#### isContinuationLine() との関係

`isContinuationLine()` (L264-277) 内の `!line.endsWith('?')` 条件により、`?`終端の行はcontinuation lineとして扱われず、question行候補として `questionEndIndex` に設定される。この既存ロジックは本修正と整合する。

#### Pass 2 逆順スキャンとの関係

Pass 2では逆順スキャンで番号付き行以外の最初の非continuation行を `questionEndIndex` に設定する。本修正はその後に `isQuestionLikeLine()` で追加検証するため、Pass 2のロジック変更は不要。

---

## 4. 防御層の再構成

修正後の防御層構造:

```
detectMultipleChoicePrompt(output, { requireDefaultIndicator: false })
│
├─ Layer 1: thinking検出（呼び出し元で実施）
│  └─ 変更なし
│
├─ Pass 1 (Layer 2): ❯インジケーター存在チェック
│  └─ requireDefaultIndicator: false の場合はスキップ（変更なし）
│
├─ Pass 2: 番号パターン収集
│  └─ 変更なし
│
├─ Layer 3: 連番検証
│  └─ 変更なし
│
├─ Layer 4: 選択肢数 + ❯チェック
│  └─ 変更なし
│
└─ Layer 5 (SEC-001): 質問行検証 ← 強化
   ├─ SEC-001a: questionEndIndex === -1 → 拒否（既存）
   └─ SEC-001b: isQuestionLikeLine() === false → 拒否（新規）
       ├─ Pattern 1: ?で終わる行 → 質問として許可
       └─ Pattern 2: 選択キーワード + :で終わる行 → 質問として許可
```

### 4.1 誤検出シナリオの防止

**シナリオ: サブエージェント完了後の番号付きリスト**

```
## Recommendations:
1. 追加のテストカバレッジを追加
2. ドキュメント更新が必要
3. パフォーマンス測定を実施
```

- Pass 2: `questionEndIndex` → "## Recommendations:" の行
- Layer 5 SEC-001b: `isQuestionLikeLine("## Recommendations:")` → false
  - `?`で終わらない
  - `:`で終わるが、QUESTION_KEYWORD_PATTERN にマッチしない
- **結果**: `isPrompt: false` ← 正しく拒否

**シナリオ: Claude Codeの実プロンプト**

```
Which option would you like to select?
1. Create new file
2. Edit existing file
3. Delete file
```

- Pass 2: `questionEndIndex` → "Which option would you like to select?" の行
- Layer 5 SEC-001b: `isQuestionLikeLine("Which option would you like to select?")` → true
  - `?`で終わる
- **結果**: `isPrompt: true` ← 正しく検出

**シナリオ: Claude Codeのコロン形式プロンプト**

```
Select a mode:
1. Development
2. Production
3. Staging
```

- Pass 2: `questionEndIndex` → "Select a mode:" の行
- Layer 5 SEC-001b: `isQuestionLikeLine("Select a mode:")` → true
  - `:`で終わり、QUESTION_KEYWORD_PATTERN の "select" にマッチ
- **結果**: `isPrompt: true` ← 正しく検出

**シナリオ: タスクリスト出力**

```
Completed the following tasks:
1. Created unit tests
2. Updated documentation
3. Fixed linting errors
```

- Pass 2: `questionEndIndex` → "Completed the following tasks:" の行
- Layer 5 SEC-001b: `isQuestionLikeLine("Completed the following tasks:")` → false
  - `?`で終わらない
  - `:`で終わるが、QUESTION_KEYWORD_PATTERN にマッチしない
- **結果**: `isPrompt: false` ← 正しく拒否

**シナリオ: ステップ説明**

```
次のステップを実行しました：
1. ファイルを作成しました
2. テストを実行しました
3. ビルドを確認しました
```

- Pass 2: `questionEndIndex` → "次のステップを実行しました：" の行
- Layer 5 SEC-001b: `isQuestionLikeLine("次のステップを実行しました：")` → false
  - `?`で終わらない
  - 全角コロン `：` は半角 `:` と異なるため、`endsWith(':')` は false
  - QUESTION_KEYWORD_PATTERN にもマッチしない（英語キーワード）
- **結果**: `isPrompt: false` ← 正しく拒否

### 4.2 日本語質問文への対応

日本語の質問文は `?`（または `？`）で終わることが一般的。全角疑問符への対応はセクション3.2の `isQuestionLikeLine()` Pattern 1 に統合済み（`line.endsWith('?') || line.endsWith('\uff1f')`）。

Claude Code/CLIの質問プロンプトは英語で表示されるため、全角疑問符への対応は防御的措置として位置づける（レビュー SF-002 に基づき一箇所に集約）。

---

## 5. 影響パス別の修正効果

### 5.1 パス1: auto-yes-manager.ts（主要誤検出パス）

| 修正前 | 修正後 |
|--------|--------|
| 番号付きリストを multiple_choice として検出 | Layer 5 SEC-001b で質問行を検証し拒否 |
| resolveAutoAnswer() → "1" を tmux に送信 | detectPrompt() → isPrompt: false で終了 |

### 5.2 パス2: response-poller.ts

| 修正前 | 修正後 |
|--------|--------|
| extractResponse() で偽 isComplete: true | detectPrompt() → isPrompt: false |
| checkForResponse() で偽 prompt メッセージ保存 | 偽メッセージ保存されない |

### 5.3 パス3: status-detector.ts

| 修正前 | 修正後 |
|--------|--------|
| 15行ウィンドウ内の番号付きリストで waiting 誤表示 | detectPrompt() → isPrompt: false |

### 5.4 パス4: current-output API + useAutoYes.ts

| 修正前 | 修正後 |
|--------|--------|
| isPromptWaiting: true + 偽 promptData | isPromptWaiting: false |
| クライアント側でも "1" 送信（二重送信） | クライアント側の自動応答なし |

### 5.5 パス5: prompt-response API

| 修正前 | 修正後 |
|--------|--------|
| 偽プロンプト活性確認で不要なキー送信許可 | isPrompt: false で正しく拒否 |

---

## 6. テスト計画

### 6.1 新規テスト: SEC-001b 質問行妥当性検証

**ファイル**: `tests/unit/prompt-detector.test.ts`

#### T1: 通常の番号付きリスト（見出し + リスト）→ isPrompt: false

```
入力:
  "## Recommendations:\n1. Add test coverage\n2. Update docs\n3. Run perf tests"
  options: { requireDefaultIndicator: false }
期待:
  isPrompt: false
```

#### T2: タスク完了リスト → isPrompt: false

```
入力:
  "Completed the following tasks:\n1. Created unit tests\n2. Updated documentation"
  options: { requireDefaultIndicator: false }
期待:
  isPrompt: false
```

#### T3: ステップ説明リスト → isPrompt: false

```
入力:
  "I performed these steps:\n1. Analyzed the code\n2. Fixed the bug\n3. Added tests"
  options: { requireDefaultIndicator: false }
期待:
  isPrompt: false
```

#### T4: マークダウン見出し + 番号リスト → isPrompt: false

```
入力:
  "### Changes Made\n1. Updated config\n2. Added validation\n3. Fixed error handling"
  options: { requireDefaultIndicator: false }
期待:
  isPrompt: false
```

### 6.2 回帰テスト: Claude Code実プロンプト → isPrompt: true

#### T5: 疑問符終端の質問行 + 番号選択肢 → isPrompt: true

```
入力:
  "Which option would you like?\n1. Create new file\n2. Edit existing\n3. Delete"
  options: { requireDefaultIndicator: false }
期待:
  isPrompt: true, type: 'multiple_choice'
```

#### T6: コロン + 選択キーワードの質問行 + 番号選択肢 → isPrompt: true

```
入力:
  "Select an option:\n1. Development\n2. Production\n3. Staging"
  options: { requireDefaultIndicator: false }
期待:
  isPrompt: true, type: 'multiple_choice'
```

#### T7: choose キーワード + コロン → isPrompt: true

```
入力:
  "Choose a mode:\n1. Fast\n2. Normal\n3. Thorough"
  options: { requireDefaultIndicator: false }
期待:
  isPrompt: true, type: 'multiple_choice'
```

#### T8: 既存の SEC-001 テスト維持（質問行なし）→ isPrompt: false

```
入力:
  "1. Option A\n2. Option B\n3. Option C"
  options: { requireDefaultIndicator: false }
期待:
  isPrompt: false（既存SEC-001aガードで拒否）
```

### 6.3 回帰テスト: requireDefaultIndicator=true（デフォルト）

#### T9: ❯付き正常プロンプト → isPrompt: true

```
入力:
  "Select:\n❯ 1. Yes\n  2. No"
  options: undefined（デフォルト）
期待:
  isPrompt: true（既存動作維持）
```

#### T10: ❯なし番号リスト（デフォルト設定）→ isPrompt: false

```
入力:
  "Steps:\n1. First\n2. Second\n3. Third"
  options: undefined（デフォルト）
期待:
  isPrompt: false（Pass 1で拒否、既存動作維持）
```

### 6.4 isQuestionLikeLine() 単体テスト

#### T11: 各パターンの検証

**実装方法に関する注記** (IC-005):

設計上、`isQuestionLikeLine()` はモジュール非公開関数（`function` 宣言、非 `export`）として定義する。そのため、T11のテストは以下のいずれかの方法で実装する:

- **推奨: 間接テスト方式** -- `detectMultipleChoicePrompt()` を経由して各パターンを検証する。各入力値を `"[質問行]\n1. Option A\n2. Option B"` 形式のテスト入力に埋め込み、`options: { requireDefaultIndicator: false }` で呼び出して `isPrompt` の結果で間接的に検証する
- **代替: export方式** -- テスト容易性のために `isQuestionLikeLine()` を `export` する場合は、直接呼び出しでテスト可能。ただし、内部実装の公開はモジュールのカプセル化を弱めるため、間接テスト方式を優先する

以下のパターン検証は、いずれの方式でも網羅すべき項目である:

```
isQuestionLikeLine("Which file?") → true
isQuestionLikeLine("Select an option:") → true
isQuestionLikeLine("Choose a mode:") → true
isQuestionLikeLine("Pick one:") → true
isQuestionLikeLine("What would you like to do?") → true
isQuestionLikeLine("Enter your choice:") → true
isQuestionLikeLine("Confirm deletion:") → true
isQuestionLikeLine("Recommendations:") → false
isQuestionLikeLine("Steps:") → false
isQuestionLikeLine("Changes Made:") → false
isQuestionLikeLine("## Summary") → false
isQuestionLikeLine("Completed tasks:") → false
isQuestionLikeLine("I did the following:") → false
isQuestionLikeLine("") → false
```

### 6.5 エッジケーステスト

#### T12: 全角疑問符 → isPrompt: true

```
入力:
  "どちらを選びますか？\n1. オプションA\n2. オプションB"
  options: { requireDefaultIndicator: false }
期待:
  isPrompt: true
```

#### T13: 長い出力の末尾に番号付きリスト → isPrompt: false

```
入力:
  (500行の通常出力) + "\nResults:\n1. Test passed\n2. Build passed"
  options: { requireDefaultIndicator: false }
期待:
  isPrompt: false
```

#### T14: Bashツール形式（インデント付き選択肢）→ isPrompt: true

このテストは複数条件の連携を検証する (IC-003):
- `isContinuationLine()` (L264-277) の `!line.endsWith('?')` 条件により、`?`終端のインデント付き行 `"  Allow this command?"` はcontinuation lineとして**扱われない**
- その結果、Pass 2逆順スキャンで `questionEndIndex` にこの行が設定される
- SEC-001b の `isQuestionLikeLine("Allow this command?")` は `?`終端のため `true` を返す
- 最終的に `isPrompt: true` が返される

```
入力:
  "  Allow this command?\n  1. Yes\n  2. No"
  options: { requireDefaultIndicator: false }
期待:
  isPrompt: true
検証ポイント:
  isContinuationLine()の?終端除外 → questionEndIndex設定 → SEC-001b通過 の連携
```

### 6.6 オプション: response-poller.ts 経由の統合テスト (IA-002)

**優先度**: オプション（必須ではない）

**背景**: response-poller.ts の `extractResponse()` 内 `detectPromptWithOptions()` パスの間接的な効果を検証する統合テストは T1-T14 のテスト計画には含まれていない。`detectPromptWithOptions()` は `stripAnsi()` + `buildDetectPromptOptions()` + `detectPrompt()` の薄いラッパーであり、`detectPrompt()` 自体が T1-T14 で十分にテスト済みであるため、中間層の統合テストは必須ではない。

**実装する場合の方針**:

```
入力:
  response-poller.ts の extractResponse() に番号付きリスト出力を渡す
  cliToolId: 'claude'
期待:
  isComplete: false（偽 isComplete: true が防止されること）
```

**判断根拠**: prompt-detector.ts の単体テスト（T1-T14）で SEC-001b ガードの動作が十分に検証される。response-poller.ts 経由のテストは、将来リファクタリング時の安全網として価値があるが、初回実装では任意とする。

---

## 7. セキュリティ設計

### 7.1 SEC-001 強化

- **SEC-001a**（既存）: `questionEndIndex === -1` ガード - 質問行がない場合は拒否
- **SEC-001b**（新規）: `isQuestionLikeLine()` ガード - 質問行が質問らしくない場合は拒否

### 7.2 False Positive / False Negative リスク

| リスク | 影響 | 対策 |
|--------|------|------|
| False Positive（通常リストを誤検出） | "1"の自動送信（本バグ） | SEC-001b で質問行妥当性を検証 |
| False Negative（実プロンプトを見逃し） | Auto-Yesが機能しない | `?`終端は無条件許可、選択キーワード+`:`は許可 |

### 7.3 QUESTION_KEYWORD_PATTERN の拡張性

キーワードパターンは `/(?:select|choose|pick|...)/i` 形式で定義するため、将来的にClaude Codeが新しい質問フレーズを使用した場合は、パターンにキーワードを追加するだけで対応可能。

### 7.4 Auto-Yesが送信する値の安全性保証 (SEC-S4-001)

Auto-Yesモードで `resolveAutoAnswer()` が返す値は、以下のいずれかに限定される:

- **`'y'`**: yes/no プロンプトへの自動応答
- **数字文字列** (例: `'1'`): multiple_choice プロンプトへの自動応答（選択肢番号）

これらの値は `sendKeys()` 経由で tmux セッションに送信されるが、いずれも英数字1文字のみであり、tmux コマンドインジェクション（メタキーシーケンス `C-c`, `C-d` 等や特殊文字による意図しない操作）のリスクはない。

**前提の重要性**: 本修正（SEC-001b ガード）は誤検出時の `'1'` 送信を防止するものだが、万が一ガードをすり抜けた場合でも、送信される値自体が安全であるため、tmux セッションへの破壊的影響は発生しない。この安全性は `resolveAutoAnswer()` の実装が上記の値のみを返すことに依存しており、将来 `resolveAutoAnswer()` の戻り値を変更する場合は、この前提の再評価が必要である。

### 7.5 多層防御の全体像 (SEC-S4-003)

SEC-001b がすり抜けた場合のフェイルセーフとして、以下の既存防御層が残留リスクを緩和する:

```
[Auto-Yes 多層防御スタック]

Layer 1: thinking検出（auto-yes-manager.ts）
  └─ thinking状態中はプロンプト検出をスキップ
  └─ 緩和効果: thinking中の偽プロンプト応答を防止

Layer 2 (Pass 1): インジケーター存在チェック
  └─ requireDefaultIndicator=true の場合、最前面に配置
  └─ 緩和効果: Codex/Gemini等のデフォルト設定での誤検出を完全防止

Layer 3: 連番検証（isConsecutiveFromOne）
  └─ 1始まりの連番でない番号付きリストを拒否
  └─ 緩和効果: ランダムな番号リスト（例: "3. foo, 7. bar"）の誤検出を防止

Layer 4: 選択肢数 + インジケーターチェック
  └─ 選択肢が MIN_CHOICES (2) 未満の場合を拒否
  └─ 緩和効果: 単一番号項目の誤検出を防止

Layer 5 (SEC-001a): 質問行存在チェック
  └─ questionEndIndex === -1 の場合を拒否
  └─ 緩和効果: 番号リストのみの出力（質問行なし）の誤検出を防止

Layer 5 (SEC-001b): 質問行妥当性検証 [本修正]
  └─ isQuestionLikeLine() === false の場合を拒否
  └─ 緩和効果: 通常のリスト見出しの誤検出を防止

[既存の追加緩和策]
- Expiry timeout: Auto-Yes応答は一定時間経過後に無効化される
- 重複応答防止: useAutoYes.ts のクライアント側で同一プロンプトへの二重応答を防止
- サーバー側ポーリング間隔: auto-yes-manager.ts のポーリング間隔が連続誤応答の頻度を制限
```

**残留リスク評価**: SEC-001b をすり抜けるためには、質問キーワードを含み `?` または `:` で終わる行の直後に 1 始まり連番リストが続く必要がある。この条件を満たす通常出力パターンは実運用上極めて稀であり、かつ上記の追加緩和策により影響は限定的である。新規の追加対策は不要と判断する。

---

## 8. 設計上の決定事項とトレードオフ

### 8.1 採用した設計

| 決定事項 | 理由 | トレードオフ |
|---------|------|-------------|
| Layer 5のみの修正 | 変更範囲最小化、既存アーキテクチャ維持 | 新規防御層追加より柔軟性が低い |
| isQuestionLikeLine()の導入 | 構造的差異による判定で信頼性が高い | キーワードパターンの保守が必要 |
| `?`終端は無条件許可 | 疑問文は言語に依存しない汎用的なシグナル | 偶然`?`で終わる非質問文があれば誤検出 |
| `:`終端はキーワード検証必須 | "Steps:"等の一般的なラベルと"Select:"等の質問文を区別 | Claude Codeが未知のキーワードで質問する場合は見逃す |

### 8.2 代替案との比較

| 方針 | メリット | デメリット | 選択 |
|------|---------|-----------|------|
| Layer 5厳格化（本案） | 変更範囲最小、回帰リスク低 | キーワードパターン保守 | ✅ 採用 |
| Pass 1復活 | 確実な防御 | Claude Code対応が壊れる | ❌ 却下 |
| 新規防御層追加 | 柔軟 | 複雑性増加、回帰リスク中 | ❌ 却下 |
| 文脈判定強化 | 高精度 | 実装複雑、未知パターン脆弱 | ❌ 却下 |

---

## 9. 実装計画

### 9.1 変更ファイル一覧

| ファイル | 変更内容 | 優先度 |
|---------|---------|--------|
| `src/lib/prompt-detector.ts` | `isQuestionLikeLine()` 関数追加、Layer 5 SEC-001b ガード追加 | P0 |
| `tests/unit/prompt-detector.test.ts` | 新規テスト14件追加 | P0 |

### 9.2 実装手順

1. `isQuestionLikeLine()` 関数と `QUESTION_KEYWORD_PATTERN` 定数を `prompt-detector.ts` に追加
2. Layer 5 SEC-001 ガードに SEC-001b 条件を追加
3. テストケース T1-T14 を追加
4. 既存テスト全パス確認（回帰テスト）
5. TypeScript型チェック・ESLint確認

### 9.3 整合性チェック対象

- **claude-poller.ts** (L166, L236): `detectPrompt()` を `buildDetectPromptOptions()` なしで呼び出し。`requireDefaultIndicator: true`（デフォルト）で動作するため、本修正の影響を受けない。変更不要だが、レガシーコードとして認識しておく。

---

## 10. ドキュメント更新対象

修正完了後に以下のドキュメント更新が必要:

| ドキュメント | 更新内容 |
|------------|---------|
| `CLAUDE.md` | prompt-detector.ts の説明に SEC-001b（質問行妥当性検証）追加 |

---

## 11. 関連Issue

- Issue #161: Auto-Yes誤検出修正（2パス検出方式導入）
- Issue #193: Claude Code選択肢プロンプト対応（`requireDefaultIndicator: false` 導入）
- Issue #188: thinking-indicator false detection
- Issue #138: サーバー側Auto-Yesポーリング
- Issue #198: epic: CLI操作の信頼性改善バッチ

---

## 12. レビューチェックリスト

- [ ] `isQuestionLikeLine()` が通常のリスト見出し（"Steps:", "Recommendations:"等）を拒否すること
- [ ] Claude Codeの実プロンプト（"Select an option:", "Which file?"等）を正しく許可すること
- [ ] requireDefaultIndicator=true（Codex/Gemini）の既存動作に影響がないこと
- [ ] 全テスト（T1-T14）がパスすること
- [ ] 既存の SEC-001 テスト（prompt-detector.test.ts L942-985）がパスすること
- [ ] TypeScript型チェック・ESLintエラーがないこと
- [ ] QUESTION_KEYWORD_PATTERNのキーワード分類コメント（観測済み/防御的追加）が実装に反映されていること（SF-001）
- [ ] `isQuestionLikeLine()` の Pattern 1 に全角疑問符判定が統合されていること（SF-002）
- [ ] `resolveAutoAnswer()` の戻り値の安全性保証がコメントに明記されていること（SEC-S4-001）
- [ ] `QUESTION_KEYWORD_PATTERN` のJSDocに 'ReDoS safe (SEC-S4-002)' 注釈が含まれていること（SEC-S4-002）
- [ ] `isQuestionLikeLine()` のJSDocに制御文字耐性の説明が含まれていること（SEC-S4-004）

---

## 13. レビュー履歴

| Stage | レビュー種別 | 日付 | スコア | ステータス |
|-------|------------|------|--------|-----------|
| Stage 1 | 通常レビュー（設計原則） | 2026-02-09 | 5/5 | approved |
| Stage 2 | 整合性レビュー | 2026-02-09 | 4/5 | conditionally_approved |
| Stage 3 | 影響分析レビュー | 2026-02-09 | 5/5 | approved |
| Stage 4 | セキュリティレビュー | 2026-02-09 | 4/5 | conditionally_approved |

---

## 14. レビュー指摘事項サマリー

### Stage 4: セキュリティレビュー

**Must Fix**:

| ID | カテゴリ | タイトル | 対応内容 | ステータス |
|----|---------|---------|---------|-----------|
| SEC-S4-001 | command_injection | Auto-Yesが送信する値の安全性保証を明記 | セクション7.4に、resolveAutoAnswer()が返す値は 'y' または数字文字列のみであり、tmuxコマンドインジェクションのリスクがないことを明記。将来の戻り値変更時の再評価要件も記載 | 反映済み |

**Should Fix**:

| ID | カテゴリ | タイトル | 対応内容 | ステータス |
|----|---------|---------|---------|-----------|
| SEC-S4-002 | redos | QUESTION_KEYWORD_PATTERNのReDoS安全性を明示 | セクション3.3のJSDocコメントに 'ReDoS safe (SEC-S4-002)' 注釈を追加。Alternation-onlyパターンでバックトラッキングが発生しない線形時間構造であることを文書化 | 反映済み |
| SEC-S4-003 | false_positive_safety | 多層防御の全体像を記載 | セクション7.5に、Layer 1-5の各防御層と既存の緩和策（expiry timeout、重複応答防止、ポーリング間隔）を整理した多層防御スタックの全体像を記載。残留リスク評価も追加 | 反映済み |
| SEC-S4-004 | input_validation | isQuestionLikeLine()の制御文字耐性を明記 | セクション3.2のisQuestionLikeLine()のJSDocに、制御文字が残留していてもendsWith()/QUESTION_KEYWORD_PATTERN.test()が安全に動作する（false-safe）ことを明記 | 反映済み |

**Consider**:

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| SEC-S4-005 | information_disclosure | エラーメッセージにおけるワークツリー情報の露出 | 現時点では対応不要。ローカルツールのためリスクは低い。将来ネットワーク公開対応を行う際に、エラーメッセージの詳細度を見直す |
| SEC-S4-006 | defense_in_depth | isQuestionLikeLine()のキーワードリスト操作による防御回避 | 現在の脅威モデル（ローカル実行、信頼されたCLIツール）では対応不要。攻撃者がtmuxセッション内のCLI出力を制御できる場合、セッション自体が既に侵害されている。脅威モデルの変更時に再評価 |

---

### Stage 3: 影響分析レビュー

**Must Fix**: なし

**Should Fix**:

| ID | カテゴリ | タイトル | 対応内容 | ステータス |
|----|---------|---------|---------|-----------|
| IA-001 | legacy_code | claude-poller.tsの状況確認 | セクション9.3に既に記載済み。claude-poller.ts L166/L236の detectPrompt() は requireDefaultIndicator=true（デフォルト）で動作するため、本修正の影響を受けない。追加アクション不要 | 確認済み（対応不要） |
| IA-002 | test_coverage | response-poller.ts経由の統合テスト不足 | prompt-detector.ts の単体テスト（T1-T14）で十分なカバレッジが得られる。response-poller.ts 経由の統合テストはオプション対応として明記。セクション6.6に追記 | 反映済み |

**Consider**:

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| IA-003 | performance | isQuestionLikeLine()の正規表現評価の追加コスト | パフォーマンス上の懸念なし。QUESTION_KEYWORD_PATTERNは非キャプチャグループのORパターンでバックトラッキングリスクなし。入力は1行（通常50文字以下）で計算量はO(n)。追加の最適化は不要 |
| IA-004 | edge_case | Claude Code trust dialog（Issue #201）との相互作用 | trust dialogはdetectPrompt()の検出対象外であり別のコードパスで処理される。本修正との相互作用はないと判断。現時点で対応不要 |

---

### Stage 2: 整合性レビュー

**Must Fix**:

| ID | カテゴリ | タイトル | 対応内容 | ステータス |
|----|---------|---------|---------|-----------|
| IC-001 | code_reference | 行番号参照の確認 | 設計書の行番号参照は現在のコードベースと整合性があることが確認された。実装着手時に再確認が必要 | 確認済み（対応不要） |
| IC-002 | cross_section | SEC-001bガードの挿入位置を明確化 | セクション3.1に既存コード（L402-411）との差分適用方法を明示。既存条件を内包するリファクタリング形式であることを記載 | 反映済み |

**Should Fix**:

| ID | カテゴリ | タイトル | 対応内容 | ステータス |
|----|---------|---------|---------|-----------|
| IC-003 | test_coverage | T14のisContinuationLine()連携を明示 | T14テスト説明に、isContinuationLine()の?終端除外ロジックとの連携フロー（除外 -> questionEndIndex設定 -> SEC-001b通過）を明記 | 反映済み |
| IC-004 | cross_section | QUESTION_KEYWORD_PATTERNの単語境界なしのトレードオフ | セクション3.3に単語境界なしのリスク評価・理由・将来方針を追記 | 反映済み |
| IC-005 | consistency | T11のisQuestionLikeLine()直接テスト実装方法を明確化 | T11テスト説明に、モジュール非公開関数のテスト方法（推奨: 間接テスト方式、代替: export方式）を記載 | 反映済み |
| IC-006 | related_issue | Issue #161設計書との整合性確認 | Layer 1-5の番号体系とセマンティクスの整合性が確認された | 確認済み（対応不要） |
| IC-007 | related_issue | Issue #193設計書のSEC-001ガードとの整合性 | SEC-001a維持 + SEC-001b追加の構造がIssue #193と正しく依存関係を保持していることが確認された | 確認済み（対応不要） |

**Consider**:

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| IC-008 | edge_case | 全角コロン非対応の意図をコメントに反映 | 実装時にisQuestionLikeLine()のコメントに全角コロンは意図的に非対応である旨を記載することを検討 |
| IC-009 | test_coverage | requireDefaultIndicator=true時のSEC-001bスキップ検証 | T9-T10で間接的にカバー済み。将来のリファクタリング時の安全網として明示テスト追加を検討 |

---

### Stage 1: 通常レビュー

**Must Fix**: なし

**Should Fix**:

| ID | カテゴリ | タイトル | 対応内容 | ステータス |
|----|---------|---------|---------|-----------|
| SF-001 | KISS | QUESTION_KEYWORD_PATTERNのキーワード数が多い | セクション3.3のJSDocコメントにキーワードを「観測済み」と「防御的追加」に分類し、各グループの意図と将来方針を明記 | 反映済み |
| SF-002 | DRY | 全角疑問符判定の分離記述 | セクション3.2の `isQuestionLikeLine()` Pattern 1 に全角疑問符判定を統合し、セクション4.2は参照のみに変更 | 反映済み |

**Consider**:

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| C-001 | OCP | QUESTION_KEYWORD_PATTERNの拡張メカニズム | 現時点では不要。将来CLIツール別キーワードが必要になった場合にDetectPromptOptions拡張を検討 |
| C-002 | KISS | endsWith(':')判定と全角コロン | YAGNI原則に従い現時点では対応不要。将来の観測に基づいて判断 |

---

## 15. 実装チェックリスト（レビュー指摘反映分）

### SF-001: QUESTION_KEYWORD_PATTERNのキーワード分類コメント

- [ ] `prompt-detector.ts` の `QUESTION_KEYWORD_PATTERN` 定数のJSDocに、キーワードを以下の2グループに分類するコメントを記載する
  - **観測済み**: `select`, `choose`, `pick`, `which`, `what`, `enter`, `confirm`
  - **防御的追加**: `how`, `where`, `type`, `specify`, `approve`, `accept`, `reject`, `decide`, `preference`, `option`
- [ ] 防御的追加キーワードについて、追加理由（False Negative低減）と将来方針（未使用確定時に削除検討）をコメントに含める

### SF-002: 全角疑問符判定の統合

- [ ] `isQuestionLikeLine()` の Pattern 1 を `line.endsWith('?') || line.endsWith('\uff1f')` に変更する
- [ ] セクション4.2に相当する実装箇所では、重複した全角疑問符判定を追加しない（Pattern 1 に統合済みであることを確認）

### IC-002: SEC-001bガードの挿入位置の明確化

- [ ] 既存の `if (!requireDefault && questionEndIndex === -1)` (L406) を `if (!requireDefault)` ブロックにリファクタリングする
- [ ] SEC-001a (`questionEndIndex === -1` チェック) をブロック内部の最初の条件として維持する
- [ ] SEC-001b (`isQuestionLikeLine()` チェック) をSEC-001aの直後、L414（質問テキスト抽出処理）の前に挿入する
- [ ] `if (!requireDefault)` ブロックの閉じ括弧をSEC-001bの直後に配置する

### IC-003: T14テストのisContinuationLine()連携検証

- [ ] T14のテストコメントに、`isContinuationLine()` の `?`終端除外ロジックとの連携フローを記載する
- [ ] テスト内容: インデント付き `?`終端行がcontinuation lineとして扱われず、`questionEndIndex` に設定されることを間接的に検証する

### IC-004: QUESTION_KEYWORD_PATTERNの単語境界トレードオフ

- [ ] `QUESTION_KEYWORD_PATTERN` のJSDocコメントに、単語境界なしの設計判断とその理由を記載する
- [ ] 部分一致による false positive リスクが実運用上極めて低いことをコメントに含める

### IC-005: T11のテスト実装方法

- [ ] `isQuestionLikeLine()` を非公開関数として実装した場合、T11は `detectMultipleChoicePrompt()` 経由の間接テストとして実装する
- [ ] 各パターン（true/false双方）を `"[質問行]\n1. Option A\n2. Option B"` 形式の入力で網羅する

### IA-002: response-poller.ts 経由の統合テスト（オプション）

- [ ] **オプション**: response-poller.ts の `extractResponse()` に番号付きリスト出力を渡し、`isComplete: false` が返されることを検証する統合テストの追加を検討する
- [ ] 実装する場合は `cliToolId: 'claude'` でテストし、`detectPromptWithOptions()` 経由のパスをカバーする
- [ ] **判断基準**: prompt-detector.ts の単体テスト（T1-T14）で SEC-001b ガードの動作が十分に検証されるため、初回実装では任意。将来のリファクタリング時の安全網として価値がある

### SEC-S4-001: resolveAutoAnswer()の安全性保証（セキュリティ設計）

- [ ] `resolveAutoAnswer()` の戻り値が `'y'` または数字文字列のみであることを、当該関数のJSDocコメントまたは関数内コメントに明記する
- [ ] tmux `sendKeys()` に渡される値がコマンドインジェクションのリスクがないことをコメントに明記する
- [ ] 将来 `resolveAutoAnswer()` の戻り値を変更する場合に、この安全性前提の再評価が必要であることをコメントに含める

### SEC-S4-002: QUESTION_KEYWORD_PATTERNのReDoS安全性注釈

- [ ] `QUESTION_KEYWORD_PATTERN` のJSDocコメントに `ReDoS safe (SEC-S4-002)` 注釈を追加する
- [ ] Alternation-onlyパターンでバックトラッキングが発生しない線形時間構造（O(n)）であることを明記する
- [ ] 既存パターン（DEFAULT_OPTION_PATTERN, NORMAL_OPTION_PATTERN）の 'ReDoS safe (S4-001)' 注釈と命名規約を統一する

### SEC-S4-003: 多層防御の全体像の文書化

- [ ] セキュリティ設計セクションに、Layer 1-5 の各防御層の役割と緩和効果を整理して記載する
- [ ] 既存の追加緩和策（expiry timeout、重複応答防止、ポーリング間隔制限）を明記する
- [ ] SEC-001b をすり抜けた場合の残留リスク評価を記載する

### SEC-S4-004: isQuestionLikeLine()の制御文字耐性の明記

- [ ] `isQuestionLikeLine()` のJSDocコメントに、制御文字が残留していても安全に動作することを明記する
- [ ] `endsWith('?')` / `endsWith(':')` は末尾1文字のみ検査するため、制御文字がマッチしないことを説明する
- [ ] `QUESTION_KEYWORD_PATTERN.test()` は英字キーワードのみにマッチするため、制御文字に対して false を返す（false-safe）ことを明記する
