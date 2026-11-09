# mem の閲覧・編集と、対話・無人に応じた開始と終了の流れ（Issue #4227 / Epic #4220 の子 G）設計

- 状態：設計の段（第 1 版、実装前）。`src/`・`tests/` は変えていない。実装は Codex の事前レビューの後、同じブランチの別の契約で行う
- 前提：Epic #4220 の決定事項 D1〜D13（とくに D3・D5・D6・D9・D11）。A（#4221）`docs/design/mem-store-4221.md`（以下「A」）、B（#4222）`docs/design/mem-close-when-4222.md`（「B」）、C（#4223）`docs/design/brief-4223.md`（「C」）、D1（#4274）`docs/design/session-boundary-brief-4274.md`（「D1」）。並行の D2（#4224）`brief-injection-d2-4224.md`（`feature/4224-worktree` `d21b22712`、「D2」）と E（#4225）`mem-promote-4225.md`（`feature/4225-worktree` `78ceab299`、「E」）は読むだけ
- 凡例：**［事実］** = この文書を書いた時点（2026-11-09、`feature/4227-worktree` = develop `55b8192e0`）でファイルと行を読んで確かめたもの。**［見立て］** = 設計としての判断。**［未確認］** = 読んでいない・実測していないもの。行番号は確認時点のもので、実装の契約では名前で探し直す

---

## 0. 止める点（PM へ返す）

契約の「止める条件」に当たる点が 5 つある。どれも **最小の追加の案** を書き、作らずに止める（この文書の §1 以降は、案を採ったときの設計）。

| # | 止める点（箇所と理由）［事実］ | 最小の追加の案［見立て］ | 採らないときの代わり |
|---|---|---|---|
| **S-A** | **人が画面で項目を追加・編集・close する入口が無い。** A の項目の書き込みの入口 `memAddItem`（`src/lib/mem/service.ts:362`）・`memUpdateItem`（`:427`）・`memCloseItem`（`:479`）は、どれも `lookupActor(db, worktreeId, body.instanceId, 'agent')`（`:368`・`:434`・`:486`）で **Agent として** 書く。人（`'human'`）で書くのは #2427 の画面のメモ `writeSessionNoteFromScreen`（`:731`・`:737`）だけ。store の側は人を受けられる（`ownedBy` は `actor.by === 'human'` なら真、`src/lib/db/mem-db.ts:857-858`。`createMemItem` は `actor.by` を `created_by`・`updated_by` に書く、`:733-734`）。`lookupActor` は private で、版・世代・mode の照合も service の中にある。G の lib から mem-db を直接呼ぶと、A の試験「store の書き込みは service からだけ」（`tests/unit/lib/mem/write-entrances-recreate-4221.test.ts`、E §7.1 が `:290-295` と引く）を破り、照合を写すことになる | `src/lib/mem/service.ts` に入口を **1 つ** 足す：`memWriteFromScreen(db, worktreeId, body, deps)`。`body = { op:'add'\|'update'\|'close', instanceId, itemId?, ifVersion?, kind?, text?, closeWhen?, evidence?, reason?, pin?: { worktreeIncarnation, instanceIncarnation }, author: 'human'\|'proposer' }`。中は既存の `memAddItem`・`memUpdateItem`・`memCloseItem` と同じ検査（validate・`parseCloseWhen`・`resolveTarget` の mode `on`）を通し、`lookupActor` の `by` だけを `author` から決める（`human` → `'human'`、`proposer` → `'agent'`）。`pin` があれば、`lookupActor` が固定した世代と `pin` が違うとき 409 `incarnation_changed`（E の S1 の案 1 と同じく「比較する元の世代は呼び手が渡す」）。**既存の 3 つの入口の振る舞いは変えない**。`ENTRANCES` に行（`screen-add`・`screen-update`・`screen-close`・`proposal-add`）を足し、既存の 3 つの不変条件（作り直し後の古い要求・`off`/`derived`・版の競合）を表の行で回す。呼び手は G の lib（`src/lib/handoff/**`）と G の route だけ（ガードで固定） | 人の編集を #2427 の `now` の枠だけにし、他の kind の追加・編集・close と、終了の流れの「確定」を作らない（受入基準の「一覧・編集・同時編集の競合」と「承認した提案だけを確定」を満たせない） |
| **S-B** | **開くときの「全文を読む」「読まない」を送信へ渡す口が無い。** 送信の route は `brief` に `'skip' \| 'force'` だけを受ける（`src/app/api/worktrees/[id]/send/send-request.ts:56`・`:101-105`）。`skip` は「この送信だけ付けない。境界は `pending` のまま」（`src/lib/session/session-brief.ts:247-251`）なので、次の送信に brief が付き「読まない」にならない。予算は `briefBudget` が `provider.defaultBytes`（text 4,096、`src/types/brief.ts:38`）で頭打ちにする（`session-brief.ts:101-111`）ので「全文」を頼めない。D2 はこの 2 つを足さない（D2 §0.1・§9.1 の変えるファイルの表） | D1 の口に **欄を 2 つ足す**（意味を変えない）：(1) `brief: 'decline'` — 境界を `skipped(declined)` として消費し、この送信には付けない（`BoundarySkipReason` に `'declined'` を足す、`src/lib/db/session-brief-db.ts:28-35`）。(2) `briefDetail: 'short' \| 'full'`（`brief` が無い＝`auto`・`force` のときだけ）— `full` は `briefBudget` の上限を `BRIEF_BUDGET.text.max`（49,152）にする。どちらも #2464 の上限（`SEND_VERIFIED_MAX_BYTES`）の内で、利用者の本文は削らない（D10）。D2 が `send-request.ts`・`session-brief.ts`・`send/route.ts` を変えている最中なので、**D2 に含めるか、D2 のマージの後に G の PR で足す** のどちらかを PM が決める（並行で同じ所を変えると衝突する） | 画面の選択を「短い要約を読む（`auto`）／今回は読まない（`skip`、次の送信に付く）」の 2 つにし、「全文」は `commandmate brief --all` の案内の 1 行を画面に出すだけにする（Issue の 3 択を満たせない） |
| **S-C** | **「終わる前の更新」の記録を D2 の読み口に渡す場所が C のファイルになる。** D2 は読み口 `readPreEndUpdate(db, { worktreeId, instanceId, before })` → `'recorded' \| 'not_recorded'` を `src/lib/brief/sources.ts`（C のファイル）に置き、「G・F が書き手になるまでは常に `not_recorded`」とする（D2 §7.2 X4・§9.1 の表）。G がその中身を書き換えると C のファイルを変える | D2 の実装の契約で、読み口の **本体を G の新しいモジュール `src/lib/handoff/pre-end.ts` に置き、`sources.ts` はそれを呼ぶだけ** にしてもらう（D2 の時点では `pre-end.ts` は常に `not_recorded` を返す 1 関数）。G はそのファイルの中身を書く。D2 が先にマージされて `sources.ts` に本体があるなら、G で `sources.ts` の 1 行（呼び先）を変えることを許す | G は記録（§5.6 の表）だけを作り、D2 の読み口は `not_recorded` のまま残す（次の世代の先頭の行が「確認できない」を出し続ける。安全側だが、確かめた終了も「確認できない」と出る） |
| **S-D** | **S2：`recorded` の decision を人が閉じる遷移が無い。** `memTransition('decision','recorded','close')` は `{ ok:false }`（`src/lib/mem/transitions.ts:45-48`）。A §3.2 は「`recorded` の `mem close` は断る。人が画面で閉じる」と書くが、人の経路も遷移の表で断られる。E は作らない（E §0.1 S2） | `transitions.ts` に遷移を **1 つ** 足す：`'withdraw-recorded'`（`recorded` → `closed`、`close_reason='withdrawn'`）。人の画面の入口（S-A の `memWriteFromScreen` の `op:'close'`、`author:'human'`）だけがこの遷移を使い、CLI の `mem close`（Agent）は今どおり 55 `state_forbids`。画面は「正本へは反映しないことにして閉じる」と明示した確認（2 段の押下）の後でだけ送る。§6 S2 | `recorded` は「反映を確かめた」（E の `confirm-reflected` → `promoted`）の後に閉じるだけにする。反映しないと決めた decision は `recorded` のまま残り、14 日で「未反映・古い」の警告が出続ける（`staleness.ts:19-35`）。purge も既定で除く（A §8.3） |
| **S-E** | **mode の画面を広げると A の部品を変える。** mode の画面は A の `src/components/mem/RepositoryMemSettings.tsx`（`RepositoryList.tsx:752` で描く）。Issue は「A の最小の画面を広げる」 | **画面の部品だけ**（lib・API・DB は変えない）の変更として許してもらう：各 mode の説明・機能の切り替えの文言（とくに `popup` を「対話：開始・終了の確認を画面に出す」と書く、§5.1）・スマホの幅の並び・worktree の画面から今のブランチの上書きを開く入口。API は既存の `memSettingsApi`（`src/lib/mem/screen-client.ts`）のまま | 新しい部品 `src/components/mem/MemModePanel.tsx` を作って `RepositoryList.tsx` の描く先を差し替える（A の部品は残る＝使われないコードが残る）。推奨しない |

D1〜D13 と違う作りは採らない。D の文面だけでは一意に決まらず、この文書が選んだ解釈は §0.1。

**D2・E の worktree とファイルは触っていない**（`git -C … show HEAD:…` で読んだだけ）。

### 0.1 選んだ解釈

| # | 文面 | 選んだ解釈 | 理由 |
|---|---|---|---|
| G1 | D11「無人かどうかは人が選ぶ設定」と、A の機能の切り替え `popup`（`mem_repository_settings.popup`・`mem_branch_overrides.popup`、A §10.1 の「G が読む」） | **`popup` を「対話の扱い」の設定として使う。** `popup=1`（対話）＝開くとき・閉じるときに画面に確認を出す。`popup=0`（無人、既定）＝出さない。単位は A と同じ repository の既定＋ブランチの上書き（D4）。保存先は DB（A の表）、変える経路は画面だけ（A §11.2 の印、既にある） | 新しい表・新しい書き込みの経路を足さずに D11 を満たす。auto-yes の状態（`auto-yes` の表・API）とは別の置き場で、互いに読まない。既定 `0` は D3 の既定 `off` と同じ向き（人が選ぶまで何も出さない）。worktree・セッション単位の「いま見ている」の切り替えは採らない（§5.1 の注） |
| G2 | Issue「Agent は通常の CLI では確定せず、提案として置き場に出す」 | 終了の流れの依頼の中で Agent が使う口は **提案の口だけ**（`commandmate handoff propose`）。依頼の文面がそれを指示する。ただし同じ時間に Agent が `mem add` などで直接書くことは **止めない**（止めるには A の入口すべてに G を呼ばせる必要があり、同じ OS 権限では保証にもならない、A §11.3）。直接書かれた更新は画面に「提案を経ずに確定した更新」として別の欄に出し、巻き戻さない | Issue の「確定済みの更新は巻き戻さない」と同じ扱い。止められない書き込みを止めたことにしない（D3 の検査の限界） |
| G3 | Issue「開くとき：3 行の preview つきで選ぶ」 | 「開くとき」＝画面から送る **最初の送信の直前** に、その instance に `pending` の境界がある（D1 の台帳）とき。CLI・orchestrate・Timer など画面の外からの送信ではポップアップは出ず、`auto`（短い要約）になる | D1 の境界は「次の付けてよい送信」で消費される（D1 §3）。画面がそれより先に人へ聞ける時点は、画面の送信の直前だけ |
| G4 | Issue「人が承認した提案だけを、項目の版を照合して確定する」 | 提案は **作った時点の項目の版（`base_version`）** を持つ。確定は「人が画面で見た提案の指紋」と `base_version` を送り返し、今の項目の版と一致したときだけ書く（S-A の入口の `ifVersion`）。違えば提案は `conflict` になり、今の項目と並べて出し直す（自動で今の版に載せ替えない） | E の preview と同じ考え方（E E2）。承認を「人が見たもの」に結ぶ |
| G5 | Issue「『終わる前の更新を確認できない』事実を次の世代へ残す」 | 「確認できた」を **狭く** 定義する：その instance の終了の依頼が、Agent の応答（`done`）・人の全提案への判断（承認して確定 or 捨てる）・確定の全成功・画面からの kill の成功の **全部** を満たしたときだけ `confirmed`。1 つでも欠ければ `unconfirmed`（理由の語つき）。依頼が無い終わり方（CLI・異常終了・orchestrate の掃除）は記録が無い＝確認できない | D2 §7.1 の文言は「確認できない」で断定しない。確認できなかった側に倒す（「確かめた」と誤って出す方が害が大きい） |

---

## 1. 事実の照合（契約の説明と実コード）

| 契約の説明 | 実コード［事実］ | 判断 |
|---|---|---|
| mode の画面（A の最小の画面） | `RepositoryMemSettings.tsx`（規則・上書き・機能 3 つ）。書き込みは `memSettingsApi`（`screen-client.ts`）が `screenRequestHeaders()` を付け、`settings-service.ts:37` が `isScreenRequest` で断る | そのまま使う（S-E） |
| A §11 の screen-request の印 | `src/lib/security/screen-request.ts`：`X-CommandMate-Client: screen` と `Origin` の一致（`isScreenRequest`、`:52`）。B の知らせの引き取りの route も使う（`notices/[noticeId]/acknowledge/route.ts:17`） | G の書き込みの route はすべてこれを使う |
| 項目の API（A） | `POST /api/worktrees/:id/mem/items`・`PATCH …/items/:itemId`・`POST …/items/:itemId/close`・`POST …/mem/now`。どれも `instanceId` で Agent として書き、印を見ない | Agent の口。人の口は無い（S-A） |
| 一覧の API（A） | `GET /api/worktrees/:id/mem`（`?branch=`・`?all=1`）・`GET /api/repositories/:id/mem?branch=`（worktree が無いとき） | 画面の一覧はこれを読む |
| 未配送の知らせ（B） | `GET /api/repositories/:id/mem/notices?branch=`（読み）と `POST …/notices/:noticeId/acknowledge`（印つき）。部品は G（B §0 S4） | G の画面に一覧と引き取りを置く |
| 終了のボタン | PC：`desktop-kill-session`（`WorktreeDetailSubComponents.tsx:1336-1347`）→ 確認の Modal（`WorktreeDetailDesktop.tsx:1215-1233`）→ `handleKillConfirm`（`src/hooks/useWorktreeDetailController.ts:1823`）→ `worktreeApi.killSession(worktreeId, cliToolId, instanceId)`（`:1860`）→ `POST /api/worktrees/:id/kill-session`。スマホ：`MobileTerminalActionsSheet` の「終了」から同じ `openActiveKillConfirm`（`WorktreeDetailRefactored.tsx:1277-1279`） | 終了の流れは `handleKillConfirm` の前に挟む（PC・スマホで同じ hook、§4） |
| 送信の brief の欄 | `send-request.ts:56`（`'skip' \| 'force'`）、route は `body.brief ?? 'auto'`（D1 §4.1 の表） | S-B |
| 送信の呼び出し元の固定 | `tests/unit/guards/session-brief-send-callers-4274.test.ts` の `CALLERS` が `sendUserMessage(` の呼び出し元を全部固定 | G は **サーバから `sendUserMessage` を呼ばない**。終了の依頼の文は画面が既存の送信の route で送る（§4.2）。呼び出し元の表は変わらない |
| 「人への質問」 | A の kind に無い（`src/types/mem.ts:14`）。C は導いた状態（開いた待ち・relay の `prompt`）として順位 1 に置く（C §0 G1） | preview の 2 行目は C の順位 1 の件数（§3.1） |
| 古さ | `memItemStaleness`（`src/lib/mem/staleness.ts`）を list・F・G が共有（同ファイルの先頭のコメント） | G の一覧は同じ関数の結果（`stale` 欄）を出す。写さない |
| 最新の migration | `CURRENT_SCHEMA_VERSION = 68`（`runner.ts:34`）。E が v69 を予定（E §6.1） | G は **v70**（E が先にマージされる前提。順が逆なら実装の契約で番号を入れ替える）［見立て］ |
| decision の遷移 | `transitions.ts:39-56`。`recorded` の `close` は断る（`:45-48`） | S-D |
| S3 の CLI と brief | CLI の一覧の行は `{result:reason,unreflected}` を出す（`src/cli/commands/mem.ts:169-177`）。brief の行は `fields` を全部 `key=value` で出し（`src/lib/brief/render.ts:78-89`）、`state=recorded`・`unreflected=true` が載る（`src/lib/brief/sources.ts:470-480`）。順位は `recorded` が 4（`:452-455`） | §6 S3 |

---

## 2. 画面の一覧（PC・スマホ）

### 2.1 置き場所と入口

| 画面 | 置き場所 | 入口 | PC・スマホ |
|---|---|---|---|
| G-1 項目の一覧・編集 | 新規 `src/app/repositories/[id]/mem/page.tsx?branch=<name>[&worktree=<id>]`、部品 `src/components/mem/MemItemsPanel.tsx` | (a) `/repositories` の行の mem の設定の下に「項目を見る」、(b) worktree の画面のヘッダ（PC）／アクションシート（スマホ、`MobileTerminalActionsSheet`）に「引き継ぎ（mem）」。(b) は `worktree=` を付けて開く | 1 ページ。`useIsMobile` で並びだけ変える（A §11.1・E §4.1 と同じ作り） |
| G-2 mode の設定 | A の `RepositoryMemSettings`（S-E で広げる） | `/repositories` の行（今どおり）＋ G-1 の上部の「このブランチの mode：on（規則 `main`）」から開く | 同上 |
| G-3 開くときのポップアップ | 新規 `src/components/mem/SessionStartBriefDialog.tsx`（`ui/Modal`） | 画面の送信の直前（§3） | 同上（スマホは全幅のシート） |
| G-4 閉じるときの流れ | 新規 `src/components/mem/SessionHandoffDialog.tsx`（`ui/Modal`、段のある 1 つのダイアログ） | 「終了」の確認の Modal の代わりに開く（`popup=1` かつ mode `on` のときだけ、§4） | 同上 |
| G-5 decision の承認 | **E の** `DecisionPromotePanel`（`src/app/repositories/[id]/mem/decisions/page.tsx`） | G-1 の decision の行から開く | E のまま（§5.5） |

### 2.2 G-1 の中身

- 上部：ブランチ名・mode（`GET …/mem/mode` の `source` つき）・`derived` なら「凍結中：Agent の書き込みと条件の評価は止まっています」・`off` なら一覧を出さず「off：項目は保持されていますが表示しません」（A §4 の表の `mem list` の `off` は 50 で項目を返さない）
- 一覧：kind ごとの節（`now` は instance ごとの枠を名前つき、D6）。行に `kind`・`state`・本文（withheld なら A §6.4 の形のまま、本文は出さない）・作成者（`createdBy`・instance）・更新者・`version`・`updatedAt`・`closeWhen` と B の評価（`{result:reason}`）・`stale`・decision の `unreflected`（§6 S3 の文言）
- 操作（mode `on` のときだけ有効。`derived`・`off` は無効にして理由を出す）：
  - 追加：kind・本文・`closeWhen`・`evidence`。**worktree の文脈（`worktree=`）があり、roster の instance を 1 つ選んだときだけ**（項目の所有は instance を持つ、D5・A §10.1 の `origin_instance_id NOT NULL`）。作成者は `human`、所有の instance は選んだもの
  - 編集：本文・`closeWhen`・`evidence`。`ifVersion` は一覧を読んだときの `version`
  - close：理由の任意入力。decision の `open` は「取り下げ」（`withdrawn`）、`recorded` は S-D の 2 段の確認
  - decision の「記録・反映」は G-5（E）へ。G-1 では書かない
- 未配送の知らせ（B）：`GET …/notices?branch=` の一覧と「引き取る」（印つき、既存の API）
- 終了の記録（§4.6）：その branch の直近の終了の依頼と結果（`confirmed`／`unconfirmed`＋理由）。読むだけ

### 2.3 書き込みの API（G、新規。すべて印が要る）

| API | 本文 | 結果 |
|---|---|---|
| `POST /api/worktrees/:id/mem/screen/items` | `{ instanceId, kind, text, closeWhen?, evidence?, key }` | S-A の `memWriteFromScreen({op:'add', author:'human'})`。`key` は画面が 1 回の押下ごとに作る（A §5.4 の冪等。二重押下・再送で 2 件にしない） |
| `PATCH /api/worktrees/:id/mem/screen/items/:itemId` | `{ instanceId, ifVersion, text?, closeWhen?, evidence? }` | `op:'update'`。版が違えば 409 `version_conflict` と今の項目（A §12.2 の形） |
| `POST /api/worktrees/:id/mem/screen/items/:itemId/close` | `{ instanceId, ifVersion, reason?, confirmUnreflected? }` | `op:'close'`。`recorded` は `confirmUnreflected:true` が無ければ 409 `confirmation_required`（S-D） |
| `GET /api/worktrees/:id/mem/screen/start-preview?instance=` | — | §3.1（読み。印は要らない） |
| 終了の流れの API | §4.3 | |

- `instanceId` は「誰の枠・誰の所有として書くか」で、書き手は人（`updated_by='human'`）。worktree が無い branch（repository の経路）の項目の編集・close は、項目の `origin_worktree_id` が今も在ればその worktree の route で、無ければ **編集できない**（読むだけ。D5 の所有を持つ worktree・instance が無い）［見立て。§9 U3］
- route は `isScreenRequest` が偽なら 403 `screen_only`（`settings-service.ts:37` と同じ）。判定は G の service の中でも行う（E T23 の (4) と同じく route だけに置かない）
- CLI に口を作らない（§7.3 のガード）

### 2.4 同時編集の競合と古い差分

- 画面は一覧を読んだときの `version` を持ち、`PATCH`・`close` に送る。409 を受けたら、**自分の下書き・読んだときの値・今の値** の 3 つを並べ（差分の表示）、「今の値に自分の下書きを載せ直して保存」（新しい `ifVersion` で送り直す。人が押したときだけ）か「下書きを捨てる」を選ばせる。自動で載せ直さない
- 古い差分：一覧を開いたまま時間が経った画面（別のセッション・条件の close で `closed` になった項目）は、書いた時点の 409（`version_conflict` か `state_forbids`）で知る。加えて、画面がフォーカスを取り戻したとき・30 秒ごと（画面の側の再読込。サーバに見張りを足さない）に一覧を読み直し、版が進んだ行に「更新されました」の印を付ける
- PC とスマホで同じ項目を開いたときも同じ規則（同じ API・同じ版）

---

## 3. 開くとき（G-3）

### 3.1 3 行の preview

`GET /api/worktrees/:id/mem/screen/start-preview?instance=<id>` は次を返す（読みだけ。境界も知らせも予約・消費しない）：

```jsonc
{ "ok": true,
  "attended": true,            // §5.1 の popup（そのブランチの決まった値）
  "mode": "on" | "derived",    // off・曖昧・未登録は { ok:true, show:false }
  "boundary": { "id": "…", "kind": "launch" | "auto_restart" | "reset" | "resume" } | null,
  "preview": {
    "open": { "count": 7, "unreflected": 1 },   // 1 行目
    "humanQuestions": 2,                        // 2 行目
    "lastUpdatedAt": "2026-11-09T03:12:00Z"     // 3 行目（null = 記録なし）
  } }
```

| 行 | 中身 | 読む所［見立て。読み口はすべて既存の export］ |
|---|---|---|
| 1 | `open` の項目の件数（そのブランチ、kind を問わず。`now` の枠を含む）と、うち未反映の decision（`recorded`）の件数 | A の `memList`（`service.ts:527`）の結果を数える。`derived` は A の表どおり `frozen` の項目を数える |
| 2 | 人への質問の件数 | C の `briefForRoute`（`src/lib/brief/service.ts:54`）の `format=json`・`all=1` で、`entries` のうち順位 1 のもの（C §0 G1）。C の情報源の読みを写さない |
| 3 | 最終更新 | 1 行目の項目と `now` の枠の `updatedAt` の最大（作者を問わない）。D2 §7.3 の「この instance の最終更新」とは別の値（あちらは Agent の更新だけ） |

- `boundary` は D1 の `getCurrentBoundary(db, worktreeId, instanceId)`（`src/lib/db/session-brief-db.ts:139`）を読むだけ。`state==='pending'` のときだけ返す
- `briefForRoute` は `on` で B の条件を評価する（読みのときの評価、D8・B §3.2）。preview が条件の close を起こしうることは list と同じで、新しい書き込みではない［事実：C の route のコメント `src/app/api/worktrees/[id]/mem/brief/route.ts:1-7`］
- preview の取得は 2 秒で打ち切る（D1 の provider の打ち切り `BRIEF_PROVIDER_TIMEOUT_MS` と同じ値）。取れなければ 3 行の代わりに「preview を取れませんでした」と出し、選択はそのまま出す

### 3.2 選択と送信（S-B を採ったとき）

| 選択 | 送信の route の本文 | D1 の記録 |
|---|---|---|
| 短い要約を読む（既定の選択） | `brief` なし（`auto`）・`briefDetail:'short'` | 今どおり `sent` |
| 全文を読む | `briefDetail:'full'` | `sent`（予算 49,152 と #2464 の上限の小さい方。入らない分は C の `omitted` と `all=` の案内が付く、C §2） |
| 読まない | `brief:'decline'` | `skipped(declined)`（境界を消費、次の送信にも付かない） |
| ダイアログを閉じる | 送らない（下書きは入力欄に残す） | 触らない |

- 出す条件：画面の送信で、`attended=true`・mode `on` か `derived`・`boundary` がある・本文が slash コマンドでない（D1 §4.1：slash は付けない・取らない）。どれかが欠ければ出さずに今どおり `auto` で送る
- **選択は送信の 1 回に結ぶ**。preview を出した後に境界が他の送信（CLI 等）で消費されていたら、D1 の claim が取れずに本文だけが送られる（D1 §3.4 の 3）。route の応答の `brief.state` を見て「既に別の送信で引き継ぎが渡されました」と出す
- D2 の差し込みとの照合：D2 は D1 の口（`BriefRequest`）に `target.worktreeIncarnation`・`instanceOnRoster` と `BriefResult.skipReason?` を足し、`brief: 'auto'/'force'` で `briefPin` を必須にする（D2 §0.1・§2.4）。G の選択は **route の本文の欄** だけで、`BriefRequest` の形を変えない（`full` は `budget.maxBytes` の値が大きくなるだけ）。D2 の先頭の行（§7.1「終わる前の更新を確認できない」）は「必須の項目」で、短い要約でも全文でも入る（D2 §7.4）。`decline` では brief が付かないので先頭の行も届かない — ダイアログに「読まないと、前回の終わり方の注意も届きません」を出す［見立て］

### 3.3 無人の経路

`attended=false`（`popup=0`、既定）のときは G-3 を出さない。画面の送信も CLI の送信も `auto` で、短い要約（`defaultBytes`）が自動で付く（D1 の既定の動き。G は何も足さない）。

---

## 4. 閉じるとき（G-4）

### 4.1 流れ

```
「終了」を押す（PC・スマホ、同じ hook）
  ├ attended=false か mode≠on か  → 今どおりの確認の Modal → kill（依頼を作らない＝記録なし）
  └ attended=true かつ mode=on
      ① 依頼を作る（POST …/handoff/requests、印つき）→ requestId・依頼の文（テンプレート）
      ② 画面が依頼の文を既存の送信の route で送る（brief:'skip'）
           失敗 → request_failed（§4.4）
      ③ Agent が提案を出す（commandmate handoff propose …）→ 終わったら handoff done
           期限（5 分）までに done が無い → agent_timeout（§4.4）
      ④ 画面が提案を差分で見せる（提案ごとに 承認／捨てる）
           ＋「提案を経ずに確定した更新」（G2）を別の欄に出す（読むだけ）
      ⑤ 「確定して終了」：承認した提案だけを、版を照合して 1 件ずつ確定
           版の食い違い → conflict（§4.5）。失敗 → failed
      ⑥ kill（既存の kill-session、その instance だけ）→ 成功で依頼を ended に
  どの段でも：「終了をやめる」（取り消し）・「今すぐ終了」（強制終了）
```

### 4.2 依頼の文（Agent へ）

固定のテンプレート（D1：モデルを呼ばない）。データの区切り（D12）は C の区画と同じ作法で、依頼の ID と期限だけを差し込む：

```
[CommandMate: 終了の前の引き継ぎの依頼 request=<id> 期限=<ISO8601>]
このセッションを終える前に、mem の更新を「提案」として出してください。確定は人が画面で行います。
- 追加:  commandmate handoff propose --request <id> add --kind <kind> --text "…" [--close-when …]
- 更新:  commandmate handoff propose --request <id> update <itemId> --base-version <v> --text "…"
- close: commandmate handoff propose --request <id> close <itemId> --base-version <v> [--reason "…"]
- 終わったら: commandmate handoff done --request <id>
今の項目は commandmate mem list で読めます。mem add / update / close で直接確定しないでください。
```

- 送るのは画面（`worktreeApi` の送信、`brief:'skip'`）。サーバから `sendUserMessage` を呼ばない（§1 の送信の呼び出し元の表を変えない）。`skip` なので境界は動かない（終わる会話に brief を付けない）
- Agent の端末にポップアップは出さない（Issue の「やらないこと」）。これは送信の本文で、端末の操作ではない

### 4.3 提案の置き場（v70、`src/lib/db/migrations/v70-mem-handoff.ts`）

```sql
CREATE TABLE mem_handoff_requests (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL, branch TEXT,           -- 作った時点の所属（A の withMemTarget）
  target_worktree_id TEXT NOT NULL,                   -- worktree_id と名付けない（A §10.3）
  target_worktree_incarnation TEXT NOT NULL,          -- 作った時点で固定
  instance_id TEXT NOT NULL, cli_tool_id TEXT NOT NULL,
  instance_incarnation TEXT,                          -- 作った時点で固定（NULL = 世代なし）
  state TEXT NOT NULL CHECK (state IN
    ('awaiting_agent','reviewing','applying','ended','cancelled','expired')),
  outcome TEXT CHECK (outcome IN ('confirmed','unconfirmed')),
  outcome_reason TEXT,   -- request_failed・agent_timeout・forced・apply_failed・conflict_left・kill_failed・expired
  agent_deadline_at INTEGER NOT NULL,                 -- 作成 + 5 分（延長は 2 回まで、各 + 5 分）
  expires_at INTEGER NOT NULL,                        -- 作成 + 60 分
  agent_done_at INTEGER, ended_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_mem_handoff_open ON mem_handoff_requests(target_worktree_id, instance_id)
  WHERE state IN ('awaiting_agent','reviewing','applying');

CREATE TABLE mem_handoff_proposals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES mem_handoff_requests(id) ON DELETE CASCADE,
  op TEXT NOT NULL CHECK (op IN ('add','update','close')),
  item_id TEXT,                                       -- add は NULL。FK なし（purge で消えても残す）
  base_version INTEGER,                               -- add は NULL
  payload TEXT NOT NULL,                              -- JSON：kind・text・closeWhen・evidence・reason（A の検査を通った値）
  fingerprint TEXT NOT NULL,                          -- payload と base_version の SHA-256（承認に結ぶ）
  author_instance_id TEXT NOT NULL, author_incarnation TEXT,   -- 作者（D5）
  state TEXT NOT NULL CHECK (state IN
    ('proposed','approved','applied','conflict','discarded','failed','expired')),
  state_reason TEXT,                                  -- version_conflict・state_forbids・disabled・incarnation_changed・db_error・cancelled・forced
  applied_item_id TEXT, applied_version INTEGER,
  checked_rules_version INTEGER NOT NULL,             -- A §6.4 と同じ：出口で読み直す
  created_at INTEGER NOT NULL, decided_at INTEGER, updated_at INTEGER NOT NULL
);
```

- **形**：提案は「項目への 1 操作」（追加・版つきの更新・close）で、全体の書き戻しにしない（D6）。decision の `record`・`promote` の操作は **無い**（D9。promote は E の画面だけ）。decision の提案は `add`（`open`）と `close`（`open` の取り下げ）だけ
- **作者**：提案の口（Agent の CLI）は A の Agent の口と同じく `instanceId` と世代で作者を決め、依頼の `instance_id`・`instance_incarnation` と違えば 409 `not_requested`（他の instance が他人の依頼に提案を足さない）
- **検査**：提案を受けたときに A の検査（`validateItemText`・`parseCloseWhen`・`validateEvidence`、`src/lib/mem/validate.ts`・`close-when.ts` の export を読むだけ）を通し、通らなければ入れない。確定のときは S-A の入口がもう一度すべて検査する（保存時より新しい規則で、A §6.4）。画面の差分の表示は出口の検査（withheld の形）を通す
- **版**：`update`・`close` は Agent が見た `base_version` を必須にする。`add` は版を持たない（新しい項目）
- **寿命**：依頼が `ended`・`cancelled`・`expired` になった時点で、未決の提案（`proposed`・`approved`・`conflict`）は `discarded`（理由つき）か `expired`。行は 14 日残し、G の次の書き込みの区間で古い行を消す（定期の実行を足さない、B §7・E §6.1 と同じ）
- **期限の判定は読むときに行う**（依頼の状態の読み・提案の受け入れ・画面の操作のたび）。サーバにタイマーを置かない（§7.3 のガード）
- mode：依頼を作るのは mode `on`・`attended=true` のときだけ。提案の受け入れも mode `on` のときだけ（`off`・`derived` は 50 `disabled`、何も保存しない：A §4 の手で書く口と同じ）
- 将来、dreaming（#4248）の提案と置き場を共有するかは #4248 の設計で決める（この表は `request_id` を必須にしており、そのままでは共有しない）［見立て］

**API（新規）**

| API | 誰が | 印 | 中身 |
|---|---|---|---|
| `POST /api/worktrees/:id/mem/handoff/requests` | 画面 | 要る | `{ instanceId }` → 依頼と依頼の文。開いた依頼があれば 409 `request_open`（それを返す） |
| `GET  …/handoff/requests/:rid` | 画面・CLI | 要らない | 依頼の状態・提案の一覧（差分の表示用に今の項目つき）・「提案を経ずに確定した更新」 |
| `POST …/handoff/requests/:rid/sent` / `send-failed` | 画面 | 要る | ② の結果 |
| `POST …/handoff/requests/:rid/proposals` | Agent（CLI） | 要らない | `{ instanceId, op, itemId?, baseVersion?, kind?, text?, closeWhen?, evidence?, reason? }` |
| `POST …/handoff/requests/:rid/done` | Agent（CLI） | 要らない | `{ instanceId }` → `reviewing` |
| `POST …/handoff/requests/:rid/extend` | 画面 | 要る | `{ ifVersion }` → `agent_deadline_at` + 5 分（2 回まで） |
| `POST …/handoff/requests/:rid/decide` | 画面 | 要る | `{ ifVersion, decisions: [{ proposalId, fingerprint, action:'approve'\|'discard' }] }` → 承認したものを確定（§4.5）。結果は提案ごと |
| `POST …/handoff/requests/:rid/cancel` | 画面 | 要る | 取り消し（§4.4） |
| `POST …/handoff/requests/:rid/end` | 画面 | 要る | `{ ifVersion, killed: true\|false, force?: true }` → ⑥ の結果を記録（§4.6） |

- CLI：`commandmate handoff propose …` と `commandmate handoff done`（新規 `src/cli/commands/handoff.ts`、`program.ts` に登録）。**承認・取り消し・終了の口は CLI に作らない**（§7.3）。exit code は A の `MemExitCode` を使う（50 disabled・51 conflict・52 not found・55 not_owner）。新しい語 `not_requested`・`request_closed` は 52 / 55 に寄せる［見立て］

### 4.4 取り消し・未応答・失敗・強制終了・タイムアウト

| 場合 | 起きること | 依頼 | 提案 | 次の世代へ（§4.6） |
|---|---|---|---|---|
| 依頼の文の送信が失敗（②） | 画面が `send-failed` を送り、「依頼を送れませんでした」と出す。選択：再送／提案なしで終了／終了をやめる | `awaiting_agent` のまま（再送）か下の行へ | — | 提案なしで終了なら `unconfirmed(request_failed)` |
| Agent が応答しない（期限まで `done` が無い） | 読むときに `agent_timeout` を出す。選択：待つ（+5 分、2 回まで）／ここまでの提案で進む（`reviewing` へ）／提案なしで終了／終了をやめる | 選択どおり | 期限の後に来た提案は 409 `request_closed`（`reviewing` 以降は受けない） | 提案なしで終了なら `unconfirmed(agent_timeout)`。「ここまでの提案で進む」は done が無いので、確定が全部通っても `unconfirmed(agent_timeout)` |
| 人が取り消す（「終了をやめる」） | 未決の提案をすべて `discarded(cancelled)`。**確定済みの提案（`applied`）と、他のセッション・Agent の直接の更新は巻き戻さない**。セッションは続く | `cancelled` | `discarded` | 終わっていないので記録しない（後で別の経路で終われば「記録なし」） |
| 確定の 1 件が失敗（DB・mode が `on` でなくなった・作り直し） | その提案は `failed(<理由>)`。他の提案は続ける。画面に一覧で出し、選択：残りで終了／終了をやめる | `applying` → `reviewing` | `failed` | `unconfirmed(apply_failed)` |
| 版の食い違い（§4.5） | `conflict`。人が今の値と並べて見直し、「今の版に載せ替えて承認」（新しい `baseVersion` で同じ提案を承認し直す。指紋は変わる）か「捨てる」 | `reviewing` | `conflict` | 未決のまま終了すれば `unconfirmed(conflict_left)` |
| 強制終了（「今すぐ終了」、どの段でも） | 未決の提案を `discarded(forced)`、kill。確定済みは巻き戻さない | `ended` | `discarded` | `unconfirmed(forced)` |
| kill が失敗 | 「終了できませんでした」と出す。依頼は `ended` にしない（`reviewing` に戻す） | `reviewing` | そのまま | 終わっていない |
| 画面を閉じた・電源が切れた（依頼の途中） | 何も進まない（サーバは待たない）。依頼は `expires_at`（60 分）の後の読みで `expired`、未決の提案は `expired`。**セッションは殺さない**（無人で kill しない） | `expired` | `expired` | 終わっていない。後で別の経路で終われば「記録なし」 |
| 依頼の途中で、画面の外から kill（CLI・別の画面・異常終了） | 次の読みで、instance の世代が依頼と違う・roster に無い → 依頼を `expired(instance_gone)` | `expired` | `expired` | 記録なし（確認できない） |

- 期限の値（Agent 5 分・全体 60 分・延長 2 回）は［見立て］。Agent の 1 ターンが 5 分を超えることは珍しくないので、UAT で見直す（§9 U1）

### 4.5 承認と確定の手順（`decide`）

1. 印・mode `on`・依頼の `version`・依頼の世代（`target_worktree_incarnation`・`instance_incarnation`）を同じ同期の区間で確かめる（違えば 409、何も書かない）
2. `discard` の提案を `discarded` にする
3. `approve` の提案を 1 件ずつ：送られた `fingerprint` が今の提案の行と一致しなければ 409 `proposal_changed`（人が見たものと違う）。一致すれば S-A の入口 `memWriteFromScreen` を呼ぶ：
   - `update`・`close`：`author:'human'`、`ifVersion = base_version`。人が承認したので人の書き込み（D6：人は誰の項目も変えられる）。`updated_by='human'`
   - `add`：`author:'proposer'`、`pin = { worktreeIncarnation: 依頼の値, instanceIncarnation: 提案の作者の世代 }`。本文は Agent のものなので作成者は Agent（その instance）。人の承認は提案の行（`decided_at`・`applied_item_id`）に残る
   - 結果が版の競合（`version_conflict`）・`state_forbids` なら `conflict`、その他の失敗は `failed`、成功は `applied`（`applied_item_id`・`applied_version`）
4. 1 件ずつ別の transaction（全体を 1 つにしない：他の提案の失敗で成功した確定を戻さない＝「確定済みは巻き戻さない」と同じ向き）
5. 依頼の `version+1`

- 承認は **画面の要求の中でだけ** 起きる。auto-yes・F の促し・brief・Schedule・dreaming から `decide` を呼ぶ口は無い（§5.3・§7.3）

### 4.6 「終わる前の更新を確認できない」を次の世代へ

- `end` の要求で `killed:true` のとき、`outcome` を決めて `ended_at` を書く：§0.1 G5 の 4 条件（`agent_done_at` がある・未決の提案が無い・`failed`/`conflict` が無い・kill が成功）が全部そろえば `confirmed`、そうでなければ `unconfirmed`＋理由
- 読み口（S-C）：`readPreEndUpdate(db, { worktreeId, instanceId, before })` は、その (worktree, instance) の `ended` の依頼のうち `ended_at < before` で最も新しいものが、**その直前の境界より後**（同じ世代の終わり）に `confirmed` なら `'recorded'`、それ以外（無い・`unconfirmed`・前の世代のもの）は `'not_recorded'`。D2 §7.2 の X1〜X3 はそのまま D2 が判定する
- 画面が kill の後に `end` を送る前に落ちたら、依頼は `ended` にならず `not_recorded`（確認できない側）
- 文言は D2 の固定の 1 行のまま（「確認できない」）。G は理由の語を brief に出さない（D2 §7.1 の上限 96 バイトを変えない）。理由は G-1 の「終了の記録」で人が読む

---

## 5. 無人・auto-yes・promote の境界

### 5.1 無人の扱いの設定

| 項目 | 決め |
|---|---|
| 置き場 | A の `popup`（`mem_repository_settings.popup`・`mem_branch_overrides.popup`）。新しい表を作らない（G1） |
| 単位 | repository の既定＋ブランチの上書き（D4。`resolveMemTarget` の `features.popup`） |
| 既定 | `0`＝無人（ポップアップを出さない） |
| 変える経路 | 画面だけ（A §11.2 の印。既にある） |
| 読む所 | G-3 の出す条件（§3.2）と G-4 の分岐（§4.1）だけ |
| auto-yes との関係 | 読まない・書かない。auto-yes の on/off・期限で `popup` を変えない。`popup` で auto-yes を変えない |

- 注：worktree・セッション単位の「いま見ている」の切り替えは採らない。ブランチの単位なら「`main` は人が見る・`feat/*` は orchestrate のワーカーが無人で回す」の運用（このリポジトリの開発体制）と合う。セッションごとの切り替えが要るなら、上書きの粒度を足す別の Issue にする［見立て。§9 U2］

### 5.2 無人の経路で起きないこと

- ポップアップを出さない（G-3・G-4）。開くときは `auto`（短い要約）が自動で付く（§3.3）
- 閉じるときに依頼を作らない。Agent に提案を頼まない。終わり方は「記録なし」として次の世代の先頭の行に出る（D2）
- 人の決定（提案の承認・decision の記録と反映・`recorded` の close・mode の変更）を代わりにしない：これらの書き込みはすべて画面の印つきの要求の中でだけ起きる。無人の経路（CLI・F の促し・Schedule・dreaming・auto-yes）から呼ぶ口が無い

### 5.3 auto-yes の応答を人の承認として扱わない

- auto-yes は Agent の端末のダイアログにキーで答える（`src/lib/polling/auto-yes-*`）。G の承認は画面の API（印つき）で、端末の答えを読まない。auto-yes が Agent の `commandmate handoff propose` の実行の許可に答えるのは「Agent が提案を出す」ことの許可で、提案の承認ではない（提案は `proposed` のまま）
- ガード（§7.3）：`src/lib/polling/**`・`src/lib/auto-yes*`・`src/app/api/worktrees/[id]/prompt-response/**`・`respond`・`special-keys` の import の閉包に G の承認の service（`src/lib/handoff/decide.ts`）が無い
- 対照の組み合わせ（受入基準）：

| 組 | `popup` | auto-yes | 期待 |
|---|---|---|---|
| 無人だが auto-yes は off | 0 | off | ポップアップなし・`auto` で短い要約・「終了」は今どおり kill・依頼なし・記録なし |
| 人が見ていて auto-yes は on | 1 | on | 開くときにポップアップ・選んだとおりに送る・「終了」で依頼の流れ。auto-yes が Agent の許可のダイアログに答えても、提案は `proposed` のまま・依頼は `reviewing` 止まり。確定は画面の `decide` だけ |

### 5.4 promote の承認（E の画面との境界）

- decision の `open → recorded / promoted`・`recorded → promoted` は **E の画面と E の API だけ**（E §4）。G-1 は decision の行に「記録・反映へ」（E の `DecisionPromotePanel` のページへ移る）を置くだけで、遷移を書かない
- G が decision に書くのは：本文の編集（`open` だけ、A の遷移表の `update`）・`open` の取り下げ（`withdrawn`）・`recorded` を未反映のまま閉じる（S-D）
- 終了の流れの提案は decision の `record`・`promote` を持たない（§4.3）。Agent が「この決定を Issue に書いて」と提案しても、G の `decide` は記録しない（提案は `add` の decision になり、記録は人が E で行う）
- E の operation が進行中（`approved`・`in_flight`・`unknown`・`transition_pending=1`）の decision を G で close しようとしたら？ G は E の表を読まない。A の版で決まる（E が先に遷移すれば G は 409、G が先に閉じれば E の遷移は `state_forbids` で `transition_pending`）。E §1.1 の競合の決まりと同じで、G は足さない［見立て］

---

## 6. S2・S3 の決定案

| # | 決定案 | 理由 |
|---|---|---|
| **S2** | **人が画面で `recorded` の decision を閉じる遷移を足す（S-D の案）。** 遷移 `'withdraw-recorded'`（`recorded` → `closed`、`close_reason='withdrawn'`）。入口は G の画面の close（S-A の `memWriteFromScreen`、`author:'human'`、印・mode `on`・`ifVersion`）だけ。画面は「この決定は記録済みですが、正本（Issue の本文など）へ反映しないことにして閉じます。コメントなどの記録は消えません」の確認を 2 段で出し、`confirmUnreflected:true` を送る。CLI の `mem close` と Agent の提案は今どおり断る（55 `state_forbids`。提案の `close` は `open` の decision だけ） | 出口が無いと、反映しないと決めた decision が `recorded` のまま残り、古さの警告（14 日）が出続ける。purge も既定で除く。`promoted` を経て閉じる（「反映した」と偽る）しか手が無くなる。`withdrawn` は既にある理由の語（A §10.1 の `CHECK`）で、DB の形を変えない。外への記録（コメント・文書）は E の operation に残り、G は消さない |
| **S3** | **CLI の一覧と brief には文言を足さない（今の構造化の欄のまま）。** 画面（G-1 と E の画面）にだけ「未反映：記録しただけで、正本へはまだ反映されていません」を出す | 両方とも既に `recorded` を区別して出し（CLI：`v<version> recorded {…,unreflected}`、`mem.ts:169-177`。brief：`state=recorded unreflected=true`、`render.ts:78-89`・`sources.ts:470-480`、順位 4）、Agent はその欄を読める。brief は D12 で「データとして区切る」もので、警告の文を足すと命令として読まれうる・予算を使う（C §2）。人が判断する場所は画面で、警告はそこに出せば足りる。A・C のファイルを変えずに済む |

---

## 7. 実装の範囲と試験

### 7.1 PR の切り方

| PR | 中身 | 待つもの |
|---|---|---|
| G-PR1 | S-A（`memWriteFromScreen` と `ENTRANCES` の 4 行）・S-D（遷移 1 つ）・人の項目の API（§2.3）・G-1 の画面（一覧・追加・編集・close・競合・未配送の知らせ）・S-E の mode の画面・ja/en の文書 | PM の S-A・S-D・S-E の決定。E のマージ（G-1 から E のページへ移る・decision の表示） |
| G-PR2 | v70・`src/lib/handoff/**`（依頼・提案・decide・期限）・CLI `handoff`・G-4 の画面・ガード | G-PR1 |
| G-PR3 | G-3（開くときの preview と選択）・S-B の欄・S-C の読み口の接続 | D2 のマージ（S-B を D2 に含めるならその後）・PM の S-B・S-C の決定 |

### 7.2 新規ファイル（A〜D1 の外）

| ファイル | 中身 |
|---|---|
| `src/lib/db/migrations/v70-mem-handoff.ts`・`runner.ts` の登録 | §4.3 |
| `src/lib/db/handoff-db.ts` | 依頼・提案の CRUD（`mem_items` は書かない）。名前は A の `mem-*.ts` の glob に入れない |
| `src/lib/handoff/request.ts`・`proposals.ts`・`decide.ts`・`pre-end.ts`・`template.ts` | 依頼の作成と状態（期限は読むときに判定）・提案の受け入れ（A の検査を呼ぶ）・承認と確定（S-A の入口だけを呼ぶ）・読み口（S-C）・依頼の文 |
| `src/lib/handoff/screen-client.ts` | 画面の client（`screenRequestHeaders()` つき、A の `screen-client.ts` と同じ形） |
| `src/app/api/worktrees/[id]/mem/screen/**`・`…/mem/handoff/**` | §2.3・§4.3 |
| `src/cli/commands/handoff.ts`（`program.ts` に登録）・`src/cli/types/` の型 | `propose`・`done` だけ |
| `src/app/repositories/[id]/mem/page.tsx`・`src/components/mem/MemItemsPanel.tsx`・`SessionStartBriefDialog.tsx`・`SessionHandoffDialog.tsx` | §2・§3・§4 |
| `docs/user-guide/`（ja・en）の mem の節 | 画面・対話と無人・終了の流れ・防げないこと（A §11.3 を写す） |

変える既存のファイル（A〜D1 の外）：`useWorktreeDetailController.ts`（`openActiveKillConfirm`・`handleKillConfirm` の前に分岐）・`WorktreeDetailDesktop.tsx`／`WorktreeDetailRefactored.tsx`（ダイアログを描く）・画面の送信（`MessageInput.tsx`・`ChatSurface.tsx`・`MobileTerminalTab.tsx`・`SessionTile.tsx`・`usePendingMessages.ts` — D1 §4.1 の表の画面の送信の全経路。G-3 はこれらが通る共通の送信の関数の 1 か所に挟む。共通の 1 か所が無ければ全部に置き、表駆動の試験で全経路を固定する）・`MobileTerminalActionsSheet.tsx`（入口）・`RepositoryList.tsx`（入口）・`locales/{ja,en}`。

### 7.3 ガード（`tests/unit/guards/`、新規）

- `handoff-screen-only-4227.test.ts`：`src/cli/**` が `mem/screen`・`handoff/requests/*/(decide|cancel|end|extend|sent)` の書き込みと `X-CommandMate-Client` を持たない（A の `mem-mode-write-screen-only.test.ts` と同じ形。A の試験は変えない）
- `handoff-no-resident-4227.test.ts`：`src/lib/handoff/**` が `setInterval`・`setTimeout`（打ち切りの `AbortController` を除く）・detached・`unref` を持たない（A の `mem-no-resident-4222.test.ts` と同じ判定）
- `handoff-no-generation-4227.test.ts`：`src/lib/handoff/**` の import の閉包に LLM の SDK・`@/lib/report`・tmux を動かすモジュールが無い（C の I9 と同じ判定）
- `handoff-approval-not-from-auto-yes-4227.test.ts`：§5.3 の閉包の検査。`decide.ts` を import するのは `…/handoff/requests/[rid]/decide/route.ts` だけ
- `memWriteFromScreen` を呼ぶのは `src/lib/handoff/decide.ts` と `…/mem/screen/**/route.ts` だけ（E T23 の (2) と同じ形）

### 7.4 全入口の不変条件の表駆動の試験

`tests/unit/lib/handoff/handoff-entrances-4227.test.ts`（新規）。表のキーは **G の service の export のうち DB の書き込みに届くもの** を本文から求め（固定の名前の列挙にしない）、入口を足すと表に足すまで落ちる（A I18・E T23 と同じ）。S-A の入口は A の `ENTRANCES` に行を足して回す（既存の行・`it`・期待値は変えない）。DB は `os.tmpdir()` の `mkdtempSync` に作り、`afterEach` で消す。

| # | 不変条件 | 陽性対照（直す前・壊した実装で落ちる） | 陰性対照 |
|---|---|---|---|
| H1 | 作り直し後の古い要求の拒否：依頼の作成・提案・`decide`・`end` の各 `await` の間に worktree を同じ ID・path で消して作り直す／instance を外して同じ ID で足す → 409 `incarnation_changed`、項目・提案・依頼が変わらない | 依頼の世代の照合を外した版で、新しい世代の項目に確定が書かれる | 作り直さなければ書ける |
| H2 | `off`・`derived`・曖昧・未登録で書かない：人の項目の 3 つの API・依頼の作成・提案・`decide` → 409 / 50 `disabled`、`mem_items` と提案の行が変わらない | mode の照合を外した版で `off` の追加が書かれる | `on` は書ける |
| H3 | 版の競合：一覧を読んだ後・提案の後に別の入口（Agent の `mem update`・別の画面）で `version+1` → 人の編集は 409 `version_conflict`、提案の承認は `conflict`。どちらも項目は他者の値のまま | `ifVersion` を外した版で他者の変更を上書き | 版が同じなら書ける |
| H4 | 取り消しで確定しない：提案 3 件のうち 1 件を確定した後に `cancel` → 確定済みの 1 件は残る、残り 2 件は `discarded`、`mem_items` は 1 件分だけ変わる。他の instance の直接の更新も残る | 取り消しで確定済みを戻す版・未決を確定する版で落ちる | 取り消さなければ全部確定できる |
| H5 | 承認は人が見たものだけ：`fingerprint` が違う・承認していない提案 → 確定しない | 指紋の照合を外した版 | 一致すれば確定 |
| H6 | 印：印の無い `decide`・`cancel`・`end`・人の項目の API → 403、何も書かない | 印の検査を外した版 | 印つきは通る |
| H7 | 無人×auto-yes の 2 通り（§5.3 の表）：`popup=0`・auto-yes off で依頼を作る要求 → 409 `unattended`、start-preview は `attended:false`。`popup=1`・auto-yes on で、auto-yes の答えの経路（`prompt-response`・`respond` の route を試験の中で呼ぶ）を通しても提案は `proposed`、依頼は `reviewing` | auto-yes の有効を「対話」と読む版（`popup` の代わりに auto-yes を読む）で、2 つの組の期待が入れ替わって落ちる | 画面の `decide` だけが確定する |
| H8 | 期限：`agent_deadline_at` の後の提案は 409 `request_closed`。`expires_at` の後の読みで `expired`、kill しない（kill の関数が呼ばれない） | 期限を見ない版 | 期限の前は受ける |
| H9 | 次の世代への記録：`confirmed` の 4 条件の 1 つずつを欠かした 4 通りで `readPreEndUpdate` が `not_recorded`、全部そろえば `recorded`。前の世代の `confirmed` は今の世代の終わりに使われない | 条件を 1 つ外した版 | — |
| H10 | 提案の作者：他の instance の提案・他の依頼への提案 → 409 `not_requested` | 作者の照合を外した版 | 依頼の instance なら受ける |
| H11 | decision の境界：提案に `record`・`promote` の op は無い（400）。G の close で `recorded` は `confirmUnreflected` が無ければ 409、あれば `closed(withdrawn)`。CLI の `mem close` は今どおり 55 | 確認を外した版 | `open` の取り下げは今どおり |
| H12 | 出口の検査：秘密らしい文字列を含む提案（受け入れの後に規則が変わった）は差分の表示で withheld、確定のときに A の検査で断られて `failed` | 出口の読み直しを外した版で本文が出る | 通常の本文は出る |

### 7.5 e2e で確かめる項目（`tests/e2e/mem-ui-4227.spec.ts`、PC と スマホの viewport の 2 通り）

- 一覧・追加・編集・close（PC・スマホ）
- 同時編集の競合：2 つのページで同じ項目を開き、片方で保存 → もう片方の保存が 409 になり、3 つの値が並ぶ。載せ直しで保存できる
- 古い差分：Agent の API（`instanceId` つき）で項目を更新 → 開いたままの画面が再読込で「更新されました」を出す
- mode の画面：`derived` で操作が無効・`off` で一覧が出ない
- 閉じるときの流れ：Agent の応答は API で模す（`proposals`・`done` を試験から呼ぶ）。未応答（期限を試験の時計で進める）・確定の失敗（mode を途中で `derived` に）・取り消し・強制終了の 4 通りで、画面の表示と提案の状態
- 開くときのポップアップ：境界の行を試験の DB に作り、3 行の preview と 3 択の送信の本文（`brief`・`briefDetail`）を route の要求で確かめる
- 実機（tmux・本物の Agent）で確かめるもの（kill の成功・Agent が依頼の文に従って `handoff propose` を打つか・5 分の期限が足りるか・D2 の先頭の行の表示）は UAT に回す（D2 §8 と同じ分け方）

---

## 8. 対になる場所（探した結果）

| 対 | 探した結果 |
|---|---|
| PC とスマホの「終了」 | 同じ hook（`openActiveKillConfirm`・`handleKillConfirm`、`useWorktreeDetailController.ts:1806`・`:1823`）を通る［事実］。分岐はそこに置けば両方に効く。設定の画面の「再起動」（`AgentUpdatesCard.tsx:178`）と roles の画面（`InstanceRolesSection.tsx:111`）も kill-session を直接呼ぶ — **終了の流れに入れない**（設定の変更のための再起動で、作業の終わりではない）。この 2 つで終わったら「記録なし」になる［見立て。§9 U4］ |
| 画面の送信の経路 | D1 §4.1 の表の 5 か所（`MessageInput.tsx`・`ChatSurface.tsx`・`MobileTerminalTab.tsx`・`SessionTile.tsx`・`usePendingMessages.ts`）が `src/lib/api-client.ts` を通る［D1 の事実。G では共通の 1 か所を実装の契約で確かめる］ |
| 画面の印の写し | A の `screen-client.ts`（設定）・B の引き取り・E の承認・G の 3 つ目の client。`screenRequestHeaders()` を共有し、印の判定は `isScreenRequest` の 1 か所 |
| 型の写し `src/cli/types/` | `handoff` の CLI の型を新しく置く。A の `mem` の型を写さず import する |
| 文書の ja・en | `docs/user-guide/` の mem の節（A・E が作る）に G の節を足す。見出しの対は `tests/unit/docs/ja-en-heading-parity.test.ts` が見る |
| 古い動きを固定している試験 | kill の確認の Modal を固定している試験（`kill-session-confirm-button` の testid）は、`popup=0`（既定）では今どおり出るので変わらない［見立て。実装の契約で `git grep -l 'kill-session-confirm-button' -- tests` で確かめる］ |

## 9. 未確認・未決（レビューで見てほしい点）

| # | 点 |
|---|---|
| U1 | 期限の値（Agent 5 分・全体 60 分・延長 2 回）。UAT で Agent の 1 ターンの長さを測って決め直す |
| U2 | 無人の扱いの単位をブランチ（A の `popup`）にしたこと。セッションごとに切り替えたい運用があるか |
| U3 | worktree が消えたブランチの項目を画面で編集できない（読むだけ）こと。人の編集に instance の所属が要らない形（所有を repository に寄せる）は A の D5 の解釈を変えるので採らなかった |
| U4 | 設定の画面・roles の画面の kill を終了の流れに入れないこと |
| U5 | 「ここまでの提案で進む」（`done` が無い）を `unconfirmed` にする厳しさ。人が全部見て確定したなら `confirmed` にしてよいという読みもある |
| U6 | `add` の提案の作成者を Agent（`author:'proposer'`）にし、承認を提案の行に残す形。brief の作者の欄は `agent` になる。人の承認を項目の側にも残すべきか（A の列を足すことになるので、足すなら止める点） |
| U7 | v70 の番号（E が v69）。マージの順で入れ替わる |
| U8 | D2 の先頭の行が `decline` で届かないこと（§3.2）。`decline` でも先頭の行だけは付ける案は D2 の「1 つの会話に 1 回」の規則と予算の扱いに触るので採らなかった |

## 10. 本文に無い指摘（この Issue では直さない）

- `docs/design/mem-store-4221.md` §3.2 の「`recorded` の `mem close` は断る。人が画面で閉じる」に対し、`transitions.ts:45-48` は人の経路も断る（E §8.5 と同じ指摘。§6 S2 で扱う）
- A の項目の route（`POST/PATCH …/mem/items`）は印を見ず `instanceId` だけで書くので、CLI 以外のローカルのプロセスも `instanceId` を名乗れば Agent として書ける。A §11.3 の「防げないこと」の範囲で、新しい穴ではない（記録だけ）
