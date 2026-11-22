# 1 回の送信の端末の変更を 1 か所の柵に通す（Issue #4534）設計

- 段: 段 1（設計 1 枚。この文書だけ）。src・tests は書かない。段 2 で、試験を先に書き（直す前の赤を確かめる）、その後に実装する
- 版: 第 1 版（2026-11-22）
- 基準: develop `ad21704ea`。行番号はこの版のもの。Issue の行番号（`192f9dca1`）は §1 で今の位置に直した
- 正: Issue #4534 の本文（事象 F1〜F5・不変条件 I1〜I4・受入条件・範囲の外）。この文書は本文を変えない
- 材料: s9 の `review-4518-4492-codex-r2.md`（A2）・`review-4518-v3-codex.md`（2）・`review-4518-v3-opus.md`（P1-1・P2-2）・`review-4466-exact-diff-codex.md`（2・3・6）・`worker-return-4518-stage1.txt`・`followup-candidates.md`（T6・T8・T10）。関連の設計 `docs/design/send-atomic-4466.md`
- 書き方: 「事実」は file:line で確かめたこと。「見立て」「未確認」は明記する

---

## 0. 結論

| 項目 | 内容 |
|---|---|
| 柵の形 | **案 1**: 要求ごとの札を AsyncLocalStorage に持ち、**端末を変える最下層（`tmux.ts` の変更の関数・送信器の `paste-buffer`・OpenCode の `prompt_async` の POST）の直前の同期の一歩で `fenceGate` が札を確かめる**。確認は変更のたびに行う（最初の変更の直前を含む）。断ったら札に理由を残し、以降の変更をすべて断る（粘着） |
| 札 | `{ requestId, target: (worktreeId, instanceId, cliToolId), sessionName, kind, confirm }`。`resolved`（route・relay の配送。名簿を同期で読み直して比べる）と `literal`（timer・直接の呼び出し。宛先は呼び手が名指した値そのもの） |
| I3 | 断った理由は例外の包み直しに頼らず、**札の上の `refusal`（元の型と `cause` を持つ）を送信サービスが読む**。route は新しい 409 `SEND_TARGET_CHANGED` を返す（§3。公開の契約の追加。人の了承が要る） |
| I4 | 宛先が変わらない送信では `fenceGate` は何もしない（変更の並び・回数・引数は同じ）。tmux を mock する既存の試験は門ごと mock されるので変わらない。試験の名前は §4 |
| 迂回の検査 | 静的（既存の `pane-key-writers` の台帳を、ペインの作成・HTTP の dispatch まで広げ、送信の経路の行は「門あり」を必須にする）と実行時（断る札の下で `tmux.ts` の変更の関数を全部呼び、偽の tmux に変更が 0 件）の 2 つ（§5） |
| 数 | 端末の変更の箇所 19 行（§1.1 の E1〜E19）。Issue の F1〜F3・F5 が当たるのは 4 行（E4・E8・E10・E16）と F3 の延長 1 行（E6）、**Issue に無いものが 11 行**、本文の後で門だけ要るものが 3 行（E12〜E14）。未決 8 件（§9） |

---

## 1. 端末の変更の全列挙（送信 1 回の順）

### 1.1 送信の要求の中で端末を変える箇所

「門」は §2 の `fenceGate` が掛かる位置。「境界」は今の `beforeInput`（`noteInputStart` / `noteDispatchStart`）より前か後か。

| # | 中身 | 今の位置（事実） | 今の境界 | Issue | 門を置く位置（段 2） |
|---|---|---|---|---|---|
| E1 | ペインの作成（`new-session`→`set-option`→`new-window`→`respawn-pane`→`resize-window`） | `src/lib/tmux/tmux.ts:531`・`:552`・`:573`・`:447`（`respawnLoginShell`、`:584` から）・`:176–186`（`reconcileSessionGeometry`、`:604` から）。呼び手 `src/lib/cli-tools/base.ts:929`（`createLaunchPane`）・`src/lib/session/claude-session.ts:999` | 前 | 無し | 各 `execFileAsync('tmux', …)` の直前 |
| E2 | 再利用するペインの形の直し（`resize-window`） | `tmux.ts:176–186`。呼び手 `base.ts:452`（`reconcileExistingSession` `:445`、`resolveLaunchPane` `:889` から） | 前 | 無し | 同上 |
| E3 | ツール自身の `resize-window` | `src/lib/cli-tools/opencode.ts:449–452`・`src/lib/cli-tools/opencode-v2.ts:284–287`（どちらも tmux の層の外の `execFileAsync`） | 前 | 無し | 呼び出しの直前（または `tmux.ts` の関数へ寄せる。§8.3） |
| E4 | 起動の打鍵（起動行・`unset CLAUDECODE`） | `src/lib/cli-tools/launch-keys.ts:39–52`（`sendKeys` `:47`）。呼び手 `claude-session.ts:1019`・`codex.ts:337`・`:343`・`gemini.ts:178`・`copilot.ts:536`・`antigravity.ts:497`・`command-code.ts:303`・`vibe-local.ts:164`・`opencode.ts:504`・`opencode-v2.ts:304` | 前 | **F3** | `tmux.ts` の `sendKeys` の中 |
| E5 | 起動中の画面への答え（trust・update・hooks の画面・auto-default の案内） | `codex.ts:630–735`・`:856–925`、`copilot.ts:604–608`、`gemini.ts:236–246`、`antigravity.ts:570–574`・`:676–682`、`claude-session.ts:479–489`、`src/lib/cli-tools/claude-auto-default-nudge.ts:140–145` | 前 | 無し | `sendKeys`・`sendSpecialKey(s)` の中 |
| E6 | 送信器の中の起動し直し（ツールが落ちたペインへ E4・E5 をもう一度） | `base.ts:814–838`（`requireSession` の `relaunch: true`）→ `base.ts:780`（`relaunchIfToolExited`）。呼び手 `codex.ts:1025`・`antigravity.ts:760`・`gemini.ts:333`・`copilot.ts:922`・`command-code.ts:420`・`vibe-local.ts:190`・`opencode.ts:914`・`opencode-v2.ts:387` | 前 | F3 の一部 | E1・E4・E5 の門 |
| E7 | 送信の前の claude の案内への答え | `claude-session.ts:1183`（`answerClaudeAutoDefaultNudgeBeforeSend`）→ `:479–489` | 前 | 無し | E5 と同じ |
| E8 | copilot の `/model`（本文の前の準備の入力） | `copilot.ts:1124–1125`（`typeLeavingMarkOnFailure` → `sendKeys(text, true)` `:328`）。呼び手 `src/lib/session/send-user-message.ts:530–533` | 前 | **F2** | `sendKeys` の中 |
| E9 | 前の送信の残りの取り下げ（carried paste の消去） | `src/lib/cli-tools/submit-verified-sender.ts:384`（`waitOutCarriedPaste` `:357–399`）→ `src/lib/session/composer-clear.ts:215`・`:217` | 前 | 無し | `clearComposerLine`・`clearComposerPasteToken` の中（`tmux.ts:1220`・`:1248`） |
| E10 | 送信の前の入力欄の消去（`C-e C-u`） | `submit-verified-sender.ts:758`（`clearComposerBeforeSend` `:633–679`）→ `composer-clear.ts:215`・`:217` | 前 | **F1** | 同上 |
| E11 | copilot の選択の一覧のコマンド | `copilot.ts` の `sendMessage`（`noteInputStart` の後に `typeLeavingMarkOnFailure`、`:936–963` 付近） | 後 | 無し | `sendKeys` の中（門だけ要る） |
| E12 | 本文の打鍵（`send-keys -l`） | `submit-verified-sender.ts:802`（`noteInputStart` `:800` の後） | 後 | — | `sendKeys` の中 |
| E13 | 本文の貼り付け（`paste-buffer`） | `submit-verified-sender.ts:280`（`runTmux`。`noteInputStart` `:274` の後）。`load-buffer` `:250`・`delete-buffer` はペインを変えない（§2.6） | 後 | — | `:280` の `runTmux` の直前 |
| E14 | Enter・Enter の打ち直し | `submit-verified-sender.ts:830`・`:933`（`sendSpecialKeys`） | 後 | — | `sendSpecialKeys` の中（キーごと） |
| E15 | 失敗の後の後始末（本文の取り下げ・置き換えの消去） | `submit-verified-sender.ts:329`・`:332`（`withdrawUnsentBody`）・`:894`（`clearInputLine`） | 後 | 無し | `clearComposerLine`・`clearInputLine` の中 |
| E16 | OpenCode の HTTP の dispatch（1 回目） | `opencode.ts:779`（`noteDispatchStart`）→ `:785`（`sendOpencodePrompt`）→ `src/lib/hooks/sources/opencode/client.ts:584–600`（`loopbackFetch` `:125`） | 境界はある | **F5** | `sendOpencodePrompt` の `try` の前 |
| E17 | OpenCode の 2 回目の dispatch（添付の送信の後の文字の送信） | `opencode.ts:1103–1114`（`sendMessageWithImage`）→ `sendMessageAfterDispatch` → `:914–917` の `trySendViaServer` | 境界はある | 無し（codex 3） | E16 と同じ |
| E18 | OpenCode のキーボードへの切り替え | `opencode.ts:934`（E9〜E15 をそのまま通る） | — | 無し | E9〜E15 の門 |
| E19 | 起動の役の確かめの失敗での停止（`kill-session`） | `base.ts:417`（`settleLaunchRole` の `kill`）→ 各ツールの `killSession` | 前 | 無し | `tmux.ts:1003` の `killSession` の中（§9 U7） |
| E20 | 送信の前のロールの再確認・relay の境界の記録（端末は変えない） | `src/app/api/worktrees/[id]/send/send-role.ts:309–336`・`src/lib/relay/relay-bind.ts:229–273` | 本文の直前 | F4 の材料 | 変えない（§2.5） |

数え方: 変更の行は E1〜E19（E20 は端末を変えない）。Issue の F1＝E10、F2＝E8、F3＝E4（E6 は F3 の延長）、F5＝E16。F4 は変更ではなく理由の読み替え（§3）。Issue に無い行（表の「無し」）は E1・E2・E3・E5・E7・E9・E11・E15・E17・E18・E19 の 11 行。

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

`192f9dca1..ad21704ea` で上のファイルのうち変わったのは `antigravity.ts`（#4503 PR-B2）だけで、送信器の順は変わっていない（`git diff --stat` で確かめた）。

### 1.3 送信の要求の外の書き手（柵の外。今の台帳のまま）

| 書き手 | 位置 | 扱い |
|---|---|---|
| ターミナルの route の入力 | `src/lib/tmux/polling-tmux-transport.ts:41`・`control-mode-tmux-transport.ts:45`・`src/lib/cli-tools/direct-input.ts` | 人の打鍵。送信の要求ではない |
| special-keys・clear-composer・kill-session の route | `src/app/api/worktrees/[id]/special-keys/route.ts`・`clear-composer/route.ts`・`kill-session/route.ts` | 同上 |
| respond・Auto-Yes・計画のレビューの答え | `src/lib/prompt-answer-sender.ts`・`command-code-plan-review.ts:231–233` | 画面への答え（#3952 の shared の書き手） |
| 中断の Escape・各ツールの終了のキー | `base.ts:629`・`opencode.ts:1310–1314`・各ツールの `killSession`・`src/lib/session-key-sender.ts:154–156`・`src/lib/session-cleanup.ts` | 止める操作 |

これらは送信の札の範囲（§2.3）の外で走る。`fenceGate` は札の無い文脈では何もしないので、今と同じに動く。新しく増やせないことは既存の台帳（`tests/unit/guards/pane-key-writers.test.ts` の `UNMEDIATED_BASELINE` など、減るだけ）が守る。§9 U1 で、この読みを決める。

### 1.4 探し方（段 2 でも同じ手順で漏れを見る）

```sh
# tmux の変更（key の書き手・ペインの作成・形）
git grep -nE "\b(sendKeys|sendSpecialKeys|sendSpecialKey|sendSpecialKeysAndInvalidate|sendDirectInputAndInvalidate|clearInputLine|clearComposerLine|clearComposerPasteToken|clearComposer|createSession|killSession|reconcileSessionGeometry|typeLaunchLines|sendMessageWithSubmitVerification)\(" -- src
# tmux の層の外で組み立てる tmux のコマンド
git grep -nE "'(send-keys|paste-buffer|load-buffer|new-session|new-window|respawn-pane|resize-window|set-option)'" -- src
git grep -nE "execFile(Async)?\(\s*'tmux'" -- src
# HTTP の dispatch
git grep -nE "fetch\(|prompt_async|sendOpencodePrompt\(" -- src/lib/cli-tools src/lib/hooks/sources/opencode
# 送信の要求の入口（札を作る所の候補）
git grep -nE "sendUserMessage\(|\.sendMessage(WithImage)?\(|sendModelCommand\(|startSession\(" -- src
```

---

## 2. 柵の形

### 2.1 案の比較

| 観点 | **案 1（採る）**: 最下層の門＋要求の札（ALS） | 案 2: 柵のモジュールを tmux の上に置き、送信器が柵の関数だけを呼ぶ | 案 3: 型で札を必須にする（全ての書き手の引数に札） |
|---|---|---|---|
| 迂回 | 変更は最下層を必ず通る。層の外の tmux のコマンドは台帳で見つける | 送信器が柵を通らず tmux を直接呼ぶと抜ける（台帳で見る） | 型で抜けない |
| 最初の変更の直前 | 変更の spawn と同じ同期の一歩で確かめる | 柵の関数の中で確かめる（同じ） | 同じ |
| I4（既存の試験） | tmux を mock する 248 本はそのまま（門ごと mock）。呼び出しの並びも引数も変わらない | 送信器の import 先が変わり、`vi.mocked(sendKeys)` で見る試験の一部が柵の関数の mock を要る | 書き手の引数が変わり、大量の試験の期待値が変わる（I4 に反する） |
| 柵を mock で消すか | 新しい試験は `child_process` だけを偽にする（`tests/unit/guards/fake-tmux-child-process.ts`）。門・tmux・送信器は本物 | 同じ | 同じ |
| 送信以外の書き手 | 札の無い文脈では素通り（今と同じ）。台帳で増やさない | 同じ | 全部に札を配る（範囲が大きい） |
| 範囲 | 中（§8.3） | 中〜大 | 大 |

案 1 を採る。#3981 の台帳の docblock（`pane-key-writers.test.ts:47–48`）が「後で型で狭める」とした案 3 は、送信以外の書き手の行が 0 になった後の別の Issue に残す。

### 2.2 札（要求ごと）

| 欄 | 意味 |
|---|---|
| `requestId` | `randomUUID()`。ログと応答に出す |
| `target` | 確かめた宛先 `(worktreeId, instanceId, cliToolId)`。`instanceId` は解決済み（主インスタンスはツールの ID、#868） |
| `resolvedBy` | 札を作ったときの `resolveSessionTarget` の段（`roster`・`primary`・`explicit`・`worktree-default`）。`literal` は持たない |
| `sessionName` | 作ったときの `resolveSessionName(target)`。門では、その時点の `resolveSessionName(target)` も一致として認める（legacy の別名、#2866） |
| `kind` | `resolved`（confirm が DB を読み直す）／`literal`（confirm は常に一致） |
| `confirm` | 同期の関数。`resolved` は下の表の比べ方 |
| `conditions` | 札に足す読みだけの条件（relay の予約の保持。§9 U6） |
| `state` | `open`→`refused`（粘着）／`closed`（要求が終わった） |
| `refusal` | 断ったときの `SendTargetChangedError`（元の型。`cause` は confirm が投げた例外） |
| `changes`・`inputStarted` | 通した変更の数、本文の入力・dispatch が始まったか（`noteInputStart`・`noteDispatchStart` が立てる） |

`resolved` の比べ方（confirm の中。`await` を置かない）:

| 今の読み | 判定 | `reason` |
|---|---|---|
| worktree の行が無い | 不一致 | `worktree-gone` |
| `resolveSessionTargetStrict(db, worktreeId, 札を作ったときと同じ options)` が `ok: false` | 不一致 | `tool-changed`（名簿と要求の tool の食い違い） |
| `cliToolId` が違う | 不一致 | `tool-changed` |
| 札が `roster` で、今は `roster` でない（行が消えた） | 不一致 | `target-gone` |
| 札が `roster` 以外で、今 `roster`（同じ tool の行が足された） | 一致 | — |
| 同じ `(worktree, instance, tool)` の行を消して作り直した | 一致（論理の宛先。#4466 レビュー 9 の Q-B と同じ） | — |
| confirm が例外 | 不一致（fail-closed） | `unreadable`（`cause` に元の例外） |
| 条件（relay の予約）が外れた | 不一致 | `relay-reservation-lost`（§3.2） |

relay の配送の札の confirm は `tryResolveRelayDeliveryTarget(db, relay.from)`（#4498 の strict）を読み直し、`null` か `(instanceId, cliToolId)` の違いで不一致にする（`target-gone`・`tool-changed`）。fallback の推測へ寄せない。

### 2.3 札を作る所（入口）と範囲

| 入口 | 札 | 範囲 |
|---|---|---|
| `POST /api/worktrees/:id/send`（`route.ts` `handleSend`） | `resolved`。`validateSendRequest` の `target`（`send-request.ts:291–314`）から作る | `startSessionForSend`（`route.ts:454`）から `sendUserMessage`（`:508`）の戻りまで |
| relay の配送（`src/lib/relay/relay-delivery.ts` `attemptDelivery`） | `resolved`。claim の直前の strict の解決（`settled`）から作る | `sendUserMessage`（`:663`）の呼び出し |
| `sendUserMessage`（`send-user-message.ts:365`） | 文脈に札があれば、その `target` が引数と一致するかを確かめる（違えば `ticket-mismatch` で断る）。無ければ `literal` を作る（timer `src/lib/timer-manager.ts:141`、直接の呼び出し） | 関数の全体 |
| それ以外（start の route、送信以外の書き手、試験の直接の呼び出し） | 作らない | 札の無い文脈＝門は素通り |

- 範囲の終わりで `state` を `closed` にする。`closed` の札は「札の無い文脈」と同じに扱う。送信の中で始めて送信の後も走るもの（`startPolling` の poller、Auto-Yes の poller の timer）が ALS を引き継いでも断られないため
- `refused` は範囲の後も断り続ける（送信の中で投げ損ねて後で走る変更を止める）
- 他の要求の札には効かない（札は要求の ALS にだけある）。同じ session への 2 つの送信は今どおり入力の lock が並べる

### 2.4 門（`fenceGate`）

`src/lib/session/terminal-fence.ts`（新）。`global-state`・logger・`node:async_hooks` だけを import する（`tmux.ts` から import するため。import の輪を作らない）。

```
fenceGate(sessionName, what):          // what は 'send-keys' / 'paste-buffer' / 'new-session' / 'http:prompt_async' など
  t = 札（ALS）
  if t が無い or t.state === 'closed': return          // 送信の要求の外（I4）
  if t.state === 'refused': throw t.refusal             // 粘着（I2）
  if sessionName が t の session でない: refuse('ticket-mismatch')
  v = t.confirm()  （例外は refuse('unreadable', cause)）
  if v が不一致: refuse(v.reason)                      // 札に refusal を残して throw
  t.changes += 1
```

- **置く所**: 端末を変える spawn・fetch と同じ同期の一歩、その直前。`tmux.ts` の各関数は `execFileAsync` を呼ぶまで `await` を挟まない（`sendKeys` `tmux.ts:663–692` は引数を組んで `execFileAsync`）。`try` の外に置き、`TmuxSendError` などに包まれないようにする
- **複数の変更の関数**: `sendSpecialKeys` はキーごと（`tmux.ts:893–906` の繰り返しの中、`execFileAsync` の直前）。門の拒否は `catch` で `TmuxSendError` にしない（`isSendFenceRefusal` なら投げ直す）。`clearComposer` の繰り返しは各 pass の `clearComposerLine` の中の門で止まる
- **最初の変更の直前**: 「変更のたびに確かめる」ので、最初の変更の直前も含む（I2）。既に通った変更（作ったペイン・起動した agent・消した入力欄）は戻さない。打鍵 0 の範囲＝「最初の変更より前の不一致なら変更 0」
- **境界との順**: `noteInputStart`・`noteDispatchStart` は、境界の hook（`runBoundaryHook`）より前に `fenceConfirm()`（数えない確かめ）を呼ぶ。不一致の要求が relay の入力の境界を DB に書かないため
- **飲み込む catch**: 送信器には失敗を飲み込んで別経路へ進む catch がある（`opencode.ts:811–823` は `unknown`/`skipped` にしてキーボードへ進む。`:814` は境界の拒否だけを投げ直す）。そこでは `isInputBoundaryRefusal` と同じく `isSendFenceRefusal` も投げ直す。投げ直しを忘れても、札が粘着なので次の変更（キーボードの最初の消去）で断られる
- **既存の lock との関係**: `isCurrent()`／`assertInputOwner` は「この書き手が今の持ち主か」、門は「この要求の宛先が今も同じか」。別の問いなので両方残す

### 2.5 既存の仕組みとの関係

| 既存 | 関係 |
|---|---|
| `beforeInput`（`instance-input-lock.ts:839–843`、relay の境界 `relay-bind.ts:229–273`・ロールの条件 `send-role.ts:309–336`） | 残す。本文の直前の**記録**（relay の境界の時刻）とロールの再確認の役。宛先の確認は門が先に、全ての変更で行う。`beforeInput` の型の保ち方だけ直す（§3.2） |
| 入力の lock（`withInstanceInputLock`・ticket・`invalidateInstanceInput`） | 変えない。門は lock の中でも外でも働く（起動の打鍵は lock の turn の中で、門が各 `sendKeys` の前に確かめる） |
| claude-3 の送信の予約（`src/lib/agent-health/claude3-reservation.ts`、CLI の側のファイルの世代） | 変えない。予約は CLI が送る前に取るもので、門はサーバーの中の変更だけを見る。門は新しい送信の経路を作らないので、予約の分岐（`pm-send` → `reserveMain`）は今のまま排他を保つ |
| #4498 の strict な解決（`tryResolveRelayDeliveryTarget`） | 配送の札の confirm に同じ関数を使う。`null` は不一致（fail-closed）。fallback へ寄せない |
| 規則 0（agy の柵、`findBoundRelayToolPolicyRefusal` `route.ts:335–343`・`closeRelayRefusedByToolPolicy`） | 変えない。門は「判定した tool と打つ tool が同じ」を変更のたびに保つので、規則 0 が判定した tool が途中で替わることは無くなる（強めるだけ） |
| #4466 の send-operation（S2 で宛先を決め、S3 は読み直さず持ち回る） | 札の `target` が S2 の値。門の confirm は「比べるだけ」で解決し直した値へ寄せない（I2 と矛盾しない）。h-S3（起動の後・打鍵の前）はこの門が実現する |

### 2.6 門を置かないもの（理由つき）

| もの | 理由 |
|---|---|
| `load-buffer`・`delete-buffer`（`submit-verified-sender.ts:250`・`:252`・`:263`・`:276`・`:282`） | tmux サーバーの buffer だけで、ペインに何も入らない。`paste-buffer` に門を置く |
| `capture-pane`・`has-session`・`display-message` などの読み | 端末を変えない |
| `invalidateCache`・`chooseNewOpencodeConversation`（`route.ts:452`）など | 端末を変えない（会話の ID の忘却は #4466 レビュー 6 の範囲。§8） |

---

## 3. I3（理由を保つ）

### 3.1 今の失い方（事実）

| 箇所 | 今 |
|---|---|
| `runBoundaryHook`（`instance-input-lock.ts:958–965`） | `beforeInput` の例外を `new InputBoundaryRefusedError(error)` に包む。コンストラクタ（`:852–858`）は message に元の message を写すだけで、`cause` を渡さない。元の型は失われる |
| `isInputBoundaryRefusal`（`:862–866`） | message の正規表現で見分ける（ツールが `Failed to send message to …` で包み直すため） |
| `sendUserMessage` の `deliver`（`send-user-message.ts:673–685`） | ロールの拒否の次に、境界の拒否を全部 `relay-reservation-lost` にする |
| `sendUserMessage` の `/model`（`:535–546`） | 再確認の code だけを見て、他は `model-switch-failed` |
| route（`send-failure.ts:65–124`） | `relay-reservation-lost` は 500＋文。`code` が無い。束ねた relay があれば `sendOutcome: 'not_sent'` が付く（`route.ts:122–143`） |
| ツールの包み直し | `codex.ts:1053`・`opencode.ts:956`・`antigravity.ts:788` などは `{ cause }` を付けるが、全ツールではない。copilot の `/model` は `code` だけを写す（`copilot.ts:1076–1088`） |

### 3.2 直し方

| # | 変更 | 型と cause |
|---|---|---|
| R1 | 門の拒否は `SendTargetChangedError`（`code: 'SEND_TARGET_CHANGED'`、`reason`、`target`、`current`（読めた今の `cliToolId`・`resolvedBy`、読めなければ null）、`requestId`、`what`、`changesBefore`、`cause`）。`ticket.refusal` にも同じ object を置く | 元の object のまま |
| R2 | `sendUserMessage` は `deliver` の catch・`/model` の catch・`startSessionForSend` の失敗の扱いで、**最初に `ticket.refusal` を読む**。あれば `{ ok: false, stage: 'target_changed', code: 'SEND_TARGET_CHANGED', refusal }` を返し、試行は `inputStarted` が false なら `not-sent`、true なら `indeterminate`（本文が入力欄にあるかもしれない）。理由は新しい `target-changed` | 包み直しの数に依らない（札の側の道） |
| R3 | 札が無いときの読み（直接の呼び出しなど）は、例外の `cause` の鎖をたどって `SendTargetChangedError` を探す（`isSendFenceRefusal`）。message の正規表現は使わない | `cause` の鎖 |
| R4 | `InputBoundaryRefusedError` は `super(message, { cause })` にする。コンストラクタの引数（`cause` 1 つ）と message は変えない（`tests/unit/app/api/worktrees/send-role-4115.test.ts:311` と `submit-verified-sender-split-4056.test.ts:197` がこの形を使う） | `.cause` に元の例外 |
| R5 | relay の予約の喪失は型にする: `RelaySendBinding.beforeInput`（`relay-bind.ts:265–268`（`:267` の型の無い `Error`））が `RelayReservationLostError` を投げる。`deliver` は `cause` の鎖にこれがあれば `relay-reservation-lost`。**型の無い境界の拒否も今どおり `relay-reservation-lost`**（`tests/unit/lib/session/send-user-message-input-boundary-3957.test.ts:255–267` が `new Error('reservation gone')` で固定している。変えない） | 型で見分け、型の無いものは今のまま |
| R6 | 門の札の条件（§9 U6）で予約の喪失を見つけたときは `SendTargetChangedError` にせず、R5 の `RelayReservationLostError` を札に置く（今の予約の喪失の応答のまま。宛先の不一致と混ぜない） | 同上 |
| R7 | relay の配送: `stage: 'target_changed'` の `not-sent` は今の `settleUnsentResult`（`relay-delivery.ts:940–966`）の「断られた」と同じ（payload を戻す。取り下げない）。`indeterminate` は今の `holdUncertain` | 変えない |
| R8 | timer: `[target_changed] <文>` を理由に残す（`timer-manager.ts:150–152` の形のまま）。`literal` の札は宛先で断らないので、出るのは `ticket-mismatch` の時だけ | — |

`ticket-mismatch`（札と違う session への変更）と札の不正は作りの誤りで、`SEND_TARGET_CHANGED` にはしない（試行の理由 `fence-misuse`、今の 500 の答え）。

### 3.3 公開の契約の追加（**人の了承が要る**。開発リーダーが PM へ WAIT で上げる）

| # | 追加 | 中身 |
|---|---|---|
| C1 | `POST /api/worktrees/:id/send` の新しい応答 | **409** `{ "error": "<文>", "code": "SEND_TARGET_CHANGED", "reason": "worktree-gone" \| "target-gone" \| "tool-changed" \| "unreadable", "target": { "worktreeId", "instanceId", "cliToolId" }, "current": { "cliToolId", "resolvedBy" } \| null, "requestId": "<uuid>" }`。今の仕組みで `sendOutcome`（`not_sent`／`unknown`）、束ねた relay があれば `relayId` が付く（`route.ts:122–143`）。ask の予約は今の `settleRouteAsk` のまま |
| C2 | `prompt --json` の `lastSend.reason` | 新しい値 `target-changed`（`not-sent` または `indeterminate`）と `fence-misuse`（`not-sent`） |
| C3 | CLI の `send`・`ask` の exit | **新しい exit 34**（`SendTargetExitCode.CHANGED`、`src/cli/types/index.ts` に足す。30〜33 は `InterruptExitCode`・`RoleExitCode`・`ToolPolicyExitCode`、40・41 は strict の `respond`）。`src/cli/utils/api-client-errors.ts:111–` の 409 の分岐に `SEND_TARGET_CHANGED` を足す |
| C4 | CLI の出力 | stdout は空。stderr の 1 行目は `Error: <サーバーの文>`。2 行目は今の `describeFailedSendOutcome`（`src/cli/commands/message-dispatch.ts:158–172`）の文（`not_sent` なら送り直してよい、`unknown` なら先に pane を見る） |
| C5 | 変えないもの | 予約の喪失の応答（500・`code` 無し・`sendOutcome: 'not_sent'`）は今のまま。`SEND_TARGET_CHANGED` の有無で区別できる（受入条件の F4）。`PROMPT_WAITING`・`FOREIGN_SESSION`・`ROLE_*`・`TOOL_POLICY_DENIED` の 409 も今のまま |
| C6 | 文書 | `docs/user-guide/cli-operations-guide.md`（ja）と英語版の終了コードの表に 34 を足す。web の画面は `error` の文を出す今の扱いのまま（未確認: 画面の送信の失敗の表示が 409 の未知の code をどう出すかは段 2 で確かめる） |

案: C3 を足さず、exit 99（今の 409 の既定、`Unexpected HTTP status: 409`）のままにもできる。勧めない（「名簿を読み直してから送る」という回復が他の 99 と区別できない）。§9 U2・U3。

---

## 4. I4（振る舞いを変えない）

宛先が変わらない送信では、門は confirm が一致して数を足すだけで、tmux の呼び出しの並び・回数・引数を変えない。次の既存の試験を**変えずに**緑で守る（段 2 の完了の条件）。

| 守るもの | 試験（ファイル: describe） |
|---|---|
| 本文と Enter を分ける・読み戻し | `tests/unit/cli-tools/submit-verified-sender.test.ts`: `submit-verified-sender`（`body/Enter separation (Issue #1469/#1470 regression guard)` ほか） |
| 送信の前の消去と再確認・lock の中の順 | `tests/unit/cli-tools/submit-verified-sender-input-lock-3945.test.ts`、`submit-verified-sender-ticket-4065.test.ts`、`submit-verified-sender-lock-split-4057.test.ts`、`submit-verified-sender-split-4056.test.ts` |
| 長い本文の貼り付け | `tests/unit/cli-tools/submit-verified-sender-long-body-2464.test.ts`、`submit-verified-sender-late-paste-3937.test.ts` |
| Enter の数・codex の burst・最初の prompt | `submit-verified-sender-final-enter-3880.test.ts`、`submit-verified-sender-codex-burst-3366.test.ts`、`submit-verified-sender-first-prompt-4035.test.ts`・`-4048.test.ts` |
| copilot の `/model` と選択の一覧 | `tests/unit/cli-tools/copilot-input-lock-3945.test.ts`: `copilot keys outside the shared sender take the input lock (Issue #3945)`、`copilot-input-lock-3952.test.ts`、`tests/unit/lib/session/send-user-message-model-recheck-3952.test.ts` |
| 起動の打鍵 | `tests/unit/cli-tools/launch-lines-input-lock-3981.test.ts`: `[#3981] launch keys wait for a send holding the composer, per tool`・`[#4050] \`typeLaunchLines\`, the ledger site every launch types through`、`codex-launch-dialog-ticket-3981.test.ts`、`session-relaunch-2070.test.ts` |
| OpenCode の HTTP とキーボードへの切り替え | `tests/unit/cli-tools/opencode-send-api-2035.test.ts`: `Issue #2035: sending over the opencode server`（`the request`・`the read-back`・`the fallback`）、`opencode-send-selection-2048.test.ts` |
| agy の本文の前の役の確かめ | `tests/unit/cli-tools/antigravity-role-gate-4385.test.ts` |
| 境界の hook・試行の記録 | `tests/unit/lib/session/send-user-message-input-boundary-3957.test.ts`（`:255–267` の `relay-reservation-lost` を含む）、`send-user-message-order-4065.test.ts`、`send-user-message.test.ts`、`tests/unit/app/api/worktrees/send-relay-bind-3957.test.ts`、`send-role-4115.test.ts`、`tests/unit/lib/relay/relay-bound-delivery-3957.test.ts` |
| route の送信 | `tests/integration/api-send-cli-tool.test.ts`、`api-send-instance-cli-tool.test.ts`、`api-send-instance-tool-conflict-2491.test.ts`、`api-send-prompt-waiting-1708.test.ts` |
| relay の strict（#4498） | `tests/unit/relay/relay-session-ref-4498.test.ts`、`tests/integration/cli-relay-adhoc-tool-4496.test.ts` |
| tmux の関数そのもの（札の無い文脈） | `tests/unit/tmux/*.test.ts`、`tests/unit/tmux.test.ts` |
| 書き手の台帳・tmux の import | `tests/unit/guards/pane-key-writers.test.ts`、`tests/unit/guards/tmux-import-allowlist.test.ts`、`tests/unit/guards/import-cycles-baseline-3482.test.ts` |

なぜ変わらないか: 上の多くは `@/lib/tmux/tmux` を mock する（門ごと消える）。mock しない試験（`fake-tmux-child-process` を使うもの、`tests/unit/tmux*`）は札の無い文脈か `literal` の札で走り、門は素通りか常に一致。route の試験の `resolved` の札は、試験の DB を同じ options で読み直して同じ答えになる。陽性対照の T8（§6）が、本物の送信器の並びを新しく記録して固定する。

---

## 5. 札の無い経路を足すと赤になる検査

| # | 種類 | 形 |
|---|---|---|
| G1 | 実行時（網羅） | 断る札（`confirm` が常に不一致）の下で、`tmux.ts` の変更の関数を**全部**呼ぶ。一覧は `pane-key-writers-scan.ts` の `tmuxKeyWriterExports` と同じ読み方で、モジュールから読む（`createSession`・`killSession`・`reconcileSessionGeometry` を足した集合）。偽の tmux（`fake-tmux-child-process`）が記録した変更が 0 件であること。門を付け忘れた新しい関数は赤 |
| G2 | 静的（層の外のコマンド） | `scanRawKeyWrites` の探し方を、`paste-buffer`・`send-keys` に加えて `new-session`・`new-window`・`respawn-pane`・`resize-window`・`set-option` と OpenCode の `prompt_async` の POST へ広げる。見つかった所は、同じ関数の中で `fenceGate(` を呼んでいること（`opencode.ts:449`・`opencode-v2.ts:284`・`submit-verified-sender.ts:280`・`client.ts:584`）。門の無い新しい所は赤 |
| G3 | 静的（入口） | `runWithSendTicket(` を呼ぶ所の一覧を固定する（route・relay の配送・`sendUserMessage`）。送信器（`sendUserMessage`・`ICLITool.sendMessage(WithImage)`・`sendModelCommand`）を production から呼ぶ所は、入口の中か、入口の範囲の中から呼ばれる関数であること（`pane-key-writers` の caller の台帳と同じ作り） |
| G4 | 静的（試験の作り） | 段 2 の柵の試験のファイルは、`terminal-fence`・`tmux`・`instance-input-lock`・`submit-verified-sender`・`composer-clear`・`send-user-message`・各ツールのモジュールを `vi.mock` しないこと（受入条件「柵を含むモジュールを mock しない」） |
| G5 | 陽性の対照 | G1〜G3 は、`os.tmpdir()` 配下に `fs.mkdtempSync` で作った写し（門を外した関数、門の無い `execFile('tmux', ['send-keys', …])`）を走査して赤になること。`afterEach` で消す |

---

## 6. 試験の一覧（段 2 で先に書く赤）

共通: 柵を含むモジュールは本物。偽にするのは `child_process`（`tests/unit/guards/fake-tmux-child-process.ts`。段 2 で「呼ばれた時に試験の関数を走らせる」口を足す。既存の振る舞いは変えない）・`fetch`（OpenCode の偽のサーバー）・本物の agy の代わりの記録した画面。DB は `os.tmpdir()` の一時ディレクトリかメモリ。名簿の行を消す／tool を変える「窓」は偽の tmux の口から入れる（確認の後・最初の変更の前＝route の解決の後の最初の `capture-pane` など）。

| # | 受入条件 | 試験の名前（案）・ファイル | 形 | 直す前に赤になる理由 |
|---|---|---|---|---|
| T1 | F1 | `tests/integration/send-fence-4534.test.ts`: `F1: the roster row goes after the check, before the composer clear → no terminal change`／`… the tool changes …` | claude の名簿の行・入力欄に残り（`C-e C-u` が出る画面）。再確認の `capture-pane` で行を消す／tool を codex に | 今は名簿を読み直さないので `send-keys C-e C-u` と本文と Enter が記録され 201 |
| T2 | F2 | 同: `F2: copilot --model, the row goes before /model → no terminal change` | copilot の行・`--model`。`switchModelUnderInputLock` の idle の読みで行を消す | `/model <id>` の `send-keys` が記録される |
| T3 | F3 | 同: `F3: launch, the row goes before new-session → nothing created or typed`（claude・codex の 2 本） | セッション無し。起動の中の `has-session` で行を消す | `new-session` と起動行の `send-keys` が記録される |
| T4 | I2 | 同: `I2: the row goes after the launch line → no change after it` | 起動行の `send-keys` の後の最初の読みで行を消す | 今は止まらず、消去・本文・Enter が続く |
| T5 | F4 | 同: `F4: a fence refusal answers 409 SEND_TARGET_CHANGED, not the reservation-lost answer`（relay あり・なし）＋`… a lost reservation still answers as before` | relay を束ねた送信。片方は行を消す、片方は relay を取り消す | 今は `relay-reservation-lost`・500・code 無し（行を消す方は止まりもしない） |
| T6 | F5 | `tests/unit/cli-tools/opencode-send-fence-4534.test.ts`: `F5: the row goes before prompt_async → no POST and no keyboard fallback`（1 回目・添付の後の 2 回目） | live の偽のサーバー（`fetch` を記録）。`noteDispatchStart` の前の読みで行を消す | POST が出る。断られてもキーボードへ進む |
| T7 | I3 | `tests/unit/lib/session/terminal-fence-4534.test.ts`: `the refusal keeps its type and cause through the tool's wrap`・`InputBoundaryRefusedError keeps the hook's error as cause` | codex の `Failed to send message to Codex` の包み・confirm が投げる例外 | 今は型も `cause` も落ちる（`instance-input-lock.ts:852–858`） |
| T8 | 陽性対照（I4） | `tests/integration/send-fence-4534.test.ts`: `control: a normal send types the same sequence as before`（claude・codex・copilot `--model`・opencode の HTTP） | 宛先が変わらない。偽の tmux の記録の並びを固定する（段 2 で、直す前の develop で記録して緑を確かめてから固定する） | 直す前も緑（対照） |
| T9 | 静的・実行時 | `tests/unit/guards/terminal-fence-coverage-4534.test.ts`: G1〜G5 | §5 | 門が無いので G1・G2 が赤 |
| T10 | agy | `tests/integration/send-fence-4534.test.ts`: `agy: the row goes before the body → nothing typed` | 記録した agy の画面（既存の fixture）を偽の tmux が返す。偽の `child_process` は tmux 以外を実行しない（本物の agy・`~/.gemini` に触れない） | 本文が記録される |
| T11 | relay の配送 | `tests/unit/lib/relay/relay-delivery-fence-4534.test.ts`: `the requester's tool changes after the claim → nothing typed, the payload goes back` | strict で解決した後・最初の変更の前に tool を変える | 今は解決した後に読み直さず打つ |
| T12 | 範囲 | `tests/unit/lib/session/terminal-fence-4534.test.ts`: `a poller started inside a send is not refused after the send closed`・`two sends to two sessions are fenced by their own tickets` | 送信の中で `setTimeout` した変更・並行の 2 要求 | 直す前は門が無く緑（対照）。段 2 の誤った実装（`closed` を断る）を赤にする |
| M1 | 変異 | T1 を、門を「`inputStarted` の後だけ効く」形（＝柵を消去の後に戻す）にして走らせる | 段 2 で一時的に変え、元に戻す | T1・T2・T3 が赤になること（返しに exit を書く） |
| M2 | 変異 | `clearComposerLine` の門を外す | 同上 | T1 と G1 が赤 |

---

## 7. agy

- 柵は agy の送信器にも効く: agy の本文・Enter・起動・trust の答えは、どれも E4・E5・E10・E12〜E14 の `tmux.ts` の関数を通る（`antigravity.ts:497`・`:570–574`・`:676–682`・`:773`）。agy の独自の `execFile`（`antigravity.ts:270`）は版の読みでペインを変えない
- 本文の前の役の確かめ（`beforeBody`、#4385）は今のまま。門はその後の `sendKeys`／`paste-buffer` の前に確かめる
- 試験は T10 の偽の tmux と記録した画面だけ。本物の agy・antigravity・`~/.gemini` には触れない（`--version` も）。偽の `child_process` は tmux 以外のコマンドを走らせない（`fake-tmux-child-process.ts` の既存の作り）

---

## 8. 範囲の外と境界

### 8.1 範囲の外

| もの | 行き先 |
|---|---|
| exact の宛先の指定そのもの（CLI の `--instance-id`、CLI が名簿を読む） | #4518（この柵の上に載る） |
| 送信の結果の 3 値と再試行の規則（unknown から送り直さない、OpenCode の unknown の後のキーボード） | #4535。この柵は「断った後は変更しない」だけを足し、unknown の後の再試行の規則は変えない |
| agy の読み戻しの判定 | #4503 PR-B1 |
| send-operation の S0〜S4 | #4466 PR1b。S3 の h-S3 はこの柵が実現する。#4466 PR1b は #4534 のマージの後に載せる |
| T6（`GET /api/worktrees/:id` の `agentInstances` が名簿が空のとき主インスタンスを合成し、実在の行と区別できない） | 範囲の外。CLI が名簿を読むときの話で、サーバーの柵の札は DB の行を直に読む（`resolveSessionTargetStrict`）。#4518 |
| T8（`ask --instance` が宛先を解き直す） | 範囲の外。CLI の側の解決。#4518 |
| T10（完了・ダイアログの通知を worktree と ID だけで relay に結ぶ） | 範囲の外。送信の後の観測の話で、端末の変更ではない。#4538（relay の行に `toTool`） |
| #4484 の画面の選択（容器の作り直しで選択が先頭に戻る ほか） | 範囲の外（画面の宛先の表示）。サーバーへ届いた送信は、この柵で宛先の変化を断る |
| 送信以外の書き手（§1.3）を札に載せる | 別の Issue（案 3）。§9 U1 |
| 送信の前の別ルートの書き込み（`--auto-yes`・`--contract`・`--role`／`--register`）、会話 ID の忘却 | #4466（S2/S3）。端末の変更ではない |

### 8.2 #4535・#4518・#4503 PR-B1 との境界

| 境 | この Issue | 相手 |
|---|---|---|
| #4535 | 門が断った試行の state（`not-sent`／`indeterminate`）と reason（`target-changed`）を決める | 3 値の名前・応答の形・再送の規則。#4535 は `target-changed` を `not_sent`（証明つき）として扱える（`inputStarted` が false のとき） |
| #4518 | サーバーの札と門。`target` の比べ方（§2.2） | CLI が exact の ID を送る形。#4518 の `EXACT_TARGET_MISMATCH` は、この札の `reason` を exact の要求の答えに写す形で載る（code を別にするかは #4518 で決める） |
| #4503 PR-B1 | agy の送信器の変更の前に門 | 読み戻しの判定（送れたか） |

### 8.3 段 2 で触るファイルの見込み（scope の候補）

- 新: `src/lib/session/terminal-fence.ts`
- `src/lib/tmux/tmux.ts`（門）、`src/lib/cli-tools/submit-verified-sender.ts`（`paste-buffer` の門）、`src/lib/cli-tools/opencode.ts`・`opencode-v2.ts`（`resize-window` の門、飲み込む catch の投げ直し）、`src/lib/hooks/sources/opencode/client.ts`（POST の門）
- `src/lib/session/instance-input-lock.ts`（R4、`noteInputStart`・`noteDispatchStart` の `fenceConfirm`・`inputStarted`）、`src/lib/session/send-user-message.ts`（R2・R3・R5）、`src/lib/session/send-attempt-types.ts`（reason）、`src/lib/relay/relay-bind.ts`（R5）、`src/lib/relay/relay-delivery.ts`（札）
- `src/app/api/worktrees/[id]/send/route.ts`・`send-failure.ts`（札・C1）
- `src/cli/types/index.ts`・`src/cli/utils/api-client-errors.ts`（C3。了承の後）、`docs/user-guide/cli-operations-guide.md` と英語版（C6）、`docs/module-reference.md` の断片
- 試験: §6 の新しいファイル、`tests/unit/guards/fake-tmux-child-process.ts`（口を足すだけ）

---

## 9. 未決（開発リーダー・PM が決めること）

| # | 問い | 勧め |
|---|---|---|
| U1 | I1 の「札の無い変更は通さない」を、送信の要求の中の変更（§1.1）に対する門＋入口の台帳（G3）で満たし、送信以外の書き手（§1.3）は今の台帳（増やさない）のままとする読みでよいか | よい。全ての書き手に札を配る案 3 は別の Issue |
| U2 | 公開の契約 C1（409 `SEND_TARGET_CHANGED` の形と `reason` の 4 値）・C2（`lastSend.reason`） | この形で人へ伺う |
| U3 | 公開の契約 C3（CLI の新しい exit 34）。足さずに 99 のままにするか | 34 を足す |
| U4 | timer を `literal` の札にする（名簿を読み直さない＝今と同じ）でよいか。名簿で確かめる形にすると、名簿の行の無い timer の送信が断られうる | `literal` |
| U5 | 札の比べ方（§2.2）: 行の作り直しを一致、`roster` 以外から `roster` へ（同じ tool）を一致、`roster` から外れたら不一致 | この表で |
| U6 | 札の条件に relay の予約の保持（読みだけ）を入れ、最初の変更の前の喪失で変更 0 にするか（今は本文の直前まで気づかず、消去・`/model`・起動は走る） | 入れる（応答は今の予約の喪失のまま、R6） |
| U7 | 送信の中の `kill-session`（E19）と失敗の後の後始末（E15）も門の対象にするか。断ると、作りかけのペインや入力欄の残りが残る | 対象にする（宛先の変わった要求は何も変えない）。残りは次の送信の消去が拾う |
| U8 | #4466 PR1b（send-operation）と #4518 を、この柵のマージの後に載せる順でよいか | よい（どちらも S3／打鍵の直前の確認をこの門に任せる） |
