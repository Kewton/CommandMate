# capture の frame を取得元の世代（pane）へ結び付ける（Issue #4304 の前提）設計

- 段: 設計（この文書だけ。コードは書かない）。実装は §5 の 2 本の PR（F1-a・F1-b）で、どちらも #4304 の PR2a より前に入れる
- 経緯: #4304 の設計（`commandmate-issue-4300-design` の `docs/design/send-foreground-check-4300.md`、改訂 6）の事前レビューで、「使う frame が取得元の世代に結び付かない」同じ種類の指摘が 3 回出た（改訂 6 の再確認 `prereview-4304-rev6-reply.md` の A、P2）。`docs/orchestrate/team.md` §6-6 に従い、作業に関わっていないイネーブラーが共通の原因を調べた（`enabler-return-4304-A-cause.md`、2026-11-14）。人の承認（2026-11-14、PM 追補 1 の 7）: A の共通の原因を「frame を取得元の世代へ結び付ける」小さな設計として切り出し、#4304 の実装より先に入れる
- リーダーの決定（この文書の前提）: **F1 を採る**（pane id を的にした capture＋frame に世代＋行動する読者はキャッシュを使わない＝狭めて塞ぐ）。F2 は F1 の後に capture の回数を測って必要なときだけ（**この設計では採らない**）。F3 は**採らない**。不変条件は G1・G2 をそのまま。世代の識別子は `(server の start_time, pane_id)`。`sweepStalePendingPrompts` は DB を書き換えるので**行動する読者**に入れる
- 基準: develop `a21776371`（`origin/develop` と同じ）。file:line はこの版で取り直した。実装の着手時は名前で探し直す
- 材料（リポジトリ外。`MyCodeBranchDesk/workspace/orchestration/runs/`）: `2026-11-14/enabler-return-4304-A-cause.md`（正本）、`2026-11-14/lead-request-enabler-4304-A-cause.md`、`2026-11-13/prereview-4304-rev6-reply.md` の A
- 表記: **事実**＝file:line・man の行がある文。**読み**＝そこからの推論（明記する）。**未確認**・**未決**は §7 に集める

## 1. 問題と共通の原因

### 1.1 事実: capture の層の作り

| 事実 | 出典 |
|---|---|
| tmux への capture は常にセッション名を的にする: `capture-pane -t =<session>:`（その時点の現在の窓・現在の pane） | `src/lib/tmux/tmux.ts:60-61`（`exactTarget`）、`tmux.ts:976` |
| capture の戻り値は文字列だけ（`Promise<string>`）。pane の識別子を返さない | `tmux.ts:952-985`（`capturePane`）、`src/lib/tmux/polling-tmux-transport.ts:56`、`src/lib/tmux/control-mode-tmux-transport.ts:61` |
| キャッシュのキーはセッション名だけ。TTL 5 秒 | `src/lib/tmux/tmux-capture-cache.ts:53`（`CACHE_TTL_MS = 5000`）、`:435-441`（`getOrFetchCapture(sessionName, …)`） |
| キャッシュの「世代」は無効化の回数（`invalidateCache`・`clearAllCache` で進む）で、pane の世代ではない | `tmux-capture-cache.ts:113-122`、`:349`、`:372` |
| キャッシュの命中は旧い frame をそのまま返す | `tmux-capture-cache.ts:443-450` |
| 待機中の取得に後から来た呼び手は、その旧い結果をそのまま受け取る（`joined`） | `tmux-capture-cache.ts:452-461` |
| 無効化の世代が動いていれば書き戻さないが、取得を始めた本人へは返す | `tmux-capture-cache.ts:476-482` |
| キャッシュを通らない `captureSessionOutputFresh` も、結果をセッション名のキーでキャッシュへ書き戻す（無効化の世代が同じなら） | `src/lib/session/cli-session.ts:201`・`:224-227` |
| frame に付く由来は「取得の開始時刻」と `fetched`／`cache`／`joined` だけ（#3798） | `tmux-capture-cache.ts:408`、`src/lib/session/waiting-episode-binding-observation.ts:194`（`captureObservedFrame`） |
| 新しいプロセスの世代の始まり（`beginAgentSession`）は capture のキャッシュを無効化しない | `src/lib/session/agent-session-lifecycle.ts:77`（同ファイルに `invalidateCache` は 0 件） |
| 今の復旧は同じ pane へ起動し直す（`relaunchIfToolExited`）。`new-window -k` はセッション作成時の窓 0 の作り直しにだけある | `src/lib/cli-tools/base.ts:780`、`tmux.ts:575` |
| セッションの改名では pane は同じなのにキャッシュを捨てる | `tmux.ts:1063`・`:1082-1083` |
| `pane_id`（`%N`）は「tmux server の中で、その pane の寿命の間、一意で変わらない」。`TMUX_PANE` で子にも渡る。server の開始時刻は `start_time` | `man tmux`（tmux 3.5a、`/opt/homebrew/share/man/man1/tmux.1` の 904-916 行・5839 行・5901 行） |
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

### 1.4 反証の比較（イネーブラーの調査）

| 仮説 | 反証 | 扱い |
|---|---|---|
| H1 キャッシュの TTL・無効化の漏れ（`beginAgentSession` に `invalidateCache` を足せば直る） | 足しても (c) の合流済みの呼び手と (d) の本人へは旧結果が返る。Fresh・direct の読者の (a) はキャッシュと無関係に残る | 寄与要因。共通の原因ではない |
| H2 番（ロック）が足りない | 番は「番の中で作り直しが入らない」ことしか言わない。番の前に取った frame（`prompt-answer-sender.ts:129-131`）は番を越えて持ち込まれる。番を取らない作り直し（CommandMate の外の tmux 操作・CLI の終了）もある | 寄与要因。共通の原因ではない |
| H3 capture が由来を返さず、確認と使用が別の観測 | pane id を的にして取り、frame に id を持たせ、使う所で照合すると、(a) は旧 pane が無いので取得が失敗し、(b)(c)(d) は id の不一致で使われない | **原因として採る** |

## 2. 不変条件

> **G1** 呼び手が行動（キー・保存・状態の書き換え・送る／保留の決定）に使う frame は、その呼び手が確認した世代の pane から、確認の後に取得したものだけ。合わなければ使わず、再取得か「不明」として扱う。
>
> **G2** 同じ世代の最後の画面の回収は、どの経路から来ても合計 1 回。

- **世代の識別子**は `(server の start_time, pane_id)`。server が変われば pane id が振り直されうるので start_time を足す（読み。§7 で確かめる）。
- #4304 の設計 R6.2 の `(pane_id, nonce)` の nonce は「同じ grid の中で rc の出力と CLI の出力を分ける」補助で、grid の識別には使わない（§8）。

## 3. capture の全読者の表

列: **区別**＝行動する読者（frame でキー・保存・DB の書き換え・送る／保留を決める）か、表示の読者か。**取得**＝cache（`captureSessionOutput` → `getOrFetchCapture`）、fresh（`captureSessionOutputFresh`）、direct（`capturePane` 直）。**順序**＝1.2 のどれで旧 grid を受け取りうるか。どの読者も**世代を知らない**（今は frame と結べる pane の識別子が無い）。

| # | 読者 | 区別 | 取得（file:line） | 順序 | frame で何をするか |
|---|---|---|---|---|---|
| R1 | 通常の応答 poll | 行動 | cache: `src/lib/polling/response-checker.ts:1753-1755` | (a)(b)(c)(d) | 応答・プロンプトの行を保存（`:1766`・`:1799`）、カーソル。持つのは tick の所有（`mayStillActAfter`、`:1764`）と frame の時刻だけ |
| R2 | 応答の保存・カーソル（非代替画面の CLI） | 行動 | cache: `src/lib/assistant-response-saver.ts:279`・`:385` | (b)(c)(d)（(a) は R1 経由） | 履歴へ保存・`lastCapturedLine` を進める |
| R3 | 復旧側の最後の画面の回収（#4304 の R6.5。develop には未実装） | 行動 | 未実装（今の部品で書けば cache か direct） | (a)、cache なら (b)(c)(d) | 旧世代の最後の画面として 1 回保存 |
| R4 | Auto-Yes の tick | 行動 | cache: `src/lib/auto-yes-poller.ts:1029` → `src/lib/polling/auto-yes-poller-capture.ts:77` | (b)(c)(d) | 回答の判定・内容の決定・`finishAnsweredPrompt` へ同じ frame（`auto-yes-poller.ts:938`）。tick の世代 `sessionEpoch`（`auto-yes-poller-generation.ts:199`）は起動の始まりで進むので、起動の後に始まった tick がキャッシュの旧 grid を読めば「今の epoch の frame」として通る（読み） |
| R5 | 回答の送る直前の再読（通常の回答・Auto-Yes） | 行動 | direct: `src/lib/prompt-answer-sender.ts:667`（`answerTargetStillOnScreen`）、`:131`（`readGuardFrame`。呼び手の frame があればそれを使う＝`:129`、R4 の cache の frame）、`:476`（キーの後の再読） | (a)（番を取らない作り直しでだけ）。`:131` は R4 経由で (b)(c)(d) | どのキーを送るか・送るかどうか。番の中の前景の確認（`:806`、#4303）と `:667` の capture は別の呼び出し |
| R6 | `/prompt-response` の再確認 | 行動 | fresh: `src/app/api/worktrees/[id]/prompt-response/frame-verification.ts:83`・`:127` | (a)、書き戻しで他者の (b) を作る (d) | 回答の送信の可否 |
| R7 | strict の respond | 行動 | fresh: `src/app/api/worktrees/[id]/respond/screen-at-send.ts:62`、`src/lib/session/strict-prompt-answer-io.ts:84` | (a)(d) | キーごとの判定 |
| R8 | 送信の前の判定（readiness・前景・プロンプト待ち） | 行動 | fresh: `src/lib/session/send-user-message.ts:338`、`src/app/api/worktrees/[id]/send/pane-shell.ts:44`。cache: `src/lib/session/prompt-waiting-guard.ts:113`（`send-user-message.ts:495` が使う）、`src/lib/relay/relay-readiness.ts:86` | fresh は (a)(d)、cache は (b)(c)(d) | 送る／保留の決定 |
| R9 | 送信の中の入力欄の読み・クリア | 行動 | direct: `src/lib/cli-tools/submit-verified-sender.ts:360`・`:432`・`:440`・`:534`・`:829`、`src/lib/cli-tools/submit-verified-sender-report.ts:84`・`:124`、`src/lib/session/composer-clear.ts:196`・`:277`、`src/lib/session-key-sender.ts:38` | (a)（番を取らない作り直しでだけ） | 本文・Enter・クリアのキー |
| R10 | 起動・準備完了（readiness）・起動時の回答・生存の確認 | 行動 | direct: `src/lib/cli-tools/base.ts:416`・`:537`、`src/lib/cli-tools/session-liveness.ts:38`（`probeSessionLiveness`。`BaseCLITool.isToolLive` が使う、`base.ts:410`・`:415`）、`codex.ts:436`・`:732`・`:781`・`:860`・`:961`、`copilot.ts:607`・`:693`・`:788`・`:894`・`:1161`、`gemini.ts:216`・`:242`・`:298`、`command-code.ts:328`・`:368`、`opencode.ts:604`・`:1015`、`opencode-v2.ts:334`・`:366`、`antigravity.ts:377`・`:445`・`:478`、`vibe-local.ts:257`、`claude-auto-default-nudge.ts:67`・`:97`・`:144`（以上 `src/lib/cli-tools/`）、`src/lib/session/claude-session.ts:677`・`:1222` | (a)（起動の番の外で作り直されたとき）。生存の確認が (a) で後継を読むと「生きている」と読み違える（読み） | 起動の成否・trust 等へのキー |
| R11 | 表示だけ（状態・画面・診断） | 表示 | cache: `src/lib/session/worktree-status-helper.ts:900-902`、`src/lib/session/current-output-builder.ts:1002`。direct: `src/app/api/worktrees/[id]/capture/route.ts:95`、`src/lib/tmux/read-mode-pager.ts:159`（シェルの `capture-pane -t "=$SESSION:"`）、`src/lib/agent-health/frame-archive.ts`（診断の保存） | (b)(c)(d) | 表示・状態の推定・待ちのエピソード（#3798） |
| R11-s | `sweepStalePendingPrompts`（R11 の状態の probe の中） | **行動**（リーダーの決定） | R11 と同じ cache の frame: `worktree-status-helper.ts:900-902` → `:908`（関数は `:739`） | (b)(c)(d) | 画面にプロンプトが無いと読むと、DB のプロンプトの行を `markPendingPromptsAsAnswered`（`src/lib/db/chat-db.ts:852`）で「答え済み」へ書き換える |

- 見た範囲: `git grep -n -E 'capturePane\(|captureSessionOutput\(|captureSessionOutputFresh\(|getOrFetchCapture\(' -- src ':!*.test.ts'` の全件（a21776371）。`src/cli/commands/capture.ts:305` は同名の CLI 側の関数で、サーバーの API を呼ぶだけ（tmux を直に読まない）なので表に入れない。R10 の各 CLI の行は呼び出しの場所だけ確かめ、前後の処理は**未確認**（§7）。

## 4. F1 の設計

### 4.1 形

| 部品 | 置き場所 | 形 | すること |
|---|---|---|---|
| `readPaneGeneration` | `src/lib/tmux/tmux.ts` | `readPaneGeneration(session) → { startTime, paneId, dead } \| null` | `display-message -p -t =<session>: '#{start_time}\t#{pane_id}\t#{pane_dead}'` を 1 回。読めない・空・形が違えば `null` |
| `capturePaneById` | `src/lib/tmux/tmux.ts` | `capturePaneById(paneId, opts) → string`（失敗は throw） | `capture-pane -t %N`。セッション名を使わない。旧 pane が無くなっていれば tmux が失敗し、**後継の grid は構造的に返らない** |
| `captureBoundFrame` | `src/lib/session/cli-session.ts` | `captureBoundFrame(target, expected?: PaneGeneration) → { frame, generation, dead } \| { unknown: reason }` | ① 世代を読む（`expected` があれば一致を要求）→ ② その `%N` を capture → ③ もう一度世代を読み、①と③が同じなら frame を返す。キャッシュを**読まない・書かない** |

`PaneGeneration` は `(startTime, paneId)` の組。`dead` は frame と同じ読みの `pane_dead`（③の値）。

### 4.2 `unknown` の理由

| 理由 | いつ | 呼び手の扱い |
|---|---|---|
| 世代が読めない | ①か③の `readPaneGeneration` が `null`（`display-message` の失敗・空・セッションが無い） | 行動しない（キー 0・保存しない・DB を書き換えない）。次の tick で取り直す |
| 世代が違う | `expected` を渡し、①が `expected` と違う | 同上。確認した世代は既に無い |
| pane が無い | ② の `capture-pane -t %N` が失敗（旧 pane が消えた） | 同上 |
| 取得中に変わった | ①と③の世代が違う | 同上。frame がどちらの世代か言えない |

「不明」を「画面が消えた」「解決した」とは読まない（#4304 の R6.3 の Auto-Yes の行と同じ扱い）。

### 4.3 狭めて塞ぐ（型とガード）

- 世代を確かめられない読者は frame を行動に使えない（team.md §6-5）。キャッシュの経路（`captureSessionOutput`）が返すものは「表示用の frame」とし、行動する読者（R1〜R10・R11-s）は `captureBoundFrame` だけを使う。
- 静的なガードを 1 本足す（既存の `tests/unit/guards/pane-key-writers.test.ts`・`pane-key-writers-scan.ts` と同じ形）: 行動する読者のファイルに `captureSessionOutput(`・`captureSessionOutputFresh(`・`capturePane(` が残らないことを数える。F1-a は F1-a で移した読者のファイルを、F1-b で残りを対象に足す。

### 4.4 キャッシュの扱い

- 行動する読者はキャッシュを使わない（読まない・書かない）。(b)(c)(d) は行動の経路から消える。
- `captureSessionOutputFresh` のキャッシュへの書き戻し（`cli-session.ts:224-227`）を**やめる**。表示用のキャッシュへ旧 pane の frame を入れないため。
- 表示用（R11）はセッション名のキーのまま。表示が旧 grid を最大 5 秒見せても、行動に使われなければ G1 を壊さない。
- 読み: 状態の probe の capture（#965 で減らした回数）は R11 のままなので増えない。増えるのは R1・R4 の tick ごとの `display-message`×2＋`capture-pane`×1（応答 poll は 2 秒＝`src/lib/polling/response-poller-core.ts:37`、Auto-Yes は 2 秒＝`src/lib/auto-yes-state.ts:996`、考え中は 5 秒＝`src/config/auto-yes-config.ts:36`）。測り方は §7。

### 4.5 回収の権利（G2）

- 世代ごとの「回収の権利」の表（`Map<世代, 'claimed'>`）を小さなモジュールに置く。権利は**世代ごとに 1 回**。
- 権利は **await の前に同期で取る**（表を見て無ければ set、までを 1 つの同期の区間で行う）。権利を取った 1 者だけが `captureBoundFrame(…, 旧世代)` で回収して保存する。取れなかった者は回収しない。
- 回収の `captureBoundFrame` が `unknown` を返したら、その世代の最後の画面は保存しない（後継の grid を旧世代として保存しない）。
- 作り直し（#4304 の L1 の `new-window -k`）は exclusive の番の中で「未回収なら権利を取って回収してから」行う（#4304 の R6.5 の順のまま）。

### 4.6 読者ごとの適用

| 読者 | F1 での形 |
|---|---|
| R1・R2 | `captureBoundFrame` で取り、tick の状態に持つ世代と照合する。違えば保存しない |
| R3 | 回収の権利（4.5）＋`captureBoundFrame(…, 旧世代)`。呼び手は #4304 の PR2a |
| R4 | `captureBoundFrame` で取り、frame とその世代を回答の経路へ渡す |
| R5 | `:131` は呼び手の frame の世代を、`:667` の再読（`captureBoundFrame`）の世代と照合する。違えば `target-changed`（キー 0） |
| R6〜R10 | `captureBoundFrame` へ差し替える |
| R11-s | 世代つきの frame でだけ DB を書き換える（形は §7 の未決） |
| R11 | 今のキャッシュのまま |

### 4.7 採らない案

- **F2「キャッシュのキーに世代を入れる」**: この設計では採らない。F1 の後に capture の回数を測り（§7）、負荷が問題になったときだけ別に考える。キャッシュの命中の frame は「確認の後に取得した」（G1 の後半）を満たさず、満たすには取得の開始時刻の規則（#3798）と重なり、組み合わせ（命中・合流・自分の取得 × 世代の一致・不一致 × 確認の前・後）が F1 の約 3 倍になる（読み）。
- **F3「行動は番の中で取り直した frame だけ」**: 採らない。番を取らない作り直し（CommandMate の外の tmux 操作・CLI の終了）には (a) が残り、番の中の capture も文字列だけなので、確認と使用がまだ別の観測（原因の A が残る）。

## 5. PR の分け方

どちらも **#4304 の PR2a より前**。team.md §6-3 の目安（数百行・20 ファイル程度）に合わせて 2 本に分ける。

| PR | 中身 | 目安（読み） |
|---|---|---|
| **F1-a**（基盤＋A で名指しされた読者） | `readPaneGeneration`・`capturePaneById`（`tmux.ts`）、`captureBoundFrame`（`cli-session.ts`）、Fresh の書き戻しの削除、R1（`response-checker.ts`）・R2（`assistant-response-saver.ts`）・R4（`auto-yes-poller-capture.ts`・`auto-yes-poller.ts` の frame の受け渡し）・R5（`prompt-answer-sender.ts`）、回収の権利のモジュール、ガード 1 本、§6 の試験 | 10〜12 ファイル、本体 250〜400 行＋試験 300〜500 行（R1・R4 の呼び出しの周りの改修量は未確認） |
| **F1-b**（残りの行動する読者） | R6・R7・R8・R9・R10（`cli-tools` の 10 ファイル前後）と `sweepStalePendingPrompts`（R11-s）。ガードの対象を足す。R10 は #4304 の PR2b（spawn と同じ呼び出しで pane id を読む）に入れてもよい | 15〜20 ファイル、本体 200〜300 行（呼び出しの差し替えが主） |

- R3（復旧側の回収）は develop に無いので、F1-a は「回収の権利」と `captureBoundFrame(…, 旧世代)` までを入れ、呼び手は #4304 の PR2a（R6.5）が作る。
- API は呼び手と同じ PR で作る（team.md §6-4）: F1-a の `captureBoundFrame` の `expected` は R5 の照合が呼び手になる。

## 6. 全組み合わせの試験の表

単体（tmux を偽の transport にする。実 tmux は不要）。各行は「他の条件を満たし、1 つだけ変える」。試験を先に入れて develop で赤を確かめてから F1 を入れて緑にする。

| # | 状態の作り方 | 読者 | 期待（直した後） | 直す前（develop） |
|---|---|---|---|---|
| T1 | 旧 pane の frame がキャッシュにある → 作り直し（pane id が変わる）→ 5 秒以内に読む | R1・R4 | 旧 frame で保存・回答をしない（`unknown` か新 pane の frame） | 赤: 旧 frame が返る（`tmux-capture-cache.ts:443-450`） |
| T2 | 旧 pane への取得が待機中 → 作り直し → 別の呼び手が合流 | R1・R4 | 合流した呼び手も旧 frame を使わない | 赤: `joined` で旧 frame（`:452-461`） |
| T3 | 旧 pane への取得が作り直しの後に完了（fresh・cache の両方） | R1・R6 | 本人は使わない。キャッシュにも入らない | 赤: 本人へ返り（`:480-482`）、無効化が無ければ書き戻す（`:476`、`cli-session.ts:224-227`） |
| T4 | 旧世代の dead を確認 → 別の呼び手が作り直し → セッション名で capture | R3・R1 | 後継の grid を旧世代の最後の画面として保存しない（取得は `unknown`） | 赤: 後継の grid が返る（`tmux.ts:976` の `=s:`） |
| T5 | 通常 poll と復旧側が同じ dead の世代を同時に回収 | R1・R3 | 保存は合計 1 回 | develop には回収が無い。#4304 の PR2a の試験として赤を確かめる（未確認） |
| T6 | 番の外で取った frame（Auto-Yes の cache の frame）を回答の番へ持ち込む → 番の前に作り直し | R4→R5 | `target-changed`、キー 0 | 赤（読み）: `:131` が呼び手の frame を使い、`:667` の再読は新 pane を読む。新 pane に同じ形のダイアログがあれば通る |
| T7 | 陽性対照: 作り直し無し、同じ世代 | 全行動読者 | frame を使う（保存 1 回・回答 1 回） | 緑（今と同じ） |
| T8 | 陽性対照: 作り直しの後、新世代を確かめてから取る | R1・R4・R10 | 新 frame を使う | 緑 |
| T9 | 世代が読めない（`display-message` の失敗・空） | 全行動読者 | `unknown`。行動しない | 実装による |
| T10 | 静的なガード: 行動する読者のファイルに `captureSessionOutput(`・`captureSessionOutputFresh(`・`capturePane(` が無い | — | 0 件 | 赤（今は 40 か所以上、§3） |

防御を 1 つずつ外す対照（F1 を入れた後、1 つだけ戻して赤を確かめる）:

- **(i)** `%N` を的にするのをやめて `=s:` に戻す → T4 が赤
- **(ii)** 取得の後の世代の再読（4.1 の③）を外す → 「取得中に作り直し」の T3 の変形が赤
- **(iii)** 回収の権利の表を外す → T5 の保存が 2 回
- **(iv)** Fresh の書き戻しを戻す → T3 のキャッシュ側が赤

## 7. 未確認・未決と確かめ方

### 7.1 未確認（実装の最初に、隔離の `tmux -L <名前>` で確かめる。本番の tmux server には触らない）

| 未確認 | 確かめ方 |
|---|---|
| pane id がその tmux server の中で**再利用されない**こと（man は「寿命の間、一意で不変」と書くだけ） | 隔離の `tmux -L` で pane を作って消して作り、id が増え続けるかを見る。あわせて tmux のソースの pane id の採番（`window.c`）を読む |
| remain-on-exit の dead pane を `capture-pane -t %N` で読めること、消えた `%N` への capture が失敗（exit≠0）になること | 同上、1 回ずつ |
| `start_time` の書式と、server の再起動で pane id が振り直されること | 同上（server を kill して起動し直し、`%0` から振り直されるか） |
| R1・R4 のキャッシュを外したときの capture の回数の増え方 | `worktree-status-helper.ts:107` の `captureCount` と同じ数え方を R1・R4 に足し、隔離のサーバーで 1 時間、F1 の前後を測る。F2 を考えるかはこの数で決める |
| pane を作り直す全操作が exclusive の番を取るか（`kill-session` API・`session-cleanup.ts`・CLI 自身の終了） | `withInstanceInputLock(…, { mode: 'exclusive' })` の呼び手を全件 grep し、`new-window`・`respawn-pane`・`kill-session` の呼び手と突き合わせる（F3 を捨てる理由の裏取り。F1 はこれに依らない） |
| R10 の各 CLI の capture の前後の処理（世代をどこで知れるか） | 各 `waitForPrompt`・起動時の回答の関数を読む。#4304 の L1 の spawn が pane id を返す形なら、その id を的にするだけで済むか |
| T6 が develop で本当に赤になるか | 試験を書いて develop で 1 本だけ動かす（`CM_DB_PATH=$PWD/data/test.db`、単一ファイル） |
| `control-mode-tmux-transport.ts:61` を使う読者の有無 | `getControlModeTmuxTransport()` の呼び手を全件読む |

### 7.2 未決（この設計では決めない）

- R11-s（`sweepStalePendingPrompts`）の直し方: 世代つきの frame でだけ書き換える／書き換えを R1 の側へ移す、のどちらにするか。行動する読者に入れること（ガードの対象）までは決まっている。F1-b の着手時に決める
- R10 を F1-b と #4304 の PR2b のどちらに入れるか（どちらでもよい、まで決まっている）
- 表示用の frame と行動用の frame の型の名前と、`unknown` の理由の識別子の名前（4.2 は意味だけを決めた）
- F2 を入れるか（7.1 の capture の回数を測ってから）

## 8. #4304 の設計書との関係

#4304 の設計書（`commandmate-issue-4300-design` の `docs/design/send-foreground-check-4300.md`、改訂 6）はこの文書では変えない。#4304 の**改訂 7** で次を反映する。

| #4304 の箇所 | 今の書き方 | 改訂 7 での書き直し |
|---|---|---|
| R6.1・R6.2 の世代の識別子 | `(pane_id, pane_start_command の nonce)` | grid の識別はこの設計の `(server の start_time, pane_id)` に置き換える。nonce は同じ grid の中で rc の出力と CLI の出力を分ける補助だけに残す |
| R6.5 dead の後の最後の画面の回収 | 「同じ `display-message` で `pane_dead=1` と識別子を読み、生前と同じならその capture を 1 回保存」（識別子の読みと capture が別の呼び出し＝T4 の穴） | 回収の権利（4.5）を同期で取り、`captureBoundFrame(…, 生前の世代)` で回収する。`unknown` なら保存しない |
| R6.6 の 9（同じ dead の世代の最後の回収／回収の途中の世代交代） | R6.5 の識別子の照合 | この設計の T4・T5 と、対照 (i)・(iii) |
| R6.3 の操作ごとの条件・R6.4 の生の入力 | 画面を読む所は今の capture | 行動する読者として `captureBoundFrame` の frame だけを使う（§3 の R5〜R9） |
| R6.7 の PR の順 | #4303-A → PR2a → PR2b → #4303-B | PR2a の前に F1-a・F1-b を置く（§5）。R10 は PR2b に入れてもよい |
| 改訂 6 の再確認の A（P2） | 未解決 | この設計の G1・G2 と F1 で閉じる |
