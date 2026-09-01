# codex rollout JSONL — 実機 fixture（Issue #2197）

**codex-cli 0.151.0** を実機で動かして採取した rollout ファイルと hook payload。
手で書いた想定データではなく、**実際に書かれた JSONL をそのまま置いている**（下記の置換のみ）。

採取手順・観測結果・本文との食い違いは
[`docs/design/codex-transcript-reader.md`](../../../../docs/design/codex-transcript-reader.md) を参照。

## 採取環境

| 項目 | 値 |
|---|---|
| codex-cli | **0.151.0** |
| originator / source | `codex-tui` / `cli`（対話 TUI。`codex exec` ではない） |
| model | `gpt-5.6-sol` |
| 採取日 | 2026-09-01 |
| 隔離 | `CODEX_HOME` をスクラッチ配下へ差し替え。ユーザーの `~/.codex/config.toml` は**読みも書きもしていない** |
| hooks | 隔離 `$CODEX_HOME/hooks.json` に `type: "command"` ハンドラを 7 イベント登録し、`--dangerously-bypass-hook-trust` で起動して payload を丸ごとファイルへ落とした |
| tmux | 専用 socket `-L cmate-2197`（ユーザーの既定 socket には触れていない） |

## ファイル

| ファイル | 中身 |
|---|---|
| `rollout-three-turns-01510.jsonl` | 1 セッション 3 ターン。①テキストのみ ②`CommandExecution` を挟む 2 メッセージ ③Markdown（`## Result` / 箇条書き / `**Done.**`）。`session_id` = `01a05a82-d71b-7bc3-8901-487b0db19d40` |
| `rollout-after-new-01510.jsonl` | 同じペインで `/new` を打った**後**のセッション 2 ターン。②が `FileChange` ＋ 空の `Reasoning` ＋ `CommandExecution` を含む。`session_id` = `01a05a85-f872-79d3-85c3-c1933dc86828` |
| `rollout-second-instance-01510.jsonl` | **同じ cwd で同時に動かした 2 本目の codex**（`codex-2` 相当）。`session_id` = `01a05a85-2e16-7253-96be-cd143be9049c` |
| `hook-events-01510.json` | 上記 3 セッションが実際に送った hook payload 21 件（`pane` / `event` / `payload`）。`session_id` と `transcript_path` の対応がこれで検証できる |

## この fixture が固定している事実

1. **hook の `session_id` は rollout ファイル名の uuid と一致する。** 3 セッション 3/3。
   さらに payload の `transcript_path` はその rollout の絶対パスそのもの。
2. **同一 cwd の 2 本目は別ファイルになる。** `cx1` と `cx2` は `cwd` が同じで `session_id` が違う。
   → cwd から転写を推測してはいけない（`codex` の turn が `codex-2` に混ざる）。
3. **`/new` は session を切り替える。** 同じペインから 2 つ目の `SessionStart` が別 `session_id` で届き、
   別ファイルが開く。session id は**キーではなくポインタ**である、という #2121 の言い方がそのまま当てはまる。
4. **turn 境界は `turn_id`。** `task_started` → 各 `item_completed` → `task_complete` がすべて同じ `turn_id` を持つ。
5. **operator の入力は `item_completed` の `UserMessage` だけ。** 同じファイルの
   `response_item` 側には `role: "user"` の `<environment_context>` などが混ざっているが、
   `UserMessage` item は本人の入力にしか出ない。

## 置換したもの（それ以外は無加工）

| 元 | 置換後 | 理由 |
|---|---|---|
| 採取ワークスペースの絶対パス | `/tmp/cmate-2197/work/cx` | ローカルパスの秘匿 |
| 隔離 `CODEX_HOME` の絶対パス | `/tmp/cmate-2197/codexhome` | 同上 |
| `session_meta.base_instructions.text` | `<elided for fixture>` | codex のシステムプロンプト全文（18 KB） |
| `response_item` の developer メッセージと `user.text` 以外の user メッセージ本文 | `<elided for fixture>` | 注入指示の全文（skills / permissions / plugins） |
| `world_state.state` | `{"elided": true}` | ホスト環境の記述 |
| `turn_context` の方針ブロック | `turn_id` / `cwd` / `model` などの識別フィールドのみ残置 | 同上 |
| `event_msg` の `token_count` / `thread_settings_applied` | `{"elided": true}` | アカウントのレート制限使用率 |
| `response_item.reasoning.encrypted_content` | `<elided for fixture>` | 暗号化ペイロード（数 KB × 件数） |

**リーダーが読むレコード（`event_msg` / `item_completed` と `task_started` / `task_complete`）は一切加工していない。**
置換対象はすべて `../../../../src/lib/hooks/sources/codex/transcript.ts` が読まないレコードである。

## 版が上がったら

`cli_version` は `session_meta` に入っている。版 bump で item の型や
`item_completed` の有無が変わった場合は、**この README の表を書き換えるのではなく新しい
fixture を採り直して並べること**（古い版の挙動も回帰の対照として要る）。
0.147.0 未満には `item_completed` が存在しない — design doc §2.1 の版別実測を参照。
