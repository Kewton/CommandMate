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

  # この send は launch-worker.mjs を通さない: 読むだけの分析で契約を使わず、claude のワーカーではなく copilot に送るため。
  commandmatedev capture "$WORKTREE_ID" --instance copilot --pane --tail 20
  # 画面のモデル表記を確認し、想定外のモデルで動いていないかを確かめる

  commandmatedev wait "$WORKTREE_ID" --instance copilot --timeout 3600 --on-prompt agent
  commandmatedev capture "$WORKTREE_ID" --instance copilot
done
```

## 3-1 assign.tsv を stdin で読んで止まった実測

その run では 1 件目の `send` の前でループが止まり、**約 90 分、ワーカーが 1 人も起動していないのに「送信中」と報告した**
（send の出力ファイルは 1 つも作られず、`GET /api/worktrees/<WT>/tasks` は空だった）。

## 3-1 Claude のモデルを契約に固定する

本体の 3-1・3-5・3-5b（docs/orchestrate/switching.md）は、送信を `scripts/orchestrate/launch-worker.mjs send` で行う（#3883）。手順の写しは作らず、この helper を呼ぶ。

- **書く**: Claude（`--model opus|sonnet`）は、動いているセッションを止めてから、worktree の `.claude/settings.local.json` の `model` に
  契約のモデルを**毎回明示して**書く（opus は `opus[1m]`、sonnet は `sonnet`。ほかのキーは残す）。以前は opus のとき `model` を消していたので、
  `~/.claude/settings.json` のグローバル既定を継ぎ、利用者が既定を fable に変えた後の run では opus 指定のワーカーが fable で動いた
  （2026-10-23、summary-3749-3839）。利用者のグローバル設定は読みも書きもしない。git が無視していないファイル（`git check-ignore` が通らない）や
  JSON でないファイルには書かず、何も送らずに exit 2
- **契約より先に起動して確かめる**（#3883 N1）: セッションは契約ではなく、作業を頼まない短いメッセージ（`INIT_MESSAGE`。Auto-Yes も付けない）で起動する。
  その後に `capture --json` の `model` を読む（空なら 20 秒おいて 3 回まで）。契約のモデル（`opus` / `sonnet` の語）を含めば `model ok`。
  空のままなら `model UNKNOWN`、別のモデルなら `model MISMATCH`。`model ok` のときだけ、`sessionStatus` が `ready` を 2 回続けて読む（10 秒おき、30 回まで）のを待って
  契約と Auto-Yes を送る。ready にならなければセッションを止め、契約は送らずに exit 1
- **1 回だけ起動し直す**: UNKNOWN / MISMATCH はセッションを止め、モデルを書き直し、起動のメッセージから送り直す。2 回目も一致しなければ
  セッションを止めて exit 40（MISMATCH）/ 41（UNKNOWN）。**契約も Auto-Yes もそのセッションには送らない**（tasks.tsv の task id は空になる）
- **止めたことを確かめる**（#3883 N2）: 止めるたびに `instances <WT> kill` の exit code と、その後の `instances <WT> --json` で `running` でないこと
  （5 秒おいて 3 回まで読む）を確かめる。kill が失敗した・まだ動いている・一覧が読めないときは、`stop UNCONFIRMED …` を出し、
  設定の書き換えも再送もせずに exit 42（kill API は止められないとセッションを残して 500 を返す）。人が止めてから送り直す
- **起動の前に Auto-Yes を切る**（#3883 N7）: Auto-Yes は worktree × instance ごとに残り、セッションが無くても次のセッションの画面に答える。
  そこで起動のたびに（セッションが動いていなくても）`auto-yes <WT> --disable --instance <id>` を送り、`instances <WT> --json` の `autoYes`（状態の保存先の値）が
  true でないことを読み返す（2 秒おきに 3 回まで）。切れたと確かめられなければ `auto-yes UNCONFIRMED …` を出し、何も書かず何も送らずに exit 43。
  Auto-Yes は契約の送信（`--auto-yes`）で初めて入る
- **送信の出力**: `runs/<date>/send-<issue>[-<item>][.a<n>].out` / `.err` を呼び出しごとに排他的に取る（`execution-key.mjs`。同じ Issue の送信を並行しても、
  起動し直しても混ざらない）。起動のメッセージの出力は `send-init-<issue>[-<item>][.a<n>].out` / `.err`。stdout は task id だけ。
  起動のメッセージが exit 99（initialization timeout / prompt not ready / composer-not-empty）なら、`MODEL_READS` × `MODEL_READ_INTERVAL_SEC` の範囲で `capture --json` の model を読み、読めれば `.err` に「プロンプト到達を確認して続行」と残して契約へ進む（読めなければ従来どおり 1 回起動し直し、なお読めなければ exit 41）。99 以外の失敗はその exit code を返し、モデルは確かめない。契約の send の失敗は従来どおり
- **単独で使うとき**: `launch-worker.mjs set-model --worktree <path> --model <opus|sonnet>`（本体の `set_claude_model` はこれを呼ぶ）、
  `launch-worker.mjs check-model --wt <WT> --model <opus|sonnet>`（0 / 40 / 41）

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

- **完了の確定**（下の 2 つの手順と同じことをスクリプトが行う）: Antigravity の instance（`antigravity-2` などの追加 instance と、その alias も。
  サーバーが解決した担当ツール `cliToolId` で決める、#3883）と `--require-signal` を付けた担当は、
  行全体が `IMPL_COMPLETED` の行が出るまで 30 秒ごとに待ち、**合図を見るまで検証を始めない**（`wait --verify` ではなく `wait` → 合図 → `verify --task` に分ける。
  作業の途中のターン終了で検証を走らせない、#3883）。合図は**この task のもの**だけを数える: この task の返事（`reply "$WT" --instance <id> --since <task の作成時刻> --json`）が
  読めるときはその返事の中の行で決める（画面に前の task の合図が残っていても、返事に無ければまだ）。返事がまだ無い（`reply: null`）か読めないときは、
  画面の裸の `IMPL_COMPLETED` は数えない（前の task の行が残ったまま、この task の途中のターン終了が来ることがある）。画面で数えるのは、
  今の HEAD を名指す `IMPL_COMPLETED head=<sha>` で、その HEAD のコミットが task の作成より後のものだけ。どれも無ければ `--signal-timeout` まで未確定のまま待つ。
  task が台帳に無い（作成時刻が分からない）ときだけ、画面の行を今までどおり数えて `signal-task=unknown` と残す。`IMPL_COMPLETED head=<sha>` の形なら、その HEAD が今の HEAD のときだけ数え、
  合図を見た後に HEAD が動いたら検証をやり直す。次に、**この呼び出しの検証の開始時刻**（ログの `Verifying: <WT> (run <id>)` の run を `verify show <id> --json` で読む。
  worktree の最新の run（`verify history --limit 1`）は使わない。その間に別の run が始まっていることがある、#3883）と
  最後のターン終了（`capture --json` の `lastStopEventAt`）と最後のコミットの時刻と作業ツリーを比べる。検証の開始の後にコミットがあるか、
  最後のターン終了より前に始まって作業ツリーに変更があれば、検証は途中の状態を見ているので `verify "$WT" --task "$TASK_ID"` でやり直し、
  その結果を記録する。時刻が読めないときは推測せず、記録の要約に `run-start=unknown` / `last-stop=unknown` と残す
- **検証が `already in progress` で始められないとき**（再指示の前の古い run がまだ動いている、#3883）: その run（`(run <id>)`）が `running` でなくなるまで
  30 秒ごとに `verify show` で待ち（3600 秒まで）、検証を始め直す（3 回まで）。裁定はこの呼び出しが始めた run のもの。記録の要約に `waited-for=run <id>` と残す
- **実行ごとのファイル**（#3883）: ログは呼び出しごとに新しい名前を排他的に取る（1 回目は `wait-<issue>.log`、同じ work item の 2 回目からは `wait-<issue>.a<n>.log`。
  `--item <名前>` を付けると `wait-<issue>-<名前>.log`）。`.verify.log` / `.reverify.log` / `.exit` はその名前から作るので、同じ Issue の 2 本の PR や
  再試行がログと終了コードを取り合わない（`.exit` にはこの呼び出しだけが知る印が付き、ほかの書き手の `.exit` は読まない）。既にある `--log` を渡すと exit 2。
  記録には work item（`item`）と execution key（`key`）が入る（docs/orchestrate/run-log.md#1-5-同じ-issue-の複数の-prwork-item）
- **Auto-Yes を切った後の読み返し**: `capture --json` が読めないときは「切れた」とせず読み直す。最後まで読めなければ `auto-yes=unknown`（#3883）
- **実行の入力の manifest**（#3883 H-8）: env-clean は `$HOME` 直下のエントリの増減を見るが、既にあるファイルの中身は見ない。
  呼び出しの開始・各検証の開始の直前・裁定の後に、`~/.claude/settings.json` の `model`、worktree の `.claude/settings.local.json`、
  `package-lock.json` の hash、`node_modules` の所在（実体のパス・リンクか）と package.json の直接の依存の版を読み（`env-manifest.mjs`。HOME 全体は辿らない）、
  ログと同じ名前の `.env.json` に execution key と一緒に残す。**最後の検証の開始から裁定までに変わっていれば裁定しない**（exit 3、
  `unconfirmed: the inputs changed during the verification (<項目>)`。2 つの環境にまたがった結果なので、どちらの環境の合格にもしない）。
  作業中に変わったものは記録に `env-changed=<項目>` と残し、裁定は終わりの manifest（`env=<hash>`）の環境での結果として扱う。
  **どの呼び出しも `wait --verify` を使わない**（#3883 N8）: `wait --verify` は CLI の中でターン終了の行を出した直後に検証を始めるので、
  その前に manifest を取れない（ログを後から読んで取ると、検証の始まりの後の値になる）。task を見張らない呼び出しも `--verify` なしの `wait` → manifest → `verify` に分ける
- **合格を使う地点も環境を照らし合わせる**（#3883 N3）: precheck の「verify が通したゲートを省く」と、publish-pr / merge-pr の記録の確認
  （`pr-common.mjs` の `missingRecords`）は、verify の記録の `env=<hash>` の manifest（同じ execution key の `.env.json`）を今の worktree の manifest と比べる。
  違えば省かない・公開もマージもしない（`verify: environment changed — … verify again`）。`env=` があるのに manifest が run のフォルダに無いときも同じ（`missing`）。
  HEAD が verify の HEAD より進んでいる（6-2 の develop 取り込み・6-4 の一本化）ときに lockfile と依存の版を比べないのは、
  **今の HEAD の precheck が今の環境で通っている**（その precheck の manifest も今と同じ）ときだけ（#3883 N9）。HEAD が違うことだけでは外さない。
  git の外の入力（モデル・settings・`node_modules` の所在）はいつも比べる。
  merge-pr はこの「依存だけの差」で先に止めず（#3883 N10）、今の HEAD の precheck を走らせてから、合格したときだけ verify の環境を判定し直す
  （develop の取り込みで lockfile が変わり precheck が一度落ちた後の再試行で、precheck がやり直される）。precheck が落ちれば止まり、
  モデル・settings・`node_modules` の所在の差は precheck を走らせる前に止める（verify をやり直す）。
- **precheck の結果も環境に結び付ける**（#3883 N9）: precheck.mjs はチェックの前後に manifest を取り、`precheck-<…>.env.json` に
  key（`<run>:<work item>:precheck-<sha>:a<n>`）と残し、記録に `key=… env=<hash>` を足す。チェックの最中に入力が変われば `fail`
  （`env-changed-during-precheck=<項目>`）。同じ HEAD・同じオプションの ok の記録を再利用する早期 return、publish（`missingRecords`）、
  merge の「その HEAD の precheck は済み」の判断は、その manifest を今と比べ、違えば・manifest が無ければ precheck をやり直す。`env=` の無い旧い precheck の記録は警告して従来どおり使う
  **`env=` の無い記録**（H-8 より前の記録。この変更が入ったときに進行中の run の記録）は従来どおり使い、`warning: verify at <sha>: no env= in the record …` を出す
- **`--instance` はサーバーが解決した id で通す**（#3587）: 最初に `GET /api/worktrees/<WT>/resolve-target?instance=<指定>`（`wait` / `capture` / `send` と同じ権威。
  primary 優先・大小文字・alias の段は route のとおり）を、ほかの呼び出しと同じ `--cli` の `reply <WT> --instance <指定> --json` 越しに引き（#3633。
  `.env`・`CM_BIND`・HTTPS で決まる接続先も、`--cli` のラッパーの設定も同じになる）、待機・検証・task の比較・`capture`・Auto-Yes（`--auto-yes-off` も）の
  すべてにその id を使う。解決できない（曖昧な alias・サーバーに届かない・CLI が起動できない）ときは **exit 2** で、何も送らず待たない
- **新しい task が来たら裁定しない**（#3587）: 開始時に `commandmatedev task list "$WT" --json` を読み、渡された task（`--task`。無ければ
  その instance の、呼び出しの開始までに作られた最新の task）が一覧にあれば、
  **`--verify` なしの `wait` → 新しい task の確認 → `verify "$WT" --task <task> --instance <id>`** で、検証を始める直前をスクリプトが握る
  （`wait --verify` は CLI の中で検証を始めるので、その前に割り込めない。`--instance` は `wait --verify` と同じ裁定にするため渡す。OpenCode の作業証跡は
  instance ごとに読まれる）。開始時の一覧が読めないときも分けて見張り、一覧が読めた時点で基準を取り直す（それまでに読めなければ `--task` が無い限り
  `verify` は task をサーバーに任せる）。一覧が読めて task が無いときは、新しい task の確認はしないが、同じく `wait` → `verify` に分ける（#3883 N8）。
  `--task` が一覧（新しい順に 20 件）の外にあるときは `task show <task> --json` で個別に読み、作成時刻で比べて見張りを続ける（開始時も、一覧が読めた時点で基準を取り直すときも）。
  開始時の一覧の照会が失敗したら、`wait` を始める前に 5 秒おきに読み直す（3 回まで）。`wait --verify` が待ち始める前に task を結び付けるのと同じく、待ち始めの task に `verify --task` を結び付けるため（#3633）。
  確認は、待機中（30 秒ごと）・`verify` の直前（再検証の前・Antigravity の合図待ちの周回も）・検証が終わって裁定を確定する前（Auto-Yes を切る前）に
  一覧を引き直して行う。同じ instance の、基準の task より新しい task（基準が一覧にあれば一覧の順序で決めるので、同じ時刻でも後に作られたものは新しい。
  無ければ作成時刻で比べる）があれば、古い task では検証せずに（または検証の結果を使わずに）**exit 3** で抜ける。記録は `fail`、要約は
  `unconfirmed: a newer task <新しい task id> was created for this instance after task <古い task id>; … auto-yes=kept`。
  ワーカーは新しい task を作業中なので Auto-Yes は切らない。新しい task で `wait-verify.mjs --task <新しい task id>` を呼び直す。
  一覧の照会は 15 秒で打ち切り、読めない・時間切れ・起動の失敗のときはその回の確認を飛ばす（待機と timeout の判定は止めない）。
  確認が例外で落ちたときも待機中の `wait` は止めてから終わる

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
