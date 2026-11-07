# opencode 1.18.35 の 1 秒未満のターン（Issue #4134）

`turn-done-subsecond.txt` は確定モデル（課金なしのモック）で 1 ターン終えた画面の `capture-pane -e -p`。隔離の HOME・XDG、`tmux -L`、80x200。

`▣  Build · mock-model · 836ms`。opencode は所要時間を次の形で描く（1.18.35 の実行ファイルの関数 `g`）。

| 所要時間 | 形 |
|---|---|
| 1 秒未満 | `836ms` |
| 1 分未満 | `5.2s` |
| 1 時間未満 | `1m 5s` |
| 1 日未満 | `1h 5m` |
| それ以上 | `2d 3h` |

`turn-done-subsecond-local-model.txt` は Ollama の局所モデル（gemma4:26b、課金なし・認証なし）の 2 ターン目。`▣  Build · gemma4 · 637ms` と、モックでない本物のモデルでも 1 秒未満になる。

検出が見ていたのは `5.2s`・`1m 5s` の形だけで、この画面は `running` / `unknown_frame` になり、`wait` が exit 124 になった。
