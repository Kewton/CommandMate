# codex 0.155.1 のスレッド名つきステータスバー、実測（Issue #2818）

codex 0.154.0 以降は、最初のターンでスレッドに名前が付くとステータスバーのパスの後ろに `· <スレッド名>` を描く。
`CODEX_STATUS_BAR_PATTERN` はパスが行末にあることを要求するので、この形のバーでは codex の検出器が境界を見つけられず、
分岐 D（末尾 15 行の thinking 判定）に落ちて、**アイドルでも末尾に残った `• Ran …` を拾って `running`** と読んでいた
（#2808 の `codex-dialogs-0155/idle-after-declined-approval.txt`）。

このディレクトリは、#2818 の修正（スレッド名つきのバーも境界として受け付ける `CODEX_TRAILED_STATUS_BAR_PATTERN`）を
**実測の画面で**確かめるために採ったものである。Issue が求めた 2 画面:

1. **スレッド名つきのバーで running している画面**（陽性対照。fixture の木に 1 枚も無かった）
2. そのコマンドが終わり、短い返答でターンを閉じた直後の **idle 画面（末尾に `• Ran` が残る形）**

**raw のまま置いている。ANSI を剥がさないこと**（`tests/fixtures/codex-dialogs-0155/README.md` と同じ理由。
入力欄・transcript のエコー・ダイアログの選択行を分けるのは SGR 属性だけ）。読むテストは
`tests/unit/lib/detection/codex-thread-title-bar-2818.test.ts`。

## Provenance — ここに fixture を足す前に読むこと

| | |
|---|---|
| build | codex-cli **0.155.1**（`codex --version`。3 枚ともバナー `OpenAI Codex (v0.155.1)` を持つ） |
| model | `gpt-5.6-terra`（`-c model_reasoning_effort=low` で起動したのでバーは `gpt-5.6-terra low`） |
| 採取日時 | **2026-09-21 18:55〜18:58 JST**（起動 18:55:07、1 ターン目の送信 18:55:25、2 ターン目の送信 18:57:06 頃、`running-in-command` 18:57:25、`running-after-command` 18:57:45、`idle-after-command` 18:58:11 頃） |
| tmux | 私設ソケット `tmux -L codex-bar-probe -f /dev/null`（tmux 3.5a）、`new-session -d -s probe -x 200 -y 1000`。ペイン寸法は `display-message '#{pane_width}x#{pane_height}'` で **200x1000** を実測。既定の tmux サーバと本人の `mcbd-*` セッションには触れていない。終わったら `tmux -L codex-bar-probe kill-server` で止めた |
| cwd | `os.tmpdir()` 配下の使い捨て git リポジトリ（`mktemp -d …/codexbar-probe-XXXXXX` の下の `repo/`、`README.md` 1 ファイルを 1 コミット） |
| 採取コマンド | `capture-pane -p -e -t '=probe:'` の出力をそのままファイルへリダイレクト。可視ペイン 1000 行＋末尾改行なので `split('\n')` は **1001** 要素 |
| CODEX_HOME | **本人の `~/.codex`**（#2808 と同じ。資格情報を使い捨て HOME に複製する方式は取っていない）。下の起動オプションで書き込みと外部送信を止めた |

### 起動

```text
env -u TMUX -u TMUX_PANE -u CM_DB_PATH -u CM_ROOT_DIR -u CM_BIND \
    -u CM_VAPID_PRIVATE_KEY -u CM_VAPID_PUBLIC_KEY -u CM_VAPID_SUBJECT \
    CM_PORT=9 CM_HOOK_URL=http://127.0.0.1:9/hook CM_PERMISSION_HOOK_URL=http://127.0.0.1:9/permission \
  codex --disable hooks -c 'notify=[]' -c history.persistence=none \
        -c model_reasoning_effort=low -c mcp_servers.node_repl.enabled=false \
        -a on-request -s read-only -c projects.<repo の実パス>.trust_level=trusted
```

- `--disable hooks` と `CM_*` の付け替え: 本人の `~/.codex/hooks.json` は CommandMate の hook なので、本番サーバへ何も
  届かないようにした。上書きはどれも `-c` / `--disable`（メモリ上のみ。`config.toml` には書かれない）
- `/model` など設定を書き換える画面は開いていない。承認ダイアログも出していない（`sleep` は read-only sandbox で通る）

### 操作

1. `Reply with the single word OK. Do not run any commands.` を送った。`send-keys -l` の直後の `Enter` では送信されず
   入力欄に残ったので、`Enter` をもう 1 回送った（2 ターン目は文字列と `Enter` の間を 1.5 秒空けて 1 回で通った）。
   codex は `• OK` と答え、バーの末尾に `· renaming... ⠼` を描いてから **`· Reply OK`** に置き換えた — これがスレッド名
2. `` Run the shell command `sleep 30` in the current directory, then reply with the single word finished. `` を送り、
   ターンが閉じるまで 1.5 秒おきに採取した（25 枚）。そのうち 2 枚と、ターンが閉じた後の 1 枚を残した

### 採取前後で確かめたこと

| | 結果 |
|---|---|
| `~/.codex/config.toml` | sha256 が前後で一致（`4714a01b…`） |
| `~/.codex/hooks.json` | 一致（`dca409d5…`） |
| `~/.codex/history.jsonl` | 行数が前後で同じ（9431 行）。この session の行は無い |
| `~/.codex/sessions/2026/09/21/` | **rollout が 1 件増えた**（`rollout-2026-09-21T18-55-08-01a0c364-….jsonl`、cwd がこの probe の repo）。消していない |
| `~/.codex/` 直下 | **SQLite の `-shm` / `-wal` が 8 個増えた**（`goals_1` / `memories_1` / `state_5` / `thread_history_1` の各 `.sqlite-shm` と `.sqlite-wal`、作成 18:55〜18:57）。採取後どのプロセスも開いていない — codex を終了操作なしに `kill-server` で止めたので、チェックポイントされずに残ったと見ている。消していない（WAL を消すと未反映の書き込みが失われうる。次に codex がその DB を開けば取り込まれる）。**次に採る人は、`kill-server` の前に codex を Ctrl+C で終了させること** |
| プロセス | 私設サーバ停止後、この probe の cwd を持つプロセスは 0 |
| `$HOME` / `~/.commandmate` 直下 | エントリ一覧が前後で一致 |
| 既定の tmux サーバ | セッション一覧が前後で一致 |

## 編集（匿名化）

**置換は 2 つだけ、どちらも同じ文字数**（桁は 1 つも動かない）。ANSI・行数・空行の位置は元とバイト一致（3 枚とも
ファイルサイズが元と同じ）。

1. macOS の利用者別一時ディレクトリの名前 `07/<30 文字>` → `xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`（バー行。各 1 か所）
2. `mktemp` の接尾辞（6 文字）→ `XXXXXX`（バナーの `directory:` 行とバー行。各 2 か所）

元のフレームと匿名化後のフレームに同じ読み取り（`detectSessionStatus` の status / reason / hasActivePrompt / evidence、
ANSI を剥がした場合の status、`readCodexGlyphRowKind` の全 `›` 行、`findCodexBottomGlyphRow`、`readCodexDialogFrame`、
`extractComposerText`、`findCodexChromeStart`、`extractModelInfo`）をかけ、3 枚とも出力が**完全一致**することを確かめた。
元のフレームはコミットしていない（リポジトリ外の一時領域にだけ置いた）。

## 3 枚

行番号は 0-based（`split('\n')` の添字）。

| ファイル | 画面 | 主な行 | 修正前 | 修正後 |
|---|---|---|---|---|
| `running-in-command.txt` | `sleep 30` の実行中（16 秒目） | 23: `• Working (16s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close`、26: 入力欄、28: バー `… · Reply OK` | `running` / `thinking_indicator` | `running` / `thinking_indicator` |
| `running-after-command.txt` | コマンドが終わり、codex がまだ作業中（36 秒目） | 23: `• Ran sleep 30`、26: `• Working (36s • esc to interrupt)`、29: 入力欄、31: バー | `running` / `thinking_indicator` | `running` / `thinking_indicator` |
| `idle-after-command.txt` | `• finished` と答えてターンが閉じた後 | 23: `• Ran sleep 30`、26: `• finished`、28: `done 6:57 PM`、31: 入力欄、33: バー | **`running` / `thinking_indicator`**（誤読） | **`ready` / `input_prompt`** |

ANSI を剥がした場合も 3 枚とも同じ判定。入力欄のグリフは 3 枚とも色なしの `ESC[1m›`（#2808 と同じく、#2798 の
オレンジのグリフは再現しなかった）。

- 実行中の画面では、実行中のコマンドは `• Running …` の行としては描かれず、`• Working (…)` の行に
  `1 background terminal running` が付くだけだった。コマンドの記録（`• Ran sleep 30`）は終わってから描かれる
- `idle-after-command.txt` は Issue が「起きうる典型」と書いた形そのもの（コマンドを 1 本実行して短く答えただけのターン）で、
  #2808 の「承認を断った後」だけでなく、**普通に完了したターンでも誤読が起きていた**
- 2 枚の running 画面の `• Working` の行は、検出用に空行を詰めると末尾から 5 行目に入るので、共通の 5 行 thinking 判定が
  先に `running` と答える。修正後の codex 分岐（2.7）単独でも `running` と読めることはテストで別に固定した

## この fixture が扱わないもの

- **Plan mode のバッジ**（`… · <path>      Plan mode (shift+tab to cycle)`）つきの running 画面は採っていない
  （Plan mode のアイドル画面は `tests/fixtures/agent-mode-2592/` にある）
- **steer（実行中に次のメッセージを送った状態）** のスレッド名つき画面は採っていない。スレッド名の無い形
  （`codex-live-2310/steer-queued-running.txt`）は分岐 2.7 で `ready` と読まれる既知の穴で、修正後はスレッド名つきでも同じになる
  （修正前は境界が見つからず分岐 D が `• Working` を拾って `running` だった）。詳細はテストの冒頭
- 承認ダイアログ・`/model` などのダイアログは #2808 の `codex-dialogs-0155/` を参照
