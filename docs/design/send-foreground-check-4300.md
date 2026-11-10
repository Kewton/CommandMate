# 送信の直前にペインの前面のプロセスを確かめる（Issue #4300）設計

- 段: 設計（この文書だけ）。改訂 1（2026-11-10）: 事前レビュー（codex-2、P1 4・P2 6）と PM の決定（PR2 の (i)〜(v)、設計の (a)〜(e)）を反映した。指摘ごとの処置は §11
- 基準: develop `e7055f994`（コードは `ed9b89eac` と同じ）。行番号はこの時点のもの。「事実」は file:line、「見立て」「未確認」は明記する
- 実装は 2 段: **PR1**（確かな証拠のときだけ止める小さな直し。別の worktree で実装中。この文書は書かない）、**PR2**（この文書の本体。PR1 のマージ後、develop から別の契約で）

## 0. PR1 との関係と止める点

### 0.1 PR1 が入れるもの（PR2 の土台）

| PR1 が入れるもの | 中身 | PR2 で変えること |
|---|---|---|
| `readPaneForeground(sessionName): Promise<'shell' \| 'other' \| 'unknown'>`（`src/lib/tmux/tmux.ts`） | 案 D（§2.1）。`display-message` で `#{pane_current_command}\t#{pane_pid}`、名前がシェルのときだけ `ps -o tpgid= -p <pane_pid>` | **判定を案 E に置き換える**（§2）。返り値を寿命の種類（`agent`・`exited`・`suspended`・`background`・`subshell`・`absent`・`unknown`）にし、`readAgentLifecycle` として 1 か所に置く。PR1 の関数は E の薄い互換（`shell` = exited/suspended/background）として残すか、呼び手を全部移して消す（実装の段で呼び手が 0 なら消す） |
| `recheckComposerBeforeInput`（`src/lib/session/composer-clear.ts:263`）の 1 か所で `'shell'` なら `AGENT_NOT_IN_FOREGROUND_CODE` を投げる | 全 driver が本文の最初のキーの前に通る点 | 1 か所ではなく**打鍵の各段の直前**に同じ判定（§3.1）。`unknown` も断る（§3.2）。一時停止・background は別の理由（§3.3） |
| `sendUserMessage` の早い拒否（`src/lib/session/send-user-message.ts`、所有権の確認の後） | 同じ判定を 1 回 | 早い拒否は「既存の復旧を通す入口」では復旧の後に置く（§4.2）。G-PR3 との重なりは §8.2 |
| `SendAttemptReason` に `'agent-not-in-foreground'`、`AGENT_NOT_IN_FOREGROUND_CODE`（`src/lib/session/send-attempt-types.ts`）、`classifySendFailure` がコードで読む（`send-attempt-state.ts`） | 500＋`sendOutcome:'not_sent'`→ exit 99 | 理由を 3 つ足す（§6）: `agent-suspended`・`agent-foreground-unknown`、それと本文の後の失敗用の `agent-left-mid-send`（indeterminate） |
| 表駆動テスト（`CLI_TOOL_IDS` の全員）と各 CLI の陽性対照 | 前面がシェルの画面で send-keys／paste が 0 回、確認を外すと各 CLI で送信が起きる | 同じ表に E の種類の行を足す（§7） |

PR1 は capture・wait・一覧・kill-session の判定、relaunch、作り直しの表示を変えない。それは全部 PR2。

### 0.2 止める点

- PR2 は送信経路（`src/lib/tmux`・`src/lib/session`・`src/lib/cli-tools`・送信と停止の API）と状態の読み手（`current-output-builder.ts`・`worktree-status-helper.ts`・`session-cleanup.ts`）、CLI の表示（`message-dispatch.ts`）とテストで収まる。`src/lib/handoff`・`src/components/mem`・`src/hooks/useWorktreeDetailController.ts` には触らない。
- `src/lib/prompt-answer-sender.ts`（`respond`・auto-yes の回答経路）は**この Issue では直さない**（PM の決定 (c)）。残りとして §10 に書く。
- PR2 は大きいので 2 本に分ける案を §8.3 に置く（推奨）。

## 1. 今の経路と、claude だけがシェルへ打ち込む理由

### 1.1 経路（事実）

`commandmate send` → `postMessage`（`src/cli/commands/message-dispatch.ts:188`、`POST /api/worktrees/:id/send`）→ ルートが所有権を確かめ（`src/app/api/worktrees/[id]/send/route.ts:228`）、`settleSessionLaunch` の後に `cliTool.isRunning()` を読み（同 `:304-308`）、false なら `startSessionForSend`（同 `:327`、`send-session-start.ts:93`）→ `sendUserMessage`（同 `:380`）。
`sendUserMessage`（`src/lib/session/send-user-message.ts:319`）は所有権（`:409`）→ プロンプトの guard（`:447`）→ `cliTool.sendMessage`（`:661`/`:681`、画像は `sendMessageWithImage` `:655`）。
claude 以外の driver は送る前に `requireSession(..., { relaunch: true })`（`src/lib/cli-tools/base.ts:814`）を通り、ツールが画面から終わったと読めれば同じペインで起動し直す（`relaunchIfToolExited`, `base.ts:780`、#2070。対照テスト `tests/unit/cli-tools/session-relaunch-2070.test.ts:156`）。`relaunch: false` は copilot の `/model`（`copilot.ts:1070`）と opencode の画像（`opencode.ts:1097`）。
その後、全員が `sendMessageWithSubmitVerification`（`src/lib/cli-tools/submit-verified-sender.ts:688`）に入る（claude は `src/lib/session-key-sender.ts:126` 経由、ほかは `codex.ts:1033`・`command-code.ts:426`・`copilot.ts:993`・`antigravity.ts:581`・`opencode.ts:934`・`opencode-v2.ts:391`・`gemini.ts:341`・`vibe-local.ts:202`）。
入力ロックの中（`sendUnderInputLock`, `:701`）で: 再読（`recheckComposerBeforeInput`, `:727`）→ 準備の再確認（`awaitReadyUnderLock`, `submit-verified-sender-lock.ts:73`）→ 入力欄を空ける（#1880, `:630`）→ 本文（長文は `load-buffer`→`paste-buffer` と到達確認 #2464 `:248-262`、短文は `sendKeys(..., {literal:true})` `:775-781`）→ Enter（`:808`）→ 読み戻し → 未確定なら Enter の再送（`:911-912`）。各キーの直前に `assertInputOwner(ticket, cliToolId, step, typed)`（`submit-verified-sender-lock.ts:93`）があり、`typed` が「本文が既に打たれたか」を表す。

### 1.2 送信前の判定がどこにあるか（事実）

| 判定 | 場所 | 前面のプロセスを見るか |
|---|---|---|
| `isRunning`（ルートの再起動判断） | claude: `isClaudeRunning` = `hasSession` + 画面の健康（`src/lib/session/claude-session.ts:802`）。ほか: `hasSession` だけ（`base.ts:231`、opencode-v2 も `opencode-v2.ts:221`） | 見ない |
| driver の再起動判断 | claude: `startClaudeSession` の `ensureHealthySession`（`claude-session.ts:708`、不健康なら kill して作り直し `:884-893`）。ほか: `relaunchIfToolExited` の `isToolLive`（画面、`base.ts:716`,`:787`） | 見ない |
| 準備待ち（prompt-not-ready） | claude: `CLAUDE_PROMPT_PATTERN` を末尾 50 行全体に当てる（`session-key-sender.ts:71`,`:114`）。ほかは各 driver の待ち | 見ない |
| 入力欄の残り（composer-not-empty） | `clearComposerBeforeSend`（`submit-verified-sender.ts:615`、claude・codex のみ） | 見ない |
| 到達確認（#2464） | `confirmPasteLanded`（`:415`）／codex の `confirmTypedBodyLanded`（`:517`） | 見ない |

前面のプロセスを見ている先例は起動待ちの `hasReturnedToShell`（`claude-session.ts:458`、#3089）、strict respond の `agentExitedToShell`（`src/lib/prompt-observation/strict-respond.ts:317`）、契約の注意（`src/app/api/worktrees/[id]/tasks/contract-role-warning.ts:28`）で、どれも `#{pane_current_command}` をシェル名の表（`src/lib/detection/shared/shell-pane-command.ts:2`）と照らす。

### 1.3 claude だけが打ち込む理由（事実＋実測）

claude は終了時に最後の画面（入力欄の `❯ ` 行と罫線）を残し、その下に `Resume this session with:`・`claude --resume <id>`・シェルのプロンプトを出す（UAT の `r-restart-compare.txt`）。

1. `CLAUDE_PROMPT_PATTERN = /^[>❯](\s*$|\s+\S)/m`（`src/lib/detection/tools/claude/patterns.ts:166`）が残った `❯ ` 行に当たる。
2. claude の liveness は `aliveTailLines: null`（`src/lib/cli-tools/liveness-spec.ts:167-168`）で画面全体に alive の型を当て、シェルのプロンプトの判定より先に走る（`src/lib/detection/tool-liveness.ts:249-253`）。なので `isClaudeRunning` は true、`ensureHealthySession` も健康と読み、作り直さない。
3. 準備待ちも同じ型で通る（`session-key-sender.ts:114`）。
4. （見立て）入力欄の読み取りはシェルの行を入力欄と読まないので #1880 の空けも通り、Enter の後は「本文が入力欄に無い」ので `submitted` → exit 0・`Message sent.`。

codex・command-code が断ったのは偶然（codex は `› zsh: terminated …` を入力欄の文字と読んで composer-not-empty、command-code は準備待ちの時間切れ）。表示が変われば打ち込みうる（見立て）。

## 2. 寿命の判定（1 か所）

### 2.1 案の比較

| 案 | 送ってよいと言う条件 | 誤り（§9 の実測） |
|---|---|---|
| A `pane_current_command` がシェル名でない | 名前だけ | 非 exec のラッパー（`bash`）を「終わった」と誤る |
| B `pane_pid` の子の有無 | 子がいる | background・Ctrl-Z の子を「動いている」と誤る |
| C 画面の入力欄 | 入力欄が見える | 今回の不具合そのもの |
| D（PR1）A＋端末の所有者 | 「シェルだ」と言える証拠（名前がシェル かつ `tpgid == pane_pid`）が**無い**こと | 対話のサブシェル（`bash -i`）が入力待ちでも `tpgid ≠ pane_pid` なので `other`＝送る（§9 の d）。ジョブ制御が無効だと前面の CLI を `shell` と読む（§9 の f）。読めないと送る |
| **E（PR2 で採用）前面のグループに CLI がいる積極的な証拠** | 端末の前面のプロセスグループ（`tpgid`）に**シェル名でないプロセスがいて**、かつ `tpgid ≠ pane_pid`（ペインのシェル自身は前面にいない） | ジョブ制御が無効なシェル（前提の外）は `unknown`＝断る。サブシェルから起動した CLI は「CLI」と読む（正しい） |

採用は **E**。D は「シェルだと言えたら断る」、E は「CLI だと言えたら送る」。PM の決定 (ii)（unknown は断る）と P1-2・P1-3 の指摘に合うのは E。D は E の部分集合（D が `shell` と言う状態を E は全部断る）なので、PR1 の止め方は PR2 でも残る。

候補として「前面のプロセスの名前が、そのツールの期待する名前（`claude`・`node`・版の文字列…）に一致する」も比べたが採らない。名前は版・導入方法（npm・ネイティブ・npx・ラッパー）で変わり、新しいツールで表を足し忘れると全部断る。E はシェルでないことだけを見るので名前に依存しない。

### 2.2 E の読み方（`readAgentLifecycle`）

1 回の判定は exec 2 回:

1. `tmux display-message -p -t <exact> '#{pane_dead}\t#{pane_pid}\t#{pane_tty}\t#{pane_current_command}'`。セッションが無い・`pane_dead=1` → `absent`。失敗・形が違う → `unknown`。
2. `ps -o pid=,pgid=,tpgid=,stat=,comm= -t <pane_tty から /dev/ を除いたもの>`（§9 で macOS 実測）。`pane_pid` の行の `tpgid` を前面のグループとし、行を前面のグループ（`pgid == tpgid`）とそれ以外に分ける。`comm` は basename にし、先頭の `-` を除いて `isShellPaneCommand` に当てる（macOS の `comm` は `/bin/bash` のようにパスで出る、§9 の c）。`pane_pid` の行が無い・数字でない・列が足りない → `unknown`。

| 種類 | 条件 | 意味 |
|---|---|---|
| `agent` | `tpgid ≠ pane_pid` かつ前面のグループにシェル名でないプロセスがいる | CLI（またはそれを包むラッパー）が前面。`lease = tpgid` を返す |
| `subshell` | `tpgid ≠ pane_pid` かつ前面のグループが全部シェル | 対話のサブシェルが入力待ち。CLI は前面にいない |
| `exited` | `tpgid == pane_pid`、前面のグループがペインのシェルだけ、ほかのグループが無い | CLI は終わり、ペインはシェルのプロンプト |
| `suspended` | `tpgid == pane_pid`、ほかのグループに状態 `T` がいる | Ctrl-Z などで止まった CLI がいる |
| `background` | `tpgid == pane_pid`、ほかのグループが `T` でなく動いている | `&` などで背面にいる |
| `unknown` | 読めない、または `tpgid == pane_pid` なのに前面のグループにシェル名でないプロセスがいる（ジョブ制御が無効で、前面か背面か区別できない、§9 の f・g） | 断る |
| `absent` | セッション・ペインが無い | 既存の「セッションが無い」と同じ扱い |

`suspended` と `background` が両方いるときは `suspended`（会話を捨てない側）。

### 2.3 前提（固定する）と実測

対応する前提: **ペインのシェルが対話シェルでジョブ制御が有効**（CommandMate はログインシェルの対話シェルを起動し、そこへ起動行を打つ。`tmux.ts:478-487`、`new-window -k`、`src/lib/cli-tools/launch-keys.ts:39`）。zsh・bash の対話シェルは既定でジョブ制御が有効。前提の外（`set +m`・非対話シェルでペインを作った場合）は `unknown` で断る（送らない側に倒れる）。

| 状況 | D（PR1） | E（PR2） | 正しい扱い | 根拠 |
|---|---|---|---|---|
| 通常の起動（CLI がシェルの子で前面） | other（送る） | agent（送る） | 送る | §9 の b（macOS 実測） |
| 非 exec のラッパー（`bash` スクリプト → CLI） | other | agent（前面のグループに `bash` と子の CLI がいる） | 送る | §9 の c |
| exec するラッパー・`npx`・`node` | other | agent | 送る | 前版の実測（§9 の表 2） |
| 対話のサブシェルが入力待ち | **other（送る＝誤り）** | subshell（断る） | 断る | §9 の d |
| サブシェルから CLI を起動 | other | agent | 送る | §9 の e |
| ジョブ制御無効のシェルで CLI が前面 | **shell（断る）** | unknown（断る） | 前提の外。断る（送らない側） | §9 の f |
| ジョブ制御無効のシェルで CLI が背面、シェルが入力待ち | **shell** | unknown（断る） | 断る | §9 の g（f と ps の上で区別できない） |
| CLI が background（ジョブ制御有効） | shell（断る） | background（断る、作り直さない） | 断る・作り直さない | §9 の h |
| Ctrl-Z で止まった CLI | shell（断る） | suspended（断る、作り直さない） | 断る・作り直さない | §9 の i |
| `fg` で戻した後 | other | agent | 送る | §9 の j |
| CLI が終わった | shell | exited | 断る、または入口ごとの既存の復旧（§4） | §9 の k |
| tmux・`ps` が読めない | unknown（送る） | unknown（**断る**） | 断る（PM の決定 (ii)） | — |
| Linux（procps） | — | 同じ | 同じ | **未実測（見立て）**: tmux 3.5a の Linux は `tcgetpgrp` のグループの `/proc/<pgrp>/cmdline` を名前にする（`osdep-linux.c`）。E は `pane_current_command` を判定に使わない（`absent` の判定と表示用）ので、この差に依存しない。procps の `ps` は `pid,pgid,tpgid,stat,comm` と `-t pts/N` を受ける（man ps）。busybox の `ps` は `tpgid` を持たず `unknown` → **全部断る**。§10 の残り |

## 3. 送信の判定（打鍵の各段）

### 3.1 各段の直前に同じ判定（PM の決定 (i)）

共通の 1 関数 `assertAgentHoldsPane(lease: AgentLease | null, sessionName, step, typed)`（`src/lib/session/agent-lifecycle.ts`、新設）を、キーを出す各段の**直前**に置く:

| 段 | 場所 | `typed` |
|---|---|---|
| 再読（最初の判定。lease を作る） | `recheckComposerBeforeInput`（`composer-clear.ts:263`、PR1 の判定の置き場所） | false |
| 入力欄を空ける（#1880） | `submit-verified-sender.ts:630` | false |
| paste（`paste-buffer`。`load-buffer` は打たないので対象外） | `:262` | false |
| 本文（paste 経路・短文経路） | `:751`・`:775` | false |
| Enter | `:808` | true |
| Enter の再送 | `:911` | true |
| copilot の選択肢・`/model` | `copilot.ts:942`・`:1115`（`recheckComposerBeforeInput` を通る） | false |

- 2 段目以降は「同じ CLI が前面にいる」ことを見る: 種類が `agent` で、かつ `tpgid` が lease と同じ。CLI が終わって作り直された（別のグループが前面）場合も止まる（P1-1 の「判定後の終了・再作成」）。
- 置き方は既存の `assertInputOwner` の隣（同じ段名、同じ `typed`）。`assertInputOwner` は同期の関数なので中には入れず、`await` の 1 行を並べる。ガード（§7.4）で「`sendKeys`・`sendSpecialKeys`・`paste-buffer` の直前に両方がある」ことを固定する。
- `typed=false` の段で断れば `not-sent`（理由は §6）。`typed=true`（本文が既に打たれた後）で断れば **`indeterminate`（`agent-left-mid-send`）で、not_sent に戻さない**（Enter を打たないので、本文はシェルの行に残るが実行はされない。送り手には「本文がペインの入力行に残っている。capture で確かめる」と出す）。
- 費用: 1 回の送信で 4〜6 回 × exec 2 回（`display-message` と `ps -t`）。どれも数 ms〜十数 ms（見立て。実装の段で測り、PR の本文に書く）。
- 残る競合（受け入れる）: 判定とキーの間（exec 1 回分）に CLI が終わる場合。最後の判定から Enter までの窓は exec 1 回分に縮む。本文の後に CLI が終われば Enter を打たないので、シェルが本文を**実行する**のは「Enter の直前の判定の後、Enter が届くまでの数 ms に CLI が終わる」ときだけ。入力ロックは CLI の終了を止められないので、これ以上は縮めない。

### 3.2 `unknown` は断る（PM の決定 (ii)）

- `unknown` は `not-sent`、理由 `agent-foreground-unknown`。PR1 の「読めなければ通す」をやめる（P1-2: `ps` の起動失敗・時間切れ・書式・PID の消滅でも capture は成功し、残った `❯` を通せる）。
- 案内（エラー文の後半）: 「ペインの前面のプロセスを確かめられなかったので何も打っていない。`commandmate capture <id> --instance <x>` で CLI が入力待ちか確かめてから送り直す。毎回断られるなら、ペインのシェルのジョブ制御が有効か、ラッパーの最後で `exec <cli>` しているかを確かめる（Issue #4300 の前提）」。
- 一時的な失敗（tmux の時間切れ）で断った送信は、送り直せば通る。

### 3.3 一時停止・background・サブシェル（PM の決定 (iii)）

- `suspended`・`background` は「終了」と別の理由 `agent-suspended`（not-sent）で断り、**作り直さない・kill しない**（Ctrl-Z の会話を捨てない。P2-6）。案内: 「CLI が一時停止（または背面）している。ペインで `fg` してから送り直す」。
- `subshell` は `agent-not-in-foreground`（PR1 と同じ理由）で断り、作り直さない（サブシェルに起動行を打つことになる）。案内: 「ペインがシェルのプロンプト。`exit` でサブシェルを抜けるか、`commandmate stop` してから送り直す」。
- `exited` だけが、入口によって既存の復旧に進める（§4）。

## 4. 入口ごとの方針

### 4.1 入口の表（P2-9）

| 入口 | 経路 | `exited` のとき | `suspended`・`background`・`subshell`・`unknown` |
|---|---|---|---|
| `send`・`ask`・`send --contract`（CLI）、UI の送信（PC・スマホ・SessionTile） | `POST /send`（`message-dispatch.ts:188`、`MessageInput.tsx:439` ほか）→ ルートの `isRunning` → `startSessionForSend` | **既存の復旧**: `isRunning` が false になるので `startSessionForSend` が作り直してから送る（claude・ほかとも）。`relaunched: true`（§4.3） | 断る（not_sent）。ルートは `isRunning` の前に種類を読み、これらでは `startSessionForSend` に進まない |
| 画像つきの送信 | `sendMessageWithImage`（claude `claude.ts:121`、opencode `opencode.ts:1089`、`send-user-message.ts:655`） | `/send` と同じ（ルートが先に復旧）。opencode の画像は `relaunch:false` なので driver の中では復旧しない | 断る |
| タイマー | `sendUserMessage`（`src/lib/timer-manager.ts:110`） | 既存のまま: claude 以外は driver の `requireSession` の relaunch で復旧、claude は断る（今も claude はタイマーで起動しない） | 断る |
| relay の配送 | `sendUserMessage`（`relay-delivery.ts:611`）。前に `relay-readiness.ts:84` が `isRunning` を読む | **保留**（`session_stopped`、既存）。作り直さない。手動の send と期待が違う | `isRunning`（§5）が true の `suspended`・`background` は readiness を通り、送信の判定で not_sent → 既存の再試行 |
| `POST /terminal`（呼び手なし） | `cliTool.sendMessage`（`terminal/route.ts:220`） | タイマーと同じ（driver の既存） | 断る。404 はペインが無いときだけ（§5） |
| copilot の通常文 | `copilot.ts:919`（relaunch:true）→ `:942` → `:993` | driver の既存の relaunch | 断る |
| copilot の選択肢・`/model` | `:942`、`sendModelCommand`（`:1067`、relaunch:false）→ `:1115` | `/model` は断る（relaunch:false） | 断る |
| opencode の HTTP 配送 | `trySendViaServer`（`opencode.ts:919`）。tmux に打たない | 明示的に対象外（打たない）。前の `requireSession` で既存の relaunch | — |
| opencode の keyboard fallback | `opencode.ts:934` → 共通の送信 | 共通の判定。HTTP 配送が `unknown` になった後の拒否は既存どおり全体を `indeterminate` に保つ（`send-attempt-state.ts:317`、#4040） | 同じ |
| `respond`・`prompt-response`・auto-yes | `src/lib/prompt-answer-sender.ts` | **この Issue では直さない**（PM の決定 (c)）。§5.3・§10 | — |
| `direct-input`・`special-keys`・`clear-composer`・`interrupt`、WebSocket の `terminal_input`（`ws-server.ts:1151`） | 人がペインを見ながら打つ生のキー | 対象外（シェルへ打つのも利用者の操作） | 対象外 |
| 起動行・信頼ダイアログ・自動既定の案内への答え | `launch-keys.ts`・`claude-session.ts` ほか | 対象外（起動の打鍵は前面がシェルで正しい。判定を通してはいけない） | — |
| スケジュール | `claude -p` を別プロセス（`claude-executor.ts:18`） | 無関係 | — |
| `reply` | 台帳を読むだけ（`reply.ts:42`） | 無関係 | — |

### 4.2 既存の復旧との関係（P2-5）

- `base.ts` の `relaunchIfToolExited`（`:780`）は、`isToolLive`（画面）の前に `readAgentLifecycle` を読む: `agent` → 何もしない、`exited` → 今どおり起動し直す（その後の `launchSession` の確かめは今どおり）、`suspended`・`background`・`subshell`・`unknown` → **起動行を打たずに断る**。今は画面だけで判定するので、Ctrl-Z で止まった codex の上のシェルに起動行を打ちうる（見立て。P2-6 の非 claude 版）。
- claude の `ensureHealthySession`（`claude-session.ts:708`）も同じ: `exited` → 今どおり kill して作り直す、`agent` → 今の画面の健康の判定、それ以外 → kill せず断る。`isClaudeRunning` だけを変えても、ここが旧い画面の判定で既存のペインを再利用すれば作り直しが起きない（P2-5）。両方が同じ `readAgentLifecycle` を読む。
- `sendUserMessage` の早い拒否（PR1）は、ルート・driver の復旧の**後**に効く位置のまま（所有権の確認の後）。ルートが先に作り直していれば `agent` を読む。タイマー・relay では driver の復旧より前に早い拒否が来ると復旧を止めるので、早い拒否は `exited` では断らず（driver の復旧に任せる）、`suspended`・`background`・`subshell`・`unknown` だけを早く断る。強制はあくまで §3.1 の各段。

### 4.3 `relaunched` の成立条件（PM の決定 (a)、P2-10）

- 起動の結果を `LaunchOutcome = 'created' | 'reused' | 'replaced' | 'joined'` として、起動中の印（`session-launch-flight`）に残す。`replaced` は「入る前の種類が `exited`（claude は加えて画面の不健康）で、前のペインの CLI を置き換えた」ときだけ。
- 送信の答えの `relaunched: true` は、その送信が通った起動の結果が `replaced` のときだけ。並行の送信が同じ起動に合流した（`joined`）ときは、合流先の結果が `replaced` なら同じく true（どちらの送り手にも前の会話が無くなったことを知らせる）。
- 失敗も隠さない: 置き換えた後に準備待ち・本文の送信が失敗した答え（500、not_sent／indeterminate）にも `relaunched: true` を載せ、CLI は exit 99 などの前に stderr に 1 行: `Note: the previous <tool> session in <session> had exited; a new session was started and the previous conversation was not carried over (Issue #4300).`。
- 対照（§7.3）: 初回起動（ペイン無し）→ false／再利用（agent）→ false／置換して成功 → true／置換後に失敗 → true と not_sent・indeterminate／並行 send の 2 本 → 両方 true で、起動は 1 回。

## 5. 読み手を同じ判定にそろえる（PM の決定 (iv)、P1-4・P2-7）

### 5.1 2 つの述語

`readAgentLifecycle` から 2 つを作り、読み手はどちらかだけを読む:

- `agentAlive`（＝`isRunning`）: `agent`・`suspended`・`background` → true、`exited`・`subshell`・`absent` → false、`unknown` → **表示の読み手は今の判定（`hasSession`、claude は画面の健康）に落とす**（一覧がちらつかないように。送信は §3.2 で断る）。
- `paneExists`: `absent` 以外 → true（`unknown` は `hasSession` に落とす）。

| 読み手 | 今 | PR2 |
|---|---|---|
| 一覧・状態の poll（`worktree-status-helper.ts:868` の `probeToolSessionLiveness`） | 画面の liveness | `agentAlive` を先に読む。false なら `sessionStatusReason: 'exited'`（`:808`）。起動中（`startingSince`）は今どおり飛ばす |
| `capture --json`（`current-output-builder.ts:925` の `cliTool.isRunning()`、停止理由 `:958` の `session_not_running`） | claude 以外は `hasSession` | `isRunning` 自体が `agentAlive` を返す（`base.ts:231`・`isClaudeRunning`・opencode-v2 `:221`）。停止理由は `exited`（ペインが残る）と `session_not_running`（ペインが無い）に分け、一覧と同じ語にする |
| `wait`（`wait.ts:635-645`、capture を読む） | — | 一度動いていて `isRunning=false` → `Completed (basis=session_gone)` exit 0（PM の決定 (b)、受け入れ）。一度も動いていない → 今どおり NOT_STARTED。`suspended` は `isRunning=true` なので待ち続ける |
| `kill-session`（`kill-session/route.ts:136-138`） | `isRunning` が false ならスキップ | `paneExists` で読む。CLI が終わった後に残るペインも止める |
| `session-cleanup`（`session-cleanup.ts:264`） | 同じ | `paneExists` |
| `terminal` ルート（`terminal/route.ts:170`） | `isRunning` が false で 404 | 404 は `paneExists` が false のときだけ。残るペインへの送信は §3 で not_sent |
| relay（`relay-readiness.ts:84`） | `isRunning` | `agentAlive`（自動で変わる）。`exited` で保留 |
| 送信ルート（`send/route.ts:259`・`:305-307`） | `isRunning` | `isRunning` の前に種類を読み、§4.1 の方針で分ける。`refuseModelOnRunningSession`（`:259`）は `agentAlive` |

### 5.2 一括の読み方

一覧の poll は全セッションを読むので、`listSessions` の `-F`（`tmux.ts:341`）に `#{pane_pid}`・`#{pane_tty}`・`#{pane_dead}` を足し、`ps -A -o pid=,pgid=,tpgid=,stat=,tty=,comm=` を **1 回**だけ呼んで tty ごとに分ける（`readAgentLifecycles`）。1 回の送信の各段は `ps -t <tty>`（行が少ない）。

### 5.3 回答経路は今回は安全にならない（P2-8 の訂正）

前版の「auto-yes は `isRunning=false` で止まる」は誤り。auto-yes の poller は画面を直接読んで回答へ進み（`auto-yes-poller.ts:1029`、`captureObservedFrame`）、応答の poll はセッションの有無（`cli-session.ts:101` の `isSessionRunning` = `sessionExists`、`response-checker.ts:1687`）を読む。どちらも `isRunning` を読まないので、PR2 の後も、終わったペインの残った画面にダイアログの型が当たれば答えのキー（数字・`y`・矢印・自由記述）を打ちうる（未確認）。回答経路（`prompt-answer-sender.ts`）は PM の決定 (c) でこの Issue では直さない。§10 の残り。

## 6. 未送信のときの exit code と理由

`SendAttemptReason`（`send-attempt-types.ts:26`）。分類はコードで読む（文面で読まない）。

| 種類・段 | state | reason | code | 答え |
|---|---|---|---|---|
| `exited`・`subshell`（復旧しない入口、または復旧の後もなお） | not-sent | `agent-not-in-foreground`（PR1） | `AGENT_NOT_IN_FOREGROUND` | 500＋`not_sent` → exit 99 |
| `suspended`・`background` | not-sent | `agent-suspended`（新） | `AGENT_SUSPENDED` | 同じ |
| `unknown` | not-sent | `agent-foreground-unknown`（新） | `AGENT_FOREGROUND_UNKNOWN` | 同じ |
| 本文の後の段（Enter・再送）で前面から外れた、lease と違う | indeterminate | `agent-left-mid-send`（新） | `AGENT_LEFT_MID_SEND` | 500＋`unknown`（既存の indeterminate と同じ）。再送してよいとは言わない |

エラー文: `The agent in session <name> is not in the pane's foreground (<kind>: <detail>); nothing was typed (Issue #4300).` に既存の `[send state: …]` と §3.2・§3.3 の案内。新しい exit 番号は作らない（呼び手は 99 と `not_sent` で分岐している）。

## 7. テストの設計

### 7.1 判定の単体（`tests/unit/session/agent-lifecycle-4300.test.ts`）

`execFile` の mock に §9 の実測の `ps` の出力（a〜k）を fixture として与え、§2.2 の種類を表で固定する。加えて: `display-message` の失敗・形違い → unknown／`ps` の失敗・時間切れ・列が足りない・`pane_pid` の行が無い → unknown／`pane_dead=1` → absent／`comm` が `/bin/bash`・`-zsh` → シェル扱い。

### 7.2 送信の表駆動（PR1 のファイルに足す）

- `CLI_TOOL_IDS` の全員で、各 CLI の**準備条件を満たした同じ画面**（入力欄が空いている）に対し、種類だけを変える: `agent` → 送る（陽性対照: 確認を外すと各 CLI で send-keys が 1 回以上、P2-9）／`exited`・`subshell`・`suspended`・`background`・`unknown` → send-keys・paste-buffer・load-buffer が 0 回、§6 の reason。
- 段ごとの注入（P1-1）: 1 回目の判定は `agent`、N 回目から `exited`（または別の `tpgid`）を返す mock で、(1) 判定の後・空けの前、(2) `load-buffer` の後・`paste-buffer` の前、(3) 本文の後・Enter の前、(4) Enter の後・再送の前。(1)(2) は not-sent・本文のキー 0 回、(3)(4) は indeterminate（`agent-left-mid-send`）で Enter が出ない。not_sent に戻らないこと。
- capture は成功するが前面が読めない（P1-2）: 終了画面＋`display-message` 失敗、終了画面＋`ps` 失敗 → not-sent／通常の CLI 画面＋`agent` → 送る（対照）。
- Ctrl-Z（P2-6）: `suspended` → not-sent、`killSession`・`startSession`・起動行の send-keys が 0 回。続けて `agent`（fg の後）→ 送る。

### 7.3 復旧と relaunched

- `base.ts` の relaunch（`session-relaunch-2070.test.ts` は期待を変えない）に、`exited` → 起動し直す（既存）／`suspended` → 起動行 0 回で断る、を足す。
- claude の `ensureHealthySession`: `exited` → kill して作り直す／`suspended` → kill しない／`agent`＋旧い画面 → 今の判定（対照）。ルートの判断と `ensureHealthySession` が同じ種類を読むこと（P2-5）。
- `relaunched`: §4.3 の 5 本の対照。CLI の stderr の 1 行は `message-dispatch` のテストで、成功と exit 99 の両方。

### 7.4 読み手とガード

- 状態: `worktree-status-helper` と `current-output-builder` の**実際の応答**を全 CLI で（P1-4）。`exited` → `isRunning=false`・`exited`／ペイン無し → `session_not_running`／`suspended` → `isRunning=true`／`unknown` → 今の判定。
- `kill-session`・`session-cleanup`: 残るペイン（`exited`）を kill する／ペインが無い → 今どおりスキップ（対照、P2-7）。`terminal` ルート: 残るペイン → 404 にしない、ペイン無し → 404。
- `wait`: 動いた後の `exited` → `session_gone` exit 0、一度も動いていない → NOT_STARTED（区別を固定）。
- ガード（`tests/unit/guards/send-foreground-gate-4300.test.ts`、PR1 のものを広げる）: `src/lib/cli-tools/submit-verified-sender.ts` の `sendKeys(`・`sendSpecialKeys(`・`paste-buffer` の直前に `assertAgentHoldsPane` があること。`src/lib` で打つファイルの許可リスト（起動・ダイアログへの答え・ロックの中・生の入力・回答経路（§10 の残り））。`isRunning(` を読むファイルの一覧を固定し、寿命を独自に判定する読み手（`hasSession` を「動いている」と読む新しい所）が増えたら見直しを強いる。
- 既存のテストの期待は変えない。tmux を部分的に mock した既存のテストが `unknown` で断るようになって落ちる場合は、テストの mock に `agent` を返す既定（`tests/helpers` の共通の mock）を足して通す。期待そのものを変える必要があれば変えずに報告する。

## 8. PR2 の範囲

### 8.1 書くファイル（予定）

- 判定: `src/lib/session/agent-lifecycle.ts`（新設。`readAgentLifecycle`・`readAgentLifecycles`・`assertAgentHoldsPane`）、`src/lib/tmux/tmux.ts`（`listSessions` の書式、PR1 の `readPaneForeground` の整理）、`src/lib/detection/shared/shell-pane-command.ts`（パスの basename）
- 送信: `src/lib/session/composer-clear.ts`、`src/lib/cli-tools/submit-verified-sender.ts`、`src/lib/cli-tools/copilot.ts`（`:942`・`:1115` の段）、`src/lib/session/send-user-message.ts`（早い拒否の分岐と `relaunched`）、`src/lib/session/send-attempt-types.ts`・`send-attempt-state.ts`（理由）
- 復旧: `src/lib/cli-tools/base.ts`（`isRunning`・`relaunchIfToolExited`）、`src/lib/session/claude-session.ts`（`isClaudeRunning`・`ensureHealthySession`）、`src/lib/cli-tools/opencode-v2.ts`（`isRunning`）、`src/lib/session/session-launch-flight.ts`（起動の結果）、`src/app/api/worktrees/[id]/send/route.ts`・`send-session-start.ts`・`send-failure.ts`
- 読み手: `src/lib/session/worktree-status-helper.ts`、`src/lib/session/current-output-builder.ts`、`src/app/api/worktrees/[id]/kill-session/route.ts`、`src/lib/session-cleanup.ts`、`src/app/api/worktrees/[id]/terminal/route.ts`
- CLI: `src/cli/commands/message-dispatch.ts`（stderr の 1 行）、`src/cli/types/`（答えの型に `relaunched`）
- 文書: `docs/user-guide/cli-operations-guide.md`（wait の `session_gone`、send の新しい理由。ja/en があれば両方）、`changelog.d/4300.md`（PR1 の断片に追記）、module-reference の断片
- テスト: §7 のファイルと PR1 の表駆動・ガード

### 8.2 G-PR3（`send-user-message.ts` の S-B）との重なり

重なるのは `src/lib/session/send-user-message.ts` だけ（PM の決定 (d)）。PR1 の早い拒否は所有権の確認の後の数行、PR2 はそこを「種類で分ける」に変え、`relaunched` を答えに載せる。G-PR3 の S-B（中止の経路）は同じ関数の別の位置。順序: PR1 → G-PR3（S-B は PR1 の早い拒否を残したまま足す）→ PR2 は develop を取り込んでから。PR2 の契約に「`send-user-message.ts` は G-PR3 の S-B の経路を変えない。早い拒否の分岐は S-B より前の位置のまま」と書く。

### 8.3 PR2 を 2 本に分ける案（推奨）

| PR | 中身 | 依存 |
|---|---|---|
| PR2a 送信 | `agent-lifecycle.ts`、各段の判定（§3）、`unknown` を断る、`suspended` の理由、入口の表のうち送信側（§4.1）、`relaunchIfToolExited`・`ensureHealthySession` が種類を読む（§4.2、作り直さない側）、§7.1・§7.2・§7.3 の前半、ガード | PR1 のマージ後 |
| PR2b 読み手と relaunched | `isRunning` の置き換え（§5.1）、current-output・一覧・wait・kill-session・cleanup・terminal・relay、起動の結果と `relaunched`（§4.3）、CLI の stderr、文書、§7.3 の後半・§7.4 | PR2a のマージ後 |

分ける理由: PR2a は「打たない」側だけで、読み手の表示を変えない（UI・wait の振る舞いの変化は PR2b に集まる）。PR2b の `isRunning` の変更は `wait` の完了と UI に効くので、UAT を別に取れる。`relaunched` は `isRunning` が `exited` を false と読んでルートが作り直すようになって初めて意味があるので PR2b。1 本で出すなら §8.1 のとおり。

## 9. 実機で決まること（隔離した tmux で確かめた）

手順: `mktemp -d "$TMPDIR/c4300r.XXXX"` の中にソケットと仮の HOME を作り、`env -i HOME=<仮> PATH=$PATH tmux -S <dir>/s -f /dev/null new-session -d -s p "env -i HOME=<仮> PATH=$PATH TERM=xterm zsh -f -i"`。`send-keys` で状態を作り、`display-message -p '#{pane_current_command}|#{pane_pid}|#{pane_tty}'`・`ps -o tpgid= -p <pane_pid>`・`ps -o pid=,ppid=,pgid=,tpgid=,stat=,comm= -t <tty>` を読む。最後に `kill-server` して dir を消す。本番のサーバー・本番の tmux（既定のソケット）には触れていない。サーバー・エージェント CLI は起動していない。

### 表 1（2026-11-10、tmux 3.5a、macOS、zsh -f -i。pane_pid=86183）

| 記号 | 状態 | pane_current_command | tpgid | 前面のグループ（`pgid == tpgid`） | ほかのグループ | D | E |
|---|---|---|---|---|---|---|---|
| a | 何も動いていないシェル | `zsh` | 86183（=pane_pid） | zsh `Ss+` | なし | shell | exited |
| b | `sleep`（CLI の代わり） | `sleep` | 87776 | sleep `S+` | — | other | agent |
| c | 非 exec の bash ラッパー → sleep | `bash` | 90968 | `/bin/bash` `S+`、sleep `S+`（同じグループ） | — | other | agent |
| d | 対話のサブシェル（`bash -i`）が入力待ち | `bash` | 94031 | bash `S+` だけ | — | **other（誤り）** | subshell |
| e | サブシェルの中で sleep | `sleep` | 95638 | sleep `S+` | bash（`S`） | other | agent |
| f | `set +m` の後 sleep を前面に | **`zsh`** | 86183（=pane_pid） | zsh `Ss+`、sleep `S+`（シェルと同じグループ） | なし | **shell（誤り）** | unknown |
| g | `set +m` の後 `sleep &` | `zsh` | 86183 | zsh `Ss+`、sleep `SN+`（同じグループ） | なし | shell | unknown（f と区別できない） |
| h | ジョブ制御有効で `sleep &` | `zsh` | 86183 | zsh `Ss+` | sleep `SN`（別グループ） | shell | background |
| i | sleep を Ctrl-Z | `zsh` | 86183 | zsh `Ss+` | sleep `T` | shell | suspended |
| j | `fg` の後 | `sleep` | 14968 | sleep `S+` | — | other | agent |
| k | 子が終わった後 | `zsh` | 86183 | zsh `Ss+` | なし | shell | exited |

読み取れたこと: (1) macOS の tmux は前面のグループのリーダーの名前を出す（c は `bash`、f は `zsh`）。(2) ジョブ制御が無効だと前面と背面がどちらも `+` つきでシェルのグループに入り、`ps` の上で区別できない（f・g）→ 前提の外として `unknown`。(3) macOS の `comm` はパスで出ることがある（c の `/bin/bash`）。

### 表 2（前版、2026-11-10、同じ環境）

| 前面 | pane_current_command | tpgid = pane_pid |
|---|---|---|
| `node -e …` | `node` | いいえ |
| `npx --no-install node -e …` | `node` | いいえ |
| `exec` する bash のラッパー → sleep | `sleep` | いいえ |

`list-sessions -F '#{session_name} #{pane_current_command} #{pane_pid}'` はセッションごとに今のペインの値を返し、`ps -o pid=,tpgid= -p <pid1>,<pid2>` で一括に読めた（§5.2 の一括版の根拠）。

## 10. 未確認・残り

- 本物の CLI（claude ネイティブ版・codex・command-code・copilot・antigravity・opencode・gemini・vibe-local）が前面のときの `ps` の行。E は「シェル名でない」だけを見るので名前に依存しないが、**CLI が終わった後も同じ tty に子（MCP サーバーなど）が残る**と `exited` ではなく `background` と読み、作り直さずに断る（送らない側）。実装の段の UAT で各 CLI の終了後の `ps -t` を取る。
- Linux（procps）の `ps -t pts/N -o pid=,pgid=,tpgid=,stat=,comm=` の実測（§2.3）。busybox の `ps` の環境では全部の送信が `unknown` で断られる。対応する環境の一覧に「procps の `ps`」を書くか、起動時に 1 回確かめてログに出すかは PR2 の契約で決める。
- 回答経路（`prompt-answer-sender.ts`。`respond`・`prompt-response`・auto-yes）: 終わったペインの残った画面にダイアログの型が当たれば打ちうる（§5.3、未確認）。PM の決定 (c) でこの Issue では直さない。同じ `assertAgentHoldsPane` を回答の最初のキーの前に置く案を、別 Issue として PM が人に伺い中（#4300 にコメントで「残り」として記録）。
- 判定と打鍵の間の数 ms の競合（§3.1）は残る。

## 11. 事前レビューの指摘ごとの処置

指摘: `workspace/orchestration/runs/2026-11-09/prereview/review-4300.md`（codex-2）。PM の決定: 同 dir の `pm-return-4300-prereview.md`（PR2 の (i)〜(v)）と `pm-return-4300-design.md`（(a)〜(e)）。

| # | 指摘 | 処置 | 理由 | 入れた節 |
|---|---|---|---|---|
| P1-1 | 1 回の判定では、判定後の終了でシェルへ送りうる。本文・paste・各 Enter が同じ寿命に属すること、本文到達後の失敗を not_sent に戻さないこと | 採る | PM (i)。各段の直前に共通の 1 関数、lease（`tpgid`）で同じ CLI を確かめる。`typed=true` の段は indeterminate。残る競合は exec 1 回分と明記 | §3.1、§6、§7.2 |
| P1-2 | 「読めなければ通す」は不具合を残す。送信に要る証拠と unknown の停止条件 | 採る | PM (ii)。E は CLI がいる積極的な証拠のときだけ送る。unknown は断り、理由と次の手を出す。capture 成功＋display／ps 失敗の対照 | §2.1、§3.2、§6、§7.2 |
| P1-3 | D は前面が CLI だと証明しない。サブシェル・ジョブ制御で逆転。前提を固定し、各状況の対照 | 採る | 前提を「対話シェル・ジョブ制御有効」に固定。D と E を比べて E を採用。通常起動・非 exec ラッパー・サブシェル・ジョブ制御無効・background・Ctrl-Z／fg を隔離した tmux で実測（macOS）。Linux は見立てとして残す | §2.1〜§2.3、§9、§10 |
| P1-4 | `capture --json` の実経路（`current-output-builder.ts:925`、`session_not_running`）が漏れている | 採る | PM (iv)。`isRunning` 自体を `agentAlive` にし、current-output と一覧が同じものを読む。停止理由を `exited` と `session_not_running` に分ける。実際の応答を全 CLI で検証 | §5.1、§7.4 |
| P2-5 | claude 以外にも自動の再起動がある（`base.ts:780`）。早い拒否が復旧を止める。`ensureHealthySession` が旧い判定で再利用しうる | 採る（前版の誤りを訂正） | PM (v)。入口ごとに「拒否／既存の復旧」を表で固定。`relaunchIfToolExited` と `ensureHealthySession` が同じ判定を読む。早い拒否は `exited` では断らない | §1.1、§1.2、§4.1、§4.2、§7.3 |
| P2-6 | 一時停止・background を終了扱いすると会話を捨てうる | 採る | PM (iii)。`suspended`・`background` は別の理由で not-sent、kill・作り直しをしない。fg の後は送れる対照 | §2.2、§3.3、§4.2、§7.2 |
| P2-7 | `isRunning=false` で kill-session・cleanup が飛ばされ、terminal が 404 | 採る | PM (iv)。`paneExists` を別の述語にし、停止・片付けはそれを読む。残るペインとペイン無しの対照 | §5.1、§7.4 |
| P2-8 | auto-yes・応答の poll が止まるという説明は誤り | 採る（説明を訂正）。回答経路は直さない | PM (c) と (v)。auto-yes は画面を直接読み、応答の poll はセッションの有無を読む。残りとして明記 | §5.3、§10 |
| P2-9 | 入口の表に画像・copilot の各経路・opencode の HTTP と fallback・WebSocket の `terminal_input`。各 CLI の陽性対照 | 採る | PM (v)。入口の表を分け、opencode の HTTP は打たないので対象外、fallback は #4040 の indeterminate を保つ。`terminal_input` は生の入力として対象外。全 CLI の陽性対照 | §4.1、§7.2 |
| P2-10 | `relaunched` の成立条件と失敗時の通知 | 採る | PM (a) と (v)。起動の結果 `replaced` のときだけ。置換後の失敗にも載せる。初回／再利用／置換成功／置換後失敗／並行の対照 | §4.3、§7.3 |

PM の設計の決定 (a)〜(e) の反映: (a) `relaunched` と stderr の 1 行 → §4.3。(b) wait の変化を受け入れる → §5.1（changelog と cli-operations-guide は PR2b の実装で）。(c) 回答経路は直さない → §0.2・§5.3・§10。(d) G-PR3 との重なり → §8.2。(e) 事前レビューは codex-2 → この改訂の後、差分だけ再確認を受ける。
