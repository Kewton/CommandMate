---
name: orchestrate-monitor
description: /orchestrate のワーカー監視レシピ（capture 解析・状態判定・介入判断・完了検証）を、bash 3.2 互換の実行可能スクリプトと fixture ベーステストとして資産化したもの。並列ワーカーを監督するときに使う。
allowed-tools: Bash(.claude/skills/orchestrate-monitor/scripts/*), Bash(git worktree list), Bash(tmux *)
---

# orchestrate-monitor

`/orchestrate`（`/pm-auto-issue2dev` の並列運用）で実証済みの**ワーカー監視レシピ**を、
オペレータ／セッションメモリに滞留していた暗黙知から取り出し、**テスト済みスクリプト**にしたもの。
判定ロジック（生成中判定・STARTED ガード・prompt 分類・完了検証）は fixture ベースの単体テストで
固定されているので、プロンプトから再発明するのではなく、この中核を移植して使える。

> **なぜ Skill 化するか**: 監視ノウハウは実運用の失敗から学ばれたが、バージョン管理外にあり再現・移転不能だった。
> 同種の誤報（未起動 idle の COMPLETE 誤報／検証ガード自身の偽陽性）が複数回再発したため、テストで封じる。

## 構成

```
.claude/skills/orchestrate-monitor/
├── SKILL.md
└── scripts/
    ├── monitor-lib.sh       # 共有ヘルパー（JSON scalar 抽出・ANSI 正規化・アンカー検出・違反カウント・介入先セッション導出）
    ├── classify-state.sh    # capture --json 1 ポーリング → 状態トークン
    ├── verify-completion.sh # タスク状態を一次ソースとする完了判定（＋STARTED ガード、回帰#1）
    ├── verify-scope.sh      # 偽陽性しないスコープ検証（回帰#2）
    ├── quality-gate.sh      # exit code を実測する品質ゲート
    ├── monitor.sh           # オペレータ用監視ループ（temp ファイル状態）
    ├── hooks-git.sh         # 作業量フックの参考実装（worktree-id → 実 checkout の commit / 変更数）
    └── hooks-task.sh        # タスク状態フック（worktree-id → 実行契約の裁定済みステータス）
```

テスト: `tests/unit/skills/orchestrate-monitor/`。fixture は**実 `capture --json` を採取した生 payload
（ANSI エスケープを含む）**で、`fixture-fidelity.test.ts` が ANSI の残存を CI で強制する
（ANSI を剥がした fixture は「製品が出力しない形」を検証してしまう＝回帰#3 の再生産）。
`npm run test:unit` に含まれ、`bash -n` 構文チェックも `syntax.test.ts` として同梱される。

## 使い方

```bash
# 1 つ以上の worktree-id を監督する（フラグ無しで正しいセッションへ介入する）
CM="npx commandmate@latest" \
  .claude/skills/orchestrate-monitor/scripts/monitor.sh \
  --interval 20 --idle-threshold 8 <worktree-id> [<worktree-id> ...]

# 既定インスタンス以外を見るときだけ <worktree-id>@<instance-id> で指定する
.claude/skills/orchestrate-monitor/scripts/monitor.sh w1 w2@codex-2

# 中核だけを個別に使う（Claude が監督中に呼ぶのはこちら）
commandmate capture <id> --json > poll.json
.claude/skills/orchestrate-monitor/scripts/classify-state.sh --json poll.json
#   -> NOT_RUNNING | RATE_LIMIT | GENERATING | PROMPT | IDLE
```

判定順（`classify-state.sh`）。**順序自体がガード**であり、各分岐は入力注入か抑止のどちらかを
引き起こすので、早すぎる発火は健全なセッションを壊す:

```
NOT_RUNNING → is_retrying(→GENERATING) → PROMPT → GENERATING → RATE_LIMIT → IDLE
```

### 介入先セッションは**導出**する（#1601）

介入（承認 Enter / rate limit の `a` / 再送）は `tmux send-keys` で撃つ。その宛先は**フラグではなく
そのポーリングの capture ペイロードから導出**される:

```
mcbd-<cliToolId>-<worktree-id>[-<instance suffix>]      # getSessionName() と同じ組み立て
```

`cliToolId` は capture --json のトップレベルフィールド（＝**サーバがそのポーリングで解決したツール**）
なので、**分類したペインと介入するペインが一致することが構造的に保証される**。claude と codex が
混在するフリートでもフラグは要らない。解決結果はワーカーごとに 1 回
`monitor[<wid>]: intervention target = <session>` として stdout に出る。

- **`<worktree-id>@<instance-id>`**: 既定インスタンス以外を見るときに使う。capture 側（`--agent` /
  `--instance`）と送信先セッションの**両方**を切り替える。同じ worktree を別インスタンスで 2 行
  並べてよい（状態とログのキーは `<id>@<instance>`）。instance id からエージェントを復元して
  `--agent` を付けるのは、サーバが `--agent` 省略時に worktree 行の既定ツールで解決するため
  （instance id からは解決しない）。
- **`--session-prefix` は後方互換の逃げ道**。渡すと導出された `mcbd-<cliToolId>` の頭だけが置き換わる
  （instance suffix は付いたまま）。本ツールが作っていないセッションを見るとき以外は不要。

> **#1601 で直したもの**: 既定が `SESSION_PREFIX="cm"` だったため、送信先は**一度も存在したことのない**
> `cm-<worktree-id>` だった。しかも 3 箇所すべてが `2>/dev/null || true` で失敗を握り潰し、ログは送信の
> **前**に「送った」と出していたので、**空振りが成功に見えていた**。承認カウンタも送信前に加算していたため
> **一度も承認していないのに `approvals=` が増えた**。現在は `tmux has-session` で存在を検証し、
> **失敗は stderr に `NOT delivered` として報告**、ログとカウンタは**配信できたときだけ**動く。
> 宛先は `=<name>:`（exact match、#1156）で撃つ。素の `-t <name>` は前方一致にフォールバックし、
> 停止中の primary 宛の入力が `-2` インスタンスへ流れ込む。

`--resend-message` / `--max-resends` はリトライ枯渇死からの再送設定（既定 `continue` / 2 回）。
`--max-polls N` は N 回ポーリングしたら（ワーカーが未完了でも）exit 0 で抜ける停止条件。既定 0 =
全ワーカーが COMPLETE になるまで回り続ける（運用時の挙動は従来どおり）。判定ロジックには一切
関与せず、ループを外部から kill せずに決定論的に終わらせるためのもの（#1527 の単体テストと、
`--max-polls 1` の 1 回だけ様子を見るプローブで使う）。

### 監視が生きているかを外から見る（#1728）

**「静かなのは健全だから」と「静かなのは監視が死んだから」を区別できること。** 2026-08-06 に、
起動行 1 行だけを出した監視が約 25 分後に exit 144 で沈黙終了し、その間ワーカー 2 本は
正常稼働のまま**無監視**だった。判定ロジックは何も変えずに、次の 3 つを足してある。

| 何が出るか | どこへ | いつ |
|---|---|---|
| `monitor: alive (poll=<n>, complete=<d>/<total>)` | stdout | `--heartbeat N` ポーリングごと（既定 10、`0` で無効） |
| `monitor: ERROR caught SIG<name> (signal <n>) on poll round <r> — monitoring stops here` | stderr | HUP / INT / QUIT / PIPE / TERM 受信時。exit は `128+n` |
| `monitor: WARN caught SIGURG on poll round <r> — ignored, monitoring continues` | stderr | SIGURG 受信時（**致死化しない**。既定動作が無視なので、届いたことだけを見えるようにする） |
| `monitor: ERROR exiting on poll round <r> with <d>/<n> worker(s) complete (rc=<rc>) — the rest are now UNMONITORED` | stderr | 正常終了（全 COMPLETE / `--max-polls` 到達）**以外**の全ての終了 |

最後の 1 行は EXIT trap にぶら下がっているので、**個別に trap していない死に方でも出る**のが要点。
引数検証で落ちる経路（不正な id・`--hooks` のファイル欠落）は trap の設置前なので従来どおり
1 行のまま。144 = 128 + 16 で macOS の signal 16 は SIGURG だが、SIGURG は既定で無視されるため
`monitor.sh` 自身が受けて死んだとは限らない（`cmd | grep …` のパイプラインの `$?` は
**grep の終了コード**である点にも注意）。再現条件は未特定のまま、次に起きたときに原因が
ログへ残るようにしてある。

### `--verbose`: ポーリングごとの状態ログ（#1533）

既定の stdout は**介入・介入先セッション・capture 失敗・終局判定（COMPLETE / VERIFY_FAILED / NOT_STARTED）・起動/停止**だけで、
「何回ポーリングして各状態が何回出たか」は残らない。`--verbose` を付けると 1 ポーリング 1 行の
固定フォーマットが追加される（**opt-in。付けない限り既定出力は 1 バイトも変わらない**）:

```
monitor[<wid>]: poll <N> -> <STATE> started=<0|1> streak=<n> commits=<n> uncommitted=<n> verdict=<VERDICT> [task=<status>]
```

`<STATE>` は `classify-state.sh` の出力、`<VERDICT>` は `verify-completion.sh` の出力、間の
key=value は**その判定に実際に渡した入力**。だから「なぜ COMPLETE にならないのか」を
verdict だけでなく根拠つきで読める。集計はそのまま awk / sort に流せる:

```bash
# 状態分類の分布
grep -oE 'poll [0-9]+ -> [A-Z_]+' monitor.log | awk '{print $4}' | sort | uniq -c
# 総ポーリング数（worker 別）
grep -cE '^monitor\[w1\]: poll ' monitor.log
# タスク状態の分布（台帳が答えた poll だけが数えられる）
grep -oE 'task=[a-z_]+' monitor.log | sort | uniq -c
```

`task=` は**台帳が答えたときだけ末尾に付く**（#1613）。契約なし委任・フォールバックモードの
poll 行は `task=` を持たず、台帳導入前と 1 バイトも変わらない。`task=-` のような
「読んでいないのに読んだ形をした値」を証拠ストリームに出さないため。裏を返せば、
**終局判定の poll 行に `task=` があるかどうかが「裁定由来か推定由来か」の判別子**になる。

### `--hooks` / `MONITOR_HOOKS`: 完了フックの配線（#1533）

`monitor.sh` の `count_commits` / `count_uncommitted` は**既定でスタブ（常に 0）**。ループ単体で
動かすための既定値だが、`verify-completion.sh` は `commits=0 かつ uncommitted=0` を
**「タスクが送られていない」兆候**として扱う（STARTED ガード、下記 7）ため、**素の実行では
COMPLETE 分岐に到達しない**。実運用では必ずフックを供給する:

```bash
# 同梱の参考実装をそのまま使う
MONITOR_HOOKS_BASE=origin/develop \
  .claude/skills/orchestrate-monitor/scripts/monitor.sh \
  --hooks .claude/skills/orchestrate-monitor/scripts/hooks-git.sh <worktree-id> ...

# env でも指定できる（両方あればフラグが勝つ）
MONITOR_HOOKS=.../hooks-git.sh .../monitor.sh <worktree-id> ...
```

指定されたファイルは**スタブ定義の後に source** される。定義した関数だけが上書きされ、片方だけ
定義したファイルでももう片方はスタブのまま動く。指定したのにファイルが無い場合は
**exit 2 で即座に失敗**する（黙ってスタブに落ちると「全 worker が NOT_STARTED」という
一見もっともらしい嘘の観測になるため）。

**`--hooks` は繰り返し指定でき、左から順に source される**（フラグを1つでも与えると
`MONITOR_HOOKS` の既定は捨てられる）。契約付き委任では作業量とタスク状態の両方が要るので、
`hooks-git.sh` と `hooks-task.sh` を並べて渡す（下記「タスク状態を一次ソースにする」）。

`hooks-git.sh` は worktree-id を `git worktree list --porcelain` から実 checkout に解決し、
`git -C <path> log --oneline <base>..HEAD` と `git -C <path> status --porcelain` で数える。
`MONITOR_HOOKS_BASE`（既定 `origin/develop`）/ `MONITOR_HOOKS_REPO`（既定 `.`）/
`MONITOR_WORKTREE_ROOT` で調整する。base ref が解決できない場合は起動時に stderr へ警告する
（黙って 0 を返すと、全部コミット済みの worker が uncommitted=0 と合わさって最後に
NOT_STARTED と誤報されるため）。

#### id の突合順（#1728）

| # | 突合対象 | 由来 |
|---|---|---|
| 1 | `slug(basename(<checkout path>))` | **現行**。`deriveWorktreeId()`（`src/lib/git/worktree-id.ts`、#1621）＝ ディレクトリ名。初回登録時に一度だけ確定するので、ブランチを切り替えても id は変わらない |
| 2 | `slug("<repo>-<branch>")` | 旧 `generateWorktreeId()`（`src/lib/git/worktrees.ts`）。`<repo>` はメイン worktree のディレクトリ名 |
| 3 | `slug("<branch>")` | 同上（repo 名なし） |

**1 が欠けていたのが #1728 の本体**である。2・3 しか無い状態では、ディレクトリをブランチ名では
なく Issue 番号で採番するリポジトリ（`commandmate-issue-1728` / `fix/1728-…`）では**1 件も**
解決できず——**メイン worktree すら解決できず**——すでにコミット済みの worker まで
`commits=0 uncommitted=0` として報告されていた。#1614 が塞いだのは「git が失敗する」経路で、
こちらは **git は成功して突合が外れる**別経路である。verify-completion.sh は
`commits=0 && uncommitted=0` を「タスクが composer から出ていない」の署名として読むので、
STARTED ガードは**誰も測っていない数字**で裁定していたことになる。

1 を先に見るのは、稼働中のサーバが配る id が 1 だからである（2 と 3 の両方が別 checkout に
当たったときは 1 が勝つ）。1 は `branch` レコードを持たない detached HEAD にも効く。

ディレクトリ名が衝突している 2 つの checkout（CommandMate 側は mint 時に
`<base>-<sha256[0:8]>` で解決している）は、この走査では区別できない。最初の 1 件を数えたうえで
`WARN` を出すので、別の checkout を数えたい場合は `MONITOR_WORKTREE_ROOT` を指定する。

**git が答えられなかった場合と、worker が本当に何も書いていない場合は別物である（#1614）。**
`git worktree list` / `git log` / `git status` はいずれも終了コードを確認する。失敗したときの
カウンタ値は 0 のまま（`commits=0 && uncommitted=0` は verify-completion.sh を安全側＝
COMPLETE を出さない方向にしか倒さない）だが、**黙った 0 ではなく**、原因ごとに
**worker あたり 1 行**を stderr へ出す。毎ポーリング出さないのは base ref 警告と同じ理由である。

```
monitor hooks ERROR: [<wid>] 'git -C <repo> worktree list --porcelain' failed (exit 128); commit and change counts for this worker are UNKNOWN and reported as 0 — ...
monitor hooks ERROR: [<wid>] no checkout resolved in '<repo>'; both counters report 0 because nothing was measured, not because the worker did nothing ...
monitor hooks WARN:  [<wid>] 'git -C <path> log --oneline <base>..HEAD' failed (exit 129); the commit count is UNKNOWN and reported as 0
```

**レベル語（`ERROR` / `WARN`）は #1728 で入れた。** それまでは `monitor hooks: …` で始まり
`WARN` も `ERROR` も含まなかったため、運用でよく使う
`monitor.sh … 2>&1 | grep -Ei "STALL|IDLE|…|ERROR|FAIL"` で**1 行残らず消えていた**。
「この 0 は測定値ではない」と言う唯一の行が、ログの中で最も消えやすい形をしていたことになる。
**ログを grep で絞るときは `ERROR|WARN|alive` を必ずパターンに含めること。**

- `ERROR` = この worker については**何も測れていない**（両カウンタが答えの代わりに 0）
- `WARN` = 片方のカウンタだけが劣化し、もう片方は実測値（STARTED ガードには本物の信号が残る）

**「もう出した」の記録はファイルであり、置き場を PID で決めることはしない（#2119）。**
`monitor.sh` はカウンタを `$(...)` の subshell で呼ぶのでシェル変数では次のポーリングまで残らず、
マーカーは `$MONITOR_HOOKS_STATE_DIR/warned-<wid>.<cause>` というファイルである。置き場は 3 通り:

| 状況 | 置き場 | 掃除 |
|---|---|---|
| `MONITOR_HOOKS_STATE_DIR` を指定 | その値 | 呼び出し側の責任（`hooks-git.sh` は消さない） |
| `monitor.sh` から source | `monitor.sh` の `STATE_DIR` に相乗り | `monitor.sh` の EXIT trap が一緒に消す |
| どちらも無い（standalone） | `mktemp -d "${TMPDIR:-/tmp}/cm-monitor-hooks-XXXXXXXX"` | 自分で作った時だけ EXIT trap で消す（既に EXIT trap があるときは張らない） |

standalone は以前 `${TMPDIR:-/tmp}/cm-monitor-hooks-$$` だった。PID は再利用され（macOS は約 10 万で
周回）、`monitor.sh` を経由しない source は誰も掃除しないので、再利用 PID を引いた run が
**自分が書いていないマーカー**を見つけて本物の `WARN` / `ERROR` を黙って捨てていた
（実測 2026-08-27: `$TMPDIR` に 4129 ディレクトリ / 4214 マーカーが堆積し、キーはすべて
次の run が出そうとするものだった）。`mktemp -d` は既存の名前を返さないのでこの誤抑止は起きない。
EXIT trap を条件付きにしているのは、bash の EXIT trap が 1 本しかなく、source されたファイルが
無条件に張るとオペレータ自身の後始末を黙って潰すためである。

worktree path の解決が失敗すると**両カウンタが同時に 0 へ沈む**ので、id が解決できないケースも
同じ粒度で報告する。なお数え方は `printf '%s' "$out" | grep -c . || true` である:
終了コードを見るために出力を変数へ受けると `$()` が末尾改行を落とすため、`wc -l` は
1 件を 0 と数える（bash 3.2.57 実測）。`|| echo 0` は 0 件で `"0\n0"` になるので使わない。

### タスク状態を一次ソースにする（#1581）

`send --contract` で委任した worktree では、サーバが検証ゲートを回してタスクに**終局ステータス**を
記録する。これは裁定結果であって推定ではないので、**完了判定の一次ソースはこちら**であり、
capture のテキスト解析は契約無しの委任と未終局タスクのためのフォールバックに降格する
（#1539 設計原則 4「文字列解析の降格」）。

```bash
.claude/skills/orchestrate-monitor/scripts/monitor.sh \
  --hooks .../hooks-git.sh --hooks .../hooks-task.sh <worktree-id> ...
```

`hooks-task.sh` は `commandmate task list <worktree-id> --limit 1` を引く。**task id は要らない**
（`send --contract` が stdout に出す id を監視ループへ渡す必要がない）: `task list` は worktree だけで
答えられ、新しい順に返すので 1 行目が実行中の契約である。API（`GET /api/worktrees/:id/tasks`）でも
同じ情報は取れるが、シェルからは CLI の方が素直（base URL と認証トークンの解決を CLI が持っている）。

| タスク状態 | verdict | 意味 |
|---|---|---|
| `succeeded` | `COMPLETE` | ゲート合格。work-evidence もサーバ側で済んでいるので commit 数の裏取りは不要 |
| `failed` / `cancelled` | `VERIFY_FAILED` | 終局だが**マージ不可**。`commandmate verify <id> --json` で失敗ゲートを見て再指示 |
| `not_started` | `NOT_STARTED` | 作業証跡ゼロ |
| `pending` / `running` / `waiting_input` / `verifying` | （フォールバック） | 未終局。capture ヒューリスティクスが判定する |
| 空 / 未知 | （フォールバック） | 契約無しの委任・未知の出力形式。**必ず従来動作に落ちる**（勝手な verdict を作らない） |

2 つの落とし穴を明示的に塞いでいる:

- **`COMPLETE` ≠ 「終わった」**。`VERIFY_FAILED` を別トークンにしたのは、「ワーカーが止まった」と
  「成果物が正しい」を同じ信号として読まないため。これが #1539 が exit code に移した当のもの。
- **生存中のペインは終局ステータスに勝つ**。`task list --limit 1` は最新のタスクを返すので、
  過去の契約のあとに素の send をした worktree では古い裁定を読みうる。`verify-completion.sh` は
  `GENERATING` / `PROMPT` / `RATE_LIMIT` を**タスク状態より先に**評価してこれを拒否する。

> **monitor の COMPLETE をマージ可否の裁定に使わないこと。** 契約付き委任の最終裁定は
> `commandmate wait <id> --on-prompt human --verify` の exit code（`0` 合格 / `20` 検証不合格 /
> `21` 作業証跡ゼロ）である。monitor は「いつ見に行くか」を決める道具であって、合否を決める道具ではない。

#### タスク状態が読めないとき（バージョンゲート、#1613）

`hooks-task.sh` を配線したのに台帳を引けなかった場合、monitor は worker ごとに**1 度だけ**
次を出してからフォールバックモードで走る。**黙って劣化しない。**

```
monitor[<wid>]: task state unavailable (CommandMate without 'commandmate task', server down, or unknown worktree) — FALLBACK MODE: completion is inferred from capture, not adjudicated. Diagnose with: commandmate task list <wid> --limit 1
```

`read_task_status` の答えは 3 値である。**空（台帳が答えた／この worktree に契約は無い）と、
`unavailable`（台帳に訊けなかった）を同じ値にしない**のがこの分岐の要点で、以前は両方が空に
潰れていたため、完了判定の一次ソースが丸ごと消えてもログは正常時と同じだった。

`$CM task list` の**終了コード**で判定する（stdout の中身ではない）。develop `a46845c7` 実測:

| 条件 | 挙動 | `read_task_status` |
|---|---|---|
| worktree をサーバが知らない | exit 99 / `Resource not found. Check the worktree ID.` | `unavailable` |
| サーバ未起動 | exit 1 / `Server is not running. Start it with: commandmate start` | `unavailable` |
| 既知 worktree・タスク 0 件 | **exit 0** / notice は stderr、stdout は空 | 空（＝正常。契約なし委任） |

**「stdout が空だから異常」にしてはいけない**のは最後の行のため。`task` 未実装の CommandMate
（`src/cli/commands/task.ts` は develop にのみ存在。v0.15.0 / v0.16.0 には無い）も非 0 で落ちるので
`unavailable` に入る。なお `commandmate task --help` は判別に使えない（旧版はルートヘルプを出して
exit 0 になる）。実サブコマンドを叩く必要がある。

`unavailable` は **TaskStatus ではない**。`verify-completion.sh` は未知値を fallthrough するので、
この値を知らない版に渡っても裁定には使われずヒューリスティクスに落ちる。monitor 側は 1 度報告した
あと空へ落として扱うが、**ポーリング自体は続く**ので、復帰したサーバは次の poll から拾える。
`hooks-task.sh` を配線しなければこの行は出ない（契約なし委任として従来どおり動く）。

### #1513 G2 の証拠採取レシピ

G2（「監視の誤報 0 を実運用で示す」）が要求する 4 点 —— **総ポーリング数・状態分類の分布・介入全件・
完了判定の根拠** —— は、この 1 コマンドで 1 本のログに揃う:

```bash
MONITOR_HOOKS_BASE=origin/develop \
.claude/skills/orchestrate-monitor/scripts/monitor.sh \
  --verbose \
  --hooks .claude/skills/orchestrate-monitor/scripts/hooks-git.sh \
  --interval 20 --idle-threshold 8 \
  <worktree-id> ... 2>&1 | tee monitor.log
```

`2>&1` は必須。**未配信の介入は stderr に出る**（stdout は「起きた介入」だけの流れなので、
届かなかった介入をそこに混ぜない）。落とすと「介入 0 件」と「介入が全部失敗」が区別できない。

| G2 の要求 | ログからの取り出し方 |
|---|---|
| 総ポーリング数 | `grep -cE '^monitor\[<wid>\]: poll ' monitor.log` |
| 状態分類の分布 | `grep -oE 'poll [0-9]+ -> [A-Z_]+' monitor.log \| awk '{print $4}' \| sort \| uniq -c` |
| 介入全件 | `grep -E "sent 'a'\|resent to\|resend budget spent" monitor.log`（承認 Enter はサイレント。総数は COMPLETE 行の `approvals=` に出る。**未配信は `grep 'NOT delivered'`** で別に数える） |
| 完了判定の根拠 | poll 行の `started= / streak= / commits= / uncommitted= / verdict= / task=`。COMPLETE した poll 行がその worker の判定根拠そのもの |
| 判定が一次ソース由来かフォールバック由来か | 終局判定の poll 行に `task=` があるか／`FALLBACK MODE` 行が出ているか |
| capture 失敗 | `grep -c 'capture failed' monitor.log`（poll 行は出ないので、総ポーリング数と別に数える） |
| helper 失敗（#1614） | `grep -cE 'classify-state failed\|verify-completion failed' monitor.log`。いずれもそのポーリングを捨てる（poll 行は出ない）。**0 でなければ判定を下せなかったポーリングがある**ので、誤報 0 の主張はその分だけ弱い |
| カウンタが信用できないポーリング | `grep -E 'monitor hooks (ERROR\|WARN):' monitor.log`（worker あたり 1 行。出ていれば `commits=` / `uncommitted=` の 0 は「測れなかった」であって「作業ゼロ」ではない。`ERROR` は両カウンタ、`WARN` は片方だけ） |
| 監視が最後まで生きていたか | `grep -E 'monitor: (alive\|ERROR\|WARN)' monitor.log`（`alive` が途切れた所が最後に生きていたポーリング。終端に `caught SIG…` / `exiting on poll round` があれば異常終了） |

**`--hooks` を付け忘れると誤報 0 は測れない**：commits/uncommitted が常に 0 になり、完走した
worker まで NOT_STARTED として記録される。G2 のログは必ずフック付きで採ること。

---

## 監視レシピと根拠（どの失敗から学んだか）

各ルールは実運用の失敗に紐づく。カッコ内はセッションメモリの出所。

### 状態検知（`classify-state.sh` / `monitor-lib.sh`）

1. **主シグナルは `commandmate capture <id> --json`**。参照フィールドは `content` / `realtimeSnippet`。
   `output` / `text` は**存在しない**（`src/lib/session/current-output-builder.ts` の payload で確認）。
2. **アンカー照合は ANSI 除去後に行う**（`ml_strip_ansi`）。実 TUI は矢印と数値の間に色リセットを挟む:
   `(4m 25s · ↓\u001b[39m \u001b[38;5;246m14.9k tokens`（`\u001b` は生 JSON 中の 6 文字） → 生 JSON への `↓ [0-9]` grep は**実機で一度も
   発火しない**。#1512 の初版は ANSI を除去済みの手書き fixture を持っていたため単体テストだけが緑で、
   実運用では**全ワーカーが IDLE 誤分類**され `NOT_STARTED` を鳴らし続けた（Issue #1522 / 回帰#3）。
   TUI がマーカーと値の間に挟む**ノーブレークスペース**（`❯` の直後、`\u00a0`）も同じ理由で正規化する。
3. **アンカーは「いま画面に出ているもの」＝`realtimeSnippet` に限定する**（`ml_pane_text`）。
   `content` は *lastCapturedLine 以降の差分*なので、ループの初回ポーリングは**バッファ全体**＝
   orchestrator が送ったタスク指示文まで返す。その指示文に識別子 `ml_has_rate_limit` が含まれていたため
   `rate.?limit` が一致し、**健全な生成中ワーカー2件に `a` が撃ち込まれた**（Issue #1522 / 回帰#7）。
   逆向きの事故も同時に防ぐ：履歴に流れた spinner 行（`↓ 14.9k tokens`）を拾うと終了済みセッションを
   永久に GENERATING と誤判定する。
4. **生成中アンカーは 3 つ**：トークンカウンタ `↓ 14.9k tokens` / `Waiting for [0-9]+ background agent` /
   フッタヒント `esc to interrupt`。
   - `esc to interrupt` は**ターン実行中のみ**表示される（idle 時は `? for shortcuts`）。トークン出力前に
     数分思考するワーカー（`✳ Cascading… (19s)` にはカウンタが無い）を拾うための唯一の手段
     （回帰#4）。
   - `[0-9]+m [0-9]+s` は**使わない**：完了後の集計行 `✻ Brewed for 8m 55s` に誤マッチし、
     終了済みセッションを永久に「生成中」と誤判定する（`feedback_orchestrate_monitor_recipe`）。
     → 回帰 fixture: `idle-brewed-summary.json` は IDLE に分類される。
   - **`isGenerating` フィールドに依存しない**：これは `sessionStatus==running && thinking_indicator` の
     狭い条件でしか true にならず、生成中でも false になりうる。だから text アンカーを一次シグナルにする
     （`feedback_orchestrate_monitor_started_guard`）。→ fixture `generating-bg-agent.json` は
     `isGenerating:false` でもアンカーで GENERATING。
5. **CLI 自身のリトライ中（`ml_is_retrying`）は「生存」＝ GENERATING**。
   `✻ 529 Overloaded · Retrying in 4s · attempt 7/10` の間セッションは生きているので、介入は**再開でなく
   queue** される（実測: `❯ a` が composer に残り `Press up to edit queued messages`。リトライ成功後に
   配信され、ワーカーが契約外の作業を始めうる）。`rate-limit` 分岐より**前**に評価する（回帰#5）。
   - `attempt 10/10` は枯渇後も画面に残るため、**idle フッタ（`? for shortcuts`）を veto** に使う。
     これが無いと死んだセッションが永久に「生存」と読まれ、再送経路に到達できない。
6. **`RATE_LIMIT` は生成中を否定してから最後に評価し、アンカーはバナー固有の言い回しに限定する**。
   本物の usage limit は**ターンを停止させる**ので、`esc to interrupt` が出ているフレームのバナー風文字列は
   定義上ワーカーが読み書きしているコード／散文である。裸の `rate.?limit` は削除した：`rate_limit` /
   `rate-limit` を含むソースや散文に一致して**健全なワーカーへ入力を注入した**（Issue #1522）。これは
   `ml_count_violations` について既に明記していた「散文一致の誤報」と同型の失敗（回帰#7）。
7. **STARTED ガード**：生成アンカーを一度も観測していない idle を COMPLETE と誤報しない。
   `commits=0 かつ uncommitted=0` は**完了ではなく未起動の兆候**（`send` がタスクを composer に残し
   Enter 未確定で worker が起動しない）（`feedback_orchestrate_monitor_started_guard`）。
   → 回帰#1: `verify-completion.sh`、fixture 相当は `verify-completion.test.ts`。
8. **AskUserQuestion 停滞**：`❯ 1. Submit answers` は製品の prompt 検出（`isPromptWaiting`）に**非マッチ**。
   text marker `❯ [0-9]+\.` で PROMPT と判定する（`feedback_orchestrate_askuserquestion_and_ci_522`）。
   → fixture `prompt-submit-answers.json`（`isPromptWaiting:false` でも PROMPT）。
   **`PROMPT` は `GENERATING` より先に評価する**：権限プロンプト表示中もフッタは `esc to interrupt` のままで
   `isPromptWaiting` / `isSelectionListActive` は false（実測）。逆順だとプロンプトが永久に承認されない。

### 介入・自動復旧（`monitor.sh`）

9. **権限プロンプト自動承認**：worker 停滞の主因は Claude Code 権限プロンプト。Enter 自動承認を**サイレント＋
   カウンタ化**し、通知を氾濫させない（`feedback_worker_permission_prompt_autoapprove` /
   `feedback_orchestrate_monitor_recipe`）。承認は commit 必須ゲート（＝完了検証）とセットで扱う。
   **カウンタは配信できたときだけ動かす**（#1601）：送信前に加算すると、届かなかった承認まで
   `approvals=` に乗り、プロンプトで止まったままの worker が「承認済み」に見える。
10. **Rate limit は待たず即 "a" 送信**で再開。「1M context credits 必須」ブロッカーは credits 有効化＋"a"
    （`feedback_rate_limit_immediate_retry` / `feedback_orchestrate_1m_context_credits`）。
    ただし**撃つ前に GENERATING を否定する**こと（上記 6）。
11. **リトライ枯渇死からは再送で復帰する**（`--resend-message` / `--max-resends`）。`attempt 10/10` 失敗後は
    idle プロンプトに落ち、誰も再送しないので放置される。放置より悪いのは、作業途中の uncommitted 変更が
    残った状態で idle streak が閾値を超え **COMPLETE と誤報**されることなので、完了判定より前に再送する。
    入力を注入する分岐なので条件は最小に絞る（Issue #1522）:
    - `IDLE` のみ（＝リトライ中 `GENERATING` とプロンプトには絶対に触らない）
    - idle 閾値に到達済み（一瞬のフレームでは撃たない）
    - `ml_has_terminal_api_error` は**現在のペインのみ**を見る（再開後に画面外へ流れたエラーは対象外）
    - `--max-resends` で打ち切り、以後はオペレータへエスカレーション
12. **介入先は導出し、送信は結果を検証し、ログとカウンタは配信できたものだけを数える**（#1601）。
    固定 prefix の連結（旧既定 `cm-<worktree-id>`）は**実在しないセッション**を指し、`2>/dev/null || true`
    が失敗を握り潰し、ログは送信の**前**に出ていた——**空振りが成功として記録される**三点セット。
    - 宛先は capture ペイロードの `cliToolId` から `mcbd-<cliToolId>-<worktree-id>[-<suffix>]` を組み立てる。
      **分類したペインへ介入する**という不変条件はこれで構造的に保つ（既定値の変更では保てない：
      1 つの prefix は claude と codex の混在フリートにも `--instance codex-2` にも同時に一致しない）。
    - 送信前に `tmux has-session` で存在を検証し、**失敗は stderr に `NOT delivered` として報告**する。
    - 宛先は `=<name>:`（exact match、#1156）。素の `-t <name>` は前方一致にフォールバックし、
      `mcbd-claude-w1` 宛の入力が `mcbd-claude-w1-2` のペインへ流れ込む。
    - 再送予算は**配信できた再送だけ**が消費する。空振りで予算を使うと、実際には一度も再送していないのに
      「budget spent — operator needed」へエスカレーションする。
13. **完了待機は `commandmate wait <id> --on-prompt human`**。既定は prompt 検出で即返るため監督ループが
    空回りする（`feedback_orchestrate_wait_on_prompt_human`）。

### 完了検証（`verify-completion.sh` / `verify-scope.sh`）

14. **契約付き委任では完了判定の一次ソースはタスク状態**（`hooks-task.sh`）で、capture 解析は
    フォールバック。マージ可否の最終裁定は `wait --verify` の exit code であり、monitor の
    `COMPLETE` ではない。詳細は上記「タスク状態を一次ソースにする（#1581）」。
    **台帳が引けない環境では、worker ごと 1 度だけ `FALLBACK MODE` を報告してから推定モードで走る**
    （#1613）。arm 前に `CM=commandmate . .../hooks-task.sh; read_task_status <worktree-id>` を叩き、
    契約中の状態／契約なしなら空／引けないなら `unavailable` のどれが返るかを確かめること。
15. **merge 成否は state=MERGED を確認してから Issue close**（未マージ Issue の誤クローズ防止）
    （`feedback_orchestrate_changelog_conflict_close_guard`）。
16. **スコープ完遂は受入ゲートでなく grep 実数で検証**。NUL 混入ファイルで grep がバイナリ扱いするため
    `grep -a` を使う（`feedback_orchestrate_scope_completeness` / `reference_grep_blind_nul_test_file`）。
17. **検証ガード自身の偽陽性に注意**（回帰#2、`verify-scope.sh`）：
    - 禁止パターンが**散文・コメント中**に出現しただけで違反と数える誤報
      （bare `npx commandmate` が「なぜ @latest が必要か」を説明する文に一致した実例）。
      → コメント行（`^[[:space:]]*#`）を除外する。fixture `scope-clean.txt` は CLEAN。
    - `grep -c ... || echo 0` は無マッチ時に `0\n2` 相当の二行を作り数値テストを壊す
      （`feedback_sed_grep_guard_false_pass`）。→ `grep -c` の出力をそのまま使う。
    - grep 実数で under-delivery を疑ったら**必ず該当行を目視してから**差し戻す。

### スクリプト品質（実装制約）

18. **bash 3.2 互換**（macOS 既定の `/bin/bash` は 3.2.57）：連想配列 `declare -A` 不可・`mapfile` 不可・
    `${var,,}` 不可。状態は**整数 index の並列配列と temp ファイル**で持つ
    （`feedback_monitor_bash32_no_assoc_arrays`）。CI は `syntax.test.ts` が `bash -n` を回す。
19. **ループ変数に `path` 等の特殊名を使わない**：zsh/bash で `path` は `PATH` に tie され、curl/tmux が
    command not found 化して health check が偽陰性になる（`feedback_zsh_path_loop_var_clobbers_path`）。
20. **品質ゲートで exit code を隠さない**（`quality-gate.sh`）：`cmd | grep ...` は `$?` を grep に渡し
    非ゼロ終了を隠す。vitest は「全テスト緑・Unhandled Rejection で exit 1」を出しうる。
    `cmd > log 2>&1; echo $?` で実測する（`feedback_quality_gate_grep_hides_exit_code`）。
21. **`sed` は `LC_ALL=C` で回す**：ペイン capture には途中で切れたマルチバイト文字が混じりうる。
    UTF-8 ロケールの BSD sed はそこで `illegal byte sequence` を吐いて停止する。

---

## 回帰テスト（red→green で固定したパターン）

| # | 誤報／実害 | 出所 | ガード | テスト |
|---|------|------|--------|--------|
| 1 | 未起動 idle を COMPLETE と誤報 | `feedback_orchestrate_monitor_started_guard` | `verify-completion.sh` の STARTED ガード | `verify-completion.test.ts` |
| 2 | 検証ガード自身の偽陽性（散文一致・`\|\| echo 0`） | 同上 / `feedback_sed_grep_guard_false_pass` | `verify-scope.sh` のコメント除外＋素の `grep -c` | `verify-scope.test.ts` |
| 3 | ANSI 除去済み手書き fixture が「製品が出ない形」を検証し、生成中を全て IDLE 誤分類 | #1522 | `ml_strip_ansi` ＋ 生 capture fixture | `fixture-fidelity.test.ts` / `live-generating-token.json` |
| 4 | トークン出力前の生成中を IDLE 誤分類 | #1522 | 生成中アンカーに `esc to interrupt` | `live-generating-pre-token.json` |
| 5 | CLI 自身の 5xx バックオフを停止と誤認し、介入が queue される | #1522 | `ml_is_retrying`（idle フッタ veto つき）を最優先 | `live-retrying-529.json` / `monitor-lib.test.ts` |
| 6 | リトライ枯渇死が放置される／半端な作業で COMPLETE 誤報 | #1522 | `ml_has_terminal_api_error` ＋ `monitor.sh` の再送 | `live-api-error-exhausted.json` / `monitor-resend.test.ts` |
| 7 | `rate.?limit` が散文・ソースに一致し**健全なワーカーへ `a` を注入** | #1522 | バナー限定アンカー ＋ `RATE_LIMIT` を最後に評価 ＋ `ml_pane_text` | `live-idle-rate-limit-source.json` / `live-generating-task-text-scrollback.json` |
| 8 | `count_commits`/`count_uncommitted` がスタブ固定で、**COMPLETE 分岐が実運用で一度も発火しない**（完走した worker まで NOT_STARTED と記録される） | #1533 | `--hooks` / `MONITOR_HOOKS` で供給、参考実装 `hooks-git.sh` を同梱 | `monitor-observability.test.ts`（フック無しで COMPLETE 到達不能 ⇄ フック有りで到達、を両方向で固定） |
| 9 | **ゲート不合格の worker を COMPLETE と報告**（commit も idle streak も「完了」に見えるので、capture 由来の信号だけでは検証不合格と区別できない） | #1581 | タスク状態を一次ソースにし、`failed` / `cancelled` を `VERIFY_FAILED` として分離 | `verify-completion.test.ts` / `monitor-task-source.test.ts` |
| 10 | 古い契約の終局ステータスを現在の裁定として読み、**生成中の worker を COMPLETE と誤報** | #1581 | 生存ペイン（`GENERATING`/`PROMPT`/`RATE_LIMIT`）をタスク状態より先に評価 | `verify-completion.test.ts`（stale veto）/ `monitor-task-source.test.ts` |
| 11 | **介入が 1 回も届かないまま「送った」と記録される**（既定 prefix `cm` が実在しないセッションを指し、失敗は握り潰され、ログとカウンタは送信前に動いていた） | #1601 | `cliToolId` からのセッション導出 ＋ `has-session` 検証 ＋ 送信後ログ ＋ 配信時のみカウント ＋ `=name:` exact match | `monitor-session-target.test.ts` / `monitor-lib.test.ts`（導出）/ `monitor-resend.test.ts` |
| 12 | **完了判定の一次ソースを失ったまま推定モードで走り続ける**（`task list` の非 0 終了が「契約なし」と同じ空文字に潰れ、ログは正常時と区別が付かない） | #1613 | `read_task_status` を 3 値化（終了コードで `unavailable`）＋ worker ごと 1 度の `FALLBACK MODE` 報告 ＋ `task=` を値があるときだけ出力 | `monitor-task-source.test.ts`（exit 1 / exit 99 を空とは別ケースとして固定）/ `monitor-observability.test.ts` / `verify-completion.test.ts` |

| 13 | **外部コマンドの終了コードを見ずに次を決める**（`git \| wc -l` が git の失敗を「作業 0」として返し完走 worker を NOT_STARTED と誤報／`classify-state.sh` が落ちると空 state が verify へ渡り、生存ペインとみなされず**稼働中 worker が COMPLETE**／`verify-completion.sh` が落ちると `case` に default が無く**そのポーリングが無言で素通り**） | #1614 | hooks-git.sh の 3 つの git 呼び出しを終了コード判定＋worker あたり 1 回の stderr 報告に、`monitor.sh` の `CLASSIFY` / `VERIFY` を `capture`（既存）と同じ扱いに | `monitor-exit-codes.test.ts`（git 失敗と真の作業ゼロを別テストで固定、0/1/複数件の計数も固定） |
| 14 | **id の突合がブランチ名だけで、現行のディレクトリ由来 id を 1 件も解決できない**（git は成功するので #13 のガードは発火しない。両カウンタが恒久 0 になり、**STARTED ガードが実測値でない数字で裁定する**） | #1728 | `mh_worktree_path()` に `slug(basename(<path>))`（＝`deriveWorktreeId`、#1621）を第 1 候補として追加。ブランチ由来の旧 2 規則は残す | `hooks-git-resolution.test.ts`（**ディレクトリ名 ≠ ブランチ名**の repo を fixture にする。既存 fixture は `myrepo-x` / `feature/x` / id `myrepo-feature-x` ＝ 旧規則で作られており、この穴を構造的に検知できなかった） |
| 15 | **警告が運用の grep で全て消える**（`monitor hooks: …` に `ERROR`/`WARN` が無く、`grep -Ei "…\|ERROR\|FAIL"` で不可視。#14 が 25 分間気付かれなかった直接の理由） | #1728 | 診断行に `ERROR`（両カウンタ死）/ `WARN`（片方）のレベル語を付与 | `hooks-git-resolution.test.ts`（Issue 記載の grep パターンそのものに `toMatch` させる） |
| 16 | **監視が黙って死に、死んだことに気付けない**（exit 144・出力は起動行のみ・ワーカーは無監視で稼働継続。健全な沈黙と区別不能） | #1728 | 受信シグナルの明示報告 ＋ 正常終端以外の EXIT 報告 ＋ `--heartbeat`（既定 10 ポーリング） | `monitor-liveness.test.ts`（SIGTERM/SIGINT の文言と exit code、SIGURG が**致死化しない**こと、正常終端では何も足さないこと、heartbeat の間隔と既定値） |

いずれも naive 実装で red → ガード実装で green にした（#3〜#7 は #1512 の初版実装に対して red）。
#8 は両方向テスト（対照＋変異注入）で固定している：`--verbose` を既定 ON にする / フックをスタブより
先に source する / poll 行の書式を変える / 参考フックの commit 数を 0 固定にする、のいずれの変異でも
該当テストが実際に赤くなることを確認済み。
#11 も同じ方法で確認済み（既定を `cm` に戻す / `has-session` 検証を外して `|| true` に戻す /
承認カウンタを送信前に加算する / ログを送信前に出す / ツール id 一覧を欠落させる /
`=name:` を素の名前に戻す の 6 変異で、いずれも該当テストだけが赤くなる）。
#12 も同様（`hooks-task.sh` の `unavailable` 分岐を削る → 7 件 red / `monitor.sh` の
`unavailable` 処理を削る → 3 件 red / poll 行を `task=${task_status:--}` に戻す → 17 件 red）。
なお **`task list` を stdout だけで判定する実装は変異で捕まらない**ため、失敗する CLI にも
正常に見える行を stdout へ出させるケースを別に置いてある。
#13 も 7 変異で確認済み（`classify` ガード削除 → 2 件 red、しかも実際に
`poll 4 -> <空> ... verdict=COMPLETE` と `COMPLETE (approvals=0)` が出る／`verify` ガード削除 → 2 件 red／
hooks-git.sh を #1614 以前へ全戻し → 5 件 red／`git log` だけ・`git status` だけ・no-checkout 警告だけを
削る → それぞれ 1・1・1 件 red／`git worktree list` だけ削る → 2 件 red／数え方を `wc -l` に戻す → 4 件 red）。
**「git が失敗した」と「本当に作業ゼロ」は別テストが担保する**（後者は stderr が空であることを固定
しているので、前者の assertion では満たせない）。
#14〜#16 も 8 変異で確認済み（`hooks-git.sh`: basename 突合を削除 → **7 件 red**／突合順を
branch 優先へ反転 → 1 件 red／レベル語を `monitor hooks:` へ戻す → 4 件 red／
ディレクトリ名衝突の WARN を削除 → 1 件 red。`monitor.sh`: シグナル trap を #1728 以前へ全戻し →
4 件 red／heartbeat を毎ポーリング発火に → 4 件 red（うち 1 件は #1533 の**既定 stdout を
byte 単位で固定したテスト**で、既定 heartbeat が運用ストリームを汚していないことの対照でもある）／
EXIT 報告を正常終端でも出す → 2 件 red／SIGURG を致死 trap に → 1 件 red）。
**「監視が死んだ」を検知するテストは、監視が死んでも緑になりうる**ため、SIGURG のケースだけは
「SIGURG では死なず、後続の SIGTERM で死ぬ」ことを exit code で固定してある。

## fixture の作り方（実機採取）

fixture は**使い捨てセッションで capture** する。実 worker session は composer 残テキストで汚染され
流用不可（`feedback_orchestrate_sibling_fold_and_real_tui_capture`）。

```bash
commandmate capture <throwaway-id> --json | tee tests/unit/skills/orchestrate-monitor/fixtures/<name>.json
```

**手で書かないこと。ANSI を剥がさないこと。** これが本 Skill 唯一の致命的な失敗モードで、#1512 の初版は
実際にこれを踏んだ（単体テスト全 green のまま実運用では 1 度もアンカーが発火しなかった）。

- ステータス行・フッタ行・composer 行の ANSI エスケープと NBSP は**そのまま残す**。1 つ剥がすと fixture は
  「製品が出力しない形」になり、テストの意味が消える。`fixture-fidelity.test.ts` が CI で残存を強制する。
- 実 capture には**作業指示文・絶対パス・セッション ID** が載る。コミット前に無関係な本文だけを短いダミーへ
  置換する（ANSI を壊さないよう、値の文字列単位で差し替える）。
- 派生 fixture（実フレームの一部を差し替えて作った異常系）は、テスト側のコメントに**何を差し替えたか**を書く。
