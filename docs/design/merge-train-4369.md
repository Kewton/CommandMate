# merge train — 複数の PR を 1 回の CI で確かめてマージする（Issue #4369）

- 状態: 設計（実装前）。第 2 版（2-4-4 事前レビュー P1 2・P2 7 とリーダーの再指示 1 を反映。改訂の履歴は末尾）
- 正本: Issue #4369 の本文と Epic #4371 の本文（背景の実測）。共通の枠（`s3-common-frame.md`）と突き合わせの決定（`s3-crosscheck.md` X1〜X10）に従う
- この run で実装するのは **PR1（train の作成・確認・報告。base へは書かない）** まで。マージの段は PR1b で、§12 の前提（人の判断）が決まってから。Issue の受入条件 1・3（N 本を CI 1 回でマージ・base が動いたら古い train でマージしない）は PR1b、受入条件 2（二分探索）は PR2 で満たす

## 0. 結論

1. **train は「GitHub の squash を手元で再現した、単一親のコミットの鎖」として作る。** `git merge-tree --write-tree --merge-base=<mb(B0, h_k)> T_{k-1} h_k` で各 PR の squash 後の tree を順に作り、`git commit-tree -p T_{k-1}` で積む。merge-base がちょうど 1 個の形だけを扱い、0 個・複数・再現できない属性は拒否する（§2.2）
2. **PR1 は「作成・確認・報告」まで。base には一切書かない。** 候補の選定 → train の作成 → 手元の組み合わせ確認 → train の ref の push → CI の待ちと判定 → 報告（どの PR を入れた train が緑／赤か、各 `T_k` の tree、CI の証拠、対象リポジトリの適格性）。`gh pr merge`・Issue の close・base への push は PR1 に入れず、引数でも拒否する（§11）
3. **運用:** PR1 の緑の train を見て、従来どおり `merge-pr.mjs` で 1 本ずつマージしてよい。そのときは既存の確認（取り込み・precheck・CI・merge のロック・`--match-head-commit`）がそのまま効く。PR1 だけではマージの時間は縮まない。縮むのは PR1b から
4. **マージの段（PR1b）は、F01（GitHub は期待する base を固定できない）と F02（途中で止まったときの未検証の接頭辞）の保証の方針を人が決めてから。** 推奨は「train の鎖を base へ fast-forward の push で一度に公開する」案（§12.3）。サーバーが base の不一致を拒否する（比較して交換）ので F01 が閉じ、公開が 1 回なので途中の base が存在せず F02 が閉じる。代償は履歴の形と PR の状態の付け方で、それを人が決める
5. **ci-pr.yml の `push: branches` に `train/**` を足すのは PR で足せる**（GitHub の設定は要らない。§8）
6. **GitHub の merge queue はこのリポジトリでは使えない見込み（未確認）。** PR1 は queue・ruleset・strict の有無を読んで報告に出し、読めなければ「不明」と書く。queue へ並べる経路は PR4 の選択肢（§9）

## 1. 今の作り（事実、`origin/develop` a334a013f）

| もの | 場所 | 中身 |
|---|---|---|
| 1 本ずつのマージ | `scripts/orchestrate/merge-pr.mjs:438` `mergeOne` | 1 未マージ → 2 tree が clean → 3 記録（verify/review/findings）と断片 → 4 develop の取り込み（`:532-545`）・衝突の印の走査（`:568-573`）・precheck（`:579-628`、取り込んだ HEAD は `--heavy-to-ci`）・push（`:633-639`）→ 5 CI 待ち（`:642-775`）→ 6 `gh pr merge --squash --match-head-commit`（`:784`）と Issue の close（`:456-466`） |
| 必須チェックの判定 | `merge-pr.mjs:188` `judgeChecks` | `bucket` が `fail`/`cancel` なら fail、`--last` は全チェックが `pass`/`skipping` かつ `LAST_REQUIRED_CHECKS`（`:150-170`、19 件）が登録済み |
| 落ちたジョブの再実行 | `merge-pr.mjs:706-760` | HEAD ごとに 1 回、run の完走を待ってから（`runIdsOf :208`・`runsStillGoing :216`） |
| CI 待ち中の base の移動 | `merge-pr.mjs:695-704` | チェックを読んだ**後で** fetch、base がマージする SHA の祖先でなければ exit 4 |
| merge のロック | `merge-pr.mjs:313` `mergeLockName`、`:872` `takeMergeLock`（export されていない）、`:898` `runOne` | `merge.<owner>.<repo>.<base>`、置き場は `<lock root>/merge/`（`:822`、merge-pr だけが読み書きする）。札の順（`machine-lock-sync.mjs:1080` `acquireMachineLockSync`） |
| ロックの記録の更新 | `machine-lock-sync.mjs:1285-1306` `setOwnerFields` | 失敗しても throw せず `false` を返す |
| 未解決の記録 | `merge-pr.mjs:833` `readUnresolved`（export 済み）、`:853` `persistUnresolved`、`:906-917` `beforeWrite` | 書込みの段（`WRITE_PHASES`、`:140`）で死んだ持ち主のロックを回収すると `.unresolved/<token>.json`。マージ済みの PR はその後 merge-pr が「記録と close だけ」で 0 を返し、ファイルを消す（`:490-498`・`:1109-1111`） |
| entry の解決 | `merge-pr.mjs:286` `parseQueue`、`:930` `parseWorktreeList`（どちらも export 済み）、`:946` `resolveEntries` | `resolveEntries` は `CLOSED`・worktree 0／2 以上・同じ PR を 2 回を `problems` に入れ、1 件でもあれば全体を返さない（`:991-1007`） |
| precheck | `scripts/orchestrate/precheck.mjs:588` `main`、`:419` `planSteps`、`:485` `optionsFromNote` | `--base` からの差分で changelog・removed-tests・ESLint・suppressions（`kind=refactor` か `--metrics` のときだけ、`:433-436`）・tsc（常に。heavy ではない）・related・tests。`--heavy-to-ci` が外すのは heavy と判定した段だけ（`:718-722`）。`--allow-removed-tests` は集約の差分の削除をすべて許す（`:697`） |
| 記録 | `scripts/orchestrate/run-log.mjs:63` `STAGES`、`:69` `LOG_STAGES = ['queue']`、`:178` `appendRecord` | `--issues` は数字の範囲だけ（`:90`） |
| push・gh の共通 | `scripts/orchestrate/pr-common.mjs:224` `pushHead`、`:169` `ghWrite`、`:143` `withGhRetry`、`:390` `missingRecords`、`:421` `markerFiles`、`:481` `fragmentProblems`、`:24` `DEFAULT_REPO`、`:26` `DEFAULT_BASE_BRANCH` | |
| CI の起動 | `.github/workflows/ci-pr.yml:100-104` | `push: branches: [main, develop]`、`pull_request: branches: [main, develop]` |
| CI の同時実行 | `ci-pr.yml:119-121`（方針の説明 `:112-118`） | `group: ci-pr-<event>-<PR 番号 or run_id>`、`cancel-in-progress` は `pull_request` だけ |
| ランナーの選び方 | `ci-pr.yml:134` ほか | push は `self-hosted`。`legacy-tmux-readmode`（`:281`）と集約ジョブ（`:616`）は `ubuntu-latest` |
| 揺れの計測 | `src/lib/agent-health/ci-flaky.ts` | develop の push CI の失敗を `test`/`infra`/`other` に分ける純関数（PR2 の揺れの規則で再利用の候補） |

GitHub 側（`gh api` の読み取り、2026-11-14。この版では再取得していない）:

- `repos/Kewton/CommandMate`: `owner.type = "User"`、`visibility = "public"`、`allow_squash_merge = true`、`allow_auto_merge = false`
- `branches/develop/protection`: 404 `Branch not protected`。`branches/main/protection`: 必須チェック `Unit Tests`・`Build`、`strict = true`
- `rulesets`: `[]`、`rules/branches/develop`: `[]`。GraphQL `mergeQueue(branch: "develop")`: `null`
- `actions/runners`: self-hosted 6 台（ephemeral）
- 手元の `gh` は 2.86.0。その `pr merge` の要求は head の一致（`expectedHeadOid`）だけで、期待する base の SHA を固定する条件は無い（GitHub の Merge API の `sha` も PR の head。事前レビュー F01 の引用による）

## 2. train の作り方

### 2.1 記号と train の同一性

- `B0`: train を作る時点の `origin/<base>` の先端。train の中で不変（precheck の `--base` も `B0` の SHA を渡し、共有の remote ref を後で fetch しても入力が差し替わらない）
- `P_1..P_N`: 候補の PR（渡された順）。`h_k` はその `headRefOid`
- `T_0 = B0`、`T_k = commit-tree(tree = merge-tree(--merge-base=mb(B0, h_k), T_{k-1}, h_k), parent = T_{k-1})`
- **train ID**: `<UTC の時刻 YYYYMMDDTHHMMSSmmmZ>-<pid>-<乱数 6 桁の hex>`。再利用しない。ref は `train/<base>/<train ID>`、worktree は `<run-dir>/train/<train ID>`、記録・報告のファイルは `<run-dir>/train/<train ID>.json`
- **train の manifest**（作成時に固定し、以後書き換えない）: `{ id, repo, base, B0, ref, entries: [{ issue, item, pr, headRepo, h, baseRef, workHead }], chain: [{ pr, T, tree }] }`。CI の判定・再実行・取消・片付けは、この manifest の `id`・`ref`・`T_N` に一致するものにだけ働く

### 2.2 squash の再現の鎖と、その成立条件（F03）

素直な `git merge h_k` の鎖（2 親）だと merge-base が `mb(T_{k-1}, h_k)` になり、GitHub の squash の `mb(B_{k-1}, h_k)` と食い違うことがある（コミットを共有する・積み上げた PR）。単一親の squash の再現の鎖なら `T_k` の tree が「k 本目までを squash した後の base の tree」の予測になり、接頭辞もそのままコミットとして在る。

ただし `--merge-base` は 1 個しか渡せず、merge-base が複数の履歴（criss-cross）では Git の通常の merge（仮想の merge-base を合成）と結果が違い得る（git-merge-tree の公式の説明）。そこで扱う形を狭める:

| 条件 | 判定 | 外れたとき |
|---|---|---|
| G1 merge-base がちょうど 1 個 | `git merge-base --all B0 h_k` の行数が 1 | 0 個（無関係の履歴）・2 個以上: その候補を外す（`dropped reason=merge-base-count=<n>`） |
| G2 再現できない属性が無い | `B0` と `h_k` の `.gitattributes`（全階層）に `merge=` の指定が無い。`h_k` の差分に gitlink（mode 160000）の変更が無い | 属性: train 全体を exit 2（`unsupported=merge-attribute`）。gitlink: その候補を外す |
| G3 衝突しない | `merge-tree` の exit 1 | その候補を外す（`dropped reason=conflict files=…`） |
| G4 git の版 | `merge-tree --write-tree --merge-base` は git 2.40 以上 | exit 2 |

rename・mode の変更・binary は扱う（ローカルの `git merge --squash` との一致を試験で固定する。§10 T-T）。**GitHub の squash との一致（見立て V1）は PR1 では確かめない**（PR1 はマージしない）。確かめ方は PR1b の前提（§12.4）: 使い捨ての検証先のリポジトリで、扱う形（T-T の各行）を実際に squash させて tree を比べてから、実 PR に使う。§12.3 の推奨案を採れば、base の tree は GitHub の squash ではなく train の tree そのものになり、V1 は要らなくなる。

### 2.3 entry の解決と候補の条件

entry は `merge-pr.mjs --queue` と同じ形 `<issue>[/<item>][@<pr>]`。`resolveEntries` は 1 件の問題で全体を返さない（`:991-1007`）ので、train は `parseQueue`・`parseWorktreeList` を再利用して**自分で 1 件ずつ分類する**（merge-pr の動きは変えない）。

| 分類 | 例 | 扱い |
|---|---|---|
| 使い方の誤り（全体を止める） | entry の書式違い、同じ PR を 2 回、`OPEN` の PR の worktree が 0 個か 2 個以上、PR を引けない（`pr` の記録が無い・`gh pr view` が見つからないと答える） | exit 2、何も作らない |
| 読み取りの失敗（全体を止める） | `gh` の再試行の後も失敗 | exit 1。「不適格」と同じにしない |
| 外す（理由を残して続ける） | C1〜C8 のどれかが外れる | `dropped` に `{ entry, pr, reason }` |

候補の条件（すべて満たすものだけ train に入れる）:

| # | 条件 | 確かめ方 | 由来 |
|---|---|---|---|
| C1 | PR が `OPEN`、`baseRefName = <base>`、`headRepository` が `<repo>`（フォークでない） | `gh pr view --json state,baseRefName,headRefOid,headRepository` | merge-pr 1 |
| C2 | worktree が clean で、worktree の HEAD = `headRefOid` | `dirtyPaths`、`git rev-parse HEAD` | merge-pr 2 |
| C3 | verify / review / findings の記録が work HEAD にそろい、断片がある | `missingRecords`（precheck を除く）＋`fragmentProblems` | merge-pr 3 |
| C4 | work HEAD（または公開 HEAD）に `precheck=ok` の記録があり、その `opts=` から条件（kind・metrics・build）を復元できる | `findLatest(…, { stage: 'precheck', result: 'ok' })`＋`optionsFromNote` | merge-pr `:588-605` の「条件が分からなければ止まる」と同じ（F04） |
| C5 | その precheck の `opts=` が `allow-removed:true` でない | 同上 | F04（テストの削除を許された PR は train に入れず、merge-pr で 1 本ずつ） |
| C6 | PR 自身の CI が全緑 | `gh pr checks` を `judgeChecks(…, { last: true, required })` | Issue 仕様 1 |
| C7 | 未解決の記録がその PR を指していない | `readUnresolved` | merge-pr `beforeWrite` |
| C8 | G1〜G3（§2.2） | `git merge-base --all`・属性・`merge-tree` | F03 |

未解決の記録が**候補に無い** PR を指すときは、PR1 は書込みをしないので止まらず、報告に出す（`unresolved: [...]`）。

### 2.4 組み合わせの確認（手元）

train の worktree（`git worktree add --detach <run-dir>/train/<ID> T_N`）で:

1. **依存（F05）**: `package-lock.json` の blob が `T_N`・`B0`・`--source <worktree>`（既定は先頭の候補の worktree）の HEAD で同じで、`<source>/node_modules` が在るときだけ、train の worktree に `node_modules` → `<source>/node_modules` の symlink を作る（source の worktree には何も書かない）。違う・不明（読めない・source の tree が dirty）なら **push の前に exit 2**（`deps=changed` か `deps=unknown`）。CI への委譲は採らない（tsc・ESLint・guards は heavy でないので `--heavy-to-ci` では外れず、委譲には precheck の変更が要る）。依存を変える PR は merge-pr で 1 本ずつ
2. 衝突の印の全追跡ファイル走査（`markerFiles`）
3. `precheck.mjs main` を train 専用の記録の置き場で呼ぶ: `--run-dir <run-dir>/train --issues <run の range> --issue <先頭の候補の Issue> --worktree <train の worktree> --base <B0 の SHA> --heavy-to-ci`、加えて**全候補の条件の和**（F04）:
   - どれかが `kind=refactor` なら `--kind refactor`、どれかが `metrics` なら `--metrics`（suppressions を train の差分全体で数える）
   - どれかが `build` なら `--build`
   - `--allow-removed-tests` は**付けない**（C5 で削除を許された PR は入っていない。train の差分にテストの削除があれば removed-tests の段が落ちて止まる＝集約の削除は拒否）
4. 重い段（広い related / tests）は `--heavy-to-ci` で CI に任せる（merge-pr の取り込み後と同じ。docs/orchestrate/ci-merge.md「6-2 取り込み後の重い段」、#4265）。軽い段が落ちたら push しない

ホストでのこの確認（tsc＋影響テスト）が、#4370 の枠の P0 に当たる唯一の区間（X10。CI の待ちには枠を握らない）。PR1 は #4370 の枠に依存せず、precheck の中の `cpu.heavy` の規則のまま。

## 3. 不変条件（PR1）

1. **I1** PR1 は base・PR の head・Issue・PR の状態のどれにも書かない。外へ書くのは `train/<base>/<自分の ID>` の ref の作成・削除と、自分の train の run の再実行・取消だけ
2. **I2** train の tree は §2.2 の G1〜G4 を満たす候補だけから作る。満たさない候補は理由つきで外し、黙って外さない
3. **I3** 組み合わせの確認の条件は全候補の条件の和で、テストの削除の許可は train へ移さない
4. **I4** 依存が `B0`・`T_N`・source で一致しないか確かめられないとき、train を push しない
5. **I5** CI の緑は、manifest の `ref`・`T_N` に結び付いた 1 つの run（workflow `ci-pr.yml`・event `push`・`head_sha = T_N`・`head_branch = ref`）の**最新の attempt** の全ジョブ（全ページ）と、`T_N` の他のチェック（check-runs）・status context をすべて読み、`judgeChecks(…, { last: true, required })` が `ok` で、status context に `error`/`failure`/`pending` が無いときだけ
6. **I6** 緑の判定は、それを読んだ**後**の fetch で base が `B0` のままであるときだけ有効（merge-pr `:695-704` と同じ順）。動いていたら古い train の結果を報告しても「緑」にせず `stale` とし、上限まで作り直す
7. **I7** 再実行・取消は manifest の run id にだけ、ref の削除は `--force-with-lease=refs/heads/<ref>:<T_N>` 付きでだけ行う。片付けは train のロックを持っている間に行う
8. **I8** train は base ごとに 1 本（train のロック `train.<owner>.<repo>.<base>`、置き場は `<lock root>/train/`。merge-train だけが読み書きする）。merge のロックは取らない（base へ書かないので merge-pr を止めない）
9. **I9** `merge=ok` などの各 Issue の進捗の記録を書かない。書くのは `train` の行（`LOG_STAGES`、HEAD を持たず進捗に数えない）と `<run-dir>/train/<ID>.json` の報告だけ
10. **I10** 対象リポジトリに固有の値（base・repo・必須チェックの一覧・workflow のファイル名）はコードに埋め込まない。必須チェックの既定は `repo == DEFAULT_REPO` のときだけ `LAST_REQUIRED_CHECKS`、それ以外は `--required-checks` が無ければ exit 2
11. **I11** 報告は採用・外した・CI の結果を集合として残す。exit 0 は「この train が緑」であって、外した entry を含む全 entry の完了ではない

## 4. 状態と遷移（PR1）

| 状態 | 出来事 | 次の状態 | 副作用 |
|---|---|---|---|
| `start` | 引数が不正（`--merge`・`--close <N>`・`--push-base` など書込みを求める引数を含む）・git < 2.40・再現できない属性・必須チェックの一覧が決まらない | `stopped(2)` | 何も書かない |
| `start` | train のロックを取れた | `locked` | ロックの記録 `phase=select train=<ID>`（`setOwnerFields` が `false` なら `stopped(1)`） |
| `start` | `--lock-timeout` まで取れない | `stopped(124)` | `train` 行 `state=lock-timeout` |
| `locked` | entry の解決で使い方の誤り／読み取りの失敗 | `stopped(2)`／`stopped(1)` | |
| `locked` | 適格性を読む（§7 の F08 の行） | `locked` | 報告の `eligibility` に `present/absent/unknown` |
| `locked` | 候補を判定（C1〜C8） | `building` | 外した PR を `dropped` に |
| `locked` | 残りが 0 本 | `done(0)` | `train` 行 `state=empty`、push しない |
| `building` | `B0` を読み、`T_1..T_N` を作り、manifest を書く | `checking` | train の worktree を作る |
| `checking` | 依存が不一致・不明 | `stopped(2)` | `deps=changed/unknown` |
| `checking` | 印・precheck が ok | `pushed` | ref が remote に無いことを確かめて `pushHead(ref, T_N)`、`train` 行 `state=pushed` |
| `checking` | precheck が exit 3（保留） | `stopped(3)` | |
| `checking` | 印・precheck が失敗 | `stopped(1)` | |
| `pushed` | `--register-timeout` まで manifest に合う run が無い | `stopped(124)` | 「CI が `train/**` で起動しない」と案内 |
| `pushed` | 合う run が 2 本以上 | `stopped(1)` | 取り違えを避ける |
| `pushed` | 判定の後の fetch で base が `B0` から動いた | `rebuild` | `train` 行 `state=base-moved`、自分の run を取消、自分の ref を lease 付きで削除 |
| `pushed` | fetch に失敗 | `pushed`（次の回に読み直す） | 緑にしない |
| `pushed` | `fail` で、この train に再実行が未送信 | `pushed` | run の完走を待って `gh run rerun <id> --failed`（1 回）。以後は attempt+1 だけを読む |
| `pushed` | 再実行の後も `fail` | `done(1)` red | 報告 `verdict=red failed=…`（どの PR が入った train か） |
| `pushed` | `ok` | `done(0)` green | 報告 `verdict=green`、各 `T_k` の tree |
| `pushed` | `--ci-timeout` 超過 | `stopped(124)` | |
| `rebuild` | やり直しが上限（`--rebuild-max`、既定 5）未満 | `locked`（新しい train ID で候補から） | |
| `rebuild` | 上限 | `stopped(4)` | |
| すべての終わり | — | — | train のロックを持ったまま、worktree を消し、green／red の ref は残す（報告から人が見られるように。`--keep-ref` 既定 on、`--no-keep-ref` で lease 付き削除）、それから解放 |

exit code: 0 緑（または 0 本）・1 赤／条件／コマンドの失敗・2 使い方／不適格・3 precheck の保留・4 作り直しの上限・124 時間切れ。

## 5. 赤のとき（PR2）— 接頭辞の探索（F09）

PR1 は赤なら報告して止まる。PR2 で次を足す:

- **始める条件**: `B0` の SHA に対応する、完了済みで緑の push run があること（「赤でない」ではない。pending・未登録・取消は始めない）
- **探索**: `lo = 0`（`B0`、緑を確認済み）、`hi = N`（赤）で、`T_mid` を `train/<base>/<ID>-p<mid>` に push して CI。見つかるのは**緑と赤の隣接の境目の 1 つ**で、単調でない列（緑・赤・赤・緑・赤）では「最初の原因」「唯一の原因」を意味しない。報告と通知では「原因」と断定せず「境目の PR（`P_hi`）」と書く
- **処置**: 境目の PR を外し、**残り（`P_1..P_{hi-1}` と `P_{hi+1}..P_N`）で新しい train を作って必ず検証し直す**。探索の途中の緑（`T_lo`）を、そのままマージの根拠にしない（PR1b の公開の方式に従い、検証した train だけを公開する）
- **回数の上限**: 外すのは 1 回の実行で 2 本まで。超えたら止めて人へ（揺れや組み合わせの問題の疑い）
- 揺れの判定（赤の場所と PR の差分の重なり）は別の規則（`ci-flaky.ts` の分類の再利用を検討）

## 6. merge-pr.mjs の部品の再利用と、弱めないこと

PR1 は base に書かないので、マージの安全性は既存の merge-pr のまま変わらない（緑の train の後も merge-pr でマージする）。下の表は「train の判定が merge-pr と同じ強さで行われるか」と、PR1b でマージを置き換えるときの対応。

| merge-pr の確認（file:line） | PR1（判定） | PR1b（マージ）で要るもの |
|---|---|---|
| 1 未マージ・`OPEN`（`:488-503`） | C1（宛先の branch と head の repo も） | 書く直前に宛先・head を読み直す（F01、R05） |
| 2 tree が clean（`:507-512`） | C2 | 同じ |
| 3 記録と断片（`:518-531`） | C3 | 同じ |
| 4 取り込み・衝突（`:532-545`） | squash の再現（§2.2 G1〜G3） | 同じ |
| 4 衝突の印（`:568-573`） | §2.4 の 2 | 同じ |
| 4 precheck、条件の引継ぎ（`:579-628`、`:588-605`） | §2.4 の 3（条件の和、削除の許可は移さない、依存の不一致は拒否） | 同じ |
| 4 push（`:633-639`） | train の ref へ（`pushHead`、ref が無いことを先に確かめる） | §12 の公開の方式による |
| 5 `judgeChecks`（`:188`） | 常に `last: true`（`--last` なしの例外は使わない）＋run・attempt・status の束ね（I5） | 同じ |
| 5 再実行 1 回（`:706-760`） | train ID ごとに 1 回、manifest の run だけ | 同じ |
| 5 timeout（`:763-775`） | 同じ既定値 | 同じ |
| 5 CI 待ちの base の移動（`:695-704`） | I6 | 公開の直前までと、公開の比較・交換（§12） |
| 6 `--match-head-commit`（`:784`） | 該当なし（マージしない） | §12 の方式で head を固定する |
| 6 close（`:456-466`） | しない | しない（記録だけ。§12.5） |
| merge のロック（`:872`） | 取らない（I8）。train のロックで train どうしを直列 | 取る（merge-pr と直列） |
| 未解決の記録（`:833`・`:906-917`） | C7 と報告 | train 由来の未確認を merge-pr が勝手に解消しない分岐（F07、§12.5） |
| 専用のプロセスグループ（`:1157`） | 同じ形（`runOuter` を写す） | 同じ |

**merge-pr.mjs の変更は PR1 では無い**（`takeMergeLock` の export は不要になった。`parseQueue`・`parseWorktreeList`・`readUnresolved`・`judgeChecks`・`runIdsOf`・`runsStillGoing`・`LAST_REQUIRED_CHECKS`・タイムアウトの定数は export 済み）。

PR1b で弱くなりうる点（§12 で人が決める）: 途中の base が CI を通らないこと（F02）、GitHub 側で base を固定できないこと（F01）。

## 7. 外部の呼び出しごとの失敗の倒れ方（PR1）

| 呼び出し | 失敗・時間切れ | 部分的な成功 | 倒れ方 |
|---|---|---|---|
| `git fetch origin <base>`（作成時） | `stopped(1)` | — | fail-closed |
| `git fetch`（CI 待ち） | その回は緑にしない、次の回に読み直す | — | fail-closed |
| `git merge-base --all`・`merge-tree` | 衝突（exit 1）は外す。他の非 0 は `stopped(1)` | — | 衝突は外す、異常は止まる |
| `git commit-tree`・`git worktree add` | `stopped(1)` | worktree だけ残る → 終わりの片付けで消す。消せなければ警告 | fail-closed |
| `node_modules` の symlink | `stopped(2)` | — | fail-closed（source には書かない） |
| precheck | 1 → `stopped(1)`、3 → `stopped(3)` | — | fail-closed |
| `git ls-remote origin <ref>`（ref が無いこと） | 読めない・在る → `stopped(1)` | — | fail-closed（他人の ref を上書きしない） |
| `git push origin T_N:refs/heads/<ref>`（`pushHead`） | 一時的な 5xx は再試行。拒否 → `stopped(1)` | 応答が落ちた → `ls-remote` で確かめる | fail-closed |
| run の特定 `gh api repos/<repo>/actions/runs?head_sha=<T_N>&event=push&branch=<ref>`（`--paginate`） | 再試行の後も失敗 → `stopped(1)` | ページの途中で失敗 → その回は判定しない | fail-closed |
| ジョブ `…/runs/<id>/attempts/<n>/jobs`（`--paginate`） | 同上 | 古い attempt の結果は混ぜない | fail-closed |
| 他のチェック `…/commits/<T_N>/check-runs`（`--paginate`） | 同上 | manifest の run 以外の check-run が `fail`→赤、`pending`→待つ | fail-closed |
| status `…/commits/<T_N>/status` | 同上 | `error`/`failure` → 赤、`pending` → 待つ、0 件 → 無視（待たない） | fail-closed |
| `bucketOf` | 知らない値は `pending` | — | fail-closed |
| `gh run rerun <id> --failed` | `already running` → 完走後にもう一度。他 → `stopped(1)` | 受理は attempt の増加で確かめる（merge-pr と同じ） | fail-closed |
| `gh run cancel <id>`（作り直し） | 警告だけ。次の train の判定は新しい ID の run しか読まないので結果に混ざらない | — | fail-open（無駄な run が残るだけ。報告に `cancel=failed run=<id>`） |
| ref の削除（lease 付き） | 警告だけ | lease が外れた（他の SHA）→ 消さない | fail-open（自分の SHA でなければ触らない） |
| 適格性の読み取り（F08）: `branches/<base>/protection`・`rules/branches/<base>`・GraphQL `mergeQueue(branch)` | 404（保護なし）は `absent`、403・5xx・読めない → `unknown`（`absent` にしない） | — | PR1 は報告に出すだけ（マージしないので止めない）。PR1b は `unknown` で拒否 |
| 記録の追記（`train` 行・報告の JSON） | `stopped(1)` | — | fail-closed（書込みは自分のファイルだけ） |
| ロックの記録の更新 `setOwnerFields` | `false` → `stopped(1)` | — | fail-closed |
| train のロック | 取れない → 124。持ち主が死んだ → 既存の回収 | — | 既存のまま |
| tmux・サーバー API・Docker | 使わない | — | — |

## 8. ci-pr.yml に `train/**` を足すこと

- 変更: `on.push.branches` を `[main, develop, 'train/**']` にする（`pull_request` とジョブは変えない。`LAST_REQUIRED_CHECKS` と `merge-pr.test.ts` の対応は崩れない）
- **PR で足せる。** push の run は push したコミットの中の `ci-pr.yml` で起動するので、develop にこの変更が入れば、それ以降に develop から作る train で効く。GitHub の設定は要らない
- 必須チェック: develop は保護されていない。main の必須チェックは main へ向く PR の文脈で効き、train のコミットのチェックはどの PR にも結び付かない
- 同時実行: `group: ci-pr-push-<run_id>`（`:120`）なので train の run どうしは取り消し合わない。作り直しの古い run は merge-train が manifest の run id で取り消す。`concurrency` は変えない（push の run を取り消さない既存の方針を崩さない）
- ランナーの負荷: PR1 では**増える**（train の run が 1 本増え、マージは従来どおり merge-pr の取り込み直しの run を使う）。減るのは PR1b から（取り込み直しの run N 回が train の run 1 回に置き換わる。見立て）。取消の失敗で古い run が残ることもあるので、「常に 1 run」「負荷は必ず減る」は保証ではなく PR3 の計測の対象
- 試験: §10 T-W

## 9. GitHub の merge queue との関係

- 事実: 持ち主は個人、develop に merge queue は無い、ruleset 0 件。`gh` 2.86.0 の `pr merge` は、queue の対象の base では通常の要求を queue／auto の経路へ変える（`--auto` を付けなくても。事前レビュー F08 の引用）
- 見立て（未確認）: 個人の持ち物のリポジトリでは merge queue を設定できない
- PR1: queue の有無（GraphQL `mergeQueue(branch)`）を読んで報告に出す。読めなければ `unknown`
- PR1b: queue が `present` か `unknown` の base では、マージの段を始めない（exit 2）。queue で 0 が返っても即時 `MERGED` とは限らず、止まった後に列がマージしうるため
- PR4（任意）: queue が使えるリポジトリ向けに、候補の判定（記録の確認）までを CommandMate が行い GitHub の列へ渡す経路。`ci-pr.yml` の `on.merge_group` が要る。`--auto` は使わない（必須チェックの無い base では即時マージに化ける）

## 10. 試験の表（PR1）

置き場:
- `tests/unit/scripts/orchestrate/merge-train-4369.test.ts`: 公開の `main` を偽の git／gh（`pr-fake.ts` に倣う）と `now`・`sleep` の差し替えで通す。純関数だけで済ませず、**副作用（呼んだ gh・git の引数、書いたファイル、exit）を assert する**
- `tests/unit/scripts/orchestrate/merge-train-git-4369.test.ts`: tree の再現と依存の判定を、`fs.mkdtempSync(os.tmpdir())` の本物の git リポジトリで（`afterEach` で消す）。precheck は実の `precheck.mjs main` を `run` の差し替えで呼び、生成した引数だけでなく `planSteps`・removed-tests の判定を通す
- `tests/unit/scripts/orchestrate/ci-pr-train-trigger-4369.test.ts`: ワークフロー

対照の作り方: 各行の陽性は「その防御（下の列「外すと」）を実装から外すと赤になる」形にする。直す前の赤（ファイルが無くて import が失敗する）は防御の証明にしない。陰性は既存の `merge-pr*.test.ts`・`run-log*.test.ts` が変わらず緑であることと、各表の正常の行。

### T-T squash の再現（本物の git）— R02・R03

| # | 形 | 期待 | 外すと |
|---|---|---|---|
| T1 | 別ファイルを変える 3 本 | `T_3` は単一親の鎖、`tree(T_3)` = 3 本を順に `git merge --squash` した tree（陰性） | — |
| T2 | 2 本目が 1 本目と同じ行で衝突 | 2 本目を外す（`conflict`）、`T_2` は 1・3 本目 | 衝突を外さないと exit 1 で全体が止まる |
| T3 | 2 本目が 1 本目のブランチの上に積まれている | `tree(T_2)` = squash を 2 回した tree。2 親の merge の鎖と違う tree になる対照つき（R02） | merge-base に `T_{k-1}` を使うと赤 |
| T4 | 候補 0 本 | push しない、exit 0、`state=empty`（R23） | — |
| T5 | git が 2.40 未満 | exit 2 | — |
| T6 | 古い base から分岐した PR | `git merge --squash` と同じ tree（R02） | — |
| T7 | merge-base が 2 個（criss-cross）。1 個指定の結果と通常の squash の結果が違う fixture | その候補を外す（`merge-base-count=2`）（R03 陽性） | G1 を外すと `tree(T_N)` が通常の squash と食い違って赤 |
| T8 | 無関係の履歴（merge-base 0 個） | 外す（`merge-base-count=0`） | — |
| T9 | `.gitattributes` に `merge=` | exit 2 `unsupported=merge-attribute` | G2 を外すと push まで進んで赤 |
| T10 | gitlink の変更を含む PR | 外す | — |
| T11 | rename・mode の変更・binary | `git merge --squash` と同じ tree（R03 陰性） | — |

### T-E entry の解決と候補 — R18・R23・R24

| # | 入力・状態 | 期待 |
|---|---|---|
| E1 | 3 本すべて適格 | 3 本で train（陰性） |
| E2 | `CLOSED`・`MERGED`・base が違う・フォーク・dirty・HEAD≠head・review 欠け・断片欠け・PR の CI が pending／fail・自分を指す未解決 | それぞれ外す、理由つき、残りで続ける。報告の `dropped` に全部（R18） |
| E3 | precheck の記録が無い／`opts=` が読めない | 外す `precheck-options-unknown`（C4） |
| E4 | precheck の記録が `allow-removed:true` | 外す `removed-tests-allowed`（C5） |
| E5 | 同じ PR を 2 回・worktree 0 個／2 個・書式違い | exit 2、何も作らない（R23） |
| E6 | `gh pr view` が 5xx を返し続ける | exit 1（「外す」にしない） |
| E7 | 全候補が外れる／全候補が衝突 | push しない、exit 0、`state=empty`（R23） |
| E8 | `--max-prs` を超える | 先頭から `--max-prs` 本、残りは `dropped reason=over-limit` |
| E9 | 候補に無い PR の未解決の記録 | 続ける、報告の `unresolved` に出す |
| E10 | 終わった後の run の記録 | `train` 行だけ増え、各 Issue の `merge`・`ci`・`precheck` の記録は増えない。`run-log.mjs status` の進捗（`headsOf`・`summarize`）は変わらない（R24） |

### T-P 組み合わせの確認 — R15・R16・R17

| # | 入力・状態 | 期待 | 外すと |
|---|---|---|---|
| P1 | 1 本が `kind=refactor`、他は bug | 実の precheck で suppressions の段が走る（R15 陽性） | 条件の和を取らないと suppressions が skip になり赤 |
| P2 | 全部 bug | suppressions は走らない（陰性） | — |
| P3 | 1 本が `build` | `--build` で build の 3 段 | — |
| P4 | A は削除を許された（C5 で外れる）、B は許されていない削除を含む | A は外れ、B を含む train は removed-tests で exit 1、push しない（R16 陽性） | 許可を OR すると push まで進んで赤 |
| P5 | lockfile が `B0`・`T_N`・source で同じ、`node_modules` あり | symlink を作り precheck を走らせる。source の worktree の中身は変わらない（R17 陰性） | — |
| P6 | train が lockfile を変える | push の前に exit 2 `deps=changed`、`npm` を 1 回も起動しない、precheck の記録を書かない（R17 陽性） | 依存の判定を外すと precheck が起動して赤 |
| P7 | source に `node_modules` が無い／source の lockfile が違う | exit 2 `deps=unknown`／`deps=changed` | — |
| P8 | precheck が exit 3 | exit 3、push しない | — |
| P9 | precheck の `--base` | `B0` の SHA（`origin/<base>` の名前ではない） | 名前を渡すと、途中の fetch で入力が変わる fixture で赤 |

### T-B チェックの読み `bucketOf`（it.each）

gh 2.86.0 の `pr checks` の対応（`pkg/cmd/pr/checks/aggregate.go`）に合わせる。事前レビューの引用で、PR1 の実装の最初に原典で確かめる。

| 種類 | 値 | bucket |
|---|---|---|
| check-run / job の `conclusion` | `success` | pass |
| 同 | `skipped`・`neutral` | skipping |
| 同 | `failure`・`timed_out`・`action_required` | fail |
| 同 | `cancelled` | cancel |
| 同 | `startup_failure`・知らない値・`status` が completed でない | pending |
| status context の `state` | `success` | pass |
| 同 | `error`・`failure` | fail |
| 同 | `pending` | pending |

### T-C CI の証拠と待ち — R11〜R14・R19〜R21

| # | 状況 | 期待 | 外すと |
|---|---|---|---|
| C1 | manifest の run の最新 attempt の 19 ジョブが全 pass、status 0 件、fetch 後の base = `B0` | `verdict=green`、exit 0（陰性） | — |
| C2 | 同じ `T_N` の別 workflow／`pull_request` の run が全緑、manifest の run は pending | 待つ（R12 陽性） | run を束ねないと誤って緑 |
| C3 | 19 の同名のジョブが別の run で緑、manifest の run は pending | 待つ | 名前だけで読むと誤って緑 |
| C4 | check-runs は全緑、status context が `failure`／`pending` | 赤／待つ（R13 陽性） | status を読まないと誤って緑 |
| C5 | attempt 1 が赤、attempt 2 が進行中、その後緑 | attempt 2 だけを読み、緑。再実行は 1 回だけ送る（R14） | 古い attempt を混ぜると赤のまま |
| C6 | ジョブの一覧の 2 ページ目の取得に失敗 | その回は判定しない | — |
| C7 | manifest に合う run が 2 本 | exit 1 | — |
| C8 | 再実行の後も赤 | exit 1、報告に入れた PR と落ちたジョブ | — |
| C9 | 判定の後の fetch で base が動いた | `stale`、自分の run を取消、新しい ID で作り直し（R21） | 判定の後に読まないと古い train を緑と報告 |
| C10 | 作り直しの後に、古い train の run が遅れて緑 | 新しい train の判定に混ざらない（R21） | — |
| C11 | 同じ秒に 2 回作り直す／前の片付けが遅れて動く | ID が違い、前の片付けは新しい ref・run に触らない（R11） | 秒だけの名前だと新しい ref を消して赤 |
| C12 | ref の削除で lease が外れる（他の SHA） | 消さない、警告 | — |
| C13 | 0 件のまま register-timeout／pending のまま ci-timeout | 124 | — |
| C14 | `--repo` が `DEFAULT_REPO` でなく `--required-checks` が無い | exit 2（R20） | 19 件を待ち続ける |
| C15 | protection 404・rules `[]`・queue null | 報告 `eligibility={protection:absent, rules:absent, queue:absent}`（R19 陰性） | — |
| C16 | rules の読み取りが 403 | 報告 `rules:unknown`、PR1 は続ける（R19。PR1b では拒否） | 403 を absent にすると赤 |
| C17 | origin の URL が `--repo` と違う | exit 2（R20） | — |

### T-W ワークフロー

| # | 読むもの | 期待 |
|---|---|---|
| W1 | `on.push.branches` | `train/**` を含む（直す前は赤） |
| W2 | `on.pull_request.branches` | `[main, develop]` のまま |
| W3 | `concurrency.cancel-in-progress` | `github.event_name == 'pull_request'` のまま |
| W4 | `LAST_REQUIRED_CHECKS` と全ジョブ | 既存の `merge-pr.test.ts` が緑のまま |

### T-A 引数（it.each）

| 引数 | 期待 |
|---|---|
| `--queue` 無し | exit 2 |
| `--merge`・`--close <N>`・`--push-base`（PR1 で書込みを求めるもの） | exit 2 `not supported until PR1b` |
| `--max-prs 0`／`21` | exit 2（1〜20） |
| `--base` が `train/` で始まる | exit 2 |

### PR1b の試験（PR1 では書かない）

R04（最後の読み取りと受理の間に外部の書き手が base を進める）・R05（選定後に PR の宛先を変える）・R06（途中で止まる）・R07（受理の直後に死ぬ／fetch・記録の失敗）・R08（応答が落ち、確かめも失敗／別の base・別のコミットで MERGED）・R09（親だけ死に子の gh が生きている）・R10（ロックの記録の更新が `false`・権限不足・token が変わる）は、§12 の方式が決まってからその方式に合わせて書く。PR2 の R22（単調でない列）は §5。

## 11. PR の切り方

| PR | 中身 | 危険の境目 |
|---|---|---|
| **PR1**（この run） | train の作成・確認・報告。base へは書かない | 使い捨ての ref への push と CI の再実行・取消だけ |
| PR1b | マージの段（§12 の方式）、write-intent・receipt・tree の照合、merge-pr の未解決の読み手の分岐、適格性による拒否 | base への不可逆な書込み。§12 の人の判断の後 |
| PR2 | 赤のときの探索（§5）、候補の自動の選び方と並べ方（古い順、UI の PR は後ろ。`flow.yaml` の `train` 節を #4367 の読み手 `scripts/flow/config.mjs` へ足す） | 赤のとき PR を外す判断が機械に移る |
| PR3 | 計測への記録（#4367 の書き手へ `kind: train` を足す。語彙はこのとき呼び手と一緒に決める＝X2）と、#4370 の枠（P0 はホストでの組み合わせ確認だけ＝X10） | #4367・#4370 の PR1 の後 |
| PR4 | 製品（`src/lib/flow/train/**`、CLI `commandmate train`、API、画面に列と train）、任意で merge queue の経路 | 製品の画面と API（API と呼び手を同じ PR） |

### 11.1 PR1 の範囲（実装の契約）

変更するファイル:

| ファイル | 変更 |
|---|---|
| `scripts/orchestrate/merge-train.mjs`（新規） | §2〜§4・§7。export: `parseArgs`・`trainId`・`classifyEntries`・`buildTrain`・`depsState`・`precheckArgs`・`bucketOf`・`collectCiEvidence`・`judgeTrain`・`readEligibility`・`main`・`runOuter` |
| `scripts/orchestrate/run-log.mjs` | `LOG_STAGES` に `'train'`（`queue` と同じく HEAD を持たず進捗に数えない）。`status` に `train:` の最新の行 |
| `.github/workflows/ci-pr.yml` | `on.push.branches` に `'train/**'` |
| `tests/unit/scripts/orchestrate/merge-train-4369.test.ts`（新規） | §10 の T-E・T-C・T-B・T-A と T-P の P8 |
| `tests/unit/scripts/orchestrate/merge-train-git-4369.test.ts`（新規） | §10 の T-T・T-P（P1〜P7・P9） |
| `tests/unit/scripts/orchestrate/ci-pr-train-trigger-4369.test.ts`（新規） | §10 の T-W |
| `tests/unit/scripts/orchestrate/` の run-log の試験 | `train` の行が進捗に混ざらないこと（E10）を足す。既存の `it` は消さない |
| `docs/orchestrate/ci-merge.md` | 節「6-2 merge train の作成と報告（merge-train.mjs）」: 使い方・exit・報告の読み方・緑の train の後は merge-pr でマージすること。#4370 PR1 も同じ文書に別の節を足すので、後に入る方が develop を取り込んで足す（X5） |
| `docs/design/merge-train-4369.md` | 状態を「PR1 実装済み」に、実装で実コードに合わせた点を追記 |
| `changelog.d/4369.md` | 既存の 1 項目へ統合 |

`merge-pr.mjs`・`precheck.mjs`・`pr-common.mjs`・`machine-lock-sync.mjs` は変えない。

usage:

```bash
node scripts/orchestrate/merge-train.mjs --run-dir <dir> --issues <range> --queue <issue[/item][@pr],...>
     [--base develop] [--repo Kewton/CommandMate] [--required-checks <name,...>] [--workflow ci-pr.yml]
     [--source <worktree>] [--max-prs 5] [--ci-timeout 3600] [--register-timeout 600] [--poll 30]
     [--lock-timeout 14400] [--rebuild-max 5] [--no-keep-ref] [--json]
```

報告（`<run-dir>/train/<ID>.json`、`--json` で標準出力にも）: `{ id, repo, base, B0, ref, verdict: green|red|empty|stale|stopped, exit, adopted: [{ issue, item, pr, h, T, tree }], dropped: [{ entry, pr, reason }], unresolved, ci: { workflow, event, runId, attempt, summary, failed, statuses }, eligibility: { protection, rules, strict, queue }, deps, precheck, rebuilds }`。

受入基準:

1. 3〜5 本の適格な PR から train を作り、CI 1 回の結果を `verdict=green` と各 `T_k` の tree で報告する。`tree(T_N)` は本物の git で 3〜5 本を順に `git merge --squash` した tree と一致する（T-T T1・T3・T6・T11、T-C C1）
2. 扱えない形（merge-base が 0 個・複数、`merge=` の属性、gitlink）を外すか拒否する（T-T T7〜T10）
3. 不適格な候補は理由つきで外して続け、使い方の誤り・読み取りの失敗は全体を止める（T-E）
4. 組み合わせの確認は全候補の条件の和で行い、テストの削除の許可は移さず、依存の不一致・不明は push の前に拒否する（T-P）
5. CI の緑は manifest の run の最新の attempt・全ページ・status context で判定し、判定の後に base が動いたら古い train を緑にしない（T-C）
6. base・PR・Issue に書かない。`gh pr merge`・`gh issue close`・base への push を 1 回も呼ばない（全試験の呼び出しの記録で確かめる）。書込みを求める引数は exit 2（T-A）
7. `ci-pr.yml` の push に `train/**` があり、既存の `merge-pr.test.ts` が緑のまま（T-W）

gates: `work-evidence`・`scope`・`env-clean`・`npm run lint`・`npx tsc --noEmit`・`unit`（`tests/unit/scripts/orchestrate`・`tests/unit/guards`・`tests/unit/docs` を名指し）。本物の GitHub での実行は PR1 の範囲外（人の判断 Q1）。

規模の見込み: `merge-train.mjs` 約 700 行、試験 3 本で約 900 行、他 4 ファイルは数十行。10 ファイル。

## 12. PR1b の前提（人の判断）

PR1b（マージの段）を始める前に、次を人が決める。決める人: 人（PM 経由。リーダーが選択肢と推奨をまとめて返す）。

### 12.1 F01 — GitHub は期待する base を固定できない

`gh pr merge --match-head-commit` が固定するのは PR の head だけ。最後に base を読んでから GitHub が受理するまでの間に、ロックに従わない書き手（人の画面でのマージ、別のマシン、別の CLI）が base を進めると、検証していない tree が公開される。事後の tree の確認は「次を送らない」だけで、その 1 本は防げない（既存の merge-pr にも同じ窓があるが、それは train の保証の根拠にならない）。

| 案 | 中身 | 塞げるもの | 残るもの |
|---|---|---|---|
| A 運用の規則 | develop へ書くのは merge-pr と train だけ（人も画面でマージしない）と決め、事後の tree の確認で検出して止める | ロックに従う書き手どうし | 規則に従わない書き手の窓（検出は事後） |
| B サーバーの規則 | ruleset で base への書込みを特定の主体に限る | 主体が違う書き手 | 個人の持ち物で、人とエージェントが同じアカウントを使うので区別できない（見立て） |
| C fast-forward の push で公開 | `gh pr merge` を使わず、`git push origin T_j:refs/heads/<base>`（強制なし）で公開する。base が `B0` でなければサーバーが non-fast-forward として拒否する（比較して交換） | すべての書き手（サーバーが原子的に比べる） | 履歴の形と PR の状態の付け方（12.3） |

### 12.2 F02 — 途中で止まったときの未検証の接頭辞

1 本ずつ squash する方式で k 本目まで送って止まると（head の移動・拒否・通信断・死亡）、`B_k` は CI を通っていない（`T_N` が緑でも `T_k` が赤のことがある）。

| 案 | 中身 | 代償 |
|---|---|---|
| a 各接頭辞も検証 | `T_1..T_N` のすべてを CI に通す | CI が N 回になり、train の意味が無い |
| b 公開の単位をまとめる | 検証した `T_j` を 1 回で公開する（案 C と組む） | 案 C と同じ |
| c 弱めを承認 | 未検証の接頭辞が残りうることを認め、復旧の責任者（PM）と許容時間（例: 次の develop の push run の完了まで）を決める | 人の承認と、壊れた develop の間の作業の止まり |

### 12.3 推奨: C＋b（fast-forward の push で一度に公開）

- 理由: F01 と F02 を同時に、サーバー側の原子的な比較で閉じる唯一の案。base の tree は CI を通した `tree(T_j)` そのものになり、GitHub の squash の tree が手元の再現と一致するか（見立て V1）に依らない。develop は保護されていないので直接の push が通る（main へは使わない）
- 決めることの副案（人の判断）:
  - **C1 2 親**: `T_k` を「tree は squash の再現、親は `T_{k-1}` と `h_k`」のコミットにする。`h_k` が base から辿れるので GitHub が PR を自動で `MERGED` にする（見立て。使い捨ての検証先で確かめる）。既存の読み手（merge-pr の「マージ済みは記録と close だけ」、`cancel-pr-runs-on-close.yml`、リリースノートの PR の拾い方）がそのまま働く。代償: develop の履歴に PR のコミットが入り、squash の 1 PR 1 コミットではなくなる
  - **C2 単一親**: 今の鎖のまま公開し、PR は「`T_k` でマージした」とコメントして閉じる。履歴は squash の形を保つ。代償: PR は `MERGED` ではなく `CLOSED` になり、`MERGED` を見る既存の読み手（merge-pr `:490-498`・`prsOfBranch`）に分岐が要る
  - リーダーの推奨は C1（既存の読み手を変えずに済み、PR の状態が正しく残る）。最終の判断は人
- 案 A＋c を選ぶ場合は、弱めの承認（未検証の base が残りうる時間と復旧の責任者）を決定として記録してから PR1b に入る

### 12.4 PR1b に入る条件（方式によらない）

1. **V1 の確認（案 C を採らない場合）**: 使い捨ての検証先のリポジトリで T-T の各形を実際に squash させ、tree が一致することを確かめる（人の操作: 検証先のリポジトリの用意）
2. **F07 死んだ train の未確認の書込みの回復**: 外への要求の前に write-intent（train ID・PR・`h_k`・期待する base・予測の tree）を永続化し、ロックの記録の更新の成功（`setOwnerFields` が `true`）を確かめてから送る。「要求の成功」「tree の照合済み」「記録済み」を別の状態にする。merge-pr が train 由来の未解決の PR を「マージ済みなので記録と close だけ」で解消しないよう、merge-pr の未解決の読み手に分岐（train の manifest と実際の base の tree を照合できるまで保持し、専用の回復へ返す）を同じ PR に入れる
3. **F08 マージ前の適格性**: legacy の保護・有効なルール（`rules/branches/<base>`、組織の継承を含む）・queue を読み、strict（ruleset を含む）・queue・`unknown` のどれかなら最初の書込みの前に exit 2
4. **F01 の宛先**: 書く直前に PR の `baseRefName`・`headRefOid`・head の repo を読み直す（R05）
5. `merge=ok` は PR の `h_k` と issue/item に結び、train の head や公開のコミットで代用しない

### 12.5 PR1b でも変えないこと

- train は Issue を閉じない（記録だけ。閉じるのは既存の経路）
- merge のロックを取り、merge-pr と直列にする

## 13. 他の子への約束

| 相手 | 提供／利用 | 形と単位 |
|---|---|---|
| #4367（計測） | 提供: train の出来事 | 語彙の案は `created`・`pushed`・`ci`・`merged`・`dropped`・`rebuilt`・`stopped`。確定は PR3 で、#4367 の書き手へ `kind: train` を足すときに呼び手と一緒に決める（X2）。PR1・PR1b・PR2 は run の記録の `train` 行と報告の JSON だけで、flow の記録の API を先に足さない |
| #4367（計測） | 利用: `flow.yaml` の読み手 | `scripts/flow/config.mjs`（X1）の `base`・`exclude`。`train` 節は PR2 が同じ読み手へ足す。PR1 は引数と既定値だけ（X6） |
| #4368（WIP） | 利用しない | |
| #4370（資源） | 利用: 枠 | P0 はホストでの組み合わせ確認（§2.4 の tsc＋影響テスト）の区間だけ。CI の待ちには握らない（X10）。接続は PR3。PR1 は既存の `cpu.heavy` の規則のまま |
| #4370（資源） | 提供: 負荷の予定 | train の CI は 1 回で self-hosted のジョブ約 16 本。train は base ごとに 1 本（I8） |
| `docs/orchestrate/ci-merge.md` | 共有 | #4369 PR1 と #4370 PR1 が別の節を足す。後に入る方が develop を取り込んで足す（X5） |
| PM・リーダー（運用） | 提供: 使い方 | PR1: `merge-train --queue <entries>` で緑を確かめ、マージは `merge-pr --queue <同じ entries>` |

## 14. 人の判断（未決。推奨つき）

| # | 決めること | 推奨 | 決める人 |
|---|---|---|---|
| Q1 | PR1 の実機の試し方 | 開いている PR が 3 本以上たまったときに 1 回動かし、報告（tree・CI の証拠・適格性）を見る。マージは従来の merge-pr | PM |
| Q2 | train が Issue を閉じるか | 閉じない | 人（Issue 仕様どおり） |
| Q3 | develop の途中の push run を取り消すか | 取り消さない（案 C＋b なら途中の push は存在しない） | 人 |
| Q4 | 候補の条件 C6（PR 自身の CI が全緑）を外すか | 外さない | PM |
| Q5 | GitHub の merge queue を試すか | このリポジトリでは試さない | 人 |
| Q6 | strict のある base | PR1 は報告だけ、PR1b は拒否 | 人 |
| Q7 | ランナーの台数・Docker | 変えない（#4370 の範囲） | 人 |
| Q8 | F01 の方式（§12.1） | C（fast-forward の push） | 人 |
| Q9 | F02 の方式（§12.2） | b（公開の単位をまとめる） | 人 |
| Q10 | 案 C の PR の状態の付け方（§12.3） | C1（2 親、GitHub に `MERGED` を付けさせる） | 人 |

GitHub の設定・launchd・Docker・ランナーの変更はどれも要らない（`ci-pr.yml` の変更は PR で入る）。案 C の検証先のリポジトリの用意は人の操作。

## 15. 事実と見立ての区別

事実（読んだもの）:

- §1 の表の file:line（`origin/develop` a334a013f の `git show`）
- §1 の GitHub の設定（`gh api` の読み取り、2026-11-14。第 2 版では再取得していない）
- push の run は push したコミットの中のワークフローの定義で起動する（GitHub Actions の仕様）
- `git merge-tree --merge-base` は 1 個しか受け付けず、merge-base が複数の履歴では通常の merge と結果が違い得る（git の公式の説明、事前レビューの引用）
- `gh` 2.86.0 の `pr merge` は head の一致だけを渡す。queue の対象では通常の要求が queue／auto の経路になる。`pr checks` は check-run と status context の両方を読む（事前レビューの引用。PR1 の実装の最初に原典で確かめる）

見立て（未確認）:

- **V1** GitHub の squash の tree は手元の再現（`merge-tree --merge-base`）と一致する。PR1 は依らない。PR1b で案 C を採れば不要、採らなければ §12.4 の 1 で確かめる
- **V2** 個人の持ち物のリポジトリでは merge queue を設定できない
- **V3** `bucketOf` の対応が gh 2.86.0 と同じ（§10 T-B）
- **V4** train の run の所要は PR の run と同程度（中央値 22 分、最長 78 分）
- **V5** `precheck.mjs main` を train 専用の run-dir と先頭の候補の Issue 番号で呼んで、各 Issue の記録を汚さずに動く。動かなければ PR1 で precheck の段の実行部の切り出しが要り、scope が広がる（そのときはリーダーへ返す）
- **V6** `node_modules` の symlink で train の worktree の tsc・vitest が動く（lockfile が同じとき）
- **V7** 2 親の `T_k`（§12.3 C1）を base へ push すると、GitHub が PR を自動で `MERGED` にする
- **V8** ruleset で人とエージェントの書込みを区別できない（同じアカウント）

## 改訂の履歴

- 2026-11-14 第 2 版: 事前レビュー（P1 2・P2 7）と再指示 1 を反映。PR1 を作成・確認・報告に狭めて base への書込みを PR1b へ移し、F01・F02 の選択肢と推奨（§12）、F03 の形の制限、F04 の条件の和、F05 の依存の拒否、F06 の train ID と CI の証拠、F07・F08 の PR1b の条件、F09 の PR2 の規則、R01〜R24 の試験の表への割り当てを足した
