# Issue #4367: チームの流れの計測・警報と人向けのダッシュボード（設計）

- 状態: **設計（上流の 2 回目、改訂 1）**。この文書だけを書き、`src/`・`scripts/`・`tests/` の試験は変えない。実装はこの文書のレビューの後、§6 の PR1a の契約から始める
- 改訂 1 は、1 回目（`b1e84d224`）への 2-4-4 事前レビュー（codex-2 `prereview-4367-reply.md`: 承認保留、P2 6 件 F1〜F6・P3）と、開発リーダーの再指示（`reinstruct-4367-design-1.md`）・突き合わせの決定（`s3-crosscheck.md` X1〜X7）を反映した。指摘ごとの処置は §14
- 正本: Issue #4367 の本文、Epic #4371 の本文（背景の実測）、段 3 の共通の枠（開発リーダーの決定、2026-11-14。`workspace/orchestration/runs/2026-11-14/s3-common-frame.md`。以下「共通の枠」）と突き合わせの決定（同じ dir の `s3-crosscheck.md`。以下「X1」〜「X7」）。本書はこれらと食い違わない。共通の枠に無いことを新しく決めたものは §11「他の子への約束」に集めた
- 基準: develop **`a334a013f`**（v0.51.1、2026-11-14 に `git fetch` した `origin/develop`）。file:line はこの版。行番号は古くなるので名前で引くこと
- 表記: **事実**＝コードを読んで、または読み取りのコマンドを実行して確かめたこと。**見立て**＝事実からの推論で、試していないこと。**未確認**＝この段で確かめていないこと。**未決**＝この設計では決めず、誰が決めるかを書いたもの（§13.3）
- 他の子（#4368・#4369・#4370）の設計本文は読んでいない。食い違いは突き合わせの決定（X1〜X7）に従う

## 結論（一覧）

| 段 | 中身 | 節 |
|---|---|---|
| 最上位の条件 | **I-0**: 各 repo／base／取得元について、対象期間を完全に観測できた値だけを確定値として記録し、未知を保ったまま、同時実行と再起動をまたいでもコミットした観測に対応する警報遷移だけを一度ずつ確定し、計測の失敗を既存の送信・検証・マージの許可へ転用しない | §1 |
| 不変条件 | I-0 を分けた 17 本（I-1〜I-17）。完全に観測できた値だけを確定値に・上限に当たったら未知・状態のキーは repo＋base（source-down は＋取得元）・tick は repo-slug ごとの排他・tick ID で冪等・期限の起点と予算と期限後の結果の破棄・最後の書き込みは高々 1 回・計測の結果を許可に使わない ほか | §1 |
| 記録の形 | `~/.commandmate/flow/<repo-slug>/<YYYY-MM-DD>.jsonl` に tick を 1 行（`tickId` つき）。`alerts.jsonl` に警報の出来事（`eventId`＝tick ID＋警報 id＋取得元）。値ごとに `complete`（完全性）を持ち、完全でない値は `null`。部分の参考値は `hints` に分けて警報の入力にしない | §2 |
| 状態と遷移 | 表 S0（排他）・S1（tick の段と期限）・S2（取得元 × 結果 → 値と完全性）・S3（警報の状態 × 入力 × 連続性）・S3R（落ちた後の再開）・S4（PM への送信。PR3、試行の記録つき） | §3 |
| 失敗の倒れ方 | 外部の呼び出し 11 種。計測は fail-open（未知として記録して続ける）、書き込み・警報の確定・送信は fail-closed。Docker だけは失敗を不応答の値として扱う。ローカルの I/O の無期限の停止は前提の外 | §4 |
| PR の切り方 | **PR1a**（計測: 設定・記録・取得・集計・tick・reconstruct・report・status、警報なし）→ **PR1b**（流れの警報 3 種＋source-down、状態を持つ部分）→ PR2（資源）→ PR3（PM への送信の経路だけ）→ PR4（#4368 の WIP・エージェント・#4370 の出来事・日次）→ PR5（製品の画面） | §5 |
| この run の PR1a・PR1b | それぞれ変更するファイル・引数の契約・受入基準・gates（lint／typecheck／unit）。PR1a は警報の設定キーを拒む | §6 |
| 試験の表 | 表 T1〜T9。F1〜F5 の陽性・陰性の対照と、防御を 1 つずつ外す変異の対照（表 T9） | §7 |
| 再現の確かめ方 | 2026-11-13 の GitHub と台帳から時間ごとの表。期待値は別の実装で出し、PR1a で手計算の証人と raw の取得条件を fixture に結ぶ。`—` は未取得で 0 と比べない | §8 |
| ダッシュボード | 第 1 段は数だけを載せる Artifact の試作を推奨。画面は PR5 | §9 |
| 人の判断・未決 | 人の判断 7 つ（推奨つき）と、未決 6 つ（誰が決めるか） | §10・§13.3 |

---

## 0. 前提の確かめ（事実）

| # | 事実 | 場所 | 本書での扱い |
|---|---|---|---|
| F1 | orchestrate の台帳は `<run-dir>/run-<issues>.jsonl` に 1 段 1 行の JSON。段は `contract/send/verify/review/findings/precheck/pr/ci/merge`、別に HEAD を持たない `queue` の行がある | `scripts/orchestrate/run-log.mjs:63`・`:69`・`:92` | 台帳の読み手（§2.5）。着手＝最初の `send ok`、マージ＝最初の `merge ok` |
| F2 | 台帳の書き手は最後の行が改行で終わっていなければ改行を足してから書く（落ちた書き手の千切れた行を閉じる）。読み手は読めない行を飛ばして報告する。どちらも単独の書き手の形で、読んで決めて書く手順の原子性は持たない | `run-log.mjs:178-195`・`:201-222` | 千切れた行の閉じ方だけを写す。警報の確定の直列化は排他（I-9）と tick ID（I-10）で別に作る |
| F3 | 台帳の run dir は `workspace/orchestration/runs/<開始日>/` で、1 本の台帳が日をまたぐ（2026-11-13 の dir の `run-3574-4317.jsonl` は 2026-11-13 01:21 〜 11-14 07:02 JST の 559 行） | 読み取りで確認 | 台帳は窓の開始日より前の dir も読む（`lookbackDays`）。lookback より前に着手した item は見えないので、台帳の数は「lookback 内に着手した分」と名付ける（§2.3） |
| F4 | `DEFAULT_REPO = 'Kewton/CommandMate'`・`DEFAULT_BASE_BRANCH = 'develop'` が orchestrate のスクリプトに埋め込まれている | `scripts/orchestrate/pr-common.mjs:24`・`:26` | 計測は**これを import しない**。repo は `git remote`、base は設定か git の ref から決める（I-16） |
| F5 | 読み取りの `gh` は 502/503/504・接続の失敗のときだけ最大 4 回（10・30・60 秒の間隔）呼び直す | `pr-common.mjs:82-84`・`:92-99`・`:143-155` | 計測は `withGhRetry` を**使わない**（最長 100 秒の待ちが期限の予算を食う）。呼び直しは 0 回（§4） |
| F6 | `defaultRun` は `spawnSync` に時間切れを渡していない | `pr-common.mjs:58-67` | 計測の子は必ず残りの予算を時間切れに渡し、`killSignal: 'SIGKILL'` で止める（§3.2） |
| F7 | マージのロックの名前は `merge.<owner>.<repo>.<base>`（`/` は `.`、64 文字を超えると sha1 で縮める） | `scripts/orchestrate/merge-pr.mjs:313-317` | repo-slug の作り方を同じ流儀にする（§2.1）。ロック自体は使わない（I-17） |
| F8 | 同期のマシンのロック `acquireMachineLockSync(name, { root, timeoutMs, … })`: 札（ticket）を取ってから `mkdir` で取る。`timeoutMs: 0` は 1 回だけ試し、期限に当たれば自分の札を片付けて `acquired: false` を返す。例外の時も札を片付けて投げ直す | `scripts/orchestrate/machine-lock-sync.mjs:1080`・`:1140-1143`・`:1369-1372`・`:1380-1383` | tick の排他に流用する（表 S0）。名前は `flow.<repo-slug>` |
| F9 | 持ち主の記録は `pid`・`host`・`token`・`acquiredAt`。同じ host で pid が ESRCH なら持ち主は死んだと判定し（`holderGone`）、記録を脇へ退かしてから消して取り直す（`recoverLock`）。札は pid の起動時刻（`ps -o etime=` から `processStartMs`）が札より新しければ pid の再利用として外す。観測できないもの（EPERM・EIO）は「分からない」で、取らない・消さない | `machine-lock-sync.mjs:63`・`:118-131`・`:450-453`・`:462-470`・`:1003-1012`・冒頭の注記 `:24-32` | 死んだ持ち主の回収は自分で書かない（部品のまま使う） |
| F10 | ロックの root は `CM_VERIFY_LOCK_ROOT` か `~/.commandmate/locks` | `scripts/orchestrate/precheck.mjs:523-526` | 同じ root を使う（`merge.*`・`cpu.heavy` とは名前が違うので互いに待たない） |
| F11 | `tests/setup.ts` は `~/.commandmate` の下を指す設定を pid ごとの一時パスに向けている（例 `CM_VERIFY_LOCK_ROOT`・`CM_RUN_LOCK_DIR`） | `tests/setup.ts:287-291` | `CM_FLOW_DIR` を同じ形で足す（共通の枠 §2）。ロックの root はすでに一時パス |
| F12 | `ci-flaky.ts` の `CiRun`／`CiJob` は job の `started_at`・`created_at` を持たない | `src/lib/agent-health/ci-flaky.ts:39-55`・`:135-156` | 順番待ちには使えない。job の読み手は新しく作る |
| F13 | 計測の道具の呼び出し `runCommand` はプロセスグループを作り、時間切れで SIGTERM → 5 秒後 SIGKILL する（非同期） | `scripts/agent-health/metrics-runners.ts:130-165` | PR1a は同期の `spawnSync` に残りの予算と SIGKILL を渡す形にする（遅れて返る結果が起きない形。§3.2）。`runCommand` は TS で `@/lib` を import するので `.mjs` から直接は使えない |
| F14 | `GET /api/metrics/vibe?days=N` は DB の `tasks`・`verification_runs`・`task_events` を読んで集計を返す（読み取りだけ） | `src/app/api/metrics/vibe/route.ts:18-40`、`src/lib/metrics/vibe-metrics.ts:329` | CommandMate の DB は**この API 越しに**読む（PR4）。DB のファイルは開かない（I-14） |
| F15 | `capture --json` の応答は必ず `isRunning` を持つ | `src/cli/types/api-responses.ts:216-237` | PR3 の送信の前の確かめの 1 つ。配送の安全は既存の `send` の判定に委ねる（I-13） |
| F16 | 設定の YAML は `yaml` パッケージで読む | `src/lib/verification/verify-config.ts:12`・`:165`、`scripts/orchestrate/contract.mjs:48` | `.commandmate/flow.yaml` も `yaml` で読む |
| F17 | ランナーの一覧 `gh api repos/Kewton/CommandMate/actions/runners` は今の資格で読める（2026-11-14 に 6 台 online） | 読み取りで確認 | PR2 の取得元 |
| F18 | team.md §6 の 3（危険の境目で PR を分ける）・4（API は呼び手と同じ PR）・5（狭めて塞ぐ） | `docs/orchestrate/team.md:64-78` | §5 の切り方 |
| F19 | `tests/unit/guards/test-file-placement.test.ts` は `tests/unit/` の下を走る root として受け、lint の範囲は `scripts/**` | `test-file-placement.test.ts:76-85`、`lint-scripts-scope.test.ts:51`・`:77` | `scripts/flow/`・`tests/unit/scripts/flow/` は既存のガードの中 |

---

## 1. 不変条件

**I-0（最上位）**: 各 repo／base／取得元について、対象期間を完全に観測できた値だけを確定値として記録し、未知を保ったまま、同時実行と再起動をまたいでもコミットした観測に対応する警報遷移だけを一度ずつ確定し、計測の失敗を既存の送信・検証・マージの許可へ転用しない。

I-1〜I-17 は I-0 を守る場所ごとに分けたもの。

| # | 不変条件 | 守る場所 | 対応する指摘 |
|---|---|---|---|
| **I-1 完全なものだけ確定値** | 値ごとに、その値が依存する入力（照会・ページ・期間・ファイル）を全部読めたことを証明できたときだけ確定値を書く。証明できない値は `null`、`complete: false` と理由 | 表 S2。試験 T2・T3 | F1 |
| **I-2 上限に当たったら未知** | 件数の上限（PR の照会の `--limit`、run の 30 本、API の 1000 件）・期間の上限（`lookbackDays`・`runLookbackHours`）に当たったか、当たっていないことを示せないときは、その値を `null`（理由 `truncated`）にする。上限の内側で数えた値を確定値にしない | 表 S2 | F1 |
| **I-3 部分の値は別の名前** | 部分的に読めたときの参考値は `hints.<名前>` に置く。`hints` は表示だけに使い、警報・集計・他の子の入力にしない | §2.2。試験 T9 の変異 M3 | F1 |
| **I-4 0 は数えた 0** | `0` は「完全に読めて、数えて 0」のときだけ。空の母集団の中央値・最大は `null`（`n: 0`） | 集計。試験 T3 | F1 |
| **I-5 状態のキーは scope** | 状態と履歴のキー（scope）は `repo`（`owner/name`）＋`base`。`source-down` は scope＋取得元。前の状態・直近の tick・`report`・`status`・`eventId` は同じ scope の行だけから選ぶ。別の scope の行は読み飛ばす | 表 S3。試験 T4 | F2 |
| **I-6 GitHub でない origin は記録しない** | PR1a〜PR1b は origin が GitHub の `owner/name` に読めないリポジトリの計測を exit 2 で拒む（記録先の識別を作らない）。ほかの識別の作り方は未決（§13.3 U1） | 設定の読み手。試験 T1 | F2 |
| **I-7 未知では鳴らさない・消さない** | 警報の入力が `null`、または連続性が未知（I-8）のとき、その警報の状態を変えない（`fired` も `resolved` も書かない） | 表 S3。試験 T4 | F4 |
| **I-8 連続性は欠けなく数える** | `source-down` の「N 回続けて失敗」は、同じ scope の直近 N 個の tick が欠けなく（間隔が `2 × intervalSec` 以内、間に読めない行が無い）並んでいるときだけ数える。欠け・壊れた履歴・`denied`／`absent` を挟むと連続性は未知（I-7 で保持） | 表 S3。試験 T4 | F4 |
| **I-9 tick は repo-slug ごとに 1 つ** | `tick` は `flow.<repo-slug>` の排他（F8 の部品）を取ってから始め、取れなければ何も書かずに exit 0（stderr に 1 行）。排他は tick の全体（取得・記録・警報の確定）を覆う | 表 S0。試験 T6 | F3 |
| **I-10 tick ID で一度ずつ** | tick は排他を取った後に `tickId`（UUID）と `at` を決め、警報の出来事は `eventId = <tickId>#<警報 id>[#<取得元>]`。すでにある `eventId` は書かない。警報を確定する tick の `at` は、同じ scope で確定済みの最後の tick の `at` より後でなければならない（古い観測で新しい状態を上書きしない） | 表 S3・S3R。試験 T6 | F3 |
| **I-11 記録が先、表示は書けたものだけ** | 警報の出来事は `alerts.jsonl` に書けてから表示する。表示するのは、この tick で書けたと確かめた出来事だけ。書けなかった出来事は表示も送信もしない | 表 S1・S3 | F3 |
| **I-12 期限で必ず終わり、終わりは 1 回** | tick の期限の起点は排他を取った時刻。取得の締め切り（既定 200 秒）を過ぎて返った結果は捨てる（`timeout`）。計測の記録の書き込みは高々 1 回、警報の出来事の書き込みも高々 1 回（1 回の追記に全部を入れる）。ローカルの I/O（`fs` の同期の読み書き）の無期限の停止は前提の外 | 表 S1・§3.2。試験 T5 | F5 |
| **I-13 送るのは明示したときだけ、既存の経路で** | PM への送信は `alerts.notify` を設定したときだけ（PR3）。送信は `commandmate send <worktree> <本文> --instance <id>` を子として呼ぶ形に限り、配送の安全は既存の `send` の判定に委ねる。`capture` の `isRunning` は送らない理由にだけ使い、送ってよい証拠にしない。tmux を直接叩かない。PR1a・PR1b は送信の設定を拒む | 表 S4 | F6・共通の枠 §3 |
| **I-14 計測は何も変えない** | 計測は GitHub・git・CommandMate・ランナー・Docker に読み取りしかしない。`gh` は `pr list` と `api` の GET（method と引数を確かめる）だけ、git は `fetch` もしない。DB のファイルを開かない。書くのは計測の記録の dir とロックの root（排他の札と持ち主）だけ | 試験 T8 | §3（レビュー） |
| **I-15 追記だけ** | 記録は追記だけ。書き換え・削除をしない。千切れた最後の行は改行で閉じてから書く（F2）。読み手は改行で終わらない最後の行を「書きかけ」として読まない | 書き手・読み手。試験 T5 | F3 |
| **I-16 リポジトリに固有の値を埋め込まない** | repo・base・ランナーの名前・台帳の場所は設定か git から決める | 設定の読み手。試験 T1 | 共通の枠 §1 |
| **I-17 計測の結果を許可に使わない** | 計測の記録・警報（`ok`・`resolved`・`null`）を、verify・precheck・CI・merge・前景の確認・送信の可否の代わりに使わない。計測は `merge.*`・`cpu.heavy` のロックを取らない・待たない。`.commandmate/verify.yaml`・`merge-pr.mjs`・`precheck.mjs` に手を入れない | §5 の変更ファイルの一覧。§11（他の子への約束） | §3（レビュー） |

---

## 2. 記録の形と指標の定義

### 2.1 置き場所と名前

- 計測の記録: `<flowDir>/<repo-slug>/<YYYY-MM-DD>.jsonl`。`<flowDir>` は `CM_FLOW_DIR` があればそれ、無ければ `<home>/.commandmate/flow`（共通の枠 §2）。日付は設定の `tz` での tick の `at` の日付
- 警報の履歴: `<flowDir>/<repo-slug>/alerts.jsonl`（共通の枠 §2。PR1b から）
- `<repo-slug>`: `<owner>.<name>` を小文字にし、`[a-z0-9_.-]` 以外を `_` に（F7 の流儀。例 `kewton.commandmate`）。64 文字を超えたら先頭 51 文字＋`.`＋sha1 の 12 桁。base は slug に入れず、各行の `base` で分ける（I-5。同じリポジトリの 2 つの base は同じファイルに混ざり、読み手が scope で選ぶ）
- 排他: `<lockRoot>/flow.<repo-slug>.lock`（F8・F10）
- 書き方: 1 行 1 JSON、末尾に改行。最後の行が改行で終わっていなければ改行を足してから書く（F2）。dir が無ければ作る（mode 0700）

### 2.2 計測の記録（`kind: "tick"`、v1）

```jsonc
{
  "v": 1, "kind": "tick",
  "tickId": "6f0c…",                         // 排他を取った後に決める UUID（I-10）
  "at": "2026-11-13T10:00:03.120Z",          // 排他を取った時刻（UTC）＝期限の起点（I-12）
  "repo": "Kewton/CommandMate", "base": "develop",
  "intervalSec": 900,                        // 設定の想定間隔（連続性の判定に使う。I-8）
  "sources": {                               // 取得元ごとの結果（表 S2）。値は ok|fail|timeout|denied|absent|truncated
    "pr": "ok", "ci": "timeout", "ledger": "ok", "load": "ok"
  },
  "flow": {                                  // 値は数か null。null の理由は complete に
    "openPrs": 13, "openDraftPrs": 0, "oldestOpenPrMin": 312,
    "mergedInWindow": 0, "mergeWindowMin": 60,      // 直前 mergeWindowMin 分（既定 60）のマージ数
    "lastMergeAt": "2026-11-13T07:40:11Z",
    "prToMergeMin": { "n": 6, "median": 212, "max": 471 },
    "ledgerWipWithinLookback": 18,           // lookback 内に着手した work item のうち未マージ（repo 全体の WIP ではない。F3）
    "startToMergeMin": { "n": 6, "median": 330, "max": 700 }
  },
  "ci": { "queuedJobs": null, "oldestQueuedMin": null, "queuedByLabel": null, "inProgressJobs": null },
  "resource": { "load1": 52.1, "load5": 61.0, "cpus": 12 },
  "complete": {                              // 値のグループごとの完全性（I-1）
    "flow.pr": true, "ci": false, "flow.ledger": true, "resource.load": true
  },
  "why": { "ci": "timeout: gh api …/actions/runs?status=queued" },   // complete=false の理由（1 行・200 文字以内）
  "hints": { },                              // 部分の参考値（I-3）。例 { "ci.queuedJobsSeen": 4 }
  "durationMs": 8123
}
```

- 値のグループと取得元の対応: `flow.pr`（`openPrs`〜`prToMergeMin`）← `pr`、`ci` ← `ci`、`flow.ledger`（`ledgerWipWithinLookback`・`startToMergeMin`）← `ledger`、`resource.load` ← `load`。グループの中の値は全部が確定値か全部が `null`（片方だけ確定の形を作らない）
- PR2 で `resource.runners*`・`resource.docker` と `sources.runners`・`sources.docker`、PR4 で `flow.wipBranches`・`flow.activeBranches`（#4368）・`agents`・`vibe`・`machine`（#4370 の出来事の読み、X3）を足す。**足すだけで、v1 の既存のキーの意味は変えない**（読み手は知らないキーを無視する）

### 2.3 指標の定義（記録と再現で同じ定義を使う）

| 指標 | 定義 | 元 | 完全である条件 |
|---|---|---|---|
| マージ数（時間ごと） | base へマージされた PR を `mergedAt` の `tz` での時（0〜23）で数える | GitHub PR | PR の照会が §2.4 の条件で完全 |
| 開いた PR（時刻 t） | base 向けで `createdAt ≤ t` かつ（`closedAt` が無い、または `closedAt > t`）の PR の数 | GitHub PR | 〃 |
| 台帳の WIP（lookback 内、時刻 t） | 台帳の work item（`issue`・`item`）のうち、最初の `send ok` が `[t − lookbackDays, t]` にあり、最初の `merge ok` が t 以前に無いもの | 台帳 | §2.5 の条件 |
| CI の順番待ち（job、過去） | job の `started_at − created_at`（分）。`conclusion: skipped` と `started_at` の無い job は除く。時の分け方は job の `created_at`。attempt は最新だけ（`filter=latest`） | GitHub run・job | §2.4 の条件 |
| 今の順番待ち（tick） | `status=queued` と `in_progress` の run の job のうち `status: queued` のもの。待ちは `at − created_at` | GitHub run・job | 〃 |
| PR→マージ | `mergedAt − createdAt`（分） | GitHub PR | PR の照会が完全 |
| 着手→マージ | 台帳の最初の `send ok` → 最初の `merge ok`（分） | 台帳 | §2.5 |
| 滞留（日次、PR4） | 窓の平均の WIP ÷ 窓のスループット（**見立て**: 定常でない日は目安） | 計測の記録 | 窓の tick が全部確定値 |

### 2.4 GitHub の照会と完全性

| 照会 | 形 | 完全である条件（全部満たす） |
|---|---|---|
| 開いた PR（tick・過去） | `gh pr list --repo R --base B --state open --limit 500 --json number,createdAt,closedAt,mergedAt,isDraft` | exit 0、件数 < 500 |
| 直近のマージ（tick） | `gh pr list --repo R --base B --state merged --search "merged:>=<at − 24h>" --limit 500 --json …` | exit 0、件数 < 500、`mergeWindowMin ≤ 1440`（設定の検査で保証。照会の窓が警報の窓を覆う） |
| 過去の PR（reconstruct） | 上の開いた PR ＋ `--state all --search "updated:>=<窓の開始>" --limit 1000` | 両方 exit 0、両方 < 上限。2 つの照会に出る同じ PR は `number` で 1 つにする（`updatedAt ≥ closedAt` なので、窓の開始以降に閉じた PR は必ず後者に出る） |
| 今の CI（tick） | `gh api "repos/R/actions/runs?status=queued&per_page=100"` と `status=in_progress`、各 run の `jobs?filter=latest&per_page=100`（全ページ） | 全部 exit 0、run の合計 ≤ 30、各応答の `total_count` と読んだ件数が一致、ページの欠けなし |
| 過去の CI（reconstruct） | `gh api --paginate "repos/R/actions/runs?created=<窓の開始 − runLookbackHours>..<窓の終わり>&per_page=100"`、各 run の `jobs?filter=latest`（全ページ） | 全部 exit 0、run の `total_count` < 1000 で読んだ件数が一致、**lookback の端の 1 時間に作られた run に窓の中で作られた job が無い**（あれば lookback が足りない可能性を否定できないので `truncated`） |

`gh` の 404・403 は `denied`、他の exit ≠ 0 は `fail`（`GH_TRANSIENT_PATTERN` で理由を分けて `why` に書く。呼び直しはしない）。

### 2.5 台帳の読み手

- 場所: `--ledger-dir`（引数）→ 設定の `ledger.runsDir`（リポジトリの**主 worktree の root**からの相対、または絶対。主 worktree の root は `git rev-parse --path-format=absolute --git-common-dir` の親）の順。どちらも無ければ `sources.ledger: "absent"`
- 読む dir: 窓の開始の `lookbackDays`（既定 7、1〜30）日前から窓の終わりの日までの `<runsDir>/<YYYY-MM-DD>/run-*.jsonl`（F3）。1 ファイル 16 MB・合計 64 MB を超えたら `truncated`（同期の読みの量を限る。I-12）
- 完全である条件: 読んだ全ファイルの全行が JSON として読め、`issue`・`stage`・`result`・`at` を持ち、`at` が時刻として読める。**例外は 1 つだけ**: 改行で終わらない最後の行（書き手が書いている途中。F2）は読まない。それ以外に読めない行が 1 行でもあれば `flow.ledger` は `null`（理由 `corrupt`、読めた行で数えた値は `hints` へ）。同じ (issue, item, stage, at) の重複行は 1 つにする
- 読むのは `issue`・`item`・`stage`・`result`・`at` だけ。`note` の中身は記録に写さない

### 2.6 警報の履歴（`alerts.jsonl`、v1、PR1b から）

```jsonc
{ "v": 1, "kind": "alert", "repo": "Kewton/CommandMate", "base": "develop",
  "id": "open-prs", "source": null,                 // source-down だけ取得元（pr|ci|ledger）
  "event": "fired",                                  // fired | resolved（PR3 で notify-attempt | notify-result | notify-gave-up を足す）
  "tickId": "6f0c…", "tickAt": "…", "eventId": "6f0c…#open-prs",
  "value": 13, "threshold": 5 }
{ "v": 1, "kind": "alert-eval", "repo": "…", "base": "…", "tickId": "6f0c…", "tickAt": "…" }   // この tick の評価を確定した印（表 S3R）
```

| 警報 id | 入力（値のグループ） | 鳴る条件 | 消える条件 | 入る PR |
|---|---|---|---|---|
| `open-prs` | `flow.pr` | `openPrs > alerts.openPrMax`（既定 5） | `openPrs ≤ openPrMax` | PR1b |
| `no-merge` | `flow.pr` | `mergedInWindow = 0` **かつ** `openPrs > 0` | `mergedInWindow ≥ 1`、または `openPrs = 0` | PR1b |
| `ci-queue` | `ci` | `oldestQueuedMin > alerts.queueWaitMinutes`（既定 15） | `oldestQueuedMin ≤ queueWaitMinutes`（queued が完全に 0 なら消える） | PR1b |
| `source-down`（取得元ごと） | 直近の tick の `sources.<元>` | 同じ scope・同じ取得元で、連続性が確かな直近 `alerts.sourceDownTicks`（既定 2）回が全部 `fail`／`timeout` | 最新が `ok`（`truncated` は消さない: 読めたが値は未知） | PR1b（pr・ci・ledger）、PR2（runners・docker） |
| `runners-zero`・`docker-down` | PR2 | §5 | | PR2 |
| `wip` | #4368 | #4368 の上限 | | PR4 |

---

## 3. 状態と遷移の表

### 3.1 表 S0: 排他（`flow.<repo-slug>`、F8・F9 の部品をそのまま使う）

| 状態 \ 出来事 | `acquireMachineLockSync('flow.<slug>', { root: lockRoot, timeoutMs: 0 })` が `acquired: true` | `acquired: false`（生きた持ち主・先の札） | `acquired: false` で `unknown` あり（観測できない） | 例外 |
|---|---|---|---|---|
| tick の開始 | `tickId`・`at` を決めて表 S1 へ | 何も書かずに exit 0。stderr に `flow: tick skipped: held by <heldBy>` の 1 行 | 何も書かずに exit 1（ロックの root の異常は人に見せる） | 何も書かずに exit 1（札は部品が片付ける。F8） |
| tick の終わり（正常・exit 1 とも） | `release()` を呼ぶ。`released` 以外の答えは stderr に 1 行（次の tick は部品の回収に任せる） | — | — | — |

- 死んだ持ち主（落ちた tick）の回収・pid の再利用の判定・観測できないときに取らないことは、部品（F9）の挙動をそのまま使い、計測の側で書かない
- 排他は取得を含む tick の全体を覆う（I-9）。15 分の間隔に対して tick の上限は 240 秒なので、正常な間隔では重ならない（**見立て**）

### 3.2 表 S1: 1 回の tick の段と期限

期限: 起点 `T0` ＝ 排他を取った時刻。取得の締め切り `Tf = T0 + fetchBudgetSec`（既定 200）、全体の締め切り `Te = T0 + tickBudgetSec`（既定 240）。子の呼び出しは `spawnSync(cmd, args, { timeout: min(呼び出しの上限, Tf − now), killSignal: 'SIGKILL' })`。SIGKILL なので子が SIGTERM を無視しても `spawnSync` は戻る（**見立て**: カーネルの中で止まった子（D 状態）は前提の外）。同期の呼び出しなので、締め切りの後に別の結果が届く経路は無い。戻った時刻が `Tf` を過ぎていれば、その結果は捨てて `timeout` とする。

| 段 \ 出来事 | 成功 | 失敗 | 締め切りを過ぎた |
|---|---|---|---|
| 1 引数・設定の読み（排他の前） | 2 へ | exit 2、何も書かない | —（局所のファイルだけ。`flow.yaml` は 64 KB を超えたら exit 2） |
| 2 repo・base・root を決める（git、排他の前。各 10 秒） | 3 へ | exit 2、何も書かない。origin が GitHub でない（I-6）・base を決められない・主 worktree の root を決められない | exit 2 |
| 3 排他（表 S0） | 4 へ | 表 S0 | — |
| 4 取得（pr → ci → ledger → load の順） | 次へ | その取得元を `fail` 等にして次へ（表 S2） | 残りの取得元を呼ばずに `timeout` とし 5 へ |
| 5 集計（純関数。入力の形を検査する） | 6 へ | 入力が形の検査に落ちた取得元（JSON でない・時刻が読めない・数でない・NaN）は `fail`（理由 `schema`）にして、その値のグループを `null` にする。集計の中の想定外の例外は exit 1（何も書かない） | —（局所の計算） |
| 6 計測の記録を 1 行書く（1 回の `appendFileSync`） | 7 へ（PR1a はここで表示して exit 0） | exit 1。警報を評価しない（I-11）。書きかけの行は次の書き手が閉じる | `now > Te` なら書かずに exit 1（期限を守れない tick は記録しない） |
| 7 警報の評価と確定（PR1b、表 S3・S3R） | 8 へ | `alerts.jsonl` が読めない（EACCES 等）: 何も書かずに exit 1。書けない: exit 1、表示しない | `now > Te` なら確定せずに exit 1（次の tick が S3R で回復） |
| 8 表示 | 1 行の要約を stdout に、この tick で書けた警報の出来事を stderr に。排他を返して exit 0 | — | — |

### 3.3 表 S2: 取得元 × 結果 → 値と完全性

| 取得元 | 結果 | `sources.<元>` | 値のグループ | `complete` |
|---|---|---|---|---|
| pr | §2.4 の条件を全部満たす | `ok` | 数えた値（0 を含む） | true |
| pr | 件数が上限に達した | `truncated` | `null` | false |
| pr | 2 つの照会のどちらかが exit ≠ 0 | `fail` | `null`（片方の照会の値を確定値にしない） | false |
| pr | 403・404 | `denied` | `null` | false |
| pr | 締め切り | `timeout` | `null` | false |
| ci | 条件を全部満たす | `ok` | 値（queued が 0 なら `queuedJobs: 0`・`oldestQueuedMin: null`、`n: 0`） | true |
| ci | run が 31 本以上・`total_count` と読んだ件数の不一致・ページの欠け・lookback の端の判定（過去） | `truncated` | `null`（読めた分は `hints.ci.*Seen`） | false |
| ci | どれか 1 つの呼び出しが exit ≠ 0 | `fail` | `null` | false |
| ci | 締め切り | `timeout` | `null` | false |
| ledger | §2.5 の条件を満たす | `ok` | 値 | true |
| ledger | 設定も引数も無い | `absent` | `null` | false |
| ledger | dir が無い・読めない | `fail` | `null` | false |
| ledger | 読めない行がある | `fail`（理由 `corrupt`） | `null`（読めた行の値は `hints`） | false |
| ledger | 読む量の上限 | `truncated` | `null` | false |
| load | `os.loadavg()` が有限の数 3 つ・`os.cpus().length ≥ 1` | `ok` | 値 | true |
| load | 非有限の数・cpus 0 | `fail`（理由 `schema`） | `null` | false |

pr が `ok` で ci が `fail` のとき、`flow.pr` は確定値で `ci` は `null`。**ci の故障は ci の `source-down` で知らせ（表 S3）、pr の回復で ci の警報は消えない**（I-5・I-7）。

### 3.4 表 S3: 警報の状態 × 入力（PR1b）

状態: 同じ scope（I-5）・同じ id（`source-down` は取得元も）の、確定済みの最後の `fired`／`resolved`（無ければ `ok`）。履歴が読めない・その scope の最後の行が壊れている（改行で終わる行が JSON でない）ときは `unknown`。

| 前の状態 \ 入力 | 超えた（breach） | 下回った（clear） | 未知（値のグループが `null`、または連続性が未知） |
|---|---|---|---|
| `ok` | `fired` | 何も書かない | 何も書かない（I-7） |
| `firing` | 何も書かない | `resolved` | 何も書かない（消さない） |
| `unknown`（履歴が壊れている） | `fired`（二重になりうる。鳴らさないより鳴らす側へ） | 何も書かない（壊れた履歴から回復を作らない） | 何も書かない |

`source-down` の入力（I-8）:

| 直近 N 個（N = `sourceDownTicks`）の同じ scope の tick | 入力 |
|---|---|
| 欠けなく、全部 `fail`／`timeout` | breach |
| 最新が `ok` | clear |
| 最新が `truncated` | 未知（読めたが値は未知。消さない・鳴らさない） |
| 間に `denied`／`absent` を挟む・最新が `denied`／`absent` | 未知（取得元が「無い」ことと「壊れた」ことを混ぜない） |
| tick の間隔が `2 × intervalSec` を超える・間に読めない行・N 個に足りない | 未知 |
| 欠けなく、`fail` と `ok` が混ざり最新が `fail` | 鳴らさない（連続でない）。`firing` なら消さない（最新が `ok` でないため） |

確定の手順（排他の中、表 S1 の 7）: (1) 同じ scope の `alerts.jsonl` を読む → (2) 表 S3R の回復 → (3) この tick の値で表 S3 を評価 → (4) 書く出来事と `alert-eval` の印を 1 回の `appendFileSync` で書く → (5) 書けた出来事だけを表示。

### 3.5 表 S3R: 落ちた後の再開（tick ID で一度ずつ）

| 次の tick が見たもの（同じ scope） | 動き |
|---|---|
| 最後の `tick` 行に `alert-eval` の印がある | 回復は無し。この tick を評価 |
| 最後の `tick` 行（前の tick が記録を書いた後に落ちた）に `alert-eval` が無い | その tick の行の値で先に評価し、`eventId` がまだ無い出来事だけを書く（印も書く）。続けてこの tick を評価 |
| 印が無い `tick` 行が 2 つ以上 | 最後の 1 つだけ回復する（それより前の観測で今の状態を作らない。I-10） |
| 出来事の追記が途中で切れた（最後の行が改行で終わらない） | 書き手が改行で閉じる（F2）。閉じられた行は読めない行として捨て、その tick は印が無いので回復の対象になる。書けていた `eventId` は二重に書かない |
| この tick の `at` が確定済みの最後の tick の `at` 以前（時計の巻き戻し） | 評価しない（計測の記録は書く）。stderr に 1 行 |

### 3.6 表 S4: PM への送信（PR3。PR1a・PR1b は `alerts.notify` を exit 2 で拒む）

送信は `flow.<repo-slug>` の排他の中で行う。試行の記録を送信の前に書く。

| 状態 \ 出来事 | 試行の印を書けた | 試行の印を書けない | `capture --json` の `isRunning: false`／読めない／時間切れ | `send` exit 0 | `send` exit ≠ 0・時間切れ | 結果を書けない |
|---|---|---|---|---|---|---|
| 送信の設定なし | — 何もしない（記録と表示だけ） | | | | | |
| 未送信の `fired`／`resolved` | `{event: notify-attempt, attemptId, eventId}` を書いた → capture へ | 送らない（exit 1） | `notify-result: skipped(not-running)` を書き送らない（既存の `send` も送らないはずの状況で、試行に数えない） | `notify-result: sent` | `notify-result: failed(exit)` | 次の tick は「結果の無い試行」として扱う（下） |
| 試行の印があり結果が無い（前の tick が送信の前後で落ちた） | 結果不明として**試行に数える**（届いたかどうか分からない）。上限に満たなければ新しい試行へ | | | | | |
| 試行が `alerts.notifyMaxAttempts`（既定 3）回に達した（結果不明を含む） | `notify-gave-up` を書き、以後送らない（表示は続く） | | | | | |

- 上限は「`send` を呼んだかもしれない回数」で数えるので、落ちて再開を繰り返しても実際の送信は上限を超えない（印を書けなければ送らないため）
- 本文は 1 行・300 文字以内・先頭 `[flow]`。改行を入れない
- `isRunning: true` は送ってよい証拠ではない。最後の判断は既存の `send`（前景の確認）がする（I-13）

---

## 4. 外部の呼び出しごとの失敗の倒れ方

| 呼び出し | 時間切れ | 失敗・時間切れ・部分的な成功のとき | 倒れる向き |
|---|---|---|---|
| `gh pr list` | 各 30 秒（残りの予算が小さければそれ） | 表 S2。呼び直しは 0 回（次の tick が呼び直しに当たる） | fail-open（未知として記録して続ける） |
| `gh api …/actions/runs`・`…/jobs` | 各 20 秒 | 1 つでも読めなければ `ci` は `null`。部分の値は `hints` | fail-open（部分を確定値にしない） |
| `gh api …/actions/runners`（PR2） | 20 秒 | 403/404 は `denied`、他は `fail`。`runners-zero` は `null` では鳴らない | fail-open |
| `docker info`（PR2） | 10 秒 | ENOENT＝`absent`、exit ≠ 0・時間切れ＝`down`（不応答そのものが知らせたい事象） | 失敗＝`down` |
| `git`（remote・ref・`--git-common-dir`） | 各 10 秒 | exit 2、何も書かない。`fetch` はしない（I-14） | fail-closed |
| `.commandmate/flow.yaml` | — | 無い＝既定値。読めない・壊れた YAML・知らないキー・型の誤り・呼び手の無いキー＝exit 2 | fail-closed |
| 台帳 | 量の上限（§2.5） | 表 S2 | fail-open（壊れた行があれば値は未知） |
| ロック（`acquireMachineLockSync`） | 0 秒 | 表 S0 | fail-closed（取れなければ何も書かない） |
| 計測の記録・`alerts.jsonl` の書き込み | 前提の外（ローカルの I/O） | EACCES・ENOSPC・EROFS は exit 1。警報を出さない（I-11）。書きかけの行は次の書き手が閉じる | fail-closed |
| CommandMate の API（PR4） | 10 秒 | 止まっている・401 は `fail`／`denied`。DB のファイルへ回り込まない（I-14） | fail-open |
| `commandmate capture`／`send`（PR3） | 30 秒／60 秒 | 表 S4 | fail-closed（送らない側） |

**ローカルの I/O**: `fs` の同期の読み書きが返らない（NFS の停止など）ことへの実時間の保証は持たない（前提の外）。守るのは「読む量の上限」（§2.5・`flow.yaml` 64 KB・`alerts.jsonl` は最後の 4 MB だけ読む）と「書く回数」（I-12）。

---

## 5. PR の切り方

危険の境目（F18）: **読み取りだけの計測**／**状態を持つ警報の確定**／**資源の外部の読み取り**／**PM への送信の経路**／**他の子の関数と API の読み取り**／**製品の画面**。呼び手の無い組み合わせは引数・設定の検査で拒み、広げるのは呼び手を作る PR（F18 の 4・5）。

| PR | 中身 | 危険の種類 | 依存 |
|---|---|---|---|
| **PR1a**（この run） | 設定の読み手（`version`・`repo`・`base`・`exclude`・`tz`・`intervalSec`・`ledger.*`。`alerts.*` は拒む）、記録の書き手（`kind: tick` だけ）、排他（表 S0）、取得（pr・ci・ledger・load）、集計、`tick`・`reconstruct`・`report`・`status`。警報なし | 読み取りと、計測の dir とロックの root への書き込み | なし |
| **PR1b**（この run） | 警報 `open-prs`・`no-merge`・`ci-queue`・`source-down`（pr・ci・ledger）。`alerts.jsonl` の書き手（`kind: alert`・`alert-eval`）、表 S3・S3R、設定に `alerts.openPrMax`・`mergeWindowMin`・`queueWaitMinutes`・`sourceDownTicks` を足す。呼び手は同じ PR の `tick`（確定）と `status`（今の警報の表示） | 状態の確定 | PR1a |
| PR2 | ランナーと Docker の取得、`runners-zero`・`docker-down`、`source-down` を runners・docker へ。設定に `alerts.runnersMin`・`alerts.docker` | Docker・ランナーの読み取り | PR1b |
| PR3 | PM への送信（表 S4）。設定に `alerts.notify`・`alerts.notifyMaxAttempts`・`alerts.renotifyMinutes`。送信の経路だけの PR | 送信の経路 | PR1b |
| PR4 | #4368 の WIP の関数を呼んで記録・`wip` 警報、③ エージェント（`/api/worktrees`）、`vibe`（API）、#4370 の `<lock root>/cpu.sem/events.jsonl` を読む（X3）、#4369 の train の行を読む集計、日次のまとめ | 他の子の関数・API の読み取り | PR1b、#4368 PR1 |
| PR5 | 製品へ: `src/lib/flow/**`・CLI `commandmate flow`・API・Flow のページ | 画面 | PR1b〜PR3、§9 の試作の結論 |

- PR2 と PR3 は並べてよい（重なるのは設定の許可リストの数行。後に入る方が develop を取り込んで足す）
- 記録の `kind: train` は #4369 の PR3 が呼び手と同じ PR で書き手に足す（X2）。PR1a の書き手は `train` を拒む

---

## 6. この run で実装する PR1a・PR1b の範囲（実装の契約にそのまま写す）

### 6.1 PR1a: 計測（警報なし）

#### 変更するファイル（実パスで 13 本）

| ファイル | 新規／変更 | 中身 | 見積り（行） |
|---|---|---|---|
| `scripts/flow/flow.mjs` | 新規 | 入口。`main(argv, deps)` を export（`deps`: `run`（同期・時間切れつき）・`now`・`env`・`home`・`lock`（表 S0 の部品の差し替え口）・`stdout`・`stderr`）。§6.1.2 の引数 | 250 |
| `scripts/flow/config.mjs` | 新規 | `readFlowConfig(repoRoot, { run, env })` → `{ repo, slug, base, exclude, tz, intervalSec, ledger }` か `{ error }` | 200 |
| `scripts/flow/record.mjs` | 新規 | `flowDirOf(env, home)`・`repoSlug(repo)`・`appendTick(dir, tick)`（`kind: 'tick'` だけ。I-15 の千切れた行の閉じ方）・`readTicks(dir, scope, from, to)`（改行で終わらない最後の行は読まない・別の scope は飛ばす） | 150 |
| `scripts/flow/sources.mjs` | 新規 | `readPr`・`readCi`・`readPrHistory`・`readCiHistory`・`readLedger`・`readLoad`。各々 `{ status, data, why, hints }` を返し、例外を投げない。§2.4・§2.5 の完全性の判定はここ | 350 |
| `scripts/flow/aggregate.mjs` | 新規 | 純関数: `tickValues(sources, at, cfg)`・`hourly(input, { from, to, tz })`。入力の形の検査（§3.2 の段 5） | 200 |
| `tests/unit/scripts/flow/config-4367.test.ts` | 新規 | 表 T1 | — |
| `tests/unit/scripts/flow/sources-4367.test.ts` | 新規 | 表 T2・T3 | — |
| `tests/unit/scripts/flow/tick-4367.test.ts` | 新規 | 表 T5・T6（排他）・T8・T9（PR1a の変異） | — |
| `tests/unit/scripts/flow/reconstruct-4367.test.ts` | 新規 | 表 T7（再現） | — |
| `tests/fixtures/flow/2026-11-13/meta.json` | 新規 | raw の取得条件（§8.2） | — |
| `tests/fixtures/flow/2026-11-13/{prs,runs,jobs}.json`・`ledger.jsonl` | 新規 | 取得結果の写し（番号・時刻・状態・ID だけ） | — |
| `tests/setup.ts` | 変更 | `process.env.CM_FLOW_DIR = join(tmpdir(), 'commandmate-test-flow', String(process.pid));`（F11 の並び） | 3 |
| `changelog.d/4367.md` | 変更 | 1 本目（この設計）の項目へ統合（2 本目の work item） | — |

本体の見積りは約 1150 行、試験を合わせて 2000〜2500 行（**見立て**）。目安（数百行）を超えるが、F18 の 4 により呼び手（`tick`・CLI）の無い部品だけの PR は作らない。超えた分は試験の表で、試験を削らない。

#### 引数の契約（`node scripts/flow/flow.mjs <cmd> …`）

| 引数 | 受ける cmd | 形 | 誤りは exit 2 |
|---|---|---|---|
| `--repo-root <dir>` | 全部 | 既定 cwd。linked worktree でもよい（主 worktree の root は `--git-common-dir` から） | 存在しない・git でない |
| `--tz <IANA>` | 全部 | 設定の `tz` より優先。`Intl.DateTimeFormat` が受けるものだけ | 受けない名前 |
| `--ledger-dir <dir>` | `tick`・`reconstruct`・`report` | 設定の `ledger.runsDir` より優先。絶対か cwd からの相対 | — （無い dir は `sources.ledger: fail`） |
| `--date <YYYY-MM-DD>` | `reconstruct` | 暦の日付 | 暦にない日付・`--from` との併用 |
| `--from <ISO>`・`--to <ISO>` | `reconstruct`・`report` | 両方そろって、`from < to`、幅 ≤ 31 日 | 片方だけ・逆・幅超え |
| `--json` | `reconstruct`・`report`・`status` | 出力を JSON に | — |
| （それ以外） | — | — | exit 2 |

`tick` は引数 `--repo-root`・`--tz`・`--ledger-dir` だけ。`reconstruct` は記録を書かない（stdout だけ）。`report`・`status` は記録を読むだけで外部を呼ばない。`status` は記録が無ければ「記録が無い」と出して exit 0。exit は 0（成功・排他を取れずに飛ばした）／1（書けない・期限・排他の観測不能・想定外）／2（引数・設定・識別）。

#### 設定の検査（`.commandmate/flow.yaml`）

- 許可するキー: `version`（1 だけ）・`repo`（`owner/name`）・`base`・`exclude`（文字列の配列、64 件以内）・`tz`・`intervalSec`（整数 60〜86400、既定 900）・`ledger.runsDir`（文字列）・`ledger.lookbackDays`（整数 1〜30、既定 7）・`ledger.runLookbackHours`（整数 1〜48、既定 6。過去の CI の照会の lookback）
- 名指しで拒むキー（exit 2、文面に「後の PR／他の子が足すキー」と出す）: `alerts`（PR1b）・`wip`（#4368）・`train`（#4369）
- 数の型: 整数のキーに小数・文字列・`NaN`・`Infinity`・範囲外は exit 2
- 無い＝全部既定値。読めない（EACCES）は「無い」と区別して exit 2

#### 受入基準

1. `reconstruct --date 2026-11-13 --tz Asia/Tokyo --ledger-dir <fixture>` を fixture（`deps.run` が `meta.json` の照会に対応する応答を返す）で動かした出力が、§8.3 の表の**取得したセル**と一致し、`—` のセルは `null` として出る（0 と比べない）
2. §8.4 の手計算の証人が全部成り立つ
3. 実際の GitHub に対して同じ `reconstruct` を手で 1 回動かし、§8.3 と一致する（PR の説明に出力を貼る。CI では動かさない）
4. `tick` は排他を取り、`CM_FLOW_DIR` の下の `<repo-slug>/<日付>.jsonl` に 1 行だけ書き、§2.2 のキー・`tickId`・`complete` を持つ
5. 表 S2 の全行が記録の値・`complete`・`sources` で再現する（未知は `null`、0 は完全に数えた 0 だけ）
6. 排他を取れないとき、何も書かずに exit 0 と stderr 1 行（表 S0）
7. 取得の締め切りを過ぎて返った結果を捨て、記録は 1 行だけ（表 S1）
8. 設定の誤り・GitHub でない origin は exit 2 で、記録もロックも作らない
9. `deps.run` が受けたコマンドが全部、読み取りの許可（§7 表 T8）に入る
10. `src/`・`scripts/orchestrate/`・`.commandmate/verify.yaml`・`.github/` に変更が無い（I-17）
11. 表 T9 の PR1a の変異の対照が、それぞれ対応する試験を赤にする（変異は試験の中の差し替えで作り、実装のファイルを書き換えない）

#### gates・scope

- gates: `lint`・`typecheck`・`unit`（`tests/setup.ts` を変えるため。共通の枠 §2）。手元の確かめのコマンド（下）は `unit` の代わりにならない
- 手元の確かめ: `npx vitest run tests/unit/scripts/flow tests/unit/guards tests/unit/docs`・`npm run lint`・`npx tsc --noEmit`
- scope.allow: `scripts/flow/**`・`tests/unit/scripts/flow/**`・`tests/fixtures/flow/**`・`tests/setup.ts`・`changelog.d/4367.md`
- fixture を足すので、契約の生成の `touchesFixtures` の文（fixture 走査テストへの登録）に従う
- 試験の隔離: 各 case は `fs.mkdtempSync(os.tmpdir())` の dir を `CM_FLOW_DIR`・`CM_VERIFY_LOCK_ROOT` に渡し（`deps.env`）、`process.env` を変えたら `afterEach` で戻す。既定の home を試す case は `deps.home` も一時 dir にし、`process.env.CM_FLOW_DIR` を消して本物の home へ落とさない。子プロセスを起こす case も `deps.run` の差し替えで実際の `gh`・`git` を呼ばない

### 6.2 PR1b: 流れの警報（状態を持つ部分）

#### 変更するファイル

| ファイル | 新規／変更 | 中身 | 見積り（行） |
|---|---|---|---|
| `scripts/flow/alerts.mjs` | 新規 | `readAlertState(dir, scope)`（scope ごとの前の状態・`unknown`・印の無い tick）・`evaluate(tick, prior, recentTicks, thresholds)`（表 S3、純関数）・`recover(...)`（表 S3R）・`commitAlerts(dir, events)`（1 回の追記、書けた出来事を返す） | 300 |
| `scripts/flow/flow.mjs` | 変更 | `tick` の段 7（排他の中で 読む → 回復 → 評価 → 1 回の追記 → 表示）、`status` に今の警報 | 80 |
| `scripts/flow/config.mjs` | 変更 | `alerts.openPrMax`（整数 0〜1000、既定 5）・`alerts.mergeWindowMin`（整数 15〜1440、既定 60）・`alerts.queueWaitMinutes`（整数 1〜1440、既定 15）・`alerts.sourceDownTicks`（整数 2〜10、既定 2）を許可。`alerts.notify`・`alerts.runnersMin`・`alerts.docker` は名指しで拒む | 40 |
| `scripts/flow/record.mjs` | 変更 | `alerts.jsonl` の読み（最後の 4 MB）・`kind: alert`・`alert-eval` | 60 |
| `tests/unit/scripts/flow/alerts-4367.test.ts` | 新規 | 表 T4・T6（確定の直列と回復）・T9（PR1b の変異） | — |
| `changelog.d/4367.md` | 変更 | 同じ 1 項目へ統合 | — |

#### 受入基準

1. 表 S3 の全セル（4 種の警報 × 前の状態 3 × 入力 3、`source-down` の入力の 6 行 × 取得元 3）が `alerts.jsonl` の書き込みで再現する
2. scope が違う行（同じリポジトリの別の base・別の取得元）で、前の状態が変わらない（I-5）
3. 表 S3R の全行
4. 同じ tick を 2 回確定しても出来事は 1 回（`eventId` の冪等）
5. pr が回復しても ci の `source-down` と `ci-queue` は消えない（陰性: ci も回復すれば消える）
6. 表示は書けた出来事だけ（書き込みの失敗で表示 0）
7. `alerts.notify` は exit 2
8. 表 T9 の PR1b の変異の対照が赤

gates・確かめのコマンドは PR1a と同じ（`tests/setup.ts` は変えないが、`unit` を外さない: 状態の確定は全体の試験で見る）。

---

## 7. 試験の表（行の形は `it.each` に写せる。実装はしない）

**先に赤**: 各 PR の最初のコミットで、各モジュールを `throw new Error('not implemented')` だけの export で置き、表の全行が赤になることを確かめる。これは「関数を呼んでいる」証拠でしかないので、**防御ごとの感度は表 T9 の変異の対照で別に示す**。陽性の対照は「この入力で鳴る／確定値になる」、陰性は「この入力では変わらない」。対照の作り方は §6.1 の「試験の隔離」。

### 表 T1: 設定と識別

| # | 入力 | 期待 | 種 |
|---|---|---|---|
| 1 | `flow.yaml` 無し・`origin/develop` あり | `base=develop`・`exclude ⊇ {develop, main, master}`・`tz` はプロセスの TZ・`intervalSec=900` | 陽性 |
| 2 | 無し・develop 無し・`origin/HEAD → main` | `base=main` | 陽性 |
| 3 | 無し・どちらも無い | exit 2「base を決められない」 | 陽性 |
| 4 | `base: trunk` | `base=trunk` | 陽性 |
| 5 | `exclude: [release]` | `{release, develop, main, master}` | 陽性 |
| 6 | 壊れた YAML／64 KB 超／EACCES | exit 2、記録・ロック 0 | 陽性 |
| 7 | 知らないキー | exit 2、キーを名指す | 陽性 |
| 8 | `alerts`（PR1a）／`wip`／`train` | exit 2「後の PR／他の子のキー」 | 陽性（呼び手の無いキーを拒む。§5） |
| 9 | `intervalSec` に `0`・`-1`・`1.5`・`"900"`・`.nan`・`.inf` | exit 2 | 陽性 |
| 10 | `lookbackDays: 31`・`runLookbackHours: 0` | exit 2 | 陽性 |
| 11 | origin `git@github.com:Kewton/CommandMate.git`／`https://github.com/Kewton/CommandMate` | `repo=Kewton/CommandMate`、slug `kewton.commandmate` | 陰性 |
| 12 | origin が GitHub でない・origin 無し | exit 2（I-6）、記録・ロック 0 | 陽性 |
| 13 | linked worktree から（`--git-common-dir` が相対で返る） | 主 worktree の root を絶対で解決し、`ledger.runsDir` をそこから | 陽性 |
| 14 | `--tz Mars/Base`／`--tz Asia/Tokyo` と設定の `tz: UTC` | exit 2／引数が勝つ | 陽性 |
| 15 | 2 つのリポジトリ（別の origin） | slug が別・ファイルが別 | 陰性 |

### 表 T2: 取得元 × 結果（表 S2、F1・F4 の対照）

| # | 取得元 | 差し替えた応答 | 期待 `sources` | 期待の値・`complete` | 種 |
|---|---|---|---|---|---|
| 1 | pr | 両方 exit 0、0 件 | `ok` | `openPrs=0`・`mergedInWindow=0`・`prToMergeMin={n:0,median:null,max:null}`・true | 陰性（完全な空＝0） |
| 2 | pr | 開いた PR が 500 件ちょうど | `truncated` | `null`・false | 陽性 |
| 3 | pr | 開いた PR は exit 0、マージの照会が exit 1 | `fail` | グループ全部 `null`（開いた PR も） | 陽性 |
| 4 | pr | 2 つの照会に同じ PR | `ok` | 1 回だけ数える | 陽性 |
| 5 | ci | run 31 本 | `truncated` | `null`・`hints.ci.queuedJobsSeen` あり | 陽性 |
| 6 | ci | 31 本目だけ長く待つ job | `truncated` | `oldestQueuedMin=null`（30 本の最大を確定値にしない） | 陽性 |
| 7 | ci | jobs の 2 ページ目が exit 1 | `fail` | `null` | 陽性 |
| 8 | ci | `total_count: 120` で読めたのは 100 | `truncated` | `null` | 陽性 |
| 9 | ci | queued 0・in_progress 0 | `ok` | `queuedJobs=0`・`oldestQueuedMin=null`・true | 陰性 |
| 10 | ci（過去） | 窓の 4 時間前の run に窓の中の job（lookback 6 時間の内） | `ok` | その job を数える | 陽性 |
| 11 | ci（過去） | lookback の端の 1 時間の run に窓の中の job | `truncated` | `null` | 陽性 |
| 12 | ledger | `send` の行が壊れている | `fail(corrupt)` | `null`（WIP を 0 にしない）・`hints` に読めた値 | 陽性 |
| 13 | ledger | `merge` の行が壊れている | `fail(corrupt)` | `null`（終わった item を未マージにしない） | 陽性 |
| 14 | ledger | 最後の行だけ改行で終わらない | `ok` | その行を除いて数える | 陰性（書きかけ） |
| 15 | ledger | 8 日前に `send ok`、未マージ（lookback 7） | `ok` | 数えない（名前が「lookback 内」なので正しい） | 陰性 |
| 16 | ledger | `send ok` の後に `merge fail` だけ | `ok` | WIP に入る | 陰性 |
| 17 | ledger | 同じ行の重複 | `ok` | 1 つに数える | 陽性 |
| 18 | ledger | 設定・引数なし | `absent` | `null` | 陽性 |
| 19 | load | `loadavg` が `[NaN,1,1]` | `fail(schema)` | `null` | 陽性 |
| 20 | pr | `createdAt` が時刻として読めない | `fail(schema)` | `null` | 陽性 |
| 21 | pr ok・ci fail | — | `pr: ok`・`ci: fail` | `flow.pr` 確定・`ci` は `null` | 陰性（片方の故障で他方は残る） |

### 表 T3: 集計（§2.3）

| # | 入力 | 期待 |
|---|---|---|
| 1 | マージが 18:59:59 と 19:00:00（`tz=Asia/Tokyo`） | 18 時に 1、19 時に 1 |
| 2 | `closedAt` が t ちょうど | t で数えない |
| 3 | マージされずに閉じた PR | `closedAt` で抜け、マージ数に入らない |
| 4 | job `skipped`・`started_at: null` | 順番待ちに入れない |
| 5 | 中央値の母集団 2 つ（偶数） | 2 つの平均 |
| 6 | 母集団 0 | `n:0`・`median:null`・`max:null` |
| 7 | `tz` を `UTC` | 時の分け方だけ変わり総数は同じ（陰性） |
| 8 | 窓の前から開いていて窓の後に閉じた PR | 窓の全時刻で開いた PR に入る |

### 表 T4: 警報（表 S3、PR1b。F2・F4 の対照）

警報 4 種 × 前の状態 {`ok`, `firing`, `unknown`} × 入力 {breach, clear, 未知} の 36 セルと、次の個別の行。

| # | 状態 | 入力 | 期待 | 種 |
|---|---|---|---|---|
| 1 | `develop` で `open-prs` が firing | 同じリポジトリの `release` の tick で clear | develop は firing のまま | 陽性（F2） |
| 2 | `source-down(pr)` と `(ci)` が firing | pr だけ ok | pr は resolved、ci は firing | 陽性（F2・F4） |
| 3 | 同じ時刻に 2 つの scope の同じ id | 両方 breach | 2 つの `fired`（eventId が別） | 陰性 |
| 4 | — | pr ok・ci fail が 2 回続く | `source-down(ci)` fired | 陽性（F4） |
| 5 | `ci-queue` firing | pr ok・ci fail | `ci-queue` は消えない | 陽性（F4） |
| 6 | — | fail → 壊れた tick の行 → fail | 未知（鳴らさない） | 陽性（I-8） |
| 7 | — | fail → denied → fail | 未知 | 陽性 |
| 8 | — | fail → （間隔 2 × intervalSec 超） → fail | 未知 | 陽性 |
| 9 | `source-down(ci)` firing | ci `truncated` | 消えない | 陽性 |
| 10 | `source-down(ci)` firing | ci ok | resolved | 陰性（完全な回復） |
| 11 | — | `no-merge`: マージ 0・`openPrs=0` | 何も書かない | 陰性 |
| 12 | — | `openPrs=5`・`openPrMax=5` | 何も書かない（`>` だけ） | 陰性 |
| 13 | — | `mergeWindowMin: 120` で 90 分前にマージ 1 | `no-merge` は鳴らない | 陽性（窓の一致） |
| 14 | 履歴の scope の最後の行が壊れている | clear | 何も書かない | 陽性 |

### 表 T5: 期限と書き込み（表 S1、F5 の対照）

| # | 入力 | 期待 | 種 |
|---|---|---|---|
| 1 | 最後の取得が `Tf` の 1 ms 前に返る | 値を使う | 陰性 |
| 2 | 取得が `Tf` の 1 ms 後に返る（`deps.now` を進める） | その結果を捨てて `timeout`、記録は 1 行 | 陽性 |
| 3 | 子が SIGTERM を無視する（`deps.run` は `spawnSync` に渡した `killSignal` を検査） | `killSignal: 'SIGKILL'`・`timeout ≤ Tf − now` で呼ばれる | 陽性 |
| 4 | 取得の途中で `Tf` | 残りの取得元を呼ばない・`timeout` | 陽性 |
| 5 | `deps.run` が throw | その取得元を `fail`、tick は続く | 陽性 |
| 6 | 記録の段で `now > Te` | 書かずに exit 1 | 陽性 |
| 7 | 記録の dir が読み取り専用 | exit 1、`alerts.jsonl` も書かない | 陽性 |
| 8 | 最後の行が改行で終わらない | 改行を足して 1 行 | 陽性 |
| 9 | `appendFileSync` の呼び出し回数 | 記録 1 回、警報 1 回以下（PR1b） | 陽性（I-12） |
| 10 | `CM_FLOW_DIR` あり | その下だけに書く | 陰性 |

### 表 T6: 排他・直列・回復（表 S0・S3R、F3 の対照）

| # | 入力 | 期待 | 種 |
|---|---|---|---|
| 1 | 生きた持ち主のロックがある | 何も書かずに exit 0、stderr 1 行 | 陽性 |
| 2 | 持ち主の pid が ESRCH | 部品が回収し、tick を行う | 陰性 |
| 3 | 観測できない（`deps.lock` が `unknown` を返す） | exit 1、何も書かない | 陽性 |
| 4 | 2 つの tick を同じ前の状態の直前で止める（barrier。`deps.lock` に本物の部品と一時の root） | 後の tick は排他で飛ぶ。`fired` は 1 回 | 陽性 |
| 5 | 前の tick が記録の後・警報の前で落ちた（印なし） | 次の tick が先にその tick を評価、出来事は 1 回 | 陽性（PR1b） |
| 6 | 前の tick が出来事の追記の途中で落ちた | 閉じた行を捨て、書けていた `eventId` は二重にしない | 陽性（PR1b） |
| 7 | 印の無い tick が 2 つ | 最後の 1 つだけ回復 | 陽性（PR1b） |
| 8 | この tick の `at` が確定済みの最後より前 | 評価しない | 陽性（PR1b） |
| 9 | 単独の tick を続けて 2 回、同じ breach | `fired` は 1 回 | 陰性 |

### 表 T7: 再現（§8）

| # | 入力 | 期待 |
|---|---|---|
| 1 | fixture | §8.3 の取得したセル全部、`—` は `null` |
| 2 | fixture・台帳なし | 台帳の列だけ `null`（陰性） |
| 3 | §8.4 の証人 | 各 1 行 |
| 4 | fixture の `meta.json` の照会と、`reconstruct` が `deps.run` へ出した照会 | 一致（取得の条件が fixture に結ばれている） |

### 表 T8: CLI と外部のコマンド（I-14）

| # | 入力 | 期待 |
|---|---|---|
| 1 | `tick`・`reconstruct` | `deps.run` が受けたのは `gh pr list`・`gh api`（`-X`／`--method` 無し、または GET。`-f`／`-F`／`--input` 無し）・`git remote get-url`・`git rev-parse`・`git symbolic-ref` だけ |
| 2 | 変異: `gh api -X POST`・`gh pr merge`・`gh run rerun`・`git fetch`・`git push` を返す取得元の差し替え | 許可の検査が赤 |
| 3 | `report`・`status` | `deps.run` を呼ばない |
| 4 | §6.1 の引数の表の各誤り | exit 2 |

### 表 T9: 変異の対照（防御を 1 つずつ外すと、対応する試験が赤）

変異は試験の中で関数の差し替え（`deps` か、変異を入れた写しを import）で作り、実装のファイルを書き換えない。

| # | 外す防御 | 赤になるべき試験 | PR |
|---|---|---|---|
| M1 | 上限に当たっても値を出す | T2-2・5・6・8・11 | 1a |
| M2 | `null` を 0 にする | T2-3・7・12・13、T4 の未知の列 | 1a・1b |
| M3 | `hints` を警報の入力に使う | T4 の未知の列（`hints` があっても動かない） | 1b |
| M4 | scope の絞り込みを外す | T4-1・2・3 | 1b |
| M5 | 排他を外す | T6-1・4 | 1a |
| M6 | `eventId` の重複の確認を外す | T6-5・6・9 | 1b |
| M7 | 期限後の結果を採る | T5-2・4 | 1a |
| M8 | 連続性の欠けを無視する | T4-6・7・8 | 1b |
| M9 | pr の回復で ci の警報を消す | T4-2・5 | 1b |
| M10 | 書けなかった出来事も表示する | §6.2 の受入 6 | 1b |

---

## 8. 2026-11-13 の実データからの再現（受入の確かめ方）

### 8.1 取得元と期間

- 期間: 2026-11-13 10:00〜22:00 JST（表）。CI の列は 13:00〜20:00 JST だけを取った（Epic の自走の窓 13:10〜19:00 を含む時の区切り）
- GitHub の PR: 設計の段では `--search "created:2026-11-12..2026-11-14"`（49 本）と `--search "created:<2026-11-12 closed:>=2026-11-12"`（1 本、#4312。11-12 13:24 JST に閉じたので 11-13 の値には効かない）で取った。**PR1a の fixture は §2.4 の過去の照会（開いた PR ＋ `updated:>=<窓の開始>`）で取り直す**（作成日で切ると前から開いていた PR を落とす）
- GitHub の run と job: `gh api --paginate "repos/Kewton/CommandMate/actions/runs?created=2026-11-13T01:00:00Z..2026-11-13T11:00:00Z&per_page=100"`（61 本、窓の開始の 3 時間前から）の各 run の `jobs?per_page=100&filter=latest`。job の `created_at` が 13:00〜20:00 JST のものだけ数える（窓の前に作られた run の job が 1 本ある）
- 台帳: `workspace/orchestration/runs/2026-11-13/run-*.jsonl` と `2026-11-14/run-*.jsonl`（11-13 に効くのは `run-3574-4317.jsonl`）
- 取得は 2026-11-14 の読み取り（GitHub の設定は変えていない）

### 8.2 期待値の出し方と fixture への結び付け

1. **期待値は計測の実装とは別の実装で出し、製品の集計で作り直さない**。§8.3 の値は、設計の段で Python の短いスクリプト（§2.3 の定義を直接書いたもの）で出した。**このスクリプトと母集団の証跡は設計の PR には入っていない**（scope の外）。独立した正しさは §8.4 の手計算の証人で補い、PR1a で fixture と一緒に確かめる
2. PR1a は照会の結果を fixture に写す。写すのは番号・時刻・状態・ID（PR の `number`、run の `id`・`created_at`・`run_attempt`、job の `id`・`created_at`・`started_at`・`conclusion`）だけ。ブランチ名・題名・`note` は写さない
3. `meta.json` に raw の取得条件を書く: 各照会のコマンドと引数・取得した時刻（UTC）・ページ数・`total_count`・読んだ件数・ID の集合の sha256・`filter=latest` で取ったこと。表 T7-4 は `reconstruct` が出す照会と `meta.json` の照会が一致することを確かめる
4. 中央値の対象の値の列（時ごとの job の待ちの並び）も `meta.json` に置き、§8.3 の中央値・最大がその列から出ることを試験で確かめる
5. fixture を取り直して §8.3 と食い違ったら、どちらの定義の読みが違うかを先に確かめ、表を勝手に直さない。直すときは本書を改訂する
6. GitHub の job の記録の保存期間は未確認。fixture は後から取り直せない日に備える

### 8.3 期待値（事実: 2026-11-14 の取得。時は JST、「時の開始」は hh:00:00）

| 時 | PR の作成 | マージ | 時の開始の開いた PR | 時の開始の台帳の WIP（lookback 内） | CI の job の数 | 順番待ちの中央値（分） | 最大（分） |
|---|---|---|---|---|---|---|---|
| 10 | 0 | 2 | 4 | 5 | — | — | — |
| 11 | 0 | 1 | 2 | 3 | — | — | — |
| 12 | 1 | 1 | 1 | 2 | — | — | — |
| 13 | 2 | 1 | 1 | 2 | 52 | 0.8 | 17.9 |
| 14 | 4 | 1 | 2 | 9 | 85 | 13.0 | 47.6 |
| 15 | 2 | 2 | 5 | 16 | 121 | 7.5 | 39.9 |
| 16 | 3 | 1 | 5 | 16 | 135 | 12.9 | 56.7 |
| 17 | 1 | 0 | 7 | 16 | 36 | 0.1 | 34.2 |
| 18 | 5 | 0 | 8 | 18 | 83 | 0.1 | 44.2 |
| 19 | 0 | 6 | 13 | 18 | 143 | 0.0 | 64.6 |
| 20 | 0 | 2 | 7 | 12 | — | — | — |
| 21 | 0 | 1 | 5 | 10 | — | — | — |

- `—` は**未取得**で、0 ではない。試験では `null` として扱い、0 と比べない。PR1a で fixture を 10〜21 時へ広げたら、表を本書の改訂で足す
- 台帳の WIP は、設計の段では台帳の dir 2 つ（11-13・11-14）の全行から数えた。§2.3 の lookback（7 日）の定義とは母集団が違いうる（11-13 より前の dir の `send` を読んでいない）。PR1a で fixture を lookback の定義どおりに取り直し、値が変わったら本書を改訂する（**未確認**）
- 台帳のマージ（`merge ok`）は 13〜19 時で GitHub のマージと一致した（1・1・2・1・0・0・6）
- Epic との照合: 19 時の開いた PR 13 は Epic の「13 本」と一致。16:40（#4349）の後 19:02 まで 0 で「16:40〜18:57 マージ 0」と一致。Epic の「13 時 2/0」は 2/1（13:05 の #4342 が Epic の窓 13:10〜の前）。Epic の「CI の中央値 22 分・最長 78 分」は定義が書かれておらず、run の `created_at → updated_at` で取ると `pull_request` 27 本で 46.4／109.9 分、`push` 11 本で 22.1／98.7 分（未確認、§13）

### 8.4 手計算の証人（PR1a の試験に 1 行ずつ）

| # | 証人 | 期待 |
|---|---|---|
| W1 | #4342 の `mergedAt` は 13:05 JST | 13 時のマージに入る（Epic の窓 13:10〜では数えない） |
| W2 | #4349 の 16:40 の後、次のマージは #4358 の 19:02 | 17・18 時のマージ 0、19 時の開始の開いた PR 13 |
| W3 | 19 時にマージされた 6 本（#4358 19:02・#4359 19:03・#4356 19:06・#4360 19:06・#4362 19:08・#4352 19:10） | 19 時のマージ 6 |
| W4 | 18:59:59 と 19:00:00 のマージ（合成の 2 行） | 18 時と 19 時に 1 つずつ |
| W5 | `closedAt` が 15:00:00 ちょうどの PR（合成） | 15 時の開始の開いた PR に入らない |
| W6 | 窓の前（12:59 以前）に作られた run の、13 時台に作られた job（fixture の ID で名指す） | 13 時の CI の job に入る |
| W7 | 13 時の job の待ちの列（fixture に固定、52 個） | 中央値 0.8・最大 17.9 |
| W8 | 窓の前から開いていて 19 時台に閉じた PR（fixture から名指す） | 13〜19 時の開始の開いた PR に入る |

---

## 9. ダッシュボードの第 1 段（推奨）

**推奨: 第 1 段は Artifact の試作。載せるのは数だけ（PR 番号・ブランチ名・題名・パスを載せない）。画面（Flow のページ）は試作で「何を先頭に置くか」が決まってから PR5 で作る。**

理由:
- 何を一目で見せるか（健康の緑黄赤の決め方・最長の待ちの強調・スマホで先頭に何を置くか）がまだ決まっていない。製品の画面で試すと、決め直すたびに画面の PR とレビューが回る。Artifact なら PM が `report --json` の出力から作り直せ、製品のコードを変えない
- 計測の出力の形（`report --json`）を画面の前に人の目で確かめられる

試作の形:
- 入力: `node scripts/flow/flow.mjs report --from <窓の開始> --to <窓の終わり> --json`（時間ごとの系列・今の値・警報の履歴）。`null` は欠測として描き、0 や緑で埋めない（I-1）
- 区画の順: 健康（緑黄赤と、赤の理由 1 行。欠測が 1 つでもあれば灰）→ 流れ（時間ごとのマージ数・開いた PR と上限・PR→マージの中央値）→ 詰まり（工程ごとの待ち、最長を強調）→ 資源（PR2 の後）→ 品質（PR4 の後）→ 警報の履歴
- 受入（試作の段）: 幅 1280 と 390 で、健康と流れがスクロールせずに読める

人の判断（H4）: Artifact は claude.ai に置かれる（外へ出る）。

---

## 10. 人の操作・人の判断

実機への導入（launchd の登録・設定ファイルの作成・Artifact の公開）はこの run の範囲外。突き合わせの決定のとおり、どれも PR1a・PR1b の実装を止めない。

| # | 判断 | 選択肢 | 推奨と理由 |
|---|---|---|---|
| H1 | 15 分ごとの `tick` を何で起こすか | (a) launchd の利用者の agent（`StartInterval 900`）／(b) CommandMate の Schedule／(c) PM が手で | **(a)**。計測はサーバー・エージェント・Docker が止まった時こそ動いていなければならない。登録は人の操作 |
| H2 | 警報の閾値の既定 | 開いた PR 5・マージ 0 の 60 分・順番待ち 15 分・取得元 2 回 | **Epic の「運用で先に入れること」の値をそのまま既定**に |
| H3 | 台帳の場所 | (a) `flow.yaml` の `ledger.runsDir: workspace/orchestration/runs`（主 worktree の root から）／(b) 引数・環境変数だけ | **(a)**。マシンの絶対パスを持ち込まず、どの worktree からでも同じ台帳を読む。このリポジトリへの `flow.yaml` のコミットは人の承認の後（X7） |
| H4 | 計測の値を外（Artifact）へ出す範囲 | 数だけ／PR 番号まで／ブランチ名まで | **数だけ** |
| H5 | 警報の送り先（PR3） | `alerts.notify` に PM を書く／書かない | **PR3 が入っても最初の 1 週は書かない**（誤報の率を見てから） |
| H6 | 記録の保存期間 | 消さない／90 日で消す | **当面は消さない**（消す仕組みは削除を伴うので別の PR で承認） |
| H7 | ランナーの API の権限（PR2） | 今の資格／専用のトークン | **今の資格**。403 なら `denied` |

---

## 11. 他の子への約束

突き合わせの決定 X1〜X7 に従う。

| 相手 | 提供／利用 | 形 | 単位・意味 |
|---|---|---|---|
| #4368（WIP） | #4367 が**提供** | `scripts/flow/config.mjs` の `readFlowConfig`（PR1a）。#4368 は `wip` 節を同じ読み手の許可リストへ足す（X1・X6: #4368 PR1 は #4367 PR1a のブランチから切る）。PR1a は `wip` を exit 2 で拒む | scope は `repo`＋`base`（I-5）。#4368 の記録・判定も同じ scope で選ぶ |
| #4368 | #4367 が**利用**（PR4） | `countWip(input) → { unmergedBranches, activeBranches }`（純関数）と取得 `readWipInput(repoRoot, { run, now }) → { ok: true, input } \| { ok: false, reason }` | `ok: false` は `null`（I-1）。#4367 は数え方を持たない。**#4368 に頼むこと**: 取得は時間切れつき、上限に当たったら `ok: false`（I-2）、`exclude` は #4367 の読み手から受け取る |
| #4369（merge train） | #4367 が**提供**（書き手） | `kind: train` の行の書き手は、**#4369 の PR3 が呼び手と同じ PR で `scripts/flow/record.mjs` に足す**（X2）。語彙は #4369 の語彙（`created`・`pushed`・`ci`・`merged`・`dropped`・`rebuilt`・`stopped`）。1 回目の本書 §11 の語彙は案として取り下げた | 書き手の共通の形（`v`・`kind`・`at`・`repo`・`base`・1 行・改行なし・追記だけ・千切れた行の閉じ方）は PR1a の `appendTick` と同じ部品を使う。書けなくても train は止めない（I-17: 計測の記録を train の判定に使わない） |
| #4370（資源） | #4367 が**利用**（PR4） | #4370 が書き続ける `<lock root>/cpu.sem/events.jsonl` を #4367 が読む（X3、`_machine` の slug は作らない） | マシン単位。読めない・壊れた行は未知（I-1）。形は #4370 の設計に従う |
| #4370 | #4367 が**提供** | 計測の記録（`resource.*`・`ci.oldestQueuedMin`、PR2 から `resource.runners*`・`resource.docker`）を `readTicks` で読んでよい | `null` を 0 や「空き」と読まない。**計測の値を受付・枠・マージの許可に使わない**（I-17。使うなら自分の取得で確かめる） |
| 全員 | 共通 | 警報は「記録＋画面」が先。PM への送信は `alerts.notify` を明示したときだけ（共通の枠 §3）。警報の id は `<子の語>-<事象>` で重ねない。計測の `null`・`resolved`・`ok` を verify・precheck・CI・merge・send の許可の代わりにしない（I-0） | — |

---

## 12. 既存の仕組みの再利用の可否

| 既存 | 使う／使わない | 理由 |
|---|---|---|
| `run-log.mjs` | 千切れた行の閉じ方を写す。読み手は使わない | F1・F2（単独の書き手の形で、日をまたぐ多数の台帳の読みにも合わない） |
| `pr-common.mjs` の `withGhRetry`・`ghJson`・`DEFAULT_REPO` | **使わない** | F4・F5・F6 |
| `pr-common.mjs` の `GH_TRANSIENT_PATTERN` | 使う（`why` の理由の分類だけ） | 判定は同じでよい |
| `merge-pr.mjs` の `mergeLockName` | 形を写す（repo-slug） | F7 |
| `machine-lock-sync.mjs` の `acquireMachineLockSync` | **PR1a で使う**（`flow.<repo-slug>`、`timeoutMs: 0`）。PR3 の送信も同じ排他の中 | F8・F9。所有（pid・host・token・起動時刻）と死んだ持ち主の回収を部品のまま使う |
| `precheck.mjs` の `machineLockRoot` | 使う（ロックの root） | F10 |
| `merge.*`・`cpu.heavy` | 使わない | I-17 |
| `metrics-runners.ts` の `runCommand` | 使わない（同期の `spawnSync`＋SIGKILL にする） | F13 |
| `ci-flaky.ts` | 使わない | F12 |
| `/api/metrics/vibe` | PR4 で API 越しに | F14 |
| `verify-config.ts` | 流儀だけ揃える | F16 |
| self-hosted ランナーの scripts | 使わない・読まない | リポジトリの外。ランナーの状態は GitHub の API から |

---

## 13. 未確認・見立て・未決と、本文に無い指摘

### 13.1 未確認

- GitHub の job の `created_at` が `needs` で後に回る job でいつ付くか（値の意味が変わる。PR1a の実装の契約で 1 本の run を見て確かめる）
- GitHub の job の記録の保存期間（§8.2）
- 権限の無いリポジトリでランナーの API が 403 か 404 か
- §8.3 の台帳の WIP の母集団が lookback の定義と一致するか（§8.3）
- Epic の「CI の中央値 22 分・最長 78 分」の定義

### 13.2 見立て

- 1 日の記録は 96 行・1 行 1〜2 KB
- `spawnSync` に SIGKILL を渡せば、子がカーネルの中で止まっていない限り期限内に戻る
- 15 分の間隔では tick が重ならない（排他で飛ぶのは手で動かした時や遅い tick の時だけ）
- PR1a は本体約 1150 行・試験を合わせて 2000〜2500 行

### 13.3 未決（誰が決めるか）

| # | 未決 | 決める人 | 本書の仮の値 |
|---|---|---|---|
| U1 | GitHub でない origin（ローカルだけのリポジトリ・他のホスト）の識別の作り方 | 開発リーダー（必要になった時に別の Issue で） | PR1a・PR1b は exit 2 で拒む |
| U2 | `runLookbackHours` の既定（6） | 実装の契約（PR1a）で 2026-11-13 の fixture の「窓の前の run の job」の最大の遅れを測って決める | 6 |
| U3 | CI の順番待ちを attempt の最新だけで数えるか、全部で数えるか | PM（指標の意味の選択） | 最新だけ（`filter=latest`） |
| U4 | tick の予算（取得 200 秒・全体 240 秒）と `intervalSec` の既定 | H1 の決定の後に PM | 200・240・900 |
| U5 | ダッシュボードの健康の緑黄赤の閾値 | 人（Artifact の試作を見て） | 警報が 1 つでも firing なら赤、欠測があれば灰 |
| U6 | `source-down` に `truncated` が続く時の知らせ（今は鳴らさない） | 開発リーダー（PR1b のレビューで） | 鳴らさない。`status` に上限に当たった回数を出す |

### 13.4 本文に無い指摘（直さない）

- Issue の「元は … CommandMate の DB（verify・task）」は DB のファイルを直接読むと読めるが、本書は API 越しに限った（I-14）
- Epic の時間帯ごとの作成／マージの数は窓の区切り（13:10〜）で数えていて、時の区切りの数と 13 時だけ違う（§8.3）

---

## 14. 改訂 1 の処置（2-4-4 事前レビュー `prereview-4367-reply.md` と再指示 1）

| 指摘 | 処分 | 反映した場所 |
|---|---|---|
| 守るべき条件（1 文） | 最上位の不変条件 I-0 にした | §1 |
| F1（部分集合を確定値として数える） | 直す。値のグループごとの完全性・上限で未知・`hints` を別にして警報の入力にしない・PR の照会の重複を ID で除く・`mergeWindowMin ≤ 1440` で照会の窓が警報の窓を覆う・台帳の数を「lookback 内」と名付ける | I-1〜I-4、§2.2〜§2.5、表 S2、T2、T9 M1〜M3 |
| F2（状態のキー） | 直す。scope＝repo＋base（source-down は＋取得元）、GitHub でない origin は PR1a で exit 2（狭めて塞ぐ。U1） | I-5・I-6、表 S3、T1-12・15、T4-1〜3、T9 M4 |
| F3（同時 tick と部分の確定） | 直す（狭めて塞ぐ）。tick は `flow.<repo-slug>` の排他で同時起動を拒む（machine-lock-sync の部品の流用）。警報の確定は排他の中で 読む → 回復 → 評価 → 1 回の追記、`tickId`・`eventId` で冪等、古い観測で上書きしない | I-9〜I-11、表 S0・S3R、T6、T9 M5・M6 |
| F4（取得元の健康） | 直す。取得元を pr・ci・ledger・load に分け、ci だけの故障は ci の source-down へ。欠測・壊れた履歴・denied／absent を挟む連続性は未知で警報を保持 | I-7・I-8、表 S3、T4-4〜10、T9 M8・M9 |
| F5（期限の終端） | 直す。期限の起点・取得と全体の予算・SIGKILL・期限後の結果の破棄・書き込み高々 1 回。ローカルの I/O の無期限の停止は前提の外と明記 | I-12、表 S1、§4 の末尾、T5、T9 M7 |
| F6（通知の上限） | 直す（PR3 の節）。送信前の試行の印・試行 ID・結果不明は試行に数える・上限で打ち切り。PR1a・PR1b は送信の設定を拒む | I-13、表 S4 |
| P3（試験の感度） | 直す。変異の対照の表 T9 を足し、F1〜F5 の陽性・陰性の対照を各表に足した | §7 |
| P3（§8 の独立性） | 直す。期待値を製品で作り直さない・手計算の証人 W1〜W8・raw の取得条件と ID 集合を `meta.json` に結ぶ・`—` は未取得で 0 と比べない。Python の証跡は設計の PR に無いことを明記 | §8.2〜§8.4、T7 |
| P3（T1 の入力軸・CLI の引数） | 直す。linked worktree・相対の `--git-common-dir`・repo／base／tz・数の型（NaN・Infinity・小数・0）・`mergeWindowMin` の窓・空の母集団。`--tz`・`--ledger-dir` を引数の契約に | §6.1 の引数の表、T1、T3-6 |
| P3（PR1 の規模） | 直す。PR1a・PR1b に分け、実パスで数え直し、行数を見積った | §5・§6 |
| P3（tests/setup.ts の隔離） | 直す。case ごとの mkdtemp・env の復元・既定の home の試験で本物の home へ落とさない | §6.1 の「試験の隔離」 |
| P3（gh の許可の検査） | 直す。method と引数まで検査し、書き込みのコマンドの変異で赤 | I-14、T8 |
| X2（train の語彙） | 従う。#4369 PR3 の語彙に揃え、本書の語彙は取り下げた | §11 |
| X3（マシンの出来事） | 従う。`cpu.sem/events.jsonl` を PR4 で読む | §5・§11 |
| X1・X6・X7 | 従う | §11・§10 H3 |

---

## 改訂の履歴

- 改訂 1（2026-11-14）: 事前レビュー（codex-2、P2 6 件）と再指示 1・突き合わせの決定 X1〜X7 を反映。I-0 を最上位に、PR1 を PR1a（計測）・PR1b（警報）に分け、完全性・scope・排他と tick ID・取得元の健康・期限・通知の試行の記録を決め、変異の対照と再現の証人を足した（§14）
