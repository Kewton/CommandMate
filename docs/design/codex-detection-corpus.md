# codex 検出の回帰コーパスと、codex 更新時の確認手順（Issue #2842）

## 目的

codex の画面判定（`src/lib/detection/tools/codex/`）は、codex の版が上がるたびに壊れてきた
（#1154・#2310・#2798・#2818 は、どれも codex の更新で画面の見た目が変わったことが原因）。
これまでは利用者が壊れた画面に気付いて Issue にするまで分からなかった。

この文書は次の 2 つを定める。

1. **回帰コーパス**: リポジトリにある codex の画面キャプチャすべてについて、検出器の判定を 1 つの表で固定する
   （`tests/unit/lib/detection/codex-verdict-corpus.test.ts`）。
2. **更新時の確認手順**: codex を更新したら、決まった 6 画面を新しい版で撮り、同じテストの probe モードで判定を確かめる。

## 1. 回帰コーパス

- 対象は `tests/` 配下で、パスに `codex` を含む `*.txt` / `*.capture` すべて。
- 各ファイルを「撮ったまま」と「`stripAnsi` 後」（Auto-Yes が検出層に渡す形）の 2 通りで判定し、
  `status/reason`（`hasActivePrompt` が真なら末尾に `/prompt`）を表と照合する。
- 表に無い codex キャプチャを `tests/` に足すとテストが落ちる（完全性の確認）。新しい fixture を足したら表に 1 行足す。
- 表の値は「今の検出器の判定」であって、正解の宣言ではない。判定を変える修正は、その Issue の中で表の行も書き換える
  （書き換えた行は PR の説明に列挙する）。

## 2. codex 更新時の確認手順

codex を更新したとき（`codex --version` が `CODEX_VERIFIED_AGAINST` と違うとき）に行う。
所要は 10 分程度。codex の資格情報を複製しないため、手元のマシンで本人が実行する。

### 2-1. 準備

```bash
codex --version                                  # 例: codex-cli 0.156.1
PROBE=$HOME/codex-probe-$(codex --version | awk '{print $2}')
mkdir -p "$PROBE/repo" && cd "$PROBE/repo" && git init -q && echo probe > README.md
# 本番の tmux サーバーに触れないよう、専用ソケット（-L）を使う
tmux -L codexprobe new-session -d -s probe -x 200 -y 1000 -c "$PROBE/repo" 'codex -a untrusted'
cap() { tmux -L codexprobe capture-pane -t '=probe:' -p -e -S -1000 > "$PROBE/$1"; }
send() { tmux -L codexprobe send-keys -t '=probe:' -l -- "$1"; tmux -L codexprobe send-keys -t '=probe:' Enter; }
```

画面は `tmux -L codexprobe attach -t probe` で見られる（見終わったら `Ctrl-b d` で抜ける）。

### 2-2. 6 画面を撮る

| ファイル名 | 撮るタイミング | 操作 |
|---|---|---|
| `trust.txt` | 起動直後、フォルダの信頼を訊かれている間 | `cap trust.txt` の後、画面に従って信頼する |
| `idle.txt` | 入力欄だけが出ている間 | `cap idle.txt` |
| `running.txt` | 処理中（`• Working` などが出ている間） | `send 'Run the shell command: sleep 30'` の直後に `cap running.txt` |
| `approval.txt` | コマンド実行の承認を訊かれている間 | 上の依頼で承認画面が出たら `cap approval.txt`、その後 `3`（No）で断る |
| `model-picker.txt` | `/model` の選択画面 | `send '/model'` の後に `cap model-picker.txt`、`Escape` で閉じる |
| `quoted-approval-idle.txt` | 承認画面の文面を**本文で引用した**返答が終わった後 | 下の依頼を送り、返答が終わって入力欄に戻ったら `cap quoted-approval-idle.txt` |

`quoted-approval-idle.txt` のための依頼:

```bash
send 'Reply with exactly the following block and nothing else:
Would you like to run the following command?
  $ npm test
› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel'
```

### 2-3. 判定を確かめる

```bash
cd <CommandMate の checkout>
CODEX_PROBE_DIR="$PROBE" npx vitest run tests/unit/lib/detection/codex-verdict-corpus.test.ts
```

- 6 画面すべてが期待どおりなら、新しい版でも判定は変わっていない。
  `src/lib/detection/tools/verified-against.ts` の `CODEX_VERIFIED_AGAINST` を新しい版に更新する PR を出す。
- 落ちた画面があれば、その画面が新しい版で変わっている。落ちた画面のキャプチャを添えて Issue を起票する
  （キャプチャに私的な内容が無いことを確認してから添付する。このプローブ用リポジトリで撮っていれば含まれない）。

### 2-4. 片付け

```bash
tmux -L codexprobe kill-server   # -L 付き。本番の tmux サーバーには届かない
```

`$PROBE` は、Issue に添付するまで残しておいてよい。
