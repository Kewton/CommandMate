# Command Code 1.58.0 の Plan review 画面

| | |
|---|---|
| `plan-review-1-58-0.txt` | **実キャプチャ由来（匿名化）。** 2026-09-20 に `commandcode 1.58.0` の live なペイン（200x1000, `tmux capture-pane -p -e`）から取り、plan のタイトル・パス・本文だけを差し替えたもの。罫線幅（200 桁）、ヘッダ 2 行の文言、行番号の桁組み（4 桁右寄せ ＋ 3 スペース）、空の行が「番号 ＋ 空白 4 つ」であること、折り返し行の 7 スペース、` REVIEW ` バッジ、フッタ 3 行の文言は**実測どおり** |

- 実ペインは内容が 1〜173 行目で、174〜1000 行目が空行（上端寄せ）。この fixture は内容部分だけ（46 行）で、1000 行への水増しはテスト側で行う
- ANSI は落としてある（既存の Command Code fixture と同じ）。行カーソルは背景色だけで描かれるので、この fixture には現れない
- 識別に使うのはフッタの 2 行（`Approve ctrl+a   executes the plan` / `Cancel esc`）。`COMMAND_CODE_PLAN_REVIEW_FOOTER` を参照

`COMMAND_CODE_VERIFIED_AGAINST` はこの 1 枚では更新しない。1.58.0 の画面を一通り測るのは Issue #2763 で、
スタンプの更新可否はそちらが決める。
