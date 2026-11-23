# 送信の結果を sent／not_sent（証明つき）／unknown の 3 値にする（Issue #4535）設計

- 段: 段 1（設計 1 枚。この文書だけ）。src・tests は書かない。段 2 で、試験を先に書き（直す前の赤を確かめる）、その後に実装する
- 版: 第 1 版（2026-11-24）
- 基準: develop `d4f4624cd`。行番号はこの版のもの。Issue の行番号（`192f9dca1`）は §1 で今の位置に直した
- 正: Issue #4535 の本文（R1〜R5・不変条件 I1〜I5・受入条件・範囲の外）と、2026-11-21 のコメント 3 つ（親の決定、#4503 PR-B1 の資産、S9 受け入れの R1〔新しいタスクのダイアログ〕・K1・K2）。この文書は本文の意味を狭めない
- 境: #4534 の設計 `send-fence-4534.md`（第 3 版）と v2 `send-fence-4534-v2.md` §3.2〜3.4・§8.2。#4534 PR-B（`b5d0ac4f1`）で入った 409 `SEND_TARGET_CHANGED`・exit 34（`not_sent` のときだけ）・`sendOutcome`
- 材料: s9 の `review-4518-4492-codex-r2.md`（A4・N2）・`review-4518-v3-codex.md`（3・5）・`review-4466-exact-diff-codex.md`（3・4・5）・`worker-return-4518-stage1.txt`・`accept-result-claude-2.md`
- 書き方: 「事実」は file:line で確かめたこと。「見立て」は推し量り。この文書の試験の番号は `T1`〜。S9 受け入れの R1 は、Issue 本文の R1（OpenCode）と区別して **N1**（新しいタスク）と書く

---

## 0. 結論

1. **3 値の正は「この要求の応答に、サーバーが型で書いた `sendOutcome`」**。`not_sent` と読めるのは §2.2 の証明の一覧に当たるときだけ。それ以外の失敗（素の 4xx/3xx/5xx の頁・非 JSON・空の 2xx・切断・形の合わない成功）は `unknown`
2. CLI は「送信の事実」と「後始末の権限」を分ける。`knownNotSent` 1 つで決めていた取り下げ・note の close・Auto-Yes の取り下げを、事実（3 値）と「この要求が relay・note を持つか」の 2 つで決める（R2・R3・R4）
3. 証明を失わないために、サーバーは**実行前のどの拒否にも `sendOutcome: "not_sent"` を付ける**（今は 404・400・relay の予約の拒否・ask の 409 に付かない）。付けないと I1 を入れた途端に I5（証明つきの拒否は今と同じ）が崩れる
4. OpenCode の送信器は `unknown` の後に何もしない（キーボードも 2 回目の HTTP も 0）。送信は `indeterminate` で終わり、route は `sendOutcome: unknown` を返す（R1）
5. relay の後始末の失敗は送信の事実を書き換えない。route は事実を `sendOutcome` に、後始末の成否を別の欄に返す（R5・I4）
6. 画面は新しいタスクのダイアログ（N1）を範囲に入れる。K1（打ち直し）・K2（再読み込みで消える）は範囲の外を勧める（§7）
7. **公開の契約が変わる所は §4 に並べた。人の答え待ち。** exit が変わるのは 2 か所（空の 2xx・OpenCode の unknown の後の fallback が成功していた場合）で、どちらも「今は exit 0 で『送れた』と言うが、送れたか分からない」場合

---

## 1. R1〜R5 と S9 の N1・K1・K2 の確かめ直し（develop `d4f4624cd`）

### 1.1 表

| # | 事実（file:line） | 見立て | この Issue で扱うか |
|---|---|---|---|
| R1 | `opencode.ts:700–714` `trySendViaServer` は `dispatchViaServer` の `unknown` を `trace.unknown` に残して false を返す。`sendMessageAfterDispatch`（`:907–975`）は false を受けて `waitForPrompt` → `sendMessageWithSubmitVerification` でキーボードに打つ（`:941–955`）。添付の送信 `sendMessageWithImage`（`:1108–1134`）は添付の dispatch が false だと `sendMessageAfterDispatch` を呼び、その中の `trySendViaServer`（`:939`）で **2 回目の HTTP dispatch** をする。`unknown` になるのは: POST の応答なし・204 以外の非 HTML の 2xx（`hooks/sources/opencode/client.ts:603–610`）、読み戻しの `mismatch`・梯子の尽き（`opencode.ts:808–816`）、dispatch の後の例外（`:839`）。#4040 の `keepUnknownDispatch`（`:987–998`）は「キーが打てなかった」ときの分類だけを直し、**打てたときは打つ** | 届いていれば二重送信。試験 `send-readiness-4040.test.ts:419`（`dispatch` を 2 回呼ぶ）と `opencode-send-api-2035.test.ts:276`（読み戻しの不一致でキーボードに打つ）が今の動きを固定している | 扱う |
| R1'（同根） | `client.ts:611–612` は 204・非 HTML の 2xx 以外を全部 `rejected` → `not_sent`（`opencode.ts:802`）。5xx と 3xx もここに入る | OpenCode の HTTP は loopback で、間にプロキシは無い。4xx と SPA の `200 text/html`（#1931 の実測）は「受け付けていない」と言えるが、5xx は「作った後に落ちた」を否定できない | 扱う（§2.3・未決 Q5） |
| R2 | `send-messages.ts:32–40` `knownNotSent` は `outcome !== null` なら `outcome !== 'unknown'`（`:35`）。`resolveBoundSendOutcome` は 409 `RELAY_BIND_CONFLICT` を `'conflict'` にする（`message-dispatch.ts:133`）ので、`knownNotSent` は true。`send.ts:489` が note を閉じ、`:487` が Auto-Yes を取り下げる。relay は取り下げない（`message-dispatch.ts:207` は `null`・`not_sent` だけ） | `RELAY_BIND_CONFLICT` は予約の前（`route.ts:295–301`、`relay-bind-db.ts:329–358`）の拒否で、**この要求は何も打っていない**（事実は `not_sent`）。ただし relay はこの要求の物ではない（別の試行が持つ・既に閉じた・期限切れ）。note の close は relay の物なので、この要求が決めてはいけない。Auto-Yes はこの送信が立てたもので取り下げてよい | 扱う |
| R3 | `api-client.ts:355–399` `sendWithBody`: 非 2xx は `readErrorPayload`（`:410–423`）で JSON でなければ `payload` なし。空の 2xx は `undefined` を返す（`:385–386`）。非 JSON の 2xx は `JSON.parse` の例外 → 状態コードの無い `ApiError`（`:393–395`）。`postMessage`（`message-dispatch.ts:192–194`）は戻り値の形を見ない。`resolveBoundSendOutcome` は `sendOutcome` の無い 4xx を `not_sent`（`:136`）、`knownNotSent` も 4xx を true（`send-messages.ts:39`）。結び付かない relay（旧サーバー）は失敗なら必ず取り下げる（`:207` の `outcome === null`） | 素の 408 の HTML・プロキシの 413・認証の前段の 401 は、ハンドラーが動いたかどうかを言わない。空の 2xx は今 `Message sent.`・exit 0（`send.ts:506`）で、**「送れた」と言ってしまう**（Issue の「未送信と読む」より強い誤り）。非 JSON の 2xx は状態コードが無いので、結び付いた relay では照会に回る（`GET relay` が `sent`／`failed` なら正しい） | 扱う |
| R4 | `fetch` は既定で redirect を追う（`api-client.ts:365–370` は `redirect` を指定しない）。301/302/303 は GET に変えて追い、**307/308 は同じ本文で POST し直す**。404 は exit 99、`resolveBoundSendOutcome` では `not_sent` | 307/308 は CLI の中の 2 回目の POST（I2 に触れる）。404/405 は「古いサーバー」の印にも使えるが、POST の後では実行前の証明にならない（codex 4） | 扱う |
| R5 | `RelaySendBinding.finish`（`relay-bind.ts:307–319`）は `settle` の例外を握り、失敗の試行なら `unknown` を返す（`:318`）。`settleRelaySendState` の更新 0（元の状態・試行 ID が合わない）は見ない。route は `finish` の戻り値をそのまま `sendOutcome` にする（`route.ts:138–144`）。CLI の `cancelRelayQuietly`（`relays.ts:258–270`）・`closeSendNote`（`send-messages.ts:99–107`）の失敗は警告だけ。note の `closeWhen: relay:<id>` は relay の `cancelled` で `met/failure`（`condition-evaluators.ts:68–84`） | 証明つきの `not_sent` が、relay の台帳の書き込み失敗で `unknown` に落ちる（安全側だが事実ではない）。逆に CLI の取り下げが失敗しても、送信の事実の行は出ない（混ざらないが、分けて言ってもいない） | 扱う |
| N1（S9 R1） | `send-new-task.ts:119–140` `interpretSendResponse` は `sendOutcome` を読まない。500 は `failed`（文 `locales/ja/common.json:399`「送信に失敗しました。接続を確かめて送り直してください。」）。`NewTaskDialog.tsx:283–285` は失敗を出して［送る］を残し、押せば確認なしに同じ本文を送る。409 `SEND_TARGET_CHANGED` の `unknown` も `conflict`（「セッションが依頼を受け付けませんでした。」）になる | 「届いたか分からない」を「失敗・送り直せ」と言い、再送を勧める。I2 の画面の層 | 扱う（§3.4） |
| K1 | PC・タイルの入力欄は `unknown` の後に下書きを残さない（S9 の実測） | 打ち直しの検出は本文の比較か冪等の鍵が要る。この Issue の範囲の外（冪等の鍵）に寄る | 範囲の外を勧める（Q7） |
| K2 | 再読み込みで楽観の行（`unknown` の行）が消える（S9 の実測） | 画面の記録はクライアントの状態だけ。サーバーの `lastSend` は残るが行ではない | 範囲の外を勧める（Q8） |

### 1.2 Issue の行番号の直し（`192f9dca1` → `d4f4624cd`）

| Issue | 今 |
|---|---|
| `opencode.ts:699–711・778–789・919–941` | `:700–714`（`trySendViaServer`）・`:796–816`（dispatch と読み戻しの判定）・`:907–975`（`sendMessageAfterDispatch`）。添付は `:1108–1134` |
| `send.ts:629–637` | #4128 の分割の後: `send-messages.ts:32–40`（`knownNotSent`）と `send.ts:483–503`（`onFailure`） |
| `message-dispatch.ts:127–145・182–211` | `:127–146`・`:182–244` |
| `api-client.ts:384–395` | `:355–399`（`sendWithBody`）、`:410–423`（`readErrorPayload`） |
| `relay-bind.ts:269–286・346–349` | `:274–298`（`onDispatchFailed`）・`:307–319`（`finish`）・`:378–392`（`nothingTyped`） |
| `relay-db.ts:370–383` | 同じ（`cancelRelay`） |
| `condition-evaluators.ts:69–84` | `:68–84`（`decideRelay`） |

### 1.3 Issue に無かった事実（この設計で拾ったもの）

- **F-a** ask の冪等の答え: `planAskForSend` は同じ ask ID の再送に 200 `{ ask: { id, state, reason, sendState } }` を返す（`lib/ask/ask-send.ts:69–75`、`route.ts:291`）。ChatMessage の形ではない。§2.2 の「成功の形」の検査はこれを `unknown` にしてはいけない（`sendState` で読む）
- **F-b** `relayWithdrawn`（#4498、`route.ts:144–151`）は「後始末の成否を別の欄で返す」形の先例。§3.3 はこの形に合わせる
- **F-c** 画面の `isSendOutcomeUnknown`（`usePendingMessages.ts:128–143`）は `sendOutcome` の無い 4xx を「未送信（直に再試行してよい）」と読む。CLI の R3 と同じ形の写し
- **F-d** OpenCode の dispatch が `not_sent` の後のキーボードは、1 回の送信の中の「確実な未送信の後の別経路」で、I2 の外（`unknown` からの切り替えではない）。今のまま残す

---

## 2. 3 値の定義と not_sent の証明

### 2.1 定義

| 値 | 意味 | 言える条件 |
|---|---|---|
| `sent` | 本文が宛先に入った | サーバーが成功を型で返した（§2.2 の S 行） |
| `not_sent` | 本文のキーも dispatch も 1 つも始まっていない、と**この要求のサーバーが証明した** | §2.2 の N 行のどれか |
| `unknown` | 上の 2 つのどちらとも言えない | それ以外すべて。応答の破損・切断・素の 4xx/5xx の頁・非 JSON・空の 2xx・3xx・404/405 だけ・形の合わない成功 |

サーバーの試行の state（`lastSend.state`）との対応は今のまま: `sent`↔`sent`、`not-sent`↔`not_sent`、`indeterminate`↔`unknown`（v2 §3.2 と同じ）。

### 2.2 証明の一覧（CLI・画面が読む規則）

前提: どの行も「**この要求の応答の本文**」（JSON、`content-type` が JSON、オブジェクト）で判定する。プロキシは型の付いた `sendOutcome` を作らない、と見る（作るなら何も証明できない。範囲の外）。

| # | 応答 | 判定 | 今 |
|---|---|---|---|
| S1 | 2xx・JSON・ChatMessage の形（`id` が文字列、`role: 'user'`）で、`sendOutcome` が無いか `sent` | `sent` | `sent`（形を見ない） |
| S2 | 2xx・JSON・`sendOutcome: 'unknown'`（OpenCode の 201 など） | `unknown` | 同じ（`message-dispatch.ts:193`） |
| S3 | 200・JSON・`ask.sendState`（F-a）。`sent` → `sent`、`failed` → `not_sent`、それ以外 → `unknown` | 左のとおり | 形を見ずに成功 |
| S4 | 2xx で上に当たらない（空・非 JSON・JSON だが形が違う） | `unknown` | 空は `sent`、非 JSON は状態の無い失敗 |
| N1 | 非 2xx・JSON・`sendOutcome: 'not_sent'` | `not_sent` | 同じ |
| N2 | 409・JSON・`code: SEND_TARGET_CHANGED`・`sendOutcome: 'not_sent'`（#4534） | `not_sent`（exit 34） | 同じ |
| N3 | 409・JSON・`code: TOOL_POLICY_DENIED`（`sendOutcome: 'not_sent'` 付き、#4437） | `not_sent`（exit 33） | 同じ（`isToolPolicyDenied` が先に true） |
| N4 | 409・JSON・`code: RELAY_BIND_CONFLICT` | 送信は `not_sent`。**relay・note の後始末の権限は無い**（§3.1） | `conflict`（note を閉じる） |
| N5 | 非 2xx・JSON・`code` が §2.4 の「実行前の拒否の code」（`sendOutcome` 無し＝旧サーバー） | `not_sent`（旧サーバーとの互換。未決 Q2） | 4xx なら `not_sent`、5xx なら照会 |
| U1 | 非 2xx・JSON・`sendOutcome: 'unknown'` または `'sent'`（失敗の答えで `sent` は「打った」） | `unknown`（`sent` の失敗は画面と同じく直の再送をしない） | 同じ |
| U2 | 非 2xx で N・U1 に当たらない（素の頁、`code` の無い JSON、知らない `code`、404/405、3xx） | `unknown` | 4xx は `not_sent`、5xx は照会 |
| U3 | 応答なし（切断・時間切れ・JSON の破損） | `unknown` | 同じ（結び付いた relay は照会） |

結び付いた relay の照会（`GET /api/relays/:id`、`message-dispatch.ts:138–145`）は今のまま残す: U2・U3・S4 のとき、`sendState` が `sent` なら `sent`、`failed` なら `not_sent`、それ以外は `unknown`。照会の `failed` は**当該の試行**の記録か、を段 2 で確かめる（`attemptId` を答えに出していない。未決 Q3）。

### 2.3 OpenCode の dispatch の 3 値（送信器の中）

| 結果 | 判定 | 今 |
|---|---|---|
| 204 → 読み戻し `found` | `delivered` | 同じ |
| 204 → 読み戻し `missing`（404） | `not_sent`（OpenCode 自身が「その ID の message は無い」と言う。#2035 の実測で、受け付けた後に捨てた） | 同じ |
| 204 → `mismatch`・梯子の尽き | `unknown` | 同じ（ただし fallback する） |
| 4xx・`200 text/html`（SPA の殻） | `not_sent` | 同じ |
| 5xx・3xx | **`unknown`**（勧め。未決 Q5） | `not_sent` |
| 204 以外の非 HTML の 2xx・応答なし・dispatch の後の例外 | `unknown` | 同じ |

### 2.4 実行前の拒否の code（N5 の一覧の候補）

`/send` の route が試行の記録の前に返す拒否（`route.ts:262–301`）:

| 応答 | code | 今の `sendOutcome` |
|---|---|---|
| 404 worktree 無し（`route.ts:264–267`） | 無し | 無し |
| 400 本文の読み・検査（`readJsonObjectBody`、`send-request.ts:209–235`） | 一部だけ（`ASK_FIELD_INVALID` などは文だけ） | 無し |
| 400 task の宛先（`task-target.ts:45`） | 有り | `not_sent`（先例） |
| 409 `ASK_ID_CONFLICT`（`ask-send.ts:62–67`） | 有り | 無し |
| 400 `RELAY_BIND_INVALID`・409 `RELAY_BIND_CONFLICT`・500 `RELAY_BIND_FAILED`（`send-relay.ts:116・128`） | 有り | 無し |

§3.2 の C4 で、これら全部に `sendOutcome: 'not_sent'` を付ける。付けた後は N1 で読め、N5 は旧サーバーのためだけに残る。

### 2.5 #4534 の 409 `SEND_TARGET_CHANGED` との整合

- `not_sent`／`unknown` は柵の試行の state（`inputStarted`・`dispatchUnknown`）から付く（v2 §3.2）。この設計の 3 値と同じ語で、読み替えは無い
- exit は #4534 のまま: `not_sent` は 34、`unknown` は 99。この Issue は 34・99 を変えない
- `SEND_TARGET_CHANGED` に `sendOutcome` が無い・知らない値なら、今の `sendTargetChangedResult`（`api-client-errors.ts:104–112`）どおり 99 で、§2.2 では U2 → `unknown`。整合する
- 画面: 新しいタスクのダイアログは今これを `conflict` と読む（N1）。§3.4 で `sendOutcome` で分ける

---

## 3. 層ごとの規則

### 3.1 CLI（`send`・`ask`。`postMessage` を通る 2 つ）

`postMessage` は 1 つの関数 `classifySendAnswer(error | body) → { fact: 'sent' | 'not_sent' | 'unknown', relayOwned: boolean }` で §2.2 を読む（今の `resolveBoundSendOutcome` と `knownNotSent` と `describeFailedSendOutcome` の 3 か所の読みを 1 つにする）。`relayOwned` は「relay がこの要求の試行として予約された」で、N4 だけ false。

| 後始末 | 条件（新） | 今 |
|---|---|---|
| relay の取り下げ（`cancelRelayQuietly`） | `fact === 'not_sent' && relayOwned` | `null`（結び付かない relay）・`not_sent` |
| note の close（`closeSendNote`） | `fact === 'not_sent' && relayOwned` | `knownNotSent`（`conflict` も真） |
| Auto-Yes の取り下げ（`withdrawArmedAutoYes`） | `fact === 'not_sent'`（relay と関係ない。この送信が立てたもの） | `knownNotSent` |
| 契約の task の failed（`failTask`） | 今のまま（失敗なら必ず。task は「送信が終わった」ではなく「この CLI の失敗」） | 同じ |
| 結び付かない relay（旧サーバー、`bound: false`） | `fact === 'not_sent'` のときだけ取り下げ（今は失敗なら必ず） | 必ず |

- **再送しない**: どの値でも `postMessage` は POST を 1 回だけ打つ。`sendWithBody` の `/send` は `redirect: 'manual'` にする（R4。3xx は U2 → `unknown`）
- **exit**: `not_sent` と `unknown` の exit は今の `handleApiError` の値のまま（§4 の C3 で一覧）。変えるのは「空の 2xx・形の合わない 2xx」（今 0、案で 99。§4 C1）だけ
- **stderr**: `unknown` のとき、今の `describeFailedSendOutcome` の unknown の文を、`sendOutcome` の無い失敗にも出す（今は `sendOutcome` の無い失敗には何も出さない。§4 C5）
- `ask` も同じ関数を通る。`ask` は note を持たない。`ask --async` の relay は上の表のとおり

### 3.2 送信器（OpenCode）

- `trySendViaServer` が `unknown` を返したら、`sendMessageAfterDispatch` はキーボードに進まず、`keepUnknownDispatch` と同じ形の誤り（`indeterminate`、reason は §4 C7）で終える。添付の送信は、添付の dispatch が `unknown` なら path の fallback（2 回目の HTTP を含む）を呼ばない
- `not_sent`・`skipped` の後のキーボード（F-d）は今のまま。2 回目の HTTP（添付 → path）も、1 回目が `not_sent` のときだけ許す。その前に #4534 の柵が宛先を照合し直す（`fenceConfirmDispatch`、今のまま）
- 5xx・3xx を `unknown` にする（§2.3、未決 Q5）
- `RelaySendBinding.onDispatchFailed`（`relay-bind.ts:274–298`）は今のまま: `unknown` の後は `retryDispatchOpen` を閉じる。fallback を止めるので、`settle` の「後の dispatch が届いた」枝（`:323–339`）は通らなくなる。枝は消さない（binding はどの送信器にも共通。`noteDispatchStart()` の呼び手は今 `opencode.ts` だけ、`git grep` で確かめた）
- 他の送信器: copilot・codex・claude・agy は HTTP の dispatch を持たない（`noteDispatchStart()` の呼び手は `opencode.ts` だけ）。agy の読み戻しは #4503 PR-B1

### 3.3 サーバー（route・relay・mem の後始末）

- **C4**: §2.4 の実行前の拒否に `sendOutcome: 'not_sent'` を付ける。試行の記録（`lastSend`）は付けない（今「記録の残らない 400 の拒否」と文書が言う。`cli-operations-guide.md:1346`。記録を足すと `lastSend` の意味が変わる）。route の一番外の `catch`（`route.ts:632–637`、500 `Failed to send message`）は、試行の記録があればそれ、無ければ何も付けない（`unknown`）
- **I4（R5）**: `RelaySendBinding.finish` は `{ outcome, settled }` を返す。`outcome` は試行の事実（`relay.sent`・`relay.attempt` から決まる）で、`settle` の例外・更新 0 で変えない。`settled: false` のとき route は `relaySettled: false` を足す（`true` のときは足さない。今の答えとバイト単位で同じ）。後始末を失った relay は `awaiting`／`input_started` のまま残り、満期か利用者の `relays --cancel` で閉じる
  - 例外: `not_sent` の事実で台帳を `failed` にできなかった relay を、CLI は今どおり取り下げる（`cancelRelay` は開いた状態なら閉じる）。だから CLI の後始末は「サーバーの後始末の失敗」の救いにもなる
- mem: note の close は CLI の `closeSendNote`（`not_sent && relayOwned`）と、relay の終端の条件（`decideRelay`）の 2 つのまま。`unknown` では CLI は閉じず、relay が `delivered`／`expired`／`cancelled` で閉じる（今のまま。R2 の直しだけ）
- relay の配送（`relay-delivery.ts` の `settleUnsentResult`・`holdUncertain`）は、返答を依頼主の composer へ入れる別の送信。今すでに `indeterminate` を `holdUncertain` にしている（v2 §3.2）。この Issue では触らない（§6）

### 3.4 画面

範囲（勧め）:

| 面 | この Issue | 理由 |
|---|---|---|
| 新しいタスクのダイアログ（`send-new-task.ts`・`NewTaskDialog*.tsx`） | **扱う**（N1） | #4503 PR-B2 の範囲の外だった。同じ根 |
| `isSendOutcomeUnknown`（`usePendingMessages.ts:128–143`。worktree 詳細・タイル・履歴・スマホが使う） | **規則だけ合わせる**（F-c: `sendOutcome` の無い 4xx を `unknown`、ただし C4 の後は route の 4xx は全部 `not_sent` を持つ） | 1 関数の変更。再試行の UI（`confirmedResend`）は #4503 PR-B2 のまま |
| 画面の再試行の古い応答（#4417）・冪等の鍵（#4503 PR-B3） | 扱わない | 範囲の外（Issue 本文） |
| K1・K2 | 扱わない（勧め） | §7 Q7・Q8 |

ダイアログの規則: `interpretSendResponse` は §2.2 で読み、`unknown` のとき新しい kind `unknown` を返す。ダイアログは `unknown` で［送る］をそのまま押せる形にしない。案: 文「届いたかどうか分かりません。送り直す前に、送り先の画面で確かめてください。」と［送り先を開く］を出し、［送る］は確認（「同じ依頼をもう一度送ります。二重に届くことがあります」）の後だけ送る。`not_sent` は今の文と動きのまま。

---

## 4. 公開の契約を足す・変える所（**人の答え待ち**）

| # | 所 | 今 | 案 | 変えない案との比べ |
|---|---|---|---|---|
| C1 | CLI `send`・`ask` の **2xx の形の検査**（S3・S4） | 空の 2xx: `Message sent.`・exit 0。非 JSON の 2xx: `Unexpected …`・exit 99（状態の無い失敗）。形の違う JSON: exit 0 | 3 つとも `unknown`: stderr に `Error: the server's answer did not say whether the message was sent` と unknown の注意、**exit 99**、relay・note はそのまま | 変えない案: 空の 2xx を exit 0 のまま。**今の `/send` は空の 2xx を返さない**（201 か 200 `ask`）ので、空の 2xx はプロキシか壊れたサーバー。exit 0 は「送れた」の約束で、監督のエージェントが成果を待ち続ける。案を勧める |
| C2 | CLI の `/send` の POST の redirect | 追う（307/308 は同じ本文を再 POST） | `redirect: 'manual'`。3xx は `unknown`・exit 99 | 変えない案は I2 に反する（二重の POST）。案を勧める |
| C3 | CLI の **exit**（`not_sent`／`unknown`） | `handleApiError` の値（400→2、401/403→2、404→99、409→99／31／33／34、429→1、5xx→99） | **変えない**。3 値は stderr と後始末に出し、exit は今の状態コードの写しのまま | 代わりの案: `unknown` に新しい exit（例 35）。#4534 が「`unknown` は 99」と文書に書いたばかり（`cli-operations-guide.md:437・1227`）で、2 回変えないため勧めない |
| C4 | `POST /api/worktrees/:id/send` の実行前の拒否（§2.4） | `sendOutcome` 無し | `sendOutcome: 'not_sent'` を足す（足すだけ。status・code・文は今のまま） | 足さない案: I1 を入れると CLI はこれらを `unknown` と読み、relay・note・Auto-Yes を残す（I5 に反する）。足す案を勧める。旧サーバー（足す前）との組は N5 の code の一覧で救う（未決 Q2） |
| C5 | CLI の stderr | `sendOutcome` の無い失敗には再送の注意を出さない（`relay-bind-cli-3957.test.ts:309・338` が固定） | `unknown` と読んだ失敗には unknown の注意（`check the pane first …`）を出す | **既存の試験 2 本の期待が変わる**（§5.3）。変えない案: 注意を出さず、後始末だけ変える。利用者が「送り直してよいか」を知る手が無くなるので、案を勧める |
| C6 | route の答えの `relaySettled`（I4） | 無し（`finish` の失敗で `sendOutcome` が `unknown` に落ちる） | `relaySettled: false` を足す（`true` のときは足さない）。`sendOutcome` は事実のまま | 変えない案: 台帳の書き込みが失敗した `not_sent` が `unknown` になり、CLI が relay を残す（安全側）。I4 の受入条件に反する |
| C7 | `prompt --json` の `lastSend.reason` | OpenCode の unknown の後にキーが打てなかったときは、その拒否の reason（`prompt-not-ready` ほか）で `indeterminate` | 新しい reason `dispatch-unknown`（`indeterminate`）。fallback を打たないので、どの場合もこれ | 代わりの案: `send-error` に寄せる。理由が読めなくなるので勧めない |
| C8 | OpenCode の送信の結果（R1） | `unknown` の後のキーボードが成功すると 201・exit 0 | 500（`indeterminate`・`sendOutcome: unknown`）・**exit 99** | 変えない案は I2 に反する。exit が 0 → 99 に変わる唯一の送信器の場合。勧めは案 |
| C9 | 画面の新しいタスクのダイアログ（N1） | `failed` の文と、確認なしの［送る］ | §3.4 の文と確認。ロケールの鍵 `newTask.errors.unknown` を ja・en に足す | 変えない案は I2（画面の層）に反する |
| C10 | `isSendOutcomeUnknown`（F-c） | `sendOutcome` の無い 4xx は「未送信」 | `unknown`（ただし `SEND_REFUSED_BEFORE_INPUT_CODES` と C4 の後の `not_sent` は今のまま） | C4 の後は route 由来の 4xx がほぼ全部 `not_sent` を持つので、変わるのは認証の前段・プロキシの 4xx だけ |
| C11 | 文書 | — | `docs/user-guide/cli-operations-guide.md`（`:765–768` の relay の段落、`:1346` の `sendOutcome` の段落、終了コードの表は変えない）と英語版、`src/cli/docs/agent-operations.ts`、`send --help`（`send.ts:240–250`） | — |

変えないもの: #4534 の 409 `SEND_TARGET_CHANGED` と exit 34、#4437 の exit 33、`PROMPT_WAITING`（exit 2）、ロールの 409（exit 31・32）、`lastSend` の state の 3 値、`relayWithdrawn`（#4498）。

---

## 5. 不変条件と、試験を先に書く順

### 5.1 不変条件（Issue の I1〜I5 に足すもの）

- **I6 1 回の CLI の送信は `/send` の POST を高々 1 回**（redirect を含む）。偽のサーバーで POST の回数を数える
- **I7 証明は要求ごと**: `not_sent` の判定は、その要求の応答の本文だけから。前の要求・別の試行の応答・`lastSend`（「最後に終わった送信」ではない、`cli-operations-guide.md:1339`）からは言わない。結び付いた relay の照会の `failed` は当該の試行のもの（未決 Q3）
- **I8 後始末の権限**: relay の取り下げと note の close は、この要求が予約した relay に限る（N4 では 0）
- **I9 並行**: 別の CLI が同じ relay を予約している間に、この CLI の `RELAY_BIND_CONFLICT` が他方の relay・note を変えない。削除: 送信の途中で worktree が消えたら #4534 の `worktree-gone` の答え（`not_sent`／`unknown`）のまま

### 5.2 試験の一覧（段 2 で先に書く。直す前の赤の形）

偽のサーバーは `os.tmpdir()` の下の一時 HOME と、ポート 0 の `http.createServer`（または既存の `mockRoutes` の形）で立て、本番 3000 に触れない。OpenCode は偽の `prompt_async`。

| # | 受入条件 | 試験（ファイル・名前の案） | 直す前の赤 |
|---|---|---|---|
| T1 | R1 | `tests/unit/cli-tools/opencode-unknown-no-fallback-4535.test.ts` `R1: the first dispatch drops before the answer — no second HTTP, no keys` | `keys` が 1 回以上（`sendMessageWithSubmitVerification` が呼ばれる） |
| T2 | R1（添付） | 同 `R1: an image dispatch unknown — the path fallback is not dispatched` | `dispatch` が 2 回 |
| T3 | R1（読み戻し） | 同 `R1: a read-back mismatch — nothing typed, indeterminate` | `submitMock` が 1 回 |
| T4 | R1 の対照 | 同 `control: a refused POST (4xx) still falls back to the keyboard`・`control: a missing read-back still falls back` | 緑のまま（陰性対照） |
| T5 | R1'（Q5） | 同 `a 5xx answer is unknown — no keys` | `keys` が 1 回以上 |
| T6 | 変異 | T1〜T3 は、fallback を戻す変更（`sendMessageAfterDispatch` の `unknown` の early return を消す）で赤になることを段 2 の記録に残す | — |
| T7 | R2 | `tests/unit/cli/commands/send-outcome-4535.test.ts` `R2: RELAY_BIND_CONFLICT — the note stays open and the relay is not withdrawn` | note の close の POST が 1 回 |
| T8 | R2 の対照 | 同 `control: RELAY_BIND_CONFLICT still withdraws this send's Auto-Yes grant` | 緑のまま |
| T9 | R3・R4 | 同 `R3/R4: <case> is unknown — no withdraw, no close, no resend`（case: 素の 408 の HTML・非 JSON の 200・空の 204・空の 200・形の違う JSON の 200・302・307・404 の HTML・405）。各々 POST の回数 1、cancel 0、close 0、stderr に unknown の注意 | 408・404・405 で cancel と close が 1。空の 2xx で exit 0。307 で POST 2 回 |
| T10 | 実の `--note --reply-to` | `tests/integration/send-note-unknown-4535.test.ts` `the message lands, the answer is lost — the waiting note stays open`（一時 HOME・一時 DB で本物の route と mem を通し、route の応答だけを切る） | 結び付かない relay の場合に note が閉じる（見立て。段 2 で赤を確かめる） |
| T11 | I4 | `tests/unit/lib/relay/relay-bind-settle-4535.test.ts` `a failed settle keeps sent as sent and not_sent as not_sent; relaySettled is false` | `not_sent` が `unknown` になる |
| T12 | 陽性対照（I5） | `send-outcome-4535.test.ts` `control: 409 PROMPT_WAITING with not_sent — withdrawn and closed`・`control: 409 SEND_TARGET_CHANGED not_sent — exit 34, withdrawn` | 緑のまま |
| T13 | C4 | `tests/unit/app/api/worktrees/send-preflight-outcome-4535.test.ts` `every refusal before the attempt carries sendOutcome not_sent`（404・400・`ASK_ID_CONFLICT`・`RELAY_BIND_*`） | `sendOutcome` が undefined |
| T14 | N5（旧サーバー） | `send-outcome-4535.test.ts` `an older server's typed refusal without sendOutcome is not_sent` | 緑（今も 4xx は `not_sent`）。I1 の直しの後も緑であることを守る |
| T15 | N1 | `tests/unit/lib/new-task/send-new-task-outcome-4535.test.ts` `500 sendOutcome unknown is kind unknown`、`tests/unit/components/new-task/NewTaskDialog-unknown-4535.test.tsx` `a second press after unknown asks first and sends once` | kind が `failed`、2 回目の押下で POST |
| T16 | C10 | `tests/unit/hooks/usePendingMessages-unknown-4535.test.tsx` `a proxy 4xx without sendOutcome is unknown` | false |
| T17 | I6 | T9 の 307 と同じ。全ケースで POST の回数を数える | 307 で 2 |

### 5.3 期待が変わる既存の試験（段 2 で変えてよいか、人・PM の判断が要る）

既存の `it` の期待を変える。この設計では変えない。段 2 の契約で許しを明記する（未決 Q6）。

| 試験 | 今の期待 | 案の後 |
|---|---|---|
| `tests/unit/cli-tools/send-readiness-4040.test.ts:419` `positive: an image dispatch unknown, the path fallback refused — the first unknown is kept` | `dispatch` 2 回、`indeterminate` | `dispatch` 1 回、`indeterminate` |
| `tests/unit/cli-tools/opencode-send-api-2035.test.ts:276` `refuses a read-back whose text is not what was sent` | `submitMock` 1 回（キーボードに打つ） | 0 回、`indeterminate` で投げる |
| `opencode-send-api-2035.test.ts:290` `refuses a read-back that is not the user's message` | 同上 | 同上（`mismatch`／梯子の尽きのどちらかを段 2 で確かめる） |
| `tests/unit/cli/commands/relay-bind-cli-3957.test.ts:176` `negative control — a legacy relay is withdrawn on any failure, as before` | 500 でも取り下げる | 500（`unknown`）では取り下げない |
| `relay-bind-cli-3957.test.ts:309・338` `negative control: an error with no sendOutcome … adds neither note` | 注意 0 | unknown の注意 1（C5） |
| `tests/unit/hooks/usePendingMessages-unknown-4503.test.tsx` の 4xx の対照（段 2 で行を特定） | 4xx は not unknown | C10 のとおり |

---

## 6. PR の割り方と境

同じファイルは 1 本にまとめる。

| PR | 中身 | 触るファイル（見込み） | 依存 |
|---|---|---|---|
| **PR-A サーバー** | C4・C6・C7・C8（route の実行前の拒否、`finish` の分離、OpenCode の fallback の停止、5xx の `unknown`） | `src/app/api/worktrees/[id]/send/route.ts`・`send-relay.ts`・`send-request.ts`、`src/lib/ask/ask-send.ts`（答えの本文）、`src/lib/relay/relay-bind.ts`、`src/lib/cli-tools/opencode.ts`、`src/lib/hooks/sources/opencode/client.ts`、`src/lib/session/send-attempt-types.ts`（reason）、試験 T1〜T6・T11・T13、§5.3 の上 3 行、文書の `lastSend` の段落 | なし |
| **PR-B CLI** | C1・C2・C3・C5・§3.1 | `src/cli/commands/message-dispatch.ts`・`send-messages.ts`・`send.ts`・`ask.ts`、`src/cli/utils/api-client.ts`（`/send` の `redirect`）、`src/cli/types/api-responses.ts`（`relaySettled`）、`src/cli/docs/agent-operations.ts`、`docs/user-guide/cli-operations-guide.md` と英語版、試験 T7〜T10・T12・T14・T17、§5.3 の relay-bind-cli の 3 行 | PR-A の C4（なくても N5 で動くが、試験 T12 の route 側は PR-A） |
| **PR-C 画面** | C9・C10 | `src/lib/new-task/send-new-task.ts`、`src/components/new-task/NewTaskDialog.tsx`・`NewTaskDialogParts.tsx`、`src/hooks/usePendingMessages.ts`、`locales/{ja,en}/common.json`、試験 T15・T16 | PR-A と独立 |

PR-A は大きい（route と OpenCode）。大きすぎると判断したら、OpenCode（`opencode.ts`・`client.ts`）を PR-A2 に分けて直列にする（route と OpenCode は別のファイル）。

境:

| 相手 | この Issue | 相手の側 |
|---|---|---|
| #4534（済み） | 3 値の名前と `sendOutcome` の読み。exit 34・99 は変えない | 柵が断った試行の state |
| #4518 | `EXACT_TARGET_MISMATCH` など新しい拒否も §2.2 の N1（`sendOutcome: 'not_sent'`）で返すことを、この規則として渡す | exact の宛先の指定。#4518 は #4535 の後に載る（Issue 本文「#4518 の前提」） |
| #4503 | PR-B1（agy の読み戻しが未送信を送信済みにしない）と対。ここは「届いたかもしれないものを未送信にしない・再送しない」。画面の PR-B2 の `isSendOutcomeUnknown` に C10 を足す。PR-B3（`clientSendId`）は範囲の外 | 資産 `feature/4503-readback-assets`（`c38259e9c`）はこの設計では使わない |
| #4466 | operationKey（冪等）と S4 の一括の確定は範囲の外。§3.3 の `relaySettled` は S4 の「事実と後始末を別々に確定」の小さな先行 | PR3 |
| #4417 | 画面の再試行の古い応答は範囲の外 | — |

---

## 7. 未決（PM・人の判断が要るもの）

| # | 問い | 勧め |
|---|---|---|
| Q1 | §4 の公開の契約（C1〜C10）をこの形で入れるか。特に exit が 0 → 99 に変わる C1（空・形の違う 2xx）と C8（OpenCode の unknown の後の fallback の成功） | 入れる。どちらも「送れたか分からない」を「送れた」と言っている今の誤りの直し |
| Q2 | 旧サーバー（C4 の前）の型つきの拒否を、CLI が code の一覧（N5）で `not_sent` と読むか。読まないなら、旧サーバーとの組で 400・`ASK_ID_CONFLICT`・`RELAY_BIND_*` の後に relay・note が 24 時間残る | 読む。一覧は §2.4 の code に限る（`code` の無い 400・404 は読まない） |
| Q3 | 結び付いた relay の照会（`GET /api/relays/:id`）の `failed` を、当該の試行の記録と言えるか。言えないなら答えに `attemptId` を出す契約が要る | 段 2 の最初に確かめる。今の予約は 1 本の relay に 1 試行（`RELAY_BIND_CONFLICT` で二重の予約を断る）なので、見立てでは言える |
| Q4 | C3: `unknown` に専用の exit を足さず 99 のままにするか | 99 のまま |
| Q5 | OpenCode の 5xx・3xx を `unknown` にするか（今は `not_sent` でキーボードに進む）。`unknown` にすると、OpenCode のサーバーが 5xx を返す間、送信は毎回 `indeterminate` で止まる | `unknown` にする。I1 の字句どおり。loopback でも 5xx は「作った後に落ちた」を否定できない |
| Q6 | §5.3 の既存の試験の期待を段 2 で変えてよいか | 変えてよい（契約に明記する） |
| Q7 | K1: U-0（確認なしに同じ本文を二度送らない）が、利用者の打ち直しまで含むか | 含まない（この Issue では）。打ち直しの検出は冪等の鍵（#4466 PR3・#4503 PR-B3）の範囲。画面の `unknown` の表示で「送れたか分からない」を残すところまでをこの Issue と PR-B2 で行う |
| Q8 | K2: 再読み込みで `unknown` の行が消えるのを、この Issue で直すか | 直さない。サーバーに「画面の送信の記録」を持たせる別の Issue に切る（`lastSend` は「最後に終わった送信」ではないので代わりにならない） |
| Q9 | §3.4 のダイアログの文と、確認の後の再送を許すか（許さず［送り先を開く］だけにする案もある） | 確認の後に許す（PR-B2 の `confirmedResend` と同じ形） |
