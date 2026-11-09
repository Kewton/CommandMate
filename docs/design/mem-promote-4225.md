# 人が差分を承認して decision を正本へ記録し、反映を確かめる（Issue #4225 / Epic #4220 の子 E）設計

- 状態：設計の段（第 3 版、実装前）。第 1 版の「止める点」は PM が決めた（§0.1）。第 3 版は Codex の事前レビュー（P1 2・P2 5）を反映した（処置は §9）。再確認（2 回目、P1 1・P2 1）も反映した（§9.2）。再確認（3 回目、P2 2）も反映した（§9.3）。実装済み（実装で実コードを正とした点は §10、共通規則の全読者は §11）
- 前提：Epic #4220 の決定事項 D1〜D13（とくに D3・D6・D9・D11・D12）。A（#4221）`docs/design/mem-store-4221.md`（以下「A」）、B（#4222）`docs/design/mem-close-when-4222.md`（「B」）、C（#4223）`docs/design/brief-4223.md`（「C」）、D1（#4274）`docs/design/session-boundary-brief-4274.md`（「D1」）。D2（#4224）は並行で設計中で、この文書は触れない
- 凡例：**［事実］** = この文書を書いた時点（2026-11-09、`feature/4225-worktree` = develop `64572168c`）でファイルと行を読んで確かめたもの。**［見立て］** = 設計としての判断。**［未確認］** = 読んでいない・実測していないもの。行番号は確認時点のもので、実装の契約では名前で探し直す

---

## 0. 冒頭

### 0.1 決定（第 1 版の「止める点」への PM の答え、2026-11-09）

第 1 版は、契約の「止める条件」に当たる点を S1〜S3 として挙げて止めた。PM の決定（`workspace/orchestration/runs/2026-11-08/pm-return-4225-stop.md` の末尾）は次のとおり。

| # | 止めた点 | 決定 | この文書への反映 |
|---|---|---|---|
| **S1** | decision を `open → recorded`・`recorded → promoted`・`open → promoted`（記録だけ）へ進める store の書き込みが無い。`src/lib/db/mem-db.ts` の書き込みの export（`createMemItem`・`updateMemItem`・`closeMemItem`・`closeMemItemByCondition`・`replaceNowSlot`・`writeScreenNote`・`purgeMem` 等、`mem-db.ts:659`・`:867`・`:923`・`:1060`）に遷移の関数が無く、A は `recorded`/`promoted` の検査だけを先に置いた（A §3.2、`transitions.ts:51-56`）。A の試験が「store の書き込みは service からだけ」（`write-entrances-recreate-4221.test.ts:290-295`）と「store の書き込みに届く service の export はすべて `ENTRANCES` にある」（`:274-285`、A §16 I17・I18）を固定している［事実］ | **案 1 を採る。** A の `mem-db.ts` に `transitionDecision` を 1 つ、`src/lib/mem/service.ts` に入口を 1 つ足し、`write-entrances-recreate-4221.test.ts` の `ENTRANCES` に行を足す。既存の行・`it`・期待値・関数の振る舞いは変えない（足すだけ）。**条件**：足した入口も既存の 3 つの不変条件（作り直した後の古い要求の拒否・mode `off`/`derived` で書かない・版の食い違いを断る）を表の行で確かめ、直しを外すと落ちる陽性の対照を置く。理由：不変条件を 1 つの表に保つ（#4222・#4223 も同じ形で通した） | §6.3（変える既存のファイル）、§7（`ENTRANCES` の行と対照）。採らなかった案 2 は §8.3 |
| S2 | 人が画面で `recorded` の decision を閉じる遷移が無い（A §3.2 は「人が画面で閉じる」と書くが、`transitions.ts:45-48` は `recorded` の `close` を誰に対しても断る）［事実］ | **G（#4227）へ送った**（PM が #4227 にコメント済み）。E では作らない | E の `recorded` は「反映を確かめる」（→ `promoted`）か、残して警告を出し続けるかのどちらか。`transitions.ts` は E で変えない |
| S3 | 「未反映の警告」を CLI の一覧（`src/cli/commands/mem.ts:169`）と brief（`src/lib/brief/sources.ts:452`・`:479`）にも文言で出すか。両方とも既に `recorded` を区別して出し、古さ（`staleness.ts:19`・`:26`）も `recorded` にかかる［事実］ | **G（#4227）へ送った**。E では変えない | Issue の「警告」は E の画面（§4）と E の API の応答の欄（`unreflected:true`）で出す |

D1〜D13 と違う作りは採らない（D9 のとおり）。

**事前レビューの後の確認（止める点ではない）**：事前レビューの指摘で A のファイルの変更は S1 の案 1 より広がらない（③ は入口の引数に「比較する元の世代」を明示するだけで、関数は 1 つ・入口は 1 つのまま。⑦ の検査は E の新しい試験のファイルに置き、A の試験は変えない）。ただし ① の処置で、受入基準「承認の後に別のセッションが文書を変えた：既存の変更を失わず、**再承認へ戻る**」のうち **再承認へ戻る** は、書く直前の最後の照合より前の変更に限られる（最後の照合と追記の間の同期の窓に入った他プロセスの変更は、失われないが再承認にはならず、`concurrent_edit` の印つきの成功として人に見せる。§3.3）。**既存の変更を失わない** は窓の中でも保つ。この読みで受入基準を満たすとしてよいか、PM に確かめてほしい（§9 ①）。

### 0.2 D・A・B・Issue の文面だけでは一意に決まらず、この文書が選んだ解釈

| # | 文面 | 選んだ解釈 | 理由 |
|---|---|---|---|
| E1 | D3「off は何も評価・更新しない」と、外へ書いた後の結果の記録 | 承認・書く操作の **開始**（preview・approve）は mode `on` だけ。**既に外へ出た操作の結果（attempt の確定・照合）は mode に関係なく記録する**。項目の状態の遷移（`recorded`・`promoted`）は `on` のときだけ | 外へ書いた事実を記録しないと、`on` に戻した後に二重に書く。B の `settle` が `off` でも `reserved` を `pending` に戻すのと同じ考え方（B §4 の 3）。項目は変えないので「off の間に閉じたことにする」記録は作らない |
| E2 | Issue「承認の後に項目が変わったら、承認を取り消して再承認を求める」 | 承認は **preview（差分）1 件に結ぶ**。preview は項目の `version` を持ち、書く直前に一致しなければ書かずに 409 `reapproval_required`。承認を DB の上で「取り消す」行は作らず、照合の不一致で無効になる（版で決める、A §3.2 の注・B §5） | 取り消しの行を別に持つと、項目の更新の経路（A の service）すべてに E を呼ばせる必要があり、A のファイルを広く変える |
| E3 | Issue「無人のときは未承認のまま残す」と D11「無人かどうかは人が選ぶ設定」 | E の書き込みは **画面の承認の要求（§4 の印つき）の中でだけ** 始まる。ほかの起点（brief・check・F の促し・Schedule・dreaming）から E の書き込みを呼ぶ口を作らない。無人の設定（G）は読まない | 起点が画面の要求しか無ければ、無人の経路で書くことは構造として起きない。D11 の設定は G の範囲 |
| E4 | Issue「コメントは決定の記録であり、反映ではない」 | 承認のときに人が **効果** を選ぶ：`spec`（仕様を変える。書けたら `recorded`）／`record_only`（記録だけ。書けたら `promoted`）。既定は `spec`（未反映として残す側に倒す） | 選ばせないと、Agent が書いた decision が黙って `promoted` になりうる。`record_only` は「人が選んだ」ときだけ |
| E5 | Issue「文書の行き先：書くのは作業木への変更まで」 | 作業木の文書への書き込みも、`spec` なら `recorded` に留まる（commit されていない文書は正本ではない）。人が commit を含めて反映を確かめてから `promoted` | 作業木の変更は消えうる（worktree の削除・`git checkout`）。CommandMate は commit しない |

---

## 1. 状態の遷移と A・B との整合

### 1.1 decision の状態（A §3.2 の表を E の操作で埋める）

| 現在 | きっかけ（E） | 次 | 誰が | mode | 根拠［事実］ |
|---|---|---|---|---|---|
| `open` | 人が画面で承認（効果 `spec`）し、操作が **成功** した | `recorded`（`version+1`） | 人（画面）だけ | `on` | `memTransition('decision','open','record')` → `recorded`（`transitions.ts:51-52`） |
| `open` | 人が画面で承認（効果 `record_only`）し、操作が成功した | `promoted`（`version+1`） | 人（画面）だけ | `on` | `'promote-record-only'` → `promoted`（`transitions.ts:55-56`）。A §3.2 の「`recorded` を経て」は 1 回の遷移として書く（中間の行を残さない）［見立て］ |
| `recorded` | 人が画面で「正本へ反映した」を確かめた | `promoted`（`version+1`） | 人（画面）だけ | `on` | `'promote'` → `promoted`（`transitions.ts:53-54`） |
| `open` | 承認の拒否・取り消し・期限切れ・操作の失敗・不明 | **変わらない**（`open`） | — | — | Issue「未承認のまま残す」 |
| `promoted` | B の条件の成立／人の close | `closed` | サーバ／人 | `on` | A・B のまま（`transitions.ts:47`・`:50`）。E は触らない |
| `open`・`recorded` | B の条件が成立 | 変わらない（`unreflected:true` を出すだけ） | — | — | `transitions.ts:49-50`（`condition` は `promoted` だけ）、`evaluate.ts:443`（decision に `unreflected`）、B §5 |
| `recorded` | `mem close`（CLI）・`mem update` | 断る（55 `state_forbids`） | — | — | `transitions.ts:45-48`・`:43-44`（`update` は `open` だけ） |

- decision の `close_when` は既定で `NULL`（`close-when.ts:44-50`：`promoted` は NULL を保存し、遷移でだけ閉じる）。`evaluate.ts:165` は `closeWhen === null` を評価しないので、既定の decision は `promoted` になっても条件では閉じず、人が閉じる［事実］
- E の遷移はすべて `version+1` する。B の close は照会の前に固定した `version`・`close_when` が transaction の中で同じときだけ書く（`closeMemItemByCondition`、`mem-db.ts:1060-1086`）ので、E の遷移が B の照会の `await` の間に入れば B はその回は閉じない。E が先に読んだ版と違えば E は書かない（B §5 の「競合の決まり」と同じ）
- `promoted` の後の B の close と、E の「反映を確かめる」の競合：E は `recorded` の版を照合するので、`recorded` のときに B は閉じない（上の表）。競合は起きない

### 1.2 E の操作（operation）の状態

項目の状態とは別に、外へ書く操作を持つ（§3）。**承認の有効さ（preview・approval）と配送の確定（attempt の結果）を分ける**。

```
preview（差分。期限つき）
   └─ approve（画面の要求）→ operation: approved
                                  └─ claim → in_flight（attempt 1 件）
                                        ├─ success   → succeeded → 項目の遷移（§1.1）
                                        ├─ failure   → failed（未送信が確定。再承認で新しい operation）
                                        └─ unknown   → unknown（自動で再送しない。照合へ、§3.4）
                                                         ├─ 照合で見つけた → succeeded
                                                         └─ 見つからない・確定できない → unknown のまま（人に照合を求める。人が「無いことを確かめた」で abandoned）
   書く直前の照合の不一致 → operation を作らない（書いていない。再承認へ、§2.3）
```

- `succeeded` の後に項目の遷移が書けなかった（項目の版が変わった・mode が `on` でない・context の worktree が作り直された・DB の更新が失敗した）ときは、operation に `transition_pending=1` と理由の語を残す。**`transition_pending=1` の operation は「進行中」として排他に入る**（§6.1 の一意の部分索引、事前レビュー ②）。画面は「書けたが項目は進んでいない」を出し、人が「記録済みとして扱う」を押すと遷移だけを行う（外へは書かない）。そのとき今の項目の欄の指紋が operation に保存した `item_fingerprint` と違えば、書いた本文と今の項目の差分を画面に出し、要求に `acknowledgeDiff:true` が無ければ 409 `diff_not_acknowledged`（事前レビューの U7）
- **外への書き込みが成功した（`succeeded`・`transition_pending` のどちらでも）後は、その時刻より前に作った同じ項目の preview はすべて無効**（approve で 409 `prior_record_exists`）。同じ項目を記録し直すには、既にある記録（コメントの URL・文書のパスと区画）を並べた **新しい preview** を作り、その preview に「既にある記録の operation ID の一覧」（`acknowledged_operation_ids`）を結ぶ。approve は、今ある成功・不明の operation の集合がこの一覧と同じときだけ通す（事前レビュー ②）

---

## 2. 承認に結び付けるもの・書く直前の照合

### 2.1 preview（差分）が持つもの

preview は画面の要求（§4.2 の印）で作り、DB に保存する（`mem_promote_previews`、§6.1）。承認は preview の ID と、画面が表示した指紋を送り返す。

| 欄 | 中身 | 何の変化を見るか |
|---|---|---|
| `item_id`・`item_version` | 項目と、差分を作ったときの版 | 承認の後の項目の変更（Agent の `mem update`・人の編集・B の close）［`updateMemItem` は `version+1`、`mem-db.ts:905`］ |
| `item_fingerprint` | 差分に使った項目の欄（`text`・`quote`・`quote_at`・`evidence`・`promote_to`）の SHA-256 と `checked_rules_version` | 版を上げない経路が将来できたときの保険（版と二重に見る）［見立て］ |
| `destination` | 正規化した行き先（§2.2） | 行き先の取り違え |
| `base_fingerprint` | 差分の基準にした行き先の内容の指紋（§2.2） | 承認の後に他のセッション・人が行き先を変えた |
| `body` と `body_sha256` | 書く本文そのもの（§5.4 の検査の後） | 画面が見せた本文と書く本文の一致。書くのは保存した `body` で、承認の要求からは本文を受け取らない |
| `effect` | `spec` / `record_only`（E4） | — |
| `quote_origin` | `agent`（Agent が記録した引用のまま）／`human`（人が画面で確かめた）（§5.1） | — |
| `rules_version` | `MEM_SECRET_RULES_VERSION`（`secret-scan.ts:21`） | 規則が上がった後の承認は検査し直す |
| `context_worktree_id`・`context_worktree_incarnation` | 画面を開いた worktree とその世代（`getWorktreeIncarnation`、`incarnation.ts:137`） | 作り直し後の古い要求（A §16 I17 と同じ不変条件） |
| `created_at`・`expires_at` | 期限（初期値 30 分［見立て］） | 期限切れ |
| `acknowledged_operation_ids` | preview を作った時点で同じ項目にある `succeeded`・`unknown` の operation の ID の一覧（画面に既にある記録として並べたもの） | 承認の後・別の画面で外への書き込みが成功した（事前レビュー ②） |
| `poster`（コメントのみ） | preview の時点の `gh api --hostname <host> user` の `id`（数値）と `login` | 承認と書き込みの間の認証アカウントの切り替え（事前レビュー ⑤。§3.2） |

### 2.2 行き先と基準の指紋

| 行き先の種類 | `destination`（正規化） | `base_fingerprint` | 照合で見るもの |
|---|---|---|---|
| Issue・PR のコメント（`issue:[host/owner/repo]#N`・`pr:…#N`。文法は A `validate.ts` の `ISSUE_REF`） | `{kind:'issue_comment', host（小文字）, owner, repo, number}`。**この host を preview の照会・POST・コメントの一覧・投稿者の照会のすべてで `--hostname` に渡す**（事前レビュー ⑤）。target を省いた `issue:#N` は項目の repository の `origin` で解決する（B §1.2 と同じ解決）。host は `hostAllowed`（`github-query.ts:63`：`github.com` か `origin` の host）を通るものだけ | `gh api repos/{o}/{r}/issues/{N}` の `node_id`・`repository_url`・`state`・`locked`・本文の SHA-256 | Issue が別のものになった（移管・削除して同じ番号）、閉じた・ロックされた、本文が変わった。**他人のコメントの増減は見ない**（コメントは追記で、既存の内容を上書きしない） |
| 作業木の文書（`path:<rel>`） | `{kind:'worktree_doc', repositoryId, branch, worktreeId, worktreeIncarnation, path（正規化後の相対）}`。worktree は人が画面で選ぶ（項目の repository の登録 root に属する worktree だけ、`withMemTarget` の `readRepositoryIds` に項目の `repository_id` が入るもの、`target.ts:116`） | ファイルの内容の SHA-256（無いときは `absent`）・大きさ・観測した HEAD のブランチと common-dir（`observeWorktreeHead`、`git-observe.ts:23`） | 承認の後に文書が変わった、worktree を消した・作り直した（世代の不一致）、別のブランチへ切り替えた、別の git になった |

### 2.3 書く直前の照合（approve の手順）

1. 画面の印（§4.2）を確かめる。無ければ 403 `screen_only`（書かない・数えない）
2. 要求を受けた時点で、context の worktree の世代と、文書なら行き先の worktree の世代を固定する（A §10.4 と同じ型）。**この固定した世代を operation の行（`context_worktree_incarnation`・`destination_worktree_incarnation`）に保存し、外への書き込みの後の A の入口へそのまま渡す**（§3.5、事前レビュー ③）
3. 文書の行き先なら `observeWorktreeHead` で HEAD を観測する（`await`）。コメントなら `gh api --hostname <host>` で Issue と投稿者（`user`）を読む（`await`、§2.2）
4. **同期の区間**（better-sqlite3 は同期なので他の要求は入らない、A §5.3）で次をすべて照合する。1 つでも違えば **何も書かず**、operation を作らず、409 `reapproval_required`（`reason` を 1 語：`item_changed`・`destination_changed`・`base_changed`・`worktree_recreated`・`branch_changed`・`expired`・`mode_not_on`・`rules_changed`・`withheld`・`prior_record_exists`・`poster_changed`）を返し、preview を無効にする
   - preview が期限内・未使用、項目の今の版が `item_version` と一致、`item_fingerprint` が一致、項目が `open`（`spec`・`record_only`）
   - 項目の `(repository_id, branch)` の mode が `on`（`memModeOnFor`、`mem-close-db.ts:99`。曖昧・未登録は `on` ではない）
   - 項目が今の規則で withheld でない（`findWithheld`、`present.ts:70`）
   - context・行き先の worktree の世代が固定した値と同じで、今も生きている（`worktreeIncarnationAlive`、`incarnation.ts:170`）
   - 文書：手順 3 の HEAD のブランチ・common-dir が preview と同じ。ファイルの内容の SHA-256 を **この区間で同期に読み直して**（`fs.readFileSync`）`base_fingerprint` と一致
   - コメント：手順 3 の Issue の指紋が `base_fingerprint` と一致
   - 同じ項目に進行中（`approved`・`in_flight`・`unknown`、`succeeded` かつ `transition_pending=1`）の operation が無い（一意の部分索引でも守る、§6.1）
   - 同じ項目の `succeeded`・`unknown` の operation の集合が preview の `acknowledged_operation_ids` と同じ（違えば `prior_record_exists`、§1.2）
   - コメント：投稿者（`gh api --hostname <host> user` の `id`）が preview の `poster.id` と同じ（違えば `poster_changed`）
5. 同じ区間で operation（`approved`）と attempt（`in_flight`、`boot_id` = 今の process）を INSERT し、preview を使用済みにする
6. 外へ書く（§3.2・§3.3）。結果で attempt を確定する（§3.4）

- コメントの照合（手順 3）と書き込み（手順 6）の間には `await` がある。その間に Issue の本文が変わっても、コメントは追記なので既存の内容を失わない（受入基準の「既存の変更を失わない」は満たす）
- 文書は手順 4 で同期に読み直し、手順 6 は **追記だけ**（`O_APPEND`、§3.3）で行う。CommandMate の中の別の要求は入らない。別のプロセス（別の Agent・エディタ）が手順 4 と 6 の間に書いても、E は文書の内容を置き換えないので **他者の変更は失われない**（事前レビュー ①。第 2 版の一時ファイル＋`rename` は、最後の読みの後の他者の変更を古い内容で上書きしうるので採らない）
- 同じ項目を 2 つの画面で並行に承認：先に手順 5 へ着いた方だけが operation を作る。後の方は「進行中の operation がある」か「版の不一致」で 409。既存の変更は失わない

---

## 3. 外へ書く操作：operation／attempt と結果が不明なとき

### 3.1 原則

- **不明を未送信として扱わない**。自動の再送はしない。再送は「失敗が確定した」か「照合で書かれていないと確定した」後の、**新しい承認**（新しい preview → 新しい operation）だけ
- 1 つの operation の attempt は原則 1 回。照合（§3.4）は attempt ではない（外へ書かない）
- 成功の地点：コメントは **作成の応答で ID を得たとき**、または **印の照合で見つけたとき**。文書は **書いた内容を読み直して一致したとき**

### 3.2 Issue のコメント

- 本文の末尾に一意の印を入れる：`<!-- commandmate-promote:op=<operation id>; item=<item id> -->`（operation id は `randomUUID`）
- 投稿の主体：approve の手順 3 で、**最初に 1 回だけ** `gh auth token --hostname <host>` で認証情報（token）を取り出し、以後の投稿者の確認（`gh api --hostname <host> user`）と POST の **2 つの呼び出しの両方に同じ token を環境変数で渡す**（**host で変数を選ばない**：gh が読む 4 つの変数 `GH_TOKEN`・`GITHUB_TOKEN`・`GH_ENTERPRISE_TOKEN`・`GITHUB_ENTERPRISE_TOKEN` の **すべてに同じ token** を入れて渡す。gh は `github.com`・`*.ghe.com`（と `github.localhost`）では `GH_TOKEN`/`GITHUB_TOKEN` を、それ以外の Enterprise Server では `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` を読む［事実：gh の `help environment`・go-gh `pkg/auth`。再確認 3 回目 P2-1］ので、どの分類の host でも固定した token が使われる。E が host の分類を持たないので、gh の分類と食い違う枝が無い。gh は環境変数の token を保存済みの認証より先に使う［実測は U11］）。これで、確認と POST の間に `gh auth switch`・`gh auth login` で有効なアカウントが変わっても、POST は確認した主体で行われる（再確認 P2）。token は子の環境にだけ置き、DB・ログ・応答・引数に出さない。`user` の `id`（数値。login は変わりうるので照合に使わない）が preview の `poster.id` と同じことを確かめ、operation の `poster_id` に保存してから POST する。token が取り出せない・`user` が読めない・`id` が違う、のどれでも POST しない（`failure`／409 `poster_changed`、送っていない）。作成の応答の `user.id` が `poster_id` と違えば `unknown`（`poster_mismatch`、人へ。token を固定しているので起きない想定の検査）（事前レビュー ⑤）
- 照合（§3.4）は投稿の後のアカウントの切り替えに備え、今の認証の token で読み、`poster_id` で突き合わせる（照合は読みだけなので主体を固定しない）
- 送り方：`gh api --method POST --hostname <host> repos/<o>/<r>/issues/<N>/comments --input -`（本文は JSON で stdin。引数に本文を載せない）。実行の口は E の新しい関数（`ghApi` は GET だけで、本文を渡す口が無い、`github-query.ts:50-53`［事実］）。`hostAllowed`・`repoPath`（`github-query.ts:55`）は再利用する
- 応答の分類（`classifyGhFailure`、`github-query.ts:18` の語を再利用し、E で「確定した失敗」と「不明」に分ける）［見立て］：

| 結果 | attempt | operation |
|---|---|---|
| exit 0 で JSON に `id`・`html_url`・`node_id` がある | `success`（`result_ref` = comment id と URL） | `succeeded` |
| HTTP 4xx（401・403・404・410・422。408・429 を除く） | `failure`（GitHub は作っていない） | `failed` |
| `gh` が無い（`missing`）・host の不許可・本文の検査の不合格（送る前） | `failure`（送っていない） | `failed` |
| タイムアウト・中断・offline・HTTP 5xx・408・429・`overflow`・exit 0 だが JSON が読めない | `unknown` | `unknown` |
| attempt を書いた process が無い（`boot_id` が違う）か、`in_flight` のまま一定時間（10 分、B の `MEM_NOTICE_ATTEMPT_STALE_MS` と同じ値、`mem-close-db.ts:37`）を過ぎた | `unknown`（読むときにそう扱い、次の書き込みの区間で確定させる） | `unknown` |

- **GitHub が受理した後に応答が切れた**：`unknown` になり、照合（§3.4）で印を見つけて `succeeded` にする。再送しない
- **書けた後の DB の更新が失敗した**：attempt は `in_flight` のまま残る（DB の行は書く前に作ってある、§2.3 の 5）。同じ process の中では例外を握って `unknown` に落とす試みを 1 回だけする。それも失敗すれば、次に読んだときに古い `in_flight` として `unknown` に見え、照合で見つかる
- **並行の再試行**：進行中の operation の一意の部分索引（§6.1）と、`in_flight` の attempt が 1 件だけであること（`attempt` の INSERT は operation の状態を `approved`→`in_flight` に変える同じ文で条件つき）で、2 つ目の要求は 409 `operation_in_progress`

### 3.3 作業木の文書

- 書き方：既存の文書の末尾に、印つきの区画を **追記だけ** する。区画は `<!-- commandmate-promote:begin op=<operation id> sha256=<区画の本文の SHA-256> -->` で始まり、`<!-- commandmate-promote:end op=<operation id> -->` で閉じる。E は文書の既存の内容を読み直して比べるが、**書き換え・置き換え・切り詰めをしない**［見立て：最小の差分。見出しの下へ差し込む形は採らない。差し込みは内容の置き換えになり ① の保証が崩れる］。拡張子は `.md` だけ、大きさは 1 MiB まで［見立て］
- 手順（すべて §2.3 の 4 と同じ同期の区間）：
  1. §5.3 のパスの検査を **もう一度** 行う（承認から時間が経っている）
  2. 内容を読み直し、`base_fingerprint` と一致を確かめる（§2.3 の 4。違えば書かずに再承認）
  3. **既にあるファイル**（`base_fingerprint` が `absent` でない）：`O_WRONLY|O_APPEND|O_NOFOLLOW` で開く。開いた記述子を `fstat` し、通常のファイル・`nlink === 1`・開く前の `lstat` と同じ `dev`/`ino` であることを確かめる（hardlink を通して repository の外のファイルへ書かない。最後の成分の symlink は `O_NOFOLLOW` が断る）。区画を 1 回の `write` で追記し、`fsync` して閉じる
  4. **新しく作るファイル**（`base_fingerprint` が `absent`）：空のファイルを作ってから書く形にしない（作った後・書く前に他者が同じファイルへ書くと、位置 0 からの `write` で他者の内容を上書きする。再確認 P1）。代わりに、同じディレクトリに operation の ID から決めた名前の一時ファイル（`.commandmate-promote-<operation id>.tmp`）を `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` で作って区画の全文を書き、`fsync` し、**`link(一時ファイル, 行き先)`** で行き先の名前を付ける。`link` は行き先が既にあれば（他者が先に作った・symlink を置いた）`EEXIST` で失敗し何も上書きしない（書かずに再承認）。成功した瞬間に行き先は区画の全文を持って現れるので、空のファイルが見える窓が無い。その後に一時ファイルの名前を `unlink` し、行き先を `lstat` して通常のファイル・`nlink === 1`・一時ファイルと同じ `dev`/`ino` を確かめる。`link` の後に他者が行き先へ追記・置き換えしても E はもう書かないので、他者の内容は失われない。`link` が使えない（`EPERM`・`ENOTSUP` 等）ファイルシステムでは書かずに `failure`（送っていない）。一時ファイルが残った（`link` と `unlink` の間で process が終わった）ときの回収は次の **E の一時名の回収規則** で行う（再確認 3 回目 P2-2）
  - **E の一時名の回収規則**：行き先と同じディレクトリの `.commandmate-promote-<id>.tmp` のうち、`<id>` が DB にある E の operation の ID で、その operation の行き先（worktree の root と相対パス）が今の行き先と同じものだけを候補にする。候補を `lstat` して通常のファイルであり、(i) 行き先を `lstat` した `dev`/`ino` と同じ（`link` の後に終わった。同じ inode の 2 つ目の名前なので、名前を消しても内容は行き先に残る。**他者が行き先へ追記していて中身が区画の全文と一致しなくても回収する**）か、(ii) 行き先と別の inode で、`nlink === 1`・中身が operation の区画の全文と完全に一致する（`link` の前に終わった）とき、その名前だけを `unlink` する。それ以外（DB に無い ID・別の行き先の operation・別の inode で中身が違う・symlink・ディレクトリ）は触らない。回収は照合（§3.4）と、同じ行き先への **既にあるファイルの追記の前**（3 の `lstat`/`fstat` の `nlink === 1` の検査の前）に、同じ同期の区間で行う。これで「`link` の後に終了 → 他者が追記 → 照合 → 別の項目の追記」が `nlink === 2` で止まらず通る。無関係な hardlink（他者が作った別名・回収規則に当たらない名前）は回収しないので、`nlink === 1` の検査で今までどおり断る
  5. 読み直す：内容が「基準の内容＋区画」（新しく作ったときは区画だけ）と一致すれば `success`。一致しないが、§3.4 の区画の照合で自分の区画がちょうど 1 つ、本文の SHA-256 も一致して見つかれば、`success` に `concurrent_edit=1` を付ける（最後の照合と追記の間に他者が書いた。他者の変更は残っている。画面に「書いている間に他の変更があった」と出し、人に文書を見てもらう）。区画が見つからない・壊れていれば `unknown`
- 例外で途中が分からなくなったとき（process の終了を含む）は §3.4 の文書の照合で決める。文書全体の一致・不一致では決めない（事前レビュー ④）
- commit・add・push・stash・checkout など git の書き込みは呼ばない（§5.4、ガードで固定）

### 3.4 不明のときの照合（reconcile）

- 画面の「照合する」（印つきの要求）でだけ行う。読むたびの自動の照合はしない（外への照会の回数を増やさない。常駐・定期の実行を足さない、D8・D13）［見立て］
- コメント：`gh api --hostname <operation の host> --paginate repos/<o>/<r>/issues/<N>/comments`（GET）で、**本文に印があり、`user.id` が operation の `poster_id`（POST の前に保存した投稿者、§3.2）と同じで、本文の SHA-256 が operation の `body_sha256` と同じ** コメントを探す。照合の時点の `gh api user` は使わない（投稿の後に認証アカウントを切り替えても、元のコメントを認識する。事前レビュー ⑤）。見つかれば `succeeded`（`result_ref` を写す）。印を写した他人のコメントは `user.id` で外れる
  - 印と投稿者は一致するが本文の SHA-256 が違う：`unknown`（`body_differs`）のまま。画面に両方を出して人に判断を求める（自動で成功にも未送信にもしない）
  - 照会が失敗（offline・403 等）：`unknown` のまま。画面に「照合できない」と理由を出す
  - 照会は成功したが見つからない：**`unknown` のまま**（GitHub の一覧の反映の遅れを否定できない）。画面は「見つからない」と時刻を出し、人が「GitHub で無いことを確かめた」を押したときだけ operation を `abandoned`（人の判断で未送信とみなす、`decided_by='human'`）にする。その後は新しい承認でだけ書ける
- 文書：今の内容から operation の印の区画（`begin op=<id>` 〜 `end op=<id>`）を探す（事前レビュー ④）
  - 区画がちょうど 1 つあり、中身の SHA-256 が `begin` の行と operation の `body_sha256` に一致：`succeeded`（文書の他の部分が変わっていても。他者の追記と、E の書き込みの成功の証拠を分ける）
  - 区画が 2 つ以上・`begin` だけ・中身の指紋が違う（壊れた・直された）：`unknown`（`block_altered`）のまま、人へ
  - 区画が無い：`unknown`（`block_missing`）のまま、人へ。内容が `base_fingerprint` と一致していても、書いた後に人が消した場合と区別できないので、**未送信と読まない**。人が「無いことを確かめた」を押したときだけ `abandoned`
  - 読めない（worktree が消えた・パスの検査に通らない）：`unknown`（`unreadable`）のまま
- 照合で `succeeded` に確定したら、§3.5 の手順（operation に保存した世代・版を A の入口へ渡す）で遷移を試みる。合わなければ `transition_pending=1`

### 3.5 外への書き込みの後の項目の遷移（世代の受け渡し、事前レビュー ③）

- approve の手順 2 で固定した context の worktree の世代（`context_worktree_incarnation`）と項目の版（`item_version`）を operation に保存し、外への書き込みの成功の後（同じ要求の続き、または reconcile の成功の後）に、**その保存した値を** A の入口 `memSettleDecisionTransition` の引数（`expectedWorktreeIncarnation`・`expectedVersion`）として渡す。A の入口は渡された値と今の値を照合するだけで、自分で世代を固定し直さない（固定し直すと、外への書き込みの `await` の間の作り直しを見逃す）
- 照合が合わない（`incarnation_changed`・`version_conflict`・`disabled`）とき：外への書き込みの結果（`succeeded`・`result_ref`）だけを保存し、`transition_pending=1` と理由を残す。遷移は人の「記録済みとして扱う」（新しい画面の要求。その要求の時点で世代と版を固定する）でだけ行う
- `unknown`・`transition_pending=1` の operation と、それが使った preview は保持の期限で消さない（§6.1）

---

## 4. 画面（最小の 1 画面）と「変える経路は画面だけ」

### 4.1 画面

- ページ：`/repositories/[id]/mem/decisions?branch=<name>`（新規、`src/app/repositories/[id]/mem/decisions/page.tsx`）。PC・スマホ共通（`useIsMobile` で並びだけ変える、A §11.1 と同じ作り）。`/repositories` の行の mem の設定（`RepositoryMemSettings`）から開く
- 部品：`src/components/mem/DecisionPromotePanel.tsx`（新規。G #4227 の画面はこの部品を使う）。1 画面に次だけを置く：
  1. その branch の decision の一覧（`open`・`recorded`。`recorded` には **「未反映：コメントに記録しただけで、正本（Issue の本文など）へはまだ反映されていません」** の警告。進行中・不明の operation があればその印）
  2. 選んだ項目の preview：行き先（種類・host/owner/repo/#N、または worktree・ブランチ・パス）、書く本文の全文（差分）、引用の出所の表示（§5.1）、効果の選択（`spec`／`record_only`、既定 `spec`）、期限
  3. ボタン：「承認して書く」・「やめる」（何も書かない。preview を捨てる）・`recorded` なら「正本へ反映したことを確かめた」・`unknown` なら「照合する」と「無いことを確かめた」（コメントは GitHub、文書は作業木で）・`succeeded` で `transition_pending` なら「記録済みとして扱う」
- 409 `reapproval_required` を受けたら、理由の語を出して preview を作り直す（自動で承認し直さない）

### 4.2 書き込みの API と印

| API（新規） | 印 | 中身 |
|---|---|---|
| `POST /api/repositories/:id/mem/decisions/:itemId/preview` | 要る | `{branch, destination?, worktreeId?, effect, quoteConfirmed?, quoteText?}` → preview（本文・指紋・期限） |
| `POST …/:itemId/approve` | 要る | `{previewId, itemVersion, baseFingerprint, bodySha256, acknowledgedOperationIds}`（画面が見たものを送り返す。本文は受け取らない）→ §2.3 |
| `POST …/:itemId/confirm-reflected` | 要る | `{ifVersion}` → `recorded → promoted` |
| `POST …/operations/:opId/reconcile` | 要る | — → §3.4 |
| `POST …/operations/:opId/abandon` | 要る | `{ifState:'unknown'}` → `abandoned` |
| `POST …/operations/:opId/settle-transition` | 要る | `{ifVersion, acknowledgeDiff?}` → `transition_pending` の遷移だけ（その要求の時点で世代と版を固定する、§3.5）。項目が closed・purge 済みなら `{acknowledgeItemClosed: true}` で遷移なしに遷移待ちだけを終える（5-2c P2-3）。操作の所属は同じ Git の root の範囲（5-2c P2-2、reconcile・abandon も同じ） |
| `GET /api/repositories/:id/mem/decisions?branch=` | 要らない（読み） | 一覧・operation の状態 |

- 印は A §11 の `isScreenRequest`（`src/lib/security/screen-request.ts:52`）をそのまま使う（`X-CommandMate-Client: screen` と `Origin` の一致）。画面の client は `screenRequestHeaders()`（`:28`）を付ける。書き込みの route は印が無ければ 403 `screen_only`（`settings-service.ts:37`・notices の acknowledge の route と同じ）
- **CLI に口を作らない**：`commandmate mem` に promote・approve・confirm のサブコマンドを足さない。ガード `tests/unit/guards/mem-promote-screen-only-4225.test.ts`（新規）で `src/cli/**` が `mem/decisions` の書き込みと `X-CommandMate-Client` を持たないことを固定する（A の `mem-mode-write-screen-only.test.ts` の `modeWriteFinding` と同じ形。A の試験は変えない）
- 防げないこと（A §11.3 と同じ）：同じ OS 権限のプロセスは印を偽れ、DB を直接書ける。Agent に承認させないのは、口が無いことと skill（#4228）の指示であって保証ではない。この限界を ja・en の利用者向けの文書に写す（実装の契約）

---

## 5. 引用・パス・git・自由入力

### 5.1 引用の出所

- `mem_items.quote`・`quote_at` は **「Agent が記録した引用」**（A §6.1。Agent の CLI が書く）。preview の既定はこの出所のまま本文に出す：見出し `Agent が記録した引用（<quote_at>、未確認）`
- 人が画面で原文と照らして確かめたら「引用を確かめた」を選ぶ（任意で引用を直す。直した引用は `validateQuote`、`validate.ts:125` を通す）。そのときだけ見出しを `人が画面で確かめた引用（<確かめた時刻>）` にし、operation の `quote_origin='human'`・`quote_confirmed_at` に残す。`mem_items.quote` は書き換えない（Agent の記録を残す）
- どちらの引用も、Agent の言葉（`text`）と区画を分けて出す（D12）

### 5.2 本文の形（コメント・文書で共通）［見立て］

```
<!-- commandmate-promote:op=<uuid>; item=<id> -->
**CommandMate: 決定の記録**（<効果: 仕様を変える決定・反映待ち / 記録だけ>）
- 項目: <id> v<version>・ブランチ: <branch>・承認: 人（画面）<時刻>
- 書いたもの: Agent <instance>（<createdAt>）

決定（Agent の記録）:
<code fence>
<text>
</code fence>

<Agent が記録した引用 / 人が画面で確かめた引用>（<時刻>）:
<code fence>
<quote>
</code fence>
```

- 自由入力（`text`・`quote`）は **フェンスの中** に入れる。フェンスは行頭から始まる backtick の列で、長さは **`max(3, 中身の最長の連続した backtick + 1)`**（CommonMark のフェンスは 3 文字以上。第 2 版の「最長＋1」だけでは backtick の無い本文で長さ 1 になり、コードブロックにならなかった。事前レビュー ⑥）。中身の行のどの backtick の列もフェンスより短いので、中身からフェンスを閉じられない。空の本文は 1 行の空白にせず、空のブロックのまま出す。これで Markdown の差し込み、`@name` の通知、`#N` の自動リンクを起こさない（GitHub はコードの中の mention を通知しない［未確認：実測は実装の契約で fixture の Issue を使わずに文書で確かめる］）
- `evidence` は出さない（構造化した参照で、正本の読者に要らない）［見立て］

### 5.3 パスの正規化（文書の行き先）

1. `promote_to` の `path:` は A の検査（`validatePromoteTo`→`normalizeRepoPath`、`validate.ts:277`・`:185`）を **選んだ worktree の root で** もう一度かける：絶対パス・`~`・NUL・バックスラッシュ・ドライブ文字を断る、`..` で外へ出るものを断る、`findSensitivePathSegment` の当たる成分を断る、root から各成分を `lstat` して symlink を断る（`:213`）［事実］
2. E で足す検査（A の関数は変えない）：root 自身が symlink でない（root を `lstat` して通常のディレクトリ。実装で `realpath` の比較から変えた、§10）、`.git` の成分を断る、最後の成分が存在するなら通常のファイルである、拡張子が `.md`、大きさの上限。**`normalizeRepoPath` は promote_to で最初の無い成分で止まる**（`validate.ts:204-211`：`mustExist=false` なら `break`）ので、無いディレクトリの下は作らない（親ディレクトリが存在することを求める）［見立て］
3. 照合のたび（preview・approve・書く直前）に 1・2 をやり直す

### 5.4 commit・push をしない

- E のファイルは git の書き込み（`commit`・`add`・`push`・`stash`・`checkout`・`reset`・`restore`・`switch`・`merge`・`rebase`・`tag`）を呼ばない。git は `observeWorktreeHead` の読みだけ
- ガード `tests/unit/guards/mem-promote-no-git-write-4225.test.ts`（新規）：E のソースに git の書き込みの語が引数として現れないことと、`gh` の `--method` が `POST` のコメントの作成 1 か所だけであることを固定する
- 「この Issue が入るまで、どの経路からも外へ書かない」の確かめ：A〜D の側で `gh` を呼ぶのは `github-query.ts:52` の GET だけ（`args` に `--method` が無い）［事実］。ただし「外へ書かない」を名指しで固定する試験は見つからなかった［事実：`tests/unit/lib/mem`・`tests/unit/lib/brief`・`tests/unit/guards/mem*`・`brief*` を `--method`・`POST`・`comment` で grep して 0 件］。E のガードで、`src/` のうち E のファイル以外が `gh` に `--method` を渡さないこと・mem/brief の lib が `fs` の書き込み（`writeFile`・`rename`・`appendFile`）を持たないことを固定する（陽性対照：E のファイルの中の呼び出しが当たる）

### 5.5 自由入力の検査

| 入力 | 検査 |
|---|---|
| 項目の `text`・`quote`（保存済み） | 書く前に今の規則で読み直す（`findWithheld`、`present.ts:70`）。当たれば preview を作らない（`withheld`） |
| 人が直した引用 | `validateQuote`（A の検査：長さ・制御文字・双方向の制御・秘密らしい文字列） |
| 組み立てた本文の全体 | (1) `findSecretRule`（`secret-scan.ts:45`）、(2) C の見えない文字の置き換え `revealInvisible`（`sanitize.ts:88`。見えない code point を `[U+XXXX]` にする）を自由入力の部分にかける。置き換えが起きたら preview に「見えない文字を置き換えた」を出す（黙って書かない） |
| 行き先（`issue:`・`path:`） | A の `ISSUE_REF`・§5.3 |
| ログ | 出来事名・ID・行き先の種類・長さ・理由の語だけ。本文・引用・パスの絶対形は出さない（A §7 と同じ） |

- 限界：同じ OS 権限のプロセスは、途中のディレクトリを symlink に差し替える（U8）・DB の operation の行を書き換えて「成功」にする、ができる。CommandMate はこれを防がない（A §11.3）。**通常の並行編集**（別の Agent・エディタが文書を書く）は、E が追記だけをするので失われない（§3.3、事前レビュー ①）

---

## 6. 保存と実装の範囲

### 6.1 schema（`v69`、`src/lib/db/migrations/v69-mem-promote.ts`、`CURRENT_SCHEMA_VERSION = 69`。今は 68、`runner.ts:34`［事実］）

```sql
CREATE TABLE mem_promote_previews (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,                 -- FK なし（purge で消えても下の記録を残す）
  item_version INTEGER NOT NULL,
  item_fingerprint TEXT NOT NULL,
  repository_id TEXT NOT NULL, branch TEXT,
  destination TEXT NOT NULL,             -- §2.2 の JSON
  base_fingerprint TEXT NOT NULL,
  body TEXT NOT NULL, body_sha256 TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('spec','record_only')),
  quote_origin TEXT NOT NULL CHECK (quote_origin IN ('agent','human','none')),
  quote_confirmed_at INTEGER,
  rules_version INTEGER NOT NULL,
  context_worktree_id TEXT, context_worktree_incarnation TEXT,
  acknowledged_operation_ids TEXT NOT NULL,   -- JSON 配列（§1.2）
  poster_host TEXT, poster_id INTEGER, poster_login TEXT,  -- コメントのみ（§3.2）
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER, invalidated_reason TEXT
);

CREATE TABLE mem_promote_operations (
  id TEXT PRIMARY KEY,                   -- 印に入る operation id
  preview_id TEXT NOT NULL,
  item_id TEXT NOT NULL,                 -- FK なし
  item_version INTEGER NOT NULL,
  item_fingerprint TEXT NOT NULL,
  context_worktree_id TEXT, context_worktree_incarnation TEXT NOT NULL,  -- §3.5 で A の入口へ渡す
  destination_worktree_incarnation TEXT,                                 -- 文書のみ
  poster_id INTEGER,                                                     -- コメントのみ（§3.2）
  repository_id TEXT NOT NULL, branch TEXT,
  destination_kind TEXT NOT NULL CHECK (destination_kind IN ('issue_comment','worktree_doc')),
  destination TEXT NOT NULL, base_fingerprint TEXT NOT NULL,
  body TEXT NOT NULL, body_sha256 TEXT NOT NULL,
  effect TEXT NOT NULL, quote_origin TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('approved','in_flight','succeeded','failed','unknown','abandoned')),
  result_ref TEXT,                       -- comment id・URL / パスと SHA-256
  transition_pending INTEGER NOT NULL DEFAULT 0,
  transition_reason TEXT,                -- incarnation_changed・version_conflict・disabled・db_error
  transition_claim TEXT,                 -- 遷移を持つ要求の印（§11.1 I2、5-2d）。A の失敗はこの印を持つ要求だけが書く
  concurrent_edit INTEGER NOT NULL DEFAULT 0,  -- 文書：追記の間に他者の変更があった（§3.3）
  unknown_reason TEXT,                   -- body_differs・block_altered・block_missing・unreadable・poster_mismatch 等
  decided_by TEXT CHECK (decided_by IN ('server','human')),
  approved_at INTEGER NOT NULL, settled_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_mem_promote_active ON mem_promote_operations(item_id)
  WHERE state IN ('approved','in_flight','unknown') OR (state = 'succeeded' AND transition_pending = 1);

CREATE TABLE mem_promote_attempts (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES mem_promote_operations(id) ON DELETE CASCADE,
  boot_id TEXT NOT NULL,                 -- memServerBootId（process-boot.ts:19）
  started_at INTEGER NOT NULL, ended_at INTEGER,
  outcome TEXT CHECK (outcome IN ('success','failure','unknown')),
  reason TEXT                            -- 1 語（classifyGhFailure の語など）。本文・stderr は保存しない
);
CREATE UNIQUE INDEX idx_mem_promote_attempt_open ON mem_promote_attempts(operation_id) WHERE ended_at IS NULL;
```

- `mem_items` に FK を張らない理由：`purgeMem` は `mem_items` を DELETE する（`mem-db.ts:1005-1049`。既定で `recorded`・`promoted` の decision を除く、`:1025`）。CASCADE だと `unknown` の operation の記録が消え、再承認で二重に書きうる。RESTRICT だと A の purge が FK の失敗で落ちる。FK を張らず、項目が消えた operation は画面に「項目は削除済み」として残す［見立て］
- `worktree_id` という名前の列を持たない（`context_worktree_id` 等）。`deleteWorktreeChildRows` の対象にならず、worktree の削除を越えて残る（A §10.3 と同じ理由）
- 保持：`succeeded`（`transition_pending=0`）・`failed`・`abandoned` の operation と使った preview は 90 日、未使用の preview は期限の後に、次の書き込みの区間で消す（定期の実行を足さない）［見立て］。**`approved`・`in_flight`・`unknown`・`transition_pending=1` の operation と、それが使った preview は期限で消さない**（世代・版・投稿者の固定を失わない。事前レビュー ②・③）

### 6.2 新規ファイル（A〜D1 のファイルの外）

| ファイル | 中身 |
|---|---|
| `src/lib/db/migrations/v69-mem-promote.ts`・`runner.ts` の登録 | §6.1 |
| `src/lib/promote/model.ts` | 型（destination・effect・operation の状態） |
| `src/lib/promote/destination.ts` | 行き先の解決・§5.3 の検査・基準の指紋 |
| `src/lib/promote/render.ts` | §5.2 の本文（フェンス・`revealInvisible`・秘密の検査） |
| `src/lib/promote/github-write.ts` | コメントの作成（POST）・照合（GET）・結果の分類 |
| `src/lib/promote/doc-write.ts` | §3.3 |
| `src/lib/promote/service.ts` | preview・approve・confirm・reconcile・abandon・settle-transition。mem の項目の遷移は §6.3 の入口 `memSettleDecisionTransition` だけを呼ぶ |
| `src/lib/db/mem-promote-db.ts` | §6.1 の表の CRUD（`mem_items` は書かない） |
| `src/app/api/repositories/[id]/mem/decisions/**/route.ts` | §4.2 |
| `src/app/repositories/[id]/mem/decisions/page.tsx`・`src/components/mem/DecisionPromotePanel.tsx`・画面の client（`screenRequestHeaders` つき） | §4.1 |
| `docs/user-guide/`（ja・en）の mem の節 | 承認の流れ・`recorded` の意味・防げないこと |

- E のコードを `src/lib/mem/` の下に置かないのは、止める条件の「`src/lib/mem/**`」に当たらないため。代わりに A の常駐のガード（`mem-no-resident-4222.test.ts:29-52`）と同じ検査を `src/lib/promote/` にかけるガードを足す（`setInterval`・detached・`unref` を持たない。`execFile` の `timeout` は使う）［見立て］

### 6.3 変える既存のファイル（§0.1 S1 の決定：案 1）

- `src/lib/db/mem-db.ts`：`transitionDecision(db, alive, itemId, expected:{version}, transition:'record'|'promote'|'promote-record-only', now)` を 1 つ足す。トランザクションの最初に `alive()`（呼び手が渡した context の worktree の世代が今も同じか）を聞き、`memTransition`（`transitions.ts:27`）で遷移を検査し、`UPDATE mem_items SET state=?, version=version+1, updated_by='human', updated_by_instance=NULL, updated_at=? WHERE id=? AND version=? AND state=?` で書く。失敗は既存の `MemStoreFailure`（`instance_not_found`/`incarnation_changed`・`item_not_found`・`version_conflict`・`state_forbids`、`mem-db.ts:323`）で返す。既存の関数・private の helper の振る舞いは変えない
- `src/lib/mem/service.ts`：入口 `memSettleDecisionTransition(db, {worktreeId, expectedWorktreeIncarnation, itemId, expectedVersion, transition})` を 1 つ足す。比較する元の世代と版は **呼び手が渡す**（E の approve が最初に固定し operation に保存した値、§3.5）。入口は自分で固定し直さず、`expectedWorktreeIncarnation` が null なら断る（`lookupActor` は `by:'human'`）。`withMemTarget` で項目の `(repository_id, branch)` の mode を同じ同期の区間で決め、`on` でなければ store を呼ばずに 409 `disabled`。E の lib（`src/lib/promote/service.ts`）からだけ呼ぶ
- `tests/unit/lib/mem/write-entrances-recreate-4221.test.ts`：`ENTRANCES` に行を足す（§7.1）。既存の行・`it`・期待値は変えない
- `src/lib/db/migrations/runner.ts`：v69 の登録

---

## 7. 不変条件の表駆動の試験（全入口）

E の書き込みの入口（**preview**・approve・confirm-reflected・reconcile・abandon・settle-transition。preview も DB に行を書くので表に入れる、事前レビュー ⑦）を 1 つの表に並べ（A の側に足す入口は A の表に足す、§7.1）、各行で同じ不変条件を回す（`tests/unit/lib/promote/promote-entrances-4225.test.ts`）。A の I18 と同じく、**表のキーは E の service の export のうち DB の書き込み・外への書き込みに届くものから列挙**し、入口を足すと表に足すまで落ちる。外への書き込みは偽の `gh`（`execFile` の差し替え）と `os.tmpdir()` の `mkdtempSync` の作業木で行い、`afterEach` で消す。本物の GitHub に書かない。

| # | 不変条件 | 陽性対照（直す前・壊した実装で落ちる） | 陰性対照（変わらない） |
|---|---|---|---|
| T1 | 画面の印が無い要求は 403、何も書かない（operation・attempt・外への呼び出しが 0） | 印の検査を外した版で外への呼び出しが 1 | 印つきは通る |
| T2 | mode が `off`・`derived`・曖昧・未登録では preview・approve・confirm は断り、外へ書かない | mode の照合を外した版で `off` の approve が書く | `on` は書く |
| T3 | 承認の後に項目が変わった（`mem update` で `version+1`）→ 409 `item_changed`、書かない | 版の照合を外した版で書く | 版が同じなら書く |
| T4 | 作り直し後の古い要求：preview の後に context／行き先の worktree を同じ ID・path で消して作り直す → 409 `worktree_recreated`、書かない（A §16 I17 と同じ形） | 世代の照合を外した版で書く | 作り直さなければ書く |
| T5 | 文書を承認の後に別のプロセスが変えた → 409 `base_changed`、文書は他者の内容のまま | 基準の照合を外した版で他者の変更を上書き | 変わらなければ追記される |
| T5b | **既にあるファイル**：最後の照合（§3.3 の 2）と追記（3）の間に別のプロセスが文書を書き換える（試験の差し込み口で、同じ区間の中で外から書く）→ 他者の内容がすべて残り、区画が 1 つ足され、`succeeded`・`concurrent_edit=1`（事前レビュー ①） | 第 2 版の一時ファイル＋`rename` の版で他者の変更が消えて落ちる | 差し込みが無ければ内容は「基準＋区画」と完全に一致し、`concurrent_edit=0` |
| T5d | **新しく作るファイル**（再確認 P1）：(a) 一時ファイルを書いた後・`link` の前に、別のプロセスが行き先を作って書く → `EEXIST` で E は書かず 409 `base_changed`、行き先は他者の内容だけ、一時ファイルは消える。(b) `link` の後に別のプロセスが行き先へ追記する → 他者の追記が残る。(c) 行き先に symlink を置く → `EEXIST`、symlink の先は変わらない | 「`O_CREAT\|O_EXCL` で空のファイルを作り、位置 0 から `write`」の版で、作成の後・`write` の前に他者の書き込みを挟むと他者の内容が上書きされて落ちる | 差し込みが無ければ行き先の内容は区画の全文と完全に一致し、一時ファイルは残らない、`concurrent_edit=0` |
| T5e | **公開の直後の終了と他者の追記**（再確認 3 回目 P2-2）：`link` の後・`unlink` の前で止める（試験の差し込み口で例外を投げ、attempt は `in_flight` のまま）→ 他者が行き先へ追記 → reconcile → 自分の区画を 1 つ見つけて `succeeded`、E の一時名は回収される（行き先の `nlink === 1`、他者の追記は残る）→ 別の項目を同じ行き先へ承認 → 追記が成功する。無関係な hardlink（回収規則に当たらない別名）を置いた行き先は今までどおり断る | 回収を「中身が区画の全文と完全に一致するものだけ」にした版（3 回目の前の規則）で、一時名が残って `nlink === 2` のまま別の項目の追記が断られて落ちる | 他者の追記が無ければ、照合で一時名を回収し内容は区画の全文と一致する。DB に無い ID の `.commandmate-promote-*.tmp` は消さない |
| T5c | 文書の hardlink（`nlink=2`）・開く前と開いた後で `ino` が違う → 書かない | `fstat` の照合を外した版で repository の外の inode に追記されて落ちる | 通常のファイルは追記される |
| T6 | 選んだ worktree で別のブランチへ切り替えた → 409 `branch_changed` | — | — |
| T7 | 同じ項目を並行に承認（`await` の間に 2 本目を進める）→ 1 本だけ書く、2 本目は 409 | 一意の索引を外した版で 2 回書く | 1 本なら書く |
| T8 | GitHub が受理した後に応答が切れた（偽の `gh` が作ってからタイムアウト）→ `unknown`、再送しない。照合で `succeeded`、コメントは 1 件 | 不明を失敗と読む版で 2 件 | 確定した 4xx は `failed` |
| T9 | 書けた後に DB の更新が失敗（settle で例外）→ 次の読みで `unknown`、照合で `succeeded`、外への書き込みは 1 回 | — | — |
| T10 | 並行の再試行（`unknown` に 2 本の reconcile・2 本の再承認）→ 外への POST は増えない | — | — |
| T11 | 照合で印は見つかったが作者・本文の指紋が違う → `succeeded` にしない（作者が違う：印を写した他人。本文が違う：`unknown` の `body_differs`） | 印だけで見る版で成功と読む | — |
| T11b | Enterprise の host（`origin` の host）への投稿：preview の照会・POST・一覧・投稿者の照会の 4 つの `gh` の呼び出しの引数がすべて同じ `--hostname <host>` を持つ。結果不明の後に偽の `gh` の認証アカウントを切り替えて（`user` が別の `id` を返す）照合しても、元の `poster_id` のコメントを `succeeded` と認識する（事前レビュー ⑤） | 照合で今の `gh api user` を使う版で認識できず落ちる。一覧で `--hostname` を省く版で引数の検査が落ちる | 印だけを写した他人（別の `user.id`）のコメントは認識しない |
| T11c | 投稿者の確認と POST の主体の固定（再確認 P2・3 回目 P2-1）：偽の `gh` は **gh と同じ host の分類**（`github.com`・`*.ghe.com` は `GH_TOKEN`/`GITHUB_TOKEN`、それ以外は `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN`）で環境変数の token を読み、その分類の変数に token があればその主体、無ければ「有効なアカウント」で答える。`github.com`・`<tenant>.ghe.com`・Enterprise Server（`ghe.example.com`）の 3 つの host でそれぞれ回す。`user` の確認の後・POST の前に有効なアカウントを A から B へ切り替える → POST の呼び出しは A の token を環境変数に持ち、偽の `gh` の記録で投稿者は A、`succeeded` で `poster_id` = A。DB・ログ・応答・引数の列に token の文字列が現れない | token を固定しない版（呼び出しごとに保存済みの認証を使う）で、投稿者が B になり落ちる。2 回目の規則（`github.com` 以外は `GH_ENTERPRISE_TOKEN` だけ）の版で、`*.ghe.com` の行の投稿者が B になり落ちる | 切り替えが無ければ同じ結果。`gh auth token` が失敗すれば POST の呼び出しは 0 回で `failure` |
| T18 | 外への成功の後に項目の遷移を失敗させ（試験の差し込み口で入口に `version_conflict` を返させる）、もう一方の画面が先に作っていた preview を approve → 409（`operation_in_progress` か `prior_record_exists`）、外への POST・追記は 1 回（事前レビュー ②） | 一意の索引から `transition_pending=1` を外し、preview の無効化を外した版で 2 回書かれて落ちる | 遷移が成功する通常の場合、項目は 1 回だけ進み（`version+1` が 1 回）、`transition_pending=0` |
| T19 | 既にある記録を並べた新しい preview の approve：`acknowledged_operation_ids` が今の集合と同じなら書ける。approve の前に別の operation が成功していれば 409 `prior_record_exists` | 集合の照合を外した版で、人が見ていない記録の後に重ねて書かれて落ちる | 記録が無い項目は一覧が空で通る |
| T20 | 世代の受け渡し：(a) preview の後、(b) approve の外への書き込みの応答待ち（偽の `gh` を止めて待たせる）、(c) reconcile の照会待ち、のそれぞれで context の worktree を同じ ID・path で消して作り直す → (a) は 409 `worktree_recreated`、(b)(c) は外の結果だけ保存し（`succeeded`・`result_ref`）、項目は `open` のまま、`transition_pending=1`・`transition_reason='incarnation_changed'`（事前レビュー ③） | A の入口が自分で世代を固定し直す版で、(b)(c) の項目が `recorded` に進んで落ちる | 作り直さなければ (b)(c) とも項目は進み、`transition_pending=0` |
| T21 | 文書の照合（事前レビュー ④）：成功の後・応答の記録の前に止め、他者が文書の別の所に追記してから reconcile → 自分の区画を 1 つ見つけて `succeeded`、追記は増えない。区画の中身を直した・区画を消した → `unknown`（`block_altered`・`block_missing`）のまま、再承認の preview は `prior_record_exists`（`unknown` を一覧に並べないと通らない） | 文書全体の一致だけで見る版で、他者の追記の後を「未送信」と読み、2 つ目の区画が書かれて落ちる | 他者の変更が無ければ「基準＋区画」の一致で `succeeded` |
| T22 | フェンス（事前レビュー ⑥）：backtick の無い本文・空行・`# 見出し`・`@name`・`#123`・`<!-- -->` を含む本文を描画し、`remark-parse`（依存に既にある［事実：`package.json`］）で解析すると、自由入力の部分がそれぞれ 1 つの `code` の節になり、`heading`・`html`・`link` の節が中身から出ない。中身に backtick 10 個の列があってもフェンスは 11 で、中身から閉じない | 「最長＋1」の版で backtick の無い本文のフェンスが 1 になり、`code` の節にならず落ちる | 通常の本文の文字は変わらない（`code` の節の値が元の本文と一致） |
| T23 | 書き込みの連鎖の網羅（事前レビュー ⑦、`tests/unit/lib/promote/promote-write-chain-4225.test.ts`、新規。A の試験は変えない）：(1) `mem-db.ts` の書き込みの export（A の試験と同じく INSERT/UPDATE/DELETE に届く export を本文から求める。固定の名前の列挙にしない）を、`mem-db.ts`・`service.ts` 以外の `src/` のファイルが呼ばない（`import { x as y }` の別名・名前空間 import・re-export を解決して見る）。(2) `memSettleDecisionTransition` を呼ぶのは `src/lib/promote/service.ts` だけ。(3) E の service の export のうち、`mem-promote-db.ts` の書き込み・A の入口・`github-write.ts`・`doc-write.ts` に届くもの（helper 越しも）が §7 の表のキーと一致する。(4) その全部が関数の最初に `isScreenRequest` を呼ぶ（E の service は要求を受け取り、`settings-service.ts:37` と同じく中で印を見る。route だけに置かない） | 別のファイルから `transitionDecision` を直接呼ぶ合成の source、別名 import の合成、helper 越しの新しい入口の合成、`isScreenRequest` を呼ばない新しい入口の合成で、それぞれ検査が落ちる | 読みだけの export（一覧・`GET`）は表に入らなくても落ちない |
| T12 | 文書の行き先：repository の外（`..`）・絶対パス・symlink（途中の成分・最後の成分・root 自身）・`.git`・sensitive → preview を作らない | `lstat` を `stat` にした版で symlink の先へ書く | 通常のファイルは書ける |
| T13 | 効果 `spec` で成功 → `recorded`、警告の欄 `unreflected:true`。B の条件が成立しても閉じない。「反映を確かめた」で `promoted`、その後は B の条件で閉じる | — | `record_only` は `promoted` |
| T14 | 拒否・取り消し・期限切れ・無人：「やめる」・期限切れの preview の approve・印の無い経路 → 項目は `open`、外へ書かない | 期限の照合を外した版で書く | — |
| T15 | 秘密らしい文字列・見えない文字：withheld の項目は preview を作らない。見えない文字は `[U+XXXX]` に置き換えて preview に出す | — | 通常の文字は変わらない |
| T16 | commit・push をしない：書いた後の `git status` は作業木の変更だけ、`git log` は増えない | — | — |
| T17 | `off` の間に結果の確定（E1）：`unknown` の照合は `off` でも記録するが、項目の状態は変えない（`transition_pending=1`） | — | — |

### 7.1 A の表（`ENTRANCES`）に足す行（§0.1 S1 の条件）

`write-entrances-recreate-4221.test.ts` の網羅の検査（`:274-285`）は、`mem-db.ts` の書き込みに届く `service.ts` の export が表か例外の一覧にあることを assert する。`transitionDecision` を足すと `memSettleDecisionTransition` が列挙に入り、表に行が無ければこの検査が落ちる（足し忘れの陽性）。足す行と、それぞれの対照：

| 行のキー（足す） | 不変条件 | 陽性の対照（直しを外すと落ちる） | 陰性の対照 |
|---|---|---|---|
| `decision-record`（`transition:'record'`）・`decision-promote`（`'promote'`）・`decision-record-only`（`'promote-record-only'`） | 作り直し後の古い要求の拒否：要求の `await` の間に context の worktree を同じ ID・path で消して作り直す → 409 `incarnation_changed`、項目は前の状態・前の版のまま（既存の `it.each(Object.keys(ENTRANCES))` の 2 本がそのまま回る、`:313`・`:331`） | `transitionDecision` の `alive()` の照合を外した版で、行が `recorded`/`promoted` に変わり落ちる | 作り直さなければ遷移が書ける（既存の control の `it.each`） |
| 同上（3 行に `mode` の列を持たせる。既存の `writeSessionNoteFromScreen` の行と同じ形） | mode `off`・`derived` で書かない：項目の branch を `off`・`derived` にして入口を呼ぶ → 409 `disabled`、`mem_items` の行は変わらない | service の mode の照合を外した版で `off` の行が書かれて落ちる | `on` は書ける |
| 同上 | 版の食い違いを断る：入口に渡す `ifVersion` を今の版より 1 小さくする／`await` の間に `updateMemItem` で `version+1` する → 409 `version_conflict`、状態は変わらない | `WHERE … version=?` と事前の照合を外した版で書かれて落ちる | 版が同じなら書ける |

- この 3 つの不変条件の対照は、表の行を足すだけで回る既存の `it.each` と、E で足す `it.each`（mode・版の 2 本、同じファイルの新しい `describe`。既存の `describe`・`it` の名前は変えない）で確かめる
- 入口は比較する元の世代を引数で受ける（§3.5）。表の行の `request()` は、要求を受けた時点（`await` の前）に読んだ世代を渡し、作り直しはその後の `await`（`withMemTarget` の git の観測）の間に入れる。既存の作り直しの `it.each` の形のまま回る
- A の試験の「store の書き込みは service だけ」（`write-entrances-recreate-4221.test.ts:291`）は固定の名前の列挙で、`transitionDecision` を含まない。A の試験は変えず、E の T23 が求めた名前の集合で同じことを見る（事前レビュー ⑦）
- 遷移の表（`memTransition`）に無い組（`recorded` に `record`、`open` に `promote` など）は 409 `state_forbids`。これは A の `transitions` の試験が持つので、E では入口から 1 本だけ確かめる

- ガード：T23（書き込みの連鎖）、§4.2（CLI に口が無い）、§5.4（git の書き込み・`gh --method` は E の 1 か所だけ・mem/brief の lib が fs に書かない）、§6.2（常駐を持たない）
- 受入基準との対照：「拒否・取り消し・差分の変更・無人で書かない」= T1・T2・T3・T14／「別のセッションが文書を変えた・worktree を消した・別のブランチ・並行の承認」= T4〜T7・T5b・T20／「受理後に応答が切れた・DB の更新が失敗・並行の再試行で二重に書かない」= T8〜T10・T18・T19・T21／「`recorded` のままで警告、確かめた後に `promoted`」= T13（re-plan の例は H #4228 の受入と共有）／「repository の外・symlink を断る」= T12／「この Issue が入るまで外へ書かない」= §5.4 のガード

---

## 8. 事実の照合・対になる場所・未確認

### 8.1 契約の説明と実コード

| 契約の説明 | 実コード | 判断 |
|---|---|---|
| A の decision の遷移 | `transitions.ts` に `record`・`promote`・`promote-record-only` の検査はあるが、それを使う store の書き込みは無い | §0.1 S1 の決定（案 1）で A に足す |
| B「未反映の decision は条件で閉じない」 | `transitions.ts:49-50`、`evaluate.ts:443`、`closeMemItemByCondition` は版と `close_when` を照合（`mem-db.ts:1060-1086`） | 一致 |
| A §11 の screen-request の印 | `isScreenRequest`（`screen-request.ts:52`）、`settings-service.ts:37` と notices の acknowledge の route が使う | そのまま使う |
| C の見えない文字の置き換え | `revealInvisible`・`BRIEF_INVISIBLE`（`sanitize.ts:24`・`:88`） | そのまま使う |
| 「A〜D の段で外へ書かないことを試験済み」 | 名指しの試験は見つからない（§5.4） | E のガードで固定する |
| A §3.2「`recorded` は人が画面で閉じる」 | 遷移が無い | §0.1 S2 の決定で G（#4227）へ送った |

### 8.2 対になる場所（探した結果）

- PC とスマホ：同じページ・同じ部品（§4.1）。A の `MobileTerminalTabSessionNote.tsx` のような別の部品は作らない
- CLI の型の写し（`src/cli/types/`）：E は CLI に口を作らないので足さない。`MemExitCode` も変えない
- 説明（ja・en）：`docs/user-guide/` の mem の節（実装の契約）。この設計の段では書かない
- 同じ処理の写し：`gh` の呼び出しは `github-query.ts`（GET）と `lib/git/github-api.ts`。E は POST を新しい 1 か所に置き、既存は変えない
- 古い動きを固定している試験：`write-entrances-recreate-4221.test.ts:274-295`（store の書き込みは service だけ・全入口は `ENTRANCES`）。E は既存の行・`it` を変えずに行を足す（§7.1）

### 8.3 採らなかった案（S1 の案 2）

A のファイルを変えず、E の新しいファイル（`src/lib/db/mem-promote-db.ts`）が `UPDATE mem_items` を直接書き、E の側に別の入口の表を持つ案。A の試験（`write-entrances-recreate-4221.test.ts:291`）は関数名の文字列で見るので通ってしまうが、A の「書き込みは service だけ」「全入口の表」の意図を外から迂回し、表が 2 つになって食い違いうる。PM の決定（§0.1）で採らない。

### 8.4 未確認・未決（レビューで見てほしい点）

| # | 内容 |
|---|---|
| U1 | `gh api --method POST … --input -` の応答の分類（とくに 5xx・タイムアウトで GitHub が作ったかどうか）を実測していない。fixture の Issue を作って試すことは「本物の GitHub に書かない」に反するので、実装の契約では偽の `gh` だけで試し、実機の確認は UAT（専用の検証 repository）に回す |
| U2 | 照合の `--paginate` は件数の多い Issue で遅い。`since`（operation の `approved_at` の少し前）で絞る案 |
| U3 | コードのフェンスの中の `@name`・`#N` が通知・リンクにならないこと（GitHub の仕様）を実測していない |
| U4 | preview の期限（30 分）・保持（90 日）・文書の大きさ（1 MiB）・拡張子（`.md` だけ）は初期値の見立て |
| U5 | 文書の書き込みの位置（末尾への追記）。見出しの下へ差し込む形を求められるか |
| U6 | `cmate-orchestrate` が Issue のコメントを plan・goal に入れないこと（Issue 本文の記述）は commandmate-skills 側で確かめていない |
| U7 | （第 3 版で決めた）`transition_pending` の「記録済みとして扱う」は、今の項目の欄の指紋が書いた時と違えば差分を出し、`acknowledgeDiff:true` を求める（§1.2） |
| U8 | 追記（§3.3）でも、途中のディレクトリの成分を `lstat` の後に symlink へ差し替える窓は Node で閉じられない（`openat` が無い）。これは同じ OS 権限の作為で、通常の並行編集ではない（§5.5）。通常の並行編集は ① の処置で失われない |
| U9 | `O_NOFOLLOW` の値が Windows の Node で 0 になる（`daemon.ts:196` は `?? 0` で受けている［事実］）。E の文書の書き込みは `O_NOFOLLOW` が 0 の platform では断る |
| U11 | `gh auth token --hostname` と、`GH_TOKEN`／`GH_ENTERPRISE_TOKEN` が保存済みの認証より優先されることを、使う gh の版で実測していない（実装の契約で `gh --version` の下限を決め、偽の `gh` の試験と別に 1 回だけ読みの API で確かめる） |
| U12 | `link` の後・`unlink` の前に他者が一時ファイルの名前を消した・置き換えた場合、照合は中身が区画の全文と一致するものだけを消すので、他者のファイルは消さない（区画と同じ中身の別のファイルを他者が置いた場合を除く。その場合も消えるのは E の区画と同じ中身だけ） |
| U10 | 他者の追記と E の追記が同じ瞬間に `O_APPEND` で重なったとき、1 回の `write` が分割されないか（ローカルの通常ファイルでは 1 回の `write` は原子的に末尾へ付く［見立て］。ネットワークのファイルシステムは対象外） |

### 8.5 本文に無い指摘（この Issue では直さない）

- `docs/design/mem-store-4221.md` §3.2 の「`recorded` の `mem close` は断る。人が画面で閉じる」に対し、`src/lib/mem/transitions.ts:45-48` は `recorded` の `close` を人の経路も含めて断る。人が閉じる遷移は無い（§0.1 S2 で G #4227 へ送った）
- `tests/unit/lib/mem/write-entrances-recreate-4221.test.ts:291` の「store の書き込みは service だけ」は関数名の文字列で見るので、新しいファイルが `UPDATE mem_items` を直接書く経路を検出しない

---

## 9. 事前レビューの処置

### 9.1 1 回目（2026-11-09）

Codex の事前レビュー（2026-11-09、P1 2・P2 5。`workspace/orchestration/runs/2026-11-08/prereview/review-4225.md`）。守る条件と対照は §7 の T 番号の行。

| # | 指摘 | 処置 | 1 行の理由（守る条件・対照） |
|---|---|---|---|
| ① | P1：同期の区間と `rename` では、最後の読みの後の他プロセスの通常の編集を古い内容で上書きする | 採る（受入基準の読みは PM に確認、§0.1） | 文書は置き換えをやめて `O_APPEND\|O_NOFOLLOW` の追記だけにし、`fstat` で hardlink・差し替えを断る。窓の中の他者の変更は失われず、`concurrent_edit` の成功として人に見せる（§3.3、T5b・T5c） |
| ② | P1：外の成功・遷移待ちの間に、古い preview から二度目を書ける | 採る | `transition_pending=1` を一意の部分索引の排他に入れ、外の成功より前の preview を無効にし、記録し直しは既にある記録の一覧を結んだ新しい preview だけにする。保持の期限で消さない（§1.2・§2.3・§6.1、T18・T19） |
| ③ | P2：E から A へ渡す途中で、要求の寿命を固定し直せる | 採る | approve で固定した世代と版を operation に保存し、A の入口は引数で受けて照合だけをする（固定し直さない）。合わなければ外の結果だけ保存して `transition_pending`。A の変更は入口の引数だけで S1 の範囲のまま（§3.5・§6.3、T20） |
| ④ | P2：文書全体の一致・不一致だけでは、書き込みの結果を確定できない | 採る | 文書の照合は operation の印の区画（begin/end と本文の SHA-256）を探す。区画が 1 つで指紋が一致すれば成功、壊れた・無いは `unknown` のまま人へ（未送信と読まない）。`conflict` の状態をやめた（§3.3・§3.4、T21） |
| ⑤ | P2：コメントの照合の host と投稿者が元の操作に固定されていない | 採る | destination の host を 4 つの `gh` の呼び出しすべての `--hostname` に使い、POST の前に投稿者の数値の `id` を operation に保存し、照合はその `id` で見る（§2.2・§3.2・§3.4、T11b） |
| ⑥ | P2：フェンスの長さ「最長＋1」は backtick の無い本文でコードブロックにならない | 採る | フェンスの長さを `max(3, 最長＋1)` にし、`remark-parse` で `code` の節になることを確かめる（§5.2、T22） |
| ⑦ | P2：入口の表に行を足すだけでは、新しい書き込み口の迂回を検出できない。preview が表に無い | 採る | E の新しい試験で、`mem-db.ts` の書き込みの export を本文から求め、別名・helper 越しも含めて呼び手を `service.ts` に限り、A の入口の呼び手を E の service に限り、E の書き込みに届く export（preview を含む）を表と突き合わせ、全部が `isScreenRequest` を最初に呼ぶことを固定する。A の試験は変えない（§7・§7.1、T23） |
| 補 | U7：内容の違う「記録済みとして扱う」で何を見せるか | 採る | 今の項目と書いた時の指紋が違えば差分を出し、`acknowledgeDiff:true` を求める（§1.2・§4.2） |

### 9.2 再確認（2 回目、2026-11-09、`workspace/orchestration/runs/2026-11-08/prereview/review-4225b.md`）

前回 7 件の判定は「解消 5 件（②③④⑥⑦）・一部解消 2 件（①⑤）」。残りの 2 件の処置：

| # | 指摘 | 処置 | 1 行の理由（守る条件・対照） |
|---|---|---|---|
| R1 | P1：新しく作る文書は `O_CREAT\|O_EXCL` で作った後・`write` の前に他者が書くと、位置 0 からの `write` で他者の内容を上書きする（① の残り） | 採る | 新しく作るファイルは、一時ファイルに全文を書いて `link` で名前を付ける（行き先が既にあれば `EEXIST` で何も上書きしない。空のファイルが見える窓が無い）。既にあるファイルは `O_APPEND` のまま（§3.3、T5b を既存／新規に分け T5d を足した） |
| R2 | P2：投稿者の確認と POST が別々の `gh` の呼び出しで、間のアカウントの切り替えで別の主体として投稿される（⑤ の残り） | 採る | 最初に 1 回 `gh auth token --hostname` で取り出した token を、確認と POST の両方に環境変数で渡して主体を固定する。token は保存・記録しない。照合は読みだけなので固定せず `poster_id` で突き合わせる（§3.2、T11c。gh の優先順位の実測は U11） |

- §0.1 の受入基準の読み（最後の照合の後の他者の変更は再承認ではなく `concurrent_edit` の成功）は、再確認でも了承済みとは判定されていない。PM の確認待ちのまま残す

### 9.3 再確認（3 回目、2026-11-09、`workspace/orchestration/runs/2026-11-08/prereview/review-4225c.md`）

前回 2 件の判定は「解消 1 件（R1）・一部解消 1 件（R2：host による環境変数の選択が gh の仕様と一致しない枝が残る）」。指摘 2 件と、一部解消の残りの処置：

| # | 指摘 | 処置 | 1 行の理由（守る条件・対照） |
|---|---|---|---|
| R3 | P2：`github.com` 以外をすべて `GH_ENTERPRISE_TOKEN` にすると、gh は `*.ghe.com` で `GH_TOKEN`／`GITHUB_TOKEN` を読むので固定した token が使われず、保存済みの認証へ戻る（R2 の残りと同じ根） | 採る | host で変数を選ぶのをやめ、gh が読む 4 つの変数すべてに同じ token を入れる。E は host の分類を持たないので gh と食い違う枝が無い（§3.2）。対照は偽の `gh` に gh と同じ分類を持たせ、`github.com`・`*.ghe.com`・Enterprise Server の 3 つで回す（T11c） |
| R4 | P2：`link` の後・`unlink` の前の終了と他者の追記が重なると、一時名の中身が区画と一致せず回収されずに `nlink === 2` が残り、後続の追記が拒否され続ける | 採る | E の一時名の回収規則を定める：DB にある E の operation の ID で同じ行き先のものだけを候補にし、行き先と同じ inode なら中身に関係なく名前を消す（内容は行き先に残る）。別の inode なら区画の全文と完全一致のときだけ。回収は照合と既にあるファイルの追記の前に行う。無関係な hardlink は今までどおり断る（§3.3、T5e） |

- §0.1 の受入基準の読みは PM の確認待ちのまま残す（3 回目でも判定の対象外）

### 9.4 実装後のレビュー（5-2b、2026-11-09、`workspace/orchestration/runs/2026-11-09/review-4225.md`）

指摘 4 件（P1 1・P2 3）。すべてこの PR で直した。

| # | 指摘 | 処置 | 1 行の理由（守る条件・対照） |
|---|---|---|---|
| P1 | 項目のブランチの mode 判定が全 root に届かない：所属は作業木の現在ブランチで解決し、追加の mode 確認は項目の所有 root だけ | 採る | preview・approve・A の入口 `memSettleDecisionTransition` は、作業木の所属に**項目のブランチ**を名指しして `withMemTarget` を引く（`decideMemTarget` の `ambiguous` と同じ扱い）。`ambiguous` は preview が `disabled`（`reason: ambiguous`）、approve が `mode_not_on` の再承認、A の入口が `ambiguous`（E は遷移待ちの理由 `disabled` に読む）。加えて `target.mode === 'on'` を求める。対照：同じ Git の 2 root で現在ブランチは双方 on・項目のブランチは一方 on／他方 off なら書かない（陽性）、単一 root の on と 2 root とも on は今どおり書ける（陰性） |
| P2-1 | 改名後に文書の照合先を失う：照合が保存した旧 ID を直接引き、`unreadable` になる | 採る | 保存した値（来歴）は書き換えない。`currentWorktreeIdOf` が alias（`resolveWorktreeIdWithAlias`）で今の ID を引き、保存した世代と同じときだけその作業木とする（改名は世代を引き継ぎ、作り直しは新しい世代）。照合・遷移（`settleTransition`）・approve の context・一時名の回収（`docOperationsFor` は保存 ID を alias で解いて照らす）に当てる。対照：改名後の照合で成功・一時名の回収・改名前の preview の承認（陽性）、同じ ID の作り直しは読まない（陰性） |
| P2-2 | 既存の close／purge の後に未解決の操作が画面から消える：一覧が closed を除いた項目の ID でしか操作を引かない | 採る | 一覧に `unresolved` を足す：ブランチの未解決の操作（approved・in_flight・unknown・遷移待ちの succeeded）を項目の存否・closed から独立に引き（`listUnresolvedPromoteOperations`）、項目の行に出ないものを項目（無ければ null）と並べる。画面は照合・無いことを確かめた・記録済みとして扱う（項目があるときだけ）のボタンを出す。対照：POST 待ちの間の close（遷移待ちのまま一覧に残る）と purge（不明のまま残り、照合が届く）、開いた項目の操作と確定した操作は `unresolved` に出ない |
| P2-3 | ブランチの値の見えない文字：本文がブランチをそのまま差し込み、`invisibleReplaced` は本文と引用だけで計算 | 採る | ブランチに C の出口の検査 `sanitizeBranch`（`brief/sanitize.ts`）を当て、通らないものは省略の形（`(省略 N bytes・理由)`）で書く。作成者のインスタンス ID は `revealInvisible`。metadata の見えない文字も `invisibleReplaced` に数える。対照：`feature/a\u200Bb` は本文に残らず true、普通のブランチ・作成者・detached はそのままで false |


### 9.5 実装後の再レビュー（5-2b 2 回目、2026-11-09、`workspace/orchestration/runs/2026-11-09/review-4225b.md`）

前回 4 件は解消 3 件・一部未対応 1 件（P2-2）。残り・追加の指摘 3 件（P2）。すべてこの PR で直した。

| # | 指摘 | 処置 | 1 行の理由（守る条件・対照） |
|---|---|---|---|
| 5-2c P2-1 | 設定の不一致で遷移待ちの回復画面を失う：A の入口の新判定は成功を遷移待ちに残すが、一覧は同じ `ambiguous` で 404 になり `unresolved` を読む前に終わる | 採る | 一覧の所属の確認を mode の一致の判定から分ける。`promoteList` は所属（`withSettledRepositoryMembership`）と mode（`decideMemTarget`）を同じ同期の区間で引き、`ambiguous` なら 200 で `mode: 'ambiguous'`・`ambiguous: { reason, roots }`・`decisions: []`・ブランチの未解決の操作すべてを返す（結果は mode に依らず残す、E1）。画面は警告を出し、照合・無いことを確かめたのボタンだけを出す（項目は遷移しないので「記録済みとして扱う」は出さない）。対照：POST 待ちの間に別 root の項目のブランチを off → 一覧に出る（陽性・成功と不明の 2 本）→ 不明は一覧から照合して結果が残る、設定が揃えば今までどおりの一覧（陰性） |
| 5-2c P2-2 | 別 root の未解決の操作は表示できても回復の API が 404：一覧は同じ Git の全 `readRepositoryIds` から出すが、reconcile・abandon・settle-transition は保存した `repository_id` と URL の ID の完全一致を求める | 採る | 回復の 3 API の所属の範囲を一覧と同じ（URL の root の所属の `candidates`、無ければ `members`）に揃える（`repositoryReadIds`・`ownsOperation`）。所属が引けない（root が無い・登録が動いている）ときは今までどおり完全一致だけ。画面は表示中の root の ID のままでよい。対照：root A の操作を root B の画面に出し、B の ID で照合・無いことを確かめた・記録済みとして扱うが届く（陽性）、別の Git の root からは 404 で何も変わらない（陰性） |
| 5-2c P2-3 | closed の項目に出した遷移のボタンが必ず拒否される：A の状態表は closed からの遷移をすべて禁じる | 採る | 外部の結果の確認と項目の遷移を分ける。closed・purge 済みの項目の遷移待ちには遷移を出さず、「記録済みとして扱う（書けた結果だけを確かめ、閉じた項目は進めません）」を出す。これは settle-transition に `{ acknowledgeItemClosed: true }` を送り、A の入口を通らずに遷移待ちだけを終える（項目は閉じたまま）。遷移の要求（`ifVersion`）は closed なら A の前に 409 `state_forbids`（`reason: item_closed`）、purge 済みなら 404（`item_gone`）。開いた項目への `acknowledgeItemClosed` は 409（`item_open`）。対照はボタンの要求（画面の試験：URL と本文）から実 API（`promoteApi` を service へ通す試験）まで |
| 5-2c 付随 | 照合の `succeeded` と A の答えの間（A の await）に、その記録を一覧に含めた preview の承認が通り 2 度目の POST をしうる（照合の前に所属の await を足したことで T10 が落ちて見えた） | 採る | `settleTransition` は最初の同期の文で遷移待ち（`transition_pending = 1`）を立て、A の答えで下ろす／理由を書く。approve の `hasActivePromoteOperation` がその間の承認を `operation_in_progress` で断る。対照：照合の A を止めた間の承認が断られ POST は 1 回（陽性、直しを外すと 2 回） |

### 9.6 実装後の再レビュー（5-2b 3 回目、2026-11-09、`workspace/orchestration/runs/2026-11-09/review-4225c.md`）

前回 3 件は解消。追加の指摘 2 件（P1 1・P2 1）。端を 1 つずつ塞ぐのをやめ、§11.1 の不変条件 I1・I2 の行として直した。

| # | 指摘 | 処置 | 1 行の理由（守る条件・対照） |
|---|---|---|---|
| 5-2d P1 | settle-transition の所属の照会（`repositoryReadIds`）の await の後で世代を取っていたので、その間に同じ ID・同じ path で作業木を作り直すと新しい世代を A へ渡し、古い要求で項目が recorded／promoted になる | 採る（I1 の行） | 世代（`getOrCreateWorktreeIncarnation`）を最初の await の前へ移し、その値を `settleTransition` → A へそのまま渡す。§11.1 の世代の表と、`getOrCreateWorktreeIncarnation` がどの関数でも最初の await より前にしか無いことを試験で固定。対照：所属の照会の中で作り直す→`worktree_recreated`・項目は open のまま（陽性、直しを外すと recorded）、作り直さなければ recorded（陰性） |
| 5-2d P2 | A を待つ間に別の画面で closed の項目の遷移待ちを確かめる（pending 0）と、先行の要求の A の失敗が照合せずに pending を 1 へ戻し、確認済みの操作が一覧に戻る | 採る（I2 の行） | 遷移を要求ごとの印（`transition_claim`）を持つ条件つきの更新に分ける：`beginPromoteTransition`（読んだ pending・印が同じときだけ印を取る）・`finishPromoteTransition`（失敗の理由は自分の印があるときだけ、成功は pending のときだけ下ろす）・`acknowledgePromoteTransition`（読んだ pending・印のときだけ下ろし印を外す）。照合の確定も読んだ `unknown` からだけにした。対照：A の待機中の確認の後、先行の失敗が pending を戻さない・後から来た要求の成功を先行の失敗が上書きしない（陽性、直しを外すと 1 に戻る）、間に何も無ければ失敗の理由が残る（陰性） |

### 9.7 実装後の再レビュー（5-2b 4 回目、2026-11-09、`workspace/orchestration/runs/2026-11-09/review-4225d.md`）

前回 2 件のうち 1 件は解消、1 件は一部未対応。残った指摘 1 件（P2）を §11.1 の I2 を強めた形の行として直した。

| # | 指摘 | 処置 | 1 行の理由（守る条件・対照） |
|---|---|---|---|
| 5-2e P2 | POST の応答待ちの操作が古さで不明になり、照合で決まって遷移も終えた（または closed の項目で確認済みの）後に元の応答が戻ると、結果の確定（CAS）の false を捨て、読み直した `succeeded` の行から新しい印を取り直し、A の失敗で pending を 1 へ戻す | 採る（I2 を強めた形） | I2 を「CAS の結果は必ず呼び手へ返し、不成立なら後続の書き込み・自動の遷移を始めない」に強めた。`settleOrUnknown` は自分の確定が成立したかを返し、`promoteApprove` は自分の確定が `succeeded` を書いたときだけ、その確定が残した遷移（pending 0・印なし）を条件に `settleTransition` を呼ぶ。`finishPromoteTransition`（成功）・`settleStalePromoteAttempts` の中の確定も戻り値を見る。網羅の検査に CAS の戻り値を捨てる呼び出し（式文・`await` だけの文・`void`）の検出と、表の CAS の行の「結果を見る」を足し、自己テストで落ちることを確かめた。対照：応答の保留 → 不明化 → 照合（＋closed の確認）→ 元の応答の解放で pending が 1 に戻らない（陽性、直しを外すと 1・`version_conflict`）、照合の無い不明化と何も無いときは従来どおり遷移する（陰性） |

---

## 10. 実装で実コードを正とした点（2026-11-09）

| # | 設計の記述 | 実装 | 理由 |
|---|---|---|---|
| I1 | root の検査は `realpath(root) === path.resolve(root)`（§5.3） | root 自身を `lstat` して通常のディレクトリで symlink でないこと | `realpath` の比較は祖先の symlink（macOS の `/var` → `/private/var`、`/tmp`）でも不一致になり、正当な作業木を断る。守るのは「root 自身が symlink でない」で、途中・最後の成分は A の `normalizeRepoPath` と E の検査が `lstat` で見る |
| I2 | operation id は approve で `randomUUID`（§3.2） | **preview で決め**、`mem_promote_previews.operation_id`（UNIQUE）に持ち、approve はその ID で operation を作る | 本文の印に operation id が入るので、画面が見せた本文（`body_sha256`）と書く本文を一致させるには preview の時点で決まっている必要がある |
| I3 | `mem_promote_operations` の列（§6.1） | `block`（文書の区画の全文）を足した | 一時名の回収規則（§3.3 の R4、別の inode のときは区画の全文と完全一致）で照らす値 |
| I4 | 本文の「承認: 人（画面）<時刻>」（§5.2） | 「差分の作成: <時刻>（承認は人が画面で行う）」 | 本文は preview で固定する（I2）。承認の時刻は operation の `approved_at` に持つ |
| I5 | T23 (1)「`mem-db.ts` の書き込みの export を `mem-db.ts`・`service.ts` 以外が呼ばない」 | 今の呼び手（`agent-instances-db.ts`・`worktree-db.ts` の `archiveNowSlots` 等、`mem-close-db.ts` の `closeMemItemByCondition`、`settings-service.ts` の設定の書き込み）を理由つきで名指しし、**それ以外の新しい呼び手**を落とす。加えて `transitionDecision` の呼び手は `mem/service.ts` だけ、`memSettleDecisionTransition` は `promote/service.ts` だけ、`mem_items` を SQL で書くのは `mem-db.ts` だけ | 設計の文面のままでは A・B が既に持つ正当な呼び手で落ちる。迂回の検出（別名・名前空間・相対パス・re-export）は名前の集合を本文から求めたまま保った |
| I6 | B の試験 `close-entrances-4222.test.ts` | `EXCEPTIONS` に `transitionDecision` を理由つきで 1 行足した（既存の行・`it`・期待値は変えない） | B の試験は「store の書き手はすべて表の行か理由つきの例外」を固定しており、新しい書き手は足すまで落ちる設計 |
| I7 | v66 の試験 `migration-v66-mem-store-4221.test.ts` | v69 の `down` を先に呼ぶ 2 行を足した（期待値は変えない） | v66 より前へ戻す試験は上に積んだ版から順に戻す（v68 のときと同じ足し方）。`mem_promote_*` は `mem_` で始まるので戻さないと「`mem_%` の表が 0」の期待に当たる |
| I8 | 文書の行き先の worktree は人が選ぶ（§2.2） | 画面で選んだ作業木を、文書の行き先と context の両方に使う。preview は HEAD のブランチが項目のブランチと同じことを求める | 1 画面で選ぶものを 1 つにした。別の作業木へ書く要求は無い |
| I9 | approve で token が取り出せないとき `failure`（§3.2） | operation を作らずに 502 `gh_failed`（`token_unavailable`）。preview は有効のまま | 送る前の失敗で、operation の行を作る前に分かる。再試行は同じ preview でできる |
| I10 | 項目の mode は `memModeOnFor(項目の root, 項目のブランチ)`（§2.3） | 作業木の所属に項目のブランチを名指しした `withMemTarget` の答え（全 root が同じ判定・`ambiguous` は断る）と、項目の root の `memModeOnFor` の両方 | 5-2b P1。所属の全 root で同じ判定を求める A の規則（`decideMemTarget`）に揃える。`MemTargetSpec.branch` は型が `string` だが `withMemTarget` は名指しの値（detached の null を含む）をそのまま `decideMemTarget` へ渡すので、null は型だけ合わせた（`target.ts` は scope 外） |
| I11 | 操作が名指す作業木は保存した ID（§3.4・§3.5） | 保存した ID と世代は書き換えず、使うときに alias と世代で今の作業木へ解く（`currentWorktreeIdOf`） | 5-2b P2-1。改名は子の行（世代を含む）と alias を動かすが、E の表は `worktree_id` 列を持たない（v69：削除で消えないため）ので改名に追随しない |
| I12 | 一覧は項目ごとの操作（§4.1） | 項目の行に加え、項目の無い／閉じた未解決の操作を `unresolved` に出す | 5-2b P2-2 |
| I13 | 一覧は `withMemTarget`（repository）の答えで所属と mode を一度に判定（§4.2） | `promoteList` は `withSettledRepositoryMembership` と `decideMemTarget` を直接引く（`withMemTarget` の repository の枝と同じ組み立て） | 5-2c P2-1。`withMemTarget` の失敗は所属を返さないので、`ambiguous` のときに未解決の操作を引く `readRepositoryIds` が無い。`target.ts` は scope 外なので E の側で同じ組み立てをした |
| I14 | 回復の API の所属は URL の root と操作の `repository_id` の一致（§4.2） | URL の root の所属（同じ Git の `candidates`）に操作の root が入っていればよい | 5-2c P2-2。一覧（`readRepositoryIds`）と同じ範囲 |
| I15 | 「記録済みとして扱う」は項目の遷移（§3.4） | 項目が closed・purge 済みなら遷移を出さず、遷移待ちを終えるだけ（`acknowledgeItemClosed`）。`settleTransition` は A の前に遷移待ちを立てる | 5-2c P2-3・付随。A の状態表（`transitions.ts`）は closed からの遷移を禁じ、A は scope 外 |
| I16 | 遷移待ちは `transition_pending` と理由（§6.1） | v69 の `mem_promote_operations` に `transition_claim`（遷移を持つ要求の印）を足した。v69 はこのブランチで足した未公開の版なので、新しい版を積まずに v69 の表に足した | 5-2d P2（I2）。先行の要求の A の答えが後から来た確認・要求を上書きしないことを、行の値だけで条件にする |
| I18 | 承認の確定の後は読み直した行が `succeeded` なら遷移へ進む（§3.5） | 自分の確定（`settleOrUnknown` の戻り値）が `succeeded` を書いたときだけ進み、`beginPromoteTransition` には読み直した行ではなく確定が残した遷移（pending 0・印なし）を渡す | 5-2e P2（I2 を強めた形）。読み直した行は照合・確認が決めた状態のことがあり、そこから印を取り直すと確定済みの遷移を始め直す |
| I17 | 結果の確定は `in_flight`・`unknown` から（§3.2） | `settlePromoteOperation` は呼び手が読んだ状態の集合（`from`）を条件にする。承認自身の結果は従来どおり `in_flight`・`unknown`、照合は `unknown` だけ。操作の行が変わったときだけ試行を閉じる | I2。照合の await の間に承認の結果が書いたものを照合が上書きしない |

## 11. 共通規則の全読者

E の入口が共有する規則と、それを読む（当てはめる）場所の全部。規則を変えるときはこの表の行をすべて直す。

| 共通規則 | 読む場所（ファイル・関数） | 固定している試験 |
|---|---|---|
| 画面の印（`isScreenRequest`）。無ければ 403 `screen_only`・何も書かない | `src/lib/promote/service.ts` の `promotePreview`・`promoteApprove`・`promoteConfirmReflected`・`promoteReconcile`・`promoteAbandon`・`promoteSettleTransition`（関数の最初の文）。route（`src/app/api/repositories/[id]/mem/decisions/**`）は要求を渡すだけ。画面の client `src/lib/promote/screen-client.ts` が `screenRequestHeaders()` を付ける | `promote-entrances-4225`（(e)）・`promote-write-chain-4225`（(4)）・`mem-decisions-routes-4225`・`DecisionPromotePanel-4225`・ガード `mem-promote-screen-only-4225` |
| mode は項目の (repository, branch) で `on` のときだけ開始・遷移する。項目のブランチを名指しして所属の全 root で同じ判定（`ambiguous` は断る、5-2b P1）＋項目の root の `memModeOnFor` | `promotePreview`・`promoteApprove`（同期の区間、`itemBranchSpec`・`itemModeOn`）、`memSettleDecisionTransition`（`src/lib/mem/service.ts`、遷移の同期の区間、項目のブランチを名指し）。`promoteReconcile`・`promoteAbandon` は結果の記録だけで mode を問わない（E1）、遷移は A の入口が断る。**追従（5-2c P2-1）**：`promoteList` は mode の判定と所属の確認を分け、`ambiguous` でも 200 で未解決の操作を返す（決定の一覧は出さない）。`DecisionPromotePanel` は `ambiguous` で警告を出し、遷移のボタンを出さない | `promote-entrances-4225`（(b)・T17・5-2b P1・5-2c P2-1）・`write-entrances-recreate-4221`（decision-* の mode の `it.each`）・`DecisionPromotePanel-4225`（5-2c P2-1） |
| 作業木の世代は要求の到着で固定し、比べるだけ（固定し直さない）。保存した作業木は alias と世代で今の ID へ解く（改名は同じ作業木、作り直しは別、5-2b P2-1） | `currentWorktreeIdOf`（`promoteApprove` の context・`settleTransition`・`promoteReconcile` の文書）、`docOperationsFor`（保存 ID を alias で解く）、`promotePreview`（`getOrCreateWorktreeIncarnation` → preview の行）、`promoteApprove`（preview の値 → operation の行）、`settleTransition`（operation の値を A の入口へ）、`promoteConfirmReflected`・`promoteSettleTransition`（その要求の時点）、`memSettleDecisionTransition` → `transitionDecision` の `alive()` | `promote-entrances-4225`（(a)・T20・5-2b P2-1）・`write-entrances-recreate-4221`（decision-* の作り直しの `it.each`） |
| 版と指紋（`item_version`・`itemFingerprint`）が承認のときと同じ | `promotePreview`（同期の区間で読み直し）、`promoteApprove`、`transitionDecision`（`WHERE version = ?`）、`promoteSettleTransition`（`acknowledgeDiff`） | `promote-entrances-4225`（T3・T18 U7）・`write-entrances-recreate-4221`（版の `it.each`） |
| 行き先と基準の指紋（文書：内容の SHA-256・HEAD のブランチと common-dir、コメント：Issue の指紋・投稿者の数値 ID） | `promoteApprove`（同期の区間）、`writeDocBlock`（書く直前にもう一度）、`destination.ts`（`checkDocPath`・`docBaseFingerprint`・`issueBaseFingerprint`） | `promote-entrances-4225`（T5・T6・poster_changed）・`promote-doc-write-4225` |
| 進行中は項目ごとに 1 つ、既にある記録を見ていない承認は書かない（`hasActivePromoteOperation`・一意の部分索引・`acknowledged_operation_ids`） | `promoteApprove`、`claimPromoteOperation`（`mem-promote-db.ts`）、migration v69 の索引 | `promote-entrances-4225`（T7・T10・T18・T19）・`migration-v69-mem-promote-4225` |
| 不明を未送信と読まない・自動で再送しない（`classifyCommentPost`、`settleStalePromoteAttempts`、照合は印・投稿者・本文の指紋／区画） | `github-write.ts`（`classifyCommentPost`）、`promoteApprove`（`settleOrUnknown`）、`promoteReconcile`、`promoteList`（`readState`：別の boot・10 分超は不明として出す）、`doc-write.ts`（`findDocBlock`・`reconcileDocBlock`） | `promote-github-4225`・`promote-entrances-4225`（T8〜T11・T21） |
| 投稿の主体の固定（token を 4 つの変数すべてに入れる。host の分類を持たない） | `github-write.ts`（`readGhToken`・`fixedTokenEnv`・`readGhUser`・`postGhComment`）、`promoteApprove` | `promote-github-4225`（T11c・3 つの host の分類）・`promote-entrances-4225`（T11c） |
| 文書は追記だけ・新規は `link`・E の一時名の回収規則 | `doc-write.ts`（`writeDocBlock`・`reclaimDocLeftovers`・`reconcileDocBlock`）、`docOperationsFor`（`mem-promote-db.ts`：同じ行き先の E の操作） | `promote-doc-write-4225`（T5b〜T5e・T12・T21）・`promote-entrances-4225`（T21・T5e） |
| git を書かない・`gh --method` は 1 か所・常駐を持たない | E の全ソース | ガード `mem-promote-no-git-write-4225`・`promote-entrances-4225`（T16） |
| decision の状態の遷移は A の 1 つの入口だけ | `transitionDecision`（`mem-db.ts`）← `memSettleDecisionTransition`（`mem/service.ts`）← `settleTransition`・`promoteConfirmReflected`（`promote/service.ts`） | `promote-write-chain-4225`（(1)〜(3)）・`write-entrances-recreate-4221`・`close-entrances-4222`（例外の行） |
| 未解決の操作は項目の存否・closed に依らず画面に出す（5-2b P2-2） | `promoteList`（`unresolved`、`listUnresolvedPromoteOperations`。**追従**：`ambiguous` でも出す、5-2c P2-1）、`DecisionPromotePanel`（`decision-unresolved`。**追従**：closed・purge 済みには遷移を出さず `acknowledgeItemClosed` だけ、5-2c P2-3）、`screen-client.ts`（`PromoteListBody`・`acknowledgeItemClosed`） | `promote-entrances-4225`（5-2b P2-2・5-2c）・`DecisionPromotePanel-4225`（5-2c） |
| 操作の所属は同じ Git の root の全部（一覧の `readRepositoryIds` と同じ範囲、5-2c P2-2） | `promoteList`（`readIdsOf`）、**追従**：`promoteReconcile`・`promoteAbandon`・`promoteSettleTransition`（`repositoryReadIds`・`ownsOperation`） | `promote-entrances-4225`（5-2c P2-2：2 root の間の表示→回復の要求、別の Git は 404） |
| closed・purge 済みの項目は遷移しない：外部の結果の確認と項目の遷移を分ける（5-2c P2-3） | `promoteSettleTransition`（`acknowledgeItemClosed` は A を通らず遷移待ちだけを終える。遷移の要求は A の前に `item_closed`／`item_gone`）、`DecisionPromotePanel`（`operationLine` の `'closed'`）、A の状態表 `transitions.ts`（closed からの遷移を禁じる、変えない） | `promote-entrances-4225`（5-2c P2-3）・`DecisionPromotePanel-4225`（5-2c P2-3） |
| 外へ書けた後、項目が動くまでは遷移待ち（`settleTransition` の最初の同期の文で立てる、5-2c 付随）。立てる・下ろす・理由を書くはすべて読んだ値と要求の印を条件にする（§11.1 I2、5-2d）。CAS の結果は呼び手が見て、不成立なら遷移を始めない（5-2e：承認は自分の確定が成立したときだけ遷移へ進む） | `settleTransition`（`promoteApprove`・`promoteReconcile`・`promoteSettleTransition` から）、`settleOrUnknown`（成否を返す）、`settleStalePromoteAttempts`（確定の成否を数える）、`hasActivePromoteOperation` | `promote-entrances-4225`（T10・5-2c の窓・5-2e）・`promote-await-write-table-4225`（CAS の戻り値を捨てる呼び出し） |
| 外へ出す本文の見えない文字（自由入力・引用・ブランチ・作成者）は見える形にし、`invisibleReplaced` に数える。ブランチは C の `sanitizeBranch`（5-2b P2-3） | `render.ts`（`renderPromoteBody`・`branchShown`）、`promotePreview`（`invisibleReplaced` を画面へ） | `promote-render-4225`（T15・5-2b P2-3） |
| 「未反映」の表示（`recorded`） | E の画面（`DecisionPromotePanel`）と E の一覧の API（`unreflected:true`）。CLI の一覧と brief の文言は G（#4227）へ送った（§0.1 S3） | `promote-entrances-4225`（T13）・`DecisionPromotePanel-4225` |


### 11.1 不変条件 I1・I2 と、E の service の await と書き込みの全表（5-2d）

直しのたびに新しい await と書き込みが入り、そこから次の指摘が出ていた（5-2b・5-2c・5-2d）。端を 1 つずつ塞ぐのをやめ、次の 2 つを規則にする。

- **I1（世代は最初の await の前に固定し、同じ値を最後まで渡す）**：E のすべての入口は、最初の await の前に作業木の世代を固定し、その同じ値を A の入口（`memSettleDecisionTransition` の `expectedWorktreeIncarnation`）と最後の書き込みまで渡す。途中で取り直さない（`getOrCreateWorktreeIncarnation` はどの関数でも最初の await より前にしか呼ばない）。E の入口は instance を受け取らない（A の入口は作業木の世代だけを比べる）ので、instance の世代は表の対象が無い。
- **I2（状態を変える書き込みは、読んだ時点の状態を条件にする）**：操作の状態（`state`・遷移待ち `transition_pending`・その理由）を変える書き込みは、すべて読んだ時点の状態を条件にした条件つきの更新（CAS）にする。遷移は要求ごとの印（`transition_claim`、v69 の列）を持ち、A の失敗はその要求がまだ印を持っているときだけ書く。先行の要求は、後から来た確認（`acknowledgeItemClosed`）や後から来た要求の結果を上書きしない。A の成功（項目が動いた）は、遷移待ちが表していた事実そのものなので、印に依らず遷移待ちを下ろす（下ろした後に来る失敗は印が無いので書かない）。
  - **I2 の強めた形（5-2e）**：条件つきの更新（CAS）の結果は必ず呼び手へ返し、呼び手は必ず見る。不成立なら、その呼び手は後続の書き込みも自動の遷移も始めない（読み直した行は他者が決めた状態なので、そこから次の書き込みへ進まない）。`promote-await-write-table-4225` は CAS（`claimPromoteOperation`・`settlePromoteOperation`・`beginPromoteTransition`・`finishPromoteTransition`・`acknowledgePromoteTransition`・`abandonPromoteOperation`・`settleOrUnknown`）の戻り値を捨てる呼び出し（式文として呼ぶ・`await` だけの文・`void`）を service と store の両方で検出し、下の表の CAS の行はすべて「結果を見る」を書く。

**入口ごとの世代の固定**（`promote-await-write-table-4225` がこの表と実コードを突き合わせる。固定する値は最初の await より前に読まれていなければならない。`—` は世代を固定しない入口で、`getOrCreateWorktreeIncarnation` を呼ばない）

<!-- promote-generation:start -->
| 入口 | 固定する値（最初の await の前） | 渡す先 |
|---|---|---|
| `promotePreview` | `getOrCreateWorktreeIncarnation` | preview の行（`context_worktree_incarnation`）→ approve |
| `promoteApprove` | `preview.context_worktree_incarnation` | 同期の区間の照合 → operation の行 → `settleTransition` → A |
| `promoteConfirmReflected` | `getOrCreateWorktreeIncarnation` | A |
| `promoteReconcile` | — | 要求は作業木を持たない。operation に保存した世代を `settleTransition` → A |
| `promoteAbandon` | — | 作業木を使わない |
| `promoteSettleTransition` | `getOrCreateWorktreeIncarnation` | `settleTransition` → A（5-2d P1：所属の照会の await の前へ移した） |
| `promoteList` | — | 読むだけ |
<!-- promote-generation:end -->

**E の service（`src/lib/promote/service.ts`）のすべての await と、状態を変えるすべての書き込み**（同じ試験がソースの await・書き込みの呼び出しを数えてこの表と比べる。新しい await・書き込み・未分類の import・service 自身の SELECT 以外の SQL は、表に行を足すまで落ちる。自己テストの対照は、写しに足した await・書き込み・import・SQL、await の後へ戻した世代、条件を外した UPDATE をそれぞれ検出すること）

<!-- promote-await-write:start -->
| 関数 | 種類 | 呼ぶもの | 回数 | 規則（I1：await の前に固定したもの・await の後に照らし直すもの／I2：書き込みの条件） |
|---|---|---|---|---|
| `defaultOrigin` | await | `import` | 1 | 読むだけ（モジュールの読み込み） |
| `observeHead` | await | `import` | 1 | 読むだけ（モジュールの読み込み） |
| `settleTransition` | write | `beginPromoteTransition` | 1 | I2：呼び手が同じ同期の区間で読んだ `state = 'succeeded'`・`transition_pending`・`transition_claim` が変わっていないときだけ印を取る。取れなければ A を呼ばない（結果を見る：null なら何も書かない） |
| `settleTransition` | await | `memSettleDecisionTransition` | 1 | I1：呼び手が固定した世代・版をそのまま渡す（取り直さない） |
| `settleTransition` | write | `memSettleDecisionTransition` | 1 | A の入口。版（`WHERE version = ?`）と世代（`alive()`）を条件に遷移する |
| `settleTransition` | write | `finishPromoteTransition` | 2 | I2：成功は `transition_pending = 1` のときだけ下ろす。失敗の理由は自分の印（`transition_claim = ?`）がまだあるときだけ書く（5-2d P2）。結果を見る（不成立はログだけ、後続の書き込みは無い） |
| `settleOrUnknown` | write | `settlePromoteOperation` | 2 | I2：承認自身の結果は `in_flight`、または古さが作った `unknown` からだけ（人の照合・無いことの確認の後は書かない）。結果を見る：成否を `settleOrUnknown` の戻り値で呼び手へ返し、呼び手は自分の確定が `succeeded` を書いたときだけ遷移を始める（5-2e P2） |
| `promotePreview` | write | `getOrCreateWorktreeIncarnation` | 1 | I1：最初の await の前に固定 |
| `promotePreview` | await | `(deps.originUrl ?? defaultOrigin)` | 1 | I1：後の同期の区間で世代・版・指紋・mode を照らし直す |
| `promotePreview` | await | `readGhIssue` | 1 | 同上 |
| `promotePreview` | await | `readGhUser` | 1 | 同上 |
| `promotePreview` | await | `observeHead` | 1 | 同上 |
| `promotePreview` | write | `prunePromoteRecords` | 1 | 同じ取引の中で状態を読んで消す（進行中・不明・遷移待ちは消さない） |
| `promotePreview` | write | `settleStalePromoteAttempts` | 1 | I2：`in_flight`・`unknown` の操作だけを不明にする（同期の区間で試行を読んで書く） |
| `promotePreview` | write | `insertPromotePreview` | 1 | 新しい行（状態の変更ではない） |
| `promoteApprove` | write | `invalidatePromotePreview` | 1 | I2：`used_at IS NULL AND invalidated_reason IS NULL` のときだけ |
| `promoteApprove` | await | `observeHead` | 1 | I1：世代は preview の値。後の同期の区間で世代・HEAD・版・指紋・mode を照らし直す |
| `promoteApprove` | await | `readGhToken` | 1 | 同上 |
| `promoteApprove` | await | `readGhUser` | 1 | 同上 |
| `promoteApprove` | await | `readGhIssue` | 1 | 同上 |
| `promoteApprove` | await | `withMemTarget` | 1 | 照合と書き込みはこの同期の区間（コールバック）の中 |
| `promoteApprove` | write | `settleStalePromoteAttempts` | 1 | I2：同上 |
| `promoteApprove` | write | `claimPromoteOperation` | 1 | I2：preview が未使用のときだけ（`used_at IS NULL`）、一意の部分索引で進行中は 1 つ。結果を見る（不成立は `operation_in_progress`、何も書かない） |
| `promoteApprove` | write | `writeDocBlock` | 1 | 書く直前に基準の指紋をもう一度照らす（§3.3） |
| `promoteApprove` | await | `postGhComment` | 1 | 結果は `settleOrUnknown`（I2）で書く |
| `promoteApprove` | write | `postGhComment` | 1 | 外への書き込み。token・投稿者は await の前に固定した値 |
| `promoteApprove` | await | `settleTransition` | 1 | I1：operation に保存した世代・版を渡す。I2：自分の確定（`settleOrUnknown`）が `succeeded` を書いたときだけ呼び、その確定が残した遷移（`transition_pending = 0`・印なし）を条件にする。確定が不成立（古さで不明になり照合・確認・放棄が先に決めた）なら遅れて戻った応答は遷移を始めない（5-2e P2） |
| `promoteConfirmReflected` | write | `getOrCreateWorktreeIncarnation` | 1 | I1：最初の await の前に固定 |
| `promoteConfirmReflected` | await | `memSettleDecisionTransition` | 1 | I1：固定した世代と要求の版を渡す |
| `promoteConfirmReflected` | write | `memSettleDecisionTransition` | 1 | A の入口（版と世代が条件） |
| `repositoryReadIds` | await | `withSettledRepositoryMembership` | 1 | 読むだけ（所属の照会） |
| `promoteReconcile` | await | `repositoryReadIds` | 1 | 要求は世代を持たない。後で operation を読み直す |
| `promoteReconcile` | write | `settleStalePromoteAttempts` | 1 | I2：同上 |
| `promoteReconcile` | await | `listGhComments` | 1 | 後の書き込みは await の前に読んだ `unknown` を条件にする |
| `promoteReconcile` | write | `settlePromoteOperation` | 1 | I2：`unknown` からだけ（その間に承認の結果や別の照合が書いたものを上書きしない）。結果を見る（不成立は `state_forbids`、遷移を始めない） |
| `promoteReconcile` | await | `settleTransition` | 1 | I1：operation に保存した世代・版。I2：照合の確定の直後に読み直した operation を条件にする |
| `promoteAbandon` | await | `repositoryReadIds` | 1 | 後で operation を読む |
| `promoteAbandon` | write | `abandonPromoteOperation` | 1 | I2：`unknown` のときだけ。結果を見る（不成立は `state_forbids`） |
| `promoteSettleTransition` | write | `getOrCreateWorktreeIncarnation` | 1 | I1：最初の await（所属の照会）の前に固定（5-2d P1） |
| `promoteSettleTransition` | await | `repositoryReadIds` | 1 | 後で operation と項目を読む。世代は固定済みの値を使う |
| `promoteSettleTransition` | write | `acknowledgePromoteTransition` | 1 | I2：読んだ `transition_pending = 1` と `transition_claim` のときだけ下ろし、先行の要求の印を外す（5-2d P2）。結果を見る（不成立は `state_forbids`） |
| `promoteSettleTransition` | await | `settleTransition` | 1 | I1：固定した世代と要求の版。I2：同じ同期の区間で読んだ operation を条件にする |
| `promoteList` | await | `withSettledRepositoryMembership` | 1 | 読むだけ |
<!-- promote-await-write:end -->

| 共通規則 | 読む場所（ファイル・関数） | 固定している試験 |
|---|---|---|
| I1・I2 | 上の 2 表のすべての行。`mem-promote-db.ts` の `UPDATE mem_promote_operations` はすべて `state` を条件にし、遷移を変えるものは遷移の読んだ値を、理由を書くものは要求の印を条件にする。CAS の戻り値は service・store のどこでも捨てない（5-2e） | `promote-await-write-table-4225`（表と実コードの突き合わせ・自己テストの対照）・`mem-promote-transition-cas-4225`（条件つきの更新）・`promote-entrances-4225`（5-2d） |
| 遷移待ちは保持期限の削除の対象外（5-2d で §11 に未記載と指摘された読者） | `prunePromoteRecords`（`mem-promote-db.ts`：`succeeded` で `transition_pending = 0` のものだけ消す） | `mem-promote-transition-cas-4225`（保持期限） |
