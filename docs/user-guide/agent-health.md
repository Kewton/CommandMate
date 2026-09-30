# エージェント CLI の日次確認（agent-health）

Claude Code・Codex・Antigravity・OpenCode・Command Code・OpenCode V2 は頻繁に更新され、そのたびに CommandMate との連携
（画面の判定・hook の宛先）が壊れることがある（例: #2842 の codex の画面判定、#2874／#2891 の codex 共有デーモンによる
hook のインスタンス取り違え）。`scripts/agent-health/run.ts` は、これを **AI を使わず決まった手順で** 確かめ、
結果を JSON に書くスクリプトである（Issue #2878）。

- Issue を立てるのはこのスクリプトではない。レポートを読んで Issue にするのは Schedule で動く AI（#2879）、
  レポートが今日出ているかを見張るのは #2880 の役目。
- 実エージェントを起動し、1 ツールあたり最大 3 回モデルを呼ぶ（費用がかかる）。

## 何を確かめるか

ツールごとに次のチェックを行う。`version` は常に行い、失敗したらそのツールの残りは `skip` になる。

| checkId | 内容 | 合格の条件 |
|---|---|---|
| `version` | `<cli> --version`（`claude` / `codex` / `agy` / `opencode` / `commandcode` / `opencode2`） | 版が取れる。前回の版は state に残し、`versionChanged` で知らせる |
| `hook-correlation` | CommandMate 自身の起動行（`getAgentEventSource(tool).prepareLaunch(...)` → `renderAgentLaunchCommand`）で `worktreeId: "agent-health-probe"`・`instanceId: "<tool>-probe"` を与えて起動し、下の依頼を送る。hook はスクリプト内の listener が受ける | `session_start`・`user_prompt_submit`・`stop` のうち、そのツールの `capabilities.supportedEvents` にあるものが、両方のキーが上の値のまま届く。別のキーで届いた hook が 1 件でもあれば fail（#2874 の型）。`configScope: 'none'`（opencode）は skip。**opencode-v2 は hook を使わないため、代わりに自前 serve の SSE を確かめる**（下記） |
| `screen-idle` | 起動（起動時のダイアログを越えた）直後の画面 | `detectSessionStatus` が `ready`、`hasActivePrompt` が偽 |
| `screen-running` | `Run the shell command: sleep 20` を送った直後の画面 | `running`（evidence が `positive`） |
| `screen-approval` | 承認が要る操作で承認ダイアログを出した画面。撮った後は**断る** | `waiting` で `hasActivePrompt` が真。ダイアログを出さないツール（opencode の既定）は skip |
| `screen-quoted-dialog` | そのツールの承認ダイアログの文面を本文で引用させた返答が終わった後の画面 | `ready`、`hasActivePrompt` が偽（#2841〜#2847 の型の回帰） |

画面は本番と同じ形で撮る（200x1000。opencode・opencode-v2 は 80x200。行数は `resolveCaptureSpec(tool).statusLines`）。

### opencode-v2 の起動と SSE（Issue #2937）

OpenCode V2 は本番では `scripts/opencode-v2/launch.sh` が `opencode2 serve`（インスタンス専用のポートとパスワード）と
TUI を 1 つのペインで動かす。確認も同じ経路で起動する。

- `reserveOpencodeV2Server()` でポートとパスワードを用意してから `prepareLaunch` を呼び、起動行が `launch.sh` を
  通ることを確かめる。`--standalone` に落ちたら（本番と違う経路なので）起動せず、`version` 以外の check を fail にする
- パスワードとポートの記録は実行の一時ディレクトリの下（`CM_OPENCODE_V2_DIR`）。利用者の `~/.commandmate/opencode-v2/` には書かない
- TUI の状態（入力履歴・モデルの選択など。利用者の背景サービスの `service.json` と同じ `~/.local/state/opencode/`）は、
  起動行の前に `XDG_STATE_HOME=<一時ディレクトリ>` を付けて一時ディレクトリへ向ける
- `hook-correlation` の枠では、自前 serve の `/api/event` を本番のクライアント（`opencode-v2/client.ts`）で購読し、
  `sleep 20` のターンの間に `session.execution.started` と `session.execution.succeeded` が届けば pass。
  受け取った `type` の一覧（重複除去）を summary に残す（イベント名が変わったときに何に変わったかが読める）
- セッションを止めた後、serve のプロセスとポートが残っていたら `hook-correlation` を fail にする（#1905 の型。残った serve は止める）

ツールごとの操作（起動時のダイアログの越え方・依頼の文面・断るキー）は `scripts/agent-health/tool-table.ts` の表にある。
要点:

| ツール | 起動行に足すもの | 承認ダイアログの出し方 | 断るキー |
|---|---|---|---|
| claude | `--model haiku --permission-mode manual` | `touch` の依頼 | Esc |
| codex | `-c projects.<作業dir>.trust_level=trusted`（信頼をファイルに書かない）・`-c history.persistence=none`・`-c check_for_update_on_startup=false`（起動時の更新ダイアログを出さず、利用者の `version.json` も取り直さない。出たときは `2. Skip`、#3020）・`-c model_reasoning_effort=low`・`-s read-only -a on-request` | `touch` の依頼 | Esc |
| antigravity | なし | `sleep` の依頼の時点で訊かれる | Esc |
| opencode | なし（前に `XDG_STATE_HOME=<一時ディレクトリ>`。利用者の `opencode/model.json` だけを読み取り専用で複製してモデル選択を引き継ぐ、#3021） | 出ない（skip） | — |
| command-code | `--trust --skip-onboarding --no-auto-update`（CommandMate と同じ） | `sleep` の依頼の時点で訊かれる | Esc |
| opencode-v2 | なし（前に `XDG_STATE_HOME=<一時ディレクトリ>`） | 出ない（skip。既定のルールで `shell` は確認なしに走る） | — |

## コマンドライン

```bash
npx tsx scripts/agent-health/run.ts [--tools claude,codex,antigravity,opencode,command-code,opencode-v2] \
  [--only <checkId>[,<checkId>]] [--out <file>] [--timeout-per-tool <sec>] \
  [--state <file>] [--server-log <file>]
```

| オプション | 既定 | 説明 |
|---|---|---|
| `--tools` | 6 ツールすべて | 対象ツール |
| `--only` | 全チェック | 行うチェック（`version` は常に行う） |
| `--out` | `~/.commandmate/agent-health/reports/<YYYY-MM-DD>.json`（JST の日付） | レポートの書き出し先 |
| `--timeout-per-tool` | 150 | 1 ツールの持ち時間（秒）。時間切れのチェックは fail |
| `--state` | `~/.commandmate/agent-health/state.json` | 前回の版の置き場所（`{ "versions": { "<tool>": "<版>" } }`）。実行の最後に更新する |
| `--server-log` | main worktree の `logs/server.log` | 本番サーバのログ（hook の漏れを数える） |

全体は 12 分を超えない（Schedule の 1 回の実行は 15 分で打ち切られるため）。持ち時間が尽きたら、残りのツールは
`version` だけ読んで他を skip にする。

終了コード:

| exit | 意味 |
|---|---|
| `0` | すべて pass / skip |
| `1` | fail が 1 つ以上 |
| `2` | スクリプト自体の異常（引数の誤り・書き込み失敗・hook 設定を戻せなかった・別の実行が進行中・中断） |

どの場合もレポートは書く（2 の場合も書ける範囲で書く。書けなければ標準出力に出す）。

## レポートの形

子 Issue #2879 の AI はこれだけを読む。フィールドの追加はよいが、名前の変更・削除は #2879 と #2880 を壊す。

```ts
interface AgentHealthReport {
  schemaVersion: 1;
  startedAt: string;          // ISO
  completedAt: string;        // ISO。#2880 はこの有無で「今日の結果がある」を判断する
  host: { commandmateCommit: string; node: string };
  tools: Array<{
    tool: 'claude' | 'codex' | 'antigravity' | 'opencode' | 'command-code' | 'opencode-v2';
    version: string | null;         // `<cli> --version` の 1 行目
    previousVersion: string | null; // 前回（state）の値
    versionChanged: boolean;        // 両方が分かっていて違うときだけ true
    checks: Array<{
      checkId: string;
      status: 'pass' | 'fail' | 'skip';
      summary: string;              // 1 行。何を期待し何が起きたか
      evidence?: string;            // 失敗時の証拠（画面の末尾 40 行、届いた hook）。4,000 文字まで
      skipReason?: string;
    }>;
  }>;
  safety: {
    globalConfigRestored: Array<{
      path: string;
      restored: boolean;
      kind?: 'hook-config' | 'trust-state';
      detail?: string;              // restored が偽の理由
    }>;
    tmuxSocket: string;             // "cm-agent-health"
    productionLog?: { path: string | null; linesAtStart: number | null; linesAtEnd: number | null; probeLines: number };
  };
  scriptErrors?: string[];          // exit 2 のときの理由
  sync?: { status: 'ok' | 'failed'; before: string; after: string; reason?: string }; // daily.sh 経由のときだけ
}
```

型は `src/lib/agent-health/types.ts`。

## 安全上の不変条件

1. **本番の tmux サーバに触れない。** tmux はすべて `-L cm-agent-health` で呼ぶ（`src/lib/agent-health/tmux-command.ts`
   が argv を組み立て、ユニットテストで固定）。子プロセスの環境から `TMUX` と、実行元から受け継いだ `CM_*`・
   `CLAUDE*`・`CODEX_*`（`CODEX_HOME` を除く）を消す。終了時（例外・SIGINT/SIGTERM でも）に私設サーバを止め、
   そのソケットファイルを消す。
2. **作業ディレクトリは一時ディレクトリ。** `os.tmpdir()` 配下に `cm-agent-health-XXXXXX` を作り、ツールごとに
   `git init` した空リポジトリで起動する。終了時に丸ごと消す。claude の `--settings` ファイルもこの中に書く
   （`CM_AGENT_HOOKS_DIR`）。
3. **マシンに 1 つしかない hook 設定を残さない。** `prepareLaunch` の前に次のファイルの中身を保存し、そのツールの
   セッションを止めた直後に書き戻して sha256 で一致を確かめる。戻せなければ exit 2。
   - codex: `$CODEX_HOME/hooks.json`、`$CODEX_HOME/commandmate/cmate-agent-event.sh`（relay の配置先）
   - antigravity: `~/.gemini/config/hooks.json`

   CLI 自身がフォルダの信頼を書き込むファイル（antigravity の `~/.gemini/antigravity-cli/settings.json`、
   command-code の `~/.commandcode/trusted-hooks.json`、codex の `config.toml`）も保存し、**差分がこの実行の
   一時ディレクトリの記述だけのときに限り**書き戻す（`kind: 'trust-state'`）。ほかの変更が混ざっていたら
   触らずに `restored: false` と書く（利用者の変更を消さないため。exit 2 にはしない）。
4. **hook を本番へ飛ばさない。** hook の送り先は `CM_PORT`（claude・antigravity・command-code の URL の
   ポート）と起動行の `CM_HOOK_URL` / `CM_PERMISSION_HOOK_URL`（codex）でスクリプト内の listener
   （`127.0.0.1` の空きポート）に向ける。tmux サーバの環境にも listener の `CM_HOOK_URL` を置くので、
   相関キー無しの既定 URL に落ちた hook も本番ではなく listener に届き、`hook-correlation` の fail になる。
   各ツールの前後で本番ログ（`logs/server.log`）の追記分を読み、`agent-health-probe` を含む行があれば
   そのツールの `hook-correlation` を fail にする。
5. **worktree の外の既存ファイルを消さない・書き換えない**（3 の書き戻しを除く）。ただし各 CLI が自分で書く
   状態（claude の `~/.claude.json` のプロジェクト項目、各 CLI のセッション記録・履歴）は CLI の通常の動作として
   残る。

同時に 2 つ走らないよう、state と同じディレクトリに `run.lock`（pid）を置く。

## 手で実行する

```bash
cd <CommandMate のチェックアウト>
npx tsx scripts/agent-health/run.ts                         # 6 ツール・全チェック（モデル呼び出しあり）
npx tsx scripts/agent-health/run.ts --only screen-idle      # 起動画面だけ（モデル呼び出しなし）
npx tsx scripts/agent-health/run.ts --tools codex --out /tmp/agent-health-codex.json
```

進み具合は標準エラーに `[agent-health] …` で出る。途中で止めたいときは Ctrl-C（後始末をしてから exit 2）。

私設 tmux サーバが残っていないことは次で確かめられる（`no server running` なら片付いている）:

```bash
tmux -L cm-agent-health ls
```

万一残っていたら、ソケットを指定して止める:

```bash
tmux -L cm-agent-health kill-server
```

## 関連

- 実装: `scripts/agent-health/`（実行）、`src/lib/agent-health/`（純粋関数とレポートの型）
- テスト: `tests/unit/lib/agent-health/`、`tests/unit/scripts/agent-health/`
- codex の画面判定を手で確かめる手順: [docs/design/codex-detection-corpus.md](../design/codex-detection-corpus.md)
- 検出カナリア（claude / opencode のより細かいシナリオ）: `scripts/canary/`

## 毎日の自動実行（Schedule）

- 確認専用の worktree（`../commandmate-agent-health`）に `docs/agent-health/CMATE.example.md` の中身を `CMATE.md` として置く。CommandMate の Schedule 機能が毎日 07:00 に Antigravity（`agy -p`）で `docs/agent-health/daily-triage-prompt.md` の手順を実行し、結果を Issue にする
- この worktree は常駐用で、ブランチ `agent-health-runner`（upstream は `origin/develop`。独自の commit は持たない）を使う。develop は本体の作業ディレクトリで使っているため同じブランチは使えない。作り方: `git worktree add -b agent-health-runner ../commandmate-agent-health origin/develop` のあと `git -C ../commandmate-agent-health branch --set-upstream-to=origin/develop`、`npm install --include=dev`、リポジトリの同期
- 依頼文は `bash scripts/agent-health/daily.sh --out <レポート>` を呼ぶだけ。`daily.sh` が同期（`git pull --ff-only origin develop`）・依存の更新（同期の前後で `package-lock.json` が変わったときだけ `npm install --include=dev`）・`run.ts` の実行をまとめて行い、標準出力に `AGENT_HEALTH_SYNC status=ok|failed …` を 1 行出す
- 同期に失敗すると（追跡ファイルの未コミットの変更 `dirty-worktree`・`pull-failed: <git の最後の行>`・`npm-install-failed`）確認を実行せず、`completedAt` と `scriptErrors` を持ち `tools` が空の最小のレポートを書いて exit 2 になる（08:00 の見張り役が「実行されなかった」と取り違えないため）
- レポートの `sync`（`daily.sh` 経由のときだけ）: `status`（`ok` / `failed`）、`before` / `after`（同期の前後の commit。失敗時は両方とも前の commit）、`reason`（失敗の理由）。`run.ts` を手で実行したときは `sync` は無い
- **worktree の片付けで削除しない**（CLAUDE.md の「恒久 worktree（クリーンアップ対象外）」）。消すと翌朝の Schedule が動かない
- ラベル `agent-health` を作っておく: `gh label create agent-health --repo Kewton/CommandMate --description "日次ヘルスチェックが自動登録した Issue"`
- Antigravity の Schedule は許可の値が `--dangerously-skip-permissions` しか無い。Command Code は `yolo` でないとコマンドを実行できない（#2454）
- 依頼文は `docs/agent-health/daily-triage-prompt.md`、Issue のひな形は `docs/agent-health/issue-template.md`。変えたいときはリポジトリのこれらの文書を直す（`CMATE.md` の Message 欄は依頼文を読むよう指示するだけ）
- 08:00 に Command Code が今日のレポートの有無を確かめ、無ければ自分で確認を実行する（`docs/agent-health/watch-prompt.md`）
- Command Code の Schedule の許可は `yolo` にすること（それ以外ではコマンドを実行できず、成功のまま何もしない。#2454）

## メトリクス計測（セキュリティ・保守性、Issue #3044）

日次確認の前（06:30）に、セキュリティ脆弱性とソフトウェア保守性の指標を **AI を使わず** 計測し、JSON に書く。
起票するのは Schedule で動く AI（`docs/agent-health/metrics-prompt.md`）で、スクリプトは Issue を立てない。

- 計測: `scripts/agent-health/metrics.ts`（外部ツールの呼び出しは `metrics-runners.ts`）。判定は純粋関数
  `src/lib/agent-health/metrics-parse.ts`（ツールの出力 → 計測値）・`metrics-rules.ts`（前回比・候補・並び・exit code）、
  型は `metrics-types.ts`（閾値の定数もここ）
- 入口: `bash scripts/agent-health/metrics.sh --out <file>`。`daily.sh --sync-only` で同期してから `metrics.ts` を実行する。
  同期に失敗したら計測せず、`completedAt` と `scriptErrors` を持ち `metrics` が空の最小の JSON を書いて exit 2
  （同期側の最小レポートは一時ディレクトリに書き、その日の agent-health レポートを上書きしない）

### 何を計測するか

| 分類 | metricId | 計測 | `value` | 候補になる条件（定数） |
|---|---|---|---|---|
| security | `npm-audit` | `npm audit --omit=dev --json`（registry 不達は `scripts/check-npm-audit.mjs` と同じ形で見分けて skip） | high 以上の advisory 件数 | advisory の検出はひとつずつ、候補は**パッケージ単位**（1 回の版上げで全部直るため）。前回に無い advisory を持つパッケージ。証拠に目標の版・修正版の有無・メジャー更新の要否 |
| security | `semgrep` | `semgrep scan --config p/typescript --config p/nodejs --json src`（ルール取得にネットワークが要る。取れなければ skip） | ERROR 件数 | 前回に無い ERROR（ルール × ファイル） |
| security | `secrets` | `gitleaks detect --redact`（未インストールなら skip） | 検出件数 | 前回に無い検出（fingerprint）。1 件でもあれば fail |
| maintainability | `file-size` | `src/` の行数（`wc -l` と同じ数え方） | 1,500 行超の本数 | 新たに 1,500 行を超えた／500 行以上のファイルが前回比 +200 行以上 |
| maintainability | `complexity` | ESLint `complexity`（閾値 10）だけを、リポジトリの設定を使わず報告専用で実行 | 複雑度 25 以上の関数の数 | ファイル内最大の複雑度が新たに 25 以上／25 以上で前回比 +5 以上 |
| maintainability | `duplication` | `npx jscpd@4 src`（最小 10 行） | 重複率（%） | 前回比 +0.5pt 以上 |
| maintainability | `unused` | `npx knip@5 --reporter json` | 未使用の依存の数 | 前回に無い未使用の依存（未使用 export は件数だけ記録） |
| maintainability | `outdated` | `npm outdated --json`（直接依存だけ） | メジャー 2 版以上遅れた数 | 新たにメジャー 2 版以上遅れた |
| maintainability | `type-safety` | `src/` の型位置の `any`・`eslint-disable`・`@ts-ignore` の数 | 合計 | どれかが前回より増えた |
| maintainability | `coverage` | `vitest run tests/unit --coverage`（**月曜（JST）だけ**） | 行カバレッジ（%） | 前回（前週）比 -2pt 以上 |

- **「新たに閾値を超えた」「前回より悪化した」だけが候補**（`candidates`）。前から超えているもの（1,500 行超の 14 本、
  複雑度 25 以上の 83 関数など）は起票せず、`value` と `details` の件数として残す
- 前回値が無い指標（初回・前回が skip のまま）は基準として記録するだけで、候補を出さない
- security の検出が続いている間は `status: 'fail'`。前からあるものは `outstanding` に入り、AI はその日の起票枠（2 件）に
  余りがあるときだけ、まだ Issue の無いものを立てる（初日に見送った advisory も翌日以降に回る）
- 外部ツールが無い・失敗した・時間切れの指標は `status: 'skip'`（`skipReason` に理由）。skip した指標の前回値は
  state に残り、次の実行はそれと比べる
- 全体は **10 分以内**（3 並列、ツールごとの上限あり。上限に達したものは skip）。2026-10-01 の実測（カバレッジなし）:
  54 秒・149 秒・140 秒（semgrep が最も長く 54〜140 秒）

### 使い方

```bash
npx tsx scripts/agent-health/metrics.ts --out /tmp/metrics.json            # 計測だけ（同期しない）
npx tsx scripts/agent-health/metrics.ts --only npm-audit,file-size --state /tmp/metrics-state.json
bash scripts/agent-health/metrics.sh --out "$HOME/.commandmate/agent-health/metrics/$(TZ=Asia/Tokyo date +%F).json"
```

| オプション | 既定 | 説明 |
|---|---|---|
| `--out` | `~/.commandmate/agent-health/metrics/<YYYY-MM-DD>.json`（JST） | 計測結果の書き出し先 |
| `--state` | `~/.commandmate/agent-health/metrics-state.json` | 前回値（`{ schemaVersion: 1, metrics: { <metricId>: { measuredAt, value, items } } }`）。実行の最後に更新する |
| `--only` | 全指標 | 計測する指標（カンマ区切り） |
| `--coverage` / `--no-coverage` | 月曜（JST）だけ | カバレッジを強制する／しない |

終了コード: `0` fail なし、`1` fail の指標あり、`2` スクリプト自体の異常（引数の誤り・同期の失敗・別の計測が進行中・
書き込み失敗）。同時に 2 つ走らないよう、state と同じディレクトリに `metrics.lock`（pid）を置く。
ツールの一時ファイル（jscpd・gitleaks・カバレッジのレポート、semgrep の設定とログ）は `os.tmpdir()` 配下の
`cm-agent-health-metrics-XXXXXX` に書き、終了時に消す。

### 計測 JSON の形

#3045（依頼）と #3046（HTML）が読む。フィールドの追加はよいが、名前の変更・削除はそれらを壊す。

```ts
interface MetricsReport {
  schemaVersion: 1;
  startedAt: string;               // ISO
  completedAt: string;             // ISO
  metrics: Array<{                 // metricId の順（上の表の順）
    metricId: 'npm-audit' | 'semgrep' | 'secrets' | 'file-size' | 'complexity'
      | 'duplication' | 'unused' | 'outdated' | 'type-safety' | 'coverage';
    category: 'security' | 'maintainability';
    status: 'pass' | 'fail' | 'skip';
    value: number | null;          // skip のとき null
    summary: string;
    candidates: Array<{
      key: string;                 // `metrics:<metricId>:<対象>`。Issue 本文の先頭 `<!-- key -->`
      title: string;
      severity?: string;           // security のとき（critical / high）
      evidence?: string;           // 何を測ったか・何で直るか
      delta?: number;              // 前回からの悪化量（指標の単位）
      score?: number;              // 保守性の並び順の重み（悪化量 ÷ 閾値）
    }>;
    outstanding?: Array<同上>;     // security: 前から続いている検出
    skipReason?: string;
    details?: Record<string, number | string>; // 起票しない件数（500 行超の本数など）
  }>;
  queue: Array<{ key: string; metricId: string; source: 'candidate' | 'outstanding' }>; // 起票する順
  host: { commandmateCommit: string; node: string };
  scriptErrors?: string[];         // exit 2 の理由
}
```

### 毎日の自動実行（Schedule）

- 日次確認と同じ worktree（`../commandmate-agent-health`）の `CMATE.md` に、`docs/agent-health/CMATE.example.md` の
  `agent-health-metrics` 行（`30 6 * * *`・command-code・`yolo`）を加える。計測（最大 10 分）と起票は 07:00 の
  日次確認より前に終わる
- 依頼文 `docs/agent-health/metrics-prompt.md`、Issue のひな形 `docs/agent-health/metrics-issue-template.md`。
  識別子 `metrics:<metricId>:<対象>` で open の Issue を探し、あれば（その日の新規・悪化のときだけ）コメント、
  無ければ起票する。**新規起票は 1 日 2 件まで**（`queue` の順: security の新規 → 悪化幅の大きい保守性 → 続いている security）
- ラベル `metrics`・`enhancement`（security は `security` も）を使う。無ければ作る:
  `gh label create metrics --repo Kewton/CommandMate --description "日次メトリクス計測が自動登録した改善 Issue"`
  （`security`・`enhancement` も同様。依頼文の手順 2 でも確かめる）
- 最後の 1 行: `AGENT_HEALTH_METRICS date=… issues_created=… issues_commented=… skipped=… exit=…`
- `gitleaks` と `semgrep` は無ければ skip になる（`brew install gitleaks semgrep`）。`jscpd`・`knip` は `npx` で取得する

## リリース判断レポート

`scripts/agent-health/release-report.ts` は、その日に自動依頼した orchestrate の結果と develop の状態を集め、
リリースの **GO／要判断／NO-GO** を判断するための HTML を 1 ファイル書く（Issue #3046）。
事実はスクリプトが集め、判定はルールで機械的に決める。AI の所見は載せるだけで判定には使わない。

```bash
npx tsx scripts/agent-health/release-report.ts --date 2026-10-01
# → <main worktree>/workspace/agent-health/2026-10-01/release-readiness.html（git の管理外）
npx tsx scripts/agent-health/release-report.ts --date 2026-10-01 --findings <所見.md> --out /tmp/rr.html
```

| オプション | 既定 |
|---|---|
| `--date <YYYY-MM-DD>` | 今日（JST） |
| `--out <file>` | `<main worktree>/workspace/agent-health/<date>/release-readiness.html` |
| `--state-dir <dir>` | `$AGENT_HEALTH_DIR` か `~/.commandmate/agent-health`（`dispatch/`・`metrics/`・`reports/` を読む） |
| `--runs-dir <dir>` | `<main worktree>/workspace/orchestration/runs` |
| `--findings <file>` | なし。AI の所見の Markdown を「AI の所見」節に載せる |
| `--repo <owner/name>` | `Kewton/CommandMate` |
| `--no-gh` | gh を呼ばない（CI・PR・Issue は「取得できず」） |
| `--no-audit` | 今日の計測に `npm-audit` が無いときの `npm audit --omit=dev` の実行をしない |

標準出力に `RELEASE_READINESS date=<日付> verdict=go|hold|no-go dispatched=<件数> out=<パス>` を 1 行出す。
HTML を書けたら判定にかかわらず exit 0、引数の誤りやスクリプトの異常は exit 2。

### 読むもの（すべて読むだけ。無い・壊れているときは「無し」「取得できず」として続ける）

- 依頼の記録 `~/.commandmate/agent-health/dispatch/<date>.json`（#3045 が書く。型は `src/lib/agent-health/dispatch-record.ts`）。
  無ければ「依頼なし」
- 計測 `~/.commandmate/agent-health/metrics/<date>.json`（#3044 が書く）。前日比は `<date>` より前で最も新しいファイル、
  前回リリース比は前回リリースタグの日（JST）以前で最も新しいファイルと比べる
- agent-health のレポート `~/.commandmate/agent-health/reports/`（`<date>` 以降。retry の結果も含む）
- orchestrate の `runs/<date>/` の `tasks*.tsv`（担当エージェント）・`wait-*<Issue>[-rN].log`（verify の exit。最後の試行）・
  `summary*.md`（所見の欄に折りたたんで載せる）
- git: `origin/develop`（無ければ `HEAD`）、`git describe --tags --abbrev=0`、タグからのコミット数
  （`--ancestry-path`。リリースの back-merge 以降に develop へ入ったもの）、develop の `changelog.d/` の断片。fetch はしない
- gh: develop HEAD の workflow run、直近 14 日に更新された PR（チェックは表に出す PR だけ個別に取る）、
  open な `agent-health`／`metrics` Issue、dispatch したバグ Issue の本文（識別子 `agent-health:<tool>:<checkId>`）

### 判定のルール（`src/lib/agent-health/release-readiness.ts` の `decideReadiness`）

- **NO-GO**: develop HEAD の CI が赤／本日（JST）develop にマージされた PR にチェックが緑でないもの（実行中・チェックなしを含む）がある／
  `npm audit --omit=dev` の high 以上の advisory 数が前回リリース時より増えた／dispatch したバグ Issue の修正のマージ後に走った
  agent-health で、その識別子のチェックがまだ `fail`
- **要判断**: dispatch した Issue に未完了（PR 未作成・未マージ・verify 不合格）がある／持ち越しがある／
  develop HEAD の CI が実行中または取得できない／本日マージされた PR の一覧を取得できない
- **GO**: 上のどれにも当たらない

判定の理由はどの判定でも箇条書きで出す。判定に影響しない事実（前回リリース時の audit 値が無い、マージ後の agent-health が
まだ走っていない修正など）は「参考」に出す。次の一手は GO なら `/release`、NO-GO なら直すもの、要判断なら決めること。

orchestrate が途中で止まった日でも、手で実行すればその時点の状態で HTML が出る。
