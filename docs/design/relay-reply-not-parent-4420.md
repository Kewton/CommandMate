# Issue #4420: 自分が開いた relay の返事を、次に開く relay の親に数えない（設計）

- 状態: **往復の数え方は [relay-rounds-window-4420.md](./relay-rounds-window-4420.md) の案 Q に置き換えた（PM の決定 2026-11-19）**。この文書で今も正なのは「返事の行を親に数えない」部分（§1・§2 の事実、§3.1、I1〜I5・I8・I9）。案 C の往復の数え方（履歴を歩いて人の行で 0 に戻す。§2.2・旧 I6・I7・I10・旧既知の制限 (a)(d)(e)）は採らなくなり、履歴として §9 に残す
- 対象: `src/lib/relay/relay-service.ts` の `findParentRelayHops`（連鎖の親の探索）と `countRecentReplyRounds`（往復の数。案 Q）、`relay-policy.ts` の `decideRelayCreation` の往復の上限（hops の上限・期限・`--allow-relay-chain` の意味は変えない）
- 試験: `tests/unit/lib/relay/relay-reply-not-parent-4420.test.ts`（実 DB `better-sqlite3` + `runMigrations`、既存の `relay-parent-hops-2387.test.ts` と同じ形）、`tests/integration/relay-reply-rounds-route-4420.test.ts`（実ルート `POST /api/relays`、`os.tmpdir()` の一時ファイル DB）、`tests/integration/relay-reply-rounds-delivery-4420.test.ts`（返事の行を本物の配送 `deliverOne` で作る）

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

### 2.2 案 C（採用の後、往復の数え方は案 Q に置き換えた。§9）: 返事を親に数えず、返事 → 次の依頼の「往復」を別に数えて上限を置く

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

## 3. 変更（実装。案 Q の後）

### 3.1 親の探索（`findParentRelayHops`）: 自分の返事とその echo を飛ばす

develop の 5 ターンの窓（`PARENT_RELAY_LOOKBACK_TURNS`、`limitUnit: 'pairs'`）のまま、新しい順に user 行を見る:

```
newer = []
各行 row について:
  row が relay 行でない → newer に積む
  row が relay 行:
    newer の行が 1 本でも row の echo でない（isEchoOfRelayRow、#2387）→ null（人の行。#2377。I3・I8）
    newer = []
    id が無い（prompt・expired の知らせ） → null（今までどおり。I4）
    relay があり relay.from が自分（isSameEndpoint） → 自分の返事。飛ばして先へ（I1・I2）
    それ以外（自分が to の relay、relay が消えた） → その hops（消えていれば null）（I4）
窓の行が尽きた → null
ledger が読めない（例外） → null（今までの fail-open の向き）
```

- echo は直後（ひとつ古い側）の relay 行にだけ照合する（I8）。「echo R2 → 返事 R2 → echo R1 → 親 R1」は親 R1 を残す
- 「同じセッション」は `relay.from` と `from` の worktree と instance が文字どおり同じ（`isSameEndpoint`）。同じ worktree の別 instance・別名（alias と id の食い違い）は返事と決めず親として扱う（fail-closed）
- 窓は 5 ターンのまま。返事と echo が 5 ターンを超えて親の前に並ぶと親は見えない（fail-open。develop と同じ向き。案 Q の既知の制限 Q-4）。本番では親になる行が無い（D1）ので、本番の動きには効かない

### 3.2 往復の上限（案 Q）

[relay-rounds-window-4420.md](./relay-rounds-window-4420.md) §2.1 のとおり。要点:

- `countRecentReplyRounds(db, from, now)`: `session_relays` の 1 本の COUNT を同期で読む。`from` が自分（worktree・instance）で、返事が届いた（`sent_request_id` あり・`delivered_at` が窓の中）か、返事の配送が `uncertain` で保留中（`pending_kind = 'reply'`・`delivery_at` が窓の中）。人の行・echo・知らせ・書かれた順は見ない。migration なし
- `RELAY_ROUNDS_WINDOW_MS = 30 分`、`MAX_RELAY_ROUNDS = 10`（`relay-policy.ts` の名前つきの定数）。`replyRounds >= 10` で `RELAY_HOPS_EXCEEDED`、`--allow-relay-chain` では外れない。判定の順は 自分宛て → ツールの方針 → 連鎖 → 深さ → **往復** → 重複
- 文面: `This session received ${n} replies to its relays in the last 30 minutes; the limit is 10. Wait before opening another (the count clears as replies age out).`
- 拒否のたびに構造化ログ `relay-rounds-refused`（`session`・`n`・窓の中の最も古い返事と最も新しい返事の時刻）

## 4. 不変条件（試験で固定した）

- **I1** 返事の行は親に数えない: 行が名指す relay の `from` がこのセッション自身なら、それは自分の依頼への返事
- **I2** 返事の行は本当の親を隠さない: 返事の行（とその echo）を飛ばした後も探索を続け、5 ターンの窓の中で、その後ろに自分が `to` の relay の行があれば、それを親として hops を数える
- **I3** 人が普通の行を打った後に連鎖が切れる規則（#2377）と echo の判定（#2387 の `isEchoOfRelayRow`）は変えない
- **I4** 判定できないとき（ledger が読めない・relay が消えた・id が無い）の向きは今までの文書どおり。返事か依頼かが決められない行は親として扱う（返事と決められたときだけ飛ばす）
- **I5** hops の上限・期限・`--allow-relay-chain` の意味は変えない
- **I8** echo の帰属は 1 通り: 次の relay 行までの普通の行をその relay 行にだけ照合する
- **I9** 上限の陰性対照は手順を分ける（深さ 2 の親 → 旗で深さ 3 → 返事 → 次も深さ 3 / 深さ 3 の親で次を拒否）。実ルートの拒否で、relay の新規行・chat の新規行がゼロ（tmux の呼び出しゼロは補助）
- 往復の上限の不変条件は案 Q（relay-rounds-window-4420.md §2.3「識別・順に頼る箇所 0」）

## 5. 試験

relay-rounds-window-4420.md §2.4 の表のとおり。単体（SQL・純粋・親）、結合（実ルート、本物の配送で作る Issue の事象と相互の往復、既知の限界の向きの固定）。旧 I7・I10 の窓・同じ時刻・500 行の試験は消した（§9）。

## 6. 既知の制限

relay-rounds-window-4420.md §2.3 の Q-1〜Q-11 を正とする。この文書の旧 (a)（人以外の普通の行で 0 に戻る）・(d)（500 行）・(e)（同じ時刻の挿入順）は、履歴を読まなくなったので無くなった。旧 (b)（依頼に答える途中で開く B→C の relay は本番で止まっていない。#4492）と (c)（人が返事と同じ本文を打ち直した行は echo と区別できない。親の探索だけに残る）は残る。

## 7. 対になる場所

- 説明の写し: `src/lib/relay/relay-policy.ts` 冒頭の規則 2・`MAX_RELAY_ROUNDS`・`RELAY_ROUNDS_WINDOW_MS` と `decideRelayCreation` の JSDoc、`relay-service.ts` の `findParentRelayHops`・`countRecentReplyRounds` の JSDoc（直した）
- 利用者向け: `docs/user-guide/cli-operations-guide.md` と `docs/en/user-guide/cli-operations-guide.md` の `--allow-relay-chain` の行に 1 文（ja・en 同じ内容。直した）
- scope 外（直さず本文に無い指摘として報告）: `src/cli/docs/agent-operations.ts:124,177,213,1080`・`src/cli/commands/send.ts:1064`・`src/cli/commands/relays.ts` の `ALLOW_RELAY_CHAIN_DESCRIPTION`（CLI 埋め込みの説明。返事の扱いと往復の上限が書かれていない）
- 文面: 深さの文面（`Relay chains stop at`）は変えていない。往復の文面は新しく足しただけ（案 Q の文面）

## 8. 決定（PM、2026-11-19）

1. 案 C で進める
2. `MAX_RELAY_ROUNDS = 10`（名前つきの定数 1 か所。#4418 の使い方で 10 に当たったら lead-return に書き、値の見直しは受け入れの後に PM が決める）
3. 断るコードは既存の `RELAY_HOPS_EXCEEDED`（往復の上限と分かる文面）。新しいコードは作らない。`--allow-relay-chain` では外れない
4. 数える単位は依頼元セッション単位、0 に戻すのは普通の行だけ（時間の窓なし）
5. 既知の制限 (a)・(b) を了承（§6）
6. （同日、設計し直し）往復の数え方は案 Q（時間の窓。W = 30 分、N = 10、2 段目の窓は入れない）に置き換える。正は relay-rounds-window-4420.md §2。上の 4 は案 Q で無くなった

## 9. 履歴: 案 C の往復の数え方（採らなくなった）

案 C は、依頼元の履歴を新しい順に歩き、人の普通の行までに受けた自分の返事を数えた（`scanRelayLineage`・`countConsecutiveReplyRounds`、99811ebb1 では確定した終わりまで倍々に読み直す I10 と、500 行の固い上限 `MAX_RELAY_LINEAGE_ROWS`）。人の行と echo の見分け・窓の端・同じ時刻の並び・書かれた順に頼る箇所から、レビューのたびに同じ種類の穴が出た（設計レビュー P2、実装レビュー P1・P2）ため、PM の決定で案 Q に置き換え、コードと試験は消した。比較は relay-rounds-window-4420.md §0〜§4。

