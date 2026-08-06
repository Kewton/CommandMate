# Claude Code hooks — 実 payload fixture

Claude Code **v2.1.223** を実機で動かして採取した hook payload。
採取手順・観測結果・公式ドキュメントとの食い違いは
[`docs/design/agent-hooks-live-verification.md`](../../../../docs/design/agent-hooks-live-verification.md)（Issue #1721）を参照。

**手で書いた想定 payload ではなく、実際に届いた JSON をそのまま置いている。**
パーサやスキーマを書くときはドキュメントではなくこちらを正とすること。

## 一覧

| ファイル | `hook_event_name` | 採取した状況 |
|---|---|---|
| `session-start.json` | `SessionStart` | TUI 起動（`source: "startup"`）。**`type:"http"` では発火しないので command hook で採取** |
| `session-start-clear.json` | `SessionStart` | `/clear`（`source: "clear"`）。`session_id` が新しくなる |
| `user-prompt-submit.json` | `UserPromptSubmit` | TUI でプロンプト送信 |
| `pre-tool-use-bash.json` | `PreToolUse` | 承認が要る `Bash` 呼び出し |
| `pre-tool-use-ask-user-question.json` | `PreToolUse` | `AskUserQuestion`（2 問・選択肢と説明つき） |
| `permission-request.json` | `PermissionRequest` | 上記 `Bash` の承認要求。`permission_suggestions` を含む |
| `permission-request-ask-user-question.json` | `PermissionRequest` | `AskUserQuestion` も承認要求を上げる。`permission_suggestions` は無い |
| `notification-permission-prompt.json` | `Notification` | `notification_type: "permission_prompt"`（承認ダイアログ表示の約 6 秒後） |
| `notification-idle-prompt.json` | `Notification` | `notification_type: "idle_prompt"`（ターン終了の約 60 秒後） |
| `stop.json` | `Stop` | ターン終了 |
| `session-end.json` | `SessionEnd` | `/exit`（`reason: "prompt_input_exit"`） |
| `session-end-clear.json` | `SessionEnd` | `/clear`（`reason: "clear"`） |

## プレースホルダ

環境固有値は以下に置換済み。フィールドの有無・順序・型は実物のまま。

| 元の値 | プレースホルダ |
|---|---|
| `session_id` | `00000000-0000-4000-8000-000000000000` |
| `prompt_id` | `11111111-1111-4111-8111-111111111111` |
| `tool_use_id` | `toolu_0000000000000000000000000` |
| `transcript_path` | `<TRANSCRIPT_PATH>` |
| `cwd` | `<CWD>` |
| 検証に使った絶対パス | `/tmp/example-marker.txt` |

## 使うときの注意

- **全イベント共通で存在するのは `session_id` / `transcript_path` / `cwd` / `hook_event_name` の 4 つだけ。**
  `prompt_id` は最初のユーザー入力より前のイベントに無く、`permission_mode` は `Notification` / `SessionStart` /
  `SessionEnd` に無く、`effort` は `UserPromptSubmit` に無い。それ以外は optional として扱うこと。
- `Notification` の判別は `message`（人間向け文言）ではなく **`notification_type`** で行うこと。
- `PermissionRequest` に **`tool_use_id` は無い**。`PreToolUse` との相関には `prompt_id` + `tool_name` + `tool_input` を使う。
- `session_id` は `/clear` で変わる。instance の永続キーにしない。
