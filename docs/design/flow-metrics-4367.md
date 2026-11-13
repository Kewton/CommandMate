# Issue #4367: チームの流れの計測・警報と人向けのダッシュボード（設計）

- 状態: **設計（上流の 1 回目）**。この文書だけを書き、`src/`・`scripts/`・`tests/` の試験は変えない。実装はこの文書のレビューの後、§6 の PR1 の契約から始める
- 正本: Issue #4367 の本文、Epic #4371 の本文（背景の実測）、段 3 の共通の枠（開発リーダーの決定、2026-11-14。`workspace/orchestration/runs/2026-11-14/s3-common-frame.md`。以下「共通の枠」）。本書は共通の枠と食い違わない。共通の枠に無いことを新しく決めたものは §11「他の子への約束」に集めた
- 基準: develop **`a334a013f`**（v0.51.1、2026-11-14 に `git fetch` した `origin/develop`）。file:line はこの版。行番号は古くなるので名前で引くこと
- 表記: **事実**＝コードを読んで、または読み取りのコマンドを実行して確かめたこと。**見立て**＝事実からの推論で、試していないこと。**未確認**＝この段で確かめていないこと
- 他の子（#4368・#4369・#4370）の設計は並行して書かれているので読んでいない。約束は共通の枠 §3 に従う

## 結論（一覧）

| 段 | 中身 | 節 |
|---|---|---|
| 不変条件 | 13 本（I-1〜I-13）。分からないは 0 と書かない・計測は何も変えない・DB のファイルを開かない・警報は記録が先で送信は明示したときだけ・送信は既存の `send` の経路と前景の確認を通る・CommandMate 固有の値を埋め込まない ほか | §1 |
| 記録の形 | `~/.commandmate/flow/<repo-slug>/<YYYY-MM-DD>.jsonl` に 1 回の計測（tick）を 1 行。`alerts.jsonl` に警報の出来事を 1 行。どちらも `v: 1`。分からない値は `null` と、その理由を `sources` に | §2 |
| 状態と遷移 | 表 S1（tick の段）・表 S2（取得元ごとの結果 → 記録）・表 S3（警報の状態 × 入力）・表 S4（PM への送信。PR3） | §3 |
| 失敗の倒れ方 | `gh`・git・台帳・設定・記録の書き込み・load・ランナーの API・Docker・CommandMate の API・`capture`／`send` の 10 種。**計測は fail-open（分からないとして記録して続ける）、書き込みと送信は fail-closed（書けなければ送らない・確かめられなければ送らない）** | §4 |
| PR の切り方 | PR1（設定の読み手・記録の書き手・GitHub と台帳の取得・時間ごとの集計・再現・流れの警報 3 種の記録）→ PR2（資源: ランナー・Docker と、その警報）→ PR3（PM への送信。送信の経路だけの PR）→ PR4（#4368 の WIP・③ エージェント・CommandMate の API・日次のまとめ）→ PR5（製品: `src/lib/flow/`・CLI `commandmate flow`・API・Flow の画面） | §5 |
| この run の PR1 | 変更するファイル 9 本・受入基準 10 本・gates は lint／typecheck／unit（`tests/setup.ts` を変えるため） | §6 |
| 試験の表 | 表 T1〜T7（設定・取得元・集計・警報・書き込み・再現・CLI の引数）。行の形は `it.each` にそのまま写せる | §7 |
| 再現の確かめ方 | 2026-11-13 の GitHub（PR・run・job）と台帳から、時間ごとのマージ数・開いた PR・台帳の WIP・CI の順番待ちを出す。期待値は本書 §8.3 の表（別の実装で出した） | §8 |
| ダッシュボード | **第 1 段は Artifact の試作（数だけを載せる）を推奨**。画面（Flow のページ）は PR5 | §9 |
| 人の判断 | 7 つ（計測の起動の仕組み・閾値の既定・台帳の場所・外へ出す範囲・送り先・記録の保存期間・ランナーの API の権限）。それぞれ推奨 1 つと理由 | §10 |

---

## 0. 前提の確かめ（事実）

| # | 事実 | 場所 | 本書での扱い |
|---|---|---|---|
| F1 | orchestrate の台帳は `<run-dir>/run-<issues>.jsonl` に 1 段 1 行の JSON。段は `contract/send/verify/review/findings/precheck/pr/ci/merge`、別に HEAD を持たない `queue` の行がある | `scripts/orchestrate/run-log.mjs:63`・`:69`・`:92` | 台帳の読み手（§2.4）。着手＝最初の `send ok`、マージ＝最初の `merge ok` |
| F2 | 台帳の書き手は最後の行が改行で終わっていなければ改行を足してから書く（落ちた書き手の千切れた行を閉じる）。読み手は読めない行を飛ばして報告する | `run-log.mjs:178-195`・`:201-222` | 計測の記録の書き手・読み手も同じ形にする（§2.1、I-9） |
| F3 | 台帳の run dir は `workspace/orchestration/runs/<開始日>/` で、1 本の台帳が日をまたぐ（2026-11-13 の dir の `run-3574-4317.jsonl` は 2026-11-13 01:21 〜 11-14 07:02 JST の 559 行） | 読み取りで確認 | 台帳はウインドウの開始日より前の dir も読む（`lookbackDays`、§2.4） |
| F4 | `DEFAULT_REPO = 'Kewton/CommandMate'`・`DEFAULT_BASE_BRANCH = 'develop'` が orchestrate のスクリプトに埋め込まれている | `scripts/orchestrate/pr-common.mjs:24`・`:26` | 計測は**これを import しない**。repo は `git remote`、base は設定か git の ref から決める（I-12） |
| F5 | 読み取りの `gh` は 502/503/504・接続の失敗のときだけ最大 4 回（10・30・60 秒の間隔）呼び直す。書き込みの `gh` は 1 回だけ | `pr-common.mjs:82-84`・`:92-99`・`:119-155` | 計測は `withGhRetry` を**使わない**（最長 100 秒の待ちが 15 分の tick を食う）。呼び直しは 0 回、時間切れつき（§4） |
| F6 | `defaultRun` は `spawnSync` に時間切れを渡していない | `pr-common.mjs:58-67` | 計測の `gh`・`git`・`docker` は必ず時間切れつきで呼ぶ（Docker が止まった日に `gh` や `docker` が戻らないと計測ごと止まる。I-7） |
| F7 | マージのロックの名前は `merge.<owner>.<repo>.<base>`（`/` は `.`、64 文字を超えると sha1 で縮める） | `scripts/orchestrate/merge-pr.mjs:313-317` | repo-slug の作り方を同じ流儀にする（§2.1） |
| F8 | 同期のマシンのロック `acquireMachineLockSync(name, { root, timeoutMs, … })` がある。ロックの root は `CM_VERIFY_LOCK_ROOT` か `~/.commandmate/locks` | `scripts/orchestrate/machine-lock-sync.mjs:1080`、`scripts/orchestrate/precheck.mjs:523-526` | PR3 の送信の直列化に `flow.<repo-slug>` で使う（§3.4）。計測（PR1）はロックを取らない。`cpu.heavy`（`precheck.mjs:115`）は**取らない**（計測は軽い） |
| F9 | `tests/setup.ts` は `~/.commandmate` の下を指す設定を pid ごとの一時パスに向けている（例 `CM_VERIFY_LOCK_ROOT`・`CM_RUN_LOCK_DIR`） | `tests/setup.ts:287-291` | `CM_FLOW_DIR` を同じ形で足す（共通の枠 §2、PR1） |
| F10 | `ci-flaky.ts` の `CiRun`／`CiJob` は `createdAt` は持つが job の `started_at`・`created_at` を持たない | `src/lib/agent-health/ci-flaky.ts:39-55`・`:135-156` | 順番待ちの計算には使えない。GitHub の job の読み手は新しく作る（§12） |
| F11 | 計測の道具の呼び出し `runCommand` はプロセスグループを作り、時間切れで SIGTERM → 5 秒後 SIGKILL する | `scripts/agent-health/metrics-runners.ts:130-165` | 同じ形を `.mjs` に写す（TS で `@/lib` を import するので `.mjs` から直接は使えない。§12） |
| F12 | `GET /api/metrics/vibe?days=N` は DB の `tasks`・`verification_runs`・`task_events` を読んで集計を返す（読み取りだけ）。CLI は `commandmate report metrics --days N --json` | `src/app/api/metrics/vibe/route.ts:18-40`、`src/lib/metrics/vibe-metrics.ts:329`、`src/cli/commands/report.ts:280-313` | CommandMate の DB（verify・task）は**この API 越しに**読む（PR4）。DB のファイルは開かない（I-4） |
| F13 | `capture --json` の応答は必ず `isRunning` を持つ | `src/cli/types/api-responses.ts:216-237` | PM への送信の前に CLI が動いていることをこれで確かめる（PR3、I-6） |
| F14 | 設定の YAML は `yaml` パッケージで読む（`verify-config.ts`・`agents-config.ts`・`contract.mjs`） | `src/lib/verification/verify-config.ts:12`、`scripts/orchestrate/contract.mjs:48` | `.commandmate/flow.yaml` も `yaml` で読む。`.commandmate/` の下の設定の流儀（`VERIFY_CONFIG_RELATIVE_PATH`、`verify-config.ts:165`）に揃える |
| F15 | ランナーの一覧 `gh api repos/Kewton/CommandMate/actions/runners` は今の資格で読める（2026-11-14 に 6 台・`status: online`、ラベル `self-hosted`・`Linux`・`ARM64`） | 読み取りで確認 | PR2 の取得元。権限が無いリポジトリでは 403 になる見立て（**未確認**）→ `unknown`（§4） |
| F16 | CI の job は `self-hosted` と `ubuntu-latest` の両方で走る（fork からの PR は ubuntu-latest） | `.github/workflows/ci-pr.yml:134` ほか | 順番待ちはラベルを問わず数え、内訳にラベルを残す（§2.3） |
| F17 | team.md §6 の 3（危険の境目で PR を分ける。送信の経路・ロックを画面と同じ PR に入れない）・4（API は呼び手と同じ PR） | `docs/orchestrate/team.md:64-76` | §5 の切り方の根拠 |

---

## 1. 不変条件

| # | 不変条件 | 守る場所 |
|---|---|---|
| **I-1 分からないは 0 と書かない** | 取得に失敗した・時間切れになった・権限が無い値は、記録で `null` にし、`sources.<元>` に理由（`fail`／`timeout`／`absent`／`denied`）を書く。`0` は「読めて、数えて 0」のときだけ | 取得元ごとの畳み込み（表 S2）。試験 T2 |
| **I-2 分からないで警報を鳴らさない・消さない** | 警報の入力が `null` のとき、その警報の状態は変えない（`firing` を `resolved` にしない、`ok` を `fired` にしない）。「取得元が続けて読めない」ことは別の警報 `source-down` で知らせる | 表 S3。試験 T4 |
| **I-3 計測は何も変えない** | 計測は GitHub・git・CommandMate・ランナー・Docker に対して読み取りしかしない（`gh` は GET だけ、git は `fetch` もしない、Docker は `info` だけ）。書くのは計測の記録の dir だけ | 試験 T7 の「呼んだコマンドの一覧」が読み取りの許可リストに収まる |
| **I-4 DB のファイルを開かない** | CommandMate の DB は API（`/api/metrics/vibe` ほか）越しにだけ読む。`better-sqlite3` で DB のファイルを開かない（テストが本番の DB を上げた事故の型を作らない） | PR4 の取得元。試験 T7 |
| **I-5 警報は記録が先** | 警報の出来事は `alerts.jsonl` に書けてから表示し、送信する。書けなかった出来事は送らない | 表 S3・S4 |
| **I-6 送るのは明示したときだけ、既存の経路で** | PM のセッションへの送信は `alerts.notify`（worktree・instance）を設定したときだけ。送信は `commandmate send <worktree> <本文> --instance <id>` を子として呼ぶ形に限り、その前に `capture --json` の `isRunning === true` を確かめる。tmux を直接叩かない | PR3。表 S4。試験 T4 の送信の行 |
| **I-7 計測は時間で必ず終わる** | 外部の呼び出しはすべて時間切れつき（§4 の表の値）。1 回の tick の全体も上限（既定 240 秒）を持ち、超えたら残りを `timeout` として記録して終わる | 表 S1。試験 T2 の `timeout` の行 |
| **I-8 1 回の tick は 1 行** | 1 回の tick が書く計測の記録は高々 1 行。部分的に読めた tick も 1 行（`null` を含む）で書く | 表 S1 |
| **I-9 追記だけ** | 記録は追記だけ。書き換え・削除をしない（保存期間の掃除は §10 H6 の人の判断の後、別の PR）。千切れた最後の行は改行で閉じてから書く（F2 と同じ） | 書き手。試験 T5 |
| **I-10 既存のロックと検証を弱めない** | 計測は `merge.*`・`cpu.heavy` のロックを取らない・待たない。`.commandmate/verify.yaml`・merge-pr.mjs の判定に手を入れない | PR1〜PR4 の変更ファイルの一覧（§5）に該当のファイルが無い |
| **I-11 数え方は 1 か所** | WIP（未マージのブランチ数・動いているブランチ数）は #4368 の関数を呼んで記録し、計測の側で別の数え方を持たない。計測が自分で数えるのは「開いた PR」と「台帳の着手済み未マージ」で、名前を分ける（`openPrs`・`ledgerWip`） | §2.2 の名前。§11 |
| **I-12 リポジトリに固有の値を埋め込まない** | repo・base・ランナーの名前・台帳の場所は設定か git から決める。`develop`・`Kewton/CommandMate` は既定値の決め方（共通の枠 §2）としてだけ現れる | 設定の読み手。試験 T1 |
| **I-13 呼び手の無い組み合わせは拒む** | 設定のキー・記録の `kind` のうち、その PR に評価する側・書く側が無いものは読み手が exit 2 で拒む（例: PR1 では `alerts.notify`・`alerts.runnersMin`・`alerts.docker`、記録の `kind: train`） | 設定の読み手・書き手。試験 T1・T5 |

---

## 2. 記録の形と指標の定義

### 2.1 置き場所と名前

- 計測の記録: `<flowDir>/<repo-slug>/<YYYY-MM-DD>.jsonl`。`<flowDir>` は `CM_FLOW_DIR` があればそれ、無ければ `~/.commandmate/flow`（共通の枠 §2）。日付は設定の `tz`（既定は計測するプロセスの TZ）での tick の時刻の日付
- 警報の履歴: `<flowDir>/<repo-slug>/alerts.jsonl`（共通の枠 §2）
- `<repo-slug>`: `<owner>.<repo>` を小文字にし、`[a-z0-9_.-]` 以外を `_` に（F7 の流儀。例 `kewton.commandmate`）。64 文字を超えたら先頭 51 文字＋`.`＋sha1 の 12 桁
- 書き方: 1 行 1 JSON、末尾に改行。最後の行が改行で終わっていなければ改行を足してから書く（F2）。dir が無ければ作る（`mkdir -p` 相当、mode 0700）

### 2.2 計測の記録（`kind: "tick"`、v1）

```jsonc
{
  "v": 1, "kind": "tick",
  "at": "2026-11-13T10:00:03.120Z",          // tick の開始（UTC）
  "repo": "Kewton/CommandMate", "base": "develop",
  "sources": {                               // 取得元ごとの結果（表 S2）
    "github": "ok", "ledger": "ok", "load": "ok"
  },
  "flow": {
    "openPrs": 13,                           // base 向けの開いた PR（draft を含む。内訳 openDraftPrs）
    "openDraftPrs": 0,
    "oldestOpenPrMin": 312,                  // 一番古い開いた PR の経過（分）
    "merged60m": 0,                          // 直前 60 分に base へマージされた PR の数
    "lastMergeAt": "2026-11-13T07:40:11Z",   // 最後のマージ（24 時間に無ければ null と sources に理由）
    "prToMergeMin": { "n": 6, "median": 212, "max": 471 },   // 直前 24 時間にマージされた PR の作成→マージ
    "ledgerWip": 18,                         // 台帳で着手済み（send ok）・未マージ（merge ok なし）の work item
    "startToMergeMin": { "n": 6, "median": 330, "max": 700 } // 台帳の最初の send ok → 最初の merge ok
  },
  "ci": {
    "queuedJobs": 9,                         // 今 queued の job（runs の status=queued・in_progress の job）
    "oldestQueuedMin": 41,                   // その中で一番長く待っている job の待ち（分）
    "queuedByLabel": { "self-hosted": 9 },
    "inProgressJobs": 6
  },
  "resource": { "load1": 52.1, "load5": 61.0, "cpus": 12 },
  "durationMs": 8123
}
```

- 値の `null` は「分からない」（I-1）。理由は `sources` に書く。`sources` の値は `ok`／`partial`（一部の呼び出しだけ読めた）／`fail`／`timeout`／`absent`（取得元が無い: 台帳の設定が無い・GitHub のリポジトリでない）／`denied`（403・404）
- PR2 で `resource.runnersOnline`・`resource.runnersBusy`・`resource.docker`（`up`／`down`／`absent`）と `sources.runners`・`sources.docker` を足す。PR4 で `flow.wipBranches`・`flow.activeBranches`（#4368 の関数）・`agents`（③）・`vibe`（CommandMate の API）を足す。**足すだけで、v1 の既存のキーの意味は変えない**（読み手は知らないキーを無視する）

### 2.3 指標の定義（記録と再現で同じ定義を使う）

| 指標 | 定義 | 元 |
|---|---|---|
| マージ数（時間ごと） | base へマージされた PR を `mergedAt` の `tz` での時（0〜23）で数える | GitHub PR |
| 開いた PR（時刻 t） | base 向けで `createdAt ≤ t` かつ（`closedAt` が無い、または `closedAt > t`）の PR の数（マージされずに閉じた PR も `closedAt` で抜ける） | GitHub PR |
| 台帳の WIP（時刻 t） | 台帳の work item（`issue` と `item`。F1）のうち、最初の `send ok` が t 以前で、最初の `merge ok` が t 以前に無いもの | 台帳 |
| CI の順番待ち（job） | job の `started_at − created_at`（分）。`conclusion: skipped` と `started_at` の無い job は除く。時の分け方は job の `created_at`。run の attempt は最新だけ（`jobs?filter=latest`） | GitHub run・job |
| 今の順番待ち（tick） | `status=queued` と `in_progress` の run の job のうち `status: queued` のもの。待ちは `at − created_at` | GitHub run・job |
| PR→マージ | `mergedAt − createdAt`（分） | GitHub PR |
| 着手→マージ | 台帳の最初の `send ok` の `at` → 最初の `merge ok` の `at`（分） | 台帳 |
| 滞留（日次、PR4） | 窓の平均の WIP ÷ 窓のスループット（時間あたりのマージ数）。Little の法則による平均の滞留時間の見積り（**見立て**: 定常でない日は目安にしかならない） | 計測の記録 |

### 2.4 台帳の読み手

- 場所: 設定の `ledger.runsDir`（リポジトリの**主 worktree の root**からの相対、または絶対）。主 worktree の root は `git rev-parse --git-common-dir` の親。CommandMate では `workspace/orchestration/runs`（人の判断 H3）。無ければ `sources.ledger: "absent"`
- 読む dir: 窓の開始日の `lookbackDays`（既定 7）日前から窓の終わりの日までの `<runsDir>/<YYYY-MM-DD>/run-*.jsonl`（F3: 台帳は日をまたぐ）。読めない行は飛ばして数を `sources` の注記に残す
- 読むのは `issue`・`item`・`stage`・`result`・`at` だけ。`note` の中身（パス・ブランチ名）は記録に写さない

### 2.5 警報の履歴（`alerts.jsonl`、v1）

```jsonc
{ "v": 1, "kind": "alert", "at": "…", "repo": "…", "base": "…",
  "id": "open-prs", "event": "fired",           // fired | resolved（PR3 で notified | notify-failed | notify-gave-up を足す）
  "value": 13, "threshold": 5, "eventId": "<at>#open-prs" }
```

| 警報 id | 鳴る条件 | 消える条件 | 入る PR |
|---|---|---|---|
| `open-prs` | `openPrs > alerts.openPrMax`（既定 5） | `openPrs ≤ openPrMax` | PR1 |
| `no-merge` | 直前 `alerts.noMergeMinutes`（既定 60）分のマージが 0 **かつ** `openPrs > 0`（マージするものが無いときは詰まりではない。`merged60m` は既定の 60 分のときの値） | マージが 1 以上、または `openPrs = 0` | PR1 |
| `ci-queue` | `oldestQueuedMin > alerts.queueWaitMinutes`（既定 15） | `oldestQueuedMin ≤ queueWaitMinutes`（queued が 0 なら 0 として消える） | PR1 |
| `source-down` | 同じ取得元が続けて `alerts.sourceDownTicks`（既定 2）回 `fail`／`timeout` | その取得元が `ok`／`partial` | PR1（github・ledger）、PR2（runners・docker） |
| `runners-zero` | `runnersOnline < alerts.runnersMin`（既定 1） | `runnersOnline ≥ runnersMin` | PR2 |
| `docker-down` | `docker = down`（`absent` では鳴らない） | `docker = up` | PR2 |
| `wip` | #4368 の上限を超えた（上限の値は #4368 の設定 `wip` 節） | 上限以下 | PR4 |

---

## 3. 状態と遷移の表

### 3.1 表 S1: 1 回の tick の段

| 段 \ 出来事 | 成功 | 失敗 | 時間切れ（tick 全体の上限） |
|---|---|---|---|
| 1 引数・設定の読み | 2 へ | exit 2、何も書かない（設定の誤りは計測しない。文面は誤りのキーを名指す） | —（読みは時間切れを持たない局所のファイル） |
| 2 repo・base を決める（git） | 3 へ | exit 2、何も書かない（`base を決められない: .commandmate/flow.yaml に base を書く`） | — |
| 3 取得元を順に読む（GitHub → 台帳 → load） | 次の取得元へ | その取得元を `fail` として次へ（表 S2）。tick は続ける | 残りの取得元を `timeout` として 4 へ |
| 4 集計 | 5 へ | 起きない（集計は純関数。入力の `null` は `null` のまま通す） | — |
| 5 計測の記録を 1 行書く | 6 へ | exit 1。警報を評価しない（I-5: 記録できない tick で警報を出さない） | — |
| 6 警報の評価（表 S3） | 出来事を `alerts.jsonl` に書く | `alerts.jsonl` が読めない: 前の状態を `unknown` として評価（表 S3 の最後の列）。書けない: exit 1、表示しない | — |
| 7 表示 | 1 行の要約を stdout に、警報の出来事を stderr に。exit 0 | — | — |

### 3.2 表 S2: 取得元の結果 → 記録

| 取得元 | 結果 | `sources.<元>` | 記録の値 |
|---|---|---|---|
| GitHub（PR の一覧・run・job） | 全部読めた | `ok` | 数えた値（0 を含む） |
| 〃 | PR は読めたが run／job の一部が読めない | `partial` | `flow.*` は値、`ci.*` は `null` |
| 〃 | `gh` が exit ≠ 0（5xx・接続・認証） | `fail` | 全部 `null` |
| 〃 | 403・404 | `denied` | 全部 `null`（`source-down` に数えない。設定の問題として起動時に 1 回 stderr へ） |
| 〃 | 時間切れ | `timeout` | 全部 `null` |
| 〃 | origin が GitHub でない | `absent` | 全部 `null`（`source-down` に数えない） |
| 台帳 | 読めた | `ok` | 値 |
| 〃 | 設定が無い | `absent` | `ledgerWip`・`startToMergeMin` は `null` |
| 〃 | dir が無い・読めない | `fail` | 〃 |
| 〃 | 一部の行が読めない | `partial` | 読めた行で数えた値（読めない行の数を注記） |
| load | `os.loadavg()` | `ok` | 値（失敗しない。Windows では 0 を返すので `absent` と記録する: **見立て**、この製品は macOS・Linux が対象） |

### 3.3 表 S3: 警報の状態 × 入力

状態は `alerts.jsonl` のその id の最後の `fired`／`resolved` から決める（無ければ `ok`）。tick の間で状態を持つプロセスは無い（再起動に強い）。

| 前の状態 \ 入力 | 超えた（breach） | 下回った（clear） | 分からない（入力が `null`） |
|---|---|---|---|
| `ok`（最後が `resolved`、または記録なし） | `fired` を書く → `firing` | 何も書かない | 何も書かない（I-2） |
| `firing`（最後が `fired`） | 何も書かない（PR3 で「再送の間隔を過ぎたら再送」を足す） | `resolved` を書く → `ok` | 何も書かない（消さない。I-2） |
| `unknown`（`alerts.jsonl` が読めない・最後の行が壊れている） | `fired` を書く（二重になりうる。鳴らさないより鳴らす側へ倒す） | 何も書かない | 何も書かない |

`source-down` だけは入力が「取得元の直近 N 回の結果」で、`null` にならない（tick の記録の `sources` を読む。読めない記録は数えない）。

### 3.4 表 S4: PM への送信（PR3）

| 状態 \ 出来事 | `fired`／`resolved` を書いた | `capture --json` が `isRunning: true` | `isRunning: false`／読めない／時間切れ | `send` exit 0 | `send` exit ≠ 0・時間切れ |
|---|---|---|---|---|---|
| 送信の設定なし | 何もしない（記録と表示だけ。共通の枠 §3） | — | — | — | — |
| 未送信 | `flow.<repo-slug>` のロックを取る（時間切れ 0 秒。取れなければこの tick は送らず次の tick へ） → capture へ | send へ | `notify-failed`（`reason=not-running`）を書き、送らない（終わったペインへ送らない規則を迂回しない） | `notified` を書く | `notify-failed`（exit を書く） |
| `notify-failed` が 1〜2 回 | 次の tick で再び capture から（同じ tick の中では再送しない） | 〃 | 〃 | 〃 | 3 回目で `notify-gave-up` を書き、以後送らない（表示は続く） |
| `notified` | 何もしない。`firing` のまま `alerts.renotifyMinutes`（既定 60）を過ぎたら新しい未送信として扱う | — | — | — | — |

- 本文は 1 行・300 文字以内・先頭 `[flow]`（例 `[flow] open-prs fired: 開いた PR 13 > 5 (kewton.commandmate develop) 詳しくは commandmate flow status`）。改行を入れない（複数行の send の既知の問題を避ける）
- `send` が exit ≠ 0 でも届いていることがある（**見立て**）。再送で同じ知らせが高々 3 回届きうる。知らせが届かないより重複を受け入れる

---

## 4. 外部の呼び出しごとの失敗の倒れ方

| 呼び出し | 時間切れ | 失敗・時間切れ・部分的な成功のとき | 倒れる向き |
|---|---|---|---|
| `gh pr list`（開いた PR・直近のマージ） | 30 秒（各） | `null` と `sources.github`（表 S2）。呼び直しは 0 回（F5 の待ちを tick に持ち込まない。次の tick が呼び直しに当たる） | fail-open（分からないとして記録して続ける） |
| `gh api …/actions/runs?status=…`・`…/jobs` | 20 秒（各）、run は最大 30 本 | 読めた run だけで数えると順番待ちを小さく見せるので、1 本でも読めなければ `ci.*` を `null`・`partial`（数えた値を出さない） | fail-open（ただし部分の値は出さない） |
| `gh api …/actions/runners`（PR2） | 20 秒 | 403/404 は `denied`、他は `fail`。`runners-zero` は `null` では鳴らない | fail-open。ランナーの 0 は「読めて 0」のときだけ |
| `docker info`（PR2） | 10 秒 | 実行ファイルが無い（ENOENT）＝`absent`（鳴らさない）。exit ≠ 0・時間切れ＝`down`（**Docker の不応答そのものが知らせたい事象**なので、ここだけは失敗を値として扱う） | 失敗＝`down`（鳴らす側） |
| `git`（remote・ref・`--git-common-dir`） | 10 秒 | 設定の段の失敗は exit 2 で何も書かない。`fetch` はしない（I-3。ref は古いことがある: base の判定に使うだけで、数えるのは GitHub） | fail-closed（決められなければ計測しない） |
| `.commandmate/flow.yaml` の読み | — | 無い＝既定値。読めない（EACCES）・YAML が壊れている・知らないキー・型の誤り・呼び手の無いキー＝exit 2 | fail-closed（誤った設定で黙って既定値に戻さない） |
| 台帳の読み | 全体で 10 秒 | 表 S2 | fail-open |
| 計測の記録・`alerts.jsonl` の書き込み | — | EACCES・ENOSPC・EROFS は exit 1。警報を出さない（I-5）。書きかけの行は次の書き手が改行で閉じる（I-9） | fail-closed |
| CommandMate の API（PR4: `/api/metrics/vibe`・`/api/worktrees`） | 10 秒 | サーバーが止まっている・401 は `sources.commandmate: fail`／`denied`。DB のファイルへ回り込まない（I-4） | fail-open |
| `commandmate capture`／`send`（PR3） | capture 30 秒、send 60 秒 | 表 S4。確かめられなければ送らない | fail-closed（送らない側）。記録と表示は残る |
| tmux | 呼ばない | — | — |

---

## 5. PR の切り方

危険の境目（F17）: **読み取りだけの計測**／**資源の外部の読み取り（Docker・ランナー）**／**PM への送信の経路**／**他の子の関数の呼び出しと CommandMate の API**／**製品の画面**。目安はどれも数百行・20 ファイル以内。

| PR | 中身 | 危険の種類 | 依存 |
|---|---|---|---|
| **PR1**（この run） | 設定の読み手（`base`・`exclude`・`tz`・`ledger`・`alerts` の流れの 3 種と `source-down`）、記録の書き手（`kind: tick`・`alert`）、GitHub（PR・run・job）と台帳と load の取得、時間ごとの集計、`reconstruct`（過去の日の再現）、`report`（窓の集計の表と JSON）、流れの警報の記録と表示。送信なし | 読み取りと、計測の dir への追記だけ | なし |
| PR2 | ランナー（`gh api …/runners`）と Docker（`docker info`）の取得、`runners-zero`・`docker-down` の警報、`source-down` を runners・docker へ。設定の読み手に `alerts.runnersMin`・`alerts.docker` を足す（ここで拒否を外す） | Docker・ランナーの読み取り（時間切れの扱いが他と逆、§4） | PR1 |
| PR3 | PM への送信（表 S4）。設定の読み手に `alerts.notify`・`alerts.renotifyMinutes` を足す。`flow.<repo-slug>` のロック（F8）。送信の経路だけの PR（画面・計測の変更を入れない） | 送信の経路 | PR1 |
| PR4 | #4368 の WIP の関数を呼んで `wipBranches`・`activeBranches` を記録、`wip` 警報、③ エージェント（`/api/worktrees` から受け持ち・止まっていた時間）、CommandMate の API（`vibe`）、日次のまとめ（滞留・最長の待ちの工程）、記録の `kind: train` を受け付ける形は**#4369 の PR が呼び手と一緒に足す**（§11） | 他の子の関数・サーバーの API の読み取り | PR1、#4368 の PR1 |
| PR5 | 製品へ: `src/lib/flow/**`（集計と警報の純関数を移す）、CLI `commandmate flow status|report`、API `GET /api/flow`、Flow のページ（PC 1280・スマホ 390。スマホは健康と流れを先頭）。スクリプトは製品の読み手を呼ぶだけにする | 画面 | PR1〜PR3、§9 の Artifact の試作の結論 |

- 呼び手の無い組み合わせは引数・設定の検査で拒む（I-13）。広げるのは呼び手を作る PR（team.md §6 の 4）
- PR2 と PR3 は互いに独立で、並べてよい（書くファイルが重なるのは設定の読み手の許可リストの 1 行だけ。後に入る方が develop を取り込んで足す）

---

## 6. この run で実装する PR1 の範囲（実装の契約にそのまま写す）

### 6.1 変更するファイル

| ファイル | 新規／変更 | 中身 |
|---|---|---|
| `scripts/flow/flow.mjs` | 新規 | 入口。`tick`・`reconstruct --date <YYYY-MM-DD>`・`report --from <ISO> --to <ISO> [--json]`・`status`（最後の tick と開いている警報）。共通の引数 `--repo-root <dir>`（既定 cwd）。exit 0／1（書けない）／2（引数・設定）。`main(argv, deps)` を export し、`deps` で `run`（時間切れつき）・`now`・`env`・`home` を差し替えられる |
| `scripts/flow/config.mjs` | 新規 | `.commandmate/flow.yaml` の読み手 `readFlowConfig(repoRoot, { run, env })` → `{ repo, base, exclude, tz, ledger, alerts }` か `{ error }`。キーの許可リスト（PR1: `version`・`repo`・`base`・`exclude`・`tz`・`ledger.runsDir`・`ledger.lookbackDays`・`alerts.openPrMax`・`alerts.noMergeMinutes`・`alerts.queueWaitMinutes`・`alerts.sourceDownTicks`）。`alerts.notify`・`alerts.runnersMin`・`alerts.docker`・`wip`・`train` は「後の PR／他の子のキー」として名指しで exit 2（`wip`・`train` は各子の PR が足す）。`base` の既定は「`refs/remotes/origin/develop` があれば develop、無ければ `refs/remotes/origin/HEAD` の先」。`exclude` に base と main／master を常に足す |
| `scripts/flow/record.mjs` | 新規 | `flowDirOf(env, home)`・`repoSlug(repo)`・`appendFlowRecord(dir, record)`（`kind` は `tick` だけを受ける。I-13）・`appendAlertEvent(dir, event)`・`readFlowRecords(dir, from, to)`・`readAlertEvents(dir)`。千切れた行の扱いは F2 と同じ |
| `scripts/flow/sources.mjs` | 新規 | `readGithub(run, { repo, base, now })`・`readGithubHistory(run, { repo, base, from, to })`・`readLedger(dir, { from, to, lookbackDays })`・`readLoad()`。各々 `{ status: 'ok'|'partial'|'fail'|'timeout'|'absent'|'denied', data }` を返し、例外を投げない |
| `scripts/flow/aggregate.mjs` | 新規 | 純関数: `tickValues(sources, now)`・`hourly({ prs, jobs, ledger }, { from, to, tz })`（§2.3 の定義そのまま）・`evaluateAlerts(tick, priorEvents, thresholds, recentTicks)`（表 S3） |
| `tests/unit/scripts/flow/flow-4367.test.ts` | 新規 | §7 の表 T1〜T7 |
| `tests/fixtures/flow/2026-11-13/{prs.json,runs.json,jobs.json,ledger.jsonl}` | 新規 | §8.2 で取った読み取りの結果の写し（ブランチ名・題名・`note` は落とし、番号・時刻・状態だけ） |
| `tests/setup.ts` | 変更 | `process.env.CM_FLOW_DIR = join(tmpdir(), 'commandmate-test-flow', String(process.pid));`（F9 の並び） |
| `changelog.d/4367.md` | 変更 | 1 本目（この設計）の項目へ統合（2 本目の work item） |

`.commandmate/flow.yaml` は PR1 では**作らない**（既定値で動くことを確かめる。置くかどうかは人の判断 H2・H3 の後）。`package.json` の scripts も足さない（呼び方は `node scripts/flow/flow.mjs …`）。

### 6.2 受入基準

1. `node scripts/flow/flow.mjs reconstruct --date 2026-11-13` を fixture の取得結果で動かした出力（試験では `deps.run` が fixture を返す）が、§8.3 の表（時間ごとのマージ数・開いた PR・台帳の WIP・CI の順番待ちの件数・中央値・最大）と**全セル一致**する
2. 実際の GitHub に対して `reconstruct --date 2026-11-13 --tz Asia/Tokyo --ledger-dir <台帳>` を手で 1 回動かし、§8.3 と一致する（PR の説明に出力を貼る。CI では動かさない）
3. `tick` は `CM_FLOW_DIR` の下の `<repo-slug>/<日付>.jsonl` に 1 行だけ書き、§2.2 のキーを持つ
4. `gh` が exit ≠ 0・時間切れのとき、`flow.*`・`ci.*` が `null`、`sources.github` が `fail`／`timeout` で、tick は exit 0（I-1・I-7）
5. 流れの警報 3 種が表 S3 のとおりに `alerts.jsonl` へ `fired`／`resolved` を書く。入力が `null` のときは何も書かない（I-2）
6. `no-merge` は `openPrs = 0` では鳴らない（陰性の対照）
7. 設定の誤り（壊れた YAML・知らないキー・`alerts.notify` などの後の PR のキー）は exit 2 で、何も書かない
8. 計測の記録の dir に書けない（読み取り専用の一時 dir）と exit 1 で、`alerts.jsonl` も書かない（I-5）
9. 呼んだ外部のコマンドがすべて読み取りの許可リスト（`gh pr list`・`gh api`（GET）・`git remote get-url`・`git rev-parse`・`git symbolic-ref`）に入っている（I-3）
10. `src/`・`scripts/orchestrate/`・`.commandmate/verify.yaml`・`.github/` に変更が無い（I-10）

### 6.3 gates・scope

- gates: `lint`・`typecheck`・`unit`（`tests/setup.ts` を変えるため。共通の枠 §2）
- scope.allow: §6.1 の表のパス（`scripts/flow/**`・`tests/unit/scripts/flow/**`・`tests/fixtures/flow/**`・`tests/setup.ts`・`changelog.d/4367.md`）
- 確認のコマンド: `npx vitest run tests/unit/scripts/flow tests/unit/guards tests/unit/docs`・`npm run lint`・`npx tsc --noEmit`
- fixture を足すので、`tests/fixtures/` の走査のテストへの登録が要るかを契約の生成（`contract.mjs` の `touchesFixtures`）の文に従って確かめる
- 新しい dir は既存のガードが受ける（**事実**: `tests/unit/guards/test-file-placement.test.ts:76-82` は `tests/unit/` の下を走る root として受け、`lint-scripts-scope.test.ts:51`・`:77` の lint の範囲は `scripts/**`）

---

## 7. 試験の表（行の形は `it.each` に写せる。実装はしない）

先に赤: PR1 の最初のコミットで、各モジュールを「`throw new Error('not implemented')` だけの関数を export する」形で置き、表の全行が赤（not implemented か期待の不一致）になることを確かめてから実装する。陽性の対照は「直す前に赤」、陰性の対照は「今までどおり／鳴らない」を固定する行。対照は `os.tmpdir()` の下に `fs.mkdtempSync` で作り、`afterEach` で消す。実リポジトリのファイルは書き換えない。

### 表 T1: 設定の読み手

| # | `flow.yaml` | origin の ref | 期待 | 種 |
|---|---|---|---|---|
| 1 | 無い | `origin/develop` あり | `base=develop`、`exclude ⊇ {develop, main, master}`、閾値は既定（5・60・15・2） | 陽性 |
| 2 | 無い | develop なし・`origin/HEAD → main` | `base=main` | 陽性 |
| 3 | 無い | どちらも無い | exit 2「base を決められない」 | 陽性 |
| 4 | `base: trunk` | develop あり | `base=trunk`（設定が勝つ） | 陽性 |
| 5 | `exclude: [release]` | develop あり | `exclude = {release, develop, main, master}` | 陽性 |
| 6 | 壊れた YAML | — | exit 2、書き込み 0 | 陽性 |
| 7 | 知らないキー `alerts.foo` | — | exit 2、キーを名指す | 陽性 |
| 8〜12 | `alerts.notify`／`alerts.runnersMin`／`alerts.docker`／`wip`／`train` | — | exit 2「後の PR（または #4368・#4369）が足すキー」 | 陽性（I-13） |
| 13 | `alerts.openPrMax: -1`・`"5"`（文字列） | — | exit 2 | 陽性 |
| 14 | `repo` なし・origin が `git@github.com:Kewton/CommandMate.git` | — | `repo=Kewton/CommandMate` | 陰性（既定の読み） |
| 15 | origin が GitHub でない | — | `repo=null`、tick の `sources.github=absent` | 陽性 |

### 表 T2: 取得元 × 結果 → 記録（表 S2）

| # | 取得元 | 差し替えた `run` の答え | 期待の `sources` | 期待の値 |
|---|---|---|---|---|
| 1 | github | 全部 exit 0 | `ok` | 数えた値（0 を含む） |
| 2 | github | PR は exit 0・jobs の 1 本が exit 1 | `partial` | `flow.*` は値、`ci.*` は `null` |
| 3 | github | `gh pr list` exit 1（HTTP 502） | `fail` | 全部 `null`（0 でない） |
| 4 | github | 時間切れ | `timeout` | 全部 `null` |
| 5 | github | exit 1・`HTTP 404` | `denied` | 全部 `null` |
| 6 | ledger | dir 無し（設定なし） | `absent` | `ledgerWip=null` |
| 7 | ledger | 3 行のうち 1 行が壊れている | `partial` | 2 行で数えた値 |
| 8 | ledger | `send ok` のあと `merge fail` だけ | `ok` | その item は WIP に入る（陰性: `merge fail` はマージでない） |
| 9 | ledger | `item` あり・なしの同じ issue | `ok` | 別の work item として数える |
| 10 | 全体 | tick の上限を超えた | 残りが `timeout` | 1 行だけ書く（I-8） |

### 表 T3: 集計（§2.3 の定義）

| # | 入力 | 期待 |
|---|---|---|
| 1 | マージが 18:59:59 と 19:00:00（`tz=Asia/Tokyo`） | 18 時に 1、19 時に 1 |
| 2 | 開いた PR: `closedAt` が t ちょうど | t の時点で数えない（`closedAt > t` だけ数える） |
| 3 | マージされずに閉じた PR | `closedAt` で抜ける・マージ数に入らない |
| 4 | job `conclusion: skipped`・`started_at: null` | 順番待ちに入れない |
| 5 | 窓の前に作られた run の、窓の中で作られた job | 窓の中の job として数える（§8.2 の実測で 1 本ある） |
| 6 | `tz` を `UTC` に変える | 時の分け方だけが変わり、総数は変わらない（陰性） |

### 表 T4: 警報（表 S3）— `id ∈ {open-prs, no-merge, ci-queue, source-down}` × 前の状態 × 入力

| # | 前の状態 | 入力 | 期待の書き込み |
|---|---|---|---|
| 1 | 記録なし | breach | `fired` |
| 2 | `fired` が最後 | breach | なし |
| 3 | `fired` が最後 | clear | `resolved` |
| 4 | `fired` が最後 | `null` | なし（消さない） |
| 5 | `resolved` が最後 | `null` | なし（鳴らさない） |
| 6 | `alerts.jsonl` の最後の行が壊れている | breach | `fired`（unknown は鳴らす側） |
| 7 | 記録なし | clear | なし |
| 8 | — | `no-merge`: マージ 0・`openPrs=0` | なし（陰性） |
| 9a | — | `source-down`: `fail` が 1 回 | なし |
| 9b | — | `source-down`: `fail`／`timeout` が 2 回続く | `fired` |
| 9c | — | `source-down`: `denied`・`absent` が続く | なし（陰性） |
| 10 | — | 閾値ちょうど（`openPrs=5`・`openPrMax=5`） | なし（`>` だけ鳴る） |

4 種 × 行 1〜7 の 28 行と、行 8〜10 の個別の行（5 行）。

### 表 T5: 書き込み

| # | 状態 | 期待 |
|---|---|---|
| 1 | `CM_FLOW_DIR` あり | その下に書く（`~` の下に書かない） |
| 2 | dir が無い | 作って書く |
| 3 | 最後の行が改行で終わっていない | 改行を足してから 1 行 |
| 4 | dir が読み取り専用 | exit 1・`alerts.jsonl` も書かない |
| 5 | `appendFlowRecord` に `kind: 'train'` | 例外（I-13。#4369 の PR が呼び手と一緒に足す） |
| 6 | `repoSlug('Kewton/CommandMate')` | `kewton.commandmate`。65 文字以上は 64 文字に縮む |

### 表 T6: 再現（§8）

| # | 入力 | 期待 |
|---|---|---|
| 1 | `tests/fixtures/flow/2026-11-13/*` | §8.3 の表の全セル |
| 2 | 同じ fixture・`ledger` なし | 台帳の WIP の列だけ `null`、他は同じ（陰性） |

### 表 T7: CLI と外部のコマンド

| # | 引数 | 期待 |
|---|---|---|
| 1 | `tick` | `deps.run` が受けたコマンドがすべて読み取りの許可リストの中（I-3） |
| 2 | `reconstruct --date 2026-13-01` | exit 2 |
| 3 | `report --from` だけ | exit 2 |
| 4 | 知らない引数 | exit 2 |
| 5 | `status`（記録なし） | 「記録が無い」と exit 0 |

---

## 8. 2026-11-13 の実データからの再現（受入 1 の確かめ方）

### 8.1 取得元と期間

- 期間: 2026-11-13 13:00〜20:00 JST（Epic の自走の窓 13:10〜19:00 を含む時の区切り）。表は 10 時〜21 時も出す
- GitHub の PR: `gh pr list --repo Kewton/CommandMate --base develop --state all --search "created:2026-11-12..2026-11-14" --limit 200 --json number,createdAt,mergedAt,closedAt,state`（49 本）と、窓より前に作られ窓の中で閉じた PR を拾う `--search "created:<2026-11-12 closed:>=2026-11-12"`（1 本、#4312。11-12 13:24 JST に閉じたので 11-13 の値には効かない）。**実装では「開いている PR」と「窓の開始以降に更新された PR」の 2 本の照会**にする（作成日で切ると、前から開いていた PR を落とす）
- GitHub の run と job: `gh api --paginate "repos/<repo>/actions/runs?created=<窓の開始−3 時間>..<窓の終わり>&per_page=100"`（61 本）の各 run の `jobs?per_page=100&filter=latest`。job の `created_at` が窓の中のものだけ数える（窓の前の run の job が 1 本ある）
- 台帳: `workspace/orchestration/runs/2026-11-13/run-*.jsonl` と `2026-11-14/run-*.jsonl`（F3。`lookbackDays` の dir も読む。11-13 の窓に効くのは `run-3574-4317.jsonl`）
- 取得は 2026-11-14 の読み取り（`gh` の読み取りだけ。GitHub の設定は変えていない）

### 8.2 期待値の出し方

1. 上の照会の結果を、番号・時刻・状態だけに落として fixture にする（PR1 の `tests/fixtures/flow/2026-11-13/`）。ブランチ名・題名・`note` は写さない
2. 期待値は**計測の実装とは別の実装**で出す。本書 §8.3 の値は、設計の段で Python の短いスクリプト（§2.3 の定義を直接書いたもの）で出した。PR1 の試験は fixture を入力に `reconstruct` の出力を §8.3 の表と比べる。食い違ったら、どちらの定義の読みが違うかを先に確かめ、表を勝手に直さない
3. GitHub の job の記録は時間がたつと消える（**未確認**: 保存期間）。fixture にするのは、後から取り直せない日に備えるため

### 8.3 期待値（事実: 2026-11-14 に上の照会で取った値。時は JST）

| 時 | PR の作成 | マージ | 時の開始の開いた PR | 時の開始の台帳の WIP | CI の job の数 | 順番待ちの中央値（分） | 最大（分） |
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

- CI の列は 13〜19 時だけ取った（— は未取得。PR1 の fixture を取るときに 10〜21 時へ広げてよい。広げたら表も足す）
- 台帳のマージ（`merge ok` の時）は 13〜19 時で GitHub のマージと一致した（1・1・2・1・0・0・6）
- 19 時の開いた PR 13 は Epic の「開いた PR は 13 本」と一致。16:40 のマージ（#4349）の後 19:02 まで 0 で、Epic の「16:40〜18:57 マージ 0」と一致
- **Epic との食い違い（事実）**: Epic の「13 時 2/0」は、ここでは 2/1。13 時のマージ（#4342）は 13:05 で、Epic の窓（13:10〜）の前。定義（時の区切り）の違いで、データの違いではない
- **Epic との食い違い（未確認）**: Epic の「PR の CI は中央値 22 分・最長 78 分」の定義は書かれていない。ここで run の `created_at → updated_at` を取ると、`pull_request` の CI 27 本で中央値 46.4・最長 109.9 分、`push` の CI 11 本で中央値 22.1・最長 98.7 分（13〜20 時に作られた run）。本書は「CI の順番待ち（job の開始まで）」と「CI の長さ（run）」を別の指標にする。Epic の数字の出し方は PM に確かめる（§13）

---

## 9. ダッシュボードの第 1 段（推奨）

**推奨: 第 1 段は Artifact の試作。載せるのは数だけ（PR 番号・ブランチ名・題名・パスを載せない）。画面（Flow のページ）は試作で「何を先頭に置くか」が決まってから PR5 で作る。**

理由:
- 何を一目で見せるか（健康の緑黄赤の決め方・最長の待ちの強調・スマホで先頭に何を置くか）がまだ決まっていない。製品の画面で試すと、決め直すたびに画面の PR とレビューが回る。Artifact なら PM が `report --json` の出力から作り直せ、製品のコードを変えない
- 計測（PR1）の出力の形（`report --json`）を、画面の前に人の目で確かめられる。画面の PR5 はその形を読むだけにできる

試作の形:
- 入力: `node scripts/flow/flow.mjs report --from <窓の開始> --to <窓の終わり> --json`（時間ごとの系列・今の値・警報の履歴）。PR1 の出力をそのまま使う
- 区画の順: 健康（緑黄赤と、赤の理由 1 行）→ 流れ（時間ごとのマージ数の棒・開いた PR と上限の線・PR→マージの中央値）→ 詰まり（工程ごとの待ち、最長を強調）→ 資源（load・ランナー・Docker。PR2 の後）→ 品質（develop の赤・揺れ・再指示。PR4 の後）→ 警報の履歴
- 受入（試作の段）: 幅 1280 と 390 で、健康と流れがスクロールせずに読める。390 では健康・流れを先頭の 1 画面に

人の判断（H4）: Artifact は claude.ai に置かれる（外へ出る）。CommandMate のこのリポジトリは公開なので数を出しても失うものは少ないが、他のリポジトリ（非公開のことがある）で同じことをする前に、出してよい範囲を人が決める。

---

## 10. 人の操作・人の判断

実機への導入（launchd の登録・設定ファイルの作成・Artifact の公開）はこの run の範囲外。

| # | 判断 | 選択肢 | 推奨と理由 |
|---|---|---|---|
| H1 | 15 分ごとの `tick` を何で起こすか | (a) launchd の利用者の agent（`StartInterval 900`）／(b) CommandMate の Schedule（エージェントのセッションで動く）／(c) PM が手で | **(a)**。計測は CommandMate のサーバー・エージェント・Docker が止まった時こそ動いていなければならない（2026-11-13 は Docker が止まったのに人が先に気づいた）。(b) はサーバーとエージェントに依存し、(c) は見張りが人に戻る。登録は人の操作（plist の作成と `launchctl`）。plist の雛形は PR1 では足さない（launchd に触れない）。PR5 までに docs に手順を書く |
| H2 | 警報の閾値の既定 | 開いた PR 5・マージ 0 の 60 分・順番待ち 15 分・取得元 2 回 | **Epic の「運用で先に入れること」の値をそのまま既定**にする（開いた PR 5、60 分、15 分）。運用の約束と警報の数字を一致させる。変えるのは `.commandmate/flow.yaml` |
| H3 | 台帳の場所 | (a) `flow.yaml` の `ledger.runsDir: workspace/orchestration/runs`（主 worktree の root から）／(b) 環境変数だけ | **(a)**。主 worktree の root からの相対なのでマシンの絶対パスを持ち込まず、どの worktree から動かしても同じ台帳を読む。CommandMate のこのリポジトリでは `workspace/` は git の外（追跡しない）なので、`flow.yaml` をコミットする PR は人が承認する |
| H4 | 計測の値を外（Artifact）へ出す範囲 | 数だけ／PR 番号まで／ブランチ名まで | **数だけ**（§9）。公開のリポジトリでも、ブランチ名・パスは試作に要らない |
| H5 | 警報の送り先（PR3） | PM の worktree・instance を `alerts.notify` に書く／書かない（記録と画面だけ） | **PR3 が入っても最初の 1 週は書かない**（記録と `status` だけ）。誤報の率を見てから送る。送るのは PM（開発リーダーではない）。PM が止まっている時は `isRunning: false` で送らないので、送れなかった記録が残る |
| H6 | 記録の保存期間 | 消さない／90 日で消す | **当面は消さない**（1 日 96 行・数百 KB の見立て）。消す仕組みは削除を伴うので、要るようになってから別の PR で人が承認する |
| H7 | ランナーの API の権限（PR2） | 今の `gh` の資格（F15 で読める）／専用のトークン | **今の資格**。他のリポジトリで 403 なら `denied` として扱い、`runners-zero` は鳴らない（その時は Docker の警報だけが頼り）。GitHub の設定は変えない |

---

## 11. 他の子への約束

| 相手 | 提供／利用 | 形 | 単位・意味 |
|---|---|---|---|
| #4368（WIP） | #4367 が**利用** | `countWip(input) → { unmergedBranches: number, activeBranches: number }`（純関数）と、`readWipInput(repoRoot, { run, now }) → { ok: true, input } \| { ok: false, reason }`（取得）。共通の枠 §3 の「純関数＋取得を分ける」 | リポジトリ × base。`exclude`（§2.1 の読み手が返す集合）を除く。`ok: false` のとき #4367 は `wipBranches: null`（I-1）。#4367 は数え方を持たない（I-11）。**#4368 に頼むこと**: 取得が時間切れつきであること（I-7）、`exclude` を #4367 の読み手から受け取る（二重に読まない） |
| #4368 | #4367 が**提供** | 設定の読み手 `readFlowConfig` の結果の `base`・`exclude`。`wip` 節は #4368 が同じ読み手の許可リストへ足す（PR1 は `wip` を exit 2 で拒む: 呼び手が無いため） | — |
| #4369（merge train） | #4367 が**提供**（書き手の形） | `appendFlowEvent(dir, { v: 1, kind: 'train', at, repo, base, trainId, event, prs, result?, note? })`。`event ∈ { created, ci-started, ci-finished, merged, ejected }`、`prs` は PR 番号の配列、`result ∈ { ok, fail, cancel }`（`ci-finished`・`merged` だけ）、`note` は 200 文字以内で改行なし。書く先は計測の記録と同じ日のファイル（§2.1）。書けなくても train は止めない（計測は fail-open。train の判定に記録を使わない） | PR1 の書き手は `kind: 'train'` を拒む（I-13）。**#4369 の PR が、呼び手と同じ PR で `train` を許可リストへ足す**（team.md §6 の 4）。集計（ダッシュボードの「マージの待ち」）は PR4 で `train` の行を読む |
| #4369 | #4367 が**提供** | `train` 節は #4369 が設定の読み手へ足す | — |
| #4370（資源） | #4367 が**利用** | 「CommandMate の使用量と上限」（枠の数・使用中の数を P0〜P3 ごと）を読む関数 `readSlots(env) → { ok, slots: [{ priority, limit, used }] } \| { ok: false }` を #4370 が出すなら PR4 で記録する（`resource.slots`）。無ければ記録しない | マシン単位。ランナーの online・Docker の状態は #4367 PR2 が自分で読む（#4370 のランナーの自動調整は、PR2 の記録を読んでよい: 記録の形 §2.2 の `resource.runnersOnline`・`resource.docker`） |
| #4370 | #4367 が**提供** | 計測の記録の `resource.*` と `ci.oldestQueuedMin`（読み手は `readFlowRecords`） | ランナーの自動調整の入力に使ってよい。書き換えはしない |
| 全員 | 共通 | 警報は「記録＋画面」が先。PM への送信は `alerts.notify` を明示したときだけ（共通の枠 §3）。#4368・#4369・#4370 が自分の警報を足すときは `alerts.jsonl` の形（§2.5）に `id` を足す | 警報の id は `<子の語>-<事象>`（例 `wip-over`・`train-stuck`）で重ならないようにする |

---

## 12. 既存の仕組みの再利用の可否

| 既存 | 使う／使わない | 理由 |
|---|---|---|
| `run-log.mjs`（台帳の書き手・読み手） | 形を**読む**だけ。import するのは `itemOf` だけ（**見立て**: 読み手 `readRecords` は `--issues` の 1 本を読む形で、日をまたぐ多数の台帳の読みに合わない） | F1・F2 |
| `pr-common.mjs` の `withGhRetry`・`ghJson`・`DEFAULT_REPO` | **使わない** | 呼び直しの待ちが長い（F5）・時間切れが無い（F6）・CommandMate 固有の既定値（F4） |
| `pr-common.mjs` の `GH_TRANSIENT_PATTERN` | 使う（`fail` の理由の分類に） | 5xx と接続の失敗の判定は同じでよい |
| `merge-pr.mjs` の `mergeLockName` | 形を写す（repo-slug） | F7。import するとマージのスクリプト全体を読み込むので写す |
| `machine-lock-sync.mjs` の `acquireMachineLockSync` | PR3 で使う（`flow.<repo-slug>`、時間切れ 0） | 送信の直列化。計測（PR1）は使わない |
| `precheck.mjs` の `cpu.heavy` | 使わない | 計測は軽い。重いロックの列に並ばない（I-10） |
| `metrics-runners.ts` の `runCommand` | 形を写す（プロセスグループ・時間切れ） | TS で `@/lib` を import するので `.mjs` から直接は使えない（F11）。PR5 で製品へ移すときに共通化を考える |
| `ci-flaky.ts` の `parseCiJobs` | 使わない | job の `created_at`・`started_at` を持たない（F10） |
| `src/lib/metrics/vibe-metrics.ts`・`/api/metrics/vibe`・`report metrics` | PR4 で API 越しに使う | DB を開かない（I-4、F12） |
| `.commandmate/verify.yaml` の読み手（`verify-config.ts`） | 流儀だけ揃える（`.commandmate/` の下・`version: 1`・`yaml`） | F14 |
| self-hosted ランナーの scripts（`runner.sh`） | 使わない・読まない | リポジトリの外にある（`git ls-files` に無い）。ランナーの状態は GitHub の API から読む（F15） |

---

## 13. 未確認・見立てと、本文に無い指摘

### 13.1 未確認

- GitHub の job の `created_at` が、`needs` で後に回る job でいつ付くか（run の作成時か、前の job の完了時か）。後者なら「順番待ち」に前の job の待ちは入らない。§2.3 の定義はどちらでも成り立つが、値の意味が変わる。PR1 の実装の契約で 1 本の run の job を見て確かめる
- GitHub の job の記録の保存期間（§8.2）
- 権限の無いリポジトリでランナーの API が 403 か 404 か（§10 H7）
- Epic の「CI の中央値 22 分・最長 78 分」の定義（§8.3）

### 13.2 見立て

- 1 日の記録は 96 行・1 行 1〜2 KB で数百 KB（§10 H6）
- `send` が exit ≠ 0 でも届いていることがある（§3.4）
- 滞留＝WIP ÷ スループットは定常でない日には目安（§2.3）

### 13.3 本文に無い指摘（直さない）

- Issue の「元は … CommandMate の DB（verify・task）」は、DB のファイルを直接読むと読める書き方だが、本書は API 越しに限った（I-4）。Issue の本文は変えていない
- Epic の時間帯ごとの作成／マージの数は窓の区切り（13:10〜）で数えていて、時の区切りの数と 13 時だけ違う（§8.3）。Epic の本文は変えていない
