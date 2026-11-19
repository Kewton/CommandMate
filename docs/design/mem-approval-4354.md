# 決定の承認の導線 — 承認待ちの件数・行き先と期限・二重の検知・承認前の修正・機械で決まる片付け（Issue #4354）設計

- 段: 設計（この文書だけ）。コード・DB・試験は書かない。実装は設計レビュー 2 本の処分と、§8 の人の答えの後に、§7 の PR ごとに別の契約で行う（Sprint 9 以降）
- 版: 第 1 版（2026-11-19、イネーブラー claude-5）
- 基準: develop `b8f6e33b8`（v0.53.0）。行番号はこの版のもの。「事実」は file:line、「見立て」「未確認」は明記する
- 正: Issue #4354 の本文・追記（2026-11-15）・コメント（2026-11-15 の衝突の指摘、2026-11-17 の順番、2026-11-19 の Sprint 8 は設計だけ）
- 関連: #4225（承認の画面、`docs/design/mem-promote-4225.md`）、#4355（決定の画面・件数の共有関数、`docs/design/mem-decisions-ux-4355.md`）、#4222（条件の評価、`mem-close-when-4222.md`）、#4221（store、`mem-store-4221.md`）、#4248（Dreaming。この設計の §6 を入力にする）
- この文書が人に伺う点は §8 にまとめる（PM が人へ渡す）。**§2 の衝突の答えが出るまで、§7 の PR1 は始められない**

---

## 0. 結論（先に）

1. **衝突の扱い（§2）**: 3 案を比べ、**案 1「行き先か期限のどちらかを必須にする（期限つきは行き先なしを許す）」を推奨**する。行き先も期限も無い decision だけを作れなくする。期限は既存の `close_when` の `at`（decision で既に許されている型）に載せ、DB の列を足さない
2. **期限の意味（§3.2）**: 期限を過ぎた decision は、**行き先が無いものだけ**を次の評価で閉じる（`close_reason='condition'`、終わりの理由 `time-passed`）。行き先のある decision は、期限を過ぎても反映していなければ閉じず、今までどおり「未反映」として残す（`team.md` §11 の 3「反映していない決定を閉じない」を機械の側でも守る）
3. **promoted の片付け（§3.3）**: `promoted` は状態を変えずに、件数・上限の警告・承認待ち・brief の数から外す（案 P-a）。自動で `closed` にする案（P-b）は、`close_reason` の CHECK を変えるために `mem_items` の作り直しの migration が要るので、推奨しない
4. **件数（§4.1）**: 全リポジトリの承認待ちの数を返す読みだけの API と、ヘッダー（PC）・サイドバー（スマホ）のバッジを足す。数え方は #4355 の `decisionCountsOf`（`src/lib/promote/decision-counts.ts:44`）の 1 つだけを使う。分からないときは 0 と書かずに「?」と出す
5. **二重の検知（§4.3）**: 差分を作るときに、行き先に同じ本文が既にあるかを機械で照らし、画面に出す。人は「記録済みとして閉じる」を選べる（外へは何も書かない）。「似ている」は機械で判定しない（完全一致の部分文字列だけ）
6. **承認前の修正（§4.4）**: `mem update` に `--promote-to`・`--quote`・`--quote-at`・`--expires-at` を足す。作成者の instance だけが、`open` のあいだだけ直せる（既存の `update` の規則、`transitions.ts:50-51`）

---

## 1. 今の作り（事実）

| # | 事実 | 出典 |
|---|---|---|
| F1 | decision の状態は `open`・`recorded`・`promoted`・`closed`。承認は画面だけ（`screen_only`）。`open → recorded`（効果 `spec`）・`open → promoted`（効果 `record_only`）・`recorded → promoted` | `src/lib/mem/transitions.ts:49-66`、`mem-promote-4225.md` §1.1 |
| F2 | 条件の成立で閉じる遷移（`condition`）は、decision では `promoted` からだけ。`open`・`recorded` で成立しても閉じず、`unreflected` の印だけを付ける | `transitions.ts:56-57`、`src/lib/mem/evaluate.ts:441-444` |
| F3 | decision に付けられる条件の型は `issue`・`pr`・`branch`・`at`。省略時は NULL（遷移だけで閉じる） | `src/types/mem.ts:74`・`:84-91` |
| F4 | 条件の評価は `list`・`check`・`brief`・`preview` のきっかけで走る。新しいタイマーは無い（D13） | `src/types/mem.ts:344`、`evaluate.ts:416-470` |
| F5 | decision の作成で `--promote-to` は任意。行き先の無い `open` の decision は、`mem check --suggest` の `decision_no_destination` が知らせるだけ | `src/cli/commands/mem.ts:430`、`src/lib/mem-suggest/rules.ts:173` |
| F6 | 承認の差分は、本文の `destination` か項目の `promoteTo` を行き先にする。画面で行き先を選べば、行き先の無い decision も承認できる | `src/lib/promote/service.ts:447-450` |
| F7 | `mem update` が直せるのは `text`・`close_when`・`evidence` だけ。`promote_to`・`quote`・`quote_at` は直せない | `src/cli/commands/mem.ts:474-480`、`src/lib/mem/service.ts:579` |
| F8 | open の件数は `state != 'closed'` で数える。`recorded`・`promoted` も数に入る。decision の警告は 20 件から（上限は無し） | `src/lib/db/mem-db.ts:284-290`・`:607-614` |
| F9 | 承認待ちの件数の共有関数 `decisionCountsOf` は、`open` と `recorded` だけを数え、`promoted` を数えない。mode が `ambiguous` なら null（0 ではない） | `src/lib/promote/decision-counts.ts:44-53` |
| F10 | brief は `closed` 以外の decision を全部出す（`recorded` は rank 4、ほかは 10） | `src/lib/brief/sources.ts:451-452`・`:500-520` |
| F11 | `close_reason` の値は `manual`・`condition`・`superseded`・`slot-removed`・`withdrawn` だけで、DB の CHECK で固定している | `src/lib/db/migrations/v66-mem-store.ts:121` |
| F12 | 承認の操作の効果は `spec`・`record_only` の 2 つで、DB の CHECK で固定している | `src/lib/db/migrations/v69-mem-promote.ts`（`effect` の CHECK、2 か所） |

### 1.1 運用の実測（2026-11-19、このリポジトリの mem、`commandmatedev mem list --all --json`）

- decision は 83 件。内訳は次のとおり:
  - `closed`・`withdrawn`: 53 件（行き先あり 28・なし 25）
  - `closed`・`manual`: 12 件（承認・反映の後に閉じたもの）
  - `promoted`: 3 件
  - `open`: 15 件（行き先あり 10・なし 5）
- 行き先の無い 25 件の取り下げ（`withdrawn`）は、ほとんどが「自走 N 時間」「Auto-Yes の許可（期限 …）」「段 N のリリースの許可」のように、**期限のある許可**だった（本文の先頭を目で見た読み。全件の分類はしていない）
- 承認まで進んだのは 15 件（`promoted` 3・`manual` 12）。承認されずに取り下げられたものは 53 件
- 読み: 実際に使われている decision の多くは「期限つきの許可」で、承認の流れ（行き先へ書く）に乗っていない。承認の導線だけを足しても、許可の決定は承認待ちの数を増やすだけになる

---

## 2. 衝突: 行き先の必須化と、期限つきの許可（行き先なし）

Issue の直し方 2（行き先の必須化）と、追記 2（期限つきの決定。自走の許可・マージの許可・「この版限り」の許可が対象）は、そのままでは両立しない。§1.1 のとおり、許可の決定は行き先を元々持たない。

### 2.1 不変条件（どの案でも守る）

| # | 不変条件 | 破れるとどうなるか |
|---|---|---|
| I1 | 承認（画面の `screen_only` の経路）で外へ書く decision は、書く前に行き先が決まっている | 承認しても書く先が無い（Issue の事象 2） |
| I2 | 行き先のある decision は、反映（`promoted`）の前に機械が閉じない。期限を過ぎても閉じない | 人の決定が正本に入らないまま消える（`team.md` §11 の 3） |
| I3 | 期限で閉じる・数から外すのは、機械で決まる値（時刻・状態）だけで判断する。モデルを呼ばない。評価できないとき（mode が `on` でない、条件の JSON が読めない）は閉じない | 推測で人の決定を閉じる（同じ種類の穴: #4419・#4430 の「外れうる観測で消す」） |
| I4 | 件数は 1 つの関数で数え、分からないときに 0 と言わない | 画面ごとに数が違い、人が「承認し終えた」と誤る（#4355 I6） |
| I5 | エージェントが人の決定を「承認済み」にする口を作らない（画面だけ）。#4354 で足す遷移もすべて画面の印を要する | エージェントが人の決定を作れる（#4225 D9） |
| I6 | 既にある decision の意味を、この変更で黙って変えない（行き先も期限も無い既存の `open` は、作り直しも自動の close もしない） | 移行で既存の決定が消える |

### 2.2 案

| | 案 1（推奨）: 行き先か期限のどちらかを必須にする | 案 2: 許可を別の kind（例 `grant`）にする | 案 3: 既定の行き先を持たせる |
|---|---|---|---|
| 中身 | decision の作成で `--promote-to` か `--expires-at`（中身は `close_when` の `at`）の少なくとも一方を要する。両方とも無ければ 400 `destination_required`（exit 2）。行き先の無い期限つきの decision は「許可」として、期限の後の評価で閉じる（§3.2） | `MEM_KINDS` に `grant` を足す。`grant` は期限が必須で、行き先も承認の流れも持たない。期限の後の評価で閉じる。decision は行き先を必須にする | リポジトリの設定に「決定の既定の行き先」（例 `path:docs/decisions.md` か追跡の Issue）を持ち、`--promote-to` の無い decision に付ける。期限は全 decision に付けられる |
| 不使用・推測の残り | 無し（時刻と状態だけで判断） | 無し | 無し |
| DB の変更 | **無し**（`close_when` の `at` は decision で既に許されている、F3） | **`mem_items` の作り直し**（`kind` の CHECK を変える、`v66-mem-store.ts:99`）。SQLite は CHECK を変えられないので、表を作り直して写す migration（`RENAME TO` の前例: `v33`・`v46`〜`v48`）。ほかの mem の表は `mem_items(id)` を参照しているので（`v67-mem-close-records.ts:26`・`:54`）、参照を保ったまま写す | リポジトリの設定の列を足す（`mem_repository_settings` に ADD COLUMN。追加だけ） |
| 波及するファイル | `validate.ts`・`service.ts`・`evaluate.ts`・`transitions.ts`・CLI の `mem add`／`update`・suggest の規則・docs | 案 1 の全部に加えて、`CLOSE_WHEN_ALLOWED`・`CLOSE_WHEN_DEFAULTS`・`MEM_OPEN_LIMITS`・古さ・brief の rank・画面の種類の表示と絞り込み・handoff の提案（`kind` の検査）・skill（`cmate-handoff`）・docs | 設定の画面と API、承認の差分（既定の行き先を出す）、docs |
| 利用者の手間 | 許可を書くときに期限を書く（今も本文に「〜11-17 23:00」と書いている） | 許可と決定の区別を書き手が覚える。古い許可の decision は decision のまま | 許可も承認すると既定の行き先へ書かれる。許可の記録が正本（docs か Issue）に溜まる |
| 承認の流れとの関係 | 行き先のある decision だけが承認の流れに乗る。許可は承認待ちの数に入れない（§4.1） | 同左（grant は承認の流れの外） | 全部が承認の流れに乗る。許可も人が承認しないと残り続ける（§1.1 の詰まりが増える） |
| 実装の大きさ（見立て） | 小〜中 | 大（migration の作り直しと、kind の表のすべて） | 中（設定の UI と migration） |

### 2.3 推奨と、捨てた理由

**推奨: 案 1。** 次の理由による。
- I1〜I6 を、DB の作り直しなしで満たせる。期限は既にある `at` の型に載り、評価も既にある経路（F4）で走る
- §1.1 の実際の使い方（許可を decision に書き、期限が来たら手で取り下げる）を、その形のまま機械の片付けに置き換えられる
- 承認待ちの数を「承認して行き先へ書くもの」だけにでき、許可が数を埋めない

**案 2 を捨てた理由**:
- 意味は最もはっきりする
- しかし `mem_items` の作り直しの migration が要る（F11 と同じく CHECK のため）。mem の表どうしの参照もあるので、データの移行を安全に試す費用が大きい
- 書き手が 2 つの kind を使い分ける運用の手間も増える
- 案 1 で I1〜I6 が満たせるので、その費用に見合わない（読み）
- 後で `grant` を足したくなったときも、案 1 の「行き先の無い期限つきの decision」を写せば移れる

**案 3 を捨てた理由**:
- 許可まで承認の流れに乗せると、§1.1 の「承認されずに溜まる」を増やす（#4248 の追記も同じ詰まりを心配している）
- 既定の行き先へ許可を書くと、正本（docs・Issue）が期限切れの許可で埋まる

### 2.4 案 1 で変わる受入条件（人の了承が要る）

- Issue の受入条件「行き先なしの decision を作れない（または既定の行き先が付く）」を、**「行き先も期限も無い decision を作れない」**に読み替える
- 期限だけを持つ decision は、承認の流れの外に置く。§4.1 の承認待ちの数に入れず、期限が来たら閉じる
- これは受入条件の変更なので、人の了承を要する（§8 Q1・Q2）

---

## 3. store と評価の変更（案 1 の場合）

### 3.1 作成の規則

| 入力 | 今 | 案 1 の後 |
|---|---|---|
| `--promote-to` あり | 作れる | 作れる（今と同じ） |
| `--promote-to` なし・`--expires-at`（または `--close-when at:…`）あり | 作れる | 作れる（「許可」として扱う） |
| 両方なし | 作れる（suggest の知らせだけ、F5） | **400 `destination_required`（CLI は exit 2）。何も書かない** |
| `--expires-at` が過去・5 分より近い | — | 400 `invalid_close_when`（既存の検査に乗せる。未来 1 分以上などの値は §8 Q5） |

- `--expires-at <ISO 8601, オフセット必須>` は `--close-when at:<ISO>` と同じ値を作る、分かりやすい別名にする。両方を指定したら使い方の誤り（exit 2）
- 新しい拒否の code `destination_required` を `MemErrorCode` と `MEM_EXIT_BY_CODE`（`src/types/mem.ts:201-263`）に足す。今まで通った入力が exit 2 になるので、**CLI の公開の契約の変更**にあたる。人の了承が要る（§8 Q2）
- 画面の経路（人が画面のメモから decision を作る経路があれば、それ）も同じ規則にする（未確認: 画面から decision を作る経路の有無。#2427 のメモの経路は `now` だけ、`mem-store-4221.md` §6.3）
- I6: 既にある、行き先も期限も無い `open` の decision は、そのまま残す。作り直しも自動の close もしない。suggest の `decision_no_destination` は今までどおり知らせる

### 3.2 期限の意味と評価

`close_when` の `at` が成立したとき（評価の `decideAt`、`evaluate.ts:405-406`）の扱いを、decision について次の表にする。

| decision の状態 | 行き先 | 今（F2） | 案 1 の後 |
|---|---|---|---|
| `open` | 無し | 閉じない（`unreflected`） | **閉じる**（`closed`、`close_reason='condition'`、終わりの理由 `time-passed`、成否 `success`） |
| `open` | 有り | 閉じない（`unreflected`） | 閉じない（`unreflected`、変わらず。I2） |
| `recorded` | 有り | 閉じない（`unreflected`） | 閉じない（変わらず。I2） |
| `promoted` | 有り | 閉じる（`condition`） | 閉じる（変わらず） |

- 実装の形（見立て）:
  - `memTransition` に、decision の `open → closed`（理由 `condition`）を「行き先の無い期限」に限って許す遷移 `expire` を足す
  - 行き先の有無は `memTransition(kind, state, transition)` の引数に無いので、遷移の判定に `{ promoteTo: string | null }` を足すか、評価（`evaluate.ts:441`）で `expire` を選ぶ
  - どちらにしても、**store の書き込みの関数の中で、同じトランザクションで項目を読み直し、`promote_to IS NULL AND state='open'` を確かめてから書く**
    - 今の `closeMemItemByCondition`（`mem-db.ts:1122-1145`）は、トランザクションの中で項目を読み直し、版と条件の一致（`:1129`）と `memTransition(…,'condition')`（`:1130`）を確かめてから書く。`closeItemByCondition`（`mem-close-db.ts:307-318`）がそれを 1 つのトランザクションで包む
    - 行き先の検査は `:1130` の判定と同じ場所に足す。評価と書き込みの間に `mem update --promote-to` が入っても、版が上がるので `:1129` で止まる。行き先の検査はその二重の守り
- 閉じたことは、既存の終わりの記録（`mem_close_records`、v67）と知らせ（作成者・後継への「終わった」の知らせ、#4222 §3.3）に乗る。新しい表は要らない
- 期限は評価のきっかけ（F4）でしか閉じない。期限の直後に評価が走らなければ、次の `list`・`check`・`brief` まで `open` のまま残る。§4.1 の件数は評価を待たずに期限で外す（純粋な時刻の比較。書き込みはしない）
- mode が `on` でないブランチでは評価しない（`evaluate.ts:417`）。期限を過ぎた許可は閉じずに残る。件数からは外す（§4.1）
- `close_reason` に `expired` を足す案は採らない。CHECK の変更（F11）が要るため。「期限で閉じた」ことは終わりの理由 `time-passed` で分かる（Issue の受入「`expired` などの理由つき」を、この語で満たす。§8 Q4）

### 3.3 promoted の片付け

| 案 | 中身 | DB の変更 | 推奨 |
|---|---|---|---|
| **P-a（推奨）** | `promoted` の状態は変えない。上限の警告（`countOpenItems`、F8）・承認待ちの数（F9 は既にそう）・brief の出力（F10）から外す。人の `mem close`・画面の close は今までどおり。条件（`close_when`）のある `promoted` は今までどおり評価で閉じる | 無し | ○ |
| P-b | `promoted` になった遷移と同じトランザクションで `closed` にする（新しい `close_reason='promoted'`） | `mem_items` の作り直し（F11） | × |
| P-c | `promoted` の後 N 日で閉じる | 無し（`at` を自動で付ける）。ただし「自動で条件を足す」が人の書いた条件を上書きする | × |

- **P-a を推奨する理由**:
  - Issue の受入は「promoted の decision が上限の数と承認待ちの件数に入らない」で、状態を変えなくても満たせる
  - 「閉じたことを理由つきで記録に残す」は、P-a では「閉じない」ので該当しない。代わりに、`promoted` は「反映済み」として画面と `mem list` に出す。人が「閉じたこと」を求める場合は P-b になる（§8 Q4）
- brief から外す範囲（読み。実装の前に PM へ確かめる）: brief の S7（`sources.ts:500-520`）で `promoted` の decision を出さない。代わりに `mem list` と画面では今までどおり見える
  - #4248 の dreaming の材料には `promoted` を入れる（正本への移し済みかどうかの判断に要る、§6）

### 3.4 数え方の変更

- `countOpenItems`（`mem-db.ts:607`）の decision の数を、`state IN ('open','recorded')` に絞る。ほかの kind は変わらない（`recorded`・`promoted` は decision にしか無い、`v66-mem-store.ts` の CHECK）
- 期限を過ぎた `open` の decision（行き先なし）は、評価で閉じるまでの間も数に入れない（純粋な時刻の比較）

---

## 4. 画面・CLI・API

### 4.1 承認待ちの件数（直し方 1）

- **新しい読みの API**: `GET /api/mem/decisions/pending`（名前は見立て）。登録されたリポジトリのブランチごとに次を返す:
  - `decisionCountsOf` の数（`open`・`recorded`・`approvable`・`mode`）
  - 期限つきの許可の数（数え方は下の 3 段目）
  - 行き先の無い既存の decision の数（I6 の残り）
- 数え方:
  - 承認待ちの数 = `open` かつ行き先あり（承認の流れに乗るもの）＋ `recorded`（反映の確認待ち）
  - `decisionCountsOf` は今は行き先を見ないので、引数の型 `DecisionCountsItem` に `promoteTo`（有無だけ）と `closeWhen`（期限）を足して、1 つの関数のまま数え分ける（I4。#4355 の CLI・画面の select と同じ数になるよう、同じ fixture の表試験を広げる）
  - 期限つきの許可（行き先なし・期限あり・期限の前）は別の数として返し、バッジの数には入れない。期限を過ぎたものは数えない
  - 行き先も期限も無い既存の `open`（I6）は「行き先なし」として別に返す。バッジの数に入れるかは §8 Q3
- **副作用なし**: 条件の評価（B）・`gh`・git の照会・書き込みを一切しない。DB の読みと時刻の比較だけ（I3）。このため、評価で閉じる前の期限切れも外せる
- `ambiguous`（同じ git の root の間で mode が食い違う）のブランチは数を null で返す。バッジは「?」を出し、0 と書かない（I4）
- **表示**:
  - PC はヘッダー（`src/components/layout/Header.tsx`）に、スマホはサイドバーかメニューに、「承認待ち N」を出す
  - 1 クリックで決定の画面（`/repositories/<id>/mem/decisions?branch=<name>`）へ行く。承認待ちが 1 つのブランチにだけあればそこへ直接、複数なら件数つきのブランチの一覧へ
  - 0 件のときは出さない
  - 既存の `AttentionBadge`（`src/components/layout/AttentionBadge.tsx`）を使うかは実装で決める（見立て）
- 読み直しの間隔: ヘッダーの既存の読み直しに合わせる。新しいタイマーは足さない（D13）。画面の遷移ごとに 1 回と、決定の画面の承認の後に読み直す

### 4.2 決定の画面の冒頭（直し方 5）

2〜3 行の固定の説明を出す（文案。実装で調整する）:

- 「エージェントは人の決定を記録として確定できません。ここで承認すると、決定の本文が行き先（Issue のコメントか docs）に書かれます」
- 「承認していない決定は、それに頼る作業の根拠になりません。期限つきの許可は承認の対象ではなく、期限が来ると閉じます」

二つ目の文の「根拠になりません」は運用の規則で、機械で止めているわけではない。docs の運用の規則（`team.md` §11）に合わせる。§8 Q6 で人に確かめる。

### 4.3 二重の検知と「記録済みとして閉じる」（直し方 3）

- **検知**: 差分（preview）を作るとき（`promotePreview`）に、行き先の今の内容を読む。照会は既存の経路を使い、新しい外部の照会先は足さない
  - 文書（`path:`）は、既に読んでいるファイルの内容（基準の指紋に使う内容、`mem-promote-4225.md` §2.2）を使う
  - Issue・PR のコメントは、`gh api --hostname <host> repos/{o}/{r}/issues/{N}/comments` の新しい側から最大 100 件を読む（上限は見立て）
- **一致の規則**（機械が判断するのは次だけ）:
  - 比べる前に両方を正規化する（NFC、空白の連続を 1 つにする、行頭・行末の空白を除く）
  - decision の `text` か `quote` が 20 code point 以上で、行き先の内容に**部分文字列として完全に含まれる**とき、一致とする
  - 似ている・言い換えは判定しない
- **表示**:
  - 一致したら、差分の画面に「行き先に同じ本文があります（<コメントの URL か 文書の行>）」を出す
  - 照会できなかったときは「確かめられませんでした（<理由>）」を出し、一致なしと書かない（I3）
- **記録済みとして閉じる**:
  - 一致を見た人が画面で選ぶ。新しい画面の入口 `decision-mark-recorded` で、`open → promoted`（既存の遷移 `promote-record-only`、`transitions.ts:62-63`）に進める
  - 外へは何も書かない
  - 一致の場所（URL か path:行）・一致を確かめた時刻・人の操作は、新しい表に残す（追加の migration。既存の表の CHECK は変えない、F12）
  - 入口は画面の印（`screen_only`）・mode `on`・worktree の世代・版の照合を、#4225 の `ENTRANCES` の表（`write-entrances-recreate-4221.test.ts`）の行として守る（I5）
- 一致が無いのに「記録済み」にしたい場合（人が手で別の場所に書いた等）は、この口では受けない。既存の「記録だけ（`record_only`）」の承認を使う

### 4.4 承認前の修正（直し方 4）

- `mem update <id>` に `--promote-to`・`--quote`・`--quote-at`・`--expires-at` を足す。API の `update` の patch（`service.ts:579`）にも同じ欄を足す
- 規則は既存の `update` と同じにする:
  - 作成者の instance だけ（`ownedBy`、`mem-db.ts:886`）
  - `open` の decision だけ（`recorded` は `state_forbids`、exit 55、`transitions.ts:50-51`）
  - 版の照合（`--if-version`）
- 検査は作成と同じ関数を使う（`validatePromoteTo`・`validateQuote`、`validate.ts`）
- 直した結果が「行き先も期限も無い」になる update（行き先を消す）は、§3.1 の規則で断る
- 承認の差分は項目の版と指紋に結び付いている（`mem-promote-4225.md` §2.1）。直した後の古い差分は、既存の照合で `reapproval_required`（`item_changed`）になる

---

## 5. 試験の層と陰性対照

| 層 | 試験 | 陰性対照（直しを外すと赤になること） |
|---|---|---|
| 単体（純粋） | `memTransition` の表: kind × 状態 × 遷移 × 行き先の有無。`expire` は「decision・open・行き先なし」だけ通る | `expire` の行き先の条件を外した変異で、「行き先あり・open」の行が赤 |
| 単体（純粋） | `decisionCountsOf` の表: mode 4 通り（`on`・`off`・`derived`・`ambiguous`）× 状態 × 行き先の有無 × 期限の前後（時計を差し替え） | promoted を数える変異・期限を見ない変異で赤。`ambiguous` で 0 を返す変異で赤 |
| 単体（store） | 作成の検査: 行き先・期限の 4 通り。両方なしは 400 `destination_required` で行 0 | 検査を外すと行が 1 になり赤 |
| 単体（store） | update の新しい欄: 作成者・open だけ。`recorded` は 55。行き先を消して期限も無い update は断る | `ownedBy` を外すと他者の update が通り赤 |
| 結合（評価） | 時計を差し替え、期限の前は閉じず、後の `check` で行き先の無い decision だけが `time-passed` で閉じる。行き先のある decision は `unreflected` のまま | 評価で閉じる条件から行き先を外す変異で、行き先ありが閉じて赤 |
| 結合（競合） | 評価が期限を読んだ後、書き込みの前に `mem update --promote-to` を入れる（評価の await の点の hook）。閉じない | 書き込みのトランザクションの中の読み直しを外す変異で赤 |
| 結合（件数 API） | 全リポジトリの数が `mem decisions`（#4355 PR1）と同じ fixture で同じになる。照会・書き込み 0（`gh` と DB の書き込みを spy で 0 回） | API の中で評価（B）を呼ぶ変異で、spy が 1 以上になり赤 |
| 結合（二重の検知） | 文書・コメントの完全一致あり／なし／20 code point 未満／照会の失敗（「確かめられませんでした」）。`decision-mark-recorded` を `ENTRANCES` に足し、画面の印なし・mode `off`・作り直し・版の食い違いで断る | 一致の規則を「似ている」に広げる変異は不要（読み）。印の検査を外す変異で、`ENTRANCES` の既存の `it.each` が赤 |
| e2e | ヘッダーのバッジ → 決定の画面へ 1 クリック（PC 1280・スマホ 390）。0 件で出ない。`ambiguous` で「?」 | バッジの数を API と別に数える変異で赤（同じ fixture の数を比べる） |
| 回帰 | 既存の行き先も期限も無い `open` の decision が、移行の後も `open` のまま残る（I6） | — |

- 時計: 評価・件数の試験は `now` を差し替える（既存の `MemEvalDeps` の `now`、`evaluate.ts:422`）
- mem・brief・check・件数がモデルを呼ばないこと（Issue の追記の受入）は、既存の「モデルを呼ばない」の試験の表に、件数 API と期限の評価の行を足す（未確認: 既存の表の場所。実装の契約で名指す）

---

## 6. #4248（Dreaming）へ渡す結論

1. 機械で決まる片付けは、この Issue が持つ（期限の許可・promoted の数）。dreaming は「中身が古い・誤り」だけを扱い、期限・promoted の片付けを提案しない（重ねない）
2. dreaming の「decision の候補」の提案は、案 1 の作成の規則（行き先か期限）を満たす形でだけ出せる。提案の schema の必須の欄に入れる
3. 承認待ちの数（§4.1）と、dreaming の「未判断の提案」の数は、**別の数**として並べる。混ぜない（#4248 の §9 の C の 1 行と同じ）
4. 期限の過ぎた許可は、dreaming の材料に入れない（閉じる前でも）。`promoted` は材料に入れる（「正本へ移す案」を重ねないため）
5. 「記録済みとして閉じる」の一致の規則（完全一致・正規化）は、dreaming の「詳細を Issue・文書へ移す案」の二重の検知でも同じ関数を使う

---

## 7. PR の分け方（Sprint 9 以降）

| PR | 中身 | 書くファイル（見込み） | 依存 | 陽性対照 |
|---|---|---|---|---|
| PR1 store と評価 | 作成の規則（§3.1）、期限の評価（§3.2）、promoted を数から外す（§3.3・§3.4）、update の新しい欄（§4.4）、CLI の `--expires-at`・update の欄、新しい error code、docs（cli-operations-guide の mem の節・`team.md` §11 の 2 の文言は PM の書き順で） | `src/types/mem.ts`、`src/lib/mem/{validate,service,transitions,evaluate}.ts`、`src/lib/db/mem-db.ts`、`src/lib/db/mem-close-db.ts`、`src/lib/promote/decision-counts.ts`、`src/lib/brief/sources.ts`、`src/cli/commands/mem.ts`、`src/lib/mem-suggest/rules.ts`、試験 | §8 Q1・Q2・Q4 の答え | §5 の単体・結合（評価・競合）の表。変異で赤 |
| PR2 件数とバッジ | 件数 API（§4.1）、ヘッダー・サイドバーのバッジ、決定の画面の冒頭の説明（§4.2） | 新しい route（`src/app/api/mem/decisions/pending/route.ts` 見込み）、`src/components/layout/Header.tsx`・`Sidebar.tsx`、`DecisionPromotePanel.tsx`（冒頭の文） | PR1（数え方の関数）。`DecisionPromotePanel.tsx` は #4355 PR3 と同じファイルなので、同じレーンで #4355 PR3 と順を決める | 件数 API の副作用 0 の spy、e2e |
| PR3 二重の検知 | 差分の照会に一致の検知を足す（§4.3）、`decision-mark-recorded` の入口、一致の記録の表（追加の migration） | `src/lib/promote/{service,reference-diff}.ts`、新しい migration（番号は PM）、`DecisionPromotePanel.tsx`、`ENTRANCES` の表 | PR1。PR2 と同じ画面のファイルなので PR2 の後 | `ENTRANCES` の行、一致・不一致・照会の失敗の表 |

- PR1 は DB の変更が無い。PR3 だけが migration を持つ（新しい表を作るだけ。既存の表は変えない）
- 各 PR の契約に、§2.1 の不変条件の番号を書く。高リスク（データ・mem の契約）なので、レビューは系統を分けて 2 本
- `docs/module-reference.md` は直接書かず、断片で渡す（今の運用）

---

## 8. 人に伺う点（PM が人へ渡す）

| # | 問い | 推奨 | 推奨しない側を選んだときの影響 |
|---|---|---|---|
| Q1 | 行き先の必須化と期限つきの許可の衝突を、どの案で解くか（§2.2） | **案 1（行き先か期限のどちらかを必須）** | 案 2: `mem_items` の作り直しの migration と、kind の表の全部の変更（大）。案 3: 許可も承認待ちに乗り、正本に許可の記録が溜まる |
| Q2 | 受入条件の読み替え「行き先も期限も無い decision を作れない」と、新しい拒否（exit 2 `destination_required`。今まで通った入力が断られる CLI の契約の変更）でよいか | よい | 拒否を入れないなら、suggest の知らせだけが残る（今と同じ） |
| Q3 | 行き先も期限も無い既存の `open` の decision（今 5 件）を、バッジの数に入れるか | 入れない。「行き先なし N 件」として別に出す。PM が中身を見て、期限を足すか取り下げる | 入れると、承認できない（行き先を画面で選ぶまで）ものが承認待ちに出る |
| Q4 | promoted を「数から外すだけ」（P-a）か、「自動で閉じて理由を残す」（P-b、migration で作り直し）か。期限で閉じた理由は `time-passed` の語でよいか（`expired` の値を足さない） | P-a と `time-passed` | P-b は案 2 と同じ作り直しの費用 |
| Q5 | 期限の最短（作成の時点から何分先から受けるか）と最長（例: 30 日） | 最短 5 分・最長は設けない（見立て） | 最長を設けると、長い許可を書き直す手間 |
| Q6 | 「承認していない決定は、それに頼る作業の根拠にならない」を画面に書いてよいか（運用の規則として。機械では止めない） | 書く | 書かないなら、承認の目的の説明が弱くなる（事象 5） |
| Q7 | 許可（行き先なし・期限あり）を人が「確かめた」印を付ける口を作るか（エージェントが許可を作り上げていないことの確認） | 作らない（今の運用でも許可は承認されていない、§1.1）。必要になったら別 Issue | 作るなら、新しい遷移と画面の口（I5 の表の行）を足す |
| Q8 | PR3 の migration の番号 | PM が割り当てる | — |

---

## 9. 未確認・レビューで見てほしい点

1. 画面から decision を作る経路があるか（§3.1）。あれば同じ規則にする
2. （確かめた）遷移の検査は `closeMemItemByCondition` の中、トランザクションの内側にある（`mem-db.ts:1129-1130`）。`expire` はそこに足す（§3.2）。session_notes の枠（`now`）の分岐（`:1131-1137`）は decision に関係しない
3. brief から `promoted` を外すと、ほかに `promoted` を brief で読む使い手がいないか（#4226 の促し、#4227 の handoff）。`grep` の範囲では brief の S7 だけを見た
4. 二重の検知でコメントを最大 100 件読む上限が、`gh` の照会の予算（`QueryLimits`、`src/lib/mem/query-plan.ts`）と合うか
5. ヘッダーに出す API の読み直しの頻度と、全リポジトリを数える費用（`listMem` を全ブランチで回すか、1 つの SELECT で数えるか）。読みの SELECT 1 本を推奨（見立て）
6. §1.1 の分類は本文の先頭を目で見た読みで、全件を分類していない
