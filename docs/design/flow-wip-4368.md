# WIP の上限 — 管理元のブランチ以外の未マージのブランチ数で新しい作業を止める（Issue #4368）

- Epic: #4371（エージェントのチームの流れの計測と制御）の子 2
- 正本: Issue #4368 の本文、Epic #4371 の本文（背景の実測）、段 3 の共通の枠（開発リーダーの決定、2026-11-14）
- 事実の出典: `origin/develop` = `a334a013f`（2026-11-14 時点）。`file:line` はすべてこのコミットで取った。行番号は古くなるので、実装では名前で探し直すこと
- この文書はコードを変えない。実装は §10 の PR1 から

## 0. 目的と結論（先に）

2026-11-13 は「同時のワーカー 5」が依頼文の約束だけで守られず、未マージのブランチが 20 本を超えた（Epic #4371）。作る速さがマージの速さを超えないよう、**数を増やす操作の入口**で上限を仕組みとして守る。

結論:

1. 数えるもの — 管理元のブランチ（`base`）へ未マージのブランチの集合 **C** と、そのうちセッションが生きているものの集合 **A**。マージ済みかは PR の状態（`headRefOid` がブランチの先端と一致する MERGED の PR）か、先端が `origin/<base>` の祖先かで決める。squash は後者で判定できないので、前者が要る
2. 止めるのは「数を増やす操作」だけ — 新しい worktree（C を 1 増やす）・契約つきの send（A を 1 増やす／新しい作業を C に足す）・数に入っていないブランチの PR の作成（C を 1 増やす）。**マージへ向かう操作（数に入っているブランチの PR・普通の send・マージ・worktree の削除・セッションの停止）は止めない**
3. 上限を超えたら何も作らず・送らずに **exit 60**（WIP の上限）、数えられないときは **exit 61**（WIP を数えられない）で止める（fail-closed）。HTTP は 409 / 503
4. 設定は `.commandmate/flow.yaml` の `wip` 節（`total`・`active`）。無ければ上限なし（今までどおり）なので、どのリポジトリでも設定を書いたときだけ効く
5. 第 1 段（この run の PR1）は `scripts/orchestrate/flow-wip.mjs` と、その呼び手（`launch-worker.mjs`・`publish-pr.mjs`・`/worktree-setup`）。第 2 段で製品（サーバーの `POST /tasks`・CLI `send` の終了コード・API・画面）へ

## 1. 用語と数え方

| 記号 | 意味 | 取り方（第 1 段） |
|---|---|---|
| `base` | 管理元のブランチ。共通の枠 §2 のとおり #4367 の読み手が決める（既定は `develop` があれば develop、無ければ既定のブランチ） | #4367 の読み手 |
| `E` | 除外の一覧。共通の枠 §2 の `exclude`（既定は main / master と base 自身）。恒久の worktree（`agent-health-runner` など）はここに名指しする | #4367 の読み手 |
| `W` | このリポジトリの **ディスク上の** worktree のうち、ブランチを持つもの（detached は入れない）。各要素は `{ path, branch, head }` | `git -C <repo-dir> worktree list --porcelain` |
| `P` | `base` へ向いた **開いた** PR の head ブランチ。他のリポジトリ（fork）からの PR は `<owner>:<branch>` を鍵にして区別する | `gh pr list --state open --base <base>` |
| `M` | マージ済みのブランチ。`b ∈ M` ⇔ `b ∉ P` かつ（`base` へマージされた PR のうち head が `b` で `headRefOid = tip(b)` のものがある、または `tip(b)` が `origin/<base>` の祖先） | `gh pr list --state merged --base <base>`、`git merge-base --is-ancestor` |
| **C** | 未マージのブランチ = `(branches(W) ∪ P) \ E \ M` | 上の合成 |
| **A** | 動いているブランチ = `{ b ∈ C : b の worktree のどれかでセッションが生きている }`。生死が分からない行は生きているとして数える | サーバーの worktree 一覧（`<cli> ls --json` の `isSessionRunning`） |
| `tip(b)` | `W` にある `b` の worktree の `HEAD`。同じブランチの worktree は git が 1 つしか許さない | `worktree list --porcelain` の `HEAD` 行 |

- **保留中のブランチも数える**（Issue の仕様。在庫も WIP）。数えたくないものは `exclude` に名指しする以外の道を作らない（つまみを増やさない）
- マージ済みの PR のブランチでも、マージの後に先端が進んだもの（`headRefOid ≠ tip(b)`）は新しい作業なので数える
- 閉じた（マージしていない）PR のブランチは、worktree が残っていれば数え、消えていれば数えない（P にも W にも無い）
- 「登録された worktree」ではなく「ディスク上の worktree」を数える理由: 登録は `sync` の後でしか起きない（`.claude/commands/orchestrate.md:333-338` の 2-3）。`git worktree add` から `sync` までの間の worktree を数え漏らすと、入口を迂回した作成が上限に見えない。DB に残ってディスクに無い行は幽霊なので数えない。これは Issue の文言からの変更なので §12 の人の判断に入れた

## 2. 不変条件

1. **I1 増やす操作だけを止める。** ゲートが断るのは、C か A を増やす操作だけ。C・A を増やさない操作（数に入っているブランチの PR の作成、普通の `send`、マージ、worktree の削除、セッションの停止、`sync`）は、上限を超えていても断らない
2. **I2 断ったら何も起きていない。** 断った（exit 60 / 61）とき、worktree・タスクの行・Auto-Yes・セッションの起動・停止・push・PR は 1 つも作られていない・変わっていない。ゲートは副作用の前に置く
3. **I3 上限ちょうどで断る。** 増やした後に上限を超える操作を断る（`|C| ≥ total` の新しい worktree は断る、`|C| = total - 1` は通す）。マージで 1 本減れば、同じ操作が通る
4. **I4 除外は数えない、除外は止めない。** `E` のブランチは C・A に入らず、`E` のブランチへの操作をゲートは断らない
5. **I5 squash でマージしたブランチは数えない。** マージの判定は `git branch --merged` だけに頼らない（PR の `headRefOid` で判定する）
6. **I6 数えられないときは止める（ゲート）、0 と言わない（計測）。** 入力の取得に失敗したら、ゲートは exit 61 で止め、計測には `null`（不明）を渡す。0 本と取り違えない
7. **I7 1 本ずつの不明は数える側に倒す。** あるブランチのマージ済みかどうか・セッションの生死だけが不明なら、そのブランチは数える（C・A に入れる）。全体を不明にはしない
8. **I8 設定が無ければ今までどおり。** `wip` 節が無い・上限が `null` のリポジトリでは、ゲートは常に通す（exit 0、標準エラーに `wip: off` の 1 行）。既存の入口の挙動は 1 bit も変わらない
9. **I9 ゲートは数えるだけで書かない。** GitHub・git・サーバーへの書き込みをしない。読むだけ（`gh` は読みの呼び出しだけ、`git` は `worktree list` / `rev-parse` / `merge-base` だけ）
10. **I10 設定はゲートされる側から読まない。** 上限は対象の worktree のファイルではなく、リポジトリの主の worktree（`--repo-dir`）の `.commandmate/flow.yaml` から読む。ワーカーが自分の worktree の設定で上限を上げられない
11. **I11 数え方は 1 つ。** C・A を数える純関数は 1 つで、ゲートと計測（#4367）が同じものを呼ぶ。第 2 段で TS へ写すときは、同じ表（§11）を両方に流して一致を固定する

## 3. 状態と遷移の表

### 3.1 ブランチの状態

| 今の状態 | 出来事 | 次の状態 | C | A | 副作用 |
|---|---|---|---|---|---|
| （無い） | worktree の作成（ゲート `worktree` を通った） | 未マージ・止まっている | +1 | 0 | なし（作成は呼び手） |
| （無い） | worktree の作成（ゲートで断られた） | （無い） | 0 | 0 | exit 60 / 61、何も作らない |
| 未マージ・止まっている | 契約つきの send（ゲート `send` を通った） | 未マージ・動いている | 0 | +1 | なし（送るのは呼び手） |
| 未マージ・止まっている | 契約つきの send（断られた） | 未マージ・止まっている | 0 | 0 | exit 60 / 61、停止・起動・送信なし |
| 未マージ・動いている | セッションが終わる・止める | 未マージ・止まっている（在庫） | 0 | −1 | なし |
| 未マージ（W にある） | PR の作成 | 未マージ・PR あり | 0 | 0 | ゲート `pr` は数に入っているので常に通す（I1） |
| （W に無い） | 他から push されたブランチの PR の作成（ゲートを通った） | 未マージ・PR あり | +1 | 0 | なし |
| （W に無い） | 同上（断られた） | （無い） | 0 | 0 | exit 60 / 61 |
| 未マージ・PR あり | PR が squash / merge でマージ（先端 = `headRefOid`） | マージ済み | −1 | 動いていれば −1 | なし |
| マージ済み | 同じブランチに新しいコミット | 未マージ | +1 | 生死による | なし |
| 未マージ・PR あり | PR を閉じる（マージせず）、worktree は残す | 未マージ・止まっている | 0 | 0 | なし |
| 未マージ | worktree を消す（PR なし） | （無い） | −1 | 動いていれば −1 | なし |
| 任意 | `exclude` に名指しされる | 除外 | 数えない | 数えない | なし |
| 未マージ | マージ済みかが不明（git / gh の 1 本だけ失敗） | 未マージとして数える | 数える | 生死による | `unknown` に名を載せる（I7） |

### 3.2 ゲートの判定

| 設定 | 入力の取得 | 対象 | 判定 | 終了コード |
|---|---|---|---|---|
| `wip` 無し・上限 `null` | （取得しない） | 任意 | off | 0 |
| `wip` が不正 | — | 任意 | 設定の誤り | 2 |
| 有効 | 全体が失敗 | 対象が除外・数に入っている PR（I1 の早道） | pass | 0 |
| 有効 | 全体が失敗 | それ以外 | unknown | 61 |
| 有効 | 成功 | §4 の各入口の式で超える | refuse | 60 |
| 有効 | 成功 | 超えない | pass | 0 |

## 4. 止める入口（どこで判定し、何を返すか）

式の `C \ {b}` は「対象 b を除いた数」。対象を除いて数えるので、対象自身が既に数に入っていても二重に数えない。

### 4.1 worktree を作る口

- **事実**: CommandMate の製品のコード（`src/`）には worktree を作る処理が無い。`git worktree add` は手順書の中にだけある — `.claude/commands/orchestrate.md:324`（2-2 の手動）、`.claude/commands/worktree-setup.md:81`（`/worktree-setup` の Phase 3）。製品は作られた worktree を `POST /api/repositories/sync`（`src/app/api/repositories/sync/route.ts:31`）で取り込むだけ。`src/app/api/worktrees/[id]/git/branch/create/route.ts:1-11` はブランチを作るが worktree は作らない（W にも P にも入らないので数に影響しない）
- **判定の式**: `|C \ {n}| ≥ total` なら断る（`n` は作るブランチ名。新しいブランチなら C に無いので `|C| ≥ total`）
- **第 1 段の判定の場所**: `node scripts/orchestrate/flow-wip.mjs check --gate worktree --repo-dir <dir> --branch <n>` を `git worktree add` の直前に置く
  - `.claude/commands/worktree-setup.md:81` の直前（Phase 3 の bash）。exit が 0 でなければ作らずに止める
  - `.claude/commands/orchestrate.md:324` は 2-2 の手動の代替。**orchestrate.md は 107,998 バイトで、`tests/unit/docs/orchestrate-size-headroom-4276.test.ts:19` の目標 108,000 バイトまで残り 2 バイト**。PR1 では 2-2 の手動の代替（`:321-326`）を `/worktree-setup` だけに寄せて減らし、増やさない
- **`sync` は止めない**: 既にディスクにある worktree を登録しないと画面から消えるだけで、数は減らない（I1）。第 2 段では、上限を超えたリポジトリを画面と #4367 の警報で見せる
- **返すもの**: exit 60 と案内文（§5）。作成しない

### 4.2 作業を送る口（契約つきの send）

- **判定の式**（対象の worktree のブランチ `b`。`b ∈ E` なら常に通す）:
  - (A) `active` が設定されていて `|A \ {b}| ≥ active` なら断る
  - (B) `total` が設定されていて、`b` に **前のタスクが無い**（このブランチへの最初の契約）かつ `|C \ {b}| ≥ total` なら断る。(B) は、入口を迂回して作られた worktree（手で `git worktree add`）に、新しい作業が入るのを止める最後の関所。前のタスクがある 2 本目の契約・再ディスパッチは (B) を見ない
  - 普通の send（`--contract` 無し。再指示・人の send）は止めない（I1）
- **第 1 段の判定の場所**: `scripts/orchestrate/launch-worker.mjs` の `main`（`:490`）で、`--instance` を解決した後（`:518-526`）、**最初の停止の前**（Command Code の `stopped(...)` は `:566`、Claude の停止の繰り返しは `:574-576`）。具体的には `contractArgs` を作る `:549` の直後、`if (commandCode)` の `:551` の前。launch-worker は契約の前にセッションを止めて開始の文を送る（`:574-585`）ので、サーバー側だけで判定すると、断る前にセッションを止めて起動し直してしまう（I2 違反）
  - 前のタスクの有無: `<cli> task list <wt> --json`（`src/cli/commands/task.ts:99-130`、`GET /api/worktrees/:id/tasks`）が空なら最初の契約。読めなければ「最初」とみなす（厳しい側）
  - 断ったら exit 60 / 61 をそのまま返す。何も止めず・書かず・送らない
- **第 2 段の判定の場所（製品・正）**: `src/app/api/worktrees/[id]/tasks/route.ts` の `POST` で、契約と verify.yaml の検査（`:160-166`）の後、ロールの検査（`:173`）とタスクの行の作成（`:188`）の前。前のタスクの有無は `listTasks(db, id, 1)`（`src/lib/db/tasks-db.ts:217`）。ロールの拒否（`:179-183` の `409` + `code` + `sendOutcome: 'not_sent'`）と同じ形で返す
  - CLI は `src/cli/commands/send.ts` の `createContractTask`（`:307`）の `catch`（`:337-349`）で `code` を見て exit 60 / 61 にする。`send --contract` はタスクを作るまで副作用を起こさない（`send.ts:1042-1055` の注記と順序）ので、ここで止めれば Auto-Yes も relay も触らない（I2）
  - 第 2 段の後も launch-worker の第 1 段のゲートは残す（停止の前に判定する唯一の場所なので）
- **返すもの**: exit 60 / 61 と案内文。HTTP は §5

### 4.3 PR を作る口

- **判定の式**（ブランチ `b`。`b ∈ E` なら通す）: `b` が既に数に入っている（`b ∈ branches(W)` か `b ∈ P`）なら **常に通す**（I1。マージへ向かう操作）。そうでなければ `|C| ≥ total` で断る
  - 受入条件「上限ちょうどで PR の作成が断られる」は、数に入っていないブランチの PR で満たす。数に入っているブランチの PR を断ると、上限を超えたときに減らす道（マージ）を塞ぐので断らない。この解釈は §12 の人の判断にも載せた
  - 早道: `b` がディスク上の worktree のブランチなら、`gh` を呼ばずに通す（`git worktree list` だけで判定できる）。GitHub が落ちていても、数に入ったブランチの PR の作成は止まらない
- **第 1 段の判定の場所**: `scripts/orchestrate/publish-pr.mjs` の `main` で、既存の PR の読み（`:206` `prsOfBranch`）の後、`problems` の判定（`:229`）の中に入れる（push の `:252` と `gh pr create` の `:275` の前）。`open` がある（既に PR がある）ときは判定しない。publish-pr は `--worktree` のブランチを出すので、実際には早道で常に通る（ゲートは数に入っていないブランチを `--branch` で出したときに効く）
  - publish-pr の終了コードは今 0 / 1 / 2（`publish-pr.mjs:35-36`）。60 / 61 を足す
- **第 2 段（製品）**: 製品で PR を作るのは Skill のインストールの PR だけ（`src/lib/skills/git-workflow.ts:900-907` → `src/lib/skills/pull-request-service.ts`）。新しいブランチなので数に入っていない。ゲートを掛けるかは §12 の人の判断（推奨: 掛ける）
- `.claude/commands/create-pr.md`（`/create-pr`）は LLM の手順で、製品の入口ではない。第 1 段では publish-pr だけを入口にする

### 4.4 入口にしないもの（理由）

| 操作 | 場所 | 止めない理由 |
|---|---|---|
| `git branch` / `git worktree add` そのもの | git | CommandMate から止められない（Issue の前提）。(B) が後で関所になる |
| `POST /api/repositories/sync` | `src/app/api/repositories/sync/route.ts:31` | 既にあるものを見えなくするだけ（I1） |
| 普通の `send`・`respond`・`reply` | `src/cli/commands/send.ts` ほか | 再指示・人の操作。数を増やさない |
| マージ（`merge-pr.mjs`） | `scripts/orchestrate/merge-pr.mjs` | 数を減らす操作（I1）。既存の組み合わせの確認・必須チェック・ロックは変えない（共通の枠 §5） |

## 5. 終了コード・HTTP・案内文

### 5.1 既存の番号（衝突の確認）

`src/cli/types/index.ts` の各表と、手順の scripts の番号（`origin/develop` で確認）:

| 番号 | 使い手 |
|---|---|
| 0 / 1 / 2 / 3 / 4 / 5 / 99 | `ExitCode`（`src/cli/types/index.ts:10-35`）。3 は `START_FAILED` と `NOT_IN_SESSION` が共有。merge-pr.mjs も 3 / 4 を使う |
| 10 / 11 / 124 | `WaitExitCode`（`:239`） |
| 11 / 12 / 13 | `SkillExitCode`（`:647`） |
| 20 / 21 | `VerifyExitCode`（`:275`） |
| 30 | `InterruptExitCode`（`:680`） |
| 31 / 32 | `RoleExitCode`（`:702-709`） |
| 40 / 41 | `StrictRespondExitCode`（`:289`）。launch-worker.mjs も 40〜45（`launch-worker.mjs:105-112`） |
| 50〜57 | `MemExitCode`（`:911`）・`MEM_EXIT_BY_CODE`（`src/types/mem.ts:233`） |

### 5.2 新しい番号（候補と推奨）

| 候補 | 意味 | 評価 |
|---|---|---|
| **60 / 61（推奨）** | 60 = WIP の上限（何もしていない）、61 = WIP を数えられない（何もしていない） | どの表とも launch-worker / merge-pr / publish-pr とも重ならない。60 番台を「流れの制御（Epic #4371）」の帯として空けられる |
| 33 / 34 | 31 / 32（ロール）の隣 | 30 番台はセッションとロールの帯。意味が違うものを混ぜる |
| 46 / 47 | launch-worker の 40〜45 の隣 | launch-worker の帯と紛らわしく、`StrictRespondExitCode` の 40 / 41 とも同じ帯 |

- 第 2 段で `src/cli/types/index.ts` に `FlowExitCode = { SUCCESS: 0, WIP_LIMIT: 60, WIP_UNKNOWN: 61 } as const` を足す（`RoleExitCode` と同じ書き方）。第 1 段の scripts は同じ値を `flow-wip.mjs` の `export const EXIT_WIP_LIMIT = 60` / `EXIT_WIP_UNKNOWN = 61` に持つ（launch-worker の `EXIT_*` と同じ流儀）
- 62〜69 は #4369・#4370 が使うなら同じ帯に置くよう提案する（§13。決めるのは各子）

### 5.3 HTTP（第 2 段）

| 場合 | 状態 | 本文 |
|---|---|---|
| 上限 | 409 | `{ error, code: 'WIP_LIMIT_EXCEEDED', sendOutcome: 'not_sent', wip: { base, gate, count, limit, branches } }`（`tasks/route.ts:181` のロールの拒否と同じ形） |
| 数えられない | 503 | `{ error, code: 'WIP_UNKNOWN', sendOutcome: 'not_sent', wip: { base, gate, source, reason } }` |

### 5.4 案内文（標準エラー、英語。CLI の既存の文に合わせる）

- exit 60:
  `WIP limit reached for <owner/repo> (base <base>): <n>/<limit> unmerged branches[, <a>/<active> running]. Nothing was created or sent. Merge or close one first: <古い順に最大 5 本: branch (#PR)>. The limits are in <repo-dir>/.commandmate/flow.yaml (wip).`
- exit 61:
  `Could not count WIP for <owner/repo> (base <base>): <source> failed: <reason>. Nothing was created or sent. Run it again once <source> answers.`
- 標準出力は `--json` のときだけ `{ verdict, gate, base, counts: { unmerged, active }, limits, unknown, branches }` を 1 行。それ以外は何も出さない（launch-worker の標準出力はタスク ID だけ、という既存の約束を守る）

## 6. 外部の呼び出しごとの失敗の倒れ方

| 呼び出し | 使う所 | 失敗・時間切れ | 部分的な成功 | 倒れ方 |
|---|---|---|---|---|
| `.commandmate/flow.yaml` の読み（#4367 の読み手） | 全ゲート | ファイル無し → off（I8）。読めない・YAML の誤り・`wip` の型の誤り → exit 2（設定の誤り、ファイル名つき） | — | 無し = fail-open（今までどおり）、壊れている = fail-closed |
| `git worktree list --porcelain`（`--repo-dir`） | W | 失敗 → 全体が不明 | 個々の行の欠け（`branch` 行が無い = detached）→ その行は数えない | fail-closed（exit 61） |
| `git rev-parse --verify origin/<base>` | M の祖先判定 | 無い → 祖先判定をしない（PR だけで判定） | — | 数えすぎ側（I7） |
| `git merge-base --is-ancestor <tip> origin/<base>` | M | 0 = 祖先、1 = 祖先でない、それ以外 → そのブランチは不明 | — | そのブランチを数える（I7）。`origin/<base>` が古い（fetch していない）と祖先に見えない → 数えすぎ側。ゲートは fetch しない（I9） |
| `gh pr list --state open --base <base> --limit 1000` | P | `withGhRetry`（`pr-common.mjs:143`、4 回・10/30/60 秒）の後も失敗 → 全体が不明 | 返った件数 = `--limit` → 切り詰めの疑い → 全体が不明 | fail-closed（exit 61） |
| `gh pr list --state merged --base <base> --limit 300` | M | 失敗 → 全体が不明 | 窓（300 件）より古いマージの PR → 下の補い | fail-closed（exit 61） |
| `gh pr list --head <b> --state all`（`prsOfBranch`、`pr-common.mjs:272`） | M の補い（窓に無く、祖先でもない W のブランチだけ） | 失敗 → そのブランチは不明 | — | そのブランチを数える（I7） |
| `<cli> ls --json`（サーバー API `GET /api/worktrees`） | A | サーバーが落ちている・401 → A が不明 | `isSessionRunning` の無い行 → その行は生きているとする | `send` のゲートは exit 61。`worktree` / `pr` のゲートは A を使わないので呼ばない |
| `<cli> task list <wt> --json` | (B) の最初の契約 | 失敗 → 最初の契約とみなす | — | 厳しい側（(B) を掛ける） |
| サーバーの `listTasks`（第 2 段） | (B) | 例外 → 503 `WIP_UNKNOWN` | — | fail-closed |
| tmux | — | 呼ばない（CLI は `src/lib/tmux` を import できない。生死はサーバーの答えを読む） | — | — |
| Docker・ランナー・launchd | — | 呼ばない | — | — |

- **数えられないときに止めるか通すか**: ゲート（新しい作業を足す入口）は **止める**（fail-closed）。理由: GitHub かサーバーが答えないときはマージも進まないので、作業を足しても溜まるだけ。2026-11-13 の溜まり方（Epic）を繰り返さない。逆に、数に入っている側の操作（I1）と除外（I4）は入力を読まずに通すので、止まるのは「新しい作業」だけ
- **計測（#4367）へは**: 全体の不明は `null`（I6）。1 本ずつの不明は数に入れたうえで `unknown` に名前を並べる
- 時間: `gh` の読みの再試行で最長およそ 100 秒＋各呼び出しの時間。ゲートの全体に別の時間切れは足さない（呼び手の launch-worker・publish-pr は既に `gh` を待つ前提で動いている）

## 7. 設定（`.commandmate/flow.yaml` の `wip` 節）

```yaml
# 共通のキー（#4367 の読み手が持つ）
base: develop
exclude: [main, agent-health-runner]
# この Issue の節
wip:
  total: 8      # 未マージのブランチ（C）の上限。整数 ≥ 1。省略・null = 上限なし
  active: 5     # 動いているブランチ（A）の上限。整数 ≥ 1。省略・null = 上限なし
```

- 節が無い・両方 `null` → off（I8）。片方だけ書けば片方だけ効く
- 検査: 整数でない・0 以下・未知のキー（`wip` の中）は設定の誤り（exit 2）。`active > total` は誤りにしない（意味は通る。A ⊆ C なので total が先に効くだけ）
- 値は既定に持たない（このリポジトリの 8 / 5 は §12 で人が決めて、`.commandmate/flow.yaml` に書く。コードに埋めない、共通の枠 §1）
- 読む場所は主の worktree の作業ツリー（I10）。どのファイルを読むかの規則は #4367 の読み手に従い、足りなければ §13 で頼む

## 8. 既存の仕組みの再利用の可否

| 既存 | 再利用 | 理由 |
|---|---|---|
| `scripts/orchestrate/pr-common.mjs` の `withGhRetry`（`:143`）・`ghJson`（`:261`）・`prsOfBranch`（`:272`）・`defaultRun`（`:58`）・`isGhRead`（`:119`） | **使う** | `gh` の読みの再試行と JSON の読み、ブランチごとの PR の読みがそのまま要る。`DEFAULT_REPO`（`:24`、`Kewton/CommandMate`）と `DEFAULT_BASE_BRANCH`（`:26`）は **使わない**（どのリポジトリでも使える形、共通の枠 §1。リポジトリは `git remote get-url origin` か設定から、base は #4367 の読み手から） |
| `scripts/orchestrate/machine-lock-sync.mjs` | 使わない | ゲートは読むだけで排他が要らない。ただし、ゲートを通ってから worktree を作るまでの間に別のレーンも通る競合（2 本が同時に「残り 1」を見る）は残る。§12 の人の判断（推奨: 第 1 段は受け入れる。`merge.<owner>.<repo>.<base>` と同じ名前の流儀で `wip.<owner>.<repo>.<base>` のロックを足すのは、#4367 の計測で同時の超過が実際に出てから） |
| `scripts/orchestrate/run-log.mjs` | 使わない（第 1 段） | run の進捗の記録（Issue × 段）で、リポジトリ × base の数の記録ではない。断った記録は #4367 の `flow` の記録へ（§13） |
| `scripts/orchestrate/precheck.mjs` | 使わない | PR の前の検査。WIP は PR を作る前でなく、作業を始める前に効かせたい |
| `scripts/orchestrate/merge-pr.mjs` | 変えない | 数を減らす側（I1）。worktree の一覧の読み方（`:953` の `git worktree list --porcelain`）は同じやり方を使う |
| `src/lib/metrics/vibe-metrics.ts`・`commandmate report metrics`（`src/cli/commands/report.ts`） | 使わない | タスク・検証の DB の集計で、ブランチ・PR を見ない。WIP の値は #4367 の記録へ渡す |
| `src/lib/verification/verify-config.ts` の `loadVerifyConfig`（`:668`） | 読み手の流儀だけ倣う | `.commandmate/verify.yaml` を `yaml` で読んで問題を一覧で返す形。`flow.yaml` の読み手は #4367 が作る（共通の枠 §2） |
| `scripts/agent-health/metrics-runners.ts` | 使わない | 計測の道具を走らせて `skip` に倒す形は計測向け。ゲートは不明で止める（I6）ので倒れ方が逆 |
| self-hosted ランナーの scripts | 使わない | WIP はランナーを見ない（ランナーの台数は #4370） |

## 9. PR の切り方

team.md §6-3（危険の境目で分ける）・§6-4（API は呼び手と同じ PR）に従う。

| PR | 中身 | 危険の境目 | 依存 |
|---|---|---|---|
| **PR1（この run）** | 第 1 段: `scripts/orchestrate/flow-wip.mjs`（純関数・入力の取得・ゲートの判定・`count` / `check`）、#4367 の読み手への `wip` 節、呼び手 3 つ（launch-worker の `send`・publish-pr の `pr`・`/worktree-setup` の `worktree`）、手順書と exit code の文書 | 手順の scripts だけ。製品の送信経路（`src/`）に触れない | #4367 PR1（読み手）が先 |
| PR2 | 第 2 段の送信経路: `src/lib/flow/wip.ts`（PR1 の純関数の写し＋同じ表の試験）、`POST /api/worktrees/[id]/tasks` のゲート、`send` の exit 60 / 61、`FlowExitCode`、`docs/` の ja / en の CLI 文書 | 製品の送信経路。画面を入れない | PR1 |
| PR3 | 数の API と画面: `GET /api/repositories/[id]/flow/wip` と呼び手（CLI `commandmate flow wip`、画面の「WIP n/上限」）、Skill の PR のゲート（§12 で掛けると決まれば） | 画面と読みの API。送信経路は入れない | PR2、#4367 の画面の置き場 |

- 呼び手の無い組み合わせは引数で拒否する: PR1 の `check --gate` は `worktree` / `send` / `pr` 以外を exit 2。`--gate send` に `--wt` が無い、`--gate pr` に `--branch` が無い、も exit 2
- PR1 の大きさの見立て: 新しいファイル 2（scripts と試験）、変える 6〜8。数百行

## 10. この run で実装する PR1 の範囲（実装の契約にできる粒度）

### 10.1 変更するファイル（scope.allow の案）

| ファイル | 新規 / 変更 | 内容 |
|---|---|---|
| `scripts/orchestrate/flow-wip.mjs` | 新規 | 下の 10.2 の関数と CLI |
| `<#4367 PR1 の flow.yaml の読み手>` | 変更 | `wip` 節（§7）の検査と既定。ファイル名は #4367 PR1 が決めたものを、契約を作るときに名指す |
| `scripts/orchestrate/launch-worker.mjs` | 変更 | `send` で `contractArgs`（`:549`）の後・最初の停止の前にゲート `send` を呼ぶ。60 / 61 / 2 はそのまま返す。使い方の注記と exit code の注記（`:63-74`）に 60 / 61 を足す |
| `scripts/orchestrate/publish-pr.mjs` | 変更 | `open` が無いときに `problems` の判定（`:229`）の前でゲート `pr` を呼ぶ。60 / 61 を返す。注記（`:35-36`）に足す。`--repo-dir`（既定は `--worktree` の主の worktree）を足す |
| `.claude/commands/worktree-setup.md` | 変更 | Phase 3（`:70-85`）の `git worktree add` の前にゲート `worktree` の 1 行と、0 以外で止める文 |
| `.claude/commands/orchestrate.md` | 変更 | 2-2 の手動の代替（`:321-326`）を `/worktree-setup` へ寄せ、バイト数を増やさない（108,000 の目標） |
| `docs/orchestrate/workers.md` | 変更 | 「3-1 send とワーカーの起動の exit code」（`:69`）に 60 / 61 の行 |
| `tests/unit/scripts/orchestrate/flow-wip-4368.test.ts` | 新規 | §11 の表 |
| `tests/unit/scripts/orchestrate/launch-worker-wip-4368.test.ts` | 新規 | ゲートが 60 / 61 のとき、停止・Auto-Yes・`send` の呼び出しが 0 回（陽性対照）、off / pass のときは今までの呼び出しの列と同じ（陰性対照） |
| `tests/unit/scripts/orchestrate/publish-pr.test.ts` | 変更（追加のみ） | 数に入っていないブランチ × 上限ちょうどで push・`gh pr create` が 0 回、worktree のブランチは上限超えでも通る |
| `changelog.d/4368.md` | 新規 | 断片 |

`.agents/` に `worktree-setup.md` の写しは無い（2026-11-14 に `find` で確認）。`tests/unit/scripts/orchestrate/orchestrate-md-calls.test.ts` は orchestrate.md の script の呼び出しを各 script の `parseArgs` に通すので、orchestrate.md に `flow-wip.mjs` を書くなら `flow-wip.mjs` も `parseArgs` を export し、その試験に足す（足さないなら orchestrate.md に書かない）。

### 10.2 `flow-wip.mjs` の形（JSDoc の型。scripts は TS を import しない）

```js
/** @typedef {{ path: string, branch: string | null, head: string | null }} WorktreeRow */
/** @typedef {{ number: number, headRefName: string, headOwner: string | null, isCrossRepository: boolean, baseRefName: string, headRefOid: string }} PrRow */
/** @typedef {{ base: string, exclude: string[], repoOwner: string,
 *   worktrees: WorktreeRow[], openPrs: PrRow[], mergedPrs: PrRow[],
 *   ancestorOfBase: Record<string, boolean | null>,      // tip → 祖先か（null = 不明）
 *   sessionRunning: Record<string, boolean | null> | null // worktree の path → 生死（null = 読んでいない）
 * }} WipInput */
/** @typedef {{ unmerged: string[], active: string[] | null, unknown: string[], excluded: string[] }} WipCount */

export function countWip(input /* WipInput */) /* : WipCount */      // 純関数。I1〜I7・I11
export function readWipInput(repoDir, { base, exclude, needSessions, run, cli }) // { ok: true, input } | { ok: false, source, reason }
export function decideGate({ gate, count, limits, target })          // { verdict: 'off'|'pass'|'refuse'|'unknown', reason, message }
export function parseArgs(argv)
export function main(argv, deps = {})                                // exit code
export const EXIT_WIP_LIMIT = 60
export const EXIT_WIP_UNKNOWN = 61
```

CLI:

```
node scripts/orchestrate/flow-wip.mjs count --repo-dir <dir> [--cli <commandmate>] [--json]
node scripts/orchestrate/flow-wip.mjs check --gate worktree --repo-dir <dir> --branch <name> [--json]
node scripts/orchestrate/flow-wip.mjs check --gate send --repo-dir <dir> --wt <worktree-id> --worktree <path> [--cli <commandmate>] [--json]
node scripts/orchestrate/flow-wip.mjs check --gate pr --repo-dir <dir> --branch <name> [--json]
```

- `count` の exit: 0 数えた（設定 off でも数える）、61 数えられない、2 使い方・設定の誤り
- `check` の exit: 0 通す（off を含む）、60 上限、61 数えられない、2 使い方・設定の誤り、1 その他
- リポジトリの `owner/repo` は `git -C <repo-dir> remote get-url origin` から（設定に `repo` があればそれ。#4367 と §13）

### 10.3 受入基準（PR1）

1. ゲート `worktree`: 上限 `total = 3` で C が 3 本のとき exit 60（何も作らない）、そのうち 1 本の PR を squash でマージした入力（`headRefOid = tip`）で exit 0
2. ゲート `send`: `active = 2` で他の 2 本が動いているとき、launch-worker は exit 60 を返し、停止・Auto-Yes・`send` の呼び出しが 0 回。1 本がマージされると同じ入力で今までどおりの呼び出しの列
3. ゲート `pr`: 数に入っていないブランチ × C が `total` ちょうどで publish-pr は exit 60（push・`gh pr create` が 0 回）。worktree のブランチは C が `total` を超えていても通る
4. 除外（`main`・`agent-health-runner`・base）は数に入らず、除外のブランチへの `send` / `pr` は止めない
5. squash でマージした PR のブランチ（祖先でない・`headRefOid = tip`）は数えない。マージの後に先端が進んだブランチは数える
6. `gh` の開いた PR の読みが失敗・切り詰めのとき exit 61、`git worktree list` が失敗したとき exit 61。数に入っている側の `pr` は 61 にならない（早道）
7. `wip` 節が無いリポジトリでは、3 つの呼び手の呼び出しの列が PR1 の前と同じ（陰性対照）
8. `Kewton/CommandMate` も `develop` もコードの既定に無い（`flow-wip.mjs` を grep して 0 件）

### 10.4 gates

- `lint`・`typecheck`・`unit-related`（`node scripts/run-related-unit-tests.mjs --base origin/develop`、mutex `cpu.heavy`）。`src/` を触らないので `build-server` は要らない
- ワーカーの確認: `npx vitest run tests/unit/scripts/orchestrate/flow-wip-4368.test.ts tests/unit/scripts/orchestrate/launch-worker-wip-4368.test.ts tests/unit/scripts/orchestrate/publish-pr.test.ts tests/unit/scripts/orchestrate/orchestrate-md-calls.test.ts tests/unit/guards tests/unit/docs`
- 試験は `run` を差し替えて `git` / `gh` / CLI の答えを与える（`publish-pr.test.ts` と同じ流儀）。実の GitHub・サーバー・tmux に触れない。一時ファイルは `fs.mkdtempSync(os.tmpdir())` で作り `afterEach` で消す

## 11. 試験の表（it.each の行の形。実装はしない）

### 11.1 `countWip`（純関数）

行の形: `[名前, worktrees, openPrs, mergedPrs, ancestorOfBase, sessionRunning, 期待の unmerged, 期待の active, 期待の unknown]`。共通: `base = 'develop'`、`exclude = ['main', 'agent-health-runner']`（base は既定で除外）。

| # | 入力 | 期待 | 対照・直す前の赤 |
|---|---|---|---|
| C1 | W = a@1, b@2。PR なし。祖先でない | unmerged = [a, b] | 陽性: モジュールが無く import で赤 |
| C2 | W = develop@0, main@9, agent-health-runner@8, a@1 | unmerged = [a] | 除外を外した入力では 4 本（陽性対照） |
| C3 | W = c@X。merged PR（head c, `headRefOid` X, base develop）。祖先でない | unmerged = [] | squash。祖先だけで判定する実装は [c] で赤 |
| C4 | W = c@Y。merged PR（head c, X）。祖先でない | unmerged = [c] | マージの後に進んだ |
| C5 | W = d@5。PR なし。祖先 | unmerged = [] | merge / fast-forward |
| C6 | W なし。open PR e（base develop） | unmerged = [e] | worktree の無い PR |
| C7 | W = f@6。open PR f | unmerged = [f]（1 本） | 二重に数えない |
| C8 | open PR g（base main） | unmerged = [] | base 以外へ向いた PR |
| C9 | W = h@7。open PR h（fork、owner x） | unmerged = [h, x:h] | fork を別に数える |
| C10 | W = （detached）@3 | unmerged = [] | detached は数えない |
| C11 | W = i@4。祖先の判定が不明（null） | unmerged = [i], unknown = [i] | I7 |
| C12 | W = j@5。closed PR j（マージせず） | unmerged = [j] | 在庫も WIP |
| C13 | W = k@1（生きている）, l@2（止まっている）, m@3（null） | active = [k, m] | 不明は生きている側 |
| C14 | W = c@X（squash でマージ済み、生きている） | active = [] | マージ済みは動いていても数えない |
| C15 | W = agent-health-runner@8（生きている） | active = [] | 除外は動いていても数えない |
| C16 | sessionRunning = null（読んでいない） | active = null | I6（0 と言わない） |

### 11.2 `decideGate`

行の形: `[名前, gate, limits, |C| の内訳, |A| の内訳, target, 前のタスク, 期待の verdict, 期待の exit]`。

| # | gate | limits | 状態 | target | 期待 |
|---|---|---|---|---|---|
| G1 | worktree | total 3 | C = 2 | 新しい n | pass / 0 |
| G2 | worktree | total 3 | C = 3 | 新しい n | refuse / 60（上限ちょうど） |
| G3 | worktree | total 3 | C = 3 → 1 本 squash でマージ（C3 の入力） | 新しい n | pass / 0（マージで 1 本減ると通る） |
| G4 | worktree | なし | C = 20 | 新しい n | off / 0（I8） |
| G5 | send | active 2 | A = {x, y} | z（止まっている） | refuse / 60 |
| G6 | send | active 2 | A = {x, z} | z | pass / 0（自分を除いて 1） |
| G7 | send | active 2 | A = {x, y}、x がマージ済みに | z | pass / 0 |
| G8 | send | total 3 | C = {a, b, c, z}、z に前のタスク無し | z | refuse / 60（迂回した作成の関所） |
| G9 | send | total 3 | C = {a, b, c, z}、z に前のタスク有り | z | pass / 0 |
| G10 | send | total 3 | C = {a, b, z} | z（前のタスク無し） | pass / 0（作るときに入れたもの） |
| G11 | send | active 1 | A = {x} | agent-health-runner | pass / 0（I4） |
| G12 | send | active 2 | A が不明（サーバーが答えない） | z | unknown / 61 |
| G13 | send | total 3 | タスクの一覧が読めない、C = {a, b, c, z} | z | refuse / 60（最初とみなす） |
| G14 | pr | total 3 | C = {a, b, c} | 新しい p（W にも P にも無い） | refuse / 60 |
| G15 | pr | total 3 | C = {a, b} | 新しい p | pass / 0 |
| G16 | pr | total 3 | C = 5 本（超過） | a（W にある） | pass / 0（I1） |
| G17 | pr | total 3 | `gh` が落ちている | a（W にある） | pass / 0（早道） |
| G18 | pr | total 3 | `gh` が落ちている | 新しい p | unknown / 61 |
| G19 | 任意 | `wip: { total: 0 }` | — | — | 設定の誤り / 2 |
| G20 | 任意 | `wip: { totl: 3 }` | — | — | 設定の誤り / 2 |

### 11.3 `readWipInput`（`run` を差し替える）

| # | 差し替える答え | 期待 |
|---|---|---|
| R1 | `git worktree list` が status 128 | `{ ok: false, source: 'git worktree list' }` |
| R2 | 開いた PR の読みが 504 を 4 回 | `{ ok: false, source: 'gh pr list --state open' }`、再試行の notice が 3 行 |
| R3 | 開いた PR の読みが `--limit` と同じ件数 | `{ ok: false, reason: 'truncated' }` |
| R4 | `merge-base --is-ancestor` が status 128（1 本だけ） | `ok: true`、`ancestorOfBase[tip] = null` |
| R5 | `origin/develop` が無い | `ok: true`、祖先の判定をしない（全部 null でなく「判定しない」印）、PR の判定だけで数える |
| R6 | `needSessions: false` | `ls --json` を呼ばない（呼び出しの列で確かめる） |
| R7 | `ls --json` の行に `isSessionRunning` が無い | その path は null |
| R8 | 呼び出しの列 | `git` は `worktree list` / `rev-parse` / `merge-base` / `remote get-url` だけ、`gh` は `isGhRead` が真のものだけ（I9） |

### 11.4 呼び手

| # | 呼び手 | ゲートの答え | 期待 |
|---|---|---|---|
| L1 | launch-worker send | 60 | exit 60、`stopSession`・`disarmAutoYes`・`setModel`・`send` の呼び出し 0 回 |
| L2 | launch-worker send | 61 | exit 61、同上 0 回 |
| L3 | launch-worker send | off / 0 | PR1 の前の試験（`launch-worker-3883.test.ts` ほか）と同じ呼び出しの列（陰性対照。既存の試験は変えない） |
| P1 | publish-pr | 60（新しいブランチ） | exit 60、push・`gh pr create` 0 回、run の記録に `pr` の行を書かない |
| P2 | publish-pr | worktree のブランチ | ゲートが `gh` を呼ばずに通す。以降は今までどおり |
| P3 | publish-pr | 既に open の PR がある | ゲートを呼ばない |
| S1 | worktree-setup.md | — | Phase 3 の bash に `flow-wip.mjs check --gate worktree` が `git worktree add` より前にある（文書の試験） |

## 12. 人の操作・人の判断（未決。推奨つき）

実機への導入（このリポジトリへの `flow.yaml` のコミット）はこの run の範囲外。GitHub の設定・launchd・ランナー・Docker の変更は要らない。

| # | 判断 | 選択肢 | 推奨と理由 |
|---|---|---|---|
| H1 | このリポジトリの上限の値 | (a) `total 8 / active 5` (b) `total 10 / active 5` (c) `total 5 / active 5` | **(a)**。active 5 は Epic の運用の約束（WIP 5）。total は「動いている 5 ＋ PR 待ち 3」。2026-11-13 の PR の CI は中央値 22 分・マージ 1 本 30 分で、通常の時間帯のマージは 1 時間に 0〜2 本（Epic の表）。#4367 の計測で 1 週間見て見直す |
| H2 | 数える worktree の元 | (a) ディスク上（`git worktree list`） (b) CommandMate に登録されたもの（Issue の文言） | **(a)**。登録は `sync` の後なので、作ってから `sync` までの worktree が数から漏れる。幽霊の行（DB だけにある）は数えない方が正しい |
| H3 | 動いている = セッションが生きている（止まっていない待機中も含む） | (a) 含む (b) 処理中・応答待ちだけ | **(a)**。Issue の定義どおり。終わったワーカーを止めるのは PM の仕事にし、案内文に止め方を書く |
| H4 | PR を作る口の解釈 | (a) 数に入っていないブランチの PR だけ断る (b) すべての PR を上限で断る | **(a)**。(b) は上限を超えたときにマージへ向かう道を塞ぎ、減らせなくなる（I1） |
| H5 | 数えられないとき | (a) 止める（fail-closed） (b) 通して警告 | **(a)**。GitHub かサーバーが答えないときはマージも進まない。作業を足しても溜まるだけ |
| H6 | 緊急の迂回 | (a) フラグを作らない（主の worktree の `flow.yaml` を人が変える） (b) `--override <理由>` を作る | **(a)**。フラグはワーカーの依頼文から使われうる。設定の変更は人の手で、#4367 の記録に残る |
| H7 | Skill のインストールの PR（`git-workflow.ts:900-907`）にもゲートを掛けるか（PR3） | (a) 掛ける (b) 掛けない | **(a)**。新しい未マージのブランチを作る点で同じ。設定の無いリポジトリでは off なので影響は無い |
| H8 | 開いた PR のあるブランチへの契約（直しの契約）を active の上限から外すか | (a) 外さない (b) 外す | **(a)**。active は機械の負荷の上限でもある（#4370）。直しは普通の send でも送れる。#4367 の計測で詰まりが出たら見直す |
| H9 | 同時に 2 本が「残り 1」を見る競合 | (a) 第 1 段は受け入れる (b) `wip.<owner>.<repo>.<base>` のロックを足す | **(a)**。超えても 1〜2 本で、次のゲートで止まる。計測で実際に出てから (b) |

## 13. 他の子への約束（提供・利用）

### 13.1 提供する（#4368 → #4367）

- **WIP の数**（共通の枠 §3）: 第 1 段は `scripts/orchestrate/flow-wip.mjs` の
  - `readWipInput(repoDir, { base, exclude, needSessions, run, cli })` → `{ ok: true, input } | { ok: false, source, reason }`
  - `countWip(input)` → `{ unmerged: string[], active: string[] | null, unknown: string[], excluded: string[] }`
  - 単位は **リポジトリ × base**。数はブランチの名前の配列で渡し、本数は呼び手が `.length` を取る。全体が数えられないときは `ok: false`（#4367 は `null` を記録し、0 を記録しない）。`active` は `needSessions: false` なら `null`
  - 第 2 段は `src/lib/flow/wip.ts` に同じ 3 つを写し、§11 の表を JSON（`tests/fixtures/flow/wip-cases.json`）にして両方の試験で読む（I11。`machine-lock-sync.mjs:34-37` の「写しを同じ規約で固定する」流儀）
- **上限の値**: `wip.total`・`wip.active` は #4367 の読み手の結果に入る。#4367 の画面・警報は「WIP n/上限」をそこから出す
- **終了コードの帯**: 60 / 61 を使う。#4369・#4370 が終了コードを足すなら 62〜69 を提案する（決めるのは各子）

### 13.2 利用する（#4367 → #4368）

- `.commandmate/flow.yaml` の読み手（#4367 PR1）に頼むこと:
  1. `wip` 節を足せること（未知の節で落ちない、または節ごとの検査を足す口がある）
  2. 返り値に `base`・`exclude`（既定の main / master / base を含めた最終の一覧）と、問題の一覧（`verify-config.ts` の流儀）
  3. **読む場所を呼び手が主の worktree に指定できる**こと（I10）。ゲートされる worktree の作業ツリーから読まない
  4. `owner/repo` を設定で上書きできるなら、そのキー名（無ければ `remote get-url origin` から取る）
- `flow` の記録の書き手（#4367）に頼むこと: ゲートが断った（60）・数えられなかった（61）ときに 1 行書ける関数。形は #4367 が決める。PR1 の時点で書き手が無ければ、PR1 は標準エラーだけにし、書き手ができた PR で呼ぶ
- 画面（#4367 の人向けのダッシュボード）: 「WIP n/上限」の表示は #4367 の画面に置く。#4368 の PR3 は数の API（`GET /api/repositories/[id]/flow/wip`）とその呼び手を作る

### 13.3 #4369・#4370 へ

- #4369（merge train）: マージは数を減らす操作なので、WIP のゲートは train に掛けない（I1）。train が作る一時のブランチ（組み合わせ確認用）を `W` や `P` に作るなら、名前の接頭辞を `exclude` に入れられるよう教えてほしい
- #4370（資源の配分）: active の上限（A）は「同時のワーカーの数」で、#4370 の P0〜P3 の枠（機械の負荷）とは別の数。両方が効く（どちらかで止まる）。#4370 の枠を WIP の数で代用しない

## 14. 事実と見立て

### 14.1 事実（`origin/develop` = `a334a013f` で確認）

- `git worktree add` は製品のコードに無く、手順書（`.claude/commands/orchestrate.md:324`、`.claude/commands/worktree-setup.md:81`）と skill の試験・デモの scripts にだけある（`git grep 'worktree add'`）
- 契約つきの send は `POST /api/worktrees/[id]/tasks` が契約を読みタスクの行を作る（`src/app/api/worktrees/[id]/tasks/route.ts:85-207`）。ロールの拒否は 409 ＋ `code` ＋ `sendOutcome: 'not_sent'`（`:179-183`）。CLI の `send --contract` は副作用の前にタスクを作る（`src/cli/commands/send.ts:1042-1055`）
- launch-worker は契約の前にセッションを止め、モデルを書き、開始の文でセッションを起動する（`scripts/orchestrate/launch-worker.mjs:574-585`）
- publish-pr は既存の PR を読み（`:206`）、条件を `problems` に集め（`:213-232`）、push（`:252`）してから `gh pr create`（`:275`）。終了コードは 0 / 1 / 2（`:35-36`）
- `prsOfBranch`（`pr-common.mjs:272-284`）は `--state all` でブランチの PR を読む。`withGhRetry`（`:143`）は読みの `gh` だけを 4 回まで再試行する
- `GET /api/worktrees?repository=<path>` は worktree の行（`path`・`repositoryPath`・`branch`・`isSessionRunning`）を返し（`src/app/api/worktrees/route.ts:66-82`、`src/types/models.ts:200-219`）、`commandmate ls --json` はそれをそのまま出す（`src/cli/commands/ls.ts:436-470`）。DB の `branch` は `sync` の時点の写しで、checkout に遅れる（`src/types/models.ts:206-219` の注記）
- `commandmate task list <wt> --json` が `GET /api/worktrees/:id/tasks` を読む（`src/cli/commands/task.ts:99-130`）
- 既存の終了コードは §5.1 の表のとおりで、60 / 61 はどこにも使われていない（`src/cli/types/index.ts`・`src/types/mem.ts`・`scripts/orchestrate/*.mjs` の注記を grep）
- `.claude/commands/orchestrate.md` は 107,998 バイト、目標は 108,000 バイト（`tests/unit/docs/orchestrate-size-headroom-4276.test.ts:19`）
- 2026-11-14 の実測: このリポジトリの `git worktree list` は 24 行（主・恒久の worktree を含む）、develop へ向いた開いた PR は 1 本（`gh pr list --state open --base develop`）

### 14.2 見立て（未確認）

- `gh pr list --state merged` の `headRefOid` は、マージの時点の head の SHA を返すと見ている（squash でも head ブランチの SHA で、マージのコミットではない）。PR1 の最初に、このリポジトリの squash でマージした PR 1 本で確かめる（`gh pr view <N> --json headRefOid,mergeCommit`）
- `--limit 300` の窓で、worktree の残っているマージ済みのブランチはほぼ拾えると見ている（このリポジトリのマージは 1 日 10〜20 本）。窓の外は `prsOfBranch` で補うので、間違いは起きず遅くなるだけ
- ゲートの所要時間は `gh` 2〜3 回＋`git` が W の本数だけで、数秒と見ている。launch-worker のモデルの確認（数十秒）より短い
- 同時の超過（H9）は、レーンを同時に立てる orchestrate の 3-1 で起きうる。何本超えるかは #4367 の計測で分かる
- `active` を「止まっていない待機中も含む」と数えると、終わったワーカーを止めない運用では上限に早く当たる。それが狙いだが、PM の手間が増えるかは運用で見る
