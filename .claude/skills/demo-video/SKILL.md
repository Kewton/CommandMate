---
name: demo-video
description: CommandMate の 30 秒デモ動画（日本語版・英語版）を隔離環境で全自動生成する。絵コンテ駆動のシーン録画・テロップ焼き込み・ffmpeg 合成・尺検証まで。「デモ動画」「demo video」「デモを録画」等の指示で使う。
allowed-tools: Bash(.claude/skills/demo-video/scripts/*), Bash(.agents/skills/demo-video/scripts/*), Bash(npx tsx *), Bash(tmux *), Bash(ffprobe *), Bash(ffmpeg *), Read
---

# demo-video

CommandMate の 30 秒デモ動画を全自動生成する。`demo-video.sh` 一発で `demo-30s.ja.mp4` と `demo-30s.en.mp4` が出る。

```bash
export HOME=/Users/Shared/cmdemo-home                      # 必須。実ログイン HOME では env-up.sh が exit 2 で止まる（後述）
.claude/skills/demo-video/scripts/demo-video.sh            # ja + en
.claude/skills/demo-video/scripts/demo-video.sh --check    # 依存＋絵コンテ検証だけ
.claude/skills/demo-video/scripts/demo-video.sh --locale ja --gif --out ~/Desktop/cm-demo
.claude/skills/demo-video/scripts/demo-video.sh --storyboard readme-hero --gif   # README 冒頭の 30 秒（#2381）
.claude/skills/demo-video/scripts/demo-video.sh --claude-cassette .claude/skills/demo-video/fixtures/claude-delegate.cast   # 委任往復だけの take
```

出力先の既定は `~/Desktop/commandmate-demo/`。**リポジトリ外**である。mp4 / GIF / 中間 PNG は**コミットしない**（配布は GitHub Release アセット等）。生成後に `git status` がクリーンであることが受入条件のひとつ。

### 絵コンテ一覧

| `--storyboard` | 出力 | 中身 | claude ペインのカセット |
|---|---|---|---|
| `default`（既定） | `demo-30s.{ja,en}.mp4` | 一覧 → 送信 → スマホ承認 → 完了（#1554） | `claude-session-sample.cast` |
| `contract-verify` | `contract-verify.{ja,en}.mp4` | 契約 → 検証の 30 秒。code card 2 枚 + ターミナル収録（#1810） | 同上 |
| `readme-hero` | `demo-hero.{ja,en}.mp4` + `.gif` | README 冒頭の 30 秒。タブ帯 → 5 エージェント → チャット面で委任 → 返答のリンク → スマホで承認とファイル（#2381） | `claude-hero.cast`（絵コンテが `claude-cassette:` で宣言） |

`--storyboard` は YAML のパスか、`storyboard/` にある stem。絵コンテが `claude-cassette:` を持てばそのカセットで claude ペインを起こし（`--claude-cassette` で上書き可）、`gif:` を持てば `--gif` の幅 / fps / バイト予算はそこから読む。

### README 撮影の env（#2381）

```bash
export HOME=/Users/Shared/cmdemo-home                                    # 実 HOME だと env-up.sh が exit 2。転写は $HOME 配下に置かれる
export PLAYWRIGHT_BROWSERS_PATH=/Users/<real>/Library/Caches/ms-playwright  # HOME を動かすと chromium が見つからない
export CM_DEMO_PORT=3481                                                 # 3000 は 3 箇所で拒否
export CM_DEMO_TMUX_SOCKET=cmdemo2381                                    # ターミナル収録の tmux -L（この絵コンテは使わないが習慣として）
unset TMUX
.claude/skills/demo-video/scripts/demo-video.sh --storyboard readme-hero --gif --out ~/Desktop/commandmate-demo/readme-hero
```

偽エージェントの tmux セッション（`mcbd-<tool>-wt-dark-mode`）は既定サーバに立つ。サーバも `tmux` を素で呼ぶので同じサーバでないと採用されない。後片付けは `env-down.sh` が**記録した名前だけ**を kill する。

## 設計判断

**実 LLM は使わない。** 実セッションは非決定的で、生成に数分かかり 30 秒に収まらない。代わりにキャプチャ済み ANSI 出力をタイミング付きで再生する「偽エージェント」を tmux セッションで動かす。

置き換えるのは **LLM だけ**で、モックは 1 つも入れていない。CommandMate から見た入力は tmux pane の中身だけなので、`status-detector.ts` / response poller / サイドバーの状態ドットはすべて製品コードのまま動く。偽エージェントが差し込まれるのは `tmux capture-pane` が返すバイト列の出所だけである。

**チャット面の Markdown は偽転写で出す（Issue #2380）。** チャット面の assistant 行を Markdown（`[Header.tsx](src/…)` の `ChatFileLink`、ツール呼び出しのチップ）として描くのは転写リーダー（`src/lib/hooks/sources/{claude,codex}/history.ts`）であって、ペインのスクレイプではない。転写が無いツールはスクレイプに落ちて**生テキスト**になる。そこで `env-up.sh` が隔離 `$HOME` の `~/.claude/projects/<slug>/<id>.jsonl` と `~/.codex/sessions/<日付>/rollout-…-<id>.jsonl` に**骨格**（ファイルと codex の `session_meta`）を置き、実 CLI と同じ `SessionStart` フックで session id をサーバに告げる。ターン本体はカセットの `@transcript` 行が**再生時刻で**追記する（リーダーは転写のタイムスタンプ ±2 分で `/send` 行を引き取るので、起動時に書いた転写では返答が質問の上に並ぶ）。DB を直接 seed しないのは、製品コードがそのまま動くことを保証するため。

**テロップは HTML → PNG → ffmpeg overlay** で焼き込む。`drawtext` は日本語に `fontfile` の明示が要り、`:` や `'` のエスケープ規則のせいで絵コンテの文字列をそのまま渡せない。HTML なら意匠が CSS 1 箇所に集約でき、文字列は `textContent` で入るので絵コンテがマークアップを注入することもない。

**ロケールはフル録画方式。** `--locale ja` はアプリ UI ごと日本語にして撮り直す。テロップだけ差し替えると、画面は英語・字幕は日本語という動画になる。日英の文言は絵コンテに**直書き**で、生成時に機械翻訳はしない（人間がレビューできない文字列を画面に出さないため）。

## 構成

```
demo-video/
├── SKILL.md
├── scripts/
│   ├── demo-video.sh       # パイプライン全体（依存確認 → ロケールごとに録画 → 合成 → 尺検証）
│   ├── env-up.sh           # 隔離デモ環境の起動（seed repo 生成 → サーバ起動 → Ready 確認）
│   ├── env-down.sh         # 停止・後片付け（PID 経由の kill のみ。pkill は使わない）
│   ├── fake-agent.sh       # カセット再生（tmux セッション作成も担当）
│   ├── cli-scene.sh        # contract-verify の中身（隔離 CLI で実ゲートを回す）
│   ├── record-scenes.ts    # Playwright をライブラリとして使うシーン録画
│   ├── terminal-scene.ts   # tmux pane の収録（ANSI→HTML→PNG→webm）
│   ├── stills.ts           # LP / README 用の静止画 5 点（予算ゲートつき）
│   ├── storyboard.ts       # 絵コンテの検証と尺の機械算出（YAML サブセット）
│   ├── render-overlays.ts  # テロップ／カード／コードカードを HTML から PNG 化
│   └── compose.sh          # ffmpeg 合成 + 尺検証ゲート
├── storyboard/
│   ├── default.yaml        # 文言を編集する唯一の場所
│   ├── contract-verify.yaml # 契約 → 検証の 30 秒（code card + terminal シーン）
│   ├── readme-hero.yaml    # README 冒頭の 30 秒（#2381。claude-cassette / gif / head / telop.position を使う）
│   └── code/               # code card が読む実ファイル（絵コンテの配下に閉じる）
├── templates/
│   ├── telop.html          # 画面下部のテロップ帯（透過 PNG）
│   ├── card.html           # タイトル／アウトロカード（不透過 PNG）
│   ├── code-card.html      # code card（等幅・行番号つき。card.html と同じ地色）
│   └── terminal.html       # tmux pane の組版（常時ダーク）
└── fixtures/
    ├── claude-session-sample.cast   # 採取済みカセット（テキスト。コミット可）。既定絵コンテの claude ペイン
    ├── claude-delegate.cast         # 委任する側の Claude（`@exec` で commandmate ask を本当に打つ）
    ├── claude-hero.cast             # claude-delegate の 1 パス目 + `@pass` + 承認の 2 パス目（readme-hero 用）
    ├── codex-review.cast            # 頼まれる側の Codex（Markdown の返答、Header.tsx へのリンク）
    ├── antigravity-idle.cast        # present-only 3 体の起動画面（--idle-only で保持）
    ├── opencode-idle.cast           #   〃（80x200）
    ├── command-code-idle.cast       #   〃
    └── transcripts/
        ├── claude-delegate.jsonl    # `@transcript` が追記する Claude のターン（テンプレート）
        ├── claude-tests.jsonl       #   〃 claude-hero の 2 パス目（`npm run test:unit` の承認後。プロンプトは `{{TASK}}`）
        └── codex-review.jsonl       #   〃 Codex の rollout ターン
```

テストは `tests/unit/skills/demo-video/` にあり `npm run test:unit` に含まれる（`.claude/skills/**` に置くと CI では 1 度も実行されない。理由は末尾「Issue 本文との差異」を参照）。

## 依存チェック（着手前に必ず実行）

```bash
command -v tmux git curl node claude codex agy opencode commandcode || echo "missing"
ffmpeg -version >/dev/null 2>&1 || echo "ffmpeg missing: brew install ffmpeg"
ffprobe -version >/dev/null 2>&1 || echo "ffprobe missing: brew install ffmpeg"
npx playwright install chromium   # 未導入なら実行（導入済みなら no-op）
```

いずれかが欠けたら**導入コマンドを提示して停止する**。録画途中で落ちると隔離サーバと tmux セッションが残る。`demo-video.sh` は最初にこれを自前で行い、欠けていれば導入コマンド（`npm install -g @openai/codex` / `opencode-ai` / `command-code`、agy は配布 URL）を提示して 1 本目の録画に入る前に止まる。

5 つのエージェントバイナリが要るのは、実 LLM を使うからではない。`POST /api/worktrees/<id>/send` は他の何を見るより先に `cliTool.isInstalled()`（実体は `which <binary>`）を評価し、false なら **503** を返す（`src/app/api/worktrees/[id]/send/route.ts`）。バイナリが PATH に無いと、依存チェックではなく**録画の途中**でテイクが死ぬ。名前はツール id ではなく実行ファイル名（`src/lib/cli-tools/install-hints.ts` の表）: antigravity は `agy`、Command Code は `commandcode`。

## パイプライン（demo-video.sh がやること）

ロケールごとに、次を通しで実行する。どこかで失敗したら `trap` で `env-down.sh --purge` まで必ず到達する。

1. 依存チェックと**絵コンテの検証**（不正なら 1 秒で止まる。2 回分の録画を無駄にしないため先に回す）
2. `env-up.sh` → `fake-agent.sh` × 5（claude / codex は live、antigravity / opencode / command-code は `--idle-only`。claude のカセットは絵コンテの `claude-cassette:` → `--claude-cassette` → 既定の順）
3. `record-scenes.ts --locale <L>` — UI を当該ロケールに切り替えて絵コンテのシーンを録画（最初に撮影外の context で `/` と worktree 画面を 1 度開いて dev サーバのコンパイルを済ませる。#2381）
4. `render-overlays.ts --locale <L>` — テロップ帯とカードを PNG 化
5. `storyboard.ts --format plan` — 尺と in/out タイムコードを算出した plan（TSV）を書き出す
6. `compose.sh` — 正規化 → overlay → concat → **尺検証ゲート**
7. `env-down.sh --purge`（次のロケールに前テイクの履歴を持ち込まない）

各ステップは個別にも回せる。以下は手動で回すときの手順。

## 手順

### 1. 隔離環境を起動

```bash
.claude/skills/demo-video/scripts/env-up.sh
. "$HOME/.commandmate-demo/state.env"    # CM_DEMO_BASE_URL 等が入る
```

`env-up.sh` は次を行う:

0. **`$HOME` が実ログイン HOME なら exit 2 で止まる**（Issue #2380。`dscl` / `getent` / `~user` 展開で引いた登録 HOME と `pwd -P` で比較。symlink も見抜く。バイパスは無い）。転写の配置も seed 生成もサーバ起動もその後なので、実 HOME の `~/.claude/projects` には何も書かれない
1. 使い捨て git リポジトリ `cmdemo-app`（3 commit + worktree 2 本。`src/components/layout/Header.tsx` と `.commandmate/agents.yaml`（5 体の roster 宣言）を `main` に持つ）を `$HOME/.commandmate-demo/seed/` に生成
2. `WORKTREE_REPOS=<seed> CM_DB_PATH=$HOME/.commandmate-demo/cm.db CM_PORT=<空きポート>` で `node_modules/.bin/tsx server.ts` を起動し、PID を state ファイルに保存
3. `curl -fsS http://127.0.0.1:<port>/` が通るまで待つ
4. `PUT /api/settings/default-agents` で既定エージェントを 5 体にし、claude / codex の**偽転写の骨格**を `$HOME` 配下に置いて、`POST /api/hooks/agent-event` に `SessionStart`（session id 付き）を 1 本ずつ送る。id とパスは `state.env` の `CM_DEMO_{CLAUDE,CODEX}_SESSION_ID` / `CM_DEMO_{CLAUDE,CODEX}_TRANSCRIPT` に入る

`CM_DEMO_PORT` / `CM_DEMO_HOME` / `CM_DEMO_READY_TIMEOUT` / `CODEX_HOME` で上書きできる。

本番の撮り直しでは先に `env-down.sh --purge` で DB を捨てること。デモ DB は残るので、消さないと過去のテイクのメッセージ履歴が画面に写り込む。

### 2. 偽エージェントを起動

セッション名は CommandMate 自身の命名規則 `mcbd-<cliTool>-<worktreeId>`（primary インスタンスは suffix 無し。`src/lib/session/claude-session.ts` の `getSessionName`）に合わせる。

worktree id は **ディレクトリ由来**である。`id = sanitize(basename(resolvedPath))`、衝突したときだけ `-<sha256(path) の先頭 8 桁>`（`src/lib/git/worktree-id.ts` の `deriveWorktreeId`。Issue #1621 / #1644 / #1645）。ブランチ名は入らない。旧規則 `<repo 名>-<branch>` の採番関数は **@deprecated** で `src/` から呼ばれていない。

**id をここに書き写さないこと。** `env-up.sh` が seed ディレクトリから導出して `state.env` に書くので、そこから読む（Issue #1809。旧規則の定数を持っていた頃は、harness が作る tmux セッション名をサーバが一切探さず、セッションが採用されないまま全シーンがタイムアウトした）。

```bash
. "$HOME/.commandmate-demo/state.env"    # CM_DEMO_WORKTREE_ID 等が入る
S=.claude/skills/demo-video/scripts; F=.claude/skills/demo-video/fixtures
CM="$PWD/node_modules/.bin/tsx $PWD/src/cli/index.ts"   # @exec の commandmate はこの checkout の CLI
$S/fake-agent.sh $F/claude-delegate.cast --tool claude --worktree "$CM_DEMO_WORKTREE_ID" \
  --cwd "$CM_DEMO_WORKTREE_PATH" --port "$CM_DEMO_PORT" --transcript "$CM_DEMO_CLAUDE_TRANSCRIPT" \
  --commandmate "$CM" --record-to "$CM_DEMO_SESSIONS_FILE"
$S/fake-agent.sh $F/codex-review.cast --tool codex --worktree "$CM_DEMO_WORKTREE_ID" \
  --cwd "$CM_DEMO_WORKTREE_PATH" --port "$CM_DEMO_PORT" --transcript "$CM_DEMO_CODEX_TRANSCRIPT" \
  --record-to "$CM_DEMO_SESSIONS_FILE"
for t in antigravity opencode command-code; do
  $S/fake-agent.sh $F/$t-idle.cast --tool $t --worktree "$CM_DEMO_WORKTREE_ID" --idle-only \
    --cwd "$CM_DEMO_WORKTREE_PATH" --record-to "$CM_DEMO_SESSIONS_FILE"
done
```

`--tool <id> --worktree <id>` で `mcbd-<tool>-<worktreeId>` を導出する（`--session` を明示するときは `mcbd-<tool>-` で始まっていないと拒否。`--tool` 無しなら `--session` の名前からツールを読む）。ジオメトリもツールで決まる: opencode は 80×200（`OPENCODE_PANE_WIDTH` / `OPENCODE_PANE_HEIGHT`。121 桁以上はサイドバーが全行に混ざる、#2047）、他は 200×1000。`--idle-only` は最初の `@input` より前の行だけ描いて保持し、届いた入力は飲み込んで再描画する（present-only の 3 体用）。

ペインは **tmux サーバの環境**を継ぐ（クライアントではない）ので、`fake-agent.sh` は隔離した `HOME` と `PATH`、`--port` の `CM_PORT` をコマンド行に書き込んでから起こす。これが無いとペインの `commandmate` は開発者の `~/.commandmate/.env` を読んで本番に繋ぐ。`--port 3000` は拒否。

`--record-to` は作ったセッション名を追記する。`env-down.sh` は**その記録**を kill 対象にするので、後片付けが名前パターンの推測に依存しない。`state.env` の 4 id に対する 2 系統目の走査もツール id を閉じたリスト（`CLI_TOOL_IDS`）で照合するので、`mcbd-command-code-<id>` のようにツール名にハイフンを含むペインも拾い、`mcbd-claude-foo-wt-dark-mode`（別 worktree）は拾わない。

`state.env` が持つ id と path（seed の basename がそのまま id になる）:

| キー | 値 | ディレクトリ |
|------|----|-------------|
| `CM_DEMO_PRIMARY_WORKTREE_ID` | `cmdemo-app` | `seed/cmdemo-app` |
| `CM_DEMO_WORKTREE_ID` / `CM_DEMO_WORKTREE_PATH` | `wt-dark-mode` | `seed/wt-dark-mode` |
| `CM_DEMO_LOGIN_WORKTREE_ID` / `CM_DEMO_LOGIN_WORKTREE_PATH` | `wt-login-error` | `seed/wt-login-error` |
| `CM_DEMO_UNSYNCED_WORKTREE_ID` / `CM_DEMO_UNSYNCED_WORKTREE_PATH` | `wt-api-cache` | `seed/wt-api-cache` |

サーバは同名の既存セッションを**新規作成せずそのまま採用する**（`claude-session.ts` の `hasSession` → `ensureHealthySession`）。カセットの 1 フレーム目が `❯` プロンプトを含むのはこのためで、空 pane は「CLI が落ちた」と判定されてセッションごと kill される。

### 3. シーンを録画

```bash
npx tsx .claude/skills/demo-video/scripts/record-scenes.ts --locale ja
# 主なオプション: --scene <id> / --out <dir> / --locale ja|en / --theme dark
#                --viewport 1440x900 / --message "..." / --headed
#                --worktree <id> / --worktree-path <dir>
#                --unsynced-worktree <id> / --unsynced-worktree-path <dir>
#                --cli-session <name> / --tmux-socket <name> / --work <dir>
#                --allow-skip
```

worktree id に**既定値は無い**。`--worktree` か環境変数 `CM_DEMO_WORKTREE_ID`、どちらも無ければ `--state` の指す `state.env` から読む。3 つとも空なら**ブラウザを開く前に落ちる**（`sync-worktrees` を撮るときは `CM_DEMO_UNSYNCED_WORKTREE_ID` も同様に必須）。

さらに録画開始前に `/api/worktrees` の `path` と `CM_DEMO_WORKTREE_PATH` を突き合わせ、同じディレクトリを別 id で持っていたら**その場で** id と path の両方を出して落ちる（`assertIdForPath`）。id は初回登録時に確定して以後動かないので（`syncWorktreesToDB` はパスで既存行を引く）、待っても直らない条件をタイムアウトまで待たない。

シーンは**部品**であり、1 本の絵コンテが全部を使う必要はない（#1575）。絵コンテは使う id だけを並べ、`demo-video.sh` はその id だけを撮る:

| id | viewport | 内容 | 同期点（prepare） |
|----|----------|------|------------------|
| `sessions-overview` | pc | ホームの Branches 一覧（複数 worktree の状態表示） | `/api/worktrees` に対象 worktree が出るまで |
| `send-and-generate` | pc | worktree を開いてメッセージ送信 → 生成開始 | `isSessionRunning === true`。送信後は `isProcessing === true` を待つ |
| `respond-from-mobile` | **mobile** | スマホ幅で承認シートを開いて承認 | `isWaitingForResponse === true` → 承認後 `false` に戻るまで |
| `complete` | pc | ready に戻った一覧 | `isProcessing === false && isSessionRunning === true` |
| `add-repository` | pc | リポジトリ画面で**パス指定**の登録（clone URL ではない＝ネットワークに出ない） | `/api/repositories` に `CM_DEMO_SEED_REPO_2` が**無い**こと → 登録後は出るまで |
| `sync-worktrees` | pc | 外部で作られた worktree を「すべて同期」で認識させる | `/api/worktrees` に `CM_DEMO_UNSYNCED_WORKTREE_ID`（既定 `wt-api-cache`）が**無い**こと → 同期後は出るまで |
| `review-diff` | pc | Git アクティビティを開いて未コミット差分を表示 | `/api/worktrees/<id>/git/staged` の `unstaged` が非空になるまで |
| `attention-badge` | pc | サイドバーの **Needs attention** pill・クロス画面 Toast・タブタイトルの `(1)` 接頭辞 | 生成中（`isProcessing === true` かつ **まだ待ちでない**）。idle なら API 経由で自分から送信する |
| `review-screen` | pc | `/review?filter=approval` の承認カード → 回答 → 一覧から消える | `isWaitingForResponse === true` → 回答後 `false` |
| `slash-palette` | pc | コンポーザーで `/` → `/cmate-verify` `/work-plan` `/create-pr` `/tdd-impl` が並ぶ → Esc で閉じる（送信しない） | `isSessionRunning === true` |
| `install-skill` | pc | Skills → Catalog の `cmate-repository-analysis` → Build install plan → Install into this worktree | `GET /api/skills` が **fresh**（stale/503 なら skip）＋ 当該 worktree に未導入 |
| `contract-verify` | **terminal** | `send --contract` → `wait --verify` の `GATE` 行・`RESULT` 行・終了コード | セッションが adopted であること。以降は §contract-verify |
| `repo-tab-switch` | pc | サイドバー折りたたみ。`cmdemo-docs` の worktree から始め、ヘッダーのタブ帯で `cmdemo-app` → ポップオーバー（状態ドット付き）→ `feature/demo-dark-mode` の行で切替（#2381） | 2 つ目の seed（`CM_DEMO_SEED_REPO_2`）を `POST /api/repositories/scan` で登録（未登録なら）→ その worktree が `/api/worktrees` に出て、`wt-dark-mode` が live |
| `agent-tabs` | pc | チャット面（`?view=chat`）で Agent ペインの roster 5 行 + ヘッダーの状態ドット + split のインスタンスピッカー（5 名がフル表示） | `isSessionRunning === true`。roster に `CM_DEMO_AGENTS` の全員が並ぶことを assert（3 体で撮らない） |
| `delegate-ask` | pc | 依頼を 1 行タイプ → Codex 行の ⋮ →「委任方法をコンポーザーに挿入」→ 送信 → 返答に `Tool calls` チップ（`commandmate ask … --instance codex`、開いた状態）とリンク | **idle**（`isProcessing`/`isWaitingForResponse` とも false）。途中のパスに送ると承認の答えとして食われる |
| `reply-file-link` | pc | Codex タブの返答（全幅 Markdown）の `Header.tsx` リンク → 右にファイルビューア | 委任が閉じていること（idle） |
| `mobile-approve` | **mobile** | Chat タブ上部にモデル名（`mobile-session-model`）、承認シートを 1 タップ | idle なら自分で送信（`MOBILE_APPROVE_MESSAGE`）→ `isWaitingForResponse === true`。解放は撮影後 `after` で検証 |
| `mobile-file-link` | **mobile** | 直近の返答のリンクをタップ → FileViewer（`modal-panel`） | 承認パスが閉じていること（idle） |

`attention-badge` は**遷移そのもの**が題材なので、`run` の中に 1 箇所だけ待ちがある（`isWaitingForResponse` になる瞬間）。Toast は realtime の `session_status_changed` で発火するため（`WaitingToastListener`）、**既に待ちに入ったセッションで撮ると Toast だけ黙って落ちる**。`prepare` は「生成中かつ未待ち」を要求し、そうでなければテイクを失敗させる。

`review-diff` の同期点が `git/diff` ではなく `git/staged` なのは、`git/diff` が**コミット指定専用**（`commit` が 7〜40 桁の hash でないと 400）で作業ツリーの変更を一切返せないため。Git ペイン自身も `git/staged` を読む。

**`respond-from-mobile` は単独では撮れない。** カセットの行は `@input` で CommandMate からの送信を待って初めて次のフレームに進むので、承認フレームは送信なしには描画されない。絵コンテに `respond-from-mobile` を置くときは**必ず手前に `send-and-generate` を置く**こと（`storyboard.test.ts` が固定している）。

サーバレンダリングされたボタンは、React が `onClick` を貼る前から Playwright の actionability を満たす。その隙に入ったクリックは黙って捨てられ、数十秒後に「別の要素が見つからない」というタイムアウトになる。`clickUntilEffective` は**観測可能な結果**（フォームが開く／ペインが `data-active="git"` になる／サーバが worktree を登録する）が出るまでクリックし直す。クリック前に固定 sleep を入れても競合が移動するだけなので使わない。

同期点は **サーバ API** を読む。状態ドットの読み上げ名はローカライズされ、エージェント別内訳で上書きされることもあるため、UI 文字列に同期すると非 en ロケールで黙って壊れる。`page.waitForTimeout` は「完成した画を数秒見せる」ためだけに使い、判定には使わない。

**待ちは `prepare` に置き、`run` に置かない。** Playwright は context 生成の瞬間から録画を始めるので、`run` の中でポーリングするとその秒数がそのまま白紙の映像になる。承認シーンはカセットがプロンプトに到達するのと capture キャッシュ（5 秒 TTL）の失効を待つため、これを `run` に置いていたときは頭 6 秒が読み込み中の画で、肝心の承認シートが trim で落ちた。

ロケール切替は **`locale` cookie**（`src/config/i18n-config.ts` の `LOCALE_COOKIE_NAME`。`NEXT_LOCALE` ではない）。context の `locale` は `Accept-Language` にしかならず、`resolveLocale` は `en` を先に探すので `ja-JP,...,en;q=0.8` は英語に解決してしまう。さらに各遷移で `<html lang>` を実測し、要求ロケールと違えばテイクを失敗させる（「UI 言語がテロップ言語と一致」を目視でなく機械で担保する）。

承認シートの決定ボタンは testid が無く文言もロケール依存（`Submit` / `送信`）なので、`locales/<locale>/prompt.json` を読んで押す。Claude の承認は番号付き選択肢なので `promptData.type` は `multiple_choice` になり、既定選択肢が `❯` 付きの `1. Yes` なので**押すのは決定ボタン 1 回**である。

viewport 既定は PC 1280x800（`--viewport` で変更可）。`respond-from-mobile` だけは `--viewport` に関係なく 390x844 に固定する — 768px 以上では `MobilePromptSheet` がそもそも描画されない。

### 4. テロップを PNG 化して合成

```bash
npx tsx .claude/skills/demo-video/scripts/render-overlays.ts --locale ja --out /tmp/overlays
npx tsx .claude/skills/demo-video/scripts/storyboard.ts --locale ja --format plan > /tmp/plan.tsv
.claude/skills/demo-video/scripts/compose.sh \
  --plan /tmp/plan.tsv --scenes "$CM_DEMO_VIDEO_DIR/ja" --overlays /tmp/overlays \
  --locale ja --out ~/Desktop/commandmate-demo/demo-30s.ja.mp4 [--gif]
```

`compose.sh` はシーンごとに「フレームサイズへ scale + letterbox → 宣言尺へ正規化 → テロップを fade in/out 付きで overlay」した mp4 を作り、concat して尺を検証する。

- **尺の伸縮**: 実尺が宣言尺より短ければ最終フレームを `tpad` で引き延ばし、長ければ**頭を切って末尾を残す**。どのシーンも見せ場は末尾（承認シート、完了した一覧）にあるため。絵コンテに `head: N` があれば先頭 N 秒も残し、間を飛ばす（`split` → `trim` × 2 → `concat`。#2381 の委任往復用）。plan の 7 列目が `head` で、無いシーンは空欄
- **GIF**: `#gif` 行（絵コンテの `gif:`）の幅 / fps で書き、`maxBytes` があれば予算ゲート。超えたら palette を 128 → 64 色（ディザ無し）に落として再試行し、それでも超えれば GIF を消して exit 1（mp4 は残る）。`--gif-width` / `--gif-fps` / `--gif-max-bytes` は plan を上書きする
- **タイムコードは絵コンテから機械算出**。手書きのタイムコードはどこにも無い。絵コンテで尺を変えれば以降のテロップ位置も自動で動く。
- **尺検証ゲート**: `ffprobe` の実測が `duration ± 0.5s` を外れたら **exit 1**。落ちたときはシートごとの宣言尺と実測尺の差分表を stderr に出し、中間ファイルを残す。
- 単体でゲートだけ回すこともできる: `compose.sh --verify out.mp4 --expect 30`、測定済みの秒数なら `--compare 30.2 --expect 30`。
- **引数の検証は ffmpeg / ffprobe の存在確認より先**に行う。逆順にすると、ffmpeg の無い環境では引数の誤りがすべて `required command not found: ffmpeg` として返り、開発機では踏めず CI でだけ落ちる（PR #1562 で実際に発生）。依存チェック自体は合成の直前に残してある。

### 4-b. contract-verify（ターミナル収録）

Task Contract・検証ゲート・Evidence は **Web UI に無い**（`src/components` から
`/api/worktrees/:id/tasks` も `/api/verification/*` も呼ばれていない）。唯一それを見せる面は
CLI の出力なので、このシーンだけはブラウザではなく tmux pane を撮る。

```bash
CM_DEMO_TMUX_SOCKET=cmdemo1810 \
  npx tsx .claude/skills/demo-video/scripts/record-scenes.ts --scene contract-verify --out DIR
```

`cli-scene.sh` が tmux セッション `cmdemo-cli` を作り、その中で次を実行する。

1. `commandmate ls` — **seed の worktree しか出ないことの assert を兼ねる**。1 つでも seed 外の id が出たら
   その場で中止する（本番に繋いでいないことの証明。`wt-api-cache` は `sync-worktrees` が撮るまで
   意図的に未登録なので、判定は「seed の部分集合であること」＋「boot sync 済みの 3 本が揃っていること」）
2. `send <id> --contract .commandmate/tasks/dark-mode.yaml`
3. `wait <id> --verify --timeout 180` → 承認フレームで **exit 10**（prompt JSON が出る）
4. `respond <id> 1`
5. `wait <id> --verify --timeout 180` → `Completed:` → `Verifying:` →
   `GATE work-evidence PASS` / `GATE scope PASS` / `GATE unit PASS` / `RESULT passed`
6. `echo $?` → `0`

**ゲートはモックしない。** seed の `.commandmate/verify.yaml` が宣言する `node --test` を
サーバが本当に実行し、映像に出る `GATE` 行はその実 exit code である（`verify show <run>` で
`unit  passed  exit=0  src=verify.yaml` と node:test の出力そのものが読める）。

隔離: `HOME` を `$CM_DEMO_STATE_DIR/cli-home` に差し替える（`~/.commandmate/.env` を読ませない。#1743）、
`CM_PORT` を state.env から渡す、state が port 3000 を記録していたら起動を拒否する。
CLI は `node_modules/.bin/tsx src/cli/index.ts`（`build:cli` 不要）。

**同期点は `prepare` ではなく手順の中にある。** `send` / `respond` の直後は
`ls --json` を（画面に出さずに）ポーリングして「生成中かつ未待ち」になるのを待つ。
`wait` が読む capture は 5 秒キャッシュされるので、直後に呼ぶと `respond` 前の承認フレームを
読んで **もう答えたはずのプロンプトに対して exit 10 を返す**（実測。修正前は 2 回目の wait が
必ず 10 で返った）。

セッション名 `cmdemo-cli` は**セッション作成の前に** `$CM_DEMO_SESSIONS_FILE` へ追記される。
後片付けは #1809 の記録ベースのままで、`mcbd-*` の総なめは行わない。
`CM_DEMO_TMUX_SOCKET` / `--tmux-socket` を渡すと `tmux -L` の専用サーバに作れる
（開発者自身のセッションを一切射程に入れずに検証するための口）。

### 4-c. install-skill（ネットワーク必須）

Catalog の URL は `src/config/skill-catalog-config.ts` のコンパイル時定数で、SSRF 対策の
完全一致 allowlist がかかっている（ローカル fixture に差し替えられない）。`prepare` は
**サーバ自身の `GET /api/skills`** で到達性を見る — 503 なら取得失敗、`catalog.stale === true` なら
オフラインのスナップショットを配っている。どちらも「導入ではなく last-known-good を撮る」ことになるので
`SceneUnavailableError` を投げる。

既定ではそれは**失敗**である（`skipping install-skill: <理由>` を stderr に出して落ちる）。
黙って空の映像を作らないため。オフラインで残りを撮りたいときだけ `--allow-skip`
（`demo-video.sh --allow-skip` も同じ）を明示する。

### 4-d. 静止画 5 点

```bash
npx tsx .claude/skills/demo-video/scripts/stills.ts --state "$HOME/.commandmate-demo/state.env"
```

`docs/images/<id>.png` と `website/assets/img/<id>.webp` を書く（現行ファイル名を維持）。

| 出力 | 画面 | サイズ | 予算 |
|---|---|---|---|
| `screenshot-desktop` | `/`（Overview） | 1280×800 @2x | **< 100KB**（LP hero / og:image。`landing-page.test.ts` が固定） |
| `screenshot-worktree-desktop` | worktree 詳細 | 同上 | < 200KB（唯一の例外） |
| `screenshot-mobile` | `/sessions` | 390×844 @3x | < 100KB |
| `screenshot-worktree-mobile` | worktree 詳細（History タブ） | 同上 | < 100KB |
| `screenshot-worktree-mobile-terminal` | worktree 詳細（Terminal タブ） | 同上 | < 100KB |

- **予算はゲート**である。`-q 82 → 40` を試し、それでも入らなければ 0.8 → 0.65 に縮小し、
  最後まで入らなければ**書かずに落ちる**（`video-to-gif` と同じ規律）。cwebp は最後の試行を
  ディスクに残すので、失敗時はそれを削除する
- 撮る前に `document.body.innerText` を読み、home ディレクトリ・プライベート LAN アドレス・
  旧製品名・**このリポジトリ自身の名前**が含まれていたら失敗させる。直し方は**構図**であって
  マスクではない

### 5. 出力を確認

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 ~/Desktop/commandmate-demo/demo-30s.ja.mp4
git status --short     # 何も出ないこと
```

シーンの webm は `$HOME/.commandmate-demo/videos/<locale>/` に、完成品は `--out` の先に出る。**バイナリはコミットしない**（どちらもリポジトリ外なので、そもそも git から見えない）。

### 6. 後片付け（異常終了時も必ず実行する）

```bash
.claude/skills/demo-video/scripts/env-down.sh          # サーバ停止 + demo tmux セッション kill + seed 削除
.claude/skills/demo-video/scripts/env-down.sh --purge  # DB・ログ・録画も消す
```

tmux セッションの kill 対象は 2 系統で、どちらも**この run が記録した名前・id にしか一致しない**。`mcbd-*` の総なめはしない（この tmux サーバは開発者自身の稼働セッションを抱えている）。

1. `fake-agent.sh --record-to` が `$CM_DEMO_SESSIONS_FILE` に追記した名前
2. `state.env` の 4 つの demo worktree id に対する `mcbd-<tool>-<id>[-<suffix>]` — サーバ自身が起こしたセッションや追加インスタンスを拾う

**手順 1 以降のどこで失敗しても、必ず 6 まで到達させること。** 途中で諦めると隔離サーバがポートを掴んだまま残り、次回の `env-up.sh` が state ファイルの存在を理由に起動を拒否する（これは意図的な設計。壊れた状態に上書きするより止める）。`demo-video.sh` は `trap ... EXIT INT TERM` でこれを保証する。

## 隔離の不変条件

4 つが揃って初めて本番非接触になる。1 つでも崩したら止めること。

1. **専用ポート。** ポート 3000 は `env-up.sh` / `env-down.sh` / `record-scenes.ts` の 3 箇所すべてが拒否する。開発機の稼働インスタンスがそこにいる。
2. **`CM_DB_PATH` は `$HOME` 配下。** `/tmp` `/var` は `validateDbPath` がシステムディレクトリとして弾くため、temp dir は使えない（`src/config/system-directories.ts`）。
3. **`WORKTREE_REPOS` は使い捨て seed のみ。** worktree 探索の唯一の入力がこれ（`getRepositoryPaths`）。`CM_ROOT_DIR` は「リポジトリを含む入れ物」であって走査対象ではない（Issue #1328）。
4. **停止は記録した PID 経由だけ。** `pkill -f commandmate` は無関係なプロセスを巻き込んだ実績があるため使わない。`env-down.sh` はプロセスグループへ signal する前に `ps -o command=` が記録どおりかを確認し、一致しなければ **kill せず異常終了する**（PID 再利用対策）。
5. **`$HOME` は実ログイン HOME ではない**（Issue #2380）。転写リーダーは `os.homedir()` 起点で `~/.claude/projects` / `~/.codex/sessions` を読み、`env-up.sh` はそこに偽転写を置く。だから `env-up.sh` は登録 HOME（`dscl` / `getent` / `~user`）と `$HOME` の実パスを比べ、一致すれば**何も書かずに exit 2** する。README の撮影は `HOME=/Users/Shared/cmdemo-home` で回す（`/Users/Shared` は `SYSTEM_DIRECTORIES` に無いので `validateDbPath` を通る。stills の個人パス対策と同じ運用）。HOME を動かすと壊れるものは一緒に指定する: `PLAYWRIGHT_BROWSERS_PATH=/Users/<real>/Library/Caches/ms-playwright`、`unset TMUX`。`env-down.sh` は state.env が記録した 2 ファイルだけ（session id を名前に持つ実パスに限って）を消す

シェルの注意点: ループ変数に `path` 等の特殊名を使わないこと（`PATH` を壊して `curl` が command not found になり、ヘルスチェックが偽陰性になる）。bash は 3.2 互換（`declare -A` / `mapfile` 不可）。

## カセット形式

1 行 1 イベントのテキスト。`#` 行と空行は無視。

```
<遅延ms>|@input|@exec|@transcript|@hook|@pass <TAB> <ペイロード>
```

- ペイロードは `printf %b` で展開する（`\e` `\n` `\t`）。ANSI を含めたまま 1 行に収まり、diff も grep も効く
- `@input` は CommandMate からのメッセージ着信までブロックする。届いた行は `{{INPUT}}`、そのパスの **1 本目**の入力は `{{TASK}}`、`--worktree` は `{{WORKTREE}}` に差し込まれる
- 承認プロンプトの後は `{{TASK}}` を使う。そこでは `{{INPUT}}` が承認の `y` になっており、それを指示として画面に映すと製品がしていないことを主張することになる
- 差し込みは **`%b` 展開の後**に行う。先に差し込むと、メッセージ中の `%` や `\e[` が printf に解釈され、カセットが書いていない制御列で pane が塗られる
- `--speed N` は数値遅延を N で割る。`--dry-run` は寝ずにスケジュールを stderr へ出す（テストが壁時計に依存しないため）。`@exec` は trace だけで実行しない
- `@pass`（ペイロード無し、#2381）は同じカセットの中で**次の指示**を始める。`{{TASK}}` と `{{EXEC_OUTPUT}}` を空にするので、続く `@input` は前の指示の続き（承認の答え）ではなく新しい指示として読まれる。`claude-hero.cast` は委任パス → `@pass` → 承認パスの 2 パス構成
- `@input` 行は**先頭行を読んだ瞬間にフレームを描き**、その後で `--input-settle` 秒の残り行を読む（#2381）。逆順だと settle の 1 秒間ペインは起動画面のままで、その間にブラウザの `current-output` が撮った capture が 5 秒キャッシュに乗り、poller の初回 tick がそれを読んで**起動バナー 1 行を返答として保存**した（実測: `✻ Welcome to Claude Code · demo fixture` が assistant 行に）

### `@exec`（Issue #2380）

`@exec <TAB> commandmate ask {{WORKTREE}} --instance codex "…" --json` は、その時点でペインの cwd で**本当に**実行し、stdout/stderr をペインに流す。委任シーンで Claude 側カセットが `commandmate ask` を打つための行で、製品の send → wait → History 読み出しは実コードが走り、差し替わるのは LLM だけになる。

- 許可されるのは**先頭の語が `commandmate`** で、シェル演算子（`;` `&` `|` バッククォート `$` `<` `>` `(` `)`）を含まないコマンドだけ。それ以外を 1 行でも含むカセットは**最初の行を再生する前に** exit 2 で拒否される
- 語分割はシェルの引用規則で行い、`{{…}}` の差し込みは**分割の後**に各 argv 要素へ行う。メッセージに `"` があっても行の引用が壊れない
- `commandmate` の語は `--commandmate` の値（複数語可）に置き換わる。`demo-video.sh` はこの checkout の `node_modules/.bin/tsx src/cli/index.ts` を渡すので、グローバル install は要らない
- 実行中は `--port` の `CM_PORT` と `CM_BIND=127.0.0.1` が渡り、`DATABASE_PATH` / `MCBD_*` / `CM_AUTH_TOKEN` は落とされる。stdin は `/dev/null`（次の `@input` が読む送信を食わないため）。exit code が非 0 でも再生は続き、`fake-agent: @exec exited N` がペインに出る
- `ask` の出力は直前に描いた running フレームの**下**に流れ、次の行が全画面を塗り直すまでの一瞬だけ見える。running のアンカー（`esc to interrupt`）はツール呼び出し行の上、フレーム末尾 15 行以内に置いておくこと

### `@transcript`（Issue #2380）

`@transcript <TAB> transcripts/codex-review.jsonl` は、テンプレート（カセットからの相対パス）の非コメント行を `--transcript` のファイルに追記する。差し込みは `{{NOW}}`（UTC ISO）、`{{TURN}}`（行ごとに新しい uuid）、`{{SESSION_ID}}`（`--transcript` のファイル名末尾 36 文字）、`{{CWD}}`、`{{WORKTREE}}`、`{{MESSAGE}}`（送信の全行。`\n` 結合）、`{{INPUT}}` / `{{TASK}}`、`{{EXEC_OUTPUT}}`（直前の `@exec` の出力）。文字列は JSON エスケープ済みで入るので、テンプレート側は `"…{{MESSAGE}}…"` のように引用符の中に置く。

- **ready フレームより前に置く。** poller はターン終了を判定した瞬間に転写を読む
- 転写のプロンプトが `/send` 行と同じ本文で、タイムスタンプが ±2 分以内なら、リーダーは `/send` 行を引き取って `request_id` を付け、返答行を `claude-turn:<uuid>` / `codex-turn:<turn_id>` で書く。だからテンプレートのプロンプト本文は `{{MESSAGE}}` にする
- codex は `task_complete` で閉じたターンしか書かない。claude は最後の assistant record に `stop_reason: end_turn` と本文が要る（#2264）。テンプレートはどちらも満たしていて、`fake-agent.test.ts` が製品のパーサで固定している

### `@hook`（Issue #2380）

`@hook <TAB> UserPromptSubmit` / `Stop`（`SessionStart` / `SessionEnd` も可）は、実 CLI の注入フックと同じ形で `POST /api/hooks/agent-event` を打つ（`--port` 必須。無ければ注記して飛ばす）。本文は `tool` / `hook_event_name` / `session_id`（`--transcript` の名前から）/ `cwd` / `worktreeId` / `instanceId`、`UserPromptSubmit` には `prompt`（送信全文）。`--dry-run` は trace だけ。サーバが答えなくても再生は続く（実フックと同じ fail-open）。

置く位置は実 TUI と同じ: `@input` の直後に `UserPromptSubmit`、`@transcript` と返答フレームの後に `Stop`。これが無いと `wait` / `ask` は「hooks が答えない」保留（`PENDING_PROMPT_HOLD_MS` = 60 秒）に入り、委任往復が 90 秒かかる（実測 2026-09-07: 88 秒 → `@hook` 導入後は 25 秒で History に 4 行）。`Stop` の受信側はその場で転写を読むので、返答行は poller の次 tick を待たずに立つ。

### 実測で決まった 2 つの形（2026-09-07、隔離サーバ + 5 ペイン + `commandmate send` で往復）

- **返答フレームは `Stop` の後に 8 秒保持する。** カセットは末尾行の後、行 0（起動画面）へ戻る。保持が無いと返答フレームは 0 秒で消え、poller（capture は 5 秒キャッシュ）は起動画面しか見ず、codex の返答が History に載らなかった
- **`@input` の直後に描くフレームは既に running。** 「composer に本文だけ」のフレームは `ready` に読め、そこに poll が当たると poller はターン完了と判定して起動画面の 1 行（`✻ Welcome to Claude Code · demo fixture`）を返答として保存した。実 TUI は 100ms でスピナーに切り替わるが、カセットにその保証は無いので、その隙間を描かない

## fixture の採取手順（実機採取）

**手で書かないこと。ANSI を剥がさないこと。** 剥がした fixture は製品が出さないペイロードを記述することになり、それが「通る」ことを証明しても意味がない（Issue #1522 の再発）。

1. 使い捨ての claude セッションを起こす（稼働中の worker セッションは composer に残テキストがあるため流用不可）

   ```bash
   tmux new-session -d -s cmdemo-capture -c "$(mktemp -d)" -x 200 -y 1000 claude
   tmux send-keys -t '=cmdemo-capture:' -l 'summarize this directory'; tmux send-keys -t '=cmdemo-capture:' Enter
   ```

2. 生成中と完了後で `-e`（ANSI 付き）キャプチャを取る

   ```bash
   tmux capture-pane -p -e -t '=cmdemo-capture:' > /tmp/frame-generating.txt   # `esc to interrupt` が見える間に
   tmux capture-pane -p -e -t '=cmdemo-capture:' > /tmp/frame-ready.txt        # `? for shortcuts` に戻ってから
   tmux kill-session -t '=cmdemo-capture'
   ```

3. 各フレームを `\e[2J\e[3J\e[H` 始まりの 1 行に畳み（`\e[3J` を落とすと tmux の履歴に前フレームが積み上がり、ターミナルペインが同じ画面を何枚も並べて表示する）、遅延を付けてカセット行にする。セッション URL・実 path・実 issue 名は必ず伏せる

**5 ツール分の採取（Issue #2380）。** ツールごとに隔離 tmux（`tmux -L cmdemo<issue>`、200×1000。opencode だけ 80×200）で 1 回ずつ起こし、同じ要領で `-e` キャプチャを取る。Claude は委任する側（`commandmate ask` を Bash tool として実行し要約する 1 ターン）、Codex は頼まれる側（Markdown で返し `src/components/layout/Header.tsx` へのリンクを 1 行含む）、Antigravity / OpenCode / Command Code は起動画面だけ。出自（版・日付・ジオメトリ）はカセット冒頭のコメントに書く。同梱の 4 本（`codex-review` / `antigravity-idle` / `opencode-idle` / `command-code-idle`）は、この repo が別 Issue で採取済みの実フレーム（`tests/fixtures/{codex-live-2310,antigravity-live-2364,command-code-live-2250,opencode-live-2049}`）から、採取ディレクトリだけを seed のパスに書き換えて組んである（枠の幅は元と同じに詰めてある）。`claude-delegate` は `claude-session-sample` のフレームを流用し、`⏺ Bash(commandmate ask …)` 行を同じ形で足した。差し替えるときは同じ regime で採り直す。

同梱の `claude-session-sample.cast` は、この手順で採取済みの実キャプチャ（`tests/unit/skills/orchestrate-monitor/fixtures/live-idle.json` / `live-generating-token.json`、sanitize 済み）から組み立ててある。検出器が実際に見ているアンカーは原文のまま残っている:

| 状態 | アンカー | 実装 |
|------|----------|------|
| running | `esc to interrupt` | `CLAUDE_INTERRUPT_HINT_PATTERN`（下 15 行窓） |
| running | スピナー文字 + `…` | `CLAUDE_THINKING_PATTERN`（下 5 行窓） |
| ready | 行頭 `❯` | `CLAUDE_PROMPT_PATTERN` |
| 応答完了 | 10 文字以上の `─` 罫線 | `CLAUDE_SEPARATOR_PATTERN` |
| waiting | `Do you want to proceed?` + `❯ 1. Yes` / `2. No, …` | `detectMultipleChoicePrompt`（`prompt-yes-no.json` の実キャプチャ） |

4 本の追加カセットが検出器に見せているアンカー:

| ツール | ready | running |
|------|-------|---------|
| codex | 太字 `›` + dim placeholder の composer（SGR で user-echo の `›` と区別、#2310）と model/directory の footer | `• Working (Ns • esc to interrupt)` |
| antigravity | 2 本の罫線に挟まれた `>` composer と `? for shortcuts` | （present-only。running フレーム無し） |
| command-code | 反転カーソル付き `❯` composer と `? for shortcuts` | 〃 |
| opencode | `┃  Ask anything...` の composer 行と `tab agents  ctrl+p commands` の footer（200 行フレームの行位置込み） | 〃 |

`tests/unit/skills/demo-video/fake-agent.test.ts` はカセットを**実物の `detectSessionStatus`** に通し、ready → running ×3 → waiting → running ×2 → ready を固定している。codex-review は ready → running ×5 → ready、idle 3 本は ready のまま、claude-delegate は `@exec` を stub の `commandmate` で本当に走らせて ready → running ×4 → ready を固定し、両 live カセットが追記した転写は製品の `parseClaudeTranscript` / `parseCodexRollout` を通して「1 ターン・閉じている・本文にリンクがある・`claude-turn:` / `codex-turn:` のキー」まで見ている。さらにアンカーを潰した変異カセット（`esc to interrupt` を消す／`❯` を消す／番号付き選択肢を潰す／質問行を潰す）では該当ステータスが実際に消えることも確認しているので、この緑は空振りではない。

承認フレームは実キャプチャの形（ツール呼び出し行 → 空行 → 質問 → 選択肢）をそのまま再現している。`detectMultipleChoicePrompt` は質問の上の継続行を質問に畳み込むので、`promptData.question` は `⏺ Bash(npm run test:unit) Do you want to proceed?` になる。これは**この画面に対する製品の実挙動**であり、Claude が描かない pane を作って見栄えを整えることはしない（#1522 の再発防止）。ただしトランスクリプト全体を質問の上に残すと 100 文字超の羅列になってスマホでは読めないため、上に残すのはキャプチャどおりツール呼び出し 1 行までとし、`fake-agent.test.ts` が 60 文字未満を固定している。

## 絵コンテ（storyboard/default.yaml）

文言を変えるときはこのファイルだけを編集する。`storyboard.ts` が合成前に検証し、違反があれば **exit 1** で止まる。

| 規則 | 理由 |
|------|------|
| シーン尺の合計 == `duration` | 合計が合わない絵コンテで 2 ロケール分撮ってから気付くのを避ける |
| `telop.ja` / `telop.en` の**両方必須** | 片方欠けると画面と字幕の言語が食い違った動画が黙って出る |
| record シーン: ja 20 文字 / en 8 語以内 | 動く映像の上に重ねる帯は一目で読めないと意味がない |
| card シーン: ja 40 文字 / en 12 語以内 | カードは静止した全画面。Issue 本文のアウトロ `github.com/Kewton/CommandMate` は 29 文字で、帯の予算では自分の規則に落ちる |
| `type: record` の id が `record-scenes.ts` の `SCENES` に**存在する**（絵コンテ ⊆ 実装） | 未実装 id は録画時に落ちる。逆方向は #1575 で外した — 「実装済みなら絵コンテに必ず載せる」は 1 本の絵コンテに全シーンを強制し、シーン追加が既存の全絵コンテを壊すため。撮った映像を捨てない保証は `demo-video.sh` が絵コンテの id だけを `--scene` で撮ることに置き換えた |
| `output` はファイル名になるので `[A-Za-z0-9._-]` のみ | `../` を含む値でディレクトリ外に書き出させない |
| `type: code` の `source` は**絵コンテのディレクトリ配下に閉じる**（解決後のパスで判定） | `output` と同じ趣旨。絵コンテは文言担当者が編集するデータで、`source` は公開動画に映るファイルを指す。symlink 経由の脱出も塞ぐため実パスで見る |
| `type: code` の `source` は 30 行以内・100 桁以内、`lang` は短い構文ラベル | カードは静止フレーム 1 枚。折り返しはしない（折り返した YAML キーは別の文書に読める）ので、幅超過は検証で落とす |
| `respond-from-mobile` / `attention-badge` / `review-screen` は手前に `send-and-generate` が要る | カセットは `@input` で送信を待つので、送信より先の画は一切描かれない |
| 承認に答えるシーン（`respond-from-mobile` / `review-screen`）は 1 本の絵コンテに **1 つまで** | カセットは 1 パスに 1 プロンプトしか描かない。2 つ置くと 2 本目がタイムアウトまで待つ |
| `attention-badge` は承認に答えるシーンより**前** | 待ちに入る瞬間が題材なので、既に答えたあとでは撮れない |
| `reply-file-link` / `mobile-approve` / `mobile-file-link` は手前に `delegate-ask` が要る（#2381） | `claude-hero.cast` は 1 パス目が委任、2 パス目が承認。ファイルリンクはその返答、承認は 2 パス目にしか無い |
| `head: N`（record のみ、0 < N < duration） | take が尺より長いとき、末尾だけでなく**先頭 N 秒も残してジャンプカット**する。委任往復は約 25 秒で、頭（挿入と送信）と尻（返答）の両方が見せ場 |
| `telop.position: top` / `bottom`（record のみ） | 帯を上に置く。既定の下帯はコンポーザーと最新の返答と承認シートの選択肢に被る。座標は `telop.html` の CSS が持ち、PNG に焼く（compose.sh は 0:0 に重ねるだけ） |
| `claude-cassette: <path>`（絵コンテからの相対、skill ディレクトリの内側、`.cast`、実在） | 撮る内容はカセットに依存する。絵コンテが宣言すれば `--storyboard` 1 つで済み、忘れたフラグが数分後のタイムアウトになるのを防ぐ。`@exec` を実行するファイルなので `source` と同じ封じ込め |
| `gif: { width, fps, maxBytes }` | `--gif` の幅 / fps / 予算。予算超過は palette を 256 → 128 → 64 色（ディザ無し）へ落として再試行し、それでも超えれば GIF を**消して exit 1**。幅と fps は絵コンテが決めたので落とさない |

```yaml
  - id: contract-yaml
    type: code
    duration: 4
    source: code/dark-mode.contract.yaml   # 絵コンテからの相対パス
    lang: yaml
    telop: { ja: "契約つきで送信する", en: "Send with a contract." }
```

`type: code` は**静止カード**である。テロップはカードの見出しになり、予算は `card` と同じ
（ja 40 文字 / en 12 語）。`compose.sh` は `card` と同じく宣言尺だけ静止 PNG を出す
（PNG 名は `code-<id>.<locale>.png`）。listing は `createElement` + `textContent` で 1 行ずつ
組む — ディスク上のファイルが公開フレームにマークアップを注入できないため。

```bash
npx tsx .claude/skills/demo-video/scripts/storyboard.ts --locale ja            # plan(TSV) を出す
npx tsx .claude/skills/demo-video/scripts/storyboard.ts --locale en --format json
```

YAML は自前の**厳格なサブセットパーサ**で読む。このツリーにある YAML パーサは `js-yaml` だけで、それは `gray-matter` / `marp-core` の**推移的依存**であり `package.json` に宣言が無い。無関係な依存更新で消えうるものをスキルの前提にはできない。サブセットは解釈できない記法を推測せずエラーにする（フローシーケンス・単一引用符・タブインデント等）。

## Issue 本文との差異（実測を正とした点）

| 本文 | 実測 | 対応 |
|------|------|------|
| #1553: `.agents/skills/` へも byte-identical 配置 | 着手時点でリポジトリに `.agents/` が無い | 新規作成して両置き。`tests/unit/skills/demo-video/mirror.test.ts` が無差分を固定 |
| #1553: テストは `scripts/tests/` に置く | `npm run test:unit` は `vitest run tests/unit` の**パス絞り込み**なので `.claude/skills/**` の test は CI で 1 度も走らない。さらに `.agents` 側の複製が `npm test` で二重実行される | `tests/unit/skills/demo-video/` に配置（`orchestrate-monitor` と同じ前例） |
| #1554: 絵コンテの record id は `sessions-overview` / `send-and-generate` / `respond-from-mobile` / `complete`。かつ「id は実装と 1:1、未実装 id はエラー」 | #1553 の実装は `overview` / `send-message` の 2 本だけ。本文どおりに書くと初日から自分のバリデータで落ちる | 本文側の id を採用して既存 2 本を改名し、`respond-from-mobile` / `complete` を新規実装した。id は絵コンテ・`--scene`・出力ファイル名に出る利用者向けの名前で、本文の方が撮る内容を正しく表している。改名で壊れる外部利用者はまだいない（Phase A はパイプライン未提供） |
| #1554: テロップ上限は ja 20 文字 | 本文自身のアウトロカードが 29 文字 | 帯（record）とカードで予算を分けた。上表を参照 |
| #1554: 承認は「ワンタップ」 | Claude の承認は番号付き選択肢なので `promptData.type` は `multiple_choice`。シートは Yes/No ボタンではなくラジオ＋決定ボタンを描く | 既定選択肢が `1. Yes` で事前選択されるため、実際に押すのは決定ボタン 1 回。文言どおり「ワンタップ」は成立する |
| サーバ起動は `PORT=<空きポート>` | `server.ts` が読むのは `CM_PORT`（`getEnvByKey`）。`PORT` は無視される | `CM_PORT` を使用 |
| #1810: `review-screen` は「カードのインライン返信で `1` を送る」。testid は `review-card` / `review-status-badge` | `ReviewTab.tsx` のカードは worktree へのリンクで、**インライン返信は存在しない**。testid も `review-item-<id>` / `review-filter-<filter>` | カードを押して開いた `prompt-panel` で答え、`/review?filter=approval` に戻って行が消えるところまでを 1 シーンにした。`src/` は本 Issue のスコープ外なので testid は追加していない |
| #1810: `commandmate ls` は「seed の 4 worktree だけが出る」 | `wt-api-cache` は `sync-worktrees` が撮るまで意図的に未登録なので、boot 直後は 3 本 | assert を「seed の部分集合」＋「boot sync 済みの 3 本が揃う」に変えた。seed 外の id が 1 つでも出れば即中止という性質は同じ |
| #1810: `verify.yaml` の gate は `node --test` | `node --test test/` は Node 24 で `test` を**モジュールとして解決**しようとして落ちる（実測: `MODULE_NOT_FOUND`） | 本文どおり引数なしの `node --test` にした |
| #1810: `contract-verify` の 1 回目の `wait` は exit 10 | カセットの `@input` が 1 行 = 1 送信だったため、`send --contract` の複数行プリアンブルが 1 行ごとにパスを進め、承認フレームが**同じメッセージの次の行で自動的に答えられて**いた。`wait` は起きていない作業について `Completed` を報告した | `fake-agent.sh` に `--input-settle`（既定 1 秒）を入れ、1 送信を 1 `@input` として読むようにした。これで実測どおり exit 10 → `respond` → exit 0 になる |
| #2380: `fixtures/transcripts/` の転写 JSONL を `env-up.sh` が配置する | リーダーは転写のプロンプトのタイムスタンプ **±2 分**で `/send` 行を引き取る（`USER_TURN_ADOPTION_WINDOW_MS`）。起動時に完成した転写を置くと、テイクが数分後に回った時点で引き取れず、返答行が質問の**上**に並ぶ | `env-up.sh` は骨格（ファイル、codex の `session_meta`）と `SessionStart` フックだけを担当し、ターン本体はカセットの `@transcript` 行が**再生時刻で**追記する。`fixtures/transcripts/*.jsonl` はそのテンプレート |
| #2380: 転写リーダーは `os.homedir()` 起点でファイルを読む | claude / codex とも**ファイルを探す鍵は session id** で、hook の `session_id`（`getLastAgentEvent`）から引く。ファイルを置くだけでは読まれない | `env-up.sh` が実 CLI と同じ `POST /api/hooks/agent-event`（`SessionStart` + `session_id`）を 1 本ずつ送る。`SessionStart` は世代を開くだけで verdict を持たないので、ステータスは画面判定のまま |
| #2380: HOME ガードは「`dscl` または `$HOME` が `CM_DEMO_HOME` 配下か」 | `CM_DEMO_HOME` は既定で `$HOME/.commandmate-demo`、つまり `$HOME` の**下**にあるので後者は成立しない | 登録 HOME（`dscl` → `getent` → `~user` 展開）と `$HOME` を `pwd -P` で比べて一致なら exit 2。symlink 越しも同じ。判定できない環境も exit 2（安全側） |
| #2380: 5 本のカセットは実 TUI を隔離 tmux で採る | 採取そのものはオーケストレーターの作業（契約の必須範囲外） | 同梱 4 本は本 repo が別 Issue で採取済みの実フレーム（`tests/fixtures/*-live-*`）から採取ディレクトリだけ書き換えて組み、`claude-delegate` は既存 sample のフレームを流用。検出器のアンカーは実キャプチャのまま。採り直すときは同じ regime で |
| #2380: 委任カセットの `@exec` は「`commandmate` 始まり」を許可条件にする | 先頭語だけの判定では `commandmate x; rm -rf …` が通る | 先頭語 `commandmate` **かつ**シェル演算子（`;` `&` `\|` バッククォート `$` `<` `>` `(` `)`）を含まない。差し込みは語分割の後 |
| #1810: 静止画は 5 点とも 100KB 未満 | `screenshot-worktree-desktop` は 3 ペインで、旧アセットも 169KB だった | 本文の例外指定（`website/assets/media/README.md`）に合わせ、この 1 枚だけ 200KB。他の 4 枚は 100KB 未満（実測 q=82 で 47〜79KB） |
| #2381: 各シーンの秒数（`repo-tab-switch` 4 / `reply-file-link` 5 / `mobile-approve` 4 / `mobile-file-link` 4） | 実測: タブ帯のブランチを押してからの遷移は dev サーバで約 2 秒（4 秒枠だとポップオーバーが枠外）、承認シートのタップ後「送信中…」が約 2.5 秒（4 秒枠だとシートが 1 秒）、委任往復の頭（依頼をタイプ → 挿入 → 送信）は 3.5〜4.8 秒（`head: 4` では送信が切れた） | `repo-tab-switch` 5 / `reply-file-link` 4 / `mobile-approve` 5 / `mobile-file-link` 3、`delegate-ask` は 7 秒のまま `head: 5`（尻 2 秒）。合計 30 秒は変えていない。見せ場が 1 フレームで済む 2 本（開いたファイル）から秒を回した |
| #2381: `agent-tabs` の telop.ja「5 エージェントが 1 つの worktree に」 | 25 文字で record の上限 20 文字を超える（Issue 自身が「字数超過はそこで落ちる」と書いている） | 「5 エージェント、1 worktree」（19 文字）。public-messaging.md §6 も同じ文言 |
| #2381: 「エージェントタブに 5 体」 | PC ヘッダーの行は idle を**ドット**に畳む（`classifyHeaderInstances`）ので、5 体が名前で並ぶのは split のインスタンスピッカーと Agent ペインの roster だけ | `agent-tabs` は Agent ペインを開いた状態でピッカーを開いて撮る。roster の alias 入力は幅で切れる（`Antigravit`、`Command`）が、ピッカーはフル表示 |
| #2381: 「2 つ目のリポジトリをクリック」 | タブ帯は名前順で `cmdemo-app` が 1 つ目。2 つ目の `cmdemo-docs` には live セッションが無い | `cmdemo-docs` の worktree から始めて `cmdemo-app` のタブを押す（ポップオーバーに 3 ブランチと状態ドット、`feature/demo-dark-mode` が緑）。切替先が次のシーンの worktree になる |
| #2381: 「Codex の返答（全幅 Markdown）」 | codex 側は初回送信でバナー行が `chat_messages` に残る（#2380 の既知行）が、チャット面には描かれなかった | Issue どおり Codex タブで撮る。Claude 側にも同じリンクがあるので、描かれるようになったら Claude タブへ切り替えればよい |
| #2381: 「PC 送信シーンのテロップ位置」 | 下帯（y 612〜720）はコンポーザーと最新の返答に被る。スマホの承認シートの選択肢にも被る | `telop.position: top`（y 164〜272、ヘッダーと split の題名帯の下）。`delegate-ask` と `mobile-approve` に付けた。`reply-file-link` は返答が中段、ファイルビューアの先頭行が上段なので下帯のまま |
| #2381: GIF は 600px / 10fps / 1.84MB 以下 | 600px / 10fps / 256 色 + 誤差拡散ディザで 2.19〜2.31MB（UI 面はテキストのアンチエイリアスにディザ・ノイズが乗り LZW が効かない） | 予算超過時は palette を 128 色・ディザ無しに落として 1.49〜1.54MB。600px と 10fps は落とさない。見た目の差は 600px では判別できない（実測） |
| #2381: 承認は「同じ worktree」で | `claude-delegate.cast` に承認フレームは無い。`claude-session-sample.cast` を使えば委任が撮れない | `claude-hero.cast` = 委任パス + `@pass` + 承認パス。`mobile-approve` は idle を待って自分で 1 行送り、2 パス目の `Do you want to proceed?` を待ってから開く |

## 既知の製品側の行（#2380 の往復で観測、スキルでは直せない）

- **codex の 1 送信目の直前に、起動バナーが assistant 行として保存される。** `send-user-message.ts` の手順 1（`savePendingAssistantResponse`）は scrollback 系ツール（codex 等）で「前回の返答の未保存分」をペインから読み、`lastCapturedLine` が 0 の初回送信ではバナー（ANSI 付き）をそのまま行にする。実 codex でも同じ（#2192 の「送信前フラッシュ」）。チャット面の codex 側は返答の上にこの行が 1 つ乗る。撮るなら Claude 側のチャット面（`claude-turn:` 行にも同じリンクがある）か、製品側で「転写リーダーが生きている instance では送信前フラッシュを飛ばす」修正を別 Issue で
- `commandmate ask … --json` の出力は `ask` が返した瞬間だけ Claude ペインの running フレームの下に見える（次の行が塗り直す）
- **PC のコンポーザーは live セッションへの送信のたびに「Queued (session busy)」の警告トーストを出す（#2381 で観測、develop 8f41c074）。** `TerminalSplitPaneContent` が `MessageInput` に `isProcessing={terminal.isRunning}` を渡しているが、#2238 以降の `isRunning` は「tmux セッションが在る」の意味で「生成中」ではない。ヘッダーの pill が `Ready` の隣で「busy」と言う。`delegate-ask` は送信直後にそのトーストの ✕ を押して閉じる（隠さない）。製品側の修正は別 Issue
- codex の初回送信直前の起動バナー行（上記）は `chat_messages` には残るが、チャット面には描かれない（実測 2026-09-07。`reply-file-link` は Codex タブで撮っている）

## 制約

- **本番サーバ（127.0.0.1:3000）と本番 `cm.db` には一切触れない。**
- 生成物（webm）はリポジトリ外に出す。コミットしない。
- 録画中に `npm run build` を回さない（稼働サーバの足元でビルドして画面を壊した前例が 2 回ある）。
