# ワーカーへの送信と監視の手順と根拠

Phase 3（並列開発）の規則は本体にある。ここには、monitor の手順と、送信・完了待ちの根拠を移した（#3481）。

## 2.5-1 分析の依頼の送り方

develop worktree上でバグIssueごとに根本原因分析を実行する：

```bash
WORKTREE_ID="mycodebranchdesk-develop"

for bug_issue in $BUG_ISSUES; do
  ISSUE_BODY=$(gh issue view "$bug_issue" --repo Kewton/CommandMate --json body -q '.body')

  # 必ず --agent copilot 等でclaude以外のエージェントを指定
  commandmatedev send "$WORKTREE_ID" "Issue #${bug_issue} の根本原因分析を実施してください。コードを変更せず分析のみ行い、結果をテキストで出力してください。

## Issue内容
${ISSUE_BODY}

## 分析要求
1. 事象の再現パスをコード上で特定
2. 根本原因を特定（直接原因、設計上の問題、類似リスク）
3. 対策案を策定（即座対策、恒久対策、予防策）" \
    --agent copilot --model claude-sonnet-5 --auto-yes --duration 1h

  commandmatedev capture "$WORKTREE_ID" --instance copilot --pane --tail 20
  # 画面のモデル表記を確認し、想定外のモデルで動いていないかを確かめる

  commandmatedev wait "$WORKTREE_ID" --instance copilot --timeout 3600 --on-prompt agent
  commandmatedev capture "$WORKTREE_ID" --instance copilot
done
```

## 3-1 assign.tsv を stdin で読んで止まった実測

その run では 1 件目の `send` の前でループが止まり、**約 90 分、ワーカーが 1 人も起動していないのに「送信中」と報告した**
（send の出力ファイルは 1 つも作られず、`GET /api/worktrees/<WT>/tasks` は空だった）。

## 3-2 monitor の起動と読み方

より詳細な監視は orchestrate-monitor skill を使う。契約付き委任では**タスク状態を一次ソース**に
できるので、`hooks-task.sh` を併せて読み込む:

```bash
MONITOR_HOOKS_BASE=origin/develop \
.claude/skills/orchestrate-monitor/scripts/monitor.sh \
  --verbose \
  --hooks .claude/skills/orchestrate-monitor/scripts/hooks-git.sh \
  --hooks .claude/skills/orchestrate-monitor/scripts/hooks-task.sh \
  --interval 20 --idle-threshold 8 <worktree-id> ... 2>&1 | tee monitor.log
```

介入先の tmux セッションは capture の `cliToolId` から導出されるので**指定は不要**（#1601）。
既定インスタンス以外を見るときだけ `<worktree-id>@<instance-id>`（例 `w1@codex-2`）で指定する。
**Antigravity のワーカーは `<worktree-id>@antigravity` で渡す**（worktree の既定は claude なので、
付けないと Claude のペインを見る）。

Antigravity のワーカーの画面判定の目印（#2606 の修正の経緯を含む）は、monitor の表示と画面が食い違うときに docs/orchestrate/antigravity.md#3-2-画面判定の目印と経緯 を読む。

Antigravity のワーカーについては次のように扱う:

- `hooks-task.sh` は引き続き**必ず**付け、完了の一次ソースにする。ポーラーのカーソルが画面の最終行を
  越えていると、`realtimeSnippet` にも `content` にもペインの行が無く、そのポーリングは `IDLE` になる
- 着手の確認は `GENERATING` / `PROMPT` の行で行える。補助として
  `commandmatedev capture "$WT" --instance antigravity --prompts --limit 5`（Auto-Yes が応答した
  許可ダイアログが時刻つきで並ぶ）や commits / uncommitted の増加も使える
- レート制限・API エラー（再送）の目印は Claude の文言のままで、agy の画面では当てにしない
  （agy のその画面は実機キャプチャが無い）
- 画面を見るときは `commandmatedev capture "$WT" --instance antigravity --pane --tail 30` を使う
  （`--json` の `realtimeSnippet` / `content` は agy の画面では空行ばかりになることがある）

**起動直後に `monitor hooks ERROR` が出ていないことを確認する（#1728）。** 出ていたら
worktree-id が checkout に解決できておらず、`commits` / `uncommitted` は**測定値ではなく恒久 0** で、
「未起動 idle を COMPLETE と誤報しない」STARTED ガードが実質的に無効になっている。
その場合は checkout の親ディレクトリを渡して回避する:

```bash
MONITOR_WORKTREE_ROOT=.. MONITOR_HOOKS_BASE=origin/develop \
.claude/skills/orchestrate-monitor/scripts/monitor.sh ... # 以下同じ
```

**ログを `grep` で絞るときは `ERROR|WARN|alive` をパターンに必ず含めること。** 上の
`| tee` なら全部残るが、実運用でよくやる
`| grep -Ei "STALL|IDLE|BLOCKED|PROMPT|COMPLETE|NOT_STARTED|ERROR|FAIL"` 形だと、
フック側の診断（上記）と監視自身の生存報告（`monitor: alive (poll=N, …)`、既定 10 ポーリングごと）が
落ちる。2026-08-06 に監視が **exit 144 で沈黙終了**し、ワーカー 2 本が約 25 分間無監視のまま
走り続けたのはこれが理由である。`alive` が途切れた所が最後に生きていたポーリングで、
異常終了時は `caught SIG…` / `exiting on poll round …` が stderr に出る。

## 3-3 完了検出が壊れた実例

2026-08-24 に #2011（`isUnclassifiedActive`
の回帰）でこれが起き、**3 ワーカーの `wait --verify` が `Unclassified interactive frame …
Waiting for human response...` を並べたまま 18 分空転した**（`--on-prompt human` なので
exit 10 にもならない）。

## 3-3 wait-verify.mjs が行う完了の確定

- **完了の確定**（下の 2 つの手順と同じことをスクリプトが行う）: Antigravity（と `--require-signal` を付けた担当）は、
  行全体が `IMPL_COMPLETED` の行が画面に出るまで 30 秒ごとに待つ。次に、直近の検証の開始時刻（`verify history`）と
  最後のターン終了（`capture --json` の `lastStopEventAt`）と最後のコミットの時刻と作業ツリーを比べる。検証の開始の後にコミットがあるか、
  最後のターン終了より前に始まって作業ツリーに変更があれば、検証は途中の状態を見ているので `verify "$WT" --task "$TASK_ID"` でやり直し、
  その結果を記録する。時刻が読めないときは推測せず、記録の要約に `run-start=unknown` / `last-stop=unknown` と残す

## 3-3 完了検出が壊れたときの退避

退避手順:

```bash
# 完了検出を経由せずゲートだけ回す（--gates を渡すと scope が選択されず exit 99 に落ちない）
commandmatedev verify "$WT" --gates token-discipline,control-chars,claudemd-size,route-exports,\
build-cli,build-server,lint,lint-sh,build,typecheck,integration,unit
```

この一覧は `.commandmate/verify.yaml` の宣言ゲートと同じ集合にする（`tests/unit/tasks/orchestrate-lint-sh-gate-3478.test.ts` が固定。入れないゲートは理由つきでそのテストの除外に書く）。

このとき `work-evidence` と `scope` は落ちるので、**オーケストレーターが手で照合する**
（commits ≥ 1 かつ作業ツリークリーン／`git diff --name-only origin/develop...HEAD` を契約の
`allow` と `deny` に突き合わせる）。ワーカーが完了しているかは commits と作業ツリーの状態で見る。
