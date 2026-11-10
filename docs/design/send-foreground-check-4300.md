# 終わった CLI のペインへ打ち込まない（Issue #4300）設計

- 段: 設計（この文書だけ）。改訂 2（2026-11-10）: codex-2 の再確認（N1〜N7）と PM の決定（`pm-return-4300-design-rev1.md` の (a)）を反映し、**主筋を「前面の推測」から「CLI を exec で起動してシェルを残さない」へ替えた**。改訂 1 の案 E は比較の表に「採らない」として残す。指摘ごとの処置は §11
- 基準: develop `7901c149e`（src は `ed9b89eac` と同じ）。行番号はこの時点のもの。「事実」は file:line、「見立て」「未確認」は明記する
- 実装は 2 段: **PR1**（確かな証拠のときだけ止める小さな直し。別の worktree で実装中。この文書は書かない）、**PR2**（この文書の本体。PR1 のマージ後、develop から別の契約で。§8 で 2 本に分ける）

## 0. 改訂 2 の要約と PR1 との関係

### 0.1 要約（改訂 2 で決めたこと）

| # | 決めること | 決定 | 節 |
|---|---|---|---|
| (1) | exec 起動の形 | **起動行を `… exec env <cli> …` にする**（ログインシェルの対話シェルに打つ今の流れのまま、最後の `exec` でシェルを CLI に置き換える）。new-window の pane command にする案は採らない（rc が読まれず PATH を失う、§9 表 3 の m） | §2 |
| (2) | remain-on-exit | **起動の直前にペインへ `remain-on-exit on` を付ける**。CLI が終わるとペインは dead pane（`#{pane_dead}=1`）で残り、最後の画面（`Resume this session with:` を含む）と `Pane is dead (status N, …)` が見える。セッションは消えない | §2.3、§3 |
| (3) | 読み手 | ペインを 3 つに分ける: **alive（`pane_dead=0`）／dead（`pane_dead=1`）／absent（セッション無し）**。`agentAlive`=alive、`paneExists`=alive または dead。停止・片付けは `paneExists`、送信・状態・relay は `agentAlive`（N6） | §3 |
| (4) | Ctrl-Z | exec したペインでは CLI が端末のセッションリーダーで、そのグループは孤立している（親が tmux）ため、**端末からの SIGTSTP は捨てられ CLI は止まらない**（実測 e・f）。`suspended` は起きない。表示は `^Z` が出るだけ | §4 |
| (5) | 既存の復旧 | 復旧の判断（#2070 `relaunchIfToolExited`、`resolveLaunchPane` の再利用 `base.ts:897`、opencode V1/V2 の再利用、claude の `ensureHealthySession`、codex の #2068）は、**まず `pane_dead` を読む**（画面は読まない）。dead なら `respawn-pane`（`-k` なし。生きたペインには tmux が断る、実測 c）してから同じ起動行を打つ。claude は今の不健康の経路（kill して作り直す） | §5 |
| (6) | relaunched | 起動の結果 `replaced`（dead／旧方式の exited から作り直した）を起動の印に残し、ルートが送信の後に読む（`takeOpencodeResumeNotice` と同じ形）。**復旧の変更と同じ PR（PR2a）で**、成功・失敗の両方の答えに載せる（N7） | §6 |
| (7) | `Resume this session with:` | dead pane に残るので capture で見える（今と同じ）。作り直しの後は、non-claude は respawn で履歴に残る（実測 a）、claude は消える。代わりに **relaunched の 1 行に、前の画面から読めた `claude --resume <id>` を添える**。ペインで自分で `claude --resume` を打つ使い方はできなくなる | §6.1 |
| (8) | 既存のセッションの移行 | 強制の再起動はしない。旧方式のペイン（印 `@cm_launch` が無い）は PR1 の判定が守る。旧方式の CLI が終わり、次の送信で復旧（#2070）すると、そのときの起動行が exec なので**その場で新方式に移る**。claude は kill して作り直すので同じく移る | §8.4 |
| (9) | N3（改行を含む本文） | 新方式のペインには、端末から行を読んでコマンドとして実行するシェルが**どの時点にもいない**（CLI がいる間は CLI が読む、終わった後は tmux が入力を捨てる）。実測 e2（改行入りの本文が実行されない）・b（dead pane への send-keys は exit 0 で何も起きない） | §4、§11 |

前面の推測（案 E）・lease・各段の判定（改訂 1 の §3.1）は **PR2 の主筋から外す**。exec 起動で、判定と打鍵の間の競合が起きても届く先がシェルでなくなるので、各段で前面を推し量る必要が消える（§11 の N1〜N4）。

### 0.2 PR1 が入れるもの（PR2 の土台）

| PR1 が入れるもの | 中身 | PR2 での扱い |
|---|---|---|
| `readPaneForeground(sessionName): 'shell' \| 'other' \| 'unknown'`（`src/lib/tmux/tmux.ts`） | 案 D（§2.1）。名前がシェル かつ `tpgid == pane_pid` なら `shell` | **旧方式のペイン（印なし）にだけ使う**（§8.4）。新方式のペインに当てると、exec した非 exec ラッパー（`bash` スクリプト → CLI）を `shell` と誤って全部断る（実測 h） |
| `recheckComposerBeforeInput`（`composer-clear.ts:263`）で `shell` なら `AGENT_NOT_IN_FOREGROUND_CODE` | 全 driver が本文の最初のキーの前に通る点 | 同じ点に「`pane_dead=1` なら断る」を足す（§4.2）。旧方式のペインでは PR1 の判定のまま |
| `sendUserMessage` の早い拒否（`send-user-message.ts`、所有権の確認の後） | 同じ判定を 1 回 | **PR2 は触らない**（§8.2。G-PR3 と重ならない） |
| `SendAttemptReason` の `'agent-not-in-foreground'`、`classifySendFailure` | 500＋`not_sent` → exit 99 | 新方式の dead pane も同じ理由で返す（理由を 2 つ足す: `agent-foreground-unknown`・`agent-left-mid-send`。§4.3） |
| 表駆動テスト（`CLI_TOOL_IDS` の全員）と陽性対照 | 前面がシェルで send-keys 0 回 | 残す（旧方式の守り）。新方式の行を足す（§7） |

PR1 の残りのリスク（判定の後に CLI が終わる競合、改行を含む本文の先頭行が本文の送信だけで実行されうる＝N3）は、PM の決定どおり PR1 の `changelog.d/4300.md` と PR 本文に明記する（この契約では changelog.d を書かない）。新方式に移ったペインではこの残りが消える（§11）。

### 0.3 止める点

- PR2 は起動（`src/lib/session/launch-screen.ts`・`src/lib/hooks/sources/launch-command.ts`・`src/lib/tmux/tmux.ts`・各 driver の起動）、復旧（`base.ts`・`claude-session.ts`・`opencode*.ts`・`codex.ts`・`session-launch-flight.ts`）、読み手（§3 の表）、送信の最初の判定（`composer-clear.ts`）、CLI の表示（`message-dispatch.ts`）で収まる。`src/lib/session/send-user-message.ts`・`src/lib/handoff`・`src/components/mem` には触らない。
- `src/lib/prompt-answer-sender.ts`（`respond`・auto-yes の回答経路）は直さない（PM の決定 (c)）。ただし新方式のペインでは答えのキーもシェルに届かなくなる（§3.3）。

## 1. 今の経路と、claude だけがシェルへ打ち込む理由

### 1.1 経路（事実）

`commandmate send` → `postMessage`（`src/cli/commands/message-dispatch.ts:188`、`POST /api/worktrees/:id/send`）→ ルートが所有権を確かめ（`src/app/api/worktrees/[id]/send/route.ts:228`）、`settleSessionLaunch` の後に `cliTool.isRunning()` を読み（同 `:305`）、false なら `startSessionForSend`（`send-session-start.ts:93`）→ `sendUserMessage`（同 `:380`）。
claude 以外の driver は送る前に `requireSession(..., { relaunch: true })`（`src/lib/cli-tools/base.ts:814`）を通り、ツールが画面から終わったと読めれば同じペインで起動し直す（`relaunchIfToolExited`, `base.ts:780`、#2070）。
その後、全員が `sendMessageWithSubmitVerification`（`src/lib/cli-tools/submit-verified-sender.ts:688`）に入り、入力ロックの中で 再読（`recheckComposerBeforeInput`）→ 準備の再確認 → 入力欄を空ける → 本文 → Enter → 読み戻し → 再送。

### 1.2 根の原因（事実）

全 CLI の起動は、`createSession`（`src/lib/tmux/tmux.ts:438`。window 0 を `sleep` の仮置き `:373` で作り、`new-window -k`（`:523`）でログインシェルの対話シェルに置き換える）の後、そのシェルへ起動行を打つ（`typeLaunchLines`, `src/lib/cli-tools/launch-keys.ts:39`）。CLI はシェルの子なので、**CLI が終わるとペインには入力を読むシェルが残る**（`launch-screen.ts` の冒頭のコメントが「the pane falls back to the same shell prompt」と明記）。どの判定がすり抜けても、打った本文はシェルが読んで実行する。

### 1.3 claude だけが打ち込む理由（事実＋実測、改訂 1 と同じ）

claude は終了時に最後の画面（入力欄の `❯ ` 行と罫線）を残し、その下に `Resume this session with:`・`claude --resume <id>`・シェルのプロンプトを出す。`CLAUDE_PROMPT_PATTERN`（`src/lib/detection/tools/claude/patterns.ts:166`）が残った `❯ ` 行に当たり、liveness は画面全体に alive の型を当てる（`liveness-spec.ts:167-168`、`tool-liveness.ts:249-253`）ので、`isClaudeRunning`・`ensureHealthySession`・準備待ちが全部通る。codex・command-code が断ったのは偶然（表示が変われば打ち込みうる、見立て）。

## 2. exec 起動（決定 (1)(2)）

### 2.1 案の比較

| 案 | 中身 | 判定 | 理由 |
|---|---|---|---|
| D（PR1） | 名前がシェル かつ `tpgid == pane_pid` なら断る | 旧方式のペインの守りとして残す | 対話サブシェル・ジョブ制御無効で誤る（§9 表 1 の d・f）。exec した非 exec ラッパーを誤って断る（表 3 の h） |
| E（改訂 1） | 前面のグループにシェル名でないプロセスがいれば送る。lease＝`tpgid`、打鍵の各段で再判定 | **採らない（理由: N1〜N4）** | N1: 「シェル名でないプロセス」は対象 CLI の証拠にならない（補助プロセスが残る・サブシェル内の Ctrl-Z）。N2: `tpgid` は同じ CLI の寿命を識別しない（非 exec ラッパーの再起動）。N3: 改行を含む本文は本文の送信だけで実行されうる。N4: キーを出す内部の経路（空けの反復・撤回・copilot の一括送信）を全部覆う必要がある。どれも「推測と打鍵の間にシェルがいる」ことが根で、端を足しても出続ける系統 |
| F-1 pane command | `new-window -k … '<起動行>'`（tmux が `default-shell -c` で起動） | 採らない | 非対話シェルなので `.zshrc` を読まず、nvm・pyenv・Homebrew の PATH を失う（表 3 の m、`RC_LOADED` が来ない）。`-lic` を付けると shell ごとの差（fish）と引用の層が増え、起動行を入力ロックの中で打つ今の流れ（#3975・#3981）、codex の #2068、opencode-v2 の cwd の再確認（#4233）を全部作り直すことになる |
| **F-2 起動行に `exec`（採用）** | 今の流れのまま、起動行を `clear…; printf…; <代入> exec env <cli> <引数>` にする | **採用** | rc・cwd・入力ロック・画面の消去がそのまま。シェルは最後に CLI へ置き換わり、CLI の終了でペインが dead になる（表 3 の a） |

### 2.2 起動行の形

今: `clear 2>/dev/null; printf '\033[3J'; NAME='v' … <cli> <引数>`（`launch-screen.ts:44` の接頭辞＋`renderAgentLaunchCommand`, `src/lib/hooks/sources/launch-command.ts:276`）。
新: `clear 2>/dev/null; printf '\033[3J'; NAME='v' … exec env <cli> <引数>`。

- `exec` の前に代入を置く（`NAME='v' exec env cmd`）。zsh・bash・sh で代入が CLI に渡ることを実測（表 3 の n）。秘密を含む代入（ロールの `OPENCODE_CONFIG_CONTENT="$(cat '<file>')"`、`src/lib/agent-roles/adapters.ts:245`）も今どおり環境に入り、`env` の argv には載らない（`exec env NAME=… cmd` の形にすると argv に載るので採らない）。
- `env` を挟む理由: **bash の対話シェルは `exec` に失敗してもシェルが残る**（表 3 の c3。zsh は終わる c）。`exec env` なら `env` は必ずあるので exec は成功し、CLI が見つからなければ `env` が 127 で終わってペインが dead になる（c2・c4）。起動の失敗でシェルが残る穴を塞ぐ。
- 入れる場所は `renderAgentLaunchCommand`（計画を行にする唯一の関数）で `${代入} exec env ${plan.command}`。後ろに足すフラグ（claude・antigravity の `--model`、command-code の起動フラグ、opencode の `-s <id>`）は今どおり行末に付くので影響しない。計画を通らない vibe-local（`'vibe-local -y'`、`vibe-local.ts:143`）は同じ補助関数で `exec env vibe-local -y`。
- ガード（§7.4）: `typeLaunchLines` に渡る文字列の段のうち起動行は、全部 `exec env ` を含むこと。例外は claude の `unset CLAUDECODE`（起動の前の行、下表）だけ。

### 2.3 全 CLI の起動行と、起動の前に同じシェルで要るもの

| CLI | 起動行を作る所 | 打つ所 | 起動の前に要るもの | 扱い |
|---|---|---|---|---|
| claude | `buildAgentLaunchCommandLine`（`claude-session.ts:938`）＋`--model`（`:948`） | `typeLaunchLines(sessionName, ['unset CLAUDECODE', …])`（`claude-session.ts:975`）。前に `tmux set-environment -g -u CLAUDECODE`（`:974`） | `unset CLAUDECODE`（同じシェルで先に走る別の行） | そのまま。2 行目だけ `exec env`。2 行は同じシェルの入力に順に積まれるので `unset` が先に効く（今と同じ） |
| codex | `buildAgentLaunchCommandLine`（`codex.ts:313`）。`plan.command` は `'<path>' -c features.daemon_auto_start=false [--no-daemon] [trust]`（`hooks/sources/codex/hooks-config.ts:918`） | `codex.ts:343`、#2068 の打ち直し `:337` | なし | `exec env`。#2068 の打ち直しは §5 |
| command-code | `buildCommandCodeLaunchCommand`（`command-code.ts:127`、フラグを後ろに） | `command-code.ts:303` | なし | `exec env` |
| copilot | `buildAgentLaunchCommandLine`（`copilot.ts:513`） | `copilot.ts:533` | なし | `exec env` |
| antigravity | `buildAgentLaunchCommandLine`＋`--model`（`antigravity.ts:303-308`） | `antigravity.ts:331` | なし | `exec env` |
| opencode | `buildAgentLaunchCommandLine`＋`-s <id>`（`opencode.ts:470-490`、`opencode-session-store.ts:312`） | `opencode.ts:504` | なし | `exec env` |
| opencode-v2 | `buildAgentLaunchCommandLine`（`opencode-v2.ts:300`） | `opencode-v2.ts:304`（前の段は cwd の再確認の関数 `launchCwdRecheck`、打たない） | なし（ポート・パスワードは代入で渡る） | `exec env` |
| gemini | `buildAgentLaunchCommandLine`（`gemini.ts:164`） | `gemini.ts:178` | なし | `exec env` |
| vibe-local | 文字列 `'vibe-local -y'`＋`-m`・`--context-window`（`vibe-local.ts:143-157`） | `vibe-local.ts:164` | なし | `exec env`。vibe-local 自体は bash スクリプトで最後に `exec python3`（手元の `~/.local/bin/vibe-local:305`） |

- `cd`: どの起動行にも無い。作業ディレクトリは `createSession` の `new-window -c`（`tmux.ts:523`）で決まる（今と同じ）。
- `export`・nvm・pyenv・Homebrew の PATH: 起動行には無く、ログインシェルが rc を読んで整える。F-2 は rc を読んだ後に exec するので今と同じ PATH で CLI が起動する（表 3 の a: 仮の `.zshrc` の PATH と変数が CLI に届いた）。
- 秘密の代入（ロール）: 上の §2.2。
- 起動行の echo: `clear` と `ESC[3J` で消す今の仕組み（#3180）は変えない。

### 2.4 remain-on-exit と印（決定 (2)）

- 起動行を打つ**同じ入力ロックの番の中で、打つ直前に** `set-option -p -t <pane> remain-on-exit on` を撃つ（ペインの選択肢。サーバ全体・既定のサーバの `-g` には撃たない）。`createSession` には入れない（`createSession` は起動以外の呼び手もある、`tmux.ts:1059` ほか）。
- CLI が終わった後: ペインは dead で残る（`pane_dead=1`、`pane_dead_status` に終了の状態、表 3 の a・b2）。セッションは消えない。remain-on-exit が無いと、ペインが閉じて 1 窓のセッションごと消える（表 3 の b）。
- remain-on-exit を付ける理由: (i) 最後の画面（`Resume this session with:`、起動の失敗の文面）が capture で読める。消えると失敗の理由が残らない。(ii) dead pane への復旧は `respawn-pane`（`-k` なし）で、**tmux 自身が「生きているペインには断る」**（表 3 の c）。生きた CLI を誤って置き換える経路が構造的に無くなる。(iii) 復旧で同じペインを使うので、non-claude は前の画面が履歴に残る（#2070 の「pane holds the transcript」と同じ、表 3 の a）。
- 印: 起動が準備の確認まで通ったら `set-option -p @cm_launch exec`（ペインの利用者の選択肢、`#{@cm_launch}` で読める、表 3 の l）。`respawn-pane` の直前に外し、次の起動の準備の確認の後にまた付ける。印は「このペインのシェルはもう CLI に置き換わった」ことを表し、§8.4 の旧方式との分岐に使う。準備の確認の前に付けないのは、起動行が打てなかったペインに印が付くと、シェルがいるのに PR1 の守りを外してしまうため。
- tmux の版: `-p`（ペインの選択肢）は tmux 3.0 以降（見立て。リポジトリに tmux の最低版の宣言は無い）。実測は 3.5a。

## 3. 読み手（決定 (3)、N6）

### 3.1 3 つの状態と 2 つの述語

`readPaneState(sessionName): 'alive' | 'dead' | 'absent' | 'unknown'`（`src/lib/tmux/tmux.ts`、新設）: `display-message -p -t <exact> '#{pane_dead}\t#{pane_pid}\t#{@cm_launch}'` を 1 回。セッションが無い → `absent`。`pane_dead=1` → `dead`。`0` → `alive`。tmux の時間切れ・形違い → `unknown`。

- `paneExists` = alive／dead（`unknown` は今の `hasSession` に落とす）。停止・片付け・terminal の 404 が読む。
- `agentAlive` = alive かつ（新方式の印あり、または旧方式で今の判定が alive）。`isRunning` がこれを返す。送信・状態・relay・wait が読む。
- 一括: `listSessions` の `-F`（`tmux.ts:341`）に `#{pane_dead}`・`#{@cm_launch}` を足す（表 3 の l: `list-sessions -F` で 1 回に読めた）。ps は使わない。
- 注意（実測）: dead pane の `pane_current_command` は終わる前の値ではなく `zsh` などが残り、`pane_tty` は別のペインが使い回す（表 3 の a・l）。dead の判定に名前と tty を使わない。

### 3.2 読み手の表

| 読み手 | 今 | 新方式 |
|---|---|---|
| 一覧・状態の poll（`worktree-status-helper.ts:868` → `probeToolSessionLiveness` → `probeSessionLiveness`） | 画面の liveness | 先に `pane_dead`（一括）。dead → `sessionStatusReason: 'exited'`（`:808` の語）。dead pane の画面には `❯` が残るので、**画面より先に読むことが必須**（claude の誤りの再発を防ぐ）。起動中（`startingSince`）は今どおり飛ばす |
| `capture --json`（`current-output-builder.ts:925` の `isRunning`、`:958` の `session_not_running`） | claude 以外は `hasSession` | `isRunning`＝`agentAlive`。停止理由は dead → `exited`、absent → `session_not_running`。本文（最後の画面）は dead でも返す |
| `wait`（`wait.ts:635-645`、`:642` の `basis=session_gone`） | capture を読む | 一度動いて `isRunning=false` → `Completed (basis=session_gone)` exit 0（PM の決定 (b)、受け入れ）。一度も動いていない → NOT_STARTED |
| `kill-session`（`kill-session/route.ts:136-138`） | `isRunning` が false ならスキップ | `paneExists` で読む。dead pane も kill する。dead のときは各 driver の `requestExit`（終了のキー）を飛ばし、すぐ `kill-session` |
| `session-cleanup`（`session-cleanup.ts:264`） | 同じ | `paneExists` |
| `terminal` ルート（`terminal/route.ts:170`） | `isRunning` が false で 404 | 404 は absent のときだけ。dead pane への送信は §4 で not_sent |
| relay（`relay-readiness.ts:84`） | `isRunning` | `agentAlive`（自動で変わる）。dead → `session_stopped` で保留（作り直さない、今どおり） |
| 送信ルート（`send/route.ts:259`・`:305`） | `isRunning` | dead → `isRunning=false` → `startSessionForSend` → driver が respawn して起動（§5）。`refuseModelOnRunningSession`（`:259`）は `agentAlive` |
| auto-yes の poller（`auto-yes-poller.ts:1029` の `captureObservedFrame`） | 画面を直接読む | tick の最初に `pane_dead` を読み、dead なら答えない・数えない。読まなくても答えのキーは tmux が捨てる（表 3 の b）ので安全の穴ではないが、「答えた」と記録する誤りを防ぐ |
| 応答の poll（`cli-session.ts:101` の `isSessionRunning` = `sessionExists`） | セッションの有無 | dead → 走らせ続けない（`agentAlive` を読む） |
| UI の端末の生の入力（`direct-input`・`special-keys`・WebSocket の `terminal_input`, `ws-server.ts:1151`） | 生のキー | 変えない。dead pane へのキーは tmux が捨てる。UI は状態 `exited` を表示する（一覧の語） |

### 3.3 回答経路（参考）

`prompt-answer-sender.ts`（`respond`・`prompt-response`・auto-yes）は PM の決定 (c) で直さない。ただし新方式のペインでは、終わった後の残った画面にダイアログの型が当たっても、答えのキーは dead pane に捨てられ**シェルでは実行されない**（改訂 1 §5.3 の残りのうち、安全の部分は新方式で消える）。残るのは旧方式のペインと、「答えた」と誤る表示だけ（§10）。

## 4. 送信と Ctrl-Z（決定 (4)(9)）

### 4.1 なぜ各段の判定が要らなくなるか

新方式のペインで端末の入力を読むのは、CLI が生きている間は CLI（またはその exec の先）だけで、終わった後は tmux が入力を捨てる。判定と打鍵の間に CLI が終わっても、本文・改行・Enter はどれも**実行されない**（表 3 の b・e2）。だから改訂 1 の「打鍵の各段の直前に前面を確かめ、lease で同じ CLI を確かめる」（N2・N4 の対象）は安全のためには要らない。残るのは「届いたか」の正しさだけ（§4.2）。

### 4.2 送信の判定（新方式のペイン）

- 最初のキーの前（PR1 と同じ `recheckComposerBeforeInput`）: `readPaneState` が `dead` → not-sent（`agent-not-in-foreground`、PR1 と同じ理由、`detail: 'exited'`）。`absent` → 今の「セッションが無い」。`unknown` → not-sent（`agent-foreground-unknown`、新）。`alive` → `pane_pid` を控える。
- Enter（と再送）の後の読み戻しで `submitted` と言う前に、もう一度 `readPaneState`: `dead`、または `pane_pid` が控えと違う（respawn された）→ **indeterminate**（`agent-left-mid-send`、新）。dead pane では読み戻しの画面が変わらず、claude の読み戻しが「本文が入力欄に無い」＝`submitted` と誤るため（実測 b: send-keys は exit 0）。not_sent には戻さない（CLI が本文を読んだ後に終わった可能性がある）。
- 費用: 1 回の送信で `display-message` が 2 回。ps は使わない。
- 旧方式のペイン（印なし）: PR1 の判定（D）をそのまま使う（§8.4）。

### 4.3 理由と exit code

| 状態・段 | state | reason | 答え |
|---|---|---|---|
| dead（最初のキーの前） | not-sent | `agent-not-in-foreground`（PR1）、detail `exited` | 500＋`not_sent` → exit 99 |
| unknown（tmux が読めない） | not-sent | `agent-foreground-unknown`（新） | 同じ |
| Enter の後に dead・respawn | indeterminate | `agent-left-mid-send`（新） | 500＋`unknown`。再送してよいとは言わない。案内: 「本文の後に CLI が終わった。届いたかは capture の最後の画面で確かめる」 |

新しい exit 番号は作らない。`suspended`・`background`・`subshell`（改訂 1）は新方式のペインでは起きないので理由を足さない（旧方式は PR1 の 1 理由で断る）。

### 4.4 Ctrl-Z（実測 e・f・g）

- exec したペインでは CLI がペインのプロセス（`pane_pid`）で、端末のセッションリーダー・前面のグループのリーダー（`Ss+`）。親は tmux なので、そのグループは**孤立したプロセスグループ**で、端末からの SIGTSTP（Ctrl-Z）は捨てられる（POSIX の規定。実測 e: `cat` は `S` のまま、ペインに `^Z` が出ただけ。f: 自分に `kill -TSTP` しても止まらず次の行へ進んだ）。
- よって新方式では「Ctrl-Z で止まった CLI に送る／作り直す」状況（改訂 1 の `suspended`、P2-6）が起きない。利用者が Ctrl-Z を押しても CLI は止まらず、そのまま使える。CLI が Ctrl-Z を自分の機能（中断など）に使うなら、それは今どおり CLI の中で効く（本物の CLI では未確認）。
- 外から SIGSTOP で止めた場合（通常の操作ではない）: 止まっている間に打ったキーは端末の入力に溜まり、続きで CLI が読む。シェルには届かない。実測 g では macOS で `kill -STOP` の後も `ps` の状態が `T` にならず、`cat` がそのまま読んだ（理由は未解明、**未確認**）。止まっていれば準備の確認が通り読み戻しが誤りうるが、安全の穴ではない（§10）。
- 表示: 状態は alive（一覧・capture は今どおり）。止まっていることを表示する仕組みは足さない。

## 5. 既存の復旧（決定 (5)、N5）

すべての「再利用か起動か」の判断は、**最初と最後で同じ `readPaneState` を読む**（画面で終了を判定しない）。新方式のペインでは、ペインが alive なら CLI（またはその exec の先）がいる、dead なら終わった、が tmux の事実で決まる。

| 復旧 | 場所 | 新方式 |
|---|---|---|
| #2070 の send 前の relaunch | `relaunchIfToolExited`（`base.ts:780`）が `isToolLive`（画面）を読む | `readPaneState` が alive → 何もしない（画面を読まない）。dead → `startSession` へ。旧方式のペイン → 今の画面の判定 |
| 起動の再利用の判断 | `resolveLaunchPane` の `isToolLive(…, { confirm: true })`（`base.ts:897`） | 同じ `readPaneState`。alive → 再利用、dead → `respawn-pane -t <pane> -c <cwd>`（`-k` なし）→ 起動行。dead から alive に変わっていた（別の要求が先に起動した）なら tmux が respawn を断るので、再読して再利用（起動の印 `session-launch-flight` が普通は先に止める） |
| opencode V1 の再利用 | `opencode.ts:393` | 同じ。dead → respawn して `-s <id>` で再開（今の再開の仕組み） |
| opencode V2 の再利用 | `opencode-v2.ts:266`（dead のときは `releaseOpencodeV2Server` してから） | 同じ |
| codex の #2068（`Update now` の後の打ち直し） | `relaunchIntoSamePane`（`codex.ts:334-339`） | codex が更新して終わるとペインは dead になる（今はシェルに戻る）。打ち直しの前に respawn する。待ちの間に dead を読めば待たずに打ち直しへ |
| copilot・antigravity の「同じペインに打ち直す」（#2070 のコメント `copilot.ts:519`・`antigravity.ts:314`） | `createLaunchPane` を飛ばして打つ | dead なら respawn してから打つ（共通の `resolveLaunchPane` の結果に `respawn` を持たせ、driver は呼ぶだけ） |
| claude の `ensureHealthySession` | `claude-session.ts:708`。不健康なら kill して作り直す（`:884-893`） | dead → 不健康と同じ経路（kill して作り直す）。alive → 今の画面の健康の判定（終了の判定には使わない） |
| ルートの `startSessionForSend` | `send/route.ts`、`send-session-start.ts:93` | dead で `isRunning=false` → 今どおり呼ぶ。中で上の driver の経路 |
| タイマー・relay | `timer-manager.ts:110`・`relay-delivery.ts:611` | タイマー: non-claude は driver の relaunch で復旧（今どおり）、claude は断る（今どおり）。relay は保留（今どおり） |

- 起動の途中で CLI が終わった（認証の失敗・PATH に無い）: 各 driver の準備待ちが `pane_dead=1` を読めたら時間切れを待たずに失敗にし、最後の画面の数行と `pane_dead_status` をエラーに載せる（今は 60 秒ほど待って exit 99）。
- `respawn-pane` は履歴を消さない（表 3 の a: 前の CLI の出力が履歴に残った）。履歴の上限（#1624）は同じペインなので保たれる。#2958（rc の途中でシェルを殺す）は、dead pane にはシェルがいないので当たらない。

## 6. relaunched の通知（決定 (6)、N7）

- 起動の結果 `LaunchOutcome = 'created' | 'reused' | 'replaced' | 'joined'` を起動の印（`session-launch-flight.ts`）に残す。`replaced` は「入る前のペインが dead（新方式）、または旧方式で終了と判定されて起動し直した（#2070・claude の作り直し）」とき。
- ルートは送信の後（成功・失敗とも）に `takeLaunchReplacedNotice({ worktreeId, instanceId })` で読む（`send/route.ts:462` の `takeOpencodeResumeNotice` と同じ形。「driver が送信の中で起動し直しうるので最後に読む」）。だから **`send-user-message.ts` を変えずに**、ルートの起動（`startSessionForSend`）と driver の中の relaunch の両方を拾える。
- 答え: `relaunched: true`。成功（201）にも失敗（500、not_sent／indeterminate）にも載せる。並行の送信が同じ起動に合流した（`joined`）ときは合流先の結果を見る。
- CLI（`message-dispatch.ts`）は exit の前に stderr に 1 行: `Note: the previous <tool> session in <session> had exited (status <n>); a new session was started and the previous conversation was not carried over (Issue #4300).`。claude で前の画面から `claude --resume <id>` が読めたら、続けて `Previous conversation: claude --resume <id>` を出す（§6.1）。
- **復旧の変更（§5）と同じ PR（PR2a）に入れる**。PR2a 単体で、置換して成功・置換後に失敗（not_sent／indeterminate）・並行の 2 本・初回起動（false）・再利用（false）を検証する（§7.3）。旧方式の #2070 の relaunch にも PR2a から通知が付く（N7: driver の再起動は今もあるので、通知を後回しにしない）。

### 6.1 `Resume this session with:` と利用者への影響（決定 (7)）

| 場面 | 今 | 新方式 |
|---|---|---|
| CLI が終わった直後の capture・UI の端末 | 最後の画面と Resume の行、シェルのプロンプト | 最後の画面と Resume の行、その下に `Pane is dead (status 0, <時刻>)`（表 3 の b2）。シェルのプロンプトは無い |
| ペインで続きを打つ | シェルで `claude --resume <id>` を打てる | **できない**（dead pane は入力を捨てる）。`commandmate send` で新しい会話として起動し直すか、`commandmate stop` してから起動する |
| 次の送信で起動し直した後 | claude は kill して作り直す（Resume の行は消える）。non-claude は同じペインに打つ（履歴に残る） | 同じ（non-claude は respawn で履歴に残る）。claude は relaunched の 1 行に `claude --resume <id>` を添える（§6） |
| 運用の手当て（`pane-ok.sh`） | 末尾の Resume・シェルのプロンプトを見る | dead pane は `Pane is dead` の行で分かる。手当ての版を足す（運用、この設計の外） |

続きの会話を CommandMate から再開する（`--resume` を起動行に付ける）機能はこの Issue では作らない（§10）。

## 7. テストの設計

### 7.1 状態の単体（`tests/unit/tmux/pane-state-4300.test.ts`）

`execFile` の mock に `display-message` の出力を与える: `0\t<pid>\texec` → alive／`1\t…` → dead／`can't find session` → absent／時間切れ・形違い → unknown。一括（`listSessions`）の `#{pane_dead}`・`#{@cm_launch}` の読み取り。

### 7.2 送信（PR1 の表駆動に足す）

- `CLI_TOOL_IDS` の全員で、各 CLI の準備条件を満たした同じ画面（入力欄が空いている）に対し、状態だけを変える: alive＋印 → 送る（陽性対照: 判定を外すと dead でも各 CLI で send-keys が 1 回以上出て、claude は `submitted` と誤る）／dead → send-keys・paste-buffer・load-buffer が 0 回、`agent-not-in-foreground`（detail `exited`）／unknown → 0 回、`agent-foreground-unknown`。
- Enter の後の確認: 読み戻しの直前に dead、または `pane_pid` が変わる → indeterminate（`agent-left-mid-send`）、not_sent に戻らない。対照: alive のまま → `submitted`。
- 印の無いペイン（旧方式）: PR1 の判定がそのまま効く（PR1 のテストを変えない）。印のあるペインでは D を呼ばない（表 3 の h の fixture: `bash` が pane_pid で tpgid と同じでも送る）。
- 実 tmux（`-L` の私設ソケット、`process.env.TMUX` を私設サーバへ向け、向いていることを assert）の結合テスト: exec 起動の代わりのプロセス（`exec env cat`）を終わらせた dead pane へ送り、改行入りの本文でファイルが作られないこと（表 3 の b・e2 の再現）。

### 7.3 復旧と relaunched（PR2a）

- `base.ts`: alive → 画面を読まず再利用／dead → `respawn-pane`（`-k` なし）→ 起動行（1 回）／旧方式で画面が終了 → 今どおり（`session-relaunch-2070.test.ts` の期待は変えない）。
- 最初の判定と最後の再利用が同じ `readPaneState` を読むこと（N5）: 終了の画面なのに alive → 再利用（画面を見ない）、`❯` が残る画面なのに dead → respawn（claude の誤りの再現の陽性対照）。
- opencode V1/V2・codex #2068・claude の `ensureHealthySession`: dead → それぞれの起動し直し、alive → 再利用。
- `relaunched`: 初回起動 → false／再利用 → false／置換して成功 → true／置換後に失敗 → true と not_sent・indeterminate／並行 send の 2 本 → 両方 true で起動は 1 回。stderr の 1 行は `message-dispatch` のテストで成功と exit 99 の両方、claude の `--resume` の行は画面に id があるときだけ。

### 7.4 読み手とガード

- 状態: `worktree-status-helper` と `current-output-builder` の実際の応答を全 CLI で: dead → `isRunning=false`・`exited`／absent → `session_not_running`／alive → 今どおり。
- 停止・片付け（N6 の対照）: 旧方式のシェルのペイン（今どおり）、dead pane（kill する、終了のキーを打たない）、セッション無し（スキップ）。terminal ルート: dead → 404 にしない、absent → 404。
- `wait`: 動いた後の dead → `session_gone` exit 0、一度も動いていない → NOT_STARTED。
- auto-yes: dead pane の画面にダイアログがあっても答えない。
- ガード（`tests/unit/guards/`）: (i) `typeLaunchLines` に渡る起動行の文字列が全部 `exec env ` を含む（例外は `unset CLAUDECODE`）、(ii) 起動行を打つ番の中で `remain-on-exit on` が起動行より先、(iii) `isRunning(` を読むファイルの一覧を固定し、`hasSession` を「動いている」と読む所が増えたら見直しを強いる、(iv) `respawn-pane` に `-k` を付ける呼び出しが `src/lib` に増えない（今の `respawnLoginShell`, `tmux.ts:397` だけ許す）。
- 既存のテスト: tmux を部分的に mock したテストが `readPaneState` の unknown で断るようになって落ちる場合は、共通の mock（`tests/helpers`）に alive を返す既定を足す。起動行を固定するテストの期待の変更は PR2b の契約で許す（§8.3）。

## 8. PR2 の範囲

### 8.1 書くファイル（予定）

- 起動行: `src/lib/hooks/sources/launch-command.ts`（`renderAgentLaunchCommand` に `exec env`）、`src/lib/session/launch-screen.ts`（コメントの「the shell stays the agent's parent」を改める）、`src/lib/cli-tools/vibe-local.ts`（手組みの行）、`src/lib/cli-tools/launch-keys.ts`（remain-on-exit を同じ番で撃つ）
- tmux: `src/lib/tmux/tmux.ts`（`readPaneState`・`respawnLaunchPane`・`setPaneLaunchMarker`・`listSessions` の `-F`）
- 復旧: `src/lib/cli-tools/base.ts`（`relaunchIfToolExited`・`resolveLaunchPane`・`createLaunchPane` の隣に respawn）、`src/lib/session/claude-session.ts`（`isClaudeRunning`・`ensureHealthySession`）、`src/lib/cli-tools/opencode.ts`・`opencode-v2.ts`（再利用）、`codex.ts`（#2068）、`copilot.ts`・`antigravity.ts`（コメントと respawn の呼び出し）、`src/lib/session/session-launch-flight.ts`（`LaunchOutcome`）
- 送信: `src/lib/session/composer-clear.ts`（最初の判定）、`src/lib/cli-tools/submit-verified-sender.ts`（Enter の後の確認）、`src/lib/session/send-attempt-types.ts`・`send-attempt-state.ts`（理由 2 つ）
- 読み手: `src/lib/session/worktree-status-helper.ts`、`src/lib/cli-tools/session-liveness.ts`、`src/lib/session/current-output-builder.ts`、`src/app/api/worktrees/[id]/kill-session/route.ts`、`src/lib/session-cleanup.ts`、`src/app/api/worktrees/[id]/terminal/route.ts`、`src/lib/auto-yes-poller.ts`、`src/lib/session/cli-session.ts`
- ルートと CLI: `src/app/api/worktrees/[id]/send/route.ts`（`relaunched`）、`send-failure.ts`、`src/cli/commands/message-dispatch.ts`（stderr の 1 行）、`src/cli/types/`（答えの型）
- 文書: `docs/user-guide/cli-operations-guide.md`（dead pane・relaunched・wait の `session_gone`。ja/en があれば両方）、`changelog.d/4300.md`（PR1 の断片に追記）、module-reference の断片
- テスト: §7 の各ファイル、PR1 の表駆動・ガード

### 8.2 G-PR3（`send-user-message.ts` の S-B）との重なり

**重ならない**。PR2 は `src/lib/session/send-user-message.ts` を変えない: relaunched はルートが送信の後に起動の印から読み（§6）、送信の判定は `composer-clear.ts`・`submit-verified-sender.ts` の中（§4.2）。PR1 の早い拒否（send-user-message.ts）はそのまま残る。順序の制約は「PR1 → PR2」だけで、G-PR3 とは並行してよい。PR2 の契約に「`send-user-message.ts` は変えない」を書く。

### 8.3 PR の分け方（推奨）

| PR | 中身 | 単体での振る舞い | 依存 |
|---|---|---|---|
| **PR2a 読み手と復旧と通知** | `readPaneState`・`paneExists`／`agentAlive`、§3 の読み手全部、§5 の復旧（dead なら respawn）、§6 の `relaunched` と stderr、§4.2 の dead・unknown・Enter の後の確認、`LaunchOutcome` | dead pane はまだ通常の起動では生まれない（remain-on-exit を付けていない）。テストでは隔離 tmux で作った dead pane と fixture で確かめる。旧方式の #2070 relaunch と claude の作り直しに **relaunched の通知がここで付く**（N7） | PR1 のマージ後 |
| **PR2b exec 起動** | 起動行の `exec env`（§2.2）、remain-on-exit と印（§2.4）、印のあるペインで PR1 の判定を外す（§8.4）、起動の途中の dead を早く失敗にする、起動行を固定するテストの期待の更新、文書 | これで新しいセッションは全部新方式。読み手と復旧は PR2a で dead pane を読めるので、読み違いの期間が無い | PR2a のマージ後 |

分ける理由: (i) どの時点でも「dead pane を読めない読み手」が無い（PR2a が先に読めるようにし、PR2b が初めて dead pane を生む）。(ii) 復旧の変更と通知が同じ PR（N7）。(iii) PR2b は起動行の形を変えるので、起動行を固定している既存のテスト（`git grep -l 'clear 2>/dev/null\|withLaunchScreenCleared' -- tests` で 14 ファイル、`renderAgentLaunchCommand\|buildAgentLaunchCommandLine` で 28 ファイル）の期待を変える。**期待を変えることを PR2b の契約で許す**（作業ルールの「既存の期待を変えない」の例外。PM の決定が要る）。1 本で出すなら §8.1 の全部。

### 8.4 既存のセッションの移行（決定 (8)）

- 強制の再起動はしない（稼働中の会話を捨てない）。旧方式のペインは印 `@cm_launch` が無いことで分かる（表 3 の l。一括の `list-sessions -F` でも読める）。
- 旧方式のペイン: 送信は PR1 の判定（D）、読み手は今の画面の判定に PR2a の `pane_dead` を重ねる（旧方式のペインは remain-on-exit が無いので dead にならず、シェルの `exit` ならセッションごと消える＝absent）。**旧方式の間の残りのリスク（判定の後に終わる競合、N3）は PR1 の残りとして続く**。
- 新方式へ移る点: (i) 利用者の stop → start、(ii) 旧方式の CLI が終わって次の送信で #2070 の relaunch が起動行を打つとき（その起動行は exec で、直前に remain-on-exit を付けるので、そのペインはその場で新方式になる。シェルは残らない）、(iii) claude の作り直し（kill して新しいセッション）、(iv) サーバーの再起動では移らない（tmux のセッションは残る）。
- 新方式のペイン（印あり）: PR1 の判定（D）は**当てない**（表 3 の h: exec した非 exec ラッパーを `shell` と誤る）。判定は §4.2。
- 混在の期間の表示: 一覧・capture は両方式とも同じ語（`exited`・`session_not_running`）を出す。

## 9. 実機で決まること（隔離した tmux で確かめた）

手順（表 3）: `mktemp -d "$TMPDIR/c4300r2.XXXX"` の中に仮の HOME（`.zshrc` に `export PATH="$HOME/fakebin:$PATH"; export RC_LOADED=yes`、`fakebin/fakecli` は `echo …; exec sleep 300` の sh スクリプト）を作り、`env -i HOME=<仮> PATH=/usr/bin:/bin:/opt/homebrew/bin TERM=xterm SHELL=/bin/zsh tmux -L c4300r2x -f /dev/null …`。セッションは本番と同じ順（`new-session … sleep 2147483647` → `new-window -k -c <dir>` → 必要なら `set-option -p remain-on-exit on`）で作った。最後に各セッションを `kill-session -t '=<name>:'`、`-L c4300r2x kill-server`、ソケットと dir を消した。既定の tmux サーバー・稼働中の `mcbd-*`・サーバーには触れていない。本物の CLI は起動していない（代わりのプロセス: `sleep`・`cat`・`sh -c`・`bash` スクリプト）。

### 表 3（2026-11-10、tmux 3.5a、macOS、ログインシェル zsh）

| 記号 | 状況 | 結果 |
|---|---|---|
| a | `… exec env FOO='a b' fakecli`（remain-on-exit on） | `pane_pid` が CLI 自身（`Ss+ sleep`、pid = pane_pid = pgid = tpgid）。CLI の出力 `fakecli PATH-ok RC=yes FOO=a b`（rc の PATH・変数・代入が届いた）。CLI を kill → `pane_dead=1`、`has-session` は成功、画面の最後に `Pane is dead (signal term, …)`。dead の `pane_current_command` は `zsh` のまま。`respawn-pane`（`-k` なし）→ rc=0、alive、新しい pid、**前の CLI の出力が履歴に残った**。respawn 後も `remain-on-exit` は on で、再び exec して kill → dead |
| b | remain-on-exit **なし**で `exec env sh -c '…; exit 0'` | CLI の終了でセッションごと消えた（`can't find session`） |
| b2 | remain-on-exit on で同じ（Resume の行を出して exit 0） | `pane_dead=1`・`pane_dead_status=0`、画面に `Resume this session with:`・`claude --resume X`・`Pane is dead (status 0, …)` |
| b（送信） | dead pane へ `send-keys -l 'echo … > <file>'` と `Enter` | どちらも **exit 0**。ファイルは作られず、画面も変わらない（入力は捨てられる） |
| c | 生きているペインへ `respawn-pane`（`-k` なし） | `respawn pane failed: pane … still active`、rc=1 |
| c | zsh で `exec nosuchcli-4300` | `command not found`、シェルも終わり dead（status 127） |
| c2 | zsh で `exec env nosuchcli-4300` | `env: …: No such file or directory`、dead（127） |
| c3 | **bash** の対話シェルで `exec nosuchcli-4300` | **シェルが残った**（`pane_dead=0`） |
| c4 | 同じ bash で `exec env nosuchcli-4300` | dead（127） |
| e | `exec env cat` に Ctrl-Z（`send-keys C-z`） | `cat` は `Ss+` のまま（止まらない）。画面に `^Z` |
| e2 | 同じペインへ改行を含む本文（`touch <f1>⏎touch <f2>`）と Enter | `cat` が行をそのまま返しただけ。**ファイルは作られない** |
| f | `exec env sh -c 'kill -TSTP $$; echo AFTER_TSTP; sleep 300'` | 止まらず `AFTER_TSTP` が出た（孤立したグループの SIGTSTP は捨てられる） |
| g | `exec env cat` に外から `kill -STOP` | `ps` の状態は `Ss+` のまま、打ったキーを `cat` が読んだ。macOS で STOP が効かなかった理由は未解明（**未確認**） |
| h | `exec env <bash スクリプト（sleep を子で起動、exec しない）>` | `pane_current_command=bash`、`/bin/bash` の pid = pgid = tpgid = pane_pid、子の sleep は同じグループ。**PR1 の D はこれを `shell` と読む**（誤って断る） |
| l | `set-option -p @cm_launch exec` と `list-sessions -F '#{session_name} #{pane_dead} #{@cm_launch}'` | 印は `#{@cm_launch}` で読め、印の無いペインは空。`pane_dead` も一括で読めた。dead pane どうしで `pane_tty` が同じ値になった（使い回し） |
| m | `respawn-pane … "exec env sleep 300"`（pane command の形、F-1） | `pane_start_command` に入り、`default-shell -c` で走る。`.zshrc` の `RC_LOADED` が CLI の環境に**無かった**（rc を読まない） |
| n | `FOO=bar exec env sh -c 'echo $FOO'`（zsh -f・bash --norc・sh） | 3 つとも `FOO=bar`。bash で `FOO="$(echo s3cr)" exec env …` も届いた。zsh で `FOO=bar exec nosuch` はシェルが終わる |

未確認（本物の CLI で確かめる、PR2b の UAT）: 各 CLI を exec 起動して終わらせたときの dead pane の画面と終了の状態、claude の Ctrl-Z の扱い、codex の `Update now`（#2068）の後に dead になること、fish をログインシェルにした利用者（手元に fish が無い）、Linux の tmux。

### 表 1・表 2（改訂 1、旧方式のペインの判定の根拠）

旧方式のペイン（PR1 の D が守る）の判定の根拠として残す。手順は改訂 1 と同じ（`tmux -S <dir>/s`、`zsh -f -i`、pane_pid=86183）。

| 記号 | 状態 | pane_current_command | tpgid | 前面のグループ | ほかのグループ | D | E（採らない） |
|---|---|---|---|---|---|---|---|
| a | 何も動いていないシェル | `zsh` | =pane_pid | zsh `Ss+` | なし | shell | exited |
| b | `sleep`（CLI の代わり） | `sleep` | 別 | sleep `S+` | — | other | agent |
| c | 非 exec の bash ラッパー → sleep | `bash` | 別 | `/bin/bash`・sleep | — | other | agent |
| d | 対話のサブシェル（`bash -i`）が入力待ち | `bash` | 別 | bash だけ | — | **other（誤り）** | subshell |
| e | サブシェルの中で sleep | `sleep` | 別 | sleep | bash | other | agent |
| f | `set +m` の後 sleep を前面に | `zsh` | =pane_pid | zsh・sleep（同じ） | なし | **shell（誤り）** | unknown |
| g | `set +m` の後 `sleep &` | `zsh` | =pane_pid | zsh・sleep（同じ） | なし | shell | unknown |
| h | ジョブ制御有効で `sleep &` | `zsh` | =pane_pid | zsh | sleep（別） | shell | background |
| i | sleep を Ctrl-Z | `zsh` | =pane_pid | zsh | sleep `T` | shell | suspended |
| j | `fg` の後 | `sleep` | 別 | sleep | — | other | agent |
| k | 子が終わった後 | `zsh` | =pane_pid | zsh | なし | shell | exited |

表 2: `node -e`・`npx --no-install node -e`・exec する bash ラッパーは、どれも `tpgid ≠ pane_pid`（D は other）。

## 10. 未確認・残り

- 本物の CLI での表 3 の再確認（§9 の未確認）。PR2b の UAT で、各 CLI を exec 起動 → 終わらせる → capture・一覧・send（not_sent）・次の send（relaunched）・stop を確かめる。
- 旧方式のペインの間の残り（PR1 の残り）: 判定の後に CLI が終わる競合、改行を含む本文の先頭行の実行（N3）。新方式に移るまで続く（§8.4）。
- 回答経路（`prompt-answer-sender.ts`）: 旧方式のペインでは改訂 1 §5.3 のとおり残る。新方式では安全の穴は消え、dead pane への「答えた」の誤りだけ（auto-yes の poller は §3.2 で dead を飛ばす。`respond` は直さない）。
- CLI 自身が対話シェルを子として開く機能（CLI の中の「シェルに入る」操作）があれば、その間の送信はそのシェルに届く。CommandMate の起動の問題ではなく CLI の中の操作なので対象外（見立て、各 CLI の機能は未確認）。
- 非 exec のラッパーが CLI を中で起動し直す場合（N2 の例）、本文は新しい CLI に届く（シェルではない）。安全の穴ではない。会話が変わったことは通知されない（`pane_pid` が変わらない）。
- 外から SIGSTOP で止まった CLI（§4.4、実測 g が未解明）: 読み戻しが `submitted` と誤りうる。通常の操作では起きない。
- CommandMate から続きの会話を再開する機能（`claude --resume` を起動行に付ける）は作らない。必要なら別 Issue。
- `wait` の `session_gone` に終了の状態（`pane_dead_status`）を載せるかは PR2b の契約で決める（今は載せない）。
- tmux の最低版（`set-option -p` は 3.0 以降の見立て）。古い tmux では `-w`（窓の選択肢、1 窓 1 ペインなので同じ効果の見立て、未確認）。

## 11. 指摘ごとの処置

### 11.1 再確認（`review-4300b.md`、codex-2）の N1〜N7

PM の決定: `pm-return-4300-design-rev1.md` の (a)（exec 起動で根の原因を消す）。

| # | 指摘 | 新方式で | 理由 | 入れた節 |
|---|---|---|---|---|
| N1／P1 | E の「非シェルがいる」は対象 CLI の証拠にならない（補助プロセス・サブシェル内の Ctrl-Z） | **消える** | 前面を推し量らない。新方式のペインには入力を読むシェルがどの時点にもおらず、CLI の終了は tmux の `pane_dead`（親としての tmux が見た事実）で決まる。サブシェルも Ctrl-Z の停止も起きない（表 3 の e・f）。E は「採らない」として §2.1 に残す | §2.1、§3.1、§4.1 |
| N2／P1 | lease＝`tpgid` では同じ CLI の寿命を識別できない | **消える**（安全の面）。正しさの面は `pane_pid` で十分 | 寿命の識別が要ったのは、別の寿命に打つとシェルが実行しうるため。新方式ではどの寿命に打ってもシェルには届かない。respawn は `pane_pid` が変わる（表 3 の a）ので Enter の後の確認（§4.2）で indeterminate にする。非 exec ラッパーの中の再起動は残り（§10、安全の穴ではない） | §4.2、§10 |
| N3／P1 | 改行を含む本文は本文の送信だけでシェルが先頭行を実行しうる。「Enter を止めれば実行されない」は誤り | **新方式で消える。旧方式では残る** | 新方式では改行を読んで実行するシェルがいない（表 3 の e2: 改行入りの本文が実行されない、b: dead pane は入力を捨てる）。旧方式のペインの間は PR1 の残りとして changelog.d と PR 本文に明記（PM の決定）。改訂 1 の「Enter を止めれば実行されない」の記述は削った | §0.2、§4.1、§8.4、§10 |
| N4／P1 | 各段の表に、キーを出す内部の経路（空けの反復・撤回・copilot の一括送信）が足りない | **消える** | 各段の判定そのものを安全のためには使わない（§4.1）。どの内部の経路のキーも、シェルではなく CLI か捨て先に届く。正しさのための確認は最初のキーの前と Enter の後の 2 回だけ（§4.2）で、内部の経路を列挙しない | §4.1、§4.2 |
| N5／P2 | 非 claude の最後の再利用の判断（`base.ts:897`・opencode・opencode V2）が旧い画面の判定のまま | **消える** | 最初の判定（`relaunchIfToolExited`）と最後の再利用（`resolveLaunchPane`・opencode V1/V2・claude の `ensureHealthySession`）が同じ `readPaneState` を読み、新方式のペインでは画面で終了を判定しない。dead からの復旧は `respawn-pane`（`-k` なし）で、生きたペインには tmux が断る（表 3 の c） | §5 |
| N6／P2 | `pane_dead=1` とペイン不在をまとめると停止・清掃が漏れる | **採る（分けた）** | alive／dead／absent の 3 つにし、停止・片付け・terminal の 404 は `paneExists`（dead を含む）、送信・状態・relay は `agentAlive`。dead pane の停止では終了のキーを飛ばす。対照: 旧方式のシェル、dead pane、セッション無し（§7.4） | §3 |
| N7／P2 | PR2a で復旧を変えるなら通知を PR2b まで延ばせない | **採る** | 復旧（§5）と relaunched（§6）を同じ PR2a に入れた。旧方式の #2070 の relaunch にも PR2a から通知が付く。PR2a 単体で置換の成功・置換後の失敗・並行の送信を検証 | §6、§8.3 |

### 11.2 最初の事前レビュー（`review-4300.md`）P1-1〜P2-10 の今の扱い

改訂 1 の処置のうち、新方式で形が変わったもの:

| # | 改訂 1 の処置 | 改訂 2 |
|---|---|---|
| P1-1 判定後の終了・再作成 | 各段の判定と lease | 新方式では届く先がシェルでなくなる（§4.1）。正しさは最初と Enter の後の確認（§4.2）。旧方式は PR1 |
| P1-2 unknown | 断る | 同じ（`readPaneState` の unknown を断る） |
| P1-3 D の誤判定 | E を採用 | E は採らない。新方式は判定に推測を使わない。D は旧方式のペインだけ |
| P1-4 capture の実経路 | `isRunning`＝`agentAlive` | 同じ（dead → `exited`） |
| P2-5 既存の復旧 | 種類を読む | `readPaneState` を読む（§5、N5） |
| P2-6 一時停止 | `suspended` で断る | 新方式では Ctrl-Z で止まらない（§4.4）。旧方式は PR1 で断る（作り直さない） |
| P2-7 停止・cleanup | `paneExists` | 同じ（dead を含む、N6） |
| P2-8 auto-yes の説明 | 訂正 | 新方式では答えのキーもシェルに届かない（§3.3） |
| P2-9 入口・各 CLI の対照 | 入口の表 | 入口ごとの拒否／復旧は §5 の表と同じ。全 CLI の陽性対照は §7.2 |
| P2-10 relaunched | `replaced` のとき | 同じ。PR2a に移した（N7） |

PM の設計の決定 (a)〜(e)（`pm-return-4300-design.md`）: (a) relaunched と stderr の 1 行 → §6。(b) wait の変化を受け入れる → §3.2。(c) 回答経路は直さない → §0.3・§3.3・§10。(d) G-PR3 との重なり → §8.2（重ならない）。(e) 事前レビューは codex-2 → この改訂の後、差分だけ再確認を受ける。

## 12. #4303 の経路（回答の送信、src/lib/prompt-answer-sender.ts）への効き目

#4303（`respond`・`prompt-response`・auto-yes の回答が、CLI の終わったペインへキーを打ち込みうる）が、改訂 2 の exec 起動（§2）で同時に塞がるかを経路ごとに見る。この Issue（#4300）では回答経路を直さない（PM の決定 (c)）。ここは #4303 の設計の入力。

### 12.1 経路とキーを出す所（事実、`ed9b89eac`）

| 経路 | 入口と前の確認 | 回答を送る所 |
|---|---|---|
| `respond`（CLI・UI） | `src/app/api/worktrees/[id]/respond/route.ts:315`。前に `screenAtSend`（`:312`）で画面を読む。`isRunning` は読まない | `sendPromptAnswer`（`src/lib/prompt-answer-sender.ts:959`） |
| `prompt-response`（UI のカード） | `src/app/api/worktrees/[id]/prompt-response/route.ts:117` の `cliTool.isRunning`（claude は画面の健康、ほかは `hasSession`）→ `frame-verification.ts:83` の画面の再読 → `answer-delivery.ts:179` | 同じ |
| auto-yes | `src/lib/auto-yes-poller.ts:1029` の `captureObservedFrame`（画面を直接読む）→ `:919` | 同じ |

`sendPromptAnswer` の中でキーを出す所: Command Code の複数選択（`sendCommandCodeMultiSelectAnswer`, `:517`）、claude・antigravity の矢印の選択（`sendSpecialKeysWhileCurrent`, `:1111` → `:842`・`:856`。AskUserQuestion で既定の選択肢なら `['Down', 'Up', 'Enter']`, `:1100-1102`）、文字の答え（`sendKeys(sessionName, answer, false)`, `:1118`）と Enter（`:1153`）、Enter を抑える答え（`:1129`、入力ロックの外）。ロックの中の再読は `answerTargetStillOnScreen`（`:657`）で、画面にダイアログが残っていれば通る。前面のプロセス・`pane_dead` を読む所は無い（strict respond の `agentExitedToShell`, `src/lib/prompt-observation/strict-respond.ts:318` は送った後の indeterminate の判定だけ）。

### 12.2 実測（隔離した tmux、2026-11-10）

手順は §9 と同じ（`tmux -L c4303x -f /dev/null`、`env -i`、仮 HOME、本番と同じ順でセッションを作る）。後始末は各セッションを `kill-session -t '=<name>:'`、`-L c4303x kill-server`、dir とソケットを消した。既定のサーバー・`mcbd-*` には触れていない。本物の CLI は起動していない。

| 記号 | 状況 | 結果 |
|---|---|---|
| p | 旧方式のペイン（シェルのプロンプト）で `touch <f>` を実行し、外から `<f>` を消してから、回答のキー `Down Up Enter` | **`<f>` がまた作られた**（`Up` が直前のコマンドを呼び出し、`Enter` で実行）。続けて `1`＋`Enter` → `zsh: command not found: 1`（シェルが実行した） |
| r | 新方式の dead pane へ `Down Up Enter` と `y` | どちらも exit 0、何も起きない（入力は捨てられる） |
| q | 新方式で、CLI の代わりが子（`sleep &`）を残して終わる | `pane_dead=1`（子が端末を持っていても、ペインのプロセスが終われば dead）。子は後始末の前に消えていた（見立て: ペインが閉じた端末の SIGHUP） |
| q3 | 同じく、端末を読む子（`(sleep 1; exec cat) &`）を残して終わる | `pane_dead=1`。`y`＋`Enter` は子に届かず（画面に出ない）捨てられた |

### 12.3 塞がる経路・塞がらない経路

| 状況 | 新方式で | 理由 | #4303 で要るもの |
|---|---|---|---|
| 新方式のペインで CLI が終わった（dead pane）。残った画面にダイアログ | **塞がる**（安全） | 答えのキー（数字・`y`・矢印・自由記述・Enter）はどれも捨てられる（r）。3 経路とも同じ `sendKeys`／`sendSpecialKeys` を通る | 届いたと誤らないこと: 最初のキーの前に `readPaneState` が dead なら未送信（`PromptAnswerNotDeliveredError`）、auto-yes は答えずに記録する。`prompt-response` は PR2a で `isRunning`＝`agentAlive` になり `:117` で 400 になる（`respond`・auto-yes は自前の確認が要る） |
| 新方式でセッションが消えた（absent） | **塞がる** | tmux が `can't find session` で失敗し、何も打たれない | 未送信として返ること（`transportDeliveryOf`, `:783` の分類）をテストで固定するだけ |
| 新方式で CLI が終わり、端末を持つ子が残る | **塞がる** | ペインは dead になり、子にもキーは届かない（q・q3） | なし（上の dead の確認に含まれる） |
| 新方式で CLI は生きていて、古い画面のダイアログの検出に当たり、CLI の中で別のプロセス（エディタ・ページャ・ツールの子）が端末を読んでいる | **塞がらない**（ただしシェルではない） | exec はシェルを消すだけで、生きた CLI とその子への誤った答えは変えない。答えはその子に届く | 今の `answerTargetStillOnScreen`（`:657`）の再読と `stillCurrent` を保つ。子が対話シェル（CLI の「シェルに入る」機能）なら実行されうる — 各 CLI にその機能があるか**未確認**。あれば前面が CLI 自身かを見る判定を回答の前に足す |
| 新方式で Ctrl-Z | **塞がる**（起きない） | CLI は止まらない（§9 表 3 の e・f） | なし |
| 新方式の起動の途中（respawn の後、`exec` の前はシェルが前面）に、前の画面のダイアログを読む | **塞がらない**（窓は短い） | respawn は履歴を残す（§9 表 3 の a）。起動行の `clear; printf '\033[3J'` までは前の画面が見えうる（respawn 直後に見える画面に前のダイアログが残るかは**未確認**）。gemini・copilot・antigravity の起動の窓（`launch-window.ts`・`antigravity-startup-trust.ts`）以外では auto-yes は起動中を避けない | 回答の前に、起動の印（`session-launch-flight` の起動中）と印 `@cm_launch` の無いペインでは答えない（`readPaneState` と同じ 1 回の `display-message` で読める） |
| 移行期間の旧方式のペインで CLI が終わった（シェルのプロンプト、画面にダイアログが残る） | **塞がらない** | シェルが残る。`Down Up Enter` で直前のコマンドが再実行され（p）、数字・`y`＋Enter はコマンドとして実行される | 回答の最初のキーの前（矢印の束・文字・Enter の各 `sendKeys`／`sendSpecialKeys` の前）に PR1 の判定（D: シェルなら未送信）を通す。矢印の答えは本文より危ない（履歴の再実行）ので、表駆動で claude・antigravity の矢印の経路を陽性対照に入れる |
| 移行期間の旧方式のペインで Ctrl-Z で止まった CLI（シェルが前面） | **塞がらない** | 上と同じくシェルが受け取る | 同じ PR1 の判定（D は `shell` と読む、§9 表 1 の i）。止まった CLI を kill・作り直ししない |
| 移行期間の旧方式で、判定の後に CLI が終わる競合 | **塞がらない** | PR1 の残り（N3 と同じ系統） | 受け入れる（新方式に移るまで）。#4303 の changelog に残りとして書く |

### 12.4 まとめ

- 新方式のペインでは、#4303 の安全の穴（答えのキーがシェルで実行される）は exec 起動で同時に塞がる。#4303 の中身は「dead・absent・起動中を未送信として返し、auto-yes が答えたと記録しないこと」の確認とテストになる（#4303 の本文の見込みどおり）。
- 塞がらないのは、(i) 移行期間の旧方式のペイン（PR1 の判定を回答経路にも通すことが要る。矢印の答えは履歴を再実行するので優先）、(ii) 起動の途中の短い窓、(iii) 生きた CLI の子への誤った答え（シェルではない。CLI の「シェルに入る」機能の有無は未確認）。
- 本文に無い指摘（#4303 の範囲で見るもの）: 文字の答えは `sendKeys(sessionName, answer, false)`（`:1118`）で `literal` を付けていない。答えが `Enter`・`C-c` などキー名と同じ文字列なら tmux がキーとして解釈しうる（`SendKeysOptions.literal` の説明、`tmux.ts` の #1933）。
