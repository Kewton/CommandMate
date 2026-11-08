# mem の設定・置き場・CRUD の CLI（Issue #4221 / Epic #4220 の子 A）設計

- 状態：設計の段（実装前）。第 3 版：Codex の事前レビュー 1 回目（P1 8 件・P2 3 件、2026-11-08）と 2 回目（P1 6 件・P2 3 件、同日）を反映した。処置の一覧は §16
- 前提：Epic #4220 の決定事項 D1〜D13。とくに D3〜D7・D12
- 凡例：**［事実］** = この文書を書いた時点（2026-11-08、`feature/4221-worktree` = develop `2307b8135`）でファイルと行を読んで確かめたもの。**［見立て］** = 設計としての判断。**［未確認］** = 読んでいない・実測していないもの。行番号は確認時点のもので、実装の契約では名前で探し直す

---

## 0. Epic の決定と食い違う点

**食い違う点は無い**（D1〜D13 と違う作りは採らない）。D の文面だけでは一意に決まらず、この文書が解釈を選んだ点を次に挙げる。レビューで解釈が違えば、ここを直してから実装する。

| # | 決定 | 選んだ解釈（第 2 版） | 理由 |
|---|---|---|---|
| T1 | D3「off は何も評価・更新しない」と D7「`now` は #2427 のメモと同じ正本」 | 1 つの行が #2427 のメモでも mem の `now` でもある（D7）。**mem の `now` である行（`mem_item_id` がある行）は、どの経路・どの mode で書いても mem の検査（§6）を通った値しか入らない**。#2427 の画面のメモの経路も、その行を書くときは mem の検査をかけ、通らなければ 400 で断る（行は前の値のまま）。mem の行でないメモは、off・derived・曖昧・未登録では今までどおり（#2427 の検査だけ）。on では書くと mem の `now` になるので mem の検査をかける（§6.3。400 になる条件は §6.3 の表が正本）。加えて、mem の出口（list・`--json`・brief・画面の mem 表示）は、保存時より新しい検査の規則で読み直し、通らない値を出さない（§6.4） | 第 1 版は off 中の画面の書き込みを未検査のまま mem の行に入れ、`on` に戻すと list・brief に出た（レビュー P1-1）。検査の入口を「行」に結ぶと、経路を足しても抜けない。mem の行でないメモの挙動は変えないので、off（既定）の利用者にとって #2427 は今までの機能のまま |
| T1' | D3 の「derived は手で書いた項目を凍結する」と、人が画面のメモで mem の `now` を書き換えること | 凍結が止めるのは Agent の口（CLI）と B の評価・close・知らせ。人が #2427 の画面のメモから自分の目で書き換えるのは止めない（版つき、§10.2）。D6「手で書いた項目を変えたり閉じたりできるのは作成者と人」の人の経路として扱う | 止めると #2427 の画面のメモが、一度 mem を使った枠だけ off の間に編集できなくなる。人の書き込みは「評価」ではない |
| T2 | D3「off は更新しない」と、instance・worktree を消すときの `now` の保持 | mem の行である `now` は、mode に関係なく、消える前に `mem_items` へ closed（`close_reason='slot-removed'`）として移す。値は T1 により検査済み | 「`on → off → on` で項目が保持される」（受入基準）を、off の間の roster 編集でも満たすため。評価でも利用者の操作でもない |
| T3 | D3「変える経路は画面（PC・スマホ）だけ」 | 「画面の経路」の印を、**画面だけが付ける独自ヘッダ（`X-CommandMate-Client: screen`）＋ `Origin` が要求の宛先と一致**にする。宛先の scheme・host は §11.2 の規則（転送のヘッダ）で決める。`Sec-Fetch-Site` は要らない（§11.2）。同じ OS 権限のプロセスはこの印を偽れるので、**保証ではなく検査** | 第 1 版の `Sec-Fetch-Site` 必須は、スマホから LAN の HTTP（`http://<PCのIP>:3000`、`docs/user-guide/webapp-guide.md:906` 付近の手順）で開いた画面を断る（Fetch Metadata は安全でない HTTP の origin には付かない。レビュー P1-8）。ブラウザは同一 origin の `PUT`・`DELETE` の `fetch` に `Origin` を付け、独自ヘッダつきの別 origin の要求は CORS の preflight で止まる。D3 自身が「保証と書かず、検査の限界として書く」としている |
| T4 | Issue の CLI 例は `add` の `--close-when` を必須に見せている | 既定値を持つ kind（`now` → `replaced`、`note` → `manual`、`decision` → `promoted`）だけ省略できる。他の kind は必須（§2.3） | Issue 本文が「`close_when` が必須の kind と、既定値を持つ kind を表にする」と求めている |

---

## 1. 契約の説明と実コードの照合（事実）

| 契約・Issue の説明 | 実コード | 判断 |
|---|---|---|
| セッションメモは `src/lib/db/memo-db.ts` | **違う。** `memo-db.ts` は `worktree_memos`（Issue #479 のワークツリーのメモ）の CRUD（`src/lib/db/memo-db.ts:1-6`）。#2427 のセッションメモは `src/lib/db/agent-instances-db.ts` にある（`MAX_SESSION_NOTE_LENGTH = 100` は `agent-instances-db.ts:563`、`normalizeSessionNoteText` は `:616`、`setSessionNote` は `:717`、`pruneSessionNotes` は `:766`） | 実コードを正とする。§10 は `agent-instances-db.ts` を変える |
| `migrations/v61-session-notes.ts` | `session_notes(worktree_id, instance_id, note NOT NULL, updated_at, PK(worktree_id, instance_id), FK worktrees ON DELETE CASCADE)`（`v61-session-notes.ts:70`） | 一致 |
| `src/app/api/worktrees/[id]/instances/notes/route.ts` | `GET` / `PUT`。`PUT` は roster にある instance だけ受ける（`route.ts:119`）、`setSessionNote` を呼ぶ（`:129`）、ログは長さだけ（`:131`） | 一致 |
| 最新の migration | `CURRENT_SCHEMA_VERSION = 65`（`src/lib/db/migrations/runner.ts:34`）、`v65_migrations` が最後（`runner.ts:103`、`v65-agent-instance-creation-keys.ts`） | 新しい版は **v66** |
| #4114 の所属の解決 | `src/lib/agent-roles/resolve.ts`。`withSettledWorktreeMembership`（`:254`）が worktree から登録 root の集合（`members`・`undetermined`）を作る。`membershipFrom`（`:163`）が「`repository_path` が名指す root」または「`git rev-parse --git-common-dir` が一致する root」を候補にし、有効な root があれば有効なものだけを数える（`:186-188`）。`resolveDefaultsForTool`（`:338`）が root ごとの設定を比べ、違えば `ambiguous`（`root-settings-differ`）、git が答えない root の設定が違えば `ambiguous`（`membership-undetermined`）。worktree の署名は `[path, repositoryPath]` だけ（`:268`） | membership の部分を一般化して再利用する（§9） |
| roster の全置換 | `setAgentInstances`（`agent-instances-db.ts:248`）は「ID＋ツール」の組で残す行を決め（`:269` 付近、#4132）、組が変わった ID の creation key を外す。一方 `pruneSessionNotes(…, instances.map(id))`（`:287`）は ID だけで残す。`agent_instances` は全件 DELETE → INSERT で、`created_at` は毎回書き直る（`:299`） | 世代は「ID＋ツール」の組に結ぶ。`created_at` は世代に使えない（§10.4） |
| worktree の削除 | `deleteWorktreesByIds`（`worktree-db.ts:978`）・`deleteRepositoryWorktrees`（`:943`）は、同じトランザクションで先に `deleteWorktreeChildRows`（`migrations/worktree-id-rename.ts:84`。`worktree_id` 列を持つすべての表から DELETE）を呼び（`worktree-db.ts:956`・`:988` 付近）、その後に `worktrees` を消す。ID の改名（`renameWorktreeIdPreservingChildren`、`worktree-id-rename.ts:128`）は子の行を新しい ID へ付け替える | `now` の退避は `deleteWorktreeChildRows` より前に置く（§10.4） |
| CLI の終了コード | `ExitCode` は 0〜5・99（`src/cli/types/index.ts:10-19`）。ほかに 10・11・124（wait）、20・21（verify）、40・41（strict respond、`:276`）、11・12・13（`:627` 付近の別コマンド）、30（`:663`）、31・32（`RoleExitCode`、`:674`）。50 番台は未使用 | mem は 50 番台を使う（§12） |
| CLI の認証ヘッダ | `ApiClient.getHeaders` は token があるときだけ `Authorization: Bearer` を付ける（`src/cli/utils/api-client.ts:200-202`）。`Origin` も独自ヘッダも付けない | 「Bearer が無い＝画面」とは言えない（§11.2 で使わない） |

---

## 2. 決めること 2：`close_when` の入力の文法と保存の形

B（#4222）の型の表（`issue`・`pr`・`branch`・`relay`・`worktree`・`session`・`at`・`manual`）に合わせる。A は **文法・正規化・保存の形・既定値・不正の拒否・作成時の世代の保存** を受け持ち、B は保存された形を評価する。A に `now` 専用の型 `replaced` を足す（B は評価しない。次の `now` の書き込みで A が閉じる）。

### 2.1 入力の文法（CLI の `--close-when` と API の `closeWhen` の文字列）

```
cond      := "manual" | "replaced" | issue | pr | branch | relay | worktree | session | at
issue     := "issue:" target "#" N            ; 成立 = closed
pr        := "pr:" target "#" N [ "?state=merged" | "?state=closed" ]   ; 既定 state=merged
branch    := "branch:" name "?" ( "merged=" ref | "deleted" ) [ "&scope=" ("local"|"remote") ]   ; scope の既定 local
relay     := "relay:" relay-id
worktree  := "worktree:" worktree-id      ; 成立 = 削除された（作成時の世代が無くなった）
session   := "session:" session-or-run-id ; PID は受けない
at        := "at:" ISO8601-with-offset    ; 例 at:2026-11-09T09:00+09:00
target    := "" | host "/" owner "/" repo  ; 空 = 項目の repository の origin
```

- `#N` だけ（`issue:#4221`）は、項目の repository の `origin` remote の URL から host・owner・repo を補って保存する（B の表「番号だけの `#N` は項目の repository を既定にして保存する」）。origin が無い・解析できないときは **入力の不正**で断る（推測で補わない）［見立て］
- `branch` の `merged=` は合流先の ref。作成したときの tip（`git rev-parse <name>`）を A が保存時に取って入れる（B の「作成したときの tip より後の commit を含む」の判定材料）。取れないときは断る
- `worktree` は、保存時に §10.1 の `mem_worktree_incarnations` の今の世代を取り（無ければ同じトランザクションで作り）、ID と世代の組で保存する。存在しない worktree ID は断る。**B は「保存した世代（`worktreeIncarnation`）がどの worktree の行としても存続していない」を成立とする**（ID では引かない。A は `worktreeIncarnationAlive(db, incarnation)` を用意する）。worktree の改名（v54/v55、`renameWorktreeIdPreservingChildren`）では世代の行が新しい ID へ付け替わって存続するので**不成立**、削除（同じ path での作り直しを含む）では世代の行が消えるので**成立**。第 2 版の「その ID の行が無い」は改名を削除と読んだ（2 回目のレビュー 5）。この 2 つの場合は `tests/fixtures/mem/close-when-v1.json` の `worktreeLifecycle` に入れ、B も同じ fixture で評価する
- `session` は保存時に分かれば #4115 のセッションの世代（`role-launch.ts` の `sessionGeneration`）を一緒に保存する。分からなければ `null`（§10.5）
- `at` はオフセット必須（`Z` か `±HH:MM`）。オフセットの無い時刻は断る（サーバのタイムゾーンで黙って解釈しない）。過去の時刻は断らない
- 未知の型・未知のキー・重複キー・余分な文字・長さ 300 code point 超・§2.3 の表で kind が受けない型は、保存の前に **入力の不正**（exit 2、`code: "invalid_close_when"`）

### 2.2 保存の形（`close_when` 列、JSON、`schema` は版）

| 型 | 保存する JSON（`schema: 1`） |
|---|---|
| `manual` | `{"schema":1,"type":"manual"}` |
| `replaced` | `{"schema":1,"type":"replaced"}`（`now` だけ） |
| `issue` | `{"schema":1,"type":"issue","host":"github.com","owner":"Kewton","repo":"CommandMate","number":4221}` |
| `pr` | 上と同じ形に `"state":"merged"\|"closed"` |
| `branch` | `{"schema":1,"type":"branch","repositoryId":"…","name":"feature/x","event":"merged"\|"deleted","into":"develop"\|null,"scope":"local"\|"remote","tipAtCreate":"<40 hex>"}` |
| `relay` | `{"schema":1,"type":"relay","relayId":"…"}` |
| `worktree` | `{"schema":1,"type":"worktree","worktreeId":"…","worktreeIncarnation":"<uuid>"}` |
| `session` | `{"schema":1,"type":"session","sessionId":"…","sessionGeneration":"<uuid>"\|null}` |
| `at` | `{"schema":1,"type":"at","epochMs":1762646400000,"offset":"+09:00"}`（評価は `epochMs`、`offset` は表示用） |
| `promoted`（decision の既定） | 列は `NULL`。§3.2 の遷移でだけ閉じる |

- host・owner・repo は大文字小文字を保存のまま持ち、比較は B が大文字小文字を無視して行う［見立て］
- `schema` が読み手の知らない版のときは、B は「不明」として扱う（閉じない）。A は今の版 1 だけを書く
- **A だけで保存した値を B が読める**ことを、A の実装のテストで固定する：各型の保存値を fixture（`tests/fixtures/mem/close-when-v1.json`）にし、§2.3 の許可表も同じ fixture に持つ。B の実装は同じ fixture を読む（§13 の T-COND）

### 2.3 kind × 条件の型の許可表（一意。A の検査と B の fixture で共有）

○ = 受ける、既 = 省略時の既定、× = 断る（`invalid_close_when`）。

| kind ＼ 型 | 省略 | `replaced` | `manual` | `issue` | `pr` | `branch` | `relay` | `worktree` | `session` | `at` |
|---|---|---|---|---|---|---|---|---|---|---|
| `now` | 既 `replaced` | ○ | × | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| `waiting` | ×（必須） | × | × | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| `decision` | 既 `promoted` | × | × | ○ | ○ | ○ | × | × | × | ○ |
| `next` | ×（必須） | × | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| `external` | ×（必須） | × | ○ | ○ | ○ | ○ | × | × | × | ○ |
| `note` | 既 `manual` | × | ○ | × | × | × | × | × | × | ○ |

- `replaced` は `now` だけ（第 1 版の表は `waiting`・`next` に許していた。レビュー P2-2）
- `waiting` に `manual` を許さない：待つ相手を型で書かせる［見立て］
- `decision` に条件を書いても、`promoted` になるまで成立で閉じない（§3.2）。`relay`・`worktree`・`session` は作業の終わりで、決定の終わりではないので受けない［見立て］

---

## 3. 決めること 3：kind ごとの状態の遷移

状態の列は `state`：`open` / `recorded` / `promoted` / `closed`。`recorded`・`promoted` は `decision` だけ。終了の理由（`close_reason`）は成否と分けて持つ（D8）。

### 3.1 非 decision（`now`・`waiting`・`next`・`external`・`note`）

| 現在 | きっかけ | 次 | 誰ができるか | mode |
|---|---|---|---|---|
| （なし） | `mem add` / `mem now` | `open` | 書いた instance（作成者。世代つき） | `on` だけ |
| `open` | `mem update --if-version` | `open`（`version+1`） | 作成者の instance（同じ世代）・人（画面） | CLI は `on` だけ。人は T1' |
| `open` | `mem close` | `closed`（`close_reason='manual'`） | 作成者・人 | CLI は `on` だけ |
| `open` | B の評価で成立 | `closed`（`close_reason='condition'`） | サーバ（誰の項目にも効く、D6） | `on` だけ |
| `open`（`now`） | 同じ instance の次の `mem now`、または人の画面のメモの書き込み（mode `on`） | 古い内容は `mem_items` に `closed`（`superseded`）、枠は新しい内容（`version+1`、新しい `mem_item_id`） | その instance・人 | `on` |
| `open`（`now`） | 人の画面のメモの書き込み（mode `off`・`derived`） | 同じ `mem_item_id` のまま内容を更新（`version+1`、`updated_by='human'`）。退避は作らない | 人 | `off`・`derived`（T1'） |
| `open`（`now`） | 人が画面のメモを空にする | `mem_items` に `closed`（`manual`、`updated_by='human'`）、枠の行は消える | 人 | 全 mode |
| `open`（`now`） | instance が roster から外れる（ID＋ツールの組で）・worktree が消える | `mem_items` に `closed`（`slot-removed`） | サーバ（既存の削除に伴う） | **全 mode**（T2） |
| `closed` | — | 終端。再び開かない（開き直しは新しい項目） | — | — |
| 任意 | `mem purge --confirm` | 行の削除 | 人（§8.3） | 全 mode |

### 3.2 decision（E の N05：記録と反映を分ける）

| 現在 | きっかけ | 次 | 誰が | mode |
|---|---|---|---|---|
| （なし） | `mem add --kind decision` | `open` | 書いた instance | `on` |
| `open` | E：人が画面で承認し、コメント・文書へ書けた | `recorded` | 人（画面）だけ | `on` |
| `open` | E：承認時に「記録だけ」を選んだ | `promoted`（`recorded` を経て） | 人（画面）だけ | `on` |
| `recorded` | E：人が正本への反映を画面で確かめた | `promoted` | 人（画面）だけ | `on` |
| `promoted` | B の条件の成立／人の close | `closed` | サーバ／人 | `on` |
| `open`・`recorded` | B の条件が成立 | **変わらない**（「未反映」として残す。B は成立の結果だけ記録する） | — | — |
| `open` | `mem close --reason` | `closed`（`close_reason='withdrawn'`） | 作成者の instance（取り下げ）・人 | `on` |
| `recorded` | `mem close` | 断る（exit 55）。人が画面で閉じる | — | — |

- A には E の画面の経路が無い。A の実装は `open` と `closed`（取り下げ）だけを作り、`recorded` / `promoted` の列の値と遷移の検査（DB の `CHECK` と関数の表）だけを先に置く［見立て］
- decision の close（取り下げ）と E の承認が競合したときは版（`version`）で決める：先に書いた方が勝ち、後は版の競合（exit 51 / HTTP 409）

---

## 4. 決めること 1：mode × 操作 × 出力・exit code

mode の判断は 1 つの関数（`resolveMemTarget`、§9）で行い、CLI・API・#2427 のメモの route・B・C・F・G はその結果だけを見る（同じ判断を写さない）。対象の指定は 2 通り（worktree から／repository＋ブランチの明示）で、どちらも同じ関数に入り、**指定したブランチの** mode を返す（今そこで開いているブランチの mode で代用しない）。**曖昧**（§9.4）と**未登録**は、書き込みでは断り、評価・表示・促しでは `off` と同じ扱いにする。

| 操作 | `off` | `derived` | `on` | 曖昧・未登録 |
|---|---|---|---|---|
| `mem mode`（読む） | 0、`mode:"off"` と決めた規則 | 0、`derived` | 0、`on` | 曖昧は exit 53・候補の root、未登録は exit 52 |
| `mem now` / `add` / `update` / `close`（手で書く口） | **exit 50 `disabled`**、何も保存しない | **exit 50**、何も保存しない（凍結） | 0 | 52 / 53、何も保存しない |
| `mem list` | exit 50（項目は返さない。保持はしている） | 0、項目に `frozen:true`。評価しない | 0、B の評価の結果つき | 52 / 53 |
| `mem check`（B） | exit 50 | exit 50 | 0 | 52 / 53 |
| B：条件の評価 | しない | しない | 読むとき（list・check・brief）にする | しない |
| B：自動の close | しない | しない | する | しない |
| B：終わった知らせの作成 | しない | しない | する | しない |
| B/D：知らせの受領 | しない（作成済みの知らせは残す） | しない（同上） | brief に入れて送れた ID だけ受領 | しない |
| C：brief | 出さない | 導いた状態だけ（mem の項目は出さない） | 導いた状態＋項目（§6.4 の出口の検査を通ったものだけ） | 出さない |
| F：更新の促し | 出さない | 出さない | 出す | 出さない |
| G：画面での項目の編集（`now` 以外） | 断る（409 `disabled`） | 断る（凍結） | 可（版つき） | 断る |
| #2427 の画面のメモ（mem の行でない） | 今までどおり | 今までどおり | 書くと mem の `now` になる（mem の検査つき、§10.2） | 今までどおり |
| #2427 の画面のメモ（mem の行） | mem の検査＋版つきで更新（T1・T1'） | 同左 | mem の検査＋版つきで置き換え（superseded） | mem の検査＋版つきで更新（保存先は行に記録済みの所属） |
| 画面：mode の変更（§11） | 可 | 可 | 可 | 可（root ごとの設定の画面で揃える） |
| `slot-removed` の保存（T2） | する | する | する | する |
| `mem purge` | 可（`--confirm` 必須） | 可 | 可 | 52 / 53 |

- `on → off/derived → on` のとき、off/derived の間に成立した条件は、`on` に戻った後の最初の読み（list・check・brief）で評価され、そこで閉じる。off の間に「閉じたことにする」記録は作らない
- mode は書き込みと同じ同期の区間で読む（§9.3）。画面で mode を変えた直後の書き込みが古い mode で通らない

---

## 5. 決めること 5：保存の場所・schema・原子的な更新・保持

### 5.1 置き場

- SQLite（既存の DB、`getDbInstance()`）。新しいファイルを作らない。worktree のファイルには置かない（D3）
- テーブルは §10。項目は `repository_id`＋ブランチ名で持ち、worktree の行には紐づけない

### 5.2 保持

| 出来事 | 設定 | 項目（`mem_items`） | `now`（`session_notes`） |
|---|---|---|---|
| サーバの再起動 | 保持（DB） | 保持（DB、`version`・世代も） | 保持（世代の列も） |
| worktree の削除・作り直し（同じブランチ） | 保持（repository に付く） | **保持**。`origin_worktree_id` は来歴（`worktree_id` という列名にしないので、`deleteWorktreeChildRows` の対象にならない、§10.3） | 行は消える（既存）。`deleteWorktreeChildRows` の前に `slot-removed` として `mem_items` へ移す（T2） |
| instance が roster から外れる（ID＋ツールの組で） | — | 保持。作成者の世代が終わるので、以後の update/close は人だけ | mem の行は退避してから消す。mem の行でないメモは今までどおり（ID だけの prune） |
| 同じ ID で別のツールに変える | — | 前の項目は前の世代のまま | mem の行は退避して消す（新しい世代は空の枠から）。§10.4 |
| alias の変更・並べ替え | — | 変わらない | 変わらない（世代も維持） |
| 同じ instance ID の作り直し | — | 前の項目は前の世代のまま。新しい instance は作成者にならない | 新しい世代は空の枠から |
| 登録 root の追加・無効化 | root ごと | 移さない。読みは同じ repository の全候補 root（無効を含む）の ID を合わせる（§9.5） | — |
| repository の登録の削除（`deleteRepository`、`db-repository.ts:317`） | CASCADE で消える | 残る（FK なし）。表示されない（§15 U3） | — |
| mode を `off` にする | — | 消さない | 消さない |

### 5.3 原子的な更新

- 所属の解決（git を待つ）と書き込みを 1 つの手順に結ぶ（§9.3）：git の答えがすべて揃った後、**同じ同期の区間**の中で、観測の前提（worktree の path・`repository_path`・登録 root の集合・HEAD）の照合 → mode の決定 → `db.transaction` での書き込みまでを行う。better-sqlite3 は同期なので、この区間に他の要求は入らない（`resolve.ts:213` の `finishAttempt` と同じ考え方）。前提が変わっていたら最大 3 回まで観測し直し、それでも変わるなら exit 53（`registration_changed`）
- トランザクションの中：対象の行を読む → 版・作成者・件数の上限・key を検査 → 退避（superseded・slot-removed）→ 書く → 版を `+1`。どこかで失敗すれば退避も含めて全部戻る
- 全体を書き戻す API を作らない（D6）。項目ごとの `add`・`update`（版つき）・`close`

### 5.4 `--key`（冪等）

- **範囲**：key は書いた instance の世代（`origin_incarnation`、UUID）ごと。一意の制約は `(origin_incarnation, idempotency_key)`。別の instance・別の世代の同じ key は別の要求（再送とみなさない）
- **要求の同一性**（指紋）：正規化後の `repository_id`・ブランチ・`origin_worktree_id`・`origin_instance_id`・`origin_incarnation`・kind・`text`・`close_when`（保存の JSON）・`promote_to`・`quote`・`quote_at`・`evidence` を、決まった順の JSON にして SHA-256。どれか 1 つでも違えば別の要求
- 同じ範囲・同じ key・同じ指紋：既にある項目をそのまま返す（exit 0、`replayed:true`）。既にある項目が閉じていても同じ ID を返す（状態はそのまま）
- 同じ範囲・同じ key・違う指紋（同じ世代のままブランチを切り替えた、`quote_at` だけ違う、など）：exit 54 `duplicate_key`、既にある項目の ID を返す
- v65 の `agent_instance_creation_keys` と同じ型［事実：`v65-agent-instance-creation-keys.ts`］。key の行は項目の行（`mem_items.idempotency_key`）に持つ

---

## 6. 決めること 6：自由入力の欄の検査

すべて **サーバで** 検査する（CLI の検査は便宜。#2427 の `MAX_SESSION_NOTE_LENGTH` と同じ考え方、`agent-instances-db.ts:550-563`）。長さは code point で数える（`Array.from(text).length`、#2427 と同じ）。検査は 1 つの関数 `validateMemFields`（`src/lib/mem/validate.ts`）で、mem の API と #2427 のメモの route（mem の行を書くとき）の両方が呼ぶ。

### 6.1 欄ごとの規則

| 欄 | 上限（code point） | 改行・タブ | ほかの制御文字 | 秘密らしい文字列 | 絶対パス | 断ったときの応答 |
|---|---|---|---|---|---|---|
| `text`（`now`） | **100**（#2427 と同じ、§10.6） | 空白に畳む（`normalizeSessionNoteText` と同じ） | C0・DEL は畳む。C1・双方向の制御・U+FEFF は断る | 断る | 許す（自由文） | `{code:"secret_like", field:"text", rule:"<id>"}` 等 |
| `text`（`now` 以外） | 1000 | LF・TAB は許す。CR・CRLF は LF に | 断る（`control_char`） | 断る | 許す | 同上 |
| `quote` | 500 | LF 許す | 断る | 断る | 許す | 同上 |
| `quote_at` | ISO8601（オフセット必須）。未来 5 分超は断る | — | — | — | — | `invalid_quote_at` |
| `evidence` | 1 項目に 5 件まで、各 300 | 不可 | 断る | 断る | **断る**（`path:` は相対だけ） | `invalid_evidence`・`absolute_path` 等 |
| `promote_to` | 300 | 不可 | 断る | 断る | **断る** | `invalid_promote_to`・`absolute_path` 等 |
| `reason`（close） | 300 | 空白に畳む | 畳む | 断る | 許す | 同上 |
| `--key` | 128、`[A-Za-z0-9._:-]` だけ | — | — | — | — | `invalid_key` |

- **絶対パスを断るのは構造化した欄（`evidence`・`promote_to`）だけ**。自由文（`text`・`quote`・`reason`）の `/tmp/mem-example` のような絶対パスは、Agent の言葉としてそのまま保存し、出口にも出す（§7）。第 1 版の §7 の「DB に絶対パスを出さない」は構造化した欄の解決に使った絶対パスのことで、書き方が広すぎた（レビュー P2-3）［見立て：自由文の絶対パスを断ると、作業の記録が書けなくなる］
- **双方向の制御**：U+202A〜U+202E、U+2066〜U+2069。`now` の C0 を畳むのは #2427 と同じ挙動に揃えるため。C1・双方向の制御は #2427 の正規化が畳まないので、mem の行では断る
- **秘密らしい文字列**：新しい `src/lib/mem/secret-scan.ts` に規則を ID つきで持ち、規則の集合に版（`MEM_SECRET_RULES_VERSION`、整数）を付ける。最初の規則：`bearer`（`Bearer\s+\S{16,}`）・`assignment`（`(password|passwd|pwd|token|secret|api[_-]?key|auth)\s*[=:]\s*\S{8,}`）・`authorization-header`・`private-key-block`（`-----BEGIN … PRIVATE KEY-----`）・`url-userinfo`（`scheme://user:pass@`）・`github-token`（`gh[pousr]_[A-Za-z0-9]{36,}`・`github_pat_`）・`anthropic-key`（`sk-ant-`）・`openai-key`（`sk-[A-Za-z0-9]{20,}`）・`aws-access-key`（`AKIA[0-9A-Z]{16}`）・`slack-token`（`xox[abprs]-`）・`jwt`（`eyJ…\.…\.…`）。ロガーの `SENSITIVE_PATTERNS`（`src/lib/logger.ts:75`）は置き換えの規則で、拒否の判定には使わない。エントロピーだけの判定はしない［見立て］
- **`evidence` の形**：`path:<repo-relative>[:<line>]`・`commit:<7〜40 hex>`・`issue:<target>#N`・`pr:<target>#N`・`task:<id>`・`relay:<id>`・`url:https://…`

### 6.2 `path:` の正規化（`evidence` と `promote_to`）

1. 絶対パス・`~`・NUL・バックスラッシュを断る（`absolute_path`。原文は応答に出さない）
2. POSIX で正規化し、`..` で worktree の root の外へ出るものを断る（`outside_repository`）
3. worktree の root から各成分を `lstat` し、**どれか 1 つでも symlink なら断る**（`symlink`）。`evidence` は存在を必須にする。`promote_to` は存在しなくてよいが、存在する最も深い祖先までを同じ検査にかける
4. `findSensitivePathSegment`（`src/lib/security/sensitive-file-guard.ts:144`）が当たる成分（`.env` など）は断る（`sensitive_path`）
5. 保存するのは正規化後の相対パスだけ。解決に使った絶対パスは保存しない
- 既存の `isWithinRoot`（`src/lib/security/path-validator.ts:44`）と `resolveAndValidateRealPath`（`:184`）は realpath で symlink を **辿って** 内側かを見る関数なので、「symlink を断る」には足りない。新しく `lstat` の連鎖を書く［見立て。`:184` の中身の全文は未確認］
- repository＋ブランチの明示（worktree なし）の経路では `path:` を検査する root が無いので、`evidence`・`promote_to` の `path:` を受けない（書き込み自体がその経路に無い、§9.2）

### 6.3 #2427 の画面のメモの route での検査（T1）

| 行の状態 | mode | かける検査 | 通らないとき |
|---|---|---|---|
| mem の行でない（`mem_item_id IS NULL`） | `off`・`derived`・曖昧・未登録 | #2427 の検査だけ（今までどおり） | 今までどおり |
| mem の行でない | `on` | `validateMemFields`（`now` の規則） | 400、`code`・`field`・`rule`。行は前の値のまま |
| mem の行 | どの mode でも | `validateMemFields`（`now` の規則） | 400。行は前の値のまま |

### 6.4 出口での読み直し

- 保存した行は `checked_rules_version`（保存時の `MEM_SECRET_RULES_VERSION`）を持つ（§10）
- mem の出口（`mem list`・`--json`・版の競合の応答・C の brief・G の mem の表示）は、`checked_rules_version` が今の版より古い行を今の規則で読み直す。読み直す欄は自由入力のすべて（`text`・`quote`・`evidence` の各項目・`promote_to`・`close_note`）。どれか 1 つでも当たった項目は、**専用の出力形（withheld の形）**で出す。DB の値は書き換えない（人が画面で直すか purge する）
- **withheld の形**（`src/lib/mem/present.ts` の `presentMemItem` 1 つで作り、全出口が共有する。2 回目のレビュー 6）：`id`・`kind`・`state`・`owner`・`createdBy`・`updatedBy`・`version`・`createdAt`・`updatedAt`・`closedAt`・`closeReason`・`stale`・`frozen` と `withheld: {code:"secret_like", field:"<当たった欄>", rule:"<id>"}` だけ。**`text`・`quote`・`quoteAt`・`evidence`・`promoteTo`・`closeWhen`・`closeNote` の鍵そのものを出さない**（当たった欄だけを消すのではない。隣の欄に同じ値の断片がある場合に備える）
- 読み直しは表示のたびに行い、結果は保存しない（定期の実行を足さない、D8・D13）［見立て：行数は §8.1 の上限で小さい］

---

## 7. 決めること 7：どこに何が出るか

| 出口 | 出すもの | 出さないもの |
|---|---|---|
| DB（保存） | 検査を通った正規化後の値（自由文の絶対パスを含む）、作成者・更新者、世代、時刻（サーバ）、`version`、`close_when` の JSON、`checked_rules_version` | 断った入力（何も書かない）、構造化した欄の解決に使った絶対パス |
| サーバのログ | `mem-item-written` 等の出来事名・`itemId`・kind・`repositoryId`・ブランチ・instance・**各欄の長さ**・断った理由の `code`・`field`・`rule` | 自由入力の本文（通った値も含む）、断った原文、構造化した欄の絶対パス（#2427 の `route.ts:131` と同じ「長さだけ」） |
| `--json`（成功） | 項目の全欄（保存した値そのもの。§6.4 で止めた項目は `withheld`） | — |
| `--json`・CLI のエラー（入力の不正） | `code`・`field`・`rule`・上限 | 断った原文・当たった部分文字列・絶対パス |
| `--json`・CLI のエラー（版の競合 exit 51） | `currentVersion` と、**今保存されている項目の全欄**（保存済み＝検査済みの値。§6.4 の止めはここでもかかる） | 要求側の新しい値（呼び出し側の手元にあるので返さない） |
| `--json`・CLI のエラー（重複 exit 54） | 既にある項目の ID・`version` | 既にある項目の本文（同じ範囲の要求なので ID で読み直せる） |
| `--json`・CLI のエラー（曖昧 exit 53） | 候補の root の ID と表示名、`reason` | root の path［見立て：roles の曖昧は path を出している、`resolve.ts:331`。mem は Agent が読む口なので出さない］ |
| 画面のメモの route のエラー（400・409） | `code`・`field`・`rule`、409 は今の `text`・`version` | 断った原文 |
| 会話の履歴（C の brief として送ったもの） | 保存済みで §6.4 を通った値を、出所・作者・時刻つきのデータの区切りで（D12。区切りの形は C が決める） | 断った値、`withheld` の本文、`frozen` の項目（derived） |
| 画面（G・#2427 の表示） | 保存済みの値（#2427 の表示は今までどおり。mem の表示は §6.4） | 断った値 |
| promote の行き先（E） | 人が差分を承認した値だけ | 未承認の値。A は外へ書かない |

- 断った値は、サーバが受け取った瞬間からどこにも残さない：例外の `message` に原文を入れない（`SessionNoteTooLongError` が上限の数字だけを持つのと同じ、`agent-instances-db.ts:579-584`）。`logger.error` に入力の body を渡さない
- CLI は stdin・引数で受けた原文を、エラーの表示で繰り返さない

---

## 8. 決めること 8：増え方の扱い

### 8.1 open の件数（ブランチごと、kind ごと。読みと同じく全候補 root の ID を合わせて数える）

| kind | 警告（`--json` の `warnings`、exit 0） | 上限（それを超える追加は exit 56 `limit_exceeded`） |
|---|---|---|
| `now` | — | instance ごとに 1 枠（構造で決まる） |
| `waiting` | 10 | 30 |
| `next` | 10 | 30 |
| `external` | 10 | 30 |
| `note` | 20 | 50 |
| `decision` | 20 | **上限なし**（人の決定の記録を件数で断らない。警告だけ） |

［見立て］数字は 20KB 超えの引き継ぎ（Epic の背景）を避けるための初期値。

### 8.2 古さ（F の促しと共有）

- 1 つの関数 `memItemStaleness(item, now)`（`src/lib/mem/staleness.ts`）が `fresh` / `stale` を返し、`list` の `stale` 欄・F の促し・G の表示が同じ関数を使う
- 対象は `open` の項目のうち `close_when` が `manual`（と `now` の `replaced`）のもの。基準は `updated_at` から：`now` 1 日・`next` 7 日・`waiting` 7 日・`external` 14 日・`note` 30 日・`decision`（`open`・`recorded`）14 日で「未反映」
- **古さは警告だけで、削除に使わない**

### 8.3 保持期間と purge

| 記録 | 自動の削除 | 理由 |
|---|---|---|
| `open`・`recorded`・`promoted` の項目 | しない | 人の決定・作業の状態 |
| `closed` の項目（`superseded` 以外） | しない（件数が 500 を超えたら `list` に警告） | 古さだけで消さない |
| `superseded` の `now` | 同じ枠（worktree・instance・世代）ごとに新しい 20 件を残し、古いものは次の `now` の書き込みの同じトランザクションで消す | 1 行の枠の上書きの履歴で、件数で決める（時刻では消さない）。新しい定期の実行を足さない（D8・D13） |
| B の配送の記録（知らせ） | 受領済みは 30 日後、次の書き込みの同じトランザクションで消す。未受領は消さない | 配送の記録は人の決定ではない。具体の表は B が持つ［見立て］ |

`mem purge`：

- `--branch <name>` 必須。repository は呼び出した worktree か `--repository <id>` で決める（§9.2 の 2 通り）。`--closed-only`・`--kind <kind>`・`--before <ISO8601>` で絞る
- `--confirm` が無いと **何も消さず**、消える件数を kind ごとに出して exit 0（`--json` は `{dryRun:true, counts:{…}}`）
- `recorded`・`promoted` の decision は `--include-decisions` が無いと対象にしない
- Agent のセッションの中（`whoami` が成功する）からの purge は CLI が断る（exit 55）。環境変数を消せば通るので、これは検査で保証ではない（§11.3）

---

## 9. 所属の解決

### 9.1 再利用するもの（事実）

- `withSettledWorktreeMembership(db, worktreeId, deps, build)`（`src/lib/agent-roles/resolve.ts:254`）と `withSettledRepositoryMembership`（`:285`）：登録 root の集合 `RoleRepositoryMembership { members, undetermined }` を作る。`members` は path の順（scan の順に依らない、`:96-101`）。git の答えを待つ間に登録が変わったら最大 3 回まで聞き直す（`:227`）。`build` は最後の照合と同じ同期の区間で呼ばれる（`:213`）
- `membershipFrom`（`:163`）：`repository_path` が名指す root、または `--git-common-dir` が一致する root が候補（`candidates`）。候補に有効な root があれば有効なものだけを `members` にする（`:186-188`）。git が失敗した、ディスクにある有効な root は `undetermined`
- 判定の型は role 専用（`resolveDefaultsForTool` は `cliToolId` を取る、`:338`）なので、設定の比較は mem 用に書く

### 9.2 対象の指定（2 通り。同じ関数に入る）

| 指定 | 使う口 | membership | ブランチ | 書き込み |
|---|---|---|---|---|
| worktree から（`whoami` か `--worktree <id>`） | `/api/worktrees/[id]/mem/*`、#2427 のメモの route | worktree の `path`・`repository_path` から | worktree の HEAD を観測（§9.3） | 可（`now`・`add`・`update`・`close`） |
| repository＋ブランチの明示（`--repository <id> --branch <name>`） | `/api/repositories/[id]/mem?branch=<name>`（`GET` の list・mode、`POST …/mem/purge`） | root から（`withSettledRepositoryMembership`） | 指定の名前をそのまま使う（HEAD を見ない）。detached は名指せない | **不可**（list・mode・purge だけ）。worktree が無くなった後の項目を読む・消すための口 |

- どちらも `resolveMemTarget(db, spec)`（`src/lib/mem/target.ts`）に入り、`{ members, candidates, branch | detached, mode, source, storageRepositoryId }` を返す。mode は **指定したブランチ**で決める（第 1 版は worktree 経路しか無く、worktree が消えた後の項目を読む口が無かった。レビュー P1-3）
- 明示の経路で、そのブランチが今どこかの worktree で開いていても、その worktree の mode は使わない

### 9.3 観測の単位（ブランチ・Git の同一性・登録の集合を 1 つの試行に結ぶ）

第 1 版はブランチを membership の前に 1 回だけ取り、membership の聞き直しで取り直さなかった（レビュー P1-2）。第 2 版は `resolve.ts` の `withSettledMembership`（`:227`）を一般化し、**目標ごとの追加の観測**（`observe`）を同じ試行に入れる：

1. 試行の始め：worktree を読み、署名 S0 = `[path, repositoryPath, 登録 root の署名]`
2. git に聞く（すべて `await`）：`observe` = worktree の path で `git symbolic-ref --quiet --short HEAD`（失敗し `git rev-parse --verify HEAD` が通れば detached、どちらも失敗なら不明）と `git rev-parse HEAD`、**`git rev-parse --git-common-dir`（realpath 済み）** → membership の git（`askGit`）→ もう一度 `observe`
3. 同期の区間：worktree を読み直して S1 を作る。`S1 == S0` かつ 2 回の `observe` が一致（ブランチ名・detached・HEAD の SHA・**common-dir**）かつ **`observe` の common-dir が membership の判定に使った worktree の common-dir（`askGit` の `identity`）と一致**しなければ「古い」として 1 へ（最大 3 回、超えたら exit 53 `registration_changed`）。HEAD が同じでも、path の実体が別の Git（別の common-dir）に替わったら、前後の観測か membership との照合のどちらかで違いが出る（2 回目のレビュー 4）
4. 同じ同期の区間で、mode を決め、`build` の中で `db.transaction` の書き込みまで行う（§5.3）。区間の外へ所属を返して後で書く形にしない（返すと `await` を挟む）

- この手順を `mem now`・`add`・`update`・`close` の API と、#2427 のメモの route（mem の判断が要るとき）が共有する。`resolve.ts` の一般化は `withSettledMembership` に任意の `observe` と、その結果を署名に足す口を付けるだけで、role の解決の結果は変えない（role の既存のテストが通ることを陰性の対照にする）
- ブランチが不明（`observe` が失敗）なら exit 52 `branch_unresolved`。`worktrees.branch`（`v36-worktree-branch.ts:29`、sync の時点の写し）は使わない
- 明示の経路（§9.2）は `observe` を持たない（ブランチは入力）

### 9.4 mode の決め方と、断る条件

root ごとに：ブランチの上書き → repository の規則（`position` の順で最初に当たった行。glob は `*` が `/` を含まない、`**` が含む）→ `off`。detached は `match='detached'` の行だけが当たる。`members` の全 root で（mode・機能の切り替え）が一致すればそれが答え。違えば曖昧（`root-settings-differ`）。`undetermined` の root の答えが違えば曖昧（`membership-undetermined`）。どちらも #4114 と同じ規則。

| 状況 | 書き込み | 読み（list・mode） | 評価・C・F |
|---|---|---|---|
| `members` が空（未登録・どの root にも属さない） | exit 52 `not_registered` | exit 52 | off と同じ |
| 同じ common-dir の重複登録、設定が一致 | 通す | 通す | 通す |
| 同じ common-dir の重複登録、設定が違う | exit 53 `ambiguous`（`root-settings-differ`）、候補の root の ID・名前 | exit 53 | off と同じ |
| git が答えない有効な root があり、設定が違う | exit 53（`membership-undetermined`） | exit 53 | off と同じ |
| 観測の間に前提が変わり続ける | exit 53（`registration_changed`） | 同じ | off と同じ |
| ブランチが取れない | exit 52 `branch_unresolved` | 同じ | off と同じ |
| 名前だけ違う repository の同名ブランチ | 別の `repository_id` なので混ざらない | — | — |
| scan の順が変わる | `members` は path の順なので答えは変わらない | — | — |

曖昧の解き方は人が画面で選ぶ：root の設定を揃えるか、片方の root を無効にする（#4114 と同じ、`resolve.ts:17-20`）。

### 9.5 保存先と読む範囲（登録 root の増減）

第 1 版は「保存は `members[0]`、読みは `members`」で、無効にした root の項目が読みから落ち、前に辞書順の root を足すと保存先が変わった（レビュー P2-1）。第 2 版：

- **保存先**：その枠・その項目が既に持っている `repository_id` があればそれ（`update`・`close`・`now` の置き換えは元の行の ID のまま）。新しい項目だけ、書いた時点の `members[0]`（path の順で先頭）
- **読む範囲**：`candidates`（同じ repository と判定された root。無効を含む）の ID の和。membership に `candidates` を足して返す（§9.3 の一般化と一緒に、`membershipFrom` が既に計算している値を捨てずに返す）
- **件数の上限**（§8.1）・**key**（§5.4、世代ごとなので root に依らない）も読む範囲と同じ和で数える
- 行を別の `repository_id` へ **移さない**（黙って移さない。人の選択も要らない）。root を足す・無効にする・scan の順を変える、のどれでも、項目は見え続け、key の再送は同じ ID を返す
- root を **登録から消した**（`deleteRepository`）ときは、その ID は候補に出ないので項目は見えなくなる（§15 U3）

---

## 10. DB の schema（v66）と #2427 のメモとの関係・移行

### 10.1 新しいテーブル（`src/lib/db/migrations/v66-mem-store.ts`）

```sql
-- repository（登録 root）ごとの設定。roles と同じく root ごとに持つ
CREATE TABLE mem_repository_settings (
  repository_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  inject_on_start INTEGER NOT NULL DEFAULT 0 CHECK (inject_on_start IN (0,1)),   -- D が読む
  prompt_on_events INTEGER NOT NULL DEFAULT 0 CHECK (prompt_on_events IN (0,1)), -- F が読む
  popup INTEGER NOT NULL DEFAULT 0 CHECK (popup IN (0,1)),                       -- G が読む
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ブランチ名の規則（先に当たった行）
CREATE TABLE mem_branch_rules (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  match TEXT NOT NULL CHECK (match IN ('glob','detached')),
  pattern TEXT,                                  -- match='glob' のとき必須
  mode TEXT NOT NULL CHECK (mode IN ('off','derived','on')),
  PRIMARY KEY (repository_id, position),
  CHECK ((match = 'glob') = (pattern IS NOT NULL))
);

-- ブランチごとの上書き（機能の切り替えは NULL = 規則・repository に従う）
CREATE TABLE mem_branch_overrides (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  mode TEXT CHECK (mode IN ('off','derived','on')),
  inject_on_start INTEGER, prompt_on_events INTEGER, popup INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, branch)
);

-- instance の世代（ID＋ツールの組の寿命。ID の再利用で前の作業を引き継がないため）
CREATE TABLE mem_instance_incarnations (
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  cli_tool_id TEXT NOT NULL,
  incarnation TEXT NOT NULL UNIQUE,              -- randomUUID
  created_at INTEGER NOT NULL,
  PRIMARY KEY (worktree_id, instance_id)
);

-- worktree の世代（削除と同じ path での作り直しを見分けるため。B の worktree 条件が読む）
CREATE TABLE mem_worktree_incarnations (
  worktree_id TEXT PRIMARY KEY REFERENCES worktrees(id) ON DELETE CASCADE,
  incarnation TEXT NOT NULL UNIQUE,              -- randomUUID
  created_at INTEGER NOT NULL
);

-- 項目（now の open は session_notes。now の closed と他の kind はここ）
CREATE TABLE mem_items (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,                   -- FK なし（§5.2）
  branch TEXT,                                   -- NULL = detached（origin_worktree_id で絞る）
  kind TEXT NOT NULL CHECK (kind IN ('now','waiting','decision','next','external','note')),
  state TEXT NOT NULL CHECK (state IN ('open','recorded','promoted','closed')),
  text TEXT NOT NULL,
  close_when TEXT,                               -- §2.2 の JSON。decision の既定は NULL
  promote_to TEXT, quote TEXT, quote_at INTEGER, evidence TEXT,  -- evidence は JSON 配列
  origin_worktree_id TEXT NOT NULL,              -- worktree_id と名付けない（§10.3）
  origin_worktree_incarnation TEXT NOT NULL,     -- 作成時の worktree の世代
  origin_instance_id TEXT NOT NULL,
  origin_cli_tool_id TEXT NOT NULL,
  origin_incarnation TEXT NOT NULL,              -- 作成時の instance の世代
  origin_session_generation TEXT,                -- 作成時の #4115 の世代。分からなければ NULL
  created_by TEXT NOT NULL CHECK (created_by IN ('agent','human')),
  updated_by TEXT NOT NULL CHECK (updated_by IN ('agent','human','server')),
  updated_by_instance TEXT,
  version INTEGER NOT NULL,
  checked_rules_version INTEGER NOT NULL,        -- §6.4
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT CHECK (close_reason IN ('manual','condition','superseded','slot-removed','withdrawn')),
  close_note TEXT,                               -- close --reason
  idempotency_key TEXT, request_fingerprint TEXT,
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK (kind = 'decision' OR state IN ('open','closed')),
  CHECK ((idempotency_key IS NULL) = (request_fingerprint IS NULL))
);
CREATE UNIQUE INDEX idx_mem_items_key ON mem_items(origin_incarnation, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 枠（session_notes の行）の版の数。行を消しても残す（§10.2、2 回目のレビュー 2）
CREATE TABLE session_note_versions (
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  last_version INTEGER NOT NULL,
  PRIMARY KEY (worktree_id, instance_id)
);
CREATE INDEX idx_mem_items_scope ON mem_items(repository_id, branch, state, kind);
```

- B の終了の記録（照会の結果・成否）と配送の記録は B の migration で足す。ただし **B が後から復元できない作成時の世代**（worktree・instance・セッション）は A が今持つ（レビュー P1-6）。B の「知らせの元の作成者と今の受取先を分ける」は、`origin_incarnation`・`origin_session_generation` を元の作成者とし、受取先は B が今の世代から決める
- 規則の既定：行が無い repository は「規則なし → `off`」。既定の行（`main → on` 等）を自動で入れない（D3）
- `mem_worktree_incarnations` は、mem がその worktree を初めて参照する書き込み（項目の作成・`worktree` 条件の保存）の同じトランザクションで作る。worktree の行が消えれば CASCADE で消え、同じ path の作り直しでは参照されたときに新しい世代が作られる。ID の改名（`renameWorktreeIdPreservingChildren`）では子として付け替わり、世代は続く（改名は削除ではない）

### 10.2 `session_notes` の拡張（D7：`now` の正本）

```sql
ALTER TABLE session_notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE session_notes ADD COLUMN mem_item_id TEXT;              -- now の項目 ID（mem の行の印）
ALTER TABLE session_notes ADD COLUMN mem_repository_id TEXT;
ALTER TABLE session_notes ADD COLUMN mem_branch TEXT;
ALTER TABLE session_notes ADD COLUMN mem_cli_tool_id TEXT;
ALTER TABLE session_notes ADD COLUMN mem_incarnation TEXT;          -- instance の世代
ALTER TABLE session_notes ADD COLUMN mem_worktree_incarnation TEXT; -- worktree の世代
ALTER TABLE session_notes ADD COLUMN mem_session_generation TEXT;   -- #4115 の世代（NULL 可）
ALTER TABLE session_notes ADD COLUMN mem_close_when TEXT;
ALTER TABLE session_notes ADD COLUMN mem_evidence TEXT;
ALTER TABLE session_notes ADD COLUMN mem_checked_rules_version INTEGER;
ALTER TABLE session_notes ADD COLUMN created_by TEXT;               -- 'agent' | 'human'（NULL = v66 より前）
ALTER TABLE session_notes ADD COLUMN updated_by TEXT;
ALTER TABLE session_notes ADD COLUMN created_at INTEGER;
```

- 1 つの行が「#2427 のメモ」でも「`now` の枠」でもある。`mem_item_id IS NOT NULL` の行が mem の `now`。`mem_item_id` を立てるのは、mem の検査（§6）を通った書き込みだけ（T1）
- `version` は行の版。内容の書き換え・`now` の置き換え（新しい `mem_item_id`）・**行の削除**のどれでも `+1`。**枠（worktree・instance）ごとの版の数を `session_note_versions(worktree_id, instance_id, last_version)` に持ち、行を消しても数を残す**。新しく作る行の版は「数＋1」なので、削除して作り直しても前の版の番号は二度と出ない（2 回目のレビュー 2。第 2 版は既定値 1 で作り直すので、版 1 を読んだ古い画面が作り直した行に一致した）。この表は worktree の子（`worktree_id` 列）で、改名に追従し、worktree の削除で消える。画面が読んだ後に CLI が更新・置換すると、画面の版は古くなる
- 退避（superseded・slot-removed・空にする）は、行の世代の列（`mem_incarnation`・`mem_worktree_incarnation`・`mem_session_generation`）を `mem_items` の `origin_*` へそのまま写す。世代を失わない

**画面のメモの読みと書き（PC・スマホ共通）**

- 読み：`SessionNote { text, updatedAt }`（`agent-instances-db.ts:571`）に **足すだけ**で `version: number` と `mem: { itemId, createdBy, … } | null` を加える（`GET /api/worktrees` の `sessionNotes`、`route.ts:112`／`GET …/instances/notes`）。既存の読み手は増えた欄を無視できる（形を消さない・変えない）
- 書き：共有の hook（`TerminalSplitPane.tsx` の `useSessionNote`、`save` は `:274-300`。スマホの `MobileTerminalTabSessionNote.tsx` も同じ hook を import、`:5-10`）が、読んだ行の `version` を `baseVersion` として `PUT` に付ける
- route の判断：

| 行 | `baseVersion` | 動き |
|---|---|---|
| 無い／mem の行でない | 無し（旧クライアント） | 今までどおり上書き（#2427 の互換）。mode が `on` なら §6.3 の検査をかけて mem の `now` にする |
| 無い／mem の行でない | 有り・一致 | 書く |
| 無い／mem の行でない | 有り・不一致 | 409 `version_conflict`、今の `text`・`version` |
| mem の行 | 無し（旧クライアント） | **409 `version_required`**（mem の `now` を黙って上書きしない） |
| mem の行 | 有り・一致 | §6.3 の検査 → mode が `on` なら置き換え（superseded）、それ以外なら同じ ID で更新（T1'） |
| mem の行 | 有り・不一致 | 409 `version_conflict`、今の `text`・`version` |

- hook は **400（検査で断った）と 409（版の競合）のどちらでも**、楽観の表示（`override`）を外して保存済みの値を表示し、**入力中の文字は編集欄に残して**理由（400 は「保存できない文字列が含まれています」、409 は「他で更新されました」）を出す（今は `!response.ok` で `setOverride(null)` するだけ、`TerminalSplitPane.tsx:290-295` 付近）。書いた文字を黙って捨てない。成功したときだけ編集欄を閉じる（2 回目のレビュー 1）
  - PC：`TerminalSplitPane` の `commitNote` は保存の結果を待ち、失敗なら編集欄を開いたまま下書き（`noteDraft`）を残す
  - スマホ：`MobileTerminalTabSessionNote.tsx` は保存の直後に編集欄を閉じる（契約の scope の外で変えない）。そこで共有の hook が失敗のとき、断った下書きと理由を `TerminalSplitPane.tsx` の小さな受け渡し（1 件だけ持つ）に置いてから `SESSION_NOTE_OPEN_EVENT` を出す。スマホの編集欄はこの event で開き直り、`SessionNoteInput`（自分で値を持つ形）は開くときに受け渡しの下書きと理由を受け取る。PC の編集欄（値を親が持つ形）は受け渡しを読まない
- 空にする（行の削除）：mem の行なら、版を照合してから `mem_items` へ `closed`（`manual`、`updated_by='human'`）を写し、行を消す

### 10.3 `worktree_id` という列名を `mem_items` に使わない理由

`getWorktreeChildTables`（`worktree-child-tables.ts:48`）は `worktree_id` という列を持つ表を FK の有無に関係なく「worktree の子」とし（`:24`）、`deleteWorktreeChildRows`（`worktree-id-rename.ts:84`）が worktree の削除で消し、`getDeletableWorktreeChildTables`（`worktree-child-tables.ts:133`）が v52 の掃除で消す。項目は worktree の削除を越えて続く（D4）ので、来歴の列は `origin_worktree_id` にする。代わりに worktree ID の改名（v54/v55）には追従しない：来歴として古い ID が残るだけで、所属の判断（`repository_id`＋ブランチ）には使わない。detached の項目だけは `origin_worktree_id` で絞るので、改名で見えなくなる（§15 U4）

`mem_instance_incarnations`・`mem_worktree_incarnations`・`session_notes` は worktree の子のまま（改名に追従、削除で消える）。

### 10.4 instance の世代を roster のすべての変更経路に結ぶ

世代は「(worktree, instance ID, ツール) の組が roster にある間」。`agent_instances.created_at` は全置換で書き直るので使わない（`agent-instances-db.ts:299`）。行の DELETE/INSERT そのものを世代の終わりの根拠にしない（全置換は物理的に全行を消して入れ直す）。

| 経路 | 世代 | `now`（mem の行） | 同じトランザクション |
|---|---|---|---|
| `addAgentInstance`（`agent-instances-db.ts:311`） | 新しく作る（前の行が残っていれば退避してから作り直す） | — | 挿入と同じ |
| `setAgentInstances`（`:248`）で組が残る（alias の変更・並べ替え） | **維持** | 維持 | — |
| `setAgentInstances` で組が外れる（ID が消える） | 終える（行を消す） | `slot-removed` に退避して行を消す | `leaving` を計算する同じ区間（`:269-275`） |
| `setAgentInstances` で同じ ID・別のツール | 前を終えて新しく作る | 前のツールの `now` を退避して行を消す（#2427 の `pruneSessionNotes` は ID だけなので、mem の行に限ってこの規則を足す） | 同上 |
| `setAgentInstances` で新しい組 | 新しく作る | — | 同上 |
| `removeAgentInstance`（`:346`） | 終える | 退避して行を消す | 既存の DELETE の前 |
| primary の instance（roster の行が無く、`instanceId === cliToolId`） | mem が初めて書くときに作る。ツールが行の `cli_tool_id` と違えば作り直す | — | mem の書き込みと同じ |
| worktree の削除（`deleteWorktreesByIds`・`deleteRepositoryWorktrees`） | CASCADE／`deleteWorktreeChildRows` で消える | **`deleteWorktreeChildRows` の前に** `slot-removed` に退避 | 既存のトランザクション（`worktree-db.ts:956`・`:988` の前） |
| worktree ID の改名 | 子として付け替わり、維持 | 維持 | 既存 |

- **要求を受けた時点（最初の `await` の前）に要求の instance の世代を読んで固定し**、同期の区間の書き込みの直前にもう一度読んで一致を確かめる。違えば（`await` の間に削除→再追加・ツールの変更があった）書かずに exit 52 `instance_not_found`（`reason:'incarnation_changed'`）。受けた時点で世代が無かったとき（派生の primary の最初の書き込み・v66 より前からの行）は、書き込みの直前にも無いときだけ同じトランザクションで作る。追加（`addAgentInstance`）と全置換の新しい組（`setAgentInstances`）は世代を**その場で作る**ので、削除→再追加は必ず別の世代になり、「受けた時点で無い・書く時点で有る」として断れる（2 回目のレビュー 3）。alias の変更・並べ替えでは組の世代を変えないので通る
- 作成者の照合（`update`・`close`）は `origin_incarnation` の一致で行う
- **派生の primary を初めて明示の roster に保存するとき**（`management.ts` の追加の経路は派生の primary を新しい instance と一緒に `setAgentInstances` に渡す）：その ID の世代の行が既にあり、ツールが同じなら**その世代を続ける**（`now`・所有権が残る）。ツールが違えば前を終えて新しく作る。世代の行が無ければ新しく作る（2 回目のレビュー 8）
- mem の行でないメモの prune は今までどおり ID だけ（#2427 を変えない）。同じ ID で別のツールにしたとき mem の行でないメモが残るのは既存の挙動で、この Issue では変えない（§16 の「本文に無い指摘」）

### 10.5 セッションの世代（#4115）の扱い

- #4115 の世代はメモリ上にある（`role-launch.ts:28-33`）。起動の行を実際に作ったときだけ新しい世代になり、既にある process への再接続では変わらない（`:16-17`）
- mem は書き込み時に分かればその世代を `origin_session_generation`・`mem_session_generation` に保存する。サーバの再起動の後は今の世代が分からないので、比較は **一致・不一致・不明** の 3 値（B が使う）。不明を「別の世代」と読まない。再接続では世代が変わらないので別の世代と判定しない
- 主な世代は永続する instance の世代（§10.4）で、セッションの世代は補助

### 10.6 #2427 の 100 code point の上限・prune・表示（Issue の「決めること 4」）

| 論点 | 決定 |
|---|---|
| 上限 | **100 のまま**。`now` は「いまこれをしている」の 1 行（分割の見出しに出る、`TerminalSplitPane.tsx:112`・`:276`）。長い段取りは `next`・`note` に書く |
| prune | §10.4 の表 |
| 画面の表示 | 文字と時刻は変えない。mem の欄（作成者・版・`close_when`）は G（#4227）が出す。409 の表示だけ §10.2 で足す |
| 既存の行の移行 | v66 は既存の行に `version=1` だけを入れ、`mem_*` は NULL（mem の行ではない）。既存のメモを勝手に mem の `now` にしない（mode は既定で off、D3） |

---

## 11. 画面の最小の口と、mode を変える API

### 11.1 置き場所

- 画面：`/repositories`（`src/app/repositories/page.tsx`、PC・スマホ共通のページ。`useIsMobile` で切り替え）の repository の行。roles の設定と同じく、行を開くと出る（`RepositoryList.tsx:731` の `RepositoryRoleDefaults` の隣）。新しいコンポーネント `src/components/mem/RepositoryMemSettings.tsx`：規則の表（glob → mode、detached の行、並べ替え）・ブランチの上書きの一覧・機能の切り替え 3 つ
- API：`GET/PUT /api/repositories/[id]/mem-settings`（規則・機能・`version`）、`PUT/DELETE /api/repositories/[id]/mem-settings/branches`（上書き）。`PUT` は `version` 必須（違えば 409）
- スマホの幅で行が開けるかは未確認（§15 U1）

### 11.2 「画面の経路だけ」の作り

1. **CLI に口を作らない**：`commandmate mem` に mode を変えるサブコマンドもオプションも無い。ガードのテスト（`tests/unit/guards/mem-mode-write-screen-only.test.ts`）で、`src/cli/**` が `mem-settings` の書き込み（`put(`・`delete(` と `mem-settings` の組）と、画面の印のヘッダ名 `X-CommandMate-Client` を持たないことを固定する
2. **サーバの印**：書き込みの route（`PUT`・`DELETE`）は、次の **両方** を満たさない要求を 403 `screen_only` で断る。判定は新しい `src/lib/security/screen-request.ts` の 1 関数
   - `X-CommandMate-Client: screen` がある。画面の API 呼び出し（`RepositoryMemSettings` が使う client）だけが付ける。独自ヘッダなので、別 origin のページからの要求は CORS の preflight を通らない（`src/middleware.ts`・`next.config.*` に CORS の許可は無い［事実：grep 0 件。route ごとは §15 U6］）
   - `Origin` があり、その scheme＋host＋port が要求の宛先と一致する。**宛先の host＋port は `X-Forwarded-Host` があればその最初の値、無ければ `Host`。scheme は `X-Forwarded-Proto` があればその最初の値、無ければサーバが受けた接続の scheme（`request.nextUrl.protocol`）**。Tunnel（`remote`）は外側が HTTPS・上流が HTTP（`src/lib/remote/tailscale.ts` の serve は `http://127.0.0.1:<port>` へ転送）なので、転送のヘッダが無いと scheme が合わない。転送のヘッダを信じても弱くならない理由：別 origin のブラウザのページは独自ヘッダ（`X-CommandMate-Client`）を付けた時点で preflight で止まり、同じ OS のプロセスはそもそも全部を偽れる（§11.3）。実際の Tunnel がこれらのヘッダを付けるかは未確認（§15 U2 で実測）（2 回目のレビュー 7）。ブラウザは同一 origin の `PUT`・`DELETE` の `fetch` に `Origin` を付ける（HTTP の LAN・localhost・HTTPS のどれでも）。Node の `fetch`（CLI）は付けない［見立て。ブラウザでの実測は未確認、§15 U2］
   - `Sec-Fetch-Site` は見ない（LAN の HTTP で付かない）。`Authorization: Bearer` の有無も見ない（token の設定次第で付かない、`api-client.ts:200-202`）。ただし `Sec-Fetch-Site` が付いていて `same-origin` 以外なら断る（付く環境での追加の検査）
3. 読み（`GET`）は CLI からも可（`mem mode` が使う）

| 入口 | 期待 |
|---|---|
| PC の localhost（`http://localhost:3000`） | 受ける |
| スマホの LAN の HTTP（`http://<PCのIP>:3000`） | 受ける |
| HTTPS（`--https`・`remote` の Tunnel） | 受ける |
| 別 origin のページからの `fetch` | 断る（preflight で止まる／`Origin` 不一致） |
| 正規の CLI（`ApiClient`、Bearer の有無に依らない） | 断る（印が無い） |
| `curl` でヘッダを偽った同じ OS のプロセス | **受けてしまう**（§11.3） |

### 11.3 防げないこと（検査の限界）

- 同じ OS 権限のプロセス（Agent を含む）は、`curl` で `X-CommandMate-Client` と `Origin` を偽れば 2 の印を通れる。DB ファイル（`CM_DB_PATH`）を直接書き換えることもできる。CommandMate はこれを **防がない・検出しない**
- 防いでいるのは「CLI の正規の口から変えられる」こと、「CLI の利用者が気づかずに変える」こと、「別 origin のページが利用者のブラウザ越しに変える」ことだけ。Agent に mode を変えさせないのは、口が無いことと skill（#4228）の指示であって、技術的な保証ではない
- 同じく、instance の名乗り（`--instance`）も偽れる（`ask`・`send` と同じ）。作成者の検査は「別のセッションの項目を誤って書き換えない」ためのもので、悪意の書き換えを防ぐものではない
- この節を `docs/user-guide/`（ja・en）の mem の節に写す（実装の契約）

---

## 12. CLI の `--json` と exit code

### 12.1 exit code（新しい `MemExitCode`、`src/cli/types/index.ts`）

| code | 名前 | `code`（`--json`） | 意味 |
|---|---|---|---|
| 0 | SUCCESS | — | 成功（`--key` の再送で既存を返したときも、`replayed:true`） |
| 1 | DEPENDENCY_ERROR（既存） | `no_response` | サーバに届かない |
| 2 | CONFIG_ERROR（既存） | `invalid_request` / `invalid_close_when` / `control_char` / `secret_like` / `too_long` / `absolute_path` / `outside_repository` / `symlink` / `sensitive_path` / `invalid_evidence` / `invalid_key` / `target_required` | 入力の不正。何も保存していない |
| 50 | DISABLED | `disabled` | mode が `off`・`derived`。何も保存していない。`mode` と決めた規則を返す |
| 51 | CONFLICT | `version_conflict` | `--if-version` が今の版と違う。何も保存していない。`currentVersion` と今の項目を返す |
| 52 | TARGET_NOT_FOUND | `not_registered` / `item_not_found` / `instance_not_found` / `branch_unresolved` | 対象不明 |
| 53 | AMBIGUOUS | `ambiguous`（`reason`: `root-settings-differ` / `membership-undetermined` / `registration_changed`） | 所属が曖昧。候補の root の ID・名前を返す（path は出さない） |
| 54 | DUPLICATE | `duplicate_key` | 同じ範囲・同じ `--key` で中身が違う。既存の項目の ID を返す |
| 55 | NOT_OWNER | `not_owner` / `state_forbids` | 作成者でない instance（別の世代を含む）、または状態が許さない（`recorded` の decision の close、セッションの中の purge） |
| 56 | LIMIT | `limit_exceeded` | §8.1 の上限 |
| 99 | UNEXPECTED_ERROR（既存） | `internal_error` | 予期しない失敗 |

50〜56 にしたのは、30〜32・40〜41 を使うループが同じ `$?` を読むため（`RoleExitCode` のコメントと同じ理由、`src/cli/types/index.ts:666-673`）。

### 12.2 `--json` の形

```jsonc
// 成功（add / update / close / now）
{ "ok": true, "item": { /* §12.3 */ }, "replayed": false, "warnings": [] }
// 失敗（版の競合）
{ "ok": false, "code": "version_conflict", "message": "…", "exitCode": 51,
  "currentVersion": 4, "item": { /* 今保存されている項目。§7 */ } }
// 失敗（入力の不正）
{ "ok": false, "code": "secret_like", "field": "text", "rule": "github-token", "exitCode": 2 }
// mem mode
{ "ok": true, "mode": "on", "source": { "level": "override" | "rule" | "fallback",
  "repositoryId": "…", "branch": "main", "rulePosition": 0, "pattern": "main" },
  "target": { "via": "worktree" | "repository", "worktreeId": "…" | null },
  "features": { "injectOnStart": false, "promptOnEvents": false, "popup": false },
  "repositoryIds": ["…"] }
// mem list
{ "ok": true, "mode": "on", "branch": "main", "items": [ … ], "now": [ { "instanceId": "claude-2", "item": { … } } ],
  "warnings": [ { "code": "open_count", "kind": "next", "count": 11, "threshold": 10 } ] }
```

### 12.3 項目の形（`--json` と API で共通）

`id`・`kind`・`state`・`text`（§6.4 で止めたときは withheld の形。自由入力の欄の鍵はすべて無い）・`closeWhen`（§2.2 の JSON）・`promoteTo`・`quote`・`quoteAt`（ISO8601 UTC）・`evidence`（配列）・`owner { repositoryId, branch, worktreeId, worktreeIncarnation, instanceId, cliToolId, incarnation, sessionGeneration }`・`createdBy`・`updatedBy`・`version`・`createdAt`・`updatedAt`・`closedAt`・`closeReason`・`stale`（§8.2）・`frozen`（derived）。`now` も同じ形（`session_notes` の `mem_*` 列から組み立てる。`sessionGeneration` は `mem_session_generation`）

### 12.4 対象の決め方

- 既定は `whoami` で決まる自分（`resolveSessionIdentity`、`src/cli/commands/whoami.ts:195`）。worktree の経路（§9.2）
- `whoami` が exit 3（`NOT_IN_SESSION`、`whoami.ts:58`）の通常のシェルでは、書き込みに `--worktree <id> --instance <id>` を必須にする（無ければ exit 2 `target_required`）。`list`・`mode`・`purge` は `--worktree <id>`、または `--repository <id> --branch <name>`（repository の経路、§9.2）
- 人の通常のシェルから `--instance` を指定した書き込みは、その instance として書く（人としては書かない。人の経路は画面だけ）［見立て］

---

## 13. 実装の範囲と対照のテスト

### 13.1 新規ファイル

| ファイル | 中身 |
|---|---|
| `src/lib/db/migrations/v66-mem-store.ts` | §10.1・§10.2 |
| `src/lib/db/mem-db.ts` | 項目・設定・世代の CRUD（トランザクション、版、key、退避） |
| `src/lib/mem/target.ts` | `resolveMemTarget`（§9.2〜§9.5）、glob の照合 |
| `src/lib/mem/close-when.ts` | §2 の文法・正規化・保存の形・§2.3 の許可表 |
| `src/lib/mem/validate.ts` | §6 の `validateMemFields`・`path:` の正規化 |
| `src/lib/mem/secret-scan.ts` | §6 の規則（ID つき、版つき） |
| `src/lib/mem/staleness.ts` | §8.2 |
| `src/lib/mem/transitions.ts` | §3 の表（関数として） |
| `src/lib/mem/incarnation.ts` | §10.4・§10.1 の世代の発行・照合、`worktreeIncarnationAlive` |
| `src/lib/mem/present.ts` | §6.4 の出口の読み直しと withheld の形（全出口で共有） |
| `src/lib/mem/git-observe.ts` | §9.3 の `observe`（HEAD・common-dir）と、`close_when` の補い（origin・tip）の git |
| `src/lib/security/screen-request.ts` | §11.2 の印 |
| `src/app/api/worktrees/[id]/mem/route.ts` ほか（`items`・`items/[itemId]`・`now`・`mode`） | worktree の経路の API |
| `src/app/api/repositories/[id]/mem/route.ts`・`…/mem/purge/route.ts` | repository の経路の API（list・mode・purge） |
| `src/app/api/repositories/[id]/mem-settings/route.ts`・`…/branches/route.ts` | §11.1（画面だけ） |
| `src/cli/commands/mem.ts` | `now`・`add`・`update`・`close`・`list`・`mode`・`purge` |
| `src/components/mem/RepositoryMemSettings.tsx` | §11.1 |
| `src/types/mem.ts` | 項目・mode・API の型 |
| `tests/fixtures/mem/close-when-v1.json` | §2.2 の保存値と §2.3 の許可表（B と共有） |
| `tests/unit/...`（下の表） | — |

### 13.2 変更する既存ファイル

| ファイル | 変更 |
|---|---|
| `src/lib/db/migrations/runner.ts` | `CURRENT_SCHEMA_VERSION = 66`、`v66_migrations` |
| `src/lib/agent-roles/resolve.ts` | `withSettledMembership` に任意の `observe` と署名への追加を足す。membership に `candidates` を足して返す（§9.3・§9.5）。role の結果は変えない |
| `src/lib/db/agent-instances-db.ts` | §10.4 の世代と退避（`addAgentInstance`・`setAgentInstances`・`removeAgentInstance`）、`setSessionNote` の版・mem の行の判断、`SessionNote` に `version`・`mem` を足す |
| `src/lib/db/worktree-db.ts` | `deleteWorktreesByIds`・`deleteRepositoryWorktrees` で `deleteWorktreeChildRows` の前に退避 |
| `src/app/api/worktrees/[id]/instances/notes/route.ts` | §6.3・§10.2 の表（検査・`baseVersion`・409） |
| `src/app/api/worktrees/route.ts` | `sessionNotes` に足した欄が載ること（形は足すだけ） |
| `src/components/worktree/TerminalSplitPane.tsx` | `useSessionNote` が `baseVersion` を送り、409 で入力を残す（PC・スマホ共通の 1 か所） |
| `src/cli/types/index.ts` | `MemExitCode` |
| `src/cli/program.ts` | `mem` の登録 |
| `src/components/repository/RepositoryList.tsx` | §11.1 の開く行 |
| `locales/ja/common.json`・`locales/en/common.json` | 画面の文言（roles の設定の文言と同じ `common` に置く見立て。409 の文言を含む） |
| `docs/user-guide/cli-operations-guide.md`（ja・en） | `mem` の節・全終了コード一覧（§12.1）・§11.3 の限界 |
| `docs/module-reference.md` | 断片で（実装の契約） |
| `scripts/check-route-exports.mjs` の対象 | 新しい route が許された export だけを持つ（既存のガード `tests/unit/guards/route-export-allowlist.test.ts` が見る） |

### 13.3 受入基準と対照のテスト

DB を使うテストは `os.tmpdir()` の `mkdtempSync` の中の DB で、`afterEach` で消す。git は `RoleResolverDeps` の `resolveCommonDir`・`pathExists` と、§9.3 の `observe` を差し替える（`resolve.ts:87-94`）。

**受入基準の項目**

| 受入基準 | 陽性（直す前の実装で落ちる・断るべきを断る） | 陰性（変わらない・通すべきを通す） |
|---|---|---|
| 初期は `off`、`off`/`derived` で書き込みを断り何も保存しない | 規則なしの repository で `now`/`add`/`update`/`close` が 50、行数 0。`derived` の規則でも 50 | `on` の規則で 0、行が 1 |
| CLI から mode を変える口が無い | ガード：`src/cli/**` に `mem-settings` の書き込みと `X-CommandMate-Client` が無い | — |
| 規則の優先順位 | 上書き（`feat/x → off`）が規則（`feat/* → on`）に勝つ、先の行が勝つ、detached は `detached` 行だけ、規則なし → off | glob が当たらないブランチは次の行へ、`*` は `/` を跨がない |
| 2 つの instance が同時に `now` | A・B が交互に `now`、互いの行が残る。**A の所属の観測の `await` の間に B の `now` を最後まで進め、その後 A を完了させても B の行が残る** | 同じ instance の 2 回目は上書きで 1 行＋`superseded` 1 件 |
| 版の競合 | 古い `--if-version` で 51、内容は前のまま、応答に今の内容 | 正しい版で 0、`version+1` |
| 作成者でない instance | 別 instance の `update`/`close` が 55、同じ ID の新しい世代も 55 | 作成者で 0、画面（人）で 0 |
| `--key` | 同じ key・同じ中身の 2 回で 1 件・2 回目 `replayed` | §R4 |
| 混ざらない・世代 | 別 repository の同名ブランチの項目が出ない、instance を消して作り直すと前の `now` が出ない（`slot-removed` になる） | 同じブランチの別 worktree から前の項目が見える |
| `on → off → on`・purge | off の間の roster の削除で `now` が `slot-removed` で残る、`--confirm` 無しの purge で行数が変わらない | `--confirm` で消える、`--include-decisions` 無しで `recorded` は残る |
| 自由入力の欄 | 各欄で上限＋1・秘密の各規則・C1/双方向の制御・（構造化した欄の）絶対パス・`..`・symlink・`.env` を断る | 上限ちょうど・LF/TAB（`now` 以外）・似ているが秘密でない文字列（`token` という語だけ、短い値）・自由文の `/tmp/mem-example` を通す |
| 再起動の後の保持 | DB を閉じて開き直した後に項目・版・世代の列が同じ | — |
| 所属の解決 | 同じ common-dir の 2 root で設定が違う → 53、git が答えない有効な root の設定が違う → 53、未登録 → 52 | 2 root で設定が一致 → 通る、scan の順（`repository_path`）を入れ替えても同じ答え、名前だけ違う repository は別 |
| `close_when` | 未知の型・オフセットの無い `at`・origin の無い `#N`・§2.3 で × の組を断る | §2.2 の各型の保存値の fixture を A が書いて読める（T-COND：B が同じ fixture を使う） |
| mode の遷移 | `on` で作成 → `off`：list 50・check 50・brief に出ない・G の編集 409 → `derived`：list は `frozen`・書き込み 50 → `on`：書き込み 0 | 各時点で項目の行と版が変わらない（許された更新だけ） |
| 断った値が出ない | 秘密・構造化した欄の絶対パスで断ったとき、応答の JSON・CLI の stderr・ロガーのモックの呼び出しに原文の部分文字列が無い | 断った理由の `code`・`field`・`rule` は出る |
| #2427 を壊さない | — | `off` で mem の行でないメモの `PUT`（`baseVersion` 無し）・`GET` が v65 と同じ動き、100 の上限、空で削除、alias の変更で残る。既存のテスト `tests/unit/lib/db/session-notes-2427.test.ts`・`tests/unit/app/api/worktrees/session-notes-2427.test.ts` は旧の形（`{text, updatedAt}`）への完全一致を見ているので、**足した欄（`version`・`mem`）を受け入れる形に期待を直す**（`text`・`updatedAt`・正規化・削除の保証は弱めない。2 回目のレビュー 9）。`GET` の応答は足した欄以外が同じ |
| 原子性 | 退避（superseded）の後の書き込みを失敗させると、退避の行も枠の行も前のまま（トランザクションが全部戻る） | 失敗しなければ両方が書かれる |

**事前レビューの指摘ごと（§16 の R 番号）**

| R | 守る条件 | 陽性 | 陰性 |
|---|---|---|---|
| R1（T1） | mem の行は、どの経路・mode でも mem の検査済みの値しか持たない。出口は今の規則で読み直す | `on` で `now` 作成 → `off` → 画面のメモの `PUT` で模擬の秘密（`ghp_` ＋ 36 文字）→ 400、行は前の値のまま → `on` → list・`--json`・brief に模擬の秘密が出ない。規則の版を上げて既存の行に当たる規則を足すと、list で `withheld` になる | mem の行でないメモは `off` で今までどおり編集・表示できる（秘密らしい文字列も #2427 の検査だけで保存される＝既存の挙動のまま） |
| R2 | ブランチ・Git の同一性・登録の集合を 1 つの試行に結び、同じ同期の区間で書く | 1 回目の `observe` の後、membership の完了前に worktree の path／HEAD（ブランチ名）を変える → 古い組で保存されない（聞き直して新しい組で書くか、3 回で 53）。#2427 のメモの route でも同じ | 何も変わらなければ 1 回で同じ所属に書く。role の解決（`resolve.ts` の既存のテスト）が同じ結果 |
| R3 | worktree 由来と repository＋ブランチの明示が同じ判定に入り、指定したブランチの mode を使う | worktree の今のブランチが `on` でも、`--repository --branch <offのブランチ>` の list は 50 で項目を返さない | worktree を消した後、`--repository --branch <onのブランチ>` で保持された項目を読める・purge できる |
| R4 | key は instance の世代ごと。要求の同一性は §5.4 の全欄 | 同じ key で、ブランチだけ・作者（別 instance／別の世代）だけ・`quoteAt` だけを変える → 元の項目の再送扱いにならない（同じ世代なら 54、別の世代なら別の項目） | 同じ世代・同じ正規化済みの要求なら同じ ID（`replayed:true`）。root の追加の後でも同じ ID |
| R5 | 世代は (worktree, ID, ツール) の組。追加・全置換・単体削除で退避と世代を同じトランザクションで | 削除→再追加、同じ ID でツールの変更、のどちらでも旧 `now`（mem の行）と旧所有権を継ぎない（新しい世代の `update` が 55、`now` が空） | alias の変更・並べ替えで `now`・世代が残る。`created_at` が変わっても世代は変わらない |
| R6 | 作成時の worktree・instance・セッションの世代を永続化し、退避でも失わない | worktree を削除 → 同じ path で作り直し → `worktree` 条件の保存値の世代と今の世代が違う（B の fixture で「成立」）。`now` 作成 → 再起動 → 退避 → `mem_items` の `origin_*` が作成時の値 | 再接続（起動の行を作らない）では `sessionGeneration` が変わらない。改名では worktree の世代が続く |
| R7 | mem の `now` を書く画面の経路は版を照合する。旧クライアントは mem の行を黙って上書きしない | 画面が読んだ（版 n）後に CLI が更新／置換 → 画面の保存（`baseVersion` = n）が 409、CLI の値が残り、編集欄に入力が残る。mem の行に `baseVersion` 無しの `PUT` が 409 `version_required` | mem の行でないメモは `baseVersion` 無しで今までどおり上書きできる |
| R8（T3） | 画面の印は独自ヘッダ＋`Origin` の一致。LAN の HTTP・localhost・HTTPS の画面を受け、別 origin と正規の CLI を断る | `Origin` が別のホスト → 403。印のヘッダ無し（Bearer あり・無しの両方）→ 403。`Sec-Fetch-Site: cross-site` → 403 | `Origin: http://192.168.1.10:3000`・`Host: 192.168.1.10:3000`・印つき・`Sec-Fetch-Site` 無し → 200。localhost・HTTPS も 200。`GET` は印無しでも 200 |
| R9 | root の増減で項目を移さず、読みと件数と key は全候補 root の和 | 同じ common-dir に path の順で前の root を足す → 前の項目が見え、key の再送が同じ ID、件数の上限が合算。前の先頭の root を無効にする → 項目が見える | scan の順だけを変えても所属・保存先が同じ |
| R10 | kind × 型の許可表は一意で、A と B が同じ fixture を使う | `waiting`・`next` の `replaced` を断る。表の × の組をすべて断る | `now` の省略は `replaced`、`note` は `manual`、`decision` は `promoted`（列 NULL）。表の ○ の組をすべて通す |
| R11 | 絶対パスを断る欄は構造化した欄だけ。競合で返すのは保存済みの値 | `evidence: path:/etc/passwd` が断られ、原文が API のエラー・`--json`・CLI の stderr・ログに出ない | 自由文の `text="/tmp/mem-example"` は保存され `--json` に出る。版の競合の応答に今の項目が出る |

**2 回目の事前レビューの指摘ごと（§16 の 2 回目の表の番号）**

| # | 守る条件 | 陽性 | 陰性 |
|---|---|---|---|
| 1 | 400 になる条件は §6.3 の表だけ。400・409 でも PC・スマホの入力が残る | `on` で mem の行でないメモに模擬の秘密 → 400。PC の編集欄が開いたまま下書きが残る、スマホの編集欄が開き直り下書きが残る | 通常の文で 200 → PC・スマホとも編集欄が閉じる。`off` の mem の行でないメモは秘密らしい文字列でも今までどおり 200 |
| 2 | 削除を越えて版の番号が単調 | 版 n を読む → 空にして削除 → 作り直し → 古い画面の `baseVersion=n` が 409 | 今の版で 200 |
| 3 | 受けた時点の世代を固定し、書く直前に照合 | 所属の観測の `await` の間に instance を削除→再追加 → `now`/`add` が 52（`incarnation_changed`）、何も書かない | `await` の間に alias の変更・並べ替え → 通る |
| 4 | common-dir を前後の観測と membership に結ぶ | HEAD（ブランチ名・SHA）は同じで、2 回目の観測の common-dir だけ違う → 古い組で書かない（3 回で 53） | 同じ Git なら 1 回で書く |
| 5 | worktree 条件は世代の存続で決める | 削除→同じ path で作り直し → 保存した世代が存続しない（fixture の `met`） | 改名 → 世代が存続（fixture の `not-met`） |
| 6 | withheld の形は 1 つで全出口が共有 | `quote`・`evidence` だけに新しい規則が当たる → list・`--json`・競合の応答に `quote`・`evidence`・`text` の鍵が無い | 当たらない項目は全欄が出る |
| 7 | 宛先の scheme は転送のヘッダ → 接続の scheme | `X-Forwarded-Proto: https`・`Origin: http://…` → 403 | `X-Forwarded-Proto: https`・`X-Forwarded-Host: x.ts.net`・`Origin: https://x.ts.net` → 200 |
| 8 | 派生の primary を明示の roster に保存しても世代が続く | 同じ ID でツールを変えて保存 → 前の `now` は退避 | primary が `now` を書く → 別の Agent を追加（派生の primary と一緒に保存）→ primary の `now`・所有権が残る |
| 9 | 既存の #2427 のテストは足した欄を受け入れる | — | `text`・`updatedAt`・正規化・削除の期待はそのまま |


---

## 14. 対になる場所（探した結果）

| 探した対象 | 結果 |
|---|---|
| 画面のメモの PC とスマホ | PC は `TerminalSplitPane.tsx`、スマホは `MobileTerminalTabSessionNote.tsx`（`SessionNoteInput`・`useSessionNote` を `TerminalSplitPane` から import、`MobileTerminalTabSessionNote.tsx:5-10`）。route を呼ぶのは `TerminalSplitPane.tsx:284` の 1 か所［事実］。§10.2 の `baseVersion`・409 の変更はこの 1 か所で両方に効く |
| メモの読み手 | `GET /api/worktrees`（`route.ts:112`）と `GET …/instances/notes`。形は足すだけ |
| 型の写し `src/cli/types/` | `api-responses.ts` に `sessionNotes`・`SessionNote` の語は無い［事実：grep 0 件］。CLI はメモを読まないので写しは無い。`mem` の型は `src/cli/types/` に新しく置く |
| roster の変更経路 | `addAgentInstance`・`setAgentInstances`・`removeAgentInstance` の 3 つ（`agent-instances-db.ts:311`・`:248`・`:346`）。§10.4 で全部に世代を結ぶ |
| worktree の寿命の経路 | 削除 2 つ（`worktree-db.ts:943`・`:978`）と改名（`worktree-id-rename.ts:128`）。§10.4 |
| ja / en の説明 | `docs/user-guide/cli-operations-guide.md` は ja。en の対は `docs/en/` 側［未確認：ファイル名］ |
| 設計書を固定するテスト | `tests/unit/docs/design-doc-identifier-audit.test.ts` は `docs/design/multi-agent-state-architecture.md` だけを見る。この文書は対象外［事実］ |

---

## 15. 未確認・未決（レビューで見てほしい点）

| # | 内容 |
|---|---|
| U1 | `RepositoryList` の開く行（roles）がスマホの幅で開けるか。D3 は PC・スマホの両方を求める |
| U2 | §11.2 の印を、実際のブラウザ（スマホの Safari・Chrome の LAN の HTTP、PWA、`remote` の Tunnel 越し）で実測していない。とくに Tunnel 越しの `Host` と `Origin` が一致するか（転送のヘッダの扱い）。実装の契約で 1 回ずつ測る |
| U3 | repository の登録を消して付け直すと新しい ID（`randomUUID`、`db-repository.ts:193`）になり、前の項目が見えなくなる。common-dir での引き継ぎを足すか、purge だけを用意するか |
| U4 | detached の項目は `origin_worktree_id` で絞るので、worktree ID の改名（v54/v55）で見えなくなる。detached を書き込み禁止にする案もある |
| U5 | §8.1 の件数・§8.2 の日数・§6 の上限は初期値の見立て。実運用の引き継ぎ（Epic の背景の 20KB）から逆算していない |
| U6 | §11.2 の preflight の前提：`src/middleware.ts` と `next.config.*` に `Access-Control-Allow` の語は無い［事実：grep 0 件］。route ごとの CORS の応答や、Next の既定の振る舞いは実測していない |

---

## 16. 事前レビューの処置

Codex の事前レビュー（2026-11-08、P1 8 件・P2 3 件、ほかに試験の追加 1 件）。守る条件と対照は §13.3 の R 番号の行。

| R | 指摘 | 処置 | 1 行の要約 |
|---|---|---|---|
| R1 | P1：T1 で未検査の値が mem の正本に入り、再開後に出力される | 採る | 検査を「行」に結び、mem の行は全経路・全 mode で mem の検査を通す。出口は規則の版で読み直す（T1・§6.3・§6.4） |
| R2 | P1：ブランチ取得と所属解決が同じ観測単位になっていない | 採る | HEAD の観測を membership の試行の前後に入れて署名に含め、同じ同期の区間で書く（§9.3） |
| R3 | P1：worktree なしで指定する CLI 経路に解決関数・API が無い | 採る | repository＋ブランチの経路を同じ `resolveMemTarget` に入れ、読み・purge だけの API を足す（§9.2） |
| R4 | P1：`--key` の指紋が別の要求を同一と判定する | 採る | key の範囲を instance の世代にし、指紋に所属・作者・`quote_at` を含む全欄を入れる（§5.4） |
| R5 | P1：incarnation を roster の全変更経路に結ぶ規則が足りない | 採る | 世代を (worktree, ID, ツール) の組に結び、3 つの roster 経路と worktree の削除の表にした（§10.4） |
| R6 | P1：B が必要とする世代情報を A の保存形が保持できない | 採る | worktree の世代の表を足し、`worktree` 条件・項目・`now` の行に作成時の世代を持たせ、退避で写す（§10.1・§10.2・§10.5） |
| R7 | P1：画面のメモ経路が版つき更新の対象から抜ける | 採る | 読みに `version` を足し、共有 hook が `baseVersion` を送る。mem の行への版の無い書き込みは 409（§10.2） |
| R8 | P1：T3 の必須ヘッダがスマホの LAN 接続を拒否する | 採る | `Sec-Fetch-Site` 必須をやめ、独自ヘッダ＋`Origin` の一致にした。Bearer の有無も見ない（T3・§11.2）。ブラウザの実測は §15 U2 |
| R9 | P2：登録 root の増減で保存先と参照範囲が変わる | 採る | 行を移さず、既存の行は元の ID のまま、読み・件数・key は全候補 root（無効を含む）の和（§9.5） |
| R10 | P2：kind ごとの条件表が `replaced` 専用規則と食い違う | 採る | kind × 型の許可表を 1 つにし、fixture で B と共有（§2.3） |
| R11 | P2：出口の表が検査規則と応答形を覆っていない | 一部採る | 絶対パスを断る欄を構造化した欄に限ると明記し、競合で返す保存値を §7 に足した。自由文の絶対パスは断らない（作業の記録に要る。§6.1） |
| R12 | 追加：「交互に now」だけでは原子性を確かめられない | 採る | `await` の間に別の要求を進める試験と、退避の後の失敗で全部戻る試験を §13.3 に足した |

本文に無い指摘（この Issue では直さない）：`src/lib/db/agent-instances-db.ts:287` — `pruneSessionNotes` は ID だけで残すので、同じ instance ID で別のツールに変えたとき、前のツールのセッションに書いた #2427 のメモが新しいツールのセッションに残る（#4132 の creation key は組で外す、`:269-275`。roles の `pruneAgentInstanceRoles` は `:290` で ID だけ）。mem の行は §10.4 で退避するが、mem の行でないメモは既存の挙動のまま。

### 2 回目の事前レビュー（Codex、2026-11-08、P1 6 件・P2 3 件。`workspace/orchestration/runs/2026-11-08/prereview/review-4221b.md`）

1 回目の R1〜R12 の判定は「解消 7 件・一部解消 5 件」。残りの指摘の処置（守る条件と対照は §13.3 の 2 回目の表）：

| # | 指摘 | 処置 | 1 行の理由 |
|---|---|---|---|
| 1 | P1：400 の条件が T1 と §6.3 で食い違う。画面は 409 しか直さず、保存を待たずに閉じる | 採る | 400 の対象を §6.3 に揃え（T1 を直した）、400・409 で入力と理由を残す契約を PC・スマホに足した（§10.2）。スマホの部品は scope の外なので共有の hook と編集欄の側で開き直す |
| 2 | P1：削除→再作成で古い版が一致しうる | 採る | 枠ごとの版の数を行の外（`session_note_versions`）に持ち、削除を越えて単調にした（§10.1・§10.2） |
| 3 | P1：`await` 中に世代が替わった要求が新しい世代で保存される | 採る | 受けた時点の世代を固定し、書く直前に照合する。追加・全置換で世代をその場で作る（§10.4） |
| 4 | P1：HEAD の一致だけでは Git の同一性を確かめられない | 採る | `observe` に common-dir を入れ、前後の一致と membership の `identity` との一致を求めた（§9.3） |
| 5 | P1：worktree の改名を「削除された」と判定する | 採る | 条件の成立を ID の行ではなく保存した世代の存続で決め、改名・削除の両方を fixture に入れた（§2.1） |
| 6 | P1：withheld で隠す欄が出口と項目の型で違う | 採る | withheld の形を 1 つの関数で定義し、自由入力の欄の鍵をすべて出さない（§6.4・§12.3） |
| 7 | P2・質問：T3 の宛先の scheme の決め方が無い | 採る | `X-Forwarded-Host`／`X-Forwarded-Proto` → `Host`／接続の scheme の順に決めた。実際の Tunnel での実測は U2 のまま（§11.2） |
| 8 | P2・質問：派生の primary を明示の roster に保存するときの世代 | 採る | 同じ ID・同じツールの世代の行があれば続ける規則を足した（§10.4） |
| 9 | P2：既存のテストが「そのまま通る」は成立しない | 採る | 足した欄を受け入れる期待に直すことを変更範囲に入れ、text・updatedAt・正規化・削除の保証は弱めない（§13.3） |


### 実装で変えた点（実装の契約、2026-11-08）

D1〜D13 と違う作りは無い。設計の文面から外れた・細かく決めた点：

| # | 箇所 | 実装 | 理由 |
|---|---|---|---|
| I1 | §5.4 の指紋 | `close_when` は保存の JSON ではなく**入力の文字列**で指紋に入れる。repository は指紋に入れず、「既にある項目の `repository_id` が今の読む範囲（全候補 root）に入っているか」で別に照合する | 保存の JSON は保存先の root（`branch` 型の `repositoryId`）と作成時の tip を含むので、前に root を足す・ブランチが進むだけで指紋が変わり、R9 の「root の追加の後でも同じ ID」を満たせない |
| I2 | §10.5 | `origin_session_generation`・`mem_session_generation` は常に `NULL` を保存する | #4115 の世代を worktree・instance から読む口が lib に無い（`role-launch` はメモリの中）。§10.5 の「分からなければ NULL」の範囲 |
| I3 | §8.3 の purge | `mem_items` だけを消す。open の `now`（#2427 のメモの行）は対象にしない | `now` の行は画面のメモでもあり、空にするのは画面の操作（§3.1）。purge の確認の件数にも出さない |
| I4 | §10.2 の PC | PC の編集欄は保存を待たずに今までどおり閉じ、400・409・その他の失敗で**下書きと理由つきで開き直す**（スマホと同じ動き） | 既存のテスト（Enter で閉じる）を変えずに「入力を残す」を満たす。下書きは分割ごとの `noteDraft` に残る |
| I5 | §11.1 | ブランチの上書きの書き込み・削除も repository の設定の `version`（1 つ）を照合して上げる | 画面が読んだ設定の全体（規則＋上書き）を 1 つの版で守る |
| I6 | §10.4 | 受けた時点で世代が無く、書く直前に**同じツールの世代がある**ときも断る（52 `incarnation_changed`） | 削除→再追加（追加で世代をその場で作る）と、同じ派生の primary の同時の初回書き込みを区別できない。後者は再送で通る |
| I7 | §10.2 | `baseVersion: 0` は「読んだとき行が無かった」。hook は版を持つ行を読んだときだけ `baseVersion` を送る（行が無い・v66 より前のサーバ：送らない＝表の「無し」） | 既存の画面の書き込み（`{instanceId, text}`）を変えない |
| I8 | §6.3 | 画面でメモを空にするときは mode を読まない（git を待たない）。mem の行は版を照合して `manual` で閉じる | §3.1 の「人が画面のメモを空にする：全 mode」 |
| I9 | §9 | 登録 root が 1 件も無いときは git を呼ばずに `not_registered` | 答えは git に依らず同じ。#2427 の既存の route のテスト（root なし）が git を呼ばない |
| I10 | §12.1 | `screen_only`（403）は CLI では exit 2 | CLI はこの経路を呼ばない（呼べば入力の不正と同じ扱い） |
| I11 | §10.4（整合性レビュー P1） | 書き込みのトランザクションの中で、instance が今も roster に同じツールで載っているかを読み直す（`MemActor.stillOnRoster`）。載っていなければ 52 `incarnation_changed` | v65 から移った instance は世代が未発行なので、世代だけでは「未発行」と「待機中に削除」を区別できない |
| I12 | §7（P2-1） | 部分更新・画面の編集の後、残した欄も含めて現行の規則で読み、どれかが当たれば検査版を上げない（withheld のまま） | 検査したのは送られた欄だけなので、検査版を上げると隠した欄が出る |
| I13 | §10.2（P2-2・P2-3） | 画面は編集を始めたときの版を下書きと一緒に固定して `baseVersion` に送る（PC は分割ごと、スマホは開いた編集欄ごと）。保存の失敗・下書き・開き直しは保存した worktree・instance に結び、切り替え先には出さない。409 を見せた後の再保存は最新の版で送る | 保存時点のキャッシュの版だと、編集中に届いた CLI の更新を上書きする。スマホの部品（scope の外）は開き直しのイベントの宛先を見ないので、hook の側で今の宛先と一致するときだけ出す |
| I14 | §10.4（P2-4） | 所有の判定は instance ID と作者の世代で照合し、`owner.worktreeId`（来歴、改名前の ID のまま）は比べない | 改名は世代表を新しい ID へ移すが、項目の来歴は旧 ID を残す |
| I15 | §10.4（P3） | 改名の衝突の分岐は、残った子の行を消す前にフック（`beforeDropLeftovers`）を呼び、runtime の改名（`migrateWorktreeIdPreservingChildren`）が mem の `now` を closed（`slot-removed`）で退避する | migration の層は `mem-db` を import しない（循環と `vi.mock` の継承を避ける）。v54/v55 の migration は v66 より前なので mem の表が無い |

本文に無い指摘（実装で見つけたもの。直さない。改名の衝突の分岐の退避は I15 で直した）：

- `src/components/worktree/MobileTerminalTabSessionNote.tsx`（契約の scope の外）は保存の直後に編集欄を閉じる。§10.2 のとおり共有の hook の側で開き直して入力を残したが、スマホの部品が保存の結果を待つ形に直すなら別の Issue
