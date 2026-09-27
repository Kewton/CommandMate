# エージェント CLI の日次確認（agent-health）

Claude Code・Codex・Antigravity・OpenCode・Command Code は頻繁に更新され、そのたびに CommandMate との連携
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
| `version` | `<cli> --version`（`claude` / `codex` / `agy` / `opencode` / `commandcode`） | 版が取れる。前回の版は state に残し、`versionChanged` で知らせる |
| `hook-correlation` | CommandMate 自身の起動行（`getAgentEventSource(tool).prepareLaunch(...)` → `renderAgentLaunchCommand`）で `worktreeId: "agent-health-probe"`・`instanceId: "<tool>-probe"` を与えて起動し、下の依頼を送る。hook はスクリプト内の listener が受ける | `session_start`・`user_prompt_submit`・`stop` のうち、そのツールの `capabilities.supportedEvents` にあるものが、両方のキーが上の値のまま届く。別のキーで届いた hook が 1 件でもあれば fail（#2874 の型）。`configScope: 'none'`（opencode）は skip |
| `screen-idle` | 起動（起動時のダイアログを越えた）直後の画面 | `detectSessionStatus` が `ready`、`hasActivePrompt` が偽 |
| `screen-running` | `Run the shell command: sleep 20` を送った直後の画面 | `running`（evidence が `positive`） |
| `screen-approval` | 承認が要る操作で承認ダイアログを出した画面。撮った後は**断る** | `waiting` で `hasActivePrompt` が真。ダイアログを出さないツール（opencode の既定）は skip |
| `screen-quoted-dialog` | そのツールの承認ダイアログの文面を本文で引用させた返答が終わった後の画面 | `ready`、`hasActivePrompt` が偽（#2841〜#2847 の型の回帰） |

画面は本番と同じ形で撮る（200x1000。opencode は 80x200。行数は `resolveCaptureSpec(tool).statusLines`）。

ツールごとの操作（起動時のダイアログの越え方・依頼の文面・断るキー）は `scripts/agent-health/tool-table.ts` の表にある。
要点:

| ツール | 起動行に足すもの | 承認ダイアログの出し方 | 断るキー |
|---|---|---|---|
| claude | `--model haiku --permission-mode manual` | `touch` の依頼 | Esc |
| codex | `-c projects.<作業dir>.trust_level=trusted`（信頼をファイルに書かない）・`-c history.persistence=none`・`-c model_reasoning_effort=low`・`-s read-only -a on-request` | `touch` の依頼 | Esc |
| antigravity | なし | `sleep` の依頼の時点で訊かれる | Esc |
| opencode | なし | 出ない（skip） | — |
| command-code | `--trust --skip-onboarding --no-auto-update`（CommandMate と同じ） | `sleep` の依頼の時点で訊かれる | Esc |

## コマンドライン

```bash
npx tsx scripts/agent-health/run.ts [--tools claude,codex,antigravity,opencode,command-code] \
  [--only <checkId>[,<checkId>]] [--out <file>] [--timeout-per-tool <sec>] \
  [--state <file>] [--server-log <file>]
```

| オプション | 既定 | 説明 |
|---|---|---|
| `--tools` | 5 ツールすべて | 対象ツール |
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
    tool: 'claude' | 'codex' | 'antigravity' | 'opencode' | 'command-code';
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
npx tsx scripts/agent-health/run.ts                         # 5 ツール・全チェック（モデル呼び出しあり）
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

- 確認専用の worktree（`../commandmate-agent-health`、ブランチ `develop` 追従）に `docs/agent-health/CMATE.example.md` の中身を `CMATE.md` として置く。CommandMate の Schedule 機能が毎日 07:00 に Antigravity（`agy -p`）で `docs/agent-health/daily-triage-prompt.md` の手順を実行し、結果を Issue にする
- ラベル `agent-health` を作っておく: `gh label create agent-health --repo Kewton/CommandMate --description "日次ヘルスチェックが自動登録した Issue"`
- Antigravity の Schedule は許可の値が `--dangerously-skip-permissions` しか無い。Command Code は `yolo` でないとコマンドを実行できない（#2454）
- 依頼文は `docs/agent-health/daily-triage-prompt.md`、Issue のひな形は `docs/agent-health/issue-template.md`。変えたいときはリポジトリのこれらの文書を直す（`CMATE.md` の Message 欄は依頼文を読むよう指示するだけ）
- 08:00 に Command Code が今日のレポートの有無を確かめ、無ければ自分で確認を実行する（`docs/agent-health/watch-prompt.md`）
- Command Code の Schedule の許可は `yolo` にすること（それ以外ではコマンドを実行できず、成功のまま何もしない。#2454）
