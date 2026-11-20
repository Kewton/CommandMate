# 決定の承認の導線 — 承認待ちの件数・行き先と期限・二重の検知・承認前の修正・機械で決まる片付け（Issue #4354）設計

- 段: 設計（この文書だけ）。コード・DB・試験は書かない。人の決定（§8、11-19、mem 91b25c73）を受けて、§7 の PR ごとに別の契約で行う（Sprint 9 以降）
- 版: 第 3.1 版（2026-11-19、イネーブラー claude-5）
  - 第 3.1 版: 第 3 版の確かめの N4（purge で 24 時間の記録を消せる）の処分。§10.4
  - 第 3 版: 第 2 版の確かめ（`workspace/orchestration/runs/2026-11-19/s8/verify-4354-v2.md`）の処分。A P1-1 の残り・N1〜N3・R1 を反映した（PM の依頼 `pm-req-4354-v3.md`）。処分は §10.3
  - 第 2 版: 設計レビュー 2 本（A: データと契約の安全、`workspace/orchestration/runs/2026-11-19/s8/review-4354-a.md`／B: 既存の設計・文書との整合と使い勝手、`review-4354-b.md`）の処分を反映した。処分の表は §10
  - 第 2 版: PM の決定（`pm-req-4354-review-disposition.md`）を反映した。Q3〜Q8 は PM が範囲の中で決め、人へは Q1・Q2 だけを渡す
  - 第 1 版: `795d5b7f4`
- 基準: develop `b8f6e33b8`（v0.53.0）。行番号はこの版のもの。「事実」は file:line、「見立て」「未確認」は明記する
- 正: Issue #4354 の本文・追記（2026-11-15）・コメント（2026-11-15 の衝突の指摘、2026-11-17 の順番、2026-11-19 の Sprint 8 は設計だけ）
- 関連:
  - #4225（承認の画面、`docs/design/mem-promote-4225.md`）
  - #4355（決定の画面・件数の共有関数、`docs/design/mem-decisions-ux-4355.md`）
  - #4222（条件の評価、`mem-close-when-4222.md`）
  - #4221（store、`mem-store-4221.md`）
  - #4223（brief、`brief-4223.md`）
  - #4228（skill、`mem-skills-4228.md`）
  - #4248（Dreaming。この設計の §6 を入力にする）

---

## 0. 結論（先に）

1. **衝突の扱い（§2）**: 推奨は案 1。decision は、行き先か期限のどちらかを必須にする。期限だけの decision を「許可」と呼ぶ
   - 許可は、行き先を持たない代わりに、短い期限（最長 7 日）を必須にする
   - 許可は、承認待ちとは**別の数で、同じバッジの場所に必ず出す**（見えない許可を作らない）
   - 期限は既存の `close_when` の `at` に載せ、「期限である」印（`expires: true`）を付ける。DB の列は足さない
2. **期限の意味（§3.2）**: 期限で機械が閉じるのは、**印つきの期限を持ち、行き先の無い `open` の decision（許可）だけ**
   - 行き先のある decision は、期限を過ぎても反映前なら閉じない（I2）
   - 印の無い既存の `at` は、今の意味（未反映の印だけ）のまま（I6）
   - 行き先を外す update は断る（I2 の迂回を塞ぐ）
3. **規則の置き場所（§3.1）**: 作成・update の規則は store 層（`createMemItem`・`updateMemItem` のトランザクションの内側）に置く。CLI・画面・handoff の提案の適用の 3 つの経路が、同じ規則で断る
4. **promoted（§3.3）**: 状態を変えずに、件数（上限の警告・承認待ち）から外す（P-a。PM の決定）。brief の出し方は変えない（`brief-4223.md` §2.3 の順位 10 のまま）
5. **件数（§4.1）**: `decisionCountsOf` の既存の `open`・`recorded` の意味と型は変えない。次の欄を**足す**:
   - `pending`（行き先ありの `open`）
   - `grants`・`expiredGrants`
   - `noDestination`（行き先なしで印つきの期限の無い `open`。条件を問わない）
   - `endedGrants`・`withdrawnDecisions`（直近 24 時間に終わったもの）
   - **どの `open` も必ずどれか 1 つの欄に入る**（和が `open` と一致する）
   - バッジは「承認待ち N・反映待ち R・許可 M」を出す。決定の画面には、直近 24 時間に終わった許可と取り下げた決定も出す
6. **二重の検知（§4.3）**: サーバーが差分（preview）を作るときに、完全一致を照らして preview に記録する
   - 人は画面で「記録済みにする」を選べる（`open → promoted`、外へは書かない）
   - 一致の事実は、サーバーが preview に残した値だけを使う
7. **承認前の修正（§4.4）**: `mem update` に `--promote-to`・`--quote`・`--quote-at`・`--expires-at` を足す。作成者の instance だけが、`open` のあいだだけ直せる。行き先を外す形は作らない
8. **#4248 へ（§6）**: `expire` は、書き込みの評価の口（`list`・`check`・`brief`・`preview`）でだけ走る。`dream-input` は純粋な時刻の比較だけを使う

### 0.1 Issue の要求と、この設計の対応（B P2-7）

| Issue の要求 | 対応 | 節 |
|---|---|---|
| 直し方 1・受入 1: 承認待ちの件数を固定の場所に出し、決定の画面へ行ける | 満たす（バッジ。許可の数も同じ場所に出す） | §4.1 |
| 直し方 2・受入 2: 行き先なしの decision を作れない（または既定の行き先が付く） | **読み替え（人の了承 Q1・Q2）**: 「行き先も期限も無い decision を作れない」。期限だけの decision（許可）は、最長 7 日・バッジに出す条件で許す | §2・§3.1 |
| 直し方 3・受入 3: 書く先に同じ本文があれば、差分の画面が示す | 満たす（完全一致。確かめた範囲を明記） | §4.3 |
| 直し方 4・受入 4: 承認前の引用の時刻と行き先を作成者が直せる（承認後は直せない） | 満たす（行き先を外す変更だけは断る） | §4.4 |
| 直し方 5: 画面の冒頭の説明 | 満たす（PM の決定 Q6: 書く） | §4.2 |
| 追記 1: promoted を自動で閉じる（少なくとも上限の数に入れない）。閉じたことを理由つきで記録する | **読み替え（PM の決定 Q4: P-a）**: 「上限の数と承認待ちに入れない」だけを満たす。閉じないので「閉じた理由」の記録は無い。promoted は残り続け、人が閉じるか purge する | §3.3 |
| 追記 2: 期限つきの決定を、期限の後の評価で理由つきで閉じ、前は閉じない | 満たす（許可だけ）。理由は `time-passed`（PM の決定 Q4。`expired` の値は足さない） | §3.2 |
| 追記の受入: mem・brief・check がモデルを呼ばない | 満たす（既存の表に行を足す） | §5 |

---

## 1. 今の作り（事実）

| # | 事実 | 出典 |
|---|---|---|
| F1 | decision の状態は `open`・`recorded`・`promoted`・`closed`。承認は画面だけ（`screen_only`）。`open → recorded`（効果 `spec`）・`open → promoted`（効果 `record_only`）・`recorded → promoted` | `src/lib/mem/transitions.ts:49-66`、`mem-promote-4225.md` §1.1 |
| F2 | 条件の成立で閉じる遷移（`condition`）は、decision では `promoted` からだけ。`open`・`recorded` で成立しても閉じず、`unreflected` の印だけを付ける | `transitions.ts:56-57`、`src/lib/mem/evaluate.ts:442-444` |
| F3 | decision に付けられる条件の型は `issue`・`pr`・`branch`・`at`。省略時は NULL（遷移だけで閉じる） | `src/types/mem.ts:74`・`:84-91` |
| F4 | 条件の評価は `list`・`check`・`brief`・`preview` のきっかけで走る。新しいタイマーは無い（D13） | `src/types/mem.ts:344`、`evaluate.ts:416-470` |
| F5 | decision の作成で `--promote-to` は任意。行き先の無い `open` の decision は、`mem check --suggest` の `decision_no_destination` が知らせるだけ | `src/cli/commands/mem.ts:430`、`src/lib/mem-suggest/rules.ts:172-173` |
| F6 | 承認の差分は、本文の `destination` か項目の `promoteTo` を行き先にする。画面で選んだ行き先は、項目の `promote_to` に書き戻さない。このため `recorded`・`promoted` でも `promote_to IS NULL` がありうる（レビュー A の補足） | `src/lib/promote/service.ts:447-450`、`mem-db.ts`（`promote_to` の UPDATE は無く、INSERT の `:498`・`:711` だけ） |
| F7 | `mem update` が直せるのは `text`・`close_when`・`evidence` だけ | `src/cli/commands/mem.ts:474-480`、`src/lib/mem/service.ts:579`、`mem-db.ts:913` |
| F8 | open の件数は `state != 'closed'` で数える。使い手は上限（`mem-db.ts:705`）・警告（`mem/service.ts:322`）・suggest（`mem-suggest/service.ts:393`）。decision の警告は 20 件から（上限は無し） | `mem-db.ts:283-290`・`:607-614` |
| F9 | 件数の共有関数 `decisionCountsOf` は、`open` と `recorded` だけを数え、行き先を見ない。mode が `ambiguous` なら null | `src/lib/promote/decision-counts.ts:44-53` |
| F10 | brief は `closed` 以外の decision を全部出す（`recorded` は rank 4、ほかは 10）。`brief-4223.md` §2.3 と `mem-skills-4228.md` の順位表も `promoted` を出す側に書いている | `src/lib/brief/sources.ts:451-452`・`:507-521`、`brief-4223.md:162`、`mem-skills-4228.md:92` |
| F11 | `close_reason` の値は 5 つで、DB の CHECK で固定している | `src/lib/db/migrations/v66-mem-store.ts:121` |
| F12 | 承認の操作の効果は `spec`・`record_only` の 2 つで、DB の CHECK で固定している | `v69-mem-promote.ts:46`・`:81` |
| F13 | decision の作成の口は 2 つ。`memAddItem`（CLI・API、`mem/service.ts:369` → `:403`）と、`memWriteFromScreen`（画面、`:697` → `:772`）。後者の `op:'add'` は `now` 以外の全 kind を受ける（`:578`・`:600-620`）。handoff の提案の適用も、後者の経路に乗る（`src/lib/handoff/proposals.ts`）。第 1 版の「画面の経路は未確認」は誤り（レビュー A・B） | 左 |
| F14 | `at` の検査は書式だけで、過去の時刻も通る。第 1 版の「既存の検査に乗せる」は誤り（レビュー A） | `src/lib/mem/close-when.ts:153-158`・`:299-300` |
| F15 | `at` の成立の答えは `met('time-passed', 'unknown', …)`。成否は `unknown`。第 1 版の「成否 `success`」は誤り（レビュー A） | `src/lib/mem/condition-evaluators.ts:144` |
| F16 | 保存した条件の読み取り（`readStoredCloseWhen`）は、`schema` と `type` だけを確かめる。ほかの欄があっても、そのまま読む | `close-when.ts:340-349` |
| F17 | 決定の画面の一覧の上に「承認待ち N 件・反映待ち M 件」を出す。ブランチの select の行には件数を付けない（#4355 PR2 の処分 5-2b） | `docs/user-guide/cli-operations-guide.md:3842`・`:3840`、`mem-decisions-ux-4355.md:98` |

### 1.1 運用の実測

**(a) `commandmatedev mem list --all --json`（2026-11-19 午後、このブランチ）**
- decision は 83 件。内訳:
  - `closed`・`withdrawn`: 53 件（行き先あり 28・なし 25）
  - `closed`・`manual`: 12 件
  - `promoted`: 3 件
  - `open`: 15 件（行き先あり 10・なし 5）
- 行き先の無い 25 件の取り下げは、ほとんどが「自走 N 時間」「Auto-Yes の許可」「段 N のリリースの許可」のような期限のある許可だった（本文の先頭を目で見た読み。全件の分類はしていない）
- 許可の長さ: 本文から読めた範囲では 4〜24 時間。リリースの許可は「この版の受け入れに合格するまで」で、1〜2 日だった（読み）

**(b) 本番の DB の読むだけの集計（2026-11-19 20:06 JST）。レビュー A P1-3 の求め**
- 方法: `sqlite3 'file:<CM_DB_PATH>?mode=ro'`
- decision は 12 件で、全部が `open`（行き先あり 6・なし 6）。`close_when` を持つ decision は 0 件
- (a) の後に、閉じた decision は purge されていた（見立て。PM の棚卸し）
- 範囲: このインストールの DB だけ。ほかの利用者の DB は見ていない
- 結論: このインストールでは「行き先なし・`at` あり」の既存の行は 0 件。ほかのインストールにはありうるので、§3.2 の印で守る（I6）

---

## 2. 衝突: 行き先の必須化と、期限つきの許可（行き先なし）

Issue の直し方 2（行き先の必須化）と追記 2（期限つきの決定）は、そのままでは両立しない。§1.1 のとおり、許可の決定は行き先を元々持たない。

### 2.1 不変条件（どの案でも守る）

| # | 不変条件 | 破れるとどうなるか |
|---|---|---|
| I1 | 承認（画面の `screen_only` の経路）で外へ書く decision は、書く前に行き先が決まっている | 承認しても書く先が無い（事象 2） |
| I2 | 行き先のある decision は、反映（`promoted`）の前に機械が閉じない。期限を過ぎても閉じない。**行き先を外す変更でこれを迂回できない** | 人の決定が正本に入らないまま消える（`team.md` §11 の 3） |
| I3 | 期限で閉じる・数から外すのは、機械で決まる値（時刻・状態・印）だけで判断する。モデルを呼ばない。評価できないとき（mode が `on` でない・条件の JSON が読めない・schema が違う）は閉じない | 推測で人の決定を閉じる（#4419・#4430 の「外れうる観測で消す」） |
| I4 | 件数は 1 つの関数で数える。分からないときに 0 と言わない。**見えないものを無いと言わない**（許可の数も必ず出す） | 画面ごとに数が違う／許可が人の目に入らないまま有効になる |
| I5 | エージェントが人の決定を「承認済み」にする口を作らない（画面だけ）。#4354 で足す遷移もすべて画面の印を要する | エージェントが人の決定を作れる（#4225 D9） |
| I6 | 既にある decision の意味を、この変更で黙って変えない。行き先も期限も無い既存の `open` と、**印の無い既存の `at` を持つ decision** は、今の意味のまま | 移行で既存の決定が閉じる・消える |
| I7 | 規則は、作成と update のすべての経路（CLI・API・画面・handoff の提案の適用）に同じく効く。store 層のトランザクションの内側に置く | 1 つの経路だけ規則を通らない |

### 2.2 案

| | 案 1（推奨）: 行き先か「短い期限」のどちらかを必須にする | 案 2: 許可を別の kind（例 `grant`）にする | 案 3: 既定の行き先を持たせる |
|---|---|---|---|
| 中身 | decision は `--promote-to` か `--expires-at` の少なくとも一方を要する。両方とも無ければ 400 `destination_required`（exit 2）。行き先の無い期限つきの decision を「許可」とする。許可の条件は次の 3 つ:<br>1. 期限は時刻だけ<br>2. 作成の時点から 5 分〜7 日<br>3. バッジに「許可 M」として出し、期限の後の評価で閉じる | `MEM_KINDS` に `grant` を足す。grant は期限が必須で、行き先も承認の流れも持たない。decision は行き先を必須にする | リポジトリの設定に「決定の既定の行き先」を持ち、`--promote-to` の無い decision に付ける |
| 推測の残り | 無し（時刻・状態・印だけ） | 無し | 無し |
| DB の変更 | **無し**（`close_when` の `at` に印を足すだけ、F16） | `mem_items` の作り直し（kind の CHECK、`v66-mem-store.ts:99`）。ほかの表が `mem_items(id)` を参照する（`v67-mem-close-records.ts:26`・`:54`） | 設定の列を足す（追加だけ） |
| 利用者の手間 | 許可を書くときに期限を書く（今も本文に「〜11-17 23:00」と書いている）。7 日を超える許可は書き直す | 許可と決定の区別を覚える | 許可も承認すると正本に書かれ、溜まる |
| 承認の流れとの関係 | 行き先のある decision だけが承認の流れに乗る。許可は承認の外だが、数と一覧で人に見える | 同左 | 全部が承認の流れに乗る（§1.1 の詰まりが増える） |
| 実装の大きさ（見立て） | 小〜中 | 大 | 中 |

### 2.3 推奨と、捨てた理由

**推奨は案 1。**
- I1〜I7 を DB の作り直しなしで満たせる
- 今の使い方（許可を decision に書き、期限が来たら手で取り下げる）を、その形のまま機械の片付けに置き換えられる
- レビュー A P1-1 の「期限を遠くにすれば門を素通りできる」は、次の 2 つで塞ぐ:
  - 最長 7 日の期限
  - 許可を必ずバッジと一覧に出すこと（I4）

**案 2 を捨てた理由**:
- `mem_items` の作り直しの migration が要る（F11 と同じく CHECK のため）
- mem の表どうしの参照もあり、移行の検証の費用が大きい
- 案 1 の許可は、後で grant を足したくなったときに写せる

**案 3 を捨てた理由**:
- 許可まで承認の流れに乗り、§1.1 の詰まりを増やす
- 正本が期限切れの許可で埋まる

### 2.4 許可の期限を時刻だけにする理由（レビュー B P2-1）

- 「この PR のマージまでの許可」のように、PR・Issue の条件で終わる許可も考えられる
- しかし PR の条件は「不明」の答え（認証切れ・ネットワーク）がありえて、成立しないまま残りうる（F2・D8）
- 最長の期限で上限を保てるのは時刻だけ
- PR の条件で終わる許可は、時刻に書き直してもらう。拒否の文で書き直し方を示す（§3.1）
- PR の条件と時刻の両方を持つ形（どちらか早いほう）は、`close_when` が 1 つしか持てないので v1 では作らない

---

## 3. store と評価の変更（案 1）

### 3.1 作成と update の規則（store 層、I7）

規則は 1 つの関数 `checkDecisionDestinationRule(prev, next, now)`（名前は見立て、`src/lib/mem/validate.ts`）に置く。`createMemItem`（`mem-db.ts:659`）と `updateMemItem`（`mem-db.ts:875`）が、トランザクションの内側で呼ぶ。CLI・API・画面・handoff の提案の適用は、どれもこの 2 つの関数を通る（F13）。

| 入力（作成、または update の後の値） | 結果 |
|---|---|
| 行き先あり（期限の有無を問わない） | 受ける。期限があっても、反映前は閉じない（§3.2） |
| 行き先なし・印つきの期限（`--expires-at`）。**作成のとき**: 作成の時点から 5 分以上、7 日以内 | 受ける（許可） |
| 行き先なし・期限なし | 400 `destination_required`（exit 2） |
| 行き先なし・期限が 5 分未満か過去、または 7 日を超える | 400 `invalid_close_when`（`reason: expiry_out_of_range`、exit 2）。既存の code を使う |
| 行き先なし・`issue`・`pr`・`branch` の条件 | 400 `destination_required`（文で「許可の期限は時刻で書く」と示す。§2.4） |
| 行き先なし・印の無い `--close-when at:…`（今の書き方） | 400 `destination_required`。文で `--expires-at` を示す。作成の時点で印の無い `at` を、行き先なしで受けない（`--close-when at:` で範囲の検査を素通りさせない。レビュー A P2-3） |
| **update で、行き先のある decision から行き先を外す** | **400 `invalid_promote_to`（`reason: destination_removal`、exit 2）**。行き先の取り替え（別の行き先へ）だけを許す（レビュー A P1-2） |
| update で、許可（行き先なし・期限つき）に行き先を足す | 受ける。行き先のある decision になり、承認の流れに乗る。期限で閉じなくなる |
| update で、許可の期限を変える（延ばす・縮める） | 受ける。ただし次の 2 つを満たすこと（確かめ N1）:<br>- 新しい期限は、update の時点から 5 分以上<br>- **作成の時点（`created_at`）から 7 日以内**<br>延長を繰り返しても、作成から 7 日を超えては生きない。超える値は 400 `invalid_close_when`（`expiry_out_of_range`） |
| **update で、印つきの期限を持たない decision に `--expires-at` を足す**（行き先も期限も無い既存の decision を許可に変える、など） | **400 `invalid_close_when`（`reason: expiry_not_allowed`、exit 2）**。許可になれるのは作成のときだけ。印つきの期限は足せない（確かめ N2） |

- 期限の範囲（5 分・作成から 7 日）は PM の決定（Q5 は「最長を設ける方向」）に沿う設計の案で、定数にする。7 日の根拠は §1.1 の許可の長さ（4〜24 時間、リリースの許可で 1〜2 日）に余裕を持たせた値（読み）
- 拒否の文（エージェントが次に打つ形を出す。レビュー B P2-5）:
  - `destination_required`: 「decision には行き先か期限が要ります。決定なら `--promote-to issue:#N`（または `pr:#N`・`path:<docs の .md>`）、期限つきの許可なら `--expires-at <ISO 8601>`（7 日以内）を付けてください」
  - `expiry_out_of_range`: 「許可の期限は、今から 5 分以上、作成から 7 日以内にしてください」
  - `expiry_not_allowed`: 「期限は、許可として作った decision にだけ付けられます。許可が要るなら、`mem add --kind decision --expires-at …` で新しく作ってください」
  - `destination_removal`: 「行き先は外せません。別の行き先へ取り替えてください」
  - 第 2 版は、行き先を外す代わりに `mem close` での取り下げを勧めていた。第 3 版で外した（取り下げは承認なしで決定を消す前からある口で、勧めない。§9 の R1）
- `--expires-at` は `mem add` と `mem update` の両方に足す。`--close-when` と同時に指定したら、使い方の誤り（exit 2）
- 新しい拒否の code `destination_required` を `MemErrorCode` と `MEM_EXIT_BY_CODE`（`src/types/mem.ts:201-263`）に足す。今まで通った入力が exit 2 になるので、**CLI の公開の契約の変更**（人の了承、§8 Q2）
- **適用の前の handoff の提案**: 保存済みで適用していない提案に、行き先なし・期限なしの decision の add がありうる。適用のときに store が断る
  - 画面はその提案を `failed`（理由 `destination_required`）として人に見せる
  - 人は、行き先か期限を足した提案を作り直すよう、エージェントに頼む
- I6:
  - 既にある、行き先も期限も無い `open` の decision はそのまま残す
  - 規則は、作成と update のときにだけ効く。既存の行を読み直して断ることはしない
  - ただし既存の行に、行き先なしのまま text だけを直す update は受ける（行き先・期限の欄に触れない update は規則の外。見立て。PR1c の契約で確かめる）

### 3.2 期限の意味と評価

**印**:
- `--expires-at` が作る `close_when` は `{ schema: 1, type: 'at', epochMs, offset, expires: true }`
- 今の読み取り（`readStoredCloseWhen`）は `schema` と `type` だけを見るので、そのまま読める（F16）
- 印の無い `at`（今までの `--close-when at:`）は、今の意味のまま（I6、レビュー A P1-3）
- 古い版のサーバーに戻した場合は印を読まず、今の意味（未反映の印だけ）になる。閉じないので安全側

**`at` が成立したときの扱い**（評価の `decideAt`、`evaluate.ts:405-406`）:

| decision の状態 | 行き先（`promote_to`） | 印 | 今（F2） | 案 1 の後 |
|---|---|---|---|---|
| `open` | 無し | `expires: true` | 閉じない（`unreflected`） | **閉じる**（`closed`、`close_reason='condition'`、終わりの理由 `time-passed`、成否 `unknown`） |
| `open` | 無し | 無し（既存の `at`） | 閉じない | 閉じない（変わらず。I6） |
| `open` | 有り | 問わない | 閉じない | 閉じない（変わらず。I2） |
| `recorded` | 有り・無し（F6） | 問わない | 閉じない | 閉じない（変わらず。I2） |
| `promoted` | 有り・無し（F6） | 問わない | 閉じる（`condition`） | 閉じる（変わらず） |

- 実装の形:
  - 遷移の検査は `closeMemItemByCondition`（`mem-db.ts:1122-1145`）の中、トランザクションの内側にある（版と条件の一致 `:1129`、`memTransition(…,'condition')` `:1130`）
  - ここに「decision・`open`・`promote_to IS NULL`・印つきの `at`」のときだけ閉じる分岐（遷移 `expire`）を足す
  - 評価と書き込みの間の update は版を上げるので、`:1129` で止まる。行き先の検査はそれと独立に効く二重の守り（§5 で両方を別々に試験する、レビュー A P2-6）
- `expire` は、書き込みの評価の口（`evaluateMemConditions`、F4 のきっかけ）でだけ走る。副作用の無い読み（件数の API・`dream-input`・`presentMemItem`）は閉じず、時刻の比較だけをする（§4.1・§6、レビュー B P1-4）
- I3: mode が `on` でないブランチでは評価しない（`evaluate.ts:417`）。条件の JSON が読めない・schema が違うときも閉じない（`readStoredCloseWhen` が null）。この場合、許可は閉じずに残り、`expired: true` の印（下）が付く
- 閉じたことは、既存の終わりの記録（`mem_close_records`、v67）と知らせ（#4222 §3.3）に乗る

**期限切れの見え方（閉じる前。レビュー A P2-4・B P2-6）**:
- `presentMemItem`（`src/lib/mem/present.ts`）で、期限（印つきか否かを問わない `at`）を過ぎた decision に `expired: true` を付ける。時刻の比較だけで、書き込みはしない
- brief: `expired` の decision は、欄 `expired=true` を付けて出す（rank は変えない。下の §3.3 と同じく brief の順位表を変えない）。エージェントは「期限切れの許可」と読める
- `mem list`・決定の画面: 「許可・期限 〇〇」「期限切れ」の印を出す
- 承認の差分: 行き先があり期限を過ぎた decision の差分に「期限を過ぎています」と警告を出す（承認は止めない）
- `close_reason` に `expired` を足さない（F11 の CHECK のため）。期限で閉じたことは終わりの理由 `time-passed` で分かる（PM の決定 Q4）

**既存の文書と試験の直し（レビュー B P1-3）**:
- B の不変条件「decision は promote の前に閉じない」に、例外が 1 つできる（印つきの期限を持つ、行き先なしの `open`）
- PR1c の docs の範囲で、次の場所を直す:
  - `mem-close-when-4222.md`: 条件の節（`:348`）、不変条件の表（`:446`）、試験の表（`:506`）。履歴として「#4354 で例外を足した」の 1 行
  - `cli-operations-guide.md:3772` 付近（日英）
  - `mem-skills-4228.md:58`
  - `cmate-handoff` の skill の `references/kinds-and-close-when.md`（公開版は commandmate-skills。人の承認）
- 既存の試験の「decision は open で閉じない」の行は、期待値を変えず「行き先あり、または印の無い `at`」の行だと明記する。印つきの行を新しく足す

### 3.3 promoted の片付け（PM の決定 Q4: P-a）

- `promoted` の状態は変えない
- 上限の警告（`countOpenItems`、F8）と承認待ちの数から外す
- **brief の出し方は変えない**。`brief-4223.md` §2.3 の順位 10 と `mem-skills-4228.md` の順位表のまま（第 1 版の「brief から外す」は取り下げた。レビュー B P1-2）
- Issue の追記 1 の「閉じたことを理由つきで記録に残す」は満たさない。promoted は閉じずに残り、`mem list`・画面の `promoted` は運用とともに増える（§1.1 (a) の実績で、承認された 15 件のうち 12 件を PM が手で閉じた）
- 片付けの手段は今のまま:
  - 人の画面の close
  - 作成者の `mem close`（`promoted` は `manual`）
  - `mem purge --include-decisions`（直近 24 時間に閉じた decision は対象にならない、§4.1）
  - docs の運用（`team.md` §11）に「反映を確かめた promoted は、PM が週に 1 回閉じる」のような手順を足すかは、PM の運用の判断（設計の外）

### 3.4 数え方の変更

- `countOpenItems`（`mem-db.ts:607`）の decision の数を、`state IN ('open','recorded')` に絞る。ほかの kind は変わらない
- 期限を過ぎた許可は、評価で閉じるまでの間も数に入れない（SQL の `json_extract(close_when, '$.expires')` と `'$.epochMs'` の比較。式は PR1c の契約で名指す。レビュー A P3-5）
- 警告の式が変わるので、`mem-store-4221.md:285` の表と、guide・`mem-skills-4228.md:59` の「件数の上限」の行に一言足す（レビュー B P3-5）

---

## 4. 画面・CLI・API

### 4.1 承認待ちの件数（直し方 1）

**数え方（I4。既存の欄は変えない。レビュー A P2-5・B P1-1）**:
- `decisionCountsOf(mode, items, now)` の既存の `open`・`recorded` の意味と型は変えない（`mem decisions --json` の `counts` の schema 1、#4355 I7）
- 次の欄を**足す**。`open` の decision は、次の 4 つの欄の**どれか 1 つに必ず入る**（確かめ N3）:
  - `pending`（承認待ち）: 行き先ありの `open`
  - `grants`（許可）: 行き先なし・印つきの期限・期限の前の `open`
  - `expiredGrants`（期限切れの許可）: 行き先なし・印つきの期限・期限を過ぎてまだ閉じていない `open`
  - `noDestination`（行き先なし）: 行き先なし・印つきの期限の無い `open`。条件の有無と型を問わない（期限なし・印の無い `at`・`issue`・`pr`・`branch` を全部ここへ）
  - 不変: `pending + grants + expiredGrants + noDestination = open`
- `recorded` は既存の欄のまま、「反映待ち」と呼ぶ。`pending` には入れない（第 2 版は `pending` に `recorded` を足していた。今の画面の「承認待ち N 件・反映待ち M 件」（F17）と重なるので分けた。確かめの B P1-1 の注）
- 直近に終わったもの（A P1-1 の残り。閉じた行の読みと時刻の比較だけ）:
  - `endedGrants`: 直近 24 時間に閉じた許可。期限で閉じたものと、取り下げたものの両方。許可は、行き先なし・印つきの期限で判定する
  - `withdrawnDecisions`: 直近 24 時間に取り下げられた（`withdrawn`）、許可でない decision（R1 の見え方）
  - 24 時間は定数
  - **purge から守る（確かめ N4）**: `purgeMem`（`mem-db.ts:1067-1110`）は、直近 24 時間に閉じた decision を、どの絞り込み（`--include-decisions` を含む）でも消さない（`NOT (kind = 'decision' AND state = 'closed' AND closed_at >= :now - 24h)` を常に足す）。dry-run の件数にも入れない
    - 消せるのは 24 時間を過ぎてから。`endedGrants`・`withdrawnDecisions` の記録は、少なくとも窓のあいだは残る
  - 前提の書き直し: 「purge は人だけ」は CLI の検査（`src/cli/commands/mem.ts:622-625`）で、保証ではない（`mem-store-4221.md` §8.3・§11.3）。同じ OS 権限で DB を直に消すことまでは防げない（A と同じ限界）
- `now` は引数で受け、関数は純粋のまま
- `ambiguous` は、足した欄も null

**API**:
- `GET /api/mem/decisions/pending`（名前は見立て）。登録されたリポジトリのブランチごとに、上の欄を返す
- 副作用なし: 条件の評価・`gh`・git の照会・書き込みを一切しない。DB の読みと時刻の比較だけ（I3）
- 全部のブランチを、1 本の SELECT で読む（見立て。§9）

**表示**:
- PC はヘッダー（`src/components/layout/Header.tsx`）、スマホはサイドバーかメニュー
- 「承認待ち N・反映待ち R・許可 M」を出す（PM の決定 Q3: `noDestination` は数に入れず、決定の画面で別に出す）
  - 許可の数も必ず出す（I4。レビュー A P1-1 の直し方 2）
  - `expiredGrants` があれば「許可 M（期限切れ K）」
  - 直近 24 時間に終わった許可・取り下げた決定があれば「終わった許可 E・取り下げ W」を添える（A P1-1 の残り）
  - 全部 0 なら出さない
- 押した先:
  - 承認待ち・許可が 1 つのブランチにだけあれば、そのブランチの決定の画面へ直接行く
  - 複数なら、#4355 のリポジトリ → ブランチの select の画面へ行く（ブランチの行に件数は付けない。#4355 の決定 5-2b に合わせる。レビュー B P2-4）。バッジが全体の数で、先はブランチを選ぶだけ
- 「?」（`ambiguous`）: 「確認できません（ブランチの mode の設定が、同じ git の登録の間で食い違っています）」の説明を出す。PC はツールチップ、スマホはタップで出す（レビュー B P3-2）
- 読み直し: ヘッダーの既存の読み直しに合わせる。新しいタイマーは足さない（D13）

**決定の画面の冒頭の数（F17）**:
- 今の「承認待ち N 件・反映待ち M 件」は、一覧の `open` を数えている
- これを、次のように変える:
  - 1 行目: 同じ関数の `pending`（承認待ち）と `recorded`（反映待ち）
  - 2 行目: 「行き先なし K 件・許可 L 件（期限切れ J 件）」
  - 3 行目: 「直近 24 時間に終わった許可 E 件・取り下げた決定 W 件」。押すと、閉じた行の一覧（本文・作成者・終わり方・時刻）を開く。閉じた行の一覧は今の画面の「閉じた項目」の表示を使う（見立て）
- PR2 で画面・`cli-operations-guide.md` の決定の画面の節（`:3842`）・`mem decisions` の表示を一緒に直す（レビュー B P1-1）
- `mem decisions --json` の `counts` は欄を足すだけで、既存の欄は変えない

### 4.2 決定の画面の冒頭（直し方 5。PM の決定 Q6: 書く）

2〜3 行の固定の説明を出す（文案。運用の規則だと分かる言い方。レビュー B P3-3）:
1. 「エージェントは人の決定を記録として確定できません。ここで承認すると、決定の本文が行き先（Issue のコメントか docs）に書かれます」
2. 「運用では、承認していない決定と、人がこの画面で見ていない許可を、作業の根拠にしません（機械で止めてはいません）」
3. 「期限つきの許可は承認の対象ではなく、期限が来ると閉じます」

- 2 つ目の文は、`team.md` §11 の運用の規則と合わせる（docs の書き順は PM）
- 許可に人が「確かめた」印を付ける口は作らない（PM の決定 Q7）

### 4.3 二重の検知と「記録済みにする」（直し方 3）

**検知（サーバーが preview を作るとき）**:
- 差分（preview）を作るときに、行き先の今の内容を読む。照会は既存の経路を使う
  - 文書: 基準の指紋に使う内容（`mem-promote-4225.md` §2.2）
  - Issue・PR のコメント: `gh api --hostname <host> repos/{o}/{r}/issues/{N}/comments` を新しい側から最大 100 件
- 一致の規則（機械が判断するのは次だけ）:
  - 両方を正規化する（NFC、空白の連続を 1 つ、行頭・行末の空白を除く）
  - decision の `text` と `quote` のそれぞれについて、20 code point 以上で、行き先の内容に**部分文字列として完全に含まれる**かを見る
  - 似ている・言い換えは判定しない
- 一致の結果を preview の行に記録する。preview は項目の版・指紋に結び付いている。記録するもの:
  - どの欄が一致したか（`text`・`quote`）
  - 場所（コメントの URL、文書の行）
  - 確かめた範囲（コメントの何件を見たか）
- 一致の関数は純粋な関数（`src/lib/promote/prior-record.ts` 見込み）にする。#4248 の「詳細を Issue・文書へ移す案」の二重の検知でも同じ関数を使う（§6）

**表示（レビュー A P2-10・P3-3）**:
- 一致あり: 「行き先に同じ本文があります（一致した欄: 本文／引用。場所: <URL か 文書:行>）」
- 一致なし、かつ全部を見た: 「行き先に同じ本文は見つかりませんでした」
- 一致なし、かつコメントが 100 件を超える: 「最新 100 件のコメントの中に同じ本文はありません（それより古いコメントは見ていません）」
- 照会できなかった: 「確かめられませんでした（<理由>）」。一致なしと書かない（I3）

**記録済みにする（レビュー A P2-9・P3-2）**:
- 名前は「記録済みにする」。閉じない。`open → promoted` で、既存の遷移 `promote-record-only`（`transitions.ts:62-63`）を使い、外へは何も書かない
- 新しい画面の入口 `decision-mark-recorded`。本文は preview の ID と、画面が表示した指紋だけ。**一致の場所はクライアントから受けない**
- サーバーは、同期の区間で次を照らす。どれかが違えば何もしない:
  1. preview が期限内・未使用で、項目の版・指紋が preview と同じ
  2. preview に一致の記録があり、その一致が `text` の一致を含む（`quote` だけの一致では記録済みにしない。§8 の外の設計の判断。引用だけが行き先にあっても、決定の本文が記録されたとは言えないため）
  3. 画面の印（`screen_only`）・mode `on`・worktree の世代
- 一致の記録は、新しい表に残す（追加の migration。既存の表の CHECK は変えない、F12。番号は PM の決定 Q8）
- 入口は #4225 の `ENTRANCES` の表（`write-entrances-recreate-4221.test.ts`）の行として守る（I5）
- 一致が無いのに記録済みにしたい場合は、この口では受けない。既存の「記録だけ（`record_only`）」の承認を使う
- 画面の文言（レビュー A P3-4）: 行き先なしの許可を画面で行き先を選んで承認しようとすると、preview の評価（F4）で許可が期限で閉じることがある。そのときは「この許可は期限で閉じました」と出す（apply は `state_forbids` で止まる）

### 4.4 承認前の修正（直し方 4）

- `mem update <id>` に `--promote-to`・`--quote`・`--quote-at`・`--expires-at` を足す。API の `update` の patch（`service.ts:579`）にも同じ欄を足す
- 規則は既存の `update` と同じにする:
  - 作成者の instance だけ（`ownedBy`、`mem-db.ts:886`）
  - `open` の decision だけ（`recorded` は `state_forbids`、exit 55、`transitions.ts:50-51`）
  - 版の照合（`--if-version`）
- 検査は作成と同じ関数を使う（`validatePromoteTo`・`validateQuote`、§3.1 の規則）
- **行き先を外す形は作らない**（`--promote-to ''` は 400 `invalid_promote_to`、`destination_removal`）。レビュー A P1-2・B P2-5
- `--expires-at` の update は、許可（作成のときに印つきの期限を持った decision）と、作成のときに行き先と期限を両方持った decision だけ。印つきの期限を持たない decision には足せない（§3.1、確かめ N2）
- 承認の差分は項目の版と指紋に結び付いている（`mem-promote-4225.md` §2.1）。直した後の古い差分は、既存の照合で `reapproval_required`（`item_changed`）になる
- suggest の規則（`rules.ts:173`、レビュー B P2-5）:
  - `decision_no_destination` を「行き先も期限も無い `open`」だけに絞る（許可には出さない）
  - 新しい促し `decision_grant_expired`（期限を過ぎてまだ閉じていない自分の許可。「閉じるか期限を延ばしてください」）を足す

---

## 5. 試験の層と陰性対照

| 層 | 試験 | 陰性対照（直しを外すと赤） |
|---|---|---|
| 単体（純粋） | `memTransition` の表: kind × 状態 × 遷移 × 行き先の有無 × 印の有無。`expire` は「decision・open・行き先なし・印つき」だけが通る | `expire` の行き先の条件・印の条件を、それぞれ外した変異で赤（2 つの変異） |
| 単体（純粋） | `checkDecisionDestinationRule` の表: 作成と update × 行き先の有無 × 期限（なし・過去・4 分・5 分・7 日・7 日＋1 分）× 条件の型（`at` 印つき・`at` 印なし・`issue`・`pr`・`branch`）× 行き先を外す update × **作成から 6 日後に「今＋7 日」へ延ばす update** × **印つきの期限の無い decision に `--expires-at` を足す update** | 7 日の上限を外す変異で、`2099-01-01` の行が通り赤（A P1-1）。上限の基準を update の時点にする変異で、6 日後の延長が通り赤（N1）。期限を足す検査を外す変異で、既存の decision が許可に変わり赤（N2）。行き先を外す検査を外す変異で赤（A P1-2）。印なしの `at` を受ける変異で赤（A P2-3） |
| 単体（純粋） | `decisionCountsOf` の表: mode 4 通り × 状態 × 行き先の有無 × 条件（なし・印つきの `at`・印の無い `at`・`issue`・`pr`・`branch`）× 期限の前後（`now` を差し替え）× 閉じた行（期限で閉じた許可・取り下げた許可・取り下げた decision、24 時間の前後）。既存の `open`・`recorded` の値は今と同じ。**全部の行で `pending + grants + expiredGrants + noDestination = open`**（N3） | `open` の意味を変える変異（行き先を見る）で、既存の表の行が赤（#4355 の互換、A P2-5）。`noDestination` を「期限も条件も無い」に戻す変異で、印の無い `at`・`issue` の行の和が合わず赤（N3）。`grants` を数えない変異で赤。`endedGrants` の 24 時間の窓を外す変異で赤 |
| 単体（store、purge。N4） | 直近 24 時間に閉じた許可・取り下げた decision を作り、`mem purge --closed-only --kind decision --confirm` と `--include-decisions` を打つ。行は残り、`endedGrants`・`withdrawnDecisions` の数が変わらない。時計を 24 時間＋1 分進めると消える | 24 時間の除外を外す変異で、purge の後の数が 0 になり赤 |
| 単体（store・経路ごと） | 作成の拒否を 3 つの経路で: `memAddItem`（CLI・API）・`memWriteFromScreen` の `add`・handoff の提案の適用（I7、A P2-1・B P2-2）。どの経路も行 0 | 規則を CLI の側だけに置く変異で、画面と handoff の行が赤 |
| 単体（store） | `closeMemItemByCondition` を直接呼ぶ: 版と `close_when` は一致させ、`promote_to` だけを非 NULL にした行（fixture で直接作る）を渡す → 閉じない（A P2-6） | `promote_to` の検査を外す変異で赤（版の照合では止まらない行） |
| 結合（評価） | 時計を差し替え、期限の前は閉じず、後の `check` で許可だけが `time-passed` で閉じる。行き先のある decision・印の無い `at` は閉じない | 評価で閉じる条件から行き先か印を外す変異で赤 |
| 結合（I3、A P2-7） | mode `off`・`derived`・`ambiguous`、条件の JSON が読めない、schema が違う、の各行で、期限を過ぎても閉じない | `evaluate.ts:417` の早期 return を外す変異で、mode の行が赤 |
| 結合（I6、A P2-8） | 移行前の行を写した fixture: 行き先なし・期限なし／行き先なし・印の無い `at` が過去／行き先あり・`at` が過去。PR の後に `check` を 1 回走らせても、状態と `version` が変わらない | 印の判定を外す変異で、印の無い `at` の行が閉じて赤 |
| 結合（副作用なし） | 件数の API・`presentMemItem`・`dream-input` の材料の組み立て（#4248 の PR で）の前後で、mem の行の状態と版が同じ。`gh` と DB の書き込みの spy が 0 回（B P1-4） | 件数の API の中で評価を呼ぶ変異で、spy が 1 以上になり赤。期限切れの許可が閉じて赤 |
| 結合（二重の検知） | 一致あり（本文・引用それぞれ）／なし／20 code point 未満／100 件を超えるコメント／照会の失敗。`decision-mark-recorded`: 一致なしの preview・引用だけの一致・版の変わった preview は断る（A P2-9）。画面の印なし・mode `off`・作り直しも断る | クライアントの値を信じる変異（preview の一致を照らさない）で、一致なしの行が通り赤。印の検査を外す変異で、`ENTRANCES` の既存の `it.each` が赤 |
| 結合（期限切れの見え方） | 時計を差し替え、期限の後の `mem list --json`・brief に `expired: true` が付き、行の状態は変わらない（A P2-4） | `expired` を付けない変異で赤 |
| e2e | ヘッダーのバッジ（承認待ち・反映待ち・許可・終わった許可）→ 決定の画面へ（PC 1280・スマホ 390）。0 件で出ない。`ambiguous` で「?」と説明。決定の画面の冒頭の数がバッジと同じ fixture で同じ | 画面の数を別の数え方にする変異で赤 |
| 回帰 | `mem decisions --json` の `counts` の既存の欄が、同じ fixture で今と同じ（#4355 I7） | — |

- 時計: 評価・件数の試験は `now` を差し替える（`MemEvalDeps` の `now`、`evaluate.ts:422`）
- モデルを呼ばないこと（Issue の追記の受入）は、既存の表に、件数の API と期限の評価の行を足す（既存の表の場所は PR の契約で名指す。未確認）

---

## 6. #4248（Dreaming）へ渡す結論

1. 機械で決まる片付け（許可の期限・promoted の数）は、この Issue が持つ。dreaming は「中身が古い・誤り」だけを扱う。**期限の許可と `promoted` の decision を対象にした `close` の提案は出さない**（レビュー B P3-6）
2. dreaming の「decision の候補」の提案は、**行き先（`promote_to`: `issue:#N`・`pr:#N`・`path:<.md>`）を必須とし、期限（許可）は起案させない**（#4248 第 2 版 §7.1、#4248 のレビュー A P1-2 を受けて第 3.1 版で直した。第 3 版までは「行き先か期限」）。dreaming の提案は decision を言い直し・閉じる・まとめる対象にもしない。これで §3.1 の許可の規則（N1・N2）と R1 を dreaming の経路から迂回させない
3. 承認待ちの数（§4.1 の `pending`）と、dreaming の「未判断の提案」の数は、**別の数**として並べる。#4248 §9 の C の行: 「『未判断の提案 N 件（うち dreaming M 件）』の 1 行を優先順位の表に足す」
4. 期限の過ぎた許可は、dreaming の材料に入れない（閉じる前でも）。`promoted` は材料に入れる（「正本へ移す案」を重ねないため）
5. 「記録済みにする」の一致の規則（完全一致・正規化、§4.3 の純粋な関数）は、dreaming の「詳細を Issue・文書へ移す案」の二重の検知でも同じ関数を使う
6. **`expire` は書き込みの評価の口でだけ走る**。`dream-input` は、既存の評価の口（閉じる）を呼ばない。期限切れは純粋な時刻の比較（`presentMemItem` の `expired`）で判定し、材料から外す。書き込まない（レビュー B P1-4）

---

## 7. PR の分け方（Sprint 9 以降。レビュー B P2-8）

| PR | 中身 | 書くファイル（見込み） | 依存 | 陽性対照 |
|---|---|---|---|---|
| PR1a 数と見え方 | promoted を上限の警告から外す（§3.3・§3.4）、`decisionCountsOf` に欄を足す（§4.1。既存の欄は変えない）、`presentMemItem` の `expired`（§3.2）、purge から直近 24 時間に閉じた decision を外す（§4.1、N4） | `src/lib/db/mem-db.ts`（`countOpenItems`・`purgeMem`）、`src/lib/promote/decision-counts.ts`、`src/lib/mem/present.ts`、`src/lib/brief/sources.ts`（`expired` の欄）、試験。docs: `mem-store-4221.md:285`・guide・`mem-skills-4228.md:59`・`brief-4223.md`（欄の追加） | なし | 件数の表、`expired` の時計の行 |
| PR1b update の欄 | `mem update` の `--promote-to`・`--quote`・`--quote-at`（§4.4）。行き先を外す拒否 | `src/lib/mem/{service,validate}.ts`、`src/lib/db/mem-db.ts`（`updateMemItem`）、`src/cli/commands/mem.ts`、試験 | なし | 行き先を外す update の拒否の変異 |
| PR1c 作成の規則と期限 | `checkDecisionDestinationRule`（§3.1、store 層）、`--expires-at`（add・update）、印つきの `at`、`expire`（§3.2）、`destination_required`（公開の契約の変更。CHANGELOG の Breaking、公開版 `cmate-handoff` の skill）、suggest の規則（§4.4）、docs（§3.2 の一覧） | `src/types/mem.ts`、`src/lib/mem/{validate,service,transitions,evaluate,close-when}.ts`、`src/lib/db/mem-db.ts`、`src/lib/mem-suggest/rules.ts`、`src/cli/commands/mem.ts`、試験。**直す既存の試験の一覧**（行き先なしの decision を作る fixture）を契約に書く | PR1b（update の経路を同じ関数で検査するため）。§8 Q1・Q2 の答え | §5 の規則・評価・I3・I6 の表 |
| PR2 件数とバッジ | 件数の API（§4.1）、ヘッダー・サイドバーのバッジ、決定の画面の冒頭の数と説明（§4.1・§4.2）、guide の決定の画面の節 | 新しい route、`Header.tsx`・`Sidebar.tsx`、`DecisionPromotePanel.tsx`、docs | PR1a（欄）。PR1c（許可の数。PR1c の前なら `grants` は常に 0） | 副作用 0 の spy、e2e |
| PR3a 一致の関数 | 一致の規則の純粋な関数（§4.3）。#4248 と共有 | `src/lib/promote/prior-record.ts`（新）、試験 | なし（PR2 の前でも出せる） | 一致の表 |
| PR3b 二重の検知の画面 | preview に一致を記録、`decision-mark-recorded` の入口、一致の記録の表（追加の migration） | `src/lib/promote/service.ts`、migration（番号は PM）、`DecisionPromotePanel.tsx`、`ENTRANCES` の表 | PR3a、PR2（同じ画面のファイル） | `ENTRANCES` の行、mark-recorded の拒否の行 |

- `DecisionPromotePanel.tsx` は #4355 の残り（PR3、Sprint 9 へ移した、`pm-plan-s8.md`）と同じファイル。#4355 の PR2 までは develop に入っている（`a21776371`・`e162dd9b9`）。PR2・PR3b と #4355 PR3 の順は、同じレーンで PM が固定する
- PR1a・PR1b・PR3a は DB の変更が無い。PR3b だけが migration を持つ（新しい表を作るだけ）
- 高リスク（データ・mem の契約）なので、各 PR のレビューは系統を分けて 2 本
- `docs/module-reference.md` は直接書かず、断片で渡す

---

## 8. 人の決定（11-19、mem 91b25c73）

人の答えは「推奨で」（2026-11-19、mem の決定 91b25c73）。

| # | 決定 |
|---|---|
| Q1 | **案 1**（決定は行き先を、許可は期限（作成から 5 分〜7 日、時刻だけ、作成のときだけ）を必須にする）。**許可が使われる前に人が見る保証が無いこと**（人が見られるのは、生きている間の数と、終わってから 24 時間の記録）も了承 |
| Q2 | **(a) exit 2 で断る**（`destination_required`、期限の範囲の外 `expiry_out_of_range`、許可でない decision への期限の追加 `expiry_not_allowed`、行き先を外す update `destination_removal`）。CLI の公開の契約の変更として、CHANGELOG の Breaking と公開版 `cmate-handoff` の skill に載せる（§7 PR1c） |

以下は、人に伺ったときの問いの記録（決定の根拠として残す）。

### Q1（伺った問い。決定は上の表）: 行き先の必須化と期限つきの許可の衝突を、どう解くか

背景:
- Issue の直し方 2 は「行き先の無い decision を作れなくする」
- 追記 2 は「期限つきの許可（自走・マージ・この版限り）を、期限で閉じる」
- 許可は行き先（Issue・docs）を持たないので、2 つはそのままでは両立しない
- 今の mem の decision の多くは許可で（§1.1）、承認されずに手で取り下げられている

選択肢:

| | 中身 | 影響 |
|---|---|---|
| **案 1（推奨）** | 決定は行き先（`--promote-to`）を付ける。許可は行き先の代わりに期限（`--expires-at`、作成から 5 分〜7 日、時刻だけ）を付ける。許可にできるのは作成のときだけ。許可は承認の対象ではない。ただしバッジに「許可 M」として出し、期限の後に機械が閉じる。終わった許可も 24 時間はバッジと決定の画面に出す | DB の変更なし。7 日を超える許可や「PR のマージまで」の許可は、時刻で書き直す必要がある。**許可は人の確認なしに作られ、使われうる**（人が見られるのは、生きている間の数と、終わってから 24 時間の記録。使われる前に人が見ることは保証しない） |
| 案 2 | 許可を decision とは別の種類（grant）にする | 意味は最もはっきりするが、mem の表の作り直し（データの移行）が要り、実装が大きい |
| 案 3 | 行き先の無い decision に既定の行き先（例: docs の決定の記録のファイル）を付ける | 許可まで承認待ちに乗り、承認されずに溜まる。正本に期限切れの許可が溜まる |

### Q2（伺った問い。決定は上の表）: 新しい拒否（CLI の公開の契約の変更）でよいか

- 案 1 を採ると、`commandmate mem add --kind decision` に行き先も期限も無いと、今まで通っていた入力が **exit 2**（`destination_required`）で断られる。画面と handoff の提案も同じく断られる
- ほかに、次の 3 つも新しく断る（どれも exit 2）:
  - 許可の期限が範囲の外（今から 5 分未満、または作成から 7 日超え）
  - 許可でない decision に、update で期限を足す
  - 行き先を外す update
- 影響の範囲（確かめた範囲。レビュー A P3-7）: 次の 3 つは既に `--promote-to` 付きで書いており、影響は小さい
  - `.claude/skills/cmate-handoff-dev/SKILL.md:145`
  - `docs/orchestrate/team.md:148`
  - `src/cli/docs/team-setup-guide.ts:423`
- 公開版の `cmate-handoff` skill と CHANGELOG の Breaking に載せる
- 選択肢:
  - (a) 推奨: 断る（exit 2）
  - (b) 断らず、`mem check --suggest` の知らせだけを続ける（今と同じ。行き先も期限も無い decision が作られ続ける）

### PM が範囲の中で決めたこと（記録）

| # | 決定 | この版での反映 |
|---|---|---|
| Q3 | 行き先も期限も無い既存の `open` は、バッジの数に入れず、決定の画面で別に出す | §4.1（`noDestination`） |
| Q4 | promoted は P-a（数から外すだけ）。期限で閉じた理由は `time-passed` | §3.2・§3.3 |
| Q5 | 期限に最長を設ける。案は設計が出す | §3.1（5 分〜7 日） |
| Q6 | 画面の冒頭の説明を書く | §4.2 |
| Q7 | 許可に人が「確かめた」印を付ける口は作らない | §4.2 |
| Q8 | migration の番号は PM | §7 PR3b |

---

## 9. 未確認・レビューで見てほしい点

1. 行き先・期限の欄に触れない update（行き先なしの既存の decision の text だけを直す）を、規則の外にしてよいか（§3.1 の I6。PR1c で確かめる）
2. コメントを最大 100 件読む上限が、`gh` の照会の予算（`QueryLimits`、`src/lib/mem/query-plan.ts`）と合うか
3. 件数の API の SELECT 1 本で、全部のリポジトリ・ブランチの mode（規則・上書き）を解決できるか。mode の解決は今 TS の関数（`memModeOnFor` など）なので、SELECT の後に TS で mode を決める形になる（見立て）
4. モデルを呼ばないことの既存の試験の表の場所
5. §1.1 (a) の分類は、本文の先頭を目で見た読み
6. **既知の口 R1（前からある。この設計では塞がない）**:
   - 作成者の instance は、承認待ち（行き先あり・`open`）の decision を、`mem close` で承認なしに取り下げられる（`memTransition('decision','open','close')` → `withdrawn`、`src/lib/mem/transitions.ts:52-53`、`ownedBy` は `mem-db.ts:864-872`）
   - 「エージェントが人の決定を作れない」（I5）は破らない。しかし、承認待ちの決定を人の目に入る前に消せる
   - 第 3 版では、取り下げを代わりの手段として勧めない（§3.1）
   - 見え方: 直近 24 時間に取り下げた決定を、バッジと決定の画面に出す（§4.1 の `withdrawnDecisions`）
   - 塞ぐかどうか（取り下げを人だけにする、取り下げに理由と人への知らせを要する等）は、Sprint 9 以降の追跡（PM が Issue にする）

---

## 10. 設計レビューの処分（第 2 版）

- 処分の語: 採用（設計を直した）・却下（理由つき）・未解決（次の手つき）
- P1 は全部を設計で塞いだ

### 10.1 レビュー A（データと契約の安全）

| 指摘 | 処分 | 反映した節 |
|---|---|---|
| 事実 F6 の補足（画面で選んだ行き先は書き戻さない） | 採用 | F6、§3.2 の表、§4.1 の `pending` |
| 事実「成否 `success`」は誤り | 採用 | F15、§3.2 |
| 事実「過去の `at` は既存の検査に乗る」は誤り | 採用 | F14、§3.1 |
| 事実「画面から decision を作る経路は未確認」は誤り | 採用 | F13、§3.1 |
| P1-1 遠い期限で必須を素通り・バッジに出ない許可 | 採用（直し方 1 と 2 の組み合わせ。3 は PM の決定 Q6・Q7 に沿い、画面の説明に入れた） | §2.2・§3.1（5 分〜7 日）、§4.1（許可の数を必ず出す）、§4.2 |
| P1-2 update で行き先を外して機械で閉じる迂回 | 採用 | I2、§3.1、§4.4、§5 |
| P1-3 行き先なし・`at` の既存の decision が一斉に閉じる | 採用（実測は 0 件、§1.1 (b)。印 `expires: true` で新しい期限だけに効かせる） | I6、§3.2、§5 |
| P2-1 規則を CLI だけに置くと画面・handoff から作れる | 採用 | I7、§3.1、§5 |
| P2-2 行き先なしで `issue/pr/branch` の条件だけ | 採用（時刻だけに限る） | §2.4、§3.1 |
| P2-3 過去・直近の期限の検査は新設で、`--close-when at:` も同じに | 採用（行き先なしで印の無い `at` は受けない） | §3.1 |
| P2-4 期限切れの許可が brief・list で有効に見える | 採用（`expired` の印。brief の rank は変えない） | §3.2 |
| P2-5 `decisionCountsOf` の意味の変更が #4355 の出力を変える | 採用（欄を足す。既存の欄は変えない） | §4.1、§5 |
| P2-6 競合の試験の陰性対照が効かない | 採用 | §5 |
| P2-7 I3 の陰性対照が無い | 採用 | §5 |
| P2-8 I6 の回帰に陰性対照が無い | 採用 | §5 |
| P2-9 記録済みはサーバーが一致を確かめ直す | 採用（preview の一致だけを使い、クライアントの値は受けない） | §4.3、§5 |
| P2-10 100 件だけの「一致なし」 | 採用 | §4.3 |
| P3-1 成否 `unknown` | 採用 | §3.2 |
| P3-2 「記録済みとして閉じる」の名前 | 採用（「記録済みにする」） | §4.3 |
| P3-3 どちらの欄が一致したかを出す | 採用（さらに、`quote` だけの一致では記録済みにしない） | §4.3 |
| P3-4 preview の評価で許可が閉じうる | 採用（画面の文言） | §4.3 |
| P3-5 期限切れを数えない式を名指す | 採用（式の形を書き、名指しは PR1c の契約） | §3.4 |
| P3-6 `promote_to IS NULL` の `recorded`・`promoted` | 採用 | §3.2 の表 |
| P3-7 CLI の契約の変更の影響と、公開 skill・CHANGELOG | 採用 | §7 PR1c、§8 Q2 |

### 10.2 レビュー B（既存の設計・文書との整合と使い勝手）

| 指摘 | 処分 | 反映した節 |
|---|---|---|
| P1-1 バッジの数と #4355 の画面の数・`decisionCountsOf` の食い違い | 採用（欄を足し、既存の欄は保つ。画面の冒頭の数を同じ欄に合わせ、guide を同じ PR で直す） | §4.1、§7 PR2 |
| P1-2 brief から promoted を外すのが 4223・4228 に反する | 採用（brief は変えない。第 1 版の案を取り下げた） | §3.3 |
| P1-3 B の不変条件を破るのに 4222・guide・skill の手当てが無い | 採用（直す文書の一覧と、既存の試験の行の扱い） | §3.2、§7 PR1c |
| P1-4 `dream-input` の「評価しても閉じない」口 | 採用 | §3.2、§6 の 6、§5 |
| P2-1 期限が `at` だけで、PR の条件の許可が作れない | 却下（時刻だけに限る。理由は §2.4: PR の条件は「不明」で残りうるため、最長の期限で上限を保てない。拒否の文で書き直し方を示し、Q1 の影響の欄に書いた） | §2.4、§3.1、§8 Q1 |
| P2-2 画面から作る経路はある | 採用 | F13、§3.1 |
| P2-3 P-a と Issue の「閉じる」の差 | 採用（差を §0.1 と §3.3 に明記。Q4 は PM が P-a に決めた） | §0.1、§3.3 |
| P2-4 バッジの先が #4355 の決定と食い違う | 採用（#4355 の select へ行き、件数は付けない） | §4.1 |
| P2-5 エージェントへの案内（文・suggest・help・行き先を外す形） | 採用 | §3.1、§4.4 |
| P2-6 期限切れの許可を人が見る所が無い | 採用 | §3.2、§4.1 |
| P2-7 受入条件の被覆表が無い | 採用 | §0.1 |
| P2-8 PR1 が大きい | 採用（PR1a・1b・1c と PR3a・3b に分けた） | §7 |
| P3-1 最短の表記の不一致 | 採用（5 分にそろえた） | §3.1 |
| P3-2 「?」の説明 | 採用 | §4.1 |
| P3-3 画面の文の断定 | 採用（運用の規則と分かる言い方） | §4.2 |
| P3-4 F8・F10 の行番号の確認 | 採用（レビュー A が develop で照合して正と確かめた。行番号を A の照合に合わせた） | §1 |
| P3-5 `countOpenItems` の変更と 4221・guide・4228 | 採用 | §3.4、§7 PR1a |
| P3-6 Dreaming への引き渡しの曖昧さ | 採用（promoted・許可の close の提案を出さない、schema への追記文、C の行の引用） | §6 |

- 却下 1 件（B P2-1）。未解決 0 件

### 10.3 第 2 版の確かめ（`verify-4354-v2.md`）の処分（第 3 版）

| 指摘 | 処分 | 反映した節 |
|---|---|---|
| A P1-1 の残り（作って使ってから取り下げる・5 分で切れる許可が人の目に入らない） | 採用（直近 24 時間に終わった許可を `endedGrants` としてバッジと決定の画面に出す）。**使われる前に人が見ることは保証できない**。これは Q7（確かめた印を作らない）の結果で、Q1 の影響の欄に明記して人の了承事項にした | §0、§4.1、§8 Q1 |
| N1 延長を繰り返せば 7 日の最長が効かない | 採用（期限の上限を作成の時点から 7 日にする） | §3.1、§5 |
| N2 既存の decision に期限を足して許可に変え、期限で閉じる | 採用（印つきの期限は作成のときだけ。update で足すと `expiry_not_allowed`） | §3.1、§4.4、§5 |
| N3 どの欄にも入らない既存の decision | 採用（`noDestination` を「行き先なし・印つきの期限なし」に定義し直し、和が `open` と一致する不変を試験にした） | §4.1、§5 |
| B P1-1 の注（`pending` に `recorded` を含めると、画面の「反映待ち」と重なる） | 採用（`pending` は行き先ありの `open` だけ。`recorded` は「反映待ち」として別に出す） | §4.1 |
| R1 作成者が承認待ちの decision を取り下げられる（前からの口。第 2 版が代わりに勧めていた） | 勧めを外した。§9 に既知の口として書き、Sprint 9 以降の追跡に（PM が Issue にする）。見え方として `withdrawnDecisions` を出す | §3.1、§4.1、§9 の 6 |

- 人へ渡す Q1・Q2 の形は変わらない。Q1 の影響の欄（許可は人の確認なしに使われうる）と、Q2 の新しい拒否の一覧（許可でない decision への期限の追加）を書き足した

### 10.4 第 3 版の確かめ（`verify-4354-v2.md` の「## 第 3 版」）の処分（第 3.1 版）

| 指摘 | 処分 | 反映した節 |
|---|---|---|
| A P1-1 の残り（一部、扱いは妥当） | 確認として受けた（Q1 の影響の欄のまま） | §8 Q1 |
| N4 purge で 24 時間の記録を消せる・「purge は人だけ」は保証でない | 採用（両方: 直近 24 時間に閉じた decision を purge の対象から常に外す。前提を「検査で保証ではない」に書き直す。§5 に purge の後の数の行と変異） | §4.1、§3.3、§5、§7 PR1a |

- 人へ渡す Q1・Q2 の形は変わらない（purge の除外は、人の操作にも効く挙動の変化だが、消せるまでの待ちが 24 時間のびるだけで、公開の拒否の code・exit は増えない。PM の範囲の判断とした）
