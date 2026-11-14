# merge train — 複数の PR を 1 回の CI で確かめてマージする（Issue #4369）

- 状態: **PR1 実装済み**（`scripts/orchestrate/merge-train.mjs`）。第 4 版（第 3 版に、事前レビュー 3 回目の処分 K1・P3-1〜P3-3 と、実装で実コードに合わせた点を反映。改訂の履歴は末尾）
- 正本: Issue #4369 の本文と Epic #4371 の本文（背景の実測）。共通の枠（`s3-common-frame.md`）と突き合わせの決定（`s3-crosscheck.md` X1〜X10）に従う
- この run で実装するのは **PR1（公開の権限の無い診断。train の作成・確認・報告だけで、base へは書かない）** まで。マージの段は PR1b で、§12 の前提（人の判断）が決まってから。Issue の受入条件 1・3（N 本を CI 1 回でマージ・base が動いたら古い train でマージしない）は PR1b、受入条件 2（二分探索）は PR2 で満たす

## 最上位の不変条件（検証した対象と、その結果を使ってよい操作を、消費先まで固定する）

再レビューで、同じ種類の指摘が 2 回目になった（F06→N1、F02→N2）。原因調査（イネーブラー）の見立ては、どちらも「検証した対象」と「その結果を使ってよい操作」を消費先まで固定せず、「tree が同じ」「train が緑」という短い言い方に縮めたこと。そこで次の 3 文を、この設計のほかのすべての条件より上に置く。下の節の条件がこれと食い違うときは、こちらを正とする。

1. **U1** CI の証拠は、repo・base・`B0`・候補とその順序・検証したコミットの SHA・検証の方針（必須チェックの一覧）・workflow・event・ref・run・attempt に結び付ける。tree が一致するだけで、別の SHA・別の接頭辞・別の操作へ転用しない
2. **U2** PR1 の報告は常に `publishable: false` とする。外への操作は自分の train の ref と run に限り、その緑を merge-pr の確認・引数・公開の方法を変える根拠にしない
3. **U3** PR1b は、公開する前に確定した SHA そのものの所定の CI を検証する。base を更新してよいのは、検証済みの公開の単位と期待する base（`B0` との完全一致）を公開の境目で照合できる場合だけ。途中で止まった未検証の接頭辞や結果の分からないものを、確認済みに昇格させない

これを閉じる単位は「作成 → 確認 → 報告 → 消費者 → 公開／拒否 → 回復」の連鎖全体。PR1 は U2 を強制する（§3 I12・§10 T-R・§11.1 受入基準 8）。PR1b は実際の呼び手と一緒に U3 を実装する（§12）。U1 は両方にかかる。

## 0. 結論

1. **train は「GitHub の squash を手元で再現した、単一親のコミットの鎖」として作る。** `git merge-tree --write-tree --merge-base=<mb(B0, h_k)> T_{k-1} h_k` で各 PR の squash 後の tree を順に作り、`git commit-tree -p T_{k-1}` で積む。merge-base がちょうど 1 個の形だけを扱い、0 個・複数・再現できない属性は拒否する（§2.2）
2. **PR1 は「作成・確認・報告」まで。base には一切書かない。** 候補の選定 → train の作成 → 手元の組み合わせ確認 → train の ref の push → CI の待ちと判定 → 報告（どの PR を入れた train が緑／赤か、各 `T_k` の tree、CI の証拠、対象リポジトリの適格性）。`gh pr merge`・Issue の close・base への push は PR1 に入れず、引数でも拒否する（§11）
3. **PR1 は公開の権限の無い診断。** 報告（人向けの文と JSON）には必ず `publishable: false` と「この結果は、マージの根拠にも、merge-pr の確認（`--last` を含む）を省く根拠にもならない」を出す。train の ref を base へ入れる操作（push・merge・fast-forward・その ref からの PR の作成）は、引数でも経路でも拒否する。マージは train が無いときと**同じ引数・同じ方法**で `merge-pr.mjs` を回す（`--queue` の最後の entry は今までどおり自動で `last` になる。`merge-pr.mjs:1089-1103`。既存の振る舞いに例外は足さない）。PR1 だけではマージの時間は縮まない。縮むのは PR1b から
4. **マージの段（PR1b）は、F01（GitHub は期待する base を固定できない）と F02（途中で止まったときの未検証の接頭辞）の保証の方針を人が決めてから。** Q8・Q9・Q10 は PR1b を始める前に人が決める（PR1 の実装の前提ではない）。推奨は「公開するコミットを先に作り、その SHA の CI を検証してから、期待する base（`B0`）との完全一致を条件に一度に公開する」案（§12.3）。普通の fast-forward の push は「今の base が公開するコミットの祖先であること」しか確かめず、`B0` との一致は保証しないので、期待値つきの更新（lease）が要る
5. **ci-pr.yml の `push: branches` に `train/**` を足すのは PR で足せる**（GitHub の設定は要らない。§8）
6. **GitHub の merge queue はこのリポジトリでは使えない見込み（未確認）。** PR1 は queue・ruleset・strict の有無を読んで報告に出し、読めなければ「不明」と書く。queue へ並べる経路は PR4 の選択肢（§9）

## 1. 今の作り（事実、`origin/develop` a334a013f）

| もの | 場所 | 中身 |
|---|---|---|
| 1 本ずつのマージ | `scripts/orchestrate/merge-pr.mjs:438` `mergeOne` | 1 未マージ → 2 tree が clean → 3 記録（verify/review/findings）と断片 → 4 develop の取り込み（`:532-545`）・衝突の印の走査（`:568-573`）・precheck（`:579-628`、取り込んだ HEAD は `--heavy-to-ci`）・push（`:633-639`）→ 5 CI 待ち（`:642-775`）→ 6 `gh pr merge --squash --match-head-commit`（`:784`）と Issue の close（`:456-466`） |
| 必須チェックの判定 | `merge-pr.mjs:188` `judgeChecks` | `bucket` が `fail`/`cancel` なら fail、`--last` は全チェックが `pass`/`skipping` かつ `LAST_REQUIRED_CHECKS`（`:150-170`、19 件）が登録済み。`--last` が無いと `Unit Tests`・`Build` 以外の `pending` は待たない（`:32-41`） |
| 列の `last` | `merge-pr.mjs:1089-1103` | `--queue` は実行の順で最後の entry に `last: o.last \|\| index === lastIndex` を付ける。CLI の `--last` があれば全 entry。試験 `tests/unit/scripts/orchestrate/merge-pr-queue-4277.test.ts:235-246` |
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
- **train ID**: `<UTC の時刻 YYYYMMDDTHHMMSSmmmZ>-<pid>-<乱数 6 桁の hex>`。再利用しない。ref は `train/<base>/<train ID>`、記録・報告のファイルは `<run-dir>/train/<train ID>.json`
- **train の作業ツリーは `git clone --shared` で、リポジトリの作業ツリーの外**: `<os.tmpdir()>/cm-train-<repo-slug>-<train ID>`（事前レビュー 3 回目 K1）。`git worktree add` は置き場所によらず元のリポジトリの `git worktree list` に載り、CommandMate の同期（`src/lib/git/worktrees.ts`）はそこを読むので、置き場所では直らない。clone は元のリポジトリの `.git/worktrees` に何も足さない（object は alternates で共有）。run-dir（`workspace/orchestration/runs/<日付>`）は作業ツリーの中なので、置くと CommandMate の worktree の読み（`src/lib/git/worktrees.ts:130-139` は detached の worktree も拾う）が本番の DB と画面に一時の worktree を出しうる。また `vitest.config.ts` に `include` が無く、作業ツリーの直下の vitest が入れ子の `tests/**` を拾う（再レビュー P3-2）。消えた worktree の行をサーバーの同期が DB から消すかは未確認（V10）
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

rename・mode の変更・binary は扱う（ローカルの `git merge --squash` との一致を試験で固定する。§10 T-T）。手元の merge-tree の結果は `text`・`eol` の属性（`merge.renormalize`）、`.git/info/attributes`、利用者の `core.attributesFile` でも変わる。PR1 の報告には、train を作った手元の git の設定（`merge.renormalize`・`core.attributesFile` の有無）を出す。base の tree が `T_N` 系のコミットそのものになる公開の方式（§12.3）なら影響は無く、GitHub の squash に頼る方式ではこれらも V1 の確認の条件に入れる。**GitHub の squash との一致（見立て V1）は PR1 では確かめない**（PR1 はマージしない）。確かめ方は PR1b の前提（§12.4）: 使い捨ての検証先のリポジトリで、扱う形（T-T の各行）を実際に squash させて tree を比べてから、実 PR に使う。§12.3 の推奨案を採れば、base の tree は GitHub の squash ではなく train の tree そのものになり、V1 は要らなくなる。

### 2.3 entry の解決と候補の条件

entry は `merge-pr.mjs --queue` と同じ形 `<issue>[/<item>][@<pr>]`。`resolveEntries` は 1 件の問題で全体を返さない（`:991-1007`）ので、train は `parseQueue`・`parseWorktreeList` を再利用して**自分で 1 件ずつ分類する**（merge-pr の動きは変えない）。

| 分類 | 例 | 扱い |
|---|---|---|
| 使い方の誤り（全体を止める） | entry の書式違い、同じ PR を 2 回、`OPEN` の PR の worktree が 0 個か 2 個以上、PR を引けない（`pr` の記録が無い・`gh pr view` が見つからないと答える） | exit 2、何も作らない |
| 読み取りの失敗（全体を止める） | `gh` の再試行の後も失敗 | exit 1。「不適格」と同じにしない |
| 外す（理由を残して続ける） | C1〜C9 のどれかが外れる | `dropped` に `{ entry, pr, reason }` |

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
| C9 | 依存のファイル（`package-lock.json`・`package.json`）を変えない | `git diff --name-only mb(B0,h_k) h_k` | F05（§2.4 の 1） |

未解決の記録が**候補に無い** PR を指すときは、PR1 は書込みをしないので止まらず、報告に出す（`unresolved: [...]`）。

### 2.4 組み合わせの確認（手元）

train の作業ツリー（`git clone --shared --no-checkout <repo> <os.tmpdir()>/cm-train-<repo-slug>-<ID>` → `git checkout --detach T_N`、§2.1。`T_N` と `B0` は alternates で見える）で:

1. **依存（F05）**: 候補を鎖に積む前に、`h_k` の差分が `package-lock.json`・`package.json` を変える候補は外す（`dropped reason=deps-changed`。その PR は merge-pr で 1 本ずつ）。1 本のために他の候補の診断まで止めないため（再レビュー P3-5。全体を止める案より、残りの報告が得られる）。そのうえで `package-lock.json` の blob が `T_N`・`B0`・`--source <worktree>`（既定は先頭の候補の worktree）の HEAD で同じで、`<source>/node_modules` が在るときだけ、train の worktree に `node_modules` → `<source>/node_modules` の symlink を作る（source の worktree には何も書かない）。source の側が違う・不明（読めない・source の tree が dirty・`node_modules` が無い）なら **push の前に exit 2**（`deps=unknown`。全候補に共通の環境の問題なので全体を止める）。CI への委譲は採らない（tsc・ESLint・guards は heavy でないので `--heavy-to-ci` では外れず、委譲には precheck の変更が要る）
2. 衝突の印の全追跡ファイル走査（`markerFiles`）
3. `precheck.mjs main` を train 専用の記録の置き場で呼ぶ: `--run-dir <run-dir>/train --issues <run の range> --issue <先頭の候補の Issue> --worktree <train の worktree> --base <B0 の SHA> --heavy-to-ci`、加えて**全候補の条件の和**（F04）:
   - どれかが `kind=refactor` なら `--kind refactor`、どれかが `metrics` なら `--metrics`（suppressions を train の差分全体で数える）
   - どれかが `build` なら `--build`
   - `--allow-removed-tests` は**付けない**（C5 で削除を許された PR は入っていない。train の差分にテストの削除があれば removed-tests の段が落ちて止まる＝集約の削除は拒否）
4. 重い段（広い related / tests）は `--heavy-to-ci` で CI に任せる（merge-pr の取り込み後と同じ。docs/orchestrate/ci-merge.md「6-2 取り込み後の重い段」、#4265）。軽い段が落ちたら push しない

ホストでのこの確認（tsc＋影響テスト）が、#4370 の枠の P0 に当たる唯一の区間（X10。CI の待ちには枠を握らない）。PR1 は #4370 の枠に依存せず、precheck の中の `cpu.heavy` の規則のまま。

## 3. 不変条件（PR1）

最上位の U1〜U3 の下に置く。

1. **I1** PR1 は base・PR の head・Issue・PR の状態のどれにも書かない。PR を作らない。外へ書くのは `train/<base>/<自分の ID>` の ref の作成・削除（lease つき）と、`pruneOwnRefs` が報告から選んだ古い ID の lease つきの削除（I13）と、manifest の run の再実行・取消だけ。それ以外（base・他人の ID の作成・lease の無い削除）は 0（事前レビュー 3 回目 P3-1）。成功・失敗・再実行・取消・片付け・作り直しのどの経路でも、判定の後の代わりの経路（fallback）で別の公開の口を呼ばない
2. **I2** train の tree は §2.2 の G1〜G4 を満たす候補だけから作る。満たさない候補は理由つきで外し、黙って外さない
3. **I3** 組み合わせの確認の条件は全候補の条件の和で、テストの削除の許可は train へ移さない
4. **I4** 依存が `B0`・`T_N`・source で一致しないか確かめられないとき、train を push しない
5. **I5** CI の緑は、manifest の `ref`・`T_N` に結び付いた 1 つの run（workflow `ci-pr.yml`・event `push`・`head_sha = T_N`・`head_branch = ref`）の**最新の attempt** の全ジョブ（全ページ）と、`T_N` の他のチェック・status context をすべて読み、`judgeChecks(…, { last: true, required })` が `ok` で、status context に `error`/`failure`/`pending` が無いときだけ。「manifest の run のもの」と「他のチェック」は、`commits/<T_N>/check-runs?filter=latest` の各 check-run の `check_suite.id` が manifest の run の `check_suite_id` と一致するかで分ける（名前や `details_url` では分けない。`filter=latest` で再実行の前の古い失敗を混ぜない）。再実行の後の `attempts/<n>/jobs` が成功を引き継いだジョブを含むかは未確認（V9）なので、PR1 の実装の最初に実際の API で確かめるまで、**再実行の後の緑は出さない**（再実行の後に緑になったら `verdict=green-after-rerun-unverified`、exit 1。確かめた後に `green` へ。代わりの読み方は check-runs の `filter=latest`＋`check_suite_id`）
6. **I6** 緑の判定は、それを読んだ**後**の fetch で base が `B0` のままであるときだけ有効（merge-pr `:695-704` と同じ順）。動いていたら「緑」にせず `stale` と報告する。作り直しは既定で 0 回（`--rebuild-max 0`、上限 1）。PR1 の運用では merge-pr のマージのたびに base が動くので、作り直すと全体の CI が余分に走るため（再レビュー P3-6）
7. **I7** 再実行・取消は manifest の run id にだけ、ref の削除は `--force-with-lease=refs/heads/<ref>:<T_N>` 付きでだけ行う。片付けは train のロックを持っている間に行う
8. **I8** train は base ごとに 1 本（train のロック `train.<owner>.<repo>.<base>`、置き場は `<lock root>/train/`。merge-train だけが読み書きする）。merge のロックは取らない（base へ書かないので merge-pr を止めない）
9. **I9** `merge=ok` などの各 Issue の進捗の記録を書かない。書くのは `train` の行（`TRAIN_LOG_STAGES`。`LOG_STAGES` と同じく HEAD を持たず進捗に数えない）と `<run-dir>/train/<ID>.json` の報告だけ
10. **I10** 対象リポジトリに固有の値（base・repo・必須チェックの一覧・workflow のファイル名）はコードに埋め込まない。必須チェックの既定は `repo == DEFAULT_REPO` のときだけ `LAST_REQUIRED_CHECKS`、それ以外は `--required-checks` が無ければ exit 2
11. **I11** 報告は採用・外した・CI の結果を集合として残す。exit 0 は「この train の `T_N` の 1 回の CI が緑」であって、外した entry を含む全 entry の完了でも、`T_1..T_{N-1}` の CI の合格でもない
12. **I12（U2）** 報告（人向けの文・`--json` の標準出力・保存する JSON）は、`verdict` が green・red・empty・stale・stopped・timeout のどれでも、作り直しや再実行の後でも、`publishable: false` と次の注意の文を持つ: 「この結果は、`B0` の上の `T_N` の tree の 1 回の CI の結果だけを意味する。マージの根拠にも、merge-pr の確認（取り込み・precheck・必須の CI・`--last`）を省いたり引数を変えたりする根拠にもならない。train の ref を base へ入れたり、その ref から PR を作ったりしない」。報告を作れない初期のエラーでも、base・PR・Issue への書込みは 0。古い報告に `publishable` が無くても、読み手はそれを公開の許可へ読み替えない（既定は false）
13. **I13** 残した ref の保持: green／red の ref は報告から人が見られるように残すが、次の train の作成のときに、同じ base の自分の名前空間（`train/<base>/`）の ref のうち新しい順で 3 本を超えるものを、報告に記録した SHA との lease 付きで消す（`--keep-refs 3`、0 で全部消す）。SHA が違う ref・報告の無い ref には触らず、報告に出す。残る ref の数は報告の `refs.remaining` に出し、消せなかったもの（前の日の run-dir の ref など）は人が消す運用を `ci-merge.md` に書く（事前レビュー 3 回目 P3-2）。残した ref は公開の許可ではない（I12）

## 4. 状態と遷移（PR1）

| 状態 | 出来事 | 次の状態 | 副作用 |
|---|---|---|---|
| `start` | 引数が不正（`--merge`・`--close <N>`・`--push-base`・`--fast-forward`・`--create-pr`・`--publishable` など、公開や書込みを求める引数を含む）・git < 2.40・再現できない属性・必須チェックの一覧が決まらない | `stopped(2)` | 何も書かない。報告を出せれば `publishable: false` |
| `start` | train のロックを取れた | `locked` | ロックの記録 `phase=select train=<ID>`（`setOwnerFields` が `false` なら `stopped(1)`） |
| `start` | `--lock-timeout` まで取れない | `stopped(124)` | `train` 行 `state=lock-timeout` |
| `locked` | entry の解決で使い方の誤り／読み取りの失敗 | `stopped(2)`／`stopped(1)` | |
| `locked` | 適格性を読む（§7 の F08 の行） | `locked` | 報告の `eligibility` に `present/absent/unknown` |
| `locked` | 候補を判定（C1〜C9） | `building` | 外した PR を `dropped` に |
| `locked` | 残りが 0 本 | `done(0)` | `train` 行 `state=empty`、push しない |
| `building` | `B0` を読み、`T_1..T_N` を作り、manifest を書く | `checking` | train の worktree を作る |
| `checking` | source の依存が不一致・不明（候補の依存の変更は C9 で外し済み） | `stopped(2)` | `deps=unknown` |
| `checking` | 印・precheck が ok | `pushed` | ref が remote に無いことを確かめて `pushHead(ref, T_N)`、`train` 行 `state=pushed` |
| `checking` | precheck が exit 3（保留） | `stopped(3)` | |
| `checking` | 印・precheck が失敗 | `stopped(1)` | |
| `pushed` | `--register-timeout` まで manifest に合う run が無い | `stopped(124)` | 「CI が `train/**` で起動しない」と案内 |
| `pushed` | 合う run が 2 本以上 | `stopped(1)` | 取り違えを避ける |
| `pushed` | 判定の後の fetch で base が `B0` から動いた | `rebuild` | `train` 行 `state=base-moved`、自分の run を取消、自分の ref を lease 付きで削除 |
| `pushed` | fetch に失敗 | `pushed`（次の回に読み直す） | 緑にしない |
| `pushed` | `fail` で、この train に再実行が未送信 | `pushed` | run の完走を待って `gh run rerun <id> --failed`（1 回）。以後は attempt+1 だけを読む |
| `pushed` | 再実行の後も `fail` | `done(1)` red | 報告 `verdict=red failed=…`（どの PR が入った train か） |
| `pushed` | 再実行の後に `ok`（V9 が未確認の間） | `done(1)` | 報告 `verdict=green-after-rerun-unverified`（I5） |
| `pushed` | 再実行なしで `ok` | `done(0)` green | 報告 `verdict=green`、検証した SHA `T_N` と CI の証拠（run・attempt・workflow・event・ref）、各 `T_k` の tree（`T_k` は CI を通していないと明記） |
| `pushed` | `--ci-timeout` 超過 | `stopped(124)` | |
| `rebuild` | やり直しが上限（`--rebuild-max`、既定 0・最大 1）未満 | `locked`（新しい train ID で候補から） | |
| `rebuild` | 上限（既定では最初の `base-moved`） | `stopped(4)` | 報告 `verdict=stale` |
| すべての終わり | — | — | train のロックを持ったまま、clone を消し、green／red の ref は I13 のとおり残し、報告を `publishable: false` で書き、それから解放 |

exit code: 0 緑（または 0 本）・1 赤／条件／コマンドの失敗／再実行の後の未確認の緑・2 使い方／不適格・3 precheck の保留・4 base が動いた（作り直しの上限）・124 時間切れ。どの exit でも報告は `publishable: false`。

## 5. 赤のとき（PR2）— 接頭辞の探索（F09）

PR1 は赤なら報告して止まる。PR2 で次を足す:

- **始める条件**: `B0` の SHA に対応する、完了済みで緑の push run があること（「赤でない」ではない。pending・未登録・取消は始めない）
- **探索**: `lo = 0`（`B0`、緑を確認済み）、`hi = N`（赤）で、`T_mid` を `train/<base>/<ID>-p<mid>` に push して CI。見つかるのは**緑と赤の隣接の境目の 1 つ**で、単調でない列（緑・赤・赤・緑・赤）では「最初の原因」「唯一の原因」を意味しない。報告と通知では「原因」と断定せず「境目の PR（`P_hi`）」と書く
- **処置**: 境目の PR を外し、**残り（`P_1..P_{hi-1}` と `P_{hi+1}..P_N`）で新しい train を作って必ず検証し直す**。探索の途中の緑（`T_lo`）を、そのままマージの根拠にしない（PR1b の公開の方式に従い、検証した train だけを公開する）
- **回数の上限**: 外すのは 1 回の実行で 2 本まで。超えたら止めて人へ（揺れや組み合わせの問題の疑い）
- 揺れの判定（赤の場所と PR の差分の重なり）は別の規則（`ci-flaky.ts` の分類の再利用を検討）

## 6. merge-pr.mjs の部品の再利用と、弱めないこと

PR1 は base に書かないので、マージの安全性は既存の merge-pr のまま変わらない。ただしそれが成り立つのは、**merge-pr の引数とマージの方法を train が無いときと同じに保つときだけ**（U2・I12）。単発の呼び出しで要る `--last`、「CI が通れば」の許可の run の全 entry の `--last`、`--queue` の最後の entry の自動の `last`（`merge-pr.mjs:1089-1103`）はどれもそのまま。train の緑を見て `--last` を外す、`--queue` を単発のループに変える、train の CI を PR の CI として渡す、train の ref を base へ入れる・その ref から PR を作る、はどれも U2 に反する。merge-pr 側には例外も新しい引数も足さない。下の表は「train の判定が merge-pr と同じ強さで行われるか」と、PR1b でマージを置き換えるときの対応。

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
| 6 `--match-head-commit`（`:784`） | 該当なし（マージしない） | §12 の方式で、公開する SHA そのものの CI を検証してから公開する（U3） |
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
| `git commit-tree`・`git clone --shared` | `stopped(1)` | clone だけ残る → 終わりの片付けで消す。消せなければ警告 | fail-closed |
| `node_modules` の symlink | `stopped(2)` | — | fail-closed（source には書かない） |
| precheck | 1 → `stopped(1)`、3 → `stopped(3)` | — | fail-closed |
| `git ls-remote origin <ref>`（ref が無いこと） | 読めない・在る → `stopped(1)` | — | fail-closed（他人の ref を上書きしない） |
| push の宛先の検査（I1） | 宛先が `refs/heads/train/<base>/<自分の ID>` でなければ push を呼ばずに `stopped(1)` | — | fail-closed（どの経路でも base・PR の head へ push しない。`pushHead` を呼ぶ前の 1 か所で検査） |
| `git push origin T_N:refs/heads/<ref>`（`pushHead`） | 一時的な 5xx は再試行。拒否 → `stopped(1)` | 応答が落ちた → `ls-remote` で確かめる | fail-closed |
| run の特定 `gh api repos/<repo>/actions/runs?head_sha=<T_N>&event=push&branch=<ref>`（`--paginate`） | 再試行の後も失敗 → `stopped(1)` | ページの途中で失敗 → その回は判定しない | fail-closed |
| ジョブ `…/runs/<id>/attempts/<n>/jobs`（`--paginate`） | 同上 | 古い attempt の結果は混ぜない | fail-closed |
| チェック `…/commits/<T_N>/check-runs?filter=latest`（`--paginate`） | 同上 | `check_suite.id` が manifest の run の `check_suite_id` と違うものを「他のチェック」とし、`fail`→赤、`pending`→待つ | fail-closed |
| status `…/commits/<T_N>/status` | 同上 | `error`/`failure` → 赤、`pending` → 待つ、0 件 → 無視（待たない） | fail-closed |
| `bucketOf` | 知らない値は `pending` | — | fail-closed |
| `gh run rerun <id> --failed` | `already running` → 完走後にもう一度。他 → `stopped(1)` | 受理は attempt の増加で確かめる（merge-pr と同じ） | fail-closed |
| `gh run cancel <id>`（作り直し） | 警告だけ。次の train の判定は新しい ID の run しか読まないので結果に混ざらない | — | fail-open（無駄な run が残るだけ。報告に `cancel=failed run=<id>`） |
| ref の削除（lease 付き、I7・I13） | 警告だけ | lease が外れた（他の SHA）→ 消さない | fail-open（自分の SHA でなければ触らない） |
| 報告の書込み（I12） | 書けない → `stopped(1)`、標準エラーに `publishable: false` と注意の文 | — | fail-closed（報告が無いことを公開の許可に読み替えない） |
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
| T12（K1） | 実行の前・precheck の最中・後で、元のリポジトリの `git worktree list --porcelain` | 変わらない。train の作業ツリーは `os.tmpdir()` の下の clone（alternates あり）で、終わりに消える | `git worktree add` にすると行が増えて赤 |

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
| C5 | attempt 1 が赤、attempt 2 が進行中、その後緑 | attempt 2 だけを読む。再実行は 1 回だけ送る。V9 を確かめるまでは `green-after-rerun-unverified`・exit 1（R14） | 古い attempt を混ぜると赤のまま／未確認のまま green にする変異で赤 |
| C5b | `filter=latest` の check-runs に、再実行の前の失敗の check-run と再実行の後の成功が同じ名前で並ぶ | 後者だけを読む。`check_suite_id` で manifest の run と他を分ける | `filter=latest` か `check_suite_id` を外すと赤 |
| C6 | ジョブの一覧の 2 ページ目の取得に失敗 | その回は判定しない | — |
| C7 | manifest に合う run が 2 本 | exit 1 | — |
| C8 | 再実行の後も赤 | exit 1、報告に入れた PR と落ちたジョブ | — |
| C9 | 判定の後の fetch で base が動いた | 既定（`--rebuild-max 0`）では `verdict=stale`・exit 4、自分の run を取消。`--rebuild-max 1` なら新しい ID で 1 回作り直す（R21） | 判定の後に読まないと古い train を緑と報告 |
| C10 | 作り直しの後に、古い train の run が遅れて緑 | 新しい train の判定に混ざらない（R21） | — |
| C11 | 同じ秒に 2 回作り直す／前の片付けが遅れて動く | ID が違い、前の片付けは新しい ref・run に触らない（R11） | 秒だけの名前だと新しい ref を消して赤 |
| C12 | ref の削除で lease が外れる（他の SHA） | 消さない、警告 | — |
| C13 | 0 件のまま register-timeout／pending のまま ci-timeout | 124 | — |
| C14 | `--repo` が `DEFAULT_REPO` でなく `--required-checks` が無い | exit 2（R20） | 19 件を待ち続ける |
| C15 | protection 404・rules `[]`・queue null | 報告 `eligibility={protection:absent, rules:absent, queue:absent}`（R19 陰性） | — |
| C16 | rules の読み取りが 403 | 報告 `rules:unknown`、PR1 は続ける（R19。PR1b では拒否） | 403 を absent にすると赤 |
| C17 | origin の URL が `--repo` と違う | exit 2（R20） | — |

### T-R 公開の権限の無い診断（U2・I12・I1）— 原因調査 §5 の PR1 の行

| # | 入力・状態・変化 | 期待する観測 | 防御を外すと |
|---|---|---|---|
| X1 | verdict が green・red・empty・stale・stopped・timeout・`green-after-rerun-unverified` の各経路、再実行・作り直しの後 | 人向けの文・`--json`・保存する JSON のすべてに `publishable: false` と I12 の注意の文。`green-after-rerun-unverified` の人向けの文は、その前の先頭の行に「赤ではない（再実行の後の緑。未確認）」（exit 1 を赤と読ませない。事前レビュー 3 回目 P3-3）。green の検証の対象は `T_N` だけで、`T_1..T_{N-1}` は「CI を通していない」と出る | green のときだけ true／欠落にする変異で赤 |
| X2 | 正常、取得・CI・記録の失敗、取消・片付けの失敗、書込みを求める引数、報告を作れない初期のエラー | git／gh の呼び出しの記録に、base への push・`gh pr create`・`gh pr merge`・`gh pr close`・`gh issue close` が 0 回。push は「自分の ID の作成と（lease つきの）削除」と「`pruneOwnRefs` が報告から選んだ古い ID の lease つきの削除」だけで、それ以外（base・他人の ID の作成・lease の無い削除）は 0（P3-1）。取消・再実行は manifest の run id だけ | 失敗の後の fallback に base への push を足すと赤 |
| X3 | push の宛先の検査に `refs/heads/develop`・`refs/heads/train/develop/<他の ID>` を渡す（内部の関数を直接） | push を呼ばずに例外 | 検査を外すと base へ push して赤 |
| X4 | train の有無で、merge-pr の呼び方を比べる（merge-train は merge-pr を呼ばない） | merge-train は merge-pr を起動せず、merge-pr が読む run の記録（`ci`・`precheck`・`merge` の段）を書かない。merge-pr の `last` の決まり方は train の有無で変わらない | train の緑を記録の `ci=ok` として書く変異で赤（merge-pr の待ちが変わる） |
| X5 | 既存の queue（陰性の対照） | `merge-pr-queue-4277.test.ts:235-246`（`--last` 無しは最後の entry だけ `last`、有りは全 entry）が変わらず緑。merge-pr.mjs は変更しない | — |
| X6 | 古い green の報告と ref が残っているところで、base・候補・順序が変わる | 新しい実行は古い報告・ref を読まず、自分の manifest と CI で判定する。古い報告から `publishable` を読み替えない | 古い報告の green を再利用する変異で赤 |
| X7 | `docs/orchestrate/ci-merge.md` の merge train の節 | 「`publishable: false`」「緑はマージの根拠にも merge-pr の確認（`--last` を含む）を省く根拠にもならない」「train の ref を base へ入れない・その ref から PR を作らない」「merge-pr は train が無いときと同じ引数」の 4 つの文がある（`tests/unit/docs/ci-merge-train-4369.test.ts`） | 文を消すと赤 |

### T-L train のロック（R09）

| # | 状況 | 期待 |
|---|---|---|
| L1 | 同じ base で 2 つの train | 後の方は待ち、`--lock-timeout` で 124。同時に 2 つの ref を push しない |
| L2 | 親だけ死に、子の `gh`／`git` が生きている | ロックは生きている扱いで回収しない（既存の pgid の規約）。グループが全部死んだ後だけ回収 |
| L3 | `setOwnerFields` が `false` | 次の外への操作をせず `stopped(1)` |
| L4 | 別の base の train | 互いに待たない |
| L5 | merge-pr が merge のロックを持っている | train は待たない（merge のロックを取らない、I8） |

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
| `--merge`・`--close <N>`・`--push-base`・`--fast-forward`・`--create-pr`・`--publishable`（PR1 で公開や書込みを求めるもの） | exit 2 `not supported: PR1 is a diagnosis (publishable: false)`、報告に `publishable: false` |
| `--rebuild-max 2` | exit 2（0〜1） |
| `--keep-refs -1` | exit 2（0 以上） |
| `--max-prs 0`／`21` | exit 2（1〜20） |
| `--base` が `train/` で始まる | exit 2 |

### PR1b の試験（PR1 では書かない）

R04（最後の読み取りと受理の間に外部の書き手が base を進める）・R05（選定後に PR の宛先を変える）・R06（途中で止まる）・R07（受理の直後に死ぬ／fetch・記録の失敗）・R08（応答が落ち、確かめも失敗／別の base・別のコミットで MERGED）・R09 の公開の段の部分（親だけ死に子の gh が生きている）・R10（ロックの記録の更新が `false`・権限不足・token が変わる）は、§12 の方式が決まってからその方式に合わせて書く。加えて、原因調査 §5 の PR1b の行:

| # | 入力・状態・変化 | 期待する観測 | 防御を外すと |
|---|---|---|---|
| Y1（N1） | tree が同じで親だけ違う `T_N` と `U_N`。`T_N` だけ CI が緑 | `U_N` への公開は 0 | tree の一致だけで証拠を採る変異で赤 |
| Y2（N1 陰性） | `U_N` 自身の所定の CI が緑、他の公開の条件も成立 | 公開の引数の SHA は `U_N`。CI の後に commit-tree・amend・メッセージや時刻の作り直しが無い | 常に拒否する実装を落とす |
| Y3（F06 の引継ぎ） | 同じ SHA の別 workflow・event・ref・run、古い attempt、status の pending、ページの欠落 | 別の証拠で緑を作らない（PR1 の T-C C2〜C6 と同じ条件） | SHA だけ／ジョブ名だけで選ぶ変異で赤 |
| Y4（F02・N2） | `T_N` は緑、`T_1` は赤。接頭辞を選ぶ／2 本目の前に落ちる | 公開の境目そのものの証拠を求める、または検証した全体を 1 回で公開するだけ | 全体の緑を接頭辞へ転用する変異で赤 |
| Y5（保持した報告・ref） | 古い green、base・候補・順序・親・メッセージが変わる | 公開の許可へ昇格しない。新しい最終の SHA・manifest・所定の CI で判定し直す | 報告の green を再利用する変異で赤 |
| Y6（公開と回復） | 直前の base の変更、応答の喪失、公開の直後の死亡 | 期待する base と違えば更新 0。結果の分からないものは確認済みにせず、F07 の write-intent・receipt へ | 事後の tree の確認だけで済ませる変異で赤 |
| Y7（§12.3 の前提） | base が `B0` より前の祖先へ巻き戻る／公開する候補の祖先が変わる | 期待値つきの更新（`B0` との完全一致）が拒否し、更新 0 | 普通の fast-forward の push にする変異で、巻き戻りの場合に公開されて赤 |

PR2 の R22（単調でない列）は §5。

## 11. PR の切り方

| PR | 中身 | 危険の境目 |
|---|---|---|
| **PR1**（この run） | 公開の権限の無い診断: train の作成・確認・報告（常に `publishable: false`）。base・PR・Issue へは書かない | 使い捨ての ref への push と、その run の再実行・取消だけ |
| PR1b | マージの段（§12 の方式）。公開するコミットを先に作り、その SHA の CI を検証してから期待する base との完全一致を条件に公開（U3）。write-intent・receipt・tree の照合、merge-pr の未解決の読み手の分岐、適格性による拒否 | base への不可逆な書込み。Q8〜Q10 を人が決めた後 |
| PR2 | 赤のときの探索（§5）、候補の自動の選び方と並べ方（古い順、UI の PR は後ろ。`flow.yaml` の `train` 節を #4367 の読み手 `scripts/flow/config.mjs` へ足す） | 赤のとき PR を外す判断が機械に移る |
| PR3 | 計測への記録（#4367 の書き手へ `kind: train` を足す。語彙はこのとき呼び手と一緒に決める＝X2）と、#4370 の枠（P0 はホストでの組み合わせ確認だけ＝X10） | #4367・#4370 の PR1 の後 |
| PR4 | 製品（`src/lib/flow/train/**`、CLI `commandmate train`、API、画面に列と train）、任意で merge queue の経路 | 製品の画面と API（API と呼び手を同じ PR） |

### 11.1 PR1 の範囲（実装の契約）

変更するファイル:

| ファイル | 変更 |
|---|---|
| `scripts/orchestrate/merge-train.mjs`（新規） | §2〜§4・§7。export: `parseArgs`・`trainId`・`classifyEntries`・`buildTrain`・`depsState`・`precheckArgs`・`assertTrainRef`（push の宛先の検査）・`bucketOf`・`collectCiEvidence`・`judgeTrain`・`readEligibility`・`buildReport`（常に `publishable: false`）・`pruneOwnRefs`・`main`・`runOuter` |
| `scripts/orchestrate/run-log.mjs` | `TRAIN_LOG_STAGES = ['train']` と、読み手が使う `ANY_LOG_STAGES`（`queue` と同じく HEAD を持たず進捗に数えない）。`status` に `train:` の最新の行（`--json` は train の行があるときだけ `train`）。実装で変えた点: `LOG_STAGES` そのものに足すと既存の試験 `run-log-queue-4277.test.ts` の `LOG_STAGES` の期待値と `status --json` のキーの期待値が変わるので、別の一覧にした |
| `.github/workflows/ci-pr.yml` | `on.push.branches` に `'train/**'` |
| `tests/unit/scripts/orchestrate/merge-train-4369.test.ts`（新規） | §10 の T-E・T-C・T-B・T-A・T-R（X1〜X6）・T-L と T-P の P8 |
| `tests/unit/scripts/orchestrate/merge-train-git-4369.test.ts`（新規） | §10 の T-T・T-P（P1〜P7・P9） |
| `tests/unit/scripts/orchestrate/ci-pr-train-trigger-4369.test.ts`（新規） | §10 の T-W |
| `tests/unit/docs/ci-merge-train-4369.test.ts`（新規） | §10 の T-R X7（ci-merge.md の 4 つの文） |
| `tests/unit/scripts/orchestrate/run-log-train-4369.test.ts`（新規） | `train` の行が進捗に混ざらないこと（E10）。既存の run-log の試験は変えない |
| `docs/orchestrate/ci-merge.md` | 節「6-2 merge train の診断（merge-train.mjs）」: 使い方・exit・報告の読み方と、次の 4 つの文（T-R X7 が固定する）: ①報告は常に `publishable: false` ②緑は `B0` の上の `T_N` の 1 回の CI の結果だけで、マージの根拠にも merge-pr の確認（取り込み・precheck・必須の CI・`--last`）を省く根拠にもならない ③train の ref を base へ入れない・その ref から PR を作らない ④マージは train が無いときと同じ引数・同じ方法で merge-pr を回す（`--queue` の最後の entry の自動の `last` もそのまま）。#4370 PR1 も同じ文書に別の節を足すので、後に入る方が develop を取り込んで足す（X5） |
| `docs/design/merge-train-4369.md` | 状態を「PR1 実装済み」に、実装で実コードに合わせた点を追記 |
| `changelog.d/4369.md` | 既存の 1 項目へ統合 |

`merge-pr.mjs`・`precheck.mjs`・`pr-common.mjs`・`machine-lock-sync.mjs` は変えない。

usage:

```bash
node scripts/orchestrate/merge-train.mjs --run-dir <dir> --issues <range> --queue <issue[/item][@pr],...>
     [--base develop] [--repo Kewton/CommandMate] [--required-checks <name,...>] [--workflow ci-pr.yml]
     [--source <worktree>] [--max-prs 5] [--ci-timeout 3600] [--register-timeout 600] [--poll 30]
     [--lock-timeout 14400] [--rebuild-max 0|1] [--keep-refs 3] [--json]
```

報告（`<run-dir>/train/<ID>.json`、`--json` で標準出力にも。人向けの文の先頭にも同じ 2 つ）: `{ publishable: false, notice: "<I12 の注意の文>", id, repo, base, B0, ref, verdict: green|red|empty|stale|stopped|timeout|green-after-rerun-unverified, exit, verified: { sha: T_N, tree, policy: <必須チェックの一覧>, workflow, event, ref, runId, checkSuiteId, attempt }, adopted: [{ issue, item, pr, h, T, tree, ciVerified: false }], dropped: [{ entry, pr, reason }], unresolved, ci: { summary, failed, statuses, others }, eligibility: { protection, rules, strict, queue }, gitConfig: { mergeRenormalize, attributesFile }, deps, precheck, rebuilds, prunedRefs }`。`adopted[].ciVerified` は各 `T_k` について常に false（CI を通したのは `verified.sha` だけ）。

受入基準:

1. 3〜5 本の適格な PR から train を作り、CI 1 回の結果を `verdict=green` と各 `T_k` の tree で報告する。`tree(T_N)` は本物の git で 3〜5 本を順に `git merge --squash` した tree と一致する（T-T T1・T3・T6・T11、T-C C1）
2. 扱えない形（merge-base が 0 個・複数、`merge=` の属性、gitlink）を外すか拒否する（T-T T7〜T10）
3. 不適格な候補は理由つきで外して続け、使い方の誤り・読み取りの失敗は全体を止める（T-E）
4. 組み合わせの確認は全候補の条件の和で行い、テストの削除の許可は移さず、依存の不一致・不明は push の前に拒否する（T-P）
5. CI の緑は manifest の run の最新の attempt・全ページ・status context で判定し、判定の後に base が動いたら古い train を緑にしない（T-C）
6. base・PR・Issue に書かない。`gh pr merge`・`gh issue close`・base への push を 1 回も呼ばない（全試験の呼び出しの記録で確かめる）。書込みを求める引数は exit 2（T-A）
7. `ci-pr.yml` の push に `train/**` があり、既存の `merge-pr.test.ts` が緑のまま（T-W）
8. **公開の権限の無い診断（U2・I12）**: どの verdict・どの exit・作り直しや再実行の後でも、報告（人向けの文・`--json`・保存する JSON）に `publishable: false` と注意の文がある。train の ref を base へ入れる操作（push・merge・fast-forward・PR の作成）は引数でも経路でも拒否され、偽の gh・git の呼び出しの記録に 1 回も現れない。merge-train は merge-pr を呼ばず、merge-pr が読む記録を書かない。`ci-merge.md` に 4 つの文がある（T-R、T-A）
9. 元のリポジトリの `git worktree list` が実行の前後（と precheck の最中）で変わらない。train の作業ツリーは `os.tmpdir()` の下の `git clone --shared` で、終わりに消す（T-T T12。事前レビュー 3 回目 K1）
10. 再実行の後の緑は、V9 を実際の API で確かめるまで `green-after-rerun-unverified`（exit 1）として出す（T-C C5）
11. train のロックで同じ base の train を直列にし、親だけ死んで子が生きている間は回収しない（T-L）

gates: `work-evidence`・`scope`・`env-clean`・`npm run lint`・`npx tsc --noEmit`・`unit`（`tests/unit/scripts/orchestrate`・`tests/unit/guards`・`tests/unit/docs` を名指し。T-R X7 は `tests/unit/docs` に入る）。本物の GitHub での実行は PR1 の範囲外（人の判断 Q1）。

規模の見込み: `merge-train.mjs` 約 800 行、試験 4 本で約 1,100 行、他 4 ファイルは数十行。11 ファイル。

止まる条件（契約へそのまま写す）: V5（precheck を train 専用の run-dir で呼べる）が外れて `precheck.mjs` の変更が要るときは、scope を広げずにリーダーへ返す。V9 は確かめられなくても止まらない（受入基準 10 の形で出す）。

## 12. PR1b の前提（人の判断）

PR1b（マージの段）を始める前に、次を人が決める。決める人: 人（PM 経由。リーダーが選択肢と推奨をまとめて返す）。**Q8・Q9・Q10 は PR1b を始める前に決める。PR1 の実装の前提ではない**（PR1 は公開の権限の無い診断で、その CI の証拠を PR1b の公開へ引き継ぐ約束をしないため。原因調査 §4(b)）。ただし「公開の直前まで未決のままでよい」という意味ではなく、PR1b の設計と実装を始める前に決める。

### 12.0 方式によらない条件（N1、U1・U3）

**公開するコミットを先に構成し、その SHA の所定の CI を検証してから公開する。`T_N` の証拠を、親の違う `U_N` へ読み替えない。** tree が同じでもコミットは同じではない（コミットは親・author／committer・メッセージ・時刻を含む）。CI の後の amend・メッセージの書き換え・時刻の作り直しも同じで、作り直したら新しい SHA としてもう一度 CI を受ける。

- 「CI をやり直す」は、公開してから base の push run を待つことではない。公開の候補 `U_N` を先に固定し、新しい manifest の対象として CI を受け、緑の後はコミットを作り替えずにその `U_N` だけを公開する
- 接頭辞を公開するなら、その接頭辞自身が新しい検証の対象（全体の緑を接頭辞へ転用しない）
- 費用: PR1 で診断した同じ候補を C1（2 親）へ変えて採用するなら、単一親の診断の CI に加えて 2 親の候補の CI が要る。PR1b ができた後の新しい実行は、**初めから選んだ方式の最終の SHA を作って CI を 1 回**にできる。「PR1b は常に CI 2 回」とは固定しない。PR1 の証拠を PR1b で必ず再利用できる、とも約束しない
- これは N1 への処置で、これだけで F01・F02・F07・F08 は閉じない（下の各節は引き続き要る）

### 12.1 F01 — GitHub は期待する base を固定できない

`gh pr merge --match-head-commit` が固定するのは PR の head だけ。最後に base を読んでから GitHub が受理するまでの間に、ロックに従わない書き手（人の画面でのマージ、別のマシン、別の CLI）が base を進めると、検証していない tree が公開される。事後の tree の確認は「次を送らない」だけで、その 1 本は防げない（既存の merge-pr にも同じ窓があるが、それは train の保証の根拠にならない）。

| 案 | 中身 | 塞げるもの | 残るもの |
|---|---|---|---|
| A 運用の規則 | develop へ書くのは merge-pr と train だけ（人も画面でマージしない）と決め、事後の tree の確認で検出して止める | ロックに従う書き手どうし | 規則に従わない書き手の窓（検出は事後） |
| B サーバーの規則 | ruleset で base への書込みを特定の主体に限る | 主体が違う書き手 | 個人の持ち物で、人とエージェントが同じアカウントを使うので区別できない（見立て V8） |
| C 期待値つきの更新で公開 | `gh pr merge` を使わず、`git push --force-with-lease=refs/heads/<base>:<B0> origin <U_j>:refs/heads/<base>` で公開する。サーバー側の今の値が `B0` と完全に一致するときだけ更新される | すべての書き手（今の値と `B0` の一致を更新の条件にする） | 履歴の形と PR の状態の付け方（12.3）。人が後で develop に保護・ruleset を足すと、この push はサーバーに拒否される（安全側に倒れて止まる。そのときは方式を決め直す）。受理の応答が落ちたときの回復（F07） |

**注意（原因調査 §6）: 普通の fast-forward の push（強制なし）は比較して交換ではない。** Git が確かめるのは「今の宛先が公開するコミットの祖先であること」で、「今の値が `B0` と等しいこと」ではない。例えば base が `B0` より前の祖先へ巻き戻っていれば、`B0` を含む `U_j` の push は fast-forward として通る。C1（2 親）では候補の head も公開するコミットの祖先に入るので、祖先の関係はさらに広い。そのため案 C は期待値つきの lease（期待値の完全一致）を条件にし、「祖先である」を「期待値と一致する」に読み替えない。lease は強制の push の一種なので、`U_j` が `B0` の子孫であることを公開の前に手元で確かめる（`git merge-base --is-ancestor B0 U_j`）。試験は §10 の Y7（巻き戻り・祖先の変化）。実際のサーバーでの反例はまだ試していない。

### 12.2 F02 — 途中で止まったときの未検証の接頭辞

1 本ずつ squash する方式で k 本目まで送って止まると（head の移動・拒否・通信断・死亡）、`B_k` は CI を通っていない（`T_N` が緑でも `T_k` が赤のことがある）。

| 案 | 中身 | 代償 |
|---|---|---|
| a 各接頭辞も検証 | `T_1..T_N` のすべてを CI に通す | CI が N 回になり、train の意味が無い |
| b 公開の単位をまとめる | 検証した `U_j` を 1 回で公開する（案 C と組む） | 案 C と同じ |
| c 弱めを承認 | 未検証の接頭辞が残りうることを認める | 人の承認と、壊れた develop の間の作業の止まり。決めることは「許容時間」と「責任」の両方で、例えば「次の develop の push run の完了まで。その run が赤なら、PM が 30 分以内に revert の PR を出す（または列を止めて原因の PR へ差し戻す）」のように、赤のときに誰が何をするかまで書く |

### 12.3 推奨: C＋b（公開するコミットを検証してから、期待値つきの更新で一度に公開）

- 理由: F01 と F02 を同時に、サーバー側の期待値の比較で閉じる唯一の案。base の tree は CI を通した `U_j` の tree そのものになり、GitHub の squash の tree が手元の再現と一致するか（見立て V1）に依らない。develop は保護されていないので直接の push が通る（main へは使わない）。12.0 により、公開するのは CI を通したその SHA だけ
- 決めることの副案（Q10、人の判断）:

| 副案 | 公開するコミット | 塞げるもの・利点 | 代償 |
|---|---|---|---|
| **C1 2 親** | `U_k` を「tree は squash の再現、親は `U_{k-1}` と `h_k`」で作る | `h_k` が base から辿れるので GitHub が PR を自動で `MERGED` にする（見立て V7。使い捨ての検証先で確かめる）。既存の読み手（merge-pr の「マージ済みは記録と close だけ」、`cancel-pr-runs-on-close.yml`、リリースノートの PR の拾い方）がそのまま働く | develop の履歴に PR のコミットが入り、squash の 1 PR 1 コミットではなくなる。**PR1 の単一親の `T_N` とは SHA が違うので、PR1 の CI の証拠は使えない**（12.0）。PR1 で診断した組をそのまま採るなら CI がもう 1 回要る。PR1b の新しい実行で最初から 2 親で作れば 1 回 |
| **C2 単一親** | PR1 と同じ単一親の鎖（`U_k = T_k` の形） | 履歴は squash の形を保つ。同じ実行の中で作った `T_N` をそのまま公開の候補にできる | PR は `MERGED` ではなく `CLOSED`（「`U_k` でマージした」とコメント）になり、`MERGED` を見る既存の読み手（merge-pr `:490-498`・`prsOfBranch`）に分岐が要る。PR1 の過去の報告の `T_N` を流用しない点は C1 と同じ（12.0・Y5） |

- リーダーの推奨は C1（既存の読み手を変えずに済み、PR の状態が正しく残る）。CI の回数は PR1b の実行で最初から 2 親で作れば 1 回のまま。最終の判断は人
- 案 A＋c を選ぶ場合は、弱めの承認（12.2 の c の許容時間と、赤のときに誰が何をするか）を決定として記録してから PR1b に入る

### 12.4 PR1b に入る条件（方式によらない）

1. **12.0（N1・U3）**: 公開するコミットの SHA そのものの所定の CI を、公開の前に検証する。CI の後にコミットを作り替えない
2. **期待する base の完全一致（U3）**: 公開は `B0` との完全一致を更新の条件にする（12.1 の注意。普通の fast-forward の push に頼らない）
3. **保存した ref・過去の報告を採用しない**: 公開してよいのは、同じ実行の中で作って検証し、`B0` が今の base と一致する公開の候補だけ。PR1 の報告（`publishable: false`）・残した ref・過去の green を公開の許可に読み替えない（Y5）
4. **V1 の確認（GitHub の squash に頼る方式を採る場合だけ）**: 使い捨ての検証先のリポジトリで T-T の各形と、`text`・`eol` の属性（`merge.renormalize`）・`.git/info/attributes`・`core.attributesFile` の条件を実際に squash させ、tree が一致することを確かめる（人の操作: 検証先のリポジトリの用意）
5. **F07 死んだ train の未確認の書込みの回復**: 外への要求の前に write-intent（train ID・PR・`h_k`・期待する base・公開する SHA・予測の tree）を永続化し、ロックの記録の更新の成功（`setOwnerFields` が `true`）を確かめてから送る。「要求の成功」「照合済み」「記録済み」を別の状態にする。merge-pr が train 由来の未解決の PR を「マージ済みなので記録と close だけ」で解消しないよう、merge-pr の未解決の読み手に分岐（train の manifest と実際の base を照合できるまで保持し、専用の回復へ返す）を同じ PR に入れる
6. **F08 マージ前の適格性**: legacy の保護・有効なルール（`rules/branches/<base>`、組織の継承を含む）・queue を読み、strict（ruleset を含む）・queue・`unknown` のどれかなら最初の書込みの前に exit 2
7. **F01 の宛先**: 書く直前に PR の `baseRefName`・`headRefOid`・head の repo を読み直す（R05）
8. `merge=ok` は PR の `h_k` と issue/item に結び、train の head や公開のコミットで代用しない
9. 試験: §10 の「PR1b の試験」（R04〜R10、Y1〜Y7）

### 12.5 PR1b でも変えないこと

- train は Issue を閉じない（記録だけ。閉じるのは既存の経路）
- merge のロックを取り、merge-pr と直列にする
- merge-pr の引数の決まり方（単発の `--last`、`--queue` の最後の entry の自動の `last`）に例外を足さない

## 13. 他の子への約束

| 相手 | 提供／利用 | 形と単位 |
|---|---|---|
| #4367（計測） | 提供: train の出来事 | 語彙の案は `created`・`pushed`・`ci`・`merged`・`dropped`・`rebuilt`・`stopped`。確定は PR3 で、#4367 の書き手へ `kind: train` を足すときに呼び手と一緒に決める（X2）。PR1・PR1b・PR2 は run の記録の `train` 行と報告の JSON だけで、flow の記録の API を先に足さない |
| #4367（計測） | 利用: `flow.yaml` の読み手 | `scripts/flow/config.mjs`（X1）の `base`・`exclude`。`train` 節は PR2 が同じ読み手へ足す。PR1 は引数と既定値だけ（X6） |
| #4368（WIP） | 利用しない | |
| #4370（資源） | 利用: 枠 | P0 はホストでの組み合わせ確認（§2.4 の tsc＋影響テスト）の区間だけ。CI の待ちには握らない（X10）。接続は PR3。PR1 は既存の `cpu.heavy` の規則のまま |
| #4370（資源） | 提供: 負荷の予定 | train の CI は 1 回で self-hosted のジョブ約 16 本。train は base ごとに 1 本（I8） |
| `docs/orchestrate/ci-merge.md` | 共有 | #4369 PR1 と #4370 PR1 が別の節を足す。後に入る方が develop を取り込んで足す（X5） |
| PM・リーダー（運用） | 提供: 使い方 | PR1: `merge-train --queue <entries>` は診断（`publishable: false`）。マージは train が無いときと同じ引数・同じ方法で `merge-pr` を回す（`--last` を外さない、`--queue` を単発のループに変えない、train の ref を base へ入れない・PR にしない） |

## 14. 人の判断（未決。推奨つき）

| # | 決めること | 推奨 | 決める人 |
|---|---|---|---|
| Q1 | PR1 の実機の試し方 | 開いている PR が 3 本以上たまったときに 1 回動かし、報告（tree・CI の証拠・適格性）を見る。マージは train が無いときと同じ引数で merge-pr。最初の実行で V9（再実行の後の jobs）を確かめる | PM |
| Q2 | train が Issue を閉じるか | 閉じない | 人（Issue 仕様どおり） |
| Q3 | develop の途中の push run を取り消すか | 取り消さない（案 C＋b なら途中の push は存在しない） | 人 |
| Q4 | 候補の条件 C6（PR 自身の CI が全緑）を外すか | 外さない | PM |
| Q5 | GitHub の merge queue を試すか | このリポジトリでは試さない | 人 |
| Q6 | strict のある base | PR1 は報告だけ、PR1b は拒否 | 人 |
| Q7 | ランナーの台数・Docker | 変えない（#4370 の範囲） | 人 |
| Q8 | F01 の方式（§12.1） | C（期待値つきの更新。普通の fast-forward の push ではない） | 人。PR1b を始める前（PR1 の前提ではない） |
| Q9 | F02 の方式（§12.2） | b（公開の単位をまとめる） | 人。PR1b を始める前 |
| Q10 | 案 C の PR の状態の付け方（§12.3） | C1（2 親、GitHub に `MERGED` を付けさせる。PR1b の実行で最初から 2 親で作り CI を 1 回） | 人。PR1b を始める前 |

GitHub の設定・launchd・Docker・ランナーの変更はどれも要らない（`ci-pr.yml` の変更は PR で入る）。案 C の検証先のリポジトリの用意は人の操作。

## 15. 事実と見立ての区別

事実（読んだもの）:

- §1 の表の file:line（`origin/develop` a334a013f の `git show`）
- §1 の GitHub の設定（`gh api` の読み取り、2026-11-14。第 2 版では再取得していない）
- push の run は push したコミットの中のワークフローの定義で起動する（GitHub Actions の仕様）
- `merge-pr --queue` は実行の順で最後の entry に自動で `last` を付ける（`merge-pr.mjs:1089-1103`、試験 `merge-pr-queue-4277.test.ts:235-246`）。`--last` の無い単発の呼び出しは `Unit Tests`・`Build` 以外の `pending` を待たない（`:32-41`）
- Git の普通の fast-forward の push が確かめるのは「宛先が公開するコミットの祖先であること」で、期待値との一致は `--force-with-lease=<ref>:<expect>` が確かめる（git-push の公式の説明、原因調査 §6 の引用）
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
- **V9** `rerun --failed` の後の `actions/runs/<id>/attempts/<n>/jobs` が、前の attempt から成功を引き継いだジョブを含む。含まなければ必須の 19 件がそろわない。確かめるまで再実行の後の緑は出さない（I5）
- **V10** CommandMate のサーバーの worktree の同期は、消えた detached の worktree の行を DB から消す（train の作業ツリーは clone で `git worktree list` に載らないので PR1 は依らない。K1）
- **V11** 親だけ違う同じ tree のコミットで、今の CI の結果が変わるか（未確認。変わらなくても、U1 により証拠は SHA に結ぶ）

## 改訂の履歴

- 2026-11-14 第 2 版: 事前レビュー（P1 2・P2 7）と再指示 1 を反映。PR1 を作成・確認・報告に狭めて base への書込みを PR1b へ移し、F01・F02 の選択肢と推奨（§12）、F03 の形の制限、F04 の条件の和、F05 の依存の拒否、F06 の train ID と CI の証拠、F07・F08 の PR1b の条件、F09 の PR2 の規則、R01〜R24 の試験の表への割り当てを足した
- 2026-11-14 第 3 版: 再レビューの N1（F06 の 2 回目）・N2（F02 の 2 回目）と原因調査を反映。最上位の不変条件 U1〜U3 を置き、PR1 を公開の権限の無い診断に固定（`publishable: false`・注意の文・公開の引数と経路の拒否・ci-merge.md の 4 つの文）、`--queue` の最後の entry の自動の `last` を反映して merge-pr に例外を足さないと明記、PR1b に「公開するコミットの SHA を先に検証」「期待値つきの更新（fast-forward ≠ `B0` との一致）」を足し、Q8〜Q10 を PR1b の前の判断に。原因調査 §5 の表を T-R と PR1b の Y1〜Y7 へ、再レビューの P3（worktree を作業ツリーの外・`filter=latest` と `check_suite_id`・V9・依存の候補を外す・作り直し既定 0・ref の保持・属性の条件・T-L）を反映
- 2026-11-14 第 4 版（PR1 の実装）: 事前レビュー 3 回目の処分を反映。K1: train の作業ツリーを `git worktree add` から `git clone --shared`（`os.tmpdir()` の下）へ。実装の最初に一時 dir で clone の上の precheck（`--base <SHA>`・`markerFiles`・ESLint・tsc・`vitest related`・guards/docs）が動くことを確かめた。受入基準 9 を「元のリポジトリの `git worktree list` が変わらない」に置き換え、T-T に T12。P3-1: I1・X2 の許される push を「自分の ID の作成と削除」と「`pruneOwnRefs` が報告から選んだ古い ID の lease つきの削除」に分けた。P3-2: 残る ref の数（`refs.remaining`）と人が消す運用（ci-merge.md）。P3-3: 再実行の後の未確認の緑の人向けの文の先頭に「赤ではない（再実行の後の緑。未確認）」。実コードに合わせた点: `train` は `LOG_STAGES` ではなく `TRAIN_LOG_STAGES`（既存の試験の期待値を変えないため）、`status --json` の `train` は行があるときだけ。T-B の対応は gh v2.86.0 の `pkg/cmd/pr/checks/aggregate.go` と一致（`startup_failure` などは既定の pending）
