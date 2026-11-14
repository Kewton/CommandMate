# WIP の上限 — 管理元のブランチ以外の未マージのブランチ数で新しい作業を止める（Issue #4368）

- Epic: #4371（エージェントのチームの流れの計測と制御）の子 2
- 正本: Issue #4368 の本文、Epic #4371 の本文（背景の実測）、段 3 の共通の枠と突き合わせの決定 X1〜X10（開発リーダー、2026-11-14）
- 事実の出典: `origin/develop` = `a334a013f`（2026-11-14 時点）。`file:line` はすべてこのコミットで取った。行番号は古くなるので、実装では名前で探し直すこと
- 改訂 2 は、再レビュー（P2 6 件、うち 5 件が同じ種類の 2 回目）と原因調査（`enabler-return-4368-cause.md`）を受けたリーダーの処分（推奨 M1 を採る）を反映した。対応の一覧は §15
- 改訂 3 は、再レビュー 3 の R7（見送りが後段・再開で送信の対象へ戻る）と R8（二つの不在は不成立の証明にならない）へのリーダーの処分（狭めて塞ぐ）と、PR1 の実装で分かった実コードとの差を反映した。対応の一覧は §15.1a

## 0. 目的と結論（先に）

2026-11-13 は「同時のワーカー 5」が依頼文の約束だけで守られず、未マージのブランチが 20 本を超えた（Epic #4371）。作る速さがマージの速さを超えないよう、WIP の上限を仕組みで守る。

改訂 1 は、ロック・受付の記録・継続の早道・札（token）を足して、管理する入口で上限を強制しようとした。再レビューと原因調査で、共通の原因が **「操作の許可に要る証拠を、その一部を表す値（持ち主の pid・ブランチ名・過去の記録・札・終了コード）で代用したこと」** と分かった。ロックの寿命と外部の操作の寿命、今の tip と作業の世代、観測したブランチと実際に push する SHA、操作の結果と後始末の結果が分かれていない。局所の値を足すたびに、次の段で保証しない部分が残る。

そこで（リーダーの処分、原因調査の M1）:

1. **PR1（この run）は、数える（`count`）・助言の照会（`check`）・その実際の読み手である orchestrate の手順だけ**にする。`check` は「新しい在庫（未マージのブランチ）を 1 本増やす前に、今回の観測で余裕があるか」の照会で、送信・PR の作成の許可証ではない。出力にもそう書く
2. launch-worker・publish-pr・`/worktree-setup` への組み込み、ロック、受付の記録、継続の早道、札は **PR1 に入れない**
3. 強制の受付（ロック・未確定の操作・世代・実際の対象・後始末の例外を含む 1 つのプロトコル）は **PR2** の条件と表として §9 に書く。Issue の受入条件「上限ちょうどで断られ、マージで 1 本減ると通る」は **PR2 で満たす**。H9 の (b)（ロック）の決定も PR2 へ移る
4. PR1 の保証は弱い（§2.3 保証の範囲）。同時の照会どうしの上限は保証しない。PM への報告はリーダーが行う
5. 数え方（C の定義・マージの証明・完全性）と #4367 への提供（X8・X9）は保つ

## 1. 用語と数え方

| 記号 | 意味 | 取り方 |
|---|---|---|
| root | 設定を読むリポジトリの主 worktree。**指定した worktree（既定は cwd）の** `git rev-parse --path-format=absolute --git-common-dir` の親。root そのものを指定する引数は作らない | `git` |
| `repo` | `owner/name`。#4367 の読み手 `readFlowConfig` が設定か `origin` から決める（X1） | `scripts/flow/config.mjs` |
| `base` | 管理元のブランチ。#4367 の読み手が決める（共通の枠 §2） | 同上 |
| `E` | 除外の一覧（共通の枠 §2 の `exclude`。既定は main / master と base 自身）。完全一致だけ | 同上 |
| `W` | root の `git worktree list --porcelain` のうち、ブランチを持つもの（detached は入れない）。各要素は `{ path, branch, head }` | `git` |
| `P` | `repo` の、`base` へ向いた **開いた** PR の head。fork からの PR は `<owner>:<branch>` を鍵に別のものとして数える | `gh pr list --state open --base <base>` |
| `M` | マージ済みの証明が取れた W のブランチ（§1.1） | §1.1 |
| **C** | 未マージのブランチ = `(branches(W) ∪ P) \ E \ M` | 合成 |
| `unknown` | マージ済みかの証明の手続きが失敗したブランチ。C に数える | 合成 |
| `complete` | 定義した取得の範囲（W・P・各枝の M の証明）がすべて成功し、`unknown` が空のとき真。偽のとき `C` の本数は上側の数（X8）。**同じ瞬間の世界の写し（snapshot）や、後の操作の予約を意味しない**（W・P・base の読みはトランザクションではない） | 合成 |
| 観測の開始・終了 | `count` / `check` が最初の外部の読みを始めた時刻と、最後の読みが戻った時刻（ISO）。出力に必ず載せる | 時計 |

### 1.1 マージ済みの証明（計数のための証拠）

ブランチ `b`（W にあり、`P` に無い）の `tip` は、`git -C <path> rev-parse HEAD` で読んだ値（観測した tip）。マージの照会の **前と後で 2 回**読み、違えば `b` は `unknown`。

1. **PR による証明**: 次の条件をすべて満たす PR が **1 本でも存在する**こと。
   - `state = MERGED`、`baseRefName = base`、`isCrossRepository = false`（fork の同名ブランチの PR は証明にしない）、`headRefName = b`、`headRefOid = tip`
   - 取り方: まず `gh pr list --repo <repo> --state merged --base <base> --limit 300 --json number,headRefName,headRefOid,baseRefName,isCrossRepository,mergedAt` の窓から探す（存在の証明なので、窓が全体でなくても見つかれば正しい）。見つからなければ `gh pr list --repo <repo> --head <b> --base <base> --state merged --limit 100 --json …` で探す。後者が失敗・時間切れ・件数が `--limit` と同じ（切り詰め）なら `b` は `unknown`
   - `pr-common.mjs` の `prsOfBranch`（`:272-284`）は使わない。base で絞らず、新しい順に 1 本ずつしか返さない
2. **祖先による証明**: `tip` が `origin/<base>` の祖先（`git merge-base --is-ancestor`、exit 0）で、かつ `origin/<base>` の SHA が GitHub の今の base の SHA と一致すること（`gh api repos/<repo>/branches/<base> --jq .commit.sha`、読みだけ）。一致しない・読めないときは使わない。fetch はしない
3. どちらでも証明できなければ C に数える。手続きが失敗したものは `unknown` にも載せる

この証明は **「今の tip がマージ済みか」の計数のためだけ**に使う。「過去のある作業の世代が終わったか」（継続の判定）には使わない（原因調査 §3.2。PR2 の世代の証拠は §9.2 で別に定める）。

### 1.2 数え方の補足

- **保留中のブランチも数える**（Issue の仕様。在庫も WIP）。数えたくないものは `exclude` に名指しする
- マージ済みの PR のブランチでも、マージの後に先端が進んだもの（`headRefOid ≠ tip`）は数える
- 閉じた（マージしていない）PR のブランチは、worktree が残っていれば数え、消えていれば数えない
- 「登録された worktree」ではなく「ディスク上の worktree」を数える（`sync` の前の worktree が漏れないため。§12 H2）
- `active`（動いているブランチ）は PR1 では数えない（常に `null`）。`listSessions`（`src/lib/tmux/tmux.ts:386-415`）が例外を空の一覧に畳み、`GET /api/worktrees` の `isSessionRunning: false` は取得の成功を証明しないため（`src/app/api/worktrees/route.ts:149`・`:160-169`）。生死の完全な読みは PR2a

## 2. 不変条件

### 2.1 最上位（原因調査 §5 の 3 文。強制の受付＝PR2 のプロトコルが満たすもの）

1. **強制受付は、権威ある root / repo / base・実パス・送り先 branch・操作する固定 SHA または契約・作業世代に結び、実操作直前と後段の消費時にその内容が一致しない許可を使わず、現在の計数証拠と継続世代の証拠を混用しない。**
2. **増分は観測済みの占有と同じ占有を二重計上しない未確定受付を含めて判定し、操作開始前から結果の反映または不成立が証明されるまで未確定分を失わず、親・子の死や一覧の不在だけで受付を解放しない。**
3. **副作用前の拒否・開始後の結果不明・操作成功・後始末失敗を別の結果として返し、全自前外部呼出しは同じ期限に対する正の有効予算がある時だけ開始し、期限切れや release 例外で送信済みの結果を未開始／再実行可能へ上書きしない。**

**M1 の境界**: PR1 の `check` はこの強制の受付を行わず、後の操作への許可・予約を出さない。上の 3 文を実装していない観測に、強制の受付と同じ保証を付けない。

### 2.2 PR1 の不変条件

1. **P1 読むだけ。** `count` / `check` は操作（worktree の作成・送信・push・PR・停止・登録）を呼ばず、ファイル・ロック・記録を書かない。外部の呼び出しは §6.1 の読みの許可表にあるものだけ
2. **P2 照会の意味は 1 つ。** `check` の答えは「今回の観測で、新しい在庫を 1 本増やす余裕があるか」だけ。`complete` な観測で `|C| ≥ total` なら 60、`|C| < total` なら 0、`complete` でなければ 61（`unknown` を含む上側の数を、正確な満杯・余裕と混ぜない）、設定の誤りは 2。off は 0 で、出力に `off` と書く
3. **P3 許可証にしない。** `check` の 0 は助言で、出力に「許可・予約ではない」と書く。送信・PR の作成の可否を答える gate（改訂 1 の `--gate send` / `--gate pr`、W にあるから増分 0、継続の早道）は作らない
4. **P4 数えられないときに 0 と言わない。** 全体の取得の失敗は `count` / `check` とも 61（`count` の JSON は `ok: false`）。取得の失敗を空の一覧に畳まない
5. **P5 1 本ずつの不明は数える側。** 1 本のマージの判定だけが不明なら、C に入れて `unknown` に載せ、`complete: false`
6. **P6 off の `check` は何も解決しない。** `flow.yaml` が無い・`wip` 節が無いとき、`check` は git の共通 dir と設定ファイルを読む以外に何もしない（GitHub・サーバー・base の解決を呼ばない）。`count` は明示の計数の要求なので、off でも repo / base を解決して数えてよい（解決できなければ 2）
7. **P7 期限。** すべての自前の外部呼び出しは、同じ絶対の締め切り（単調時計の `deadlineMono`）から計算した残りを **整数 ms に切り下げ、1 以上のときだけ**開始する（`spawnSync` は `timeout` が正のときだけタイマーを張る。原因調査 §3.4）。0 以下なら呼ばずに時間切れ。締め切りを延ばさない（呼び手がより短い締め切りを渡したらそれ）。締め切りの後に返った結果は捨てる。読みの再試行は 0 回
8. **P8 設定は root から。** 設定は root の `.commandmate/flow.yaml` だけから読む（対象の作業ツリーの設定を読まない）
9. **P9 手順は 0 以外で新しいレーンを始めない。** orchestrate の手順は、計画の段（1-5）で `check` が 0 以外のとき、その Issue と worktree の無い残りの新しいレーンの候補すべてを `assign.tsv` に入れない。よって worktree の作成・launch・登録・tasks.tsv の行・wait は始まらない。run の記録（`run-log.mjs`）に見送りを書かない（`contract` の `skip` は通過扱いで、`status` が `next=send` と読む。R7）。冷間起動の再送・停止にも落とさない（§4.2）
10. **P10 既存を弱めない。** launch-worker・publish-pr・merge-pr・`/worktree-setup`・検証ゲートは PR1 で変えない（共通の枠 §5）
11. **P11 数え方は 1 つ。** C を数える純関数は 1 つで、`check` と計測（#4367）が同じものを呼ぶ（X8）

### 2.3 保証の範囲（PR1）

- **保証すること**: 定義した取得の範囲について、完全に取れた観測で C を数え、上限との比較を正しく答えること。数えられないときに 0 と言わないこと。手順が 60 / 61 / 2 で新しいレーンを始めないこと
- **保証しないこと**:
  - **同時の受付の上限。** 2 人（2 つのリーダー、同じ run の並べた手順）が同じ空きを観測して各々 0 を受け取り、両方が worktree を作れば上限を超える（§11.5 T10 で、この限界を固定する試験を置く。強制の合格試験にはしない）
  - `check` の後の交代（観測の後に別の誰かがブランチを足す・マージする）
  - 手順を通らない操作（普通の `send`、直接の `git worktree add`・`git push`・`gh pr create`、手順の外での `/worktree-setup`）
  - 既存の在庫の消化（再指示・2 本目の契約・PR の作成・マージ）は `check` の対象ではない（増分 0 の操作を止めない、という約束は、照会しないことで守る）
- この弱さは意図した選択（原因調査 §7・M1）。強制の保証は PR2 で提供する。PM への報告はリーダーが行う

## 3. 状態と遷移の表

### 3.1 `check` の判定

| 設定 | 取得 | 観測 | verdict | exit | 出力（標準エラー） |
|---|---|---|---|---|---|
| `flow.yaml` 無し・`wip` 無し | 取らない（P6） | — | off | 0 | `wip: off (no limit configured). advisory only.` |
| `wip` が不正（`active` を含む）・`repo` / `base` を決められない | — | — | config-error | 2 | 設定の誤りと場所 |
| 有効 | 全体が失敗・時間切れ・切り詰め・形の誤り | — | unknown | 61 | `source` と理由 |
| 有効 | 取れた | `complete: false`（枝の `unknown` あり） | unknown | 61 | 上側の数と `unknown` の枝 |
| 有効 | 取れた | `complete`、`|C| ≥ total` | full | 60 | 数・上限・古い順の枝 |
| 有効 | 取れた | `complete`、`|C| < total` | room | 0 | 数・上限・「助言で、許可・予約ではない」 |

### 3.2 手順（orchestrate 1-5 の計画）の新しいレーンの状態

改訂 3（R7 の処分）: 照会は計画の段（1-5、`assign.tsv` を書く前）で **1 回だけ**行う。2-2 の bash・`assign.tsv` の後の書き換え・run の記録には組み込まない。

| 今の状態 | 出来事 | 次の状態 | 手順がすること |
|---|---|---|---|
| 新しいレーン候補（worktree が無い Issue） | `check` = 0（room）、残りの空き `total − |unmerged|` > 0 | 計画に入る | `assign.tsv` に入れ、空きを 1 減らす。続いて既存の 2-2 以降 |
| 新しいレーン候補 | `check` = 0（off） | 計画に入る | `assign.tsv` に入れる（上限なし） |
| 新しいレーン候補 | `check` = 0 だが空きを使い切った | 見送り | `assign.tsv` に入れない。plan.md の「見送り」に Issue・担当・モデル・理由（`room 使い切り`） |
| 新しいレーン候補 | `check` = 60 | 見送り | その Issue と **残りの新しいレーン候補すべて**を `assign.tsv` に入れない。plan.md の「見送り」に Issue・担当・モデル・理由（`wip=60 n/total`） |
| 新しいレーン候補 | `check` = 61 | 見送り | 同上（理由 `wip=61 <source>: <reason>`）。`source` の読みが戻ってから次の計画で照会し直す |
| 新しいレーン候補 | `check` = 2・1・コマンドが動かない | 見送り | 同上（理由 `wip=<exit> …`）。0 以外を作る側へ落とさない |
| 見送り | 次の計画（1-5） | 新しいレーン候補 | `check` をやり直してから候補へ戻す。run の記録の `next` からは戻さない |
| 既存の worktree がある Issue（再開・2 本目の契約） | — | 既存の手順 | 照会の結果にかかわらず `assign.tsv` に入れる（増分 0） |

- 見送った Issue は `assign.tsv` に無いので、2-2 は worktree を作らず、3-1 は launch せず tasks.tsv に行を書かず、3-3 は待たない（3-1・3-3 は `assign.tsv`・tasks.tsv の全行を読む、§4.1）
- run の記録に見送りを書かないので、`run-log.mjs status` は見送った Issue を `next=send` と読まない（記録が無い Issue は run の対象に現れない）

## 4. 照会の置き場所と手順

### 4.1 なぜ 1-5 だけか

- 未マージのブランチ（在庫）が増えるのは、新しいレーンの worktree を作る時（W に 1 本足す）。3-1 の契約の送信は、既に W にある worktree に送るので C を増やさない。6-1 の PR の作成も、既に W にあるブランチの PR なので C を増やさない
- よって `check` の読み手は orchestrate の **1-5（計画の記録、`assign.tsv` を書く前）** だけにする（改訂 3、R7）。計画の段では worktree をまだ作らないので、1 回の照会の `total − |unmerged|` を、この計画で入れてよい新しいレーンの本数の上限にする（同じ計画の中で照会を繰り返しても、まだ作っていない worktree は W に現れないため）
- 3-1・6-1 は変えない（launch-worker・publish-pr は 60 / 61 を返さない）。改訂 1 で 3-1 の分岐に書く予定だった 60 / 61 の扱いは、PR1 では要らない（再送に読み替えられる入口が無い）
- 事実: 2-2 は `.claude/commands/orchestrate.md:312-331`（`/worktree-setup` か手動の `git worktree add`、`:324`）。`assign.tsv` は 1-2b で書かれ（`:296`）、3-1 のループが読む（`:707-728`）。3-1 は RC にかかわらず tasks.tsv に行を書き（`:727`）、3-3 は tasks.tsv の全行を wait-verify へ渡す（`:799-805`）。よって **見送った Issue を `assign.tsv` から外さないと、3-1 が worktree の無い Issue を launch し、tasks.tsv に行ができ、3-3 が待つ**。P9 の「行を作らない」は、見送る Issue を最初から `assign.tsv` に入れないことで満たす（改訂 2 の「2-2 で外す」は、外し忘れた候補が 3-1 に残る経路があった。R7 の反例 B）

### 4.2 orchestrate.md 1-5 に書くこと

```bash
node scripts/orchestrate/flow-wip.mjs check --worktree . --json > "workspace/orchestration/runs/$DATE/wip.json"; WIP=$?
```

- 本体は、照会の 1 行と「新しいレーンを `assign.tsv` に入れる前に 1 回だけ。2-2・3-1・run の記録では呼ばない」「0 は助言（許可・予約ではない）。0 以外は新しいレーンを入れず plan.md の『見送り』へ」と参照だけにする。`必ず守ること` に 1 行（1-5）。2-2 は「`assign.tsv` の各 Issue（見送りは除く）」と書き直す
- 詳細（空きの計算の bash、入れ方、見送りの書き方、再開、保証の範囲、設定）は `docs/orchestrate/workers.md` の節「1-5 WIP の照会」に、終了コードは `docs/orchestrate/exit-codes.md` の節「1-5 flow-wip check の 60 / 61 / 2」に書く
- **バイト数**: orchestrate.md は 107,998 バイトで、目標 108,000 バイト（`tests/unit/docs/orchestrate-size-headroom-4276.test.ts`）まで残り 2 バイト。2-2 の手動の代替（`git worktree add` と `npm install --include=dev` と根拠の行）を `docs/orchestrate/workers.md` の節「2-2 worktree を手動で作る」へ、3-1 の冷間起動の実測の文を `docs/orchestrate/exit-codes.md` の「3-1 冷間起動の失敗 exit 99」へ移して空けた（実装後 107,934 バイト）
- `.claude/commands/` の写し（`.agents/`）は無い（2026-11-14 に `find` で確認）

### 4.3 手順に書かないこと

- 2-2 の worktree の作成の前の照会と、`assign.tsv` の後からの書き換え（改訂 3。計画の段で入れないことに一本化する）
- run の記録への見送りの行（`--stage contract --result skip` は通過扱い。R7 の反例 A）
- 3-1 の launch-worker の前の照会（3-1 は在庫を増やさない）
- 6-1 の publish の前の照会（同上）
- `/worktree-setup` の中の照会（`/worktree-setup` は 1-5 の照会の後の 2-2 で呼ばれる。中に置くと手順の外で使ったときの強制のように読まれるが、強制ではない）

## 5. 終了コードと出力

### 5.1 終了コード

既存の番号（`origin/develop` で確認）:

| 番号 | 使い手 |
|---|---|
| 0 / 1 / 2 / 3 / 4 / 5 / 99 | `ExitCode`（`src/cli/types/index.ts:10-35`）。merge-pr.mjs も 3 / 4 |
| 10 / 11 / 124 | `WaitExitCode`（`:239`） |
| 11 / 12 / 13 | `SkillExitCode`（`:647`） |
| 20 / 21 | `VerifyExitCode`（`:275`） |
| 30 | `InterruptExitCode`（`:680`） |
| 31 / 32 | `RoleExitCode`（`:702-709`） |
| 40 / 41 | `StrictRespondExitCode`（`:289`）。launch-worker.mjs も 40〜45（`launch-worker.mjs:105-112`） |
| 50〜57 | `MemExitCode`（`:911`）・`MEM_EXIT_BY_CODE`（`src/types/mem.ts:233`） |

`flow-wip.mjs` の番号（X4 で決定済みの帯）:

| exit | `check` | `count` |
|---|---|---|
| 0 | room（余裕あり）または off | 数えた（`complete` の真偽は JSON に） |
| 60 | full（`complete` で `|C| ≥ total`） | 使わない |
| 61 | 判定できない（取得の失敗・時間切れ・切り詰め・形の誤り・`complete: false`） | 数えられない（全体の取得の失敗） |
| 2 | 使い方・設定の誤り | 同左 |
| 1 | 想定外の例外 | 同左 |

PR1 では 60 / 61 を返すのは `flow-wip.mjs` だけで、launch-worker・publish-pr は返さない。62〜69 は #4369・#4370 が使うなら同じ帯を提案する。

### 5.2 出力

- 標準エラー（人と手順が読む。英語）:
  - 60: `WIP full for <repo> (base <base>): <n>/<total> unmerged branches, observed <start>–<end>. Advisory only — not a permit or reservation. Do not start a new lane; merge existing work first. Unmerged: <最大 5 本の枝の名前>.`（改訂 3: 古さの順は W・P に時刻が無いので断定しない。観測の順で並べる）
  - 61: `WIP could not be judged for <repo> (base <base>): <source>: <reason>. Advisory only. Do not start a new lane; check <source>, then run check again.`
  - 0（room）: `WIP room for <repo> (base <base>): <n>/<total>, observed <start>–<end>. Advisory only — not a permit or reservation; another lane may take it.`
- 標準出力（`--json` のときだけ、1 行）: `{ verdict, advisory: true, repo, base, total, unmerged, unknown, excluded, complete, observedFrom, observedTo, source?, reason? }`。`count --json` は `{ ok, repo, base, unmerged, active: null, unknown, excluded, complete, observedFrom, observedTo }`

## 6. 外部の呼び出しごとの失敗の倒れ方

### 6.1 読みの許可表と倒れ方

締め切り: `--deadline-sec`（整数 1〜3600、既定 120 秒、§12 U3）か呼び手の `deadlineMono`（単調時計 `performance.now()` の絶対の締め切り。#4367 の読み手と同じ時計。改訂 3）の短い方。各コマンドの上限は `git` 10 秒・`gh` 30 秒で、残りとの短い方を整数 ms に切り下げ、1 以上のときだけ開始（P7）。`spawnSync` に `timeout` と `killSignal: 'SIGKILL'`。`pr-common.mjs` の `defaultRun`（`:58-67`、時間切れなし）と `withGhRetry`（`:143`、再試行あり）は使わない。

| 呼び出し | 呼ぶ者 | 使う所 | 失敗・時間切れ | 部分的な成功 | 倒れ方 |
|---|---|---|---|---|---|
| `git rev-parse --path-format=absolute --git-common-dir` | flow-wip | root | exit 2 | — | 止める |
| `flow.yaml` の生の読み（`readRawFlowConfig`） | config.mjs | off の判定 | 無い → off。EACCES・壊れた YAML・64 KB 超 → 2 | — | 無い = 何もしない |
| `readFlowConfig`（`git remote get-url`・`symbolic-ref` などは読み手の中。#4367 の `runBounded` を同じ `deadlineMono` で渡す） | config.mjs | repo・base・exclude | 2。読み手の時間切れ（`identification timed out`）は 61 | — | 止める（設定の誤り） |
| `git worktree list --porcelain` | flow-wip | W | 61 | `branch` 行の無い塊（detached）→ 数えない。`worktree` 行の無い塊 → 61 | fail-closed |
| `git rev-parse HEAD`（各 W、照会の前後 2 回） | flow-wip | tip | その枝は `unknown` | 前後で違う → `unknown` | 数える側 |
| `gh api repos/<repo>/branches/<base>`（GET） | flow-wip | 祖先の鮮度 | 祖先の証明を使わない | — | 数える側 |
| `git rev-parse --verify origin/<base>` | flow-wip | 祖先の鮮度 | 祖先の証明を使わない | — | 数える側 |
| `git merge-base --is-ancestor` | flow-wip | 祖先 | 0 = 祖先、1 = でない、それ以外・時間切れ → `unknown` | — | 数える側 |
| `gh pr list --state open --base <base> --limit 1000` | flow-wip | P | 61 | 件数 = `--limit` → 61。欄の欠け・型の誤り・途中で切れた JSON → 61 | fail-closed |
| `gh pr list --state merged --base <base> --limit 300` | flow-wip | M の窓 | 窓を使わず枝ごとへ | — | 存在の証明だけ |
| `gh pr list --head <b> --base <base> --state merged --limit 100` | flow-wip | M の枝ごと | その枝は `unknown` | 切り詰め → `unknown` | 数える側 |
| tmux・サーバー API・ロック・ファイルの書き込み | — | — | **呼ばない**（P1） | — | — |

- `flow-wip.mjs` が自分で呼ぶ `git` は `rev-parse`・`worktree list`・`merge-base` の 3 種、`gh` は `pr list` と GET の `api` だけ（`isGhRead`、`pr-common.mjs:119` が真）。#4367 の読み手が中で呼ぶものは読み手の許可表に従う（区別して試験する、§11.3 R9）
- 同期のローカルの読み（`flow.yaml` は 64 KB まで）の無期限の停止は保証の外（#4367 の I-12 と同じ）

### 6.2 数えられないときに止めるか通すか

`check` は判定できなければ 61 で、手順は新しいレーンを始めない（fail-closed）。理由: GitHub か git が答えないときはマージも進まないので、作業を足しても溜まるだけ。既存の在庫の消化は `check` を呼ばないので止まらない。

## 7. 設定（`.commandmate/flow.yaml` の `wip` 節）

```yaml
# 共通のキー（#4367 の読み手 scripts/flow/config.mjs が持つ）
base: develop
exclude: [main, agent-health-runner]
# この Issue の節（PR1）
wip:
  total: 8      # 未マージのブランチ（C）の上限。整数 1〜1000
# active は PR2a まで受け付けない
```

- 読む順: (1) root を決める → (2) `readRawFlowConfig(root)`（YAML の解析と `wip` の形の検査だけ。remote・base・GitHub を呼ばない）。無い・`wip` が無い → `check` は off → (3) `wip` が有る（または `count`）ときだけ `readFlowConfig(root, { runBounded, env, deadlineMono })`（#4367 PR1a の実際の API。改訂 3）
- 検査: `wip.total` は整数 1〜1000（小数・文字列・`NaN`・`Infinity`・0 以下・範囲外は 2）。`wip.active` は「PR2a で足すキー」として名指しで 2。`wip` の中の知らないキーは 2
- 値は既定に持たない（このリポジトリの値は §12 H1。コードに埋めない）

## 8. 既存の仕組みの再利用の可否

| 既存 | 再利用 | 理由 |
|---|---|---|
| `scripts/flow/config.mjs`（#4367 PR1a） | **使う・広げる** | X1・X6・X9。`wip.total` の許可、`wip.active` の拒否、`readRawFlowConfig` |
| `scripts/orchestrate/pr-common.mjs` の `isGhRead`（`:119`） | 使う | 読みだけの検査 |
| 同 `withGhRetry`・`defaultRun`・`prsOfBranch`・`DEFAULT_REPO`・`DEFAULT_BASE_BRANCH` | 使わない | 再試行・時間切れなし・最新 1 本だけ・固有の値（§6.1・§1.1） |
| `scripts/orchestrate/machine-lock-sync.mjs` | **PR1 では使わない** | PR1 にロックを入れない。PR2 の強制の受付で、子のプロセスグループ（`pgid`、`holderState` `:349-355`）と未確定の操作の記録と一緒に使う（§9） |
| `scripts/orchestrate/run-log.mjs` | **使わない**（改訂 3） | `contract` の `skip` は通過扱いで、`summarize` が `next=send` を返す（R7 の反例 A）。見送りは plan.md の「見送り」に書く |
| `scripts/orchestrate/launch-worker.mjs`・`publish-pr.mjs`・`merge-pr.mjs` | 変えない | P10 |
| `src/lib/metrics/vibe-metrics.ts`・`commandmate report metrics` | 使わない | ブランチ・PR を見ない |
| `GET /api/worktrees`（`isSessionRunning`） | 使わない | §1.2 |

## 9. PR の切り方と、PR2 の強制の受付の条件

### 9.1 PR の切り方

| PR | 中身 | 依存 |
|---|---|---|
| **PR1（この run）** | `flow-wip.mjs`（`count`・助言の `check`）、`config.mjs` の `wip.total` と `readRawFlowConfig`、#4367 の読み手の試験の更新（X9）、読み手の手順（orchestrate.md 1-5・`docs/orchestrate/workers.md`・`exit-codes.md`） | #4367 PR1a のブランチから切る（X6） |
| PR2a | セッションの生死の完全な読み（`listSessions` の失敗を区別）と `wip.active` | PR1 |
| PR2b | **強制の受付のプロトコル**（§9.2〜§9.6）と、その最初の入口 1 つ。Issue の受入条件（上限ちょうどで断られ、マージで 1 本減ると通る）をここで満たす | PR1。§9.6 の再開条件 |
| PR2c | 残りの入口（送信・PR の作成）と製品の `POST /api/worktrees/[id]/tasks`・`send` の 60 / 61・`FlowExitCode` | PR2b |
| PR3 | 数の API（`GET /api/repositories/[id]/flow/wip`）と画面の「WIP n/上限」（#4367 の画面） | PR1 |
| PR4 | Skill のインストールの PR の受付（§12 H7） | PR2c |

PR1 は 1 本（改訂 1 の 1a / 1b の分割は、launch / publish を外したので要らない）。

### 9.2 PR2b の受付の対象と世代（最上位の 1 文目）

- 受付は次の内容に結び付ける: root・repo・base、操作の種類、実パス（worktree）、送り先のブランチ、**操作する固定 SHA（push・PR）または契約のパスと内容のハッシュ（送信）**、作業の世代
- **作業の世代**: 「受付の後に、そのブランチの作業が一度終わったか」を、計数の証拠（§1.1 の今の tip）と別に判定する。受付の時の tip を記録し、(a) その tip を head とする MERGED の PR が受付の後にある、(b) reflog の **イベントの時刻**（`%gd` の日付の形・`%gs` の `branch: Created from`。`%ct` はコミットの日時なので使わない）で受付の後に作り直しがある、のどちらかなら世代は終わり。reflog の欠け・期限切れ・同じ秒で順序が分からないときは「継続を証明しない」（新しい作業として扱う）
- 実操作の直前と後段の消費の時に、受付の内容と実際の対象（push する SHA、送る契約、パス、ブランチ）を権威ある所から読み直して照合し、一致しなければ使わない（2）。publish の `--branch` と push する固定 SHA（`publish-pr.mjs:181`・`:188`・`:252`、`pr-common.mjs:224-226`）は W のブランチ名ではなく、この照合で結ぶ（原因調査 §3.3）

### 9.3 PR2b の未確定の受付（最上位の 2 文目）

状態（受付 1 件）:

| 状態 | 入る出来事 | 数え方 | 抜ける出来事 |
|---|---|---|---|
| 意図 | 判定で通した直後、実操作の前に永続の記録を書く（ロックの中） | 未確定として数える | 実操作の開始 |
| 開始済み | 子のコマンドを始めた（持ち主に子の `pgid` を記録） | 未確定として数える | 子の終了 |
| 外部の結果待ち | 子が戻った（成功・失敗・不明） | 未確定として数える | C に現れた／不成立が証明された |
| 反映済み | 同じ占有が C に現れた（同じ repo・base・ブランチ・SHA） | C の側で数える（二重に数えない） | 終わり |
| 不成立 | 当該の操作・受付 ID に対応する **確定した拒否・不実行の結果**があり、その作用が今後成立しないと示せる（改訂 3、R8） | 数えない | 終わり |
| 不明 | 上のどちらも証明できない | 未確定として数える。次の受付は 61 に狭めてよい | 人の確認か、反映・不成立の証明 |

- 親の死・子の死・一覧に無いことだけでは受付を外さない。ロックの回収（持ち主の死）と受付の解放は別の判断
- **二つの不在は不成立の証明にならない**（R8）。PR の一覧に head SHA の PR が無い・remote の参照に push が無い、を締め切り内に完全に読めても、それは観測した時点で結果が見えないことの証拠であり、要求が確定して拒否されたこと・今後成立しないことの証拠ではない。この場合は「不明」に残して数え、次の受付は 61 に狭めてよい

| 観測 | 分類 | 数え方 |
|---|---|---|
| 一覧・参照が完全に読めて陰性（今の不在） | 不明 | 未確定として数える |
| 子が終わった・親が死んだ | 不明（生死と要求の状態は別の軸） | 未確定として数える |
| 当該の受付 ID の操作が確定して拒否された（例: 締め切りで止めて子を起こしていない記録、操作のコマンドが副作用の前に失敗を返した記録） | 不成立 | 数えない |
| 同じ占有が C に現れた | 反映済み | C の側で数える |

- PR2b の対照: 結果不明の要求があり、照合の時点の一覧・参照はまだ陰性、その後に外部の結果が見えてくる順序を与え、完全な陰性の応答だけで未確定分を消す版を赤にする。陰性対照は、当該の要求について確定した不成立を得て枠を解放できる場合
- 判定の式: `|C| + |未確定のうち C に現れていないもの| + Δ > total` なら断る（`Δ` は §9.2 の対象と世代で決める）

### 9.4 PR2b の結果の分け方と期限（最上位の 3 文目）

| 段 | 結果 | 返すもの | 呼び手の扱い |
|---|---|---|---|
| 副作用の前 | 上限 | 60「何も始めていない」 | 新しい受付を止める |
| 副作用の前 | 判定できない（取得・ロック・期限） | 61「何も始めていない」 | 読みが戻ってから照会し直す |
| 開始の後 | 失敗が確定 | 操作の既存の失敗コード | 既存の扱い |
| 開始の後 | 結果不明（期限切れを含む） | 別の結果（60 / 61 を流用しない） | 再実行しない。照合を待つ |
| 成功 | 成功 | 操作の既存の成功（task ID・PR 番号） | 既存の扱い |
| 成功の後 | 後始末（release・記録の追記）の失敗・例外 | 成功のまま。警告と健康の印を残す | 再実行しない（`machine-lock-sync.mjs:1269-1275` の release の例外を、呼び手の `catch`（`launch-worker.mjs:639-641`）で exit 1 にしない） |

- 期限: すべての自前の外部呼び出しは、同じ絶対の締め切りに対して正の残り（整数 ms ≥ 1）があるときだけ始める。ロックの待ちも同じ締め切りに含め、ロックの後に締め切りを取り直さない。開始の後の期限切れは「結果不明」で、「何も始めていない」にしない
- ロックの部品の中の `ps`（`processStartMs`、`machine-lock-sync.mjs:118-119`）は時間切れを持たないので、実時間の保証の外と明記するか、部品を変える別の Issue にする

### 9.5 PR2c の札（token）と後段の消費（W8・R6）

- 札は受付の内容（§9.2）を権威ある所で引ける ID とし、後段は札の文字列ではなく **内容と実際の対象**を照合する。同じ操作の再試行は同じ札で 1 回だけ消費し、別の操作への再利用は 2
- 登録（`send.ts:1038-1050`）の前の拒否は「何も始めていない」、前段が起動した後の拒否は `not_sent` と既に起きた副作用の一覧（`sideEffects`）。2 つを同じ結果にしない
- 札が無効（回収・期限切れ）でも、生きた前段が同じロックを持っていれば待つ。無条件に受け付け直さない

### 9.6 PR2b の再開条件（原因調査 §8 の末尾）

対象と世代の証拠・操作の前の未確定の意図・観測済みの C との重複の排除・外部の結果不明の照合・後段の札の消費・操作の後の結果の保持を **1 つの表**にしてから、最初の強制の入口を選ぶ。推奨の最初の入口は worktree の作成（在庫が実際に増える所。§12 U6）。publish を最初にするなら「1 回の書き込みだから回復は要らない」を根拠にしない（push・upstream・PR の作成・記録の段がある、`publish-pr.mjs:245-291`）。

PR2b の試験は原因調査 §6 の T1〜T9 を全部含める: 親 gone・子 alive の未確定、結果不明の後の可視化、作り直しの reflog の生の文字列、受付→マージ→新しいコミット、push する SHA と W の在籍の組、内側の照会の直前の期限 −1 ms／0／+1 ms、ロックの後の締め切り、操作の後の release の非 released と例外、生きた正しい札での別の対象。

ロックの名前（PR2b）: `[A-Za-z0-9.-]` の外の文字と `_` 自身を `_XX` に置き換える（単射）。repo は小文字に正規化。全体が 200 バイトを超えたら末尾を SHA-256 の先頭 16 桁に置き換える。

## 10. この run で実装する PR1 の範囲（実装の契約にできる粒度）

### 10.1 変更するファイル（scope.allow）

| ファイル | 新規 / 変更 | 内容 |
|---|---|---|
| `scripts/orchestrate/flow-wip.mjs` | 新規 | 10.2 の関数と CLI（`count`・`check`） |
| `scripts/flow/config.mjs` | 変更 | `wip` をキーとして許可し `wip.total`（整数 1〜1000）を検査、`wip.active` を「PR2a」と名指しで拒む、`readRawFlowConfig(root)`。`readFlowConfig` の結果に `wip` を足すのは節があるときだけ（F1）。WIP の名前を export しない（`cli-4367.test.ts` の「scripts/flow/ は WIP の読み手を export しない」を保つ） |
| `tests/unit/scripts/flow/config-4367.test.ts` | 変更 | I6 の `wip` の行の期待を「`wip: 1` は形の誤りとして `#4368` を名指して拒む」に更新（X9。行は消さない）。F1〜F6 を足す |
| `tests/unit/scripts/orchestrate/flow-wip-4368.test.ts` | 新規 | §11.1〜§11.5 |
| `tests/unit/scripts/orchestrate/orchestrate-md-calls.test.ts` | 変更（追加のみ） | §11.6（1-5 の呼び出しを `parseArgs` に通す、読み手が 1-5 だけ、文の固定） |
| `.claude/commands/orchestrate.md` | 変更 | 1-5 に照会、`必ず守ること` に 1 行、2-2 を「見送りは除く」に、2-2 の手動の代替と 3-1 の冷間起動の実測を docs へ移す。108,000 バイト以下 |
| `docs/orchestrate/workers.md` | 変更 | 節「1-5 WIP の照会」と、移した節「2-2 worktree を手動で作る」 |
| `docs/orchestrate/exit-codes.md` | 変更 | 節「1-5 flow-wip check の 60 / 61 / 2」と、移した冷間起動の実測 |
| `changelog.d/4368.md` | 変更 | 既存の 1 項目へ統合 |

- 改訂 3 で、改訂 2 の `tests/unit/scripts/orchestrate/orchestrate-wip-2-2-4368.test.ts`（2-2 の bash を偽のコマンドで動かす試験）は作らない（R7 の処分。読み手を 1-5 に移し、2-2 に bash を置かないため）。文と呼び出しの試験で固定する
- 変えないもの: `scripts/orchestrate/launch-worker.mjs`・`publish-pr.mjs`・`merge-pr.mjs`・`run-log.mjs`・`machine-lock-sync.mjs`・`.claude/commands/worktree-setup.md`・`src/**`・`tests/setup.ts`。ロックの root・`~/.commandmate` の下へ書かない

### 10.2 `flow-wip.mjs` の形（JSDoc の型。scripts は TS を import しない）

```js
/** @typedef {{ path: string, branch: string | null, head: string | null }} WorktreeRow */
/** @typedef {{ number: number, headRefName: string, headOwner: string | null, isCrossRepository: boolean, baseRefName: string, headRefOid: string, mergedAt?: string }} PrRow */
/** @typedef {{ repo: string, base: string, exclude: string[], worktrees: WorktreeRow[], openPrs: PrRow[],
 *   merged: Record<string, 'proved' | 'not-proved' | 'unknown'>, observedFrom: string, observedTo: string }} WipInput */
/** @typedef {{ unmerged: string[], active: null, unknown: string[], excluded: string[], complete: boolean }} WipCount */

export function countWip(input)                  // 純関数（X8）
export function readWipInput(root, { run, deadlineMono, wallNow, repo, base, exclude })
                                                 // { ok: true, input } | { ok: false, source, reason }。例外を投げない（生の git / gh の出力を自分で解析する）
export function decideCheck({ count, total })    // { verdict: 'room'|'full'|'unknown', exit }（P2）。off は呼び手が先に決める
export function makeRunner({ spawnSync, monoNow }) // (cmd, args, { capMs, deadlineMono, cwd }) → { status, code, stdout, stderr, called, timedOut, skipped }。残り < 1 ms なら呼ばずに skipped（P7）。許可表（isAllowedWipCall）の外は呼ばずに refused
export function parseArgs(argv)
export function main(argv, deps = {})            // exit code
export const EXIT_WIP_FULL = 60
export const EXIT_WIP_UNKNOWN = 61
// readRawFlowConfig(root) は scripts/flow/config.mjs に置く
```

CLI:

```
node scripts/orchestrate/flow-wip.mjs count [--worktree <path>] [--deadline-sec <n>] [--json]
node scripts/orchestrate/flow-wip.mjs check [--worktree <path>] [--deadline-sec <n>] [--json]
```

- `--worktree` の既定は cwd。root はそこから決める（P8）。`--gate`・`--branch`・`--wt`・`--add`・ロック・op の引数は無い（あれば 2）
- `admit`・`add-worktree`・`hasContinuation`・受付の記録・札は作らない

### 10.3 受入基準（PR1）

1. `check`: `total = 3`、完全な観測で C が 3 本 → exit 60、2 本 → exit 0。3 本のうち 1 本の PR を squash でマージした生の `gh` の出力（`headRefOid = tip`・同じ base・同じリポジトリ）を与えると 2 本に減り exit 0
2. `check`: 枝の `unknown` が 1 本でもあれば（上側の数が上限未満でも）exit 61。全体の取得の失敗・時間切れ・切り詰め・形の誤りは 61
3. `check` は出力（標準エラーと `--json`）に、助言であること（`advisory: true`、"not a permit or reservation"）と観測の開始・終了を必ず書く
4. off（`flow.yaml` 無し・`wip` 無し）の `check` は exit 0、`off` と表示し、`gh`・`remote get-url`・`symbolic-ref` の呼び出しが 0 回
5. `count` は off でも数え、`{ ok, unmerged, active: null, unknown, excluded, complete, observedFrom, observedTo }` を返す
6. `count` / `check` はファイル・ロックを書かず、`git worktree add`・`push`・`gh pr create`・`commandmate send` を呼ばない（呼び出しの列と、一時 HOME・一時ロックの root の dir が空のままであることで確かめる）
7. マージの証明（§11.2 の E 行）がすべて生の出力から判定される
8. 期限（§11.4 の D 行）: 残りが 1 ms 未満では子を始めない
9. `.claude/commands/orchestrate.md` が 108,000 バイト以下。照会の呼び出しは 1-5 の 1 か所だけで `parseArgs` を通り、2-2・3-1・3-3 に無い。0 以外で新しいレーンを `assign.tsv` に入れず plan.md の「見送り」に Issue・担当・モデル・理由を書くこと、run の記録に見送りを書かないこと、再開は次の計画の照会から、が本体・workers.md・exit-codes.md に書かれている（改訂 3）
10. `wip.active` は 2（「PR2a」）。#4367 の読み手の試験の I6 の `wip` の行は「形の誤りとして名指して拒む」期待に変わり（`wip.total` の許可は F2）、`alerts` / `train` は今までどおり拒む
11. launch-worker・publish-pr・`/worktree-setup` のファイルが PR1 の差分に無い
12. `Kewton/CommandMate`・`develop` が `flow-wip.mjs` に無い（grep 0 件）

### 10.4 gates

- `lint`・`typecheck`・`unit-related`（`node scripts/run-related-unit-tests.mjs --base origin/develop`、mutex `cpu.heavy`）。`cpu.heavy` の裁定を省かない。`src/` を触らないので `build-server` は要らない。`tests/setup.ts` は変えない
- ワーカーの確認（ゲートの代わりにしない）: `npx vitest run tests/unit/scripts/orchestrate/flow-wip-4368.test.ts tests/unit/scripts/orchestrate/orchestrate-md-calls.test.ts tests/unit/scripts/flow tests/unit/guards tests/unit/docs`、`node scripts/check-orchestrate-size.mjs`
- 試験は `run` を差し替え、**生の** `git worktree list --porcelain`・`gh … --json` の出力を与える（完成した verdict を純関数に渡すだけの試験で済ませない）。一時 dir は `fs.mkdtempSync(os.tmpdir())`、`HOME`・`CM_VERIFY_LOCK_ROOT` を一時 dir へ向けて `afterEach` で消し、変えた env は戻す
- 既存の試験の期待の反転は X9 の 1 行だけ（plan に「行の削除ではなく期待の更新」と書く）

## 11. 試験の表（PR1。it.each の行の形。実装はしない）

各表の「赤」は、1 つの防御を外した変異の実装で落ちることを示す。

### 11.1 数と照会（`countWip`・`decideCheck`・`main`）

| # | total | 観測 | 期待 | 赤（変異） |
|---|---|---|---|---|
| N1 | 3 | complete、C 2 本 | room / 0 | — |
| N2 | 3 | complete、C 3 本 | full / 60（上限ちょうど） | `>` で比べる |
| N3 | 3 | complete、C 5 本（超過） | full / 60 | — |
| N4 | 3 | C 3 本 → 1 本 squash でマージ | room / 0 | squash を数える |
| N5 | 3 | `unknown` 1 本、上側の数 2 | unknown / 61 | 上側の数で room |
| N6 | 3 | `unknown` 1 本、上側の数 3 | unknown / 61 | 上側の数で full |
| N7 | なし（off） | — | off / 0、`off` と表示 | off で数える |
| N8 | 3 | complete、C 3 本、`agent-health-runner` も W にある | 除外は数えない | 除外を数える |
| N9 | 3 | room | 出力に `advisory: true` と "not a permit or reservation" | 文言を落とす |
| N10 | — | `count`、off | 数える（`ok: true`） | off で数えない |

### 11.2 証拠（マージの証明。生の `gh` / `git` の出力から）

| # | 入力 | 期待 | 赤（変異） |
|---|---|---|---|
| E1 | W = c@X。MERGED（head c・base develop・X・同じリポジトリ）。祖先でない | 数えない | 祖先だけで判定 |
| E2 | W = c@Y。MERGED（c・develop・X） | 数える | tip を見ない |
| E3 | MERGED が 2 本: 新しい方は base main・X、古い方は base develop・X | 数えない | 最新 1 本だけ見る |
| E4 | MERGED が 1 本: base main・X | 数える | base を見ない |
| E5 | MERGED（fork の c・develop・X） | 数える | `isCrossRepository` を見ない |
| E6 | 窓に無く、枝ごとの照会で MERGED（c・develop・X） | 数えない | 窓だけ |
| E7 | 枝ごとの照会が切り詰め | 数える、`unknown = [c]` | 切り詰めを見ない |
| E8 | 祖先、`origin/develop` = GitHub の SHA | 数えない | — |
| E9 | 祖先、`origin/develop` ≠ GitHub の SHA | 数える | 鮮度を見ない |
| E10 | 祖先、GitHub の SHA が読めない | 数える | 読めないを一致と扱う |
| E11 | 照会の前後で `rev-parse HEAD` が違う | `unknown`、数える | 1 回だけ読む |

### 11.3 入力の完全性（`readWipInput`）

| # | 差し替える答え | 期待 | 赤（変異） |
|---|---|---|---|
| R1 | `git worktree list` が status 128 | `ok: false, source: 'git worktree list'` | 空の W に畳む |
| R2 | 開いた PR の読みが失敗 | `ok: false`、呼び出し 1 回（再試行 0） | 空の P に畳む／再試行 |
| R3 | 開いた PR の件数 = `--limit` | `ok: false, reason: 'truncated'` | — |
| R4 | 開いた PR の JSON に `headRefName` の欠けた行 | `ok: false, reason: 'shape'` | 形を見ない |
| R5 | 開いた PR の JSON が途中で切れている | `ok: false, reason: 'shape'` | — |
| R6 | `worktree` 行の無い塊 | `ok: false, reason: 'shape'` | — |
| R7 | `merge-base` が 1 本だけ status 128 | `ok: true`、その枝が `unknown` | 全体を不明／数えない |
| R8 | off の `check` | `gh`・`remote get-url`・`symbolic-ref` 0 回 | off でも解決 |
| R9 | 呼び出しの列 | `flow-wip.mjs` 自身の `git` は 3 種、`gh` は `isGhRead` が真のものだけ。読み手の呼び出しは別に数える | 書く呼び出しを足す |
| R10 | `--worktree` に linked worktree（主 root と別の親 dir） | 主 root の `flow.yaml` を読み、対象の作業ツリーの `flow.yaml`（上限 1000）は読まない | 対象から読む |

### 11.4 期限

| # | 状況 | 期待 | 赤（変異） |
|---|---|---|---|
| D1 | 内側の枝の照会の直前の残り −1 ms | 子 0 回、その枝 `unknown` | 0 以下でも呼ぶ |
| D2 | 残り 0 ms ちょうど | 子 0 回（`timeout: 0` を渡さない） | `timeout: 0` で無期限の子 |
| D3 | 残り 0.6 ms（切り下げで 0） | 子 0 回 | 切り上げ |
| D4 | 残り 1 ms | 子 1 回、`timeout: 1` | — |
| D5 | `gh` が戻らない（`timedOut: true`） | 61、`source` と `timeout` | 時間切れを渡さない |
| D6 | 締め切りの後に返った成功 | 捨てて 61 | 遅れた結果で room |
| D7 | 呼び手の `deadlineMono` が `--deadline-sec` より短い | 呼び手の締め切り | 取り直す・延ばす |
| D8 | 全体の取得が 61 の後 | 再試行の呼び出し 0 回 | 再試行する |

### 11.5 読むだけ・同時の限界

| # | 状況 | 期待 |
|---|---|---|
| T10 | 2 つの `check` が同じ観測（C 2 本、total 3）を見る | 両方 0。**保証の範囲の限界を固定する行**で、強制の合格試験ではない |
| T10b | `count` / `check` を 1 回ずつ | 一時 HOME・一時ロックの root の下にファイルが 0、呼び出しの列に書く操作（`worktree add`・`push`・`pr create`・`send`）が 0 |

### 11.6 手順（文と呼び出しの試験。改訂 3）

R7 の処分で、照会の読み手を 1-5 の計画の段だけにし、2-2 の bash・`assign.tsv` の後の書き換え・run の記録に組み込まない。2-2 の bash を偽のコマンドで動かす試験（改訂 2 の T11a〜T11f）は作らず、`orchestrate-md-calls.test.ts` に次を足す。

| # | 対象 | 期待 |
|---|---|---|
| T11a | 1-5 の bash | `bash -n` が通り、`flow-wip.mjs` の引数が `parseArgs` を通る（`check`・`--worktree .`・`--json`） |
| T11b | 本体 | `flow-wip.mjs check` の呼び出しは本体に 1 か所。2-2・3-1・3-3 に `flow-wip` が無い。`--note "wip=` が無い |
| T11c | 1-5・2-2 の文 | 「`assign.tsv` に入れる前に 1 回だけ」「0 以外は新しいレーンを入れず plan.md の『見送り』へ」、2-2 が「見送りは除く」 |
| T11d | workers.md の節 | bash が通り、0 以外で `ROOM=0`。「助言で、許可・予約ではない」「同時の照会の上限は保証しない」「Issue・担当・モデル」「次の計画（1-5）で `check` をやり直してから」「すべて `assign.tsv` に入れない」。run の記録への追記が無い |
| T11e | exit-codes.md の節 | 0・60・61・2・1 の行がある |

- 見送りの再開の実際の読み手（`run-log.mjs status`）は、見送りの記録を持たないので `next=send` を返さない。記録の行を足さないこと自体を T11b・T11d で固定する

### 11.7 設定の共有（#4367 の読み手）

| # | 入力 | 期待 | 赤（変異） |
|---|---|---|---|
| F1 | #4367 の設定だけ（`wip` なし） | #4367 の読みの結果が PR1 の前と同じ | 既存の検査を壊す |
| F2 | `wip: { total: 8 }` | 許可、結果に `wip.total = 8` | — |
| F3 | `wip: { total: 8, active: 5 }` | 2、「PR2a」を名指す | `active` を黙って無視 |
| F4 | `wip: { totl: 8 }`・`total: 0`・`1.5`・`"8"`・`.inf` | 2 | — |
| F5 | `alerts`・`train`（#4367 PR1a の時点） | 今までどおり 2 | 「wip を拒む」行を消して済ませる（改訂 3: I6 の行は残し、`wip: 1` を形の誤りとして拒む期待に変えた） |
| F6 | `readRawFlowConfig` | git の remote・GitHub を呼ばない | — |

## 12. 人の操作・人の判断（未決）

実機への導入（このリポジトリへの `flow.yaml` のコミット）はこの run の範囲外（X7）。GitHub の設定・launchd・ランナー・Docker の変更は要らない。

### 12.1 方針

| # | 判断 | 選択肢 | 推奨と理由 | 決める人 |
|---|---|---|---|---|
| H1 | このリポジトリの `wip.total` | (a) 8 (b) 10 (c) 5 | **(a)**。動いている 5（Epic の運用の約束）＋ PR 待ち 3。#4367 の計測で 1 週間見て見直す | 人 |
| H2 | 数える worktree の元 | (a) ディスク上 (b) 登録されたもの（Issue の文言） | **(a)**。作ってから `sync` までが漏れない | 人 |
| H3 | 動いている = 止まっていない待機中も含む（PR2a） | (a) 含む (b) 処理中・応答待ちだけ | **(a)** | 人 |
| H4 | PR を作る口の解釈（PR2c） | (a) 在庫を増やす PR だけ断る (b) すべて断る | **(a)**。(b) は減らす道を塞ぐ | 人 |
| H5 | 判定できないとき | (a) 止める (b) 通して警告 | **(a)** | 人 |
| H6 | 緊急の迂回 | (a) フラグを作らない（`flow.yaml` を人が変える） (b) `--override` | **(a)** | 人 |
| H7 | Skill のインストールの PR の受付（PR4） | (a) 掛ける (b) 掛けない | **(a)** | 人 |
| H8 | 開いた PR のあるブランチへの契約を active の上限から外すか（PR2a） | (a) 外さない (b) 外す | **(a)** | 人 |
| H9 | 同時の受付 | — | **決定済み（リーダー）: (b) ロック。ただし PR2b で、§9.3 の未確定の受付と一緒に**。PR1 は同時の受付を保証しない | 済み（PR2 へ移った） |
| G1 | PR1 の保証が助言にとどまること（§2.3） | — | 受け入れる（原因調査 M1）。Issue の受入条件は PR2b で満たす | リーダーが PM へ報告 |

### 12.2 未決

| # | 未決 | 推奨 | 決める人 |
|---|---|---|---|
| U2 | ロックの待ちの締め切り（PR2b） | PR2b の設計で、同じ絶対の締め切りの中に含める（§9.4） | リーダー（PR2b の設計時） |
| U3 | 取得の全体の締め切りの既定（`--deadline-sec`） | 120 秒（#4367 の取得の予算 200 秒より短い） | PM（#4367 の U4 と一緒に） |
| U4 | Issue の受入の active の段を PR2a まで延ばすこと | 延ばす | リーダー |
| U5 | 受付の記録の片付け（PR2b） | PR2b の設計で | リーダー |
| U6 | PR2b の最初の強制の入口 | worktree の作成（在庫が実際に増える所） | リーダー |

## 13. 他の子への約束（提供・利用）

### 13.1 提供する（#4368 → #4367）

- **WIP の数**（共通の枠 §3、X8）: `scripts/orchestrate/flow-wip.mjs` の
  - `readWipInput(root, { run, deadlineMono, wallNow, repo, base, exclude })` → `{ ok: true, input } | { ok: false, source, reason }`。使えない答えで例外を投げない。`deadlineMono` は呼び手の単調時計の絶対の締め切り（#4367 の `runBounded` と同じ時計。Date 系の時刻を渡さない）。`run` は `makeRunner` の戻り値。再試行 0 回。残り 1 ms 未満では子を始めない
  - `countWip(input)` → `{ unmerged: string[], active: null, unknown: string[], excluded: string[], complete: boolean }`
  - 単位は **repo × base**。#4367 は `complete` が真のときだけ `unmerged.length` を確定値として記録し、偽なら `null`（上側の数は別の欄で、警報の入力にしない）。`active` は PR2a まで常に `null`
  - `complete` は定義した取得の範囲の完全性で、同じ瞬間の写しでも予約でもない。計測の値を受付の許可に使わない
  - 第 2 段は `src/lib/flow/wip.ts` に写し、§11 の表を JSON にして両方の試験で読む
- **上限**: `wip.total` は #4367 の読み手の結果に入る（PR1 で足す）
- **強制の受付の API は PR1 では提供しない**（未確定の受付を含む上限の API は PR2b）

### 13.2 利用する（#4367 → #4368）

- `scripts/flow/config.mjs` の `readFlowConfig(repoRoot, { runBounded, env, deadlineMono })`（X1。#4367 改訂 2 の確定版の API。改訂 2 までの `{ run, env }` は旧版 9240bff の形）。#4367 PR1a の承認された版に固定して依存する。#4368 PR1 が変えること（X9、#4368 の scope に入れる）:
  1. `wip` を名指しで拒む扱いをやめ、`wip.total` を許可、`wip.active` を「PR2a で足す」として名指しで拒む
  2. `readRawFlowConfig(root)` を足す（YAML の解析と `wip` の形の検査だけ）
  3. `tests/unit/scripts/flow/config-4367.test.ts` の I6 の `wip` の行の期待を同じ PR で更新（行は消さない。`alerts`・`train` を拒む期待は残す）
- `flow` の記録の書き手（#4367）: PR1 では呼ばない

### 13.3 #4369・#4370 へ

- #4369（merge train）: マージは数を減らす操作なので、WIP の照会は train に掛けない。PR1 はロックを取らないので `merge/…` と干渉しない
- #4370（資源の配分）: active の上限（PR2a）は「同時のワーカーの数」で、#4370 の枠（機械の負荷）とは別。PR1 は launch-worker を変えないので、#4370 の launch-worker の中の順と干渉しない

## 14. 事実と見立て

### 14.1 事実（`origin/develop` = `a334a013f` で確認）

- `git worktree add` は製品のコードに無く、手順書（`.claude/commands/orchestrate.md:324`、`.claude/commands/worktree-setup.md:81`）にだけある
- orchestrate: `assign.tsv` は 1-2b で書く（`orchestrate.md:296`）。3-1 は `assign.tsv` を読み、launch-worker の RC と task の存在で `SENT` を決め（`:719-726`）、RC にかかわらず tasks.tsv に行を書く（`:727`）。`:739` は「exit 40〜44 以外は冷間起動の失敗に従って再送」。3-3 は tasks.tsv の全行を wait-verify へ渡す（`:799-805`）
- publish-pr は `run` を `withGhRetry` で包み（`:163`）、固定の SHA を `--branch` の名前へ push する（`:181`・`:188`・`:252`、`pr-common.mjs:224-226`）
- `prsOfBranch`（`pr-common.mjs:272-284`）は base で絞らず、新しい順に open と merged を 1 本ずつ返す。`defaultRun`（`:58-67`）は時間切れを渡さない
- `listSessions`（`src/lib/tmux/tmux.ts:386-415`）は例外を空の一覧にする
- `machine-lock-sync.mjs` の release はロックの dir の削除に失敗すると例外を投げる（`:1269-1275`）。`holderState` は `pgid` があればグループの生死も見る（`:349-355`）。`processStartMs` の `ps` は時間切れを持たない（`:118-119`）。launch-worker の `catch` は通常の例外を exit 1 にする（`launch-worker.mjs:639-641`）
- `.claude/commands/orchestrate.md` は 107,998 バイト、目標は 108,000 バイト（`tests/unit/docs/orchestrate-size-headroom-4276.test.ts:19`）
- #4367 の設計（改訂 1 の 9240bff）: 読み手は `scripts/flow/config.mjs` の `readFlowConfig(repoRoot, { run, env })`、PR1a は `wip` を exit 2 で拒み、その試験は `tests/unit/scripts/flow/config-4367.test.ts` の T1 の 8 行目（実装の時点では I6 の `wip` の行。API は改訂 2 の 8b3d5b1 で `{ runBounded, env, deadlineMono }` に変わった）
- Node の `spawnSync` は `timeout` が正のときだけタイマーを張る（原因調査 §3.4 が一次資料を確認。この設計ではその報告として引く）
- 2026-11-14 の実測（再取得していない）: このリポジトリの `git worktree list` は 24 行、develop へ向いた開いた PR は 1 本

### 14.2 見立て（未確認）

- `gh pr list --state merged` の `headRefOid` は、マージの時点の head の SHA（squash でも head ブランチの SHA）と見ている。PR1 の最初に、squash でマージした PR 1 本で確かめる（`gh pr view <N> --json headRefOid,mergeCommit`）。確かめるまで、この証拠だけで枝を C から外す実装を受け入れない
- 1-5 で 1 回照会し、空きの本数までしか新しいレーンを入れなければ、1 つの run の中では上限を超えない。超えるのは複数の run・リーダーが同時に計画したとき（§2.3）
- 枝ごとのマージの照会は W の本数だけ増える（このリポジトリで 20 本前後）。窓で多くが見つかると見ている

## 15. 改訂の対応

### 15.1a 改訂 3（再レビュー 3 の R7・R8、リーダーの処分「狭めて塞ぐ」、PR1 の実装）

| 指摘 | 処分 | 反映先 |
|---|---|---|
| R7 見送りが後段・再開で送信の対象へ戻る | 照会の読み手を 1-5 の計画の段だけにする。0 以外ならその Issue と worktree の無い残りの新しい候補すべてを `assign.tsv` に入れず、plan.md の「見送り」に Issue・担当・モデル・理由。run の記録（`contract` の `skip`）は使わない。再開は次の計画で照会し直してから。2-2 の bash の試験は作らず、文と呼び出しの試験で固定 | §2.2 P9、§3.2、§4、§8、§10.1、§10.3、§11.6 |
| R8 二つの不在は不成立の証明にならない（PR2b） | 不成立は当該の操作・受付 ID の確定した拒否・不実行の結果だけ。今の不在は不明に残す。表と対照を足す | §9.3 |
| 実装で分かった差: #4367 の読み手の API | `readFlowConfig(root, { runBounded, env, deadlineMono })`（単調時計）。`flow-wip` も同じ時計の `deadlineMono` で締め切りを持つ | §6.1、§7、§10.2、§13 |
| 実装で分かった差: full の表示の「古い順」 | W・P に古さの根拠の時刻が無いので、観測の順に最大 5 本の名前を出し、古さを断定しない | §5.2 |
| 実装で分かった差: 識別の時間切れ | 読み手の `identification timed out` は設定の誤り（2）ではなく判定できない（61） | §6.1 |

### 15.1 改訂 2（再レビューの R1〜R6、原因調査、リーダーの処分 M1）

| 指摘 | 処分 | 反映先 |
|---|---|---|
| R1 親の死と未確定の操作 | PR1 からロック・op を外し、PR2b の未確定の受付の表で条件にする | §0、§9.3、§2.1 の 2 文目 |
| R2 継続の世代 | PR1 から継続の早道・受付の記録を外す。PR2b で計数の証拠と世代の証拠を分け、reflog のイベントの時刻を使う | §1.1 の末尾、§9.2 |
| R3 publish の実対象 | PR1 は publish に組み込まない。PR2b で push する固定 SHA と送り先のブランチに結ぶ | §4.1、§9.2 |
| R4 期限の境界 | PR1 の取得に残す: 整数 ms に切り下げて 1 以上だけ、同じ締め切り、延ばさない。ロックの待ちは PR2b | P7、§6.1、D1〜D8、§9.4 |
| R5 release の例外 | PR1 にロックが無いので経路が無い。PR2b で成功の後の後始末の失敗を成功のままにする | §9.4 |
| R6 札 | PR2c の条件として、内容と実際の対象の照合・1 回の消費・前段の後の拒否の副作用 | §9.5 |
| P3（tasks.tsv・3-3、setup の任意 base、許可表、ロック名） | tasks.tsv は `assign.tsv` から外して 3-3 まで流す試験（T11f）。setup は PR1 で変えない。許可表は §6.1。ロック名は §9.6 | 各節 |

### 15.2 改訂 1（2-4-4 事前レビューの W1〜W8）

W3（active を PR1 から外す）・W4（マージの存在の証明）・W5（root と off）・W6（手順の 60 / 61 の扱い）・W7（期限）・X8・X9 は改訂 2 でも保つ。W1・W2・W8 の強制の部分は PR2 へ移した。

改訂の履歴: 2026-11-14 改訂 3 — 再レビュー 3 の R7・R8 の処分と PR1 の実装の差を反映（§15.1a）。2026-11-14 改訂 1 — 2-4-4 事前レビュー（P2 8 件）とリーダーの処分を反映。2026-11-14 改訂 2 — 再レビュー（P2 6 件）と原因調査を受けたリーダーの処分（M1）を反映し、PR1 を count と助言の check と orchestrate の手順に絞り、強制の受付を PR2 の条件と表へ移した。
