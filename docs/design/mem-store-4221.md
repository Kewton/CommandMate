# mem の設定・置き場・CRUD の CLI（Issue #4221 / Epic #4220 の子 A）設計

- 状態：設計の段（実装前）。この文書を Codex が事前レビューした後、同じブランチの別の契約で実装する
- 前提：Epic #4220 の決定事項 D1〜D13。とくに D3〜D7・D12
- 凡例：**［事実］** = この文書を書いた時点（2026-11-08、`feature/4221-worktree` = develop `2307b8135`）でファイルと行を読んで確かめたもの。**［見立て］** = 設計としての判断。**［未確認］** = 読んでいない・実測していないもの。行番号は確認時点のもので、実装の契約では名前で探し直す

---

## 0. Epic の決定と食い違う点

**食い違う点は無い**（D1〜D13 と違う作りは採らない）。ただし、D の文面だけでは一意に決まらず、この文書が解釈を選んだ点を次に挙げる。レビューで解釈が違えば、ここを直してから実装する。

| # | 決定 | 選んだ解釈 | 理由 |
|---|---|---|---|
| T1 | D3「off は何も評価・更新しない」と D7「`now` は #2427 のメモと同じ正本」 | #2427 の画面のメモ（既存の機能）は mode に関係なく今までどおり書ける。mode が縛るのは mem の口（CLI・B・C・F・G）だけ。mode が `on` 以外のときの画面のメモの書き込みは「人の書き込み」として同じ行を更新し、mem の欄（§10.2 の `mem_*`）は消さずに `version` だけ進める | #2427 を off（既定）で壊さない。off の利用者にとってメモは今までの機能のまま |
| T2 | D3「off は更新しない」と、instance・worktree を消すときの `now` の保持（Issue「prune の前に終了の記録へ移すか」） | mem の欄を持つ `now` の行は、mode に関係なく、消える前に `mem_items` へ closed（`close_reason='slot-removed'`）として移す。これは評価でも利用者の操作でもなく、既存の削除に伴う保存なので、off でも行う | 「`on → off → on` で項目が保持される」（受入基準）を、off の間の roster 編集でも満たすため |
| T3 | D3「変える経路は画面だけ」 | 「画面の経路」をサーバで見分ける印は、ブラウザだけが付ける `Sec-Fetch-Site: same-origin` と `Origin` の一致、および `Authorization: Bearer` が無いこと（§11）。同じ OS 権限のプロセスはこの印を偽れるので、**保証ではなく検査**として書く | D3 自身が「保証と書かず、検査の限界として書く」としている |
| T4 | Issue の CLI 例は `add` の `--close-when` を必須に見せている | 既定値を持つ kind（`note` → `manual`、`decision` → `promoted`）だけ省略できる。他の kind は必須（§2.3） | Issue 本文が「`close_when` が必須の kind と、既定値を持つ kind を表にする」と求めている |

---

## 1. 契約の説明と実コードの照合（事実）

| 契約・Issue の説明 | 実コード | 判断 |
|---|---|---|
| セッションメモは `src/lib/db/memo-db.ts` | **違う。** `memo-db.ts` は `worktree_memos`（Issue #479 のワークツリーのメモ）の CRUD（`src/lib/db/memo-db.ts:1-6`）。#2427 のセッションメモは `src/lib/db/agent-instances-db.ts` にある（`MAX_SESSION_NOTE_LENGTH = 100` は `agent-instances-db.ts:563`、`normalizeSessionNoteText` は `:616`、`setSessionNote` は `:717`、`pruneSessionNotes` は `:766`） | 実コードを正とする。§10 は `agent-instances-db.ts` を変える |
| `migrations/v61-session-notes.ts` | `session_notes(worktree_id, instance_id, note NOT NULL, updated_at, PK(worktree_id, instance_id), FK worktrees ON DELETE CASCADE)`（`v61-session-notes.ts:70`） | 一致 |
| `src/app/api/worktrees/[id]/instances/notes/route.ts` | `GET` / `PUT`。`PUT` は roster にある instance だけ受ける（`route.ts:119`）、`setSessionNote` を呼ぶ（`:129`）、ログは長さだけ（`:131`） | 一致 |
| 最新の migration | `CURRENT_SCHEMA_VERSION = 65`（`src/lib/db/migrations/runner.ts:34`）、`v65_migrations` が最後（`runner.ts:103`、`v65-agent-instance-creation-keys.ts`） | 新しい版は **v66** |
| #4114 の所属の解決 | `src/lib/agent-roles/resolve.ts`。`withSettledWorktreeMembership`（`:254`）が worktree から登録 root の集合（`members`・`undetermined`）を作る。`membershipFrom`（`:163`）が「`repository_path` が名指す root」または「`git rev-parse --git-common-dir` が一致する root」を候補にし、有効な root があれば有効なものだけを数える。`resolveDefaultsForTool`（`:338`）が root ごとの設定を比べ、違えば `ambiguous`（`root-settings-differ`）、git が答えない root の設定が違えば `ambiguous`（`membership-undetermined`） | 再利用する（§9） |
| CLI の終了コード | `ExitCode` は 0〜5・99（`src/cli/types/index.ts:10-19`）。ほかに 10・11・124（wait）、20・21（verify）、40・41（strict respond、`:276`）、11・12・13（`:627` 付近の別コマンド）、30（`:663`）、31・32（`RoleExitCode`、`:674`）。50 番台は未使用 | mem は 50 番台を使う（§12） |

---

## 2. 決めること 2：`close_when` の入力の文法と保存の形

B（#4222）の型の表（`issue`・`pr`・`branch`・`relay`・`worktree`・`session`・`at`・`manual`）に合わせる。A は **文法・正規化・保存の形・既定値・不正の拒否** を受け持ち、B は保存された形を評価する。A に `now` 専用の型 `replaced` を足す（B は評価しない。次の `now` の書き込みで A が閉じる）。

### 2.1 入力の文法（CLI の `--close-when` と API の `closeWhen` の文字列）

```
cond      := type ":" args | "manual" | "replaced"
issue     := "issue:" target "#" N            ; 成立 = closed
pr        := "pr:" target "#" N [ "?" "state=merged" | "?" "state=closed" ]   ; 既定 state=merged
branch    := "branch:" name "?" ( "merged=" ref [ "&scope=" ("local"|"remote") ] | "deleted" [ "&scope=" ... ] )
relay     := "relay:" relay-id
worktree  := "worktree:" worktree-id      ; 成立 = 削除された
session   := "session:" session-or-run-id ; PID は受けない
at        := "at:" ISO8601-with-offset    ; 例 at:2026-11-09T09:00+09:00
target    := "" | host "/" owner "/" repo  ; 空 = 項目の repository の origin
```

- `#N` だけ（`issue:#4221`）は、項目の repository の `origin` remote の URL から host・owner・repo を補って保存する（B の表「番号だけの `#N` は項目の repository を既定にして保存する」）。origin が無い・解析できないときは **入力の不正**で断る（推測で補わない）［見立て］
- `branch` の `merged=` は必須の合流先の ref。作成したときの tip（`git rev-parse <name>`）を A が保存時に取って入れる（B の「作成したときの tip より後の commit を含む」の判定材料）。取れないときは断る
- `worktree` は作成時の worktree の世代（§10.2 の `mem_instance_incarnations` ではなく、worktree の `id` と、保存時の `worktrees` 行の存在）を保存する。存在しない ID は断る
- `at` はオフセット必須（`Z` か `±HH:MM`）。オフセットの無い時刻は断る（サーバのタイムゾーンで黙って解釈しない）。過去の時刻は断らない（作ってすぐ成立の候補になるだけ）
- 未知の型・未知のキー・重複キー・余分な文字・長さ 300 code point 超は、保存の前に **入力の不正**（exit 2、`code: "invalid_close_when"`）

### 2.2 保存の形（`close_when` 列、JSON、`schema` は版）

| 型 | 保存する JSON（`schema: 1`） |
|---|---|
| `manual` | `{"schema":1,"type":"manual"}` |
| `replaced` | `{"schema":1,"type":"replaced"}`（`now` だけ） |
| `issue` | `{"schema":1,"type":"issue","host":"github.com","owner":"Kewton","repo":"CommandMate","number":4221}` |
| `pr` | 上と同じ形に `"state":"merged"\|"closed"` |
| `branch` | `{"schema":1,"type":"branch","repositoryId":"…","name":"feature/x","event":"merged"\|"deleted","into":"develop","scope":"local"\|"remote","tipAtCreate":"<40 hex>"}` |
| `relay` | `{"schema":1,"type":"relay","relayId":"…"}` |
| `worktree` | `{"schema":1,"type":"worktree","worktreeId":"…"}` |
| `session` | `{"schema":1,"type":"session","sessionId":"…"}` |
| `at` | `{"schema":1,"type":"at","epochMs":1762646400000,"offset":"+09:00"}`（評価は `epochMs`、`offset` は表示用） |

- host・owner・repo は小文字に正規化しない（GitHub は大文字小文字を区別しないが、表示を壊さない）。比較は B が大文字小文字を無視して行う［見立て］
- `schema` が読み手の知らない版のときは、B は「不明」として扱う（閉じない）。A は今の版 1 だけを書く
- **A だけで保存した値を B が読める**ことを、A の実装のテストで固定する：各型の保存値を fixture にし、B の実装で同じ fixture を読む（§13 の T-COND）

### 2.3 kind ごとの `close_when` の必須と既定値

| kind | 必須か | 既定値 | 受ける型 |
|---|---|---|---|
| `now` | 任意 | `replaced` | `replaced`・`at`・`issue`・`pr`・`branch`・`relay`・`session` |
| `waiting` | **必須** | — | `manual` 以外すべて（待つ相手を型で書かせる）［見立て］ |
| `decision` | 任意 | `promoted`（保存は `{"schema":1,"type":"manual"}` と同じ扱いではなく、§3 の遷移でだけ閉じる。列は `NULL`） | 追加の条件は受けるが、`promoted` になるまで評価しても閉じない（§3） |
| `next` | **必須** | — | すべて（`manual` を含む） |
| `external` | **必須** | — | `issue`・`pr`・`branch`・`at`・`manual` |
| `note` | 任意 | `manual` | `manual`・`at` |

---

## 3. 決めること 3：kind ごとの状態の遷移

状態の列は `state`：`open` / `recorded` / `promoted` / `closed`。`recorded`・`promoted` は `decision` だけ。終了の理由（`close_reason`）は成否と分けて持つ（D8）。

### 3.1 非 decision（`now`・`waiting`・`next`・`external`・`note`）

| 現在 | きっかけ | 次 | 誰ができるか | mode |
|---|---|---|---|---|
| （なし） | `mem add` / `mem now` | `open` | 書いた instance（作成者になる） | `on` だけ |
| `open` | `mem update --if-version` | `open`（`version+1`） | 作成者の instance（同じ incarnation）・人（画面） | `on` だけ |
| `open` | `mem close` | `closed`（`close_reason='manual'`） | 作成者・人 | `on` だけ |
| `open` | B の評価で成立 | `closed`（`close_reason='condition'`、照会の結果は B の欄） | サーバ（誰の項目にも効く、D6） | `on` だけ |
| `open`（`now`） | 同じ instance の次の `mem now` | 古い行は `mem_items` に `closed`（`close_reason='superseded'`）、枠は新しい内容 | その instance | `on` だけ |
| `open`（`now`） | instance が roster から消える・worktree が消える | `mem_items` に `closed`（`close_reason='slot-removed'`） | サーバ（既存の削除に伴う） | **全 mode**（T2） |
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

mode の判断は 1 つの関数（`resolveMemMode`、§9）で行い、CLI・B・C・F・G はその結果だけを見る（同じ判断を写さない）。**曖昧**（§9.3）と**未登録**は、書き込みでは断り、評価・表示・促しでは `off` と同じ扱いにする。

| 操作 | `off` | `derived` | `on` | 曖昧・未登録 |
|---|---|---|---|---|
| `mem mode`（読む） | 0、`mode:"off"` と決めた規則 | 0、`derived` | 0、`on` | 曖昧は exit 53・候補の root、未登録は exit 52 |
| `mem now` / `add` / `update` / `close`（手で書く口） | **exit 50 `disabled`**、何も保存しない | **exit 50**、何も保存しない（凍結） | 0 | 52 / 53、何も保存しない |
| `mem list` | exit 50（項目は返さない。保持はしている） | 0、項目に `frozen:true`。評価しない | 0、B の評価の結果つき | 52 / 53 |
| `mem check`（B） | exit 50 | exit 50 | 0 | 52 / 53 |
| B：条件の評価 | しない | しない | 読むとき（list・check・brief）にする | しない |
| B：自動の close | しない | しない | する | しない |
| B：終わった知らせの作成 | しない | しない | する | しない |
| B/D：知らせの受領 | しない（作成済みの知らせは残す。消さない） | しない（同上） | brief に入れて送れた ID だけ受領 | しない |
| C：brief | 出さない | 導いた状態だけ（mem の項目は出さない） | 導いた状態＋項目 | 出さない（`off` と同じ） |
| F：更新の促し | 出さない | 出さない | 出す | 出さない |
| G：画面での項目の編集 | 断る（409 `disabled`） | 断る（凍結） | 可 | 断る |
| 画面：mode の変更（§11） | 可 | 可 | 可 | 可（root ごとの設定の画面で揃える） |
| #2427 の画面のメモ | 今までどおり（T1） | 今までどおり（T1） | `now` の人の書き込み（§10.2） | 今までどおり |
| `slot-removed` の保存（T2） | する | する | する | する（保存先は行に記録済みの `repository_id`） |
| `mem purge` | 可（`--confirm` 必須） | 可 | 可 | 52 / 53 |

- `on → off/derived → on` のとき、off/derived の間に成立した条件は、`on` に戻った後の最初の読み（list・check・brief）で評価され、そこで閉じる。off の間に「閉じたことにする」記録は作らない
- mode は書き込みの **トランザクションの中で** 読み直す（§5.3）。画面で mode を変えた直後の書き込みが古い mode で通らない

---

## 5. 決めること 5：保存の場所・schema・原子的な更新・保持

### 5.1 置き場

- SQLite（既存の DB、`getDbInstance()`）。新しいファイルを作らない。worktree のファイルには置かない（D3）
- テーブルは §10.2。項目は `repository_id`＋ブランチ名で持ち、worktree の行には紐づけない

### 5.2 保持

| 出来事 | 設定 | 項目（`mem_items`） | `now`（`session_notes`） |
|---|---|---|---|
| サーバの再起動 | 保持（DB） | 保持（DB、`version` も） | 保持 |
| worktree の削除・作り直し（同じブランチ） | 保持（repository に付く） | **保持**。`origin_worktree_id` は来歴として残る（`worktree_id` という列名にしないので、`getWorktreeChildTables` の掃除の対象にならない、§10.3） | 行は CASCADE で消える（既存）。消える前に `slot-removed` として `mem_items` へ移す（T2） |
| instance の roster からの削除 | — | 保持。作成者の incarnation が消えるので、以後の update/close は人だけ | `pruneSessionNotes` で消える（既存、`agent-instances-db.ts:287`・`:362`）。その前に `mem_items` へ移す |
| 同じ instance ID の作り直し | — | 前の項目は前の incarnation のまま。新しい instance は作成者にならない | 新しい incarnation で空の枠から始まる |
| repository の登録の削除（`deleteRepository`、`db-repository.ts:317`） | CASCADE で消える | 残る（FK なし）。どの root にも属さないので表示されない［見立て。§15 未決 U3］ | — |
| mode を `off` にする | — | 消さない | 消さない |

### 5.3 原子的な更新

- すべての書き込みは 1 つの `db.transaction` の中で：mode を読み直す → 対象の行を読む → 版・作成者・件数の上限を検査 → 書く → 版を `+1`。better-sqlite3 は同期なので、この区間は 1 つの一貫した見え方になる（`resolve.ts` の `finishAttempt` と同じ考え方、`resolve.ts:213`）
- 所属の解決は git を `await` するので、トランザクションの外で行い、中で「解決したときの root の集合の署名」（`rootsSignature` と同じ材料）と worktree の `path`・`repository_path` を照合し直す。変わっていたら最大 3 回まで解決し直し、それでも変わるなら exit 53（`registration_changed`）［見立て。`withSettledMembership` の上限 3 回、`resolve.ts:227` と同じ］
- 全体を書き戻す API を作らない（D6）。項目ごとの `add`・`update`（版つき）・`close`
- `--key`：`(repository_id, idempotency_key)` に一意の制約。同じ key・同じ要求の指紋（kind・text・close_when・evidence・promote_to・quote の正規化後の SHA-256）なら、既にある項目をそのまま返す（exit 0、`replayed:true`）。同じ key で指紋が違うなら exit 54 `duplicate_key`。v65 の `agent_instance_creation_keys` と同じ型［事実：`v65-agent-instance-creation-keys.ts`］

---

## 6. 決めること 6：自由入力の欄の検査

すべて **サーバで** 検査する（CLI の検査は便宜。#2427 の `MAX_SESSION_NOTE_LENGTH` と同じ考え方、`agent-instances-db.ts:550-563`）。長さは code point で数える（`Array.from(text).length`、#2427 と同じ）。

| 欄 | 上限（code point） | 改行・タブ | ほかの制御文字 | 秘密らしい文字列 | 断ったときの応答 |
|---|---|---|---|---|---|
| `text`（`now`） | **100**（#2427 と同じ、§10.4） | 空白に畳む（`normalizeSessionNoteText` と同じ） | 空白に畳む | 断る | `{code:"secret_like", field:"text", rule:"<id>"}` |
| `text`（`now` 以外） | 1000 | LF・TAB は許す。CR は LF に、CRLF は LF に | 断る（`control_char`） | 断る | 同上 |
| `quote` | 500 | LF 許す | 断る | 断る | 同上 |
| `quote_at` | ISO8601（オフセット必須）。未来 5 分超は断る | — | — | — | `invalid_quote_at` |
| `evidence` | 1 項目に 5 件まで、各 300 | 不可 | 断る | 断る | `invalid_evidence` |
| `promote_to` | 300 | 不可 | 断る | 断る | `invalid_promote_to` |
| `reason`（close） | 300 | 不可（空白に畳む） | 畳む | 断る | 同上 |
| `--key` | 128、`[A-Za-z0-9._:-]` だけ | — | — | — | `invalid_key` |

- **ほかの制御文字**：C0（LF・TAB を除く）・DEL・C1（U+0080〜U+009F）・双方向の制御（U+202A〜U+202E、U+2066〜U+2069）・U+FEFF。`now` 以外は畳まずに断る（Agent の入力は直させる。人が貼った複数行の扱いは #2427 の画面の経路だけが畳む）［見立て］
- **秘密らしい文字列**：新しい `src/lib/mem/secret-scan.ts` に規則を ID つきで持つ。最初の規則：`bearer`（`Bearer\s+\S{16,}`）・`assignment`（`(password|passwd|pwd|token|secret|api[_-]?key|auth)\s*[=:]\s*\S{8,}`）・`authorization-header`・`private-key-block`（`-----BEGIN … PRIVATE KEY-----`）・`url-userinfo`（`scheme://user:pass@`）・`github-token`（`gh[pousr]_[A-Za-z0-9]{36,}`・`github_pat_`）・`anthropic-key`（`sk-ant-`）・`openai-key`（`sk-[A-Za-z0-9]{20,}`）・`aws-access-key`（`AKIA[0-9A-Z]{16}`）・`slack-token`（`xox[abprs]-`）・`jwt`（`eyJ…\.…\.…`）。ロガーの `SENSITIVE_PATTERNS`（`src/lib/logger.ts:75`）は置き換えのための規則で、拒否の判定には使わない（偽陽性の基準が違う）。エントロピーだけの判定はしない（偽陽性が多い）［見立て］
- **`evidence` の形**：`path:<repo-relative>[:<line>]`・`commit:<7〜40 hex>`・`issue:<target>#N`・`pr:<target>#N`・`task:<id>`・`relay:<id>`・`url:https://…`（userinfo・クエリの秘密は上の検査）
- **`path:` の正規化**（`evidence` と `promote_to`）：
  1. 絶対パス・`~`・NUL・バックスラッシュを断る（`absolute_path`。原文は応答に出さない）
  2. POSIX で正規化し、`..` で worktree の root の外へ出るものを断る（`outside_repository`）
  3. worktree の root から各成分を `lstat` し、**どれか 1 つでも symlink なら断る**（`symlink`）。`evidence` は存在を必須にする。`promote_to` は存在しなくてよいが、存在する最も深い祖先までを同じ検査にかける
  4. `findSensitivePathSegment`（`src/lib/security/sensitive-file-guard.ts:144`）が当たる成分（`.env` など）は断る（`sensitive_path`）
  5. 保存するのは正規化後の相対パスだけ。解決に使った絶対パスは保存しない
  - 既存の `isWithinRoot`（`src/lib/security/path-validator.ts:44`）と `resolveAndValidateRealPath`（`:184`）は realpath で symlink を **辿って** 内側かを見る関数なので、「symlink を断る」には足りない。新しく `lstat` の連鎖を書く［見立て。`:184` の中身の全文は未確認］

---

## 7. 決めること 7：どこに何が出るか

| 出口 | 出すもの | 出さないもの |
|---|---|---|
| DB（保存） | 検査を通った正規化後の値、作成者・更新者、時刻（サーバ）、`version`、`close_when` の JSON | 断った入力（何も書かない）、絶対パス |
| サーバのログ | `mem-item-written` 等の出来事名・`itemId`・kind・`repositoryId`・ブランチ・instance・**各欄の長さ**・断った理由の `code`・`field`・`rule` | 自由入力の本文、断った原文、絶対パス（#2427 の `route.ts:131` と同じ「長さだけ」） |
| `--json`（成功） | 項目の全欄（保存した値そのもの） | — |
| `--json`・CLI のエラー（失敗） | `code`・`field`・`rule`・上限・現在の版（版の競合）・候補の root の ID と表示名（曖昧） | 断った原文・当たった部分文字列・絶対パス（root の path も出さず、ID と名前だけ）［見立て：roles の曖昧は path を出している、`resolve.ts:331`。mem は Agent が読む口なので出さない］ |
| 会話の履歴（C の brief として送ったもの） | 保存済みの値を、出所・作者・時刻つきのデータの区切りで（D12。区切りの形は C が決める） | 断った値（保存されていないので出せない）、`frozen` の項目（derived） |
| 画面（G・#2427 の表示） | 保存済みの値 | 断った値 |
| promote の行き先（E） | 人が差分を承認した値だけ | 未承認の値。A は外へ書かない |

- 断った値は、サーバが受け取った瞬間からどこにも残さない：例外の `message` に原文を入れない（`SessionNoteTooLongError` が上限の数字だけを持つのと同じ、`agent-instances-db.ts:579-584`）。`logger.error` に入力の body を渡さない
- CLI は stdin・引数で受けた原文を、エラーの表示で繰り返さない

---

## 8. 決めること 8：増え方の扱い

### 8.1 open の件数（ブランチごと、kind ごと）

| kind | 警告（`--json` の `warnings`、exit 0） | 上限（それを超える追加は exit 56 `limit_exceeded`） |
|---|---|---|
| `now` | — | instance ごとに 1 枠（構造で決まる） |
| `waiting` | 10 | 30 |
| `next` | 10 | 30 |
| `external` | 10 | 30 |
| `note` | 20 | 50 |
| `decision` | 20 | **上限なし**（人の決定の記録を件数で断らない。警告だけ） |

［見立て］数字は 20KB 超えの引き継ぎ（Epic の背景）を避けるための初期値。C の予算が別にあるので、ここは「書く側に気づかせる」ためのもの。

### 8.2 古さ（F の促しと共有）

- 1 つの関数 `memItemStaleness(item, now)`（`src/lib/mem/staleness.ts`）が `fresh` / `stale` を返し、`list` の `stale` 欄・F の促し・G の表示が同じ関数を使う
- 対象は `open` の項目のうち `close_when` が `manual`（と `now` の `replaced`）のもの。基準は `updated_at` から：`now` 1 日・`next` 7 日・`waiting` 7 日・`external` 14 日・`note` 30 日・`decision`（`open`・`recorded`）14 日で「未反映」
- **古さは警告だけで、削除に使わない**

### 8.3 保持期間と purge

| 記録 | 自動の削除 | 理由 |
|---|---|---|
| `open`・`recorded`・`promoted` の項目 | しない | 人の決定・作業の状態 |
| `closed` の項目（`superseded` 以外） | しない（件数が 500 を超えたら `list` に警告） | 古さだけで消さない |
| `superseded` の `now` | 同じ枠（worktree・instance・incarnation）ごとに新しい 20 件を残し、古いものは次の `mem now` の同じトランザクションで消す | 1 行の枠の上書きの履歴で、件数で決める（時刻では消さない）。新しい定期の実行を足さない（D8・D13） |
| B の配送の記録（知らせ） | 受領済みは 30 日後、次の書き込みの同じトランザクションで消す。未受領は消さない | 配送の記録は人の決定ではない。具体の表は B が持つ［見立て］ |

`mem purge`：

- `--branch <name>` 必須（repository は呼び出した worktree か `--repository <id>` で決める）。`--closed-only`・`--kind <kind>`・`--before <ISO8601>` で絞る
- `--confirm` が無いと **何も消さず**、消える件数を kind ごとに出して exit 0（`--json` は `{dryRun:true, counts:{…}}`）
- `recorded`・`promoted` の decision は `--include-decisions` が無いと対象にしない
- Agent のセッションの中（`whoami` が成功する）からの purge は CLI が断る（exit 55）。環境変数を消せば通るので、これは検査で保証ではない（§11.3）

---

## 9. 所属の解決

### 9.1 再利用するもの（事実）

- `withSettledWorktreeMembership(db, worktreeId, deps, build)`（`src/lib/agent-roles/resolve.ts:254`）：worktree から `RoleRepositoryMembership { members, undetermined }` を作る。`members` は path の順（scan の順に依らない、`:96-101`）。git の答えを待つ間に登録が変わったら最大 3 回まで聞き直す（`:227`）
- `membershipFrom`（`:163`）：`repository_path` が名指す root、または `--git-common-dir` が一致する root が候補。候補に有効な root があれば有効なものだけ（`:186-188`）。git が失敗した、ディスクにある有効な root は `undetermined`
- 判定の型は role 専用（`resolveDefaultsForTool` は `cliToolId` を取る、`:338`）なので、**membership の部分だけを再利用し、設定の比較は mem 用に書く**。`withSettledWorktreeMembership` は role の名前空間にあるが role の設定を読まないので、移さずに import する［見立て。移すなら別 Issue］

### 9.2 mem の解決（`resolveMemMode(db, worktreeId)`、`src/lib/mem/mode.ts`）

1. `withSettledWorktreeMembership` で `members`・`undetermined` を得る。同じ `build` の中（同期の区間）で、下の 2〜5 を行う
2. ブランチ：worktree の path で `git symbolic-ref --quiet --short HEAD`（1 秒）を **membership を聞く前に** 取る。exit 1 = detached、それ以外の失敗 = 不明（書き込みを断る、exit 52 `branch_unresolved`）。`worktrees.branch`（`v36-worktree-branch.ts:29`、sync の時点の写し）は使わない（古いことがある）［見立て］
3. root ごとに mode を決める：ブランチの上書き → repository の規則（`position` の順で最初に当たった行。glob は `*` が `/` を含まない、`**` が含む）→ `off`。detached は `match='detached'` の行だけが当たる
4. `members` の全 root で（mode・機能の切り替え）が一致すればそれが答え。違えば **曖昧**（`root-settings-differ`）。`undetermined` の root の答えが違えば曖昧（`membership-undetermined`）。どちらも #4114 と同じ規則
5. 項目を **保存する** `repository_id` は `members[0]`（path の順で先頭）。**読む** ときは `members` 全部の ID の項目を合わせて読む（root が増えて先頭が変わっても、前の項目が見える）［見立て］

### 9.3 断る条件

| 状況 | 書き込み | 読み（list・mode） | 評価・C・F |
|---|---|---|---|
| `members` が空（未登録・どの root にも属さない） | exit 52 `not_registered` | exit 52 | off と同じ |
| 同じ common-dir の重複登録、設定が一致 | 通す（保存は `members[0]`） | 通す | 通す |
| 同じ common-dir の重複登録、設定が違う | exit 53 `ambiguous`（`root-settings-differ`）、候補の root の ID・名前 | exit 53 | off と同じ |
| git が答えない有効な root があり、設定が違う | exit 53（`membership-undetermined`） | exit 53 | off と同じ |
| 解決の間に登録が変わり続ける | exit 53（`registration_changed`） | 同じ | off と同じ |
| ブランチが取れない | exit 52 `branch_unresolved` | 同じ | off と同じ |
| 名前だけ違う repository の同名ブランチ | 別の `repository_id` なので混ざらない | — | — |
| scan の順が変わる | `members` は path の順なので答えは変わらない | — | — |

曖昧の解き方は人が画面で選ぶ：root の設定を揃えるか、片方の root を無効にする（#4114 と同じ、`resolve.ts:17-20`）。

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

-- instance の世代（ID の再利用で前の作業を引き継がないため）
CREATE TABLE mem_instance_incarnations (
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  incarnation TEXT NOT NULL,                     -- randomUUID
  created_at INTEGER NOT NULL,
  PRIMARY KEY (worktree_id, instance_id)
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
  origin_instance_id TEXT NOT NULL,
  origin_incarnation TEXT NOT NULL,
  session_generation TEXT,                       -- #4115 の世代。分かるときだけ
  created_by TEXT NOT NULL CHECK (created_by IN ('agent','human')),
  updated_by TEXT NOT NULL CHECK (updated_by IN ('agent','human','server')),
  updated_by_instance TEXT,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT CHECK (close_reason IN ('manual','condition','superseded','slot-removed','withdrawn')),
  close_note TEXT,                               -- close --reason
  idempotency_key TEXT, request_fingerprint TEXT,
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK (kind = 'decision' OR state IN ('open','closed'))
);
CREATE UNIQUE INDEX idx_mem_items_key ON mem_items(repository_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_mem_items_scope ON mem_items(repository_id, branch, state, kind);
```

- B の終了の記録（照会の結果・成否）と配送の記録は B の migration で足す（A では列を作らない）
- 規則の既定：行が無い repository は「規則なし → `off`」。最初のリリースで既定の行（`main → on` 等）を自動で入れない（D3：有効にするのは人だけ）

### 10.2 `session_notes` の拡張（D7：`now` の正本）

```sql
ALTER TABLE session_notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE session_notes ADD COLUMN mem_item_id TEXT;          -- now の項目 ID（mem から書いたとき）
ALTER TABLE session_notes ADD COLUMN mem_repository_id TEXT;
ALTER TABLE session_notes ADD COLUMN mem_branch TEXT;
ALTER TABLE session_notes ADD COLUMN mem_incarnation TEXT;
ALTER TABLE session_notes ADD COLUMN mem_close_when TEXT;
ALTER TABLE session_notes ADD COLUMN mem_evidence TEXT;
ALTER TABLE session_notes ADD COLUMN created_by TEXT;           -- 'agent' | 'human'（NULL = v66 より前）
ALTER TABLE session_notes ADD COLUMN updated_by TEXT;
ALTER TABLE session_notes ADD COLUMN created_at INTEGER;
```

- 1 つの行が「#2427 のメモ」でも「`now` の枠」でもある。`mem_item_id IS NOT NULL` の行が mem の `now`
- `mem now`（`on`）：同じ行を書く。前の内容に `mem_item_id` があれば `mem_items` へ `superseded` として写してから上書き（§8.3 の 20 件）。`mem_incarnation` は `mem_instance_incarnations` の今の値
- 画面のメモ（`PUT …/instances/notes`）：
  - mode が `on`：`now` の人の書き込み。§6 の秘密らしい文字列の検査を足す（off では足さない＝#2427 の挙動を変えない）。`version` を受けたら版つきで書く（違えば 409）。受けなければ今までどおり上書き
  - mode が `on` 以外：今までどおり。`version+1`・`updated_by='human'` だけ足す（T1）
  - 空にする（行の削除）：mem の `now` だったら、消す前に `mem_items` へ `closed`（`manual`、`updated_by='human'`）
- 読み手の互換：`getSessionNote`・`getSessionNotesByWorktree`・`getAllSessionNotes`（`agent-instances-db.ts:638`・`:659`・`:687`、`GET /api/worktrees` が `src/app/api/worktrees/route.ts:112` で使う）が返す `SessionNote { text, updatedAt }` の形は変えない。mem の欄は別の関数で読む

### 10.3 `worktree_id` という列名を `mem_items` に使わない理由

`getWorktreeChildTables`（`worktree-child-tables.ts:48`）は `worktree_id` という列を持つ表を FK の有無に関係なく「worktree の子」とし（`:24`）、`getDeletableWorktreeChildTables`（`:133`）が worktree の削除・v52 の掃除で消す。項目は worktree の削除を越えて続く（D4）ので、来歴の列は `origin_worktree_id` にする。代わりに worktree ID の改名（v54/v55）には追従しない：来歴として古い ID が残るだけで、所属の判断（`repository_id`＋ブランチ）には使わない。detached の項目だけは `origin_worktree_id` で絞るので、改名で見えなくなる［見立て。§15 U4］

`mem_instance_incarnations`・`session_notes` は worktree の子のまま（改名に追従、削除で消える）。

### 10.4 #2427 の 100 code point の上限・prune・表示（Issue の「決めること 4」）

| 論点 | 決定 |
|---|---|
| 上限 | **100 のまま**。`now` は「いまこれをしている」の 1 行（分割の見出しに出る、`TerminalSplitPane.tsx:112`・`:276`）。長い段取りは `next`・`note` に書く。上限を上げると画面の見出しと #2427 の受入を変えることになる |
| prune | 既存の `pruneSessionNotes`（`agent-instances-db.ts:766`）と `removeAgentInstance` の `DELETE`（`:362`）の前に、`mem_item_id` のある行を `mem_items` へ `slot-removed` として写す（T2）。同じトランザクションの中 |
| worktree の削除 | `deleteWorktreesByIds`（`worktree-db.ts:978`）・`deleteRepositoryWorktrees`（`:943`）のトランザクションの中で、CASCADE の前に同じ写しを行う |
| 画面の表示 | 変えない（文字と時刻）。mem の欄（作成者・版・`close_when`）は G（#4227）が出す |
| 既存の行の移行 | v66 は既存の行に `version=1` だけを入れ、`mem_*` は NULL（mem の項目ではない）。既存のメモを勝手に mem の `now` にしない（mode は既定で off、D3） |

---

## 11. 画面の最小の口と、mode を変える API

### 11.1 置き場所

- 画面：`/repositories`（`src/app/repositories/page.tsx`、PC・スマホ共通のページ。`useIsMobile` で切り替え）の repository の行。roles の設定と同じく、行を開くと出る（`RepositoryList.tsx:731` の `RepositoryRoleDefaults` の隣）。新しいコンポーネント `src/components/mem/RepositoryMemSettings.tsx`：規則の表（glob → mode、detached の行、並べ替え）・ブランチの上書きの一覧・機能の切り替え 3 つ
- API：`GET/PUT /api/repositories/[id]/mem-settings`（規則・機能・`version`）、`PUT/DELETE /api/repositories/[id]/mem-settings/branches`（上書き）。`PUT` は `version` 必須（違えば 409）
- スマホで行が開けるかは未確認（§15 U1）

### 11.2 「画面の経路だけ」の作り

1. **CLI に口を作らない**：`commandmate mem` に mode を変えるサブコマンドもオプションも無い。`src/cli/` が `mem-settings` の書き込みの URL を持たないことをガードのテスト（`tests/unit/guards/mem-mode-write-screen-only.test.ts`）で固定する：`src/cli/**` に `mem-settings` の文字列と `put(`・`delete(` の組が無いこと
2. **サーバの印**：書き込みの route は次をすべて満たさない要求を 403 `screen_only` で断る：`Sec-Fetch-Site: same-origin`、`Origin` がリクエストの host と一致、`Authorization: Bearer …` が無い（CLI は Bearer を付ける、`src/cli/utils/api-client.ts:201`）。判定は新しい `src/lib/security/screen-request.ts` の 1 関数
3. 読み（`GET`）は CLI からも可（`mem mode` が使う）

### 11.3 防げないこと（検査の限界）

- 同じ OS 権限のプロセス（Agent を含む）は、`curl` でヘッダを偽れば 2 の印を通れる。DB ファイル（`CM_DB_PATH`）を直接書き換えることもできる。CommandMate はこれを **防がない・検出しない**
- 防いでいるのは「CLI の正規の口から変えられる」ことと「CLI の利用者が気づかずに変える」ことだけ。Agent に mode を変えさせないのは、口が無いことと skill（#4228）の指示であって、技術的な保証ではない
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
| 54 | DUPLICATE | `duplicate_key` | 同じ `--key` で中身が違う。既存の項目の ID を返す |
| 55 | NOT_OWNER | `not_owner` / `state_forbids` | 作成者でない instance、または状態が許さない（`recorded` の decision の close、セッションの中の purge） |
| 56 | LIMIT | `limit_exceeded` | §8.1 の上限 |
| 99 | UNEXPECTED_ERROR（既存） | `internal_error` | 予期しない失敗 |

50〜56 にしたのは、30〜32・40〜41 を使うループが同じ `$?` を読むため（`RoleExitCode` のコメントと同じ理由、`src/cli/types/index.ts:666-673`）。

### 12.2 `--json` の形

```jsonc
// 成功（add / update / close / now）
{ "ok": true, "item": { /* §12.3 */ }, "replayed": false, "warnings": [] }
// 失敗
{ "ok": false, "code": "version_conflict", "message": "…", "exitCode": 51,
  "currentVersion": 4, "item": { /* 今の内容 */ } }
// mem mode
{ "ok": true, "mode": "on", "source": { "level": "override" | "rule" | "fallback",
  "repositoryId": "…", "branch": "main", "rulePosition": 0, "pattern": "main" },
  "features": { "injectOnStart": false, "promptOnEvents": false, "popup": false },
  "repositoryIds": ["…"] }
// mem list
{ "ok": true, "mode": "on", "branch": "main", "items": [ … ], "now": [ { "instanceId": "claude-2", "item": { … } } ],
  "warnings": [ { "code": "open_count", "kind": "next", "count": 11, "threshold": 10 } ] }
```

### 12.3 項目の形（`--json` と API で共通）

`id`・`kind`・`state`・`text`・`closeWhen`（§2.2 の JSON）・`promoteTo`・`quote`・`quoteAt`（ISO8601 UTC）・`evidence`（配列）・`owner { repositoryId, branch, worktreeId, instanceId, incarnation, sessionGeneration }`・`createdBy`・`updatedBy`・`version`・`createdAt`・`updatedAt`・`closedAt`・`closeReason`・`stale`（§8.2）・`frozen`（derived）

### 12.4 対象の決め方

- 既定は `whoami` で決まる自分（`resolveSessionIdentity`、`src/cli/commands/whoami.ts:195`）
- `whoami` が exit 3（`NOT_IN_SESSION`、`whoami.ts:58`）の通常のシェルでは、書き込みに `--worktree <id> --instance <id>` を必須にする（無ければ exit 2 `target_required`）。`list`・`mode`・`purge` は `--worktree <id>` か `--branch <name> --repository <id>` でよい
- 人の通常のシェルから `--instance` を指定した書き込みは、その instance として書く（人としては書かない。人の経路は画面だけ）［見立て］

---

## 13. 実装の範囲と対照のテスト

### 13.1 新規ファイル

| ファイル | 中身 |
|---|---|
| `src/lib/db/migrations/v66-mem-store.ts` | §10.1・§10.2 |
| `src/lib/db/mem-db.ts` | 項目・設定・incarnation の CRUD（トランザクション、版、key） |
| `src/lib/mem/mode.ts` | `resolveMemMode`（§9.2）、glob の照合 |
| `src/lib/mem/close-when.ts` | §2 の文法・正規化・保存の形・kind ごとの許可 |
| `src/lib/mem/validate.ts` | §6 の長さ・制御文字・`evidence`/`promote_to` の正規化 |
| `src/lib/mem/secret-scan.ts` | §6 の規則（ID つき） |
| `src/lib/mem/staleness.ts` | §8.2 |
| `src/lib/mem/transitions.ts` | §3 の表（関数として） |
| `src/lib/security/screen-request.ts` | §11.2 の印 |
| `src/app/api/worktrees/[id]/mem/route.ts` ほか（`items`・`items/[itemId]`・`now`・`mode`・`purge`） | 書き込み・読みの API |
| `src/app/api/repositories/[id]/mem-settings/route.ts`・`…/branches/route.ts` | §11.1（画面だけ） |
| `src/cli/commands/mem.ts` | `now`・`add`・`update`・`close`・`list`・`mode`・`purge` |
| `src/components/mem/RepositoryMemSettings.tsx` | §11.1 |
| `src/types/mem.ts` | 項目・mode・API の型 |
| `tests/unit/...`（下の表） | — |

### 13.2 変更する既存ファイル

| ファイル | 変更 |
|---|---|
| `src/lib/db/migrations/runner.ts` | `CURRENT_SCHEMA_VERSION = 66`、`v66_migrations` |
| `src/lib/db/agent-instances-db.ts` | `pruneSessionNotes`・`removeAgentInstance`・`setSessionNote` の前の写し（T2）、`version`・`updated_by` |
| `src/lib/db/worktree-db.ts` | `deleteWorktreesByIds`・`deleteRepositoryWorktrees` の写し |
| `src/app/api/worktrees/[id]/instances/notes/route.ts` | mode が `on` のときの検査・`version`（§10.2） |
| `src/cli/types/index.ts` | `MemExitCode` |
| `src/cli/program.ts` | `mem` の登録 |
| `src/components/repository/RepositoryList.tsx` | §11.1 の開く行 |
| `locales/ja/common.json`・`locales/en/common.json` | 画面の文言（roles の設定の文言と同じ `common` に置く見立て。置き場の辞書は実装で確かめる） |
| `docs/user-guide/cli-operations-guide.md`（ja・en） | `mem` の節・全終了コード一覧（§12.1）・§11.3 の限界 |
| `docs/module-reference.md` | 断片で（実装の契約） |
| `scripts/check-route-exports.mjs` の対象 | 新しい route が許された export だけを持つ（既存のガード `tests/unit/guards/route-export-allowlist.test.ts` が見る） |

### 13.3 受入基準と対照のテスト

DB を使うテストは `os.tmpdir()` の `mkdtempSync` の中の DB で、`afterEach` で消す。git は `RoleResolverDeps` の `resolveCommonDir`・`pathExists` を差し替える（`resolve.ts:87-94`）。

| 受入基準 | 陽性（直す前の実装で落ちる・断るべきを断る） | 陰性（変わらない・通すべきを通す） |
|---|---|---|
| 初期は `off`、`off`/`derived` で書き込みを断り何も保存しない | 規則なしの repository で `now`/`add`/`update`/`close` が 50、行数 0。`derived` の規則でも 50 | `on` の規則で 0、行が 1 |
| CLI から mode を変える口が無い | ガード：`src/cli/**` に `mem-settings` の書き込みが無い。route：Bearer つき・`Sec-Fetch-Site` 無しの `PUT` が 403 | ブラウザの印つきの `PUT` が 200、`GET` は Bearer でも 200 |
| 規則の優先順位 | 上書き（`feat/x → off`）が規則（`feat/* → on`）に勝つ、先の行が勝つ、detached は `detached` 行だけ、規則なし → off | glob が当たらないブランチは次の行へ、`*` は `/` を跨がない |
| 2 つの instance が同時に `now` | A・B が交互に `now`、互いの行が残る | 同じ instance の 2 回目は上書きで 1 行＋`superseded` 1 件 |
| 版の競合 | 古い `--if-version` で 51、内容は前のまま、応答に今の内容 | 正しい版で 0、`version+1` |
| 作成者でない instance | 別 instance の `update`/`close` が 55、同じ ID の新しい incarnation も 55 | 作成者で 0、画面（人）で 0 |
| `--key` | 同じ key・同じ中身の 2 回で 1 件・2 回目 `replayed` | 同じ key・違う中身で 54、違う key で 2 件 |
| 混ざらない・世代 | 別 repository の同名ブランチの項目が出ない、instance を消して作り直すと前の `now` が出ない（`slot-removed` になる） | 同じブランチの別 worktree から前の項目が見える |
| `on → off → on`・purge | off の間の roster の削除で `now` が `slot-removed` で残る、`--confirm` 無しの purge で行数が変わらない | `--confirm` で消える、`--include-decisions` 無しで `recorded` は残る |
| 自由入力の欄 | 各欄で上限＋1・秘密の各規則・C0/C1/双方向の制御・絶対パス・`..`・symlink・`.env` を断る | 上限ちょうど・LF/TAB（`now` 以外）・似ているが秘密でない文字列（`token` という語だけ、短い値）を通す |
| 再起動の後の保持 | DB を閉じて開き直した後に項目と版が同じ | — |
| 所属の解決 | 同じ common-dir の 2 root で設定が違う → 53、git が答えない有効な root の設定が違う → 53、未登録 → 52 | 2 root で設定が一致 → 通る、scan の順（`repository_path`）を入れ替えても同じ答え、名前だけ違う repository は別 |
| `close_when` | 未知の型・オフセットの無い `at`・origin の無い `#N`・kind が受けない型を断る | §2.2 の各型の保存値の fixture を A が書いて読める（B が同じ fixture を使う：T-COND） |
| mode の遷移 | `on` で作成 → `off`：list 50・check 50・brief に出ない・画面の編集 409 → `derived`：list は `frozen`・書き込み 50 → `on`：書き込み 0 | 各時点で項目の行と版が変わらない（許された更新だけ） |
| 断った値が出ない | 秘密・絶対パスで断ったとき、応答の JSON・CLI の stderr・ロガーのモックの呼び出しに原文の部分文字列が無い | 断った理由の `code`・`field`・`rule` は出る |
| #2427 を壊さない（陰性だけ） | — | `off` で画面のメモの `PUT`・`GET` の応答が v65 と同じ形、100 の上限、空で削除、alias の変更で残る（既存のテストがそのまま通る） |

---

## 14. 対になる場所（探した結果）

| 探した対象 | 結果 |
|---|---|
| 画面のメモの PC とスマホ | PC は `TerminalSplitPane.tsx`、スマホは `MobileTerminalTabSessionNote.tsx`（`SessionNoteInput`・`useSessionNote` を `TerminalSplitPane` から import、`MobileTerminalTabSessionNote.tsx:5-10`）。route を呼ぶのは `TerminalSplitPane.tsx:284` の 1 か所［事実］。§10.2 の route の変更は両方に効く。`version` を送る変更もこの 1 か所 |
| メモの読み手 | `GET /api/worktrees`（`route.ts:112`）と `GET …/instances/notes`。形を変えない |
| 型の写し `src/cli/types/` | `api-responses.ts` に `sessionNotes`・`SessionNote` の語は無い［事実：grep 0 件］。CLI はメモを読まないので写しは無い。`mem` の型は `src/cli/types/` に新しく置く |
| ja / en の説明 | `docs/user-guide/cli-operations-guide.md` は ja。en の対は `docs/en/` 側［未確認：ファイル名］ |
| 設計書を固定するテスト | `tests/unit/docs/design-doc-identifier-audit.test.ts` は `docs/design/multi-agent-state-architecture.md` だけを見る。この文書は対象外［事実］ |

---

## 15. 未確認・未決（レビューで見てほしい点）

| # | 内容 |
|---|---|
| U1 | `RepositoryList` の開く行（roles）がスマホの幅で開けるか。D3 は PC・スマホの両方を求める |
| U2 | `Sec-Fetch-Site` を付けない古いブラウザ・WebView（PWA）で画面の書き込みが断られないか。付かないときに `Origin` だけで通すかを実装の前に決める |
| U3 | repository の登録を消して付け直すと新しい ID（`randomUUID`、`db-repository.ts:193`）になり、前の項目が見えなくなる。common-dir での引き継ぎを足すか、purge だけを用意するか |
| U4 | detached の項目は `origin_worktree_id` で絞るので、worktree ID の改名（v54/v55）で見えなくなる。detached を書き込み禁止にする案もある |
| U5 | `session_generation`（#4115）はメモリ上にしかなく（`role-launch.ts:28-33`）、再起動の後は NULL になる。D5 の「セッションの世代」は `mem_instance_incarnations` を主にし、`session_generation` は補助にした |
| U6 | §8.1 の件数・§8.2 の日数・§6 の上限は初期値の見立て。実運用の引き継ぎ（Epic の背景の 20KB）から逆算していない |
