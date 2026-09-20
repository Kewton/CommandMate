# Command Code 1.58.0 の Plan review 画面、実測（Issue #2763）

#2761（検出）と #2762（承認ボタン）は、2026-09-20 に本人の稼働セッションで 1 枚だけ観測された
Plan review のフッタ文言 `Approve ctrl+a   executes the plan` / `Cancel esc` **だけ**を根拠に書かれていた。
キーの意味論と画面遷移は未測だった。このディレクトリはそれを隔離環境で 1 キーずつ測った結果である。

結論を先に 3 つ:

1. **`Enter` は安全ではない。** 本文にカーソルがある間は「コメント欄を開く」だけだが、
   `↓` を本文の最終行より先へ送るとフォーカスが**下のアクション一覧に移り**、そこでの `Enter` は
   フォーカス中のアクションを**実行する**。24 行の plan では `↓` 24 回で `❯ Approve` に乗り、
   そこで押した `Enter` は plan を承認して `calc.js` を実際に書き換えた
   （[`after-enter-on-focused-approve.txt`](./after-enter-on-focused-approve.txt)）。
   → #2762 の矢印パッドは Plan review では `Enter` を隠す必要がある。
2. **Plan review はペインを消してから描かれる。** `alternate_on=0` のまま `history_size=0`、
   バナーも transcript もフレームに 1 行も残らない。`/model` ピッカー（#2326）のような
   「transcript の下に重ねる」形ではないので、カードに会話が混ざる心配はない。
   承認 / 取消の直後に transcript は復元される。
3. **現行の検出器はアクション一覧にフォーカスが移った瞬間に `ready` を返す**（偽完了）。
   本文にカーソルがある間は `running` なので、同じ画面が押すキー次第で `running` と `ready` を
   行き来する。詳細は下の「現行の検出器が返す verdict」。

## Provenance — ここに fixture を足す前に読むこと

| | |
|---|---|
| このディレクトリの全ファイル | **live capture。合成フレームは 1 枚も無い** |
| build | Command Code **1.58.0**（`commandcode --version` が `1.58.0`）。Plan review のフレームは画面を消して描かれるのでバナー行 `# Command Code v1.58.0` を含まない。バナーは `after-approve*.txt` / `after-cancel*.txt` にだけ残る |
| 採取日 | **2026-09-21** |
| geometry | 200x1000 — `TUI_PANE_WIDTH` x `TUI_PANE_HEIGHT`、本番と同じペイン |
| 採取コマンド | plain: `tmux -L ccplan-probe capture-pane -p -S - -E - -t '=probeN:'`（`-N` 無しなので行末の空白は落ちている）。ANSI 版 `-p -e -S - -N -E -` も並行して採ったが、Issue の成果物は plain なのでコミットしていない |
| tmux | **専用ソケット** `tmux -L ccplan-probe`、セッション `probe` / `probe2` / `probe3` / `probe4`、`-x 200 -y 1000`。既定ソケットには一切書いていない（`mcbd-*` は前後とも **32** で不変）。後始末は `tmux -L ccplan-probe kill-server` |
| cwd | `/private/tmp/ccplan-probe/sample-repo` — `git init` しただけの使い捨てリポジトリ（`calc.js` と `README.md` の 2 ファイル）。本物のリポジトリは開いていない |
| 起動 | 1 行、YAML の折り畳み無し: `env -i HOME=$HOME PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin TERM=xterm-256color LANG=en_US.UTF-8 commandcode --trust --skip-onboarding --no-auto-update --plan --no-session`（`editor-took-the-pane.txt` の run だけ `EDITOR=vi` を足した） |
| サーバ | 無し。CommandMate のサーバもデーモンも起動していない。tmux のペイン 1 枚だけ |
| 唯一の編集 | transcript のフレームに出る `/Users/<user>` を `/home/plan-probe` に置換した（16 文字 → 16 文字で桁は動かない）。他のバイトは採ったまま。`~/.commandcode/plans/...` の tilde 表記は Command Code 自身の描画なのでそのまま |

`HOME` は本物を渡している（#2754 と同じ理由。Command Code の既存の認証を読ませるため）。
`$HOME` 直下には何も作っていない（`~/.commandcode` は既存）。`~/.commandmate` には触れていない。

plan の**内容**は作り物（`calc.js` に `subtract` / `divide` / `modulo` / `clamp` / `negate` を足す、という
使い捨てリポジトリ向けの plan）である。**描画とキー意味論は本物**。

## 隔離の証跡

```
$ env -u TMUX tmux ls | grep -c '^mcbd-'        # 開始前
32
$ env -u TMUX tmux -L ccplan-probe ls           # 後始末の直前
probe4: 1 windows (created Mon Sep 21 00:40:09 2026)
$ env -u TMUX tmux -L ccplan-probe kill-server
$ env -u TMUX tmux -L ccplan-probe ls
no server running on /private/tmp/tmux-501/ccplan-probe
$ env -u TMUX tmux ls | grep -c '^mcbd-'        # 終了後
32
```

`$TMUX` はこのシェルで設定済み（`/private/tmp/tmux-501/default,...`）だったので、
**すべての tmux 呼び出しを `env -u TMUX tmux -L ccplan-probe ...` で書いた**。
`TMUX_TMPDIR` は隔離手段として使っていない（`$TMUX` に負けるため）。
`bind-key` / `unbind-key` / `set-option -g` は既定サーバにも専用サーバにも撃っていない
（専用サーバに撃ったのは `set-option -t '=probeN:' window-size manual` だけ）。

## 1. キー意味論の表（Issue の問い 1〜9 への答え）

| # | 問い | 実測した答え |
|---|---|---|
| 1 | `C-a`（0x01）で本当に承認されるか。直後の画面は | **コメント 0 件なら即承認**。ペインは一瞬**完全な空白**（非空行 0）になり、その後 transcript が復元され ` PLAN(exit)` ＋ `Plan approved — exited plan mode, now in auto-accept mode (edits apply without prompts).` が足される。**コメントが 1 件でもあると別の確認画面が挟まる**（下の §3.4 のラジオ。`←/→ choose · enter confirm · esc back`）。承認後は続けて通常のツール許可ダイアログ（`Execute Shell Command`）が出ることが多い |
| 2 | `Esc` の後はどの画面に戻るか | **composer に戻り、plan mode のまま**（モード行は `plan mode [shift+tab]`）。transcript に ` PLAN(exit)` ＋ `Plan not approved — staying in plan mode. The plan file stays saved at ...` が足される。**その時点ではまだ `running`**（エージェントがそのターンを続ける）。ターンが終われば `ready` と読める（[`after-cancel.txt`](./after-cancel.txt) が前者、[`after-cancel-idle.txt`](./after-cancel-idle.txt) が後者）。保留中のコメントは確認なしで捨てられる |
| 3 | `↑` `↓` は行カーソルを動かすか。カーソルは何で描かれるか | **動かす。plan の 1 行単位**（空行も 1 行として数える。3 回の `↓` で plan 1 行目 → 4 行目）。カーソルは**背景色だけ**（`ESC[48;5;60m`）で、**グリフは無い**。折り返した行は折り返し先の pane 行も一緒に塗られる。`↑` は対称（3 回で元へ戻り、ANSI ごとバイト一致）。**plain のキャプチャでは前後が完全に同一**なので、ANSI を捨てた検出器はカーソル位置を一切読めない |
| 4 | 空の状態で `Enter` は何をするか | **本文にカーソルがある間は承認しない。** コメント欄 `   ┃  ● Type your comment…` が開き、フッタが `enter to pin · esc discard` になるだけ。空のまま `Enter` をもう一度押すと欄が閉じ、フレームは初期状態と**バイト一致**に戻る（何も pin されない）。**ただし `↓` でフォーカスがアクション一覧に移っていると `Enter` はフォーカス中のアクションを実行する** — `❯ Approve` で押した `Enter` は plan を承認し、`calc.js` への追記が実行された。**→ 矢印パッドの `Enter` は隠す必要がある** |
| 5 | 文字 → `Enter` でコメントを付けた後のフッタと行番号 | 行番号は**変わらない**。代わりに ①行番号と本文の間に `●`（U+25CF）が入り `   1 ● # ...` になる、②その行の下に `      ↳ <コメント>`（U+21B3）の行が 1 本増える、③バッジ行が ` REVIEW   1 pending comment` になる、④**アクション行が 1 本増える** `Submit review (1) ctrl+r   agent revises the plan, returns it for review`、⑤`Approve` 行の末尾に ` · comments go along as notes` が付く、⑥フッタに ` ctrl+n/p jump comments` が挿入される。コメント付きで承認すると、コメントは**合成されたユーザー発話**として transcript に載る（`These review notes are NOT blocking; honor them while implementing` ＋ `- Line N: "..."` / `  Note: ...`） |
| 6 | `?` `x` `!` と `C-g` | `?` `x` `!` は**確認なしの 1 打**で定型コメントを pin する: `Why? Explain the reasoning behind this.` / `Cut this — remove it from the plan.` / `Risky — double-check this before implementing.`。`C-g` は **plan ファイル自体**を `$EDITOR` で開く。`$EDITOR` 未設定（`env -i`）なら**ペインは奪われず**、アクション行の下に `Editor exited with code 127` が 1 行出るだけ。`EDITOR=vi` だと**ペインを奪う**（`alternate_on=1`）。戻し方は §4 |
| 7 | transcript を消してから描かれるか、重ねて描かれるか | **消してから描かれる。** `alternate_on=0` / `history_size=0` のまま、フレームの 1 行目が罫線で、バナーも `❯ <プロンプト>` もツール行も 1 行も残らない。`/model` ピッカー（#2326）や `AskUserQuestion`（#2754）が transcript の**下に**描かれるのとは逆。承認 / 取消で transcript は復元される（＝消えたのは描画だけで、会話は保持されている） |
| 8 | キャンバスより長い plan | **スクロールする。** 886 行の plan では最初のフレームが plan 1〜837 行目（[`plan-review-long-top.txt`](./plan-review-long-top.txt)、995 行）、カーソルを下へ送ると 43〜885 行目に移る（[`plan-review-long-scrolled-cancel-focused.txt`](./plan-review-long-scrolled-cancel-focused.txt)）。**ヘッダ 4 行（罫線 / `Plan review: ...` / `Review the plan like a PR — ...`）とフッタは常に固定**で、間の本文だけが動く。したがって `frame.lastLines`（末尾 15 行）にはフッタとアクション行が**必ず**入る |
| 9 | Plan review が出る条件 | **plan mode のときだけ。** `accept-edits`（auto-accept）で plan を求めると、エージェントはまず `PLAN(enter)` を呼び、`Enter plan mode for read-only exploration and planning?` という**通常の許可ダイアログ**（`❯ 1. Yes (Recommended)` / `2. No, stay in current mode`）を出す。そこで Yes を選んで plan mode に入ってはじめて Plan review が出る。承認すると plan mode は抜けて auto-accept モードに変わる |

## 2. 1 キーずつの前後比較（送った `send-keys` の引数そのもの）

| 送ったキー（`send-keys` 引数） | 前 | 後 | pane の差分 |
|---|---|---|---|
| `Down`（×3） | `plan-review-initial.txt` | `plan-review-cursor-moved.txt` | **plain は差分ゼロ（バイト一致）**。ANSI では `ESC[48;5;60m` が plan 1 行目から 4 行目（と折り返し行）へ移る |
| `Up`（×3） | 上の続き | — | ANSI ごと `plan-review-initial` に**バイト一致**で戻る |
| `Enter`（コメント欄なし） | `plan-review-initial.txt` | `plan-review-comment-box-open.txt` | カーソル行の下に `   ┃  ● Type your comment…` が 1 行、フッタが `type + enter to comment · quick: ...` → `enter to pin · esc discard` |
| `Enter`（空欄のまま 2 回目） | `plan-review-comment-box-open.txt` | — | 欄が消え `plan-review-initial` に**バイト一致**。pin されない |
| `-l -- 'Also cover a divide(a, b) helper here.'` | `plan-review-initial.txt` | `plan-review-comment-typing.txt` | 打鍵だけで欄が開き、本文がそのまま入る（`   ┃  ● Also cover ...`）。フッタは `enter to pin · esc discard` |
| `Enter`（本文あり） | `plan-review-comment-typing.txt` | `plan-review-comment-pinned.txt` | §1 の問い 5 の ①〜⑥ が一度に起きる |
| `-l -- '?'` | — | `plan-review-quick-comments.txt` の 1 本目 | `↳ Why? Explain the reasoning behind this.` が即 pin、件数 +1 |
| `-l -- 'x'` | — | 同 2 本目 | `↳ Cut this — remove it from the plan.` |
| `-l -- '!'` | — | 同 3 本目 | `↳ Risky — double-check this before implementing.` |
| `C-g`（`$EDITOR` 未設定） | `plan-review-quick-comments.txt` | `plan-review-editor-exited.txt` | `Cancel esc` の下に `Editor exited with code 127` が 1 行増えるだけ。ペインは失われない |
| `C-g`（`EDITOR=vi`） | — | `editor-took-the-pane.txt` | **ペインを奪う**。`alternate_on=1`、vi が plan ファイルを全画面で開く（最下行 `"~/.commandcode/plans/add-modulo-to-calc.md" 27L, 879B`） |
| `C-a`（コメント 4 件） | `plan-review-editor-exited.txt` | `plan-review-approve-choice.txt` | アクション 3 行が**ラジオ 1 行**に置き換わる: `Approve (•) with 4 comments as notes ( ) original plan · discard comments`、フッタ `←/→ choose · enter confirm · esc back` |
| `Right` / `Left` | `plan-review-approve-choice.txt` | `plan-review-approve-choice-discard.txt` | `(•)` と `( )` が入れ替わる（選択側に `ESC[48;5;60m`）。`Left` で ANSI ごとバイト一致に戻る |
| `Enter`（ラジオ確定） | `plan-review-approve-choice.txt` | `after-approve-with-comments.txt` | 直後のフレームは**非空行 0 の空白**。5 秒後には transcript が復元され ` PLAN(exit)` とコメント注入済みの合成発話が載る |
| `C-a`（コメント 0 件） | `plan-review-second-plan.txt` | `after-approve.txt` | **ラジオは出ない。** 直後は空白フレーム（[`after-approve-immediate-blank.txt`](./after-approve-immediate-blank.txt)）、5 秒後に transcript ＋ `Execute Shell Command` の許可ダイアログ |
| `Down`（本文の最終行から更に 1 回） | `plan-review-short.txt` | `plan-review-action-focus-approve.txt` | フォーカスが**アクション一覧**へ。`Approve ctrl+a` が `❯ Approve  ctrl+a`（`❯` ＋ 空白、`ESC[48;5;60m` 付き、キー名の前が**空白 2 つ**）になり、フッタが `↑/↓ choose · enter to run` |
| `Down` / `Up`（アクション一覧内） | — | `plan-review-long-submit-review-focused.txt` / `plan-review-long-scrolled-cancel-focused.txt` | `❯` が `Submit review (N)` → `Approve` → `Cancel` を上下する。`Submit review` から更に `↑` で本文の最終行へ戻り、フッタも `type + enter to comment · ...` に戻る |
| `Enter`（`❯ Approve` にフォーカス） | `plan-review-action-focus-approve.txt` | `after-enter-on-focused-approve.txt` | **承認して実行された。** 5 秒後のフレームに `+ export function clamp(v, lo, hi) {` の差分と、次のシェル許可ダイアログ |
| `Escape`（本文にカーソル） | `plan-review-long-scrolled-cancel-focused.txt` | `after-cancel.txt` | 直後は空白フレーム、3 秒後に transcript ＋ `Plan not approved — staying in plan mode.`。保留コメント 1 件は確認なしで消えた |

## 3. 画面の実測形

### 3.1 初期（コメント 0 件）

```text
────────────────────────────────────────  (200 列の U+2500)

Plan review: Add `subtract(a, b)` to calc.js + test file · ~/.commandcode/plans/add-subtract-to-calc.md · v1
Review the plan like a PR — type on any line to comment, enter pins it under the line.

   1   # Add `subtract(a, b)` to calc.js + test file      ← 行番号は右寄せ 4 桁 ＋ 空白 3 つ
   2
   3   ## Context
   …
  52

────────────────────────────────────────  (200 列の U+2500)

 REVIEW                                               ← 前後に空白 1 つずつ、`ESC[48;5;30m` のバッジ
Approve ctrl+a   executes the plan
Cancel esc

type + enter to comment · quick: ? why  x cut  ! risky · ctrl+g $EDITOR
```

### 3.2 コメントが 1 件以上

```text
   1 ● # Add `subtract(a, b)` to calc.js + test file      ← 行番号と本文の間が `●`（U+25CF）
      ↳ Also cover a divide(a, b) helper here.            ← U+21B3。行番号は無い
…
 REVIEW   1 pending comment
Submit review (1) ctrl+r   agent revises the plan, returns it for review
Approve ctrl+a   executes the plan · comments go along as notes
Cancel esc

type + enter to comment · ctrl+n/p jump comments · quick: ? why  x cut  ! risky · ctrl+g $EDITOR
```

`↳` の行は、折り返した plan 行では**折り返しの最後の pane 行の下**に入る。
`↳` の行自体も `ESC[48;5;60m` で塗られているので、**背景色だけでカーソル行を探すと
コメント行と区別が付かない**（#2761 が ANSI を見るならここに注意）。

### 3.3 アクション一覧にフォーカスがある

```text
 REVIEW
❯ Approve  ctrl+a   executes the plan       ← `❯ ` が頭に付き、キー名の前が空白 2 つになる
Cancel esc

↑/↓ choose · enter to run
```

### 3.4 `C-a` をコメント付きで押したとき挟まる確認

```text
 REVIEW   4 pending comments
Approve (•) with 4 comments as notes ( ) original plan · discard comments
Editor exited with code 127

←/→ choose · enter confirm · esc back
```

選択側が `(•)`、非選択側が `( )` で、**plain のままでも読める**（背景色は補助）。

### 3.5 フッタの 4 変種

| いつ | 文言 |
|---|---|
| 本文にカーソル、コメント 0 件 | `type + enter to comment · quick: ? why  x cut  ! risky · ctrl+g $EDITOR` |
| 本文にカーソル、コメント 1 件以上 | `type + enter to comment · ctrl+n/p jump comments · quick: ? why  x cut  ! risky · ctrl+g $EDITOR` |
| コメント欄が開いている | `enter to pin · esc discard` |
| アクション一覧にフォーカス | `↑/↓ choose · enter to run` |
| `C-a` の確認ラジオ | `←/→ choose · enter confirm · esc back` |

#2761 / #2762 が `Approve ctrl+a   executes the plan` を完全一致で探しているなら、
**コメントが 1 件付いた瞬間に `· comments go along as notes` が付いて外れる**し、
アクション一覧にフォーカスが移ると `❯ Approve  ctrl+a` になって更に外れる。

## 4. `C-g` の誤爆からの戻り方

`EDITOR=vi` でペインを奪われたとき、**キーを送っても戻らない**。
`send-keys Escape ':q!' Enter` を何度送っても vi は反応しなかった。原因は測れている:

```
$ ps -o pid,pgid,tpgid,stat,command -t ttys011
  PID  PGID TPGID STAT COMMAND
 7409 85718 85718 S+   vi /home/plan-probe/.commandcode/plans/add-modulo-to-calc.md
85718 85718 85718 Ss+  command-code
```

エディタは **command-code と同じプロセスグループ**で起動されており、`command-code`（node）が
stdin を読み続けているので、tmux が流したバイトは vi に届く前に node に吸われる。
`pane_current_command` も `node` のままなのでエディタの存在すら外から見えない。

戻し方は 2 つ:

- **エディタのプロセスを kill する**（`kill <pid>`）。Plan review は復帰し `Editor exited with code null` が
  1 行出るが、**ペインが階段状に崩れる**（[`editor-killed-staircase.txt`](./editor-killed-staircase.txt)）。
  tty が `opost -onlcr` のまま残るためで、`C-l` でもリサイズでも直らなかった。
- **セッションを作り直す**（Issue の逸脱時の扱いどおり `kill-session -t '=<name>:'`）。こちらが確実。

## 5. fixture 一覧

### Plan review そのもの

| file | 何のためのものか |
|---|---|
| `plan-review-initial.txt` | 基準。52 行の plan、コメント 0 件、カーソルは plan 1 行目 |
| `plan-review-cursor-moved.txt` | `↓` ×3 の後。**`plan-review-initial.txt` とバイト一致**（plain にカーソルは映らない） |
| `plan-review-short.txt` | 23 行の plan。40 行しか使わないので単体テストで扱いやすい最小形 |
| `plan-review-second-plan.txt` | 別の run の 68 行 plan。ヘッダ・フッタが 1 枚目の偶然でないことの対照 |
| `plan-review-comment-box-open.txt` | 空の `Enter` 1 回。コメント欄が開いただけで承認されていない |
| `plan-review-comment-typing.txt` | 文字を打った直後。欄に本文が入っている |
| `plan-review-comment-pinned.txt` | `Enter` で pin した後。`●` / `↳` / `Submit review (1)` / フッタの `ctrl+n/p` が一度に出る |
| `plan-review-quick-comments.txt` | `?` `x` `!` の 3 打で pin された定型コメント 3 本（＋ 打鍵コメント 1 本＝ 4 件） |
| `plan-review-editor-exited.txt` | `$EDITOR` 未設定で `C-g`。`Editor exited with code 127` が 1 行 |
| `plan-review-approve-choice.txt` | コメント 4 件で `C-a`。**承認前に挟まるラジオ** |
| `plan-review-approve-choice-discard.txt` | 同じラジオで `Right`。`( ) with ... (•) original plan · discard comments` |
| `plan-review-action-focus-approve.txt` | `↓` 24 回で `❯ Approve` にフォーカス。**この状態の `Enter` が承認する** |
| `plan-review-long-top.txt` | 886 行の plan の先頭側（plan 1〜837 行目）。フッタは 995 行目 |
| `plan-review-long-scrolled-cancel-focused.txt` | 同じ plan を下までスクロール（43〜885 行目）、`❯ Cancel` にフォーカス |
| `plan-review-long-submit-review-focused.txt` | 同、`❯ Submit review (1)` にフォーカス |

### Plan review を抜けた後

| file | 何のためのものか |
|---|---|
| `after-approve-immediate-blank.txt` | `C-a` の**直後**。非空行 0。承認と再描画の間に**完全な空白フレーム**が挟まる |
| `after-approve.txt` | コメント 0 件で承認して 5 秒後。transcript が復元され `Execute Shell Command` の許可ダイアログが出ている |
| `after-approve-with-comments.txt` | コメント 4 件のままラジオを確定して 5 秒後。コメントが合成発話として注入されている |
| `after-cancel.txt` | `Esc` の 3 秒後。composer に戻り plan mode のままだが、**エージェントはまだターンを続けている** |
| `after-cancel-partial-redraw.txt` | `Esc` の**直後**（別 run）。再描画の途中（34 行）を捕まえた 1 枚 |
| `after-cancel-idle.txt` | `Esc` の後にターンが終わったところ。ここではじめて `ready` と読める |
| `after-enter-on-focused-approve.txt` | `❯ Approve` で `Enter` を押した 5 秒後。plan が実行され `+ export function clamp(...)` の差分が出ている |
| `editor-took-the-pane.txt` | `EDITOR=vi` で `C-g`。vi が 1000 行を占有（`alternate_on=1`） |
| `editor-killed-staircase.txt` | vi を kill した後。Plan review は戻るが `opost -onlcr` のせいで階段状に崩れている |

## 6. 現行の検出器が返す verdict（`commandCodeStatusDetector.detect(normalizeFrame(raw))`）

**#2761 はまだ入っていない**（`src/lib/detection/` に `plan_review` は無い）ので、
これは #2761 が直す前の基準線である。

| file | status | reason | hasActivePrompt |
|---|---|---|---|
| `plan-review-initial.txt` | `running` | `default` | false |
| `plan-review-cursor-moved.txt` | `running` | `default` | false |
| `plan-review-short.txt` | `running` | `default` | false |
| `plan-review-second-plan.txt` | `running` | `default` | false |
| `plan-review-comment-box-open.txt` | `running` | `default` | false |
| `plan-review-comment-typing.txt` | `running` | `default` | false |
| `plan-review-comment-pinned.txt` | `running` | `default` | false |
| `plan-review-quick-comments.txt` | `running` | `default` | false |
| `plan-review-editor-exited.txt` | `running` | `default` | false |
| `plan-review-approve-choice.txt` | `running` | `default` | false |
| `plan-review-approve-choice-discard.txt` | `running` | `default` | false |
| `plan-review-long-top.txt` | `running` | `default` | false |
| **`plan-review-action-focus-approve.txt`** | **`ready`** | **`input_prompt`** | **false** |
| **`plan-review-long-scrolled-cancel-focused.txt`** | **`ready`** | **`input_prompt`** | **false** |
| **`plan-review-long-submit-review-focused.txt`** | **`ready`** | **`input_prompt`** | **false** |
| `after-approve-immediate-blank.txt` | `running` | `default` | false |
| `after-approve.txt` | `waiting` | `prompt_detected` | true |
| `after-approve-with-comments.txt` | `running` | `thinking_indicator` | false |
| `after-cancel.txt` | `running` | `thinking_indicator` | false |
| `after-cancel-partial-redraw.txt` | `running` | `default` | false |
| `after-cancel-idle.txt` | `ready` | `input_prompt` | false |
| `after-enter-on-focused-approve.txt` | `waiting` | `prompt_detected` | true |
| `editor-took-the-pane.txt` | `running` | `default` | false |
| `editor-killed-staircase.txt` | `running` | `default` | false |

`extractCommandCodeSelectionListFrame` は **24 枚すべてに `null` を返す**。
したがって `tests/unit/lib/chat/dialog-frame-2326.test.ts` の全走査（`cropped` の期待リスト）は
このディレクトリを足しても**増えない**。全走査は赤くなっていない。

### Epic #2759 に報告すべき食い違い

Issue 本文は「#2761 のマージ後なら `plan-review-*` は `waiting` / `command_code_plan_review`、
`after-cancel` は `ready`」を期待値として挙げている。#2761 は未マージなので期待値の比較自体は
まだできないが、**#2761 の設計に効く食い違いを 2 つ測った**:

1. **アクション一覧にフォーカスがある 3 枚が `ready` / `input_prompt` で publish される（偽完了）。**
   `❯ Approve  ctrl+a` / `❯ Cancel  esc` / `❯ Submit review (1)  ctrl+r` の行頭 `❯` が
   `COMMAND_CODE_PROMPT_PATTERN`（`/^❯(\s*$|\s+\S)/m`）に当たるためで、#2754 が
   「`❯` が選択肢一覧の外に出たときの偽完了」として記録したのと同じ family である。
   **人間が plan を承認するかどうか決めていない画面で `wait` が exit 0 する。**
   同じ画面が、カーソルが本文にある間は `running`、`↓` を最終行より先へ送ると `ready` になる。
   **原因は変異注入で確かめてある**: 3 枚の行頭 `❯ ` を空白 2 つに置換すると
   `ready` / `input_prompt` → `running` / `default` に戻る。
2. **`after-cancel` は `Esc` の直後には `ready` にならない。** `Esc` はプラン提示を取り消すだけで
   ターンは終わらないので、そこからエージェントが別のツールを呼ぶ。`ready` と読めるのは
   ターンが終わった後（`after-cancel-idle.txt`）である。`Esc` 直後を `ready` と決め打つ設計は
   #2754 の偽完了をもう 1 つ増やす。

本 Issue ではどちらも**直していない**（スコープ外）。GitHub の Epic #2759 へのコメントは、
実行契約が外向きの操作（push / PR / コメント）をオーケストレーター側に寄せているので、
ここに記録するに留めてある。

## 7. 逸脱の記録

- **`COMMAND_CODE_VERIFIED_AGAINST` は動かしていない。** 現状 `1.40.1` のまま。本 Issue はプロダクトコードを
  変更しないし、上の §6 のとおり 1.58.0 の Plan review は現行ルールで**正しく読めていない**ので、
  ここでスタンプを 1.58.0 に進めると「測った結果と逆のこと」を freshness プローブが言うことになる
  （#2754 が 1.54.1 で同じ判断をしている）。
- **`C-g` のペイン奪取からキー操作では戻れなかった。** §4 のとおり。Issue の逸脱時の扱いに従って
  セッションを作り直した（`kill-session -t '=probe2:'` → `probe3` を新規作成）。
- **`↓` を `send-keys -N 400` で一気に送ったら、arrow のバイト列の一部が
  コメント欄に `[B` として入った。** これは**プローブ側の副作用**であり、製品の挙動として主張しない。
  `plan-review-long-scrolled-cancel-focused.txt` と `plan-review-long-submit-review-focused.txt` の
  2 枚に残っている `↳ [B` はそれである（`plan-review-long-top.txt` はそれより前に採ったので入っていない）。1 打ずつ間隔を空けて送った
  `plan-review-cursor-moved.txt` / `plan-review-action-focus-approve.txt` では起きていない。
- **Command Code は plan を `~/.commandcode/plans/*.md` に書く。** プローブが 6 本足した
  （`add-subtract-to-calc.md` / `add-divide-to-calc.md` / `full-repo-rewrite-exhaustive.md` /
  `add-modulo-to-calc.md` / `add-clamp-to-calc.md` / `add-negate-to-calc.md`）。
  同じディレクトリの `plans-index.json` は Command Code 自身が更新した。`$HOME` 直下のエントリは増えていない
  （`~/.commandcode` は既存）し、`~/.commandmate` には触れていない。**既存のファイルは消していない。**
- **taste 学習が走った。** 書き込み先は使い捨てリポジトリ側の
  `/private/tmp/ccplan-probe/sample-repo/.commandcode/taste/taste.md` で、`$HOME` ではない。
- **承認した plan は実際に実行された。** 書き換わったのは使い捨てリポジトリの `calc.js` だけで、
  シェル実行の許可は毎回 `Esc` で断った。

## 8. このディレクトリを読むテスト

現時点では**無い**。Issue #2763 の実行契約が変更してよいパスを
`tests/fixtures/command-code-plan-review-2763/**` と `changelog.d/2763.md` に限っているので、
`tests/unit/` に専用スイートは足していない。#2761 / #2762 がルールを書くときに、
上の §6 の表を期待値の出発点として使うこと。
