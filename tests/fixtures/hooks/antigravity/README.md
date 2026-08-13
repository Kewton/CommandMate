# Antigravity CLI (`agy`) hooks — 実 payload fixture

Antigravity CLI **v1.1.7**（採取途中で本体が自動更新され、後半は v1.1.12）を実機で動かして採取した hook payload。
採取手順・観測結果・公式ドキュメントとの食い違いは
[`docs/design/agent-hooks-phase4-live-verification.md`](../../../../docs/design/agent-hooks-phase4-live-verification.md)（Issue #1757）を参照。

**手で書いた想定 payload ではなく、実際に届いた JSON をそのまま置いている。**

## 一覧

| ファイル | イベント | `AGENT_EVENT_TYPES` | 採取した状況 |
|---|---|---|---|
| `session-start.json` | `SessionStart` | `session_start` | セッション開始。**公式ドキュメントに載っていないが実際に発火する** |
| `pre-invocation.json` | `PreInvocation` | （対応語なし） | モデル呼び出し直前。ターンごとに繰り返し発火 |
| `pre-tool-use.json` | `PreToolUse` | `pre_tool_use` | ツール実行前（`toolCall.name: "run_command"`） |
| `post-tool-use.json` | `PostToolUse` | `post_tool_use` | ツール実行後（`error` フィールドつき、成功時は空文字） |
| `post-invocation.json` | `PostInvocation` | （対応語なし） | ツール呼び出し完了後 |
| `stop.json` | `Stop` | `stop` | 実行ループ終了（`terminationReason: "NO_TOOL_CALL"`） |

## 使うときの注意

- **payload に `hook_event_name` に相当するフィールドが一切無い。**
  どのイベントかは「どのハンドラが起動されたか」でしか判らない。
  受け口を 1 本の URL に集約する設計は agy では成立しない — **イベント種別はコマンド引数で渡すこと。**
- **キーは camelCase（protojson）。** 他 3 ツールの snake_case とここだけ流儀が違う。
- **`workspacePaths` が空配列**（CLI モードで実測）。`cwd` に相当するフィールドも無い。
  → **payload から worktree を特定できない。** worktree ID は hook コマンドの引数に焼き込むしかない。
- `user_prompt_submit` / `notification` / `session_end` に対応するイベントは**存在しない**
  （`SessionEnd` / `Notification` / `UserPromptSubmit` を `hooks.json` に書いても一度も発火しない）。
- `Stop` は「ループが止まろうとしている」通知であり、`{"decision":"continue"}` を返すと**停止を阻止できる**。
  CommandMate が完了検知に使う場合、返答内容が agent の挙動を変えることを忘れないこと。

## プレースホルダ

| 元の値 | プレースホルダ |
|---|---|
| `conversationId` | `22222222-2222-4222-8222-222222222222` |
| `transcriptPath` | `<TRANSCRIPT_PATH>` |
| `artifactDirectoryPath` | `<ARTIFACT_DIR>` |
