# 検出カナリア（`npm run canary`）

実 `claude` の TUI を使い捨て tmux セッションで起動し、固定シナリオで得たフレームを
**本番と同じ検出関数**（`detectSessionStatus` / `detectPrompt`）に食わせて期待値を assert する回帰プローブ。

Claude Code の新バージョンが検出層を壊したことを、ユーザー報告ではなく**カナリアで**検知するために存在する
（Issue #1727 / Epic #1720）。hooks 化（#1720）が完了しても scraper はフォールバックとして残るため、本カナリアは恒久的に価値がある。

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
npm run canary                                   # 5 シナリオすべて
npm run canary -- --list                         # シナリオ一覧（意図・期待値・所要時間）
npm run canary -- --only model-overlay,idle      # 一部だけ実行
npm run canary -- --skip generating              # 一部だけ除外
npm run canary -- --json                         # 機械可読サマリ
npm run canary -- --keep                         # 使い捨て HOME と tmux セッションを残す（デバッグ用）
npm run canary -- --mutate                       # ハーネス自体の非空振り自己テスト（後述）
CM_CANARY_MODEL=haiku npm run canary             # 課金を抑える（後述）
```

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

---

## 既知の限界

- **claude 以外のツール（codex / gemini / antigravity / copilot / opencode）は未対応。** Epic #1720 Phase 4 と同時期に追加する
- **#1708 の「Ready to submit your answers?」確認画面は対象外。** これは picker と違いフッターを持たず、
  現行コードでは**既知の未修正欠陥**（Issue #1708 で追跡中）。既知バグを緑の期待値としてハーネスに固定すると
  カナリアが恒常的に赤になり signal として死ぬため、シナリオ 3 は「picker ＋ タスクパネル併存」（#807 のガードが効く形）を対象にしている。
  #1708 が修正されたら、確認画面を 6 番目のシナリオとして追加すること
- シナリオ 3 は Claude の `TaskCreate` ツールに依存する。ツール名が変わるとタスクパネルが描画されず、
  「併存を再現できなかった」として赤になる（これは意図した挙動: 弱いプローブが緑の顔をするより良い）

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
