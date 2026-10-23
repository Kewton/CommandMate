# Issue #3798 waiting の区間（WaitingEpisode）に ID と帰属を持たせる設計

- 対象 Issue: #3798（ブラウザを開いていないと agy の waiting の区間が閉じない）
- 版: **第 4 版（確定版、2026-10-24、レビュー 3 回目を反映）**。第 1 版 `81f762b1e`、第 2 版 `dacf6c244`、第 3 版 `d6be3df7c`。土台は develop `4ec3c066b`
- 位置づけ: 設計書の段。コードは 1 行も変えていない。この版で設計を確定し、§6 の各 PR の節から実装の契約を起案する
- 入力: Issue 本文、2026-10-19 のコメント（作り直しの設計 第 2 版: 破れ 7 件・規則 1〜8・追加の受入基準）、UAT 記録 `workspace/orchestration/runs/2026-10-18/uat-3788.md` 項目 D、保留ブランチ `fix/3798-waiting-interval-close-no-browser`（HEAD `07610c745`）、独立レビュー `workspace/orchestration/runs/2026-10-23/review-3798-design-1.md`・`-2.md`・`-3.md`

## 0. 表記

- **[事実]** は develop のコードを読んで確かめたこと。参照は `path:line`（develop `4ec3c066b` 時点の行番号）
- **[見立て]** は推論。実機でもテストでも確かめていない
- **未確認** は調べたが確かめられなかったこと
- 「区間」は `WaitingEpisode`、「turn」は `TurnRecord`（`src/lib/session/provisional-turn.ts:309`）、「世代」は `generationStartedAt`（`src/lib/session/agent-event-turn.ts:51`）
- 「R1-N」「R2-N」「R3-N」はレビュー 1・2・3 回目の指摘 N

この文書は型・不変条件・呼び出しの順序・同期区間の境界・失敗時の扱いを決める。関数本体は書かない。

---

## 1. 現状の調査

### 1.1 型

[事実]
- `WaitingEpisode` は `{ since: number; kind: WaitingKind | null }` だけ（`src/lib/session/waiting-episode-state.ts:70-81`）。ID も、どの turn・世代で開いたかも持たない
- 区間の置き場は `globalThis.__sessionWaitingEpisodes`（compositeKey → 区間、`waiting-episode-state.ts:64`）。インスタンスごとに高々 1 つ
- 遷移の通知は `WaitingTransition`（`waiting-episode-state.ts:84-97`）。区間の ID も「置き換え」も表せない
- 書き手は `observeWaitingEdge()`（`waiting-episode-state.ts:162-193`）。テストの 18 ファイルがこの関数を直接呼ぶ（`grep -rln observeWaitingEdge tests`）。`vi.mock` で `waiting-episode-state` を置き換えるテストは無い
- `turnId` は `turn-<at>-<seq>`（`agent-event-turn.ts:144-147`）で、同一ミリ秒でも区別できる

### 1.2 区間を開く経路

| # | 経路 | 場所 | since | 備考 |
|---|---|---|---|---|
| O1 | status の問い合わせ（ブラウザ・`commandmate ls` 等） | `src/lib/session/worktree-status-helper.ts:884` | `frame.structuredWaitingSince`（`:688`）か now | 待ちの判定は scraper の status と構造化の decision の OR（`:663`） |
| O2 | 応答 poller が確認を検出 | `src/lib/polling/response-checker.ts:941`（`savePromptMessage`、`:814`） | `getWaitingEpisode()?.since ?? promptObservedAt`（`:910-912`） | 本文ハッシュの重複除外 `isDuplicatePrompt`（`:841`。判定と同時にハッシュを登録する: `src/lib/polling/prompt-dedup.ts:90-101`）を通ったものだけ。**push を先に出し（`:921-938`）、その後に区間を開く**。全画面 TUI（opencode・copilot、`:761`）でなければ直後に `stopPolling`（`:950-952`） |

[事実] `observeWaitingEdge` を本番のコードで呼ぶのはこの 2 箇所と `response-checker.ts:1465` だけ。Auto-Yes poller・hook の受信・`applyAgentStopEvent` は区間に触れない。

### 1.3 区間を閉じる経路

| # | 経路 | 場所 | 条件 |
|---|---|---|---|
| C1 | status の問い合わせ | `worktree-status-helper.ts:884` | `frame.isWaitingForResponse === false`。session が動いていない・capture が throw（`:875-878`）・未分類の画面もすべて「待っていない」（`:542-545`）。「動いていない」は呼び手が先に取った `sessionNameSet`（`:816`）で決まる |
| C2 | 応答 poller が返答を記録 | `response-checker.ts:1465` | 返答を保存した tick の末尾。`mayStillActAfter(ctx,'conversation-log')`（`:1420`）の後、`await` なし |

[事実] `sessionNameSet` は呼び手（`src/app/api/worktrees/route.ts:138`、`src/app/api/worktrees/[id]/route.ts:67`）が `listSessions()` の await で取ったもの。Issue 本文の `response-checker.ts:1448` は develop では `:1465`（説明コメントは `:1457`）。

### 1.4 since を引き継ぐ経路

- [事実] O2 は開いている区間があればその `since` を自分の確認の since として使い（`response-checker.ts:911-912`）、gate（`:922-927`）と push（`:929-938`）に渡す
- [事実] O1 も既存の区間があれば `kind` を更新するだけ（`waiting-episode-state.ts:181-187`）

### 1.5 区間を読む側

| 読み手 | 場所 | 区間の何で識別するか |
|---|---|---|
| Auto-Yes の hold | `src/lib/push/prompt-push-gate.ts:172-190` | `hold.since !== input.waitingSince` で新しい hold（`:179`）。そのとき予約 tick を 1 回だけ読む（`:180`）。起点は `max(firstHeldAt, lastServerResponseTimestamp)`（`:188-189`） |
| 抑止記録の帰属 | `prompt-push-gate.ts:351-354` | `suppression.at >= waitingSince` |
| 通知の dedup | `src/lib/push/notification-dedup.ts:132-143` | `WaitingPushRecord.since`（`:95-100`） |
| push の分岐 | `src/lib/push/push-sender.ts:585-591` | `waitingSince` があれば `shouldSendWaitingPush`。dedup は最初の `await` より前（`:611-619`） |
| 通知の保持・再判定・reminder | `src/lib/push/waiting-push-notifier.ts` | `PendingWait.since`（`:111-117`）。`gateAndSend`（`:234-254`）は区間の `kind` を見ない |
| 解除通知 | `src/lib/push/resolution-push-notifier.ts:145` | `hasOpenWaitingEpisode(worktreeId)`（worktree 単位） |
| カードのマーク | `src/lib/push/prompt-card-state.ts` | worktree ごとに 1 行・1 文で書く |
| 端末側の解除 | `public/sw.js:186-208`・`:220-258` | tag の通知を全部閉じてから無音の置き換えを出す。「閉じて何も出さない」分岐は持たない契約（`:170-183`） |
| WebSocket | `src/lib/realtime/waiting-broadcast.ts:74-76` | `transition.waiting` / `since` |
| relay | `src/lib/relay/relay-triggers.ts:134` | `transition.waiting && kind==='prompt'` |
| `commandmate wait` の抑止表示 | `src/cli/commands/wait.ts:245-264` | `autoYes.lastSuppression.at` が 60 秒以内か（`wait.ts:234-237`） |
| opencode の質問 push | `src/lib/hooks/sources/opencode/push.ts:34-44`・`:172` | `waitingSince: askedAt`。区間を開かない |

### 1.6 turn model 側の事実

- `recordAgentEvent`（`src/lib/session/agent-event-state.ts:346-401`）は late `session_start` 以外 `{ recorded: true }` を返し、turn が閉じたか・拒否されたかは返さない。末尾は `fenceTurnForNewGeneration`（`session_start` のとき、`:395`）→ `applyTurnTransition`（`:399`）→ `applyAwaitingInstructionTransition`（`:400`）
- `session_start` は毎回 `generationStartedAt` を更新する（`:385`）
- `applyTurnTransition`（`agent-event-turn.ts:466-519`）: 世代より前の event は捨てる（`:470`）。`user_prompt_submit`（`:478`）・`post_tool_use`（`:486`）・`session_end`（`:504`）は **decision を一括で捨てる**（`releaseAllDecisions`）。`post_tool_use` の一括 release はツールが順に走る前提（#1726 のコメント）
- 明示の回答による release は `releaseSettledDecision`（`:758` の `permission_prompt` の `promptSettled`、`:782` の `permission_replied`）。`idle_prompt` は一括 release（`:789`）
- `applyStopToTurn`（`:687-713`）: 開いている turn への別 session の stop は何もせず `return`（`:694`）。開いている turn が無ければ、session を見ずに `openedAt:null` の閉じた記録で上書きする（`:701-712`）
- `openTurn`（`:567-614`）: dialog だけの記録の decision は新しい turn に運ばれる（`:591-593`）。同じ session の開いている turn を印の無い prompt が置き換えたときは `reopenedTurns` に残す（`:609-613`）。理由は #3330 の重複と中断後の再送（`:429-433`）
- `joinOpenTurnFromDuplicate`（`:650-675`）: 置き換えた turn を元の ID で戻す
- `openDecision`（`:828-`）が作る dialog だけの記録は `sessionId: null`（`:846`・`:863`）。`idle_prompt` も turn が無ければ decision 0 件の表示だけの記録を作る（`:800-811`）
- **予測の decision は読んだ時点で消える**: `livePendingDecisions`（`agent-event-turn.ts:172-185`）は `DIALOG_PENDING_MAX_MS.predicted`（20 秒、`provisional-turn.ts:153-156`）を過ぎた decision を黙って落とす。dialog だけの記録はその後「表示だけ」と同じ形になる（R3-4）
- `reportPermissionRequestPending`（`agent-event-state.ts:563`）と `reportQuestionPending`（`:626`）は `recordAgentEvent` の外で `openDecision` を呼ぶ（`:571`・`:634`）（R3-6）
- `fenceTurnForNewGeneration`（`:347-368`）の呼び手は `session_start`（`agent-event-state.ts:395`）と `beginAgentEventGeneration`（`:447`、呼び手 `src/lib/session/agent-session-lifecycle.ts:90`）
- `closesTurn` は片方の sessionId が null なら同じ session とみなす（`provisional-turn.ts:547-550`）
- turn は stop 以外でも閉じる: `observeScraperCompletionEvidence`（`agent-event-turn.ts:311-345`、呼び手 `current-output-builder.ts:1002`）が画面の `ready` を 3 回続けて読むと `scraper_evidence`。`mayClose` を false にするのは codex だけ（`src/lib/detection/turn-abandoned.ts:43-46`）。`effectiveTurn` は読んだ時点で 30 分の `stale`（`agent-event-turn.ts:133-142`）。どちらも遷移の通知は無い

### 1.7 agy の hook の event

[事実] agy の source は `supportedEvents: ['session_start', 'post_tool_use', 'stop']`（`src/lib/hooks/sources/antigravity/source.ts:248`）。`UserPromptSubmit`・`Notification`・`SessionEnd` は無い（`:238-240`）。`PreToolUse` は `/api/hooks/permission-request` に向けられ、記録しない（`:242-247`）。`permissionHookPredictsDialog: false`（`:259`）なので dialog だけの記録も作られない（`src/lib/hooks/permission-decision-service.ts:455-461`）。agy の turn は **最初の `post_tool_use` で開く**（`agent-event-turn.ts:480`）。turn の最初のツールで確認が出ると、その時点で開いている turn は無い。

### 1.8 recordAgentEvent の呼び手と await の位置

| 経路 | turn への記録（同期） | 記録の前後の await |
|---|---|---|
| `POST /api/hooks/agent-event`（agy・claude・codex 等） | `applyAgentEventToState` → `recordAgentEvent`（`src/lib/hooks/agent-event-intake.ts:340-398`） | 後: `await applyAgentStopEvent`（`src/app/api/hooks/agent-event/route.ts:177`）。route の `await` は `:73` と `:177` だけ |
| opencode ingest（一般） | `recordAgentEvent`（`src/lib/hooks/sources/opencode/ingest.ts:396`・`:414`） | 後: `await applyStop`（`:434`）→ 動的 import（`:253-257`）→ `applyAgentStopEvent`（`:268`） |
| opencode ingest（permission） | `recordAgentEvent`（`:386`） | 前: `await adjudicatePermission`（`:385`） |
| opencode ingest（question） | `reportQuestionPending`（`:221`。`recordAgentEvent` の外） | — |
| opencode V2 ingest（permission） | `recordAgentEvent`（`src/lib/hooks/sources/opencode-v2/ingest.ts:233`） | 前: `await adjudicatePermission`（`:232`） |
| opencode V2 ingest（question） | `recordAgentEvent`（`:253`） | 前: `await readQuestion`（`:250`） |
| opencode V2 ingest（settled・stop・その他） | `recordAgentEvent`（`:240`・`:298`・`:301`） | stop は後: `await stopEffect`（`:299`）→ 動的 import（`:74-78`）→ `applyAgentStopEvent`（`:85`） |
| permission-request の見送り | `reportPermissionRequestPending`（`permission-decision-service.ts:465`。`recordAgentEvent` の外） | — |
| respond の構造化回答 | `recordAgentEvent(permission_replied)`（`src/app/api/worktrees/[id]/respond/structured-decision.ts:712`） | 前: 回答の送信の await（`:631`・`:634`。同じ関数かは未確認） |
| 構造化回答の配信 | 同上（`src/lib/hooks/structured-decision-response.ts:529`） | 前: 動的 import の await（`:528`） |
| decision の再確認 | 同上（`src/lib/hooks/pending-decision-recheck.ts:149`） | 前: 動的 import の await（`:148`） |
| `POST /api/hooks/claude-done`（旧形式） | turn model に記録しない | body の読み（`claude-done/route.ts:34`）→ capture（`:58`）→ ログ保存（`:72`）→ `applyAgentStopEvent`（`:100`） |

### 1.9 画面の読み方

- [事実] agy の Auto-Yes poller は確認を受信の範囲（`receiptScope`）つきで読む（`src/lib/auto-yes-poller.ts:682-711`）。窓の外では本物の確認でも `no_prompt`（`:957-991`）。status API・応答 poller・通知は範囲を渡さない（`:960-963`）
- [事実] `detectSessionStatus` の結果は `status`・`hasActivePrompt`・範囲を渡さない読みの `promptDetection` を持つ（`src/lib/detection/status-detector.ts:60-80`）
- [事実] copilot の 4 択以上の `ask_user` は `isPrompt: true` で `hasActivePrompt: false`（`src/lib/detection/tools/copilot/detect.ts:82-94`、`verdicts.ts:28-41`）。opencode の permission の帯は promptDetection を持たない（`src/lib/detection/tools/opencode/detect.ts:141`）
- [事実] capture は 5 秒キャッシュと singleflight を通る（`src/lib/session/cli-session.ts:105-125`、`src/lib/tmux/tmux-capture-cache.ts:46`）。キャッシュの値は書いた時刻だけを持ち、`captureSessionOutput` は文字列だけを返す

### 1.10 事象の説明

[事実]（UAT 記録）1 回目: 09:28:14.804 に区間が開く → 15.119 に `response-sent` → 18.839 に stop → 24.121 に `prompt-push-allowed (auto-yes-not-answered)`。3・4 回目は `waitingSince` が 1 回目の値のまま、poller が答える前に `prompt-push-allowed`。hook の到着順は記録に無い。

[見立て] agy の返答は hook で届くので C2 に来ず、ブラウザが無いので C1 も来ない。区間が開いたままなので hold の終わりの再判定（`waiting-push-notifier.ts:289-305`）が `auto-yes-not-answered` を出し、次の確認で O2 が古い since を流用して即座に通知可になる。

---

## 2. 設計

### 2.1 方針

1. 区間は **ID・帰属（binding）・版** を持つ。同一性は ID だけで判定する。時刻は表示・経過時間と、**フレームが閉じる操作より前のものか** の比較だけに使う
2. turn の遷移は、turn model を書き換えた **`recordAgentEvent` の同期区間の末尾**（と、`recordAgentEvent` の外で decision を作る 2 関数・世代更新・復元の同期区間）で区間に作用する。後段の `await` の後では区間を操作しない
3. 画面の観測（status-helper・応答 poller・Auto-Yes poller）は **1 つの画面の読み方**（受信窓を見ない）と **1 つの観測関数** を使い、始めた時点の版と読んだフレームの capture の時刻で照合する
4. 帰属の違う区間への入れ替えは **1 つの操作**（`replaced`）
5. push 側は区間 ID で照合し、ID の無い入力とは since で突き合わせる
6. **既定の動作は 2 つに分ける**（R3-5）:
   - **閉じる側（観測の `not-waiting`・`gone`）は全域で定義する**。区間の binding を問わず、観測者ごとの条件を満たせば閉じる。表に「当たらない区間」は無い。閉じ忘れはこの Issue の誤通知そのものなので、「状態を変えない」を閉じる側の既定にはしない
   - **turn の遷移の表と、開く・置き換える・rebind の側の既定は「区間の状態を変えない」**（`waiting-episode-unmatched` を warn）。ここで状態を変えないと、閉じる側では「区間が残る」ことになるが、その区間は観測の `not-waiting`/`gone`（全域で定義）が閉じる。開き忘れは次の観測が開き直す。残る危険は「観測者が 1 つもいない」場合だけで、§8 の限界に書く

### 2.2 型

```ts
// src/lib/session/waiting-episode-state.ts（leaf: agent-event-* も binding も import しない）

export type WaitingEpisodeId = string; // `wep-<bootNonce>-<seq>`。時刻を含めない
export type GenerationRef = { kind: 'opened'; at: number } | { kind: 'none' };

export type EpisodeBinding =
  | { kind: 'turn'; generation: GenerationRef; turnId: string }
  | { kind: 'dialog-only'; generation: GenerationRef; recordTurnId: string; sessionId: string | null }
  | { kind: 'unattributed'; generation: GenerationRef; lastClosedTurnId: string | null }
  | { kind: 'screen'; generation: GenerationRef; originTurnId: string | null };

export interface WaitingEpisode {
  episodeId: WaitingEpisodeId;
  since: number;                  // 表示・経過時間用。同一性に使わない
  openedAt: number;               // 区間を開いた（replaced で置いた）時刻。フレームの新旧の比較用（R3-1）
  boundAt: number;                // 最後に binding が変わった時刻（開いたときは openedAt と同じ。rebind で更新。最終レビュー P3-1）
  kind: WaitingKind | null;
  binding: EpisodeBinding;
  openedBy: WaitingObserver;
  promptScreenKey: string | null; // 開いた確認の画面キー（無ければ null）
}

/** compositeKey ごとの単調な版。開く・閉じる・置き換え・rebind のたびに 1 増える（kind の更新では増えない）。 */
export type EpisodeVersion = number;

/** compositeKey ごとの最後の終了（閉じる・置き換えの古い側）（R3-2）。 */
export type LastClosed = { at: number; promptScreenKey: string | null } | null;

export type WaitingCloseReason =
  | 'turn-stop' | 'turn-session-end' | 'turn-superseded' | 'decision-settled' | 'generation'
  | 'screen-cleared' | 'session-gone' | 'response-recorded' | 'poller-answered' | 'legacy-stop';

export interface WaitingTransition {
  worktreeId: string; cliToolId: CLIToolType; instanceId: string | undefined;
  waiting: boolean;            // opened/replaced: true、closed: false
  since: number | null;
  kind: WaitingKind | null;
  at: number;
  cause: 'opened' | 'closed' | 'replaced';
  episodeId: WaitingEpisodeId | null;
  previousEpisodeId: WaitingEpisodeId | null;
  closeReason: WaitingCloseReason | null;
}

// 低水準の書き込み（binding モジュールだけが呼ぶ）
export function openEpisode(key, next: NewEpisode, at: number): WaitingEpisode;
export function closeEpisode(key, expectedId: WaitingEpisodeId, reason: WaitingCloseReason, at: number): boolean;
export function replaceEpisode(key, expectedId: WaitingEpisodeId, next: NewEpisode, reason: WaitingCloseReason, at: number): WaitingEpisode | null;
export function rebindEpisode(key, expectedId: WaitingEpisodeId, binding: EpisodeBinding): boolean;
export function getEpisodeVersion(key): EpisodeVersion;
export function getLastClosed(key): LastClosed;

// 既存の呼び手とテスト（18 ファイル）のための互換。binding は登録された resolver で決め、
// 無ければ { kind: 'unattributed', generation: { kind: 'none' }, lastClosedTurnId: null }
export function observeWaitingEdge(params: ObserveWaitingEdgeParams): number | null;
export function registerEpisodeBindingResolver(resolver: EpisodeBindingResolver): void;
```

state は leaf のまま。binding モジュールが resolver を globalThis 経由で登録する（R2-10）。

turn model の結果:

```ts
// src/lib/session/agent-event-turn.ts
export type OpeningEvent = 'user_prompt_submit' | 'pre_tool_use' | 'post_tool_use';

/** 遷移の直前の記録。dialog-only と display-only は「decision が 0 件か」だけの違いで、どちらも turnId を持つ（R3-4）。 */
export type PreviousTurn =
  | { kind: 'none' }
  | { kind: 'dialog-only'; turnId: string; decisions: number; sessionId: string | null }
  | { kind: 'display-only'; turnId: string }
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
  /** 明示の回答による release だけ（releaseSettledDecision）。一括の release（post_tool_use・
   *  user_prompt_submit・idle_prompt・session_end）はこの outcome を出さない（R3-3）。 */
  | { kind: 'decision-answered'; recordTurnId: string; recordKind: 'dialog-only' | 'turn'; before: number; remaining: number }
  | { kind: 'generation-fenced'; source: 'process-start' | 'session-start'; generation: GenerationRef; fencedTurnId: string | null };

// src/lib/session/agent-event-state.ts
export type AgentEventRecordOutcome =
  | { recorded: true; turn: TurnTransitionOutcome[]; episode: EpisodeEffect[] }
  | { recorded: false; skipped: 'late-session-start' };
```

turn model の変更:
- `openDecision` の入力に `sessionId: string | null` を足し、dialog だけの記録を新しく作るときに入れる（R1-6）
- `applyStopToTurn` の `:701` の分岐で、上書きされる記録が decision 1 件以上の dialog だけの記録で、その sessionId と stop の sessionId が両方 non-null かつ異なるときは、上書きせず `stop-rejected(other-session)`（R1-6）
- `reportPermissionRequestPending`・`reportQuestionPending` は `openDecision` の後、**同じ関数の末尾で** `decision-opened` を `applyTurnOutcomesToEpisode` に渡す（R3-6）

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

// src/lib/detection/prompt-screen-key.ts（新設。partialAnswerScreenKey を移す。
// src/lib/polling/auto-yes-poller-state.ts:180 は re-export する）
export function promptScreenKey(promptData: PromptData): string;

// src/lib/session/waiting-episode-binding.ts（新設）
export interface ObservationStart { generation: GenerationRef; version: EpisodeVersion }
export interface WaitingObservation {
  worktreeId: string; cliToolId: CLIToolType; instanceId?: string;
  observer: 'status-probe' | 'response-checker' | 'auto-yes-poller';
  start: ObservationStart;
  reading: ScreenReading;
  frameCapturedAt: number;   // 読んだフレームを取りに行き始めた時刻（キャッシュ当たりならその値の取得開始時刻）
  freshPrompt?: boolean;     // RC が isDuplicatePrompt を通す新しい確認／Auto-Yes poller が答えを送る直前
  lastAnswer?: { episodeId: WaitingEpisodeId; screenKey: string } | null; // PR 3。呼び手が渡す
  now?: number;
}
export type ObservationAction = 'opened' | 'kept' | 'rebound' | 'replaced' | 'closed' | 'ignored';
export function startWaitingObservation(worktreeId, cliToolId, instanceId?): ObservationStart;
export function planWaitingObservation(obs: WaitingObservation): WaitingObservationPlan; // 純粋
export function commitWaitingObservation(plan: WaitingObservationPlan): ObservationAction;
export function observeWaiting(obs: WaitingObservation): WaitingObservationPlan;        // plan + commit
export function applyTurnOutcomesToEpisode(key: CompositeKeyParts, outcomes: TurnTransitionOutcome[], at: number): EpisodeEffect[];
export function captureLegacyStopTarget(worktreeId, cliToolId, instanceId): LegacyStopTarget;
export function settleLegacyStop(worktreeId, cliToolId, instanceId, target: LegacyStopTarget):
  'closed' | 'target-gone' | 'hook-authority' | 'screen' | 'nothing-open';
```

- `captureSessionOutputWithMeta(): { output, capturedAt }` を足す。キャッシュの値にはその値を取りに行き始めた時刻（`fetchStartedAt`）を持たせる。既存の `captureSessionOutput` の戻り値は変えない
- Auto-Yes poller の状態（PR 3）: `lastAnswer?: { episodeId; screenKey; at }`（`auto-yes-poller-state.ts`。#3796 の欄には触らない）
- stop の権限（規則 6）: `__waitingHookStopGeneration: Map<compositeKey, GenerationRef>`。`stopped`・`stop-without-turn` を処理したとき、その世代を書く

### 2.3 不変条件

- **I1** 1 インスタンスに開いている区間は高々 1 つ。区間 ID は再利用しない
- **I2** `episodeId`・`since`・`openedAt` は開いてから閉じるまで変わらない。変わるのは `kind` と `binding`（と、binding に付く `boundAt`）だけ
- **I3** rebind は edge を出さない。hold・dedup・reminder は区間 ID に付くので、rebind で延びも縮みもしない
- **I4** `closed` の edge は「その区間が終わった」ことだけを言う。置き換えは `replaced` を 1 回だけ出す
- **I5** 区間を開く・閉じる・置き換える・rebind するのは次のどれかの同期区間だけ:
  - (a) `recordAgentEvent` の末尾、`reportPermissionRequestPending`・`reportQuestionPending` の末尾、`beginAgentEventGeneration` の中、`joinOpenTurnFromDuplicate` の呼び手の同期区間（`applyTurnOutcomesToEpisode`）
  - (b) 観測の `commitWaitingObservation` で、`start.generation` と `start.version` が今と同じとき
  - (c) claude-done の `settleLegacyStop` で、`target.episodeId` が今の区間 ID と同じとき
  - (d) `freshPrompt: true` の観測は、版が違っても今の状態で plan し直す。I6 に当たれば `ignored`。世代が違えば `ignored`
- **I6** 観測が区間を開く・置き換える・rebind するのを見送るのは、次の **すべて** を満たすときだけ（R3-2）:
  1. `getLastClosed(key)` が null でない
  2. `frameCapturedAt <= lastClosed.at`（閉じる操作より前に取りに行ったフレーム）
  3. 読みの画面キー `k` が null、または `k === lastClosed.promptScreenKey`（閉じた区間と同じ確認を映している、または確認を読めない画面）
  - 閉じた区間と違う確認を映すフレームは、閉じる操作より前のものでも見送らない（別の新しい確認を取りこぼさない）
- **I7** `binding.generation` が今の世代と違えば前のプロセスのもの。`process-start` の世代更新で閉じる
- **I8** `screen` の区間は turn の遷移（stop・session_end・開始・decision）と `session-start` の世代更新では閉じない。閉じるのは観測の `not-waiting`/`gone`（Auto-Yes poller を含む: R3-1）と `process-start` の世代更新
- **I9** `humanHeld` は `readWaitingScreen` だけが決める。受信窓を見る読みを使わない
- **I10** `kept` は版を変えず、照合なしに `kind` だけを更新できる
- **I11** 既定の動作は §2.1 の 6 のとおり。観測の `not-waiting`・`gone` は全域で定義し、既定を持たない。turn の遷移の表と、観測の開く・置き換える・rebind の側の表の外は「状態を変えない」

### 2.4 規則ごとの落とし込み

#### 規則 1（ID と帰属）・humanHeld の定義

開く時点の binding は turn model から同期で決める（`getAgentTurn` の fence 込み）:

| 開く時点の turn model | binding |
|---|---|
| 開いている turn | `turn` |
| `openedAt===null && closedAt===null` で、読んだ時点の `livePendingDecisions` が 1 件以上 | `dialog-only` |
| 上記で decision 0 件、閉じた turn、記録なし | `unattributed`（最後に閉じた turn か表示だけの記録の turnId を `lastClosedTurnId` に） |
| 読みが `humanHeld: true` | 上の結果に関わらず `screen`（上の結果が `turn(T)` なら `originTurnId: T`） |

`humanHeld` = 次のすべて: (1) `detectSessionStatus(...).status === 'waiting'` (2) 同じ結果の `promptDetection.isPrompt === false`（範囲を渡さない読み） (3) 構造化の待ち（`peekPromptWaiting().structured`）が無い。

#### 規則 2・4・8: turn の遷移の作用表（`applyTurnOutcomesToEpisode`）

`recordAgentEvent` は fence の結果と遷移の結果を配列に集め、`applyAwaitingInstructionTransition`（`agent-event-state.ts:400`）の後で順に渡す（R2-13）。

列（すべて今の世代。世代が違う区間は列 I）:

| 記号 | 開いている区間 |
|---|---|
| A | なし |
| B | `turn(X)`（X は行の対象の turn: T1〜T5 では新しい N、T7 では N、T8・T13 では T、T9 では previous の X、T17 では R） |
| C | `turn(Y)`（Y ≠ X） |
| D | `dialog-only(R)` で、R が行の対象の記録の turnId と一致（T2〜T4・T10・T11 では `previous.turnId`、T15・T17 では R）（R3-4） |
| E | `dialog-only(R')`（D 以外） |
| F | `unattributed(lastClosedTurnId = P)`（P は `previous.turnId`。`previous` が none なら null） |
| G | `unattributed`（F 以外） |
| H | `screen` |
| I | `binding.generation` が今と違う |

動作: **閉**=閉じる、**付**=rebind、**－**=何もしない。

| # | outcome | A | B | C | D | E | F | G | H | I |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | `opened(N, post/pre_tool_use, previous=closed(P))` | － | －※1 | 閉 superseded | －※5 | 閉 superseded | 付 turn(N) | 閉 superseded | － | 閉 generation |
| T2 | `opened(N, post/pre_tool_use, previous=dialog-only(R))` | － | －※1 | 閉 superseded | 付 turn(N) | 閉 superseded | 付 turn(N)※2 | 閉 superseded | － | 閉 generation |
| T3 | `opened(N, post/pre_tool_use, previous=display-only(R) / none)` | － | －※1 | 閉 superseded | 付 turn(N)（R3-4） | 閉 superseded | 付 turn(N) | 閉 superseded | － | 閉 generation |
| T4 | `opened(N, user_prompt_submit, previous=closed/dialog-only/display-only/none)` | － | －※1 | 閉 superseded | 閉 superseded | 閉 superseded | 閉 superseded | 閉 superseded | － | 閉 generation |
| T5 | `opened(N, previous=open-same-session(P) / open-other-session(P))` | － | －※1 | 閉 superseded | －※5 | 閉 superseded | 閉 superseded | 閉 superseded | － | 閉 generation |
| T6 | `continued(T)` | － | － | － | － | － | － | － | － | － |
| T7 | `restored(R, discarded N)` | － | 付 turn(R) | － | － | － | － | － | － | － |
| T8 | `stopped(T)` | － | 閉 turn-stop | － | － | － | － | － | － | 閉 generation |
| T9 | `stop-without-turn(previous=closed(X, 理由を問わない))` | － | 閉 turn-stop | － | －※5 | － | 閉 turn-stop | － | － | 閉 generation |
| T10 | `stop-without-turn(previous=dialog-only(R))`（session の照合を通ったもの） | － | － | － | 閉 turn-stop | － | 閉 turn-stop | 閉 turn-stop | － | 閉 generation |
| T11 | `stop-without-turn(previous=display-only(R) / none)` | － | － | － | 閉 turn-stop（R3-4） | － | 閉 turn-stop | － | － | 閉 generation |
| T12 | `stop-rejected(*)` | － | － | － | － | － | － | － | － | － |
| T13 | `session-ended(T)` | － | 閉 session-end | － | － | － | － | － | － | 閉 generation |
| T14 | `session-end-rejected(*)` | － | － | － | － | － | － | － | － | － |
| T15 | `decision-opened(R, recordKind=dialog-only)` | － | － | － | － | － | 付 dialog-only(R) | 付 dialog-only(R) | － | － |
| T16 | `decision-opened(R, recordKind=turn)` | － | － | － | － | － | － | － | － | － |
| T17 | `decision-answered(R, before>0, remaining=0)` | － | 閉 decision-settled | － | 閉 decision-settled | － | － | － | － | － |
| T18 | `decision-answered(remaining>0 または before=0)` | － | － | － | － | － | － | － | － | － |
| T19 | `generation-fenced(process-start)` | － | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 閉 generation |
| T20 | `generation-fenced(session-start)` | － | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 閉 generation | 付（世代だけ新しく。R2-8） | 閉 generation |
| T21 | `none` | － | － | － | － | － | － | － | － | － |

- ※1 B の X は今作られた turn N なので、遷移の前に `turn(N)` の区間は存在しない（turnId は単調な連番: `agent-event-turn.ts:144-147`）。状態を変えない
- ※2 T2 の F は `lastClosedTurnId` が dialog だけの記録 R そのもののときだけ当たる（R の decision が期限切れで表示だけと同じ形のときに開いた `unattributed` の区間が、その後 R に decision が戻った場合）。「`unattributed` の区間を開いた後で dialog だけの記録 R ができた」形（scraper が先に読んだ確認に hook が追いついた）は、区間の `lastClosedTurnId` が R より前の turn P なので F ではなく G に当たり、T2 では `閉 superseded` になる。この形は T15（`decision-opened`）で `dialog-only(R)` に付け替えておくことで T2 の D に入る。T15 の outcome は `decision-opened` を出す 3 経路すべてが出すので、取りこぼしは `applyTurnOutcomesToEpisode` が throw した場合だけ（最終レビュー P3-3）
- ※5 T1・T5・T9 の `previous` は dialog だけ／表示だけの記録ではないので、列 D に当たる区間は無い（`dialog-only` の区間はすべて列 E）。状態を変えない
- T1・T3 の F の rebind は「確認が turn より先に来た」形（agy の最初のツールの確認、開始 hook の遅れ）だけ。`lastClosedTurnId` の一致と、開いた event が `post_tool_use`/`pre_tool_use` であることが条件（R2-4）
- T4 は `user_prompt_submit` で区間を閉じる（turn model もこのとき decision を全部捨てる）
- T17 は **明示の回答**（`permission_prompt` の `promptSettled`、`permission_replied`、respond の構造化回答・配信・再確認）による release だけ。`post_tool_use`・`user_prompt_submit`・`idle_prompt`・`session_end` の一括 release は `decision-answered` を出さない（claude の並列ツールで、ツール A の `post_tool_use` がツール B の確認の区間を閉じないため。R3-3）
- 予測の decision が 20 秒で読み出し時に消えると、dialog だけの記録は表示だけと同じ形になる。列 D は `recordTurnId` の一致だけで判定するので、T3・T11 で閉じる・付け替える（R3-4）
- **T15 の経路**: `decision-opened` を出すのは `recordAgentEvent`（`notification(permission_prompt)`）と、`reportPermissionRequestPending`・`reportQuestionPending` の末尾の 3 つ（R3-6）

#### 規則 3・4・5: 観測の作用表（`planWaitingObservation`）

前提の照合（表より先）:
1. `start.generation` が今と違う → `ignored`
2. 動作が `kept` 以外で `start.version` が今と違う → `ignored`（`freshPrompt` は I5 (d) で plan し直す）
3. 動作が「開く・置き換え・rebind」で I6 に当たる → `ignored`

`c` は読みが `waiting` のときの規則 1 の binding、`k` は読みの画面キー（`promptData` があれば `promptScreenKey`、無ければ null）。

**表 O-1: 読みが `waiting`（開く・置き換え・rebind・kept の側）**

| 開いている区間 | humanHeld=false | humanHeld=true |
|---|---|---|
| なし | opened（binding=c） | opened（screen） |
| `turn(T)`・T は開いている | c=turn(T): kept。ただし `freshPrompt` かつ `lastAnswer.episodeId`=今の ID かつ `k`≠null かつ `k`≠`lastAnswer.screenKey` なら replaced（R1-7）。c=turn(N≠T): replaced。c=dialog-only/unattributed: kept | 付 screen(origin T) |
| `turn(T)`・T は閉じている（理由を問わない） | c=turn(N≠T): replaced。c=dialog-only/unattributed: `freshPrompt` かつ `k`≠null かつ `k`≠区間の `promptScreenKey` なら replaced、それ以外は kept（R2-3） | 付 screen(origin T) |
| `dialog-only(R)` | c=dialog-only(R): kept。c=turn(N): 付 turn(N)。c=dialog-only(R'≠R): replaced。c=unattributed: kept | 付 screen(origin null) |
| `unattributed` | c=unattributed: kept（ただし `freshPrompt` かつ `lastAnswer.episodeId`=今の ID かつ `k`≠null かつ `k`≠`lastAnswer.screenKey` なら replaced）。c=dialog-only(R): 付 dialog-only(R)。c=turn(N): `k`≠null かつ `k`=区間の `promptScreenKey` なら 付 turn(N)、それ以外は replaced（R2-4） | 付 screen(origin null) |
| `screen(origin O)` | c=turn(O): 付 turn(O)。それ以外: replaced | kept |

（`c` の値は turn / dialog-only / unattributed の 3 種で、表の各セルはこの 3 種すべてを書いた。前提 1 が比べるのは**観測の開始時点の世代と今の世代**で、区間の `binding.generation` ではない。区間の `binding.generation` が今と違う（世代更新の適用を取りこぼした、T20 で付け替えた後にさらに世代が変わった等）ときは下の行で扱う。最終レビュー P3-2）

| 開いている区間 | humanHeld=false | humanHeld=true |
|---|---|---|
| `binding.generation` が今と違う（種類を問わない） | replaced（binding=c） | replaced（screen） |

**表 O-2: 読みが `not-waiting`・`gone`・`unknown`（閉じる側。開いている区間の binding を問わない: R3-5）**

| 観測者 | `not-waiting` | `gone` | `unknown` |
|---|---|---|---|
| status-helper | 閉 screen-cleared | 閉 session-gone | ignored（status-helper は capture 失敗を従来どおり `not-waiting` として渡す: §9） |
| response-checker（C2） | 閉 response-recorded | 閉 session-gone | ignored |
| Auto-Yes poller | 区間が `screen` なら、`frameCapturedAt > max(区間の openedAt, boundAt)` のとき 閉 screen-cleared（R3-1、最終レビュー P3-1: screen へ付け替えた後のフレームでなければ閉じない）。`screen` 以外なら、`lastAnswer.episodeId` が今の ID のとき 閉 poller-answered（PR 3。それまでは ignored）。どちらでもなければ ignored | 閉 session-gone | ignored |
| 区間なし（どの観測者でも） | ignored | ignored | ignored |

どのセルも前提 2（版の照合）を通ったときだけ動く。Auto-Yes poller が `screen` 以外の区間を自分の答え無しに閉じないのは Issue の規則 3（「poller がその区間に答えたときだけ」）による。人が答えた `screen` 以外の区間は stop（T 表）か status-helper が閉じる。

規則 5（置き換え）の残り:
- `replaced` は古い区間を消して新しい区間を置き、`cause:'replaced'` の遷移を 1 回だけ出す。解除通知は呼ばれず（`cause==='closed'` のときだけ）、WebSocket は `waiting:true` の新しい since だけを送る。`lastClosed` は置き換えでも古い区間の値で更新する
- 新しい区間の since: 読みの `structuredSince` が新しい binding に属するならそれ、そうでなければ観測時刻
- 解除通知の照合:
  - prompt の push の `data` に `episodeId` を入れる
  - `prompt-card-state` のマークに、最後に通知した区間 ID 1 つを時刻と一緒に 1 文で入れる。時刻だけの旧形式は「ID なし」
  - 解除の push に `resolvedEpisodeId`（マークの ID。無ければ欠く）
  - `public/sw.js` は、同じ tag の通知のうち `data.episodeId` が `resolvedEpisodeId` と等しいもの・`episodeId` を持たないものを閉じて無音の置き換えを出す。違う `episodeId` の通知が残っていれば、それを閉じてから同じ内容で `silent:true`・`renotify:false` で出し直す。どの分岐でも `showNotification` を必ず 1 回呼ぶ
  - `resolvedEpisodeId` の無い解除は今の動き

#### 規則 6（claude-done）

- 区間・世代は `claude-done/route.ts:47` の後、`:58` の await の前に `captureLegacyStopTarget` で固定する（最初の await は `:34` の body の読みだが、worktreeId は body の中にある）
- `:72` の await の後、`:100` の前に `settleLegacyStop`。閉じるのは (1) 世代が同じ (2) 区間 ID が `target.episodeId`（非 null）と同じ (3) 今の世代に hook の stop の印が無い (4) 区間が `screen` でない、のすべてを満たすとき
- route の変更は `no-claude-fallback` guard の baseline（`tests/unit/guards/no-claude-fallback.test.ts:258-291`、追加禁止）に触れないよう、`'claude'` の文字列を新しい呼び出しの引数に書かない

#### 規則 7

5 章。

#### 規則 8 の残り・O2 が ignored のとき（R3-2）

- C2（`response-checker.ts:1465`）は表 O-2 の response-checker の行。`start` は tick の最初の `await`（`:1533`）の前に読む。`tests/unit/guards/retired-tick-write-guard-3705.test.ts` の対象一覧に新しい関数名を足す
- O2（`savePromptMessage`）の順序:
  1. `planWaitingObservation({ freshPrompt: true })` を **`isDuplicatePrompt`（`:841`）より前**に呼ぶ
  2. plan が `ignored`（I6 に当たる＝閉じた区間と同じ確認を、閉じる前に取ったフレームで読んだ、または世代が違う）なら、**保存も dedup の登録も push もせず**、重複のときと同じく `return false`（`stopPolling` しない）。ログ `prompt-observation-stale`。ハッシュを登録しないので、次の tick の新しいフレームで同じ確認が本当に出ていれば保存される
  3. それ以外は今の順序どおり `isDuplicatePrompt` → 保存 → gate と push（plan の ID・since で）→ `commitWaitingObservation`。同じ同期区間（`savePromptMessage` は同期関数、`notifyPushSubscribers` の dedup は最初の await より前: `push-sender.ts:611-619`）
- `closeAgentTurn`・`observeScraperCompletionEvidence`・`effectiveTurn` の `stale` は遷移を出さない。その turn に付いた区間は、後の stop（T9）、次の turn（T1）、観測（表 O-1 の「T は閉じている」、表 O-2）のどれかで閉じる
- permission_replied の経路は記録の前に await があるが、区間の操作は `recordAgentEvent` の末尾で今の状態に対して行う

### 2.5 同期区間の境界

| 経路 | 固定する時点 | 区間を操作する同期区間 | await の後にしないこと |
|---|---|---|---|
| agent-event route | — | `recordAgentEvent` の末尾。重複破棄の復元は `dropDuplicateAgentEvent`（`agent-event-intake.ts:300-`）の中 | `applyAgentStopEvent`（`route.ts:177`）で触れない |
| opencode ingest | — | `recordAgentEvent`（`:386`・`:396`・`:414`）の末尾、`reportQuestionPending`（`:221`）の末尾 | `applyStop`（`:434`）で触れない |
| V2 ingest | — | `recordAgentEvent`（`:233`〜`:301`）の末尾 | `stopEffect`（`:299`）で触れない |
| permission-request の見送り | — | `reportPermissionRequestPending`（`permission-decision-service.ts:465` から）の末尾（R3-6） | — |
| permission_replied の 3 経路 | — | `recordAgentEvent` の末尾 | — |
| 世代更新（process-start） | — | `beginAgentEventGeneration` の中 | — |
| claude-done | `captureLegacyStopTarget`（`:47` の後） | `settleLegacyStop`（`:72` の後、`:100` の前） | `:100` 以降で触れない |
| status-helper | 呼び手が `listSessions()` を呼ぶ前（`worktrees/route.ts:138` の前、`[id]/route.ts:67` の前）に全インスタンス分の `ObservationStart` を取り `detectWorktreeSessionStatus` に渡す。渡されなければ `detectInstanceSessionStatus` の冒頭 | `observeWaiting`（`:884` の位置）。`frameCapturedAt` は `captureSessionOutputWithMeta` から | — |
| 応答 poller | `start`（`checkForResponse` の `:1533` の前） | O2: `savePromptMessage` の中（plan は `isDuplicatePrompt` の前）、C2: `:1465` | — |
| Auto-Yes poller | `start`（tick の capture の await の前。`auto-yes-poller.ts:1172` 付近） | `no_prompt` を返す直前（`:991` 付近）の `observeWaiting`（screen の open/rebind/閉じるは PR 1b、答えた区間を閉じるのは PR 3）。答えの送信を始める同期区間（PR 3） | — |

### 2.6 失敗時の扱い

- listener が throw しても区間の状態は変わらない（`waiting-episode-state.ts:114-128` の封じ込めを維持）
- `applyTurnOutcomesToEpisode` が throw しても turn の記録は済んでいる。内部で握り `waiting-episode-turn-sync-failed` を warn。区間が残っても、表 O-2 は binding を問わず閉じる（R3-5）
- 区間の listener は `recordAgentEvent` を同期で呼ばない（未確認: §11）
- capture 失敗: Auto-Yes poller は `unknown`。status-helper は従来どおり `not-waiting`（版の照合つき）
- `captureSessionOutputWithMeta` がキャッシュの時刻を返せない場合は `frameCapturedAt = 0`（I6 の 2 を満たす側に倒す。I6 の 3 で別の確認なら開ける）
- 解除の判定（`app_settings` の 1 読み）が hook の route の同期区間で走るようになる。送信は `void` で切り離されている
- プロセス再起動で区間は消える（今の §6.2 の限界）

---

## 3. 破れの順序がどこで閉じるか

### 3.1 agy の実際の event の組での基本の流れ（UAT の形）

前の turn を P とする（最初の turn なら P は無い）。

| 手順 | event / 観測 | turn model | 区間 |
|---|---|---|---|
| 1 | `send` で「ls を実行して」 | 変化なし | なし |
| 2 | `PreToolUse` → permission-request（記録しない） | 変化なし | なし |
| 3 | 確認が出る → RC（O2）・status-helper・Auto-Yes poller（PR 3）のどれかが読む | 開いている turn なし | opened `unattributed(lastClosedTurnId=P)` |
| 4 | Auto-Yes が答える（PR 3 では `lastAnswer`） | — | — |
| 5a | `post_tool_use` | `opened(N, post_tool_use, previous=closed(P))` | T1・F → 付 `turn(N)` |
| 6a | `stop` | `stopped(N)` | T8・B → 閉 |
| 5b | （`post_tool_use` 無しで）`stop` | `stop-without-turn(previous=closed(P))` | T9・F → 閉 |
| 7 | 次の確認 | — | 新しい ID・since で opened → 新しい hold |

最初の turn では 5a が T3・F、5b が T11・F。hold の終わり（約 9 秒）より前に stop が届けば `prompt-push-allowed` は出ない（UAT 1 回目の stop は答えの約 3.7 秒後）。

### 3.2 これまでの破れの順序の一覧（25 件）

| 出典 | # | 順序（要約） | 閉じる場所（第 4 版） |
|---|---|---|---|
| 既知 | 1 | 新 session B の確認 `turn(B)` → 旧 A の stop | `:694` で拒否 → T12。dialog だけなら `:701` で拒否 |
| 既知 | 2 | 答え → survey → stop | 観測が `humanHeld` → `screen` → T8 の H。stop が先なら閉じた後に `screen` で開き直す（I6 の 3: 画面キー null は 2 も見る＝stop の後のフレームなら開く） |
| 既知 | 3 | A の stop 記録 → await → B が開く → A の後段 | A は記録の末尾で閉じ済み。後段は区間に触れない |
| 既知 | 4 | A の区間が残る → A stop・await → B の確認 | A は stop の同期区間で閉じる。`screen` で残れば観測が replaced |
| 既知 | 5 | 前世代の hook 記録 → 世代更新 → claude-done だけ | T19/T20 で閉じる。`settleLegacyStop` は今の世代の印だけ見る |
| 既知 | 6 | turn 未作成で確認 → 遅い開始 hook → 取得の繰り返し | T1/T3 の F で rebind。観測は kept |
| 既知 | 7 | A の stop 記録 → await → 世代更新 → B 人待ち → A の後段 | A は閉じ済み。遅い A の stop は `before-generation` で T12 |
| R1 残る順序 | 1 | poller が受信窓の外で確認を読む | `readWaitingScreen` は受信窓を見ない（I9） |
| R1 残る順序 | 2 | status-helper と poller が交互に読む | 同じ関数で読む。同じ turn の画面の行き来は rebind |
| R1 残る順序 | 3 | T が画面の証拠で閉じる → stop | T9（B と F） |
| R1 残る順序 | 4 | status-helper 開始時に区間なし → await 中に開いて閉じる → 古い画面で開く | 版の照合（前提 2）と I6 |
| R1 残る順序 | 5 | E1 の観測が await 中に E2 を screen へ rebind | 版の照合 |
| R1 残る順序 | 6 | 答えの後に E が開く → poller が閉じない | PR 3 で答えの送信で区間を開く。古い画面からの open は I6 |
| R1 残る順序 | 7 | opencode の別 session の idle が dialog だけの区間を閉じる | `:701` で session を照合して拒否 |
| R1 残る順序 | 8 | PR 1a だけで解除が新しいカードを消す | 4 本を同じリリースに入れ、PR 2 を 1a の直後に（§6.0） |
| R2 割り込み | 1 | RC の capture 中に答えと stop → stop の後に開く | I6（同じ画面キー、閉じる前のフレーム） |
| R2 割り込み | 2 | status-helper が古いキャッシュで開く | I6 |
| R2 割り込み | 3 | poller の tick 中に rebind → close は ignored → 次の tick | 版の照合で見送り、次の tick で収束 |
| R2 割り込み | 4 | `beginAgentEventGeneration` → screen → 同じプロセスの `SessionStart` | T20 の H は rebind |
| R2 割り込み | 5 | claude-done: await 中に hook stop が A を閉じ B が開く | `settleLegacyStop` の ID の照合 |
| R2 割り込み | 6 | opencode / V2 の permission の await 中の入れ替わり | `recordAgentEvent` の末尾で今の状態に対して処理 |
| R2 割り込み | 7 | 30 分の stale を読んだ観測が置き換える | 表 O-1「T は閉じている」は別の turn か画面キーが違う確認のときだけ replaced |
| R3 割り込み | 1 | poller の close（古いフレーム）が RC の新しい確認の open を見送らせる | I6 の 3: 別の画面キーなら見送らない。O2 は `ignored` でもハッシュを登録しない（§2.4 規則 8） |
| R3 割り込み | 2 | claude の並列ツールで A の `post_tool_use` が B の確認の区間を閉じる | T17 は明示の回答だけ。`post_tool_use` は `decision-answered` を出さない（`continued` → T6） |
| R3 割り込み | 3 | 予測の decision が 20 秒で消えた後の `post_tool_use`／stop | 列 D は `recordTurnId` の一致で判定。T3 の D で付け替え、T11 の D で閉じる |

（R3 の残り 2 件: 指摘 1 の「poller が screen を閉じない」は表 O-2 の Auto-Yes poller の行、指摘 5 の「stop で閉じたのに残った turn(T)」は表 O-2 の全域定義で閉じる。）

### 3.3 表の網羅の確かめ方

- **T 表**: 行は `TurnTransitionOutcome` の 12 種を `previous`・`event`・`source`・`remaining` で分けた 21 行。列は区間の状態の 9 種（なし／turn の一致・不一致／dialog-only の一致・不一致／unattributed の一致・不一致／screen／世代違い）。21×9＝189 セルにすべて動作（閉・付・－）を書いた。「－※1」「－※5」は存在しない組み合わせで、来たら既定（状態を変えない＋warn）
- **表 O-1**: 区間の状態 7 種（世代違いの行を含む）× humanHeld 2 種＝14 セル。humanHeld=false のセルは `c` の 3 種（turn / dialog-only / unattributed）すべてを書いた。前提 1 は観測の開始時点の世代を比べるもので、区間の世代違いは O-1 の行で扱う（テスト U に「世代違いの区間 × O-1」のケースを入れる）
- **表 O-2**: 観測者 3 種 × 読み 3 種、と「区間なし」。binding で分けないので当たらない区間は無い
- 実装の段では、表をそのまま列挙したテーブル駆動のテスト（§6 の各 PR の `…-table-3798.test.ts`）で 189＋14×3＋12 のケースを回す

---

## 4. 陰性対照・陽性対照とテストの層

### 4.1 層

| 記号 | 層 | 入口 |
|---|---|---|
| R | 実 ingest（route） | `POST /api/hooks/agent-event` の handler。`route.ts:177` の await は `resolveStopTranscriptCapture` を deferred にして止める |
| OC | opencode ingest | `ingestOpencodeEvent`（`applyStop` の動的 import を遅延させる mock） |
| V2 | opencode V2 ingest | `ingestOpencodeV2Event` の `stopEffect` seam（`ingest.ts:183`）を deferred |
| CD | claude-done route | `request.json()`・`captureClaudeOutput`・`recordClaudeConversation` を deferred |
| SH | status-helper | `detectWorktreeSessionStatus`（capture を deferred・キャッシュの時刻を指定できる mock） |
| RC | response-checker | 本物の `checkForResponse`（`isDuplicatePrompt` も本物） |
| AY | Auto-Yes poller | `detectAndRespondToPrompt` / tick（受信窓は本物） |
| CO | current-output | `buildCurrentOutput` を 3 回回して `scraper_evidence` |
| P | push | notifier・gate・dedup・resolution・card-state を fake timers で |
| SW | Service Worker | `tests/unit/pwa/sw-push.test.ts` と同じ方式 |
| U | 表の単体 | `applyTurnOutcomesToEpisode`・`planWaitingObservation` をテーブル駆動で |

対照は `os.tmpdir()` の `mkdtempSync` で作った隔離 DB で行い、`afterEach` で消す。各テストを書く PR は §6 の節に割り振った（§6 の受入基準が正）。

### 4.2 一覧（PR は括弧内）

- **表の網羅**: T 表 189 セル（1a）、表 O-1・O-2（1b。O-2 の poller の `screen` 以外の行は 3）
- **agy の実際の event の組**: 確認 → 答え → `post_tool_use` → stop／`post_tool_use` 無しで stop／最初の turn で同じ 2 つ／`scraper_evidence` の後の `unattributed(lastClosed=T)` → stop（R・P・CO、1a）
- **破れ 7 件**: #1（R・OC・V2、1a）、#2（R・OC・V2・SH・AY、1b）、#3（R・OC・V2、1a）、#4（R・OC・V2、1a／RC、1b）、#5（CD、1a）、#6（R・OC・V2、1a／SH、1b）、#7（R・OC・V2、1a）
- **R1 の指摘**: 受信窓の外（AY・SH・R、1b）、menu ⇄ 確認の行き来（SH・AY、1b）、`scraper_evidence` の後の stop（CO・R、1a）と次の確認（RC、1b）、ABA と rebind の見送り（SH・R、1b）、答えで区間を開く（AY・P、3）、SW の出し直し（SW、2）、別 session の idle と表示だけの記録（OC・R、1a）、poller が答える種類の 2 つ目の確認（RC・AY・P、3）、`listSessions()` の後の session（SH、1b）、中断後の再送と復元（R、1a）
- **R2 の指摘と抜け**: agy の event の組（上）、30 分の stale を越えた人待ち（SH・P、1b）、RC の capture 中の stop（RC・R、1b）、copilot の 4 択以上と opencode の帯（SH・RC、1b）、`unattributed` の漏れ（R・SH、1a・1b）、hold の混在（P、2）、`SessionStart` が screen を閉じない（R・SH、1a）、tmux から人が答えた後の古いキャッシュ（SH、1b）、`decision-answered` で閉じる（R・OC、1a）、listener が読む turn model の状態（R、1a）、API で答える確認（OC・V2・R、1a）
- **R3 の指摘**:
  - poller が `screen` を閉じる: 答え → survey（poller が `screen` で開く）→ 人が答える → poller が `not-waiting` → 閉じる。開く前に取ったフレームの `not-waiting` では閉じない（AY・P、1b）
  - 別の確認の open を見送らない: poller の close の await 中に RC が別の画面キーの確認 C2 を読む → C2 が開く。同じ画面キーなら見送り、ハッシュも登録しない（次の tick の新しいフレームで保存される）（RC・AY、1b）
  - claude の並列ツール: 確認 B の区間 `turn(T)` → ツール A の `post_tool_use` → 区間が残る（since・hold・通知回数が変わらない）。`permission_replied` で閉じる（R、1a）
  - 予測の decision の期限切れ: dialog だけの記録の区間 → 21 秒後に `post_tool_use` → `turn(N)` に付く → stop で閉じる。21 秒後に stop → 閉じる（R、1a）
  - 残った `turn(T)`（T は stop で閉じている。`applyTurnOutcomesToEpisode` の throw を注入）→ status-helper・RC の `not-waiting` で閉じる（SH・RC、1b）
  - `reportPermissionRequestPending`・`reportQuestionPending` の後に `unattributed` の区間が `dialog-only` に付く（OC・R、1a）
- **追加の陰性対照**: 拒否された stop（R・OC・V2、1a）、同一ミリ秒の turn 層（R、1a）と push 層（P・RC、2・1b）、同じ本文の次の確認（RC、1b）、複数回の再取得（SH、1b）、世代交替（R・SH、1a）、claude-done の await 中の入れ替わりと body の読みの限界（CD、1a）、開始 hook だけ併用（CD・R、1a）、permission_replied の経路（R・OC・V2、1a）、poller が閉じない条件（AY、3）、旧形式のカードのマーク（P・SW、2）
- **人待ち**: menu の後に stop（R・OC・V2・AY・P、1b）、構造化確認 → 遅い開始 hook → 繰り返し取得（R・OC・V2・SH・P、1a・1b）
- **#3796**: wake → capture 失敗 → 再予約の間の rebind で hold が延びない（P・AY、2・1b）、replaced で新しい hold（P、2）、到着順の逆転（SW・P、2）
- **陽性対照（維持）**: UAT 1 回目の形（R・P、1a）、UAT 3/4/6/7 回目の形（R・RC・P、1a）、人が要る画面は約 9 秒（P・SH、1a 以降すべて）、閉じる edge は通知しない（R・P、1a）

---

## 5. #3796 との整合（規則 7）

[事実] #3796 は hold の開始時に予約 tick を 1 回だけ読み（`prompt-push-gate.ts:180`・`:204-209`）、その後は早まる方向にだけ読み直す（`:220-226`・`:249`）。

1. **hold の同一性は dedup と同じ混在の規則**: 「両方に ID があり等しい」か「片方に ID が無く since が等しい」なら同じ待ち。hold に ID が無く入力にあれば書き足す。新しい hold（予約 tick を読む）は、同じ待ちとみなせないときだけ
2. **rebind は hold を作り直さない**（I3）
3. **replaced は新しい hold**。古い区間の hold は `forgetAutoYesHold(key, { episodeId: old })` で落とす
4. **dedup は区間 ID**（混在の規則は 1 と同じ）
5. **reminder・再判定も区間 ID**。`replaced` を受けたら古い区間のタイマーを止め、解除通知は出さない
6. **抑止記録に区間 ID**。gate は ID があれば ID の一致、無ければ `at >= waitingSince`。gate 側は PR 2、書き手は PR 3。`refreshEpisodeSuppression`（`auto-yes-poller-receipt-log.ts:246-270`）は `episodeId` を引き継ぐ
7. **wait**: `current-output` に `autoYes.lastSuppression.episodeId` と `autoYes.waitingEpisodeId` を公開し、`wait.ts` の `activeSuppression`（`:252-264`）は両方が非 null で異なれば古い記録。どちらかが無ければ 60 秒の窓
8. `lastServerResponseTimestamp` は起点を後ろへずらすだけなので残す。区間の判定は `lastAnswer.episodeId`
9. Auto-Yes poller の #3796 の欄（`auto-yes-poller-state.ts:44-58`）には触らない

---

## 6. 実装の分割（実装の契約の起案元）

### 6.0 順序とリリースの止め方

- 4 本を **1a → 2 → 1b → 3** の順に develop へ入れる。**4 本を同じリリースに入れる**
- リリースの止め方（R3-7）:
  - 4 本は 1 回の /orchestrate の run で続けてマージし、間を空けない
  - Issue #3798 に 4 本のチェックリスト（PR 番号）を置き、4 本そろうまで Issue を閉じない。/release を実行する人は、develop に入った #3798 の PR がチェックリストと一致するかを確かめる（`gh pr list --search "3798 in:title" --state merged --base develop`）
  - `changelog.d/3798.md` は 1 本の断片として PR 1a で書き、2・1b・3 は同じ断片の 1 行を上書きして育てる（リリースノートには 1 エントリだけ出る）。1a だけが入った develop から切られても、断片の本文が「4 本のうち 1a」を名乗らないよう、各 PR は断片をその時点の develop の状態どおりに書く
- 1a だけの develop の既知の後退（ブラウザ無しで「答え → survey → stop」の survey が通知されない）は 1b で閉じる。この期間は同じ run の中に収める

### 6.1 PR 1a: 区間の ID と帰属、turn の遷移での同期的な終了、claude-done

**(1) 変更するファイル**
- `src/lib/session/waiting-episode-state.ts`（型・低水準の書き込み・版・`lastClosed`・resolver の登録。`observeWaitingEdge` は互換のまま）
- `src/lib/session/waiting-episode-binding.ts`（新設。`applyTurnOutcomesToEpisode`・`captureLegacyStopTarget`・`settleLegacyStop`・開く時点の binding の決定・resolver の登録）
- `src/lib/session/agent-event-turn.ts`（outcome を返す・`openDecision` の sessionId・`:701` の拒否・`decision-answered` は `releaseSettledDecision` だけ）
- `src/lib/session/agent-event-state.ts`（`recordAgentEvent` の末尾・`reportPermissionRequestPending`・`reportQuestionPending`・`beginAgentEventGeneration` から適用。新しい関数は export しない）
- `src/lib/hooks/agent-event-intake.ts`（復元の outcome の適用とログ）
- `src/app/api/hooks/agent-event/route.ts`（`agent-event-stop-applied` に `episodeEffect`）
- `src/app/api/hooks/claude-done/route.ts`
- `src/lib/push/waiting-push-notifier.ts`・`src/lib/session/waiting-episode-state.ts` の docblock の古い記述（§9）
- テスト（下）、`changelog.d/3798.md`

**(2) 受入基準（テスト名の案）**
- `tests/unit/session/waiting-episode-turn-table-3798.test.ts` — `T<n> × <列>: <動作>` を 189 ケース（テーブル駆動）。表の外は `waiting-episode-unmatched` の warn
- `tests/unit/api/hooks-agent-event-waiting-episode-3798.test.ts`
  - `agy: confirmation → answer → post_tool_use → stop closes the wait (no prompt-push-allowed at hold end)`
  - `agy: confirmation → answer → stop without post_tool_use closes the wait`
  - `agy: first turn (no previous turn) closes the wait in both orders`
  - `stop after scraper_evidence closed the turn closes turn(T) and unattributed(lastClosed=T)`
  - `#1: old session A stop while session B waits leaves B (id, since, hold end, push count)`
  - `#3/#7: stop recorded, await held, B opens / generation bumps — B survives the late return`
  - `claude parallel tools: tool A post_tool_use leaves tool B wait; permission_replied closes it`
  - `predicted decision expired after 20s: post_tool_use rebinds, stop closes`
  - `user_prompt_submit closes a leftover unattributed wait`
  - `interrupt resend closes P's wait; queued-notice restore rebinds N's wait to R`
  - `SessionStart after process-start keeps the screen wait and closes the others`
  - `rejected stop (other session / before generation) changes nothing`
  - `same-millisecond stop and turn start give two turn ids and two episodes`
  - `the closing listener reads the turn model after applyAwaitingInstructionTransition`
  - `positive: UAT run 1 / runs 3,4,6,7 shapes`、`positive: a human-required screen is allowed about 9 s in`、`negative: the closing edge itself notifies nothing`
- `tests/unit/hooks/sources/opencode-waiting-episode-3798.test.ts`・`opencode-v2-waiting-episode-3798.test.ts` — #1・#3・#6・#7、別 session の idle、`decision-answered` で閉じる、`reportQuestionPending` の後の rebind、permission の await 中の入れ替わり
- `tests/unit/api/hooks-claude-done-waiting-episode-3798.test.ts` — #5、`:58`・`:72` の await 中の 3 通り、`limit: body read swap closes the new wait`、開始 hook だけ併用
- 既存テストが期待を変えずに通ること（特に `tests/unit/session/waiting-episode-1786.test.ts`、`tests/unit/push/waiting-push-1790.test.ts`、`tests/unit/api/hooks-claude-done-delegation.test.ts`）。`:701` の変更が既存テストに固定されていれば、変えずに本文に無い指摘にする

**(3) 単独で develop に入っても壊れない理由**
- 区間に足すのは欄と閉じる経路だけで、既存の `observeWaitingEdge` の戻り値・edge の形（`waiting`・`since`・`kind`）は変わらない。新しい欄（`cause` 等）を読む購読者はまだ無い
- `replaced` はこの PR では出ない（観測の照合は 1b）。push 側は since のまま動き、区間が閉じたときの解除通知の動きは今と同じ
- 後退は §6.0 の 1 件（survey）と、解除が新しいカードを消す形が増えること。どちらも同じ run の 1b・2 で閉じる

**(4) 実装で設計から変えたこと（PR 1a の実装時に確定）**

既存テストの期待値を変えないために、型の置き場所を次のように変えた。規則の表・同期区間の境界・不変条件は変えていない。
- `getWaitingEpisode()` は `{ since, kind }` のまま返す（`tests/unit/session/waiting-episode-1786.test.ts` が `toEqual` で比べる）。`episodeId`・`binding`・`openedAt`・`boundAt`・`openedBy`・`promptScreenKey` は `getWaitingEpisodeRecord()` で読む。区間の付帯情報は store の区間オブジェクトを鍵にした WeakMap に置く（map を直接書き換えるテストがあるため、付帯情報の無い区間は読んだ時点で `unattributed` として扱う）
- `onWaitingTransition` の遷移は 7 つの欄のまま（同テストが `toEqual` で比べる）。`cause`・`episodeId`・`previousEpisodeId`・`closeReason` を足した遷移は、新しい購読 `onWaitingEpisodeTransition` で配る。`replaced` は既存の購読者には `waiting: true` の 1 回の edge として届く
- `recordAgentEvent` の戻り値は `{ recorded: true }` のまま（`tests/unit/session/turn-model.test.ts`・`late-session-start-1903.test.ts` が `toEqual` で比べる）。遷移の結果と区間への作用は `recordAgentEvent` の中で `applyTurnOutcomesToEpisode` に渡し、閉じたことは `waiting-episode-binding` が `waiting-episode-closed-by-turn` の info ログで出す。そのため `agent-event-stop-applied` に `episodeEffect` は足さず、`src/app/api/hooks/agent-event/route.ts` と `src/lib/hooks/agent-event-intake.ts` は変更しなかった
- `joinOpenTurnFromDuplicate` は真偽値のまま（`agent-event-state` が同じ関数を再 export していることをテストが確かめる）。復元の結果（`restored`）は、`waiting-episode-binding` が globalThis 経由で登録する outcome sink に turn model から渡す
- claude-done の tool id は `src/lib/hooks/sources/claude/tool-id.ts` の `CLAUDE_CLI_TOOL_ID` を使う（`'claude'` の文字列を新しく書かない）
- PR 1a の間の既知の動き: `screen` の binding を作る観測は PR 1b なので、起動直後の信頼確認などの区間も `session-start` の世代更新（T20）で閉じる。画面に残っていれば次の観測（status の問い合わせ・応答 poller）が新しい区間として開き直す（通知がもう 1 回出うる）。§6.0 の同じリリースの約束で 1b と一緒に出す

### 6.2 PR 2: push 側を区間 ID で照合

**(1) 変更するファイル**
- `src/lib/push/prompt-push-gate.ts`（hold の ID 化と混在の規則、抑止記録の ID による照合の読み）
- `src/lib/polling/auto-yes-suppression-state.ts`（型の欄 `episodeId?` の追加のみ）
- `src/lib/push/notification-dedup.ts`、`src/lib/push/push-sender.ts`（`waitingEpisodeId` を通す）
- `src/lib/push/waiting-push-notifier.ts`（`PendingWait.episodeId`・`replaced` の扱い）
  - 購読は `onWaitingEpisodeTransition` にする。旧 `onWaitingTransition`（7 欄）のままだと `replaced` が `waiting: true` の edge としか届かず、新しい待ちか同じ待ちかを since でしか判じられない（同じ since の `replaced` を同じ待ちとして古い hold のまま扱い、違う since なら古いタイマーを残したまま hold を作り直す）（PR 1a の実装レビュー P3-1）
  - 区間 ID は store から `getWaitingEpisodeRecord` で読む（`getWaitingEpisode` は §6.1 (4) のとおり `{ since, kind }` のまま）。O2（`response-checker`）が開いた区間も、edge の `episodeId` と、hold の終わり・分類の猶予・reminder の再判定で読む store の ID が同じになる（P3-1）
- `src/lib/push/resolution-push-notifier.ts`、`src/lib/push/prompt-card-state.ts`、`public/sw.js`
- テスト

**(2) 受入基準（テスト名の案）**
- `tests/unit/push/prompt-push-gate-episode-id-3798.test.ts`
  - `mixed: an id-less gate then an id-bearing gate on the same since make one hold and read the session-wait tick once`
  - `rebind keeps the hold end; replaced starts a new hold that reads the tick at its own start`
  - `suppression with episodeId matches by id; without it by at >= since`
  - `wake → capture failure → reschedule with a rebind in between does not extend the hold`
- `tests/unit/push/waiting-push-episode-id-3798.test.ts` — `same since, two episode ids notify twice with two holds`、`replaced cancels the old timers and sends no resolution`、`escalation re-reads by episode id`
- `tests/unit/push/cross-device-dismissal-episode-3798.test.ts` — `card mark keeps the last episode id in one write`、`legacy time-only mark reads as id-less`
- `tests/unit/pwa/sw-push-episode-3798.test.ts` — `resolution closes only its own episode card and re-shows a newer one silently`、`showNotification is called exactly once on every branch`、`id-less resolution keeps today's behaviour`
- 既存の `prompt-push-gate-*`・`waiting-push-*`・`cross-device-dismissal-2001`・`restart-card-state-2057`・`sw-push` が期待を変えずに通ること

**(3) 単独で develop に入っても壊れない理由**
- ID を渡さない呼び手（O2・opencode の質問 push・既存テスト）は since の比較のままで、混在の規則により ID つきの notifier と同じ hold・dedup にまとまる。#3796 の予約 tick は 1 回だけ読まれる
- `replaced` を受ける処理は入るが、発生するのは 1b から。旧形式のマーク・旧 sw.js・ID の無い解除は今の動き
- `sw.js` はどの分岐でも `showNotification` を 1 回呼ぶ（`userVisibleOnly` の契約を守る）

**(4) 実装で設計から変えたこと（PR 2 の実装時に確定）**

既存テストの期待値を変えないために、置き場所を次のように変えた。混在の規則・照合の順序は変えていない。
- 抑止記録の `episodeId?` は `AutoYesPolicySuppression` に足さず、同じファイルの `EpisodeScopedPolicySuppression`（`AutoYesPolicySuppression` を継承）に置いた。`AutoYesPolicySuppression` は `current-output` が公開する形で、キー集合を CLI の写し（`src/cli/types/api-responses.ts`）と等しく保つ型の検査（`tests/unit/cli/types/last-suppression-mirror-3822.test.ts`）があり、欄を足すと型検査が落ちる。gate はこの型で `episodeId` を読む。公開する形への追加は、書き手と CLI 側を変える PR 3 で行う
- カードのマークの区間 ID は、時刻の行（`push_prompt_card:<worktreeId>`、値は今までどおり時刻だけ）の隣の行 `push_prompt_card_episode:<worktreeId>` に、時刻の行と **同じ 1 つの INSERT 文** で書く（値は `<at>:<episodeId>`。ID が無ければ `<at>:`）。時刻の行の値を変えると `tests/unit/push/restart-card-state-2057.test.ts` の `persistedMark()` の期待（時刻の文字列）が変わるため。ID の行の時刻が時刻の行と違えば（旧い版のサーバーが時刻の行だけを書き換えた）ID 無しとして読む。旧い版のサーバーが書いたマーク（時刻の行だけ）も ID 無し
- `forgetAutoYesHold(key, wait)` の第 2 引数は、数値（since、#3776 のまま）か `{ since, episodeId }` を受ける。比較は混在の規則（`isSameWait`）
- `handleWaitingTransition` は ID つきの遷移と 7 欄の遷移の両方を受ける（既存テストが 7 欄で直接呼ぶ）。7 欄のときは store の区間の since が一致すればその ID を使う
- `sw.js` で別の区間のカードが 2 枚以上あるときは、`getNotifications` が最後に返したもの（最も新しいもの）を出し直す

### 6.3 PR 1b: 観測の照合と共通の画面の読み方

**(1) 変更するファイル**
- `src/lib/detection/waiting-screen-reading.ts`（新設）、`src/lib/detection/prompt-screen-key.ts`（新設。`partialAnswerScreenKey` を移す）
- `src/lib/polling/auto-yes-poller-state.ts`（re-export の 1 行のみ）
- `src/lib/session/waiting-episode-binding.ts`（観測の関数・表 O-1・O-2・前提の照合・I6）
- `src/lib/session/cli-session.ts`・`src/lib/tmux/tmux-capture-cache.ts`（`captureSessionOutputWithMeta`・`fetchStartedAt`）
- `src/lib/session/worktree-status-helper.ts`、`src/app/api/worktrees/route.ts`・`src/app/api/worktrees/[id]/route.ts`
- `src/lib/polling/response-checker.ts`（O2 の plan を `isDuplicatePrompt` の前に・ignored のときの扱い・gate と push に ID・C2）
- `src/lib/auto-yes-poller.ts`（`no_prompt` の観測: `screen` の open・rebind・閉じる）
- `tests/unit/guards/retired-tick-write-guard-3705.test.ts`（対象一覧への追加のみ）、テスト

**(2) 受入基準（テスト名の案）**
- `tests/unit/session/waiting-episode-observation-table-3798.test.ts` — 表 O-1・O-2 の全セルと前提 1〜3（テーブル駆動。O-2 の poller の `screen` 以外の行は ignored を確かめる）
- `tests/unit/lib/worktree-status-helper-waiting-episode-3798.test.ts`
  - `start taken before listSessions: a session started after the list keeps its wait`
  - `ABA: no wait at start, opened and closed during the capture, stale frame does not reopen`
  - `stale cached frame after a stop (human answered in tmux) does not reopen the same prompt`
  - `a wait past the 30-minute stale bound keeps id, since and push count`
  - `copilot 4+ option ask_user and opencode permission strip with a decision are not screen`
  - `a turn(T) left after its stop is closed by not-waiting`
  - `three polls on the same wait open one edge`
- `tests/unit/lib/polling/response-checker-waiting-episode-3798.test.ts`
  - `a stop during the capture: the same prompt is not reopened and its hash is not registered`
  - `a different prompt read during another closer's await still opens`
  - `the same text in the next turn opens a new wait through the real isDuplicatePrompt`
  - `a prompt after a scraper_evidence-closed turn with a different screen key is replaced`
- `tests/unit/polling/auto-yes-poller-screen-episode-3798.test.ts`
  - `answer → survey: poller opens/rebinds screen; stop leaves it; human answers; poller not-waiting closes it`
  - `a not-waiting frame fetched before the screen opened does not close it`
  - `a receipt-window-outside agy confirmation is not screen; stop closes the wait`
  - `status-helper and poller alternating six times: one opening edge, same id and hold end`
- 人待ちの対照（menu の後に stop、構造化確認 → 遅い開始 hook → 取得の繰り返し）
- 既存テストが期待を変えずに通ること（特に `tests/unit/lib/polling/response-checker-retired-tick-3705.test.ts`・`response-checker-waiting-push-1790.test.ts`・guard）

**(3) 単独で develop に入っても壊れない理由**
- 1a・2 の型の上に乗る。`replaced` は 2 の notifier が受けられる
- 観測が閉じる条件は今より狭くならない（status-helper・C2 は版の照合が足されるだけ）。閉じない区間は表 O-2 が binding を問わず閉じる
- O2 が見送るのは「閉じた区間と同じ確認を、閉じる前のフレームで読んだ」ときだけで、ハッシュを登録しないので次の tick で取り直せる
- 同じ turn の 2 つ目の確認は kept のまま（今と同じ。悪化ではない。3 で閉じる）

### 6.4 PR 3: Auto-Yes poller の終了・答えでの区間・2 つ目の確認・抑止記録・wait

**(1) 変更するファイル**
- `src/lib/auto-yes-poller.ts`（答えの送信の同期区間で `freshPrompt` の観測と `lastAnswer`・`screen` 以外の区間を閉じる）
- `src/lib/polling/auto-yes-poller-state.ts`（`lastAnswer` の追加）
- `src/lib/polling/auto-yes-suppression-state.ts`（書き込みで `episodeId`）、`src/lib/polling/auto-yes-poller-receipt-log.ts`（`episodeId` の引き継ぎ）
- `src/lib/session/waiting-episode-binding.ts`（`lastAnswer` を使う表 O-1・O-2 のセル）
- `src/lib/polling/response-checker.ts`（`lastAnswer` を渡す行）
- `src/lib/session/current-output-builder.ts`・`current-output-types.ts`、`src/cli/types/api-responses.ts`、`src/cli/commands/wait.ts`
- テスト。`prompt-push-gate.ts` は含まない

**(2) 受入基準（テスト名の案）**
- `tests/unit/polling/auto-yes-poller-answered-episode-3798.test.ts`
  - `no wait at answer time: the poller opens one and records lastAnswer; the cleared screen closes it`
  - `does not close: an unanswered wait, an answer to an earlier wait, a capture failure, an unclassified frame, a swap during the tick`
  - `poller-answered prompt types (opencode numbered choice, copilot ≤3 options): a second prompt with a different screen key in the same turn is replaced and held, not allowed at once`
- `tests/unit/cli/wait-suppression-episode-3798.test.ts` — `different episode ids make the suppression stale`、`missing ids fall back to the 60 s window`
- 保留ブランチの `auto-yes-poller-close-answered-wait-3798` の survey/picker・信頼確認・受信待ちの対照を、`lastAnswer.episodeId` で書き直したもの

**(3) 単独で develop に入っても壊れない理由**
- poller が閉じるのは自分が答えた区間だけで、`screen` の扱いは 1b のまま。gate は 2 で ID を読めるので、書き手が増えるだけ
- `wait` は欄が無いサーバーでは 60 秒の窓に戻る（互換）

---

## 7. 保留ブランチから流用するもの・捨てるもの

| 対象（`07610c745`） | 扱い | 理由 |
|---|---|---|
| `waiting-episode-close-no-browser-3798.test.ts` の UAT の再現・陽性対照・閉じる edge は通知しない対照 | 流用。agy の event の組に書き直す（1a） | 再現の形は UAT と一致 |
| 同ファイルの session A/B の対照 | 流用（1a） | 判定の場所が変わるだけ |
| `auto-yes-poller-close-answered-wait-3798.test.ts` の survey/picker・信頼確認・受信待ちの対照 | 流用（3）。答えの判定は `lastAnswer.episodeId` | 時刻の比較は規則 1 に反する |
| 同ファイルの `detectSessionStatus(...).status === 'waiting'` で menu を守る考え方 | `readWaitingScreen` にする（1b） | R1-1・R2-5 |
| `waiting-episode-close-async-stop-3798.test.ts` の await を止める仕掛け | 流用（1a。R 層にも同じ仕掛け） | 期待は一部変わる |
| `response-checker-ended-turn-wait-3798.test.ts`・`worktree-status-helper-ended-turn-wait-3798.test.ts` の仕掛け | 流用（1b） | 期待は ID で書き直す |
| `hooks-claude-done-delegation.test.ts` への追加 | 流用（1a）。「hook の turn が開いていれば閉じない」は捨てる | 開始 hook だけ併用で閉じられなくなる |
| #3796 との統合部分 | 流用（3） | 別関数で互いの中身を変えない |
| `waiting-episode-turn.ts` | 捨てる | 閉じる側が今の turn と時刻から推定している |
| `applyAgentStopEvent` の先頭での終了 | 捨てる | opencode・V2 では await の後 |
| `stopTurnOutcomes` Map | 捨てる | await を挟むと次の turn に読まれる |

---

## 8. 限界

- **claude-done の旧形式**: B の区間が開いた後に届いた旧 A の claude-done は B に当たる（同じ世代に hook の stop があれば印で止まる）。body の読み（`route.ts:34`）の間の入れ替わりも同じ
- **session ID の無い hook**: 破れ #1 と R1 残る順序 7 の保護は両方の session ID が要る
- **stop-without-turn**: session ID で区別できなければ `unattributed`・`dialog-only` の区間を閉じる
- **#3330 の重複と確認が重なったとき**: 印の無い複製で turn P の区間が閉じ、復元しても戻らない。確認が残っていれば次の観測が開き直す（通知がもう 1 回出うる）
- **遅れて届く `user_prompt_submit`**: 先に見えた確認の区間は T4 で閉じ、確認が残っていれば開き直す
- **観測者が 1 つもいない**: Auto-Yes が off でブラウザも無いと、回答の後の survey を誰も読まず、stop で閉じたまま次の問い合わせまで開かない。Auto-Yes が off なら開いた時点で通知は出ている
- **decision の記録が無い opencode の permission の帯**: `humanHeld` になり stop で閉じない（観測で閉じる）
- **同じ turn の同じ本文の 2 つ目の確認**: 画面キーが同じなので replaced にならない
- **Auto-Yes poller は `screen` 以外の区間を自分の答え無しに閉じない**（Issue の規則 3）。人が答えて stop も来ない区間は、ブラウザが無ければ残る（reminder が出る）
- **Service Worker の更新**: 端末の `sw.js` が更新されるまでは今の動き
- **プロセス再起動**: 区間はメモリにあり、再起動で消える

---

## 9. 本文に無い指摘（scope 外。直していない）

- `src/lib/push/waiting-push-notifier.ts:22-31` と `src/lib/session/waiting-episode-state.ts:14-18` の docblock は「`observeWaitingEdge` の呼び手は `worktree-status-helper` だけ」と書くが、今は `response-checker` も呼ぶ。PR 1a で書き直す
- `src/lib/session/worktree-status-helper.ts:875-878`: capture が throw すると区間を閉じる（#1786 の決定）。未分類の画面も同じ。既存テストの期待を変えないため、版の照合を足すだけにした
- `src/lib/hooks/sources/opencode/push.ts:172`: 質問の push が区間を開かず、since の一致だけで status-helper の通知と束ねている。PR 2 では since の互換を残す

---

## 10. 改訂履歴

### レビュー 1 回目（第 2 版、`dacf6c244`）

| 指摘 | 重さ | 処置 | 反映した節 |
|---|---|---|---|
| 1 humanHeld を受信窓を見ない共通関数で | P1 | 採用（第 3 版で定義を R2-5 のとおり直した） | 1.9、I9、規則 1 |
| 2 stop 以外で閉じた turn の区間 | P1 | 採用（第 3 版で `unattributed(lastClosedTurnId)` にも広げた） | T9、表 O-1 |
| 3 開く・rebind に開始時点の照合 | P2 | 採用（版。第 3 版で capture の時刻、第 4 版で画面キーの条件） | I5・I6 |
| 4 答えの後に開いた区間を poller が閉じない | P2 | 採用（答えの送信で区間を開く） | 6.4 |
| 5 Service Worker が置き換えを出さない分岐 | P2 | 採用 | 規則 5 |
| 6 dialog だけの判定と別 session の stop | P2 | 採用 | 2.2、T10 |
| 7 同じ turn の 2 つ目の確認 | P2 | 採用 | 表 O-1、6.4 |
| 8 `sessionNameSet` が古い | P3 | 採用 | 2.5 |
| 9 open-same-session → rebind | P3 | 採用（閉じる側） | T5 |
| 10 PR の分割 | P3 | 採用 | 6 |
| 11 カードのマークの一覧 | P3 | 一部採用（区間 ID 1 つ） | 規則 5 |
| 12 recordAgentEvent の他の経路 | P3 | 採用 | 1.8、2.5 |

### レビュー 2 回目（第 3 版、`d6be3df7c`）

| 指摘 | 重さ | 処置 | 反映した節 |
|---|---|---|---|
| 1 agy の event の組・`unattributed(lastClosed)` | P2 | 採用 | 1.7、T9・T11、3.1 |
| 2 (d) が古いフレームから開く | P2 | 採用（capture の時刻。第 4 版で画面キーの条件を足した） | I5・I6 |
| 3 30 分の stale を読んだ観測が置き換える | P2 | 採用 | 表 O-1 |
| 4 `unattributed` が次の turn へ漏れる | P2 | 採用 | T1〜T4、表 O-1 |
| 5 humanHeld の定義 | P2 | 採用（構造化の待ちの条件を足した） | 規則 1 |
| 6 ブラウザ無しの破れ #2 | P2 | 採用（同じリリース・poller の screen を 1b へ） | 6 |
| 7 PR 2 の時点の hold | P2 | 採用（混在の規則） | 5 |
| 8 `session_start` の世代更新が screen を閉じる | P3 | 採用（T20） | T19・T20 |
| 9 古いキャッシュで開き直す | P3 | 採用（I6） | I6 |
| 10 import の循環 | P3 | 採用（state は leaf） | 2.2 |
| 11 decisions-released の付け替え | P3 | 採用（閉じる。第 4 版で明示の回答だけに絞った） | T17 |
| 12 §1.7 の V2 の await | P3 | 採用 | 1.8 |
| 13 遷移を出す位置 | P3 | 採用 | 規則 2 |
| 14 指摘 7 の opencode の対照 | P3 | 採用 | T17、6.4 |

### レビュー 3 回目（第 4 版、確定版）

レビュー: `review-3798-design-3.md`。各指摘はコードを開いて事実を確かめてから処置した。7 件とも事実は正しく、全件採用。

| 指摘 | 重さ | 事実の確認 | 処置 | 反映した節 |
|---|---|---|---|---|
| 1 poller が `screen` を閉じられず詰まる | P2 | 正しい（第 3 版の ※4 (2)・I8。`waiting-push-notifier.ts:234-254` の gate は `kind` を見ない） | 採用。表 O-2 で poller も `screen` を閉じる（版の照合と `frameCapturedAt > openedAt`）。※4 (2) を削除。`openedAt` を区間に足した | 2.2、I8、表 O-2、6.3 |
| 2 I6 が別の新しい確認の open まで止める | P2 | 正しい（`lastClosedAt` は key に 1 つ。`isDuplicatePrompt` は判定と同時に登録: `prompt-dedup.ts:90-101`） | 採用。`LastClosed` を時刻と画面キーの組にし、見送るのは画面キーが同じか null のときだけ。O2 は plan を `isDuplicatePrompt` の前に置き、ignored なら保存・登録・push をせず `return false` | 2.2、I6、規則 8、6.3 |
| 3 T17 が並列ツールの `post_tool_use` で閉じる | P2 | 正しい（`agent-event-turn.ts:486` の一括 release） | 採用。outcome を `decision-answered` にし、`releaseSettledDecision` の明示の回答だけが出す | 1.6、2.2、T17・T18 |
| 4 列 D と ※1 の「起こらない」 | P2 | 正しい（`livePendingDecisions` が読み出しで 20 秒の予測を落とす: `agent-event-turn.ts:172-185`、`provisional-turn.ts:153-156`） | 採用。D は `recordTurnId` の一致だけで判定。T3 の D は付 turn(N)、T11 の D は閉。※1 は B の存在しない組み合わせだけに絞り、D の「起こらない」を削除（※5 で D に当たる区間が無い行を説明） | 1.6、T 表 |
| 5 既定「状態を変えない」の理由づけ | P2 | 正しい（第 3 版は閉じる側も既定に任せ、残った `turn(T)` が詰まる） | 採用。表 O-2 を binding を問わず定義し、既定は T 表と開く・置き換え・rebind の側だけ。§2.1 の 6・I11 の理由づけを書き直した | 2.1、I11、表 O-2 |
| 6 T15 と `report*Pending` | P3 | 正しい（`agent-event-state.ts:563`・`:626` は `recordAgentEvent` の外） | 採用（表の注と §2.5 に加え、2 関数の末尾で `decision-opened` を適用して rebind の取りこぼしを無くした。T2 の F も付け替えに変えた） | 1.6、1.8、2.2、T2・T15、2.5 |
| 7 1a だけでリリースが切られる | P3 | 正しい（develop からいつでも /release できる） | 採用。1 回の run で続けてマージ、Issue のチェックリスト、/release 前の確認コマンド、断片を 1 本で育てる | 6.0 |

---

### 最終レビュー（P3 3 件。PR 1a の契約で反映）

| 指摘 | 処置 | 反映した節 |
|---|---|---|
| P3-1 poller が screen を閉じる条件に、最後に binding が変わった時刻を入れる | 採用。区間に `boundAt` を持たせ、条件を `frameCapturedAt > max(openedAt, boundAt)` にした。PR 1a では `boundAt` を持たせるところまで（閉じる側は PR 1b） | 2.2、I2、表 O-2 |
| P3-2 「世代違いは前提 1 で先に落ちる」は誤り | 採用。前提 1 は観測の開始時点の世代を比べるもので、区間の `binding.generation` ではない。O-1 に「世代違いの区間」の行（replaced）を足し、テスト U にそのケースを入れる（観測の表のテストは PR 1b） | 表 O-1 の注、3.3 |
| P3-3 T2 の F の説明 | 採用。`unattributed` の区間を開いた後に dialog だけの記録ができた形は `lastClosedTurnId` が前の turn なので G（閉 superseded）に当たる。T15 で先に付け替えるので取りこぼしは throw のときだけ、と書き直した | ※2 |

## 11. 実装に進むときに実機で確かめること

レビュー 3 回目の末尾の 5 項目:

1. agy で `post_tool_use` と stop の到着順と間隔。survey が出る頻度と、人が答えた後の画面
2. claude の並列ツールの実行中に、permission の decision がどう記録・release されるか
3. 同じプロセスの最初の `SessionStart` が、信頼確認・hooks review の画面の前に来るか後に来るか（T20）
4. opencode で Auto-Yes が API で裁定したとき、permission の帯が画面に描かれるか（描かれて decision の記録が無ければ `screen` になる）
5. `tmux-capture-cache` の singleflight の待ち合わせで `fetchStartedAt` が正しく返るか

これまでの版から残る確認事項:

6. 区間の listener（`waiting-push-notifier`・`waiting-broadcast`・`relay-triggers`）が `recordAgentEvent` を同期で呼ばないか
7. opencode が他 session の `session.idle` をどこで落としているか（`opencode/history.ts:459` 付近）
8. `reportPermissionRequestPending` の経路で session ID を得られるか
9. `agent-event-turn.ts:701` の上書きを既存テストが固定しているか
10. `structured-decision.ts:712` が `:631`・`:634` の await と同じ関数の中にあるか
11. poller が copilot の 4 択以上の `ask_user` に答えるか
12. 保留ブランチのテストを develop の上で動かしていない（#3820 以降との差）
