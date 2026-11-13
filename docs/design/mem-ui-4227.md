# mem の閲覧・編集と、対話・無人に応じた開始と終了の流れ（Issue #4227 / Epic #4220 の子 G）設計

- 状態：設計の段（**第 6 版**、実装前）。第 1 版（`b832056a6`）に PM の決定（`pm-decision-4226-4227-stops.md` の G の節）と Codex の事前レビュー（`prereview/review-4227.md`、P1 3・P2 7・P3 1）を反映したのが第 2 版（`9ea305362`）。第 3 版は PM の決定（`pm-decision-4226-s3-4227-sf.md` の G の S-F の節と F の番号の節）と Codex の再確認（`prereview/review-4227b.md`、残件 P1 3・P2 4）を反映した。第 4 版は Codex の 3 回目の再確認（`prereview/review-4227c.md`、P1 1・P2 4）だけを局所に反映した。第 5 版は 4 回目の再確認（`prereview/review-4227d.md`、P1 1・P2 1）を、PM の決定（kill の対象の識別を 3 値の規則にする・新しい拒否を未送信へ写す）に沿って局所に反映した。**第 6 版は PM の決定（`pm-decision-4227-kill.md`：終了の流れから自動の kill を外す）と 5 回目の再確認（`prereview/review-4227e.md`、P1 1・P2 2）を反映した**：G は kill しない。閉じるときは 更新の依頼 → 提案 → 差分 → 承認 → 確定 →（人がその場で押す既存の停止）で、G はその後に止まったことを観測して記録するだけ。kill の排他・Agent の世代の記録・識別の 3 値の関数・観測点の表・kill の側へ通す期待の識別・`InstanceLifecycleBusyError` は G から外した（§4.6.1 に「採らない」として理由つきで残す）。処置の一覧は §11（1 回目 §11.1・2 回目 §11.2・3 回目 §11.3・4 回目 §11.4・5 回目と PM の決定 §11.5・6 回目 §11.6）。実装は同じブランチの別の契約で行う。**G-PR1（§7.1）を実装した**：S-A の `memWriteFromScreen`・S-D の `withdraw-recorded` と `closeMemItemVersioned`・§2.3 の人の項目の API・G-1 の画面・S-E。G-PR1 の契約で 6 回目の再確認の 2 件を局所に直し（§11.6）、共通規則の全読者を §12 に書いた。**G-PR2（§7.1）を実装した**：v71・`src/lib/handoff/**`・CLI `handoff`・G-4 の部品と hook の口・ガード。設計から決めたこと・外れたことは §11.12、全読者は §12 の G-PR2 の欄（実装の事実）。**G-PR3（§7.1）を実装した**：G-3（開くときの preview と選択、§3.1.1 の分類）・S-B の欄と画面の側の契約・S-F・S-C の読み口（`pre-end.ts`。接続は §11.22 の止める点）・MemItemsPanel の単位を G-PR2 の store へ・pr2e P3-2／P3-3・e2e の模型の補正。設計から決めたこと・外れたことは §11.22、全読者は §12 の G-PR3 の欄（実装の事実）
- **第 3 版〜第 6 版で新しく止める点は無い。**（第 5 版の識別の規則と、その止める条件は第 6 版で G から外した。第 6 版は G の作るものを減らすだけで、A・B・C・D1 の作り直しも PM の決定の範囲の外の変更も無い［見立て、§11.5］） 第 2 版の S-F は PM が (a)（C に旗を 1 つ足す）に決めた（§0.0）。migration の番号は **G = v71**（E = v69・F = v70。マージの順 E → F → G）
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
| G5 | Issue「『終わる前の更新を確認できない』事実を次の世代へ残す」 | 「確認できた」を **狭く** 定義する：その instance の終了の依頼が「確定して終了」（強制でない）で終わり、かつ Agent の応答（`done`）・人の全提案への判断（承認して確定 or 捨てる）・確定の全成功・**人がその場で押した既存の停止の後に、サーバが止まったことを観測した**（§4.6。第 6 版：G は kill しない）の **全部** を満たしたときだけ `confirmed`。**強制終了（確定の前に人が停止を押した＝「今すぐ停止」）は 4 条件より優先して必ず `unconfirmed(forced)`**（`done` 済み・提案 0 でも）。停止を確かめられなければ `confirmed` にしない（次の世代には「確認できない」が残る）。1 つでも欠ければ `unconfirmed`（理由の語つき）。依頼が無い終わり方（CLI・異常終了・orchestrate の掃除）は記録が無い＝確認できない |
| G6 | 依頼・提案・kill・end を「同じセッション」に結ぶ | **会話の寿命の鍵を D1 の境界の行（`session_brief_boundaries` の `id`）にする。** 依頼を作るとき、その instance の今の境界（`getCurrentBoundary`、最も大きい `seq`）の `id` を固定する。以後の提案・`done`・`decide`・`end` は、今の境界の `id` が固定した値と同じで、かつ instance の寿命（A の在籍の世代、`isSameInstanceLifetime`）が同じときだけ受ける。境界は起動（`launch`）・自動の再起動・reset・resume・明示（`explicit`）で新しい行になる（`session-brief-db.ts:24`）ので、在籍を変えずに kill→再起動した後の古い要求は拒まれる。画面の再読込・WebSocket の再接続は境界を開かないので受ける | A の incarnation は在籍の寿命で、プロセスの起動の世代ではない（`src/lib/mem/incarnation.ts:1-12`。kill→再起動は `beginAgentEventGeneration` を進めるが incarnation は変えない、`agent-session-lifecycle.ts:99`）。永続化された会話の区切りで、既にあるのは D1 の境界だけ。`explicit` を「新しい会話」と数えるのは安全側（確認できない側）に倒れる［見立て］ | D2 §7.1 の文言は「確認できない」で断定しない。確認できなかった側に倒す（「確かめた」と誤って出す方が害が大きい） |


### 0.2 Issue の範囲・受入基準との対応（第 6 版、PM の決定の読み替え）

PM の決定（`pm-decision-4227-kill.md`、2026-11-09）：**終了の流れから自動の kill を外す。** 3〜5 回目の再確認の P1 はすべて「古い依頼が、後から入れ替わった Agent を kill しうる」ことの識別の端で、各 CLI のプロセス構成は実機でしか決まらず、識別を詰めても端が出続ける見込み。危険の元（古い依頼による自動の kill）を作らない。受入基準は弱めない。

| Issue の文面 | この設計での読み（第 6 版） | どこで |
|---|---|---|
| 閉じるとき（画面の「終了」から）：更新を頼む → 提案 → 差分 → 人が承認した提案だけを版を照合して確定 → **閉じる** | 「閉じる」＝ **人がその場で押す既存の停止**（今の「終了」と同じ `handleKillConfirm` → `worktreeApi.killSession` → kill-session の route。変えない）。流れは 更新の依頼 → 提案 → 差分 → 承認 → 確定 →（人が押す既存の停止）。G はサーバから kill しない。停止の後に G の `end` が止まったことを観測して記録するだけ | §4.1・§4.6 |
| Agent が応答しない | 今どおり試す：期限（5 分）で `agent_timeout`、待つ／ここまでの提案で進む／提案なしで終える／やめる | §4.4・H8・§7.5 |
| 更新に失敗した | 今どおり試す：確定の 1 件の失敗は `failed`、残りで進むかやめる | §4.4・H13・§7.5 |
| 人が取り消した | 今どおり試す：未決の提案を捨てる、確定済み・他のセッションの更新は巻き戻さない | §4.4・H4・§7.5 |
| 強制終了した | **＝人が確定の前に停止を押した場合**（どの段でも「今すぐ停止」＝既存の停止＋`end` の `force`）。未決の提案を捨て、記録は必ず `unconfirmed(forced)`。停止に失敗した後の再試行でも forced は消えない | §4.4・H9・§7.5 |
| タイムアウト | Agent 5 分（延長 2 回）・全体 60 分。サーバは待たず、読むときに判定。**期限でサーバが kill することはない**（今どおり） | §4.3・§4.4 |
| 「終わる前の更新を確認できない」事実を次の世代へ残す | 「確認できた」（`confirmed`）＝ **確定までの成功**（`done`・全提案への判断・確定の全成功）と、**人が停止を押したことの観測**（G-4 の停止のボタンの押下の後にだけ画面が送る `end`）と、**サーバが止まったことを確かめた**（`isRunning` が偽・境界と在籍の寿命が依頼と同じ）の全部。停止を確かめられなければ（まだ動いている・境界が変わった・画面が `end` を送らずに閉じた・サーバが落ちた）`confirmed` にせず、次の世代の先頭の行は「確認できない」になる（D2 の読み口は `not_recorded`） | §0.1 G5・§4.6 |
| 無人の経路・auto-yes を人の承認にしない | 変わらない（無人では今どおりの確認の Modal → kill。依頼なし・記録なし） | §5 |

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
| kill の口 | `worktreeApi.killSession(id, cliToolId?, instanceId?)`（`src/lib/api-client.ts:771`）は期待する世代を渡す欄を持たない。kill の本体は `kill-session/route.ts` の中に直書き（`:123-160`、`cliTool.isRunning`・`cliTool.killSession`） | **第 6 版：G は kill しない。** 閉じるときの停止は人がその場で押す既存の停止（この口と route をそのまま使う、変えない）。G の `end` は停止の後に止まったことを観測して記録するだけ（§4.6）。kill の本体の共有の関数への移動はしない（§4.6.1） |
| 画面の送信の欄 | `sendMessage` の options は `{ cliToolId?, instanceId?, imagePath? }` だけで、`brief` を body に入れない（`api-client.ts:677-700`）。`MessageInput` の楽観送信は `onOptimisticSend` の直後に下書きを消す（`MessageInput.tsx:420-428`） | S-B の画面の側の契約（§3.2.1） |
| C の「全文」 | 有限の予算では項目ごとに 512 バイトで省略形（`fit.ts:45-60`・`render.ts:95-100`・`types/brief.ts:43`）。`injectOnStart=false` は D1 が付けない（`session-brief.ts:288`）。provider の要求の型 `BriefRequest` は `src/lib/session/brief-provider.ts:23`、`fitText` を呼ぶのは `src/lib/brief/provider.ts:129-138` | S-F（§0.0、PM の決定 (a)） |
| C の順位 1 | 情報源 `state`・`relay` の「読めない」行も順位 1（`BRIEF_STATUS_ROW_RANK`、`sources.ts:83-93`）。実際の待ちは `state` の `waiting`（`:182-199`、欄 `instance`）と `relay` の `state=prompt`（`relayItem`、`:244-262`。欄は `dir`（`owed`＝この instance が `to`、`awaiting`＝この instance が `from`）と `peer`＝`<worktreeId>/<instanceId>`。専用の待ち先の欄は無い）。relay の `from` は依頼した側、`to` は働く側で、`prompt` は **働く側（`to`）** が確認で止まったこと（`src/lib/db/migrations/v60-session-relays.ts:13-18`・`src/lib/relay/relay-badges.ts:20-25`・`:102`） | 人への質問の件数は順位でなく分類で数え、鍵は `(worktree, instance)`（§3.1.1） |
| 送信の直前の照合（D1） | D1 の `claim()` は入力の排他の中の `claimInStretch` で所属・境界・寿命を照合し、不一致・例外では **本文だけを打つ**（`session-brief.ts:347-360` の `return this.input.content`）。`claimed` は消費ではなく、送れなければ `settleBoundaryClaim(…,'not_sent')` で `pending` に戻る（新しい境界があれば `superseded`、`session-brief-db.ts:362-403`） | §3.2 の最終の照合（`decline`・`full` は本文だけにせず 409） |
| 起動と kill の排他 | 入力の排他（`withInstanceInputLock`、`instance-input-lock.ts:542`）は composer への書き手の順で、起動・kill を並べない。kill-session の route は `checkSessionOwnership`・`isRunning` を await してから `killSession` を呼ぶ（`kill-session/route.ts:129-152`）。起動の呼び出しは `send-session-start.ts:98-105`・`cli-tools/base.ts:800` など。src に tmux の `session_created`・`pane_pid` を読む所は無い（`git grep` で 0 件）。`pane_pid` は pane の最初のプロセス（shell）で、Codex は shell と pane を残して Agent だけを起動し直す（`codex.ts` の `resolveLaunchPane` の relaunch と `relaunchIntoSamePane`）ので、`pane_pid` は Agent の世代ではない（第 4 版）。`ps -o tpgid=` は端末の前面のプロセスグループの ID で、job control の無い shell では Agent が shell と同じグループで動くので、Agent が交代しても同じ値になりうる（第 5 版。4 回目 P1）。起動の行は `NAME='value' … <command>` を利用者の login shell に打つ（`agent-session-lifecycle.ts` の `buildAgentLaunchCommandLine`・`tmux.ts` の `respawnLoginShell`）。起動の全経路は `beginAgentSession` を呼ぶ（`git grep -ln 'beginAgentSession(' -- src` の 10 ファイル）tmux の `killSession` を直接呼ぶ所は `cliTool.killSession` の外にもある（`session-cleanup.ts:274`・`:314`、`claude-session.ts:712`、`session-key-sender.ts:166`、`base.ts:983`・`opencode*.ts` の stop） | （第 6 版で外した）G は kill しないので、起動／終了の排他と Agent の識別を足さない（§4.6.1）。左の事実は「採らない」理由の記録として残す |
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
  - 編集：本文・`closeWhen`・`evidence`。`ifVersion` は編集を開いた時点の `version`、送るのは人が変えた欄だけ（§2.4.1）
  - close：理由の任意入力。`ifVersion` は「閉じる」を開いた時点の `version`。decision の `open` は「取り下げ」（`withdrawn`）、`recorded` は S-D の 2 段の確認、`promoted` は「close」（`manual`）。ボタンは遷移の表から導く（§2.4.1 の (5)）
  - 人が書いた項目（`created_by='human'`）は人だけが変える・閉じる（D6）。所有に選んだ instance の Agent の `mem update`・`mem close` は 409 `not_owner`（exit 55）。条件の close は誰の項目にも効く
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
| `GET /api/worktrees/:id/mem/start-preview?instance=`（G-PR3 で `mem/screen/` の外へ、§11.22 #2） | — | §3.1（読み。印は要らない） |
| 終了の流れの API | §4.3 | |

- `instanceId` は「誰の枠・誰の所有として書くか」で、書き手は人（`updated_by='human'`）。worktree が無い branch（repository の経路）の項目の編集・close は、項目の `origin_worktree_id` が今も在ればその worktree の route で、無ければ **編集できない**（読むだけ。D5 の所有を持つ worktree・instance が無い）［見立て。§9 U3］
- route は `isScreenRequest` が偽なら 403 `screen_only`（`settings-service.ts:37` と同じ）。判定は G の service の中でも行う（E T23 の (4) と同じく route だけに置かない）
- CLI に口を作らない（§7.3 のガード）
- 実装（G-PR1）の形［事実］：入口は `memWriteFromScreen(db, request, worktreeId, { op, author, itemId?, body, pin?, fence? }, deps)`。印の判定のために要求（`request`）を引数に取り、`author`・`pin`・`fence` は要求の本文でなく呼び手が渡す（route は `author:'human'` を固定し、`pin`・`fence` を渡さない）。409 の理由の語 `incarnation_changed`・`membership_changed`・`confirmation_required`・`fenced` は A の `MemErrorCode`（`src/types/mem.ts`、契約の範囲の外）に足さず、service の `MEM_SCREEN_REFUSALS` に置いた（CLI の終了コードの表に載らない＝CLI からは来ない）。`add` は人のとき `expectBranch` と `key` が必須（無ければ 400）。`now` の項目の `update`・`close` も 400（`kind`）。H14(c)（`null → lazy`）は `update`・`close` で通る。`add` は A の `createMemItem` の `settleActorIncarnation` が、読んだ時点で無かった世代の発行を断る（A の規則のまま、G は変えない）

### 2.4 同時編集の競合と古い差分

- 画面は一覧を読んだときの `version` を持ち、`PATCH`・`close` に送る。409 を受けたら、**自分の下書き・読んだときの値・今の値** の 3 つを並べ（差分の表示）、「今の値に自分の下書きを載せ直して保存」（新しい `ifVersion` で送り直す。人が押したときだけ）か「下書きを捨てる」を選ばせる。自動で載せ直さない
- 古い差分：一覧を開いたまま時間が経った画面（別のセッション・条件の close で `closed` になった項目）は、書いた時点の 409（`version_conflict` か `state_forbids`）で知る。加えて、画面がフォーカスを取り戻したとき・30 秒ごと（画面の側の再読込。サーバに見張りを足さない）に一覧を読み直し、版が進んだ行に「更新されました」の印を付ける
- PC とスマホで同じ項目を開いたときも同じ規則（同じ API・同じ版）

#### 2.4.1 画面の入口ごとの規則（G-PR1 の 5-2b の処置、端でなく規則で塞ぐ）［事実：`MemItemsPanel.tsx`・`transitions.ts` の `memScreenActions`］

画面は次の 5 つの規則を、書き込みの入口すべてで守る。規則を変えるときは、この表の行を全部見る。試験は `tests/unit/components/mem/MemItemsPanel-screen-rules-4227.test.tsx`（規則ごとの describe。8ccd61971 の画面ではそれぞれ落ちる）。

| 規則 | 追加（`add`） | 編集（`update`） | close（`open`・`promoted`） | 記録済みの決定の close（`withdraw-recorded`） |
|---|---|---|---|---|
| (1) 読んだ時点の版と全欄の値を保つ | 読む値は無い（入力だけ） | 編集を開いた時点の `version`・本文・根拠・条件の種類を `EditDraft.read` に保つ。開いている間の再読込みで差し替えない | 「閉じる」を開いた時点の項目を `Closing.read` に保つ | 同左（段の判断も `read` の状態で行う） |
| (2) 送るのは人が変えた欄だけ | 書いた欄だけ（空の欄は送らない） | `editChanges`：本文は読んだ値と違えば、根拠は読んだ配列と違えば（全部消したら `evidence: []`）、条件は書いたときだけ（空は「今のまま」）。何も変えていなければ `ifVersion` だけを送る（版の照合だけの保存） | 理由（書いたときだけ） | 理由＋`confirmUnreflected: true` |
| (3) 版は読んだ時点のもの。競合は比較と明示の再確認へ | 版は無い。`expectBranch` は画面のブランチ | `ifVersion = read.version`。409 は下書き・読んだ値・今の値を本文と根拠ごとに並べ、載せ直しで送る欄も示す。「載せ直して保存」を押したときだけ今の版で送る（送る欄は (2) のまま） | `ifVersion = read.version`。409 は読んだ値と今の値（状態・本文）を並べ、「今の値を見たうえで閉じ直す」で今の項目を `read` にして確認からやり直す | 同左。やり直しは 2 段の確認の 1 段目から |
| (4) 結果が不明（timeout・接続断、status 0）なら同じ要求を送り直す | 要求の内容と `key` を `pending` に保ち、入力を固定し「同じ内容で送り直す」。store は同じ `key` に同じ項目を返す（2 件にならない）。確定した拒否（4xx）は不明ではない（次は新しい `key`） | 同じ本文・同じ `ifVersion` を送り直す | 同じ要求を送り直す | 同左（`confirmUnreflected` も同じ） |
| (4a) 結果が不明な要求は変えない単位で持つ（宛先も単位の一部） | 単位＝`{op:'add', worktreeId, input}`（instance・全欄・`key`・`expectBranch` は `input`）。`pendings['add']` に 1 つ。送り直しは単位の宛先へ単位をそのまま送る（今の選択・入力欄から作り直さない）。作業木か instance の選択が単位と違えば送れない（ボタンを無効にし「その宛先に戻す／送り直さずにやめる」を出す） | 単位＝`{op:'update', worktreeId, itemId, input}`（`ifVersion`・送った欄）。`pendings['update:<id>']`。宛先が違えば同じく送れない | 単位＝`{op:'close', …}`。`pendings['close:<id>']`。同上 | 同左 |
| (4b) 別の操作の完了で、ほかの単位を消さない | 答え（成功・確定した拒否）はその単位だけを消す。別項目の保存・close の完了では `add` の単位は残る（(4e) の後は、単位がある間に別の書き込みは始まらない。単位の前から開いていた別項目の下書きも保存できない） | 同左。単位の表示の「送り直さずにやめる」で、その項目の `update` の単位だけを捨てる（人の明示。単位がある間は行の「編集」を出さない。§11.10） | 同左。「送り直さずにやめる」で、その項目の `close` の単位だけを捨てる | 同左 |
| (4c) 通ったと言えるのはサーバーが同じ key の成立を返したときだけ | 既存の `key` の冪等（`replayed`）で判定する | key が無いので、送り直しの 409 は欄を比べて「保存できた」と推し量らず、競合として比較と明示の再確認へ戻す | 同左（409 の今が `closed` でも閉じたとは言わない。比較を出し、閉じ直しは出ない。比較は一覧の行の中でなく単位の側に出すので、closed を除く既定の一覧から行が消えても見える。§11.9） | 同左 |
| (4d) 単位の表示は単位の外の状態を読まない（§11.10） | 単位は送り直しと表示に要るもの（宛先・`key`・送った全欄）を持つ。追加の入力欄（`adding`）は単位の表示に使わない | 単位に `draft`（読んだ値・表示した下書き）も持つ。送り直しの欄は単位の `draft` から描き、1 つしか持てない `edit` を読まない。行が一覧にあれば行の中、無ければ単位の側。比較（`conflicts`）は項目ごとに持ち、別の項目の編集・close を開いても・保存しても消えない（同じ項目の編集・close を開くとその項目の比較だけを閉じる）。答えで閉じる下書きもその項目のものだけ | 単位に `closing`（開いた時点の項目・理由）も持つ。`closing` を読まない。比較（`closeConflicts`）は項目ごと。以下同左 | 同左（送った単位は確認の段を過ぎているので、2 段目の表示のまま送り直す） |
| (4e) 結果が不明・送信中の単位がある間は、ほかに何も書かない（PM の規則、§11.11） | 単位（送信中の要求も含む）が 1 つでもある間、その単位の「送り直す／送り直さずにやめる」以外の書き込み（追加・編集・close・載せ直し・閉じ直す、行の「編集」「閉じる」を開くことも）は押せない。単位の入力欄（追加の欄）は読み取り専用で、単位の値（送信中は送った値）を出す。理由を `mem-items-write-locked` に出す（送信中／結果不明）。読み直し・作業木と instance の選択の変更は止めない（読むだけ）。単位の宛先と違う選択では送り直せない（(4a)）のは変えない。送る関数の側（`sendOne`）も、1 度に 1 本・ほかの単位がある間は送らない | 同左。編集の欄は単位の `draft`（送信中は送った下書き）で読み取り専用 | 同左。理由の欄は読み取り専用 | 同左 |
| (5) 出すボタンは遷移の表から | mode `on`・作業木・instance があるとき | `memScreenActions(kind,state).edit`（＝`memTransition(…,'update')`。記録済み・反映済みの決定には出さない） | `memScreenActions(…).close`。文言は遷移の理由で決める（`withdrawn` は「取り下げる」、`manual` は「close」。反映済みの決定は「close」） | `withdraw-recorded` のとき 2 段の確認 |

- **(4e) の単位は引き継ぎのダイアログと同じ store（G-PR3、§4.1.1 の「項目の画面の単位」）**：送信中・結果不明の単位は部品の state でなく `close-rule.ts` の store（送った作業木の id を鍵）にあり、再 mount・ページを離れて戻っても残る（ページの再読み込みでは消える）。消すのは答え（`settleMemItemsWrite`）と人の「送り直さずにやめる」（`dropMemItemsUnit`）だけ。lock は 2 つの画面が同じ store から読む（ダイアログの単位はパネルを、パネルの単位はダイアログの承認・捨てる・載せ替えを止める。描かれていなくても）。送る関数の側も、`sendOne` の照合に加えて store の `startMemItemsWrite` が断る
- 閉じる条件が必須の kind（`waiting`・`next`・`external`、A の `CLOSE_WHEN_DEFAULTS` が `null`）は、追加の欄に「必須」を出す。`close-when.ts` は `fs` を引くので画面は `CLOSE_WHEN_REQUIRED_KINDS` を持ち、試験で A の表と等しいことを固定する。拒否 `invalid_close_when` は `reason`（`required`・`kind_forbids_type`・書き方）ごとに具体の文言にする
- 390px：作業木・instance の選択欄は `min-w-0 max-w-full`、見出しのブランチ名は折り返す。e2e に実際の長さの名前で `document.documentElement.scrollWidth <= innerWidth` を測る行を足した

---

## 3. 開くとき（G-3）

### 3.1 3 行の preview

`GET /api/worktrees/:id/mem/start-preview?instance=<id>`（G-PR3 の実装で `mem/screen/` の外に置いた、§11.22 #2）は次を返す（読みだけ。境界も知らせも予約・消費しない）：

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
- **3 行を読んだ後に境界と対象を読み直す**（G-PR6、§11.22 #3）：3 行の読み（C の build、`derived` では A の list も）は await をまたぐので、その間に境界が開く・使われる・置き換わることがある。読み終えたら対象（mode・popup・`injectOnStart`）を解決し直し、その解決と同じ同期の区間（`withMemTarget` の callback の中。境界を読んだ後に await しない）で境界（id・`pending`）を読み直し、変わっていれば A の 3 行をどの id でも返さず 409 `boundary_changed` を返す（画面は取得の失敗として送らず、下書きを残して「もう一度」で読み直す）。境界が無くなった（使われた）だけなら有効な `show:false`。**preview の中で作り直さない**：C の build（要求の寿命の pin を作る呼び手）は 1 回だけで、繰り返しの中に置かない（#4224 の R5、`brief-call-chain-forms-4224`・`brief-retry-paths-4223` の表）
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
- **送る前に preview を新しく読んで待つ**（G-PR6、§11.22 #3）：作曲欄は slash でない通常の本文を送る直前に、その送信の対象（worktree・instance）と送信の試行を固定して preview を読み、答えを待つ（上限 2 秒。focus の 10 秒の抑制はこの読みに使わない）。手元のキャッシュは送るかどうかの根拠にしない。答えが `show:true` なら必ず選択を出し、その間は楽観送信・API の送信・下書きの消去をしない。mode の判定は画面に持たない（on・derived は同じ経路、サーバーの `show` だけが決める）。答えが `show:false`（`popup=0` の `attended:false` を含む）なら今どおり `auto` で送る。**読めない・2 秒を超えた・答えが無い（非 200）ときは送らない**：下書き（本文・画像）を残し、理由と「もう一度」を出す（利用者の選択を黙って飛ばさない）。`show:true` で 3 行だけ読めないときは今どおり選択を出す。読みの待ちの間の 2 回目の Enter・ボタンは同じ下書きの重ね押しとして送らない（待ち行列に積まない）。読みの間に対象が変わった・作曲欄が無くなった・下書き（本文、または画像の削除・差し替え・追加）が変わったら、その試行は捨てる（何も送らない）。読みの間に plan review が始まったら、待つ前と同じく送らずに下書きを残す（#3999 の注意）
- **既知の制約（G-PR6、codex P2-4）**：失敗した送信の再送（再送のボタン・通信が戻ったときの自動の再送、`usePendingMessages`）はこの門を通らず、前と同じく `auto` で送る。受入（段 10：画面の通常の送信）の外。直すなら再送も同じ門（送る前の読みと選択）を通す（#4289 で追跡）
- 背景の読み（focus・送信の後）・送る前の読み・409 の後の読みは **1 つの取得世代の規則** に従う：読みごとに番号を取り、採用済みより新しく、作曲欄が残っていて対象が同じときだけキャッシュに採る（409 の後の新しい境界を、遅れて届いた古い背景の読みが上書きしない）
- **選択は「見せた境界」に結ぶ**（`briefBoundary`）。照合は **2 回** 行う（第 3 版、再確認 P2）：route の入口（早く断るため。省いてもよい）と、**送信の直前の排他の区間**（D1 の `claim()` の `claimInStretch`、入力の排他 `withInstanceInputLock` の中で本文を打つ直前の同期の区間）。正は後者で、前者を通っても provider の作成・入力の排他の待ちの間の変化は後者で止まる。
  - **不変条件（最終の照合、pr3d・PM の決定）**：`full`・`decline` は、plan の結果（`STRICT_PLAN_OUTCOMES`：用意済み `planned`・消費済み `used_up`・空 `empty`・中止 `refused`。早期 return を含む全部。pr3f で `slash_command` は外した＝strict × slash は route の 400、サービスでは plan の中止 `slash_command`）に関係なく、**打鍵の直前の最終区間（入力の排他の中）で境界を必ず読み直す**。plan は見せた行 A を確定（skip・consumed）しない。確定は最終区間でだけ行う（plan が書くのは、選択と無関係な死んだ claim の回収 `settleStaleClaim`（`plan.stale-claim`、D1 の回収で A を `unknown` にする）と worktree の incarnation だけ。A の確定はしない。pr3e、PM Claude P3-3）。`claim()` は strict なら最初に下の 1 つの述語を通し、plan の結果ごとの分岐（網羅の `switch`）はその後に置くので、どの早期 return も最終の照合の前に来られない。strict の送信は中止以外の結果で入力の排他の下に入る（`needsOuterLock`。command-code も）。下の表の行と §11.22 の個別の記述はこの不変条件の場合分けで、試験は `session-brief-final-reading-4227.test.ts` の表（§11.22 #20・#22）。
  - **最終区間の照合は 1 つの述語（pr3e、PM の決定 `pm-return-4227-pr3d.md`）**：`SendBrief.finalReading(db, target)`。`claim()` の strict の節（`claimStrict`）が `withMemTarget` の同期の区間の中で、plan の結果（`planned`・`used_up`・`empty`）によらず最初に呼ぶ（`refused` は区間に入らず plan の理由で中止）。条件の一覧（ここが唯一の正。上から順に見て、最初に落ちた条件が 409 `boundary_changed` の `reason`。plan の中止があればその理由のまま＝最初の理由が勝つ）：
    1. **所属（worktree）**：入口で固定した worktree がまだ同じ（`briefWorktreeContinuity` が `same`）で、worktree の incarnation が plan の読んだもの → 違えば `worktree_changed`
    2. **設定**：所属が解決でき、mode・`injectOnStart`・所属（`membershipKey`：保存先・読み先・branch・detached・mode・`injectOnStart`）が plan の読んだもの → mode `off` は `off`、`injectOnStart` が切れたら `disabled`、それ以外は `settings_changed`
    3. **境界の同一性**：見せた行 A（`briefBoundary`）が instance の今の境界で、`superseded` でない → 違えば `superseded`
    4. **所属（instance）**：instance が入口で固定した寿命のままで、A がその寿命の行 → 違えば `incarnation_changed`
    5. **境界の状態**：plan が読んだまま（`pending` は `pending`、消費済みは消費済み）。別の送信の予約中（`claimed`）・待ちの間に別の送信に取られた → `claimed`、消費済みが `pending` に戻った → `superseded`

    plan は strict のどの結果でも（`refused` を除く）この述語が比べるもの（A の状態・`membershipKey`・worktree の incarnation）を読んでおく（`strictSeen`）。消費済みも plan で所属・設定を読む（mode `off`・`injectOnStart` が切れていれば plan の時点で中止）。**枝ごとの違いは、述語が通った後の commit の種別だけ**（下の S-B-commit）。照合の中身を枝の中に書かない。strict でない送信（`auto` の短い要約・`skip`・`force`・`never`）はこの述語を通らず、D1 のまま。
  - **不変条件 S-B-commit（pr3f、PM の処分 `pm-return-4227-pr3e.md`、原因 `pm-rootcause-4227-sb.md`）**：strict の `claim()` は「述語 → `commitStrict(kind)` → その戻り値の `text` だけを打つ」の一本道（`claimStrict` → `commitInFinalStretch` → `finalStretch` → `finalReading` → `commitStrict`）。
    - **戻り値は 1 つの値**（判別共用体 `StrictCommit`）：`{ type:'type', text }` か `{ type:'abort', reason }`。述語の結果も同じ形（`{ type:'pass', row }` か中止）。例外・null・undefined・形の違う値・書き込みの changes≠1・guard の withheld・予約の失敗はすべて中止（打鍵 0・A はそのまま）。中止の判定に横の旗を使わない（plan の中止は理由 `planAbort` として持ち、区間に入る前に中止に変える）。本文を既定にする `?? content` は無い。strict は D1 の fail-open の部品（`skip`・`skipped`・`claimInStretch`）を区間で通らない。形はガード `tests/unit/guards/session-brief-strict-commit-4227.test.ts` が固定する（`claimStrict` が本文を名指さない・`??` が無い、strict の関数が D1 の部品を呼ばない、catch はすべて中止を返す）。
    - **種別ごとの表** `STRICT_COMMIT_RULES`（`satisfies Record<StrictKind, …>`）：`brief`（`full`、予約 `claim.reserve` → `claim.row`、brief＋本文、配送の結果で settle）・`decline`（`claim.row`、本文、`skipped(declined)`）・`empty`（`claim.row`、本文、`skipped(empty)`）・`used_up`（書かない、本文、報告 `consumed`）。`claim.row` は incarnation の補完と `claimBoundary` を 1 つのトランザクションで行い、どちらかが行を変えなければ両方を戻して中止 `claim_failed`。予約が投げれば `claim_failed`、予約が何も返さない・入らなければ `reservation_conflict`（provider が答えた後は、claim できなければ `discarded` で知らせる。投げたときは知らせない）。表の列は `writes`・`typed`・`claims`（行を claim するか。`used_up` だけ false）の 3 つ。**settle の仕方は表に持たない**（pr3g、PM Claude P3-3）：打った後の決着は plan の `Plan.skipAs`（`null`・`declined`・`empty`）だけが決める唯一の真実で、表に同じ値の列を置くと読まれない二重の真実になるので消した。表 2 には M06（`claim.row` の補完が claim と同じトランザクションで戻る）・M10（予約の後に claim できなければ provider へ `discarded`）・N3（戻しが行を変えなければ claim を保持＝`claim_held`）の行を足した（pr3g、PM Claude P3-4）。
    - **打つ前に A を消費しない**：`decline` と `empty` も「`claimed` にする → 打つ → `sent`・`unknown` で `skipped(<理由>)`、`not_sent` で `pending` に戻す」（PM 決定 2。`auto` の `empty` は D1 のまま plan で消費する）。
    - **戻しの失敗（二重の失敗、PM 決定 3）**：`not_sent` で `pending` に戻す書き込みが失敗した（投げた・行を変えなかった）ら、token を `liveClaims` に残す。同じプロセスの次の strict の送信は plan で 409 `claimed`（打っていない A が黙って消費済みにならない）。報告は `{ state:'not_sent', reason:'claim_held' }`。**残るリスク**：サーバーの再起動の後は、次の要求の plan が死んだ claim の回収（`settleStaleClaim`）で A を `unknown`（消費済み）にする。**聞き直しにはならない**（pr3g、codex P3）：preview は `pending` の行でしか開かないので選択の画面は出ず、次の `full`・`decline` は used_up として本文だけを打ち、報告は `consumed`（画面は「この区切りの引き継ぎは使い済みでした（別の送信で渡されたか、サーバーの再起動の前に結果の分からない送信がありました）。本文だけを送りました。」）。要約は届かないまま（引き継ぎの取りこぼし）で、これを残るリスクとして受け入れる。`auto` の送信は生きている claim の行を plan し、`claimBoundary` に負けて本文だけになる（D1 のまま）。
    - **報告は commit・settle の結果からだけ作る**：`consumed` は commit、`attached`・`skipped(<理由>)`・`not_sent`・`claim_held` は settle。
    - **狭めて塞ぐ（PM 決定 5）**：画面が送らない組み合わせは route の引数の検査で 400、何も解決・送信しない：strict × slash の本文（`brief 'decline' and briefDetail 'full' are not for a slash command`）・strict × 境界を持たない tool（`… are only for a tool with session boundaries`、`BOUNDARY_TOOLS` の外）。サービスでも strict × slash は plan の中止 `slash_command`（何も書かない）。送信のサービスの型（`sendUserMessage<P>` の `StrictBriefNamesBoundary<P>`）は、型が strict を名指す呼び出しに `briefBoundary` を要る。`briefBoundary` × `auto` の短い要約は**塞がない**：画面が「短い要約を読む」で送る（下の表の 1 行目、`MessageInput` の試験が固定）ので 400 にすると画面の選択が壊れる。受け取って使わない（害は無い）。
  境界の状態ごとの扱い：

  | 送信の直前の区間での今の境界 | `auto`（短い要約） | `full`・`decline` |
  |---|---|---|
  | `briefBoundary` の行が今の境界（最大の `seq`）で `pending` | 今どおり | 選んだとおり（`full` は付ける、`decline` は下の予約） |
  | 別の行が今の境界（reset・再起動で A → B） | 今どおり（B に付くか D1 の理由で付かない） | **送信を断る**：409 `boundary_changed`（`reason:'superseded'`）。B を消費・付与せず、**本文も打たない** |
  | `briefBoundary` の行が `claimed`（別の送信が予約中。消費ではない） | 今どおり | 409 `boundary_changed`（`reason:'claimed'`）。予約した送信が失敗すれば行は `pending` に戻る（`settleBoundaryClaim(…,'not_sent')`）ので「消費済み」と扱わない |
  | `briefBoundary` の行が `sent`・`skipped`・`unknown`（消費済み） | 今どおり | 本文だけを送る（D1 §3.4 の 3）。応答の `brief.state='consumed'` で「既に別の送信で引き継ぎが渡されました」。判定は上の 1 つの述語で行う（plan の消費済みは確定ではない。A → B は上の行。待ちの間の mode・`injectOnStart`・所属の変化も述語の 2 で 409）。区間で `claimBoundary` が別の送信に先を越された（plan では `pending`、区間では消費済み）ときは安全側で 409 `claimed`（§11.22 #15） |
  | 所属・mode・`injectOnStart`・寿命が変わった（D1 の `settings_changed`・`incarnation_changed`）、provider の失敗・`over_limit`・予約の衝突（`reservation_conflict`）、区間の例外 | 今どおり（本文だけ。D1 の動きを変えない） | 409 `boundary_changed`（`reason` に D1 の語、例外は `claim_failed`）。本文を打たない。`full` の `empty`（付けるものが無い）だけは本文だけを送り、報告 `empty`（A は最終区間で上の 1 つの述語が通ったときに `claimed` にし、本文が入った（`sent`・`unknown`）ら `skipped(empty)`、入らなければ `pending` に戻す。pr3f。待ちの間に別の送信に取られていれば 409 `claimed`、mode・`injectOnStart`・所属が変わっていれば 409。消費済みも同じ述語を通る） |

  - **409 の伝播**：`claim()` は `full`・`decline` のときだけ、本文の代わりに「中止」（`{ abort: reason }`）を返し、`sendUserMessage` はキーを 1 つも送らずに型つきの誤り（`BriefChoiceAbortedError`）を投げる。送信の route はそれを 409 `{ error:'boundary_changed', reason, boundary: { id, state } | null }` にする（`sendUserMessage` の呼び出し元は変えない＝`CALLERS` の表は変わらない）。`auto`・`skip`・`force` は `claim()` の戻りが今と同じ（本文だけか brief つき）
  - **`full` の失敗の経路を送信のサービスまで通す**（第 4 版、3 回目 P2）［事実：今の plan は provider の失敗・`over_limit` で `skip(rowId, …)` を書いて本文だけに倒し（`session-brief.ts:314-327`）、`claim()` は区間の例外を握って本文だけを返し（`session-brief.ts:347-360`）、`sendUserMessage` は配送の例外を `classifySendFailure` で普通の送信の失敗（`stage:'send'`）に変える（`send-user-message.ts:702-728`）］。そのままでは `full` の失敗が 409 にならないか、本文だけが打たれるので、G-PR3 で次を足す：(1) plan（`session-brief.ts`）は `full` のとき provider の失敗・`over_limit`（予算・行の上限・`withinVerifiedSize`）で **`skip` を書かず**（境界は `pending` のまま、消費しない）中止の理由（`provider_failed`・`over_limit`）を持ち、`claim()` は区間に入らずに中止を返す。(2) 区間の例外（`withMemTarget` の throw）は `full`・`decline` では中止 `claim_failed`。区間で既に `claimed` にしていたら `settleBoundaryClaim(…,'not_sent')` で `pending` に戻す（誤って消費しない）。(3) `send-user-message.ts` は `BriefChoiceAbortedError` を `classifySendFailure` に渡さず、`{ ok:false, stage:'brief_choice', code:'boundary_changed', reason, boundary }` で返す（打鍵の前なので送信の試み（`recordSendAttempt`）は記録しない＝`settle` を呼ばない。境界は中止の時点のまま、区間で予約した後なら `not_sent` で `pending` に戻す。relay の保留・`prompt_waiting` の分岐より前。pr3c で §11.22 #7 の実装の事実に合わせて書き直した）。**中止の判定は型（`instanceof BriefChoiceAbortedError`、`claim()` が投げた値そのもの）だけで行い、メッセージの文面では読まない**（第 6 版、5 回目 P2(1) の規則）：既存の分類は tmux の例外が利用者の本文を引用するので、配送不明の文面を「未送信」の文面より先に照合する［事実：`send-attempt-state.ts` の `classifySendFailure` の #3880 の注と `TMUX_TRANSPORT_FAILURE` の行］。中止は打鍵の前に `claim()` が投げ、配送の例外とは経路が別なので、本文に中止の文面が入っていて tmux の送信が失敗しても、その例外は中止の型ではなく、今どおり `classifySendFailure` で `indeterminate`（`send-error`）になる。`classifySendFailure` に中止の文面の行を足さない（code・`cause` の判定と文面の代替の判定を混ぜない）。送信の route はこの `stage` だけを 409 にする。(4) `auto` は (1)(2) の失敗でも今どおり本文だけ（D1 の `skip` の記録も今どおり）
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
           今の境界（会話の寿命の鍵、§0.1 G6）・在籍の寿命・所属（repository・branch）を固定する。
           境界が無ければ 409 session_unknown → ダイアログに「引き継ぎの依頼を作れません」と出し、
           選べるのは「停止」（下の ⑥ と同じ既存の停止。依頼が無いので記録なし）と「やめる」だけ
      ② 画面が依頼の文を既存の送信の route で送る（brief:'skip'）
           失敗 → request_failed（§4.4）
      ③ Agent が提案を出す（commandmate handoff propose …）→ 終わったら handoff done
           期限（5 分）までに done が無い → agent_timeout（§4.4）
      ④ 画面が提案を差分で見せる（提案ごとに 承認／捨てる）
           ＋「提案を経ずに確定した更新」（G2）を別の欄に出す（読むだけ）
      ⑤ 「確定する」：承認した提案だけを、版を照合して 1 件ずつ確定
           版の食い違い → conflict（§4.5）。失敗 → failed
      ⑥ 「停止する」を人が押す。押下の handler の中でだけ、次の 3 つを順に行う：
           (a) POST …/end（停止の宣言。G は kill しない：依頼を ending にし、確定の途中なら止める）
           (b) 既存の停止（handleKillConfirm → worktreeApi.killSession → kill-session の route、変えない）
           (c) POST …/end/observe（G は kill せず、止まったことを観測して記録、§4.6）
  どの段でも：「終了をやめる」（取り消し）・「今すぐ停止」（強制終了 = ⑥ を end の force で）
  G はサーバから kill しない。期限・取り消し・古い依頼から kill に届く経路は無い（§4.6.1・§7.3）
```

#### 4.1.1 ダイアログの閉じ方の規則（G-PR2 の pr2c で入れ、pr2d で全経路の規則にし、pr2e で単位を store へ移し、pr2f で await の後の続きに単位と開いた回を持たせた。PM の決定 `pm-return-4227-pr2c-codex.md`・`pm-review-4227-pr2d-claude.md` の処分・`pm-return-4227-pr2e-codex.md` の末尾）

**不変条件**：確定の送信中・結果不明の単位は、ダイアログを消すどの経路でも、人の選択（「同じ内容で送り直す」／「送り直さずにやめる」）なしに消えない。ダイアログが描き直されても（PC ↔ スマホ・向き・幅・ページの Loading・再 mount）消えない。単位がある間はダイアログを閉じない。取り消しを始めた後は新しい確定も引き継ぎの text も送らない。

**規則は 1 つの関数、単位は 1 つの store**：`src/lib/handoff/close-rule.ts` の `handoffCloseBlock`（持つもの → 閉じられない理由）と、全経路が経路の名前を付けて呼ぶ `askHandoffClose(path)`（閉じてよければ開いた回を閉じる `closeHandoffOpening(token, path)`。pr2f から開いた回の token を名指す）。pr2e から、単位（送信中 `inflight`・結果不明 `pending`・停止中 `stopping`・取り消し待ち `cancelling`）は**同じ module の store に worktree の id を鍵にして**持ち、開いた回（依頼の view・text・plain の理由・`created`・`closed`）も store に持つ。ダイアログは `useSyncExternalStore` で読むだけで、部品の state に持つのは人の選択と通知だけ。ページ（`useWorktreeDetailController.ts`）も同じ store を `askHandoffClose` 越しに読むので、ダイアログが描かれていない瞬間（Loading）にも規則が単位を守る。どちらにも規則の写しは無い。
- 描き直し：新しい instance は store の開いた回（閉じておらず同じ instance 宛て）を見つけて続ける。`create` は開いた回ごとに 1 回（`created`）で、その応答は部品でなく開いた回に書かれる（描き直しの間に返っても落ちない）。ページの「終了」は `openHandoff` で新しい開いた回を始める（単位には触れない）。
- 単位を消すのは store の 2 つの関数だけ：`settleHandoffDecide`（確定の応答）と `dropHandoffUnit`（人の「やめる」）。停止・取り消しの旗は `endHandoffStop`／`endHandoffCancel`（その操作の終わり）。ガードは呼び出しの名前でなく、これらの識別子の参照（別名・prop 渡し・直接の書き込みを含む）を数える。
- **await の後の続き（pr2f、型で強制）**：確定の settle（`finally` を含む）・閉じる（取り消しの応答・plain の停止の後）・開いた回への書き込み（create の応答・読み直し）・隠したときの close は、**開始時の送信単位と開いた回を必ず持ち、今のものと一致しなければ何もしない**。送信単位は `startHandoffDecide` だけが作る `SentHandoffDecide`（送るたびに新しい identity。結果不明の送り直しも新しい単位）で、`settleHandoffDecide(sending, …)`・`dropHandoffUnit(unit)` はそれを名指す。開いた回は `beginHandoffOpening` だけが作る `HandoffOpeningToken` で、`closeHandoffOpening(token, path)`（一致しなければ `stale` を返し規則も聞かない）・`noteHandoffHidden(token)`・`patchHandoffOpening(token, …)` はそれを名指す。どちらも brand 型なので、単位・token を持たない settle/close/patch は store の API に無く、呼べない（`tsc`）。ダイアログの `closeBy(of, path)` は `closed`／`refused`／`stale` を返し、`stale` なら `onClose` も読み直しもしない。ページの `closeHandoffBy` は自分が始めた開いた回の token で閉じ、`stale`（ほかの開いた回が始まった）なら自分の target だけを外す。停止・取り消しの旗（`endHandoffStop`／`endHandoffCancel`）は作業木の id が単位の id（開始は旗が立っている間は拒まれるので、終わりは必ず自分の開始のもの）。codex review-4227-pr2d P2-1（先の確定の `finally` が次の送信単位を結果不明にする）・P2-2（古い取り消し・plain の停止の完了が新しい開いた回を閉じる）・PM Claude pr2e P3-1（create の応答の token 照合に対照が無い）をこの規則で消した。
- **import の形（pr2f、解決でなく禁止）**：`close-rule` の関数は名前つき import だけを許す。`src/` で別名（`import { dropHandoffUnit as forget }`・`export { … as … } from`）・名前空間（`import * as`・`export * as`）・`export *`・default import・動的 `import()`・`require()` で store を読むと、指定子（`@/lib/handoff/close-rule`・相対パス）によらずガードが落とす。store の外で `SentHandoffDecide`／`HandoffOpeningToken` へ cast することも落とす。
- **書き手の受け渡しの禁止（pr2g、codex review-4227-pr2e P2・PM Claude pr2f P3-3）**：store の書き手（開始・settle・drop・close・hide・patch・旗の終わり・`resetHandoffStoreForTests`。ガードの `STORE_WRITERS`）は、import した所で呼ぶだけにする。`src/` の store 以外で、書き手の re-export（同名・別名・`export { x }` のローカル再 export、store からでも別の module からでも）・`export default`／`export =`・**どの module からでも**別名での import・呼び出し以外の参照（値・object の property・引数として渡す）を落とす。橋渡しのファイル（`export { dropHandoffUnit } from './close-rule'`）とその利用側（`import { dropHandoffUnit as forget } from './bridge'`）は両方とも落ち、二段の再 export は最初の段で切れる。`import()`／`require()` の指定子は文字列だけを許し、置換の無いテンプレートリテラルは文字列として store を名指すかを見て、置換のあるテンプレート・計算された指定子は落とす（pr2g の例外「固定の頭が store の上にないディレクトリ」は pr2h で `src/i18n.ts` の 1 形に絞った。次の「ガードの不変条件」）。
- **ガードの不変条件（pr2h、PM の決定 `pm-return-4227-pr2g.md`。禁止の列挙をやめ、許可する形だけを通す）**：`src/` の `.ts`／`.tsx` の全ファイルについて、store（`src/lib/handoff/close-rule.ts`）の書き手（ガードの `STORE_WRITERS`）に値として届く経路は、**許可リストのファイル（`STORE_IMPORTERS`：`src/components/mem/SessionHandoffDialog.tsx`・`src/hooks/useWorktreeDetailController.ts`。pr2h で入れた `src/components/worktree/WorktreeDetailDesktop.tsx` は型だけの読者なので pr2i で外した）からの、文字列リテラルの静的 import で、その記号を呼び出す形だけ**。許可リストの外のファイルは store から値を何も取らない（名前つき・default・名前空間・副作用の import、re-export・`export *`）ので、ラッパー・橋渡し・別名・値渡しは書き方によらず落ちる。指定子は綴りでなく解決後のパス（TypeScript の module 解決。`@/`・相対・エスケープ・拡張子・戻る `..`）で store かどうかを決め、文字列での前置きの絞り込みはせず全ファイルを AST で読む。`import()`／`require()`（と `createRequire` が作った loader）の指定子は置換の無い文字列だけ。例外は `src/i18n.ts` の実際の 1 形 `../locales/${識別子}/<固定名>.json`（置換は識別子 1 つ・置換の後ろに `..` も `/` の段も無い）で、そのファイルに限る。`require` を呼び出し以外で参照する形（`const r = require`）も落とす。型だけの参照（`import type`・`{ type x }`・`export type`・`typeof`）は実行時に何も渡さないので通す。許可リストに足すのは、そのファイルが store を読む理由を設計に書いてから。許可リストのファイルの中で書き手を呼ぶラッパーを export する形（ページの hook の `closeHandoffBy` と同じ形）はガードで区別できないので、許可リストのファイルの変更はレビューで見る（PM Claude pr2h P3-2、記録）。
- **ガードの最終形：名前と場所を表で固定する（pr2i、PM の決定 `pm-return-4227-pr2h.md`）**：抜けが 5 回続いたので、意味（loader の基準・引数・データの流れ）を追わず、次の表で名前と場所を固定する。表は今の実ソースの一覧で、実ソースが表と一致することもガードが確かめる（名前の残りも落ちる）。
  - **store の export の表面（`STORE_EXPORTS`）**：`close-rule.ts` が export してよい値の名前と、その値が書き手か否か（書き手の行は `STORE_WRITERS` と一致）。値は宣言（`export function`／`export const`）でだけ export し、表に無い値の export・`export { … }`（別名でも同名でも）・`export default`／`export =` は落ちる。**store の中で書き手の名前を参照してよいのは宣言だけ**（pr2j、PM Claude pr2i P2-1）：書き手を値に持つ object・配列、書き手を呼ぶラッパー関数（表の読み手の名前でも）に加え、表の書き手の中での**書き手の名前の**呼び出しも落ちる（`return { ...opening, close: (p) => closeHandoffOpening(opening.token, p) }` のような、書き手の名前を呼ぶ閉じる関数つきの handle や state の関数）。落ちるのはこの名前の形だけで、store の内部の書き込み関数（`markClosed`・`commit`・`writeFlags` 等）を呼ぶ無名関数や、それらを値として返す・state に入れる形は落ちない（下の「保証の範囲」。pr2k）。実ソースの store に書き手→書き手の呼び出しは無い（0 件）ので、その形を固定する表は置かない。表の所属は自前のプロパティ（`Object.hasOwn`、または `Set`）で判定し、`in` は使わない（pr2j、codex review-4227-pr2h P2-1：`export const toString = …` が継承名で表に「ある」ことになっていた。`STORE_EXPORTS`・`STORE_WRITERS`・`STORE_REEXPORTS`・`NODE_MODULE_IMPORTERS` の全部）。
  - **store の re-export（`STORE_REEXPORTS`）**：store の値を re-export してよいのは `SessionHandoffDialog.tsx` の `handoffCloseBlock`（同名）だけ。`export { … } from` の store・`export *`・import した値の `export { x }`／`export default x` を数え、表に無い名前・別名・別のファイルは落ちる。
  - **`createRequire` はファイルで固定（`NODE_MODULE_IMPORTERS`）**：`module`／`node:module` から値を取ってよいのは `src/cli/utils/qr-terminal.ts` の `import { createRequire } from 'node:module'`（別名なし）の 1 形だけ。それ以外のファイルの `module`・`node:module` からの値の import（名前つき・別名・default・名前空間・副作用）・re-export・`require()`／`import()`・`import = require()` は、名前・形を問わず落ちる。loader の基準（`new URL(…, import.meta.url)` 等）と引数は追わない。値を取るかは store 側と同じ関数で**指定子ごとの `type`** を見る（pr2j、codex review-4227-pr2h P2-2）：`import { type Module } from 'node:module'`・`export { type Module } from 'node:module'` は値を取らないので通り、表との一致にも数えない。`type` と値の指定子が混ざれば値として落ちる。
  - **書き手の参照は呼び出しの callee だけ**：依存配列・引数・JSX 属性を含め、callee 以外の位置の書き手の識別子は除外なしで落ちる（pr2h まであった `useCallback`／`useEffect`／`useMemo` の名前による依存配列の除外は、書き手には掛けない。`onClose`・`setHandoffTarget` の検査では今もその除外を使う）。
  - **読者は値の import だけ数える**：type-only の import／export と `typeof` は読者にも到達にも数えない。ただし `createRequire` の loader の検査（ガードの `checkCreatedRequires` の 2 つの走査）は型の位置を除かず、`import type { createRequire } from 'node:module'` と `typeof createRequire`、`qr-terminal.ts` での `typeof` の loader の参照を値と数えて落とす。これは過剰な禁止（正当なコードを足すとガードが赤で知らせる安全側の誤り）で既知、#4289 で追跡する（pr2k、codex review-4227-pr2i P2）。
  - **保証の範囲（pr2k、PM の判断 `pm-return-4227-pr2j.md`）**：ガードが保証するのは、**store の外のファイルから store の書き手へ値で届かないこと**（上の export の表面・re-export の表・`node:module` のファイル・書き手の参照は callee だけ・読者は値の import だけ）。**store のファイル（`close-rule.ts`）の中は信頼境界**で、store の中で書き手や内部の書き込み関数（`markClosed`・`commit`・`writeFlags` 等）を値として返す・handle や state に入れる形（例：`beginHandoffOpening` が `close: (p) => { … markClosed(opening.token) }` や `close: markClosed` つきの handle を返す、state に `commit` を呼ぶ関数を入れる）はガードの範囲外。store の中で落ちるのは、書き手の名前を宣言以外で参照する形（pr2j）だけ。store の中身の変更は PR レビューで見る（PM Claude pr2j P2-1 は P3、#4289 で追跡）。
  - **保証の範囲外**：`src/` の外・`.js` 等（`src/` に 0 件）・`eval`／`new Function`／`module.require`／`globalThis.require` のような文字列や property 越しの loader・ビルド設定（tsconfig の `paths`・webpack の alias）の改変・`process.getBuiltinModule`（`process.getBuiltinModule('node:module').createRequire` のような property 越しの組み込みの取得。pr2j、PM Claude pr2i P3-2）・意図して隠す書き方（組み込みの別名の連鎖、React の hook 名を装った自作関数で表をすでに通っているもの、文字列の計算での指定子の組み立て等）・許可したファイルの中の loader の基準・store のファイルの中で書き手や内部の書き込み関数を値として外へ出す形（上の「保証の範囲」）。これらは #4289 に記録する側（P3）。
- **ページの `stale` の枝（pr2g、PM Claude pr2f P3-2）**：ほかのページ（PC の分割とスマホ、同じ store の別の描画）が開いた回を始めた後にページの `closeHandoffBy` が呼ばれると `stale` になり、自分の target だけを外し、ほかの開いた回（閉じない）と作業木の単位（送信中のまま）に触れない。`useWorktreeDetailController-handoff-stale-4227.test.tsx` が、ダイアログの close と作業木の切り替えの 2 経路で固定する（`stale` で target を残す向きに変えると 2 件赤）。
- **store の今の token・単位を読む API（pr2g では入れない、#4289 で追跡、PM Claude pr2f P3-1）**：snapshot（`handoffStoreSnapshot`）と `handoffUnitsOf`・`liveHandoffOpeningFor` は今の開いた回の token と送信単位を返す。読み取り専用の view にする案は入れなかった。理由：(1) 描き直し（PC ↔ スマホ・Loading の後）のダイアログは開いた回を自分で始めていないので、続きに渡す token を store から受け取るほかない（受け取る関数が「今の token を返す API」になる）。(2) 結果不明の単位の「やめる」と送り直しは、人が押した時点で表示している単位そのものを名指す必要があり、store から単位を受け取る。(3) どちらも、ダイアログの読み取り（view・開いた回の再開・表示中の単位への操作）を store 側の API に作り替える大きな src の変更になり、表のテストの `rule.tokenless`（今の値を読んで渡す変異）も作り替えが要る。今は、await の後に今の値を読んで渡す形（PM Claude の B1・B2）は表のテストが赤で捕まえる。
- plain の停止は既存の停止の結果（`SessionStopResult`：`stopped`・`refused`・`failed`・`unknown`）を受け、`stopped` のときだけ「停止しました」にする。それ以外は理由を出して停止ボタンを残し、同じ画面から押し直せる（codex pr2c P2-2）。

| 持つもの | 判定 | 理由 |
|---|---|---|
| 停止の途中（`end` の応答待ち → 既存の停止 → `end/observe`） | `stopping` | 既存の確認と同じ（停止の要求中の取り消しは無視、Issue #1171）。`end` の応答の後に閉じられていたら既存の停止へ進まない |
| 確定の送信中、または結果不明（この作業木のものも、ほかの作業木のものも） | `unknown` | 人が選ぶまで持つ（G-PR1 の規則）。送信中のものは結果不明で返りうるので同じに扱う |
| 取り消しの応答待ち | `cancelling` | 応答で閉じる。その間に別の閉じ方を受けず、確定・停止・延長・載せ替え・引き継ぎの text（送り直し・開いた直後の create → text）を送らない（store の `startHandoffDecide`・`startHandoffStop`・`handoffTextSendable` と、`simpleWrite`・`stop` の照合。ボタンも無効） |
| 無し | 閉じる | — |

**経路**（`HANDOFF_CLOSE_PATHS`。ガード `tests/unit/guards/handoff-close-paths-4227.test.ts` が、ダイアログの `onClose` の参照が `closeBy` の呼び出し 1 か所だけ（別名・prop 渡しも落ちる）・ページの `setHandoffTarget` の参照が `closeHandoffBy`（null）と `openHandoff` だけ（別名も落ちる）・どちらも `closeHandoffOpening` で規則を聞く・`openHandoff` の前に `closeHandoffBy('page-end')`・単位を消す識別子（`dropHandoffUnit` は「やめる」、`settleHandoffDecide` は `decide`、`endHandoffStop`／`endHandoffCancel` はその操作）の参照が許した所だけ・部品の旧い写し（`setPending`・`pendingRef`・`keepPending`）の参照が無い・store の中で `pending`／`inflight` を書くのは 3 関数だけ・`src/` のほかのファイルが単位を消さない・`src/` で store を別名・名前空間・`export *`・動的 import で読まない（pr2f）・store の settle／drop／close／hide／patch の第 1 引数が送信単位・開いた回の型で、ほかに store を書く export 関数が無い（pr2f）・呼び出しの経路名と宣言が一致、を確かめる。新しい経路を足して規則を通さないと落ちる）：

| 経路 | どこ | 拒まれたとき |
|---|---|---|
| `person`：Esc・×・背景・「終了をやめる」・「閉じる」・「やめる」（plain） | ダイアログの `requestClose`／`closeBy` | 閉じず・取り消さず、理由を出す |
| `cancel-answer`：取り消しの応答 | `requestClose` の await の後 | 閉じない（取り消しの後は確定を送らないので、通常は起きない） |
| `plain-stop-done`：plain の停止が終わった後 | `plainStop` | 閉じず、「停止しました。選んでから閉じて」を出し、単位の欄を残す（codex pr2b P2 2） |
| `worktree-switch`：作業木の切り替え（同じページのまま `worktreeId` が変わったときだけ。作り直したページ・StrictMode の 2 回目では聞かない、§11.22 #17） | hook の `[worktreeId]` の effect | ダイアログは残り、**ほかの作業木の画面のもの**（`foreign`）として出す：依頼は元の作業木のまま、新しい依頼を作らず、停止・確定・延長・載せ替えは出さない（ページの停止はその作業木のため）。単位は「やめる」だけ押せる。元の作業木に戻ると送り直せる（A→B→A。codex pr2b P2 3・PM Claude pr2c P3-1） |
| `page-end`：ページの別の「終了」 | hook の `openEnd` | 何も開かない（引き継ぎを差し替えず、plain の確認も出さない）。ダイアログに理由を出す。kill の要求中は引き継ぎを開かない（PM Claude pr2c P3-2 (b)） |
| `dialog`：ダイアログが聞いた後に閉じる | hook の `closeHandoff` | ダイアログが既に聞いた後なので拒まれない（ページ側でもう一度聞く） |

- 単位がある間も、この作業木の画面ではダイアログから既存の停止を押せる（閉じ込めない）。ほかの作業木の単位は表示し「送り直さずにやめる」だけ押せる（送り直しは無効、`handoff-pending-elsewhere`）。開き直しで単位を消さない。
- 単位の寿命は store（pr2e）。ダイアログ部品の寿命と切り離したので、PC ↔ スマホの切り替え（`isMobile` の枝で別の位置に描かれ instance が替わる）・ページの Loading（作業木の切り替えで詳細を読み直す間、ダイアログが外れる。codex pr2c P2-1）・再 mount でも残り、`create` を繰り返さない。ページの再読み込みでは消える（module の store も消える）。ほかの作業木の単位が残っているときは、その作業木で引き継ぎを開くと出る。項目の画面の lock は描かれているダイアログが出す（Loading の間は外れるが、その間は項目の画面も外れている）。**G-PR3 で MemItemsPanel の単位も同じ store に載せた**（次の bullet）。
- **ページが作り直されたときの開いた回の取り戻し（G10、G-PR1+G-PR2 の審判の UAT の差し戻し）**：
  - **単体の模型と実画面の差**［事実］：単体の「path 6 — the dialog drawn again」はダイアログ部品だけを同じページの下で mount し直す。実画面では、PC ↔ スマホの切り替えで `AppShell`（`src/components/layout/AppShell.tsx`）が子を別の親の下に描くので、**ページそのもの（`WorktreeDetailRefactored` と `useWorktreeDetailController`）が mount し直される**。落ちるのはページの `handoffTarget`（React の state、`isOpen` の元）で、store の開いた回・単位・依頼は残る。だからダイアログは閉じて見え、「終了」の押し直しで同じ単位が出た（UAT の g10-01〜04）。作業木の切り替えも同じで、Next はページを `[id]` で鍵にするので切り替えのたびにページが作り直される（`node_modules/next/dist/client/components/layout-router.js` の `createRouterCacheKey`）。`AppShell-remount-children-4227.test.tsx` が前者を固定する。
  - **直し**：ページの hook は mount のとき（と作業木が変わったとき）、store の開いた回を取り戻す。**この作業木の開いた回（閉じていない）は単位の有無によらず**、**ほかの作業木の開いた回はその作業木に確定の送信中・結果不明があるときだけ**（不変条件の単位。人の選択を待つ）。取り戻しは `openHandoff(target, 開いた回の token)` で、新しい開いた回を始めず（`create` も text も送らない）、`openHandoff` の前に `closeHandoffBy('page-end')` を聞く形はガードのまま（target が無いので必ず通る）。ほかの作業木のものは取り戻すだけで `closeHandoffBy('worktree-switch')` は聞かない（pr3c 以降、§11.22 #17：`worktree-switch` は同じページのまま `worktreeId` が変わったときだけ聞く。実画面の作業木の切り替えはページの作り直しなので聞かない）。foreign の表示（依頼は元の作業木のまま・やめるだけ）は store から導く（`SessionHandoffDialog` の `foreign`）。ほかの作業木の停止・取り消しの応答待ちは自分の応答で終わるので取り戻さない（その間に別のページが自分の開いた回を始めてよい、pr2f の表の行）。閉じた開いた回（人が閉じた）は取り戻さない。
  - 試験：`useWorktreeDetailController-handoff-remount-4227.test.tsx`（hook の unmount → mount。直しを外すと 3 件赤）、e2e `mem-handoff-4227.spec.ts` の「G10」（実ブラウザで viewport を 1280 ↔ 390、作業木の切り替えの Loading → foreign → 戻って送り直せる）。
  - **最初の描画から・Loading の外で（G-PR4 の G10、G-PR3 の UAT の差し戻し 4）**［事実］：取り戻しが effect だけだと、作り直されたページの最初の commit は target が null で、cache miss ならページの Loading の早期 return がダイアログを外していた（開発サーバ・StrictMode の Agent 待ちで、戻った直後 0.1〜1 秒消えた）。直し：controller の `handoffTarget` と 2 つの ref の初期値を、effect と同じ条件（`handoffTakeBackOf`、読むだけ）で選んだ開いた回の target・token から揃える（render 中に begin・close・patch を呼ばない）。ダイアログの描画は `WorktreeDetailRefactored` の 1 か所（`withHandoff`、Loading・認証切れ・エラー・PC／スマホのどの枝でも同じ鍵の同じ instance）に集め、`WorktreeDetailDesktop` の描画と `onHandoff*` の props は消した。取り戻す条件・人の close・stale token・同じページでの本当の作業木の変更・foreign の停止不可は変えない。**ルートの遷移そのものを待つ間（`loading.tsx`、ページがまだ無い）は閉じない**：e2e で計測を残す（広げるかは別の判断）。試験：`WorktreeDetailRefactored-handoff-strict-remount-4227.test.tsx`（StrictMode・実 controller・実ダイアログで key=A → B → A、初期取得を保留。直す前は 4 件赤、controller だけ直すと cache miss の 2 件が赤）、ガード `handoff-close-paths-4227` の `checkPageHosts`（PC のページは描かない・ページは 1 回で `onClose={closeHandoff}`）、e2e の「G10 (G-PR4)」（(a) cache hit・(b) cache miss＋初期取得の保留・(c) ルートの遷移の保留を、push から 100ms・1s・3s にブラウザ内で採取）。
  - **G10b（codex-2 の P2 2 件、PM の処分）**：(1) 認証切れ（401）の間はダイアログを描かない（`isAuthExpired` で `<SessionHandoffDialog>` を描画から外す。`isOpen={false}` にすると隠す＝開いた回を閉じるので、外す）。再ログインのボタンが覆われずフォーカスも拘束されず、開いた回と単位は store に残り、読み込みが通れば同じ単位のダイアログが戻る（close の規則は変えない）。試験：`WorktreeDetailRefactored-handoff-auth-expired-4227.test.tsx`。(2) e2e の受入は「一度出たら消えない」：(a)(b)(c) で push から 3s まで 50ms ごとに採り、最初に 1 個になった後に 0 個へ戻る遷移が 0 回・1s までに 1 個。**(a)(b)(c) の 100ms は dev のルート読み込み・Suspense の間はページが無いための既知の制約（G10d で (b) も記録のみに：負荷で 0 と 1 に揺れる）**（値は記録のみで、期待を 0 に固定しない）。
  - **G10c（codex-2 の P2 2 件、PM の処分）**：(1) 受入を言い直した：認証切れの間に消えて戻るのは「**同じページのまま認証が戻った場合に、同じ単位で戻る**」まで。再ログインのボタンは**ハード遷移**（`window.location.href = '/login'`）で、ページも in-memory の store（`close-rule.ts`、永続化なし）も作り直されるため、単位は残らない。**これは G10 の前（fd2f4a589）から同じ**で、G10 が悪くしたものではない（旧版の tree で、ボタンのハード遷移と、遷移後の store が空であることを試験で確かめた）。ハード遷移を越えて単位を保つ（sessionStorage など）のは新しい要件で、#4289 に記録。試験：`WorktreeDetailRefactored-handoff-auth-expired-4227.test.tsx` の「(hard navigation)」。(2) e2e の判定は予定時刻のラベルではなく**実測の `elapsed`**：期限（1s）の前に実際に採れた採取で 1 個・最初に 1 個になった時刻・1→0 の遷移を `elapsed` で数える。採取が予定から 100ms 超遅れた走行は、採取の判定だけを『判定不能』として annotations と console に記録する（遅れていない走行は採取の判定も合否に使う）。**(a)(b)(c)(d) の合否は MutationObserver**（push の前から付け、例外時も外す。(a)(b)(c) は push の時点で 0 個・最初の 1 個が 1s まで・その後の全通知で 0 個が 0 回・最大 1 個・終了時 1 個・同じノード。(d) は開始時 1 個・全通知で 0 個が 0 回・最大 1 個・終了時 1 個・同じノード）で決め、MutationObserver が何も見なければ（通知 0 など）不合格（#4345・#4342）。記録に `at:dialogs@elapsed` を残す。判定の確認用に `G10_SAMPLE_SKEW_MS`（採取を遅らせる）と、既定で無効の `G10_ABC_DROP_DIALOG`・`G10_D_DROP_DIALOG`（ダイアログのノードを 1 タスクだけ外す）を持つ。
  - **#4317 PR1（ページの登録、ホストはページ内のまま）**：ページ（`useWorktreeDetailController`）はマウントごとに新しい識別子で `@/lib/handoff/page-registration` に登録し、cleanup は自分の識別子だけを外す（遅い cleanup が新しい登録を消さない・StrictMode の 2 回目で古い識別子が戻らない）。現在の登録は生きている中で最も新しいもの。ダイアログは `registration` を受け、現在の登録でない間（重なり・空白）は描画したまま close（×・Escape・背景・ボタン）・stop・decide・書き込み・本文の送信・drop を始めない。押した時と await の後（`end` の応答の後の kill、cancel・plain stop の応答の後の close、mode 読み取りの後の opening の作成）の両方で照合し、送信済みのものは元の単位・宛先で記録する（`end` の応答の採用・`end/observe`・decide の unknown・cancel の応答の読み直し・plain stop の stopped）。認証切れはページを越えて登録簿が持ち、現在の登録の 401 で立て、現在の登録の認証済みの取得の成功でだけ戻す（新しいページの初期値の false・Retry・古いページの応答・cleanup では戻らない）。ダイアログは描画から外すだけで単位・opening は保つ。不変条件（再指示 2）：ページのダイアログの認証による非表示は登録簿の `authExpired` だけで決め（ページ自身の `isAuthExpired` は再ログインの案内だけ）、認証の結果（成功・401）は取得を始めたときの登録の識別子と、同じ登録の中の取得の順（`seq`。新しい取得の結果を採った後は古い取得の 200 も 401 も動かさない）で照合し、新しい操作はすべて `handoffPageMayStart`（現在の登録 かつ 認証が有効）で始め（create の後の自動の本文の送信も、同じ作業木ではなく create を始めた登録で判定し、失効していれば unsent のまま）、送信済みの結果は元の単位・opening・宛先へ記録する。mode の取得・ダイアログの API・kill-session などの 401 は登録簿へ届かない（既存の通知の範囲。PR2 か別の追跡）。試験：`page-registration-4317`・`SessionHandoffDialog-registration-4317`・`useWorktreeDetailController-handoff-registration-4317`・`WorktreeDetailRefactored-handoff-auth-carry-4317`。
  - **#4317 PR2（ホストをルートの外に常設）**：ダイアログのホストは `HandoffDialogHost`（`src/components/mem/`）の 1 つだけで、`AppShellGate` が `AppShell` と兄弟の位置に常に描く（ルートの `loading.tsx`・Next が `[id]` で作り直すページ・PC／スマホの枝・ゲートの shell の有無のどれでも作り直されない）。ページ（`WorktreeDetailRefactored`）はダイアログを描かず（`withHandoff` は撤去）、登録の上に表示するもの（target・規則を通る `closeHandoff`・既存の停止 `stopForHandoff`）を `publishHandoffPageView` で載せるだけ。ホストの表：作業木の詳細のルート（パスから読む。`shouldRenderShell()` は許可に使わない）で、そのルートのページが現在の登録なら、その view（target が null なら 0 個）／ルートのページが登録されていない間（ルートの Loading・離れるページがまだ登録中）は取り戻しの条件（`@/lib/handoff/take-back` の `handoffTakeBackOf`、ページの初期値と同じ）で 1 個にし、登録も callback も渡さない（何も始めない）／認証切れ・詳細以外のルート・login／offline／proxy・terminal／files・パス不明は 0 個。0 個は描画から外すだけで `isOpen=false` では隠さない（opening は保つ）。ダイアログは key を付けず同じ instance・同じ DOM のまま、選択・通知・`writing` は opening の token が替わったときだけ初期化する（#4346：人の選択はダイアログの state から opening（store の `HandoffOpening.choices`）へ移した。ホストが 0 個を描く間（別の作業木・詳細以外のルート）はダイアログが unmount され、state では同じ opening に戻っても選択が外れていたため。新しい opening は空の選択で始まり、確定・拒否の応答の後は空にする。試験：`HandoffDialogHost-4317` の `[#4346]`）。ダイアログの opening の開始も effect の時点の登録で照合し直す。store の単位・close-rule・通信は不変。ガード `handoff-close-paths-4227` の `checkPageHosts` は「ページは 0、`AppShellGate` に 1、ホストの callback と登録は現在の登録の view だけ」に置き換えた（陽性対照つき）。試験：`HandoffDialogHost-4317`（表・Suspense の fallback を commit する対照と、ホストをページ内に置いた陽性対照）・`AppShellGate-handoff-host-4317`、e2e の「G10 (G-PR4)」の (d)（B で A の unknown の単位を foreign として 1 個表示 → RSC を保留して B→A：MutationObserver の全通知で 1 個・同じ DOM ノード。直す前は 0 個を 2 回数えて赤）。本番ビルドでの受入は e2e では示せない（Playwright は development 固定）。
  - **#4317 PR2 再指示 1（ルートも始める条件に入れる）**：ホストはパスの詳細のルート（作業木 id、詳細でなければ `null`）を layout effect で `reportHandoffRoute` に報告し、`handoffPageMayStart` は「現在の登録 かつ 認証有効 かつ その登録の作業木がそのルート」（`handoffRegistrationOnRoute`。ホストがルートのページとして描く判定と同じ）だけで新しい操作を始める。B の登録が残ったままパスが A になった間（開発のサーバーの RSC 保留中）に返った create・`end`・mode の取得は、本文の送信・kill・opening の作成を始めない。送信済みの後始末（decide の settle・本文の送信結果・kill の後の observe）は元の宛先で完了させる。ホストが一度も報告していない間（`route` が `undefined`。シェルなしでページを動かす単体テスト）はルートを条件に入れない（`AppShellGate` は常にホストを描く）。
- **項目の画面の単位（G-PR3、「画面全体で 1 つの規則」）**：MemItemsPanel の単位（送信中 `sending`・結果不明 `unknown`、操作の slot ごと）は `close-rule.ts` の store の `items` に、送った作業木の id を鍵にして持つ。書き手は `startMemItemsWrite`（単位を受け、`SentMemItemsWrite` を作る唯一の関数）・`settleMemItemsWrite`（その送信の答え：`unknown` なら残し、答えなら slot を消す）・`dropMemItemsUnit`（人の「送り直さずにやめる」）の 3 つだけ。読み手は `memItemsUnitsOf`・`memItemsUnitsAll`・`memItemsUnitsLock`。ダイアログの単位と同じく、部品の再 mount・ページを離れて戻っても残り（ページの再読み込みでは消える）、lock は 2 つの画面が同じ store から読む：ダイアログは `memItemsUnitsLock(store)`、パネルは `handoffUnitsLock(store)` を相手の lock に足す（`mem-write-lock.ts` の publish は今どおり併用）。store の側でも `startHandoffDecide` は項目の単位があれば、`startMemItemsWrite` はダイアログの単位があれば断る（(4)(e) の「ほかに何も書かない」を両向きに）。
  - **ガードの許可リストを変えた理由**（`handoff-close-paths-4227` の表）：パネルは store の書き手（自分の単位の 3 つ）を呼ぶので `STORE_IMPORTERS` に `src/components/mem/MemItemsPanel.tsx` を足した。保証を弱めないため、新しい表 `STORE_IMPORTER_VALUES` でパネルが取ってよい値を名前で固定した（`dropMemItemsUnit`・`settleMemItemsWrite`・`startMemItemsWrite`・`handoffStoreSnapshot`・`subscribeHandoffStore`・`handoffUnitsLock`・`memItemsUnitsAll`）：ダイアログの単位の書き手（`dropHandoffUnit` など）・表に無い読み手・名前空間・default の import はパネルからでも落ちる（陽性対照つき）。`STORE_WRITERS`・`STORE_EXPORTS` に 3 つの書き手（第 1 引数の型 `MemItemsUnit`・`SentMemItemsWrite`）と 3 つの読み手を足し、`SentMemItemsWrite` への cast を store の外で落とす（`checkBrandCasts`）。保証の範囲（store の外から書き手へ値で届かないこと、store のファイルの中は信頼境界）は変えない

### 4.2 依頼の文（Agent へ）

固定のテンプレート（D1：モデルを呼ばない）。データの区切り（D12）は C の区画と同じ作法で、依頼の ID と期限だけを差し込む：

```
[CommandMate: 終了の前の引き継ぎの依頼 request=<id> 期限=<ISO8601+09:00>]
このセッションを終える前に、mem の更新を「提案」として出してください。確定は人が画面で行います。
- 追加:  commandmate handoff propose --request <id> add --kind <kind> --text "…" --close-when <cond>
- kind=<kind>: --close-when は必須（付けないと終了コード 2）／省略可。使える値: … 例: --close-when …（kind ごとに 1 行。例の型は kind の意味で選ぶ）
- --close-when の値の形: manual / issue:#<n> / … / at:<ISO8601+09:00>（propose の kind が取る型だけ。at: はその時刻に自動で閉じる）
- 更新:  commandmate handoff propose --request <id> update <itemId> --base-version <v> --text "…"
- close: commandmate handoff propose --request <id> close <itemId> --base-version <v> [--reason "…"]
- 終わったら: commandmate handoff done --request <id>
propose が失敗したら（終了コードが 0 以外）、done の前に直して出し直してください。done の後の提案は受け付けません。propose と done を 1 つのコマンドにつながないでください。
今の項目は commandmate mem list で読めます。mem add / update / close で直接確定しないでください。
```

- 送るのは画面（`worktreeApi` の送信、`brief:'skip'`）。サーバから `sendUserMessage` を呼ばない（§1 の送信の呼び出し元の表を変えない）。`skip` なので境界は動かない（終わる会話に brief を付けない）
- Agent の端末にポップアップは出さない（Issue の「やらないこと」）。これは送信の本文で、端末の操作ではない
- **雛形と CLI の一致（G9、G-PR1+G-PR2 の審判の UAT の差し戻し）**：46cbe7699 では雛形の `propose --request <id> add …` を CLI が `unknown option '--request'` で拒んだ（`--request` は操作のサブコマンドにしか無かった）。CLI を両方の形を受け付けるようにした（`propose` にも `--request` を置き、操作は自分のもの→`propose` のものの順に読む `handoffRequestOf`。どちらにも無ければ 2・何も送らない）。不変条件：**雛形（`handoffRequestText` の出力）と CLI の手引き（ja・en の `commandmate handoff` の行）の全コマンド行を、実際の `buildProgram()` が parse し、名指したコマンドと依頼の ID に届く**（`tests/unit/cli/commands/handoff-template-parse-4227.test.ts`。行は本文から抜き出すので、雛形に足した行も自動で対象になる）。
- **雛形の `--close-when`（G9、G-PR3 の UAT の差し戻し 3）**：雛形が `[--close-when …]` と省略可に見せたが、waiting・next・external は必須で、Agent の初回の `propose` が exit 2 だった。kind ごとの必須・省略可と使える型を `lib/mem/close-when` の `CLOSE_WHEN_DEFAULTS`・`CLOSE_WHEN_ALLOWED`・`CLOSE_WHEN_TYPES` から組み（写さない）、型の書き方は `CLOSE_WHEN_FORMS`（型の追加はコンパイルで落ちる）。時刻は期限も例も `+09:00`（UTC 表記を Agent が取り違えた）。PM レビュー後: 例の型は kind の意味で選ぶ表（`EXAMPLE_TYPE`。next・external・note は manual、`at:` は自動で閉じるので例にしない）、必須の kind の `--close-when` に括弧を付けない、「終了コード」は `MEM_EXIT_BY_CODE` から、値の形の行は propose の kind が取る型だけ。不変条件：**kind ごとの例の行を実際の `buildProgram()` と `parseCloseWhen` に通すと受理される**／必須の kind で外すと拒否される（`handoff-template-close-when-4227.test.ts`）。
- **propose の失敗の後の done（G9、1 行の決定）**：CLI の parse の誤りはサーバに届かないので、done の時点で失敗した propose があったかはサーバに分からない。そこで **提案 0 件で done が届いた依頼（`reviewing`・`agentDoneAt` あり・提案 0）は、ダイアログに「提案が失敗していたなら届いていない。依頼し直すには『終了をやめる』→『終了する』」を出す**（`handoff-done-empty`、`SessionHandoffDialog-done-empty-4227.test.tsx`）。雛形にも「失敗したら done の前に直して出し直す・propose と done を 1 つのコマンドにつながない」を書いた。done の後の提案は今どおり `request_closed`（受け付けない）。

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
  state TEXT NOT NULL CHECK (state IN
    ('awaiting_agent','reviewing','applying','ending','ended','cancelled','expired')),
  apply_token TEXT,                                   -- applying の間だけ：その decide の印（§4.5）
  end_token TEXT,                                     -- ending の間だけ：停止の宣言の印（§4.6。G は kill しない）
  end_forced INTEGER NOT NULL DEFAULT 0 CHECK (end_forced IN (0, 1)),   -- 一度 1 にしたら同じ依頼では 0 に戻さない（§4.6、再確認 P1-2）
  outcome TEXT CHECK (outcome IN ('confirmed','unconfirmed')),
  outcome_reason TEXT,   -- forced・request_failed・agent_timeout・apply_failed・conflict_left・session_changed・expired（第 6 版で kill_failed を外した：止まらなければ ended にしない）
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
-- 依頼の固定した所属・寿命は変えない。end_forced は 1 → 0 にしない（再確認 P1-2）。第 6 版で process_identity の列を外した（§4.6.1）
CREATE TRIGGER mem_handoff_requests_pinned BEFORE UPDATE OF repository_id, branch, detached, target_worktree_id,
    target_worktree_incarnation, instance_id, instance_incarnation, instance_on_roster, boundary_id
  ON mem_handoff_requests BEGIN SELECT RAISE(ABORT, 'mem_handoff_requests: pinned column'); END;
CREATE TRIGGER mem_handoff_requests_forced_sticky BEFORE UPDATE OF end_forced ON mem_handoff_requests
  WHEN OLD.end_forced = 1 AND NEW.end_forced = 0
  BEGIN SELECT RAISE(ABORT, 'mem_handoff_requests: end_forced is sticky'); END;
```

- **形**：提案は「項目への 1 操作」（追加・版つきの更新・close）で、全体の書き戻しにしない（D6）。decision の `record`・`promote` の操作は **無い**（D9。promote は E の画面だけ）。decision の提案は `add`（`open`）と `close`（`open` の取り下げ）だけ
- **作者**：提案の口（Agent の CLI）は A の Agent の口と同じく `instanceId` と世代で作者を決め、依頼の `instance_id`・`instance_incarnation` と違えば 409 `not_requested`（他の instance が他人の依頼に提案を足さない）
- **会話の寿命**：提案・`done`・`decide`・`end` は、どれも書き込みの同期の区間で `getCurrentBoundary(…).id === boundary_id` と `isSameInstanceLifetime(依頼の値, readInstanceLifetime(…), cli_tool_id)` を確かめ、違えば 409 `session_changed`（依頼は `expired(session_changed)`、未決の提案は `expired`）。読み（`GET`）も同じ判定で状態を進める（読みは印が要らないが、旧依頼・旧提案を `expired` にすることはある。`mem_items` と新しい世代の依頼は変えない。§7.4 の入口の表）。**ただし停止の宣言済み（`state='ending'`）の依頼は除く**（G-PR1 の契約での局所の訂正、6 回目の再確認 P2）：停止の宣言の前の古い要求（依頼が `awaiting_agent`・`reviewing`・`applying`）は今どおり 409 `session_changed`・依頼は `expired(session_changed)`。宣言済みの依頼は、境界・在籍の寿命が変わっても、読み・期限の前の判定・他の入口はこれを失効させず `ending` のまま残す。終わり方は、同じ `end_token` の `end/observe`（観測の要求）で `ended`・`unconfirmed(session_changed)`（§4.6 の 4）か、期限（`expires_at`）で `expired`（記録なし）の 2 つだけ。`ending` の依頼への `propose`・`done`・`decide`・`rebase`・`extend` は 409 `request_closed`（`session_changed` ではない）。GET・観測・H15・§7.5 の e2e はこの 1 つの規則で読む
- **所属**：依頼の `repository_id`・`branch`・`detached` は作成の区間で `withMemTarget` の結果から固定し、以後変えない（トリガー）。確定（§4.5）は S-A に `pin.membership` として渡し、S-A の最終の区間の target と照合する（違えば 409 `membership_changed`、その提案は `failed(membership_changed)`）
- **強制の後**：`end_forced=1` になった依頼は、以後 `propose`・`done`・`decide`・`rebase`・`extend` を 409 `request_closed` で断る（未決の提案は既に `discarded(forced)`）。受けるのは `end`・`end/observe`（停止の再試行）・`cancel`・読みだけ
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
| `POST …/handoff/requests/:rid/end` | 画面（停止のボタンの押下の handler だけ） | 要る | `{ ifVersion, force?: true }` → 停止の宣言（§4.6 の 1）。依頼を `ending`・`end_token` にし、確定の途中なら止める。**kill しない** |
| `POST …/handoff/requests/:rid/end/observe` | 画面（同じ handler で、既存の停止の後） | 要る | `{ endToken }` → **サーバが** 止まったことを観測して記録する（§4.6 の 3・4）。**kill しない**。画面は `killed` を申告しない（観測の材料にしない） |

- CLI：`commandmate handoff propose …` と `commandmate handoff done`（新規 `src/cli/commands/handoff.ts`、`program.ts` に登録）。**承認・取り消し・終了の口は CLI に作らない**（§7.3）。exit code は A の `MemExitCode` を使う（50 disabled・51 conflict・52 not found・55 not_owner）。新しい語 `not_requested`・`request_closed` は 52 / 55 に寄せる［見立て］

### 4.4 取り消し・未応答・失敗・強制終了・タイムアウト

| 場合 | 起きること | 依頼 | 提案 | 次の世代へ（§4.6） |
|---|---|---|---|---|
| 依頼の文の送信が失敗（②） | 画面が `send-failed` を送り、「依頼を送れませんでした」と出す。選択：再送／提案なしで終了／終了をやめる | `awaiting_agent` のまま（再送）か下の行へ | — | 提案なしで終了なら `unconfirmed(request_failed)` |
| Agent が応答しない（期限まで `done` が無い） | 読むときに `agent_timeout` を出す。選択：待つ（+5 分、2 回まで）／ここまでの提案で進む（`reviewing` へ）／提案なしで終了／終了をやめる | 選択どおり | 期限の後に来た提案は 409 `request_closed`（`reviewing` 以降は受けない） | 提案なしで終了なら `unconfirmed(agent_timeout)`。「ここまでの提案で進む」は done が無いので、確定が全部通っても `unconfirmed(agent_timeout)` |
| 人が取り消す（「終了をやめる」） | 未決の提案をすべて `discarded(cancelled)`。**確定済みの提案（`applied`）と、他のセッション・Agent の直接の更新は巻き戻さない**。セッションは続く | `cancelled` | `discarded` | 終わっていないので記録しない（後で別の経路で終われば「記録なし」） |
| 確定の 1 件が失敗（DB・mode が `on` でなくなった・作り直し） | その提案は `failed(<理由>)`。他の提案は続ける。画面に一覧で出し、選択：残りで終了／終了をやめる | `applying` → `reviewing` | `failed` | `unconfirmed(apply_failed)` |
| 版の食い違い（§4.5） | `conflict`。人が今の値と並べて見直し、「今の版に載せ替える」（`rebase` で改版 → 新しい版との差分を再表示 → 新しい指紋で再承認、§4.5.1）か「捨てる」 | `reviewing` | `conflict` | 未決のまま終了すれば `unconfirmed(conflict_left)` |
| 強制終了（確定の前に人が「今すぐ停止」を押した。どの段でも） | 押下の handler が `end` の `force:true`（停止の宣言）→ 既存の停止 → `end/observe` を順に送る。宣言で未決の提案を `discarded(forced)`、`applying` の最中なら `apply_token` を外すので残りの確定は最終の区間の `fence` で止まる（§4.5）。確定済みは巻き戻さない。**kill は人の押した既存の停止だけ**（G は kill しない） | `ending` → `ended`（止まったことを観測できたとき） | `discarded` | **必ず** `unconfirmed(forced)`（`done` 済み・提案 0・確定が全部通っていても。G5 の優先の規則） |
| 停止が効かなかった（既存の停止が失敗した・`end/observe` でまだ動いている） | 「停止を確かめられませんでした」と出し、停止のボタンをもう一度出す（押すのは人）。依頼は `ended` にしない（`reviewing` に戻す）。**一度立った `end_forced` は同じ依頼では消さない**：強制の後の再試行は `force` の有無にかかわらず forced のまま（`force` なしで再試行して止まっても `unconfirmed(forced)`）。forced の依頼は以後 `propose`・`decide` などを受けない（§4.3） | `ending` → `reviewing` | そのまま（強制なら既に `discarded(forced)`） | 終わっていない（このまま画面を閉じれば `confirmed` は無い＝次の世代は「確認できない」） |
| 停止の宣言の後、`end/observe` を送らずに画面が閉じた（電源・再読込の途中） | サーバは待たない。依頼は `ending` のまま、`expires_at` の後の読みで `expired`。人が押した既存の停止が効いていても、観測していないので `confirmed` にしない | `ending` → `expired` | 未決は `expired` | 記録なし（確認できない）。再読込なら画面は `GET …/requests/:rid` で `ending` を見て、`end/observe` を送り直せる（同じ `end_token`） |
| 止まったが、観測の時点で境界・在籍の寿命が依頼と違う（停止の後に CommandMate・人の手で起動し直した） | 古い会話は終わったが、止まったことを依頼の会話について確かめられない。新しいプロセスには何もしない（G は kill しない） | `ended` | 未決は `expired` | `unconfirmed(session_changed)` |
| 在籍を変えずに kill→再起動（画面の外、CLI 等） | 次の読み・書きで境界が違う → 停止の宣言の前の依頼は `expired(session_changed)`。その古い依頼からの `propose`・`done`・`decide`・`end` はすべて 409 `session_changed`（`end/observe` は宣言済みの依頼にしか届かない。宣言済みの依頼は失効させず、観測で `ended`・`unconfirmed(session_changed)`、§4.3 の会話の寿命・§4.6）。**古い依頼は kill に届く経路を持たない**（G は kill しない。停止は人が今の画面で押す既存の停止だけ） | `expired` | `expired` | 記録なし |
| 画面を閉じた・電源が切れた（依頼の途中） | 何も進まない（サーバは待たない）。依頼は `expires_at`（60 分）の後の読みで `expired`、未決の提案は `expired`。**セッションは殺さない**（無人で kill しない） | `expired` | `expired` | 終わっていない。後で別の経路で終われば「記録なし」 |
| 依頼の途中で、画面の外から kill（CLI・別の画面・異常終了） | 次の読みで、境界が違う・instance の寿命が違う・roster に無い → 停止の宣言の前の依頼を `expired(session_changed)`（宣言済みの `ending` は §4.6 の観測で `unconfirmed(session_changed)`、観測が来なければ期限で `expired`） | `expired` | `expired` | 記録なし（確認できない） |
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

### 4.6 終了（`end`）と「終わる前の更新を確認できない」を次の世代へ（第 6 版：G は kill しない）

**G はサーバから kill しない**（PM の決定、§0.2）。停止は、人がその場で押す既存の停止（`handleKillConfirm` → `worktreeApi.killSession`（`src/lib/api-client.ts:771`）→ kill-session の route。route・api-client・hook の中身は変えない）だけ。G の `end` は停止の宣言と、停止の後の観測と記録だけを行う。古い依頼・期限・取り消し・`decide`・読みから kill に届く経路は作らない（§7.3 `handoff-no-kill-4227` で固定）。

停止のボタン（G-4 の ⑥ と「今すぐ停止」）の **押下の handler の中でだけ** 次を順に行う（effect・タイマー・`decide` の完了・依頼の状態の変化からは呼ばない。部品の試験 H15(f) で固定）：

1. **停止の宣言** `POST …/end` `{ ifVersion, force? }`（同期の 1 transaction）：印・依頼の `version === ifVersion`・依頼が `awaiting_agent`／`reviewing`／`applying`（`applying` は `force` のときだけ）・会話の寿命（境界の `id`・在籍の寿命）が同じ。違えば 409 `session_changed` など（依頼は `expired(session_changed)`）。このとき画面は「依頼の後にセッションが入れ替わりました。停止は今のセッションに効きます（引き継ぎは記録されません）」と出し、既存の停止を押すかは人が決める（押しても依頼は記録しない）。通れば `state='ending'`・`end_token`・**`end_forced = MAX(end_forced, force ? 1 : 0)`**（一度立った forced は同じ依頼では消さない。トリガーでも 1 → 0 を拒む）・`apply_token=NULL`（進行中の `decide` を最終の区間で止める）・未決の提案を `discarded(forced)`（今回 `force` のとき）・`version+1`。応答は `endToken`
2. **既存の停止**：画面が今と同じ停止（`worktreeApi.killSession(worktreeId, cliToolId, instanceId)`）を呼ぶ。G はその応答を観測の材料にしない（成功・失敗のどちらでも 3 へ進む。画面の `killed` の申告で成功を認めない）
3. **観測** `POST …/end/observe` `{ endToken }`：依頼が `ending` かつ `end_token` が同じ（違えば 409、何も変えない）。サーバが `cliTool.isRunning(target_worktree_id, instance_id)`（`src/lib/cli-tools/base.ts` の `isRunning(worktreeId, instanceId?)`。kill-session の route と同じ呼び方）と、今の境界の `id`・在籍の寿命を読む（**読むだけ。kill・起動をしない**）。**session 名を渡さない**（G-PR1 の契約での局所の訂正、6 回目の再確認 P2）：`isRunning` は受けた ID から `getSessionName` で session 名を組み立て直すので、session 名を渡すと別の名前を探し、実際の Agent が動いていても偽を返しうる（`confirmed` への誤到達）。primary（`instance_id === cli_tool_id`）と追加の instance の両方で、照会する session 名が kill-session の route の止めた名前と同じことを G-PR2 の試験で固定し、停止に失敗した（`isRunning` が真・読みの失敗）ときに `confirmed` にならないことを H9(f)(g) で固定する
4. **記録（同期の 1 transaction）**：依頼が `ending` かつ `end_token` が同じ。
   - 先に境界の `id` と在籍の寿命を比べる。違えば `isRunning` の値にも読みの失敗にも関わらず下の「それ以外」へ進み、`ended`・`unconfirmed(session_changed)`（宣言済みの観測の要求なので 409 `session_changed` にしない。6 回目の再確認 P2）
   - `isRunning` が真で、境界・在籍の寿命が依頼と同じ → 止まっていない：`reviewing` に戻す（`end_token=NULL`、`end_forced` はそのまま）、409 `not_stopped`。画面は「停止を確かめられませんでした」と停止のボタンをもう一度出す（押すのは人）
   - `isRunning` の読みが失敗し、境界・在籍の寿命が依頼と同じ → 同じく `reviewing` に戻して 409 `not_stopped`（止まったと言わない）
   - それ以外は `ended`・`ended_at`、`outcome` を次の **優先の順** で決める：
     1. `end_forced=1` → `unconfirmed(forced)`（**4 条件より優先**。`done` 済み・提案 0 でも。前の宣言で立った forced も含む）
     2. 境界の `id` か在籍の寿命が依頼と違う（停止の後に起動し直した。`isRunning` が真でも偽でも）→ `unconfirmed(session_changed)`。新しいプロセスには何もしない
     3. §0.1 G5 の 4 条件（`agent_done_at` がある・未決の提案が無い・`failed`/`conflict` が無い・人の停止の後に `isRunning` が偽で境界と在籍の寿命が依頼と同じ）が全部 → `confirmed`
     4. それ以外 → `unconfirmed(<最初に欠けた条件の語>)`（`agent_timeout`・`conflict_left`・`apply_failed` など）
5. 応答の消失：同じ `end` の再送は 1 の `version` の照合で 409 になり今の状態を返す。同じ `endToken` の `end/observe` の再送は、記録の後なら 409 と今の状態（`ended` と `outcome`）を返す。G は kill しないので、再送で kill が増えることは無い（既存の停止をもう一度押すのは人）

- 「止まった」の観測は `isRunning` が偽で、境界・在籍の寿命が依頼と同じこと。プロセスの識別（pid・世代）は見ない［見立て］：`confirmed` が言うのは「依頼の会話の Agent が止まり、別の会話は始まっていない」ことで、CommandMate の起動し直しは境界を変える（D1）。D1 の境界の記録に失敗した起動し直しを、人がさらに止めていた場合だけは区別できないが、そのときも「動いていない」は正しく、G は何も kill しない（誤って `confirmed` になるのは「止まったのは依頼の Agent か、その後に起動された Agent か」だけで、どちらも止まっている）
- 防げないこと［見立て］：人が押す既存の停止は今どおり session の名前で kill し、期待する世代を照合しない（§10）。押す前にセッションが入れ替わっていれば今の画面のセッションが止まるが、これは今の「終了」と同じ動きで、G が新しく作る危険ではない。G の依頼が古くなったことは 1 の宣言の 409 で人に見せる
- 読み口（S-C）：`readPreEndUpdate(db, { worktreeId, instanceId, before })` は、その (worktree, instance) の `ended` の依頼のうち `ended_at < before` で最も新しいものが、**その直前の境界より後**（同じ世代の終わり）に `confirmed` なら `'recorded'`、それ以外（無い・`unconfirmed`・前の世代のもの・`ending` のまま `expired`）は `'not_recorded'`。D2 §7.2 の X1〜X3 はそのまま D2 が判定する
- サーバか画面が 3・4 に届く前に落ちたら、依頼は `ending` のまま `expires_at` の後の読みで `expired`＝`not_recorded`（確認できない側）。画面の再読込なら `GET …/requests/:rid` で `ending` を見て、同じ `endToken` で `end/observe` を送り直せる
- 文言は D2 の固定の 1 行のまま（「確認できない」）。G は理由の語を brief に出さず、上限の値を持たない（D2 の先頭の行の上限は D2 の実装中の設計で **128 バイト**（第 2 版の 96 から実装で直した。`../commandmate-issue-4224` の作業中の設計書 §7.1、2026-11-09 に読んだ）。G-PR3 の接続の試験は D2 の export した定数を import して使い、数値を写さない）。理由は G-1 の「終了の記録」で人が読む

#### 4.6.1 採らないもの（第 6 版、PM の決定で G から外した）

第 5 版までの §4.6 は「G の `end` がサーバで照合してから kill する」前提で、次を足していた。PM の決定（終了の流れから自動の kill を外す）で前提が無くなったので、どれも作らない。既存のファイル（kill-session の route・起動の経路・`session-cleanup.ts`・`agent-session-lifecycle.ts`・各 driver・`send-attempt-*.ts`・`send-failure.ts`・`cli-operations-guide.md`）は G では変えない。

| 外したもの（第 5 版まで） | 外した理由 | 代わり |
|---|---|---|
| 起動／終了の排他 `withInstanceLifecycleLock`（`instance-lifecycle-lock.ts`）、起動の全経路と `killWorktreeSession` を包む変更、排他の順序と再入の契約 5 項 | 守っていたのは「G の kill の await の間に起動し直した新しい Agent を、G が kill しない」こと（2 回目 R-P1-1）。G が kill しないので、守る対象が無い | 無し（起動・kill の既存の経路は今どおり） |
| `InstanceLifecycleBusyError`（`INSTANCE_LIFECYCLE_BUSY_CODE`・文面 `lifecycle busy, nothing was typed`）、`classifySendFailure` の `lifecycle-busy` の行、`SendAttemptReason` の `'lifecycle-busy'`、`send-failure.ts` の 409 `INSTANCE_LIFECYCLE_BUSY`、`cli-operations-guide.md`（ja・en）の理由の一覧 | 排他を足さないので、送信の中の再起動が lifecycle を待たずに断る場面が無い（4 回目 P2 の前提が消える）。新しいエラーも文面も足さないので、5 回目 P2(1) の「本文に含まれる新しい文言を未送信の証拠と誤る」も起きない | `classifySendFailure`（`send-attempt-state.ts`）は 1 行も変えない。G が足す送信の中止（`BriefChoiceAbortedError`、§3.2）は **型で読み、文面で分類しない**（5 回目 P2(1) の規則をこちらに当てる。§3.2 と H21(j)） |
| Agent の識別：起動の世代の記録 `launchIdentity`、`beginAgentSession` の変更、各 driver の `agentProcessNames`、観測 `observeAgentProcess`、3 値の `classifyAgentIdentity`（`agent-identity.ts`） | kill の対象を確かめるためのもの。5 回目 P1（宣言名に一致する wrapper の外側を本体と取り違え、本体だけの交代を `'same'` と読む）のように、識別の端は各 CLI のプロセス構成に依り実機でしか決まらない。3〜5 回目の P1 はすべてこの端だった | 「止まった」は `isRunning` と境界・在籍の寿命で観測する（§4.6 の 3・4）。識別しないので、取り違えても kill に届かない |
| 観測点 × 失敗の注入の表（第 5 版 §7.4.1）、H15(d)(e)(g)(h)(i)(j)、H23 | 上の識別と排他の試験 | H15 を「G から kill に届かない」対照に置き換えた（§7.4） |
| kill の側へ通す期待の識別（`killInstanceSession` の `expect.processIdentity`）、kill の本体の共有の関数 `kill-instance-session.ts` への移動、v71 の `process_identity` の列 | kill しないので照合する所が無い | kill-session の route のまま（変えない） |
| kill の全経路を tmux の `killSession` から逆引きして、排他の中にあることを固定するガード（第 4 版 `instance-lifecycle-lock-4227`）と `agent-identity-4227` のガード | 排他と識別を固定するためのもの | 「G の閉包に kill が無い」ガード（§7.3 `handoff-no-kill-4227`） |
| 識別不明のとき従来の kill の Modal に戻る導線（第 5 版 §4.1 ① の `session_unknown` → 今どおりの確認の Modal） | 5 回目 P2(2)。識別が無くなり、G-4 の停止そのものが既存の停止なので、別の導線として残す意味が無い。Modal へ戻すと「依頼の記録が無いまま終わる」経路がダイアログの外にもう 1 つできる | 依頼を作れない（境界が無い）ときは、ダイアログの中で「停止」（既存の停止。依頼が無いので記録なし）と「やめる」だけを出す（§4.1 ①） |

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
| G-PR2 | v71（E = v69・F = v70 の後）・`src/lib/handoff/**`（依頼・提案・decide・rebase・期限・会話の寿命・停止の宣言と観測）・CLI `handoff`・G-4 の画面（停止は既存の停止を呼ぶ）・ガード（第 6 版：kill の本体の移動・排他・識別は外した、§4.6.1） | G-PR1 |
| G-PR3 | G-3（開くときの preview と選択、§3.1.1 の分類）・S-B の欄と画面の側の契約（§3.2.1）・S-C の読み口の接続（`pre-end.ts` と、D2 が置き場所を移した `previous-end.ts` の 1 行。pr3c で接続）・S-F の C の `itemCap` と provider の `detail`（PM の決定 (a)） | **D2 の develop へのマージ**（S-B・S-C・S-F は D2 のマージを前提に、この PR で足す。D2 の契約は変えない） |

### 7.2 新規ファイル（A〜D1 の外）

| ファイル | 中身 |
|---|---|
| `src/lib/db/migrations/v71-mem-handoff.ts`・`runner.ts` の登録 | §4.3 |
| `src/lib/db/handoff-db.ts` | 依頼・提案の CRUD（`mem_items` は書かない）。名前は A の `mem-*.ts` の glob に入れない |
| `src/lib/handoff/request.ts`・`proposals.ts`・`decide.ts`・`end.ts`・`pre-end.ts`・`template.ts` | 依頼の作成と状態（期限は読むときに判定）・提案の受け入れ（A の検査を呼ぶ）・承認と確定（S-A の入口だけを呼ぶ）・停止の宣言と観測の記録（§4.6。kill しない。`isRunning` の値は route が読んで値で渡す）・読み口（S-C）・依頼の文 |
| `src/lib/handoff/screen-client.ts` | 画面の client（`screenRequestHeaders()` つき、A の `screen-client.ts` と同じ形） |
| `src/app/api/worktrees/[id]/mem/screen/**`・`…/mem/handoff/**` | §2.3・§4.3 |
| `src/cli/commands/handoff.ts`（`program.ts` に登録）・`src/cli/types/` の型 | `propose`・`done` だけ |
| `src/app/repositories/[id]/mem/page.tsx`・`src/components/mem/MemItemsPanel.tsx`・`SessionStartBriefDialog.tsx`・`SessionHandoffDialog.tsx` | §2・§3・§4 |
| `docs/user-guide/`（ja・en）の mem の節 | 画面・対話と無人・終了の流れ・防げないこと（A §11.3 を写す） |

変える A〜D1 のファイル（PM の決定の範囲）：`src/lib/mem/service.ts`（S-A の入口 1 つ、既存の 3 つは変えない）・`src/lib/mem/transitions.ts`（S-D の遷移 1 つ）・`src/lib/db/mem-db.ts`（S-D の `closeMemItemVersioned` 1 つ、既存の `closeMemItem` は変えない）・`tests/unit/lib/mem/write-entrances-recreate-4221.test.ts`（`ENTRANCES` に行を足すだけ）・G-PR3 で `send-request.ts`・`session-brief.ts`・`send/route.ts`・`session-brief-db.ts`・**`src/lib/session/send-user-message.ts`**（S-B。`BriefChoiceAbortedError` を `classifySendFailure` に渡さず `stage:'brief_choice'` で返す、§3.2。第 4 版、3 回目 P2）・`sources.ts` の 1 行（S-C）。S-F（PM の決定 (a)）で `src/lib/brief/fit.ts`（`FitTextOptions.itemCap` と `uncapped` の分岐だけ）・`src/lib/brief/provider.ts`（`detail === 'full'` で `itemCap:false` を渡すだけ）・`src/lib/session/brief-provider.ts`（`BriefRequest.detail?` の欄だけ）。`render.ts` は変えない（`fittedEntryLine` の `all` の引数に `uncapped` を渡すだけで足りる）。C の既存の `it`・期待値・出力は変えない。

変える既存のファイル（A〜D1 の外）：`src/lib/api-client.ts`（`sendMessage` の options と戻り値の型、§3.2.1。`killSession` は変えない）・`useWorktreeDetailController.ts`（`openActiveKillConfirm` の前に分岐。`handleKillConfirm` の中身（既存の停止）は変えず、G-4 の停止のボタンからも同じものを呼ぶ）・`WorktreeDetailDesktop.tsx`／`WorktreeDetailRefactored.tsx`（ダイアログを描く）・画面の送信（`MessageInput.tsx`・`ChatSurface.tsx`・`MobileTerminalTab.tsx`・`SessionTile.tsx`・`usePendingMessages.ts` — D1 §4.1 の表の画面の送信の全経路。G-3 はこれらが通る共通の送信の関数の 1 か所に挟む。共通の 1 か所が無ければ全部に置き、表駆動の試験で全経路を固定する）・`MobileTerminalActionsSheet.tsx`（入口）・`RepositoryList.tsx`（入口）・`locales/{ja,en}`。

**第 6 版で変えないことにした既存のファイル**（§4.6.1）：`src/app/api/worktrees/[id]/kill-session/route.ts`（kill の本体を移さない）・起動の全経路（`send-session-start.ts`・`cli-tools/base.ts` など。排他で包まない）・`src/lib/session-cleanup.ts`・`src/lib/session/agent-session-lifecycle.ts`・各 driver（`agentProcessNames` を足さない）・`src/lib/session/send-attempt-state.ts`・`src/lib/session/send-attempt-types.ts`・`src/app/api/worktrees/[id]/send/send-failure.ts`・`docs/user-guide/cli-operations-guide.md`・`docs/en/user-guide/cli-operations-guide.md`。

### 7.3 ガード（`tests/unit/guards/`、新規）

- `handoff-screen-only-4227.test.ts`：`src/cli/**` が `mem/screen`・`handoff/requests/*/(decide|cancel|end|end/observe|extend|sent)` の書き込みと `X-CommandMate-Client` を持たない（A の `mem-mode-write-screen-only.test.ts` と同じ形。A の試験は変えない）
- `handoff-no-resident-4227.test.ts`：`src/lib/handoff/**` が `setInterval`・`setTimeout`（打ち切りの `AbortController` を除く）・detached・`unref` を持たない（A の `mem-no-resident-4222.test.ts` と同じ判定）
- `handoff-no-generation-4227.test.ts`：`src/lib/handoff/**` の import の閉包に LLM の SDK・`@/lib/report`・tmux を動かすモジュールが無い（C の I9 と同じ判定）
- `handoff-approval-not-from-auto-yes-4227.test.ts`：§5.3 の閉包の検査。`decide.ts` を import するのは `…/handoff/requests/[rid]/decide/route.ts` だけ
- `memWriteFromScreen` を呼ぶのは `src/lib/handoff/decide.ts` と `…/mem/screen/**/route.ts` だけ（E T23 の (2) と同じ形）
- `closeMemItemVersioned` を呼ぶのは `src/lib/mem/service.ts` の `memWriteFromScreen` だけ。`withdraw-recorded` の文字列が `src/cli/**`・`src/lib/handoff/proposals.ts` に無い
- `handoff-no-kill-4227.test.ts`（第 6 版、PM の決定）：G は kill しない。(1) `src/lib/handoff/**` と `src/app/api/worktrees/[id]/mem/handoff/**` の import の閉包（TypeScript の AST で、名前つきの import・`as` の別名・`import * as` の名前空間・再 export を辿る）に、tmux の `killSession`（`src/lib/tmux/tmux.ts`）・`SessionTransport` の `killSession`・cli-tools の各 driver の `killSession`・`stopClaudeSession`・`session-cleanup.ts`・kill-session の route のモジュールが無く、本文に `.killSession(` の呼び出しが無い。(2) `src/lib/handoff/**` と G の route が `cliTool.isRunning` 以外の tmux を動かす関数を呼ばない（観測は読むだけ。`isRunning` は route が読んで値で渡す）。陽性対照（`os.tmpdir()` の `mkdtempSync` に置いた fixture のソースで）：直接の `killSession(name)`・`import { killSession as k }` の `k(name)`・`import * as tmux` の `tmux.killSession(name)`・kill-session の route の `import` の 4 つがそれぞれ落ちる。陰性対照：`isRunning` だけを読む fixture は通る
- `SessionHandoffDialog.tsx` が `worktreeApi.killSession`（と `handleKillConfirm`）に届くのは停止のボタンの `onClick` の handler の中だけ（`useEffect`・タイマー・`decide` の応答の処理からは届かない）。静的な検査に加えて部品の試験 H15(f) で固定する
- v71 のトリガー `mem_handoff_proposals_immutable`・`mem_handoff_requests_pinned`・`mem_handoff_requests_forced_sticky` が migration にあり、`handoff-db.ts` の更新の SQL が不変の列を SET せず、`end_forced` を `MAX(end_forced, ?)` でだけ書く
- `handoff-close-paths-4227.test.ts`（pr2d〜pr2j）：ダイアログを消す全経路が 1 つの規則を通ること（§4.1.1）。pr2h から書き手への到達は**不変条件**で見る：`src/` の `.ts`／`.tsx` の全ファイルについて、store の書き手に値として届く経路は、許可リスト（`STORE_IMPORTERS`）のファイルからの、文字列リテラルの静的 import で、その記号を呼び出す形だけ。それ以外の形（禁止を列挙した形に限らない）はすべて落ちる。指定子は解決後のパスで判定し、全ファイルを AST で読む。動的な loader の例外は `src/i18n.ts` の locales の 1 形だけ。型だけの参照は通す。pr2i から名前と場所を表で固定する（ガードの最終形）：store の export の表面（`STORE_EXPORTS`、書き手か否かつき）・store の re-export（`STORE_REEXPORTS`：ダイアログの `handoffCloseBlock` だけ）・`module`／`node:module` から値を取るファイル（`NODE_MODULE_IMPORTERS`：`src/cli/utils/qr-terminal.ts` の 1 形だけ）・書き手の参照は呼び出しの callee だけ（依存配列の名前による除外なし。pr2j から store の中では宣言だけ）・読者は値の import だけ（`STORE_IMPORTERS` はダイアログと hook。`node:module` も同じく指定子ごとの `type` で見る）・表の所属は `Object.hasOwn` で見る（pr2j）。保証するのは store の外のファイルから書き手へ値で届かないことで、store のファイルの中は信頼境界（pr2k、§4.1.1 の「保証の範囲」）。保証の範囲外は §4.1.1 の「ガードの最終形」

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
| H9 | 次の世代への記録：`confirmed` の 4 条件の 1 つずつを欠かした 4 通りで `readPreEndUpdate` が `not_recorded`、全部そろえば `recorded`。前の世代の `confirmed` は今の世代の終わりに使われない。**停止の観測**（第 6 版）：(e) 停止の宣言の後に `end/observe` が来ない（`ending` のまま期限）→ `expired`、`not_recorded`。(f) `end/observe` で `isRunning` が真 → `reviewing`・409 `not_stopped`、`ended` にならない。(g) `isRunning` の読みが投げる → 同じく `not_stopped`（止まったと言わない）。**強制の優先**：(a) `done` 済み・提案 0 で `end` の `force:true` → 既存の停止 → `end/observe` で止まった → 必ず `unconfirmed(forced)`。**(b) 強制の 2 段の再試行**（再確認 P1-2。第 6 版で停止を人の既存の停止に読み替え）：`done` 済み・提案 0 → `end` `force:true` → 既存の停止が効かない（偽の kill-session が失敗し `isRunning` が真のまま）→ `end/observe` で依頼は `reviewing`・`end_forced=1` → `force` なしで `end` → 既存の停止が効く → `end/observe` → `unconfirmed(forced)`（`confirmed` にならない）。(c) `end_forced` を 1 → 0 にする UPDATE はトリガーで ABORT。(d) forced の依頼への `propose`・`decide` は 409 `request_closed` | 条件を 1 つ外した版。強制の判定を 4 条件の後に置いた版（(a) が `confirmed` になって落ちる）。`end_forced = force ? 1 : 0` で代入する版（(b) の再試行で `confirmed` になって落ちる）。画面の申告（kill-session の応答の成功）で止まったと読む版（(f) で `ended` になって落ちる）。`isRunning` の失敗を「止まった」と読む版（(g)） | 通常の「確定する」→ 人の停止 → 止まったことの観測（強制でない）で 4 条件がそろえば `confirmed`。強制を一度も使わない停止の失敗→再試行→成功は 4 条件どおり |
| H10 | 提案の作者：他の instance の提案・他の依頼への提案 → 409 `not_requested` | 作者の照合を外した版 | 依頼の instance なら受ける |
| H11 | decision の境界：提案に `record`・`promote` の op は無い（400）。G の close で `recorded` は `confirmUnreflected` が無ければ 409、あれば `closed(withdrawn)`。CLI の `mem close` は今どおり 55 | 確認を外した版 | `open` の取り下げは今どおり |
| H12 | 出口の検査：秘密らしい文字列を含む提案（受け入れの後に規則が変わった）は差分の表示で withheld、確定のときに A の検査で断られて `failed` | 出口の読み直しを外した版で本文が出る | 通常の本文は出る |
| H13 | `decide` の最終の transaction：(a) 同じ `ifVersion` の `decide` を 2 本並行 → 片方だけが `applying` になり、もう片方は 409。項目は 1 回だけ変わる。(b) 項目の保存の後に応答を捨てて同じ `decide` を再送 → 409 と `applied` の状態、`add` は 2 件にならない（`key`）。(c) `decide` の await 中に `end` の `force` → 残りの提案は `discarded(forced)`、項目は変わらない。(d) await 中に期限（`expires_at`）を過ぎる → `expired` | `fence` を外した版・始めの CAS を外した版・`key` を外した版 | 1 本だけの `decide` は全部確定し、既に確定した別の提案を巻き戻さない |
| H14 | S-A の所属・mode・寿命（最終の区間）：(a) `on` の worktree の route から、`off` の別ブランチの item ID を `update`・`close` → 409、項目は変わらない。(b) await 中に worktree を同じ ID・path で作り直す → 409 `incarnation_changed`。(c) 正当な `null→lazy` の発行（A の最初の mem の書き込み）を挟んでも拒まない。**(d) 依頼の所属**（再確認 P1-3）：ブランチ A・B の両方が mode `on`、A で依頼を作り `add` の提案を承認 → `decide` の await（`askConditionGit` を止めた deps）中に同じ worktree の HEAD を B へ変える → 409 `membership_changed`、提案は `failed(membership_changed)`、**A にも B にも `mem_items` の行が 1 件も増えない**。(e) 画面の G-1 の `add`（`expectBranch:'A'`）で同じ await 中に HEAD を B へ → 409、保存ゼロ | 所属の照合を外した版（(a) が書かれる）・寿命を最初だけ見る版（(b)）・`isSameInstanceLifetime` の代わりに incarnation の等号を使う版（(c) が拒まれる）・`pin.membership` を比べない版（(d)・(e) で B に 1 件書かれる） | 同じブランチの項目は書ける。HEAD を変えなければ `add` は A に書かれる |
| H15 | 会話の寿命と、G から kill に届かないこと（§0.1 G6・§4.6。第 6 版で書き直し：G は kill しない）：(a) 在籍を変えずに kill→再起動（新しい `launch` の境界を開く）→ 停止の宣言の前の古い依頼の `propose`・`done`・`decide`・`end` はすべて 409 `session_changed`、依頼は `expired(session_changed)`。**宣言済みの依頼**（`end` の後、`ending`）は、同じ再起動の後でも GET・他の入口が失効させず（`ending` のまま、`propose`・`decide` は 409 `request_closed`）、同じ `end_token` の `end/observe` で `ended`・`unconfirmed(session_changed)`（(e) と同じ。GET を観測の前に挟んでも同じ結果になることを対照に置く）。(b) 画面の再読込・再接続（境界を開かない）→ 受ける。(c) `end/observe` は画面の申告でなく `isRunning` で決める：`isRunning` が真のままなら `ended` にならない。**(d) G の全入口で kill が呼ばれない**：依頼の作成・提案・`done`・`decide`・`rebase`・`cancel`・`extend`・`end`（`force` あり・なし）・`end/observe`・読み・期限の判定（`expires_at` を過ぎた読み）の各々を、kill の関数（tmux の `killSession`・各 driver の `killSession`・kill-session の route の本体）を数える偽で回す → どの入口でも呼び出し 0 回（入口の表と同じキーの表駆動）。**(e) 停止の後の起動し直し**：`end` → 既存の停止 → `end/observe` の前に新しい `launch` の境界を開いて新しいプロセスを動かす（`isRunning` が真）→ 依頼は `ended`・`unconfirmed(session_changed)`、kill は呼ばれず、新しいプロセスは動いたまま。同じく `isRunning` が偽（新しいプロセスも止まった）でも `unconfirmed(session_changed)`。**(f) 画面の停止は人の押下だけ**（部品の試験、`@testing-library/react`）：`decide` が全部成功しても・依頼が `expired` になっても・期限の表示が来ても `worktreeApi.killSession` の呼び出しは 0 回。停止のボタンを押したときだけ `end` → `killSession` → `end/observe` の順に 1 回ずつ呼ばれる（PC とスマホの 2 通り）。**(g) 依頼を作れない**：境界が無い → 409 `session_unknown`、ダイアログは「停止」と「やめる」だけを出し、今どおりの確認の Modal は開かない（5 回目 P2(2)）。「停止」は既存の停止を 1 回呼び、`end` は送らない（依頼が無い） | 境界を見ない版（(a) で古い依頼が通る）・`isRunning` を見ない版（(c)）・`end` か期限の判定の中で kill を呼ぶ版（第 5 版までの形。(d) で呼び出しが 1 回になって落ちる）・観測で境界を見ない版（(e) で `confirmed` になる）・`decide` の成功で自動に停止する版（(f) で `killSession` が呼ばれる）・`session_unknown` で確認の Modal に戻す版（(g)） | 境界と在籍の寿命が同じで、人の停止の後に `isRunning` が偽なら `ended`。`popup=0`（無人）の「終了」は今どおりの確認の Modal から kill-session を呼ぶ（G の入口を通らない）。既存の kill-session の route は今どおり kill する |
| H16 | close の版と `recorded`：(a) 承認（人が見た版）の後に他者が `update` → 人の close は 409 `version_conflict`、項目は他者の値で `open`。(b) `recorded` に `confirmUnreflected` なし → 409、あり → `closed(withdrawn)`。(c) CLI の `mem close`（`closeMemItem`）は `recorded` に今どおり 55。(d) Agent の提案で `recorded` の close → 409 `state_forbids` | 版の照合を transaction の外に置いた版・遷移を `close` に混ぜた版（(c) が通る） | `open` の close は今どおり |
| H17 | `now`：S-A の `add` の `kind:'now'`・提案の `now` → 400。人の `now` の枠は #2427 の経路のまま書ける | `now` を S-A に通した版 | 他の kind は書ける |
| H18 | 改版：(a) `conflict` → `rebase` → 古い指紋の `approve` は 409 `proposal_changed`、新しい指紋で確定。(b) 指紋の範囲：`op`・`item_id`・`kind`・`base_version`・`payload`・`revision` のどれを変えても指紋が変わる（1 つずつの 6 通り）。(c) トリガー：不変の列の UPDATE は ABORT | `rebase` で指紋を計算し直さない版・指紋から `op` を外した版・トリガーの無い migration | 競合が無ければ改版なしで確定 |
| H19 | 画面の送信の契約（部品の試験、`@testing-library/react`）：(a) G-3 を閉じると本文・画像・自由入力の下書きが残る。(b) 保留→再送で選択（`brief`・`briefDetail`・`briefBoundary`）が同じ。(c) 終了の依頼の文の送信の body は `brief:'skip'`。(d) PC・スマホ・分割の各ペイン・`SessionTile` の全経路で同じ（表駆動） | 下書きを先に消す版・再送で選択を落とす版 | `popup=0` では body が今と同じバイト列 |
| H20 | `injectOnStart` と「全文」（S-F の (a)）：(a) `popup=1`・`injectOnStart=false` → preview は `show:false`、G-3 を出さない。(b) **600 バイトの本文の 1 項目**を `briefDetail:'full'`（provider に `detail:'full'`）で送る → 本文が省略されずに全部入る（`…(本文 N bytes を省略` が無い）。(c) **総予算の境界**：`itemCap:false` で、予算にちょうど入る項目数と 1 バイト足りない項目数の 2 通り → 入らない項目は項目ごと落ちて `omitted` と `all=` の案内、`BriefOverBudgetError` は出ない。(d) **行数の境界**：`maxLines` ちょうどと 1 行超えの 2 通り → 行の上限が今どおり効く。(e) withheld の項目は `full` でも本文を出さない。(f) D2 の必須の先頭の行は `full` でも入る（D2 の export した定数で照合、G-PR3）。(g) 見えない文字（U+200B など）を含む 600 バイトの本文 → `full` でも置き換えた形で出る。(h) **既定 short の不変**：`itemCap` を渡さない `fitText`・`detail` の無い要求・`briefDetail:'short'` の出力が、同じ入力で今の実装と 1 バイトも違わない（C の既存の試験がそのまま通ることと、変更の前後で出力を比べる対照） | `itemCap:false` を `all` と同じに扱う版（(c)(d) で予算・行の上限を超える）・`itemCap` を見ない版（(b) が省略形のまま）・`full` で sanitize を飛ばす版（(g)） | `short` と CLI の `brief`（`--all` を含む）は今どおり |
| H21 | 選択と境界（§3.2 の表）：(a) preview で A を見た後に A→B（reset）→ `decline`・`full` は 409 `boundary_changed`（`superseded`）、B は `pending` のまま、本文は打たれない。(b) A が別の送信で消費済み → 本文だけ、報告どおりの表示。(c) 変化なし → 選んだとおり。(d) `auto` の応答に brief の報告が無いとき「別の送信で渡された」を出さない。**(e) 確認の後の変化**（再確認 P2）：route の入口の照合を通った後、provider の作成か入力の排他の待ちの間に A→B → 送信の直前の区間で 409、**キーが 1 つも送られない**（偽の sender の呼び出しが 0）、境界 A・B とも消費されない。**(f) 別の送信の予約**：別の送信が A を `claim`（`claimed`）した状態で `decline` → 409（`claimed`）、本文は打たれない → 別の送信が失敗して A が `pending` に戻る → 聞き直して `decline` → `skipped(declined)`。(g) `decline` の本文が打てなかった（`not_sent`）→ A は `pending` に戻る。(h) 画面：(e)(f) の 409 の後、本文・画像の下書きが残り、ダイアログが開き直る（部品の試験）。**(i) `full` の失敗の経路を実際の送信のサービス経由で**（第 4 版、3 回目 P2）：送信の route → `sendUserMessage`（偽の sender・偽の provider、DB は `mkdtempSync`）で、`full` の (i-1) provider が投げる (i-2) provider の本文が予算を超える（`over_limit`。バイトと行の 2 通り、`withinVerifiedSize` を超える 1 通り）(i-3) 区間の `withMemTarget` が投げる、の各々 → HTTP 409 `boundary_changed`（`reason` は `provider_failed`・`over_limit`・`claim_failed`）、**偽の sender の打鍵が 0 回**、境界は `pending` のまま（`skipped`・`sent`・`claimed` にならない、(i-3) で予約した後なら `pending` に戻る）、応答は普通の送信の失敗（`stage:'send'`）にならない。画面の部品の試験で同じ 409 の後に下書きが残る。**(j) 中止の文面を本文に含む送信**（第 6 版、5 回目 P2(1) の陰性対照）：`auto` で本文に `BriefChoiceAbortedError` の message と同じ文字列を含め、偽の tmux の送信口が本文を引用した `Command failed: tmux send-keys … -l -- <本文>` で失敗する → 配送の記録は今どおり `{ state:'indeterminate', reason:'send-error' }`、HTTP は 409 `boundary_changed` にならない（`stage:'send'`）、境界の予約は D1 のとおり `unknown` で決着する（`not_sent` に戻さない） | `full` でも plan が `skip` を書く版（(i) で境界が消費される）・`send-user-message.ts` が `BriefChoiceAbortedError` を `classifySendFailure` に通す版（(i) が 409 でなく送信の失敗になる）・`briefBoundary` を見ない版（(a) で `decline` が B を消費する）・route の入口だけで照合する版（(e) で本文が打たれる）・`claimed` を消費済みと読む版（(f) で本文だけが送られる）・中止を文面で読む版（`classifySendFailure` か `send-user-message.ts` が message の照合で中止と読む。(j) で配送不明が 409 `boundary_changed`／`not_sent` になって落ちる） | (c)。`auto` は (a)(e)(f) でも今どおり（D1 の既定の動き）。**`auto` の (i-1)〜(i-3)**：本文だけが打たれ（打鍵 1 回分）、D1 の記録は今どおり（`skipped(provider_failed)`・`skipped(over_limit)`、区間の例外は本文だけ）、HTTP は今どおり成功 |
| H22 | 人への質問の分類（§3.1.1）：(a) 質問 0・`state` の情報源が読めない → `count:0`・`unknownSources:['state']`（「質問あり」にしない）。(b) 実際の待ち 1 件 → `count:1`。(c) **同じ待ちの重複**：`state` の `waiting`（今の worktree の X）と `owed` の `prompt`（この instance＝X）→ `count:1`。同じ相手への `awaiting` の `prompt` が 2 本 → 1 件。**(d) 同名の別 worktree**：今の worktree の `claude` の `waiting` と、別の worktree の `claude` を待つ `awaiting` の `prompt` → `count:2`。**(e) 両方向**：`owed` の `prompt`（止まっているのはこの instance）と `awaiting` の `prompt`（止まっているのは `peer`）を別々に・一緒に → 鍵どおりに数える。(f) `peer` が形に合わない relay の行 → 数えず `unknownSources:['relay']`。**(g) C の実際の形**（第 4 版、3 回目 P2）：(a) の fixture は `briefForRoute` に投げる `state` の reader を渡して得た JSON（状態の行は `statusRowItem` の `fields.unavailable`、`sources[]` の `status:'unavailable'`）。entries の状態の行だけ・`sources[]` の `status` だけのどちらでも `unknownSources:['state']`。待っていない instance の `state` の行（`readStateSource` が作る、`waiting` の欄が無い）は数えない | 順位 1 を数える版（(a) が 1 になる）・`entry.status` を見る版（実際の行に `status` の欄が無く、(g) が「質問なし・不明なし」になる）・`waiting !== null` で判定する版（欄が無い行を待ちと数える）・instance ID だけを鍵にする版（(d) が 1 になる）・`dir` を見ずに常に `peer` を鍵にする版（(c) の `owed` が別の鍵になって 2 になる） | 待ちが無く読めれば `count:0`・不明なし |
| H23 | （第 6 版で削除：排他の順序と再入の試験。G は起動／終了の排他を足さないので対象が無い、§4.6.1。`classifySendFailure` は変えないので、既存の分類の試験がそのまま通ることだけを確かめる） | — | — |

**入口ごとの適用条件と例外**（第 3 版、再確認 P2。表駆動の試験の行のキー。✓＝その H を回す、`—`＝回さない（理由を右端に）。期待が入口で違う所は「例外」に書く）：

| 入口（行のキー） | H6 印 | H2 mode | H1a 新しい世代を変えない | H1b 旧依頼の失効 | H15 会話の寿命・実プロセス | H7 無人×auto-yes | 例外・期待 |
|---|---|---|---|---|---|---|---|
| 画面の項目 `add`・`update`・`close`・`close`(recorded) | ✓ 無印は 403 | ✓ | ✓ | — 依頼に触らない | — 依頼が無い（寿命は S-A の (iii)、H14） | ✓ | `add` は `expectBranch` の照合（H14(e)） |
| S-A の直接の呼び出し（`memWriteFromScreen`） | ✓ service の中の判定（route だけに置かない） | ✓ | ✓ | — | — | — | `pin` があれば H14(d) |
| handoff `create` | ✓ | ✓ | ✓ | — 新しい依頼を作る側 | ✓ 境界が無ければ 409 `session_unknown`（H15(g)。プロセスの識別は見ない） | ✓ `popup=0` は 409 `unattended` | 開いた依頼があれば 409 `request_open` |
| handoff `read`（`GET`） | **— 印は要らない**：無印でも 200（陰性対照として「無印で読める」を回す） | — 読みは mode で断らない（`off` は 409 でなく状態を返す） | ✓ `mem_items` を書かない | ✓ **状態を進める**：停止の宣言の前の旧依頼は `expired(session_changed)`・期限切れは `expired`（宣言済みの `ending` は境界が変わっても失効させない。§4.3） | ✓ 判定だけ（kill しない） | ✓ | 読みで変わってよいのは旧依頼・旧提案の状態だけ |
| handoff `sent`・`send-failed`・`extend` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | forced の依頼への `extend` は 409 `request_closed` |
| handoff `propose`・`done`（Agent の CLI） | **— 印は要らない**（Agent の口。印つきでも権限は増えない） | ✓ 50 `disabled` | ✓ | ✓ | ✓ | ✓ | 作者の照合（H10）。期限の後・forced の後は 409 `request_closed` |
| handoff `decide`・`rebase` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `decide` は H13・H14(d) |
| handoff `cancel` | ✓ | — mode が `off` になっても取り消しは受ける（何も確定しない操作） | ✓ | ✓（既に失効なら 409 で何もしない） | ✓ | ✓ | 確定済みを戻さない（H4） |
| handoff `end`・`end/observe`（`force` あり・なし） | ✓ | — mode が変わっても停止の宣言と観測は受ける（判断は寿命と停止の観測だけ） | ✓ | ✓ | ✓ H15(a)(c)(d)(e)・H9(b)(e)(f)(g) | ✓ | **kill しない**（H15(d)）。`end/observe` は同じ `end_token` のときだけ |
| 読みに伴う期限の判定（`expired`） | — 内部 | — | ✓ | ✓ | ✓ kill しない（H8） | — | — |
| 古い行の掃除（14 日） | — 内部 | — | ✓ `mem_items` を消さない | — 終わった依頼だけを消す | — | — | 開いた依頼・14 日以内の行を消さない |


#### 7.4.1 （第 6 版で削除）Agent の識別の観測点と失敗の注入

第 5 版の観測点 × 注入の表（`agent-identity-4227.test.ts`）は作らない。G は kill しないので、kill の対象の識別も、その観測の失敗を「kill しない」に倒す試験も要らない（§4.6.1）。G から kill に届かないことは H15(d)(f) と §7.3 `handoff-no-kill-4227` で固定する。

### 7.5 e2e で確かめる項目（`tests/e2e/mem-ui-4227.spec.ts`、PC と スマホの viewport の 2 通り）

- 一覧・追加・編集・close（PC・スマホ）
- 同時編集の競合：2 つのページで同じ項目を開き、片方で保存 → もう片方の保存が 409 になり、3 つの値が並ぶ。載せ直しで保存できる
- 古い差分：Agent の API（`instanceId` つき）で項目を更新 → 開いたままの画面が再読込で「更新されました」を出す
- mode の画面：`derived` で操作が無効・`off` で一覧が出ない
- 閉じるときの流れ：Agent の応答は API で模す（`proposals`・`done` を試験から呼ぶ）。未応答（期限を試験の時計で進める）・確定の失敗（mode を途中で `derived` に）・取り消し・強制終了（確定の前に「今すぐ停止」を押す）の 4 通りで、画面の表示と提案の状態。どの通りでも、人が停止を押すまで kill-session の route への要求が 0 件（e2e のサーバへの要求を数える。第 6 版）。強制終了は `done` 済み・提案 0 でも画面の終了の記録が `unconfirmed(forced)`
- 強制の 2 段の再試行（再確認 P1-2。第 6 版で停止を人の既存の停止に読み替え）：`done` 済み・提案 0 →「今すぐ停止」→ 既存の停止が効かない（e2e のサーバの kill を失敗させ、`isRunning` が真のまま）→ 画面は「停止を確かめられませんでした」→ 普通の「停止する」で再試行 → 止まる → 画面の終了の記録が `unconfirmed(forced)`（`confirmed` にならない）。e2e のサーバで kill を失敗させる差し替えの口が組めなければ H9(b) の単体の対照と UAT に回し、その旨を PR に書く［未確認：e2e のサーバの差し替えの口］
- 停止の後の起動し直し（第 6 版。第 5 版の「kill の内部の await 中の再起動」は G が kill しないので外した）：停止のボタンの後、`end/observe` の前に別のページから同じ instance へ送信（起動の経路）→ 終了の記録が `unconfirmed(session_changed)` で、新しいプロセスは動いたまま（G は kill しない）。観測の前に画面の再読込（`GET`）を挟んでも、依頼は `ending` のままで同じ記録になる（停止の宣言の前の古い要求だけが 409・`expired(session_changed)`、§4.3）。順序を e2e で作れなければ H15(e) の単体の対照に回し、その旨を PR に書く
- 競合の後の改版：2 つ目のページで項目を更新 → 提案が `conflict` → 「今の版に載せ替える」→ 差分が新しい版で出直す → 承認で確定
- 開くときの下書き：本文と画像を入れて送信 → G-3 を閉じる → 入力欄に本文と画像が残る。選んで送る → 保留の吹き出しの再送でも同じ選択（route の要求の body で確かめる）。**API の旗だけでなく、実際の入力欄の本文と送信の body を見る**
- 終了の依頼の文：送信の body が `brief:'skip'` で、route の応答に brief が付かない
- 開くときのポップアップ：境界の行を試験の DB に作り、3 行の preview（質問 0＋情報源の失敗で「不明」。失敗は手で書いた JSON でなく、e2e のサーバの `briefForRoute` の `state` の reader を失敗させて作る＝実際の `statusRowItem` の行。差し替えの口が組めなければ H22(g) の単体の対照に回し、その旨を PR に書く）と 3 択の送信の本文（`brief`・`briefDetail`・`briefBoundary`）を route の要求で確かめる。preview の後に境界を作り直すと聞き直しになり、**409 の後も入力欄に本文と画像が残る**
- G-PR2 の行（閉じるときの流れの 4 通り・強制の 2 段の再試行・停止の後の起動し直し・競合の後の改版・終了の依頼の文）は `tests/e2e/mem-handoff-4227.spec.ts` に置いた［事実］。`/api` をブラウザの context で差し替え、2 つのページが 1 つのサーバの模型（依頼・提案・項目の版・instance が動いているか・会話）を共有する。kill の失敗（500 で動いたまま）・kill の応答の保留・mode の途中の変更はこの模型の口で作る。サーバ自身の規則は単体の表（`tests/unit/lib/handoff/**`）が持つ。「route の応答に brief が付かない」は送信の route の単体の試験（#4274 の `send-brief-request-4274.test.ts`・`session-brief-boundaries-4274.test.ts`）の側で、e2e は送信の body の `brief:'skip'` を見る
- 実機（tmux・本物の Agent）で確かめるもの（人の停止の後に `end/observe` が「止まった」を観測できること（ツールごとの `isRunning` の値）・Agent が依頼の文に従って `handoff propose` を打つか・5 分の期限が足りるか・D2 の先頭の行の表示）は UAT に回す（D2 §8 と同じ分け方）

---

## 8. 対になる場所（探した結果）

| 対 | 探した結果 |
|---|---|
| PC とスマホの「終了」 | 同じ hook（`openActiveKillConfirm`・`handleKillConfirm`、`useWorktreeDetailController.ts:1806`・`:1823`）を通る［事実］。分岐はそこに置けば両方に効く。設定の画面の「再起動」（`AgentUpdatesCard.tsx:178`）と roles の画面（`InstanceRolesSection.tsx:111`）も kill-session を直接呼ぶ — **終了の流れに入れない**（設定の変更のための再起動で、作業の終わりではない）。この 2 つで終わったら「記録なし」になる［見立て。§9 U4］。第 6 版：G-4 の停止のボタンも同じ `handleKillConfirm` の中身（既存の停止）を呼ぶ。停止の写しを作らない |
| 画面の送信の経路 | D1 §4.1 の表の 5 か所（`MessageInput.tsx`・`ChatSurface.tsx`・`MobileTerminalTab.tsx`・`SessionTile.tsx`・`usePendingMessages.ts`）が `src/lib/api-client.ts` を通る［D1 の事実。G では共通の 1 か所を実装の契約で確かめる］ |
| 画面の印の写し | A の `screen-client.ts`（設定）・B の引き取り・E の承認・G の 3 つ目の client。`screenRequestHeaders()` を共有し、印の判定は `isScreenRequest` の 1 か所 |
| 型の写し `src/cli/types/` | `handoff` の CLI の型を新しく置く。A の `mem` の型を写さず import する |
| 文書の ja・en | `docs/user-guide/` の mem の節（A・E が作る）に G の節を足す。見出しの対は `tests/unit/docs/ja-en-heading-parity.test.ts` が見る |
| kill の本体の写し | （第 6 版）G は kill しないので写しも共有の関数も作らない。停止は PC・スマホとも既存の `handleKillConfirm` → kill-session の route の 1 本。設定の画面の再起動・roles の画面も今どおり（G は触らない） |
| 起動／終了の排他の対（第 3 版） | （第 6 版で外した、§4.6.1）kill の側と起動の側の両方に排他を置く必要は、G が kill するときだけ。G は kill しないので、どちらにも置かない |
| 所属の固定の対（第 3 版） | handoff の `add`（`pin.membership`）と画面の G-1 の `add`（`expectBranch`）。どちらも A の `memAddItem` と同じく最終に解決した target に保存するので、同じ照合を置いた。`update`・`close` は既存の項目の所属の照合 (i) があるが、handoff の経路は `pin` でも照合する |
| 送信の直前の照合の対（第 3 版） | route の入口の `briefBoundary` の照合と、D1 の `claimInStretch`（入力の排他の中）。正は後者。D1 の `auto`・`skip`・`force` の経路は `claim()` の戻りを変えない |
| 中止の伝播の対（第 4 版） | `session-brief.ts` の plan（provider の失敗・`over_limit`）と `claim()`（区間の例外）の 2 か所が中止を作り、`send-user-message.ts` の配送の失敗の分岐（`classifySendFailure` の前）と送信の route の 2 か所が 409 に写す。`sendUserMessage` の他の呼び出し元（relay・timer など）は `full`・`decline` を渡さないので中止を受けない［見立て。実装の契約で `CALLERS` の表から確かめる］ |
| kill の全経路の対（第 4 版） | （第 6 版で置き換えた）tmux の `killSession` の import を下から逆引きする探し方は、§7.3 `handoff-no-kill-4227` で「G の閉包に kill が無い」ことを確かめる向きに使う（別名・名前空間・再 export を辿る）。kill の全経路を排他の中に入れることはしない |
| Agent の再起動の対（第 4 版） | （第 6 版で外した）Agent だけが交代する所（Codex の `relaunchIntoSamePane`・`base.ts:800`）を識別で見分ける必要は、G が kill するときだけ。G の観測は境界（D1）と `isRunning` だけで、交代を見分けられないときは `confirmed` にならない側か、止まっていることが正しい側に倒れる（§4.6） |
| 配送の分類の対（第 5 版、4 回目 P2。第 6 版で書き直し） | G は配送の分類に新しい行を足さない（`InstanceLifecycleBusyError` を外した、§4.6.1）。G が足す送信の中止 `BriefChoiceAbortedError` は `send-user-message.ts` で型で読み、`classifySendFailure` に渡さない（§3.2）。文面で読む所は作らないので、本文の引用（tmux の例外が本文を含む、`send-attempt-state.ts` の #3880 の注）と取り違える所が無い。探した対象：`classifySendFailure` を呼ぶ所（`send-user-message.ts` の 3 か所、`git grep -n 'classifySendFailure(' -- src`）と、文面で `not-sent` を返す行（同ファイル）。G の中止の文面と重なる行は無い |
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
| U13 | （第 6 版で解消）kill の対象の識別と、2 つのサーバが 1 つの tmux を共有する運用での排他の限界は、G が kill しないので問いにならない。残るのは、人の停止の後に各 Agent で `isRunning` が偽になるまでの時間（`end/observe` が早すぎて `not_stopped` になりすぎないか）を UAT で見ることだけ |
| U14 | （第 6 版で解消）排他を足さないので待ちの上限も無い |
| U8 | D2 の先頭の行が `decline` で届かないこと（§3.2）。`decline` でも先頭の行だけは付ける案は D2 の「1 つの会話に 1 回」の規則と予算の扱いに触るので採らなかった |

## 10. 本文に無い指摘（この Issue では直さない）

- `src/lib/api-client.ts:771` の `killSession` と kill-session の route は、期待するプロセス・会話の世代を受けない。第 6 版の G は kill しないので照合もしない。人が押す停止（`popup=0` の「終了」・G-4 の停止・設定の画面の再起動・roles の画面）は今どおり世代を見ずに今の session を kill する（G では直さない。人がその場で押す操作で、G の新しい危険ではない）
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

### 11.4 4 回目（Codex の再確認、`prereview/review-4227d.md`、第 4 版 `fd587decb` に対して）

再確認の評価：前回の 5 件のうち 4 件は解消、P1（Agent の起動世代）は一部解消。残件と追加の指摘を、PM の決定（端を 1 つずつ塞がず規則にする。#4288 と同じ形）に沿って次のとおり処置した（第 5 版。ほかの節は必要な所だけ変えた）。

| # | 指摘 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|---|
| P1 | `tpgid` が変わらなくても Agent は交代できる（job control の無い shell では Agent が shell と同じグループで動く。境界の記録の失敗と組み合わせると旧依頼から B を kill できる） | **採る**（規則にする） | `tpgid` は PID ではなく端末の前面のプロセスグループの ID［事実：`ps(1)`］。起動は利用者の login shell に起動の行を打ち直す［事実：`tmux.ts` の `respawnLoginShell`・`codex.ts` の起動の行と `relaunchIntoSamePane`］。D1 の境界の記録は失敗しても起動を止めない（第 4 版の §11.3 の事実）。端（`tpgid`・`pane_pid`・境界）を 1 つずつ足しても、読める値が別の Agent を指す形が残る | §4.6 の識別を 3 値の純関数 `classifyAgentIdentity`（`'same'`／`'different'`／`'unknown'`）にし、`'same'` だけが kill する。「同じ」は Agent 自身のプロセス（pane の木の中で `agentProcessNames` に一致するただ 1 つ。shell・宣言に無い wrapper は採らない）を、起動の時の記録（`beginAgentSession` で同期に進める世代番号と、起動の待ちの後の pid・開始時刻）と照らして一致したときだけ。`tpgid`・`pane_pid`・shell の pid は識別に使わない。不明は kill せず人の手動の停止へ案内。止める条件（どのツールでも識別が取れないと分かったら §0 に書いて止まる）を明記し、コードの上では当たらないと判断［見立て：起動の行は shell が `command` を直接の子として起動する］。§1 の表・§4.3 の列の注・§4.4 の 2 行・§4.6 の 3 と防げないこと・§7.2・§7.3 `agent-identity-4227`・§7.4 H15(g) に「Agent の PID は交代するが `tpgid` は同じ」の対照・(h)(i)(j)・§7.4.1 の観測点 × 注入の表・§8・§9 U13 |
| P2 | lifecycle の競合の拒否を `not_sent` にする規約が無い（未知の失敗は `indeterminate` で、境界が `unknown` で決着する） | **採る** | 配送の失敗は `classifySendFailure` で分類し、知らない失敗は `indeterminate`（`send-error`）［事実：`send-attempt-state.ts:399`］。`indeterminate` は境界を `unknown` で決着させる［事実：`session-brief.ts` の `outcomeOf`］。ツールの包みは元の例外を `cause` に持ち、`carriesCode` が辿る［事実：`send-attempt-state.ts` の `carriesCode`］ | §4.6 の契約の 2 に写像（`INSTANCE_LIFECYCLE_BUSY_CODE` と文面 → `{ not-sent, lifecycle-busy }`、`SendAttemptReason` に足す、`send-failure.ts` で 409 `INSTANCE_LIFECYCLE_BUSY`、文書の理由の一覧）。§7.2 の変えるファイルに `send-attempt-state.ts`・`send-attempt-types.ts`・`send-failure.ts`・`cli-operations-guide.md`（ja・en）。§7.4 H23(a) を実際の `sendUserMessage` 経由で配送の記録・境界（`pending` に戻る）・打鍵の回数 0・route の 409 まで確かめる対照に（`cause` つきと文面だけの 2 通り、陽性対照は今の実装）。§8 に配送の分類の対 |

- 第 5 版で新しく止める点は無い。識別の規則・配送の分類の 1 行は A〜D1 の作り直しでも PM の決定の範囲の外でもない（`agent-session-lifecycle.ts`・各 driver・`send-attempt-*.ts`・`send-failure.ts` は A〜D1 の外で、足すのは欄・行だけ）［見立て］。D2・E の worktree とファイルは読んでいない（第 5 版でも読む必要が無かった）
- 未確認：各 Agent が pane の木に宣言した名前でただ 1 つ現れるか（U13 の UAT）、e2e のサーバの reader と kill の差し替えの口、`send-failure.ts` の既存の試験の形（実装の契約で取り直す）

### 11.5 5 回目（codex-2 の再確認、`prereview/review-4227e.md`、第 5 版 `f9c7fd5bc` に対して）と PM の決定（`pm-decision-4227-kill.md`）

再確認の評価：前回の P1（Agent の起動世代）は一部解消、前回の P2（lifecycle の競合の未送信への写像）は解消。残件 P1 1・追加 P2 2。これを受けた **PM の決定：終了の流れから自動の kill を外す**（3〜5 回目の P1 はすべて「古い依頼が、後から入れ替わった Agent を kill しうる」ことの識別の端で、各 CLI のプロセス構成は実機でしか決まらず、識別を詰めても端が出続ける見込み。同じ種類の穴が 3 回出たので、手当てを足すのをやめて経路を消す）。第 6 版は次のとおり処置した。

| # | 指摘・決定 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|---|
| PM | 終了の流れから自動の kill を外す。閉じるときは 更新の依頼 → 提案 → 差分 → 承認 → 確定 →（人がその場で押す既存の停止）。G は古い依頼が後から kill する経路を作らない。kill の排他・Agent の世代の記録・識別の 3 値の関数・観測点の表・kill の側へ通す期待の識別は G から外す。受入基準は弱めない。「終わる前の更新を確認できた」は確定までの成功と人が停止を押したことの観測で決め、停止を確かめられなければ unconfirmed。対応表に読み替えを書く | **採る** | PM の決定 | §0.2 に Issue の範囲・受入基準との対応表と読み替え。§0.1 G5 の 4 条件の 4 つ目を「人の停止の後に止まったことを観測」に。§4.1 の流れ（⑥ を人の押下の handler の中の 停止の宣言 → 既存の停止 → 観測 に）。§4.3 の `process_identity` の列とトリガーの列・`kill_failed` を外し、API を `end`（停止の宣言、kill しない）と `end/observe`（観測、kill しない）に。§4.4 の行を書き直し（強制終了＝確定の前の「今すぐ停止」、停止が効かない、`end/observe` を送らずに閉じた、停止の後の起動し直し）。§4.6 を書き直し、§4.6.1 に外したもの 7 つを理由つきで残した。§1 の 2 行・§7.1・§7.2（変えないファイルを明記）・§7.3（`killInstanceSession`・`instance-lifecycle-lock-4227`・`agent-identity-4227` のガードを外し、`handoff-no-kill-4227` と停止のボタンの検査を足した）・§7.4 H9(e)(f)(g)・H15 の書き直し（(d) G の全入口で kill 0 回、(f) 停止は人の押下だけ、(g) 依頼を作れないとき）・H23 と §7.4.1 を削除・入口の表・§7.5・§8・§9 U13 U14 を解消・§10 |
| P1 | 同名の親子から外側を選ぶだけでは Agent 自身に限定できない（宣言名に一致する wrapper W の下で本体だけが交代しても `'same'`） | **前提ごと外す**（PM の決定） | 指摘は kill の対象の識別の規則の反例で、G が kill しなければ識別が要らない。外側を採る規則・複数候補の扱い・driver の宣言を詰めても、各 CLI の実の構成（U13）次第で端が残る見込み（PM の判断） | `classifyAgentIdentity`・`agentProcessNames`・`launchIdentity` を外した（§4.6.1）。「止まった」の観測は `isRunning` と境界・在籍の寿命で、プロセスを識別しない（§4.6）。取り違えても kill に届かないことを H15(d) と `handoff-no-kill-4227` で固定 |
| P2(1) | 本文に含まれる新しいエラー文言（`lifecycle busy, nothing was typed`）を未送信の証拠にできる。既存の分類は配送不明の判定を文言の判定より優先する［事実：`send-attempt-state.ts` の `classifySendFailure` の #3880 の注・`TMUX_TRANSPORT_FAILURE` の行］ | **`InstanceLifecycleBusyError` を外す**。規則は G の残りの新しい中止に当てる | kill を外したので起動／終了の排他が要らず、送信の中の再起動が lifecycle を待たずに断る場面が無い。新しいエラーも文面も `classifySendFailure` の行も足さないので、この誤りは起きない（`send-attempt-state.ts`・`send-attempt-types.ts`・`send-failure.ts`・`cli-operations-guide.md` は変えない）。G が残す新しい中止 `BriefChoiceAbortedError`（§3.2）には同じ規則を当てる：code（型）の判定と文面の代替の判定を分け、中止は型だけで読み、文面では読まない | §4.6.1 の 2 行目。§3.2 の (3) に「中止は `instanceof` だけで読み、`classifySendFailure` に文面の行を足さない」。§7.4 H21(j) に陰性対照（`auto` で本文に中止の文面＋tmux の失敗 → `indeterminate`（`send-error`）のまま、409 にならない、境界は `unknown`）と、文面で読む版の陽性対照。§8 の配送の分類の対 |
| P2(2) | 依頼の作成時の識別不明だけ従来の kill の Modal へ戻る導線が残り、不明なら kill しない規則と食い違う | **導線を削除** | 識別が無くなり、G-4 の停止そのものが既存の停止（人の押下）なので、Modal へ戻す別の導線は不要。戻すと記録の無い終わり方の入口がダイアログの外にもう 1 つできる | §4.1 ①：境界が無く依頼を作れないときは、ダイアログの中で「停止」（既存の停止、記録なし）と「やめる」だけ。§4.6.1 の 7 行目。§7.4 H15(g)・入口の表の `create` |

- 第 6 版で新しく止める点は無い。G は作るものを減らしただけで、A・B・C・D1 の作り直しも PM の決定の範囲の外の変更も無い。D2・E の worktree とファイルは読んでいない（第 6 版でも読む必要が無かった）［見立て］
- 未確認：人の停止の後に各 Agent で `isRunning` が偽になるまでの時間（U13 の残り、UAT）、e2e のサーバの kill を失敗させる差し替えの口（§7.5）、`handleKillConfirm` を G-4 の停止のボタンから呼ぶときの対象の渡し方（今は確認の Modal の対象を読む。実装の契約で確かめる）

### 11.6 6 回目の再確認（`prereview/review-4227f.md`、P1 0・P2 2）の処置（G-PR1 の契約で設計書だけを直す。実装は G-PR2）

| # | 指摘 | 処置 | 直した所 |
|---|---|---|---|
| P2(1) | 停止の観測の API が `cliTool.isRunning(sessionName)` と書かれていたが、実際は `isRunning(worktreeId, instanceId?)` で、session 名を渡すと別の名前を探して偽を返しうる | **`isRunning(target_worktree_id, instance_id)` に訂正**（kill-session の route と同じ呼び方）。session 名を渡さない。primary・追加の instance の両方で照会する session 名を G-PR2 で固定し、停止に失敗したときに `confirmed` にならないことは H9(f)(g) | §4.6 の 3 |
| P2(2) | 境界が変わった後の `end/observe` の状態遷移が 2 通り（409・`expired(session_changed)` と `ended`・`unconfirmed(session_changed)`）あり、GET の失効が先に走ると観測の条件を満たせない | **停止の宣言の前の古い要求と、宣言済みの観測の要求を分けた**：前者は今どおり 409・`expired(session_changed)`、後者（`ending`）は読み・他の入口が失効させず、同じ `end_token` の `end/observe` で `ended`・`unconfirmed(session_changed)`、来なければ期限で `expired`。観測は境界・在籍の寿命を先に比べ、違えば `isRunning` の値・読みの失敗に関わらず `unconfirmed(session_changed)` | §4.3 の会話の寿命・§4.4 の表の 2 行・§4.6 の 4・§7.4 H15(a) と入口の表の `read` の行・§7.5 の停止の後の起動し直し |

### 11.7 G-PR1 の 5-2b（Codex `review-4227-pr1.md`、P2 5）と PM 側の Claude のレビュー（`pm-review-4227-pr1-claude.md`）の処置

前提：試験・vitest の前に必ず `export CM_DB_PATH=$PWD/data/test.db`（本番の DB を守る。サーバは起動しない。e2e は既存の仕組みで CI が走らせる）。

| # | 指摘 | 処置 | 直した所 |
|---|---|---|---|
| Codex P2 #1・Claude P3-1 | close の `ifVersion` が確認を開いた時点でなく再読込み後の版 | 規則 (1)(3)：`Closing.read` の版を送る。409 は比較と「閉じ直す」で確認からやり直す | `MemItemsPanel.tsx`、§2.4.1 |
| Codex P2 #2・Claude P2-1 | 競合の載せ直しが見ていない根拠を巻き戻す | 規則 (2)(3)：変えた欄だけ送る。競合の比較に根拠と送る欄を出す | 同上 |
| Codex P2 #3・Claude P2-2 | 結果不明の押し直しが別の key で 2 件目を作る | 規則 (4)：要求の内容と key を保ち、入力を固定して送り直す。ja/en の文書を実際に合わせた | 同上、`docs/user-guide/cli-operations-guide.md`・en |
| Codex P2 #4・Claude P2-1 | 根拠を空にしても送られない | 規則 (2)：`evidence: []` を送る | 同上 |
| Codex P2 #5・Claude P3-2 | 記録済みの決定に実行できない「編集」、反映済みの close の文言が「取り下げ」 | 規則 (5)：`memScreenActions` を遷移の表から導く | `transitions.ts`・`MemItemsPanel.tsx` |
| Claude P3-6（PM が P2 に上げた） | 人が書いた項目を所有の instance の Agent が CLI で変え・閉じられる（D6 に反する） | `ownedBy` で `createdBy='human'`（`now` を除く）を Agent に偽。条件の close は今どおり。表に人の項目の行と対照 | `mem-db.ts`、`write-entrances-recreate-4221.test.ts`、§12 |
| Claude P3-3 | 390px で作業木の選択欄・ブランチ名がはみ出す見込み | `min-w-0 max-w-full`・見出しの折り返し。e2e に長い名前の行 | `MemItemsPanel.tsx`・`page.tsx`・e2e |
| Claude P3-4 | 条件が必須の kind を示さない・拒否の文言 | 必須の表示と `reason` ごとの文言 | `MemItemsPanel.tsx`・locales |
| Claude P3-5 | popup の説明が G-PR2・PR3 の動きを先に約束 | 「この版では保存だけ」に直した | locales・ja/en の文書 |
| Claude P3-7 | ZWSP などが A の規則で通る | 追跡 #4289（直さない） | — |

### 11.8 G-PR1 の再レビュー（Codex `review-4227-pr1b.md`、P2 3）の処置

前提：試験・vitest・verify の前に必ず `export CM_DB_PATH=$PWD/data/test.db`（本番の DB を守る）。サーバは起動しない。e2e は既存の仕組みで CI が走らせる。3 件とも、結果が不明な要求の扱いを画面が推し量っていた所から出ていたので、端を塞ぐのでなく §2.4.1 の規則 (4a)(4b)(4c) の行に揃えた。

| # | 指摘 | 処置 | 対照（`MemItemsPanel-screen-rules-4227.test.tsx` の describe「rule (4)(a)(b)(c)」） |
|---|---|---|---|
| ① | 別操作の完了が未解決の追加の key を消す | (4b)：`pending` を操作ごとの単位（`pendings`）にし、答えはその単位だけを消す | 追加の応答の消失 → 別の項目を保存 → 元の追加を送り直しても 1 件（538aa6cd9 では 2 件） |
| ② | 再送の宛先が今の作業木の選択に差し替わる | (4a)：単位に `worktreeId` を持ち、選択が違えば送らずに「その宛先に戻す／やめる」 | 追加の応答の消失 → wt-2 を選ぶ → 送れない → 戻して送ると wt-1 へ同じ要求で 1 件。陰性：やめると何も送らない |
| ③ | 条件だけの編集が未保存でも成功扱い | (4c)：編集・close の送り直しの 409 は欄の比較で成功と読まず、常に競合へ | 条件だけの更新が届かず → 別画面が本文を更新 → 送り直しの 409 は「保存しました」にならず比較。陰性：不明が無ければ今どおり保存 |

既存の試験「edit: the answer is lost after the store wrote it …」は (4c) で期待が逆になるので、名前と期待を (4c) に合わせた（PM の決定の (c) による）。close の送り直しの試験は、閉じた項目が一覧から消えるので期待は変わらない。


### 11.9 G-PR1 の 2 回目の再レビュー（Codex `review-4227-pr1c.md`、P2 1）の処置

前提：試験・vitest・verify の前に必ず `export CM_DB_PATH=$PWD/data/test.db`（本番の DB を守る）。サーバは起動しない。e2e は既存の仕組みで CI が走らせる。

| # | 指摘 | 処置 | 対照（`MemItemsPanel-screen-rules-4227.test.tsx` の describe「rule (4)(c): the comparison and the unknown request stay apart from the list」） |
|---|---|---|---|
| P2 | closed への送り直しの 409 の比較が、直後の再読込み（既定は closed を除く `listMemItems`）で行ごと消える | 比較（編集の競合・close の競合）を行の中でなく、一覧から独立した「単位の側」（`mem-items-units`、一覧の上）に出す。同じ理由で、結果が不明な編集・close の送り直しも、その行が一覧に無ければ単位の側に出す（行があれば今どおり行の中）。test id は変えない | close の成功 → 応答の消失 → 送り直し → 409 で、既定の表示のまま比較が見え、今の値は「閉じた」で閉じ直しは出ない。close の応答の消失 → 再読込みで行が消えても送り直しが押せる。編集中に Agent が閉じた → 409 の比較が残り、載せ直しは出ない。陰性：不明も競合も無ければ単位の側は出ず、編集・close は行の中。一覧にある項目の競合は載せ直しで今どおり保存 |

既存の試験「close of a recorded decision: the answer is lost → …」は、§11.8 で「閉じた項目が一覧から消えるので期待は変わらない」とした所が、この指摘そのもの（比較が無いことを期待していた）なので、期待を「比較が単位の側に見え、閉じ直しは出ない」に直した（この契約の決定による。名前は変えない）。

### 11.10 G-PR1 の 3 回目の再レビュー（Codex `review-4227-pr1d.md`、P2 1）と PM 側の Claude のレビュー（`pm-review-4227-pr1-claude-c.md`、P3 3）の処置

前提：試験・vitest・verify の前に必ず `export CM_DB_PATH=$PWD/data/test.db`（本番の DB を守る）。サーバは起動しない。e2e は既存の仕組みで CI が走らせる。結果が不明な要求と画面の別の操作の絡みが 4 回続いた（§11.7〜§11.9 と今回）ので、端を塞ぐのでなく §2.4.1 に規則 (4d)「単位の表示は単位の外の状態を読まない」の行を足した。

| # | 指摘 | 処置 | 対照（`MemItemsPanel-screen-rules-4227.test.tsx` の describe「rule (4)(d)」） |
|---|---|---|---|
| Codex P2 | 一覧に無い送り直しの表示が、1 つしか持てない `edit`・`closing` に頼るので、別の項目の編集・close を開くと消える（A の close の応答が消えた → 再読込みで A が消える → B を編集・保存 → A の送り直しが消える） | (4d)：単位（`Pending`）に表示に要るもの（編集は `draft`、close は `closing`）を持たせ、行の中・単位の側の送り直しの欄はどちらも単位から描く。単位の側は `pendings` の全部（一覧に無い項目の編集・close）を出す。比較（編集・close の競合）も項目ごとの表にし、別の項目の操作で消さない。答え（成功・409）で閉じる下書きはその項目のものだけ。単位がある行は「編集」「閉じる」を出さず、単位の表示に「送り直さずにやめる」を出す（その単位だけを捨てて一覧を読み直す） | Codex の順（A の close の応答の消失 → 再読込み → B を編集・保存 → A を送り直すと同じ宛先・同じ要求で 409 の比較）。一覧にある A の close の単位が、B の編集・B の close を開いても A の理由のまま出る（単位の外を読まない）。A の編集の単位が B の close を開いても下書きのまま残る。A の比較が B の編集を開いても残り、A の編集を開くと閉じる。陰性：「送り直さずにやめる」は何も送らず、その単位だけを捨て、行の「編集」が戻る |
| Claude P3-1 | 一覧に無い編集の送り直しに対照が無い | 対照を 1 本足す（src は (4d) の直しに含まれる） | 編集の応答の消失 → Agent が閉じる → 再読込みで行が消える → 単位の側の送り直しが同じ本文を送り、409 の比較が単位の側に出て、載せ直しは出ない（単位の側に編集を出さない変異で落ちることを確かめた） |
| Claude P3-2 | 利用者向けの説明（ja/en）が「送り直しは一覧の上」と言い切る | 「比べる表示は一覧の上、送り直しは一覧にあれば行の中・無ければ一覧の上」に直し、別の項目の操作で消えないこと・「送り直さずにやめる」も書いた | 文書の変更のみ |
| Claude P3-3 | 単位の側の「載せ直し」「閉じ直す」が書ける状態を見ない | 追跡（#4289）。直さない | — |

新しい対照のうち 5 本は 364738a07 の画面で落ちる（P3-1 の 1 本は 364738a07 でも通り、上の変異で落ちる）。

### 11.11 G-PR1 の 4 回目の再レビュー（Codex `review-4227-pr1e.md`、P2 1）と PM の決定（`pm-return-4227-pr1-pending.md` の (a)）の処置

前提：試験・vitest・verify の前に必ず `export CM_DB_PATH=$PWD/data/test.db`。サーバは起動しない。e2e は既存の仕組みで CI が走らせる。結果が不明な要求と画面の別の操作の絡みの指摘が 5 回続いたので、PM の決定で端を塞ぐのをやめ、組み合わせ自体を無くす不変条件 §2.4.1 (4e) にした。

| # | 指摘 | 処置 | 対照 |
|---|---|---|---|
| Codex P2 | 追加の応答待ちに入力欄を A→B に変えると、結果不明の後に B を表示したまま A を送り直す（追加の欄が (4d) に追従していない） | (4e)：送信中の要求を `inflight` に持ち、送信中・結果不明の単位がある間は単位の欄を読み取り専用にして単位の値（`input`）から描く。ほかの書き込みは押せず、理由を出す | `MemItemsPanel-write-lock-4227.test.tsx` の表（単位の操作 add・edit・close × 状態 送信中・結果不明 × 他の操作 add・edit・close・入力欄の変更・選択の変更・再読み込みの 36 行）。各行で単位の外の書き込みが送られず、単位の欄が送った値のまま変わらず、送り直しが同じ宛先・同じ要求であることを見る |
| PM Claude P3-3 | 単位の側の「載せ直し」「閉じ直す」が書ける状態を見ない | (4e) と同時に、両ボタンを `lock`（単位がある間）と `canWrite` で無効にする | 同じファイルの対照 2 本（単位がある間の載せ直し・書けない選択での載せ直し） |

- 陽性：f2f3e2d28 の画面で表の 18 行（add の 12 行と、edit・close の結果不明 × add・edit・close の 6 行）と対照 3 本が落ちる。ガードを外す変異（ボタンの `lock !== null` と `sendOne` の単位の照合を外す）で、結果不明 × add・edit・close の 8 行と対照 2 本が落ちる。陰性：単位が無ければ何も止めない・「送り直さずにやめる」の後は書ける。
- pr1e までの対照のうち、単位がある間に別の操作を書く 4 本（rule (4)(a)(b)(c) の ①、rule (4)(d) の 3 本）は、名前を変えずに「その間は押せず何も送らない → 単位が決着した後に書ける」に本文を合わせた。単位の表示の独立（(4d)）と一覧に無い送り直し（P3-1）の対照はそのまま通る。


### 11.12 G-PR2 の実装で設計から決めたこと・外れたこと（実装の事実）

前提：試験・vitest の前に必ず `export CM_DB_PATH=$PWD/data/test.db`。サーバ・tmux・Agent は起動しない。

| # | 点 | 決めたこと |
|---|---|---|
| 1 | v71 の列 | §4.3 の列に `send_state`（② の結果、`request_failed` の判定）・`extensions`（延長の回数）・`approved_fingerprint`（PM P3-a の印：人が承認した指紋）を足した |
| 2 | 終わりの理由 | `undecided_left`（判断されないまま残った提案）を足した。4 条件の判定は `done`（無ければ `agent_timeout`、依頼の送信が失敗していれば `request_failed`）→ 未決 → `conflict_left` → `apply_failed` の順 |
| 3 | 「ここまでの提案で進む」 | 新しい入口を作らず、Agent の期限を過ぎた `awaiting_agent` への `decide`（選ばない `decisions: []` も可）で `applying` → `reviewing` に進む |
| 4 | 印（PM P3-a） | §12 の D6 の行。印が通らなければ 409 `not_approved`（`MEM_SCREEN_REFUSALS` に足した）。`decide` の `fence` と印は別の層で、取り消し・強制・期限・会話の変化は `fence` か印のどちらかで止まる |
| 5 | 生きている依頼 | 作成は、同じ instance の開いた依頼と、同じ会話で停止を宣言した依頼（`not_stopped` で `reviewing` に戻りうる）があれば 409 `request_open`（それを返す）。古い会話の宣言済みの依頼は場所を取らない（観測は `session_changed` で終わるだけ） |
| 6 | 依頼の文の送信 | `src/lib/handoff/screen-client.ts` の `handoffApi.sendText` が送信の route に `brief:'skip'` で送る（`api-client.ts` は G-PR3 の範囲なので変えない） |
| 7 | G-4 の描画 | `SessionHandoffDialog.tsx` と hook の `openActiveEnd`・`handoffTarget`・`closeHandoff`・`stopForHandoff`（既存の停止の本体を `stopSession(target)` に出し、`handleKillConfirm` と同じものを呼ぶ）を作り、`cce5d9edc`（G-PR2 の同じ PR の追加の契約）で `WorktreeDetailDesktop.tsx`（PC のヘッダー・各分割の「終了」）と `WorktreeDetailRefactored.tsx`（スマホの「…」の「終了」）が `SessionHandoffDialog` を描き、「終了」は `openEnd` を通って `popup=1` かつ mode `on` のとき G-4 を開く［事実：G-PR3 の時点の develop、§12 の「対話・無人の設定」の行］。それ以外は今どおりの確認の Modal |
| 8 | S-C の読み口 | `pre-end.ts` は G-PR3（§7.1）。G-PR2 は記録（`outcome`・`outcome_reason`・`ended_at`）まで |
| 9 | 画面の外の更新 | `GET` の `direct` は、依頼の作成の後に Agent がそのブランチで書いた項目（提案の確定で書いた項目を除く、最大 50）。読むだけ。detached の依頼は項目の一覧（`mem-db.ts` の `scopeClause`）と同じく依頼の作業木（`origin_worktree_id`）の項目だけ（pr2c、§11.13 (3)） |

### 11.13 G-PR2 のレビュー（codex `review-4227-pr2.md`・A `pm-review-4227-pr2-claude.md`・B `pm-review-4227-pr2-claude-b.md`）と契約の補正（`pr2c-amend.md`）の処置

前提：試験・vitest の前に必ず `export CM_DB_PATH=$PWD/data/test.db`。サーバ・tmux・Agent は起動しない。対照は、外すと落ちることを試験の中の変異（`vi.mock` で 1 つの照合だけを外す）か、作業後に手で入れた変異（入れて落ちることを見て戻した）で示した。

| # | 指摘 | 処置 | 対照（外すと落ちる／陰性） |
|---|---|---|---|
| (1) | codex P2-1：停止の宣言の応答待ちに Esc・×・背景で取り消せ、遅れた応答から `onStop` へ進む | §4.1.1 の規則（`stopping`）で全入口を止める。`end` の await の後、閉じられていれば `onStop` へ進まない | `SessionHandoffDialog-4227.test.tsx` の「closing the dialog」の表（Esc・×・背景・「終了をやめる」× 停止中・送信中・結果不明 → 閉じない・取り消さない、陰性：何も無ければ閉じて取り消す）と「the dialog closed by the page while `end` is answered」。規則の判定と await 後の照合を外すと 14 本が落ちる |
| (10) | B P3-3 後半（PM が P2 に）：閉じた後に開くと結果不明の確定が人の選択なしに消える | 開くときに消さない（`worktreeId` を単位に持ち、ほかの作業木のものだけ外す）。閉じる規則は (1) と同じ関数（`unknown`）。結果不明の欄は依頼の有無に関わらず出す | 「kept over a reopening」（開き直しても出て、lock を持ち、同じ内容で送り直す。陰性：捨てた後は出ない）。開くときに消す変異で落ちる |
| (2) | codex P2-2：承認の画面が本文・close の理由しか見せない | 確定で書く欄（add：本文・closeWhen・evidence・promoteTo、update：本文・closeWhen・evidence、close：理由）を今の値と並べる。省略は「変えない」（add と理由は「指定なし」）、`[]` は「空にする」で、項目の画面の `editChanges` と同じ規則 | 「the approval shows every field it writes」の 4 本（条件だけの更新・`[]` と省略・add と close・伏せた提案と項目） |
| (3) | codex P2-3：直接更新の一覧だけ detached の所属が広い | `listDirectItemChanges` に `origin_worktree_id` を足し、`readView` から依頼の作業木を渡す | `handoff-direct-scope-4227.test.ts`（detached の作業木 2 つ、陰性：ブランチは共有、`readView` の経路）。条件を外す変異で 2 本落ちる |
| (4) | B P2-1：分割ペインの「終了」の配線に対照が無い | 実装は変えない（配線は正しい）。試験だけ | `WorktreeDetailRefactored-handoff-end-4227.test.tsx` の「a PC split pane’s own End」（アクティブでない `codex-2` で mode を 1 回読み・引き継ぎの target・popup off の確認がその session を止める・それまで kill 0） |
| (5) | B P2-2：create の失敗で plain の停止へ降りる対照が無い | 実装は変えない。試験だけ | 「a create that fails for any reason」の it.each（status 0・500・disabled・unattended・未知の code → plain の停止、押すと onStop 1 回・end 0 回） |
| (6) | B P3-5：mode を読む間の連打で 2 つのダイアログが開きうる | `openEnd` は読み中の押下を無視（作業木が変われば外す）し、片方を開くときにもう片方を閉じる（kill の要求中の確認は残す） | `useWorktreeDetailController-handoff-end-4227.test.tsx` の「pressed again while the mode is read」4 本。読み中の無視を外すと落ちる。codex P3（取り消し後の遅れた応答）は #4289 |
| (8) | A P3-1：decide の fence の `sameConversation` を外しても落ちない | 試験だけ | `handoff-decide-fence-conversation-4227.test.ts`（確定の await 中に新しい境界 → `expired(session_changed)`・書かれない。陽性：fence の `sameConversation` を外すと書かれる。陰性：境界が無ければ書かれる） |
| (9) | A P3-2：`approvalMarkHolds` の op・itemId／要求の state と token／作業木と instance の照合に対照が無い | 試験だけ | `write-entrances-recreate-4221.test.ts` の D6 の表に 6 行（fence を通さず `memWriteFromScreen` を直接呼び、それぞれ `not_approved`）と、照合を 1 つずつ外す変異 6 本（書かれる） |
| (11) | B P3-4：「引き取る」が lock の外であることの対照が無い | 実装は testid を足すだけ | `MemItemsPanel-write-lock-4227.test.tsx` の「taking a notice stays outside the lock」（自分の単位が結果不明・handoff の lock の 2 通りで押せて acknowledge が送られる）。lock を足す変異で 2 本落ちる |

- 作らない：B P3-1（create の応答待ちの plain の停止、補正で外した）。範囲の外：B P3-2・P3-3 前半・P3-6、A P3-3〜P3-5、codex P3（#4289）。


### 11.14 G-PR2 pr2c の再レビュー（codex `review-4227-pr2b.md` の P2 3 件・PM Claude `pm-review-4227-pr2c-claude.md` の P3-1・P3-2）と PM の決定（`pm-return-4227-pr2c-codex.md` の (a)）の処置

同じ種類（結果不明 × 閉じ方・別の操作）が 2 回目なので、端ではなく §4.1.1 の不変条件と 1 つの関数にした。表の試験は `tests/unit/components/mem/SessionHandoffDialog-close-table-4227.test.tsx`（実の hook とダイアログを pages と同じに配線。経路 5 × 状態（送信中・結果不明・取り消し待ち）× 作業木（この作業木の画面・切り替えた後のほかの作業木の画面））。

| 指摘 | 規則のどこで消えるか | 表の行（陽性：規則を外す `rule.off` か手の変異で落ちる／陰性） |
|---|---|---|
| codex P2 1：取り消しの応答待ちに確定を押せ、結果不明のまま閉じる | `cancelling` と、取り消しの開始後は `decide` を送らない（条件 4） | 経路 2「cancelling × being sent cannot arise」（確定・停止が送られない）。`decide` の照合とボタンの無効を外す変異で落ちる。陰性：確定の後の取り消しは送られて閉じる |
| codex P2 2：plain の停止の後の自動 close が規則を迂回 | `plain-stop-done` が規則を通る | 経路 3 の sending・unknown（停止は走り、単位が残り、やめてから閉じる）。`rule.off` の行で閉じる。陰性：何も無ければ閉じる |
| codex P2 3・PM Claude P3-1：別の作業木で開くと結果不明を消す | 開くときに消さない・`worktree-switch` が規則を通る・ほかの作業木の単位は「やめる」だけ | 経路 4 の 3 状態と「A → B → A」（B で送り直し無効・やめるは有効、A に戻ると同じ内容で送り直す）。`rule.off` の行で閉じる。ガードの「開くときに消す」変異。陰性：何も無ければ切り替えで閉じる |
| PM Claude P3-2 (a)：ページ側の閉じ（別の「終了」・切り替え）が規則を通らない | `page-end`・`worktree-switch` | 経路 5 の 3 状態（差し替えず plain も出さず mode も読まない）・ほかの作業木の画面の行。`rule.off` の行で差し替わる |
| PM Claude P3-2 (b)：kill の要求中に引き継ぎが開き 2 つ同時に | `openEnd` は kill の要求中に引き継ぎを開かない | 経路 5「a kill in flight」。照合を外す変異で落ちる |

- 経路 1（人の閉じ方）は 3 状態とほかの作業木の画面の行、陰性つき。既存の pr2c の表（`SessionHandoffDialog-4227.test.tsx` の Esc・×・背景・「終了をやめる」× 停止中・送信中・結果不明）はそのまま通る。
- MemItemsPanel 側は変えない（G-PR3 で規則の文言・表を揃える）。

### 11.15 G-PR2 pr2d の再レビュー（PM Claude `pm-review-4227-pr2d-claude.md` の P2-1・P3-1・P3-2 と PM の処分、codex `review-4227-pr2c.md` の P2 3 件）の処置

| 指摘 | 処置 | 表の行・ガード（陽性／陰性） |
|---|---|---|
| PM Claude P2-1：PC ↔ スマホでダイアログが作り直され、結果不明が人の選択なしに消える／codex P2-1：作業木の切り替えで実画面が Loading を挟んでダイアログを外し、単位と登録が消える（B で新しい依頼も作られうる） | **構造で直した**：単位と開いた回を `close-rule.ts` の store（worktree の id が鍵）へ移し、部品の state から外した。`registerHandoffHold` は廃止（規則は store を直接読む）。2 か所に描く形は残し、どちらの instance も同じ store を読む | 表の経路 6「layout」「remount」× 送信中・結果不明・取り消し待ち・停止中（単位が残り、依頼は 1 回、Esc は拒まれ、応答・停止の続きも届く）、陰性（何も無ければ同じ依頼を描くだけ）、陽性 `rule.perInstance`（部品が外れると store を空にする＝部品の state に戻す変異）で単位が消え依頼が 2 回。実画面 `WorktreeDetailRefactored-handoff-units-4227.test.tsx`：PC → スマホ（`useIsMobile` の変化で別の枝へ）と、B の取得を保留して Loading を挟む切り替え（A のものとして残り、B に依頼なし）。陰性：何も無ければ切り替えで閉じる。陽性：`rule.perInstance` で両方とも消える。手の変異（描き直しで常に新しい開いた回を始める・購読の解除で store を空にする）でも 11 件落ちる |
| PM Claude P3-1／codex P2-3：ガードが呼び出しの名前で数え、別名・直接の setter を通す | ガードを識別子の参照で数える形に書き直した（§4.1.1） | G1（`const closeNow = onClose`）・G2（`pendingRef.current = null`・`setPending(null)`・単位への直接の書き込み）・drop の別名・`settleHandoffDecide` を許した所の外で・hook からの clear・G3（`const clearTarget = setHandoffTarget`、経路名はコメントに残す）・store が `pending` を 3 関数の外で書く・store を空にする関数を足す・`src/` のほかのファイルからの clear、がそれぞれ落ちる。陰性：手を加えない写しは通る |
| PM Claude P3-2：取り消しを始めた後も引き継ぎの text が送られる | 条件 4 を広げた：`handoffTextSendable`（開いた回が生きていて、その作業木の取り消しが始まっていない）を text を送る前に見る。送り直しのボタンも取り消し中は無効。開いた直後の create → text も、閉じた／取り消した開いた回では送らない | 「cancelling：送り直しは送られない」「閉じた後に create が返っても text は送られない」、陰性 2 本。手の変異：照合とボタンの両方を外すと落ちる（照合だけを外す変異は、ボタンが無効なので等価で生き残る） |
| codex P2-2：plain の停止の失敗も「停止しました」にして再試行を隠す | 既存の停止（`stopSession`）が `SessionStopResult` を返す形にし（kill の成功・404・走っていない＝`stopped`、拒否＝`refused`、5xx で走っている＝`failed`、読めない・期限・別の kill の途中＝`unknown`）、`stopped` のときだけ閉じる／「停止しました」にする。既存の通知（toast）は変えない | 表「the plain stop’s answer」：拒否・失敗・不明 × 単位なし／単位あり（文言は出ず、停止ボタンが残って押し直せ、2 回目で止まって閉じる）。陰性：停止できて単位ありなら「停止しました」。`result` を見ない変異で 6 件落ちる |
| PM Claude P3-3（foreign の文言） | 直さない（#4289） | — |

### 11.16 G-PR2 pr2e の再レビュー（codex `review-4227-pr2d.md` の P2 3 件・PM Claude `pm-review-4227-pr2e-claude.md` の P3-1）と PM の決定（`pm-return-4227-pr2e-codex.md` の (a)）の処置

同じ系統（await の後の続きが、自分の単位・開いた回を持たずに今の状態へ作用する）が G-PR1 から数えて 3 回目なので、端ではなく §4.1.1 の「await の後の続き」の規則を型で強制した。

| 指摘 | 処置 | 表の行・ガード（陽性／陰性） |
|---|---|---|
| codex P2-1：先の確定の `finally` が次の送信単位を処理する（500 → 読み直し待ちに再確定 → 先の `finally` が次を結果不明にし、応答前に再送できる） | `startHandoffDecide` が送るたびに新しい `SentHandoffDecide` を返し、`settleHandoffDecide(sending, …)` は `inflight` がその単位のときだけ書く | 表 `SessionHandoffDialog-close-table-4227.test.tsx` の pr2f「a decide’s finally × the next sending」（次は送信中のまま、結果不明は出ず、次の応答が失われたら次が結果不明になる）、陰性（次が無ければ何も残らない）、store の表 `tests/unit/lib/handoff/close-rule-continuations-4227.test.ts`。陽性：`rule.tokenless`（settle が今の送信単位へ届く＝pr2f の前）で結果不明が出る。手の変異（`inflight !== sending` を外す）で赤 |
| codex P2-2：古い取り消し・plain の停止の完了が新しい開いた回を閉じる | `closeHandoffOpening(token, path)`（一致しなければ `stale`）・`noteHandoffHidden(token)`。ダイアログは開始時の token で `closeBy` し、plain の停止は await の後に開いた回が生きていなければ何もしない | 表の pr2f「the cancel’s answer × a new opening」「the plain stop’s end × a new opening」（A の待ちの間にページを離れ B で開く → B は開いたまま、「停止しました」も出ない）、store の表の close・hide の行。陽性：`rule.tokenless` で B が閉じる。手の変異は二重の守り（`stale` の照合と `markClosed` の token）を両方外すと赤（片方だけは等価で生き残る） |
| PM Claude pr2e P3-1：create の応答の token 照合に対照が無い | G-PR3 から戻して同じ規則で：表に行を足した | 表の pr2f「the create’s answer × a new opening」（create の応答待ちに閉じて開き直し、古い応答の版 9 が新しい開いた回の版 3 を書き換えず、text は 1 回）、store の表の patch の行。陽性：`rule.tokenless` で版 9 になる。手の変異 P34（`patchHandoffOpening` の照合と effect の `isLiveHandoffOpening` を両方外す）で赤 |
| codex P2-3：ガードが import の別名・名前空間を実体へ解決しない | 解決でなく禁止（PM の推奨）：§4.1.1 の「import の形」。store の書き手の第 1 引数の型と、brand 型への cast も固定 | ガードの pr2f の行：他のファイル（`MemItemsPanel.tsx`）からの `dropHandoffUnit as forget`・`import * as rule from '../../lib/handoff/close-rule'`（pr2e のガードは両方とも通すことも確かめる）・`export { … as … } from`・`export * as`・動的 `import()`・同じディレクトリの `./close-rule` の名前空間がそれぞれ落ちる。token の無い close を足す・settle を作業木の id で受ける・brand へ cast する、も落ちる。陰性：名前つき・type の import と別名の無い re-export、手を加えない写しは通る |

### 11.17 G-PR2 pr2f の再レビュー（codex `review-4227-pr2e.md` の P2 1 件・PM Claude `pm-review-4227-pr2f-claude.md` の P3-1〜P3-3）と PM の決定（`pm-return-4227-pr2f-codex.md` の (a)）の処置

| 指摘 | 処置 | 表の行・ガード（陽性／陰性） |
|---|---|---|
| codex P2：同名 re-export を経由した別名が禁止を迂回する（`bridge.ts` の `export { dropHandoffUnit } from './close-rule'` → `import { dropHandoffUnit as forget } from './bridge'`） | §4.1.1 の「書き手の受け渡しの禁止」：書き手の re-export を `src/` で全面禁止し、書き手の名前の別名 import はどの module からでも落とす | ガードの pr2g の行：2 ファイル（橋渡し＋利用側）の対照で両方が落ち、片方ずつでも落ちる。pr2f のガード（`checkImportForms`・`checkOthers`）はこの 2 ファイルを通すことも確かめる。陰性：ダイアログとページの実ソース、書き手でない記号の re-export（`handoffCloseBlock`）と名前つき import は通る |
| PM Claude P3-3：二段の再 export とテンプレートリテラルの指定子が抜ける | 二段の再 export（別名・同名）・ローカルの `export { x }`・`export default`・object の property として渡す、を落とす。`import()`／`require()` の置換のあるテンプレート・計算された指定子を落とす | ガードの pr2g の行：`` import(`@/lib/handoff/close-rule`) ``・`` import(`@/lib/handoff/${leaf}`) ``・`import(where)`／`require(where)`・`` import(`../../lib/${leaf}`) `` が落ちる。陰性：`src/i18n.ts` の locales のテンプレートは通る |
| PM Claude P3-2：ページの `closeHandoffBy` の `stale` の枝に対照が無い | 届く筋書き（ほかのページが開いた回を始めた後の close・作業木の切り替え）を試験にした（src は変えない） | `useWorktreeDetailController-handoff-stale-4227.test.tsx`：target が外れ、ほかの開いた回は開いたまま・単位は送信中のまま。陽性：`stale` で target を残す向きの手の変異で 2 件赤。陰性：自分の開いた回が単位を持つなら拒まれ target が残る・何も持たなければ規則で閉じる |
| PM Claude P3-1：store から今の token・単位を読んで渡す迂回が型でもガードでも止まらない | 入れない（#4289 で追跡）。理由は §4.1.1 の「store の今の token・単位を読む API」 | 変更なし（B1・B2 の形は表のテストが赤で捕まえる） |

### 11.18 G-PR2 pr2g の再レビュー（PM Claude `pm-review-4227-pr2g-claude.md` の P3-1〜P3-4 と参考・codex `review-4227-pr2f.md` の新しい P2 2 件）と PM の決定（`pm-return-4227-pr2g.md`）の処置

禁止する書き方を列挙する形の抜けが pr2f・pr2g・今回と 3 回続いたので、端を足さず、ガードを「許可する形だけを通す」不変条件（§4.1.1 の「ガードの不変条件」・§7.3）に作り替えた。src は変えない（実ソースは不変条件を満たしている）。

| 指摘 | 処置 | ガード（陽性／陰性） |
|---|---|---|
| codex P2 (2)：前置きの正規表現（`close-rule`・`import\s*\(`）に当たらない書き方（`'close'+'-rule'`、`import/*c*/(p)`）が AST の検査の前に除外される | 前置きの絞り込みを全部外し（`checkImportForms`・`checkWriterHandOn`・`checkOthers`、cast も AST で読む）、`src/` の全ファイルをパースする（1 回だけパースして使い回す） | 陽性：`import/*c*/(p)` が `computed specifier (p)` で赤。陰性：実ソース全体（ファイル数と `src/i18n.ts` を含むことも確かめる） |
| PM Claude P3-1：エスケープした指定子（`'@/lib/handoff/\u0063lose-rule'`）で namespace import と `export *` が通る | 指定子はパース済みの値を TypeScript の module 解決（tsconfig の `paths`）で解決したパスで判定する | 陽性：エスケープした指定子の `import * as S`・`export *` がそれぞれ赤（旧い絞り込みに当たらないことも示す） |
| PM Claude P3-2・codex P2 (1)：locales の例外が汎用（置換の中の `../`、`require` のテンプレート）、`const r = require; r(…)` | 例外を `src/i18n.ts` の `import()` の 1 形（`../locales/${識別子}/<固定名>.json`）に限る。`require` を呼び出し以外で参照すると落とす。`createRequire` の loader も同じ規則 | 陽性：置換に文字列・`require` のテンプレート・別ファイルの同じ形・置換の後ろの `..`・`const r = require`・`createRequire` の loader が store を読む／値で渡す、がそれぞれ赤。陰性：`src/i18n.ts`・`src/cli/utils/qr-terminal.ts` |
| PM Claude P3-3：書き手を呼ぶだけのラッパー関数を別の module から export できる | store から値を import してよいファイルを `STORE_IMPORTERS` に固定（ダイアログ・ページの hook・PC のページ）。外のファイルは store から値を何も取れない。実ソースの読者が許可リストと一致することも確かめる | 陽性：`MemItemsPanel.tsx` のラッパーが赤（pr2g のガードは 0 件だったことも示す）。既存の対照（別名・名前空間・re-export・動的 import・橋渡し・二段・値渡し・テンプレート）も新しい判定で赤 |
| PM Claude P3-4：`typeof`・type-only の import／export まで受け渡しと数える過剰な禁止 | 型の位置の参照と type-only の import／export を除く | 陰性：許可リストの外での `import type`（別名つき）・`{ type x as y }`・`export type`・`typeof`、ダイアログでの `typeof closeHandoffOpening` が通る |
| 参考：stale の試験の `expect(own.closed).toBe(false)` は常に真（store は新しい object を commit するので古い snapshot は変わらない） | 消した。何も閉じていないことは、すぐ上の `handoffStoreSnapshot().opening` が他のページの回と同一で `closed === false` であることが確かめている | `useWorktreeDetailController-handoff-stale-4227.test.tsx` |

保証の範囲外（P3 で記録する側）：`src/` の外・`.js` 等（`src/` に 0 件）・`module.require`／`eval`／`new Function` のような property や文字列越しの loader・ビルド設定の改変。

### 11.19 G-PR2 pr2h の再レビュー（PM Claude `pm-review-4227-pr2h-claude.md` の P2-1・P2-2・P3-1〜P3-4・codex `review-4227-pr2g.md` の P2 3 件）と PM の決定（`pm-return-4227-pr2h.md`）の処置

ガードの抜けが 5 回目なので、意味（基準・引数・データの流れ）を追わず、名前と場所を表で固定する形で閉じた。これを G-PR2 のガードの最終形とする（§4.1.1 の「ガードの最終形」・§7.3）。src は変えない（実ソースは表と一致し、依存配列に書き手を置く実ソースも無い）。

| 指摘 | 処置 | ガード（陽性／陰性） |
|---|---|---|
| PM Claude P2-1：store 自身が書き手を別名・object・ラッパーで export でき、許可リストのファイル経由で外へ渡せる | store の export の表面を `STORE_EXPORTS`（名前と書き手か否か）で固定。宣言での export だけ、`export { … }`・default は落とす。store の中の書き手の参照は宣言と、表の書き手の中での呼び出しだけ。許可リストのファイルの store からの re-export を `STORE_REEXPORTS`（ダイアログの `handoffCloseBlock`）で固定 | 陽性：store の別名 export・同名 `export { }`・object・配列・ラッパー関数・`export default`・表に無い値・表の読み手の名前のラッパー・表の名前の export 外し、store → ダイアログ → 外の連鎖、ダイアログの表外の名前・別名・ローカルの `export { x }`、hook の re-export がそれぞれ赤。陰性：実ソース（表との一致も） |
| PM Claude P2-2・codex P2-1：`createRequire` の別名 import、名前空間・default、`new URL` の基準 | `module`／`node:module` から値を取ってよいファイルを `NODE_MODULE_IMPORTERS`（`qr-terminal.ts` の 1 形）に固定し、それ以外は名前・形を問わず落とす。基準・引数は追わない | 陽性：別名（C1。pr2h のガードは 0 件だったことも示す）・名前空間（C2）・default（C3）・別ファイルの同名と `new URL` の基準・別の名前・副作用 import・`require()`・`import()`・re-export・許可ファイルでの別名がそれぞれ赤。陰性：`qr-terminal.ts` |
| codex P2-2：依存配列の除外（`useMemo` の名前）で書き手を値で渡せる | 書き手の参照は callee だけ。依存配列の名前による除外を書き手には掛けない（`onClose`・`setHandoffTarget` の検査では、実ソースの `closeBy` の依存配列に `onClose` があるので除外を残す） | 陽性：自作の `useMemo` への依存配列（codex の形）・React の `useCallback` の依存配列・引数・JSX 属性がそれぞれ赤。旧い除外では 0 件だったことも示す |
| PM Claude P3-1・codex P2-3：読者の確認が type-only を数える／`WorktreeDetailDesktop.tsx` が型だけなのに許可リストにある | 読者は値の import／re-export だけ数える。`WorktreeDetailDesktop.tsx` を `STORE_IMPORTERS` から外した | 陽性：PC のページに値の import を足すと赤。陰性：型だけ import する新しいファイル・PC のページそのまま |
| PM Claude P3-3：「置換は識別子 1 つ」に陽性対照が無い | 識別子でない置換の対照を足した | 陽性：`` import(`../locales/${String(l)}/common.json`) `` が赤（尾は許可する形のまま）。陰性：`src/i18n.ts` |
| PM Claude P3-2（許可リストのファイル内のラッパー export）・P3-4（大小違いの指定子は tsc の TS1261 で止まる） | 記録のみ（§4.1.1 に一文） | — |

### 11.20 G-PR2 pr2i の再レビュー（PM Claude `pm-review-4227-pr2i-claude.md` の P2-1・P3-1〜P3-4・codex `review-4227-pr2h.md` の P2 2 件）と PM の処分（`pm-return-4227-pr2i.md`）の処置

pr2i の最終形（名前と場所を表で固定し、意味は追わない）のまま、表の読み方と store の中の規則を締めた。src は変えない（実ソースの store に書き手→書き手の呼び出しは無く、`node:module` を型だけで読むファイルも無い）。

| 指摘 | 処置 | ガード（陽性／陰性） |
|---|---|---|
| PM Claude P2-1：書き手の本体の無名関数は owner が書き手になり、閉じる関数つきの handle・state の関数として外へ値で出せる | store の中で `STORE_WRITERS` の名前を参照してよいのは宣言だけ（callee も不可）。閉じたのは書き手の**名前**を呼ぶ形だけで、同じ無名関数が store の内部の書き込み関数（`markClosed`・`commit`・`writeFlags`）を呼ぶ形・それらを値で返す形は閉じていない（store の中は信頼境界、§4.1.1 の「保証の範囲」・§11.21）。実ソースに書き手→書き手の呼び出しは無いので、固定する形の表は置かない | 陽性：`beginHandoffOpening` が `close: (p) => closeHandoffOpening(opening.token, p)` つきの handle を返す形・同じ関数を開いた回（state）に入れる形がそれぞれ赤（pr2i の判定では 0 件だったことも示す）。陰性：実ソースの store の書き手の参照は 0 件 |
| codex P2-1：表の所属を `in` で見るので継承名（`toString` 等）の export が表外なのに通る | 全ての表（`STORE_EXPORTS`・`STORE_WRITERS`・`STORE_REEXPORTS`・`NODE_MODULE_IMPORTERS`）を `Object.hasOwn` で読む（`STORE_IMPORTERS` は `Set`） | 陽性：store の `export const toString`・`constructor`・`export function hasOwnProperty` が「表に無い」で赤、書き込む `toString` が「書き手でない」で赤。継承名が表から何も取らないこと |
| codex P2-2：`node:module` 側だけ宣言全体の `type` を見て、指定子ごとの `type` を値扱い | store 側と同じ関数（指定子ごとの `isTypeOnly`）で到達・読者を判定する | 陰性：`import { type Module } from 'node:module'`・`export { type Module } from 'node:module'`（と `module` の型だけ）が通り、読者に数えない。陽性：`type` と値の混在の import・re-export は赤、値の re-export は読者に数える |
| PM Claude P3-2：`process.getBuiltinModule('node:module').createRequire` | 記録のみ（§4.1.1 の保証の範囲外に足した） | — |
| PM Claude P3-1・P3-3・P3-4 | 記録のみ（#4289） | — |

### 11.21 G-PR2 pr2j の再レビュー（PM Claude `pm-review-4227-pr2j-claude.md` の P2-1・codex `review-4227-pr2i.md` の P2 1 件）と PM の処分（`pm-return-4227-pr2j.md`）の処置

2 件とも P3 にして #4289 で追跡する。ガードのテスト・src は変えず、§4.1.1 と §11.20 の「閉じた」と読める記述を実装どおりに直した（pr2k、設計書だけ）。

| 指摘 | 処置 | 理由 |
|---|---|---|
| PM Claude P2-1：書き手の本体の無名関数が store の内部関数（`markClosed`・`commit`）を呼び、閉じる関数つきの handle・state の関数として外へ値で出せる（`close: markClosed` も同じ） | P3（#4289）。ガードは変えない。§4.1.1 に「保証の範囲」を足し、§11.20 の P2-1 の行を「閉じたのは書き手の名前の形だけ」に直した | store のファイルの中は信頼境界。ガードが保証するのは store の外のファイルから書き手へ値で届かないこと（export の表面・re-export の表・`node:module` のファイル・callee だけ・値の読者）で、store の公開面は表で固定済み。store の中身の変更は PR レビューで見る |
| codex P2：loader の検査（`checkCreatedRequires` の 2 つの走査）が型の位置の `typeof` を値と数え、`import type { createRequire }`＋`typeof`・`qr-terminal.ts` での `typeof` の loader を落とす | P3（#4289）。ガードは変えない。§4.1.1 の「読者は値の import だけ数える」に既知の例外として書いた | 過剰な禁止（fail-closed）。正当なコードを足したときにガードが赤で知らせる安全側の誤りで、pr2h の PM Claude P3-4（型の位置の過剰）と同じ扱い。今の実ソースに該当の形は無い |

### 11.22 G-PR3 の実装で設計から決めたこと・外れたこと（実装の事実）

前提：試験・vitest の前に必ず `export CM_DB_PATH=$PWD/data/test.db`。サーバ・tmux・Agent は起動しない。

| # | 点 | 決めたこと |
|---|---|---|
| 1 | S-C の接続（**止める点** → pr3c で接続した） | **pr3c（PM の処分 4）：`previous-end.ts` の `readPreEndUpdate` の本体を `readHandoffPreEndUpdate` を呼ぶ 1 行にした。D2 の X1〜X4・先頭の行の文言・上限は変えていない。試験は `brief-previous-end-4224.test.ts` の「buildBrief reads the hand-off’s confirmed end」（確認済みの終了で先頭の行が出ない／`unconfirmed` は出る。配線を外すと赤）。** 以下は G-PR3 の時点の記録：D2 は読み口 `readPreEndUpdate` を `sources.ts` でなく `src/lib/brief/previous-end.ts` に置いてマージされた（`build.ts` がそこから import）［事実］。`previous-end.ts`・`build.ts` は G-PR3 の契約の範囲（`sources.ts` の 1 行）と §7.2 の表の外なので、本体の接続はしていない。読み専用の本体 `src/lib/handoff/pre-end.ts` の `readHandoffPreEndUpdate`（同じ引数・同じ答え）と試験（H9 の 4 条件・前の世代・作業木の作り直し・読みの失敗、D2 の `previousEndLead` と `PREVIOUS_END_LINE_MAX_BYTES` を import した照合）までを置いた。接続（`previous-end.ts` の `readPreEndUpdate` の本体を `readHandoffPreEndUpdate` を呼ぶ 1 行にする）は `previous-end.ts` を範囲に含む契約で行う。それまで次の世代の先頭の行は今どおり「確認できない」（安全側） |
| 2 | preview の route の場所 | §3.1 の `…/mem/screen/start-preview` でなく `GET /api/worktrees/:id/mem/start-preview`。`mem/screen/` はガード `mem-screen-write-4227` が「人の書き込み（印つき）の 3 本だけ」と固定しているので、印の要らない読みをそこに置かない（ガードを変えない） |
| 3 | preview の読み方 | **G-PR6 で改めた**（UAT `dev-reports/issue/4228/uat-s9-10-run/report.md` の段 10、S10-der・S10-full の差し戻し）：通常の本文の送信は、送る直前に preview を新しく読んで待ち（上限 2 秒）、`show:true` なら必ず聞く。読めなければ送らずに下書きを残す。規則は §3.1 の「3 行を読んだ後に境界と対象を読み直す」と §3.2 の「送る前に preview を新しく読んで待つ」が正。受入（§3.2 の出す条件・F22 の「境界が pending で popup 1 なら選択が出る」）と下の旧方針「待たない」が食い違っており、受入を正とした（送る前の待ちと、取得の失敗で送らないことを受け入れる）。以下は G-PR3 の時点の記録：送信は preview を待たない。作曲欄（`MessageInput`）は focus で裏で読み（10 秒より古いときだけ、2 秒で打ち切り）、attended の作業木では送信の後にも読み直す。送るとき手元の preview が `show` なら聞き、無い・古い・読めないときは今どおり `auto` で送る（`popup=0`（既定）の送信は今と同じ要求・同じ時点）。境界がその間に開いた最初の送信は聞かずに `auto` になりうる（D1 の既定の動き） |
| 4 | 選択つきの送信 | 楽観送信（`onOptimisticSend`・`usePendingMessages`）を通さず、作曲欄が `worktreeApi.sendMessage` を await する。下書き（本文・画像）は送れたときだけ消し、409 `boundary_changed` は再送せず preview を読み直してダイアログを開き直す（注意の文つき）。よって §3.2.1 の「保留の 1 件に選択を持たせる」は要らない（選択つきの送信は保留にならない）。全経路（スマホの作曲欄・PC の分割・セッション画面のタイル）が `MessageInput` を描くので、聞くのはそこ 1 か所（`git grep '<MessageInput' -- src`）。試験は `MessageInput-start-brief-4227.test.tsx`（楽観／await × PC／スマホの表） |
| 5 | 1 行目・3 行目の読み方 | §3.1 の表の「A の `memList` を数える」から変えた：mode `on` では 2 行目と同じ C の JSON（`briefForRoute` の 1 回の build、`all=1`）の `mem` の entries を数える（`openLinesOfBrief`。B の条件の評価が 1 回で済み、build の途中の作業木の作り直しで別の要求として評価し直さない。表 `brief-retry-paths-4223` の行）。`derived` は C が手書きの項目を読まない（`BRIEF_DERIVED_SOURCES`）ので A の `memList`（凍結、評価なし）を数える（`openLinesOf`）。件数は `closed` でない項目（`now` の枠を含む）、うち未反映＝`recorded` の decision、最終更新はその `updatedAt` の最大 |
| 6 | instance ID の形 | `src/lib/handoff/**` は `cli-tools/**` を import できない（ガード `handoff-no-kill-4227`）ので、preview は `INSTANCE_ID_PATTERN`・`MAX_INSTANCE_ID_LENGTH` と同じ値を持ち、試験で等しいことを固定した。`/` を含まないので `peer` は最後の `/` で分ける（U11 を確かめた） |
| 7 | 中止の記録 | `brief_choice` の中止は送信の試み（`recordSendAttempt`）を記録しない（打鍵の前で、`SendAttemptReason` に合う語が無い。足すと §4.6.1 の「変えないファイル」に触る）。境界は中止の時点のまま（区間で予約した後に投げたら `not_sent` で `pending` に戻す）。§3.2 (3) の本文もこれに合わせた（pr3c、A P3-6） |
| 8 | 400 の文面 | `brief` の値の誤りは #4274 の文面 `brief must be 'skip' or 'force'` のまま（その試験が文面を固定している。`decline` は画面の語で CLI には出さない）。`briefDetail`・`briefBoundary` の誤りは新しい文面 |
| 9 | 応答の報告 | `full` は選択なので、`skipped` の報告も返す（`short` は `auto` のまま返さない）。使用済みの境界は `state:'consumed'`（CLI の型 `src/cli/types/api-responses.ts` も足した） |
| 10 | pr2e P3-3 | `create` の 409 `request_open` は拾った依頼の文（`text`）も返し、ダイアログは `sendState` が `unsent`（自分が送っている最中を除く）でも「依頼の文を送り直す」を出す |
| 11 | pr2e P3-2 | 自分の作業木に単位が無く、別の作業木の結果不明が store にあるとき、ダイアログはそれを「別の作業木の結果不明」として出し、捨てるだけ押せる（送り直しは無効）。捨てる押下は既存の 1 か所（`handoff-pending-drop`）のまま |
| 12 | e2e の模型（#4289 B P3-6） | `tests/e2e/mem-handoff-4227.spec.ts` の模型の `end` は `applying` を `force` なしで 409 `state_forbids`、`create` は境界が無ければ 409 `session_unknown`（模型の `boundary`）、`request_open` は `text` つき。模型の `decide` は同期で `applying` が残らないので、既存の行の流れは変わらない。G-3 の e2e の行（§7.5 の「開くときの下書き」「開くときのポップアップ」）はサーバを起動しない契約なので足していない（部品の試験 H19・H21(h) と単体の H21・H22 で代替。UAT に回す） |
| 13 | G9（審判の UAT の差し戻し） | §4.2 の「雛形と CLI の一致」「propose の失敗の後の done」。`propose` の `--request` は操作の前でも後でもよい。提案 0 件の done はダイアログが人に知らせる |
| 14 | G10（審判の UAT の差し戻し） | §4.1.1 の「ページが作り直されたときの開いた回の取り戻し」。原因はページの作り直し（`AppShell` の枝・Next の `[id]`）で `handoffTarget` が落ちること。e2e は viewport の 1280 ↔ 390 と作業木の切り替え（G-PR3 の契約では流していない。pr3c で流した、#18） |
| 15 | pr3c：消費済みの境界と最終の照合（codex P2-1・A P3-1、PM の処分 2）。**pr3d で #20 の不変条件に一般化した**（`usedUp`・`recheckUsedUp` は `strictPlan`・`finalReading` に置き換え。以下は pr3c の時点の記録） | `full`・`decline` で plan が見せた行を消費済みと読んだとき、`SendBrief` は報告を確定せず（`usedUp`）、送信を入力の排他の下に置き（`needsOuterLock`）、`claim()` の冒頭で今の境界を読み直す（`recheckUsedUp`）：見せた行が今の境界で消費済み → 本文だけ・`consumed`、別の行・`superseded` → 409 `superseded`、`claimed` → 409 `claimed`、読みの例外 → `claim_failed`。何も書かない。区間で `claimBoundary` が負けた場合（plan では `pending`、別の送信が排他の中で先に消費）は表 (b) の「本文だけ」に倒さず **安全側の 409 `claimed`（打たない）** のまま（画面は preview を読み直して聞き直す）。試験：`session-brief-choice-4227.test.ts` の H21 (b2)（A 消費済み → 排他の待ち → `/clear` で B、直す前は本文が送られて赤）と (A P3-1) |
| 16 | pr3c：試験なしの防御（A P3-2） | `claim()` の catch の `unclaim`（区間で予約した後に例外）は、今の `withMemTarget` が callback を最後に呼ぶのでほぼ到達しない。試験を作るための注入が大きいので、試験なしの防御として残す |
| 17 | pr3c：StrictMode の二重実行（B P2-1、PM の処分 1） | 取り戻しの effect は、同じ作業木の開いた回を既にこのページが取り戻していれば何もしない（`handoffOpeningRef.current === live.token`）。`worktree-switch` は、このページで `worktreeId` が実際に変わったときだけ聞く（前に見た作業木を ref に持つ。新しい mount は null から）。作り直したページ・StrictMode の 2 回目では聞かないので、単位なしの開いた回を閉じず、押していない拒否の alert も出ない。試験：remount の単体に `reactStrictMode: true` の版（直す前は 3 件赤） |
| 18 | pr3c：e2e を完了条件に（PM の処分 3・5） | `mem-handoff-4227.spec.ts` を playwright の設定のまま（専用ポート・使い捨ての DB、`/api` は stub）で流した。G10 の decide の切断は `route`/`unroute` に同じ関数の参照を渡す（関数は同一性で比べられる）。Agent 待ちの場合も `data-layout` を確かめる（B P3-1）。直す前の hook では「waiting for the agent (no unit)」が赤だった |
| 19 | pr3c：項目の送信の throw（A P3-3） | `MemItemsPanel` の `sendOne` は、答えを決着させる前に投げたら `unknown` に倒す（ダイアログの decide の finally と同じ）。単位は残り、同じ slot の以前の結果不明を `answered` で消さない。throw は click の未処理の reject にせず、結果不明の知らせを出す。試験：`MemItemsPanel-write-lock-4227.test.tsx` の「a throw is unknown」。store の相互排他・同一性（A P3-4）は `close-rule-continuations-4227.test.ts` と `SessionHandoffDialog-pr3-4227.test.tsx` に対照を足した（変異 G2・G3・G5・G7 が赤） |
| 20 | pr3d：最終の照合の不変条件（codex `review-4227-pr3b.md` の追加 P2、PM の処分 `pm-return-4227-pr3c.md`） | （pr3e で照合の中身を §3.2 の「最終区間の照合は 1 つの述語」に一本化した。#22。以下は pr3d の時点の記録）端の手当て（pr3c の消費済みの枝）をやめ、§3.2 の不変条件にした。plan は strict の結果を `strictPlan`（`STRICT_PLAN_OUTCOMES`）に持つだけで A を確定しない：`full` の空の応答も plan では `skip` を書かず（`empty`）、最終区間で A がまだ `pending` の今の境界なら `skipped(empty)` にして本文だけ（`claim.consume` の書き込み）、取られていれば 409 `claimed`。plan が名前の無い出口で終わったら fail-closed で `claim_failed`。`claim()` は strict なら最初に `finalReading`、次に網羅の `switch`（`never` で新しい結果の足し忘れを型で落とす）。`needsOuterLock` は `strictPlan` が中止以外なら真。試験：`session-brief-final-reading-4227.test.ts`（行は `STRICT_PLAN_OUTCOMES` から作り、`satisfies Record<StrictPlanOutcome, …>` で場合の足し忘れが型で落ちる。`decline` × `empty` は build しないので到達しない）。先に赤：直す前は「empty × A → B × full」（codex P2）で本文が B の会話へ打たれ（`result.ok=true`）、slash の 2 行（full・decline）も本文が打たれた。slash の strict（画面は slash に選択を出さないので通常は来ない）も不変条件どおり A → B で 409 にした |
| 21 | pr3d：PM Claude P3-1・P3-2 の試験 | P3-1：同じページのまま A → B → A に戻ったとき、A の開いた回（結果不明の単位つき）が開いたまま・新しい拒否の知らせが出ない（`useWorktreeDetailController-handoff-remount-4227.test.tsx`。`handoffOpeningRef.current === live.token` の早期 return を外すと赤、本体は変えていない）。P3-2：H21 (b2) を command-code でも（`SUPPORTED_COMPOSER_TOOLS` に無く、外側の排他は `needsOuterLock` だけ）。`needsOuterLock` の strict の項を外すと 2 件赤 |
| 22 | pr3e：最終区間の照合を 1 つの述語に（codex `review-4227-pr3c.md` の P2、PM Claude `pm-review-4227-pr3d-claude.md` の P3-1〜3、PM の処分 `pm-return-4227-pr3d.md`） | 条件は §3.2 の「最終区間の照合は 1 つの述語」の一覧だけが正（ここには書かない）。pr3d までは枝ごとに照合の中身が違い、`empty` の確定は mode・`injectOnStart` を見なかった（codex P2）。試験：`session-brief-final-reading-4227.test.ts` の H21 (pr3e) の表（plan の結果 × 待ちの間の変化 {なし, A → B, 別の送信が A を取る, mode `off`, `injectOnStart` off, 所属の変化（branch）} × {full, decline} × tool {claude, command-code}、到達する 9 × 6 × 2 = 108 行。行は列挙から作る。陰性の行（変化なし・消費済みに別の送信）も tool の軸つき）。先に赤（直す前）：34 行（`empty`・`used_up`・slash × mode `off`・`injectOnStart` off・所属の変化、slash × 別の送信が A を取る）。P3-1：`needsOuterLock` を `used_up` だけに狭めた変異で command-code の empty・slash × A → B の 3 行が赤。P3-2：empty の状態の照合を外した変異で empty × 別の送信が A を取る（409 `claimed`）が赤 |
| 23 | pr3f：不変条件 S-B-commit（codex `review-4227-pr3d.md` の P2、PM Claude `pm-review-4227-pr3e-claude.md` の P2-1・P3-1〜P3-4、原因 `pm-rootcause-4227-sb.md`、PM の処分 `pm-return-4227-pr3e.md`） | 中身は §3.2 の「不変条件 S-B-commit」だけが正（ここには書かない）。原因：strict の「中止なら打たない・消費しない」が D1 の fail-open の部品の上に、出口ごとの `if (this.strict) refuse` と後から見る旗・既定の `?? content` で重ねてあった（旗を立て忘れた出口は本文を打つ側へ倒れる）。#15・#20・#22 は plan → 述語 → 述語の後と段を移っただけで、述語の後（確定・打つ文字列・例外）を縛る条件が無かった。試験：表 1（`session-brief-final-reading-4227.test.ts`）の待ち中の変化に `instance_remade`・`worktree_remade`・`seeded_claim` を足した（7 シナリオ × 9 変化 × 2 tool − 消費済み × seeded claim）。表 2（`session-brief-commit-4227.test.ts`）＝種別 × commit の失敗（throw・changes 0・withheld・予約の失敗・not sent・戻しの失敗）× tool、報告と台帳の整合を 1 つの関数で見る。直す前に赤：E1・E2（empty の `skipBoundary` が投げる／行を変えない → 本文を打ち A は `pending`、報告は `skipped(empty)`）・E3（empty × not sent → A が `skipped(empty)`）・I2（decline × not sent × 戻しの失敗 → 次の decline が A を `unknown` にして打つ）、変異 M1・PM Claude P2-1（条件 4 を外す）・P3-1（条件 5 の `claimed` を外す）。route の 400（strict × slash・strict × 境界の無い tool）は `send-brief-choice-4227.test.ts` |
| 24 | pr3f：P3-4（記録のみ） | API を直に呼ぶときだけ起きる組み合わせ：`briefBoundary` × `auto` の短い要約は受け取って使わない（画面が送るので 400 にしない、§3.2）。strict × 境界の無い tool は pr3f で 400。`attended` はサーバーで見ないので CLI などからも strict を送れるが、述語と commit がすべて止める |

---

## 12. 共通規則の全読者（G-PR1 の実装の後、5-2b の前に書いた）

G が使う共通の規則ごとに、規則を持つ 1 か所と、それを読む所（書き手・読み手・試験・文書）を全部挙げる。G-PR1 の行は実装した時点のファイルを `git grep` で確かめた［事実］。**G-PR2 の欄は G-PR2 を実装した時点のファイルで書き直した［事実］**（5-2b の前）。**G-PR3 の欄（「G-PR3［事実］」）は G-PR3 を実装した時点のファイルで書き直した**（5-2b の前、§11.22）。規則を変えるときは、この表の全読者を同じ PR で直す。

| 規則 | 持つ所（1 か所） | 読む所（G-PR1 の時点［事実］） | 後の PR で足す読者［見立て］ |
|---|---|---|---|
| 画面の印（`X-CommandMate-Client: screen` と `Origin` の一致） | `src/lib/security/screen-request.ts` の `isScreenRequest`・`screenRequestHeaders` | 判定：`settings-service.ts`（mode の書き込み）・`notices/[noticeId]/acknowledge/route.ts`（B）・`promote/service.ts`（E）・**`mem/service.ts` の `memWriteFromScreen`** と **`…/mem/screen/items/**/route.ts` の 3 本**（G-PR1、route と service の両方で見る）。付ける側：`mem/screen-client.ts` の `memSettingsApi`・**`memItemsApi`**（G-PR1）・`promote/screen-client.ts`。試験：`tests/unit/guards/mem-mode-write-screen-only.test.ts`・`mem-promote-screen-only-4225.test.ts`・**`mem-screen-write-4227.test.ts`**・**`lib/mem/screen-write-entrances-4227.test.ts` の H6 の行** | G-PR2［事実］：判定は handoff の画面の route 10 本（`requests`・`sent`・`send-failed`・`extend`・`cancel`・`decide`・`proposals/[pid]/rebase`・`end`・`end/observe`）と service の `handoffCreate`・`handoffCancel`・`screenStep`（`sent`・`send-failed`・`extend`）・`handoffRebase`・`handoffDecide`・`handoffEnd`・`handoffObserve`（route と service の両方）。付ける側は `src/lib/handoff/screen-client.ts` の `handoffApi`。印の要らない口は `GET …/requests/:rid` と Agent の `proposals`・`done`。試験：ガード `handoff-screen-only-4227`・`handoff-entrances-4227.test.ts` の H6 の行 |
| 人の書き込みの最終の区間の照合（S-A の (i) 所属・(ii) mode `on`・(iii) 世代と寿命・(iv) 要求のブランチ） | `mem/service.ts` の `memWriteFromScreen` の中の `write`（`resolveTarget` の同期の build を 1 つの `db.transaction` で包む） | 呼び手：`…/mem/screen/items/route.ts`（`add`）・`[itemId]/route.ts`（`update`）・`[itemId]/close/route.ts`（`close`）。試験：`write-entrances-recreate-4221.test.ts` の `screen-*` の 4 行・`screen-write-entrances-4227.test.ts`。文書：`docs/user-guide/cli-operations-guide.md`・`docs/en/…` の「項目を画面で見る・書く」 | G-PR2［事実］：`src/lib/handoff/decide.ts` の `handoffDecide`（`author:'proposer'`・`pin`（依頼の世代・在籍の寿命・所属）・`fence`（依頼が `applying` で同じ `apply_token`・提案が `approved` で同じ版と指紋・期限の内・同じ会話）・`approval`（PM P3-a の印）を渡す）。試験：`handoff-flow-4227.test.ts` の H4(b)・H13・H14(d) |
| 在籍の寿命の比較（`null → lazy` は同じ、`roster` の発行は別） | `src/lib/db/session-brief-db.ts` の `isSameInstanceLifetime`・`readInstanceLifetime` | `session/session-boundary.ts`・`brief/build.ts`（D1・C）・**`mem/service.ts` の `memWriteFromScreen`**（G-PR1）。A の `createMemItem` の `settleActorIncarnation` は別の（より厳しい）規則で、読んだ時点で無かった世代が書き込みの前に発行されていれば断る［事実。G は変えない。H14(c) は `update` で固定した］ | G-PR2［事実］：`src/lib/handoff/common.ts` の `sameConversation`（作業木の世代・D1 の今の境界の `id`・`isSameInstanceLifetime`）を `judgeRequest`（全入口の読みと書きの前）・`decide` の `fence`・`end/observe` の記録・作成の「生きている依頼」の判定が読む。依頼の作成は `readInstanceLifetime` で寿命を固定する |
| 遷移の表（`withdraw-recorded` を含む） | `src/lib/mem/transitions.ts` の `memTransition` | `mem-db.ts` の `updateMemItem`・`closeMemItem`・`closeMemItemByCondition`・`transitionDecision`・**`closeMemItemVersioned`**、`mem/evaluate.ts`。`withdraw-recorded` を渡すのは `memWriteFromScreen`（人・`confirmUnreflected:true`・`recorded` の決定）だけ（ガードで固定、CLI と提案の側に文字列が無い） | G-PR2［事実］：`src/lib/handoff/proposals.ts` の `checkProposal`・`handoffRebase` が `memTransition(kind, state, 'update'\|'close')` を読み、決定の `close` は `open` だけ（`recorded` は 409 `state_forbids`）。`withdraw-recorded` の文字列を持たない（ガード `mem-screen-write-4227`）。`memWriteFromScreen` は `withdraw-recorded` を `author:'human'` のときだけ選ぶ（承認の印で人として書く提案の確定でも選ばない） |
| 版の照合（`ifVersion`） | store の各関数の transaction の中（`updateMemItem`・**`closeMemItemVersioned`**・`transitionDecision`） | 画面：`MemItemsPanel.tsx` が読んだ版を送り、409 で 3 つの値を並べる。試験：H3・H16(a) の行・部品の試験・e2e | G-PR2［事実］：`decide` は提案の `base_version` を `ifVersion` に渡し（項目の版）、依頼の版は `decide`・`rebase`・`extend`・`end` の `ifVersion`（`changeHandoffRequest` の版の条件）。試験：`handoff-entrances-4227.test.ts` の H3 の行・`handoff-flow-4227.test.ts` の H13(a)(b)・H18(a) |
| 画面の 5 つの規則（§2.4.1） | `MemItemsPanel.tsx`（`editChanges`・`readSnapshot`・`pendings`（操作ごとの単位・`pendingSendable`）・`Closing.read`・比較と一覧に無い送り直しを出す単位の側 `mem-items-units`・単位が持つ表示（`draft`・`closing`）と項目ごとの比較（`conflicts`・`closeConflicts`）、規則 (4d)・送信中の `inflight` と書き込みを止める `lock`・`sendOne`、規則 (4e)）と `transitions.ts` の `memScreenActions` | 試験：`MemItemsPanel-screen-rules-4227.test.tsx`・`MemItemsPanel-write-lock-4227.test.tsx`（(4e) の表）・`MemItemsPanel-4227.test.tsx`・e2e `mem-ui-4227.spec.ts`。文書：`docs/user-guide/cli-operations-guide.md`・`docs/en/…` の「同時編集」「送り直し」「ボタン」 | G-PR2［事実］：`SessionHandoffDialog.tsx`（`decide` の単位：送信中 `inflight`・結果不明 `pending` を同じ要求のまま送り直す (4)、送るのは人が選んだ提案だけ (2)、版は読んだ依頼の版 (3)、送り直しの 409 は成功と読まず今の状態を出す (4c)）と、画面をまたぐ (4e) の共有の lock `src/components/mem/mem-write-lock.ts`（`MemItemsPanel.tsx` と `SessionHandoffDialog.tsx` の承認・捨てる・載せ替え・延長が同じ lock。知らせの引き取り・mode の設定・取り消し・停止は外、PM P3-3）。試験：`SessionHandoffDialog-4227.test.tsx`・`MemItemsPanel-write-lock-4227.test.tsx` の画面をまたぐ表と mode を off にした行 |
| 引き継ぎのダイアログの閉じ方と単位の store（§4.1.1、pr2d・pr2e・pr2f） | `src/lib/handoff/close-rule.ts` の `handoffCloseBlock`・`askHandoffClose`・`closeHandoffOpening`・`HANDOFF_CLOSE_PATHS`、送信単位と開いた回の型（`SentHandoffDecide`・`HandoffOpeningToken`、pr2f）、単位と開いた回の store（`startHandoffDecide`・`settleHandoffDecide`・`dropHandoffUnit`・`startHandoffStop`／`endHandoffStop`・`startHandoffCancel`／`endHandoffCancel`・`beginHandoffOpening`・`handoffTextSendable`）と `SessionStopResult` | G-PR1 には読者が無い | G-PR2［事実］：`SessionHandoffDialog.tsx` の `closeBy`・`requestClose`・`plainStop`（`person`・`cancel-answer`・`plain-stop-done`）と store の読み書き、`useWorktreeDetailController.ts` の `closeHandoffBy`（`worktree-switch`・`page-end`・`dialog`）・`openEnd`・`openHandoff`（開いた回を始める）・`stopSession`（`SessionStopResult` を返す）、`WorktreeDetailDesktop.tsx` の `onHandoffStop` の型。試験に `WorktreeDetailRefactored-handoff-units-4227.test.tsx`（実画面の描き直し）。試験：`SessionHandoffDialog-close-table-4227.test.tsx`（経路 × 状態 × 作業木）・`SessionHandoffDialog-4227.test.tsx` の pr2c の表・store の表 `close-rule-continuations-4227.test.ts`（pr2f）・ページの `stale` の枝 `useWorktreeDetailController-handoff-stale-4227.test.tsx`（pr2g）・ガード `handoff-close-paths-4227`（pr2g から書き手の受け渡しと計算された指定子も）。文書：ja/en の `cli-operations-guide.md` の「引き継ぎの終わり方」。G-PR3［事実］：store に項目の画面の単位（`items`、書き手 `startMemItemsWrite`・`settleMemItemsWrite`・`dropMemItemsUnit`、読み手 `memItemsUnitsOf`・`memItemsUnitsAll`・`memItemsUnitsLock`）を足し、`MemItemsPanel.tsx` が読み書きする（§4.1.1 の bullet）。ダイアログは別の作業木の結果不明を出して捨てさせる（pr2e P3-2）。ガードは `STORE_IMPORTERS` にパネル、`STORE_IMPORTER_VALUES` でパネルの取れる値を固定。試験：`MemItemsPanel-write-lock-4227.test.tsx` の G-PR3 の describe（再 mount で単位が残る・両向きの lock）・`SessionHandoffDialog-pr3-4227.test.tsx`・ガードの G-PR3 の describe |
| 人が書いた項目は人だけが変える・閉じる（D6） | `mem-db.ts` の `ownedBy`（`createdBy='human'` かつ `now` でない項目は `actor.by='agent'` に偽） | 書き手：`updateMemItem`・`closeMemItem`・`closeMemItemVersioned`（Agent の入口 `memUpdateItem`・`memCloseItem`、`memWriteFromScreen` の `author:'agent'`）。条件の close（`closeMemItemByCondition`）は読まない（誰の項目も閉じる）。試験：`write-entrances-recreate-4221.test.ts` の D6 の表。文書：ja/en の「人が書いた項目」・画面の `limits`・`refusal.not_owner` | G-PR2［事実］（PM P3-a）：`memWriteFromScreen` の `approval`（`decide` だけが渡す印）。印は `handoff-db.ts` の `approvalMarkHolds` がサーバーの行だけで判定する（提案が同じ `apply_token` で `approved`・承認した指紋 `approved_fingerprint` が今の列から計算し直した指紋と同じ・同じ op と項目・依頼が `applying`・同じ作業木と instance）。通れば `update`・`close` の書き手は `human`（人の項目も変えられる）、`add` は Agent のまま（U6）。書き込みと同じ transaction で `consumeApprovalMark` が `applied` にする（1 回だけ）。印が通らなければ 409 `not_approved`。印の無い proposer は Agent として書く（人の項目は `not_owner`）。試験：`write-entrances-recreate-4221.test.ts` の D6 の表の 4 行（承認済みの確定・承認の無い proposer・承認の後に内容が変わった提案・使用済みの承認での 2 回目）と印の照合を外す変異の対照、1 回だけの対照 |
| 本番 DB を守る（試験・vitest・verify） | 各契約の前提（`export CM_DB_PATH=$PWD/data/test.db` を先に） | G の試験はすべて `os.tmpdir()` の一時 DB（`openMigratedFileDb`）を開き、本番の DB を開かない。e2e は API を stub し、サーバを起動しない | G-PR2［事実］：`tests/unit/lib/handoff/handoff-harness.ts` が `os.tmpdir()` の一時 DB を開く。observe の route の試験は `:memory:`。G-PR3［事実］：`handoff-pre-end-4227`・`handoff-request-open-text-4227` は同じ harness、`handoff-start-preview-4227`・`brief-full-detail-4227` は C の `BriefWorld`（`os.tmpdir()`）、`session-brief-choice-4227` は D1 の 4274 の world（`os.tmpdir()`）、送信の route の試験は `:memory:` |
| 古さ（`stale`） | `src/lib/mem/staleness.ts` の `memItemStaleness`（`present.ts` が一覧の `stale` に入れる） | 画面は一覧の `stale` を出すだけで計算しない（`MemItemsPanel.tsx`） | F（#4226）の促し。G-PR3［事実］：preview（`preview.ts` の `openLinesOf`）は一覧の結果を数えるだけで `stale` を読まない |
| 対話・無人の設定（`popup`） | A の `mem_repository_settings.popup`・`mem_branch_overrides.popup` → `decideRootMode` の `features.popup` | 書く：`settings-service.ts`（画面だけ）。説明：`RepositoryMemSettings.tsx` の `mem.featureHelp.popup`（S-E）・文書の「項目を画面で見る・書く」の最後の項。**G-PR1 では分岐に読まない**（auto-yes も読まない） | G-PR2［事実］：`useWorktreeDetailController.ts` の `openEnd(target)`・`openActiveEnd`（押すたびに `GET …/mem/mode` を読み、`mode==='on'` かつ `features.popup` で G-4、それ以外・読みの失敗・`END_MODE_READ_TIMEOUT_MS`（5 秒）で答えないときは今の確認）と `handoffCreate`（`popup` が偽なら 409 `unattended`）。「終了」は全部これに繋いだ：PC のヘッダー（`WorktreeDetailDesktop.tsx` の `onKillSession`）・各分割の「終了」とロールの再起動（`onRequestSessionEnd` → `openEnd`）・スマホの「…」の「終了」（`WorktreeDetailRefactored.tsx` の `MobileTerminalActionsSheet` の `onEnd`）。G-4 は `WorktreeDetailDesktop.tsx` とスマホの `WorktreeDetailRefactored.tsx` が `SessionHandoffDialog`（`onStop` は hook の `stopForHandoff`＝`handleKillConfirm` と同じ `stopSession`）として描く。G は kill しない。試験：`useWorktreeDetailController-handoff-end-4227.test.tsx`（分岐の表・期限・作業木の切り替え・停止の対象）・`WorktreeDetailRefactored-handoff-end-4227.test.tsx`（PC・スマホの配線）・e2e `mem-handoff-4227.spec.ts`。G-PR3［事実］：G-3 の出す条件は `src/lib/handoff/preview.ts` の `handoffStartPreview`（`features.popup`・mode `on`／`derived`・`features.injectOnStart`・今の境界が `pending`）。読むのは `MessageInput.tsx`（`fetchStartPreview`）。試験：`handoff-start-preview-4227.test.ts`（出す条件の 5 行）・`MessageInput-start-brief-4227.test.tsx` |
| 宣言の前の古い要求と宣言済みの観測の要求（6 回目 P2(2)） | G-PR2 の `src/lib/handoff/request.ts`（会話の寿命の判定）と `end.ts`（観測）［見立て］ | G-PR1 には読者が無い（設計書の §4.3・§4.4・§4.6・H15・§7.5 だけ） | G-PR2［事実］：`common.ts` の `judgeRequest`（開いた依頼は期限か会話の変化で `expired`、`ending` は期限だけ）を `GET`・`propose`・`done`・`decide`・`rebase`・`extend`・`sent`・`send-failed`・`cancel`・`end`・`end/observe`・作成の「生きている依頼」の判定が通る。`end.ts` の `handoffObserve` は会話を先に比べ、違えば `ended`・`unconfirmed(session_changed)`（強制なら `forced`）。試験：`handoff-flow-4227.test.ts` の H15(a)(e)・`handoff-entrances-4227.test.ts` の H1。e2e：`tests/e2e/mem-handoff-4227.spec.ts` の「停止の後の起動し直し」（宣言の後・観測の前の再読込は `ending` のまま、観測で `unconfirmed(session_changed)`、新しいプロセスは動いたまま） |
| 停止の観測（`cliTool.isRunning(worktreeId, instanceId)`、6 回目 P2(1)） | `src/lib/cli-tools/base.ts` の `isRunning`（session 名は中で `getSessionName` が作る） | `src/app/api/worktrees/[id]/kill-session/route.ts`（既存）。G-PR1 には G の読者が無い | G-PR2［事実］：`…/handoff/requests/[rid]/end/observe/route.ts` の `readRunning`（`resolveSessionTargetStrict` で roster の tool → `isRunning(worktreeId, instanceId)`、読みの失敗は null）を値で `handoffObserve` に渡す。session 名を渡さない。試験：`tests/unit/api/handoff-observe-isrunning-4227.test.ts`（primary・追加の instance で kill-session の route と同じ引数・同じ session 名、`isRunning` が真・投げる で `not_stopped`・`confirmed` にならない） |
| 開くときの選択と境界（S-B、§3.2） | `src/lib/session/session-brief.ts` の `SendBrief`（`strict`＝`decline` か `auto`＋`full`、plan の中止 `refuse`→`planAbort`、pr3f の一本道 `claimStrict`→`commitInFinalStretch`→`finalReading`→`commitStrict`（`STRICT_COMMIT_RULES`・`StrictCommit`）、`BriefChoiceAbortedError`、`settleUnbriefedInLock`）と `session-brief-db.ts` の `settleDeclinedClaim`（`declined`・`empty`）・`BoundarySkipReason` の `declined` | G-PR3［事実］：送信の route（`send-request.ts` の `validateBriefChoice` と pr3f の 400 `STRICT_BRIEF_NOT_FOR_COMMAND`・`STRICT_BRIEF_NOT_FOR_TOOL`、`route.ts` の 409 `boundary_changed`）・`send-user-message.ts`（型で読み `stage:'brief_choice'`、`classifySendFailure` に渡さない。pr3f の型 `StrictBriefNamesBoundary`）・画面 `api-client.ts`（`SendBriefChoice`・`SendBriefReport`・`isBriefBoundaryChanged`）・`MessageInput.tsx`・`src/cli/types/api-responses.ts`（`consumed`・`declined`・`claim_held`）。試験：`session-brief-choice-4227.test.ts`（H21）・`session-brief-final-reading-4227.test.ts`（表 1）・`session-brief-commit-4227.test.ts`（表 2、H23）・ガード `session-brief-strict-commit-4227.test.ts`・`send-brief-choice-4227.test.ts`（route）・4274 の入口の表の decline の行・`session-brief-write-rule-4224` の WRITERS・D2 の入口の表 |
| 全文（S-F、§0.0） | `src/lib/brief/fit.ts` の `FitTextOptions.itemCap`（`uncapped`）と `provider.ts` の `detail === 'full'` | G-PR3［事実］：`brief-provider.ts` の `BriefRequest.detail`、`session-brief.ts` の `briefBudget(…, detail)`（`BRIEF_BUDGET.text.max` と #2464 の小さい方）。`render.ts` は変えていない。試験：`brief-full-detail-4227.test.ts`（H20 (b)〜(h)） |
| 人への質問の分類（§3.1.1） | `src/lib/handoff/preview.ts` の `classifyHumanQuestions` | G-PR3［事実］：`handoffStartPreview` と route `…/mem/start-preview`。画面 `SessionStartBriefDialog.tsx`。試験：`handoff-start-preview-4227.test.ts`（H22、C の実際の JSON） |
| 終わる前の更新の読み口（S-C） | `src/lib/handoff/pre-end.ts` の `readHandoffPreEndUpdate` | G-PR3［事実］：試験 `handoff-pre-end-4227.test.ts`。pr3c［事実］：D2 の `previous-end.ts` の `readPreEndUpdate` が呼び（1 行）、`build.ts` の `readPreviousEndOnce` → `previousEndLead` の X4 が読む。試験 `brief-previous-end-4224.test.ts` の S-C の describe（`buildBrief` から） |
