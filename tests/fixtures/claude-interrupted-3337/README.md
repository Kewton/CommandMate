# claude-interrupted-3337 — Claude Code の中断の画面、実測（Issue #3337）

生成の途中で Esc を押した後の Claude Code の画面 2 枚。**raw のまま置いている（ANSI つき、1000 行）。**

使っているテスト: `tests/unit/lib/turn-abandoned-interrupts-3337.test.ts`

## 採取

| | |
|---|---|
| 採取日 | **2026-10-05**（JST） |
| Claude Code | **2.1.289**（Opus 5.5 / medium effort） |
| 採ったところ | オーケストレーターの実機確認。隔離したサーバー（UAT 用の root）、hooks を注入したセッション |
| 渡されたファイル | `/tmp/claude-501/claude-interrupted-3337.txt`、`/tmp/claude-501/claude-esc-restored-3337.txt`（どちらもバイトのまま写した） |

## 画面

| ファイル | 画面 | 中身のある行（0 始まり） |
|---|---|---|
| `claude-2.1.289-esc-restored.txt` | 依頼（長い作文）を送り、生成が始まって約 8 秒で Esc を押した後。**`Interrupted` の行は出ず、送った文が入力欄に戻る** | 前のターン 7〜17、入力欄の枠 996〜998（997 が入力欄で、戻った依頼の文が入っている）、フッター 999 |
| `claude-2.1.289-interrupted.txt` | 2 つ目の依頼（長い作文）の生成中に Esc を押した後 | 前のターン 7〜21、依頼 23、返答の書き出し 25〜27、`⎿  Interrupted · What should Claude do instead?` 28、入力欄の枠 996〜998、フッター 999 |

## 測って分かったこと（オーケストレーターの実測）

- どちらの形でも **`Stop` の hook が来ない**。`Interrupted` の形は Esc の後 2 分半以上、入力欄に戻る形は
  45 秒以上、`sessionStatus` は `running` / `hook_prompt_submit` のままで、`Notification(idle_prompt)` による
  `ready` も出なかった（画面でターンを閉じない扱いを Claude にも当てていた版で）
- `detectSessionStatus` はどちらの画面も `ready` / `input_prompt`（positive）と読む
- 中断の形が 1 つではないので、画面から「中断」を読む方式は取りこぼす。そこで Claude には
  画面でターンを閉じない扱いを当てず、#1930 のとおり画面の証拠で閉じる
  （`src/lib/detection/turn-abandoned.ts`）。この 2 枚は、Claude のターンが画面で閉じることの確かめに使う
