# 往復の数と連鎖の親を DB に持つ（Issue #4420 の数え方の設計し直し）

- 段: 設計（この文書だけ）。コード・DB・試験は書かない。実装は、設計レビューの処分の後に、開発リーダー（claude-3）のレーンで行う（`fix/4420-relay-reply-not-parent`、PR は 1 本）
- 版: 第 2.1 版（2026-11-19、イネーブラー claude-5）
  - 第 2.1 版: 第 2 版の確かめ（`review-4420-redesign-a.md` の「## 第 2 版」、一部 2・新しい穴 N1〜N5）の処分。§11.3
  - 第 2 版: 設計レビュー 2 本の処分。処分の表は §11
    - A: 暴走の上限の安全性、`workspace/orchestration/runs/2026-11-19/s8/review-4420-redesign-a.md`、P1 0・P2 2・P3 6
    - B: 整合・配送、`review-4420-redesign-b.md`、P1 0・P2 2・P3 5
  - 第 2 版: PM の依頼（`pm-req-4420-redesign-v2.md`）の決定を反映した。relay に bound した送信は数を戻さない。素の send は既知の制限とし、#4492 に足す
  - 第 1 版: `a74163275`（PM の決定 Q1〜Q5 は `04580f70e`）
- 基準:
  - develop `b8f6e33b8`（v0.53.0）
  - #4420 のブランチ `fix/4420-relay-reply-not-parent` の `99811ebb1`（読むだけ）
  - 行番号はこの版のもの。「事実」は file:line、「見立て」「未確認」は明記する
- 正:
  - Issue #4420
  - 今の設計 `../commandmate-issue-4420/docs/design/relay-reply-not-parent-4420.md`（以下「旧設計」。不変条件 I1〜I10、PM の決定 §8）
- 材料:
  - `s8/` の `lead-stop-4420-window.md`・`lead-stop-4420-redesign.md`・`pm-reply-4420-*.md`
  - `s8/` の旧レビュー `review-4420-design.md`・`review-4420-codex.md`・`review-4420-opus.md`・`review-4420-codex-r2.md`・`review-4420-opus-r2.md`
- 筆者の関わり: 筆者は #4420 の実装・旧設計・旧レビューに関わっていない

---

## 0. 結論（先に）

- **往復の数と連鎖の親を、依頼元セッション（worktree＋instance）ごとの 1 行の状態として DB に持つ**
  - 新しい表は `relay_session_rounds`（v73）
  - 状態は、chat の user 行を書く唯一の入口 `createMessage`（`src/lib/db/chat-db.ts:183-226`）で、行の挿入と同じトランザクションの中で進める
- relay を開くときは、その 1 行を同期で読むだけにする。履歴は読み直さない（窓・同じ時刻の並べ替え・読み切りの上限が無くなる）
- **第 2 版の要点: 「書かれた順」に頼らない**（レビュー A P2-1）
  - 書かれる順は出来事の順と違いうる
    - 返事の行は打鍵の後に書かれる
    - 端末の記録は、本体より先に書くことも、取りこぼしを後で書くこともある
  - そこで、状態の遷移は次の 2 つで決める:
    1. **数える**: 返事の行。relay の台帳の印で、1 relay につき 1 回だけ（冪等）
    2. **0 に戻す**: 人の普通の行のうち、行の時刻が「最後に数えた返事の時刻」より新しく、echo でないものだけ。echo は、**この instance へ今打っている本文**（返事・bound の依頼・知らせ・素の送信のすべて。打鍵の前に記録する）か、直近の relay 行で決める
  - 残る「順への依存」は §3.4 に列挙した。第 2.1 版で、どれも厳しい向き（早めに断る側）にしか外れない形にした（O4 を直した）
- relay に bound した送信（`--reply-to`・`ask --async`）で届く依頼の行は、数を戻さない（PM の決定。A↔B の相互の依頼も 10 で止まる）
- 会話の archive（kill-session）は、同じトランザクションで状態を戻す（今の動きを変えない、E4）
- 公開の契約は変えない（code・文面の型・exit）

---

## 1. なぜ履歴の読み直しをやめるのか（3 回の同じ種類）

| 回 | 指摘 | 形 |
|---|---|---|
| 1 | 設計レビュー codex P2-1 | 返事と echo が、本当の親を 5 ターンの窓から押し出す |
| 2 | 実装レビュー（fc01e3bd0） | 窓の最後の未照合の echo／知らせが窓を食う／ちょうど 45 件の履歴を上限扱い／同じ時刻の型の並び |
| 3 | 再レビュー（99811ebb1）codex P2×3 | 501 行目が拒否を解除／同じ時刻で型を優先して返事を捨てる／普通の行だけの長い履歴を読み切れないとして断る |

- 共通の原因（読み）: 「出来事の列」を、後から時刻の並べ替えと有限の窓で復元しようとしている
- 第 1 版はこれを「書かれた順で前へ進める」に替えた。しかし書かれた順も出来事の順ではない（レビュー A P2-1）
- 第 2 版は、**数える根拠を台帳の印（relay ごとに 1 回）**、**0 に戻す根拠を 1 つの時刻どうしの比較**にして、列の復元をどこにも残さない

---

## 2. 不変条件

### 2.1 外側の決まり（変えない。PM の決定）

| # | 決まり |
|---|---|
| E1 | 返事の行は連鎖の親に数えない（Issue の事象を直す） |
| E2 | 本物の連鎖は今までどおり `RELAY_CHAIN_BLOCKED`、深さの上限は `RELAY_HOPS_EXCEEDED` |
| E3 | 返事 → 次の依頼の往復は、人の普通の行を挟まずに `MAX_RELAY_ROUNDS = 10` 回で `RELAY_HOPS_EXCEEDED`。`--allow-relay-chain` では外れない。依頼元セッション単位 |
| E4 | 公開の契約（code・exit・API・CLI）と、利用者に見える今の動き（kill-session で数え直す等）を変えない |

### 2.2 この設計の不変条件

| # | 不変条件 |
|---|---|
| R1 | 状態は、chat の user 行の挿入と同じトランザクションで進む。行があって状態が進んでいない（逆も）ことは無い |
| R2 | user 行を書く入口は `createMessage` の 1 つだけ。user 行の分類（`role`・`message_type`・`worktree_id`・`instance_id`、`request_id` の `relay:`）を後から変える UPDATE も無い。`createMessage` に状態を飛ばす引数を持たせない（§8 の静的な試験で固定） |
| R3 | relay を開くときの判定は、状態の 1 行の同期の読みだけで決まる。履歴を読まない |
| R4 | 状態の遷移は §3.2 の表の 1 つだけ。どの書き手も同じ表を通る |
| R5 | 行が無い状態は「0・親なし」と同じ意味 |
| R6 | 判定できないときの向き: 親の relay が消えていれば hops は null（連鎖でない）。往復の数は DB の値をそのまま使う（消えた relay の返事も数えたまま。PM の決定 Q3） |
| **R7** | **1 つの relay の返事は、1 回だけ数える**（台帳の印で冪等。レビュー A P3-3） |
| **R8** | **0 に戻すのは、行の時刻が `last_counted_at`（最後に数えた返事の行の時刻）より新しい、echo でない人の普通の行だけ**。同じ時刻・古い時刻の行は戻さない（厳しい向き。レビュー A P2-1） |
| **R9** | **echo は打鍵の前の記録で決める**: この (worktree, instance) へ**今打っている本文**（`sendUserMessage` が打鍵の前に記録する。返事・bound の依頼・知らせ・素の送信のすべて）、`uncertain` で保留中の relay の本文、または直近の relay 行と、`normalizeUserTurnContent` で一致する行（レビュー A P2-1、第 2 版の確かめ N1・N2・N3） |
| **R10** | **relay に bound した送信で届く依頼の行は、状態を変えない**（PM の決定。レビュー A P2-2） |
| **R11** | 状態の行を消す・戻す操作は、対応する履歴の操作（archive・instance の削除）と同じトランザクションで行う（レビュー B P2-1、A P3-5） |

---

## 3. 状態と、その進み方

### 3.1 表（v73）

```sql
CREATE TABLE relay_session_rounds (
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,              -- chat_messages.instance_id と同じ、解決済みの id
  rounds INTEGER NOT NULL DEFAULT 0 CHECK (rounds >= 0),
  last_counted_at INTEGER,                -- 最後に数えた返事の行の timestamp（R8）
  last_counted_relay_id TEXT,             -- 記録・ログ用
  parent_relay_id TEXT,                   -- 連鎖の親（自分が to の relay）。NULL = 親なし
  last_relay_message_id TEXT,             -- 直近の relay 行（echo の照合の 2 つ目、R9）
  last_reset_message_id TEXT,             -- 直近に 0 へ戻した行（記録・ログ用）
  inflight_body_hash TEXT,                -- 今打っている本文の hash（normalizeUserTurnContent の後の SHA-256。R9）
  inflight_set_at INTEGER,                -- その記録の時刻
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (worktree_id, instance_id)
);
ALTER TABLE session_relays ADD COLUMN rounds_counted_at INTEGER;  -- R7 の印（NULL = まだ数えていない）
```

- `worktree_id` の列があるので、worktree の削除・ID の改名は、子の表の見つけ方（`src/lib/db/migrations/worktree-child-tables.ts`）が自動で扱う（§6）
- `session_relays` への列の追加は ALTER の追加だけ。既存の行は NULL（まだ数えていない）。移行の前に配送済みの返事が後から重複して書かれても、数えるのは 1 回

### 3.2 遷移の表（`createMessage` の中。user 行のときだけ）

書く行は、行の値と台帳だけで分類する。状態の前の値に依存する判定（R8 の時刻の比較など）は、§3.3 の 1 つの SQL 文の中で行う。

| # | 書く行の種類（判定） | rounds | last_counted_at | parent | last_relay_message_id |
|---|---|---|---|---|---|
| T1 | **返事**: `message_type='relay'`、`request_id=relay:<id>`、relay が在り、その `from` がこの行の (worktree, instance) と文字どおり同じ。**かつ** 台帳の `rounds_counted_at` が NULL（同じトランザクションで印を書けた） | **+1** | max(今, 行の timestamp) | 変えない（E1・旧 I2） | この行 |
| T1' | 返事だが、台帳の印が既にある（同じ relay の 2 本目の行。再試行など） | 変えない（R7） | 変えない | 変えない | この行 |
| T2 | **relay が無い** `request_id=relay:<id>` の relay 行（claim の後・行の書き込みの前に、worktree の削除の CASCADE で relay が消えた等） | **+1**（本番の `request_id` 付きの relay 行は返事だけ。R6 と同じ厳しい向き。レビュー A P3-1） | max(今, 行の timestamp) | 変えない | この行 |
| T3 | **自分が `to` の relay の行**（本番の書き手は無い、旧設計 D1。試験の形） | 0 | NULL | その relay | この行 |
| T4 | relay は在るが、端がどちらとも一致しない relay 行（今は起きない。将来の別名の解決） | 変えない | 変えない | **変えない**（生きた relay を親にしない。レビュー A P3-1） | この行 |
| T5 | **知らせ**: `message_type='relay'`、`request_id` なし（`prompt`・`expired`） | 変えない | 変えない | NULL（旧 I4） | この行 |
| T6 | **relay に bound した送信で届く依頼の行**: send の route が `body.relayId`（bound の relay）を持つ送信で書く `normal` の行。`createMessage` に `relayRequest: true` を渡す（行の分類の欄は変えない。R2 の「状態を飛ばす引数」ではなく、遷移を選ぶ入力） | 変えない（R10） | 変えない | 変えない | 変えない |
| T7 | **echo**（R9）: `message_type='normal'` で、次のどれか:<br>(a) 本文の hash が `inflight_body_hash`（この instance へ今打っている本文）と一致する<br>(a') 同じ (worktree, instance) を `from` とする relay のうち、`uncertain` で保留中の payload の本文と一致する<br>(b) `last_relay_message_id` の行と一致し、その行の時刻以後 | 変えない | 変えない | 変えない | 変えない |
| T8 | **人の普通の行**: `message_type='normal'` で、T6・T7 でない。**かつ 行の timestamp > last_counted_at**（または `last_counted_at` が NULL） | **0** | NULL | NULL | 変えない |
| T8' | 人の普通の行だが、行の timestamp ≦ last_counted_at（遅れて書かれた行。取りこぼしの後書きなど） | 変えない（R8） | 変えない | 変えない | 変えない |
| T9 | そのほかの user 行（`prompt`・`prompt_response` など。今は書き手が無い、レビュー B P3-3） | 変えない（PM の決定 Q1。将来の防御） | 変えない | 変えない | 変えない |

- T1 の「同じ」の判定は `isSameEndpoint`（worktree と instance の id が文字どおり同じ）
- T7 (a) の「今打っている本文」の記録（第 2 版の確かめ N1・N2。第 2 版は台帳の返事の payload だけだった）:
  - `sendUserMessage` は、打鍵の**前**に、この (worktree, instance) の状態の行の `inflight_body_hash`・`inflight_set_at` を書く（小さな UPSERT）
  - 対象は、この関数で打つ本文のすべて: relay の返事・知らせ（`relay-delivery.ts:626-634`）、bound の依頼と素の送信（send の route）
  - 同じ instance への打鍵は入力の錠（#3945）で 1 本ずつなので、記録は 1 つで足りる（見立て。実装で確かめる）
  - 記録を外すのは、route の行（T1・T1'・T5・T6 など）を書く `createMessage` の同じトランザクションの中。外す時点と行の書き込みの間に隙間が無い。送れなかった（`not_sent`）ときも外す
  - 結果の分からない送信は、次の打鍵の記録で上書きされるまで残す（同じ本文の後の行を echo とみなす。厳しい向き）
  - エージェントが本文を受け取るのは打鍵の後なので、端末の記録がその本文を書く時点では、必ず記録がある（因果の順。§3.4 O3）
  - route の行が書かれた後は、端末の記録は #2392 と未キーの行の claim（`src/lib/history/user-turn-recorder.ts:340-372`）で同じ本文の行を書かない。その後の echo は T7 (b) と未キーの行の claim が受け持つ
- T7 (a') の台帳の照合（第 2 版の確かめ N3）: `uncertain` で保留中（hold）の relay の payload（`pending_body`、v60・v63 の列。列名と状態の名前は実装で確かめる）
- T7 (b) は、#2387 の `isEchoOfRelayRow`（`relay-service.ts:114-119`。時刻の向きの試験を含む）をそのまま使う。行が読めない（再送で消えた。レビュー B P3-2）ときは (b) は不一致で、(a) だけで決める
- T8 の時刻:
  - 行の `timestamp` は出来事の時刻（送信は打ち始めの時刻、端末の記録は transcript の時刻）
  - `last_counted_at` は数えた返事の行の `timestamp`

### 3.3 書き方（同時の更新。レビュー A P3-2）

`createMessage` の中で、次の順に行う（1 つのトランザクション）:
1. **最初に `INSERT INTO chat_messages`**。書き込みの文から始めるので、トランザクションは最初から書き込みの錠を持つ。読みから始めて後で書く形（WAL の BUSY_SNAPSHOT）にしない
2. 行の分類（§3.2 の T1〜T9）に要る読み（relay・`inflight_body_hash`・保留中の payload）と、T1 の印（`UPDATE session_relays SET rounds_counted_at=? WHERE id=? AND rounds_counted_at IS NULL`、変わった行の数で T1／T1' を決める）
3. 状態は **1 つの SQL の UPSERT** で進める（`INSERT … ON CONFLICT(worktree_id, instance_id) DO UPDATE SET rounds = CASE … END, …`）
   - R8 の時刻の比較（`excluded` の行の時刻 > `last_counted_at`）も、この文の CASE の中で行う
   - 前の状態を JS で読んで次を計算する形にしない
- `createMessage` が既に外のトランザクションの中で呼ばれる場合は、better-sqlite3 の入れ子（savepoint）になる。上の 1〜3 の順は同じ

### 3.4 残る「順への依存」の列挙（PM の依頼の求め）

| # | どこで順に頼るか | 外れたときの向き | 扱い |
|---|---|---|---|
| O1 | R8: 人の行の時刻と `last_counted_at` の比較。時刻が出来事の順を表すこと（送信は打ち始めの時刻、transcript は記録の時刻） | transcript の時刻が秒に丸められる等で人の行が古く見えると、戻らない（**厳しい向き**: 早めに断る。人がもう 1 行打てば戻る） | 既知の制限 (f) |
| O2 | R8: 返事 r_k と r_{k+1} の間に人が打った行が、r_{k+1} を数えた後に遅れて書かれる | 戻らない（**厳しい向き**） | 既知の制限 (f) |
| O3 | T7 (a): 今打っている本文の記録は、打鍵より前に書かれる | 因果の順（記録 → 打鍵 → エージェントの受け取り → 端末の記録）で、書き込みの順の前提ではない。`sendUserMessage` を通らずに打つ経路は無い（見立て。打つ経路は `sendUserMessage` の 1 つ。返事・知らせ・bound の依頼・素の送信） | 試験で固定（§8）。打つ経路が 1 つであることを静的な試験で固定（§8） |
| O4 | 配送が `uncertain`（結果が分からない）で終わり、返事の行が書かれない | 第 2.1 版で**厳しい向き**に直した（第 2 版の確かめ N3）:<br>- `uncertain` に移す（`holdRelayPayloadDelivery`）同じトランザクションで、その relay を数えて印を付ける（+1。届いた前提）<br>- その本文は、`inflight_body_hash` と保留中の payload（T7 (a')）で echo とみなす<br>- 後で返事の行が書かれても T1'（2 回目は数えない）<br>`not_sent`（確かに打っていない）は数えず、記録を外す（エージェントは受け取っていないので echo も出ない） | 人が「届いていない」と解決したときも、数えたままにする（厳しい向き。PM の決定待ちの推奨、§9.1） |
| O5 | 親（T3・T5）: 知らせと `to` 側の行の順 | 本番には `to` 側の行が無い（旧設計 D1）ので、親は常に null。試験の形だけ | 記録だけ |
| O6 | 端末（tmux attach）から直に打った人の行は、ターンの終わりまで書かれない（`src/lib/hooks/sources/claude/history.ts:847-866`） | 10 で断られた後に人が端末で「続けて」と打ち、エージェントが同じターンの中で relay を開くと、まだ 10 のままで断られる（**厳しい向き**）。画面・`send` の行は打鍵の直後に書かれるので起きない。旧設計も同じ（履歴にまだ無い）で、退行ではない（第 2 版の確かめ N5） | 既知の制限 (j)。cli-operations-guide の「人が 1 行打てば数え直す」に「端末から直に打った行は、そのターンが終わってから効く」を足す |

- 残るのは、1 つの時刻の比較（O1・O2）、因果の順（O3）、端末の行の書かれる時点（O6）だけ。列の復元（窓・並べ替え）は無い
- 第 2.1 版で、**緩む向きに外れる依存は無くなった**（O4 を厳しい向きに直し、因果の保護を、打っている本文のすべてに広げた）。どれも外れれば早めに断る側で、人の 1 行（O6 は画面か `send`）で戻る

### 3.5 開くときの読み（`openRelay`、同期）

```
row = SELECT rounds, parent_relay_id FROM relay_session_rounds WHERE worktree_id = :from.wt AND instance_id = :from.inst
rounds = row?.rounds ?? 0
parentHops = row?.parent_relay_id ? (getRelayById(parent)?.hops ?? null) : null   -- 消えていれば null（R6）
decideRelayCreation({ …, parentHops, replyRounds: rounds })                       -- 純関数。判定の順は旧設計 §3.2 のまま
```

- `findParentRelayHops`・`scanRelayLineage`・`countConsecutiveReplyRounds`・`MAX_RELAY_LINEAGE_ROWS`（99811ebb1）は消す。代わりに `readRelaySessionRounds(db, from)` を置く（同期、1 行の SELECT）
- #4466 の設計（S2 の中の同期の読み）とそのまま合う（`send-atomic-4466.md` I8 は読み替え済み）
- 文面:
  - 往復の上限の文面（旧設計 §3.2 の 1 つ目）は変えない
  - 「読み切れなかった」の文面は消す
- 拒否のときのログに、状態の行（rounds・last_counted_at・last_counted_relay_id・last_reset_message_id）を添える（レビュー A P3-6）

### 3.6 遷移のログ（レビュー A P3-6）

- 状態が変わるたびに、構造化ログ `relay-rounds-transition` を 1 行出す。中身:
  - 前 → 後（rounds・parent）
  - 遷移の番号（T1〜T9）
  - 行の id・relay の id
  - 判定の理由（例 `echo:ledger`・`echo:row`・`late-normal`）
- 状態は履歴から作り直せないので、規則の誤りはこのログで追う
- ログはトランザクションの後に出す（戻ったときに残さない）

---

## 4. 同時・期限・cancelled・消えた relay・履歴の操作

| 場面 | 扱い |
|---|---|
| 同時の更新 | §3.3（書き込みから始め、状態は 1 つの UPSERT）。同じプロセスは better-sqlite3 の同期で直列。別の接続は SQLite の書き込みの錠で直列 |
| 同時の open（扇の広がり） | rounds = 9 で並べて N 本開くと全部通り、返事で 9＋N になる（旧設計と同じ）。E3 は順の往復の上限で、扇は止めない。既知の制限 (g)。#4466 の S2 でも、開く判定は数を変えないので同じ |
| 期限切れ | 返事の行は書かれない。届くのは知らせ（T5）。数は変えず、親を外す |
| cancelled | 依頼元に行は書かれない。何も変わらない |
| 数えた後に relay が消える | 数えたまま（R6、PM の決定 Q3） |
| 行の書き込みの前に relay が消える | T2（+1、厳しい向き） |
| 親の relay が消える | 開くときに hops は null（旧 I4 と同じ） |
| 返事の行の挿入が失敗する | トランザクションごと戻る。数も印も進まない（R1） |
| 再送で前の行が消される（orphan の削除、`send-user-message.ts:626-640`・`:863-866`。レビュー B P3-2） | 数と印はそのまま（R7 で 2 本目は数えない）。`last_relay_message_id` が消えた行を指すと、T7 (b) は不一致になる。T7 (a) と R8 の時刻の比較で決まる |
| **会話の archive（kill-session。レビュー B P2-1）** | 今の動き（99811ebb1 は archive 済みを読まないので、数と親が 0・なしに戻る）を保つ。`deleteMessagesByInstance`・`deleteMessagesByCliTool`・`deleteAllMessages`（`chat-db.ts:598-612`）の中で、archive と同じトランザクションで状態の行を消す（R11）:<br>- `ByInstance`: その (worktree, instance)<br>- `ByCliTool`: `DELETE FROM relay_session_rounds WHERE worktree_id=? AND instance_id IN (SELECT DISTINCT instance_id FROM chat_messages WHERE worktree_id=? AND cli_tool_id=?)`（archive の前に引く）<br>- `deleteAllMessages`: その worktree の全部 |
| **instance の削除（`removeAgentInstance`、`agent-instances-db.ts:414`。レビュー A P3-5）** | 同じトランザクションで、その (worktree, instance) の状態の行を消す（R11）。同じ id の再追加は 0 から |
| **エージェントのプロセスの作り直し**（tmux が消えた・`/exit`・再起動・codex の同じ pane への relaunch。第 2 版の確かめ N4） | `beginAgentSession` → `archiveSupersededSessionMessages`（`src/lib/session/session-generation-archive.ts:1-28`・`:123`）が `deleteMessagesByInstance` を呼ぶ。R11 によって、同じトランザクションで状態の行も消え、**0 に戻る**。今の動き（99811ebb1 は archive 済みの履歴を読まないので 0 に戻る）と同じで、E4 に合う。人以外の 0 戻しの経路として既知の制限 (h) に書く（PM の決定、§9.1） |
| `/clear` など、履歴を archive しない操作 | 状態は残る（厳しい向き） |

---

## 5. 初期値と migration v73（PM の決定 Q2: 案 A。レビュー B P2-2）

- **初期値**: 表を作るだけ。行は無い（＝ 0・親なし、R5）。`session_relays.rounds_counted_at` は NULL
  - 親は本番では今も常に null（旧設計 D1）なので、変わらない
  - 往復の数は、移行の直後に各セッションが 0 から数え直す。1 回だけ緩む（既知の制限 (d)）
- **やること（慣例どおり。v72 の形）**:
  1. 新規 `src/lib/db/migrations/v73-relay-session-rounds.ts`
     - `export const v73_migrations: Migration[]`、`up`・`down`
     - `up`: §3.1 の `CREATE TABLE` と `ALTER TABLE session_relays ADD COLUMN rounds_counted_at`
     - `down`: `DROP TABLE relay_session_rounds`。`session_relays` の列の扱いは、SQLite の版が `DROP COLUMN` を持つかで決める。持たなければ列を残し、意味の無い列として注記する（v62 の down の作りを参考にする）
     - 先頭の注釈（v72 と同じ形）: 子の表の見つけ方に拾われること、down で数を忘れること、`rounds_counted_at` の意味
  2. `src/lib/db/migrations/index.ts` に import と `...v73_migrations` を足す（v72 は 61・121 行）
  3. `CURRENT_SCHEMA_VERSION` を 73 にする。`tests/unit/lib/db-migrations.test.ts:40` の `toBe(72)` も 73 に
  4. 専用の試験 `tests/unit/db/migration-v73-relay-session-rounds-4420.test.ts` を新設する（v72 の試験の形）
- 番号の v73 は PM の割り当て（`pm-reply-4420-redesign.md` の 2）

---

## 6. worktree の削除・改名（#4490）との関係（PM の決定 Q5）

- 今の削除（`deleteWorktreeChildRows`）は、`worktree_id` の列を持つ表を全部消す。`relay_session_rounds` も `chat_messages` も消えるので、状態と履歴は食い違わない
- `REFERENCES worktrees(id) ON DELETE CASCADE` を持つので、v52 型の孤児の掃除と `renameWorktreeIdPreservingChildren` の両方に拾われる
  - 改名で移し先に同じ instance の行があると、`UPDATE OR IGNORE` で移し元の行が落ちる（`worktree-id-rename.ts:150-153`）。数が 0 へ緩む向きで、改名の衝突のときだけ（レビュー B P2-2 の補足。既知の制限 (i)）
- #4490 の方針（子の表を「所有＝状態」と「履歴」に分け、スキーマの宣言か登録表で決める）では、この表は**状態**（所有。worktree と一緒に消す側）。#4490 への渡し:
  - #4490 が登録表を入れたら、`relay_session_rounds` を「所有」側に載せる
  - #4420 の PR は表を作るだけ。順序は #4420 が先でも後でもよい（今は `worktree_id` の列の規約で、自動で所有側）
  - `chat_messages` が「履歴」（残す側）に分かれた場合、同じ ID の worktree を作り直すと、状態は 0 から・履歴は残る（既知の制限 (d) と同じ向き）
  - 試験: 同じ worktree id の再作成で `relay_session_rounds` が消え、`chat_messages` が残る場合の数（§8 の migration の行）

---

## 7. 旧設計の不変条件 I1〜I10 の対応表

| 旧 | 中身 | この設計での扱い |
|---|---|---|
| I1 | 返事の行は親に数えない | 残る（T1・T2 は親を変えない） |
| I2 | 返事は本当の親を隠さない | 残る（T1 の後も親はそのまま。T3 で親） |
| I3 | 人の行で連鎖が切れる（#2377）・echo の判定（#2387）は変えない | 残る（T8。echo は #2387 の関数を T7 (b) で使い、台帳の照合（T7 (a)）を足す） |
| I4 | 判定できないときの向き | 残る（R6。T4 は親を変えない向きに直した） |
| I5 | hops の上限・期限・旗の意味は変えない | 残る |
| I6 | 往復の上限 | 残る。変えるのは 3 つ: migration を足す（PM の決定）、消えた relay の返事も数えたまま（Q3）、1 relay 1 回（R7） |
| I7 | 返事と echo が親を窓から押し出さない・同じ時刻の並び | 消える（窓も並べ替えも無い） |
| I8 | echo の帰属は 1 通り | 置き換わる（R9: 台帳の配送中の本文＋直近の relay 行） |
| I9 | 上限の陰性対照の手順の分け方・実ルートで新しい行がゼロ | 残る（§8） |
| I10 | 窓の端 | 消える |
| — | 新しい: R1〜R11 | §2.2 |

---

## 8. 試験の層と陰性対照

| 層 | 試験 | 陰性対照（変異で赤） |
|---|---|---|
| 単体（純粋） | §3.2 の T1〜T9 を、行の種類 × 前の状態の全組で確かめる。`nextRelaySessionState` を純粋な関数にし、UPSERT の CASE と同じ表を共有する | 返事で親を変える（I1/I2）。返事で 0 にする。知らせで 0 にする・親を残す（I4）。T4 で親を生きた relay にする（A P3-1）。T9 で 0 にする（Q1） |
| 単体（store） | 行の挿入と状態の UPSERT と台帳の印が、同じトランザクションにある。UPSERT で例外を注入すると、行も印も残らない（R1） | 状態の更新をトランザクションの外へ出す変異 |
| 単体（store、2 接続） | 同じ DB の 2 つの接続で、交互に返事の行と人の行を書く。BUSY_SNAPSHOT で落ちない（§3.3） | 前の状態を SELECT してから書く形に戻す変異で、2 接続の行が赤（A P3-2） |
| 単体（静的、R2） | `src` の中で、`chat_messages` への書き込み（`INSERT`・`INSERT OR IGNORE`・`INSERT OR REPLACE`・`REPLACE INTO`、改行を挟む形を含む）が `createMessage` の 1 か所だけ。user 行の `role`・`message_type`・`worktree_id`・`instance_id` を変える UPDATE と、`request_id` に `relay:` を入れる UPDATE が無い。`createMessage` に状態を飛ばす引数が無い（A P3-4） | 別の書き込みの経路を足す変異。状態を条件付きにする変異 |
| 単体（静的、O3） | tmux へ本文を打つ経路（`sendKeys` などの送信の関数の呼び手）が、`sendUserMessage` の中の 1 か所だけ（打鍵の前の記録を通らない打鍵が無い） | 記録を通らない打鍵の経路を足す変異で赤 |
| 結合（書き手ごと、R4） | 本物の書き手で行を書く: 送信（`sendUserMessage`、偽の tmux）・bound の送信・relay の配送（`deliverOne`、返事・prompt・expired）・端末の直の入力の記録（`recordUserTurn`）。状態が §3.2 のとおり進む | 1 つの書き手だけ別の関数で進める変異 |
| **結合（順のずれ、A P2-1・第 2 版の確かめ N1・N2・N3）** | (1) 打鍵の前の記録の後、route の行より**先に**端末の記録が同じ本文の `normal` 行を書く → 0 に戻らない（T7 (a)）。**返事・bound の依頼・知らせ・素の送信の 4 種類のそれぞれで**確かめる<br>(1') `uncertain` で保留した返事: 保留の時点で +1、その本文の端末の記録は 0 に戻さない、後で書かれた返事の行は数えない<br>(2) 返事 3 本の後に、それより古い時刻の人の行を backfill する → 0 に戻らない（T8'）<br>(3) 返事の後に、それより新しい時刻の人の行 → 0（T8） | (1) は記録の照合を外す変異で赤。照合の対象を返事だけに戻す変異で、bound の依頼と知らせの行が赤（N1・N2）。(1') は保留のときに数えない変異で赤（N3）。(2) は時刻の比較を外す変異で赤 |
| **結合（冪等、A P3-3）** | 同じ relay の返事の行を 2 本書く（再試行の形）→ +1 だけ | 印を外す変異で +2 になり赤 |
| **結合（相互の依頼、A P2-2）** | A↔B が bound の送信（`--reply-to`）で相互に依頼し、人を挟まずに 11 往復 → どちらかが `RELAY_HOPS_EXCEEDED`（T6）。素の `send`（bound なし）で届く行は 0 に戻す（既知の制限 (a) を固定する向き） | T6 を外す変異で、11 往復が通り赤 |
| 結合（判定） | `openRelay` の判定:<br>- 返事 9 本の後は通る。10 本で `RELAY_HOPS_EXCEEDED`（旗あり・なし）<br>- 人の普通の行の後は 0<br>- 相手を交互にしても数え続ける<br>- 知らせを挟んでも数は変わらない<br>- 親（`to` 側の行）の後の返事でも、親は残る | `openRelay` で履歴を読む変異（旧関数を戻す）は、下の回帰の行で赤 |
| 結合（3 回の穴の回帰） | (1) 普通の行だけの 501 行の後 → 0・通る<br>(2) 同じ ms に普通の行 → 返事 1 の順で書き、その後に返事 9 本 → 10 で断る（同じ時刻は戻さない、R8）<br>(3) 知らせ 500 本の後の普通の行 → 0<br>(4) 知らせだけ 45 本 → 0・通る | 時刻の並べ替えを持ち込む変異で (2) が赤 |
| **結合（履歴の操作、B P2-1・A P3-5）** | kill-session の 3 つの形（instance・tool・全部）の後に、その状態が 0・親なし。instance の削除の後も同じ。別の instance の状態は残る | archive と同じトランザクションの削除を外す変異で赤 |
| 結合（実ルート、旧 I9） | `POST /api/relays` の拒否で、relay の新規行・chat の新規行がゼロ。深さの陰性対照は手順を分ける | — |
| **公開の契約の回帰（B P3-4）** | `RELAY_HOPS_EXCEEDED` の code・HTTP の 409・往復の上限の文面が、99811ebb1 の往復の文面と同じ | 文面を変える変異 |
| migration | v73 で表と列ができ、既存の行は変わらない。down で表が消える。`CURRENT_SCHEMA_VERSION` が 73。worktree の削除で状態の行が消え、改名で付け替わる。同じ worktree id の再作成（#4490 の形）で状態が 0 から | 表から `worktree_id` の列名を変える変異で、子の表の見つけ方に拾われず赤 |

- 既存の `the loop guard`・#2387・クローズ後の再作成の試験は、行を `createMessage` で書く形にそろえ、期待は変えずに緑にする
- 99811ebb1 の I7・I10 の試験（窓・同じ時刻の並べ替え）は、上の回帰の行に置き換える

---

## 9. PM の決定と、実装の積み方

### 9.1 PM の決定（2026-11-19）

| # | 決定 |
|---|---|
| Q1 | 0 に戻す入口は `message_type='normal'` の user 行だけ（T8）。`prompt_response` などでは戻さない。今は書き手が無く（レビュー B P3-3）、将来の防御 |
| Q2 | 初期値は案 A（§5） |
| Q3 | 消えた relay の返事も数えたまま（R6） |
| Q4 | 99811ebb1 の扱いは開発リーダーが決める（§9.2 に材料） |
| Q5 | #4490 に「`relay_session_rounds` は状態」を渡す（§6） |
| （第 2 版の依頼） | relay に bound した送信（`--reply-to`・`ask --async`）で届く依頼の行は、数を戻さない（T6、R10）。素の `send`（relay なし）で届く行は人の行と見分けられないので、既知の制限 (a) として残し、#4492 に足す。公開の契約は変えない |
| （第 2 版の依頼） | 会話の archive は、同じトランザクションで状態を戻す（今の動きを変えない） |
| （第 2.1 版の依頼） | エージェントのプロセスの作り直しでも 0 に戻る（R11 を `deleteMessagesByInstance` の中に置く。今の動きと同じ）。既知の制限 (h) に書く |
| （第 2.1 版の推奨。PM の決定待ち） | `uncertain` で保留した返事を、人が後で「届いていない」と解決しても、数えたままにする（厳しい向き） |

### 9.2 実装の積み方の材料（レビュー B P3-5。決めるのはリーダー）

- 同じブランチ（99811ebb1 の上）に積む場合に消すもの:
  - `scanRelayLineage`・`findParentRelayHops`・`countConsecutiveReplyRounds`・`MAX_RELAY_LINEAGE_ROWS`
  - 窓の試験
  - 旧設計の I7・I10 の記述（旧設計の文書の I7・I10 に「`relay-rounds-db-4420.md` で置き換え」の注記を足す）
- 残すもの: `decideRelayCreation` の入力 `replyRounds` と、往復の文面
- 直すもの: `relay-policy.ts:192` のコメント（`countConsecutiveReplyRounds` を指している）
- 完了の条件: `grep -E 'scanRelayLineage|countConsecutiveReplyRounds|MAX_RELAY_LINEAGE_ROWS'` が 0 件
- docs:
  - `docs/user-guide/cli-operations-guide.md:1120` の文（ja・en）と、CHANGELOG の既知の制限に、(d) と (a)（bound の扱い）を足す
  - module-reference の relay の行は、追記でなく既存の行の更新にする（断片で渡す）
- 推奨（読み）: 同じブランチに積む。#4418 が #4420 のマージを待っており、PR の経緯が 1 本に残る

---

## 10. 既知の制限

- (a) **素の `send`**（relay に bound しない）で届く依頼の行は、人の行と見分けられないので 0 に戻る。A↔B が素の `send` で相互に依頼すると、10 では止まらない。bound の送信（`--reply-to`・`ask --async`）は止まる（T6）。続きは #4492
- (b) 依頼に答える途中の B→C は止まらない（旧 (b)、#4492）
- (c) （第 2.1 版で解消）配送が `uncertain` で終わった返事は保留の時点で数え、その本文は echo とみなす（§3.4 O4）。`not_sent` は打っていないので echo も出ない
- (d) 移行の直後と、同じ ID の worktree を作り直した直後に、往復の数は 0 から数え直す（1 回だけ緩む）
- (e) 人が返事と同じ本文を打ち直した行は、echo と区別できない（旧 (c)）
- (f) 人の行の時刻が、最後に数えた返事の時刻以前に見えると、0 に戻らない（§3.4 O1・O2。厳しい向き。人がもう 1 行打てば戻る）
- (g) 数が上限の手前のときに並べて開く relay（扇の広がり）は止めない（旧設計と同じ）
- (h) （第 2 版の記述を事実に直した。第 2 版の確かめ N4）エージェントのプロセスを作り直すたび（tmux が消えた・`/exit`・再起動・relaunch）に、会話の archive と同じく数は 0 に戻る（`session-generation-archive.ts:123`）。今の動きと同じ（E4）。人以外の 0 戻しの経路。`/clear` など履歴を archive しない操作では残る
- (j) 端末（tmux attach）から直に打った人の行は、そのターンが終わってから効く。同じターンの中の relay は、まだ前の数で判定される（§3.4 O6。厳しい向き。画面・`send` の行は直ちに効く）
- (i) worktree の ID の改名で、移し先に同じ instance の状態の行があると、移し元の行が落ちる（0 へ緩む向き。改名の衝突のときだけ）

**未確認**（実装の最初に確かめる）:
1. `session_relays` の保留中（`uncertain`）の payload の列名と状態の名前（`pending_body`・配送の状態。v60・v63）
2. SQLite の版が `ALTER TABLE … DROP COLUMN` を持つか（§5 の down）
3. 外のトランザクションの中から `createMessage` を呼ぶ呼び手があるか（§3.3 の savepoint）
4. 同じ instance への打鍵が入力の錠（#3945）で 1 本ずつであること（`inflight_body_hash` が 1 つで足りるか。足りなければ instance ごとに複数の記録を持つ）

---

## 11. 設計レビューの処分（第 2 版）

- 処分の語: 採用（設計を直した）・却下（理由つき）・未解決（次の手つき）

### 11.1 レビュー A（暴走の上限の安全性）

| 指摘 | 処分 | 反映した節 |
|---|---|---|
| P2-1 書かれた順は出来事の順でない（echo が本体より先・遅れた人の行で 0） | 採用。次のとおり直した:<br>- 数える根拠を台帳の印にした（R7）<br>- 0 に戻す根拠を「最後に数えた返事より新しい人の行」にした（R8）<br>- echo を、台帳の配送中の本文と直近の relay 行で決める（R9）<br>- 遷移の表（T1〜T9）を書いた<br>- 残る順への依存を §3.4 に列挙した（緩む向きは O4 の 1 回まで、ほかは厳しい向き） | §0、§2.2、§3.2、§3.4、§8、§10 (c)(f) |
| P2-2 bound の依頼で相手の数が 0 に戻る（相互の依頼が止まらない） | 採用（PM の決定: bound の送信は変えない T6。素の send は既知の制限 (a)、#4492 へ） | §2.2 R10、§3.2 T6、§8、§9.1、§10 (a) |
| P3-1 決められない relay 行で 0 に戻す・生きた relay を親にする | 採用（relay が無いときは +1、端が一致しないときは何も変えない） | §3.2 T2・T4、§8 |
| P3-2 同時の更新の書き方（BUSY_SNAPSHOT）・同時の open | 採用（書き込みから始め、状態は 1 つの UPSERT。2 接続の試験。扇の広がりは既知の制限 (g)） | §3.3、§4、§8、§10 (g) |
| P3-3 同じ relay の返事の 2 本目で +2 | 採用（台帳の印 `rounds_counted_at` で 1 relay 1 回） | §2.2 R7、§3.1、§3.2 T1'、§8 |
| P3-4 R2 の静的な試験の網が狭い | 採用（INSERT の変種・分類を変える UPDATE・状態を飛ばす引数まで） | §2.2 R2、§8 |
| P3-5 instance の削除・同じ id の再追加で古い数を引き継ぐ | 採用（instance の削除と同じトランザクションで状態を消す。再起動は既知の制限 (h)） | §2.2 R11、§4、§8、§10 (h) |
| P3-6 状態は履歴から作り直せない | 採用（遷移ごとの構造化ログ、拒否のログに状態の行、陰性対照に各場面） | §3.5、§3.6、§8 |

### 11.2 レビュー B（整合・配送）

| 指摘 | 処分 | 反映した節 |
|---|---|---|
| P2-1 kill-session の archive で、今の動きでは数と親が戻る | 採用（(a): archive の 3 つの関数と同じトランザクションで状態の行を消す。`ByCliTool` は chat の行から instance を引く） | §2.1 E4、§2.2 R11、§4、§8 |
| P2-2 migration の慣例 | 採用（ファイル名・`index.ts`・`CURRENT_SCHEMA_VERSION` の試験・専用の試験・注釈。改名の衝突の補足は既知の制限 (i)） | §5、§6、§8、§10 (i) |
| P3-1 #4490 の宣言の方法に載せる作業 | 採用 | §6 |
| P3-2 orphan の削除で状態と履歴がずれる | 採用（§4 に行を足した。echo の照合で行が読めないときは、台帳だけで決める） | §3.2、§4 |
| P3-3 Q1 の根拠は本番では効かない | 採用（「今は書き手が無い。将来の防御」と明記。未確認から外した） | §3.2 T9、§9.1 |
| P3-4 文面の削除と公開の契約の回帰の試験 | 採用 | §8 |
| P3-5 実装の積み方の材料 | 採用（材料を書いた。決めるのはリーダー） | §9.2 |

- 却下 0 件・未解決 0 件

### 11.3 第 2 版の確かめ（`review-4420-redesign-a.md` の「## 第 2 版」）の処分（第 2.1 版）

| 指摘 | 処分 | 反映した節 |
|---|---|---|
| P2-1・P2-2 の残り（一部） | 採用（下の N1・N2 と同じ直しで塞いだ） | §3.2、§3.4 |
| N1（P2）bound の依頼も、端末の記録が先に書くと 0 に戻る | 採用（T7 (a) の照合を、この instance へ今打っている本文のすべてに広げた。`sendUserMessage` が打鍵の前に本文の hash を記録し、route の行を書くトランザクションで外す。4 種類の本文のそれぞれで陰性対照） | §2.2 R9、§3.1、§3.2 T7、§3.4 O3、§8 |
| N2（P3）知らせの echo | 採用（同上。知らせも `sendUserMessage` で打つので同じ記録に入る） | 同上 |
| N3（P3）O4 を厳しい向きに | 採用（`uncertain` に移す同じトランザクションで数えて印を付ける。保留中の本文を echo の照合に足す。人が「届いていない」と解決したときも数えたままにする案は、PM の決定待ち） | §3.2 T7 (a')、§3.4 O4、§8、§9.1、§10 (c) |
| N4（P3）(h) の「再起動では残る」は誤り | 採用（プロセスの作り直しのたびに 0 に戻る、と事実に直した。今の動きと同じ。人以外の 0 戻しの経路として書いた） | §4、§9.1、§10 (h) |
| N5（P3）端末から打った行はターンの終わりまで書かれない | 採用（O6 と既知の制限 (j)、guide に 1 文） | §3.4 O6、§10 (j) |

- 打つ経路が `sendUserMessage` の 1 つであることを、静的な試験で固定した（O3 の前提）
- 第 2.1 版で、緩む向きに外れる順の依存は無くなった（§3.4）
