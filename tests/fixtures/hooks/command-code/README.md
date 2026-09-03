# Command Code (`commandcode`) hooks — 実 payload fixture

Command Code **v1.40.1** を実機（隔離 tmux socket、200x50）で動かして採取した hook payload。
採取スクリプトは `cat` で stdin をそのままログへ落とし、stdout に `{}` だけを返すシェルスクリプト
（＝この tool の「見送り」の綴り）。Issue #2251 / Epic #2249 Phase B。

**手で書いた想定 payload ではなく、実際に届いた JSON をそのまま置いている**（下の「プレースホルダ」で
置換した値を除く）。

## 一覧

| ファイル | `hook_event_name` | `AGENT_EVENT_TYPES` | `detail`（`extractSnakeCaseEventDetail`） | 採取した状況 |
|---|---|---|---|---|
| `session-start.json` | `SessionStart` | `session_start` | `startup`（`source`） | 起動直後。プロンプトを 1 文字も打つ前に届く |
| `pre-tool-use-shell.json` | `PreToolUse` | `pre_tool_use` | `shell_command`（`tool_name`） | `ls -la` の実行前。**承認ダイアログの後**（下記） |
| `post-tool-use-shell.json` | `PostToolUse` | `post_tool_use` | `shell_command` | 同じ tool 呼び出しの後。`tool_response` は文字列 |
| `pre-tool-use-write.json` | `PreToolUse` | `pre_tool_use` | `write_file` | ファイル作成の実行前 |
| `post-tool-use-write.json` | `PostToolUse` | `post_tool_use` | `write_file` | 同上の後 |
| `stop.json` | `Stop` | `stop` | `null`（subtype 無し） | ターン終了。`stop_hook_active: false` |

`AGENT_EVENT_TYPES` 側の 4 語がこのツールの**全部**である。表に無い 3 語は
「観測されなかった」のではなく**ロード時に拒否される** — 同梱バンドル `dist/cli.mjs` の
`isHookEvent` が照合する配列は `["PreToolUse","PostToolUse","Stop","SessionStart"]` の 4 要素で、
それ以外は `unknown hook event "…" — skipped` という警告つきで捨てられる。
`UserPromptSubmit` / `Notification` / `SessionEnd` は**書いても登録されない**。

## 使うときの注意

- **payload は Claude 形の snake_case。** `session_id` / `transcript_path` / `cwd` /
  `hook_event_name` / `permission_mode` / `tool_use_id` / `tool_name` / `tool_input`。
  antigravity の camelCase protojson とは別の流儀で、`SESSION_ID_FIELDS` の 1 番目がそのまま効く。
- **`PreToolUse` は承認ダイアログの「後」に発火する。** 同じ tool 呼び出しで
  ダイアログ表示 00:11:37 → 人が承認 00:11:46 → `PreToolUse` 00:11:46。
  したがって**この event を permission-request として扱えない**（Epic #2249 決定 3）。
  `parsePermissionRequest` は `() => null` であり、Auto-Yes は TUI の番号応答のまま。
- **`tool_display_name`（`SHELL` / `WRITE`）は使わない。** ツール自身の UI ラベルであって、
  matcher や運用者の grep が当たるのは `tool_name` のほう。
- **`transcript_path` は cwd から計算できない。** `~/.commandcode/projects/<slug>/<session_id>.jsonl`
  の `<slug>` は cwd を kebab 化したもので、**camelCase も分解される**
  （`MyCodeBranchDesk` → `my-code-branch-desk`）。この fixture の `cwd` と `transcript_path` は
  その対応をそのまま保存してある — Phase C(#2252) が参照する唯一の証拠なので、
  ここだけは `<TRANSCRIPT_PATH>` プレースホルダにしていない。
- **`model` を運ぶフィールドが無い。** 4 event どれにも無く、画面の
  `# models: …` バナー（Phase A の抽出）が唯一の経路である。
- **返答 `{}` で全 event が続行する**（実測）。ブロックになるのは
  `decision: "block"` / `block: true` / `hookSpecificOutput.permissionDecision: "deny"` と、
  **`PreToolUse` / `Stop` での exit code 2** の 4 通りだけ。

## 設定ファイル側の実測（fixture ではないが同時に採ったもの）

- 読まれる層は 3 つで、**上書きではなく合併**される:
  `<cwd>/.commandcode/settings.local.json` → `<cwd>/.commandcode/settings.json` →
  `~/.commandcode/settings.json` の順に読み、全ハンドラを 1 本の配列へ足す
  （重複除去キーは `${event}:${matcher}:${command}`）。
  実測: 2 層に別コマンドを登録すると `◼ Ran 2 session start hooks` と表示された。
- **`matcher` は空文字でなければならない。** ハンドラ選択が
  `if (handler.matcher) { if (!toolName) continue; … }` で、`SessionStart` と `Stop` は
  `toolName: ""` で呼ばれる。つまり**空でない matcher はこの 2 event を消す** —
  `"*"` は「全一致」として*ロードは通る*ので警告も出ない。
  実測: `""` で `◼ Ran 2 session start hooks`、`"*"` で `◼ Ran 1 session start hook`（`""` の層だけ）。
- `timeout` の単位は**秒**、`(0, 600]` の範囲外は警告つきで捨てられる。既定 30。
- `.commandcode/` は git の管理外に**ならない**（`git status` に `?? .commandcode/` と出る）。
  ただし Command Code 自身が初回起動で `.commandcode/taste/taste.md` を書くので、
  この状況は CommandMate が作るものではない。

## プレースホルダ

| 元の値 | プレースホルダ |
|---|---|
| `session_id` | `33333333-3333-4333-8333-333333333333` |
| `cwd` | `/private/tmp/MyCodeBranchDesk/probe` |
| `transcript_path` のホーム | `/Users/example` |
| `tool_use_id` | `call_00_AAAABBBBCCCCDDDDEEEE000<n>` |
