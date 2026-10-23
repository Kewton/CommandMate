# Issue #3798 waiting の区間（WaitingEpisode）に ID と帰属を持たせる設計

- 対象 Issue: #3798（ブラウザを開いていないと agy の waiting の区間が閉じない）
- 版: 第 3 版（2026-10-24、レビュー 2 回目を反映）。第 1 版 `81f762b1e`、第 2 版 `dacf6c244`。土台は develop `4ec3c066b`
- 位置づけ: **設計書の段**。コードは 1 行も変えていない。この文書は次の段で実装の契約の入力になる
- 入力: Issue 本文、2026-10-19 のコメント（作り直しの設計 第 2 版: 破れ 7 件・規則 1〜8・追加の受入基準）、UAT 記録 `workspace/orchestration/runs/2026-10-18/uat-3788.md` 項目 D、保留ブランチ `fix/3798-waiting-interval-close-no-browser`（HEAD `07610c745`）、独立レビュー `workspace/orchestration/runs/2026-10-23/review-3798-design-1.md`（1 回目）・`review-3798-design-2.md`（2 回目）

## 0. 表記

- **[事実]** は develop のコードを読んで確かめたこと。参照は `path:line`（develop `4ec3c066b` 時点の行番号）
- **[見立て]** は推論。実機でもテストでも確かめていない
- **未確認** は調べたが確かめられなかったこと
- 「区間」は `WaitingEpisode`、「turn」は `TurnRecord`（`src/lib/session/provisional-turn.ts:309`）、「世代」は `generationStartedAt`（`src/lib/session/agent-event-turn.ts:51`）
- 「R1-N」「R2-N」はレビュー 1 回目・2 回目の指摘 N。「残る順序 R1-N」は 1 回目の「まだ破れる順序」、「割り込み R2-N」は 2 回目の「await の境界で割り込む順序」

この文書は型・不変条件・呼び出しの順序・同期区間の境界・失敗時の扱いを決める。関数本体は書かない。

---

## 1. 現状の調査

### 1.1 型

[事実]
- `WaitingEpisode` は `{ since: number; kind: WaitingKind | null }` だけ（`src/lib/session/waiting-episode-state.ts:70-81`）。ID も、どの turn・世代で開いたかも持たない
- 区間の置き場は `globalThis.__sessionWaitingEpisodes`（compositeKey → 区間、`waiting-episode-state.ts:64`）。インスタンスごとに高々 1 つ
- 遷移の通知は `WaitingTransition`（`waiting-episode-state.ts:84-97`）。区間の ID も「置き換え」も表せない
- 書き手は `observeWaitingEdge()`（`waiting-episode-state.ts:162-193`）。`waiting:false` なら区間を消して閉じる edge を出し、`waiting:true` で既存があれば `kind` だけ更新して `since` を返し、無ければ `structuredSince ?? now` で開く。テストの 18 ファイルがこの関数を直接呼ぶ（`grep -rln observeWaitingEdge tests`）
- `turnId` は `turn-<at>-<seq>`（`agent-event-turn.ts:144-147`）で、同一ミリ秒でも区別できる

### 1.2 区間を開く経路

| # | 経路 | 場所 | since | 備考 |
|---|---|---|---|---|
| O1 | status の問い合わせ（ブラウザ・`commandmate ls` 等） | `src/lib/session/worktree-status-helper.ts:884` | `frame.structuredWaitingSince`（= `peekPromptWaiting().structured.at`、`:688`）か now | 待ちの判定は scraper の status と構造化の decision の OR（`:663`） |
| O2 | 応答 poller が確認を検出 | `src/lib/polling/response-checker.ts:941`（`savePromptMessage`、`:814`） | `getWaitingEpisode()?.since ?? promptObservedAt`（`:910-912`） | 本文ハッシュの重複除外 `isDuplicatePrompt`（`:841`）を通ったものだけ。**push を先に出し（`:921-938`）、その後に区間を開く**。全画面 TUI（opencode・copilot、`:761`）でなければ直後に `stopPolling`（`:950-952`） |

[事実] `observeWaitingEdge` を本番のコードで呼ぶのはこの 2 箇所と、閉じる側の `response-checker.ts:1465` だけ。Auto-Yes poller・hook の受信・`applyAgentStopEvent` は区間に触れない。

### 1.3 区間を閉じる経路

| # | 経路 | 場所 | 条件 |
|---|---|---|---|
| C1 | status の問い合わせ | `worktree-status-helper.ts:884` | `frame.isWaitingForResponse === false`。session が動いていない・capture が throw（`:875-878`）・未分類の画面もすべて「待っていない」になる（`:542-545`）。「動いていない」は呼び手が先に取った tmux の一覧（`sessionNameSet`、`:816`）で決まる |
| C2 | 応答 poller が返答を記録 | `response-checker.ts:1465` | 返答を保存した tick の末尾。`mayStillActAfter(ctx,'conversation-log')`（`:1420`）の後、`await` なし |

[事実] `sessionNameSet` は呼び手（`src/app/api/worktrees/route.ts:138`、`src/app/api/worktrees/[id]/route.ts:67`）が `listSessions()` の await で取ったもの。Issue 本文の `response-checker.ts:1448` は develop では `:1465`（説明コメントは `:1457`）。

### 1.4 since を引き継ぐ経路

- [事実] O2 は開いている区間があればその `since` を自分の確認の since として使い（`response-checker.ts:911-912`）、gate（`:922-927`）と push（`:929-938`）に渡す
- [事実] O1 も既存の区間があれば `kind` を更新するだけ（`waiting-episode-state.ts:181-187`）

### 1.5 区間を読む側

| 読み手 | 場所 | 区間の何で識別するか |
|---|---|---|
| Auto-Yes の hold | `src/lib/push/prompt-push-gate.ts:172-190` | `hold.since !== input.waitingSince` で新しい hold（`:179`）。そのとき予約 tick を 1 回だけ読む（`:180`）。起点は `max(firstHeldAt, lastServerResponseTimestamp)`（`:188-189`） |
| 抑止記録の帰属 | `prompt-push-gate.ts:351-354` | `suppression.at >= waitingSince`（時刻） |
| 通知の dedup | `src/lib/push/notification-dedup.ts:132-143` | `WaitingPushRecord.since`（`:95-100`） |
| push の分岐 | `src/lib/push/push-sender.ts:585-591` | `waitingSince` があれば `shouldSendWaitingPush`。dedup は最初の `await` より前（`:611-619`） |
| 通知の保持・再判定・reminder | `src/lib/push/waiting-push-notifier.ts` | `PendingWait.since`（`:111-117`）。`releaseAutoYesHold`（`:289-305`）・`releaseHeldWait`（`:318-340`）・`runEscalationTick`（`:441-489`） |
| 解除通知 | `src/lib/push/resolution-push-notifier.ts:145` | `hasOpenWaitingEpisode(worktreeId)`（worktree 単位） |
| カードのマーク | `src/lib/push/prompt-card-state.ts` | worktree ごとに 1 行・1 文で書く（モジュールの docblock） |
| 端末側の解除 | `public/sw.js:186-208`・`:220-258` | `tag` の通知を全部閉じてから無音の置き換えを出す。**「閉じて何も出さない」分岐は持たない契約**（`userVisibleOnly:true`、`:170-183`） |
| WebSocket | `src/lib/realtime/waiting-broadcast.ts:74-76` | `transition.waiting` / `since` |
| relay | `src/lib/relay/relay-triggers.ts:134` | `transition.waiting && kind==='prompt'` |
| `commandmate wait` の抑止表示 | `src/cli/commands/wait.ts:245-264` | `autoYes.lastSuppression.at` が 60 秒以内か。区間を見ない（`wait.ts:234-237`） |
| opencode の質問 push | `src/lib/hooks/sources/opencode/push.ts:34-44`・`:172` | `waitingSince: askedAt`。区間を開かず、status-helper が後で同じ値で開くことに頼る |

### 1.6 turn model 側の事実

- `recordAgentEvent` は late `session_start` を保留したとき以外 `{ recorded: true }` を返す（`src/lib/session/agent-event-state.ts:346-401`）。turn が実際に閉じたか・拒否されたかは返さない。末尾は `fenceTurnForNewGeneration`（`session_start` のとき、`:395`）→ `applyTurnTransition`（`:399`）→ `applyAwaitingInstructionTransition`（`:400`）の順
- `session_start` は毎回 `generationStartedAt` を更新する（`:385`）。同じプロセスの最初の `SessionStart` でも新しい世代になる
- `applyTurnTransition`（`agent-event-turn.ts:466-519`）: 世代より前の event は捨てる（`:470`）。`user_prompt_submit` は turn を開いた後に `releaseAllDecisions`（`:476-477`）
- `applyStopToTurn`（`:687-713`）: 開いている turn に別 session の stop が来たら何もせず `return`（`:694`）。開いている turn が無ければ、session を見ずに `openedAt:null` の閉じた記録で上書きする（`:701-712`）
- `openTurn`（`:567-614`）: dialog だけの記録の decision は新しい turn に運ばれる（`:591-593`）。開いている同じ session の turn を印の無い prompt が置き換えたときは `reopenedTurns` に残す（`:609-613`）。置き換えの理由は #3330 の重複だけでなく中断後の再送もある（`:429-433`）
- `joinOpenTurnFromDuplicate`（`:650-675`）: queued notice の印つき複製で、置き換えた turn を元の ID で戻す
- `openDecision`（`:828-`）が作る dialog だけの記録は `sessionId: null`（`:846`・`:863`）。`idle_prompt` も turn が無ければ `openedAt:null, closedAt:null, pendingDecisions:[]` の表示だけの記録を作る（`:800-811`）
- `fenceTurnForNewGeneration`（`:347-368`）の呼び手は `recordAgentEvent` の `session_start`（`agent-event-state.ts:395`）と `beginAgentEventGeneration`（`:447`、呼び手は `src/lib/session/agent-session-lifecycle.ts:90`）
- `closesTurn` は片方の sessionId が null なら同じ session とみなす（`provisional-turn.ts:547-550`）
- turn は stop 以外でも閉じる: `observeScraperCompletionEvidence`（`agent-event-turn.ts:311-345`、呼び手 `current-output-builder.ts:1002`）が画面の `ready` を 3 回続けて読むと `scraper_evidence` で閉じる。`mayClose` を false にするのは codex だけ（`src/lib/detection/turn-abandoned.ts:43-46`、`src/lib/session/hook-turn-hold.ts:46-52`）。`effectiveTurn` は**読んだ時点で** `displayEvent.at` から 30 分を過ぎた turn を `stale` で閉じる（`agent-event-turn.ts:133-142`、`provisional-turn.ts:123`）。どちらも遷移の通知は無い

### 1.7 agy の hook の event（R2-1）

[事実] agy の source は `supportedEvents: ['session_start', 'post_tool_use', 'stop']`（`src/lib/hooks/sources/antigravity/source.ts:248`）。`UserPromptSubmit`・`Notification`・`SessionEnd` は「無い」（同 `:238-240`）。`PreToolUse` は `/api/hooks/permission-request` に向けられ、裁定するだけで記録しない（同 `:242-247`）。`permissionHookPredictsDialog: false`（同 `:259`）なので、裁定を見送っても dialog だけの記録は作られない（`src/lib/hooks/permission-decision-service.ts:455-461`）。

したがって agy の turn は **最初の `post_tool_use` で開く**（`applyTurnTransition` の `post_tool_use`、`agent-event-turn.ts:480` は `continueOpen:true` で、開いている turn が無ければ開く。#3437 の「stop の後の `pre_tool_use`」の除外は `promptOpensTurns` の source だけで、agy は当たらない）。turn の最初のツールで確認が出ると、その時点で turn model に開いている turn は無い。

### 1.8 recordAgentEvent の呼び手と await の位置

| 経路 | turn への記録（同期） | 記録の前後の await |
|---|---|---|
| `POST /api/hooks/agent-event`（agy・claude・codex 等） | `applyAgentEventToState` → `recordAgentEvent`（`src/lib/hooks/agent-event-intake.ts:340-398`） | 後: `await applyAgentStopEvent`（`src/app/api/hooks/agent-event/route.ts:177`）。route の `await` は `:73` と `:177` だけ |
| opencode ingest（一般） | `recordAgentEvent`（`src/lib/hooks/sources/opencode/ingest.ts:396`・`:414`） | 後: `await applyStop`（`:434`）→ 動的 import（`:253-257`）→ `applyAgentStopEvent`（`:268`） |
| opencode ingest（permission） | `recordAgentEvent`（`:386`） | **前**: `await adjudicatePermission`（`:385`） |
| opencode V2 ingest（permission） | `recordAgentEvent`（`src/lib/hooks/sources/opencode-v2/ingest.ts:233`） | **前**: `await adjudicatePermission`（`:232`）（R2-12） |
| opencode V2 ingest（question） | `recordAgentEvent`（`:253`） | **前**: `await readQuestion`（`:250`）（R2-12） |
| opencode V2 ingest（settled・stop・その他） | `recordAgentEvent`（`:240`・`:298`・`:301`） | stop は後: `await stopEffect`（`:299`）→ 動的 import（`:74-78`）→ `applyAgentStopEvent`（`:85`） |
| respond の構造化回答 | `recordAgentEvent(notification/permission_replied)`（`src/app/api/worktrees/[id]/respond/structured-decision.ts:712`） | 前: 回答の送信の await（`:631`・`:634`。`:712` が同じ関数の中かは未確認） |
| 構造化回答の配信 | 同上（`src/lib/hooks/structured-decision-response.ts:529`） | 前: 動的 import の await（`:528`） |
| decision の再確認 | 同上（`src/lib/hooks/pending-decision-recheck.ts:149`） | 前: 動的 import の await（`:148`） |
| `POST /api/hooks/claude-done`（識別子なしの旧形式） | **turn model に記録しない** | body の読み（`src/app/api/hooks/claude-done/route.ts:34`）→ capture（`:58`）→ ログ保存（`:72`）→ `applyAgentStopEvent`（`:100`） |

[事実] opencode の質問は `reportQuestionPending`（`opencode/ingest.ts:221`）が `recordAgentEvent` の外で decision を作る。`applyAgentStopEvent`（`src/lib/hooks/agent-event-service.ts:244-`）は区間に触れない。

### 1.9 画面の読み方

- [事実] agy の Auto-Yes poller は確認を `detectPromptOnCleanFrame` に受信の範囲（`receiptScope`）を渡して読む（`src/lib/auto-yes-poller.ts:682-711`）。窓の外では本物の確認でも `no_prompt` になる（`:957-991`）。status API・応答 poller・通知は範囲を渡さない（`:960-963`）
- [事実] `detectSessionStatus` の結果は `status`・`hasActivePrompt`・範囲を渡さない読みの `promptDetection` を持つ（`src/lib/detection/status-detector.ts:60-80`）
- [事実] `hasActivePrompt` と `promptDetection.isPrompt` は一致しないことがある: copilot の 4 択以上の `ask_user` は `isPrompt: true` なのに `positiveVerdictWithPrompt('waiting', COPILOT_SELECTION_LIST)`（`hasActivePrompt: false`）になる（`src/lib/detection/tools/copilot/detect.ts:82-94`、`src/lib/detection/tools/verdicts.ts:28-41`）。opencode の permission の帯は `positiveVerdict('waiting', OPENCODE_PERMISSION_PROMPT)` で promptDetection を持たない（`src/lib/detection/tools/opencode/detect.ts:141`）（R2-5）
- [事実] capture は `getOrFetchCapture` の 5 秒キャッシュと singleflight を通る（`src/lib/session/cli-session.ts:105-125`、`src/lib/tmux/tmux-capture-cache.ts:46`）。キャッシュの値はキャッシュに書いた時刻（`timestamp`）を持つが、`captureSessionOutput` は文字列だけを返す（R2-2・R2-9）

### 1.10 事象の説明（UAT 項目 D との対応）

[事実]（UAT 記録）1 回目: 09:28:14.804 に区間が開く → 15.119 に `response-sent` → 18.839 に stop → 24.121 に `prompt-push-allowed (auto-yes-not-answered)`。3・4 回目は `waitingSince` が 1 回目の値のまま、poller が答える前に `prompt-push-allowed`。UAT の記録に hook の到着順（`post_tool_use` が stop より前に来たか）は無い。

[見立て] agy の返答は hook で届くので C2 に来ず、ブラウザが無いので C1 も来ない。区間が開いたままなので、hold の終わりの再判定（`waiting-push-notifier.ts:289-305`）が `auto-yes-not-answered` を出し（1 回目）、次の確認で O2 が古い since を流用して即座に通知可になる（3・4・6・7 回目）。保留ブランチの最初のコミット `bfcf02c8f` がテストでこの 2 つの形を再現している（コミットメッセージ。この文書では再実行していない）。

---

## 2. 設計

### 2.1 方針

1. 区間は **ID・帰属（binding）・版** を持つ。同一性は ID だけで判定する。時刻は表示・経過時間と、**フレームが閉じる操作より前のものか** の比較だけに使う（規則 1）
2. turn の遷移（stop・開始・世代・session_end・復元・decision）は、**turn model を書き換えた `recordAgentEvent` の同期区間の末尾で**区間に作用する。後段の `await` の後では区間を操作しない（規則 2・8）
3. 画面の観測（status-helper・応答 poller・Auto-Yes poller）は **1 つの画面の読み方**（受信窓を見ない）と **1 つの観測関数** を使う。観測は始めた時点の版と、読んだフレームの capture の時刻を渡し、戻った時点で照合する（規則 3・4）
4. 帰属の違う区間への入れ替えは **1 つの操作**（`replaced`）にし、途中で「誰も待っていない」を出さない（規則 5）
5. push 側の hold・dedup・reminder・解除・抑止記録は区間 ID で照合し、ID の無い入力とは since で突き合わせる（規則 5・7）
6. **表の外の組み合わせは「区間の状態を変えない」**（開かない・閉じない・置き換えない・rebind しない、edge も出さない）。これを既定の動作とし、`waiting-episode-unmatched` を warn で出す。通知の側から見ると「閉じない」側に倒れる。開いている区間は reminder（10 分）と hold の再判定で人に届くので、閉じ忘れは通知が出る方向に、開き忘れは次の観測で直る方向に収束する

### 2.2 型

```ts
// src/lib/session/waiting-episode-state.ts（leaf: agent-event-* も binding も import しない）

/** プロセス内で一意。時刻を含めない（同一ミリ秒でも別）。 */
export type WaitingEpisodeId = string; // `wep-<bootNonce>-<seq>`

/** 世代の参照。「世代が開かれていない」を null と混ぜない。 */
export type GenerationRef = { kind: 'opened'; at: number } | { kind: 'none' };

export type EpisodeBinding =
  /** turn T の中の待ち。 */
  | { kind: 'turn'; generation: GenerationRef; turnId: string }
  /** 確認だけが先に来ている（dialog だけの記録で、pendingDecisions が 1 件以上）。 */
  | { kind: 'dialog-only'; generation: GenerationRef; recordTurnId: string; sessionId: string | null }
  /** 開いている turn も、decision を持つ dialog の記録も無いときに見えた待ち。
   *  lastClosedTurnId は開いた時点で最後に閉じていた turn（無ければ null）。 */
  | { kind: 'unattributed'; generation: GenerationRef; lastClosedTurnId: string | null }
  /** 画面固有の人待ち。originTurnId は screen になる前の帰属が turn だったときだけ。 */
  | { kind: 'screen'; generation: GenerationRef; originTurnId: string | null };

export interface WaitingEpisode {
  episodeId: WaitingEpisodeId;
  since: number;                 // 表示・経過時間用。同一性に使わない
  kind: WaitingKind | null;
  binding: EpisodeBinding;
  openedBy: WaitingObserver;
  promptScreenKey: string | null; // 開いた（または replaced した）ときの確認の画面キー
}

/** compositeKey ごとの単調な版。開く・閉じる・置き換え・rebind のたびに 1 増える（kind の更新では増えない）。 */
export type EpisodeVersion = number;

/** compositeKey ごとの「最後に区間を閉じた・置き換えた時刻」（Date.now()）。フレームの新旧の比較だけに使う。 */
export type LastClosedAt = number | null;

export type WaitingCloseReason =
  | 'turn-stop' | 'turn-session-end' | 'turn-superseded' | 'decision-settled' | 'generation'
  | 'screen-cleared' | 'session-gone' | 'response-recorded' | 'poller-answered' | 'legacy-stop';

export interface WaitingTransition {
  worktreeId: string; cliToolId: CLIToolType; instanceId: string | undefined;
  waiting: boolean;          // opened/replaced: true、closed: false
  since: number | null;
  kind: WaitingKind | null;
  at: number;
  cause: 'opened' | 'closed' | 'replaced';
  episodeId: WaitingEpisodeId | null;
  previousEpisodeId: WaitingEpisodeId | null;
  closeReason: WaitingCloseReason | null;
}

/** 低水準の書き込み（binding モジュールだけが呼ぶ）。 */
export function openEpisode(...): WaitingEpisode;
export function closeEpisode(key, expectedId: WaitingEpisodeId, reason: WaitingCloseReason, at: number): boolean;
export function replaceEpisode(key, expectedId: WaitingEpisodeId, next: NewEpisode, reason: WaitingCloseReason, at: number): WaitingEpisode | null;
export function rebindEpisode(key, expectedId: WaitingEpisodeId, binding: EpisodeBinding): boolean;
export function getEpisodeVersion(key): EpisodeVersion;
export function getLastClosedAt(key): LastClosedAt;

/** 既存の呼び手とテスト（18 ファイル）のための互換。binding は登録された resolver で決め、
 *  無ければ { kind: 'unattributed', generation: { kind: 'none' }, lastClosedTurnId: null }。 */
export function observeWaitingEdge(params: ObserveWaitingEdgeParams): number | null;
export function registerEpisodeBindingResolver(resolver: EpisodeBindingResolver): void;
```

state は leaf のまま。binding モジュールが起動時に resolver を登録する（globalThis 経由。`next dev` で bundle が分かれても 1 つ: #1736 と同じ理由）。これで state → binding の import が無く、循環ができない（R2-10）。本番の呼び手（status-helper・response-checker・Auto-Yes poller）は binding の `observeWaiting` を直接呼ぶ。

turn model の結果:

```ts
// src/lib/session/agent-event-turn.ts
export type OpeningEvent = 'user_prompt_submit' | 'pre_tool_use' | 'post_tool_use';

export type PreviousTurn =
  | { kind: 'none' }
  | { kind: 'dialog-only'; turnId: string; decisions: number; sessionId: string | null }
  | { kind: 'display-only'; turnId: string }            // idle_prompt の表示だけの記録（decision 0 件）
  | { kind: 'open-same-session'; turnId: string }
  | { kind: 'open-other-session'; turnId: string }
  | { kind: 'closed'; turnId: string; closedBy: TurnCloseReason };

export type TurnTransitionOutcome =
  | { kind: 'none' }
  | { kind: 'opened'; turnId: string; event: OpeningEvent; generation: GenerationRef; previous: PreviousTurn }
  | { kind: 'continued'; turnId: string }
  | { kind: 'restored'; restoredTurnId: string; discardedTurnId: string }
  | { kind: 'stopped'; turnId: string; generation: GenerationRef }
  | { kind: 'stop-without-turn'; recordTurnId: string; generation: GenerationRef; previous: PreviousTurn }
  | { kind: 'stop-rejected'; reason: 'other-session' | 'before-generation' }
  | { kind: 'session-ended'; turnId: string }
  | { kind: 'session-end-rejected'; reason: 'other-session' | 'no-turn' | 'before-generation' }
  | { kind: 'decision-opened'; recordTurnId: string; recordKind: 'dialog-only' | 'turn' }
  | { kind: 'decisions-released'; recordTurnId: string; recordKind: 'dialog-only' | 'turn'; before: number; remaining: number }
  | { kind: 'generation-fenced'; source: 'process-start' | 'session-start'; generation: GenerationRef; fencedTurnId: string | null };

// src/lib/session/agent-event-state.ts
export type AgentEventRecordOutcome =
  | { recorded: true; turn: TurnTransitionOutcome[]; episode: EpisodeEffect[] }
  | { recorded: false; skipped: 'late-session-start' };
```

`process-start` は `beginAgentEventGeneration`（CommandMate が session を作った）、`session-start` は hook の `SessionStart`（同じプロセスの最初の `SessionStart` や `/clear` を含む）。

turn model の変更（R1-6）:
- `openDecision` の入力に `sessionId: string | null` を足し、dialog だけの記録を新しく作るときに入れる
- `applyStopToTurn` の `:701` の分岐で、上書きされる記録が dialog だけ（decision 1 件以上）で、その sessionId と stop の sessionId が両方 non-null かつ異なるときは、上書きせず `stop-rejected(other-session)` を返す

観測:

```ts
// src/lib/detection/waiting-screen-reading.ts（新設。detection 層。polling を import しない）
export type ScreenReading =
  | { kind: 'waiting'; waitingKind: WaitingKind | null; humanHeld: boolean;
      promptData: PromptData | null; structuredSince: number | null }
  | { kind: 'not-waiting' }
  | { kind: 'unknown' }   // capture 失敗・分類できない画面
  | { kind: 'gone' };     // session が動いていない
export function readWaitingScreen(input: {
  cliToolId: CLIToolType; output: string; lastOutputTimestamp?: Date;
  structuredWaiting: boolean; structuredSince: number | null;
}): ScreenReading;

// src/lib/detection/prompt-screen-key.ts（新設。partialAnswerScreenKey を移し、
// src/lib/polling/auto-yes-poller-state.ts:180 は re-export する）
export function promptScreenKey(promptData: PromptData): string;

// src/lib/session/waiting-episode-binding.ts（新設）
export interface ObservationStart {
  generation: GenerationRef;
  version: EpisodeVersion;
}
export interface WaitingObservation {
  worktreeId: string; cliToolId: CLIToolType; instanceId?: string;
  observer: 'status-probe' | 'response-checker' | 'auto-yes-poller';
  start: ObservationStart;
  reading: ScreenReading;
  /** 読んだフレームの capture を始めた時刻（キャッシュ当たりならそのキャッシュの値を取りに行き始めた時刻）。 */
  frameCapturedAt: number;
  /** response-checker が isDuplicatePrompt を通した新しい確認として保存する／Auto-Yes poller が答えを送る直前。 */
  freshPrompt?: boolean;
  /** Auto-Yes poller の最後の答え（呼び手が渡す。binding は polling を import しない）。 */
  lastAnswer?: { episodeId: WaitingEpisodeId; screenKey: string } | null;
  now?: number;
}
export type ObservationAction = 'opened' | 'kept' | 'rebound' | 'replaced' | 'closed' | 'ignored';
export function startWaitingObservation(worktreeId, cliToolId, instanceId?): ObservationStart;
export function planWaitingObservation(obs: WaitingObservation): WaitingObservationPlan;   // 純粋
export function commitWaitingObservation(plan: WaitingObservationPlan): ObservationAction;
export function observeWaiting(obs: WaitingObservation): WaitingObservationPlan;          // plan + commit

export function applyTurnOutcomesToEpisode(key: CompositeKeyParts, outcomes: TurnTransitionOutcome[], at: number): EpisodeEffect[];
export function captureLegacyStopTarget(worktreeId, cliToolId, instanceId): LegacyStopTarget;
export function settleLegacyStop(worktreeId, cliToolId, instanceId, target: LegacyStopTarget):
  'closed' | 'target-gone' | 'hook-authority' | 'screen' | 'nothing-open';
```

`captureSessionOutput` に capture の時刻を返す版（`captureSessionOutputWithMeta(): { output, capturedAt }`）を足す。キャッシュの値には、その値を取りに行き始めた時刻を持たせる（`tmux-capture-cache.ts` の `CacheEntry` に `fetchStartedAt`）。既存の `captureSessionOutput` の戻り値は変えない。

Auto-Yes poller の状態（PR 3）: `lastAnswer?: { episodeId: WaitingEpisodeId; screenKey: string; at: number }`（`src/lib/polling/auto-yes-poller-state.ts`。#3796 の欄には触らない）。

stop の権限（規則 6）: `__waitingHookStopGeneration: Map<compositeKey, GenerationRef>`。`stopped` / `stop-without-turn` を処理したとき、その世代を書く。

### 2.3 不変条件

- **I1** 1 インスタンスに開いている区間は高々 1 つ。区間 ID は再利用しない
- **I2** 区間の `episodeId`・`since` は開いてから閉じるまで変わらない。変わるのは `kind` と `binding` だけ（rebind）
- **I3** rebind は edge を出さない。hold・dedup・reminder は区間 ID に付くので、rebind で延びも縮みもしない
- **I4** `closed` の edge は「その区間が終わった」ことだけを言う。置き換えでは出さない（`replaced` を 1 回だけ出す）
- **I5** 区間を開く・閉じる・置き換える・rebind するのは次のどれかの同期区間だけ:
  - (a) `recordAgentEvent` の末尾（turn model を書き換え終えた後）の `applyTurnOutcomesToEpisode`、または `beginAgentEventGeneration`・`joinOpenTurnFromDuplicate` の呼び手の同期区間
  - (b) 観測の `commitWaitingObservation` で、`start.generation` と `start.version` が今と同じとき
  - (c) claude-done の `settleLegacyStop` で、`target.episodeId` が今の区間 ID と同じとき
  - (d) 例外: `freshPrompt: true` の観測は、版が違っても今の状態で plan し直して適用する。**ただし `frameCapturedAt > lastClosedAt` のときだけ**（R2-2）。そうでなければ `ignored`。世代が違えば `ignored`
- **I6** 観測が区間を開く・置き換える・rebind するのは `frameCapturedAt > lastClosedAt` のときだけ（観測者を問わない）。閉じる操作より前に capture したフレームで、閉じた後の区間を作らない（R2-2・R2-9）。閉じる観測は版の照合（I5 (b)）で縛る
- **I7** 区間の `binding.generation` が今の世代と違えば前のプロセスのもの。`process-start` の世代更新で閉じる
- **I8** `screen` の区間は turn の遷移（stop・session_end・開始・decision）と `session-start` の世代更新では閉じない。閉じるのは観測（`not-waiting`/`gone`）と `process-start` の世代更新だけ（R2-8）
- **I9** `humanHeld` は `readWaitingScreen` だけが決める。受信窓を見る読みを使わない
- **I10** `kept` は版を変えず、照合なしに `kind` だけを更新できる
- **I11** 表の外の組み合わせは「区間の状態を変えない」（2.1 の 6）

### 2.4 規則ごとの落とし込み

#### 規則 1（ID と帰属）・humanHeld の定義

開く時点の binding は turn model から同期で決める（`getAgentTurn` の fence 込み）:

| 開く時点の turn model | binding |
|---|---|
| 開いている turn | `turn`（その `turnId`） |
| `openedAt===null && closedAt===null` で `pendingDecisions.length > 0` | `dialog-only` |
| 上記で decision 0 件、閉じた turn、記録なし | `unattributed`（最後に閉じた turn があれば `lastClosedTurnId` に。表示だけの記録はその turnId） |
| 読みが `humanHeld: true` | 上の結果に関わらず `screen`（上の結果が `turn(T)` なら `originTurnId: T`） |

`humanHeld`（R2-5 で定義を変えた）= 次のすべて:
1. `detectSessionStatus(output, cliToolId, lastOutputTimestamp).status === 'waiting'`
2. 同じ結果の `promptDetection.isPrompt === false`（範囲を渡さない読み。`hasActivePrompt` ではない。copilot の 4 択以上の `ask_user` は `isPrompt: true` なので人待ち画面にならない）
3. 構造化の待ち（`peekPromptWaiting().structured`）が無い（opencode の permission の帯は decision の記録があるので人待ち画面にならない）

#### 規則 2・4・8: turn の遷移の作用表（`applyTurnOutcomesToEpisode`）

`recordAgentEvent` は fence の結果と遷移の結果を配列に集め、**`applyAwaitingInstructionTransition`（`agent-event-state.ts:400`）の後（関数の末尾）**で順に `applyTurnOutcomesToEpisode` に渡す（R2-13）。edge の listener は turn model を書き換え終えた状態を読む。

列の記号（すべて今の世代。世代が違う区間は列 I）:

| 記号 | 開いている区間 |
|---|---|
| A | なし |
| B | `turn(X)`（X は行の対象の turn） |
| C | `turn(Y)`（Y ≠ X） |
| D | `dialog-only(R)`（R は行の対象の記録） |
| E | `dialog-only(R')`（R' ≠ R） |
| F | `unattributed(lastClosedTurnId = P)`（P は行の `previous` の turnId。`previous` が none なら null） |
| G | `unattributed`（F 以外） |
| H | `screen` |
| I | `binding.generation` が今と違う |

動作の記号: **閉**=閉じる（理由は行に書く）、**付**=rebind（行に書く binding へ）、**－**=何もしない。

| # | outcome | A | B | C | D | E | F | G | H | I |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | `opened(N, event=post_tool_use/pre_tool_use, previous=closed(P))` | － | －※1 | 閉 superseded（C=turn(P)） | －※1 | 閉 superseded | 付 turn(N) | 閉 superseded（R2-4） | － | 閉 generation |
| T2 | `opened(N, event=post/pre, previous=dialog-only(R))` | － | －※1 | 閉 superseded | 付 turn(N) | 閉 superseded | 閉 superseded※2 | 閉 superseded | － | 閉 generation |
| T3 | `opened(N, event=post/pre, previous=display-only(P) / none)` | － | －※1 | 閉 superseded | －※1 | 閉 superseded | 付 turn(N) | 閉 superseded | － | 閉 generation |
| T4 | `opened(N, event=user_prompt_submit, previous=closed/dialog-only/display-only/none)` | － | －※1 | 閉 superseded | 閉 superseded | 閉 superseded | 閉 superseded（R2-4） | 閉 superseded | － | 閉 generation |
| T5 | `opened(N, previous=open-same-session(P) / open-other-session(P))` | － | －※1 | 閉 superseded（R1-9） | －※1 | 閉 superseded | 閉 superseded | 閉 superseded | － | 閉 generation |
| T6 | `continued(T)` | － | － | － | － | － | － | － | － | － |
| T7 | `restored(R, discarded N)` | － | 付 turn(R)（B=turn(N)） | － | － | － | － | － | － | － |
| T8 | `stopped(T)` | － | 閉 turn-stop | － | － | － | － | － | － | 閉 generation |
| T9 | `stop-without-turn(previous=closed(X, 理由は問わない))` | － | 閉 turn-stop（B=turn(X)、R1-2） | － | － | － | 閉 turn-stop（F は lastClosed=X、R2-1） | － | － | 閉 generation |
| T10 | `stop-without-turn(previous=dialog-only(R))`（session の照合を通ったもの） | － | － | － | 閉 turn-stop | － | 閉 turn-stop | 閉 turn-stop | － | 閉 generation |
| T11 | `stop-without-turn(previous=display-only(P) / none)` | － | － | － | － | － | 閉 turn-stop | － | － | 閉 generation |
| T12 | `stop-rejected(*)` | － | － | － | － | － | － | － | － | － |
| T13 | `session-ended(T)` | － | 閉 session-end | － | － | － | － | － | － | 閉 generation |
| T14 | `session-end-rejected(*)` | － | － | － | － | － | － | － | － | － |
| T15 | `decision-opened(R, recordKind=dialog-only)` | － | － | － | － | － | 付 dialog-only(R)※3 | 付 dialog-only(R)※3 | － | － |
| T16 | `decision-opened(R, recordKind=turn)` | － | － | － | － | － | － | － | － | － |
| T17 | `decisions-released(R, before>0, remaining=0)` | － | 閉 decision-settled（B=turn(R)） | － | 閉 decision-settled | － | － | － | － | － |
| T18 | `decisions-released(remaining>0 または before=0)` | － | － | － | － | － | － | － | － | － |
| T19 | `generation-fenced(source=process-start)` | － | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 閉 generation |
| T20 | `generation-fenced(source=session-start)` | － | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 付（generation を新しい世代に。R2-8） | 閉 generation |
| T21 | `none` | － | － | － | － | － | － | － | － | － |

- ※1 起こらない組み合わせ（新しく開いた turn N の区間は遷移の前には無い。T1・T3・T5 の D は `previous` が dialog だけの記録でないので、列 D の R が無い）。起きたら既定（I11）。T4 の D は `previous=dialog-only(R)` のときの R の区間で、`user_prompt_submit` が decision を捨てるので閉じる
- ※2 `unattributed` の区間が開いた後に dialog だけの記録ができたなら T15 で `dialog-only` に付いているはずなので、ここに残る `unattributed` は別の待ち
- ※3 `unattributed` の区間に後から decision が記録された（scraper が先に読んだ確認に hook が追いついた）。同じ待ちとみなす
- T1・T3 の F の rebind は「確認が turn より先に来た」形（agy の最初のツールの確認、開始 hook の遅れ）だけ。`lastClosedTurnId` が `previous` と一致する（間に別の turn が無い）ことと、開いた event が `post_tool_use`/`pre_tool_use` であることの両方が条件（R2-4）
- T4（`user_prompt_submit`）は区間を閉じる。turn model もこのとき decision を全部捨てる（`agent-event-turn.ts:476-477`）
- T17 は decision に API や hook で答えたとき（opencode の `adjudicatePermission`、respond の構造化回答）。答えた区間は閉じる（R2-11・R2-14）
- T20 で `screen` を閉じないのは、同じプロセスの最初の `SessionStart` が信頼確認などの画面の後に届いても閉じ直さないため。画面が消えていれば観測が閉じる
- 戻り値 `EpisodeEffect[]` を `AgentEventRecordOutcome` 経由でログに出す（`agent-event-stop-applied` に `episodeEffect`）

#### 規則 3・4・5: 観測の作用表（`planWaitingObservation`）

前提の照合（表より先に評価する）:
1. `start.generation` が今と違う → `ignored`
2. 動作が `kept` 以外で、`start.version` が今と違う → `ignored`（`freshPrompt` は I5 (d) で plan し直す）
3. 動作が「開く・置き換え・rebind」で、`frameCapturedAt <= lastClosedAt` → `ignored`（I6）

読みの候補（`c`）は、読みが `waiting` のとき規則 1 の表で決めた binding。`k` は読みの確認の画面キー（`promptData` があれば `promptScreenKey(promptData)`、無ければ null）。

| 開いている区間 ＼ 読み | `waiting`・humanHeld=false | `waiting`・humanHeld=true | `not-waiting` | `unknown` | `gone` |
|---|---|---|---|---|---|
| なし | opened（binding=c） | opened（screen） | ignored | ignored | ignored |
| `turn(T)`・T は開いている | c=turn(T): **kept**。ただし `freshPrompt` かつ `lastAnswer.episodeId`=今の ID かつ `k`≠null かつ `k`≠`lastAnswer.screenKey` なら **replaced**（R1-7）。c=turn(N≠T): replaced | 付 screen(origin T) | 閉※4 | ignored | 閉 session-gone |
| `turn(T)`・T は閉じている（stop 以外） | c=turn(N≠T): replaced。c=dialog-only/unattributed: `freshPrompt` かつ `k`≠null かつ `k`≠区間の `promptScreenKey` なら replaced、それ以外は **kept**（R2-3） | 付 screen(origin T) | 閉※4 | ignored | 閉 session-gone |
| `dialog-only(R)` | c=dialog-only(R): kept。c=turn(N): 付 turn(N)。c=dialog-only(R'≠R): replaced。c=unattributed: kept | 付 screen(origin null) | 閉※4 | ignored | 閉 session-gone |
| `unattributed` | c=unattributed: kept（ただし `freshPrompt` かつ `lastAnswer.episodeId`=今の ID かつ `k`≠null かつ `k`≠`lastAnswer.screenKey` なら replaced）。c=dialog-only(R): 付 dialog-only(R)。c=turn(N): `k`≠null かつ `k`=区間の `promptScreenKey` なら 付 turn(N)、それ以外は replaced（R2-4） | 付 screen(origin null) | 閉※4 | ignored | 閉 session-gone |
| `screen(origin O)` | c=turn(O): 付 turn(O)（R1-1）。それ以外: replaced | kept | 閉※4 | ignored | 閉 session-gone |

- ※4 `not-waiting` で閉じる理由と条件は観測者で違う:
  - status-helper: `screen-cleared`（版の照合つき。capture 失敗は status-helper が従来どおり `not-waiting` として渡す: §9）
  - response-checker（C2）: `response-recorded`
  - Auto-Yes poller: 次の 2 つを満たすときだけ `poller-answered` で閉じ、満たさなければ `ignored`。(1) `lastAnswer.episodeId` が今の区間 ID と同じ。(2) 区間が `screen` でない（`screen` の区間を poller の「確認が無い」で閉じない）
- `unknown` は観測者を問わず `ignored`。表の外は既定（I11）

規則 5（置き換え）の残り:
- `replaced` は、古い区間を消して新しい区間を置き、`cause:'replaced'` の遷移を **1 回だけ** 出す。`closed` は出さないので解除通知は呼ばれず（`waiting-push-notifier.ts:395` は `cause==='closed'` のときだけ）、WebSocket は `waiting:true` の新しい since だけを送る。`lastClosedAt` は置き換えでも更新する
- 新しい区間の since: 読みの `structuredSince` が新しい binding に属するならそれ、そうでなければ観測時刻
- 解除通知の照合:
  - prompt の push の `data` に `episodeId` を入れる
  - `prompt-card-state` のマークの値に、最後に通知した区間 ID 1 つを時刻と一緒に 1 文で入れる（R1-11）。時刻だけの旧形式の値は「ID なし」として読む
  - 解除の push に `resolvedEpisodeId`（マークの ID。無ければ欠く）を入れる
  - `public/sw.js` は解除を受けたら、同じ tag の通知のうち `data.episodeId` が `resolvedEpisodeId` と等しいもの、または `episodeId` を持たないものを閉じ、無音の置き換えを出す。`data.episodeId` が違う通知が残っていれば、それを閉じてから同じ内容で `silent:true`・`renotify:false` で出し直す。どの分岐でも `showNotification` を必ず 1 回呼ぶ（R1-5）
  - `resolvedEpisodeId` の無い解除は今の動き

#### 規則 6（claude-done の保証範囲）

- 区間・世代は **worktree を引いた直後（`claude-done/route.ts:47` の後、`:58` の await の前）** に `captureLegacyStopTarget` で固定する。最初の `await` は body の読み（`:34`）だが、worktreeId は body の中にあるので、その前には固定できない
- `:72` の await の後、`:100` の前に `settleLegacyStop` を同期で呼ぶ。閉じるのは次のすべてを満たすとき: (1) 今の世代が `target.generation` と同じ (2) 今の区間 ID が `target.episodeId`（null でない）と同じ (3) 今の世代に hook の stop の印が無い (4) 区間が `screen` でない
- 開始 hook だけを併用する設定では、区間は `turn(T)` に付き、hook の stop の印が無いので claude-done が閉じる。前の世代の hook の記録は印に数えない（破れ #5）
- route の変更は `no-claude-fallback` guard の baseline（`tests/unit/guards/no-claude-fallback.test.ts:258-291`、追加禁止）に触れないよう、`'claude'` の文字列を新しい呼び出しの引数に書かない

#### 規則 7

5 章にまとめる。

#### 規則 8 の残り

- C2（`response-checker.ts:1465`）は `observeWaiting({ observer:'response-checker', reading:{kind:'not-waiting'}, start })`。`start` は tick の最初の `await`（`:1533`）の前に読む。`tests/unit/guards/retired-tick-write-guard-3705.test.ts` の対象一覧に新しい関数名を足す
- O2（`savePromptMessage`）は `planWaitingObservation({ freshPrompt: true })` で区間（ID・since）を決め、その ID・since で gate と push を出し、同じ同期区間で `commitWaitingObservation` する。`savePromptMessage` は同期関数（`:814`）で、`notifyPushSubscribers` の dedup は最初の `await` より前（`push-sender.ts:611-619`）
- `closeAgentTurn`・`observeScraperCompletionEvidence`・`effectiveTurn` の `stale` は遷移を出さない。その turn に付いた区間は、後から届く stop（T9）、次の turn の開始（T1）、観測（`turn(T)`・T は閉じている の行）のどれかで閉じる。**観測が stale を書いた直後でも、候補が別の turn か画面キーが違う確認でなければ置き換えない**（R2-3）
- permission_replied の経路（`structured-decision.ts:712`・`structured-decision-response.ts:529`・`pending-decision-recheck.ts:149`・opencode・V2）は記録の前に await があるが、区間の操作は `recordAgentEvent` の末尾で今の turn model に対して行い、時刻で照合しない

### 2.5 同期区間の境界（経路ごと）

| 経路 | 固定する時点（最初の await の前） | 区間を操作する同期区間 | await の後にしないこと |
|---|---|---|---|
| agent-event route | — | `recordAgentEvent` の末尾。重複破棄の復元は `dropDuplicateAgentEvent`（`agent-event-intake.ts:300-`）の中 | `applyAgentStopEvent`（`route.ts:177`）で触れない |
| opencode ingest | — | `recordAgentEvent`（`:386`・`:396`・`:414`）の末尾 | `applyStop`（`:434`）で触れない |
| V2 ingest | — | `recordAgentEvent`（`:233`〜`:301`）の末尾 | `stopEffect`（`:299`）で触れない |
| permission_replied の 3 経路 | — | `recordAgentEvent` の末尾 | — |
| 世代更新（process-start） | — | `beginAgentEventGeneration` の中 | — |
| claude-done | `captureLegacyStopTarget`（`:47` の後） | `settleLegacyStop`（`:72` の後、`:100` の前） | `:100` 以降で触れない |
| status-helper | 呼び手が `listSessions()` を呼ぶ前（`worktrees/route.ts:138` の前、`[id]/route.ts:67` の前）に worktree の全インスタンス分の `ObservationStart` を取り、`detectWorktreeSessionStatus` に渡す（R1-8）。渡されなければ `detectInstanceSessionStatus` の冒頭で取る | `observeWaiting`（`:884` の位置）。`frameCapturedAt` は `captureSessionOutputWithMeta` から | — |
| 応答 poller | `start`（`checkForResponse` の `:1533` の前） | O2: `savePromptMessage` の中、C2: `:1465` の位置 | — |
| Auto-Yes poller | `start`（tick の capture の await の前。`auto-yes-poller.ts:1172` 付近） | 答えの送信を始める同期区間（`freshPrompt` の観測と `lastAnswer` の書き込み、PR 3）、`no_prompt` を返す直前（`:991` 付近）の `observeWaiting`（screen の open/rebind は PR 1b、閉じるのは PR 3） | — |

### 2.6 失敗時の扱い

- listener が throw しても区間の状態は変わらない（`waiting-episode-state.ts:114-128` の封じ込めを維持）
- `applyTurnOutcomesToEpisode` が throw しても turn の記録は済んでいる。内部で握り、`waiting-episode-turn-sync-failed` を warn で出す
- 区間の listener は `recordAgentEvent` を同期で呼ばない（turn model へ同期で戻らない）。今の listener（`waiting-push-notifier`・`waiting-broadcast`・`relay-triggers`）がそうであることは実装の段で確かめる（未確認）
- capture 失敗: Auto-Yes poller は `unknown`。status-helper は従来どおり `not-waiting`（版の照合つき）
- `captureSessionOutputWithMeta` がキャッシュの時刻を返せない場合（旧い値）は `frameCapturedAt` を `0` とし、開く・置き換え・rebind を見送る側に倒す（ただし `lastClosedAt === null` なら開ける）
- 閉じる listener（解除の判定で `app_settings` を読む）が hook の route の同期区間で走るようになる。解除の送信は `void` で切り離されている（`waiting-push-notifier.ts:395`）ので、待たせるのは `decidePromptResolution` の同期部分だけ
- プロセス再起動で区間は消える（今の §6.2 の限界）

---

## 3. 破れの順序がどこで閉じるか

### 3.1 agy の実際の event の組での基本の流れ（UAT の形）

agy は `user_prompt_submit` を出さず、turn は最初の `post_tool_use` で開く（1.7）。前の turn を P とする（最初の turn なら P は無い）。

| 手順 | event / 観測 | turn model | 区間 |
|---|---|---|---|
| 1 | `send` で「ls を実行して」 | 変化なし（P は stop で閉じている） | なし |
| 2 | agy が `PreToolUse` → permission-request（記録しない） | 変化なし | なし |
| 3 | 確認が画面に出る → RC（O2）または Auto-Yes poller（PR 3）が読む | 開いている turn なし | opened `unattributed(lastClosedTurnId=P)`（P が無ければ null） |
| 4 | Auto-Yes が答える（PR 3 では `lastAnswer` に区間 ID） | — | — |
| 5a | `post_tool_use` | `opened(N, post_tool_use, previous=closed(P,'stop'))` | T1・F → 付 `turn(N)` |
| 6a | `stop` | `stopped(N)` | T8・B → 閉 turn-stop |
| 5b | （`post_tool_use` が届かない）`stop` | `stop-without-turn(previous=closed(P,'stop'))` | T9・F → 閉 turn-stop（R2-1） |
| 7 | 次の「ls を実行して」の確認 | — | 区間が無いので新しい ID・since で opened → 新しい hold |

最初の turn（P なし）では 3 が `unattributed(lastClosedTurnId=null)`、5a は `previous=none` で T3・F、5b は T11・F で閉じる。どの経路でも hold の終わり（約 9 秒）より前に stop が届けば `prompt-push-allowed` は出ない（UAT 1 回目の stop は答えの約 3.7 秒後）。stop が 9 秒より遅く、答えた後の画面が `not-waiting` なら、PR 3 の Auto-Yes poller が閉じる。

### 3.2 保留ブランチで見つかった破れ 7 件

| # | 再現の順序（agy の event の組で書けるものは agy で） | 以前に起きたこと | この設計で閉じる場所 |
|---|---|---|---|
| 1 | ① 同じ instance で新 session B の turn が開き、B の確認で区間 `turn(B)` が開く（claude: `user_prompt_submit` / agy: `post_tool_use`） ② 旧 session A の stop | turn は拒否するのに区間は閉じた | ② は `:694` で拒否 → `stop-rejected` → T12。B が dialog だけの記録（session ID あり）なら `:701` の分岐も拒否 |
| 2 | ① agy の確認（`unattributed(P)`）に Auto-Yes が答える ② `post_tool_use`（T1 で `turn(N)`） ③ survey など番号の無い menu ④ Auto-Yes poller の tick（PR 1b）・status-helper が menu を読む ⑤ stop | 人が要る menu の区間を閉じた | ④ の読みは `humanHeld:true`（status waiting・isPrompt false・構造化の待ちなし）→ 付 `screen(origin N)` → ⑤ は T8 の H で何もしない。④ が ⑤ より後なら、⑤ で閉じた後に ④ が新しい区間を `screen` で開く（`frameCapturedAt > lastClosedAt` のとき）→ 9 秒で通知可 |
| 3 | ① A の stop を記録 ② 後段の await（route `:177` / opencode `:434` / V2 `:299`） ③ B の確認で区間が開く ④ A の後段が戻る | B の区間を閉じた | A の区間は ① の `recordAgentEvent` の末尾で閉じ済み。④ は区間を操作しない |
| 4 | ① A の区間が開いたまま ② A の stop・await ③ B の確認 | B が A の since を引き継いだ | A の区間は ② の同期区間で閉じる（T8/T9/T11）。A が `screen` で残っていれば ③ の観測は replaced（新しい ID・since・hold、dedup も ID で別） |
| 5 | ① 前の世代で hook の記録 ② 世代更新 ③ 現世代は claude-done だけ | 互換 stop で閉じられなくなった | ② で前世代の区間は閉じる（T19/T20）。③ の `settleLegacyStop` は今の世代の印だけを見る |
| 6 | ① turn 未作成で確認（agy の最初のツール: `unattributed(P)`） ② 遅い開始 hook（agy: `post_tool_use`） ③ 取得を繰り返す | 取得のたびに閉じ直した | ② は T1・F で rebind（同じ ID・since・hold）。③ の観測は `turn(N)` の行で kept |
| 7 | ① A の stop を記録 ② await ③ 世代更新 ④ 開始 hook 前の B が人待ち ⑤ A の後段が戻る | B の区間を閉じた | A の区間は ① で閉じ済み。⑤ は区間を操作しない。① が ③ より後に届けば `before-generation` で T12 |

### 3.3 レビュー 1 回目の残る順序 8 件

| # | 順序 | 閉じる場所 |
|---|---|---|
| 1 | agy の poller が受信窓の外で確認を読む → stop で閉じない | `readWaitingScreen` は受信窓を見ない（I9）。確認は `humanHeld:false` |
| 2 | status-helper と poller が交互に読む | 同じ関数で読むので一致。同じ turn の画面の行き来は rebind |
| 3 | T が画面の証拠で閉じる → stop | T9（B と F の両方） |
| 4 | status-helper の開始時点で区間なし → await → E が開いて閉じる → 古い画面で開き直す | 版の照合（I5 (b)）と `frameCapturedAt <= lastClosedAt`（I6） |
| 5 | E1 の観測が await の間に E2 を screen へ rebind | 版の照合 |
| 6 | 答えの後に E が開く → poller が閉じない | 答えの送信で区間を開く（PR 3）。古い画面からの open は I6 で見送り |
| 7 | opencode の別 session の idle が dialog だけの区間を閉じる | `:701` の分岐で session を照合して拒否（両方の session ID があるとき） |
| 8 | PR 1a だけの develop で解除が新しいカードを消す | 4 本を同じリリースに入れ、PR 2 を 1a の直後に入れる（§6） |

### 3.4 レビュー 2 回目の割り込み 7 件

| # | 順序 | 閉じる場所 |
|---|---|---|
| 1 | RC の capture 中に答えと stop → (d) で stop の後に区間が開く | I5 (d) の `frameCapturedAt > lastClosedAt` の条件。フレームは stop より前に取りに行ったものなので見送り |
| 2 | status-helper が stop の後に始まり、キャッシュの古い画面で開く | I6。キャッシュの値は stop より前に取りに行ったもの |
| 3 | poller の tick 中に `post_tool_use` の rebind → poller の close は ignored → 次の tick で閉じる | 版の照合で見送り、次の tick で収束（第 2 版と同じ） |
| 4 | `beginAgentEventGeneration` → screen の区間 → 同じプロセスの `SessionStart` | T20 の H は rebind（世代だけ新しくする）。閉じない |
| 5 | claude-done: 対象を固定 → await の間に hook stop が A を閉じ B が開く | `settleLegacyStop` の ID の照合で何もしない |
| 6 | opencode / V2 の permission: `await adjudicatePermission` の間に入れ替わる | 記録は `recordAgentEvent` の末尾で今の状態に対して処理 |
| 7 | 30 分の stale が読んだ時点で書かれ、観測が置き換える | 観測の表の「T は閉じている」の行は、別の turn か画面キーが違う確認のときだけ置き換える。同じ確認は kept |

---

## 4. 陰性対照・陽性対照とテストの層

### 4.1 層

| 記号 | 層 | 入口 | 観測 |
|---|---|---|---|
| R | 実 ingest（route） | `POST /api/hooks/agent-event` の handler（`recordAgentEvent` は本物）。`route.ts:177` の await は `resolveStopTranscriptCapture` を deferred にして止める | `getWaitingEpisode`・遷移の記録・`prompt-push-*` のログ |
| OC | opencode ingest | `ingestOpencodeEvent`（`applyStop` の動的 import を遅延させる mock） | 同上 |
| V2 | opencode V2 ingest | `ingestOpencodeV2Event` の `stopEffect` seam（`ingest.ts:183`）を deferred | 同上 |
| CD | claude-done route | `request.json()`・`captureClaudeOutput`・`recordClaudeConversation` を deferred | 同上 |
| SH | status-helper | `detectWorktreeSessionStatus`（capture を deferred・キャッシュの時刻を指定できる mock） | 同上 |
| RC | response-checker | 本物の `checkForResponse`（`isDuplicatePrompt` も本物） | 同上 |
| AY | Auto-Yes poller | `detectAndRespondToPrompt` / tick（受信窓は本物） | 同上 |
| CO | current-output | `buildCurrentOutput` を 3 回回して `scraper_evidence` で turn を閉じる | turn の `closedBy` |
| P | push | notifier・gate・dedup・resolution・card-state を fake timers で | 通知回数・hold の期限・予約 tick を読んだ回数・解除 |
| SW | Service Worker | `tests/unit/pwa/sw-push.test.ts` と同じ方式 | 閉じた通知・`showNotification` の回数と内容 |
| U | 表の単体 | `applyTurnOutcomesToEpisode`・`planWaitingObservation` を表の行ごとに | 動作 |

対照は `os.tmpdir()` の `mkdtempSync` で作った隔離 DB で行い、`afterEach` で消す。各テストに書く PR は §6 の番号。

### 4.2 一覧

**表の網羅（U、PR 1a・1b）**: §2.4 の turn の遷移の表（T1〜T21 × A〜I）と観測の表の全セルを 1 ケースずつ。表の外の組み合わせ（※1 など）が既定（状態を変えない・`waiting-episode-unmatched` の warn）になること。

**agy の実際の event の組（R、PR 1a。R2 の抜け 1）**

| 対照 | 層 |
|---|---|
| 確認（`unattributed(P)`）→ 答え → `post_tool_use` → stop: 閉じる。hold の終わりに `prompt-push-allowed` が出ない | R・P |
| 確認 → 答え → `post_tool_use` 無しで stop: 閉じる（T9・F） | R・P |
| 最初の turn（P なし）で同じ 2 つ | R |
| T が `scraper_evidence` で閉じた後に開いた `unattributed(lastClosedTurnId=T)` → stop: 閉じる | CO・R |

**破れ 7 件**

| 対照 | 層（PR） |
|---|---|
| #1 新 session B 待ち中の旧 A の stop: B の ID・since・hold の期限・通知回数が変わらない | R・OC・V2（1a） |
| #2 回答 → survey/picker → stop: 区間・hold・reminder が残る。解除通知 0 | R・OC・V2・SH（1b）、AY（1b: screen の rebind） |
| #3 A の stop 記録 → await 中に B が開く → 戻る: B が残る | R・OC・V2（1a） |
| #4 A の区間が開いたまま → A stop・await → B の確認: B は新しい ID・since・hold | R・OC・V2・RC（1a・1b） |
| #5 前世代の hook 記録 → 世代更新 → claude-done だけ: 閉じる | CD（1a） |
| #6 turn 未作成で確認 → 遅い開始 hook → 取得 3 回: 開く edge 1 回、ID・since 不変 | R・OC・V2（1a）、SH（1b） |
| #7 A stop 記録 → await → 世代更新 → 開始 hook 前の B 人待ち → 戻る: B が残る | R・OC・V2（1a） |

**レビュー 1 回目の指摘に対応する対照**

| 対照 | 層（PR） |
|---|---|
| R1-1: agy の確認を poller が受信窓の外で読む → 区間は `screen` にならない → stop で閉じる。status-helper と poller を交互に 6 回 → 開く edge 1 回・ID・hold の期限が不変 | AY・SH・R・P（1b） |
| R1-1: 同じ turn で menu → 確認 → menu → rebind だけ | SH・AY（1b） |
| R1-2: 確認 → 答え → `scraper_evidence` で T が閉じる → stop → 閉じる。stop が来ずに画面キーの違う次の確認 → replaced | CO・R（1a）、RC（1b） |
| R1-3: 開く経路の ABA（版の照合）、E1 → E2 の rebind の見送り | SH・R（1b） |
| R1-4: 答えの送信の時点で区間が無い → poller が開いて `lastAnswer` に書く → 画面が消えた tick で閉じる | AY・P（3） |
| R1-5: 解除のとき別の `episodeId` の通知を無音で出し直し、`showNotification` を 1 回呼ぶ。何も無いときも 1 回 | SW（2） |
| R1-6: opencode の dialog だけの区間に別 session の idle → 閉じない。`idle_prompt` の表示だけの記録の上の待ちは `unattributed` | OC・R（1a） |
| R1-7: **poller が答える種類の確認**（opencode の番号つき選択・copilot の 3 択以下の確認）で、同じ turn の確認 1 に答え、9 秒以上後に画面キーの違う確認 2 → 新しい区間・新しい hold、poller が答える前に `prompt-push-allowed` が出ない（R2-14） | RC・AY・P（3） |
| R2-14: API で答える確認（opencode の permission を `adjudicatePermission` が答える、respond の構造化回答）→ T17 で閉じる → 次の確認は新しい区間 | OC・V2・R（1a） |
| R1-8: 呼び手の `listSessions()` の後に新しい session が開いて区間が開く → 古い一覧で閉じない | SH（1b） |
| R1-9: 中断後の再送 → P の区間が閉じる。queued notice の復元 → N の間の区間が R に戻る | R（1a） |

**レビュー 2 回目の「§4 の抜け」6 件**

| 対照 | 層（PR） |
|---|---|
| agy の実際の event の組（`user_prompt_submit` なし、`post_tool_use` で turn が開く）での確認 → 答え → stop。`post_tool_use` 無しも含む | 上の「agy の実際の event の組」（1a） |
| 30 分の stale を越えた人待ちの確認を観測しても、ID・since・通知回数が変わらない（Auto-Yes off と on の両方） | SH・P（1b） |
| RC の capture の await 中に stop（または poller の close）→ 戻った RC が開かない（`frameCapturedAt <= lastClosedAt`）。stop の後に取りに行ったフレームの本物の確認は開く（陽性） | RC・R（1b） |
| copilot の 4 択以上の `ask_user`、opencode の permission の帯（decision の記録あり）が `screen` にならない。decision の記録が無い帯は `screen`（限界の固定） | SH・RC（1b） |
| `unattributed` の区間が残っているときの次の turn: `user_prompt_submit` なら閉じる（T4）、`lastClosedTurnId` が違えば閉じる（T1 の G）、観測で画面キーが違えば replaced（漏れない） | R・SH（1a・1b） |
| PR 2 単独での hold の混在: ID なしの gate（O2）の直後に ID つきの gate（notifier）が同じ since で来る → hold は 1 つ、予約 tick を読むのは 1 回 | P（2） |

**レビュー 2 回目の指摘に対応する対照（上と重ならないもの）**

| 対照 | 層（PR） |
|---|---|
| R2-8: `beginAgentEventGeneration` → 信頼確認の `screen` → `SessionStart` → 閉じない（解除 0・通知 1 回）。`screen` 以外は閉じる | R・SH（1a） |
| R2-9: Auto-Yes off で tmux から人が答える → stop → 5 秒以内のキャッシュを読む status-helper が開かない | SH（1b） |
| R2-11: decision に答えた（`remaining=0`）dialog だけの区間は閉じる。`remaining>0` は残る | R・OC（1a） |
| R2-13: stop の閉じる edge の listener が読む turn model が、`applyAwaitingInstructionTransition` の後の状態 | R（1a） |

**追加の陰性対照**

| 対照 | 層（PR） |
|---|---|
| 拒否された stop（別 session / 世代より前）で区間・hold・通知回数が変わらない | R・OC・V2（1a） |
| 同一ミリ秒（turn の層）: 同じ `receivedAt` の A の stop と B の開始 → turnId が 2 つ、A の区間は閉じ B の区間は別 ID | R（1a） |
| 同一ミリ秒（push の層）: 2 つの区間の since が等しい → ID が別、通知 2 回、hold が別 | P・RC（2・1b） |
| 同じ本文の次の確認（次の turn）: `isDuplicatePrompt` を本物のまま通し、新しい区間・新しい通知。重複除外で落ちるならその事実を固定する | RC（1b） |
| 複数回の再取得: status の取得を 3 回以上 → 開く edge 1 回 | SH（1b） |
| 世代交替: `process-start` で `screen` を含めて閉じる。`session-start` で `screen` 以外を閉じる | R・SH（1a） |
| claude-done の各 await（`:58`・`:72`）中の入れ替わり: hook stop が A を閉じ B が開く → B が残る／世代更新 → 何もしない／何も起きない → A が閉じる | CD（1a） |
| claude-done の body の読み（`:34`）の限界: body の読みの間に A が閉じ B が開く → B が閉じる（テスト名に `limit:`） | CD（1a） |
| 開始 hook だけ併用: hook stop の印なし → claude-done が閉じる。印あり → 何もしない | CD・R（1a） |
| permission_replied の 3 経路と opencode・V2 の permission（記録の前に await）: 記録は今の区間に対してだけ作用する | R・OC・V2（1a） |
| Auto-Yes poller: 答えていない区間・前の区間の答え・capture 失敗・未分類の画面・`screen` の区間・tick 中の入れ替わりで閉じない | AY（3） |
| 旧形式のカードのマークと `resolvedEpisodeId` の無い解除で今の動き | P・SW（2） |

**人待ちの対照**（最終状態に加え、解除通知・通知回数・since・hold の期限が変わらない）

| 対照 | 層（PR） |
|---|---|
| menu が出た後に stop | R・OC・V2・AY・P（1b） |
| 構造化確認 → 遅い開始 hook → 繰り返し取得 | R・OC・V2・SH・P（1a・1b） |

**#3796 との対照**

| 対照 | 層（PR） |
|---|---|
| wake → capture 失敗 → 再予約の間に rebind が起きても hold の期限が延びない | P・AY（2・1b） |
| replaced で新しい区間だけに新しい hold（予約 tick を新しい hold の開始時点で 1 回読む） | P（2） |
| 解除通知と新しい通知の到着順の逆転 | SW・P（2） |

**陽性対照（維持）**

| 対照 | 層（PR） |
|---|---|
| UAT 1 回目の形（agy の event の組で）: 答え +0.3 秒・stop +4 秒 → `prompt-push-allowed` が出ない | R・P（1a） |
| UAT 3/4/6/7 回目の形: 次の確認は自分の ID・since で hold される | R・RC・P（1a） |
| 人が要る画面（答えも stop も無い）は約 9 秒で `auto-yes-not-answered` | P・SH（1a 以降のすべて） |
| 閉じる edge 自体は通知しない | R・P（1a） |

---

## 5. #3796 との整合（規則 7）

[事実] #3796 は hold の開始時に Auto-Yes poller の予約 tick を 1 回だけ読み（`prompt-push-gate.ts:180`・`:204-209`）、その後は早まる方向にだけ読み直す（`:220-226`・`:249`）。

1. **hold の同一性は dedup と同じ混在の規則**（R2-7）。今の hold と入力が同じ待ちとみなすのは「両方に ID があり等しい」か「片方に ID が無く since が等しい」。片方に ID が無く since が等しいとき、hold に ID が無ければ入力の ID を hold に書き足す（以後は ID で比べる）。新しい hold を作る（予約 tick を読む）のは、同じ待ちとみなせないときだけ
2. **rebind は hold を作り直さない**（I3）。`firstHeldAt`・`sessionWaitTick` は rebind の前後で同じ
3. **replaced は新しい hold**。新しい区間 ID で初めて gate に来た時点で予約 tick を読む。古い区間の hold は `forgetAutoYesHold(key, { episodeId: old })` で落とす
4. **dedup は区間 ID**（混在の規則は 1 と同じ）。opencode の質問 push は ID を持たないので、since で status-helper の通知と束ねる今の動きを残す
5. **reminder・再判定も区間 ID**。`replaced` を受けたら古い区間のタイマーを止め、解除通知は出さない
6. **抑止記録に区間 ID**。`AutoYesPolicySuppression` に `episodeId?: WaitingEpisodeId | null`。gate は ID があれば ID の一致、無ければ `at >= waitingSince`。gate 側（型の欄を含む）は PR 2、書き手は PR 3。`refreshEpisodeSuppression`（`src/lib/polling/auto-yes-poller-receipt-log.ts:246-270`）は写し直すとき `episodeId` を引き継ぐ
7. **wait が読む抑止記録**。`current-output` に `autoYes.lastSuppression.episodeId` と `autoYes.waitingEpisodeId` を公開し、`wait.ts` の `activeSuppression`（`:252-264`）は両方が非 null で異なれば古い記録として扱う。どちらかが無ければ 60 秒の窓（`:245`）
8. **旧区間の回答を持ち込まない**。`lastServerResponseTimestamp`（`prompt-push-gate.ts:188-189`）は起点を後ろへずらすだけなので残す。区間を閉じる判定・同じ turn の 2 つ目の確認の判定は `lastAnswer.episodeId` を使う
9. Auto-Yes poller の #3796 の欄（`src/lib/polling/auto-yes-poller-state.ts:44-58`）には触らない。capture 失敗の tick は区間に作用しない

---

## 6. 実装の分割

**4 本を 1a → 2 → 1b → 3 の順に develop へ入れ、4 本とも同じリリースに入れる**（間でリリースを切らない）。poller の `no_prompt` の観測のうち「人待ち画面を開く・`screen` へ rebind する」部分は PR 1b に前倒しし、「答えた区間を閉じる」「答えで区間を開く」「2 つ目の確認の replaced」は PR 3 に残す（R2-6）。

各 PR が単独で develop に入った直後の状態:

| PR | 入った直後の develop で変わること | 今より悪くなる形 | それを閉じる PR | 単独で develop に入れてよいか |
|---|---|---|---|---|
| 1a | 区間に ID・binding。turn の遷移で同期的に閉じる（agy の UAT の形が直る）。claude-done の照合 | (1) 答え → survey → stop の順で、ブラウザが無いと survey の区間が stop で閉じ、通知されない（今は「閉じない」ことで偶然 9 秒後に通知されていた）。(2) stop で閉じる回数が増え、解除通知が新しいカードを消す形がカードのある場合に出やすい | (1) 1b（poller が survey を `screen` で開く。Auto-Yes off で poller の無い場合は §8 の限界） (2) 2 | 入れてよい（リリースは 2・1b・3 と一緒） |
| 2 | push 側が ID で照合（ID の無い入力は since）。sw.js の照合 | なし。1a の (2) が閉じる。ID の無い O2 と ID つきの notifier が同じ since で来ても hold は 1 つ（§5 の 1） | — | 入れてよい |
| 1b | 共通の画面の読み方・観測の表・版と capture の時刻の照合・`replaced` の発生。poller の screen の open/rebind | 同じ turn の 2 つ目の確認は kept のまま（今と同じ。悪化ではない） | 3 | 入れてよい |
| 3 | poller の閉じる・答えで開く・2 つ目の確認の replaced・抑止記録の ID・wait | なし | — | 入れてよい |

### PR 1a: 区間の ID と帰属、turn の遷移での同期的な終了、claude-done

- scope: `src/lib/session/waiting-episode-state.ts`、`src/lib/session/waiting-episode-binding.ts`（新設。`applyTurnOutcomesToEpisode`・`captureLegacyStopTarget`・`settleLegacyStop`・binding の resolver の登録）、`src/lib/session/agent-event-turn.ts`、`src/lib/session/agent-event-state.ts`、`src/lib/hooks/agent-event-intake.ts`、`src/app/api/hooks/agent-event/route.ts`（ログの欄）、`src/app/api/hooks/claude-done/route.ts`、テスト、`changelog.d/3798.md`
- テスト: §4.2 の「agy の実際の event の組」、破れ #1・#3・#5・#6（turn 側）・#7、R1-2（stop 側）・R1-6・R1-9・R2-8・R2-11・R2-13・R2-14、表の網羅（turn の遷移の表）、拒否された stop、同一ミリ秒（turn の層）、世代交替、claude-done、permission_replied の経路、陽性対照
- 注意: `waiting-episode-state` は leaf のまま（R2-10）。`agent-event-state` を部分 mock する既存の integration テストがあるので、新しい関数は `agent-event-state` から export しない。`agent-event-turn.ts:701` の挙動の変更が既存テストに固定されていないかを最初に確かめる

### PR 2: push 側を区間 ID で照合

- scope: `src/lib/push/prompt-push-gate.ts`、`src/lib/polling/auto-yes-suppression-state.ts`（型の欄の追加のみ）、`src/lib/push/notification-dedup.ts`、`src/lib/push/push-sender.ts`、`src/lib/push/waiting-push-notifier.ts`、`src/lib/push/resolution-push-notifier.ts`、`src/lib/push/prompt-card-state.ts`、`public/sw.js`、テスト。**O2 の plan/commit は 1b に置く**（PR 2 の O2 は ID を渡さず、§5 の 1 の混在の規則で hold・dedup が 1 つにまとまる）
- テスト: hold の混在、同一ミリ秒（push の層）、replaced で新しい hold、rebind で hold が延びない、SW、旧形式のマーク、既存の `prompt-push-gate-*`・`waiting-push-*`・`cross-device-dismissal-2001`・`restart-card-state-2057`・`sw-push` が期待を変えずに通ること

### PR 1b: 観測の照合と共通の画面の読み方

- scope: `src/lib/detection/waiting-screen-reading.ts`（新設）、`src/lib/detection/prompt-screen-key.ts`（新設。`partialAnswerScreenKey` の移設と re-export）、`src/lib/polling/auto-yes-poller-state.ts`（re-export の 1 行のみ）、`src/lib/session/waiting-episode-binding.ts`（観測の関数・版・`lastClosedAt`）、`src/lib/session/cli-session.ts`・`src/lib/tmux/tmux-capture-cache.ts`（capture の時刻）、`src/lib/session/worktree-status-helper.ts`、`src/app/api/worktrees/route.ts`・`src/app/api/worktrees/[id]/route.ts`、`src/lib/polling/response-checker.ts`（O2 の plan/commit・gate と push に ID・C2 の照合）、`src/lib/auto-yes-poller.ts`（`no_prompt` の観測のうち screen の open/rebind だけ）、`tests/unit/guards/retired-tick-write-guard-3705.test.ts`（対象一覧への追加のみ）、テスト
- テスト: 表の網羅（観測の表）、破れ #2・#4・#6 の観測側、R1-1・R1-2（観測）・R1-3・R1-8、R2 の抜けのうち stale・RC の capture 中の stop・copilot/opencode の帯・`unattributed` の漏れ、R2-9、同じ本文の次の確認、複数回の再取得、人待ちの対照

### PR 3: Auto-Yes poller の終了・答えでの区間・2 つ目の確認・抑止記録・wait

- scope: `src/lib/auto-yes-poller.ts`、`src/lib/polling/auto-yes-poller-state.ts`（`lastAnswer` の追加）、`src/lib/polling/auto-yes-suppression-state.ts`（書き込み）、`src/lib/polling/auto-yes-poller-receipt-log.ts`、`src/lib/session/waiting-episode-binding.ts`（`lastAnswer` を使う観測の表の行）、`src/lib/polling/response-checker.ts`（`lastAnswer` を渡す行）、`src/lib/session/current-output-builder.ts`・`current-output-types.ts`、`src/cli/types/api-responses.ts`、`src/cli/commands/wait.ts`、テスト。`prompt-push-gate.ts` は含まない
- テスト: AY の対照、R1-4・R1-7、wait の抑止表示

---

## 7. 保留ブランチから流用するもの・捨てるもの

| 対象（`07610c745`） | 扱い | 理由 |
|---|---|---|
| `tests/unit/push/waiting-episode-close-no-browser-3798.test.ts` の UAT の再現・人が要る画面の陽性対照・閉じる edge は通知しない対照 | 流用。agy の event の組（`post_tool_use` で turn が開く）に書き直す | 再現の形は UAT と一致。event の組は R2-1 |
| 同ファイルの session A/B の対照 | 流用（#1 の R 層） | 判定の場所が変わるだけ |
| `tests/unit/polling/auto-yes-poller-close-answered-wait-3798.test.ts` の survey/picker・信頼確認・受信待ちの対照 | 流用（PR 3）。答えの判定は `lastAnswer.episodeId` | 時刻の比較は規則 1 に反する |
| 同ファイルの `detectSessionStatus(...).status === 'waiting'` で menu を守る考え方 | 流用し、`readWaitingScreen` にする（PR 1b）。条件は `isPrompt` と構造化の待ちも見る | R1-1・R2-5 |
| `tests/unit/push/waiting-episode-close-async-stop-3798.test.ts` の OpenCode / V2 の await を止める仕掛け | 流用（OC・V2 の土台）。R 層にも同じ仕掛けを作る | 期待は一部変わる |
| `tests/unit/lib/polling/response-checker-ended-turn-wait-3798.test.ts`・`tests/unit/lib/worktree-status-helper-ended-turn-wait-3798.test.ts` の仕掛け | 流用（RC・SH の土台） | 期待は ID で書き直す |
| `tests/unit/api/hooks-claude-done-delegation.test.ts` への追加 | 流用（CD）。「hook の turn が開いていれば閉じない」は捨てる | 開始 hook だけ併用で閉じられなくなる |
| #3796 との統合部分 | 流用（PR 3） | 別関数で互いの中身を変えない |
| `src/lib/session/waiting-episode-turn.ts` | 捨てる | 閉じる側が今の turn と時刻から推定している |
| `applyAgentStopEvent` の先頭での終了 | 捨てる | opencode・V2 では await の後 |
| `stopTurnOutcomes` Map | 捨てる | await を挟むと次の turn に読まれる |

---

## 8. 限界と未確認事項

### 限界

- **claude-done の旧形式**: B の区間が開いた後に届いた旧 A の claude-done は B に当たる。同じ世代に hook の stop があれば印で止まる。body の読み（`route.ts:34`）の間の入れ替わりも同じ（`limit:` のテストで固定）
- **session ID の無い hook**: `closesTurn` は片方が null なら同じ session とみなす。破れ #1 と残る順序 R1-7 の保護は両方の session ID が要る
- **stop-without-turn**: session ID で区別できなければ `unattributed` / `dialog-only` の区間を閉じる
- **#3330 の重複と確認が重なったとき**: 印の無い複製が先に届くと turn P の区間は閉じ、復元しても戻らない。確認が残っていれば次の観測が新しい区間として開く（通知がもう 1 回出うる）
- **遅れて届く `user_prompt_submit`**: 確認が先に見え、その turn の `user_prompt_submit` が後から届くと、区間は T4 で閉じる。確認が残っていれば次の観測が開き直す（通知がもう 1 回出うる）。turn model が同じ時点で decision を捨てるのに合わせた（R2-4）
- **観測の無い人待ち**: Auto-Yes が off でブラウザも無いとき、回答の後の survey を誰も読まないまま stop が来ると、区間は閉じ、次の status の問い合わせまで開き直らない。Auto-Yes が off なら開いた時点で通知は出ている
- **decision の記録が無い opencode の permission の帯**: hook が届かないと構造化の待ちが無く `humanHeld` になり、stop で閉じない（観測で閉じる）
- **同じ turn の同じ本文の 2 つ目の確認**: 画面キーが同じなので replaced にならない。`isDuplicatePrompt` でも落ちうる
- **版・capture の時刻で見送られる open**: status-helper の open は次の問い合わせまで遅れうる
- **Service Worker の更新**: 端末の `sw.js` が更新されるまでは今の動き
- **プロセス再起動**: 区間はメモリにあり、再起動で消える

---

## 9. 本文に無い指摘（scope 外。直していない）

- `src/lib/push/waiting-push-notifier.ts:22-31` と `src/lib/session/waiting-episode-state.ts:14-18` の docblock は「`observeWaitingEdge` の呼び手は `worktree-status-helper` だけ」と書くが、今は `response-checker`（`:941`・`:1465`）も呼ぶ。PR 1a で書き直す
- `src/lib/session/worktree-status-helper.ts:875-878`: capture が throw すると区間を閉じる（#1786 の決定）。未分類の画面も同じ。規則 3 と考え方が違うが、既存テストの期待を変えないため、版の照合を足すだけにした
- `src/lib/hooks/sources/opencode/push.ts:172`: 質問の push が区間を開かず、since の一致だけで status-helper の通知と束ねている。PR 2 では since の互換を残す

---

## 10. 改訂履歴

### レビュー 1 回目（第 2 版、`dacf6c244`）

| 指摘 | 重さ | 処置 | 反映した節 |
|---|---|---|---|
| 1 humanHeld を受信窓を見ない共通関数で | P1 | 採用（第 3 版で定義を R2-5 のとおり直した） | 1.9、2.2、I9、規則 1、観測の表 |
| 2 stop 以外で閉じた turn の区間 | P1 | 採用（第 3 版で `unattributed(lastClosedTurnId)` にも広げた: R2-1） | 1.6、T9、観測の表 |
| 3 開く・rebind に開始時点の照合 | P2 | 採用（版。第 3 版で capture の時刻も足した: R2-2） | I5・I6 |
| 4 答えの後に開いた区間を poller が閉じない | P2 | 採用（答えの送信で区間を開く） | 規則 3、PR 3 |
| 5 Service Worker が置き換えを出さない分岐 | P2 | 採用 | 規則 5 |
| 6 dialog だけの判定と別 session の stop | P2 | 採用 | 2.2、T10、規則 1 |
| 7 同じ turn の 2 つ目の確認 | P2 | 採用（PR 3） | 観測の表 |
| 8 `sessionNameSet` が古い | P3 | 採用 | 2.5 |
| 9 open-same-session → rebind | P3 | 採用（閉じる側） | T5 |
| 10 PR の分割 | P3 | 採用（第 3 版で同じリリース・poller の前倒しを足した: R2-6） | 6 |
| 11 カードのマークの一覧 | P3 | 一部採用（区間 ID 1 つ） | 規則 5 |
| 12 recordAgentEvent の他の経路 | P3 | 採用 | 1.8、規則 8 |

### レビュー 2 回目（第 3 版）

レビュー: `review-3798-design-2.md`。各指摘は該当コードを開いて事実を確かめてから処置した。14 件とも事実は正しかった（R2-5 の opencode の帯は「hasActivePrompt:false」に加え promptDetection も持たないことを確かめ、定義に構造化の待ちの条件を足した）。

| 指摘 | 重さ | 事実の確認 | 処置 | 反映した節 |
|---|---|---|---|---|
| 1 agy は `user_prompt_submit` が無く、turn は最初の `post_tool_use` で開く。`unattributed(lastClosedTurnId)` が stop-without-turn で閉じない | P2 | 正しい（`antigravity/source.ts:238-248`・`:259`、`permission-decision-service.ts:455-461`） | 採用。T9 に F（lastClosed=X）を足し、T11 で previous=none/display-only の F を閉じる。§3 を agy の event の組で書き直した | 1.7、T9・T11、3.1・3.2、4.2 |
| 2 (d) の plan し直しで古いフレームから開く | P2 | 正しい（`cli-session.ts:105-125` の 5 秒キャッシュと singleflight。`captureSessionOutput` は時刻を返さない） | 採用（capture の時刻の案）。I5 (d) と I6 に `frameCapturedAt > lastClosedAt` | 1.9、2.2、I5・I6、3.4 |
| 3 30 分の stale を読んだ観測が置き換える | P2 | 正しい（`agent-event-turn.ts:133-142` は読んだ時点で閉じる） | 採用。「T は閉じている」の行は別の turn か画面キーが違う確認のときだけ replaced | 観測の表、3.4 |
| 4 `unattributed` の区間が次の turn へ漏れる | P2 | 正しい（第 2 版は無条件の rebind） | 採用。turn の遷移側は lastClosed の一致かつ post/pre_tool_use のときだけ rebind、`user_prompt_submit` は閉じる。観測側は画面キーが同じときだけ | T1〜T4、観測の表、8 |
| 5 humanHeld の定義（copilot の 4 択以上・opencode の帯） | P2 | 正しい（`copilot/detect.ts:82-94`、`verdicts.ts:28-41`、`opencode/detect.ts:141`） | 採用し強めた。`isPrompt===false` に加え、構造化の待ちが無いことを条件にした（opencode の帯は promptDetection を持たないため `isPrompt` だけでは足りない） | 1.9、規則 1 |
| 6 ブラウザ無しの破れ #2 を閉じるのは PR 3 | P2 | 正しい（第 2 版は poller の観測を PR 3 に置いていた） | 採用（両方）。4 本を同じリリースにし、poller の screen の open/rebind を 1b へ前倒し | 6 |
| 7 PR 2 の時点の O2 で hold が作り直される | P2 | 正しい（`prompt-push-gate.ts:179-180`） | 採用（hold にも dedup と同じ混在の規則）。O2 の plan/commit は 1b のまま | 5（1）、6、4.2 |
| 8 `session_start` の世代更新が screen を閉じる | P3 | 正しい（`agent-event-state.ts:385`） | 採用。`generation-fenced` に source を持たせ、`session-start` では `screen` を閉じない（T20） | 2.2、I8、T19・T20 |
| 9 古いキャッシュで版が一致したまま開き直す | P3 | 正しい（R2-2 と同じ仕組み） | 採用（R2-2 の I6 で一緒に閉じる） | I6、4.2 |
| 10 import の循環 | P3 | 正しい（第 2 版の薄い層は state → binding → state） | 採用。state は leaf、binding が resolver を登録。`lastAnswer` は観測の入力。画面キーの関数は detection 層へ移す | 2.2、6 |
| 11 decisions-released で `unattributed` に付け替えると漏れる | P3 | 正しい | 採用（閉じる。`decision-settled`） | T17 |
| 12 §1.7 の V2 の await | P3 | 正しい（`opencode-v2/ingest.ts:232`・`:250`） | 採用 | 1.8 |
| 13 遷移を出す位置 | P3 | 正しい（`agent-event-state.ts:395-400`） | 採用。`recordAgentEvent` の末尾で出す。listener が turn model へ戻らないことは未確認として残す | 規則 2 の前文、2.6、4.2 |
| 14 指摘 7 の opencode の対照の種類 | P3 | 正しい（opencode の permission は `adjudicatePermission` が答え、`lastAnswer` は書かれない） | 採用。R1-7 の対照は poller が答える種類に限定。API で答えたときは T17 で閉じる | T17、4.2 |

---

## 11. この版に残る既知の限界と未確認（実装の初めに実機で確かめる項目）

1. agy で `post_tool_use` が stop より前に必ず届くか（届かなくても T9/T11 で閉じる設計だが、頻度を見る）
2. agy の確認がどの観測で最初に開くか（RC か status-helper か poller か）と、そのときの `lastClosedTurnId`
3. 同じプロセスの最初の `SessionStart` が、信頼確認・hooks review の画面より前に来るか後に来るか（T20 の前提）
4. poller が copilot の 4 択以上の `ask_user` に答えるか
5. 区間の listener（`waiting-push-notifier`・`waiting-broadcast`・`relay-triggers`）が `recordAgentEvent` を同期で呼ばないか
6. opencode が他 session の `session.idle` をどこで落としているか（`opencode/history.ts:459` 付近）
7. `reportPermissionRequestPending`（`agent-event-state.ts:563`）の経路で session ID を得られるか
8. `agent-event-turn.ts:701` の上書きを既存テストが固定しているか
9. `structured-decision.ts:712` が `:631`・`:634` の await と同じ関数の中にあるか
10. `tmux-capture-cache.ts` に `fetchStartedAt` を足して singleflight の待ち合わせでも同じ時刻を返せるか
11. 保留ブランチのテストを develop の上で動かしていない（#3820 以降との差）
12. 限界のうち実害の大きいもの: claude-done の旧形式の取り違え、session ID の無い hook、観測の無い人待ち（Auto-Yes off・ブラウザ無し）
