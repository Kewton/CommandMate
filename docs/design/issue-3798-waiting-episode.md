# Issue #3798 waiting の区間（WaitingEpisode）に ID と帰属を持たせる設計

- 対象 Issue: #3798（ブラウザを開いていないと agy の waiting の区間が閉じない）
- 版: 第 2 版（2026-10-23、レビュー 1 回目を反映）。第 1 版はコミット `81f762b1e`。土台は develop `4ec3c066b`
- 位置づけ: **設計書の段**。コードは 1 行も変えていない。この文書が独立したレビューを通ってから、実装の契約が別に送られる
- 入力: Issue 本文、2026-10-19 のコメント（作り直しの設計 第 2 版: 破れ 7 件の表・規則 1〜8・追加の受入基準）、UAT 記録 `workspace/orchestration/runs/2026-10-18/uat-3788.md` 項目 D、保留ブランチ `fix/3798-waiting-interval-close-no-browser`（HEAD `07610c745`）、独立レビュー 1 回目 `workspace/orchestration/runs/2026-10-23/review-3798-design-1.md`（指摘 12 件・まだ破れる順序 8 件・受入基準との対応の抜け）

## 0. 表記

- **[事実]** は develop のコードを読んで確かめたこと。参照は `path:line`（develop `4ec3c066b` 時点の行番号）
- **[見立て]** は推論。実機でもテストでも確かめていない
- **未確認** は調べたが確かめられなかったこと
- 「区間」は `WaitingEpisode`、「turn」は `TurnRecord`（`src/lib/session/provisional-turn.ts:309`）、「世代」は `generationStartedAt`（`src/lib/session/agent-event-turn.ts:51`）
- 「レビュー指摘 N」はレビュー 1 回目の指摘番号、「残る順序 N」は同レビューの「まだ破れる順序」の番号

この文書は型・不変条件・呼び出しの順序・同期区間の境界・失敗時の扱いを決める。関数本体は書かない。

---

## 1. 現状の調査

### 1.1 型

[事実]
- `WaitingEpisode` は `{ since: number; kind: WaitingKind | null }` だけ（`src/lib/session/waiting-episode-state.ts:70-81`）。ID も、どの turn・世代で開いたかも持たない
- 区間の置き場は `globalThis.__sessionWaitingEpisodes`（compositeKey → 区間、`waiting-episode-state.ts:64`）。インスタンスごとに高々 1 つ
- 遷移の通知は `WaitingTransition`（`waiting-episode-state.ts:84-97`）。`waiting: true|false`・`since`・`kind`・`at` で、区間の ID も「置き換え」も表せない
- 書き手は `observeWaitingEdge()`（`waiting-episode-state.ts:162-193`）。`waiting:false` なら区間を消して閉じる edge を出し、`waiting:true` で既存があれば `kind` だけ更新して `since` を返し、無ければ `structuredSince ?? now` で開く
- `turnId` は `turn-<at>-<seq>`（`agent-event-turn.ts:144-147`）で、同一ミリ秒でも区別できる。区間にはこれに相当するものが無い

### 1.2 区間を開く経路

| # | 経路 | 場所 | since | 備考 |
|---|---|---|---|---|
| O1 | status の問い合わせ（ブラウザ・`commandmate ls` 等） | `src/lib/session/worktree-status-helper.ts:884` | `frame.structuredWaitingSince`（= `peekPromptWaiting().structured.at`、`:688`）か now | 待ちの判定は scraper の status と構造化の decision の OR（`:663`） |
| O2 | 応答 poller が確認を検出 | `src/lib/polling/response-checker.ts:941`（`savePromptMessage`、`:814`） | `getWaitingEpisode()?.since ?? promptObservedAt`（`:910-912`） | 本文ハッシュの重複除外 `isDuplicatePrompt`（`:841`）を通ったものだけ。**push を先に出し（`:921-938`）、その後に区間を開く**。全画面 TUI（opencode・copilot、`:761`）でなければ直後に `stopPolling`（`:950-952`） |

[事実] `observeWaitingEdge` を呼ぶのはこの 2 箇所と、閉じる側の `response-checker.ts:1465` だけ。Auto-Yes poller・hook の受信・`applyAgentStopEvent` は区間に触れない（レビューも同じ確認をした）。

### 1.3 区間を閉じる経路

| # | 経路 | 場所 | 条件 |
|---|---|---|---|
| C1 | status の問い合わせ | `worktree-status-helper.ts:884` | `frame.isWaitingForResponse === false`。session が動いていない・capture が throw（`:875-878`）・未分類の画面もすべて「待っていない」になる（`:542-545` のコメントがこの決定を書いている）。「動いていない」は呼び手が先に取った tmux の一覧（`sessionNameSet`、`:816`）で決まる |
| C2 | 応答 poller が返答を記録 | `response-checker.ts:1465` | 返答を保存した tick の末尾。`mayStillActAfter(ctx,'conversation-log')`（`:1420`）を通った後、`await` なし |

[事実] 区間がどの turn のものかは、どちらの経路も見ない。C1 は自分の capture の `await`（`:841`・`:870`）の間に別の経路が開いた区間でも、戻ってきた時点の判定で閉じる。`sessionNameSet` は呼び手（`src/app/api/worktrees/route.ts:138`、`src/app/api/worktrees/[id]/route.ts:67`）が `listSessions()` の await で取ったもの。

Issue 本文は閉じる行を `response-checker.ts:1448` としているが、develop では呼び出しが `:1465`（説明コメントは `:1457`）。

### 1.4 since を引き継ぐ（流用する）経路

- [事実] O2 は開いている区間があればその `since` を自分の確認の since として使い（`response-checker.ts:911-912`）、gate（`:922-927`）と push（`:929-938`）に渡す。前の確認の区間が閉じていなければ、次の確認は前の区間の since・hold・dedup をそのまま引き継ぐ
- [事実] O1 も既存の区間があれば `kind` を更新するだけ（`waiting-episode-state.ts:181-187`）

### 1.5 区間を読む側

| 読み手 | 場所 | 区間の何で識別するか |
|---|---|---|
| Auto-Yes の hold | `src/lib/push/prompt-push-gate.ts:172-190` | `hold.since !== input.waitingSince` で新しい hold（`:179`）。`forgetAutoYesHold(key, since)`（`:271-274`）。起点は `max(firstHeldAt, lastServerResponseTimestamp)`（`:188-189`） |
| 抑止記録の帰属 | `prompt-push-gate.ts:351-354` | `suppression.at >= waitingSince`（時刻） |
| 通知の dedup | `src/lib/push/notification-dedup.ts:132-143` | `WaitingPushRecord.since`（`:95-100`）。キーは `${worktreeId}::${instanceId}` |
| push の分岐 | `src/lib/push/push-sender.ts:585-591` | `waitingSince` があれば `shouldSendWaitingPush`。`notifyPushSubscribers` の dedup は最初の `await` より前（`:611-619`） |
| 通知の保持・再判定・reminder | `src/lib/push/waiting-push-notifier.ts` | `PendingWait.since`（`:111-117`）。`releaseAutoYesHold`（`:289-305`）・`releaseHeldWait`（`:318-340`）・`runEscalationTick`（`:441-489`）はすべて `episode.since !== held.since` で別の区間と判定 |
| 解除通知 | `src/lib/push/resolution-push-notifier.ts:145` | `hasOpenWaitingEpisode(worktreeId)`（worktree 単位。区間を照合しない） |
| カードのマーク | `src/lib/push/prompt-card-state.ts` | worktree ごとに 1 行・1 文で書く（読み直して書き戻す操作を挟まない、モジュールの docblock） |
| 端末側の解除 | `public/sw.js:186-208`・`:220-258` | `tag`（`<worktreeId>:prompt`）の通知を全部閉じてから無音の置き換えを出す。区間を照合しない。**「閉じて何も出さない」分岐は持たない契約**（`userVisibleOnly:true`、`:170-183`） |
| WebSocket | `src/lib/realtime/waiting-broadcast.ts:74-76` | `transition.waiting` / `since` |
| relay | `src/lib/relay/relay-triggers.ts:134` | `transition.waiting && kind==='prompt'` |
| `commandmate wait` の抑止表示 | `src/cli/commands/wait.ts:245-264` | `autoYes.lastSuppression.at` が 60 秒以内か（`SUPPRESSION_FRESH_MS`）。区間を見ない（`current-output` は since を公開していない: `wait.ts:234-237` のコメント） |
| opencode の質問 push | `src/lib/hooks/sources/opencode/push.ts:34-44`・`:172` | `waitingSince: askedAt`。区間を開かずに、status-helper が後で同じ値で開くことに頼って dedup を合わせている |

### 1.6 turn model 側の事実

- `recordAgentEvent` は late `session_start` を保留したとき以外 `{ recorded: true }` を返す（`src/lib/session/agent-event-state.ts:346-401`）。turn が実際に閉じたか・拒否されたかは返さない
- `applyTurnTransition`（`agent-event-turn.ts:466-519`）: 世代より前の event は捨てる（`:470`）。`user_prompt_submit` は turn を開いた後に `releaseAllDecisions`（`:476-477`）
- `applyStopToTurn`（`:687-713`）: 開いている turn に別 session の stop が来たら何もせず `return`（`:694`）。開いている turn が無ければ、session を見ずに `openedAt:null` の閉じた記録で上書きする（`:701-712`。dialog だけの記録の decision も捨てる）
- `openTurn`（`:567-614`）: dialog だけの記録（`openedAt:null, closedAt:null`）の decision は新しい turn に運ばれる（`:591-593`）。開いている同じ session の turn を印の無い prompt が置き換えたときは `reopenedTurns` に残す（`:609-613`）。置き換えの理由は #3330 の重複だけでなく、中断後の再送もある（`:400-420` の docblock）
- `joinOpenTurnFromDuplicate`（`:650-675`）: queued notice の印つき複製で、置き換えた turn を元の ID で戻す
- `openDecision`（`:828-`）が作る dialog だけの記録は `sessionId: null`（`:846`・`:863`）。`idle_prompt` も turn が無ければ `openedAt:null, closedAt:null, pendingDecisions:[]` の表示だけの記録を作る（`:800-811`）。**形だけでは dialog だけの記録と区別できない**
- `fenceTurnForNewGeneration`（`:347-368`）: 世代更新で decision を捨て、開いている turn を `closedBy:'generation'` で閉じる。呼び手は `recordAgentEvent` の `session_start`（`agent-event-state.ts:395`）と `beginAgentEventGeneration`（`:447`、呼び手は `src/lib/session/agent-session-lifecycle.ts:90`）
- `closesTurn` は片方の sessionId が null なら同じ session とみなす（`provisional-turn.ts:547-550`）
- turn は stop 以外でも閉じる: `observeScraperCompletionEvidence`（`agent-event-turn.ts:311-345`）が画面の `ready`（positive）を 3 回続けて読むと `scraper_evidence` で閉じる。呼び手は `current-output-builder.ts:1002`（`commandmate wait`・`capture`・端末画面が回す）。`mayClose` を false にするのは codex だけ（`src/lib/detection/turn-abandoned.ts:43-46`、`src/lib/session/hook-turn-hold.ts:46-52`）で、agy は閉じられる。`effectiveTurn` は読み出し時に 30 分で `stale` として閉じる（`agent-event-turn.ts:133-142`、`TURN_STALE_AFTER_MS`: `provisional-turn.ts:123`）。どちらも遷移の通知は無い

### 1.7 recordAgentEvent の呼び手と await の位置

| 経路 | turn への記録（同期） | 記録の前後の await | 区間への作用（今） |
|---|---|---|---|
| `POST /api/hooks/agent-event`（agy・claude・codex 等） | `applyAgentEventToState` → `recordAgentEvent`（`src/lib/hooks/agent-event-intake.ts:340-398`） | 後: `await applyAgentStopEvent`（`src/app/api/hooks/agent-event/route.ts:177`）。記録との間に `await` は無い（route の `await` は `:73` と `:177` だけ） | なし |
| opencode ingest（一般） | `recordAgentEvent`（`src/lib/hooks/sources/opencode/ingest.ts:414`） | 後: `await applyStop`（`:434`）→ 動的 import（`:253-257`）→ `applyAgentStopEvent`（`:268`） | なし |
| opencode ingest（permission） | `recordAgentEvent`（`:386`） | **前**: `await adjudicatePermission`（`:385`）。古い `receivedAt` の記録が await の後に入る | なし |
| opencode V2 ingest | `recordAgentEvent`（`src/lib/hooks/sources/opencode-v2/ingest.ts:233`・`:240`・`:253`・`:298`・`:301`） | 後: `await stopEffect`（`:299`）→ 動的 import（`:74-78`）→ `applyAgentStopEvent`（`:85`） | なし |
| respond の構造化回答 | `recordAgentEvent(notification/permission_replied)`（`src/app/api/worktrees/[id]/respond/structured-decision.ts:712`） | 前: 回答の送信の await（`structured-decision.ts:631`・`:634`。:712 がどの関数の中かは実装の段で確かめる） | なし |
| 構造化回答の配信 | 同上（`src/lib/hooks/structured-decision-response.ts:529`） | 前: 動的 import の await（`:528`） | なし |
| decision の再確認 | 同上（`src/lib/hooks/pending-decision-recheck.ts:149`） | 前: 動的 import の await（`:148`） | なし |
| `POST /api/hooks/claude-done`（識別子なしの旧形式） | **turn model に記録しない** | body の読み（`src/app/api/hooks/claude-done/route.ts:34`）→ capture（`:58`）→ ログ保存（`:72`）→ `applyAgentStopEvent`（`:100`） | なし |

[事実] `applyAgentStopEvent`（`src/lib/hooks/agent-event-service.ts:244-`）は `recordAgentStopEvent`（時刻だけ）→ 履歴の読み（await）→ task 遷移・検証。区間には触れない。

### 1.8 Auto-Yes poller の読み方（受信窓）

[事実] agy の Auto-Yes poller は確認を `detectPromptOnCleanFrame` に受信の範囲（`receiptScope`）を渡して読む（`src/lib/auto-yes-poller.ts:682-711`）。agy がこのインスタンスについて数秒以内に CommandMate へ問い合わせた確認だけが「確認」と読まれ、窓の外では本物の確認でも `no_prompt` になり `noteNoPromptOnScreen` → `logIfWithheldForWantOfReceipt` で記録される（`:957-991`）。status API・応答 poller・通知は範囲を渡さずに読む（同 `:960-963` のコメント）。`detectSessionStatus` の結果は `status` と、範囲を渡さない読みの `hasActivePrompt`・`promptDetection` を持つ（`src/lib/detection/status-detector.ts:60-80`）。

### 1.9 事象の説明（UAT 項目 D との対応）

[事実]（UAT 記録）1 回目: 09:28:14.804 に区間が開く → 15.119 に `response-sent` → 18.839 に stop → 24.121 に `prompt-push-allowed (auto-yes-not-answered)`。3・4 回目は `waitingSince` が 1 回目の値のまま、poller が答える前に `prompt-push-allowed`。

[見立て] 説明は Issue の見立てどおり。agy の返答は hook で届くので C2 に来ず、ブラウザが無いので C1 も来ない。区間が開いたままなので、hold の終わりの再判定（`waiting-push-notifier.ts:289-305`）が `auto-yes-not-answered` を出し（1 回目）、次の確認で O2 が古い since を流用して即座に通知可になる（3・4・6・7 回目）。保留ブランチの最初のコミット `bfcf02c8f` がテストでこの 2 つの形を再現している（コミットメッセージ。この文書では再実行していない）。

---

## 2. 設計

### 2.1 方針

1. 区間は **ID・帰属（binding）・版** を持つ。同一性は ID だけで判定し、時刻は表示と経過時間に使う（規則 1）
2. turn の遷移（stop・開始・世代・session_end・復元）は、**turn model を書き換えたその同期区間の中で**区間に作用する。後段の `await` の後では区間を操作しない（規則 2・8）
3. 画面の観測（status-helper・応答 poller・Auto-Yes poller）は **1 つの画面の読み方**（受信窓を見ない）と **1 つの観測関数** を使い、帰属の推定を各自で持たない。観測は始めた時点の **版** を渡し、戻った時点で版が同じときだけ区間を変える（規則 3・4）
4. 帰属の違う区間への入れ替えは **1 つの操作**（`replaced`）にし、途中で「誰も待っていない」を出さない（規則 5）
5. push 側の hold・dedup・reminder・解除・抑止記録は区間 ID で照合する（規則 5・7）

### 2.2 型

```ts
// src/lib/session/waiting-episode-state.ts

/** プロセス内で一意。時刻を含めない（同一ミリ秒でも別）。 */
export type WaitingEpisodeId = string; // `wep-<bootNonce>-<seq>`。seq は globalThis の単調増加カウンタ

/** 世代の参照。「世代が開かれていない」を null と混ぜない。 */
export type GenerationRef =
  | { kind: 'opened'; at: number }   // generationStartedAt の値
  | { kind: 'none' };                // このプロセスで世代が一度も開かれていない

/** 区間がどの待ちとして開いたか（規則 1: 帰属不明・確認だけ・開いた turn・世代を 2 値に潰さない）。 */
export type EpisodeBinding =
  /** turn T の中の待ち。T の終わりで閉じうる。 */
  | { kind: 'turn'; generation: GenerationRef; turnId: string }
  /** 確認だけが先に来ている（dialog だけの記録で、pendingDecisions が 1 件以上）。 */
  | { kind: 'dialog-only'; generation: GenerationRef; recordTurnId: string; sessionId: string | null }
  /** 現世代で開いている turn も、decision を持つ dialog の記録も無いときに見えた待ち。 */
  | { kind: 'unattributed'; generation: GenerationRef; lastClosedTurnId: string | null }
  /** 画面固有の人待ち（survey・picker・信頼確認など）。turn の終わりでは閉じない（規則 3）。
   *  originTurnId は screen になる前の帰属（turn だったときだけ）。 */
  | { kind: 'screen'; generation: GenerationRef; originTurnId: string | null };

export type WaitingObserver =
  | 'status-probe' | 'response-checker' | 'auto-yes-poller'
  | 'turn-transition'  // recordAgentEvent / beginAgentEventGeneration / 復元
  | 'legacy-stop';     // claude-done

export interface WaitingEpisode {
  episodeId: WaitingEpisodeId;
  /** 表示・経過時間用。開いた後は動かさない。同一性に使わない。 */
  since: number;
  kind: WaitingKind | null;
  binding: EpisodeBinding;
  openedBy: WaitingObserver;
  /** 開いたときの確認の画面キー（partialAnswerScreenKey、auto-yes-poller-state.ts:180）。分からなければ null。 */
  promptScreenKey: string | null;
}

/** compositeKey ごとの単調な版。区間を開く・閉じる・置き換える・rebind するたびに 1 増える（kind の更新では増えない）。 */
export type EpisodeVersion = number;

export type WaitingCloseReason =
  | 'turn-stop' | 'turn-session-end' | 'turn-superseded' | 'generation'
  | 'screen-cleared' | 'session-gone' | 'response-recorded' | 'poller-answered' | 'legacy-stop';

/** 既存の形に cause・episodeId を足す。既存の購読者は waiting/since だけ読めば今までどおり動く。 */
export interface WaitingTransition {
  worktreeId: string; cliToolId: CLIToolType; instanceId: string | undefined;
  waiting: boolean;          // opened/replaced: true、closed: false
  since: number | null;
  kind: WaitingKind | null;
  at: number;
  cause: 'opened' | 'closed' | 'replaced';
  episodeId: WaitingEpisodeId | null;         // opened/replaced: 新しい区間、closed: null
  previousEpisodeId: WaitingEpisodeId | null;  // closed/replaced: 終わった区間
  closeReason: WaitingCloseReason | null;      // closed/replaced のときだけ
}
```

turn model が返す結果（規則 2: 「記録した」と「turn を終わらせた」を分ける）:

```ts
// src/lib/session/agent-event-turn.ts
export type PreviousTurn =
  | { kind: 'none' }
  | { kind: 'dialog-only'; turnId: string; decisions: number; sessionId: string | null }
  | { kind: 'display-only'; turnId: string }          // idle_prompt の表示だけの記録（decision 0 件）
  | { kind: 'open-same-session'; turnId: string }     // 印の無い prompt の置き換え（#3330 の重複 / 中断後の再送）
  | { kind: 'open-other-session'; turnId: string }
  | { kind: 'closed'; turnId: string; closedBy: TurnCloseReason };

export type TurnTransitionOutcome =
  | { kind: 'none' }
  | { kind: 'opened'; turnId: string; generation: GenerationRef; previous: PreviousTurn; carriedDecisions: boolean }
  | { kind: 'continued'; turnId: string }
  | { kind: 'restored'; restoredTurnId: string; discardedTurnId: string }
  | { kind: 'stopped'; turnId: string; generation: GenerationRef }                           // 開いている turn を閉じた
  | { kind: 'stop-without-turn'; recordTurnId: string; generation: GenerationRef; previous: PreviousTurn } // :701 の分岐
  | { kind: 'stop-rejected'; reason: 'other-session' | 'before-generation' }
  | { kind: 'session-ended'; turnId: string }
  | { kind: 'session-end-rejected'; reason: 'other-session' | 'no-turn' | 'before-generation' }
  | { kind: 'decisions-released'; turnId: string; remaining: number }
  | { kind: 'generation-fenced'; generation: GenerationRef; fencedTurnId: string | null };

// src/lib/session/agent-event-state.ts
export type AgentEventRecordOutcome =
  | { recorded: true; turn: TurnTransitionOutcome; episode: EpisodeEffect }
  | { recorded: false; skipped: 'late-session-start' };
```

turn model の変更（レビュー指摘 6）:
- `openDecision` の入力に `sessionId: string | null` を足し、dialog だけの記録を新しく作るときに入れる（`applyNotificationToTurn` は `record.sessionId` を持つ。`reportPermissionRequestPending` 側に session ID があるかは未確認。無ければ null）
- `applyStopToTurn` の `:701` の分岐で、上書きされる記録が dialog だけ（decision 1 件以上）で、その sessionId と stop の sessionId が両方 non-null かつ異なるときは、**上書きせず** `stop-rejected(other-session)` を返す。今は session を見ずに上書きして decision を捨てているので、これは turn model の挙動の変更（既存テストがこの上書きを固定しているかは未確認。固定していれば実装の段で本文に無い指摘として扱う）

観測（規則 3・4）:

```ts
// src/lib/detection/waiting-screen-reading.ts（新設。detection 層に置き、polling を import しない）
/** 受信窓を見ない共通の画面の読み方（レビュー指摘 1）。全観測者がこれを使う。 */
export type ScreenReading =
  | { kind: 'waiting'; waitingKind: WaitingKind | null; humanHeld: boolean;
      promptScreenKey: string | null; structuredSince: number | null }
  | { kind: 'not-waiting' }
  | { kind: 'unknown' }   // capture 失敗・分類できない画面
  | { kind: 'gone' };     // session が動いていない
export function readWaitingScreen(input: {
  cliToolId: CLIToolType; output: string; lastOutputTimestamp?: Date;
  structuredWaiting: boolean; structuredSince: number | null;
}): ScreenReading;
// humanHeld = detectSessionStatus(output, cliToolId, lastOutputTimestamp) の status==='waiting' かつ hasActivePrompt===false かつ構造化の待ちも無い
// promptScreenKey = hasActivePrompt のとき promptDetection.promptData から partialAnswerScreenKey

// src/lib/session/waiting-episode-binding.ts（新設）
export interface ObservationStart {
  generation: GenerationRef;
  version: EpisodeVersion;
  episodeId: WaitingEpisodeId | null; // ログ用
}
export interface WaitingObservation {
  worktreeId: string; cliToolId: CLIToolType; instanceId?: string;
  observer: 'status-probe' | 'response-checker' | 'auto-yes-poller';
  start: ObservationStart;
  reading: ScreenReading;
  /** response-checker が isDuplicatePrompt を通した新しい確認として保存するとき true。auto-yes-poller が答えを送る直前も true。 */
  freshPrompt?: boolean;
  now?: number;
}
export type ObservationAction = 'opened' | 'kept' | 'rebound' | 'replaced' | 'closed' | 'ignored';
export interface WaitingObservationPlan {
  action: ObservationAction;
  episode: Pick<WaitingEpisode, 'episodeId' | 'since' | 'kind' | 'binding'> | null; // 適用後に開いている区間
  basedOnVersion: EpisodeVersion;
}
export function startWaitingObservation(worktreeId, cliToolId, instanceId?): ObservationStart;
export function planWaitingObservation(obs: WaitingObservation): WaitingObservationPlan;   // 純粋
export function commitWaitingObservation(key, plan: WaitingObservationPlan): ObservationAction; // 版が basedOnVersion と違えば 'ignored'
export function observeWaiting(obs: WaitingObservation): WaitingObservationPlan;          // plan + commit

/** turn の遷移を区間に反映する。turn を書き換えた同期区間の中で呼ぶ。 */
export function applyTurnOutcomeToEpisode(key: CompositeKeyParts, outcome: TurnTransitionOutcome, at: number): EpisodeEffect;
export type EpisodeEffect = { action: 'closed' | 'rebound' | 'none'; episodeId: WaitingEpisodeId | null };

/** 規則 6: claude-done。 */
export interface LegacyStopTarget { generation: GenerationRef; episodeId: WaitingEpisodeId | null }
export function captureLegacyStopTarget(worktreeId, cliToolId, instanceId): LegacyStopTarget;
export function settleLegacyStop(worktreeId, cliToolId, instanceId, target: LegacyStopTarget):
  'closed' | 'target-gone' | 'hook-authority' | 'screen' | 'nothing-open';
```

Auto-Yes poller の状態（PR 3）:

```ts
// src/lib/polling/auto-yes-poller-state.ts（#3796 の欄には触らない）
lastAnswer?: { episodeId: WaitingEpisodeId; screenKey: string; at: number };
```

stop の権限（規則 6）: `__waitingHookStopGeneration: Map<compositeKey, GenerationRef>`。`applyTurnOutcomeToEpisode` が `stopped` / `stop-without-turn` を受けたとき、その世代を書く。

`observeWaitingEdge` は既存のテストと呼び手のために残し、`observeWaiting` に `start` を「今」で埋めて委ねる薄い層にする（戻り値 `since` も今までどおり）。

### 2.3 不変条件

- **I1** 1 インスタンスに開いている区間は高々 1 つ。区間 ID は再利用しない
- **I2** 区間の `episodeId`・`since` は開いてから閉じるまで変わらない。変わるのは `kind` と `binding` だけ（rebind）
- **I3** rebind は edge を出さない（WebSocket・push・解除のどれも動かない）。hold・dedup・reminder は区間 ID に付くので、rebind で延びも縮みもしない
- **I4** `closed` の edge は「その区間が終わった」ことだけを言う。置き換えでは出さない（`replaced` を 1 回だけ出す）
- **I5** 区間を開く・閉じる・置き換える・rebind するのは次のどれかの同期区間だけ:
  - (a) turn model を書き換えた同期区間（`applyTurnOutcomeToEpisode`）
  - (b) 観測の `start.version` が今の版と同じことを確かめた同期区間（`commitWaitingObservation`）
  - (c) claude-done が `target.episodeId` と今の区間 ID の一致を確かめた同期区間
  - (d) 例外: `freshPrompt: true` の観測（response-checker が新しい確認として保存する、Auto-Yes poller が答えを送る）は、版が違っても **今の状態で plan し直して** 適用する。この 2 つは「今その確認が画面にある」ことを、重複除外か送信の直前の読みで確かめているため。plan し直しても `start.generation` が今と違えば `ignored`
- **I6** 世代が `start.generation` と違う観測は何もしない（I5 (d) も同じ）
- **I7** 区間の `binding.generation` が今の世代と違えば、その区間は前のプロセスのもの。世代更新の同期区間で閉じる
- **I8** `binding.kind === 'screen'` の区間は turn の遷移（stop・session_end・開始）では閉じない。閉じるのは観測（`not-waiting`/`gone`）と世代更新だけ
- **I9** `humanHeld` は `readWaitingScreen` だけが決める。受信窓を見る読み（`readPromptFrame` の `receiptScope`）を `humanHeld` に使わない
- **I10** `kept` は版を変えず、照合なしに `kind` だけを更新できる

### 2.4 規則ごとの落とし込み

#### 規則 1（ID と帰属）

開く時点の binding は turn model から同期で決める（`getAgentTurn` の fence 込み、`agent-event-turn.ts:214-222`）:

| 開く時点の turn model | binding |
|---|---|
| 開いている turn（`openedAt!==null && closedAt===null`） | `turn`（その `turnId`） |
| `openedAt===null && closedAt===null` で `pendingDecisions.length > 0` | `dialog-only` |
| 上記で `pendingDecisions.length === 0`（`idle_prompt` の表示だけの記録） | `unattributed` |
| 閉じた turn・記録なし | `unattributed`（閉じた turn があればその ID を `lastClosedTurnId` に） |
| 読みが `humanHeld: true` | 上の結果に関わらず `screen`（上の結果が `turn(T)` なら `originTurnId: T`） |

#### 規則 2（stop は実際に終わらせた対象だけを閉じる）

- `recordAgentEvent` は `applyTurnTransition` の戻り値を受け、**同じ関数の中で** `applyTurnOutcomeToEpisode` を呼ぶ。`recordAgentEvent` は同期関数なので、stop の記録・turn の遷移・区間の終了は 1 つの同期区間に入る
- `applyAgentStopEvent`（後段。opencode・V2 では動的 import の await の後）は区間を操作しない
- 区間への作用表（`applyTurnOutcomeToEpisode`）:

| outcome | 開いている区間の binding | 作用 |
|---|---|---|
| `stopped(T)` | `turn(T)` 同世代 | 閉じる（`turn-stop`） |
| `stopped(T)` | それ以外 | 何もしない |
| `stop-without-turn(previous=closed(T, closedBy≠'stop'))` | `turn(T)` 同世代 | 閉じる（`turn-stop`）。T が画面の証拠・stale・resync で先に閉じられ、その後に開いた turn が無い形（レビュー指摘 2） |
| `stop-without-turn(previous=dialog-only / display-only / none)` | `dialog-only` / `unattributed` 同世代 | 閉じる（`turn-stop`） |
| `stop-without-turn` | `screen` / 他 | 何もしない |
| `stop-rejected(*)` | 何でも | 何もしない（破れ #1、別 session の dialog だけの記録: レビュー指摘 6） |
| `session-ended(T)` | `turn(T)` | 閉じる（`turn-session-end`） |
| `opened(N, previous=dialog-only(R))` | `dialog-only(R)` | rebind → `turn(N)`（規則 4） |
| `opened(N)` | `unattributed` 同世代 | rebind → `turn(N)`（規則 4） |
| `opened(N, previous=open-same-session(P))` | `turn(P)` | **閉じる**（`turn-superseded`）。印の無い prompt は中断後の再送でもあり、`user_prompt_submit` は turn model でも decision を全部捨てる（`:476-477`）ので、区間もそれに合わせる（レビュー指摘 9） |
| `opened(N, previous=open-other-session(P) / closed(P))` | `turn(P)` | 閉じる（`turn-superseded`） |
| `restored(R, discarded N)` | `turn(N)` | rebind → `turn(R)`（規則 8。N の間に開いた区間を戻す。P の区間を閉じた分は戻さない: §8 の限界） |
| `decisions-released(T, remaining=0)` | `dialog-only(T)` | rebind → `unattributed`（decision の無い記録は dialog だけとみなさない） |
| `generation-fenced(G)` | `binding.generation ≠ G` | 閉じる（`generation`。`screen` も含む） |
| 上記以外 | — | 何もしない |

- 戻り値 `EpisodeEffect` を `AgentEventRecordOutcome` 経由でログに出す（`agent-event-stop-applied` に `episodeEffect` を足す）。拒否された stop も `stop-rejected` として明示的に持ち回る（今の `{recorded:true}` が turn の終了成功を意味しない問題: `agent-event-state.ts:401`・`agent-event-turn.ts:694`）
- 保留ブランチの `stopEndsWaitingEpisode`（後段で turn model を読み直して推定）は採らない

#### 規則 3（turn の後にも残る人待ちは stop で閉じない）

- `humanHeld` は `readWaitingScreen` が受信窓を見ずに決める（I9、レビュー指摘 1）。agy の確認は受信窓の外でも `hasActivePrompt: true` と読まれるので `humanHeld: false` のまま `turn` に付き、stop で閉じる。status-helper と Auto-Yes poller が同じ関数で読むので、読みが観測者ごとに交互に変わることはない
- 観測が `humanHeld: true` を読み、版が開始時点と同じなら、区間を `screen` に rebind する（I2: ID・since はそのまま）。以後 stop・session_end・turn の開始では閉じない（I8）
- **Auto-Yes poller が閉じる条件**（すべて満たすとき `poller-answered` で閉じる）:
  1. `readWaitingScreen` の読みが `not-waiting`。`unknown`（capture 失敗・未分類）・`gone` では何もしない
  2. `start.generation` と `start.version` が今と同じ（tick の capture の await の間に入れ替わっていない）
  3. `lastAnswer.episodeId` が今の区間 ID と同じ（その区間にこの poller が答えた）
- **答えを送るとき**（レビュー指摘 4）: Auto-Yes poller は答えの送信を始める同期区間で、`freshPrompt: true` の観測を行う。区間が無ければこの観測が開き（binding は規則 1 の表）、あればその区間（または規則 4 の表の結果）を使う。その区間 ID と答えた確認の画面キーを `lastAnswer` に書く。これで「答えた後に別の経路が区間を開く」形が無くなる（答えより前に区間がある）。答えより前の画面を読んだ status-helper の open は、版の照合（I5 (b)）で `ignored` になる
- status-helper は従来どおり capture 失敗を「待っていない」と読む（`worktree-status-helper.ts:542-545` の #1786 の決定。既存テストの期待を変えないため）。ただし閉じるのは版が開始時点と同じときだけ。未分類の画面は `readWaitingScreen` が `unknown` を返すが、status-helper は今の動きを保つために `not-waiting` として渡す（§9 本文に無い指摘）
- 「menu の後に stop」: 観測が menu を `humanHeld` と読んだ時点で `screen` → stop は何もしない。「stop の後に menu」: stop で閉じた後、次の観測が menu を `waiting(humanHeld)` と読み、新しい区間（新しい ID・since・hold）を開く → 9 秒で通知可（陽性対照）

#### 規則 4（確認が turn より先のときは同じ区間の帰属の更新）

- `openTurn` の decision の引継ぎ（`agent-event-turn.ts:591-593`）は `opened` の `previous: dialog-only(R)`・`carriedDecisions: true` として返り、同じ `recordAgentEvent` の同期区間で rebind する
- status-helper・response-checker・Auto-Yes poller は `planWaitingObservation` を呼び、binding の推定を自分で持たない。観測の表（`planWaitingObservation`、すべて同世代。版が違えば I5 (b)(d) に従う）:

| 開いている区間 | 観測時点の候補（読み） | action |
|---|---|---|
| なし | `waiting` | opened |
| なし | `not-waiting` / `unknown` / `gone` | ignored |
| 何でも | `not-waiting` / `gone`（status-helper・response-checker） | closed（`screen-cleared` / `session-gone` / `response-recorded`） |
| 何でも | `not-waiting`（Auto-Yes poller） | 規則 3 の 3 条件を満たせば closed、満たさなければ ignored |
| 何でも | `unknown` | ignored |
| `turn(T)`（T は開いている） | `turn(T)` | kept |
| `turn(T)`（T は開いている） | `turn(T)` かつ `freshPrompt` かつ `lastAnswer.episodeId===今の ID` かつ画面キーが `lastAnswer.screenKey` と違う | **replaced**（同じ turn の 2 つ目の確認。レビュー指摘 7） |
| `turn(T)`（T は閉じている: stop 以外で閉じ、区間が残った） | `turn(N)` / `dialog-only` / `unattributed` | **replaced**（レビュー指摘 2） |
| `turn(T)`（T は閉じている） | `screen` | rebind → `screen` |
| `dialog-only(R)` / `unattributed` | `turn(N)` | rebind（turn 遷移で済んでいれば kept） |
| `dialog-only(R)` / `unattributed` | 同じ binding | kept |
| `turn(*)` / `dialog-only` / `unattributed` | `screen`（humanHeld） | rebind → `screen` |
| `screen` | `screen` | kept |
| `screen(originTurnId=T)` | `turn(T)`（答えられる確認） | rebind → `turn(T)`（同じ turn の画面の行き来。レビュー指摘 1） |
| `screen(originTurnId≠T)` | `turn(T)` | replaced |
| `screen` | `dialog-only` / `unattributed` | replaced |
| `turn(P)` | `turn(T)`（P≠T、T は開いている） | replaced（turn 遷移の取りこぼしの収束） |
| 世代が違う | `waiting` | replaced |

「同じ turn の 2 つ目の確認」の判定は `lastAnswer` を使うので PR 3 に入る（§6）。それまでは同じ turn の 2 つ目の確認は kept のまま（今と同じ）。

#### 規則 5（別区間への置換は 1 つの操作）

- `replaced` は、古い区間を消して新しい区間を置き、`cause:'replaced'` の遷移を **1 回だけ** 出す。`closed` は出さないので、`resolution-push-notifier` は呼ばれず（`waiting-push-notifier.ts:395` は `cause==='closed'` のときだけ）、WebSocket は `waiting:true` の新しい since だけを送る
- 新しい区間の since: 読みの `structuredSince` が新しい binding に属する（その turn の decision の `at`）ならそれ、そうでなければ観測時刻。古い区間の since は持ち込まない
- 解除通知の照合（端末の到着順の逆転）:
  - prompt の push の `data` に `episodeId` を入れる
  - `prompt-card-state` のマークの値に **最後に通知した区間 ID 1 つ** を時刻と一緒に入れる（1 文の上書きのまま。一覧は持たない: レビュー指摘 11）。tag が同じ通知は端末で最新の 1 枚に畳まれる（`sw.js:220-258` の close-then-show）ので、最後の 1 つで足りる。時刻だけの旧形式の値は「ID なし」として読む
  - 解除の push に `resolvedEpisodeId`（マークの ID、無ければ欠く）を入れる
  - `public/sw.js` は解除を受けたら、同じ tag の通知のうち `data.episodeId` が `resolvedEpisodeId` と等しいもの、または `episodeId` を持たないもの（旧形式）を閉じ、無音の置き換えを出す。**`data.episodeId` が違う通知が残っていれば、それを閉じてから同じ内容（title・body・data）で `silent:true`・`renotify:false` で出し直す**。どの分岐でも `showNotification` を必ず 1 回呼ぶ（`userVisibleOnly` の契約、`sw.js:170-183`。レビュー指摘 5）
  - `resolvedEpisodeId` の無い解除（旧サーバー・旧形式のマーク）は今の動き（tag の全部を閉じて置き換え）

#### 規則 6（claude-done の保証範囲）

- 区間・世代は **worktree を引いた直後（`claude-done/route.ts:47` の後、`:58` の capture の await の前）** に `captureLegacyStopTarget` で固定する。`:34` の body の読みが最初の `await` だが、worktreeId は body の中にあるので、その前には固定できない（[事実]）
- `:72` の await の後、`:100` の `applyAgentStopEvent` の前に `settleLegacyStop` を同期で呼ぶ。閉じるのは次のすべてを満たすとき:
  1. 今の世代が `target.generation` と同じ
  2. 今の区間 ID が `target.episodeId`（null でない）と同じ
  3. 今の世代に hook の stop の印（`__waitingHookStopGeneration`）が無い
  4. 区間の binding が `screen` でない
- 同じ区間を hook の stop が先に閉じていれば 2 で何もしない（hook と併用時の二重終了の防止）
- 世代の印は今の世代だけを見るので、前の世代の hook の記録は claude-done の終了を妨げない（破れ #5）
- 開始 hook だけを併用する設定（`user_prompt_submit` 等は agent-event、stop は claude-done）では、区間は `turn(T)` に付き、今の世代に hook の stop が無いので claude-done が閉じる
- claude-done は turn model に何も記録しない（今のまま）。route の変更は `no-claude-fallback` guard の baseline（`tests/unit/guards/no-claude-fallback.test.ts:258-291`、追加禁止）に触れないよう、`'claude'` の文字列を新しい呼び出しの引数に書かない（route 内の既存の値か lib 側の定数を使う）

#### 規則 7（#3796 との整合・dedup・抑止記録）

5 章にまとめる。

#### 規則 8（stop 以外の turn 遷移と既存の閉じる経路）

- `session_start`（`agent-event-state.ts:385-396`）と `beginAgentEventGeneration`（`:433-`）はどちらも `fenceTurnForNewGeneration` の後に `applyTurnOutcomeToEpisode(generation-fenced)` を同じ同期区間で呼ぶ。`fenceTurnForNewGeneration` は turn が無くても outcome を返す
- `session_end` は `session-ended` / `session-end-rejected` を返す
- queued notice の復元（`joinOpenTurnFromDuplicate`、`agent-event-turn.ts:650`）は `restored` を返し、呼び手（`agent-event-intake.ts:314` の重複破棄の経路）が同期で `applyTurnOutcomeToEpisode` を呼ぶ
- `permission_replied` の記録（`structured-decision.ts:712`・`structured-decision-response.ts:529`・`pending-decision-recheck.ts:149`・opencode・V2）は `decisions-released` を返す。これらの経路は記録の **前** に await がある（1.7、レビュー指摘 12）が、区間の操作は `recordAgentEvent` の中で今の turn model に対して行うので、await の前の状態を前提にしない。記録の `at` は await の前の時刻になりうるが、区間の照合は時刻を使わない（規則 1）
- opencode の permission（`opencode/ingest.ts:385-386`）も同じ: `adjudicatePermission` の await の後に記録されるが、`recordAgentEvent` の中で今の状態に対して処理する
- C2（`response-checker.ts:1465`）は `observeWaiting({ observer:'response-checker', reading:{kind:'not-waiting'}, start })` にする（作用は `response-recorded`）。`start` は tick の最初の `await`（`:1533` の `isSessionRunning`）の前に読む。`mayStillActAfter` の後の同期区間であることは変えない（`tests/unit/guards/retired-tick-write-guard-3705.test.ts` の対象一覧に新しい関数名を足す）
- O2（`savePromptMessage`）は `planWaitingObservation({ freshPrompt: true })` で区間（ID・since）を決め、その ID・since で gate と push を出し、同じ同期区間で `commitWaitingObservation` する。`savePromptMessage` は同期関数（`response-checker.ts:814`）で、`notifyPushSubscribers` の dedup は最初の `await` より前（`push-sender.ts:611-619`）なので、「push を先に、区間を後に」の順序（`:899-909` のコメント）を保ったまま ID を一致させられる
- `closeAgentTurn`（`scraper_evidence`・`resync_idle`、`agent-event-turn.ts:253`）・`observeScraperCompletionEvidence`・`effectiveTurn` の `stale` は区間に作用しない（読み出しや画面の読みの中で turn を書き換え、遷移を出せない）。その turn に付いた区間は、後から届く stop（`stop-without-turn(previous=closed)`）、次の turn の `opened(previous=closed)`、観測の `replaced` のどれかで閉じる

### 2.5 同期区間の境界（経路ごと）

| 経路 | 固定する時点（最初の await の前） | 区間を操作する同期区間 | await の後にしないこと |
|---|---|---|---|
| agent-event route | — | `applyAgentEventToState` → `recordAgentEvent` → `applyTurnTransition` → `applyTurnOutcomeToEpisode`。重複破棄の復元は `dropDuplicateAgentEvent`（`agent-event-intake.ts:300-`）の中 | `applyAgentStopEvent`（`route.ts:177`）で区間に触れない |
| opencode ingest | — | `recordAgentEvent`（`ingest.ts:386`・`:396`・`:414`）の中 | `applyStop`（`:434`）で触れない |
| V2 ingest | — | `recordAgentEvent`（`ingest.ts:233`〜`:301`）の中 | `stopEffect`（`:299`）で触れない |
| permission_replied の 3 経路 | — | `recordAgentEvent` の中 | — |
| 世代更新 | — | `beginAgentEventGeneration` の中 | — |
| claude-done | `captureLegacyStopTarget`（`:47` の後） | `settleLegacyStop`（`:72` の後、`:100` の前） | `:100` 以降で触れない |
| status-helper | **呼び手が `listSessions()` を呼ぶ前**（`src/app/api/worktrees/route.ts:138` の前、`src/app/api/worktrees/[id]/route.ts:67` の前）に worktree の全インスタンス分を `startWaitingObservation` で取り、`detectWorktreeSessionStatus` に渡す（レビュー指摘 8）。渡されなければ `detectInstanceSessionStatus` の冒頭で取る（旧呼び手の互換） | `observeWaiting`（`:884` の位置） | — |
| 応答 poller | `start`（`checkForResponse` の `:1533` の前） | O2: `savePromptMessage` の中（`freshPrompt`）、C2: `:1465` の位置 | — |
| Auto-Yes poller | `start`（tick の capture の await の前。#3796 の `sessionWaitTickRanAt` を書く位置の近く、`auto-yes-poller.ts:1172` 付近） | 答えの送信を始める同期区間（`freshPrompt` の観測と `lastAnswer` の書き込み）、`no_prompt` を返す直前（`:991` 付近）の `observeWaiting` | — |

### 2.6 失敗時の扱い

- 区間の listener が throw しても区間の状態は変わらない（今の `emit` の封じ込め、`waiting-episode-state.ts:114-128` を維持）
- `applyTurnOutcomeToEpisode` が throw しても `recordAgentEvent` の turn の記録は済んでいる。throw は内部で握り、`waiting-episode-turn-sync-failed` を warn で出す（hook の受信を 500 にしない）
- capture 失敗: Auto-Yes poller は `unknown`（何もしない）。status-helper は従来どおり `not-waiting`（ただし版の照合つき）
- 版の不一致は `ignored`（debug ログ `waiting-observation-stale`）。I5 (d) の 2 経路だけは plan し直す
- 閉じる listener（解除の判定で `app_settings` を読む）が hook の route の同期区間で走るようになる（今は status の問い合わせと応答 poller の中だけ）。listener は今も同期で走り、解除の送信は `void` で切り離されている（`waiting-push-notifier.ts:395`）ので、hook の応答を待たせるのは `decidePromptResolution` の同期部分（DB の 1 読み）だけ。[見立て] 問題にならない量だが、PR 1a のテストで route の応答時間の退行が無いことを見る
- プロセス再起動で区間は消える（今の §6.2 の限界、`prompt-card-state.ts:82-91`）。ID の `bootNonce` で再起動前後の ID は衝突しない

---

## 3. 破れの順序がどこで閉じるか

### 3.1 保留ブランチで見つかった破れ 7 件

| # | 再現の順序 | 以前に起きたこと | この設計で閉じる場所 | 規則 |
|---|---|---|---|---|
| 1 | ① 同じ instance の新 session B の turn が開き、B の確認で区間（`turn(B)`）が開く ② 旧 session A の stop が届く | turn は拒否するのに区間は閉じた | ② の `applyStopToTurn` が `:694` で拒否 → `stop-rejected(other-session)` → 区間に作用しない。B がまだ dialog だけの記録（session ID あり）なら、`:701` の分岐も上書きせず拒否（2.2 turn model の変更） | 2 |
| 2 | ① turn T の確認に Auto-Yes が答える ② survey など番号の無い menu が出る ③ T の stop | 人が要る menu の区間を閉じた | ② の観測（`readWaitingScreen` は受信窓を見ない）が `humanHeld` を読み、版が同じなら `screen(originTurnId=T)` に rebind → ③ は I8 で何もしない。Auto-Yes poller も読みが `waiting` なので閉じない | 3 |
| 3 | ① A の stop を記録 ② 後段の await ③ B が区間を開く ④ A の後段が戻る | B の区間を閉じた | A の区間は ① の同期区間で閉じ済み。④ は区間を操作しない（2.5） | 2 |
| 4 | ① A の区間が開いたまま ② A の stop・await ③ B の確認 | B が A の since を引き継ぎ、猶予が短く、A の通知済みで B が抑止された | `turn(A)` なら ② の同期区間で閉じ、③ は新しい ID・since で開く。A が `screen(originTurnId=A)` で残っていれば ③ の観測は候補 `turn(B)` で `replaced`（新しい ID・since・hold、dedup も ID で別） | 2・5・7 |
| 5 | ① 前の世代で hook の記録 ② 世代更新 ③ 現世代は claude-done だけ | 互換 stop で閉じられなくなった | ② で前世代の区間は閉じる。③ の `settleLegacyStop` は今の世代の hook stop の印だけを見るので、印が無く閉じる | 6・8 |
| 6 | ① turn 未作成で確認（`unattributed` / `dialog-only`） ② 遅い開始 hook ③ 取得を繰り返す | 引き継がれた確認の区間を取得のたびに閉じ直した | ② の `opened` で rebind（同じ ID・since・hold）。③ の観測は `kept` | 4 |
| 7 | ① A の stop を記録 ② await ③ 世代更新 ④ 開始 hook 前の B が人待ち ⑤ A の後段が戻る | 世代の柵で turn が null になり B の区間を閉じた | A の区間は ① で閉じ済み（③ でも閉じる）。⑤ は区間を操作しない。① が ③ より後に届いた場合は `before-generation` で拒否 | 2・8 |

### 3.2 レビュー 1 回目の「まだ破れる順序」8 件

| # | 順序 | この版で閉じる場所 | 規則・節 |
|---|---|---|---|
| 1 | ① agy の確認で区間が `turn(T)` で開く ② Auto-Yes poller が受信窓の外で同じ確認を読む ③ T の stop | ② の読みは `readWaitingScreen`（窓を見ない）なので `hasActivePrompt: true` → `humanHeld: false` → binding は `turn(T)` のまま → ③ で閉じる | I9、規則 3 |
| 2 | status-helper と Auto-Yes poller が交互に同じ画面を読む | 両方が同じ `readWaitingScreen` を使うので読みが一致し、`kept` が続く。画面が本当に確認と menu を行き来しても、同じ turn なら `screen(originTurnId=T)` ⇄ `turn(T)` の rebind で ID・since・hold は変わらない | I9、規則 4 の表 |
| 3 | ① 確認で `turn(T)` が開く ② Auto-Yes が答える ③ `commandmate wait` 等の current-output が画面の ready を 3 回読み T を `scraper_evidence` で閉じる ④ agy の Stop | ④ は `stop-without-turn(previous=closed(T, scraper_evidence))` → `turn(T)` の区間を閉じる。④ が来ず次の確認が来た場合も、観測の表の「`turn(T)`（閉じている）× 新しい候補 → replaced」で新しい区間になる | 規則 2 の表、規則 4 の表 |
| 4 | ① status-helper の開始時点で区間なし（版 v） ② capture の await ③ E が開いて stop で閉じる（版 v+2） ④ status-helper が古い画面を waiting と読む | ④ の open は版の不一致で `ignored` | I5 (b) |
| 5 | ① status-helper の開始時点は E1（版 v） ② await の間に E1 が stop で閉じ E2 が開く ③ status-helper が古い survey を humanHeld と読む | ③ の rebind は版の不一致で `ignored` | I5 (b) |
| 6 | ① Auto-Yes が答える ② その後に答えより前の画面から区間 E が開く ③ poller が E を閉じない | 答えを送る同期区間で `freshPrompt` の観測が区間を開く（または既存の区間を使う）ので、① の時点で区間がある。② の古い画面からの open は版の不一致で `ignored`。response-checker の `freshPrompt` の open は plan し直して既存の区間に `kept`（同じ確認・同じ turn） | 規則 3、I5 (d) |
| 7 | opencode の別 session の idle が dialog だけの区間を閉じる | dialog だけの記録が session ID を持ち、stop の session ID と違えば `stop-rejected(other-session)`。どちらかの session ID が無ければ閉じる（§8 の限界） | 2.2 turn model の変更、規則 2 の表 |
| 8 | ① PR 1a だけの develop で stop で閉じる ② 解除通知の送信中に新しいカード ③ 解除が後に届いて新しいカードを消す | PR 2（解除と Service Worker の ID 照合）を PR 1a の直後に入れ、同じリリースに含める（§6） | 規則 5、§6 |

---

## 4. 陰性対照・陽性対照とテストの層

### 4.1 層

| 記号 | 層 | 入口 | 区間・push の観測 |
|---|---|---|---|
| R | 実 ingest（route） | `POST /api/hooks/agent-event` の handler を直接呼ぶ（`recordAgentEvent` は本物）。`route.ts:177` の await は `resolveStopTranscriptCapture` を deferred にして止める | `getWaitingEpisode`・遷移の記録・`prompt-push-*` のログ |
| OC | opencode ingest | `ingestOpencodeEvent`（`applyStop` の動的 import を遅延させる mock で await を止める） | 同上 |
| V2 | opencode V2 ingest | `ingestOpencodeV2Event` の `stopEffect` seam（`ingest.ts:183`）を deferred にする | 同上 |
| CD | claude-done route | `request.json()`・`captureClaudeOutput`・`recordClaudeConversation` を deferred にする | 同上 |
| SH | status-helper | `detectWorktreeSessionStatus`（capture を deferred にできる mock、`sessionNameSet` を渡す） | 同上 |
| RC | response-checker | 本物の `checkForResponse`（`isDuplicatePrompt` も本物） | 同上 |
| AY | Auto-Yes poller | `detectAndRespondToPrompt` / tick（受信窓は本物の `beginAntigravityFrameRead` 系） | 同上 |
| CO | current-output | `buildCurrentOutput` を 3 回回して `scraper_evidence` で turn を閉じる | turn の `closedBy` |
| P | push | `waiting-push-notifier`・`prompt-push-gate`・`notification-dedup`・`resolution-push-notifier`・`prompt-card-state` を fake timers で | 通知回数・hold の期限・解除 |
| SW | Service Worker | `tests/unit/pwa/sw-push.test.ts` と同じ方式 | 閉じた通知・`showNotification` の呼び出し回数と内容 |

対照は `os.tmpdir()` の `mkdtempSync` で作った隔離 DB（既存の push テストと同じ方式）で行い、`afterEach` で消す。

### 4.2 一覧

**破れ 7 件**（すべて陰性対照）

| 対照 | 層 |
|---|---|
| #1 新 session B 待ち中の旧 A の stop: B の ID・since・hold の期限・通知回数が変わらない | R・OC・V2 |
| #2 回答 → survey/picker → stop: 区間・hold・reminder が残る。解除通知 0 | R・OC・V2（stop）・AY・SH（観測） |
| #3 A の stop 記録 → await 中に B が開く → 戻る: B が残る | R（`route.ts:177` の await）・OC・V2 |
| #4 A の区間が開いたまま → A stop・await → B の確認: B は新しい ID・since・hold、A の通知済みで抑止されない | R・OC・V2・RC |
| #5 前世代の hook 記録 → 世代更新 → claude-done だけ: 閉じる | CD |
| #6 turn 未作成で確認 → 遅い開始 hook → 取得 3 回: 開く edge 1 回、ID・since 不変 | SH・R・OC・V2 |
| #7 A stop 記録 → await → 世代更新 → 開始 hook 前の B 人待ち → 戻る: B が残る | R（`route.ts:177` の await）・OC・V2 |

**レビュー指摘 1〜9 に対応する対照**

| 対照 | 層 |
|---|---|
| 指摘 1: agy の確認を Auto-Yes poller が受信窓の外で読む → 区間は `turn` のまま → stop で閉じる（陽性）。status-helper と poller を交互に 6 回 → 開く edge 1 回・ID 不変・hold の期限不変 | AY・SH・R・P |
| 指摘 1: 同じ turn で menu → 確認 → menu と画面が変わる → rebind だけ（ID・since・hold 不変） | SH・AY |
| 指摘 2: 確認 → 答え → current-output が `scraper_evidence` で T を閉じる → agy の Stop → 区間が閉じる。Stop が来ずに次の確認 → 新しい ID・since・hold | CO・R・RC・P |
| 指摘 3: status-helper の開始時点で区間なし → await 中に開いて閉じる → 古い画面で waiting → 開かない。開始時点 E1 → await 中に E2 → 古い survey → E2 は rebind されない | SH・R |
| 指摘 4: 答えの送信の時点で区間が無い → poller が開いて `lastAnswer` に書く → 画面が消えた tick で閉じる。答えより前の画面を読んだ status-helper の open は無視される | AY・SH・P |
| 指摘 5: 解除を受けたとき別の `episodeId` の通知が残る → それを無音で出し直し、`showNotification` を 1 回呼ぶ。閉じる通知も残す通知も無いときも 1 回呼ぶ | SW |
| 指摘 6: opencode の dialog だけの区間に別 session の idle → 閉じない（両方の session ID がある）。`idle_prompt` の表示だけの記録の上に見えた待ちは `unattributed` | OC・R |
| 指摘 7: opencode / copilot（全画面 TUI）で同じ turn の確認 1 に答え、9 秒以上後に確認 2 → 新しい区間・新しい hold、poller が答える前に `prompt-push-allowed` が出ない | RC・AY・P |
| 指摘 8: 呼び手の `listSessions()` の後に新しい session が開いて区間が開く → 古い一覧で「動いていない」と読んでも閉じない | SH |
| 指摘 9: 中断後の再送（印の無い prompt が同じ session の開いている turn を置き換える）→ P の区間が閉じる。queued notice の復元 → N の間に開いた区間が R に戻る | R |

**追加の陰性対照**

| 対照 | 層 |
|---|---|
| 拒否された stop（別 session / 世代より前）で区間・hold・通知回数が変わらない。ログの `episodeEffect` が `none` | R・OC・V2 |
| 同一ミリ秒（turn の層）: 同じ `receivedAt` の A の stop と B の `user_prompt_submit` を route に続けて送る → turnId が 2 つ、A の区間は閉じ B の区間は別 ID | R |
| 同一ミリ秒（push の層）: 2 つの区間の since が等しい → ID が別、通知 2 回、hold が別 | P・RC |
| 同じ本文の次の確認（次の turn）: `isDuplicatePrompt` を本物のまま通し、新しい区間・新しい通知（本文ハッシュの重複除外で落ちる場合はその事実を固定し、本文に無い指摘にする） | RC |
| 複数回の再取得: 同じ区間に対する status の取得を 3 回以上 → 開く edge 1 回 | SH |
| 世代交替: `beginAgentEventGeneration` と `session_start` のそれぞれで、開いている区間（`screen` を含む）が閉じる edge 1 回 | R・SH |
| claude-done の各 await 中の入れ替わり: `:58` の間、`:72` の間それぞれで (a) hook stop が A を閉じ B が開く → B が残る (b) 世代更新 → 何もしない (c) 何も起きない → A が閉じる（陽性） | CD |
| claude-done の body の読み（`:34`）の限界を固定: body の読みの間に A が閉じ B が開く → body が返る → B が閉じる（テスト名に `limit:` を付け、仕様として残す） | CD |
| 開始 hook だけ併用: hook の turn が開いている・hook stop の印なし → claude-done が閉じる（陽性）。hook stop の印あり → claude-done は何もしない | CD・R |
| permission_replied の 3 経路と opencode の permission（記録の前に await）: await の間に区間が入れ替わっても、記録は今の区間に対して `decisions-released` の作用しか持たない | R・OC |
| status-helper の capture の await 中に応答 poller が開いた区間を、戻った status-helper が閉じない | SH・RC |
| Auto-Yes poller: 答えていない区間・前の区間の答え・capture 失敗・未分類の画面・tick 中の入れ替わりで閉じない | AY |
| 旧形式のカードのマーク（時刻だけ）と `resolvedEpisodeId` の無い解除で、今の動き（tag の全部を閉じる）になる | P・SW |

**人待ちの対照**（最終状態に加え、解除通知・通知回数・since・hold の期限が変わらないことを見る）

| 対照 | 層 |
|---|---|
| menu が出た後に stop | R・OC・V2・AY・P |
| 構造化確認 → 遅い開始 hook → 繰り返し取得 | R・OC・V2・SH・P |

**#3796 との対照**

| 対照 | 層 |
|---|---|
| wake → capture 失敗 → 再予約の間に rebind が起きても hold の期限が延びない（`autoYesHoldEndsAt` の値が rebind の前後で同じ） | P・AY |
| replaced で新しい区間だけに新しい hold（`pendingSessionWaitTick` を新しい hold の開始時点で読む） | P |
| 複数端末への解除通知と新しい通知の到着順の逆転: 解除が後に届いても新しいカードが残る（無音で出し直される） | SW・P |

**陽性対照（維持）**

| 対照 | 層 |
|---|---|
| UAT 1 回目の形: 答え +0.3 秒・stop +4 秒 → hold の終わりに `prompt-push-allowed` が出ない | R・P |
| UAT 3/4/6/7 回目の形: 次の確認は自分の ID・since で hold される | R・RC・P |
| 人が要る画面（答えも stop も無い）は約 9 秒で `auto-yes-not-answered` | P・SH |
| 閉じる edge 自体は通知しない（Auto-Yes off で開く通知 1 回、stop で 0 回） | R・P |

---

## 5. #3796 との整合（規則 7）

[事実] #3796 は hold の開始時に Auto-Yes poller の予約 tick を 1 回だけ読み（`prompt-push-gate.ts:180`・`:204-209`）、その後は早まる方向にだけ読み直す（`:220-226`・`:249`）。

決めること:

1. **hold は区間 ID に付ける。** `AutoYesHoldStart` に `episodeId` を足し、`hold.episodeId !== input.waitingEpisodeId` のときだけ新しい hold を作る（`:179` の since の比較を置き換える）。ID を渡さない呼び手（既存テスト・opencode の質問 push）は従来の since の比較にする
2. **rebind は hold を作り直さない。** I3 により `firstHeldAt`・`sessionWaitTick` は rebind の前後で同じ。予約 tick の保持・短縮値は延びない（「早まる方向だけ」の約束を守る）
3. **replaced は新しい hold。** 新しい区間 ID で初めて gate に来た時点で `pendingSessionWaitTick(key, now)` を読む。古い区間の hold は `forgetAutoYesHold(key, { episodeId: old })` で落とす（#3776 の「次の区間の hold を巻き込まない」を ID で行う）
4. **dedup は区間 ID。** `WaitingPushRecord` に `episodeId: string | null` を足す。同じ待ちとみなすのは「両方に ID があり等しい」か「片方に ID が無く since が等しい」（opencode の質問 push は ID を持たないので、since で status-helper の通知と束ねる今の動きを残す）
5. **reminder・再判定も区間 ID。** `PendingWait` に `episodeId` を足し、`releaseAutoYesHold`・`releaseHeldWait`・`runEscalationTick` の `episode.since !== held.since` を ID の比較にする。`replaced` を受けたら古い区間の分類待ち・hold 待ちのタイマーを止め、解除通知は出さない
6. **抑止記録に区間 ID を入れる。** `AutoYesPolicySuppression` に `episodeId?: WaitingEpisodeId | null` を足す（記録した同期区間で開いていた区間）。gate は ID があれば `suppression.episodeId === input.waitingEpisodeId`、無ければ従来の `at >= waitingSince`。gate 側の読み（型の欄の追加を含む）は PR 2、書き手は PR 3。#3796 の `refreshEpisodeSuppression`（`src/lib/polling/auto-yes-poller-receipt-log.ts:246-270`）は記録を写し直すとき `episodeId` を引き継ぐ（新しい区間へ持ち込まない）
7. **wait が読む抑止記録。** `current-output` の `autoYes.lastSuppression` に `episodeId` を、`autoYes` に今の `waitingEpisodeId` を公開する。`wait.ts` の `activeSuppression`（`:252-264`）は、両方が非 null で異なれば古い記録として扱う。どちらかが無ければ（旧サーバー）今の 60 秒の窓（`:245`）
8. **旧区間の回答を持ち込まない。** hold の起点に使う `lastServerResponseTimestamp`（`prompt-push-gate.ts:188-189`）は「起点を後ろへずらす」だけなので残す。Auto-Yes poller が区間を閉じる判定・2 つ目の確認の判定には時刻ではなく `lastAnswer.episodeId` を使う（規則 3・4）。同じ turn の 2 つ目の確認は `replaced` で新しい hold になるので、前の答えの時刻から数えた hold の終わりが新しい確認に当たらない（レビュー指摘 7）
9. Auto-Yes poller の #3796 の欄（`sessionWaitTickAt`・`sessionWaitTickRanAt`・`sessionAppearedAt`、`src/lib/polling/auto-yes-poller-state.ts:44-58`）には触らない。capture 失敗の tick は区間に作用しない（規則 3）ので、「wake → capture 失敗 → 再予約」の間に区間も hold も変わらない

---

## 6. 実装の分割

4 本に分け、**1a → 2 → 1b → 3** の順に入れる。1a と 2 は同じリリースに入れる（1a だけでは stop で閉じる回数が増え、解除通知が新しいカードを消す形がカードのある場合に今より出やすい: 残る順序 8）。各 PR は前の PR の型だけに依存し、単独で develop に入っても既存のテストの期待を変えない。

### PR 1a: 区間の ID と帰属、turn の遷移での同期的な終了、claude-done

- scope: `src/lib/session/waiting-episode-state.ts`、`src/lib/session/waiting-episode-binding.ts`（新設。`applyTurnOutcomeToEpisode`・`captureLegacyStopTarget`・`settleLegacyStop` と binding の決定）、`src/lib/session/agent-event-turn.ts`（outcome・`openDecision` の sessionId・`:701` の拒否）、`src/lib/session/agent-event-state.ts`、`src/lib/hooks/agent-event-intake.ts`（復元の outcome とログ）、`src/app/api/hooks/agent-event/route.ts`（ログの欄）、`src/app/api/hooks/claude-done/route.ts`、テスト、`changelog.d/3798.md`
- 入るもの: 規則 1・2・6・8、規則 4 のうち turn 遷移側（`opened` での rebind）。観測者は `observeWaitingEdge`（薄い層）のまま。binding は開く時点で決める
- テスト: 4.2 の破れ #1・#3・#5・#7（R・OC・V2・CD）、#6 の turn 遷移側、指摘 2（stop 側）・6・9、拒否された stop、同一ミリ秒（turn の層）、世代交替、claude-done の入れ替わりと body の読みの限界、開始 hook だけ併用、permission_replied の経路、陽性対照（UAT 1 回目・3/4 回目・人が要る画面・閉じる edge は通知しない）
- これで Issue の元の受入基準（ブラウザ無しで答え済み＋ターン終了で閉じる・`prompt-push-allowed` が出ない・人が要る画面は約 9 秒）を満たす
- 注意: `import-cycles-baseline` guard（`tests/unit/guards/import-cycles-baseline-3482.test.ts`）に新しい循環を足さない。`waiting-episode-state` は `agent-event-*` を import しない。`agent-event-state` を部分 mock する既存の integration テストがあるので、新しい関数は `agent-event-state` から export しない（保留ブランチ `7b41cd6a8` の記録）。`agent-event-turn.ts:701` の挙動の変更が既存テストに固定されていないかを最初に確かめる

### PR 2: push 側を区間 ID で照合（hold・dedup・reminder・解除・抑止記録の読み・Service Worker）

- scope: `src/lib/push/prompt-push-gate.ts`（hold の ID 化と、抑止記録の ID による照合の読み。§5 の 1・3・6 の gate 側）、`src/lib/polling/auto-yes-suppression-state.ts`（`episodeId` の型の欄の追加のみ）、`src/lib/push/notification-dedup.ts`、`src/lib/push/push-sender.ts`、`src/lib/push/waiting-push-notifier.ts`（`replaced` の扱いを含む）、`src/lib/push/resolution-push-notifier.ts`、`src/lib/push/prompt-card-state.ts`（マークに ID 1 つ）、`public/sw.js`、`src/lib/polling/response-checker.ts`（gate・push に ID を渡す行だけ）、テスト
- 入るもの: 規則 5 の解除の照合、§5 の 1〜6（6 は gate の読みだけ）。`replaced` はまだ発生しないが、受けたときの扱いをここで入れる（1b の前提）
- テスト: 同一ミリ秒（push の層）、replaced で新しい hold、rebind で hold が延びない（#3796 の wake → capture 失敗 → 再予約を含む）、到着順の逆転と `showNotification` を必ず呼ぶこと（SW）、旧形式のマーク、既存の `prompt-push-gate-*`・`waiting-push-*`・`cross-device-dismissal-2001`・`restart-card-state-2057`・`sw-push` が期待を変えずに通ること（ID の無い入力は since の比較のまま）

### PR 1b: 観測の照合と共通の画面の読み方

- scope: `src/lib/detection/waiting-screen-reading.ts`（新設）、`src/lib/session/waiting-episode-binding.ts`（`startWaitingObservation`・`planWaitingObservation`・`commitWaitingObservation`・`observeWaiting`、版）、`src/lib/session/worktree-status-helper.ts`、`src/app/api/worktrees/route.ts`・`src/app/api/worktrees/[id]/route.ts`（`listSessions()` の前に開始時点を取って渡す）、`src/lib/polling/response-checker.ts`（O2 の plan/commit と C2 の照合）、`tests/unit/guards/retired-tick-write-guard-3705.test.ts`（対象一覧への追加のみ）、テスト
- 入るもの: 規則 3 の観測の部分（humanHeld・screen への rebind）、規則 4 の観測の表（`lastAnswer` を使う行を除く）、規則 5 の `replaced` の発生、I5 の版の照合
- テスト: 破れ #2・#4・#6 の観測側（SH・RC）、指摘 1（SH の交互の読み・画面の行き来）、指摘 2（観測の replaced）、指摘 3、指摘 8、複数回の再取得、同じ本文の次の確認、status-helper の await 中の open、人待ちの対照

### PR 3: Auto-Yes poller の終了・答えでの区間・2 つ目の確認・抑止記録の書き手・wait

- scope: `src/lib/auto-yes-poller.ts`、`src/lib/polling/auto-yes-poller-state.ts`（`lastAnswer` の追加のみ）、`src/lib/polling/auto-yes-suppression-state.ts`（書き込みで `episodeId` を入れる）、`src/lib/polling/auto-yes-poller-receipt-log.ts`（`episodeId` の引き継ぎ）、`src/lib/session/waiting-episode-binding.ts`（`lastAnswer` を使う観測の表の行）、`src/lib/polling/response-checker.ts`（O2 に画面キーを渡す行）、`src/lib/session/current-output-builder.ts`・`current-output-types.ts`、`src/cli/types/api-responses.ts`、`src/cli/commands/wait.ts`、テスト。**`prompt-push-gate.ts` は含まない**（読みは PR 2 で入っている）
- 入るもの: 規則 3 の poller の条件と答えでの区間、規則 4 の表の「同じ turn の 2 つ目の確認」、§5 の 6（書き手）〜9
- テスト: 4.2 の AY の対照、指摘 1（受信窓の外）・4・7、menu が出た後に stop（AY）、wait の抑止表示（ID が違えば古い、ID が無ければ 60 秒）
- PR 1a だけでも、stop が hold の終わりより先に届けば誤通知は出ない。PR 3 は「答えた後もターンが 9 秒より長く続く」場合と、同じ turn の 2 つ目の確認を閉じる

---

## 7. 保留ブランチから流用するもの・捨てるもの

| 対象（`07610c745`） | 扱い | 理由 |
|---|---|---|
| `tests/unit/push/waiting-episode-close-no-browser-3798.test.ts` の UAT 1 回目・3/4 回目の再現、人が要る画面の陽性対照、閉じる edge は通知しない対照 | 流用（期待は同じ） | 再現の形が UAT と一致している |
| 同ファイルの session A/B の対照 | 流用（#1 の R 層） | 期待は同じ。判定の場所が変わるだけ |
| `tests/unit/polling/auto-yes-poller-close-answered-wait-3798.test.ts` の survey/picker・信頼確認・受信待ちの対照 | 流用（PR 3）。答えたかの判定は時刻から `lastAnswer.episodeId` に置き換える | 規則 3 と同じ。時刻の比較は規則 1 に反する |
| 同ファイルの `detectSessionStatus(raw ?? clean).status === 'waiting'` で menu を守る考え方 | 流用し、`readWaitingScreen` として全観測者の共通関数にする（PR 1b） | poller だけに置くと status-helper と読みが分かれる（レビュー指摘 1） |
| `tests/unit/push/waiting-episode-close-async-stop-3798.test.ts` の OpenCode / V2 の await を止める仕掛け | 流用（OC・V2 層の土台）。R 層にも同じ形の仕掛けを作る | 期待は一部変わる（F の「A を閉じて B を開く」は、A が stop の同期区間で閉じ済みになる） |
| `tests/unit/lib/polling/response-checker-ended-turn-wait-3798.test.ts`・`tests/unit/lib/worktree-status-helper-ended-turn-wait-3798.test.ts` の本物の `checkForResponse` / status-helper を動かす仕掛け | 流用（RC・SH 層の土台） | 期待は ID で書き直す |
| `tests/unit/api/hooks-claude-done-delegation.test.ts` への追加（G の対照） | 流用（CD 層）。「hook の turn が開いていれば claude-done は閉じない」は捨てる | 開始 hook だけ併用の設定で閉じられなくなる（4.2）。hook stop の印で判定する |
| #3796 との統合部分（`closeWaitAnsweredByPoller` と `refreshEpisodeSuppression` を両立させたマージの解き方） | 流用（PR 3） | 別関数で互いの中身を変えない形は保てる |
| `src/lib/session/waiting-episode-turn.ts`（`beganInAnEndedTurn`・`stopEndsWaitingEpisode`・`closeWaitingEpisodeOfEndedTurn`） | 捨てる | 区間が帰属を持たず、閉じる側が今の turn と時刻から推定している。破れ #6 は「turn の開始時刻 > since」の推定そのものから出た |
| `applyAgentStopEvent` の先頭での終了 | 捨てる | opencode・V2 では動的 import の await の後に呼ばれる（破れ #3・#7） |
| 保留ブランチの `stopTurnOutcomes` Map（`7b41cd6a8`、`66977a5a5` で撤去済み） | 捨てる | キー単位で 1 回消費する値は await を挟むと次の turn に読まれる。outcome は同期区間の戻り値として渡す |

---

## 8. 限界と未確認事項

### 限界（設計で閉じないもの）

- **claude-done の旧形式**: 識別子が無いので、B の区間が開いた後に届いた旧 A の claude-done は B に当たる。同じ世代に hook の stop が届いていれば印で止まるが、claude-done だけの設定では判別できない。`target` を固定できるのは body の読み（`route.ts:34`）の後なので、body の読みの間に入れ替わった場合も同じ（4.2 で `limit:` のテストとして固定する）
- **session ID の無い hook**: `closesTurn` は片方の sessionId が null なら同じ session とみなす（`provisional-turn.ts:547-550`）。dialog だけの記録の拒否（レビュー指摘 6）も両方の session ID が要る。手で設定した relay など session ID を送らない hook では、破れ #1 と残る順序 7 の保護は効かない
- **stop-without-turn**: 開いている turn が無いときの stop は、session ID で区別できなければ `unattributed` / `dialog-only` の区間を閉じる
- **#3330 の重複と確認が重なったとき**: 印の無い複製が先に届くと、開いていた turn P の区間は `turn-superseded` で閉じる。後から届いた印つきの複製が turn P を戻しても、閉じた区間は戻さない。確認がまだ画面にあれば、次の観測が新しい区間として開き直す（通知がもう 1 回出うる）。印の無い prompt は中断後の再送とも区別できないので、閉じる側を選んだ（レビュー指摘 9）
- **観測の無い人待ち**: Auto-Yes が off（poller が無い）で、ブラウザも無いとき、回答の後に出た survey を誰も読まないまま stop が来ると、区間は `turn` のまま閉じる。次に status が問い合わされるまで開き直らない。Auto-Yes が off なら開いた時点で通知は出ている（gate は `auto-yes-inactive`）ので、失うのは「まだ待っている」の reminder と解除の正確さ
- **版の照合で見送られる open**: status-helper の open は、await の間に何かが変われば見送られ、次の問い合わせまで開かない。確認を開く主な経路（response-checker・Auto-Yes poller）は I5 (d) で plan し直すので見送られない
- **同じ turn の同じ本文の 2 つ目の確認**: response-checker の本文ハッシュの重複除外（`response-checker.ts:841`）で落ちる場合は新しい確認として扱われず、`replaced` にならない
- **Service Worker の更新**: 端末の `sw.js` が更新されるまでは、解除は tag の全部を閉じる今の動き
- **プロセス再起動**: 区間はメモリにあり、再起動で消える（今の §6.2 の限界のまま）

### 未確認

- agy で、確認のダイアログより前に `pre_tool_use` が届くか（レビューの記録では agy の hook は `session_start`・`post_tool_use`・`stop` だけ）。設計はどちらでも同じ結果になるようにしたが、実機の順序は見ていない
- claude-done と agent-event の Stop を両方つないだ claude で、どちらが先に届くかの頻度（保留ブランチ `66977a5a5` の本文にも未確認とある）
- opencode が他 session の `session.idle` をどこで落としているか（`src/lib/hooks/sources/opencode/history.ts:459` 付近に「この pane のものでない session」の扱いがあるが、ingest の stop の経路に届くかは確かめていない）
- `reportPermissionRequestPending`（`agent-event-state.ts:563`）の経路で session ID を得られるか
- `agent-event-turn.ts:701` の上書き（session を見ない）を既存テストが固定しているか
- `structured-decision.ts:712` の記録が `:631`・`:634` の await と同じ関数の中にあるか
- `readWaitingScreen` を `src/lib/detection/` に置いたとき、`partialAnswerScreenKey`（`src/lib/polling/auto-yes-poller-state.ts:180`）の import が `import-cycles-baseline` に新しい循環を作らないか
- opencode の質問 push（`src/lib/hooks/sources/opencode/push.ts:172`）が Auto-Yes の gate を通らないのが意図か
- 保留ブランチのテストを develop（`4ec3c066b`）の上で動かしていない。流用するときに #3820 以降の変更（`noteToolCallEndedInLedger` 等）との差を確かめる必要がある
- 4.2 の各対照が develop の実装で落ちることは、実装の段で確かめる（この段ではテストを書いていない）

---

## 9. 本文に無い指摘（scope 外。直していない）

- `src/lib/push/waiting-push-notifier.ts:22-31` と `src/lib/session/waiting-episode-state.ts:14-18` の docblock は「`observeWaitingEdge` の呼び手は `worktree-status-helper` だけ」と書いているが、今は `response-checker`（`:941`・`:1465`）も呼ぶ。PR 1a で書き直す
- `src/lib/session/worktree-status-helper.ts:875-878`: capture が throw すると区間を閉じる（#1786 の決定）。未分類の画面も同じ。規則 3 の「capture 失敗・不明な画面は消失と扱わない」と考え方が違う。既存テストの期待を変えないため、この設計では版の照合を足すだけにした
- `src/lib/hooks/sources/opencode/push.ts:172`: 質問の push が区間を開かず、since の一致だけで status-helper の通知と束ねている。区間 ID の dedup に移すと束ねられなくなるので、PR 2 では since の互換を残す（5 章 4）

---

## 10. 改訂履歴（レビュー 1 回目）

レビュー: `workspace/orchestration/runs/2026-10-23/review-3798-design-1.md`。各指摘は該当コードを開いて事実を確かめてから処置した。

| 指摘 | 重さ | 事実の確認 | 処置 | 反映した節 |
|---|---|---|---|---|
| 1 humanHeld を受信窓を見ない共通関数で | P1 | 正しい（`auto-yes-poller.ts:682-711`・`:957-991`、status は範囲なし: `:960-963`） | 採用。`readWaitingScreen`（detection 層）を新設し全観測者が使う。screen は `originTurnId` を持ち、同じ turn の確認へは rebind | 1.8、2.2、I9、規則 1・3・4 の表、3.2 #1・#2、4.2、6（PR 1b） |
| 2 stop 以外で閉じた turn の区間 | P1 | 正しい（`observeScraperCompletionEvidence`: `agent-event-turn.ts:311-345`、呼び手 `current-output-builder.ts:1002`、`mayClose` の除外は codex だけ: `turn-abandoned.ts:43-46`） | 採用。`stop-without-turn` に `previous` を持たせ、`closed(T, stop 以外)` なら `turn(T)` を閉じる。観測の表に「閉じた turn の区間 × 新しい候補 → replaced」 | 1.6、2.2、規則 2・4 の表、3.2 #3、4.2 |
| 3 開く・rebind に開始時点の照合が無い | P2 | 正しい（I5 は閉じる・置き換えるだけを縛っていた） | 採用。compositeKey ごとの単調な版を `ObservationStart` に持たせ、kept 以外は版の一致が条件。ただし response-checker の新しい確認と Auto-Yes poller の答えは plan し直す（見送ると確認が通知されないため） | 2.2、I5・I10、2.6、3.2 #4・#5、8 |
| 4 答えの後に開いた区間を poller が閉じない | P2 | 正しい（第 1 版の条件 4 は答えた時点の区間 ID だけを見ていた） | 採用（2 案のうち「答えの送信で区間を開いておく」）。画面キーは `lastAnswer` に持ち、指摘 7 に使う | 2.2、規則 3、3.2 #6、4.2、6（PR 3） |
| 5 Service Worker が置き換えを出さない分岐 | P2 | 正しい（`sw.js:170-183` が「閉じて何も出さない分岐は持たない」と明記） | 採用。残す通知を同じ内容・無音で出し直し、`showNotification` を必ず 1 回呼ぶ | 1.5、規則 5、4.2 |
| 6 dialog だけの判定と別 session の stop | P2 | 正しい（`openDecision` は `sessionId: null`: `:846`・`:863`、`idle_prompt` の表示だけの記録: `:800-811`、`:701` は session を見ずに上書き） | 採用。dialog だけは `pendingDecisions.length > 0` を条件にし、記録に session ID を持たせ、違えば `stop-rejected`。opencode の他 session の idle の落とし先は未確認のまま | 1.6、2.2（turn model の変更）、規則 1・2 の表、3.2 #7、8 |
| 7 同じ turn の 2 つ目の確認 | P2 | 正しい（全画面 TUI は確認の後も poll: `response-checker.ts:761`・`:950-952`、重複除外 `:841`） | 採用。`freshPrompt` かつ前の確認に答え済みで画面キーが違えば replaced（PR 3） | 規則 4 の表、5（8）、4.2 |
| 8 status-helper の `sessionNameSet` が古い | P3 | 正しい（呼び手が先に `listSessions()` を await: `worktrees/route.ts:138`・`[id]/route.ts:67`） | 採用。開始時点を呼び手の `listSessions()` の前に取る | 1.3、2.5、4.2、6（PR 1b） |
| 9 open-same-session → rebind | P3 | 正しい（中断後の再送も同じ形: `agent-event-turn.ts:429-433`。`user_prompt_submit` は decision を全部捨てる: `:476-477`） | 採用。open-same-session は閉じる側。restored は N の区間を R へ戻すだけ（閉じた区間は戻さない限界を明記） | 規則 2 の表、8 |
| 10 PR の分割 | P3 | 正しい（第 1 版は gate の変更が PR 2 と PR 3 に割れていた） | 採用。1a → 2 → 1b → 3。1a と 2 は同じリリース。`prompt-push-gate.ts` の変更はすべて PR 2 | 6 |
| 11 カードのマークの一覧 | P3 | 正しい（`prompt-card-state.ts` は 1 行 1 文で書く方針） | 一部採用。一覧は持たず、最後に通知した区間 ID 1 つを時刻と一緒に 1 文で書く。旧形式の値は「ID なし」として読む | 1.5、規則 5、4.2 |
| 12 recordAgentEvent の他の経路 | P3 | 正しい（`structured-decision.ts:712`・`structured-decision-response.ts:529`・`pending-decision-recheck.ts:149`・`opencode/ingest.ts:386`、いずれも記録の前に await） | 採用。経路の表に足し、記録の前の await が区間の照合に影響しないこと（今の状態に対して処理・時刻を使わない）を明記 | 1.7、規則 8、2.5、4.2 |

受入基準との対応の抜け（R 層の破れ #3・#4・#7、OpenCode と V2 の破れ #2・#6、同一ミリ秒の turn 層、`isDuplicatePrompt` を本物のまま通す同じ本文の次の確認、claude-done の body の読みの限界、指摘 1〜7 の対照）は、すべて 4.2 に足した。
