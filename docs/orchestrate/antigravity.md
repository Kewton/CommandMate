# Antigravity 担当の運用メモ

Antigravity 担当のワーカーに固有の運用メモと、手で確かめるときの手順を移した（#3481）。いつ読むかは本体の各節に書いてある。

## 1-2b 冷間起動と信頼ダイアログの運用メモ

**運用メモ（Antigravity の送信時、2026-09-20 実測）**: 新規 worktree の 1 回目の send は
`exit 99`（`prompt not ready`）になることがある。原因は 2 系統あり、**画面を見て切り分ける**:

- **フォルダ信頼ダイアログ**（`Do you trust the contents of this project?` / `> Yes, I trust this folder`）—
  Auto-Yes は答えられない。`tmux send-keys -t "=mcbd-antigravity-<worktree-id>:" Enter` で確定してから再送する。
  **`-t` の末尾にコロンが要る**（`-t "=<name>"` だけだと `can't find pane` になる）
- **起動が 60 秒枠に間に合わないだけ**（Claude でも起きる）— 画面が既にプロンプトなら、そのまま 1 回再送すれば通る

どちらもワーカー起因ではないので、3-4 の再指示回数には数えない。

## 3-2 画面判定の目印と経緯

**Antigravity のワーカーも monitor の画面判定で読める（#2606 で修正）。** 修正前は、生成中の目印
（`↓ N` / `esc to interrupt`）とプロンプトの目印（`❯ N.`）が Claude の画面の文言だけで、agy の画面
（`esc to cancel`・点字スピナー・`Run this command?`）には当たらなかった。しかも agy のペインは上端寄せ
（200x1000）なので、判定が読んでいた `realtimeSnippet`（末尾 100 行）は空行ばかりだった。2026-09-17 の
パイロットでは 59 回のポーリングがすべて `IDLE started=0` で、裁定に届いたのは `hooks-task.sh` の task 状態を
読んでいたからである。現在の `classify-state.sh` は、capture の `cliToolId` が `antigravity` のときだけ
agy 用の目印を使い、`realtimeSnippet` と `content` の長い方から空行を除いた末尾を読む:

- 生成中: ステータス行の `esc to cancel`、または点字スピナー。ただし `↑/↓ Navigate` フッターがある画面では
  生成中と読まない（agy のダイアログもステータス行に `esc to cancel` を出すため）
- プロンプト: `↑/↓ Navigate` フッター＋番号つきの選択肢（`> 1. Yes` など）
- 待機中: 入力欄の枠（罫線 / `>` / 罫線 / ステータス行）。`? for shortcuts` には頼らない（#2478）

## 3-3 完了の合図を手で確かめる

2026-09-17 #2605 の実測（`logs/server.log`）:
- 01:28:34 `schedule` の許可 → 01:28:36 stop → wait が完了と読んで検証を開始
- その後 4 回、`schedule` で起き直しては閉じる、をくり返した
- 最後の stop は 01:33:41 で、`IMPL_COMPLETED` もこのとき出た

検証が途中の成果物ですべて通ると、未完成の変更がマージに進む。wait が返ったら、まず合図を確かめる:

```bash
commandmatedev capture "$WT" --instance antigravity --pane --tail 40 \
  | perl -pe 's/\e\[[0-9;]*m//g' \
  | grep -qE '^[[:space:]]*IMPL_COMPLETED[[:space:]]*$' && echo "signal: done" || echo "signal: not yet"
```

- **行全体が `IMPL_COMPLETED` である行だけ**を合図として数える。goal の文面（「最後に `IMPL_COMPLETED` とだけ出力する」）も
  画面に表示されるので、部分一致では誤判定する
- `not yet` なら、合図が出るまで待つ。作業が続いているかは、`capture --prompts` と commits の増加で確かめる
- 合図が出たら、wait の検証が合図より前に始まっていないかを確かめる。
  比べるのは、「wait が起動した直近の検証の開始時刻」と「最後のターン終了の時刻」（合図を出したターンの終了）の 2 つ:

  ```bash
  RUN_STARTED=$(curl -s "http://localhost:3000/api/worktrees/$WT/verify/runs" \
    | jq -r '[.runs[] | select(.trigger == "wait")][0].startedAt')          # 例 2026-09-17T01:28:40.776Z
  LAST_STOP=$(commandmatedev capture "$WT" --instance antigravity --json | jq -r '.lastStopEventAt')   # epoch ms
  node -e "console.log(Date.parse(process.argv[1]) < Number(process.argv[2]) ? 'before-signal' : 'after-signal')" \
    "$RUN_STARTED" "$LAST_STOP"
  git -C "../commandmate-issue-${issue}" log -1 --format=%cI   # 最後のコミット時刻
  git -C "../commandmate-issue-${issue}" status --porcelain    # 契約ファイル以外の変更が無いこと
  ```

  - **`after-signal`**: wait の exit code をそのまま使う
  - **`before-signal`**: 最後のコミットが検証の開始より後か、作業ツリーに変更があれば、検証は途中の状態を見ている。
    `commandmatedev verify "$WT" --task "$TASK_ID" --json` で全ゲートを検証し直し、その結果で裁定する。
    どちらも無ければ、検証は最終状態を見ている。exit 0 はそのまま採用し、exit 20 は 3-4 の「合図の前に始まった検証」に従う
- #2605 の値: 検証の開始が 01:28:40.776Z、最後のターン終了が 01:33:41.574Z（`before-signal`）。
  最後のワーカーのコミットは 01:27:47 で、作業ツリーはクリーンだった
