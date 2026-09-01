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

fixture: [`hook-events-01510.json`](../../tests/fixtures/transcripts/codex/hook-events-01510.json)（21 件）。

**「同一 cwd で 2 本目が別ファイル」は本リーダーの設計を 1 つ決めている。**
cwd から最新の rollout を推測する実装は、`codex` のターンを `codex-2` の会話へ書き込む。
だから pointer が無いときの代替探索は**置かない** — false を返してスクレイパに任せる。

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
- リーダー（ファイル解決・冪等・fail-open）: `tests/unit/hooks/sources/codex-history-2197.test.ts`
- ゲートの capability 分岐: `tests/unit/polling/structured-history-gate-2197.test.ts`
- capability pin 表（全 6 source 全数一致）: `tests/unit/hooks/sources/capabilities.test.ts`
