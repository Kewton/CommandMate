# 実機実測: Command Code 1.54.1 の `AskUserQuestion` 画面とキー意味論

- **Issue**: [#2754](https://github.com/Kewton/CommandMate/issues/2754)（親 [#2756](https://github.com/Kewton/CommandMate/issues/2756)、Blocks [#2755](https://github.com/Kewton/CommandMate/issues/2755)）
- **ステータス**: 実測完了（**検出ルールの変更なし**。`src/` の変更は `verified-against.ts` の docblock のみ）
- **検証日**: 2026-09-20
- **対象**: Command Code **1.54.1**（`command-code@1.54.1`、全フレームのバナー行 `# Command Code v1.54.1`）
- **プラットフォーム**: macOS (Darwin 27.0.0) / `/opt/homebrew/bin/commandcode` / model `deepseek-v4.1-flash`
- **隔離**: 専用 tmux ソケット `tmux -L cc1541-probe`、使い捨て git リポジトリ、`env -i` 1 行。**本人稼働中の `mcbd-*` セッションには一切触れていない**（既定ソケットの 22 セッションは前後で不変）
- **成果物**: 本書 ＋ [`tests/fixtures/command-code-askuserquestion-2754/`](../../tests/fixtures/command-code-askuserquestion-2754/README.md)（採取 26 枚 ＋ README）＋ `tests/unit/detection/tools/command-code/askuserquestion-1541-2754.test.ts`
- **一次証拠**: 上記 26 枚。すべて `tmux -L cc1541-probe capture-pane -p -e -S - -N -E -` の 200x1000 生フレーム（ANSI つき）。編集は cwd 行のパス置換 1 箇所のみ

> **本書に書いてあるのは推測ではなく、1 キーずつ送って前後のペインを採った結果である。**
> 測れなかったものは「未測」と書く。§4 の表は 1 行ごとに採取ファイル名を持つ。

---

## 1. 結論サマリ

| # | 測ったこと | 実測結果 | 採取 |
|---|---|---|---|
| 1 | `Submit` 行のカーソル描画 | **`❯ Submit`**。U+276F ＋ 半角空白 ＋ 素の単語、列 0 始まり、**番号は付かない**。SGR は前景 1 本（`ESC[38;5;189m❯ SubmitESC[39m`）で背景属性なし。合成フレームの想定どおりだった | `multiselect-cursor-on-submit.txt` |
| 2 | 確定行のラベル | 最後の質問では `Submit`、それ以外では **`Next`**。どちらも番号なし | `multiselect-cursor-on-next.txt` |
| 3 | フッタ | **質問が 1 つだけのときは 1 行も描かれない**。複数質問のときだけ `Enter to select \| … \| Esc to cancel` が出る。したがって**フッタは 1.54.1 の question 画面の必要条件ではない** | `tabs-single-question.txt`（無）/ `multiselect-initial.txt`（有） |
| 4 | 質問 1 つのときのタブ行 | **`● Update scope \| ◯ Review` の 2 セル**。`Review` セルは常に付く。**1 セル行は発生しない**（＝ `segments.length < 2` の緩和は不要） | `tabs-single-question.txt` |
| 5 | 回答済みタブ | `✔`（U+2714）。**この 1 文字が `isCommandCodeQuestionTabRow` を落とし**、質問 1 つ答えた時点で以降の全画面が #2521 の region reading に届かなくなる | `singleselect-answered-tabs.txt` |
| 6 | `Enter` の意味 | 単一選択では確定。**複数選択の選択肢行では「その行のトグル」**で、質問は出たまま。`Submit` 行では**送信ではなく Review ページへ遷移** | §4 |
| 7 | `1`–`9` の意味 | 単一選択では即確定＋次へ。**複数選択ではトグル（カーソルは動かない）**。カーソルが一覧から外れていると**完全に無反応** | §4 |
| 8 | `Space` | フッタに載っていないが効く。**ただしカーソルが一度も動いていないと無反応**、`Submit` 行にいるときは**見えていない行（実測では option 1）をトグルする**。フレームからは効き先が判らない | §4 |
| 9 | `Esc` | **1 打で質問ごと取り消し**（`└ User declined to answer questions`）。タブは戻らない。notes 入力を開いていても同じ | §4 |
| 10 | `n` / `c` | `n` は `❯ notes:` 入力行を挿入（破壊的ではない）。`c` は**1 打でダイアログを閉じ、その時点の回答を「相談したい」として送る**。どちらも確認なし | §4 |
| 11 | 未文書キー `d` | **フッタにない `d` が複数選択を終了させる**。未回答のまま押すと `⚠ You have not answered all questions` ＋ `No answer` で Review ページへ | §4 |
| 12 | いまの検出チェーンの読み | 26 枚中 **17 枚が誤読**。うち **6 枚は `ready`/`input_prompt`（＝ #2521 の偽完了）**、7 枚はチェックボックス一覧が単一選択 payload として出てくる | §5 |

### 1.1 #2755 が特に依拠すべき結論

1. **`Submit` 行の実描画は `❯ Submit`**（§1-1）。合成フレームで代用する必要はもう無い。
2. **偽完了の条件は「`Submit` という単語」ではなく「`❯` が選択肢一覧の外に出たこと」**。`Submit` / `Next` / `notes:` の 3 種で同じ結果になる（§5）。
3. **`Enter` は確定キーではない**（§1-6）。複数選択で送ると回答が 1 つ増減するだけ。
4. **確定には 2 段ある**: 選択肢 → `Submit`/`Next` 行 → Review ページの `1. Submit`。GUI から確定させるなら Review ページまで渡る必要がある。
5. **送信対象から外すべきキー**: `Space`（効き先がフレームから判らない）、`Esc`（1 打で取り消し）、`c`（1 打で送信）、`d`（未文書の終了）、`n`（モード切替）。**`1`–`9` はカーソルが一覧にあるときだけ有効**。
6. **自由文行にフォーカスがあると数字は文字として入る**（§4）。GUI の自由文経路は「行に移動してから打つ」ことが必須で、移動していないと composer ではなくこの行に落ちるのではなく、**数字がトグルではなく本文になる**。

---

## 2. 隔離環境（再現手順）

```bash
# 1. 使い捨てリポジトリ（os.tmpdir() 配下。本物のリポジトリは開かない）
mkdir -p /private/tmp/cc1541-probe/sample-repo && cd /private/tmp/cc1541-probe/sample-repo
git init -q && printf 'export function add(a, b) {\n  return a + b;\n}\n' > calc.js
git add -A && git -c user.email=probe@example.invalid -c user.name=probe commit -qm init

# 2. 専用ソケットで 200x1000 のペインを立てる（env -i は必ず 1 行で書く）
tmux -L cc1541-probe new-session -d -s probe -x 200 -y 1000 -c /private/tmp/cc1541-probe/sample-repo "env -i HOME=$HOME PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin TERM=xterm-256color LANG=en_US.UTF-8 commandcode"

# 3. 採取（ANSI と罫線を残す）
tmux -L cc1541-probe capture-pane -p -e -S - -N -E - -t probe > frame.txt

# 4. 後始末（-L を必ず付ける。既定サーバには触れない）
tmux -L cc1541-probe kill-server
```

`HOME` は本物を渡している（Command Code の既存の認証を読ませるため）。`$HOME` 直下には
何も作っていない（`~/.commandcode` は既存）。CommandMate のサーバ・デーモンは一切起動していない。

質問画面は「`ask_user_question` を 1 回だけ、この質問とこの選択肢で呼べ」とエージェントに
指示して出した。**内容は作り物、描画とキー意味論は本物**である。

### 2.1 採取のラン構成

| ラン | 質問の構成 | 何を測ったか |
|---|---|---|
| A | 単一 / 単一 / **複数**（3 問） | 回答済みタブ、複数選択の全キー、自由文、notes、`Esc` |
| B | **複数**（1 問） | 1 問だけのタブ行、フッタ無しの `❯ Submit`、`Enter` → Review → 送信 |
| C | **複数** / 単一（2 問） | `Next` 行、選択肢行での `Esc` |
| D | **複数** / 単一（2 問） | 選択肢行での `Enter`、`Next` 行での `Enter`、`c` |
| E | **複数**（1 問） | `Submit` 行での `Space` / 数字、未文書キー `d` |
| F | **複数**（1 問） | `↑` の遷移先（一覧内の巻き戻しと `Submit` への跳躍） |

---

## 3. 画面の実測形

### 3.1 複数選択（最後の質問、複数質問のうちの 1 つ）

`multiselect-cursor-on-submit.txt` の該当行（ANSI を落としたもの）:

```text
────────────────────────────────────────  (200 列の U+2500)
✔ Party size | ✔ Rental car | ● Update scope | ◯ Review

Which files should I update?

  1. [ ] calc.js
        Update calc.js.
  2. [✔] README.md
        Update README.md.
  3. [ ] docs
        Update the docs directory.
  4. [✔] tests
        Update the tests.
  5. [ ] Type something...
❯ Submit

Enter to select | Arrow keys to navigate | 1-9 quick select | n notes | c chat | Esc to cancel
```

読み取れること:

- 選択肢の説明のインデントは**複数選択で 8 桁**（単一選択は 5 桁）。チェックボックス 4 桁分ずれる
- **自由文行も番号を持ち、チェックボックスを持つ**（`5. [ ] Type something...`）
- `Submit` は**番号を持たない**。したがって「1.…N. の厳密な連番」は `Submit` の 1 行上で終わる
- タブ行の `✔` は**回答済み**、`●` は**いま表示中**、`◯` は**未回答**

### 3.2 質問 1 つのとき（フッタなし）

`tabs-single-question.txt`:

```text
────────────────────────────────────────
● Update scope | ◯ Review

Which files should I update?

❯ 1. [ ] calc.js
        Update calc.js.
  2. [ ] README.md
        Update README.md.
  3. [ ] docs
        Update the docs directory.
  4. [ ] Type something...
  Submit
```

**フッタが 1 行も無い。** 罫線・タブ行・質問・選択肢・確定行で終わる。

### 3.3 Review ページ

`review-page-submit-cancel.txt`:

```text
✔ Update scope | ● Review

1. Which files should I update?
   calc.js

❯ 1. Submit
  2. Cancel

← to go back and edit
```

未回答があると `⚠ You have not answered all questions` と `No answer` が入る
（`review-page-unanswered-warning.txt`）。

---

## 4. キー意味論（1 キーずつ送って前後を採取した結果）

**送信は `tmux -L cc1541-probe send-keys` で 1 打ずつ。** 「前」「後」は採取ファイル名。
同じファイル名が「前」と「後」に並んでいる行は、**送った結果フレームがバイト単位で変わらなかった**
ことを意味する（`cmp` で確認済み）。

### 4.1 数字キー `1`–`9`

| 送ったキー | 前（採取） | 後（採取） | 観測された変化 |
|---|---|---|---|
| `2`（単一選択・選択肢行） | `singleselect-initial-unanswered-tabs.txt` | `singleselect-answered-tabs.txt` | **その場で確定し次の質問へ進んだ**。タブが `● Party size` → `✔ Party size` になり、`● Rental car` が表示中になった |
| `2` → `4`（複数選択・選択肢行、1 打ずつ） | `multiselect-initial.txt` | `multiselect-two-checked.txt` | **チェックをトグルするだけ**。option 2 と 4 が `[✔]` になり、**`❯` は option 1 から動かなかった**。質問は出たまま |
| `1`（自由文行にフォーカス） | `multiselect-free-text-typed.txt` | `multiselect-free-text-digit-appended.txt` | **本文に文字として入った**（`docs/api.md` → `docs/api.md1`）。どのチェックも動かない |
| `2`（`Submit` 行にカーソル） | `multiselect-submit-row-space-ticked-option-1.txt` の直後の状態（`Space` で戻した `multiselect-cursor-on-submit-no-footer.txt` と同形） | 同（**バイト単位で無変化**） | **完全に無反応**。カーソルが一覧を離れると quick-select は死ぬ |

> 4 行目の「前」は run E の `Space` 2 回でチェックを元に戻した直後のフレームで、`cmp` により
> `Space` 前のフレームと**バイト一致**している。committed しているのは同形の
> `multiselect-cursor-on-submit-no-footer.txt`（run B、option 1 のみ `[✔]`）。

### 4.2 `Enter`

| 送ったキー | 前（採取） | 後（採取） | 観測された変化 |
|---|---|---|---|
| `Enter`（単一選択・選択肢行） | `singleselect-answered-tabs.txt` | `multiselect-initial.txt` | **カーソル行を確定し次の質問へ**。`✔ Party size \| ✔ Rental car \| ● Update scope` |
| `Enter`（複数選択・選択肢行） | `multiselect-next-row-not-last-question.txt`（同一の質問・選択肢。run C の採取で、transcript だけが異なる） | `multiselect-enter-toggled-option-1.txt` | **カーソル行をトグルしただけ**（`❯ 1. [✔] Shallow`）。**質問は閉じない** |
| `Enter`（自由文行、複数選択） | `multiselect-free-text-typed.txt` | `multiselect-free-text-typed.txt`（**バイト一致**） | **画面上は何も起きない**。自由文はすでにチェック済みなので、確定でも送信でもない |
| `Enter`（`Next` 行） | `multiselect-cursor-on-next.txt` | `singleselect-answered-tabs.txt` と同形（run D の採取は committed していない） | **次の質問へ進んだ**。タブが `✔ Depth \| ● Output \| ◯ Review` になった |
| `Enter`（`Submit` 行） | `multiselect-cursor-on-submit-no-footer.txt` | `review-page-submit-cancel.txt` | **送信されない。Review ページが開いた**（`❯ 1. Submit` / `2. Cancel` / `← to go back and edit`） |
| `Enter`（Review ページの `❯ 1. Submit`） | `review-page-submit-cancel.txt` | 送信後のフレームは committed していない（`└ Which files should I update? → calc.js` が transcript に出る） | **ここで初めて回答が送られた** |

### 4.3 `Space`

| 送ったキー | 前（採取） | 後（採取） | 観測された変化 |
|---|---|---|---|
| `Space`（カーソルを一度も動かしていない状態） | `multiselect-two-checked.txt` | `multiselect-two-checked.txt`（**バイト一致**） | **無反応**。ハイライト通知がまだ 1 度も出ていないため |
| `Space`（`↓` を 1 回打ったあと、カーソル行の上） | `multiselect-cursor-on-option-2.txt` | `multiselect-space-untoggled-cursor-row.txt` | **カーソル行をトグルした**（option 2 の `[✔]` が `[ ]` に） |
| `Space`（`❯` が `Submit` 行にある状態） | `multiselect-cursor-on-submit-no-footer.txt` と同形（run E。チェックなし） | `multiselect-submit-row-space-ticked-option-1.txt` | **カーソルが居ない option 1 に `[✔]` が付いた**。`❯` は `Submit` のまま。もう 1 回 `Space` で元に戻る（トグル） |

> 3 行目が #2755 にとって重要な理由: **`Space` がどの行に当たるかは画面から判らない。**
> `multiselect-cursor-on-option-1-after-nav.txt` は「矢印を打つ前のフレーム」と**バイト一致**する
> のに、`Space` の挙動は 1 行目と 2 行目で違う。つまり内部のハイライト状態はペインに現れない。

### 4.4 `↑` / `↓`

| 送ったキー | 前（採取） | 後（採取） | 観測された変化 |
|---|---|---|---|
| `↓`（option 1 の上） | `multiselect-two-checked.txt` | `multiselect-cursor-on-option-2.txt` | 1 行下へ |
| `↓`（最後の選択肢の上） | `multiselect-free-text-focused.txt` の 1 つ前（option 4。committed していない） | `multiselect-free-text-focused.txt` | **自由文行に入る**（TextInput にフォーカス） |
| `↓`（自由文行の上） | `multiselect-free-text-focused.txt` | `multiselect-cursor-on-submit.txt` | **`Submit` 行に止まる**。矢印は `Submit` にも止まる |
| `↑`（`Submit` 行の上） | `multiselect-cursor-on-submit.txt` | `multiselect-free-text-focused.txt`（**バイト一致**） | 自由文行に戻る |
| `↑`（一覧に入ってから option 1 の上） | `multiselect-cursor-on-option-1-after-nav.txt` | `multiselect-up-from-option-1-lands-on-submit.txt` | **自由文行を飛ばして `Submit` に跳んだ** |
| `↑`（矢印を一度も打っていない状態の option 1 の上） | `multiselect-cursor-on-option-1-after-nav.txt`（**バイト一致**する初期フレーム） | `multiselect-up-from-option-1-wraps-to-last.txt` | **一覧の中で最後の選択肢に巻き戻った**（`Submit` には行かない） |

> 最後の 2 行は同じキーで行き先が違う。初期状態から最短で `Submit` に着く手順は
> **`↓` → `↑` → `↑`** の 3 打（選択肢の数に依らない）。

### 4.5 `Esc`

| 送ったキー | 前（採取） | 後（採取） | 観測された変化 |
|---|---|---|---|
| `Esc`（選択肢行） | `multiselect-next-row-not-last-question.txt` | `not-applicable-question-cancelled.txt` | **質問ごと取り消された**。`└ User declined to answer questions`、composer が戻る。**タブは戻らない** |
| `Esc`（`notes:` 入力を開いた状態） | `multiselect-notes-row-open.txt` | `not-applicable-cancelled-from-notes-row.txt` | **notes を閉じるだけでなく、質問ごと取り消された**。ターン継続中に当たったので `✻ Thinking…` が残っている |

> 本 Issue の「測っている最中に `Esc` などで質問が消えた」場合の申し送り: **消えた**。
> 2 回とも同じ結果で、**本番セッションには送っていない**。

### 4.6 `n` / `c` / `d`

| 送ったキー | 前（採取） | 後（採取） | 観測された変化 |
|---|---|---|---|
| `n` | `multiselect-free-text-typed.txt`（この後 `↑` を 1 打。その中間フレームは committed していない） | `multiselect-notes-row-open.txt` | **`❯ notes: Add notes on this design…` の入力行が、自由文行と `Submit` の間に挿入された**。`❯` はその行へ移る。ファイルは書かれず、セッションも変わらない |
| `c` | `singleselect-answered-tabs.txt` と同形（run D の Q2。committed していない） | `not-applicable-chat-disposition.txt` | **1 打でダイアログが閉じ**、`└ User wants to discuss the questions instead of answering` になった。その時点までの回答が「相談」として送られる。確認は無い |
| `d`（**フッタに無い**） | `multiselect-cursor-on-option-3-nothing-checked.txt` | `review-page-unanswered-warning.txt` | **複数選択を終了させた**。未回答のまま Review ページへ行き `⚠ You have not answered all questions` / `No answer` |

`d` は Issue 本文の測定対象に挙がっていないが、**フッタに書かれていない 1 文字キーが回答を
確定方向に進める**という点で `n` / `c` と同じ危険度を持つため測った。破壊的な副作用
（ファイル書き込み等）は観測していない。

### 4.7 未測のもの

| 項目 | 理由 |
|---|---|
| `←` / `→` によるタブ移動 | 本 Issue の測定対象キーに含まれていないため送っていない。Review ページのフッタ `← to go back and edit` は採取に写っているが、押していないので**未測** |
| 単一選択画面での `Space` / `d` | 複数選択に絞って測った。**未測** |
| `Ctrl+V`（画像貼り付け）・`Ctrl+G`（外部エディタ） | 送っていない。**未測** |
| 1.53.x の同じ画面 | 手元にあるのは 1.54.1 のみ。**未測**（#2521 の報告値がすべて） |

---

## 5. いまの検出チェーンが 1.54.1 をどう読むか（実測）

`askuserquestion-1541-2754.test.ts` が 26 枚すべてについて固定している。要約:

| 読み | 枚数 | 該当 | 正しいか |
|---|---|---|---|
| `waiting` / `command_code_selection_list` / `hasActivePrompt:false`（#2521 のフォールバック） | 6 | `tabs-single-question` / `multiselect-next-row-not-last-question` / `multiselect-cursor-on-option-1-after-nav` / `multiselect-cursor-on-option-3-nothing-checked` / `multiselect-up-from-option-1-wraps-to-last` / `multiselect-enter-toggled-option-1` | **正しい** |
| `waiting` / `prompt_detected` / `hasActivePrompt:true`（`readCommandCodeQuestionDialog` が読んだ） | 1 | `singleselect-initial-unanswered-tabs` | **半分誤り** — 選択肢 4 のラベルに**新フッタ 1 行がまるごと畳み込まれている** |
| `waiting` / `prompt_detected` / `hasActivePrompt:true`（**汎用パーサ**が読んだ） | 10 | `singleselect-answered-tabs` / `multiselect-initial` / `multiselect-two-checked` / `multiselect-cursor-on-option-2` / `multiselect-space-untoggled-cursor-row` / `multiselect-free-text-*` 3 枚 / `review-page-*` 2 枚 | **誤り** — チェックボックス一覧が `[ ] ` 付きラベルの単一選択 payload になる |
| `ready` / `input_prompt` / `hasActivePrompt:false`（偽完了） | 6 | `multiselect-cursor-on-submit` / `-no-footer` / `multiselect-up-from-option-1-lands-on-submit` / `multiselect-cursor-on-next` / `multiselect-notes-row-open` / `multiselect-submit-row-space-ticked-option-1` | **誤り** — `commandmate wait` が exit 0 する |
| `ready` / `input_prompt`（質問が本当に消えている） | 2 | `not-applicable-question-cancelled` / `not-applicable-chat-disposition` | **正しい** |
| `running` / `thinking_indicator` | 1 | `not-applicable-cancelled-from-notes-row` | **正しい** |

### 5.1 誤読の原因は 2 つあり、独立している

1. **`✔`（U+2714）がタブ行判定を落とす。**
   `COMMAND_CODE_TAB_SEGMENT_PATTERN`（`selection-shape.ts`）は各セルの先頭記号が
   `●◉⦿` か `◯○◌⚪` であることを要求する。1.54.1 の回答済みタブは `✔` なので
   `isCommandCodeQuestionTabRow` が false を返し、region が見つからず、#2521 以前と同じく
   汎用パーサに落ちる。**質問を 1 つ答えるだけで起きる。**
2. **`❯` が選択肢一覧の外に出ると region reading の「カーソルは 1 つ」条件を満たさない。**
   `Submit` / `Next` / `notes:` の 3 種。`Submit` という単語の問題ではない。

この 2 つは互いを含意しない（`✔` が無くても `❯ Submit` なら偽完了になる）。**#2755 は両方塞ぐ
必要がある。**

### 5.2 汎用パーサが出す payload の実例（`multiselect-initial.txt`）

```json
{ "type": "multiple_choice",
  "question": "Which files should I update?",
  "options": [
    { "number": 1, "label": "[ ] calc.js", "isDefault": true },
    { "number": 2, "label": "[ ] README.md", "isDefault": false },
    { "number": 3, "label": "[ ] docs", "isDefault": false },
    { "number": 4, "label": "[ ] tests", "isDefault": false },
    { "number": 5, "label": "[ ] Type something...", "isDefault": false }
  ],
  "isAskUserQuestion": true }
```

`respond 1` はここで**ボックスを 1 つ付けて止まる**。`multiselect-cursor-on-option-2.txt` では
`isDefault` が `[✔] README.md` に付くので、**`respond --default` は人が付けた答えを外す**。

---

## 6. 判断: 1.54.1 の新フッタを検出に使うか

**結論: 使わない。** `afterPrompt` の保険分岐として別定数を足すこともしない。理由は 2 つで、
どちらも実測である:

1. **必要条件にならない。** 質問が 1 つのときフッタは 1 行も描かれない
   （`tabs-single-question.txt` / `multiselect-cursor-on-submit-no-footer.txt`）。フッタを
   手がかりにすると、いちばん危ない「1 問だけ・フッタ無し・`❯ Submit`」の画面をちょうど取り逃す。
2. **いま既に害になっている。** フッタが出ている単一選択では、`findNumberedOptionBlock` の
   末尾走査がフッタ行を**最後の選択肢の説明として畳み込む**ので、選択肢 4 のラベルが
   `Type something... Enter to select | Arrow keys to navigate | …` になる
   （`singleselect-initial-unanswered-tabs.txt`）。#2755 がまずやるべきは「フッタを手がかりに
   足す」ことではなく「**フッタを選択肢から切り離す**」ことである。

`COMMAND_CODE_SELECTION_LIST_FOOTER` は #2753 の「やらないこと」どおり**変更していない**。

---

## 7. 判断: `COMMAND_CODE_VERIFIED_AGAINST` を上げるか

**結論: 上げない（`1.40.1` / `2026-09-03` のまま）。** 理由は
[`tests/fixtures/command-code-askuserquestion-2754/README.md`](../../tests/fixtures/command-code-askuserquestion-2754/README.md)
と `src/lib/detection/tools/verified-against.ts` の docblock に書いた。要点:

- このスタンプは `getDetectorFreshness` が「ルールは installed の版に対して測られているか」を
  答えるための入力である。本 Issue が測ったのは **ルールが 1.54.1 に対して答えられていない**
  ことなので、`1.54.1` と書くと測定結果と逆のことを probe が言う
- #2304 の前例（再採取してルールが変わらなければ上げない）を**逆向きに**適用することになる
- 独立した事情として、`npm run check:detector-freshness` はいま入っている CLI と比べるため、
  1.54.1 と書いても STALE のままになる（§9 参照）
- **上げるのは #2755 がこれらのフレームからルールを読み直したとき**、そのフレームの版で

`verified-against.ts` には上記を記録する docblock 段落を足した（**値は変えていない**）。

---

## 8. #2755 への申し送り

| # | 申し送り | 根拠 |
|---|---|---|
| 1 | `❯ Submit` / `❯ Next` / `❯ notes:` の 3 種を「カーソルが一覧の外にある question 画面」として拾う。単語ではなく**一覧の外**が条件 | §5.1-2 |
| 2 | タブ行の記号に `✔`（U+2714）を足す（`COMMAND_CODE_TAB_*_MARKERS` は 3 家族になる。`✔` は「回答済み」で、selected でも unselected でもない） | §5.1-1 |
| 3 | 送ってよいキーは **`1`–`9`（カーソルが一覧にあるときのみ）** と **`↑`/`↓`**。`Space` / `Esc` / `c` / `d` / `n` は送らない | §4.3, §4.5, §4.6 |
| 4 | 複数選択を確定させるには **`Submit`/`Next` 行 → `Enter` → Review ページ → `1`（または `Enter`）** の 2 段が要る。1 段目だけでは送信されない | §4.2 |
| 5 | 自由文を送るなら**先に自由文行へカーソルを移す**。移す前に文字を送ると数字はトグルとして解釈され、移した後は数字も本文に入る | §4.1, §4.2 |
| 6 | `findNumberedOptionBlock` の末尾走査からフッタ行を除外する（さもないと最後の選択肢のラベルが汚れたまま） | §6-2 |
| 7 | **未測**: `←`/`→` のタブ移動、単一選択での `Space`/`d`、`Ctrl+V`/`Ctrl+G` | §4.7 |

---

## 9. 逸脱記録（Issue 本文「逸脱時の扱い」に対する報告）

| 逸脱 | 実際に起きたこと | 取った対応 |
|---|---|---|
| **手元の版** | 起動時点で `command-code@1.54.1`（Issue の想定どおり）。ただし起動直後に Command Code 自身が `◼ [update-notice] update available: v1.58.0 (installing in the background — a restart applies it)` を出し、**測定中にグローバルの npm パッケージを 1.58.0 に置き換えた** | こちらからは `npm install` 等を一切実行していない。**読んでいたプロセスは起動時の 1.54.1 のまま**で、全 26 フレームがバナー行 `# Command Code v1.54.1` を持つ（テストで固定）。以後この機で再採取すると 1.58.0 になるため、**別の測定になる** |
| **測定中に `Esc` で質問が消えた** | `notes:` 入力を開いた状態で `Esc` を送ったところ、notes だけでなく**質問ごと取り消された** | 消えた事実を `not-applicable-cancelled-from-notes-row.txt` として採取。選択肢行でも同じことを確認（`not-applicable-question-cancelled.txt`）。**本番セッションには送っていない** |
| **`n` / `c` が破壊的か** | `n` は入力行を足すだけ、`c` はダイアログを閉じて回答を送るだけ。ファイル書き込み・セッション変更は観測していない | 両方とも採取して記録。`c` は 1 打で送信されるので §8-3 の除外対象にした |
| **既存スイープが新採取で落ちたか** | `tests/unit/lib/chat/dialog-frame-2326.test.ts` の crop 期待一覧が 7 行不足で落ちた | プロダクトコードは直さず、**一覧に 7 行足した**（Issue 本文が明示的に許可している「採取が増えたことによる期待一覧の更新」） |
| **複数選択を自力で出せたか** | 出せた。エージェントに `ask_user_question` の呼び出しを直接指示して再現 | 本物のリポジトリは使っていない |
| **`Submit` 行にカーソルがある画面を再現できたか** | **できた**。合成フレームでの代用はしていない | `multiselect-cursor-on-submit.txt` ほか |
