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

合図は **この task・この instance・この work item の worktree** で確かめる（#3883）。入力は 3 つの変数で、後半もすべて同じ値を使う:
`$INSTANCE` は wait が待った instance（`antigravity-2` などの追加 instance や別名を解決したもの。tasks.tsv の 3 列目）、
`$WT_DIR` はその work item の worktree のパス（3-3 の `WT_DIR`。`../commandmate-issue-<N>` と決め打ちしない）、`$TASK_ID` は tasks.tsv の 4 列目。

```bash
# 前半: この task の合図と、それが指す HEAD（SIGNAL_HEAD）。規則は wait-verify.mjs の hasCompletionSignal と同じ
ESC=$(printf '\033')
TASK_CREATED=$(commandmatedev task show "$TASK_ID" --json | jq -r '.task.createdAt')
HEAD_NOW=$(git -C "$WT_DIR" rev-parse HEAD)
REPLY_JSON=$(commandmatedev reply "$WT" --instance "$INSTANCE" --since "$TASK_CREATED" --json)
if printf '%s' "$REPLY_JSON" | jq -e '(.reply | type) == "string"' > /dev/null 2>&1; then
  # この task の返事がある: 裸の行（=）と head= の行（=<sha>）を分けて取り出す
  CANDIDATES=$(printf '%s' "$REPLY_JSON" | jq -r '.reply' | sed "s/${ESC}\[[0-9;]*m//g" \
    | sed -nE 's/^[[:space:]]*IMPL_COMPLETED([[:space:]]+head=([0-9a-f]{7,40}))?[[:space:]]*$/=\2/p')
else
  # 返事がまだ無い（reply: null）・読めない: 画面では head= の行だけを取り、今の HEAD が task の作成より後のコミットのときだけ数える
  CANDIDATES=$(commandmatedev capture "$WT" --instance "$INSTANCE" --pane --tail 40 | sed "s/${ESC}\[[0-9;]*m//g" \
    | sed -nE 's/^[[:space:]]*IMPL_COMPLETED[[:space:]]+head=([0-9a-f]{7,40})[[:space:]]*$/=\1/p')
  node -e 'process.exit(Date.parse(process.argv[1]) >= Date.parse(process.argv[2]) ? 0 : 1)' \
    "$(git -C "$WT_DIR" log -1 --format=%cI HEAD)" "$TASK_CREATED" || CANDIDATES=
fi
# 裸の行は今の HEAD の合図、head= の行は今の HEAD を名指すときだけ（別の SHA は数えない）
SIGNAL_HEAD=$(printf '%s\n' "$CANDIDATES" | awk -v h="$HEAD_NOW" '$0 == "=" || (length($0) > 1 && index(h, substr($0, 2)) == 1) { print h; exit }')
if [ -n "$SIGNAL_HEAD" ]; then echo "signal: done head=$SIGNAL_HEAD"; else echo "signal: not yet"; fi
```

- **行全体が `IMPL_COMPLETED` である行だけ**を合図として数える。goal の文面（「最後に `IMPL_COMPLETED` とだけ出力する」）も
  画面に表示されるので、部分一致では誤判定する
- 返事の `IMPL_COMPLETED head=<sha>` は、その SHA が今の HEAD（`git -C "$WT_DIR" rev-parse HEAD`）の先頭と一致するときだけ数える。
  前の HEAD を名指す返事は、この HEAD の完了ではない（#3883。wait-verify.mjs も同じ規則で拒否する）
- 画面（`capture --pane`）の裸の `IMPL_COMPLETED` では決めない。前の task の行が画面に残ったまま、この task の途中のターン終了
  （`schedule` など）が来ることがあり、ターン終了の時刻はその行がこの task のものかを示さない（#3883）。返事がまだ無い（`reply: null`）・
  読めないときに画面で数えてよいのは、今の HEAD を名指す `IMPL_COMPLETED head=<sha>` で、そのコミットの時刻がこの task の作成
  （`$TASK_CREATED`）以後のときだけ。task が台帳に無い（`$TASK_CREATED` が `null`）ときも `not yet` になる
- `not yet` なら、合図が出るまで待つ。作業が続いているかは、`capture --prompts` と commits の増加で確かめる
- 合図が出たら、`$SIGNAL_HEAD` を裁定まで保ち、wait の検証が合図より前に始まっていないかを確かめる。
  比べるのは、「wait が起動した検証の開始時刻」と「同じ `$INSTANCE` の最後のターン終了の時刻」（合図を出したターンの終了）の 2 つ。
  primary の `antigravity` の時刻で比べない（追加 instance の task では、primary の最後の stop は検証より古いことがあり、`after-signal` と読み違える）。
  検証は wait のログの `Verifying: <WT> (run <id>)` の run id で引く（worktree の最新の run は、その後に始まった別の run のことがある、#3883）:

  ```bash
  # 後半: 前半と同じ $WT・$INSTANCE・$WT_DIR・$SIGNAL_HEAD で比べる。$WAIT_LOG は wait のログ（wait-<issue>[-<item>][.a<n>].log）
  RUN_ID=$(grep -oE '^Verifying: [^ ]+ \(run [0-9]+\)' "$WAIT_LOG" | tail -1 | grep -oE '[0-9]+\)$' | tr -d ')')
  RUN_STARTED=$(commandmatedev verify show "$RUN_ID" --json | jq -r '.startedAt')   # 例 2026-09-17T01:28:40.776Z
  LAST_STOP=$(commandmatedev capture "$WT" --instance "$INSTANCE" --json | jq -r '.lastStopEventAt // empty')   # epoch ms
  node -e '
    const [started, stop, committed, signalHead, head, dirty] = process.argv.slice(1);
    if (!signalHead) { console.log("verdict=not-yet (no signal for this task and HEAD)"); process.exit(0); }
    const s = Date.parse(started);
    const before = Number.isFinite(s) && /^[0-9]+$/.test(stop) && s < Number(stop);
    const why = [];
    if (Number.isFinite(s) && Date.parse(committed) > s) why.push("committed-after-start");
    if (head !== signalHead) why.push("head-moved-since-signal");
    if (before && dirty.trim() !== "") why.push("dirty-before-signal");
    const verdict = why.length ? `reverify(${why.join(",")})` : dirty.trim() !== "" ? "dirty" : "adopt";
    console.log(`timing=${before ? "before-signal" : "after-signal"} verdict=${verdict}`);
  ' "$RUN_STARTED" "$LAST_STOP" "$(git -C "$WT_DIR" log -1 --format=%cI)" "$SIGNAL_HEAD" "$(git -C "$WT_DIR" rev-parse HEAD)" \
    "$(git -C "$WT_DIR" status --porcelain | grep -vE '^.. (\.commandmate/tasks/|dev-reports/)')"   # 契約ファイルと dev-reports/ は数えない
  ```

  - **`verdict=adopt`**: wait の exit code をそのまま使う（`before-signal` でも、検証の開始の後にコミットが無く作業ツリーが変わっていなければ、検証は最終状態を見ている。
    exit 0 はそのまま採用し、exit 20 は 3-4 の「合図の前に始まった検証」に従う）
  - **`verdict=reverify(…)`**: 検証は途中の状態を見ている（検証の開始の後のコミット・合図の後の HEAD の移動・合図の前に始まった検証と作業ツリーの変更）。
    `commandmatedev verify "$WT" --task "$TASK_ID" --instance "$INSTANCE" --json` で全ゲートを検証し直し、その結果で裁定する。
    再検証の間に HEAD が動いたら（`git -C "$WT_DIR" rev-parse HEAD` が再検証の前と違えば）裁定せず、前半からやり直す
  - **`verdict=dirty`**: 作業ツリーに未コミットの変更がある。裁定せず、capture で状況を見る（wait-verify.mjs の exit 3 と同じ）
  - **`verdict=not-yet`**: 前半の合図がこの task・この HEAD のものでない。合図を待つ
- #2605 の値: 検証の開始が 01:28:40.776Z、最後のターン終了が 01:33:41.574Z（`before-signal`）。
  最後のワーカーのコミットは 01:27:47 で、作業ツリーはクリーンだった（`verdict=adopt`）

## 3-3 途中でターンを閉じる理由

agy は作業の途中でも
ターンを閉じることがある。例えば、バックグラウンドで起動したコマンドの終了を `schedule`（数十秒後に自分を起こす）で待つとき。
wait はそのターン終了を完了（`basis=hook_stop`）と読むので、作業が終わる前に検証が走る。

## 3-3 wait のログの Prompt detected

- Antigravity のワーカーでは、Auto-Yes が許可ダイアログに応答している間も、wait のログに
  `Prompt detected … Waiting for human response...` が繰り返し出る。応答済みかどうかは
  `capture --prompts` の `[answered:auto]` で確かめる。このログだけを見て介入しないこと。
