# 長い本文の send で先頭側が欠ける — 再現マトリクスと原因（Issue #2464）

**判定: 原因は Claude Code 側の入力の組み立て。** tmux は本文を 1 バイトも落とさずにペインへ渡しているが、
TUI はそれを pty の読み取り単位（macOS で 1,022 バイト）ごとに受け取り、Claude Code 2.1.268 は
bracketed paste でない入力を読み取りごとに組み立てて **最後の 1 回分だけ** を composer に残す。
Issue の候補 1〜4 はどれも当たらなかった（§3）。塞ぎ方は「512 バイトを超える本文は 1 回の bracketed
paste で流し、Enter は composer が本文全体を示すまで押さない」（§6）。修正後は 4 tool × 8 本、
48 KiB / 240 行までが転写とバイト一致で届いた（§5）。

以下はすべて実測値であり、推測や公式ドキュメントの引き写しではない。

---

## 0. 採取環境

| 項目 | 値 |
|---|---|
| 日付 | 2026-09-11 |
| 基準コミット | `7411af6f`（develop、Issue の照合基準 `9b813eea` 以降） |
| OS | macOS（Darwin 25.6.0） |
| tmux | 3.5a。専用ソケットのサーバ（`tmux -L cm2464probe`）で、本番サーバには触れていない |
| ペイン | 本番と同じ 200x1000（`TUI_PANE_WIDTH` x `TUI_PANE_HEIGHT`） |
| claude | Claude Code 2.1.268 |
| codex | codex-cli 0.154.0 |
| Command Code | 1.53.0（本番と同じ `--trust --skip-onboarding --no-auto-update` で起動） |
| antigravity | Antigravity CLI（`agy`）1.2.0 |

## 1. 方法

- **本文**: 1 KB / 10 行、1 KB / 1 行、4 KB / 30 行、4 KB / 1 行、12 KB / 60 行、12 KB / 1 行（修正後は
  48 KB / 240 行、48 KB / 1 行を追加）。どれも決定的に生成し、各行に `L<nn>` の印を入れて、欠けたときに
  どこから残っているかが分かるようにした。12 KB / 60 行と 4 KB / 30 行、12 KB / 1 行は
  `tests/fixtures/long-body-2464/*.body` に置いてある。
- **送り方**: 本番の送信関数 `sendMessageWithSubmitVerification()` そのもの（`/api/worktrees/:id/send` →
  `sendUserMessage` → 各 tool の `sendMessage` が最後に呼ぶ関数）を tsx で直接呼んだ。
  `process.env.TMUX` を専用サーバに向け、同名セッションが専用サーバに在り本番サーバに無いことを毎回
  確認してから送っている。HTTP ルートは本文を `trim()` して渡すだけなので、前後に空白の無い本文では
  経路の差にならない。
- **判定**: 画面の目視ではなく、**相手 tool の転写に記録された本文と送った本文のバイト比較**。
  `ask --json` の `source: history` が読むのと同じファイルを直接読んだ。
  - claude: `~/.claude/projects/<slug>/<session>.jsonl` の `type: "user"`（文字列 content）
  - codex: `~/.codex/sessions/…/rollout-*.jsonl` の `UserMessage` item
  - Command Code: `~/.commandcode/projects/<slug>/<id>.jsonl` の `role: user` かつ `meta.source: user`
  - agy: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl` の
    `USER_INPUT` の `<USER_REQUEST>` 内

生の計測値は `tests/fixtures/long-body-2464/matrix.json` にある。

## 2. 再現マトリクス（修正前の経路: `send-keys -l`）

到達バイト数 / 送信バイト数。「一致」は転写の本文が送信本文とバイト単位で同一。

| 本文 | claude | codex | Command Code | antigravity |
|---|---|---|---|---|
| 1 KB / 10 行 | **2 / 1,024**（`u.` だけ） | 一致 | 一致 | 一致 |
| 1 KB / 1 行 | **2 / 1,024**（`o.` だけ） | 一致 | 一致 | 一致 |
| 4 KB / 30 行 | **8 / 4,096**（` romeo .` だけ） | 一致 | 一致 | 一致 |
| 4 KB / 1 行 | **8 / 4,096**（`ber osc.` だけ） | 一致 | 一致 | 一致 |
| 12 KB / 60 行 | 一致（5 回中 4 回）／ **24 / 12,288**（1 回、`key xray yankee zulu al.` だけ） | 一致 | 一致 | 一致（ただし記録は送信の 116 秒後） |
| 12 KB / 1 行 | 一致 | 一致 | 一致 | 一致（記録は 205 秒後） |

**欠けた位置**: claude で欠けたものは例外なく「先頭から 1,022 × k バイトが消え、最後の端数だけが残る」。
残ったのは最終行（L10 / L30 / L60）の末尾の数バイトで、どの `L<nn>` の印も残っていない。

| 送信 | 到達 | 送信 mod 1,022 |
|---|---|---|
| 1,024 | 2 | 2 |
| 4,096 | 8 | 8 |
| 12,288 | 24 | 24 |

どの回も送信関数は約 330 ms で正常に返っていた（= `commandmate send` なら `Message sent.`）。

antigravity は欠けなかったが、12 KB の打鍵入力を取り込み終えるまでに 2〜3.5 分かかった。送信関数は
322 ms で成功を返しており、その時点では本文はまだ composer に流れ込んでいる途中だった（§4 の読み戻し
窓の問題で、それが見えていなかった）。

## 3. 切り分け

| 候補（Issue 本文） | 対照 | 結果 | 判定 |
|---|---|---|---|
| 4. tmux の引数長 | 生ペイン（`stty raw -echo; cat > file`）へ `send-keys -l -- <本文>` | 1,024 / 4,096 / 12,288 / 16,000 / 16,320 バイトはバイト一致で到達。16,340 バイト以上は `command too long`（rc 1、0 バイト） | **否定**。12 KB は切れない。上限を超えると黙って切れるのではなく送信自体が失敗する |
| 2. `clearComposerBeforeSend` との競合 | `clearBeforeSend` を切って送信 | 4 KB → 8 バイト、1 KB → 2 バイト（同じ欠け方）。clear を一切通さない素の `tmux send-keys` でも 12 KB → 24 バイト | **否定** |
| 1. Enter が早すぎる | Enter を 3,000 ms 遅らせて送信 | 4 KB → 8 バイト、1 KB → 2 バイト。素の `tmux send-keys` で Enter を約 10 秒後に押しても 12 KB → 24 バイト | **否定**。Enter を押す前から composer は末尾しか持っていない（下記） |
| 3. placeholder の再 Enter | 欠けた回の composer と Enter の回数 | composer に placeholder は無く、末尾の文字列だけが普通のテキストとして入っていた。Enter は 1 回で `submitted` 判定（再送なし） | **否定** |
| （陽性対照）bracketed paste | `load-buffer` + `paste-buffer -p -r` で流し、手で Enter | composer は `[Pasted text #13 +59 lines]`、転写は 12,288 バイト一致 | 全文が届く |

素の `send-keys -l` で 12 KB を打ち込んだ直後の composer（`tests/fixtures/long-body-2464/claude-tail-only-after-send-keys.capture`）:

```
❯ key xray yankee zulu al.
──────────────────────────
  paste again to expand
```

送出から 76 ms 後にはこの形になり、以後変わらない。直後の bracketed paste の placeholder が `#13` だった
ことから、1 回の送信が 12 回の「貼り付け」として数えられていたことも分かる。

## 4. 原因

1. tmux は本文を全部ペインに書く（§3 の生ペイン）。
2. TUI はそれを pty から読むが、1 回の読み取りは macOS で 1,022 バイト。1 KB を超える本文は必ず複数回の
   読み取りに割れる。
3. Claude Code 2.1.268 は bracketed paste の印（`ESC[200~ … ESC[201~`）が無い入力を読み取りごとに
   貼り付けとして扱い、**composer には最後の読み取り分しか残らない**。到達バイト数が常に
   「送信バイト数 mod 1,022」になるのはこのため。12 KB が 5 回中 4 回は全文届いたように、取りこぼすか
   どうかは TUI 内部のタイミングに依るが、1 KB と 4 KB は 8 回中 8 回欠けた。
4. 残った末尾は普通のテキストなので Enter でそのまま送信され、送信後の読み戻し（composer が空になった／
   生成が始まった）は正常な送信と区別がつかない。したがって `send` は `Message sent.` を返す。

codex / Command Code / agy は bracketed でない入力でも全文を保持した。Issue の事象（「Claude だけ途中から
届き、他の 3 体には届く」）とそのまま一致する。

付随して見つかった、同じ「送れたことにされる」系統の問題:

- **読み戻し窓が空行だった。** 送信関数は `capture-pane -S -12` の末尾 12 行から composer を探すが、
  capture は 1000 行ペインの全行を返す。codex / Command Code / agy は上から描画する（最後の描画行は
  1,002 行中 306 / 297 / 286 行目）ので、末尾 12 行は空行だけで、composer は一度も見つからず、
  どの送信も `submitted` に分類されていた。agy の 12 KB が数分遅れて届いたのに送信が 322 ms で成功した
  のはこれ。
- Command Code の composer の placeholder は `C-u` / `C-e C-u` / Escape では消えない（Ctrl+C 1 回で消える）。

なお本 Issue の作業を依頼した契約文（7,833 バイト / 95 行、日本語）は同じ経路で claude に全文届いている。
セッション起動の 2.8 秒後に送られたもので、取りこぼしがタイミング依存であることと矛盾しない（詳しい条件は
追っていない）。

## 5. 修正後の測定（paste 経路）

同じ本文を修正後の送信関数で送り、転写とバイト比較した。

| 本文 | claude | codex | Command Code | antigravity |
|---|---|---|---|---|
| 1 KB / 10 行 | 一致 | 一致 | 一致 | 一致 |
| 1 KB / 1 行 | 一致 | 一致 | 一致 | 一致 |
| 4 KB / 30 行 | 一致 | 一致 | 一致 | 一致 |
| 4 KB / 1 行 | 一致 | 一致 | 一致 | 一致 |
| **12 KB / 60 行** | **一致** | **一致** | **一致** | **一致** |
| 12 KB / 1 行 | 一致 | 一致 | 一致 | 一致 |
| 48 KB / 240 行 | 一致 | 一致 | 一致 | 一致 |
| 48 KB / 1 行 | 一致 | 一致 | 一致 | 一致 |

32 / 32 本が一致。送信関数はどれも約 350 ms で返り、agy も送信の約 1 秒後に記録された（打鍵入力で
2〜3.5 分かかっていたものが解消）。

## 6. 塞ぎ方（`src/lib/cli-tools/submit-verified-sender.ts`）

1. **512 バイトを超える本文は paste で流す**（`LITERAL_SEND_MAX_BYTES`）。`tmux load-buffer -b <一意名> -`
   で本文を stdin から渡し、`paste-buffer -p -r -d -b <名前> -t =<session>:` で貼る。
   - `-p`: アプリが bracketed paste を要求している（`?2004h`）ときだけ `ESC[200~ … ESC[201~` で包む。
     要求していないアプリには `send-keys -l` と同じバイト列がそのまま届く（生ペインで両方をバイト比較済み）。
   - `-r`: LF を LF のまま渡す。既定の LF→CR だと、bracketed paste を要求していないアプリでは行ごとに
     Enter になる。
   - `-d`: 貼ったらバッファを消す。失敗時も `delete-buffer` で消すので、本文が tmux サーバに残らない。
   - stdin 経由なので `send-keys` の約 16.3 KB の上限が無い（20 KB を実測）。
   - 512 バイト以下は従来どおり `send-keys -l`。1 回の読み取りに収まるので割れない。512 は実測した
     読み取り単位 1,022 バイトの半分で、多バイト文字や読み取り単位の小さい環境への余裕を取った。
2. **Enter の前に、composer が本文全体を示しているか照合する**（`classifyPasteLanded()`）。100 ms 間隔で
   最大 20 回（2 秒）読む。
   - placeholder はそれが数える単位で本文と比べる（§7）。本文より少なければ `pasting`（まだ貼り付け中。
     Enter は押さずに待つ）、同じなら `landed`、多ければ `mismatch`。placeholder が 2 つ以上、または
     placeholder 以外の文字が同じ行にあれば `mismatch`。
   - placeholder の無い普通のテキストは、それが本文の **先頭** のときだけ `landed`。本文に含まれるが先頭
     ではないテキストは本 Issue の「末尾だけ」そのものなので `mismatch`。
   - 何も見えない（composer が無い・空・待機中のヒント）は `unseen`。
3. **揃わなかったら送らない。** `mismatch`、時間切れの `pasting`、そして composer を計測済みの tool
   （`clearBeforeSend`: claude, codex）での `unseen` は、composer から本文を取り除いて（claude / codex は
   #1879 の検証つき消去、他は `C-u`）Enter を押さずに throw する。未計測の composer（gemini, copilot,
   opencode, vibe-local, antigravity, Command Code）での `unseen` は、見えないことを「送れなかった」と
   読むと長文を全部拒否することになるので、警告を残して従来どおり進む。
4. **失敗は exit 0 にならない。** throw は送信ルートの 500（`Failed to send message to <Tool>: Message body
   did not arrive intact …`）になり、CLI は既存の 5xx 処理で `Error: Server error: …` を stderr に出して
   exit 99 で終わる。`Message sent.` は出ない（CLI 側の挙動は `src/cli/utils/api-client.ts` の既存コードで
   確認。本 Issue では変更していない）。
5. **読み戻し窓を描画されている行の末尾にする。** capture の末尾の空行を落としてから 12 行を取る。
   claude（下端に描画）には影響せず、codex / Command Code / agy では初めて composer が読める。これで
   Enter 後に placeholder が残っていれば `pending` として Enter を再送できる（codex の placeholder
   `[Pasted Content …]` と Command Code の `[… +NL]` も「まだ composer にある」と認識するようにした）。
6. **保証の明文化。** `commandmate send --help`、`commandmate docs --section agent-operations` の send 節、
   `commandmate docs --section delegation` の「How long a request can be」に、48 KiB / 240 行までを 4 tool で
   確認済みであること、揃わなければ exit 99 で何も送られないこと、それより長い brief はファイルに置いて
   読ませることを書いた。上限を強制するものではない（長い本文も同じ経路・同じ照合を通る）。

## 7. paste 後の composer の形（実測）

| tool | 複数行（12 KB / 60 行） | 1 行（12 KB） | 数える単位 |
|---|---|---|---|
| claude 2.1.268 | `[Pasted text #86 +59 lines]` | `[Pasted text #87]` | 改行の数（60 行で +59）。1 行は数を出さない |
| antigravity 1.2.0 | `[Pasted text #5 +60 lines]` | `[Pasted text #6 12288 chars]` | 行数（60 行で +60）／文字数 |
| codex 0.154.0 | `[Pasted Content 12288 chars]` | `[Pasted Content 12288 chars]` | 文字数 |
| Command Code 1.53.0 | `[PROBE P12k… +60L]` | `[PROBE P12k… +1L]` | 行数（先頭 10 文字つき） |

600 バイトの 1 行は claude / codex / agy では折り返した生テキスト、Command Code では `[… +1L]`。
placeholder は `paste-buffer` から 60 ms 以内に描画された。`+M lines` は claude と agy で数え方が 1 違う
ので両方を受け入れる。bracketed paste は 1 単位で届くので、守りたいのは「大きく足りない」（本 Issue の
24 バイト）であって 1 行の差ではない。

## 8. 残課題・対象外

- Command Code の placeholder は `C-u` では消えないため、到達しなかったときの取り除き（best effort）では
  残る場合がある。throw のメッセージにその状態が出る。
- 未計測の composer（gemini / copilot / opencode / vibe-local）の paste 後の形は測っていない。`unseen` は
  警告して進む（従来と同じ許容）。
- Linux の pty 読み取り単位は測っていない（閾値は macOS の実測の半分）。
- skill 側（cmate-delegate §3 の 5 欄 brief、cmate-workspace-research）の改修は対象外。長い brief を
  ファイル経由にするかどうかは、§6-6 の保証を見て skill 側が選ぶ。

## 9. 再現手順

本番の tmux サーバには触れないこと。すべて専用ソケット `-L` で行う。

```bash
SB=$(mktemp -d)/sb && mkdir -p "$SB" && cd "$SB" && git init -q
env -u CLAUDECODE tmux -L cm2464probe new-session -d -s claude -x 200 -y 1000 -c "$SB"
tmux -L cm2464probe send-keys -t '=claude:' -l -- 'claude' && tmux -L cm2464probe send-keys -t '=claude:' Enter
# trust ダイアログは既定が "No, exit" なので Down → Enter

# 修正前の経路（send-keys -l）: composer に末尾だけが残る
tmux -L cm2464probe send-keys -t '=claude:' -l -- "$(cat tests/fixtures/long-body-2464/P4knl.body)"
tmux -L cm2464probe capture-pane -p -t '=claude:' | grep '^❯'      # ❯  romeo .

# composer を空にしてから、修正後の経路（bracketed paste）
tmux -L cm2464probe send-keys -t '=claude:' C-e C-u
tmux -L cm2464probe load-buffer -b p2464 - < tests/fixtures/long-body-2464/P4knl.body
tmux -L cm2464probe paste-buffer -p -r -d -b p2464 -t '=claude:'
tmux -L cm2464probe capture-pane -p -t '=claude:' | grep '^❯'      # ❯ [Pasted text #N +29 lines]

tmux -L cm2464probe kill-session -t '=claude'
```

到達の判定は画面ではなく転写で行う: `~/.claude/projects/<slug>/*.jsonl` の最新の `type: "user"` の
`message.content` と本文を `cmp` する。
