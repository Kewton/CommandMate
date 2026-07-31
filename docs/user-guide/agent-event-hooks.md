# エージェントイベント Hook 設定ガイド

CommandMate はエージェントの完了を、既定では **tmux 画面の文字列解析**で推測している。
本ガイドで設定する hook を入れると、エージェント CLI 自身が発する**構造化イベント**が
第一級の情報源として加わる（Issue #1549）。

> **文字列解析は廃止しない**。hook は設定した人の環境にしか存在しないので、
> 未設定でも従来どおり動くことが前提である。hook は「二つ目の意見」であり、
> 現時点で `wait` やポーラーの完了判定を置き換えてはいない（§5）。

---

## 1. 受け口: `POST /api/hooks/agent-event`

```jsonc
{
  "tool": "claude",          // 既存 CLI ツール id（claude / codex / ...）
  "event": "stop",           // stop | notification | session_start
  "cwd": "/path/to/worktree", // 絶対パス。worktree の解決キー
  "sessionId": "abc123",      // 任意
  "payload": {}               // 任意
}
```

| 応答 | 意味 |
|---|---|
| `202 {"accepted":true}` | 受理。**worktree が解決できた場合も、できなかった場合も同じ応答**（登録済みディレクトリの探索に使われないため） |
| `400` | `tool` / `event` / `cwd` が不正（相対パス・`..` を含む・NUL バイト等） |

認証が有効（`CM_AUTH_TOKEN_HASH` 設定済み）なら、この経路も**認証必須**である。
`Authorization: Bearer <token>` を付けること（後述の `CM_AUTH_TOKEN`）。

`event: "stop"` を受け取ると、`cwd` が指す worktree について次を行う:

1. 実行契約つきの active task があれば `agent_idle` イベントを `task_events` に
   `source=hook` で記録する
2. その契約に `success.autoVerifyOnStop: true` があれば検証ランを自動起動する
   （[task-contract.md](../design/task-contract.md) §2.5。**省略時は false**）
3. セッション状態のヒントとして `lastStopEventAt` を記録する（§5）

契約が無いセッション（大多数）では 1〜2 は何も起こらず、3 だけが記録される。

`notification` / `session_start` は受理・記録されるが、現時点で状態は変えない。

---

## 2. 同梱スクリプト `cmate-agent-event.sh`

`scripts/hooks/cmate-agent-event.sh` は上記を POST するだけの薄いラッパである
（bash 3.2 互換）。

```
cmate-agent-event.sh [--tool ID] [--event EVENT] [--cwd PATH] [--session-id ID]
                     [--json JSON | --stdin-json] [--url URL] [--strict] [JSON]
```

| 環境変数 | 既定 | 用途 |
|---|---|---|
| `CM_HOST` | `127.0.0.1` | サーバホスト |
| `CM_PORT` | `3000` | サーバポート（worktree 並列運用時は該当ポート） |
| `CM_HOOK_URL` | — | 完全な URL。`CM_HOST`/`CM_PORT` より優先 |
| `CM_AUTH_TOKEN` | — | 設定時 `Authorization: Bearer` を付与 |
| `CM_AGENT_TOOL` | `claude` | `--tool` の既定 |
| `CM_HOOK_TIMEOUT` | `5` | curl の `--max-time`（秒） |

`cwd` の決定順は `--cwd` → `CM_AGENT_CWD` → `CLAUDE_PROJECT_DIR` → JSON の `cwd` → `$PWD`。

**POST に失敗しても exit 0 で終わる**。サーバが落ちているという理由でエージェントの
セッションが壊れるほうが害が大きいからである。CI 等で失敗を検出したい場合は `--strict`。

---

## 3. Claude Code の設定（Stop hook）

`~/.claude/settings.json`（プロジェクト限定なら `.claude/settings.json`）:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/scripts/hooks/cmate-agent-event.sh --tool claude --stdin-json"
          }
        ]
      }
    ]
  }
}
```

Claude Code は hook に `{"session_id":"...","hook_event_name":"Stop","cwd":"..."}` を
**stdin の JSON** で渡すので `--stdin-json` を付ける。`hook_event_name` は
`Stop` / `SubagentStop` → `stop`、`Notification` → `notification`、
`SessionStart` → `session_start` に対応づけられる。

ポートを変えている worktree では `command` の前に `CM_PORT=3135 ` を付ける。

> `--stdin-json` を付けないと stdin を読まないので、hook が stdin を渡さない構成でも
> ブロックしない。その場合 `cwd` は `CLAUDE_PROJECT_DIR` か `$PWD` から決まる。

---

## 4. Codex の設定（notify）

`~/.codex/config.toml`:

```toml
notify = ["/absolute/path/to/scripts/hooks/cmate-agent-event.sh", "--tool", "codex"]
```

Codex は notify コマンドの**末尾に JSON 文字列を 1 引数として追加**して起動する。
スクリプトはオプション以外の位置引数を JSON として読み、`type` を event に、
`turn-id` を `sessionId` に対応づける（`agent-turn-complete` → `stop`）。

notify は Codex の作業ディレクトリで起動されるため `cwd` は `$PWD` から決まる。
確実にしたい場合は `"--cwd", "/path/to/worktree"` を足す。

---

## 5. いま hook が「変えないこと」

`lastStopEventAt` は `GET /api/worktrees/:id/current-output` と WebSocket の
ターミナルスナップショットに**露出するだけ**で、`wait` / ポーラー / Auto-Yes の
完了判定はいずれも従来どおり文字列解析の結果で動く。

文字列解析と hook という二重ソースを、実測データを見る前に切り替えるのは
「既知の不正確さ」を「未知の失敗モード」と交換することになる。
判定への組み込みは後続 Issue で、両者の一致率を見てから行う。

---

## 6. 制限事項

- **複数インスタンス**: リクエストにインスタンス id が無いため、イベントは常に
  そのツールの**プライマリインスタンス**（`--instance` 無指定相当）の task に適用される。
  1 worktree で `codex` と `codex-2` を併走させている場合、`codex-2` の hook は
  `codex` の task を動かす。
- **gemini / copilot 等**: 配線は今後。受け口自体は `tool` に既存 CLI ツール id を
  取れるので、同じスクリプトで `--tool` を変えれば送信はできる。
- **`commandmate init` での自動設定**: 本 Issue のスコープ外。上記は手動設定の手順である。

---

## 関連ドキュメント

- [実行契約（Task Contract）](../design/task-contract.md) — `success.autoVerifyOnStop`
- [検証設定](../design/verification-config.md) — 自動起動される検証ゲート
- [CLI 運用ガイド](./cli-operations-guide.md)
