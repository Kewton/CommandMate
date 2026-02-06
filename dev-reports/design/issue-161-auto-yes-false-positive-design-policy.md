# 設計方針書: Issue #161 Auto-Yes誤検出修正

## 1. 概要

### 1.1 問題

Auto-Yesモード有効時、Claude CLIの通常出力に含まれる番号付きリスト（例：「1. ファイルを作成」「2. テストを実行」）が`detectMultipleChoicePrompt`関数で誤ってmultiple_choiceプロンプトとして検出され、「1」が自動送信される。

> **[S2-009] ユーザー影響**: Auto-Yesモード有効時に誤検出が発生すると、Claude CLIの選択肢プロンプトでない番号付きリスト出力に対して「1」が自動送信される。これによりClaude CLIが意図しない入力を受け取り、予期しない動作（選択肢1が選択される等）が発生する可能性がある。ユーザーの作業フローが中断され、手動での復旧が必要になる場合がある。

### 1.2 根本原因

`prompt-detector.ts`の`detectMultipleChoicePrompt`関数（L198）のパターンマッチが緩すぎる：

```typescript
const optionPattern = /^\s*([❯ ]\s*)?(\d+)\.\s*(.+)$/;
```

**問題点**:
1. `[❯ ]`の文字クラスが❯だけでなく**空白文字1つ**も許容する。これにより通常の番号付きリスト行が選択肢行として`options`配列に追加される。L212の`includes('❯')`によりhasDefault=trueにはならないが、options配列に不要な行が蓄積される問題がある（詳細はSection 3.1参照）
2. 連番検証なし -> 散発的な番号（1, 5, 10等）でもマッチ
3. thinking状態の判定なし -> CLI処理中の出力でも検出が発動

> **[S2-010] 注記**: 設計書内の行番号（L198, L212等）は執筆時点のソースコードを参照している。実装着手時に行番号を再確認すること。重要な参照には行番号に加えて関数名やパターン文字列も併記している。

### 1.3 対策方針

Issueの3つの対策案を**組み合わせ**て実装する：

| # | 対策 | 効果 | 優先度 |
|---|------|------|--------|
| 案1 | ❯インジケーター検出の厳格化（2パス検出方式） | ❯未検出時はnormalOptionPatternを適用せず、通常の番号付きリストがoptions配列に入るのを完全に排除 | Must |
| 案2 | thinking状態での検出スキップ（呼び出し元で実施） | CLI処理中の誤検出を排除 | Must |
| 案3 | 連番検証の追加 | 散発的な番号付きリストの誤検出を排除 | Should（防御的措置） |

> **[S1-005] 注記**: 案3の連番検証はMustからShould（防御的措置）に変更。理由：Issue #161で報告されている実際の誤検出パターン「1. ファイルを作成\n2. テストを実行」は1始まりの連番であるため、この検証だけでは防止できない。案1（❯厳格化）+ 案2（thinking判定）の2層で実際の問題は防止される。連番検証は将来の未知の誤検出パターンに対する防御的措置として追加する。

---

## 2. 変更対象ファイル

| ファイル | 変更内容 | 変更規模 |
|---------|----------|----------|
| `src/lib/prompt-detector.ts` | パターン厳格化（2パス検出方式）、連番検証（防御的） | 中 |
| `src/lib/auto-yes-manager.ts` | thinking判定の事前チェック追加 | 小 |
| `src/lib/status-detector.ts` | detectPrompt前のthinkingチェック追加（必要に応じて） | 小 |
| `tests/unit/prompt-detector.test.ts` | 誤検出防止・回帰テスト追加 | 中 |
| `tests/unit/lib/auto-yes-resolver.test.ts` | 回帰テスト確認 | 小 |
| `tests/unit/lib/auto-yes-manager.test.ts` | thinking中のpollAutoYesスキップテスト追加 | 小 |

> **[S1-001/S1-002] 変更**: prompt-detector.tsからthinking判定を削除。thinking判定はauto-yes-manager.ts側のみで実施する。これによりprompt-detector.tsのCLIツール非依存性を維持する。
> **[S2-003] 追加**: status-detector.tsを条件付き変更対象として追加。Section 7.1で指摘されたdetectPrompt()とdetectThinking()の実行順序問題への対応のため。
> **[S2-006] 追加**: tests/unit/lib/auto-yes-manager.test.tsを変更対象として追加。Section 5.3テスト#1およびSection 5.4のthinkingスキップテストの実装先。

---

## 3. 詳細設計

### 3.1 案1: ❯インジケーター検出の厳格化（prompt-detector.ts） -- 2パス検出方式

> **[S2-001] 設計変更**: 当初の各行独立マッチ方式から2パス検出方式に変更。normalOptionPatternを❯インジケーターのコンテキスト確認なしに全行に適用すると、通常の番号付きリスト行がoptions配列に蓄積される問題を解決できない。2パス方式により、❯付き行が存在する場合のみnormalOptionPatternを適用し、誤検出を根本的に防止する。

#### 現在のコード（L198）

```typescript
const optionPattern = /^\s*([❯ ]\s*)?(\d+)\.\s*(.+)$/;
```

#### 問題の詳細

`[❯ ]`は文字クラスで、❯（U+276F）または半角スペース（U+0020）の**1文字**にマッチする。

> **[S1-004] 補足: hasDefault判定の実態**
>
> L212の既存コード `const hasDefault = Boolean(match[1] && match[1].includes('❯'));` により、match[1]が空白1文字のみの場合は`includes('❯')`がfalseを返すため、**hasDefault=trueにはならない**。つまり「空白1文字が❯と同じ扱いになってisDefault=trueになる」という問題は、hasDefault判定レベルでは既に防がれている。
>
> **実際の問題**: `[❯ ]`パターンの真の問題は、通常の番号付きリスト行（例：`  1. ファイルを作成`）が**選択肢行として`options`配列に追加されてしまう**ことにある。空白1文字でもキャプチャグループがマッチするため、これらの行はoptionPatternにマッチし、isDefault=falseの選択肢としてoptions配列に蓄積される。その結果、出力の別の場所に❯文字が含まれている場合（例：プロンプト文字`❯`）、options配列の蓄積とhasDefaultIndicatorの組み合わせでFalse Positiveが発生しうる。

#### 修正方針 -- 2パス検出方式

❯インジケーターの検出を分離し、2パスで選択肢行を収集する：

```typescript
// ❯付きの選択肢行パターン（デフォルト選択肢）
const defaultOptionPattern = /^\s*❯\s*(\d+)\.\s*(.+)$/;
// 通常の選択肢行パターン（❯なし、先頭の空白のみ）
const normalOptionPattern = /^\s*(\d+)\.\s*(.+)$/;
```

**2パス検出ロジック**:

**パス1（❯インジケーター存在確認）**: 50行ウィンドウ内の全行をスキャンし、`defaultOptionPattern`にマッチする行が**少なくとも1行**存在するかを確認する。❯インジケーターが1行も見つからなければ、即座に`isPrompt: false`を返す。

**パス2（選択肢行収集）**: パス1で❯インジケーターが確認された場合のみ実行する。全行を再スキャンし、以下の順でマッチを試みて選択肢行を収集する：
1. `defaultOptionPattern`でマッチを試みる -> マッチしたらisDefault=true
2. マッチしなければ`normalOptionPattern`でマッチを試みる -> isDefault=false
3. どちらもマッチしなければ選択肢行ではない

> **[S2-001] 設計判断**: 2パス方式により、normalOptionPatternは**❯付き行が確認されたコンテキスト内でのみ**適用される。これにより、通常の番号付きリスト（❯が一切含まれない出力）がoptions配列に蓄積されることを完全に防止する。パス1は軽量な存在チェックのみであり、パフォーマンスへの影響は軽微である。

### 3.2 案2: thinking状態での検出スキップ（auto-yes-manager.tsのみ）

> **[S1-001/S1-002] 設計変更**: thinking判定はauto-yes-manager.ts側のdetectThinking()呼び出しのみに集約する。prompt-detector.ts内ではthinking判定を行わない。

#### 設計判断の根拠

- **SRP維持**: prompt-detector.tsはプロンプトパターンの検出に責務を限定する。thinking状態の判定は呼び出し元の責務である。
- **OCP維持**: prompt-detector.tsはCLIツール非依存の汎用モジュールである。CLAUDE_THINKING_PATTERNのようなClaude CLI固有パターンをimportすると、新しいCLIツール（Codex, Gemini等）のthinkingパターン追加時にprompt-detector.tsの修正が必要になる。
- **DRY維持**: 既にdetectThinking()がCLIツール別の分岐を適切に行っている。prompt-detector.ts内で別のthinking判定を追加すると、同じ概念の判定が2つの異なる実装で共存することになる。
- **影響範囲の限定**: auto-yes-manager.ts以外の呼び出し元（response-poller.ts, claude-poller.ts, status-detector.ts）は既に独自のthinking判定を行っているため、prompt-detector.ts内での重複は不要。

#### auto-yes-manager.tsの変更

`pollAutoYes`関数内で、`detectPrompt`呼び出し前に`detectThinking`チェックを追加する。これにより、thinking中の不要なprompt検出処理をスキップし、パフォーマンスと正確性の両方を向上させる。

> **[S2-004] 注記**: auto-yes-manager.tsのL17では既に`import { stripAnsi } from './cli-patterns';`がimport済みである。そのため、変更は既存import文への`detectThinking`の追加のみとなる。

```typescript
// 変更前（L17）: import { stripAnsi } from './cli-patterns';
// 変更後: import { stripAnsi, detectThinking } from './cli-patterns';

async function pollAutoYes(worktreeId: string, cliToolId: CLIToolType): Promise<void> {
  // ... 既存のチェック

  try {
    const output = await captureSessionOutput(worktreeId, cliToolId, 5000);
    const cleanOutput = stripAnsi(output);

    // thinking状態ならprompt検出をスキップ
    if (detectThinking(cliToolId, cleanOutput)) {
      scheduleNextPoll(worktreeId, cliToolId);
      return;
    }

    const promptDetection = detectPrompt(cleanOutput);
    // ... 既存ロジック
  }
}
```

### 3.3 案3: 連番検証の追加（prompt-detector.ts） -- 防御的措置

> **[S1-005] 優先度変更**: MustからShould（防御的措置）に変更。実際のIssue #161の誤検出パターン「1. ファイルを作成\n2. テストを実行」は1始まりの連番であるため、この検証単体では防止できない。案1 + 案2の2層で実際の問題は解決される。連番検証は将来の未知の誤検出パターン（散発的な番号によるマッチ等）に対する防御的措置として実装する。

#### 検証ロジック

検出した選択肢番号が**1から始まる連番**であることを検証する。

```typescript
/**
 * 防御的チェック: 将来の未知の誤検出パターン対策
 * 注意: Issue #161の実際の誤検出パターンは1始まり連番のため、
 * この検証単体では防止できない。案1(❯厳格化) + 案2(thinking判定)が主要な防御層。
 *
 * [S3-010] この検証は Claude CLI が常に1始まり連番を使用する前提に基づく。
 * 将来、Claude CLI がコンテキストに応じて選択肢をフィルタリングし、
 * 非連番（例: 1, 2, 4）を出力するケースが観測された場合、
 * この検証の緩和（例: 1始まりのみチェック、連番要件を削除）を検討すること。
 */
function isConsecutiveFromOne(numbers: number[]): boolean {
  if (numbers.length === 0) return false;
  if (numbers[0] !== 1) return false;
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] !== numbers[i - 1] + 1) return false;
  }
  return true;
}
```

**適用場所**: 選択肢収集後、`options.length < 2 || !hasDefaultIndicator`チェックの前（既存コードL241の`hasDefaultIndicator`定義の前）に連番検証を追加。

> **[S2-007] 注記**: 設計書のコード例で使用する変数名`hasDefaultIndicator`は既存コードL242で定義されている変数名と一致する。

```typescript
// 連番検証（防御的措置）
const optionNumbers = options.map(opt => opt.number);
if (!isConsecutiveFromOne(optionNumbers)) {
  return { isPrompt: false, cleanContent: output.trim() };
}

// 既存チェック（❯インジケーター必須）
const hasDefaultIndicator = options.some(opt => opt.isDefault);
if (options.length < 2 || !hasDefaultIndicator) {
  return { isPrompt: false, cleanContent: output.trim() };
}
```

---

## 4. 多層防御の全体像

> **[S1-001/S1-002] 更新**: Layer 1のthinking状態チェックは呼び出し元（auto-yes-manager.ts等）で実施する。prompt-detector.ts内部には含めない。
> **[S2-001] 更新**: Layer 2の説明を2パス検出方式に更新。❯インジケーターが存在しない場合、normalOptionPatternは一切適用されないため、通常の番号付きリストがoptions配列に入ることを完全に防止する。

```
Claude CLI出力
    |
[Layer 1] thinking状態チェック (案2) -- 呼び出し元で実施
    |     auto-yes-manager.ts: detectThinking() による事前チェック
    |     status-detector.ts: 独自のdetectThinking()
    |       注: 現状はdetectPrompt() (L80)がdetectThinking() (L91)より先に
    |       実行されるため、thinking中のmultiple_choice誤検出時にLayer 1を
    |       バイパスする可能性あり。Step 5で実行順序の対応を検討する。
    |     response-poller.ts / claude-poller.ts: 独自のthinking判定
    | (thinking中はdetectPrompt()をスキップ)
    v
[Layer 2] 2パス❯インジケーター検出 (案1) -- prompt-detector.ts内
    | パス1: 50行ウィンドウ全行でdefaultOptionPattern(❯付き)をスキャン
    |   -> ❯付き行が0件ならば即座にisPrompt: false（normalOptionPatternは適用しない）
    | パス2: ❯付き行が存在する場合のみ、全行を再スキャンして選択肢を収集
    |   -> defaultOptionPattern (isDefault=true) + normalOptionPattern (isDefault=false)
    v
[Layer 3] 連番検証 (案3、防御的措置) -- prompt-detector.ts内
    | (非連番はスキップ)
    v
[Layer 4] 既存チェック (options >= 2 && hasDefault) -- prompt-detector.ts内
    |
    v
検出結果 -> resolveAutoAnswer -> 応答送信
```

**設計ポイント**: Layer 1は各呼び出し元の責務として実装する。これによりprompt-detector.tsはCLIツール非依存を維持し、Layer 2-4の純粋なパターン検出に専念する。Layer 2の2パス方式により、❯インジケーターが存在しない出力ではnormalOptionPatternが適用されないため、通常の番号付きリストがoptions配列に蓄積されることを根本的に防止する。

---

## 5. テスト計画

### 5.1 誤検出防止テスト（新規追加）

| # | テストケース | 入力例 | 期待結果 | 保護する防御層 |
|---|-------------|--------|----------|---------------|
| 1 | 通常の番号付きリスト | `1. ファイルを作成\n2. テストを実行` | `isPrompt: false` | Layer 2（2パス方式: パス1で❯未検出のため即座にfalse） |
| 2 | ❯なしの番号付きリスト | `  1. Yes\n  2. No` | `isPrompt: false` | Layer 2（2パス方式: パス1で❯未検出のため、normalOptionPatternは適用されずoptions配列は空のまま） |
| 3 | 非連番リスト | `❯ 1. Option A\n  3. Option B` | `isPrompt: false` | Layer 3（連番検証） |
| 4 | 1始まりでないリスト | `❯ 2. Option A\n  3. Option B` | `isPrompt: false` | Layer 3（連番検証） |
| 5 | thinking中の番号付き出力 | `✻ Analyzing...\n1. Step one\n2. Step two` | `isPrompt: false`（auto-yes-manager側テスト） | Layer 1（thinkingチェック） |
| 6 | CLIのステップ説明 | `I'll do the following:\n1. Create file\n2. Run tests\n3. Commit` | `isPrompt: false` | Layer 2（2パス方式: ❯未検出） |
| 7 | **[S3-003]** プロンプト行の❯と番号付きリストの共存 | `❯ /work-plan\n\nI will do the following:\n1. Create file\n2. Run tests` | `isPrompt: false` | Layer 2（2パス方式: ❯を含む行はdefaultOptionPattern `^\s*❯\s*(\d+)\.\s*(.+)$` にマッチしない。`❯ /work-plan`は❯の後に数字.ではなく`/work-plan`が続くためマッチせず、パス1で❯付き選択肢行が0件となる） |

> **[S2-005] 注記**: テストケース#2は、S2-001の2パス検出方式の採用により、Layer 2レベルで保護される。パス1で❯インジケーターが検出されないため、normalOptionPatternは一切適用されず、options配列は空のままとなる。

### 5.2 正常検出回帰テスト（既存確認 + 追加）

| # | テストケース | 入力例 | 期待結果 |
|---|-------------|--------|----------|
| 1 | 有効な❯付きmultiple_choice | `❯ 1. Yes\n  2. No` | `isPrompt: true`, `type: 'multiple_choice'` |
| 2 | 連番+❯の3択 | `❯ 1. Yes\n  2. No\n  3. Cancel` | `isPrompt: true`, options.length=3 |
| 3 | requiresTextInputフラグ | `❯ 1. Yes\n  2. Tell me differently` | `options[1].requiresTextInput: true` |
| 4 | yes/noパターン | `Proceed? (y/n)` | `isPrompt: true`, `type: 'yes_no'` |
| 5 | Approveパターン | `Approve?` | `isPrompt: true`, `type: 'yes_no'` |
| 6 | [Y/n]パターン | `Continue? [Y/n]` | `isPrompt: true`, `defaultOption: 'yes'` |

### 5.3 防御層境界テスト（新規追加）

> **[S1-007] 追加**: 各防御層が独立して機能することを検証する境界テスト
> **[S2-006] 注記**: テスト#1はauto-yes-manager.tsの単体テスト（`tests/unit/lib/auto-yes-manager.test.ts`）として実装する。Section 5.4の「thinking中にpollAutoYesがprompt検出をスキップすること」と同一テストケースである。

| # | テストケース | 期待する停止層 | 説明 | 実装先 |
|---|-------------|---------------|------|--------|
| 1 | thinking中 + ❯付き連番選択肢 | Layer 1（呼び出し元） | thinking判定で検出をスキップ | `tests/unit/lib/auto-yes-manager.test.ts` |
| 2 | thinking中でない + ❯なし番号付きリスト | Layer 2 | 2パス方式でパス1の❯存在チェックにより選択肢として認識されない | `tests/unit/prompt-detector.test.ts` |
| 3 | thinking中でない + ❯あり + 非連番（1, 3, 5） | Layer 3 | 連番検証で排除 | `tests/unit/prompt-detector.test.ts` |
| 4 | thinking中でない + ❯あり + 連番 + 選択肢1個のみ | Layer 4 | options.length < 2 で排除 | `tests/unit/prompt-detector.test.ts` |
| 5 | thinking中でない + ❯あり + 連番 + 2個以上 | 全層パス | 正常なmultiple_choiceとして検出 | `tests/unit/prompt-detector.test.ts` |

### 5.4 50行ウィンドウ境界条件テスト（新規追加）

> **[S3-007]** 2パス検出方式が依存する50行スキャンウィンドウの境界条件を検証するテスト

| # | テストケース | 入力 | 期待結果 | 説明 |
|---|-------------|------|----------|------|
| 1 | ❯行がウィンドウの先頭（50行目）に位置する | 49行の通常テキスト + `❯ 1. Yes\n  2. No`（❯行が末尾から50行目） | `isPrompt: true` | ❯行がスキャンウィンドウのぎりぎり境界内にある場合に正常検出されることを確認 |
| 2 | ❯行がウィンドウ外（51行目以降）に位置する | 50行の通常テキスト + `❯ 1. Yes`の後に`  2. No`（❯行がウィンドウ外） | `isPrompt: false` | ❯行がスキャンウィンドウ外にスクロールアウトした場合、False Positiveが発生しないことを確認 |
| 3 | 回答済みの古いプロンプト + 新しい番号付きリスト | `❯ 1. Yes\n  2. No\n[回答済み出力40行]\n1. Step one\n2. Step two` | ウィンドウ内に❯行と番号付きリストが共存する場合の挙動確認（既存のoptions.length >= 2 && hasDefault検証に依存） | 古いプロンプトの❯が残存する場合のエッジケース |

> **注記**: 50行ウィンドウサイズは既存の`detectMultipleChoicePrompt()`で使用されている値を踏襲する。2パス方式はウィンドウの意味を「選択肢スキャン」から「❯存在確認 + 選択肢スキャン」に変更するが、ウィンドウサイズ自体は変更しない。パス1（❯存在チェック）のウィンドウを縮小することで古いプロンプトデータの干渉を軽減できる可能性があるが、これは実際の問題が報告された場合の将来最適化とする。

### 5.5 auto-yes-manager回帰テスト（旧5.4）

- 既存の`tests/unit/lib/auto-yes-resolver.test.ts`が全テストパスすること
- **[S2-006]** thinking中にpollAutoYesがprompt検出をスキップすること（Section 5.3テスト#1と同一テストケース。`tests/unit/lib/auto-yes-manager.test.ts`に実装する）

---

## 6. 破壊的変更のリスク分析

### 6.1 False Negative増加リスク

| 変更 | リスク | 緩和策 |
|------|--------|--------|
| ❯厳格化（2パス方式） | ❯なしの正規選択肢プロンプトが検出されなくなる | ❯は必須要件として維持（既存の条件と同じ）。2パス方式は❯の存在を前提条件にするだけであり、❯が存在する場合の検出ロジックは変わらない |
| 連番検証 | Claude CLIが非連番選択肢を出す場合に検出漏れ | Claude CLIは常に1始まり連番を使用（仕様確認済み）。防御的措置のため影響は限定的 |
| thinking判定 | thinkingパターン未カバーの状態で誤判定 | 既存のdetectThinking()を使用（実績あり）。呼び出し元での実施のため、CLIツール別の適切な分岐が可能 |

> **[S3-006] Claude CLI出力形式変更への依存リスク**: 2パス検出方式は、Claude CLIの選択肢インジケーターとして❯（U+276F）文字を前提としている。過去にClaude CLIのプロンプト文字が`>`から`❯`（U+276F）に変更された実績があり、選択肢インジケーターの形式も将来変更される可能性がある。インジケーター文字が変更された場合、defaultOptionPatternがマッチしなくなり、全ての正規multiple_choiceプロンプトがFalse Negativeとなる。
>
> **緩和策**:
> - defaultOptionPatternの❯文字をcli-patterns.tsの名前付き定数として抽出し、将来の更新を容易にすることを推奨する
> - 実際のClaude CLI出力に対する統合レベルのスモークテストを追加し、CLI形式変更時の早期警告とすることを推奨する
> - これらの対応はIssue #161のコアスコープ外であり、別Issueでのフォローアップを推奨する

### 6.2 サーバー・クライアント間の重複応答防止メカニズムへの影響

> **[S3-002]** 現在のアーキテクチャでは、サーバー側ポーリング（auto-yes-manager.tsのpollAutoYes()）とクライアント側フック（useAutoYes.ts）の両方がプロンプトに応答する能力を持つ。重複応答防止は`lastServerResponseTimestamp`と3秒のウィンドウ（`DUPLICATE_PREVENTION_WINDOW_MS`）に依存している。
>
> **本変更の影響**: Issue #161の変更（2パス検出方式、thinkingガード、連番検証）はFalse Positiveの削減のみを目的としており、既存の3秒重複防止ウィンドウのメカニズムには一切影響しない。具体的には：
> - detectPrompt()の戻り値の型・構造は変更されない
> - auto-yes-manager.tsのresponseTimestamp記録ロジックは変更されない
> - useAutoYes.tsのDUPLICATE_PREVENTION_WINDOW_MSチェックは変更されない
>
> 3秒ウィンドウの妥当性については、本変更のスコープ外である。より堅牢な重複防止メカニズム（例：プロンプトIDまたは質問ハッシュベースの重複排除）が必要な場合は、別Issueでのフォローアップを推奨する。

### 6.3 thinking状態からプロンプト表示への遷移遅延（既知のトレードオフ）

> **[S3-008]** Layer 1のthinking状態チェック（auto-yes-manager.ts）により、thinking中はdetectPrompt()の呼び出しがスキップされる。Claude CLIがthinkingを完了して選択肢プロンプトを表示する遷移期間中、tmux出力にはthinkingインジケーター（スピナー文字等）が残存している場合がある。detectThinking()は最終行だけでなく出力全体を広範にチェックするため、プロンプトが最新行に表示されていても、以前の行にthinkingインジケーターが残っていればthinking=trueとなり、プロンプト検出が1ポーリングサイクル以上遅延する可能性がある。
>
> **影響範囲**: Auto-Yesモードの自動応答が最大2秒（1ポーリング間隔）遅延する。正確性の問題ではない（プロンプトは最終的に検出される）。
>
> **設計判断**: False Positive応答によるユーザーの作業フロー中断と比較して、2秒の遅延は許容可能なトレードオフである。ユーザーフィードバックにより遅延が問題視された場合、auto-yesパスに限定して最終N行のプロンプトチェックをthinkingチェックより先に行う最適化を検討するが、現時点では不要とする。

### 6.4 パフォーマンス影響

- thinking判定: 呼び出し元でdetectThinking()1回呼び出し（軽微）
- 連番検証: O(n)の配列チェック（n=選択肢数、通常2-5個、軽微）
- ❯パターン分離（2パス方式）: パス1は❯存在チェックのみ（軽量）。パス1で❯未検出の場合はパス2をスキップするため、誤検出ケースではむしろ処理が軽くなる。❯が存在する場合のみ2回のスキャンとなるが、50行以内の処理であり軽微。

---

## 7. 呼び出し元の影響調査

### 7.1 detectPrompt()の呼び出し元

| ファイル | 行 | コンテキスト | 影響 | thinking判定状況 |
|---------|-----|-------------|------|-----------------|
| `src/lib/auto-yes-manager.ts` | L280 | pollAutoYes内 | 直接影響あり（thinking判定追加） | **追加予定**: detectPrompt()前にdetectThinking()チェック |
| `src/lib/response-poller.ts` | L248, L442, L556 | extractResponse内（複数箇所） | 間接影響（detectPromptの結果が変わる） | getCliToolPatterns().thinkingPatternによるパターンマッチ（L266, L337, L533）。**[S3-005] 注記**: L248はClaude固有パーミッションプロンプトの早期検出で使用され、thinking判定より先に実行されるためthinkingガードなし。L442/L556は抽出処理の後半で使用。2パス検出修正がprompt-detector.ts内で適用されるため、全呼び出し箇所でFalse Positiveが削減される |
| `src/lib/claude-poller.ts` | L164 | extractClaudeResponse内 | 間接影響（detectPromptの結果が変わる） | ローカル定義のthinkingPattern (`/[✻✽⏺·∴✢✳]/m`) によるパターンマッチ（L76） -- cli-patterns.tsのCLAUDE_THINKING_PATTERNとは異なるパターン |
| `src/lib/status-detector.ts` | L80 | detectStatus内 | 間接影響（detectPromptの結果が変わる） | detectThinking()関数を使用（L91）。ただしdetectPrompt() (L80)が先に実行されるため実行順序に問題あり |
| `src/app/api/worktrees/route.ts` | L62 | ワークツリー一覧API | 間接影響（detectPromptの結果が変わる） | **[S3-001]** detectPrompt()がdetectThinking()より先に実行される。status-detector.tsと同じ実行順序問題を持つ。2パス検出修正により全呼び出し箇所でFalse Positiveが解消されるため、このファイルへの直接変更は不要 |
| `src/app/api/worktrees/[id]/route.ts` | L62 | ワークツリー詳細API | 間接影響（detectPromptの結果が変わる） | **[S3-001]** 上記worktrees/route.tsと同じパターン。detectPrompt()がdetectThinking()より先に実行される。2パス検出修正により直接変更不要 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | L79 | 現在の出力取得API | 間接影響（detectPromptの結果が変わる） | **[S3-001]** detectPrompt()をdetectThinking()より先に呼び出すが、`!isPromptWaiting && detectThinkingState(...)`のガードにより、プロンプト検出時にthinking=trueにはならない。ただしFalse Positive時にisPromptWaiting=trueとpromptDataがクライアントに伝播する。2パス検出修正により直接変更不要 |
| `src/hooks/useAutoYes.ts` | - | promptData依存 | 間接影響（検出されないプロンプトは到達しない） | クライアント側（サーバー側で処理済み） |

> **[S1-006] 追加**: status-detector.tsがdetectPrompt()の呼び出し元として追加された。status-detector.tsはL80でdetectPrompt(lastLines)を呼び出し、promptが検出されるとearly returnするため、L91のdetectThinking()チェックに到達しない実行順序になっている。thinking中にmultiple_choiceの誤検出が発生した場合、ステータスが誤って'waiting'になる可能性がある。
> **[S2-002] 更新**: 各呼び出し元のthinking判定状況を具体的に記載。response-poller.tsはgetCliToolPatterns().thinkingPattern、claude-poller.tsはローカル定義の簡略化パターン、status-detector.tsはdetectThinking()関数をそれぞれ使用しており、3つの異なる方式が存在する。
> **[S3-001] 追加**: 3つのAPIルートファイル（worktrees/route.ts、worktrees/[id]/route.ts、worktrees/[id]/current-output/route.ts）をdetectPrompt()の呼び出し元として追加。いずれもdetectPrompt()をdetectThinking()より先に実行するパターンを持つ。prompt-detector.ts内の2パス検出修正により全呼び出し箇所でFalse Positiveが解消されるため、これらのファイルへの直接コード変更は不要。
> **[S3-005] 更新**: response-poller.tsのdetectPrompt()呼び出し箇所を詳細化（L248, L442, L556）。L248の早期検出にはthinkingガードがないことを明記。

### 7.2 影響の種類

- **auto-yes-manager.ts**: detectPrompt()呼び出し前にdetectThinking()チェックを追加する（本設計書のスコープ）。
- **response-poller.ts / claude-poller.ts**: `detectPrompt()`を呼び出してプロンプトを検出しているが、今回の変更はFalse Positiveの削減であり、正当なプロンプトの検出には影響しない。既存のthinking判定はこれらのファイル内で別途行われている。
- **status-detector.ts**: detectPrompt()がdetectThinking()より先に実行されるため、thinking中のFalse Positiveが'waiting'ステータスの誤判定を引き起こす可能性がある。**推奨対応**: status-detector.tsでもdetectPrompt()呼び出し前にdetectThinking()チェックを追加するか、実行順序をthinking -> promptの順に変更することを検討する。ただし、status-detector.tsの変更はIssue #161のコアスコープ外であるため、動作確認の上、必要に応じて対応する。
- **useAutoYes.ts**: promptDataが渡されなくなるケースが増えるが、これは正しい動作（誤検出されていたものが検出されなくなる）。
- **APIルート**: worktrees/route.ts、worktrees/[id]/route.ts、worktrees/[id]/current-output/route.tsはdetectPrompt()を呼び出すが、prompt-detector.ts内の2パス検出修正により全箇所でFalse Positiveが削減される。直接コード変更は不要。

> **[S3-009] 注記**: PromptDataを消費するUIコンポーネント（PromptPanel.tsx、MobilePromptSheet.tsx、PromptMessage.tsx、MessageList.tsx、WorktreeDetailRefactored.tsx）は、current-output APIレスポンスからpromptDataを受け取る下流消費者である。本変更によりFalse PositiveのpromptDataオブジェクトが減少するが、これらのコンポーネントは既にpromptDataがnull/undefinedの場合を正しく処理しているため、コード変更は不要である。

---

## 8. 実装順序

```
0. [推奨] 回帰テストのベースライン作成（TDDアプローチ）
   |  Section 5.2の回帰テストケース1-6を現在のコードに対して作成・実行し、
   |  全テストがパスすることを確認する。これにより後方互換性のベースラインを確立する。
   |
1. prompt-detector.ts: 2パス❯検出方式の実装（案1）
   |
2. prompt-detector.ts: 連番検証追加（案3、防御的措置）
   |
3. auto-yes-manager.ts: thinking事前チェック追加（案2）
   |
4. テスト作成・実行（誤検出防止テスト、防御層境界テスト、50行ウィンドウ境界テスト含む）
   |
5. status-detector.tsの実行順序確認・必要に応じて対応
   |
6. CI品質チェック
```

> **[S1-001/S1-002] 変更**: 旧Step 3「prompt-detector.ts: thinking判定追加」を削除。thinking判定はauto-yes-manager.ts側のみで実施する。
> **[S1-006] 追加**: Step 5にstatus-detector.tsの確認ステップを追加。
> **[S3-004] 追加**: Step 0として回帰テストのベースライン作成を推奨。現在のテストファイルにはmultiple_choiceプロンプト検出のテストケースが0件であるため、コード変更前にSection 5.2の回帰テスト（テスト1-6）を現在のコードに対して作成・実行し、全パスを確認することを推奨する。これにより、実装変更後の後方互換性を現行動作（ドキュメント上の期待動作ではなく）に対して自動検証できる。

---

## 9. セキュリティ考慮事項

> **[S4-001〜S4-008]** Stage 4セキュリティレビューの結果を反映したセキュリティ設計ノート。

### 9.1 ReDoS耐性

> **[S4-001]** 本設計で提案する正規表現パターンのReDoS安全性評価。

**提案パターンの安全性**:
- `defaultOptionPattern` (`/^\s*\u276F\s*(\d+)\.\s*(.+)$/`): アンカー付き（`^...$`）であり、各量化子が異なる文字クラスを消費するため、病的なバックトラッキングは発生しない。ReDoS安全。
- `normalOptionPattern` (`/^\s*(\d+)\.\s*(.+)$/`): 同上、アンカー付きでReDoS安全。

**既存パターンの軽微なリスク**:
- `TEXT_INPUT_PATTERNS`内の `/enter\s+/i` パターンは末尾の`\s+`が貪欲マッチであり、入力文字列に大量の空白文字が含まれる場合に不要なバックトラッキングが理論上発生しうる。ただし、このパターンはtmux出力から抽出された選択肢ラベル（通常数十文字）に対してtest()で適用されるため、実際のReDoSリスクは低い。防御的措置として `/enter\s/i` への変更または文字数上限チェック（`label.length > 200`のスキップ）を将来検討してよいが、Issue #161のスコープ内では対応不要。

> **[S4-008]** `CLAUDE_THINKING_PATTERN`の`.+…`部分について、`.+`は貪欲マッチだが、ネスト量化子（`(a+)+`等）には該当せず、バックトラッキングは入力行の長さに対して線形である。tmux出力の1行は通常数百文字以下であるため、パフォーマンスへの影響は軽微。ただし、本設計のauto-yes-manager.ts変更により、`detectThinking()`が`detectPrompt()`の前に呼び出されるため、`CLAUDE_THINKING_PATTERN`の評価頻度が増加する。/mフラグにより各行に対して個別にマッチが試みられるが、リスクは低い。防御的改善として`.+…`を`[^\n]+…`に変更することで意図を明確化できるが、Issue #161のスコープ外として扱う。

### 9.2 コマンドインジェクション防御

> **[S4-003]** tmux sendKeys経由のコマンドインジェクション防御に関するdefense-in-depth推奨事項。

**現在の安全性**: `resolveAutoAnswer()`は以下の値のみを返す：
- `'y'`（yes/noプロンプトの場合）
- 数値文字列（`target.number.toString()`、multiple_choiceの場合）
- `null`（スキップ）

これらの値はいずれもtmuxコマンドインジェクションのリスクが極めて低い安全な文字列である。加えて、`worktreeId`は`WORKTREE_ID_PATTERN`（`/^[a-zA-Z0-9_-]+$/`）で検証済みである。

**defense-in-depth推奨（将来改善）**: `sendKeys()`呼び出し前に、`answer`が予期された形式（`/^(y|n|\d+)$/`）であることを明示的にアサートするガードを追加することで、将来`resolveAutoAnswer()`の変更時にも安全性を維持できる。これはIssue #161のブロッキング要件ではなく、将来のフォローアップとして推奨する。

### 9.3 Auto-Yesの自動承認リスク（既知リスク）

> **[S4-006]** Auto-Yesがyes/noプロンプトに対して常に`'y'`を返す既存設計のリスク認識。

**既知のリスク**: `auto-yes-resolver.ts`はyes/noプロンプトに対して無条件に`'y'`を返す。Claude CLIが「このファイルを削除しますか？(y/n)」「このディレクトリを上書きしますか？(y/n)」等の破壊的操作の確認プロンプトを表示した場合、Auto-Yesモードは自動的に`'y'`を送信する。1時間のタイムアウト（`AUTO_YES_TIMEOUT_MS = 3600000`）内に破壊的操作のプロンプトが表示された場合のリスクがある。

**Issue #161との関係**: 本設計のFalse Positive修正はこのリスクを間接的に軽減する（誤検出による意図しない`'y'`送信を防ぐため）が、正当なプロンプトに対する自動承認リスクは残存する。

**将来のフォローアップ候補（Issue #161スコープ外）**:
- 破壊的操作キーワード（delete, remove, overwrite, destroy等）を質問文から検出し、該当する場合は自動応答をスキップするセーフガード
- Auto-Yesモードの有効時間を設定可能にする
- Auto-Yes応答の履歴をUIに表示し、ユーザーが事後確認できる仕組み

### 9.4 残存False Positiveリスク

> **[S4-002]** 多層防御実装後も残存するFalse Positiveリスクの認識。

**残存リスク**: 50行ウィンドウ内に回答済みの古いプロンプトの❯が残存している場合、新しい番号付きリスト出力がFalse Positiveとなる可能性がある。具体的には、古いプロンプトの❯行がウィンドウ内に残っている状態で、Claude CLIが通常の番号付きリストを出力した場合、パス1で❯が検出され、パス2で番号付きリストがnormalOptionPatternにマッチしてoptions配列に蓄積される。

**テストカバレッジ**: このエッジケースはSection 5.4テスト#3（回答済みの古いプロンプト + 新しい番号付きリスト）で検証する。テスト#3の結果に基づき、既存の`options.length >= 2 && hasDefault`検証がこのケースを正しく処理できることを確認する。

**将来の改善候補**: ウィンドウサイズの動的調整、または応答済みプロンプトの追跡メカニズムの導入を検討する。これらはIssue #161のスコープ外であり、実際に問題が報告された場合のフォローアップとする。

### 9.5 ANSI処理・ログ・OWASP確認事項

> **[S4-004]** `stripAnsi()`（cli-patterns.ts L160の`ANSI_PATTERN`）は標準的なANSIエスケープシーケンス（CSI、OSC、不完全CSI）をカバーしており、Claude CLI出力に対しては実績がある。提案パターン（defaultOptionPattern/normalOptionPattern）はstripAnsi()適用後のクリーンな文字列に対して実行されるため、ANSIコード残留による誤マッチのリスクは低い。現在の実装で実用上十分であり、Issue #161スコープ内での変更は不要。将来、非標準ANSIシーケンスが問題になった場合は、strip-ansiパッケージ等への移行を検討する。

> **[S4-005]** ログ出力のセキュリティ確認: auto-yes-manager.tsのログはworktreeIdのみを出力し、応答内容やプロンプト質問文は含まれていない。prompt-detector.tsのログは`question`（CLIのUI要素テキスト）と`optionsCount`のみで、ユーザーの機密データは含まれていない。detectThinking()のログも`contentLength`と`isThinking`ブール値のみ。全体的にログ出力のセキュリティは適切に管理されている。将来デバッグ目的でLOG_LEVEL=debugを使用する場合は、tmux出力内容が記録される可能性があるため、運用環境でのdebugレベル使用を避けることを推奨する。

> **[S4-007]** OWASP Top 10との関連性評価: Issue #161の変更はWebアプリケーションのHTTPリクエスト処理には直接関与しないため、OWASP Top 10の大部分は適用外である。Auto-Yes機能はCM_AUTH_TOKENで保護されたAPIエンドポイント経由で有効化され、worktreeIdバリデーションとMAX_CONCURRENT_POLLERS制限が適用されている。本変更はこれらの既存セキュリティメカニズムに影響を与えない。追加のOWASP対応は不要。

---

## 10. 品質チェック項目

| チェック項目 | コマンド | 基準 |
|-------------|----------|------|
| ESLint | `npm run lint` | エラー0件 |
| TypeScript | `npx tsc --noEmit` | 型エラー0件 |
| Unit Test | `npm run test:unit` | 全テストパス |
| Build | `npm run build` | 成功 |

---

## 11. レビュー指摘事項サマリー

### 11.1 Stage 1: 通常レビュー（設計原則）

**レビュー日**: 2026-02-06

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|---------|---------|---------|
| S1-001 | Must Fix | DRY | thinking判定ロジックがprompt-detector.tsとauto-yes-manager.tsで二重に実行される | 反映済み: Section 3.2からprompt-detector.ts内thinking判定を削除 |
| S1-002 | Must Fix | SOLID | prompt-detector.tsにClaude CLI固有のCLAUDE_THINKING_PATTERNを直接importすることはSRP/OCP違反 | 反映済み: prompt-detector.tsのCLIツール非依存性を維持 |
| S1-003 | Should Fix | DRY | detectPrompt()内のyes/noパターン検出で同一構造のコードが4回繰り返されている | 認識済み: Issue #161スコープ外、別Issueでフォローアップ推奨 |
| S1-004 | Should Fix | KISS | ❯パターン分離で正規表現が2つに増える設計 -- 既存hasDefault判定との整合性 | 反映済み: Section 3.1に実態の補足追加、真の問題を明確化 |
| S1-005 | Should Fix | KISS | 連番検証（案3）の実際の誤検出シナリオでの有効性 | 反映済み: MustからShould（防御的措置）に変更 |
| S1-006 | Should Fix | SOLID | status-detector.tsの影響調査漏れ | 反映済み: Section 7.1テーブルに追加、実行順序の問題を記載 |
| S1-007 | Nice to Have | KISS | 多層防御の各層の境界テスト | 反映済み: Section 5.3に防御層境界テスト追加 |
| S1-008 | Nice to Have | DRY | claude-poller.tsのthinkingPatternがcli-patterns.tsと重複定義 | 認識済み: 既存技術的負債、Issue #161スコープ外 |
| S1-009 | Nice to Have | SOLID | detectMultipleChoicePrompt()の責務が大きい | 認識済み: 将来のリファクタリング候補、Issue #161スコープ外 |

### 11.2 Stage 2: 整合性レビュー

**レビュー日**: 2026-02-06

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|---------|---------|---------|
| S2-001 | Must Fix | cross_section | Section 3.1のnormalOptionPatternコンテキスト制約と検出ロジックの不整合 | 反映済み: 2パス検出方式を採用。Section 3.1, 4, 5.1を更新 |
| S2-002 | Should Fix | code_reference | Section 7.1のthinking判定状況の記述が不正確 | 反映済み: Section 7.1のthinking判定状況列を具体化 |
| S2-003 | Should Fix | cross_section | Section 2変更対象ファイルにstatus-detector.tsが含まれていない | 反映済み: Section 2にstatus-detector.tsを条件付き変更対象として追加 |
| S2-004 | Should Fix | feasibility | auto-yes-manager.tsのimport変更が既存importへの追加であることが不明確 | 反映済み: Section 3.2にstripAnsiが既にL17でimport済みである旨を注記 |
| S2-005 | Should Fix | test_coverage | Section 5.1テストケース#2の期待結果と防御層の整合性 | 反映済み: Section 5.1に保護する防御層の列を追加、テストケース#2がLayer 2で保護されることを明記 |
| S2-006 | Should Fix | test_coverage | Section 5.3テスト#1の実装場所が不明確 | 反映済み: Section 2にauto-yes-manager.test.ts追加、Section 5.3に実装先を明記、Section 5.4との同一性を注記 |
| S2-007 | Nice to Have | code_reference | Section 3.3の連番検証の適用場所記述が微妙に不正確 | 反映済み: Section 3.3に既存コードL241/L242との対応を注記 |
| S2-008 | Nice to Have | cross_section | Section 4のLayer 1にstatus-detector.tsの実行順序問題の注記がない | 反映済み: Section 4の多層防御図のLayer 1にstatus-detector.tsの実行順序問題を注記 |
| S2-009 | Nice to Have | issue_design | Issue #161のユーザー影響の記載がない | 反映済み: Section 1.1にユーザー影響のサブセクションを追加 |
| S2-010 | Nice to Have | code_reference | 行番号の将来変動リスク | 反映済み: Section 1.2に行番号再確認の注記を追加 |

### 11.3 Stage 3: 影響分析レビュー

**レビュー日**: 2026-02-06

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|---------|---------|---------|
| S3-001 | Must Fix | ripple_effect | APIルート（worktrees/route.ts等3ファイル）がdetectPrompt()の呼び出し元として未記載 | 反映済み: Section 7.1テーブルに3つのAPIルートファイルを追加。2パス検出修正により直接コード変更は不要であることを明記 |
| S3-002 | Must Fix | race_condition | サーバー・クライアント間の重複応答防止メカニズムへの影響が未分析 | 反映済み: Section 6.2に3秒重複防止ウィンドウが本変更の影響を受けないことを明記 |
| S3-003 | Should Fix | edge_case | U+276F文字がプロンプト行と選択肢インジケーターの両方で使用されており曖昧性がある | 反映済み: Section 5.1にテストケース#7を追加（プロンプト行❯ + 番号付きリストの共存シナリオ） |
| S3-004 | Should Fix | backward_compat | 既存テストにmultiple_choiceプロンプトの回帰テストがなく、変更前のベースラインが存在しない | 反映済み: Section 8にStep 0として回帰テストのベースライン作成（TDDアプローチ）を推奨追加 |
| S3-005 | Should Fix | ripple_effect | response-poller.tsの複数detectPrompt()呼び出し箇所（L248, L442, L556）が未記載 | 反映済み: Section 7.1のresponse-poller.tsエントリに複数呼び出し箇所とL248のthinkingガード不在を明記 |
| S3-006 | Should Fix | dependency | Claude CLI出力形式変更（❯文字、選択肢インジケーター形式）による2パス検出の無効化リスク | 反映済み: Section 6.1に依存リスクと緩和策（名前付き定数抽出、統合スモークテスト）を追加 |
| S3-007 | Should Fix | edge_case | 50行スキャンウィンドウの境界条件（不足/過剰）のテスト不足 | 反映済み: Section 5.4に50行ウィンドウ境界条件テスト（3ケース）を追加 |
| S3-008 | Should Fix | user_experience | thinking状態からプロンプト表示への遷移時にauto-yes応答が遅延する可能性 | 反映済み: Section 6.3に既知のトレードオフとして遷移遅延（最大2秒）を記載 |
| S3-009 | Nice to Have | ripple_effect | UIコンポーネント（PromptPanel等）がPromptDataの下流消費者として未記載 | 反映済み: Section 7.2にUIコンポーネントの下流消費者としてのノートを追加 |
| S3-010 | Nice to Have | edge_case | isConsecutiveFromOne()がClaude CLIのフィルタリング選択肢に対応できない可能性 | 反映済み: Section 3.3のisConsecutiveFromOne()コメントに将来の緩和可能性を注記 |
| S3-011 | Nice to Have | dependency | claude-poller.tsの簡略化thinkingPatternがcli-patterns.tsと不一致 | 対応不要: S1-008で既に認識済み、Section 10.4のスコープ外技術的負債に含まれる |

### 11.4 Stage 4: セキュリティレビュー

**レビュー日**: 2026-02-06

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|---------|---------|---------|
| S4-001 | Should Fix | redos | TEXT_INPUT_PATTERNSの `/enter\s+/i` に軽微なバックトラッキングリスク。提案パターン（defaultOptionPattern, normalOptionPattern）はアンカー付きでReDoS安全 | 反映済み: Section 9.1にReDoS耐性評価を追加 |
| S4-002 | Should Fix | auto_response_safety | 50行ウィンドウ内の古い❯残存によるFalse Positiveリスク（Issue #161の核心問題、多層防御で緩和） | 反映済み: Section 9.4に残存False Positiveリスクを追加、Section 5.4テスト#3と相互参照 |
| S4-003 | Should Fix | command_injection | sendKeys前のresolveAutoAnswer()出力値アサーション（defense-in-depth推奨） | 反映済み: Section 9.2にdefense-in-depth推奨を追加。将来のフォローアップとして位置付け |
| S4-004 | Nice to Have | input_validation | stripAnsi()のANSI_PATTERNが一部非標準シーケンスをカバーしない可能性 | 反映済み: Section 9.5に確認結果を記載。現状で実用上十分、変更不要 |
| S4-005 | Nice to Have | logging | ログ出力にtmux出力内容や機密情報が含まれないことの確認 | 反映済み: Section 9.5に確認結果を記載。現状でセキュリティ適切 |
| S4-006 | Should Fix | auto_response_safety | Auto-Yesがyes/noに常に'y'を返す設計は破壊的操作の自動承認リスクを内包（既存設計、スコープ外） | 反映済み: Section 9.3に既知リスクとして記載。将来のフォローアップ候補を列挙 |
| S4-007 | Nice to Have | owasp | OWASP Top 10との関連性評価。直接的該当なし、既存認証・認可メカニズムで十分 | 反映済み: Section 9.5に確認結果を記載。追加対応不要 |
| S4-008 | Should Fix | redos | CLAUDE_THINKING_PATTERNの `.+…` に軽微なReDoSリスク。detectThinking()事前チェックで評価頻度増加 | 反映済み: Section 9.1にリスク評価を追加。防御的改善は Issue #161スコープ外 |

### 11.5 スコープ外の技術的負債

以下の項目はIssue #161のスコープ外として認識し、別Issueでのフォローアップを推奨する。

| 項目 | 関連レビューID | 説明 |
|------|---------------|------|
| yes/noパターンのDRY改善 | S1-003 | detectPrompt()内のPattern 1-4を配列ループ方式にリファクタリング |
| claude-poller.tsのthinkingPattern統一 | S1-008, S3-011 | L76のローカルthinkingPatternをcli-patterns.tsのCLAUDE_THINKING_PATTERNまたはdetectThinking()に統一。S3-011で影響分析の観点からも再確認済み |
| detectMultipleChoicePrompt()の責務分割 | S1-009 | parseOptionLines() / validateOptions() / buildResult()への分割リファクタリング |
| サーバー・クライアント重複応答防止の強化 | S3-002 | 3秒タイムスタンプウィンドウからプロンプトID/質問ハッシュベースの重複排除への改善検討 |
| ❯文字のcli-patterns.ts定数化 | S3-006 | defaultOptionPatternの❯（U+276F）をcli-patterns.tsの名前付き定数として抽出し、CLI形式変更時の対応を容易にする |
| Claude CLI出力形式の統合スモークテスト | S3-006 | 実際のClaude CLI出力に対する検出テストを追加し、CLI形式変更の早期警告とする |
| TEXT_INPUT_PATTERNSのReDoS防御的改善 | S4-001 | `/enter\s+/i`を`/enter\s/i`に変更、またはlabel文字数上限チェック追加 |
| sendKeys前のanswer形式アサーション | S4-003 | `sendKeys()`呼び出し前に`answer`が`/^(y\|n\|\d+)$/`にマッチすることをアサートするdefense-in-depthガード追加 |
| Auto-Yesの破壊的操作セーフガード | S4-006 | 破壊的操作キーワード（delete, remove, overwrite等）検出による自動応答スキップ、有効時間の設定可能化、応答履歴のUI表示 |
| CLAUDE_THINKING_PATTERNの防御的ReDoS改善 | S4-008 | `.+…`を`[^\n]+…`に変更して意図を明確化 |
| 50行ウィンドウの古い❯残存対策 | S4-002 | ウィンドウサイズの動的調整、または応答済みプロンプトの追跡メカニズムの導入検討 |

---

## 12. 実装チェックリスト

### Must Fix対応

- [ ] **[S1-001/S1-002]** prompt-detector.tsにCLAUDE_THINKING_PATTERNをimportしない
- [ ] **[S1-001/S1-002]** prompt-detector.tsのdetectMultipleChoicePrompt()内にthinking判定ロジックを追加しない
- [ ] **[S1-001/S1-002]** auto-yes-manager.tsのpollAutoYes()内でdetectThinking()による事前チェックを追加する
- [ ] **[案1/S2-001]** prompt-detector.tsに2パス検出方式を実装する:
  - [ ] パス1: 50行ウィンドウ内でdefaultOptionPattern（❯付き）にマッチする行の存在を確認
  - [ ] パス1で❯未検出の場合、即座にisPrompt: falseを返す
  - [ ] パス2: ❯が確認された場合のみ、defaultOptionPatternとnormalOptionPatternで選択肢行を収集
- [ ] **[S3-001]** Section 7.1にAPIルート3ファイルが呼び出し元として記載されていることを確認する（コード変更は不要）
- [ ] **[S3-002]** 既存の3秒重複応答防止ウィンドウが本変更の影響を受けないことを実装時に確認する

### Should Fix対応

- [ ] **[S1-004]** Section 3.1の問題説明が実態（L212のincludes判定）と整合していることを確認する
- [ ] **[S1-005]** 連番検証を防御的措置として実装し、コメントで「将来の未知パターン対策」と明記する
- [ ] **[S1-006]** status-detector.tsの実行順序（detectPrompt L80 -> detectThinking L91）を確認する
- [ ] **[S1-006]** 必要に応じてstatus-detector.tsでdetectPrompt()前にdetectThinking()チェックを追加する
- [ ] **[S2-004]** auto-yes-manager.tsの既存import文（L17のstripAnsi）にdetectThinkingを追加する
- [ ] **[S3-004]** コード変更前にSection 5.2の回帰テスト（テスト1-6）を現在のコードに対して作成・全パス確認する（TDDアプローチ）
- [ ] **[S3-005]** response-poller.tsの複数detectPrompt()呼び出し箇所（L248, L442, L556）がLayer 2修正で正しく保護されることを確認する
- [ ] **[S3-010]** isConsecutiveFromOne()の実装コメントに将来の緩和可能性を記載する

### セキュリティ対応（Stage 4）

- [ ] **[S4-001]** 提案パターン（defaultOptionPattern, normalOptionPattern）がアンカー付きでReDoS安全であることを実装時に確認する
- [ ] **[S4-002]** Section 5.4テスト#3（古い❯残存 + 新しい番号付きリスト）の実装と結果確認。残存False Positiveリスクの実際の挙動を検証する
- [ ] **[S4-003]** （将来改善）sendKeys()呼び出し前にanswer形式アサーション（`/^(y|n|\d+)$/`）の追加を検討する（Issue #161ではブロッキングではない）
- [ ] **[S4-006]** （将来改善）Auto-Yesの破壊的操作自動承認リスクについて、フォローアップIssueの作成を検討する
- [ ] **[S4-008]** detectThinking()事前チェック追加後、CLAUDE_THINKING_PATTERNの評価頻度増加がパフォーマンスに影響しないことを確認する

### テスト対応

- [ ] **[S1-007/S2-006]** 防御層境界テスト（Section 5.3）を実装する（テスト#1はauto-yes-manager.test.tsに実装）
- [ ] 誤検出防止テスト（Section 5.1）を全て実装する（**[S3-003]** テストケース#7含む）
- [ ] 正常検出回帰テスト（Section 5.2）が全てパスすることを確認する
- [ ] **[S2-006]** auto-yes-manager回帰テスト（Section 5.5）をtests/unit/lib/auto-yes-manager.test.tsに実装する
- [ ] **[S3-007]** 50行ウィンドウ境界条件テスト（Section 5.4）を実装する（3ケース）
