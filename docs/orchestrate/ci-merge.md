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
- 関係するテスト・テストの段が広いときは `cpu.heavy` を取ってから走らせる（#3884。しきい値と記録は下の「6-1-1 重い検証の資源制御と待ちの記録」）。
  `merge-pr.mjs` が自分で取り込んだ HEAD だけは、その段を走らせず CI に任せる（`--heavy-to-ci`。下の「6-2 取り込み後の重い段」）

## 6-1-1 テスト全体と unit-related の分け方

（#3884 G6-4）**既定は `unit-related`**（契約の `gates: [lint, typecheck, unit-related]`）。テスト全体（verify.yaml の `unit`）を契約で選ぶのは、
変更に関係するテストだけでは裁定にならない次の変更に限る:

- テストの共通設定・ヘルパーを変える（`tests/setup.ts`・`tests/helpers/**`・`vitest.config.ts`）
- 広い rename・移動で、import の関係そのものが変わる
- 多くのモジュールが読む共有の状態・型の**意味**を変える（署名が同じでも読者が多いもの。例: `src/lib/db` の行の意味、`src/types` の共通の型）

`unit-related` は、`src/` のコードと `tests/unit`・`tests/helpers` 以外のファイルが変わると自分でテスト全体に切り替わる
（`scripts/run-related-unit-tests.mjs` の `mode=full`）。そのときに `unit` を重ねて足さない（同じ全体を 2 回走らせるだけ）。

**同じ PR の同じ tree で、テスト全体を重ねない。** テストのゲートの合格は、その HEAD（＝その tree）と、その環境（`env=` の manifest、
`verifyEnvState` が `same`）にだけ効く。この 2 つが同じなら、レビューの往復で新しいコミットが無い再検証・precheck・merge 前の確認で
テスト全体を走らせ直さない（precheck は同じ HEAD・同じ引数の `ok` を再利用する。上の節）。HEAD か環境が変わったら走らせ直す。

**流用しないもの**: `work-evidence`・`scope`・`env-clean` は契約（task）に結び付いた判定である（`scope` は契約の `scope.allow`、
`env-clean` は task の開始時の snapshot、`work-evidence` は契約のファイルを除いた差分）。別の task・別の契約の合格を、HEAD が同じという
だけで流用しない。再送・再指示で task を作り直したら、その task で検証をやり直す（テストのゲートの合格だけは、同じ tree・同じ環境なら
再利用してよい。契約が要求する組み込みのゲートは `--gates` で絞っても必ず走る）。

**省略しないもの**: PR の CI の全体検証（`Unit Tests`・`Integration`・`E2E`・`Build`）と、API・DB を変える変更の統合検証
（verify.yaml の `integration` か CI の `Integration`）は、ローカルで何を再利用しても省かない。`unit-related` で裁定した PR は
CI の `Unit Tests` が `pass` になってからマージする（6-2 の例外。今までどおり）。

## 6-1-1 重い検証の資源制御と待ちの記録

（#3884 H-10・H-11・G6-5）重いテストは、どの入口から走っても同じ `cpu.heavy`（マシンで 1 本）に入れる。`mutex` を外す・
同時の本数を増やすことは解決にしない（.commandmate/verify.yaml の `unit` / `integration` の注記: 負荷で裁定が反転する）。

- **verify の実行枠**（`MAX_CONCURRENT_VERIFICATIONS` = 2、`src/lib/verification/gate-runner.ts`）は「同時に**実行**するゲートの数」の
  上限で、待っている run の数ではない。ゲートが `mutex` を待つ間は枠を返し（ロックが空いていれば返さない）、ロックを取ったら、
  始まるのを待っている run より先に枠を取り直す。以前は `cpu.heavy` を持つ run と待つ run の 2 本で枠が埋まり、3 本目の run は
  5 秒の `lint` も始められなかった。同時に実行するゲートは今までどおり 2 本まで、重いゲートは `cpu.heavy` で 1 本ずつ
- **待ちと実行を分けて記録する**: `mutex` を持つゲートと、枠を待ったゲートの `log_tail` の最後の行に
  `[timing] queue=<秒>s mutex=<秒>s run=<秒>s` が入る（`queue` は枠の待ち、`mutex` はロックの待ち、`run` はコマンドそのもの＝
  `duration_ms`）。`[mutex] waited=` は今までどおり 1 行目にある。どちらも待たなかったゲートには何も足さない。
  `log_tail` に載るので `commandmate verify --json`・`verify show` に出る。ログ本文を持たない `verify history --json`
  （`GET /api/verification/runs`）には、この行だけを数に直した `timing`（`{ queueSec, mutexSec, runSec }`）がゲートごとに載る。
  行の無いゲート（待ちの無いもの・この行ができる前の run）は `timing` を持たない
- **verify の取消し**: `mutex` を待つ間に枠を返した run を取消すと、枠を取り直さずに閉じる。ロックを取った後の枠待ちも取消せ、
  そのときはロックを返す。ほかの 2 枠が長いゲートを実行中でも、取消しはその終了を待たない
- **precheck**（`scripts/orchestrate/precheck.mjs`）は、テストの段が広いときだけ `cpu.heavy` を取る:
  `tests` は、明示したテスト（変更したテスト＋変更したパスを名指しするテスト）が **50 ファイル以上**のとき。`tests/unit/guards`・
  `tests/unit/docs` は数えない（毎回走る軽い確認で、ここに一律に mutex を付けない）。`related` は、変更した `src/`・`scripts/` の
  ファイルに **import をたどって届く** unit テスト（`vitest related` と同じく間接の import も数える。`src/`・`scripts/`・`tests/` の
  静的・動的な import、`@/`・`@tests/` と相対パス。パスで名指しするテストも足す）が **50 ファイル以上**か、変更したファイルが **20 以上**のとき。
  型だけの参照（`import type`・`export type`・指定子がすべて `type` の `import { type A }`）はたどらない（変換で消え、`vitest related` も
  たどらない。一部だけ `type` の import は実行時の参照として数える）。
  直接の import だけ数えると、`env.ts` のように直接の利用者は少ないが `logger.ts` を通じて千を超えるテストに届く変更を軽い扱いにしていた。
  50 は tests/unit（2026-10-25 時点で 2436 ファイル）の約 2% で、ロック無しで走ってきた guards＋docs（58 ファイル）と同じ程度の量。
  ロックの待ちの上限は `unit` ゲートと同じ 5400 秒で、待ち切ったらその段は**走らせない**（`<段>=held`）。ほかの段が落ちていなければ
  precheck は**裁定不能**として記録の結果を `skip` にし、**exit 3** で終わる（ok の 0 とも、段が落ちた 1 とも別。資源の衝突を
  テストの不合格にしない）。同じ HEAD で走らせ直せばよい（`skip` は再利用しない）。待ち切った後の重い段は待ち直さずに `held` にする。
  ロック無しで重ねて走らせると、ロックが防ぐはずの負荷由来の裁定を記録してしまう
- **run の記録**: `verify` / `precheck` の行は、`durationSec` を `queueSec`（枠の待ち）・`mutexSec`（ロックの待ち）・`runSec`（実行）に
  分けて持てる（`run-log.mjs append --queue-sec / --mutex-sec / --run-sec`。無い行は今までどおり読む）。precheck は自分で
  `mutexSec`・`runSec` を書く
- **待ち切った verify**: `reason=mutex-wait` の SKIP だけで exit 99 になった検証は、`wait-verify.mjs` が `--mutex-retries`（既定 2）回まで
  自動で並び直す（#3938）。手順と記録の読み方は docs/orchestrate/exit-codes.md#3-4-99-の対応

## 6-2 統合破壊の実測

2026-08-22 に、単独でどちらも全ゲート緑・CI 11/11 の
2 本を続けてマージして develop の `tsc` と `test:unit` を壊した（一方が関数を rename し、
他方のテストが旧名を使っていた）。同型の統合破壊はこの run で 2 件あり、**どちらも
`npx tsc --noEmit` と影響テストのローカル実行で捕まった**。

## 6-2 「CI が通れば」の許可と全チェックの合格

`--last` なしの `merge-pr.mjs` は、全 `unit` の検証と `--build` の precheck がある PR の `Build` も `Unit Tests` も待たない（取り込み後に重い段を CI に任せた HEAD の `Unit Tests` は待つ。下の「6-2 取り込み後の重い段」）。設計どおりだが、利用者の許可の「CI が通れば」とは食い違う。
実例（#4135）: PR #4125 を、開いて 22 秒でマージした（`checks=pending:16`）。push の CI は後で全 17 ジョブ合格で、結果として害は無かった。

決定: `merge-pr` にオプションは足さない。全チェックを待つ経路は既存の `--last` で足りるので、許可の条件が「CI が通れば」の run ではどの PR にも付ける規則にする。

全チェックの合格は `judgeChecks` の判定そのもの: すべての `bucket` が `pass` か `skipping`。`skipping` は CI が条件で飛ばしたジョブで、待っても結果は変わらないので合格に数える。`pending` は待ち、`fail` / `cancel` はマージしない。

`gh pr checks` は登録済みのチェックしか返さない。登録済みが全部合格でも CI の完走とは限らないので、`--last` は `LAST_REQUIRED_CHECKS` のすべてが登録されるまで待つ。一覧は `.github/workflows/ci-pr.yml` の全ジョブ（matrix の展開後の `Unit Tests (shard 1/4)`〜`(4/4)` を含む 17 件）で、ジョブを足す・名前を変えるときは一覧も直す。食い違うと `merge-pr.test.ts` が両方向で落ちる。一覧に無いチェック（ほかのワークフローなど）は、登録されてから完了を待つ。`--last` なしは未登録を待たない（今までどおり）。

対象は `ci-pr.yml` だけでよい（#4148 で見送り。追跡は不要）。PR に対して走るほかのワークフローは `cancel-pr-runs-on-close.yml` だけで、PR を閉じたとき（`types: [closed]`）にしか動かない。`pages.yml` は main への push、`publish.yml` はリリースで走る。PR の開いている間に別のワークフローを足すと `merge-pr.test.ts` が落ちるので、そのときに一覧へ足すかを決める。

## 6-2 取り込み後の重い段

（#4265。2026-11-08 の run 4221-4259 で、PR #4261 の取り込み後の precheck が `cpu.heavy` を 5400 秒待って exit 3、
#4262 は 109 分中 67 分がこの待ちだった。取り込み後の PR の CI は 18 分。枠はワーカーの `wait --verify` の
`unit` / `integration` / `unit-related` と共有で、並行するワーカーがいる間は空かない。）

`merge-pr.mjs` は、**その実行で develop を取り込んだ HEAD** の precheck に `--heavy-to-ci` を渡す。precheck は
`cpu.heavy` を取るはずの段（広い `related` / `tests`）を走らせず、ロックも取らずに、記録の要約へ `<段>=ci` と書く
（結果は `ok`。`run-log.mjs status` の `next` も、merge-pr・publish-pr の `unmetStage` も、ほかの `ok` の precheck と同じに読む）。
手元に残すのは秒で終わる段だけ:

- 衝突の印の全追跡ファイル走査（precheck の前に merge-pr が行う）
- changelog・removed-tests・ESLint・lint-sh・suppressions・tsc
- 広くない `related` / `tests`（ロックを取らない段。guards・docs を含む）

これらが落ちたら今までどおり push せずに止まる。重い段の確認は、取り込んだ HEAD を push した後の PR の CI が受け持つ。
マージの条件は変えていない: 6-3 の判定（`--last` の全チェック、`Unit Tests`・`Build` を待つかどうかの規則）で、
**その HEAD の CI が合格するまでマージしない**。単独で緑の PR を続けてマージしても組み合わせが通るとは限らない（上の「6-2 統合破壊の実測」）への備えは、
この CI の合格を待つことで守る。
ただし重い段を CI に任せた HEAD（precheck の記録に `<段>=ci` がある HEAD）は、`--last` の有無によらず CI の `Unit Tests` が `pass` に
なるまでマージしない。ワーカーの検証がテスト全体を通していても、それは取り込む前の作業 HEAD の tree で、取り込んだ HEAD の組み合わせを
手元で見たテストは無いため（`--last` なしで全 `unit` の検証がある PR でも `Unit Tests` を待たない、の例外。記録の `ci` は `unit=pass`）。

次の precheck は今までどおり `cpu.heavy` を取り、待ち切ったら exit 3（保留）になる:

- publish-pr の前の初回の precheck（6-1-1）
- merge-pr が取り込みをせずに走らせる precheck（`publish-pr.mjs` が先に push した取り込みの HEAD、前回の実行で取り込んだまま push しなかった HEAD を含む）

`<段>=ci` の記録は、`--heavy-to-ci` の precheck どうしでだけ再利用する。フラグ無しの precheck は同じ HEAD でも重い段を走らせ直す。

## 6-2 CI 待ちの間に develop が動いたとき

`merge-pr.mjs` の refresh は開始時にしか行わない。CI を待つ間に先の PR がマージされると、待っている HEAD は組み合わせとして未確認になる。そこで CI を見るたびに、`gh pr checks` を読んだ**後で** `git fetch` して（#4148）、`origin/develop` がマージする SHA（worktree の今の HEAD ではなく、`--match-head-commit` に渡す固定の SHA）に含まれなくなっていたら**マージせず exit 4** で止める（`merge` の段に `base-moved` を記録）。同じ引数で再実行すれば、取り込み・precheck・push からやり直す。`--match-head-commit` が固定するのは PR の HEAD だけで base は固定しないので、緑の返答を待つ間に進んだ分もここで読む。最後の `git fetch` から `gh pr merge` が届くまでの間に進んだ分は、この検査では止まらない（GitHub 側で base を固定する手段が無い）。

`git fetch` が失敗した回は判定できないので、その回はマージせず、次の回に読み直す。読めないまま期限に達したら exit 124。

## 6-3 落ちたジョブの再実行と run の完走

（#4162。1 ジョブが早く落ちると、同じ run の残りが走っている間は `gh run rerun` が `already running` で拒まれ、`merge-pr.mjs` が exit 1 で止まっていた。#3783・#4149 で実測。）

`merge-pr.mjs` は落ちたジョブの run に `pending` のチェックが残っている間は再実行を送らず、完走を待つ。追加の API は呼ばない（`gh pr checks` の `link` で run を見分ける）。チェックに現れていないのに `already running` で拒まれたときも、送っていないものとして待ちに戻る。

- **待機の期限**: `--ci-timeout`（別の上限は設けない）。超えたら exit 124 で、`waiting for run <id> to finish before re-running it` と出す
- **develop が進んだとき**: 見るたびの確認（「6-2 CI 待ちの間に develop が動いたとき」）で exit 4。再実行は送らない
- **PR の HEAD が進んだとき**: 待ちの間に動いたら exit 1（`ci` 段に `head-moved <sha>` を記録）。古い HEAD の run を再実行しても、マージする HEAD の確認にならない。新しい HEAD で再実行すれば続きから進む
- **再実行の回数**: 同じ HEAD で 1 回のまま。受理された分だけを `rerun=<id>` と記録するので、待っている間に `merge-pr.mjs` が止まっても、再開後に 1 回送る。受理の後は、また落ちれば `after-rerun` で止まる

## 6-3 git push の 5xx

`publish-pr.mjs` と `merge-pr.mjs` の `git push` は `pr-common.mjs` の `pushHead` を通る（#4162）。`gh` の書き込み（下の「gh の 5xx の再試行」）と違い、同じ SHA の push は送り直しても変わらないので、再試行する。

- **対象**: HTTP 500・502・503・504、`RPC failed`、接続切れ、理由が `Internal Server Error` だけの `[remote rejected]`（#4133 の実測の形）。`[rejected]` と、ほかの理由の `[remote rejected]`（非 fast-forward、hook、protected branch）は答えなので送り直さない。hook が `Internal Server Error` と出力しても、git の理由は `pre-receive hook declined` なので対象にならない
- **応答が消えたとき**: 失敗のたびに `git ls-remote origin refs/heads/<branch>` を読み、リモートがこの HEAD なら成功として進む
- **回数**: `gh` と同じ最大 4 回（10 秒・30 秒・60 秒あける）。尽きたら今までどおり exit 1
- **ローカルが進んだとき**: 送り元は常に確かめた SHA（`git push origin <sha>:refs/heads/<branch>`）で、`HEAD` やブランチ名を git に解決させない。確認の後に参照が動いても、送るのは検証と記録の SHA のまま。進んだコミットは次の実行で判定する。`publish-pr.mjs` の上流は push の後に `git config` で設定する（SHA の送り元では `-u` が効かない。設定の失敗は知らせるだけで止めない）

## 6-3 CI の登録までの時間と --ci-timeout

待ちを 2 つに分ける（#4148）:

- `--register-timeout`（既定 600 秒）: この HEAD にチェックが 1 つも無い間。GitHub が CI の run を作るまでの時間で、CI の遅さではない。超えると `no CI registered on <sha>` で exit 124
- `--ci-timeout`（既定 3600 秒）: 最初のチェックが見えてから。超えると今までどおり `CI did not settle` で exit 124

どちらも exit 124 で、再実行すれば同じ HEAD の CI を待ち直す。`git push` の 500（`remote rejected ... Internal Server Error`、#4133 で 2 回）は上の「6-3 git push の 5xx」のとおり再試行する。4 回とも失敗すると exit 1 で止まり（`git push failed: ...`。マージには進まない）、再実行すれば `refresh=unpushed` で push からやり直す。

#4133 の exit 124 の実測（`merge-4133c.out`）: 出力の 12 件はどれも `(not registered)` の付かない `pending` で、登録の遅れではなく登録後のジョブが 1 時間終わらなかった形だった。この形はこの分離でも exit 124 のままで、同じ HEAD で待ち直す前に `gh run view` でランナーの詰まりを見る。

## 6-2 分類器にマージを拒否されたとき

明示の許可（dispatch-terms の「マージを進めてよい」）がある run でも、auto mode の分類器がマージを拒否することがある（#4016）。実測は 15 run 中 3 run。11-01 と 11-02 は計 8 PR が、人手なし・許可ルールがあっても拒否された。拒否は毎回ではない。

決定: 「マージ可」は残す。拒否されたら `merge-pr.mjs` と `gh pr merge` の言い換えなど別の経路で再試行せず、CI の合格を確かめて「マージ可能」を報告し、残りの PR もマージせずに止まる。

## 6-2 コメントの中の衝突マーカーの実例

2026-08-22 に JSDoc ブロックコメントの
内側へ落ちた衝突マーカーをコミットした事例がある（**コメント内なので `tsc` は exit 0、
関連テストも緑**だった）。

## 6-3 fail を見落とした実例

2026-08-22 に「10 pass / 1 fail（Build）」の PR を、fail を目視で見落として
マージし develop のビルドを壊した。

## 6-3 既存の揺れが再発したときの担当

2026-11-04 の run で、`WorktreeDetailRefactored.test.tsx` の TC-3 が PR と develop で計 4 回落ちた。#4117 由来のテストの窓で、再実行で流している間に develop が赤になり、#4133 のワーカーが直した（負荷下 30 回で確認）。

再実行が効くのは最初の 1 回だけにする（#4148）。**同じテストが同じ run でもう一度落ちたら（PR でも develop の push でも）、再実行をやめて担当を決める**:

1. 由来を見る: `git log -S '<テスト名>' -- <テストのファイル>` で入れた PR を探し、run の記録と summary に、テスト名・落ちた回数・由来を書く
2. 担当を上から順に決める:
   - そのテストかその対象のファイルを scope に持つ、この run のワーカー → そのワーカーへ再指示する
   - 無ければ、次にマージする PR のワーカー。契約の scope にテストのファイルを足して再指示する（#4133 の形。PR 本文に「既存の揺れで、この PR の変更が原因ではない」と書く）
   - 走っているワーカーがいなければ、オーケストレーターが利用者に報告して追跡の Issue を提案する（起票は了承を得てから）
3. develop の push の CI がそのテストで赤なら、直るまで次のマージを止める

修正は負荷をかけて確かめる（直す前に落ちる条件で複数回）。1 回の緑では揺れが直った証拠にならない。

## 6-4 一本化のコミットと scope ゲート

**一本化のコミットには trailer `Orchestrator-Fold: module-reference` を付ける**（例: `git commit -m 'docs(module-reference): #<N> の断片を本体へ写す' --trailer 'Orchestrator-Fold: module-reference'`。trailer が無いと、再指示の後の scope ゲートが一本化を範囲外として落とす）。`docs/module-reference.md` だけを変え、この trailer を持つコミットだけが触ったパスは、その後にワーカーへ再指示しても `verify --task` の scope ゲートが差分から除くので、それを理由に exit 20 にはならない（#3588）。trailer の無いコミット（ワーカーの単独コミットを含む）や未コミットの変更が同じファイルを触った場合は、今までどおり範囲外として落ちる。merge コミット自身の編集は、`docs/module-reference.md` の中なら承認済みの統合（develop の取り込みで衝突を機械解決したもの）として除き、それ以外のファイルの編集はワーカーの変更として scope で判定する。`merge-pr.mjs` が一本化を越えて作業の HEAD を探す規則（`pr-common.mjs` の `workHeads`）は trailer を求めず、変えたファイルに加えて、そのコミット自身の `verify` の記録と、マージなら自動マージとの差も見る（定義は [run-log.md 1-5](./run-log.md#1-5-記録の中身と-next-の決まり)）。

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

書き込みの `gh`（`pr create` / `pr merge` / `run rerun` / `issue close`）は 1 回だけ送る（`ghWrite`）。504 は「GitHub が処理を終えたが応答が届かなかった」こともあるので、送り直すと PR が 2 本立つ・同じ HEAD の run を 2 回 rerun することがありうる。5xx・接続エラーで失敗したときは送り直さず、読み取りで 1 回確かめる: `pr create` はブランチの open な PR が今の HEAD を指しているか、`pr merge` は PR が `MERGED` で head が今の HEAD か、`run rerun` は run の試行番号（`gh run view <id> --json attempt`。送る前に読んでおく）が増えたか（status は見ない。`completed` は再実行の前にも、受理された再実行が確かめるまでに終わった後にもなる。送る前に試行番号が読めなかったときは受理と判断しない）、`issue close` は Issue が `CLOSED` か。済んでいれば stderr に `— not sent again; it went through` を出して成功として続け、済んでいない（または確かめる読み取りも失敗した）ときは `— not sent again; it did not go through` を出して今までどおり失敗で止まる。HEAD ごとに rerun は 1 回の制御（`ci` の段の `rerun=`）は変わらない。
