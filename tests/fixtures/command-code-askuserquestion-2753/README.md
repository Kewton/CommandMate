# Command Code 1.54.1 の `AskUserQuestion`（回答済みタブ ＋ 複数選択）

| | |
|---|---|
| `multiselect-answered-tabs.txt` | **実キャプチャ由来（匿名化）。** 2026-09-20 に `commandcode 1.54.1` の live なペイン（200x1000, `tmux capture-pane -p -e`）から取り、ラベル・本文だけを差し替えたもの。罫線幅（200 桁）、タブ行のグリフ（`✔` / `●` / `◯`）、オプション行のインデント、`[ ]` / `[x]`、`Submit` 行、フッタ文言は**実測どおり** |
| 1.53.0 の同じ画面 | [`../command-code-askuserquestion-2521/`](../command-code-askuserquestion-2521/README.md)。**タブは `● / ◯` の 2 つだけ、チェックボックスなし、`Submit` 行なし、フッタなし** |

1.53.0 から 1.54.1 で増えたもの:

- 回答済みタブの `✔`（1 画面に複数の質問をタブで並べる形）
- `[ ]` / `[x]` のチェックボックス（複数選択）
- オプションの下の `Submit` 行
- フッタ `Enter to select | Arrow keys to navigate | 1-9 quick select | n notes | c chat | Esc to cancel`
  （`COMMAND_CODE_SELECTION_LIST_FOOTER` は `·` 区切りの `enter to select · esc to cancel` なので**一致しない**）

`COMMAND_CODE_VERIFIED_AGAINST` はこの 1 枚では更新しない。1.54.1 の画面を一通り測るのは Issue #2754 で、
スタンプの更新可否はそちらが決める。
