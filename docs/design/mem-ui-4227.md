# mem の閲覧・編集と、対話・無人に応じた開始と終了の流れ（Issue #4227 / Epic #4220 の子 G）設計

- 状態：設計の段（**第 4 版**、実装前）。第 1 版（`b832056a6`）に PM の決定（`pm-decision-4226-4227-stops.md` の G の節）と Codex の事前レビュー（`prereview/review-4227.md`、P1 3・P2 7・P3 1）を反映したのが第 2 版（`9ea305362`）。第 3 版は PM の決定（`pm-decision-4226-s3-4227-sf.md` の G の S-F の節と F の番号の節）と Codex の再確認（`prereview/review-4227b.md`、残件 P1 3・P2 4）を反映した。第 4 版は Codex の 3 回目の再確認（`prereview/review-4227c.md`、P1 1・P2 4）だけを局所に反映した。処置の一覧は §11（1 回目 §11.1・2 回目 §11.2・3 回目 §11.3）。`src/`・`tests/` は変えていない。実装は同じブランチの別の契約で行う
- **第 3 版・第 4 版で新しく止める点は無い。** 第 2 版の S-F は PM が (a)（C に旗を 1 つ足す）に決めた（§0.0）。migration の番号は **G = v71**（E = v69・F = v70。マージの順 E → F → G）
- 前提：Epic #4220 の決定事項 D1〜D13（とくに D3・D5・D6・D9・D11）。A（#4221）`docs/design/mem-store-4221.md`（以下「A」）、B（#4222）`docs/design/mem-close-when-4222.md`（「B」）、C（#4223）`docs/design/brief-4223.md`（「C」）、D1（#4274）`docs/design/session-boundary-brief-4274.md`（「D1」）。並行の D2（#4224）`brief-injection-d2-4224.md`（`feature/4224-worktree` `d21b22712`、「D2」）と E（#4225）`mem-promote-4225.md`（`feature/4225-worktree` `78ceab299`、「E」）は読むだけ
- 凡例：**［事実］** = この文書を書いた時点（2026-11-09、`feature/4227-worktree` = develop `55b8192e0`）でファイルと行を読んで確かめたもの。**［見立て］** = 設計としての判断。**［未確認］** = 読んでいない・実測していないもの。行番号は確認時点のもので、実装の契約では名前で探し直す

---

## 0. 止める点

### 0.0 第 2 版で止めた点 S-F（**PM の決定済み：(a) C に旗を 1 つ足す**、2026-11-09）

PM の決定：**(a) を採る。** C の `FitTextOptions` に `itemCap?: boolean`（既定 `true`）と、provider の `BriefRequest`（`src/lib/session/brief-provider.ts:23`）に `detail?: 'short' | 'full'` の **2 つの欄だけ** を足す。C の既存の `it` と出力は 1 バイトも変えない（既存の試験がそのまま通ることで示す）。足すのは **G-PR3**（D2 のマージ後、S-B と同じ PR）。理由（PM）：(b) の「詳しく」への呼び替えは Issue の「全文」を満たさず、受入基準の文面を変えることになる。(a) は既定が今どおりで、C の出力と既存の試験は変わらない。

決めた形［見立て。§3.2・§7.4 H20 で固定］：

- `fitText`（`src/lib/brief/fit.ts:45`）は今 `const all = options.maxBytes === null` を「項目ごとの省略をしない」と「予算と行の上限を見ない」の両方に使う。これを 2 つに分ける：`uncapped = all || options.itemCap === false` を `fittedEntryLine(…, uncapped)` に渡し、`takePrefix`・`maxLines`・`BriefOverBudgetError` の判定は今どおり `all`（`maxBytes === null`）だけで決める。`itemCap` を渡さない呼び出し（CLI の `brief`・route・provider の `short`）は今と同じバイト列
- `itemCap:false` でも **全体の予算（`maxBytes`）と行の上限（`maxLines`、#2464）は今どおり効く**。入らない項目は今どおり項目ごと落ち、`omitted` と `all=` の案内が付く（C §2）。withheld の項目は本文を持たない（`entryLine` は `withheld=` だけを出す、`render.ts:78-89`）ので形が変わらない。D2 の先頭の必須の行（D2 §7.4）は provider が今どおり先に置く
- 見えない文字の置き換え（C の `sanitizeBriefField`・`revealInvisible`、`src/lib/brief/sanitize.ts`）は情報源の読みと `entryLine` で行われ、`itemCap` の分岐より前にある。`full` でも同じ関数を通る（新しい描き方を作らない）
- provider（`src/lib/brief/provider.ts:129-138` の `fitText` の呼び出し）は `request.detail === 'full'` のときだけ `itemCap:false` を渡す。`detail` が無い・`'short'` は今どおり。予算は D1 の `briefBudget` が S-B の `briefDetail:'full'` で `BRIEF_BUDGET.text.max`（49,152）と #2464 の上限の小さい方にする（§3.2）

第 2 版の比較の表（記録）：

| # | 止める点（箇所と理由）［事実］ | 最小の追加の案［見立て］ | 変えずに済む代わりの意味づけ［見立て］ |
|---|---|---|---|
| **S-F** | **「全文を読む」は、予算を広げるだけでは全文にならない。** C の `fitText`（`src/lib/brief/fit.ts:45-60`）は `maxBytes` が有限のとき、各項目を `fittedEntryLine(entry, read, all=false)`（`src/lib/brief/render.ts:95-100`）で描き、1 行が `BRIEF_ITEM_MAX_BYTES`＝512（`src/types/brief.ts:43`）を超える本文は **全体の予算に入っても** 省略形（`…(本文 N bytes を省略。読む: …)`）にする。省略しないのは `maxBytes === null`（`--all`）のときだけで、そのときは #2464 の行の上限 `maxLines` も見ない（`fit.ts:52-54`）。D1 の provider の送信は #2464 の上限の内の有限の予算でしか作れない（`session-brief.ts:290-292` の `briefBudget`）。よって送信に「全文」を付けるには **C の `fit.ts`・`render.ts`（と provider の `BriefRequest` の欄）を変える** ことになり、PM の決定（S-B は送信の route の欄を足すだけ）の範囲を超える。加えて、`injectOnStart=false` のブランチでは D1 が `skipped(disabled)` で何も付けない（`session-brief.ts:288`）ので、どの選択でも brief は届かない | C の `FitTextOptions` に旗を 1 つ足す：`itemCap?: boolean`（既定 `true`＝今どおり）。`false` のとき `fittedEntryLine(…, all=true)` で描き、全体の予算（と `maxLines`）は今どおり守る（入らない項目は今どおり項目ごと落ちて `omitted` と `all=` の案内が付く）。provider の `BriefRequest` に `detail?: 'short' \| 'full'` を足し、`full` のときだけ `itemCap:false`。C の既存の `it` と出力は変わらない（既定が今どおり）。足すのは G-PR3（D2 のマージ後、S-B と同じ PR） | **「全文」を「詳しく」と呼び替える。** 予算だけを広げ（`BRIEF_BUDGET.text.max` と #2464 の上限の小さい方）、各項目は今どおり 512 バイトで省略形にする。ダイアログの文言は「詳しく読む（長い本文は省略。全文は `commandmate brief --all` で読めます）」。C・provider を変えない。Issue の 3 択（短い要約／全文／読まない）のうち「全文」は満たせないが、送信に付く情報は増える |

- **決定（第 3 版）：「最小の追加の案」を採った。** §3.2 の `briefDetail:'full'` の行は「全文を読む」に戻し、§7.4 H20 に陽性・陰性の対照を足した。「代わりの意味づけ」（「詳しく」）は採らない
- `injectOnStart=false` の扱い（C を変えずに決められる）：G-3 は **`injectOnStart=true` のときだけ出す**（§3.2 の出す条件）。false では何を選んでも付かないので、選ばせない

### 0.0b PM の決定済みの止める点（第 1 版の §0。決定を反映して書き換えた）

PM の決定（2026-11-09、人が PM の推奨に委任した範囲）：**S-A・S-D・S-E は採る**（A・E の既存の入口・行・`it` は変えず、足した入口は `ENTRANCES` の行と 3 つの不変条件の対照で固定）。**S-B・S-C は採る。ただし D2 のマージ後に G の PR で足す**（D2 の契約は変えない）。**S3 は §6 の案**（画面だけに警告、CLI・brief に文言を足さない）。**migration は G = v71**（E = v69・F = v70。当初の決定は G = v70・F は足さないだったが、2026-11-09 の PM の決定で F が v70 を使うことになり、G は v71 に入れ替えた）。**マージの順は E → F → G**（G は D2 のマージも前提）。

下の表は、決定の内容と、事前レビュー（§11）で具体化した点を書いたもの。

| # | 点（箇所と理由）［事実］ | 決定（採る形）［見立て。§11 の処置を反映］ | 採らなかったときの代わり（記録） |
|---|---|---|---|
| **S-A** | **人が画面で項目を追加・編集・close する入口が無い。** A の項目の書き込みの入口 `memAddItem`（`src/lib/mem/service.ts:362`）・`memUpdateItem`（`:427`）・`memCloseItem`（`:479`）は、どれも `lookupActor(db, worktreeId, body.instanceId, 'agent')`（`:368`・`:434`・`:486`）で **Agent として** 書く。人（`'human'`）で書くのは #2427 の画面のメモ `writeSessionNoteFromScreen`（`:731`・`:737`）だけ。store の側は人を受けられる（`ownedBy` は `actor.by === 'human'` なら真、`src/lib/db/mem-db.ts:857-858`。`createMemItem` は `actor.by` を `created_by`・`updated_by` に書く、`:733-734`）。`lookupActor` は private で、版・世代・mode の照合も service の中にある。G の lib から mem-db を直接呼ぶと、A の試験「store の書き込みは service からだけ」（`tests/unit/lib/mem/write-entrances-recreate-4221.test.ts`、E §7.1 が `:290-295` と引く）を破り、照合を写すことになる **採る（決定）。** `src/lib/mem/service.ts` に入口を **1 つ** 足す：`memWriteFromScreen(db, worktreeId, body, deps)`。`body = { op:'add'\|'update'\|'close', instanceId, itemId?, ifVersion?, kind?, text?, closeWhen?, evidence?, reason?, key?, confirmUnreflected?, pin?: { worktreeIncarnation, instanceLifetime, membership: { repositoryId, branch, detached } }, expectBranch?, author: 'human'\|'proposer', fence? }`。中は既存の `memAddItem`・`memUpdateItem`・`memCloseItem` と同じ検査（validate・`parseCloseWhen`・`resolveTarget` の mode `on`）を通し、`lookupActor` の `by` だけを `author` から決める（`human` → `'human'`、`proposer` → `'agent'`）。**`by='human'` は A の `ownedBy` を素通りする（`mem-db.ts:857-858`）ので、A の Agent の口が所有の照合で暗に得ている検査を、最終の書き込みの区間（`resolveTarget` の同期の callback を 1 つの `db.transaction` に包んだ中）で明示する**：(i) 対象の項目の `owner.repositoryId`・`owner.branch` が、要求先 worktree の `resolveTarget` の結果と一致する（`on` の worktree の route から `off` の別ブランチの item ID を書けない）、(ii) mode は `on`、(iii) 要求の寿命：`lookupActor` の時点で固定した worktree の世代（`getWorktreeIncarnation`）と instance の寿命（`readInstanceLifetime`）が、最終の区間の値と同じ。instance の比較は D1 の `isSameInstanceLifetime`（`session-brief-db.ts:201`）を使い、正当な `null→lazy` の発行は拒まない。違えば 409 `incarnation_changed`、何も書かない。(iv) **所属の固定（第 3 版、再確認 P1-3）**：`pin.membership` があれば、最終の区間の `resolveTarget` の結果（`storageRepositoryId`・`branch`・`detached`）が `pin.membership` と同じ。違えば 409 `membership_changed`、何も書かない。A の `memAddItem` は最終に解決した target の scope に保存する［事実：`service.ts:389-397` の `scopeOf(target)`］ので、(i) の既存の項目の所属の照合だけでは、await（`askConditionGit`）中に同じディレクトリの HEAD を別のブランチへ変えたときの **新しい `add`** を防げない。画面の G-1 の `add` は `pin` の代わりに `expectBranch`（画面が開いている `?branch=` の値、detached は `null`）を送り、同じ照合を受ける（同じ理由の対になる場所）。`pin` は呼び手（G の `decide`）が依頼の時点の世代を渡すとき（E の S1 の案 1 と同じく「比較する元の世代は呼び手が渡す」）。`fence` は `decide` が渡す同期の関数で、同じ transaction の中で項目の書き込みの直前に呼ばれ、偽なら何も書かない（§4.5）。close の版の照合と `recorded` の close は S-D の store の関数を使う。`now` の kind は `memAddItem` と同じく 400 `invalid_request`（人の `now` の枠は #2427 の `writeSessionNoteFromScreen` のまま、§2.2）。**既存の 3 つの入口と A の store の既存の関数の振る舞いは変えない**。`ENTRANCES` に行（`screen-add`・`screen-update`・`screen-close`・`screen-close-recorded`・`proposal-add`）を足し、既存の 3 つの不変条件（作り直し後の古い要求・`off`/`derived`・版の競合）を表の行で回す（既存の行・`it`・期待値は変えない）。呼び手は G の lib（`src/lib/handoff/**`）と G の route だけ（ガードで固定） | 人の編集を #2427 の `now` の枠だけにし、他の kind の追加・編集・close と、終了の流れの「確定」を作らない（受入基準の「一覧・編集・同時編集の競合」と「承認した提案だけを確定」を満たせない） |
| **S-B** | **開くときの「全文を読む」「読まない」を送信へ渡す口が無い。** 送信の route は `brief` に `'skip' \| 'force'` だけを受ける（`src/app/api/worktrees/[id]/send/send-request.ts:56`・`:101-105`）。`skip` は「この送信だけ付けない。境界は `pending` のまま」（`src/lib/session/session-brief.ts:247-251`）なので、次の送信に brief が付き「読まない」にならない。予算は `briefBudget` が `provider.defaultBytes`（text 4,096、`src/types/brief.ts:38`）で頭打ちにする（`session-brief.ts:101-111`）ので「全文」を頼めない。D2 はこの 2 つを足さない（D2 §0.1・§9.1 の変えるファイルの表） **採る（決定）。D2 のマージ後に G-PR3 で足す（D2 の契約は変えない）。** D1 の口に **欄を 3 つ足す**（既存の値の意味を変えない）：(1) `brief: 'decline'` — 境界を `skipped(declined)` として消費し、この送信には付けない（`BoundarySkipReason` に `'declined'` を足す、`src/lib/db/session-brief-db.ts:28-35`）。(2) `briefDetail: 'short' \| 'full'`（`brief` が無い＝`auto` のときだけ）— `full` は `briefBudget` の上限を `BRIEF_BUDGET.text.max`（49,152）にし、provider へ `detail:'full'` を渡す（S-F の (a)。項目ごとの 512 バイトの省略をしない「全文」）。(3) `briefBoundary: <boundary id>` — 画面が preview で見せた境界。`decline`・`full` は、送信の直前の排他の区間（D1 の `claimInStretch`、入力の排他の中）で今の境界をもう一度照合し、この ID の `pending` でなければ **消費も付与もせず、本文も打たず** 409 `boundary_changed`（理由つき）を route まで伝える（§3.2 の最終の照合）。どれも #2464 の上限（`SEND_VERIFIED_MAX_BYTES`）の内で、利用者の本文は削らない（D10）。**画面の側の契約も同じ PR に含める**（§3.2.1）：`worktreeApi.sendMessage` の options と body の直列化、楽観送信（`onOptimisticSend`・`usePendingMessages`）の options、保留と再送での選択の保持、応答の `brief` を画面へ返す型 | 画面の選択を「短い要約を読む（`auto`）／今回は読まない（`skip`、次の送信に付く）」の 2 つにし、「全文」は `commandmate brief --all` の案内の 1 行を画面に出すだけにする（Issue の 3 択を満たせない） |
| **S-C** | **「終わる前の更新」の記録を D2 の読み口に渡す場所が C のファイルになる。** D2 は読み口 `readPreEndUpdate(db, { worktreeId, instanceId, before })` → `'recorded' \| 'not_recorded'` を `src/lib/brief/sources.ts`（C のファイル）に置き、「G・F が書き手になるまでは常に `not_recorded`」とする（D2 §7.2 X4・§9.1 の表）。G がその中身を書き換えると C のファイルを変える **採る（決定）。D2 のマージ後に G-PR3 で接続する（D2 の契約は変えない）。** D2 は読み口の本体を `sources.ts` に置いたままマージされる前提で、G-PR3 は (1) 新しい読み専用のモジュール `src/lib/handoff/pre-end.ts`（副作用なし・書き込みなし・依頼の表を読むだけ）に本体を置き、(2) `sources.ts` の `readPreEndUpdate` の本体を「`pre-end.ts` を呼ぶ 1 行」に変える（C のファイルの変更はこの 1 か所だけ。D2 の X1〜X4 の判定と先頭の行の文言・上限は変えない）。接続の試験は D2 のその時点の契約（先頭の行の上限は **D2 の値をそのまま import して** 使い、G に数値を写さない。§4.6）で固定する | G は記録（§5.6 の表）だけを作り、D2 の読み口は `not_recorded` のまま残す（次の世代の先頭の行が「確認できない」を出し続ける。安全側だが、確かめた終了も「確認できない」と出る） |
| **S-D** | **S2：`recorded` の decision を人が閉じる遷移が無い。** `memTransition('decision','recorded','close')` は `{ ok:false }`（`src/lib/mem/transitions.ts:45-48`）。A §3.2 は「`recorded` の `mem close` は断る。人が画面で閉じる」と書くが、人の経路も遷移の表で断られる。E は作らない（E §0.1 S2） **採る（決定）。** (1) `transitions.ts` に遷移を **1 つ** 足す：`'withdraw-recorded'`（`recorded` → `closed`、`close_reason='withdrawn'`）。(2) **遷移を足すだけでは届かない**（A の `closeMemItem`（`mem-db.ts:923`）は `'close'` 固定で `ifVersion` も無い）ので、A の store に **新しい関数を 1 つ** 足す：`closeMemItemVersioned(db, actor, itemId, { ifVersion, reason, transition: 'close'\|'withdraw-recorded' }, now)`。中は 1 つの `db.transaction` で、版の比較（違えば `version_conflict` と今の値）→ 所有（`ownedBy`）→ `memTransition(kind, state, transition)` → close を行う。既存の `closeMemItem` は変えない（CLI の `mem close` と A の route は今どおりそれを呼ぶ）。(3) `withdraw-recorded` を渡すのは `memWriteFromScreen` の `op:'close'`・`author:'human'`・`confirmUnreflected:true`・項目が `recorded` の decision のときだけ。`confirmUnreflected` が無ければ 409 `confirmation_required`。Agent の提案の `close` は常に `transition:'close'`（`open` の decision の取り下げだけ）。CLI の `mem close`（Agent）は今どおり 55 `state_forbids`。画面は「正本へは反映しないことにして閉じる」と明示した確認（2 段の押下）の後でだけ送る。§6 S2 | `recorded` は「反映を確かめた」（E の `confirm-reflected` → `promoted`）の後に閉じるだけにする。反映しないと決めた decision は `recorded` のまま残り、14 日で「未反映・古い」の警告が出続ける（`staleness.ts:19-35`）。purge も既定で除く（A §8.3） |
| **S-E** | **mode の画面を広げると A の部品を変える。** mode の画面は A の `src/components/mem/RepositoryMemSettings.tsx`（`RepositoryList.tsx:752` で描く）。Issue は「A の最小の画面を広げる」 **採る（決定）。** **画面の部品だけ**（lib・API・DB は変えない）の変更とする：各 mode の説明・機能の切り替えの文言（とくに `popup` を「対話：開始・終了の確認を画面に出す」と書く、§5.1）・スマホの幅の並び・worktree の画面から今のブランチの上書きを開く入口。API は既存の `memSettingsApi`（`src/lib/mem/screen-client.ts`）のまま | 新しい部品 `src/components/mem/MemModePanel.tsx` を作って `RepositoryList.tsx` の描く先を差し替える（A の部品は残る＝使われないコードが残る）。推奨しない |

D1〜D13 と違う作りは採らない。D の文面だけでは一意に決まらず、この文書が選んだ解釈は §0.1。

**D2・E の worktree とファイルは触っていない**（`git -C … show HEAD:…` で読んだだけ）。

### 0.1 選んだ解釈

| # | 文面 | 選んだ解釈 | 理由 |
|---|---|---|---|
| G1 | D11「無人かどうかは人が選ぶ設定」と、A の機能の切り替え `popup`（`mem_repository_settings.popup`・`mem_branch_overrides.popup`、A §10.1 の「G が読む」） | **`popup` を「対話の扱い」の設定として使う。** `popup=1`（対話）＝開くとき・閉じるときに画面に確認を出す。`popup=0`（無人、既定）＝出さない。単位は A と同じ repository の既定＋ブランチの上書き（D4）。保存先は DB（A の表）、変える経路は画面だけ（A §11.2 の印、既にある） | 新しい表・新しい書き込みの経路を足さずに D11 を満たす。auto-yes の状態（`auto-yes` の表・API）とは別の置き場で、互いに読まない。既定 `0` は D3 の既定 `off` と同じ向き（人が選ぶまで何も出さない）。worktree・セッション単位の「いま見ている」の切り替えは採らない（§5.1 の注） |
| G2 | Issue「Agent は通常の CLI では確定せず、提案として置き場に出す」 | 終了の流れの依頼の中で Agent が使う口は **提案の口だけ**（`commandmate handoff propose`）。依頼の文面がそれを指示する。ただし同じ時間に Agent が `mem add` などで直接書くことは **止めない**（止めるには A の入口すべてに G を呼ばせる必要があり、同じ OS 権限では保証にもならない、A §11.3）。直接書かれた更新は画面に「提案を経ずに確定した更新」として別の欄に出し、巻き戻さない | Issue の「確定済みの更新は巻き戻さない」と同じ扱い。止められない書き込みを止めたことにしない（D3 の検査の限界） |
| G3 | Issue「開くとき：3 行の preview つきで選ぶ」 | 「開くとき」＝画面から送る **最初の送信の直前** に、その instance に `pending` の境界がある（D1 の台帳）とき。CLI・orchestrate・Timer など画面の外からの送信ではポップアップは出ず、`auto`（短い要約）になる | D1 の境界は「次の付けてよい送信」で消費される（D1 §3）。画面がそれより先に人へ聞ける時点は、画面の送信の直前だけ |
| G4 | Issue「人が承認した提案だけを、項目の版を照合して確定する」 | 提案は **作った時点の項目の版（`base_version`）** を持つ。確定は「人が画面で見た提案の指紋」と `base_version` を送り返し、今の項目の版と一致したときだけ書く（S-A の入口の `ifVersion`）。違えば提案は `conflict` になり、今の項目と並べて出し直す（自動で今の版に載せ替えない） | E の preview と同じ考え方（E E2）。承認を「人が見たもの」に結ぶ |
| G5 | Issue「『終わる前の更新を確認できない』事実を次の世代へ残す」 | 「確認できた」を **狭く** 定義する：その instance の終了の依頼が「確定して終了」（強制でない）で終わり、かつ Agent の応答（`done`）・人の全提案への判断（承認して確定 or 捨てる）・確定の全成功・**サーバが確かめた** kill の成功（§4.6）の **全部** を満たしたときだけ `confirmed`。**強制終了（「今すぐ終了」）は 4 条件より優先して必ず `unconfirmed(forced)`**（`done` 済み・提案 0 でも）。1 つでも欠ければ `unconfirmed`（理由の語つき）。依頼が無い終わり方（CLI・異常終了・orchestrate の掃除）は記録が無い＝確認できない |
| G6 | 依頼・提案・kill・end を「同じセッション」に結ぶ | **会話の寿命の鍵を D1 の境界の行（`session_brief_boundaries` の `id`）にする。** 依頼を作るとき、その instance の今の境界（`getCurrentBoundary`、最も大きい `seq`）の `id` を固定する。以後の提案・`done`・`decide`・`end` は、今の境界の `id` が固定した値と同じで、かつ instance の寿命（A の在籍の世代、`isSameInstanceLifetime`）が同じときだけ受ける。境界は起動（`launch`）・自動の再起動・reset・resume・明示（`explicit`）で新しい行になる（`session-brief-db.ts:24`）ので、在籍を変えずに kill→再起動した後の古い要求は拒まれる。画面の再読込・WebSocket の再接続は境界を開かないので受ける | A の incarnation は在籍の寿命で、プロセスの起動の世代ではない（`src/lib/mem/incarnation.ts:1-12`。kill→再起動は `beginAgentEventGeneration` を進めるが incarnation は変えない、`agent-session-lifecycle.ts:99`）。永続化された会話の区切りで、既にあるのは D1 の境界だけ。`explicit` を「新しい会話」と数えるのは安全側（確認できない側）に倒れる［見立て］ | D2 §7.1 の文言は「確認できない」で断定しない。確認できなかった側に倒す（「確かめた」と誤って出す方が害が大きい） |

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
| 最新の migration | `CURRENT_SCHEMA_VERSION = 68`（`runner.ts:34`）。E が v69（E §6.1）、F が v70（PM の決定 2026-11-09） | G は **v71**（PM の決定。E → F → G の順にマージされる前提。順が変われば実装の契約で番号を入れ替える） |
| decision の遷移 | `transitions.ts:39-56`。`recorded` の `close` は断る（`:45-48`） | S-D |
| 在籍の世代とプロセス | A の incarnation は在籍（roster の削除・再追加）の寿命（`src/lib/mem/incarnation.ts:1-12`）。kill→再起動は event の世代（`beginAgentEventGeneration`、`agent-session-lifecycle.ts:99`）を進めるが incarnation は変えない。D1 の境界の行は起動・reset・resume ごとに新しい `id` になる（`session-brief-db.ts:24`・`getCurrentBoundary` `:139`） | 会話の寿命の鍵は D1 の境界の `id`（§0.1 G6） |
| kill の口 | `worktreeApi.killSession(id, cliToolId?, instanceId?)`（`src/lib/api-client.ts:771`）は期待する世代を渡す欄を持たない。kill の本体は `kill-session/route.ts` の中に直書き（`:123-160`、`cliTool.isRunning`・`cliTool.killSession`） | G の終了は画面の kill を使わず、G の `end` の route がサーバで照合してから kill する（§4.6）。kill の本体は route から共有の関数へ移す（振る舞いは変えない） |
| 画面の送信の欄 | `sendMessage` の options は `{ cliToolId?, instanceId?, imagePath? }` だけで、`brief` を body に入れない（`api-client.ts:677-700`）。`MessageInput` の楽観送信は `onOptimisticSend` の直後に下書きを消す（`MessageInput.tsx:420-428`） | S-B の画面の側の契約（§3.2.1） |
| C の「全文」 | 有限の予算では項目ごとに 512 バイトで省略形（`fit.ts:45-60`・`render.ts:95-100`・`types/brief.ts:43`）。`injectOnStart=false` は D1 が付けない（`session-brief.ts:288`）。provider の要求の型 `BriefRequest` は `src/lib/session/brief-provider.ts:23`、`fitText` を呼ぶのは `src/lib/brief/provider.ts:129-138` | S-F（§0.0、PM の決定 (a)） |
| C の順位 1 | 情報源 `state`・`relay` の「読めない」行も順位 1（`BRIEF_STATUS_ROW_RANK`、`sources.ts:83-93`）。実際の待ちは `state` の `waiting`（`:182-199`、欄 `instance`）と `relay` の `state=prompt`（`relayItem`、`:244-262`。欄は `dir`（`owed`＝この instance が `to`、`awaiting`＝この instance が `from`）と `peer`＝`<worktreeId>/<instanceId>`。専用の待ち先の欄は無い）。relay の `from` は依頼した側、`to` は働く側で、`prompt` は **働く側（`to`）** が確認で止まったこと（`src/lib/db/migrations/v60-session-relays.ts:13-18`・`src/lib/relay/relay-badges.ts:20-25`・`:102`） | 人への質問の件数は順位でなく分類で数え、鍵は `(worktree, instance)`（§3.1.1） |
| 送信の直前の照合（D1） | D1 の `claim()` は入力の排他の中の `claimInStretch` で所属・境界・寿命を照合し、不一致・例外では **本文だけを打つ**（`session-brief.ts:347-360` の `return this.input.content`）。`claimed` は消費ではなく、送れなければ `settleBoundaryClaim(…,'not_sent')` で `pending` に戻る（新しい境界があれば `superseded`、`session-brief-db.ts:362-403`） | §3.2 の最終の照合（`decline`・`full` は本文だけにせず 409） |
| 起動と kill の排他 | 入力の排他（`withInstanceInputLock`、`instance-input-lock.ts:542`）は composer への書き手の順で、起動・kill を並べない。kill-session の route は `checkSessionOwnership`・`isRunning` を await してから `killSession` を呼ぶ（`kill-session/route.ts:129-152`）。起動の呼び出しは `send-session-start.ts:98-105`・`cli-tools/base.ts:800` など。src に tmux の `session_created`・`pane_pid` を読む所は無い（`git grep` で 0 件）。`pane_pid` は pane の最初のプロセス（shell）で、Codex は shell と pane を残して Agent だけを起動し直す（`codex.ts` の `resolveLaunchPane` の relaunch と `relaunchIntoSamePane`）ので、`pane_pid` は Agent の世代ではない（第 4 版）。tmux の `killSession` を直接呼ぶ所は `cliTool.killSession` の外にもある（`session-cleanup.ts:274`・`:314`、`claude-session.ts:712`、`session-key-sender.ts:166`、`base.ts:983`・`opencode*.ts` の stop） | §4.6 の排他と実プロセスの世代（新設、第 4 版で Agent のプロセスの世代に） |
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
  - `now`：G の項目の API では追加・編集しない（S-A は `now` を 400 で断る。A の `memAddItem` と同じ）。人の `now` の枠の書き込みは既存の #2427 の画面のメモ（`writeSessionNoteFromScreen`、`service.ts:731`）の経路のまま。G-1 はその枠を表示し、編集はその既存の画面へ移る入口を置くだけ。終了の流れの提案も `now` を扱わない（§4.3）
- 未配送の知らせ（B）：`GET …/notices?branch=` の一覧と「引き取る」（印つき、既存の API）
- 終了の記録（§4.6）：その branch の直近の終了の依頼と結果（`confirmed`／`unconfirmed`＋理由）。読むだけ

### 2.3 書き込みの API（G、新規。すべて印が要る）

| API | 本文 | 結果 |
|---|---|---|
| `POST /api/worktrees/:id/mem/screen/items` | `{ instanceId, kind, text, closeWhen?, evidence?, key, expectBranch }` | S-A の `memWriteFromScreen({op:'add', author:'human'})`。`key` は画面が 1 回の押下ごとに作る（A §5.4 の冪等。二重押下・再送で 2 件にしない）。`expectBranch` は画面が開いているブランチ（detached は `null`）で、最終の区間で解決した target と違えば 409 `membership_changed`、何も書かない（S-A の (iv)） |
| `PATCH /api/worktrees/:id/mem/screen/items/:itemId` | `{ instanceId, ifVersion, text?, closeWhen?, evidence? }` | `op:'update'`。版が違えば 409 `version_conflict` と今の項目（A §12.2 の形） |
| `POST /api/worktrees/:id/mem/screen/items/:itemId/close` | `{ instanceId, ifVersion, reason?, confirmUnreflected? }` | `op:'close'`。版の比較と close は S-D の `closeMemItemVersioned` の 1 つの transaction（承認の後に他者が更新していれば 409 `version_conflict`）。`recorded` は `confirmUnreflected:true` が無ければ 409 `confirmation_required`、あれば `withdraw-recorded`（S-D） |
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
  "injectOnStart": true,       // A の機能の切り替え。false なら show:false（§0.0 S-F の注）
  "mode": "on" | "derived",    // off・曖昧・未登録は { ok:true, show:false }
  "boundary": { "id": "…", "kind": "launch" | "auto_restart" | "reset" | "resume" | "explicit" } | null,
  "preview": {
    "open": { "count": 7, "unreflected": 1 },                // 1 行目
    "humanQuestions": { "count": 2, "unknownSources": [] },   // 2 行目（unknownSources が空でなければ「不明」を添える）
    "lastUpdatedAt": "2026-11-09T03:12:00Z"                  // 3 行目（null = 記録なし）
  } }
```

| 行 | 中身 | 読む所［見立て。読み口はすべて既存の export］ |
|---|---|---|
| 1 | `open` の項目の件数（そのブランチ、kind を問わず。`now` の枠を含む）と、うち未反映の decision（`recorded`）の件数 | A の `memList`（`service.ts:527`）の結果を数える。`derived` は A の表どおり `frozen` の項目を数える |
| 2 | 人への質問の件数 | C の `briefForRoute`（`src/lib/brief/service.ts:54`）の `format=json`・`all=1` の `entries` を、**表示の順位ではなく分類で** 数える（§3.1.1） |
| 3 | 最終更新 | 1 行目の項目と `now` の枠の `updatedAt` の最大（作者を問わない）。D2 §7.3 の「この instance の最終更新」とは別の値（あちらは Agent の更新だけ） |

#### 3.1.1 人への質問の分類（順位と分ける）

C は情報源 `state`・`relay` の「読めない」行にも順位 1 を使う（`BRIEF_STATUS_ROW_RANK`、`sources.ts:83-93`）ので、順位 1 の件数は質問の件数ではない［事実］。G は C の JSON（`BriefJson`、`src/types/brief.ts`）の **`entries[]` と `sources[]` の 2 つ** を次で分類する（G の `src/lib/handoff/preview.ts` の中だけ。C のファイルは変えない）。**C の JSON の実際の形**（第 4 版、3 回目 P2）［事実］：entry の値は `entry.fields` の中にある（`fields.waiting`・`fields.instance`・`fields.dir`・`fields.peer`・`fields.state`）。状態の行（`statusRowItem`、`sources.ts:115`）は `status` の欄を持たず、`fields.unavailable` か `fields.unsupported` に理由の語を持つ。情報源の `status`（`ok`・`unavailable`・`unsupported`・`absent`・`skipped`・`unobserved`）は entries ではなく別の `sources[]` の配列にある（`build.ts:321`）。`state` の行は `compact`（`sources.ts:108`）で null の欄を落とすので、**待っていない instance の行には `waiting` の欄そのものが無い**（null の値ではない）：

| entry | 分類 |
|---|---|
| `source=state` で `fields.waiting` の欄が **ある**（文字列の）行（`sources.ts:182-199`。欄が無い＝待っていない） | 質問。鍵＝`(preview の worktree, 行の欄 instance)`（`state` の情報源は今の worktree の roster だけを読む） |
| `source=relay`・`state=prompt`・`dir=owed` の行（`relayItem`、`sources.ts:244-262`） | 質問。この instance が働く側（`to`）で、確認で止まっているのはこの instance。鍵＝`(preview の worktree, preview の instance)` |
| `source=relay`・`state=prompt`・`dir=awaiting` の行 | 質問。この instance が依頼した側（`from`）で、止まっているのは相手（`to`）。鍵＝`peer` を **最後の `/` で** 分けた `(worktreeId, instanceId)`（instance ID は `/` を含まない［見立て。実装の契約で `isValidInstanceId` を確かめ、含みうるなら relay の行の ID から `getRelayById` で `to` を読み直す］）。別の worktree の同じ名前の instance（`claude` と `claude`）は別の鍵 |
| 状態の行（`fields.unavailable` か `fields.unsupported` の欄がある entry、`statusRowItem`） | 質問に数えない。`unknownSources` に `entry.source` を入れる |
| `sources[]` で `id` が `state`・`relay` の要素の `status` が `unavailable`・`unsupported`・`skipped` | entries に状態の行が無くても `unknownSources` に `id` を入れる（entries と sources のどちらか一方で「不明」になれば不明。`ok`・`absent`・`unobserved` は不明にしない：`unobserved` は S1 の観測が無い＝待ちの記録も無い） |
| `omitted.byRank['1']` が 1 以上（`all=1` でも行の上限などで順位 1 が落ちた） | `unknownSources` に `omitted` を入れる（数え落としを「なし」と出さない） |
| それ以外（順位 1 でも。`dir` が無い・`peer` が形に合わない relay の行を含む） | 質問に数えない。形に合わない relay の行は `unknownSources` に `relay` を入れる（数え落としを「なし」と出さない） |

- **重複の排除は `(worktree, instance)` の鍵の集合で行う**（第 3 版、再確認 P2）。instance ID だけを鍵にすると、今の worktree の `claude` の待ちと、別の worktree の `claude` を待つ relay の `prompt` が 1 件に潰れる（過少に数える）。同じ鍵に複数の行（`state` の `waiting` と `owed` の `prompt`、同じ相手への `awaiting` の `prompt` が 2 本）があれば 1 件
- 表示：`count` が 0 で `unknownSources` が空なら「人への質問：なし」、空でなければ「人への質問：0 件（state を読めず不明）」のように **不明** を出す。`count>0` なら件数（不明があれば添える）
- **試験の fixture は C の実際の関数で作る**（第 4 版、3 回目 P2）：H22(a) と e2e の「情報源の失敗」の fixture は、手で書いた JSON ではなく、`briefForRoute` に失敗する reader（`BriefBuildDeps.readers` の `state`・`relay` が投げる・時間切れ）を渡して得た実際の JSON（中の状態の行は `statusRowItem` が作ったもの）を使う。待ちの無い `state` の行も `readStateSource` を通して作る（`waiting` の欄が無い形を手で作り直さない）
- 待ち先の復元は C の出力の欄（`dir`・`peer`）だけから行い、relay の表を直接読まない（C のファイルも変えない）。`peer` の欄は C の `sanitizeBriefField` を通った値で、見えない文字が置き換わっていれば鍵が合わない → その行は形に合わない行として「不明」に倒す

- `boundary` は D1 の `getCurrentBoundary(db, worktreeId, instanceId)`（`src/lib/db/session-brief-db.ts:139`）を読むだけ。`state==='pending'` のときだけ返す。その `id` を画面は選択と一緒に送る（§3.2 の `briefBoundary`）
- `briefForRoute` は `on` で B の条件を評価する（読みのときの評価、D8・B §3.2）。preview が条件の close を起こしうることは list と同じで、新しい書き込みではない［事実：C の route のコメント `src/app/api/worktrees/[id]/mem/brief/route.ts:1-7`］
- preview の取得は 2 秒で打ち切る（D1 の provider の打ち切り `BRIEF_PROVIDER_TIMEOUT_MS` と同じ値）。取れなければ 3 行の代わりに「preview を取れませんでした」と出し、選択はそのまま出す

### 3.2 選択と送信（S-B、D2 のマージ後）

| 選択 | 送信の route の本文 | D1 の記録 |
|---|---|---|
| 短い要約を読む（既定の選択） | `brief` なし（`auto`）・`briefDetail:'short'`・`briefBoundary` | 今どおり `sent` |
| 全文を読む | `briefDetail:'full'`・`briefBoundary` | `sent`（予算 49,152 と #2464 の上限の小さい方。provider へ `detail:'full'` → C の `itemCap:false` で、**予算に入る項目は 512 バイトを超えても省略しない**（S-F の (a)）。全体の予算・行の上限・withheld・D2 の必須の行・見えない文字の置き換えは今どおり。入らない項目は C の `omitted` と `all=` の案内、C §2） |
| 読まない | `brief:'decline'`・`briefBoundary` | `skipped(declined)`（境界を消費、次の送信にも付かない）。本文が打たれなかったときは `pending` に戻す（下の最終の照合） |
| ダイアログを閉じる | 送らない（本文・画像の下書きは入力欄に残す） | 触らない |

- 出す条件：画面の送信で、`attended=true`・mode `on` か `derived`・**`injectOnStart=true`**・`boundary` がある・本文が slash コマンドでない（D1 §4.1：slash は付けない・取らない）。どれかが欠ければ出さずに今どおり `auto` で送る（`injectOnStart=false` は D1 が `skipped(disabled)` にするので、選ばせても意味が無い）
- **選択は「見せた境界」に結ぶ**（`briefBoundary`）。照合は **2 回** 行う（第 3 版、再確認 P2）：route の入口（早く断るため。省いてもよい）と、**送信の直前の排他の区間**（D1 の `claim()` の `claimInStretch`、入力の排他 `withInstanceInputLock` の中で本文を打つ直前の同期の区間）。正は後者で、前者を通っても provider の作成・入力の排他の待ちの間の変化は後者で止まる。境界の状態ごとの扱い：

  | 送信の直前の区間での今の境界 | `auto`（短い要約） | `full`・`decline` |
  |---|---|---|
  | `briefBoundary` の行が今の境界（最大の `seq`）で `pending` | 今どおり | 選んだとおり（`full` は付ける、`decline` は下の予約） |
  | 別の行が今の境界（reset・再起動で A → B） | 今どおり（B に付くか D1 の理由で付かない） | **送信を断る**：409 `boundary_changed`（`reason:'superseded'`）。B を消費・付与せず、**本文も打たない** |
  | `briefBoundary` の行が `claimed`（別の送信が予約中。消費ではない） | 今どおり | 409 `boundary_changed`（`reason:'claimed'`）。予約した送信が失敗すれば行は `pending` に戻る（`settleBoundaryClaim(…,'not_sent')`）ので「消費済み」と扱わない |
  | `briefBoundary` の行が `sent`・`skipped`・`unknown`（消費済み） | 今どおり | 本文だけを送る（D1 §3.4 の 3）。応答の `brief.state='consumed'` で「既に別の送信で引き継ぎが渡されました」 |
  | 所属・mode・`injectOnStart`・寿命が変わった（D1 の `settings_changed`・`incarnation_changed`）、provider の失敗・`over_limit`・予約の衝突（`reservation_conflict`）、区間の例外 | 今どおり（本文だけ。D1 の動きを変えない） | 409 `boundary_changed`（`reason` に D1 の語、例外は `claim_failed`）。本文を打たない。`full` の `empty`（付けるものが無い）だけは本文だけを送り、報告 `empty` |

  - **409 の伝播**：`claim()` は `full`・`decline` のときだけ、本文の代わりに「中止」（`{ abort: reason }`）を返し、`sendUserMessage` はキーを 1 つも送らずに型つきの誤り（`BriefChoiceAbortedError`）を投げる。送信の route はそれを 409 `{ error:'boundary_changed', reason, boundary: { id, state } | null }` にする（`sendUserMessage` の呼び出し元は変えない＝`CALLERS` の表は変わらない）。`auto`・`skip`・`force` は `claim()` の戻りが今と同じ（本文だけか brief つき）
  - **`full` の失敗の経路を送信のサービスまで通す**（第 4 版、3 回目 P2）［事実：今の plan は provider の失敗・`over_limit` で `skip(rowId, …)` を書いて本文だけに倒し（`session-brief.ts:314-327`）、`claim()` は区間の例外を握って本文だけを返し（`session-brief.ts:347-360`）、`sendUserMessage` は配送の例外を `classifySendFailure` で普通の送信の失敗（`stage:'send'`）に変える（`send-user-message.ts:702-728`）］。そのままでは `full` の失敗が 409 にならないか、本文だけが打たれるので、G-PR3 で次を足す：(1) plan（`session-brief.ts`）は `full` のとき provider の失敗・`over_limit`（予算・行の上限・`withinVerifiedSize`）で **`skip` を書かず**（境界は `pending` のまま、消費しない）中止の理由（`provider_failed`・`over_limit`）を持ち、`claim()` は区間に入らずに中止を返す。(2) 区間の例外（`withMemTarget` の throw）は `full`・`decline` では中止 `claim_failed`。区間で既に `claimed` にしていたら `settleBoundaryClaim(…,'not_sent')` で `pending` に戻す（誤って消費しない）。(3) `send-user-message.ts` は `BriefChoiceAbortedError` を `classifySendFailure` に渡さず、`{ ok:false, stage:'brief_choice', code:'boundary_changed', reason, boundary }` で返す（`settle` は `not_sent`。relay の保留・`prompt_waiting` の分岐より前）。送信の route はこの `stage` だけを 409 にする。(4) `auto` は (1)(2) の失敗でも今どおり本文だけ（D1 の `skip` の記録も今どおり）
  - **`decline` の予約**：区間で `briefBoundary` の行を `claimed`（`claim_token`）にしてから本文を打つ。結果で決める：`sent`・`unknown` → `skipped(declined)`（新しい関数 `settleDeclinedClaim`、`claimed` かつ同じ token のときだけ）／`not_sent` → 今の `settleBoundaryClaim(…,'not_sent')` と同じく `pending`（新しい境界があれば `superseded`）。本文が届かなかったのに「読まない」を消費しない
  - 画面（§3.2.1）：409 `boundary_changed` は再送しない。本文・画像・自由入力の状態を残したまま、新しい preview を取り直して聞き直す（`reason:'claimed'` のときは「別の送信が引き継ぎを渡しています」を添える）。**`auto` の応答には brief の報告が無いことがある**（`send/route.ts:94`：付いた・旗があった・不明のときだけ）ので、報告が無いときは何も出さない（「別の送信で渡された」と断定しない）
- D2 の差し込みとの照合：D2 は D1 の口（`BriefRequest`）に `target.worktreeIncarnation`・`instanceOnRoster` と `BriefResult.skipReason?` を足し、`brief: 'auto'/'force'` で `briefPin` を必須にする（D2 §0.1・§2.4）。G が `BriefRequest` に足すのは S-F の `detail` だけ（他の選択は **route の本文の欄**）。D2 の先頭の行（§7.1「終わる前の更新を確認できない」）は「必須の項目」で、短い要約でも全文でも入る（D2 §7.4）。`decline` では brief が付かないので先頭の行も届かない — ダイアログに「読まないと、前回の終わり方の注意も届きません」を出す［見立て］

#### 3.2.1 画面の側の契約（S-B と同じ PR）

| 箇所 | 変えること |
|---|---|
| `worktreeApi.sendMessage`（`api-client.ts:677`） | options に `brief?: 'skip'\|'force'\|'decline'`・`briefDetail?`・`briefBoundary?` を足し、あるときだけ body に入れる（無ければ今と同じ body のバイト列）。戻り値の型を `ChatMessage & { brief?: SendBriefReport }` にし、応答の `brief` を捨てない |
| 楽観送信（`onOptimisticSend`・`usePendingMessages.ts`） | 保留の 1 件に選択（3 つの欄）を持たせ、再送は **同じ選択** で送る（再送で選び直さない・`auto` に戻さない）。`boundary_changed` の 409 は再送せず、保留の 1 件を「選び直しが要る」の状態にして本文・画像を持ったまま残し、ダイアログを開き直す。選ばれたらその 1 件を新しい選択と新しい `briefBoundary` で送る。ダイアログを閉じたら、入力欄が空ならその本文・画像を入力欄へ戻し、空でなければ保留の 1 件を「送れていません」の印つきで残す（どちらでも本文を捨てない） |
| `MessageInput.tsx`（`:420-428`） | ダイアログは **下書きを消す前** に開く。選択が決まってから `onOptimisticSend` を呼び、そこで今どおり下書きを消す。閉じたら本文・画像・自由入力の状態は残る |
| 他の画面の送信の経路（`ChatSurface.tsx`・`MobileTerminalTab.tsx`・`SessionTile.tsx`・分割の各ペイン） | 共通の送信の関数の 1 か所に G-3 を挟む。共通の 1 か所が無ければ全部に置き、表駆動の試験で全経路を固定する（§7.4 H19） |
| 終了の依頼の文（§4.2） | `sendMessage(…, { brief:'skip' })` で直接送る（楽観送信・ダイアログを通さない）。brief が付かないことを応答の報告で確かめる |

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
           起動／終了の排他（§4.6）の中で、今の境界（会話の寿命の鍵、§0.1 G6）・在籍の寿命・
           所属（repository・branch）・実プロセスの世代を一緒に固定。境界かプロセスが無ければ 409 session_unknown → 今どおりの確認の Modal
      ② 画面が依頼の文を既存の送信の route で送る（brief:'skip'）
           失敗 → request_failed（§4.4）
      ③ Agent が提案を出す（commandmate handoff propose …）→ 終わったら handoff done
           期限（5 分）までに done が無い → agent_timeout（§4.4）
      ④ 画面が提案を差分で見せる（提案ごとに 承認／捨てる）
           ＋「提案を経ずに確定した更新」（G2）を別の欄に出す（読むだけ）
      ⑤ 「確定して終了」：承認した提案だけを、版を照合して 1 件ずつ確定
           版の食い違い → conflict（§4.5）。失敗 → failed
      ⑥ end（G の route がサーバで寿命を照合 → kill → 止まったことを確かめる → ended）
  どの段でも：「終了をやめる」（取り消し）・「今すぐ終了」（強制終了 = end の force）
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

### 4.3 提案の置き場（v71、`src/lib/db/migrations/v71-mem-handoff.ts`）

```sql
CREATE TABLE mem_handoff_requests (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL, branch TEXT,           -- 作った時点の所属（A の withMemTarget の storageRepositoryId・branch）
  detached INTEGER NOT NULL,                          -- 同上。この 3 つが S-A の pin.membership（§4.5、再確認 P1-3）
  target_worktree_id TEXT NOT NULL,                   -- worktree_id と名付けない（A §10.3）
  target_worktree_incarnation TEXT NOT NULL,          -- 作った時点で固定
  instance_id TEXT NOT NULL, cli_tool_id TEXT NOT NULL,
  instance_incarnation TEXT,                          -- 作った時点で固定（NULL = 世代なし）
  instance_on_roster INTEGER NOT NULL,                -- 作った時点の在籍（isSameInstanceLifetime の earlier）
  boundary_id TEXT NOT NULL,                          -- 会話の寿命の鍵：作った時点の D1 の境界の id（§0.1 G6）。FK なし
  process_identity TEXT NOT NULL,                     -- 実プロセスの世代：作った時点の Agent のプロセスの世代（§4.6 の readProcessIdentity。第 4 版で pane_pid から Agent の前面のプロセスの pid と開始時刻に）
  state TEXT NOT NULL CHECK (state IN
    ('awaiting_agent','reviewing','applying','ending','ended','cancelled','expired')),
  apply_token TEXT,                                   -- applying の間だけ：その decide の印（§4.5）
  end_token TEXT,                                     -- ending の間だけ（§4.6）
  end_forced INTEGER NOT NULL DEFAULT 0 CHECK (end_forced IN (0, 1)),   -- 一度 1 にしたら同じ依頼では 0 に戻さない（§4.6、再確認 P1-2）
  outcome TEXT CHECK (outcome IN ('confirmed','unconfirmed')),
  outcome_reason TEXT,   -- forced・request_failed・agent_timeout・apply_failed・conflict_left・kill_failed・session_changed・expired
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
  kind TEXT NOT NULL,                                 -- 作った時点の項目の kind（add は payload の kind）
  base_version INTEGER,                               -- add は NULL。改版（rebase）で変わる
  revision INTEGER NOT NULL DEFAULT 1,                -- 改版の番号（§4.5.1）
  payload TEXT NOT NULL,                              -- JSON：kind・text・closeWhen・evidence・reason（A の検査を通った値）
  fingerprint TEXT NOT NULL,                          -- 正規化した {request_id, id, revision, op, item_id, kind, base_version, payload} の SHA-256
  author_instance_id TEXT NOT NULL, author_incarnation TEXT,   -- 作者（D5）
  state TEXT NOT NULL CHECK (state IN
    ('proposed','approved','applied','conflict','discarded','failed','expired')),
  state_reason TEXT,                                  -- version_conflict・state_forbids・disabled・incarnation_changed・session_changed・db_error・cancelled・forced
  apply_token TEXT,                                   -- approved の間だけ：承認した decide の印
  applied_item_id TEXT, applied_version INTEGER,
  checked_rules_version INTEGER NOT NULL,             -- A §6.4 と同じ：出口で読み直す
  created_at INTEGER NOT NULL, decided_at INTEGER, updated_at INTEGER NOT NULL
);
-- 提案の「何に対する何の操作か」は作った後に変えない（指紋の前提）。改版で変わるのは base_version・revision・fingerprint・state だけ
CREATE TRIGGER mem_handoff_proposals_immutable BEFORE UPDATE OF request_id, op, item_id, kind, payload, author_instance_id, author_incarnation
  ON mem_handoff_proposals BEGIN SELECT RAISE(ABORT, 'mem_handoff_proposals: immutable column'); END;
-- 依頼の固定した所属・寿命・プロセスの世代は変えない。end_forced は 1 → 0 にしない（再確認 P1-2）
CREATE TRIGGER mem_handoff_requests_pinned BEFORE UPDATE OF repository_id, branch, detached, target_worktree_id,
    target_worktree_incarnation, instance_id, instance_incarnation, instance_on_roster, boundary_id, process_identity
  ON mem_handoff_requests BEGIN SELECT RAISE(ABORT, 'mem_handoff_requests: pinned column'); END;
CREATE TRIGGER mem_handoff_requests_forced_sticky BEFORE UPDATE OF end_forced ON mem_handoff_requests
  WHEN OLD.end_forced = 1 AND NEW.end_forced = 0
  BEGIN SELECT RAISE(ABORT, 'mem_handoff_requests: end_forced is sticky'); END;
```

- **形**：提案は「項目への 1 操作」（追加・版つきの更新・close）で、全体の書き戻しにしない（D6）。decision の `record`・`promote` の操作は **無い**（D9。promote は E の画面だけ）。decision の提案は `add`（`open`）と `close`（`open` の取り下げ）だけ
- **作者**：提案の口（Agent の CLI）は A の Agent の口と同じく `instanceId` と世代で作者を決め、依頼の `instance_id`・`instance_incarnation` と違えば 409 `not_requested`（他の instance が他人の依頼に提案を足さない）
- **会話の寿命**：提案・`done`・`decide`・`end` は、どれも書き込みの同期の区間で `getCurrentBoundary(…).id === boundary_id` と `isSameInstanceLifetime(依頼の値, readInstanceLifetime(…), cli_tool_id)` を確かめ、違えば 409 `session_changed`（依頼は `expired(session_changed)`、未決の提案は `expired`）。読み（`GET`）も同じ判定で状態を進める（読みは印が要らないが、旧依頼・旧提案を `expired` にすることはある。`mem_items` と新しい世代の依頼は変えない。§7.4 の入口の表）
- **所属**：依頼の `repository_id`・`branch`・`detached` は作成の区間で `withMemTarget` の結果から固定し、以後変えない（トリガー）。確定（§4.5）は S-A に `pin.membership` として渡し、S-A の最終の区間の target と照合する（違えば 409 `membership_changed`、その提案は `failed(membership_changed)`）
- **強制の後**：`end_forced=1` になった依頼は、以後 `propose`・`done`・`decide`・`rebase`・`extend` を 409 `request_closed` で断る（未決の提案は既に `discarded(forced)`）。受けるのは `end`（再試行）・`cancel`・読みだけ
- **範囲**：提案は `now` を扱わない（`add` の `kind:'now'`・`now` の枠の項目への `update`・`close` は 400）。decision の `close` は `open` の取り下げだけ（`recorded` の項目への `close` の提案は 409 `state_forbids`）
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
| `POST …/handoff/requests/:rid/decide` | 画面 | 要る | `{ ifVersion, decisions: [{ proposalId, fingerprint, action:'approve'\|'discard' }] }` → 承認したものを確定（§4.5）。結果は提案ごと。同じ `ifVersion` の 2 回目（並行・応答の消失の後の再送）は 409 `version_conflict` と今の依頼・提案の状態（確定済みは `applied`）を返す |
| `POST …/handoff/requests/:rid/proposals/:pid/rebase` | 画面 | 要る | `{ ifVersion, fingerprint }`（`conflict` の提案の、人が見た指紋）→ 改版（§4.5.1）。新しい `revision`・`base_version`・`fingerprint` を返す。確定はしない |
| `POST …/handoff/requests/:rid/cancel` | 画面 | 要る | 取り消し（§4.4） |
| `POST …/handoff/requests/:rid/end` | 画面 | 要る | `{ ifVersion, force?: true }` → **サーバが** 寿命を照合して kill し、止まったことを確かめて記録する（§4.6）。画面は `killed` を申告しない |

- CLI：`commandmate handoff propose …` と `commandmate handoff done`（新規 `src/cli/commands/handoff.ts`、`program.ts` に登録）。**承認・取り消し・終了の口は CLI に作らない**（§7.3）。exit code は A の `MemExitCode` を使う（50 disabled・51 conflict・52 not found・55 not_owner）。新しい語 `not_requested`・`request_closed` は 52 / 55 に寄せる［見立て］

### 4.4 取り消し・未応答・失敗・強制終了・タイムアウト

| 場合 | 起きること | 依頼 | 提案 | 次の世代へ（§4.6） |
|---|---|---|---|---|
| 依頼の文の送信が失敗（②） | 画面が `send-failed` を送り、「依頼を送れませんでした」と出す。選択：再送／提案なしで終了／終了をやめる | `awaiting_agent` のまま（再送）か下の行へ | — | 提案なしで終了なら `unconfirmed(request_failed)` |
| Agent が応答しない（期限まで `done` が無い） | 読むときに `agent_timeout` を出す。選択：待つ（+5 分、2 回まで）／ここまでの提案で進む（`reviewing` へ）／提案なしで終了／終了をやめる | 選択どおり | 期限の後に来た提案は 409 `request_closed`（`reviewing` 以降は受けない） | 提案なしで終了なら `unconfirmed(agent_timeout)`。「ここまでの提案で進む」は done が無いので、確定が全部通っても `unconfirmed(agent_timeout)` |
| 人が取り消す（「終了をやめる」） | 未決の提案をすべて `discarded(cancelled)`。**確定済みの提案（`applied`）と、他のセッション・Agent の直接の更新は巻き戻さない**。セッションは続く | `cancelled` | `discarded` | 終わっていないので記録しない（後で別の経路で終われば「記録なし」） |
| 確定の 1 件が失敗（DB・mode が `on` でなくなった・作り直し） | その提案は `failed(<理由>)`。他の提案は続ける。画面に一覧で出し、選択：残りで終了／終了をやめる | `applying` → `reviewing` | `failed` | `unconfirmed(apply_failed)` |
| 版の食い違い（§4.5） | `conflict`。人が今の値と並べて見直し、「今の版に載せ替える」（`rebase` で改版 → 新しい版との差分を再表示 → 新しい指紋で再承認、§4.5.1）か「捨てる」 | `reviewing` | `conflict` | 未決のまま終了すれば `unconfirmed(conflict_left)` |
| 強制終了（「今すぐ終了」、どの段でも） | `end` の `force:true`。未決の提案を `discarded(forced)`、kill。確定済みは巻き戻さない。`applying` の最中なら、`apply_token` を外すので残りの確定は最終の区間の `fence` で止まる（§4.5） | `ending` → `ended` | `discarded` | **必ず** `unconfirmed(forced)`（`done` 済み・提案 0・確定が全部通っていても。G5 の優先の規則） |
| kill が失敗（サーバが確かめて、同じ実プロセスがまだ動いている） | 「終了できませんでした」と出す。依頼は `ended` にしない（`reviewing` に戻す）。**一度立った `end_forced` は同じ依頼では消さない**：強制の後の再試行は `force` の有無にかかわらず forced のまま（`force` なしで再試行して成功しても `unconfirmed(forced)`）。forced の依頼は以後 `propose`・`decide` などを受けない（§4.3） | `ending` → `reviewing` | そのまま（強制なら既に `discarded(forced)`） | 終わっていない |
| kill の待ちの間に CommandMate の経路で再起動しようとした（送信の起動・自動の再起動） | 起動は起動／終了の排他（§4.6）で kill の終わりまで待つ。kill → 止まったことを確かめる → 記録 → 排他を外す → 起動、の順になる | `ended` | — | 4 条件どおり（新しいプロセスの境界は記録の後に開く） |
| 排他を通らない入れ替え（別の CommandMate サーバ・tmux の直接の操作。**同じ pane・同じ shell のまま Agent だけが交代した場合を含む**）を kill の直前に見つけた | kill の直前の実プロセスの世代の照合で、依頼の `process_identity` と違う → **kill しない**（新しいプロセスは生き残る） | `expired(session_changed)` | 未決は `expired` | 記録なし（確認できない） |
| kill の直前に世代を読めない（`ps`・tmux の読みの失敗・前面のプロセスが決まらない） | **kill しない**（fail-closed）。409 `identity_unknown`、「終了できませんでした（今のプロセスを確かめられません）」 | `ending` → `reviewing`（`end_forced` はそのまま） | そのまま | 終わっていない |
| kill の後に、排他を通らない入れ替えで別のプロセスが動いている | 止まったことの確認で、動いているプロセスの世代が依頼と違う → 古いプロセスは止めた。新しいプロセスは kill し直さない | `ended` | 未決は `expired` | `unconfirmed(session_changed)` |
| 在籍を変えずに kill→再起動（画面の外、CLI 等） | 次の読み・書きで境界が違う → 依頼は `expired(session_changed)`。古い依頼からの `propose`・`done`・`decide`・`end` はすべて 409 `session_changed`（新しいプロセスを古い依頼で kill しない） | `expired` | `expired` | 記録なし |
| 画面を閉じた・電源が切れた（依頼の途中） | 何も進まない（サーバは待たない）。依頼は `expires_at`（60 分）の後の読みで `expired`、未決の提案は `expired`。**セッションは殺さない**（無人で kill しない） | `expired` | `expired` | 終わっていない。後で別の経路で終われば「記録なし」 |
| 依頼の途中で、画面の外から kill（CLI・別の画面・異常終了） | 次の読みで、境界が違う・instance の寿命が違う・roster に無い → 依頼を `expired(session_changed)` | `expired` | `expired` | 記録なし（確認できない） |
| 画面の再読込・WebSocket の再接続 | 境界も在籍も変わらないので依頼はそのまま。開き直した画面は `GET …/requests/:rid` で続きから出す | そのまま | そのまま | — |

- 期限の値（Agent 5 分・全体 60 分・延長 2 回）は［見立て］。Agent の 1 ターンが 5 分を超えることは珍しくないので、UAT で見直す（§9 U1）

### 4.5 承認と確定の手順（`decide`）

確定は「最初の確認」と「書き込み」の間に await（S-A の `askConditionGit` など）を挟む。その間の取り消し・同じ `decide` の並行・強制終了を防ぐため、**各提案の最終の transaction で依頼と提案を確かめ直し、項目の変更と `applied` の記録を同じ transaction で確定する**。

1. **始め（同期の 1 transaction）**：印・mode `on`・依頼の `version === ifVersion`・依頼の `state==='reviewing'`・期限（`expires_at`、読みの時点の `now`）・会話の寿命（§4.3 の「会話の寿命」）を確かめる。違えば 409、何も書かない。通れば依頼を `applying`・`apply_token=<新しい乱数>`・`version+1` にし、`discard` の提案を `discarded`、`approve` の提案のうち `fingerprint` が今の行と一致するものを `approved`・`apply_token` を同じ値にする（一致しないものは 409 `proposal_changed` として結果に返し、状態を変えない）。**同じ `ifVersion` の並行の `decide` は、ここで片方だけが通る**
2. `approved` の提案を 1 件ずつ、S-A の `memWriteFromScreen` に渡す（`update`・`close`：`author:'human'`、`ifVersion = base_version`、`pin` は `add` と同じ値（既存の項目の所属の照合 (i) に加えて、依頼の所属とも照合する）。`add`：`author:'proposer'`、`pin = { worktreeIncarnation: 依頼の値, instanceLifetime: 依頼の値, membership: { repositoryId, branch, detached }: 依頼の値 }`、`key = 'handoff:' + proposalId + ':' + revision`（A §5.4 の冪等の鍵。同じ提案から 2 件にしない））。`fence` には次を確かめる同期の関数を渡す（S-A の最終の transaction の中、項目の書き込みの直前に呼ばれる）：
   - 依頼の `state==='applying'` かつ `apply_token` がこの `decide` の値（取り消し・強制終了・別の `decide` で外れていれば偽）
   - 提案の `state==='approved'`・`apply_token` が同じ・`revision` と `fingerprint` が始めの値と同じ
   - 期限：`expires_at > now`（`now` はこの区間で読む 1 つの値。S-A の書き込みの `now` と同じ値を使う）
   - 会話の寿命（境界の `id` と在籍の寿命）が依頼と同じ
   `fence` が真なら、**同じ transaction の中で** 項目を書き、提案を `applied`（`applied_item_id`・`applied_version`・`decided_at`）にする。偽なら何も書かず、提案は `discarded(cancelled)`・`discarded(forced)`・`expired`・`expired(session_changed)` のどれか（外れた理由による）
   - S-A の結果が版の競合（`version_conflict`）・`state_forbids` なら `conflict`、`membership_changed`（await 中に HEAD が別のブランチへ変わった）は `failed(membership_changed)`、その他の失敗は `failed`
3. 提案ごとに別の transaction（全体を 1 つにしない：他の提案の失敗で成功した確定を戻さない＝「確定済みは巻き戻さない」と同じ向き）
4. **終わり（同期の 1 transaction）**：依頼が `applying` かつ `apply_token` が同じなら `reviewing` に戻し、`apply_token=NULL`・`version+1`。外れていれば（取り消し・強制終了）触らない
5. **応答の消失**：項目の保存の後に応答が失われても、提案は既に `applied` で、同じ `decide` の再送は 1 の `version` の照合で 409 になり、今の状態（`applied`）を返す。`add` の再送は `key` でも 2 件にならない

- `cancel` は依頼を `cancelled`・`apply_token=NULL` にし、`approved`・`proposed`・`conflict` の提案を `discarded(cancelled)` にする（同期の 1 transaction）。`applying` の最中でも受ける（確定済みの `applied` は残る、巻き戻さない）
- 承認は **画面の要求の中でだけ** 起きる。auto-yes・F の促し・brief・Schedule・dreaming から `decide`・`rebase` を呼ぶ口は無い（§5.3・§7.3）

#### 4.5.1 競合の後の改版→再表示→再承認

`conflict` の提案は、そのままでは承認できない（指紋が `base_version` を含み、今の項目の版と合わない）。次の 3 つの状態遷移を分ける：

| 段 | 要求 | 起きること |
|---|---|---|
| 改版 | `POST …/proposals/:pid/rebase` `{ ifVersion, fingerprint }`（人が見た `conflict` の提案の指紋） | 同期の 1 transaction：依頼が `reviewing`・`version` 一致・会話の寿命が同じ・提案が `conflict` で指紋が一致 → `base_version = 今の項目の version`・`revision+1`・指紋を計算し直し・`state='proposed'`・依頼の `version+1`。`payload`・`op`・`item_id` などはトリガーで変えられない（§4.3）。項目が `closed` などで遷移が無ければ改版せず 409 `state_forbids`（人は「捨てる」だけ） |
| 再表示 | `GET …/requests/:rid` | 改版した提案を、新しい `base_version` の項目の値との差分で出す（人が見るのは改版の後の差分） |
| 再承認 | `decide` に新しい `fingerprint` で `approve` | §4.5 の手順そのまま。古い指紋の `approve` は 409 `proposal_changed` |

- 指紋は `{request_id, id, revision, op, item_id, kind, base_version, payload}` を正規化した JSON の SHA-256（§4.3）。`op`・`item_id`・`kind`・`payload` の不変は v71 のトリガーで保証し、ガードの試験（H18）で「トリガーがある・更新が ABORT になる」を固定する

### 4.6 終了（`end`）と「終わる前の更新を確認できない」を次の世代へ

**kill はサーバが照合してから行い、画面の `killed:true` の申告で成功を認めない。** kill の本体（今は `kill-session/route.ts:123-160` に直書き）を共有の関数 `src/lib/session/kill-instance-session.ts` の `killInstanceSession(worktreeId, { cliToolId, instanceId })` へ移す（既存の kill-session の route はそれを呼ぶだけになり、応答・副作用（auto-yes の解除・starting の記録の消去など）は変えない）。

**照合と kill を別の区間にしない（第 3 版、再確認 P1-1）。** 既存の kill は `checkSessionOwnership`・`isRunning` を await してから `killSession` を呼ぶ［事実：`kill-session/route.ts:129-152`］。照合を route の始めだけで行うと、その await の間に旧プロセスが終わって同じ名前で再起動したとき、新しいプロセスを kill してから境界の変化に気づく（後から `unconfirmed` にしても終了は戻せない）。そこで次の 2 つを kill の側まで通す：

- **起動／終了の排他** `withInstanceLifecycleLock(sessionName, fn)`（新規 `src/lib/session/instance-lifecycle-lock.ts`。`instance-input-lock.ts` と同じく tmux のセッション名ごと・`globalThis` に置く・FIFO・待ちの上限つき。入力の排他とは別の錠で、入れ子の順は「lifecycle → input」に固定する）。取るのは **kill の全経路**（`killInstanceSession` の中）と **起動の全経路**（`startSession` を呼ぶ所：`send-session-start.ts:98-105`・`cli-tools/base.ts:800` の再起動・assistant の start など。全数は実装の契約で `git grep -n '\.startSession(' -- src` で数え、ガードで固定する）と、依頼の作成（§4.1 ①）。待ちの上限を超えたら何もせずに 409 `lifecycle_busy`（kill しない・起動しない）
- **kill の全経路は tmux の終了の処理の側から逆引きして数える**（第 4 版、3 回目 P2）。`cliTool.killSession(` の呼び出しだけでは足りない（tmux の `killSession`（`src/lib/tmux/tmux.ts:951`）を直接呼ぶ所が `cliTool.killSession` の外にある［事実］）。2026-11-09 の分類（全数は実装の契約で取り直し、§7.3 のガードで固定）：

  | tmux の `killSession` に届く所 | 扱い |
  |---|---|
  | 各 driver の `killSession`（`base.ts:983` の共通の stop・`opencode.ts`・`opencode-v2.ts` の stop など） | `cliTool.killSession` の中身。呼ぶのは `killInstanceSession`（排他を取る）と、起動の中の `settleLaunchRole` の `kill`（`base.ts:417`、起動の排他に再入）だけにする |
  | `claude-session.ts:712` の `ensureHealthySession`（起動の中の不健全な session の kill） | 起動の中（`startClaudeSession`）からだけ呼ばれる → 起動の排他に再入。起動の外から呼ぶ所ができたらガードで落とす |
  | `session-key-sender.ts:166`（Claude の stop） | `stopClaudeSession`（`claude.ts:141` の `killSession`）の中身 → 上の driver と同じ |
  | `session-cleanup.ts:274` の `killWorktreeSession`（worktree の削除） | **排他へ通す**（`withInstanceLifecycleLock(sessionName, …)` で包む。中身は変えない）。worktree の削除の間に起動・`end` が走りうるので除外しない |
  | `session-cleanup.ts:314` の `cleanupGlobalSessions` | **除外**：`GLOBAL_SESSION_WORKTREE_ID` の session は roster の instance ではなく、依頼を作れない（依頼の作成は roster と D1 の境界を要する）。保証の範囲は「依頼のある instance の session」で、この除外はその外 |
  | transport の `killSession`（`polling-tmux-transport.ts:67`・`control-mode-tmux-transport.ts:102`） | 今は呼ぶ所が無い［事実：`git grep` で 0 件］。呼ぶ所ができたらガードで落とす（表に足すまで） |

  保証の範囲：依頼のある instance の session を kill する CommandMate のサーバの中の経路は、すべて `withInstanceLifecycleLock` の中で kill する。範囲の外（防げない）：別のサーバ・人の `tmux kill-session`・`cleanupGlobalSessions`。これらは kill の直前の世代の照合と止まったことの確認（§4.6 の 3）で「確認できない」側に倒す
- **排他の順序と再入の契約**（第 4 版、3 回目 P2）。既存の送信は入力の排他を持ってから、終わった Agent の自動の再起動で `startSession` に入る［事実：`send-user-message.ts:702-713` の `withInstanceInputLock` の中の配送 → `base.ts:800`］ので、「lifecycle → input」の順と逆向きの入れ子が既にある。そこで次のとおり定める：
  1. **順序**：外から新しく取るときは lifecycle → input。起動の中の打鍵（`launch-keys.ts:40` の `withInstanceInputLock`）は lifecycle を持ったまま input を待ってよい
  2. **input を持った文脈から lifecycle を取るときは待たない**（送信の中の自動の再起動）：その文脈で lifecycle が空いていれば取り、空いていなければ **待たずに** `InstanceLifecycleBusyError` を投げる（起動しない・キーを送らない）。送信は `not_sent` で失敗し（D1 の予約は `pending` に戻る）、画面は下書きを残す。input の持ち主が lifecycle を待つことが無いので、lifecycle の持ち主（`end`・外の起動）が input を待っても循環しない
  3. **同じ所有者の再入**：`instance-input-lock.ts` と同じく `AsyncLocalStorage` で持ち主を持ち、持ち主の文脈からの再取得は合流する（2 回取らない）。合流するのは `end` の route → `killInstanceSession`、起動の共通の関数 → `startSession` → `settleLaunchRole` の `kill`・`ensureHealthySession`・Codex の `relaunchIntoSamePane`
  4. **旧 ticket の失効の後**：Agent の交代（`beginAgentSession` → `invalidateInstanceInput`）で input の ticket を失った文脈（古い送信）は、lifecycle を新しく取らない（`InstanceInputOwnershipLostError` と同じく断る）。古い送信が新しい Agent を再起動・kill しない。lifecycle の錠自体は Agent の交代で失効させない（kill・起動の持ち主は交代の当事者なので）
  5. 待ちの上限：lifecycle の外からの待ちは上限つき（U14）で、超えたら 409 `lifecycle_busy`。2 の「待たない」は上限 0 と同じ扱い
- **実プロセスの世代** `readProcessIdentity(worktreeId, cliToolId, instanceId)` → `'<session_created>:<pane_pid>:<agent_pid>@<agent_started>'` か `null`（第 4 版、3 回目 P1）。`pane_pid` は pane の最初のプロセス（shell）で、**同じ pane の中の Agent の再起動を見分けない**［事実：tmux の `pane_pid` の定義。Codex は shell と pane を残して Agent を起動し直す（`codex.ts` の relaunch・`relaunchIntoSamePane`）］ので、世代は **Agent のプロセス** で取る：tmux の `display-message -p '#{session_created} #{pane_pid}'` → `ps -o tpgid= -p <pane_pid>`（その端末の前面のプロセスグループ＝今動いている Agent）→ `ps -o lstart= -p <tpgid>`（開始時刻。`src/cli/utils/process-inspector.ts` の `getProcessStartTime` と同じ読み方で、サーバの側に置く）。Agent が起動し直せば pid と開始時刻が必ず変わり、Agent が終わって shell が前面に戻っても `tpgid` が変わる。**どれかが読めない・`tpgid` が 0 以下・`lstart` が空なら `null`（不明）**。この値は OS から読むので、D1 の境界の記録の成否に依らない（`openLaunchBoundary` は記録の失敗で起動を止めない［事実：`session-boundary.ts:153` の catch → warn］が、その経路でも Agent の pid・開始時刻は変わる）。依頼の作成で `process_identity` に固定する（排他の中で、境界・在籍の寿命と同じ時点。`null` なら 409 `session_unknown` で依頼を作らない）。`killInstanceSession` に `expect?: { processIdentity }` を足し、**`cliTool.killSession` を呼ぶ直前に**（所有の確認・`isRunning` の await の後、間に他の await を挟まずに）もう一度読んで比べる。違えば kill せず `{ result:'identity_changed' }` を返す。**読めなければ（`null`）kill せず `{ result:'identity_unknown' }`**（fail-closed。不明を「同じ」と読まない）。`expect` を渡さない呼び出し（既存の kill-session の route・設定の画面の再起動・roles の画面）は今どおり世代を見ない（§10）

G の `end` の route は、全体を `withInstanceLifecycleLock` の中で行う：

1. **始め（同期の 1 transaction）**：印・依頼の `version === ifVersion`・依頼が `awaiting_agent`／`reviewing`／`applying`（`applying` は `force` のときだけ）・会話の寿命（境界の `id`・在籍の寿命）が同じ。違えば 409 `session_changed` などで kill しない（**古い依頼から新しいプロセスを kill しない**）。通れば `state='ending'`・`end_token`・**`end_forced = MAX(end_forced, force ? 1 : 0)`**（一度立った forced は同じ依頼では消さない。トリガーでも 1 → 0 を拒む）・`apply_token=NULL`（進行中の `decide` を最終の区間で止める）・未決の提案を `discarded(forced)`（今回 `force` のとき）・`version+1`
2. kill：`killInstanceSession(worktreeId, { cliToolId, instanceId, expect: { processIdentity: 依頼の値 } })`。中の await（所有の確認・`isRunning`）の間も排他を持ったままなので、CommandMate の経路の起動は割り込めない。排他を通らない入れ替えは直前の世代の照合で `identity_changed` になり、kill しない
3. 止まったことの確認：`isRunning` が偽なら止まった。真なら `readProcessIdentity` を読み、依頼と同じ世代なら `kill_failed`、違う世代なら「古いプロセスは止まり、別のプロセスが動いている」（`session_changed`。kill し直さない）。読めなければ `kill_failed` と同じに扱う（止まったと言わない）
4. **終わり（同期の 1 transaction）**：依頼が `ending` かつ `end_token` が同じ。`identity_changed`（kill しなかった）→ `expired(session_changed)`。`identity_unknown`（kill しなかった）→ `reviewing` に戻して 409 `identity_unknown`（`end_forced` はそのまま）。`kill_failed` → `reviewing` に戻す（`end_forced` はそのまま）。止まっていれば `ended`・`ended_at`、`outcome` を次の **優先の順** で決める：
   1. `end_forced=1` → `unconfirmed(forced)`（**4 条件より優先**。`done` 済み・提案 0 でも。前の `end` で立った forced も含む）
   2. 境界の `id` が依頼と違う・3 で別の世代が動いている → `unconfirmed(session_changed)`
   3. §0.1 G5 の 4 条件（`agent_done_at` がある・未決の提案が無い・`failed`/`conflict` が無い・kill を確かめた）が全部 → `confirmed`
   4. それ以外 → `unconfirmed(<最初に欠けた条件の語>)`（`agent_timeout`・`conflict_left`・`apply_failed` など）
5. 排他を外す（待っていた起動はここから進み、新しい境界は記録の後に開く）
6. 応答の消失：同じ `end` の再送は 1 の `version` の照合で 409 になり、今の状態（`ended` と `outcome`）を返す。kill を 2 回しない

- 防げないこと［見立て］：排他はサーバのプロセスごと（`instance-input-lock.ts` の先頭のコメントと同じ限界）。2 つの CommandMate サーバが 1 つの tmux を共有する・人が tmux を直接操作する入れ替えは排他を通らない。それは kill の直前の世代の照合で狭めるが、照合の読み（tmux と `ps` の読み）と `killSession` の中の tmux の操作の間は残る。記録は「確認できない」側に倒す。Agent が前面に別のプロセス（エディタなど）を出している間は `tpgid` が Agent でないので、依頼の作成と kill の直前の読みが食い違えば kill しない（安全側。U13）

- 「今すぐ終了」（強制）も同じ `end` の route（`force:true`）。kill-session の route を画面から直接呼ばない（`popup=1`・mode `on` のとき）
- 読み口（S-C）：`readPreEndUpdate(db, { worktreeId, instanceId, before })` は、その (worktree, instance) の `ended` の依頼のうち `ended_at < before` で最も新しいものが、**その直前の境界より後**（同じ世代の終わり）に `confirmed` なら `'recorded'`、それ以外（無い・`unconfirmed`・前の世代のもの）は `'not_recorded'`。D2 §7.2 の X1〜X3 はそのまま D2 が判定する
- サーバが kill の後の 3 に届く前に落ちたら、依頼は `ending` のまま `expires_at` の後の読みで `expired`＝`not_recorded`（確認できない側）
- 文言は D2 の固定の 1 行のまま（「確認できない」）。G は理由の語を brief に出さず、上限の値を持たない（D2 の先頭の行の上限は D2 の実装中の設計で **128 バイト**（第 2 版の 96 から実装で直した。`../commandmate-issue-4224` の作業中の設計書 §7.1、2026-11-09 に読んだ）。G-PR3 の接続の試験は D2 の export した定数を import して使い、数値を写さない）。理由は G-1 の「終了の記録」で人が読む

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
- ガード（§7.3）：`src/lib/polling/**`・`src/lib/auto-yes*`・`src/app/api/worktrees/[id]/prompt-response/**`・`respond`・`special-keys` の import の閉包に G の承認・改版・終了の service（`src/lib/handoff/decide.ts`・`rebase` の関数・`end` の関数）が無い。通常の `prompt-response` の経路も同じ（auto-yes でない人の端末の答えも承認ではない、§7.4 H7）
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

## 6. S2・S3 の決定（PM の決定済み：S2 は S-D、S3 は下の案）

| # | 決定 | 理由 |
|---|---|---|
| **S2** | **人が画面で `recorded` の decision を閉じる遷移を足す（S-D）。** 遷移 `'withdraw-recorded'`（`recorded` → `closed`、`close_reason='withdrawn'`）と、版の照合と close を 1 つの transaction に置く store の関数 `closeMemItemVersioned`（§0.0b S-D）。入口は G の画面の close（S-A の `memWriteFromScreen`、`author:'human'`、印・mode `on`・`ifVersion`・`confirmUnreflected:true`）だけ。画面は「この決定は記録済みですが、正本（Issue の本文など）へ反映しないことにして閉じます。コメントなどの記録は消えません」の確認を 2 段で出し、`confirmUnreflected:true` を送る。CLI の `mem close` と Agent の提案は今どおり断る（55 `state_forbids`。提案の `close` は `open` の decision だけ） | 出口が無いと、反映しないと決めた decision が `recorded` のまま残り、古さの警告（14 日）が出続ける。purge も既定で除く。`promoted` を経て閉じる（「反映した」と偽る）しか手が無くなる。`withdrawn` は既にある理由の語（A §10.1 の `CHECK`）で、DB の形を変えない。外への記録（コメント・文書）は E の operation に残り、G は消さない |
| **S3** | **CLI の一覧と brief には文言を足さない（今の構造化の欄のまま）。** 画面（G-1 と E の画面）にだけ「未反映：記録しただけで、正本へはまだ反映されていません」を出す | 両方とも既に `recorded` を区別して出し（CLI：`v<version> recorded {…,unreflected}`、`mem.ts:169-177`。brief：`state=recorded unreflected=true`、`render.ts:78-89`・`sources.ts:470-480`、順位 4）、Agent はその欄を読める。brief は D12 で「データとして区切る」もので、警告の文を足すと命令として読まれうる・予算を使う（C §2）。人が判断する場所は画面で、警告はそこに出せば足りる。A・C のファイルを変えずに済む |

---

## 7. 実装の範囲と試験

### 7.1 PR の切り方

| PR | 中身 | 待つもの |
|---|---|---|
| G-PR1 | S-A（`memWriteFromScreen` と `ENTRANCES` の 5 行）・S-D（遷移 1 つと `closeMemItemVersioned`）・人の項目の API（§2.3）・G-1 の画面（一覧・追加・編集・close・競合・未配送の知らせ）・S-E の mode の画面・ja/en の文書 | E のマージ（G-1 から E のページへ移る・decision の表示。マージの順 E → F → G） |
| G-PR2 | v71（E = v69・F = v70 の後）・`src/lib/handoff/**`（依頼・提案・decide・rebase・期限・会話の寿命）・kill の本体の共有の関数への移動・CLI `handoff`・G-4 の画面・ガード | G-PR1 |
| G-PR3 | G-3（開くときの preview と選択、§3.1.1 の分類）・S-B の欄と画面の側の契約（§3.2.1）・S-C の読み口の接続（`pre-end.ts` と `sources.ts` の 1 行）・S-F の C の `itemCap` と provider の `detail`（PM の決定 (a)） | **D2 の develop へのマージ**（S-B・S-C・S-F は D2 のマージを前提に、この PR で足す。D2 の契約は変えない） |

### 7.2 新規ファイル（A〜D1 の外）

| ファイル | 中身 |
|---|---|
| `src/lib/db/migrations/v71-mem-handoff.ts`・`runner.ts` の登録 | §4.3 |
| `src/lib/db/handoff-db.ts` | 依頼・提案の CRUD（`mem_items` は書かない）。名前は A の `mem-*.ts` の glob に入れない |
| `src/lib/handoff/request.ts`・`proposals.ts`・`decide.ts`・`pre-end.ts`・`template.ts` | 依頼の作成と状態（期限は読むときに判定）・提案の受け入れ（A の検査を呼ぶ）・承認と確定（S-A の入口だけを呼ぶ）・読み口（S-C）・依頼の文 |
| `src/lib/session/instance-lifecycle-lock.ts`・`src/lib/session/process-identity.ts` | 起動／終了の排他（順序と再入の契約を含む）と実プロセスの世代の読み（§4.6。世代は Agent の前面のプロセスの pid と開始時刻、読めなければ `null`）。tmux と `ps` を読むのはサーバの側（`src/lib/tmux` を使う。CLI からは呼ばない）。`src/lib/handoff/**` からは import しない（世代は route が読んで値で渡す。下の no-generation のガードと同じ判定） |
| `src/lib/handoff/screen-client.ts` | 画面の client（`screenRequestHeaders()` つき、A の `screen-client.ts` と同じ形） |
| `src/app/api/worktrees/[id]/mem/screen/**`・`…/mem/handoff/**` | §2.3・§4.3 |
| `src/cli/commands/handoff.ts`（`program.ts` に登録）・`src/cli/types/` の型 | `propose`・`done` だけ |
| `src/app/repositories/[id]/mem/page.tsx`・`src/components/mem/MemItemsPanel.tsx`・`SessionStartBriefDialog.tsx`・`SessionHandoffDialog.tsx` | §2・§3・§4 |
| `docs/user-guide/`（ja・en）の mem の節 | 画面・対話と無人・終了の流れ・防げないこと（A §11.3 を写す） |

変える A〜D1 のファイル（PM の決定の範囲）：`src/lib/mem/service.ts`（S-A の入口 1 つ、既存の 3 つは変えない）・`src/lib/mem/transitions.ts`（S-D の遷移 1 つ）・`src/lib/db/mem-db.ts`（S-D の `closeMemItemVersioned` 1 つ、既存の `closeMemItem` は変えない）・`tests/unit/lib/mem/write-entrances-recreate-4221.test.ts`（`ENTRANCES` に行を足すだけ）・G-PR3 で `send-request.ts`・`session-brief.ts`・`send/route.ts`・`session-brief-db.ts`・**`src/lib/session/send-user-message.ts`**（S-B。`BriefChoiceAbortedError` を `classifySendFailure` に渡さず `stage:'brief_choice'` で返す、§3.2。第 4 版、3 回目 P2）・`sources.ts` の 1 行（S-C）。S-F（PM の決定 (a)）で `src/lib/brief/fit.ts`（`FitTextOptions.itemCap` と `uncapped` の分岐だけ）・`src/lib/brief/provider.ts`（`detail === 'full'` で `itemCap:false` を渡すだけ）・`src/lib/session/brief-provider.ts`（`BriefRequest.detail?` の欄だけ）。`render.ts` は変えない（`fittedEntryLine` の `all` の引数に `uncapped` を渡すだけで足りる）。C の既存の `it`・期待値・出力は変えない。

変える既存のファイル（A〜D1 の外）：`src/app/api/worktrees/[id]/kill-session/route.ts`（kill の本体を `src/lib/session/kill-instance-session.ts` へ移すだけ。応答・副作用は変えない、既存の試験はそのまま通す。移した本体は起動／終了の排他を取るので、既存の終了も起動と直列になる。`expect` を渡さないので世代は見ない）・起動の全経路（`send-session-start.ts`・`cli-tools/base.ts` の再起動・assistant の start などの `startSession` の呼び出しを `withInstanceLifecycleLock` で包むだけ。起動の中身は変えない。送信の中の再起動は §4.6 の順序の契約の 2 で待たずに取る）・`src/lib/session-cleanup.ts`（`killWorktreeSession` の kill を `withInstanceLifecycleLock` で包むだけ。§4.6 の kill の全経路の表）・`src/lib/api-client.ts`（`sendMessage` の options と戻り値の型、§3.2.1）・`useWorktreeDetailController.ts`（`openActiveKillConfirm`・`handleKillConfirm` の前に分岐）・`WorktreeDetailDesktop.tsx`／`WorktreeDetailRefactored.tsx`（ダイアログを描く）・画面の送信（`MessageInput.tsx`・`ChatSurface.tsx`・`MobileTerminalTab.tsx`・`SessionTile.tsx`・`usePendingMessages.ts` — D1 §4.1 の表の画面の送信の全経路。G-3 はこれらが通る共通の送信の関数の 1 か所に挟む。共通の 1 か所が無ければ全部に置き、表駆動の試験で全経路を固定する）・`MobileTerminalActionsSheet.tsx`（入口）・`RepositoryList.tsx`（入口）・`locales/{ja,en}`。

### 7.3 ガード（`tests/unit/guards/`、新規）

- `handoff-screen-only-4227.test.ts`：`src/cli/**` が `mem/screen`・`handoff/requests/*/(decide|cancel|end|extend|sent)` の書き込みと `X-CommandMate-Client` を持たない（A の `mem-mode-write-screen-only.test.ts` と同じ形。A の試験は変えない）
- `handoff-no-resident-4227.test.ts`：`src/lib/handoff/**` が `setInterval`・`setTimeout`（打ち切りの `AbortController` を除く）・detached・`unref` を持たない（A の `mem-no-resident-4222.test.ts` と同じ判定）
- `handoff-no-generation-4227.test.ts`：`src/lib/handoff/**` の import の閉包に LLM の SDK・`@/lib/report`・tmux を動かすモジュールが無い（C の I9 と同じ判定）
- `handoff-approval-not-from-auto-yes-4227.test.ts`：§5.3 の閉包の検査。`decide.ts` を import するのは `…/handoff/requests/[rid]/decide/route.ts` だけ
- `memWriteFromScreen` を呼ぶのは `src/lib/handoff/decide.ts` と `…/mem/screen/**/route.ts` だけ（E T23 の (2) と同じ形）
- `closeMemItemVersioned` を呼ぶのは `src/lib/mem/service.ts` の `memWriteFromScreen` だけ。`withdraw-recorded` の文字列が `src/cli/**`・`src/lib/handoff/proposals.ts` に無い
- `killInstanceSession` を呼ぶのは kill-session の route と `…/handoff/requests/[rid]/end/route.ts` だけ。`src/lib/handoff/**` の閉包には入らない（上の no-generation と同じ判定）。G の `end` の route は `expect.processIdentity` を必ず渡す
- `instance-lifecycle-lock-4227.test.ts`：`src/**` の `.startSession(` の呼び出しと `cliTool.killSession(` の呼び出しが、すべて `withInstanceLifecycleLock` の callback の中か、それを取る関数（`killInstanceSession`・起動の共通の関数）の中にある（呼び出し元の表を本文から求め、新しい呼び出しを足すと表に足すまで落ちる。`CALLERS` と同じ形）。**加えて tmux の側から逆引きする**（第 4 版、3 回目 P2）：`src/lib/tmux/tmux.ts` の `killSession` を import する全モジュール（TypeScript の AST で、名前つきの import・`as` の別名・`import * as` の名前空間の `ns.killSession`・再 export を辿る）と、`SessionTransport` の `killSession` の呼び出しを本文から求め、各呼び出しが §4.6 の kill の全経路の表の「排他の中」「再入」「除外（理由つき）」のどれかの行にあることを確かめる。陽性対照（`os.tmpdir()` の `mkdtempSync` に置いた fixture のソースで）：表に無い直接の `killSession(name)`・`import { killSession as k }` の `k(name)`・`import * as tmux` の `tmux.killSession(name)` の 3 つがそれぞれ落ちる。陰性対照：表の行どおりの呼び出しは通る
- v71 のトリガー `mem_handoff_proposals_immutable`・`mem_handoff_requests_pinned`・`mem_handoff_requests_forced_sticky` が migration にあり、`handoff-db.ts` の更新の SQL が不変の列を SET せず、`end_forced` を `MAX(end_forced, ?)` でだけ書く

### 7.4 全入口の不変条件の表駆動の試験

`tests/unit/lib/handoff/handoff-entrances-4227.test.ts`（新規）。表のキーは **G の service の export のうち DB の書き込みに届くもの** を本文から求め（固定の名前の列挙にしない）、入口を足すと表に足すまで落ちる（A I18・E T23 と同じ）。S-A の入口は A の `ENTRANCES` に行を足して回す（既存の行・`it`・期待値は変えない）。DB は `os.tmpdir()` の `mkdtempSync` に作り、`afterEach` で消す。

| # | 不変条件 | 陽性対照（直す前・壊した実装で落ちる） | 陰性対照 |
|---|---|---|---|
| H1 | 作り直し後の古い要求の拒否：各入口の `await` の間に worktree を同じ ID・path で消して作り直す／instance を外して同じ ID で足す → 409 `incarnation_changed`。**(H1a) 新しい世代の側を変えない**：`mem_items`・新しい世代の依頼と提案の行が変わらない（全入口）。**(H1b) 旧依頼を失効させる**：旧依頼は `expired(session_changed)`、旧依頼の未決の提案は `expired`（依頼に触る入口だけ。下の入口の表） | 依頼の世代の照合を外した版で、新しい世代の項目に確定が書かれる（H1a）・失効させない版で旧依頼が `reviewing` のまま残る（H1b） | 作り直さなければ書ける |
| H2 | `off`・`derived`・曖昧・未登録で書かない：人の項目の 3 つの API・依頼の作成・提案・`decide` → 409 / 50 `disabled`、`mem_items` と提案の行が変わらない | mode の照合を外した版で `off` の追加が書かれる | `on` は書ける |
| H3 | 版の競合：一覧を読んだ後・提案の後に別の入口（Agent の `mem update`・別の画面）で `version+1` → 人の編集は 409 `version_conflict`、提案の承認は `conflict`。どちらも項目は他者の値のまま | `ifVersion` を外した版で他者の変更を上書き | 版が同じなら書ける |
| H4 | 取り消しで確定しない：(a) 提案 3 件のうち 1 件を確定した後に `cancel` → 確定済みの 1 件は残る、残り 2 件は `discarded`、`mem_items` は 1 件分だけ変わる。他の instance の直接の更新も残る。(b) **確定の前の await 中の `cancel`**：S-A の `askConditionGit` を止めた deps で 1 件目の await 中に `cancel` → `fence` が偽で項目は変わらず、提案は `discarded(cancelled)` | 取り消しで確定済みを戻す版・未決を確定する版・`fence` を最初の確認だけにした版（(b) で取り消された提案が確定される） | 取り消さなければ全部確定できる |
| H5 | 承認は人が見たものだけ：`fingerprint` が違う・承認していない提案 → 確定しない | 指紋の照合を外した版 | 一致すれば確定 |
| H6 | 印：印の無い `decide`・`cancel`・`end`・人の項目の API → 403、何も書かない | 印の検査を外した版 | 印つきは通る |
| H7 | 無人×auto-yes の 2 通り（§5.3 の表）：`popup=0`・auto-yes off で依頼を作る要求 → 409 `unattended`、start-preview は `attended:false`。`popup=1`・auto-yes on で、auto-yes の答えの経路（`prompt-response`・`respond` の route を試験の中で呼ぶ）を通しても提案は `proposed`、依頼は `reviewing`。**加えて、通常の（auto-yes でない）`prompt-response` の経路を各入口（依頼の作成・提案・`done`・`decide`・`rebase`・`cancel`・`end`）の直後に通しても、承認・確定・`end` が進まない**（提案・依頼・`mem_items` の行が変わらない） | auto-yes の有効を「対話」と読む版（`popup` の代わりに auto-yes を読む）で、2 つの組の期待が入れ替わって落ちる | 画面の `decide` だけが確定する |
| H8 | 期限：`agent_deadline_at` の後の提案は 409 `request_closed`。`expires_at` の後の読みで `expired`、kill しない（kill の関数が呼ばれない） | 期限を見ない版 | 期限の前は受ける |
| H9 | 次の世代への記録：`confirmed` の 4 条件の 1 つずつを欠かした 4 通りで `readPreEndUpdate` が `not_recorded`、全部そろえば `recorded`。前の世代の `confirmed` は今の世代の終わりに使われない。**強制の優先**：(a) `done` 済み・提案 0 で `end` の `force:true` → 必ず `unconfirmed(forced)`。**(b) 強制の 2 段の再試行**（再確認 P1-2）：`done` 済み・提案 0 → `end` `force:true` → kill が失敗（`isRunning` が真のまま、世代は同じ）→ 依頼は `reviewing`・`end_forced=1` → `force` なしで `end` を再試行 → kill が成功 → `unconfirmed(forced)`（`confirmed` にならない）。(c) `end_forced` を 1 → 0 にする UPDATE はトリガーで ABORT。(d) forced の依頼への `propose`・`decide` は 409 `request_closed` | 条件を 1 つ外した版。強制の判定を 4 条件の後に置いた版（(a) が `confirmed` になって落ちる）。`end_forced = force ? 1 : 0` で代入する版（(b) の再試行で `confirmed` になって落ちる） | 通常の「確定して終了」（強制でない）で 4 条件がそろえば `confirmed`。強制を一度も使わない kill の失敗→再試行→成功は 4 条件どおり |
| H10 | 提案の作者：他の instance の提案・他の依頼への提案 → 409 `not_requested` | 作者の照合を外した版 | 依頼の instance なら受ける |
| H11 | decision の境界：提案に `record`・`promote` の op は無い（400）。G の close で `recorded` は `confirmUnreflected` が無ければ 409、あれば `closed(withdrawn)`。CLI の `mem close` は今どおり 55 | 確認を外した版 | `open` の取り下げは今どおり |
| H12 | 出口の検査：秘密らしい文字列を含む提案（受け入れの後に規則が変わった）は差分の表示で withheld、確定のときに A の検査で断られて `failed` | 出口の読み直しを外した版で本文が出る | 通常の本文は出る |
| H13 | `decide` の最終の transaction：(a) 同じ `ifVersion` の `decide` を 2 本並行 → 片方だけが `applying` になり、もう片方は 409。項目は 1 回だけ変わる。(b) 項目の保存の後に応答を捨てて同じ `decide` を再送 → 409 と `applied` の状態、`add` は 2 件にならない（`key`）。(c) `decide` の await 中に `end` の `force` → 残りの提案は `discarded(forced)`、項目は変わらない。(d) await 中に期限（`expires_at`）を過ぎる → `expired` | `fence` を外した版・始めの CAS を外した版・`key` を外した版 | 1 本だけの `decide` は全部確定し、既に確定した別の提案を巻き戻さない |
| H14 | S-A の所属・mode・寿命（最終の区間）：(a) `on` の worktree の route から、`off` の別ブランチの item ID を `update`・`close` → 409、項目は変わらない。(b) await 中に worktree を同じ ID・path で作り直す → 409 `incarnation_changed`。(c) 正当な `null→lazy` の発行（A の最初の mem の書き込み）を挟んでも拒まない。**(d) 依頼の所属**（再確認 P1-3）：ブランチ A・B の両方が mode `on`、A で依頼を作り `add` の提案を承認 → `decide` の await（`askConditionGit` を止めた deps）中に同じ worktree の HEAD を B へ変える → 409 `membership_changed`、提案は `failed(membership_changed)`、**A にも B にも `mem_items` の行が 1 件も増えない**。(e) 画面の G-1 の `add`（`expectBranch:'A'`）で同じ await 中に HEAD を B へ → 409、保存ゼロ | 所属の照合を外した版（(a) が書かれる）・寿命を最初だけ見る版（(b)）・`isSameInstanceLifetime` の代わりに incarnation の等号を使う版（(c) が拒まれる）・`pin.membership` を比べない版（(d)・(e) で B に 1 件書かれる） | 同じブランチの項目は書ける。HEAD を変えなければ `add` は A に書かれる |
| H15 | 会話の寿命と実プロセス（§0.1 G6・§4.6）：(a) 在籍を変えずに kill→再起動（新しい `launch` の境界を開く）→ 古い依頼の `propose`・`done`・`decide`・`end` はすべて 409 `session_changed`、`killInstanceSession` は呼ばれない。(b) 画面の再読込・再接続（境界を開かない）→ 受ける。(c) `end` は画面の申告でなく `isRunning` で決める：`isRunning` が真のままなら `ended` にならない。**(d) kill の内部の await 中の再起動**（再確認 P1-1）：`killInstanceSession` の `checkSessionOwnership`・`isRunning` の await を止めた deps で、その間に送信の起動の経路（`startSession` を呼ぶ入口）を呼ぶ → 起動は排他で kill の終わりまで待ち、旧プロセスだけが kill され、依頼の記録の後に新しいプロセスが起動して **生き残る**。(e) 同じ await 中に、排他を通らない入れ替え（偽の tmux で `session_created:pane_pid` を変える）→ `cliTool.killSession` は **呼ばれず**、新しいプロセスが生き残る、依頼は `expired(session_changed)`。(f) kill の後に別の世代が動いている → `unconfirmed(session_changed)`、kill し直さない。**(g) pane・shell は同じで Agent だけ交代する**（第 4 版、3 回目 P1）：偽の tmux・`ps` で `session_created`・`pane_pid` は同じまま、`tpgid` と `lstart` だけを変える（Codex の `relaunchIntoSamePane` と同じ形）→ `cliTool.killSession` は呼ばれず、依頼は `expired(session_changed)`。**(h) 境界の記録の失敗の経路**：`openLaunchBoundary` の DB を投げる形にして同じ pane で Agent を起動し直す（境界の行は増えない）→ 世代は変わり、(g) と同じく kill しない。**(i) 世代を読めない**：`ps` が失敗する・`tpgid` が 0・`lstart` が空の 3 通り → kill せず 409 `identity_unknown`、依頼は `reviewing`。依頼の作成で読めなければ 409 `session_unknown` | 境界を見ない版（(a) で新しいプロセスが kill される）・`isRunning` を見ない版（(c)）・排他を kill の側に通さない版（(d) で起動が割り込み、新しいプロセスが kill される）・kill の直前に世代を読み直さない版（(e) で新しいプロセスが kill される）・**世代を `session_created:pane_pid` だけで作る版（(g)(h) で交代後の Agent が kill される）・`null` を「同じ」と読む版（(i) で kill される）** | 境界と世代が同じなら全部通る（pane・shell・Agent の pid・開始時刻がすべて同じ → kill する）。既存の kill-session の route（`expect` なし）は今どおり kill する |
| H16 | close の版と `recorded`：(a) 承認（人が見た版）の後に他者が `update` → 人の close は 409 `version_conflict`、項目は他者の値で `open`。(b) `recorded` に `confirmUnreflected` なし → 409、あり → `closed(withdrawn)`。(c) CLI の `mem close`（`closeMemItem`）は `recorded` に今どおり 55。(d) Agent の提案で `recorded` の close → 409 `state_forbids` | 版の照合を transaction の外に置いた版・遷移を `close` に混ぜた版（(c) が通る） | `open` の close は今どおり |
| H17 | `now`：S-A の `add` の `kind:'now'`・提案の `now` → 400。人の `now` の枠は #2427 の経路のまま書ける | `now` を S-A に通した版 | 他の kind は書ける |
| H18 | 改版：(a) `conflict` → `rebase` → 古い指紋の `approve` は 409 `proposal_changed`、新しい指紋で確定。(b) 指紋の範囲：`op`・`item_id`・`kind`・`base_version`・`payload`・`revision` のどれを変えても指紋が変わる（1 つずつの 6 通り）。(c) トリガー：不変の列の UPDATE は ABORT | `rebase` で指紋を計算し直さない版・指紋から `op` を外した版・トリガーの無い migration | 競合が無ければ改版なしで確定 |
| H19 | 画面の送信の契約（部品の試験、`@testing-library/react`）：(a) G-3 を閉じると本文・画像・自由入力の下書きが残る。(b) 保留→再送で選択（`brief`・`briefDetail`・`briefBoundary`）が同じ。(c) 終了の依頼の文の送信の body は `brief:'skip'`。(d) PC・スマホ・分割の各ペイン・`SessionTile` の全経路で同じ（表駆動） | 下書きを先に消す版・再送で選択を落とす版 | `popup=0` では body が今と同じバイト列 |
| H20 | `injectOnStart` と「全文」（S-F の (a)）：(a) `popup=1`・`injectOnStart=false` → preview は `show:false`、G-3 を出さない。(b) **600 バイトの本文の 1 項目**を `briefDetail:'full'`（provider に `detail:'full'`）で送る → 本文が省略されずに全部入る（`…(本文 N bytes を省略` が無い）。(c) **総予算の境界**：`itemCap:false` で、予算にちょうど入る項目数と 1 バイト足りない項目数の 2 通り → 入らない項目は項目ごと落ちて `omitted` と `all=` の案内、`BriefOverBudgetError` は出ない。(d) **行数の境界**：`maxLines` ちょうどと 1 行超えの 2 通り → 行の上限が今どおり効く。(e) withheld の項目は `full` でも本文を出さない。(f) D2 の必須の先頭の行は `full` でも入る（D2 の export した定数で照合、G-PR3）。(g) 見えない文字（U+200B など）を含む 600 バイトの本文 → `full` でも置き換えた形で出る。(h) **既定 short の不変**：`itemCap` を渡さない `fitText`・`detail` の無い要求・`briefDetail:'short'` の出力が、同じ入力で今の実装と 1 バイトも違わない（C の既存の試験がそのまま通ることと、変更の前後で出力を比べる対照） | `itemCap:false` を `all` と同じに扱う版（(c)(d) で予算・行の上限を超える）・`itemCap` を見ない版（(b) が省略形のまま）・`full` で sanitize を飛ばす版（(g)） | `short` と CLI の `brief`（`--all` を含む）は今どおり |
| H21 | 選択と境界（§3.2 の表）：(a) preview で A を見た後に A→B（reset）→ `decline`・`full` は 409 `boundary_changed`（`superseded`）、B は `pending` のまま、本文は打たれない。(b) A が別の送信で消費済み → 本文だけ、報告どおりの表示。(c) 変化なし → 選んだとおり。(d) `auto` の応答に brief の報告が無いとき「別の送信で渡された」を出さない。**(e) 確認の後の変化**（再確認 P2）：route の入口の照合を通った後、provider の作成か入力の排他の待ちの間に A→B → 送信の直前の区間で 409、**キーが 1 つも送られない**（偽の sender の呼び出しが 0）、境界 A・B とも消費されない。**(f) 別の送信の予約**：別の送信が A を `claim`（`claimed`）した状態で `decline` → 409（`claimed`）、本文は打たれない → 別の送信が失敗して A が `pending` に戻る → 聞き直して `decline` → `skipped(declined)`。(g) `decline` の本文が打てなかった（`not_sent`）→ A は `pending` に戻る。(h) 画面：(e)(f) の 409 の後、本文・画像の下書きが残り、ダイアログが開き直る（部品の試験）。**(i) `full` の失敗の経路を実際の送信のサービス経由で**（第 4 版、3 回目 P2）：送信の route → `sendUserMessage`（偽の sender・偽の provider、DB は `mkdtempSync`）で、`full` の (i-1) provider が投げる (i-2) provider の本文が予算を超える（`over_limit`。バイトと行の 2 通り、`withinVerifiedSize` を超える 1 通り）(i-3) 区間の `withMemTarget` が投げる、の各々 → HTTP 409 `boundary_changed`（`reason` は `provider_failed`・`over_limit`・`claim_failed`）、**偽の sender の打鍵が 0 回**、境界は `pending` のまま（`skipped`・`sent`・`claimed` にならない、(i-3) で予約した後なら `pending` に戻る）、応答は普通の送信の失敗（`stage:'send'`）にならない。画面の部品の試験で同じ 409 の後に下書きが残る | `full` でも plan が `skip` を書く版（(i) で境界が消費される）・`send-user-message.ts` が `BriefChoiceAbortedError` を `classifySendFailure` に通す版（(i) が 409 でなく送信の失敗になる）・`briefBoundary` を見ない版（(a) で `decline` が B を消費する）・route の入口だけで照合する版（(e) で本文が打たれる）・`claimed` を消費済みと読む版（(f) で本文だけが送られる） | (c)。`auto` は (a)(e)(f) でも今どおり（D1 の既定の動き）。**`auto` の (i-1)〜(i-3)**：本文だけが打たれ（打鍵 1 回分）、D1 の記録は今どおり（`skipped(provider_failed)`・`skipped(over_limit)`、区間の例外は本文だけ）、HTTP は今どおり成功 |
| H22 | 人への質問の分類（§3.1.1）：(a) 質問 0・`state` の情報源が読めない → `count:0`・`unknownSources:['state']`（「質問あり」にしない）。(b) 実際の待ち 1 件 → `count:1`。(c) **同じ待ちの重複**：`state` の `waiting`（今の worktree の X）と `owed` の `prompt`（この instance＝X）→ `count:1`。同じ相手への `awaiting` の `prompt` が 2 本 → 1 件。**(d) 同名の別 worktree**：今の worktree の `claude` の `waiting` と、別の worktree の `claude` を待つ `awaiting` の `prompt` → `count:2`。**(e) 両方向**：`owed` の `prompt`（止まっているのはこの instance）と `awaiting` の `prompt`（止まっているのは `peer`）を別々に・一緒に → 鍵どおりに数える。(f) `peer` が形に合わない relay の行 → 数えず `unknownSources:['relay']`。**(g) C の実際の形**（第 4 版、3 回目 P2）：(a) の fixture は `briefForRoute` に投げる `state` の reader を渡して得た JSON（状態の行は `statusRowItem` の `fields.unavailable`、`sources[]` の `status:'unavailable'`）。entries の状態の行だけ・`sources[]` の `status` だけのどちらでも `unknownSources:['state']`。待っていない instance の `state` の行（`readStateSource` が作る、`waiting` の欄が無い）は数えない | 順位 1 を数える版（(a) が 1 になる）・`entry.status` を見る版（実際の行に `status` の欄が無く、(g) が「質問なし・不明なし」になる）・`waiting !== null` で判定する版（欄が無い行を待ちと数える）・instance ID だけを鍵にする版（(d) が 1 になる）・`dir` を見ずに常に `peer` を鍵にする版（(c) の `owed` が別の鍵になって 2 になる） | 待ちが無く読めれば `count:0`・不明なし |
| H23 | 排他の順序と再入（§4.6 の契約、第 4 版、3 回目 P2）：(a) **外部の起動と送信の中の再起動の競合**：送信 S が input を持ち、Agent が終わっている（`isToolLive` が偽）。同時に外の起動 X（`send-session-start` の経路）が lifecycle を取って input を待つ → S の再起動は lifecycle を待たずに `InstanceLifecycleBusyError`、S は `not_sent`（打鍵 0、D1 の予約は `pending` に戻る）、S が input を離した後に X が起動する。起動は 1 回だけで、試験は待ちの上限の前に終わる（デッドロックしない）。(b) 逆の順：S の再起動が先に lifecycle を取る → X は lifecycle を待ち、S の後で `resolveLaunchPane` が `live` を見て起動しない（起動は 1 回）。(c) **同じ所有者の再入**：`end` → `killInstanceSession`、起動 → `settleLaunchRole` の `kill`・`ensureHealthySession`・`relaunchIntoSamePane` が錠を 2 回取らない（取得の回数を数える偽の錠で 1 回）。(d) **input の所有中の lifecycle の待ち**：`end` が lifecycle を持つ間に送信が input を持って再起動に入る → 待たずに失敗し、`end` の kill はその送信の input の解放を待たずに進む。(e) **旧 ticket の失効の後**：送信 S の input の ticket が `invalidateInstanceInput` で失効した後、S の文脈からの lifecycle の取得は断られる（起動・kill をしない） | 送信の中の再起動でも lifecycle を待つ版（(a) で S と X が互いを待ち、待ちの上限で両方が失敗する）・再入を合流しない版（(c) で自分の錠を待って止まる）・失効した文脈にも lifecycle を渡す版（(e) で古い送信が新しい Agent を起動する） | 競合が無ければ送信の中の再起動は今どおり起動して本文を打つ |

**入口ごとの適用条件と例外**（第 3 版、再確認 P2。表駆動の試験の行のキー。✓＝その H を回す、`—`＝回さない（理由を右端に）。期待が入口で違う所は「例外」に書く）：

| 入口（行のキー） | H6 印 | H2 mode | H1a 新しい世代を変えない | H1b 旧依頼の失効 | H15 会話の寿命・実プロセス | H7 無人×auto-yes | 例外・期待 |
|---|---|---|---|---|---|---|---|
| 画面の項目 `add`・`update`・`close`・`close`(recorded) | ✓ 無印は 403 | ✓ | ✓ | — 依頼に触らない | — 依頼が無い（寿命は S-A の (iii)、H14） | ✓ | `add` は `expectBranch` の照合（H14(e)） |
| S-A の直接の呼び出し（`memWriteFromScreen`） | ✓ service の中の判定（route だけに置かない） | ✓ | ✓ | — | — | — | `pin` があれば H14(d) |
| handoff `create` | ✓ | ✓ | ✓ | — 新しい依頼を作る側 | ✓ 境界・プロセスが無ければ 409 `session_unknown` | ✓ `popup=0` は 409 `unattended` | 開いた依頼があれば 409 `request_open` |
| handoff `read`（`GET`） | **— 印は要らない**：無印でも 200（陰性対照として「無印で読める」を回す） | — 読みは mode で断らない（`off` は 409 でなく状態を返す） | ✓ `mem_items` を書かない | ✓ **状態を進める**：旧依頼は `expired(session_changed)`・期限切れは `expired` | ✓ 判定だけ（kill しない） | ✓ | 読みで変わってよいのは旧依頼・旧提案の状態だけ |
| handoff `sent`・`send-failed`・`extend` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | forced の依頼への `extend` は 409 `request_closed` |
| handoff `propose`・`done`（Agent の CLI） | **— 印は要らない**（Agent の口。印つきでも権限は増えない） | ✓ 50 `disabled` | ✓ | ✓ | ✓ | ✓ | 作者の照合（H10）。期限の後・forced の後は 409 `request_closed` |
| handoff `decide`・`rebase` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `decide` は H13・H14(d) |
| handoff `cancel` | ✓ | — mode が `off` になっても取り消しは受ける（何も確定しない操作） | ✓ | ✓（既に失効なら 409 で何もしない） | ✓ | ✓ | 確定済みを戻さない（H4） |
| handoff `end`（`force` あり・なし） | ✓ | — mode が変わっても終了は受ける（kill の判断は寿命と世代だけ） | ✓ | ✓ | ✓ H15(a)(c)〜(i)・H9(b) | ✓ | 失効していれば kill しない |
| 読みに伴う期限の判定（`expired`） | — 内部 | — | ✓ | ✓ | ✓ kill しない（H8） | — | — |
| 古い行の掃除（14 日） | — 内部 | — | ✓ `mem_items` を消さない | — 終わった依頼だけを消す | — | — | 開いた依頼・14 日以内の行を消さない |

### 7.5 e2e で確かめる項目（`tests/e2e/mem-ui-4227.spec.ts`、PC と スマホの viewport の 2 通り）

- 一覧・追加・編集・close（PC・スマホ）
- 同時編集の競合：2 つのページで同じ項目を開き、片方で保存 → もう片方の保存が 409 になり、3 つの値が並ぶ。載せ直しで保存できる
- 古い差分：Agent の API（`instanceId` つき）で項目を更新 → 開いたままの画面が再読込で「更新されました」を出す
- mode の画面：`derived` で操作が無効・`off` で一覧が出ない
- 閉じるときの流れ：Agent の応答は API で模す（`proposals`・`done` を試験から呼ぶ）。未応答（期限を試験の時計で進める）・確定の失敗（mode を途中で `derived` に）・取り消し・強制終了の 4 通りで、画面の表示と提案の状態。強制終了は `done` 済み・提案 0 でも画面の終了の記録が `unconfirmed(forced)`
- 強制の 2 段の再試行（再確認 P1-2）：`done` 済み・提案 0 →「今すぐ終了」→ kill の失敗（e2e のサーバの kill を失敗させる）→ 画面は「終了できませんでした」→ 普通の「終了」で再試行 → 成功 → 画面の終了の記録が `unconfirmed(forced)`（`confirmed` にならない）
- kill の内部の await 中の再起動（再確認 P1-1）：`end` の kill を遅らせた間に、別のページから同じ instance へ送信（起動の経路）→ 終了の記録が出た後に新しいプロセスが動いている（`isRunning` が真・世代が依頼と違う）。e2e のサーバで kill を遅らせ・失敗させる試験用の差し替え（`killInstanceSession` の deps）が組めなければ、この 2 つは H9(b)・H15(d)(e) の単体の対照と UAT（実の tmux）に回し、その旨を PR に書く［未確認：e2e のサーバの差し替えの口］
- 競合の後の改版：2 つ目のページで項目を更新 → 提案が `conflict` → 「今の版に載せ替える」→ 差分が新しい版で出直す → 承認で確定
- 開くときの下書き：本文と画像を入れて送信 → G-3 を閉じる → 入力欄に本文と画像が残る。選んで送る → 保留の吹き出しの再送でも同じ選択（route の要求の body で確かめる）。**API の旗だけでなく、実際の入力欄の本文と送信の body を見る**
- 終了の依頼の文：送信の body が `brief:'skip'` で、route の応答に brief が付かない
- 開くときのポップアップ：境界の行を試験の DB に作り、3 行の preview（質問 0＋情報源の失敗で「不明」。失敗は手で書いた JSON でなく、e2e のサーバの `briefForRoute` の `state` の reader を失敗させて作る＝実際の `statusRowItem` の行。差し替えの口が組めなければ H22(g) の単体の対照に回し、その旨を PR に書く）と 3 択の送信の本文（`brief`・`briefDetail`・`briefBoundary`）を route の要求で確かめる。preview の後に境界を作り直すと聞き直しになり、**409 の後も入力欄に本文と画像が残る**
- 実機（tmux・本物の Agent）で確かめるもの（kill の成功・kill の await 中の再起動で新しいプロセスが生き残ること・Agent が依頼の文に従って `handoff propose` を打つか・5 分の期限が足りるか・D2 の先頭の行の表示）は UAT に回す（D2 §8 と同じ分け方）

---

## 8. 対になる場所（探した結果）

| 対 | 探した結果 |
|---|---|
| PC とスマホの「終了」 | 同じ hook（`openActiveKillConfirm`・`handleKillConfirm`、`useWorktreeDetailController.ts:1806`・`:1823`）を通る［事実］。分岐はそこに置けば両方に効く。設定の画面の「再起動」（`AgentUpdatesCard.tsx:178`）と roles の画面（`InstanceRolesSection.tsx:111`）も kill-session を直接呼ぶ — **終了の流れに入れない**（設定の変更のための再起動で、作業の終わりではない）。この 2 つで終わったら「記録なし」になる［見立て。§9 U4］ |
| 画面の送信の経路 | D1 §4.1 の表の 5 か所（`MessageInput.tsx`・`ChatSurface.tsx`・`MobileTerminalTab.tsx`・`SessionTile.tsx`・`usePendingMessages.ts`）が `src/lib/api-client.ts` を通る［D1 の事実。G では共通の 1 か所を実装の契約で確かめる］ |
| 画面の印の写し | A の `screen-client.ts`（設定）・B の引き取り・E の承認・G の 3 つ目の client。`screenRequestHeaders()` を共有し、印の判定は `isScreenRequest` の 1 か所 |
| 型の写し `src/cli/types/` | `handoff` の CLI の型を新しく置く。A の `mem` の型を写さず import する |
| 文書の ja・en | `docs/user-guide/` の mem の節（A・E が作る）に G の節を足す。見出しの対は `tests/unit/docs/ja-en-heading-parity.test.ts` が見る |
| kill の本体の写し | kill-session の route（`:123-160`）・G の `end` の route。G-PR2 で共有の関数に寄せ、写しを作らない。設定の画面の再起動・roles の画面は route を通るので、応答は変わらず、起動／終了の排他だけが新しく効く（世代の照合は `expect` を渡さないので無い） |
| 起動／終了の排他の対（第 3 版） | kill の側（`killInstanceSession` の 1 か所）と起動の側（`startSession` の呼び出し：`send-session-start.ts:98-105`・`cli-tools/base.ts:800`・assistant の start）。片方だけに排他を置くと P1-1 は直らないので、両方をガード（§7.3 `instance-lifecycle-lock-4227`）で固定する［事実：`git grep -n '\.startSession(' -- src` の 2026-11-09 の結果。全数は実装の契約で取り直す］ |
| 所属の固定の対（第 3 版） | handoff の `add`（`pin.membership`）と画面の G-1 の `add`（`expectBranch`）。どちらも A の `memAddItem` と同じく最終に解決した target に保存するので、同じ照合を置いた。`update`・`close` は既存の項目の所属の照合 (i) があるが、handoff の経路は `pin` でも照合する |
| 送信の直前の照合の対（第 3 版） | route の入口の `briefBoundary` の照合と、D1 の `claimInStretch`（入力の排他の中）。正は後者。D1 の `auto`・`skip`・`force` の経路は `claim()` の戻りを変えない |
| 中止の伝播の対（第 4 版） | `session-brief.ts` の plan（provider の失敗・`over_limit`）と `claim()`（区間の例外）の 2 か所が中止を作り、`send-user-message.ts` の配送の失敗の分岐（`classifySendFailure` の前）と送信の route の 2 か所が 409 に写す。`sendUserMessage` の他の呼び出し元（relay・timer など）は `full`・`decline` を渡さないので中止を受けない［見立て。実装の契約で `CALLERS` の表から確かめる］ |
| kill の全経路の対（第 4 版） | `cliTool.killSession` の呼び出し（上からの検索）と tmux の `killSession` の import（下からの逆引き）。§4.6 の表に 6 行。片方だけでは `session-cleanup.ts:274` のような直接の呼び出しが漏れる［事実：2026-11-09 の `git grep -n 'killSession' -- src`］ |
| Agent の再起動の対（第 4 版） | 起動の側で Agent だけが交代する所：Codex の `resolveLaunchPane` の relaunch と `relaunchIntoSamePane`（同じ pane に起動の行を打ち直す）・`base.ts:800` の送信の前の再起動（`relaunchIfToolExited`）。どれも `beginAgentSession` を呼ぶが、世代は OS の Agent のプロセスから読むので、境界・`beginAgentSession` の記録に依らない |
| 順位と分類 | C の順位 1（`BRIEF_STATUS_ROW_RANK`）を「質問」と読む所は G の preview だけ（§3.1.1）。D2 の先頭の行・E の画面は順位 1 を質問と数えない［見立て。実装の契約で `git grep -n "rank === 1\|rank: 1" src` で確かめる］ |
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
| U7 | （決定済み）v71。E = v69・F = v70（2026-11-09 の PM の決定で入れ替え）。マージの順は E → F → G |
| U9 | 境界の `explicit`（`send --with-brief` が開く）も「新しい会話」と数えて依頼を `expired(session_changed)` にすること。同じプロセスのまま依頼が切れる場合がある（安全側）。実機で `send --with-brief` と終了の流れが重なる頻度を見る |
| U10 | 起動のたびに D1 の境界の行が必ず開くこと（依頼の作成が `session_unknown` で落ちないか）。D1 の `launch` の証拠の取りこぼしを UAT で見る |
| U11 | （第 3 版で解消）relay の待ち先は `dir`・`peer` から復元する（§3.1.1）。残るのは instance ID が `/` を含みうるか（`peer` の分け方）だけ |
| U12 | （第 3 版で解消）S-F は PM の決定 (a)（§0.0） |
| U13 | 起動／終了の排他はサーバのプロセスごと。2 つのサーバが 1 つの tmux を共有する運用では kill の直前の世代の照合だけが効く。第 4 版で世代を Agent の前面のプロセス（`tpgid` の pid と `lstart`）にした。UAT で見ること：各 Agent（claude・codex・copilot・opencode・antigravity・command-code）で `tpgid` が Agent の本体を指すか（起動の行の `env … <cmd>` のラッパーが前面に残らないか）、Agent が前面に子のプロセス（エディタ・ページャ）を出している間に終了すると `identity_changed` で kill しない頻度、macOS と Linux の `ps -o tpgid=` の差。`lstart` は秒の精度だが pid と組なので、同じ秒に同じ pid が再利用されない限り区別できる |
| U14 | 排他の待ちの上限（`lifecycle_busy` を返すまで）の値。起動は数十秒かかりうるので、kill の側の待ちの上限を起動の長さに合わせて UAT で決める |
| U8 | D2 の先頭の行が `decline` で届かないこと（§3.2）。`decline` でも先頭の行だけは付ける案は D2 の「1 つの会話に 1 回」の規則と予算の扱いに触るので採らなかった |

## 10. 本文に無い指摘（この Issue では直さない）

- `src/lib/api-client.ts:771` の `killSession` と kill-session の route は、期待するプロセス・会話の世代を受けない。G は自分の `end` の route で照合するが、既存の「終了」（`popup=0`）・設定の画面の再起動・roles の画面の kill は今どおり世代を見ずに kill する（G では直さない。G の流れの外）
- `src/lib/api-client.ts:677` の `sendMessage` は route が受ける `brief`（`'skip'`・`'force'`）を body に入れる口を持たない（D1 の欄が画面から使えない）。G-PR3 の §3.2.1 で足す

- `docs/design/mem-store-4221.md` §3.2 の「`recorded` の `mem close` は断る。人が画面で閉じる」に対し、`transitions.ts:45-48` は人の経路も断る（E §8.5 と同じ指摘。§6 S2 で扱う）
- A の項目の route（`POST/PATCH …/mem/items`）は印を見ず `instanceId` だけで書くので、CLI 以外のローカルのプロセスも `instanceId` を名乗れば Agent として書ける。A §11.3 の「防げないこと」の範囲で、新しい穴ではない（記録だけ）

---

## 11. 事前レビューの処置

### 11.1 1 回目（Codex、`prereview/review-4227.md`、第 1 版 `b832056a6` に対して）

| # | 指摘 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|---|
| P1-1 | 承認の初回確認だけでは、途中の取り消し・二重承認を防げない（await 中の `cancel`・同じ `decide` の並行・保存後の応答の消失） | **採る** | 確定の前に await があり、最初の確認だけでは取り消された提案を遅れて確定できる［事実：S-A の `memUpdateItem` は `askConditionGit` を await してから `resolveTarget`、`service.ts:455-470`］ | §4.5 を書き直し：始めの CAS（`applying`・`apply_token`）、S-A の最終の transaction の中の `fence`（依頼・提案の状態・`apply_token`・指紋・期限・会話の寿命）で項目の変更と `applied` を同じ transaction で確定、終わりの CAS、応答の消失の扱い（`version` の 409・`add` の `key`）。§4.3 に `apply_token`。§0.0b S-A に `fence`。§7.4 H4(b)・H13 |
| P1-2 | 強制終了でも 4 条件で `confirmed` が成立しうる | **採る** | `done` 済み・提案 0 の「今すぐ終了」が 4 条件を満たす | §0.1 G5 に優先の規則。§4.6 の `outcome` の決め方を優先の順（forced → session_changed → 4 条件）に。§4.3 に `end_forced`。§4.4 の強制終了の行。§7.4 H9 に陽性・陰性対照、§7.5 |
| P1-3 | 在籍の世代では終了対象のプロセスを固定できない。`killed:true` だけで成功としない | **採る** | A の incarnation は在籍の寿命で、kill→再起動では変わらない［事実：`incarnation.ts:1-12`・`agent-session-lifecycle.ts:99`］。`killSession` に期待する世代の欄が無い［事実：`api-client.ts:771`］ | §0.1 G6（会話の寿命の鍵 = D1 の境界の `id`）。§4.3 に `boundary_id`・`instance_on_roster`・「会話の寿命」の照合を全入口に。§4.6 で `end` をサーバの照合→kill→`isRunning` の確認→記録に（画面の `killed` を廃止）、kill の本体を共有の関数へ。§4.4 に kill→再起動・再接続の行。§1・§7.2・§7.3。§7.4 H15 |
| P2-1 | S-A は `by='human'` だけでは A の不変条件を引き継げない（所属・mode・寿命） | **採る** | `ownedBy` は人なら即真［事実：`mem-db.ts:857-858`］で、Agent の口が所有の照合で得ている所属の検査が人の経路に無い | §0.0b S-A に (i) 所属 (ii) mode (iii) 寿命 を最終の区間で明示。`isSameInstanceLifetime` で `null→lazy` を拒まない。§7.4 H14 |
| P2-2 | close の版の照合・`withdraw-recorded` の到達経路・`now` の扱いが不足 | **採る** | `closeMemItem` は `ifVersion` が無く `'close'` 固定［事実：`mem-db.ts:923-935`］。`memAddItem` は `now` を断る［事実：`service.ts:371`］ | §0.0b S-D に `closeMemItemVersioned`（版の比較と close を 1 つの transaction、遷移を引数で）と到達の条件。S-A と §2.2 に `now` は #2427 の経路のまま・提案は `now` を扱わない。§2.3・§6 S2・§7.2・§7.3。§7.4 H16・H17 |
| P2-3 | 競合の後の再承認の API が無い。指紋の範囲と列の不変 | **採る** | 指紋が `payload` と `base_version` だけで、`op`・`item_id` を変えても同じ指紋になりうる | §4.5.1（改版→再表示→再承認の 3 段、`rebase` の API）。§4.3 で `revision`・`kind` の列、指紋の範囲を `{request_id, id, revision, op, item_id, kind, base_version, payload}` に、不変の列を v71 のトリガーで保証。§4.4 の版の食い違いの行は §4.5.1 に従う。§7.3・§7.4 H18 |
| P2-4 | S-B の画面の側の契約（api-client・MessageInput の下書き・保留と再送・結果の経路）が抜けている | **採る**（G-PR3、D2 のマージ後） | `sendMessage` は brief を body に入れず［事実：`api-client.ts:677-700`］、楽観送信は直後に下書きを消す［事実：`MessageInput.tsx:420-428`］ | §3.2.1 を新設。§0.0b S-B に画面の側も同じ PR と明記。§7.2 に `api-client.ts`。§7.4 H19、§7.5 |
| P2-5 | 「全文」と実際の注入条件が一致しない（512 バイトの省略・`injectOnStart=false`） | **一部採る** | 項目ごとの 512 バイトの省略は C の `fit.ts`・`render.ts` の変更なしに外せない［事実：`fit.ts:45-60`・`render.ts:95-100`］。契約の「止める条件」に当たるので、作らずに S-F として PM へ返す。`injectOnStart=false` は C を変えずに決められるので決めた | §0.0 S-F（最小の案：`FitTextOptions.itemCap` と provider の `detail`。代わりの意味づけ：「詳しく」）。§3.1 に `injectOnStart`、§3.2 の出す条件と「詳しく」の行。§7.4 H20 |
| P2-6 | preview の選択が見せた境界に結ばれていない | **採る** | 送信の body に期待する境界の ID が無く、A を見て選んだ `decline` が B を消費しうる | S-B に `briefBoundary`。§3.2 の境界の 3 通り（同じ・変わった → 409 `boundary_changed` で聞き直す・消費済み）と、`auto` の応答に報告が無いときに断定しない［事実：`send/route.ts:94`］。§3.2.1 で 409 を再送しない。§7.4 H21 |
| P2-7 | 順位 1 の件数は人への質問の件数ではない | **採る** | `state`・`relay` の「読めない」行も順位 1［事実：`sources.ts:83-93`］ | §3.1 の 2 行目を `{count, unknownSources}` に、§3.1.1 の分類（`waiting`・`relay` の `prompt`、同じ instance は 1 件、状態の行は不明）。C のファイルは変えない。§8・§7.4 H22・§7.5 |
| P3-1 | D2 の先頭の行の上限が古い（96 → 128） | **採る** | D2 の今の値は 128（`../commandmate-issue-4224` の作業中の設計書 §7.1。なお同 worktree の HEAD `d58934b4e` の `git show` では 96 のままで、128 は未コミットの作業中の値［事実：2026-11-09 に両方を読んだ］） | §4.6 で 128 に直し、G は数値を持たず D2 の export した定数を import して試験する、と書いた |
| 全体 | 全経路の試験表・H4 の await 中の cancel・H9 の強制の優先・e2e の本文と下書き・auto-yes 以外の prompt-response | **採る** | — | §7.4 の H4・H7・H9 の書き換え、H13〜H22、全経路の行のキー。§7.5 に改版・下書き・依頼の文の e2e。§5.3 |
| 推奨 | S-A・S-D を確定処理の契約として一緒に具体化、S-E は画面変更、S-B は D2 のマージ後に一か所、S-C は副作用のない読み専用 | **採る** | PM の決定と同じ向き | §0.0b・§7.1（G-PR1 に S-A・S-D、G-PR3 に S-B・S-C、`pre-end.ts` は読み専用） |

- PM の決定（G の節）の反映：S-A・S-D・S-E を採る（§0.0b）、S-B・S-C を D2 のマージ後に G-PR3 で（§0.0b・§7.1）、S3 は §6 の案（§6）、当時の決定は G = v70・F は足さないだったが、第 3 版で G = v71（F = v70）に直した・マージの順 E → F → G（§7.1・§9 U7）
- 第 2 版で新しく止める点は S-F だけ（§0.0）だった。第 3 版で PM の決定 (a) を反映し、§3.2 は「全文」に戻した

### 11.2 2 回目（Codex の再確認、`prereview/review-4227b.md`、第 2 版 `9ea305362` に対して）

再確認の評価：P1-1・P2-2・P2-3・P2-4・P3-1 は解消。P1-2・P1-3・P2-1・P2-5・P2-6・P2-7 は一部解消。残件と追加の指摘を次のとおり処置した。

| # | 指摘 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|---|
| R-P1-1（前回 P1-3 の残り） | 境界の照合の後・実際の kill の前にプロセスが入れ替わると、新しいプロセスを kill できる | **採る** | 既存の kill は `checkSessionOwnership`・`isRunning` を await してから `killSession` を呼び［事実：`kill-session/route.ts:129-152`］、起動と kill を並べる排他は無い［事実：`instance-input-lock.ts` は composer の書き手の順だけ］。`killInstanceSession` も期待する世代を受けない | §4.6 に起動／終了の排他 `withInstanceLifecycleLock`（kill・起動・依頼の作成が取る）と実プロセスの世代（`process_identity`＝`session_created:pane_pid`、依頼の作成で固定、`killSession` の直前に読み直す）を足し、`end` の全体を排他の中で行う。§4.3 に `process_identity` とトリガー。§4.4 の行を 3 つに分けた。§7.2 に新規 2 ファイル・起動の全経路、§7.3 にガード。§7.4 H15(d)(e)(f)、§7.5、§8、§9 U13・U14 |
| R-P1-2（前回 P1-2 の残り） | 強制終了の失敗の後の再試行で forced が消える（`end_forced = force ? 1 : 0`） | **採る** | §4.4 の「残す」と §4.6 の代入が食い違っていた | §4.6 を `end_forced = MAX(end_forced, …)` にし、§4.3 にトリガー `mem_handoff_requests_forced_sticky`（1 → 0 を ABORT）と「forced の依頼は以後 `propose`・`decide` などを受けない」。§4.4 の kill の失敗の行。§7.3。§7.4 H9(b)(c)(d)、§7.5 に 2 段の再試行 |
| R-P1-3（前回 P2-1 の残り） | `add` の提案が別のブランチへ確定される（pin・fence が所属を比べない） | **採る** | A の `memAddItem` は最終に解決した target の scope に保存する［事実：`service.ts:389-397`］ので、既存の項目の所属の照合では新しい `add` を防げない | S-A に (iv) `pin.membership`（repository・branch・detached）と最終の target の照合（409 `membership_changed`）。§4.3 に `detached` の列と所属の固定、§4.5 の `pin`。対になる場所として画面の G-1 の `add` に `expectBranch`（§2.3）。§7.4 H14(d)(e) |
| R-P2-1（前回 P2-6 の残り） | `briefBoundary` を送信の直前の排他の区間でも照合する。decline/full の最終の照合・409 の伝播・予約中の扱い | **採る** | D1 の `claim()` は不一致・例外で本文だけを打つ［事実：`session-brief.ts:347-360`］。`claimed` は消費でなく `not_sent` で `pending` に戻る［事実：`session-brief-db.ts:362-403`］ | §3.2 を照合 2 回（正は `claimInStretch`）と境界の状態ごとの表に書き直し、`claim()` の「中止」→ `BriefChoiceAbortedError` → 409 の伝播、`decline` の予約と `settleDeclinedClaim`（`not_sent` は `pending` に戻す）を定義。§3.2.1 の保留の 1 件の扱い。§0.0b S-B。§1 の表。§7.4 H21(e)〜(h)、§7.5 |
| R-P2-2（前回 P2-7 の残り） | 質問の重複の排除を instance ID だけにすると過少に数える。relay の待ち先は `dir`・`peer` から | **採る** | relay の行は `dir`・`peer` を返し、専用の待ち先の欄は無い［事実：`sources.ts:244-262`］。`prompt` は働く側（`to`）が止まったこと［事実：`relay-badges.ts:20-25`・`v60-session-relays.ts:13-18`］ | §3.1.1 の鍵を `(worktree, instance)` にし、`owed`／`awaiting` ごとの待ち先の復元を定義（形に合わない行は「不明」）。§1 の表。§7.4 H22(c)〜(f)。§9 U11 を解消 |
| R-P2-3（追加） | テストの表の全行への適用が API の契約と矛盾する（GET は印が不要、寿命の変更で旧依頼を expired にする） | **採る** | H6 の無印 403・H1 の「依頼が変わらない」は読みと Agent の口に当てはまらない | §7.4 に入口ごとの適用条件と例外の表。H1 を H1a（新しい世代を変えない）と H1b（旧依頼の失効）に分けた。§4.3 の「会話の寿命」に読みの扱い |
| R-P2-4（前回 P2-5 の残り、S-F） | 決定待ち。3 択を保つなら `itemCap` の追加を推す。H20 は 600 バイトの 1 項目・総予算と行数の境界・D2 の必須の行・既定 short の不変 | **採る**（PM の決定 (a)） | PM の決定：(b) は Issue の「全文」を満たさず受入基準の文面を変える。Codex の推奨と同じ向き（P1 の別意見ではないので PM に戻さない） | §0.0 を決定済みに書き換え（`fitText` の `all` を `uncapped` と分ける、provider の `detail`、sanitize は同じ関数）。§3.2 を「全文」に戻した。§3.1 の注。§7.1 G-PR3、§7.2 の変えるファイル（`fit.ts`・`provider.ts`・`brief-provider.ts`、`render.ts` は変えない）。§7.4 H20(b)〜(h)。§9 U12 を解消 |
| PM（F の番号） | F が v70 を使う | **採る** | PM の決定（F = v70・G = v71、マージの順 E → F → G） | 設計書の G の v70 をすべて v71 に（§0.0b・§1・§4.3・§4.5.1・§7.1・§7.2・§7.3・§9 U7・§11.1） |

- 第 3 版で新しく止める点は無い。起動の全経路に排他を足すことは A〜D1 の作り直しではなく（`send-session-start.ts`・`cli-tools/base.ts` は A〜D1 の外）、PM の決定の範囲（S-A〜S-F）にも触れない［見立て］
- C の既存の `it` と出力は変えない（S-F は既定が今どおり）。D2・E の worktree とファイルは読んでいない（第 3 版では読む必要が無かった）

### 11.3 3 回目（Codex の再確認、`prereview/review-4227c.md`、第 3 版 `f061f8d9a` に対して）

再確認の評価：前回の 7 件のうち R-P1-2・R-P1-3・R-P2-1〜R-P2-4 は解消、R-P1-1 は一部解消（排他と kill の直前の照合は入ったが、世代の値が Agent の再起動を見分けない）。残件と追加の指摘を次のとおり処置した（第 4 版。ほかの節は変えていない）。

| # | 指摘 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|---|
| P1 | `session_created:pane_pid` は同じ pane の中の Agent の再起動を見分けない | **採る** | `pane_pid` は pane の最初のプロセス（shell）。Codex は shell と pane を残して Agent を起動し直す［事実：`codex.ts` の `resolveLaunchPane` の relaunch・`relaunchIntoSamePane`］。D1 の境界の記録は失敗しても起動を止めない［事実：`session-boundary.ts:153` の `openLaunchBoundary` の catch → warn］ので、境界に頼る世代も漏れうる | §4.6 の世代を `'<session_created>:<pane_pid>:<agent_pid>@<agent_started>'`（`ps -o tpgid=` の前面のプロセスと `ps -o lstart=`）に。OS から読むので境界の記録の成否に依らない。読めなければ `null` で fail-closed（依頼の作成は 409 `session_unknown`、kill の直前は kill せず 409 `identity_unknown`、止まったことの確認は `kill_failed` 扱い）。§1 の表・§4.3 の列の注・§4.4 に 2 行・§4.6 の 2〜4・防げないこと。§7.4 H15(g)「pane・shell は同じで Agent だけ交代する」・(h) 境界の記録の失敗の経路・(i) 読めない、の対照。§8・§9 U13 |
| P2(1) | 排他のガードが kill の全経路を列挙できない（`session-cleanup.ts:274` の直接の呼び出し） | **採る** | tmux の `killSession` を直接呼ぶ所が `cliTool.killSession` の外に 4 つある［事実：`session-cleanup.ts:274`・`:314`、`claude-session.ts:712`、`session-key-sender.ts:166`］ | §4.6 に tmux の側から逆引きした kill の全経路の表（排他の中・再入・除外）と保証の範囲。`killWorktreeSession` は排他へ通し、`cleanupGlobalSessions` は理由つきで除外。§7.2 に `session-cleanup.ts`。§7.3 のガードを逆引き（別名・名前空間・再 export を辿る）にし、直接・別名・名前空間の呼び出しの陽性対照と陰性対照。§8 |
| P2(2) | 質問の分類の状態の行の形が C の JSON と違う | **採る** | 状態の行は `fields.unavailable`／`fields.unsupported` を持ち `status` の欄は無い［事実：`sources.ts:115-133` の `statusRowItem`］。情報源の `status` は別の `sources[]`［事実：`build.ts:321-326`］。`state` の行は `compact` で null の欄を落とす［事実：`sources.ts:108-112`・`:182-199`］ | §3.1.1 の分類を `entries[].fields` と `sources[]` の両方で行う形に直し、`waiting` は欄の有無で判定、`omitted` の順位 1 も「不明」に。fixture は `briefForRoute`・`statusRowItem`・`readStateSource` を通して作る。§7.4 H22(g)、§7.5 |
| P2(3) | `full` の失敗の経路を実際の送信のサービスまで固定する試験が無い。`send-user-message.ts` が §7.2 に無い | **採る** | 今の plan は失敗で境界を `skip` にし［事実：`session-brief.ts:314-327`］、`sendUserMessage` は配送の例外を普通の送信の失敗に変える［事実：`send-user-message.ts:702-728`］ので、第 3 版の「409 にする」は `send-user-message.ts` を変えないと成り立たない | §3.2 に `full` の失敗の経路（plan は `full` で `skip` を書かず中止、区間の例外は中止 `claim_failed` で予約を戻す、`send-user-message.ts` は `stage:'brief_choice'` で返す、`auto` は今どおり）。§7.2 の変えるファイルに `send-user-message.ts`。§7.4 H21(i)（provider の失敗・予算と行・`withinVerifiedSize`・区間の例外 → 409・打鍵 0・境界を消費しない・下書きを残す、`auto` の同じ失敗を陰性対照に）。§8 |
| P2(4) | 排他の順序と再入の契約が無い（送信は input を持ってから再起動で `startSession` に入る） | **採る** | 既存の送信の中の自動の再起動は input → 起動の順［事実：`send-user-message.ts:702-713`・`base.ts:800`］。input の錠には再入と旧 ticket の失効がある［事実：`instance-input-lock.ts:530-560`・`:802-830`］ | §4.6 に順序と再入の契約 5 項（外からは lifecycle → input、input を持つ文脈は lifecycle を待たない、同じ所有者は合流、失効した文脈には渡さない、待ちの上限）。§7.4 H23（外部の起動と送信の中の再起動の競合の両方の順・再入・input の所有中の lifecycle の待ち・旧 ticket の失効の後） |

- 第 4 版で新しく止める点は無い。`send-user-message.ts` と `session-cleanup.ts` の変更は S-B の 409 の伝播と P1-1 の排他を成り立たせる最小の変更で、A〜D1 の作り直しでも PM の決定の範囲の外でもない［見立て］。D2・E の worktree とファイルは読んでいない（第 4 版でも読む必要が無かった）
- 未確認：実の tmux・`ps` での `tpgid` の値（Agent ごと、U13）、e2e のサーバの reader と kill の差し替えの口、`ensureHealthySession` の呼び出し元が起動の中だけか（実装の契約で取り直す）
