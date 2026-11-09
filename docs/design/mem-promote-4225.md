# 人が差分を承認して decision を正本へ記録し、反映を確かめる（Issue #4225 / Epic #4220 の子 E）設計

- 状態：設計の段（第 2 版、実装前）。第 1 版の「止める点」は PM が決めた（§0.1）。実装は Codex の事前レビューの後、同じブランチの別の契約で行う
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
                                                         ├─ 照合で無いと確定（文書のみ）→ failed
                                                         └─ 確定できない → unknown のまま（人に照合を求める）
   書く直前の照合の不一致 → conflict（書いていない。再承認へ）
```

- `succeeded` の後に項目の遷移が書けなかった（項目の版が変わった・mode が `on` でない・DB の更新が失敗した）ときは、operation に `transition_pending=1` を残す。画面は「書けたが項目は進んでいない」を出し、人が今の版で「記録済みとして扱う」を押すと、その版で遷移だけを行う（外へは書かない）［見立て］。同じ項目に `succeeded` の operation があるときの新しい preview は、既にある記録（コメントの URL・文書のパス）を先に出し、二重の記録を人に選ばせる

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

### 2.2 行き先と基準の指紋

| 行き先の種類 | `destination`（正規化） | `base_fingerprint` | 照合で見るもの |
|---|---|---|---|
| Issue・PR のコメント（`issue:[host/owner/repo]#N`・`pr:…#N`。文法は A `validate.ts` の `ISSUE_REF`） | `{kind:'issue_comment', host（小文字）, owner, repo, number}`。target を省いた `issue:#N` は項目の repository の `origin` で解決する（B §1.2 と同じ解決）。host は `hostAllowed`（`github-query.ts:63`：`github.com` か `origin` の host）を通るものだけ | `gh api repos/{o}/{r}/issues/{N}` の `node_id`・`repository_url`・`state`・`locked`・本文の SHA-256 | Issue が別のものになった（移管・削除して同じ番号）、閉じた・ロックされた、本文が変わった。**他人のコメントの増減は見ない**（コメントは追記で、既存の内容を上書きしない） |
| 作業木の文書（`path:<rel>`） | `{kind:'worktree_doc', repositoryId, branch, worktreeId, worktreeIncarnation, path（正規化後の相対）}`。worktree は人が画面で選ぶ（項目の repository の登録 root に属する worktree だけ、`withMemTarget` の `readRepositoryIds` に項目の `repository_id` が入るもの、`target.ts:116`） | ファイルの内容の SHA-256（無いときは `absent`）・大きさ・観測した HEAD のブランチと common-dir（`observeWorktreeHead`、`git-observe.ts:23`） | 承認の後に文書が変わった、worktree を消した・作り直した（世代の不一致）、別のブランチへ切り替えた、別の git になった |

### 2.3 書く直前の照合（approve の手順）

1. 画面の印（§4.2）を確かめる。無ければ 403 `screen_only`（書かない・数えない）
2. 要求を受けた時点で、context の worktree の世代と、文書なら行き先の worktree の世代を固定する（A §10.4 と同じ型）
3. 文書の行き先なら `observeWorktreeHead` で HEAD を観測する（`await`）。コメントなら `gh api` で Issue を読む（`await`、§2.2）
4. **同期の区間**（better-sqlite3 は同期なので他の要求は入らない、A §5.3）で次をすべて照合する。1 つでも違えば **何も書かず**、operation を作らず、409 `reapproval_required`（`reason` を 1 語：`item_changed`・`destination_changed`・`base_changed`・`worktree_recreated`・`branch_changed`・`expired`・`mode_not_on`・`rules_changed`・`withheld`）を返し、preview を無効にする
   - preview が期限内・未使用、項目の今の版が `item_version` と一致、`item_fingerprint` が一致、項目が `open`（`spec`・`record_only`）
   - 項目の `(repository_id, branch)` の mode が `on`（`memModeOnFor`、`mem-close-db.ts:99`。曖昧・未登録は `on` ではない）
   - 項目が今の規則で withheld でない（`findWithheld`、`present.ts:70`）
   - context・行き先の worktree の世代が固定した値と同じで、今も生きている（`worktreeIncarnationAlive`、`incarnation.ts:170`）
   - 文書：手順 3 の HEAD のブランチ・common-dir が preview と同じ。ファイルの内容の SHA-256 を **この区間で同期に読み直して**（`fs.readFileSync`）`base_fingerprint` と一致
   - コメント：手順 3 の Issue の指紋が `base_fingerprint` と一致
   - 同じ項目に進行中（`approved`・`in_flight`・`unknown`）の operation が無い（一意の部分索引でも守る、§6.1）
5. 同じ区間で operation（`approved`）と attempt（`in_flight`、`boot_id` = 今の process）を INSERT し、preview を使用済みにする
6. 外へ書く（§3.2・§3.3）。結果で attempt を確定する（§3.4）

- コメントの照合（手順 3）と書き込み（手順 6）の間には `await` がある。その間に Issue の本文が変わっても、コメントは追記なので既存の内容を失わない（受入基準の「既存の変更を失わない」は満たす）。文書は手順 4 で同期に読み直し、手順 6 の書き込みも同期で行う（§3.3）ので、CommandMate の中の別の要求は入らない。**同じ OS 権限の別のプロセスが手順 4 と 6 の間に文書を書く** 窓は残る（§5.5 の限界）
- 同じ項目を 2 つの画面で並行に承認：先に手順 5 へ着いた方だけが operation を作る。後の方は「進行中の operation がある」か「版の不一致」で 409。既存の変更は失わない

---

## 3. 外へ書く操作：operation／attempt と結果が不明なとき

### 3.1 原則

- **不明を未送信として扱わない**。自動の再送はしない。再送は「失敗が確定した」か「照合で書かれていないと確定した」後の、**新しい承認**（新しい preview → 新しい operation）だけ
- 1 つの operation の attempt は原則 1 回。照合（§3.4）は attempt ではない（外へ書かない）
- 成功の地点：コメントは **作成の応答で ID を得たとき**、または **印の照合で見つけたとき**。文書は **書いた内容を読み直して一致したとき**

### 3.2 Issue のコメント

- 本文の末尾に一意の印を入れる：`<!-- commandmate-promote:op=<operation id>; item=<item id> -->`（operation id は `randomUUID`）
- 送り方：`gh api --method POST --hostname <host> repos/<o>/<r>/issues/<N>/comments --input -`（本文は JSON で stdin。引数に本文を載せない）。実行の口は E の新しい関数（`ghApi` は GET だけで、本文を渡す口が無い、`github-query.ts:50-53`［事実］）。`hostAllowed`・`repoPath`（`github-query.ts:55`）は再利用する
- 応答の分類（`classifyGhFailure`、`github-query.ts:18` の語を再利用し、E で「確定した失敗」と「不明」に分ける）［見立て］：

| 結果 | attempt | operation |
|---|---|---|
| exit 0 で JSON に `id`・`html_url`・`node_id` がある | `success`（`result_ref` = comment id と URL） | `succeeded` |
| HTTP 4xx（401・403・404・410・422。429 を除く） | `failure`（GitHub は作っていない） | `failed` |
| `gh` が無い（`missing`）・host の不許可・本文の検査の不合格（送る前） | `failure`（送っていない） | `failed` |
| タイムアウト・中断・offline・HTTP 5xx・429・`overflow`・exit 0 だが JSON が読めない | `unknown` | `unknown` |
| attempt を書いた process が無い（`boot_id` が違う）か、`in_flight` のまま一定時間（10 分、B の `MEM_NOTICE_ATTEMPT_STALE_MS` と同じ値、`mem-close-db.ts:37`）を過ぎた | `unknown`（読むときにそう扱い、次の書き込みの区間で確定させる） | `unknown` |

- **GitHub が受理した後に応答が切れた**：`unknown` になり、照合（§3.4）で印を見つけて `succeeded` にする。再送しない
- **書けた後の DB の更新が失敗した**：attempt は `in_flight` のまま残る（DB の行は書く前に作ってある、§2.3 の 5）。同じ process の中では例外を握って `unknown` に落とす試みを 1 回だけする。それも失敗すれば、次に読んだときに古い `in_flight` として `unknown` に見え、照合で見つかる
- **並行の再試行**：進行中の operation の一意の部分索引（§6.1）と、`in_flight` の attempt が 1 件だけであること（`attempt` の INSERT は operation の状態を `approved`→`in_flight` に変える同じ文で条件つき）で、2 つ目の要求は 409 `operation_in_progress`

### 3.3 作業木の文書

- 書き方：既存の文書の末尾に、印つきの区画を足す（`<!-- commandmate-promote:op=…; item=… -->` で始まり、決まった終わりの行で閉じる）。既存の行は変えない［見立て：最小の差分。見出しの下へ差し込む形は後で］。拡張子は `.md` だけ、大きさは 1 MiB まで［見立て］
- 手順（すべて §2.3 の 4 と同じ同期の区間）：
  1. §5.3 のパスの検査を **もう一度** 行う（承認から時間が経っている）
  2. 内容を読み直し、`base_fingerprint` と一致を確かめる（§2.3 の 4）
  3. 同じディレクトリに一時ファイル（`O_CREAT|O_EXCL`、名前は operation id から）を書き、`fsync`、元のファイルの mode を写し、`rename` で置き換える。`rename` は最後の成分が symlink・hardlink でもそのリンクを辿らずに置き換える（リンク先を書き換えない）
  4. 読み直して、書いた内容の SHA-256 と一致すれば `success`（`result_ref` = 相対パスと SHA-256）。違えば `unknown`
- 例外で途中が分からなくなったとき（process の終了を含む）の照合は、読み直しで **確定できる**：今の内容が書いた内容と一致 → `succeeded`、`base_fingerprint` と一致し一時ファイルが無い → `failed`（書いていない）、どちらでもない → `conflict`（誰かが変えた。書かない。人へ）
- commit・add・push・stash・checkout など git の書き込みは呼ばない（§5.4、ガードで固定）

### 3.4 不明のときの照合（reconcile）

- 画面の「照合する」（印つきの要求）でだけ行う。読むたびの自動の照合はしない（外への照会の回数を増やさない。常駐・定期の実行を足さない、D8・D13）［見立て］
- コメント：`gh api --paginate repos/<o>/<r>/issues/<N>/comments`（GET）で、**本文に印があり、作者が `gh api user` の login と同じで、本文の SHA-256 が operation の `body_sha256` と同じ** コメントを探す。見つかれば `succeeded`（`result_ref` を写す）。印を偽った他人のコメントを成功と読まないため作者と本文の指紋も見る
  - 照会が失敗（offline・403 等）：`unknown` のまま。画面に「照合できない」と理由を出す
  - 照会は成功したが見つからない：**`unknown` のまま**（GitHub の一覧の反映の遅れを否定できない）。画面は「見つからない」と時刻を出し、人が「GitHub で無いことを確かめた」を押したときだけ operation を `abandoned`（人の判断で未送信とみなす、`decided_by='human'`）にする。その後は新しい承認でだけ書ける
- 文書：§3.3 の読み直しで確定する（人の判断は要らない）

---

## 4. 画面（最小の 1 画面）と「変える経路は画面だけ」

### 4.1 画面

- ページ：`/repositories/[id]/mem/decisions?branch=<name>`（新規、`src/app/repositories/[id]/mem/decisions/page.tsx`）。PC・スマホ共通（`useIsMobile` で並びだけ変える、A §11.1 と同じ作り）。`/repositories` の行の mem の設定（`RepositoryMemSettings`）から開く
- 部品：`src/components/mem/DecisionPromotePanel.tsx`（新規。G #4227 の画面はこの部品を使う）。1 画面に次だけを置く：
  1. その branch の decision の一覧（`open`・`recorded`。`recorded` には **「未反映：コメントに記録しただけで、正本（Issue の本文など）へはまだ反映されていません」** の警告。進行中・不明の operation があればその印）
  2. 選んだ項目の preview：行き先（種類・host/owner/repo/#N、または worktree・ブランチ・パス）、書く本文の全文（差分）、引用の出所の表示（§5.1）、効果の選択（`spec`／`record_only`、既定 `spec`）、期限
  3. ボタン：「承認して書く」・「やめる」（何も書かない。preview を捨てる）・`recorded` なら「正本へ反映したことを確かめた」・`unknown` なら「照合する」と「GitHub で無いことを確かめた」・`succeeded` で `transition_pending` なら「記録済みとして扱う」
- 409 `reapproval_required` を受けたら、理由の語を出して preview を作り直す（自動で承認し直さない）

### 4.2 書き込みの API と印

| API（新規） | 印 | 中身 |
|---|---|---|
| `POST /api/repositories/:id/mem/decisions/:itemId/preview` | 要る | `{branch, destination?, worktreeId?, effect, quoteConfirmed?, quoteText?}` → preview（本文・指紋・期限） |
| `POST …/:itemId/approve` | 要る | `{previewId, itemVersion, baseFingerprint, bodySha256}`（画面が見たものを送り返す。本文は受け取らない）→ §2.3 |
| `POST …/:itemId/confirm-reflected` | 要る | `{ifVersion}` → `recorded → promoted` |
| `POST …/operations/:opId/reconcile` | 要る | — → §3.4 |
| `POST …/operations/:opId/abandon` | 要る | `{ifState:'unknown'}` → `abandoned` |
| `POST …/operations/:opId/settle-transition` | 要る | `{ifVersion}` → `transition_pending` の遷移だけ |
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

- 自由入力（`text`・`quote`）は **フェンスの中** に入れる。フェンスの長さは中身の最長の連続した backtick より 1 つ長くする。これで Markdown の差し込み、`@name` の通知、`#N` の自動リンクを起こさない（GitHub はコードの中の mention を通知しない［未確認：実測は実装の契約で fixture の Issue を使わずに文書で確かめる］）
- `evidence` は出さない（構造化した参照で、正本の読者に要らない）［見立て］

### 5.3 パスの正規化（文書の行き先）

1. `promote_to` の `path:` は A の検査（`validatePromoteTo`→`normalizeRepoPath`、`validate.ts:277`・`:185`）を **選んだ worktree の root で** もう一度かける：絶対パス・`~`・NUL・バックスラッシュ・ドライブ文字を断る、`..` で外へ出るものを断る、`findSensitivePathSegment` の当たる成分を断る、root から各成分を `lstat` して symlink を断る（`:213`）［事実］
2. E で足す検査（A の関数は変えない）：root 自身が symlink でない（`realpath(root) === path.resolve(root)`）、`.git` の成分を断る、最後の成分が存在するなら通常のファイルである、拡張子が `.md`、大きさの上限。**`normalizeRepoPath` は promote_to で最初の無い成分で止まる**（`validate.ts:204-211`：`mustExist=false` なら `break`）ので、無いディレクトリの下は作らない（親ディレクトリが存在することを求める）［見立て］
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

- 限界：同じ OS 権限のプロセスは §2.3 の照合と書き込みの間に文書を書ける。DB の operation の行を書き換えて「成功」にもできる。CommandMate はこれを防がない（A §11.3）

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
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE mem_promote_operations (
  id TEXT PRIMARY KEY,                   -- 印に入る operation id
  preview_id TEXT NOT NULL,
  item_id TEXT NOT NULL,                 -- FK なし
  item_version INTEGER NOT NULL,
  repository_id TEXT NOT NULL, branch TEXT,
  destination_kind TEXT NOT NULL CHECK (destination_kind IN ('issue_comment','worktree_doc')),
  destination TEXT NOT NULL, base_fingerprint TEXT NOT NULL,
  body TEXT NOT NULL, body_sha256 TEXT NOT NULL,
  effect TEXT NOT NULL, quote_origin TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('approved','in_flight','succeeded','failed','unknown','conflict','abandoned')),
  result_ref TEXT,                       -- comment id・URL / パスと SHA-256
  transition_pending INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT CHECK (decided_by IN ('server','human')),
  approved_at INTEGER NOT NULL, settled_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_mem_promote_active ON mem_promote_operations(item_id)
  WHERE state IN ('approved','in_flight','unknown');

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
- 保持：`succeeded`・`failed`・`abandoned`・`conflict` の operation と使った preview は 90 日、未使用の preview は期限の後に、次の書き込みの区間で消す（定期の実行を足さない）［見立て］

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

- `src/lib/db/mem-db.ts`：`transitionDecision(db, alive, itemId, expected:{version}, transition:'record'|'promote'|'promote-record-only', now)` を 1 つ足す。トランザクションの最初に `alive()`（要求時に固定した context の worktree の世代が今も同じか）を聞き、`memTransition`（`transitions.ts:27`）で遷移を検査し、`UPDATE mem_items SET state=?, version=version+1, updated_by='human', updated_by_instance=NULL, updated_at=? WHERE id=? AND version=? AND state=?` で書く。失敗は既存の `MemStoreFailure`（`instance_not_found`/`incarnation_changed`・`item_not_found`・`version_conflict`・`state_forbids`、`mem-db.ts:323`）で返す。既存の関数・private の helper の振る舞いは変えない
- `src/lib/mem/service.ts`：入口 `memSettleDecisionTransition(db, spec, itemId, body)` を 1 つ足す。要求時に context の worktree の世代を固定し（`lookupActor` は `by:'human'`）、`withMemTarget` で項目の `(repository_id, branch)` の mode を同じ同期の区間で決め、`on` でなければ store を呼ばずに 409 `disabled`。E の lib（`src/lib/promote/service.ts`）からだけ呼ぶ
- `tests/unit/lib/mem/write-entrances-recreate-4221.test.ts`：`ENTRANCES` に行を足す（§7.1）。既存の行・`it`・期待値は変えない
- `src/lib/db/migrations/runner.ts`：v69 の登録

---

## 7. 不変条件の表駆動の試験（全入口）

E の書き込みの入口（approve・confirm-reflected・reconcile・abandon・settle-transition）。A の側に足す入口は A の表に足す（§7.1）を 1 つの表に並べ、各行で同じ不変条件を回す（`tests/unit/lib/promote/promote-entrances-4225.test.ts`）。A の I18 と同じく、**表のキーは E の service の export のうち DB の書き込み・外への書き込みに届くものから列挙**し、入口を足すと表に足すまで落ちる。外への書き込みは偽の `gh`（`execFile` の差し替え）と `os.tmpdir()` の `mkdtempSync` の作業木で行い、`afterEach` で消す。本物の GitHub に書かない。

| # | 不変条件 | 陽性対照（直す前・壊した実装で落ちる） | 陰性対照（変わらない） |
|---|---|---|---|
| T1 | 画面の印が無い要求は 403、何も書かない（operation・attempt・外への呼び出しが 0） | 印の検査を外した版で外への呼び出しが 1 | 印つきは通る |
| T2 | mode が `off`・`derived`・曖昧・未登録では preview・approve・confirm は断り、外へ書かない | mode の照合を外した版で `off` の approve が書く | `on` は書く |
| T3 | 承認の後に項目が変わった（`mem update` で `version+1`）→ 409 `item_changed`、書かない | 版の照合を外した版で書く | 版が同じなら書く |
| T4 | 作り直し後の古い要求：preview の後に context／行き先の worktree を同じ ID・path で消して作り直す → 409 `worktree_recreated`、書かない（A §16 I17 と同じ形） | 世代の照合を外した版で書く | 作り直さなければ書く |
| T5 | 文書を承認の後に別のプロセスが変えた → 409 `base_changed`、文書は他者の内容のまま | 基準の照合を外した版で他者の変更を上書き | 変わらなければ追記される |
| T6 | 選んだ worktree で別のブランチへ切り替えた → 409 `branch_changed` | — | — |
| T7 | 同じ項目を並行に承認（`await` の間に 2 本目を進める）→ 1 本だけ書く、2 本目は 409 | 一意の索引を外した版で 2 回書く | 1 本なら書く |
| T8 | GitHub が受理した後に応答が切れた（偽の `gh` が作ってからタイムアウト）→ `unknown`、再送しない。照合で `succeeded`、コメントは 1 件 | 不明を失敗と読む版で 2 件 | 確定した 4xx は `failed` |
| T9 | 書けた後に DB の更新が失敗（settle で例外）→ 次の読みで `unknown`、照合で `succeeded`、外への書き込みは 1 回 | — | — |
| T10 | 並行の再試行（`unknown` に 2 本の reconcile・2 本の再承認）→ 外への POST は増えない | — | — |
| T11 | 照合で印は見つかったが作者・本文の指紋が違う → `succeeded` にしない | 印だけで見る版で成功と読む | — |
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
- 遷移の表（`memTransition`）に無い組（`recorded` に `record`、`open` に `promote` など）は 409 `state_forbids`。これは A の `transitions` の試験が持つので、E では入口から 1 本だけ確かめる

- ガード：§4.2（CLI に口が無い）、§5.4（git の書き込み・`gh --method` は E の 1 か所だけ・mem/brief の lib が fs に書かない）、§6.2（常駐を持たない）
- 受入基準との対照：「拒否・取り消し・差分の変更・無人で書かない」= T1・T2・T3・T14／「別のセッションが文書を変えた・worktree を消した・別のブランチ・並行の承認」= T4〜T7／「受理後に応答が切れた・DB の更新が失敗・並行の再試行で二重に書かない」= T8〜T10／「`recorded` のままで警告、確かめた後に `promoted`」= T13（re-plan の例は H #4228 の受入と共有）／「repository の外・symlink を断る」= T12／「この Issue が入るまで外へ書かない」= §5.4 のガード

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
| U7 | `transition_pending` の「記録済みとして扱う」は人が今の版で確かめる操作。Agent が書き換えた内容がコメントと違うまま `recorded` になりうる。差分を出して確かめさせるか |
| U8 | 同じ OS 権限のプロセスによる §2.3 の 4〜6 の間の文書の書き換え（§5.5）。`O_NOFOLLOW` の open と `rename` の間の窓は Node で閉じられない |

### 8.5 本文に無い指摘（この Issue では直さない）

- `docs/design/mem-store-4221.md` §3.2 の「`recorded` の `mem close` は断る。人が画面で閉じる」に対し、`src/lib/mem/transitions.ts:45-48` は `recorded` の `close` を人の経路も含めて断る。人が閉じる遷移は無い（§0.1 S2 で G #4227 へ送った）
- `tests/unit/lib/mem/write-entrances-recreate-4221.test.ts:291` の「store の書き込みは service だけ」は関数名の文字列で見るので、新しいファイルが `UPDATE mem_items` を直接書く経路を検出しない
