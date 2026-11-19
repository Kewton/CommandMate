# Issue #4420: 自分が開いた relay の返事を、次に開く relay の親に数えない（設計）

- 状態: 設計（段 1）。実装（段 2）はレビューの処分を受けてから
- 対象: `src/lib/relay/relay-service.ts` の `findParentRelayHops`（連鎖の親の探索）。`relay-policy.ts`（`decideRelayCreation`）・hops の上限・期限・`--allow-relay-chain` は変えない
- 試験: `tests/unit/lib/relay/relay-reply-not-parent-4420.test.ts`（新規。実 DB `better-sqlite3` + `runMigrations`、既存の `relay-parent-hops-2387.test.ts` と同じ形）

## 1. 前提（事実。実コードで確かめた）

1. 連鎖の判定は `openRelay` → `findParentRelayHops(db, from)`。依頼元セッション（`from`）の直近 5 ターンの user 行を新しい順に読み、最初の `messageType === 'relay'` の行を親とする。それより新しい user 行がすべてその行の echo（`isEchoOfRelayRow`、#2387）なら、行の `requestId`（`relay:<id>`）が名指す relay の `hops` を返す。echo でない行（人の普通の行）が挟まれば null（#2377 の「人が打てば連鎖が切れる」）。relay が消えた・ledger が読めない・`requestId` が無い → null（fail-open: 連鎖でない）
2. `messageType: 'relay'` の行を書くのは `relay-delivery.ts` の `deliverOne`（`sendUserMessage(..., messageType: 'relay')`）**だけ**。書き先は常に `requester`＝relay の **`from`**（依頼元）。`requestId: relay:<id>` が付くのは `kind === 'reply'`（返事）のときだけで、`prompt`（受け手のプロンプト待ちの知らせ）・`expired`（期限切れの知らせ）は `requestId` 無しの `relay` 行
3. 受け手（`to`）に届く依頼そのもの（`send --reply-to` の本文）は、`send` ルートが書く**普通の user 行**（`messageType: 'normal'`、`relay:` の `requestId` 無し）。bound relay（#3957）も ledger に入力の開始時刻（`inputBoundaryAt`）を記録するだけで、行には relay を指す印を付けない（`relay-bind.ts`。#4418 の `docs/design/flow-relay-watch-4418.md` §1 も「受け手の履歴は送り手を持たない」と確認している）
4. したがって**本番で `findParentRelayHops` が親として拾う行は、すべて「このセッション自身が `from` の relay の返事」**である。Issue の事象（送る → 返事 → 次を送る の 2 回目が `RELAY_CHAIN_BLOCKED`）はこの読みのとおりに起きる
5. 既存の試験（`relay-service.test.ts` の `the loop guard`・`relay-parent-hops-2387.test.ts`）は、`openRelay({ from: C, to: A })` の relay を名指す `relay` 行を **A（`to`）の履歴**に手で置き、「A は relay された依頼に答えている途中」を表している。この行の形（`to` 側に `relay:<id>` の行）は本番のどの書き手も書かない

## 2. 契約の前提との食い違い（レビューで処分してほしい点）

契約の【原因】【不変条件】は「依頼の受け手には自分への依頼の行（自分が `to` の relay を名指す行）がある」ことを前提にしている（I2・陰性対照「B が A の依頼に答える途中で C へ開く relay は `RELAY_CHAIN_BLOCKED` のまま」）。実コードでは §1-3 のとおりその行は書かれない。帰結:

- **(D1) I1 をそのまま入れると、本番の連鎖の禁止は事実上効かなくなる。** 本番で親になり得る行は返事の行だけで、それをすべて飛ばすため、`findParentRelayHops` は本番では常に null（親なし）を返し、`hops` は常に 1 になる。`RELAY_CHAIN_BLOCKED` と `RELAY_HOPS_EXCEEDED` が本番で出る経路が無くなる
- **(D2) 「B が A の依頼に答える途中で C へ開く relay」は、今の本番でも止まっていない。** B の履歴の依頼の行は普通の行なので、今の `findParentRelayHops` も B に親を見つけない。「今までの試験」が固定しているのは本番に無い行の形（§1-5）に対する動きで、契約の陰性対照は今の本番の動きとしては成り立っていない
- **(D3) #2377 の連鎖の禁止が本番で実際に止めていたのは、まさに本件の形（返事を受けた依頼元が次の relay を開く）だった。** #2377 の受入条件「relay で届いたメッセージを受けた B が同じ相手へ `--reply-to` で返そうとすると既定で exit 2」の「relay で届いたメッセージ」は、本番では返事の配送しか無い。つまり本件は「誤検知の除去」ではなく「#2377 が本番で止めていた唯一の形を許す」変更になる。返事を受けたエージェントが毎回 `--reply-to` で送り返す往復（A↔B の ping-pong）を止めるものは、修正後は「同じ向きの開いた relay は 1 本まで」（`countOpenRelaysBetween`）と期限だけになる

PM の決定（依頼元一般に適用・同じ相手との往復に別の上限を設けない）は D3 を受け入れる判断と読めるが、D1（`hops` の上限が本番で一度も効かなくなる）まで含めて受け入れるかは契約に書かれていない。次の 3 案から選んでほしい。

### 案 A（推奨・契約どおり）: 返事の行を飛ばし、`to` 側の行は親として残す

- 実装は §3 のとおり。I1〜I5 を満たし、既存の試験はすべてそのまま緑（それらの行は `to` 側なので I2 で親として拾われる）
- D1 を受け入れる。`to` 側の分岐は、今は本番の書き手が無いが、将来どこかが依頼の行に `relay:<id>` を付けた（または #2387 以前の DB に残る行・別の書き手が同じ形の行を書いた）ときに連鎖の禁止と hops の上限が効くための、試験で固定した規則として残る
- 段 2 の申し送りと changelog に D1・D3 を書く（「返事の後の依頼は連鎖に数えない。そのため返事の往復は連鎖の禁止の対象外になり、同じ向きの開いた relay は 1 本までの規則と期限で止まる」）

### 案 B: 受け手の側に本当の親を持たせる（I2 を本番でも効かせる）

- B の「A の依頼に答えている途中」を ledger から決める: B が `to` で、開いていて（`pending`/`prompt`）、bound で `inputBoundaryAt` があり、B の履歴のその時刻以降に人の普通の行が無い relay があれば、それを親とする
- 今の本番では通っている「依頼に答える途中で別の relay を開く」（orchestrate のリーダーが PM の relay に答える途中でワーカーへ `--reply-to` するなど）を**新たに拒否する**。既存の運用を壊しうる挙動の追加で、#4420 の範囲（不具合修正）を越える。依頼の行と人の行の見分け（§1-3）も ledger の時刻に頼ることになる。別 Issue を推奨

### 案 C: 返事の後の依頼に別の上限を設ける

- 同じ相手との「返事 → 次の依頼」の回数を数えて上限を置く。PM の決定（別の上限を設けない）に反するので挙げるだけ

## 3. 変更（案 A）

`findParentRelayHops` の探索を、最初の `relay` 行で止めるのではなく、**返事と決められた行（とその echo）を飛ばして続ける**形にする。

```
recentUserRows（新しい順）を i = 0.. で見る:
  行が relay 行でない:
    その行が「直前に飛ばした/これから見る relay 行」の echo でなければ → null（人の行。#2377）
  行が relay 行:
    relayId = parseRelayRequestId(row.requestId)
    relay   = relayId ? getRelayById(db, relayId) : null
    relay があり relay.from が from と同じセッション → 返事。行を飛ばして続ける（I1）
    それ以外 → この行を親として、今までどおり hops（relay が無い・id が無いなら null）を返す（I4）
```

- echo の判定は今の `isEchoOfRelayRow`（#2387）をそのまま使う。今は「親の行より新しい行はすべて親の echo」を要求している。修正後は「ある relay 行より新しく、次の relay 行より古い行」がその relay 行の echo であることを要求する（返事の行の echo は飛ばし、依頼の行の echo は今までどおり親の echo として扱う）。echo でない行が現れた時点で null（人の行で連鎖が切れる。I3）
- **「同じセッション」の判定**: `relay.from.worktreeId === from.worktreeId` かつ instance が同じ。instance の比較は、`getMessages` が行を選ぶときに使っている解決（`resolveRelaySession(db, from)` と `matchResolvedInstance`）と同じ規則にそろえる（例: 呼び手が `instanceId` を既定の値で渡し、relay には解決後の値が入っている場合に食い違わないこと）。比べられない・食い違うときは「返事と決められない」として親に数える（I4: 返事と決められたときだけ飛ばす）
- 探索の窓（`PARENT_RELAY_LOOKBACK_TURNS = 5` ターン）は変えない（I5）。返事の行を飛ばした先が窓の外なら親なし（今までの「窓の外の古い relay を親と取り違えない」と同じ向き）
- `relay` 行で `requestId` が無いもの（`prompt`・`expired` の知らせ）は、今までどおり「最初の relay 行で、id が無い → null」。返事と決められないので飛ばさない（I4。新しい fail-open を足さない。今もここで null を返しているので向きは変わらない）
- `decideRelayCreation`・`MAX_RELAY_HOPS`・TTL・`allowRelayChain` は触らない（I5）

## 4. 不変条件（試験で固定する）

- **I1** 返事の行は親に数えない: 行が名指す relay の `from` がこのセッション自身なら、それは自分の依頼への返事
- **I2** 返事の行は本当の親を隠さない: 返事の行（とその echo）を飛ばした後も探索を続け、その後ろに自分が `to` の relay の行があれば、それを親として hops を数える。返事を挟んでも連鎖の禁止・深さの上限を抜けられない
- **I3** 人が普通の行を打った後に連鎖が切れる規則（#2377）と echo の扱い（#2387）は変えない
- **I4** 判定できないとき（ledger が読めない・relay が消えた・id が無い）の向きは今までの文書どおり。返事か依頼かが決められない行は親として扱う（返事と決められたときだけ飛ばす）
- **I5** hops の上限・期限・`--allow-relay-chain` の意味は変えない

## 5. 試験（段 2。先に書き、直す前に赤を確かめる）

`describe('... (#4420)')`。行は `relay-delivery` が書く形（依頼元の履歴に `messageType: 'relay'`・`requestId: relay:<id>`・本文は `buildRelayReplyMessage`）で置く。

- 陽性（直す前は赤）
  - A→B を開く → B の返事が A に届く → A→B の次の relay（旗なし）が通り hops 1
  - 同じ状態から A→C（別の相手）も通る
  - 3 回目（返事 → 依頼 → 返事 → 依頼）も通る。返事の echo（#2387 の seed）を挟んでも通る
- 陰性対照（直す前も後も同じ）
  - 既存の `the loop guard` / #2387 の試験（`to` 側の行 → `RELAY_CHAIN_BLOCKED`・旗で hops+1・上限で `RELAY_HOPS_EXCEEDED`）を消さずに緑のまま
  - I2: X→A の行（A が `to`）を置き、A が旗つきで A→B を開き（hops 2）、B の返事が A に届いた後、A→C を旗なしで開くと `RELAY_CHAIN_BLOCKED`。旗ありなら hops 3、X の行の hops を `MAX_RELAY_HOPS` にしておけば `RELAY_HOPS_EXCEEDED`
  - I3: 返事の後に人が普通の行を打てば親なし（今までどおり）。返事と依頼の行の間に人の行があれば、依頼の行は親にならない
  - I4: 返事の行が名指す relay を消すと、その行は返事と決められず親として扱い、今までどおり null（fail-open の向きは今と同じ）。`requestId` の無い `relay` 行（`prompt` の知らせ）が最新なら今までどおり null
- 試験 DB は既存の relay の試験と同じく `better-sqlite3` の実 DB（`:memory:` + `runMigrations`）。リポジトリのファイルは書き換えない

## 6. 対になる場所（段 2 で直す・報告する）

- 説明の写し: `src/lib/relay/relay-policy.ts` 冒頭の規則 1 の説明、`relay-service.ts` の `findParentRelayHops` の JSDoc（scope 内。直す）
- 利用者向け: `docs/user-guide/cli-operations-guide.md:1120` と `docs/en/user-guide/cli-operations-guide.md:917` の `--allow-relay-chain` の行に、返事を受けた後の次の依頼は連鎖に数えない旨を 1 文（ja・en 同じ内容）
- scope 外（直さず本文に無い指摘として報告）: `src/cli/docs/agent-operations.ts:124,177,213,1080`・`src/cli/commands/send.ts:1064` の CLI 埋め込みの説明（「relay で届いたメッセージに答える途中」の表現。意味は変わらないが、返事の扱いが書かれていない）
- 文面・エラーコードは変えないので、integration・e2e の文面固定の探索は不要（段 2 で `git grep` は流して結果を書く）

## 7. 段 2 に進む条件

- §2 の D1〜D3 を受けて、案 A（推奨）・B・C のどれで進めるかの処分
- 案 A の場合、changelog と利用者向けの 1 文に D3（返事の往復は連鎖の禁止の対象外になり、同じ向きの開いた relay は 1 本までの規則と期限で止まる）を書くかどうか
