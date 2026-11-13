# merge train — 複数の PR を 1 回の CI で確かめてマージする（Issue #4369）

- 状態: 設計（実装前）。Epic #4371（流れの計測と制御）の子 3。共通の枠はリーダー claude-3 の決定（2026-11-14、`s3-common-frame.md`）に従う
- 正本: Issue #4369 の本文と Epic #4371 の本文（背景の実測）。この文書は Issue の「仕様（案）」を実コード（`origin/develop` = `a334a013f`）に合わせて具体化したもの
- この run で実装するのは §11 の PR1 まで。二分探索（受入条件 2）は PR2

## 0. 結論

1. **train は「GitHub の squash を手元で再現した、単一親のコミットの鎖」として作る。** `git merge-tree --write-tree --merge-base=<merge-base(B0, head_k)> T_{k-1} head_k` で各 PR の squash の結果の tree を順に作り、`git commit-tree -p T_{k-1}` で積む。train の先端 `T_N` の tree が「N 本を squash し終えた base の tree」の予測で、CI はこの tree を 1 回だけ確かめる（§2）
2. **マージは各 PR を train の順に `gh pr merge --squash --match-head-commit <head_k>`。** 1 本ごとに「base の先端が 1 つ前の自分の squash であること」（前）と「新しい base の tree が `T_k` の tree と一致すること」（後）を機械で確かめ、どちらかが外れたら残りをマージしない（fail-closed、§3・§4）
3. **既存の `merge-pr.mjs` の確認は 1 つも外さない。** 組み合わせの確認（取り込み・衝突の印・tsc・影響テスト）は「各 PR の HEAD」から「train の HEAD」へ移り、必須チェックの判定は `--last` 相当（全チェック＋`LAST_REQUIRED_CHECKS` の登録）に固定され、merge のロック・`--match-head-commit`・未解決の記録はそのまま使う（§6 の表）
4. **赤は（PR2 で）接頭辞の二分探索。** train は鎖なので、接頭辞 `T_k` はすでにコミットとして在る。最小の赤い接頭辞 `k*` を探し、緑の接頭辞 `T_1..T_{k*-1}` をマージし、`P_{k*}` を外して残りで train を作り直す（§5）
5. **ci-pr.yml の `push: branches` に `train/**` を足すのは PR で足せる**（GitHub の設定は要らない）。develop にブランチ保護が無く、main の必須チェックは PR の文脈で効くだけなので、train の run は必須チェックに関わらない。ランナーの負荷は「N 本の取り込み直しの CI」が「1 本の train の CI」に置き換わる分だけ減る（§8）
6. **GitHub の merge queue はこのリポジトリでは使えない見込み（未確認）。** 持ち主は個人（`owner.type = User`）、develop に merge queue は設定されていない（GraphQL `mergeQueue(branch:"develop") = null`）、ruleset は 0 件。使えるリポジトリ向けの経路は PR4 の選択肢として設計だけ置く（§9）

## 1. 今の作り（事実、`origin/develop` a334a013f）

| もの | 場所 | 中身 |
|---|---|---|
| 1 本ずつのマージ | `scripts/orchestrate/merge-pr.mjs:438` `mergeOne` | 1 未マージ → 2 tree が clean → 3 記録（verify/review/findings）と断片 → 4 develop の取り込み（`:532-545`）・衝突の印の走査（`:568-573`）・precheck（`:579-628`、取り込んだ HEAD は `--heavy-to-ci`）・push（`:633-639`）→ 5 CI 待ち（`:642-778`）→ 6 `gh pr merge --squash --match-head-commit`（`:784`）と Issue の close（`:456-466`） |
| 必須チェックの判定 | `merge-pr.mjs:188` `judgeChecks` | `bucket` が `fail`/`cancel` なら fail、`--last` は全チェックが `pass`/`skipping` かつ `LAST_REQUIRED_CHECKS`（`:150-170`、19 件）が登録済み |
| 落ちたジョブの再実行 | `merge-pr.mjs:706-760` | HEAD ごとに 1 回、run の完走を待ってから（`runIdsOf :208`・`runsStillGoing :216`） |
| CI 待ち中の base の移動 | `merge-pr.mjs:695-704` | チェックを読んだ**後で** fetch、base がマージする SHA の祖先でなければ exit 4 |
| merge のロック | `merge-pr.mjs:313` `mergeLockName`、`:872` `takeMergeLock`（export されていない）、`:898` `runOne` | `merge.<owner>.<repo>.<base>`、置き場は `<lock root>/merge/`（`:822`）。札の順（`machine-lock-sync.mjs:1080` `acquireMachineLockSync`） |
| 未解決の記録 | `merge-pr.mjs:833` `readUnresolved`、`:853` `persistUnresolved`、`:906-917` `beforeWrite` | 書込みの段（`WRITE_PHASES = ['push','merge','close']`、`:140`）で死んだ持ち主のロックを回収すると `.unresolved/<token>.json`。その PR を含まない merge-pr は止まる |
| 列 | `merge-pr.mjs:286` `parseQueue`、`:946` `resolveEntries`、`:1029` `runQueue` | entry `<issue>[/<item>][@<pr>]` を PR → branch → worktree に解決。exit 3・4 を自動でやり直す |
| 専用のプロセスグループ | `merge-pr.mjs:1144` `innerSpawnOptions`、`:1157` `runOuter` | 自分を detached で起動し直し、ロックの記録に pgid を書く |
| precheck | `scripts/orchestrate/precheck.mjs:588` `main` | `--base` からの差分で tsc・`vitest related`・名指しのテスト・guards/docs。重い段は `cpu.heavy`（`:115`）か `--heavy-to-ci` で `<段>=ci` |
| 記録 | `scripts/orchestrate/run-log.mjs:63` `STAGES`、`:69` `LOG_STAGES = ['queue']`、`:178` `appendRecord` | `--issues` は数字の範囲だけ（`:90` `ISSUES_PATTERN`） |
| push・gh の共通 | `scripts/orchestrate/pr-common.mjs:224` `pushHead`（SHA を名指しで push）、`:169` `ghWrite`（書込みの確認つき再試行）、`:390` `missingRecords`、`:421` `markerFiles`、`:481` `fragmentProblems`、`:24` `DEFAULT_REPO`、`:26` `DEFAULT_BASE_BRANCH` | |
| CI の起動 | `.github/workflows/ci-pr.yml:100-104` | `push: branches: [main, develop]`、`pull_request: branches: [main, develop]` |
| CI の同時実行 | `ci-pr.yml:119-121` | `group: ci-pr-<event>-<PR 番号 or run_id>`、`cancel-in-progress` は `pull_request` だけ。push の run は互いに取り消さない |
| ランナーの選び方 | `ci-pr.yml:134` ほか | `pull_request` 以外（push）は `self-hosted`。`legacy-tmux-readmode`（`:281`）と集約ジョブ（`:616`）は `ubuntu-latest` |
| PR の run の自動取消 | `.github/workflows/cancel-pr-runs-on-close.yml` | PR を閉じる・マージすると、その PR の `pull_request` run を止める（push run には届かない） |
| 揺れの計測 | `src/lib/agent-health/ci-flaky.ts` | develop の push CI の失敗を `test`/`infra`/`other` に分ける純関数。揺れの判定の規則（別の規則）で再利用の候補 |

GitHub 側（`gh api` で 2026-11-14 に読んだもの）:

- `repos/Kewton/CommandMate`: `owner.type = "User"`、`visibility = "public"`、`allow_squash_merge = true`、`allow_auto_merge = false`
- `branches/develop/protection`: 404 `Branch not protected`
- `branches/main/protection`: 必須チェック `Unit Tests`・`Build`、`strict = true`
- `rulesets`: `[]`、`rules/branches/develop`: `[]`
- GraphQL `repository.mergeQueue(branch: "develop")`: `null`（`viewerCanAdminister = true`）
- `actions/runners`: self-hosted 6 台（ephemeral、`self-hosted, Linux, ARM64`）、読んだ時点で全台 online

## 2. train の作り方

### 2.1 記号

- `B0`: train を作る時点の `origin/<base>` の先端
- `P_1..P_N`: 候補の PR（§2.3 の順）。`h_k` はその `headRefOid`
- `T_0 = B0`、`T_k = commit-tree(tree = merge-tree(--merge-base=mb(B0, h_k), T_{k-1}, h_k), parent = T_{k-1})`
- train のブランチ `train/<base>/<UTC の時刻 YYYYMMDDTHHMMSSZ>`（例 `train/develop/20261114T073000Z`）が `T_N` を指す

### 2.2 なぜ「merge の鎖」でなく「squash の再現の鎖」か

Issue の案は「候補の head を順に merge」。素直な `git merge h_k` の鎖（2 親）だと、merge-base が `mb(T_{k-1}, h_k)` になり、GitHub が squash で使う `mb(B_{k-1}, h_k)`（`B_{k-1}` は squash の鎖なので `h_k` の祖先を含まない）と食い違うことがある（例: 2 本の PR が同じコミットを共有する、片方がもう片方の上に積まれている）。そうなると CI を通した tree と、マージ後の base の tree が一致しない。

squash の再現の鎖にすると:

- `T_k` の tree は「`P_1..P_k` を順に squash した後の base の tree」の予測そのもの（見立て: GitHub の squash の 3-way merge が git の merge-ort と同じ結果を出すこと。§12）
- 接頭辞 `T_k` がそのまま「k 本目までのマージ後」の予測なので、二分探索（§5）の候補を作り直さずに push できる
- 単一親なので、train の差分（`git diff B0..T_N`）が「マージで base に入るもの」に一致し、precheck の `--base` 差分がそのまま組み合わせの影響範囲になる

`git merge-tree --write-tree --merge-base` は git 2.40 以上（手元は 2.49.0）。足りなければ train は作らずに exit 2（§4）。

### 2.3 候補と並べ方

PR1 は呼び手が entry を渡す（`merge-pr.mjs --queue` と同じ形 `<issue>[/<item>][@<pr>]`、`resolveEntries` を再利用）。自動の候補選び（管理元へ向いた開いている PR を全部見る）は PR2。

候補の条件（どれか 1 つでも外れたら「外す」。外した理由を記録と出力に出し、残りで続ける）:

| # | 条件 | 確かめ方 | 由来 |
|---|---|---|---|
| C1 | PR が `OPEN` で base が `<base>` | `gh pr view --json state,baseRefName,headRefOid` | merge-pr 1 |
| C2 | worktree が clean で、worktree の HEAD = `headRefOid`（push していない作業が無い） | `dirtyPaths`、`git rev-parse HEAD` | merge-pr 2（train は PR の head を使うので、記録の HEAD と push 済みの HEAD が同じであることを求める） |
| C3 | verify / review / findings の記録が work HEAD にそろい、断片がある | `missingRecords`（precheck を除く）＋`fragmentProblems` | merge-pr 3 |
| C4 | PR 自身の CI が全緑 | `gh pr checks` を `judgeChecks(…, { last: true, required: LAST_REQUIRED_CHECKS })` で `ok` | Issue 仕様 1 |
| C5 | squash の再現で衝突しない | `merge-tree` の exit 1（衝突） | Issue 仕様 2 |
| C6 | 未解決の記録が無い（ある PR は train に入れず、`merge-pr --queue` でその PR を先に処理させる） | `readUnresolved` | merge-pr `beforeWrite` |

並べ方: PR1 は渡された順。PR2 で「PR の作成の古い順、UI の PR は後ろ」（UI の判定は変更パスの glob、`flow.yaml` の `train.uiPaths`。既定 `src/components/**`・`src/app/**/page.tsx`・`src/app/**/layout.tsx`・`tests/e2e/**`）。

### 2.4 組み合わせの確認（手元）

train の worktree（`<run-dir>/train/<時刻>`、`git worktree add --detach <path> T_N`）で:

1. 衝突の印の全追跡ファイル走査（`markerFiles`）
2. `precheck.mjs main` を train 専用の記録の置き場で呼ぶ: `--run-dir <run-dir>/train --issues <run の range> --issue <先頭の entry の Issue> --worktree <train の worktree> --base origin/<base> --heavy-to-ci`。記録の置き場を分けるので、各 Issue の precheck の記録（merge-pr・publish-pr・`status` が読む）を汚さない。`--allow-removed-tests` は、どれかの PR の work HEAD の precheck の記録がそれを持つときだけ付ける（各 PR の precheck で一度許された削除なので）
3. `node_modules`: train の worktree の `package-lock.json` が、`--source <worktree>`（既定は先頭の entry の worktree）と同じ blob なら `node_modules` をその worktree へ symlink。違えば重い段と同じく手元では走らせず（`tsc` も `=ci`）、記録に `deps=changed` と書いて CI に任せる

`--heavy-to-ci` にする理由は merge-pr の取り込み後と同じ（docs/orchestrate/ci-merge.md「6-2 取り込み後の重い段」、#4265）: 直後に同じ tree の CI を全部待つので、手元で `cpu.heavy` を取って待つ意味が無い。軽い段（changelog・removed-tests・ESLint・tsc・guards/docs・狭い related）が落ちたら push しない。

## 3. 不変条件

1. **I1** train がマージする PR は、train の CI が緑と判定された tree `tree(T_j)` に含まれる PR `P_1..P_j` だけで、その順番どおり
2. **I2** 各 PR は `--match-head-commit h_k`（train に入れた head）でだけマージする。PR の head が動いたら、その PR とそれより後はこの train でマージしない
3. **I3** `P_k` の squash を送る直前、`origin/<base>` の先端は `B_{k-1}`（k=1 なら `B0`、それ以外は 1 つ前の自分の squash の結果）でなければならない。違えば送らない
4. **I4** `P_k` の squash の後、`tree(origin/<base> の先端) == tree(T_k)`。違えば残りを送らず、`tree-mismatch` を記録して止まる（exit 1、人へ）
5. **I5** 全部を送り終えたとき `tree(origin/<base>) == tree(T_j)`（j は最後にマージした PR の位置）。これが受入条件 1 の機械の確認
6. **I6** CI の緑の判定は `judgeChecks(checks of T_j, { last: true, required: LAST_REQUIRED_CHECKS })` が `ok`、かつその判定を読んだ後の fetch で base が `B0` のまま（merge-pr `:695-704` と同じ順）
7. **I7** train は base ごとに 1 本だけ。merge のロック `merge.<owner>.<repo>.<base>` を、train を作る前から最後の記録まで持つ。merge-pr と train は互いを待つ
8. **I8** 未解決の記録がある間は、その PR を含まない書込みをしない（merge-pr の `beforeWrite` と同じ）。train の squash の段は `phase = 'merge'`・`pr = <番号>` をロックの記録に書いてから送る
9. **I9** train のブランチ（`train/**`）以外のブランチへ push しない。PR の head も base も train は書き換えない（base への書込みは `gh pr merge` だけ）
10. **I10** train は Issue を閉じない（`--close -` と同じ）。マージした PR ごとに run の記録の `merge` 段（`result=ok`・`note=pr=#N train=<名前> pos=k/N`）を書き、閉じるのは既存の経路（`merge-pr.mjs --queue` はマージ済みの entry を「記録と close だけ」で通す）
11. **I11** 外れた PR・作り直し・止まった理由は必ず記録（`train` の行）と標準エラーに出す。黙って外さない
12. **I12** 設定の値（base・repo・ブランチの接頭辞・必須チェックの一覧）はコードに埋め込まず、既定値か引数か `flow.yaml` から読む（共通の枠 §1）

## 4. 状態と遷移

| 状態 | 出来事 | 次の状態 | 副作用 |
|---|---|---|---|
| `start` | 引数が不正・git < 2.40・base に `strict` の必須チェック | `stopped(2)` | 何も書かない |
| `start` | merge のロックを取れた | `locked` | ロックの記録 `phase=train-select` |
| `start` | `--merge-lock-timeout` まで取れない | `stopped(124)` | `train` 行 `state=lock-timeout` |
| `locked` | 未解決の記録が候補外の PR を指す | `stopped(1)` | `train` 行 `state=recovered-stop` |
| `locked` | 候補を判定（C1〜C4、C6） | `building` | 外した PR を `train` 行 `state=dropped reason=…` |
| `locked` | 残りが 0 本 | `done(0)` | `train` 行 `state=empty` |
| `building` | `fetch` して `B0` を読み、`T_1..T_N` を作る（C5 の衝突は外して続ける） | `checking` | train の worktree を作る |
| `checking` | 印の走査・precheck が ok | `pushed` | `phase=train-push`、`pushHead(train/…)`、`train` 行 `state=pushed head=T_N` |
| `checking` | precheck が exit 3（保留） | `stopped(3)` | train の worktree を消す |
| `checking` | 印・precheck が失敗 | `stopped(1)` | 同上。どの PR の差分かは出力に（PR1 は外さない、PR2 は二分探索へ） |
| `pushed` | `--register-timeout` までチェックが 1 つも登録されない | `stopped(124)` | 「CI が `train/**` で起動しない」と案内 |
| `pushed` | チェックを読んだ後の fetch で base が `B0` から動いた | `rebuild` | `train` 行 `state=base-moved`、古い train の run を `gh run cancel`、ブランチを消す |
| `pushed` | fetch に失敗 | `pushed`（次の回に読み直す） | マージしない |
| `pushed` | `judgeChecks` が `fail` で、この `T_N` に再実行が未送信 | `pushed` | run の完走を待って `gh run rerun --failed`（1 回） |
| `pushed` | 再実行の後も `fail` | PR1: `stopped(1)`／PR2: `bisect` | `train` 行 `state=red failed=…` |
| `pushed` | `ok` | `merging(1)` | `train` 行 `state=green` |
| `pushed` | `--ci-timeout` 超過 | `stopped(124)` | |
| `rebuild` | やり直しが上限（既定 5 回、merge-pr の exit 4 と同じ）未満 | `locked`（ロックは持ったまま） | |
| `rebuild` | 上限 | `stopped(4)` | |
| `merging(k)` | `gh pr view` で `P_k` がすでに `MERGED` | `stopped(1)` | `merged-elsewhere`。I4 を確かめられないので残りは送らない |
| `merging(k)` | base の先端 ≠ `B_{k-1}`（I3） | k=1: `rebuild`／k>1: `stopped(4)` | k>1 は「1..k-1 はマージ済み、残りは次の train」 |
| `merging(k)` | 未解決の記録が他の PR を指す（I8） | `stopped(1)` | |
| `merging(k)` | `gh pr merge --squash --match-head-commit h_k` が成功 | `tree-check(k)` | `phase=merge pr=P_k`、`merge` 段 `ok` |
| `merging(k)` | 失敗（head が動いた・mergeable でない） | `stopped(1)` | `merge` 段 `fail`、残りを送らない |
| `tree-check(k)` | `tree(base) == tree(T_k)` | k<j: `merging(k+1)`／k=j: `done(0)` | `B_k` を記録 |
| `tree-check(k)` | 不一致 | `stopped(1)` | `train` 行 `state=tree-mismatch`、人へ |
| `tree-check(k)` | base の先端の親が `B_{k-1}` でない（誰かが割り込んだ） | `stopped(4)` | |
| `bisect`（PR2） | §5 | `merging(1)`（緑の接頭辞）→ `rebuild`（残り） | `train` 行 `state=bisect lo= hi=` |
| すべて | 終わる | — | ロックの記録 `phase=idle` で解放、train の worktree と `train/**` のブランチを消す（消せなくても exit は変えない） |

exit code は merge-pr と揃える: 0 全部（または 0 本）・1 条件／コマンドの失敗・2 使い方／git の版・3 precheck の保留・4 base が動いた（やり直しの上限、またはマージの途中）・124 時間切れ。

## 5. 赤のとき — 接頭辞の二分探索（PR2）

- 前提: base の先端（`B0`）の最新の push run が赤でないこと。赤なら二分探索に意味が無いので `stopped(1)`、`base-red`
- 揺れ: 二分探索に入る前に、`T_N` の落ちたジョブを 1 回だけ再実行（I6 と同じ規則）。揺れの判定（赤の場所と PR の差分の重なり）は別の規則（Epic の運用、`ci-flaky.ts` の分類の再利用を検討）で、この設計は決めない
- 探索: `lo = 0`（緑と見なす `B0`）、`hi = N`（赤）。`mid = ⌊(lo+hi)/2⌋` の `T_mid` を `train/<base>/<時刻>-p<mid>` で push して CI。緑なら `lo = mid`、赤なら `hi = mid`。`hi = lo + 1` で止まる。原因は `P_hi`
- 処置: `T_lo` までの緑の接頭辞を §4 の `merging` でマージ（I1 の j = lo）。`P_hi` を外して通知（`train` 行 `state=dropped reason=red`）。残り `P_{hi+1}..P_N` で train を作り直す
- CI の回数: train 1 回＋⌈log₂ N⌉ 回。N=5 で最大 4 回（1 本ずつなら 5 回、しかも各回に取り込み直し）
- 接頭辞の確認でも base が動いたら `rebuild`（接頭辞の結果は捨てる）

## 6. merge-pr.mjs の部品の再利用と、弱めないことの証明

| merge-pr の確認（file:line） | train のどこで行うか | 再利用の形 |
|---|---|---|
| 1 未マージ・`OPEN`（`:488-503`） | 候補 C1、`merging(k)` の直前の `gh pr view` | `prsOfBranch`・`ghJson` |
| 2 tree が clean（`:507-512`） | 候補 C2（worktree が clean かつ HEAD = PR の head）。train の worktree は新規なので常に clean | `dirtyPaths` |
| 3 記録と断片（`:518-531`） | 候補 C3 | `missingRecords`・`fragmentProblems`・`workHeadOf` |
| 4 develop の取り込み・衝突（`:532-545`） | §2.1 の squash の再現（C5）。衝突は外して通知 | `git merge-tree`（新規） |
| 4 衝突の印の走査（`:568-573`） | §2.4 の 1、train の worktree で | `markerFiles` |
| 4 precheck（`:579-628`）、取り込んだ HEAD は `--heavy-to-ci` | §2.4 の 2、train の HEAD で `--heavy-to-ci` | `precheck.mjs main` |
| 4 push（`:633-639`） | train のブランチへ | `pushHead` |
| 5 チェックの判定 `judgeChecks`（`:188`） | train の HEAD のチェックで、常に `last: true`・`required: LAST_REQUIRED_CHECKS`（`--last` なしの「Unit Tests・Build だけ待つ」例外は使わない＝強くなる） | `judgeChecks`（チェックの読み方は §7 の `bucketOf`） |
| 5 再実行は HEAD ごとに 1 回、run の完走後（`:706-760`） | train の HEAD ごとに同じ | `runIdsOf`・`runsStillGoing`・`ghWrite` |
| 5 `--register-timeout`・`--ci-timeout`（`:763-775`） | 同じ既定値（600 秒・3600 秒） | 定数を import |
| 5 CI 待ちの base の移動（`:695-704`） | 同じ順（チェックの後に fetch）。加えて I3（送る前）・I4（送った後） | — |
| 6 `--squash --match-head-commit`（`:784`） | 各 PR を `h_k` で。題名は `squashSubject` | `squashSubject`・`ghWrite` |
| 6 close（`:456-466`） | しない（I10）。記録だけ | — |
| merge のロック（`:872`） | train の全体で 1 回取る（I7） | `takeMergeLock` を export して使う（PR1 で export だけ足す。動きは変えない） |
| 未解決の記録（`:833`・`:906-917`） | 候補 C6 と、各 squash の前（I8） | `readUnresolved`、ロックの `setOwnerFields({ phase: 'merge', pr })` |
| 専用のプロセスグループ（`:1157`） | 同じ形で train も detached で起動し直す | `runOuter` の形を写す（`script` 引数で自分を指せる） |

弱くなる点（正直に書く）:

- **途中の base が CI を通っていない。** 1 本ずつなら各マージ後の base（`B_k`）は、その直前に PR の CI で同じ tree が確かめられていた。train では `B_1..B_{j-1}` の tree は確かめず、`B_j` だけ。途中の base の push run が赤でも、最新の push run（`B_j` = train の tree）が緑なら良しとする（Issue 仕様 5「base の push run は最新の 1 本だけ見る」）。I4 で各途中の tree は予測どおりなので、「CI を通した tree へ至る途中」であることは保証される
- **PR 自身の CI は古い base の上で走ったもの。** C4 は「その PR 単独で壊れていない」の確認で、組み合わせは train の CI が受け持つ（merge-pr でも取り込み後の HEAD の CI が組み合わせを受け持つのと同じ役割分担）

## 7. 外部の呼び出しごとの失敗の倒れ方

| 呼び出し | 失敗・時間切れ | 部分的な成功 | 倒れ方 |
|---|---|---|---|
| `git fetch origin <base>`（CI 待ち） | その回はマージしない、次の回に読み直す | — | fail-closed（merge-pr と同じ） |
| `git fetch`（作成時） | `stopped(1)` | — | fail-closed |
| `git merge-tree` | exit 1 = 衝突 → その PR を外す。それ以外の非 0 → `stopped(1)` | — | 衝突は外す、異常は止まる |
| `git commit-tree`・`git worktree add` | `stopped(1)` | worktree だけ残る → 終わりの片付けで消す。消せなければ警告 | fail-closed |
| precheck | 1 → `stopped(1)`、3 → `stopped(3)` | — | fail-closed |
| `git push origin T_N:refs/heads/train/…`（`pushHead`） | 一時的な 5xx は `pushHead` が再試行。拒否 → `stopped(1)` | push が届いたが応答が落ちた → `pushHead` が `ls-remote` で確かめる | fail-closed。train のブランチは使い捨てなので書込みの段に数えない（`WRITE_PHASES` に足さない） |
| チェックの読み取り `gh api repos/<repo>/commits/<T>/check-runs` | gh の再試行（`withGhRetry`）の後も失敗 → `stopped(1)` | ページの途中まで → `--paginate` で全部読めたときだけ判定 | fail-closed（読めないものを緑にしない） |
| `bucketOf(checkRun)` の対応 | 知らない `conclusion` は `pending`（待つ） | — | fail-closed。対応は §10 T-B の表で固定（見立て: gh の `bucket` と同じ対応） |
| `gh run rerun --failed` | `already running` → 完走後にもう一度。他 → `stopped(1)` | 受理の確認は attempt の増加（merge-pr と同じ） | fail-closed |
| `gh run cancel`（古い train） | 警告だけ（exit は変えない） | — | fail-open（ランナーの無駄で、正しさには関わらない） |
| `gh pr view`（マージ前） | 再試行の後も失敗 → `stopped(1)` | — | fail-closed |
| `gh pr merge --squash --match-head-commit` | 拒否 → `merge` 段 `fail`、`stopped(1)` | 応答が落ちた → `ghWrite` の `confirm`（`state = MERGED` かつ `headRefOid = h_k`） | fail-closed。ロックの `phase = merge` の間に死ねば、次の merge-pr／train が `.unresolved` を書く（既存の仕組み） |
| `gh api …/branches/<base>/protection`（strict の確認） | 404 = 保護なし → 続ける。他の失敗 → `stopped(2)` | — | fail-closed |
| ブランチの削除 `git push origin --delete train/…` | 警告だけ | — | fail-open（残っても train はブランチ名に時刻を持つので衝突しない） |
| ファイル（記録の追記） | `appendRecord` の例外 → `stopped(1)`。マージの後なら、マージは済んでいるので出力に「記録できなかった PR」を出す | — | 書込みの前の記録は fail-closed |
| merge のロック | 取れない → 124。持ち主が死んだ → 既存の回収（`onStaleHolder`） | — | 既存のまま |
| tmux・サーバー API・Docker | 使わない（PR1・PR2）。PR3 以降の API は §11 | — | — |

## 8. ci-pr.yml に `train/**` を足すこと

- 変更: `on.push.branches` を `[main, develop, 'train/**']` にする（`pull_request` は変えない）。ジョブは変えない（`LAST_REQUIRED_CHECKS` と `merge-pr.test.ts` の対応は崩れない）
- **PR で足せる。** push の run は**push したコミットの中の** `ci-pr.yml` で起動するので、develop にこの変更が入れば、それ以降に develop から作る train で効く。GitHub の設定（ブランチ保護・必須チェック・ruleset）は要らない
- 必須チェック: develop は保護されていない（404）。main の必須チェック（`Unit Tests`・`Build`、strict）は main へ向く PR の文脈のチェックで、train のコミットのチェックはどの PR にも結び付かないので影響しない
- 同時実行: `group: ci-pr-push-<run_id>`（`:120`）なので train の run どうしは取り消し合わない。作り直しのときは merge-train が古い train の run を `gh run cancel` で止める（自分の train のブランチの run だけ。§7 で fail-open）。`concurrency` は変えない（push の run を取り消さない既存の方針 `:112-118` を崩さない）
- ランナーの負荷（見立て。数は §1 の CI の構成から）: 1 回の run は 19 チェック（うち `ubuntu-latest` は `legacy-tmux-readmode` と集約 2 つ）。1 本ずつだと N 本で「取り込み直しの PR の run N 回＋develop の push run N 回」、train だと「train の run 1 回（赤なら＋⌈log₂ N⌉）＋develop の push run N 回」。取り込み直しの run が N−1 回減る。develop の push run N 回は変わらない（減らすのは §13 の未決 Q3）
- 試験: `ci-pr.yml` の `on.push.branches` に `train/**` があること、`concurrency.cancel-in-progress` が push で false のままであることを読む試験を足す（§10 T-W）

## 9. GitHub の merge queue との関係

- 事実: このリポジトリは個人の持ち物（`owner.type = User`）、develop に merge queue は無い（`mergeQueue = null`）、ruleset 0 件
- 見立て（未確認）: GitHub の告知（2023〜2024）では merge queue は組織の持つ公開リポジトリと Enterprise Cloud の非公開リポジトリが対象で、個人の持ち物では ruleset に merge queue を設定できない。`gh api` の読み取りの範囲では「設定されていない」までしか確かめられず、「設定できない」は確かめていない（設定を試すのは人の操作で、この run では触らない）
- 使えるリポジトリ向けの選択肢（PR4、任意）: `flow.yaml` の `train.mode: queue` のとき、候補の判定（C1〜C4、C6。記録の確認はここで済ませる）までを CommandMate が行い、`gh pr merge --squash --match-head-commit <h>`（merge queue が有効な base では列に並ぶ）で GitHub の列へ渡す。要るもの: `ci-pr.yml` の `on.merge_group`、base の ruleset の必須チェック。マージ後の処理（記録・I5 の tree の確認）は、PR が `MERGED` になったのを見て後から行う（GitHub の列の中に手元の確認は差し込めない）
- 注意（既知の罠、memory「gh pr merge --auto は即時マージに化ける」）: 必須チェックが無い base で `--auto` を使うと即時マージになる。queue の経路でも `--auto` は使わず、merge queue が有効であることを `gh api graphql` の `mergeQueue(branch)` が null でないことで確かめてから渡す（null なら train の経路へ倒す）

## 10. 試験の表

試験の置き場: `tests/unit/scripts/orchestrate/merge-train-4369.test.ts`（純関数と、`pr-fake.ts` に倣った偽の git／gh）、tree の再現だけは `fs.mkdtempSync(os.tmpdir())` の本物の git リポジトリで（`afterEach` で消す）。直す前の赤の形: `merge-train.mjs` が無いので import が失敗する（全行が赤）。陰性対照は既存の `merge-pr*.test.ts` が変わらず緑であること（PR1 は `takeMergeLock` の export を足すだけ）。

### T-S 候補の判定 `selectCandidates(entries, facts)`（it.each）

| # | state | base 一致 | clean・HEAD=head | 記録 | PR の CI | 未解決 | 期待 |
|---|---|---|---|---|---|---|---|
| S1 | OPEN | yes | yes | そろう | ok | 無し | 採る（陽性） |
| S2 | MERGED | yes | yes | そろう | ok | 無し | 外す `merged`（記録だけ） |
| S3 | CLOSED | — | — | — | — | — | 外す `closed` |
| S4 | OPEN | no | yes | そろう | ok | 無し | 外す `base-mismatch` |
| S5 | OPEN | yes | dirty | そろう | ok | 無し | 外す `dirty` |
| S6 | OPEN | yes | HEAD≠head | そろう | ok | 無し | 外す `unpushed` |
| S7 | OPEN | yes | yes | review 欠け | ok | 無し | 外す `record:review` |
| S8 | OPEN | yes | yes | 断片欠け | ok | 無し | 外す `fragment` |
| S9 | OPEN | yes | yes | そろう | pending | 無し | 外す `ci-pending` |
| S10 | OPEN | yes | yes | そろう | fail | 無し | 外す `ci-fail` |
| S11 | OPEN | yes | yes | そろう | 未登録の必須あり | 無し | 外す `ci-pending` |
| S12 | OPEN | yes | yes | そろう | ok | 自分の PR | 外す `unresolved`（merge-pr へ） |
| S13 | OPEN | yes | yes | そろう | ok | 他の PR | 全体を `recovered-stop`（exit 1） |
| S14 | OPEN | yes | yes | precheck だけ欠け | ok | 無し | 採る（precheck は train の HEAD で行う。陰性対照: merge-pr と同じく precheck を除く） |

### T-T squash の再現 `buildTrain(B0, heads)`（本物の git）

| # | 形 | 期待 |
|---|---|---|
| T1 | 別ファイルを変える 3 本 | `T_3` は単一親の鎖、`tree(T_3)` = 3 本を順に `git merge --squash` した tree（陽性） |
| T2 | 2 本目が 1 本目と同じ行で衝突 | 2 本目を外し `dropped: [{ pr, reason: 'conflict' }]`、`T_2` は 1・3 本目 |
| T3 | 2 本目が 1 本目のブランチの上に積まれている（コミットを共有） | merge-base は `mb(B0, h_2)`。`tree(T_2)` = squash を 2 回した tree（2 親の merge の鎖とは違う tree になる例を対照に置く） |
| T4 | 候補 0 本 | `T_N = B0`、train を作らない |
| T5 | git が 2.40 未満（偽の `git --version`） | exit 2 |
| T6 | ある PR の head が B0 の子孫でない（古い base から分岐） | merge-base は `mb(B0, h)` で、結果は `git merge --squash` と同じ |

### T-B チェックの読み `bucketOf(checkRun)`（it.each）

| status | conclusion | bucket |
|---|---|---|
| completed | success | pass |
| completed | skipped | skipping |
| completed | neutral | pass |
| completed | failure / timed_out / action_required / startup_failure | fail |
| completed | cancelled | cancel |
| queued / in_progress / waiting / pending / requested | null | pending |
| completed | 知らない値 | pending（fail-closed） |

（見立て: gh の `pr checks` の `bucket` の対応と同じ。PR1 の実装の最初に gh のソースの対応と突き合わせ、違えば gh に合わせて表を直す）

### T-C CI 待ち `waitTrainCi`（偽の gh・git、`now`・`sleep` を差し替え）

| # | チェック | fetch 後の base | 再実行 | 期待 |
|---|---|---|---|---|
| C1 | 全 pass＋必須 19 件登録 | B0 | — | `green`（陽性） |
| C2 | 全 pass、必須 1 件未登録 | B0 | — | 待つ |
| C3 | 1 件 fail、run 完走 | B0 | 未送信 | 再実行を送る、待つ |
| C4 | 1 件 fail | B0 | 送信済み | `red` |
| C5 | 1 件 fail、run 進行中 | B0 | 未送信 | 送らず待つ |
| C6 | 全 pass | 動いた | — | `base-moved`（マージしない。陰性対照: merge-pr の exit 4 と同じ順） |
| C7 | 全 pass | fetch 失敗 | — | 待つ（緑でもマージしない） |
| C8 | 0 件のまま register-timeout | — | — | 124 |
| C9 | pending のまま ci-timeout | B0 | — | 124 |

### T-M マージの段 `mergeTrain`（偽の gh・git）

| # | 状況 | 期待 |
|---|---|---|
| M1 | 3 本、各 squash の後の tree が `T_k` と一致 | 3 本ともマージ、`merge` 段 3 行、exit 0、最後に I5（受入条件 1） |
| M2 | 2 本目の squash の後の tree が不一致 | 1・2 本目はマージ済み、3 本目は送らない、`tree-mismatch`、exit 1 |
| M3 | 2 本目を送る前に base の先端が `B_1` でない | 2 本目以降を送らない、exit 4 |
| M4 | 1 本目を送る前に base が動いた | 作り直し（`rebuild`）、古い train ではマージしない（受入条件 3） |
| M5 | `gh pr merge` が head の不一致で拒否 | `merge` 段 `fail`、残りを送らない、exit 1 |
| M6 | `gh pr merge` の応答が落ちたが `MERGED`・head 一致 | 成功扱い（`ghWrite` の confirm） |
| M7 | 2 本目を送る前に他の PR の未解決の記録が現れた | 送らない、exit 1 |
| M8 | ロックの記録の `phase` | 各 squash の前に `merge`・`pr=<番号>`、終わりに `idle` |
| M9 | どの経路でも `gh issue close` を呼ばない | 呼び出しの記録に無い（I10） |
| M10 | 作り直しが 5 回続く | exit 4 |

### T-X 二分探索（PR2）

| # | N | 赤の原因 | 期待 |
|---|---|---|---|
| X1 | 5 | P3 | push は `p2`（緑）・`p3`（赤）の 2 回。P1・P2 をマージ、P3 を外し、P4・P5 で作り直し（受入条件 2） |
| X2 | 5 | P1 | `p2` 赤、`p1` 赤 → P1 を外す、0 本マージ、P2〜P5 で作り直し |
| X3 | 5 | P5 | `p2` 緑、`p3` 緑、`p4` 緑 → P1〜P4 をマージ、P5 を外す |
| X4 | 4 | P2 と P3 の組み合わせ | `p2` 緑、`p3` 赤 → P3 を外す（P2 は残る） |
| X5 | 3 | base が赤 | 探索しない、`base-red`、exit 1 |
| X6 | 5 | 探索の途中で base が動いた | 接頭辞の結果を捨てて作り直し |

### T-W ワークフロー（PR1、`ci-pr-train-trigger-4369.test.ts`）

| # | 読むもの | 期待 |
|---|---|---|
| W1 | `on.push.branches` | `train/**` を含む（直す前は赤） |
| W2 | `on.pull_request.branches` | `[main, develop]` のまま（陰性対照） |
| W3 | `concurrency.cancel-in-progress` | `github.event_name == 'pull_request'` のまま（push を取り消さない） |
| W4 | `LAST_REQUIRED_CHECKS` と全ジョブ | 既存の `merge-pr.test.ts` が緑のまま（陰性対照） |

### T-A 引数（it.each）

| 引数 | 期待 |
|---|---|
| `--queue` 無し | exit 2 |
| `--queue 4245,4245` | exit 2（同じ PR を 2 回、`resolveEntries` の規則） |
| `--max-prs 0` / `--max-prs 21` | exit 2（1〜20） |
| `--base` に `train/` で始まる名前 | exit 2 |
| `--close 4245` | exit 2（train は閉じない。`--close -` だけ受け付ける） |

## 11. PR の切り方

| PR | 中身 | 危険の境目 | 規模（見込み） |
|---|---|---|---|
| **PR1**（この run） | `merge-train.mjs`（作成・手元の確認・push・CI 待ち・マージ・tree の確認・base が動いたら作り直し。赤は止まる）、`ci-pr.yml` の `train/**`、`merge-pr.mjs` の export、`run-log.mjs` の `LOG_STAGES` | GitHub への書込み（push・merge）が始まる | 〜900 行・8 ファイル |
| PR2 | 二分探索（§5）、候補の自動の選び方と並べ方（§2.3）、`flow.yaml` の `train` 節（#4367 の読み手へ足す） | 赤のときに PR を外す判断が機械に移る | 〜600 行 |
| PR3 | 計測への記録（§12 の `flow` の出来事、#4367 の書き手を呼ぶ）と枠（#4370 の P0） | #4367・#4370 の PR1 の後 | 〜200 行 |
| PR4 | 製品の機能: `src/lib/flow/train/**`、CLI `commandmate train`（API を呼ぶ）、API `POST/GET /api/repositories/:id/train`、画面に列と train。任意で merge queue の経路（§9） | 製品の画面と API | 分ける（API と呼び手を同じ PR、§6-4） |

### 11.1 PR1 の範囲（そのまま実装の契約にできる粒度）

変更するファイル:

| ファイル | 変更 |
|---|---|
| `scripts/orchestrate/merge-train.mjs`（新規） | §2〜§4・§6・§7。export: `parseArgs`・`validate`・`bucketOf`・`selectCandidates`・`buildTrain`・`waitTrainCi`・`mergeTrain`・`main`・`runOuter`。usage は下 |
| `scripts/orchestrate/merge-pr.mjs` | `takeMergeLock`・`heldByLine`・`describeUnresolved` を export するだけ（動きは変えない） |
| `scripts/orchestrate/run-log.mjs` | `LOG_STAGES` に `'train'` を足す（`queue` と同じく HEAD を持たず進捗に数えない）。`status` の出力に `train:` の最新の行 |
| `.github/workflows/ci-pr.yml` | `on.push.branches` に `'train/**'` |
| `tests/unit/scripts/orchestrate/merge-train-4369.test.ts`（新規） | §10 の T-S・T-T・T-B・T-C・T-M・T-A |
| `tests/unit/scripts/orchestrate/ci-pr-train-trigger-4369.test.ts`（新規） | §10 の T-W |
| `tests/unit/scripts/orchestrate/run-log*.test.ts` の該当 | `LOG_STAGES` に `train` が加わったことの試験を足す（既存の `it` は消さない） |
| `docs/orchestrate/ci-merge.md` | 節「6-2 merge train（merge-train.mjs）」を足す（使い方・exit code・merge-pr との使い分け・弱くなる点 §6） |
| `docs/design/merge-train-4369.md` | 状態を「PR1 実装済み」に、実装で実コードに合わせた点を追記 |
| `changelog.d/4369.md` | 既存の 1 項目へ統合（同じ Issue の 2 本目の規則） |

usage:

```bash
node scripts/orchestrate/merge-train.mjs --run-dir <dir> --issues <range> --queue <issue[/item][@pr],...>
     [--base develop] [--repo Kewton/CommandMate] [--source <worktree>] [--max-prs 5]
     [--ci-timeout 3600] [--register-timeout 600] [--poll 30] [--merge-lock-timeout 14400] [--rebuild-max 5] [--close -]
```

受入基準:

1. 偽の gh・git で 3 本を CI 1 回でマージし、マージ後の base の tree が `T_3` の tree と一致する（T-M M1）。本物の git で `T_k` が `git merge --squash` を順に重ねた tree と一致する（T-T T1・T3）
2. CI 待ちの間に base が動いたら、マージせずに作り直す。作り直しの上限で exit 4（T-C C6・T-M M4・M10）
3. マージの途中で tree が食い違う・base に割り込まれたら残りを送らない（T-M M2・M3）
4. train は Issue を閉じない（T-M M9）。マージした PR ごとに run の記録の `merge` 段がある
5. merge のロックを merge-pr と共有し、未解決の記録を尊重する（T-S S12・S13、T-M M7・M8）
6. `ci-pr.yml` の push に `train/**` があり、既存の `merge-pr.test.ts` が緑のまま（T-W）
7. 赤のとき（PR1）は 1 本もマージせず exit 1、どの PR が入った train かを出力する

gates（契約の検証）: `work-evidence`・`scope`・`env-clean`・`npm run lint`・`npx tsc --noEmit`・`unit`（`tests/unit/scripts/orchestrate`・`tests/unit/guards`・`tests/unit/docs` を名指し）。実機（本物の GitHub への push・マージ）の UAT は PR1 の範囲外で、人の判断（§13 Q1）の後。

scope.allow の見込み: 上の表のファイル＋`changelog.d/4369.md`。

## 12. 他の子への約束

| 相手 | 提供／利用 | 形と単位 |
|---|---|---|
| #4367（計測） | 提供: train の出来事 | `recordFlowEvent({ kind: 'train', event, repo, base, train, at, prs, detail })`。`event` は `created`（`prs` = 入れた PR、`dropped` = 外した PR と理由）・`pushed`（`head`）・`ci`（`result: green/red/timeout`、`durationSec`、`checks` の要約）・`merged`（`pr`、`pos`、`squash` の SHA）・`dropped`（`pr`、`reason`）・`rebuilt`（`reason: base-moved/bisect`）・`stopped`（`exit`、`reason`）。1 出来事 1 行。書き手と置き場（`~/.commandmate/flow/<repo-slug>/<日付>.jsonl`）は #4367 が決め、#4369 は呼ぶだけ（PR3）。PR1・PR2 は run の記録の `train` 行だけ |
| #4367（計測） | 利用: `flow.yaml` の読み手 | `base`・`exclude` を読む。`train` 節（`maxPrs`・`uiPaths`・`mode`・`ciTimeoutSec`・`rebuildMax`）は #4369 PR2 が同じ読み手へ足す。読み手が無い間（PR1）は引数と既定値だけ |
| #4368（WIP） | 利用しない | train は WIP の数を変えない（マージで減るのは計測側が数える） |
| #4370（資源） | 利用: 枠 | train の CI 待ちと組み合わせの確認は P0（`acquireSlot('P0')`）。#4370 の PR1 が入るまでは merge のロックと、precheck の中の `cpu.heavy`（`--heavy-to-ci` なので取らないことが多い）だけで動く（共通の枠 §3） |
| #4370（資源） | 提供: 負荷の予定 | train の CI は 1 回で self-hosted のジョブを約 16 本使う（§8）。二分探索は 1 回ずつ直列で、同時に 2 本の train の run を出さない（I7） |
| PM・リーダー（運用） | 提供: 使い方 | `merge-pr --queue` の代わりに `merge-train --queue`。Issue を閉じるのは後で `merge-pr --queue <同じ entry>`（マージ済みは記録と close だけ） |

## 13. 人の操作・人の判断（未決。推奨つき）

| # | 決めること | 推奨 | 理由 |
|---|---|---|---|
| Q1 | PR1 の実機の試し方 | 開いている PR が 3 本以上たまったときに、`merge-pr --queue` の代わりに 1 回だけ使い、結果（CI の回数・時間・tree の一致）を見てから常用する | 偽の gh の試験では GitHub の squash の tree が merge-ort と一致するか（§2.2 の見立て）を確かめられない。最初の 1 回で I4 が外れれば止まるので害は小さい |
| Q2 | train が Issue を閉じるか | 閉じない（I10）。後で `merge-pr --queue` を同じ entry で流して閉じる | Issue 仕様 5「閉じない・記録」。複数 PR の Issue（`--item`）の閉じる規則を train に二重に持たない |
| Q3 | develop の途中の push run（`B_1..B_{j-1}`）を取り消すか | 取り消さない（今の `ci-pr.yml` の方針 `:112-118` のまま）。PR3 の計測でランナーの負荷を見てから決め直す | 途中の run は「CI を通した tree へ至る途中」の確認として捨てる理由が弱く、取り消すと ci-pr.yml の方針の変更（人の判断）になる |
| Q4 | 候補の条件 C4（PR 自身の CI が全緑）を外すか | 外さない | 外すと単独で壊れた PR が train に入り、二分探索の回数が増える。PR 自身の CI はすでに走っている（取り込み直しの CI ではない） |
| Q5 | GitHub の merge queue を試すか | このリポジトリでは試さない。組織の持つ別のリポジトリで使う人が出たら PR4 で | 個人の持ち物では使えない見込み（§9）。設定の変更は人の操作 |
| Q6 | base に strict の必須チェックがあるリポジトリ | train は exit 2 で断る（PR1）。2 本目の squash が「base より古い」で拒否されるため | 必須チェックの設定を変えるのは人の操作。断る形なら黙って 1 本ずつに落ちない |
| Q7 | ランナーの台数・Docker | 変えない（#4370 の範囲） | train は run の回数を減らす側 |

GitHub の設定・launchd・Docker・ランナーの変更はどれも要らない（`ci-pr.yml` の変更は PR で入る）。

## 14. 事実と見立ての区別

事実（この文書の作成時に読んだもの）:

- §1 の表の file:line（`origin/develop` a334a013f の `git show` で読んだ）
- §1 の GitHub の設定（`gh api` の読み取り、2026-11-14）
- push の run は push したコミットの中のワークフローの定義で起動する（GitHub Actions の仕様）
- `git merge-tree --write-tree --merge-base` は git 2.40 以上（手元は 2.49.0）

見立て（未確認）:

- **V1** GitHub の squash の tree は、`git merge-tree --merge-base=mb(base, head) base head` の tree と一致する（GitHub は merge-ort を使っている、という公開の情報に基づく）。外れたら I4 が止める。確かめ方は Q1
- **V2** 個人の持ち物のリポジトリでは merge queue を設定できない（§9）
- **V3** `bucketOf` の対応は gh の `pr checks` の `bucket` と同じ（§10 T-B）
- **V4** train の run の所要は PR の run と同程度（中央値 22 分、最長 78 分、Epic の実測）。train は差分が大きいぶん `vitest` の対象は変わらない（CI は全部を走らせる）ので、所要は本数に比例しない
- **V5** `precheck.mjs main` を train 専用の run-dir と先頭の entry の Issue 番号で呼んで、各 Issue の記録を汚さずに動く（`--issues` は数字の範囲だけ、`--issue` は記録の振り分けにしか使わない、と読んだ）。PR1 の最初の試験で確かめ、動かなければ段の実行部を関数に切り出す（その場合 `precheck.mjs` が PR1 の scope に入る）
- **V6** `node_modules` の symlink で train の worktree の tsc・vitest が動く（`package-lock.json` が同じとき）
