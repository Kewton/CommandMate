# `milestone-check.mjs` — Milestone の整合の検査（Issue #4642 PR-1）

この文書は `scripts/orchestrate/milestone-check.mjs`（PR-1）の定義の正本。PR-2（運用文書への組み込み）と
PR-3（画面・CLI の可視化の設計）は別。

- 口: `node scripts/orchestrate/milestone-check.mjs check [--json] [--deadline-sec <n>] [--plan <状態ファイル>] [--no-history]`
- 口: `node scripts/orchestrate/milestone-check.mjs summary [--json|--md] [--deadline-sec <n>] [--plan <状態ファイル>] [--no-history]`
- exit: 0 ずれ無し／62 ずれあり／61 判定できない／2 使い方・設定の誤り／1 想定外。**強い順は 2 > 61 > 62 > 0**（判定できない入力が 1 つでもあれば、ずれがあっても 61）。`summary` はずれがあっても 0。対応表は [exit-codes.md](../orchestrate/exit-codes.md#1-5-milestone-check-の-exit-code)。
- `--json` は 1 行の JSON: `{ ok, complete, milestone: { current, previous[] }, rows[], unknown[], keyless[], observedFrom, observedTo }`。`summary --json` はさらに `summary: { done[], inProgress[], remaining[], deferred[], drift[] }` を足す。
- `--deadline-sec` の既定 120、上限 3600（`flow-wip.mjs` と同じ）。
- 配置の前提: `scripts/flow/`（issue #4367）の runner・config と同じリポジトリの worktree でだけ動く（`.commandmate/flow.yaml` を読む）。この PR の開発は `/orchestrate` の運用を変えない（流されなければ何も見えない、は PR-2 が手当てする）。

## 1 不変条件

- **I1 読み取り専用**: §4 の許可の表の外は `refused`（呼ばない）。書き込み・ロック・Milestone・ラベル・Issue の変更をしない。ファイルにも書かない（stdout・stderr だけ）。
- **I2 失敗を「ずれ無し」と読まない**: gh・git の失敗・時間切れ・JSON が読めない・件数が上限ちょうど（`--limit` と同じ数＝切れたと見なす）は、どれも判定できない（`complete: false`・exit 61・`unknown[]` に読みの名）。部分の結果で exit 0 を返さない。読めた分のずれの行は出してよいが exit は 61。
- **I3 鍵なし**: 番号の取れない worktree（detached を含む）と開いた PR を黙って落とさない（`keyless[]`）。
- **I4 今の Milestone は設定だけ**: `.commandmate/flow.yaml` の `milestone.current`。推さない（「open な Issue のある一番小さい Sprint」等は使わない）。
- **I5 証拠つき・決定的**: 各行は根拠（worktree のパス・ブランチ・PR 番号・Milestone 名・出来事の時刻）を持つ。同じ入力からは同じ出力（並びは Issue 番号の順、同じ番号の中は kind の順）。
- **I6 期限**: 全体の締め切りを単調時計の絶対の締め切りで守る（`flow-wip.mjs` の `makeRunner` と同じ形）。締め切りの後に返った結果は使わない（`timeout`）。
- **I7 本番 3000 を読まない・サーバーを呼ばない**: `fetch`・`http` を使わない。サーバーの task の記録（本番 3000 への GET）も読まない。
- **I8 既存の道具を書き替えない**: `flow-wip.mjs`・`pr-common.mjs`・`runner.mjs`・`precheck.mjs`・`merge-pr.mjs`・`wait-verify.mjs` は読む・import するだけ（この PR では `parseWorktreePorcelain` を import するだけ）。

## 2 鍵（Issue の番号）

| 出どころ | 取り方 | 例 |
|---|---|---|
| worktree のディレクトリ名（basename） | `^commandmate-issue-(\d+)` | `commandmate-issue-4604-s13` → 4604 |
| ブランチ | `^[a-z]+\/(\d+)[a-z]?((?:-\d+[a-z]?)*)-` の先頭の番号と、続く `-<数>` の番号の全部 | `fix/4621-4636-lock-test-flakes` → 4621・4636、`docs/4432a-verify-priority-design` → 4432 |
| 開いた PR・マージ済みの PR | 本文の `(?:Closes\|Fixes\|Resolves) #(\d+)`（大文字小文字を問わない）と `Refs #(\d+)`、題の `\(#(\d+)\)`。1 つも無ければブランチの鍵 | PR #4625 の本文 `Closes #4604` → 4604 |
| 計画の状態ファイル（`--plan`） | `items[].id` の先頭の番号（`^(\d+)`） | `4642-a1` → 4642 |

- 1 つの worktree・PR から複数の番号が取れたら、全部を証拠にする（ディレクトリ 4621、ブランチ 4621・4636 → 4621・4636）。
- **鍵なし（I3）**: 番号が取れない worktree（detached を含む）と開いた PR は `keyless[]` の行で出す（パス・ブランチ・PR 番号）。情報で、exit を変えない。
- 除外: 主の checkout（`git rev-parse --git-common-dir` の親）と、ブランチが `base`・`main`・`master` か `flow.yaml` の `exclude` にある worktree は、鍵なしにも出さない。

### 2.4 観測できない鍵（既知の限界）

`gh issue list --milestone` は、読んだ Milestone の一覧に属する Issue しか返さない。証拠の鍵がどの読んだ一覧にも無い場合（Milestone なし・後の Sprint に居る等）、その鍵が OPEN か CLOSED かを言える許可された読みはこの PR には無い。この PR はそれを **OPEN かつ Milestone なし** として読む（指定どおり `gh` を増やさないための限界）。したがって、閉じた Issue に残った worktree／ブランチは M1 として出うる。M1 の判定に要る Issue の Milestone は、current・前・後の Sprint の一覧と closed な Milestone の一覧（`open_issues` が 1 以上のものだけ）から決め、どれにも無ければ「Milestone なし」とする。

## 3 分ける種類（`rows[]` の `kind`。`severity` は `drift` か `info`）

| kind | 定義 | severity |
|---|---|---|
| `M1` 野良 | OPEN の Issue で、作業の証拠があるのに、Milestone が current でない（前・後の Sprint・ほかの Milestone・なし） | drift |
| `M1b` 残骸 | OPEN の Issue で、merged-worktree だけがあり、Milestone が current でない | info |
| `M2-residue` 残留 | current の OPEN の Issue で作業が始まっておらず、`--plan` があり、その item に無い | drift |
| `M2-planned` 計画にある（未着手） | 同上で、`--plan` の item にある | info |
| `M2-no-evidence` 証拠なし | 同上で、`--plan` が無い | info |
| `M3-closing-forgotten` 閉じ忘れ | OPEN の Issue で、窓の中のマージ済みの PR の本文が `Closes/Fixes/Resolves #N` を持ち、ラベル `merged-awaiting-accept` が無い | drift |
| `M3-awaiting-accept` 受け入れ待ち | 同上でラベルがある | info |
| `M4-previous-sprint` 前の Sprint の残り | 前の open な Sprint の Milestone に OPEN の Issue がある（1 Issue 1 行） | drift |
| `M5-closed-leftover` closed な Milestone の残り | closed な Milestone の `open_issues` が 1 以上（Milestone 1 行、数つき、`issue` は `null`） | drift |
| `M5-empty-previous` 空の前の Sprint | 前の open な Sprint で `open_issues` 0（リリース待ち） | info |
| `M6-unrecorded-move` 記録の無い移動 | current と前の open な Sprint の Issue の timeline の `milestoned`／`demilestoned` で、`roadmapIssue` の最後のコメントの `createdAt` より後のもの（1 出来事 1 行） | drift |

- 「作業が始まっている」＝ unmerged-worktree・fresh-worktree・open-pr のどれか。計画の item は「割り当て」で、M2 の未着手／残留を分け、M1 の証拠にはなるが進行中ではない。
- 証拠の鍵の Issue が CLOSED なら、M1 にしない（情報も出さない）。
- 1 つの Issue が複数の kind に当たれば、全部の行を出す。
- 並びは Issue 番号の順、同じ番号の中は kind の順（上表の順）。`issue` が `null` の行（M5）は番号の後ろに置く。

### 3.1 作業の証拠（Issue ごと）

worktree のブランチを、次の順で 1 つに分ける:

1. 窓の中のマージ済みの PR の `headRefName` がそのブランチ → **merged-worktree**（残骸）
2. `git rev-list --count refs/remotes/origin/<base>..refs/heads/<branch>` が 1 以上 → **unmerged-worktree**
3. 0 → **fresh-worktree**（コミットの無い新しいブランチ。**作業の証拠に数える**。`flow-wip.mjs` の数えの漏れを持ち込まない）
4. detached の worktree はディレクトリ名の鍵だけで **fresh-worktree** と同じ扱い（鍵が取れなければ鍵なし）
- rev-list が失敗・時間切れ → その worktree は判定できない（`unknown[]` に名指し、全体は 61）。

ほかの証拠: **open-pr**（開いた PR）、**plan-item**（`--plan` の item）。

## 4 許可の表（I1）

`isAllowedMilestoneCall(cmd, args)`。引数の完全一致・型・パターンで判定し、`gh` は先に `isGhRead(args)` が真であること。

- `git worktree list --porcelain`
- `git rev-parse --path-format=absolute --git-common-dir`
- `git rev-list --count refs/remotes/origin/<base>..refs/heads/<branch>`（`<branch>` は `[A-Za-z0-9._/-]+`、`..` を含まない）
- `gh api repos/<o>/<r>/milestones?state=all&per_page=100`
- `gh issue list --repo <o/r> --milestone <title> --state all --json number,state,title,labels,closedAt --limit 1000`
- `gh pr list --repo <o/r> --state open --base <base> --limit 1000 --json number,headRefName,title,body`
- `gh pr list --repo <o/r> --state merged --base <base> --search merged:>=<YYYY-MM-DD> --json number,headRefName,title,body,mergedAt --limit 300`
- M6 が on（既定）のときだけ: `gh api --paginate repos/<o>/<r>/issues/<N>/timeline?per_page=100`、`gh issue view <roadmapIssue> --repo <o/r> --json comments`

`repo`・`base` は `.commandmate/flow.yaml` の読み（`flow-wip.mjs` と同じ出どころ）。日付の窓は今日（注入できる時計）から `mergedWindowDays` 日前。

## 5 `summary`

- 見出しは固定の 5 つ、この順: `完了`（current の CLOSED）／`進行中`（current の OPEN で作業が始まっている）／`残り`（current の OPEN で作業が始まっていない）／`先送り`（M6 の出来事のうち current からの `demilestoned`。`--no-history` なら「（履歴を読んでいない）」の 1 行）／`ずれ`（check の drift の行）。
- `--md` は既定（`--json` を付けないとき）。1 行目 `## Milestone <current>（<完了数>/<全数> 完了）`。各見出しは `### <名>（<数>）`、Issue ごとに `- #<N> <題> — <現在地>`（現在地: worktree のパス・`PR #<M>`・`plan`。無ければ `—`）。ずれの行は `- <severity> <kind> #<N> — <detail>`。
- 判定できない入力があれば、1 行目の直後に `> 不完全: <理由>` を出し、exit 61。`--md` は exit 61・0 だけ（設定の誤りは 2）。
- `--json` は check と同じ形に `summary: { done[], inProgress[], remaining[], deferred[], drift[] }` を足す（各 item は `{ issue, title, where }`、`deferred` は `{ issue, title, at }`）。

## 6 確かめたこと（試験の生成元）

`tests/unit/scripts/orchestrate/milestone-check-4642.test.ts`。外の呼び出しは注入した偽の `spawnSync`（呼び出しを記録し、表の答えを返す）で作り、本物の `gh`・`git` を呼ばない。時計も注入する。

- **T1 判定の表**: 2 状態 × 5 Milestone × 7 証拠 = 70 行。期待は試験の中の独立した判定の表（実装を呼ばない）で出し、`{ kind, severity, issue }` の組の全部を `toEqual` で比べ、exit も見る。
- **T2 外の結果の表**: 各読み × { ok, fail, timeout, 件数の上限, 読めない JSON, 形 }。ok 以外の全部で `complete: false`・exit 61・`unknown[]` に読みの名。
- **T3 許可の表**: 表の中は真、表の外（`gh issue edit`・`gh api -X PATCH`・`gh api -f`・`gh label create`・`git checkout`・`git rev-list --count a..b`・`refs…a..b`）は偽。偽の `spawnSync` の記録で、表の外は 0 回。
- **T4 鍵**: ディレクトリ・ブランチ・PR 本文・題・`--plan` の取り方の表。鍵なしの worktree（`commandmate-accept-s12t-j` detached、`docs/s13-retro-measures`）と番号の無い開いた PR が `keyless[]` に出る。除外の worktree は出ない。
- **T5 設定**: `milestone.current` が無い・その Milestone が無い・closed → exit 2。`milestone` の節の形の誤り（知らない鍵・型）→ exit 2。
- **T6 `summary --md` の字面**: 固定の見出し 5 つ・順・Issue ごとの 1 行の形を、出力の全文で固定（`toBe`）。不完全の行。
- **T7 今日のずれ**（plan-4642 の (5) の fixture）: current＝Sprint 13。#4604 は M1（fresh-worktree）と M4。Sprint 12 の OPEN 10 件は M4（そのうち #4546 は worktree で M1 も）。`milestone.current` を Sprint 12 のままにすると Sprint 13 のレーン 4621・4631・4632・4640 が M1。Sprint 7（closed）に open 1 → M5。#4594 は PR #4639（マージ済み、本文 `Refs #4594`）の worktree で M1b（情報）、M3 にならない。M6 は #4461 の最後のコメントより後でだけ出る。
- **T8 期限**: 締め切りの後に返った結果を使わない（timeout として 61）。

## 7 この PR で決めたこと

- **`milestone.current` は名前で書く**（Q1）。推す規則はずれそのものに引きずられる。
- **受け入れ待ちの印はラベル `merged-awaiting-accept`**（Q2）。道具は読むだけで、作らない。
- **レーンの割り当ての正は計画の状態ファイルの `items[].id`**（Q3）。台帳の自由文は読まない。
- **検査は助言（exit 62 で何も止めない）**（Q4）。
- **画面・CLI の可視化は入れない**（Q5、PR-3 の設計）。
- **M6 を入れる。既定 on、`--no-history` で切る**（Q6）。
- **サーバーの task の記録（本番 3000）を読まない**（Q7）。
