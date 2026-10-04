# live-region-3183 — 引用されたダイアログ（合成）

Issue #3183 の陰性 fixture のうち、実機の採取が無い 3 ツール分。
読むテストは `tests/unit/detection/tools/live-region-quoted-dialog.test.ts` と
`tests/unit/lib/polling/auto-yes-live-region-3183.test.ts`。
判断は [`docs/design/3183-live-region-extraction.md`](../../../docs/design/3183-live-region-extraction.md) の §4.2 / §6 項目 2。

## なぜ合成か

3 ツールとも「承認ダイアログの文面を返答に描かせ、その下に入力欄がある」実機キャプチャがリポジトリに無い。
既存のテスト（`tests/unit/lib/polling/antigravity-quoted-dialog-autoyes.test.ts` の `quoteAboveComposer`、
`tests/unit/lib/detection/command-code-quoted-footer.test.ts` の `quotedAboveComposer`）と同じく、
**実機の idle フレームの入力欄の直前に、実機のダイアログの行を差し込んで**作った。
実機の採取は agent-health の `screen-quoted-dialog` で保存されるフレーム（`--save-frames all`）から置き換える。

## 作り方

どれも「元の idle フレームの物理行 N の直前に、元のダイアログの物理行 A〜B と空行 1 行を差し込み、
差し込んだ行数だけ最も長い空行の連続から空行を消して、行数を元と同じにする」。
差し込んだ行は ANSI を含めて 1 バイトも変えていない（copilot だけ、枠の `│` を外した — 返答の中の引用に枠は無い）。

| ファイル | 元の idle フレーム（差し込み位置） | 差し込んだダイアログの行 | 行数 |
|---|---|---|---|
| `quoted-dialog-idle-antigravity.txt` | `tests/fixtures/antigravity-live-2364/idle-after-deny.txt` の L41（入力欄の上の罫線）の直前 | `tests/fixtures/antigravity-live-2364/dialog-bash-oneline.txt` の L26–L38（`Command` から `↑/↓ Navigate` の footer まで） | 1001（元と同じ） |
| `quoted-dialog-idle-command-code.txt` | `tests/fixtures/tui-frame-footer-2776/command-code-1.58.0-idle-quoted-footers.txt` の L29（入力欄の上の罫線）の直前 | `tests/fixtures/command-code-live-2250/dialog-shell-command.txt` の L31–L40（`Execute Shell Command` から footer まで） | 1001（元と同じ） |
| `quoted-dialog-idle-copilot.txt` | `tests/unit/lib/detection/fixtures/copilot-live-1885/turn-complete.txt` の L997（cwd 行）の直前 | `tests/unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt` の L994–L1000（質問から footer まで。ANSI と左右の `│` を外し、3 桁字下げ） | 1002（元と同じ） |

agy の差し込みは footer の行（L38）で止め、その下の `esc to cancel`（L39）は入れていない。
L39 は agy の状態行で、ダイアログの文面ではない。入れると「引用された `esc to cancel` が実行中に見える」という
別の問題（`tests/unit/lib/detection/antigravity-quoted-dialog.test.ts` の `keeps a generating pane generating`）を測ることになる。

## 期待する判定

| ファイル | 状態 | Auto-Yes |
|---|---|---|
| 3 本とも | `ready`、`hasActivePrompt: false` | 答えない |

ファイル名をツール名で**始めない**のは、ツール名で始まるファイルを「実機の画面」として全件掃引するテスト
（`tests/unit/lib/detection/command-code-quoted-footer.test.ts` の `commandCodeCaptures` など）に、合成フレームを混ぜないため。
