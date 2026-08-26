# 検出カナリア（`npm run canary`）

実エージェント CLI の TUI を使い捨て tmux セッションで起動し、固定シナリオで得たフレームを
**本番と同じ検出関数**（`detectSessionStatus` / `detectPrompt`）に食わせて期待値を assert する回帰プローブ。

CLI の新バージョンが検出層を壊したことを、ユーザー報告ではなく**カナリアで**検知するために存在する
（Issue #1727 / Epic #1720）。hooks 化（#1720）が完了しても scraper はフォールバックとして残るため、本カナリアは恒久的に価値がある。

Issue #1847 で claude のシナリオが 7 本になり、後半 2 本は検出層ではなく **Auto-Yes v2 の裁定**
（`PermissionRequest` hook）を実 TUI で確認する。こちらが守っているのは
「`allow` を返すとダイアログが出ずにツールが走る」「空応答ならダイアログが出る」という
**Claude 側の契約**で、これはリポジトリ内のどのテストでも観測できない。

Issue #2050 で **2 つ目のツール `opencode` が 5 シナリオ**入った。`--tool` で切り替える
（既定は `claude`）。**1 回の実行が駆動するのは 1 ツールだけ** — 使い捨て HOME・pane geometry・
起動完了行・起動フラグがツールごとに違い、途中で組み替えるとハーネスを建て直すことになるため。

- 実装: [`scripts/canary/`](../../scripts/canary/)
- 生成される実フレーム: `tests/fixtures/canary/`
- 単体テスト（tmux も課金も不要）: `tests/unit/canary/`

---

## 前提

| 項目 | 要件 | 備考 |
|---|---|---|
| tmux | **3.2 以上** | `new-session -e VAR=value` を使うため。preflight で検証し、古ければ即エラー |
| CLI | PATH 上に実行可能な `claude` / `opencode` | preflight で `--version` を実測し、**`verifiedAgainst` と突き合わせて版ずれを報告する**（後述） |
| 認証 | ツールごとに異なる | 下記「認証」参照 |
| OS | macOS / Linux | keychain 経由の claude 認証は macOS のみ。Linux は環境変数が必須 |

### ツールごとの実行形（`scripts/canary/tool-profiles.ts`）

| | claude | opencode |
|---|---|---|
| pane geometry | `TUI_PANE_WIDTH x TUI_PANE_HEIGHT` = **200x1000** | `80 x OPENCODE_PANE_HEIGHT` = **80x200** |
| capture 行数 | 1000（`STATUS_DETECTION_CAPTURE_LINES`） | 200（alternate screen なので pane 高が上限） |
| 起動完了行 | `? for shortcuts` | `tab agents  ctrl+p commands` |
| 起動フラグ | `--permission-mode manual` | なし（固定は config 側） |
| hooks シナリオ | あり（#1847） | なし（`PermissionRequest` 相当が無い） |

> **起動完了行は「検出器が読む行」であってはならない。** 起動ゲートが検出器の判定行と同じだと、
> idle シナリオは**ゲートが既に保証したこと**を assert するだけの空振りになる。
> opencode で `┃  Ask anything...`（branch E の規則そのもの）ではなく
> `tab agents  ctrl+p commands` を使っているのはそのため（`tool-profiles.ts` の rule 1）。

### 認証

隔離 HOME 下では **Claude Code は keychain へフォールバックしない**（2.1.223 で実測。HOME も `CLAUDE_CONFIG_DIR` も
移すと `/login` 画面に落ちる）。そのためカナリアは認証を明示的に解決する:

1. `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token` で発行）または `ANTHROPIC_API_KEY` が環境にあればそれを使う（CI 経路）
2. 無ければ macOS keychain の `Claude Code-credentials` を読み、使い捨て HOME に `.claude/.credentials.json`（0600）として複製する

**アクセストークンの期限が 15 分未満の場合は 2 を拒否する。**
使い捨てセッションがリフレッシュすると refresh token がローテートされ、**開発者本人のセッションがログアウトされ得る**ため。
その場合は時間をおいて再実行するか、`CLAUDE_CODE_OAUTH_TOKEN` を使う。

#### opencode（Issue #2050）

opencode は provider の credential を `~/.local/share/opencode/auth.json` からしか読まない（環境変数経路は無い）。
カナリアはこれを**使い捨て HOME に mode 600 で複製**し、実行後に HOME ごと削除する。
ファイルが無いマシンは preflight で拒否する（90 秒後に `Connect a provider` で止まるより早い）。

モデルは使い捨て `~/.config/opencode/opencode.jsonc` に固定する。既定は
`github-copilot/claude-sonnet-4.6`、`CM_CANARY_OPENCODE_MODEL` で上書き可。
**固定するのは「モデルピッカーを一度も開かずに済ませる」ため** — ピッカーは確定すると既定モデルを書き換える
（claude の `/model` overlay と同じ罠。`opencode-picker` が確定せず Escape するのもこれが理由）。

同じ config に `permission: { bash: "ask", edit: "ask", webfetch: "ask" }` も書く。
**1.18.22 の既定では `ls -la` がそのまま実行され、承認ダイアログが出ない**（実測）ので、
これが無いと `opencode-permission` は観測対象を失う。claude の `--permission-mode manual` と同じ性質の固定で、
**カナリアについての言明であって CommandMate のセッションがこうなるという話ではない**。

---

## 実行

```bash
npm run canary                                   # claude 7 シナリオすべて
npm run canary -- --tool opencode                # opencode 5 シナリオすべて
npm run canary -- --list                         # 全ツールのシナリオ一覧（意図・期待値・所要時間）
npm run canary -- --only model-overlay,idle      # 一部だけ実行
npm run canary -- --skip generating              # 一部だけ除外
npm run canary -- --json                         # 機械可読サマリ
npm run canary -- --keep                         # 使い捨て HOME と tmux セッションを残す（デバッグ用）
npm run canary -- --mutate                       # ハーネス自体の非空振り自己テスト（後述）
npm run canary -- --mutate-verdict               # 受け口の裁定を反転させる自己テスト（後述）
npm run canary -- --strict-version               # 版ずれを exit 5 にする（後述）
CM_CANARY_MODEL=haiku npm run canary             # claude の課金を抑える（後述）
CM_CANARY_OPENCODE_MODEL=... npm run canary -- --tool opencode   # opencode の provider/model を差し替える
```

> `--only` に他ツールの id を渡すと「`--tool opencode` のシナリオです」と名指しで拒否する。
> 素の "unknown scenario" にすると、実際は `--tool` の付け忘れなのに typo を疑って探し始めることになるため。

> **permission mode は `--permission-mode manual` で固定している**（Issue #1847）。
> Claude Code 2.1.236 で既定が **auto mode** になり、auto mode では Claude が自分で承認判断をするため
> **本カナリアが読むべき承認ダイアログがそもそも描画されない**。しかも使い捨て HOME では
> 1 本目だけ manual・2 本目以降が auto へ自己移行するため、複数シナリオ実行だけが
> 「起動タイムアウト」で落ちるという分かりにくい形で出ていた（ready フッタ `? for shortcuts` が
> manual mode にしか無いため）。`settings.json` に `permissions.defaultMode` を書くと今度は
> 「Make auto mode your default permission mode?」の選択画面が composer の前に出るので、
> コマンドライン側で固定している（`CANARY_PERMISSION_MODE` / `scripts/canary/session.ts`）。

### exit code

| code | 意味 | 対応 |
|---|---|---|
| 0 | 全シナリオ緑 | — |
| 1 | **検出回帰**（期待値に到達しなかった） | `tests/fixtures/canary/` の実フレームを見て別 Issue を起票 |
| 2 | 引数・前提エラー（claude 不在、tmux が古い、認証なし 等） | メッセージに従う |
| 3 | **ガード違反**（実 HOME の設定が変わった / `mcbd-*` セッションが消えた） | 即調査。カナリア自体の欠陥 |
| 4 | 判定不能（API overload / usage limit でシナリオが状態に到達できず） | 検出回帰ではない。時間をおいて再実行 |
| 5 | **版ずれ**（`--strict-version` 指定時のみ。全シナリオは緑） | fixture を採り直して `verified-against.ts` を更新する |

`--mutate` のときだけ意味が反転する: **全シナリオが赤になれば exit 0**（自己テスト成功）。

### 所要時間と費用の目安

2026-08-06 の実測（macOS, tmux 3.5a, claude 2.1.223, Opus 5 既定）:

| 項目 | 実測 |
|---|---|
| 5 シナリオ合計 | **約 29 秒**（実測 28.6 秒。最遅シナリオ `askuserquestion-task-panel` が 12.6 秒） |
| `--mutate` 自己テスト | 約 166 秒（各シナリオが 30 秒の timeout を消費するため） |
| トークンを使うシナリオ | 3 つ（`permission-dialog` / `askuserquestion-task-panel` / `generating`）。`idle` と `model-overlay` は **API を一切呼ばない** |

2026-08-20 の実測（同環境, claude 2.1.237, Opus 5 既定。シナリオ 6・7 追加後）:

| 項目 | 実測 |
|---|---|
| 7 シナリオ合計 | **276.7 秒**。ただしその 244 秒は `askuserquestion-task-panel` の timeout（下記「既知の限界」）。他 6 件は合計 29 秒 |
| シナリオ 6・7 だけ | **16.8 秒**（`--only permission-hook-allow,permission-hook-no-decision`） |
| `--mutate-verdict` 自己テスト | **369.9 秒**（2 件がそれぞれ満了まで待つ。時計を縮めない理由は後述） |
| `--mutate --only permission-hook-*` | 67.3 秒 |
| トークンを使うシナリオ | 5 つ（上記 3 つ ＋ `permission-hook-allow` / `permission-hook-no-decision`） |

2026-08-26 の実測（同環境, opencode 1.18.22, `github-copilot/claude-sonnet-4.6` 固定）:

| 項目 | 実測 |
|---|---|
| `--tool opencode` 5 シナリオ合計 | **45.2 秒**（最遅 `opencode-turn-complete` が 17.6 秒。初回計測時は 62.9 秒） |
| `--tool opencode --mutate` 自己テスト | **180.7 秒**（各シナリオが 30 秒の timeout を消費するため） |
| トークンを使うシナリオ | 3 つ（`opencode-generating` / `opencode-permission` / `opencode-turn-complete`）。`opencode-idle` と `opencode-picker` は **API を一切呼ばない** |
| 1 ターンの生成時間 | 12.8s / 20.7s（約 300 語のプロンプト。`--mutate` の mutant 選択がこの値に依存する — 後述） |

費用は 1 回あたり**数十セント程度**（各シナリオで短いプロンプト 1 本 + システムプロンプト。既定モデルが Opus 5 の場合の概算で、
実測ではなく見積り）。Max プラン配下で実行した場合はプランの利用枠から引かれる。
`CM_CANARY_MODEL=haiku` を付けると課金対象の 3 シナリオが Haiku 4.5 で走り、桁で安くなる
（検出対象は TUI の形であってモデルの賢さではないため、シナリオの妥当性は落ちない）。

---

## 何を assert しているか

### claude（Issue #1727 / #1847、7 シナリオ）

| # | シナリオ id | 状態 | 期待する検出結果 |
|---|---|---|---|
| 1 | `idle` | 起動直後のプロンプト | `ready` / `input_prompt`、`hasActivePrompt=false`、Auto-Yes 沈黙 |
| 2 | `permission-dialog` | Write ツールの許可ダイアログ | `waiting` / `prompt_detected`、`hasActivePrompt=true`、**Auto-Yes からも見える** |
| 3 | `askuserquestion-task-panel` | AskUserQuestion picker ＋ 最下部のタスクパネル併存（#1708 の形） | `waiting`（`prompt_detected` または `claude_selection_list`）**かつフレームにタスクパネルが写っていること** |
| 4 | `model-overlay` | `/model` オーバーレイ | `waiting` / `claude_selection_list` **かつ Auto-Yes からは見えない**（#1495） |
| 5 | `generating` | 生成中 | `running` / `thinking_indicator`、Auto-Yes 沈黙 |
| 6 | `permission-hook-allow` | Auto-Yes v2 が `PermissionRequest` に `allow` を返した後 | **ダイアログがどちらの経路にも出ない**、`structuredEvents` も prompt を報告しない、**probe ファイルが実在する**（＝ツールが本当に走った） |
| 7 | `permission-hook-no-decision` | 契約 `denyPatterns` 一致 → no-decision | `waiting` / `prompt_detected`、両経路から見える、`autoYes.lastSuppression.reason = deny-pattern`、**probe ファイルは無い** |

シナリオ 6・7 は Auto-Yes v2（#1724）の裁定を実 TUI で確認するもので（Issue #1847）、
フレームだけでは足りない点が他の 5 つと違う。**「裁定が無いとき」と同じ画面が期待値**なので、
pane だけを見ると受け口が何も答えなかった場合と区別が付かない。そのため
probe ファイルの実在（6）と裁定器自身の verdict ＋ `lastSuppression`（7）を併せて assert する。

この 2 つは本番の `buildAgentHookSettings` が書いた `--settings` を**カナリア内の受け口**
（`hook-receiver.ts` / `127.0.0.1:0` の ephemeral ポート）に向けて起動する。
裁定は本体の `resolvePermissionRequest` をそのまま呼び、**DB を要する 2 箇所だけ**
（契約 `autoYes` の読み出しと `allow` の監査記録）を `PermissionDecisionDeps` で差し替える。
`structuredEvents` / `autoYes.lastSuppression` も `buildCurrentOutput` と同じ getter
（`getLastAgentEvent` / `resolvePromptWaiting` / `getLastPolicySuppression`）で組む。

検出の呼び方は**本番の 2 経路をそのまま複製**している:

- ステータス経路 — `detectSessionStatus(生capture, <tool>)`（`worktree-status-helper.ts` と同じく ANSI 付きの生フレームを渡す）
- Auto-Yes 経路 — `detectPrompt(stripBoxDrawing(stripAnsi(生capture)), buildDetectPromptOptions(<tool>))`（`auto-yes-poller.ts` は status-detector を通さない）

`<tool>` はシナリオの `tool` フィールドがそのまま入る（#2050）。これが opencode の分岐 A0〜E と
`hasNumberedDialogs: false` の宣言を選ぶスイッチなので、`tool` を取り違えたシナリオは
**別ツールの規則で採点される**（実行に失敗するのではなく、静かに違う答えを出す）。

**両方を独立に assert する**のが重要で、「片方だけが見る」プロンプトこそがカナリアの主対象である（#1495 は Auto-Yes 側だけで発火した）。

capture は本番と同じ `capture-pane -p -e -S -1000`、ペインも本番の geometry（`TUI_PANE_WIDTH` × `TUI_PANE_HEIGHT` = 200×1000、
`history-limit` も同値）で作る。#1708 の「上端に picker・下端にタスクパネル・間に約 950 行の空行」というレイアウトは
この geometry でしか再現しない。

### opencode（Issue #2050、5 シナリオ）

`src/lib/detection/tools/opencode/detect.ts` の**陽性分岐 A0 / A / C / D / E に 1 本ずつ**。
この 5 本が opencode の status detector が言えることの全部なので、5 本緑
＝「その版の TUI で規則がまだ成り立っている」になる。

| # | シナリオ id | branch | 状態 | 期待する検出結果 |
|---|---|---|---|---|
| 1 | `opencode-idle` | E | 起動直後の composer（`┃  Ask anything...`） | `ready` / `input_prompt` / `evidence=positive`、busy フッタ無し、Auto-Yes 沈黙 |
| 2 | `opencode-generating` | A | 生成中（`esc interrupt` フッタ） | `running` / `opencode_processing_indicator` / `evidence=positive`、フレームに busy フッタ |
| 3 | `opencode-permission` | A0 | 承認ダイアログのボタン列 | `waiting` / `opencode_permission_prompt`、`hasActivePrompt=false`、**Auto-Yes から見えない**、`△ Permission required` が写っている |
| 4 | `opencode-picker` | C | `/models` picker | `waiting` / `opencode_selection_list`、**Auto-Yes から見えない**（#1495 と同型の罠） |
| 5 | `opencode-turn-complete` | D | 完了マーカー `▣  Build · <model> · <duration>` | `ready` / `opencode_response_complete` / `evidence=positive`、duration 付きマーカーあり・busy フッタ無し |

**各期待値は独立な 2 つの主張をする**（`scripts/canary/opencode-expectations.ts`）:

1. **本番の verdict** — `evidence` まで含めて。`evidence` は飾りではなく設計規則 D1 を assert に落としたもので、
   分岐を失って heuristics に落ちた検出器は同じ `ready` / `running` を返しつつ `evidence: 'none'` になる
   （#1894 が記録した「語彙が変わったので `ready` が戻ってきた」失敗そのもの）
2. **フレームの構造的事実** — ただし**検出器が読む行とは別の行**を、`cli-patterns.ts` から import せず
   その場に書き下す。ダイアログは見出し `△ Permission required`（検出器はボタン列を読む）、
   picker は `Connect provider ctrl+a` のヒント行（検出器は `Select model` ヘッダを読む）、
   生成中は spinner セル（検出器は `esc interrupt` の語を読む）。
   同じ定数を使い回すと、その定数を壊したとき**両方の主張が同時に動いて**
   「そもそもその状態に到達したのか」が言えなくなる

`opencode-idle` と `opencode-turn-complete` が別の `reason` なのは実測どおり:
**1 ターン走ったあとの composer には `Ask anything...` が描かれない**ので、
完了フレームの `ready` は branch E ではなく branch D（完了マーカー）から出る。

capture は本番と同じ `capture-pane -p -e -S -200`、ペインも本番の geometry
（`80 × OPENCODE_PANE_HEIGHT` = 80×200 —— `launchSession()` が実セッションを resize する値）で作る。
`OPENCODE_PERMISSION_PATTERN` の docblock が「`enter confirm` は 80 桁で `enter con` に切れる」と
記録しているとおり、**幅が違えば見えている画面も違う**。


---

## 隔離（ここは絶対に緩めないこと）

| 対象 | 方法 | 検証 |
|---|---|---|
| tmux | **すべての呼び出しが `-L cmate-canary-*` を経由**（`buildTmuxArgs()` が強制。socket 名は正規表現で検証） | `tests/unit/canary/canary-isolation.test.ts` |
| `kill-server` | `PrivateTmuxServer.killServer()` からのみ到達可能。素の argv 構築では例外 | 同上 |
| server-global 変更 | `bind-key` / `unbind-key` / `source-file` / `-g` は拒否 | 同上 |
| セッション指定 | 常に完全一致形 `=<name>:` | 同上 |
| HOME | `mkdtemp` した使い捨て HOME（realpath 解決済み）。**tmux サーバ自体の env も差し替える** | セッション作成直後に `show-environment HOME` で**転送されたことを assert** |
| XDG 変数 | `XDG_{CONFIG,DATA,STATE,CACHE}_HOME` / `OPENCODE_CONFIG*` を**環境から落とす**（#2050） | `sanitizeEnv` の `STRIPPED_ENV_VARS`（単体テストが全数を検証） |
| 実 `~/.claude/settings.json` | 触らない | 実行前に sha256 を取り、**各シナリオの前後**と teardown 後に再検証（違反は exit 3） |
| 実 `~/.config/opencode/opencode.json{,c}`・`~/.local/share/opencode/auth.json` | 触らない | 同上（sha256） |
| 実 `~/.local/share/opencode/opencode.db` | 触らない | 同上。ただし **size+mtime** で照合（58MB あり、シナリオごとに 2 回ハッシュすると実行より重い） |
| ユーザーの `mcbd-*` セッション | 触らない | 実行前後で一覧を突き合わせ、消滅・出現を検出（違反は exit 3） |

補足:

- `TMUX_TMPDIR` は**隔離手段として使わない**。`$TMUX` が設定されていると無視される。効くのは `-L` / `-S` だけ
- **opencode は `$HOME` から config / state / data（`opencode.db` を含む）を全部引く**。
  セッションを 1 回動かすだけで `opencode.db` に書くので、HOME を差し替えないと実データを汚す
  （方針書 `docs/design/opencode-server-live-verification.md` §4.1）。XDG 変数を落とすのは、
  使い捨て HOME の中から実ディレクトリへ戻る経路を塞ぐため
- 素の `tmux` を呼ぶ箇所は `guards.ts` の `listUserTmuxSessions()` **ただ一つ**で、`list-sessions` 決め打ちの読み取り専用
- 私設サーバは `-f /dev/null` で起動する（開発者の `~/.tmux.conf` に左右されない）
- 使い捨て HOME には認証情報の複製が入るため、実行後に必ず削除する（`--keep` 時のみ残り、削除コマンドが表示される）

---

## ハーネス自体の非空振り証明（`--mutate`）

各シナリオは「本来の期待値」に加えて、**もっともらしいが誤った期待値**（`mutantExpectation`）を持つ。
`--mutate` はこちらで走り、**全シナリオが赤にならなければ自己テスト失敗**として扱う（緑のまま通ったら、その assert は空振りしている）。

2026-08-06 の実測（claude 2.1.223）: **5/5 が赤**（`blocked` 0 件）→ `mutation self-test PASSED`（exit 0）。

`--mutate` 実行時は fixture を上書きしない（赤フレームで正常時の参照フレームを潰さないため）。

### `--mutate-verdict`（Auto-Yes v2 シナリオ用 / Issue #1847）

シナリオ 6・7 で問われているのは**述語の正しさではなく受け口の応答**である。
どちらも「裁定が無いときと同じ画面」を期待値にしているので、誤った期待値を当てても
「このハーネスは本当に裁定を届けているのか」は証明できない。そこで
**受け口が逆の裁定を返す**モードを別フラグとして用意した:

| シナリオ | 通常 | `--mutate-verdict` | 期待される結果 |
|---|---|---|---|
| `permission-hook-allow` | `allow` | `{}` | ダイアログが出る → 赤 |
| `permission-hook-no-decision` | `{}` | `allow` | ダイアログが出ない → 赤 |

- 期待値は**本来のもののまま**。反転するのは受け口の応答だけで、受け口のログには
  `[MUTATED: sent …]` が残る（裁定器自身の verdict は本物のまま記録される）
- **受け口を持たないシナリオは SKIP** になり、合否の材料に数えない
- `--mutate` と違い**時計を 30 秒に縮めない**。縮めると「反転が画面を変えたから赤」ではなく
  「まだ何も起きていないから赤」で通ってしまい、自己テストが誤って PASS する
- `--mutate` と `--mutate-verdict` は**同時指定できない**（赤の原因が特定できなくなるため）

2026-08-20 の実測（claude 2.1.237）: **2/2 が赤** → `mutation self-test PASSED`（exit 0）。
allow を `{}` にすると `waiting` / `prompt_detected` になり、no-decision を `allow` にすると
`ready` / `input_prompt` に戻る。`--mutate`（誤った期待値）でも 2/2 が赤。

### opencode の非空振り証明（Issue #2050）

**mutant は「そのシナリオでは絶対に満たせないもの」を選ぶこと。** `--mutate` は
「mutant で緑になったら自己テスト失敗（空振り）」と報告するので、シナリオが*自然に流れ着く*状態を
mutant にすると自己テストが不安定になる。実際 `opencode-generating` の mutant に
`opencode-turn-complete` を当てるのは**駄目**で、実測のターンは 12.8 秒 —— `--mutate` の 30 秒時計に
余裕で収まるので mutant が真になり「空振り」と誤報される。現行の 5 本はどれも
「そのシナリオが決して描かない行」（ダイアログ見出し・picker ヒント行・busy フッタ）を要求している。

2026-08-26 の実測（opencode 1.18.22）:

| 自己テスト | 結果 |
|---|---|
| `--tool opencode`（通常） | **5/5 緑**、62.9 秒 |
| `--tool opencode --mutate` | **5/5 赤** → `mutation self-test PASSED`（exit 0）、180.7 秒 |

さらに CI 側では `tests/unit/canary/canary-opencode-2050.test.ts` が同じ主張を
**committed フレームの 1 行を壊して**確認している（ボタン列のラベル / ボタン列の gutter /
busy フッタの語 / picker ヘッダ / 完了マーカーの duration / composer プレースホルダ）。
**変異は構造を保つもの**にしてある —— gutter ごと消すような変異は後段が gutter を境界に使っている場合に
別の理由で赤になり、何を証明したのか分からなくなるため。

---

## 版ずれ検出（`opencode --version` × `verifiedAgainst`、Issue #2050）

preflight が実行する `<tool> --version` は、そのまま**陳腐化プローブ**でもある。出力は
`src/lib/detection/version-probes.ts` と**同じ** `parseCliVersion` を通り、`commandmate status` と
`npm run check:detector-freshness` が読むのと**同じ** `DETECTOR_VERIFIED_AGAINST` と突き合わされる。
つまりカナリアの結果は必ず「どの版で測ったか」「規則はその版で読まれたものか」を伴って出る。

これが赤を actionable にする。`opencode-permission FAILED` だけでは検出回帰と
「昨日 opencode を上げた」を区別できないが、`installed 1.18.30 / rules read off 1.18.22` が
同じ画面にあれば即座に判別できる。赤が出たときはサマリの直後にも drift を再掲する。

| 状態 | 意味 |
|---|---|
| `fresh` | installed == stamp |
| `stale` | installed > stamp。**fixture を採り直して `verified-against.ts` を更新する** |
| `rules-ahead` | installed < stamp（規則の方が新しい版で読まれている） |
| `unmeasured` | そのツールのフレームは一度も採られていない |
| `unreadable` | `--version` から版が読めなかった |

既定では**警告のみ**（exit code に影響しない）。`--strict-version` を付けたときだけ exit 5 になる。
既定を失敗にしない理由: 版が上がった当日でも全シナリオが緑のことはあり、
版番号だけで赤くなるカナリアは「無視してよいもの」として学習されて仕組みごと死ぬ。

pane geometry も一緒に報告する（`80x200 (stamp says …)`）。
**別の幅で採った fixture は本番が見ている画面の fixture ではない**ため。

---

## 赤が出たときの読み方

1. **`FAIL`** — 期待値に到達しなかった。検出回帰の可能性が高い。`tests/fixtures/canary/<id>.ts` にその時の実フレームが
   `tests/fixtures/` と同じ形式で保存されているので、そのまま修正用の回帰テストに使える（生の ANSI 付きは `<id>.raw.txt`）
2. **`BLOCKED`** — フレームに API overload / usage limit reached / API Error が写っていた。**検出回帰ではない**。
   自己リトライ中（`529 Overloaded · Retrying in 34s`）は最大 180 秒までシナリオの時計を止めて待つ
3. **`GUARD VIOLATION`（exit 3）** — 実 HOME の設定が変わった等。カナリア自体の欠陥なので最優先で調査する

> 注意: fixture は**赤い実行でも上書きされる**。commit する前に diff を確認すること。
> `tests/unit/canary/canary-expectations.test.ts` は「commit された fixture = 直近の正常フレーム」であることを前提にしている。

---

## シナリオの追加

`scripts/canary/scenarios.ts` の `SCENARIOS` に 1 エントリ足すだけでよい（`--only` / `--list` / fixture 生成は自動で追随する）。

```ts
{
  id: 'my-scenario',            // ファイル名になるので [a-z0-9-] のみ
  tool: 'claude',               // 'claude' | 'opencode'（#2050）
  title: '…',
  intent: '壊れたとき何が起きるのかを書く',
  cost: 'small',                // 'none' なら API を呼ばない
  timeoutMs: 120_000,
  pollIntervalMs: 2_000,
  expectation: expectSomething,       // expectations.ts の純関数
  mutantExpectation: expectSomethingElse,  // 必ず別物にすること（--mutate の根拠）
  resetKeys: ['Escape'],
  async drive(driver) { await driver.submitPrompt('…'); },
}
```

期待値そのものは `scripts/canary/expectations.ts` に**純関数**として書く。こうしておくと
`tests/unit/canary/` から commit 済み fixture に対して同じ述語を回せるので、CI（tmux も課金もなし）でも守られる。

**hooks 経由の裁定まで見るシナリオ**は、上に加えて `hooks` ブロックを持つ（Issue #1847）:

```ts
  hooks: {
    policy: { mode: null, allowPromptTypes: [], denyPatterns: ['…'] },  // 契約の autoYes 相当
    probeFile: 'canary-…-probe.txt',   // ツールが本当に走ったかの証拠になるファイル
  },
```

これが付いていると runner が (1) 本番の `buildClaudeLaunchCommand` で `--settings` を生成して
カナリアの受け口に向け、(2) Auto-Yes を有効化し、(3) 毎 capture で `Observation.hooks` を埋める。
期待値は `scripts/canary/hook-expectations.ts` に置く（フレームではなく `Observation.hooks` を読むため、
`expectations.ts` とはファイルを分けている）。**`hooks` が無いときは必ず不一致を返すこと** —
受け口が繋がっていない実行が空振りで緑にならないようにするため。

---

## 既知の限界

- **claude / opencode 以外のツール（codex / gemini / antigravity / copilot）は未対応。** Epic #1720 Phase 4 と同時期に追加する
- **#1708 の「Ready to submit your answers?」確認画面は対象外。** これは picker と違いフッターを持たず、
  現行コードでは**既知の未修正欠陥**（Issue #1708 で追跡中）。既知バグを緑の期待値としてハーネスに固定すると
  カナリアが恒常的に赤になり signal として死ぬため、シナリオ 3 は「picker ＋ タスクパネル併存」（#807 のガードが効く形）を対象にしている。
  #1708 が修正されたら、確認画面を新しいシナリオとして追加すること（id は 6・7 が Auto-Yes v2 で埋まっている）
- シナリオ 3 は Claude の `TaskCreate` ツールに依存する。ツール名が変わるとタスクパネルが描画されず、
  「併存を再現できなかった」として赤になる（これは意図した挙動: 弱いプローブが緑の顔をするより良い）。
  **2026-08-20 に実際にこれが起きた**: claude 2.1.237 のセッションに `TaskCreate` が存在せず
  （`No matching deferred tools found`）、picker は正しく検出できているのにタスクパネルが無く
  241 秒の timeout で赤になった。**検出回帰ではない**。駆動プロンプトの書き直しが必要で、#1727 側の課題
- シナリオ 6・7 は claude 専用。他ツールの `AgentEventSource`（codex / copilot / gemini / antigravity /
  opencode）には `encodeVerdict` / `parsePermissionRequest` を実 TUI で確かめる仕組みがまだ無い
- **opencode 側は 80 桁だけを採る**（#2050）。120 / 200 桁の fixture は別 Issue（#2047）の担当で、
  互いの幅に触らないことで並行作業の衝突を避けている
- **opencode の `ctrl+p` コマンドパレットは対象外。** `OPENCODE_SELECTION_LIST_PATTERN` は
  `Select model` / `Select provider` / `Connect a provider` しか名前に持たず、パレットのフレームは
  `running` / `default`（証拠なし）に落ちる（#1896 で実測済みの既知の穴）。
  既知の穴を緑の期待値として固定するとカナリアが恒常的に赤になるため、シナリオにはしていない
- シナリオ 6・7 の受け口は**認証を検証しない**（`withAuthHeader: false` で注入する）。
  `Authorization: Bearer $CM_AUTH_TOKEN` の `allowedEnvVars` 展開（D7）は
  `tests/unit/hooks/hook-settings-generator.test.ts` の担当で、カナリアは見ていない

---

## CI 組み込みの選択肢（未決 — ユーザー判断待ち）

Issue #1727 のスコープでは**ローカル実行までを完了**とし、CI 組み込みは以下の 2 案を提示して判断を仰ぐ。

### 案 A: GitHub Actions nightly

```
schedule: cron '0 18 * * *' (JST 03:00) + workflow_dispatch
runs-on: ubuntu-latest（tmux は apt で導入。3.2+ を満たす）
secrets: CLAUDE_CODE_OAUTH_TOKEN（`claude setup-token`）または ANTHROPIC_API_KEY
失敗時: exit 1 のときだけ Issue を自動起票（exit 4 = BLOCKED では起票しない）
```

- **利点**: 新バージョン配布の当日〜翌日に気付ける。実行忘れがない
- **コスト**: 1 回あたり数十セント（`CM_CANARY_MODEL=haiku` で 1 桁下がる）× 30 日 ≒ **月数ドル**。
  GitHub Actions 側の実行時間は 1 回 2〜3 分（依存インストール込み）で、public repo なら無料枠内
- **リスク**: 長命の認証トークンを GitHub secrets に置くことになる。トークンの権限はアカウント全体に及ぶ。
  ローテーション運用（`claude setup-token` の再発行）が必要
- **注意**: 起票条件を exit code で分けること。API overload での赤（exit 4）で起票すると、
  「カナリアの Issue は無視してよい」という学習が起きて仕組みごと死ぬ

### 案 B: 開発機での手動 / cron 運用

```
シークレット不要（keychain 認証をそのまま使う）
契機: claude のバージョンが上がったとき / リリース前 / launchd or cron で日次
```

- **利点**: シークレット管理ゼロ。追加費用は実行分のみ。すぐ始められる（今日から使える）
- **コスト**: 1 回あたり数十セント、必要なときだけ
- **リスク**: 実行忘れ。気付くのが「壊れてから」になる可能性は残る
- 現実的な運用: `commandmate update` / claude の自動更新後に 1 回回す、をリリース手順に組み込む

**推奨**: まず案 B で運用し、赤が実際に有用だった実績（= 1 回でも回帰を捕まえた）が出てから案 A に上げる。
案 A を先に入れると、トークン管理コストを払った上で「誰も見ない nightly」になりやすい。
