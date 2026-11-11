# 送信の直前にペインの前面のプロセスを確かめる（Issue #4300）設計

- 段: 設計（この文書だけ）。実装は PM の確認と事前レビューの後、同じブランチの別の契約で行う
- 基準: develop `ed9b89eac`。行番号はこの時点のもの。「事実」は file:line、「見立て」「未確認」は明記する

## 0. 止める点

なし。実装の段で触るのは送信経路（`src/lib/tmux`・`src/lib/session`・`src/lib/cli-tools` の送信前の判定・送信の API）とそのテストで収まる見込み。`src/lib/handoff`・`src/components/mem`・`src/hooks/useWorktreeDetailController.ts` には触らない。
例外の候補は 1 つ: `src/lib/prompt-answer-sender.ts`（`respond`・auto-yes の回答経路。§3.2）。書いてよい範囲の外なので、この Issue の実装の段では触らず、§3.2 の判断を PM に伺う。

## 1. 今の経路と、claude だけがシェルへ打ち込む理由

### 1.1 経路（事実）

`commandmate send` → `postMessage`（`src/cli/commands/message-dispatch.ts:188`、`POST /api/worktrees/:id/send`）→ ルートが所有権を確かめ（`src/app/api/worktrees/[id]/send/route.ts:228`）、`settleSessionLaunch` の後に `cliTool.isRunning()` を読み（同 `:304-308`）、false なら `startSessionForSend`（同 `:327`、これが既存の「自動の再起動」）→ `sendUserMessage`（同 `:380`）。
`sendUserMessage`（`src/lib/session/send-user-message.ts:319`）は所有権（`:409`）→ プロンプトの guard（`:447`）→ `cliTool.sendMessage`（`:661`/`:681`）。各 driver は自分の準備待ちの後、全員が `sendMessageWithSubmitVerification`（`src/lib/cli-tools/submit-verified-sender.ts:688`）に入る（claude は `src/lib/session-key-sender.ts:126` 経由、ほかは `codex.ts:1033`・`command-code.ts:426`・`copilot.ts:993`・`antigravity.ts:581`・`opencode.ts:934`・`opencode-v2.ts:391`・`gemini.ts:341`・`vibe-local.ts:202`）。
入力ロックの中（`sendUnderInputLock`, `:701`）で: 再読（`recheckComposerBeforeInput`, `:727`。実体は `src/lib/session/composer-clear.ts:263`）→ 準備の再確認（`awaitReadyUnderLock`, `:735`）→ 入力欄を空ける（#1880, `:739`）→ 本文（長文は paste と到達確認 #2464、短文は `sendKeys(..., {literal:true})` `:781`）→ Enter → 読み戻し。

### 1.2 送信前の判定がどこにあるか（事実）

| 判定 | 場所 | 前面のプロセスを見るか |
|---|---|---|
| `isRunning`（ルートの再起動判断） | claude: `isClaudeRunning` = `hasSession` + 画面の liveness（`src/lib/session/claude-session.ts:802`）。ほか全員: `hasSession` だけ（`src/lib/cli-tools/base.ts:231`、opencode-v2 も `opencode-v2.ts:221`） | 見ない |
| 準備待ち（prompt-not-ready） | claude: `CLAUDE_PROMPT_PATTERN` を末尾 50 行**全体**に当てる（`session-key-sender.ts:71`,`:114`）。ほかは各 driver の `readiness`／待ち（例 `command-code.ts:402`、`antigravity.ts:537`、`opencode.ts:940`） | 見ない |
| 入力欄の残り（composer-not-empty） | `clearComposerBeforeSend`（`submit-verified-sender.ts:615`、claude・codex のみ参加） | 見ない |
| 到達確認（#2464） | `confirmPasteLanded`（`:415`）／codex の `confirmTypedBodyLanded`（`:517`） | 見ない |

送信経路で前面のプロセスを見ている所は無い。既にある先例は起動待ちの `hasReturnedToShell`（`claude-session.ts:458`、#3089）、strict respond の `agentExitedToShell`（`src/lib/prompt-observation/strict-respond.ts:317`）、契約の注意（`src/app/api/worktrees/[id]/tasks/contract-role-warning.ts:28`）で、どれも `#{pane_current_command}`（`src/lib/tmux/tmux.ts:309`）をシェル名の表（`src/lib/detection/shared/shell-pane-command.ts:2`）と照らす。

### 1.3 claude だけが打ち込む理由（事実＋実測）

claude は終了時に最後の画面（入力欄の `❯ ` 行と罫線）を残し、その下に `Resume this session with:`・`claude --resume <id>`・シェルのプロンプトを出す（UAT の `r-restart-compare.txt`）。

1. `CLAUDE_PROMPT_PATTERN = /^[>❯](\s*$|\s+\S)/m`（`src/lib/detection/tools/claude/patterns.ts:166`）が、残った `❯ ` 行に当たる。
2. claude の liveness は `aliveTailLines: null`（`src/lib/cli-tools/liveness-spec.ts:167-168`）で、画面全体に alive の型を当てる。この判定はシェルのプロンプトの判定より先に走る（`src/lib/detection/tool-liveness.ts:249-253`）。なので `isClaudeRunning` は true になり、再起動しない。
3. 準備待ちも同じ型を末尾 50 行全体に当てるので通る（`session-key-sender.ts:114`）。
4. （見立て）claude の入力欄の読み取りはシェルの行を入力欄と読まないので #1880 の空けも通り、Enter の後は「本文が入力欄に無い」ので `submitted` になる → exit 0・`Message sent.`（実測の結果は Issue の再現どおり）。

codex・command-code が断ったのは規則が働いたからではない。codex は入力欄の読み取りが `› zsh: terminated …` の行を入力欄の文字と読んで composer-not-empty になり（`d1-codex-restart.txt`）、command-code は準備待ちが時間切れになった。どちらも画面の見え方しだいの偶然で、表示が変われば打ち込みうる（見立て）。

## 2. どこで前面のプロセスを確かめるか

### 2.1 案の比較

| 案 | 何を見るか | ラッパー経由の起動 | 弱点 |
|---|---|---|---|
| A `pane_current_command` がシェル名 | 端末の前面のプロセスグループの名前 | **`exec` しないシェルスクリプトのラッパーは `bash` と出る**（下の実測）→ 動いている CLI を「終わった」と誤る | 名前だけでは区別できない |
| B `pane_pid` の子プロセス | ペインのシェルに子がいるか | 子の有無だけで、前面かどうかは分からない（バックグラウンドのジョブ、Ctrl-Z で止まった CLI を「動いている」と誤る） | プロセス木をたどる費用 |
| C 画面の入力欄の検出 | 末尾の画面 | 影響なし | 今回の不具合そのもの。スクロールに残った入力欄で誤る |
| **D（採用）A ＋ 端末の所有者** | `pane_current_command` がシェル名 **かつ** `ps -o tpgid= -p <pane_pid>` が `pane_pid` と一致 | ラッパーは別のプロセスグループで前面に立つので tpgid ≠ pane_pid → 「シェルではない」と正しく読む | `ps` を 1 回呼ぶ。ただし名前がシェルのときだけ |

採用は D。「前面がシェル」と言うのは、tmux が前面の名前をシェルと言い、**かつ** ペインの最初のシェル（`pane_pid`）自身が端末の前面のプロセスグループである場合だけ。CommandMate のペインはログインシェルを起動し、そこへ起動行を打つので（`tmux.ts:478-487` と `new-window -k`、`src/lib/cli-tools/launch-keys.ts:39`）、`pane_pid` はそのシェルで、CLI はその子として別のプロセスグループで前面に立つ。

- ラッパー: `node`・`npx`・`exec` するスクリプトは名前がシェルにならない。`exec` しないスクリプトは名前が `bash` だが tpgid ≠ pane_pid で救われる（実測は §7）。
- 起動直後: 起動行を打つ前のペインは前面がシェルで、規則は「終わった」と読む。それで正しい（打ち込めば起動行と混ざる）。起動中の扱いは既存のまま（ルートの `settleSessionLaunch`、状態の `getSessionStartingSince`（`src/lib/session/worktree-status-helper.ts:865`）が先に効く）。起動の打鍵（`typeLaunchLines`）はこの規則を通らない（通してはいけない）。
- CommandMate による再起動の途中: 再起動は起動中の印（`session-launch-flight`）の下で走るので、送信はそれを待つか session-starting で断る（既存の流れ）。待った後に D を読むので、新しい CLI が前面に立った後でしか打たない。
- 読めないとき（tmux・`ps` が失敗、名前が空）: **D は「シェルだ」という確かな証拠があるときだけ断る**。読めないことを理由に断らない。画面の読み取りに失敗すれば既存の `recheck-failed`（`composer-clear.ts:269-275`）で断るので、tmux が生きていて `display-message` だけが失敗する場合だけが残る（見立て: まれ）。こうしておくと、tmux を部分的に mock する既存のテストの期待が変わらない。

### 2.2 置き場所

- 判定の本体: `src/lib/tmux/` に `readPaneForeground(sessionName): Promise<'shell' | 'other' | 'unknown'>` を置く。`display-message -p '#{pane_current_command}\t#{pane_pid}'` を 1 回読み、名前がシェルのときだけ `ps -o tpgid= -p <pid>` を呼ぶ。シェル名の表は `isShellPaneCommand` を使い、新しく作らない。
- 状態（§5）用の一括版: `listSessions` の `-F`（`tmux.ts:341`）に `#{pane_current_command}` と `#{pane_pid}` を足す。`list-sessions` の書式は、そのセッションの今のペインのこの 2 つを返す（§7 で実測）。`ps` はシェル名のセッションだけをまとめて 1 回呼ぶ。普段（全部の CLI が動いている）は exec が増えない。

## 3. 全 CLI に同じ規則を効かせる

### 3.1 共通の 1 か所で強制する

強制する点は `recheckComposerBeforeInput`（`composer-clear.ts:263`）。ここは入力ロックの中、本文の最初のキーの前に**全 CLI が必ず通る**（§1.1 の 9 driver すべての `sendMessageWithSubmitVerification`、それと copilot の `/model` の前 `copilot.ts:1115` と選択肢の送信 `:942`）。`copilot.ts:379` の `rethrowIfDialogOpen` はダイアログ以外の失敗を握りつぶして呼び手自身の拒否に任せるので、新しいコードが握りつぶされても打たない側に倒れる（見立て。実装の段でテストで確かめる）。ここで `readPaneForeground` が `'shell'` なら、コード `AGENT_NOT_IN_FOREGROUND_CODE` つきの Error を投げる。`clearComposerBeforeSend`・paste・`sendKeys` のどれよりも前なので、send-keys は 1 バイトも出ない。

driver ごとの表で固定する案は採らない。driver が 9 つあり、新しい driver が表の行を足し忘れれば素通りになる。共通の点なら、新しい driver も `sendMessageWithSubmitVerification` を使う限り自動で入る（使わない driver は §3.3 のガードで止める）。

早い拒否（任意、推奨）: `sendUserMessage` の所有権の確認の直後（`send-user-message.ts:409` の後、プロンプトの guard の前）でも同じ判定を 1 回読み、`'shell'` なら同じ理由で断る。これが無いと command-code などは準備待ち（数秒〜10 秒）が先に時間切れになり、理由が `prompt-not-ready` と出る。強制はあくまでロックの中の 1 か所で、こちらは理由を正しく早く出すためのもの。

### 3.2 送信の入口の一覧（`git grep` で sendKeys・sendSpecialKeys・`sendMessage(`・`sendUserMessage(` を拾ったもの）

| 入口 | 経路 | 規則を通るか |
|---|---|---|
| `send`・`ask`（CLI）、`send --contract` | `POST /send`（`message-dispatch.ts:188`。契約は `/tasks` に記録してから同じ `/send`、`src/cli/commands/send.ts:323`） | 通る（§3.1） |
| UI の送信（PC・スマホ・SessionTile） | `worktreeApi.sendMessage` → `POST /send`（`src/components/worktree/MessageInput.tsx:439` ほか） | 通る |
| タイマー | `sendUserMessage`（`src/lib/timer-manager.ts:110`） | 通る |
| relay の配送 | `sendUserMessage`（`src/lib/relay/relay-delivery.ts:611`） | 通る |
| `POST /terminal`（呼び手なし、公開のまま） | `cliTool.sendMessage`（`src/app/api/worktrees/[id]/terminal/route.ts:220`） | 通る（driver 経由） |
| copilot の `/model` | `sendModelCommand` → `recheckComposerBeforeInput` | 通る |
| `respond`・`prompt-response`・auto-yes | `src/lib/prompt-answer-sender.ts`（数字・y・矢印、自由記述の答え） | **通らない**。プロンプトが検出されたときだけ打つ。検出が古い画面のダイアログに当たれば打ちうる（未確認）。書いてよい範囲の外なので、この Issue では直さず、同じ判定を回答の最初のキーの前に置く別 Issue を PM に提案する |
| `direct-input`・`special-keys`・`clear-composer`・`interrupt` | ターミナル画面の生のキー入力と操作キー | 対象外。人がペインを見ながら打つ生の入力で、シェルへ打つのも利用者の操作 |
| 起動行・信頼ダイアログ・自動既定の案内への答え | `launch-keys.ts`・`claude-session.ts` ほか | 対象外（起動の打鍵は前面がシェルで正しい） |
| スケジュール | `claude -p` を別プロセスで実行（`src/lib/session/claude-executor.ts:18`、execFile） | tmux に打たないので無関係 |
| `reply` | 台帳を読むだけ（`src/cli/commands/reply.ts:42`） | 無関係 |

### 3.3 全部が通ることを固定する方法

1. 表駆動の振る舞いテスト（§6）: `CLI_TOOL_IDS` の全員について、前面がシェルのペインへの送信で send-keys・paste が 0 回。表を `CLI_TOOL_IDS` から作るので、新しい CLI は自動で行に入る。
2. ガード（`tests/unit/guards/send-foreground-gate-4300.test.ts`）: `src/lib/cli-tools/*.ts` の各 driver の `sendMessage` 系が、本文を打つ前に `sendMessageWithSubmitVerification` か `recheckComposerBeforeInput` を通ることを静的に固定する。`src/lib` で `sendKeys(`／`sendSpecialKeys(`／`paste-buffer` を呼ぶファイルを許可リスト（ファイルと理由: 起動・ダイアログへの答え・ロックの中・生の入力）に固定し、新しく打つ場所ができたら見直しを強いる。

## 4. 未送信のときの exit code と理由

- `SendAttemptReason` に `'agent-not-in-foreground'` を足す（`src/lib/session/send-attempt-types.ts:26`）。`classifySendFailure` はコードで読む（文面で読まない。`send-attempt-state.ts` の `PASTE_NOT_STARTED_CODE` と同じやり方。本文の文字が理由を偽れないように）。
- 送信ルートの答えは既存の失敗と同じ 500 と `sendOutcome: 'not_sent'`（`src/app/api/worktrees/[id]/send/send-failure.ts:120-123`）。CLI は exit 99 と `Note: the message was not sent (sendOutcome=not_sent)`（`message-dispatch.ts:156-158`）。codex・command-code が今出している形とそろう。新しい exit 番号は作らない（呼び手は既に 99 と `not_sent` で分岐している）。
- エラー文: `The agent in session <name> is not running (the pane is back at its shell: <cmd>); nothing was typed (Issue #4300).` に続けて既存の `[send state: not-sent (agent-not-in-foreground): …]`。復旧の案内は「`commandmate stop` してから送り直す（新しい会話で起動する）」。
- 自動の再起動: 既存のものは claude だけにある（`isRunning` が false → `startSessionForSend` → `startClaudeSession` が不健康なセッションを kill して作り直し、入力欄の準備を待つ、`claude-session.ts:877-893`）。§5 で claude の `isRunning` が終わったペインを false と読むようになると、claude の send はこの既存の流れで**作り直してから送る**。入力欄の準備（`startClaudeSession` の `CLAUDE_PROMPT_PATTERN` 待ち）と、ロックの中の D の両方を通らなければ未送信。ほかの CLI には自動の再起動は無く（`isRunning` = `hasSession`）、この Issue でも足さない。断るだけ。
- PM に確認したい点: claude の作り直しは**前の会話を引き継がない**新しいセッションになる（`--resume` しない）。今も、クラッシュして画面からも終わったと分かる claude には同じことが起きている。送り手から見えるように、送信の答えに「作り直した」ことを足すか（`relaunched: true` と CLI の stderr の 1 行）を決めてほしい。推奨は「足す」。

## 5. `capture --json` の `isRunning`・`sessionStatus`

- 状態の poll は全ツールで `probeToolSessionLiveness` を使う（`worktree-status-helper.ts:866-872`）。D をこの probe の**前**に置く: `'shell'` なら `isRunning=false`、理由は `agent process exited (pane foreground: zsh)`。`sessionStatusReason` は既存の `exited`（同 `:808`）。`'other'`・`'unknown'` なら今の画面の判定のまま。起動中（`startingSince`）は今どおり probe を飛ばす。
- claude の画面の型（`aliveTailLines: null`）は変えない。終わったペインを見分けるのは D の役目にし、画面の判定の幅は動かさない（#2070・#3191 で固定した判定を崩さない）。
- 読み手への影響:
  - `wait`: 一度「動いている」を見た後に `isRunning=false` になると `Completed (basis=session_gone)` で exit 0（`src/cli/commands/wait.ts:640-645`）。claude が途中で落ちたとき、今は時間切れまで待つが、変更後は完了として返る。ほかの CLI は #2070 から既にこの動き。`--verify` を付ければ作業証跡で判定されるので、偽の合格にはならない（exit 20/21）。この変化は changelog に書く。
  - UI: 終わったペインのセッションが「停止」と出る（今は claude だけ「動いている」と出ていた）。
  - 応答の poll・auto-yes: `isRunning=false` で止まる側の動きは既存（ほかの CLI と同じ）。auto-yes が終わったペインに答えを打たなくなるのは良い方向。
  - claude の `isRunning`（`isClaudeRunning`）も D を通すので、送信ルートの判断と `capture` の表示が一致する。

## 6. テストの設計

- 単体（`tests/unit/tmux/pane-foreground-4300.test.ts`）: `readPaneForeground` を `execFile` の mock で。zsh かつ tpgid=pane_pid → `'shell'`／`bash` かつ tpgid≠pane_pid（`exec` しないラッパー）→ `'other'`／`node`・版の文字列 `2.1.287` → `'other'`（`ps` を呼ばない）／`-zsh` → シェル扱い／display-message の失敗・空 → `'unknown'`／`ps` の失敗 → `'unknown'`。
- 表駆動（`tests/unit/cli-tools/send-foreground-gate-4300.test.ts`）: `CLI_TOOL_IDS` の全員（claude・codex・command-code・copilot・antigravity・opencode・opencode-v2・gemini・vibe-local）について、tmux の mock が前面 `zsh`・tpgid=pane_pid・画面は UAT の終了画面（`❯ ` 行＋`Resume this session with:`＋シェルのプロンプト。fixture として固定）を返す。期待: send-keys と paste-buffer と load-buffer が 0 回、`classifySendFailure` が `{state:'not-sent', reason:'agent-not-in-foreground'}`。
  - 陽性の対照: 同じ表で `readPaneForeground` だけを `'other'` に差し替えると、少なくとも claude の行で send-keys が 1 回以上になる（＝確認を外すと落ちる）ことを同じファイルで示す。
  - 陰性の対照: 前面 `node`（tpgid≠pane_pid）・通常の入力欄の画面では、今までどおり送る。
- 到達確認（#2464）: 既存の paste・到達確認のテストは**期待を変えない**。D は `'unknown'` で断らないので、tmux を部分的に mock した既存のテストは新しい呼び出しが例外になっても今の結果のまま（実装の段で `tests/unit/cli-tools/submit-verified-sender*.test.ts` を変えずに通すことを確かめる）。もし display-message の回数を数えているテストが落ちたら、期待を変えずに報告する。
- 状態: `worktree-status-helper` に 1 本。前面がシェルなら `isRunning=false`・`sessionStatusReason='exited'`、`startingSince` があるときは probe しない。
- 送信ルート: claude で `isRunning=false` → `startSessionForSend` が呼ばれる（既存の流れ）、作り直しの後に送る。ほかの CLI は 500＋`sendOutcome:'not_sent'`。
- ガード: §3.3 の 2。

## 7. 実機で決まること（隔離した tmux で確かめた）

手順: `mktemp -d "$TMPDIR/c4300.XXXX"` の中にソケットと仮の HOME を作り、`env -i HOME=<仮> tmux -S <dir>/s -f /dev/null new-session -d -s p "env -i HOME=<仮> PATH=$PATH zsh -f -i"`。`send-keys` で各コマンドを前面に出し、`display-message -p '#{pane_current_command}'`・`'#{pane_pid}'`・`ps -o tpgid= -p <pane_pid>` を読む。最後に `kill-server` して dir を消す。本番のサーバー・本番の tmux セッションには触れていない。

結果（2026-11-10、tmux 3.5a、macOS）:

| 前面 | pane_current_command | tpgid = pane_pid | D の判定 |
|---|---|---|---|
| 何も動いていないシェル | `zsh` | はい | shell |
| `sleep`（ネイティブの子） | `sleep` | いいえ | other |
| `node -e …` | `node` | いいえ | other |
| `npx --no-install node -e …` | `node` | いいえ | other |
| `exec` しない bash のラッパー → sleep | **`bash`** | いいえ | other（A だけなら誤って shell） |
| `exec` する bash のラッパー → sleep | `sleep` | いいえ | other |
| 子が終わった後 | `zsh` | はい | shell |

`list-sessions -F '#{session_name} #{pane_current_command} #{pane_pid}'` はセッションごとに今のペインの値を返し、`ps -o pid=,tpgid= -p <pid1>,<pid2>` で一括に読めた（§2.2 の一括版の根拠）。

未確認（実装の段か UAT で確かめる）: 本物の claude（ネイティブ版）・codex・command-code・copilot・antigravity・opencode が前面にいるときの `pane_current_command`。#3089 の記録では claude は `claude`・`node`・版の文字列（`shell-pane-command.ts:4-8`）。D はシェル名でない限り `'other'` なので、値そのものに依存しない。Linux の `ps -o tpgid=` は procps にある（見立て、未実測）。

## 8. 実装の段の範囲（予定）

`src/lib/tmux/`（`readPaneForeground`・`listSessions` の書式）、`src/lib/session/composer-clear.ts`（強制点）、`src/lib/session/send-user-message.ts`（早い拒否）、`src/lib/session/send-attempt-types.ts`・`send-attempt-state.ts`（理由）、`src/lib/cli-tools/session-liveness.ts`・`src/lib/session/claude-session.ts`（`isRunning` と状態）、`src/lib/session/worktree-status-helper.ts`、テストとガード、`changelog.d/4300.md`（`### Fixed`）、module-reference の断片。
