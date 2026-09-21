# tui-frame-footer-2776 — フッタ行の位置と形の実測（Issue 2776）

`tests/unit/lib/detection/tui-frame-footer-2776.test.ts` の入力。
`normalizeTuiFrameForDetection`（`src/lib/detection/tui-detection-frame.ts`）が
「フッタ」と判定する行が、本物のフッタと会話本文の引用とでどう違うかを測った。
判断は [`docs/design/tui-frame-footer-scan-2776.md`](../../../docs/design/tui-frame-footer-scan-2776.md)。

## Provenance

**全ファイルが実キャプチャ由来**（合成フレームは無い）。2026-09-21、macOS、tmux 3.5a。

- 専用ソケット `tmux -L footer-probe` の上に 200x1000 のセッションを作り
  （`new-session -x 200 -y 1000` → セッション単位の `window-size manual` → `resize-window`）、
  `os.tmpdir()` 配下の使い捨て git リポジトリ（`a.ts` と `README.md` の 2 ファイル）で各 CLI を起動した。
  本人の既定 tmux サーバと `mcbd-*` セッションには触れていない。採取後に `kill-server` で片付け、
  使い捨てディレクトリも削除した
- 取り方は本番の `capturePane` と同じ `tmux capture-pane -p -e -S -1000 -E -`（ANSI 付きのまま）
- claude は `claude --permission-mode default`（確認ダイアログを出すため。`/model` などの設定系スラッシュコマンドは送っていない）。
  codex は使い捨てディレクトリの trust を `-c 'projects={"<dir>"={trust_level="trusted"}}'` で
  **メモリ上だけ**与えて起動した（`~/.codex/config.toml` は採取の前後で同一 sha256）。
  command-code は `cmd --trust`、起動直後の TASTE 画面は Esc（skip）で閉じた

### 追加採取（Issue 2811）

`claude-2.1.278-*-task-panel.txt` の 2 本。2776 で未測だった task panel を実測で置き換えた。

| 項目 | 値 |
|---|---|
| 日付 | 2026-09-21（15:11–15:14 JST）、macOS、tmux 3.5a |
| ペイン | 専用ソケット `tmux -L footer-probe-2`（`-f /dev/null`）のセッション `probe-claude`、200x1000（上と同じ 3 手順）。本人の既定 tmux サーバと `mcbd-*` セッションには触れていない |
| CLI | claude-cli 2.1.278、Haiku 4.5。`CLAUDE_CODE_ENABLE_TODO_TOOLS=1 claude --permission-mode default --model haiku` をペインのコマンドとして直接起動（シェル行は無い） |
| private HOME | **なし**。private HOME でも private `CLAUDE_CONFIG_DIR` でも `Not logged in · Please run /login` で起動できなかったので、本物の `~/.claude` で動かした |
| 作業ディレクトリ | `mktemp -d` の使い捨て git リポジトリ（`a.ts` と `README.md`）。採取後に削除 |
| 取り方 | 上と同じ `capture-pane -p -e -S -1000 -E -` |

2.1.278 は task-tracking ツール（TaskCreate / TodoWrite 系）を一部のモデル（Claude 3.x・Opus 4.0–4.7・Sonnet 4.0–4.6・Haiku 4.5）にしか出さず、
それ以外は `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` が要る（2.1.278 に同梱の changelog）。今回は両方を満たした。

手順: trust ダイアログ（既定は `❯ No, exit`）を Down＋Enter で承諾 → 依頼 1「TaskCreate で 3 タスクを作り、1 つ目を in_progress にし、
Bash で `touch probe.txt`」→ Bash の確認ダイアログで採取 → Enter で承認 → 依頼 2「AskUserQuestion で 1 問だけ」→ picker で採取 →
Esc → `/exit`。セッションが 0 本になった時点で私設サーバも終わった。

## 匿名化

書き換えたのは次の 4 つだけで、フッタ判定に関わる行は 1 文字も変えていない。

| 元 | 置き換え | 備考 |
|---|---|---|
| 使い捨てディレクトリの `…/folders/<2 文字>/<30 文字>/T/tmp.<10 文字>` | `…/folders/xx/xxx…x/T/tmp.XXXXXXXXXX` | **同じ桁数**（箱罫線・右寄せがずれない） |
| シェルプロンプトの `<user>@<host>` | `user@host` | codex / command-code の最上部のシェル行だけ |
| `/Users/<user>` | `/Users/user` | codex の最上部、pyenv の警告行だけ |

## ファイル

| ファイル | 採取表の # | CLI | 画面 |
|---|---|---|---|
| `claude-2.1.278-bash-approval.txt` | 1 | claude-cli 2.1.278 | Bash の確認ダイアログ。フッタ ` Esc to cancel · Tab to amend` は L25 |
| `claude-2.1.278-edit-approval.txt` | 1 | claude-cli 2.1.278 | Edit の確認ダイアログ（差分つき）。フッタは L58 |
| `claude-2.1.278-askuserquestion-picker.txt` | 2 | claude-cli 2.1.278 | AskUserQuestion の picker。フッタ `Enter to select · ↑/↓ to navigate · Esc to cancel` は L30 |
| `claude-2.1.278-idle-quoted-footers.txt` | 5 | claude-cli 2.1.278 | 依頼文と返答が両フッタ文言を引用したあとの idle。引用が当たる行は L58 / L61 / L65 / L67 |
| `claude-2.1.278-picker-below-quoted-footers.txt` | 5 | claude-cli 2.1.278 | 同じセッションで引用の下に本物の picker。本物のフッタは L92 |
| `claude-2.1.278-approval-below-quoted-footers.txt` | 5 | claude-cli 2.1.278 | 同じセッションで引用の下に本物の Bash 確認。本物のフッタは L102 |
| `codex-0.155.1-idle-after-turn.txt` | 4 | codex-cli 0.155.1 | 1 ターン終えた idle（通常画面） |
| `codex-0.155.1-idle-quoted-footers.txt` | 5 | codex-cli 0.155.1 | 2774 の再現。依頼文の中で両フッタ文言を引用し（L42 / L43）、返答「了解」のあと idle |
| `command-code-1.58.0-idle-after-turn.txt` | 4 | command-code 1.58.0 | 1 ターン終えた idle（通常画面） |
| `command-code-1.58.0-idle-quoted-footers.txt` | 5 | command-code 1.58.0 | codex と同じ依頼文（引用は L20 / L21）のあと idle |
| `claude-2.1.278-bash-approval-task-panel.txt` | 3 | claude-cli 2.1.278 | Issue 2811。Bash の確認ダイアログ。フッタ ` Esc to cancel · Tab to amend` は L24、その下のペイン最下部 L997–L1000 に task panel `3 tasks (0 done, 1 in progress, 2 open)` と 3 行 |
| `claude-2.1.278-askuserquestion-task-panel.txt` | 3 | claude-cli 2.1.278 | Issue 2811。同じセッションで AskUserQuestion の picker。フッタ `Enter to select · ↑/↓ to navigate · Esc to cancel` は L32（行頭から）、task panel は同じ L997–L1000 |

`claude-2.1.278-*-quoted-footers.txt` の 3 本は、Edit を 1 回承認したあとの採取なので、
画面右側（列 111–200、行 2–10）に session-diff パネル `1 file changed +1 -1 ✕` が描かれ、
本文は約 110 桁で折り返されている。空行も背景色つきの SGR を含むので、
`trim()` で空行と見なすには先に `stripAnsi` が要る。

## 採れなかったもの（未測）

- **claude の task panel（採取表 #3）**: 2776 では 2.1.278 のセッションで TaskCreate / TodoWrite が
  使えず（claude 自身が「どちらも利用できない」と返答）、旧版の実キャプチャ
  （`tests/unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt` = 2.1.240、
  `tests/fixtures/canary/askuserquestion-task-panel.raw.txt` = 2.1.223）で代えていた。
  **Issue 2811 で実測に置き換えた**（上表の `claude-2.1.278-*-task-panel.txt`）。旧版の 2 本もテストに残している
- **antigravity の通常画面（採取表 #4）**: agy 1.2.7 は使い捨てディレクトリで trust ダイアログ
  （`Yes, I trust this folder` / `No, exit`）を出す。承諾すれば既存の `~/.gemini/trustedFolders.json`
  に行が足され、同ファイルには過去の probe ディレクトリの `DO_NOT_TRUST` 行もあるので拒否も記録されうる。
  既存ファイルを書き換えないため、どちらも選ばず Ctrl+C 2 回で抜け（同ファイルの sha256 は前後で同一）、採取していない。
  `tests/fixtures/` 全体の走査に含まれる agy 1.1.18–1.2.1 の実キャプチャ 38 ファイルで代える。
  Issue 2811 では private HOME（`HOME="$(mktemp -d)"`）で起動したが、`Authentication required. Please visit the URL to log in:`
  （Google OAuth）で止まり通常画面に進めなかった（`agy -p` で確認）。資格情報は本物の `~/.gemini` 側にあるが、
  private HOME へは写していない。**今回も未測**で、代わりは同じ 38 ファイルのまま
