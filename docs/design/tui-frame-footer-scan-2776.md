# フッタ判定の実測と条件の選定（Issue 2776）

測定日: 2026-09-21 / 対象: `src/lib/detection/tui-detection-frame.ts` の `normalizeTuiFrameForDetection`

このドキュメントは**実測値の記録**と、それに基づく判定条件の選定理由である。
採取ファイルの出どころは [`tests/fixtures/tui-frame-footer-2776/README.md`](../../tests/fixtures/tui-frame-footer-2776/README.md)。
結論を固定するテストは `tests/unit/lib/detection/tui-frame-footer-2776.test.ts`。

---

## 結論

| 案 | 採否 | 一言で |
|---|---|---|
| (a) 行アンカー — **行頭側** | **採る** | 実キャプチャの本物のフッタ 35 行（claude 19・command-code 16）は、すべて前が空白だけ（生キャプチャでは空白＋SGR）。実キャプチャの引用 17 行は、すべて前に可視文字を持つ |
| (a) 行アンカー — 行末側（`\s*$`） | 採らない | 本物のフッタ 35 行中 30 行が、一致部分の後ろにキーヒントの続き（` · Esc to cancel` など）を持つ |
| (b) 探索範囲を画面下部に限る | 採らない | 生の行番号では本物のフッタは**上端側**（L25–L108 / 1001）。非空行で数えると本物（下に 0–7 行）と引用（下に 4–31 行）が重なる |
| (c) 捨てる量に上限 | 採らない | 本物のフッタが捨てる生の行数（893–976）は 2774 の誤爆（963）と同じ大きさ。非空行では本物（0–7）と引用（2774 fixture で 5）が重なる |

実装は 2 つのパターンの先頭に `^(?:\s|\x1b\[[0-9;]*m)*` を足しただけ（`CLAUDE_LOWER_INTERACTIVE_ANCHOR` は変えていない）。

---

## 採取環境

| 項目 | 値 |
|---|---|
| tmux | 専用ソケット `tmux -L footer-probe`（3.5a）。セッション名は `probe-claude` / `probe-codex` / `probe-cc` / `probe-agy`。本人の既定サーバと `mcbd-*` には触れていない。採取後に `tmux -L footer-probe kill-server`、残ったソケットファイル（自分が作ったもの）を削除 |
| 画面 | 200x1000（`new-session -x 200 -y 1000` → セッション単位の `window-size manual` → `resize-window`。本番の `reconcileSessionGeometry` と同じ手順） |
| 取り方 | `capture-pane -p -e -S -1000 -E -`（本番の `capturePane` と同じ。ANSI 付き） |
| 作業ディレクトリ | `mktemp -d`（`os.tmpdir()` 配下）に作った使い捨て git リポジトリ。採取後に削除 |
| CLI | claude-cli 2.1.278（`--permission-mode default`）/ codex-cli 0.155.1 / command-code 1.58.0 / agy 1.2.7 |

本番サーバへの影響: codex のグローバル hook（`~/.codex/hooks.json`）は採取中も稼働中の CommandMate サーバへ
`session_start` / `user_prompt_submit` / `stop` を送ったが、サーバは `agent-event-unresolved-target`
（使い捨てディレクトリは登録 worktree ではない）として捨てており、どのセッションの状態も変えていない。

---

## 採取ごとの表

列の意味:

- **行番号 / 全行数**: `stripAnsi` 後に `split('\n')` した 1 始まりの行番号と要素数（末尾改行の空要素を含む）
- **行全体か**: 一致した文字列の前と後ろに何があるか。「前: 空白」は空白だけ（生キャプチャでは空白＋SGR `\x1b[38;5;246m`）
- **捨てられる行数**: 判定されたフッタで `normalizeTuiFrameForDetection` が捨てる行数（括弧内は非空行）。
  「下」はフッタより下を捨てる分岐、「上」は下に新しい対話（`CLAUDE_LOWER_INTERACTIVE_ANCHOR`）があってフッタ以上を捨てる分岐

### 本物のフッタ（採取表 #1・#2・#5 の本物側）

| # | ファイル | CLI | 行番号 / 全行数 | 行全体か | 捨てられる行数 |
|---|---|---|---|---|---|
| 1 | `tests/fixtures/tui-frame-footer-2776/claude-2.1.278-bash-approval.txt` | claude 2.1.278 | L25 / 1001 | 前: 空白、後: なし | 下 976（非空 0） |
| 1 | `tests/fixtures/tui-frame-footer-2776/claude-2.1.278-edit-approval.txt` | claude 2.1.278 | L58 / 1001 | 前: 空白、後: なし | 下 943（非空 0） |
| 2 | `tests/fixtures/tui-frame-footer-2776/claude-2.1.278-askuserquestion-picker.txt` | claude 2.1.278 | L30 / 1001 | 前: 空白、後: ` · Esc to cancel` | 下 971（非空 0） |
| 5 | `tests/fixtures/tui-frame-footer-2776/claude-2.1.278-picker-below-quoted-footers.txt` | claude 2.1.278 | L92 / 1001 | 前: 空白、後: ` · Esc to cancel` | 下 909（非空 0） |
| 5 | `tests/fixtures/tui-frame-footer-2776/claude-2.1.278-approval-below-quoted-footers.txt` | claude 2.1.278 | L102 / 1001 | 前: 空白、後: なし | 下 899（非空 0） |
| 1 | `tests/fixtures/canary/permission-dialog.raw.txt`（既存・実キャプチャ） | claude 2.1.223 | L34 / 1001 | 前: 空白、後: なし | 下 967（非空 0） |
| 2 | `tests/fixtures/claude-live-2486/tabs-q1.txt`（既存・実キャプチャ） | claude 2.1.268 | L28 / 1001 | 前: 空白、後: ` · Esc to cancel` | 下 973（非空 0） |
| 2 | `tests/fixtures/claude-live-2486/preview-q1.txt`（既存・実キャプチャ） | claude 2.1.268 | L43 / 1001 | 前: 空白、後: ` · n to add notes · Esc to cancel` | 下 958（非空 0） |
| 3 | `tests/fixtures/canary/askuserquestion-task-panel.raw.txt`（既存・実キャプチャ） | claude 2.1.223 | L38 / 1001 | 前: 空白、後: ` · Esc to cancel` | 下 963（非空 4 = task panel） |
| 3 | `tests/unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt`（既存・実キャプチャ） | claude 2.1.240 | L108 / 1001 | 前: 空白、後: ` · ctrl+e to explain` | 下 893（非空 7 = task panel） |
| 3 | `tests/fixtures/claude-live-2468/askuserquestion-submit-files-edited-panel.txt`（既存・実キャプチャ） | claude 2.1.267 | フッタなし / 1001 | — | 0（HUD `+28 files edited before this session` は最下行だが、この画面にフッタは無い） |

採取表 #3 の 2.1.278 での結果:

- **session-diff HUD**: 2.1.278 では**フッタの下ではなく画面の右側**に出た（`claude-2.1.278-*-quoted-footers.txt` の列 111–200・行 2–10、
  `1 file changed +1 -1 ✕`）。フッタより下を捨てる量には効かない（上表の 2.1.278 の行は全部「非空 0」）
- **task panel**: **未測**。このセッションでは TaskCreate / TodoWrite が使えず（claude 自身が「どちらも利用できない」と返答）、
  パネルを出せなかった。合成はせず、上表の 2.1.223 / 2.1.240 の実キャプチャ（非空 4 / 7）を「フッタ以降を捨てる」が
  本来想定していた量の実測として使う

### 引用（採取表 #5 と、既存 fixture に在ったもの）

| ファイル | CLI | 当たる行（全行数） | 行全体か（前にあるもの） | 下の非空行 | 旧ルールで捨てた行数 → 新ルール |
|---|---|---|---|---|---|
| `tests/fixtures/tui-frame-footer-2776/claude-2.1.278-idle-quoted-footers.txt` | claude 2.1.278 | L58 / L61 / L65 / L67（1001） | `「フッタ: ` / `「` / `- Picker footer: フッタ: ` / `- Approval footer: ` | 15 / 12 / 10 / 8 | L67 で 上 67（非空 46）→ **0** |
| `tests/fixtures/tui-frame-footer-2776/claude-2.1.278-picker-below-quoted-footers.txt` | claude 2.1.278 | 同じ 4 行 | 同上 | 25 / 22 / 20 / 18 | 旧でも本物の L92 が選ばれる（引用から本物まで 25 行、非空 18）→ 同じ |
| `tests/fixtures/tui-frame-footer-2776/claude-2.1.278-approval-below-quoted-footers.txt` | claude 2.1.278 | 同じ 4 行 | 同上 | 31 / 28 / 26 / 24 | 旧でも本物の L102 が選ばれる（引用から本物まで 35 行、非空 24）→ 同じ |
| `tests/fixtures/tui-frame-footer-2776/codex-0.155.1-idle-quoted-footers.txt` | codex 0.155.1 | L42 / L43（1016） | `「フッタ: ` / `「` | 5 / 4 | L43 で 上 43（非空 29）→ **0** |
| `tests/fixtures/tui-frame-footer-2776/command-code-1.58.0-idle-quoted-footers.txt` | command-code 1.58.0 | L20 / L21（1001） | `「フッタ: ` / `「` | 8 / 7 | L21 で 上 21（非空 15）→ **0** |
| `tests/fixtures/codex-quoted-footer-2774/idle-after-quoted-picker-footer.txt`（2774・合成） | codex | L22（32） | `「フッタ: ` | 5 | L22 で 上 22（非空 20）→ **0**。`›` を消すと旧ルールは 下 10（非空 5）→ 新ルールは **0** |
| `tests/unit/lib/detection/fixtures/copilot-picker-1895/picker-vocabulary-in-response.txt`（既存・実キャプチャ） | copilot 1.0.80 | L57（1002） | `navigate · ` | 14 | L57 で 上 57（非空 45）→ **0** |
| `tests/fixtures/claude-idle-numbered-list-2457/reply-quotes-dialog-wording.txt`（既存・合成） | claude | L10（19） | **前: 空白**、後: ` · ctrl+e to explain がフッタです。` | 6 | 上 10（非空 7）→ **同じ**（新ルールでも当たる。後述） |

2774 の実例（Issue 2774 本文。私有の会話を含むため実キャプチャは非収録）は「1002 行中 963 行を捨てた、誤認行は L39」。

### 他ツールの通常フレーム（採取表 #4）

| ファイル | CLI | 当たる行 |
|---|---|---|
| `tests/fixtures/tui-frame-footer-2776/codex-0.155.1-idle-after-turn.txt` | codex 0.155.1 | 0 |
| `tests/fixtures/tui-frame-footer-2776/command-code-1.58.0-idle-after-turn.txt` | command-code 1.58.0 | 0 |
| antigravity | agy 1.2.7 | **未測**（trust の承諾・拒否がどちらも既存の `~/.gemini/trustedFolders.json` に書かれうるため採取しなかった。下の走査の 38 ファイルで代える） |

`tests/fixtures/` と `tests/unit/lib/detection/fixtures/` の全体走査（パスに `codex` / `command-code` / `antigravity` / `agy` を含む
ファイル。`.txt` `.capture` `.log` は本文、`.json` `.jsonl` は文字列の葉、`.ts` は export した文字列と引数 0 の関数の戻り値）:

| ツール | 走査したファイル | 新ルールで当たる行 | 旧ルールで当たる行 |
|---|---|---|---|
| codex | 57 | **0** | 3（2774 fixture L22、`codex-0.155.1-idle-quoted-footers.txt` L42 / L43 — すべて引用） |
| antigravity | 38 | **0** | 0 |
| command-code | 115 | 16（下記） | 18（下記 16 ＋ `command-code-1.58.0-idle-quoted-footers.txt` L20 / L21 の引用） |

command-code の 16 行は `command-code-askuserquestion-2753/multiselect-answered-tabs.txt` L28 と
`command-code-askuserquestion-2754/*.txt` 15 本（L38–L70）で、どれも **command-code 自身の AskUserQuestion フッタ**
`Enter to select | Arrow keys to navigate | 1-9 quick select | n notes | c chat | Esc to cancel`（claude と同じ文言）が行頭にある。
誤認ではなく本物のフッタで、**下の非空行はすべて 0**（切り落としで失う行が無い）。テストはこの 3 点（ディレクトリ・文言・下が空）を固定する。

---

## 各案の判断

### (a) 行アンカー — 行頭側を採る

- **支持した実測**: 走査で見つかった実キャプチャの本物のフッタ 35 行 — claude 19 行（2.1.223 の canary 6、2.1.240 の 1708 1、
  2.1.268 の 2486 7、2.1.278 の本採取 5。表はそのうち 10 行）と command-code 16 行 — は、すべて一致部分の前が空白だけ。
  生キャプチャでは `' \x1b[38;5;246mEsc to cancel…'` のように空白と SGR 1 個が前に来る（`claude-2.1.278-bash-approval.txt` L25）。
  実キャプチャの引用 17 行（claude 2.1.278 の 3 本 × 4 行、codex・command-code 各 2 行、copilot 1 行）と 2774 の合成 1 行は、
  すべて前に可視文字（`「`、`「フッタ: `、`- Approval footer: `、`navigate · `）を持つ。
- **限界**: 引用が行頭（前が空白だけ）から始まれば、この条件でも当たる。実キャプチャにその例は無く、
  既存 fixture では合成の 2457 の 1 行だけ（行末側の節で後述）
- **SGR を許す理由**: 旧ルールは位置を見なかったので、生のキャプチャ（ANSI 付き）を渡しても本物のフッタに当たった。
  行頭アンカーを `^\s*` にすると生の入力で当たらなくなる。確認した本番の呼び出し元（`frame.ts` / `detectPrompt` の
  各呼び出し）は `stripAnsi` 済みの文字列を渡すので、現状この許容が効くのは生の入力だけ（変異 2 で確認）

### (a) 行アンカー — 行末側は採らない

- **支持しなかった実測**: 本物のフッタ 35 行中 30 行は一致部分の後ろに続きがある
  （claude の picker は ` · Esc to cancel` / ` · n to add notes · Esc to cancel` / ` · n to add notes · Tab to switch questions · Esc …`、
  2.1.240 の確認は ` · ctrl+e to explain`、command-code は ` | 1-9 quick select | n notes | c chat | Esc to cancel`）。
  行は全部フッタだが、今のパターンは行の一部しか書いていないので `\s*$` を足すとこの 30 行が外れる
- 行末まで書くにはキーヒントの文法（実測だけで尾が 5 通りある）を列挙する必要があり、実測に無い形は推測になる。
  しかも行頭側だけで実測の引用はすべて外れるので、行末側で新たに外せる実測の引用は無い
- 例外は合成の `reply-quotes-dialog-wording.txt`（2457）: 返答の本文が行頭からフッタ文言を書き、後ろに ` · ctrl+e to explain がフッタです。`
  が続く。` · <ヒント>` の文法で尾を縛っても 2.1.240 の本物の尾 ` · ctrl+e to explain` と前半が同じで区別できず、
  区別に要る「ヒントの語彙」は推測になる。この行は下に composer があるので「上を捨てる」分岐に入り、下の本文と
  composer は残る（変更前と同じ挙動。`tests/unit/polling/*-2457.test.ts` 2 本は緑のまま）

### (b) 探索範囲を画面下部に限る — 採らない

- **生の行番号**: 表の本物のフッタは L25 / L28 / L30 / L34 / L38 / L43 / L58 / L92 / L102 / L108（全 1001 行）。
  claude は 1000 行ペインの**上端側**にダイアログを描き、その下の約 900 行は空行（task panel があれば最下部）。
  Issue の前提「本物のフッタは画面の下部に描かれる」は生の行番号では成り立たず、2774 実例の誤認行 L39 と同じ帯に入る
- **非空行で数えた末尾からの距離**（`contentLines` の末尾何行か）: 本物は 0 / 4 / 7（4 と 7 は旧版の task panel）。
  引用は 4 / 5 / 7 / 8 / 10 / 12 / 14 / 15 と 18 以上（codex の実採取 L43 は下に 4 行、2774 fixture は 5 行、command-code は 7 行）。
  task panel を残すには N ≥ 7 が要り、その N では codex・2774・command-code の引用が探索範囲に入る。
  割合で数えても同じ行の並びなので同じ重なりになる
- 範囲で外せるのは 2774 実例のような「引用の下に大量の出力がある」場合だけで、それは行頭アンカーで既に外れている

### (c) 捨てる量に上限を置く — 採らない

- **生の行数**: 本物のフッタが捨てる行数は 893–976（ほぼ空行）。2774 実例の 963 と同じ大きさで、上限で区別できない
- **非空行**: 本物が「下を捨てる」量は 0（2.1.278 の全採取）、4 / 7（旧版の task panel）。一方 2774 fixture の引用は
  `›` を消して「下を捨てる」分岐に入れても非空 5 行しか捨てない。本物の範囲に収まるので上限では止まらない
- 2.1.278 の task panel は未測で、パネルの高さ（タスク数・展開表示）に上限がある根拠を実測で持てなかった。
  低い上限は #1708（task panel の行が選択肢として読まれる）を再発させる
- 「上を捨てる」分岐（下に新しい対話がある）で捨てる量は、古いフレームの上側全部という設計なので上限と相容れない

---

## 変更の影響

- 本物のフッタ 35 行: 判定・捨てる行数ともに変わらない（上表と走査）
- 変わるのは引用を含むフレームだけで、どれも「捨てていた行を捨てなくなる」方向:
  claude 2.1.278 の idle（非空 46 行）、codex 0.155.1（29）、command-code 1.58.0（15）、2774 fixture（20）、copilot 1895（45）
- 既存の detection スイート（`CI=true npx vitest run tests/unit/detection tests/unit/lib/detection tests/unit/lib/chat`）は
  変更後も全件緑。期待値を変えたテストは無い

## 変異注入

`tests/unit/lib/detection/tui-frame-footer-2776.test.ts`（16 件）で、追加した条件が効いていることを確かめた。

| 変異 | 赤になった件数 | 赤になったテスト |
|---|---|---|
| 行頭アンカーを外す（＝旧ルール） | 10 / 16 | 引用の下に本物がある 2 本（引用行も当たる）、2774 fixture 3 本（`›` 無しでも捨てない を含む）、採取 5 の 3 本、他ツール走査 2 本 |
| `^\s*` だけにする（SGR を許さない） | 1 / 16 | 生のキャプチャで同じ行がフッタになる。detection スイート＋関連 5 本（2497 件）では赤 0 |

どちらも元に戻したあと 16 / 16 緑。
