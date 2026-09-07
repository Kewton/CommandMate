# codex 転写リーダー 実測と設計（Issue #2197）

- **Issue**: [#2197](https://github.com/Kewton/CommandMate/issues/2197) ／ 親 Epic [#2192](https://github.com/Kewton/CommandMate/issues/2192) Phase 2
- **対象**: codex-cli **0.151.0**（実機）＋ **0.142.0 … 0.151.0** の保存済み rollout 400 本（版別の後方互換確認）
- **実測日**: 2026-09-01
- **成果物**: 本書 ＋ [`tests/fixtures/transcripts/codex/`](../../tests/fixtures/transcripts/codex/) ＋
  `src/lib/hooks/sources/codex/{transcript,history}.ts`
- **先行**: [#2041 opencode（push）](./opencode-server-live-verification.md) / #2121 claude（pull） / #2196 共通ヘルパ

---

## 0. 要旨

codex のチャット履歴を **codex 自身の転写（rollout JSONL）** から書けるようになった。

- assistant 行は Markdown 本文（TUI の罫線・折返し・スピナー残骸を含まない）を
  `request_id = codex-turn:<turn_id>` で書く。
- user 行は #2196 の `recordUserTurn()` を再利用し `request_id = codex-prompt:<UserMessage item id>` で書く。
  ターミナルで直接打った入力もチャット面に載る。
- 転写が読めないときは **false を返して従来のスクレイプに任せる**（fail-open）。

**Issue 本文との食い違いは §6 にまとめた。**

---

## 1. 実測ハーネス

ユーザーの稼働セッションと `~/.codex/config.toml` に触れないこと、が制約だった。
#1757 のスパイクと同じ `CODEX_HOME` 隔離で満たしている。

```bash
SP=<scratchpad>
mkdir -p "$SP/codexhome"
cp -p ~/.codex/auth.json "$SP/codexhome/auth.json"; chmod 600 "$SP/codexhome/auth.json"
cat > "$SP/codexhome/config.toml" <<'TOML'
model = "gpt-5.6-sol"
approval_policy = "never"
sandbox_mode = "workspace-write"
TOML
# hooks.json: 7 イベントすべてを payload ダンプ用スクリプトへ（type は "command" のみ。#1757 P3）
tmux -L cmate-2197 new-session -d -s cxdbg -x 200 -y 50 -c "$SP/work/cx" \
  "env CODEX_HOME='$SP/codexhome' HOOKDUMP_FILE='$SP/hooks-cx1.jsonl' TERM=xterm-256color \
   codex --dangerously-bypass-hook-trust"
```

- **専用 tmux socket（`-L cmate-2197`）**。tmux の解決順は `-L` > `$TMUX` > `TMUX_TMPDIR` なので、
  `TMUX_TMPDIR` では隔離できない（#1757 §3.3）。
- **`--dangerously-bypass-hook-trust`** を使ったのは trust をユーザーの `config.toml` へ書かないため。
  これは検証専用で、CommandMate の既定は今も「書かない・ユーザーが一度だけ承認する」（`hooks-config.ts`）。
- ワークスペースはスクラッチ配下の使い捨て git repo。本 worktree に codex を走らせてはいない。

実行したのは 6 ターン: `PONG-1` / シェル実行 / Markdown 出力 / `/new` 後の `PONG-AFTER-NEW` /
`FileChange` を伴う編集 ／ 2 本目インスタンスの `PONG-FROM-SECOND-INSTANCE`。

---

## 2. rollout JSONL の形

1 行 1 レコード。外側は **`{ordinal, timestamp, type, payload}`** で固定。

```
sessions/<yyyy>/<mm>/<dd>/rollout-<ローカル時刻>-<session uuid>.jsonl
```

### 2.1 レコード種別（保存済み 250 セッションの実数）

| `type` | 件数 | 中身 |
|---|---:|---|
| `response_item` | 51,267 | **モデルに送った側**の記録。`message`(role=developer/user/assistant) / `reasoning` / `custom_tool_call` / `custom_tool_call_output` |
| `event_msg` | 50,616 | **TUI が表示した側**の記録。`item_completed` / `token_count` / `task_started` / `task_complete` / `thread_settings_applied` |
| `turn_context` | 415 | ターンごとの cwd / model / approval policy |
| `world_state` | 319 | ホスト環境の記述 |
| `session_meta` | 259 | 先頭 1 行。`session_id` / `cwd` / `originator` / `cli_version` |
| `compacted` | 66 | 圧縮の記録 |
| `inter_agent_communication_metadata` | 13 | マルチエージェント |

**版による差（400 本の版別集計）:**

| `cli_version` | `item_completed` を含むファイル |
|---|---|
| 0.142.0 – 0.146.0 | **0 本**（代わりに `event_msg` の `agent_message` / `user_message` / `agent_reasoning`） |
| 0.147.0 | 41 / 42 |
| 0.148.0 | 84 / 87 |
| 0.149.0 / 0.149.1 | 43 / 44、70 / 74 |
| 0.151.0 | 5 / 5 |

→ **本リーダーの下限は codex-cli 0.147.0。** それ未満では turn が 1 件も組み立たず、
false を返してスクレイパへ落ちる（欠測ではなく従来動作）。
hooks 自体の stable が 0.146 なので、実質「hooks が使えるなら 0.147 も使える」に近い。

### 2.2 なぜ `event_msg` / `item_completed` だけを読むのか

同じ会話が 2 系統に二重で書かれている。読むのは **item 側だけ**で、これが本リーダーの中心的な判断。

1. **`role: "user"` はほとんど user ではない。**
   `response_item` 側の `role: "user"` には `<environment_context>` / `<recommended_plugins>` /
   AGENTS.md 指示が混ざる（実測: 保存済み 40 本で user role 73 件のうち本人入力は 38 件）。
   item 側は `UserMessage` が本人入力にしか出ない — **deny list ではなく positive evidence**。
   #2196 が claude で採った規律と同じ。
2. **ツール呼び出しが読めるのは item 側だけ。**
   `custom_tool_call.input` は JavaScript の断片
   （`const r = await tools.exec_command({cmd:"…"})`）。`CommandExecution` item は argv と
   `parsed_cmd[].cmd`（シェル 1 行）を持つ。
3. **`content_item_kinds`（`response_item` を本人入力と判別できる唯一のフィールド）は 0.151.0 にしか無い。**
   0.149.1 では欠落しており、注入 user レコードと本人入力が見分けられない。
   これに依存したリーダーは 1 版戻るだけで静かに壊れる。

`response_item` は「item 側の重複」として**数えて捨てる**（`CodexTurnBuild.duplicateStreamRecords`）。
未知種別として報告しないのは、既知の重複だからである。

### 2.3 `item_completed` の item 種別（保存済み 250 セッション）

| `item.type` | 件数 | 読むフィールド | Markdown 表現 |
|---|---:|---|---|
| `Reasoning` | 12,084 | `summary_text`（**12,084 件すべて空**） | 非空のときだけ `> **Thinking**` の引用。実測では常に出力なし |
| `CommandExecution` | 9,211 | `parsed_cmd[].cmd` →（無ければ）`command` argv | `` - `exec` — <cmd> `` |
| `AgentMessage` | 2,211 | `content[].text`、`phase` | 段落そのまま（`commentary` / `final_answer` の両方） |
| `FileChange` | 1,407 | `changes` のキー（パス） | `` - `edit` — <paths> `` |
| `UserMessage` | 286 | `content[].text`、`id` | assistant 本文には入れない（user 行になる） |
| `McpToolCall` | 102 | `server` / `tool` | `` - `mcp` — <server>.<tool> `` |
| `ContextCompaction` | 53 | （`{type,id}` のみ） | **既知の無音**。unknown に数えない |
| `Extension` | 23 | `query` / `action` | `` - `extension` — <query> `` |
| `ImageView` | 24 | `path` | `` - `view` — <path> `` |

この表に無い種別は `unknownBlockTypes` として**数えてログに出す**（`codex-transcript-unknown-items`）。
黙って落とさない。

- `AgentMessage.phase` は `commentary` 1,943 / `final_answer` 268。
  **`final_answer` は必ずそのターン最後の `AgentMessage`**（309 / 309 ターン）。
- `commentary` も本文に入れる。codex の TUI は両方表示するし、直後のツール行が何のためかを説明しているのは
  `commentary` の側だから。

### 2.4 turn 境界は書いてある

`turn_id` が `task_started` / 全 `item_completed` / `turn_context` / `task_complete` に載る。
claude（返信とプロンプトを結ぶフィールドが無く、レコード順から推測するしかない）より素直。

保存済み 326 ターンの実測:

| 事実 | 実数 |
|---|---|
| `task_complete` を持つターン | **326 / 326** |
| `UserMessage` を持つターン | 297 / 326（残り 29 は圧縮など、人の入力が無いターン） |
| `UserMessage` を **2 件以上**持つターン | **23 / 326** |

→ **1 ターン = 1 プロンプトではない。** 実行中に送った追加プロンプトを codex は同じターンに畳み込む。
そのため user 行のキーは `turn_id` ではなく **`UserMessage` item の `id`**（§4.2）。

---

## 3. hook との対応（すべて実測）

| 確認事項 | 結果 |
|---|---|
| hook の `session_id` は rollout ファイル名の uuid と一致するか | **一致。3 セッション 3/3。** さらに payload の `transcript_path` が rollout の絶対パスそのもの |
| 複数インスタンス（`codex-2`）でファイルは分かれるか | **分かれる。** 同一 cwd で同時起動した 2 本は `session_id` が別で、rollout も別ファイル |
| `/clear` 相当でファイルは切り替わるか | **切り替わる。** 0.151.0 の `/new` が新しい `session_id` と新しい rollout を開き、2 回目の `SessionStart` hook がそれを運んでくる |
| `SessionStart` に `turn_id` はあるか | **無い。** `UserPromptSubmit` / `Stop` / `PreToolUse` / `PostToolUse` にはある |
| `Stop` hook と rollout の `task_complete` の順序 | **hook が先。** しかも codex は hook のコマンドが終了するまで `task_complete` を書かない（#2398、§3.1） |

fixture: [`hook-events-01510.json`](../../tests/fixtures/transcripts/codex/hook-events-01510.json)（21 件）。

**「同一 cwd で 2 本目が別ファイル」は本リーダーの設計を 1 つ決めている。**
cwd から最新の rollout を推測する実装は、`codex` のターンを `codex-2` の会話へ書き込む。
だから pointer が無いときの代替探索は**置かない** — false を返してスクレイパに任せる。

### 3.1 Stop hook は `task_complete` の**前**に発火し、hook の終了を待つ（Issue #2398 実測）

§4.3 の「閉じたターンだけ書く」は `task_complete` を見て判定する。その `task_complete` が
**いつ書かれるか**は #2197 では計測していなかった。#2398 で計測したところ、claude と逆だった。

稼働ログ 3 日分（2026-09-07 時点）。「Stop 受け口が同期に転写を書けた回数」:

| tool | 同期で書けた / Stop 受信 |
|---|---|
| claude | 506 / 508 |
| antigravity | 9 / 9 |
| command-code | 1 / 1 |
| **codex** | **0 / 105** |

codex の 105 回はすべて `codex-transcript-turn-open` を 3 回（500ms 間隔）出して false で終わっている。
1 ターンの実測（`turn_id 01a07bc1-…`、21:04:48 のターン）:

```
12:05:22.515Z codex-transcript-turn-open  items:6   ← Stop 受け口 attempt 1
12:05:23.065Z codex-transcript-turn-open  items:6   ← attempt 2
12:05:23.604Z codex-transcript-turn-open  items:6   ← attempt 3
12:05:23.604Z agent-event-stop-applied structuredHistoryCaptured:false  ← 受け口が応答
12:05:23.607Z (rollout) task_complete                ← 応答の 3ms 後に codex が追記
```

受け口の応答時刻と `task_complete` の timestamp の差は当日 5 ターンで **3 / 16 / 59 / 61 / 63 ms**、
すべて「応答の**後**」。つまり **codex は Stop hook のコマンド（relay の同期 `curl --max-time 5`）が
終了するまで rollout に `task_complete` を書かない。** claude は逆（転写を書いてから Stop を発火する）で、
#2246 / #2264 の「2 つの追記が競合している」という読みは claude では正しく、codex では偽である。

設計上の帰結（`src/lib/hooks/stop-history-capture.ts`）:

- **受け口の中で待ってはいけない。** 待っている本人が追記をブロックしているので、#2264 の
  「3 回 × 500ms」は回数を増やしても間隔を延ばしても勝てない（自己待ち）。
  副作用として codex の全ターンの終了を毎回 1 秒遅らせていた。
- 同期の読みは **1 回だけ**。false かつ転写が在るなら、**応答を返してから** detach した遅延読み
  （150 / 500 / 2000 / 5000 ms の有限回）へ切り替える。1 回目の 150ms で実測 63ms を追い越す。
- 遅延読みも `structured-history-gate` の `captureStructuredHistoryTurn` を通す。
  per-instance 直列化・冪等な書き込み・`broadcastMessage`・`onRelayTurnCompleted` はそのまま効く。
- claude / antigravity / command-code は 1 回目で成功するので、この分岐に入らず #2264 のまま。
- 「どのツールが hook 終了を待つか」は今のところ `STOP_HOOK_BLOCKS_TRANSCRIPT_CLOSE`
  （`stop-history-capture.ts`）の 1 行テーブル。2 つ目が出た時点で
  `AgentSourceCapabilities` へ移す（§4.4 の `transcriptHistory` の隣）。

---

## 4. 設計

### 4.1 session pointer（`history.ts`）

- `getLastAgentEvent(worktreeId, cliToolId, instanceId).sessionId` を読み、`globalThis` の Map に **latch**。
  `globalThis` である理由は #1736（`next dev` ではバンドルごとにモジュールスコープが別になる）。
- pointer が無ければ **false**。hooks 未設定 / hooks 未 trust（codex は未 trust の hook を無言で skip する。#1757 P4）/
  サーバ再起動直後は、いずれも pointer が無い状態になる。
- ファイル解決は `$CODEX_HOME/sessions` 配下の走査。
  **ファイル名にローカル壁時計時刻が入る**（`rollout-2026-09-01T10-08-39-<uuid>.jsonl` の session の
  `timestamp` は `01:08:53Z`）ため、id からパスは計算できない。
  ディレクトリ名の降順（= 日付の降順）で降り、見つけた結果は session id ごとに memo する。
  memo は使う前に毎回 `stat` で検証する。
- session id は UUID の形をしていなければ照合に使わない（ファイル名比較へ届く値なので、
  `/` や `..` を含む値をそのまま扱わない）。
- 解決したパスは `acceptCodexRolloutPath()` を通す — `<codexHome>/sessions` 配下・`.jsonl`・NUL 無し・
  `resolve()` 後に判定。`acceptClaudeTranscriptHint` と同じ規律。
- `CODEX_HOME` を尊重する。codex の唯一の per-invocation 隔離手段であり（#1757 §5.1.2）、
  それを設定して起動された CommandMate はそのディレクトリを見ている。

### 4.2 行の書き方

| 行 | `request_id` | 由来 |
|---|---|---|
| assistant | `codex-turn:<turn_id>` | codex 自身の turn id |
| user | `codex-prompt:<UserMessage item id>` | #2196 の `recordUserTurn()` を**再利用**（再実装していない） |

- `codex-turn:` は `AGENT_MARKDOWN_REQUEST_ID_PREFIXES` に追加した（= Markdown 描画対象）。
  `codex-prompt:` は**入れない** — 人の入力は verbatim のまま描く（#2196 と同じ理由）。
- 末尾 4 MiB だけ読む（`src/lib/history/transcript-tail.ts` の `TRANSCRIPT_TAIL_BYTES`。
  claude の `CLAUDE_TRANSCRIPT_TAIL_BYTES` と同じ値・同じ理由）。
  本機の最大 rollout は **273 MB**（2026-08-25）だったので、窓は必須。
- 窓の先頭行（途中から始まる断片）は捨てる。追記中の末尾断片は 1 レコードの損失として数える。

### 4.3 「閉じたターンだけ書く」

`task_complete` を見ていないターンは **false を返す**。claude 版には無い判定で、根拠は §2.4 の
「326/326 が `task_complete` を持つ」。

- 途中まで書かれた本文を保存すると、**切れているのに完成して見える行**が永久に残る。
- 逆に false を返した場合のコストは「このターンだけ Markdown 化されない」だけで、
  スクレイパが従来どおり書く。
- **user 行は閉じていなくても書く。** ターミナルで打った入力を履歴に載せるのが #2196 の目的で、
  それは相手がスクレイプ行でも同じだけ価値がある。

### 4.4 ゲートの capability 化

`structured-history-gate.ts` のツール名分岐（`cliToolId !== 'opencode'` / `!== CLAUDE_CLI_TOOL_ID`）を
`AgentSourceCapabilities.transcriptHistory` による分岐へ置き換えた。

| source | `transcriptHistory` | ゲートが訊くこと |
|---|---|---|
| claude | `'pull'` | 「いま記録して、記録したか答えて」 |
| codex | `'pull'` | 同上 |
| opencode | `'push'` | 「その接続は生きているか」 |
| gemini / copilot / antigravity / legacy relay | `null` | 何も訊かない |

- 宣言値は文字列と `null` のみ（#1921 D3「JSON 直列化可能な宣言値のみ。関数は置かない」）。
  `structuredEvents.source` でそのままワイヤに載るため、関数だと黙って消える。
- **どのリーダーを呼ぶか**は capability に入れられない（関数だから）ので、ゲート内の
  `PULL_TRANSCRIPT_READERS` テーブルに 1 行ずつ置く。`'pull'` を宣言してテーブルに無い tool は
  警告ログを出して false（= スクレイパ）。#2198 は自分の `source.ts` とこの 1 行だけを足せばよい。
- 型は宣言マージで足している（`src/lib/hooks/agent-event-types.ts` の `declare module './sources/types'`）。
  `sources/types.ts` は `agent-event-types.ts` から `AgentEventType` を import しているため、
  語彙側にフィールドを置くとモジュールの向きが逆転する。語とフィールドを 1 ファイルに同居させる方を採った。

### 4.5 頭が窓の外に落ちたターン（Issue #2402）

#### 実測（2026-09-07、`commandagent-develop` / codex）

| 事実 | 実測値 |
|---|---|
| rollout | 30 MB / 7,408 行 |
| 該当ターン `01a07a0e-…` | 13:09→20:00（7 時間）、387 items、`compacted` 4 回 |
| 行の範囲 | 1,660〜7,390 行目 |
| 窓（4 MiB）の外に落ちたもの | `task_started` と最初の 2 プロンプト |
| 窓の中に残ったもの | 後半の items と 19:45 の steer プロンプト |
| 13:15:02 の steer プロンプト | user 行が adopt されず（`request_id` NULL のまま）、`user-turn-adopted` も出ていない |

`buildCodexTurns` は `turn_id` をキーに**窓内の最初のレコード**で turn を開き、`task_started` の
有無を見ていなかった。`closed`（`task_complete` を見たか）はあるのに、対になる開始側の印が無い。
その結果、頭が欠けたターンと最初から見ていたターンが**区別できず**、本文は窓内の item だけで
書かれ、欠落は無言だった。

#### 決定 1: `task_started` を見たかを持ち、印を付けて**書く**

`CodexTurnAccumulator.started` を足す（`closed` と対）。`renderCodexTurn` は
`started === false` かつ本文が空でないとき、先頭に `CODEX_TURN_HEAD_TRUNCATION_MARKER`
（`_(head truncated)_`）を付ける。`MAX_CODEX_TURN_BODY_LENGTH` 超過時の
`CODEX_TURN_TRUNCATION_MARKER`（`_(truncated)_`）と**同じ様式・反対の端**。
長さ上限の適用より**前**に付けるので、両端が切れたターンは両端でそう言う。

本文が空のときは印を付けない。「何かが欠けています」だけの行は、行が無いより悪い
（`writeCodexTurn` は空本文をスクレイパへ渡す。渡せるのは本文が空のままのときだけ）。

#### 決定 2: claude と逆に「書く」— 非対称の根拠

| | claude（`../claude/history`） | codex（本モジュール） |
|---|---|---|
| 頭が窓外のターンの扱い | **書かない**（`collectHeadlessClaudeTurn` は描画専用） | **印を付けて書く** |
| 根拠 | 返答からプロンプトへのリンクが**1 つも無い**。turn key を捏造するしかなく、捏造した key は後続の run が「既に書いた」と認識できない行になる | `turn_id` が `task_started` だけでなく**全 `item_completed` / `turn_context` / `task_complete`** に載る（§2.4、326/326）。**頭が窓外でも窓内の item から正しい key が読める** |
| `partial` の置き場所 | `ClaudeTurnProgress`（プレビュー用・書き込み無し） | `chat_messages` の行そのもの |

claude の「書かない」をそのまま真似すると、codex がタダで渡してくれている本文を捨てることになる。
**この非対称性は `transcript.ts` のモジュール docblock にも書いてある**（実装を読む人が
claude 側と読み比べたときに必ずぶつかるため）。

#### 決定 3: 窓外の steer プロンプトは adopt **しない**。ログに理由を残すだけ

Issue の対応案 2（「既存の `/send` 行のうち turn 開始〜窓先頭の範囲にある未 adopt 行を候補として
扱えるか」）は**採らない**。

- `recordCodexUserTurns` が見るのは `turn.prompts`＝**窓内の `UserMessage` item** だけ。
  窓外のプロンプトはテキストが読めない（そのバイトを読んでいない）。
- テキストが無い以上、未 adopt の `/send` 行のどれがこのターンのものかは**照合できない**。
  時間範囲だけで結び付けると、別インスタンス・別ターンの行に `codex-prompt:<item id>` を
  付けてしまう。その key は**間違った行に永久に付く**（`setMessageRequestId` は一度きり）。
- 誤 adopt のコストは「打った文が別の返答に紐づく」で、無 adopt のコスト
  （`request_id` NULL の行が 1 本残る＝ §5-5 の orphan が 1 つ増える）より大きい。

代わりに、headless なターンを書いたときに `codex-transcript-turn-headless` を出し、
**窓が実際に測れたものだけ**を載せる。

| フィールド | 意味 |
|---|---|
| `windowBytes` | `CODEX_TRANSCRIPT_TAIL_BYTES`（なぜ切れたか） |
| `windowFirstRecordAt` | 窓の最初のタイムスタンプ付きレコードの epoch ms。「ターンはこれより前に始まった」の上界 |
| `turnlessRecords` / `malformedLines` | 窓が turn に帰属させられなかった数／読めなかった行数 |
| `promptsInWindow` | **窓内にあったプロンプト数。** これが 0 や 1 で、UI にプロンプトが足りなければ「窓外プロンプトがある」と読める |
| `itemsInWindow` | 窓内の item 数 |

**窓外に何件落ちたかは載せない。** そのバイトを読んでいない read には知りようがなく、
推定値は沈黙より悪い。

#### 決定 4: 窓（4 MiB）は codex だけ広げない

`src/lib/history/transcript-tail.ts` には触れない。本機の最大 rollout は **273 MB**（#2197 実測）で、
窓はその 1 ファイルを毎ターン読まないために在る。codex だけ広げると、
「一番大きいファイルを持つツールの窓を一番大きくする」ことになる。

なお `transcript-tail.ts` の docblock にある「a turn that genuinely does not fit produces a turn
with no prompt in it, which each reader detects and reports **rather than writing as a headless
reply**」は、この Issue 以降 **codex には当てはまらない**（claude / antigravity は従来どおり）。
共有モジュールの記述は #2402 のスコープ外なので直していない。

---

## 5. 既知の制約

1. **CommandMate 停止中に進んだターンは Markdown にならない。**
   このリーダーは常に「最新の 1 ターン」しか書かない（過去ターンには既にスクレイパの行があり、
   遡って書くと同じ返信が 2 回並ぶ）。サーバが止まっている間に進んだターンは、
   次のターンが終わったときには「最新」ではないので読まれない。
   **履歴は欠けない** — その間の行はスクレイパが書いている（サーバが動いていなければどちらも書かないので、
   これはリーダーの制約ではなくサーバ停止の帰結）。
2. **hooks が無い / trust されていない codex は従来どおり。** pointer が無いので fail-open。
3. **0.147.0 未満は読まない。**（§2.1）
4. **`Reasoning` は実質いつも空。** 本機のアカウントでは 12,084 件すべて `summary_text: []`。
   非空になる設定があるなら描画されるが、その形は未実測。
5. **1 ターンに複数プロンプトがあると `orphan` ペアが 1 つ増える。**
   user 行は 1 プロンプト 1 行、assistant 行は 1 ターン 1 行なので、2 プロンプトのターンは
   （user, なし）＋（user, assistant）になる。畳んで 1 行にするより、打った文が消えない方を採った。
6. **生成中の本文（#2199）はスコープ外。** 本リーダーは閉じたターンしか書かない。
7. **窓（4 MiB）より長いターンは頭が欠ける。**（#2402、§4.5）本文には `_(head truncated)_` が付き、
   `codex-transcript-turn-headless` が出るが、**欠けた本文と窓外プロンプトは戻らない**。
   窓外プロンプトの `/send` 行は `request_id` NULL のまま残る（adopt しない理由は §4.5 決定 3）。

---

## 6. Issue 本文との食い違い（実測を正とした点）

| Issue 本文 | 実測 | 対応 |
|---|---|---|
| 「`~/.codex/sessions/**/rollout-*-<sessionId>.jsonl`」 | ルートは `~/.codex` 固定ではなく **`$CODEX_HOME`**（未設定時のみ `~/.codex`） | `resolveCodexHome()` で env を尊重 |
| 「assistant 行は `request_id = 'codex-turn:<id>'`」「user 行は `codex-prompt:<id>`」で `<id>` が同じ想定 | **turn に複数プロンプトが載る**（23/326） | assistant は `turn_id`、user は `UserMessage` item id。別 id 空間 |
| 「hook の `session_id` が rollout ファイル名の uuid と一致するかは未実測」 | **一致する。** かつ `transcript_path` が絶対パスで来る | pointer は `session_id` を latch（`transcript_path` は `AgentEventRecord` に載っていないので現状は使えない。載せられれば走査を省ける） |
| 「レコード形式は未実測」 | §2 のとおり 2 系統。**item 側だけを読む** | `content_item_kinds` に依存しない実装 |
| 「codex は非 alternate screen」等 scraper 側の記述 | 変更していない | scope 外 |

---

## 7. 検証

- fixture 駆動 unit: `tests/unit/hooks/sources/codex-transcript-2197.test.ts`
- 頭が窓外のターン（§4.5）: `tests/unit/hooks/sources/codex-headless-turn-2402.test.ts`
  （fixture `tests/fixtures/transcripts/codex/rollout-headless-tail-2402.jsonl` ＝
  `rollout-three-turns-01510.jsonl` の末尾バイト列。陰性対照として同じ capture を
  **丸ごと**読ませ、3 ターンの本文が印なしで従来どおりであることも同ファイルで固定している）
- リーダー（ファイル解決・冪等・fail-open）: `tests/unit/hooks/sources/codex-history-2197.test.ts`
- ゲートの capability 分岐: `tests/unit/polling/structured-history-gate-2197.test.ts`
- capability pin 表（全 6 source 全数一致）: `tests/unit/hooks/sources/capabilities.test.ts`
