# antigravity — 「保存できた」と「終わった」を分ける（Issue #2443）

関連: #2198（転写リーダー）／#2264（未確定 turn を書かない）／#2436（capture の三値化）／#2437（送信直前フラッシュ）／#2438（保存済み行の grow）／#2377（relay への完了通知）／#2401（relay の turn 行要求）
照合基準: `bc6b308f`（#2438 マージ後、2026-09-09）

---

## 0. この文書が決めること

agy は **ターンを閉じるレコードを書かない**。判定材料は「最後に書いたレコードの形」しかなく、
`isAntigravityTurnClosingRecord` はそれを `MODEL` / `PLANNER_RESPONSE` / `tool_calls` なし / 非空 content と定義している。
中間ナレーション（「現在 Command Code からの返答待機中です」）はこの形に完全に一致する。

#2438 はここから生じる被害のうち **行の凍結** を修復可能にした。修復できないまま残ったのが、
同じ `true` が引き起こす **配送** である:

- `structured-history-gate` は capture の `true` を受けて `onRelayTurnCompleted(..., settled=true)` を呼ぶ。
- `relay-delivery` は `settled=true` で即座に `stashReplyForOpenRelays` を実行し、最新の assistant 行を配送する。
- 配送済みの本文は `broadcastMessage('message_updated', …)` では取り消せない。

本 Issue は **「History が保持している」と「エージェントが書き終えた」を別の事実として扱う**。
保存・表示・修復はこれまでどおり続け、外へ出す配送だけを証拠で門番する。

---

## 1. 状態遷移と終了証拠

### 1.1 二つの状態

| 状態 | 意味 | History | `message_updated` | relay への完了通知 |
|---|---|---|---|---|
| **provisional（暫定）** | 行はある。agy が書き終えたとは言っていない | 保存済み。以後の read で伸びれば更新 | 出す | **出さない** |
| **settled（確定）** | agy 自身の記録がこの本文で終わったと言える | 同上 | 出す | 一度だけ出す |

`captureAntigravityTranscriptTurn` の戻り値（boolean）は**変えていない**。`true` は従来どおり
「History がこの turn を Markdown として保持しているので scrape を捨てよ」であり、#2436 の
`outcome` も #2437 のカーソル前進も #2264 の「未確定 turn は書かない」もそのままである。
状態は `StructuredHistoryCaptureReport.completion` という**別のフィールド**で伝える。
理由は #2436 が `outcome` について書いたものと同じ: 戻り値の意味を増やすと、既存の
`if (await captureStructuredHistoryTurn(...))` が黙って別の意味になる。

### 1.2 採用する終了証拠 — agy 自身の `Stop`、順序で照合する

**`resolveAntigravityTurnCompletion(turn, stopAt)`**（`src/lib/hooks/sources/antigravity/transcript.ts`、純関数）。
確定するのは次を**すべて**満たすときだけ:

1. `isAntigravityTurnWritable(turn)`（`closed || superseded`）— そもそも書ける形になっている。
2. `antigravityTurnLastRecordAt(turn) > 0` — turn 内に `created_at` を持つレコードが 1 件以上ある。
3. `stopAt !== null` — この instance について `Stop` を受信済み。
4. `stopAt >= max(lastRecordAt, turn.startedAt)` — その `Stop` が turn の**最新レコード以降**に届いている。

`reason` は `stop-after-last-record`（確定）／`turn-open`／`no-timestamped-record`／`no-stop-event`／
`stop-before-last-record` の 5 語で、ログに出る。

**出所。** `stopAt` は `src/lib/session/agent-event-state.ts` の `getLastStopEventAt(worktreeId, cliToolId, instanceId)`。
`/api/hooks/agent-event` → `applyAgentStopEvent` が `recordAgentStopEvent` を呼んでから
`resolveStopTranscriptCapture` に進むので、**Stop 起点の capture では読み出し時点で既に入っている**。
poller 起点の capture も同じ値を読む。したがって受け口から gate へフラグを引き回す配線は不要で、
2 つのトリガが同じ 1 本の証拠を見る。

**`(worktreeId, cliToolId, instanceId, conversationId, turn)` への対応付け。**

| 次元 | 対応付け |
|---|---|
| `worktreeId` / `cliToolId` / `instanceId` | `buildCompositeKey` の複合キー。`getLastStopEventAt` も追跡リストもこのキー |
| `conversationId` | hook の `conversationId`（= `brain/<id>` のディレクトリ名）。追跡リストは会話 id ごと持ち、別会話なら丸ごと捨てる |
| `turn` | `step_index`。行キーは `antigravity-turn:<conversationId>#<stepIndex>` |
| 本文の版 | `completionKey = <requestId>@<lastRecordAt>` |

### 1.3 なぜ「文言／秒数／`status`／`truncated_fields`」ではないのか

- **文言**（"waiting" / 「待機中」）: モデルの散文であり、言語を変えれば外れる。結論が待機に言及したときも誤る。
  テストは同じシナリオを日本語と英語で流し、同じ判定になることを固定している。
- **固定 N 秒**: 起票時の実測で早期候補→次レコードが min 3 / median 58 / **max 156** 秒、
  最後側の観測可能な 4 件が min 9 / median 113 / max 118 秒。**重なっており定数では分離できない**。
  fixture はこの最悪ケース（156 秒）を持ち、テストはそれを 3 秒に詰めても判定が動かないことを固定している。
- **`status: DONE`**: 起票時の実測では早期 8 件・最後 7 件のすべてが `DONE`。分離しない。
- **`truncated_fields`**: agy が「フィールドを省略した」と言う属性であって、終了の宣言ではない。
  相関（早期 0 / 最後 4）は測られているが因果は測られていない。fixture には意図的に入れていない。

### 1.4 次 `USER_INPUT` による区切りを終了証拠にしない理由

`superseded`（後続 `USER_INPUT` が別 turn を開いた）は **「その turn にはもうレコードが追加されない」**
という構造上の事実であり、`isAntigravityTurnWritable` はそれを書き込み可否の根拠として使い続ける。
しかし **「依頼が成功した」証拠ではない**: 人間が痺れを切らして次を打った turn も、エージェントが
途中で落ちた turn も同じく superseded になる。

さらに実務上、確定判定を `superseded` にも広げると副作用が 2 つある:

1. relay へ配送してよいかの判断が「最新 turn」についてのものである以上、最新 turn は定義上 superseded に
   ならないので、配送側では **一度も効かない**。
2. 追跡（§3）の終了条件に使うと、「次のプロンプトが来た瞬間に追跡をやめる」ことになり、
   Issue が要求する「通常窓の外に落ちた古い候補を追い続ける」が成立しなくなる。

したがって **終了証拠は `Stop` の順序照合のみ**とし、`superseded` は書き込み可否のためだけに残す。

### 1.5 `Stop` に `{"decision":"continue"}` を返せる問題への答え

`src/lib/hooks/sources/antigravity/source.ts` が記すとおり、agy の `Stop` は観測ではなく、
`continue` で応答するとループが再開する。ここでは **`continue` を検出しない**。証拠が「フラグ」ではなく
**順序**だからである:

- ループが再開すれば、再開後のレコードは `Stop` より後の `created_at` を持つ。すると
  `stopAt >= lastRecordAt` が再び偽になり、**確定が自動的に取り消される**（テストで固定）。
- 新しい本文が新しい `Stop` で確定されたときは `completionKey` の `@lastRecordAt` が変わるので、
  改めて 1 回だけ通知される（過去分の追送ではなく、新しい本文についての新しいエッジ）。

**残余リスク。** `created_at` は秒精度なので、`Stop` と同じ秒に追記されたレコードは `stopAt` と等値に見える。
これはサブ秒の窓であり、`created_at` の 1 tick で上界が決まる。誤りの向きは
「1 レコード早く確定する」であって「終わっていない turn を終わったことにし続ける」ではない。

---

## 2. 証拠が得られない場合

| 状況 | 起きること | 結果 |
|---|---|---|
| **hook が使えない** | `resolveAntigravityConversationId` が null。転写を読む経路自体に入らない | reader は `false`。scraper が唯一の writer になり、poller が `settled=false` で従来どおり通知する（`response-checker.ts`） |
| **`Stop` が一度も来ない**（agy が落ちた／hook が失敗した） | `reason: 'no-stop-event'` | 行は保存・更新され続ける。**完了通知は出さない**。relay は既存の締切（`sweepExpiredRelays`）で終わる |
| **古い `Stop`（前 turn のもの）** | `reason: 'stop-before-last-record'` | 同上。誤配送しない |
| **`Stop` の後に MODEL が続く** | 新レコードで再び `stop-before-last-record` | 確定が取り消され、再確定後に新しい key で 1 回だけ通知 |
| **転写の書き込み遅延**（`Stop` が先、レコードが後） | 一時的に `turn-open` か `stop-before-last-record` | `stop-history-capture` の再試行と poller の次 tick が拾う。#2264 / #2399 の経路は変えていない |
| **プロセス／CommandMate 再起動** | `getLastStopEventAt` も追跡リストも in-memory なので消える | 行の冪等性は `request_id` にあるので二重 INSERT はしない。確定は次の `Stop` を待つ。追跡は §3 のとおり #2438 の窓まで縮む |
| **`agent-event-state` に到達できない** | `resolveAntigravityStopAt` が catch して null | `no-stop-event` と同じ。保存は続き、配送はしない |

**理由をどこに残すか。** provisional のまま `captured === true` になった capture は
`structured-history-gate` が `structured-history-capture-provisional` を `reason` 付きで INFO 出力する。
reader 側は `antigravity-transcript-unsettled-out-of-window` / `-unsettled-evicted` を出す。
relay 側の待機・timeout 経路（`relay-scrape-row-not-transcript-backed`、`sweepExpiredRelays`）は変更していない。

**昇格しない。** 証拠がないまま暫定回答を「完了」にする経路は追加していない。

---

## 3. 要再確認 turn の追跡

### 3.1 条件

追跡リスト（`__antigravityUnsettledTurns`、instance キー → `{ conversationId, steps[] }`）に入るのは
**この reader が行を持っていることを確認し、かつ確定していない turn** だけである。
`ANTIGRAVITY_TURN_RECHECK_LIMIT = 3` は「既に保存した user turn の直近 3 件」という #2438 の窓で、
そのまま**下限**として残す。毎 poll の候補は:

```
candidates = (追跡リストにあり、かつ直近3件に入っていない turn) ++ (直近3件)
```

### 3.2 終了条件

| 終了 | きっかけ |
|---|---|
| 確定した | `Stop` の順序照合が通った時点で外す（`noteAntigravityTurnCompletion(confirmed=true)`） |
| 行が消えた | `findMessageByRequestId` が null。History がクリアされた等、修復対象が無い |
| 読み取り窓から消えた | 今回の read の turn 集合に `step_index` が無い（`forgetAntigravityTurnsOutsideWindow`） |
| 会話が変わった | `conversationId` 不一致でリストごと破棄（`/clear` は新しい会話 id を発行する） |
| 上限を超えた | 最古を 1 件 evict（ログに出す） |

### 3.3 計算量の上限

- 1 instance あたりの追跡件数 = `ANTIGRAVITY_UNSETTLED_TURN_LIMIT = 16`。
- 1 poll あたりの候補数 ≤ `16 + 3 = 19`（転写の長さに依存しない固定値）。
- 候補 1 件のコストは索引 1 回（`findMessageByRequestId`）。行があり、かつ書ける形のときだけ render。
- 直列化は gate の per-instance キューのまま。タイマもループも追加していない。

**3 件を増やしただけではない。** 3 は「新しい turn が続いても近傍は見る」という下限として残し、
その外は「この reader が暫定で書いた行」という**述語**で追う。無条件に窓を広げるより件数は小さく、
かつ 4 turn 先でも 10 turn 先でも同じように届く。

### 3.4 保証範囲外（明示）

次は復元不能な入力であり、**保証しない**:

- **read tail（4 MiB）の外** — 転写の先頭が窓から出た turn。
- **`USER_INPUT` が窓に無い** — turn を組み立てられない（`preludeRecords` として計上、`false` を返す）。
- **`MAX_ANTIGRAVITY_TURN_RECORDS = 2048` 超過** — `overflowed` としてログに出るが、落ちたレコードは戻らない。
- **転写ファイルが削除／置換された** — `locateAntigravityTranscript` が null、または window から消えて追跡解除。
- **プロセス再起動でリストが消えた後、既に 3 turn 以上進んでいた行** — #2438 の窓まで縮む。

### 3.5 同じ長さ／短い再読本文について

`growAntigravityTurnRow` の「**厳密に長いときだけ置換**」は**変えていない**。
同じ長さの訂正と tail 欠損を区別できる証拠を本 Issue では定義していないため、
「文字列が違えば上書き」は導入しない。窓が滑った・切り詰められた本文で完全な返答を潰す方が、
凍結より悪い（#2438 の判断を踏襲）。

---

## 4. relay と push の発火経路（コードで列挙）

### 4.1 relay

| # | 発火点 | 引数 | 本 Issue での扱い |
|---|---|---|---|
| 1 | `src/lib/polling/structured-history-gate.ts` `captureStructuredHistoryTurn` | `settled=true` | **`completion === 'settled'` かつ `completionKey` が未通知のときだけ**。provisional では呼ばない |
| 2 | `src/lib/polling/response-checker.ts`（scrape を hold した枝） | `settled=false` | 変更なし。capture が `true` を返した turn ではこの枝に入らない |
| 3 | `src/lib/polling/response-checker.ts`（scrape を保存した枝） | `settled=false` | 変更なし |
| 4 | `src/lib/relay/relay-triggers.ts` `onRelayPromptWaiting` | — | ダイアログ待ちの通知。返答の配送ではない |
| 5 | `src/lib/relay/relay-triggers.ts` 保守 tick | — | 期限切れの掃除と再送。新規の配送を作らない |

その先: `notifyRelayTurnCompleted` → `settled=true` なら `stashReplyForOpenRelays` 即時、
`settled=false` かつ転写を持つツールなら `deliverWhenTranscriptCatchesUp`（`RELAY_TURN_ROW_GRACE_MS` の猶予）。
`stashRelayPayload` は `pending_kind IS NULL` で守られているので、同じ relay に 2 通は入らない。
**暫定保存だけでは 1〜3 のどれも `settled=true` を出さない。**

### 4.2 push

完了 push の生産者は 1 箇所しかない:

- `src/lib/polling/response-checker.ts` の `notifyPushSubscribers({ kind: 'completion', … })`。
  poller が running → idle を判定した枝にあり、**転写リーダーが何を書いたかには依存しない**。

`src/lib/hooks/sources/antigravity/**` と `src/lib/polling/structured-history-gate.ts` は
`@/lib/push` を静的にも動的にも import していない。テストは gate 経由の capture（provisional / settled 両方）で
`notifyPushSubscribers` が 0 回であることを固定している。

### 4.3 `message_updated` と外部配送を分けて検証する

- `broadcastMessage('message_updated', …)` は **同じ worktree を見ているブラウザへの表示更新**であり、
  行の `id` / `request_id` / `timestamp` / instance / `archived` を保ったまま `content` だけを差し替える
  (`updateMessageContent` は `content`（と明示された任意項目）以外の列に触れない)。
- 外部への完了通知／返信配送は §4.1 / §4.2 の経路だけである。
- テストはこの 2 つを別々に数える: 更新は `broadcastMessage` の呼び出しで、配送は
  stub した `onRelayTurnCompleted` / `notifyPushSubscribers` の呼び出しで。

---

## 5. 実装の所在

| ファイル | 追加・変更 |
|---|---|
| `src/lib/hooks/sources/antigravity/transcript.ts` | `antigravityTurnLastRecordAt`、`AntigravityTurnCompletion*`、`resolveAntigravityTurnCompletion`（純関数） |
| `src/lib/hooks/sources/antigravity/history.ts` | `resolveAntigravityStopAt`、追跡リスト（`ANTIGRAVITY_UNSETTLED_TURN_LIMIT`、`resetAntigravityUnsettledTurns`）、`selectAntigravityRecheckCandidates`、`reportAntigravityCompletion` |
| `src/lib/polling/structured-history-gate.ts` | `StructuredHistoryTurnCompletion`、report の `completion` / `completionKey` / `completionReason`、通知の門番と 1 回化 |

`src/lib/hooks/sources/antigravity/source.ts` は変更していない。`Stop` の受信経路
（`agent-event-service` → `stop-history-capture`）も変更していない。他 CLI の完了条件、
履歴 schema、DB API、配送 API はいずれも変更していない。

### 5.1 後方互換

`StructuredHistoryCaptureReport.completion` が**未設定なら `settled`**。
claude / codex / command-code はそれぞれターンを閉じるレコードを持つので、行が書けたこと自体が
完了の証拠であり、この 3 つの挙動は #2377 のままである（テストで固定）。
`completionKey` を出さない reader は毎 capture で通知される点も従来どおり。

---

## 6. テストと対照

`tests/unit/hooks/sources/antigravity-turn-completion-2443.test.ts`（reader）、
`tests/unit/lib/polling/structured-history-gate-completion-2443.test.ts`（gate、実 reader を通す）、
fixture は `tests/fixtures/antigravity-turn-completion-2443/`（**合成データ**。由来はその README）。

各ゲートを無効化した対照でテストが落ちることを確認済み:

| 無効化した箇所 | 落ちたテスト |
|---|---|
| `resolveAntigravityTurnCompletion` の `no-stop-event` / `stop-before-last-record` 分岐 | 17 件 |
| `selectAntigravityRecheckCandidates` の追跡リスト側 | 3 件 |
| gate の `completion === 'settled'` 条件 | 4 件 |
| gate の通知 1 回化（`claimCompletionAnnouncement`） | 1 件 |

評価用コーパスについて: 本 PR に同梱したのは合成 fixture のみで、起票時に報告された
私有環境の 113 turn は本リポジトリに無く、再測定もしていない。したがって
「早期確定/最終見落としの件数と分母」を報告できる実データは無い。合成ケースの一覧と由来は
fixture の README にある。
