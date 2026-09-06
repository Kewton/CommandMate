# claude-model-switch-2363 — `PostModelSwitch` / `PreModelSwitch` の実 payload

Claude Code **v2.1.263** の `/model` / `/fast` 切替で届いた hook payload を、
そのまま置いている（Issue #2363）。読むのは
`tests/unit/lib/hooks/sources/claude-model-switch-2363.test.ts`、
`tests/unit/lib/session/agent-model-switch-hook-2363.test.ts`、
`tests/integration/hooks-claude-model-switch-2363.test.ts`。

**手で書いた想定 payload ではなく、実際に届いた JSON をそのまま置いている。**
#2361 で得た `PostModelSwitch` の値は副産物だったので、本 Issue のために採り直した。

`tests/fixtures/hooks/claude/` とは別ディレクトリにしてある。あちらは
「置かれた fixture の `hook_event_name` は全部登録されている」ことを
`tests/unit/hooks/hook-settings-generator.test.ts` と
`tests/unit/api/hooks-agent-event-instance.test.ts` が走査して検査する場所で、
ここには **登録しない** `PreModelSwitch` の実 payload も置くため。

## 採取条件

| | |
|---|---|
| 採取日 / 版 | 2026-09-06、claude 2.1.263（`~/.local/bin/claude`） |
| 隔離 | `tmux -L cm2363`（私設 socket、200x50）。**`CLAUDE_CONFIG_DIR`** を捨てディレクトリに向け、`settings.json`（下記 command hook 入り）と `.claude.json`（`mcpServers` / `projects` 抜きの写し）を置いた。`HOME` はそのまま。`/model <arg>` の「saved as your default」は全部その捨て `settings.json` に落ちた（`/model default` は `model` キーを消し、`modelSettings.claude-sonnet-5.effortLevel` が書かれた）。ホストの `~/.claude/settings.json` には触れていない |
| 経路（2 本同時） | (1) `CLAUDE_CONFIG_DIR/settings.json` に **全イベント**（`PreModelSwitch` / `PostModelSwitch` / `ConfigChange` / `PreCompact` / `PostCompact` / `SubagentStop` / `PermissionRequest` ＋通常 7 種）を `type: "command"` で登録し stdin を NDJSON に落とした。(2) **CommandMate が書くのと同じ形**（`type: "http"`、`headers: {Content-Type}`、`timeout`、URL は `/api/hooks/agent-event?tool=claude&worktreeId=…&instanceId=claude`）を `--settings <file>` で注入し、`{"accepted":true}` を 202 で返すだけの受け口に POST させた。**ここに置いた `*-model-switch-*.json` は (2) で届いた body** |
| 起動 | `claude --settings <file>` を `git init` 済みの空ディレクトリで。フォルダ信頼ダイアログは `Yes, I trust this folder` |

## 一覧

| ファイル | `hook_event_name` | 操作 | 要点 |
|---|---|---|---|
| `post-model-switch-command.json` | `PostModelSwitch` | `/model sonnet`（Haiku から） | `to_model: claude-sonnet-5`、`requested_model: sonnet`、`source: command` |
| `post-model-switch-picker.json` | `PostModelSwitch` | `/model` → `↓` → `s`（Sonnet から Haiku、this session only） | `source: picker`。picker の `Enter` は同じモデルを選んだ試行しか無く未発火（`source` は未確認） |
| `post-model-switch-default.json` | `PostModelSwitch` | `/model default`（`claude-opus-5` から） | `to_model: claude-opus-5[1m]`、**`requested_model: null`** |
| `post-model-switch-fast-on.json` | `PostModelSwitch` | `/fast` → Tab → Enter（Haiku から） | `to_model: claude-opus-5[1m]`、`requested_model: null`、`source: command`。画面は `↯ Fast mode ON · model set to Opus 5 · $10/$50 per Mtok` |
| `pre-model-switch-fast-on-first.json` | `PreModelSwitch` | 上の `/fast` と同じキー操作 | 1 発目。`from_model: claude-haiku-4-5-20251001` |
| `pre-model-switch-fast-on-second.json` | `PreModelSwitch` | 同上 | **2 発目**（約 0.1 秒後）。`from_model: claude-sonnet-5` — セッションは Haiku だったので誤り。`Pre` は登録しない根拠 |
| `session-start-after-switches.json` | `SessionStart` | 捨て設定の既定を `default` にした後の再起動 | `model: claude-opus-5[1m]`。`to_model` と同じ綴りであることの対照 |

## 観測結果（登録判断の根拠）

- `PostModelSwitch` は **モデルが実際に変わった時だけ 1 回** 届く。`/model haiku`（すでに Haiku）、picker で同じ行を選ぶ、picker を `Esc`（`Kept model as`）、`/fast` ON（すでに Opus 1M）、`/fast` OFF、`/effort low` はどれも発火しない。`/clear` は `SessionEnd(reason: clear)` ＋ `SessionStart(source: clear、model キー無し)` のみ。
- `to_model` の綴りは `SessionStart.model` と同じ id 形（`claude-sonnet-5` / `claude-haiku-4-5-20251001` / `claude-opus-5` / `claude-opus-5[1m]`）。`/model opus` は `claude-opus-5`、`/model default` と `/fast` は `claude-opus-5[1m]`。
- **`from_model` は切替前の値**。`PreModelSwitch` は 1 回目の起動（`/model sonnet`）では 1 発だったが、2 回目の起動（捨て `settings.json` に `modelSettings.claude-sonnet-5` が残った状態）では `/model haiku` / `/fast` とも **2 発** 届き、2 発目の `from_model` / `to_model` が現在のモデルと食い違った（Haiku のセッションで `from_model: claude-sonnet-5`、`/model haiku` で `to_model: claude-sonnet-5`）。`PostModelSwitch` はどちらの起動でも 1 発で、値は画面と一致した。
- `requested_model` は `/model default` と `/fast` で `null`。
- `PostModelSwitch` に `model` キーは無い（`modelFields: ['model']` の平坦読みでは取れない）。
- `--settings` 注入の `type: "http"` hook で `PreModelSwitch` / `PostModelSwitch` とも届く（`SessionStart` のように http が黙って捨てられることはない）。`User-Agent: axios/1.15.2`。
- 隔離 `.claude.json` を onboarding フラグだけの写しにすると `Not logged in` になり `/fast` が `Fast mode has been disabled by your organization` の modal で止まる。`mcpServers` / `projects` 以外を全部写すとログイン状態が引き継がれ `/fast` が使える。

## プレースホルダ

| 元の値 | プレースホルダ |
|---|---|
| `session_id` | `00000000-0000-4000-8000-000000000000` |
| `prompt_id` | `11111111-1111-4111-8111-111111111111` |
| `transcript_path` | `<TRANSCRIPT_PATH>` |
| `cwd` | `<CWD>` |

フィールドの有無・順序・型は実物のまま。
