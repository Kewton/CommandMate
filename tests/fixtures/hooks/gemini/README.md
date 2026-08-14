# Gemini CLI hooks — 実 payload fixture

Gemini CLI で実機採取した hook payload。`session-start.json` 以外は **v0.55.1**
（`session-start` は v0.42.0 と v0.55.1 の両方で同形を確認）。
採取手順・観測結果・公式ドキュメントとの食い違いは
[`docs/design/agent-hooks-phase4-live-verification.md`](../../../../docs/design/agent-hooks-phase4-live-verification.md)（Issue #1757）を参照。

**手で書いた想定 payload ではなく、実際に届いた JSON をそのまま置いている。**

## 一覧

| ファイル | `hook_event_name` | `AGENT_EVENT_TYPES` | 採取した状況 |
|---|---|---|---|
| `session-start.json` | `SessionStart` | `session_start` | CLI 起動（`source: "startup"`） |
| `before-agent.json` | `BeforeAgent` | `user_prompt_submit` | プロンプト送信（`prompt` フィールド） |
| `pre-compress.json` | `PreCompress` | （対応語なし） | **新規セッションの 1 ターン目でも発火した**（`trigger: "auto"`） |
| `before-model.json` | `BeforeModel` | （対応語なし） | モデル呼び出し直前。`llm_request` に**組み立て済みプロンプト全文**が入る |
| `session-end.json` | `SessionEnd` | `session_end` | セッション終了（`reason: "exit"`） |

## 採れなかったイベント（理由つき）

`AfterTool` / `BeforeTool` / `AfterAgent` / `AfterModel` / `Notification` は**未採取**。
この環境の Google アカウントが `IneligibleTierError`
（*This client is no longer supported for Gemini Code Assist for individuals*）で
モデル呼び出しに到達できず、**ツール実行を伴うターンを 1 度も成立させられなかった**ため。
上の 5 件はダミー API キーでモデル呼び出しが 400 で落ちるまでの間に発火した分である。

## 使うときの注意

- **イベント名が Claude Code と違う。** CLI 自身の `gemini hooks migrate --from-claude` が持つ
  変換表（実装から読み出した）:
  `PreToolUse→BeforeTool` / `PostToolUse→AfterTool` / `UserPromptSubmit→BeforeAgent` /
  `Stop→AfterAgent` / `SubAgentStop→AfterAgent` / `SessionStart→SessionStart` /
  `SessionEnd→SessionEnd` / `PreCompact→PreCompress` / `Notification→Notification`。
  さらに `BeforeModel` / `AfterModel` は Claude に対応語が無い gemini 固有イベント。
- **ツール名もリマップされる**（matcher に効く）:
  `Edit→replace` / `Bash→run_shell_command` / `Read→read_file` / `Write→write_file` /
  `Glob→glob` / `Grep→grep` / `LS→ls`。
- payload 本体は Claude 互換の snake_case ＋ `hook_event_name`。**加えて全イベントに `timestamp` がある**
  （Claude / codex には無い）。
- `before-model.json` の `llm_request.messages[].content` には**ワークスペースのディレクトリ構造が
  そのまま載る**。受け口でログに落とすと情報量が多い。

## プレースホルダ

| 元の値 | プレースホルダ |
|---|---|
| `session_id` | `00000000-0000-4000-8000-000000000000` |
| `transcript_path` | `<TRANSCRIPT_PATH>` |
| `cwd` | `<CWD>` |
| `timestamp` | `2026-08-13T00:00:00.000Z` |
| 隔離ホームの絶対パス | `<SCRATCHPAD>` |
