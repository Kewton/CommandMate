# codex 0.157.1 の標準画面、実測（Issue #2868）

codex-cli 0.157.1 で `/model` の選択画面を UI から操作できなくなった（Send が `prompt_no_longer_active` で拒否される）。
`docs/design/codex-detection-corpus.md` §2 の 6 画面と、`/model` の追加 2 画面をこの版で撮り直したもの。

**答え: 6 画面のうち落ちたのは `model-picker.txt` だけ。** 原因はフッタの文言変更
（`Press enter to confirm or esc to go back` → `enter select · esc back`）。`CODEX_PICKER_FOOTER_PATTERN` で直した。
追加の 2 枚（`/model` の 2 段目）もフッタ `enter default · s session · esc back` が同じ理由で落ちていたので、
`CODEX_EFFORT_PICKER_FOOTER_PATTERN` で直した。

**raw のまま置いている。ANSI を剥がさないこと**（`tests/fixtures/codex-dialogs-0155/README.md` と同じ理由）。
読むテストは `tests/unit/lib/detection/codex-dialogs-0157.test.ts` と `codex-verdict-corpus.test.ts`。

## Provenance — ここに fixture を足す前に読むこと

| | |
|---|---|
| build | codex-cli **0.157.1**（`codex --version`。trust 以外の 7 枚はバナー `OpenAI Codex (v0.157.1)` を持つ） |
| model | `GPT-6-Sol`（`-c model_reasoning_effort=low` で起動したのでバーは `GPT-6-Sol low`） |
| 採取日時 | **2026-09-27 00:36〜00:40 JST**（trust 00:36:00、idle 00:38:23、`/model` 00:38:27、effort 00:38:32、digit 00:38:49、running 00:39:06、承認 00:39:49、引用 00:40:25） |
| tmux | 私設ソケット `tmux -L codexprobe -f /dev/null`、`new-session -d -s probe -x 200 -y 1000`。ペイン寸法は `display-message '#{pane_width}x#{pane_height}'` で **200x1000** を実測。既定の tmux サーバには触れていない。終わったら `-L codexprobe kill-server` |
| cwd | `os.tmpdir()` 配下の使い捨て git リポジトリ（`mktemp -d …/codex0157-probe-XXXXXX` の下の `repo/`、`README.md` 1 ファイルを 1 コミット） |
| 採取コマンド | `capture-pane -p -e -S -1000 -t '=probe:'`。`split('\n')` は **1001** 要素 |
| CODEX_HOME | 本人の `~/.codex`（資格情報は複製していない） |

### 起動

```text
env -u CM_DB_PATH -u CM_ROOT_DIR -u CM_BIND \
    CM_PORT=9 CM_HOOK_URL=http://127.0.0.1:9/x CM_PERMISSION_HOOK_URL=http://127.0.0.1:9/x \
  codex --disable hooks -c 'notify=[]' -c history.persistence=none \
        -c model_reasoning_effort=low -c mcp_servers.node_repl.enabled=false
```

- **trust 画面**は上の行そのままで出し、採取後 Ctrl+C で抜けた
- 残り 7 枚は上の行に `-a on-request -s read-only` を足して起動した。§2 の `codex -a untrusted` は
  **0.157.1 で使えない**（`--ask-for-approval` の値は `on-request` / `never` のみ）
- **0.157.1 は `-c projects."<path>".trust_level="trusted"` の上書きで trust 画面を通さなかった**（0.155.1 では通った）。
  そのため 2 回目の起動では trust 画面で `1. Trust and continue` を選んだ。この選択は `~/.codex/config.toml` に
  probe リポジトリの `[projects."…"]` を 1 件書き込む（採取後もそのまま）
- `running.txt`: `Run the shell command: sleep 30` を送った 4 秒後。read-only でも `sleep` は承認なしで走った
- `approval.txt`: `sleep` が承認を出さないので、`Run the shell command: touch probe.txt` を送って承認画面を出した。
  採取後 `3`（No）で断った。`probe.txt` は作られていない
- `/model` は Esc で閉じた（モデルは `GPT-6-Sol low` のまま）

### 採取前後で確かめたこと

| | 結果 |
|---|---|
| `$HOME` / `~/.commandmate` 直下 | エントリ一覧が前後で一致 |
| `~/.codex/hooks.json` | sha256 一致 |
| `~/.codex/config.toml` | **trust の 1 件が増えた**（上記） |
| `~/.codex/sessions/2026/09/27/` | rollout が 1 件増えた（この probe のもの） |
| 既定の tmux サーバ | 触れていない。私設サーバは停止済み |

## 編集（匿名化）

同じ文字数の置換 2 つだけ（桁は動かない）。ANSI・行数・空行の位置は元とバイト一致。

1. macOS の利用者別一時ディレクトリの名前 `07/<30 文字>` → `07/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
2. `mktemp` の接尾辞 → `XXXXXX`

## ファイル

| ファイル | 画面 | 判定（raw / stripAnsi 後） |
|---|---|---|
| `trust.txt` | 起動直後の `Folder access` / `Trust this folder?` | `waiting` / `prompt_detected` |
| `idle.txt` | 入力欄だけ | `ready` / `input_prompt` |
| `running.txt` | `• Working (3s • esc to interrupt)` | `running` / `thinking_indicator` |
| `approval.txt` | `Would you like to run the following command?`（`touch probe.txt`） | `waiting` / `prompt_detected` |
| `model-picker.txt` | `/model` の 1 段目 `Select Model and Effort` | `waiting` / `codex_selection_list`（修正前は `prompt_detected`） |
| `model-picker-effort.txt` | 1 段目で選択中の行のまま Enter → 2 段目 `Select Reasoning Level for GPT-6-Sol` | `waiting` / `codex_selection_list`（修正前は `prompt_detected`） |
| `model-picker-digit.txt` | `/model` を開き直して `3` → 2 段目 `Select Reasoning Level for GPT-6-Luna` | `waiting` / `codex_selection_list`（修正前は `prompt_detected`） |
| `quoted-approval-idle.txt` | 承認画面の文面を本文で引用した返答の後の入力欄 | `ready` / `input_prompt` |

## 0.155.1 からの差分

| | 0.155.1 | 0.157.1 |
|---|---|---|
| `/model` の見出し | `Select model …` | `Select Model and Effort` |
| `/model` 1 段目のフッタ | `Press enter to confirm or esc to go back` | `enter select · esc back` |
| `/model` 2 段目のフッタ | （未採取） | `enter default · s session · esc back` |
| trust の見出し・フッタ | `Do you trust …` / `Press enter to continue` | `Folder access` / `Trust this folder? …` / `enter continue · esc quit` |
| trust の選択肢 | `1. Yes, continue` / `2. No, quit` | `1. Trust and continue` / `2. Quit` |
| 選択行の描き方 | `ESC[1mESC[38;5;6m› …`（シアン太字） | `ESC[1;7m› 2. … ESC[0;7m<説明>`（**反転**。グリフとラベルは同じスパン） |
| `/model` の配置 | 状態バーの上 | 画面の最下部に寄せて描かれ、下に状態バーが**無い**（`findCodexFooterBoundary` は -1。分岐 0.8 は画面の最後の行までを窓にする） |
| 承認のフッタ | `Press enter to confirm or esc to cancel` | 同じ |

## 番号キーの挙動

`/model` の 1 段目で `3` を押すと、カーソル移動ではなく**即決定**で 3 番のモデルの 2 段目（effort 選択）へ進む
（`model-picker-digit.txt`）。モデルの切り替え自体は 2 段目で決定するまで起きない（Esc 2 回で閉じて `GPT-6-Sol low` のまま）。

## この fixture で直していないもの（Issue の範囲外）

- **trust**: 状態は `waiting` / `prompt_detected` で標準画面の期待どおりだが、フッタ `enter continue · esc quit` を入口が
  認めないので `evaluateDialogPresence(…).present` は false
