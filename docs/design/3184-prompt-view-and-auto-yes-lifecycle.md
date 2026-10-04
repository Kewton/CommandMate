# 承認ダイアログの見せ方・答え方の一元化と Auto-Yes の寿命表（Issue #3184）

- 対象 Issue: #3184
- 基準コミット: `b3be4eff`（develop, v0.44.1 マージ後）
- 種別: 設計書（この段階ではコード・テストを変更しない）
- 関連: #1708 #1725 #1738 #1898 #1932 #2031 #2039 #2100 #2573 #2583 #2584 #2755 #2775 #2810 #2822 #2793 #2809 #2845 #2851 #2870 #2951 #2965 #3179 #3181 #3182 #3195

本書の行番号・件数は、すべて基準コミット上で `grep -n` / `sed -n` で読んだ値である。読んでいない値は書いていない。

---

## 0. 要約

- **A（見せ方と答え方）**: 承認待ちのデータから、受け取る側がそのまま使える 1 つの形 `PromptView` を作る純関数 `derivePromptView()` を `src/lib/session/prompt-view.ts` に置く。サーバーは `current-output` に `promptView` として公開し、パネル・スマホ・チャット面・`useAutoYes`・`wait` はこの結果だけを読む。`PromptData` の閉じた union（#1725 の注記）と `isAnswerablePromptData()` は壊さず、`derivePromptView(x)?.kind === 'screen-choices'` ⇔ `isAnswerablePromptData(x)` を表テストで固定する。
- **B（Auto-Yes の寿命）**: 「どの出来事で Auto-Yes をどう消すか」を `src/lib/auto-yes-lifecycle.ts` の表 `AUTO_YES_LIFECYCLE` と適用関数 `releaseAutoYes()` にまとめる。#3188（kill-session で無効化）は**挙動を変えずに表の 1 行として取り込み、呼び出しを置き換える**。今どこからも消されていない「インスタンス削除」を表に足す。
- 実コードを読んで、Issue 本文と次の点が食い違っていた（§1.4）。特に **#3181 はパネルとスマホでは直っているが、チャット面（`ChatSurface`）とプッシュ通知には同じ取りこぼしが残っている**ことがコードから読める。

---

## 1. 現状の整理（Issue 本文「現状のコード」の裏取り）

### 1.1 共通の判定

| Issue の記述 | 実コード | 判定 |
|---|---|---|
| `src/types/models.ts:645` の `isAnswerablePromptData()` | 関数本体は `src/types/models.ts:651`。`:645` はその JSDoc の中 | 行ずれ（内容は一致） |
| 分かるのは「`type` が `unclassified` かどうか」だけ | `return value != null && value.type !== UNCLASSIFIED_PROMPT_TYPE;`（`:654` 付近、関数 `:651`） | 一致 |
| `UNCLASSIFIED_PROMPT_TYPE` | `src/types/models.ts:565`。`PromptType` の外に置く理由がコメントにある | 一致 |
| `PromptData` の union は閉じている（#1725） | `src/types/models.ts:554` `PromptData = YesNoPromptData \| MultipleChoicePromptData`、`:616` `LivePromptData`、`:631` `StoredPromptData` | 一致 |

### 1.2 選択肢の置き場所

| Issue の記述 | 実コード | 判定 |
|---|---|---|
| `structured-prompt.ts:273` の `StructuredPromptWaitingData` は `options: never[]`、選択肢は `decisionOptions` | `src/lib/session/structured-prompt.ts:273`。`decisionOptions?`、`decisionId?: string \| null`、`askUserQuestion?`、`toolName?`、`patterns?` を持つ | 一致 |
| 組み合わせ方は受け取る側に任されている | 受け取り側の読み方は `src/components/worktree/prompt-decision-id.ts` に部分的に集まっている（`readPromptDecisionId` `:85`、`readPromptQuestionChoices` `:196`、`readStructuredDecisionHeading` `:248`）。ただしこれは**クライアント専用の位置**にあり、CLI・push・Auto-Yes は使っていない | 一致（補足あり） |

サーバー側で `decisionOptions` / `decisionId` を決める式は `src/lib/session/current-output-builder.ts:1913`（`addressableDecisionId`）と `:1933`（`addressesQuestion`）にあり、`:1970` で `promptData` を組み立て、`:2190` で公開している。`decisionOptions` は承認（approval）のときだけ、`decisionId` は承認と質問（question）の両方に付く（#2100）。

### 1.3 Auto-Yes を消す経路

| Issue の記述 | 実コード | 判定 |
|---|---|---|
| worktree 削除 `session-cleanup.ts:133` | `:123` `stopAutoYesPollingByWorktree` → `:133` `deleteAutoYesStateByWorktree` | 一致 |
| 孤児の掃除 `resource-cleanup.ts:240` | `:240` / `:245` `deleteAutoYesState`、`:255` `stopAutoYesPolling` | 一致 |
| 連続エラー `auto-yes-poller.ts:232` | `:232` `disableAutoYes(..., 'consecutive_errors', ...)` → `:234` `stopAutoYesPolling` | 一致 |
| セッション停止（kill-session）では消えない（#3182） | **基準コミットでは消える。** `c2f0a928`（PR #3188）で `src/app/api/worktrees/[id]/kill-session/route.ts:218-221` に `disableAutoYes(id, cliToolId, undefined, instanceId)` と `stopAutoYesPolling(...)` が入った。同じループで `clearSessionStarting`（`ee314d38`, PR #3192） | **食い違い（Issue 起票後に修正済み）** |
| インスタンスの削除では消えない | 一致。インスタンス削除は `PATCH /api/worktrees/[id]` の `agentInstances`（`src/app/api/worktrees/[id]/route.ts:216-246`）で、Auto-Yes に触れない。CLI の `instances remove --kill`（`src/cli/commands/instances.ts:480-514`）は先に kill-session を呼ぶので結果的に無効化されるが、UI（`AgentInstancesPane.tsx:494` の PATCH）と `--kill` なしの CLI では残る | 一致 |
| サーバー再起動 | 状態は `globalThis.__autoYesStates`（`src/lib/auto-yes-state.ts` の Map）だけに持ち、DB 等への永続化は無い（`grep -rniE "auto_yes\|restoreAutoYes" src server.ts` で永続化コードは見つからない）。終了時は `server.ts:908` で `stopAllAutoYesPolling()`。プロセス終了で Map ごと消える | 暗黙に消える |

### 1.4 Issue 本文との食い違い（実コードを正とする）

1. **「`unclassified` を参照しているファイルは 21 個」**: `grep -rl unclassified src` は **67 ファイル**を返す。21 は `grep -rlE "'unclassified'|UNCLASSIFIED_PROMPT_TYPE|isAnswerablePromptData" src` の件数と一致する。21 のうち 3 ファイル（`src/hooks/useAutoYes.ts`、`src/lib/relay/relay-delivery.ts`、`src/types/ui-state.ts`）は `unclassified` という語を含まず、`isAnswerablePromptData` だけで該当している。§7 に 67 ファイル全部、§7.2 に 21 ファイルの対応を載せる。
2. **行番号のずれ**: `PromptPanel.tsx:480`（見出し）は実際は `:481-483`、`:532`（`UnclassifiedPromptNotice`）は呼び出しが `:533-534`、定義が `:560`。`MobilePromptSheet.tsx:529` / `:558` は `:530`（instructionText）、`:538`（見出し）、`:561`（通知）。`ChatSurface.tsx:578-579` は `:596-597`。他（`structured-prompt.ts:273`、`chat-tool-approvals.ts:546`、`useAutoYes.ts:93`、`wait.ts:69`）は一致。
3. **#3181 は部分的に修正済み**: `0b8857ac`（PR #3187）で `readStructuredDecisionHeading()`（`prompt-decision-id.ts:248`）が入り、パネル（`PromptPanel.tsx:1290` の `unclassifiedHeading`）とスマホ（`MobilePromptSheet.tsx:1010` の同名関数、**複製**）は V2 承認で「読み取れませんでした」を出さない。しかし次の 2 経路は直っていない（コードからの読み取り。実機は未確認、§6）:
   - **チャット面**: `ChatSurface.tsx:597` `if (live.isPromptWaiting && !isAnswerablePromptData(live.promptData)) return 'promptUnreadable';` は `decisionOptions` を見ないため、V2 承認でも `promptUnreadable` カード（`locales/ja/worktree.json:553` 「応答待ちですが選択肢を読み取れませんでした。…」）を出す。
   - **プッシュ通知**: `deriveWaitingKind()`（`src/lib/session/waiting-kind.ts:69-76`）は scraper の `hasActivePrompt` だけで `'prompt'` を判定するため、構造化層だけが見ている V2 承認は `'unclassified'` になり、`push-sender.ts:338` の `needsTerminal()` が真 → 「ターミナルで確認」の文面になる。`waiting-push-notifier.ts` の 8 秒猶予（#2156）は scraper が後から `prompt` に読み替える場合しか救わない。
4. **パネルとスマホで `decisionId` の出どころが違う**: パネルは呼び出し元が渡す prop（`TerminalSplitPaneContent.tsx:759` `readPromptDecisionId(prompt.data)` → `:1139`）で判定し、スマホは payload から自分で読む（`MobilePromptSheet.tsx:876`）。結果は今は同じだが、同じ判断を 2 か所で行っている。
5. **自由入力の判定も複製**: `optionTakesTypedText()` が `PromptPanel.tsx:74` と `MobilePromptSheet.tsx:60` に 2 つある（コメントで意図的な複製と明記、`PromptPanel.test.tsx` が一致を検査）。
6. **`wait` の選択肢**: `wait.ts:950-953` は `options` が空なら `decisionOptions` を使うが、V2 の**質問**（`decisionId` あり・`decisionOptions` なし・`askUserQuestion.labels` あり）では何も拾わず `options: []` を出す。パネルは同じ payload で番号ボタンを出す（`readPromptQuestionChoices`）。

---

## 2. 新しい形

### 2.1 置き場所と依存の制約

- ファイル: **`src/lib/session/prompt-view.ts`**（新規）
- **import をひとつも持たない純モジュール**にする。理由:
  - CLI（`tsconfig.cli.json`）は `"paths": {}` で `@/` エイリアスが使えない。CLI は `../../lib/...` の相対 import でなら lib を使える（例: `src/cli/config/cli-tool-ids.ts:22`、`src/cli/commands/status.ts:17`）が、取り込んだ先が `@/` を使っていると解決できない。`src/types/models.ts` も `structured-prompt.ts` も `@/` を使っているので、CLI から直接は読めない。
  - クライアントコンポーネントからも読める必要がある（`structured-prompt.ts` の「Pure on purpose」と同じ理由）。
- そのため入力型は既存型に依存しない**構造的な緩い型**にする。`LivePromptData` / `StoredPromptData` / CLI のミラー `PromptData`（`src/cli/types/api-responses.ts`、`type: string`）のどれもキャストなしで渡せる。

### 2.2 型

```ts
/** derivePromptView が読むフィールドだけ。既存のどの prompt 型もそのまま代入できる。 */
export interface PromptViewSource {
  type: string;
  question?: string;
  status?: string;
  options?: readonly unknown[];
  multiSelect?: boolean;
  decisionId?: unknown;
  decisionOptions?: unknown;
  askUserQuestion?: unknown;
  toolName?: unknown;
}

/** どう答えるか。Issue の 4 区分のうち 3 つはこの値そのもの（自由入力は §2.4）。 */
export type PromptViewKind =
  | 'screen-choices' // 画面の番号（キー入力）で答える。/prompt-response
  | 'api-choices'    // エージェントの API で答える。/respond に decisionId を付ける
  | 'unreadable';    // 答える手段を出さない（ターミナルで答える）

export type PromptViewHeading =
  | { kind: 'question'; text: string }               // 画面から読んだ質問文
  | { kind: 'approval'; toolName: string | null }    // V2 等の承認（#3181 の見出し）
  | { kind: 'agent-question' }                       // API で答える質問（#2039）
  | { kind: 'unreadable' };                          // 「選択肢を読み取れませんでした」

export interface PromptViewChoice {
  /** 送る値。画面なら番号（'1'）か 'yes'/'no'、API なら respond が受ける番号。 */
  answer: string;
  label: string;
  isDefault: boolean;
  /** この選択肢を選ぶと文字入力欄を出す（#2573 の optionTakesTypedText と同じ規則）。 */
  takesText: boolean;
  description?: string;
}

export interface PromptView {
  kind: PromptViewKind;
  heading: PromptViewHeading;
  /** kind === 'unreadable' なら必ず空。 */
  choices: readonly PromptViewChoice[];
  /** チェックボックス式（#2755）。screen-choices のときだけ true になりうる。 */
  multiSelect: boolean;
  /** 文字入力を受けるか。null なら受けない（§2.4）。 */
  freeText: { via: 'screen' | 'api' } | null;
  /** kind === 'api-choices' のときだけ非 null（#2031 の「id と選択肢は一緒に出る」を型で保つ）。 */
  decisionId: string | null;
  /** api-choices のとき、承認か質問か。それ以外は null。 */
  apiTarget: 'approval' | 'question' | null;
}

export function derivePromptView(source: PromptViewSource | null | undefined): PromptView | null;
```

### 2.3 判定規則（`derivePromptView` の中身）

上から順に評価する。既存の 3 関数（`readPromptDecisionId` / `readPromptQuestionChoices` / `readStructuredDecisionHeading`）と `optionTakesTypedText` の規則をそのまま移す。新しい判断は足さない。

| # | 条件 | kind | heading | choices |
|---|---|---|---|---|
| 0 | `source == null` | （null を返す） | — | — |
| 1 | `type !== 'unclassified'`（= `isAnswerablePromptData` が真） | `screen-choices` | `question`（`source.question`） | `yes_no` は yes/no、`multiple_choice` は `options` を写す |
| 2 | `type === 'unclassified'` かつ `decisionId` が空でない文字列 かつ `decisionOptions` が非空配列 | `api-choices` / `apiTarget: 'approval'` | `approval`（`toolName`） | `decisionOptions` の `number`/`label` |
| 3 | `type === 'unclassified'` かつ `decisionId` あり かつ `decisionOptions` なし かつ `askUserQuestion` が 1 問・ラベル欠けなし（`readPromptQuestionChoices` と同条件） | `api-choices` / `apiTarget: 'question'` | `agent-question` | `labels` を 1 始まりで番号付け |
| 4 | それ以外の `type === 'unclassified'`（`decisionId` 無し、または `decisionOptions` だけあって id が無い #1932 の半端な形、履歴行 `UnclassifiedFrameRecord` / `StructuredPromptHistoryRecord` を含む） | `unreadable` | `unreadable` | `[]` |

- 規則 1 の `takesText` は `optionTakesTypedText` と同じ（`/^[^\S\n]*type\s+something\b/i` に一致するラベルで `requiresTextInput` が真）。正規表現は `prompt-view.ts` に 1 つだけ置き、`PromptPanel.tsx:74` / `MobilePromptSheet.tsx:60` の 2 つの複製はこれを読むように置き換える（サーバー側の `TYPED_TEXT_FIELD_LABEL_PATTERNS` との一致検査は既存テストを移す）。
- 規則 2 と 3 は排他（#2039 の第 3 条件）。両方が成り立つ payload はサーバーが作らない（`current-output-builder.ts:1933-1937`）が、来たら規則 2（承認）が勝つ。今の `readPromptQuestionChoices` と同じ。
- 履歴行（`StoredPromptData` の劣化 2 形）は `decisionId` を持たないので必ず規則 4。`current-output-builder.ts` は API で答えられる間は履歴行を書かない（#2965、`:2112` からの `if` の `!answerableOverAgentApi`）ので、これは実態と一致する。

### 2.4 「自由入力」の扱い（Issue の 4 区分との対応）

Issue は「選択肢あり（画面の番号）」「選択肢あり（API）」「自由入力」「読めない」を並べているが、**現行データでは自由入力が単独で現れる形が無い**ことをコードで確認した:

- 画面: `Type something...` は `multiple_choice` の 1 選択肢（実測 fixture `tests/fixtures/command-code-askuserquestion-2522/promptdata-golden-2755.json` の `question-default-on-free-text` は 3 択の 3 番目）。
- API: OpenCode V2 の `custom: true`（#2951）は選択肢付きの質問に乗る。`readPromptQuestionChoices` はラベルが空なら null を返す（`prompt-decision-id.ts:212` の `labels.length === 0` 判定）。
- `PromptType` には `'input'` があるが、`PromptData` union には含まれない（`models.ts:368` と `:554`）。

そこで「自由入力」は `kind` の 4 値目にせず、**`freeText` という直交した軸**にする。Issue の 4 区分はこう写す:

| Issue の区分 | PromptView |
|---|---|
| 選択肢あり（画面の番号で答える） | `kind: 'screen-choices'`, `freeText: null` |
| 選択肢あり（API で答える） | `kind: 'api-choices'` |
| 自由入力 | `freeText !== null`（画面: `kind: 'screen-choices'` + `freeText.via: 'screen'`／API: `kind: 'api-choices'` + `freeText.via: 'api'`） |
| 読めない | `kind: 'unreadable'` |

4 値目にすると、「選択肢 3 つのうち 1 つが入力欄」の形で `kind` を 1 つに決められず、受け取り側がまた解釈を足すことになる。

### 2.5 サーバーでの公開と、受け取り側の読み方

- `buildCurrentOutput`（`current-output-builder.ts`）で、payload の `promptData` の隣（`:2190`）に `promptView: derivePromptView(promptData)` として載せる。型は `promptView?: PromptView | null`（実装メモ: optional にした。セッションが動いていない早期 return の payload と、既存テストが組み立てる payload が持たないため。absent は null と同じに読む）。#2870 の `promptAnswerable` と同じく**追加フィールド**で、既存フィールドは並びも型も変えない。
- 運ぶ経路は `promptAnswerable` が通っている所と同じ: `src/lib/realtime/types.ts`、`src/lib/realtime/terminal-broadcast.ts`、`src/cli/types/api-responses.ts`（CLI のミラー）、`src/hooks/useTerminalPanePolling.ts`、`src/hooks/useWorktreeDetailController.ts`（`grep -rln promptAnswerable src` で出る 11 ファイルが候補。どれが値を運ぶだけかは実装時に確認）。
- 受け取り側は 1 つの読み関数を使う: `readPromptView(payload) = payload.promptView ?? derivePromptView(payload.promptData)`。`??` にするのは #2369 の `isDismissablePanelActive` と同じ理由で、`promptView` を出さない古いデーモンでも同じ関数で同じ結論になる。
- ブラウザのコンポーネントのうち、reducer の `prompt.data` しか持たないもの（`PromptPanel` / `MobilePromptSheet` は props で `promptData` を受ける）は `derivePromptView(promptData)` を直接呼んでよい。**判断の中身は 1 関数にしかなく、サーバーと同じ関数**なので結論は一致する。reducer（`src/types/ui-state.ts` の `PromptState`）に `view` を足すかどうかは §6-4。

### 2.6 既存の型・公開 API を壊さない理由

| 既存 | 扱い | 理由 |
|---|---|---|
| `PromptData` union（閉じている） | 変えない | `PromptView` は別の型で、union を広げない。#1725 / #1738 の「答えを送る経路に劣化形を渡させない」性質はそのまま |
| `isAnswerablePromptData()` | 残す | **型の絞り込み**に使う（`buildPromptResponseBody(answer, tool, promptData)` の引数を `PromptData` にする等）。見せ方を決める用途には使わなくする。`kind === 'screen-choices'` ⇔ `isAnswerablePromptData` を表テストで固定し（§4）、2 つが食い違えない |
| `UNCLASSIFIED_PROMPT_TYPE` と `type: 'unclassified'` の値 | 変えない | `wait` の exit 10 JSON・`capture --prompts`・DB の `prompt_data` 列が外部契約として使っている |
| `prompt-decision-id.ts` の 3 関数 | 中身を `prompt-view.ts` の `readDecisionId` / `readQuestionChoices` / `readDecisionHeading` に移し、3 関数はそれを呼ぶ薄い互換ラッパーとして残す（実装メモ: `derivePromptView` を呼ぶ形にはしなかった。旧 3 関数は `type` を見ないので、`derivePromptView` 経由にすると「`decisionId` を持つ画面プロンプト」等で答えが変わる。`derivePromptView` も同じ 3 関数を使うので判断の中身は 1 か所） | 既存テスト（`PromptPanelQuestion-2039`、`PromptHeadingUnclassified-3181` 等）が import しているため。新しい呼び出しは増やさない |
| `current-output` の JSON | `promptView` を**追加**するだけ | 既存の CLI・スクリプトは知らないフィールドを無視する |
| `wait` の exit 10 JSON | `type` / `options` / `status` の意味を変えない。`answerVia`（`'screen' \| 'api' \| 'terminal'`）を**追加** | `type: 'unclassified'` で分岐している既存の呼び出し側（`--auto-yes` dispatch 等、`wait.ts:62-68` のコメント）を壊さない |

---

## 3. 移行の対応表（A）

「今」→「置き換え」。置き換えないものは理由を書く。

| ファイル | 今どう動いているか | どう置き換えるか／置き換えない理由 |
|---|---|---|
| `src/lib/session/prompt-view.ts`（新規） | — | `derivePromptView` / `readPromptView` / `TYPED_TEXT_FIELD_LABEL_PATTERNS` を置く |
| `src/lib/session/current-output-builder.ts` | `:1970` で `promptData` を決め `:2190` で公開 | 直後に `promptView` を計算して公開。`decisionOptions`/`decisionId` の決め方（`:1913`/`:1933`）は**変えない**（生成側の判断で、受け取り側の解釈ではない） |
| `src/lib/session/structured-prompt.ts` | `type: UNCLASSIFIED_PROMPT_TYPE` で劣化形 2 種を作る | 置き換えない（生成側）。`buildStructuredPromptQuestion` の英文（`:362`）も `wait`/`capture` 向けに残す |
| `src/types/models.ts` | 定数 `:565`、`isAnswerablePromptData` `:651` | 置き換えない（§2.6）。`isAnswerablePromptData` の JSDoc に「見せ方は `derivePromptView` で決める」と 1 行足す |
| `src/components/worktree/prompt-decision-id.ts` | `decisionId` / 質問の選択肢 / 見出しをそれぞれ読む | 中身を `prompt-view.ts` へ移し、互換ラッパーにする（§2.6） |
| `src/components/worktree/PromptPanel.tsx` | `isAnswerablePromptData` で見出し（`:481-483`）・指示文（`:456`）・通知（`:533`）を分け、通知内で `decisionId ? promptData.decisionOptions : null`（`:577`）、`unclassifiedHeading` `:1290` | `view = derivePromptView(promptData)`。見出しは `view.heading`、操作部品は `view.kind` で分ける。`unclassifiedHeading` と `optionTakesTypedText` の複製を削除し `prompt-view.ts` を読む。`decisionId` prop は送信先の決定にだけ使い、見せ方には `view.decisionId` を使う |
| `src/components/mobile/MobilePromptSheet.tsx` | パネルと同じ判断を複製（`:530`/`:538`/`:561`、`:876-883`、`unclassifiedHeading` `:1010`、`optionTakesTypedText` `:60`） | パネルと同じく `view` だけを読む。複製 2 関数を削除 |
| `src/components/worktree/ChatSurface.tsx` | `:597` `!isAnswerablePromptData` → `promptUnreadable`（V2 承認でも） | `view.kind === 'unreadable'` のときだけ `promptUnreadable`。`api-choices` はパネル／シートが答えるので `null`（答えられるプロンプトにカードを出さないという `:549-553` の既存方針どおり）。`:596` の `isUnclassifiedActive`（フレーム判定）との順序は §6-3 |
| `src/components/worktree/TerminalSplitPaneContent.tsx` | `:666` 送信 body の型の絞り込みに `isAnswerablePromptData`、`:759` `readPromptDecisionId` | `:666` は**残す**（`buildPromptResponseBody` の引数型の絞り込みで、見せ方の判断ではない。理由コメントを付ける）。`:759` は `view.decisionId` に置き換え |
| `src/hooks/useWorktreeDetailController.ts` | `:1236` 送信 body の型の絞り込み | **残す**（同上、理由コメント） |
| `src/components/worktree/MobileTerminalTab.tsx` | `:863-864` で `isPromptWaiting` / `promptData` を ChatSurface に渡す | 変更なし（ChatSurface 側で `view` を導く） |
| `src/hooks/useAutoYes.ts` | `:93` `if (!isAnswerablePromptData(promptData)) return;` | `if (derivePromptView(promptData)?.kind !== 'screen-choices') return;`。続く `resolveAutoAnswer(promptData)` には `PromptData` が要るので、型の絞り込みとして `isAnswerablePromptData` を 1 回残す（理由コメント）。`api-choices` をブラウザが答えないのは今と同じ（サーバーの `permission-adjudication` / `pending-decision-recheck` が答える） |
| `src/cli/commands/wait.ts` | 自前定数 `:69`、`:950-953` で `options` が空なら `decisionOptions` | 画面の `options` → `decisionOptions`（`reply` を含む生の形のまま）→ `readPromptView(data)` が API の質問と言うときだけその `choices` を `{number, label}` で、の順に使う（実装メモ: `decisionOptions` のフォールバックは view に関係なく残した。既存テスト `reports the verdicts a structured approval accepts (Issue #1898)` が `decisionId` の無い #2031 以前の形で書かれているため。`answerVia` は view だけから決める）。V2 質問でも選択肢が出る（§1.4-6 の修正）。`answerVia` を追加。`:1092` の合成出力（60 秒の未分類 dwell）は `type: 'unclassified'` のまま（外部契約）。自前定数は `prompt-view.ts` の定数を相対 import で読む |
| `src/cli/commands/capture.ts` | 自前定数 `UNCLASSIFIED_FRAME_TYPE` `:56` で `--prompts` の行状態 | 状態語（`unclassified:hook-*` / `unclassified:detection-failed`）は外部契約なので残す。判定を `derivePromptView(p)?.kind === 'unreadable'` にし、自前定数を削除 |
| `src/cli/types/api-responses.ts` | CLI 側 `PromptData` ミラー（`type: string`）、`'unclassified-frame'` 理由 | `promptView?: PromptView` を current-output 型に追加（型は `prompt-view.ts` から相対 import）。ミラーの緩さ（#1738）は変えない |
| `src/lib/chat/chat-tool-approvals.ts` | `:546` `type === UNCLASSIFIED_PROMPT_TYPE \|\| status === 'unclassified'` → outcome `'unclassified'` | `derivePromptView(record)?.kind === 'unreadable'`（履歴行は §2.3 で必ず unreadable）。`status === 'unclassified'` 側は「型が壊れた行」の保険として残すか実装時に既存テスト（`chat-tool-approvals-2460` fixture）で決める |
| `src/app/api/worktrees/[id]/respond/route.ts` | DB 行に `isAnswerablePromptData` で 400 | **残す**（サーバー側の送信ゲートで、型の絞り込み。見せ方ではない） |
| `src/lib/relay/relay-delivery.ts` | `:282` / `:459` で `isAnswerablePromptData` | **残す**（DB 行の `options` を読むための型の絞り込み）。V2 承認を relay するかは §6-2 |
| `src/lib/session/waiting-kind.ts` | `deriveWaitingKind` が scraper の `hasActivePrompt` だけで `prompt` を判定 | §6-2 の決定後に、入力へ `apiAnswerable: boolean`（`hasApiAnswerableDecision` と同じ判定）を足し、真なら `'prompt'` を返す。push・StatusDot・relay はこの結果を読むだけなので個別変更は不要 |
| `src/lib/push/push-sender.ts` / `waiting-push-notifier.ts` | `waitingKind` が `menu`/`unclassified` なら「ターミナルで」 | 変更なし（`waiting-kind.ts` 側で直る） |
| `src/components/ui/StatusDot.tsx`、`src/types/sidebar.ts` | `WaitingKind` の表示 | 変更なし（同上） |
| `src/types/ui-state.ts` | `PromptState.data: LivePromptData` | 既定では変更なし（§6-4） |

---

## 4. テスト計画

### 4.1 共通 fixture（4 行 + 対照 3 行）

すべて既存 fixture か既存ビルダーで作る（実機は使わない）。置き場所: `tests/fixtures/prompt-view-3184/index.ts`（新規、既存データを組み立てるだけ）。

| 行 | Issue の区分 | 作り方 |
|---|---|---|
| R1 | 画面の番号 | `promptdata-golden-2755.json` の `question-description-indent-0-1-2`（`multiple_choice`、3 択、既定 1） |
| R2 | API（V2 承認） | `buildStructuredPromptData('wt-3184', { source: 'notification', message: 'edit hello.txt', toolName: 'edit', decisionOptions: STRUCTURED_DECISION_OPTIONS, decisionId: 'per_3184…', patterns: ['*'] })`（`PromptHeadingUnclassified-3181.test.tsx` と同じ組み方） |
| R3 | 自由入力 | `promptdata-golden-2755.json` の `question-default-on-free-text`（既定が `Type something...`） |
| R4 | 読めない | `buildStructuredPromptData(..., { source: 'notification', message: 'something is open', decisionOptions: null })` |
| N1（陰性対照） | — | `decisionOptions` はあるが `decisionId: null`（#1932 の半端な形を手で作る）→ 必ず `unreadable` |
| N2（追加） | API（V2 質問） | `decisionId` あり・`decisionOptions` なし・`askUserQuestion: { question, labels: ['A','B'], questionCount: 1 }` |
| N3（追加） | API の自由入力 | N2 に `custom: true` |

### 4.2 受入基準ごとのテスト

| 受入基準 | テストファイル（新規は★） | 内容 | 陽性／陰性 |
|---|---|---|---|
| 設計書 | 本書 | — | — |
| A の関数が 1 か所にある | ★`tests/unit/session/prompt-view-3184.test.ts` | 全行の `derivePromptView` の結果を表で固定。`kind === 'screen-choices'` ⇔ `isAnswerablePromptData` を全行で検査 | 陰性: N1 が `unreadable`、R4 の `choices` が空、`decisionId` が `api-choices` 以外で常に null |
| `isAnswerablePromptData()` / `'unclassified'` を UI・Auto-Yes・CLI で直接見ていない | ★`tests/unit/session/prompt-view-usage-guard-3184.test.ts` | `src/components` `src/hooks` `src/cli` を読み、`isAnswerablePromptData(`・`UNCLASSIFIED_PROMPT_TYPE`・`=== 'unclassified'` の出現が許可リスト（ファイル＋直前行に `#3184:` の理由コメント）にだけあることを検査 | 陽性: 許可リスト外に 1 行足すと落ちる（テスト内で文字列を差し込んだ検査関数に対して確認） |
| 4 データでパネル・スマホ・チャット面・Auto-Yes・`wait` が同じ結論 | ★`tests/unit/components/prompt-view-consumers-3184.test.tsx`（jsdom、**1 本の表**） | 行 R1〜R4（＋N1〜N3）× 列［PromptPanel／MobilePromptSheet／`resolveBlockedReason`／`useAutoYes`／`wait`］で、各列の観測値を `view.kind` に写した結論（`screen` / `api` / `none`）が行内で全部一致することを検査。観測値: パネルとシートは描画された操作部品の testid、チャット面は `resolveBlockedReason` の戻り値（`null` か `promptUnreadable`）、Auto-Yes は `fetch` が呼ばれたか（`serverPollerActive: false`）、`wait` は `ApiClient` をモックして exit 10 の `answerVia` と `options` | 陰性: R2 で `resolveBlockedReason` が `promptUnreadable` を返さない（**現行コードでは落ちる**＝修正前の赤を確認できる）。R4 は全列 `none` |
| V2 承認で「読み取れませんでした」が出ない | 上の表テストの R2 行 + 既存 `tests/unit/components/mobile/PromptHeadingUnclassified-3181.test.tsx`（変更せず緑のまま） | パネル・シートの見出し、チャット面のカード文言（`chatSurface.reasonPromptUnreadable` が出ない）を R2 で検査 | 陽性対照: R4 では同じ文言が**出る** |
| B: 出来事の表が 1 か所、出来事ごとに単体テスト | ★`tests/unit/lib/auto-yes-lifecycle-3184.test.ts` | §8 の表の各行に `it` を 1 つ（6 件）。状態（enabled / stopReason / 消えたか）と poller の停止を検査 | 陰性: 対象外のインスタンス・worktree の状態が残ること（#3188 の「targets 外は触らない」と同じ） |
| B: 各経路が表を呼ぶ | ★`tests/unit/api/worktree-patch-instance-removed-auto-yes-3184.test.ts`、既存 `tests/unit/api/kill-session-auto-yes-3182.test.ts`（変更せず緑）、既存 `tests/unit/session-cleanup-issue404.test.ts`、`tests/unit/resource-cleanup.test.ts`、`tests/unit/lib/auto-yes-manager.test.ts`（`consecutive_errors`） | ルートから表まで通ることを確認 | 陰性: PATCH で**残った**インスタンスの Auto-Yes は有効のまま |
| B: 表を通らない削除が無い | ★`tests/unit/lib/auto-yes-lifecycle-usage-guard-3184.test.ts` | `disableAutoYes(` / `deleteAutoYesState(` / `deleteAutoYesStateByWorktree(` / `stopAutoYesPollingByWorktree(` の呼び出しが許可リスト（`auto-yes-state.ts` 内部、`auto-yes-lifecycle.ts`、手動操作の `auto-yes/route.ts`、ID 移行の `worktree-session-reconcile.ts`）にだけあることを検査 | 同上 |
| lint / typecheck / unit | `npm run lint`、`npx tsc --noEmit`、`npm run test:unit`、加えて `npm run build:cli`（`prompt-view.ts` が CLI ビルドに入るため） | — | — |

### 4.3 変えずに緑のままであるべき既存テスト

`tests/unit/components/PromptPanelDecisionId.test.tsx`、`PromptPanelQuestion-2039.test.tsx`、`QuestionFreeText-2951.test.tsx`、`PromptPanelDecisionSubject-2031.test.tsx`、`tests/unit/components/worktree/TerminalSplitPaneContent-decision-1932.test.tsx`、`tests/unit/components/mobile/MobilePromptSheetDecision-2945.test.tsx`、`PromptHeadingUnclassified-3181.test.tsx`、`tests/unit/components/worktree/ChatSurface-dialog-card-2254.test.tsx`、`tests/unit/cli/commands/wait.test.ts`、`tests/unit/session/structured-prompt-decision-id-2031.test.ts`、`current-output-question-decision-2100.test.ts`、`tests/unit/hooks/useAutoYes.test.ts`、`tests/unit/api/kill-session-auto-yes-3182.test.ts`、`kill-session-starting-3179.test.ts`。

`decisionOptions` を含むテストを `grep -rl decisionOptions tests` で引くと ChatSurface 系は 1 本も無い（§1.4-3 のチャット面の取りこぼしがテストに現れていない理由）。

---

## 5. 実装の分割案

2 本の契約に分ける（A が大きすぎれば A1/A2 に割る）。B は A に依存しない。

### 契約 A1: 形を作って公開し、CLI を読ませる

1. `src/lib/session/prompt-view.ts` と `tests/unit/session/prompt-view-3184.test.ts`、fixture を作る（Red → Green）。
2. `prompt-decision-id.ts` を互換ラッパーにする。
3. `current-output-builder.ts` で `promptView` を公開し、運搬経路と CLI ミラーに型を足す。
4. `wait.ts` / `capture.ts` を `readPromptView` に置き換える。`npm run build:cli` を通す。

scope.allow 候補:
```
src/lib/session/prompt-view.ts
src/components/worktree/prompt-decision-id.ts
src/lib/session/current-output-builder.ts
src/lib/realtime/types.ts
src/lib/realtime/terminal-broadcast.ts
src/cli/types/api-responses.ts
src/cli/commands/wait.ts
src/cli/commands/capture.ts
tests/unit/session/prompt-view-3184.test.ts
tests/fixtures/prompt-view-3184/**
tests/unit/cli/commands/wait.test.ts
changelog.d/3184.md
dev-reports/module-reference/3184.md
```

### 契約 A2: 受け取り側を読ませ、表テストとガードで固定する

1. 表テスト `prompt-view-consumers-3184.test.tsx` を先に書き、R2 のチャット面列が赤になることを確認する。
2. `PromptPanel` / `MobilePromptSheet` / `ChatSurface` / `TerminalSplitPaneContent` / `useAutoYes` / `chat-tool-approvals` を置き換える。複製 2 関数を削除。
3. 型の絞り込みとして残す `isAnswerablePromptData` に理由コメントを付け、使用箇所ガードを足す。
4. （§6-2 で「やる」と決まった場合のみ）`waiting-kind.ts` と `worktree-status-helper.ts`。

scope.allow 候補:
```
src/components/worktree/PromptPanel.tsx
src/components/mobile/MobilePromptSheet.tsx
src/components/worktree/ChatSurface.tsx
src/components/worktree/TerminalSplitPaneContent.tsx
src/hooks/useAutoYes.ts
src/hooks/useWorktreeDetailController.ts
src/lib/chat/chat-tool-approvals.ts
src/types/models.ts
src/app/api/worktrees/[id]/respond/route.ts
src/lib/relay/relay-delivery.ts
src/lib/session/waiting-kind.ts            # §6-2 次第
src/lib/session/worktree-status-helper.ts  # §6-2 次第
tests/unit/components/prompt-view-consumers-3184.test.tsx
tests/unit/session/prompt-view-usage-guard-3184.test.ts
tests/unit/components/PromptPanel.test.tsx
tests/unit/components/worktree/ChatSurface-dialog-card-2254.test.tsx
changelog.d/3184.md
dev-reports/module-reference/3184.md
```
（`respond/route.ts`・`relay-delivery.ts`・`models.ts` は理由コメントを足すためだけ。）

### 契約 B: Auto-Yes の寿命表

1. `src/lib/auto-yes-lifecycle.ts` と `tests/unit/lib/auto-yes-lifecycle-3184.test.ts`（6 出来事）。
2. kill-session・session-cleanup・resource-cleanup・poller・server.ts を表の呼び出しに置き換える（挙動不変。既存テストが緑のまま）。
3. `PATCH /api/worktrees/[id]` にインスタンス削除の行を足し、ルートテストを足す。
4. 使用箇所ガード。

scope.allow 候補:
```
src/lib/auto-yes-lifecycle.ts
src/app/api/worktrees/[id]/kill-session/route.ts
src/app/api/worktrees/[id]/route.ts
src/lib/session-cleanup.ts
src/lib/resource-cleanup.ts
src/lib/auto-yes-poller.ts
server.ts
tests/unit/lib/auto-yes-lifecycle-3184.test.ts
tests/unit/lib/auto-yes-lifecycle-usage-guard-3184.test.ts
tests/unit/api/worktree-patch-instance-removed-auto-yes-3184.test.ts
changelog.d/3184.md
dev-reports/module-reference/3184.md
```

並行で走らせる場合、A と B が同時に触るファイルは無い（`changelog.d/3184.md` と断片だけ。契約ごとに `3184-a.md` / `3184-b.md` に分けると衝突しない）。

---

## 6. 未確認・未決の事項と決め方

| # | 事項 | 決め方 |
|---|---|---|
| 6-1 | 「自由入力」を `kind` でなく `freeText` の軸にした（§2.4） | 根拠はコード（単独で現れる形が無い）。Issue 起票者が 4 値目を求めるならオーケストレーターが判断する。既定は本書どおり |
| 6-2 | V2 承認を `waitingKind: 'prompt'` に上げるか（プッシュの文面、サイドバーの点、relay の対象が変わる） | 挙動変更なので利用者判断。推奨: プッシュと点は上げる（アプリで答えられるのに「ターミナルで」と言うのは #3181 と同じ誤り）。relay は上げない（`relay-triggers.ts:128-131` は `kind === 'prompt'` で別セッションに伝えるが、`relay-delivery.ts:280-290` は DB 行の `options` を列挙するだけで API の選択肢を持たない。relay は別 Issue）。上げる場合は `relay-triggers.ts` に `kind === 'prompt' && !apiAnswerable` の除外が要る。`peekPromptWaiting()`（`prompt-waiting-composition.ts:308-312`）が返す `structured` に `decisionId` があるかは実装時に型で確認する |
| 6-3 | チャット面で、V2 承認のフレームが `isUnclassifiedActive` でも立っている場合、`resolveBlockedReason` の `'unclassified'`（`ChatSurface.tsx:596`、`:597` より先）に当たり、本書の `:597` の修正だけでは「キー入力カード」が残る | **実機不要**。既存 fixture `tests/fixtures/opencode-v2-dialogs-2984/permission.txt` と `tests/fixtures/opencode-v2-live-2945/permission-required.txt` を opencode-v2 の検出器にかけ、`isUnclassifiedFrame(status, reason)` が真になるかを vitest で確かめる。真なら、`api-choices` の判定を `:596` より前に置くか（フレーム判定より API の答え方を優先）を A2 で決める。偽なら `:597` の修正で足りる |
| 6-4 | ブラウザ側で `promptView` を reducer（`PromptState`）に載せるか、コンポーネントで `derivePromptView(prompt.data)` を呼ぶか | 既定は後者（運ぶフィールドが増えない。同じ関数なので結論は同じ）。サーバーとブラウザの版ずれは同一バンドルなので起きない。CLI は別プロセスなので `promptView ?? derive` で読む |
| 6-5 | チャット面の R2 修正は**実機で現象を見ていない**（コードからの読み取り） | 実機確認の手順（ここでは実行しない）: 隔離サーバー（`CM_DB_PATH` を明示、本番以外のポート、`tmux -L` の私設サーバー、起動後に `lsof` で DB パスを実測）で OpenCode V2 を起動し、編集の承認を出させる。チャット面に `chat-surface-unreadable-hint` が出るか、`capture --json` の `promptData.decisionOptions` と `isUnclassifiedActive` を同時に採取する。要る理由: 6-3 の分岐がフレーム次第で、fixture が実機の全フレームを代表する保証が無い |
| 6-6 | プッシュの「ターミナルで」文面が V2 承認で実際に出るか | 6-5 と同じ環境で、プッシュの送信ログ（`push/waiting-notifier`）の `waitingKind` を見る。単体では `deriveWaitingKind` に R2 相当の入力（`hasActivePrompt: false`、`waiting: true`）を与えて `'unclassified'` になることを確認できる |
| 6-7 | `wait` の V2 質問で `options` を埋めると、既存の呼び出し側が「番号を送れる」と読む | `respond` は V2 質問に番号で答えられる（`buildStructuredPromptQuestion`（`structured-prompt.ts:362`）の質問の節が `respond <id> <number>` を案内している）。外部契約の変更だが方向は安全側。CHANGELOG に書く |
| 6-8 | インスタンス削除時にセッション自体を止めるか（UI の削除は PATCH だけで、セッションが残る） | 本 Issue の範囲外（Auto-Yes の状態だけを消す）。セッションが残ること自体は別 Issue にする |
| 6-9 | 起動中の記録（#3179）を同じ表に入れるか | 既定は入れない（§8.3）。`session-starting-state.ts` には worktree 単位の削除関数が無く、#3195 のトークン照合と絡むため |
| 6-10 | 孤児の掃除をインスタンス単位（roster に無い instanceId のキー）にも広げるか | 既定は広げない。roster は `resolveAgentInstances(db, id, selectedAgents)` で導かれ、主インスタンスが暗黙に含まれるので、誤判定で生きている Auto-Yes を消す危険がある。インスタンス削除を PATCH 側で確実に拾うことで足りるかを B の実装後に判断する |

---

## 7. `grep -rl unclassified src` の全 67 ファイル

分類記号:
- **P** = `promptData.type` の `'unclassified'`（本 Issue の対象）
- **F** = フレームの未分類フラグ `isUnclassifiedActive` / `unclassifiedInstanceIds` / 点の表示（画面の読み取り側。範囲外）
- **W** = `WaitingKind` の `'unclassified'`（待ちの種類）
- **R** = Auto-Yes の抑止理由 `'unclassified-frame'`
- **H** = 履歴行の outcome
- **C** = コメントのみ（コード上の参照なし）

`code` 列は `grep -n unclassified` の行のうちコメント行（`*` / `//` / `{/*` 始まり）を除いた行数。

| # | ファイル | 分類 | code | 現状の解釈 |
|---|---|---|---|---|
| 1 | `src/app/api/worktrees/[id]/respond/route.ts` | C（実判定は P） | 0 | DB 行を `isAnswerablePromptData` で 400 拒否。type だけ見る |
| 2 | `src/app/globals.css` | C | 0 | `waitingKind` menu/unclassified の中段階の色の説明 |
| 3 | `src/app/sessions/page.tsx` | F | 8 | `isUnclassifiedCliStatus` → `resolveUnclassifiedDot` で点を描く |
| 4 | `src/cli/commands/capture.ts` | P | 5 | **自前定数** `UNCLASSIFIED_FRAME_TYPE`（`:56`）。type と `source` で `--prompts` の行状態を決める |
| 5 | `src/cli/commands/ls.ts` | C | 0 | `wait --help` への言及 |
| 6 | `src/cli/commands/peers.ts` | C | 0 | #2775 の未分類セッションの説明 |
| 7 | `src/cli/commands/wait.ts` | P / F / R | 8 | **自前定数** `:69`。exit 10 で `options` が空なら **`decisionOptions` も見る**（`:950-953`）。`isUnclassifiedActive` の 60 秒 dwell で type unclassified を合成（`:1064`〜`:1092`）。`'unclassified-frame'` の理由文 `:268` |
| 8 | `src/cli/docs/agent-operations.ts` | ヘルプ文 | 3 | `wait` の unclassified の説明文 |
| 9 | `src/cli/types/api-responses.ts` | P / R | 1 | CLI 側ミラー `PromptData`（`type: string`）、`decisionOptions?` を宣言。`'unclassified-frame'` を union に持つ |
| 10 | `src/components/common/CommandPalette.tsx` | F | 4 | `resolveUnclassifiedDot` で点とラベル |
| 11 | `src/components/layout/RepositoryTabBar.tsx` | F | 6 | 同上（グループ単位） |
| 12 | `src/components/layout/Sidebar.tsx` | F | 3 | 同上 |
| 13 | `src/components/mobile/MobileHeader.tsx` | F | 1 | `data-unclassified` 属性 |
| 14 | `src/components/mobile/MobilePromptSheet.tsx` | P | 3 | type で分ける（`isAnswerablePromptData`）＋ **`decisionId`・`decisionOptions` を payload から自分で読む**（`:876-883`）。見出しは `readStructuredDecisionHeading`、`unclassifiedHeading` を複製（`:1010`） |
| 15 | `src/components/review/ReviewTab.tsx` | F | 5 | `resolveUnclassifiedDot` |
| 16 | `src/components/sessions/SessionTile.tsx` | F | 1 | 同上 |
| 17 | `src/components/sidebar/BranchListItem.tsx` | F | 10 | `isBranchUnclassified` で状態語 |
| 18 | `src/components/sidebar/BranchStatusIndicator.tsx` | F | 6 | `resolveUnclassifiedDot` の定義（`:56`） |
| 19 | `src/components/ui/StatusDot.tsx` | W | 2 | `StatusDotWaitingKind`（`:50`）で中段階の色 |
| 20 | `src/components/worktree/ChatDialogCard.tsx` | C | 0 | カードの説明 |
| 21 | `src/components/worktree/ChatMessageBubble.tsx` | H | 1 | outcome → i18n キー（`:985`） |
| 22 | `src/components/worktree/ChatSurface.tsx` | F / P | 4 | `isUnclassifiedActive` → `'unclassified'`（`:596`）。**type だけ見て** `promptUnreadable`（`:597`）。`decisionOptions` を見ない |
| 23 | `src/components/worktree/ChatTranscript.tsx` | C | 0 | 死んだセッションの行の説明 |
| 24 | `src/components/worktree/MobileTerminalTab.tsx` | C | 0 | エスケープハッチの説明 |
| 25 | `src/components/worktree/prompt-decision-id.ts` | C（実体は P） | 0 | `decisionId` / `decisionOptions` / `askUserQuestion` を読む 3 関数。`PromptView` の前身 |
| 26 | `src/components/worktree/PromptAnswerKeys.tsx` | C | 0 | 答えキーの説明 |
| 27 | `src/components/worktree/PromptPanel.tsx` | P | 6 | type で分ける＋**通知の中で `decisionOptions`** を読む（`:577`）。`decisionId` は prop。`unclassifiedHeading`（`:1290`） |
| 28 | `src/components/worktree/TerminalEscapeHatch.tsx` | C | 0 | 未分類オーバーレイ用キーの説明 |
| 29 | `src/components/worktree/TerminalSplitPane.tsx` | F | 1 | `data-unclassified` 属性 |
| 30 | `src/components/worktree/TerminalSplitPaneContent.tsx` | C（実判定は P） | 0 | 送信 body の型の絞り込みに `isAnswerablePromptData`（`:666`）。`readPromptDecisionId`（`:759`）をパネルへ |
| 31 | `src/components/worktree/WorktreeDetailRefactored.tsx` | F | 1 | `resolveUnclassifiedDot` |
| 32 | `src/components/worktree/WorktreeDetailSubComponents.tsx` | F | 5 | 同上（インスタンス単位） |
| 33 | `src/config/detection-evidence-config.ts` | C | 0 | `unclassified_frames` 計数の説明 |
| 34 | `src/config/pane-polling-cadence.ts` | C | 0 | ポーリング間隔の説明 |
| 35 | `src/hooks/useTerminalPanePolling.ts` | F | 11 | `isUnclassifiedActive` を回数と経過時間で確定（`:487-504`） |
| 36 | `src/hooks/useWorktreeDetailController.ts` | C（実判定は P） | 0 | 送信 body の型の絞り込み（`:1236`） |
| 37 | `src/lib/auto-yes-poller.ts` | R | 3 | 抑止を `'unclassified-frame'` で記録（`:636`、`:678`） |
| 38 | `src/lib/chat/chat-tool-approvals.ts` | H / P | 4 | **type または status** が unclassified なら outcome `'unclassified'`（`:546`） |
| 39 | `src/lib/chat/dialog-frame.ts` | C | 0 | — |
| 40 | `src/lib/detection/cli-patterns.ts` | C | 0 | — |
| 41 | `src/lib/detection/idle-evidence-observation.ts` | C | 0 | — |
| 42 | `src/lib/detection/selection-shape.ts` | C | 0 | — |
| 43 | `src/lib/detection/status-detector.ts` | C | 0 | — |
| 44 | `src/lib/detection/tools/antigravity/detect.ts` | C | 0 | — |
| 45 | `src/lib/detection/tools/antigravity/dialog.ts` | C | 0 | — |
| 46 | `src/lib/detection/tools/command-code/detect.ts` | C | 0 | — |
| 47 | `src/lib/detection/tools/opencode-v2/detect.ts` | C | 0 | — |
| 48 | `src/lib/detection/tools/opencode/detect.ts` | C | 0 | — |
| 49 | `src/lib/detection/tools/types.ts` | C | 0 | — |
| 50 | `src/lib/detection/unclassified-frame-tracker.ts` | F | 4 | 未分類フレームの継続を `globalThis` の Map で追う |
| 51 | `src/lib/polling/antigravity-permission-receipts.ts` | C | 0 | — |
| 52 | `src/lib/polling/auto-yes-resolver.ts` | R | 1 | 抑止理由 union（`:81`） |
| 53 | `src/lib/push/push-sender.ts` | W | 1 | `needsTerminal()`：menu か unclassified なら「ターミナルで」（`:338`） |
| 54 | `src/lib/push/waiting-push-notifier.ts` | W | 1 | `isUnnamedWait()`：null か unclassified なら 8 秒保留（`:193`） |
| 55 | `src/lib/realtime/types.ts` | C | 0 | `WaitingKind` フィールドの説明 |
| 56 | `src/lib/relay/relay-triggers.ts` | C（実判定は W） | 0 | `kind !== 'prompt'` で除外（`:128-131`） |
| 57 | `src/lib/session/current-output-builder.ts` | P（生成側）/ F | 7 | `UnclassifiedFrameRecord` を書く（`:959-960`）、`isUnclassifiedActive` を公開（`:2204`） |
| 58 | `src/lib/session/layer-disagreement.ts` | C | 0 | — |
| 59 | `src/lib/session/session-starting-state.ts` | C | 0 | — |
| 60 | `src/lib/session/status-evidence.ts` | C | 0 | `isUnclassifiedFrame` の定義の説明 |
| 61 | `src/lib/session/status-mapping.ts` | F | 2 | 引数 `unclassified` で `isProcessing` を倒す（`:246`、`:252`） |
| 62 | `src/lib/session/structured-prompt.ts` | P（生成側） | 2 | `type: UNCLASSIFIED_PROMPT_TYPE` で劣化形 2 種、履歴行は `status: 'unclassified'` |
| 63 | `src/lib/session/waiting-kind.ts` | W | 2 | 型 `WaitingKind`（`:29`）、フォールバック `'unclassified'`（`:75`）。**`decisionOptions` を見ない** |
| 64 | `src/lib/session/worktree-status-helper.ts` | W | 1 | `WAITING_KIND_PRIORITY`（`:323`） |
| 65 | `src/lib/sidebar-utils.ts` | F | 4 | `isBranchUnclassified`、`unclassified: true` の付与 |
| 66 | `src/types/models.ts` | P / F | 4 | 定数 `:565`、`UnclassifiedFrameRecord` `:586`（`status: 'unclassified'`）、`waitingKind` 型 `:105` |
| 67 | `src/types/sidebar.ts` | W / F | 19 | `BranchWaitingKind` `:44`、`unclassifiedInstanceIds` |

### 7.1 「unclassified」という語を含まない該当ファイル（Issue の 21 に入る 3 つ）

| ファイル | 現状の解釈 |
|---|---|
| `src/hooks/useAutoYes.ts` | `:93` `isAnswerablePromptData` で答えないと決める（type だけ見る） |
| `src/lib/relay/relay-delivery.ts` | `:282` 選択肢の列挙、`:459` 質問文の取り出し（type だけ見る） |
| `src/types/ui-state.ts` | `:31` コメントで `isAnswerablePromptData` を案内 |

### 7.2 Issue の 21 ファイルと本書の扱い

21 = 上表のうち #1, 4, 7, 9, 14, 19, 22, 27, 30, 36, 38, 53, 54, 57, 62, 63, 66, 67 の 18 ファイル ＋ §7.1 の 3 ファイル。移行の扱いは §3 の対応表に全部ある（P は置き換え／理由つきで残す、W は §6-2 次第、F と R は範囲外＝画面の読み取り側）。

---

## 8. B: Auto-Yes の寿命

### 8.1 前提: #3182 の判断と、入っているもの

- #3182 は「B（止めたら切る）」に決まり、`c2f0a928`（PR #3188）でマージ済み。kill-session は route の `targets`（instance 指定ならその 1 つ、無指定なら主＋roster）すべてについて、**kill の成否・セッションの有無・他サーバー所有に関係なく** `disableAutoYes(id, cliToolId, undefined, instanceId)`（理由なし＝手動無効と同じ）と `stopAutoYesPolling(buildCompositeKey(...))` を呼ぶ（`kill-session/route.ts:218-221`）。新しい停止理由は足していない。テストは `tests/unit/api/kill-session-auto-yes-3182.test.ts`。
- `ee314d38`（PR #3192, #3179）が同じループに `clearSessionStarting(id, cliToolId, instanceId)` を足した。`02e30e94`（#3195）で起動ごとのトークンが入り、kill-session はトークンなしで誰の記録でも消す。

### 8.2 出来事の表

`src/lib/auto-yes-lifecycle.ts` に次の表を置く。**状態の扱い**は 2 通り:
- `disable` = `enabled: false` にして `stopReason` を残す。インスタンスが**まだ存在する**とき（画面に「止まった理由」を出せる）。
- `delete` = Map からキーを消す。インスタンスや worktree が**もう存在しない**とき（残すと掃除する経路が無い。`resource-cleanup` は worktree 単位でしか掃除しない）。

| 出来事 `AutoYesLifecycleEvent` | 入口（呼ぶ側） | 対象 | 状態 | stopReason | poller | 現状 | 新 |
|---|---|---|---|---|---|---|---|
| `session-killed` | `kill-session/route.ts:218-221` | インスタンス | disable | なし（#3188 の判断どおり） | 止める | #3188 で実装済み | **表の呼び出しに置き換え（挙動不変）** |
| `instance-removed` | `PATCH /api/worktrees/[id]`（`route.ts:216-246`、`setAgentInstances` の前後の roster の差分） | 削除されたインスタンス | delete | — | 止める | 何もしない | **追加** |
| `worktree-deleted` | `session-cleanup.ts:123` / `:133`（`DELETE /api/repositories`、`syncWorktreesAndCleanup` 経由の sync / scan / restore / clone-manager） | worktree 全体 | delete | — | 止める | 実装済み | 表の呼び出しに置き換え。順序（poller → state → schedule、#404）は保つ |
| `orphan-swept` | `resource-cleanup.ts:236-257`（24 時間ごと） | 1 キー | delete | — | 止める | 実装済み | 表の呼び出しに置き換え |
| `consecutive-errors` | `auto-yes-poller.ts:225-235` | 1 キー | disable | `'consecutive_errors'` | 止める | 実装済み | 循環を避けるため poller は行と同じ値を直接適用し、テストで一致を固定（§8.4） |
| `server-shutdown` | `server.ts:908` | 全部 | （プロセス終了で Map ごと消える。明示の削除はしない） | — | 全部止める | 暗黙 | 表に明記し、`stopAllAutoYesPolling` を表経由で呼ぶ。再起動後に復元しない（永続化を足さない）ことを仕様として書く |

表に**入れない**もの（「消す」出来事ではないため）と理由:
- 手動の無効化（`auto-yes/route.ts:409-431`）、期限切れ（`auto-yes-state.ts:201` の読み取り時）、停止パターン（`:459`）: 利用者の操作か Auto-Yes 自身の条件で、寿命の出来事ではない。今の場所に残す。
- worktree ID の移行（`worktree-session-reconcile.ts:619-631`）: 状態を**移す**出来事で、消さない。表の注記に「消さない出来事」として名前だけ載せる。

### 8.3 隣接する状態（参考。表には入れない）

| 出来事 | 起動中の記録（#3179） | 理由 |
|---|---|---|
| `session-killed` | kill-session が `clearSessionStarting` を呼ぶ（トークンなし） | #3192 / #3195 のまま。route に残す |
| その他 | 呼ばない | 起動の `finally`（トークン照合）で消える。worktree 単位の削除関数が無い（§6-9） |

Auto-Yes の表に起動中の記録を混ぜると、`auto-yes-lifecycle.ts` が `session-starting-state.ts`（AsyncLocalStorage とトークン）に依存する。2 つは寿命の決まり方が違う（Auto-Yes は利用者の許可、起動中は起動処理の進み具合）ので分けておく。

### 8.4 関数

```ts
// src/lib/auto-yes-lifecycle.ts
export type AutoYesLifecycleEvent =
  | 'session-killed' | 'instance-removed' | 'worktree-deleted'
  | 'orphan-swept' | 'consecutive-errors' | 'server-shutdown';

export interface AutoYesLifecycleRule {
  state: 'disable' | 'delete' | 'none';
  stopReason?: AutoYesStopReason;
  poller: 'stop';
}

export const AUTO_YES_LIFECYCLE: Readonly<Record<AutoYesLifecycleEvent, AutoYesLifecycleRule>>;

export type AutoYesLifecycleTarget =
  | { scope: 'instance'; worktreeId: string; cliToolId: CLIToolType; instanceId?: string }
  | { scope: 'worktree'; worktreeId: string }
  | { scope: 'key'; compositeKey: string }
  | { scope: 'all' };

export function stopAutoYesPollersFor(event: AutoYesLifecycleEvent, target: AutoYesLifecycleTarget): void;
export function applyAutoYesStateRule(event: AutoYesLifecycleEvent, target: AutoYesLifecycleTarget): void;
/** poller を止めてから、表の規則で状態を消す（上の 2 つを順に呼ぶ）。 */
export function releaseAutoYes(event: AutoYesLifecycleEvent, target: AutoYesLifecycleTarget): void;
```

- **#3188 の扱い: 再利用ではなく置き換え（挙動は同一）**。`kill-session/route.ts:219-220` の 2 行を `releaseAutoYes('session-killed', { scope: 'instance', worktreeId: id, cliToolId, instanceId })` の 1 行にする。`disable` ＋理由なし＋poller 停止という #3188 の中身は表の `session-killed` 行がそのまま持つ。`targets` の集め方（kill の成否に関係なく全 target）は route に残す（どれを対象にするかは route の知識）。`kill-session-auto-yes-3182.test.ts` は**変更せずに**緑であることを置き換えの合格条件にする。
- poller と状態の順序: 同期関数の中で続けて呼ぶので、間に poll が割り込むことはない（JS は単一スレッドで、`stopAutoYesPolling` も `disableAutoYes` も同期）。順序は `session-cleanup.ts` のコメント（#404）に合わせて poller → 状態に統一する。
- **循環 import を作らない**（実装で変えた点）: `auto-yes-lifecycle.ts` は、cleanup 系のテスト（`session-cleanup*.test.ts`、`resource-cleanup.test.ts`）が `@/lib/polling/auto-yes-manager` を `vi.mock` しているため、その barrel 経由で state と poller を import する。barrel は poller を再 export するので、**poller から lifecycle を import すると循環になる**。単一ファイルの scope では表と状態適用を別モジュールに分けられないため、poller の連続エラー（`auto-yes-poller.ts` の `incrementErrorCount`）は**表の `consecutive-errors` 行と同じ値を直接適用**し、理由をコメントに書いた。表の行と poller の呼び出しが一致することは `auto-yes-lifecycle-3184.test.ts` が両端（表の値と poller のソースの `disableAutoYes(worktreeId, cliToolId, 'consecutive_errors',`、lifecycle を import していないこと）で固定する。
- **2 つの半分を公開する**（実装で足した点）: `releaseAutoYes` = `stopAutoYesPollersFor(event, target)` → `applyAutoYesStateRule(event, target)`。`session-cleanup` は poller と状態の失敗を別々に `pollerErrors` へ積む（既存テスト `session-cleanup-issue404`）ので 2 つを別の try で呼び、`resource-cleanup` は状態キーと poller キーを別々のループで掃除するので、それぞれのループで片方を呼ぶ。
- インスタンス削除の検出: PATCH ハンドラで `setAgentInstances` の**前に** `resolveAgentInstances(db, id, worktree.selectedAgents)` で旧 roster を読み（実装メモ: `getAgentInstances` ではなく resolver にした。roster を保存していない worktree の暗黙の主インスタンスも「旧 roster」に含めるため）、`(id, cliTool)` の組で比べて新 roster に無い組について `releaseAutoYes('instance-removed', …)`（同じ id が別ツールに付け替えられた場合は旧ツール側を消す）。`setAgentInstances` が失敗（400）した場合は呼ばない。主インスタンス（`instanceId === cliToolId`）は 2 部のキーになる（`buildCompositeKey`、`auto-yes-state.ts:52-64`）が、`buildCompositeKey` を通すので呼ぶ側は区別しなくてよい。

### 8.5 出来事ごとの単体テスト（`tests/unit/lib/auto-yes-lifecycle-3184.test.ts`）

| 出来事 | 準備 | 期待 | 陰性対照 |
|---|---|---|---|
| `session-killed` | 2 インスタンスを有効化、poller 起動 | 対象は `enabled: false`・`stopReason` なし・poller 停止 | もう一方は有効のまま |
| `instance-removed` | 同上 | 対象のキーが `getAutoYesStateCompositeKeys()` から消え、poller 停止 | 同上 |
| `worktree-deleted` | 2 worktree に状態 | 対象 worktree のキーが全部消える | 他 worktree は残る |
| `orphan-swept` | 1 キー | そのキーだけ消える | — |
| `consecutive-errors` | 1 キー | `enabled: false`・`stopReason: 'consecutive_errors'` | — |
| `server-shutdown` | poller 複数 | `getActivePollerCount() === 0`。状態の Map には触れない（プロセス終了で消える前提を表で明示） | — |

加えて、表の全キーに規則があること（`Object.keys(AUTO_YES_LIFECYCLE)` が 6 件）と、§4.2 の使用箇所ガードで「表を通らない削除が無い」ことを固定する。
