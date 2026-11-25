# 送信の結果を sent／not_sent（証明つき）／unknown の 3 値にする（Issue #4535）設計

- 段: 段 2（PR を 4 本、直列。各 PR は試験を先に書き、直す前の赤を確かめてから実装する）。段 1（設計と、公開の値に触らない足場・内部の分類）は済み
- 版: **第 3.2 版**（2026-11-25、§3.4 に柵の 409 の本文を返す規則 INV-V2a〜V2c を足した）。第 1 版は `ce6a3cd62`、第 2 版は `a7ec9997a`、第 2.1 版は `493957140`、第 3 版は `10a1a0dc0`
- **人の決定**（Issue #4535 コメント 7116505317、2026-11-24 08:01）: 公開の契約 C1〜C12 は設計どおり。Q1〜Q13 は推奨どおり、**Q13 は (b) 片付け**
- 基準: develop `d4f4624cd`。行番号はこの版のもの。Issue の行番号（`192f9dca1`）は §1.2 で今の位置に直した
- 正: Issue #4535 の本文（R1〜R5・不変条件 I1〜I5・受入条件・範囲の外）と、2026-11-21 のコメント 3 つ（親の決定、#4503 PR-B1 の資産、S9 受け入れの R1〔新しいタスクのダイアログ〕・K1・K2）。この文書は本文の意味を狭めない
- 境: #4534 の設計 `send-fence-4534.md`（第 3 版）と v2 `send-fence-4534-v2.md` §3.2〜3.4・§8.2。#4534 PR-B（`b5d0ac4f1`）で入った 409 `SEND_TARGET_CHANGED`・exit 34（`not_sent` のときだけ）・`sendOutcome`
- 材料: s9 の `review-4518-4492-codex-r2.md`（A4・N2）・`review-4518-v3-codex.md`（3・5）・`review-4466-exact-diff-codex.md`（3・4・5）・`worker-return-4518-stage1.txt`・`accept-result-claude-2.md`
- 第 2.1 版の材料: s11 の `review-4535-design-v2-opus.md`（第 2 版の再確認。解消 32・未解消 0・P3 7、以下 **V**）・`brief-4535-s1.md`（段 1 の指示）
- 第 2 版の材料: s11 の `review-4535-design-opus.md`（P1 1・P2 7・P3 10、以下 **A**）・`review-4535-design-opus2.md`（P1 1・P2 7・P3 6、以下 **B**）・`reinstruct-4535-design-r1.md`（処分）
- 書き方: 「事実」は file:line で確かめたこと。「見立て」は推し量り。この文書の試験の番号は `T1`〜。S9 受け入れの R1 は、Issue 本文の R1（OpenCode）と区別して **N1** と書く

## 第 3.2 版の変更点（C の INV-V2 を印で書き直す）

材料: s11 の `lead-stop-4535-c-inv-v2-3rd.md`（同じ種類の穴の 3 回目）・`enabler-return-4535-inv-v2-cause.md`（共通の原因と案 A）・`reinstruct-4535-c-r7.md`（PM の処分: 案 A を C に入れる）。

| 前の形（段 2 §3.3 INV-V2、r6） | 直した所 |
|---|---|
| 返した本文は文字列だけで入力欄に届き、元の宛先は worktree 単位の共有の表（hold）に別に書き、送る時に下書きの文字列の「含む」で照合も解除もした。返す道ごとの書き忘れ（1 回目）・照合の狭すぎ（2 回目）・解除の広すぎ（別の入力欄の送信が hold を消す、3 回目）が同じ原因から出た | §3.4.1: INV-V2 を V2a（結び付き）・V2b（解除は持ち主だけ）・V2c（判定は印で、下書きの中身に依らない）に割り、受け入れる境界を書いた。共有の表と文字列の照合は無くす |

## 第 3.1 版の変更点（A1 のレビュー 2 本の直し）

材料: s11 の `review-4535-a1-codex.md`・`review-4535-a1-opus.md`、処分 `lead-disposition-4535-a1-review.md`。

| 指摘 | 直した所 |
|---|---|
| SPA の殻の例外が 200 以外の HTML 2xx にも効いていた（codex P1-1） | §2.3 の表: 例外は **status 200 かつ `text/html`** だけ。`201`・`202` などの HTML 2xx は `unknown` |
| 添付の止めが path の fallback の `requireSession({ relaunch: true })` の後だった（codex P2-1・opus P3-1） | §3.2: 添付の止めは `sendMessageWithImage` の中、添付の dispatch が `unknown` と分かった直後、path の fallback と `requireSession` の前。起動のキーも打たない。名簿の行とペインが消えていても、止めの柵の確かめが 409 `SEND_TARGET_CHANGED` を返す |
| 「最悪 350 ms」は待ちの合計で、所要時間の上限ではない（codex P2-2・opus P3-4） | §2.3・§3.2 を「4 回の読み戻し（間の待ちは合わせて 350 ms、各回の上限 5 s）」に。動きは変えない |

## 第 3 版の変更点（人の決定を入れる）

| 決定 | 直した所 | 持ち主の PR |
|---|---|---|
| C1〜C12 設計どおり | §4 の見出しを「人の答え待ち」から「決定済み」に | 各 PR（§6） |
| Q13 (b) | §3.1 の「N4 で照会が `failed`」の行を「`relayOwned` を true に戻し、relay の取り下げ・note の close・Auto-Yes の取り下げをする」に。T8 の 2 本目の期待を「片付ける」に。§7 Q13 に決定。段 1 の `classify-send-answer.ts` の `applyRelayLookup` の直しは **PR-B**（A1 では変えない） | B（文は A1 の最初のコミット） |
| Q5 | 5xx・3xx を `unknown`（設計どおり）。実の場面（`prompt_async` が 5xx を返す形）は **A1 の後にリーダーが測る**（A1 のワーカーは本物の opencode に触れない） | A1（実測はリーダー） |
| Q1〜Q4・Q6〜Q12 | §7 の各行に「決定: 推奨どおり」 | — |

### A1 の着手で確かめた事実（第 3 版に足す）

- **C7 の「今」**: OpenCode の `unknown` の後にキーが打てなかったときの `lastSend.reason` は、拒否の reason ではなく **`send-error`**（`classifySendFailure` が #4040 の文面を最初に読み、`indeterminate`・`send-error` を返す: `send-attempt-state.ts:321–326`）。`dispatch-unknown` を `lastSend.reason` に出すには、reason の型（`send-attempt-types.ts`）のほかに **`classifySendFailure`（`src/lib/session/send-attempt-state.ts`）** が送信器の誤りを code で読む 1 行が要る
- **§5.3 の表に無い、A1 で期待が変わる既存の試験**: `opencode-send-api-2035.test.ts` の `the server answered %s: sendOpencodePrompt says rejected, the send is not_sent` の `500` の行（Q5 で `unknown`、キーボードに進まない）・`the POST got no answer (%s): …`（2 行）・`a 2xx other than 204 (%s) may have created the message: …`（2 行）。後の 2 本は答え（`unknown`）は同じで、`sendMessage` が投げるようになる（今はキーボードで成功する）ので `observeInputStart` が拒否で終わる
- 柵（#4534）との順: 送信器の止め（`dispatch-unknown`）の前に `fenceConfirm()` を 1 回呼ぶ（何も変えない確かめ）。dispatch の途中で宛先が替わった送信は、今どおり 409 `SEND_TARGET_CHANGED`（`sendOutcome: 'unknown'`、`lastSend.reason` `target-changed`）で答え、`dispatch-unknown` に読み替えない（今は後のキーボードの `noteInputStart` の確かめが断っていた。止めの後はその確かめが無くなるので、止めの側で同じ確かめをする）。INV-F2

## 第 2 版の変更点

| 指摘 | 処分 | 節 |
|---|---|---|
| A P1-1・B P1-1 `RELAY_BIND_CONFLICT` は not_sent の証明ではない（同じ要求の写しが先に予約した印） | 採る。N4 を `unknown`（`GET relay` の `sent`→`sent`・`failed`→`not_sent`）にし、relay・note・Auto-Yes に触らない。C4 の規則から外し、答えには `sendOutcome: 'unknown'` を付ける。T8 を逆にした。relay の無い送信のプロキシの再試行は範囲の外と書いた | §1.1 R2・§2.2 N4・§2.4・§3.1・§5.2 T7〜T8・§8 |
| A P2-1 `relayOwned` の定義と表の食い違い | 採る。「この CLI の起動が作った relay で、サーバーが別の試行の結び付きを言っていない」に直した。`RELAY_BIND_INVALID`・`RELAY_BIND_FAILED` は取り下げ・close する | §3.1・T7b |
| A P2-2・B P2-1 C4 の一覧の漏れ（`model_refused`・`INVALID_PATH`・brief の 409） | 採る。一覧をやめ、**route の包みの 1 つの規則**にした。T13 は規則を外すと赤になる形 | §2.4・§3.3・C4・T13 |
| B P2-2・A P3-2 middleware の 401・403 | 採る。型の印（`code`・`sendOutcome`）を足す案 C12 にした。足さない場合の食い違いも書いた | §2.2 N6・C12 |
| A P3-1・B P3-2 `ECONNREFUSED` | 採る。`cause.code === 'ECONNREFUSED'` だけ `not_sent`（`fetch failed` 全体ではない） | §2.2 N7 |
| B P2-3 C2 の比べ直し（3xx は前段の転送で、再 POST は最初の 1 通） | 採る。C2 を「redirect は今どおり追い、最後の答えを §2.2 で読む」に変えた。exit 0→99 の 3 か所目は作らない。I6 を「ハンドラーに届く POST」に直した | §2.2 R 行・§3.1・C2・I6・T17 |
| A P2-3・B P2-4 ask の `sendState` の語・失敗の答えの `ask.sendState` | 採る。語を `reserved | sent | not_sent | send_unknown` に直し、失敗の答えの `ask.sendState` も証明の源にした | §2.2 S3・N8 |
| B P2-5 新しいタスクのダイアログの時間切れ・切断 | 採る。`transportFailure` の送信の部分も `unknown` | §3.4・T15 |
| A P2-7・B P2-6 OpenCode の読み戻しの最初の 404 | 採る。梯子を最後まで回して 404 が続いたら `missing`（最悪 350 ms。第 3.1 版で「4 回、間の待ちは合わせて 350 ms、各回の上限 5 s」に直した） | §2.3・§3.2・T4 |
| B P2-7 C3・Q4 の exit（unknown は 1・2・99） | 採る。C3 と Q4 を書き直した | C3・Q4 |
| A P2-6 C8 の影響（timer・relay の配送・画面） | 採る。C8 に足し、timer の `indeterminate`→`failed` を別の Issue として §6 に書いた | C8・§6 |
| A P2-4・P2-5 試験の形（T9・T17 の `mockRoutes`、T10） | 採る。本物の `fetch` と `http.createServer`、T10 は着いた後に 408 の HTML | §5.2 |
| A P3-7 T1 の前提・T6 の変異 | 採る | T1・T6 |
| A P3-8 T14 が旧規則と区別できない | 採る。対の陰性を足した | T14 |
| A P3-9・B P3-4・P3-5 PR の割り方・文書 | 採る。A1 OpenCode を最初の独立の PR、文書の段落の持ち主を PR ごとに決めて直列に | §6 |
| A P3-3 包みが本文の `sendOutcome` を上書き | 採る。弱い方（`unknown`）が勝つ | §3.3 |
| A P3-4 S2（201 と `unknown`）の意味 | 採る。事実は `sent`（exit 0）、relay の観測が `unknown` と分けて書いた | §2.2 S2 |
| A P3-5 `settled: false` での `evaluateRelayAfterSend` | 採る。`settled` のときだけ呼ぶ | §3.3 |
| A P3-6 画面の redirect | 採る（範囲の外として書く。C2 と同じ理由で害は無い） | §3.4 |
| A P3-10・B P3-1 行番号・`content-type` の前提 | 採る | §1・§2.2 |
| B P3-3 C4 で今の CLI の stderr が変わる | 採る | C4 |
| B P3-4 `cli-operations-guide.md:1343` | 採る | C11 |
| B P3-6 Q5 の実測・Q6 の陽性の対照 | 採る | Q5・Q6・§5.3 |

採らないもの: 無し。

### 第 2.1 版の変更点

| 指摘 | 処分 | 節 |
|---|---|---|
| V P3-1 N4 で照会が `failed` のとき relay・note・Auto-Yes が残るのに、stderr は「送り直してよい」と言う | 案つきで Q13（人に追加で聞く）。それまでの設計の既定は「残す」（第 2 版のまま）。T8 の 2 本目は Q13 の答えで決める | §3.1・T8・Q13 |
| V P3-2 `RELAY_BIND_CONFLICT` は `sendOutcome` より先に `code` で決める | 採る | §2.2 優先 |
| V P3-3 C12 で期待が変わる既存の試験・変えてはいけない試験 | 採る | §5.3 |
| V P3-4 読み戻しの梯子で 404 と別の答えが混じるとき | 採る。4 回とも 404 のときだけ `not_sent`、混ざれば `unknown` | §2.3・T4 |
| V P3-5 N7 の `cause.code` の読む所・`AggregateError` | 採る。`ApiError.cause` → `TypeError.cause` の 2 段、`AggregateError` は中の全部が `ECONNREFUSED` のときだけ。分からなければ `unknown` | §2.2 N7 |
| V P3-6 C2 の前提が崩れたときの落ち方 | 採る | C2 |
| V P3-7 T13 の変異の「全部赤」は relayId の無い入力に限る | 採る | T13 |
| 段 1（brief-4535-s1） | 公開の値に触らない足場と内部の分類を先に入れる（§8） | §8 |

---

## 0. 結論

1. **3 値の正は「この要求の応答に、サーバーが型で書いた印」**。`not_sent` と読めるのは §2.2 の N 行（実行前の拒否の証明）に当たるときだけ。それ以外の失敗（素の 4xx/5xx の頁・非 JSON・空の 2xx・切断・形の合わない成功・`RELAY_BIND_CONFLICT`）は `unknown`
2. CLI は「送信の事実」と「後始末の権限」を分ける。`knownNotSent` 1 つで決めていた取り下げ・note の close・Auto-Yes の取り下げを、事実（3 値）と「relay がこの CLI の物か」の 2 つで決める（R2・R3・R4）
3. 証明を失わないために、route は**送信の service に入る前に止めて試行も記録しなかったどの拒否にも `sendOutcome: "not_sent"` を付ける**（1 つの規則。今は 404・400・`model_refused`・`INVALID_PATH`・ask の 409 などに付かない）。`RELAY_BIND_CONFLICT` だけは例外で `unknown`
4. OpenCode の送信器は `unknown` の後に何もしない（キーボードも 2 回目の HTTP も 0）。読み戻しの 404 は梯子を最後まで回してから `missing` にする（R1）
5. relay の後始末の失敗は送信の事実を書き換えない。route は事実を `sendOutcome` に、後始末の成否を `relaySettled` に返す（R5・I4）
6. 画面は新しいタスクのダイアログ（N1、時間切れ・切断を含む）を範囲に入れる。K1・K2 は範囲の外を勧める（§7）
7. **公開の契約が変わる所は §4。人の答え待ち。** exit が 0 → 99 に変わるのは 2 か所（空・形の違う 2xx と、OpenCode の unknown の後の fallback が成功していた場合）。redirect は今どおり追うので 3 か所目は作らない。C8 は exit のほかに timer・relay の配送・画面の結果も変える
8. PR は 4 本、直列: **A1 OpenCode（実の二重送信を止める本体、独立）** → A2 route → B CLI → C 画面（C は A2 の後、B と並べてよい）

---

## 1. R1〜R5 と S9 の N1・K1・K2 の確かめ直し（develop `d4f4624cd`）

### 1.1 表

| # | 事実（file:line） | 見立て | この Issue で扱うか |
|---|---|---|---|
| R1 | `opencode.ts:700–714` `trySendViaServer` は `dispatchViaServer` の `unknown` を `trace.unknown` に残して false を返す。`sendMessageAfterDispatch`（`:907–975`）は false を受けて `waitForPrompt` → `sendMessageWithSubmitVerification` でキーボードに打つ（`:941–955`）。添付の送信 `sendMessageWithImage`（`:1108–1134`）は添付の dispatch が false だと `sendMessageAfterDispatch` を呼び、その中の `trySendViaServer`（`:937`）で **2 回目の HTTP dispatch**（新しい messageId）をする。`unknown` になるのは: POST の応答なし・204 以外の非 HTML の 2xx（`hooks/sources/opencode/client.ts:603–610`）、読み戻しの `mismatch`・梯子の尽き（`opencode.ts:808–816`）、dispatch の後の例外（`:839`）。#4040 の `keepUnknownDispatch`（`:987–998`）は「キーが打てなかった」ときの分類だけを直し、**打てたときは打つ** | 届いていれば二重送信。試験 `send-readiness-4040.test.ts:419`（`dispatch` を 2 回呼ぶ）と `opencode-send-api-2035.test.ts:276`（読み戻しの不一致でキーボードに打つ）が今の動きを固定している | 扱う |
| R1'（同根） | `client.ts:611–612` は 204・非 HTML の 2xx 以外を全部 `rejected` → `not_sent`（`opencode.ts:802`）。5xx と 3xx もここに入る（`OPENCODE_FETCH_REDIRECT = 'manual'`、`client.ts:95` で 3xx はそのまま見える）。読み戻しは最初の GET の 404 で即 `missing`（`opencode.ts:868–871`）で、梯子（`OPENCODE_SEND_READBACK_DELAYS_MS`、`:255–269`）は 404 に効かない。定数の注（`:262–267`）は「書き込み途中を missing と言うと二重に届く」と言い、`:869–870` の注は逆を言う | OpenCode の HTTP は loopback で、間にプロキシは無い。4xx と SPA の `200 text/html`（#1931 の実測）は「受け付けていない」と言えるが、5xx は「作った後に落ちた」を否定できない。即断の 404 は「1.18.22 で 204 の前に message があった」の 5 回の実測（`client.ts:648–651`）だけに依る | 扱う（§2.3・Q5） |
| R2 | `send-messages.ts:32–40` `knownNotSent` は `outcome !== null` なら `outcome !== 'unknown'`（`:35`）。`resolveBoundSendOutcome` は 409 `RELAY_BIND_CONFLICT` を `'conflict'` にする（`message-dispatch.ts:133`）ので、`knownNotSent` は true。`send.ts:489` が note を閉じ、`:487` が Auto-Yes を取り下げる。relay は取り下げない（`message-dispatch.ts:207` は `null`・`not_sent` だけ）。relay はこの CLI の起動が送信の直前に作る（`send.ts:390`・`:457`、`ask.ts` の `registerRelayForMessage`、`relays.ts:232–244`）。既にある relay ID を `/send` に渡す CLI・画面の経路は無い。予約は 1 本の条件付き UPDATE（`bind_attempt_id IS NULL AND state='pending' AND send_state='awaiting' AND expires_at > now`、`relay-bind-db.ts:310–321`）で、断りは「既に閉じた」「期限切れ」「already bound to a send」の 3 つ（`:350–357`） | 作ったばかりの relay で期限切れ・利用者の取り消しはまず起きない。残る「既に別の送信が予約した」「既に delivered」は、**この CLI の同じ要求の写し**（プロキシ・tunnel の POST の再試行）が先に届いた場合しか作れない。つまり `RELAY_BIND_CONFLICT` は「この HTTP 要求は何も打っていない」は正しいが、**依頼が届いていない証明ではなく、届いているかもしれない正の兆候**。Issue の「取り消さない」は守り、「not_sent」とは読まない（第 1 版の誤り） | 扱う |
| R3 | `api-client.ts:355–399` `sendWithBody`: 非 2xx は `readErrorPayload`（`:410–423`）で JSON でなければ `payload` なし（`content-type` は見ない）。空の 2xx は `undefined` を返す（`:385–386`）。非 JSON の 2xx は `JSON.parse` の例外 → 状態コードの無い `ApiError`（`:393–395`）。`postMessage`（`message-dispatch.ts:192–194`）は戻り値の形を見ない。`resolveBoundSendOutcome` は `sendOutcome` の無い 4xx を `not_sent`（`:136`）、`knownNotSent` も 4xx を true（`send-messages.ts:39`）。結び付かない relay（旧サーバー）は失敗なら必ず取り下げる（`:207` の `outcome === null`） | 素の 408 の HTML・プロキシの 413 は、ハンドラーが動いたかどうかを言わない。空の 2xx は今 `Message sent.`・exit 0（`send.ts:506`）で、**「送れた」と言ってしまう**（Issue の「未送信と読む」より強い誤り）。非 JSON の 2xx は状態コードが無いので、結び付いた relay では照会に回る | 扱う |
| R4 | `fetch` は既定で redirect を追う（`api-client.ts:365–370` は `redirect` を指定しない）。301/302/303 は GET に変えて追い、307/308 は同じ本文で POST し直す。404 は exit 99、`resolveBoundSendOutcome` では `not_sent`。CommandMate の `/send` は 3xx を返さない（route は 201／200／4xx／5xx、`/api/*` の未認証は middleware が 401 JSON、login への redirect は画面の要求だけ: `middleware.ts:200–209`） | 3xx は前段（プロキシ・tunnel・http→https）が**ハンドラーへ渡さずに**返したもの。307/308 の再 POST は「ハンドラーに届く 1 通目」で、二重送信ではない（第 1 版の §4 C2 の比べは誤り）。404/405 は「古いサーバー」の印にも使えるが、POST の後では実行前の証明にならない | 扱う（§2.2・C2） |
| R5 | `RelaySendBinding.finish`（`relay-bind.ts:310–321`）は `settle` の例外を握り、失敗の試行なら `unknown` を返す（`:320`）。`settleRelaySendState` の更新 0 は見ない。route は `finish` の戻り値をそのまま `sendOutcome` にし、`withBody` の `extra` が本文の `sendOutcome` に勝つ（`route.ts:138–151`）。CLI の `cancelRelayQuietly`（`relays.ts:258–270`）・`closeSendNote`（`send-messages.ts:99–107`）の失敗は警告だけ。note の `closeWhen: relay:<id>` は relay の `cancelled` で `met/failure`（`condition-evaluators.ts:68–84`） | 証明つきの `not_sent` が、relay の台帳の書き込み失敗で `unknown` に落ちる（安全側だが事実ではない）。逆に、`finish` は `!boundaryWritten` なら `not_sent`（`relay-bind.ts:381`）なので、本文が `unknown` のとき包みが `not_sent` に書き換えうる（起動の段の柵の `indeterminate`、`send-session-start.ts:174–176`。注釈では今は起きない） | 扱う |
| N1（S9 R1） | `send-new-task.ts:119–140` `interpretSendResponse` は `sendOutcome` を読まない。500 は `failed`（文 `locales/ja/common.json:399`「送信に失敗しました。接続を確かめて送り直してください。」）。時間切れ・切断は `transportFailure`（`:163–166`、`:269`）で同じ `failed`。セッションの無い宛先はこの要求の中で起動するので時間切れは珍しくない。`NewTaskDialog.tsx:283–285` は失敗を出して［送る］を残し、押せば確認なしに同じ本文を送る。409 `SEND_TARGET_CHANGED` の `unknown` も `conflict`（「セッションが依頼を受け付けませんでした。」） | 「届いたか分からない」を「失敗・送り直せ」と言い、再送を勧める。I2 の画面の層 | 扱う（§3.4） |
| K1 | PC・タイルの入力欄は `unknown` の後に下書きを残さない（S9 の実測） | 打ち直しの検出は本文の比較か冪等の鍵が要る | 範囲の外を勧める（Q7） |
| K2 | 再読み込みで楽観の行（`unknown` の行）が消える（S9 の実測） | 画面の記録はクライアントの状態だけ。`lastSend` は残るが行ではない | 範囲の外を勧める（Q8） |

### 1.2 Issue の行番号の直し（`192f9dca1` → `d4f4624cd`）

| Issue | 今 |
|---|---|
| `opencode.ts:699–711・778–789・919–941` | `:700–714`（`trySendViaServer`）・`:796–816`（dispatch と読み戻しの判定）・`:907–975`（`sendMessageAfterDispatch`）。添付は `:1108–1134` |
| `send.ts:629–637` | #4128 の分割の後: `send-messages.ts:32–40`（`knownNotSent`）と `send.ts:483–503`（`onFailure`） |
| `message-dispatch.ts:127–145・182–211` | `:127–146`・`:182–244` |
| `api-client.ts:384–395` | `:355–399`（`sendWithBody`）、`:410–423`（`readErrorPayload`） |
| `relay-bind.ts:269–286・346–349` | `:277–301`（`onDispatchFailed`）・`:310–321`（`finish`）・`:381`（`nothingTyped`） |
| `relay-db.ts:370–383` | 同じ（`cancelRelay`） |
| `condition-evaluators.ts:69–84` | `:68–84`（`decideRelay`） |

### 1.3 Issue に無かった事実

- **F-a** ask の冪等の答え: 同じ ask ID・同じ本文の再送は 200 `{ ask: { id, state, reason, sendState } }`（`lib/ask/ask-send.ts:69–75`、`route.ts:291`）。ChatMessage の形ではない。`sendState` は `reserved | sent | not_sent | send_unknown`（`src/types/ask-correlation.ts:48`、CLI 側 `src/cli/types/api-responses.ts:1694`）。route は ask を読んだ後の**失敗も含むすべての答え**に `ask.sendState` を付ける（`route.ts:116–118`、`settleRouteAsk` `:190–200`。`!ask.delivering || ask.notTyped || relay.attempt === 'not-sent'` なら `not_sent`）
- **F-b** `relayWithdrawn`（#4498、`route.ts:144–151`）は「後始末の成否を別の欄で返す」形の先例
- **F-c** 画面の `isSendOutcomeUnknown`（`usePendingMessages.ts:128–143`）は `sendOutcome` の無い 4xx を「未送信（直に再試行してよい）」と読む。CLI の R3 と同じ形の写し
- **F-d** OpenCode の dispatch が `not_sent` の後のキーボードは、1 回の送信の中の「確実な未送信の後の別経路」で、I2 の外。今のまま残す
- **F-e** middleware: IP の制限は本文の無い 403（`middleware.ts:124–131`）、`/api/*` の認証の失敗は 401 `{ error: 'Unauthorized' }`（code 無し、`:200–205`）。どちらも route の前
- **F-f** `handleApiError` は `ECONNREFUSED` と `fetch failed` を同じ「Server is not running」・exit 1 にする（`api-client-errors.ts:225–229`）。undici の `fetch failed` は接続の拒否だけでなく、送った後の切断（`ECONNRESET` など）も含む（`cause.code` で分かれる）

---

## 2. 3 値の定義と not_sent の証明

### 2.1 定義

| 値 | 意味 | 言える条件 |
|---|---|---|
| `sent` | 本文が宛先に入った | サーバーが成功を型で返した（§2.2 の S 行） |
| `not_sent` | 本文のキーも dispatch も 1 つも始まっていない、と**この要求のサーバー（または TCP の接続の拒否）が証明した** | §2.2 の N 行のどれか |
| `unknown` | 上の 2 つのどちらとも言えない | それ以外すべて |

サーバーの試行の state（`lastSend.state`）との対応は今のまま: `sent`↔`sent`、`not-sent`↔`not_sent`、`indeterminate`↔`unknown`。

前提と限界: 証明は**要求ごと**（I7）。依頼ごとではない。前段が同じ要求を再試行し、2 通目の答え（型つきの `not_sent`、たとえば 1 通目が入力ロックを持つ間の拒否）だけを返す場合、1 通目は届いているのに `not_sent` と読む。結び付けた relay のある送信では、2 通目は `RELAY_BIND_CONFLICT` になるので N4 で `unknown` に落ちる。**relay の無い送信の前段の再試行は、冪等の鍵（#4466 PR3・#4503 PR-B3）の範囲で、この Issue の外**。またプロキシは型の付いた `sendOutcome` を作らない、と見る。

### 2.2 証明の一覧（CLI・画面が読む規則）

どの行も「**この要求の応答の本文**」（JSON のオブジェクト）で判定する。今の `readErrorPayload`（`api-client.ts:410–423`）は `content-type` を見ないので、段 2 で JSON の `content-type` の確かめを足す（`mockRoutes` は常に JSON の型を付けるので、試験は本物の `fetch` で書く）。

| # | 応答 | 判定 | 今 |
|---|---|---|---|
| S1 | 2xx・JSON・ChatMessage の形（`id` が文字列、`role: 'user'`）で、`sendOutcome` が無いか `sent` | `sent` | `sent`（形を見ない） |
| S2 | 2xx・JSON・ChatMessage の形・`sendOutcome: 'unknown'` | 送信の事実は **`sent`**（exit 0、再送しない）。relay の観測が `unknown`（返答の下限を言えない: `noInputBoundary`、`relay-bind.ts:352–361`）。今どおり relay を残し `printRelayUnconfirmedNotice` を出す | 同じ（`message-dispatch.ts:193`）。A1 の後は OpenCode の unknown の後の fallback がこれを作らなくなる |
| S3 | 200・JSON・`ask.sendState`（F-a。冪等の答え） | `sent`→`sent`、`not_sent`→`not_sent`、`reserved`・`send_unknown`・その他→`unknown` | 形を見ずに成功 |
| S4 | 2xx で上に当たらない（空・非 JSON・JSON だが形が違う） | `unknown` | 空は `sent`、非 JSON は状態の無い失敗 |
| N1 | 非 2xx・JSON・`sendOutcome: 'not_sent'` | `not_sent` | 同じ |
| N2 | 409・`code: SEND_TARGET_CHANGED`・`sendOutcome: 'not_sent'`（#4534） | `not_sent`（exit 34） | 同じ |
| N3 | 409・`code: TOOL_POLICY_DENIED`（`sendOutcome: 'not_sent'` 付き、#4437） | `not_sent`（exit 33） | 同じ |
| N4 | 409・`code: RELAY_BIND_CONFLICT` | **`unknown`**。結び付いた relay を照会し、`sent`→`sent`、`failed`→`not_sent`、それ以外→`unknown`。どの場合も relay・note・Auto-Yes に触らない | `conflict`（note を閉じ、Auto-Yes を取り下げる） |
| N5 | 非 2xx・JSON・`code` が §2.4 の旧サーバー互換の一覧（`sendOutcome` 無し） | `not_sent`（Q2） | 4xx なら `not_sent`、5xx なら照会 |
| N6 | 401・403・JSON・`code: AUTH_REQUIRED`／`IP_DENIED`（C12 の後の middleware） | `not_sent` | 401 は `not_sent`（4xx）、403 の空本文も同じ |
| N7 | 応答なし・接続の拒否（接続が張れていない） | `not_sent`（1 バイトも届いていない）。読む所: CLI は `fetch` の例外を `ApiError` の `cause` に包む（`api-client.ts:396–397`）ので、`ApiError.cause`（`TypeError: fetch failed`）→ その `cause.code === 'ECONNREFUSED'` と 2 段たどる。Node の `autoSelectFamily` で IPv4・IPv6 の両方が拒否されると `AggregateError`（`code` の付き方が版で違う）になるので、`errors` の**全部**が `ECONNREFUSED` のときだけ `not_sent`。期限（`DeadlineExceededError`、`:390–393`）とそれ以外の形は `unknown` | 状態の無い失敗（照会） |
| N8 | 非 2xx・JSON・`ask.sendState: 'not_sent'`（F-a、`ask` の付いた送信） | `not_sent` | 読まない |
| U1 | 非 2xx・JSON・`sendOutcome: 'unknown'` または `'sent'`（失敗の答えの `sent` は「打った」）、または `ask.sendState: 'send_unknown'`／`'sent'` | `unknown`（直の再送はしない） | 同じ（ask は読まない） |
| U2 | 非 2xx で N・U1 に当たらない（素の頁、`code` の無い JSON、知らない `code`、404/405、前段が返した 3xx） | `unknown` | 4xx は `not_sent`、5xx は照会 |
| U3 | 応答なし（N7 以外の切断・時間切れ・JSON の破損） | `unknown` | 同じ（結び付いた relay は照会） |

- 結び付いた relay の照会（`GET /api/relays/:id`、`message-dispatch.ts:138–145`）は今のまま、U2・U3・S4・N4 で使う。`failed` を書くのは当該の試行の `settle` だけ（`relay-bind.ts:381–384`）で、relay は CLI ごとに新しく 1 試行しか結び付かないので、照会の `failed` は当該の試行のもの（Q3）
- redirect: CLI は今どおり追う（`fetch` の既定）。最後の答えを上の表で読む。308 の後の 201 ChatMessage は S1（`sent`）、303 で GET に化けた後の頁は S4／U2（`unknown`）
- 優先: **`code: RELAY_BIND_CONFLICT` は最初に `code` で決める**（N4: `relayOwned = false` と照会。A2 の後の答えは `sendOutcome: 'unknown'` を持つが、それで U1 に入れない。事実は照会で上書きする）。それ以外の N・U の判定は `sendOutcome` を先に、`code` を後に見る。同じ答えに `sendOutcome` と `ask.sendState` があり食い違えば、弱い方（`unknown` が勝つ）

### 2.3 OpenCode の dispatch の 3 値（送信器の中）

| 結果 | 判定 | 今 |
|---|---|---|
| 204 → 読み戻し `found` | `delivered` | 同じ |
| 204 → 読み戻しが梯子の**最後まで** 404 | `not_sent`（OpenCode 自身が「その ID の message は無い」と言い続けた。4 回の読み戻し（間の待ちは合わせて 350 ms、各回の上限 5 s）） | 最初の 404 で即 `not_sent` |
| 204 → 404 の後に `found` | `delivered` | 404 で即 `not_sent` → キーボード（二重送信） |
| 204 → 404 と別の答え（5xx・読めない答え）が混じり、`found` が無い（404・500・404・404 など） | `unknown`（4 回とも 404 のときだけ `missing`） | 1 回目の 404 で即 `not_sent` |
| 204 → `mismatch`・梯子の尽き（404 以外の読めない答え） | `unknown` | 同じ（ただし fallback する） |
| 4xx・`200 text/html`（SPA の殻。status 200 のときだけ） | `not_sent` | 同じ（ただし今は 201・202 などの HTML 2xx も `not_sent`） |
| 5xx・3xx | **`unknown`**（Q5） | `not_sent` |
| 204 以外の非 HTML の 2xx・200・204 以外の HTML 2xx（201・202 など。204 は読み戻しの行に入る）・応答なし・dispatch の後の例外 | `unknown` | 同じ（HTML の 201・202 は `not_sent`） |

### 2.4 route の実行前の拒否（C4 の規則と N5 の一覧）

**規則（C4）**: route の包み（`POST`、`route.ts:107–151`）で、次をすべて満たす非 2xx の答えに `sendOutcome: 'not_sent'` を付ける。

- この要求の試行が記録されていない（`relay.attempt === null`）
- 送信の service に入っていない、または service が鍵の前に止めたと言った（`!ask.delivering || ask.notTyped`。今は ask の行だけが使う `settleRouteAsk` の `:198` と同じ条件。段 2 で ask に限らない名前に移す）
- 答えの `code` が `RELAY_BIND_CONFLICT` でない（これには `sendOutcome: 'unknown'` を付ける。§1.1 R2）
- 答えに既に `sendOutcome` が無い

外側の `catch`（`route.ts:632–637`、500 `Failed to send message`）も同じ規則で、service に入っていなければ `not_sent`、入っていれば付けない（`unknown`）。

今この規則で `not_sent` が付くようになる答え（一覧は規則の確かめに使う。実装は一覧を持たない）:

| 応答 | code | 所 |
|---|---|---|
| 404 worktree 無し | 無し | `route.ts:264–267` |
| 400 本文の読み・検査 | 一部だけ | `readJsonObjectBody`、`send-request.ts:209–235` |
| 409 `ASK_ID_CONFLICT` | 有り | `ask-send.ts:62–67`（同じ ID・**別の本文**。同じ本文の写しは 200 の冪等の答え（S3）になるので、写しの印にはならない） |
| 400 `RELAY_BIND_INVALID`・500 `RELAY_BIND_FAILED` | 有り | `send-relay.ts:116`、`relay-bind.ts:153–156・174–182`、`relay-bind-db.ts:339–350` |
| 400 `model_refused` | 有り | `route.ts:401–404`・`:457–459`、`send-session-start.ts:58–75`・`:179–182`、code `send-request.ts:118` |
| 400 `INVALID_PATH` | 有り | `route.ts:399–400`・`:508–509`（2 回目はセッションの起動の後）、`send-image-path.ts:45–67` |
| 409 brief の選び直し | **無し**（本文は `{ error: result.code, reason, boundary }`） | `route.ts:568–574`（`ask.notTyped`）。`code: 'brief_choice'` を足すかは Q10 |

**N5（旧サーバーとの互換。Q2）**: CLI が `sendOutcome` の無い答えを `not_sent` と読む `code` の一覧: `ASK_ID_CONFLICT`・`RELAY_BIND_INVALID`・`RELAY_BIND_FAILED`・`model_refused`・`INVALID_PATH`・`PROMPT_WAITING`・`session_owned_by_other_server`（`FOREIGN_SESSION_ERROR_CODE` の値）・ロールの code（`ROLE_` で始まるもの）・`ROSTER_CHANGED`（409 の値は大文字、`api-client-errors.ts:94`）。**`RELAY_BIND_CONFLICT` は入れない**。`code` の無い 400・404 は読まない。

### 2.5 #4534 の 409 `SEND_TARGET_CHANGED` との整合

- `not_sent`／`unknown` は柵の試行の state（`inputStarted`・`dispatchUnknown`）から付く（v2 §3.2）。この設計の 3 値と同じ語で、読み替えは無い
- exit は #4534 のまま: `not_sent` は 34、`unknown` は 99。この Issue は 34・99 を変えない
- `SEND_TARGET_CHANGED` は試行を記録する（`recordNotSent('target-changed')` か `recordAttempt`）ので、C4 の規則には入らない
- `sendOutcome` が無い・知らない値なら、今の `sendTargetChangedResult`（`api-client-errors.ts:104–112`）どおり 99 で、§2.2 では U2 → `unknown`
- 画面: 新しいタスクのダイアログは今これを `conflict` と読む（N1）。§3.4 で `sendOutcome` で分ける

---

## 3. 層ごとの規則

### 3.1 CLI（`send`・`ask`。`postMessage` を通る 2 つ）

`postMessage` は 1 つの関数 `classifySendAnswer(error | body) → { fact: 'sent' | 'not_sent' | 'unknown', relayOwned: boolean }` で §2.2 を読む（今の `resolveBoundSendOutcome`・`knownNotSent`・`describeFailedSendOutcome` の 3 か所の読みを 1 つにする）。

`relayOwned` の定義: **この CLI の起動が作った relay で、サーバーが別の試行の結び付きを言っていない**。`RELAY_BIND_CONFLICT`（N4）だけ false。`RELAY_BIND_INVALID`・`RELAY_BIND_FAILED` は true（予約の前の拒否だが、relay はこの CLI の物で、送信は `not_sent`）。

| 後始末 | 条件（新） | 今 |
|---|---|---|
| relay の取り下げ（`cancelRelayQuietly`） | `fact === 'not_sent' && relayOwned` | `null`（結び付かない relay）・`not_sent` |
| note の close（`closeSendNote`） | `fact === 'not_sent' && relayOwned` | `knownNotSent`（`conflict` も真） |
| Auto-Yes の取り下げ（`withdrawArmedAutoYes`） | `fact === 'not_sent' && relayOwned`（N4 では届いているかもしれない依頼の Auto-Yes なので触らない。relay の無い送信は `relayOwned` を true と読む） | `knownNotSent` |
| N4 で照会が `failed` | **`relayOwned` を true に戻し、relay の取り下げ・note の close・Auto-Yes の取り下げをする**（Q13 (b)。`failed` を書くのは結び付いた唯一の試行の `settle` だけで、その試行は何も打っていない: Q3）。照会が `sent`・その他のときは今のまま触らない | `conflict`（note を閉じ Auto-Yes を取り下げる） |
| 契約の task の failed（`failTask`） | 今のまま（失敗なら必ず。task は「この CLI の失敗」）。N4 で届いていた場合の task は Q11 | 同じ |
| 結び付かない relay（旧サーバー、`bound: false`） | `fact === 'not_sent'` のときだけ取り下げ（今は失敗なら必ず） | 必ず |

- **再送しない**: どの値でも `postMessage` は POST を 1 回だけ打つ。redirect は `fetch` の既定のまま（§2.2）
- **exit**: `not_sent` と `unknown` の exit は今の `handleApiError` の値のまま（C3）。変えるのは S4（今 0、案で 99。C1）だけ。N4 で照会が `sent` なら exit 0（`postMessage` が成功を返す。今の照会の `sent` と同じ）
- **stderr**: `unknown` のとき、今の `describeFailedSendOutcome` の unknown の文を、`sendOutcome` の無い失敗にも出す（C5）。N4 は relay の注意（`printRelayUnconfirmedNotice`、`relays --id` と pane の確認）を出す。N7 は今の「Server is not running」だけで、unknown の注意を出さない
- `ask` も同じ関数を通る。`ask` は note を持たない

### 3.2 送信器（OpenCode）

- `trySendViaServer` が `unknown` を返したら、`sendMessageAfterDispatch` はキーボードに進まず、`keepUnknownDispatch` と同じ形の誤り（`indeterminate`、reason は C7）で終える。添付の送信は、添付の dispatch が `unknown` なら path の fallback（2 回目の HTTP を含む）を呼ばない。守りは 2 つ（`sendMessageAfterDispatch` の止めと `sendMessageWithImage` の止め）で、試験は別々に変異させる（T6）。`sendMessageWithImage` の止めは添付の dispatch の直後、path の fallback（`sendMessageAfterDispatch`）とその `requireSession({ relaunch: true })` の前に置く（第 3.1 版。起動のキーも打たず、ペインが消えていても柵の 409 を失わない）
- 読み戻しの 404 は梯子（`[0, 50, 100, 200]`）を最後まで回し、全部 404 なら `missing`（§2.3）。途中で `found` なら `delivered`。4 回の読み戻しで、間の待ちは合わせて 350 ms、各回の GET は `OPENCODE_REQUEST_TIMEOUT_MS`（5 s）が上限（遅いサーバーでは約 20 s まで延びうる）
- `not_sent`・`skipped` の後のキーボード（F-d）は今のまま。2 回目の HTTP（添付 → path）も、1 回目が `not_sent` のときだけ許す。その前に #4534 の柵が宛先を照合し直す（`fenceConfirmDispatch`、今のまま）
- 5xx・3xx を `unknown` にする（§2.3、Q5）
- `RelaySendBinding.onDispatchFailed`（`relay-bind.ts:277–301`）は今のまま。fallback を止めるので、`settle` の「後の dispatch が届いた」枝（`:326–342`）は通らなくなる。枝は消さない（binding はどの送信器にも共通）
- 他の送信器: `noteDispatchStart()` の呼び手は `opencode.ts` だけ（`git grep` で確かめた）。copilot・codex・claude・agy は HTTP の dispatch を持たない。agy の読み戻しは #4503 PR-B1

### 3.3 サーバー（route・relay・mem の後始末）

- **C4**: §2.4 の規則を route の包みに 1 つ置く。試行の記録（`lastSend`）は足さない（今「記録の残らない 400 の拒否」と文書が言う。`cli-operations-guide.md:1346`。記録を足すと `lastSend` の意味が変わる）。#4518 の `EXACT_TARGET_MISMATCH` のような新しい拒否も、規則が自動で覆う
- **I4（R5）**: `RelaySendBinding.finish` は `{ outcome, settled }` を返す。`outcome` は試行の事実（`relay.sent`・`relay.attempt` から決まる）で、`settle` の例外・更新 0 で変えない。`settled: false` のとき route は `relaySettled: false` を足す（`true` のときは足さない。今の答えとバイト単位で同じ）
  - 包みの `sendOutcome` は、本文の `sendOutcome`（あれば）と `finish` の `outcome` の**弱い方**（`unknown` が勝つ）にする（今は `extra` が勝つ。A P3-3）
  - `evaluateRelayAfterSend`（`route.ts:142`）は `outcome === 'sent' && settled` のときだけ呼ぶ（台帳が `input_started` のままなら評価は空振りする）
  - 後始末を失った relay は `awaiting`／`input_started` のまま残り、満期か利用者の `relays --cancel` で閉じる。`not_sent` で台帳を `failed` にできなかった relay は、CLI が今どおり取り下げる（`cancelRelay` は開いた状態なら閉じる）
- **C12 middleware**: `/api/*` の 401 に `code: 'AUTH_REQUIRED'`、IP の制限の 403 に JSON 本文 `{ error, code: 'IP_DENIED' }` を足す（`/api/*` だけ。画面の要求の login への redirect は今のまま）。`sendOutcome` は middleware が route を知らないので付けず、CLI・画面が code で N6 と読む
- mem: note の close は CLI の `closeSendNote`（`not_sent && relayOwned`）と、relay の終端の条件（`decideRelay`）の 2 つのまま。`unknown` では CLI は閉じず、relay が `delivered`／`expired`／`cancelled` で閉じる（R2 の直しだけ）
- relay の配送（`relay-delivery.ts` の `settleUnsentResult`・`holdUncertain`）と timer（`timer-manager.ts:146–171`）はコードを触らない。ただし C8 で結果が変わる（§4 C8）

### 3.4 画面

| 面 | この Issue | 理由 |
|---|---|---|
| 新しいタスクのダイアログ（`send-new-task.ts`・`NewTaskDialog*.tsx`） | **扱う**（N1。答えの読みと、送信の時間切れ・切断） | #4503 PR-B2 の範囲の外だった。同じ根 |
| `isSendOutcomeUnknown`（`usePendingMessages.ts:128–143`。worktree 詳細・タイル・履歴・スマホが使う） | **規則だけ合わせる**（F-c: `sendOutcome` の無い 4xx を `unknown`、N6 の code と `SEND_REFUSED_BEFORE_INPUT_CODES` は `not_sent`。C4 の後は route の拒否は `sendOutcome` を持つ） | 1 関数の変更。再試行の UI（`confirmedResend`）は #4503 PR-B2 のまま |
| 画面の redirect | 扱わない。ブラウザーの `fetch` は 307/308 で POST し直すが、CLI と同じく前段がハンドラーへ渡していない形なので二重にならない。最後の答えを §2.2 で読む（`send-new-task.ts:127` の `response.redirected` の 200 は今どおり成功にしない） | C2 と同じ |
| 画面の再試行の古い応答（#4417）・冪等の鍵（#4503 PR-B3） | 扱わない | 範囲の外（Issue 本文） |
| K1・K2 | 扱わない（勧め） | Q7・Q8 |

ダイアログの規則:

- `interpretSendResponse` は §2.2 で読み、`unknown` のとき新しい kind `unknown` を返す
- `transportFailure` は、**送信の要求**（`/send`）の時間切れ・切断を `unknown` にする。Auto-Yes を立てる要求の失敗は今のまま `auto_yes_failed`（`send-new-task.ts:234–240`）。接続の拒否（N7 に当たるもの。ブラウザーでは見分けられないので、`fetchApi` の `kind: 'offline'` だけ）は `failed` のまま
- ダイアログは `unknown` で［送る］をそのまま押せる形にしない。文「届いたかどうか分かりません。送り直す前に、送り先の画面で確かめてください。」と［送り先を開く］を出し、［送る］は確認（「同じ依頼をもう一度送ります。二重に届くことがあります」）の後だけ送る（Q9）。`not_sent` は今の文と動きのまま

### 3.4.1 柵の 409 で止まった本文を入力欄に返す（C。INV-V2a〜V2c）

柵（#4534）の 409 `SEND_TARGET_CHANGED` `not_sent` で止まった新しい送信の本文は、今の入力欄に 1 回だけ返す（人の決定 S2-Q1・S2-Q5 (b)。`worktree-gone`・元の宛先が答えに無いとき・`unknown`・2 回目以降の試行では返さない＝INV-V1・V3・T20 のまま）。返した本文が、替わった後の宛先へ 1 回の押下で送られないことを、次の 3 つで決める。

- **印**: `RetargetTag = { id, original: { instanceId, cliToolId } }`。本文を返す時に作る
- **INV-V2a 結び付き**: 柵の `not_sent` で入力欄に入る（残る）本文は、必ず印と一緒に入力欄に届く。本文と印は 1 つの値 `{ text, tag }` で運び、印の無い柵の本文を入力欄に入れる関数は無い（型で閉じる）。返す道は 3 つ: 楽観の送信の答え（`onTargetChanged`）・行の［破棄］（`discard`）・入力欄に本文が残る待つ形の送信（`noteFenceRefusal`。スマホの端末の表示・brief の選択）
- **INV-V2b 解除は持ち主だけ**: 印は本文を持つ入力欄が持つ（state と、下書きの鍵の隣 `<draftKey>:retarget`）。下書きと一緒に再読み込み・タイルの instance の切り替えを跨ぐ。消えるのは、その入力欄が自分の下書きを送った時だけ（送った時に持っていた印だけ）。別の入力欄・別のタブ・別の送信・時間・件数では消えない（件数の上限は無い）
- **INV-V2c 判定**: 印を持ち、その元の宛先（instance と tool の両方）が今の To と違う入力欄では、Enter・［送信］・brief の選択の 1 回で POST 0 で確認が出る（元の宛先と今の宛先を示す）。取り消せば POST 0。「はい」で今の To へ POST 1。**下書きの中身（文字列）は見ない**。判定に使う印は、送るたびに読む入力欄の印と保存の印（`readRetargetTagState`）の和（id で合わせる）で、保存が読めない（投げる・壊れた値）時は元の宛先が分からないものとして聞く（その「はい」はその 1 回の送信だけに効く。#4607）
- **保存の失敗**: 印を `localStorage` に書けないときは本文を返さず、トーストでそう伝える（fail-closed。再読み込みを跨いで印を持てないため）。待つ形の送信では本文は入力欄から出ていないので、印は state に持ち、その画面の間は効く（保存が投げる・容量のときに入力欄の切り替えを跨ぐ場合は下の既知の限界）
- **既知の限界**（人の決定 (b)、2026-11-25。直しは #4604）: INV-V2a〜V2c は、保存（`localStorage`）の読み・書きが成り立つときだけ保証する。**保存が投げる・容量が足りないときは保証しない**。入力欄の state と保存の 2 つの写しが、入力欄の切り替え（`/sessions` のタイルの instance）・遅らせた下書きの保存と組んで食い違い、印の無い本文が替わった宛先の入力欄に残ることがある（例: brief の選択で止まった本文を持つタイルで、`getItem` が投げる間に instance を切り替えると、本文は画面に残り、印は切り替え先の保存の `[]` に置き換わって、Enter 1 回で替わった宛先へ POST 1。`:retarget` の書き込みだけが容量で失敗すると、切り替えて戻した時に本文は戻り印は戻らない）。下書きと印を 1 つの保存の値にまとめ、読めない・書けないときは「分からない」として次の 1 回を聞く直しは #4604
- **受け入れる境界**（PM の処分）: 人がクリップボードで別の入力欄へ貼った本文は INV-V2 の外（1 回の押下ではなく人の操作）。返した本文を全部消して別の文を打っても、その入力欄の次の 1 回は聞く（余分な確認。安全側）
- 試験: 同じ worktree の入力欄を 2 つ以上並べ（PC の分割枠 2 つ・スマホ＋PC の分割枠・`/sessions` のタイル 2 枚・別のタブ）、手順の列（返す・打つ・宛先を替える・別の入力欄から送る・別のタブから送る・再読み込み・タイルの切り替え・2 回目の返し）を流して、最後の Enter の期待を試験の中の小さなモデル（入力欄ごとの「受け取った印の元の宛先の集合」。その入力欄の送信でだけ空にする）から決める。期待を本文の形から決めない

---

## 4. 公開の契約を足す・変える所（**決定済み**: C1〜C12 は設計どおり）

| # | 所 | 今 | 案 | 変えない案との比べ |
|---|---|---|---|---|
| C1 | CLI `send`・`ask` の **2xx の形の検査**（S3・S4） | 空の 2xx: `Message sent.`・exit 0。非 JSON の 2xx: exit 99（状態の無い失敗）。形の違う JSON: exit 0 | 3 つとも `unknown`: stderr に `Error: the server's answer did not say whether the message was sent` と unknown の注意、**exit 99**、relay・note はそのまま | 変えない案: 空の 2xx を exit 0 のまま。今の `/send` は空の 2xx を返さない（201 か 200 `ask`）ので、空の 2xx は前段か壊れたサーバー。exit 0 は「送れた」の約束で、監督のエージェントが成果を待ち続ける。案を勧める |
| C2 | CLI の `/send` の POST の redirect | 追う（301/302/303 は GET、307/308 は同じ本文で POST） | **今のまま追う**。最後の答えを §2.2 で読む（308 の後の 201 は `sent`、GET に化けた後の頁は `unknown`） | 第 1 版の案（`redirect: 'manual'`）は、`/send` が 3xx を返さず前段の 3xx はハンドラーへ渡していないので二重送信を防がない一方、http→https を 308 で返す前段の後ろへ `--url`／`CM_URL` で送る利用者を毎回 exit 99 にする（exit 0→99 の 3 か所目）。採らない。前段が「ハンドラーへ渡してから 3xx を返す」形は無い、を前提として書く。前提が崩れた場合: 結び付いた relay の送信は 2 通目が `RELAY_BIND_CONFLICT`（N4、`unknown`）に落ちて安全。結び付きの無い送信は §2.1 の「前段の再試行」と同じ範囲の外 |
| C3 | CLI の **exit**（`not_sent`／`unknown`） | `handleApiError` の値: 400・401・403→2、404→99、409→99／31／33／34、429→1、5xx→99、切断・時間切れ・`fetch failed`→1 | **変えない**。3 値は stderr（`sendOutcome=<値>` の語を含む注意）と後始末に出す。`unknown` の exit は 1・2・99 のどれかに散る | 代わりの案: `unknown` に専用の exit。exit は今、状態コードの写しで、監督のスクリプトはそれで分けている。後の組で `unknown` と exit 2 が重なるのは、C4・C12 の後は**前段が返した素の 400・401・403 だけ**（stderr の「pane を見よ」と exit 2「入力の誤り」が同時に出る）。この重なりを受け入れて勧めは「変えない」（Q4） |
| C4 | `POST /api/worktrees/:id/send` の実行前の拒否（§2.4 の規則） | `sendOutcome` 無し | 規則で `sendOutcome: 'not_sent'` を足す（status・code・文は今のまま）。`RELAY_BIND_CONFLICT` には `sendOutcome: 'unknown'` | 足さない案: I1 を入れると CLI はこれらを `unknown` と読み、relay・note・Auto-Yes を残す（I5 に反する。例: 稼働中の claude への `send --model X` の 400 で「pane を見よ」と Auto-Yes の残り）。**今の CLI（B の前）の stderr も変わる**: `describeFailedSendOutcome` が足した `not_sent` を読み、404・400・`model_refused` などに `Note: the message was not sent … it is safe to send it again.` を出す（正しい文）。`RELAY_BIND_CONFLICT` の `unknown` には今の CLI が「pane を見よ」を出す（これも正しい） |
| C5 | CLI の stderr | `sendOutcome` の無い失敗には再送の注意を出さない（`relay-bind-cli-3957.test.ts:309・338` が固定） | `unknown` と読んだ失敗には unknown の注意を出す（N7 を除く） | **既存の試験 2 本の期待が変わる**（§5.3）。変えない案: 注意を出さず、後始末だけ変える。利用者が「送り直してよいか」を知る手が無くなるので、案を勧める |
| C6 | route の答えの `relaySettled`（I4） | 無し（`finish` の失敗で `sendOutcome` が `unknown` に落ちる） | `relaySettled: false` を足す（`true` のときは足さない）。`sendOutcome` は事実のまま（本文との弱い方） | 変えない案: 台帳の書き込みが失敗した `not_sent` が `unknown` になる。I4 の受入条件に反する |
| C7 | `prompt --json` の `lastSend.reason` | OpenCode の unknown の後にキーが打てなかったときは、その拒否の reason で `indeterminate` | 新しい reason `dispatch-unknown`（`indeterminate`） | 代わりの案: `send-error` に寄せる。理由が読めなくなるので勧めない |
| C8 | OpenCode の送信の結果（R1） | `unknown` の後のキーボードが成功すると成功 | 失敗（`indeterminate`・`sendOutcome: unknown`）。呼び手ごとに: **CLI** 201・exit 0 → 500・**exit 99**。**画面の送信** 201 → 500 `unknown`（#4503 PR-B2 の unknown の行）。**timer** `sent` → `failed`（`timer-manager.ts:168`、理由 `[send] …`。timer は `indeterminate` を分けないので、利用者が作り直すと二重送信の入口になる）。**relay の配送** 配送済み → `holdUncertain`（返答が依頼主に自動で入らず、保留の表示になる） | 変えない案は I2 に反する。勧めは案。timer の `indeterminate` を `failed` と書く件は §6 の別の Issue |
| C9 | 画面の新しいタスクのダイアログ（N1） | `failed` の文と、確認なしの［送る］ | §3.4 の文と確認。ロケールの鍵 `newTask.errors.unknown` を ja・en に足す | 変えない案は I2（画面の層）に反する |
| C10 | `isSendOutcomeUnknown`（F-c） | `sendOutcome` の無い 4xx は「未送信」 | `unknown`（ただし N6 の code・`SEND_REFUSED_BEFORE_INPUT_CODES`・`not_sent` は今のまま） | C4・C12 の後に変わるのは前段の 4xx だけ。C12 を採らないと、画面の cookie の期限切れの 401 が「届いたか分からない」になる |
| C11 | 文書 | — | `docs/user-guide/cli-operations-guide.md` の `:765–768`（relay）・`:1343`（「opencode の HTTP 配送（`unknown` の後のキー入力への切り替えを含む）」は A1 の後は誤り）・`:1346`（`sendOutcome` の段落）・`lastSend` の reason、英語版の同じ所、`src/cli/docs/agent-operations.ts`、`send --help`（`send.ts:240–250`）。終了コードの表は変えない | — |
| C12 | middleware の `/api/*` の 401・403 | 401 `{ error: 'Unauthorized' }`、403 は本文なし | 401 に `code: 'AUTH_REQUIRED'`、403 に `{ error: 'Forbidden', code: 'IP_DENIED' }` | 変えない案: CLI は 401 で exit 2（「token を渡せ」）と「pane を見よ」の注意を同時に出し、画面は cookie の期限切れを「届いたか分からない」と言う。案を勧める。`code` を足すだけで status は同じ |

変えないもの: #4534 の 409 `SEND_TARGET_CHANGED` と exit 34、#4437 の exit 33、`PROMPT_WAITING`（exit 2）、ロールの 409（exit 31・32）、`lastSend` の state の 3 値、`relayWithdrawn`（#4498）、redirect の追い方。

---

## 5. 不変条件と、試験を先に書く順

### 5.1 不変条件（Issue の I1〜I5 に足すもの）

- **I6 再送しない（HTTP）**: 1 回の CLI の送信で、CLI が自分で `/send` の POST を打つのは 1 回。前段の 307/308 を追うのは「ハンドラーに届く 1 通目」で、ハンドラーに届く POST は高々 1 通。偽の前段とハンドラーで、ハンドラー側の POST の数を数える
- **I7 証明は要求ごと**: `not_sent` の判定は、その要求の応答の本文（または接続の拒否）だけから。前の要求・別の試行の応答・`lastSend` からは言わない。要求の写し（前段の再試行）は §2.1 の限界
- **I8 後始末の権限**: relay の取り下げ・note の close・Auto-Yes の取り下げは、`relayOwned`（§3.1）のときだけ。N4 では 0
- **I9 並行・削除**: 同じ relay の写しの予約の間に、この CLI の `RELAY_BIND_CONFLICT` が relay・note・Auto-Yes を変えない。送信の途中で worktree が消えたら #4534 の `worktree-gone` の答え（`not_sent`／`unknown`）のまま
- **I10 規則は 1 つ**: route の実行前の拒否の `sendOutcome` は包みの 1 規則から付く。拒否の所ごとに付けない（新しい拒否の漏れを作らない）

### 5.2 試験の一覧（段 2 で先に書く。直す前の赤の形）

偽のサーバーは `os.tmpdir()` の下の一時 HOME と、**ポート 0 の `http.createServer`** で立て、CLI は**本物の `fetch`** で呼ぶ（`mockRoutes`（`relay-bind-cli-3957.test.ts:82–109`）は redirect を追わず、HTML・空本文・非 JSON・`content-type` を作れないので、T9・T10・T17 には使わない）。本番 3000 に触れない。OpenCode は偽の `prompt_async`。

| # | 受入条件 | 試験（ファイル・名前の案） | 直す前の赤 |
|---|---|---|---|
| T1 | R1 | `tests/unit/cli-tools/opencode-unknown-no-fallback-4535.test.ts` `R1: the first dispatch drops before the answer — no second HTTP, no keys`。**pane に空の入力欄が出ているフレーム**を前提にする（出ていないと直す前でもキーは 0。`send-readiness-4040.test.ts:400–407`） | `keys` が 1 回以上 |
| T2 | R1（添付） | 同 `R1: an image dispatch unknown — the path fallback is not dispatched`（同じ前提） | `dispatch` が 2 回 |
| T3 | R1（読み戻し） | 同 `R1: a read-back mismatch — nothing typed, indeterminate`（同じ前提） | `submitMock` が 1 回 |
| T4 | R1 の対照と 404 | 同 `control: a refused POST (4xx) still falls back to the keyboard`・`control: a read-back 404 to the end of the ladder still falls back`（陰性）・`a read-back 404 then found is delivered — no keys`（陽性）・`a read-back mixing 404 and 500 is unknown — no keys`（陽性） | 最後の 1 本: 1 回目の 404 でキーボードに打つ |
| T5 | R1'（Q5） | 同 `a 5xx answer is unknown — no keys` | `keys` が 1 回以上 |
| T6 | 変異 | T1・T3 は `sendMessageAfterDispatch` の `unknown` の止めを外すと赤、T2 は `sendMessageWithImage` の path の fallback の止めを外すと赤。**2 つを別々に**外して段 2 の記録に残す | — |
| T7 | R2 | `tests/unit/cli/commands/send-outcome-4535.test.ts` `R2: RELAY_BIND_CONFLICT — the note stays open, the relay is not withdrawn, Auto-Yes stays, the relay is looked up` | note の close の POST が 1 回、Auto-Yes の取り下げが 1 回 |
| T7b | `relayOwned`（陽性） | 同 `control: RELAY_BIND_INVALID — the relay is withdrawn and the note closed` | 緑のまま（I5） |
| T8 | R2（照会の陽性） | 同 `RELAY_BIND_CONFLICT and the lookup says sent — exit 0, nothing resent`・`… says failed — not_sent, the relay is withdrawn, the note closed, Auto-Yes withdrawn`（Q13 (b): 片付ける） | 1 本目: 今は exit 99。2 本目: 今は relay を取り下げない（note は閉じる） |
| T9 | R3・R4 | `tests/unit/cli/commands/send-outcome-http-4535.test.ts`（本物の `fetch`・`http.createServer`）`R3/R4: <case> is unknown — no withdraw, no close, no resend`（case: 素の 408 の HTML・`code` の無い JSON の 400・非 JSON の 200・空の 204・空の 200・形の違う JSON の 200・303 → 頁・404 の HTML・405）。各々ハンドラーの POST 1、cancel 0、close 0、stderr に unknown の注意 | 408・400・404・405 で cancel と close が 1。空の 2xx で exit 0 |
| T10 | 実の `--note --reply-to` | `tests/integration/send-note-unknown-4535.test.ts` `the message lands, a 408 page comes back — the waiting note stays open`。一時 HOME・一時 DB で本物の route と mem を通し、前段の小さな中継（`http.createServer` で `/send` を上流へ渡し、上流の 201 を捨てて `408 text/html` を返す）を挟む。切断の版は陰性の対照（今も緑。照会が `sent` を読む） | `message-dispatch.ts:136` の `statusCode < 500 → not_sent` で relay の取り下げと note の close |
| T11 | I4 | `tests/unit/lib/relay/relay-bind-settle-4535.test.ts` `a failed settle keeps sent as sent and not_sent as not_sent; relaySettled is false`・`the weaker of the body's and the binding's outcome wins` | `not_sent` が `unknown` になる |
| T12 | 陽性対照（I5） | `send-outcome-4535.test.ts` `control: 409 PROMPT_WAITING with not_sent — withdrawn and closed`・`control: 409 SEND_TARGET_CHANGED not_sent — exit 34, withdrawn`・`control: model_refused 400 with not_sent — Auto-Yes withdrawn, "safe to send again"` | 緑のまま |
| T13 | C4（I10） | `tests/unit/app/api/worktrees/send-preflight-outcome-4535.test.ts` `no refusal before the send service answers without sendOutcome`: `sendUserMessage` を「呼ばれたら試験を落とす」偽物にし、拒否を起こす入力を並べる（worktree 無し・壊れた本文・`ask` の衝突・`RELAY_BIND_INVALID`・`model_refused` の早い検査と遅い検査・`INVALID_PATH` の 2 か所）。どの答えにも `sendOutcome: 'not_sent'`。`RELAY_BIND_CONFLICT` は `unknown`。入力は**すべて `relayId` 無し**で並べる。**変異**: 包みの規則を外すと全部赤（一覧ではなく規則を守る）。結び付いた relay の予約の後の拒否（`model_refused` の遅い検査・2 回目の `INVALID_PATH`）は、規則を外しても `finish` の `!boundaryWritten → not_sent` で緑のままなので、結び付いた版は T11（`finish` の側）に置く。brief の 409 は `sendUserMessage` の偽物が `brief_choice` を返す形で別に 1 本 | `sendOutcome` が undefined |
| T14 | N5（旧サーバー） | `send-outcome-4535.test.ts` `an older server's typed refusal (model_refused, no sendOutcome) is not_sent` と対の陰性 `a 400 with no code ({ error } only) is unknown` | 1 本目は今も緑、2 本目は今は `not_sent` で赤。旧規則（4xx なら `not_sent`）に戻す変異で 2 本目が赤 |
| T15 | N1 | `tests/unit/lib/new-task/send-new-task-outcome-4535.test.ts` `500 sendOutcome unknown is kind unknown`・`a send that times out is kind unknown`・`control: the Auto-Yes request failing is still auto_yes_failed`、`tests/unit/components/new-task/NewTaskDialog-unknown-4535.test.tsx` `a second press after unknown asks first and sends once` | kind が `failed`、2 回目の押下で POST |
| T16 | C10・C12 | `tests/unit/hooks/usePendingMessages-unknown-4535.test.tsx` `a proxy 4xx without sendOutcome is unknown`・`control: 401 AUTH_REQUIRED is not unknown`、`tests/unit/middleware-send-codes-4535.test.ts` `401 and 403 on /api carry a code` | false、code が無い |
| T17 | I6 | T9 のファイル `a 308 from a front is followed once — the handler sees one POST, exit 0`（前段の `http.createServer` が 308 で同じ後段の `/send` を指し、後段で POST を数える） | 緑（今も 1 通）。**`redirect: 'manual'` を入れる変異で赤**（exit 99）— C2 の判断を守る |
| T18 | N7 | T9 のファイル `ECONNREFUSED is not_sent — no unknown note, the relay is withdrawn`（閉じたポートへ） | 今は照会に回り、照会も失敗して `unknown` |

### 5.3 期待が変わる既存の試験（段 2 で変えてよいか。Q6）

| 試験 | 今の期待 | 案の後 |
|---|---|---|
| `tests/unit/cli-tools/send-readiness-4040.test.ts:419` `positive: an image dispatch unknown, the path fallback refused — the first unknown is kept` | `dispatch` 2 回、`indeterminate` | `dispatch` 1 回、`indeterminate` |
| `tests/unit/cli-tools/opencode-send-api-2035.test.ts:276` `refuses a read-back whose text is not what was sent` | `submitMock` 1 回（キーボードに打つ） | 0 回、`indeterminate` で投げる |
| `opencode-send-api-2035.test.ts:290` `refuses a read-back that is not the user's message` | 同上 | 同上（`mismatch`／梯子の尽きのどちらかを段 2 で確かめる） |
| `opencode-send-api-2035.test.ts:249` `falls back to the keyboard when the server discarded the message` | 1 回目の 404 で打つ | 梯子の最後まで 404 を返す偽物にして、打つ（意図は同じ） |
| `tests/unit/cli/commands/relay-bind-cli-3957.test.ts:176` `negative control — a legacy relay is withdrawn on any failure, as before` | 500 でも取り下げる | 500（`unknown`）では取り下げない。**同じ所に陽性の対照を足す**: 旧サーバーの relay も型つきの `not_sent`（N1・N5）なら取り下げる（旧サーバーで relay を 24 時間残さない意図を弱めない） |
| `relay-bind-cli-3957.test.ts:196` `409 RELAY_BIND_CONFLICT: another attempt owns it — NOT withdrawn` | 取り下げない | 同じ（名前の「another attempt」は写しのことと注を足すだけ。期待は変わらない） |
| `relay-bind-cli-3957.test.ts:309・338` `negative control: an error with no sendOutcome … adds neither note` | 注意 0 | unknown の注意 1（C5） |
| `tests/unit/hooks/usePendingMessages-unknown-4503.test.tsx` の 4xx の対照（段 2 で行を特定） | 4xx は not unknown | C10 のとおり |
| `tests/unit/lib/security/auth-challenge-3090.test.ts:154・168`（`/api/*` の 401 を `{ error: 'Unauthorized' }` の `toEqual` で固定） | `code` 無し | `code: 'AUTH_REQUIRED'` が付く（C12） |
| `auth-challenge-3090.test.ts:161`（画面の道 `/sessions` に `accept: application/json`）・`tests/integration/api-fs-browse.test.ts:107`（route 自身の 401、`src/app/api/fs/browse/route.ts:54`） | `{ error: 'Unauthorized' }` | **変えない**（C12 は middleware の `/api/*` だけ。変わったら規則の範囲の誤り） |

---

## 6. PR の割り方と境

並べる PR どうしは同じファイルを触らない。直列の PR は、文書の**段落の持ち主**を決めて同じファイルを順に触る（衝突させない）。

| 順 | PR | 中身 | 触るファイル（見込み） | 依存 |
|---|---|---|---|---|
| 1 | **A1 OpenCode（R1）** | C7・C8・Q5、§2.3 の読み戻し。実の二重送信を止める本体。公開の契約の変更は C7・C8 だけで、route・CLI に依らない | `src/lib/cli-tools/opencode.ts`、`src/lib/hooks/sources/opencode/client.ts`、`src/lib/session/send-attempt-types.ts`（reason）、試験 T1〜T6、§5.3 の OpenCode の 4 行。文書: `cli-operations-guide.md` の `:1343` と `lastSend` の reason の段落、英語版の同じ所 | なし |
| 2 | **A2 route・relay・middleware** | C4（§2.4 の規則。`RELAY_BIND_CONFLICT` は `unknown`）・C6・C12、包みの弱い方の規則 | `src/app/api/worktrees/[id]/send/route.ts`、`src/lib/relay/relay-bind.ts`、`src/middleware.ts`、試験 T11・T13・T16 の middleware。文書: `:1346`（`sendOutcome` の段落）と英語版 | A1 の後（文書の同じファイル） |
| 3 | **B CLI** | C1・C3・C5・§3.1・N4〜N8 | `src/cli/commands/message-dispatch.ts`・`send-messages.ts`・`send.ts`・`ask.ts`、`src/cli/utils/api-client.ts`（`content-type`・`cause.code`）、`src/cli/utils/api-client-errors.ts`、`src/cli/types/api-responses.ts`（`relaySettled`）、`src/cli/docs/agent-operations.ts`、試験 T7〜T10・T12・T14・T17・T18、§5.3 の relay-bind-cli の行。文書: `:765–768`・`send --help`、英語版 | A2 の後（N4 の答えと C4 が要る。旧サーバーは N5 で救う） |
| 4 | **C 画面** | C9・C10 | `src/lib/new-task/send-new-task.ts`、`src/components/new-task/NewTaskDialog.tsx`・`NewTaskDialogParts.tsx`、`src/hooks/usePendingMessages.ts`、`locales/{ja,en}/common.json`、試験 T15・T16 の画面 | A2 の後（C10 は C4・C12 に依る）。B とは触るファイルが重ならないので並べてよい |

C4 は A2 で、`RELAY_BIND_CONFLICT` に `not_sent` を付けない形でしか出さない（旧い CLI ＋ 新しいサーバーで「送り直してよい」が出ないため）。

境:

| 相手 | この Issue | 相手の側 |
|---|---|---|
| #4534（済み） | 3 値の名前と `sendOutcome` の読み。exit 34・99 は変えない | 柵が断った試行の state |
| #4518 | 新しい拒否（`EXACT_TARGET_MISMATCH` など）は、試行を記録しないなら C4 の規則が `not_sent` を付ける。記録するなら試行の state から付く | exact の宛先の指定。#4518 は #4535 の後に載る |
| #4503 | PR-B1（agy の読み戻しが未送信を送信済みにしない）と対。PR-B2 の `isSendOutcomeUnknown` に C10 を足す。PR-B3（`clientSendId`）は範囲の外 | 資産 `feature/4503-readback-assets`（`c38259e9c`）はこの設計では使わない |
| #4466 | operationKey（冪等）と S4 の一括の確定は範囲の外。`relaySettled` は S4 の「事実と後始末を別々に確定」の小さな先行。relay の無い送信の前段の再試行（§2.1）は operationKey で扱う | PR3 |
| #4417 | 画面の再試行の古い応答は範囲の外 | — |
| 別の Issue（新） | timer が送信の `indeterminate` を `failed` と書く（`timer-manager.ts:168`）。C8 の後は OpenCode の unknown がここに来る。timer の表示で「届いたか分からない」を分ける | 追跡票に起こす（PM） |

---

## 7. 未決だったもの（**決定済み**: 推奨どおり。Q13 は (b)）

| # | 問い | 勧め |
|---|---|---|
| Q1 | §4 の公開の契約（C1〜C12）をこの形で入れるか。exit が 0 → 99 に変わるのは C1（空・形の違う 2xx）と C8（OpenCode の unknown の後の fallback の成功）の 2 か所。C8 は timer（`sent`→`failed`）・relay の配送（配送済み→`holdUncertain`）・画面（201→500 `unknown`）も変える。redirect は追い続ける（C2）ので 3 か所目は無い | 入れる。どちらも「送れたか分からない」を「送れた」と言う今の誤りの直し。**決定: 推奨どおり** |
| Q2 | 旧サーバー（C4 の前）の型つきの拒否を、CLI が code の一覧（N5）で `not_sent` と読むか。読まないなら、旧サーバーとの組で 400・`ASK_ID_CONFLICT`・`model_refused` などの後に relay・note が 24 時間残る | 読む。一覧は §2.4 の N5 に限る（`RELAY_BIND_CONFLICT`・`code` の無い 400・404 は読まない）。**決定: 推奨どおり** |
| Q3 | 結び付いた relay の照会の `failed` を当該の試行の記録と言えるか | 言える（`failed` を書くのは当該の試行の `settle` だけ、relay は CLI ごとに 1 試行）。**決定: 推奨どおり** |
| Q4 | C3: `unknown` に専用の exit を足さず、今の状態コードの写し（1・2・99）のままにするか。前段の素の 400・401・403 では exit 2 と unknown の注意が重なる | 足さない。exit は状態コードの写しとして使われており、3 値は stderr の `sendOutcome=<値>` で読む。重なりは前段の素の 4xx に限られる（C4・C12 の後）。**決定: 推奨どおり** |
| Q5 | OpenCode の 5xx・3xx を `unknown` にするか（今は `not_sent` でキーボードに進む）。`unknown` にすると、OpenCode のサーバーが 5xx を返す間、送信は毎回 `indeterminate` で止まる | `unknown` にする。段 2 で OpenCode の `prompt_async` が 5xx を返す実の場面（モデルの指定の誤りなど）を 1 つ測り、利用者の常の操作で毎回止まる場面が無いかを確かめる。あれば人に戻す。**決定: 推奨どおり**（実の場面は A1 の後にリーダーが測る） |
| Q6 | §5.3 の既存の試験の期待を段 2 で変えてよいか | 変えてよい（契約に明記する）。`relay-bind-cli-3957.test.ts:176` には旧サーバーの陽性の対照を足す。**決定: 推奨どおり** |
| Q7 | K1: U-0（確認なしに同じ本文を二度送らない）が、利用者の打ち直しまで含むか | 含まない（この Issue では）。打ち直しの検出は冪等の鍵（#4466 PR3・#4503 PR-B3）の範囲。**決定: 推奨どおり** |
| Q8 | K2: 再読み込みで `unknown` の行が消えるのを、この Issue で直すか | 直さない。サーバーに「画面の送信の記録」を持たせる別の Issue に切る。**決定: 推奨どおり** |
| Q9 | §3.4 のダイアログの文と、確認の後の再送を許すか | 確認の後に許す（PR-B2 の `confirmedResend` と同じ形）。**決定: 推奨どおり** |
| Q10 | brief の選び直しの 409（`route.ts:568–574`、code 欄が無い）に `code: 'brief_choice'` を足すか | 足す（C4 の規則で `not_sent` は付くが、旧サーバー互換の N5 と画面の分岐に code が要る）。画面だけの答えなので影響は小さい。**決定: 推奨どおり** |
| Q11 | N4（`RELAY_BIND_CONFLICT`）で照会が `sent` 以外のとき、契約の task を `failed` にするか（写しが届いていれば task は動いている） | 今のまま `failed` にし、照会が `sent`・`failed` 以外のときだけ stderr に「写しが届いているかもしれない」を出す（照会の `sent` は exit 0、`failed` は Q13 (b) の片付けと「送り直してよい」）。task の状態を照会で直すのは #4466 の範囲。**決定: 推奨どおり** |
| Q12 | C12（middleware の 401・403 に code）を入れるか | 入れる。status は変えず、`/api/*` の JSON に `code` を足すだけ。**決定: 推奨どおり** |
| Q13 | N4（`RELAY_BIND_CONFLICT`）で照会が `failed` のとき、relay・note・Auto-Yes をどうするか。`failed` の relay の `state` は `pending` のまま（`settleRelaySendState` は `send_state` だけを変える、`relay-bind-db.ts:429–440`）で、閉じるのは CLI の `cancelRelay` だけ。(a) 残す（第 2 版）: stderr は「送り直してよい」なのに、古い relay と note が 24 時間残り、Auto-Yes も残る（#4116 が避けた「届かなかった送信の Auto-Yes が他の仕事に答える」）。(b) 照会が `failed` なら `relayOwned` を true に戻し、取り下げ・close・Auto-Yes の取り下げをする: `failed` を書くのは結び付いた唯一の試行の `settle` だけ（Q3）で、その試行は何も打っていない。ただし「写しが予約した後に何も打たずに終わった」の読みは照会 1 回に依る | (b)。Q3 と同じ論で照会の `failed` は「この依頼は届いていない」の証明になり、`not_sent` の扱い（I5）と揃う。二重送信・取り消しの誤りはどちらでも起きない。**決定: (b)**（PR-B で `applyRelayLookup` と T8 を直す） |

---

## 8. 段 1（公開の値に触らない足場と内部の分類）

人の答え（Q1〜Q13）の前に、公開の値（exit・HTTP の status・code・本文の欄・stdout/stderr の文・画面の文・`lastSend.reason`）に触らない部分だけを入れる（#4534 PR-B の段 1 と同じ形）。

| もの | 所 | 中身 |
|---|---|---|
| 送信の答えの分類 | `src/lib/send-outcome/classify-send-answer.ts` | §2.2 の S・N・U の行を純粋な関数 `classifySendAnswer(answer)` にする。入力は「この要求の応答」を表す値（`{ kind: 'response', status, contentType, bodyText }` か `{ kind: 'error', error }`）。出力は `{ fact, row, relayOwned, consultRelay }`（`row` は表の行の名前、`consultRelay` は照会を勧める行）。照会の結果は `applyRelayLookup(classified, sendState)` で足す（`sent`→`sent`・`failed`→`not_sent`、証明つきの行と `relayOwned` は変えない）。照会そのもの・後始末・exit・文は持たない。試験 `tests/unit/lib/send-outcome/classify-send-answer-4535.test.ts` |
| OpenCode の dispatch の分類 | `src/lib/send-outcome/opencode-dispatch-outcome.ts` | §2.3 の表: `prompt_async` の答え（status・content-type・応答なし）→ `accepted`／`not_sent`／`unknown`、読み戻しの梯子の答えの列と梯子の長さ → `delivered`／`not_sent`／`unknown`（`classifyOpencodePromptAnswer`・`classifyOpencodeReadbacks`）。試験 `tests/unit/lib/send-outcome/opencode-dispatch-outcome-4535.test.ts` |
| 試験の偽のサーバー | `tests/helpers/send-outcome-server-4535.ts` | 本物の `http.createServer`（ポート 0、`127.0.0.1`）で、`/send` の答え（空の 2xx・非 JSON・HTML の 408・307/308・切断）を返す。ハンドラーに届いた POST を数える。閉じたポート（ECONNREFUSED）を作る補助。補助自身の試験 `tests/unit/helpers/send-outcome-server-4535.test.ts` は本物の `fetch` で答えた形がそのまま届くことを確かめる |

- どの module も**どこからも呼ばない**（段 2 で CLI・route・画面・OpenCode の送信器に配線する。配線は人の答えの後）。だから公開の値は 1 つも変わらない
- 試験は表ごとに置き、分類の各行を外す変異（たとえば `RELAY_BIND_CONFLICT` を `not_sent` に倒す、`sendOutcome` の無い 4xx を `not_sent` に倒す、404 の梯子を 1 回目で決める）で赤になることを確かめる
- Q13 は未決なので、分類は N4 の `failed` の照会について「事実は `not_sent`、`relayOwned` は false（第 2 版の既定）」を返し、段 2 で答えに合わせる

