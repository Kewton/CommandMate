# capture の frame を取得元の世代（pane）へ結び付ける（Issue #4304 の前提）設計

- 段: 設計（この文書だけ。コードは書かない）。第 2 版（§9）。実装は §5 の 2 本の PR（F1-a・F1-b）で、どちらも #4304 の PR2a より前に入れる。最後の画面の回収の権利（§4.7）と作り直しの順は #4304 の PR2a・PR2b が初めて実装する
- 経緯: #4304 の設計（`commandmate-issue-4300-design` の `docs/design/send-foreground-check-4300.md`、改訂 6）の事前レビューで、「使う frame が取得元の世代に結び付かない」同じ種類の指摘が 3 回出た（改訂 6 の再確認 `prereview-4304-rev6-reply.md` の A、P2）。`docs/orchestrate/team.md` §6-6 に従い、作業に関わっていないイネーブラーが共通の原因を調べた（`enabler-return-4304-A-cause.md`、2026-11-14）。人の承認（2026-11-14、PM 追補 1 の 7）: A の共通の原因を「frame を取得元の世代へ結び付ける」小さな設計として切り出し、#4304 の実装より先に入れる
- リーダーの決定（この文書の前提）: **F1 を採る**（pane id を的にした capture＋frame に世代＋行動する読者はキャッシュを使わない＝狭めて塞ぐ）。F2 は F1 の後に capture の回数を測って必要なときだけ（**この設計では採らない**）。F3 は**採らない**。世代の識別子は `(server の start_time, pane_id)`（成立条件は §4.8）。`sweepStalePendingPrompts` は DB を書き換えるので**行動する読者**に入れる
- 第 2 版の材料: 第 1 版（`e1f92c211`）の 2-4-4 事前レビュー `prereview-4304-capgen-reply.md`（codex-2、**承認保留**。F1 には賛成、指摘 A〜F）と、リーダーの再指示 `reinstruct-4304-capgen-1.md`。指摘ごとの処置は §9 の後の表
- 基準: develop `a21776371`（`origin/develop` と同じ）。file:line はこの版で取り直した。実装の着手時は名前で探し直す
- 材料（リポジトリ外。`MyCodeBranchDesk/workspace/orchestration/runs/`）: `2026-11-14/enabler-return-4304-A-cause.md`（原因の正本）、`2026-11-14/lead-request-enabler-4304-A-cause.md`、`2026-11-13/prereview-4304-rev6-reply.md` の A、`2026-11-14/prereview-4304-capgen-reply.md`、`2026-11-14/reinstruct-4304-capgen-1.md`
- 表記: **事実**＝file:line・man の行がある文。**読み**＝そこからの推論（明記する）。**未確認**・**未決**は §7 に集め、未決には誰が・何で・いつ決めるかを書く

## 1. 問題と共通の原因

### 1.1 事実: capture の層の作り

| 事実 | 出典 |
|---|---|
| tmux への capture は常にセッション名を的にする: `capture-pane -t =<session>:`（その時点の現在の窓・現在の pane） | `src/lib/tmux/tmux.ts:60-61`（`exactTarget`）、`tmux.ts:976` |
| capture の戻り値は文字列だけ（`Promise<string>`）。pane の識別子を返さない | `tmux.ts:952-985`（`capturePane`）、`src/lib/tmux/session-transport.ts:28`（`captureSnapshot`）、`src/lib/tmux/polling-tmux-transport.ts:55-56`、`src/lib/tmux/control-mode-tmux-transport.ts:59-61` |
| キャッシュのキーはセッション名だけ。TTL 5 秒 | `src/lib/tmux/tmux-capture-cache.ts:53`（`CACHE_TTL_MS = 5000`）、`:435-441`（`getOrFetchCapture(sessionName, …)`） |
| キャッシュの「世代」は無効化の回数（`invalidateCache`・`clearAllCache` で進む）で、pane の世代ではない | `tmux-capture-cache.ts:113-122`、`:349`、`:372` |
| キャッシュの命中は旧い frame をそのまま返す | `tmux-capture-cache.ts:443-450` |
| 待機中の取得に後から来た呼び手は、その旧い結果をそのまま受け取る（`joined`） | `tmux-capture-cache.ts:452-461` |
| 無効化の世代が動いていれば書き戻さないが、取得を始めた本人へは返す | `tmux-capture-cache.ts:476-482` |
| キャッシュを通らない `captureSessionOutputFresh` も、結果をセッション名のキーでキャッシュへ書き戻す（無効化の世代が同じなら） | `src/lib/session/cli-session.ts:201`・`:224-227` |
| strict の read はこの書き戻しに依存する: Fresh の戻り値を捨て、続く `buildCurrentOutput`（キャッシュから読む）の payload を観測と frame に使う | `src/lib/session/strict-prompt-answer-io.ts:79-95`、`src/lib/session/current-output-builder.ts:1002` |
| frame に付く由来は「取得の開始時刻」と `fetched`／`cache`／`joined` だけ（#3798） | `tmux-capture-cache.ts:408`、`src/lib/session/waiting-episode-binding-observation.ts:194`（`captureObservedFrame`） |
| 新しいプロセスの世代の始まり（`beginAgentSession`）は capture のキャッシュを無効化しない | `src/lib/session/agent-session-lifecycle.ts:77`（同ファイルに `invalidateCache` は 0 件） |
| 今の復旧は同じ pane へ起動し直す（`relaunchIfToolExited`）。`new-window -k` はセッション作成時の窓 0 の作り直しにだけある。`respawn-pane -k` は窓 0 の作り直しの失敗時の代わり | `src/lib/cli-tools/base.ts:780`、`tmux.ts:575`、`tmux.ts:449` |
| セッションの改名では pane は同じなのにキャッシュを捨てる | `tmux.ts:1063`・`:1082-1083` |
| `pane_id`（`%N`）は「tmux server の中で、その pane の寿命の間、一意で変わらない」。`TMUX_PANE` で子にも渡る。server の開始時刻は `start_time`（man は「Server start time」とだけ書き、精度を書かない） | `man tmux`（tmux 3.5a、`/opt/homebrew/share/man/man1/tmux.1` の 904-916 行・5839 行・5901 行） |
| `src/` の非テストに `pane_id`・`paneId` は 0 件 | `git grep -n -E "pane_id\|paneId\b" -- src ':!*.test.ts'`（a21776371） |

### 1.2 読み: 旧 grid を受け取る 4 つの順序

- **(a) dead 確認 → 別の呼び手の作り直し → セッション名で capture**: 旧世代の dead を確かめた呼び手が、後継の grid を受け取る（`tmux.ts:976` の `=s:`）
- **(b) キャッシュの命中**: 作り直しの後 5 秒以内に、作り直しの前の grid が返る（`beginAgentSession` もキャッシュを消さない）
- **(c) 待機中の旧結果への合流**: 作り直しの前に始まった取得に合流し、旧 grid を受け取る（`tmux-capture-cache.ts:452-461`）
- **(d) 遅れて完了した旧 capture**: tmux が旧 pane を読んだ後、Node 側で返るのが作り直しの後になる。本人へは旧 grid が返り（`:480-482`）、無効化が走っていなければキャッシュへも書き戻される（`:476`、Fresh は `cli-session.ts:224-227`）→ 他の読者の (b) になる

### 1.3 共通の原因（構造）

> capture は「セッション名を的にし、文字列だけを返す」ので、frame は自分を作った pane（世代）を運ばない。#4304 の設計は改訂のたびに、使う frame とは別の観測（改訂 4 の入力欄の形 → 改訂 5 の argv の名前・nonce の不在 → 改訂 6 の今の pane の確認）で世代を推し量り、その観測と使う frame を結ぶものがセッション名しかなかった。だから確認を強くしても使う側に届かず、レビューは別の読者・別の順序から次の抜けを見つけた。

- 事実: このリポジトリは frame の由来を既に別の物差しで足している — 無効化の回数（#3734、`tmux-capture-cache.ts:113-122`）、取得の時刻（#3798）、tick・起動の epoch（`src/lib/polling/auto-yes-poller-generation.ts:199`）、入力の ticket（#3945、`agent-session-lifecycle.ts`）。どれもセッション名かプロセスの起動の回数に付いていて、pane の世代に付いたものは無い（1.1 の最後の行）。
- 読み: 改訂 6 の L1（世代ごとに新しい grid）で grid を分けても、**どの grid を読んだかを capture が言わない**ので、L1 の利点が読者に届かない。
- 読み（第 2 版で足した）: 由来は取得の呼び出しでだけ落ちるのではない。取得した文字列を加工した値（clean な文字列・`statusResult`・`promptData`・current-output の payload）、注入された capture の callback（`() => Promise<string>`）、呼び手が先に取った frame の受け渡し（`initialCapture`・`params.frame`）でも落ちる。だから「取得の関数を差し替える」だけでは閉じず、**行動の入口で受け取れる値**を限る必要がある（§4.3）。

### 1.4 反証の比較（イネーブラーの調査）

| 仮説 | 反証 | 扱い |
|---|---|---|
| H1 キャッシュの TTL・無効化の漏れ（`beginAgentSession` に `invalidateCache` を足せば直る） | 足しても (c) の合流済みの呼び手と (d) の本人へは旧結果が返る。Fresh・direct の読者の (a) はキャッシュと無関係に残る | 寄与要因。共通の原因ではない |
| H2 番（ロック）が足りない | 番は「番の中で作り直しが入らない」ことしか言わない。番の前に取った frame（`prompt-answer-sender.ts:129-131`）は番を越えて持ち込まれる。番を取らない作り直し（CommandMate の外の tmux 操作・CLI の終了）もある | 寄与要因。共通の原因ではない |
| H3 capture が由来を返さず、確認と使用が別の観測 | pane id を的にして取り、frame に id を持たせ、使う所で照合すると、(a) は旧 pane が無いので取得が失敗し、(b)(c)(d) は id の不一致で使われない | **原因として採る** |

### 1.5 F1 が保証する範囲（第 2 版で明記）

- F1 が言うのは「この frame は、取得の時点で、この世代の pane の grid から来た」ことだけ（**grid・pane の出典**）。
- F1 は次を保証しない。これらは #4304 本体の契約（R6.2 の E1・R6.4 の番）で扱う:
  - 取得の後、キーの配送までに世代が変わらないこと（配送の直前の照合は §4.4 で行うが、照合と配送の間の変化は #4304 の番と E1 の範囲）
  - 同じ pane の中のプロセスの入れ替わり（同じ `%N` の中の再 exec、`respawn-pane` による起動し直し）。pane の寿命を世代とするので、同じ pane の中では世代が変わらない（**読み**。`respawn-pane` で `pane_id` が保たれるかは §7.1 で確かめる）。#4304 の L1 が世代ごとに新しい pane を作るのはこのため
  - 任意の外部の tmux 操作（CommandMate の外からの `respawn-pane`・`kill-pane` 等）を防ぐこと。F1 はそれを**検出して使わない**だけ

## 2. 不変条件

> **G0（最上位。レビューの 1 文をそのまま採る）** 行動とその記録は、対象として保持した世代について確認後に取得した同じ由来の frame だけを使い、由来不明・世代不一致では許可や解決を作らず、dead の最後の保存は死後に取った frame を共有の回収権で高々 1 回だけ確定し、その回収が終わる前に作り直さない。
>
> **G1** 呼び手が行動（キー・保存・状態の書き換え・送る／保留の決定）に使う frame は、その呼び手が確認した世代の pane から、確認の後に取得したものだけ。合わなければ使わず、再取得か「不明」として扱う。
>
> **G2** 同じ世代の最後の画面の回収は、どの経路から来ても合計 1 回（第 2 版で明確化: **成功の保存が高々 1 回**。回収に失敗した世代は 0 回で、必ず 1 回保存するとは約束しない。§4.7）。

- G0 は G1・G2 を実行できる条件にしたもの。「確認後に取得した」「同じ由来」「対象として保持した世代」は §4.3・§4.4、「由来不明・世代不一致では許可や解決を作らず」は §4.2、「死後に取った frame」は §4.6、「共有の回収権で高々 1 回」「回収が終わる前に作り直さない」は §4.7 で閉じる。
- **世代の識別子**は `(server の start_time, pane_id)`。一意性は前提にせず、F1-a の実装の最初に確かめる成立条件にする（§4.8）。
- #4304 の設計 R6.2 の `(pane_id, nonce)` の nonce は「同じ grid の中で rc の出力と CLI の出力を分ける」補助で、grid の識別には使わない（§8）。

## 3. capture の全読者の表

### 3.1 取得の境界（取得者）

| 取得者 | 出典 | 扱い |
|---|---|---|
| `capturePane`（セッション名を的） | `tmux.ts:952-985` | 行動の経路からは外す（§4.3）。表示・診断にだけ残す |
| `SessionTransport.captureSnapshot` と 2 つの adapter | `session-transport.ts:28`、`polling-tmux-transport.ts:55-56`、`control-mode-tmux-transport.ts:59-61` | 取得の境界に含める。行動の入口へは渡せない（§4.3） |
| `captureSessionOutput`（cache）・`captureSessionOutputFresh` | `cli-session.ts:141`・`:201` | 返すのは「表示用の frame」だけ（§4.3）。Fresh の書き戻しはやめる（§4.5） |
| WS の control-mode の代わりの取得 | `src/lib/ws-server.ts:1056` | `terminal_output` への表示だけ。表示用のまま |
| シェルの `capture-pane` | `src/lib/tmux/read-mode-pager.ts:159` | 表示（読みモード）だけ |
| 新設 `captureBoundFrame` | §4.1 | 行動の入口へ渡せる frame を作れる唯一の取得者 |

`getControlModeTmuxTransport` の capture 以外の利用（reconcile の改名、WS の入力・resize）は capture の読者に数えない。

### 3.2 行動する読者（R1〜R10）

列: **取得**＝cache（`captureSessionOutput` → `getOrFetchCapture`）、fresh（`captureSessionOutputFresh`）、direct（`capturePane` 直）。**順序**＝1.2 のどれで旧 grid を受け取りうるか。**今の失敗時**＝取得の失敗で今どう続くか（事実）。どの読者も今は**世代を知らない**。

| # | 読者 | 取得（file:line） | 順序 | 今の失敗時 | frame で何をするか |
|---|---|---|---|---|---|
| R1 | 通常の応答 poll | cache: `src/lib/polling/response-checker.ts:1753-1755` | (a)(b)(c)(d) | — | 応答・プロンプトの行を保存（`:1766`・`:1799`）、カーソル、待ちの観測（`:1609`）。持つのは tick の所有（`mayStillActAfter`、`:1764`）と frame の時刻だけ |
| R2 | 応答の保存・カーソル（非代替画面の CLI）の 2 経路 | cache: `src/lib/assistant-response-saver.ts:279`（transcript の後のカーソル。呼び手は `src/lib/hooks/sources/{claude,codex,command-code,antigravity}/history.ts` の `advanceCapturedLineForTranscriptTurn`）・`:385`（送信の前の flush） | (b)(c)(d)（(a) は R1 経由） | 空なら何もしない | 履歴へ保存・`lastCapturedLine` を進める（`:279-309` は capture の後に dynamic import の await を挟んで書く） |
| R3 | 復旧側の最後の画面の回収（#4304 の R6.5。develop には未実装） | 未実装 | (a)、cache なら (b)(c)(d) | — | 旧世代の最後の画面として保存 |
| R4 | Auto-Yes の tick | cache: `src/lib/auto-yes-poller.ts:1029` → `src/lib/polling/auto-yes-poller-capture.ts:77`（`CapturedPollerFrame` は raw・clean・headCut だけ、`:37-49`） | (b)(c)(d) | — | 回答の判定・内容の決定・`finishAnsweredPrompt` へ同じ frame（`auto-yes-poller.ts:938`）。待ちの観測（`:1164`・`:1235`） |
| R5 | 回答の送る直前の読み（通常の回答・Auto-Yes・plan-review の共通部） | direct: `src/lib/prompt-answer-sender.ts:131`（`readGuardFrame`。呼び手の frame があればそれ、`:129`）、`:667`（`answerTargetStillOnScreen`）、`:476`（キーの後の再読） | (a)。`:129` は呼び手の frame の順序を引き継ぐ | `:128-133`・`:189-190`: 取得の失敗は `null` として通過 | どのキーを送るか・送るかどうか。`:667` の再読は**条件つき**: 番の待ち・読みの印の変化があったときだけ `stillApplies` を呼び、joined なら再読しない（`src/lib/session/instance-input-lock.ts:671-704`）。Enter 省略の回答はこの番の経路を通らない（`prompt-answer-sender.ts:1215-1226`） |
| R6 | `/prompt-response` の確認と plan-review | fresh: `src/app/api/worktrees/[id]/prompt-response/frame-verification.ts:83`・`:127`（plan-review の `recapture`）。plan-review は `src/app/api/worktrees/[id]/prompt-response/plan-review.ts:57-91` が state と `recapture?: () => Promise<string>` を受ける | (a)、書き戻しで他者の (b) を作る (d) | `frame-verification.ts:88-93`: 失敗でも続行（「手の回答を止めない」） | 回答の送信の可否、plan-review のキーの計画 |
| R7 | respond（通常と strict） | fresh: `src/app/api/worktrees/[id]/respond/screen-at-send.ts:62`（通常）、`src/lib/session/strict-prompt-answer-io.ts:84`（strict。payload は `buildCurrentOutput` の cache から、`:85`） | 通常は (a)(d)、strict は (b)(c)(d) も | `screen-at-send.ts:63-65`: frame 無しで続行 | キーごとの判定、strict の観測（`observeSession`） |
| R8 | 送信の前の判定（readiness・前景・プロンプト待ち・relay） | fresh: `src/lib/session/send-user-message.ts:338`、`src/app/api/worktrees/[id]/send/pane-shell.ts:44`。cache: `src/lib/session/prompt-waiting-guard.ts:113`（`send-user-message.ts:495` が使う）、`src/lib/relay/relay-readiness.ts:86` | fresh は (a)(d)、cache は (b)(c)(d) | `prompt-waiting-guard.ts:154-160`: `waiting: false`。`relay-readiness.ts:103-110`: 保留なし | 送る／保留の決定。prompt 待ちの共有の状態の解決（`prompt-waiting-guard.ts:120`） |
| R9 | 送信の中の入力欄の読み・クリア | direct: `src/lib/cli-tools/submit-verified-sender.ts:360`・`:432`・`:440`・`:534`・`:829`、`src/lib/cli-tools/submit-verified-sender-report.ts:84`・`:124`、`src/lib/session/composer-clear.ts:196`・`:277`、`src/lib/session-key-sender.ts:38` | (a) | `submit-verified-sender.ts:358-364`: 読めなければ次の周へ | 本文・Enter・クリアのキー。`submit-verified-sender.ts:365-369` は取った frame を `clearComposer` の `initialCapture` へ渡す。`composer-clear.ts:150-172` は `capture` の callback と `initialCapture`（生の文字列）を受ける |
| R10 | 起動・準備完了・起動時の回答・生存の確認 | direct: `src/lib/cli-tools/base.ts:416`（`settleLaunchRole` の capture。kill の判断にも使う、`:414-418`）・`:537`、`src/lib/cli-tools/session-liveness.ts:38`（`probeSessionLiveness`。`BaseCLITool.isToolLive` が使い、confirm では 2 回読む、`base.ts:718-728`）、`codex.ts:436`・`:732`・`:781`・`:860`・`:961`、`copilot.ts:607`・`:693`・`:788`・`:894`・`:1161`、`gemini.ts:216`・`:242`・`:298`、`command-code.ts:328`・`:368`、`opencode.ts:604`・`:1015`、`opencode-v2.ts:334`・`:366`、`antigravity.ts:377`・`:445`・`:478`、`vibe-local.ts:257`、`claude-auto-default-nudge.ts:67`・`:97`・`:144`（以上 `src/lib/cli-tools/`）、`src/lib/session/claude-session.ts:677`・`:1222` | (a)（起動の番の外で作り直されたとき） | `session-liveness.ts:42-50`: 読めないとき一部の CLI は `alive: true` | 起動の成否・trust 等へのキー・kill の判断。生存の確認が (a) で後継を読むと「生きている」と読み違える（読み） |

### 3.3 R11 を関数・副作用の単位で分けた表（第 2 版）

第 1 版は R11 をまとめて「表示」としたが、表示の経路の中に共有の状態・DB を書く副作用がある（レビュー A）。**純粋な表示（画面を見せる・整形して送る）だけが cache の frame を使ってよい**。それ以外は行動として扱う。

| # | 関数・副作用 | 出典 | 区別 | F1 での扱い |
|---|---|---|---|---|
| R11-a | current-output の payload を表示用に作って返す（HTTP の通常の poll、WS の定期の push） | `src/app/api/worktrees/[id]/current-output/route.ts:129`、`src/lib/realtime/terminal-broadcast.ts:74` | 表示 | cache のまま。ただし下の R11-b の副作用は表示用の frame では行わない |
| R11-b1 | prompt 待ちの共有の状態を、scraper が非 waiting と読んだ画面で消す | `current-output-builder.ts:1099-1108` → `src/lib/session/prompt-waiting-composition.ts:248-254` | 行動 | bound な frame でだけ行う |
| R11-b2 | ターンの終了の証拠を数え、閾値で `closedAt`・`closedBy` を書く | `current-output-builder.ts:1075-1081` → `src/lib/session/agent-event-turn.ts:402-425` | 行動 | bound な frame でだけ行う |
| R11-b3 | 未分類の frame の DB 記録 | `current-output-builder.ts:1218-1233` | 行動（記録） | bound な frame でだけ行う |
| R11-b4 | 構造化プロンプトの DB 記録と recorded の印 | `current-output-builder.ts:1268-1285` | 行動（記録） | bound な frame でだけ行う |
| R11-b5 | 状態の証拠の観測（`observeStatusEvidence`） | `current-output-builder.ts:1328`、`src/lib/session/worktree-status-helper.ts:702-706` | 行動（安全側。読み手が送信・relay の判定に使うかを F1-b で確かめ、表示だけと分かれば表示へ） | bound な frame でだけ行う |
| R11-c | strict の read の payload と観測 | `strict-prompt-answer-io.ts:79-95` | 行動 | 同じ BoundFrame から payload と観測を作る（§4.4） |
| R11-d | HTTP の `?observe=1` の観測（`observeSession`）と `?fresh=1` | `current-output/route.ts:125-129`・`:178-189` | 行動（観測の token を発行し、`wait` の判定に使う） | bound な frame から作る |
| R11-e | WS の fresh な payload | `terminal-broadcast.ts:158-164` | 表示（payload）＋R11-b の副作用 | payload は表示。副作用は R11-b の規則 |
| R11-f1 | 状態の probe の表示（状態・画面） | `worktree-status-helper.ts:900-902` | 表示 | cache のまま |
| R11-f2 | 起動中の frame の観測（`observeSessionStartingFrame`） | `worktree-status-helper.ts:593-598` | 行動（安全側。起動中の判定を送信が読むかを F1-b で確かめる） | bound な frame でだけ行う |
| R11-f3 | model・reasoning の表示用のラッチ（`recordCapturedModelInfo`） | `worktree-status-helper.ts:609-614` | 表示（読み。#1784 の目的は表示。行動の読み手があれば行動へ移す） | cache のまま |
| R11-f4 | 待ちの観測（push 通知の元。取得が throw すると not-waiting） | `worktree-status-helper.ts:923-932` | 行動 | bound な frame でだけ行う。取得の失敗・unknown を not-waiting にしない（既存の待ちを解決しない） |
| R11-s | `sweepStalePendingPrompts`（DB のプロンプトの行を「答え済み」へ） | `worktree-status-helper.ts:739-759`・`:908`、`src/lib/db/chat-db.ts:852` | **行動**（リーダーの決定） | bound な同じ世代の frame で「プロンプトが無い」と読んだときだけ。今の署名は `statusResult` だけを受けるので、由来を運ぶ値を受ける形に変える |
| R11-g | 画面の API・読みモード・診断の保存・WS の代わりの取得 | `src/app/api/worktrees/[id]/capture/route.ts:95`、`read-mode-pager.ts:159`、`src/lib/agent-health/frame-archive.ts:84-116`、`ws-server.ts:1056` | 表示・診断 | 今のまま。診断の行を回答や最後の画面の保存に昇格させない |

### 3.4 行動の副作用の駆動元

表示用の frame で行動の副作用をやめると、その副作用を誰が起こすかが要る（止めっぱなしは「解決しない」側に倒れるが、送信の保留などが残り続ける）。規則: **F1-b の後、各副作用に bound な駆動元が 1 つ以上あること**。

| 副作用 | 今の駆動元 | F1-b の後の bound な駆動元 |
|---|---|---|
| R11-b1 prompt 待ちの解消 | builder（cache）、R8 の prompt guard（`prompt-waiting-guard.ts:120`） | R8（送信の時に bound で読む）＋builder の bound な経路（R11-c・R11-d・R11-e） |
| R11-b2 ターンの終了 | builder だけ | **未決 U1**（§7.2） |
| R11-b3・b4 記録 | builder だけ | **未決 U1** |
| R11-b5・f2 証拠・起動中の観測 | builder・状態の probe | **未決 U1** |
| R11-f4 待ちの観測 | R1（`response-checker.ts:1609`）・R4（`auto-yes-poller.ts:1164`・`:1235`）・状態の probe | R1・R4（bound）。状態の probe は session が無いときの `gone` だけ（frame に依らない） |
| R11-s sweep | 状態の probe だけ | **未決 U1** |

## 4. F1 の設計

### 4.1 形

| 部品 | 置き場所 | 形 | すること |
|---|---|---|---|
| `readPaneGeneration` | `src/lib/tmux/tmux.ts` | `readPaneGeneration(session) → { startTime, paneId, dead } \| null` | `display-message -p -t =<session>: '#{start_time}\t#{pane_id}\t#{pane_dead}'` を 1 回。読めない・空・形が違えば `null`（§4.8 の成立条件の結果によって、server の識別の欄を足す） |
| `readPaneGenerationById` | `src/lib/tmux/tmux.ts` | `readPaneGenerationById(paneId) → 同上` | `display-message -p -t %N …`。③（取得の後の読み）と回収の dead の確認に使う。`%N` が無ければ `null` |
| `capturePaneById` | `src/lib/tmux/tmux.ts` | `capturePaneById(paneId, opts) → string`（失敗は throw） | `capture-pane -t %N`。セッション名を使わない。旧 pane が無くなっていれば tmux が失敗し、**後継の grid は構造的に返らない**。別の的へ取り直さない |
| `captureBoundFrame` | `src/lib/session/cli-session.ts` | `captureBoundFrame(target, expected?: PaneGeneration) → BoundFrame \| Unknown` | ① 世代を読む（`expected` があれば一致を要求）→ ② その `%N` を capture → ③ `%N` の世代をもう一度読み、①と③の `(startTime, paneId)` と `dead` が同じなら frame を返す。キャッシュを**読まない・書かない** |

`PaneGeneration` は `(startTime, paneId)` の組（§4.8 で server の識別の欄を足しうる）。`BoundFrame` は `{ frame, generation, dead }` を持ち、`dead` は①と③で一致した値。①と③で `dead` が違えば `unknown`（§4.2。①alive→③dead の frame は「最後の画面」ではないため。§4.6）。

### 4.2 `unknown` の理由と、各 return の終わり方

| 理由 | いつ | 呼び手の扱い（**どれも行動を許可しない**） |
|---|---|---|
| 世代が読めない | ①か③の読みが `null`（`display-message` の失敗・timeout・空・不正な形・セッションが無い） | キー 0・保存 0・DB と共有の状態の「解決」0。次の機会に取り直す |
| 世代が違う | `expected` を渡し、①が `expected` と違う | 同上。確認した世代は既に無い。新しい世代を元の判断に引き継がない |
| pane が無い・取得の失敗 | ② の `capture-pane -t %N` が失敗・timeout・stdout が途中 | 同上。成功した空の画面（`""` を正常に返した）とは区別する。別の的（セッション名）へ取り直さない |
| 取得中に変わった | ①と③の世代か `dead` が違う | 同上。frame がどちらの世代・どちらの状態か言えない |

- 「不明」を「画面が消えた」「解決した」「保留なし」「待ちなし」「生きている」とは読まない（#4304 の R6.3 の Auto-Yes の行と同じ扱い）。今の失敗時の続行（§3.2 の「今の失敗時」の列）は、F1 で次へ変える。**これは利用者から見える挙動の変更**で、実装の PR の changelog に書く:
  - R5・R6・R7: キー 0 の未送信（`answer_not_delivered`、再送してよい）。「手の回答を止めない」（`frame-verification.ts:89`）はやめる
  - R8 の prompt guard: 保留（判定できない）。relay: 保留（再試行）
  - R10 の生存: 「生きている」とも「終わった」とも言わない第 3 の値。起動し直し・kill・拒否の解除のどれも行わない（§4.4）
  - R11-f4: 待ちを解決しない（今の「throw は not-waiting」をやめる）
- unknown は呼び手の型で区別できる値として返す（例外で返すか値で返すかの書き方は未決 U3。どちらでも「行動を許可しない」で終わること）。

### 4.3 行動の入口の境界（第 2 版で決めた。名前は未決 U3）

- **行動の入口は BoundFrame（とそれから作った由来つきの値）だけを受け取る。** 次を受け取らない:
  - 生の文字列の frame（`params.frame: string`、`initialCapture: string`）
  - 生の capture の callback（`() => Promise<string>`、`(sessionName) => Promise<string>`。plan-review の `recapture`、`clearComposer` の `capture`、`settleLaunchRole` の `capture`）
  - 由来を落とした値（clean な文字列だけ、`statusResult` だけ、current-output の payload だけ）
  - 表示用の frame（`captureSessionOutput`・`captureSessionOutputFresh`・`captureSnapshot` の戻り値）
- 由来つきの値: BoundFrame から作った加工（clean・`promptData`・`statusResult`・payload）は、元の BoundFrame（の世代）と一緒に運ぶ。parser や detector に生の文字列を渡すこと自体は禁止しない。**行動と記録がその結果を使うとき、同じ BoundFrame へ結べること**が条件。
- **外から世代の値を足しても「確認済み」にならない**: BoundFrame は `captureBoundFrame` だけが作れる（型を構造でなく名目で区別し、作る関数を外へ出さない）。`{ frame, generation }` の形の object を作っても行動の入口は受け取らない。
- 注入の継ぎ目（テストの seam）: callback を受けるなら `() => Promise<BoundFrame | Unknown>` の形にし、期待する世代を引数に取る。試験は試験用の作り手（試験の helper の中だけ）で BoundFrame を作る。
- この境界は §6 の T10（第 2 版）とガードで機械に入れる。

### 4.4 操作ごとの世代の取り方・持ち方・取り直し（第 2 版）

| 操作 | 期待する世代をどこで取るか | どこまで持つか | いつ取り直すか／照合するか | 合わないとき |
|---|---|---|---|---|
| R1 応答 poll の tick | tick の `captureBoundFrame`（期待なし）で G。前の tick の世代を poller の状態に持つ | その tick の保存・カーソル・待ちの観測まで（`response-checker.ts` の capture の後は await を挟まない、#3705） | 毎 tick。前の tick と世代が違えば、その tick は保存しない（新しい世代のカーソルの扱いは #4304 PR2a の relaunched） | 保存 0・カーソル不変 |
| R2 transcript の後のカーソル・送信の前の flush | poller の状態に持つ世代を期待として `captureBoundFrame(…, G)` | dynamic import の await の後、カーソルを書く直前まで | 書く直前に poller の状態の世代がまだ G か（同期の照合） | 書かない。dead の flush は最後の画面の回収（§4.6・§4.7）へ回し、ここで最後として保存しない |
| R4 Auto-Yes の tick → R5 → 回答の完了 | tick の `captureBoundFrame` で G | 判定・回答の内容・`sendPromptAnswer`（BoundFrame を渡す）・`finishAnsweredPrompt`・カーソルまで同じ G | tick の中では取り直さない。次の tick で新しく取る | 回答しない。旧 G の成功を新しい世代の「答え済み」・カーソルへ書かない |
| R5 回答の送信（Auto-Yes・respond・prompt-response 共通） | 呼び手の BoundFrame の G（呼び手が frame を持たないときは自分の `captureBoundFrame` で G） | 最初のキーの直前まで。番の中の `stillApplies` の再読は `captureBoundFrame(…, G)` | **最初のキーの直前に、番の経路（非競合・番の待ち・joined）と Enter 省略の経路のどれでも、`readPaneGeneration` が G であることを照合する**（#4303 の前景の確認と同じ所。条件つきの `stillApplies` に頼らない）。キーの後の再読（`:476`）も `captureBoundFrame(…, G)` | 最初のキーの前ならキー 0・未送信。キーの一部の後なら既に送ったキーの数を保ち（`keysSent`）、完了として保存しない（`indeterminate`） |
| R6 prompt-response | 最初の `captureBoundFrame` で G | 検証・plan-review の再読（`captureBoundFrame(…, G)`）・R5 へ渡すまで | plan-review の `stillApplies` と R5 の最初のキーの直前 | 未送信（409 系、再送してよい）。同じ phase・同じキーの計画でも G→H ならキー 0 |
| R7 respond 通常 | `screen-at-send` の `captureBoundFrame` で G。保存済みのプロンプトの行の由来とは別に扱う | R5 へ渡すまで | R5 と同じ | 未送信（今の「frame 無しで続行」をやめる） |
| R7 strict | その操作の最初の read の `captureBoundFrame` で G。payload と観測は同じ BoundFrame から作る（R11-c） | その操作の全キー・各キーの後の read まで | 各 read は `captureBoundFrame(…, G)` | read を `capture` の失敗として返す（キー 0、またはキーの一部の後なら strict の既存の扱い）。token・保存・再送の一致は #4304 の strict の PR の範囲 |
| R8 送信の前の判定 | 判定の `captureBoundFrame` で G | 判定 → R9 の送信の最初のキーの直前まで | R9 の最初のキーの直前に G を照合 | 送らない（保留・未送信） |
| R9 入力欄の読み・クリア | R8 の G（クリアの `initialCapture` は BoundFrame） | 本文・Enter・クリアの各周 | 各周の読みは `captureBoundFrame(…, G)` | 最初のキーの前なら未送信。後なら送信済みの prefix の記録を保ち `indeterminate` |
| R10 起動・準備完了 | F1-b: `launchSession` が戻った直後の `readPaneGeneration` で G。#4304 PR2b の後: spawn が同じ呼び出しで返す pane id | 準備完了の待ち・trust・update・nudge のキー・`settleLaunchRole`（capture と kill の判断）・起動直後の生存の confirm（2 回の読み）まで同じ G | 各読みは `captureBoundFrame(…, G)`。読みのたびに新しい世代を受け直さない | 起動の失敗（準備待ちの時間切れと同じ扱い）。trust 等のキーを送らない。後継の pane を kill しない |
| R10 起動の外の生存の確認（`relaunchIfToolExited`・拒否の解除 `base.ts:410`） | 呼び出しの `captureBoundFrame` で G | その判断まで | — | unknown は「生きている」でも「終わった」でもない: 起動し直さない・拒否を解除しない |
| R11-b・c・d・e・f2・f4・s | builder・probe の `captureBoundFrame` で G（bound な経路のとき） | その副作用を書くまで（同期） | — | 副作用を行わない（解決・消去・終了・記録を作らない） |

### 4.5 キャッシュの扱い

- 行動する読者はキャッシュを使わない（読まない・書かない）。(b)(c)(d) は行動の経路から消える。
- `captureSessionOutputFresh` のキャッシュへの書き戻し（`cli-session.ts:224-227`）を**やめる**。表示用のキャッシュへ旧 pane の frame を入れないため。**strict の read（R11-c）がこの書き戻しに依存しているので、書き戻しの削除と strict の read の置き換えは同じ PR（F1-a）に入れる**（§5）。
- 表示用（R11-a・f1・f3・g）はセッション名のキーのまま。表示が旧 grid を最大 5 秒見せても、行動に使われなければ G1 を壊さない。cache の取得自身の遅れた書き戻し（`tmux-capture-cache.ts:476-482`）は表示用に残る。Fresh の削除で表示の旧 frame が無くなるとは言わない。
- 読み: 状態の probe の capture（#965 で減らした回数）は表示（R11-f1）のまま。増えるのは bound な取得ごとの `display-message`×2（①③）と、cache から bound へ移る読者（R1・R4、U1 の結果によって R11-a の一部）の `capture-pane`。応答 poll は 2 秒＝`src/lib/polling/response-poller-core.ts:37`、Auto-Yes は 2 秒＝`src/lib/auto-yes-state.ts:996`、考え中は 5 秒＝`src/config/auto-yes-config.ts:36`。測り方は §7.1。

### 4.6 最後の画面の回収の条件（第 2 版、レビュー C）

- 最後の画面として保存してよい frame は、**dead を確かめた後に、その同じ世代を的に取得した frame** だけ: ① `%G` が dead（`pane_dead=1`）→ ② `capture-pane -t %G` → ③ `%G` がまだ dead で同じ世代。
- **alive → dead**（①alive・③dead）: frame は `unknown`（§4.2「取得中に変わった」）。通常の frame としても最後の画面としても使わない。最後の画面は、dead を確かめた後の別の回収（上の手順）で取る。死ぬ直前に CLI が書いた最後の行を落とさないため。
- **dead → alive**（①dead・③alive）: 最後の回収の成功にしない（同じ pane への外部の `respawn-pane` 等を含む）。`unknown`。
- 回収の期待の世代は、**生前（alive の bound な取得）に持った世代**だけ（#4304 R6.5 の「生前の識別子を持たない（サーバーの再起動の後など）capture は保存しない」を継ぐ）。生前の世代を持たない dead の pane は回収しない（保存 0、診断にだけ残してよい）。
- これはプロセスの実体の判定を F1 に足す要求ではない。「最後の画面」を名乗る条件だけ。

### 4.7 回収の権利（第 2 版、レビュー D）

**状態**（世代ごと）:

| 状態 | 意味 | 遷移 |
|---|---|---|
| 無し | 誰も回収を始めていない | 回収の開始で → 進行中（所有者つき） |
| 進行中 | 所有者が §4.6 の取得または保存の途中 | 保存の完了で → 完了。unknown・throw・所有の失効・時間切れで → 失敗 |
| 完了 | 成功の保存が 1 回済んだ | 終端 |
| 失敗（打ち切り） | 回収できなかった。保存 0 | 終端。**取り直さない**（二人目が回収しない） |

- 権利は **await の前に同期で取る**（表を見て「無し」なら「進行中」を set、までを 1 つの同期の区間で）。権利は**世代ごとに 1 回**。「無し」以外を見た者は回収しない。
- 所有者は、どの終わり方でも（unknown・throw・tick の所有の失効・入力の所有の失効）`finally` で終端（完了か失敗）へ移す。進行中のまま残さない。
- 回収の取得と保存は**入力の番（`withInstanceInputLock`）を取らない**（tmux の読みと DB の書き込みだけ）。だから作り直しの側が exclusive の番を持って待っても、所有者がその番を待って詰まる順序は無い。
- 回収の取得と保存はそれぞれ時間の上限を持つ（tmux の呼び出しの timeout、DB の書き込み）。上限を超えたら所有者は失敗へ移す。
- **作り直し（#4304 L1 の `new-window -k`）の順**: exclusive の番の中で、その世代の状態を見る → 「無し」なら自分が権利を取り、回収してから作り直す → 「進行中」なら終端を待つ（上限つき。上限は回収の上限の和より長くする）→ 終端なら作り直す → 待ちが上限を超えたら**作り直さない**（復旧の失敗として返し、次の機会に再試行。作り直してから回収、の順にはしない）。
- R1・R2 が dead を読んだときの保存も、同じ最後の保存として数え、同じ権利を通す（R3 だけの表にしない）。
- **寿命と保証の範囲**: 表は CommandMate のサーバーのプロセスのメモリにだけ置く。保証は**1 つのサーバープロセスの中で**「成功の保存が高々 1 回」。サーバーの再起動・HMR で表が空になったら、生前の世代を持たない dead の pane は回収しない（§4.6）ので、再起動をまたいだ二度目の保存は起きない。複数の CommandMate サーバーが同じ pane を扱う構成は保証の外（今の `--issue` の並列サーバーはそれぞれ自分のセッションを扱う、の前提。**読み**）。表の行は、その世代の pane が無くなったことを読んだ後に消す（数の上限は実装で決める）。
- G2 の言い方: 「成功の保存は高々 1 回。失敗した世代は 0 回」。

### 4.8 世代の識別子の成立条件（第 2 版、レビュー E）

`(start_time, pane_id)` は次を**F1-a の実装の最初**に、隔離の `tmux -L <名前>`（本番の tmux server には触らない）と tmux 3.5a のソースで確かめてから使う。成り立たない項目があれば、下の候補から選ぶ。

| 成立条件 | 確かめ方 | 不十分なときの候補 |
|---|---|---|
| E-1 `start_time` の精度（秒か、それより細かいか） | 隔離の server で `display-message -p '#{start_time}'` の値と書式を見る。ソースの `start_time` の format の定義を読む | 下の E-3 の候補 |
| E-2 pane id の採番が server の中で再利用・wrap しないこと（man は「寿命の間、一意で不変」と書くだけ） | ソースの pane id の採番（`window.c` の次の id の変数）の型と増え方を読む。隔離の server で pane を作って消して作る（実験で増えたことだけで一般化しない） | 再利用がありうるなら、`pane_id` だけでなく pane を作った時刻（`#{pane_start_time}` 等、ソースで確かめる）を足す |
| E-3 同じ socket で server が入れ替わったことを区別できること（start_time が同じ表現・同じ `%N` の衝突） | 隔離の server を kill して同じ socket で起動し直し、`%0` から振り直されることと start_time の値を見る | (1) server の PID（`#{pid}`）を識別に足す (2) CommandMate が server に初めて触れたときに server の option へ一意な印を置き、識別に足す (3) server の識別が変わったら、持っている期待の世代を全部失効させ、その間は unknown にする（restart を unknown として扱う）。(3) は (1)・(2) と併用できる |
| E-4 `respawn-pane` で `pane_id` が保たれるか | 隔離の server で `respawn-pane -k` の前後の `pane_id` | 保たれる（読み）なら §1.5 のとおり F1 の世代はそれを区別しない。#4304 は L1 で新しい pane を作る |

- 候補の選択は §7.2 の未決 U2（実装者が確かめた結果を書き、リーダーが選ぶ）。選ぶまで F1-a の基盤をマージしない。
- 同じ server・同じ pane の G→H→G（pane を切り替えて戻る）で、取得が `%G` 固定なら、H の grid を読んだことにはならない。これは誤りではないので「必ず失敗」を要求しない（§6.2 の TE2）。

### 4.9 採らない案

- **F2「キャッシュのキーに世代を入れる」**: この設計では採らない。F1 の後に capture の回数を測り（§7）、負荷が問題になったときだけ別に考える。キャッシュの命中の frame は「確認の後に取得した」（G1 の後半）を満たさず、満たすには取得の開始時刻の規則（#3798）と重なり、組み合わせ（命中・合流・自分の取得 × 世代の一致・不一致 × 確認の前・後）が F1 の約 3 倍になる（読み）。
- **F3「行動は番の中で取り直した frame だけ」**: 採らない。番を取らない作り直し（CommandMate の外の tmux 操作・CLI の終了）には (a) が残り、番の中の capture も文字列だけなので、確認と使用がまだ別の観測（原因の A が残る）。

## 5. PR の分け方（第 2 版で引き直した、レビュー F）

どちらも **#4304 の PR2a より前**。各 PR は「取得の API・実際の呼び手・消費する入口・unknown の return・型とガード」まで閉じる単位にする（team.md §6-4: API は呼び手と同じ PR）。表示の見た目・画面の読み方・送るキーやロックの新しい仕様は混ぜず、**由来の保持と拒否だけ**を入れる。team.md §6-3 の目安（数百行・20 ファイル程度）は目安でゲートではない。

| PR | 閉じる単位 | 中身 | 目安（読み） |
|---|---|---|---|
| **F1-a**（回答の経路） | 回答のキーの入口（R5）とその全呼び手 | §4.8 の成立条件の確認（最初）→ `readPaneGeneration`・`readPaneGenerationById`・`capturePaneById`・`captureBoundFrame`・unknown の型。R4（`auto-yes-poller-capture.ts`・`auto-yes-poller.ts` の frame の受け渡しと完了の記録）、R5（`prompt-answer-sender.ts`。最初のキーの直前の世代の照合を番の経路と Enter 省略の両方に、`params.frame` を BoundFrame に）、R6（`frame-verification.ts`・`plan-review.ts` の `recapture`・prompt-response の route）、R7 通常（`screen-at-send.ts`・respond の route）、R7 strict の read（`strict-prompt-answer-io.ts`）と、そのために `buildCurrentOutput` が**与えられた BoundFrame から** payload を作る入口（strict だけが使う）、Fresh の書き戻しの削除（strict の read と同じ PR、§4.5）。境界のガード（T10）は回答の入口を対象に | 15〜20 ファイル、本体 300〜500 行＋試験 400〜700 行。R5 の呼び手の前後と strict の builder の改修量は未確認 |
| **F1-b**（保存・送信・起動・状態の経路） | 残りの行動の入口（応答の保存・送信・起動・状態の副作用） | R1（`response-checker.ts`）、R2（`assistant-response-saver.ts` の 2 経路と `hooks/sources/*/history.ts` の 4 呼び手）、R8（4 ファイル）、R9（`submit-verified-sender*.ts`・`composer-clear.ts` の `capture`／`initialCapture` の境界・`session-key-sender.ts`）、**R10（全 CLI の起動・`session-liveness.ts`・`base.ts`・`claude-session.ts`。入れ先は F1-b に決めた）**、R11-b〜f の副作用を bound な frame でだけ行う分け方（`current-output-builder.ts`・`worktree-status-helper.ts`・current-output の route・`terminal-broadcast.ts`）、R11-s。境界のガードの対象を全行動の入口へ広げる | 30 ファイル前後（取得元だけで 24、レビューの §2 の内訳）＋型・試験。§6-3 の目安を超えるので、R10 を F1-b2 に分けるかを未決 U4 とする |

- **R10 の入れ先は F1-b**（第 1 版の「#4304 PR2b でもよい」は取り消す）。F1-b の後に「全行動の読者は bound だけ」が成り立つことを、#4304 PR2a の前提にするため。PR2b は R10 の期待の世代の取り方を「`launchSession` の後の読み」から「spawn が返す pane id」へ替えるだけ。
- **F1-a の後の中間の状態**: 回答の経路は全部 bound。R1・R2・R8〜R10・R11 は develop と同じ（cache・Fresh・direct のまま）で、悪くはならない。Fresh の書き戻しを消しても、表示用の読者は自分で取得するので表示は変わらない。strict は同じ PR で BoundFrame に移るので、「書き戻しの削除だけが入った中間版」は作らない。F1-a は R6・R7 の旧い入口を受け入れる互換の道を足さない（呼び手を同じ PR に入れる）。
- **回収の権利（§4.7）と最後の回収（§4.6）は #4304 PR2a に入れる**（呼び手 R3 と R1・R2 の dead の保存が初めて現れる PR。未使用のモジュールを F1 に先に入れない、team.md §6-4）。この設計はその形と順序の契約を決める。**作り直しが終端を待つ順は #4304 PR2b**（`new-window -k` を初めて実装する PR）。PR2a の回収の入口が共有の権利を通ることは PR2a の試験で確かめる。
- `captureBoundFrame` の `expected` の最初の呼び手は F1-a の R5（呼び手の G で再読・照合）と R6 の plan-review の再読。

## 6. 試験

単体（tmux を偽の transport にする。実 tmux は不要）。各行は「他の条件を満たし、1 つだけ変える」。各陰性（使わない・送らない）には同じ世代の陽性（使う・1 回送る）を置き、全部を拒否する実装で緑にならないようにする。「直す前に赤」は、新しい API の名前が無くてコンパイルできない、の意味ではない: 旧い cache を消費する今の API・関数へ旧 G → 新 H を差し、キー・DB・共有の状態の誤った副作用が出ることを赤として確かめる。

### 6.1 基本の表（第 1 版の T1〜T10。T10 は第 2 版で替えた）

| # | 状態の作り方 | 読者 | 期待（直した後） | 直す前（develop） |
|---|---|---|---|---|
| T1 | 旧 pane の frame がキャッシュにある → 作り直し（pane id が変わる）→ 5 秒以内に読む | R1・R4 | 旧 frame で保存・回答をしない（`unknown` か新 pane の frame） | 赤: 旧 frame が返る（`tmux-capture-cache.ts:443-450`） |
| T2 | 旧 pane への取得が待機中 → 作り直し → 別の呼び手が合流 | R1・R4 | 合流した呼び手も旧 frame を使わない | 赤: `joined` で旧 frame（`:452-461`） |
| T3 | 旧 pane への取得が作り直しの後に完了（fresh・cache の両方） | R1・R6 | 本人は使わない。キャッシュにも入らない | 赤: 本人へ返り（`:480-482`）、無効化が無ければ書き戻す（`:476`、`cli-session.ts:224-227`） |
| T4 | 旧世代の dead を確認 → 別の呼び手が作り直し → セッション名で capture | R3・R1 | 後継の grid を旧世代の最後の画面として保存しない（取得は `unknown`） | 赤: 後継の grid が返る（`tmux.ts:976` の `=s:`） |
| T5 | 通常 poll と復旧側が同じ dead の世代を同時に回収 | R1・R3 | 成功の保存は合計 1 回 | develop には回収が無い。#4304 PR2a の試験で赤を確かめる |
| T6 | 番の外で取った frame（Auto-Yes の frame）を回答の番へ持ち込む → 番の前に作り直し | R4→R5 | `target-changed` か未送信、キー 0 | 赤（読み）: `:129` が呼び手の frame を使い、`:667` の再読は新 pane を読む。新 pane に同じ形のダイアログがあれば通る |
| T7 | 陽性対照: 作り直し無し、同じ世代 | 全行動読者 | frame を使う（保存 1 回・回答 1 回） | 緑（今と同じ） |
| T8 | 陽性対照: 作り直しの後、新世代を確かめてから取る | R1・R4・R10 | 新 frame を使う | 緑 |
| T9 | 世代が読めない・取得が失敗（①・②・③のそれぞれで: 失敗・timeout・空・不正な形・途中の stdout） | 全行動読者 | `unknown`。行動しない。成功した空の画面とは区別する | 赤（R5・R6・R7・R8・R10・R11-f4 は今は続行する。§3.2 の「今の失敗時」） |
| T10 | **境界の検査（第 2 版）**: 行動の入口へ渡せる入力を型と静的なガードで検査する — (1) 生の文字列・生の capture の callback・表示用の frame・由来を落とした payload を行動の入口に渡すと型が通らない（`@ts-expect-error` の試験）(2) `{ frame, generation }` を手で作った object も通らない（外から世代を足しても確認済みにならない）(3) BoundFrame を作る関数が `cli-session.ts` と試験の helper の外で使われていない (4) 加工した値（clean・`statusResult`・payload）を行動へ戻すときに元の BoundFrame の世代が付いている | — | すべて満たす | 赤（今は行動の入口が `string` と `() => Promise<string>` を受ける。§4.3） |

### 6.2 レビューの指摘ごとの対照（第 2 版）

| # | 指摘 | 状態の作り方 | 期待 | 陽性（同じ世代） |
|---|---|---|---|---|
| TA1 | A | キャッシュに旧 G の画面、新 H の capture を返す → strict の read | strict が旧 G でキーを出さない。payload・観測・frame が同じ BoundFrame | 同じ G なら同じ観測を strict へ渡し 1 回送る |
| TA2 | A | 同上 → current-output（R11-a・b）を読む | 旧 G を根拠に prompt 待ちを消さない・ターンを閉じない・未分類／構造化の記録を作らない | bound な同じ G では今どおり消す・閉じる・記録する |
| TA3 | A | 状態の probe が旧 G の cache・取得の失敗を読む | sweep・待ちの観測・証拠の更新が 0。unknown を not-waiting にしない | bound な同じ G でプロンプトが無ければ sweep 1 回 |
| TA4 | A・F | F1-a だけを入れた版で、新しい証拠を読んだ後に旧 cache で strict が回答しない（Fresh の書き戻しの削除と strict の read が同じ版にある） | キー 0 | 同じ G は 1 回 |
| TB1 | B | G で判定 → await の間に H へ交代 → 同じ文面のプロンプト。これを非競合・番の待ち・joined・Enter 省略・plan-review・クリアの初回 frame のそれぞれで | 元の G の判断を H へ引き継がずキー 0 | 交代なしで 1 回 |
| TB2 | B | ①・②・③ の各失敗を、各公開の入口（`/respond`・`/prompt-response`・strict・Auto-Yes・send・relay・起動）から | キー 0・保存 0・「解決」の更新 0。今の fail-open（続行）にしない | 失敗なしで今どおり |
| TB3 | B | キーの一部を送った後に世代交代 | 既に送ったキーの数を保ち、完了として保存しない（`indeterminate`） | 交代なしで完了 |
| TB4 | B | `expected` を省略して新しい H を読めた | 元の G に対して決めた回答を H へ転用しない（新しい H を読めたことだけを陽性にしない） | — |
| TC1 | C | ① alive → capture → 最後の行を書いて終了 → ③ dead | 最初の frame を最後の画面として保存しない。dead を確かめた後の回収に最後の行がある | ① dead → capture → ③ dead の同じ G で 1 回保存 |
| TC2 | C | ① dead → capture → ③ alive（外部の respawn） | 最後の回収の成功にしない | 同上 |
| TC3 | C | dead の回収の①・②・③の失敗 | 成功の回収にしない（保存 0、状態は失敗） | 同上 |
| TD1 | D | 所有者 A を権利の取得の直後・取得の直後・保存の直前でそれぞれ止め、B が作り直しを要求 | B の作り直しは A の終端より後。二重の回収なし | A が終わってから作り直す |
| TD2 | D | A が unknown・throw・入力の所有の失効・時間切れで終わる | 保存 0・状態は失敗・永久の待ちなし・取り直しなし。B は終端を見て作り直す | — |
| TD3 | D | R1・R2・R3 が同じ dead の G に同時に到着 | 成功の保存 1 回 | 別の世代 G・H はそれぞれ 1 回 |
| TD4 | D | 表が空（サーバーの再起動・HMR を模す）で dead の G を読む | 生前の世代を持たないので回収しない（保存 0） | 生前の G を持てば 1 回 |
| TD5 | D | B が exclusive の番を持って待つ間、A の回収が番を要求しない | 詰まらない（A は番を取らない） | — |
| TE1 | E | server が違うのに pane 番号が同じ、start_time の表現も同じ、という偽の transport の行 | §4.8 で選んだ識別が区別できなければ、この行は保証の外として承認しない。区別できる識別なら unknown | 同じ server・同じ pane は使える |
| TE2 | E | 同じ server で pane を G→H→G と切り替え、取得は `%G` 固定 | `%G` が同じ寿命なら H の frame にはならない。失敗を要求しない（陽性） | — |
| TE3 | E | start_time が違う別の server | unknown。期待の世代を失効 | — |
| TF1 | F | F1-a 単独と F1-a＋F1-b の両方で、実際の API の入口を通し「新しい証拠を読んだ後に旧 cache で回答しない」 | キー 0 | 同じ G は 1 回 |
| TF2 | F | F1-b の後、R10 に生の capture が残っていない。#4304 PR2a の回収の入口が共有の権利を通る | 0 件・通る | — |

### 6.3 全組み合わせの軸（レビューの §4 の表を採る）

T1〜T10・TA〜TF はこの全表の代表の行と位置付ける。実装の PR は、自分が閉じる入口についてこの軸の交差を表駆動で書く。

| 軸 | 値 |
|---|---|
| 取得源 | bound な direct／表示の cache の命中／joined／遅れた取得／旧い Fresh／transport の代わり／呼び手の frame／注入の callback |
| 世代 | 同じ G／expected と不一致／取得中の交代／取得の後の受け渡し中の交代／同名のセッションの作り直し／server の交代／識別の値の衝突 |
| 生存 | alive→alive／alive→dead／dead→dead／dead→alive／absent／unknown |
| 失敗点 | ①の読み／②の取得／③の読み／型・受け渡しの欠落／保存／所有の失効 |
| 所有と競合 | 非競合／番の待ち／joined／Enter 省略／回収の権利の競合／権利の所有者の失敗／権利の状態の寿命切れ |
| 副作用 | キーの数と順序／本文・回答の保存／カーソル／prompt の sweep／prompt 待ち・ターンの終了／strict の観測／最後の保存／`new-window` の順序 |

### 6.4 防御を 1 つずつ外す対照（F1 を入れた後、1 つだけ戻して赤を確かめる）

- **(i)** `%N` を的にするのをやめて `=s:` に戻す → T4 が赤
- **(ii)** 取得の後の世代の再読（§4.1 の③）を外す → 「取得中に作り直し」の T3 の変形と TC1 が赤
- **(iii)** 回収の権利の表を外す（#4304 PR2a） → T5・TD3 の保存が 2 回
- **(iv)** Fresh の書き戻しを戻す → 「表示用のキャッシュへ Fresh が書かない」の契約の試験が赤（第 2 版: 全行動の読者がキャッシュを読まなくなった後は G1 の行動の違反にはならないので、独立した契約の試験として置く）
- **(v)** 最初のキーの直前の世代の照合（§4.4 の R5）を外す → TB1 の joined・Enter 省略の行が赤

## 7. 未確認・未決と確かめ方

### 7.1 未確認（実装の最初に、隔離の `tmux -L <名前>` で確かめる。本番の tmux server には触らない）

| 未確認 | 確かめ方 | いつ |
|---|---|---|
| §4.8 の E-1〜E-4（start_time の精度、pane id の採番・再利用・wrap、同じ socket の server の入れ替わり、`respawn-pane` での `pane_id`） | §4.8 の表のとおり。tmux 3.5a のソースと隔離の server | F1-a の最初（基盤を書く前） |
| remain-on-exit の dead pane を `capture-pane -t %N`・`display-message -t %N` で読めること、消えた `%N` への capture が失敗（exit≠0）になること | 隔離の server で 1 回ずつ | F1-a の最初 |
| capture の回数の増え方（R1・R4 の bound 化、`display-message`×2 の追加） | `worktree-status-helper.ts:107` の `captureCount` と同じ数え方を bound な取得に足し、隔離のサーバーで 1 時間、F1-a の前後を測る | F1-a のマージの後、F1-b の契約の前（U1・F2 の判断の材料） |
| pane を作り直す全操作が exclusive の番を取るか（`kill-session` API・`session-cleanup.ts`・CLI 自身の終了） | `withInstanceInputLock(…, { mode: 'exclusive' })` の呼び手を全件 grep し、`new-window`・`respawn-pane`・`kill-session` の呼び手と突き合わせる（F3 を捨てる理由の裏取り。F1 はこれに依らない） | 任意 |
| R10 の各 CLI の capture の前後の処理（ready の return・trust・update・nudge のキー・再読の callback・`command-code.ts:325-390` の待ちの回数） | 各 `waitForPrompt`・起動時の回答の関数を読み、§4.4 の R10 の行（起動時の世代に拘束）で書けるかを確かめる | F1-b の最初 |
| T6・TA4・TB2 が develop で本当に赤になるか | 試験を書いて develop で 1 本ずつ動かす（`CM_DB_PATH=$PWD/data/test.db`、単一ファイル） | 各 PR の最初 |
| R11-b5（状態の証拠）・R11-f2（起動中）・R11-f3（model のラッチ）の読み手が行動に使うか | 各 `observe*`・`record*` の読み手を全件読む | F1-b の最初。表示だけと分かれば §3.3 の区別を直す |
| `--issue` の並列サーバーが同じ pane を扱わないこと（§4.7 の保証の範囲の前提） | 並列サーバーのセッション名の作り方と tmux の socket を読む | #4304 PR2a の最初 |

### 7.2 未決（誰が・何で・いつ決めるか）

| # | 未決 | 誰が | 何で | いつ／決まるまで |
|---|---|---|---|---|
| U1 | 表示の経路にしか bound な駆動元の無い副作用（R11-b2 ターンの終了、R11-b3・b4 の記録、R11-b5・f2 の観測、R11-s の sweep）を、(p) その経路の取得を bound にする（cache を外す）か、(q) bound の読者（R1・R8）へ移すか。どちらでも「表示用の frame では行わない」は変わらない | リーダー（数字で決まらなければ PM に上げる） | §7.1 の capture の回数の計測 | F1-b の契約の前。決まるまで F1-b を送らない。develop はそれまで今のまま |
| U2 | 世代の識別子に足すもの（§4.8 の E-3 の候補 (1)〜(3)、E-2 の不十分なときの代わり） | 実装者が §4.8 の結果を書き、リーダーが選ぶ。保証の範囲を狭める（server の入れ替わりを保証の外にする）なら PM の承認 | §4.8 の確かめの結果 | F1-a の基盤を書く前。決まるまで基盤をマージしない |
| U3 | BoundFrame・表示用の frame・unknown の型の名前、unknown を値で返すか例外で返すか、unknown の理由の識別子 | F1-a の実装者（レビューで確かめる） | §4.3 の境界を満たすこと（境界そのものはこの設計で決めた） | F1-a の中 |
| U4 | F1-b を R10 で F1-b1・F1-b2 に分けるか（R10 の入れ先が F1 の中であることは決めた） | リーダー | F1-b の差分の見積り（team.md §6-3 の目安） | F1-b の契約の時 |
| U5 | F2 を入れるか | リーダー | §7.1 の capture の回数 | F1-b の後 |
| U6 | 利用者から見える挙動の変更（§4.2: 手の回答が capture の失敗で未送信になる、relay・prompt guard が判定できないとき保留する）を受け入れるか | **人**（PM 経由。2-4-4 の承認のときに確かめる） | §4.2 の一覧 | F1-a の契約の前。受け入れない項目は、その入口を F1 の保証の外として明記する |

## 8. #4304 の設計書との関係

#4304 の設計書（`commandmate-issue-4300-design` の `docs/design/send-foreground-check-4300.md`、改訂 6）はこの文書では変えない。#4304 の**改訂 7** で次を反映する。

| #4304 の箇所 | 今の書き方 | 改訂 7 での書き直し |
|---|---|---|
| R6.1・R6.2 の世代の識別子 | `(pane_id, pane_start_command の nonce)` | grid の識別はこの設計の `(server の start_time, pane_id)`（§4.8 の U2 の結果を足した形）に置き換える。nonce は同じ grid の中で rc の出力と CLI の出力を分ける補助だけに残す |
| R6.5 dead の後の最後の画面の回収 | 「同じ `display-message` で `pane_dead=1` と識別子を読み、生前と同じならその capture を 1 回保存」（識別子の読みと capture が別の呼び出し＝T4 の穴、dead の読みと frame が同時でない＝TC1 の穴） | §4.6（dead を確かめた後に同じ世代を的に取った frame だけ）と §4.7（回収の権利の状態・寿命・作り直しの順）で書き直す。R1・R2 の dead の保存も同じ権利を通す |
| R6.6 の 9（同じ dead の世代の最後の回収／回収の途中の世代交代） | R6.5 の識別子の照合 | この設計の T4・T5・TC1〜TC3・TD1〜TD5 と、対照 (i)・(ii)・(iii) |
| R6.3 の操作ごとの条件・R6.4 の生の入力 | 画面を読む所は今の capture | 行動する読者として BoundFrame だけを使う（§3.2・§4.4）。配送の直前の世代の照合（§4.4 の R5・R8）と、#4304 のプロセスの証拠（E1）・番は別の保証として並べる（§1.5） |
| R6.7 の PR の順 | #4303-A → PR2a → PR2b → #4303-B | PR2a の前に F1-a・F1-b を置く（§5）。R10 は F1-b（PR2b は期待の世代の取り方を spawn の pane id へ替えるだけ）。回収の権利と最後の回収は PR2a、作り直しが回収の終端を待つ順は PR2b |
| 改訂 6 の再確認の A（P2） | 未解決 | この設計の G0〜G2 と F1 で閉じる |

## 9. 改訂の履歴

- 第 1 版（2026-11-14、`e1f92c211`）: 共通の原因・G1・G2・R1〜R11・F1・F1-a/b・T1〜T10 を書いた
- 第 2 版（2026-11-14）: 2-4-4 事前レビュー（`prereview-4304-capgen-reply.md`、承認保留、A〜F）とリーダーの再指示 1 を反映。G0 を最上位に置き、R11 を関数・副作用の単位で分け（§3.3・§3.4）、操作ごとの世代の寿命と行動の入口の境界（§4.3・§4.4）、最後の回収の条件（§4.6）、回収の権利の状態と作り直しの順（§4.7）、世代の識別子の成立条件（§4.8）を決め、F1-a/b を閉じる単位で引き直し（R10 は F1-b、回収の権利は #4304 PR2a）、T10 を境界の検査に替え、指摘ごとの対照 TA〜TF と全組み合わせの軸を足した。未決は U1〜U6 として誰が・何で・いつを書いた

### 第 2 版の指摘ごとの処置

| 指摘 | 処置 | 節 |
|---|---|---|
| A R11 に行動と記録が残る | 関数・副作用の単位で分け、純粋な表示だけ cache。副作用は bound な frame でだけ。駆動元の表 | §3.3・§3.4・U1 |
| B 期待の世代と unknown の契約 | 操作ごとの取り方・持ち方・照合の表、unknown の各 return は行動を許可しない、行動の入口の境界 | §4.2・§4.3・§4.4 |
| C dead の情報は最後の画面の証拠ではない | dead を確かめた後に同じ世代を的に取った frame だけ。alive→dead・dead→alive | §4.1・§4.6 |
| D 回収の完了と作り直し・失敗・寿命 | 状態 4 つ、finally で終端、番を取らない、作り直しは終端を待つ（上限つき、超えたら作り直さない）、1 プロセスの保証 | §4.7 |
| E 世代の一意性 | F1-a の最初に確かめる成立条件 E-1〜E-4 と候補 | §4.8・U2 |
| F PR の中間状態と担当 | 回答の経路（F1-a）と残り（F1-b）で閉じる。Fresh の削除と strict は同じ PR。R10 は F1-b。回収の権利は PR2a、作り直しの順は PR2b | §5 |
| §4 T10・試験 | T10 を境界の検査へ。TA〜TF・全組み合わせの軸・対照 (v) | §6 |
