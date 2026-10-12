# PR とマージの根拠と実測

Phase 6（PR とマージ）の規則は本体にある。ここには、その根拠と実測を移した（#3481）。

## 6-1 同時に回す本数の実測

分割前の実測（CI 実行 118 本、2026-08-21〜24）:

| 同時実行ピーク | CI 中央値 | 最大 |
|---|---|---|
| 1 | 10.8 分 | 12.3 分 |
| 3 | 11.6 分 | 15.5 分 |
| 4 | 14.7 分 | 28.6 分 |
| **20** | **49.2 分** | **162.4 分** |

分割後は 1 本あたりのジョブ数が増えるので、同時本数の推奨は分割後の実測で見直す（#2638）。

**3〜4 本までは +8〜36% で、スループットはほぼ線形に伸びる。** 20 本は 4.5 倍の劣化で、
増やした分を食い潰す（この帯では 1 マージあたりの CI 実行回数も 3.7 回まで膨らんでいた＝
refresh のやり直し）。

**逆方向の失敗の方が高くつく。** 2026-08-23〜24 に同時 1 本で回した帯では、CI 単体は
10.8 分と最速だったのに**スループットは 2.50 → 0.50 PR/h（5 分の 1）**まで落ちた。
1 本あたりの品質指標（CI 実行回数 3.7 → 2.0、PR 作成→マージ 最長 6 時間 → 11〜13 分）は
すべて改善していたので、落ちたのは並列度だけである。**「丁寧にやる」を「1 本ずつやる」と
取り違えないこと。**

## 5-3 未処置の指摘が残った実例

（#2011 のコミット文は「`api-responses.ts` は scope 外なので直していない。要追随」と書いたが、追跡する Issue にならず、
後に #3298 として出た。#1899 の「hook を受ける側は直していない」も #3289 になった）

## 5-3 PR の前の確認の実測

実測（2026-10-05 #3291）: レビューを通った後に CI のガードで落ちた

実測（2026-10-05 #3292・#3295）:
コミットした結果、変更が scope の外に出て scope ゲートが落ちた

## 6-1 同時本数の前提

CI は使い捨ての self-hosted ランナー 8 台（2026-09-18 時点）で、PR あたり 14 ジョブを回すので
（#2638 で Unit Tests を 4 本に分割）、同時本数を上げると 1 本あたりが
伸びる。**が、伸び始めるのは 4 本を超えてからで、3〜4 本まではほぼ無償である。**

## 6-1-1 並走させる理由

順に回すと 1 issue あたり約 22 分（ローカル 10.8 分 ＋ CI 10.8 分）を直列で払う。

実測でローカルゲートの
85〜90% は `unit` 単独（545〜584 秒）なので、**1 issue あたり約 10 分が消える。**

壊れた PR で CI を焼くリスクは、先に通す確認でほぼ潰せる。両方が緑になってからマージするので
裁定の強さは変わらない。

## 6-1-1 precheck の段と再利用

- 段: 断片の検査（`node scripts/changelog-fragments.mjs check`）・削除した `it` / `describe` の数（0 でなければ落とす。契約の決定が許したときだけ `--allow-removed-tests`）・
  変更したファイルの ESLint・`.sh` を変えたら `node scripts/run-lint-sh-if-changed.mjs`・整理と計測の Issue だけ `node scripts/count-suppressions.mjs`（2-4-3）・
  `tsc --noEmit`・関係するテスト（`vitest related` ＋ 変更したテスト・変更したパスを名指しするテスト・`tests/unit/guards`・`tests/unit/docs`）
- 結果は run の記録の `precheck` 段に HEAD つきで書く。**同じ HEAD・同じ引数（`--base` / `--kind` / `--metrics` / `--allow-removed-tests` / `--build`）の `ok` があれば
  走らせずに再利用する**（どの段も、コミットされた木と引数だけを読む。落ちた後の再実行でも同じテストを 2 回走らせない）。
  同じ HEAD の `verify=ok` が通した verify.yaml のゲートのうち、同じ確認になるもの（`lint` → ESLint、`typecheck` → tsc、`lint-sh` → lint-sh）の段も走らせない。
  契約が定義したゲート（`<id>@contract`）と、テストのゲート（`unit` / `unit-related`。選ぶテストが違う）は、どの段の代わりにもならない
- 関係するテストは `tests/unit` に限る（`vitest related --dir tests/unit`）。integration / e2e は CI が見る

- 作業ツリーに契約（`.commandmate/tasks/`）と `dev-reports/` 以外の変更があると、その HEAD の結果にならないので exit 2 で止まる

## 6-2 統合破壊の実測

2026-08-22 に、単独でどちらも全ゲート緑・CI 11/11 の
2 本を続けてマージして develop の `tsc` と `test:unit` を壊した（一方が関数を rename し、
他方のテストが旧名を使っていた）。同型の統合破壊はこの run で 2 件あり、**どちらも
`npx tsc --noEmit` と影響テストのローカル実行で捕まった**。

## 6-2 コメントの中の衝突マーカーの実例

2026-08-22 に JSDoc ブロックコメントの
内側へ落ちた衝突マーカーをコミットした事例がある（**コメント内なので `tsc` は exit 0、
関連テストも緑**だった）。

## 6-3 fail を見落とした実例

2026-08-22 に「10 pass / 1 fail（Build）」の PR を、fail を目視で見落として
マージし develop のビルドを壊した。

## 6-4 一本化のコミットと scope ゲート

**一本化のコミットには trailer `Orchestrator-Fold: module-reference` を付ける**（例: `git commit -m 'docs(module-reference): #<N> の断片を本体へ写す' --trailer 'Orchestrator-Fold: module-reference'`。trailer が無いと、再指示の後の scope ゲートが一本化を範囲外として落とす）。`docs/module-reference.md` だけを変え、この trailer を持つコミットだけが触ったパスは、その後にワーカーへ再指示しても `verify --task` の scope ゲートが差分から除くので、それを理由に exit 20 にはならない（#3588）。trailer の無いコミット（ワーカーの単独コミットを含む）や未コミットの変更が同じファイルを触った場合は、今までどおり範囲外として落ちる。merge コミット自身の編集は、`docs/module-reference.md` の中なら承認済みの統合（develop の取り込みで衝突を機械解決したもの）として除き、それ以外のファイルの編集はワーカーの変更として scope で判定する。`merge-pr.mjs` が一本化を越えて作業の HEAD を探す規則（`pr-common.mjs` の `workHeads`）はファイルだけで判定し、trailer を求めない。

同じ判定で、`work-evidence` ゲートも一本化のコミットを作業証跡のコミット数に数えない（#3633）。一本化のコミットだけのブランチを verify すると、scope は変更ゼロで合格しても work-evidence が作業証跡ゼロ（exit 21）にして未着手として止める。ワーカーのコミットが 1 つでもあれば今までどおり合格する（log の `orchestrator fold commit(s) excluded` が除いた数）。

## 6-4 断片が無い PR の実例

（過去に実際に発生し、後追いで docs PR が必要になった）

## 6-4 断片と消えたテストを手で確かめる

CHANGELOG の断片は、同じタイミングで PR ブランチ上で次を確認する:

```bash
# changelog.d/<N>.md がこの PR のコミットに含まれている（未コミットの断片は出ない）
git diff --name-status origin/develop...HEAD -- changelog.d/   # 状態 A（追加）の changelog.d/<N>.md の 1 行だけであること
# 断片の書式が通る（他の断片も含めて全件を検証する）
node scripts/changelog-fragments.mjs check; echo "CHECK=$?"     # CHECK=0 であること
```

既存のテストが消えていないことも、同じタイミングで確認する（`unit-related` のゲートはテストが消えたことを検出できない。2-4-2 の #2936）:

```bash
# 削除された it / describe / test の行数。0 であること
git diff origin/develop...HEAD -- 'tests/**' | grep -cE '^-\s*(it|describe|test)\('
```

0 でなければ、差分を読んで意図を確かめる（名前の変更・移動なら理由が本文かコミットメッセージにあるか）。

## squash のコミットの題名

`merge-pr.mjs` は `gh pr merge --squash --subject "<PR タイトル> (#<PR 番号>)"` で題名を渡す（タイトルが既に `(#<PR 番号>)` で終わるなら二重にしない）。
fold や develop の取り込みで work HEAD と異なるときも、CI 待ちの最後に読んだ PR のタイトルを使う（`--pr` 指定でも同じ）。マージ後の develop のコミットの題名は PR の題名と一致する（#3618）。

## gh の 5xx の再試行

`publish-pr.mjs` と `merge-pr.mjs` の `gh` の呼び出しは、`pr-common.mjs` の `withGhRetry` を通る（#3633）。呼び直すのは読み取りの `gh`（`pr view` / `pr list` / `pr checks` / `issue view` / `run view` / `run list`、`gh api` の GET など。`isGhRead`）だけで、GitHub が `HTTP 502` / `503` / `504`（2026-10-12 の Partially Degraded の間の `504 Gateway Timeout` で、#3587・#3618・#3588 の merge-pr.mjs が計 10 回以上 exit 1 で止まった）を返したときと、接続が切れたとき（connection reset・i/o timeout など）だけ、10 秒・30 秒・60 秒あけて最大 4 回まで呼び直す。呼び直すたびに stderr へ `gh <サブコマンド>: <gh の 1 行目> — retrying in <秒>s (attempt <n>/4)` を出す。4xx（404・422・401 など）や本当の失敗（マージできない・チェックの待ち中の exit 8）は呼び直さず、今までどおりそのまま止まる。4 回とも 5xx なら最後の答えで今までどおり止まるので、外側での再試行は GitHub の障害が数分続いたときだけでよい。

書き込みの `gh`（`pr create` / `pr merge` / `run rerun` / `issue close`）は 1 回だけ送る（`ghWrite`）。504 は「GitHub が処理を終えたが応答が届かなかった」こともあるので、送り直すと PR が 2 本立つ・同じ HEAD の run を 2 回 rerun することがありうる。5xx・接続エラーで失敗したときは送り直さず、読み取りで 1 回確かめる: `pr create` はブランチの open な PR が今の HEAD を指しているか、`pr merge` は PR が `MERGED` で head が今の HEAD か、`run rerun` は run の status が `completed` でなくなったか、`issue close` は Issue が `CLOSED` か。済んでいれば stderr に `— not sent again; it went through` を出して成功として続け、済んでいない（または確かめる読み取りも失敗した）ときは `— not sent again; it did not go through` を出して今までどおり失敗で止まる。HEAD ごとに rerun は 1 回の制御（`ci` の段の `rerun=`）は変わらない。
