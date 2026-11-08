# close_when の型付きの評価と終了の記録（Issue #4222 / Epic #4220 の子 B）設計

- 状態：第 3 版：Codex の事前レビュー 1 回目（P1 4 件・P2 5 件）と 2 回目（P2 3 件、2026-11-08）を反映した。処置の一覧は §13、守る条件と対照は §9.3。実装は同じブランチの別の契約で行う
- 前提：Epic #4220 の決定事項 D1〜D13（とくに D3・D5・D6・D8・D9・D10・D12）と、A（#4221）の設計 `docs/design/mem-store-4221.md`（以下「A」）。close_when の文法・保存の形・kind × 型の許可表の正本は A §2 と `tests/fixtures/mem/close-when-v1.json`
- 凡例：**［事実］** = この文書を書いた時点（2026-11-08、`feature/4222-worktree` = develop `e5297912a`）でファイルと行を読んで確かめたもの。**［見立て］** = 設計としての判断。**［未確認］** = 読んでいない・実測していないもの。行番号は確認時点のもので、実装の契約では名前で探し直す

---

## 0. Epic・A の設計と食い違う点

**止まる必要のある食い違いは無い**（D1〜D13・A と違う作りは採らない）。D・A・Issue の文面だけでは一意に決まらず、この文書が解釈を選んだ点を次に挙げる。レビューで解釈が違えば、ここを直してから実装する。

| # | 文面 | 選んだ解釈 | 理由 |
|---|---|---|---|
| S1 | A §2.1 の `session := "session:" session-or-run-id`（中身は未定義）。fixture の例は `session:run-42` | **`session:` の ID に名前空間を付ける**：`task:<task id>`・`verify:<run id>`・`schedule:<execution log id>` の 3 つだけ（§1.6）。B の実装で A の `parseCloseWhen` の `session` の枝をこの 3 つに狭め、fixture の `inputs.session` を `session:task:run-42` に、`invalid` に `session:run-42` を足す（fixture の `$comment` が「close-when.ts と一緒にだけ変える」と定めている［事実：`close-when-v1.json:2`］）。B より前に保存された名前空間の無い値は、評価で **不明**（`session_kind_unknown`）にして閉じない | CommandMate が終わりを記録している「run」は DB の 3 つの表だけ。tmux のセッション名と PID は、別のホスト・サーバの再起動・作り直しを区別できない（Issue「PID の再利用・別のホスト・サーバの再起動を区別できない条件は扱わない」）。書き込みの時点で断るほうが、閉じない項目を黙って作らない |
| S2 | Issue「`expired` / `cancelled` は『返答を得た』ではない」 | relay の `expired`・`cancelled` は、保留と未配送の payload が無ければ **成立**（終端）とし、終了の記録の成否を `failure`、理由を `relay-expired` / `relay-cancelled` にする（§2）。「返答を得た」（`success`）は `delivered` だけ | 終端の状態から返答は二度と出ない（`OPEN_RELAY_STATES = ['pending','prompt']`、`src/lib/relay/types.ts:29`）。不成立のまま残すと、待つ相手のいない `waiting` が残り続ける。D8 の「条件の成立と意図の達成を分ける」をそのまま使う |
| S3 | Issue「CommandMate が元から観測している出来事（relay の終端・worktree の削除・セッションの終了）は、その場で評価してよい」 | **第 1 版では使わない**。評価は `mem list`・`mem check`・brief（C）・画面の preview（G）の読みだけ | relay・worktree・task の書き手（`relay-db*.ts`・`worktree-db.ts`・`tasks-db.ts`）から mem を呼ぶと import の向きと transaction の境界が増える。読みだけで受入基準を満たせる。必要になったら別 Issue |
| S4 | Issue「画面の『未配送の知らせ』の一覧に残し、人が引き取れるようにする」 | B は一覧と引き取りの **API と DB** を作る。画面の部品は G（#4227） | 画面は G の範囲（Epic の子の分け方）。B の受入基準は API の試験で満たす |
| S5 | A §2.2「host・owner・repo は大文字小文字を保存のまま」 | GitHub への照会は **host の許可表** を通る（§1.2）：`github.com` と、項目の repository の `origin` の host だけ。ほかは不明（`host_not_allowed`） | `gh` は github.com 以外の host に `GH_ENTERPRISE_TOKEN` を送る［見立て：gh の環境変数の仕様。実測は §12 U2］。Agent が書いた任意の host へサーバの token を送らない |
| S6 | A §10.1・§10.4 の instance の世代（roster の寿命）と、Issue の「作成者のセッションが終わっていれば次の世代のセッション」 | **「作成者が終わった」＝作成者の instance の世代（roster の寿命）が終わった**（roster から外れた・ツールを変えた・worktree を消した）と定める。tmux の kill・サーバの再起動・同じ世代の再起動は終わりではなく、同じ世代の次の brief が作成者として受け取る。「次の世代」の証拠に要るので、v67 で A の `mem_instance_incarnations` に `issued_by`（`'roster'`＝追加・全置換の新しい組で作った、`'lazy'`＝mem が派生の primary に後から発行した、`NULL`＝v67 より前）を **足す**（列の追加だけで A の世代の意味は変えない。§3.3） | 事前レビュー P2-4：発行の時刻はセッションの開始の証拠にならない（派生の primary は初回の書き込みで今の時刻の世代を得る、`service.ts` の `lookupActor`・A §10.4）。roster の寿命で定めるのは A §10.5「主な世代は永続する instance の世代」と同じ。合意は §12 U9 |

---

## 1. 型ごとの評価の表

### 1.1 共通

- 結果は 3 値：**成立**（`met`）・**不成立**（`not-met`）・**不明**（`unknown`）。不明は閉じない。どの結果にも `reason`（固定の語彙、§1.9）を付ける。本文・照会の生の出力・stderr は結果にもログにも出さない（A §7 と同じ）
- 評価の入口は 1 つ：`evaluateMemConditions(db, target, ctx)`（新規 `src/lib/mem/evaluate.ts`）。`ctx = { trigger: 'list'|'check'|'brief'|'preview', caller?: {worktreeId, instanceId}, limits?, deps }`
- 評価する項目：対象のブランチの `open` の項目と `now` の枠のうち、`close_when` が `manual`・`replaced`・NULL（decision の `promoted` 既定）でないもの。decision は `open`・`recorded` も評価する（結果を出すだけで閉じない、§5）・`promoted` は閉じうる
- `readStoredCloseWhen` が `null` を返す値（知らない `schema`・壊れた JSON）は不明（`schema_unknown`）［事実：`src/lib/mem/close-when.ts:302`］
- 照会の種類と上限（1 回の評価＝1 回の `evaluateMemConditions` の呼び出し）：

| 種類 | 例 | 1 回の照会のタイムアウト | 1 回の評価の上限 | 同時に走らせる数 |
|---|---|---|---|---|
| 外の照会 | `gh api`・`git ls-remote` | 5,000 ms | **8 回**（brief は C が 4 を渡す見立て） | 4 |
| 手元の git | `rev-parse`・`merge-base`・`cat-file`・`reflog`・`remote get-url` | 3,000 ms | 24 回 | 4 |
| DB | relay・worktree の世代・task・verify・schedule | — | 数えない（同期・手元） | — |
| 全体の期限 | — | list・check は 10,000 ms、brief・preview は呼び手が渡す（C の見立て 3,000 ms） | — | — |

- **上限を超えた・期限を過ぎた**照会は実行せず、その照会に頼る項目を不明（`query_budget_exhausted` / `deadline_exceeded`）にする。評価の順は項目の `created_at` の古い順（決まった順にして、毎回同じ項目が後回しにならないことより、同じ入力で同じ結果を優先する）［見立て］
- **同じ対象の照会は 1 回にまとめる**：照会の鍵（§1.2〜§1.4）で 1 回の評価の中の重複を 1 つにし、結果を全項目で共有する。同時に走る別の評価とは、**実行中の照会だけ**を鍵で共有する（終わったら捨てる。時間で持つキャッシュは作らない＝タイマーも期限の掃除も要らない、§7）
- **共有してよい鍵の条件**（事前レビュー P1-1）：鍵は「照会の結果が答える範囲」を全部含む。同じ鍵の結果は、どの呼び手が読んでも同じ問いへの答えでなければならない。呼び手ごとに違う引数（照会する ref の集合など）を鍵の外に置かない。`ls-remote` は §1.4 のとおり全 head の一覧を取る
- **共有の照会の寿命と、呼び手の待ちを分ける**（事前レビュー P2-5）：共有の項目（`query-plan.ts` の `SharedQuery`）は `{promise, abort: AbortController, waiters}` を持つ。子プロセスの寿命は **照会自身のタイムアウト**（表の 5,000 / 3,000 ms、`execFile` の `timeout`）と `abort` だけで決まり、どの呼び手の期限でも kill しない。呼び手は自分の期限（`withDeadline`）で待ちをやめ（`waiters-1`、自分の結果は `deadline_exceeded`）、**最後の呼び手が離れたとき（`waiters == 0`）に `abort()` で子を kill し、共有の項目を消す**。照会が終われば（成功・失敗・タイムアウト）項目を消す。期限の `setTimeout` は呼び手ごとに `finally` で `clearTimeout` する
- 子プロセスは `execFile`（shell なし、引数は配列）。`timeout` は `execFile` の option で、終われば消える（常駐しない）。環境は `GH_PROMPT_DISABLED=1`・`GIT_TERMINAL_PROMPT=0` を足し、対話を待たない

### 1.2 `issue`

| 項目 | 内容 |
|---|---|
| 照会の先 | `gh api --hostname <host> repos/<owner>/<repo>/issues/<n>`（`state`・`state_reason`・`pull_request` だけを読む） |
| 照会の鍵 | `gh-issue:<host 小文字>/<owner 小文字>/<repo 小文字>#<n>` |
| 成立 | `state == "closed"`。成否は `state_reason == "completed"` → `success`、`not_planned` → `failure`、それ以外・無し → `unknown` |
| 不成立 | `state == "open"`（`issue-open`） |
| 不明 | 404（`not_found`）・401／未ログイン（`unauthenticated`）・403（`forbidden`、本文に rate limit の語があれば `rate_limited`）・5xx（`remote_error`）・接続できない（`offline`）・タイムアウト（`query_timeout`）・`gh` が無い（`gh_unavailable`）・JSON が読めない（`unexpected_response`）・`pull_request` がある＝番号が PR（`not_an_issue`）・host が許可表に無い（`host_not_allowed`） |

- **host の許可表**（S5）：`github.com`、または項目の repository（`close_when` を書いた root。`repositoryId` は `mem_items.repository_id`）の `git remote get-url origin` を A の `parseOriginUrl`（`close-when.ts:220`）で読んだ host。比較は小文字。`origin` の読みは手元の git として数え、repository ごとに 1 回にまとめる
- 分類は `gh` の exit code と stderr の `HTTP <3 桁>` の語で行う。stderr の全文は捨てる。既存の `getIssueInfo` は失敗をすべて `null` に畳むので使わない［事実：`src/lib/git/github-api.ts:45-60`。新しい `src/lib/mem/github-query.ts` を書く］

### 1.3 `pr`

| 項目 | 内容 |
|---|---|
| 照会の先 | `gh api --hostname <host> repos/<owner>/<repo>/pulls/<n>`（`state`・`merged_at` だけ） |
| 照会の鍵 | `gh-pr:<host>/<owner>/<repo>#<n>`（`issue` とは別の鍵） |
| 成立（`state=merged`、既定） | `merged_at != null`。成否 `success`、理由 `pr-merged` |
| 成立（`state=closed`） | `state == "closed"`（merge の有無を問わない）。成否は merge 済み → `success`、未 merge → `failure`。理由 `pr-closed` |
| 不成立 | `state == "open"`（`pr-open`）。`state=merged` で `closed` かつ未 merge（`pr-closed-unmerged`。開き直せるので不成立） |
| 不明 | `issue` と同じ分類。404 は番号が PR でない場合も含む |

### 1.4 `branch`

保存の形：`{repositoryId, name, event, into, scope, tipAtCreate}`（A §2.2）。git は `repositoryId` の root の path で走らせる（refs は common-dir で共有されるので、どの worktree でも同じ）。root が無い・無効・ディスクに無い → 不明（`repository_unavailable`）。remote は `origin` だけ（項目は remote の URL を持たない。任意の URL へは繋がない）。

**ブランチの同一性**（「削除の後に同名で作り直されたものは別物」）［見立て］：

| 状態 | 判定の材料 |
|---|---|
| 無い（`gone`） | local：`git rev-parse --verify --quiet refs/heads/<name>^{commit}` が exit 1。remote：`git ls-remote --heads origin`（全 head の一覧、§1.4 の注）が exit 0 で、一覧に `refs/heads/<name>` が無い |
| 同じ（`same`） | ref があり、`tipAtCreate` がその tip の祖先か同じ（`git merge-base --is-ancestor`）。local は加えて、ref の作成の時刻（下の注）が項目の `created_at` より後**でない** |
| 作り直し（`recreated`） | local で、ref の作成の秒 S が項目の `created_at` より確実に後（`S × 1000 > created_at`。`tipAtCreate` が空でないときだけ使う。§1.4 の空の tip の規則） |
| 前後が言えない（`order-uncertain`） | local で、ref の作成の秒 S が項目の `created_at` と同じ秒（`S == floor(created_at / 1000)`）。reflog は秒、項目はミリ秒なので、どちらが先かを言えない（事前レビュー 2 回目 ②）。祖先の判定が `same` を示しても `same` にしない |
| 区別できない（`diverged`） | ref はあるが `tipAtCreate` が祖先でない（作り直し・rebase・force push のどれかで、remote では見分けられない） |
| 取得できない | 手元の git が exit 0/1 以外・タイムアウト、`ls-remote` が exit 128 等（`offline`・`query_timeout`・`remote_error`）、祖先の判定に要る object が手元に無い（`objects_missing`） |

- **同じ秒**（事前レビュー 2 回目 ②）：reflog の時刻は秒、項目の `created_at` は `Date.now()` のミリ秒［事実：`createMemItem` の `now`、`src/lib/db/mem-db.ts`］。作成の秒 S について、`S × 1000 > created_at` なら確実に後（`recreated`）、`(S + 1) × 1000 <= created_at` なら確実に前（祖先の判定へ）、どちらでもない＝同じ秒は `order-uncertain`（不明）。閉じないほうへ寄せる（同じ秒に枝を作ってすぐ項目を書いた場合も不明のまま。人が閉じる。§12 U3）
- **ref の作成の時刻**（事前レビュー P1-4）：commit の時刻（`%ct`・`%at`）は使わない。古い commit から作り直したブランチでも commit の時刻は古いままだから。使うのは **reflog の項目そのものの時刻**（ref を書き換えた時刻）：`git reflog show --date=unix --format=%gd%x09%gs refs/heads/<name>` の `%gd`（実測：git 2.49 で `<name>@{<unix 秒>}` の短い形。末尾の `@{<数字>}` だけを読む）から秒を取り、最も古い項目が「`branch: Created from`」で始まるときだけ、その秒を作成の時刻とする。最も古い項目が作成の行でない（改名・期限切れで切れた）・reflog が無い（`core.logAllRefUpdates=false`）ときは作成の時刻は **不明** として reflog の条件を使わず、祖先の判定だけで `same` / `diverged` を決める（§12 U3 の限界）。`%gd` の形は実装の契約で実際の git で確かめる（§9.3 の P1-4 の試験は `os.tmpdir()` の中の実 repository で行う）
- **remote の head は全件を 1 回で取る**（事前レビュー P1-1）：`git ls-remote --heads origin`（ref の引数なし）を repository ごとに 1 回（鍵 `ls-remote-heads:<repositoryId>`）。返るのは全 head の一覧なので、どの呼び手のどの ref も「一覧に無い＝無い」と読める。ref を引数で絞った照会を共有すると、照会しなかった ref を「無い」と読むので、絞った形を作らない。出力は `maxBuffer` 8 MB、超えたら不明（`unexpected_response`）。**`git fetch` はしない**（利用者の repository の refs を書き換えない・定期の照会を足さない）
- **空の `tipAtCreate`**（事前レビュー P2-1）：今の A は `deleted` の条件で tip を取らず空文字を保存する［事実：`closeWhenGitNeeds` は `merged` だけ tip を求める、`src/lib/mem/close-when.ts:211-216`。`finalizeCloseWhen` は `deleted` で `tipAtCreate: ''`、`:267-283`］。B は次の 2 つを行う。評価の時の tip を作成の時の tip として補うことはしない
  1. **新しい保存**：B の実装で `closeWhenGitNeeds` を `deleted` でも tip を求めるように変え、保存の時に ref があればその tip、無ければ空文字を入れる（`deleted` は ref が無くても保存を断らない。`merged` は今どおり tip が無ければ断る）。tip を読む ref は scope で分ける：`local` → `refs/heads/<name>`、`remote` → `refs/remotes/origin/<name>`（無ければ `refs/heads/<name>`）。fixture に `deleted` の保存値（tip あり・空の 2 つ）を足す
  2. **空の tip の評価**（A が既に保存した値と、保存時に ref が無かった値）：同一性の証拠が無いので `gone`（成立）・ref がある（不成立、`branch-present-no-baseline`）・取得できない（不明）の 3 つだけにし、`recreated`・`diverged` を **出さない**（根拠の不足を作り直しや削除と読まない）

**`event = deleted`**

| 同一性 | 結果 |
|---|---|
| `gone` | 成立（`branch-deleted`、成否 `unknown`） |
| `recreated`（local だけ） | 成立（`branch-recreated`。元のブランチは無い） |
| `same` | 不成立（`branch-present`） |
| ref がある・`tipAtCreate` が空 | 不成立（`branch-present-no-baseline`） |
| `diverged` | **不明**（`branch-diverged`。rebase を削除と読まない） |
| `order-uncertain` | **不明**（`branch-order-uncertain`。同じ秒の作り直しを `same` と読まない） |
| 取得できない | 不明（理由はそのまま）。「ref が無い」と「取得できない」を分ける |

- 「削除の未同期」：remote の削除は `ls-remote` で直接見るので、手元の `refs/remotes/origin/<name>` が残っていても関係ない。local の削除は refs をそのまま見る

**`event = merged`**（`into` へ、作成したときの tip より後の commit を含んで入った）

1. ブランチの頭 H を決める：`same` なら今の tip。`gone`・`recreated`・`diverged` なら H は無い
2. H があり **H == tipAtCreate** → 不成立（`no-new-commits`。共通の祖先を指すだけの新しいブランチ）
3. H があり、H が `into` の tip（scope に従い local の `refs/heads/<into>` か `ls-remote` の値）の祖先 → 成立（`branch-merged`、`success`）
4. scope が `remote` のとき、squash・rebase の merge と「merge の後にブランチを消した」を GitHub で見る：`gh api --hostname <origin の host> 'repos/<o>/<r>/pulls?state=closed&base=<into>&head=<o>:<name>&per_page=20'`（鍵 `gh-pr-head:<host>/<o>/<r>:<name>:<into>`、値は URL エンコード）。次の **すべて** を満たす PR があれば成立（`branch-merged-pr`、`success`）（事前レビュー P2-2：同名の過去の PR を拾わない）
   - `merged_at != null` かつ **`merged_at` が項目の `created_at` より後**（項目を書く前に終わった作業ではない）
   - `head.sha != tipAtCreate` かつ `tipAtCreate` が `head.sha` の祖先（手元に object があれば `merge-base`、無ければ `gh api repos/<o>/<r>/compare/<tipAtCreate>...<head.sha>` の `status == "ahead"`）
   - **今の頭との対応**：H があれば（`same`）`head.sha == H`（今のブランチの頭そのものが merge された。merge の後に積んだ未 merge の commit があれば当たらない）。H が無い（`gone`）ときは上の 2 つだけ。`recreated`・`diverged` のときは PR の証拠を使わない（項目が追う作業との対応が言えない）
5. それ以外：H があれば不成立（`not-merged`）。H が無く（`gone`・`recreated`）scope が local なら不明（`branch-gone-unmerged-unknown`：merge の後に消したのか、merge せずに消したのかを手元だけでは言えない）。`diverged` は不明（`branch-diverged`）、`order-uncertain` は不明（`branch-order-uncertain`。H を決めない＝1〜4 に入らない）
- **合流先が違う**：判定は `into` だけを見る。`main` に入っていても `into=develop` なら 3・4 に当たらず不成立
- **remote が取得できない**：`ls-remote` が失敗 → 不明（`offline` 等）。4 の `gh` が失敗し、1〜3 で決まらない → 不明
- **作り直し**：`recreated`・`diverged` の新しいブランチの merge は、2〜4 で元の項目の成立に数えない。remote で、作り直したブランチが `tipAtCreate` の子孫から始まっていると見分けられない（§12 U3）

### 1.5 `relay`

照会の先：`getRelayById(db, relayId)`（`src/lib/db/relay-db-base.ts:16`）。照会の数に数えない。行が無い → 不明（`relay_not_found`。relay の行は両端の worktree の削除で CASCADE で消える［事実：`v60-session-relays.ts:79-80`］）。判定は §2 の表。

### 1.6 `session`（S1 の 3 つの名前空間）

| 名前空間 | 照会の先（DB） | 成立（理由・成否） | 不成立 | 不明 |
|---|---|---|---|---|
| `task:<id>` | `getTask(db, id)`（`src/lib/db/tasks-db.ts:202`） | `succeeded`（`task-succeeded`・`success`）、`cancelled`（`task-cancelled`・`failure`） | `pending`・`running`・`waiting_input`・`verifying`（生きているが止まっている＝rate limit・確認待ちを含む）、`failed`・`not_started`（再検証で開き直せる［事実：`VERIFIABLE_TASK_STATUSES`、`tasks-db.ts:81`］。理由 `task-reopenable`） | 行が無い（`session_not_found`） |
| `verify:<run id>` | `getVerificationRun`（`src/lib/db/verification-db.ts:442`） | `passed`（`success`）、`failed`・`error`・`not_started`・`cancelled`（`failure`）。理由 `verify-<status>` | `running` | 行が無い・数字でない |
| `schedule:<id>` | `execution_logs` の行（新しい読み関数、`src/lib/db/` の既存の schedule の DB 関数の隣） | `completed`（`success`）、`failed`・`timeout`・`cancelled`（`failure`）。理由 `schedule-<status>` | `running` | 行が無い |
| 名前空間なし（B より前の値） | — | — | — | 常に不明（`session_kind_unknown`） |

- **サーバの再起動の後**：task の状態は出来事でだけ動き、再起動では変わらない（tmux のセッションは再起動を越えて続く）ので、`running` は再起動の後も不成立のまま［事実：`src/lib/tasks/task-state-machine.ts:10-14`］。verify の `running` は起動時に `error` へ閉じられ［事実：`src/lib/verification/verification-reconciler.ts:43-61`］、schedule の `running` は起動時に `failed` へ閉じられる［事実：`src/lib/job-executor.ts:139-146`］。どちらも「実行していたプロセスは無い」という記録で、B はそれを成立（`failure`）と読む。再起動を「終わった＝成功」とは読まない
- `sessionGeneration`（A の保存の欄）は 3 つの名前空間では使わない（ID が UUID か AUTOINCREMENT で、作り直しで同じ ID が出ない［見立て：DB のリセットは対象外］）

### 1.7 `worktree`

照会の先：`worktreeIncarnationAlive(db, worktreeIncarnation)`（`src/lib/mem/incarnation.ts:102`）。保存した世代の存続で決め、ID では引かない（A §2.1、2 回目のレビュー 5）。

| 状態 | 結果 |
|---|---|
| 世代の行がある（同じ ID・改名後の新しい ID のどちらでも） | 不成立（`worktree-alive`）。改名は削除ではない |
| 世代の行が無い（削除・同じ path での作り直し） | 成立（`worktree-deleted`・`unknown`） |
| 保存の値に `worktreeIncarnation` が無い・空 | 不明（`schema_unknown`） |

- 「削除の未同期」：ディスクから消えても DB の行が sync まで残る間は世代が残るので不成立（閉じない）。B はディスクを見ない
- fixture の `worktreeLifecycle`（`close-when-v1.json`）の 3 行を、B の評価でもそのまま通す

### 1.8 `at`

- `now >= epochMs` → 成立（`time-passed`・`unknown`）。それより前 → 不成立（`time-not-yet`）。不明は無い。`now` はサーバの時計（`deps.now`）

### 1.9 理由の語彙（`reason`）

成立・不成立の理由は上の各表の語。不明の理由は `not_found`・`unauthenticated`・`forbidden`・`rate_limited`・`remote_error`・`offline`・`query_timeout`・`gh_unavailable`・`unexpected_response`・`not_an_issue`・`host_not_allowed`・`repository_unavailable`・`objects_missing`・`branch-diverged`・`branch-order-uncertain`・`branch-gone-unmerged-unknown`・`relay_not_found`・`relay-delivery-uncertain`・`session_not_found`・`session_kind_unknown`・`schema_unknown`・`query_budget_exhausted`・`deadline_exceeded`。語は `src/types/mem.ts` に定数で置き、CLI・画面・C は語で分岐する（文面で分岐しない）。

---

## 2. relay の状態と配送の保留の対応表

relay の行の読み［事実：`src/lib/relay/types.ts`］：`state`（`:26`）、`pendingKind`（`'reply'|'prompt'|'expired'|null`、`:204`）、`deliveryHold`（`{state:'attempting'|'uncertain', …}|null`、`:225`・`:107`）。`delivered` への close は payload を空にし（`closeRelayDelivered`、`src/lib/db/relay-db-delivery.ts:28-43`）、取り消しは保留の payload を残す（`cancelRelay`、`src/lib/db/relay-db.ts:370`）。

| `state` | `deliveryHold` | `pendingKind` | 結果 | 理由・成否 |
|---|---|---|---|---|
| `pending` | どれでも | どれでも | 不成立 | `relay-open` |
| `prompt` | どれでも | どれでも | 不成立 | `relay-prompt`（B の確認待ち。答えれば返答が出る） |
| `delivered` | `null` | `null` | **成立** | `relay-delivered`・`success` |
| `delivered` | `attempting` | どれでも | 不成立 | `relay-delivery-attempting` |
| `delivered` | `uncertain` | どれでも | **不明** | `relay-delivery-uncertain`（人が `relays resolve` で決めるまで） |
| `delivered` | `null` | 非 `null` | 不成立 | `relay-payload-pending` |
| `expired` / `cancelled` | `null` | `null` | **成立**（S2） | `relay-expired` / `relay-cancelled`・`failure` |
| `expired` / `cancelled` | `null` | 非 `null`（期限切れの知らせ・取り消し前の返答が A へ未配送） | 不成立 | `relay-payload-pending`（`listClosedRelaysWithPendingPayload` が拾う行、`relay-db.ts:337`） |
| `expired` / `cancelled` | `attempting` | どれでも | 不成立 | `relay-delivery-attempting` |
| `expired` / `cancelled` | `uncertain` | どれでも | **不明** | `relay-delivery-uncertain` |
| 行が無い | — | — | 不明 | `relay_not_found` |

- 「保留が残っている relay では閉じない」：`deliveryHold != null` の行は、`state` に関係なく成立にしない（`attempting` は動いている途中なので不成立、`uncertain` は届いたか分からないので不明）
- `delivered` に保留が付く組は、今の書き手では作られない見立て（close と保留の終わりは同じ transaction、`relay-db-delivery.ts:110-139`）。表は防御として全組を決める［見立て］
- `lastDeliveryBlock`（メモリだけの観測、`types.ts:182`）は見ない。再起動で消えるため

---

## 3. 終了の記録と「終わった」の知らせ

### 3.1 schema（`src/lib/db/migrations/v67-mem-close-records.ts`、`CURRENT_SCHEMA_VERSION = 67`）

今の最新は v66［事実：`src/lib/db/migrations/runner.ts:34`、`v66-mem-store.ts`］。

```sql
-- 終了の記録：条件による close 1 件に 1 行（D8：条件の成立と、終了の理由・成否を分ける）
CREATE TABLE mem_close_records (
  item_id TEXT PRIMARY KEY REFERENCES mem_items(id) ON DELETE CASCADE,
  condition_json TEXT NOT NULL,        -- close した時点の close_when（保存の JSON のまま）
  condition_type TEXT NOT NULL,
  evaluated_version INTEGER NOT NULL,  -- 評価した項目の版（close の前）
  observation_json TEXT NOT NULL,      -- 照会の結果：{source, observedAt, facts}。facts は §1 の表の読んだ欄だけ（本文・stderr を入れない）
  end_reason TEXT NOT NULL,            -- §1 の成立の理由（issue-closed, relay-expired, …）
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','unknown')),
  trigger TEXT NOT NULL CHECK (trigger IN ('list','check','brief','preview')),
  triggered_by_worktree_ref TEXT,      -- 評価を呼んだ側（所有者ではない）。worktree_id と名付けない（§3.4）
  triggered_by_instance_id TEXT,
  closed_at INTEGER NOT NULL
);

-- 配送の試み：D が brief に入れて送る 1 回
CREATE TABLE mem_notice_attempts (
  id TEXT PRIMARY KEY,
  boot_id TEXT NOT NULL,               -- サーバのプロセスの boot id（§3.5）
  recipient_worktree_ref TEXT NOT NULL,
  recipient_instance_id TEXT NOT NULL,
  recipient_incarnation TEXT,          -- A の instance の世代。行が無い枠は NULL（§3.3 (a)）
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  result TEXT CHECK (result IN ('sent','not-sent','indeterminate','abandoned')),
  CHECK ((settled_at IS NULL) = (result IS NULL))
);

-- 「終わった」の知らせ：close 1 件に 1 つ
CREATE TABLE mem_notices (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE REFERENCES mem_items(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,          -- 項目の所属（FK なし、A §5.2 と同じ）
  branch TEXT,
  origin_worktree_ref TEXT NOT NULL,    -- 元の作成者（A の origin_* をそのまま写す）
  origin_worktree_incarnation TEXT NOT NULL,
  origin_instance_id TEXT NOT NULL,
  origin_cli_tool_id TEXT NOT NULL,
  origin_incarnation TEXT NOT NULL,
  item_created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','reserved','acknowledged')),
  attempt_id TEXT REFERENCES mem_notice_attempts(id),
  attempt_audience TEXT CHECK (attempt_audience IN ('creator','successor')), -- 予約したときの区分。知らせごと（事前レビュー P2-3）
  uncertain_count INTEGER NOT NULL DEFAULT 0,   -- 配送の結果が不明だった回数
  acknowledged_at INTEGER,
  acknowledged_by TEXT CHECK (acknowledged_by IN ('creator','successor','human')),
  acknowledged_instance_id TEXT,
  acknowledged_incarnation TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((state = 'reserved') = (attempt_id IS NOT NULL)),
  CHECK ((attempt_id IS NULL) = (attempt_audience IS NULL)),
  CHECK ((state = 'acknowledged') = (acknowledged_at IS NOT NULL))
);
CREATE INDEX idx_mem_notices_scope ON mem_notices(repository_id, branch, state);

-- A の世代の表に、世代を作った経路を足す（S6・§3.3 (b)）。列の追加だけ
ALTER TABLE mem_instance_incarnations ADD COLUMN issued_by TEXT CHECK (issued_by IN ('roster','lazy'));
-- 既存の行は NULL（v67 より前。経路が分からないので「後から生まれた」の証拠にしない）
```

- 1 つの試み（brief 1 回）に作成者の知らせと前の世代の知らせが混ざってよい。区分は試みではなく **知らせの行**（`attempt_audience`）に持ち、受領の区分（`acknowledged_by`）はその値から決める（事前レビュー P2-3）
- `issued_by` を書くのは A の世代の発行の口だけ：`addAgentInstance`・`setAgentInstances` の新しい組（A §10.4 の表で「新しく作る」行）→ `'roster'`、`mem-db.ts` の `settleActorIncarnation`（派生の primary の初回の mem の書き込み。A §10.4 の「mem が初めて書くときに作る」。第 2 版は経路を `service.ts` と書いていた）→ `'lazy'`。`startInstanceIncarnation`（`incarnation.ts`）に引数を 1 つ足す
- **最初の roster の保存は「後から生まれた」の証拠にしない**（事前レビュー 2 回目 ①）：worktree に `agent_instances` の行が 1 つも無い（roster が派生のまま）ときの保存（`setAgentInstances`・`addAgentInstance`）では、primary の組（`instance_id == cli_tool_id`）は派生で前から居た primary が明示の roster に写されただけかもしれない。その組の新しい世代は `'lazy'` にする（証拠にしない）。primary でない ID（`codex-2` 等）は派生では生まれないので `'roster'`。最初の保存で本当に新しく足した primary も `'lazy'` になる（閉じないほう＝渡さないほうへ寄せる。知らせは (a)・画面の一覧に残る）

- `REFERENCES mem_items(id) ON DELETE CASCADE` は `foreign_keys = ON` で効く［事実：`src/lib/db/db-instance.ts:147`］。`mem purge` が項目を消すと記録と知らせも消える（purge の dry-run の件数に `notices` を足す、§9.2）
- 項目の側は A の列のまま：`mem_items.state='closed'`・`close_reason='condition'`・`updated_by='server'`［事実：`MEM_CLOSE_REASONS`、`src/types/mem.ts:20`］。`now` の枠の項目は A の退避（`archiveSlot`、`src/lib/db/mem-db.ts:489`）で `mem_items` へ `condition` として移してから記録を書く

### 3.2 close の手順（1 回の評価）

1. 同期：対象を解決（`withMemTarget`、mode が `on` のときだけ先へ、§4）。評価する項目の `(id, version, close_when)` を読んで固定する
2. 非同期：§1 の照会（上限・期限・まとめ）
3. 同期の区間・1 つの `db.transaction`：成立の項目ごとに
   - mode を項目の `(repositoryId, branch)` について DB の設定から決め直す（`decideRootMode`、`mem-db.ts:254`。対象の `members` の全 root で `on` が一致するときだけ。git は待たない）
   - 項目を読み直し、`version` と `close_when` が 1 で固定した値と同じで、`memTransition(kind, state, 'condition')` が通るときだけ close（`transitions.ts:36`・`:49`）。違えば何もしない（次の評価で決め直す）
   - 終了の記録と知らせを同じ transaction で書く（`mem_notices.item_id` の UNIQUE で 2 つ目は作られない）
4. 結果を返す：項目ごとに `{result, reason, closed, unreflected?}`

並行する評価（他の instance の brief・`check`・画面の preview）が同じ項目を同時に閉じようとしても、3 の版の照合で close も記録も知らせも 1 つだけになる。

### 3.3 作成者と受取先

- **元の作成者**は知らせの `origin_*`（A の `origin_incarnation` 等）。変えない
- **作成者が生きているか**は、世代の ID（`mem_instance_incarnations.incarnation` は UNIQUE、A §10.1）で引く：新規 `instanceIncarnationAlive(db, incarnation)`（`incarnation.ts`、`worktreeIncarnationAlive` と同じ作り）。**来歴の worktree ID（`origin_worktree_ref`）では引かない**。worktree の改名で世代の行は新しい ID へ付け替わり［事実：通常の改名は子の行の `worktree_id` を新しい ID へ更新する、`src/lib/db/migrations/worktree-id-rename.ts:172-178`］、作成者は生きたまま（事前レビュー P1-3。A の所有の判定も同じく世代で照合し、来歴の worktree ID を比べない［事実：`ownedBy`、`src/lib/db/mem-db.ts:856-863`］）
- **作成者の終わり**の定義は S6：作成者の instance の世代が無くなったとき。tmux の kill・サーバの再起動・同じ世代の作り直しの無い再起動は終わりではない（同じ世代の次の brief が作成者として受け取る）
- **今の受取先**は保存せず、受け取りを求められた時点で、1 つの関数 `noticeAudience(db, notice, recipient) → 'creator' | 'successor' | null` で決める。C の一覧（`listMemNoticesFor`）・D の予約（`reserveMemNotices`、transaction の中で決め直す）・G の未配送の一覧の状態の表示は、すべてこの関数を呼ぶ（判定を写さない）：

| 受け取りを求めたセッション R（worktree・instance・世代） | 条件 | 結果 |
|---|---|---|
| 作成者 | `R.incarnation == origin_incarnation`（worktree ID は比べない。改名の後の新しい ID からでも作成者） | `creator` |
| 次の世代 (a) 同じ枠 | 作成者が生きていない かつ `R.instanceId == origin_instance_id` かつ R の worktree が作成者の worktree（`resolveWorktreeIdWithAlias(db, origin_worktree_ref)` で改名を辿った今の ID、`src/lib/db/worktree-alias-db.ts:85`）かつ R が同じ repository（読む範囲の root）・同じブランチ。R の世代は作成者と違う・または行が無い | `successor`。`(worktree_id, instance_id)` は世代の表の主キー（A §10.1）なので、作成者の行が無くなった後のこの枠の世代は、発行の時刻に関係なく作成者より後 |
| 次の世代 (b) 同じブランチの別の枠 | 作成者が生きていない かつ R が同じ repository・同じブランチ かつ R の世代が `issued_by='roster'` で `created_at > item_created_at` | `successor`。roster の追加・全置換で作った世代だけが「項目より後に生まれた」の証拠になる。`'lazy'`・`NULL` の世代（前から居た派生の primary が後から発行を受けたもの）は証拠にしない（事前レビュー P2-4） |
| それ以外（作成者が生きている間の他の instance、前から居る別の instance、行の無い別の枠） | — | `null`（渡さない） |
| 画面（人） | — | 一覧に出す。人が引き取ると `acknowledged_by='human'` |

- **instance ID の再利用**：同じ ID の新しい世代は「作成者」にならない（世代で比べる、A §10.4）。(a) の「次の世代」として、前の世代の知らせだと分かる形で渡る（C は「前の世代（`<origin_instance_id>`、<作成時刻>）の項目」として出し、R 自身の項目として出さない）
- **作成者が終わっている**（`session` の条件で閉じた場合を含む）：(a)・(b)。どちらも居なければ画面の一覧に残る（消えない）
- **副作用の整理**（事前レビュー P2-4 の追記）：`noticeAudience` と `listMemNoticesFor` は **何も書かない**（世代を作らない・古い試みを戻さない）。書き込みは §3.5 の表の「書くもの」の欄に挙げたものだけ。第 1 版の「受け取りの transaction で R の世代を作る」はやめた（行の無い枠は (a) で扱え、(b) には使わない）

### 3.4 列名

`worktree_id` という名前の列を持たない（`origin_worktree_ref`・`recipient_worktree_ref`・`triggered_by_worktree_ref`）。`getWorktreeChildTables` は `worktree_id` 列を持つ表を worktree の子として削除する［事実：`src/lib/db/migrations/worktree-child-tables.ts:24`］。知らせは作成者の worktree が消えても残らなければならない（A §10.3 と同じ理由）。

### 3.5 受領の確定（D の配送の結果を受ける口）

新規 `src/lib/mem/notices.ts`。C・D・G はこの関数だけを使う：

| 関数 | 呼び手 | 動き |
|---|---|---|
| 関数 | 呼び手 | 返すもの | 書くもの |
|---|---|---|---|
| `listMemNoticesFor(db, recipient)` | C（brief の候補を選ぶ）・G（preview） | 受け取れる知らせと、知らせごとの `audience`・`uncertain`（前回の配送が確かめられなかったか。古い試みに予約されたままの知らせは、次の予約で `+1` されるのを先に数えた値）。他の試みが `reserved` にしている知らせは出さない。古い試み（下の再起動・10 分）の知らせは `pending` として見せる | **何も書かない** |
| `reserveMemNotices(db, recipient, selections)` | D（送る本文を確定する前） | `{ attemptId \| null, reserved: Array<{noticeId, audience, uncertain}> }`。**予約できた知らせの ID・区分・配送不明の印**（事前レビュー P1-2・2 回目 ③）。`selections` は `Array<{noticeId, uncertain}>`（C が一覧で読んで本文の予算に数えた印） | 1 つの transaction で：古い試みを `abandoned` にして知らせを `pending`・`uncertain_count+1` に戻す → 渡された ID のうち今も `pending` で `noticeAudience` が非 `null` で、**戻した後の印（`uncertain_count > 0`）が C の渡した `uncertain` と同じ**ものだけを `reserved`（`attempt_audience` も）にし、試みを 1 行作る。印が変わった知らせは予約せず `pending` のまま（次の brief が新しい印で選び直す）。1 件も取れなければ試みを作らず `attemptId: null`。保持の期限を過ぎた行の削除 |
| `settleMemNoticeAttempt(db, attemptId, sendState)` | D（送信の結果が出た後） | 処理した件数 | `sendState` は送信の到達確認の 3 値（`'sent'\|'not-sent'\|'indeterminate'`、`src/lib/session/send-attempt-types.ts:24`）。**`attempt_id = attemptId` の知らせだけ**を対象に：`sent` → 受領（`acknowledged_by` = その知らせの `attempt_audience`）。`not-sent` → `pending`。`indeterminate` → `pending`・`uncertain_count+1`（C は次の brief で「前回の配送が確かめられなかった知らせ」と付けて出す）。2 回目の settle は何もしない。保持の削除 |
| `acknowledgeMemNoticeByHuman(db, noticeId, version)` | G（画面の引き取り） | 結果 | `acknowledged_by='human'` |

**C・D の手順の契約**（事前レビュー P1-2。予約と送る本文を同じ ID の集合に結ぶ）：

1. C が `listMemNoticesFor` で候補を選ぶ（予算で省くのはここ）
2. D が選んだ ID で `reserveMemNotices` を呼ぶ
3. **C は予約の結果の `reserved` だけで知らせの部分を組み直す**（予約できなかった ID は本文から除く。区分の表示は `reserved` の `audience`、「前回の配送が確かめられなかった」の表示は `reserved` の `uncertain` を使う）。`reserved` の各行は、C が 1 で予算に数えたのと同じ印を持つ（印が変わった知らせは 2 で予約されない、事前レビュー 2 回目 ③）ので、組み直しで本文は短くなるだけで予算は超えない
4. D が送る。送る前に止めた（組み直しの失敗・送信の口に入らなかった）ときも `settle(attemptId, 'not-sent')` を呼ぶ
5. D が送信の結果で `settle` を呼ぶ。受領になるのは 3 で本文に入れた知らせ（＝その試みの知らせ）だけ

並行する 2 つの brief が同じ知らせを選んでも、2 で片方だけが予約でき、3 でもう片方の本文から除かれるので、同じ知らせが 2 つの本文に入らない。

- **受領にしない**：予算で省いた・配送の結果が不明・`check`・他の instance の brief（受け取れないので渡らない）・画面の preview（`listMemNoticesFor` は書かない）
- **サーバの再起動**：`reserved` のまま残った試みは、`boot_id` が今のプロセスの boot id（新規 `src/lib/mem/process-boot.ts`、`getOrInitGlobal` に `randomUUID()`。relay の `relayServerBootId` と同じ作り、`src/lib/relay/relay-boot.ts:30`）と違えば古い試みとし、`listMemNoticesFor` は `pending` として見せ（書かない）、次の `reserveMemNotices` の transaction で `indeterminate` と同じに戻す（`result='abandoned'`、知らせは `pending`・`uncertain_count+1`）。起動時の処理も時間の見張りも足さず、読んだときに比べる。同じプロセスで `reserved` のまま 10 分を過ぎた試みも、読んだときに同じ扱い［見立て：D の送信の期限より十分長い］
- **受領の後は繰り返さない**：`acknowledged` の知らせは `listMemNoticesFor` に出ない
- **保持**：`acknowledged` の知らせと settle 済みの試みは、受領から 30 日後、次の知らせの書き込み（close・reserve・settle）の同じ transaction で消す（A §8.3）。未受領は消さない。終了の記録は項目と同じ寿命（purge だけで消える）

---

## 4. mode が `off` / `derived` のときに評価・close・知らせを作らない作り

A の mode の表（A §4）をそのまま使う：

| 操作 | `off` | `derived` | `on` | 曖昧・未登録 |
|---|---|---|---|---|
| `mem list` | exit 50（A のまま。評価しない） | 0、`frozen:true`、**評価しない**（`condition` の欄を出さない） | 0、評価して結果つき | 52 / 53 |
| `mem check`（新規） | exit 50 | exit 50 | 0 | 52 / 53 |
| brief（C）・preview（G） | 評価しない | 評価しない | 評価する | 評価しない |
| close・終了の記録・知らせの作成 | しない | しない | する | しない |
| 知らせの受領（`reserve`・`settle`・人の引き取り） | しない（作成済みの知らせは残す） | しない | する | しない |
| 画面の未配送の一覧（読むだけ） | 出す（読みだけ） | 出す | 出す | 出さない |

作りの 3 か所：

1. **入口**：`evaluateMemConditions` の最初で `target.ok && target.mode === 'on'` でなければ、照会を 1 つもせずに空の結果を返す。呼び手（`memList`・`memCheck`・C・G）も同じ判定で呼ばない（`memList` の `off` の拒否は今のまま、`service.ts:517`）。二重にするのは、呼び手を足したときに抜けないため
2. **close の transaction**：§3.2 の 3 で、項目の `(repositoryId, branch)` の mode を DB から決め直し、`on` でなければ close も記録も知らせも書かない（照会の `await` の間に人が画面で `off` にした場合）
3. **受領**：`reserveMemNotices`・`settleMemNoticeAttempt`・人の引き取りは、知らせの `(repository_id, branch)` の mode を同じく決め直し、`on` でなければ何も書かない（`settle` は `reserved` を `pending` に戻すことだけはする。`off` の間に送った結果を受領にしない）

- `on → off/derived → on`：off の間に成立した条件は、`on` に戻った後の最初の評価で閉じる（A §4 の注のとおり）。off の間に「閉じたことにする」記録を作らない

---

## 5. 未反映の decision を閉じない規則と、E（#4225）との競合

- decision の `open`・`recorded` は、条件が成立しても `memTransition('decision', state, 'condition')` が断るので閉じない［事実：`transitions.ts:49`］。評価の結果は `{result:'met', unreflected:true}` として list・check に出すだけで、DB に何も書かない（記録・知らせも作らない）。A の古さ（「未反映」、A §8.2）とは別の欄
- `promoted` の decision は、成立で閉じ、記録と知らせを作る
- **競合の決まり**：すべて項目の `version` で決める（A §3.2 の注と同じ）
  - B の close は、照会の前に固定した `version`・`close_when` が transaction の中で同じときだけ書く。E の承認（`open → recorded`・`recorded → promoted`・記録だけ）・人の取り下げ・`close_when` の更新は `version+1` するので、照会の `await` の間にそれらが入れば、B はその回は閉じない
  - E の書き込みは E が読んだ版を照合する。B が先に `promoted` の decision を閉じた後の E の書き込みは版の競合（409）。`closed` は終端（`transitions.ts:28`）なので開き直さない
  - `recorded` を読んで「閉じない」と決めた評価の間に E が `promoted` にした場合：その回は閉じず、次の評価で閉じる（取りこぼさない・先回りもしない）

---

## 6. 照会の失敗を「閉じない」に寄せる規則のまとめ

| 状況 | 結果 | 閉じるか |
|---|---|---|
| 404・権限不足（401・403）・offline・照会のタイムアウト | 不明（§1.9 の語） | 閉じない |
| 照会の回数の上限・全体の期限 | 不明（`query_budget_exhausted`・`deadline_exceeded`） | 閉じない |
| 削除の未同期（worktree の DB の行が残る・remote の追跡 ref が残る） | 不成立（worktree）・`ls-remote` で直接判定（branch） | 閉じない（branch は本当の状態で決める） |
| 知らない `schema`・名前空間の無い `session` | 不明 | 閉じない |
| relay の保留（`attempting`・`uncertain`）・未配送の payload | 不成立・不明（§2） | 閉じない |
| 照会の `await` の間に版・mode が変わった | — | その回は閉じない |

---

## 7. 新しい常駐・タイマーを作らないことの確かめ方

作り：評価は呼び出しの中だけで走り、終われば何も残さない。キャッシュは実行中の照会の共有だけ（§1.1）。共有の照会は、待つ呼び手が 1 つでも残る間だけ生き、最後の呼び手が離れれば `abort()` で子を kill して項目を消す（§1.1、事前レビュー P2-5）。期限は `execFile` の `timeout` と、評価の中で 1 つだけ使う期限の helper（`src/lib/mem/eval-deadline.ts` の `withDeadline`。`setTimeout` を `finally` で `clearTimeout`）。boot id は読んだときに作る値で、起動時の処理を足さない（§3.5）。

試験：

| # | 試験 | 陽性（作った・残したら落ちる） | 陰性 |
|---|---|---|---|
| G1 | ガード `tests/unit/guards/mem-no-resident-4222.test.ts`：`src/lib/mem/**`・`src/app/api/**/mem/**`・`src/cli/commands/mem*.ts` を走査し、`setInterval`・`setImmediate`・`new Worker`・`fork(`・`detached: true`・`.unref(`・`schedule-manager`/`timer-manager` の import が無いこと、`setTimeout(` は `eval-deadline.ts` だけにあること | 走査の関数に「`setInterval(` を含む文字列」「`eval-deadline.ts` 以外の `setTimeout(`」を渡すと違反を返す（ガード自身の陽性の対照） | 今の `src/lib/mem/**` で違反 0 件 |
| G2 | 同じガードで、サーバの起動の経路（`server.ts`・`src/lib/server/**`［事実：どちらも在る。`src/instrumentation*` は無い］）が `@/lib/mem` を import しないこと | 走査の関数に import を含む文字列を渡すと違反 | 今の起動の経路で 0 件 |
| G3 | 実行の試験：`vi.useFakeTimers()` の下で、**同時に走らせた評価がすべて終わった後に** `vi.getTimerCount() === 0`。照会のタイムアウトで終わった場合・期限で打ち切った場合も 0。単独の評価なら、その評価の終わりで 0 | `withDeadline` の `clearTimeout` を外した版（試験の中の差し替え）で 1 以上 | 通常の評価で 0 |
| G4 | 子プロセス：`execFile` の差し替えで、**待つ呼び手が 0 になった時点で**開始した数と終わった数が一致し、共有の表（`SharedQuery` の Map）が空（打ち切った照会も `abort` で kill されて終わる） | 終わらない差し替えを 1 つ混ぜ、呼び手が 1 つだけ → その呼び手の期限で返った後、照会は `abort` を受け、表が空。`abort` を外した版（試験の中の差し替え）で表に残る | 通常で一致・表が空 |
| G5 | 共有の照会の寿命（事前レビュー P2-5）：期限 3 秒の brief と期限 10 秒の check が同じ照会（4 秒で答える差し替え）を共有 | brief は 3 秒で `deadline_exceeded` を返し、照会は kill されない。check は 4 秒の答えを受け取り、成立なら閉じる。呼び手ごとの期限で子を kill する版（試験の中の差し替え）では check が答えを失う | 両方の期限の内に答えれば両方が同じ結果。両方が期限で離れれば子は kill され、タイマー 0・表が空 |

---

## 8. 実装の範囲

### 8.1 新規ファイル

| ファイル | 中身 |
|---|---|
| `src/lib/db/migrations/v67-mem-close-records.ts` | §3.1 |
| `src/lib/db/mem-close-db.ts` | 条件による close（`mem-db.ts` の退避を呼ぶ）・終了の記録・知らせ・試みの CRUD（transaction） |
| `src/lib/mem/evaluate.ts` | `evaluateMemConditions`（§1.1・§3.2・§4） |
| `src/lib/mem/condition-evaluators.ts` | 型ごとの判定（§1.2〜§1.8・§2）。照会の結果を受けて 3 値と理由を返す純粋な関数 |
| `src/lib/mem/query-plan.ts` | 照会の鍵・まとめ・上限・同時数・実行中の Promise の共有 |
| `src/lib/mem/github-query.ts` | `gh api` の実行と失敗の分類（§1.2）・host の許可表 |
| `src/lib/mem/git-query.ts` | `rev-parse`・`merge-base`・`cat-file`・`reflog`・`ls-remote`・`remote get-url` と分類 |
| `src/lib/mem/eval-deadline.ts` | §7 の `withDeadline` |
| `src/lib/mem/notices.ts` | §3.3・§3.5 |
| `src/lib/mem/process-boot.ts` | §3.5 の boot id |
| `src/app/api/worktrees/[id]/mem/check/route.ts` | `POST`（`mem check`） |
| `src/app/api/repositories/[id]/mem/notices/route.ts` | `GET`（未配送の一覧、`?branch=`） |
| `src/app/api/repositories/[id]/mem/notices/[noticeId]/acknowledge/route.ts` | `POST`（人の引き取り。A の画面の印 `src/lib/security/screen-request.ts` を通す） |
| `tests/fixtures/mem/close-when-eval-v1.json` | 型ごとの照会の応答（差し替え）→ 期待の 3 値・理由の表と、§2 の全組 |

### 8.2 変える既存ファイル

| ファイル | 変更 |
|---|---|
| `src/lib/db/migrations/runner.ts` | `CURRENT_SCHEMA_VERSION = 67`、`v67_migrations` |
| `src/lib/db/mem-db.ts` | `purgeMem` の dry-run に知らせの件数（実際の削除は CASCADE）。条件の close から呼ぶ退避の口を export（中身は今の `archiveSlot`） |
| `src/lib/mem/service.ts` | `memList`（`on` で評価して `condition` を付ける）・新規 `memCheck` |
| `src/lib/mem/present.ts` | 項目の形に `condition: {result, reason, evaluatedAt, unreflected?} \| null` を足す（withheld の形でも理由の語だけは出す。語は自由入力を含まない） |
| `src/lib/mem/close-when.ts` | S1：`session` の名前空間。P2-1：`closeWhenGitNeeds` が `deleted` でも tip を求め、scope で読む ref を分ける。`deleted` は tip が無くても断らない（空文字） |
| `src/lib/mem/incarnation.ts` | `instanceIncarnationAlive`（P1-3）。`startInstanceIncarnation` に `issuedBy`（S6） |
| `src/lib/db/agent-instances-db.ts` | 世代の発行の口（`addAgentInstance`・`setAgentInstances` の新しい組）が `issuedBy: 'roster'` を渡す（S6） |
| `src/lib/mem/service.ts`（`lookupActor` 等の派生の primary の初回発行） | `issuedBy: 'lazy'`（S6） |
| `tests/fixtures/mem/close-when-v1.json` | S1：`inputs.session`・`stored.session`・`invalid`。P2-1：`deleted` の保存値（tip あり・空）を足す（既存の `stored.branch` は変えない） |
| `src/types/mem.ts` | 結果・理由・知らせの型 |
| `src/cli/commands/mem.ts` | `check` の追加、`list` の表示に結果 |
| `src/cli/types/`（`api-responses.ts` か mem の型の置き場） | check の応答の型 |
| `src/app/api/worktrees/[id]/mem/route.ts`・`src/app/api/repositories/[id]/mem/route.ts` | list の評価に呼び手（worktree・instance）を渡す |
| `docs/user-guide/cli-operations-guide.md`・`docs/en/user-guide/cli-operations-guide.md` | `mem check`・型ごとの成立の表・理由の語・限界（§12） |
| `tests/unit/lib/mem/close-when*.test.ts`（A の試験） | S1 の fixture の変更に追従（既存の `it` の名前と、S1 以外の期待は変えない） |

### 8.3 変えないもの

- relay・task・verify・schedule・worktree の書き手（S3）。`src/lib/git/github-api.ts`（失敗を `null` に畳む既存の口はそのまま）
- C・D・G の本体。B は §3.5 の関数と API を用意し、呼ぶのは C（#4223）・D（#4224）・G（#4227）

---

## 9. 受入基準と対照の試験

DB を使う試験は `os.tmpdir()` の `mkdtempSync` の中の DB で、`afterEach` で消す。`gh`・`git` は `execFile` の差し替え（引数で鍵を決め、exit code・stdout・stderr・遅延を返す）、relay・task 等は DB に行を入れる。サーバ・tmux は起動しない。

### 9.1 受入基準の項目

| 受入基準 | 陽性（B が無い・壊れると落ちる） | 陰性（変わらない・閉じないべきを閉じない） |
|---|---|---|
| 全型で成立・不成立・不明 | fixture `close-when-eval-v1.json` の全行：`issue`（closed→成立、open→不成立、404→不明）、`pr`（merged・closed の両 state）、`branch`（§9.2）、`relay`（§2 の全組）、`worktree`（fixture の `worktreeLifecycle`）、`session`（3 名前空間）、`at`（前後） | 各型の不成立・不明で `mem_items.state` が `open` のまま、記録・知らせが 0 件 |
| 404・権限不足・offline・タイムアウト・回数の上限・削除の未同期で閉じない | `gh` の差し替えで 404・401・403・rate limit・接続の失敗・遅延（5 秒超）→ 不明、理由の語が §1.9 のとおり。issue の項目 10 件（番号がすべて違う）で上限 8 → 8 回だけ照会、2 件が `query_budget_exhausted` | 同じ番号の項目 3 件 → 照会 1 回で 3 件とも成立。worktree の DB の行が残るディスクの削除 → 不成立。local の追跡 ref が残る remote の削除 → `ls-remote` の答えで成立 |
| relay の状態 × 保留 | §2 の表の全行を 1 つの表の試験で（`state` 5 × `deliveryHold` 3 × `pendingKind` 有無）。`uncertain` → 不明、`attempting` → 不成立、`expired`＋未配送の payload → 不成立 | `delivered`・保留なし → 成立（`success`）。`expired`・保留なし → 成立（`failure`） |
| 生きているが止まっている／再起動の後の `session` | task `waiting_input`・`running`（rate limit を想定）→ 不成立。再起動を模して boot id を変えても task `running` → 不成立 | verify の `running` を `reconcileOrphanVerificationRuns` で `error` に閉じた後 → 成立（`failure`）。schedule の `recoverRunningLogs` の後 → 成立（`failure`）。名前空間の無い `session:run-42`（v66 の値）→ 不明 |
| 未反映の decision・E との競合 | `open`・`recorded` の decision で条件が成立 → 閉じない、`unreflected:true`、記録 0 件。照会の `await` の間に decision を `promoted` にする（E の模擬：版 +1）→ その回は閉じない、次の評価で閉じる。B が閉じた後の E の版つき書き込み → 409 | `promoted` の decision → 成立で閉じ、記録と知らせが 1 件 |
| 他の instance・`check`・preview が先でも作成者に 1 回だけ | 別の instance の brief の評価・`check`・preview が先に閉じる → 知らせは 1 件、`pending`。他の instance の `listMemNoticesFor` には出ない。作成者の brief で `reserve` → `settle('sent')` → 受領。その後の作成者の `listMemNoticesFor` は空。2 つの評価を同時に走らせても記録・知らせが 1 件 | 作成者の `check` だけでは受領にならない（次の brief で 1 回届く） |
| 知らせの受取先 | 作成者の instance を roster から外す → 同じブランチで後から作った instance に `successor` で渡る、作成者より前から居る instance には渡らない。同じ instance ID を作り直す → 新しい世代は `creator` にならず `successor`。C が予算で省いた知らせ（ID を渡さない）→ `pending` のまま次の brief で出る。`settle('indeterminate')` → `pending`・`uncertain_count=1`。`reserve` の後に boot id を変える（再起動）→ 次の読みで `pending`・`uncertain_count+1` | `settle('sent')` の後は誰の一覧にも出ない。2 回目の `settle` は何もしない。受取先が無い → 画面の一覧に残り、人の引き取りで受領 |
| `branch` | §9.2 | §9.2 |
| mode `off` / `derived` | 成立する条件の項目を `on` で作る → `off`・`derived` にする → list・check・preview・brief の評価で照会 0 回（`execFile` の呼び出し 0）、close・記録・知らせ 0。照会の `await` の間に `off` にする → 閉じない。`off` の間の `reserve` → 何も書かない | `on` に戻した最初の評価で閉じる。`off` の間も作成済みの知らせは残り、画面の一覧に出る |
| 常駐・タイマーを作らない | §7 の G1〜G4 | 同 |

### 9.2 `branch` の対照

| 場合 | 陽性 | 陰性 |
|---|---|---|
| 合流先が違う | `into=develop` の項目で、ブランチが `main` にだけ merge 済み → 不成立 | `develop` に merge 済み → 成立 |
| 新しいブランチで変更がまだ無い | tip == `tipAtCreate` で、その commit が `develop` に含まれる → 不成立（`no-new-commits`） | commit を 1 つ足して merge → 成立 |
| 削除の後の同名の作り直し | local：reflog の作成の時刻が項目より後 → `deleted` は成立（`branch-recreated`）、`merged` は作り直したブランチの merge で成立にならない。`tipAtCreate` が祖先でない tip → `deleted` は不明（`branch-diverged`） | 同じブランチの rebase（reflog は続く）→ `deleted` は不成立 |
| remote が取得できない | `ls-remote` が exit 128 → 不明（`offline`）。squash の判定の `gh` が失敗し祖先でも決まらない → 不明 | `ls-remote` が成功して ref が無い → `deleted` 成立（ref が無いことと取得できないことが別の結果） |
| squash の merge（remote） | ブランチの tip が `develop` の祖先でなく、`gh` の merge 済みの PR（`head.sha` が `tipAtCreate` の子孫）がある → 成立（`branch-merged-pr`） | merge 済みの PR の `head.sha == tipAtCreate` → 不成立 |
| host の許可表 | 項目の origin の host でも `github.com` でもない host の `issue` → 照会 0 回で不明（`host_not_allowed`） | origin の host・`github.com` は照会する |

---

### 9.3 事前レビューの指摘ごと（§13 の番号）

| # | 守る条件 | 陽性（直す前の設計の実装で落ちる） | 陰性（変わらない） |
|---|---|---|---|
| P1-1 | 共有する照会の結果は、鍵が答える範囲を全部含む。`ls-remote` は全 head の一覧を 1 回で取り、一覧に無い＝無い | 同じ repository で、評価 A（ref X の `deleted`）と評価 B（ref Y の `deleted`、Y は remote に在る）を同時に走らせ、`ls-remote` の差し替えは呼ばれた引数に応じて返す → Y の項目は閉じない（不成立）。ref を引数に渡す `ls-remote` を呼んだら試験が落ちる（引数の検査） | 同じ repository の 2 つの評価は `ls-remote` を 1 回だけ呼ぶ。X が一覧に無ければ X の項目は成立 |
| P1-2 | 送る本文は予約できた知らせの ID だけで組み、settle はその試みの知らせだけを受領にする | 知らせ n1・n2・n3 に、brief α が {n1,n2}、brief β が {n2,n3} を同時に予約 → n2 はどちらか一方の `reserved` にだけ入り、もう一方の組み直した本文に n2 が無い。α を `sent` で settle → n1・n2（α が取った分）だけ受領、β の分は `reserved` のまま | 競合が無ければ選んだ ID がすべて予約され、`sent` でそれだけが受領、選ばなかった知らせは `pending` のまま。1 件も予約できなければ `attemptId: null` で試みの行を作らない |
| P1-3 | 作成者の生存は世代の ID で引く。来歴の worktree ID では引かない。一覧・予約・画面の判定は `noticeAudience` 1 つ | 作成者の worktree を改名（`renameWorktreeIdPreservingChildren`）→ 同じブランチの別の instance（roster で後から追加）の `listMemNoticesFor` に出ない・`reserve` で取れない。改名後の新しい ID の作成者のセッションが `creator` で受け取る | worktree を削除して同じ ID・同じ instance ID で作り直す → 新しい世代は `creator` にならず (a) の `successor`。作成者の instance を roster から外す → (a)・(b) の規則どおり |
| P1-4 | ref の作成の時刻は reflog の項目の時刻で読み、commit の時刻を使わない | `os.tmpdir()` の実 repository で、`GIT_COMMITTER_DATE` を過去にした commit C を作る → 項目を作る → ブランチを消して C から同名で作り直す → `recreated` と判定し、`deleted` は成立、作り直したブランチの merge で `merged` は成立しない | 項目より前に作ったブランチ（commit の時刻が古い・新しいの両方）を作り直さずに置く → `same`。reflog の最も古い項目が作成の行でない repository → 作成の時刻は不明として祖先の判定だけ |
| P2-1 | `deleted` の保存は ref があれば tip を持つ。空の tip は `recreated`・`diverged` に読まない。評価の時の tip で補わない | 今の A が保存した `tipAtCreate: ''` の `deleted`（local）で、ref が在り、reflog が項目より後の作成を示す → `recreated` にせず不成立（`branch-present-no-baseline`） | 空の tip でも ref が無ければ成立、取得できなければ不明（無いと取得できないを分ける）。B の保存の後の `deleted` は tip を持ち、§1.4 の表どおり。`merged` の保存の挙動（tip が無ければ断る）は変わらない |
| P2-2 | remote の PR の証拠は、項目の作成より後の merge で、今の頭と対応するものだけ | 今のブランチの頭 H は未 merge、同名の過去の PR（`merged_at` が項目より前・`head.sha` は `tipAtCreate` の祖先）だけが merge 済み → 不成立。H の後に未 merge の commit を積んだ状態で、H の前の頭の PR が merge 済み → 不成立 | 項目の作成の後に `head.sha == H` の PR が squash で merge → 成立。merge の後にブランチを消した（`gone`）で、`merged_at` が項目より後・`tipAtCreate` の子孫の PR → 成立 |
| P2-3 | 区分は知らせごとに持ち、受領の区分はその値 | 1 つの brief に作成者の知らせ m1 と前の世代の知らせ m2 を入れて `sent` → m1 は `acknowledged_by='creator'`、m2 は `'successor'` | 作成者の知らせだけの brief は全部 `creator`。2 回目の settle は何もしない |
| P2-4 | 「後から生まれた」の証拠は roster の発行（`issued_by='roster'`）か同じ枠の置き換えだけ。一覧は書かない | 項目より前から居る派生の primary（世代の行なし）が、項目の後に mem を初めて書いて `'lazy'` の世代を得る → (b) の `successor` にならない。`listMemNoticesFor` の前後で DB のどの表の行も変わらない（世代を作らない・古い試みを戻さない） | 項目の後に roster へ追加した instance は (b) で受け取れる。作成者の枠の次の世代（同じ instance ID、行が無い・`'lazy'` でも）は (a) で受け取れる。作成者の tmux を kill して同じ世代で起動し直す → `creator` のまま |
| P2-5 | 呼び手の期限と共有の子の寿命を分ける。最後の呼び手が離れたら回収 | §7 の G5 の陽性 | §7 の G4・G5 の陰性 |
| R2-① | 最初の roster の保存で写された primary の世代は「後から生まれた」の証拠にしない | 派生の primary だけの worktree で項目を作る → 作成者を終わらせる → 同じブランチの別の worktree で、前から居た派生の primary を `codex-2` の追加とともに初めて roster に保存（`createInstanceWithRole` → `setAgentInstances`）→ その primary の世代は `'lazy'` で、(b) の `successor` にならない（直す前の実装では `'roster'` で受け取れる） | 同じ保存で足した `codex-2` は `'roster'` で (b) の `successor`。roster が既にある worktree へ足した primary は `'roster'` |
| R2-② | 項目と同じ秒の ref の作成は前後を言えないので `same` にしない | 項目の `created_at` と同じ秒に作成の行がある local のブランチ（祖先の判定は `same` を示す）→ `deleted` は不成立にせず不明（`branch-order-uncertain`）、`merged` は H を決めず不明（直す前の実装では `same` で `merged` が成立しうる） | 作成の秒が項目より確実に前（1 秒以上前）→ 祖先の判定どおり `same`。確実に後 → `recreated` |
| R2-③ | 予約の結果は配送不明の印を持ち、C が予算に数えた印と違う知らせは予約しない | `settle('indeterminate')` の後の知らせ → 一覧の `uncertain` が真、予約の `reserved` も真。一覧で `uncertain:false` と読んだ後に古い試みが切れて印が真になる知らせ → 予約されず `pending` のまま（直す前の実装では印の無い本文の予算のまま予約される） | 印が変わらなければ選んだ ID がすべて予約され、`reserved` の印は一覧と同じ |

## 10. 対になる場所（探した結果）

| 探した対象 | 結果 |
|---|---|
| 条件の評価の呼び手 | `memList`（`src/lib/mem/service.ts:508`）と repository の経路の list（`src/app/api/repositories/[id]/mem/route.ts`）。どちらも `memList` を通るので、評価は `memList` の 1 か所に入れる。C・G は未実装 |
| relay の終端の判定の写し | `isOpenRelayState`（`types.ts:32`）と `listClosedRelaysWithPendingPayload`（`relay-db.ts:337`）。B は `isOpenRelayState` を使い、payload の有無は行の `pendingKind` で見る（同じ意味の SQL を写さない） |
| task の終端の写し | `TERMINAL_TASK_STATUSES`（`tasks-db.ts:44`）と `VERIFIABLE_TASK_STATUSES`（`:81`）。B は「終端だが開き直せる」を `VERIFIABLE` から引く（自前の一覧を作らない） |
| GitHub の照会の既存の口 | `src/lib/git/github-api.ts`（失敗を `null` に畳む）・`src/lib/skills/pull-request-service.ts`・`src/lib/git/fork-manager.ts`。3 値に要る分類を持たないので使わない |
| 送信の到達確認の 3 値 | `SendAttemptState`（`send-attempt-types.ts:24`）。D の結果をこの型のまま受ける |
| boot id の既存の作り | `relayServerBootId`（`relay-boot.ts:30`）。relay と混ぜないため mem 用を別に持つ（同じ作り） |
| ja / en の説明 | `docs/user-guide/cli-operations-guide.md` の mem の節（`:3407` 付近）と `docs/en/user-guide/cli-operations-guide.md` |
| 設計書を固定する試験 | `tests/unit/docs/design-doc-identifier-audit.test.ts` は別の設計書だけを見る（A §14）。この文書は対象外 |

---

## 11. 事実の照合（契約の説明と実コード）

| 契約・Issue の説明 | 実コード | 判断 |
|---|---|---|
| 最新の migration は v66 | `CURRENT_SCHEMA_VERSION = 66`（`runner.ts:34`）、`v66-mem-store.ts` | 新しい版は v67 |
| A の worktree 条件は世代の存続で決める | `worktreeIncarnationAlive`（`incarnation.ts:102`）が世代で引く。fixture に `worktreeLifecycle`（改名 → not-met、削除・作り直し → met） | 一致。§1.7 |
| A は session の世代を保存する | 常に `null`（A の I2、`service.ts` の `sessionGeneration: null`）。#4115 の世代はメモリと、ロールの設定があるときだけの `agent_role_launch_records`（`role-launch.ts:339` の早道） | 世代に頼らない名前空間（S1） |
| relay の状態と `deliveryHold` | `RelayState` 5 つ（`types.ts:26`）、`RelayDeliveryState` 2 つ（`:107`） | 一致。§2 |
| decision は promote 前に閉じない | `memTransition('decision', …, 'condition')` は `promoted` だけ通す（`transitions.ts:49`） | 一致。§5 |
| D の配送の結果 | D（#4224）は未実装。送信の到達確認の型は `SendAttemptState`（`send-attempt-types.ts:24`） | B は `SendAttemptState` を受ける口を用意する（§3.5） |

---

## 12. 未確認・未決（レビューで見てほしい点）

| # | 内容 |
|---|---|
| U1 | §1.1 の数字（外の照会 8 回・5 秒、手元の git 24 回・3 秒、期限 10 秒、brief は C が 4 回・3 秒）は見立て。brief の送信の遅れの許容（D10 は予算をバイトで決めるが時間は決めていない）は C・D と合わせる |
| U2 | `gh` が `GH_ENTERPRISE_TOKEN` を github.com 以外の任意の host へ送るか（S5 の前提）を実測していない。送らないと分かっても、許可表は残す（照会の先を Agent の入力で広げない） |
| U3 | `branch` の作り直しの見分けは local の reflog の項目の時刻に頼る（commit の時刻は使わない、§1.4）。`%gd` と `--date=unix` の出力の形は git 2.49 で `<name>@{<秒>}` と実測した（実 git の試験で固定する）。項目と同じ秒に作ったブランチは前後を言えないので不明のまま（事前レビュー 2 回目 ②）。reflog が無い・期限切れの repository と、remote で `tipAtCreate` の子孫から作り直したブランチは見分けられない（§1.4）。正確に追うなら `pr:` の型を使うよう利用者の説明に書く。`merged` の local で、merge の後にブランチを消した場合は不明のまま（人が閉じる） |
| U4 | S2（relay の `expired`・`cancelled` を成立・`failure` で閉じる）は解釈。「不成立のまま残す」が Issue の意図なら §2 の 2 行と試験を入れ替える |
| U5 | S1 の狭め方で、B より前に名前空間なしで保存された `session` の項目は永遠に不明になる（閉じないだけで、人は閉じられる）。v66 の利用者は数日分（A のマージは 2026-11-08）で、移行の処理は作らない見立て |
| U6 | §3.3 (b) の「次の世代」（roster で作った世代の `created_at > item_created_at`）は、作成者の生前に後から roster に加わった別の instance も含む。作成者の終わりの時刻は A の世代の表に残らない（行が消える）ので、これより狭くするには世代の終わりの記録が要る。派生の primary だけで回すブランチでは、別の worktree の primary は (b) にならず、知らせは画面の一覧に残る |
| U7 | §7 G2 の起動の経路は `server.ts` と `src/lib/server/` の在ることだけを確かめた（中身は読んでいない）。起動から import される他のファイルがあれば、実装の契約でガードの対象に足す |
| U8 | `mem check` を CLI の `$?` で「不明が残った」と分けるか（今は常に 0 で、結果は `--json` の `results`）。ループで使うなら 57 等を足す案がある |
| U9 | S6「作成者の終わり＝instance の世代（roster の寿命）の終わり」は、Issue の「作成者のセッションが生きていれば」を roster の単位に読んだもの。tmux の kill の後も同じ世代の次のセッションが作成者として受け取る。この読みの合意はまだ無い（レビューで確かめる） |
| U10 | `git ls-remote --heads origin` の全件は、head が数万の repository で重い。8 MB を超えたら不明にするが、実際の大きさは測っていない |

---

## 13. 事前レビューの処置

Codex の事前レビュー 1 回目（2026-11-08、P1 4 件・P2 5 件。`workspace/orchestration/runs/2026-11-08/prereview/review-4222.md`）。守る条件と対照は §9.3 の同じ番号の行。S1〜S4・mode の入口と書き込みの直前の再確認・decision の版の照合は「矛盾は未観測」とされたので変えていない。

| # | 指摘 | 処置 | 1 行の理由 |
|---|---|---|---|
| P1-1 | 共有する `ls-remote` の鍵に照会した ref の集合が無い | 採る | `ls-remote --heads origin` で全 head を 1 回で取り、鍵が答える範囲を全部含む形にした。ref を絞った照会を作らない（§1.1・§1.4） |
| P1-2 | 予約の結果と、実際に送る知らせの ID が一致する契約が無い | 採る | 予約が取れた ID と区分を返し、C はそれだけで本文を組み直し、settle はその試みの知らせだけを受領にする手順を C・D の契約にした（§3.5） |
| P1-3 | worktree の改名を作成者の終わりと読む | 採る | 生存は UNIQUE な世代の ID で引く `instanceIncarnationAlive` にし、一覧・予約・画面を `noticeAudience` 1 つに揃えた（§3.3） |
| P1-4 | reflog の `%ct` は commit の時刻で、ref の作成の時刻ではない | 採る | reflog の項目の時刻（`%gd` と `--date=unix`）を使い、作成の行でなければ時刻を不明として使わない。実 git で固定する（§1.4・U3） |
| P2-1 | `deleted` の `tipAtCreate` は A では空文字 | 採る | 新しい保存で `deleted` も tip を取り（無ければ空）、空の tip は作り直し・食い違いに読まない規則を足した。評価の時の tip で補わない（§1.4） |
| P2-2 | remote の merge の判定が項目より前の同名 PR を拾う | 採る | PR の `merged_at` が項目より後で、今の頭 H があれば `head.sha == H` を求め、作り直し・食い違いでは PR の証拠を使わない（§1.4 の 4） |
| P2-3 | 1 つの試みでは作成者と前の世代の混在を記録できない | 採る | 区分を試みから知らせの行（`attempt_audience`）へ移した（§3.1・§3.5） |
| P2-4 | 世代の発行の時刻を、セッションが後から生まれた証拠にしている | 採る | 証拠を「同じ枠の置き換え」と「roster の発行（`issued_by='roster'`）」に限り、A の世代の表に列を足した（S6）。作成者の終わりを roster の寿命と定め、合意は U9。一覧の副作用を無くし、書き込みを §3.5 の表に整理した |
| P2-5 | 共有の照会の期限・中断の持ち主が無い | 採る | 子の寿命は照会自身のタイムアウトと `abort` だけで決め、呼び手は自分の期限で待ちをやめ、最後の呼び手が離れたら kill・回収する（§1.1・§7 の G4・G5） |

### 13.2 事前レビュー 2 回目（2026-11-08、P2 3 件。`workspace/orchestration/runs/2026-11-08/prereview/review-4222b.md`）

1 回目の 9 件は解消 7 件・一部解消 2 件（P1-4・P2-4）と判定された。一部解消の残りが下の ②・① で、③ は修正で生まれた穴。守る条件と対照は §9.3 の R2-① 〜 R2-③。

| # | 指摘 | 処置 | 1 行の理由 |
|---|---|---|---|
| ① | 既存の派生の primary の初回の roster の保存を「後から生まれた」の証拠にできる | 採る | roster の行が無い worktree の最初の保存では、primary の組の新しい世代を `'lazy'` にする（§3.1）。lazy の発行の経路の記述を `mem-db.ts` の `settleActorIncarnation` に直した |
| ② | 項目の作成と同じ秒のブランチの作り直しを見逃す | 採る | 作成の秒が項目と同じ秒なら `order-uncertain`（不明）にし、`same` にしない（§1.4）。確実に後・確実に前だけを使う |
| ③ | 予約で増えた配送不明の情報が最終の本文へ届く契約が無い | 採る | 一覧が配送不明の印を（古い試みの `+1` を先に数えて）返し、予約は C が予算に数えた印と同じ知らせだけを取り、`reserved` に印を返す（§3.5）。印が変わった知らせは予約しないので、本文は短くなるだけで予算を超えない |


---

## 14. 実装で変えた点・細かく決めた点（実装の契約で追記）

| # | 設計の文面 | 実装 | 理由 |
|---|---|---|---|
| I1 | §8.2 `present.ts` の項目の形に `condition` を足す | `MemListResponse.conditions`（項目の ID → `MemConditionView`）に置き、`presentMemItem` と withheld の形は変えない | withheld の残す欄の表（A の `MEM_WITHHELD_KEPT_KEYS`）を変えずに済む。語は自由入力を含まないので別の欄で足りる |
| I2 | §1.6 schedule の読み関数を `src/lib/db/` の既存の schedule の DB 関数の隣に置く | `mem-close-db.ts` の `readScheduleRunStatus`（読みだけ） | 契約の scope に schedule の DB ファイルが無い |
| I3 | §3.1 の schema | `mem_notice_attempts.recipient_worktree_incarnation` と `mem_notices.version` を足した | 試みの受取先の worktree の作り直しを settle で見分ける（不変条件 (a)）。人の引き取りを版で照合する（(c)、§3.5 の `acknowledgeMemNoticeByHuman(…, version)`） |
| I4 | §3.5 settle | `sent` でも、受取先の worktree が作り直されていた・mode が `on` でないときは受領にせず `pending` に戻す | 知らせを失わないほうへ寄せる（不変条件 (a)・(b)） |
| I5 | §3.5 人の引き取り | `pending` の知らせだけ（`reserved` は `state_forbids`） | 送信中の試みと受領が二重にならない |
| I6 | §7 G1「`setTimeout(` は `eval-deadline.ts` だけ」 | 例外の表に `screen-client.ts`（#4221 の画面の fetch の期限、ブラウザ側で `finally` で消す）を理由つきで置いた | サーバの評価の経路ではない。A のコードは変えない |
| I7 | §9.2 purge の dry-run に知らせの件数 | `notices` は 1 件以上のときだけ応答に出す | A の応答の形（`{ok, dryRun, counts}`）を固定する試験を変えない |
| I8 | §4 受領の mode | 予約は、知らせの root の mode に加えて、受取先の読む範囲の全 root の mode が `on` のときだけ | 受取先のブランチが `off` の間に brief へ載せない |
| I9 | §3.2 の mode の決め直し | close は項目の root と対象の members の全 root。知らせの書き込み（予約・settle・人）は知らせの root | 知らせは root を 1 つしか持たない（A §9.5 の保存先） |
| I10 | §1.4 `merged` | `tipAtCreate` が空の `merged`（A は保存を断るので通常は無い）は不明（`schema_unknown`）。`into` の ref が無い：local は不成立、remote は PR の証拠へ | 根拠の無いものを成立にしない |
| I11 | §1.6 `verify:<run id>` | 数字（1〜16 桁）だけを受ける（`parseSessionId`） | `getVerificationRun` は数値の ID |
| I12 | §1.4 `merged` の `recreated` | 不明（`branch-gone-unmerged-unknown`） | 元のブランチの merge を言えない |
| I13 | §3.3 (b)（2 回目 ①） | 最初の roster の保存の判定は「保存の前に `agent_instances` の行が 0 件」 | 派生の roster は行を持たない（`resolveAgentInstances`）。primary の判定は `instance_id === cli_tool_id`（#868） |

---

## 15. 共通規則の全読者（実装の後に、5-2b の前に書く）

B が足した・変えた共通の規則ごとに、読む・書く全経路と、規則に追従しているか。C・D・G は未実装なので、その口（関数）までを書く。

### 15.1 世代の照合（worktree の寿命・instance の世代・`issued_by`）

| 規則の関数 | 呼び出し元 | API / CLI / 画面 | 追従 |
|---|---|---|---|
| `fixMemEvalLifetime`（`evaluate.ts`、要求の最初の await の前に worktree の世代を固定）→ `evaluateMemConditions` の必須の `lifetime` → `closeItemByCondition` の `alive` | `memList`・`memCheck` | `GET /api/worktrees/:id/mem`・`POST /api/worktrees/:id/mem/check`・`mem list`・`mem check` | 追従（`close-entrances-4222` の (a)） |
| 同上（公開の評価の口そのもの） | brief（#4223）・preview（#4227）が呼ぶ口 `evaluateMemConditions` | C・G（未実装） | 追従（整合性レビュー P2-3 で直した。`lifetime` は省けない型で、worktree の対象に寿命が無い・別の worktree の寿命・`repository` の寿命なら何も評価しない。表の行「via evaluateMemConditions (brief / preview)」が口を直接呼んで (a)〜(c) を固定） |
| 同上（repository の経路は `{ via: 'repository' }`、`alive = null`） | `memList`（`via: 'repository'`） | `GET /api/repositories/:id/mem?branch=` | 追従（worktree を経ないので照合する寿命が無い。mode・版は照合する） |
| `recipientStillHere`（`mem-close-db.ts`） | `reserveNotices` ← `reserveMemNotices` | D（未実装） | 追従（(a)） |
| settle の `sameWorktree`（試みの `recipient_worktree_incarnation` を `worktreeIncarnationAlive` で世代から引く。予約時の id では引かない） | `settleNoticeAttempt` ← `settleMemNoticeAttempt` | D（未実装） | 追従（(a)。作り直しなら受領にせず `pending`。整合性レビュー P2-1 で直した：予約と settle の間の通常の改名は世代の行が新しい id へ動くので同じ受取先のまま受領する。改名先の削除・作り直しは世代が消えるので `pending`） |
| `noticeAudience`（作成者は `origin_incarnation`、生存は `instanceIncarnationAlive`、(a) は `resolveWorktreeIdWithAlias`、(b) は `issued_by='roster'` と `created_at`） | `listNoticesFor`・`reserveNotices`・`memNoticeAudience` | C・D（未実装）、G は `memNoticeAudience` を呼ぶ口 | 追従（判定の写しは無い。`grep` で `origin_incarnation` を比べる箇所は `noticeAudience` だけ） |
| `rosterIssue`（`agent-instances-db.ts`、最初の保存の primary は `lazy`） | `setAgentInstances`・`addAgentInstance` | `PATCH /api/worktrees/:id`（roster の全置換、`route.ts` の `setAgentInstances`）・`POST /api/worktrees/:id/instances/roles` 等の `createInstanceWithRole`（`management.ts`）→ `setAgentInstances` | 追従（`startInstanceIncarnation` の全呼び出しが `issuedBy` を名指す、`close-entrances-4222` の試験） |
| `settleActorIncarnation`（`mem-db.ts`、`lazy`） | `createMemItem`・`replaceNowSlot` | mem の書き込みの全経路 | 追従 |
| `listUndeliveredNotices` | `listUndeliveredMemNotices` ← `memUndeliveredNotices` | `GET /api/repositories/:id/mem/notices?branch=` | 追従（受取先を持たないので `audience: null`。判定はしない） |

### 15.2 mode の判定

| 規則の関数 | 呼び出し元 | API / CLI / 画面 | 追従 |
|---|---|---|---|
| 入口：`evaluateMemConditions` の `target.mode === 'on'` | `memList`（`off` は 409、`derived` は評価しない）・`memCheck`（`on` 以外は 409） | list・check の API と CLI | 追従（(b)。`off`・`derived` で `execFile` 0 回） |
| `memModeOnFor`（`decideRootMode` を DB から読み直す） | `closeItemByCondition`（項目の root ＋ members）・`reserveNotices`（受取先の全 root ＋ 知らせの root）・`settleNoticeAttempt`・`acknowledgeNoticeByHuman` | 上記と D・G | 追従（(b)） |
| 読みだけの一覧 | `listNoticesFor`・`listUndeliveredNotices` | C・G | 規則の対象外（§4：読みは出す） |

### 15.3 評価の 3 値

| 規則の関数 | 呼び出し元 | API / CLI / 画面 | 追従 |
|---|---|---|---|
| `condition-evaluators.ts`（型ごとの判定、理由の語は `src/types/mem.ts` の定数） | `evaluate.ts` の `evaluateOne` | — | 追従（fixture `close-when-eval-v1.json`） |
| 閉じるのは `met` だけ・`unknown` は閉じない・decision は `memTransition` | `evaluateMemConditions` | `memList`（`conditions`）・`memCheck`（`results`） | 追従 |
| 表示 | `conditionText`（`src/cli/commands/mem.ts`） | `mem list`・`mem check` | 追従（語で表示し、文面で分岐しない） |

### 15.4 受領の確定

| 規則の関数 | 呼び出し元 | API / CLI / 画面 | 追従 |
|---|---|---|---|
| `settleNoticeAttempt`（その試みの知らせだけ・`attempt_audience` で区分・2 回目は何もしない） | `settleMemNoticeAttempt` | D（未実装） | 追従 |
| `acknowledgeNoticeByHuman`（画面が読んだ版の照合 → mode → 古い予約は戻してから引き取る・生きている予約は `state_forbids`） | `acknowledgeMemNoticeByHuman` ← `memAcknowledgeNotice` | `POST /api/repositories/:id/mem/notices/:noticeId/acknowledge`（画面の印） | 追従（整合性レビュー P2-2 で直した。一覧が `pending` と読む古い予約を人が引き取れなかった） |
| 古い試みの判定 `attemptIsStale`（別の boot か 10 分超） | `readable`（`listNoticesFor`・`listUndeliveredNotices`、書かない）・`abandonStaleAttempts`（`reserveNotices`）・`acknowledgeNoticeByHuman`（その知らせの試みだけを `abandoned` にし、+1 を数える） | C・D・G、画面の印 | 追従（読みが `pending` と見せるものは、書く側の reserve と人の引き取りの両方が引き取れる） |
| 受領の後に出さない | `listNoticesFor`・`listUndeliveredNotices`（`state != 'acknowledged'`） | C・G | 追従 |
| 保持の削除（30 日） | `pruneRetention`（close・reserve・settle・人の引き取りの transaction の中） | — | 追従（未受領は消さない） |

未追従は見つからなかった（探した対象：`src/` の `mem_notices`・`mem_notice_attempts`・`mem_close_records`・`issued_by`・`startInstanceIncarnation`・`decideRootMode` を含む全ファイル）。

その後の整合性レビュー（Codex、`workspace/orchestration/runs/2026-11-08/review-4222.md`、P2 3 件）で 3 つの未追従が見つかり、この PR で直した（上の表の該当行に反映済み）。

| 番号 | 未追従 | 直し方 | 試験（陽性・陰性） |
|---|---|---|---|
| P2-1 | settle が試みの保存した旧 id から worktree の世代を引き、予約→通常の改名→`sent` を受領にしなかった | 世代そのものの存続（`worktreeIncarnationAlive`）で照合 | `notices-4222`：改名をまたいで受領／同じ id の作り直し・改名先の作り直しは `pending` |
| P2-2 | 古い予約は一覧で `pending` と読めるのに、人の引き取りは `reserved` を一律に断った（DB の回復は reserve だけ） | 人の引き取りにも `attemptIsStale` を通し、古い予約はその試みを `abandoned` にしてから引き取る | `notices-4222`：別の boot・10 分超は引き取れ、古い試みの後の settle は何もしない／生きている予約は 409 `state_forbids`、版の違い・`off` は何も書かない |
| P2-3 | 公開の評価の口 `evaluateMemConditions` が `alive` の省略を許し、入口の表は writer と writer の直接の呼び手しか数えなかった | `lifetime` を必須にし、口の中で対象と照合する。表に `entrance`（公開層の関数）と `callers`（公開層の関数を呼ぶ `src/` の関数）を持たせ、両方を源から列挙して表と一致させる | `close-entrances-4222`：口を直接呼ぶ行の (a)〜(c)／寿命なし・別の worktree・`repository` は評価しない、新しい入口・新しい呼び手・class の中の呼び出しを検査が拾う対照 |
| 再レビュー P2 | 公開層の入口の列挙がファイルごとで、公開層の中のファイルをまたぐ連鎖（`notices.ts` の新しい export が `evaluateMemConditions` を呼ぶ）を入口と数えなかった。公開層は呼び手の検索からも除いている | 公開層の全ファイルを 1 つの源として連鎖を閉包で列挙する（公開層の中の呼び手は全て入口として表に要る） | `close-entrances-4222`：直接の連鎖・helper 経由の連鎖を入口と数え、表との比較が落ちる／読むだけの export は入口にならない。ファイルごとの解析に戻すと対照が赤 |
