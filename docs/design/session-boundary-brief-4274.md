# セッションの境界の検出と送信経路への brief の口（Issue #4274、#4224 の前半 D1）

親：Epic #4220（決定 D1・D3・D10・D12 を前提にする）。依存：#4221（A、マージ済み・`docs/design/mem-store-4221.md`）。
並行：B（#4222）・C（#4223）。後半 D2（C の接続・B の受領・フックとの二重の回避・終わり方の表示・実機の受入）は #4224 に残す。

この文書は**設計の段**の成果物で、`src/`・`tests/` はまだ変えていない。実装は、この設計を Codex が事前に
レビューした後の、同じブランチの別の契約で行う。

**書き方の約束**：各段の記述に印を付ける。

- **［事実］** 実コード・fixture・実測の記録で確かめたこと。`file:line` は develop `232dc4783` 時点
- **［見立て］** 事実から組んだ設計判断。レビューで変わりうる
- **［未確認］** 実機で測っていないこと。D2 の実機の受入（#4224）か、事前の採取で確かめる

---

## 0. 冒頭

### 0.1 食い違う点（止める点）

**止める点は無い。** D1〜D13・A の設計と違う作りは要らない。ただし Issue の書き方と実コードが違う所が 3 つあり、
実コードを正として設計した（どれも作りを変えずに吸収できる）。

| # | Issue の書き方 | 実コード［事実］ | この設計での扱い |
|---|---|---|---|
| G1 | 「既存の送信の上限（#2464）」 | サーバに本文の上限は無い。`send-request.ts:79` は `trim()` と空の判定だけ。#2464 が与えたのは **48 KiB・240 行まで到達を確かめた**という文書上の保証（`src/cli/commands/send.ts:57-66`、`--help` は `:817`）で、「強制する上限ではない」と明記されている。到達の確認そのものは送信関数（`submit-verified-sender.ts:746` で 512 バイト超を 1 回の bracketed paste にし、Enter は composer が本文全体を示すまで押さない） | 48 KiB・240 行を **brief を足すときだけ効く上限**として扱う（§6）。利用者の本文だけで超える送信は今までどおり送る（本文を削らない・断らない）。値は CLI と共有の定数へ移す（§8） |
| G2 | 配送の記録 `not_sent` / `unknown` / `sent` を「既存の区別のまま」 | 送信の service の語は `not-sent` / `sent` / `indeterminate`（`send-attempt-types.ts:24`）。`not_sent` / `unknown` / `sent` は relay と route の語（`relay-bind.ts:62`、写像は `route.ts:127-129` の `unboundSendOutcome`：`not-sent`→`not_sent`、それ以外→`unknown`） | 台帳には route と同じ写像で `not_sent` / `unknown` / `sent` を書く（`indeterminate`→`unknown`）。新しい語を作らない |
| G3 | 「既存のセッションの世代（`beginAgentSession`）」 | `beginAgentSession`（`agent-session-lifecycle.ts:76`）の世代はメモリだけ（`agent-event-state` の `generationStartedAt`、#4115 の `sessionGeneration` は `randomUUID` をメモリに置き、再起動で失われる：`role-launch.ts:27-32`）。会話の識別（`session_id`）もメモリの最後の出来事にしか無い（`agent-event-record.ts:24-31`、`transcript-history.ts:182-209`） | 「1 回」を再起動の後まで保つため、境界は**新しい DB の台帳**に持つ（§3）。既存の世代はそのまま（読みも変えもしない） |

### 0.2 B と重なる変更

**B の書いているファイル（`src/lib/mem/**`・`src/lib/db/mem-db.ts`・`src/lib/db/agent-instances-db.ts`）は変えない。**
A の既存の export を読むだけにする。

| 読むもの | 場所［事実］ | 使い方 |
|---|---|---|
| `withMemTarget(db, { via: 'worktree', worktreeId }, deps, build)` | `src/lib/mem/target.ts:116` | 所属（repository・ブランチ・detached）・`mode`・`features` を、送信の時点で決める。失敗（`not_registered` / `ambiguous` / `branch_unresolved` / `not_found`）は「付けない」（§7） |
| `MemTargetResolved.features.injectOnStart` | `src/types/mem.ts:117-121`、既定は全部 `false`（`mem-db.ts:44`） | mode が `derived` / `on` **かつ** `injectOnStart` のときだけ付ける。A がこのスイッチを D 用に既に置いている |
| `getInstanceIncarnation(db, worktreeId, instanceId)` | `src/lib/mem/incarnation.ts:24` | 差し込みのキーに instance の世代を入れる（ID の再利用で前の境界を引き継がない。A の D5 と同じ理由） |

重なりうるが B のファイルではないもの（オーケストレーターが順序を決める）：

- **migration の番号**：D1 は新しい表のため migration を 1 本足す（`src/lib/db/migrations/` と `runner.ts:34` の
  `CURRENT_SCHEMA_VERSION = 66`）。A の設計では B も終了の記録を「B の migration で足す」（`mem-store-4221.md:468`）。
  **両方が v67 を名乗ると衝突する**。後にマージする側が番号を繰り上げる
- `docs/module-reference.md` の行（実装の契約で断片に書く）

---

## 1. 用語

| 語 | 意味 | 持つ場所 |
|---|---|---|
| プロセスの世代 | エージェントのプロセスを CommandMate が作る境界。`beginAgentSession` が呼ばれた時点 | 既存（メモリ）。D1 は読まず、同じ呼び出しで台帳に「起動の境界」を 1 行足す |
| 会話の境界 | エージェントが新しい会話を始めた点：新しい起動・reset（`/clear`・`/new`）・resume で対象の会話が変わった・自動の再起動。**単なる再接続（プロセスがそのまま生きている）は境界ではない** | 新しい台帳 `session_brief_boundaries`（§3） |
| 差し込み | 境界の後の最初の「付けてよい送信」で、brief を利用者の本文の前に付けて 1 回だけ送ること | 送信の service（`sendUserMessage`） |
| 差し込みのキー | (worktree, instance, instance の世代, 境界の ID) | 台帳の行 |

---

## 2. 境界の種類 × ツールの検出

### 2.1 証拠の 3 つの源

| 源 | 何が分かるか | 根拠［事実］ |
|---|---|---|
| (a) 起動の経路 | CommandMate がプロセスを作った。全ツール共通 | `beginAgentSession` は各ツールの作成の経路だけで呼ばれ、再利用の経路では呼ばれない（`agent-session-lifecycle.ts:22-35`）。Claude `claude-session.ts:910`（再利用は `:884-889` で return）、Codex `codex.ts:298`（再利用は `:284`）、Command Code `command-code.ts:283`（再利用は `:274`） |
| (b) フックの `SessionStart` | 会話の識別（`session_id`）と種類（`source`：`startup` / `clear` / `resume` …） | `source` は `extractSnakeCaseEventDetail` が `detail` に入れる（`hook-event-vocabulary.ts:95,109`）。`recordAgentEvent` の `session_start` の分岐（`agent-event-state.ts:382,393`）が既に「`/clear` も新しい世代」として扱っている。`session_id` は記録されるが ID としては使わない（`agent-event-record.ts:24-31`、`/clear` で変わる：`app/api/hooks/agent-event/route.ts:26-28`） |
| (c) 送った本文 | CommandMate の送信の経路で reset のコマンドを送った | `sendUserMessage` はすべての「本文を打つ」経路の要（`send-user-message.ts:397-403`）。送ったのが `/clear` 等なら、次の送信は新しい会話へ行く |

画面（scraper）は境界の証拠に**使わない**［見立て］。Command Code は `/clear` の後の画面が起動画面とバイト単位で
同じ（`src/lib/detection/tools/command-code/detect.ts:39-41`、fixture `tests/fixtures/command-code-live-2250/boot-idle-1490.txt`）
で「空の会話」は読めるが、スクロールや再描画で誤るので、D1 では受入の fixture に使うだけにする（§9）。

### 2.2 表

○＝自動で検出（保証する）、△＝自動で検出するが一部の場合だけ（保証の範囲を書く）、×＝検出しない（明示の口 §7.3）

| 境界の種類 | Claude Code | Codex | Command Code |
|---|---|---|---|
| 新しい起動 | ○ (a) `claude-session.ts:910`。続く `SessionStart(source=startup)`（fixture `tests/fixtures/hooks/claude/session-start.json`）は**同じ境界**に会話の ID を結ぶだけ | ○ (a) `codex.ts:298`。`SessionStart` は**最初のターンの送信時**に来る（`tests/fixtures/hooks/codex/README.md` の表、fixture `session-start.json`）ので、境界は (a) で決まり、後から来た ID を結ぶ | ○ (a) `command-code.ts:283`。`SessionStart(startup)` は打つ前に来る（`tests/fixtures/hooks/command-code/README.md`、fixture `session-start.json`） |
| 既存のプロセスへの再接続 | 境界ではない。(a) が呼ばれない（`:884-889`） | 同（`:284`） | 同（`:274`） |
| 会話の reset | ○ (b) `SessionStart(source=clear)`（fixture `session-start-clear.json`、対の `session-end-clear.json`）＋ (c) `/clear` | △ (c) `/new`。(b) は `/new` で新しい `session_id` と 2 回目の `SessionStart` が来ると実測済み（`codex/history.ts:21-24`、codex-cli 0.151.0）だが、**届く時点（`/new` の直後か次のターンか）は［未確認］**。次のターンなら、端末から直接打った `/new` は遅れて分かる（§3.6） | △ (c) `/clear`。`/clear` で `SessionStart` が来るかは［未確認］（フックは 4 語だけ：`command-code/source.ts:14-24`）。端末から直接打った `/clear` は検出しない |
| 会話の resume（対象の会話が変わる） | △ (b) `SessionStart(source=resume)` で、`session_id` が今の境界の会話の ID と違うときだけ境界。`source=resume` の fixture は無い［未確認・要採取］ | × 実測が無い［未確認］。明示の口 | × 実測が無い［未確認］。明示の口 |
| 自動の再起動 | ○ (a) 送信の中の再起動 `relaunchIfToolExited`（`base.ts:774-790`、`requireSession` から `:827`）も `startSession` を通る | ○ (a) 同。加えて更新の後の同じペインでの再起動 `relaunchIntoSamePane`（`codex.ts:334-335`） | ○ (a) 同 |

- 他のツール（copilot・gemini・antigravity・opencode・opencode-v2・vibe-local）は**未対応**。差し込みも明示の口も
  付けない（`sendUserMessage` は今までどおり）。copilot は `SessionStart` が `UserPromptSubmit` の後に来る
  （`copilot/source.ts:53-64`）など別の扱いが要るため、表に足すときに別 Issue にする［見立て］
- Codex のフックは、信頼されていないと黙って飛ばされる（`codex/history.ts:36-40`）。その場合 (b) は無く、(a)・(c) だけになる
- Claude の `SessionStart(source=compact)` は境界にしない［見立て］：会話の ID は続き、Issue の 5 種類にも無い。
  要るなら D2 で決める

### 2.3 reset のコマンドの綴り

送った本文の先頭の語（前後の空白を除いた最初の空白までの語）で決める。表に無い綴りは reset と見ない。

| ツール | reset と見る | 根拠 |
|---|---|---|
| Claude Code | `/clear` | ［事実］`claude/history.ts:30`・`claude/transcript.ts:119,143`。別名（`/reset`・`/new`）は［未確認］のため入れない |
| Codex | `/new`、`/clear` | `/new` は実測（`codex/history.ts:21-24`）。`/clear` は［未確認］— 実装の前に CLI の一覧（slash-command のカタログ）で確かめ、無ければ外す |
| Command Code | `/clear` | ［事実］`command-code/detect.ts:39-41`（`/clear` の後の画面の採取） |

---

## 3. 境界の台帳と「1 回」の保証

### 3.1 プロセスの世代と会話の境界を分ける

- プロセスの世代（既存）は変えない。`beginAgentSession` は今までどおりメモリの柵を立てる
- 会話の境界は台帳の 1 行。1 つのプロセスの世代の中に複数の境界がありうる（起動 → `/clear` → `/clear`）。
  逆に、1 回の起動の中で 2 回プロセスが替わっても（Codex の `relaunchIntoSamePane`）、まだ何も送っていない前の境界は
  `superseded` になり、付くのは最後の境界だけ
- 「新しい境界」「単なる再接続」「同じ境界での再送」の区別：
  - 新しい境界 ＝ 台帳に新しい行が開いた（§2 の証拠のどれか）
  - 単なる再接続 ＝ 行が開かない（再利用の経路は (a) を呼ばず、`SessionStart` も来ない。サーバの再起動の後も同じ）
  - 同じ境界での再送 ＝ 同じ行への 2 回目以降の送信。行の状態が `pending` でなければ付けない

### 3.2 台帳の形（新しい表）［見立て］

```sql
CREATE TABLE session_brief_boundaries (
  id TEXT PRIMARY KEY,                    -- 境界の ID（UUID）。差し込みのキーの最後の要素
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,              -- instanceId ?? cliToolId
  cli_tool_id TEXT NOT NULL,
  instance_incarnation TEXT,              -- A の mem_instance_incarnations。無ければ NULL
  seq INTEGER NOT NULL,                   -- (worktree, instance) ごとの通し番号。最大が「今の境界」
  kind TEXT NOT NULL CHECK (kind IN ('launch','auto_restart','reset','resume','explicit')),
  evidence TEXT NOT NULL CHECK (evidence IN ('launch','hook','send_command','explicit')),
  conversation_id TEXT,                   -- 分かれば agent の session_id。後から結ぶ
  late INTEGER NOT NULL DEFAULT 0,        -- 境界を開いたターンが既に送られていた（§3.6）
  opened_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','claimed','sent','unknown','superseded','skipped')),
  skip_reason TEXT,                       -- §7 の理由（off / disabled / target_unresolved / empty / over_limit / provider_failed）
  claim_token TEXT,                       -- 取ったプロセスの nonce ＋ 送信の ID
  attempts INTEGER NOT NULL DEFAULT 0,    -- not_sent で戻した回数
  last_outcome TEXT CHECK (last_outcome IN ('not_sent','unknown','sent')),
  brief_bytes INTEGER,
  brief_mode TEXT,                        -- provider が返した mode
  included_ids TEXT,                      -- JSON の配列（含めた知らせの ID。D2 で B へ渡す）
  settled_at INTEGER,
  UNIQUE (worktree_id, instance_id, seq)
);
```

- worktree の子の表は `worktree_id` の列で自動で列挙される（`migrations/worktree-child-tables.ts:24-40`）ので、
  改名で付け替わり、削除で消える
- 保持：(worktree, instance) ごとに新しい 20 行を残し、古い行は行を足す同じトランザクションで消す（A の
  `superseded` の `now` と同じ考え方、`mem-store-4221.md:301`。新しい定期の実行を足さない：D8・D13）
- 書き込みが失敗しても起動も送信も止めない（ログだけ）。`archiveSupersededSessionMessages` と同じ扱い
  （`agent-session-lifecycle.ts:144-161`）。テストで DB が無いときは何もしない（`resolveSessionArchiveDatabase`、
  `session-generation-archive.ts:80-83` と同じ規則）

### 3.3 行を開く・結ぶ（観測）

| 観測 | 動き |
|---|---|
| `beginAgentSession` | `kind=launch`（同じ起動の 2 回目＝`noteLaunchProcessReplaced` が世代を進める場合と、`relaunchIfToolExited` からの場合は `auto_restart`）の行を開き、同じ instance の `pending` の行を `superseded` にする。`claimed` の行はそのまま（§3.5 の「送信の中の再起動」） |
| `recordAgentEvent(session_start)`（遅れた `SessionStart` の保留 `isLateSessionStart` を通った後） | `source=startup`：今の行の `conversation_id` が空なら結ぶ。空でなく違う ID なら、CommandMate の外でプロセスが作り直された（ペインで手で起動し直した）と見て `kind=launch, evidence=hook` を開く。`source=clear`：今の行が送った本文 (c) で開いた reset で `conversation_id` が空なら**結ぶ**（二重にしない）。そうでなければ `kind=reset, evidence=hook` を開く。`source=resume`：ID が今の行と違うときだけ `kind=resume` を開く。`compact` とその他：何もしない |
| ほかのフックの出来事（`session_id` を持つもの） | 今の行の `conversation_id` があり、違う ID が来たら、境界を見逃していた（サーバが止まっている間の `/clear` など）と見て `kind=reset, evidence=hook, late=1` を開く |
| `sendUserMessage` が reset のコマンド（§2.3）を `sent` で送り終えた | `kind=reset, evidence=send_command` を開く |
| `send --with-brief` | 今の行が `pending` ならそれを使う。そうでなければ `kind=explicit` を開いてその送信で取る |

- 観測の入口は 2 つ：`beginAgentSession`（`agent-session-lifecycle.ts:76` の関数の中、柵の後）と、
  `recordAgentEvent` の `session_start` の分岐（`agent-event-state.ts:393` の中、`generationStartedAt.set` の隣）。
  ほかのフックの出来事は同じ関数の `lastAgentEvent.set`（`:377`）の後で ID だけ比べる。どれも新しいモジュールの
  関数を 1 行呼ぶだけにし、`agent-event-state` は DB を import しない（呼ぶ先が動的に解決する。`transcript-history.ts:190`
  と同じ形）［見立て］
- 台帳に行が 1 つも無い instance（D1 を入れる前から動いているプロセス）は**境界が無い**＝付けない。再起動の後の
  再接続を「新しい境界」と読まないための既定

### 3.4 取る（claim）と送る

1. **計画（ロックの外、`await` あり）**：今の行が `pending` で、この送信が「付けてよい送信」（§4・§7）なら、
   所属と mode を決め（`withMemTarget`）、予算を計算し（§6）、provider に brief を作らせる
2. **取る（ロックの中、同期）**：本文を打つ直前に `UPDATE … SET state='claimed', claim_token=? WHERE id=? AND state='pending'`。
   変わった行が 1 なら brief を付ける。0 なら（別の送信が先に取った・境界が替わった）brief を付けずに本文だけ送る
3. **送る**：打つ本文は `brief + 区切り + 利用者の本文`（§6.2）
4. **決着**：送信の結果（`settle`）を写像して行を更新する

| 送信の結果（`SendAttemptState`） | 台帳の `last_outcome` | 行の状態 | 次の送信 |
|---|---|---|---|
| `sent` | `sent` | `sent`（`included_ids`・`brief_bytes`・`brief_mode` を書く） | 付けない |
| `not-sent`（何も打っていない：所有・プロンプト待ち・ロック・再確認・関係の予約の喪失など） | `not_sent` | `pending` に戻す（`attempts+1`、`claim_token` を消す） | 付ける（未送信を「読んだ」としない） |
| `indeterminate`（打ったが届いたか分からない） | `unknown` | `unknown` | **付けない**（無条件に再送しない）。人が `--with-brief` で明示したときだけ付ける |

### 3.5 「1 回」の保証の作り

| 場合 | 作り | 保証 |
|---|---|---|
| 同時の初回の送信 2 つ | 2 は better-sqlite3 の同期の 1 文（Node の 1 本のスレッドで、間に他の送信が入らない）。Claude・Codex は本文を打つ部分が既に instance の入力のロックの中（`send-user-message.ts:647-655`、`withInstanceInputLock`）。Command Code は今はロックが送信関数の中（`submit-verified-sender.ts:691`）なので、**取る候補がある送信だけ** `deliver()` を外側の `withInstanceInputLock` で包む（内側の送信関数は同じ持ち主の切符に**合流**し、並ばない：`instance-input-lock.ts:530-542`） | 付くのは 1 回だけ、かつロックの順で先に打たれた本文に付く |
| 送信の拒否（`not-sent`） | 行を `pending` に戻す | 次の付けてよい送信に 1 回付く |
| 結果不明（`indeterminate`） | 行を `unknown` に固定 | 二重には付かない。届かなかった可能性は残る（人が判断する）。D2 で B に「未確認」として渡す |
| サーバの再起動 | 台帳は DB。プロセスが生きていれば (a) は呼ばれず、行も開かない→付かない。プロセスが死んでいて送信の経路が起動し直せば (a) で新しい行→付く。再起動の前に `claimed` のまま残った行は、`claim_token` の nonce が今のプロセスのものでないので、読むときに `unknown` として扱い書き直す（起動時の掃除を足さない） | 再接続では付かない。クラッシュの最中の送信は二重にしない |
| 送信の中の再起動 | `sendMessage` の中の `requireSession` → `relaunchIfToolExited`（`base.ts:808-829`）は、本文を決めた**後**に新しいプロセスを作る。決着が `sent` のとき、取った行より新しい行がこの送信の取った後に開いていたら：取った行に brief を付けていたなら、新しい行を `sent`（同じ記録を写す）・取った行を `superseded` にする（brief は実際には新しいプロセスに届いたため）。付けていなかったなら新しい行は `pending` のまま（次の送信に付く） | 1 回。ただし「再起動の後の最初の本文」に付くとは限らない（2 通目に付くことがある） |
| 境界が古くなる | 新しい行が開くと、それより前の `pending` は `superseded` | 前の境界の brief が後の会話の途中に入らない |

### 3.6 遅れて分かる境界

端末から直接打った reset（Codex の `/new`・Claude の `/clear`）は (c) を通らない。(b) が来れば分かるが、Codex の
`SessionStart` が次のターンの送信時に来るなら、その送信は既に brief なしで打たれている［未確認］。この場合は行を
`late=1` で開き、**次の**付けてよい送信に付ける。「最初の本文に付く」ではなく「その境界に 1 回付く」が保証の範囲。

---

## 4. 送信の経路

### 4.1 付ける経路・付けない経路

`sendUserMessage` に新しい引数 `brief?: 'auto' | 'skip' | 'force' | 'never'` を足し、**既定は `never`**（付けない・取らない）。
付ける経路だけが `auto`（または利用者の指定）を渡す。新しい呼び出し元が黙って付けることは無い［見立て］。

| 経路 | 入口［事実］ | D1 | 理由 |
|---|---|---|---|
| CLI `send` | `src/cli/commands/message-dispatch.ts:188`（`postMessage` → `POST /api/worktrees/:id/send`） | 付ける（`auto`。`--no-brief`→`skip`、`--with-brief`→`force`） | 人・Agent が会話を進める主経路 |
| CLI `ask` | `src/cli/commands/ask.ts:64` で同じ `postMessage` | 付ける（`auto` だけ。旗は足さない） | 同じ route を通る。旗は要望が出てから |
| 契約付きの依頼（`send --contract`） | `send.ts:304-340` が task を作って前文つきの本文を受け取り、同じ route へ | 付ける（`auto`） | 契約の前文は利用者の本文として扱い、削らない。上限は §6 |
| 画面の送信（PC・スマホ） | `src/components/worktree/MessageInput.tsx`・`ChatSurface.tsx`・`MobileTerminalTab.tsx`・`SessionTile.tsx`・`src/hooks/usePendingMessages.ts` → `src/lib/api-client.ts` → 同じ route | 付ける（`auto`。API の `brief` の欄を受ける） | 画面の「読まない」のボタンは G（#4227）。D1 は API の欄 `brief: 'skip' | 'force'` までを作る |
| Timer（時刻の送信） | `src/lib/timer-manager.ts:110` | 付ける（`auto`） | 手の送信と同じ経路をとる方針（#1028、同 `:103-109`）。新しい起動の後の最初の送信になりうる |
| relay の配送 | `src/lib/relay/relay-delivery.ts:611` | 付けない（`never`。ファイルは変えない） | 本文は相手の返事で、bind・予約・保留の 1 回の台帳（#3957・#4064）が本文の digest で配送を追う。brief を混ぜると「その返事が届いたか」の判定を変える。境界も**取らない**ので、`pending` は次の付けてよい送信に残る |
| Schedule（`CMATE.md`） | `src/lib/schedule-manager.ts:149` → `job-executor.ts:228`（`execFile` で 1 回の実行） | 付けない | tmux の会話が無い 1 回きりの実行。dreaming（D13）は自分の材料（`dream-input`）で動く |
| ターミナルの命令 | `src/app/api/worktrees/[id]/terminal/route.ts`（`sendUserMessage` を通らない、同 `:24-26`） | 付けない | 利用者が打った命令そのもの。前に文を足すと命令が変わる |
| 直接入力・特殊キー・回答 | `direct-input/route.ts`・`special-keys/route.ts`・`respond`・`prompt-response` | 付けない | ダイアログへの回答とキー。`sendUserMessage` を通らない（`send-user-message.ts:400-403`） |
| slash コマンドの送信 | どの経路でも、本文の先頭の語が `^/[a-z][a-z0-9-]*$` | 付けない・取らない | コマンドの前に文を足すとコマンドでなくなる。reset のコマンドなら §3.3 で行を開く |

### 4.2 `agent-session-lifecycle` に入れる所

- `beginAgentSession`（`agent-session-lifecycle.ts:76`）：`beginAgentEventGeneration`（`:98`）の後、archive（`:152`）の前に、
  `try` で包んだ `openLaunchBoundary(target, at, kind)` を 1 行。`kind` は `noteLaunchProcessReplaced`（`:90`）が世代を
  進めたかどうか（同じ起動の 2 回目）と、`relaunchIfToolExited` の中か（`AsyncLocalStorage` の印、`markSessionStarting`
  と同じ持ち方）で `launch` / `auto_restart` を分ける［見立て］
- 再利用の経路には何も足さない（再接続は境界ではない）

### 4.3 `send-user-message` に入れる所

| 箇所［事実］ | 足すこと |
|---|---|
| 引数 `SendUserMessageParams`（`:99-171`） | `brief?: 'auto' \| 'skip' \| 'force' \| 'never'`、`onBrief?(outcome)`（route が応答に載せる） |
| 本文を打つ形 `typedBodyFor`（`:281-285`、`:338`） | `typedContent` を「brief を付けたなら付けた本文」から作る。`settle` の `typedContent`（`:357`、#4048 の最初のプロンプトの受領が digest で照らす）も付けた本文になる |
| プロンプト待ちの確認の後（`:425` の後、`/model` の段 `:444` の後） | 計画（§3.4 の 1）。`not-sent` で返る経路（`:373`・`:413`・`:455-459`）は計画の前なので台帳に触らない |
| `deliver()` の始め（`:562` の前） | 取る（§3.4 の 2）。Claude・Codex はここが既に外側のロックの中（`:647-650`） |
| `sendToTool()`（`:607-640`） | `content` の代わりに付けた本文を渡す（画像の経路 `:612`・`:618-622` も同じ） |
| ロックの選び方（`:647`） | 取る候補があるときは Command Code も外側のロックで包む |
| 失敗の後の composer の読み `composerStillHolds`（`:259-274`、`:599`） | 照らす本文を付けた本文にする（`composerHoldsMessage` は本文の最初の行を探す：`send-attempt-state.ts:413-417`。付けた本文の最初の行は brief の行） |
| `settle`（`:342-363`）と `sent` の後（`:669`） | 台帳の決着（§3.4 の 4）。reset のコマンドなら行を開く |
| 履歴の行 `createMessage`（`:685-694`）・`updateLastUserMessage`（`:763`）・孤児の判定（`:537-549`） | **変えない**。利用者の本文だけを保存する。brief は台帳にだけ残す |

route（`src/app/api/worktrees/[id]/send/route.ts`）：`send-request.ts` の `SendMessageRequest`（`:30-49`）に
`brief?: 'skip' | 'force'` を足して検証し（不正は 400、何も記録しない）、`sendUserMessage`（`route.ts:364`）へ
`auto` / `skip` / `force` で渡す。応答の `brief` の欄は**付けたとき・旗があったときだけ**足す（空の provider で
旗なしなら応答は今とバイト単位で同じ）。

---

## 5. BriefProvider の口

### 5.1 形［見立て］

新しいモジュール `src/lib/session/brief-provider.ts`。C（#4223）はこの口を実装し、D2 で差し替える。

```ts
import type { MemMode } from '@/types/mem';
import type { CLIToolType } from '@/lib/cli-tools/types';

export type BriefBoundaryKind = 'launch' | 'auto_restart' | 'reset' | 'resume' | 'explicit';

export interface BriefRequest {
  /** 誰の境界か。 */
  target: {
    worktreeId: string;
    cliToolId: CLIToolType;
    instanceId: string;               // instanceId ?? cliToolId
    instanceIncarnation: string | null;
  };
  /** 所属（A の withMemTarget の答え。off は渡さない）。 */
  membership: {
    repositoryId: string;             // storageRepositoryId
    readRepositoryIds: string[];
    branch: string | null;            // detached は null
    detached: boolean;
    mode: Exclude<MemMode, 'off'>;    // 'derived' | 'on'
  };
  /** 境界の種類。 */
  boundary: {
    id: string;
    kind: BriefBoundaryKind;
    late: boolean;
    openedAt: number;                 // epoch ms（サーバの時刻）
  };
  /** 予算。UTF-8 の最終出力のバイト数と行数。maxBytes >= provider.minBytes のときだけ呼ぶ。 */
  budget: { maxBytes: number; maxLines: number };
  now: number;
}

export interface BriefResult {
  /** そのまま打つ本文（区切りの形は provider の責任：D12）。'' は付けない。 */
  body: string;
  /** body に実際に含めた知らせの ID（D2 で B の受領に渡す）。 */
  includedNoticeIds: string[];
  /** provider が組み立てに使った mode（request の mode と違えば付けない）。 */
  mode: Exclude<MemMode, 'off'>;
}

export interface BriefProvider {
  readonly id: string;
  /** これ未満の予算では brief を作れない（C の「最小値」）。 */
  readonly minBytes: number;
  /** 予算の既定値（C の「既定値」）。 */
  readonly defaultBytes: number;
  build(request: BriefRequest): Promise<BriefResult> | BriefResult;
}

export const EMPTY_BRIEF_PROVIDER: BriefProvider = {
  id: 'empty',
  minBytes: 0,
  defaultBytes: 0,
  build: (request) => ({ body: '', includedNoticeIds: [], mode: request.membership.mode }),
};

export function getBriefProvider(): BriefProvider;          // 既定は EMPTY_BRIEF_PROVIDER
export function setBriefProviderForTest(p: BriefProvider | null): void;
```

D1 の側が検める（provider を信じない）：

- `Buffer.byteLength(body, 'utf8') <= budget.maxBytes` と行数 `<= budget.maxLines`。超えたら付けない（`skipped`、`over_limit`）
- `mode` が request と同じ。違えば付けない（`provider_failed`）
- 例外・時間切れ（既定 2 秒［見立て］）は付けない（`provider_failed`）。**送信は続ける**（利用者の本文は送る）
- `body === ''` は付けない（`skipped`、`empty`。境界は消費する — 空の provider のまま行が `pending` に残り、C を入れた後に
  会話の途中で付くのを防ぐ）

### 5.2 C（#4223）と照合する点

C の Issue と両方に書く（D1 の実装の契約の前に、C の設計者と合わせる）。

| # | 点 | D1 の案 |
|---|---|---|
| C1 | 予算の単位 | C の「テキストの最終出力の UTF-8 のバイト数」をそのまま使う（`--json` の形は使わない） |
| C2 | 行数 | #2464 の保証が 240 行でもあるので `maxLines` を渡す。C が行数を守れないなら D1 が超過として付けない |
| C3 | 最小値・既定値 | provider の `minBytes` / `defaultBytes` として C が持つ。D1 は `maxBytes < minBytes` なら呼ばない（C の CLI の「最小値未満は入力の誤り」とは別。口では誤りにせず「付けない」） |
| C4 | mode | `off` では呼ばない。`derived` は手で書いた項目を出さない（C の受入どおり）。答えの `mode` を照らす |
| C5 | 含めた知らせの ID | `includedNoticeIds` は「本文に実際に入った」ものだけ（予算で落ちた項目を含めない）。ID の名前空間（mem の item ID か B の知らせの ID か）は C と B で決める。D1 は不透明な文字列として保存する |
| C6 | 区切り（D12） | 出所・作者・時刻つきのデータの区画の形は C。D1 は `body` の後に区切りを 1 つ置くだけ（§6.2） |
| C7 | 決定性 | 同じ状態から同じ本文（C の安定性の受入）。D1 の試験は固定の偽の provider で行う |
| C8 | 副作用 | `build` はモデルを呼ばず（Epic D1）、DB に書かない（受領の記録は D2 で B が行う） |
| C9 | 境界の種類 | `kind` と `late` を渡す。種類で本文を変えるか（例：resume では「前の会話の続き」を短く）は C が決める |

---

## 6. 予算・#2464・配送の記録

### 6.1 上限

- 上限：`SEND_VERIFIED_MAX_BYTES = 48 × 1024`、`SEND_VERIFIED_MAX_LINES = 240`（G1。今は CLI の `send.ts:65-66` にある値を
  `src/config/send-verified-limits.ts` へ移し、CLI の `--help` と server が同じ値を読む）
- **brief を足すときだけ**上限を見る。利用者の本文だけの送信は今までどおり（長さで断らない・削らない）

### 6.2 合計の計算

```
区切り   = "\n\n"
付けた本文 = brief.body + 区切り + 利用者の本文
空き(bytes) = MAX_BYTES - bytes(利用者の本文) - bytes(区切り)
空き(lines) = MAX_LINES - lines(利用者の本文) - 1
予算.maxBytes = min(provider.defaultBytes, 空き(bytes))
予算.maxLines = 空き(lines)
```

- 画像の経路では、`typedBodyFor` が付けた本文に画像の参照を足す（今と同じ処理を付けた本文に対して行う）。参照の
  バイト数も空きから引く
- `予算.maxBytes < provider.minBytes` または `予算.maxLines < 1`：brief を付けずに送り、行を `skipped`（`over_limit`）に
  する（記録する）。**利用者の本文は削らない**
- 「brief を予算の最小値まで縮める」は、`maxBytes` を空きまで下げて provider に渡すことで行う（縮め方は C）

### 6.3 到達の確認との合わせ方

- 到達の確認（`submit-verified-sender.ts:675-760`：512 バイト超は 1 回の bracketed paste、Enter は composer が全体を示すまで
  押さない）は**付けた本文**に対して働く。brief を別に打たず、1 つの本文として 1 回で打つので、確認の仕組みは変えない
- 失敗の分類（`classifySendFailure`）・`composer-residue` の判定・最初のプロンプトの受領（#4035・#4048）も付けた本文で
  照らす（§4.3）
- 既存の #2464 の試験（`tests/fixtures/long-body-2464/` を使うもの）は変えずに通ること（空の provider では打つ本文が今と同じ）

### 6.4 配送の記録

§3.4 の表のとおり。`sent` のときだけ `included_ids` を確定する。`not_sent` は「読んだ」としない。`unknown` は再送しない。
D2 はこの行を読んで B の受領に渡す（D1 は B を呼ばない）。

---

## 7. 例外（「1 回付ける」の外）

| 例外 | 判定 | 行 | 応答（旗または付けたとき） |
|---|---|---|---|
| mode が `off` | `withMemTarget` の `mode === 'off'` | `skipped`（`off`）。境界は消費（後で on にしても会話の途中に入れない） | `brief: { state: 'skipped', reason: 'off' }` |
| `injectOnStart` が `false` | `features.injectOnStart` | `skipped`（`disabled`） | 同（`disabled`） |
| 所属が決まらない | `withMemTarget` の失敗 | `skipped`（`target_unresolved`） | 同 |
| 明示の省略 `--no-brief`・API `brief: 'skip'` | 送信の引数 | **触らない**（`pending` のまま）。その 1 回だけ効き、設定は変えない | `brief: { state: 'skipped', reason: 'no_brief' }` |
| 合計が上限を超えた | §6.2 | `skipped`（`over_limit`） | 同 |
| provider の失敗・空 | §5.1 | `skipped`（`provider_failed` / `empty`） | 空のときは応答に足さない |
| 配送の結果が不明 | `indeterminate` | `unknown` | `brief: { state: 'unknown' }` |
| slash コマンドの送信 | §4.1 | 触らない | 足さない |

### 7.3 明示の口（境界を検出できないツールの代わり）

- `commandmate send <id> "…" --with-brief`（API `brief: 'force'`）：mode と `injectOnStart` が許すときに、今の行が `pending` なら
  それに、そうでなければ `kind=explicit` の行を開いて、この送信に付ける。`unknown` の行の後でも付く（人の判断）
- `--with-brief` と `--no-brief` は同時に指定できない（exit 2、何も送らない）
- 画面のボタン（「brief を付けて送る」「読まない」）は G（#4227）。D1 は API の欄まで
- 保証の範囲：明示の口は「その送信に 1 回付ける」だけで、会話の境界を知らない。同じ会話で何度押しても毎回付く

---

## 8. 実装の範囲（次の契約）

### 8.1 新規

| ファイル | 中身 |
|---|---|
| `src/lib/session/brief-provider.ts` | §5.1 の型・`EMPTY_BRIEF_PROVIDER`・取得と試験用の差し替え |
| `src/lib/session/session-boundary.ts` | 観測（§3.3）：`openLaunchBoundary`・`observeSessionStartBoundary`・`observeConversationId`・`openResetBoundaryFromSend`、reset の綴り（§2.3）・slash コマンドの判定 |
| `src/lib/session/session-brief.ts` | 計画・取る・決着（§3.4〜3.5）、予算（§6.2）、provider の検め（§5.1） |
| `src/lib/db/session-brief-db.ts` | 台帳の SQL（開く・取る・戻す・決着・保持の 20 行） |
| `src/lib/db/migrations/v67-session-brief-boundaries.ts` | §3.2 の表（番号は §0.2） |
| `src/config/send-verified-limits.ts` | 48 KiB・240 行（G1） |

### 8.2 変える既存のファイル

| ファイル | 変更 |
|---|---|
| `src/lib/session/agent-session-lifecycle.ts` | §4.2 の 1 行 |
| `src/lib/session/agent-event-state.ts` | `recordAgentEvent` の `session_start` の分岐と ID の比較に 1 行ずつ（§3.3） |
| `src/lib/session/send-user-message.ts` | §4.3 |
| `src/app/api/worktrees/[id]/send/route.ts`・`send-request.ts` | `brief` の欄の検証と受け渡し、応答の `brief` |
| `src/lib/timer-manager.ts` | `brief: 'auto'` |
| `src/cli/commands/send.ts` | `--no-brief` / `--with-brief`、`--help`、上限の定数を `src/config/send-verified-limits.ts` から |
| `src/cli/commands/ask.ts`（必要なら `message-dispatch.ts`） | `brief` を送らない（route の既定 `auto`）。変更が無いことを試験で固定 |
| `src/cli/types/api-responses.ts` | 送信の応答の型に `brief?`（`:1702` の `sendOutcome` の隣） |
| `src/lib/db/migrations/runner.ts` | `CURRENT_SCHEMA_VERSION` |
| `src/cli/docs/agent-operations.ts`、`docs/user-guide/cli-operations-guide.md`（ja）と `docs/en/` の対 | 旗と例外の説明 |

変えないもの：`src/lib/relay/relay-delivery.ts`（既定 `never` で付けない）、`src/lib/mem/**`・`mem-db.ts`・
`agent-instances-db.ts`（§0.2）、`submit-verified-sender*.ts`（到達の確認はそのまま）、ターミナル・直接入力・回答の route。

---

## 9. 試験（受入基準との対照）

すべて単体・結合の試験で、実機・tmux・サーバは使わない。DB は `os.tmpdir()` 配下の `fs.mkdtempSync` に作り、`afterEach` で消す。
偽の provider は空でない固定の文 `FAKE_BRIEF = '[[brief:fixed]]'`（`minBytes: 16`、`defaultBytes: 4096`）。
画面とフックの入力は既存の fixture を使う：Claude `tests/fixtures/hooks/claude/session-start.json`・`session-start-clear.json`・
`session-end-clear.json`、Codex `tests/fixtures/hooks/codex/session-start.json`・`session-end.json`、Command Code
`tests/fixtures/hooks/command-code/session-start.json` と `tests/fixtures/command-code-live-2250/boot-idle-1490.txt`。
Claude の fixture は `session_id` が置換で同じ値なので、ID の変化の試験は fixture を読んでから ID だけ差し替える。

| 受入基準（#4274） | 陽性（今の実装では落ちる） | 陰性（今までどおり） |
|---|---|---|
| 境界の種類ごとに偽の brief が 1 回だけ付く | 3 ツール × {起動（`beginAgentSession`）、reset（hook／送った `/clear`・`/new`）、自動の再起動} のそれぞれで、次の送信の打つ本文が `FAKE_BRIEF + "\n\n" + 本文`、その次の送信は本文だけ | 境界の無い instance（行が無い）への送信は本文だけ |
| 「初回 → reset → 送信」で 2 回目にも付く | 起動 → 送信（付く）→ `/clear`（付かない・行が開く）→ 送信（付く）。Claude は hook と送った本文の両方が来ても 1 回 | `/clear` そのものには付かない |
| reset の無い再接続では付かない | — | 再利用の経路（`beginAgentSession` を呼ばない）→ 送信は本文だけ。`SessionStart(compact)` の後も本文だけ |
| resume で対象の会話が変わると付く | Claude：`SessionStart(source=resume)` で ID が違う → 付く | 同じ ID の `resume` → 付かない |
| 同時の初回の送信 | `sendUserMessage` を 2 つ並べて走らせる（送信関数は偽）→ brief は 1 つの本文だけ、それはロックで先に打たれた方。Command Code でも同じ（外側のロックで包む） | 境界が無いときは 2 つとも本文だけで、ロックの取り方も今と同じ（Command Code を外側で包まない） |
| 送信の拒否 | プロンプト待ち・`not-sent` で決着 → 行は `pending`、次の送信に付く | 拒否された送信の打つ本文は無い（今と同じ） |
| 結果不明 | `indeterminate` → 行は `unknown`、次の送信に付かない。`force` では付く | — |
| サーバの再起動 | 台帳を残しメモリの状態（`resetLaunchRoleStateForTest` 等とモジュールの再読み込み）を消す → 再接続の送信は本文だけ。`claimed` の行（他の nonce）は `unknown` に読まれる | プロセスが死んでいて起動し直す送信には付く |
| 送信の中の再起動 | `relaunchIfToolExited` を送信の中で起こす（偽）→ §3.5 の表どおり | — |
| mode が `off` では何も付かない | — | `injectOnStart: false` または規則で `off` → 本文だけ、行は `skipped`。provider は呼ばれない |
| `--no-brief` は 1 回だけ効く | `skip` → 本文だけ、次の送信に付く。設定（`mem-settings`）は変わらない | CLI：`--no-brief` と `--with-brief` の同時は exit 2 で何も送らない |
| 合計が上限を超えても本文を削らない | 47.9 KiB の本文 → brief なし・本文はバイト一致・行は `skipped(over_limit)`。49 KiB の本文（brief なし）は今どおり送られる | 空きが `minBytes` 以上なら `maxBytes` が空きまで下がって provider に渡る |
| #2464 の到達の確認の試験が通ったまま | — | 既存の `long-body-2464` の試験を変えずに走らせる。付けた本文の 513 バイト超は paste の経路を通る |
| 空の provider では送信の本文が今と同じ | — | **固定の試験**：`EMPTY_BRIEF_PROVIDER` で、境界あり・mode `on`・`injectOnStart: true` の送信の、`cliTool.sendMessage` / `sendMessageWithImage` へ渡る本文が引数の `content` とバイト一致、`recordSendAttempt` の `typedContent` が無い、route の応答に `brief` の鍵が無い、`chat_messages` の行が今と同じ |
| 付けない経路 | — | relay の配送（`never`）・Schedule・ターミナル・直接入力・回答は付けず、行も触らない。`sendUserMessage` の呼び出し元を列挙して `brief` の値を固定するガード（新しい呼び出し元は既定 `never`） |
| slash コマンド | — | `/model` などに付けない、行を触らない |

---

## 10. 未確認の一覧（D2 の実機の受入、または実装の前の採取）

| # | 未確認 | 影響 | 確かめ方 |
|---|---|---|---|
| U1 | Claude の `SessionStart(source=resume)` の payload（ID が resume の対象の会話のものか） | §2.2 の Claude の resume | 隔離の tmux で `/resume` を選び、fixture を採る |
| U2 | Codex の `/new` の 2 回目の `SessionStart` が届く時点 | §3.6 の late の頻度 | 隔離の tmux で `/new` → 何も打たずに待つ／次を打つ |
| U3 | Codex に `/clear` があるか、`/resume` で `SessionStart` が来るか | §2.3・§2.2 | slash のカタログと実機 |
| U4 | Command Code の `/clear`・resume で `SessionStart` が来るか | 来るなら Command Code の reset が ○ になる | 実機（v1.53 以降） |
| U5 | Claude の `/clear` の別名（`/reset`・`/new`） | 綴りの表 | slash のカタログ |
| U6 | brief を付けた本文が、Claude の transcript からの履歴（#2121）にどう出るか | 画面の会話に brief が利用者の発言として出る可能性 | D2 の実機。出るなら D2 で履歴の表示から外す |
| U7 | provider の時間切れの既定（2 秒） | 送信の遅れ | C の実測 |

## 11. D2 に残すもの（#4224）

C の provider を `getBriefProvider()` へ接続する・`included_ids` と `last_outcome` を B の受領へ渡す・フックでも brief を出す
Agent で二重にしない（フックの側を採るか送信の側を採るか）・予定していない終わり方の後の先頭の表示・Claude Code / Codex /
Command Code の実機の受入（§10 の U1〜U6 を含む）。
