# codex-mid-turn-3337 — codex 0.160.0 のターンの途中の画面、実測（Issue #3337）

`capture --json` の `sessionStatus` が、codex の長いターンの途中で `ready` になった。
このディレクトリは、そのとき画面がどう読まれていたかを確かめるために採った、ターンの途中の画面と、
中断した後の画面である。

**raw のまま置いている。ANSI を剥がさないこと**（`tests/fixtures/codex-live-2310/README.md` と同じ理由）。

使っているテスト:

- `tests/unit/lib/current-output-mid-turn-3337.test.ts`
- `tests/unit/lib/turn-abandoned-interrupts-3337.test.ts`
- `tests/unit/lib/detection/codex-verdict-corpus.test.ts`（codex の画面は全件ここに行を持つ）

## 採取

| | |
|---|---|
| 採取日 | **2026-10-05**（JST） |
| codex | codex-cli **0.160.0** |
| tmux | 3.5a、私設ソケット `tmux -L cm3337`、設定なし（`-f /dev/null`） |
| ペイン | **200x1000**（`new-session -x 200 -y 1000` の後、`set-window-option window-size manual` と `resize-window -x 200 -y 1000`） |
| 採取コマンド | `tmux -L cm3337 capture-pane -t '=<session>:' -p -e -S -10000 -E -`（サーバーの `capturePane` と同じ引数） |
| cwd | 使い捨ての git リポジトリ（コミット 1 つ） |
| 後始末 | 私設サーバーを `kill-server -L cm3337` で閉じ、codex のプロセスが残っていないことを確かめた |

起動のしかたは `tests/fixtures/startup-screen-3293/README.md` と同じ（`env -i`、使い捨ての `HOME` と
`CODEX_HOME`、認証の要らない provider を閉じたポートに向ける）。provider に
`request_max_retries=8,stream_max_retries=8` を足した。利用者の `~/.codex` は読んでも書いてもいない。

provider に届かないので、codex はターンを終えずに `Working` を出し続け、30 秒ほどで
`Reconnecting... waiting for network` に変わる。この間を 0.5〜1 秒おきに 70 枚採った。
**作業中の表示の出かたを見るための画面**で、返答のあるターンではない。

## ファイル

| ファイル | 画面 | 直す前の判定 | 直した後 |
|---|---|---|---|
| `codex-0.160.0-working-bullet.txt` | `• Working (44s • esc to interrupt)` | `running` | `running` |
| `codex-0.160.0-working-hollow.txt` | `◦ Working (43s • esc to interrupt)` | **`ready` / `input_prompt`** | `running` |
| `codex-0.160.0-reconnecting-bullet.txt` | `• Reconnecting... waiting for network (54s • esc to interrupt)` | **`ready` / `input_prompt`** | `running` |
| `codex-0.160.0-reconnecting-hollow.txt` | `◦ Reconnecting... waiting for network (55s • esc to interrupt)` | **`ready` / `input_prompt`** | `running` |
| `codex-0.160.0-interrupted-idle.txt` | Esc で止めた 2.5 秒後。`■ Conversation interrupted - use /feedback if something went wrong` | `ready` | `ready`（陰性対照） |
| `codex-0.160.0-interrupted-background-terminal.ts` | **採取ではなく、組み立て**。`interrupted-idle.txt` の 994 行目に `1 background terminal running · /ps to view · /stop to close` を書いた画面（下の節） | `ready` | `ready`（読み手は中断と読む） |

## 測って分かったこと

- **作業中の表示の先頭の記号は、`•` と `◦` が交互に出る（スピナー）。** 70 枚のうち 36 枚が `◦`。
  検出は `•` と決まった動詞（`CODEX_THINKING_PATTERN`）でしかこの行を読んでいなかったので、`◦` の画面は
  「入力欄があり、作業中の表示が無い」と読まれ、`ready` / `input_prompt`（positive）になった。
  5 秒おきの 3 回のポーリングが続けて `◦` に当たると、ターンが `scraper_evidence` で閉じられる
- **見出しは `Working` とは限らない。** 再接続の間は `Reconnecting... waiting for network`。
  どちらの記号でも、動詞の一覧に無いので `ready` になった
- 作業中の行には、必ず経過時間つきの `(… • esc to interrupt)` が付く（`(43s •`、`(1m 00s •`）。
  直した後の検出（`CODEX_LIVE_STATUS_ROW_PATTERN`）はこれで読む。待ち行列の行の
  `(press esc to interrupt and send immediately)` には経過時間が無いので当たらない
- **中断（Esc）では `Stop` の hook が来ない。** 同じ起動のしかたで、`CODEX_HOME/hooks.json` に
  `SessionStart` / `UserPromptSubmit` / `Stop` / `SessionEnd` を、ファイルに 1 行書くだけの command hook
  として置き、hooks の確認で `Trust all and continue` を選んで測った。発言を送ると `SessionStart` と
  `UserPromptSubmit` が届き、Esc の後 15 秒待っても `Stop` は届かなかった（2 回とも）。
  hook の確認に答えた信頼は、使い捨ての `CODEX_HOME` に書かれた

### `codex-0.160.0-interrupted-background-terminal.ts`（組み立てた画面）

ダミーの provider は返答しないので、codex にコマンドを走らせられない。オーケストレーターの実機確認
（隔離したサーバー、codex 0.160.0、hooks あり）で、`sleep 90 && ls` の実行中に Esc を押すと、画面の末尾は
`■ Conversation interrupted …`、`1 background terminal running · /ps to view · /stop to close`、
`› Ask Codex to do anything` の順になり、40 秒以上 `running` のままだった。この並びを、
`codex-0.160.0-interrupted-idle.txt` の 994 行目（ターンの途中の画面で作業中の行がある行）に、
その行を書いて組み立てた。ほかの行はバイトのまま。その行の属性（dim）は推測である。読み手は
その行の前後の空行を飛ばすので、行の位置は判定を変えない。

## 採れなかったもの

- **本人の設定での、本物のモデルが考えている間の画面**: 認証の要る provider には使い捨ての
  `CODEX_HOME` からつなげない。考えている間の見出しが推論の要約（`Working` 以外の語）に変わるかは、
  ここでは確かめていない。`CODEX_LIVE_STATUS_ROW_PATTERN` は見出しを見ないので、変わっても読める
