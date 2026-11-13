# ask の返答を依頼に結ぶ — 送信 ID と native transcript の対応（Issue #4344）設計

- 段: 設計（この文書だけ。コードは書かない）。§7 は 2026-11-13 13:51 に人が決めた。実装は §6 の PR の並びで行う（PR1 は claude）
- 人の決定: **案 A を採る**（2026-11-13 13:14 JST、Issue #4344 のコメント）。対応する CLI から順に広げ、未対応の CLI（native transcript を持たない pane-only の tool）と旧サーバーでは `ask` が返答を自動で回収しない挙動の変更を受け入れる
- 基準: develop `a823cdd2b`。行番号はこの時点のもの（実装の着手時は名前で探し直す）。「事実」は file:line、「見立て」「未確認」は明記する
- 材料: Issue #4344 本文（不変条件 1〜7）、イネーブラーの設計調査（`workspace/orchestration/runs/2026-11-13/enabler-return-4315-ask-design.md`。リポジトリ外）、#4315 のレビュー 2 回（同 `review-4315.md`・`review-4315b.md`）
- 改訂: 第 2 版。事前レビュー（2-4-4、`prereview-4344-reply.md` の必須 M1〜M7・推奨 R1〜R3・質問 Q1〜Q3）を反映。どの指摘をどこに入れたかは §10

## 0. 最初に決めること（この節が以降の前提）

### 0.1 最初に対応する adapter の範囲

| tool | 最初の対応 | 理由（事実／見立て） |
|---|---|---|
| `claude` | **PR1 で対応（縦に一本通す。§6）** | native transcript の user record に record 単位の id がある（`src/lib/hooks/sources/claude/history.ts`・`transcript.ts`）。ただし turn 中に割り込んだ入力は prompt record ではなく `queue-operation`（remove, `absorbed_mid_turn`）と `queued_command` の attachment として残り、hook も発火しない（`src/lib/hooks/sources/claude/queued-notice.ts:10-18`）。今の `buildClaudeTurns`（`transcript.ts:804`）はこれを turn の入力に数えない。**これを数えるまで capability を true にしない**（§3.2 M1） |
| `codex` | **PR2 で対応** | turn に `turn_id`、prompt に `UserMessage` の `item.id` があり、1 turn に複数の prompt を収容しうる（`src/types/agent-transcript.ts:339` `codexTurnRequestId`・`:352` `codexPromptRequestId`、`recordCodexUserTurns` `src/lib/hooks/sources/codex/history.ts:625`）。共有 turn を検知できるので ambiguous を返せる（見立て。PR2 の fixture で確かめる） |
| `command-code`・`antigravity`・`opencode`・`opencode-v2` | 後続の Issue（1 tool ずつ） | transcript の reader はある（`src/cli/utils/reply-ledger.ts:68` `TRANSCRIPT_READER_TOOLS`、`src/lib/relay/relay-bound-reply.ts:133`）が、封筒が user record に残るか・共有 turn を検知できるかが未確認 |
| `copilot`・`gemini`・`vibe-local` | 対応しない（pane-only） | native transcript の reader が無い（`relay-bound-reply.ts:139-141` が false）。人の決定どおり返答を自動で回収しない |

capability は **adapter ごとに、§6 の表の対照（封筒を含む実入力 → native 入力 ID → 完了 turn の assistant 行、と M1〜M6 の試験）がすべて通ったものだけ true** にする。判定は機械で行う: capability の表（サーバーの 1 か所）を true にする行は、その tool の adapter 対照の試験ファイルが存在し、§6 の M1〜M6 の各ケースを名前で含むことをガードの試験で確かめる（PR1 で claude、PR2 で codex の分を足す）。

**版の判定（H5、2026-11-13 14:55 の人の決定）**: stop_reason を書かない版では turn の完了が観測できない（I5）ので capability を false に絞る。表（`ASK_ATTRIBUTION_MIN_VERSIONS`）に tool ごとの最小版を持ち、サーバーが観測した導入済みの版（`--version`）がそれ以上のときだけ、capabilities API と send の入口で true にする。版が読めないときは false。ガードの試験は、true の tool に最小版があり、その tool の対照の fixture の記録がすべて最小版以上で、assistant 記録がすべて stop_reason を持つことを確かめる（§3.6.3a）。

### 0.2 未対応の CLI・旧サーバー・コマンド本文での `ask` の出力

送信と待機は今までどおり行い（送信回数を変えない・終了コードを変えない＝不変条件 6）、**返答の回収だけをやめる**。画面へは降りない。

| 状況 | 送信 | stdout（本文モード） | stderr（1 行） | JSON | exit |
|---|---|---|---|---|---|
| 対応済み tool・対応済みサーバー・`matched` | する（封筒つき） | 返答本文 | なし | `source:"history"`、`reply:<本文>`、`askId`、`attribution:{state:"matched"}` | 0 |
| 未対応の tool（`copilot` など） | する（封筒なし） | 空 | `reply not collected: <tool> has no ask attribution (tool_unsupported); look with \`capture <wt> --instance <id> --pane\`` | `source:"none"`、`reply:null`、`askId:null`、`attribution:{state:"unavailable",reason:"tool_unsupported"}` | 0 |
| 旧サーバー（`GET /api/asks/capabilities` が 404） | する（封筒なし・旧 body のまま） | 空 | 同上（reason は `server_unsupported`） | 同上（reason `server_unsupported`） | 0 |
| 本文が `/`・`!`・`#` で始まる（M4） | する（**封筒なし・本文はそのまま**） | 空 | 同上（reason は `slash_command`） | 同上（reason `slash_command`） | 0 |
| 対応済みだが確定しない（ambiguous／unmatched） | する（封筒つき） | 空 | `reply not collected: <reason>; ...` | `source:"none"`、`reply:null`、`askId`、`attribution:{state, reason}` | 0 |
| wait が失敗（exit 10／20／21／124、upstream fault） | 既存どおり | 既存どおり | 既存どおり | 既存どおり | 既存どおり |

- **送信前に断らない理由**: 人の決定の文言は「返答を自動で回収しない」であり「送らない」ではない。送信前に断ると未対応の tool で `ask` 自体が使えなくなり、新しい exit code も要る。イネーブラーの案（送信前に設定エラー）より変更が小さく、不変条件 6 とも合う。
- **コマンド本文（M4）**: brief はコマンドの本文に何も付けない（`isSlashCommandBody`、`src/lib/session/session-boundary.ts:68`。`/` で始まる最初の語・`!` で始まる本文。呼び手 `src/lib/session/session-brief.ts:731-737`）。封筒を前に付けると `/compact` がコマンドではなく文章として送られる。`ask` はこの述語に加えて `#` で始まる本文も封筒の対象外にする（claude の `#` の扱いは未確認のため安全側。述語は brief の写しを作らず `isSlashCommandBody` を呼び、`#` だけを ask 側で足す）。
- `--async` は対象外（relay の経路。不変条件 7）。
- 既存の `overlapped` の stderr 行と `"overlapped": true` は残す（`src/cli/commands/ask.ts:479`・`:505`）。overlap が立っても `matched` の判定は台帳だけで行う（overlap は警告、帰属は台帳）。
- capability の読み取りが 404 以外で失敗した（ネットワーク等）ときは、送信も同じサーバーへ行うので既存のエラー処理に任せる（`handleCommandError`）。台帳の無い送信へ黙って落とさない。

### 0.3 DB の migration の番号

**この文書には書かない。** 着手時（PR1）に `src/lib/db/migrations/` の最新版を見て決める（並行の Issue が先に版を取りうるため）。

### 0.4 session の世代（M5。PR1 の着手前に決める＝ここで決めた）

- **送信時に固定するのは宛先だけ**: worktree・解決済み instance・tool。送信時には世代を書かない。
- **世代は reader が封筒入りの record を観測したときの native の session id**（claude の transcript の session id、codex の rollout の session id）。台帳には reader が書く。
- 理由（事実）: 既存の「世代」はプロセスのメモリ上の値しか無い（`src/lib/session/agent-event-state.ts:505-511` の `getAgentEventGenerationStartedAt`。メモリ上の Map、`src/lib/session/prompt-submit-receipt.ts` も globalThis）。送信時に確定させると、サーバー再起動後の最初の ask は必ず世代不明＝`unmatched` になり、`/clear` は世代を変えないので検出もできない。
- 結び付けの条件: 封筒入りの user record と、それを閉じる turn の assistant 行は**同じ native session（同じファイル／同じ session id）の中**にあること。封筒の record が、その instance が今たどっている session（`resolveClaudeSessionId` `claude/history.ts:211`、`resolveCodexSessionId` `codex/history.ts:188`）以外で見つかったら `rejected`（`/clear` 前の session・別 instance の session）。

### 0.5 リポジトリ内の既存の呼び手（M7）

- `scripts/orchestrate/consistency-review.mjs` は `ask --json` に返答の文字列が無いと `no-reply` で exit 1 にする（`:159`・`:782`。`ask` の起動は `:744`）。5-2b（Codex の整合性レビュー）がこれを通る。
- **決定（リーダーの推奨を採る）: 未対応の tool で回収をやめる変更（§6 の PR3）は、codex の capability が true になった後（PR2 のマージ後）にマージする。`consistency-review.mjs` は変えない。**
- 残る影響: codex の利用上限で Antigravity に振り替えた場合、antigravity が対応するまで 5-2b は `no-reply` で止まる。§7 (d) の決定: 振り替え先は claude。
- `.claude/skills/cmate-delegate-dev/scripts/ask.sh`（と `.agents/skills/...` の写し）は JSON と exit code をそのまま通すので壊れない（`ask.sh:210-221`、レビューの読み）。ただし未対応の tool で exit 0・reply null を「空の返答で完了」と読みうる、context-limit の救済（`has_context_limit_error`）は reply の本文を読むので働かない、`SKILL.md:227` は `source` の説明を前提にしている。公開版 skill（commandmate-skills）と出す順番は §7 (c) の決定（skill を先に publish してから PR3）。ask.sh・SKILL.md はこの Issue では触らない。

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
- `recordUserTurn`（`src/lib/history/user-turn-recorder.ts:203`）は send 行を本文の正規化（`normalizeUserTurnContent` `:170`）・時間窓・近い時刻で採用する（`:329-343`）。同文の連続送信を厳密に区別できない。brief が前に付いたときの救済は `afterDeliveredBrief`（`:445`）の `^<<<cmate-brief:` 始まりに限られる。
- codex は 1 turn に複数の prompt を収容し、prompt item ID と turn ID は別物（`agent-transcript.ts:339,352`）。接頭辞の置換で対応は作れない。

## 2. 不変条件（Issue の 1〜7 を設計の言葉で）

1. **帰属の連鎖**: 返答は `askId` → 実際に受け付けられた入力（封筒つき）→ native の user record（prompt）→ その prompt が属する**完了した** turn → その turn の assistant 行、の連鎖で選ぶ。本文・接頭一致・行位置・時刻・「最新」で代用しない。
2. **宛先の固定**: 送信時に worktree・解決済み instance・tool を台帳に固定し、世代は reader が観測した native の session id で固定する（§0.4）。別の宛先、再起動・`/clear` 後の別 session、古い transcript の遅着は採らない。世代が不明なら確認済みと扱わない。
3. **同文を保存**: 依頼と返答が同文（`hi` に `hi`）でも、role と対応が正しければ返す。本文を比べて依頼か返答かを決めない。同文を 2 回送っても `askId` は別。
4. **共有 turn は ambiguous**: 1 つの turn に別の入力（別の ask・手入力・画面からの送信・claude の turn 中に吸収された入力）が入っていたら、特定の依頼への返答と断定しない。native 側に個別の対応が無ければ `ambiguous`、`reply=null`。
5. **確定しないものは空欄**: 読めない・対応なし・欠損・未完了・曖昧は `source=none, reply=null`。画面や別 turn で穴埋めしない。結果不明の send を再送しない。
6. **完了と回収は別**: wait の成功は処理の終了であって帰属の証拠ではない。既存の終了コードを保ち、返答が無くても終了済みなら exit 0。理由は JSON の `attribution.reason` と stderr の 1 行で言う。
7. **既存の読者を変えない**: `capture`（raw・`--tail`・`--follow`）・`transcript-squeeze`・capture API・`wait-verify`・一般の `reply`（「最新の返答を読む」）・async relay・**History の user 行の採用（`recordUserTurn`。封筒の無い入力では何も変えない）** の振る舞いを変えない。封筒を外す処理は「封筒があるときだけ」動く（§3.2 M2）。共有 helper を変える必要が出たら、その全読者を列挙し直してから決める。公開版 skill の `ask.sh`（`.claude/skills/cmate-delegate-dev/scripts/ask.sh`・`.agents/skills/...` の写し）と `SKILL.md` には触れない — 旧経路の修正と publish は人へ（commandmate-skills 側。§7）。
   - **見え方は変わる（意味は変わらない）**: 封筒を付けると ask の本文は必ず 2 行以上になる。claude は複数行の入力を paste として扱うので、claude のペインには本文の代わりに `[Pasted text …]` と封筒が出る。capture の出力の意味・API・squeeze は変わらないが、利用者・UAT・demo-video の見え方は変わる。§7 (b) の決定: 受け入れる。

## 3. 仕組み（案 A）

### 3.1 部品

| 部品 | 置き場所（候補） | 役割 |
|---|---|---|
| 台帳 | 新規テーブル `ask_correlations`（migration。番号は §0.3）、新規 `src/lib/db/ask-correlation-db.ts`、型 `src/types/ask-correlation.ts` | 1 行 = 1 askId。列は `ask_id / worktree_id / instance_id / cli_tool_id / body_digest / send_state / sent_message_id / native_session_id / native_input_id / native_turn_key / assistant_message_ids / turn_open_at_send / attribution_state / reason / created_at / updated_at`（§3.4） |
| send の入口 | `src/app/api/worktrees/[id]/send/route.ts`（`POST` `:86`、`sendUserMessage` 呼び出し `:380`）、`send-request.ts`、`src/lib/session/send-user-message.ts`（`sendUserMessage` `:357`）、新規 `src/lib/session/ask-correlation.ts` | body の任意フィールド `ask: { id, protocol }` を受け、予約 → 封筒つきで入力 → 送信結果を記録 |
| 封筒 | `ask-correlation.ts` | 実際に agent へ渡す入力に、版と askId を持つ機械用の 1 行を付ける（位置は §3.2 M3）。モデルに復唱は求めない |
| reader | `src/lib/hooks/sources/claude/history.ts`・`transcript.ts`（PR1）、`codex/history.ts`（PR2）、共通 `transcript-history.ts` | native user record から封筒を回収して外し、その prompt が属する完了 turn と assistant 行を台帳に結ぶ |
| History の採用 | reader（`claude/transcript.ts` の `createClaudeTurn`） | 封筒は reader が**1 回だけ**外し、`recordUserTurn`（`user-turn-recorder.ts`）は変えない（M2。再指示 2: 本文の先頭が別の封筒で始まっても二重に外さない） |
| 読取 API | 新規 `src/app/api/asks/capabilities/route.ts`、`src/app/api/asks/[askId]/route.ts` | capability（protocol 版・tool ごとの対応）と、askId による台帳＋保存済み assistant 行の読み取り |
| CLI | `src/cli/commands/ask.ts`、新規 `src/cli/utils/ask-reply.ts`、`src/cli/commands/message-dispatch.ts`、`src/cli/types/api-responses.ts` | askId の生成・capability の確認・送信・wait 後の台帳読み・出力 |

### 3.2 規則

- **askId** は同期 `ask` だけが UUID で作る。`send`・`--async`・画面の送信は付けない（付けない送信の振る舞いは変えない）。
- **予約**: 同じ askId・同じ bodyDigest の再 POST は状態を返すだけ（追加の入力 0）。同じ askId・別の本文は 409（追加の入力 0）。予約と送信結果の記録は別の短い transaction（入力の間 transaction を保持しない）。
- **送信結果**: 既存の `not_sent`／prompt 待ち／role 不一致の拒否は台帳を `not_sent` にして既存どおり返す。結果不明（unknown）は `send_unknown` のまま。再送しない。
- **askId を `chat_messages.request_id` に上書きしない**（`src/lib/db/chat-db.ts:72`）。History の重複防止と native requestId は今のまま。
- **capability の出どころは 1 つ**: サーバーの `GET /api/asks/capabilities`。CLI 側に tool の表の写しを足さない（既に `reply-ledger.ts:68`・`relay-bound-reply.ts:133`・`src/components/worktree/ChatMessageBubble.tsx:465` に同種の表が 3 つある）。

**M1 — claude の turn に入った入力の集合（不変条件 4）**

- claude の turn の入力は、prompt record に加えて、**同じ turn の中の `queue-operation`（remove）と `queued_command` の attachment**まで数える（`queued-notice.ts:10-18`。fixture は `tests/fixtures/claude-self-resume-3430/`）。turn の入力が 2 つ以上なら、封筒の付いた入力を含めて全員 `ambiguous/shared_turn`。
- 吸収された入力には封筒が乗らない（吸収された ask B は B 自身の user record を持たない）。B は B の turn が見つからないので `unmatched`（`absorbed_mid_turn`）。A は上の規則で `ambiguous`。
- 数えられない限り claude の capability は true にしない（§0.1）。
- `<task-notification>` の吸収（バックグラウンドのタスク完了通知）は「別の入力」に数えない（§7 (a) の決定 ②）。代わりに `attribution` に `notified:true` を出す（通知への反応が返答に混ざりうることを言う）。手入力・ask の吸収は数える。

**R3 — 送信時の手がかり `turnOpenAtSend` は安全弁**

- 送信 API は送信の瞬間に turn が開いていたか（`turnOpenAtSend`、`ask.ts:356-360` が読む値）を返す。台帳にも記録する。
- claude で `turn_open_at_send = true` なら、reader が吸収を見つけなくても `matched` を出さず `ambiguous/turn_open_at_send` にする。**証拠としては使わない**（false でも `matched` の根拠にはならない。M1 の数え方が根拠）。

**M2 — 封筒と History の採用（不変条件 7）**

- reader は封筒を回収した**後に外し**、`recordUserTurn` には封筒の無い本文を渡す。採用の規則（`user-turn-recorder.ts:329-343` の本文の正規化一致）自体は変えない。
- 外す処理は「先頭が封筒の正規の位置（M3）に一致するときだけ」動く。relay の本文・brief だけが付いた本文・封筒の無い入力では何も変わらない。
- 外さないと: 一致しないので user 行が 2 行目として insert され、チャット画面に封筒が出る。さらに ask の `hasForeignPromptInWindow`（`ask.ts:406-412`）が自分の行を他人の入力と見なし `overlapped` を誤報する。
- **この採用の試験は、封筒を実際に出し始める PR と同じ PR に置く**（§6 では PR1）。

**M3 — 封筒の正規の位置と外す順序**

- 入力される本文は brief が前、利用者の本文が後（`send-user-message.ts:402-403`・`:732-739`）。claude は複数行の入力を `<pasted_content id=…>` で包んで記録する（`claudePastedContentPrompt` `transcript.ts:212-241`）。封筒を足すと ask は必ず複数行＝paste になる。
- **正規の位置: brief の閉じフェンスの直後、利用者の本文の直前（brief が無ければ本文の直前＝先頭）**。打つ本文は `[brief][封筒の 1 行]\n[利用者の本文]`。封筒を brief より前に置かない（`afterDeliveredBrief` の `^` 一致が外れ、M2 が brief 付きの送信にも広がる）。
- **外す順序（reader）: paste の包み（`claudePastedContentPrompt`）→ brief（`afterDeliveredBrief`）→ 封筒**。封筒は「残りの先頭行が封筒の形に完全一致する」ときだけ外す。本文中の引用や assistant 側の記述は対応付けに使わない。
- 封筒の形（見立て。PR1 の fixture で確定）: `[cmate-ask v1 <askId>]` のような版つきの 1 行。封筒が 2 つの native 入力に現れたら推定でつながない（M6 の終端の規則が優先）。
- 送信側の差し込みは brief の claim の後（`deliverWithBrief` の中、`send-user-message.ts:732-739`）。封筒を差し込んだら **`typedContent` を必ず計算し直す**（今は `typedText !== content` のときだけ `typedBodyFor` を呼ぶ `:739`）。そうしないと入力欄の残りの判定・送信済み本文の記録・`typedDigest`（`src/lib/session/send-attempt-state.ts:188-197`）が実際に打った本文とずれる。History の行は今どおり利用者の本文（封筒なし）。

**M4 — コマンド本文**: §0.2 のとおり封筒を付けず `unavailable/slash_command`。入力は封筒の無い ask と同じ（本文を変えない）。

**M6 — 終端の状態と冪等**

- `matched`・`ambiguous` は終端。上書きしない。
- 同じ native の入力 ID（と同じ native session id）で再び読んだときは冪等（状態・本文・`assistant_message_ids` を変えない）。
- 別の native の入力 ID・別の session での再出現（claude の resume・fork、codex の resume。未確認だが起こりうる）は、ログ（`ask-correlation-duplicate-sighting`）に記録するだけで台帳を変えない。終端になる前（`pending`）に 2 つ目が現れたら `unmatched/envelope_duplicated`。

### 3.3 帰属の状態と理由

| `attribution.state` | 意味 | reply |
|---|---|---|
| `matched` | 連鎖が完結し、turn に他の入力が無い（終端）。通知の吸収だけなら `notified:true` を添える（§7 (a)） | 本文 |
| `ambiguous` | 連鎖は完結したが、turn に他の入力がある、または turn が送信時に開いていた（終端） | null |
| `unmatched` | 対応済みの tool で、期限までに連鎖が完結しなかった | null |
| `unavailable` | tool・サーバーが未対応、またはコマンド本文で、台帳を使っていない | null |

`pending` は API の途中状態で、CLI の最終出力には出さない。

| `reason` | 状態 |
|---|---|
| `tool_unsupported`・`server_unsupported`・`slash_command` | unavailable |
| `shared_turn`・`turn_open_at_send` | ambiguous |
| `envelope_lost`（封筒の無い user record しか来ない）・`absorbed_mid_turn`・`envelope_duplicated`・`turn_incomplete`・`generation_changed`・`history_missing`（読み取り時に判定。§3.4）・`body_truncated`・`send_unknown`・`grace_expired` | unmatched |

### 3.4 台帳の寿命（R1）

- 列名は `worktree_id`。`getWorktreeChildTables`（`src/lib/db/migrations/worktree-child-tables.ts:26-47`）が `worktree_id` 列を自動で拾うので、worktree の改名・削除に追従する（FK は付けない既存の流儀でも拾われる）。
- 保持: 作成から 7 日、または worktree ごとに新しい 500 行まで（多い方を消す）。掃除は予約のついで（`reserveAsk` の transaction の外の 1 文）。数値は着手時に見直してよいが、上限を持つことは変えない。
- 予約されないまま reader が見つけた `buffered` 行（利用者が封筒の形の文を貼った場合など）は 10 分で期限切れにして消す。予約と合流しない限り何にも使わない。
- `history_missing` は**保存する状態ではなく、読み取りのときに判定する**: `matched` の行の `assistant_message_ids` が履歴の削除で引けなければ、API は `unmatched/history_missing` を返す（台帳の `matched` は書き換えない）。
- 既存データの backfill は無し（新しいテーブルだけ）。
- 実装の契約には「テストは worktree の DB（`CM_DB_PATH` を worktree の `data/` か `os.tmpdir()` の隔離 DB）で走らせる」と書く。ワーカーのテストが本番 DB を migration で上げた前例がある（2026-11-01）。

### 3.5 reader はいつ回るか（Q1 への答え）

- 事実: claude の transcript の reader は、サーバーの poller が turn の終わりに呼ぶ（`src/lib/polling/structured-history-gate.ts:387` → `captureClaudeTranscriptTurn` `claude/history.ts:369`）。CLI の `wait` のポーリングとは独立にサーバー側で回る。
- 設計: 台帳の確定（`recordNativeAskInput`・`bindCompletedTurn`）はこの reader の中で行う。加えて、`GET /api/asks/:askId` が `pending` の行を読んだときは、その宛先の reader を 1 回だけ同期で呼んでから答える（冪等。M6）。これで poller の持ち主（`poller-owner`）が別プロセスでも、15 秒の grace の中で確定する経路がある。
- 未確認: poller が止まっている状態（tick の間隔・持ち主の不在）で同期の 1 回が間に合うか。PR1 の integration で「poller を止めた状態で API の読み取りだけで `matched` になる」を確かめる。

### 3.6 台帳の状態遷移表（PM の処分・案 1、2026-11-13）

材料: リーダー経由の具体化（`state-table-4344-reply.md`、リポジトリ外）を設計の言葉で写した。推測では足していない。file:line は HEAD `32b91fa4d` 時点。略号: C＝`src/lib/ask/ask-correlation.ts`、D＝`src/lib/db/ask-correlation-db.ts`、A＝`src/lib/hooks/sources/claude/ask-attribution.ts`、T＝`src/lib/hooks/sources/claude/transcript.ts`、R＝`src/app/api/worktrees/[id]/send/route.ts`、S＝`src/lib/ask/ask-send.ts`。「赤」はコードを読んだうえでの見込み（未実行）。

#### 3.6.1 状態

台帳の行の状態は `send_state`（`reserved`／`sent`／`not_sent`／`send_unknown`）と `attribution_state`（`pending`／`matched`／`ambiguous`／`unmatched`）の組、加えて native の入力を記録済みか（`native_input_id IS NOT NULL`）で決まる。

| 記号 | 台帳の値 | 意味 | 終端か |
|---|---|---|---|
| ∅ | 行なし | 予約が無い（貼られた封筒など） | — |
| **R** | `reserved`/`pending`、入力なし | 予約した。送信の結果はまだ保存していない | いいえ |
| **R+** | `reserved`/`pending`、入力あり | 送信の結果の保存より前に、reader が封筒を見た | いいえ |
| **P** | `sent` または `send_unknown`/`pending`、入力なし | 送った（または送れたか不明）。封筒はまだ見ていない | いいえ |
| **P+** | 同上、入力あり | 封筒を見たが、まだ確定していない | いいえ |
| **N** | `not_sent` | 何も打っていない。送信結果の保存の時点で `unmatched/not_sent` の終端（H2） | はい（H2） |
| **M** | `matched` | 確定した | はい |
| **Am** | `ambiguous`（`shared_turn`・`turn_open_at_send`） | 共有の turn | はい |
| **U** | `unmatched`（`envelope_duplicated`・`absorbed_mid_turn`・`body_truncated`） | 確定しないことが確定した | はい（C:121-123 が pending 以外を終端と扱う） |

**保存しない状態**（読み取りか計画の時に決まる）:
- `unavailable`（`tool_unsupported`・`slash_command`）: S:46-52。行を作らない。
- `unmatched/history_missing`: C:274。
- （`unmatched/not_sent` は H2 で保存する終端になった。表の N）
- `unmatched/send_unknown`（H3。古い予約の読み取り）・`unmatched/history_changed`（H4。読み取りで判定）
- `grace_expired`・`turn_incomplete`・`send_unknown`・`envelope_lost`・`generation_changed`: CLI 側（PR3）。今の台帳には書かない。

**設計にあって実装に無い状態**: `buffered`（設計 §3.4・§4）。予約の無い封筒は `unknown` と答えてログに残すだけ（C:149-153）。

**状態でなく、結果として返るもの**: `rejected`・`duplicate`・`unknown`（C:112-119）。

#### 3.6.2 観測

| 記号 | 観測 |
|---|---|
| O1 | 送信の結果の保存（R:149-161 → D:140-156）。`sent`（turnOpenAtSend が true／false／null）・`not_sent`・`send_unknown` |
| O2 | 封筒入りの native record の出現（本人の prompt record。T:803-818） |
| O3a | 同じ封筒の再出現: 同じ input id・同じ session |
| O3b | 同じ封筒の再出現: 別の input id |
| O3c | 同じ封筒の再出現: 別の session |
| O4 | この ask が、別の turn に吸収された（`queue-operation` remove・`queued_command` に封筒がある。T:916-929） |
| O5 | turn の完了の証拠（今は `isClaudeTurnWritable`、T:786-793） |
| O6 | session の違い（現在の session と record の session）、または宛先の違い |
| O7 | History の更新（assistant 行の作成・成長・削除） |
| O8 | 期限切れ（CLI の grace、保持の掃除） |

#### 3.6.3 状態×観測 → 次の状態

各セルの「終端化の前提条件」がそろうまで終端にしない。「試験」の ○ は既存、★ は新規（直す前に赤）。「守られているか」は HEAD `32b91fa4d` の実装について: ○ 守られている、✗ 守られていない、△ 未確認。

| # | 今の状態 | 観測 | 次の状態 | 終端化の前提条件（そろうまで終端にしない） | 試験（○＝既存、★＝新規。直す前に赤） | 守られているか |
|---|---|---|---|---|---|---|
| 1 | R | O1 sent／send_unknown | P（R+ なら P+） | `send_state='reserved'` の行だけが受け取る（1 回だけ） | ○ migration-v72「records the send outcome once and never rewrites a terminal attribution (M6)」、○ send-ask「reserves before the send…」「…send_unknown (never resent)」 | ○ D:150-152 |
| 2 | R | O1 not_sent | N | 同上 | ○ send-ask「a send refused before any key records not_sent…」 | ○ R:155-158 |
| 3 | R | O2（宛先も session も一致） | R+ | **終端にしない**（送信時の観測、特に turnOpenAtSend の保存の前だから） | ○「a complete turn read before the outcome is saved stays pending; turnOpenAtSend=true saved later → ambiguous」 | ○ C:183-190 |
| 4 | R+ | O3b（2 つ目の別 input） | **R+（重複の証拠を保存）** → O1 の後に U/envelope_duplicated | 証拠を持ち越す。O1 の後、どの完了判定より先に重複を判定する | ★「M6 a second envelope input seen while reserved is carried: after the outcome is saved it is unmatched/envelope_duplicated, never matched」 | ✗ **C:170**（証拠を保存せず `pending` を返す）。pr1b の 4 |
| 5 | R／P | O4（自分が吸収された） | R なら証拠を保存して O1 の後に U/absorbed_mid_turn。P なら U/absorbed_mid_turn | 宛先**と session** が一致すること。送信の結果が保存済みであること。R の間は証拠を持ち越す | ○ M1「an absorbed ask: A is ambiguous/shared_turn and B unmatched/absorbed_mid_turn」、○「an absorbed ask whose send is not saved yet is not settled either」、★「M5 an absorbed envelope in a stale session never settles the pending row」、★「an absorbed ask seen while reserved is settled absorbed after the outcome is saved」 | ✗ **A:61・C:222-229**（session を照合しない。pr1b の 5）、✗ C:225（R の間の証拠を捨てる。読み直しで再び見えるかは△） |
| 6 | P | O2、完了の証拠なし | P+ | — | ○ (3)「stays pending (turn_incomplete for the CLI) and never takes the previous turn」 | ○ C:183-191 |
| 7 | P／P+ | O6 宛先の違い | 変化なし（rejected） | — | △ 宛先の不一致だけの試験は見つからない。★「M5 a sighting under another instance is rejected and leaves the row pending」 | ○ C:156-159 |
| 8 | P／P+ | O6 session の違い（両方とも読めた） | 変化なし（rejected） | — | ○ (8)「M5 a record of the session before /clear is rejected」 | ○ C:161-164 |
| 8b | P／P+ | O6 **session が読めない**（`currentSessionId` か `nativeSessionId` が null） | **変化なし（pending のまま）** | session が確認できるまで、入力の記録も終端化もしない（設計の不変条件 2「世代が不明なら確認済みと扱わない」） | ★「M5 a sighting whose current session cannot be read never settles (stays pending)」 | ✗ **C:161**（どちらかが null なら照合を丸ごと飛ばす）。今回の新しい指摘 |
| 9 | P+ | O5 完了・`otherInputs>0` | Am/shared_turn | **完了の証拠が本物の閉じ**（stop の観測。I5）であること、session が確認済みであること | ○ M1「A is ambiguous/shared_turn…」 | ✗ **A:65・T:786-793**（History の救済条件を完了とみなす）。pr1b の 2 |
| 10 | P+ | O5 完了・turnOpenAtSend=true | Am/turn_open_at_send | 同上 | ○ (11)「turnOpenAtSend=true → ambiguous/turn_open_at_send」 | ○ C:198-201（完了の証拠は 9 と同じ ✗） |
| 10b | P+ | O5 完了・turnOpenAtSend=null（送信時に読めなかった） | **Am/turn_open_at_send**（H1） | 本物の閉じ・session 確認済み | ★「H1 turnOpenAtSend unknown at the send → ambiguous/turn_open_at_send」 | ✗ 今は「開いていない」と同じに扱う（C:198、R:520） |
| 11 | P+ | O5 完了・O7 assistant 行あり・切れていない | M | 本物の閉じ・session 確認済み・**本文を固定する**（I2） | ○ (1)「a 305-line reply comes back in full…」、○ (2)「ask `hi` answered `hi` is matched with exactly `hi`」、★「a turn with no stop_reason observed is never matched (History's rescue is not completion)」 | ✗ 完了の判定は A:65（pr1b の 2） |
| 11b | P+ | O5 の代わりに superseded（後の prompt が来た）で、stop の観測が無い（中断された turn） | **U/turn_interrupted**（H5） | — | ★「H5 an interrupted turn (superseded, no stop) settles unmatched/turn_interrupted」 | ✗ A:65（History の救済条件で完了とみなし matched にしうる） |
| 11c | P+ | stop_reason が一度も観測されず、superseded でもない | P+（変化なし） | 完了の証拠が無いので終端にしない（I5）。この版は §0.1 の版の判定で capability が false になる（H5） | ★「a turn with no stop_reason observed is never matched (History's rescue is not completion)」 | ✗ A:65 |
| 12 | P+ | O5 完了・O7 assistant 行あり・切れている | U/body_truncated | 同上 | ★「a truncated row settles unmatched/body_truncated」（試験は見つからない） | ○ C:203-206 |
| 13 | P+ | O5 完了・O7 行がまだ無い | P+ | — | △ 試験は見つからない | ○ C:202 |
| 14 | P+ | O3a | 変化なし（冪等） | — | ○ (9)「M6 reading the same input twice changes nothing」 | ○ C:165-167・182 |
| 15 | P+ | O3b（終端の前） | U/envelope_duplicated | 送信の結果が保存済みであること | ★「a second input of the same envelope after the send is saved → unmatched/envelope_duplicated」（直接の試験は見つからない） | ○ C:179 |
| 16 | P+ | O3c（現在の session が新しい側） | U/envelope_duplicated（古い側は 8 で rejected） | session がどちらも読めていること（8b） | ★「resume into a new session before the turn settled → envelope_duplicated」 | △ 静的には C:165-179 で成り立つ |
| 17 | P／P+ | O8 CLI の grace | **変化なし**（CLI が `unmatched/grace_expired` を出す。台帳には書かない） | 期限切れでは台帳を終端にしない（後から来た正しい証拠を捨てない） | ★（PR3）「grace expiry prints unmatched/grace_expired and leaves the row pending」 | ○ 書いていない |
| 18 | M | O3a／O3b／O3c／O4 | 変化なし（ログ `ask-correlation-duplicate-sighting`） | — | ○ (9)「…another session after matched (resume / fork) leaves it as it was」。ただしこの試験は session の不一致で 8 を通って rejected になり、終端の分岐（C:171）までは届かない。★「same session, another input id after matched → duplicate, unchanged」 | ○ C:171-177・182、D:202 |
| 19 | M | O7 同じ行が成長・変化する（turn の再開・修復） | **M のまま。読むと `unmatched/history_changed`**（H4） | 確定時に本文の digest（sha256）と長さを台帳に持ち、読むときに違えば返さない（本文は持たない＝v72 の「Holds no body」を保つ） | ★「M6 a matched reply whose History row later changes reads unmatched/history_changed」 | ✗ **C:271-278**（毎回いまの本文を読む）。pr1b の 3 |
| 20 | M | O7 行の削除 | 読むと `unmatched/history_missing`（台帳は M のまま） | — | ○ (9)「M6 a reply row deleted from History reads unmatched/history_missing; the ledger stays matched」 | ○ C:274-277 |
| 21 | Am／U | すべての観測 | 変化なし | — | ○ migration-v72 の M6 | ○ D:202、C:182 |
| 22 | N | O2（封筒が見えた。分類と矛盾） | **変化なし**（N は終端。観測はログだけ。H2） | — | ★「H2 an envelope seen after not_sent leaves unmatched/not_sent」 | ✗ 今は `sendSettled` が真なので M にもなりうる（C:126-128・190） |
| 23 | N | 読み取り（GET） | `unmatched/not_sent` に見える。refresh しない | — | ○ send-ask「…records not_sent, and the answer says so」 | ○ C:251・265 |
| 24 | R | O8 サーバーが送信の途中で落ち、O1 が来ない | **`ASK_RESERVED_STALE_MS`（10 分）を過ぎた R は、読み取り（reader・API）の時に `send_unknown` とみなす**（H3）。R+ は表の 3・4 の先へ進める | 予約からの経過時間だけで判定（台帳の `send_state` は書き換えない） | ★「H3 a reservation older than ASK_RESERVED_STALE_MS is read as send_unknown and can settle」 | ✗ 今は R のまま。保持（7 日・500 行）で消えるだけ |
| 25 | 任意 | O8 保持の掃除 | 行が消える（GET は 404） | — | ○ migration-v72「prunes by age…」 | ○ D:124-134 |
| 26 | ∅ | O2（予約の無い封筒の形の行） | 行は作らない。**History の本文から封筒を外さない** | 封筒を外すのは、同じ宛先の予約行がある本文だけ（I3） | ★「M2 negative: a send without ask whose body opens with an envelope-shaped line keeps it; the /send row is adopted as one row」 | ✗ **T:803-809**（形だけで外す）。pr1b の 1。台帳側は ○ C:149-153 |

#### 3.6.3a 人の決定（2026-11-13 14:55）に合わせた定数と規則

- `ASK_RESERVED_STALE_MS` = 10 分（600,000 ms）。H3: 予約からこれだけたっても送信結果の無い行（`reserved`）は、読み取りの時に `send_unknown` とみなす。送信の経路（入力のロック待ち・セッションの起動）の上限より十分長い値
- `ASK_ATTRIBUTION_MIN_VERSIONS.claude` = `2.1.239`。H5: stop_reason を書かない claude の版では capability を false に絞る。この値はリポジトリにある実記録で stop_reason を持つ最古の版（`tests/fixtures/turn-separation-2234/claude-tool-first-turn.jsonl`）。それより古い版・版が読めないときは false（§0.1）
- 新しい理由: `turn_interrupted`（H5。保存する終端）、`history_changed`（H4。読み取りで判定、保存しない）、`send_unknown`（H3。古い予約の読み取りで判定、保存しない）、`not_sent`（H2。保存する終端）
- 台帳に足す列（v72 の中で）: 本文の digest と長さ（H4）、予約中に見えた重複・吸収の証拠（I8）

#### 3.6.4 不変条件（14）

| # | 不変条件 | 覆う指摘 |
|---|---|---|
| I1 | 終端（matched・ambiguous・unmatched）は、どの観測でも上書きしない。 | M6 |
| I2 | matched で返す本文は確定した時のものと同じで、History がその後に変わっても変わらない（変わったら返さない）。 | pr1b の 3 |
| I3 | 封筒を外すのは、同じ宛先の予約行がある本文だけで、1 回だけ外す（本文の中の別の封筒は残す）。 | pr1b の 1、pr1 の 2、M2 |
| I4 | 送信時の観測（送信の結果と turnOpenAtSend）が保存されるまで、どの行も終端にしない。 | pr1 の 1 |
| I5 | 完了の証拠は turn の閉じ（stop の観測）だけで、History の書込みの救済条件（stop が一度も観測されない・superseded）は完了の証拠に使わない。 | pr1b の 2 |
| I6 | session の照合は、すべての観測（本人の封筒・吸収・再出現）に当てる。どちらかの session が読めないときは、何も記録せず何も確定しない。 | pr1b の 5、M5、8b |
| I7 | 宛先（worktree・tool・instance）の照合も、すべての観測に当てる。 | M5 |
| I8 | 再出現と吸収の証拠は、保留（reserved）の間も持ち越し、送信の結果を保存した後に、完了の判定より先に判定する。 | pr1b の 4 |
| I9 | 1 つの ask の native の入力は 1 つ。2 つ目は推定でつながず、終端の前なら `unmatched/envelope_duplicated`、終端の後ならログだけにする。 | M6 |
| I10 | 吸収された入力（バックグラウンドの通知を除く）がある turn の封筒入力は matched にしない。吸収された側の ask は `unmatched/absorbed_mid_turn` にする。 | M1 |
| I11 | 送信時に turn が開いていた（turnOpenAtSend=true）ask は matched にしない。 | R3 |
| I12 | `history_missing` は読み取りのときに判定し、台帳に保存しない。期限切れ（CLI の grace）も台帳に書かない。 | R1 |
| I13 | コマンド本文（`/`・`!`・`#`）には封筒を付けず、行も作らない（`unavailable/slash_command`）。 | M4 |
| I14 | 封筒は brief の閉じフェンスの直後・利用者の本文の直前に置き、打った本文で `typedContent` を計算し直す。 | M3 |

M7（consistency-review が止まる）は CLI（PR3）の話なので、この表の外。

#### 3.6.5 表の外で、設計の改訂で決めるもの（人の判断は不要）

- **`buffered` を設計から外す**。予約は必ず入力より前（R:237-246）なので、予約の無い封筒は貼られたものだけで、行を作る理由が無い。表の 26（台帳は作らず、本文も外さない）で足りる。§3.4・§4・§5 の `buffered` の記述はこの節が優先する。
- **別プロセスの同時書込み**。bind は 1 プロセスの中では同期で割り込まれないが、poller の持ち主が別プロセスだと、2 つのプロセスがそれぞれ別の input で `native_input_id IS NULL` の同じ行を読み、片方の `recordAskNativeInput` が 0 行の更新でも戻り値を見ずに確定へ進みうる（C:184。静的な読み、未確認）。対策: 確定の UPDATE の条件に `native_input_id = ?` を足し、記録に失敗したら確定しない。試験は 2 つの DB 接続で順序を差して作る。
- 表の 7・12・13・15・16 には対応する試験が無い（実装は静的には守っている）。

#### 3.6.6 未確認

- 表の 5 で、reserved の間に捨てた吸収の証拠が、次の読み直しでもう一度見えるか（History の reader が transcript をどこから読み直すか、`selectUnwrittenTurns` の進み方は未読）。
- 試験の実行と、修正前の赤の実測。

## 4. return・throw・書き込みの表

| 関数（候補） | return | throw | 書き込み／順序 |
|---|---|---|---|
| `reserveAsk(db, {askId, target, bodyDigest})` | `reserved`／`existing`（同 digest。行の状態つき）／`conflict`（別 digest） | DB の失敗だけ（route は 500、入力しない） | 台帳に 1 行 INSERT（短い transaction）。**入力より前**。期限切れ行の掃除は transaction の外 |
| `isAskCommandBody(content)` | boolean（`isSlashCommandBody` か `#` 始まり） | なし | なし |
| `insertEnvelope(typedText, content, askId)` | 封筒を利用者の本文の直前に入れた本文（純関数。M3） | なし | なし。brief の claim の後に 1 回。呼んだら `typedContent` を再計算 |
| `stripEnvelope(text)` | `{askId, body}`／null（正規の位置に完全一致しない） | なし | なし。reader の外す順序の最後 |
| `sendUserMessage`（既存。ask 分岐を追加） | 既存の結果型（変えない） | 既存どおり | 既存の書き込み＋ `recordSendOutcome`（`sent`／`not_sent`／`send_unknown`、`sentMessageId`、`turnOpenAtSend`）。**入力の後**、別 transaction |
| reader `recordNativeAskInput(askId, nativeInputId, nativeSessionId)` | `bound`／`buffered`（台帳未予約）／`rejected`（宛先・session が不一致）／`duplicate`（M6） | なし（読み取りの失敗は記録して続ける。reader の他の読者を止めない） | 台帳を UPDATE。終端の行は変えない。封筒を外した本文を `recordUserTurn` へ |
| reader `bindCompletedTurn(nativeTurnKey, inputs[], absorbed[], assistantIds[])` | 各 askId の `matched`／`ambiguous` | なし | 台帳を UPDATE。**turn の完了を読んだ後だけ**。未完了なら何もしない。終端は上書きしない |
| `GET /api/asks/capabilities` | `{protocol, tools:{[cliToolId]:boolean}}` | なし | なし |
| `GET /api/asks/:askId` | 台帳＋本文（`matched` のときだけ）／`history_missing` の読み取り判定／404（未知の askId） | なし | `pending` なら reader を 1 回呼ぶ（その中の UPDATE のみ） |
| CLI `readAskAttribution(client, askId, deadline)` | `{state, reason, reply}` | 期限切れは throw せず `unmatched/grace_expired` | なし |
| CLI `ask` の本体 | — | 既存の `handleCommandError` | 送信 1 回（再送しない）→ wait → 読み → stdout／stderr → exit |

## 5. 入力×状態の組み合わせの表

| 入力・割込み | 状態 | 結果 |
|---|---|---|
| 上寄せの 1000 行ペイン、返答が 305 行目・下は罫線の余白／通常の画面 | 対応済み、単独 turn | 同じ本文を `matched` で返す（画面の位置・80 行の窓に依存しない） |
| 画面に旧い返答だけ、今回の依頼が画面から消えた | 今回の対応なし | `unmatched`（`turn_incomplete` か `grace_expired`）。旧い返答を採らない |
| 依頼 `hi`、返答 `hi` | 単独 turn | `matched`、reply は正確に `hi` |
| 同文の ask を 2 回 | 別々の askId、別々の turn | それぞれ自分の turn の本文 |
| A と B が同じ codex turn に合流／手入力が同じ turn に追加 | 共有 turn | 両方 `ambiguous/shared_turn`、reply=null |
| claude の ask A の turn 中に、手入力か ask B が吸収された（`queue-operation` remove） | 共有 turn（M1） | A は `ambiguous/shared_turn`、B は `unmatched/absorbed_mid_turn` |
| claude で送信時に turn が開いていた（`turnOpenAtSend=true`）、吸収は見えない | 安全弁（R3） | `ambiguous/turn_open_at_send` |
| `<task-notification>` の吸収だけを含む claude の turn | §7 (a) の決定 ② | `matched`、`attribution.notified: true` |
| 前 turn が send の後に終わり history に入る、今回分は未完了 | 今回の turn 未完了 | `unmatched`（`turn_incomplete`）。前 turn を採らない |
| 別 instance の返答／`/clear` 前の session の record | 宛先・session の不一致（M5） | 採らない（reader が `rejected`） |
| サーバー再起動後の最初の ask | 世代は reader が観測（M5） | 単独 turn なら `matched` |
| `matched` の後、同じ封筒が resume・fork で別の session に現れる | 終端（M6） | 状態・本文は変わらない。ログに記録だけ |
| 同じ native 入力 ID を reader が 2 回読む | 冪等（M6） | 変化なし |
| native user record が send 行より先に届く | 台帳未予約 | `buffered` → 予約時に合流。本文＋時刻で採用しない |
| 封筒入りの native record と send 時の user 行 | M2 | 採用されて 1 行、内容に封筒なし、`overlapped` なし |
| brief 付きの ask／brief 無し、複数行／1 行の本文 | M3 | どの組でも封筒の回収と History の採用が成り立つ |
| `ask … "/compact"`・`!ls`・`#memo` | M4 | 封筒なし・本文はそのまま、`unavailable/slash_command` |
| 同じ askId で再 POST（同本文／別本文） | — | 状態を返す（入力 0）／409（入力 0） |
| 送信の応答が消える | `send_unknown` | 再送しない。grace 内に native が来れば台帳で確定、来なければ `unmatched/send_unknown` |
| 封筒が user record に残らない | — | `unmatched/envelope_lost`。その tool の capability の対照で落ちる |
| 返答の保存の後、別 turn が 30 件以上増える | `matched` | askId で読むので自分の本文 |
| 返答の行が履歴の削除で消えた | 読み取り時に判定（R1） | `unmatched/history_missing`（台帳は `matched` のまま） |
| 本文が切れている | — | `unmatched/body_truncated`。完全な返答とは言わない |
| `copilot`・`gemini`・`vibe-local` | 未対応 | `unavailable/tool_unsupported`、exit 0、画面へ降りない |
| 旧サーバー（capabilities が 404） | 未対応 | `unavailable/server_unsupported`、exit 0、旧 body で送る |
| wait が exit 10／20／21／124・upstream fault | — | 既存どおり（台帳は読まない） |
| `--async` | — | 既存どおり（台帳を使わない） |

## 6. PR の分け方（R2）

各 PR は**直す前に赤になる試験**を先に置き、陰性対照（今までどおりの動き）を同じ PR に置く。赤は「新しい関数・API が無いこと」による赤にしない: 既存の公開の入口（send の route・`recordUserTurn`・`ask` の CLI）を通し、今の実装が誤った値を返すことで落ちる形にする。

### 第一案（採る）: claude を縦に一本通す

イネーブラーの提案どおり。未使用の API だけを先に足す PR を作らない。

| PR | 書くもの | 直す前に赤の試験（今の実装で落ちる理由） | 陰性対照 |
|---|---|---|---|
| **PR1: claude を縦に** | migration（番号は着手時）・`ask-correlation-db.ts`・型・`ask-correlation.ts`・send の route／`send-request.ts`／`send-user-message.ts` の ask 分岐（予約・封筒・`typedContent` の再計算）・claude の reader（封筒の回収と外し・M1 の入力の集合・完了 turn の対応）・reader による封筒の外し（1 回だけ。`recordUserTurn` は変えない）・`GET /api/asks/*`（capability は claude だけ true）・**§3.6 の状態遷移表の全セルの試験を置く**・`ask` の CLI（capability が true の tool だけ台帳で読む。**ほかの tool は今の経路のまま**） | (1) claude で上寄せ 305 行目の返答 → reply の全文一致（今は末尾 80 行を返すか返答が無い）、(2) `hi` と旧 `⏺ history` だけの画面・対応なし → none（今は pane を採る）、`> hi`／`⏺ hi` と対応済み本文 `hi` → `hi`、(3) 前 turn が send 後に終わり今回分は未完了 → none（今は時刻窓で旧 turn を選ぶ）、(4) M1: 吸収 1 件の fixture で A・B → `ambiguous`／`unmatched`（今は A の reply を返す）、通知（`<task-notification>`）だけの吸収 → `matched`・`notified:true`（§7 (a) ②）、(5) M2: 封筒入り record＋send 行 → 1 行・封筒なし・`overlapped` なし、(6) M3: brief 付き／無し × 複数行／1 行、(7) M4: `/compact` → 本文不変・`unavailable`、(8) M5: 再起動後の最初の ask が `matched`、`/clear` 前の session の record は `rejected`、(9) M6: `matched` 後の別 session の再出現で不変、(10) 同じ askId の再 POST は入力 0、別本文は 409、(11) R3: `turnOpenAtSend=true` → `ambiguous`、(12) Q1: poller を止めて API の読み取りだけで確定 | 封筒の無い send・relay・brief だけの行の採用は不変、`<tool>-turn:` の行と重複防止は不変、exit 10／20／21／124・upstream fault・instance の別名・`--async`・`overlapped`・`capture --tail`／`--follow`・一般の `reply` は不変、claude 以外の tool の `ask` は不変 |
| **PR2: codex** | `codex/history.ts`（と parser）の封筒の回収と外し・完了 turn の対応、capability を codex で true | (1) 1 turn に 2 つの prompt → 両方 `ambiguous`（今は reply を返す）、(2) 単独 turn の全文一致、(3) M2〜M6 を codex の fixture で同じ名前のケースとして、(4) Q3: 大きな paste を `[Pasted Content …]` に畳んだ入力の rollout に封筒と展開後の本文が残るか（残らなければ capability は false のまま、PR2 は reader だけで止める） | codex の既存の user 行・`codex-prompt:`／`codex-turn:` の行は不変 |
| **PR3: 回収しない tool への切り替えと docs** | `ask` の CLI で capability が false の tool を `unavailable/tool_unsupported`、旧サーバーを `server_unsupported`（pane へ降りない）、`ask` の help、`src/cli/docs/agent-operations.ts`、`docs/user-guide/cli-operations-guide.md` と `docs/en/user-guide/cli-operations-guide.md` の `## commandmate ask` 節 | (1) `copilot` → `unavailable`・画面を読まない・exit 0（今は pane を返す）、(2) capabilities が 404 → `server_unsupported`・旧 body で 1 回送る | PR1 の陰性対照すべて |

- **PR3 のマージは PR2 のマージ後（codex の capability が true になった後）**。`consistency-review.mjs` は変えない（§0.5、M7）。
- 既存の pane を前提にした ask の試験（`tests/unit/cli/commands/ask-*.test.ts` の pane 採用）は消さず、期待値の変更理由（人の決定による挙動の変更）を各試験に書く。PR1 では claude に関わる分、PR3 では残り。
- `readSqueezedPaneTail`（`capture.ts:384`）は PR3 で ask から呼ばれなくなるが、`capture.ts` は変えない（不変条件 7）。
- **PM の処分（2026-11-13、再指示 1）: PR1 はサーバー側だけ**（台帳・send の予約と封筒・claude の reader・History の採用・`/api/asks/*`）。再指示 2: 帰属を終端にするのは send の route が送信結果と `turnOpenAtSend` を台帳に保存した後だけ（`reserved` の間に reader が完了 turn を読んでも `pending`）。`ask` の CLI が `ask` を指定して台帳で読む切り替えは、利用者に見える変化なので §7 (c) のとおり公開版 skill の後の PR3 に回す。PR1 の時点では誰も `ask` を指定しない（未使用の API を先に足す形を受け入れる）。
- PR1 は大きい（DB・send・reader・CLI を含む）。レビューの往復が増えるなら、PR1 の中のコミットを「台帳と send」「reader と採用」「CLI」に分けて読む順を示す（PR は分けない）。
- capability の機械判定（§0.1）のガードの試験は PR1 で置き、PR2 で codex の行を足す。

### 第二案（採らない）: 層で分ける（台帳と send → reader → CLI）

当初の契約の分け方。PR1 が「誰も送らない `ask` フィールド」と「全 tool が false の capabilities」だけになり、未使用の API を先に足すことになる。M2 の採用の試験も封筒を出し始める PR に置けない（PR1 で封筒を出すなら reader が無く、出さないなら試験の対象が無い）。PR の大きさを優先する事情が出たときだけ使う。

## 7. 決定（2026-11-13 13:51、人）

すべて推奨どおりに決まった（Issue #4344 のコメント）。

| 決めること | 選択肢 | 決定 |
|---|---|---|
| (a) claude の `<task-notification>` の吸収（バックグラウンドのタスク完了通知）を「別の入力」に数えるか（M1 の付記） | ① 数える（そうした turn の ask は `ambiguous`。バックグラウンドを使う claude の ask の多くが回収されない）② 数えない（通知は利用者の入力ではないとみなし、手入力・ask の吸収だけを数える。通知に答えた本文が返答に混ざりうる） | **②**。通知は `queued-notice.ts` が内容（`<task-notification>` 始まり）で区別できる（`:10-18`、188 件中 178 件が通知）。「通知への反応が返答に混ざる」ことを `attribution` に `notified:true` として出す（PR1 で実装） |
| (b) capture の見え方の変化を受け入れるか（ask の本文が必ず複数行になり、claude のペインに `[Pasted text …]` と封筒が出る） | ① 受け入れる ② 1 行の本文では封筒を本文と同じ行の末尾に付ける（paste を避けるが、M3 の外し方と brief の流儀が変わる。未検討） | **① 受け入れる**。意味・API は変わらず、帰属の根拠を保てる。UAT・demo-video の手順に注記する |
| (c) 公開版 skill の `ask.sh`・`SKILL.md` と出す順番 | ① 公開版 skill を先に直して publish してから PR3 をマージ ② PR3 を先にマージし、公開版を追って直す（その間、未対応の tool で「空の返答で完了」と読まれうる） | **①**。公開版 skill を先に直して publish してから PR3（commandmate-skills の Issue と publish は PM が人に伺う。PR3 はリーダーが止める）。`reply:null` と `attribution` の読み方・context-limit の救済の扱いを直す |
| (d) codex の上限で Antigravity に振り替えたときの 5-2b（M7 の残り） | ① antigravity の adapter が対応するまで、振り替え先は claude にする ② `consistency-review.mjs` に `attribution.state` の分岐を足す（このとき書いてよいファイルに足す） | **① 振り替え先は claude**。運用の手順の変更で済み、スクリプトを変えない |

### 7.1 決定（2026-11-13 14:55、人）: 状態遷移表（§3.6）から出たもの

PM 経由で人が決めた。PR1 はこの決定と §3.6 の全セル・不変条件 14 に沿って作り直す（PM の処分）。

| 決めること | 選択肢 | 決定 |
|---|---|---|
| H1. `turnOpenAtSend` が読めなかったとき（null）の扱い（表の 10b） | ① 今どおり「開いていなかった」と同じに扱う ② true 側（`ambiguous`）に倒す | **② `ambiguous/turn_open_at_send`** |
| H2. `not_sent` の後に封筒が見えたとき（表の 22） | (a) `not_sent` を保存の時点で `unmatched/not_sent` の終端にし、後の観測はログだけ (b) 証拠を採って普通に確定まで進める | **(a)** |
| H3. 送信の途中でサーバーが落ち、送信の結果が来ない（表の 24） | ① 一定時間たった R を読み取りの時に `send_unknown` とみなす ② 保持の掃除まで放置する | **①**。時間は `ASK_RESERVED_STALE_MS`（§3.6.3a） |
| H4. I2（matched の本文を確定時のまま返す）の実現方法（表の 19） | (a) 確定時に本文を台帳に持つ (b) digest と長さを持ち、違えば `history_changed` で返さない | **(b)**。本文は持たない（v72 の「Holds no body」を保つ） |
| H5. 中断された turn（superseded）の扱い（I5） | ① 永久に `pending` ② `turn_interrupted` の `unmatched` | **② `unmatched/turn_interrupted`**。stop_reason を書かない claude の版では capability を false に絞る（版の判定は §0.1） |

## 8. 質問への答え

- **Q1（15 秒の間に reader が回るか）**: §3.5。サーバーの poller が turn の終わりに reader を呼ぶ経路に加え、`GET /api/asks/:askId` が `pending` のとき reader を 1 回同期で呼ぶ。poller を止めた状態の確定は PR1 の integration で確かめる。
- **Q2（tool の版で絞るか）**: 帰属の正しさのためには絞らない。reader は record ごとに封筒の有無を見るので、版によって封筒が残らなければ `unmatched/envelope_lost` になり、誤った `matched` にはならない。対照の fixture に採取した版を書き、封筒が残らない版が見つかったら capability に最小の版を足す（そのとき決める）。
- **Q3（codex の大きな paste の畳み）**: PR2 の fixture で確かめる。rollout に封筒と展開後の本文が残らなければ codex の capability は false のまま。

## 9. 未確認のこと

- 実機の send・ask・capture、テストの赤／緑は未実施（コードを読んで設計した）。
- 封筒が全 version の claude・codex で user record にそのまま残るか、モデルの返答に影響しないか（PR1／PR2 の fixture と、別途許可された隔離環境の実機で確かめる）。
- claude の turn 境界を record の順序と `queue-operation` から組み立てる方法が、tool 使用を挟む turn・compact・画像を含む入力でも一意に閉じるか。
- claude の `#` で始まる本文の扱い（M4 では安全側で封筒を付けない）。
- claude・codex の resume・fork で過去の record が別の session に再び現れるか（M6 は現れる前提で終端にした）。
- poller が止まっているときに API の同期の読み取りが 15 秒に間に合うか（§3.5）。
- brief・`/clear`・compact・手入力・OpenCode V1/V2 に封筒が与える影響（対応 tool を広げる後続の Issue で詰める）。
- `ask.sh:210-221`・`SKILL.md:227` の読みは事前レビューの記述による（この文書の作成では再確認していない）。

## 10. 事前レビュー（2-4-4）の反映先

| 指摘 | 反映先 |
|---|---|
| M1 claude の吸収された入力 | §0.1、§3.2 M1、§5、§6 PR1 (4)、§7 (a) |
| M2 封筒と History の採用 | §2 の 7、§3.2 M2、§4 `stripEnvelope`・reader、§5、§6 PR1 (5) |
| M3 封筒の位置・外す順序・`typedContent` | §3.2 M3、§4 `insertEnvelope`、§6 PR1 (6) |
| M4 コマンド本文 | §0.2、§3.3、§4 `isAskCommandBody`、§6 PR1 (7) |
| M5 世代 | §0.4、§2 の 2、§6 PR1 (8) |
| M6 終端と冪等 | §3.2 M6、§4、§6 PR1 (9) |
| M7 consistency-review | §0.5、§6（PR3 のマージ順）、§7 (c)(d) |
| R1 台帳の寿命 | §3.4 |
| R2 PR の分け方 | §6 第一案・第二案、§0.1 の機械判定 |
| R3 `turnOpenAtSend` | §3.2 R3、§3.3、§6 PR1 (11) |
| Q1〜Q3 | §8 |
| 不変条件 7 に History の採用・capture の見え方 | §2 の 7、§7 (b) |

### 10.1 今の PR1 の実装で守られていない所（§3.6 より。HEAD `32b91fa4d`）

| # | 場所 | 守られていない条件 | 表のセル | 出典 |
|---|---|---|---|---|
| 1 | T:803-809 | 予約の無い封筒の形の行も形だけで外す（I3: 外すのは同じ宛先の予約行がある本文だけ） | 26 | review-4344-pr1b の 1 |
| 2 | A:65・T:786-793 | History の書込みの救済条件（`isClaudeTurnWritable`: stop 未観測・superseded）を完了の証拠に使う（I5） | 9・10・11 | pr1b の 2 |
| 3 | C:271-278 | matched の返答を毎回いまの History から読む。行が成長すると本文が変わる（I2） | 19 | pr1b の 3 |
| 4 | C:170 | reserved の間に見えた 2 つ目の別 input の証拠を保存せず `pending` を返す（I8） | 4 | pr1b の 4 |
| 5 | A:61・C:222-229 | 吸収の観測で session を照合しない。reserved の間の吸収の証拠を捨てる（I6・I8） | 5 | pr1b の 5 |
| 6 | C:161 | `currentSessionId` か `nativeSessionId` が null だと session の照合を丸ごと飛ばす（I6） | 8b | 状態遷移表の具体化で新しく見つけた |

§7.1 は 2026-11-13 14:55 に決まった。PR1 を作り直すときに、全セルの試験と一緒に直す。
