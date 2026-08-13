# GitHub Copilot CLI hooks — 実 payload fixture

GitHub Copilot CLI **v1.0.77**（採取途中で本体が自動更新され、後半は v1.0.79）を実機で動かして採取した hook payload。
採取手順・観測結果・公式ドキュメントとの食い違いは
[`docs/design/agent-hooks-phase4-live-verification.md`](../../../../docs/design/agent-hooks-phase4-live-verification.md)（Issue #1757）を参照。

> **Issue #1757 起票時点の「copilot に hooks は無いかもしれない」という前提は誤り。**
> 1.0.77 に hooks は実在し、payload は 4 ツール中もっとも Claude Code に近い。

**手で書いた想定 payload ではなく、実際に届いた JSON をそのまま置いている。**

## 一覧

| ファイル | `hook_event_name` | `AGENT_EVENT_TYPES` | 採取した状況 |
|---|---|---|---|
| `session-start.json` | `SessionStart` | `session_start` | `copilot -p` 起動（`source: "new"`、`initial_prompt` つき） |
| `user-prompt-submit.json` | `UserPromptSubmit` | `user_prompt_submit` | プロンプト送信。**`SessionStart` より先に届く** |
| `pre-tool-use.json` | `PreToolUse` | `pre_tool_use` | `Bash` 呼び出し前 |
| `post-tool-use.json` | `PostToolUse` | `post_tool_use` | 同 `Bash` の完了（`tool_result` つき） |
| `stop.json` | `Stop` | `stop` | ターン終了（`stop_reason: "end_turn"`） |
| `session-end.json` | `SessionEnd` | `session_end` | 非対話セッション終了（`reason: "complete"`） |

## 使うときの注意

- **全イベントに `hook_event_name` / `session_id` / `timestamp` / `cwd` がある。**
  `transcript_path` は `Stop` にしか無い。
- `tool_name` は `Bash` — Claude Code と同じ綴り。gemini のようなツール名リマップは無い。
- `Notification` を登録したが `copilot -p`（非対話）では一度も発火しなかった。TUI では未計測。
- **イベント発火順は `UserPromptSubmit` → `SessionStart`。** Claude / codex と逆なので、
  `session_start` を「セッションの最初のイベント」と仮定してはいけない。
- hook コマンドには `COPILOT_CLI` / `COPILOT_CLI_BINARY_VERSION` / `COPILOT_HOME` /
  **`COPILOT_PROJECT_DIR`** が環境変数として渡る（4 ツール中これだけ）。

## プレースホルダ

| 元の値 | プレースホルダ |
|---|---|
| `session_id` | `00000000-0000-4000-8000-000000000000` |
| `transcript_path` | `<TRANSCRIPT_PATH>` |
| `cwd` | `<CWD>` |
| `timestamp` | `2026-08-13T00:00:00.000Z` |
