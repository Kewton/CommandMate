# codex hooks — 実 payload fixture

OpenAI Codex CLI **v0.147.0** を実機で動かして採取した hook payload。
採取手順・観測結果・公式ドキュメントとの食い違いは
[`docs/design/agent-hooks-phase4-live-verification.md`](../../../../docs/design/agent-hooks-phase4-live-verification.md)（Issue #1757）を参照。

**手で書いた想定 payload ではなく、実際に届いた JSON をそのまま置いている。**

## 一覧

| ファイル | `hook_event_name` | `AGENT_EVENT_TYPES` | 採取した状況 |
|---|---|---|---|
| `session-start.json` | `SessionStart` | `session_start` | TUI セッションの**最初のターン送信時**（プロセス起動時ではない） |
| `user-prompt-submit.json` | `UserPromptSubmit` | `user_prompt_submit` | TUI でプロンプト送信 |
| `pre-tool-use.json` | `PreToolUse` | `pre_tool_use` | 承認が要る `Bash` 呼び出し |
| `post-tool-use.json` | `PostToolUse` | `post_tool_use` | 同 `Bash` の完了（`tool_response` は空文字） |
| `permission-request.json` | `PermissionRequest` | （対応語なし） | 上記 `Bash` の承認要求。**`tool_use_id` が無い** |
| `stop.json` | `Stop` | `stop` | ターン終了 |
| `session-end.json` | `SessionEnd` | `session_end` | `/quit`（`reason: "other"`） |

## 使うときの注意

- **`notification` に対応するイベントは codex に存在しない。** `hooks.json` に `Notification` を書いても
  無言で捨てられる（TUI の hooks レビュー画面が列挙する 11 イベントに含まれない）。
- Claude の `prompt_id` に相当するのは **`turn_id`**。名前が違う。
- `PermissionRequest` には `tool_use_id` が無い（Claude と同じ）。`PreToolUse` との相関は
  `turn_id` + `tool_name` + `tool_input` で行うこと。
- `permission_mode` は実行モードで変わる（`codex exec` は `bypassPermissions`、TUI は `default`）。
- `model` は全イベントに入るが `SessionEnd` には無い。

## プレースホルダ

| 元の値 | プレースホルダ |
|---|---|
| `session_id` | `00000000-0000-4000-8000-000000000000` |
| `turn_id` | `11111111-1111-4111-8111-111111111111` |
| `tool_use_id` | `exec-00000000-0000-4000-8000-000000000000` |
| `transcript_path` | `<TRANSCRIPT_PATH>` |
| `cwd` | `<CWD>` |
