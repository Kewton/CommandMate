# 1 回の送信の端末の変更を 1 か所の柵に通す（Issue #4534）設計

- 段: 段 1（設計 1 枚。この文書だけ）。src・tests は書かない。段 2 で、試験を先に書き（直す前の赤を確かめる）、その後に実装する
- 版: 第 2 版（2026-11-22）。第 1 版 `6c495b52b`
- 基準: develop `ad21704ea`。行番号はこの版のもの。Issue の行番号（`192f9dca1`）は §1.2 で今の位置に直した
- 正: Issue #4534 の本文（事象 F1〜F5・不変条件 I1〜I4・受入条件・範囲の外）。この文書は本文の意味を狭めない
- 材料: s9 の `review-4518-4492-codex-r2.md`（A2）・`review-4518-v3-codex.md`（2）・`review-4518-v3-opus.md`（P1-1・P2-2）・`review-4466-exact-diff-codex.md`（2・3・6）・`worker-return-4518-stage1.txt`・`followup-candidates.md`（追跡票 T6・T8・T10）。関連の設計 `docs/design/send-atomic-4466.md`
- 第 2 版の材料: s10 の `review-4534-design-codex.md`（P1 4・P2 5・P3 1）・`review-4534-design-opus.md`（P1 1・P2 7・P3 10）・`reinstruct-4534-design-r1.md`（処分 A〜J と追記）・`pm-reply-4534-design-wait.md`
- 書き方: 「事実」は file:line で確かめたこと。「見立て」「未確認」は明記する。この文書の試験の番号は `T1`〜、追跡票（followup-candidates）の番号は「追跡票 T6」と書いて区別する

## 第 2 版の変更点

| 単位 | 処分した指摘 | 直した節 |
|---|---|---|
| A. 札の欠落を fail-closed に | codex P1-1・opus P1-1・opus P2-5（U1・U4） | §0、§2.3（入口と権限の表）、§2.4（送信の層の印と門の判定）、§2.6（範囲と受け継ぎ）、§5 G3、§6 T12a・T12b、§9 |
| B. I2 が保証する時点 | codex P1-2・P2-1、opus P3-8（U5）、PM の追記 | §0、§2.5（発行の時点と実変更の時点、案 B1・B2 と費用）、§6 の「発行済み・変更前」の対照、§9 P-1 |
| C. 列挙の漏れ | codex P1-3・opus P2-1・P2-2・P3-1・P3-2 | §1.1（E20〜E22、E1・E2 の `set-window-option`）、§1.3（control mode）、§1.4（grep）、§2.3（`/terminal`） |
| D. I3 の分類を入口ごとに | codex P1-4・opus P2-4 | §3.2（分類の順と入口の表）、§6 T3・T5 |
| E. 後始末・kill を門で止めない | opus P2-3（U7） | §2.7、§1.1 E19・E21、§9 |
| F. 比べ方の誤検知 | opus P2-6（U5） | §2.2（比べ方の表を「実在の宛先か」に） |
| G. OpenCode の門の照合先 | codex P2-2 | §2.8、§6 T6 |
| H. 検査と試験の陰性対照 | codex P2-3、opus P3-9 | §5（肯定の対照→拒否・欠落）、§6（足場・各試験の直し） |
| I. 公開の契約は 2 案を比べる | codex P2-4・opus P2-7・opus P3-10（U2・U3）、PM の追記 | §3.3（案 a・b、推奨 b、値は人の答えの後に確定）、§3.4（CLI の出力の約束を限定、reason の優先順位） |
| J. relay の両端 | codex P2-5（U6） | §2.9 |
| P3 | codex P3-1、opus P3-3〜P3-7・P3-10 | §8.1（追跡票の表記）、§2.10（ファイル）、§2.4（`paste-buffer` の門の位置）、§2.3（相乗りの launch・正規化・`run`）、§8.2 |

---

## 0. 結論

| 項目 | 内容 |
|---|---|
| 柵の形 | 要求ごとの札を AsyncLocalStorage に持ち、端末を変える最下層の直前の同期の一歩で `fenceGate` が札を確かめる。最下層は `tmux.ts` の変更の関数、送信器の `paste-buffer`、OpenCode の `prompt_async` の POST、Claude の起動の `set-environment` |
| fail-closed（I1） | 送信だけが使う中間の層が「送信の変更」の印を付け、印の下で開いた札が無ければ門が投げる（§2.4）。札の欠落を `literal` で埋めない。timer・`/terminal` のコマンド送信は、入口で明示の札を作る。Auto-Yes の poller・respond・人の直接のキーは、入口で「送信の外」と宣言する（§2.3） |
| I2（**狭めない**） | 確かめから spawn・fetch の開始までは同期で、同じプロセスの JS は割り込めない（発行の時点）。**実変更の時点まで閉じるために、案 B1（名簿の書き手との排他。宛先ごとの貸し出し、DB に置く）と案 B2（ペイン ID で打つ）の両方を採る**（§2.5）。両方を入れたうえで残る窓は、CommandMate を経ずに DB を直に書く書き手だけ（§2.5.4）。これを I2 の外と読むかは PM・人が決める（§9 P-1） |
| I3 | 断った理由は札の上に、元の型と `cause` を持つ object で置く。分類は入口ごとに決まった順で行う（§3.2）。宛先の変化は 409、予約の喪失は今の答え、呼び出しの誤りは 500。409 には `sendOutcome` が必ず付く |
| 公開の契約 | 案 (a) 既存の 409 `roster_changed`・exit 31 に寄せる、案 (b) 新しい 409 `SEND_TARGET_CHANGED`・exit 34。推奨は (b)。**exit と `reason` の値は人の答えの後に確定する**（§3.3） |
| I4 | 宛先が変わらない送信では、門は確かめて数えるだけ。tmux を mock する既存の試験は門ごと mock されるので変わらない。ただし fail-closed（A）は、札の無いまま本物の門まで届く既存の試験を赤にしうる。その数は段 2 の最初に測り、PM が決める（§4.2、§9 P-2） |
| 数 | 端末の変更の箇所は 22 行（§1.1 の E1〜E22。E23 は変更ではない）。Issue の F1・F2・F3・F5 に当たるのが 4 行、F3 の延長が 1 行、**Issue に無いものが 14 行**、本文の後で門だけ要るものが 3 行。送信の入口は 4 つ（§2.3）。未決は PM の判断 2 件と、その他 7 件（§9） |

---

## 1. 端末の変更の全列挙（送信 1 回の順）

### 1.1 送信の要求の中で端末を変える箇所

「境界」は、今の `beforeInput`（`noteInputStart` / `noteDispatchStart`）より前か後か。「門の扱い」は §2.4 と §2.7 による。

| # | 中身 | 今の位置（事実） | 境界 | Issue | 門の扱い（段 2） |
|---|---|---|---|---|---|
| E1 | ペインの作成（`new-session`→`set-option`→`new-window`→`respawn-pane`→`set-window-option`→`resize-window`） | `src/lib/tmux/tmux.ts:531`・`:552`・`:573`・`:447`（`respawnLoginShell`、`:584` から）・`:176–186`（`reconcileSessionGeometry`、`:604` から）。呼び手 `src/lib/cli-tools/base.ts:929`（`createLaunchPane`）・`src/lib/session/claude-session.ts:999` | 前 | 無し | `createSession` は **1 つの変更**として扱う。`new-session` の直前で 1 回確かめ、通ったら関数の中の残りは同じ許可で通す（§2.7） |
| E2 | 再利用するペインの形の直し（`set-window-option`・`resize-window`） | `tmux.ts:174–187`。呼び手 `base.ts:452`（`reconcileExistingSession` `:445`、`resolveLaunchPane` `:889` から）・`claude-session.ts:930` | 前 | 無し | 各 `execFileAsync` の直前 |
| E3 | ツール自身の `resize-window` | `src/lib/cli-tools/opencode.ts:449–452`・`src/lib/cli-tools/opencode-v2.ts:284–287`（tmux の層の外の `execFileAsync`） | 前 | 無し | `tmux.ts` に門のある関数を足し、そこへ寄せる（G2 の行を減らす） |
| E4 | 起動の打鍵（起動行・`unset CLAUDECODE`） | `src/lib/cli-tools/launch-keys.ts:39–52`（`sendKeys` `:47`）。呼び手 `claude-session.ts:1019`・`codex.ts:337`・`:343`・`gemini.ts:178`・`copilot.ts:536`・`antigravity.ts:497`・`command-code.ts:303`・`vibe-local.ts:164`・`opencode.ts:504`・`opencode-v2.ts:304` | 前 | **F3** | `sendKeys` の中 |
| E5 | 起動中の画面への答え（trust・update・hooks の画面・auto-default の案内） | `codex.ts:630–735`・`:856–925`、`copilot.ts:604–608`、`gemini.ts:236–246`、`antigravity.ts:570–574`・`:676–682`、`claude-session.ts:479–489`、`src/lib/cli-tools/claude-auto-default-nudge.ts:140–145` | 前 | 無し | `sendKeys`・`sendSpecialKey(s)` の中 |
| E6 | 送信器の中での起動し直し（E1〜E5 をもう一度） | `base.ts:814–838`（`requireSession` の `relaunch: true`）→ `base.ts:780`（`relaunchIfToolExited`）。呼び手 `codex.ts:1025`・`antigravity.ts:760`・`gemini.ts:333`・`copilot.ts:922`・`command-code.ts:420`・`vibe-local.ts:190`・`opencode.ts:914`・`opencode-v2.ts:387` | 前 | F3 の延長 | E1〜E5 の門 |
| E7 | 送信の前の claude の案内への答え | `claude-session.ts:1183`（`answerClaudeAutoDefaultNudgeBeforeSend`）→ `:479–489` | 前 | 無し | E5 と同じ |
| E8 | copilot の `/model`（本文の前の準備の入力） | `copilot.ts:1124–1125`（`typeLeavingMarkOnFailure` → `sendKeys(text, true)` `:328`）。呼び手 `src/lib/session/send-user-message.ts:530–533` | 前 | **F2** | `sendKeys` の中 |
| E9 | 前の送信の残りの取り下げ（carried paste の消去） | `src/lib/cli-tools/submit-verified-sender.ts:384`（`waitOutCarriedPaste` `:357–399`）→ `src/lib/session/composer-clear.ts:215`・`:217` | 前 | 無し | `clearComposerLine`・`clearComposerPasteToken` の中（`tmux.ts:1220`・`:1248`） |
| E10 | 送信の前の入力欄の消去（`C-e C-u`） | `submit-verified-sender.ts:758`（`clearComposerBeforeSend` `:633–679`）→ `composer-clear.ts:215`・`:217` | 前 | **F1** | 同上 |
| E11 | copilot の選択の一覧のコマンド | `copilot.ts` の `sendMessage`（`noteInputStart` の後に `typeLeavingMarkOnFailure`、`:936–963` 付近） | 後 | 無し | `sendKeys` の中 |
| E12 | 本文の打鍵（`send-keys -l`） | `submit-verified-sender.ts:802`（`noteInputStart` `:800` の後） | 後 | — | `sendKeys` の中 |
| E13 | 本文の貼り付け（`paste-buffer`） | `submit-verified-sender.ts:280`（`runTmux`。`noteInputStart` `:274` の後）。`load-buffer` `:250` はペインを変えない | 後 | — | `:271–277` の `try` の中（`runBeforeBody`・`noteInputStart` と同じ catch。断ると load 済みの buffer を消す。opus P3-4） |
| E14 | Enter・Enter の打ち直し | `submit-verified-sender.ts:830`・`:933`（`sendSpecialKeys`） | 後 | — | `sendSpecialKeys` の中（キーごと） |
| E15 | 失敗の後の後始末（本文の取り下げ・置き換えの消去） | `submit-verified-sender.ts:329`・`:332`（`withdrawUnsentBody`）・`:894`（`clearInputLine`） | 後 | 無し | 後始末の許可（§2.7） |
| E16 | OpenCode の HTTP の dispatch（1 回目） | `opencode.ts:779`（`noteDispatchStart`）→ `:785`（`sendOpencodePrompt`）→ `src/lib/hooks/sources/opencode/client.ts:584–600`（`loopbackFetch` `:124–126`） | 境界はある | **F5** | `sendOpencodePrompt` の `try` の前。照合先は §2.8 |
| E17 | OpenCode の 2 回目の dispatch（添付の送信の後の文字の送信） | `opencode.ts:1103–1114`（`sendMessageWithImage`）→ `sendMessageAfterDispatch` → `:914–917` の `trySendViaServer` | 境界はある | 無し | 別の発行として同じ門（§2.8） |
| E18 | OpenCode のキーボードへの切り替え | `opencode.ts:934`（E9〜E15 を通る） | — | 無し | E9〜E15 の門 |
| E19 | 起動の役の確かめの失敗での停止（`kill-session`、#4115） | `base.ts:413–419`（`settleLaunchRole` の `kill`）→ 各ツールの `killSession` | 前 | 無し | 後始末の許可（§2.7） |
| E20 | Claude の起動の tmux のグローバル環境の変更（`set-environment -g -u CLAUDECODE`） | `claude-session.ts:1018`（`execAsync` のシェルの行。tmux の層の外） | 前 | 無し（codex P1-3） | `tmux.ts` に門のある関数を足して寄せる（§2.10）。全体への影響は下の注 |
| E21 | Claude の再利用の枝で健康でないペインを消す（`kill-session`） | `claude-session.ts:752–758`（`ensureHealthySession`）。呼び手 `:928`。route の `!running` の枝の `startSessionForSend`（`src/app/api/worktrees/[id]/send/route.ts:454`）から届く | 前 | 無し（opus P2-1） | **通常の変更として門を通す**（この要求が作ったものではないので、後始末の許可にしない） |
| E22 | tmux の別名の交代による打ち先の入れ替わり（legacy の別名の登録・解除） | `src/lib/cli-tools/session-name.ts:142–151`・`src/lib/tmux/legacy-session-alias.ts`。`killSession`・`hasSession` が別名を外す | — | 無し（codex P2-1） | 案 B2 でペイン ID に打つ（§2.5） |
| E23 | 本文の直前のロールの再確認と relay の境界の記録（端末は変えない） | `src/app/api/worktrees/[id]/send/send-role.ts:309–336`・`src/lib/relay/relay-bind.ts:229–273` | 本文の直前 | F4 の材料 | 変えない（§2.9） |

E20 の注: tmux サーバーのグローバル環境から `CLAUDECODE` を消す。これから作る全てのセッションに効き、動いているプロセスには効かない。消すのは「入っていてはいけない値」なので、他のセッションに害は無い。それでも端末の状態を変えるので、起動の変更として門を通す。札の確かめが通らなければ、起動行（E4）より前で止まる。

数え方: 変更の行は E1〜E22。Issue の F1＝E10、F2＝E8、F3＝E4、F5＝E16 で 4 行。E6 は F3 の延長。Issue に無い行は E1・E2・E3・E5・E7・E9・E11・E15・E17・E18・E19・E20・E21・E22 の 14 行。本文の後で門だけ要る行は E12〜E14 の 3 行。

### 1.2 Issue の行番号の直し（`192f9dca1` → `ad21704ea`）

| Issue の参照 | 今 | 差 |
|---|---|---|
| `submit-verified-sender.ts:753–762`・`:793–802` | `:755–762`（消去）・`:793–802`（入力の開始） | 同じ中身 |
| `copilot.ts:1120–1127` | `:1120`（再読み）・`:1124–1125`（`/model`） | 同じ |
| `launch-keys.ts:39–50` | `:39–52` | 同じ |
| `codex.ts:337–343・912–920` | 同じ | 同じ |
| `instance-input-lock.ts:849–865・944–964` | `:849–866`・`:944–965` | 同じ |
| `send-user-message.ts:530–545・673–685・795–807` | `:530–546`・`:673–685`・`:796–808` | 同じ |
| `opencode.ts:699–711` | 同じ（POST は `:779–785`） | 同じ |

`192f9dca1..ad21704ea` で、上のファイルのうち変わったのは `antigravity.ts`（#4503 PR-B2）だけ。送信器の順は変わっていない（`git diff --stat` で確かめた）。

### 1.3 送信の要求の外の書き手

| 書き手 | 位置 | 入口の宣言（§2.3） |
|---|---|---|
| ターミナルの route の人の打鍵 | `src/lib/tmux/polling-tmux-transport.ts:41`・`control-mode-tmux-transport.ts:45`・`src/lib/cli-tools/direct-input.ts` | 送信の外 |
| control mode（WebSocket の人の入力） | `src/lib/tmux/tmux-control-client.ts:129`（stdin へ `send-keys -t … -H`）・`:138`（`refresh-client -C`）。呼び手 `src/lib/ws-server.ts:1151`・`:1182`。`execFile` を通らない**第 2 の最下層**（opus P3-2） | 送信の外。G2 はテンプレート文字列の tmux のコマンドも探す |
| special-keys・clear-composer・kill-session の route | `src/app/api/worktrees/[id]/special-keys/route.ts`・`clear-composer/route.ts`・`kill-session/route.ts` | 送信の外 |
| respond・Auto-Yes・計画のレビューの答え | `src/lib/prompt-answer-sender.ts`・`src/lib/auto-yes-poller.ts`・`command-code-plan-review.ts:231–233` | 送信の外 |
| 中断の Escape・各ツールの終了のキー・停止 | `base.ts:629`・`opencode.ts:1310–1314`・各ツールの `killSession`・`src/lib/session-key-sender.ts:154–156`・`src/lib/session-cleanup.ts` | 送信の外 |
| `renameSession` | `tmux.ts:1056` | 送信の外（G1 の集合には入れる） |

`/terminal` のコマンド送信（`src/app/api/worktrees/[id]/terminal/route.ts:246` の `cliTool.sendMessage`）は人の打鍵ではなく送信の経路なので、§2.3 の入口に入れる（opus P2-2・codex P1-1）。

### 1.4 探し方（段 2 でも同じ手順で漏れを見る）

```sh
# tmux の変更（key の書き手・ペインの作成と形・環境・停止・名前）
git grep -nE "\b(sendKeys|sendSpecialKeys|sendSpecialKey|sendSpecialKeysAndInvalidate|sendDirectInputAndInvalidate|clearInputLine|clearComposerLine|clearComposerPasteToken|clearComposer|createSession|killSession|renameSession|reconcileSessionGeometry|typeLaunchLines|sendMessageWithSubmitVerification)\(" -- src
# tmux の層の外で組み立てる tmux のコマンド（配列・シェルの行・テンプレート文字列）
git grep -nE "(send-keys|paste-buffer|load-buffer|new-session|new-window|respawn-pane|resize-window|set-option|set-window-option|setw|set-environment|setenv|kill-session|rename-session|refresh-client)" -- src ':!src/lib/tmux/tmux.ts'
git grep -nE "execFile(Async)?\(\s*'tmux'|exec(Async)?\(\s*[\`'\"]tmux |stdin\.write\(\`" -- src
# HTTP の dispatch
git grep -nE "fetch\(|prompt_async|sendOpencodePrompt\(" -- src/lib/cli-tools src/lib/hooks/sources/opencode
# 送信の入口（札を作る所）と、送信の中で始めて外へ逃げるもの
git grep -nE "sendUserMessage\(|\.sendMessage(WithImage)?\(|sendModelCommand\(|startSession\(" -- src
git grep -nE "notifyTmuxSessionCreated\(|onTmuxSessionCreated\(|startPolling\(|scheduleNextPoll\(" -- src
```

---

## 2. 柵の形

### 2.1 案の比較

| 観点 | **案 1（採る）**: 最下層の門＋要求の札（ALS）＋送信の層の印 | 案 2: 柵のモジュールを tmux の上に置き、送信器が柵の関数だけを呼ぶ | 案 3: 型で札を必須にする（全ての書き手の引数に札） |
|---|---|---|---|
| 迂回 | 最下層は必ず通る。層の外のコマンドは G2 で見つける | 送信器が tmux を直に呼ぶと抜ける（台帳で見る） | 型で抜けない |
| 札の欠落 | 送信の層の印の下で札が無ければ門が投げる | 柵の関数で投げる | 型で起きない |
| I4（既存の試験） | tmux を mock する試験は門ごと mock されるのでそのまま。本物の門まで届く試験の一部は、札が要るようになる（§4.2） | 送信器の import 先が変わり、mock の付け方が変わる | 書き手の引数が変わり、大量の期待値が変わる |
| 範囲 | 中（§2.10） | 中〜大 | 大 |

案 1 を採る。案 3 は、送信以外の書き手の台帳の行が 0 になった後の別の Issue に残す（`tests/unit/guards/pane-key-writers.test.ts:47–48` の docblock の「後で型で狭める」）。

### 2.2 札と比べ方

| 欄 | 意味 |
|---|---|
| `requestId` | `randomUUID()`。ログ・応答に出す。相乗りの launch で自分の拒否かを見分ける（§2.6） |
| `target` | 確かめた宛先。`(worktreeId, instanceId, cliToolId)` で、解決の**結果**を入れる。`instanceId` は `instanceId ?? cliToolId` に揃える（#868。主インスタンスの普通の送信が `ticket-mismatch` にならないため。opus P3-6） |
| `resolvedBy` | 札を作ったときの `resolveSessionTarget` の段 |
| `sessionName` | `resolveSessionName(cliToolId, worktreeId, instanceId)`（`src/lib/cli-tools/session-name.ts:142`）。作ったときの名前 |
| `paneId` | 案 B2。最初の確かめの前に読む `#{pane_id}`。作るペインは作った直後に読む |
| `kind` | `resolved`（送信の route・relay の配送・`/terminal`）／`timer`（§2.3） |
| `conditions` | 読みだけの追加の条件。relay の予約（§2.9） |
| `state` | `open` → `refused`（範囲の中で粘着）／`closed`（範囲が終わった） |
| `refusal` | 断ったときの型つきの object（§3.2） |
| `changes`・`inputStarted`・`dispatchUnknown` | 通した変更の数、本文の入力・dispatch が始まったか、前の dispatch が `unknown` か |
| `created` | この要求が作ったセッション（後始末の許可の範囲。§2.7） |

確かめ（`confirm`）は同期で、`await` を置かない。**要求の options で解き直さない**。札の宛先が今も実在するかを、名簿の行そのもので見る（opus P2-6）。

| 札の `resolvedBy` | 一致の条件 | 不一致の `reason` |
|---|---|---|
| どれでも | worktree の行がある | `worktree-gone` |
| `roster` | `(worktreeId, instanceId)` の名簿の行があり、tool が札と同じ | 行が無い → `target-gone`。tool が違う → `tool-changed` |
| `primary`・`explicit`・`worktree-default`・`fallback` | その instance に、札と**違う tool** の名簿の行が足されていない | 違う tool の行がある → `tool-changed` |
| （共通） | 同じ `(worktree, instance, tool)` の行を消して作り直したものは一致（論理の宛先。#4466 レビュー 9 の Q-B）。打ち先のペインの同一性は案 B2 が別に保つ | — |
| （共通） | 確かめが例外を投げた | `unreadable`（`cause` に元の例外。fail-closed） |

画面で worktree の既定の tool（`worktrees.cli_tool_id`、`src/app/api/worktrees/[id]/route.ts:288`）を替えただけでは不一致にしない。`worktree-default` の札は、作ったときの結果（`instanceId`・tool）を持ち回り、その instance に別の tool の行が無い限り一致とする。#4466 の「S2 で決めた宛先を持ち回り、比べるだけ」と同じ形。

relay の配送の札は、`tryResolveRelayDeliveryTarget(db, relay.from)`（#4498 の strict）を同期で読み直す。`null`、または `(instanceId, cliToolId)` の違いで不一致にする（`target-gone`・`tool-changed`）。fallback の推測へ寄せない。

### 2.3 入口と権限（G3 が固定する一覧）

| 入口 | 扱い | 札・宣言 | 範囲 |
|---|---|---|---|
| `POST /api/worktrees/:id/send`（`route.ts` `handleSend`） | 保護する | `resolved`。`validateSendRequest` の `target`（`src/app/api/worktrees/[id]/send/send-request.ts:291–314`）から作る | `startSessionForSend`（`route.ts:454`）から `sendUserMessage`（`:508`）の戻りまで。`AsyncLocalStorage.run` で包む。`enterWith` は使わない（札が `POST` の残りの `binding.finish`・`evaluateRelayAfterSend`（`route.ts:113–147`）へ漏れるため。opus P3-7） |
| relay の配送（`src/lib/relay/relay-delivery.ts` `attemptDelivery`） | 保護する | `resolved`。claim の直前の strict の解決（`settled`）から作る | `sendUserMessage`（`:663`）の呼び出し |
| `POST /api/worktrees/:id/terminal` のコマンド送信（`terminal/route.ts:211–246`） | 保護する | `resolved`。同じ route が `resolveSessionTargetStrict` で解いた `target` から作る | `cliTool.sendMessage`（`:246`）の呼び出し。答えは §3.3 の 409 |
| timer（`src/lib/timer-manager.ts:132–146`） | 保護する（狭く） | `timer`。宛先は timer の行の `(worktreeId, instanceId, cliToolId)`。確かめは「worktree の行がある」「timer の行が今も `sending`」「その instance に別の tool の名簿の行が無い」。worktree の所有の確かめ（`checkWorktreeSessionOwnership`）は今どおり `sendUserMessage` の中 | `sendUserMessage`（`:141`）の呼び出し |
| Auto-Yes の poller の tick・respond・plan review の答え・special-keys・clear-composer・kill-session の route・人の直接のキー（transport・direct-input・control mode）・中断・停止 | 対象外 | `runOutsideSend(kind, fn)` で「送信の外」と宣言する（`kind`: `answer`・`operator`・`stop`）。宣言の中では、受け継いだ送信の札を見ない | 各入口の関数 |
| `sendUserMessage`（`send-user-message.ts:365`） | 入口ではない | 札を作らない。文脈の札の `target` と引数（`instanceId ?? cliToolId` に揃える）が違えば `ticket-mismatch` | — |

- `literal` の札は無い。札の欠落を埋める既定の札も無い（codex P1-1）
- 上の入口の一覧（`runWithSendTicket(` と `runOutsideSend(` の呼び出し元）を G3 で固定する。足すときは試験を付ける
- 相乗りの launch（`src/lib/session/session-launch-flight.ts:228–261`）: launch の本体は最初の呼び手の ALS で走る。相乗りした要求 B は A の結果を受ける。B が A の拒否（`requestId` が違う）を受けたら、自分の宛先の変化として答えない。B の答えは今の起動失敗の扱い（§3.2 の 4）にする。B 自身の最初の変更は B の門で確かめる。A が札の無い呼び手になることは無い（`startSession(` を呼ぶのは送信の入口の中だけ。§1.4 の grep で確かめた。`send-session-start.ts:98`・`:103`・`:105` と各ツールの `relaunchIfToolExited`）

### 2.4 門（`fenceGate`）と送信の層の印

`src/lib/session/terminal-fence.ts`（新）。`global-state`・logger・`node:async_hooks` だけを import する（`tmux.ts` から import するので、import の輪を作らない）。

**送信の層の印（fail-closed の軸。opus P2-5）**: 送信の経路でしか呼ばれない中間の層が、入るときに印を付ける。印は ALS の値で、門が読む。

| 印を付ける層（ファイル:関数） | 理由 |
|---|---|
| `submit-verified-sender.ts` `sendMessageWithSubmitVerification`（`:706`） | 全ツールの本文・消去・Enter が通る |
| `launch-keys.ts` `typeLaunchLines`（`:39`） | 全ツールの起動の打鍵が通る（起動は送信の入口の中でしか起きない。§2.3） |
| `base.ts` `createLaunchPane`（`:926`）・`claude-session.ts` `startClaudeSession`（`:897`） | ペインの作成 |
| `copilot.ts` `sendModelCommand`（`:1070`） | `/model` |
| `opencode.ts` `dispatchViaServer`（`:718`） | HTTP の dispatch |

門の判定:

```
fenceGate(op):                              // op = { sessionName | dispatch: {target, port, sessionId}, what }
  if 「送信の外」の宣言の中: return              // 対象外の入口（§2.3）
  t = 札（ALS）
  if t が無い:
    if 送信の層の印がある: throw FenceMisuseError('unticketed')   // fail-closed（I1）
    return                                    // 送信の経路ではない（tmux の関数の直接の試験など）
  if t.state === 'closed': throw FenceMisuseError('closed')       // 終わった送信の残りのコールバック（§2.6）
  if t.state === 'refused': throw t.refusal                       // 範囲の中の粘着（I2）
  if op の打ち先が t のもので無い: refuse(FenceMisuseError('ticket-mismatch'))
  v = t.confirm()  （例外は refuse('unreadable', cause)）
  if v が不一致: refuse(v)                      // 札に refusal を置いて throw
  lease = 案 B1 の貸し出しを取る（同じ同期の一歩）
  t.changes += 1
  return lease                                 // 呼び手は変更が終わったら finally で返す
```

- 置く所: 端末を変える spawn・fetch と同じ同期の一歩、その直前。`tmux.ts` の変更の関数は `execFileAsync` を呼ぶまで `await` を挟まない（事実: `sendKeys` `tmux.ts:663–692`、`clearComposerLine` `:1220–1226`、`killSession` `:1003–1006`）。`try` の外に置き、`TmuxSendError` に包ませない
- 複数の変更の関数: `sendSpecialKeys` はキーごと（`tmux.ts:893–906` の繰り返しの中、`execFileAsync` の直前）。`catch` は `isSendFenceRefusal` を `TmuxSendError` にせず投げ直す
- `createSession` は 1 つの変更（§2.7）
- 境界との順: `noteInputStart`・`noteDispatchStart` は、境界の hook（`runBoundaryHook`）より前に `fenceConfirm()`（数えない確かめ）を呼ぶ。宛先の変わった要求が、relay の入力の境界を DB に書かないため
- 飲み込む catch: 失敗を飲み込んで別経路へ進む catch（`opencode.ts:811–823`。`:814` は境界の拒否だけを投げ直す）は、`isSendFenceRefusal` も投げ直す。投げ直しを忘れても、範囲の中では粘着なので次の変更で断られる
- 既存の lock との関係: `isCurrent()`／`assertInputOwner` は「この書き手が今の持ち主か」、門は「この要求の宛先が今も同じか」。別の問いなので両方残す

### 2.5 I2 が保証する時点（狭めない）

#### 2.5.1 2 つの時点

| 時点 | 意味 | 門だけで閉じるか |
|---|---|---|
| 発行の時点 | 門の確かめから、`execFile` の spawn・`fetch` の呼び出しまで | 閉じる。同じプロセスの JS はこの同期の一歩に割り込めない（事実: `tmux.ts:23` の `promisify(execFile)`、`submit-verified-sender.ts:201–212` の Promise の executor、`client.ts:124–126`）。better-sqlite3 の読みは同期（`resolve-session-target.ts:249–258`、`relay-session-ref.ts:111`） |
| 実変更の時点 | tmux サーバーがペインを変えるまで（tmux のクライアントの起動の後）、HTTP の相手が要求を受けるまで | **閉じない**。間に、(1) 同じプロセスの別の要求が名簿を書く（spawn の後は JS が回る）、(2) 別の DB の接続（WAL。`src/lib/db/db-instance.ts:144–156` は複数のプロセスが同じ DB を開く場合を想定している）が書く、(3) 同じ名前のペインの置き換え・別名の交代（E22）が入る。codex が今の `sendKeys` と偽 tmux で、(2) の窓の変更 1 件を再現した |

Issue の I2（最初の変更より前の不一致なら変更 0）は、実変更の時点で読む。これは PM の判断（`pm-reply-4534-design-wait.md` の 2）。よって門に加えて、下の B1・B2 で実変更の時点まで閉じる。

#### 2.5.2 案 B1: 名簿の書き手との排他（宛先ごとの貸し出し）

- 門は、確かめと同じ同期の一歩で、宛先 `(worktreeId, instanceId)` の**貸し出し**を取る。変更の約束（`execFileAsync` の Promise、`fetch` の応答）が決着したら返す。tmux のコマンドはサーバーが処理を終えてからクライアントが終わるので、決着の時点でペインの変更は済んでいる。HTTP は応答を受けた時点で受理済み
- 名簿の書き手は、自分の `IMMEDIATE` トランザクションの中で、生きている貸し出しが無いことを確かめてから書く。あれば書かずに待つ（20 ms ごと、上限 5 秒）。上限を越えたら 409 `roster_changed`（既存の code、§3.3 の C7）
- 対象の書き手（事実）: `src/lib/db/agent-instances-db.ts` の `setAgentInstances`（`:255`）・`addAgentInstance`（`:371`）・`removeAgentInstance`（`:414`）、`src/lib/db/worktree-db.ts` の worktree の削除（`:968`・`:1002`）。`updateCliToolId`（`:592`）は §2.2 の比べ方で宛先を変えないので対象にしない
- 貸し出しの置き場:

| 置き場 | 閉じる窓 | 費用 |
|---|---|---|
| B1-mem: プロセスの中の表（`globalThis`） | (1) だけ | 安い。migration 無し |
| **B1-db（採る）**: DB の表 `send_target_leases(worktree_id, instance_id, request_id, pid, expires_at)` | (1)(2) | 確かめと貸し出しの INSERT を 1 つの `IMMEDIATE` トランザクションにする（読みと貸し出しが同じ時点になる）。返すときに DELETE。期限（既定 30 秒。HTTP の要求の timeout 以上にし、期限で `fetch` を abort する）で、落ちたプロセスの貸し出しを無効にする |

- 変更 1 回ごとに DB の書き込みが 2 回増える（1 送信で 10〜20 回）。better-sqlite3 の同期の書き込みで数十 µs。見立て（段 2 で測る）

#### 2.5.3 案 B2: 実行先の識別情報で打つ（ペイン ID）

- 札の最初の確かめの前に、打ち先の `#{pane_id}` を 1 回読む（`display-message -p -t =name: '#{pane_id}'`、読み）。この要求が作るペインは作った直後に読む
- 札の下の変更は `-t %<pane_id>` に打つ。同じ名前で置き換わったペイン・別名の交代では、tmux サーバー自身がコマンドを断る（`can't find pane`）。tmux の中で、実変更の時点で閉じる
- 札の無い変更（送信の外）は今どおり名前で打つ（I4）
- 門の拒否と区別するため、tmux のこの失敗は `pane-replaced` として `SendTargetChangedError` にする（`reason` の値は人の答えの後に確定）

#### 2.5.4 費用と、残る窓

| 案 | 閉じるもの | 触るファイル（src） | 足す試験 |
|---|---|---|---|
| 門だけ | 発行の時点 | `terminal-fence.ts`（新）・`tmux.ts`・`submit-verified-sender.ts`・`client.ts`・`opencode.ts`・`opencode-v2.ts`・`claude-session.ts`・`instance-input-lock.ts`・`send-user-message.ts`・route 2 つ・`relay-delivery.ts`・`timer-manager.ts` | §6 の T1〜T12 |
| ＋B1-db | 名簿の並行の書き手（同じプロセス・別のプロセス） | 上に加えて、migration 1 つ（`src/lib/db/migrations/` に 1 本）・`src/lib/db/send-lease-db.ts`（新）・`agent-instances-db.ts`・`worktree-db.ts`・名簿を書く route（`src/app/api/worktrees/[id]/instances/**`・worktree の削除）の 409 の答え | T13（同じプロセスの書き手が変更の決着まで待つ）・T14（2 つの DB の接続で、spawn の後・変更の前に書く。codex の再現の形）・T15（期限切れの貸し出しを無視する）・T16（待ちの上限で 409 `roster_changed`）。migration の試験 1 本 |
| ＋B2 | ペインの置き換え・別名の交代 | `tmux.ts`（札の下の打ち先を `%pane_id` に）・`submit-verified-sender.ts`（`paste-buffer` の `-t`）・`terminal-fence.ts` | T17（同じ三つ組を消して作り直した後のペインには打たない）・T18（別名の交代の後は打たない）・T19（札の無い変更は名前で打つ。対照） |

B1-db と B2 の両方を入れたうえで残る窓は次の 2 つ。

- CommandMate を経ずに DB を直に書く書き手（`sqlite3` の手での編集など）。貸し出しの表を読まない
- tmux の外でペインの中身が変わること（agent 自身の動き）。これは宛先の変化ではない

1 つ目を I2 の外と読むかは、受入条件の読みになる。PM・人が決める（§9 P-1）。B1-db・B2 のどちらかを入れない場合に残る窓も、同じ所に並べる。

### 2.6 範囲と受け継ぎ

| もの | 扱い |
|---|---|
| 範囲の中の粘着 | 断った札は、範囲の中では以降の全ての変更を断る |
| 範囲の後（`closed`）に、札を受け継いだコールバックが変更を試みる | **断る**（`FenceMisuseError('closed')`、試行は記録しない）。終わった送信の残りのコールバックが打つことを止める（codex P1-1） |
| 送信の中で始まり、送信の外で働くもの | **始める所で札から切り離す**（`AsyncLocalStorage` の `exit`／`AsyncResource.bind`）。一覧: `tmux.ts:617` の `notifyTmuxSessionCreated` が呼ぶ listener（Auto-Yes の poller の `armSessionWaitWake` → `scheduleNextPoll`、`src/lib/auto-yes-poller.ts:1350–1359`）・`send-user-message.ts:910` の `startPolling`。G3 がこの一覧を固定する |
| 切り離しの一覧に漏れがあったら | Auto-Yes の tick は入口で「送信の外」と宣言する（§2.3）ので、受け継いだ札は見ない（二重の守り）。宣言も切り離しも無いものは `closed` で断られ、試験で赤になる（T12b） |
| 範囲の中で、送信の外の書き手が受け継いだ札で打つ | 宣言があれば札を見ない。札の `changes` も数えない（`changesBefore` を正しく保つ。opus P1-1） |

### 2.7 後始末・kill と作りかけのもの

「宛先の変わった要求は、**新しい入力を**何も入れない」と読む。この要求が作ったものの片付けは止めない（opus P2-3・U7）。

| もの | 許可 | 理由 |
|---|---|---|
| `createSession` の中の `set-option`・`new-window`・`respawn-pane`・`set-window-option`・`resize-window` | `new-session` の門が通ったら、同じ関数の中は 1 つの変更として通す | 途中で断ると、窓 0 に `sleep 2147483647` の placeholder だけのセッションが残る（`tmux.ts:425`・`:534–536`）。次の送信は `hasSession` が true で再利用の枝（`base.ts:885–903`）へ進み、起動行を `sleep` の標準入力へ打つ。手で kill するまで起動できない |
| この要求が作ったセッションの kill（E19 の #4115 の役の違う agent の停止を含む） | 後始末の許可。断った札でも通す。打ち先は札の `created` にあるものだけ | 役の違う agent を生き残らせない（#4115 の不変条件） |
| `withdrawUnsentBody`（E15）・`delete-buffer` | 後始末の許可。断った札でも通す | この要求が入れた本文・buffer を取り戻すだけ |
| 置き換えの消去（`submit-verified-sender.ts:894`） | 後始末の許可 | 同上（入力欄にあるのは、この要求が入れた本文の置き換え） |
| E21（健康でないペインの kill） | 通常の変更（門で確かめる） | この要求が作ったものではない |
| `createSession` の `catch`（`tmux.ts:608–611`） | `cause` を付けて包む。門の拒否は包まずに投げ直す | 型と `cause` を保つ（§3.2） |

作りかけのものの片付け: `createSession` の中では断らないので、placeholder は残らない。`createSession` の後・起動行の前に断ったときは、シェルのある空のセッションが残る。次の送信の再利用の枝が、tool の生きていないペインとして起動し直す（`base.ts:885–903`。シェルがあるので起動行は通る）。

### 2.8 OpenCode の門の照合先（codex P2-2）

- `sendOpencodePrompt`（`client.ts:584`）は `port` と `sessionId` しか受けない。札の `sessionName` を渡すと自己比較になる
- 段 2 は `sendOpencodePrompt` に `dispatch: { target, port, sessionId }` を渡す。門は札の確かめに加えて、同じ同期の一歩で次を読み直す。どれも同期の読み（事実: `src/lib/hooks/sources/opencode/ports.ts:170`・`subscription.ts:267`・`:335`）
  - `getAssignedOpencodePort(target) === port`
  - `getOpencodeLiveness(target).state === 'live'`
  - `getOpencodePrimarySession(target) === sessionId`
  - `target` が札の `target` と同じ
- 違えば不一致（`reason` は `dispatch-changed`。値は人の答えの後に確定）
- 添付の後の 2 回目の POST（E17）は別の発行として、同じ門を通す
- 前の dispatch が `unknown` のまま 2 回目で断られたときは、札の `dispatchUnknown` が残る。試行は `indeterminate`（§3.2）

### 2.9 relay の両端・予約・claim（codex P2-5）

| もの | 扱い |
|---|---|
| 配送の門の照合 | 札の宛先は、配送が打つ側（`relay.from` を strict に解いた requester）だけ。規則 0 が見る `to` の側は照合しない。「門で規則 0 の両端まで保つ」とは言わない |
| 規則 0 の判定 | 今のまま残す。route の `findBoundRelayToolPolicyRefusal`（`route.ts:333–343`）・`send-relay.ts:147–170`、配送の `closeRelayRefusedByToolPolicy`（`relay-delivery.ts:613–677`）。判定の後に逆の端だけが変わる窓は、今と同じに残る（#4535・#4538 の範囲） |
| 送信の route の予約の再確かめ（U6） | 札の条件に入れる。同じ `relayId` で、**同じ `attemptId`** の予約が `awaiting` のまま生きているかを読むだけ（`relay-bind.ts:229–268`・`:302–319`） |
| 配送の claim の再確かめ | 札の条件に入れる。今の payload が、この配送の `attemptId` の claim を持っているかを読むだけ（`relay-delivery.ts:629–658`・`:693–699`） |
| 副作用 | 条件の確かめは読むだけ。取り下げ（withdraw）・保留・requeue は今の処理のまま（`settleUnsentResult` `relay-delivery.ts:940–966`、route の `binding.finish`）。条件の不一致は `RelayReservationLostError` として札に置き、宛先の変化にしない（§3.2） |
| claude-3 の予約 | 置き換えない。CLI の側のファイルの世代の予約（`src/lib/agent-health/claude3-reservation.ts`）は送る前に取るもので、門は新しい入口を作らない |
| #4498 の strict | 配送の札の確かめに同じ関数を使う。`null` は不一致（fail-closed） |
| #4466 の send-operation | 札の `target` が S2 の値。門は比べるだけで、解決し直した値へ寄せない。h-S3（起動の後・打鍵の前）はこの門で実現する |

### 2.10 門を置かないもの・端末の外の副作用

| もの | 扱い |
|---|---|
| `load-buffer`（`submit-verified-sender.ts:250`） | ペインに何も入らないので門を置かない。断ったときに残った buffer は `paste-buffer` の門の catch で消す（E13） |
| `capture-pane`・`has-session`・`display-message` などの読み | 端末を変えない |
| 起動で書くファイル（`src/lib/cli-tools/opencode-config.ts:616` の `opencode.json`、claude の hooks の設定、役の注入） | 端末の変更ではないので門の外。断った送信が作業ツリーにファイルを残しうる。どれも次の起動が同じ内容で書き直すもので、宛先の変化で害になる値は無い（見立て。opus P3-3） |
| `chooseNewOpencodeConversation`（`route.ts:452`） | 端末を変えない（#4466 レビュー 6 の範囲） |

---

## 3. I3（理由を保つ）

### 3.1 今の失い方（事実）

| 箇所 | 今 |
|---|---|
| `runBoundaryHook`（`src/lib/session/instance-input-lock.ts:958–965`） | `beforeInput` の例外を `new InputBoundaryRefusedError(error)` に包む。コンストラクタ（`:852–858`）は元の message を写すだけで `cause` を渡さない。codex が `TypeError` で `cause` が空になることを再現した |
| `isInputBoundaryRefusal`（`:862–866`） | message の正規表現で見分ける |
| `sendUserMessage` の `deliver`（`send-user-message.ts:673–685`） | ロールの拒否の次に、境界の拒否を全部 `relay-reservation-lost` にする |
| `sendUserMessage` の `/model`（`:535–546`） | 再確認の code だけを見て、他は `model-switch-failed` |
| 起動の失敗（`src/app/api/worktrees/[id]/send/send-session-start.ts:93–167`） | `sendUserMessage` より前に route が分類する。知らない例外は 500 `SESSION_START_FAILED`。その手前で `BaseCLITool.startSessionOnce` の `catch`（`base.ts:366–371`）が `reportSessionStartFailure`（電話への起動失敗の通知）を呼ぶ |
| route の失敗の答え（`send-failure.ts:65–124`） | `relay-reservation-lost` は 500＋文で、`code` が無い。`sendOutcome` は記録された試行から付く（`route.ts:125–142`） |
| ツールの包み直し | `codex.ts:1053`・`opencode.ts:956`・`antigravity.ts:788` は `{ cause }` を付ける。copilot の `/model` は `code` だけを写す（`copilot.ts:1084`）。`createSession` は `cause` 無し（`tmux.ts:608–611`）。`pasteBody` の `paste-buffer` の失敗も `cause` 無し（`submit-verified-sender.ts:281–285`） |

### 3.2 直し方（分類の順と入口）

型（どれも `requestId` を持つ）:

| 型 | 意味 | 試行の state／reason | route の答え |
|---|---|---|---|
| `SendTargetChangedError` | 宛先の変化（§2.2・§2.5・§2.8 の不一致） | `inputStarted` が false で `dispatchUnknown` も false なら `not-sent`、それ以外は `indeterminate`。reason `target-changed` | 409（§3.3） |
| `RelayReservationLostError` | 予約・claim の喪失（§2.9）。今の `RelaySendBinding.beforeInput`（`relay-bind.ts:265–268`、`:267` の型の無い `Error`）もこの型にする | `not-sent`／`relay-reservation-lost` | 今のまま（500、`code` 無し、`sendOutcome`） |
| `FenceMisuseError` | 呼び出しの誤り（`unticketed`・`closed`・`ticket-mismatch`） | `not-sent`／`fence-misuse` | 500（今の失敗の答え） |

分類の順（全ての入口で同じ。codex P1-4）:

1. 文脈の札の `refusal` で、`requestId` が自分のもの → その型で分類する
2. 例外の `cause` の鎖をたどり、上の 3 つの型があれば、`requestId` が自分のものに限ってその型で分類する
3. 1・2 で見つからない境界の拒否（`isInputBoundaryRefusal`）→ 今どおり `relay-reservation-lost`（`tests/unit/lib/session/send-user-message-input-boundary-3957.test.ts:255–267` が `new Error('reservation gone')` で固定している。変えない）
4. それ以外 → 今の分類（`classifySendFailure`、起動の失敗は `answerSessionStartFailure`）。`requestId` が自分のものでない拒否（相乗りの launch で A が断られた B）はここに入る

| 入口 | 分類する所（段 2） | 足すこと |
|---|---|---|
| 起動（route の `startSessionForSend`） | `send-session-start.ts` の `answerSessionStartFailure` の最初 | 1・2 に当たれば、409 と `recordNotSent('target-changed')` を返す（`sendOutcome` が付く）。`base.ts:366–371` の `reportSessionStartFailure` は、門の拒否（自分の `requestId`）なら呼ばない（通知 0） |
| `/model`（`send-user-message.ts:535–546`） | catch の最初 | 1・2 を `INPUT_RECHECK_*` の code より先に見る。`{ ok: false, stage: 'target_changed', code: 'SEND_TARGET_CHANGED', refusal }` |
| 本文・dispatch（`deliver` `:673–685`） | catch の最初 | 同上。ロールの拒否（`isRoleConditionUnmet`）より前 |
| relay の配送 | `relay-delivery.ts` の `settleUnsentResult`（`:940–966`） | `not-sent` は今の「断られた」と同じ（payload を戻す。取り下げない）。`indeterminate` は今の `holdUncertain` |
| `/terminal` | `terminal/route.ts:246` の catch | 1・2 に当たれば 409（§3.3）。それ以外は今のまま |
| timer | `timer-manager.ts:148–152` | `[target_changed] <文>` を理由に残す |

その他:

- `InputBoundaryRefusedError` は `super(message, { cause })` にする。コンストラクタの引数（`cause` 1 つ）と message は変えない（`tests/unit/app/api/worktrees/send-role-4115.test.ts:311`・`tests/unit/cli-tools/submit-verified-sender-split-4056.test.ts:197` がこの形を使う）
- `noteInputStart`・`noteDispatchStart` は境界の hook より前に `fenceConfirm()` を呼ぶ（§2.4）。宛先の変わった要求は、relay の境界を DB に書かない。境界の通知の後で最終の門が断った場合は、境界は書かれたまま試行が `not-sent` になり、`binding.finish` が `failed` にする（今の予約の喪失と同じ形）
- 前の HTTP dispatch が `unknown`（`relay-bind.ts:308–343` の `dispatch === 'unknown'`）のまま今回の門が POST の前に断った場合 → `indeterminate`。relay の `finish` には `unknown` を渡す。最初の POST の前に断っただけの場合 → `not-sent`
- 409 には必ず `sendOutcome` を付ける。route はどの入口の拒否でも、`recordNotSent` か `onAttempt` で試行を記録する。記録が漏れると、束ねた relay の CLI は 4xx を `not_sent` と読む（`src/cli/commands/message-dispatch.ts:127–136`）

### 3.3 公開の契約（**人の答え待ち**。開発リーダーが PM へ上げ、PM が人へ渡した）

2 つの案:

| 観点 | 案 (a): 既存の 409 `roster_changed` に寄せる | **案 (b)（推奨）**: 新しい 409 `SEND_TARGET_CHANGED` |
|---|---|---|
| 既存 | `send-role.ts:139–157`（文: `The roster changed while this send was waiting; nothing was saved or typed. Send it again.`、試行の reason `role-condition-failed`）。CLI は exit 31 `RoleExitCode.CONFLICT`（`src/cli/utils/role-failure.ts:48`、`api-client-errors.ts:164–169`） | 無し |
| 意味 | 「何も保存も入力もしていない」で固定されている（PM の返事の 1） | 送信の途中で宛先が変わった。起動・消去などが済んだ後もある。本文が入っていれば `indeterminate` |
| `unreadable` | 確かめが読めなかったことを「名簿が変わった」と言ってしまう | `reason` で区別できる（確定した変化ではない） |
| 回復 | 送り直す | `sendOutcome` が `not_sent` なら名簿を読み直して送り直す。`unknown` なら先に pane を見る |
| CLI の exit | 31（`not_sent` と `unknown` が同じ値） | 34（`src/cli` のどの値とも重ならない。codex・opus が確かめた）。`not_sent`／`unknown` の区別は exit 34 だけでは付かず、`sendOutcome` が要る（strict の `respond` は 40／41 で分けている） |
| 試行の reason | `role-condition-failed`（ロールの理由と混ざる） | `target-changed` |

推奨は (b)。(a) の文は「何も入力していない」と約束していて、起動の後・本文の後の拒否と合わない。**exit 34 と `reason` の値は人の答えの後に確定する。** 段 2 の契約（試験を先に）も人の答えの後に作る。

案 (b) の中身（確定は人の答えの後）:

| # | 追加 | 中身 |
|---|---|---|
| C1 | `POST /api/worktrees/:id/send` と `POST /api/worktrees/:id/terminal` のコマンド送信の 409 | `{ "error": "<文>", "code": "SEND_TARGET_CHANGED", "reason": <§2.2・§2.5・§2.8 の値>, "target": { "worktreeId", "instanceId", "cliToolId" }, "current": { "cliToolId", "resolvedBy" } \| null, "requestId", "sendOutcome": "not_sent" \| "unknown" }`。`sendOutcome` は必須。束ねた relay があれば `relayId` が付く。ask の予約は今の `settleRouteAsk` のまま |
| C2 | `prompt --json` の `lastSend.reason` | `target-changed`・`fence-misuse`（優先順位は §3.4） |
| C3 | CLI の `send`・`ask` の exit | 34（`SendTargetExitCode.CHANGED`、`src/cli/types/index.ts`）。`api-client-errors.ts:151–174` の 409 の分岐に足す |
| C4 | CLI の出力 | §3.4 の約束 |
| C5 | 変えないもの | 予約の喪失の答え（500、`code` 無し、`sendOutcome: 'not_sent'`）。`PROMPT_WAITING`・`FOREIGN_SESSION`・`ROLE_*`・`TOOL_POLICY_DENIED`・`roster_changed` の 409。`SEND_TARGET_CHANGED` の有無で予約の喪失と区別できる（受入条件の F4） |
| C6 | 文書 | `docs/user-guide/cli-operations-guide.md`（ja）と英語版の終了コードの表 |
| C7 | 案 B1 の名簿の書き手 | 貸し出しの待ちが上限を越えたら、既存の 409 `roster_changed`（exit 31）を返す。名簿の route（`instances add/remove/alias`、worktree の削除）に、短い待ちとこの答えが増える |

案 (a) を選ぶなら、C1 の code が `roster_changed`、C3 の exit が 31 になる。`send-role.ts` の文は案 (a) の意味に合わせて直す必要がある（「入力していない」と言えない場合がある）。

### 3.4 CLI の出力の約束（限定）と reason の優先順位

- 「stdout は空」とは約束しない。今の CLI は POST の前に契約の task の ID を stdout に出す（`src/cli/commands/send.ts:340–348`）。`postMessage` も、外側のエラーの分類より前に再送・relay・ロールの注意を stderr に出す（`message-dispatch.ts:195–225`、`src/cli/commands/send-action-support.ts:296–306`、`src/cli/commands/ask.ts:647–655`・`:769–778`）
- 約束するのは次の 3 つ
  - stdout には、今の事前の出力（task の ID）より後に何も足さない
  - stderr に `Error: <サーバーの文>` の行を 1 つ出す（今の注意の行の後）
  - 再送の可否は今の `describeFailedSendOutcome`（`message-dispatch.ts:158–172`）の文で出す
- `send` と `ask` は同じ `postMessage` を通るので、同じ順になる
- `lastSend.reason` には、1 つの試行に reason を 1 つだけ記録する。複数の理由が重なったときは、§3.2 の分類の順で決める
  - 宛先の変化（`target-changed`）
  - 予約の喪失（`relay-reservation-lost`）
  - 呼び出しの誤り（`fence-misuse`）
  - 今の reason
- 既に記録された他の試行の reason は上書きしない（今の `recordSendAttempt` の世代の規則のまま）

---

## 4. I4（振る舞いを変えない）

### 4.1 変えずに緑で守る既存の試験

宛先が変わらない送信では、門は確かめて数え、貸し出しを取って返すだけ。tmux の呼び出しの並び・回数・引数を変えない。案 B2 の `%pane_id` は札の下でだけ使い、tmux を mock する試験には見えない。

| 守るもの | 試験（ファイル: describe） |
|---|---|
| 本文と Enter を分ける・読み戻し | `tests/unit/cli-tools/submit-verified-sender.test.ts`: `submit-verified-sender`（`body/Enter separation (Issue #1469/#1470 regression guard)` ほか） |
| 送信の前の消去と再確認・lock の中の順 | `tests/unit/cli-tools/submit-verified-sender-input-lock-3945.test.ts`、`submit-verified-sender-ticket-4065.test.ts`、`submit-verified-sender-lock-split-4057.test.ts`、`submit-verified-sender-split-4056.test.ts` |
| 長い本文の貼り付け | `submit-verified-sender-long-body-2464.test.ts`、`submit-verified-sender-late-paste-3937.test.ts` |
| Enter の数・codex の burst・最初の prompt | `submit-verified-sender-final-enter-3880.test.ts`、`submit-verified-sender-codex-burst-3366.test.ts`、`submit-verified-sender-first-prompt-4035.test.ts`・`-4048.test.ts` |
| copilot の `/model` と選択の一覧 | `tests/unit/cli-tools/copilot-input-lock-3945.test.ts`: `copilot keys outside the shared sender take the input lock (Issue #3945)`、`copilot-input-lock-3952.test.ts`、`tests/unit/lib/session/send-user-message-model-recheck-3952.test.ts` |
| 起動の打鍵 | `tests/unit/cli-tools/launch-lines-input-lock-3981.test.ts`: `[#3981] launch keys wait for a send holding the composer, per tool`・`[#4050] \`typeLaunchLines\`, the ledger site every launch types through`、`codex-launch-dialog-ticket-3981.test.ts`、`session-relaunch-2070.test.ts` |
| OpenCode の HTTP とキーボードへの切り替え | `tests/unit/cli-tools/opencode-send-api-2035.test.ts`: `Issue #2035: sending over the opencode server`（`the request`・`the read-back`・`the fallback`）、`opencode-send-selection-2048.test.ts` |
| agy の本文の前の役の確かめ | `tests/unit/cli-tools/antigravity-role-gate-4385.test.ts` |
| 境界の hook・試行の記録 | `tests/unit/lib/session/send-user-message-input-boundary-3957.test.ts`（`:255–267` を含む）、`send-user-message-order-4065.test.ts`、`send-user-message.test.ts`、`tests/unit/app/api/worktrees/send-relay-bind-3957.test.ts`、`send-role-4115.test.ts`、`tests/unit/lib/relay/relay-bound-delivery-3957.test.ts` |
| route の送信 | `tests/integration/api-send-cli-tool.test.ts`、`api-send-instance-cli-tool.test.ts`、`api-send-instance-tool-conflict-2491.test.ts`、`api-send-prompt-waiting-1708.test.ts` |
| relay の strict（#4498） | `tests/unit/relay/relay-session-ref-4498.test.ts`、`tests/integration/cli-relay-adhoc-tool-4496.test.ts` |
| tmux の関数そのもの（札の無い文脈・送信の層の印も無い） | `tests/unit/tmux/*.test.ts`、`tests/unit/tmux.test.ts` |
| 書き手の台帳・tmux の import・import の輪 | `tests/unit/guards/pane-key-writers.test.ts`、`tmux-import-allowlist.test.ts`、`import-cycles-baseline-3482.test.ts` |

### 4.2 fail-closed（A）と I4 の重なり（PM の判断 P-2）

- 送信の層の印の下で札が無いと、門が投げる（§2.4）。既存の試験のうち、次の 3 つを全て満たすものは赤になりうる
  - 札を作る入口を通らずに、送信の層（§2.4 の表）を直に呼ぶ
  - tmux も送信器も mock せずに、本物の門まで届く（`child_process` だけを偽にする試験）
  - `fetch` だけを偽にする OpenCode の試験
- 候補（見立て。段 2 の最初に、印と門を入れた枝で該当の試験を流して数を測る）: `tests/unit/cli-tools/submit-verified-sender.test.ts`（`child_process` を偽にする）・`launch-lines-input-lock-3981.test.ts`・`session-relaunch-2070.test.ts`・`opencode-v2.test.ts`・`send-readiness-4040.test.ts`・`submit-verified-sender-first-prompt-4048.test.ts`・`submit-verified-sender-final-enter-3880.test.ts`・`copilot-agent-hooks.test.ts`・`opencode-send-api-2035.test.ts`
- 赤が出たら、どれか 1 つを PM が選ぶ
  - (i) その試験に、明示の札を作る試験用の入口（`withTestSendTicket`）を足す。試験の期待値は変えず、前置きの 1 行を足すだけ。ただし「既存の試験を変えずに緑」とは違う
  - (ii) 送信の層の印を付ける所を、赤の出ない所まで狭める。fail-closed の範囲が狭まる
- 勧めは (i)。試験用の札は test のヘルパーにだけ置く。production の入口の一覧（G3）には入れない。vitest の setup で全体に札を配る形は採らない（fail-closed が試験で見えなくなる）
- 「迂回」でも「ゲートのための前提の変更」でもないが、I4 の字句に触れるので PM が決める

---

## 5. 札の無い経路を足すと赤になる検査（codex P2-3）

どの検査も 3 段で書く。

1. 肯定の対照: 通る札の下で、fixture が対象の変更まで届くこと（偽の tmux に、その変更の呼び出しが記録される）
2. 同じ fixture を断る札の下で走らせる → その変更が 0 件
3. 同じ fixture を札の無い文脈（送信の層の印あり）で走らせる → 0 件で `FenceMisuseError('unticketed')`

| # | 種類 | 形 |
|---|---|---|
| G1 | 実行時（網羅） | `tmux.ts` の変更の関数を**全部**呼ぶ。一覧はモジュールから読む（`pane-key-writers-scan.ts` の `tmuxKeyWriterExports` と同じ読み方に、`createSession`・`killSession`・`renameSession`・`reconcileSessionGeometry`・E3・E20 で足す関数を加えた集合）。上の 3 段を関数ごとに行う。門を付け忘れた新しい関数は 2 で赤。`sendSpecialKeys` は 2 つ目のキーの前で断る形も試す（後続の変更だけが未検査のものを捕まえる） |
| G2 | 静的（呼び出しごと） | §1.4 の 2 つ目・3 つ目の grep と同じ探し方を、tmux の層の外の**変更する呼び出しごと**に行う（配列・シェルの行・テンプレート文字列。`set-environment`・`set-window-option`・`refresh-client` を含む）。各行は台帳の行（ファイル・関数・コマンド・決め）を持つ。決めは「門あり」か「送信の外」（理由つき）。「門あり」は、その呼び出しの直前（同じ関数の中で、間に `await` を挟まない）に `fenceGate(` があること。OpenCode の `prompt_async` の POST も行を持つ |
| G3 | 静的（入口と切り離し） | `runWithSendTicket(`・`runOutsideSend(` の呼び出し元の一覧（§2.3）と、札から切り離す所の一覧（§2.6）を固定する。送信の層（§2.4 の表）を production から呼ぶ所は、入口の中か、入口の範囲の中から呼ばれる関数であること（`pane-key-writers` の caller の台帳と同じ作り） |
| G4 | 静的（試験の作り） | §6 の柵の試験のファイルは、`terminal-fence`・`tmux`・`instance-input-lock`・`submit-verified-sender`・`composer-clear`・`send-user-message`・各ツールのモジュール・`client.ts` を `vi.mock` しない |
| G5 | 検査そのものの陽性の対照 | G1〜G3 は、`os.tmpdir()` 配下に `fs.mkdtempSync` で作った写しを走査して赤になること（門を外した関数、門の無い `execFile('tmux', ['send-keys', …])`、`await` の後に門がある呼び出し、入口の外からの送信の層の呼び出し）。`afterEach` で消す |

---

## 6. 試験の一覧（段 2 で先に書く赤）

### 6.1 足場（opus P3-9・codex P2-3）

- 柵を含むモジュールは本物。偽にするのは `child_process`（`tests/unit/guards/fake-tmux-child-process.ts`）、`fetch`（OpenCode の偽のサーバー）、記録した画面だけ
- 今の偽の tmux（305 行）が模すのは、セッションの有無と `#{session_path}`・`capture-pane` の中身だけ。段 2 で次を足す（既存の振る舞いは変えない）
  - 呼び出しごとに試験の関数を走らせる口（窓を入れる所）
  - capture の列（読み戻し・消去の確かめ・Enter の確かめ・launch の readiness を通す画面）
  - `#{pane_id}`（案 B2）
  - `which claude`・`test -x` などの tmux 以外のコマンドの答え
- 今の偽の `child_process` は tmux 以外を `ENOENT` で断る（`fake-tmux-child-process.ts:189`・`:263–303`）。起動まで届かない fixture でも「変更 0」が緑になってしまうので、**各試験は同じ fixture の肯定の対照（窓を入れない）で、対象の変更が記録されることを先に確かめる**
- T3 の Claude の起動には、`which claude` のスタブと、準備のできた画面（`claude-session.ts:641–654`・`:956–958`）が要る
- 窓の位置: 「確認の後・最初の変更の前」は、route の解決（札の作成）の後の最初の読み。T3 の窓は、起動の中の `has-session` を使う。route の `isRunning` の `has-session`（札の範囲の前）と区別する
- 足場が G4（ツールのモジュールを mock しない）を守ったまま組めないと分かったら、試験を書く前に PM へ上げる（受入条件の「柵を含むモジュールを mock しない」の範囲になる）
- 「発行済み・変更前」の対照（codex P1-2）: 偽の tmux を「spawn された、まだ変更していない」で止めて名簿を変え、それから進める。案 B1・B2 が入る前は、変更が 1 件記録される（直す前の赤・門だけの赤）。B1・B2 が入った後は 0 件か、名簿の書き手が待たされる

### 6.2 一覧

| # | 受入条件 | 試験の名前（案）・ファイル | 形 | 直す前に赤になる理由 |
|---|---|---|---|---|
| T1 | F1 | `tests/integration/send-fence-4534.test.ts`: `F1: the roster row goes after the check, before the composer clear → no terminal change`／`… the tool changes …`／`… issued but not yet applied`（発行済み・変更前） | claude の名簿の行。入力欄に残りがある画面（`C-e C-u` が出る）。再確認の `capture-pane` で行を消す／tool を codex にする。肯定の対照で `send-keys C-e C-u` が出ることを先に確かめる | 今は名簿を読み直さないので、消去・本文・Enter が記録されて 201 |
| T2 | F2 | 同: `F2: copilot --model, the row goes before /model → no terminal change`＋発行済み・変更前 | copilot の行・`--model`。`switchModelUnderInputLock` の idle の読みで行を消す | `/model <id>` の `send-keys` が記録される |
| T3 | F3・I3 | 同: `F3: launch, the row goes before new-session → nothing created or typed, 409, no start-failure notice`（claude・codex）＋発行済み・変更前 | セッション無し。起動の中の `has-session` で行を消す。答えが 409（§3.3）、`lastSend.reason` が `target-changed`、`reportSessionStartFailure` の通知が 0 件 | `new-session` と起動行が記録される。止めても 500 `SESSION_START_FAILED` と起動失敗の通知になる |
| T4 | I2 | 同: `I2: the row goes after the launch line → no change after it` | 起動行の `send-keys` の後の最初の読みで行を消す | 消去・本文・Enter が続く |
| T5 | F4 | 同: `F4: a fence refusal answers 409 SEND_TARGET_CHANGED with sendOutcome`／`a lost reservation still answers as before`／`a refusal with a cause keeps it` | relay を束ねた送信で 3 本に分ける。(1) 行を消す、(2) relay の予約を取り消す、(3) 確かめが例外を投げる（`unreadable`、`cause`）。直接の `cause` と札の `refusal` の両方を見る | (1) は止まらない。止まっても `relay-reservation-lost`・500・`code` 無し |
| T6 | F5 | `tests/unit/cli-tools/opencode-send-fence-4534.test.ts`: `F5: the row goes before prompt_async → no POST and no keyboard fallback`（1 回目・添付の後の 2 回目）／`the port is reassigned, the roster is the same → no POST`＋発行済み・変更前 | live の偽のサーバー（`fetch` を記録）。`noteDispatchStart` の前の読みで行を消す／割当のポートを替える | POST が出る。断られてもキーボードへ進む |
| T7 | I3 | `tests/unit/lib/session/terminal-fence-4534.test.ts`: `the refusal keeps its type and cause through the tool's wrap`・`InputBoundaryRefusedError keeps the hook's error as cause`・`a joined launch does not answer another request's refusal as its own` | codex の `Failed to send message to Codex` の包み・`TypeError` を投げる境界・相乗りの launch | 型も `cause` も落ちる |
| T8 | 陽性対照（I4） | `tests/integration/send-fence-4534.test.ts`: `control: a normal send makes the same changes as before`（claude・codex・copilot `--model`・opencode の HTTP） | 宛先が変わらない。門を mock しない同じ入力で、許可した全ての変更の列（tmux の argv と HTTP）を記録する。段 2 で直す前の develop で記録して緑を確かめてから固定する。既存の mock の試験は上位の順を保つ補助 | 直す前も緑（対照） |
| T9 | 静的・実行時 | `tests/unit/guards/terminal-fence-coverage-4534.test.ts`: G1〜G5 | §5 | 門が無いので G1・G2 が赤 |
| T10 | agy | `tests/integration/send-fence-4534.test.ts`: `agy: the row goes before the composer clear → nothing typed` | 害の無い記録した agy の画面（既存の fixture）を偽の tmux が返す。tool は偽。消去より前に名簿を変える。偽の `child_process` は tmux 以外を走らせない | 本文が記録される |
| T11 | relay の配送 | `tests/unit/lib/relay/relay-delivery-fence-4534.test.ts`: `the requester's tool changes after the claim → nothing typed, the reply goes back`／`… the prompt goes back`／`… an indeterminate one is held` | strict で解決した後・最初の変更の前に tool を変える。reply・prompt の戻し、保留まで見る | 解決の後に読み直さずに打つ |
| T12a | 範囲 | `tests/unit/lib/session/terminal-fence-4534.test.ts`: `an Auto-Yes poller armed by a send's launch still answers after the send was refused` | 送信の launch で `notifyTmuxSessionCreated` が Auto-Yes の poller を起こし、その後に送信が断られる。poller の答えが打たれる | 直す前は門が無く緑（対照）。誤った実装（範囲の後も粘着、切り離し漏れ）を赤にする |
| T12b | 範囲 | 同: `a callback a finished send left behind is refused` | 送信の中で `setTimeout` した、宣言も切り離しも無いコールバックが、範囲の後に打とうとする → 0 件・`FenceMisuseError('closed')`。並行の 2 要求は自分の札だけで止まる | 直す前は打たれる |
| T13〜T19 | I2（実変更の時点） | §2.5.4 の表 | 案 B1・B2 | 案を入れる前は窓の変更が記録される |
| M1 | 変異 | T1・T2・T3 を、門を「`inputStarted` の後だけ効く」形（柵を消去の後に戻す）にして**それぞれ**流す | 段 2 で一時的に変え、元に戻す | T1・T2・T3 が赤になること（返しに exit を書く） |
| M2 | 変異 | `clearComposerLine` の門を外す | 同上 | T1 と G1 が赤 |

---

## 7. agy

- 柵は agy の送信器にも効く。agy の本文・Enter・起動・trust の答えは、どれも E4・E5・E10・E12〜E14 の `tmux.ts` の関数を通る（`antigravity.ts:497`・`:570–574`・`:676–682`・`:773`）。agy の独自の `execFile`（`antigravity.ts:270`）は版の読みで、ペインを変えない
- 本文の前の役の確かめ（`beforeBody`、#4385）は今のまま。門はその後の `sendKeys`／`paste-buffer` の前に確かめる
- 試験は T10 の偽の tmux と記録した画面だけ。本物の agy・antigravity・`~/.gemini` には触れない（`--version` も）

---

## 8. 範囲の外と境界

### 8.1 範囲の外

| もの | 行き先 |
|---|---|
| exact の宛先の指定そのもの（CLI の `--instance-id`、CLI が名簿を読む） | #4518（この柵の上に載る） |
| 送信の結果の 3 値と再試行の規則（unknown から送り直さない、OpenCode の unknown の後のキーボード） | #4535。この柵は「断った後は新しい入力をしない」だけを足し、unknown の後の再試行の規則は変えない |
| agy の読み戻しの判定 | #4503 PR-B1 |
| send-operation の S0〜S4 | #4466 PR1b。S3 の h-S3 はこの柵で実現する。PR1b は #4534 のマージの後に載せる |
| 追跡票 T6（followup-candidates: `GET /api/worktrees/:id` の `agentInstances` が、名簿が空のとき主インスタンスを合成し、実在の行と区別できない） | 範囲の外。CLI が名簿を読むときの話で、サーバーの札は DB の行を直に読む。#4518 |
| 追跡票 T8（followup-candidates: `ask --instance` が宛先を解き直す） | 範囲の外。CLI の側の解決。#4518 |
| 追跡票 T10（followup-candidates: 完了・ダイアログの通知を worktree と ID だけで relay に結ぶ） | 範囲の外。送信の後の観測で、端末の変更ではない。#4538（relay の行に `toTool`） |
| #4484 の画面の選択（容器の作り直しで選択が先頭に戻る ほか） | 範囲の外（画面の宛先の表示）。サーバーへ届いた送信は、この柵で宛先の変化を断る |
| 送信以外の書き手（§1.3）を札に載せる | 別の Issue（案 3） |
| 送信の前の別ルートの書き込み（`--auto-yes`・`--contract`・`--role`／`--register`）、会話 ID の忘却 | #4466（S2/S3）。端末の変更ではない |
| relay の規則 0 の逆の端が判定の後に変わる窓 | 今と同じに残る（§2.9）。#4535・#4538 |

### 8.2 #4535・#4518・#4503 PR-B1 との境界

| 境 | この Issue | 相手 |
|---|---|---|
| #4535 | 門が断った試行の state（`not-sent`／`indeterminate`）と reason を決める | 3 値の名前・応答の形・再送の規則。**exit 34 と reason の値は、#4535 の 3 値の名前に合わせて人の答えの後に確定する**（2 回変えないため。opus P3-10） |
| #4518 | サーバーの札と門。`target` の比べ方（§2.2） | CLI が exact の ID を送る形。#4518 の `EXACT_TARGET_MISMATCH` は、この札の拒否を exact の要求の答えに写す形で載る（code を別にするかは #4518 で決める） |
| #4503 PR-B1 | agy の送信器の変更の前に門 | 読み戻しの判定（送れたか） |

### 8.3 段 2 で触るファイルの見込み（scope の候補）

§2.5.4 の表の「門だけ」と、採った案 B1-db・B2 の行を合わせたものに、次を足す。

- `src/lib/session/send-attempt-types.ts`（reason）
- `src/lib/relay/relay-bind.ts`（`RelayReservationLostError`）
- `src/lib/cli-tools/base.ts`（`createLaunchPane` の印、`startSessionOnce` の通知の分岐）
- `src/lib/cli-tools/launch-keys.ts`・`copilot.ts`（印）
- `src/lib/auto-yes-poller.ts`（「送信の外」の宣言）
- `src/app/api/worktrees/[id]/send/send-session-start.ts`・`send-failure.ts`
- `src/app/api/worktrees/[id]/terminal/route.ts`
- 人の答えの後: `src/cli/types/index.ts`・`src/cli/utils/api-client-errors.ts`（C3）、`docs/user-guide/cli-operations-guide.md` と英語版（C6）
- `docs/module-reference.md` の断片
- 試験: §6 の新しいファイル、`tests/unit/guards/fake-tmux-child-process.ts`（口と答えを足す）、§4.2 の (i) を選んだ場合はその試験の前置き

---

## 9. 未決

### 9.1 PM の判断が要るもの（前提に触れる。開発リーダーが PM へ上げる）

| # | 問い | 勧め |
|---|---|---|
| P-1 | I2 を実変更の時点で満たすために、案 B1-db（名簿の書き手との排他、DB の貸し出し。名簿の route に短い待ちと 409 `roster_changed` が増える）と案 B2（ペイン ID で打つ）の両方を入れる。両方を入れても残る窓は「CommandMate を経ずに DB を直に書く書き手」だけ（§2.5.4）。この窓を受入条件の外と読むか | 両方を入れる。DB を直に書く手での編集は、CommandMate の書き手ではないので I2 の外と読む。読まないなら、受入条件の変更として人が決める |
| P-2 | fail-closed（送信の層の印の下で札が無ければ投げる）が、本物の門まで札無しで届く既存の試験を赤にしうる（§4.2）。(i) その試験に試験用の札の前置きを足すか、(ii) 印の範囲を狭めるか | (i)。段 2 の最初に数を測って返す |

### 9.2 その他（開発リーダーが決める、または人の答えを待つ）

| # | 問い | 勧め |
|---|---|---|
| U2 | 公開の契約: 案 (a) と (b)（§3.3） | (b)。人の答え待ち。値は人の答えの後に確定する |
| U3 | CLI の exit: (b) なら 34、(a) なら 31 | U2 と一緒に人が決める |
| U4 | timer の札（§2.3 の `timer`）の確かめを「worktree の行・timer の行が `sending`・別の tool の行が無い」にする | この形 |
| U5 | 比べ方（§2.2）: 実在の宛先かを名簿の行そのもので見て、worktree の既定の変更では断らない。同じ三つ組の作り直しは論理の宛先として一致にし、ペインの同一性は B2 が保つ | この形 |
| U6 | 札の条件に、送信の予約（同じ `attemptId`）と配送の claim を読みだけで入れる（§2.9） | 入れる。応答は今の予約の喪失のまま |
| U7 | 後始末（この要求が作ったものの kill・取り下げ・`delete-buffer`）は、断った札でも通す。`createSession` は 1 つの変更（§2.7） | この形 |
| U8 | #4466 PR1b と #4518 を、この柵のマージの後に載せる | よい |
