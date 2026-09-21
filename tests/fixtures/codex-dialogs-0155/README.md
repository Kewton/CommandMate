# codex 0.155.1 のダイアログ、実測（Issue #2808）

#2798 は `readCodexGlyphRowKind()` の規則を「**ラベルがグリフと同じ色で描かれている（1 スパン）**ときだけ
色を選択肢の根拠にする」「dim ラベル（プレースホルダ）は色より先に composer」に改めたが、0.155.1 で採ったのは
アイドルの入力欄 1 枚だけだった（`tests/fixtures/codex-idle-composer-0155/`）。このディレクトリは、同じ 0.155.1 で
**選択肢を描く画面**を採り直したものである。問いは 1 つ — 0.155.1 が選択行を「着色グリフ → リセット → 装飾なしラベル」
に変えていて、#2798 の規則がそれを入力欄と読んでいないか。

**答え: 変えていない。** 5 画面とも選択行はグリフとラベルが同じ SGR の 1 スパンで、0.146.0〜0.153.2 の実測と
バイト単位で同じ形だった。5 画面とも `waiting` に読める。ただし表の外で 1 枚、アイドルが `running` に読まれる
フレームが採れた（下の「表の外の所見」）。

**raw のまま置いている。ANSI を剥がさないこと。** 判定の根拠は SGR 属性だけで、剥がしたフレームでは入力欄・
transcript のエコー・ダイアログの選択行が同じバイトになる（`tests/fixtures/codex-live-2310/README.md` と同じ理由）。
読むテストは `tests/unit/lib/detection/codex-dialogs-0155-2808.test.ts`。

## Provenance — ここに fixture を足す前に読むこと

| | |
|---|---|
| build | codex-cli **0.155.1**（`codex --version`。trust 以外の 7 枚はバナー `OpenAI Codex (v0.155.1)` を持つ。trust 画面はバナーより前に出るので版を持たない） |
| model | `gpt-5.6-terra`（`-c model_reasoning_effort=low` で起動したのでステータスバーは `gpt-5.6-terra low`） |
| 採取日時 | **2026-09-21 15:10〜15:12 JST**（trust 15:10:39、`/model` 15:11:43、`/experimental` 15:11:58、`/keymap` 15:12:13、承認 15:12:36、承認を断った後 15:12:47） |
| tmux | 私設ソケット `tmux -L codex0155-probe -f /dev/null`（tmux 3.5a）、`new-session -d -s probe -x 200 -y 1000`。ペイン寸法は `display-message '#{pane_width}x#{pane_height}'` で **200x1000** を実測。既定の tmux サーバと本人の `mcbd-*` セッションには触れていない。終わったら私設サーバを `-L codex0155-probe` 付きで止めた |
| cwd | `os.tmpdir()` 配下の使い捨て git リポジトリ（`mktemp -d …/codex0155-probe-XXXXXX` の下の `repo/`、`README.md` 1 ファイルを 1 コミット） |
| 採取コマンド | `capture-pane -p -e -t '=probe:'`。可視ペイン 1000 行＋末尾改行なので `split('\n')` は **1001** 要素（`codex-live-2310/` と同じ形） |
| CODEX_HOME | **本人の `~/.codex`**（#2310 / #2400 の「使い捨て HOME に資格情報を複製する」方式は取っていない）。代わりに下の起動オプションで書き込みと外部送信を止めた |

### 起動

```text
env -u CM_DB_PATH -u CM_ROOT_DIR -u CM_BIND -u CM_VAPID_* \
    CM_PORT=9 CM_HOOK_URL=http://127.0.0.1:9/… CM_PERMISSION_HOOK_URL=http://127.0.0.1:9/… \
  codex --disable hooks -c 'notify=[]' -c history.persistence=none \
        -c model_reasoning_effort=low -c mcp_servers.node_repl.enabled=false
```

- `--disable hooks` と `CM_*` の付け替え: 本人の `~/.codex/hooks.json` は CommandMate の hook（`PermissionRequest` は
  既定で `127.0.0.1:3000` へ POST）なので、本番サーバへ何も届かないようにした。上書きはどれも `-c` / `--disable`（メモリ上のみ）
- **trust 画面（#5）** は上の行そのままで起動して出し、採取後 **Ctrl+C** で抜けた（選択肢は確定していない）
- **#1〜#4 と追加の 3 枚**は上の行に `-a on-request -s read-only -c projects.<repo の実パス>.trust_level=trusted` を足した。
  0.155.1 では `-a` / `-s` だけでは trust 画面が消えなかったので、trust は `-c` の上書き（`config.toml` には書かれない）で通した
- `/model` `/experimental` `/keymap` は `C-u` → コマンド名 → Enter で開き、採取後 **Esc** で閉じた（Enter で確定していない）
- 承認ダイアログは「`touch probe.txt` を実行して」と頼んで出した（read-only sandbox なので codex が昇格を求める）。
  採取後 **Esc**（3. No）で断った。`probe.txt` は作られていない

### 採取前後で確かめたこと

| | 結果 |
|---|---|
| `~/.codex/config.toml` | sha256 が前後で一致（`4714a01b…`） |
| `~/.codex/hooks.json` | 一致 |
| `~/.codex/history.jsonl` | この session の行は無い（期間中に 1 行増えたが、`session_id` は並行して動いていた別の codex セッションのもの） |
| `~/.codex/sessions/2026/09/21/` | **rollout が 1 件増えた**（cwd がこの probe の repo のもの。承認ダイアログのために 1 ターン送ったため）。消していない |
| プロセス | 私設サーバ停止後、この probe の cwd を持つプロセスは 0 |
| `$HOME` / `~/.commandmate` 直下 | エントリ一覧が前後で一致 |

## 編集（匿名化）

**置換は 2 つだけ、どちらも同じ文字数**（桁は 1 つも動かない）。ANSI・行数・空行の位置は元とバイト一致。

1. macOS の利用者別一時ディレクトリの名前 `07/<30 文字>` → `xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
   （trust の `> You are in …` 行と、ステータスバーを持つ 2 枚のバー行。計 3 か所）
2. `mktemp` の接尾辞 `GDAoWO` → `XXXXXX`（バナーの `directory:` 行とバー行。計 10 か所）

元のフレームと匿名化後のフレームに同じ読み取り（`detectSessionStatus` の status / reason / hasActivePrompt / 選択肢、
`readCodexGlyphRowKind` の全 `›` 行、`findCodexBottomGlyphRow`、`readCodexDialogFrame`、`extractComposerText`、
`findCodexChromeStart`、ANSI を剥がした場合の status）をかけ、8 枚とも出力が**完全一致**することを確かめた。
元のフレームはコミットしていない（リポジトリ外の一時領域にだけ置いた）。

## Issue の表の 5 画面

選択行（`cat -v`、`^[` が ESC）。**グリフの直後に属性の変化が無い**のが 5 行すべてに共通する。

| # | ファイル | 選択行（0-based 行番号） | 0.155.1 より前の同じ画面 |
|---|---|---|---|
| 1 | `dialog-approval-run-command.txt` | 26: `^[[1m^[[38;5;6m› 1. Yes, proceed (y)^[[0m` | 0.146.0 `codex-live-1628/approval-run-command.txt` と同一 |
| 2 | `dialog-model-picker.txt` | 15: `^[[1m^[[38;5;6m› 3. gpt-5.6-terra (current)  Balanced agentic coding model for everyday work.^[[0m` | 0.148.0 / 0.151.0 と同じ形（行内の文言はモデル一覧の差） |
| 3 | `dialog-experimental-toggles.txt` | 13: `^[[1m^[[38;5;6m› [ ] Network proxy                Apply network proxy …^[[0m` | 0.153.2 `codex-live-2310/` と同一 |
| 4 | `dialog-keymap-editor.txt` | 17: `^[[1m^[[38;5;6m› Global       - Open Agents                unbound^[[0m` | 0.153.2 `codex-live-2310/` と同一 |
| 5 | `dialog-trust-directory.txt` | 5: `^[[38;5;6m› 1. Yes, continue^[[39m` | 0.153.2 `codex-live-2310/` と同一（太字でも dim でもなく、グリフの色がラベルまで続く） |

非選択行はどの画面もグリフを持たない（描画上は 2 桁の空白で始まる）。ラベル本体は装飾なしで、説明文・キーヒント・
`/keymap` のグループ名が dim（例: `  2. Yes, and don't ask again … (^[[2mp^[[0m)`、`  4. gpt-5.6-luna             ^[[2mFast and …^[[0m`）。

判定（#2798 を含む 62db1a2f の上で読んだもの）:

| # | `readCodexGlyphRowKind`（全 `›` 行） | `readCodexDialogFrame` | `detectSessionStatus(…, 'codex')` | ANSI を剥がした場合 |
|---|---|---|---|---|
| 1 | 10 `transcript-echo` / 26 `option` | `glyph`、選択肢 3、フッタ認識 | `waiting` / `prompt_detected` | `waiting` / `prompt_detected` |
| 2 | 15 `option` | `glyph`、選択肢 5、フッタ認識 | `waiting` / `codex_selection_list` | `waiting` / `codex_selection_list` |
| 3 | 13 `option` | `glyph`、フッタ認識 | `waiting` / `codex_selection_list` | `ready`（#2310 が固定した限界と同じ） |
| 4 | 17 `option` | `glyph`、フッタ認識 | `waiting` / `codex_selection_list` | `ready`（同上） |
| 5 | 5 `option` | `glyph`、選択肢 2、フッタ認識 | `waiting` / `prompt_detected` | `waiting` / `prompt_detected` |

0.153.2 からの差分（判定には効いていない）:

- `/experimental` のフッタが `Press space to select or enter to save`（`for next conversation` が消えた）。
  `CODEX_DIALOG_FOOTER_PATTERN` の `press … to …` で引き続き認識される
- 承認ダイアログに `Environment: local` の行が増えた

## 追加の 3 枚（アイドル側）

| ファイル | 画面 | `›` 行 | 判定 |
|---|---|---|---|
| `idle-composer.txt` | 起動直後のアイドル | 10: `^[[1m›^[[0m ^[[2mAsk Codex to do anything^[[0m` | `ready` / `input_prompt` |
| `composer-typed-slash.txt` | 入力欄に `/model` を打った直後（補完ポップアップ表示中） | 10: `^[[1m›^[[0m /model` | `ready` / `input_prompt` |
| `idle-after-declined-approval.txt` | 承認を Esc で断った後のアイドル | 10: エコー、23: `^[[1m›^[[0m ^[[2mAsk Codex to do anything^[[0m` | **`running` / `thinking_indicator`**（下記） |

**この probe では入力欄のグリフはオレンジにならなかった**（3 枚とも色なしの `ESC[1m›`）。#2798 が本番サーバから
採ったオレンジのグリフ（`ESC[38;2;255;178;66m`）がどの条件で出るのかは特定していない。

## 表の外の所見 — アイドルが `running` に読まれる（#2818 で解消）

**#2818 で解消した**: `findCodexFooterBoundary`（`src/lib/detection/tools/codex/detect.ts`）がスレッド名つきのバーも境界と認めるようになり、`idle-after-declined-approval.txt` は `ready` と読まれる（`codex-dialogs-0155-2808.test.ts` の期待値は反転済み、`CODEX_VERIFIED_AGAINST` も 0.155.1 へ進めた）。以下は解消前の記録。

`idle-after-declined-approval.txt` はターンが中断されて入力待ちの画面だが、`detectSessionStatus` は
**`running` / `thinking_indicator`** を返す。#2798 の行規則は正しく読めている（23 行目は `composer`、
`readCodexDialogFrame` は `null`）ので、誤りはその外にある:

1. ステータスバー（25 行目）が `gpt-5.6-terra low · <repo のパス> · Run touch probe.txt` と、パスの**後ろに
   スレッド名**を持つ。`CODEX_STATUS_BAR_PATTERN`（`src/lib/detection/cli-patterns.ts`）はパスが行末にあることを
   要求するので一致せず、フッタ境界が `-1` になる（スレッド名つきのバーは 0.154.0 の実測に既に在る —
   `tests/fixtures/agent-mode-2592/codex-default-thread-title.txt`）
2. 境界が無いので `tools/codex/detect.ts` の分岐 D（パディングを除いた末尾 15 行の thinking 判定）に落ち、断った承認の後にも
   描かれる `• Ran touch probe.txt`（17 行目）を `CODEX_THINKING_PATTERN` の `Ran` が拾う

バーからスレッド名を外すだけで `ready` / `input_prompt` に戻る（テストで固定した）。Issue の「規則を推測で変えない」
に従い直していない。この 1 枚が正しく読めないので、`CODEX_VERIFIED_AGAINST` は 0.155.1 へ上げていない。

## この fixture が扱わないもの

- **オレンジのグリフの入力欄**（#2798 の形）は再現できなかった。その形の入力欄の実測は #2798 の 1 枚のまま
- `/permissions`、hooks review、アップデートダイアログ、Browser use の承認、`apply_patch` の承認、`/model` の
  2 段目（effort 選択）は採っていない
- 完了したターンの後のアイドル（中断ではなく最後まで走ったもの）は採っていない
