# エージェントイベント Hook 設定ガイド

CommandMate はエージェントの完了を、既定では **tmux 画面の文字列解析**で推測している。
hook を入れると、エージェント CLI 自身が発する**構造化イベント**が第一級の情報源として
加わる（Issue #1549）。

**Claude セッションについては、この hook は CommandMate が自動注入する**（Issue #1722）。
手動設定は不要になった（§0）。手動設定を残していても壊れない — §0.4 を参照。

> **文字列解析は廃止しない**。hook は「二つ目の意見」であり、
> 現時点で `wait` やポーラーの完了判定を置き換えてはいない（§5）。

---

## 0. 自動注入（Claude / Issue #1722）

CommandMate が Claude セッションを**新規作成**するとき、そのセッション専用の
hooks 設定ファイルを生成し `claude --settings <file>` で渡す。

```
~/.commandmate/hooks/claude-<worktreeId>-<instanceId>-<hash>.json
```

| 注入されるイベント | handler | 備考 |
|---|---|---|
| `SessionStart` | `command`（`cmate-agent-event.sh` 中継） | **http は使えない**。§0.2 |
| `UserPromptSubmit` | `http` | |
| `Stop` | `http` | |
| `Notification` | `http`（matcher: `permission_prompt\|idle_prompt`） | matcher は `notification_type` に照合される |
| `SessionEnd` | `http` | |
| `PermissionRequest` | `http`（別受け口 `/api/hooks/permission-request`、timeout 5 秒） | **Auto-Yes v2**（#1724）。§0.6 |

`PreToolUse` は**注入しない**。裁定する仕組みがまだ無く、注入しても全件 no-decision を
返すだけになる（Phase 4 の担当）。

### 0.1 `~/.claude/settings.json` は書き換えられない

`--settings` の hooks はユーザー設定と**同一イベントでも配列連結され、両方が実行される**
（置換ではない）。ユーザーの `~/.claude/settings.json` は sha256 が変わらない（実測）。

### 0.2 `SessionStart` だけ `type:"http"` が使えない

Claude Code は `SessionStart` の http hook を**黙って skip する**（公式ドキュメント未記載）。
debug ログに `HTTP hooks are not supported for SessionStart` が出るだけで、
stdout にも TUI にも何も出ない。そのため `SessionStart` のみ `type:"command"` で
`scripts/hooks/cmate-agent-event.sh` を中継に使う。

### 0.3 無効化（ロールバック）

```bash
CM_AGENT_HOOKS_INJECT=0 commandmate start
```

注入をスキップし、Issue #1722 以前とまったく同じ起動コマンドになる。
生成ファイルの置き場所は `CM_AGENT_HOOKS_DIR` で変更できる。

### 0.4 手動設定との共存（二重配送）

§3 の手動 Stop hook を残したまま自動注入が有効になると、**同じターンの `stop` が 2 回届く**。
`applyAgentStopEvent` の `lastStopEventAt` は上書きなので冪等だが、
`task_events` の `agent_idle` は**配送ごとに 1 行増える**（実測・確認済み）。

そのため受け口は `(worktreeId, cliTool, instance, event, sessionId)` が一致する
イベントを **3 秒以内は 1 回として扱う**。両方の配送は同じ `session_id` を運ぶので
二重配送は畳まれ、別ターン（別 `session_id`）は畳まれない。
`sessionId` を送らない呼び出しは**畳まない**（区別材料が無いため、
実イベントを取りこぼすより重複を許す）。

**手動設定は削除して構わない**（自動注入が同じイベントを送る）。
残す場合も上記 dedup で二重記録は起きない。

### 0.5 注入されないケース

- **既存セッションの再利用時**（healthy なセッションがある場合）は注入しない。
  次回の新規作成から適用される。実行中セッションへの settings 追記は Claude が
  無警告でホットリロードするため技術的には可能だが、
  「この pane はどの設定で動いているか」が時間で変わる状態を避けるために採らない。
- **hook の到着を「起動完了」の signal にしてはいけない**。未 trust ディレクトリでは
  folder trust ダイアログが先に出て、応答するまで `SessionStart` すら発火しない
  （実測 25.3 秒の完全無音）。起動検出は従来どおり `CLAUDE_PROMPT_PATTERN` と
  trust ダイアログ自動応答で行う。
### 0.6 `PermissionRequest`（Auto-Yes v2 / Issue #1724）

他のイベントと違い、これは**同期**で、**応答本文がエージェントに従われる**。
Claude は承認ダイアログを**描く前に**この hook を叩き、CommandMate は 3 通りのうち 1 つを返す。

| 応答 | Claude の挙動 |
|---|---|
| `{}`（no-decision） | 従来どおり TUI 承認ダイアログが出る（＝この機能が無い機械と同じ） |
| `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` | ダイアログを出さず即実行 |
| `deny` | **CommandMate は返さない**（下記） |

裁定表:

| 条件 | 裁定 |
|---|---|
| payload を読めない | no-decision |
| `tool_name` が `AskUserQuestion` | no-decision（常に） |
| Auto-Yes が無効／期限切れ | no-decision |
| 契約 `autoYes` が抑止（`mode: off` / `denyPatterns` 一致 / 型不許可） | no-decision ＋ `lastSuppression` 記録 |
| 上記以外 | `allow` |

- **判定不能は必ず no-decision。** 誤 `allow` はコマンド実行を意味し、no-decision はダイアログが出るだけ。
  この非対称性が全分岐の設計原則になっている。
- **`deny` は返さない。** Auto-Yes の抑止はもともと「自動応答しない」であって「拒否する」ではない。
  `denyPatterns` 該当時も**ダイアログが出て手動で応答できる**（挙動は従来と同じ）。
- **`denyPatterns` の照合対象はそのリクエストの `tool_input` だけ**（Bash なら command、他ツールは主要引数）。
  画面もスクロールバックも入力に無いため、#1699（承認済みの `rm -rf` が以後の無関係な承認まで抑止した不具合）は
  構造的に起こらない。
- **`AskUserQuestion` は突破できない。** `allow` を返しても選択画面はそのまま出る（実測）。
  裏返せば「`respond yes` が承認に化ける」型の事故も起きない。質問への回答は別機構（#1726）の担当。
- **サーバが落ちていてもエージェントは止まらない。** hook の timeout / 接続失敗はすべて fail-open で、
  ダイアログが出るだけになる。
- Auto-Yes のトグルとは**独立に常時注入**される。注入はセッション起動時 1 回きりで、
  Auto-Yes は後から有効化されるため、トグル連動にすると「有効にしたのに hook が無い」状態が生まれる。
- **画面ベースの Auto-Yes は残っている。** hooks 非対応の環境と Claude 以外の CLI では従来どおり動く。


---

## 1. 受け口: `POST /api/hooks/agent-event`

受け口は**2 つのリクエスト形式**を受ける。

**(a) CommandMate 形式**（`cmate-agent-event.sh` と手動設定）:

```jsonc
{
  "tool": "claude",           // 既存 CLI ツール id（claude / codex / ...）
  "event": "stop",            // stop | notification | session_start |
                              // user_prompt_submit | session_end
  "cwd": "/path/to/worktree", // 絶対パス。worktree の解決キー
  "sessionId": "abc123",      // 任意
  "worktreeId": "wt-a",       // 任意。あれば cwd 解決より優先
  "instanceId": "claude-2",   // 任意。無ければプライマリ扱い
  "detail": "idle_prompt"     // 任意。イベント種別のサブタイプ
}
```

**(b) Claude Code のネイティブ payload**（注入した `type:"http"` hook）:

```jsonc
{ "hook_event_name": "Stop", "session_id": "...", "cwd": "...", ... }
```

`type:"http"` はボディを加工できないため、Claude の payload がそのまま届く。
`tool` / `worktreeId` / `instanceId` は**クエリパラメータ**で渡す:

```
POST /api/hooks/agent-event?tool=claude&worktreeId=wt-a&instanceId=claude-2
```

| 応答 | 意味 |
|---|---|
| `202 {"accepted":true}` | 受理。**worktree が解決できた場合も、できなかった場合も同じ応答**（登録済みディレクトリの探索に使われないため） |
| `400` | `tool` / `event`（または `hook_event_name`）/ `cwd` / `instanceId` が不正 |

認証が有効（`CM_AUTH_TOKEN_HASH` 設定済み）なら、この経路も**認証必須**である。
`Authorization: Bearer <token>` を付けること（後述の `CM_AUTH_TOKEN`）。

> **注入した http hook の `headers` で `$CM_AUTH_TOKEN` を使う場合、
> 同じ hook に `allowedEnvVars: ["CM_AUTH_TOKEN"]` を併記しないと展開されない。**
> 併記を忘れるとリテラル文字列 `$CM_AUTH_TOKEN` で認証しにいき、無言で 401 になる。
> 生成器はこれを常に対で出力する。

`event: "stop"` を受け取ると、対象 worktree / instance について次を行う:

1. 実行契約つきの active task があれば `agent_idle` イベントを `task_events` に
   `source=hook` で記録する
2. その契約に `success.autoVerifyOnStop: true` があれば検証ランを自動起動する
   （[task-contract.md](../design/task-contract.md) §2.5。**省略時は false**）
3. セッション状態のヒントとして `lastStopEventAt` を記録する（§5）

契約が無いセッション（大多数）では 1〜2 は何も起こらず、3 だけが記録される。

`stop` 以外のイベントは受理・記録されるが、現時点で状態は変えない。

### 1.1 インスタンスの特定

`cwd` は worktree は特定できるが**インスタンスは特定できない** —
同一 worktree の `claude` と `claude-2` は cwd が同じである。
そのため注入 URL に `worktreeId` / `instanceId` を焼き込み、これを相関キーにする。

**`session_id` は相関キーにしない。** `/clear` は `SessionEnd(reason=clear)` →
`SessionStart(source=clear)` を発火し、そのとき `session_id` が変わる。
インスタンス・worktree・tmux pane はどれも変わっていない。

`worktreeId` / `instanceId` が無いリクエスト（手動設定）は従来どおり
`cwd` から worktree を解決し、**プライマリインスタンス**に適用される。

---

## 2. 同梱スクリプト `cmate-agent-event.sh`

`scripts/hooks/cmate-agent-event.sh` は上記を POST するだけの薄いラッパである
（bash 3.2 互換）。

```
cmate-agent-event.sh [--tool ID] [--event EVENT] [--cwd PATH] [--session-id ID]
                     [--worktree-id ID] [--instance-id ID]
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

`--worktree-id` / `--instance-id` は**指定したときだけ**ボディに載る。
未指定なら受け口は cwd 解決＋プライマリ扱いになるので、Issue #1549 時点の手動設定と
挙動が変わらない。

`hook_event_name` は `Stop` / `SubagentStop` → `stop`、`Notification` → `notification`、
`SessionStart` → `session_start`、`SessionEnd` → `session_end`、
`UserPromptSubmit` → `user_prompt_submit` に対応づけられる。
`PreToolUse` / `PermissionRequest` は**対応づけず exit 2 で拒否する**（本 Issue のスコープ外）。

**POST に失敗しても exit 0 で終わる**。サーバが落ちているという理由でエージェントの
セッションが壊れるほうが害が大きいからである。CI 等で失敗を検出したい場合は `--strict`。

---

## 3. Claude Code の手動設定（Stop hook）

> **Claude では通常この設定は不要**（§0 の自動注入が同じイベントを送る）。
> 以下は CommandMate 以外から起動した Claude セッションや、
> `CM_AGENT_HOOKS_INJECT=0` で運用する場合の手順である。

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
**stdin の JSON** で渡すので `--stdin-json` を付ける。対応づけは §2 のとおり。

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

> **例外は `PermissionRequest` だけ**（§0.6 / Issue #1724）。これは応答がエージェントに
> 従われる唯一のイベントで、Auto-Yes が有効なら承認ダイアログを出さずに実行させる。
> それ以外の判定（`wait` / ポーラー / 完了検知）は以下のとおり従来のまま。

`lastStopEventAt` と `structuredEvents` は
`GET /api/worktrees/:id/current-output` と WebSocket のターミナルスナップショットに
**露出するだけ**で、`wait` / ポーラー / **画面ベース** Auto-Yes の完了判定はいずれも
従来どおり文字列解析の結果で動く。

```jsonc
"lastStopEventAt": 1754470000000,
"structuredEvents": {
  "lastEventType": "notification",   // 直近イベント種別
  "lastEventAt": 1754470000000,
  "lastEventDetail": "idle_prompt"   // notification_type / reason / source
}
```

hook が届いているかを確認したいときはこれを見る。
`lastEventType` が永久に `null` なら注入されていないか、届いていない。

文字列解析と hook という二重ソースを、実測データを見る前に切り替えるのは
「既知の不正確さ」を「未知の失敗モード」と交換することになる。
判定への組み込みは後続 Issue（#1723）で、両者の一致率を見てから行う。

---

## 6. 制限事項

- **手動設定でのインスタンス指定**: `--worktree-id` / `--instance-id` を渡さない
  リクエストは従来どおり**プライマリインスタンス**の task に適用される。
  1 worktree で `codex` と `codex-2` を併走させている場合、`codex-2` の hook に
  `--instance-id codex-2` を足さないと `codex` の task を動かす。
  Claude の自動注入セッションではこれは自動で入る。
- **自動注入は Claude のみ**: codex / gemini / copilot 等への展開は今後。
  受け口自体は `tool` に既存 CLI ツール id を取れるので、
  同じスクリプトで `--tool` を変えれば送信はできる。
- **hook 到着 ≠ 起動完了**: §0.5 のとおり、未 trust ディレクトリでは
  trust ダイアログに答えるまで `SessionStart` すら来ない。
- **hook はすべて fail-open**: timeout も接続失敗もエージェントを止めない。
  CommandMate サーバが落ちていてもセッションは壊れず、イベントだけが失われる
  （`PermissionRequest` なら承認ダイアログが出るだけになる）。
- **`PermissionRequest` は headless `-p` では発火しない**: sandbox guard が先に弾くため、
  非対話実行は Auto-Yes v2 の裁定対象にならない（実測）。
- **ユーザーが「No」を選んだことは hook から分からない**: `PermissionDenied` は TUI で
  拒否しても発火しなかった（実測・登録済み 0 回）。拒否を検知する仕組みには使えない。

---

## 関連ドキュメント

- [実行契約（Task Contract）](../design/task-contract.md) — `success.autoVerifyOnStop`
- [検証設定](../design/verification-config.md) — 自動起動される検証ゲート
- [CLI 運用ガイド](./cli-operations-guide.md)
- [実機検証: Claude Code hooks](../design/agent-hooks-live-verification.md) —
  本ガイドの「実測」の出典（Issue #1721）。公式ドキュメントとの食い違いは §2 にある
- [実 payload fixture](../../tests/fixtures/hooks/claude/) — 実機で採取した 12 件
