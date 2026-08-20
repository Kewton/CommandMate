# 検出カナリア（`npm run canary`）

実 `claude` の TUI を使い捨て tmux セッションで起動し、固定シナリオで得たフレームを
**本番と同じ検出関数**（`detectSessionStatus` / `detectPrompt`）に食わせて期待値を assert する回帰プローブ。

Claude Code の新バージョンが検出層を壊したことを、ユーザー報告ではなく**カナリアで**検知するために存在する
（Issue #1727 / Epic #1720）。hooks 化（#1720）が完了しても scraper はフォールバックとして残るため、本カナリアは恒久的に価値がある。

Issue #1847 でシナリオが 7 本になり、後半 2 本は検出層ではなく **Auto-Yes v2 の裁定**
（`PermissionRequest` hook）を実 TUI で確認する。こちらが守っているのは
「`allow` を返すとダイアログが出ずにツールが走る」「空応答ならダイアログが出る」という
**Claude 側の契約**で、これはリポジトリ内のどのテストでも観測できない。

- 実装: [`scripts/canary/`](../../scripts/canary/)
- 生成される実フレーム: `tests/fixtures/canary/`
- 単体テスト（tmux も課金も不要）: `tests/unit/canary/`

---

## 前提

| 項目 | 要件 | 備考 |
|---|---|---|
| tmux | **3.2 以上** | `new-session -e VAR=value` を使うため。preflight で検証し、古ければ即エラー |
| claude | PATH 上に実行可能な `claude` | preflight で `--version` を実測しレポートに記録する |
| 認証 | 次のいずれか | 下記「認証」参照 |
| OS | macOS / Linux | keychain 経由の認証は macOS のみ。Linux は環境変数が必須 |

### 認証

隔離 HOME 下では **Claude Code は keychain へフォールバックしない**（2.1.223 で実測。HOME も `CLAUDE_CONFIG_DIR` も
移すと `/login` 画面に落ちる）。そのためカナリアは認証を明示的に解決する:

1. `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token` で発行）または `ANTHROPIC_API_KEY` が環境にあればそれを使う（CI 経路）
2. 無ければ macOS keychain の `Claude Code-credentials` を読み、使い捨て HOME に `.claude/.credentials.json`（0600）として複製する

**アクセストークンの期限が 15 分未満の場合は 2 を拒否する。**
使い捨てセッションがリフレッシュすると refresh token がローテートされ、**開発者本人のセッションがログアウトされ得る**ため。
その場合は時間をおいて再実行するか、`CLAUDE_CODE_OAUTH_TOKEN` を使う。

---

## 実行

```bash
npm run canary                                   # 7 シナリオすべて
npm run canary -- --list                         # シナリオ一覧（意図・期待値・所要時間）
npm run canary -- --only model-overlay,idle      # 一部だけ実行
npm run canary -- --skip generating              # 一部だけ除外
npm run canary -- --json                         # 機械可読サマリ
npm run canary -- --keep                         # 使い捨て HOME と tmux セッションを残す（デバッグ用）
npm run canary -- --mutate                       # ハーネス自体の非空振り自己テスト（後述）
npm run canary -- --mutate-verdict               # 受け口の裁定を反転させる自己テスト（後述）
CM_CANARY_MODEL=haiku npm run canary             # 課金を抑える（後述）
```

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

費用は 1 回あたり**数十セント程度**（各シナリオで短いプロンプト 1 本 + システムプロンプト。既定モデルが Opus 5 の場合の概算で、
実測ではなく見積り）。Max プラン配下で実行した場合はプランの利用枠から引かれる。
`CM_CANARY_MODEL=haiku` を付けると課金対象の 3 シナリオが Haiku 4.5 で走り、桁で安くなる
（検出対象は TUI の形であってモデルの賢さではないため、シナリオの妥当性は落ちない）。

---

## 何を assert しているか

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

- ステータス経路 — `detectSessionStatus(生capture, 'claude')`（`worktree-status-helper.ts` と同じく ANSI 付きの生フレームを渡す）
- Auto-Yes 経路 — `detectPrompt(stripBoxDrawing(stripAnsi(生capture)))`（`auto-yes-poller.ts` は status-detector を通さない）

**両方を独立に assert する**のが重要で、「片方だけが見る」プロンプトこそがカナリアの主対象である（#1495 は Auto-Yes 側だけで発火した）。

capture は本番と同じ `capture-pane -p -e -S -1000`、ペインも本番の geometry（`TUI_PANE_WIDTH` × `TUI_PANE_HEIGHT` = 200×1000、
`history-limit` も同値）で作る。#1708 の「上端に picker・下端にタスクパネル・間に約 950 行の空行」というレイアウトは
この geometry でしか再現しない。

---

## 隔離（ここは絶対に緩めないこと）

| 対象 | 方法 | 検証 |
|---|---|---|
| tmux | **すべての呼び出しが `-L cmate-canary-*` を経由**（`buildTmuxArgs()` が強制。socket 名は正規表現で検証） | `tests/unit/canary/canary-isolation.test.ts` |
| `kill-server` | `PrivateTmuxServer.killServer()` からのみ到達可能。素の argv 構築では例外 | 同上 |
| server-global 変更 | `bind-key` / `unbind-key` / `source-file` / `-g` は拒否 | 同上 |
| セッション指定 | 常に完全一致形 `=<name>:` | 同上 |
| HOME | `mkdtemp` した使い捨て HOME（realpath 解決済み）。**tmux サーバ自体の env も差し替える** | セッション作成直後に `show-environment HOME` で**転送されたことを assert** |
| 実 `~/.claude/settings.json` | 触らない | 実行前に sha256 を取り、**各シナリオの前後**と teardown 後に再検証（違反は exit 3） |
| ユーザーの `mcbd-*` セッション | 触らない | 実行前後で一覧を突き合わせ、消滅・出現を検出（違反は exit 3） |

補足:

- `TMUX_TMPDIR` は**隔離手段として使わない**。`$TMUX` が設定されていると無視される。効くのは `-L` / `-S` だけ
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

- **claude 以外のツール（codex / gemini / antigravity / copilot / opencode）は未対応。** Epic #1720 Phase 4 と同時期に追加する
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
