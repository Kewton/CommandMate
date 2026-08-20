# 実機検証: Claude Code hooks（Phase 0 スパイク）

- **Issue**: [#1721](https://github.com/Kewton/CommandMate/issues/1721)（親 Epic [#1720](https://github.com/Kewton/CommandMate/issues/1720)）
- **ステータス**: 実測完了（コード変更なし）
- **検証日**: 2026-08-06
- **対象**: Claude Code **v2.1.223**（比較のため 2.1.221 / 2.1.222 も一部実行）
- **プラットフォーム**: macOS (Darwin 25.6.0) / native installer
- **成果物**: 本書 ＋ [`tests/fixtures/hooks/claude/*.json`](../../tests/fixtures/hooks/claude/)
- **公式ドキュメント**: https://code.claude.com/docs/en/hooks （2026-08-06 取得）

> 本書は下流 Issue（#1722 / #1723 / #1724 / #1725 / #1726）が仕様の根拠として引用することを前提に書かれている。
> **本書に書いてあるのは「公式ドキュメントの記述」ではなく「実際に動かして観測した結果」である。**
> ドキュメントと実測が食い違った箇所は [§2](#2-公式ドキュメントと実測の食い違い) にまとめた。

---

## 1. 結論サマリ

| # | 検証項目 | 実測結果 | 再現コマンド／証拠 |
|---|---|---|---|
| 1 | `--settings` のマージ挙動 | **併存（置換ではない）**。`--settings` の hooks はユーザーの `~/.claude/settings.json` の hooks と**同一イベントでも配列連結**され、両方が実行される。ユーザー設定ファイルは書き換わらない（sha256 不変）。`--settings` はファイルパスに加えて**インライン JSON 文字列**も受け付ける | [§5.1](#51-項目-1----settings-のマージ挙動) |
| 2 | trust プロンプトの有無 | `--settings` 由来 hooks 専用の承認ダイアログは**出ない**。ただし**未 trust のディレクトリでは folder trust ダイアログが先に出て、答えるまで `SessionStart` を含む一切の hook が発火しない**（実測 **25.3 秒**の完全無音）。trust はフォルダ単位で一度きり。さらに**セッション実行中に settings.json へ hook を追記すると、承認も警告もなく即座にホットリロードされて発火する** | [§5.2](#52-項目-2--trust-プロンプトの有無) |
| 3 | `type: "http"` の挙動 | localhost への POST **可**（axios / `Content-Type: application/json`）。**`SessionStart` だけ http 非対応**（公式ドキュメント未記載）。`timeout` は**秒**指定・`UserPromptSubmit` の既定は 30 秒。timeout も接続不能も**すべて fail-open**。`headers` の `$VAR` 補間は `allowedEnvVars` 併記で機能。**async は `type:"command"` 限定**（http には無い） | [§5.3](#53-項目-3--type-http-の挙動) |
| 4 | `PermissionRequest` の no-decision | **空応答 `{}` を返すと従来どおり TUI 承認ダイアログが出る**（＝ fail-safe）。`allow` を返すとダイアログを出さず即実行し transcript に `Allowed by PermissionRequest hook`、`deny` を返すと `Denied by PermissionRequest hook`。**http / command 両方で decision が効く**。ただし **headless `-p` では PermissionRequest 自体が発火しない**（sandbox guard が先に弾く） | [§5.4](#54-項目-4--permissionrequest-の-no-decision) |
| 5 | 実 payload 採取 | 12 ファイルを [`tests/fixtures/hooks/claude/`](../../tests/fixtures/hooks/claude/) に収録（`PermissionRequest` / `PreToolUse(AskUserQuestion)` / `Notification(permission_prompt, idle_prompt)` / `Stop` / `UserPromptSubmit` / `SessionStart` / `SessionEnd` ＋派生） | [§5.5](#55-項目-5--実-payload-採取) |
| 6 | hooks が発火しない UI | trust dialog / `/login` / `/model` overlay / **AskUserQuestion の選択画面と「Ready to submit your answers?」確認画面**では**一切のイベントが出ない**。AskUserQuestion は `PreToolUse` がツール呼び出し時に 1 回出るだけで、以降の選択・確定操作は完全に無音。update banner は発生させられず未計測 | [§5.6](#56-項目-6--hooks-が発火しない-ui-の一覧) |
| 7 | 対応バージョン | **v2.1.223 で項目 1〜6 がすべて成立**。`--settings` と「SessionStart は http 非対応」は 2.1.221 / 2.1.222 でも同じ。初出バージョンは手元に 3 版しかないため特定できず | [§5.7](#57-項目-7--対応バージョン) |

### 1.1 下流 Issue が特に依拠すべき結論

| 結論 | 影響する Issue |
|---|---|
| `SessionStart` に `type:"http"` は使えない。**命令中継スクリプト（`type:"command"`）が必須** | #1722（自動注入） |
| `--settings` は既存ユーザー hooks を壊さずに**追加**できる。インライン JSON 可なので一時ファイル生成も不要 | #1722 |
| trust ダイアログが未応答の間は `SessionStart` すら来ない。**hooks 到着を起動完了の signal にすると未 trust worktree で永久に待つ** | #1722 / #1723 |
| `PermissionRequest` の空応答は**必ず TUI ダイアログにフォールバックする**。Auto-Yes v2 は「判断できないときは黙る」だけで安全側に倒れる | #1724 |
| hook の timeout / 接続失敗は**すべて fail-open**。CommandMate サーバが落ちていてもエージェントは止まらない | #1724 |
| **`AskUserQuestion` にも `PermissionRequest` が上がるが、`allow` を返しても選択画面は出る**。Auto-Yes v2 の一律 allow では AskUserQuestion を突破できない（安全だが、突破には別機構が要る） | #1724 / #1726 |
| AskUserQuestion の選択・確定画面は完全に無音。**この画面の検出は scraper に残すしかない** | #1723 / #1726 |
| `/clear` は `SessionEnd(reason=clear)` → `SessionStart(source=clear)` を発火し、**`session_id` が変わる**。session_id を instance の永続キーにしてはいけない | #1722 |

---

## 2. 公式ドキュメントと実測の食い違い

**本 Issue の最重要成果物。** 下流実装者は下表を先に読むこと。

| # | 公式ドキュメント / Epic #1720 本文の記述 | 実測 | 影響 |
|---|---|---|---|
| **D1** | hooks reference は handler type を `command` / `http` / `mcp_tool` / `prompt` / `agent` の 5 種と説明し、**イベントごとの type 制限には触れていない** | **`SessionStart` では `type:"http"` が黙って skip される。**debug ログにのみ `Skipping HTTP hook <url> — HTTP hooks are not supported for SessionStart` が出て、**stdout/TUI には何も表示されない**。2.1.221 / 2.1.222 でも同じ | **最重要。** #1722 が SessionStart を http で組むと「設定は通るのにイベントだけ来ない」無言の失敗になる。`type:"command"` + `scripts/hooks/cmate-agent-event.sh` 相当の中継が必須 |
| **D2** | `PermissionRequest` の入力に `permission_requirements`（必要な権限の説明の配列）と `tool_use_id` があると記載 | 実 payload に **`permission_requirements` は無く、代わりに `permission_suggestions`**（`addRules` 形式の許可ルール候補）が入る。**`tool_use_id` も無い** | #1724 が `tool_use_id` で `PreToolUse` と突き合わせようとすると失敗する。相関には `prompt_id` + `tool_name` + `tool_input` を使うこと。fixture: [`permission-request.json`](../../tests/fixtures/hooks/claude/permission-request.json) |
| **D3** | Epic #1720 は `Notification`（matcher: `permission_prompt\|idle_prompt`）と記載（matcher の照合対象を明示していない） | matcher は payload の **`notification_type`** フィールドに対して照合される。`message` は `"Claude needs your permission"` / `"Claude is waiting for your input"` という**人間向け文言**で、機械判断には使わないこと。存在しない matcher（`no_such_type`）は無言で 0 回 | #1725 は `notification_type` を第一級キーにすること |
| **D4** | timeout 既定は「`command`/`http`/`mcp_tool` は 600 秒、`UserPromptSubmit` は 30 秒に下げる」 | **実測一致**（`UserPromptSubmit` + http、timeout 未指定で **30.005 秒**で cancel）。ただし `async:true` の command hook は `UserPromptSubmit` でも **600000ms** で登録される（30 秒には下げられない） | 一致。async 側の差異は #1722 が長時間 hook を使う場合に効く |
| **D5** | 「Exit code 0 with no output means the hook has no decision to report, so the tool call continues through the normal permission flow」 | **実測一致。** `{}` を返すと TUI ダイアログが出る（[§5.4](#54-項目-4--permissionrequest-の-no-decision) に pane 出力あり） | 一致。Auto-Yes v2 の安全性設計はこの一致に依拠してよい |
| **D6** | `PermissionDenied` イベントが存在すると記載 | **TUI 承認ダイアログでユーザーが「3. No」を選んでも `PermissionDenied` hook は発火しなかった**（登録済み・0 回）。debug ログには `Bash tool permission denied` のみ | #1724 が「ユーザーが拒否した」を hook で知ろうとしても取れない。deny ルール由来の拒否では発火する可能性があるが**本スパイクでは未確認**。断定せずに扱うこと |
| **D7** | Epic #1720 の「検証済み事実」に `type: "http"`（localhost POST・headers 可）とある | **成立**。加えて `headers` 内の `$VAR` は **`allowedEnvVars` に列挙した環境変数のみ**展開される（列挙しないと展開されない） | #1722 が `CM_AUTH_TOKEN` を hook から送る場合、`allowedEnvVars` の併記が必須 |
| **D8** | （記載なし） | **セッション実行中に `~/.claude/settings.json` へ hook を追記すると、承認も警告もなくホットリロードされて次のプロンプトから発火する** | #1722 は「起動済みセッションにも後から注入できる」。同時に**セキュリティ上の注意**でもある（settings を書ける者は無音で任意コマンドを実行できる） |

---

## 3. 再現環境（ハーネス）

すべての実測は**隔離 HOME**と**専用 tmux socket**の中で行った。以下をそのまま再実行すれば同じ観測ができる。

### 3.1 隔離 HOME

`~/.claude/settings.json` を一切触らないため、`HOME` ごと差し替える。
macOS では認証情報が Keychain（service `Claude Code-credentials`）にあるが、**config dir が既定以外だと Keychain は参照されず `Not logged in` になる**（実測）。
そのため隔離 HOME には `.claude/.credentials.json` を Keychain から書き出して渡す。

```bash
SP=/path/to/scratchpad                       # 作業用一時ディレクトリ
mkdir -p "$SP"/{home/.claude,work,dumps,ctrl,logs}

# 認証情報（mode 600・検証後に削除すること）
umask 077
security find-generic-password -s "Claude Code-credentials" -w > "$SP/home/.claude/.credentials.json"

# オンボーディングをスキップするための最小 ~/.claude.json
python3 - "$SP" <<'PY'
import json, sys, os
src = json.load(open(os.path.expanduser('~/.claude.json')))
keep = ['oauthAccount','userID','anonymousId','machineID','hasCompletedOnboarding',
        'lastOnboardingVersion','firstStartTime','installMethod','autoUpdates',
        'hasAvailableSubscription','claudeCodeFirstTokenDate']
out = {k: src[k] for k in keep if k in src}
out.update({'projects': {}, 'mcpServers': {}, 'numStartups': 50})
json.dump(out, open(os.path.join(sys.argv[1], 'home', '.claude.json'), 'w'), indent=2)
PY

# 動作確認（PONG が返れば隔離 HOME で認証できている）
( cd "$SP/work" && HOME="$SP/home" claude -p "Reply with exactly: PONG" --output-format text < /dev/null )
```

> **注意**: `CLAUDE_CONFIG_DIR` だけを差し替えても同様に `Not logged in` になる（実測）。
> `--settings` のみでの検証も可能だが、`/model` overlay はフッタが `Enter to set as default` であり
> **誤って Enter を押すとユーザーのグローバル既定モデルが変わる**。隔離 HOME を強く推奨する。

### 3.2 リクエストダンプサーバ

hook の受け側。**稼働中の本番サーバ（port 3000）には絶対に飛ばさない**（`stop` イベントが本番 DB の `task_events` に書かれる）。
`ctrl/<tag>.response` / `.delay` / `.status` を置くだけで、再起動なしに応答内容・遅延・ステータスを差し替えられる。

```python
# $SP/dumpserver.py — 使い捨て hook レシーバ
import json, os, sys, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DUMPS, CTRL = os.path.join(ROOT, "dumps"), os.path.join(ROOT, "ctrl")
SEQ, LOCK = [0], threading.Lock()

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        tag = self.path.strip("/").split("/")[-1] or "root"
        with LOCK:
            SEQ[0] += 1
            seq = SEQ[0]
        base = os.path.join(DUMPS, "%03d-%s" % (seq, tag))
        open(base + ".body.json", "wb").write(raw)
        json.dump({"seq": seq, "tag": tag, "path": self.path,
                   "iso": time.strftime("%H:%M:%S"),
                   "headers": dict(self.headers.items())},
                  open(base + ".meta.json", "w"), indent=2)
        d = os.path.join(CTRL, tag + ".delay")
        if os.path.exists(d):
            time.sleep(float(open(d).read().strip()))
        r = os.path.join(CTRL, tag + ".response")
        body = open(r, "rb").read() if os.path.exists(r) else b"{}"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send_response(200); self.send_header("Content-Length", "3")
        self.end_headers(); self.wfile.write(b"ok\n")

    def log_message(self, *a):
        pass

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
```

```bash
nohup python3 "$SP/dumpserver.py" 8791 > "$SP/logs/server.out" 2>&1 &
curl -sS http://127.0.0.1:8791/ping     # => ok
```

`type:"command"` 側は stdin の payload をそのまま中継するだけのシムを使う。

```bash
cat > "$SP/hookpost.sh" <<'SH'
#!/usr/bin/env bash
set -u
TAG="${1:-cmd}"
BODY="$(cat)"
printf '%s' "$BODY" | curl -sS -m 10 -X POST -H 'Content-Type: application/json' \
  --data-binary @- "http://127.0.0.1:8791/hook/${TAG}" 2>/dev/null
exit 0
SH
chmod +x "$SP/hookpost.sh"
```

### 3.3 tmux の隔離（必読）

エージェントは tmux ペインの中で動いており `$TMUX` はユーザーの本番サーバを指している。
tmux の解決順は **`-L` / `-S` > `$TMUX` > `TMUX_TMPDIR`** なので、**`TMUX_TMPDIR` では隔離できない**。
必ず `-L <専用socket>` を使うこと。

```bash
# 起動（パイプを挟むと --print モードに落ちるので tee 等を挟まない）
tmux -L cmate-spike new-session -d -s cmate-spike-1 -x 200 -y 50 -c "$SP/work" \
  "env HOME='$SP/home' TERM=xterm-256color claude --settings '$SP/settings.json' --debug-file '$SP/logs/debug.log'"

# 観測
tmux -L cmate-spike capture-pane -p -t '=cmate-spike-1:0.0'

# 後始末（kill-server は絶対に使わない。完全一致ターゲットで session だけ落とす）
tmux -L cmate-spike kill-session -t '=cmate-spike-1:'
```

- **`kill-server` は書かない**（`-L` を付け忘れた瞬間にユーザーの全 `mcbd-*` セッションが飛ぶ）。専用 socket なら最後の session 終了でサーバも自然終了する。
- `bind-key` / `unbind-key` / `set-option -g` を既定サーバへ撃たない。

### 3.4 デバッグログ

`--debug hooks --debug-file <path>` が本スパイクの一次証拠源。
**hook の skip・timeout・fail-open はここにしか出ない**（TUI にも stdout にも出ない）。

---

## 4. 観測に使った設定ファイル

<details>
<summary>TUI 検証用 <code>settings-T.json</code>（項目 2/4/5/6）</summary>

```json
{
  "hooks": {
    "SessionStart":     [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/session-start" } ] } ],
    "SessionEnd":       [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/session-end" } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/user-prompt-submit" } ] } ],
    "PermissionRequest":[ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/permission-request" } ] } ],
    "PermissionDenied": [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/permission-denied" } ] } ],
    "Notification":     [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/notification" } ] } ],
    "Stop":             [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/stop" } ] } ],
    "ConfigChange":     [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/config-change" } ] } ],
    "PreToolUse": [
      { "matcher": "AskUserQuestion", "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/pretooluse-askuserquestion" } ] },
      { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/pretooluse-any" } ] }
    ]
  }
}
```
</details>

<details>
<summary>Notification matcher 検証用 <code>settings-T2.json</code>（項目 5）</summary>

```json
{
  "hooks": {
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh session-start-cmd" } ] } ],
    "Notification": [
      { "matcher": "permission_prompt", "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/notif-matcher-permission" } ] },
      { "matcher": "idle_prompt",       "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/notif-matcher-idle" } ] },
      { "matcher": "no_such_type",      "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/notif-matcher-bogus" } ] }
    ],
    "PermissionRequest": [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:8791/hook/permission-request" } ] } ]
  }
}
```
</details>

---

## 5. 検証項目ごとの実測

### 5.1 項目 1 — `--settings` のマージ挙動

**結論: 併存する（配列連結）。ユーザー設定は書き換わらない。インライン JSON も可。**

#### 何を実行したか

隔離 HOME の `~/.claude/settings.json` に `UserPromptSubmit`（command → タグ `us-ups`）を、
`--settings` 側に同じ `UserPromptSubmit`（command → `cli-ups-cmd`、http → `cli-ups-http`）を置いて 1 回だけプロンプトを投げた。

```bash
cd "$SP/work"
HOME="$SP/home" claude -p "Reply with exactly: PONG-A" --output-format text \
  --settings "$SP/cli-settings.json" --debug hooks --debug-file "$SP/logs/debug-A.log" < /dev/null
```

#### 何が起きたか

ダンプサーバに 3 本すべてが届いた（＝置換ではなく**併存**）。

```
001-us-session-start      <- ~/.claude/settings.json 由来（command）
002-cli-session-start     <- --settings 由来（command）
003-cli-ups-http          <- --settings 由来（http）
004-cli-ups-cmd           <- --settings 由来（command）
005-us-ups                <- ~/.claude/settings.json 由来（command）
006-cli-stop
007-cli-session-end
```

- 同一イベント（`UserPromptSubmit`）に対して **3 本の hook がすべて実行された**。
- 観測された実行順は http → command(`--settings`) → command(user settings) だったが、**1 回の観測**であり順序に依存する実装をしてはならない。
- 実行後、隔離 HOME の `settings.json` も本物の `~/.claude/settings.json` も**内容不変**（[§6](#6-非汚染の証拠)）。

#### インライン JSON

`claude --help` は `--settings <file-or-json>` と書いており、実際に JSON 文字列を直接渡せた。

```bash
INLINE='{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"http","url":"http://127.0.0.1:8791/hook/inline-json-settings"}]}]}}'
HOME="$SP/home" claude -p "Reply with exactly: PONG-E" --output-format text --settings "$INLINE" < /dev/null
# => PONG-E / dumps に 064-inline-json-settings が到着
```

→ **#1722 は設定ファイルを worktree に書き出さずに hooks を注入できる。**

---

### 5.2 項目 2 — trust プロンプトの有無

**結論: `--settings` 由来 hooks 専用の承認ダイアログは無い。しかし folder trust ダイアログが hooks 発火を完全にブロックする。**

#### 何を実行したか

**一度も開いたことのないディレクトリ**（`$SP/work2`）で TUI セッションを起動し、
ダイアログが出ている間にダンプサーバの受信数を数えた。

```bash
tmux -L cmate-spike new-session -d -s cmate-spike-1 -x 200 -y 50 -c "$SP/work2" \
  "env HOME='$SP/home' TERM=xterm-256color claude --settings '$SP/settings-T.json' --debug-file '$SP/logs/debug-T.log'"
sleep 8
tmux -L cmate-spike capture-pane -p -t '=cmate-spike-1:0.0'
ls -1 "$SP/dumps"/*.body.json | wc -l          # 起動前と同じ ＝ 0 件到着
```

#### 何が起きたか

```
 Accessing workspace:
 /…/scratchpad/work2

 Quick safety check: Is this a project you created or one you trust? …

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
```

- このダイアログが出ている間、**hook は 1 本も発火しない**（受信数は起動前と同一）。
- `Enter` で trust した直後に初めて `SessionStart` が発火した。

| 時刻 | 事象 | 出典 |
|---|---|---|
| `07:55:45.891Z` | claude プロセス起動（`Registered 0 hooks from 0 plugins`） | `debug-T.log` |
| — | folder trust ダイアログ表示・人間の応答待ち | pane capture |
| `07:56:11.147Z` | `Hook SessionStart:startup (SessionStart) success` | `debug-T.log` |

→ **25.3 秒間、hooks は完全に無音**。この時間は人間の応答時間そのものなので、無応答なら無限に伸びる。

- **`--settings` の hooks に対する固有の承認ダイアログ・警告は出なかった**（v2.1.223）。出るのは folder trust だけ。
- trust は**フォルダ単位で一度きり**。同じディレクトリで 2 回目のセッションを起動したときはダイアログなしで即 `SessionStart` が発火した。

#### 追加観測: 実行中の settings 変更はホットリロードされる（承認なし）

セッションを起動したまま、隔離 HOME の `~/.claude/settings.json` に `UserPromptSubmit` hook を**追記**し、
次のプロンプトを投げた。

```bash
# セッション起動中に settings.json を書き換える
cat > "$SP/home/.claude/settings.json" <<JSON
{ "hooks": { "SessionStart":    [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh us-session-start" } ] } ],
             "UserPromptSubmit":[ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh us-ups-added-midsession" } ] } ] } }
JSON
# → 次のプロンプト送信で 057-us-ups-added-midsession が到着
```

**承認ダイアログも警告も出ないまま新しい hook が実行された。**
`startClaudeSession` の初期化ループへの影響は次の 2 点に整理できる。

1. **hooks 到着を「起動完了」の signal にしてはいけない。** 未 trust の worktree では永久に来ない。従来どおり pane 描画（trust ダイアログの検出）で起動シーケンスを進める必要がある。
2. **再起動なしで注入できる。** #1722 は既存セッションに対しても settings 書き換えだけで hooks を有効化できる（ただし `--settings` の内容は起動時固定なので、実行中注入はユーザー/プロジェクト設定ファイル経由になる）。

---

### 5.3 項目 3 — `type: "http"` の挙動

#### 5.3.1 localhost への POST

**可**。ダンプサーバが受け取ったリクエストヘッダ:

```json
{
  "Accept": "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "User-Agent": "axios/1.15.2",
  "Host": "127.0.0.1:8791",
  "Connection": "keep-alive"
}
```

body は hook payload の JSON そのもの。デバッグログ:

```
[DEBUG] Hooks: HTTP hook POST to http://127.0.0.1:8791/hook/cli-ups-http
[DEBUG] Hooks: HTTP hook response status 200, body length 2
[DEBUG] Hook UserPromptSubmit (UserPromptSubmit) success:
```

#### 5.3.2 `SessionStart` は http 非対応（**ドキュメント未記載・D1**）

`SessionStart` に http hook を登録すると、**エラーにもならず黙って skip される**。

```bash
grep -o 'HTTP hooks are not supported for [A-Za-z]*' "$SP/logs/debug-T.log" | sort -u
# => HTTP hooks are not supported for SessionStart
```

```
2026-08-06T07:55:05.876Z [DEBUG] Skipping HTTP hook http://127.0.0.1:8791/hook/session-start — HTTP hooks are not supported for SessionStart
```

- 同じ設定ファイルの他イベント（`SessionEnd` / `UserPromptSubmit` / `PreToolUse` / `PermissionRequest` / `Notification` / `Stop`）は**すべて http で発火した**。制限は `SessionStart` だけ。
- **TUI にも stdout にも一切表示されない。**`--debug-file` を取らない限り気付けない。
- 2.1.221 / 2.1.222 でも同一メッセージを確認（再現コマンドは [§5.7](#57-項目-7--対応バージョン)）。
- 回避策: `SessionStart` は `type:"command"` にする（本スパイクでも command で正常に取得できている）。

#### 5.3.3 timeout — 単位は秒 / fail-open

ダンプサーバの応答を意図的に遅延させて測定した。

| 条件 | POST 時刻 | 打ち切り時刻 | 実測 | セッション |
|---|---|---|---|---|
| `"timeout": 2`、サーバ遅延 5 秒 | `07:51:51.830Z` | `07:51:53.834Z` | **2.004 秒** | 継続（`PONG-B1` / exit 0） |
| `timeout` 未指定（`UserPromptSubmit`）、サーバ遅延 120 秒 | `07:52:16.192Z` | `07:52:46.197Z` | **30.005 秒** | 継続（`PONG-B3` / exit 0） |

```
2026-08-06T07:51:53.834Z [DEBUG] Hook UserPromptSubmit (UserPromptSubmit) cancelled:
Hook cancelled
```

- **`timeout` の単位は秒**（ミリ秒ではない）。
- `UserPromptSubmit` の既定 timeout は **30 秒**。公式ドキュメントの「`UserPromptSubmit` lowers the `command`, `http`, and `mcp_tool` default to 30」と一致（D4）。
- **timeout しても hook は "cancelled" になるだけでセッションは進む＝ fail-open。**

#### 5.3.4 接続不能時 — fail-open

誰も listen していないポートを指定した場合:

```
2026-08-06T07:52:26.240Z [ERROR] Hooks: HTTP hook error: connect ECONNREFUSED 127.0.0.1:8799
2026-08-06T07:52:26.240Z [DEBUG] Hook UserPromptSubmit (UserPromptSubmit) error:
```

`PONG-B2` が返り exit 0。**接続失敗でもエージェントは止まらない。**

> **#1724 への含意**: CommandMate サーバが停止していても、hooks 経由の裁定が効かなくなるだけで
> エージェントセッションは壊れない。`PermissionRequest` は [§5.4](#54-項目-4--permissionrequest-の-no-decision) のとおり TUI ダイアログにフォールバックする。

#### 5.3.5 `headers` と `$VAR` 補間

```json
{ "type": "http", "url": "http://127.0.0.1:8791/hook/hdr-probe",
  "headers": { "X-Cmate-Probe": "d", "X-From-Env": "$CMATE_SPIKE_ENVVAR",
               "Authorization": "Bearer $CMATE_SPIKE_TOKEN" },
  "allowedEnvVars": ["CMATE_SPIKE_ENVVAR", "CMATE_SPIKE_TOKEN"] }
```

```bash
HOME="$SP/home" CMATE_SPIKE_ENVVAR="env-value-123" CMATE_SPIKE_TOKEN="tok-abc" \
  claude -p "Reply with exactly: PONG-D" --settings "$SP/settings-D.json" ...
```

受信ヘッダ:

```json
{ "X-Cmate-Probe": "d", "X-From-Env": "env-value-123", "Authorization": "Bearer tok-abc" }
```

→ **`allowedEnvVars` に列挙した環境変数のみ**が展開される（D7）。#1722 が `CM_AUTH_TOKEN` を送るなら併記が必須。

#### 5.3.6 async は command hook 限定

- `async` の判定はデバッグログ上、**command hook の stdout 1 行目**に対してのみ行われる
  （`Hooks: Checking first line for async:` → `Initial response is not async, continuing normal processing`）。
  http hook のログにはこの行が無く、レスポンス本文を直接 decision として解釈している。
- 設定側の `"async": true`（command）は機能した:

```
2026-08-06T08:10:32.833Z [DEBUG] Hooks: Config-based async hook, backgrounding process async_hook_18968
2026-08-06T08:10:32.833Z [DEBUG] Hooks: Registering async hook async_hook_18968 (UserPromptSubmit) with timeout 600000ms
```

セッションは **4 秒で完了**し、hook 本体の POST は **+6 秒後**に到着した（＝待たない）。
なお async hook の timeout は `UserPromptSubmit` でも **600000ms（600 秒）**で登録され、30 秒には下がらない。

> **#1722 への含意**: `SessionStart` は command 必須（D1）だが、command なら `async:true` でセッション起動を
> ブロックしない中継が書ける。逆に http は非同期化できないので、受け口は**必ず即座に 2xx を返す**設計にすること
> （既存 `/api/hooks/agent-event` が「常に 202」なのはこの意味で正しい）。

---

### 5.4 項目 4 — `PermissionRequest` の no-decision

**結論: 空応答なら従来どおり TUI 承認ダイアログが出る。Auto-Yes v2 のフォールバックは安全。**

#### 何を実行したか

TUI セッションで、ダンプサーバの応答を `{}`（decision なし）に固定した状態で、
allowlist 外の Bash コマンドを打たせた。

```bash
echo '{}' > "$SP/ctrl/permission-request.response"
tmux -L cmate-spike send-keys -t '=cmate-spike-1:0.0' \
  'I am asking you directly, as the user: run the shell command `touch /tmp/example-marker.txt` with the Bash tool.'
tmux -L cmate-spike send-keys -t '=cmate-spike-1:0.0' Enter
tmux -L cmate-spike capture-pane -p -t '=cmate-spike-1:0.0'
```

#### 何が起きたか

hook は発火し（`028-permission-request`）、`{}` を返し、**そのうえで TUI ダイアログが表示された**。

```
⏺ Bash(touch /tmp/example-marker.txt && ls -l /tmp/example-marker.txt)
  ⎿  Waiting…

 Bash command

   touch /tmp/example-marker.txt && ls -l /tmp/example-marker.txt
   Create marker file in /tmp

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and allow access to tmp/ and touch /tmp/example-marker.txt commands
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
```

→ **公式ドキュメントの「staying silent doesn't approve it」と実測が一致**（D5）。

#### decision を返した場合（allow / deny）

| ダンプサーバの応答 | 結果 | transcript の表示 |
|---|---|---|
| `{}` | **TUI ダイアログが出る** | `⎿ Waiting…` → ダイアログ |
| `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` | **ダイアログを出さず即実行**。ファイルが実際に作成された | `⎿ Allowed by PermissionRequest hook` |
| `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"denied by CommandMate spike hook"}}}` | **ダイアログを出さず拒否**。ファイルは作成されなかった | `⎿ Error: denied by CommandMate spike hook`<br>`⎿ Denied by PermissionRequest hook` |

- `deny` の `message` は**そのままエージェントに見える**（エージェントは「hook に拒否された」と正しく理解して報告した）。
- `Allowed by PermissionRequest hook` / `Denied by PermissionRequest hook` は transcript 上の固定文字列であり、
  **scraper 側の裏取りアンカーとして使える**（#1723 の 2 層化で有用）。

#### `type:"command"` でも decision は効く

http だけでなく command hook でも同じ結果になった。

```bash
cat > "$SP/hook-allow.sh" <<'SH'
#!/usr/bin/env bash
set -u
cat > /dev/null
printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
exit 0
SH
# settings: { "hooks": { "PermissionRequest": [ { "hooks": [ { "type": "command", "command": "$SP/hook-allow.sh" } ] } ] } }
# => ダイアログ無しで実行され、transcript に「⎿ Allowed by PermissionRequest hook」
```

#### 重要な制約 1: headless `-p` では `PermissionRequest` が発火しない

`claude -p` で作業ディレクトリ外への書き込みを指示した 2 回とも、
**`PreToolUse` は発火したが `PermissionRequest` は 0 回**で、sandbox の書き込みガードが先に弾いた。

```
The command was blocked by the sandbox — this session may only write inside `…/work`
```

→ **Auto-Yes v2 の検証・回帰テストは TUI セッション（tmux）で行う必要がある。** headless では再現しない。

#### 重要な制約 2: TUI で「No」を選んでも `PermissionDenied` は来ない（D6）

`PermissionDenied` hook を登録した状態で「3. No」を選んだが、**hook は 0 回**。
デバッグログには `Bash tool permission denied` が出るのみ。
deny ルール由来の拒否で発火するかは本スパイクでは**未確認**なので、断定して設計しないこと。

---

### 5.5 項目 5 — 実 payload 採取

収録先: [`tests/fixtures/hooks/claude/`](../../tests/fixtures/hooks/claude/)

| ファイル | イベント | 採取した状況 |
|---|---|---|
| `session-start.json` | `SessionStart` (`source: "startup"`) | TUI 起動（trust 応答後） |
| `session-start-clear.json` | `SessionStart` (`source: "clear"`) | `/clear` 実行時 |
| `user-prompt-submit.json` | `UserPromptSubmit` | TUI でプロンプト送信 |
| `pre-tool-use-bash.json` | `PreToolUse` (`tool_name: "Bash"`) | 承認が要る Bash 呼び出し |
| `pre-tool-use-ask-user-question.json` | `PreToolUse` (`tool_name: "AskUserQuestion"`) | 2 問 × 選択肢つきの質問 |
| `permission-request.json` | `PermissionRequest` (`tool_name: "Bash"`) | 上記 Bash の承認要求 |
| `permission-request-ask-user-question.json` | `PermissionRequest` (`tool_name: "AskUserQuestion"`) | AskUserQuestion も承認要求を上げる |
| `notification-permission-prompt.json` | `Notification` (`notification_type: "permission_prompt"`) | 承認ダイアログ表示から **6 秒後** |
| `notification-idle-prompt.json` | `Notification` (`notification_type: "idle_prompt"`) | ターン終了から **60 秒後** |
| `stop.json` | `Stop` | ターン終了 |
| `session-end.json` | `SessionEnd` (`reason: "prompt_input_exit"`) | `/exit` |
| `session-end-clear.json` | `SessionEnd` (`reason: "clear"`) | `/clear` |

**プレースホルダ**（環境固有値を置換済み）:

| 元の値 | プレースホルダ |
|---|---|
| `session_id` | `00000000-0000-4000-8000-000000000000` |
| `prompt_id` | `11111111-1111-4111-8111-111111111111` |
| `tool_use_id` | `toolu_0000000000000000000000000` |
| `transcript_path` | `<TRANSCRIPT_PATH>` |
| `cwd` | `<CWD>` |
| 検証用の絶対パス | `/tmp/example-marker.txt` |

#### 全イベント共通のフィールド

```
session_id / transcript_path / cwd / hook_event_name
prompt_id        … 最初のユーザー入力より前のイベント（SessionStart 等）には無い
permission_mode  … Notification / SessionStart / SessionEnd には無い
effort.level     … PreToolUse / PermissionRequest / Stop にはあるが UserPromptSubmit には無い
```

**フィールドの有無はイベントごとに違う。全イベント共通で存在するのは `session_id` / `transcript_path` / `cwd` / `hook_event_name` の 4 つだけ**なので、パーサはそれ以外を optional として扱うこと。

#### `Notification` の matcher（実測）

`matcher` は payload の **`notification_type`** に対して照合される（D3）。

| matcher | 発火 |
|---|---|
| `"permission_prompt"` | 承認ダイアログのときだけ発火（`17:07:15` の `PermissionRequest` → `17:07:21` に発火。**6 秒後**） |
| `"idle_prompt"` | 入力待ちのときだけ発火（ターン終了 → **約 60 秒後**） |
| `"no_such_type"` | 一度も発火しない（エラーも警告も無い） |

`message` は `"Claude needs your permission"` / `"Claude is waiting for your input"` という人間向け文言。**機械判断には `notification_type` を使うこと。**

#### `session_id` は `/clear` で変わる

```
17:05:46  session-end        reason=clear   session_id=d058e554…
17:05:46  us-session-start   source=clear   session_id=25969b1f…   ← 別 ID
```

→ **#1722 の instance 相関で `session_id` を永続キーにしてはいけない。** `/clear` のたびに切り替わる。

---

### 5.6 項目 6 — hooks が発火しない UI の一覧

各 UI を表示させ、**表示中にダンプサーバの受信件数が増えないこと**で判定した。

| UI | hooks イベント | 実測 | 備考 |
|---|---|---|---|
| **folder trust dialog** | **無し** | 起動〜trust 応答まで **25.3 秒間 0 件**。応答して初めて `SessionStart` | [§5.2](#52-項目-2--trust-プロンプトの有無)。**hooks 到着を起動完了の signal にできない根拠** |
| **`/login` メニュー** | **無し** | overlay 表示中、受信件数 29 → 29 | 「Select login method」まで表示して Esc |
| **`/model` overlay** | **無し** | overlay 表示中、受信件数 29 → 29 | Esc で閉じた場合。**モデルを実際に変更したときに `ConfigChange` が出るかは未計測**（グローバル既定を書き換える操作なので実行しなかった） |
| **AskUserQuestion 選択画面** | **無し** | 選択肢の提示中・回答操作中とも 23 → 23 | `PreToolUse` はツール呼び出し時に **1 回だけ**。以降は無音 |
| **AskUserQuestion「Ready to submit your answers?」確認画面** | **無し** | 確認画面表示中 23 → 23 | **#1708 で問題になった画面そのもの。構造化イベントが存在しないので scraper 依存が残る** |
| AskUserQuestion 送信後 | `Stop` | 23 → 24 | 回答確定後にターンが再開して `Stop` |
| **update banner** | **未計測** | 更新保留状態を作れず再現できなかった | 上記の傾向（起動シーケンス系ダイアログは全部無音）から**発火しないと考えるのが自然だが、実測していない** |
| composer への suggested-reply 自動入力 | **無し** | ターン終了後に composer へ提案文が自動で入る場面を観測 | 「ユーザーが入力中」と誤認しうる。scraper 側の既知の毒 |

#### `AskUserQuestion` と `PermissionRequest` の関係（**#1724 / #1726 の要）**

`AskUserQuestion` はツール呼び出しなので `PermissionRequest` も上げる。

```json
{ "hook_event_name": "PermissionRequest", "tool_name": "AskUserQuestion",
  "tool_input": { "questions": [ … ] } }
```

`Bash` の場合と違い **`permission_suggestions` が無い**。
そして決定的に重要なのは:

> **`PermissionRequest` に `decision.behavior = "allow"` を返しても、AskUserQuestion の選択画面はそのまま表示される。**

（`ctrl/permission-request.response` に allow を入れた状態で AskUserQuestion を誘発し、
ダンプサーバのログで allow を返したことを確認したうえで、pane には選択画面が出ることを確認した）

- **良い面**: Auto-Yes v2 が `PermissionRequest` を一律 allow しても、AskUserQuestion が勝手に回答されることはない（＝「`respond yes` が承認に化ける」型の事故は起きない）。
- **悪い面**: 一律 allow では **AskUserQuestion の停止を解消できない**。#1726 が別機構として必要な理由がこれ。

#### 2026-08-06 追記（Issue #1726 の実測による訂正）

本節の「AskUserQuestion 表示中は一切のイベントが出ない」は、**イベントを数えた窓の外で 2 件が発火していた**。
#1726 の実装時に `PreToolUse` / `PostToolUse` / `Notification` / `Stop` を登録した dump サーバへ実セッション
（v2.1.223）を流し、ボディごと採取した結果:

| 時刻 | イベント | 画面 |
|---|---|---|
| 15:36:04.112 | `PreToolUse`（`AskUserQuestion`） | 選択画面が描かれる |
| 15:36:10.127 | **`Notification`（`permission_prompt`）** | **選択画面は出たまま** |
| 15:36:28.643 | **`PostToolUse`（`AskUserQuestion`）** | 人間が回答した直後 |
| 15:36:29.992 | `Stop` | ターン終了 |

訂正は 2 点:

1. **`Notification(permission_prompt)` は AskUserQuestion でも発火する。** §5.5 の「ダイアログ描画の約 6 秒後」
   という遅延がそのまま効いており、本節の計測窓（23 → 23）はその 6 秒より後に始まっていたと考えられる。
   **「イベントが来た＝画面が閉じた」と読んではいけない。**
2. **`PostToolUse` は発火する。** 本書は「登録済み・0 回」としていたが、`AskUserQuestion` に matcher を絞って
   登録すると回答確定の直後（`Stop` の 1.3 秒前）に届く。payload は `tool_input` に加えて
   `tool_response.answers`（選んだラベル）を持つ。fixture:
   [`post-tool-use-ask-user-question.json`](../../tests/fixtures/hooks/claude/post-tool-use-ask-user-question.json)

「選択・確定の**操作中**は無音」（＝どの画面を表示しているかは構造化イベントから判らない）という本節の結論自体は
変わらない。変わるのは**イベントの有無を画面遷移の signal に使えない**という点で、#1726 はこれを踏まえて
「画面の検出は scraper、選択肢の内容は `PreToolUse` の payload」という分担にしている。

---

### 5.7 項目 7 — 対応バージョン

- **v2.1.223 で項目 1〜6 がすべて成立**（本書の全実測がこの版）。

```bash
claude --version   # => 2.1.223 (Claude Code)
```

- 手元に残っていた過去 2 版でも `--settings` は動作し、**`SessionStart` の http 非対応も同じ**だった。

```bash
BIN_DIR=$(dirname "$(readlink -f "$(which claude)")")     # native installer の版別バイナリ置き場
for v in 2.1.221 2.1.222; do
  HOME="$SP/home" "$BIN_DIR/$v" -p "Reply with exactly: PONG-$v" --output-format text \
    --settings "$SP/settings-V.json" --debug hooks --debug-file "$SP/logs/debug-$v.log" < /dev/null
  grep -o 'HTTP hooks are not supported for [A-Za-z]*' "$SP/logs/debug-$v.log" | sort -u
done
# 2.1.221 => PONG-2.1.221 / HTTP hooks are not supported for SessionStart
# 2.1.222 => PONG-2.1.222 / HTTP hooks are not supported for SessionStart
```

- **各機能の初出バージョンは特定できなかった。**手元に 3 版（2.1.221 / 2.1.222 / 2.1.223）しかないため。
  公式ドキュメントには `prompt_id` について "absent until first user input, v2.1.196+" という記述があるが、これは**実測していない**。
- したがって本 Epic の実装は **「v2.1.223 で動作」を前提**とし、対応版レンジを狭く仮定しないこと。

---

## 6. 非汚染の証拠

### 6.1 `~/.claude/settings.json` の before / after

```bash
# 検証開始前
shasum -a 256 ~/.claude/settings.json
# b08b823b14c1961ed867cd765306018a45e14108d22ade1d04208a31971698a8  /Users/…/.claude/settings.json

# 全検証（TUI 3 セッション ＋ headless 9 回 ＋ /model overlay ＋ /login overlay）終了後
diff "$SP/baseline/settings.json.before" ~/.claude/settings.json && echo "GLOBAL_SETTINGS_DIFF_EMPTY"
# => GLOBAL_SETTINGS_DIFF_EMPTY
shasum -a 256 ~/.claude/settings.json
# b08b823b14c1961ed867cd765306018a45e14108d22ade1d04208a31971698a8  /Users/…/.claude/settings.json
```

**diff は空、sha256 も一致。ユーザーのグローバル設定は一切書き換わっていない。**

`/model` overlay を開いて Esc で閉じた直後、**隔離 HOME 側の** `settings.json` も不変であることを別途確認した。
なお `/model` の overlay フッタは `Enter to set as default · s to use this session only · Esc to cancel` であり、
**Enter を押していたら既定モデルが書き換わっていた**。隔離 HOME を使う理由がこれである。

### 6.2 tmux

- すべて `tmux -L cmate-spike` の**専用 socket 上**で実行。
- `kill-server` は使用していない。後始末は `/exit` と `kill-session -t '=cmate-spike-1:'`（完全一致）のみ。
- 検証後、既定 socket 上のユーザーセッション（`mcbd-claude-*` 5 本）は**全て健在**であることを `tmux list-sessions` で確認済み。

### 6.3 その他

- hook の受け側は使い捨てのダンプサーバ（127.0.0.1:8791）のみ。**本番サーバ（port 3000）へは 1 件も送っていない**ので、本番 DB の `task_events` は無変更。
- 隔離 HOME に書き出した `.credentials.json`（Keychain 由来）は mode 600 で作成し、検証完了後に削除した。

---

## 7. 未検証・積み残し

下流実装者が「実測済み」と誤解しないよう明示する。

| 項目 | 状態 | 理由 |
|---|---|---|
| update banner でのイベント | **未計測** | 更新保留状態を意図的に作れなかった |
| `/model` でモデルを実際に変更したときの `ConfigChange` | **未計測** | グローバル既定を書き換える操作のため実行しなかった |
| deny ルール由来の拒否での `PermissionDenied` 発火 | **未確認** | TUI での「No」選択では発火しないことのみ確認 |
| `SubagentStop` / `PreCompact` / `PostToolUse` などの payload | **未採取** | 本 Issue のスコープ外 |
| 各イベント・`--settings` の初出バージョン | **特定できず** | 手元に 3 版しかない |
| hooks の実行順序の保証 | **1 回の観測のみ** | 順序に依存する実装をしないこと |
| codex / gemini / copilot / agy / opencode の hooks | **スコープ外** | Epic #1720 の Phase 4 で別途 |

---

## 8. #1724 の手動検証 3 項目の記録先（追記: Issue #1847）

Epic #1720 は #1724（Auto-Yes v2 = `PermissionRequest` hook による構造化裁定）に **手動検証 3 項目**を
残していた。Epic close 時点で記録が揃っていたのは 1 項目＋部分的に 1 項目だけで、
「どこを見れば確認できるのか」が誰にも辿れない状態だった。#1847 で残り 2 項目を
実 TUI カナリア（`scripts/canary/`、#1727）のシナリオとして固定し、3 項目すべての記録先を下表に確定した。

| #1724 の手動検証項目 | 記録先 | 種別 |
|---|---|---|
| サーバ停止時の fail-open（hook の timeout / 接続不能でセッションが止まらない） | 本書 [§5.3.3](#533-timeout--単位は秒--fail-open)（timeout = cancelled でセッションは進む）／[§5.3.4](#534-接続不能時--fail-open)。運用面の引用は `docs/user-guide/agent-event-hooks.md` の §0.6 / §7 | 実測（2026-08-06 / v2.1.223） |
| Auto-Yes 有効時に `PermissionRequest` へ `allow` を返すとダイアログを出さずにツールが走る | canary シナリオ **`permission-hook-allow`**（`scripts/canary/scenarios.ts`）。無条件 allow の受け口での先行観測は `agent-hooks-permission-deny-verification.md` §3（#1739） | 実 TUI カナリア（毎回再実測） |
| Auto-Yes 無効時／契約 `denyPatterns` 該当時に**ダイアログが出て手動で応答できる**（no-decision ＋ `lastSuppression`） | canary シナリオ **`permission-hook-no-decision`**（同上） | 実 TUI カナリア（毎回再実測） |

### 8.1 カナリアが「本体の裁定経路」をどこまで通しているか

`npm run canary` はサーバプロセスではないので、Next.js のルートとミドルウェア認証、および
**データベースを要する 2 箇所だけ**が本物ではない。裁定そのもの（`resolvePermissionRequest`）は
本体の関数をそのまま呼んでいる。

| 本番 | カナリア |
|---|---|
| `buildAgentHookSettings` が `--settings` ファイルを書く | 同じ関数。`port`（受け口の ephemeral ポート）と `directory`（使い捨て HOME 配下）だけ差し替え |
| `claudeAgentEventSource.parsePermissionRequest` / `encodeVerdict` | レジストリ経由で同じ source |
| `resolvePermissionRequest` が裁定する | **同じ関数**（`PermissionDecisionDeps` で下 2 行だけ差し替え） |
| 契約の `autoYes` を active task 行から読む | シナリオが直接与える（task 行を持たないため） |
| `allow` をプロンプト履歴へ書く | 書かない（開発者の DB を汚さないため） |
| `recordAgentEvent` / `reportPermissionRequestPending` / `recordPolicySuppression` | 同じモジュール（すべて in-memory） |
| `buildCurrentOutput` が `structuredEvents` / `autoYes.lastSuppression` を組む | 同じ getter（`getLastAgentEvent` / `resolvePromptWaiting` / `getLastPolicySuppression`）を同じ順で呼ぶ |

差し替えた 2 箇所（契約の読み出しと allow の監査記録）は
`tests/unit/hooks/permission-decision-service.test.ts` が本番実装のまま押さえている。
2 つのシナリオが**空振りしていない**ことは `--mutate-verdict`（受け口が逆の裁定を返す）で証明する。
シナリオ・受け口・期待値の純関数部分は `tests/unit/canary/canary-hook-scenarios.test.ts` が CI で固定する。

### 8.2 2026-08-20 の実測（Claude Code v2.1.236 / v2.1.237）

| 観測 | 結果 |
|---|---|
| `permission-hook-allow` | **緑**。`allow` 応答でダイアログは出ず、`Write` が実行されて probe ファイルが生成された |
| `permission-hook-no-decision` | **緑**。`denyPatterns` 一致 → 空応答 `{}` → 承認ダイアログが出て、`autoYes.lastSuppression` に `deny-pattern` が載った |
| `--mutate-verdict` | **両シナリオとも赤**（＝非空振り） |

**副次的に判明した上流変更（#1847 で対処済み）**: Claude Code **2.1.236 で既定の permission mode が
auto mode になった**。auto mode では Claude が自分で承認判断を行うため、
本カナリアが読むべき承認ダイアログがそもそも描画されない。しかも
使い捨て HOME では **1 本目だけ manual、2 本目以降が auto へ自己移行する**ため、
複数シナリオ実行だけが「起動タイムアウト」で落ちるという分かりにくい形で表面化した
（ready フッタ `? for shortcuts` が manual mode にしか無いため）。
`settings.json` に `permissions.defaultMode` を書くと今度は
「Make auto mode your default permission mode?」の選択画面が composer の前に出るので、
カナリアは **`--permission-mode manual` をコマンドラインで固定**している
（`CANARY_PERMISSION_MODE`、`scripts/canary/session.ts`）。

---

## 9. 関連

- Epic: [#1720](https://github.com/Kewton/CommandMate/issues/1720)
- 既存の受け口: `src/app/api/hooks/agent-event/route.ts`（常に 202 を返す＝ [§5.3.6](#536-async-は-command-hook-限定) の要件と整合）
- 既存の中継スクリプト: `scripts/hooks/cmate-agent-event.sh`（[§5.3.2](#532-sessionstart-は-http-非対応ドキュメント未記載d1) より `SessionStart` ではこれが必須）
- 手順書: `docs/user-guide/agent-event-hooks.md`
- 公式: https://code.claude.com/docs/en/hooks
