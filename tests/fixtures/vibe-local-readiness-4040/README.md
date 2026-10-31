# vibe-local-readiness-4040 — vibe-local 1.3.3 の送信前の画面、実測（Issue #4040）

`isVibeLocalComposerReady`（`src/lib/detection/tools/vibe-local/readiness.ts`）の判定を、
実機の画面で固定するための採取。`tests/unit/cli-tools/send-readiness-4040.test.ts` が読む。

## 採取の条件

| | |
|---|---|
| 採取日 | 2026-11-01 |
| エージェント | vibe-local（vibe-coder）1.3.3、モデル `qwen3-coder:30b`（Ollama、起動前はモデル未ロード） |
| 起動 | `vibe-local -y`（CommandMate と同じ引数） |
| 隔離 | 使い捨ての `HOME`（設定ファイルの `MODEL` / `SIDECAR_MODEL` / `OLLAMA_HOST` の 3 行の写しと、`vibe-coder.py` へのリンクだけ）、`XDG_STATE_HOME` ほかも使い捨て。`ps eww` でプロセスの環境に効いていることを確認 |
| tmux | 私設ソケット `tmux -L cm4040vl`、200x50、`capture-pane -p -S -200 -E -`（`-e` 無し） |
| 後始末 | `kill-session -t '=vl4040:'`、読み込まれたモデルは `ollama stop` で採取前の状態（未ロード）に戻した |

パスとシェルのプロンプトは置き換えている（`/Users/dev/work/vibe-probe`、`dev@host work %`）。判定はどちらも読まない。

## 起動から入力欄まで（3 回）

起動の打鍵から、最後の `ctx:N% ❯` の行が本文の無い形になるまで: **1.15 s / 0.62 s / 0.60 s**。
vibe-local はモデルを起動時ではなく最初の発言で読み込む。送信の待ち（15 s）はこれを十分に覆う。

## ファイル

| ファイル | 画面 | 判定 |
|---|---|---|
| `boot-ready.txt` | 起動画面（入力待ち）。`ctx:4% ❯` の下はフッター（`─` の罫線・`✦ Ready │ ctx:4% │ qwen3-coder:30b`・`ESC: stop`）だけ | ready |
| `boot-loading.txt` | 起動の 0.5 s 後。ラッパーのバナーだけで、入力欄はまだ無い | not ready |
| `generating.txt` | 最初の発言を送った直後。エコー `ctx:4% ❯ Reply with …` の下に `◜ Thinking — ESC: stop...`。ステータスバーは生成中も `✦ Ready` | ready（生成中の例外） |
| `turn-done.txt` | 最初のターンが終わった画面。エコーの下に `assistant: OK-4040`、新しい `ctx:4% ❯` | ready |

**入力欄の行は最後の空でない行ではない。** 1.3.3 は入力欄の下にフッター 3 行を描く。
「最後の空でない行が `ctx:N% ❯`」をそのまま判定にすると、準備のできた画面も準備できていないと読む。
