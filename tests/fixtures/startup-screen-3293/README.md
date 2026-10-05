# startup-screen-3293 — codex と vibe-local の起動画面、実測（Issue #3293）

codex と vibe-local は、起動画面（バナー）が返答の行として履歴に保存されていた。
このディレクトリは、その起動画面と、起動時のダイアログ、最初のターンの画面である。

**raw のまま置いている。ANSI を剥がさないこと。** codex の入力欄とエコーは `›` の SGR 属性で
しか見分けられない（`tests/fixtures/codex-live-2310/README.md` と同じ理由）。

使っているテスト:

- `tests/unit/lib/polling/startup-screen-3293.test.ts`（「まだ発言が無い画面か」の判定）
- `tests/unit/lib/polling/response-checker-startup-screen-3293.test.ts`（経路 A: poller）
- `tests/unit/lib/assistant-response-saver-startup-screen-3293.test.ts`（経路 B: 送信直前の退避）
- `tests/unit/lib/detection/codex-verdict-corpus.test.ts`（codex の画面は全件ここに行を持つ）

## 採取

| | |
|---|---|
| 採取日 | **2026-10-05**（JST） |
| codex | codex-cli **0.160.0** |
| vibe-local | vibe-local（vibe-coder）**1.3.3**、モデル `qwen3-coder:30b`（Ollama 0.35.1） |
| tmux | 3.5a、私設ソケット `tmux -L cm3293`、設定なし（`-f /dev/null`） |
| ペイン | **200x1000**（本番と同じ。`new-session -x 200 -y 1000` の後、`set-window-option window-size manual` と `resize-window -x 200 -y 1000`） |
| 採取コマンド | `tmux -L cm3293 capture-pane -t '=<session>:' -p -e -S -10000 -E -`（サーバーの `capturePane` と同じ引数） |
| cwd | 使い捨ての git リポジトリ（コミット 1 つ） |
| 後始末 | セッションを閉じ、私設サーバーが残っていないことを確かめた。使い捨ての HOME は消した |

### codex の起動のしかた

利用者の `~/.codex` は**読んでも書いてもいない**。使い捨ての `HOME` と `CODEX_HOME` で、`env -i` から起動した。

```
codex -c features.daemon_auto_start=false -c check_for_update_on_startup=false \
  -c model_provider=probe -c 'model_providers.probe={name="probe",base_url="http://127.0.0.1:9/v1"}' -m probe-model
```

- 認証の要らない provider を閉じたポートに向けた。ログイン画面は出ず、フォルダの信頼の確認から始まる
- `-c features.daemon_auto_start=false` は CommandMate が付ける引数と同じ（共有デーモンにつながない）
- 本番の起動画面との違い: ステータスバーのモデル名が `probe-model default`、色が 256 色
  （`COLORTERM` を渡していない）、アカウントに固有の通知が出ない。バナーの 3 行
  （`>_ OpenAI Codex (v0.160.0)`・cwd・ひとこと）と入力欄の位置は、本人の設定で採った
  `codex-0.160.0-first-turn-reply.txt` と同じ

### vibe-local の起動のしかた

本物のラッパーを `vibe-local -y` で起動した（CommandMate と同じ引数）。`HOME` は使い捨てで、
設定ファイル（`MODEL` / `SIDECAR_MODEL` / `OLLAMA_HOST` の 3 行）の写しと、`vibe-coder.py` へのリンクだけを置いた。
履歴とセッションの記録は使い捨ての `HOME` に書かれ、利用者の `~/.local/state/vibe-local` は変わっていない。

- 本番の起動画面との違い: `First time? Try typing: …` と `Type /help for commands, …` の 2 行は、
  新しい `HOME` だから出ている。本人の `HOME` で採った画面（Epic #3207 の UAT）には無い
- `-y` で起動すると、起動時のダイアログは出ない

## ファイル

行番号は 0 始まり。

| ファイル | 画面 | 中身のある行 |
|---|---|---|
| `codex-0.160.0-dialog-trust.txt` | フォルダの信頼の確認（起動して最初に出る） | 1〜10 |
| `codex-0.160.0-boot-idle.txt` | **起動画面（入力待ち）**。上のダイアログに答えた直後の画面でもある | バナー 1・2・4、ロゴ 491〜507、入力欄 996、ステータスバー 998、`? for shortcuts` 999 |
| `codex-0.160.0-boot-typed.txt` | 起動画面で、入力欄に文字を打って送っていない | バナー 1・2・4、入力欄 996、ステータスバー 998 |
| `codex-0.160.0-first-turn-interrupted.txt` | 最初の発言を送り、Esc で止めた後 | バナー 1・2・4、エコー 7、`■ Conversation interrupted` 10、入力欄 996 |
| `codex-0.160.0-first-turn-reply.txt` | 最初のターンが終わった画面（返答あり）。**出どころは下の節** | バナー 1・2・4、エコー 7、返答 10・12、入力欄 996 |
| `vibe-local-1.3.3-boot-idle.txt` | **起動画面（入力待ち）** | バナー 1〜30、区切り 996、入力欄 `ctx:4% ❯` 997、フッター 998〜1000 |
| `vibe-local-1.3.3-first-turn-done.txt` | 最初のターンが終わった画面 | バナー 1〜30、エコー 997、`assistant: OK-3293` 1001、新しい入力欄 1003 |

### `codex-0.160.0-first-turn-reply.txt` の出どころ

これだけは、このディレクトリのために採ったものではない。Epic #3207 の実機 UAT（2026-10-05）で
保存された画面 `dev-reports/issue/3207/uat/evidence/frames/uat-codex.txt` を、バイトのまま写した
（`cmp` で一致）。本人の設定の codex 0.160.0（`GPT-6.1-Sol xhigh`）が、隔離したサーバーの下で 1 ターン
返答した後の画面である。採取コマンドの記録は残っていない（1000 行＋末尾の改行、ANSI つき）。

置いた理由: ダミーの provider は返答しないので、**返答のある** 0.160.0 の画面はここでは採れない。
陰性対照（エコーのある画面は今までどおり読まれる）に、実機の返答が要る。

## 測って分かったこと

- **codex 0.160.0 は alternate screen に描く。** 起動画面でも、ターンの後でも `#{alternate_on}` は 1、
  `#{history_size}` は 0 で、capture は常に 1000 行。入力欄は下端（996 行目）に固定され、transcript は
  上から伸びる。0.15x は入力欄が transcript のすぐ下に付いて動く、インラインの描画だった
  （`tests/fixtures/codex-live-2310/`、`codex-idle-composer-0155/`）
- codex 0.160.0 のバナーは枠が無い。0.15x の枠つきのバナーは、行が skip の規則（`│`、`╭─╮`）に
  当たって落ちていたが、0.160.0 の 3 行とロゴは、どの規則にも当たらない
- フォルダの信頼の確認は、`1` を送っただけでは進まない（フッターは `enter continue · esc quit`）。
  Enter で確定する。Enter の 0.4 秒後の capture はもう起動画面で、その後の 8 秒ほど（9 枚）バイトが
  変わらなかった（`codex-0.160.0-boot-idle.txt` はその最初の 1 枚）
- codex のエコー行は `ESC[1;2m…› ESC[0m<本文>`（グリフが dim）。入力欄は `ESC[1m›ESC[0m`（bold）で、
  文字を打った入力欄は `ESC[1m›ESC[0m <本文>` になる。#2310 の測定と同じ
- vibe-local は、発言を送った `ctx:N% ❯ <本文>` の行がそのまま scrollback に残る。これがエコーである。
  文字を打って送っていない入力欄も、同じ形の行になる

## 採れなかったもの

- **本人の設定（`~/.codex`）での codex の起動画面**: 起動していない。codex は起動するだけで
  `CODEX_HOME` の sqlite とログを書き、フォルダの信頼に答えると `config.toml` に追記する。
  契約が `~/.codex/*` の書き換えを禁じているため、使い捨ての `CODEX_HOME` で採った
- **vibe-local の起動時のダイアログ**: `-y` では出ない（`-y` なしのラッパーは許可の確認を出すが、
  CommandMate はその形で起動しない）
