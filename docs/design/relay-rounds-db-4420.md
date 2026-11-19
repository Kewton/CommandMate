# 往復の数と連鎖の親を DB に持つ（Issue #4420 の数え方の設計し直し）

- 段: 設計（この文書だけ）。コード・DB・試験は書かない。実装は、設計レビュー 2 本の処分の後に、開発リーダー（claude-3）のレーンで行う（`fix/4420-relay-reply-not-parent`、PR は 1 本）
- 版: 第 1 版（2026-11-19、イネーブラー claude-5）。PM の決定（Q1〜Q5、§9.1）を書き足した
- 基準:
  - develop `b8f6e33b8`（v0.53.0）
  - #4420 のブランチ `fix/4420-relay-reply-not-parent` の `99811ebb1`（読むだけ）
  - 行番号はこの版のもの。「事実」は file:line、「見立て」「未確認」は明記する
- 正:
  - Issue #4420
  - 今の設計 `../commandmate-issue-4420/docs/design/relay-reply-not-parent-4420.md`（以下「旧設計」。不変条件 I1〜I10、PM の決定 §8）
- 材料:
  - `workspace/orchestration/runs/2026-11-19/s8/` の `lead-stop-4420-window.md`・`lead-stop-4420-redesign.md`
  - 同じ場所の `pm-reply-4420-design.md`・`pm-reply-4420-window.md`・`pm-reply-4420-redesign.md`
  - 同じ場所のレビュー `review-4420-design.md`・`review-4420-codex.md`・`review-4420-opus.md`・`review-4420-codex-r2.md`・`review-4420-opus-r2.md`
- PM の決定（`pm-reply-4420-redesign.md`）:
  - 数え方そのものを設計し直す（往復の数を DB に持つ）
  - migration は v73
  - 案 C の外側の決まり（`MAX_RELAY_ROUNDS = 10`・`RELAY_HOPS_EXCEEDED`・旗で外れない・依頼元セッションの単位・人の普通の行で 0）は変えない
- 筆者の関わり: 筆者は #4420 の実装・旧設計・レビューに関わっていない

---

## 0. 結論（先に）

- **往復の数と連鎖の親を、依頼元セッション（worktree＋instance）ごとの 1 行の状態として DB に持つ**
  - 新しい表は `relay_session_rounds`（v73）
  - 状態は、chat の user 行を書く**唯一の入口**（`createMessage`、`src/lib/db/chat-db.ts:183-226`）で、**行の挿入と同じトランザクション**の中で進める
- relay を開くときは、その 1 行を同期で読むだけにする（`openRelay`・#4466 の S2）。履歴は読み直さない
  - これで、3 回出た同じ種類の穴（窓の端・同じ時刻の並び・読み切れない上限）が、すべて仕組みとして無くなる
  - 状態は「書かれた順」に進むので、時刻の並べ替えも、窓も、読み切りの上限も要らない
- 状態の進み方は、旧設計の歩き（新しい行から古い行へ読む）を、**書かれる時点で 1 行ずつ前へ進める**形に写したもの（§3）
  - 返事の行で +1（親は変えない）
  - 人の普通の行で 0 に戻し、親を外す
  - 知らせの行では数を変えず、親を外す
  - echo では何も変えない
  - 自分が `to` の relay の行では、親にして数を 0 に戻す
- 初期値は「行なし＝ 0・親なし」（§5）
  - 本番には親になる行が無い（旧設計の D1）ので、親は今と変わらない
  - 往復の数は、移行の直後に 1 回だけ緩む（各セッションが 0 から数え直す）。既知の制限にする
- 公開の契約は変えない（同じ code・同じ文面の型・同じ exit）。窓の「読み切れなかった」の文面（旧設計 §3.2 の 2 つ目）は要らなくなるので消す

---

## 1. なぜ履歴の読み直しをやめるのか（3 回の同じ種類）

| 回 | 指摘 | 形 |
|---|---|---|
| 1 | 設計レビュー codex P2-1 | 返事と echo が、本当の親を 5 ターンの窓から押し出す |
| 2 | 実装レビュー（fc01e3bd0）codex P1・P2、opus P2 | 窓の最後の未照合の echo で上限が抜ける／知らせが窓を食って誤って断る／ちょうど 45 件の履歴を上限扱い／同じ時刻の型の並び |
| 3 | 再レビュー（99811ebb1）codex P2×3 | 501 行目が拒否を解除する／同じ時刻で型を優先して返事を捨てる／普通の行だけの長い履歴を読み切れないとして断る |

- 共通の原因（読み）: 「書かれた順の出来事の列」を、後から**時刻の並べ替えと有限の窓**で復元しようとしている
  - 時刻は同じ値を持ちうる（ms の衝突）
  - 窓には端がある
  - 端を広げると、上限と負荷が衝突する
- 書かれる時点なら、順は 1 つに決まっている。数をそのときに進めれば、復元は要らない

---

## 2. 不変条件

### 2.1 外側の決まり（変えない。PM の決定）

| # | 決まり |
|---|---|
| E1 | 返事の行は連鎖の親に数えない（Issue の事象を直す） |
| E2 | 本物の連鎖（自分が `to` の relay に答える途中で開く relay）は、今までどおり `RELAY_CHAIN_BLOCKED`、深さの上限は `RELAY_HOPS_EXCEEDED` |
| E3 | 返事 → 次の依頼の往復は、人の普通の行を挟まずに `MAX_RELAY_ROUNDS = 10` 回で `RELAY_HOPS_EXCEEDED`。`--allow-relay-chain` では外れない。依頼元セッション単位（相手を問わず） |
| E4 | 公開の契約（code・exit・API・CLI）を変えない |

### 2.2 この設計の不変条件

| # | 不変条件 |
|---|---|
| R1 | 状態は、chat の user 行の挿入と**同じトランザクション**で進む。行があって状態が進んでいない（逆も）ことは無い |
| R2 | user 行を書く入口は `createMessage` の 1 つだけ。ほかの経路で `chat_messages` に INSERT しない（今もそう。`chat-db.ts:194` が唯一の INSERT。静的な試験で固定する） |
| R3 | relay を開くときの判定は、状態の 1 行の同期の読みだけで決まる。履歴を読まない。窓・時刻の並べ替え・読み切りの上限を持たない |
| R4 | 状態の進み方は §3 の表の 1 つだけ。どの書き手（送信・relay の配送・端末の直の入力の記録・hook の記録）も同じ表を通る |
| R5 | 行が無い状態は「0・親なし」と同じ意味 |
| R6 | 判定できないときの向きは旧設計 I4 のまま。親の relay が消えていれば hops は null（連鎖でない）。往復の数は DB の値をそのまま使う（消えた relay の分も数えたまま。厳しい向き） |

---

## 3. 状態と、その進み方

### 3.1 表（v73）

```sql
CREATE TABLE relay_session_rounds (
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,              -- chat_messages.instance_id と同じ、解決済みの id
  rounds INTEGER NOT NULL DEFAULT 0 CHECK (rounds >= 0),
  parent_relay_id TEXT,                   -- 連鎖の親（自分が to の relay）。NULL = 親なし
  last_relay_message_id TEXT,             -- 直近の relay 行（echo の照合に使う）
  last_reset_message_id TEXT,             -- 直近に 0 へ戻した行（記録・試験用）
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (worktree_id, instance_id)
);
```

- `worktree_id` の列を持つので、worktree の削除と ID の改名は、今の子の表の見つけ方（`src/lib/db/migrations/worktree-child-tables.ts`、#1621）が自動で扱う（§6）
- `rounds` に上限の CHECK は置かない（判定は `>= MAX_RELAY_ROUNDS`）

### 3.2 進み方（`createMessage` の中、同じトランザクション）

user 行（`role = 'user'`）を書くときだけ、次の表で状態を進める。assistant 行は状態を変えない。

| 書く行の種類 | 判定（行の値だけで決まる） | rounds | parent | last_relay_message_id |
|---|---|---|---|---|
| **返事** | `message_type = 'relay'`、`request_id = relay:<id>`、その relay の `from` が、この行の (worktree, instance) と文字どおり同じ（`isSameEndpoint`） | **+1** | 変えない（E1。本当の親を隠さない＝旧 I2） | この行 |
| **自分が `to` の relay の行**（依頼の行。本番の書き手は今は無い、旧設計 D1。試験の形） | `message_type = 'relay'`、`request_id = relay:<id>`、その relay の `to` がこの行の (worktree, instance) | **0** | **その relay**（旧 I2: 親の後ろの行は数えない） | この行 |
| 返事とも依頼とも決められない relay の行 | `request_id = relay:<id>` で、relay が無い・端がどちらとも一致しない | 0 | その id（hops を読むと null。旧 I4 の「親として扱う」） | この行 |
| **知らせ**（`prompt`・`expired`） | `message_type = 'relay'`、`request_id` なし | 変えない | **NULL**（旧 I4: 知らせが最新なら親なし） | この行 |
| **echo** | `message_type = 'normal'` で、`last_relay_message_id` の行の echo（`isEchoOfRelayRow`、#2387 の関数を変えずに使う。行を id で 1 つ読むだけ） | 変えない | 変えない | 変えない |
| **人の普通の行** | `message_type = 'normal'` で、echo でない | **0** | **NULL** | 変えない |
| そのほかの user 行（`prompt`・`prompt_response` など） | — | 変えない | 変えない | 変えない |

- 旧設計の歩き（新しい行から古い行へ）を、書かれる時点の前向きの更新に写したもの。対応は次のとおり
  - 歩きが「返事は数えて先へ進む」→ 前向きでは +1
  - 歩きが「人の行で終わる」→ 前向きでは、人の行が来たら、それより古いものは数えない（0 に戻す）
  - 歩きが「知らせが親より新しければ親なし」→ 前向きでは、知らせが来たら親を外す
- **`prompt_response` などで 0 に戻さない**（§9 の PM に伺う点 Q1）
  - 旧設計の歩きは、relay でないすべての user 行で終わっていた
  - しかし Auto-Yes の答え（機械の行）で数が戻ると、上限が効かない
  - この設計の推奨は「`message_type = 'normal'` の行だけで 0 に戻す」（厳しい向き）
  - `prompt_response` の user 行を書く書き手があるかは未確認（`grep` では見つからなかった、§10）
- echo の照合は、直近の relay 行 1 つだけと行う
  - #2392 の後、端末の記録（`src/lib/history/user-turn-recorder.ts:29-40`・`:347-360`）は relay の配送の行と同じ本文の行を書かない。このため echo は古い履歴か、ほかの書き手にしか出ない（読み）
  - 直近の relay 行より前の relay 行の echo が後から来ると、人の行として 0 に戻る（緩む向き）。既知の制限 (c) にする
- 同じ時刻の行: 状態は**書かれた順**（トランザクションの順）で進む。時刻を見ない。旧 I7・I10 の同じ時刻の規則は要らなくなる

### 3.3 開くときの読み（`openRelay`、同期）

```
row = SELECT rounds, parent_relay_id FROM relay_session_rounds WHERE worktree_id = :from.wt AND instance_id = :from.inst
rounds = row?.rounds ?? 0
parentHops = row?.parent_relay_id ? (getRelayById(parent)?.hops ?? null) : null   -- 消えていれば null（R6）
decideRelayCreation({ …, parentHops, replyRounds: rounds })                       -- 純関数。判定の順は旧設計 §3.2 のまま
```

- `findParentRelayHops`・`scanRelayLineage`・`countConsecutiveReplyRounds`（99811ebb1）は消す。代わりに `readRelaySessionRounds(db, from)` を置く（同期、1 行の SELECT）
- #4466 の設計（S2 の中の同期の読み）とそのまま合う。#4466 の文書の `countConsecutiveReplyRounds` の名前は、この関数に読み替える（§8）
- 文面: 往復の上限の文面（旧設計 §3.2 の 1 つ目）は変えない。「読み切れなかった」の文面と `MAX_RELAY_LINEAGE_ROWS` は消す

---

## 4. 同時の更新・期限・cancelled・消えた relay

| 場面 | 扱い |
|---|---|
| 同時の更新 | `createMessage` の行の挿入と状態の UPSERT を、1 つの `db.transaction` に入れる。better-sqlite3 は同期なので、同じプロセスの中で 2 つの書き込みが混ざらない。別のプロセスは API を通るので、同じ DB の書き込みの直列で決まる |
| 開くのと返事が同時 | 開く判定は、その時点の数で決まる。開いた後に届いた返事は、次に開くときに数える（旧設計と同じ意味） |
| 期限切れ | 返事の行は書かれない。届くのは `expired` の知らせで、数を変えず親を外す（旧 I6 と同じ） |
| cancelled | 依頼元に行は書かれない。何も変わらない（旧 I6 と同じ） |
| 返事を数えた後に relay が消える（worktree の削除の CASCADE など） | 数えたまま（R6。厳しい向き）。旧設計では「消えた relay の行で数えるのを止める」だった。数は大きくなる側にだけ変わる |
| 親の relay が消える | 開くときに hops は null（連鎖でない。旧 I4 と同じ fail-open の向き） |
| 返事の行の挿入が失敗する | トランザクションごと戻るので、数も進まない（R1） |
| 履歴を消す操作（会話の archive など） | 状態は変えない（数は残る。厳しい向き）。0 に戻すのは人の普通の行だけ |

---

## 5. 初期値と migration v73

| 案 | 中身 | 判断 |
|---|---|---|
| **A（推奨）** | 表を作るだけ。行は無い（＝ 0・親なし、R5） | ○ |
| B | migration の中で、各セッションの履歴を旧設計の歩きで 1 回読み、初期値を入れる | × |

**案 A を推奨する理由**:
- 親は本番では今も常に null（旧設計 D1: 本番に `to` 側の relay 行の書き手が無い）。初期値で変わらない
- 往復の数は、移行の直後に各セッションが 0 から数え直す。上限が 1 回だけ（最大 10 往復分）緩む。既知の制限 (d) にする
- 案 B は、3 回出た窓の問題を migration に持ち込む。migration の時間が履歴の長さに比例する

**migration の中身**:
- v73 は `CREATE TABLE relay_session_rounds` と主キーだけ。down は `DROP TABLE`
- 番号の v73 は PM の割り当て（`pm-reply-4420-redesign.md` の 2）

---

## 6. worktree の削除（#4490）との関係

- 今の削除（`deleteWorktreeChildRows`）は、`worktree_id` の列を持つ表を全部消す（#4490 の本文）。`relay_session_rounds` も消える。`chat_messages` も同じく消えるので、状態と履歴は食い違わない
- #4490 の方針（子の表を「所有＝状態」と「履歴」に分ける）では、この表は**状態**（worktree と一緒に消す側）にする。worktree がなくなれば、そのセッションの往復は意味を持たない
- #4490 の実装で、`chat_messages` が「履歴」（残す側）に分かれた場合の扱い:
  - 同じ ID の worktree を作り直すと、状態は 0 から、履歴は残る。食い違うが、緩むのは 1 回だけ（既知の制限 (d) と同じ向き）
  - #4490 の設計に「`relay_session_rounds` は状態」と 1 行を足すよう、PM に渡す
- worktree の ID の改名（`renameWorktreeIdPreservingChildren`）では、子の表として付け替わり、数は続く

---

## 7. 旧設計の不変条件 I1〜I10 の対応表

| 旧 | 中身 | この設計での扱い |
|---|---|---|
| I1 | 返事の行は親に数えない | **残る**（§3.2 の返事の行は親を変えない） |
| I2 | 返事は本当の親を隠さない | **残る**（返事の後も親はそのまま。親の行は数を 0 にする） |
| I3 | 人の行で連鎖が切れる（#2377）・echo の判定（#2387）は変えない | **残る**（人の普通の行で 0・親なし。echo は `isEchoOfRelayRow` を変えずに、直近の relay 行と照合） |
| I4 | 判定できないときの向き | **残る**（R6。決められない relay 行は親として扱い、hops は null） |
| I5 | hops の上限・期限・旗の意味は変えない | **残る** |
| I6 | 往復の上限（セッション単位・旗で外れない・期限切れ・cancelled は数えない・migration なし） | **残る。ただし 2 つ変える**: migration を足す（PM の決定）。消えた relay の返事も数えたまま（R6） |
| I7 | 返事と echo が親を窓から押し出さない・同じ時刻の並び | **消える**（窓も並べ替えも無い） |
| I8 | echo の帰属は 1 通り | **簡単になって残る**（直近の relay 行とだけ照合。既知の制限 (c)） |
| I9 | 上限の陰性対照の手順の分け方・実ルートで新しい行がゼロ | **残る**（試験の決まり。§8） |
| I10 | 窓の端（確定した終わりまで読む・500 行の上限） | **消える**（読み直さない） |
| — | 新しい: R1〜R6 | §2.2 |

---

## 8. 試験の層と陰性対照

| 層 | 試験 | 陰性対照（変異で赤） |
|---|---|---|
| 単体（純粋） | §3.2 の表を純粋な関数（`nextRelaySessionState(prev, row, ledgerLookup)`）にして、行の種類 × 前の状態の全部の組で、次の状態を確かめる | 返事で親を変える変異（I1/I2 の行が赤）。返事で 0 に戻す変異。知らせで 0 に戻す・親を残す変異（I4 の行が赤）。echo で 0 に戻す変異。`prompt_response` で 0 に戻す変異（Q1 の答えに合わせる） |
| 単体（store） | `createMessage` で user 行を書くと、同じトランザクションで状態が進む。挿入の後の状態の UPSERT で例外を注入すると、行も残らない | 状態の更新をトランザクションの外へ出す変異で、行が残り数が進まず赤（R1） |
| 単体（静的、R2） | `src` の中で `INSERT INTO chat_messages` が `chat-db.ts` の `createMessage` の 1 か所だけ | 別の INSERT の経路を足す変異で赤 |
| 結合（書き手ごと、R4） | 本物の書き手で行を書く: 送信（`sendUserMessage`、偽の tmux）・relay の配送（`deliverOne`、返事・prompt・expired）・端末の直の入力の記録（`recordUserTurn`）。それぞれで状態が §3.2 のとおり進む | 1 つの書き手だけ別の関数で状態を進める変異で、その書き手の行が赤 |
| 結合（判定） | `openRelay`: 返事 9 本の後は通る、10 本で `RELAY_HOPS_EXCEEDED`（旗あり・なし、文面）。人の普通の行の後は 0。相手を交互にしても数え続ける。知らせを挟んでも数は変わらない。親（`to` 側の行）の後の返事でも親は残る（旗なしで `RELAY_CHAIN_BLOCKED`） | `openRelay` で状態でなく履歴を読む変異（旧関数を戻す）は、下の回帰の行で赤 |
| 結合（3 回の穴の回帰） | 3 回の指摘の場面を、状態の進み方として置く: (1) 普通の行だけの 501 行の履歴の後 → 0、通る（旧 r2 の 3）。(2) 同じ ms に普通の行 → 返事 1 の順で書き、その後に返事 9 本 → 書かれた順で 10、断る（旧 r2 の 2）。(3) 知らせ 500 本の後の普通の行 → 0（旧 r2 の 1）。(4) 知らせだけ 45 本 → 0・通る（旧 1 回目・2 回目） | 時刻の並べ替えを持ち込む変異で (2) が赤 |
| 結合（実ルート、旧 I9） | `POST /api/relays` の拒否で、relay の新規行・chat の新規行がゼロ。深さの陰性対照は手順を分ける（深さ 2 の親 → 旗で深さ 3 → 返事 → 次も深さ 3／深さ 3 の親で次を拒否） | — |
| migration | v73 で表ができ、既存の行は変わらない。down で消える。worktree の削除で行が消え、ID の改名で付け替わる（子の表の見つけ方が拾う） | 表から `worktree_id` の列名を変える変異で、子の表の見つけ方に拾われず赤 |
| #4466 との整合 | `readRelaySessionRounds` が同期の関数で、#4466 の S2 の中で呼べる（型の試験か、await の無いことの lint） | — |

- 既存の `the loop guard`・#2387・クローズ後の再作成の試験は、行の置き方を「`createMessage` で書く」形にそろえて、期待は変えずに緑にする
  - 旧設計 §1-5 のとおり、`to` 側の行を手で置く試験は、本番に無い形を表す
  - 状態は `createMessage` で進むので、試験の行も `createMessage` を通して書く。直に INSERT する試験の helper があれば直す
- 99811ebb1 の I7・I10 の試験（窓・同じ時刻の並べ替え）は、上の回帰の行に置き換える（期待は「書かれた順」で読む）

---

## 9. PM に伺う点

| # | 問い | 推奨 |
|---|---|---|
| Q1 | 0 に戻す入口を `message_type = 'normal'` の user 行だけにするか。旧設計の歩きは、relay でないすべての user 行（`prompt_response` などを含む）で終わっていた | `normal` だけ。Auto-Yes の答えなど、機械の答えで上限が緩むのを防ぐ（厳しい向き。公開の契約は変わらない） |
| Q2 | 初期値（§5） | 案 A（表だけ。移行の直後に 1 回緩む） |
| Q3 | 消えた relay の返事も数えたままにする（R6。旧 I6 からの変更） | する（厳しい向き） |
| Q4 | 99811ebb1 の扱い | 同じブランチに作り直しのコミットを積むか、develop から切るかはリーダーが決める（`pm-reply-4420-redesign.md` の 4 のとおり）。窓の関数と試験は消す |
| Q5 | #4490 の設計に「`relay_session_rounds` は状態」を足すよう渡すか | 渡す |

- 人に伺う点は無い（公開の契約は変えない。E4）

### 9.1 PM の決定（2026-11-19、Q1〜Q5 はすべて推奨どおり）

| # | 決定 |
|---|---|
| Q1 | 0 に戻す入口は `message_type = 'normal'` の user 行だけ。`prompt`・`prompt_response` などでは戻さない（§3.2） |
| Q2 | 初期値は案 A（表だけ。行なし＝ 0・親なし。移行の直後に 1 回だけ緩むのを既知の制限 (d) とする。§5） |
| Q3 | 消えた relay の返事も数えたままにする（R6。旧 I6 からの変更。§4） |
| Q4 | 99811ebb1 の扱い（同じブランチに作り直しのコミットを積むか、develop から切るか）は開発リーダーが決める |
| Q5 | #4490 の設計に「`relay_session_rounds` は状態（worktree と一緒に消す側）」を足すよう渡す（§6） |

---

## 10. 既知の制限と未確認

**既知の制限**:
- (a) 人以外の普通の行でも 0 に戻る（旧 (a) と同じ。行に送り手が無い）
- (b) 依頼に答える途中の B→C は止まらない（旧 (b)、#4492）
- (c) 直近の relay 行より前の relay 行の echo が後から来ると、人の行として 0 に戻る（緩む向き）。#2392 の後、端末の記録は echo を書かない
- (d) 移行の直後と、同じ ID の worktree を作り直した直後に、往復の数は 0 から数え直す（1 回だけ緩む）
- (e) 人が返事と同じ本文を打ち直した行は、echo と区別できない（旧 (c)）

**未確認**:
1. `prompt_response`・`prompt` の user 行を書く書き手があるか（`src` の grep では見つからなかった）
2. （確かめた）`role: 'user'` の行を書くのは `sendUserMessage`（`src/lib/session/send-user-message.ts:825-834`。送信・relay の配送）と `recordUserTurn`（`src/lib/history/user-turn-recorder.ts:253-255`。端末の直の入力の記録）の 2 つだけ（`grep "role: 'user'"`、2026-11-19）。hook の history の書き手は assistant の行。R4 の結合の試験はこの 2 つの書き手で足りる
3. （確かめた）`chat_messages` へ直に INSERT するのは、`src` では `createMessage` だけ。`tests`（試験の fixture）と `scripts`（履歴の掃除の試験）には直の INSERT がある。R2 の静的な試験は `src` に限る。状態を見る試験は、行を `createMessage` で書く helper を使う
