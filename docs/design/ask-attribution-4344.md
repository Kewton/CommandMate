# ask の返答を依頼に結ぶ — 送信 ID と native transcript の対応（Issue #4344）設計

- 段: 設計（この文書だけ。コードは書かない）。実装は事前レビュー（2-4-4）の後、§6 の 3 本の PR で行う
- 人の決定: **案 A を採る**（2026-11-13 13:14 JST、Issue #4344 のコメント）。対応する CLI から順に広げ、未対応の CLI（native transcript を持たない pane-only の tool）と旧サーバーでは `ask` が返答を自動で回収しない挙動の変更を受け入れる
- 基準: develop `a823cdd2b`。行番号はこの時点のもの（実装の着手時は名前で探し直す）。「事実」は file:line、「見立て」「未確認」は明記する
- 材料: Issue #4344 本文（不変条件 1〜7）、イネーブラーの設計調査（`workspace/orchestration/runs/2026-11-13/enabler-return-4315-ask-design.md`。リポジトリ外）、#4315 のレビュー 2 回（同 `review-4315.md`・`review-4315b.md`）

## 0. 最初に決めること（この節が以降の前提）

### 0.1 最初に対応する adapter の範囲

| tool | 最初の対応 | 理由（事実／見立て） |
|---|---|---|
| `claude` | **PR2 で対応** | native transcript の user record に record 単位の id がある（`src/lib/hooks/sources/claude/history.ts`・`transcript.ts`）。境界は record の順序から組み立てる（見立て: 封筒入りの user record → 次の user record までの assistant 行で 1 turn を閉じられる。fixture で確かめる） |
| `codex` | **PR2 で対応（claude と同じ PR。fixture の対照が通らなければ capability を false のまま出す）** | turn に `turn_id`、prompt に `UserMessage` の `item.id` があり、1 turn に複数の prompt を収容しうる（`src/types/agent-transcript.ts:339` `codexTurnRequestId`・`:352` `codexPromptRequestId`、`recordCodexUserTurns` `src/lib/hooks/sources/codex/history.ts:625`）。共有 turn を検知できるので ambiguous を返せる |
| `command-code`・`antigravity`・`opencode`・`opencode-v2` | 後続の Issue（1 tool ずつ） | transcript の reader はある（`src/cli/utils/reply-ledger.ts:68` `TRANSCRIPT_READER_TOOLS`、`src/lib/relay/relay-bound-reply.ts:133`）が、封筒が user record に残るか・共有 turn を検知できるかが未確認 |
| `copilot`・`gemini`・`vibe-local` | 対応しない（pane-only） | native transcript の reader が無い（`relay-bound-reply.ts:139-141` が false）。人の決定どおり返答を自動で回収しない |

capability は **adapter ごとに、§6 PR2 の fixture の対照（封筒を含む実入力 → native 入力 ID → 完了 turn の assistant 行）が通ったものだけ true** にする。対照の無い tool を true で広告しない。

### 0.2 未対応の CLI・旧サーバーでの `ask` の出力

送信と待機は今までどおり行い（送信回数を変えない・終了コードを変えない＝不変条件 6）、**返答の回収だけをやめる**。画面へは降りない。

| 状況 | 送信 | stdout（本文モード） | stderr（1 行） | JSON | exit |
|---|---|---|---|---|---|
| 対応済み tool・対応済みサーバー・`matched` | する（封筒つき） | 返答本文 | なし | `source:"history"`、`reply:<本文>`、`askId`、`attribution:{state:"matched"}` | 0 |
| 未対応の tool（`copilot` など） | する（封筒なし） | 空 | `reply not collected: <tool> has no ask attribution (tool_unsupported); look with \`capture <wt> --instance <id> --pane\`` | `source:"none"`、`reply:null`、`askId:null`、`attribution:{state:"unavailable",reason:"tool_unsupported"}` | 0 |
| 旧サーバー（`GET /api/asks/capabilities` が 404） | する（封筒なし・旧 body のまま） | 空 | 同上（reason は `server_unsupported`） | 同上（reason `server_unsupported`） | 0 |
| 対応済みだが確定しない（ambiguous／unmatched） | する（封筒つき） | 空 | `reply not collected: <reason>; ...` | `source:"none"`、`reply:null`、`askId`、`attribution:{state, reason}` | 0 |
| wait が失敗（exit 10／20／21／124、upstream fault） | 既存どおり | 既存どおり | 既存どおり | 既存どおり | 既存どおり |

- **送信前に断らない理由**: 人の決定の文言は「返答を自動で回収しない」であり「送らない」ではない。送信前に断ると未対応の tool で `ask` 自体が使えなくなり、新しい exit code も要る。イネーブラーの案（送信前に設定エラー）より変更が小さく、不変条件 6 とも合う。
- `--async` は対象外（relay の経路。不変条件 7）。
- 既存の `overlapped` の stderr 行と `"overlapped": true` は残す（`src/cli/commands/ask.ts:479`・`:505`）。overlap が立っても `matched` の判定は台帳だけで行う（overlap は警告、帰属は台帳）。
- capability の読み取りが 404 以外で失敗した（ネットワーク等）ときは、送信も同じサーバーへ行うので既存のエラー処理に任せる（`handleCommandError`）。台帳の無い送信へ黙って落とさない。

### 0.3 DB の migration の番号

**この文書には書かない。** 着手時（PR1）に `src/lib/db/migrations/` の最新版を見て決める（並行の Issue が先に版を取りうるため）。

## 1. 今の経路（事実）と、画面で 2 回失敗した経緯

### 1.1 同期 `ask` の経路

`resolveCommandTarget`（`ask.ts:603`）→ `askedAt = Date.now()`（`:614`）→ `postMessage`（`:644`）→ `pollWorktree`（`:681`。wait と同じ poller）→ 成功なら `readAskReply`（`:711`）→ `readOverlapLedger`・`detectOverlap`（`:716-729`）→ `printAskReply`（`:734`）→ exit 0。

`readAskReply`（`ask.ts:323`）は history → pane → none:

- history: `readLatestReply`（`:187`）が `/messages` の直近を読み、`replyCandidates`（`reply-ledger.ts:130`。`askedAt` 以降の assistant 行）から `pickLatestReply`（`:164`。transcript 由来の印のある最新）を選ぶ。transcript の reader がある tool は最大 15 秒待つ（`REPLY_TURN_ROW_GRACE_MS` `ask.ts:91`）。**送信との一致は見ていない**（時刻と「最新」で選ぶ）。
- pane: `readPaneTail`（`:232`）→ `readSqueezedPaneTail`（`src/cli/commands/capture.ts:384`）で 1000 行（`PANE_CAPTURE_LINES` `capture.ts:42`）を取り、squeeze して末尾 80 行（`PANE_FALLBACK_TAIL` `ask.ts:70`）。capture API が返すのは `output` だけ（`src/app/api/worktrees/[id]/capture/route.ts:97`）で、依頼・turn・世代の対応情報は無い。
- `agent` は `resolveCommandTarget` が常に解決するので（`ask.ts:609`）、history が空なら全 tool で pane へ降りる。

### 1.2 画面の帰属が 2 回失敗した経緯（#4315 の 5-2b）

1. 末尾 80 行の制限を外して画面全体を読む → 旧い返答（305 行目）が今回の reply に混ざる（review-4315 の指摘 P2）。
2. 依頼本文の接頭一致で依頼行を探し、その後ろだけを読む → 旧い `⏺ history` を依頼 `hi` と誤認し、正しい返答 `⏺ hi` を依頼行として捨てる（review-4315b の指摘 1）。

画面しか入力に持たない判定は「旧い返答が残っている」と「同じ文で答え直して再描画した」を区別できない（同じ capture になりうる）。だから画面は返答の証拠にしない。

### 1.3 既存の ID が送信 ID の代わりにならない理由（事実）

- `<tool>-turn:<id>` は native turn の由来を示す ID で、ask の送信 ID ではない。
- `recordUserTurn`（`src/lib/history/user-turn-recorder.ts:203`）は send 行を本文の正規化（`normalizeUserTurnContent` `:170`）・時間窓・近い時刻で採用する。同文の連続送信を厳密に区別できない。
- codex は 1 turn に複数の prompt を収容し、prompt item ID と turn ID は別物（`agent-transcript.ts:339,352`）。接頭辞の置換で対応は作れない。

## 2. 不変条件（Issue の 1〜7 を設計の言葉で）

1. **帰属の連鎖**: 返答は `askId` → 実際に受け付けられた入力（封筒つき）→ native の user record（prompt）→ その prompt が属する**完了した** turn → その turn の assistant 行、の連鎖で選ぶ。本文・接頭一致・行位置・時刻・「最新」で代用しない。
2. **宛先の固定**: 予約時に worktree・解決済み instance・tool・session の世代を台帳に固定する。別の宛先、再起動・`/clear` 後の同名 instance、古い transcript の遅着は採らない。世代が不明なら確認済みと扱わない。
3. **同文を保存**: 依頼と返答が同文（`hi` に `hi`）でも、role と対応が正しければ返す。本文を比べて依頼か返答かを決めない。同文を 2 回送っても `askId` は別。
4. **共有 turn は ambiguous**: 1 つの turn に別の入力（別の ask・手入力・画面からの送信）が入っていたら、特定の依頼への返答と断定しない。native 側に個別の対応が無ければ `ambiguous`、`reply=null`。
5. **確定しないものは空欄**: 読めない・対応なし・欠損・未完了・曖昧は `source=none, reply=null`。画面や別 turn で穴埋めしない。結果不明の send を再送しない。
6. **完了と回収は別**: wait の成功は処理の終了であって帰属の証拠ではない。既存の終了コードを保ち、返答が無くても終了済みなら exit 0。理由は JSON の `attribution.reason` と stderr の 1 行で言う。
7. **既存の読者を変えない**: `capture`（raw・`--tail`・`--follow`）・`transcript-squeeze`・capture API・`wait-verify`・一般の `reply`（「最新の返答を読む」）・async relay の振る舞いを変えない。共有 helper を変える必要が出たら、その全読者を列挙し直してから決める。公開版 skill の `ask.sh`（`.claude/skills/cmate-delegate-dev/scripts/ask.sh`・`.agents/skills/...` の写し）には触れない — 旧経路の修正と publish は人へ（commandmate-skills 側）。

## 3. 仕組み（案 A）

### 3.1 部品

| 部品 | 置き場所（候補） | 役割 |
|---|---|---|
| 台帳 | 新規テーブル（migration。番号は §0.3）、新規 `src/lib/db/ask-correlation-db.ts`、型 `src/types/ask-correlation.ts` | 1 行 = 1 askId。`askId / worktreeId / instanceId / cliToolId / sessionGeneration / bodyDigest / sendState / sentMessageId / nativeInputId / nativeTurnKey / assistantMessageIds / attributionState / reason / createdAt / updatedAt` |
| send の入口 | `src/app/api/worktrees/[id]/send/route.ts`（`POST` `:86`、`sendUserMessage` 呼び出し `:380`）、`send-request.ts`、`src/lib/session/send-user-message.ts`（`sendUserMessage` `:357`）、新規 `src/lib/session/ask-correlation.ts` | body の任意フィールド `ask: { id, protocol }` を受け、予約 → 封筒つきで入力 → 送信結果を記録 |
| 封筒 | `ask-correlation.ts` | 実際に agent へ渡す入力（brief の合成の後、入力の境界）に、版と askId を持つ機械用の 1 行を付ける。モデルに復唱は求めない |
| reader | `src/lib/hooks/sources/{claude,codex}/history.ts`（PR2）、共通 `transcript-history.ts` | native user record から封筒を回収し、その prompt が属する完了 turn と assistant 行を台帳に結ぶ |
| 読取 API | 新規 `src/app/api/asks/capabilities/route.ts`、`src/app/api/asks/[askId]/route.ts` | capability（protocol 版・tool ごとの対応）と、askId による台帳＋保存済み assistant 行の読み取り |
| CLI | `src/cli/commands/ask.ts`、新規 `src/cli/utils/ask-reply.ts`、`src/cli/commands/message-dispatch.ts`、`src/cli/types/api-responses.ts` | askId の生成・capability の確認・送信・wait 後の台帳読み・出力 |

### 3.2 規則

- **askId** は同期 `ask` だけが UUID で作る。`send`・`--async`・画面の送信は付けない（付けない送信の振る舞いは変えない）。
- **予約**: 同じ askId・同じ bodyDigest の再 POST は状態を返すだけ（追加の入力 0）。同じ askId・別の本文は 409（追加の入力 0）。予約と送信結果の記録は別の短い transaction（入力の間 transaction を保持しない）。
- **送信結果**: 既存の `not_sent`／prompt 待ち／role 不一致の拒否は台帳を `not_sent` にして既存どおり返す。結果不明（unknown）は `send_unknown` のまま。再送しない。
- **封筒の形**（見立て。PR1 で fixture により確定）: 本文の前に 1 行、`[cmate-ask v1 <askId>]` のような機械用の行。条件は (a) 版を持つ、(b) user record にそのまま残る、(c) 本文中の引用や assistant 側の記述は対応付けに使わない（user record の先頭の封筒だけを読む）、(d) 封筒が 2 つの native 入力に現れたら推定でつながない。
- **順序の逆転**: native user record は send 行より先に届きうる。reader は封筒の askId で台帳を引き、台帳行が未予約なら保留の行として記録し、予約時に合流させる。本文＋時刻で別の行に採用しない。一般の `recordUserTurn` の規則は変えない（ask 専用の採用は `sentMessageId` を使う）。
- **askId を `chat_messages.request_id` に上書きしない**（`src/lib/db/chat-db.ts:72`）。History の重複防止と native requestId は今のまま。
- **読取**: `GET /api/asks/:askId` は台帳と保存済み assistant 行を返す。直近 N 件から「最新」を選ばない（後から別 turn が 30 件以上増えても自分の本文を読める）。
- **CLI の待ち**: wait 成功の後、既存の 15 秒の grace（`REPLY_TURN_ROW_GRACE_MS`）の中で台帳が `matched`／`ambiguous` になるのを待つ。期限までに確定しなければ `unmatched`（reason つき）。別 turn の終了を今回の完了に読み替えない。
- **capability の出どころは 1 つ**: サーバーの `GET /api/asks/capabilities`。CLI 側に tool の表の写しを足さない（既に `reply-ledger.ts:68`・`relay-bound-reply.ts:133`・`src/components/worktree/ChatMessageBubble.tsx:465` に同種の表が 3 つある）。

### 3.3 帰属の状態と理由

| `attribution.state` | 意味 | reply |
|---|---|---|
| `matched` | 連鎖が完結し、turn に他の入力が無い | 本文 |
| `ambiguous` | 連鎖は完結したが、turn に他の入力がある | null |
| `unmatched` | 対応済みの tool で、期限までに連鎖が完結しなかった | null |
| `unavailable` | tool またはサーバーが未対応で、台帳を使っていない | null |

`pending` は API の途中状態で、CLI の最終出力には出さない。

| `reason` | 状態 |
|---|---|
| `tool_unsupported`・`server_unsupported` | unavailable |
| `shared_turn` | ambiguous |
| `envelope_lost`（封筒の無い user record しか来ない）・`turn_incomplete`・`generation_changed`・`history_missing`・`body_truncated`・`send_unknown`・`grace_expired` | unmatched |

## 4. return・throw・書き込みの表

| 関数（候補） | return | throw | 書き込み／順序 |
|---|---|---|---|
| `reserveAsk(db, {askId, target, bodyDigest})` | `reserved`／`existing`（同 digest。行の状態つき）／`conflict`（別 digest） | DB の失敗だけ（route は 500、入力しない） | 台帳に 1 行 INSERT（短い transaction）。**入力より前** |
| `wrapWithEnvelope(body, askId)` | 封筒つき本文（純関数） | なし | なし。brief の合成の後、入力の境界で 1 回 |
| `sendUserMessage`（既存。ask 分岐を追加） | 既存の結果型（変えない） | 既存どおり | 既存の書き込み＋ `recordSendOutcome`（`sent`／`not_sent`／`send_unknown`、`sentMessageId`、`sessionGeneration`）。**入力の後**、別 transaction |
| reader `recordNativeAskInput(askId, nativeInputId, generation)` | `bound`／`buffered`（台帳未予約）／`rejected`（宛先・世代が不一致、封筒の重複） | なし（読み取りの失敗は記録して続ける。reader の他の読者を止めない） | 台帳を UPDATE。既存の user 行の挿入規則は変えない |
| reader `bindCompletedTurn(nativeTurnKey, inputs[], assistantIds[])` | 各 askId の `matched`／`ambiguous` | なし | 台帳を UPDATE。**turn の完了を読んだ後だけ**。未完了なら何もしない |
| `GET /api/asks/capabilities` | `{protocol, tools:{[cliToolId]:boolean}}` | なし | なし |
| `GET /api/asks/:askId` | 台帳＋本文（`matched` のときだけ）／404（未知の askId） | なし | なし |
| CLI `readAskAttribution(client, askId, deadline)` | `{state, reason, reply}` | 期限切れは throw せず `unmatched/grace_expired` | なし |
| CLI `ask` の本体 | — | 既存の `handleCommandError` | 送信 1 回（再送しない）→ wait → 読み → stdout／stderr → exit |

## 5. 入力×状態の組み合わせの表

| 入力・割込み | 状態 | 結果 |
|---|---|---|
| 上寄せの 1000 行ペイン、返答が 305 行目・下は罫線の余白／通常の画面 | claude・codex、単独 turn | 同じ本文を `matched` で返す（画面の位置・80 行の窓に依存しない） |
| 画面に旧い返答だけ、今回の依頼が画面から消えた | 今回の対応なし | `unmatched`（`turn_incomplete` か `grace_expired`）。旧い返答を採らない |
| 依頼 `hi`、返答 `hi` | 単独 turn | `matched`、reply は正確に `hi` |
| 同文の ask を 2 回 | 別々の askId、別々の turn | それぞれ自分の turn の本文 |
| A と B が同じ codex turn に合流／手入力が同じ turn に追加 | 共有 turn | 両方 `ambiguous`（`shared_turn`）、reply=null |
| 前 turn が send の後に終わり history に入る、今回分は未完了 | 今回の turn 未完了 | `unmatched`（`turn_incomplete`）。前 turn を採らない |
| 別 instance の返答／再起動・`/clear` をまたぐ transcript | 宛先・世代の不一致 | 採らない（reader が `rejected`） |
| native user record が send 行より先に届く | 台帳未予約 | `buffered` → 予約時に合流。本文＋時刻で採用しない |
| 同じ askId で再 POST（同本文／別本文） | — | 状態を返す（入力 0）／409（入力 0） |
| 送信の応答が消える | `send_unknown` | 再送しない。grace 内に native が来れば台帳で確定、来なければ `unmatched/send_unknown` |
| 封筒が user record に残らない | — | `unmatched/envelope_lost`。capability を true にしてはいけない tool（fixture の対照で落とす） |
| 返答の保存の後、別 turn が 30 件以上増える | `matched` | askId で読むので自分の本文 |
| 本文が切れている／履歴が消された | — | `unmatched`（`body_truncated`／`history_missing`）。完全な返答とは言わない |
| `copilot`・`gemini`・`vibe-local` | 未対応 | `unavailable/tool_unsupported`、exit 0、画面へ降りない |
| 旧サーバー（capabilities が 404） | 未対応 | `unavailable/server_unsupported`、exit 0、旧 body で送る |
| wait が exit 10／20／21／124・upstream fault | — | 既存どおり（台帳は読まない） |
| `--async` | — | 既存どおり（台帳を使わない） |

## 6. PR の分け方

各 PR は**直す前に赤になる試験**を先に置き、陰性対照（今までどおりの動き）を同じ PR に置く。未使用の API だけを先に足して終わらせない（各 PR は単体で意味のある不変条件を固定する）。

### PR1: 相関の台帳（DB の migration）と send の入口の予約・封筒

- 書くもの: migration（番号は着手時）・`ask-correlation-db.ts`・型・`ask-correlation.ts`・send の route／`send-request.ts`／`send-user-message.ts` の ask 分岐・`GET /api/asks/capabilities`（全 tool false で出す）
- 赤の試験（直す前に落ちる）: 隔離 DB と mock 送信の integration で (1) 同じ askId の 2 回目は入力 0、(2) 別本文は 409、(3) 封筒が brief の合成の後・入力の境界で 1 回だけ付く、(4) `not_sent`／prompt 待ち／role 不一致で台帳が `not_sent`、(5) `chat_messages.request_id` に askId が入らない
- 陰性対照: `ask` フィールドの無い送信は本文・応答・書き込みが変わらない（既存の send の integration）

### PR2: 最初の adapter の reader（claude・codex）

- 書くもの: `claude/history.ts`・`codex/history.ts`（と必要な transcript parser）で native user record からの封筒の回収と完了 turn の対応、`GET /api/asks/:askId`、capability を fixture の通った tool だけ true に
- 赤の試験: parser の fixture で (1) 封筒つき入力 → native 入力 ID → 完了 assistant 行が `matched`、(2) codex の 1 turn に 2 つの prompt → 両方 `ambiguous`、(3) 未完了 turn は何も結ばない、(4) 世代違い・別 instance は `rejected`、(5) user record が send 行より先 → 合流、(6) 封筒が無い → capability を true にできない（対照で落ちる）
- 陰性対照: 既存の history の行（`<tool>-turn:`・user 行の採用・重複防止）が変わらない

### PR3: ask の CLI と読取 API の利用・docs ja/en

- 書くもの: `ask.ts`・`ask-reply.ts`・`message-dispatch.ts`・`api-responses.ts`、`ask` の help、`src/cli/docs/agent-operations.ts`、`docs/user-guide/cli-operations-guide.md` と `docs/en/user-guide/cli-operations-guide.md` の `## commandmate ask` 節（帰属の状態・未対応 tool の挙動の変更）
- 赤の試験（CLI の route 別 mock。新 API が無いことによる赤にしない）: (1) wait 成功・messages 空・1000 行の 305 行目に返答・罫線の余白・自分の askId の API に確定本文 → **reply の全文一致**（今は末尾 80 行を返すか返答を得られず赤）、(2) `hi` と旧 `⏺ history` だけの画面・対応なし → none（今は pane を採るので赤）、`> hi`／`⏺ hi` と対応済み本文 `hi` → reply は `hi`、(3) 前 turn が send 後に終わって history に入り今回分は未完了 → none（今は時刻窓で旧 turn を選べるので赤）、(4) 同文の 2 入力が同じ turn → ambiguous・reply=null（今は警告だけで reply を返すので赤）、(5) `copilot` → `unavailable/tool_unsupported`・画面を読まない・exit 0（今は pane を返すので赤）、(6) capabilities が 404 → `server_unsupported`・旧 body で 1 回送る
- 陰性対照: exit 10／20／21／124・upstream fault・instance の別名解決・`--async`・`overlapped` の行・`capture --tail`／`--follow`・一般の `reply`
- 既存の pane を前提にした ask の試験（`tests/unit/cli/commands/ask-*.test.ts` の pane 採用）は消さず、期待値の変更理由を各試験に書く（人の決定による挙動の変更）。`readSqueezedPaneTail`（`capture.ts:384`）は ask から呼ばれなくなるが、`capture.ts` は変えない（不変条件 7）

## 7. 未確認のこと

- 実機の send・ask・capture、テストの赤／緑は未実施（コードを読んで設計した）。
- 封筒が全 version の claude・codex で user record にそのまま残るか、モデルの返答に影響しないか（PR1／PR2 の fixture と、別途許可された隔離環境の実機で確かめる）。
- claude の turn 境界を record の順序から組み立てる方法が、tool 使用を挟む turn・compact・画像を含む入力でも一意に閉じるか。
- session の世代（`sessionGeneration`）を何で確定するか（native の session id か CommandMate の起動世代か）。既存の submit receipt は claude 限定・メモリ上で、永続の代わりにならない（イネーブラーの調査。未再確認）。
- 履歴削除・worktree の削除・ID の変更（`worktree-id-rename`）のときの台帳の寿命。
- brief・`/clear`・compact・手入力・OpenCode V1/V2 に封筒が与える影響（対応 tool を広げる後続の Issue で詰める）。
