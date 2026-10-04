# 「いま操作できる部分」を 1 か所で切り出す（Issue #3183）

対象 Issue: [#3183](https://github.com/Kewton/CommandMate/issues/3183) / 作成日: 2026-10-04 / 状態: 設計（実装前）

このドキュメントは実装前の設計書である。コードとテストはまだ変えていない。
数字と行番号は、すべてこの worktree（`b3be4eff` 時点）で `grep -n` / `sed -n` / fixture の行番号付き表示で読んだ値である。
fixture の行番号は **ファイルの 1 始まりの物理行**（ANSI を除いて表示した行。空行も数える）。

---

## 0. 結論（要約）

| 決めたこと | 中身 |
|---|---|
| 操作部分の名前 | **live region**。`NormalizedFrame.liveRegion: LiveRegion` を足す（既存フィールドは変えない） |
| 操作部分の定義 | 「画面の下端に、ツールがいま描いている入力の塊」。**入力欄（composer）が見えていればその塊の先頭から下**、見えていなければ**ダイアログ枠の先頭から下**、どちらも見つからなければ**画面全体**（＝今日の読み方） |
| ツールごとの違い | `LiveRegionSpec`（入力欄の目印・ダイアログ枠の目印・`composerHidesDialogs`）の**宣言だけ**。宣言は共有の部品（`fencedComposer` / `bottomMostComposerRow` / `ruleAboveOptionRun` / `dialogTopFrom` など）を呼ぶ数行で書く |
| 切り出す場所 | `normalizeFrame(output, tool?)` の中で 1 回だけ。`tool` を省いた呼び出しは今日と同じ結果（`anchor: 'none'`、画面全体） |
| 共通の拒否規則 | 入力欄が見えているフレームでは、**入力欄より上にある選択肢・フッタ・ダイアログ文言は操作部分ではない**。この 1 規則を `runToolDetection`（状態）と Auto-Yes の両方が同じ関数で使う |
| Auto-Yes の入力 | 今日は `stripBoxDrawing` 済みの文字列（罫線が消えた綴り）で `normalizeFrame` している。これを**生のキャプチャ**から作った `NormalizedFrame` 1 個に揃え、プロンプト検出・ダイアログ判定・codex の起動画面ガードに同じものを渡す |
| agent-health | `screen-*` が `fail` のとき、**生のフレーム全体**を `<レポートの置き場>/../frames/<date>/<tool>-<checkId>.txt` に書く（ANSI 付き。そのまま fixture にできる） |
| 分割 | 3 段（土台 → 読み替え → agent-health）。2 本の契約にまとめるなら「土台＋読み替え」と「agent-health」 |

---

## 1. 現状の整理（Issue 本文の「現状のコード」の裏取り）

### 1.1 本文どおりだったもの

| 本文の記述 | 実コード | 判定 |
|---|---|---|
| `NormalizedFrame` に操作部分のフィールドが無い | `src/lib/detection/tools/types.ts:47-60`。フィールドは `raw` / `clean` / `lines` / `contentLines` / `lastLines` / `thinkingLines` | 正しい（ただし `contentLines`（L55）も在る。本文の列挙から漏れていた） |
| 切り出しは codex だけが持つ `cli-patterns.ts:438` の `codexActiveRegionLines()` | `src/lib/detection/cli-patterns.ts:438`。最下段の「本物の入力行」`CODEX_GENUINE_PROMPT_LINE = /^\s*›(?!\s*\d+\.)/`（L368）より**下**の行を返す。無ければ画面全体 | 正しい。使い手は同ファイルの `getCodexActiveDialog`（L451）と `getCodexLifecycleDialog`（L581-582）の 2 つだけ |
| claude は footer の行頭判定で引用を見分ける | `src/lib/detection/tui-detection-frame.ts:19-20`（`CLAUDE_PROMPT_FOOTER_PATTERN`）、L21（picker footer）、L30-31（`CLAUDE_LOWER_INTERACTIVE_ANCHOR`）、L59（`normalizeTuiFrameForDetection`） | 正しい |
| 検出と Auto-Yes が同じ切り出しを使う保証が無い | 1.3 で具体的に示す | 正しい（保証が無いどころか、**入力の綴りが違う**） |
| agent-health の不合格時は切り詰めた抜粋だけ | `src/lib/agent-health/screen-checks.ts:109` が `paneEvidence(frame)` を入れる。`src/lib/agent-health/report.ts:41-49` の `paneEvidence` は ANSI を除き、空行を詰め、末尾 N 行を `truncateEvidence`（L30）に通す | 正しい |

### 1.2 本文と食い違っていたもの（実コードを正とする）

1. **codex の切り出しは 1 つではなく 2 つある。** `codexActiveRegionLines()`（#892、ANSI を除いた綴りで最下段の `›` 行を探す）とは別に、
   `src/lib/detection/tools/codex/cli-patterns.ts:490` の `isCodexComposerAtBottom()`（#2841）が在る。こちらは生の SGR を読んで最下段の `›` 行を
   `composer` / `option` / `transcript-echo` に分け（`findCodexBottomGlyphRow`、L352）、`codex/detect.ts` の L208（branch 0.6 の拒否）・
   L395-402（`isStalePrompt`）・L408-414（`detectDialog`）で使われる。**同じ「入力欄より上は会話」という規則が codex の中で 2 回、別の綴りで書かれている。**
2. **claude の footer 判定は claude 専用ではない。** `normalizeTuiFrameForDetection` はツールを問わず次の 4 か所から呼ばれる:
   `src/lib/detection/tools/frame.ts:28`（全ツールの `normalizeFrame`）、`src/lib/detection/prompt-detector.ts:194`、
   `src/lib/detection/prompt-detect-multiple-choice.ts:992`、`src/lib/detection/tools/antigravity/dialog.ts:254`。
   `CLAUDE_LOWER_INTERACTIVE_ANCHOR`（L30-31）が codex の `›` を含むのはこのため（#2774）。
3. **claude の引用対策は `tui-detection-frame.ts` だけではない。** #2847 は `src/lib/detection/tools/claude/detect.ts:128` の `selectionFooterRows()` で、
   入力欄（`findClaudeInputBox`、`src/lib/detection/composer-text.ts:170`）より下の行だけから選択リストの footer を読む。
4. **本文の一覧に無い「入力欄より上は会話」の実装が他にもある。**
   - 汎用の番号リスト解析の「ユーザー入力の壁」: `src/lib/detection/prompt-detect-multiple-choice.ts:1215-1222`（#287）。下から読んで、選択肢を 1 つも集める前に `❯` / `●` / `›` で始まる行に当たったら打ち切る。claude / codex / command-code / copilot の入力欄はこれで止まるが、**agy の `>` と opencode 系の `┃` は止まらない**（#2851 が Auto-Yes まで届いた理由）
   - copilot: `src/lib/detection/cli-patterns.ts:2263` の `isCopilotSelectionFrame()` と L1860 の `readCopilotStatusBar()`。最下行が状態バーなら picker ではない、という位置の規則
   - agy: `src/lib/detection/cli-patterns.ts:2629` の `locateAntigravityDialogRegion()`（footer の下に入力欄があれば null）、`tools/antigravity/detect.ts:68`（survey）・L89（選択画面）・L116（番号リスト）の 3 つの述語
   - opencode v1: 専用の引用対策は無い。`tools/opencode/detect.ts:136` が承認ストリップを `frame.lastLines`（末尾 15 行）で読むので、引用が十分上にあれば当たらない、という**窓の距離だけ**が守っている（`tests/fixtures/opencode-agent-health-3021/quoted-dialog-reply-done.txt` は利用者の発話の枠 L23 に `┃   Allow once   Allow always   Reject` を持つ。現状 `ready` になることは `tests/unit/detection/tools/opencode/agent-health-frames-3021.test.ts:55-60` が固定）
5. **本文が挙げたファイルのうち、2 つは「操作部分の始まり」の問題ではない。**
   - `tools/claude/picker-chrome.ts:179` の `hasPickerFooterBelow()` は、AskUserQuestion のプレビュー枠を **parser の中で**「下に footer が無い枠は picker の枠ではない」と判定する（`prompt-detect-multiple-choice.ts:219` から呼ばれる）。操作部分の中の構造判定であり、置き換え対象ではなく、live region の**中で**動き続ける
   - `selection-shape.ts` の `readSelectionListShape()`（L1171）と `hasDismissablePanelFooter()`（L400）はクライアント部品（`ChatSurface.tsx:593` / L948、`TerminalSplitPaneContent.tsx:731`、`useWorktreeDetailController.ts:805`）が生の文字列に対して呼ぶ。状態の reason が既に「選択リスト」と決まった後の形の読み取りで、ブラウザのバンドルに `NormalizedFrame` を持ち込めないため置き換えない（3 章）。同ファイルの `hasCommandCode*FooterAtBottom`（L346 / L358 / L370）は検出側で使われ、置き換え対象

### 1.3 検出と Auto-Yes が別の綴りを読んでいる（具体）

| 経路 | どこで `NormalizedFrame` を作るか | 入力の綴り |
|---|---|---|
| 状態（サイドバー・`wait`・送信ガード） | `src/lib/detection/status-detector.ts:230` `normalizeFrame(output)` | **生**（ANSI・罫線あり） |
| 状態の中の「本物のダイアログか」（#2991） | 同 L238-239 `evaluateDialogPresence(cliToolId, …, output)` → `auto-yes-dialog-gate.ts:323` | 生 |
| Auto-Yes のダイアログ判定 | `src/lib/auto-yes-poller.ts:671` `evaluateAutoYesDialogGate(…, cleanOutput)` → `auto-yes-dialog-gate.ts:323` `normalizeFrame(frame)` | **`stripBoxDrawing(stripAnsi(raw))`**（`auto-yes-poller.ts:383`） |
| Auto-Yes のプロンプト検出 | `auto-yes-poller.ts:557` → `src/lib/polling/response-checker.ts:326` `detectPromptOnCleanFrame` → L383 汎用 `detectPrompt(cleanOutput)`。agy だけ L404-409 で `normalizeFrame(rawFrame ?? cleanOutput)` | 罫線なし（agy の述語だけ生） |
| Auto-Yes の codex 起動画面ガード | `auto-yes-poller.ts:603` `getCodexLifecycleDialog(cleanOutput)` | 罫線なし |
| `respond` の数字送信ガード | `src/lib/prompt-answer-sender.ts:358` `normalizeFrame(frame)`（`capturePane` の結果） | 生 |
| codex の model picker 判定 | `tools/codex/detect.ts:545` `normalizeFrame(cleanOutput)` | 罫線なし |

`stripBoxDrawing`（`cli-patterns.ts:3162`）は L3168 で `─` `│` `┃` `╹` `▀` などだけの行を空にする。claude の入力欄は `^─{10,}$` の 2 本の罫線で見つける（`composer-text.ts:170` の `findClaudeInputBox`）ので、
**Auto-Yes の綴りでは claude の入力欄は見つからない**。command-code（`cli-patterns.ts:2904` の `findCommandCodeChromeStart`）、opencode 系の `┃` 枠も同じ。
つまり今日の Auto-Yes は、状態の側が使っている「入力欄」という目印を、構造上読めない綴りで判定している。

もう 1 つ: 状態の側の `isStalePrompt` / `requireVouchedPrompt`（`run-detection.ts:114` / L119）は Auto-Yes では呼ばれない。
Auto-Yes の拒否は「ゲートが `enforce` のツール（`auto-yes-dialog-gate.ts:107-152` の表で claude / codex / copilot / opencode / opencode-v2）の `detectDialog`」と「agy だけの追加述語」の 2 つで、
`legacy` の agy / command-code は汎用の番号リスト推定（と上の「入力の壁」）だけで答える。

---

## 2. 新しい形

### 2.1 型（`src/lib/detection/tools/types.ts` に追加）

> 実装（段階 A・B）で確定した形。設計時の案（生の行 index、`spec` を引数に取る拒否関数）からの変更点は §8 にまとめた。

```ts
export type LiveRegionAnchor = 'composer' | 'dialog' | 'none';

export interface LiveRegion {
  readonly tool: CLIToolType | null;      // どのツールの宣言で求めたか（tool なしで作ったフレームは null）
  readonly anchor: LiveRegionAnchor;
  readonly startRow: number;              // contentLines の index（'none' なら 0）
  readonly composerEndRow?: number;       // 'composer' のときだけ: 入力欄の塊の最終行
  readonly composerAtBottom: boolean;     // 入力欄が画面の下端（その下に答えられるものが無い）
  readonly composerHidesDialogs: boolean; // 宣言の composerHidesDialogs を写したもの
  readonly lines: readonly string[];      // contentLines.slice(startRow)
}

export interface NormalizedFrame {
  // …既存 6 フィールドは変えない…
  readonly liveRegion: LiveRegion;
}
```

**index は `contentLines` に取る。** 既存のツール規則はどれも `frame.contentLines` を読んでいる
（claude の `findClaudeInputBox`、codex の `findCodexContentEnd`、agy の #2845 述語、copilot の `findCopilotChromeStart`）。
座標系を揃えることで、宣言は既存の関数をそのまま呼べ、規則は「自分の footer の行」と「入力欄の行」を同じ番号で比べられる。
SGR を読む目印（codex）には `LiveRegionRows.raw` で生のキャプチャを渡す。

`composerAtBottom` は「入力欄が見つかった」とは別の値である。codex の承認ダイアログでは、最下段の本物の `›` 行は
ダイアログの上に残った利用者の発話（`codex-dialogs-0157/approval.txt` L24）で、region はそこから始まるが下端ではない
（§7 codex）。拒否規則が見るのは `composerAtBottom` だけ。

### 2.2 宣言（`ToolDetectorSpec.liveRegion`）

```ts
export interface LiveRegionSpec {
  readonly composer: LiveRegionMarker;     // 必須
  readonly dialogTop?: LiveRegionMarker;   // 入力欄が無いとき
  readonly composerHidesDialogs: boolean;  // 答えを受ける画面がすべて入力欄を消すか
}
export interface LiveRegionMarker { locate(rows: LiveRegionRows): LiveRegionHit | null; }
export interface LiveRegionHit { start: number; end?: number; atBottom?: boolean; }
export interface LiveRegionRows { raw: string; contentLines: readonly string[]; }
```

共有の部品（`src/lib/detection/tools/live-region.ts`）:

| 部品 | 中身 | 使うツール |
|---|---|---|
| `fencedComposer(find)` | ツール自身の構造的な finder（罫線・グリフ・罫線）が返す先頭行から最終行まで。下端に固定された塊なので `atBottom` は常に真 | claude（`findClaudeInputBox`）、command-code（`findCommandCodeChromeStart`。直下が `❯ 1.` なら質問ダイアログのカーソルとして拒否）、copilot（`findCopilotChromeStart`） |
| `bottomMostComposerRow({ isComposerRow, atBottom })` | 下から最初に入力欄と認めた行。下端かどうかは宣言が決める | agy（空の `>`。下に番号行も `↑/↓ Navigate` も無ければ下端） |
| codex 専用の目印（`tools/codex/live-region.ts`） | 最下段の `CODEX_GENUINE_PROMPT_LINE`（`findCodexComposerRow`、#892）から始まり、下端かどうかは `isCodexComposerAtBottom`（#2841: 生の SGR → 綴りなしの最終行） | codex |
| `OPENCODE_GUTTER_COMPOSER`（`tools/opencode-gutter-live-region.ts`） | 下端 4 行以内の `ctrl+[tp]` footer、その上 3 行以内の `╹▀` 罫線、その上に続く `┃` 行の塊 | opencode、opencode-v2 |
| `ruleAboveOptionRun({ footer, rule, maxRows })` | 下から footer、その上の `1.` の選択肢、そこから上で最初の罫線 | claude、command-code（ダイアログ枠） |
| `dialogTopFrom(find)` | ツール自身の関数が返すダイアログ枠の先頭 | agy（`locateAntigravityDialogRegion`）、copilot（`╰` に対応する `╭`） |
| `opencodeGutterDialogTop(title)` | 下端 60 行以内の `┃` 行で `title` に当たるもの | opencode（`△ Permission required`）、opencode-v2（同 ＋ `Questions`） |

`composerHidesDialogs` は claude / codex / antigravity / command-code が `true`、copilot / opencode / opencode-v2 が `false`。
copilot の `/model` picker（`copilot-live-1885/model-picker.txt`）と opencode 系の picker・command palette
（`opencode-live-2046/w80/dialog-*.txt`、`opencode-v2-live-2971/*.txt` ほか）は、**入力欄を残したまま上に重ねて描かれる**ことを
実装前の全 fixture 掃引で確かめた（入力欄が下端なのに状態が `waiting` / `detectDialog` が `picker` を返すフレームはこの 3 ツールだけ）。

各ツールの宣言は `src/lib/detection/tools/<tool>/live-region.ts` に 1 つずつ置き、`<tool>/detect.ts` は `liveRegion: X_LIVE_REGION` で同じ物を参照する。
`normalizeFrame` が読むのは `src/lib/detection/tools/live-region-specs.ts` の表で、両者が同一物であることは
`tests/unit/detection/tools/live-region-markers.test.ts` が固定する。

### 2.3 切り出し（`normalizeFrame` の 1 回）

```ts
export function normalizeFrame(output: string, tool?: CLIToolType): NormalizedFrame
export function liveRegionOf(frame: NormalizedFrame, tool: CLIToolType): LiveRegion
export function withLiveRegion(frame: NormalizedFrame, tool: CLIToolType): NormalizedFrame
```

- `tool` を渡すと `LIVE_REGION_SPECS[tool]` で 1 回だけ切り出す。省くと `{ tool: null, anchor: 'none' }`（画面全体）
- `liveRegionOf` / `withLiveRegion` は、別のツール（または tool なし）で作られたフレームを受けたときだけ切り出し直す。
  `runToolDetection` と `detectDialog` の包みは必ずこれを通すので、tool を渡さずに作ったフレーム（既存のテスト）でもツールの宣言が効く
- `registry.ts` は import しない（循環を避けるため、表は検出モジュールに依存しない）
- `src/` の `normalizeFrame(` の呼び出しはすべて tool つき（`detector-contract.test.ts` が固定）

### 2.4 共通の拒否規則（1 か所）

`src/lib/detection/tools/live-region.ts`:

```ts
/** multiple_choice で、入力欄が下端、かつ composerHidesDialogs のツール → 引用 */
export function isQuotedNumberedPrompt(region: LiveRegion, prompt: PromptDetectionResult): boolean;
/** 入力欄が下端なら、numbered のダイアログ判定は常に、keys は composerHidesDialogs のツールだけ捨てる */
export function vetoesDialog(region: LiveRegion, verdict: DialogVerdict | null): boolean;
```

- `runToolDetection`: プロンプトが見つかったら、`spec.isStalePrompt` の前に `isQuotedNumberedPrompt` を見て無効化する
- `createToolStatusDetector` が返す `detectDialog` は `vetoesDialog` で包まれる（ツールの `detectDialog` は書き換えない）
- Auto-Yes 側: `detectPromptOnCleanFrame`（`response-checker.ts`）と `assessPromptAnswerability`（`auto-yes-dialog-gate.ts`）が同じ `isQuotedNumberedPrompt` を同じ region に対して呼ぶ

`isQuotedNumberedPrompt` が `composerHidesDialogs` を要るのは、入力欄の上に picker を重ねるツールでは「入力欄が下端」が
「何も開いていない」の証明にならないから。copilot / opencode / opencode-v2 の番号リストは従来どおりそれぞれのダイアログ規則
（3 ツールとも Auto-Yes ゲートは `enforce`、opencode-v2 は `requireVouchedPrompt`）が判定する。
`tests/unit/polling/auto-yes-dialog-gate-opencode-v2-2984.test.ts` と `tests/unit/session/opencode-v2-body-numbered-list-2991.test.ts` は
「その下の層が拒否する前は、候補として読まれていた」ことを対照として固定しており、この線引きはそれとも整合する。

### 2.5 既存の型・公開 API を壊さない理由

| 変更 | 壊さない理由 |
|---|---|
| `NormalizedFrame.liveRegion` を追加 | `NormalizedFrame` を**作る**のは `normalizeFrame` だけ（`grep -rn "normalizeFrame(" src` で定義 1 か所と呼び出し 6 か所、すべて関数経由）。`NormalizedFrame` を object literal で作っているテスト・ソースは無い（`grep -rn "NormalizedFrame" tests src` で、`tools/` の外はコメント 3 か所だけ） |
| `normalizeFrame(output, tool?)` | 第 2 引数は省略可。省略時の `liveRegion` は「画面全体」で、それを読む新しい規則は anchor `'none'` で何もしない |
| `ToolDetectorSpec.liveRegion?` | 省略可。宣言の無いツールは今日の読み方のまま（`readIdleEvidence` / `detectDialog` と同じ段階的導入） |
| `evaluateAutoYesDialogGate(tool, type, frame: string \| NormalizedFrame)` | 文字列も受け続ける（その場合は `normalizeFrame(frame, tool)`）。Auto-Yes の poller だけが `NormalizedFrame` を渡すように変わる |
| `getCodexActiveDialog` / `getCodexLifecycleDialog` / `isCodexPromptReady` の引数 | 文字列のまま。中で `normalizeFrame(output, 'codex').liveRegion` を読む（`cli-tools/codex.ts` の 5 か所の呼び出しは変えない） |

---

## 3. 移行の対応表

| ファイル | 今どう動いているか | どう置き換えるか ／ 置き換えない理由 |
|---|---|---|
| `src/lib/detection/tools/types.ts` | `NormalizedFrame`（L47-60）、`ToolDetectorSpec`（L147-219） | 2.1 / 2.2 の型を足す |
| `src/lib/detection/tools/frame.ts` | `normalizeFrame(output)`（L27） | `tool?` を足し、`liveRegion` を 1 回計算する |
| `src/lib/detection/tools/live-region.ts`（新規） | — | 部品、`locateLiveRegion`、`isQuotedNumberedPrompt`、`vetoesDialog` |
| `src/lib/detection/tools/live-region-specs.ts`（新規） / `tools/<tool>/live-region.ts`（新規 7 つ） | — | 7 ツールの宣言 |
| `src/lib/detection/status-detector.ts` | L230 `normalizeFrame(output)` | `normalizeFrame(output, cliToolId)` |
| `src/lib/detection/tools/run-detection.ts` | L113-137 で `isStalePrompt` / `requireVouchedPrompt` | その前に `isQuotedNumberedPrompt`。`createToolStatusDetector` で `detectDialog` を包む |
| `src/lib/detection/cli-patterns.ts` `codexActiveRegionLines`（L438） | 最下段の `›` 行より下を返す（綴りなし） | **削除**。目印の部分は `findCodexComposerRow`（export）に名前を変え、codex の宣言はこれで region の先頭を決める。`getCodexActiveDialog` / `getCodexLifecycleDialog` は `string \| NormalizedFrame` を受け、フレームなら `liveRegion` の入力欄より下、文字列なら同じ `findCodexComposerRow` で切る（`cli-tools/codex.ts` の起動待ちループは文字列のまま） |
| `src/lib/detection/cli-patterns.ts` `isCodexPromptReady`（L389） | 最下段のダイアログ行より下に本物の入力行があるか | **残す**。問いが「入力欄が出たか」（起動待ち）で、live region の有無そのもの。中身を `liveRegion.anchor === 'composer'` と、その下にダイアログ行が無いことに書き換えるのは段階 B の任意項目（同じ答えになることを `tests/unit/cli-tools/codex*.test.ts` で確かめてから） |
| `src/lib/detection/tools/codex/cli-patterns.ts` `isCodexComposerAtBottom`（L490） | 生の SGR → 綴りなしの 2 段で「最下段が入力欄か」 | 関数は残し、**呼ぶのは codex の宣言（`tools/codex/live-region.ts`）だけ**にした（`detector-contract.test.ts` が固定）。`codex/detect.ts` の 3 か所は `liveRegionOf(frame, 'codex').composerAtBottom` を読む |
| `src/lib/detection/tools/codex/detect.ts` `isCodexStalePrompt`（L119） | 答え済み承認の下に `• Ran` などがあるか（#1160） | **残す**。入力欄が描かれる前（承認に答えた直後、実行中）の古い承認ブロックで、live region の位置では区別できない（入力欄はまだ下に無い）。理由をコメントで残す |
| `src/lib/detection/tools/codex/detect.ts` `isCodexModelPickerFrame`（L544-545） | `normalizeFrame(cleanOutput)`（綴りなし） | `string \| NormalizedFrame` を受ける。poller はその tick のフレームを渡す |
| `src/lib/detection/tui-detection-frame.ts` | claude の footer で全ツールのフレームを切る（L59-87） | **段階 B では残す**。`detectPrompt` が内部で直接呼び（`prompt-detector.ts:194`、`prompt-detect-multiple-choice.ts:992`）、`NormalizedFrame` を持たない呼び出し元も多い。live region と同じ答えになる fixture（`tests/fixtures/tui-frame-footer-2776/` の 12 本）を `tui-frame-footer-2776.test.ts` が固定しているので、退役は 6 章の未決 6 で別に決める |
| `src/lib/detection/tools/claude/detect.ts` `selectionFooterRows`（L128） | 入力欄があればその行以降、無ければ末尾 15 行 | `frame.liveRegion.lines` の末尾 15 行に置き換え（同じ入力欄を同じ部品で見つけるので答えは変わらない） |
| `src/lib/detection/tools/claude/picker-chrome.ts` `hasPickerFooterBelow`（L179） | プレビュー枠の下に footer があるか（parser の中） | **置き換えない**。操作部分の始まりではなく、操作部分の中の枠の判定（1.2-5） |
| `src/lib/detection/tools/antigravity/detect.ts` L68 / L89 / L116 / L135 | survey・選択画面・番号リストの 3 つで「下に入力欄があれば引用」 | L116 `isAntigravityQuotedNumberedList` と L135 `isStalePrompt` は**削除**（共通拒否 `isQuotedNumberedPrompt` と agy の宣言 `bottomMostComposerRow` に移った）。L68 の survey と L89 の選択画面は**残す**: 判定の材料が「footer の行より下に入力欄があるか」で、入力欄の**下**に描かれる Switch Model picker（`picker-switch-model.txt`）を含むため、入力欄から下を見る live region とは向きが逆 |
| `src/lib/detection/cli-patterns.ts` `locateAntigravityDialogRegion`（L2629） | footer の下に入力欄があれば null、境界行（`ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN`、L2571）で始まりを決める | **そのまま残し**、agy の `dialogTop` 宣言として呼ぶ（`dialogTopFrom`）。agy の reader（`detectAntigravityNumberedDialogPrompt`）が使う関数でもある |
| `src/lib/detection/tools/command-code/detect.ts` L191-192 / L303 / L326 と `selection-shape.ts` L289 / L346 / L358 / L370 | フッタが `lastLines` の下端にあるか（#2846） | `beforePrompt` の先頭で `liveRegionOf(frame, 'command-code').composerAtBottom` なら null（3 つのオーバーレイと質問ダイアログはどれも入力欄を消す）。`…AtBottom` の 4 関数は入力欄の無いフレームのために残す |
| `src/lib/detection/selection-shape.ts` `readSelectionListShape`（L1171）・`hasDismissablePanelFooter`（L400） | クライアント部品が生の文字列から読む | **置き換えない**。ブラウザのバンドルに検出モジュールを入れない（`ChatSurface.tsx` などのクライアント部品）。状態の reason が決まった後の形の読み取りで、引用の判定はサーバ側の reason が先に済ませている |
| `src/lib/detection/tools/opencode-v2/detect.ts` `requireVouchedPrompt`（L161） | `detectDialog` が認めない番号リストを無効化（#2991） | **残す**。共通拒否は入力欄が見えるときだけ働く。v2 では答えの最中（入力欄がまだ無い）の番号リストもあり、`requireVouchedPrompt` はそれも拒む。2 つは重なるが矛盾しない |
| `src/lib/detection/tools/opencode/detect.ts` L136 | 承認ストリップを末尾 15 行で読む（窓の距離だけ） | **変えない**。opencode は picker を入力欄の上に重ねる（`composerHidesDialogs: false`）ので、入力欄が下端でも `keys` の判定は捨てない。承認ストリップは入力欄を消して描かれる（§7）ので、入力欄が下端のフレームでこの分岐が当たるのは引用だけだが、その判定は Auto-Yes ゲート（`enforce`）と窓の距離に任せたまま（§8） |
| `src/lib/detection/tools/copilot/detect.ts` / `cli-patterns.ts` L1860 / L2263 | 最下行の状態バー・picker footer | 宣言の入力欄の目印は既存の `findCopilotChromeStart`（`fencedComposer`）。`isCopilotSelectionFrame` / `readCopilotStatusBar` は残す（picker・状態の判定であり、始まりの判定ではない）。copilot は picker を入力欄の上に重ねるので `composerHidesDialogs: false` |
| `src/lib/polling/response-checker.ts` `detectPromptOnCleanFrame`（L326） | 汎用 `detectPrompt(cleanOutput)`、agy だけ L404-409 で引用を拒否 | 第 6 引数に `frame?: NormalizedFrame` を足し、渡されたら**全ツールに** `isQuotedNumberedPrompt` をかける。L404-409 の agy 専用の分岐は消す |
| `src/lib/polling/response-checker.ts` `isNumberedDialogVouched`（L495） | `evaluateDialogPresence(…, frame)`（生） | 変えない（既に生を渡している）。中で `normalizeFrame(frame, tool)` になり live region が効く |
| `src/lib/polling/auto-yes-dialog-gate.ts` L311-323 | `normalizeFrame(frame)`（Auto-Yes からは綴りなし） | `NormalizedFrame` を受ける。文字列なら `normalizeFrame(frame, tool)` |
| `src/lib/polling/auto-yes-dialog-gate.ts` `assessPromptAnswerability`（L489-493） | 生の `frame` から `stripBoxDrawing(stripAnsi(frame))` を作り汎用 `detectPrompt` | 生の `frame` で `NormalizedFrame` を 1 回作り、`detectPromptOnCleanFrame(…, frame)` と `evaluateDialogPresence` に同じものを渡す |
| `src/lib/auto-yes-poller.ts` L557 / L603 / L671 | 綴りなし（L603 / L671）と生（L557 の第 4 引数）が混在 | `detectAndRespondToPrompt` の冒頭で `const frame = normalizeFrame(rawOutput ?? cleanOutput, cliToolId)` を 1 回作り、3 か所すべてに渡す。`rawOutput` は L883 で必ず取れている |
| `src/lib/prompt-answer-sender.ts` L358 | `normalizeFrame(frame)`（生） | `normalizeFrame(frame, params.cliToolId)` |
| `src/lib/cli-tools/antigravity.ts` L180 | `normalizeFrame(output)` | `normalizeFrame(output, 'antigravity')` |
| `src/lib/agent-health/screen-checks.ts` / `scripts/agent-health/probe-tool.ts` / `scripts/agent-health/main.ts` | 不合格時は `paneEvidence`（抜粋）だけ | 5 章段階 C。生のフレーム全体をファイルに保存し、レポートの check に `framePath` を足す |

---

## 4. テスト計画

### 4.1 受入基準 → テスト

| 受入基準 | テストファイル（新規は ★） | 何を固定するか |
|---|---|---|
| 7 ツールの目印と根拠 fixture が設計書にある | ★`tests/unit/detection/tools/live-region-markers.test.ts` | 7 章の表を**そのまま**データにして、各 fixture の `liveRegion.anchor` と `startRow`（行番号 − 1）を固定する。表とテストがずれたら赤 |
| `NormalizedFrame` に操作部分が載り、ツールごとの切り出しコードが無い | `tests/unit/detection/tools/detector-contract.test.ts`（追記） | 7 ツールの detector が `liveRegion` を宣言している。`codexActiveRegionLines` / `isAntigravityQuotedNumberedList` / `isCodexComposerAtBottom` を `src/` から grep して 0 件（残すものは 3 章の表のとおり理由コメントつき、grep の除外に名前で入れる） |
| Auto-Yes が同じ操作部分を読む（テストで固定） | ★`tests/unit/lib/polling/auto-yes-live-region-3183.test.ts` | ① `detectAndRespondToPrompt` が `normalizeFrame` を**1 回だけ、生のキャプチャで**呼び、同じオブジェクトがゲートに届く（`vi.spyOn`）。② 7 ツールの全 fixture について「状態が `waiting` かつ `hasActivePrompt`」と「Auto-Yes が答える」の組が 4.2 の表どおり。③ 変異: `LIVE_REGION_SPECS[tool]` の `composer` を「見つからない」に差し替えると、状態と Auto-Yes の**両方**が同時に変わる（片方だけ変わったら赤） |
| 7 ツール × 陽性・陰性の fixture テスト | ★`tests/unit/detection/tools/live-region-quoted-dialog.test.ts` | 4.2 の 14 本。陽性は状態 `waiting`（承認待ち）と Auto-Yes の対象、陰性は `ready` かつ `hasActivePrompt=false` で Auto-Yes は答えない |
| 既存の検出テストが通る（期待値を緩めない） | 既存すべて。特に `tests/unit/detection/tools/dialogs.test.ts`、`tests/unit/lib/detection/tui-frame-footer-2776.test.ts`、`codex-quoted-dialog.test.ts`、`antigravity-quoted-dialog.test.ts`、`command-code-quoted-footer.test.ts`、`claude-quoted-selection-footer.test.ts`、`tests/unit/lib/polling/antigravity-quoted-dialog-autoyes.test.ts`、`tests/unit/detection/tools/live-reply-numbered-list-2997.test.ts`、`tests/unit/detection/tools/opencode/agent-health-frames-3021.test.ts` | 期待値は変えない。変える必要が出たら、それは live region の宣言の誤りとして扱う |
| agent-health の `screen-*` 不合格でフレーム全体が残る | ★`tests/unit/lib/agent-health/frame-archive.test.ts` | `os.tmpdir()` 配下の `mkdtemp` に書く（`$HOME` に書かない）。`fail` の 1 件 → `<dir>/frames/<date>/<tool>-<checkId>.txt` が**生の入力とバイト一致**。`pass` → 書かない。`screen-picker` の複数画面 → `<tool>-screen-picker-<screen>.txt` が画面数だけ。書けないとき（読み取り専用ディレクトリ）でもレポートは書かれ、`framePath` が無いだけ |
| lint / typecheck / unit | CI | — |

### 4.2 7 ツールの陽性・陰性 fixture

「Auto-Yes の対象」は `detectAndRespondToPrompt` が `'responded'` を返すこと（送信は既存テストと同じくモック）。
答えの形が `keys`（矢印キーで答える）のダイアログは、ゲートが**設計どおり答えない**（`auto-yes-dialog-gate.ts` の `allowed` は `answerMode === 'numbered'` のときだけ真）ので、陽性には `numbered` のダイアログを使う。

| ツール | 陽性（本物のダイアログ） | 陰性（同じ文面の引用＋下に入力欄） | 陰性の種類 |
|---|---|---|---|
| claude | `tests/unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt` | `tests/fixtures/claude-idle-numbered-list-2457/live-2997/claude-reply-numbered-list-21284.txt`（`Do you want to proceed?` / `❯ 1. Yes` / `2. No` を返答として描いた実機） | 実機 |
| codex | `tests/fixtures/codex-dialogs-0157/approval.txt` | `tests/fixtures/codex-dialogs-0157/quoted-approval-idle.txt`（承認ダイアログの文面を返答として描いた実機） | 実機 |
| antigravity | `tests/fixtures/antigravity-live-2364/dialog-bash-oneline.txt` | `idle-after-deny.txt` の入力欄の上に `dialog-bash-oneline.txt` の L26-L38 を差し込んだ合成（`tests/unit/lib/polling/antigravity-quoted-dialog-autoyes.test.ts` の `quoteAboveComposer` と同じ作り方） | **合成**（6 章 未決 2） |
| command-code | `tests/fixtures/command-code-live-2250/dialog-shell-command.txt` | `tests/fixtures/tui-frame-footer-2776/command-code-1.58.0-idle-quoted-footers.txt` の入力欄の上に `dialog-shell-command.txt` の L29-L40 を差し込んだ合成（`command-code-quoted-footer.test.ts` の `quotedAboveComposer` と同じ） | **合成**（未決 2） |
| copilot | `tests/unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt` | `copilot-live-1885/turn-complete.txt` の入力欄の上に `permission-dialog.txt` の L994-L1000 を枠なしで差し込んだ合成 | **合成**（未決 2） |
| opencode | `tests/unit/lib/detection/fixtures/opencode-live-1893/permission-bash.txt`（`keys`: 状態は `waiting`、Auto-Yes は**答えない**のが正しい） | `tests/fixtures/opencode-agent-health-3021/quoted-dialog-reply-done.txt`（承認ストリップを返答と発話の両方に描いた実機） | 実機。陽性の Auto-Yes 側は未決 1 |
| opencode-v2 | `tests/fixtures/opencode-v2-dialogs-2984/question.txt`（`numbered`） | `tests/fixtures/opencode-v2-dialogs-2984/quoted-dialog-reply.txt`（`❯ 1. Yes` / `2. No` を返答として描いた実機） | 実機 |

陰性の追加対照（入力欄が無く、引用の**下**に本物のダイアログがある → 陽性のまま）:
`tests/fixtures/tui-frame-footer-2776/claude-2.1.278-approval-below-quoted-footers.txt`、`claude-2.1.278-picker-below-quoted-footers.txt`、
`tests/fixtures/opencode-v2-dialogs-2984/question-under-quoted-dialog.txt`。これらは「入力欄より上は会話」だけでは足りず、
ダイアログ枠の先頭（`dialogTop`）で引用を落とせることを確かめる。

### 4.3 陽性・陰性対照の考え方

- **変異で空虚な緑を防ぐ**（`live-region-quoted-dialog.test.ts` と `auto-yes-live-region-3183.test.ts`）:
  - 陽性の下に陰性の入力欄の塊を描き足すと、claude / codex / antigravity / command-code の 4 ツールで `hasActivePrompt: false`・`waiting` 以外に倒れる。copilot と opencode 系は `composerHidesDialogs: false` で、この変異は live region の主張の外（§2.4）
  - 陰性から入力欄の塊を消すと `waiting`・`hasActivePrompt: true` に倒れるのは antigravity。ほかの 6 ツールは入力欄の行頭グリフ（`❯` / `›`）で汎用 parser 自体が止まる（#287 の壁）か、ゲートが判定するので、入力欄を消しても live region 以外の防御が残る。agy の `>` だけがどちらにも当たらない（#2851 が Auto-Yes まで届いた理由）
  - `LIVE_REGION_SPECS.antigravity.composer` を「何も見つけない」に差し替えると、同じ陰性が状態 `waiting` と Auto-Yes `responded` に**同時に**倒れ、戻すと同時に戻る
- **目印の実測表**: §7 を `live-region-markers.test.ts` の表にした（24 行。最初の非空行が引用した物理行と一致すること）。全 fixture の anchor 分布は実装前の掃引で確かめ（§8）、表には「入力欄」「ダイアログ枠」「入力欄だが下端でない」の 3 種を各ツールで最低 1 本ずつ入れた

---

## 5. 実装の分割案

| 段階 | 中身 | 振る舞いの変化 | 見積り |
|---|---|---|---|
| A. 土台 | 型、`live-region.ts` の部品、7 ツールの宣言、`normalizeFrame(output, tool?)`、`status-detector.ts:230` で tool を渡す、7 章の測定テスト、掃引表 | **無し**（フィールドを足すだけで、誰も読まない） | 小〜中 |
| B. 読み替え | 共通拒否（`run-detection`、`detectDialog` の包み）、Auto-Yes の `NormalizedFrame` 1 個化（poller・response-checker・gate・answer-sender）、codex 2 つの切り出しの統合、各ツールの個別の引用判定の削除・置き換え、4.2 の 14 本＋変異、合成 fixture 3 本 | 有り（ただし既存テストの期待値は変えない） | 大 |
| C. agent-health | `src/lib/agent-health/frame-archive.ts`（新規）、`evaluateScreen` / `evaluatePickerScreens` の fail で保存、`probe-tool.ts` の `recordScreen`（L207）から保存先を渡す、`main.ts` で保存先を決める、レポートの check に `framePath`、`docs/user-guide/agent-health.md` に 1 段落 | 有り（ファイルが増えるだけ） | 小 |

C は A・B と独立している（検出モジュールを触らない）。**2 本の契約にするなら「A＋B」と「C」**、A を先に単独で入れたいなら「A」と「B＋C」。

### scope.allow の候補

**段階 A**
```
src/lib/detection/tools/types.ts
src/lib/detection/tools/frame.ts
src/lib/detection/tools/live-region.ts
src/lib/detection/tools/live-region-specs.ts
src/lib/detection/tools/*/live-region.ts
src/lib/detection/tools/*/detect.ts          # liveRegion: X を 1 行足すだけ
src/lib/detection/status-detector.ts
tests/unit/detection/tools/live-region-markers.test.ts
tests/unit/detection/tools/detector-contract.test.ts
tests/unit/detection/tools/fixture-sweep.ts
changelog.d/**
dev-reports/module-reference/**
```

**段階 B**
```
src/lib/detection/tools/**
src/lib/detection/cli-patterns.ts
src/lib/detection/selection-shape.ts
src/lib/detection/status-detector.ts
src/lib/polling/response-checker.ts
src/lib/polling/auto-yes-dialog-gate.ts
src/lib/auto-yes-poller.ts
src/lib/prompt-answer-sender.ts
src/lib/cli-tools/antigravity.ts
src/lib/cli-tools/codex.ts                   # 呼び出しは変えない予定。import の整理が要る場合だけ
tests/unit/detection/**
tests/unit/lib/detection/**
tests/unit/lib/polling/**
tests/unit/lib/auto-yes-poller-*.test.ts
tests/unit/cli-tools/codex*.test.ts
tests/fixtures/live-region-3183/**           # 合成 fixture 3 本と README（作り方と元の fixture・行番号）
changelog.d/**
dev-reports/module-reference/**
```

**段階 C**
```
src/lib/agent-health/frame-archive.ts
src/lib/agent-health/screen-checks.ts
src/lib/agent-health/report.ts
src/lib/agent-health/types.ts               # check に framePath を足す
scripts/agent-health/probe-tool.ts
scripts/agent-health/main.ts
tests/unit/lib/agent-health/frame-archive.test.ts
tests/unit/lib/agent-health/cli-and-screens.test.ts
docs/user-guide/agent-health.md
changelog.d/**
dev-reports/module-reference/**
```

### 段階 B の手順（この順で 1 コミットずつ）

1. `isQuotedNumberedPrompt` / `vetoesDialog` と、それを使う `run-detection` の 2 か所。既存テストを全部流して緑を確認
2. Auto-Yes の 1 個化（poller → response-checker → gate → answer-sender）。`auto-yes-live-region-3183.test.ts` の ①③
3. codex: `codexActiveRegionLines` 削除、`isCodexComposerAtBottom` を宣言へ移す、`codex/detect.ts` の 3 か所を消す
4. agy・command-code・claude・opencode の個別判定を 3 章の表どおり置き換え
5. 4.2 の 14 本＋変異、掃引表の確定

---

## 6. 未確認・未決の事項と決め方

| # | 事項 | なぜ未決か | 決め方 |
|---|---|---|---|
| 1 | opencode v1 の「陽性: Auto-Yes の対象になる」 | v1 の検出規則が返すダイアログは**すべて** `answerMode: 'keys'`（`tools/opencode/prompt.ts:93` / L97 / L117）。数字を打つと `1` がボタン行に吸われ Enter が強調中の項目を確定する（#1893 / #1896）ため、ゲートは答えない設計。受入基準をそのまま満たす fixture は**原理的に作れない** | 陽性を「状態 `waiting`、ゲートがダイアログを認める（`dialog !== null`）、`allowed=false`（`keys` だから）」と読み替え、PR 説明で Issue 起票者に確認する。opencode-v2 の承認ストリップも同じ（陽性は `numbered` の質問フォームで取る） |
| 2 | agy・command-code・copilot の陰性に**実機の**引用 fixture が無い | 3 ツールとも、ダイアログの文面を返答に描かせた実機キャプチャがリポジトリに無い（agy と command-code は既存テストが実機フレームから合成している。copilot は picker の footer を引用した `copilot-picker-1895/picker-vocabulary-in-response.txt` L67-68 だけで、承認ダイアログの文面の引用は無い） | 段階 B は合成で進める（既存の 2 ツールの前例どおり、元 fixture と行番号を README に書く）。実機の採取は段階 C のあと agent-health に任せる: `screen-quoted-dialog` のプロンプト（`spec.prompts.quoted`、`probe-tool.ts:484`）が既に「引用させる」手順なので、C で**合格時も保存する**オプション（例 `--save-frames all`）を足し、1 回の日次実行で 7 ツール分の実機フレームが揃う。実機が要る理由: 返答の描き方（字下げ・`⏺` / `•` / `●` の行頭記号・折り返し）はツールの版ごとに違い、合成ではそこを測れない |
| 3 | copilot 1.0.82 のダイアログ枠 | `verified-against.ts:91` は copilot を 1.0.82 で測ったとするが、`copilot-live-2269/` に**ダイアログのフレームが無い**（boot-idle / turn-* だけ）。`╭` … `╰` の枠が 1.0.82 でも同じかは未確認 | 2 と同じ採取（agent-health の `screen-approval` の保存フレーム）で確かめる。それまで copilot の `dialogTop` は 1.0.80 の実測（7 章）で宣言し、1.0.82 で見つからなければ anchor `'none'`（今日の読み方）に落ちるだけなので害は無い |
| 4 | command-code 1.58.0 のダイアログ | 1.58.0 の採取は idle 2 本（`tui-frame-footer-2776/command-code-1.58.0-*`）だけで、ダイアログは 1.40.1（`command-code-live-2250/dialog-shell-command.txt`）と 1.49.0（`*-1490.txt`）。README L92 は 1.49.0 のダイアログが「1.40.1 と形が同じ」と書く | 3 と同じ。段階 A の掃引表で 1.40.1 / 1.49.0 の両方が `dialog` に当たることを固定しておく |
| 5 | claude の入力欄も罫線も無い画面（起動時の信頼ダイアログ、全画面の `/model`） | `tests/fixtures/claude-trust-dialog-3078/allowlist-default-no-2-1-287.txt` は L11 に `Enter to confirm · Esc to cancel` があるだけで、`─` の罫線を持たない（grep で 0 件）。`ruleAboveOptionRun` が当たらない | anchor `'none'`（画面全体）で正しい。起動時は会話がまだ無く、引用の危険が無い。段階 A の測定テストで `'none'` を固定する |
| 6 | `normalizeTuiFrameForDetection` の claude footer 切り（全ツールに効いている）を退役させるか | 1.2-2 のとおり、`detectPrompt` が内部で直接呼んでおり、`NormalizedFrame` を持たない呼び出し元（`detectPrompt` の利用者すべて）に効いている。live region で置き換えると、その全員に tool を渡す必要がある | 段階 B では残す。B のあと、`tui-frame-footer-2776/` の 12 本と `canary/` で「footer 切りの結果 ⊆ live region」を測るテストを足し、全部で包含が成り立てば別 Issue で退役させる。成り立たない fixture があれば、その行を理由として残す |
| 7 | agent-health のフレームの保存先 | Issue の例は `dev-reports/agent-health/frames/<date>/` だが、日次確認のレポートは `~/.commandmate/agent-health/reports/<date>.json`（`scripts/agent-health/main.ts:65` の `DEFAULT_DIR`、L195）で、`dev-reports/` は worktree 相対かつ `.gitignore:59` で無視される | **レポートと同じ親ディレクトリ**に置く（既定 `~/.commandmate/agent-health/frames/<date>/`、`--out` を変えればその隣）。日次確認は常駐 worktree（`../commandmate-agent-health`）から走るので、worktree 相対だと他の worktree から見えない。レポートの check に `framePath`（絶対パス）を足して、報告から辿れるようにする |
| 8 | 保存するフレームの形 | fixture の README はどれも「生の `capture-pane -p -e` を ANSI 付きのまま」を求める（例 `antigravity-live-2364/README.md`、`copilot-live-1885/README.md`）。一方 `paneEvidence` は ANSI を除く | `tmux.capture` が返した**生の文字列をそのまま**書く（`probe-tool.ts:191-194` の `look()` が `lastFrame` に持っている）。版・画面サイズ・checkId・判定は同名の `.json` に分けて書き、`.txt` を 1 バイトも変えない。fixture に昇格させるときの匿名化（利用者名・一時ディレクトリ名を同じ桁数で置き換える、`tui-frame-footer-2776/README.md` の流儀）は人が行う |
| 9 | 生の SGR が無い入力（綴りなしの呼び出し元） | 段階 B のあとも、`normalizeFrame` を綴りなしの文字列で呼ぶ外部の呼び出しが残る可能性がある | 宣言の部品はすべて「生 → 綴りなし」の 2 段（codex の今日の `isCodexComposerAtBottom` と同じ）。罫線が消えた綴りでは `fencedComposer` が当たらず anchor `'none'` に落ちる＝今日の読み方なので、悪化はしない。段階 B の完了条件として `grep -rn "normalizeFrame(" src` の全呼び出しが tool つき・生の入力であることを確認する |

この設計書の作成では実機の CLI・tmux・サーバーを動かしていない。上の採取はすべて段階 C 以降、または別契約で行う。

---

## 7. fixture の実測表（7 ツールの「操作部分の始まり」）

行番号は fixture ファイルの物理行（1 始まり）。「入力欄」は anchor `'composer'`、「ダイアログ枠」は anchor `'dialog'` の目印。
版は fixture の README（または画面上のバナー）から読んだもの。

### claude

| 項目 | 内容 |
|---|---|
| 入力欄の目印 | `fencedComposer({ glyph: /^[>❯]/, maxFooterRows: 4, maxBoxRows: 40 })` — 今日の `findClaudeInputBox`（`composer-text.ts:170`。`CLAUDE_STATUS_BAR_MAX_ROWS = 4`、`CLAUDE_INPUT_BOX_MAX_ROWS = 40`）と同じ。開き罫線の行が start |
| 入力欄の根拠 | `tests/fixtures/tui-frame-footer-2776/claude-2.1.278-idle-quoted-footers.txt`（2.1.278）: L997 `────`、L998 `❯ just reply noted`、L999 `────`、L1000 `⏸ manual mode on · …`。引用 L58 / L61 / L65 / L67 は start（L997）より上 |
| | `tests/fixtures/claude-idle-numbered-list-2457/live-2997/claude-reply-numbered-list-21284.txt`（2.1.284）: 引用 L9-11 / L18-20（`Do you want to proceed?` / `❯ 1. Yes` / `2. No`）、入力欄 L57 `────` / L58 `❯` / L59 `────` / L60 状態行 |
| ダイアログ枠の目印 | `ruleAboveOptionRun({ rule: /^─{10,}$/, footer: isClaudeFooter })` — 下から footer、その上の番号選択肢の先頭、そこから上で最初の `─` 罫線が start。footer の下の task panel はダイアログの外だが live region には含める（末尾まで） |
| ダイアログ枠の根拠 | `tests/fixtures/tui-frame-footer-2776/claude-2.1.278-bash-approval.txt`: 罫線 L12、`❯ 1. Yes` L20、footer `Esc to cancel · Tab to amend` L25 |
| | `tests/unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt`: 罫線 L97、`❯ 1. Yes` L104、footer L108、task panel L994-1000（footer の下） |
| | `tests/fixtures/tui-frame-footer-2776/claude-2.1.278-askuserquestion-picker.txt`: 罫線 L17、`❯ 1. Red` L22、**枠の中の 2 本目の罫線 L27**、footer L30。「footer から上で最初の罫線」だと L27 を取り違えるので、**選択肢の先頭から上**に探す |
| | `tests/fixtures/tui-frame-footer-2776/claude-2.1.278-edit-approval.txt`: 罫線 L46、差分の `╌` 行 L49 / L52（`─` ではないので当たらない）、`❯ 1. Yes` L54、footer L58 |
| | 引用の下の本物（陰性の追加対照）: `claude-2.1.278-approval-below-quoted-footers.txt` 引用 L61 / L67、罫線 L88、`❯ 1. Yes` L96、footer L102 |
| 当たらない画面 | `tests/fixtures/claude-trust-dialog-3078/allowlist-default-no-2-1-287.txt`: 罫線 0 本、footer `Enter to confirm · Esc to cancel` L11 → anchor `'none'`（未決 5） |

### codex

| 項目 | 内容 |
|---|---|
| 入力欄の目印 | codex の目印（`tools/codex/live-region.ts`） — 生の最下段の `›` 行を SGR で分類し `composer` ならその行が start（`findCodexBottomGlyphRow`、`tools/codex/cli-patterns.ts:352`）。SGR が無ければ最下段の `CODEX_GENUINE_PROMPT_LINE`（`cli-patterns.ts:368`、番号付き `› 1.` を除く） |
| 入力欄の根拠 | `tests/fixtures/codex-dialogs-0157/quoted-approval-idle.txt`（0.157.1）: 利用者の発話 L37 `› Reply with exactly…`、その中の引用 L40 `› 1. Yes, proceed (y)` と L42 footer、返答の引用 L45-49、入力欄 L997 `› Ask Codex to do anything`、状態行 L999-1000 |
| | `tests/fixtures/claude-idle-numbered-list-2457/live-2997/codex-reply-dialog-glyph-01571.txt`（0.157.1）: 返答の引用 L33 `› 1. Yes, continue` / L34 / L35 `Press enter to continue`、入力欄 L57、状態行 L59-60 |
| 注意 | 発話の行（L37）は綴りなしでは `CODEX_GENUINE_PROMPT_LINE` に当たる。生では SGR の dim で `transcript-echo` と分かれる（`tools/codex/cli-patterns.ts` の `readCodexGlyphRowKind`）。綴りなしの段は「最下段」なので L997 が勝つ |
| ダイアログ枠の目印 | 宣言しない（codex はダイアログ中に入力欄を消し、ダイアログが下端を占める。入力欄が無ければ anchor `'none'` で今日と同じ） |
| ダイアログの根拠（陽性） | `tests/fixtures/codex-dialogs-0157/approval.txt`: 発話 L24 `› Run the shell command: touch probe.txt`、質問 L987、`› 1. Yes, proceed (y)` L996、footer `Press enter to confirm or esc to cancel` L1000。最下段の**本物の** `›` 行（番号付きを除く）は発話の L24 なので、region は anchor `'composer'`・start L24・`composerAtBottom: false`（生の最下段の `›` 行 L996 は SGR で `option`）。#892 の「入力行より下が active」と同じ切り方 |
| | `tests/unit/lib/detection/fixtures/codex-live-1628/approval-run-command.txt`: 質問 L44、`› 1.` L51、footer L55 |

### antigravity

| 項目 | 内容 |
|---|---|
| 入力欄の目印 | `bottomMostComposerRow` — 最下段の空の `>`（または mode banner。`ANTIGRAVITY_PROMPT_PATTERN`、`cli-patterns.ts:2468`）の行が start。その下に番号行（`ANTIGRAVITY_NUMBERED_OPTION_PATTERN`）も `↑/↓ Navigate`（`ANTIGRAVITY_SELECTION_LIST_PATTERN`）も無ければ下端 |
| 入力欄の根拠 | `tests/fixtures/antigravity-live-2364/idle-after-deny.txt`（1.1.27）: L41 `────`、**L42 `>`（start）**、L43 `────`、L44 `? for shortcuts`。発話の行（L30 `> Using the Bash tool, …`）は `>` の後に文字があるので `ANTIGRAVITY_PROMPT_PATTERN`（`$` で終わる）に当たらない |
| ダイアログ枠の目印 | footer `↑/↓ Navigate` から上で最初の境界行 `ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN`（`cli-patterns.ts:2571`）の次の行 — 今日の `locateAntigravityDialogRegion`（L2629）の後半 |
| ダイアログ枠の根拠 | `tests/fixtures/antigravity-live-2364/dialog-bash-oneline.txt`: L26 `Command`、L27 `────`、L29 `Requesting permission for:`、L32 `Do you want to proceed?`、L33 `> 1. Yes`、L36 `4. No`、L38 `↑/↓ Navigate · tab Amend · …`、L39 `esc to cancel`。入力欄は無い |
| 入力欄の下の操作部分 | `tests/fixtures/antigravity-live-2364/dialog-feedback-category.txt`（入力欄の**下**に番号行）。`composerEndRow` より下を読む根拠（2.4） |
| 引用の陰性 | 実機なし（合成。未決 2） |

### command-code

| 項目 | 内容 |
|---|---|
| 入力欄の目印 | `fencedComposer({ glyph: /^❯/, maxFooterRows: 4, maxBoxRows: 40 })` — 今日の `findCommandCodeChromeStart`（`cli-patterns.ts:2904`。`COMMAND_CODE_FOOTER_MAX_ROWS = 4`、`COMMAND_CODE_INPUT_BOX_MAX_ROWS = 40`）と同じ |
| 入力欄の根拠 | `tests/fixtures/tui-frame-footer-2776/command-code-1.58.0-idle-quoted-footers.txt`（1.58.0）: 引用 L18-21（`1. 観点の説明` / `2. 観点の説明` / 2 つの footer 文言）、L29 `────`、L30 `❯ Ask your question...`、L31 `────`、L32 `? for shortcuts · taste on` |
| ダイアログ枠の目印 | `ruleAboveOptionRun({ rule: /^─{10,}$/, footer: /↑\/↓ navigate · enter select/ })` |
| ダイアログ枠の根拠 | `tests/fixtures/command-code-live-2250/dialog-shell-command.txt`（1.40.1）: 返答 L25-26、L29 `────`、L31 `Execute Shell Command`、L32 `Command Code needs to execute …`、L36 `❯ 1. Yes`、L38 `3. No, …`、L40 `↑/↓ navigate · enter select · ctrl+e explain · …`。入力欄は無い |
| 引用の陰性 | 承認ダイアログ文面の実機の引用は無い（合成。未決 2）。footer 文言だけの引用は上の 1.58.0 の実機 |

### copilot

| 項目 | 内容 |
|---|---|
| 入力欄の目印 | 1.0.80: `fencedComposer({ glyph: /^❯/, maxFooterRows: 2, … })`（`cli-patterns.ts` の `COPILOT_STATUS_BAR_MAX_ROWS = 2`、`COPILOT_COMPOSER_MAX_ROWS = 40`）。1.0.82: `halfBlockComposer()`（`╻▄` … `╹▀`、角の字が必須。コメントは `cli-patterns.ts` の `COPILOT_*` 定義の直下）。どちらも最下行の状態バーを伴う |
| 入力欄の根拠 | `tests/unit/lib/detection/fixtures/copilot-live-1885/turn-complete.txt`（1.0.80）: L997 cwd 行、L998 `────`、L999 `❯`、L1000 `────`、L1001 `← open sidebar · / commands · …` |
| | `tests/unit/lib/detection/fixtures/copilot-live-2269/turn-complete.txt`（1.0.82）: L996 cwd 行、L997 `╻▄▄…`、L998 `┃`、L999 `╹▀▀…`、L1000 状態行 |
| | `tests/unit/lib/detection/fixtures/copilot-picker-1895/picker-vocabulary-in-response.txt`: picker footer の引用 L67-68、入力欄 L998-1000、状態行 L1001 |
| ダイアログ枠の目印 | `boxTop({ corner: '╭' })` — 最下行の `╰` から上へ対応する `╭`。ダイアログ中は状態バーと入力欄が描かれない（`isCopilotSelectionFrame` のコメント、`cli-patterns.ts:2263` の直上） |
| ダイアログ枠の根拠 | `tests/unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt`（1.0.80）: L987 `╭───`、L994 `│ Do you want to run this command?`、L996 `│ ❯ 1. Yes`、L998 `│   3. No, …`、L1000 `│ ↑/↓ to navigate · enter to select · esc to cancel`、L1001 `╰───` |
| 未確認 | 1.0.82 のダイアログ枠（未決 3）。承認ダイアログ文面の実機の引用（未決 2） |

### opencode（v1）

| 項目 | 内容 |
|---|---|
| 入力欄の目印 | `gutterComposerAboveFooter({ footer: /ctrl\+[tp]/, separator: /^\s*╹▀+/ })` — 今日の `findContentEnd`（`tools/opencode/detect.ts:46`。末尾 10 行で `ctrl+[tp]`、その 2 行上が境界）と同じ footer を使い、区切りの上に続く `┃` 行の塊の先頭が start |
| 入力欄の根拠 | `tests/fixtures/opencode-agent-health-3021/quoted-dialog-reply-done.txt`（1.18.33、80x200）: 発話の枠 L17-24（L20 `┃  △ Permission required`、L23 `┃   Allow once   Allow always   Reject`）、返答の引用 L26-31、完了行 L33 `▣  Build · … · 1.2s`、入力欄 L192-195（L195 `┃  Build · Claude Sonnet 5.5 GitHub Copilot · high`）、L196 `╹▀▀…`、L197-199 footer（L197 に `ctrl+p`） |
| 注意 | 発話の枠も `┃` を持ち、承認ストリップの文言（L23）が**枠の中に**ある。`OPENCODE_PERMISSION_PATTERN`（`cli-patterns.ts:1271-1272`）は `┃` に錨を下ろすので、位置で落とすしかない。今日は末尾 15 行の窓の外だから当たらないだけ（1.2-4） |
| ダイアログ枠の目印 | `gutterBlockTop({ title: /△ Permission required/ })` |
| ダイアログ枠の根拠 | `tests/unit/lib/detection/fixtures/opencode-live-1893/permission-bash.txt`（1.18.21）: L192 `┃  △ Permission required`、L193 `┃    # Shell command`、L195 `┃  $ ls -la`、L198 `┃   Allow once   Allow always   Reject  ctrl+f fullscreen  …`、L199 `┃`。`╹▀` も `ctrl+p` も無い（入力欄は無い） |

### opencode-v2

| 項目 | 内容 |
|---|---|
| 入力欄の目印 | v1 と同じ `gutterComposerAboveFooter`（footer は `ctrl+p commands`）。`OPENCODE_V2_IDLE_COMPOSER_PATTERN`（`cli-patterns.ts:1695-1696`、`┃ Ask anything…`）は空の入力欄の placeholder で、下の fixture では描かれていないので目印にしない |
| 入力欄の根拠 | `tests/fixtures/opencode-v2-dialogs-2984/quoted-dialog-reply.txt`（2.0.18）: 返答の番号リスト L11-13、発話 L19-23、返答の引用 L27 `Do you want to proceed?` / L28 `❯ 1. Yes` / L29 `2. No`、完了行 L31、入力欄 L194-197（L197 `┃  Build · LongCat 2.5 Preview Free OpenCode Zen`）、L198 `╹▀▀…`、L199 `… ctrl+p commands` |
| ダイアログ枠の目印 | `gutterBlockTop({ title: /△ Permission required|^\s*┃\s*Questions\s*$/ })` |
| ダイアログ枠の根拠 | `tests/fixtures/opencode-v2-dialogs-2984/permission.txt`: L186 `┃  △ Permission required`、L187 `┃    → Edit notes.txt`、L198 `┃   Allow once   Always allow   Reject  …`、L199 `┃` |
| | `tests/fixtures/opencode-v2-dialogs-2984/question.txt`: L190 `┃  Questions`、L192 `┃  Which color do you prefer?`、L194-196 `┃  1. Red` / `2. Blue` / `3. Type your own answer`、L198 `┃  ↑↓ select  enter submit  esc dismiss`、L199 `┃` |
| 引用の下の本物 | `tests/fixtures/opencode-v2-dialogs-2984/question-under-quoted-dialog.txt`（陰性の追加対照。`dialogs.test.ts:465` が `question` として固定） |

### まとめ

| ツール | 入力欄の目印 | ダイアログ枠の目印 | 陽性 fixture | 陰性 fixture |
|---|---|---|---|---|
| claude | 罫線・`❯`・罫線（下端 4 行以内） | 選択肢の先頭から上の最初の `─` 罫線 | 実機 | 実機 |
| codex | 最下段の `›`（SGR で composer） | 宣言しない | 実機 | 実機 |
| antigravity | 最下段の空の `>`（下に番号行・`↑/↓ Navigate` が無ければ下端） | `↑/↓ Navigate` から上の境界行 | 実機 | **合成**（実機は未確認） |
| command-code | 罫線・`❯`・罫線（下端 4 行以内） | 選択肢の先頭から上の最初の `─` 罫線 | 実機（1.40.1） | **合成**（実機は footer の引用だけ） |
| copilot | cwd 行＋罫線・`❯`・罫線＋状態バー（1.0.80）／`╻▄`・`┃`・`╹▀`（1.0.82）（`findCopilotChromeStart`） | `╰` に対応する `╭` | 実機（1.0.80） | **合成**（実機は未確認。1.0.82 のダイアログも未確認） |
| opencode | `┃` の塊＋`╹▀`＋`ctrl+p` footer | `┃  △ Permission required` | 実機（Auto-Yes は `keys` で答えない。未決 1） | 実機 |
| opencode-v2 | `┃` の塊＋`╹▀`＋`ctrl+p` footer | `┃  △ Permission required` / `┃  Questions` | 実機（質問フォーム） | 実機 |

---

## 8. 実装で確定したこと（設計時の案からの差分）

段階 A・B の実装（Issue #3183）で、設計時の案から次のとおり変えた。どれも実装前の全 fixture 掃引（`tests/fixtures/**`・`tests/unit/lib/detection/fixtures/**`・`tests/unit/detection/tools/claude/fixtures/**` の `.txt` をツール名でふるい分け、`normalizeFrame(raw, tool)` の anchor と、入力欄が下端なのに `waiting` / `detectDialog` 非 null / 汎用 parser が候補を読むフレームを列挙）か、既存テストの対照で決めた。

| # | 設計時の案 | 実装 | 理由 |
|---|---|---|---|
| 1 | `startRow` は生の行の index | `contentLines` の index | 既存規則がすべて `contentLines` を読むため（§2.1） |
| 2 | 共通拒否は全ツール | `isQuotedNumberedPrompt` は `composerHidesDialogs` のツールだけ。`vetoesDialog` は numbered なら全ツール、keys は `composerHidesDialogs` のツールだけ | 掃引で、copilot の `/model` picker と opencode 系の picker / palette 26 本が「入力欄が下端なのに開いている」と分かった。また `tests/unit/polling/auto-yes-dialog-gate-opencode-v2-2984.test.ts`（3 本）と `tests/unit/session/opencode-v2-body-numbered-list-2991.test.ts`（2 本）は「ゲート・`requireVouchedPrompt` の前の層では候補として読まれる」ことを対照として固定しており、これらの期待値は変えていない |
| 3 | agy の入力欄は罫線で囲まれた塊 | 最下段の空の `>` の行（`bottomMostComposerRow`）。下に番号行か `↑/↓ Navigate` があれば下端ではない | #2845 の述語と同じ行を目印にするため。Switch Model picker は入力欄の**下**に描かれる（`picker-switch-model.txt` L41-L58）ので footer も条件に入れた |
| 4 | codex の目印は SGR を先に読む `codexGlyphComposer()` | region の先頭は `findCodexComposerRow`（#892 の最下段の本物の `›`）、下端かどうかは `isCodexComposerAtBottom`（#2841） | 2 つの既存の読みをそのまま 1 つの目印の 2 つの半分にした。承認ダイアログでは先頭が発話の行になり下端ではない（§7 codex） |
| 5 | `dialogTop` で、入力欄の無いフレームの引用も落とす | `dialogTop` は求めて `liveRegion` に載せるが、拒否規則は使わない | 入力欄の無いフレームで引用を落とす既存の規則（claude の footer 行頭判定、agy の `locateAntigravityDialogRegion` など）は現状で通っており、置き換える根拠となる失敗例が無い。§4.2 の追加対照（引用の下の本物）が陽性のままであることは既存テストが固定している |
| 6 | `isAntigravitySelectionScreenOpen`（L89）を `liveRegion` で書き換え | 残す | #3 の picker が入力欄の下に描かれるため、「footer より下に入力欄があるか」という向きの判定が要る |
| 7 | opencode L136 を共通拒否にかける | かけない | #2 の線引き。opencode の承認ストリップは入力欄を消して描かれ（`permission-bash.txt`）、`keys` なので Auto-Yes は答えない |
| 8 | Auto-Yes の陽性 = `detectAndRespondToPrompt` が `responded` | claude / codex / antigravity / command-code / copilot は `responded`。opencode はゲートが `permission`・`keys` を認め `allowed: false`（オーケストレーターの裁定どおり）。opencode-v2 の質問フォームはゲートが `question`・`numbered` を認め `allowed: true` だが、画面経路では汎用 parser が `┃` に描かれた選択肢を読まず `no_prompt`（v2 の質問はエージェントの API で答える、#2945） | 実測 |
| 9 | 全 fixture の anchor 分布を `fixture-sweep.ts` の表で固定 | §7 の 24 行を `live-region-markers.test.ts` で固定 | 掃引は実装前の確認に使い、固定するのは設計書に引いた行に絞った |
| 10 | codex の起動画面ガード（poller L603）は文字列 | poller はその tick のフレームを `getCodexLifecycleDialog` と `isCodexModelPickerFrame` に渡す | 同じフレームを 4 か所すべてに渡すため。`cli-tools/codex.ts` の起動待ちは文字列のまま（同じ `findCodexComposerRow` で切る） |

