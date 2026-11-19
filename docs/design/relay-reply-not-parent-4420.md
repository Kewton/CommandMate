# Issue #4420: 自分が開いた relay の返事を、次に開く relay の親に数えない（設計）

- 状態: 設計（段 1）。実装（段 2）はレビューの処分を受けてから
- 対象: `src/lib/relay/relay-service.ts` の `findParentRelayHops`（連鎖の親の探索）。案 C では `relay-policy.ts` の `decideRelayCreation` に往復の上限を 1 つ足す（hops の上限・期限・`--allow-relay-chain` の意味は変えない）
- 試験: `tests/unit/lib/relay/relay-reply-not-parent-4420.test.ts`（新規。実 DB `better-sqlite3` + `runMigrations`、既存の `relay-parent-hops-2387.test.ts` と同じ形）

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

### 2.2 案 C（不変条件を満たす候補）: 返事を親に数えず、返事 → 次の依頼の「往復」を別に数えて上限を置く

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
- **読む量**: `getMessages(..., limit: MAX_RELAY_ROUNDS + 1, limitUnit: 'pairs')`（ターン単位。返事の行 1 本 = 1 ターン）。上限 +1 ターンまで読んで、止まる行に当たらなければ「上限以上」と決められる。今の親の探索（5 ターン）とは別の読み（親の探索の窓は I5 で変えない）
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

## 3. 変更

### 3.1 返事の行を親に数えない（案 A・案 C 共通）

`findParentRelayHops` の探索を、最初の `relay` 行で止めるのではなく、**返事と決められた行（とその echo）を飛ばして続ける**形にする。

```
recentUserRows（新しい順）を i = 0.. で見る:
  行が relay 行でない:
    その行が直後（古い側）の relay 行の echo でなければ → null（人の行。#2377）
  行が relay 行:
    relayId = parseRelayRequestId(row.requestId)
    relay   = relayId ? getRelayById(db, relayId) : null
    relay があり relay.from が from と同じセッション → 返事。行を飛ばして続ける（I1）
    それ以外 → この行を親として、今までどおり hops（relay が無い・id が無いなら null）を返す（I4）
```

- echo の判定は今の `isEchoOfRelayRow`（#2387）をそのまま使う。「ある relay 行より新しく、その一つ新しい relay 行より古い行」がその relay 行の echo であることを要求する。echo でない行が現れた時点で null（I3）
- **「同じセッション」の判定**: `relay.from.worktreeId === from.worktreeId` かつ instance が同じ（`isSameEndpoint`）。instance の比較は、`getMessages` が行を選ぶときの解決（`resolveRelaySession(db, from)`・`matchResolvedInstance`）と同じ規則にそろえる。比べられない・食い違うときは「返事と決められない」として親に数える（I4）
- 窓（`PARENT_RELAY_LOOKBACK_TURNS = 5`）は変えない（I5）。返事の行を飛ばした先が窓の外なら親なし
- `requestId` の無い `relay` 行（`prompt`・`expired` の知らせ）は、今までどおり「最初の relay 行で、id が無い → null」（I4。今もここで null なので向きは変わらない）

### 3.2 往復を数えて上限を置く（案 C のみ）

- `relay-service.ts` に `countConsecutiveReplyRounds(db, from): number` を足す。§2.2 (3) の読み方で、人の行（または返事と決められない relay 行）に当たるまでの返事の行を数える。ledger が読めないときは 0（今の親の探索と同じ fail-open の向き。新しい向きを足さない）
- `decideRelayCreation` の入力に `replyRounds`（省略時 0。既存の呼び手と試験は変わらない）を足し、`replyRounds >= MAX_RELAY_ROUNDS` なら `RELAY_HOPS_EXCEEDED`（(6) の文面）。旗では外れない
- `openRelay` が `replyRounds: countConsecutiveReplyRounds(db, input.from)` を渡す

## 4. 不変条件（試験で固定する）

- **I1** 返事の行は親に数えない: 行が名指す relay の `from` がこのセッション自身なら、それは自分の依頼への返事
- **I2** 返事の行は本当の親を隠さない: 返事の行（とその echo）を飛ばした後も探索を続け、その後ろに自分が `to` の relay の行があれば、それを親として hops を数える
- **I3** 人が普通の行を打った後に連鎖が切れる規則（#2377）と echo の扱い（#2387）は変えない
- **I4** 判定できないとき（ledger が読めない・relay が消えた・id が無い）の向きは今までの文書どおり。返事か依頼かが決められない行は親として扱う（返事と決められたときだけ飛ばす）
- **I5** hops の上限・期限・`--allow-relay-chain` の意味は変えない
- **I6（案 C）** 往復の暴走は止まる: 人の行を挟まない「返事 → 次の依頼」は `MAX_RELAY_ROUNDS` 回で断られ、旗でも外れない。相手を替えても数は続く。人の普通の行で 0 に戻る

## 5. 試験（段 2。先に書き、直す前に赤を確かめる）

`tests/unit/lib/relay/relay-reply-not-parent-4420.test.ts`。行は `relay-delivery` が書く形（依頼元の履歴に `messageType: 'relay'`・`requestId: relay:<id>`・本文は `buildRelayReplyMessage`）で置く。実 DB（`better-sqlite3` の `:memory:` + `runMigrations`）。

- 陽性（直す前は赤）
  - A→B を開く → B の返事が A に届く → A→B の次の relay（旗なし）が通り hops 1
  - 同じ状態から A→C（別の相手）も通る
  - 3 回目（返事 → 依頼 → 返事 → 依頼）も通る。返事の echo（#2387 の seed）を挟んでも通る
- 陰性対照（直す前も後も同じ）
  - 既存の `the loop guard` / #2387 の試験（`to` 側の行 → `RELAY_CHAIN_BLOCKED`・旗で hops+1・上限で `RELAY_HOPS_EXCEEDED`）を消さずに緑のまま
  - I2: X→A の行（A が `to`）を置き、A が旗つきで A→B を開き（hops 2）、B の返事が A に届いた後、A→C を旗なしで開くと `RELAY_CHAIN_BLOCKED`。旗ありなら hops 3、X の行の hops を `MAX_RELAY_HOPS` にしておけば `RELAY_HOPS_EXCEEDED`
  - I3: 返事の後に人が普通の行を打てば親なし。返事と依頼の行の間に人の行があれば、依頼の行は親にならない
  - I4: 返事の行が名指す relay を消すと、その行は親として扱われ今までどおり null。`requestId` の無い `relay` 行（`prompt` の知らせ）が最新なら今までどおり null
- 案 C の往復の上限（I6）
  - 上限の手前は通る: 返事 → 依頼を `MAX_RELAY_ROUNDS - 1` 回続けた後の次の依頼は通る（直す前は 2 回目で赤）
  - 上限で断る: `MAX_RELAY_ROUNDS` 本目の返事の後の依頼は `RELAY_HOPS_EXCEEDED`、`allowRelayChain: true` でも同じ
  - 別の相手でも数は続く: B・C を交互に名指しても `MAX_RELAY_ROUNDS` で断る
  - 人の行で戻る: 上限に当たった後に人の普通の行を 1 本置くと次の依頼が通る
  - 期限切れ・cancelled は数えない: `expired` の知らせ（`requestId` 無しの `relay` 行）を挟んでも数は増えず、0 にも戻らない。cancelled の relay は行が無いので数に入らない
  - echo は数えない: 各返事の後に echo を seed しても数は返事の本数のまま
  - `decideRelayCreation` の純関数の試験（`relay-policy.test.ts` と同じ形を新しいファイルで）: `replyRounds` 省略時は今までどおり、上限で `RELAY_HOPS_EXCEEDED`、旗で外れない、判定の順（`RELAY_CHAIN_BLOCKED` が先、`RELAY_DUPLICATE_PENDING` が後）

## 6. 対になる場所（段 2 で直す・報告する）

- 説明の写し: `src/lib/relay/relay-policy.ts` 冒頭の規則の説明（案 C なら往復の上限を規則として足す）、`relay-service.ts` の `findParentRelayHops` の JSDoc（scope 内。直す）
- 利用者向け: `docs/user-guide/cli-operations-guide.md:1120` と `docs/en/user-guide/cli-operations-guide.md:917` の `--allow-relay-chain` の行に、返事を受けた後の次の依頼は連鎖に数えない旨を 1 文（ja・en 同じ内容）。案 C なら往復の上限（人の行を挟まない連続 N 回で断る・旗では外れない・人が 1 行打てば戻る）も 1 文
- scope 外（直さず本文に無い指摘として報告）: `src/cli/docs/agent-operations.ts:124,177,213,1080`・`src/cli/commands/send.ts:1064`・`src/cli/commands/relays.ts` の `ALLOW_RELAY_CHAIN_DESCRIPTION`（CLI 埋め込みの説明。返事の扱いと往復の上限が書かれていない）
- 文面: 案 C で `RELAY_HOPS_EXCEEDED` の往復用の文面を足す（既存の深さの文面は変えない）。段 2 で `git grep -l 'Relay chains stop at' -- tests/integration tests/e2e` を流し結果を書く

## 7. 段 2 に進む条件

- 案の処分: 案 C（不変条件を満たす候補）か、人の判断で案 A か
- 案 C を選ぶ場合に PM が決める値
  1. `MAX_RELAY_ROUNDS` の値（案 10。§2.2 (2)。PM のセッションで人の行を挟まずに続く返事の実数を見て決める）
  2. 数える単位: 相手を問わず `from` 単位（推奨）か、同じ向き単位か（§2.2 (1)）
  3. 断るコード: `RELAY_HOPS_EXCEEDED` を使う（推奨・scope 内）か、新しいコード `RELAY_ROUNDS_EXCEEDED`（公開の契約の変更・`src/cli/` を scope に追加）か（§2.2 (6)）
  4. 0 に戻す条件は人の普通の行だけで、時間の窓は置かない（§2.2 (3)）でよいか
  5. 人以外の普通の行（relay なしの `send`・`flow tick` の 1 行）でも 0 に戻る限界（§2.2 (3) の注意）を受け入れるか
- changelog と利用者向けの 1 文に、D3（返事の往復は連鎖の禁止ではなく往復の上限で止まる）を書く
