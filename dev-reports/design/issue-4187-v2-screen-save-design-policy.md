# Issue #4187 設計方針: OpenCode V2 の返信を画面の読み取りで保存するか

- 対象: Issue #4187（#4175 の項目 3a を外した理由の残り）
- 基準: develop `45963ac7b`（行番号はこの時点で確認したもの）
- 段: 設計のみ。`src/` と `tests/` は変えない。実装は 2-4-4（Codex の事前レビュー）の後、別の契約で行う
- 版: 第 2 版（2026-11-06）。Codex の事前レビュー（`workspace/orchestration/runs/2026-11-06/prereview/review-4187.md`）を反映。指摘ごとの処置は §7
- 表記: **［事実］** は file:line を読んで確かめたこと。**［見立て］** は推論。**［未確認］** は確かめていないこと

---

## 0. 結論

**画面の読み取り（`isTurnComplete`）では V2 の返信を保存しない。今の動き（V2 は画面では完了を返さない）を設計として確定する。**
live でない間の返信は、画面ではなく **V2 の専用サーバーの文書（`GET /api/session/{id}/message`）を後から読む既存の経路**に任せ、その経路を再接続のときにも走らせる（**回復の同期**）。回復の同期は、範囲・失敗時の再試行・session の取り違え・接続の判定を §2.2 の条件で定める。

この Issue で扱うのは**履歴の保存だけ**である。同じ「live でない間のターン」に関わる **relay への完了の知らせ**（指摘 1）と **失った Stop に対する `wait`**（指摘 2）は、現行からある別の欠落として追跡 Issue に回す（§6）。履歴の保存・relay・`wait` は、それぞれ別の受入条件として扱い、この Issue の受入基準は履歴の保存だけを言う。

`--standalone`（CommandMate が購読する専用サーバーの経路が無い）と、自分で終わった購読の返信は**記録しない**を仕様とする。そのとき返信を読めるのは**ターミナルの画面だけ**で、チャット面には出ない（第 1 版の「チャット面には出る」は誤り。§2.3）。利用者がその場で気づける表示は追跡 Issue に回す（§6）。

理由の要点（詳細は §1・§3）:

1. live でない状態のうち `lost`（切断・再接続待ち）は、後で V2 の文書から **同じターンが `oc-turn:<user message id>` の鍵で書かれる**。画面で保存した行には この鍵が無いので、両方が書くと**同じターンが 2 行になる**。
2. 画面で保存するには Issue の問題 1〜3（開始位置・echo の境界・長い返信の頭）を全部直す必要があり、どれも V2 の実測で「本文の引用」に負ける形をしている。得られるのは `--standalone` の返信だけで、本番の起動では劣化（warn・agent-health の不合格）として扱われている。
3. 画面の読み取りで V2 が完了を返さないことは、状態検出（`endsWithTurnComplete`）とは独立している。保存しないと決めても状態表示は壊れない。ただし `wait` の完了は Stop に依存し、切断で Stop を失ったときの `wait` は別の欠落として残る（§6 T2）。

---

## 1. 現状の事実

### 1.1 画面の読み取りの保存の経路

- ［事実］`isTurnComplete` に V2 の分岐が無い: `src/lib/polling/response-checker-extraction-steps.ts:599-653`。
- ［事実］V2 の chrome の境界（#4175 の 3b）は部分の抽出にしか届かない: 同 `:83-91` のコメント。
- ［事実］V2 が画面で完了しないことはテストで固定されている: `tests/unit/detection/tools/opencode-v2/pattern-anchors-4175.test.ts:136`（実測 13 画面 × cursor 2 通り）。同じ describe で状態検出（`endsWithTurnComplete`）は完了と読むことも固定。
- ［事実］保存に進むのは `extractResponse` の結果が `isComplete` のときだけ: `src/lib/polling/response-checker.ts:756-796`。
- ［事実］対話のプロンプトの経路: 早期確認（`response-checker.ts:536-554`）は V2 を含まない。後段（`:575`、`cliToolId !== 'opencode'`）は V2 も通るが、#4184 のコミット本文の実測（V2 の fixture 52 枚 × cursor 3 通りで完了 0 件）で完了にならない。
- ［事実］画面の保存の後にだけ relay の完了を知らせる: `response-checker.ts:1334`・`:1374`（`onRelayTurnCompleted(..., false)`）。V2 はここに来ない。

### 1.2 Issue の問題 1〜3 の実コードとの照合

| # | Issue の記述 | 実コード | 判定 |
|---|---|---|---|
| 1 | `response-extractor.ts:215` の alternate screen の分岐に V2 が無い | `src/lib/response-extractor.ts:215` `if (cliToolId === 'opencode' \|\| cliToolId === 'copilot')` | 合っている |
| 1 | `ALTERNATE_SCREEN_CLI_TOOLS` に V2 は既にある、`lineCountIsCursor` は false | `src/lib/cli-tools/types.ts:42-53`（`'opencode-v2'` あり、#2934）、`response-checker.ts:815` | 合っている。**#4184 のコミット本文の「`types.ts:42` に opencode-v2 が無い」は誤り** |
| 2 | echo の境界 `findOpencodeV2UserEchoEnd` | develop に無い（#4184 で外した）。`findRecentUserPromptIndexInFrame`（`response-checker-extraction-steps.ts:123`）に V2 の分岐は無い | 合っている |
| 3 | 蓄積は opencode・copilot だけ | `response-checker.ts:747-755` | 合っている |
| 3 | `openCodeCleanLines` は opencode だけ | `response-checker.ts:500`、`turnHeadTruncated` は `response-checker-extraction-steps.ts:794-799` | 合っている |
| 3 | 先頭の補完 | `cleanCompletedResponse` の V2 の分岐は無い: `response-checker.ts:1095-1116` | 合っている |

### 1.3 イベントストリームの経路（V2 の構造化履歴）

- ［事実］画面の保存は、push の書き手が live の間は止まる: `response-checker.ts:1423-1458`、`:1490`。V2 の probe は `src/lib/polling/structured-history-gate.ts:460-464`、判定は `:482` 以降。
- ［事実］V2 の「live」は `liveness.state === 'live'` だけ: `src/lib/hooks/sources/opencode-v2/subscription.ts:134-136`。
- ［事実］V2 の返信は、ストリームのターン終了（`session.execution.succeeded|failed|interrupted`）を合図に文書を読んで書く: `history.ts:86-90`、`subscription.ts:505-515`（`recordOpencodeV2TurnEnd`）、`:439-453`（`deliver` が毎フレームで呼ぶ）。
- ［事実・第 2 版で訂正］**読む範囲は「閉じた全ターン」ではない。**`readRecentMessages`（`history.ts:289-306`）は新しい側からページを読み、**そのページに `user` メッセージが 1 つでもあれば止まる**（`:300-303`）。上限は `MAX_OPENCODE_V2_HISTORY_PAGES = 5`（`:104`）。したがって、保存されていない古いターンの `user` が前のページにあると、そのターンは読まれない。読んだ範囲のうち閉じたターンを新しい 50 本まで書く（`:429-432`）。
- ［事実］読みの失敗: 最初のページが読めないと null（`:298`）→ `syncOpencodeV2History` は warn を出して **0 を返す**（`:403-413`）。書いた 0 件と区別できない。再試行は無い。
- ［事実］鍵は `oc-turn:<user message id>`、既にあれば書かない: `history.ts:337-345`。同じインスタンスの同期は直列: `serialize(opencodeV2KeyOf(target))`（`:391`）。
- ［事実］model の latch は `isCurrent()` が true のときだけ: `history.ts:415-425`。`isCurrent` は購読の寿命だけを見る（`subscription.ts:456-458` `isCurrentSubscription`）。同じ購読の中で session が替わっても、遅れて終わった前の session の同期が latch できる。
- ［事実］`history.ts` の保存は DB への書き込みと `broadcastMessage` だけで、relay の完了は知らせない（`history.ts:347-366`、broadcast は `:357`）。`onRelayTurnCompleted` の呼び手は `response-checker.ts:1334`・`:1374` と `structured-history-gate.ts:629`（pull の読み手）だけ（`git grep -n onRelayTurnCompleted -- src`）。Stop の受け手の履歴処理は pull でない道具では抜ける（`src/lib/hooks/stop-history-capture.ts:375`）。
- ［事実］画面の保存は `requestId` に `claudeMetadata?.requestId`（V2 では undefined）を渡す: `response-checker.ts:1351-1361`（保留の経路は `:1313`）。画面の行と文書の行は鍵で突き合わせられない。
- ［事実］状態の遷移（`SubscriptionState`、`subscription.ts:82-93`）:
  - 開いた直後 `unknown`（`:176`）。接続できたら `openOpencodeV2EventStream` の直後に `markAlive`（`:318`）で `live`、続いて `attempt = 0`（`:319`）、そして pending の resync を await する（`:324-326`）。resync のフレームも `deliver` を通る。heartbeat・フレームごとにも `markAlive`（`:329`）。
  - ストリームが切れたら `lost`（`:339`）→ 待ってから再接続（`runStream` のループ）。
  - 自分で終わると `lost` のまま `endedLiveness` に残る（`:223-237`）。閉じると消える（`closeOpencodeV2Subscription`、`:191-`）。
- ［事実・第 2 版で訂正］`--standalone` は「サーバーが無い」のではなく、**CommandMate が購読する専用サーバー（wrapper ＋ port ＋ password）の経路が無い**形（`source.ts:85-95` のコメント「a private server with no structured events」）。port の割り当てが無いとき、または launch.sh / パスワードのファイルが無いときに落ちる: `source.ts:104-126`。port が null のとき `subscribe` は購読を開かず `{ state: 'unknown' }` を返す: `source.ts:327-330`。agent-health は `--standalone` の起動行を不合格にする: `src/lib/agent-health/server-events.ts:101-115`。
- ［事実］スケジュールの実行は別経路の `opencode2 run --standalone --format json`（`src/lib/session/claude-executor.ts:301`）。この設計の「記録しない」の対象は**対話の TUI だけ**で、スケジュールの実行は含まない。
- ［事実］`wait` は、hook がターンの始まりを報告したインスタンスでは Stop（`lastStopEventAt`）が来るまで完了を返さない: `src/cli/commands/wait-turn-boundary.ts:193-197`、`src/cli/commands/wait.ts:826-840`。孤児のターンの解放（`wait.ts:766-`）は、最新のプロンプトの後に Stop があることを条件にするので、最新のターンの Stop を失った場合は解放されない［見立て: 条件の読み。実機では見ていない］。
- ［事実］チャット面の進行中の本文は claude だけ: `src/lib/session/chat-turn-progress.ts:415`（`if (cliToolId !== 'claude') return;`）。呼び手は `src/lib/session/current-output-builder.ts:201` の 1 か所だけ（`git grep -n 'publishChatTurnProgress('`）で、V2 の進行中の本文を出す経路は無い。

### 1.4 live でない状態の分類

| 状態 | どう起きるか | 返信を後で書く者 | 画面で保存したら |
|---|---|---|---|
| A. `lost`（再接続待ち） | サーバーが一時的に応答しない、ストリームが切れた | 現状: 再接続後、その session の次のターン終了で同期（範囲は §1.3 の制限つき） | 次の同期で `oc-turn:` の行が別に書かれ、同じターンが 2 行 |
| A'. 再接続後にターン終了が来ない | 最後のターンの途中で切れ、その後に送信が無い | 現状: **無い**（この Issue で塞ぐ） | 1 行（後で送信すると 2 行） |
| B. `unknown`（開いた直後〜初回の接続） | `openOpencodeV2Subscription` から最初の接続まで | ある（接続後の同期） | A と同じ |
| C. `--standalone`（port null） | port の範囲切れ・状態 dir に書けない | **無い** | 1 行 |
| C'. `--standalone`（port あり・launch.sh / パスワード欠け） | `source.ts:117-125` | 無い。購読は使われない port に向いて `lost` を繰り返す［見立て］ | 1 行 |
| D. 自分で終わった購読（`endedLiveness`） | パスワードのファイルが消えた・port の持ち主が変わった | 無い | 1 行 |
| E. CommandMate の再起動 → reattach | `reattach.ts` が購読を開き直す | 再起動の間に終わったターンは、次のターン終了の同期で（§1.3 の制限つき）。session id を知らないので回復の同期は走らない | A と同じ |

［見立て］A/B/E と C/C'/D は、poller から見える `liveness` だけでは区別できない。

---

## 2. 決定（A 案: 画面では保存しない）

### 2.1 画面の読み取り

- `isTurnComplete` に V2 の分岐を**足さない**。`pattern-anchors-4175.test.ts:136` の固定をそのまま仕様とする（describe は消さない）。
- Issue の問題 1〜3 は**直さない**。直さない理由を、該当の 3 か所のコメントで V2 を名指しして書く（実装の契約で）:
  - `response-extractor.ts:208-218`: V2 は alternate screen だが、完了の抽出に来ないのでこの枝に入れない（#4187）。
  - `response-checker.ts:745-755`: V2 は完了を返さないので蓄積しない（#4187）。
  - `response-checker-extraction-steps.ts:83-91`: 既存の「partial only」のコメントに #4187 の決定を参照で足す。

### 2.2 回復の同期（live でない間のターンを、再接続のときに書く）

守る条件（C1〜C8）。どれも §5 のテストの陽性・陰性で確かめる。

- **C1 接続の履歴を明示する（指摘 5）。**`SubscriptionState` に `connectedOnce: boolean` を足す。`openOpencodeV2EventStream` が成功した直後、`markAlive` より前に読み、読んだあと true にする。**回復の同期を始めるのは「成功した接続」のうち `connectedOnce` が既に true だったもの**（＝接続した後に切れて、また接続できた）だけ。`attempt` は使わない（`:319` で 0 に戻り、初回の接続までの失敗と区別できない）。heartbeat・フレームごとの `markAlive`（`:329`）は契機にしない。
- **C2 1 回の再接続につき 1 回。**回復の同期は `runStream` のループの 1 回の成功した接続につき 1 度だけ予約する。
- **C3 resync の後、購読がまだ自分のものか確かめる（指摘 5）。**`resyncOpencodeV2Pending` の await（`:324-326`）の後で `isCurrentSubscription(state)` が false なら、回復の同期を始めない。始めた後で閉じられた・入れ替わった場合は、既存の方針（行は書く・model の latch はしない、#3733）を保つ。
- **C4 回復の対象と、いまの session を分ける（指摘 4）。**
  - `currentSessionId: string | null` — `deliver` がフレームの session id で更新する（resync のフレームも含む）。model を latch してよい session を表す。
  - `recoverySessionIds: Set<string>` — **ストリームが切れた時点**（`:339` で `lost` にする所）で `currentSessionId` を加える。resync で別の session（B）のフレームが来ても、切れる前の A はこの集合に残る。
  - 回復の同期は集合の各 session を順に同期し、**読みが成功した session だけ**を集合から外す。
- **C5 model の latch は「いまの session」の同期だけ（指摘 4）。**`syncOpencodeV2History` に渡す `isCurrent` を「購読が自分のもの **かつ** `currentSessionId === 同期している session`」にする。通常のターン終了の同期にも同じ条件を使う（遅れて終わった A の同期が、B に替わった後に A の model で表示を戻さない）。
- **C6 回復の範囲を定める（指摘 3）。**回復の同期は、通常の同期（新しい側のページで `user` を見たら止まる）ではなく、**「既に History にある `oc-turn:` の `user` に出会うまで」前のページを読む**読み方にする。上限は既存の `MAX_OPENCODE_V2_HISTORY_PAGES`（5 ページ）と `MAX_OPENCODE_V2_SYNCED_TURNS`（50 本）をそのまま使い、上限に達したら読みを止めて warn `opencode-v2-history-recovery-truncated`（session id・読んだページ数）を出す。保証する範囲は「5 ページ以内にある、閉じた未保存のターン」と書く（全件は保証しない）。このため `history.ts` を変える（第 1 版の「`history.ts` は変えない」を改める）。
- **C7 失敗したら限られた回数だけやり直す（指摘 3）。**回復の同期は「読めなかった」と「書く行が 0 件だった」を区別する（`history.ts` の内部で結果に `unreadable` を持たせる。公開の `syncOpencodeV2History` の戻り値の型は変えない）。読めなかった session は集合に残し、2 秒・5 秒・15 秒の 3 回までやり直す（タイマーは購読の `lifetimeController` で止まる）。やり直しの間に次の再接続が来たら、その再接続の 1 回にまとめる（C2）。3 回とも失敗したら warn `opencode-v2-history-recovery-failed` を出して集合から外す（無制限に続けない）。次にその session のターン終了が来れば、通常の同期が新しい側から読む。
- **C8 二重に書かない。**鍵 `oc-turn:` と既存の直列化（`history.ts:337-345`・`:391`）で、回復の同期と通常の同期が重なっても行は 1 本、`broadcastMessage` も 1 回。

寿命と消える条件:

| 値 | 生まれる | 変わる | 消える |
|---|---|---|---|
| `connectedOnce` | 購読を開いたとき false | 最初の成功した接続で true | 購読と一緒（close・自分で終わる）。reattach で開き直すと false から |
| `currentSessionId` | session id を持つフレーム（resync を含む）を最初に受けたとき | 別の session id のフレームを受けたとき | 購読と一緒。`endedLiveness` には残さない |
| `recoverySessionIds` | ストリームが切れた時点 | 回復の同期で読めた session を外す。3 回失敗で外す | 購読と一緒。閉じたらやり直しのタイマーも止まる |

同じ値を読む他の経路: 3 つとも新設で、読むのは回復の同期と latch の条件だけ。usage の更新（`refreshOpencodeV2UsageOnFrame`）は今どおりフレームの session id を読む（変えない）。

### 2.3 記録されない状態（C / C' / D）と、読める面の正しい説明（指摘 6）

- **記録しない**を仕様とする（C・C'・D の対話 TUI。スケジュールの `run --standalone` は対象外、§1.3）。
- 読める面（第 1 版の誤りを直す）: **ターミナルの画面だけ**（PC のターミナル、スマホのターミナル、`commandmate capture`）。チャット面（ChatSurface）は保存された行と、claude の進行中の本文しか出さないので、記録されない V2 の返信はチャット面にも History にも出ない（§1.3 の `chat-turn-progress.ts:415`）。
- E（reattach の直後に session id を知らない）と、C6 の上限を超えた分も「記録されないことがある」範囲に含めて説明する。
- docs（実装の契約）: `docs/user-guide/opencode-v2.md`（§2 の `--standalone` の段落 `:40-41` と、注意の節 `:111`）と `docs/en/user-guide/opencode-v2.md`（`:42`・`:122`）に、上の 3 点（記録しない・読めるのはターミナルだけ・スケジュールは別）を足す。
- その場の利用者への表示（バッジ・告知）は、この Issue では入れない（§6 T3）。

### 2.4 状態の遷移（決定後）

```
           open                 connect ok (connectedOnce:=true)            stream ends
 (none) ─────────▶ unknown ───────────────────────────────▶ live ─────────────────────────▶ lost
                     │                                          ▲      recoverySessionIds += current │
                     │                                          │                                 │
                     │                                          │  connect ok かつ connectedOnce   │
                     │                                          └─────────────────────────────────┘
                     │                                            → resync → isCurrent なら回復の同期（C1〜C8）
                     │ port null（standalone）
                     ▼
             購読なし（unknown のまま）── 返信は記録しない（読めるのはターミナルだけ）
 lost ── password 無し / port の持ち主が変わった ──▶ ended（endedLiveness）── 記録しない
```

画面の読み取り（poller）は、どの状態でも V2 の返信を保存しない。

### 2.5 全経路の一覧（指摘「全経路」）

| 区分 | 経路 | この Issue での扱い |
|---|---|---|
| 起動 | 通常の attach（wrapper ＋ port ＋ password） | 変えない。初回の接続は回復の同期の契機にしない（C1） |
| 起動 | 初回の接続が失敗した後の成功 | 初回と同じ扱い（`connectedOnce` が false のまま） → 回復しない（C1、テスト R3b） |
| 起動 | port なし（C） | 記録しない（§2.3） |
| 起動 | wrapper・password 欠け（C'） | 記録しない（§2.3） |
| 継続 | 通常のターン終了 → 同期 | 変えない。latch の条件だけ C5 |
| 継続 | 切断・watchdog → 再接続 → pending の resync → 回復の同期 | C1〜C8 |
| 継続 | その間の通常のフレーム | `currentSessionId` を更新。回復の同期と重なっても C8 |
| 寿命 | close → 再 open | 新しい購読は空から（R5） |
| 寿命 | 自分で終わる（D） | 記録しない。やり直しのタイマーも止まる |
| 寿命 | CommandMate の再起動 → reattach（E） | session id を知らないので回復しない。§2.3 で説明、§6 T4 |
| 寿命 | 同じ購読の中で session が替わる | C4・C5 |
| 読み手 | 履歴 DB → PC・スマホの History / チャット面・SessionTile・CLI の返信の読み取り | 行の形は既存の `oc-turn:` と同じ。回復した行も同じ経路で見える（`broadcastMessage`） |
| 読み手 | relay の候補の評価 | **扱わない**。現行でも `history.ts` は relay に知らせない（§1.3）。§6 T1 |
| 読み手 | Stop → `wait`・タスク処理 | **扱わない**。回復の同期は `lastStopEventAt` を書かない。§6 T2 |
| 読み手 | model の latch → 表示・変更の知らせ | C5 |
| 読み手 | usage の更新 | 変えない |
| 別経路 | スケジュールの `run --standalone`（`claude-executor.ts:301`） | 対象外（§1.3） |

---

## 3. 退けた案（B 案: 画面で保存する）と、その場合に要るもの

1. **live でない状態の区別**（§1.4）: A/B/E では保存せず、C/C'/D だけ保存する。`liveness` では区別できない。画面の行に V2 の user message id を付けることもできない（画面に id は出ない。`grep -lE 'msg_|ses_' tests/fixtures/opencode-v2-live-4175/*.txt` は 0 件）。
2. 問題 1: `resolveExtractionStartIndex`（`response-extractor.ts:215`）と `findRecentUserPromptIndexInFrame`（`response-checker-extraction-steps.ts:123`）に V2 を足す。
3. 問題 2: echo の境界を本文の引用で取り違えない読み方（`quote-footer-done.txt` に負けない）。
4. 問題 3: 蓄積（`response-checker.ts:747`）・`openCodeCleanLines`（`:500`）・`cleanCompletedResponse`（`:1095`）に V2 を足し、`turnHeadTruncated` を返す（`long-done.txt` は頭の欠けを必ず通る）。

この重さに対して得られるのは C/C'/D の返信だけなので、A 案を採る。

---

## 4. 実装の範囲（次の契約）

| ファイル | 変更 | 条件 |
|---|---|---|
| `src/lib/hooks/sources/opencode-v2/subscription.ts:82-93` | `connectedOnce`・`currentSessionId`・`recoverySessionIds` を足す | C1・C4 |
| `src/lib/hooks/sources/opencode-v2/subscription.ts:288-350`（`runStream`） | 切断で集合に加える（`:339`）／成功した接続で `connectedOnce` を読む（`:318` の前）／resync の後に `isCurrentSubscription` を確かめて回復の同期を予約（`:326` の後）／やり直しのタイマー | C1・C2・C3・C4・C7 |
| `src/lib/hooks/sources/opencode-v2/subscription.ts:439-453`（`deliver`）・`:505-515`（`recordOpencodeV2TurnEnd`） | `currentSessionId` の更新、latch の条件（`isCurrent` に session の一致を足す） | C4・C5 |
| `src/lib/hooks/sources/opencode-v2/history.ts:289-306`（`readRecentMessages`）・`:385-452`（`syncOpencodeV2History`） | 回復用の読み方（既にある `oc-turn:` まで前へ、上限 5 ページ）と、内部の結果に `unreadable` を持たせる。公開の戻り値の型は変えない | C6・C7・C8 |
| `src/lib/response-extractor.ts:208-218` | コメントだけ | §2.1 |
| `src/lib/polling/response-checker.ts:745-755` | コメントだけ | §2.1 |
| `src/lib/polling/response-checker-extraction-steps.ts:83-91` | コメントだけ | §2.1 |
| `docs/user-guide/opencode-v2.md`・`docs/en/user-guide/opencode-v2.md` | 記録しない状態・読めるのはターミナルだけ・スケジュールは別 | §2.3 |
| `changelog.d/4187.md` | 1 エントリ（`<!-- ### Added -->`） | 契約 |
| `tests/unit/hooks/sources/opencode-v2/subscription-recovery-4187.test.ts`（新規） | §5.1 | — |
| `tests/unit/hooks/sources/opencode-v2/history-recovery-4187.test.ts`（新規） | §5.2 | — |
| `tests/unit/lib/polling/response-checker-opencode-v2-no-scrape-4187.test.ts`（新規） | §5.3 | — |

scope の外（直さない）: `src/lib/cli-tools/types.ts`、poller の保存の経路、relay（§6 T1）、`wait`（§6 T2）、UI（§6 T3）。

---

## 5. 確かめるテスト（陽性と陰性）

**作り方（第 2 版で訂正）**: 既存の `subscription.test.ts`（`:56-60`）と `history.test.ts`（`:91-95`）は fetch のモックではなく**ローカルの HTTP サーバー**（`createServer`）で V2 のサーバーを立てている。新しいテストもこれに倣う（`/api/event` の SSE を開け閉めして切断・再接続を作り、`/api/session/{id}/message` のページを返す）。DB は既存の history のテストの作り方に合わせる。

### 5.1 回復の同期（`subscription-recovery-4187.test.ts`）

| # | 種類 | 手順 | 期待 |
|---|---|---|---|
| R1 | 陽性（直す前に落ちる） | live で `ses_A` のフレーム → ストリームを切る → 切れている間に `ses_A` のターン 2 が閉じる（文書にだけある）→ 再接続、その後フレームは来ない | ターン 2 の `oc-turn:` の行が 1 本、本文は `renderOpencodeTurn` と一致（直す前は 0 本） |
| R2 | 陰性（逐次で二重にならない） | R1 の後、`ses_A` のターン終了フレームで通常の同期 | 行は増えない |
| R2b | 陰性（重ねて二重にならない） | 再接続の回復の同期の文書の読みをサーバー側で止めておき、その間に `ses_A` のターン終了フレームを流して通常の同期を起こし、その後読みを返す | 行 1 本・`broadcastMessage` 1 回・model の変更の知らせ 1 回以下 |
| R3 | 陰性 | 初回の接続（`unknown` → `live`） | 回復の同期は起きない（文書の読みはフレームによるものだけ） |
| R3b | 陰性（初回の失敗の後の初成功） | 最初の probe を 503 で返し、2 回目で接続 | 回復の同期は起きない |
| R3c | 陽性 | 接続 → 切断 → 再接続 → 切断 → 再接続 | 回復の同期はそれぞれの再接続で 1 回ずつ（計 2 回） |
| R3d | 陰性（heartbeat） | live のまま heartbeat を何度も受ける | 回復の同期は起きない |
| R4 | 陰性 | 再接続したが、その購読で session id を持つフレームを一度も受けていない | 文書を読まない |
| R5 | 陰性（寿命） | close → 同じ target で開き直し → 切断 → 再接続 | 前の購読の session を読まない |
| R6 | 陽性（resync で上書きされない） | `ses_A` のフレーム → 切断（A に未保存のターン）→ 再接続、resync が `ses_B` のフレームを返す | A の未保存のターンが書かれる |
| R6b | 陰性（latch） | `ses_A` の同期の読みを止めておき、その間に `ses_B` のフレームを受け、その後 A の読みを返す | A の行は書かれる。model の latch は A の model にならない |
| R7 | 陰性（購読の入れ替わり） | resync の await 中に購読を閉じる | 回復の同期は始まらない（文書の読み 0 回） |
| R7b | 陰性（既存の方針） | 回復の同期の読みの最中に購読を閉じる | 行は書かれる・latch はしない |
| R8 | 陽性（やり直し） | 再接続の回復の同期の最初の読みを 500、2 回目を 200 | 2 回目で行が書かれる |
| R8b | 陰性（打ち切り） | 4 回とも 500 | 読みは 3 回のやり直しで止まり、warn `opencode-v2-history-recovery-failed` が 1 回 |
| R8c | 陰性（閉じたら止まる） | やり直しの待ちの間に close | それ以降の読み 0 回 |

### 5.2 回復の範囲（`history-recovery-4187.test.ts`）

`tests/fixtures/opencode-v2-history-2940` の実測の文書を元に、ページを分けて返す。

| # | 種類 | 文書 | 期待 |
|---|---|---|---|
| H1 | 陽性（直す前に落ちる） | 未保存のターンの `user` が 2 ページ目、1 ページ目に新しいターンの `user` | 回復の読みで両方書かれる（通常の読みでは古い方が書かれないことも同じテストで示す） |
| H2 | 陽性 | 未保存のターンが 3 本 | 3 本とも古い順に書かれる |
| H3 | 陰性 | 既に保存済みの `oc-turn:` の `user` が 2 ページ目にある | 3 ページ目は読まない。保存済みは増えない |
| H4 | 陰性（上限） | 保存済みに出会わないまま 6 ページ以上ある | 5 ページで止まり、warn `opencode-v2-history-recovery-truncated` |
| H5 | 陰性（未完了） | 最新のターンが `idle` で閉じていない | 書かない |
| H6 | 陰性（型） | 公開の `syncOpencodeV2History` | 戻り値は今どおり書いた行の数 |

### 5.3 画面の読み取りが V2 を保存しない（`response-checker-opencode-v2-no-scrape-4187.test.ts`）

既存の固定は `extractResponse` の層（`pattern-anchors-4175.test.ts:136`）だけなので、`checkForResponse` の層で固定する。実測の画面を使う。

| # | 種類 | 画面 | liveness | 期待 |
|---|---|---|---|---|
| S1 | 陰性 | `opencode-v2-live-4175/long-done.txt`（echo が画面の外） | `lost` | `createMessage` 0 回・保留 0 件・`onRelayTurnCompleted` 0 回 |
| S2 | 陰性 | `quote-footer-done.txt` | `unknown`（standalone） | 同上 |
| S3 | 陰性 | `interrupted.txt` | `lost` | 同上 |
| S4 | 陰性 | `idle-after-turn.txt` | `unknown` | 同上 |
| S5 | 陰性 | `opencode-v2-live-2945/turn-done-after-approval.txt`・`question-answered.txt` | `lost` | 同上 |
| S6 | 陰性（取り直し） | S1 の画面を cursor 0 → 行数で 2 回 | 任意 | 2 回とも 0 回 |

S1〜S6 は今のコードで通る（仕様の固定）。陽性の対照は、作業中に一時的に `isTurnComplete` に V2 を入れて S1 が `createMessage` 1 回になることを確かめ、コミット本文に書く（ファイルは戻す）。

### 5.4 Issue の受入基準 2 の順について

受入基準 2 は「保存するなら」の条件つきで、A 案では画面の保存は 0 件で一定（S1〜S6）。「live でない → live への復帰」の件数と本文は R1・R2・R2b・R6・R8 で確かめる。

---

## 6. 追跡 Issue の候補（この Issue で直さない、現行からある欠落）

| # | 題 | 残す場所 | 誤る条件 | この Issue で直さない理由 |
|---|---|---|---|---|
| T1 | OpenCode V2 の構造化履歴の行が relay の完了として知らされない | `src/lib/hooks/sources/opencode-v2/history.ts:347-366`（保存と broadcast だけ）、呼び手の無い `src/lib/relay/relay-triggers.ts:63`（V2 から）、`src/lib/hooks/stop-history-capture.ts:375` | V2 を relay の送り先にしたとき、返信は History に書かれるが relay の完了の知らせが来ない。live の間も同じ［見立て: `git grep onRelayTurnCompleted` の呼び手から。期限の処理で拾うかは未確認］。再接続の回復で書いた行も同じ | live の間から欠けている現行の欠落で、relay の候補の評価・settled の扱い・重複配送の防止の設計が要る。この Issue（履歴の保存）の受入条件と分ける |
| T2 | OpenCode V2 で切断中に Stop を失うと `wait` が返らない | `src/cli/commands/wait-turn-boundary.ts:193-197`、`src/cli/commands/wait.ts:766-`（孤児の解放）・`:833` | ターンの始まりを受けた後に切断し、終わりのイベントだけ失うと `lastStopEventAt` が更新されず、`wait` は `--timeout` まで待つ。回復の同期は行を書くが Stop は書かない | 回復した行から Stop を作ると、古い閉じたターンで実行中のターンを完了扱いする危険がある（Codex 指摘 2 の陰性）。Stop の意味（エージェント自身の報告）を変える設計で、タスク処理・検証への波及も別に見る必要がある |
| T3 | 記録されない状態（standalone・購読の終わり・reattach 直後）をその場で利用者に見せる | 表示の候補: インスタンスのタブ・SessionTile・スマホの同じ場所。状態の出どころは `subscription.ts:119`（`getOpencodeV2Liveness`）、`source.ts:104-126` | 今は warn と agent-health だけで、チャット面を見ている利用者は返信が記録されていないことに気づけない | PC とスマホの UI・i18n・解除の条件（正常に戻ったら消す）の設計が要り、この Issue の範囲（履歴の保存）を大きく超える。この Issue では docs の説明を正すだけにする |
| T4 | CommandMate の再起動の後、再起動の間に終わったターンを回復する | `src/lib/hooks/sources/opencode-v2/reattach.ts`、`subscription.ts`（`currentSessionId` が null から始まる） | 再起動の間に終わったターンは、その session の次のターン終了まで書かれない。次のターンが来なければ書かれない | session の一覧の API の有無が未確認（§8）。実測が先 |

---

## 7. 事前レビューの指摘ごとの処置

| 指摘 | 処置 | 理由（1 行） |
|---|---|---|
| 1 relay | (b) T1 | live の間から欠けている現行の欠落で、relay の候補の評価と重複配送の設計が要り範囲が膨らむ |
| 2 `wait` | (b) T2 | 回復した行から Stop を作るのは「古いターンで実行中のターンを完了扱い」の危険がある別の設計 |
| 3 回復の範囲・再試行 | (a) C6・C7、H1〜H6・R8〜R8c | 回復の同期が保証する範囲を書かないと「直った」と言えないので、`history.ts` を範囲に入れる |
| 4 session の上書き・latch | (a) C4・C5、R6・R6b | 回復の同期を足す以上、resync の上書きで回復の対象を失う穴を同時に塞ぐ必要がある |
| 5 再接続の判定・競合 | (a) C1〜C3、R2b・R3〜R3d・R7 | `attempt` では判定できないことを確かめたので、接続の履歴を明示する |
| 6 告知 | 説明の誤りは (a) §2.3・docs。表示は (b) T3 | 「チャット面には出る」は誤りなので直す。その場の表示は UI の設計が要り範囲が膨らむ |
| 全経路の一覧 | (a) §2.5 | 経路ごとに扱う・扱わないを明示する |
| 事実の訂正（en docs・standalone の語・テストの作り方） | (a) §1.3・§2.3・§4・§5 | 実コードで確かめた（`docs/en/user-guide/opencode-v2.md` あり、`source.ts:85-95`、`subscription.test.ts:56-60`・`history.test.ts:91-95`） |

---

## 8. 未確認・残り

- ［未確認］V2 2.0.18 の文書 API で、切断の間に終わったターンが接続中と同じ形（`user` → `assistant` … → `idle`）で残るか。`tests/fixtures/opencode-v2-history-2940` は接続中の実測。
- ［未確認］session の一覧の API の有無（T4）。
- ［未確認］子 session（tool が開く session）を含む実機のフレームの到着順。C4 の `currentSessionId` が子 session の id で上書きされると、回復の対象と latch の対象が親とずれる。実装の契約で `frameSessionId` が親を返すかを確かめ、子を返すなら親の id に寄せる（確かめられなければコミット本文に未確認と書く）。
- ［未確認］relay の期限の処理（`relay-delivery.ts:1025` `runRelayMaintenanceTick`）が V2 の返信を拾うか（T1 の前提）。
- ［見立て］C' の状態で購読が `lost` を繰り返すのは、`probeOpencodeV2Server` が `unreachable` を返し続けるため。

---

## 9. 1 人・1 PR に収まるか

変更ファイル（§4）:

1. `src/lib/hooks/sources/opencode-v2/subscription.ts`（中心。状態 3 つ・`runStream` の 3 か所・`deliver`・やり直し）
2. `src/lib/hooks/sources/opencode-v2/history.ts`（回復用の読み方と内部の結果）
3. `src/lib/response-extractor.ts`（コメント）
4. `src/lib/polling/response-checker.ts`（コメント）
5. `src/lib/polling/response-checker-extraction-steps.ts`（コメント）
6. `docs/user-guide/opencode-v2.md`
7. `docs/en/user-guide/opencode-v2.md`
8. `changelog.d/4187.md`
9. `tests/unit/hooks/sources/opencode-v2/subscription-recovery-4187.test.ts`（新規、16 件）
10. `tests/unit/hooks/sources/opencode-v2/history-recovery-4187.test.ts`（新規、6 件）
11. `tests/unit/lib/polling/response-checker-opencode-v2-no-scrape-4187.test.ts`（新規、6 件）

コードの変更は V2 の source の 2 ファイルに閉じ、残りはコメント・docs・テスト。［見立て］1 人・1 PR に収まる。重いのは R2b・R6b・R7・R8 の「読みを止めておく」ローカルサーバーの作りで、既存の `subscription.test.ts` の `startServer` を同じファイル内で写して使う。relay・`wait`・UI（T1〜T3）を入れると 1 PR を超えるので入れない。
