# Issue #4420: 自分が開いた relay の返事を、次に開く relay の親に数えない（設計）

- 状態: **案 C を採用（PM の決定 2026-11-19）**。段 2 で実装（`MAX_RELAY_ROUNDS = 10`、断るコードは `RELAY_HOPS_EXCEEDED`）
- 対象: `src/lib/relay/relay-service.ts` の `findParentRelayHops`（連鎖の親の探索）。案 C では `relay-policy.ts` の `decideRelayCreation` に往復の上限を 1 つ足す（hops の上限・期限・`--allow-relay-chain` の意味は変えない）
- 試験: `tests/unit/lib/relay/relay-reply-not-parent-4420.test.ts`（実 DB `better-sqlite3` + `runMigrations`、既存の `relay-parent-hops-2387.test.ts` と同じ形）、`tests/integration/relay-reply-rounds-route-4420.test.ts`（実ルート `POST /api/relays`、`os.tmpdir()` の一時ファイル DB）

## 1. 前提（事実。実コードで確かめた）

1. 連鎖の判定は `openRelay` → `findParentRelayHops(db, from)`。依頼元セッション（`from`）の直近 5 ターンの user 行を新しい順に読み、最初の `messageType === 'relay'` の行を親とする。それより新しい user 行がすべてその行の echo（`isEchoOfRelayRow`、#2387）なら、行の `requestId`（`relay:<id>`）が名指す relay の `hops` を返す。echo でない行（人の普通の行）が挟まれば null（#2377 の「人が打てば連鎖が切れる」）。relay が消えた・ledger が読めない・`requestId` が無い → null（fail-open: 連鎖でない）
2. `messageType: 'relay'` の行を書くのは `relay-delivery.ts` の `deliverOne`（`sendUserMessage(..., messageType: 'relay')`）**だけ**。書き先は常に `requester`＝relay の **`from`**（依頼元）。`requestId: relay:<id>` が付くのは `kind === 'reply'`（返事）のときだけで、`prompt`（受け手のプロンプト待ちの知らせ）・`expired`（期限切れの知らせ）は `requestId` 無しの `relay` 行
3. 受け手（`to`）に届く依頼そのもの（`send --reply-to` の本文）は、`send` ルートが書く**普通の user 行**（`messageType: 'normal'`、`relay:` の `requestId` 無し）。bound relay（#3957）も ledger に入力の開始時刻（`inputBoundaryAt`）を記録するだけで、行には relay を指す印を付けない（`relay-bind.ts`。#4418 の `docs/design/flow-relay-watch-4418.md` §1 も「受け手の履歴は送り手を持たない」と確認している）
4. したがって**本番で `findParentRelayHops` が親として拾う行は、すべて「このセッション自身が `from` の relay の返事」**である。Issue の事象（送る → 返事 → 次を送る の 2 回目が `RELAY_CHAIN_BLOCKED`）はこの読みのとおりに起きる
5. 既存の試験（`relay-service.test.ts` の `the loop guard`・`relay-parent-hops-2387.test.ts`）は、`openRelay({ from: C, to: A })` の relay を名指す `relay` 行を **A（`to`）の履歴**に手で置き、「A は relay された依頼に答えている途中」を表している。この行の形（`to` 側に `relay:<id>` の行）は本番のどの書き手も書かない


## 2. 契約の前提との食い違い（レビューで処分してほしい点）

契約の【原因】【不変条件】は「依頼の受け手には自分への依頼の行（自分が `to` の relay を名指す行）がある」ことを前提にしている（I2・陰性対照「B が A の依頼に答える途中で C へ開く relay は `RELAY_CHAIN_BLOCKED` のまま」）。実コードでは §1-3 のとおりその行は書かれない。帰結:

- **(D1) 返事の行を親に数えないだけ（案 A）だと、本番の連鎖の禁止と hops の上限は一度も効かなくなる。** 本番で親になり得る行は返事の行だけで、それをすべて飛ばすため、`findParentRelayHops` は本番では常に null を返し、`hops` は常に 1 になる
- **(D2) 「B が A の依頼に答える途中で C へ開く relay」は、今の本番でも止まっていない。** B の履歴の依頼の行は普通の行なので、今の `findParentRelayHops` も B に親を見つけない。既存の試験が固定しているのは本番に無い行の形（§1-5）に対する動き
- **(D3) #2377 の連鎖の禁止が本番で実際に止めていたのは、まさに本件の形（返事を受けた依頼元が次の relay を開く）だった。** #2377 の受入条件「relay で届いたメッセージを受けた B が…」の「relay で届いたメッセージ」は、本番では返事の配送しか無い。返事を受けたエージェントが毎回 `--reply-to` で送り直す往復の暴走を止めていたのはこの規則で、ほかに残るのは「同じ向きの開いた relay は 1 本まで」（`countOpenRelaysBetween`）と期限だけ

**不変条件（PM）: 連鎖の暴走防止（深さ・往復の上限）は残る。** 案 A は D1 によりこれを満たさない（選ぶなら人の判断）。これを満たしつつ Issue の事象を直す候補が案 C。案 B（受け手側に本当の親を持たせる）は別 Issue（§2.3）。

### 2.1 案 A: 返事の行を飛ばし、`to` 側の行は親として残す（往復の上限なし）

- 変更は §3.1 だけ。I1〜I5 を満たし、既存の試験はすべてそのまま緑（それらの行は `to` 側なので I2 で親として拾われる）
- D1 を受け入れることになる。`to` 側の分岐は、今は本番の書き手が無い規則として試験で固定されるだけ
- **PM の不変条件（往復の上限が残る）を満たさない**

### 2.2 案 C（**採用**）: 返事を親に数えず、返事 → 次の依頼の「往復」を別に数えて上限を置く

案 A の §3.1 をそのまま入れ（返事の行は親にしない。Issue の事象が直る）、それとは別に、返事を受けた直後に次の relay を開くことを 1 回の「往復」と数え、人の普通の行が入るまでの連続回数に上限を置く（§3.2）。

#### (1) 数える単位

- **1 回 = 依頼元 S の履歴にある、S 自身が `from` の relay の返事の行 1 本**（§3.1 で「返事」と決めた行。echo は数えない）。S が次の relay を開くときに、その時点までに受けた返事の数を数える。つまり「返事を受けて、次を開く」の対を 1 と数える
- **相手を問わず S（`from`）単位**で数える（推奨）。同じ向き（S→B）だけを数えると、B・C を交互に名指すだけで上限を抜けられる。往復の暴走は「返事が次の依頼を呼ぶ」S の側の性質で、相手が誰かは関係ない。PM が複数のワーカーへ順に送る使い方も 1 本の連続として数えるので、値はそれを見込んで決める（(2)）
- 代案: 同じ向き（S→T）単位。PM が相手を替えるたびに 0 から数えられて PM に優しいが、交互の名指しで抜けられる。採らない理由として残す

#### (2) 上限の値と根拠（値は案。決めるのは PM）

- **案: `MAX_RELAY_ROUNDS = 10`**（`relay-policy.ts` の定数。`MAX_RELAY_HOPS` の隣）
- 根拠:
  - `MAX_RELAY_HOPS = 3` は**深さ**（依頼に答える途中で開く入れ子）の上限で、往復の上限は**横の長さ**（返事を受けて次を開く連続）の上限。入れ子は 3 段で足りるが、PM の普通の使い方（送る → 返事 → 次を送る）は 1 日に何十回も続くので、3 では L1（#4418）の 4 回目で止まる。深さと同じ値は使えない
  - `MAX_OPEN_RELAYS_PER_PAIR = 1` により、同じ向きの往復は必ず 1 本ずつ順に進む。暴走の速さは「受け手の 1 ターン」で決まり（数分）、10 回なら暴走は受け手のおよそ 10 ターン分で止まる
  - 期限（既定 24h・最大 7 日）は 1 本の relay の寿命で、連続の回数は縛らない。往復の上限は期限では代えられない
  - 人の普通の行で 0 に戻る（(3)）ので、上限に当たった PM のセッションは、人が 1 行打てば続けられる。上限は「人が見ないまま 10 往復した」の合図として働く
- **段 2 の前に PM に確かめてほしいこと**: 実際の PM のセッションで、人の行を挟まずに続く返事の数（#4418 レーン a の運用で 1 回の作業に何往復するか）。10 で足りなければ値だけ変える（構造は同じ）

#### (3) 数える窓（どこまで遡るか・何で 0 に戻るか）

- **人の普通の行で 0 に戻る**（#2377 の「人が打てば連鎖が切れる」と同じ規則・同じ判定）。S の履歴を新しい順に読み、§3.1 と同じく、返事の行とその echo は数えて先へ進み、`requestId` の無い `relay` 行（`prompt`・`expired` の知らせ）は数えずに先へ進み、それ以外の user 行（人の行、`to` 側の依頼の行）に当たったら止まる
- **時間の窓は置かない**。返事と次の依頼の間が何時間空いても、人の行が無ければ同じ連続。時間で戻すと、遅い受け手との暴走が時間をかけて上限を抜けられる
- **読む量（実装で変えた。§3.3・I10）**: 親の探索と往復の数えを 1 回の歩き（`scanRelayLineage`）にまとめ、確定した終わりまで読む（固定の窓にしない）。fc01e3bd0 の 45 ターンの固定窓は実装レビューで窓の端の問題が出たので I10 で書き直した。初めの案（上限 +1 ターンを別に読み、親の探索は 5 ターンのまま）は、返事と echo が本当の親を 5 ターンの窓から押し出す（I7）ので採らなかった
- 注意: 人以外の普通の行（ほかのエージェントが relay なしで S に `send` した行、`flow tick` が PM に送る 1 行）も「人の行」と同じく 0 に戻す。#2377 の規則が既にそうで、行に送り手が無い（§1-3）ので見分けられない。これは上限が緩む向きの限界として書いておく

#### (4) どこから数えるか（ledger か履歴か・migration）

- **履歴の返事の行から数える**（推奨）。返事の行は `relay-delivery` が依頼元に必ず 1 本書き、`requestId` で ledger に戻れる（`relay.from` が S かを §3.1 と同じ判定で確かめる）。「人の行で 0 に戻る」は履歴にしか無い情報なので、どのみち履歴を読む
- **新しい列・migration は要らない**。変更は `src/lib/relay/` の中で閉じる（`getMessages`・`getRelayById` を使う）
- 代案（ledger）: `session_relays` に `rounds` の列を足し、開くときに直前の返事の relay の `rounds + 1` を書く。migration（`src/lib/db/`、scope 外）が要り、「人の行で 0」を判定するのに結局履歴を読む。採らない

#### (5) 期限・cancelled との関係

- **期限切れの relay は数えない**: 返事の行が無く、届くのは `requestId` の無い `expired` の知らせ（`relay` 行）だけ。知らせは数えず、0 にも戻さない（人の行ではない）
- **cancelled の relay は数えない**: 依頼元に行が書かれない
- **数えるのは届いた返事だけ**。「返事が届いたので次を開く」が暴走の形で、返事の来なかった relay はその形にならない
- 返事の行が名指す relay が消えている（`getRelayById` が null）: 返事と決められない（I4）。§3.1 ではその行を親として扱い今までどおり null（fail-open）。往復の数えでも**そこで止める**（数えた分だけで判定する。新しい fail-open を足さないため、決められない行を返事として数え足すことも、0 に戻すこともしない — 止めるのはそれ以上遡らないという意味）

#### (6) 断るときのコードと `--allow-relay-chain`

- **推奨: 既存の `RELAY_HOPS_EXCEEDED` を使い、文面で往復の上限と言う**（例: `This session has opened ${n} relays in a row, each right after a reply, with nothing typed in between; the limit is ${MAX_RELAY_ROUNDS}. Have a person look before sending another.`）
  - 理由: CLI は `src/cli/commands/relays.ts` の `RELAY_REFUSAL_CODES`（決まった 5 つ）に入るコードだけを exit 2 と文面で返し、それ以外は一般のエラーとして投げる。新しいコードは CLI・`RelayRefusalCode`・API の文書の変更（公開の契約の変更、`src/cli/` は scope 外）になる。`RELAY_HOPS_EXCEEDED` は「連鎖の上限に当たった。旗では抜けられない」という今の意味のまま使える
  - 代案: 新しいコード `RELAY_ROUNDS_EXCEEDED`。利用者とスクリプトが深さと往復を見分けられる。公開の契約の変更で、scope に `src/cli/commands/relays.ts`・`src/cli/types/api-responses.ts`（あれば）と CLI の埋め込みの説明を足す必要がある。PM が選ぶなら scope の追加とセットで
- **`--allow-relay-chain` は往復の上限を外さない**（`MAX_RELAY_HOPS` と同じく「戸を広げるが壁は外さない」。#2377 の規則 2 の文言どおり）。旗で外せると、暴走するエージェントが旗を付けて送り直すだけで抜けられる
- 判定の順は `decideRelayCreation` の今の順の `RELAY_HOPS_EXCEEDED` の直後・`RELAY_DUPLICATE_PENDING` の前（自分宛て・ツールの方針・連鎖・深さ・往復・重複）。純関数のまま、`relay-service` が数えた `replyRounds: number` を入力に足す

#### (7) 返事の行の扱いと hops

- 返事の行は親に数えない（§3.1、案 A と同じ）。Issue の事象（2 回目の `RELAY_CHAIN_BLOCKED`）はこれで直る
- 暴走は往復の上限で止める（(2)〜(6)）。両者は別の数で、互いを打ち消さない: 返事の行は「親」には数えず「往復」には数える
- **hops の数え方は案 A と同じ**（`to` 側の行が親のときだけ親の hops + 1。返事の後の依頼は hops 1）。往復で hops を増やすと、深さ 3 の上限が往復 3 回目で効いて PM の使い方が止まる（(2) の 1 つ目）

### 2.3 案 B（別 Issue を推奨）: 受け手の側に本当の親を持たせる

- B の「A の依頼に答えている途中」を ledger から決める（B が `to` で開いていて、bound で `inputBoundaryAt` があり、その時刻以降に人の行が無い relay を親とする）
- 今の本番では通っている「依頼に答える途中で別の relay を開く」を新たに拒否する（D2）。#4420 の範囲を越える

### 2.4 案 A と案 C の比較

| 観点 | 案 A | 案 C |
|---|---|---|
| Issue の事象（返事の後の 2 回目・3 回目が断られる）が直るか | 直る | 直る（往復の上限の手前まで。上限に当たったら人の 1 行で戻る） |
| 本番で連鎖の禁止（`RELAY_CHAIN_BLOCKED`）が効くか | 効かない（D1。`to` 側の行の書き手が無い） | 効かない（同じ。D2 の形を止めるのは案 B） |
| 本番で上限（`RELAY_HOPS_EXCEEDED`）が効くか | 効かない（hops は常に 1） | 効く（往復の上限として。人の行の無い連続 `MAX_RELAY_ROUNDS` 回で断る） |
| PM の不変条件（深さ・往復の上限が残る） | 満たさない | 満たす（深さは今と同じく `to` 側の行に対して、往復は新しい上限で） |
| 既存の運用への影響 | なし（今断られている形が通るだけ） | 人の行を挟まない返事 → 依頼が `MAX_RELAY_ROUNDS` 回続くと断られる（今は 2 回目で断られているので、今より緩い） |
| 変更の大きさ | `findParentRelayHops` の探索のみ | 案 A ＋ 往復を数える関数・`decideRelayCreation` の入力 1 つ・定数 1 つ・文面 1 つ |
| migration | 不要 | 不要（履歴から数える。(4)） |
| 公開の契約の変更 | なし | なし（`RELAY_HOPS_EXCEEDED` を使う場合）。新しいコードを選べばあり（(6)） |

## 3. 変更（実装）

### 3.1 1 回の歩き（`scanRelayLineage`）で、親と往復の数を決める

`relay-service.ts` に `scanRelayLineage(db, from): { parentHops, replyRounds, truncated }` を足し、`findParentRelayHops`・`countConsecutiveReplyRounds` はその片方を返す。`openRelay` は 1 回だけ呼んで両方を `decideRelayCreation` に渡す。

```
読み: 依頼元の user 行を 32 ターン読む（getMessages、limitUnit 'pairs'、同期）。歩きが確定した終わりに
      当たらなければ 64・128・256・501 ターンと読み直す（I10）
並べ: 新しい順。同じ時刻は普通の行を先に、relay 行どうしは挿入順（rowid）の新しい順（I7・I10）
pending = []
各行 row について:
  row が relay 行でない → pending に積む
  row が relay 行:
    pending の行が 1 本でも row（または同じ時刻の relay 行）の echo でない → 終わり（人の行。#2377。I3・I8）
    pending = []
    id が無い（prompt・expired の知らせ） → 親が未決なら「親なし」に決める（今までどおり。I4）。数えも 0 戻しもせず先へ
    relay があり relay.from が自分（isSameEndpoint） → 返事。replyRounds += 1 して先へ（I1・I2）。
      MAX_RELAY_ROUNDS に届いたら終わり（断ることが決まる）
    それ以外（自分が to の relay、relay が消えた） → 親が未決ならこの行の hops（消えていれば null）。終わり（I4）
読んだ行が尽きた:
  履歴を全部読んだ（読めた user 行が頼んだ数より少ない） → 履歴の始まり。終わり（pending が残っていれば、
    その後ろに relay 行は無いので人の行。終わり）
  まだ後ろがある → 終わりではない（未照合の echo も終わりにしない）。倍のターンで読み直す
  501 ターン（MAX_RELAY_LINEAGE_ROWS + 1）を読んでも終わりに当たらない → truncated: true、replyRounds は確かめた本数
ledger が読めない（例外） → { parentHops: null, replyRounds: 0, truncated: false }（今までの fail-open の向き）
```

- **echo の帰属（I8）**: 新しい順に、次の relay 行までの普通の行をまとめ、それらをその relay 行（とそれと同じ時刻の relay 行）にだけ `isEchoOfRelayRow`（#2387、変えない）で照合する。同じ時刻の relay 行も見るのは、同じ時刻の返事・知らせ・echo の並びで帰属が変わらないようにするため（I10）。「echo R2 → 返事 R2 → echo R1 → 親 R1」は親 R1 を残す。返事 R2 と同じ本文でも R2 より古い行は R1 と照合され、echo でないので人の行として終わる
- **「同じセッション」**: `relay.from` と `from` の worktree と instance が文字どおり同じ（`isSameEndpoint`）。同じ worktree の別 instance・食い違いは返事と決めず、親として扱う（I4）。**別名**: instance の別名（alias）と id が食い違った relay は自分の返事と決めず親として扱う（fail-closed。親があれば連鎖として断る側）。API・CLI は endpoint を id に解決してから送るので、本番でこの食い違いが起きる経路は見つかっていない（影響小。実装レビュー opus P3）
- 往復の数え: 親が決まった後も、知らせ・返事を歩いて数え続ける。`MAX_RELAY_ROUNDS` に届いたら止める（断ることが決まる。親が未決なら `findParentRelayHops` は null を返すが、`openRelay` は往復の上限で断る）

### 3.2 往復の上限（`relay-policy.ts`）

- `MAX_RELAY_ROUNDS = 10`（名前つきの定数 1 か所。試験は定数を参照）
- `decideRelayCreation` の入力に `replyRounds?: number`（省略時 0）。判定の順は 自分宛て → ツールの方針 → 連鎖（`RELAY_CHAIN_BLOCKED`）→ 深さ（`RELAY_HOPS_EXCEEDED`）→ **往復（`RELAY_HOPS_EXCEEDED`）** → 重複（`RELAY_DUPLICATE_PENDING`）。純関数のまま
- 往復の文面（深さの `Relay chains stop at …` と見分けがつく）: `This session has opened relays ${n} times in a row, each right after a reply, with nothing typed in between; round trips stop at 10. Have a person look before sending another (any ordinary message resets the count).`
- 読み切れなかったとき（入力 `historyTruncated?: boolean`、往復が上限未満のとき）の文面（I10。「10 回続けた」と言わない）: `Only ${n} replies in a row could be confirmed: this session's history has no ordinary message within the last 500 rows, so the round-trip count (limit 10) could not be read to its end. Have a person look before sending another (any ordinary message resets the count).`
- `MAX_RELAY_LINEAGE_ROWS = 500`（名前つきの定数 1 か所）
- `allowRelayChain` では外れない

### 3.3 窓の端と同じ時刻（I7・I10）

- **確定した終わりまで読む（I10）**: 往復の数と親は、確定した終わり（人の普通の行・履歴の先頭・親の行・消えた relay の行・返事 `MAX_RELAY_ROUNDS` 本）まで読んで決める。固定の件数の窓で読み切ったことを終わりとみなさない。fc01e3bd0 の 45 ターンの窓は、(1) 窓の最後が未照合の echo（対の行が窓の外）だと人の行として終わって上限を抜け、(2) 知らせが窓を食うと 0〜数本の返事で「10 回続けた」と断り、(3) ちょうど 45 件で終わる履歴も上限扱いにした（実装レビュー codex P1・P2、opus P2）
- **読み方**: 同期のまま（#4466 の設計が同期の読みを前提にしている）。`getMessages` を `limitUnit: 'pairs'` で 32 ターンから倍々に読み直す（`before` でのページ送りは、同じ時刻の行がページの境で割れるので使わない。`pairs` は境の時刻の行を全部含む）。知らせ・echo は数えずに進む。履歴を全部読んだかは「読めた user 行が頼んだ数より少ない」で決める（ちょうどの件数でも、倍で読み直して確かめる）
- **固い上限**: `MAX_RELAY_LINEAGE_ROWS = 500`。501 ターン読んでも終わりに当たらなければ断る（fail-closed、`RELAY_HOPS_EXCEEDED`）。文面は確かめた本数と「読み切れなかった」を言う。上限の判定のため 1 行先（501）まで読み、同じ時刻の行の組は割らない
- **未照合の echo**: 読んだ行の最後に、対の relay 行がまだ読めていない普通の行が残っても、それを終わり（人の行）としない。読み進めて決める。履歴を全部読んで残ったときだけ人の行
- **assistant の多いターン**: `pairs` は user 行で数えるので、assistant 行は読む量に効かない
- **同じ時刻**: SQLite の `ORDER BY timestamp DESC` は同じ時刻の行の順を決めないので、読んだ後に並べ直す: 同じ時刻なら普通の行を新しい側（echo は relay 行より古くならないため、echo として照合される。人の行なら連鎖を切る）、relay 行どうしは挿入順（`rowid`）の新しい順。普通の行は同じ時刻の relay 行のどれの echo でもよい（返事・知らせ・echo が同じ時刻でも、どの挿入順でも 10 本目の返事を数える）。決められない並びでも、確定した上限を解除しない（返事 `MAX_RELAY_ROUNDS` 本に届けばそこで終わり、断る）
- 返事と echo が並んで本当の親が 5・6・7 件目に来ても親は見える。「古い無関係な relay を親と取り違えない」は窓ではなく歩きの規則（echo と自分の返事・知らせしか飛ばさず、それ以外で止まる）が守る

## 4. 不変条件（試験で固定した）

- **I1** 返事の行は親に数えない: 行が名指す relay の `from` がこのセッション自身なら、それは自分の依頼への返事
- **I2** 返事の行は本当の親を隠さない: 返事の行（とその echo）を飛ばした後も探索を続け、その後ろに自分が `to` の relay の行があれば、それを親として hops を数える
- **I3** 人が普通の行を打った後に連鎖が切れる規則（#2377）と echo の判定（#2387 の `isEchoOfRelayRow`）は変えない
- **I4** 判定できないとき（ledger が読めない・relay が消えた・id が無い）の向きは今までの文書どおり。返事か依頼かが決められない行は親として扱う（返事と決められたときだけ飛ばす）
- **I5** hops の上限・期限・`--allow-relay-chain` の意味は変えない
- **I6** 往復の上限: 依頼元セッション単位（相手を問わず）で、人の普通の行が入るまでに受けた自分の relay の返事の数が `MAX_RELAY_ROUNDS` 以上なら、次の relay を `RELAY_HOPS_EXCEEDED` で断る。旗では外れない。期限切れ・cancelled（返事の行が無いもの）は数えない。返事と決められない行（relay が消えた等）で数えるのを止め、数え足しも 0 戻しもしない。migration は足さない
- **I7** 返事と echo が本当の親を窓から押し出さない。同じ時刻の行は普通の行を新しい側に並べる
- **I10（窓の端）** 往復の数と親は確定した終わり（人の普通の行・履歴の先頭など）まで読んで決める。固定の件数の窓で読み切ったことを終わりとみなさない。同期の読みで、終わりの行・返事 `MAX_RELAY_ROUNDS` 本・固い上限 `MAX_RELAY_LINEAGE_ROWS`（500 行）のどれかまで読む。固い上限で止まったら断り、文面は確かめた本数と読み切れなかったことを言う。未照合の echo は終わりとしない。同じ時刻の型が混ざる行は挿入順で並べ、決められないときも確定した上限を解除しない
- **I8** echo の帰属は 1 通り: 次の relay 行までの普通の行をその relay 行（と同じ時刻の relay 行）にだけ照合する
- **I9** 上限の陰性対照は手順を分ける（深さ 2 の親 → 旗で深さ 3 → 返事 → 次も深さ 3 / 深さ 3 の親で次を拒否）。実ルートの拒否で、relay の新規行・chat の新規行がゼロ（tmux の呼び出しゼロは補助。このルートはどの経路でも tmux に届かないので、それだけでは弱い）

## 5. 試験

`tests/unit/lib/relay/relay-reply-not-parent-4420.test.ts`（59 件）と `tests/integration/relay-reply-rounds-route-4420.test.ts`（2 件）。行は `relay-delivery` が書く形（依頼元の履歴に `messageType: 'relay'`・`requestId: relay:<id>`・本文は `buildRelayReplyMessage`）で置く。

- I1（陽性）: 返事の後の A→B（旗なし・hops 1）、A→C、3 回目、echo を挟んでも通る
- I2・I9: (i) 深さ 2 の親 → 旗で A→B（深さ 3）→ 返事 → 旗なし `RELAY_CHAIN_BLOCKED`・旗あり深さ 3 / (ii) 深さ 3 の親の前に返事 → 旗あり `RELAY_HOPS_EXCEEDED`・旗なし `RELAY_CHAIN_BLOCKED` / 親と返事の間・返事の後の人の行で連鎖が切れる
- I4: 消えた relay の返事の行は親（null）でその後ろの親に届かない、知らせが最新なら null、同じ worktree の別 instance の relay は返事にしない
- I7: 親が 5・6・7 件目、同じ時刻の echo と返事・人の行と返事・親と返事（挿入の順を両方）
- I8: 「echo R2 → 返事 R2 → echo R1 → 親 R1」、返事より古い同じ本文の行、#2392（読み手が行を書かない）、人が同じ本文を打ち直した行（既知の制限として固定）、別の本文
- I6: 上限 -1 は通る、上限で断る（旗あり・なし、文面、relay の新規行ゼロ）、相手を交互にしても続く、人の行で 0、echo を数えない、期限切れの知らせは数えも 0 戻しもしない、cancelled を数えない、消えた relay の行で止まる、自分が `to` の行で止まる、知らせだけの履歴は先頭まで読んで 0 本（fc01e3bd0 では「読み切ったら断る」と固定していた試験の期待を I10 で変えた）、instance ごと
- I10: 知らせのみ 44・45・46 件（通る）、返事 3＋知らせ 40・45（通る）、ちょうど 45 件で終わる履歴（返事 3＋知らせ 42、通る）、返事 10＋知らせ＋割れた echo＋知らせ 31・44・63 件（断る。読みの端 32・64 と旧窓 45 で echo が割れる）、割れた echo の後ろの返事を数える、同じ時刻の返事・知らせ・echo の 3 通りの挿入順（10 本目を数えて断る）、assistant の多いターン（9 本は通る・10 本は断る）、500 行の上限で止まる（断る・文面が確かめた本数）、上限の手前の履歴は先頭まで読む
- 変異で確かめた（コミットに残さない）: 窓の件数で打ち切る変異（45 ターン固定、読み切り＝終わり）で I10 の 8 件が赤、未照合の echo を終わりとする変異で割れた echo の 2 件（31・63）が赤
- 純関数: `replyRounds` 省略時は今までどおり、上限未満は通る、上限で `RELAY_HOPS_EXCEEDED`（旗で外れない）、連鎖が先・重複が後
- 実ルート: 返事の後の `POST /api/relays` が 201・hops 1 / 10 往復の後は旗あり・なしとも 409 `RELAY_HOPS_EXCEEDED`（往復の文面）、relay・chat の行数が変わらない（tmux の呼び出しゼロは補助）
- 既存の `the loop guard`・#2387・クローズ後の再作成の試験は変えずに緑

## 6. 既知の制限

- (a) 行に送り手が無い（§1-3）ため、人以外の普通の行（relay なしの `send`・`flow tick` の 1 行など）でも往復の数は 0 に戻る（上限が緩む向き）。**相互の relay（A と B が互いに relay を開く）では「約 10 ターンで止まる」は成り立たない**: B に届く A の依頼は普通の行なので B の数は 0 に戻り、依頼に答える途中の relay も (b) のとおり止まらない。10 ターンの見積もりは片側の暴走（A が返事のたびに次を開く）にだけ当てはまる
- (b) 依頼に答える途中で開く B→C の relay は、受け手の依頼の行に relay の印が無いため今も本番で止まっておらず、この変更でも変わらない（D2）。続きは #4492（Sprint 9。bound の `input_message_id` を使う案を含む）
- (c) 人が返事と同じ本文を打ち直した行は、#2387 の規則どおり echo と区別できない（返事の本文は `[from …]` の枠つき）
- (d) 人の行を挟まずに 500 行を読んでも終わりに当たらないときは断る（fail-closed。文面は確かめた本数と読み切れなかったことを言う。§3.3）
- (e) 同じ時刻の relay 行どうしは挿入順（`rowid`）で並べる。挿入順が実際の順と違う書き手があれば、その並びは挿入順のまま読む（§3.3）

## 7. 対になる場所

- 説明の写し: `src/lib/relay/relay-policy.ts` 冒頭の規則 2 と `decideRelayCreation` の JSDoc、`relay-service.ts` の `findParentRelayHops`・窓の定数の JSDoc（直した）
- 利用者向け: `docs/user-guide/cli-operations-guide.md` と `docs/en/user-guide/cli-operations-guide.md` の `--allow-relay-chain` の行に 1 文（ja・en 同じ内容。直した）
- scope 外（直さず本文に無い指摘として報告）: `src/cli/docs/agent-operations.ts:124,177,213,1080`・`src/cli/commands/send.ts:1064`・`src/cli/commands/relays.ts` の `ALLOW_RELAY_CHAIN_DESCRIPTION`（CLI 埋め込みの説明。返事の扱いと往復の上限が書かれていない）
- 文面: 深さの文面（`Relay chains stop at`）は変えていない。往復の文面は新しく足しただけ

## 8. 決定（PM、2026-11-19）

1. 案 C で進める
2. `MAX_RELAY_ROUNDS = 10`（名前つきの定数 1 か所。#4418 の使い方で 10 に当たったら lead-return に書き、値の見直しは受け入れの後に PM が決める）
3. 断るコードは既存の `RELAY_HOPS_EXCEEDED`（往復の上限と分かる文面）。新しいコードは作らない。`--allow-relay-chain` では外れない
4. 数える単位は依頼元セッション単位、0 に戻すのは普通の行だけ（時間の窓なし）
5. 既知の制限 (a)・(b) を了承（§6）
