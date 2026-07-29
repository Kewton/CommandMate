---
name: demo-video
description: CommandMate のデモ動画を隔離環境で収録する。Phase A は「隔離デモ環境の起動・偽エージェント再生・Playwright シーン録画」まで。「デモ動画」「demo video」「デモを録画」等の指示で使う。
allowed-tools: Bash(.claude/skills/demo-video/scripts/*), Bash(.agents/skills/demo-video/scripts/*), Bash(npx tsx *), Bash(tmux *), Bash(ffprobe *), Bash(ffmpeg -version), Read
---

# demo-video（Phase A: 基盤）

CommandMate の 30 秒デモ動画を全自動生成するための技術基盤。本 Phase は **隔離デモ環境・偽エージェント再生・Playwright シーン録画** の 3 点のみを担当する。絵コンテ／テロップ／ffmpeg 合成／30 秒尺検証は後続 Issue #1554。

## 設計判断

**実 LLM は使わない。** 実セッションは非決定的で、生成に数分かかり 30 秒に収まらない。代わりにキャプチャ済み ANSI 出力をタイミング付きで再生する「偽エージェント」を tmux セッションで動かす。

置き換えるのは **LLM だけ**で、モックは 1 つも入れていない。CommandMate から見た入力は tmux pane の中身だけなので、`status-detector.ts` / response poller / サイドバーの状態ドットはすべて製品コードのまま動く。偽エージェントが差し込まれるのは `tmux capture-pane` が返すバイト列の出所だけである。

## 構成

```
demo-video/
├── SKILL.md
├── scripts/
│   ├── env-up.sh         # 隔離デモ環境の起動（seed repo 生成 → サーバ起動 → Ready 確認）
│   ├── env-down.sh       # 停止・後片付け（PID 経由の kill のみ。pkill は使わない）
│   ├── fake-agent.sh     # カセット再生（tmux セッション作成も担当）
│   └── record-scenes.ts  # Playwright をライブラリとして使うシーン録画
└── fixtures/
    └── claude-session-sample.cast   # 採取済みカセット（テキスト。コミット可）
```

テストは `tests/unit/skills/demo-video/` にあり `npm run test:unit` に含まれる（`.claude/skills/**` に置くと CI では 1 度も実行されない。理由は末尾「Issue 本文との差異」を参照）。

## 依存チェック（着手前に必ず実行）

```bash
command -v tmux git curl node || echo "missing"
ffmpeg -version >/dev/null 2>&1 || echo "ffmpeg missing: brew install ffmpeg"
ffprobe -version >/dev/null 2>&1 || echo "ffprobe missing: brew install ffmpeg"
npx playwright install chromium   # 未導入なら実行（導入済みなら no-op）
```

いずれかが欠けたら**導入コマンドを提示して停止する**。録画途中で落ちると隔離サーバと tmux セッションが残る。

## Phase A 手順

### 1. 隔離環境を起動

```bash
.claude/skills/demo-video/scripts/env-up.sh
. "$HOME/.commandmate-demo/state.env"    # CM_DEMO_BASE_URL 等が入る
```

`env-up.sh` は次を行う:

1. 使い捨て git リポジトリ `cmdemo-app`（2 commit + worktree 2 本）を `$HOME/.commandmate-demo/seed/` に生成
2. `WORKTREE_REPOS=<seed> CM_DB_PATH=$HOME/.commandmate-demo/cm.db CM_PORT=<空きポート>` で `node_modules/.bin/tsx server.ts` を起動し、PID を state ファイルに保存
3. `curl -fsS http://127.0.0.1:<port>/` が通るまで待つ

`CM_DEMO_PORT` / `CM_DEMO_HOME` / `CM_DEMO_READY_TIMEOUT` で上書きできる。

本番の撮り直しでは先に `env-down.sh --purge` で DB を捨てること。デモ DB は残るので、消さないと過去のテイクのメッセージ履歴が画面に写り込む。

### 2. 偽エージェントを起動

セッション名は CommandMate 自身の命名規則 `mcbd-<cliTool>-<worktreeId>` に合わせる。worktree id は `<repo 名>-<branch>` を slug 化したもの（`src/lib/git/worktrees.ts` の `generateWorktreeId`）なので、seed リポジトリでは次になる。

```bash
WT=cmdemo-app-feature-demo-dark-mode
.claude/skills/demo-video/scripts/fake-agent.sh \
  .claude/skills/demo-video/fixtures/claude-session-sample.cast \
  --session "mcbd-claude-$WT" --cwd "$CM_DEMO_SEED_ROOT/wt-dark-mode"
```

サーバは同名の既存セッションを**新規作成せずそのまま採用する**（`claude-session.ts` の `hasSession` → `ensureHealthySession`）。カセットの 1 フレーム目が `❯` プロンプトを含むのはこのためで、空 pane は「CLI が落ちた」と判定されてセッションごと kill される。

### 3. シーンを録画

```bash
npx tsx .claude/skills/demo-video/scripts/record-scenes.ts
# 主なオプション: --scene <id> / --out <dir> / --locale ja / --theme dark
#                --viewport 390x844 / --message "..." / --headed
```

Phase A のシーンは 2 本:

| id | 内容 | 同期点 |
|----|------|--------|
| `overview` | ホームの Branches 一覧（複数 worktree の状態表示） | `/api/worktrees` に対象 worktree が出るまで待つ → `branch-list-item` と `status-indicator` の可視化を待つ |
| `send-message` | worktree を開いてメッセージ送信 → 生成開始〜完了 | 送信後 `isProcessing === true` を待ち、続けて `isProcessing === false && isSessionRunning === true` を待つ |

同期点は **サーバ API** を読む。状態ドットの読み上げ名はローカライズされ、エージェント別内訳で上書きされることもあるため、UI 文字列に同期すると非 en ロケールで黙って壊れる。`page.waitForTimeout` は「完成した画を数秒見せる」ためだけに使い、判定には使わない。

viewport 既定は PC 1280x800。`--locale` / `--theme` は Playwright の browser context までは通してあるが、**アプリ側のロケール・テーマ切替は Phase B（#1554）**。

### 4. 出力を確認

```bash
ls -la "$CM_DEMO_VIDEO_DIR"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$CM_DEMO_VIDEO_DIR/send-message.webm"
```

webm は `$HOME/.commandmate-demo/videos/` に出る。**バイナリはコミットしない**（出力先はリポジトリ外なので、そもそも git から見えない）。

### 5. 後片付け（異常終了時も必ず実行する）

```bash
.claude/skills/demo-video/scripts/env-down.sh          # サーバ停止 + demo tmux セッション kill + seed 削除
.claude/skills/demo-video/scripts/env-down.sh --purge  # DB・ログ・録画も消す
```

**手順 1 以降のどこで失敗しても、必ず 5 まで到達させること。** 途中で諦めると隔離サーバがポートを掴んだまま残り、次回の `env-up.sh` が state ファイルの存在を理由に起動を拒否する（これは意図的な設計。壊れた状態に上書きするより止める）。

## 隔離の不変条件

4 つが揃って初めて本番非接触になる。1 つでも崩したら止めること。

1. **専用ポート。** ポート 3000 は `env-up.sh` / `env-down.sh` / `record-scenes.ts` の 3 箇所すべてが拒否する。開発機の稼働インスタンスがそこにいる。
2. **`CM_DB_PATH` は `$HOME` 配下。** `/tmp` `/var` は `validateDbPath` がシステムディレクトリとして弾くため、temp dir は使えない（`src/config/system-directories.ts`）。
3. **`WORKTREE_REPOS` は使い捨て seed のみ。** worktree 探索の唯一の入力がこれ（`getRepositoryPaths`）。`CM_ROOT_DIR` は「リポジトリを含む入れ物」であって走査対象ではない（Issue #1328）。
4. **停止は記録した PID 経由だけ。** `pkill -f commandmate` は無関係なプロセスを巻き込んだ実績があるため使わない。`env-down.sh` はプロセスグループへ signal する前に `ps -o command=` が記録どおりかを確認し、一致しなければ **kill せず異常終了する**（PID 再利用対策）。

シェルの注意点: ループ変数に `path` 等の特殊名を使わないこと（`PATH` を壊して `curl` が command not found になり、ヘルスチェックが偽陰性になる）。bash は 3.2 互換（`declare -A` / `mapfile` 不可）。

## カセット形式

1 行 1 イベントのテキスト。`#` 行と空行は無視。

```
<遅延ms>|@input <TAB> <ペイロード>
```

- ペイロードは `printf %b` で展開する（`\e` `\n` `\t`）。ANSI を含めたまま 1 行に収まり、diff も grep も効く
- `@input` は CommandMate からのメッセージ着信までブロックする。届いた行は `{{INPUT}}` に差し込まれる
- 差し込みは **`%b` 展開の後**に行う。先に差し込むと、メッセージ中の `%` や `\e[` が printf に解釈され、カセットが書いていない制御列で pane が塗られる
- `--speed N` は数値遅延を N で割る。`--dry-run` は寝ずにスケジュールを stderr へ出す（テストが壁時計に依存しないため）

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

同梱の `claude-session-sample.cast` は、この手順で採取済みの実キャプチャ（`tests/unit/skills/orchestrate-monitor/fixtures/live-idle.json` / `live-generating-token.json`、sanitize 済み）から組み立ててある。検出器が実際に見ているアンカーは原文のまま残っている:

| 状態 | アンカー | 実装 |
|------|----------|------|
| running | `esc to interrupt` | `CLAUDE_INTERRUPT_HINT_PATTERN`（下 15 行窓） |
| running | スピナー文字 + `…` | `CLAUDE_THINKING_PATTERN`（下 5 行窓） |
| ready | 行頭 `❯` | `CLAUDE_PROMPT_PATTERN` |
| 応答完了 | 10 文字以上の `─` 罫線 | `CLAUDE_SEPARATOR_PATTERN` |

`tests/unit/skills/demo-video/fake-agent.test.ts` はカセットを**実物の `detectSessionStatus`** に通し、ready → running ×4 → ready を固定している。さらにアンカーを潰した変異カセットでは `running` / `ready` が実際に消えることも確認しているので、この緑は空振りではない。

## Issue #1553 本文との差異（実測を正とした点）

| 本文 | 実測 | 対応 |
|------|------|------|
| `.agents/skills/` へも byte-identical 配置 | 着手時点でリポジトリに `.agents/` が無い | 新規作成して両置き。`tests/unit/skills/demo-video/mirror.test.ts` が無差分を固定 |
| テストは `scripts/tests/` に置く | `npm run test:unit` は `vitest run tests/unit` の**パス絞り込み**なので `.claude/skills/**` の test は CI で 1 度も走らない。さらに `.agents` 側の複製が `npm test` で二重実行される | `tests/unit/skills/demo-video/` に配置（`orchestrate-monitor` と同じ前例） |
| サーバ起動は `PORT=<空きポート>` | `server.ts` が読むのは `CM_PORT`（`getEnvByKey`）。`PORT` は無視される | `CM_PORT` を使用 |

## 制約

- **本番サーバ（127.0.0.1:3000）と本番 `cm.db` には一切触れない。**
- 生成物（webm）はリポジトリ外に出す。コミットしない。
- 録画中に `npm run build` を回さない（稼働サーバの足元でビルドして画面を壊した前例が 2 回ある）。
