# close_when の型付きの評価と終了の記録（Issue #4222 / Epic #4220 の子 B）設計

- 状態：設計の段（実装前）。第 1 版。実装は Codex の事前レビューの後、同じブランチの別の契約で行う
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
- **同じ対象の照会は 1 回にまとめる**：照会の鍵（§1.2〜§1.4）で 1 回の評価の中の重複を 1 つにし、結果を全項目で共有する。同時に走る別の評価とは、**実行中の照会の Promise だけ**を鍵で共有する（終わったら捨てる。時間で持つキャッシュは作らない＝タイマーも期限の掃除も要らない、§7）
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
| 無い（`gone`） | local：`git rev-parse --verify --quiet refs/heads/<name>^{commit}` が exit 1。remote：`git ls-remote --heads origin refs/heads/<name>` が exit 0 で行が無い |
| 同じ（`same`） | ref があり、`tipAtCreate` がその tip の祖先か同じ（`git merge-base --is-ancestor`）。local は加えて、`git reflog show --format=%ct%x09%gs refs/heads/<name>` の最も古い行が「`branch: Created from`」で、その時刻が項目の `created_at` より後**でない** |
| 作り直し（`recreated`） | local で、reflog の最も古い行が作成の行で、時刻が項目の `created_at` より後 |
| 区別できない（`diverged`） | ref はあるが `tipAtCreate` が祖先でない（作り直し・rebase・force push のどれかで、remote では見分けられない） |
| 取得できない | 手元の git が exit 0/1 以外・タイムアウト、`ls-remote` が exit 128 等（`offline`・`query_timeout`・`remote_error`）、祖先の判定に要る object が手元に無い（`objects_missing`） |

- reflog が無い（`core.logAllRefUpdates=false`・期限切れ）ときは reflog の条件を使わず、祖先の判定だけで `same` / `diverged` を決める（§12 U3 の限界）
- `ls-remote` は repository ごとに 1 回にまとめる（`git ls-remote origin refs/heads/<a> refs/heads/<b> …`。鍵 `ls-remote:<repositoryId>`）。**`git fetch` はしない**（利用者の repository の refs を書き換えない・定期の照会を足さない）

**`event = deleted`**

| 同一性 | 結果 |
|---|---|
| `gone` | 成立（`branch-deleted`、成否 `unknown`） |
| `recreated`（local だけ） | 成立（`branch-recreated`。元のブランチは無い） |
| `same` | 不成立（`branch-present`） |
| `diverged` | **不明**（`branch-diverged`。rebase を削除と読まない） |
| 取得できない | 不明（理由はそのまま）。「ref が無い」と「取得できない」を分ける |

- 「削除の未同期」：remote の削除は `ls-remote` で直接見るので、手元の `refs/remotes/origin/<name>` が残っていても関係ない。local の削除は refs をそのまま見る

**`event = merged`**（`into` へ、作成したときの tip より後の commit を含んで入った）

1. ブランチの頭 H を決める：`same` なら今の tip。`gone`・`recreated`・`diverged` なら H は無い
2. H があり **H == tipAtCreate** → 不成立（`no-new-commits`。共通の祖先を指すだけの新しいブランチ）
3. H があり、H が `into` の tip（scope に従い local の `refs/heads/<into>` か `ls-remote` の値）の祖先 → 成立（`branch-merged`、`success`）
4. scope が `remote` のとき、squash・rebase の merge と「merge の後にブランチを消した」を GitHub で見る：`gh api --hostname <origin の host> 'repos/<o>/<r>/pulls?state=closed&base=<into>&head=<o>:<name>&per_page=20'`（鍵 `gh-pr-head:<host>/<o>/<r>:<name>:<into>`、値は URL エンコード）。`merged_at != null` かつ `head.sha != tipAtCreate` かつ `tipAtCreate` が `head.sha` の祖先（手元に object があれば `merge-base`、無ければ `gh api repos/<o>/<r>/compare/<tipAtCreate>...<head.sha>` の `status == "ahead"`）の PR があれば成立（`branch-merged-pr`、`success`）
5. それ以外：H があれば不成立（`not-merged`）。H が無く（`gone`・`recreated`）scope が local なら不明（`branch-gone-unmerged-unknown`：merge の後に消したのか、merge せずに消したのかを手元だけでは言えない）。`diverged` は不明（`branch-diverged`）
- **合流先が違う**：判定は `into` だけを見る。`main` に入っていても `into=develop` なら 3・4 に当たらず不成立
- **remote が取得できない**：`ls-remote` が失敗 → 不明（`offline` 等）。4 の `gh` が失敗し、1〜3 で決まらない → 不明
- **作り直し**：`recreated`・`diverged` の新しいブランチの merge は、2・3 で元の項目の成立に数えない。remote で、作り直したブランチが `tipAtCreate` の子孫から始まっていると見分けられない（§12 U3）

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

成立・不成立の理由は上の各表の語。不明の理由は `not_found`・`unauthenticated`・`forbidden`・`rate_limited`・`remote_error`・`offline`・`query_timeout`・`gh_unavailable`・`unexpected_response`・`not_an_issue`・`host_not_allowed`・`repository_unavailable`・`objects_missing`・`branch-diverged`・`branch-gone-unmerged-unknown`・`relay_not_found`・`relay-delivery-uncertain`・`session_not_found`・`session_kind_unknown`・`schema_unknown`・`query_budget_exhausted`・`deadline_exceeded`。語は `src/types/mem.ts` に定数で置き、CLI・画面・C は語で分岐する（文面で分岐しない）。

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
  recipient_incarnation TEXT NOT NULL, -- A の instance の世代
  audience TEXT NOT NULL CHECK (audience IN ('creator','successor')),
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
  uncertain_count INTEGER NOT NULL DEFAULT 0,   -- 配送の結果が不明だった回数
  acknowledged_at INTEGER,
  acknowledged_by TEXT CHECK (acknowledged_by IN ('creator','successor','human')),
  acknowledged_instance_id TEXT,
  acknowledged_incarnation TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((state = 'reserved') = (attempt_id IS NOT NULL)),
  CHECK ((state = 'acknowledged') = (acknowledged_at IS NOT NULL))
);
CREATE INDEX idx_mem_notices_scope ON mem_notices(repository_id, branch, state);
```

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
- **今の受取先**は保存せず、受け取りを求められた時点で決める（作成者が後から終わる場合に追従するため）：

| 受け取りを求めたセッション R（worktree・instance・世代） | 条件 | 扱い |
|---|---|---|
| 作成者 | `R.incarnation == origin_incarnation`（同じ ID でも世代が違えば作成者ではない） | `audience='creator'` で渡す |
| 次の世代 | 作成者の世代が終わっている（`mem_instance_incarnations` に `(origin_worktree_ref, origin_instance_id)` の `origin_incarnation` が無い）かつ R が同じ repository（読む範囲の root）・同じブランチにいて、R の世代の `created_at` が `item_created_at` より後 | `audience='successor'` で渡す。C は「前の世代（`<origin_instance_id>`、<作成時刻>）の項目」として出し、R 自身の項目として出さない |
| それ以外（作成者が生きている間の他の instance、作成者より前から居る別の instance） | — | 渡さない |
| 画面（人） | — | 一覧に出す。人が引き取ると `acknowledged_by='human'` |

- **instance ID の再利用**：同じ ID の新しい世代は「作成者」にならない（世代で比べる、A §10.4）。作成者の世代が終わっているので「次の世代」として、前の世代の知らせだと分かる形で渡る
- **作成者が終わっている**（`session` の条件で閉じた場合を含む）：上の「次の世代」。それも無ければ一覧に残る（消えない）
- R の世代の行が無い（v66 より前からの primary が mem を一度も書いていない）ときは、受け取りの transaction で A の `startInstanceIncarnation` で作る（`incarnation.ts:47`）［見立て：作った時刻は `item_created_at` より後なので次の世代になる。作成者は必ず世代を持つので、作成者を取り違えない］

### 3.4 列名

`worktree_id` という名前の列を持たない（`origin_worktree_ref`・`recipient_worktree_ref`・`triggered_by_worktree_ref`）。`getWorktreeChildTables` は `worktree_id` 列を持つ表を worktree の子として削除する［事実：`src/lib/db/migrations/worktree-child-tables.ts:24`］。知らせは作成者の worktree が消えても残らなければならない（A §10.3 と同じ理由）。

### 3.5 受領の確定（D の配送の結果を受ける口）

新規 `src/lib/mem/notices.ts`。C・D・G はこの関数だけを使う：

| 関数 | 呼び手 | 動き |
|---|---|---|
| `listMemNoticesFor(db, recipient)` | C（brief を組む）・G（preview） | 受け取れる知らせを返す。**何も書かない** |
| `reserveMemNotices(db, recipient, noticeIds)` | D（実際に brief に入れて送る直前） | 1 つの transaction で、渡された ID のうち今も受け取れる `pending` だけを `reserved` にし、`mem_notice_attempts` を 1 行作り `attemptId` を返す。予算で省いた知らせは C が ID を渡さないので `pending` のまま |
| `settleMemNoticeAttempt(db, attemptId, sendState)` | D（送信の結果が出た後） | `sendState` は送信の到達確認の 3 値（`'sent'|'not-sent'|'indeterminate'`、`src/lib/session/send-attempt-types.ts:24`）。`sent` → 受領（`acknowledged`、`acknowledged_by` = 試みの `audience`）。`not-sent` → `pending` に戻す。`indeterminate` → `pending` に戻し `uncertain_count+1`（C は次の brief で「前回の配送が確かめられなかった知らせ」と付けて出す）。2 回目の settle は何もしない |
| `acknowledgeMemNoticeByHuman(db, noticeId, version)` | G（画面の引き取り） | `acknowledged_by='human'` |

- **受領にしない**：予算で省いた・配送の結果が不明・`check`・他の instance の brief（受け取れないので渡らない）・画面の preview（`listMemNoticesFor` は書かない）
- **サーバの再起動**：`reserved` のまま残った試みは、`boot_id` が今のプロセスの boot id（新規 `src/lib/mem/process-boot.ts`、`getOrInitGlobal` に `randomUUID()`。relay の `relayServerBootId` と同じ作り、`src/lib/relay/relay-boot.ts:30`）と違えば、次の `listMemNoticesFor`・`reserveMemNotices` の読みで `indeterminate` と同じに扱う（`result='abandoned'`、知らせは `pending`・`uncertain_count+1`）。起動時の処理も時間の見張りも足さず、読んだときに比べる。同じプロセスで `reserved` のまま 10 分を過ぎた試みも、読んだときに同じ扱い［見立て：D の送信の期限より十分長い］
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

作り：評価は呼び出しの中だけで走り、終われば何も残さない。キャッシュは実行中の Promise の共有だけ（§1.1）。期限は `execFile` の `timeout` と、評価の中で 1 つだけ使う期限の helper（`src/lib/mem/eval-deadline.ts` の `withDeadline`。`setTimeout` を `finally` で `clearTimeout`）。boot id は読んだときに作る値で、起動時の処理を足さない（§3.5）。

試験：

| # | 試験 | 陽性（作った・残したら落ちる） | 陰性 |
|---|---|---|---|
| G1 | ガード `tests/unit/guards/mem-no-resident-4222.test.ts`：`src/lib/mem/**`・`src/app/api/**/mem/**`・`src/cli/commands/mem*.ts` を走査し、`setInterval`・`setImmediate`・`new Worker`・`fork(`・`detached: true`・`.unref(`・`schedule-manager`/`timer-manager` の import が無いこと、`setTimeout(` は `eval-deadline.ts` だけにあること | 走査の関数に「`setInterval(` を含む文字列」「`eval-deadline.ts` 以外の `setTimeout(`」を渡すと違反を返す（ガード自身の陽性の対照） | 今の `src/lib/mem/**` で違反 0 件 |
| G2 | 同じガードで、サーバの起動の経路（`server.ts`・`src/lib/server/**`［事実：どちらも在る。`src/instrumentation*` は無い］）が `@/lib/mem` を import しないこと | 走査の関数に import を含む文字列を渡すと違反 | 今の起動の経路で 0 件 |
| G3 | 実行の試験：`vi.useFakeTimers()` の下で、全型の項目を `evaluateMemConditions` で評価し終えた後に `vi.getTimerCount() === 0`。照会のタイムアウトで終わった場合・期限で打ち切った場合も 0 | `withDeadline` の `clearTimeout` を外した版（試験の中の差し替え）で 1 以上 | 通常の評価で 0 |
| G4 | 子プロセス：`execFile` の差し替えで、開始した数と終わった数が評価の終わりに一致する（打ち切った照会も kill されて終わる） | 終わらない差し替えを 1 つ混ぜると、評価は期限で返り、その照会は kill を受ける（kill の呼び出しの数で確かめる） | 通常で一致 |

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
| `src/lib/mem/close-when.ts` | S1：`session` の名前空間 |
| `tests/fixtures/mem/close-when-v1.json` | S1：`inputs.session`・`stored.session`・`invalid` |
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
| U3 | `branch` の作り直しの見分けは local の reflog に頼る。reflog が無い・期限切れの repository と、remote で `tipAtCreate` の子孫から作り直したブランチは見分けられない（§1.4）。正確に追うなら `pr:` の型を使うよう利用者の説明に書く。`merged` の local で、merge の後にブランチを消した場合は不明のまま（人が閉じる） |
| U4 | S2（relay の `expired`・`cancelled` を成立・`failure` で閉じる）は解釈。「不成立のまま残す」が Issue の意図なら §2 の 2 行と試験を入れ替える |
| U5 | S1 の狭め方で、B より前に名前空間なしで保存された `session` の項目は永遠に不明になる（閉じないだけで、人は閉じられる）。v66 の利用者は数日分（A のマージは 2026-11-08）で、移行の処理は作らない見立て |
| U6 | §3.3 の「次の世代」の基準（R の世代の `created_at > item_created_at`）は、作成者の生前に後から加わった別の instance も含む。作成者の終わりの時刻は A の世代の表に残らない（行が消える）ので、これより狭くするには世代の終わりの記録が要る |
| U7 | §7 G2 の起動の経路は `server.ts` と `src/lib/server/` の在ることだけを確かめた（中身は読んでいない）。起動から import される他のファイルがあれば、実装の契約でガードの対象に足す |
| U8 | `mem check` を CLI の `$?` で「不明が残った」と分けるか（今は常に 0 で、結果は `--json` の `results`）。ループで使うなら 57 等を足す案がある |
