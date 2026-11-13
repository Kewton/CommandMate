# WIP の上限 — 管理元のブランチ以外の未マージのブランチ数で新しい作業を止める（Issue #4368）

- Epic: #4371（エージェントのチームの流れの計測と制御）の子 2
- 正本: Issue #4368 の本文、Epic #4371 の本文（背景の実測）、段 3 の共通の枠と突き合わせの決定 X1〜X10（開発リーダー、2026-11-14）
- 事実の出典: `origin/develop` = `a334a013f`（2026-11-14 時点）。`file:line` はすべてこのコミットで取った。行番号は古くなるので、実装では名前で探し直すこと
- 改訂 1 は 2-4-4 事前レビュー（P2 8 件: W1〜W8）とリーダーの処分を反映した。対応の一覧は §15
- この文書はコードを変えない。実装は §10 の PR1 から

## 0. 目的と結論（先に）

2026-11-13 は「同時のワーカー 5」が依頼文の約束だけで守られず、未マージのブランチが 20 本を超えた（Epic #4371）。作る速さがマージの速さを超えないよう、**数を増やす操作の、CommandMate が管理する入口**で上限を仕組みとして守る。

結論:

1. 数えるもの — 管理元のブランチ（`base`）へ未マージのブランチの集合 **C**。マージ済みは「同じリポジトリ・同じ base・観測した先端（tip）と `headRefOid` が一致する MERGED の PR が存在する」か「鮮度を確かめた `origin/<base>` の祖先」で決める。どちらも証明できなければ数える
2. 判定は **操作の後に実際に増える数（増分）** で行う。増分 0（数に入ったブランチの PR、同じブランチの作業の継続の契約）は通す。増分 1 で上限に達していれば断る
3. 管理する 3 つの入口（worktree の作成・契約つきの送信・PR の作成）は、判定から作成・起動の確定までリポジトリ × base ごとのロック `wip.<owner>.<repo>.<base>` を持つ（リーダーの決定 W1。同時の受付で上限を超えない）
4. 上限は exit 60、判定できない（入力の取得の失敗・時間切れ・ロックが取れない）は exit 61。どちらも既存の停止・Auto-Yes・タスク・送信・push を 1 つも始めない
5. 設定は `.commandmate/flow.yaml` の `wip.total`。無ければ何も読まず何も止めない。**動いているブランチの上限（`wip.active`）は PR1 では受け付けない**: セッションの生死を「取得が完全だった」と証明して読む口が今の製品に無い（W3、§6.2）。生死の完全な読みを足す PR2a の後に入れる
6. 第 1 段（この run の PR1）は `scripts/orchestrate/flow-wip.mjs` と呼び手（`/worktree-setup`・`launch-worker.mjs`・`publish-pr.mjs`・orchestrate の手順）。第 2 段で製品（`POST /api/worktrees/:id/tasks`・`send` の終了コード・API・画面）へ

## 1. 用語と数え方

| 記号 | 意味 | 取り方（第 1 段） |
|---|---|---|
| root | 設定とロックの名前を決めるリポジトリの主 worktree。**対象の worktree の** `git rev-parse --path-format=absolute --git-common-dir` の親（呼び手が root を指定する引数は作らない。W5） | `git` |
| `repo` | `owner/name`。#4367 の読み手 `readFlowConfig` が設定か `origin` から決める（X1） | `scripts/flow/config.mjs` |
| `base` | 管理元のブランチ。#4367 の読み手が決める（共通の枠 §2） | 同上 |
| `E` | 除外の一覧（共通の枠 §2 の `exclude`。既定は main / master と base 自身）。完全一致だけ | 同上 |
| `W` | root の `git worktree list --porcelain` のうち、ブランチを持つもの（detached は入れない）。各要素は `{ path, branch, head }` | `git` |
| `P` | `repo` の、`base` へ向いた **開いた** PR の head。fork からの PR は `<owner>:<branch>` を鍵に別のものとして数える | `gh pr list --state open --base <base>` |
| `M` | マージ済みの証明が取れた W のブランチ（§1.1） | §1.1 |
| **C** | 未マージのブランチ = `(branches(W) ∪ P) \ E \ M` | 合成 |
| `unknown` | マージ済みかの証明の手続きが失敗したブランチ。C に数える（I7） | 合成 |
| `complete` | 入力の全体が完全に取れ、`unknown` が空のとき真。偽のとき `C` の本数は上側の数（X8） | 合成 |
| `Δ` | 操作の後に C が増える数（0 か 1）。§4 の入口ごとに決める | 判定 |
| 受付の記録 | ゲートが `Δ = 1` の操作を通し、その操作が成功したときに 1 行書く記録（§5.3）。「同じブランチの作業の継続」の証拠 | `flow-wip.mjs` |

### 1.1 マージ済みの証明（W4）

ブランチ `b`（W にあり、`P` に無い）の `tip` は、判定の直前に `git -C <path> rev-parse HEAD` で読んだ値（観測した tip）。

1. **PR による証明**: 次の条件をすべて満たす PR が **1 本でも存在する**こと。
   - `state = MERGED`、`baseRefName = base`、`isCrossRepository = false`（同じリポジトリのブランチ。fork の同名ブランチの PR は証明にしない）、`headRefName = b`、`headRefOid = tip`
   - 取り方: まず `gh pr list --repo <repo> --state merged --base <base> --limit 300 --json number,headRefName,headRefOid,baseRefName,isCrossRepository,mergedAt` の窓から探す（存在の証明なので、窓が全体でなくても見つかれば正しい）。窓で見つからなければ `gh pr list --repo <repo> --head <b> --base <base> --state merged --limit 100 --json …` で探す。後者が失敗・時間切れ・件数が `--limit` と同じ（切り詰め）なら `b` は `unknown`
   - `pr-common.mjs` の `prsOfBranch`（`:272-284`）は使わない。base で絞らず、新しい順に 1 本ずつしか返さないので、別の base へのマージが正しい PR を隠す（W4）
2. **祖先による証明**: `tip` が `origin/<base>` の祖先（`git merge-base --is-ancestor`、exit 0）で、かつ **`origin/<base>` の SHA が GitHub の今の base の SHA と一致する**こと（`gh api repos/<repo>/branches/<base> --jq .commit.sha`、読みだけ）。一致しない・読めないときは祖先による証明を使わない（古い ref は base が巻き戻された・置き換えられたときに安全側と言えない。W4）。fetch はしない
3. どちらでも証明できなければ、`b` は C に数える。証明の手続きが失敗したものは `unknown` にも載せる

### 1.2 数え方の補足

- **保留中のブランチも数える**（Issue の仕様。在庫も WIP）。数えたくないものは `exclude` に名指しする
- マージ済みの PR のブランチでも、マージの後に先端が進んだもの（`headRefOid ≠ tip`）は新しい作業なので数える
- 閉じた（マージしていない）PR のブランチは、worktree が残っていれば数え、消えていれば数えない
- 「登録された worktree」ではなく「ディスク上の worktree」を数える。登録は `sync` の後でしか起きず（`.claude/commands/orchestrate.md:333-338` の 2-3）、作ってから `sync` までの worktree が漏れる。Issue の文言からの変更なので §12 H2 に残した
- `active`（動いているブランチ）は PR1 では数えない（常に `null`）。§6.2

## 2. 不変条件

**I0（最上位。2-4-4 事前レビューの 1 文）**: 同じリポジトリ / base と実際の操作対象について、完全性と鮮度が確認できた入力で増分と受付中の増分を判定し、上限を増やさない操作を妨げず、拒否時は既存の停止・Auto-Yes・task・送信・push を一切開始せず、許可後も既存の検証・前景・merge の条件を省略しない。

I0 を次に分ける。

1. **I1 増分で判定する。** 断るのは、`Δ = 1` で `|C \ {b}| ≥ total` の操作だけ。`Δ = 0` の操作（数に入ったブランチの PR、同じブランチの作業の継続の契約、普通の `send`、マージ、worktree の削除、セッションの停止、`sync`）は、上限を超えていても断らない。`Δ` が証明できないときは 1 とする（W2）
2. **I2 断ったら何も始めていない。** exit 60 / 61 / 2 のとき、worktree・タスクの行・Auto-Yes・セッションの停止と起動・モデルの書き込み・push・PR・受付の記録は 1 つも作られていない・変わっていない。ゲートは呼び手の最初の副作用の前に置く
3. **I3 上限ちょうどで断り、マージで 1 本減れば通る。** `|C| = total` の新しい worktree は断り、`|C| = total − 1` は通す
4. **I4 受付は直列。** 管理する 3 つの入口は、`Δ = 1` のとき、判定の前にロック `wip.<owner>.<repo>.<base>` を取り、操作の確定（§5.2）まで持つ。同時の 2 本が同じ「残り 1」を見て両方通ることはない（W1）
5. **I5 除外は数えない、除外は止めない。** `E` のブランチは C に入らず、`E` のブランチへの操作は断らない（ロックも取らない）
6. **I6 証明できないものを「無い」にしない。** マージ済みの証明が無いブランチは数える。入力の全体が取れないときは、ゲートは exit 61、計測には `complete: false`（X8。#4367 は本数を確定値として記録しない）。取得の失敗を空の一覧に畳まない
7. **I7 1 本ずつの不明は数える側。** 1 本のマージの判定だけが不明なら、そのブランチを C に入れて `unknown` に名を載せる。全体を不明にはしない
8. **I8 設定が無ければ何も読まない。** `flow.yaml` が無い・`wip` 節が無いリポジトリでは、ゲートは git の共通 dir を読む以外に何もせず（GitHub・サーバー・base の解決を呼ばない）、exit 0。既存の入口の挙動は変わらない（W5）
9. **I9 ゲートが書くのは自分の記録だけ。** GitHub・git・サーバーへ書かない。書くのはロックとロックの中の受付の記録（§5.3）だけ（`add-worktree` の `git worktree add` は呼び手の操作を代わりに行うもので、ゲートの判定の書き込みではない）。判定のための `git` は `worktree list` / `rev-parse` / `merge-base` / `remote get-url` / `reflog`、`gh` は読みだけ（`isGhRead`、`pr-common.mjs:119`）
10. **I10 設定と対象を結ぶ。** 設定は対象の worktree の git の共通 dir から決まる root から読む。実際の操作の宛先（publish の `--repo`）が設定の `repo` と違えば、副作用の前に exit 2（W5）
11. **I11 期限で必ず終わる。** 各コマンドに時間切れ、取得の全体に締め切りを持つ。時間切れは `source` つきの不明（exit 61）。締め切りの後に返った結果から pass を作らない。読みの再試行は 0 回（W7）
12. **I12 数え方は 1 つ。** C を数える純関数は 1 つで、ゲートと計測（#4367）が同じものを呼ぶ。第 2 段で TS へ写すときは同じ表（§11）を両方に流す
13. **I13 通した後は既存のとおり。** 通したとき、呼び手の既存の検査（publish の記録・マーカー・断片、launch のモデル・権限・ロール・前景、merge-pr の条件のすべて）と順序を変えない（共通の枠 §5）
14. **I14 保証の範囲。** 保証は **管理する入口を通る操作** について。普通の `send`（停止したブランチのセッションを起動しうる）、直接の `git worktree add`・`git push`・`gh pr create` は管理の外で、上限を超えうる。管理の外で作られたブランチは C に数えられ、次の管理する入口の判定に効く

## 3. 状態と遷移の表

### 3.1 ブランチの状態

| 今の状態 | 出来事 | 次の状態 | ΔC | 副作用 |
|---|---|---|---|---|
| （無い） | `add-worktree`（ゲートを通った） | 未マージ・受付済み | +1 | ロックの中で `git worktree add`、成功したら受付の記録 |
| （無い） | `add-worktree`（断られた） | （無い） | 0 | exit 60 / 61、何も作らない |
| （無い） | 直接の `git worktree add`（管理の外、I14） | 未マージ・未受付 | +1 | なし |
| 未マージ・受付済み | 契約つきの送信（継続の証拠あり） | 同じ | 0 | ロックを取らずに通す |
| 未マージ・未受付 | 契約つきの送信（ゲートを通った） | 未マージ・受付済み | 0（数は既に C にある。受付の判定では `Δ = 1` とみなす） | ロックの中で launch、送信が成功したら受付の記録 |
| 未マージ・未受付 | 契約つきの送信（断られた） | 同じ | 0 | exit 60 / 61、停止・起動・送信なし |
| 未マージ（W にある） | PR の作成 | 未マージ・PR あり | 0 | ゲートは通す（ロック・`gh` なし） |
| （W に無い） | PR の作成（ゲートを通った） | 未マージ・PR あり | +1 | ロックの中で push と `gh pr create` |
| （W に無い） | PR の作成（断られた） | （無い） | 0 | exit 60 / 61、push・PR なし |
| 未マージ・PR あり | PR が squash / merge でマージ（`headRefOid = tip`） | マージ済み | −1 | なし |
| マージ済み | 同じブランチに新しいコミット | 未マージ・未受付（受付の記録は §4.2 で無効） | +1 | なし |
| 未マージ | worktree を消す（PR なし） | （無い） | −1 | なし |
| 任意 | `exclude` に名指しされる | 除外 | 数えない | なし |
| 未マージ | マージの証明の手続きが失敗 | 未マージとして数える | 0 | `unknown` に名を載せる（I7） |

「受付済み」は C の数には影響しない。契約つきの送信の判定で、増分 0（継続）とみなせるかだけに効く（§4.2）。

### 3.2 ゲートの判定

| 設定 | 対象 | ロック | 入力の取得 | 判定 | 終了コード |
|---|---|---|---|---|---|
| `flow.yaml` 無し・`wip` 無し | 任意 | 取らない | 取らない（I8） | off | 0 |
| `wip` が不正（`active` を含む） | 任意 | 取らない | — | 設定の誤り | 2 |
| `wip` が有効、`repo` / `base` を決められない | 任意 | 取らない | — | 設定の誤り | 2 |
| 有効 | 除外、または `Δ = 0` が証明できた | 取らない | 早道の分だけ | pass | 0 |
| 有効 | `Δ = 1` | 締め切りまでに取れない・観測できない | — | unknown（source `wip-lock`） | 61 |
| 有効 | `Δ = 1` | 取れた | 全体が失敗・時間切れ・切り詰め | unknown（source つき） | 61（ロックを返す） |
| 有効 | `Δ = 1` | 取れた | 取れた、`|C \ {b}| ≥ total` | refuse | 60（ロックを返す） |
| 有効 | `Δ = 1` | 取れた | 取れた、超えない | pass | 0（操作の確定まで持つ） |

## 4. 止める入口（どこで判定し、何を返すか）

### 4.1 worktree を作る口

- **事実**: 製品のコード（`src/`）に worktree を作る処理は無い。`git worktree add` は手順書の中だけ — `.claude/commands/orchestrate.md:324`（2-2 の手動）、`.claude/commands/worktree-setup.md:81`（Phase 3）。製品は作られた worktree を `POST /api/repositories/sync`（`src/app/api/repositories/sync/route.ts:31`）で取り込むだけ
- **第 1 段の入口**: `node scripts/orchestrate/flow-wip.mjs add-worktree --branch <b> --dir <path> --from <base>`。ロックを取り、判定し、通れば **自分で** `git worktree add -b <b> <path> <base>` を実行し、成功したら受付の記録を書き、ロックを返す。判定から作成の確定までロックの中なので、別の入口が間に入らない（I4）
  - `Δ`: `b` が既にブランチとしてある（`git show-ref --verify refs/heads/<b>` が成功）なら、`-b` での作成を git が断るので使い方の誤り（exit 2）。それ以外は 1
  - `--from` が設定の `base` と違えば exit 2（W5。`/worktree-setup` は今 develop 固定で作る（`worktree-setup.md:63`・`:81`）。設定の base が develop でないリポジトリでは、`--from` を設定の base で渡すよう手順書を書く）
  - off のとき: ゲートは何も読まず、`git worktree add` だけを実行する（今までどおりの作成）
  - 終了コード: 0 作った、60 上限、61 判定できない、2 使い方・設定の誤り、1 `git worktree add` の失敗（受付の記録は書かない）
- **呼び手**: `.claude/commands/worktree-setup.md` Phase 3（`:66-83`）の `git worktree add` を `flow-wip.mjs add-worktree` に置き換え、exit が 0 でなければ Phase 4 以降（`npm install`・サーバー起動・同期）へ進まずに止める。既存の worktree を使い直す枝（`:77-79`）はゲートを呼ばない（`Δ = 0`）
  - `.claude/commands/orchestrate.md` 2-2 の手動の代替（`:321-331`）は消し、`/worktree-setup` だけにする（手動の `git worktree add` は管理の外になる。I14）。これでバイト数が減り、§4.2・§4.3 の手順の追記に回す（§10.1）。消す節の `--include=dev` の注意は `worktree-setup.md` の Phase 4（`:95-97`）に既にあり、失われない
- **`sync` は止めない**: 既にディスクにある worktree を登録しないと画面から消えるだけで、数は減らない（I1）

### 4.2 作業を送る口（契約つきの送信）

- **判定**（対象の worktree のブランチ `b`。`b ∈ E` なら通す）:
  1. **継続の証拠**（`Δ = 0`）: 受付の記録（§5.3）に、同じ `repo`・`base`・`b`・worktree の実パスの行があり、かつ次のどれにも当たらないこと — 記録の後に `b` が作り直された（`git reflog show --format=%ct%x09%gs refs/heads/<b>` の最後の `branch: Created from` の時刻が記録より新しい。reflog が読めなければ証拠なし）、記録の後に `b` が base へマージされた（§1.1 の PR の条件を満たし `mergedAt` が記録より新しい PR がある。読めなければ証拠なし）。証拠があればロックを取らずに通す
  2. 証拠が無い・読めない（新しい作業として扱う。W2）: ロックを取り、`|C \ {b}| ≥ total` なら断る
  - `b` は対象の worktree の今のブランチ（`git -C <worktree> rev-parse --abbrev-ref HEAD`）。サーバーの `--wt` の行の `path` の実パスが `--worktree` の実パスと違えば exit 2（W5。`<cli> ls --json`、読めなければ 61）
  - タスクの一覧（`task list`）は証拠にしない。worktree 単位で、ブランチや作業と結び付かない（W2。`src/cli/commands/task.ts:99-130`）
  - 普通の send（`--contract` 無し。再指示・人の send）はゲートの外（I14）
- **第 1 段の判定の場所**: `scripts/orchestrate/launch-worker.mjs` の `main`（`:490`）。`--instance` を解決した後（`:518-526`）、`contractArgs` を作る `:549` の直後、**最初の副作用の前**（Command Code の停止 `:566`、Claude の停止 `:576`、Auto-Yes の解除、モデルの書き込み、開始の文 `:585` のどれよりも前）
  - ロックを取ったときは、契約の送信 `sendTo('send', contractArgs)` が戻るまで持つ（W1）。モデルの確認で起動し直す分も含むので数分になる（§14.2）。ゲートはプロセスの中の関数（`admit`）で呼ぶ。別のプロセスではロックを送信の戻りまで持てない
  - 送信が exit 0 で **task ID が空でない**ときだけ受付の記録を書く。exit 0 でも task ID が空なら記録を書かず、launch-worker の結果も変えない（既存の `TASK_ID` の確かめ、`orchestrate.md:719-726`、は残す。W6）
  - 断ったら exit 60 / 61 / 2 をそのまま返す。標準出力には何も出さない（task ID だけ、の既存の約束）。案内は標準エラーへ
- **第 2 段**: §9.1（W8）

### 4.3 PR を作る口

- **判定**（ブランチ `b`）:
  - `b ∈ E`、または `b` が root の W にある（数に入っている）なら `Δ = 0`。ロックも `gh` も使わずに通す（I1）
  - それ以外は `Δ = 1`: ロックを取り、`|C| ≥ total` なら断る。通したら push と `gh pr create` が戻るまでロックを持つ
- **宛先との結び付け**（W5）: wip が有効なとき、publish の `--repo` が設定の `repo` と違えば exit 2（push の前）。`--base` が設定の `base` と違う PR は、管理する base の C を増やさないので `Δ = 0` として通す（このことを標準エラーに 1 行で言う）。publish の宛先を設定で書き換えることはしない
- **第 1 段の判定の場所**: `scripts/orchestrate/publish-pr.mjs` の `main`。既存の PR の読み（`:206` `prsOfBranch`）で `open` も `merged` も無いと分かった後、`problems` の判定（`:229`）の後、push（`:252`）の前。`open` がある・マージ済みのときはゲートを呼ばない（既存の早い return、`:207-210`・`:260-264`）
  - publish の既存の検査（記録・マーカー・断片・他の PR、`:212-231`）は WIP を通しても省かない（I13）。publish は WIP の前に `gh` を読むので、GitHub が落ちていれば WIP と関係なく既存の経路で止まる（ゲートの早道は「GitHub が落ちても publish が成功する」保証ではない）
  - ゲートは publish の `run`（`:163` で `withGhRetry` に包まれている）を使わず、**ゲート自身の runner**（§10.2 の `makeRunner`。時間切れつき・再試行なし）を使う（二重の再試行を防ぐ。W7）
  - 終了コードは今 0 / 1 / 2（`:35-36`）。60 / 61 を足す
- **第 2 段（製品）**: 製品で PR を作るのは Skill のインストールの PR だけ（`src/lib/skills/git-workflow.ts:900-907`）。掛けるかは §12 H7。画面と別の PR にする（§9）

### 4.4 入口にしないもの

| 操作 | 場所 | 理由 |
|---|---|---|
| `git branch` / 直接の `git worktree add` / 直接の `gh pr create` | git・gh | CommandMate から止められない（I14） |
| `POST /api/repositories/sync` | `src/app/api/repositories/sync/route.ts:31` | 既にあるものを見えなくするだけ（I1） |
| 普通の `send`・`respond`・`reply` | `src/cli/commands/send.ts` ほか | 再指示・人の操作。停止したブランチを起動しうるが、PR1 の保証の外（I14） |
| マージ（`merge-pr.mjs`） | `scripts/orchestrate/merge-pr.mjs` | 数を減らす操作。既存の refresh・precheck・必須チェック・base の移動・merge のロック・`--match-head-commit` は変えない |

## 5. 終了コード・ロック・受付の記録・案内文

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

新しい番号（X4 で決定済み）: **60 = WIP の上限**、**61 = WIP を判定できない**（入力の取得の失敗・時間切れ・切り詰め・ロックが締め切りまでに取れない・ロックを観測できない）。ロックが取れないことを別の番号にしない理由: 呼び手の扱い（原因が戻るのを待って判定し直す）が 61 と同じで、`source: wip-lock` で区別できる。62〜69 は #4369・#4370 が使うなら同じ帯を提案する（決めるのは各子）。

**呼び手の扱い（W6）** — 番号が空いていても、既存の手順の分岐に落ちると「再送」に読み替えられる。PR1 で手順に書く:

| 終了コード | 意味 | 呼び手（orchestrate の 3-1・6-1）がすること | してはいけないこと |
|---|---|---|---|
| 60 | 上限。何も始めていない | **新しい受付を止め、既存の消化（マージ）へ回る**。その Issue は `send` / `pr` の段を `fail` で記録し、マージが進んでから送り直す | 同じ送信の再送、冷間起動の手順（`orchestrate.md:739`）、stop / kill、wait / verify |
| 61 | 判定できない。何も始めていない | 標準エラーの `source` の読み（GitHub・サーバー・ロックの持ち主）が戻ったのを確かめてから、同じ呼び出しで判定し直す | 読みを確かめずに繰り返す、冷間起動の再送 |
| 0 で task ID が空 | 送れていない（既存） | 既存の `task MISSING` の扱い | 成功として受付に数える |

### 5.2 ロック（W1、リーダーの決定）

| 項目 | 決め |
|---|---|
| 名前 | `wip.<owner>.<repo>.<base>`。各部分の `[A-Za-z0-9_.-]` の外の文字は `_XX`（16 進）に置き換える（`feature/x` の `/` を衝突なく表す） |
| 置き場所 | `machineLockRoot(home)`（`scripts/orchestrate/precheck.mjs:523`、`CM_VERIFY_LOCK_ROOT` か `~/.commandmate/locks`）の下の専用の dir `wip/`。merge のロックが `merge/` を持つのと同じ理由（`merge-pr.mjs:812-823`: verify.yaml の `mutex` から触れられない）。`merge.*`・`cpu.heavy` は使わない |
| 部品 | `machine-lock-sync.mjs` の `acquireMachineLockSync(name, { root, timeoutMs, warn })`（`:1080`）。札の順・持ち主の記録（pid・host・token・acquiredAt）・観測の 3 値は部品のまま。持ち主の欄に `setOwnerFields({ gate, branch, issue, item })` |
| 取る時 | `Δ = 1` と決めた後、入力を読む前（読みと判定と確定を同じロックの中で） |
| 持つ間 | worktree: `git worktree add` が戻るまで。send: launch-worker の契約の `sendTo` が戻るまで。pr: `gh pr create` が戻るまで |
| 返す | `finally` で `release()`。`released` 以外の答えは標準エラーに 1 行 |
| 待つ締め切り | `--wip-lock-wait-sec`（既定 600 秒。§12 U2）。過ぎたら exit 61（`source: wip-lock`、`heldBy` を `describeOwner`（`:373`）で示す） |
| 観測できない | `acquired: false` で `unknown` あり（EPERM・EIO など）は取らずに exit 61 |
| 持ち主の死 | 同じ host で pid が ESRCH の持ち主は、次に取る者が部品の `holderGone` / `recoverLock`（`:450`・`:1003`）で回収する。自分で回収を書かない。死んだ持ち主の操作が途中まで進んでいても、次の判定は実際の状態（ディスクの worktree・開いた PR）を数えるので、C は正しい。受付の記録が無い分は「未受付」として厳しい側に倒れる |
| 期限 | ロックそのものに期限は付けない（持ち主が生きている間は持つ）。持つ間の長さは呼び手の操作の長さ。生きた持ち主が止まった（ハング）ときは待つ側が 61 を返し、人が持ち主の pid を見て止める |

### 5.3 受付の記録

- 場所: ロックと同じ dir の `wip.<…>.admitted.jsonl`。1 行 = `{ v: 1, repo, base, branch, worktree: <実パス>, gate, issue, item, at: <ISO>, by: <pid> }`
- 書く時: ロックを持っている間、操作が成功したと確かめた直後に 1 回の追記（worktree: `git worktree add` が exit 0。send: 送信が exit 0 で task ID が空でない。pr: PR の番号が取れた）
- 読む時: 契約つきの送信の継続の証拠（§4.2）。ロックの外で読んでよい（追記だけ。改行で終わらない最後の行は読まない）。読めない・壊れた行は無視する（証拠が減るだけで厳しい側）
- 大きさ: 1 行 300 バイト程度。片付けは §12 U5（第 1 段では消さない）

### 5.4 案内文（標準エラー、英語。既存の CLI の文に合わせる）

- exit 60: `WIP limit reached for <repo> (base <base>): <n>/<total> unmerged branches. Nothing was started. Do not resend: merge or close one first, then send again. Oldest: <古い順に最大 5 本: branch (#PR)>. Limit: <root>/.commandmate/flow.yaml (wip.total).`
- exit 61: `Could not judge WIP for <repo> (base <base>): <source>: <reason>. Nothing was started. Check <source> first, then run the same command again.`
- `--json`（`flow-wip.mjs` の CLI だけ）: 標準出力に `{ verdict, gate, repo, base, delta, unmerged, unknown, complete, total, source?, reason? }` を 1 行

## 6. 外部の呼び出しごとの失敗の倒れ方

### 6.1 表

締め切り: 各コマンドの時間切れは `git` 10 秒・`gh` 30 秒・`<cli>` 30 秒、ただし「全体の締め切りまでの残り」のほうが短ければそれ。全体の締め切りは呼び手が `deadlineAt` で渡す（既定は呼び出しから 120 秒。§12 U3）。`spawnSync` に `timeout` と `killSignal: 'SIGKILL'` を渡す（`pr-common.mjs:58-67` の `defaultRun` は時間切れを渡していないので、ゲートは自分の runner を持つ）。再試行は 0 回。締め切りの後の結果は捨てる（W7）。

| 呼び出し | 使う所 | 失敗・時間切れ | 部分的な成功 | 倒れ方 |
|---|---|---|---|---|
| `git rev-parse --git-common-dir`（対象から） | root | exit 2（git でない） | — | 副作用の前に止める |
| `flow.yaml` の生の読み（§7） | off の判定 | 無い → off。読めない（EACCES）・壊れた YAML・64 KB 超 → exit 2 | — | 無い = 今までどおり、壊れている = 止める |
| `readFlowConfig`（#4367、`wip` が有るときだけ） | repo・base・exclude | exit 2（base を決められない・origin が GitHub でない） | — | 止める（設定の誤り） |
| `git worktree list --porcelain`（root） | W | 失敗・時間切れ → 61 | `branch` 行が無い（detached）→ 数えない。`worktree` 行が無い塊 → 61（形が壊れている） | fail-closed |
| `git rev-parse HEAD`（各 W） | tip | 失敗 → その枝は `unknown`、数える | — | 数える側 |
| `gh api repos/<repo>/branches/<base>` | 祖先の鮮度 | 失敗 → 祖先の証明を使わない | — | 数える側 |
| `git merge-base --is-ancestor` | 祖先 | 0 = 祖先、1 = 祖先でない、それ以外・時間切れ → その枝は `unknown` | — | 数える側 |
| `gh pr list --state open --base <base> --limit 1000` | P | 失敗・時間切れ → 61 | 件数 = `--limit` → 61（切り詰め）。行の欄の欠け・型の誤り → 61 | fail-closed |
| `gh pr list --state merged --base <base> --limit 300` | M の窓 | 失敗・時間切れ → 窓を使わない（枝ごとへ） | 窓の外 → 枝ごとへ | 存在の証明だけに使う |
| `gh pr list --head <b> --base <base> --state merged --limit 100` | M の枝ごと | 失敗・時間切れ・切り詰め → その枝は `unknown` | — | 数える側 |
| `git reflog show refs/heads/<b>` | 継続の証拠 | 失敗・reflog 無し → 証拠なし | — | 新しい作業として扱う |
| `<cli> ls --json` | `--wt` と `--worktree` の結び付け（send） | 失敗・時間切れ → 61 | `--wt` の行が無い → exit 2 | fail-closed |
| ロック（§5.2） | 受付の直列 | 締め切り → 61、観測できない → 61 | — | fail-closed |
| 受付の記録の追記 | §5.3 | 失敗 → 標準エラーに 1 行、操作の結果は変えない | — | 証拠が無いだけ（次は新しい作業として扱う） |
| tmux・サーバーのセッションの一覧 | — | **使わない**（§6.2） | — | — |
| Docker・ランナー・launchd | — | 呼ばない | — | — |

- **数えられないときに止めるか通すか**: `Δ = 1` の操作は止める（fail-closed）。GitHub かサーバーが答えないときはマージも進まないので、作業を足しても溜まるだけ。`Δ = 0` と除外は入力を読まずに通すので、止まるのは新しい作業だけ
- **計測（#4367）へは**: 全体が取れなければ `ok: false`。1 本ずつの不明は C に数えて `unknown` に並べ、`complete: false`（X8）

### 6.2 セッションの生死を PR1 で使わない理由（W3）

- `listSessions`（`src/lib/tmux/tmux.ts:386-415`）は tmux の呼び出しの **すべての例外を空の一覧**にする（`:413-415`）。`GET /api/worktrees`（`src/app/api/worktrees/route.ts:149`）はその一覧からセッションの所有を決めて（`:160-169`、`src/lib/session/worktree-status-helper.ts:1133-1176`）`isSessionRunning` を返す
- つまり HTTP 200 の `isSessionRunning: false` は、tmux の一覧の取得が成功したことを証明しない。時間切れ・取得の失敗が「全部止まっている → 空きあり」になり、active の上限を素通りする
- PR1 は `src/` を変えないので、`false` を停止の証拠にできる読みが無い。よって PR1 は `wip.active` を設定の誤り（exit 2、「PR2a で足す」）として受け付けず、A を数えない。active の上限（Issue の 2 段目）は、`listSessions` の失敗を区別して返す読み（例: 一覧に `sessionsComplete: boolean` を付ける）を実呼び手（active のゲート）と一緒に足す PR2a の後
- 計測（#4367）にも `active: null` を渡す。0 にしない（X8）

## 7. 設定（`.commandmate/flow.yaml` の `wip` 節）

```yaml
# 共通のキー（#4367 の読み手 scripts/flow/config.mjs が持つ）
base: develop
exclude: [main, agent-health-runner]
# この Issue の節（PR1）
wip:
  total: 8      # 未マージのブランチ（C）の上限。整数 1〜1000
# active は PR2a まで受け付けない（§6.2）
```

- **読む順（W5・I8）**:
  1. root を対象の worktree の `--git-common-dir` から決める
  2. `<root>/.commandmate/flow.yaml` を **生で**読む（`readRawFlowConfig(root)`: YAML の解析と `wip` の形の検査だけ。git の remote・base・GitHub を呼ばない）。無い・`wip` が無い → off
  3. `wip` が有るときだけ `readFlowConfig(root, { run, env })`（#4367、`repo`・`base`・`exclude` を決める）
- 検査: `wip.total` は整数 1〜1000（小数・文字列・`NaN`・`Infinity`・0 以下・範囲外は exit 2）。`wip.active` は「PR2a で足すキー」として名指しで exit 2。`wip` の中の知らないキーは exit 2
- 値は既定に持たない（このリポジトリの値は §12 H1 で人が決めて書く。コードに埋めない）
- ゲートされる worktree の作業ツリーの `flow.yaml` は読まない（root だけ）。ワーカーが自分の worktree の設定で上限を上げられない

## 8. 既存の仕組みの再利用の可否

| 既存 | 再利用 | 理由 |
|---|---|---|
| `scripts/flow/config.mjs`（#4367 PR1a） | **使う・広げる** | X1・X6。`wip.total` を許可リストへ足し、`readRawFlowConfig` を足す（§10） |
| `scripts/orchestrate/machine-lock-sync.mjs` の `acquireMachineLockSync`（`:1080`）・`describeOwner`（`:373`） | **使う** | 受付の直列（§5.2、W1）。持ち主の記録・死の回収・観測の 3 値を部品のまま |
| `scripts/orchestrate/precheck.mjs` の `machineLockRoot`（`:523`） | **使う** | ロックの root を他のロックと揃える |
| `scripts/orchestrate/pr-common.mjs` の `isGhRead`（`:119`） | 使う | 読みだけの検査 |
| 同 `withGhRetry`（`:143`）・`defaultRun`（`:58`） | **使わない** | 再試行が締め切りを食う・`defaultRun` に時間切れが無い（W7。#4367 の F5・F6 と同じ判断） |
| 同 `prsOfBranch`（`:272`） | **使わない** | base で絞らず最新の 1 本しか返さない（W4） |
| 同 `DEFAULT_REPO`・`DEFAULT_BASE_BRANCH`（`:24`・`:26`） | 使わない | どのリポジトリでも使える形（共通の枠 §1） |
| `scripts/orchestrate/run-log.mjs` | 使わない（呼び手の手順が `send` / `pr` の段を書く既存のまま） | run の進捗の記録で、ブランチ・worktree を持たず、受付の証拠にならない |
| `scripts/orchestrate/merge-pr.mjs` | 変えない | 数を減らす側（I1） |
| `src/lib/metrics/vibe-metrics.ts`・`commandmate report metrics` | 使わない | タスク・検証の DB の集計で、ブランチ・PR を見ない |
| `GET /api/worktrees`（`isSessionRunning`） | **PR1 では使わない** | §6.2 |
| `scripts/agent-health/metrics-runners.ts` の `runCommand`（`:130-165`） | 使わない | TS で `@/lib` を import し、`.mjs` から使えない。非同期 |

## 9. PR の切り方

team.md §6-3（危険の境目で分ける）・§6-4（API は呼び手と同じ PR）に従う。

| PR | 中身 | 危険の境目 | 依存 |
|---|---|---|---|
| **PR1a（この run）** | `flow-wip.mjs`（数え方・入力の取得・判定・ロック・受付の記録・`count` / `check --gate pr` / `add-worktree`）、`config.mjs` の `wip.total` と `readRawFlowConfig`、#4367 の読み手の試験の更新（X9）、呼び手 `/worktree-setup` と orchestrate 2-2 | 手順の scripts と新しいロック。送信経路に触れない | #4367 PR1a のブランチから切る（X6） |
| **PR1b（この run）** | 呼び手 `launch-worker.mjs`（send）と `publish-pr.mjs`（pr）、orchestrate 3-1 / 6-1 の 60・61 の分岐、`docs/orchestrate/workers.md` | 送信経路（launch）と PR の作成 | PR1a |
| PR2a | セッションの生死の完全な読み（`listSessions` の失敗を区別する）と `wip.active`（呼び手: launch-worker の send のゲート） | 製品の tmux の読み。画面を入れない | PR1b |
| PR2b | 製品の送信経路: `POST /api/worktrees/[id]/tasks` のゲート、`send --contract` の exit 60 / 61、`FlowExitCode`、docs の ja / en。§9.1 の順 | 製品の送信経路 | PR1b（PR2a があれば active も） |
| PR3 | 数の API（`GET /api/repositories/[id]/flow/wip`）と呼び手（CLI `commandmate flow wip`・#4367 の画面の「WIP n/上限」） | 読みの API と画面 | PR2b |
| PR4 | Skill のインストールの PR のゲート（§12 H7 で掛けると決まれば） | 製品の書き込みの受付。画面と混ぜない | PR2b |

PR1a / PR1b に分けるかは §12 U1（リーダーが決める）。分けない場合も §10 の範囲は同じで、試験の表も同じ。

### 9.1 PR2b の順と結果（W8）

- **順**: (1) WIP の受付（`Δ` の判定とロック、または前段の受付の札の検証）→ (2) `--register` / `--role` の登録（`send.ts:1038-1050`）→ (3) タスクの行の作成（`tasks/route.ts:188`）→ (4) Auto-Yes・送信。WIP の判定を登録より前に置き、断ったときに登録を始めない
- **前段と後段**: launch-worker（前段）がロックを持ったまま `send` を呼ぶときは、受付の札（ロックの `token`）を `send` に渡し、サーバー（後段）は札の持ち主が生きていてロックがその札であることを確かめて数え直さない。札の無い `send --contract`（人の直接の送信）は後段が自分で数える
- **後段で断ったとき**: 応答は 409 / 503 と `sendOutcome: 'not_sent'` に加え、**既に起きた副作用の一覧**（`sideEffects: ['instance_registered', …]`）を返す。`not_sent` を「副作用なし」の証明として扱わない。CLI は exit 60 / 61 と、その一覧を標準エラーに出す。launch-worker が前段で起動したセッションは、後段の拒否のとき既存の `stopped(...)` で止め、止めたことを結果に書く
- **札の期限**: 札はロックの token。ロックが回収された（持ち主の死）札は無効で、後段は数え直す
- HTTP: 上限 409 `{ error, code: 'WIP_LIMIT_EXCEEDED', sendOutcome: 'not_sent', sideEffects, wip }`、判定できない 503 `{ error, code: 'WIP_UNKNOWN', sendOutcome: 'not_sent', sideEffects, wip }`（`tasks/route.ts:179-183` のロールの拒否と同じ形に `sideEffects` を足す）。`src/cli/types/index.ts` に `FlowExitCode = { SUCCESS: 0, WIP_LIMIT: 60, WIP_UNKNOWN: 61 } as const`

## 10. この run で実装する PR1 の範囲（実装の契約にできる粒度）

### 10.1 変更するファイル（scope.allow の案）

| ファイル | 新規 / 変更 | PR | 内容 | 見積り（行） |
|---|---|---|---|---|
| `scripts/orchestrate/flow-wip.mjs` | 新規 | 1a | 10.2 の関数と CLI | 650 |
| `scripts/flow/config.mjs` | 変更 | 1a | `wip.total` の許可と検査、`wip.active` を名指しで拒む、`readRawFlowConfig(root)` | 70 |
| `tests/unit/scripts/flow/config-4367.test.ts` | 変更 | 1a | 表 T1 の 8 行目（`wip` を拒む）の期待を「`wip.total` は許可・`wip.active` と `alerts` / `train` は拒む」に更新（X9）。行は消さない | 30 |
| `tests/unit/scripts/orchestrate/flow-wip-4368.test.ts` | 新規 | 1a | §11.1〜§11.5・§11.8 | 900 |
| `tests/unit/scripts/orchestrate/worktree-setup-wip-4368.test.ts` | 新規 | 1a | §11.6 の S 行（偽のコマンドで bash を実行） | 200 |
| `.claude/commands/worktree-setup.md` | 変更 | 1a | Phase 3 を `flow-wip.mjs add-worktree` に、非 0 で止める | 15 |
| `.claude/commands/orchestrate.md` | 変更 | 1a・1b | 2-2 の手動（`:321-331`）を消す（1a）。3-1 の分岐（`:739`）と 6-1 の呼び出しと echo（`:1068-1071`）に 60 / 61（1b）。全体で 108,000 バイト以下 | ±0 |
| `scripts/orchestrate/launch-worker.mjs` | 変更 | 1b | §4.2 のゲート・ロック・受付の記録、注記（`:63-74`） | 80 |
| `scripts/orchestrate/publish-pr.mjs` | 変更 | 1b | §4.3 のゲート、注記（`:35-36`） | 50 |
| `tests/unit/scripts/orchestrate/launch-worker-wip-4368.test.ts` | 新規 | 1b | §11.7 の L 行 | 350 |
| `tests/unit/scripts/orchestrate/publish-pr.test.ts` | 変更（追加のみ） | 1b | §11.7 の P 行 | 200 |
| `tests/unit/scripts/orchestrate/orchestrate-md-calls.test.ts` | 変更（追加のみ） | 1b | 3-1 の雛形を偽のコマンドで実行（§11.6 の O 行） | 120 |
| `docs/orchestrate/workers.md` | 変更 | 1b | 「3-1 send とワーカーの起動の exit code」（`:69`）に 60 / 61 と §5.1 の扱い | 15 |
| `changelog.d/4368.md` | 変更 | 1a・1b | 既存の 1 項目へ統合 | — |

規模の見積り: 本体 約 880 行、試験 約 2000 行（**見立て**）。目安（数百行）を超えるが、§6-4 によりロック・受付の記録・入力の取得を呼び手と分けた PR にはできない（呼び手の無い部品になる）。超えた分は試験の表で、試験を削らない。U1 で 1a / 1b に分ければ、本体は約 750 行 / 約 130 行。

`.agents/` に `worktree-setup.md` の写しは無い（2026-11-14 に `find` で確認）。`tests/setup.ts` は変えない（ロックの root は試験ごとに `CM_VERIFY_LOCK_ROOT` を一時 dir へ向ける）。

### 10.2 `flow-wip.mjs` の形（JSDoc の型。scripts は TS を import しない）

```js
/** @typedef {{ path: string, branch: string | null, head: string | null }} WorktreeRow */
/** @typedef {{ number: number, headRefName: string, headOwner: string | null, isCrossRepository: boolean, baseRefName: string, headRefOid: string, mergedAt?: string }} PrRow */
/** @typedef {{ repo: string, base: string, exclude: string[],
 *   worktrees: WorktreeRow[], openPrs: PrRow[],
 *   merged: Record<string, 'proved' | 'not-proved' | 'unknown'>   // W のブランチ → マージの証明（§1.1）
 * }} WipInput */
/** @typedef {{ unmerged: string[], active: null, unknown: string[], excluded: string[], complete: boolean }} WipCount */

export function countWip(input)                        // 純関数。WipCount（X8）
export function readWipInput(root, { run, now, deadlineAt, repo, base, exclude })
                                                       // { ok: true, input } | { ok: false, source, reason }（W7。例外を投げない）
export function decideGate({ gate, delta, count, total, target })
                                                       // { verdict: 'pass'|'refuse'|'unknown', exit, message }
export function admit({ gate, target, root, home, env, run, now, deadlineAt, lockWaitMs, op })
                                                       // ロック → 読み → 判定 → op() → 受付の記録 → 返す。op は通したときだけ呼ぶ
export function hasContinuation({ root, repo, base, branch, worktree, run, now, deadlineAt })
                                                       // 継続の証拠（§4.2）。true / false（不明は false）
export function makeRunner({ spawn })                  // 時間切れ・SIGKILL つきの同期の runner（再試行なし）
export function parseArgs(argv)
export function main(argv, deps = {})
export const EXIT_WIP_LIMIT = 60
export const EXIT_WIP_UNKNOWN = 61
// readRawFlowConfig(root) は scripts/flow/config.mjs に置く（#4367 の読み手を広げる）
```

- `run` は同期で `(command, args, { timeoutMs }) → { status, stdout, stderr, timedOut }`。既定は `makeRunner` が作る、`spawnSync` に `timeout` と `killSignal: 'SIGKILL'` を渡すもの。呼び手（launch-worker・publish-pr）は自分の `run`（publish は `withGhRetry` で包んだもの）を渡さない。試験は `deps.wipRun` で差し替える
- `deadlineAt` は ms の絶対時刻。#4367 の tick の予算から呼ぶときは、その残りを渡す（#4367 の頼み、§13）

CLI:

```
node scripts/orchestrate/flow-wip.mjs count --worktree <path> [--json]
node scripts/orchestrate/flow-wip.mjs check --gate pr --worktree <path> --branch <name> [--json]
node scripts/orchestrate/flow-wip.mjs add-worktree --branch <name> --dir <path> --from <base> [--wip-lock-wait-sec <n>]
```

- `check --gate send` は作らない（送信のゲートは launch-worker の中でロックを送信の戻りまで持つ必要があり、別のプロセスでは持てない）。`check --gate pr` は人が手で確かめる読みだけ（ロックを取らない・受付の記録を書かない）で、publish-pr は `admit` を使う。呼び手の無い組み合わせは exit 2（§6-4）
- `count` の exit: 0 数えた（off でも数える）、61 数えられない、2 使い方・設定の誤り

### 10.3 受入基準（PR1）

1. `add-worktree`: `total = 3`・C が 3 本で exit 60、`git worktree add` の呼び出し 0 回。そのうち 1 本の PR を squash でマージした入力（`headRefOid = tip`・同じ base・同じリポジトリ）で exit 0、`git worktree add` 1 回、受付の記録 1 行
2. 同時の受付: `total = 3`・C が 2 本で、2 つの `add-worktree` を同時に始めた（barrier）とき、通るのは 1 つだけで、もう一方は 60（I4）
3. send（launch-worker）: `total = 3`・対象が未受付で、対象を除いた C が 3 本（`|C \ {b}| = 3`）のとき exit 60、停止・Auto-Yes・モデル・`send` の呼び出し 0 回。対象に継続の証拠があれば、C が `total` を超えていても今までどおりの呼び出しの列
4. pr（publish-pr）: W に無いブランチ × C が `total` ちょうどで exit 60（push・`gh pr create` 0 回、`pr` の記録なし）。W のブランチは C が `total` を超えていても通る（ロック・WIP の `gh` の呼び出しなし）
5. 除外（`main`・`agent-health-runner`・base）は数えず、除外への send / pr は止めない
6. マージの証明: squash（祖先でない・`headRefOid = tip`）は数えない。最新の PR が別の base へのマージで、古い PR が正しい base・tip のとき数えない（最新 1 本だけ見る実装は赤）。fork の同名ブランチのマージでは数える。鮮度の分からない `origin/<base>` の祖先だけでは数える
7. 取得の失敗・時間切れ・切り詰めは exit 61 で、呼び手の副作用 0
8. `wip` 節が無い・`flow.yaml` が無いリポジトリでは、`gh`・`<cli>`・`remote get-url` の呼び出し 0 回で、3 つの呼び手の呼び出しの列が PR1 の前と同じ（陰性対照）
9. `wip.active` は exit 2（「PR2a」）。#4367 の読み手の試験の 8 行目は `wip.total` を許可する期待に変わり、`alerts` / `train` は今までどおり拒む
10. orchestrate 3-1 の雛形で launch-worker が 60 / 61 を返したとき、再送・stop・wait が始まらず、`send` の段が `fail` で記録される
11. `.claude/commands/orchestrate.md` は 108,000 バイト以下
12. `Kewton/CommandMate`・`develop` はコードの既定に無い（`flow-wip.mjs` を grep して 0 件）

### 10.4 gates

- `lint`・`typecheck`・`unit-related`（`node scripts/run-related-unit-tests.mjs --base origin/develop`、mutex `cpu.heavy`）。`cpu.heavy` の裁定を省かない。`src/` を触らないので `build-server` は要らない。`tests/setup.ts` を変えることになったら `unit` に広げる（共通の枠）
- ワーカーの確認（ゲートの代わりにしない）: `npx vitest run tests/unit/scripts/orchestrate/flow-wip-4368.test.ts tests/unit/scripts/orchestrate/worktree-setup-wip-4368.test.ts tests/unit/scripts/orchestrate/launch-worker-wip-4368.test.ts tests/unit/scripts/orchestrate/publish-pr.test.ts tests/unit/scripts/orchestrate/orchestrate-md-calls.test.ts tests/unit/scripts/flow tests/unit/guards tests/unit/docs`
- 試験は `run` を差し替えて `git` / `gh` / CLI の答えを与える。実の GitHub・サーバー・tmux に触れない。ロックの root・受付の記録は `CM_VERIFY_LOCK_ROOT` で `fs.mkdtempSync(os.tmpdir())` の下へ向け、`afterEach` で消す
- 既存の試験の期待の反転は X9 の 1 行だけ（plan に「行の削除ではなく期待の更新」と書く）

## 11. 試験の表（it.each の行の形。実装はしない）

各表の「赤」は、直す前（または 1 つの防御を外した変異）の実装で落ちることを示す。防御ごとに 1 つずつ外す変異を置く（モジュールが無くて import で落ちる、だけで済ませない）。

### 11.1 数と増分（`countWip`・`decideGate`）

行の形: `[名前, total, C の内訳, 対象, 対象の占有, Δ, 期待の verdict, 期待の exit]`。

| # | total | C | 対象 | 占有 | Δ | 期待 | 赤（変異） |
|---|---|---|---|---|---|---|---|
| N1 | 3 | 2 本 | 新しい n | 無い | 1 | pass / 0 | — |
| N2 | 3 | 3 本 | 新しい n | 無い | 1 | refuse / 60（上限ちょうど） | `>` で比べる変異 |
| N3 | 3 | 3 本 → 1 本 squash でマージ | 新しい n | 無い | 1 | pass / 0 | squash を数える変異 |
| N4 | 3 | 5 本（超過） | W の a（pr） | 数に入っている | 0 | pass / 0 | 常に `|C|` で断る変異 |
| N5 | 3 | 5 本（超過） | 受付済みの a（send、継続の証拠あり） | 数に入っている | 0 | pass / 0 | 継続を見ない変異 |
| N6 | 3 | 4 本（a は手で作った未受付） | a（send） | 未受付 | 1 | refuse / 60（`|C \ {a}| = 3`） | — |
| N7 | 3 | 3 本（a は未受付） | a（send） | 未受付 | 1 | pass / 0（`|C \ {a}| = 2`） | 自分を数える変異 |
| N8 | なし（off） | 20 本 | 任意 | — | — | off / 0 | — |
| N9 | 3 | 3 本 | `agent-health-runner` | 除外 | — | pass / 0 | 除外を数える変異 |
| N10 | 3 | 3 本、1 本が `unknown` | 新しい n | 無い | 1 | refuse / 60、`complete: false` | `unknown` を数えない変異 |

### 11.2 証拠（マージの証明・継続の証拠）

| # | 入力 | 期待 | 赤（変異） |
|---|---|---|---|
| E1 | W = c@X。MERGED（head c・base develop・X・同じリポジトリ）。祖先でない | 数えない | 祖先だけで判定 |
| E2 | W = c@Y。MERGED（c・develop・X） | 数える | tip を見ない |
| E3 | W = c@X。MERGED が 2 本: 新しい方は base main・X、古い方は base develop・X | 数えない | 最新 1 本だけ見る（`prsOfBranch` の流用） |
| E4 | W = c@X。MERGED が 1 本: base main・X | 数える | base を見ない |
| E5 | W = c@X。MERGED（fork owner z の c・develop・X） | 数える | `isCrossRepository` を見ない |
| E6 | 窓（300 件）に無く、枝ごとの照会で MERGED（c・develop・X） | 数えない | 窓だけで判定 |
| E7 | 枝ごとの照会が切り詰め（100 件） | 数える、`unknown = [c]` | 切り詰めを見ない |
| E8 | tip が祖先、`origin/develop` = GitHub の base の SHA | 数えない | — |
| E9 | tip が祖先、`origin/develop` ≠ GitHub の SHA（古い ref） | 数える | 鮮度を見ない |
| E10 | tip が祖先、GitHub の SHA が読めない | 数える | 読めないを一致と扱う |
| E11 | 照会の間に HEAD が変わった（`rev-parse` を照会の前後で 2 回読んで違う） | `unknown`、数える | 1 回だけ読む |
| E12 | 継続: 記録あり（同じ repo・base・b・実パス）、reflog の作成が記録より古い、記録の後のマージなし | 証拠あり | — |
| E13 | 継続: 記録あり、reflog の作成が記録より新しい（作り直し） | 証拠なし | 作成時刻を見ない |
| E14 | 継続: 記録あり、記録の後に base へマージした PR | 証拠なし | マージを見ない |
| E15 | 継続: 記録は別のブランチ（同じ path を使い直した） | 証拠なし | path だけで照合 |
| E16 | 継続: 記録は別の worktree の実パス | 証拠なし | ブランチだけで照合 |
| E17 | 継続: reflog が無い・読めない | 証拠なし | 読めないを証拠ありと扱う |
| E18 | 継続: タスクの一覧にだけ過去のタスクがある（受付の記録なし） | 証拠なし | タスクの一覧を証拠にする |

### 11.3 入力の完全性（`readWipInput`）

| # | 差し替える答え | 期待 | 赤（変異） |
|---|---|---|---|
| R1 | `git worktree list` が status 128 | `ok: false, source: 'git worktree list'` | 失敗を空の W に畳む |
| R2 | 開いた PR の読みが失敗 | `ok: false, source: 'gh pr list --state open'`（再試行の呼び出し 0 回） | 失敗を空の P に畳む／再試行する |
| R3 | 開いた PR の件数 = `--limit` | `ok: false, reason: 'truncated'` | — |
| R4 | 開いた PR の JSON は正しいが `headRefName` の欠けた行 | `ok: false, reason: 'shape'` | 形を見ない |
| R5 | 開いた PR の JSON が途中で切れている | `ok: false, reason: 'shape'` | — |
| R6 | `worktree list` の `worktree` 行の無い塊 | `ok: false, reason: 'shape'` | — |
| R7 | `merge-base` が 1 本だけ status 128 | `ok: true`、その枝が `unknown` | 全体を不明にする／数えない |
| R8 | `flow.yaml` が無い | `gh`・`<cli>`・`remote get-url` の呼び出し 0 回（I8） | off でも base を解決する |
| R9 | 呼び出しの列 | 判定の `git` は I9 の 5 種、`gh` は `isGhRead` が真のものだけ | 書く呼び出しを足す |

### 11.4 期限（W7）

| # | 差し替える答え | 期待 | 赤（変異） |
|---|---|---|---|
| D1 | `gh` が戻らない（`timedOut: true`） | 締め切りの内に `ok: false, source: 'gh …', reason: 'timeout'`、exit 61、副作用 0 | 時間切れを渡さない |
| D2 | 残り 5 秒で枝ごとの照会が 20 本 | 締め切りを超えない（各呼び出しの `timeoutMs` ≤ 残り）、間に合わない枝は `unknown` | 1 本ごとに 30 秒を渡す |
| D3 | 締め切りの後に返った成功 | 捨てて 61 | 遅れた結果で pass |
| D4 | publish の `withGhRetry` の `run` が手元にある | WIP の `gh` の呼び出しは 1 回ずつ（再試行 0） | 包んだ `run` を使う |
| D5 | `deadlineAt` が既に過ぎている | 何も呼ばずに `ok: false, reason: 'timeout'` | — |

### 11.5 競合・寿命・設定と対象（ロック、W1・W5）

| # | 状況 | 期待 | 赤（変異） |
|---|---|---|---|
| K1 | `total = 3`・C = 2、2 つの `admit` を barrier で同時に | 通るのは 1 つ、他方は判定が `|C| = 3` で 60 | ロックを判定だけで持つ（確定の前に返す） |
| K2 | 5 つを同時に | 通るのは 1 つ、残りは 60 | 同上 |
| K3 | ロックが生きた持ち主に持たれ、締め切りが来る | exit 61、`source: wip-lock`、`heldBy` を示す。op 0 回 | 待たずに通す |
| K4 | 持ち主が op の途中で死んだ（pid ESRCH） | 次の `admit` が部品で回収して取り、実際の状態で数える。受付の記録が無い枝は未受付 | 死んだ持ち主のロックで永久に 61 |
| K5 | ロックの観測ができない（EPERM） | exit 61、op 0 回 | 観測できないを空きと扱う |
| K6 | op が失敗（`git worktree add` が 128） | exit 1、受付の記録 0 行、ロックを返す | 失敗でも記録する |
| K7 | op の後の受付の記録の追記が失敗 | 標準エラーに 1 行、op の結果のまま | 記録の失敗で op を失敗にする |
| K8 | 判定の後に対象のブランチが変わった（op の直前の `rev-parse --abbrev-ref` が違う） | op を呼ばずに exit 2 | 判定の時の名前で op |
| K9 | 同じ受付の再試行（N7 の後に同じ a へ再送） | 継続の証拠で pass、ロックを取らない | — |
| K10 | マージで 1 枠空いた直後の `admit` | pass | — |
| C1 | 対象の worktree（linked）から root を決める | 主 worktree の `flow.yaml` を読み、対象の作業ツリーの `flow.yaml`（上限 1000）は読まない | 対象から読む |
| C2 | 別のリポジトリの worktree を `--worktree` に | そのリポジトリの root の設定で判定（引数で root を渡せない） | — |
| C3 | publish の `--repo` ≠ 設定の `repo` | push の前に exit 2 | 宛先を見ない |
| C4 | publish の `--base` ≠ 設定の `base` | `Δ = 0` として通し、標準エラーに 1 行 | 設定の base へ書き換える |
| C5 | `add-worktree --from trunk`、設定の base は develop | exit 2、作らない | — |
| C6 | send の `--wt` の行の `path` ≠ `--worktree` の実パス | exit 2、副作用 0 | — |
| C7 | `flow.yaml` 無し・origin 無し・HEAD 未設定 | off / 0（新しい拒否を出さない） | off でも `readFlowConfig` を呼ぶ |

### 11.6 手順（偽のコマンドで bash を実際に動かす）

行の順の正規表現だけで代わりにしない。手順書の bash のブロックを取り出し、`PATH` の先頭に偽の `node` / `git` / `npm` / `commandmatedev` / `curl` を置いた一時 dir で、書かれたとおりの bash で実行し、偽のコマンドが書く呼び出しの記録を見る。

| # | 手順 | 偽の `flow-wip.mjs` / launch-worker の答え | 期待 |
|---|---|---|---|
| S1 | worktree-setup Phase 3〜4 | 0 | `npm install` が呼ばれる（陰性対照） |
| S2 | 同 | 60 | `npm install`・Phase 5・Phase 6 の呼び出し 0 回、0 でない終わり方 |
| S3 | 同 | 61 | 同上 |
| S4 | 同 | 2 | 同上 |
| S5 | 同 | 時間切れ（偽が 124 で終わる） | 同上 |
| S6 | 同、既存の worktree がある | （呼ばれない） | `flow-wip.mjs` の呼び出し 0 回、今までどおり続く |
| O1 | orchestrate 3-1 の雛形（1 件の `assign.tsv`） | launch-worker が 60 | `run-log.mjs append --stage send --result fail --note "launch exit=60"`、launch-worker の呼び出し 1 回だけ（再送なし）、`kill` / `wait` の呼び出し 0 回 |
| O2 | 同 | 61 | 同上（`exit=61`） |
| O3 | 同 | 0 で task ID が空 | `task MISSING`、`--result fail` |
| O4 | 同 | 0 と task ID | `--result ok`（陰性対照） |
| O5 | orchestrate 3-1 の文（`:739` 付近） | — | 60 / 61 の扱い（§5.1 の表の「すること」）が書かれ、「冷間起動の失敗に従って再送」の対象から外れている |

### 11.7 各呼び手

| # | 呼び手 | 状況 | 期待 |
|---|---|---|---|
| L1 | launch-worker（Claude、`--model opus`） | ゲート 60 | exit 60、`stopSession`・`disarmAutoYes`・`setModel`・`send` の呼び出し 0 回、標準出力は空 |
| L2 | launch-worker（Command Code、`--model -`） | ゲート 60 | exit 60、権限の読みと停止の呼び出し 0 回（ゲートはその前） |
| L3 | launch-worker（alias の instance） | ゲート 61 | exit 61、同上 0 回 |
| L4 | launch-worker | off | PR1 の前の試験（`launch-worker-3883.test.ts` ほか）と同じ呼び出しの列（既存の試験は変えない） |
| L5 | launch-worker | pass、送信 exit 0・task ID あり | 受付の記録 1 行、ロックは `sendTo('send', …)` が戻った後に返る（呼び出しの順で確かめる） |
| L6 | launch-worker | pass、送信 exit 0・task ID 空 | 受付の記録 0 行 |
| L7 | launch-worker | pass、モデルの不一致で exit 40 | 受付の記録 0 行、ロックを返す、exit 40 のまま |
| P1 | publish-pr | W に無いブランチ × C = total | exit 60、push・`gh pr create` 0 回、`pr` の記録なし |
| P2 | publish-pr | W のブランチ × C > total | ロック・WIP の `gh` の呼び出し 0 回、以降は今までどおり |
| P3 | publish-pr | 既に open の PR | ゲートを呼ばない |
| P4 | publish-pr | 記録の欠け（既存の `problems`） | 既存の exit 1 のまま（WIP は判定しない） |
| P5 | publish-pr | pass | ロックは `gh pr create` が戻った後に返る |

### 11.8 設定の共有（#4367 の読み手）

| # | 入力 | 期待 | 赤（変異） |
|---|---|---|---|
| F1 | #4367 の設定だけ（`wip` なし） | #4367 の読みの結果が PR1 の前と同じ | 既存の検査を壊す |
| F2 | `wip: { total: 8 }` | 許可、`readFlowConfig` の結果に `wip.total = 8` | — |
| F3 | `wip: { total: 8, active: 5 }` | exit 2、「PR2a」を名指す | `active` を黙って無視 |
| F4 | `wip: { totl: 8 }`・`total: 0`・`1.5`・`"8"`・`.inf` | exit 2 | — |
| F5 | `alerts`・`train`（#4367 PR1a の時点） | 今までどおり exit 2 | 「wip を拒む」行を消して済ませる |
| F6 | `readRawFlowConfig` | git の remote・GitHub を呼ばない | — |

## 12. 人の操作・人の判断（未決）

実機への導入（このリポジトリへの `flow.yaml` のコミット）はこの run の範囲外（X7）。GitHub の設定・launchd・ランナー・Docker の変更は要らない。

### 12.1 方針（PM・人）

| # | 判断 | 選択肢 | 推奨と理由 | 決める人 |
|---|---|---|---|---|
| H1 | このリポジトリの `wip.total` | (a) 8 (b) 10 (c) 5 | **(a)**。動いている 5（Epic の運用の約束）＋ PR 待ち 3。#4367 の計測で 1 週間見て見直す | 人 |
| H2 | 数える worktree の元 | (a) ディスク上 (b) 登録されたもの（Issue の文言） | **(a)**。作ってから `sync` までが漏れない | 人 |
| H3 | 動いている = 止まっていない待機中も含む（PR2a） | (a) 含む (b) 処理中・応答待ちだけ | **(a)**。Issue の定義どおり | 人 |
| H4 | PR を作る口の解釈 | (a) 数に入っていないブランチだけ断る (b) すべて断る | **(a)**。(b) は減らす道を塞ぐ（I1） | 人 |
| H5 | 判定できないとき | (a) 止める (b) 通して警告 | **(a)**。マージも進まない時に足しても溜まる | 人 |
| H6 | 緊急の迂回 | (a) フラグを作らない（主 worktree の `flow.yaml` を人が変える） (b) `--override` | **(a)** | 人 |
| H7 | Skill のインストールの PR へのゲート（PR4） | (a) 掛ける (b) 掛けない | **(a)** | 人 |
| H8 | 開いた PR のあるブランチへの契約を active の上限から外すか（PR2a） | (a) 外さない (b) 外す | **(a)** | 人 |
| H9 | 同時の受付 | — | **決定済み: (b) ロック**（リーダー、W1。§5.2） | 済み |

### 12.2 未決（この設計で決めきれないこと）

| # | 未決 | 推奨 | 決める人 |
|---|---|---|---|
| U1 | PR1 を 1a / 1b の 2 本に分けるか | 分ける（送信経路の 1b を、ロックと数え方の 1a と別にレビューする。§6-3） | リーダー |
| U2 | ロックを待つ締め切りの既定（`--wip-lock-wait-sec`） | 600 秒（launch-worker の 1 回の起動とモデルの確認が収まる長さの見立て。§14.2） | PM |
| U3 | 取得の全体の締め切りの既定 | 120 秒（#4367 の取得の予算 200 秒より短く、tick の中で呼べる） | PM（#4367 の U4 と一緒に） |
| U4 | Issue の受入条件のうち active の段（2 段目）を PR2a まで延ばすこと | 延ばす（§6.2。PR1 で受けると素通りの穴になる） | リーダー（Issue の受入の分け方） |
| U5 | 受付の記録の片付け | 第 1 段は消さない。PR3 で、マージ済み・消えたブランチの行を 30 日で落とす | リーダー |

## 13. 他の子への約束（提供・利用）

### 13.1 提供する（#4368 → #4367）

- **WIP の数**（共通の枠 §3、X8）: `scripts/orchestrate/flow-wip.mjs` の
  - `readWipInput(root, { run, now, deadlineAt, repo, base, exclude })` → `{ ok: true, input } | { ok: false, source, reason }`。例外を投げない。`deadlineAt` は呼び手の残りの予算（#4367 の頼み: 時間切れつき。W7）。再試行 0 回。`repo`・`base`・`exclude` は #4367 の読み手の結果をそのまま渡す
  - `countWip(input)` → `{ unmerged: string[], active: null, unknown: string[], excluded: string[], complete: boolean }`
  - 単位は **repo × base**。#4367 は `complete` が真のときだけ `unmerged.length` を確定値として記録し、偽なら `null`（上側の数は別の欄で、警報の入力にしない）。`active` は PR2a まで常に `null`（0 にしない）
  - 第 2 段は `src/lib/flow/wip.ts` に写し、§11 の表を JSON（`tests/fixtures/flow/wip-cases.json`）にして両方の試験で読む（I12）
- **上限**: `wip.total` は #4367 の読み手の結果に入る（PR1a で足す）
- **ロック**: `wip/wip.<…>.lock` は #4368 だけが取る。#4367 の tick は取らない（読みだけで、受付をしない）

### 13.2 利用する（#4367 → #4368）

- `scripts/flow/config.mjs` の `readFlowConfig(repoRoot, { run, env })`（X1）。#4368 PR1a が変えること（X9、#4368 の scope に入れる）:
  1. `wip` を名指しで拒む扱いをやめ、`wip.total` を許可、`wip.active` を「PR2a で足す」として名指しで拒む
  2. `readRawFlowConfig(root)` を足す（YAML の解析と `wip` の形の検査だけ。base・origin を解決しない。I8・W5）
  3. `tests/unit/scripts/flow/config-4367.test.ts` の T1 の 8 行目の期待を同じ PR で更新（行は消さない。`alerts`・`train` を拒む期待は残す）
- 読む場所: #4367 の読み手の root の決め方（`--git-common-dir` の親）を使う。ゲートは root を引数で受けない
- `flow` の記録の書き手（#4367）: PR1 では呼ばない。#4367 PR4 で WIP を記録するときに、受付の記録（§5.3）を読むかを #4367 が決める

### 13.3 #4369・#4370 へ

- #4369（merge train）: マージは数を減らす操作なので、WIP のゲートは train に掛けない。train が作る一時のブランチは worktree にしないか、名前を `exclude` に入れられる形にしてほしい。ロック `wip/…` と `merge/…` は別の dir で、互いに待たない
- #4370（資源の配分）: active の上限（PR2a）は「同時のワーカーの数」で、#4370 の P0〜P3 の枠（機械の負荷）とは別。両方が効く。launch-worker の中の順は「WIP の受付 → #4370 の枠」を提案する（WIP で断るものに枠を取らない）。決めるのは #4370

## 14. 事実と見立て

### 14.1 事実（`origin/develop` = `a334a013f` で確認）

- `git worktree add` は製品のコードに無く、手順書（`.claude/commands/orchestrate.md:324`、`.claude/commands/worktree-setup.md:81`）と skill の試験・デモの scripts にだけある
- 契約つきの send は `POST /api/worktrees/[id]/tasks` がタスクの行を作る（`src/app/api/worktrees/[id]/tasks/route.ts:85-207`、作成は `:188`）。ロールの拒否は 409 ＋ `code` ＋ `sendOutcome: 'not_sent'`（`:179-183`）。CLI の `send` は `--register` / `--role` の登録をしてから契約のタスクを作る（`src/cli/commands/send.ts:1038-1050`）
- launch-worker は `--instance` を `:518-526` で解決し、`:549` で契約の引数を作り、Command Code は `:566`、Claude は `:574-585` で停止・モデル・開始の文を行ってから契約を送る
- publish-pr は `run` を `withGhRetry` で包み（`:163`）、既存の PR を読み（`:206`）、`problems` を集め（`:212-231`）、push（`:252`）してから `gh pr create`（`:275`）。終了コードは 0 / 1 / 2（`:35-36`）
- `prsOfBranch`（`pr-common.mjs:272-284`）は `--state all` を base で絞らずに読み、新しい順に open と merged を 1 本ずつ返す。`defaultRun`（`:58-67`）は `spawnSync` に時間切れを渡さない。`withGhRetry`（`:143`）は読みの `gh` を 4 回まで再試行する
- `listSessions`（`src/lib/tmux/tmux.ts:386-415`）は例外を空の一覧にする。`GET /api/worktrees` はその一覧から `isSessionRunning` を作る（`src/app/api/worktrees/route.ts:149`・`:160-169`）
- `acquireMachineLockSync`（`machine-lock-sync.mjs:1080`）は札と `mkdir` の排他、持ち主の記録、死んだ持ち主の回収（`:450`・`:1003`）を持つ。ロックの root は `machineLockRoot`（`precheck.mjs:523`）。merge のロックは専用の dir `merge/`（`merge-pr.mjs:812-823`）
- orchestrate 3-1 の雛形は launch-worker の RC と task の存在で `SENT` を決め（`orchestrate.md:719-726`）、`:739` は「exit 40〜44 以外は冷間起動の失敗に従って再送」と書く
- `.claude/commands/orchestrate.md` は 107,998 バイト、目標は 108,000 バイト（`tests/unit/docs/orchestrate-size-headroom-4276.test.ts:19`）
- #4367 の設計（改訂 1 の 9240bff）: 読み手は `scripts/flow/config.mjs` の `readFlowConfig(repoRoot, { run, env })`、PR1a は `wip` を exit 2 で拒み、その試験は `tests/unit/scripts/flow/config-4367.test.ts` の T1 の 8 行目
- 2026-11-14 の実測: このリポジトリの `git worktree list` は 24 行、develop へ向いた開いた PR は 1 本

### 14.2 見立て（未確認）

- `gh pr list --state merged` の `headRefOid` は、マージの時点の head の SHA（squash でも head ブランチの SHA）と見ている。PR1a の最初に squash でマージした PR 1 本で確かめる（`gh pr view <N> --json headRefOid,mergeCommit`）
- launch-worker のロックを持つ間（モデルの確認と起動し直しを含む）は 1〜5 分と見ている。その間、同じ repo × base の他の受付は待つ。並列のレーンの立ち上げは直列になるが、今の 3-1 も 1 件ずつ送る雛形なので差は小さい
- 枝ごとのマージの照会は W の本数だけ増える（このリポジトリで 20 本前後、1 本 1 秒前後）。窓で多くが見つかるので、多くは数本と見ている
- reflog は既定（`core.logAllRefUpdates`）で非 bare のリポジトリに残る。期限切れ（既定 90 日）の後は継続の証拠が取れず、新しい作業として扱われる（厳しい側）
- 管理の外の操作（I14）がどれだけあるかは、#4367 の計測で C の増え方と受付の記録の差として見える

## 15. 改訂 1 の対応（2-4-4 事前レビューの W1〜W8 と突き合わせの決定）

| 指摘 | 処分 | 反映先 |
|---|---|---|
| W1 同時受付 | 直す（リーダーの決定: H9 を (b)）。判定から確定までのロック、所有・死の回収・取れないときは 61 | I4、§5.2、§4、K1〜K10 |
| W2 増分と前タスク | 直す。増分で判定、継続は受付の記録＋reflog＋マージ後の無効で証明、不明は新しい作業 | I1、§4.2、N4〜N7、E12〜E18 |
| W3 ls の false | 狭めて塞ぐ。PR1 は active を受け付けず、生死の完全な読みは PR2a | §6.2、§7、F3、U4 |
| W4 マージの証拠 | 直す。存在の証明（repo・base・tip・同じリポジトリ）、`prsOfBranch` を使わない、祖先は鮮度を確かめたときだけ | §1.1、E1〜E11 |
| W5 設定と宛先 | 直す。root は対象の共通 dir から、off は何も読まない、宛先の不一致は副作用の前に 2 | I8、I10、§7、C1〜C7、R8 |
| W6 60 / 61 の消費 | 直す。3-1・6-1 の扱いの表と手順、空の task ID を成功にしない | §5.1、§4.2、O1〜O5 |
| W7 期限 | 直す。各コマンドと全体の締め切り、再試行 0、遅れた結果を捨てる、`deadlineAt` | I11、§6.1、D1〜D5 |
| W8 PR2 の後段の拒否 | PR2b の契約として書く（順・札・副作用の一覧） | §9.1 |
| X8・X9 | 反映 | §13、§10.1 |

改訂の履歴: 2026-11-14 改訂 1 — 2-4-4 事前レビュー（codex-2、P2 8 件）とリーダーの処分・突き合わせの決定 X1〜X10 を反映（ロック・増分・マージの証明・設定の root・60/61 の消費・期限・active を PR2a へ・PR1 の範囲と試験の表の書き直し）。
