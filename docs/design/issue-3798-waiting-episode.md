# Issue #3798 waiting の区間（WaitingEpisode）に ID と帰属を持たせる設計

- 対象 Issue: #3798（ブラウザを開いていないと agy の waiting の区間が閉じない）
- 版: 第 1 版（2026-10-23）。土台は develop `4ec3c066b`
- 位置づけ: **設計書の段**。コードは 1 行も変えていない。この文書が独立したレビューを通ってから、実装の契約が別に送られる
- 入力: Issue 本文、2026-10-19 のコメント（作り直しの設計 第 2 版: 破れ 7 件の表・規則 1〜8・追加の受入基準）、UAT 記録 `workspace/orchestration/runs/2026-10-18/uat-3788.md` 項目 D、保留ブランチ `fix/3798-waiting-interval-close-no-browser`（HEAD `07610c745`）

## 0. 表記

- **[事実]** は develop のコードを読んで確かめたこと。参照は `path:line`（develop `4ec3c066b` 時点の行番号）
- **[見立て]** は推論。実機でもテストでも確かめていない
- **未確認** は調べたが確かめられなかったこと
- 「区間」は `WaitingEpisode`、「turn」は `TurnRecord`（`src/lib/session/provisional-turn.ts:309`）、「世代」は `generationStartedAt`（`src/lib/session/agent-event-turn.ts:51`）を指す

この文書は型・不変条件・呼び出しの順序・同期区間の境界・失敗時の扱いを決める。関数本体は書かない。

---

## 1. 現状の調査

### 1.1 型

[事実]
- `WaitingEpisode` は `{ since: number; kind: WaitingKind | null }` だけ（`src/lib/session/waiting-episode-state.ts:70-81`）。ID も、どの turn・世代で開いたかも持たない
- 区間の置き場は `globalThis.__sessionWaitingEpisodes`（compositeKey → 区間、`waiting-episode-state.ts:64`）。インスタンスごとに高々 1 つ
- 遷移の通知は `WaitingTransition`（`waiting-episode-state.ts:84-97`）。`waiting: true|false`・`since`・`kind`・`at` で、区間の ID も「置き換え」も表せない
- 書き手は `observeWaitingEdge()` の 1 関数（`waiting-episode-state.ts:162-193`）。`waiting:false` なら区間を消して閉じる edge を出し、`waiting:true` で既存があれば `kind` だけ更新して `since` を返し、無ければ `structuredSince ?? now` で開く
- `turnId` は `turn-<at>-<seq>`（`agent-event-turn.ts:144-147`）で、同一ミリ秒でも区別できる。区間にはこれに相当するものが無い

### 1.2 区間を開く経路

| # | 経路 | 場所 | since | 備考 |
|---|---|---|---|---|
| O1 | status の問い合わせ（ブラウザ・`commandmate ls` 等） | `src/lib/session/worktree-status-helper.ts:884` | `frame.structuredWaitingSince`（= `peekPromptWaiting().structured.at`、`:688`）か now | 待ちの判定は scraper の status と構造化の decision の OR（`:663`） |
| O2 | 応答 poller が確認を検出 | `src/lib/polling/response-checker.ts:941`（`savePromptMessage`、`:814`） | `getWaitingEpisode()?.since ?? promptObservedAt`（`:910-912`） | **push を先に出し（`:921-938`）、その後に区間を開く**。full-screen TUI でなければ直後に `stopPolling`（`:950-952`） |

[事実] `observeWaitingEdge` を呼ぶのはこの 2 箇所と、閉じる側の `response-checker.ts:1465` だけ（`grep` で確認）。Auto-Yes poller・hook の受信・`applyAgentStopEvent` は区間に触れない。

### 1.3 区間を閉じる経路

| # | 経路 | 場所 | 条件 |
|---|---|---|---|
| C1 | status の問い合わせ | `worktree-status-helper.ts:884` | `frame.isWaitingForResponse === false`。session が動いていない・capture が throw（`:875-878` で `isProcessing=true` のみ）・未分類の画面もすべて「待っていない」になる（`:542-545` のコメントがこの決定を書いている） |
| C2 | 応答 poller が返答を記録 | `response-checker.ts:1465` | 返答を保存した tick の末尾。`mayStillActAfter(ctx,'conversation-log')`（`:1420`）を通った後、`await` なし |

[事実] 区間がどの turn のものかは、どちらの経路も見ない。C1 は自分の capture の `await`（`:841`・`:870`）の間に別の経路が開いた区間でも、戻ってきた時点の判定で閉じる。

Issue 本文は閉じる行を `response-checker.ts:1448` としているが、develop では呼び出しが `:1465`（説明コメントは `:1457`）。

### 1.4 since を引き継ぐ（流用する）経路

- [事実] O2 は開いている区間があればその `since` を自分の確認の since として使い（`response-checker.ts:911-912`）、gate（`:922-927`）と push（`:929-938`）に渡す。前の確認の区間が閉じていなければ、次の確認は前の区間の since・hold・dedup をそのまま引き継ぐ
- [事実] O1 も既存の区間があれば `kind` を更新するだけ（`waiting-episode-state.ts:181-187`）

### 1.5 区間を読む側

| 読み手 | 場所 | 区間の何で識別するか |
|---|---|---|
| Auto-Yes の hold | `src/lib/push/prompt-push-gate.ts:172-190` | `hold.since !== input.waitingSince` で新しい hold（`:179`）。`forgetAutoYesHold(key, since)`（`:271-274`） |
| 抑止記録の帰属 | `prompt-push-gate.ts:351-354` | `suppression.at >= waitingSince`（時刻） |
| 通知の dedup | `src/lib/push/notification-dedup.ts:132-143` | `WaitingPushRecord.since`（`:95-100`）。キーは `${worktreeId}::${instanceId}` |
| push の分岐 | `src/lib/push/push-sender.ts:585-591` | `waitingSince` があれば `shouldSendWaitingPush`。`notifyPushSubscribers` の dedup は最初の `await` より前（`:611-619`） |
| 通知の保持・再判定・reminder | `src/lib/push/waiting-push-notifier.ts` | `PendingWait.since`（`:111-117`）。`releaseAutoYesHold`（`:289-305`）・`releaseHeldWait`（`:318-340`）・`runEscalationTick`（`:441-489`）はすべて `episode.since !== held.since` で別の区間と判定 |
| 解除通知 | `src/lib/push/resolution-push-notifier.ts:145` | `hasOpenWaitingEpisode(worktreeId)`（worktree 単位。区間を照合しない） |
| 端末側の解除 | `public/sw.js:186-208`・`:220-258` | `tag`（`<worktreeId>:prompt`）の通知を全部閉じてから無音の置き換えを出す。区間を照合しない |
| WebSocket | `src/lib/realtime/waiting-broadcast.ts:74-76` | `transition.waiting` / `since` |
| relay | `src/lib/relay/relay-triggers.ts:134` | `transition.waiting && kind==='prompt'` |
| `commandmate wait` の抑止表示 | `src/cli/commands/wait.ts:245-264` | `autoYes.lastSuppression.at` が 60 秒以内か（`SUPPRESSION_FRESH_MS`）。区間を見ない（`current-output` は since を公開していない: `wait.ts:234-237` のコメント） |
| opencode の質問 push | `src/lib/hooks/sources/opencode/push.ts:34-44`・`:172` | `waitingSince: askedAt`。区間を開かずに、status-helper が後で同じ値で開くことに頼って dedup を合わせている |

### 1.6 turn model 側の事実

- `recordAgentEvent` は late `session_start` を保留したとき以外 `{ recorded: true }` を返す（`src/lib/session/agent-event-state.ts:346-401`）。turn が実際に閉じたか・拒否されたかは返さない
- `applyTurnTransition`（`agent-event-turn.ts:466-519`）: 世代より前の event は捨てる（`:470`）
- `applyStopToTurn`（`:687-713`）: 開いている turn に別 session の stop が来たら何もせず `return`（`:694`）。開いている turn が無ければ `openedAt:null` の閉じた記録を新しく作る（`:701-712`。dialog だけの記録も上書きして decision を捨てる）
- `openTurn`（`:567-614`）: dialog だけの記録（`openedAt:null, closedAt:null`）の decision は新しい turn に運ばれる（`:591-593`）。開いている同じ session の turn を新しい prompt が置き換えたときは `reopenedTurns` に残す（`:609-613`）
- `joinOpenTurnFromDuplicate`（`:650-675`）: queued notice の印つき複製で、置き換えた turn を元の ID で戻す
- `fenceTurnForNewGeneration`（`:347-368`）: 世代更新で decision を捨て、開いている turn を `closedBy:'generation'` で閉じる。呼び手は `recordAgentEvent` の `session_start`（`agent-event-state.ts:395`）と `beginAgentEventGeneration`（`:447`、呼び手は `src/lib/session/agent-session-lifecycle.ts:90`）
- `closesTurn` は片方の sessionId が null なら同じ session とみなす（`provisional-turn.ts:547-550`）
- `effectiveTurn` は読み出し時に古い turn を `closedBy:'stale'` で閉じる（`agent-event-turn.ts:133-142`）。遷移の通知は無い

### 1.7 stop の受信経路と await の位置

| 経路 | turn への記録（同期） | その後の await | 区間への作用 |
|---|---|---|---|
| `POST /api/hooks/agent-event`（agy・claude・codex 等） | `applyAgentEventToState` → `recordAgentEvent`（`src/lib/hooks/agent-event-intake.ts:340-398`） | `await applyAgentStopEvent`（`src/app/api/hooks/agent-event/route.ts:177`）。記録との間に `await` は無い（route の `await` は `:73` と `:177` だけ） | なし |
| opencode ingest | `recordAgentEvent`（`src/lib/hooks/sources/opencode/ingest.ts:414`） | `await applyStop`（`:434`）の中で動的 import を await（`:253-257`）してから `applyAgentStopEvent`（`:268`） | なし |
| opencode V2 ingest | `recordAgentEvent`（`src/lib/hooks/sources/opencode-v2/ingest.ts:298`） | `await stopEffect`（`:299`）→ 動的 import（`:74-78`）→ `applyAgentStopEvent`（`:85`） | なし |
| `POST /api/hooks/claude-done`（識別子なしの旧形式） | **turn model に記録しない** | body の読み（`src/app/api/hooks/claude-done/route.ts:34`）→ capture（`:58`）→ ログ保存（`:72`）→ `applyAgentStopEvent`（`:100`） | なし |

[事実] `applyAgentStopEvent`（`src/lib/hooks/agent-event-service.ts:244-`）は `recordAgentStopEvent`（時刻だけ）→ 履歴の読み（await）→ task 遷移・検証。区間には触れない。

### 1.8 事象の説明（UAT 項目 D との対応）

[事実]（UAT 記録）1 回目: 09:28:14.804 に区間が開く → 15.119 に `response-sent` → 18.839 に stop → 24.121 に `prompt-push-allowed (auto-yes-not-answered)`。3・4 回目は `waitingSince` が 1 回目の値のまま、poller が答える前に `prompt-push-allowed`。

[見立て] 説明は Issue の見立てどおり。agy の返答は hook で届くので C2 に来ず、ブラウザが無いので C1 も来ない。区間が開いたままなので、
- hold の終わりの再判定（`waiting-push-notifier.ts:289-305`）が区間を開いたままと読み、`auto-yes-not-answered` を出す（1 回目）
- 次の確認で O2 が古い since を流用し（`response-checker.ts:911-912`）、hold の起点（同じ since の hold の `firstHeldAt`）から 9 秒を過ぎているので即座に通知可になる（3・4・6・7 回目）

保留ブランチの最初のコミット `bfcf02c8f` がテストでこの 2 つの形を再現し、赤を確かめている（コミットメッセージ）。この文書では再実行していない。

---

## 2. 設計

### 2.1 方針

1. 区間は **ID と帰属（binding）** を持つ。同一性は ID だけで判定し、時刻は表示と経過時間に使う（規則 1）
2. turn の遷移（stop・開始・世代・session_end・復元）は、**turn model を書き換えたその同期区間の中で**区間に作用する。後段の `await` の後では区間を操作しない（規則 2・8）
3. 画面の観測（status-helper・応答 poller・Auto-Yes poller）は **1 つの観測関数** を呼び、帰属の推定を各自で持たない。観測は「始めた時点で見ていた区間」を渡し、戻ってきた時点で照合する（規則 3・4）
4. 帰属の違う区間への入れ替えは **1 つの操作**（`replaced`）にし、途中で「誰も待っていない」を出さない（規則 5）
5. push 側の hold・dedup・reminder・解除は区間 ID で照合する（規則 5・7）

### 2.2 型

```ts
// src/lib/session/waiting-episode-state.ts

/** プロセス内で一意。時刻を含めない（同一ミリ秒でも別）。 */
export type WaitingEpisodeId = string; // `wep-<bootNonce>-<seq>`。seq は globalThis の単調増加カウンタ

/** 世代の参照。「世代が開かれていない」を null と混ぜない。 */
export type GenerationRef =
  | { kind: 'opened'; at: number }   // generationStartedAt の値
  | { kind: 'none' };                // このプロセスで世代が一度も開かれていない

/** 区間がどの待ちとして開いたか（規則 1: 4 つを 2 値に潰さない）。 */
export type EpisodeBinding =
  /** 開いている turn の中の待ち。その turn の終わりで閉じうる。 */
  | { kind: 'turn'; generation: GenerationRef; turnId: string }
  /** 確認だけが先に来ている（turn model に dialog だけの記録 openedAt:null がある）。 */
  | { kind: 'dialog-only'; generation: GenerationRef; recordTurnId: string }
  /** 現世代で開いている turn も dialog の記録も無いときに見えた待ち（hook の無いツール、開始 hook の前、stop の後）。 */
  | { kind: 'unattributed'; generation: GenerationRef; lastClosedTurnId: string | null }
  /** 画面固有の人待ち（survey・picker・信頼確認など）。turn の終わりでは閉じない（規則 3）。 */
  | { kind: 'screen'; generation: GenerationRef };

export type WaitingObserver =
  | 'status-probe'       // worktree-status-helper
  | 'response-checker'   // 応答 poller
  | 'auto-yes-poller'
  | 'turn-transition'    // recordAgentEvent / beginAgentEventGeneration
  | 'legacy-stop';       // claude-done

export interface WaitingEpisode {
  episodeId: WaitingEpisodeId;
  /** 表示・経過時間用。開いた後は動かさない。同一性に使わない。 */
  since: number;
  kind: WaitingKind | null;
  binding: EpisodeBinding;
  openedBy: WaitingObserver;
}

export type WaitingCloseReason =
  | 'turn-stop'          // 規則 2: その turn の stop
  | 'turn-session-end'
  | 'turn-superseded'    // 帰属先の turn が stop 以外で閉じたまま次の turn が開いた
  | 'generation'         // 規則 8: 世代更新
  | 'screen-cleared'     // 観測が「待っていない」を読んだ
  | 'session-gone'       // session が動いていない
  | 'response-recorded'  // C2
  | 'poller-answered'    // 規則 3: Auto-Yes poller が答えた区間の画面が消えた
  | 'legacy-stop';       // 規則 6: claude-done

/** 既存の形に cause・episodeId を足す。既存の購読者は waiting/since だけ読めば今までどおり動く。 */
export interface WaitingTransition {
  worktreeId: string; cliToolId: CLIToolType; instanceId: string | undefined;
  waiting: boolean;          // opened/replaced: true、closed: false
  since: number | null;
  kind: WaitingKind | null;
  at: number;
  cause: 'opened' | 'closed' | 'replaced';
  episodeId: WaitingEpisodeId | null;        // opened/replaced: 新しい区間、closed: null
  previousEpisodeId: WaitingEpisodeId | null; // closed/replaced: 終わった区間
  closeReason: WaitingCloseReason | null;     // closed/replaced のときだけ
}
```

turn model が返す結果（規則 2: 「記録した」と「turn を終わらせた」を分ける）:

```ts
// src/lib/session/agent-event-turn.ts（applyTurnTransition / fenceTurnForNewGeneration / joinOpenTurnFromDuplicate の戻り値）
export type PreviousTurn =
  | { kind: 'none' }
  | { kind: 'dialog-only'; turnId: string }
  | { kind: 'open-same-session'; turnId: string }   // #3330 の置き換え
  | { kind: 'open-other-session'; turnId: string }
  | { kind: 'closed'; turnId: string; closedBy: TurnCloseReason };

export type TurnTransitionOutcome =
  | { kind: 'none' }                                                    // 区間に関係しない（notification の大半、late session_start 等）
  | { kind: 'opened'; turnId: string; generation: GenerationRef; previous: PreviousTurn; carriedDecisions: boolean }
  | { kind: 'continued'; turnId: string }
  | { kind: 'restored'; restoredTurnId: string; discardedTurnId: string } // joinOpenTurnFromDuplicate
  | { kind: 'stopped'; turnId: string; generation: GenerationRef }        // 開いている turn を閉じた
  | { kind: 'stop-without-turn'; recordTurnId: string; generation: GenerationRef } // :701 の分岐
  | { kind: 'stop-rejected'; reason: 'other-session' | 'before-generation' }
  | { kind: 'session-ended'; turnId: string }
  | { kind: 'session-end-rejected'; reason: 'other-session' | 'no-turn' | 'before-generation' }
  | { kind: 'generation-fenced'; generation: GenerationRef; fencedTurnId: string | null };

// src/lib/session/agent-event-state.ts
export type AgentEventRecordOutcome =
  | { recorded: true; turn: TurnTransitionOutcome }
  | { recorded: false; skipped: 'late-session-start' };
```

`{ recorded: true }` に `turn` を足すだけなので、戻り値を無視している既存の呼び手（opencode・V2 の ingest、テスト）は変わらない。

観測（規則 3・4）:

```ts
// src/lib/session/waiting-episode-binding.ts（新設）

/** 観測が始まった時点で見ていたもの。最初の await の前に読む。 */
export interface ObservationStart {
  generation: GenerationRef;
  episodeId: WaitingEpisodeId | null; // その時点で開いていた区間（無ければ null）
}

export type ScreenReading =
  | { kind: 'waiting'; waitingKind: WaitingKind | null; humanHeld: boolean; structuredSince: number | null }
  | { kind: 'not-waiting' }
  | { kind: 'unknown' }   // capture 失敗・分類できない画面（poller は消失と扱わない）
  | { kind: 'gone' };     // session が動いていない

export interface WaitingObservation {
  worktreeId: string; cliToolId: CLIToolType; instanceId?: string;
  observer: Exclude<WaitingObserver, 'turn-transition' | 'legacy-stop'>;
  start: ObservationStart;
  reading: ScreenReading;
  /** auto-yes-poller のときだけ: この poller が答えた区間（answer を送り始めた時点で開いていた区間）。 */
  answeredEpisodeId?: WaitingEpisodeId | null;
  now?: number;
}

export type ObservationAction = 'opened' | 'kept' | 'rebound' | 'replaced' | 'closed' | 'ignored';

export interface WaitingObservationPlan {
  action: ObservationAction;
  /** 適用後に開いている区間（closed/ignored で区間が無ければ null）。 */
  episode: Pick<WaitingEpisode, 'episodeId' | 'since' | 'kind' | 'binding'> | null;
  /** 適用時に、計画したときの区間と同じかを照合するための値。 */
  basedOn: WaitingEpisodeId | null;
}

export function startWaitingObservation(worktreeId, cliToolId, instanceId?): ObservationStart;
export function planWaitingObservation(obs: WaitingObservation): WaitingObservationPlan;   // 純粋。書かない
export function commitWaitingObservation(plan: WaitingObservationPlan): ObservationAction; // basedOn が今の区間と違えば 'ignored'
export function observeWaiting(obs: WaitingObservation): WaitingObservationPlan;          // plan + commit

/** turn の遷移を区間に反映する。recordAgentEvent / beginAgentEventGeneration が turn を書き換えた直後に同期で呼ぶ。 */
export function applyTurnOutcomeToEpisode(key: CompositeKeyParts, outcome: TurnTransitionOutcome, at: number): EpisodeEffect;

/** 規則 6: claude-done。 */
export interface LegacyStopTarget { generation: GenerationRef; episodeId: WaitingEpisodeId | null }
export function captureLegacyStopTarget(worktreeId, cliToolId, instanceId): LegacyStopTarget;
export function settleLegacyStop(worktreeId, cliToolId, instanceId, target: LegacyStopTarget): 'closed' | 'target-gone' | 'hook-authority' | 'nothing-open';
```

`observeWaitingEdge` は既存のテストと呼び手のために残し、`observeWaiting` に `start` を「今」で埋めて委ねる薄い層にする（戻り値 `since` も今までどおり）。

stop の権限（規則 6）: `__waitingHookStopGeneration: Map<compositeKey, GenerationRef>`。`applyTurnOutcomeToEpisode` が `stopped` / `stop-without-turn` を受けたとき、その世代を書く。claude-done は今の世代にこの印があれば区間を閉じない。

### 2.3 不変条件

- **I1** 1 インスタンスに開いている区間は高々 1 つ。区間 ID は再利用しない
- **I2** 区間の `episodeId`・`since` は開いてから閉じるまで変わらない。変わるのは `kind` と `binding` だけ（rebind）
- **I3** rebind は edge を出さない（WebSocket・push・解除のどれも動かない）。hold・dedup・reminder は区間 ID に付くので、rebind で延びも縮みもしない
- **I4** `closed` の edge は「その区間が終わった」ことだけを言う。置き換えでは出さない（`replaced` を 1 回だけ出す）
- **I5** 区間を閉じる・置き換えるのは、(a) turn model を書き換えた同期区間の中、または (b) 観測が `start.episodeId` と今の区間 ID の一致を確かめた後の同期区間の中、または (c) claude-done が `target.episodeId` と一致を確かめた後の同期区間の中、のどれかだけ
- **I6** 世代が `start.generation` と違う観測は何もしない（前のプロセスの画面を読んでいる）
- **I7** 区間の `binding.generation` が今の世代と違えば、その区間は前のプロセスのもの。世代更新の同期区間で閉じる
- **I8** `binding.kind === 'screen'` の区間は turn の遷移（stop・session_end・開始）では閉じない。閉じるのは観測（`not-waiting`/`gone`）と世代更新だけ

### 2.4 規則ごとの落とし込み

#### 規則 1（ID と帰属）

- `episodeId` を開くたびに払い出す（2.2）。hold・dedup・reminder・解除・抑止記録は ID で照合する（規則 7 の節）
- binding は開く時点で turn model から同期で決める:

| 開く時点の turn model（`getAgentTurn` の fence 込み、`agent-event-turn.ts:214-222`） | binding |
|---|---|
| 開いている turn（`openedAt!==null && closedAt===null`） | `turn`（その `turnId`） |
| dialog だけの記録（`openedAt===null && closedAt===null`） | `dialog-only`（その `turnId`） |
| 閉じた turn・記録なし | `unattributed`（閉じた turn があればその ID を `lastClosedTurnId` に） |
| 観測が `humanHeld: true` を読んだ | 上の結果に関わらず `screen` |

`humanHeld` は「status の判定が `waiting` で、答えられる確認（prompt reader の `isPrompt`）ではない」画面。保留ブランチ `7b41cd6a8` が poller で使った `detectSessionStatus(raw ?? clean, cliToolId).status === 'waiting'` と prompt reader の組み合わせを、観測関数の入力を作る側（各観測者）が渡す。

#### 規則 2（stop は実際に終わらせた対象だけを閉じる）

- `recordAgentEvent` は `applyTurnTransition` の戻り値 `TurnTransitionOutcome` を受け、**同じ関数の中で** `applyTurnOutcomeToEpisode` を呼ぶ。`recordAgentEvent` は同期関数なので、stop の記録・turn の遷移・区間の終了は 1 つの同期区間に入る
- 区間への作用表（`applyTurnOutcomeToEpisode`）:

| outcome | 開いている区間の binding | 作用 |
|---|---|---|
| `stopped(T)` | `turn(T)` 同世代 | 閉じる（`turn-stop`） |
| `stopped(T)` | `screen` / 他 | 何もしない |
| `stop-without-turn` | `unattributed` / `dialog-only` 同世代 | 閉じる（`turn-stop`）。`dialog-only` は turn model 側でも `:701` の上書きで decision が捨てられている |
| `stop-rejected(*)` | 何でも | 何もしない（破れ #1） |
| `session-ended(T)` | `turn(T)` | 閉じる（`turn-session-end`） |
| `opened(N, previous)` | `dialog-only(R)` で `previous=dialog-only(R)`、または `unattributed` 同世代 | rebind → `turn(N)`（規則 4） |
| `opened(N, previous=open-same-session(P))` | `turn(P)` | rebind → `turn(N)`（#3330 の置き換え。復元に備える） |
| `opened(N, previous=open-other-session(P) / closed(P))` | `turn(P)` | 閉じる（`turn-superseded`） |
| `restored(R, discarded N)` | `turn(N)` | rebind → `turn(R)`（規則 8） |
| `generation-fenced(G)` | `binding.generation ≠ G` | 閉じる（`generation`。`screen` も含む） |
| 上記以外 | — | 何もしない |

- 戻り値 `EpisodeEffect`（`{ action: 'closed'|'rebound'|'none'; episodeId }`）を `AgentEventRecordOutcome` 経由でログに出す（`agent-event-stop-applied` に `episodeEffect` を足す）。拒否された stop も `stop-rejected` として明示的に持ち回る（今の `{recorded:true}` が turn の終了成功を意味しない問題: `agent-event-state.ts:401`・`agent-event-turn.ts:694`）
- `applyAgentStopEvent`（後段。opencode・V2 では動的 import の await の後）は **区間を操作しない**。保留ブランチの `stopEndsWaitingEpisode`（後段で turn model を読み直して推定）は採らない

#### 規則 3（turn の後にも残る人待ちは stop で閉じない）

- 観測者が `humanHeld: true` を読んだら、区間はその同期区間で `screen` に rebind される（I2: ID・since はそのまま）。以後 stop・session_end・turn の開始では閉じない（I8）
- **Auto-Yes poller が閉じる条件**（すべて満たすとき `poller-answered` で閉じる）:
  1. 読みが `not-waiting`（status の判定が `waiting` でない）。`unknown`（capture 失敗・未分類）・`gone` では何もしない
  2. `start.generation` が今の世代と同じ
  3. `start.episodeId` が今の区間 ID と同じ（tick の間に入れ替わっていない）
  4. `answeredEpisodeId` が今の区間 ID と同じ（その区間にこの poller が答えた）。`answeredEpisodeId` は答えを送り始める同期区間で、そのとき開いていた区間 ID を pollerState に記録したもの（新しい欄 `lastAnsweredEpisodeId`。#3796 の欄には触らない）
- status-helper は従来どおり capture 失敗と未分類を「待っていない」と読む（`worktree-status-helper.ts:542-545` の #1786 の決定。既存テストの期待を変えないため）。ただし閉じるのは `start.episodeId` が今の区間と同じときだけにする（自分の capture の await 中に開いた区間を閉じない）
- 「menu の後に stop」: poller・status-helper が menu を読んだ時点で `screen` → stop は何もしない。「stop の後に menu」: stop で閉じた後、次の観測が menu を `waiting(humanHeld)` と読み、新しい区間（新しい ID・since・hold）を開く → 9 秒で通知可（陽性対照）

#### 規則 4（確認が turn より先のときは同じ区間の帰属の更新）

- `openTurn` の decision の引継ぎ（`agent-event-turn.ts:591-593`）は `opened` の `previous: dialog-only(R)`・`carriedDecisions: true` として返り、同じ `recordAgentEvent` の同期区間で `dialog-only(R)` の区間を `turn(N)` に rebind する
- dialog の記録が無い `unattributed` の区間（scraper だけが読んだ確認、開始 hook が遅れたとき）も、同じ世代で次に開いた turn に rebind する（破れ #6）
- status-helper と response-checker は `planWaitingObservation` を呼び、binding の推定を自分で持たない。観測時点の binding 候補が開いている区間の binding と「同じ待ち」と判定される組み合わせ（下表）なら `kept` か `rebound` で、閉じて開き直さない

| 開いている区間 | 観測時点の候補 | 観測の action |
|---|---|---|
| `turn(T)` | `turn(T)` | kept |
| `dialog-only(R)` / `unattributed` 同世代 | `turn(N)` | rebound（turn 遷移で済んでいれば kept） |
| 何でも（同世代） | `screen`（humanHeld） | rebound → `screen` |
| `screen` | `screen` | kept |
| `screen` | `turn(T)` で答えられる確認 | replaced（規則 5） |
| `turn(P)` | `turn(T)`（P≠T） | replaced（turn 遷移の取りこぼしの収束） |
| 世代が違う | 何でも | replaced |

#### 規則 5（別区間への置換は 1 つの操作）

- `commitWaitingObservation` の `replaced` は、古い区間を消して新しい区間を置き、`cause:'replaced'` の遷移を **1 回だけ** 出す。`closed` は出さないので、`resolution-push-notifier` は呼ばれず（`waiting-push-notifier.ts:395` は `cause==='closed'` のときだけ）、WebSocket は `waiting:true` の新しい since だけを送る
- 新しい区間の since: 観測の `structuredSince` が新しい binding に属する（その turn の decision の `at`）ならそれ、そうでなければ観測時刻。古い区間の since は持ち込まない
- 解除通知の照合（端末の到着順の逆転）:
  - prompt の push の `data` に `episodeId` を入れる
  - `prompt-card-state` のマーク（worktree 単位、`app_settings`）に、そのカードで通知した区間 ID の一覧を持たせる
  - 解除の push に `resolvedEpisodeIds`（マークの一覧）を入れる
  - `public/sw.js` は解除を受けたら、同じ tag の通知のうち `data.episodeId` が一覧にあるもの、または `episodeId` を持たないもの（旧形式）だけを閉じる。一覧に無い `episodeId` の通知が残っていれば、無音の置き換えを出さない
  - 一覧の無い解除（旧サーバー）は今の動き（tag の全部を閉じる）

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
- claude-done は turn model に何も記録しない（今のまま）。route の変更は `no-claude-fallback` guard の baseline（`tests/unit/guards/no-claude-fallback.test.ts:258-291`、追加禁止）に触れないよう、`'claude'` の文字列を新しい呼び出しの引数に書かない（route 内の既存の値を使うか、lib 側に置いた定数を使う）

#### 規則 7（#3796 との整合・dedup・抑止記録）

5 章にまとめる。

#### 規則 8（stop 以外の turn 遷移と既存の閉じる経路）

- `session_start`（`agent-event-state.ts:385-396`）と `beginAgentEventGeneration`（`:433-`）はどちらも `fenceTurnForNewGeneration` の後に `applyTurnOutcomeToEpisode(generation-fenced)` を同じ同期区間で呼ぶ。`fenceTurnForNewGeneration` は turn が無くても outcome を返す（区間の世代の照合は turn の有無と独立）
- `session_end` は `session-ended` / `session-end-rejected` を返す
- queued notice の復元（`joinOpenTurnFromDuplicate`、`agent-event-turn.ts:650`）は `restored` を返し、呼び手（intake の重複破棄の経路）が同期で `applyTurnOutcomeToEpisode` を呼ぶ
- C2（`response-checker.ts:1465`）は `observeWaiting({ observer:'response-checker', reading:{kind:'not-waiting'}, start })` にする。`start` は tick の最初の `await`（`:1533` の `isSessionRunning`）の前に読む。`mayStillActAfter` の後の同期区間であることは変えない（`tests/unit/guards/retired-tick-write-guard-3705.test.ts` の対象一覧に新しい関数名を足す）
- O2（`savePromptMessage`）は `planWaitingObservation` で区間（ID・since）を決め、その ID・since で gate と push を出し、同じ同期区間で `commitWaitingObservation` する。`savePromptMessage` は同期関数（`response-checker.ts:814`）で、`notifyPushSubscribers` の dedup は最初の `await` より前（`push-sender.ts:611-619`）なので、「push を先に、区間を後に」の順序（`:899-909` のコメント）を保ったまま ID を一致させられる
- `closeAgentTurn`（`scraper_evidence`・`resync_idle`、`agent-event-turn.ts:253`）と `effectiveTurn` の `stale` は区間に作用しない（読み出しで書くので遷移を出せない）。その turn に付いた区間は、次の turn の `opened(previous=closed)` か観測で閉じる

### 2.5 同期区間の境界（経路ごと）

| 経路 | 固定する時点（最初の await の前） | 区間を操作する同期区間 | await の後にしないこと |
|---|---|---|---|
| agent-event route | — | `applyAgentEventToState` → `recordAgentEvent` → `applyTurnTransition` → `applyTurnOutcomeToEpisode` | `applyAgentStopEvent`（`route.ts:177`）で区間に触れない |
| opencode ingest | — | `recordAgentEvent`（`ingest.ts:414`）の中 | `applyStop`（`:434`）で触れない |
| V2 ingest | — | `recordAgentEvent`（`ingest.ts:298`）の中 | `stopEffect`（`:299`）で触れない |
| 世代更新 | — | `beginAgentEventGeneration` の中 | — |
| claude-done | `captureLegacyStopTarget`（`:47` の後） | `settleLegacyStop`（`:72` の後、`:100` の前） | `:100` 以降で触れない |
| status-helper | `startWaitingObservation`（`detectInstanceSessionStatus` の冒頭、`:841` の liveness の await の前） | `observeWaiting`（`:884` の位置） | — |
| 応答 poller | `start`（`checkForResponse` の `:1533` の前） | O2: `savePromptMessage` の中、C2: `:1465` の位置 | — |
| Auto-Yes poller | `start`（tick の capture の await の前。#3796 の `sessionWaitTickRanAt` を書く位置の近く、`auto-yes-poller.ts:1172` 付近） | `no_prompt` を返す直前（`:991` 付近）の `observeWaiting`。`lastAnsweredEpisodeId` は答えの送信を始める同期区間で書く | — |

### 2.6 失敗時の扱い

- 区間の listener が throw しても区間の状態は変わらない（今の `emit` の封じ込め、`waiting-episode-state.ts:114-128` を維持）
- `applyTurnOutcomeToEpisode` が throw しても `recordAgentEvent` の turn の記録は済んでいる。throw は内部で握り、`waiting-episode-turn-sync-failed` を warn で出す（hook の受信を 500 にしない）
- capture 失敗: Auto-Yes poller は `unknown`（何もしない）。status-helper は従来どおり `not-waiting`（ただし `start` の照合つき）
- `commitWaitingObservation` の `basedOn` 不一致は `ignored`（debug ログ）。同期区間の中で plan と commit を続けて呼ぶので、通常は起きない
- プロセス再起動で区間は消える（今の §6.2 の限界、`prompt-card-state.ts:82-91`）。ID の `bootNonce` で再起動前後の ID は衝突しない

---

## 3. 破れ 7 件がどこで閉じるか

| # | 再現の順序 | 以前に起きたこと | この設計で閉じる場所 | 規則 |
|---|---|---|---|---|
| 1 | ① 同じ instance の新 session B の turn が開き、B の確認で区間（`turn(B)`）が開く ② 旧 session A の stop が届く | turn は拒否するのに区間は閉じた | ② の `applyStopToTurn` が `:694` で拒否 → `stop-rejected(other-session)` → 区間に作用しない（2.4 規則 2 の表） | 2 |
| 2 | ① turn T の確認に Auto-Yes が答える ② survey など番号の無い menu が出る ③ T の stop | 人が要る menu の区間を閉じた | ② の観測（poller / status-helper）が `humanHeld` を読み `screen` に rebind → ③ は I8 で何もしない。poller も読みが `waiting` なので閉じない | 3 |
| 3 | ① A の stop を記録 ② 後段の await ③ B が区間を開く ④ A の後段が戻る | B の区間を閉じた | A の区間は ① の同期区間で閉じ済み。④ は区間を操作しない（2.5） | 2 |
| 4 | ① A の区間が開いたまま ② A の stop・await ③ B の確認 | B が A の since を引き継ぎ、猶予が短く、A の通知済みで B が抑止された | `turn(A)` なら ② の同期区間で閉じ、③ は新しい ID・since で開く。A が `screen` で残っていれば ③ の観測が `replaced`（新しい ID・since・hold、dedup も ID で別） | 2・5・7 |
| 5 | ① 前の世代で hook の記録 ② 世代更新 ③ 現世代は claude-done だけ | 互換 stop で閉じられなくなった | ② で前世代の区間は閉じる。③ の `settleLegacyStop` は今の世代の hook stop の印だけを見るので、印が無く閉じる | 6・8 |
| 6 | ① turn 未作成で確認（`unattributed` / `dialog-only`） ② 遅い開始 hook ③ 取得を繰り返す | 引き継がれた確認の区間を取得のたびに閉じ直した | ② の `opened` で rebind（同じ ID・since・hold）。③ の観測は `kept` | 4 |
| 7 | ① A の stop を記録 ② await ③ 世代更新 ④ 開始 hook 前の B が人待ち ⑤ A の後段が戻る | 世代の柵で turn が null になり B の区間を閉じた | A の区間は ① で閉じ済み（③ でも閉じる）。⑤ は区間を操作しない。① が ③ より後に届いた場合は `before-generation` で拒否 | 2・8 |

---

## 4. 陰性対照・陽性対照とテストの層

### 4.1 層

| 記号 | 層 | 入口 | 区間・push の観測 |
|---|---|---|---|
| R | 実 ingest（route） | `POST /api/hooks/agent-event` の handler を直接呼ぶ（`recordAgentEvent` は本物） | `getWaitingEpisode`・遷移の記録・`prompt-push-*` のログ |
| OC | opencode ingest | `ingestOpencodeEvent`（`applyStop` の動的 import を遅延させる mock で await を止める） | 同上 |
| V2 | opencode V2 ingest | `ingestOpencodeV2Event` の `stopEffect` seam（`ingest.ts:183`）を deferred にする | 同上 |
| CD | claude-done route | `captureClaudeOutput`・`recordClaudeConversation` を deferred にする | 同上 |
| SH | status-helper | `detectInstanceSessionStatus` を公開経路から（capture を deferred にできる mock） | 同上 |
| RC | response-checker | 本物の `checkForResponse` | 同上 |
| AY | Auto-Yes poller | `detectAndRespondToPrompt` / tick | 同上 |
| P | push | `waiting-push-notifier`・`prompt-push-gate`・`notification-dedup`・`resolution-push-notifier` を fake timers で | 通知回数・hold の期限・解除 |
| SW | Service Worker | `tests/unit/pwa/sw-push.test.ts` と同じ方式 | 閉じた通知・置き換えの有無 |

対照は `os.tmpdir()` の `mkdtempSync` で作った隔離 DB（既存の push テストと同じ方式）で行い、`afterEach` で消す。

### 4.2 一覧

**破れ 7 件**（すべて陰性対照。直す前の develop では「区間が閉じない」側で落ち、保留ブランチの各版ではそれぞれの破れで落ちる）

| 対照 | 層 |
|---|---|
| #1 新 session B 待ち中の旧 A の stop: B の ID・since・hold の期限・通知回数が変わらない | R・OC・V2 |
| #2 回答 → survey/picker → stop: 区間・hold・reminder が残る。解除通知 0 | R（stop）・AY（poller）・SH |
| #3 A の stop 記録 → await 中に B が開く → 戻る: B が残る | OC・V2 |
| #4 A の区間が開いたまま → A stop・await → B の確認: B は新しい ID・since・hold、A の通知済みで抑止されない | OC・V2・RC |
| #5 前世代の hook 記録 → 世代更新 → claude-done だけ: 閉じる | CD |
| #6 turn 未作成で確認 → 遅い開始 hook → 取得 3 回: 開く edge 1 回、ID・since 不変 | SH・R |
| #7 A stop 記録 → await → 世代更新 → 開始 hook 前の B 人待ち → 戻る: B が残る | OC・V2 |

**追加の陰性対照**

| 対照 | 層 |
|---|---|
| 拒否された stop（別 session / 世代より前）で区間・hold・通知回数が変わらない。ログの `episodeEffect` が `none` | R・OC・V2 |
| 同一ミリ秒: 区間 A の終了と区間 B の開始が同じ `now`、または 2 つの区間の since が等しい → ID が別、通知 2 回、hold が別 | P・RC |
| 同じ本文の次の確認（次の turn）: 新しい区間・新しい通知 | RC |
| 複数回の再取得: 同じ区間に対する status の取得を 3 回以上 → 開く edge 1 回 | SH |
| 世代交替: `beginAgentEventGeneration` と `session_start` のそれぞれで、開いている区間（`screen` を含む）が閉じる edge 1 回 | R・SH |
| claude-done の各 await 中の入れ替わり: `:58` の間、`:72` の間それぞれで (a) hook stop が A を閉じ B が開く → B が残る (b) 世代更新 → 何もしない (c) 何も起きない → A が閉じる（陽性） | CD |
| 開始 hook だけ併用: hook の turn が開いている・hook stop の印なし → claude-done が閉じる（陽性）。hook stop の印あり → claude-done は何もしない | CD・R |
| queued notice の復元: 置き換えた turn に付いた区間が元の turn に戻り、元の turn の stop で閉じる | R |
| status-helper の capture の await 中に応答 poller が開いた区間を、戻った status-helper が閉じない | SH・RC |
| Auto-Yes poller: 答えていない区間・前の区間の答え・capture 失敗・未分類の画面・tick 中の入れ替わりで閉じない | AY |

**人待ちの対照**（最終状態に加え、解除通知・通知回数・since・hold の期限が変わらないことを見る）

| 対照 | 層 |
|---|---|
| menu が出た後に stop | R・AY・P |
| 構造化確認 → 遅い開始 hook → 繰り返し取得 | R・SH・P |

**#3796 との対照**

| 対照 | 層 |
|---|---|
| wake → capture 失敗 → 再予約の間に rebind が起きても hold の期限が延びない（`autoYesHoldEndsAt` の値が rebind の前後で同じ） | P・AY |
| replaced で新しい区間だけに新しい hold（`pendingSessionWaitTick` を新しい hold の開始時点で読む） | P |
| 複数端末への解除通知と新しい通知の到着順の逆転: 解除が後に届いても新しいカードが残り、無音の置き換えを出さない | SW・P |

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
6. **抑止記録に区間 ID を入れる。** `AutoYesPolicySuppression` に `episodeId: WaitingEpisodeId | null` を足す（記録した同期区間で開いていた区間）。gate は ID があれば `suppression.episodeId === input.waitingEpisodeId`、無ければ従来の `at >= waitingSince`。#3796 の `refreshEpisodeSuppression`（`src/lib/polling/auto-yes-poller-receipt-log.ts:246-270`）は記録を写し直すとき `episodeId` を引き継ぐ（新しい区間へ持ち込まない）
7. **wait が読む抑止記録。** `current-output` の `autoYes.lastSuppression` に `episodeId` を、`autoYes` に今の `waitingEpisodeId` を公開する。`wait.ts` の `activeSuppression`（`:252-264`）は、両方が非 null で異なれば古い記録として扱う。どちらかが無ければ（旧サーバー）今の 60 秒の窓（`:245`）
8. **旧区間の回答を持ち込まない。** hold の起点に使う `lastServerResponseTimestamp`（`prompt-push-gate.ts:188-189`）は「起点を後ろへずらす」だけなので残す。Auto-Yes poller が区間を閉じる判定には時刻ではなく `lastAnsweredEpisodeId` を使う（規則 3）
9. Auto-Yes poller の #3796 の欄（`sessionWaitTickAt`・`sessionWaitTickRanAt`・`sessionAppearedAt`、`src/lib/polling/auto-yes-poller-state.ts:44-58`）には触らない。capture 失敗の tick は区間に作用しない（規則 3）ので、「wake → capture 失敗 → 再予約」の間に区間も hold も変わらない

---

## 6. 実装の分割

PR 1 本では scope が session・push・poller・Service Worker・CLI にまたがり、レビューの単位として大きすぎる。3 本に分け、この順に入れる。どの PR も単独で develop を壊さない（前の PR の型だけに依存する）。

### PR 1: 区間の ID と帰属、turn の遷移での同期的な終了（session 層）

- scope: `src/lib/session/waiting-episode-state.ts`、`src/lib/session/waiting-episode-binding.ts`（新設）、`src/lib/session/agent-event-turn.ts`、`src/lib/session/agent-event-state.ts`、`src/lib/hooks/agent-event-intake.ts`（復元の outcome とログ）、`src/app/api/hooks/agent-event/route.ts`（ログの欄）、`src/lib/session/worktree-status-helper.ts`、`src/lib/polling/response-checker.ts`、`src/app/api/hooks/claude-done/route.ts`、`tests/unit/guards/retired-tick-write-guard-3705.test.ts`（対象一覧への追加のみ）、各テスト、`changelog.d/3798.md`
- 入るもの: 規則 1・2・4・6・8、規則 3 のうち stop・status-helper の部分、規則 5 のうち `replaced` の遷移（push 側はまだ since で照合するが、`replaced` は `closed` を出さないので解除は動かない）
- テスト: 4.2 の破れ 7 件（層 R・OC・V2・CD・SH・RC）、拒否された stop、世代交替、claude-done の入れ替わり、開始 hook だけ併用、queued notice の復元、複数回の再取得、陽性対照（UAT 1 回目・3/4 回目・人が要る画面・閉じる edge は通知しない）
- これで Issue の元の受入基準（ブラウザ無しで答え済み＋ターン終了で閉じる・`prompt-push-allowed` が出ない・人が要る画面は約 9 秒）を満たす
- 注意: `import-cycles-baseline` guard（`tests/unit/guards/import-cycles-baseline-3482.test.ts`）に新しい循環を足さない。`waiting-episode-state` は `agent-event-*` を import しない。`agent-event-state` を部分 mock する既存の integration テストがあるので、新しい関数は `agent-event-state` から export しない（保留ブランチ `7b41cd6a8` の記録）

### PR 2: push 側を区間 ID で照合（hold・dedup・reminder・解除・Service Worker）

- scope: `src/lib/push/prompt-push-gate.ts`、`src/lib/push/notification-dedup.ts`、`src/lib/push/push-sender.ts`、`src/lib/push/waiting-push-notifier.ts`、`src/lib/push/resolution-push-notifier.ts`、`src/lib/push/prompt-card-state.ts`、`public/sw.js`、`src/lib/polling/response-checker.ts`（gate・push に ID を渡す行だけ）、テスト
- 入るもの: 規則 5 の解除の照合、規則 7 の 1〜5
- テスト: 同一ミリ秒、replaced で新しい hold、rebind で hold が延びない（#3796 の wake → capture 失敗 → 再予約を含む）、到着順の逆転（SW）、既存の `prompt-push-gate-*`・`waiting-push-*`・`cross-device-dismissal-2001`・`sw-push` が期待を変えずに通ること（ID の無い入力は since の比較のまま）

### PR 3: Auto-Yes poller の終了と抑止記録の区間 ID（poller・CLI）

- scope: `src/lib/auto-yes-poller.ts`、`src/lib/polling/auto-yes-poller-state.ts`（`lastAnsweredEpisodeId` の追加のみ）、`src/lib/polling/auto-yes-suppression-state.ts`、`src/lib/polling/auto-yes-poller-receipt-log.ts`（`episodeId` の引き継ぎ）、`src/lib/session/current-output-builder.ts`・`current-output-types.ts`、`src/cli/types/api-responses.ts`、`src/cli/commands/wait.ts`、テスト
- 入るもの: 規則 3 の poller の条件、規則 7 の 6〜9
- テスト: 4.2 の AY の対照（答えた区間だけ閉じる、survey/picker/信頼確認・受信待ちで保留した確認・capture 失敗・未分類・tick 中の入れ替わりで閉じない）、menu が出た後に stop、wait の抑止表示（ID が違えば古い、ID が無ければ 60 秒）
- PR 1 だけでも、stop が hold の終わりより先に届けば誤通知は出ない。PR 3 は「答えた後もターンが 9 秒より長く続く」場合を閉じる

---

## 7. 保留ブランチから流用するもの・捨てるもの

| 対象（`07610c745`） | 扱い | 理由 |
|---|---|---|
| `tests/unit/push/waiting-episode-close-no-browser-3798.test.ts` の UAT 1 回目・3/4 回目の再現、人が要る画面の陽性対照、閉じる edge は通知しない対照 | 流用（期待は同じ） | 再現の形が UAT と一致している |
| 同ファイルの session A/B の対照 | 流用（#1 の R 層） | 期待は同じ。判定の場所が変わるだけ |
| `tests/unit/polling/auto-yes-poller-close-answered-wait-3798.test.ts` の survey/picker・信頼確認・受信待ちの対照と、`detectSessionStatus(raw ?? clean).status === 'waiting'` で menu を守る考え方 | 流用（PR 3）。答えたかの判定は時刻から `lastAnsweredEpisodeId` に置き換える | 規則 3 と同じ。時刻の比較は規則 1 に反する |
| `tests/unit/push/waiting-episode-close-async-stop-3798.test.ts` の OpenCode / V2 の await を止める仕掛け | 流用（OC・V2 層の土台） | 期待は一部変わる（F の「A を閉じて B を開く」は、A が stop の同期区間で閉じ済みになる） |
| `tests/unit/lib/polling/response-checker-ended-turn-wait-3798.test.ts`・`tests/unit/lib/worktree-status-helper-ended-turn-wait-3798.test.ts` の本物の `checkForResponse` / status-helper を動かす仕掛け | 流用（RC・SH 層の土台） | 期待は ID で書き直す |
| `tests/unit/api/hooks-claude-done-delegation.test.ts` への追加（G の対照） | 流用（CD 層）。「hook の turn が開いていれば claude-done は閉じない」は捨てる | 開始 hook だけ併用の設定で閉じられなくなる（4.2）。hook stop の印で判定する |
| `#3796` との統合部分（`closeWaitAnsweredByPoller` と `refreshEpisodeSuppression` を両立させたマージの解き方） | 流用（PR 3） | 別関数で互いの中身を変えない形は保てる |
| `src/lib/session/waiting-episode-turn.ts`（`beganInAnEndedTurn`・`stopEndsWaitingEpisode`・`closeWaitingEpisodeOfEndedTurn`） | 捨てる | 区間が帰属を持たず、閉じる側が今の turn と時刻から推定している。破れ #6 は「turn の開始時刻 > since」の推定そのものから出た |
| `applyAgentStopEvent` の先頭での終了 | 捨てる | opencode・V2 では動的 import の await の後に呼ばれる（破れ #3・#7） |
| 保留ブランチの `stopTurnOutcomes` Map（`7b41cd6a8`、`66977a5a5` で撤去済み） | 捨てる | キー単位で 1 回消費する値は await を挟むと次の turn に読まれる。outcome は同期区間の戻り値として渡す |

---

## 8. 限界と未確認事項

### 限界（設計で閉じないもの）

- **claude-done の旧形式**: 識別子が無いので、B の区間が開いた後に届いた旧 A の claude-done は B に当たる（`target` が B を指す）。同じ世代に hook の stop が届いていれば印で止まるが、claude-done だけの設定では判別できない。また `target` を固定できるのは body の読み（`route.ts:34`）の後なので、body の読みの間に入れ替わった場合も同じ
- **session ID の無い hook**: `closesTurn` は片方の sessionId が null なら同じ session とみなす（`provisional-turn.ts:547-550`）。手で設定した relay など session ID を送らない hook では、破れ #1 の保護は効かない
- **stop-without-turn**: 開いている turn が無いときの stop は `unattributed` / `dialog-only` の区間を閉じる。その区間が、開始 hook がまだ届いていない別 session のものかは判別できない
- **観測の無い人待ち**: Auto-Yes が off（poller が無い）で、ブラウザも無いとき、回答の後に出た survey を誰も読まないまま stop が来ると、区間は `turn` のまま閉じる。次に status が問い合わされるまで開き直らない。Auto-Yes が off なら開いた時点で通知は出ている（gate は `auto-yes-inactive`）ので、失うのは「まだ待っている」の reminder と解除の正確さ
- **Service Worker の更新**: 端末の `sw.js` が更新されるまでは、解除は tag の全部を閉じる今の動き
- **プロセス再起動**: 区間はメモリにあり、再起動で消える（今の §6.2 の限界のまま）
- **`stale` で閉じた turn**: 読み出しで閉じるので遷移を出せない。その turn の区間は次の turn の開始か観測で閉じる

### 未確認

- agy で、確認のダイアログより前に `pre_tool_use` が届くか（区間が `turn` で開くか `unattributed` で開いて rebind されるか）。設計はどちらでも同じ結果になるようにしたが、実機の順序は見ていない
- claude-done と agent-event の Stop を両方つないだ claude で、どちらが先に届くかの頻度（保留ブランチ `66977a5a5` の本文にも未確認とある）
- opencode の質問 push（`src/lib/hooks/sources/opencode/push.ts:172`）が Auto-Yes の gate を通らないのが意図か。質問が Auto-Yes で答えられる種類かを確かめていない
- 保留ブランチのテストを develop（`4ec3c066b`）の上で動かしていない。流用するときに #3820 以降の変更（`noteToolCallEndedInLedger` 等）との差を確かめる必要がある
- 4.2 の各対照が develop の実装で落ちることは、実装の段で確かめる（この段ではテストを書いていない）

---

## 9. 本文に無い指摘（scope 外。直していない）

- `src/lib/push/waiting-push-notifier.ts:22-31` と `src/lib/session/waiting-episode-state.ts:14-18` の docblock は「`observeWaitingEdge` の呼び手は `worktree-status-helper` だけ」と書いているが、今は `response-checker`（`:941`・`:1465`）も呼ぶ。PR 1 で書き直す
- `src/lib/session/worktree-status-helper.ts:875-878`: capture が throw すると区間を閉じる（#1786 の決定）。規則 3 の「capture 失敗は消失と扱わない」と考え方が違う。既存テストの期待を変えないため、この設計では poller にだけ規則 3 を適用し、status-helper は `start` の照合を足すだけにした
- `src/lib/hooks/sources/opencode/push.ts:172`: 質問の push が区間を開かず、since の一致だけで status-helper の通知と束ねている。区間 ID の dedup に移すと束ねられなくなるので、PR 2 では since の互換を残す（5 章 4）
