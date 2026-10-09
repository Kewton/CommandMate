# Claude Code transcript — バックグラウンド作業を残したままの Stop（Issue #3430）

`transcript.jsonl` は 2026-10-08 の実 transcript（Claude Code 2.1.293、worktree `commandmate-issue-3423`、
session `0a8e0d46-…`）から抜き出したもの。**手で書いた想定ではなく、届いた記録の形をそのまま残している。**

## 何が起きたか

1. 23:37:00 `Bash` が 120 秒で打ち切られてバックグラウンドへ（`toolUseResult.backgroundTaskId: "beszxbdym"`）
2. 23:37:06〜23:37:49 `Monitor` を 6 本起動（`toolUseResult.taskId` と `persistent: false`）。うち `b5svpm92a` はターン中に通知が届いた（`queue-operation` の `remove` と `queued_command` の attachment）
3. 23:37:53 **最初の Stop**（47 行目の `stop_hook_summary`）。未通知の作業が 6 本残っている
4. 23:38:14 `beszxbdym` の `<task-notification>` が `type: "user"` のプロンプトとして届き、新しいターンが開く → コミット
5. 以後、Monitor の通知のたびにターンが開いて閉じ、最後の Stop（84 行目）で未通知の作業が 0 本になる

各 `stop_hook_summary` の直前までを読むと、未通知の作業は 6 → 5 → 4 → 3 → 2 → 1 → 0 本。

## 加工

- 載せたのは `user` / `assistant` / `queue-operation` / `queued_command` の attachment / `stop_hook_summary` だけ。他の type（`prompt_snapshot` など）は落とした
- 最初のプロンプト（契約本文）、バックグラウンドでないツール結果の本文、ツール入力のコマンドは伏せた（`(elided)` など）
- パスは `<TASK_DIR>` / `<CWD>` / `<HOME>` に、session id は `00000000-0000-4000-8000-000000003430` に置換
- 残した構造化フィールド: `toolUseResult` の `backgroundTaskId` / `taskId` / `persistent` / `timeoutMs` / `timedOutAfterMs` / `interrupted`
