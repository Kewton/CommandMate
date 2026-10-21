# Auto-Yes の確認ごとの記録（Issue #3820）設計

- 対象: Issue #3820（確認ごとに判断・配送・解消と停止の区間を記録する）
- 状態: **設計のみ**。この文書の時点で `src/` と `tests/` は変えていない。実装は設計のレビューの後に、§7 の PR 分割で別の契約として行う
- 基準: develop `1be6cacfa`（2026-10-21）。行番号はこの時点のもの。実装の前に名前で探し直すこと
- 方針: Auto-Yes の基本方針 第 3 版 第 1 部 4 節（計測）。関連: #3817 #3818。順番は #3820（計測）→ #3821（共通化）→ #3822（答えの意味と契約）→ #3823（未対応ツール）
- 前提として読んだもの（git には無い。リポジトリのルートの `workspace/proposals/2026-10-20/`）:
  `auto-yes-basic-policy-v3.md`・`auto-yes-per-agent-target.md`・`measurements-2026-10-20.md`（ほかに `review-codex.md` の R9 と `auto-yes-basic-policy-v2.md` の 8 節）

**この設計で守ること: 答え方は変えない（記録だけ）。記録が失敗しても、回答・hook の返事・ポーラーの次の tick を止めない。**

---

## 0. 用語

| 語 | 意味 |
|---|---|
| 確認 | エージェントが人に求めた 1 回の許可・選択（1 回のツールの呼び出しにつき 1 件）。画面のダイアログ・hook の要求・API の承認要求のどれで見えたかは問わない |
| 判断 | Auto-Yes がその確認に「答える／止める（答えない）」と決めたこと。根拠の段と、止めたときの理由を持つ |
| 配送 | 決めた答えをエージェントへ届けること。画面ならキー送信、hook なら HTTP の返事、opencode なら API への POST |
| 解消 | 確認が画面・要求から消えたこと。誰が消したか（Auto-Yes・人・不明）は、分かる範囲でだけ書く |
| 停止の区間 | 1 件の確認について、Auto-Yes が「止める」と判断してから、その確認が解消するか Auto-Yes が答えるまでの時間 |
| 根拠の段 | 基本方針の L1〜L4。L1 = hook / API の判定、L2 = hook の目撃と画面の照合、L3 = ツール専用の規則で認識した画面、L4 = 汎用の文字推定。ほかに今の経路として `enter-fallback`（Enter の補い）と `browser`（ブラウザの自動回答）を別に数える |

---

## 1. 現状の記録の経路（実コードで確認）

Issue 本文の 3 点は、実コードと合っていた（行番号は 1 か所だけずれていた。下の表の注記）。

### 1.1 止めた記録 = インスタンスごとに最後の 1 件の上書き

| 場所 | 内容 |
|---|---|
| `src/lib/polling/auto-yes-suppression-state.ts:68` | `lastPolicySuppressions`（`globalThis` の `Map<compositeKey, AutoYesPolicySuppression>`） |
| `src/lib/polling/auto-yes-suppression-state.ts:75-86` | `recordPolicySuppression()` が `Map.set` で**上書き**する。持つのは `reason`・`mode`・`promptType`・`pattern`・`at` だけで、確認の識別も開始時刻も無い。`at` は再び止めるたびに更新される（ファイル冒頭の説明 12-16 行のとおり） |
| `src/lib/polling/auto-yes-suppression-state.ts:107` | `forgetPolicySuppression()`（#3796、契約が変わったときに消す） |
| 書き手 | ポーラーの 4 つの出口が共有する `suppressAndWarnOnce()`（`src/lib/polling/auto-yes-prompt-suppression.ts:66-81`、記録は 74 行）。方針による抑止は `resolveAnswerUnderPolicy()`（`src/lib/polling/auto-yes-poller-steps.ts:75-103`）から。agy の受信記録が無いときは `src/lib/polling/auto-yes-poller-receipt-log.ts:138,169,217`、信頼の画面は `auto-yes-prompt-suppression.ts:411`。hook の方針抑止は `src/lib/hooks/permission-decision-service.ts:513-523` |
| 読み手 | `src/lib/session/current-output-builder.ts:762`（`capture --json` の `autoYes.lastSuppression`、WS）・`src/lib/push/prompt-push-gate.ts:351`（通知の保留）。どちらも「今止まっているか」を知るためで、件数や時間は見ていない |

→ 日次の件数も、止まっていた時間も復元できない。`at` は「最後に止めた tick」で、開始ではない。理由が途中で変わっても前の理由は残らない。

### 1.2 回答の記録 = `chat_messages` の `promptData.answeredBy`

`PromptAnsweredBy = 'auto' | 'human' | 'terminal'`（`src/types/models.ts:397`）。書く場所は 5 つ:

| 経路 | 場所 | `answeredBy` | 問題 |
|---|---|---|---|
| サーバーの poller が画面に答えた | `src/lib/auto-yes-poller.ts:607-614`（`finishAnsweredPrompt()` 542 行から。`recordAnsweredPrompt()` は `src/lib/db/chat-db.ts:972`） | `auto` | キーを送った後に 1 行書くだけ。判断（根拠の段）・送信の結果（部分送信）・解消を区別しない。再試行（同じ確認に 10 秒後にもう一度答える、`DUPLICATE_RETRY_EXPIRY_MS` = `src/lib/auto-yes-state.ts:922`）は同じ pending 行を上書きするか新しい行を作るかが行の有無で変わる |
| `/prompt-response`（人の UI と**ブラウザの自動回答**） | `src/app/api/worktrees/[id]/prompt-response/answer-delivery.ts:153-161`（159 行が `answeredBy: 'human'`） | `human` | `src/hooks/useAutoYes.ts:190` のブラウザの自動回答も同じ API を叩くので `human` になる（186-189 行の注記がこれを認めている）。タスクのイベントも `prompt_answered_human`（190 行） |
| `respond` API | `src/app/api/worktrees/[id]/respond/route.ts:271` | `human` | — |
| strict respond（CLI） | `src/app/api/worktrees/[id]/prompt-response/strict/route.ts:115` | 申告どおり（既定 `cli`） | `PromptAnsweredBy` の外の文字列も入る |
| 誰も記録しないまま確認が消えた | `markPendingPromptsAsAnswered()`（`src/lib/db/chat-db.ts:852`、902 行） | `terminal` | 「エージェントが先へ進んだ」ことしか分からない |
| hook の allow | `src/lib/hooks/permission-decision-service.ts:247-292`（281 行が `answeredBy: 'auto'`） | `auto` | 下の 1.3 |

`answeredBy='auto'` だけを数えると、ブラウザの自動回答を落とし、Enter の補い（`poller:auto-yes-enter-fallback-sent`、`src/lib/auto-yes-poller.ts:513`。行は書かない）も落とす。配送の失敗は行を書かない（send が throw すると `finishAnsweredPrompt` に来ない）ので「失敗を回答済みにする」誤りは今は無いが、**部分送信**（#3706、`partial-answer`）は止めた記録の上書きにしか残らない。

### 1.3 hook の allow の監査記録

- `recordAllowedPermission()`（`src/lib/hooks/permission-decision-service.ts:247`）は、allow のたびに `chat_messages` へ「答えた」行を 1 行 INSERT する（`summary` は `PermissionRequest allow · tool=… · prompt_id=…`、267 行。`status: 'answered'`・`answer: 'allow'`・`answeredBy: 'auto'`、279-281 行）
- 前提は説明（229-245 行。Issue が引いた 232-234 行はこの説明の中ほど）の **「allow した要求はダイアログを出さない。だからこの行が唯一の記録」**（233 行）
- agy でもこの関数が呼ばれる。agy の `PreToolUse` は `/api/hooks/permission-request` に来て（`src/app/api/hooks/permission-request/route.ts:224`）、同じ `resolvePermissionRequest()`（`permission-decision-service.ts:460-541`、allow なら 536-538 行で記録）を通る
- **実測（`measurements-2026-10-20.md` §1）では agy 1.4.2 は allow を返しても確認を出す**（1.1.12・1.1.27 と同じ）。画面の poller がその確認に答えて、もう 1 行 `auto` を書く。`auto-yes-per-agent-target.md` の数え方で、hook の allow 564 件は画面でも答えた二重の記録
- 逆に、agy は利用者の許可リストにあるコマンドや作業フォルダ内の `read_file` では確認を出さない（同 §1・§6）。この場合は「hook が allow した」行だけが残り、「CommandMate が許可して実行させた」ように読めるが、実際は agy 自身の設定で実行されている
- ソースの能力の宣言には、この違いを表す欄がまだ無い。近いのは `permissionHookPredictsDialog`（claude `src/lib/hooks/sources/claude/source.ts:159` が true、agy `src/lib/hooks/sources/antigravity/source.ts:241` が false）と `permissionReplyReleasesPrompt`（claude 164 行・agy 244 行とも false）。前者は「答えなかったら確認が出るか」、後者は「配送で待ちの記録を解いてよいか」で、**「allow したら確認が出ないか」ではない**

### 1.4 そのほかの記録（突き合わせに使える既存の材料）

| 材料 | 場所 | 使い道 |
|---|---|---|
| hook の判定のログ `permission-request-decided` / `permission-request-slow` | `src/app/api/hooks/permission-request/route.ts:273-289` | 判定 1 回につき 1 行。`behavior`・`reason`・`suppressedBy`・`elapsedMs` はあるが確認の識別は `promptId`（claude の `prompt_id` はターンの id で、呼び出しの id ではない） |
| opencode の判定の最後の 1 件 | `src/lib/hooks/permission-decision-state.ts:99`（`lastDecisions.set`）、書き手 `src/lib/hooks/permission-adjudication.ts:136` | `delivered` / `releasedPrompt` を持つ。これも上書き |
| poller の送信ログ `poller:response-sent` | `src/lib/auto-yes-poller.ts:575-583` | 送った答えと質問（500 文字まで）。判断の根拠は無い |
| agy の受信記録 | `src/lib/polling/antigravity-permission-receipts.ts:72-76`（`{ toolName, at }` だけ）、書き手 `route.ts:213-221` | 8 秒の受信窓。`toolCall.args`・`stepIdx`・`conversationId` は捨てている |
| agy の受信のエピソード | `src/lib/polling/antigravity-receipt-episodes.ts`（`beginAntigravityFrameRead` 195 行・`endAntigravityFrameRead` 221 行・`markAntigravityAnswerSent` 256 行） | 「ダイアログを最初に見た時刻」と「どの受信で受理したか」を既に持っている。agy の確認の識別の土台になる |
| CLI 自身の許可のモード | `PermissionRequestPayload.permissionMode`（`src/lib/hooks/permission-request-payload.ts:56,109`）。使っているのは `NON_BLOCKING_PERMISSION_MODES`（`permission-decision-service.ts:361,425`）だけ | claude の `PermissionRequest` にしか無い。中継（`scripts/hooks/cmate-agent-event.sh`）は `permission_mode` を送らない |

---

## 2. 確認の識別と、判断・キー送信・解消の結び方

### 2.1 識別の作り方（ツール・経路ごと）

確認ごとに、サーバーが `confirmationId`（記録用の連番。`<compositeKey>` とは別に、プロセスの中で一意）を振る。何を「同じ確認」とみなすかは、経路ごとに次の**識別の材料**で決める。

| 経路 | 識別の材料 | 同じ確認とみなす範囲 | 別の確認に分ける条件 |
|---|---|---|---|
| 画面（全ツール共通） | `partialAnswerScreenKey(promptData)`（`src/lib/polling/auto-yes-poller-state.ts:178`。種類・質問・選択肢・`approvalTarget`、カーソルは除く）＋ セッションの世代（`sessionEpoch`） | 同じ画面キーが、確認の無い tick を挟まずに続いている間 | 確認の無い tick（`noteNoPromptOnScreen()`、`src/lib/auto-yes-poller.ts:695`）・別の画面キー・セッションの作り直し（世代が変わる） |
| hook: claude / codex / copilot | hook の 1 回の配送（route が受けた 1 リクエスト）。`prompt_id` はターンの id なので使わない（claude は `tool_use_id` が `PermissionRequest` に無い: `src/lib/hooks/sources/claude/source.ts:165`） | その 1 リクエスト | 別のリクエスト |
| hook: agy | **(`conversationId`, `stepIdx`)**（`measurements-2026-10-20.md` §2: 会話の中では一意、起動し直すと 2 から始まるので会話の id と組にする） | 同じ組 | 別の組 |
| API: opencode / opencode-v2 | `PendingDecision.id`（`per_…`） | 同じ id | 別の id |
| `/prompt-response` | 送った時点の画面キー（route が再確認したフレームから作る） | — | — |

**`generatePromptKey()`（`type:question`、`src/lib/detection/prompt-key.ts`）を識別に使わない。** 重複の判定（`isDuplicatePrompt()`、`src/lib/polling/auto-yes-poller-generation.ts:198`）はこれを使っているが、claude の「Do you want to proceed?」のように質問が同じでコマンドだけ違う確認を 1 件に潰す。画面キーは `approvalTarget`（承認対象のコマンド）を含むので分けられる（受入基準の陰性「2 つの呼び出しを 1 件に潰さない」）。

**画面だけでは分けられない場合（限界として記録する）**: 同じコマンドの確認が、確認の無い tick（2 秒間隔、`POLLING_INTERVAL_MS` = `src/lib/auto-yes-state.ts:914`）を挟まずに 2 回続くと、画面の材料だけでは 1 件に見える。このとき:
- 答えを送った後も同じ画面キーが 10 秒（`DUPLICATE_RETRY_EXPIRY_MS`）を超えて残り、poller が再試行したら、**同じ確認への 2 回目の送信**として数える（`sendAttempts` を増やす）。新しい確認にはしない
- 解消が見えないまま終わった確認は `resolution: 'unresolved-after-send'` として別に数え、「答えて解消した」に入れない（陰性「配送の失敗を回答済みにしない」）
- hook の材料（agy の `stepIdx`）があるツールは、画面キーより hook の識別を優先する（§2.3）

### 2.2 1 件の確認の状態

```
opened ──decide(answer, basis)──> deciding ──sent(ok|partial|failed)──> sent ──clear──> closed(resolved-after-answer)
   │                                                        └─failed──> withheld? (下)    └─再試行──> sent（sendAttempts+1）
   └─decide(withhold, reason)──> withheld ──reason が変わる──> withheld（理由の履歴に追加）
                                     ├─clear──────────> closed(resolved-while-withheld)  … 人か端末で解消
                                     ├─decide(answer)─> deciding …（契約が変わって答えた）
                                     └─poller 停止 / Auto-Yes OFF / 世代交代 ─> closed(abandoned:<理由>)
```

- **判断**: `decision`（`answer` / `withhold`）・`basis`（根拠の段: `L1` / `L2` / `L3` / `L4` / `enter-fallback` / `browser`）・`reason`（止めたとき。今の `AutoYesSuppressionReason` の語彙、`src/lib/polling/auto-yes-suppression-reason.ts:9-76`。hook の `PermissionDecisionReason` の `auto-yes-disabled` など、`permission-decision-service.ts:80-92`）
- **配送**: `sent`（`ok` / `partial` / `failed`）と `sendAttempts`。画面は `sendPromptAnswer()` が戻ったら `ok`、throw したら `failed`、#3706 の部分送信なら `partial`。hook は返事を書けたら `ok`。opencode は `delivered`（`permission-adjudication.ts`）。**配送が `failed` / `partial` の確認は、回答済みに数えない**
- **解消**: `resolution` と `resolvedBy`。画面は確認の無い tick か別の画面キー、agy は受信のエピソードの終わり（§2.3）、hook の L1 ツールは「allow を配送した」（§5 の能力が true のとき）、opencode は `settled`。`resolvedBy` は、Auto-Yes が送った後に消えたら `auto`、`/prompt-response` が人の答えを送った後なら `human-ui`、それ以外は `unknown`（端末で打った・エージェントが自分で取り消した、を区別できない）

### 2.3 経路をまたぐ結び付け

| ツール | 結び方 |
|---|---|
| claude / codex / copilot | hook の allow で確認は出ない（`auto-yes-per-agent-target.md`「hook でできること」）。hook の確認はその場で `opened → decided(answer, L1) → sent(ok) → closed(released-by-hook)` と閉じる。claude は allow の後に自身の安全確認を出すことがある（`measurements-2026-10-20.md` §4 の 139 件）。この画面の確認は**別の確認**として開き、同じインスタンスで直前（8 秒以内）に hook の allow があったことを `afterHookAllow: true` として添える。**同じ呼び出しかどうかは断定しない**（基本方針 第 2 部「claude の L2」は保留。照合は先の Issue） |
| agy | hook の `PreToolUse`（`(conversationId, stepIdx)` で開く）と、画面の確認を 1 件にする。受信のエピソード（`antigravity-receipt-episodes.ts`）が「この確認はどの受信で受理したか」を既に持っているので、受信記録に `callId`（`conversationId:stepIdx`）を持たせ、エピソードが受理した受信の `callId` を画面の確認に付ける。閉じるのは **(a) 画面から確認が消えた（エピソードの終わり）か (b) その `stepIdx` の `PostToolUse` が来た**のどちらか早い方。「No, cancel」では `PostToolUse` も `Stop` も来ない（`measurements-2026-10-20.md` §2）ので、(b) だけでは閉じない。`read_file` のように確認を出さない `PreToolUse` がある（同 §6）ので、画面に確認が出ないまま `PostToolUse` が来たら `closed(no-dialog)` として「確認は出なかった」に数える |
| command-code | hook は確認に答えた後に届く（`measurements-2026-10-20.md` §3）。画面の確認だけで識別し、hook は結び付けない（`tool_use_id` を後から添えるのは、この Issue の範囲外） |
| opencode / opencode-v2 | `PendingDecision.id` で開き、`adjudicatePendingPermission()` の `delivered` / `settled` で配送と解消を書く |
| gemini / vibe-local | 画面の確認だけ（hook の判定は無い） |

**中継が `stepIdx` を落としている件**: `scripts/hooks/cmate-agent-event.sh` は `pre_tool_use` / `post_tool_use` で `toolCall.name` だけを `detail` に入れ（216-223 行）、本文には `tool`・`event`・`cwd`・`sessionId`（agy は `conversationId`、179-196 行）・`worktreeId`・`instanceId`・`detail` しか載せない。`stepIdx` を本文に足し、受け口（`src/app/api/hooks/agent-event/route.ts` → `readEventDetail()` `src/lib/hooks/agent-event-intake.ts:265`）で読む必要がある（§7 PR 3）。`PreToolUse` 側は中継を通らず（`src/lib/hooks/sources/antigravity/hooks-config.ts` の説明 51-70 行）、`parseAntigravityPermissionRequest()`（`src/lib/hooks/sources/antigravity/source.ts:122-145`）が `conversationId` を `sessionId` に入れ、`stepIdx` を読んでいないだけなので、`PermissionRequestPayload` に `callId` を足して読む。

---

## 3. 記録の置き場所

### 3.1 選択肢の比較

| 案 | 利点 | 欠点 | migration |
|---|---|---|---|
| A. DB の新しい表（`auto_yes_confirmations` など） | 再起動しても残る。SQL で何日分でも集計できる。将来の UI・API から読める | 書き込みが hook のハンドラ（エージェントが返事を待っている）と poller の tick の中に入る（better-sqlite3 は同期）。保存期間と掃除を新しく決める必要がある。agent-health の metrics が**本番の DB を読む**ことになる（今は本番ログ・`ps`・`GET /api/worktrees` だけ: `docs/user-guide/agent-health.md:416`） | **要**（`CURRENT_SCHEMA_VERSION` 61 → 62、`src/lib/db/migrations/runner.ts:27`） |
| B. 既存の表への列（`chat_messages` の `prompt_data` に欄を足す） | JSON の欄なので migration が要らない。今の `answeredBy` の行に根拠の段を足せる | 止めた区間・理由の変化・配送の失敗は「答えた行」に対応しない（行が無い・1 件に複数の出来事）。`chat_messages` は利用者に見える履歴で、計測のための行を混ぜると History・チャット面（`src/lib/chat/chat-tool-approvals.ts`）の表示が変わる。pending 行の付け替え（`recordAnsweredPrompt`）の規則に縛られる | 不要 |
| C. 構造化ログ＋日次集計 | 書き込みは 1 行の出力だけで、hook の返事・tick を待たせない。migration が要らない。agent-health は既に本番ログを 1 回読んで `hook-observation`（#3311）を出しており、同じ形に乗る（`src/lib/agent-health/hook-observation.ts`・`metrics-perf.ts:155`・`scripts/agent-health/metrics-runners.ts:696`）。「サーバーが区間の始まりを持ち、終わりに長さつきの 1 行を出す」形も `detection-divergence-resolved` で前例がある | ログはサイズでローテートされ、3 世代しか残らない（`scripts/start.sh:192` の `rotate_logs`。起動時だけ）。長期の推移は agent-health の日次の結果（metrics の state）で持つしかない。再起動で、開いていた確認・区間はメモリと一緒に消える（閉じる行が出ない）。API・UI からは読めない | 不要 |

### 3.2 決定: C（構造化ログ＋日次集計）

理由:
1. 受入基準が求める出力先は agent-health の日次で、agent-health は本番ログを読む仕組みを既に持っている。DB を読ませると、本番の DB に触れる経路が増える（隔離の失敗で本番 DB を掴んだ前例がある）
2. 書き込みが hook の返事・キー送信の経路に入らない。ログの出力は同期でも数十マイクロ秒で、DB の書き込みより軽い。§8 の「記録の失敗が回答を止めない」を構造で守りやすい
3. 今は「何件・何分か」を数えたいだけで、過去の任意の日を SQL で引く要件は無い。日次の数字は agent-health の結果に残る
4. migration が要らないので、記録をやめる・語彙を変えるときの戻しが軽い

C の欠点への手当て:
- **再起動**: `confirmationId` に起動ごとの `bootId` を含め、閉じていない `opened` の行から、集計側が「再起動で閉じなかった確認」を数える（§4.3）。長さは加えない
- **ローテート**: 24 時間分に満たないときは、`hook-observation` と同じく skip する（`docs/user-guide/agent-health.md:415`）
- **API・UI から読めない**: 「今止まっているか」は今の `lastPolicySuppression` が引き続き答える（§4.4）。表示を変えるのは #3821（判定の結果を事実と判断に分けて共有する）の範囲

`chat_messages` の `answeredBy` は**今の意味のまま残す**（History・`capture --prompts` の表示の正本。計測の正本にはしない）。例外は §5 の agy の allow の行だけ。

**未決（実装の前に決める）**: ログの行を本番の既定（`info`、`src/lib/env.ts:329`）で出すか。`info` で出す前提で書いた。`CM_LOG_LEVEL=warn` の利用者では数えられないが、agent-health は開発者の本番サーバーでしか動かないので、今は受け入れる。

### 3.3 ログの行（語彙）

タグは `lib/polling/auto-yes-confirmation-ledger`（新しいモジュール、§7 PR 1）。`[time] [LEVEL] [tag] event {json}` の形（`src/lib/logger.ts:203` `formatLogEntry`、agent-health の `TEXT_LINE` が読む形）。

| イベント | いつ | 主な項目 |
|---|---|---|
| `auto-yes-confirmation-opened` | 確認を初めて見た／受けた | `confirmationId`（`<bootId>-<連番>`。`bootId` はモジュールを読み込んだ時に 1 回作る乱数）・`worktreeId`・`cliToolId`・`instanceId`・`source`（`screen` / `hook` / `api` / `prompt-response`）・`promptType`・`callId`（あれば）・`cliPermissionMode`（あれば、§3.4） |
| `auto-yes-confirmation-closed` | 解消・放棄 | 上の識別＋`decision`・`basis`・`sent`・`sendAttempts`・`resolution`・`resolvedBy`・`openMs`（開いてから閉じるまで）・`withheldMs`（停止の区間の合計）・`reasons`（理由の履歴。`[{reason, atMs}]`、最大 8 件、超えた分は `reasonsDropped` に数だけ）・`afterHookAllow` |
| `auto-yes-confirmation-reason-changed` | 止めている確認の理由が変わった | `confirmationId`・`from`・`to` |

1 件の確認は原則 `opened` と `closed` の 2 行。理由が変わったときだけ 1 行増える。止めている間の tick ごとの行は出さない（今の WARN は `warnOncePerFrame` で 1 画面 1 回、`suppressAndWarnOnce()`）。

**集計に使うのは `closed` の `withheldMs`（サーバーが区間の始まりと終わりの時刻から計算した値）だけ。** ログの行の間隔から停止の時間を推定しない（`review-codex.md` R9 の陰性「ログの一分間隔をそのまま停止時間にする集計」）。

### 3.4 CLI 自身の自動許可との区別

- claude の auto モード・`bypassPermissions` では `PermissionRequest` が来ず、確認も出ない（`measurements-2026-10-20.md` §8）。これは CommandMate の Auto-Yes ではないので、**確認として数えない**。代わりに、hook で見えた `permission_mode` をインスタンスごとに覚え、`opened` の行に `cliPermissionMode` として添える。日次では「auto 系のモードで動いていたインスタンスの数」と「その間の `pre_tool_use` の件数」を別の欄に出す（CommandMate が答えた件数とは足さない）
- `permission_mode` は今 `PermissionRequest` にしか届かない（1.4 の表）。`PreToolUse` / `UserPromptSubmit` の中継に `permission_mode` を足すのは §7 PR 3（`stepIdx` と同じ中継の変更）
- **hook が来ないことを auto モードの証拠にしない**（基本方針 第 2 部）。モードが分からなければ `cliPermissionMode` は書かない
- **未決**: codex（`approval_policy`）と command-code（`.commandcode/settings.local.json` の `permissions`、`defaultMode`）の「自身の自動許可」をどう知るか。hook の本文にモードが載るかを測っていない。測る手順: 私設 tmux（`-L cmprobe-*`）と scratchpad のフォルダで素の CLI を起動し、自前の受け口で全 hook の本文を保存して、モードを切り替えたときに変わる欄を探す（`measurements-2026-10-20.md` の方法と同じ）。分かるまでは `cliPermissionMode` を書かない

---

## 4. 停止の区間

### 4.1 持ち方

- 区間は**確認に従属する**（確認 1 件につき、止めている区間は高々 1 つの連続した区間、または契約が変わって答えた場合は答えた時点で終わる）。確認と別の表は作らない
- メモリの記録（`globalThis` の `Map<confirmationId, LedgerEntry>`、インスタンスごとに開いている確認の索引つき）に、`withheldSince`（区間の開始）・`reasons`（理由の履歴）・`currentReason` を持つ
- `globalThis` に置くのは今の `auto-yes-suppression-state.ts` と同じ理由（書き手が hook の route と poller で、`next dev` では別々に束ねられる: 同ファイル 45-61 行）

### 4.2 開始・終了・理由の変化

| 出来事 | 区間への作用 |
|---|---|
| 初めて `withhold` と判断 | 開始（`withheldSince = now`、`reasons = [reason]`） |
| 次の tick も同じ理由で `withhold` | 何もしない（同じ確認の複数 tick は 1 件。陽性の受入基準） |
| 違う理由で `withhold` | 理由の変化を追加し、`reason-changed` の行を 1 行 |
| `answer` と判断して送信が `ok` | 区間を終える（`withheldMs` に加算）。確認は `sent` へ |
| 送信が `failed` / `partial` | 区間は終えない（`partial` は今も `partial-answer` で止める: `auto-yes-suppression-reason.ts:46`）。理由の変化として `partial-answer` を足す |
| 確認が解消（clear・別の画面キー・エピソードの終わり） | 区間を終えて確認を閉じる（`resolution: 'resolved-while-withheld'`） |
| poller の停止（`stopAutoYesPolling()`、`src/lib/auto-yes-poller.ts:1339`、理由つき）・Auto-Yes の OFF / 期限切れ・セッションの作り直し | 区間を終えて確認を閉じる（`resolution: 'abandoned'`、`abandonReason` に停止の理由） |
| `forgetPolicySuppression()`（契約が変わった、#3796） | 区間は終えない。次の tick の判断で理由が変わるか答えるかで決まる |

### 4.3 再起動と日をまたぐ区間

- 再起動でメモリの区間は消え、`closed` は出ない。サーバーの起動を示す構造化された行は今は無い（`server.ts` は `console.log` で起動を書く）ので、起動の行には頼らない。`confirmationId` の先頭の `bootId` が起動ごとに変わることを使い、集計は「`opened` があり、同じ `confirmationId` の `closed` が無く、その後に別の `bootId` の行が現れた」ものを `unclosedByRestart` として件数だけ数える（長さは加えない）
- 集計の窓（直近 24 時間）は `closed` の行の時刻で切る。窓の終わりに開いたままの確認は `openAtWindowEnd` として件数だけ出す
- **未決**: 長く止まった確認（数時間）を、閉じるまで数えないままでよいか。今の案では、閉じた日に全部の長さが入る。選択肢: (a) 今の案のまま、(b) 1 時間ごとに `withheld-ongoing` の行（その時点までの長さ）を出し、集計は窓の中の最後の値を使う。(b) は行が増えるが、#3767 のような 4 時間の停止がその日に見える。実際の停止の長さの分布を (a) で 2 週間見てから決める

### 4.4 今の「最後の 1 件」との関係

`recordPolicySuppression()` と `getLastPolicySuppression()` は**消さない**。読み手（`capture --json`・`cmate wait`・通知の保留）の契約で、「今止まっているか・なぜか」を答えている。計測の記録はその隣に足すもので、`suppressAndWarnOnce()` など書き手の共通の入口から両方を呼ぶ。読み手を計測の記録へ移すかは #3821（判定の結果の共有）で決める。

---

## 5. agy の hook の allow の監査記録の意味の直し方

### 5.1 決定

1. **ソースの能力に `permissionAllowSuppressesDialog`（allow を返すと確認が出ないか）を足す。** claude・codex・copilot は `true`、agy は `false`（1.1.12・1.1.27・1.4.2 で実測）、command-code は `false`（hook が確認の後に届く）、opencode / opencode-v2 は API で承認するので `true`、gemini は未実測なので `false`。ツール名での分岐にしない（`reportPendingDialog` が `permissionHookPredictsDialog` で分けているのと同じ書き方: `permission-decision-service.ts:421-433`）
2. `resolvePermissionRequest()` の allow の記録（536-538 行）は、この能力が `true` のときだけ `recordAllowedPermission()` で「答えた」行を書く。**`false` のときは `chat_messages` に行を書かない。** 確認が出れば画面の poller が `auto` の行を書くので、二重の記録が消える。計測の記録には `hook-decided`（判断 `answer`、根拠 `L2` 候補・**配送は「hook に allow を返した」だけで、確認への回答ではない**）として、同じ確認（§2.3 の `callId`）に付ける
3. agy で確認が出ないまま `PostToolUse` が来た場合（利用者の許可リスト・`read_file`）は、計測の記録で `closed(no-dialog)` とし、**「CommandMate が答えた」には数えない**。この呼び出しは agy 自身の許可で実行された
4. ログの `permission-request-decided`（`route.ts:288`）の項目に `allowSuppressesDialog` を足し、ログだけ読んでも「hook が allow した」と「確認なしで実行した」を分けられるようにする

### 5.2 なぜ行を書かないのか（比較した案）

| 案 | 内容 | 判断 |
|---|---|---|
| (a) 行を書かない（採用） | 画面の回答の行が正本になる | 564 件の二重の記録が消える。確認が出なかった呼び出しは CommandMate の回答ではないので、履歴に「Auto-Yes が許可した」と出さない方が正しい |
| (b) 行を書くが意味を変える（`status: 'answered'` をやめ、`hookVerdict` などの新しい欄） | 履歴に hook の判定が残る | `PromptAnsweredBy` / 表示（`src/components/worktree/ChatToolApprovalGroup.tsx`・`src/lib/chat/chat-tool-approvals.ts:531-545`）・`capture --prompts`（`src/cli/commands/capture.ts:229,272`）の読み方を全部直す必要がある。計測は §3 のログで足りる |
| (c) 今のまま | — | 方針の 4 節に反する |

**注意（実装の契約に書く）**: (a) は利用者に見える履歴から agy の hook の行が消える変更。changelog に書く。確認が出て人が答えた場合は、人の回答の行が残る。

---

## 6. agent-health の日次の集計

### 6.1 出し方

`hook-observation`（#3311）と同じ形の **metrics の指標を 1 つ足す**: `auto-yes-observation`。

- `METRIC_IDS` に足し、category は `process`（`src/lib/agent-health/metrics-types.ts:12-30,58`）。`process` は fail にならず、`candidates` は常に空（Issue を立てない）。何を候補にするかは、2 週間ほど数字を見てから別の Issue で決める（`hook-observation` と同じ扱い: `docs/user-guide/agent-health.md:421-422`）
- 読むのは metrics が既に 1 回読んでいる本番ログ（`metrics-perf.ts` の `addLogLine` が行を配る。`hook-observation` は 155 行で受けている）。同じ読み込みに `addAutoYesObservationLine()` を足す
- 窓は直近 24 時間（`PERF_LOG_WINDOW_HOURS`）。ログが無い・24 時間分に満たないときは skip（他の 3 指標と同じ）
- 公開リポジトリなので、`details` と `records` に載せるのは**件数・時間・ツール名・根拠の段・理由のコード（列挙された語彙だけ）**。worktree・インスタンス・確認の id・コマンド・質問の文面は写さない。語彙に無い値は `(other)` にまとめる（`metrics-perf.ts` の扱いと同じ）

### 6.2 中身

`value` = その日に止めた確認の件数（`withheldConfirmations`）。

`details`（日の合計）:

| 欄 | 意味 |
|---|---|
| `confirmations` | 閉じた確認の件数 |
| `answered` | 答えて、配送が `ok` だった件数（**配送の失敗・部分送信は含めない**） |
| `answerDeliveryFailed` / `answerPartial` | 配送の失敗・部分送信の件数 |
| `resolvedAfterAnswer` / `unresolvedAfterSend` | 答えた後に解消が見えた件数／見えないまま終わった件数 |
| `withheldConfirmations`（= `value`） | 止めた確認の件数 |
| `withheldMsTotal` / `withheldMsMedian` / `withheldMsP90` / `withheldMsMax` | 停止の区間の合計と分布 |
| `noDialog` | agy などで確認が出ないまま閉じた呼び出し（CommandMate の回答ではない） |
| `unclosedByRestart` / `openAtWindowEnd` | §4.3 |
| `cliAutoModeInstances` / `cliAutoModeToolCalls` | §3.4（CommandMate の回答とは足さない） |

`records`（内訳の行。`ci-flaky` と同じく表として持つ）:
- 回答: `{ kind: 'answered', tool, basis, count }`（ツール別・根拠の段別の回答数）
- 停止: `{ kind: 'withheld', tool, reason, count, totalMs, maxMs }`（理由別の停止の件数・時間。理由は区間の最後の理由で数え、理由が変わった件数は `reasonChanged` として別に数える）

`summary`（1 行）: `確認 N 件（回答 N・停止 N 件 合計 Xm・配送失敗 N）。回答の多い段: claude L1 N / agy L2 N …`。`metrics-rules.ts` の `hookObservationSummary` と同じ置き場所（`src/lib/agent-health/metrics-rules.ts:461-464`）に `case 'auto-yes-observation'` を足す。

### 6.3 文書

`docs/user-guide/agent-health.md` の指標の表（391 行の `hook-observation` の行の隣）と説明（421 行からの節の後）、`docs/agent-health/metrics-prompt.md:68`（観測だけの指標の列挙）に足す。英語版の agent-health の文書は無い（`docs/en/` に該当なし）。

---

## 7. 実装の PR 分割

4 本。順序: **PR 1 → (PR 2 と PR 4 は並行可) → PR 3**。

### PR 1: 記録の土台と画面の経路（poller）

- 変更ファイル:
  - 新規 `src/lib/polling/auto-yes-confirmation-ledger.ts`（状態遷移は純関数＋`globalThis` の記録＋ログの出力。時刻は引数で注入）
  - `src/lib/auto-yes-poller.ts`（`detectAndRespondToPrompt` の開く・判断・送信・解消、`noteNoPromptOnScreen` の解消、`settleFailedTick` の送信失敗、`stopAutoYesPolling` の放棄、再試行の `sendAttempts`）
  - `src/lib/polling/auto-yes-prompt-suppression.ts`（`suppressAndWarnOnce` から停止を記録。`suppressIfNotOursToAnswer` の `ours` に門の判定を載せて根拠の段を決める）
  - `src/lib/polling/auto-yes-poller-steps.ts`（`resolveAnswerUnderPolicy`・`withheldForEarlierSend`）
  - `src/lib/polling/auto-yes-poller-enter-fallback.ts` / `tryEnterFallback`（根拠 `enter-fallback`）
  - `src/lib/polling/auto-yes-poller-receipt-log.ts`（agy の `no-hook-receipt` の停止。agy の確認は `isPrompt: false` で返るので、poller の確認の経路でなくここで開く）
  - テスト: `tests/unit/polling/auto-yes-confirmation-ledger.test.ts`（新規）、poller の既存テストの隣に経路のテスト
- 根拠の段の決め方（PR 1 の範囲）: 門の判定が `gated && allowed && dialog` なら `L3`、`gated: false`（`legacy` のツール・`yes_no`）なら `L4`、Enter の補いは `enter-fallback`。agy の専用リーダーが読んで受信で受理した確認は、PR 3 までは `L3` とし `receiptAccepted: true` を添える（専用リーダーか汎用の推定かを返す欄は `PromptDetectionResult`（`src/lib/detection/types.ts:69-83`）に無いので、`detectPromptOnCleanFrame`（`src/lib/polling/response-checker.ts:281`）の agy の分岐から分かる範囲で付ける）
- 受入基準:
  - 陽性: 同じ確認が 5 tick 続き、止めたまま解消 → `opened` 1 行・`closed` 1 行・`withheldMs` は最初の判断から解消まで
  - 陽性: 答えた後 10 秒を超えて残り再試行 → 同じ確認で `sendAttempts: 2`
  - 陰性: 質問が同じで `approvalTarget` が違う 2 つの確認が続く → 2 件
  - 陰性: 送信が throw → `sent: 'failed'` で `answered` に数えない。部分送信 → `partial`
  - 停止の区間: 開始・理由の変化（`type-not-allowed` → `deny-pattern`）・終了（解消／答えた／poller 停止）がそれぞれテストで固定される
  - 記録の関数が throw しても、`detectAndRespondToPrompt` の戻り値・キー送信・既存のログと `lastPolicySuppression` は変わらない（記録を throw させる差し替えで確かめる）
  - 既存の poller のテストは期待値を変えずに通る（答え方は変えない）
- 依存: なし

### PR 2: hook・API・`/prompt-response` の経路と、allow の監査記録の意味

- 変更ファイル:
  - `src/lib/hooks/sources/types.ts`（`AgentSourceCapabilities` に `permissionAllowSuppressesDialog`）（`AgentSourceCapabilities` は 344 行）と各ソース（`claude`・`codex`・`copilot`・`antigravity`・`command-code`・`opencode`・`opencode-v2`・`gemini`、`legacy-relay.ts` も。宣言は `define-source.ts` を通る）
  - `src/lib/hooks/permission-decision-service.ts`（判断を記録、能力が `false` なら `recordAllowedPermission` を呼ばない、`permissionMode` を記録へ）
  - `src/app/api/hooks/permission-request/route.ts`（`permission-request-decided` に `allowSuppressesDialog`）
  - `src/lib/hooks/permission-adjudication.ts`（opencode の配送・解消）
  - `src/hooks/useAutoYes.ts` と `src/app/api/worktrees/[id]/prompt-response/`（本文に `origin: 'auto-yes-browser'` を足し、計測の記録で `browser` と人を分ける。**`answeredBy` は変えない**。#3821 でブラウザの自動回答をやめるまでの基準の数字を取るため）
  - テスト: 能力の表のテスト（`tests/unit/hooks/sources/capabilities.test.ts`。全ソースが宣言している）、agy の allow で行を書かないこと、claude の allow で今までどおり行を書くこと（陰性）
- 受入基準:
  - claude / codex / copilot の allow → 計測の確認 1 件（`L1`・`released-by-hook`）と `chat_messages` の行 1 行（今と同じ）
  - agy の allow → `chat_messages` に行を書かない。計測には hook の判断として残る
  - `/prompt-response` の `origin` 付き → `basis: 'browser'`、無し → 人。配送の失敗（`success: false`・500）は回答に数えない
  - opencode の配送の失敗（`delivered: false`）は回答に数えない
- 依存: PR 1（記録のモジュール）

### PR 3: agy の確認の識別（`stepIdx`）と、hook の allow と画面の回答の結び付け

- 変更ファイル:
  - `src/lib/hooks/permission-request-payload.ts`（`callId` の欄）、`src/lib/hooks/sources/antigravity/source.ts`（`stepIdx` を読み `conversationId:stepIdx` を `callId` に）
  - `src/lib/polling/antigravity-permission-receipts.ts`（受信記録に `callId`）、`src/lib/polling/antigravity-receipt-episodes.ts`（受理した受信の `callId` を返す）
  - `scripts/hooks/cmate-agent-event.sh`（`post_tool_use` で `stepIdx` を、`pre_tool_use` / `user_prompt_submit` で `permission_mode` を本文に）、`src/lib/hooks/agent-event-intake.ts` と受け口（読む）
  - 中継のテスト（`tests/unit/scripts/cmate-agent-event.test.ts` ほか同じ接頭辞のもの）、受け口のテスト、記録の結び付けのテスト
- 受入基準:
  - agy で `PreToolUse(allow, stepIdx=25)` → 画面の確認 → poller が答える → `PostToolUse(stepIdx=25)` が **1 件の確認**として記録される（`basis: 'L2'` 候補ではなく、今の受信窓のままなので `L3` + `callId`。L2 の照合は保留の項目）
  - 陰性: 同じコマンドの 2 回の呼び出し（`stepIdx` 25 と 27）は 2 件
  - 陰性: 確認で「No」→ `PostToolUse` が来ない → 画面から消えた時点で閉じる（`resolvedBy: 'unknown'`）
  - `read_file` のように確認が出ない → `closed(no-dialog)`
  - 中継が `stepIdx` の無い古い本文でも今までどおり受け付ける（後方互換）
- 依存: PR 1・PR 2（能力と hook の記録）

### PR 4: agent-health の日次の集計

- 変更ファイル:
  - 新規 `src/lib/agent-health/auto-yes-observation.ts`（純関数: 行 → 測定）
  - `src/lib/agent-health/metrics-types.ts`（`METRIC_IDS`・`METRIC_CATEGORY`）、`metrics-perf.ts`（行を配る）、`metrics-rules.ts`（`summary`）、`scripts/agent-health/metrics-runners.ts`（`fromServerLog`）
  - `docs/user-guide/agent-health.md`・`docs/agent-health/metrics-prompt.md`
  - テスト: 行の fixture から `details` / `records`（`os.tmpdir()` に置いたログで）
- 受入基準:
  - PR 1 の語彙の行から、ツール別・根拠の段別の回答数と、理由別の停止の件数・時間が出る
  - 陰性: `closed` の無い `opened` の行の間隔を停止の時間にしない。配送の失敗を回答に数えない。`details` に id・パス・文面が載らない
  - 知らない根拠の段・理由は `(other)` にまとまる（PR 2・3 が後から足す値で壊れない）
- 依存: PR 1（ログの語彙）。PR 2・3 より先にマージしてよい

---

## 8. 影響（動作・性能・DB の書き込み量）と、失敗の扱い

### 8.1 回答を止めない

- 記録の入口はすべて `try { … } catch { logger.debug(…) }` で包み、**throw しない**。呼ぶ位置は、判断が決まった後・キー送信が戻った後で、判断の分岐の条件には使わない（記録は読むだけの側。今の `lastPolicySuppression` の説明「Exposure only: nothing reads this to make a decision」と同じ）
- hook の route では、記録を返事の後に回せない（同期のハンドラ）ので、メモリの更新とログの 1 行だけにする（O(1)、I/O の待ちなし）。DB は使わない（§3.2）
- PR 1 の受入基準に「記録が throw しても答え方が変わらない」テストを入れる

### 8.2 ポーラーの動作・性能

- 1 tick あたりの追加はメモリの `Map` の参照と比較だけ。行を出すのは確認の開閉と理由の変化のときだけで、止めている間の tick ごとには出さない
- メモリ: 開いている確認だけを持ち、閉じたら消す。インスタンスごとに開いている確認は通常 1 件。念のため上限（例: インスタンスあたり 16 件・全体 1,024 件）を置き、超えたら古いものを `abandoned(capacity)` で閉じる
- **未決**: 上限の値。今の稼働（同時のインスタンス数十）では届かない値を置く想定で、実装の PR で決める

### 8.3 書き込み量

- DB への書き込みは**増えない**（§3.2 の C）。PR 2 で agy の allow の行が無くなる分、`chat_messages` への INSERT は減る（`auto-yes-per-agent-target.md` の数え方で 2026-08-01〜10-20 に 564 行）
- ログ: 確認 1 件につき 2 行（理由が変わればもう 1 行）。過去の件数（同資料: claude の hook 5,461・codex の hook 12,832 が 81 日、画面の回答は多い日で command-code 約 300/日）から、多い日でも 1 日に 1,000 件前後 → 2,000〜3,000 行。`LOG_VOLUME_ALERT_LINES`（1 つの名前で 20,000 行/日、`metrics-types.ts`）を下回る。増え方は `log-volume` で確かめる
- **実機で測る手順（この契約では測らない）**: PR 1 を入れた隔離サーバー（`CM_DB_PATH` と private HOME を `os.tmpdir()` 配下に置き、`lsof` で本番の DB を掴んでいないことを確かめる）で、claude と agy のインスタンスに Auto-Yes を ON にして確認が出る作業を 1 時間させ、(1) `auto-yes-confirmation-*` の行数、(2) `poller:response-sent` の行数との比、(3) tick の所要時間（既存のログ）の前後差を見る

---

## 9. 未決の一覧

| 項目 | 選択肢 | 決め方 |
|---|---|---|
| ログの行の水準（§3.2） | `info`（案）/ `warn` | 利用者の `CM_LOG_LEVEL` の実態。今は `info` で進める案 |
| 長い停止を閉じる前に見せるか（§4.3） | (a) 閉じた日に全部 / (b) 1 時間ごとの途中の行 | (a) で 2 週間の分布を見てから |
| codex・command-code の「自身の自動許可」の知り方（§3.4） | hook の本文 / 設定ファイルを読む / 書かない | §3.4 の手順で hook の本文を測る |
| 開いている確認の上限（§8.2） | 値 | PR 1 で決める |
| claude の安全確認と、直前の hook の allow が同じ呼び出しか（§2.3） | — | 基本方針 第 2 部「claude の L2」で保留。この Issue では `afterHookAllow` を添えるだけ |
| 日次の数字の候補化（§6.1） | — | 2 週間の数字を見てから別の Issue |
