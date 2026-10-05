# claude-interrupted-3337 — Claude Code の中断の画面、実測（Issue #3337）

生成の途中で Esc を押した後の Claude Code の画面。**raw のまま置いている（ANSI つき、1000 行）。**

使っているテスト: `tests/unit/lib/turn-abandoned-interrupts-3337.test.ts`

## 採取

| | |
|---|---|
| 採取日 | **2026-10-05**（JST） |
| Claude Code | **2.1.289**（Opus 5.5 / medium effort） |
| 採ったところ | オーケストレーターの実機確認。隔離したサーバー（UAT 用の root）、hooks を注入したセッション |
| 渡されたファイル | `/tmp/claude-501/claude-interrupted-3337.txt`（バイトのまま写した） |

## 画面

| ファイル | 画面 | 中身のある行（0 始まり） |
|---|---|---|
| `claude-2.1.289-interrupted.txt` | 2 つ目の依頼（長い作文）の生成中に Esc を押した後 | 前のターン 7〜21、依頼 23、返答の書き出し 25〜27、`⎿  Interrupted · What should Claude do instead?` 28、入力欄の枠 996〜998、フッター 999 |

## 測って分かったこと（オーケストレーターの実測）

- 中断では **`Stop` の hook が来ない**。Esc の後 2 分半以上、`sessionStatus` は `running` / `hook_prompt_submit`
  のままで、`Notification(idle_prompt)` による `ready` も出なかった
- `detectSessionStatus` はこの画面を `ready` / `input_prompt`（positive）と読む
- 前のターンの中断の行は transcript に残る。読み手は「入力欄の枠（`findClaudeChromeStart`）の上の、最後の
  中身のある行」だけを見る
