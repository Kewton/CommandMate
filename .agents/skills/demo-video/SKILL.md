---
name: demo-video
description: CommandMate の 30 秒デモ動画（日本語版・英語版）を隔離環境で全自動生成する。絵コンテ駆動のシーン録画・テロップ焼き込み・ffmpeg 合成・尺検証まで。「デモ動画」「demo video」「デモを録画」等の指示で使う。
allowed-tools: Bash(.claude/skills/demo-video/scripts/*), Bash(.agents/skills/demo-video/scripts/*), Bash(npx tsx *), Bash(tmux *), Bash(ffprobe *), Bash(ffmpeg *), Read
---

# demo-video

CommandMate の 30 秒デモ動画を全自動生成する。`demo-video.sh` 一発で `demo-30s.ja.mp4` と `demo-30s.en.mp4` が出る。

```bash
.claude/skills/demo-video/scripts/demo-video.sh            # ja + en
.claude/skills/demo-video/scripts/demo-video.sh --check    # 依存＋絵コンテ検証だけ
.claude/skills/demo-video/scripts/demo-video.sh --locale ja --gif --out ~/Desktop/cm-demo
```

出力先の既定は `~/Desktop/commandmate-demo/`。**リポジトリ外**である。mp4 / GIF / 中間 PNG は**コミットしない**（配布は GitHub Release アセット等）。生成後に `git status` がクリーンであることが受入条件のひとつ。

## 設計判断

**実 LLM は使わない。** 実セッションは非決定的で、生成に数分かかり 30 秒に収まらない。代わりにキャプチャ済み ANSI 出力をタイミング付きで再生する「偽エージェント」を tmux セッションで動かす。

置き換えるのは **LLM だけ**で、モックは 1 つも入れていない。CommandMate から見た入力は tmux pane の中身だけなので、`status-detector.ts` / response poller / サイドバーの状態ドットはすべて製品コードのまま動く。偽エージェントが差し込まれるのは `tmux capture-pane` が返すバイト列の出所だけである。

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
│   ├── record-scenes.ts    # Playwright をライブラリとして使うシーン録画
│   ├── storyboard.ts       # 絵コンテの検証と尺の機械算出（YAML サブセット）
│   ├── render-overlays.ts  # テロップ／カードを HTML から PNG 化
│   └── compose.sh          # ffmpeg 合成 + 尺検証ゲート
├── storyboard/
│   └── default.yaml        # 文言を編集する唯一の場所
├── templates/
│   ├── telop.html          # 画面下部のテロップ帯（透過 PNG）
│   └── card.html           # タイトル／アウトロカード（不透過 PNG）
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

いずれかが欠けたら**導入コマンドを提示して停止する**。録画途中で落ちると隔離サーバと tmux セッションが残る。`demo-video.sh` は最初にこれを自前で行い、欠けていれば `brew install` を提示して 1 本目の録画に入る前に止まる。

## パイプライン（demo-video.sh がやること）

ロケールごとに、次を通しで実行する。どこかで失敗したら `trap` で `env-down.sh --purge` まで必ず到達する。

1. 依存チェックと**絵コンテの検証**（不正なら 1 秒で止まる。2 回分の録画を無駄にしないため先に回す）
2. `env-up.sh` → `fake-agent.sh`
3. `record-scenes.ts --locale <L>` — UI を当該ロケールに切り替えて 4 シーン録画
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
npx tsx .claude/skills/demo-video/scripts/record-scenes.ts --locale ja
# 主なオプション: --scene <id> / --out <dir> / --locale ja|en / --theme dark
#                --viewport 1440x900 / --message "..." / --headed
```

シーンは**部品**であり、1 本の絵コンテが全部を使う必要はない（#1575）。絵コンテは使う id だけを並べ、`demo-video.sh` はその id だけを撮る:

| id | viewport | 内容 | 同期点（prepare） |
|----|----------|------|------------------|
| `sessions-overview` | pc | ホームの Branches 一覧（複数 worktree の状態表示） | `/api/worktrees` に対象 worktree が出るまで |
| `send-and-generate` | pc | worktree を開いてメッセージ送信 → 生成開始 | `isSessionRunning === true`。送信後は `isProcessing === true` を待つ |
| `respond-from-mobile` | **mobile** | スマホ幅で承認シートを開いて承認 | `isWaitingForResponse === true` → 承認後 `false` に戻るまで |
| `complete` | pc | ready に戻った一覧 | `isProcessing === false && isSessionRunning === true` |
| `add-repository` | pc | リポジトリ画面で**パス指定**の登録（clone URL ではない＝ネットワークに出ない） | `/api/repositories` に `CM_DEMO_SEED_REPO_2` が**無い**こと → 登録後は出るまで |
| `sync-worktrees` | pc | 外部で作られた worktree を「すべて同期」で認識させる | `/api/worktrees` に `cmdemo-app-feature-demo-api-cache` が**無い**こと → 同期後は出るまで |
| `review-diff` | pc | Git アクティビティを開いて未コミット差分を表示 | `/api/worktrees/<id>/git/staged` の `unstaged` が非空になるまで |

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

- **尺の伸縮**: 実尺が宣言尺より短ければ最終フレームを `tpad` で引き延ばし、長ければ**頭を切って末尾を残す**。どのシーンも見せ場は末尾（承認シート、完了した一覧）にあるため。
- **タイムコードは絵コンテから機械算出**。手書きのタイムコードはどこにも無い。絵コンテで尺を変えれば以降のテロップ位置も自動で動く。
- **尺検証ゲート**: `ffprobe` の実測が `duration ± 0.5s` を外れたら **exit 1**。落ちたときはシートごとの宣言尺と実測尺の差分表を stderr に出し、中間ファイルを残す。
- 単体でゲートだけ回すこともできる: `compose.sh --verify out.mp4 --expect 30`、測定済みの秒数なら `--compare 30.2 --expect 30`。
- **引数の検証は ffmpeg / ffprobe の存在確認より先**に行う。逆順にすると、ffmpeg の無い環境では引数の誤りがすべて `required command not found: ffmpeg` として返り、開発機では踏めず CI でだけ落ちる（PR #1562 で実際に発生）。依存チェック自体は合成の直前に残してある。

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

**手順 1 以降のどこで失敗しても、必ず 6 まで到達させること。** 途中で諦めると隔離サーバがポートを掴んだまま残り、次回の `env-up.sh` が state ファイルの存在を理由に起動を拒否する（これは意図的な設計。壊れた状態に上書きするより止める）。`demo-video.sh` は `trap ... EXIT INT TERM` でこれを保証する。

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
- `@input` は CommandMate からのメッセージ着信までブロックする。届いた行は `{{INPUT}}`、そのパスの **1 本目**の入力は `{{TASK}}` に差し込まれる
- 承認プロンプトの後は `{{TASK}}` を使う。そこでは `{{INPUT}}` が承認の `y` になっており、それを指示として画面に映すと製品がしていないことを主張することになる
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
| waiting | `Do you want to proceed?` + `❯ 1. Yes` / `2. No, …` | `detectMultipleChoicePrompt`（`prompt-yes-no.json` の実キャプチャ） |

`tests/unit/skills/demo-video/fake-agent.test.ts` はカセットを**実物の `detectSessionStatus`** に通し、ready → running ×3 → waiting → running ×2 → ready を固定している。さらにアンカーを潰した変異カセット（`esc to interrupt` を消す／`❯` を消す／番号付き選択肢を潰す／質問行を潰す）では該当ステータスが実際に消えることも確認しているので、この緑は空振りではない。

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

## 制約

- **本番サーバ（127.0.0.1:3000）と本番 `cm.db` には一切触れない。**
- 生成物（webm）はリポジトリ外に出す。コミットしない。
- 録画中に `npm run build` を回さない（稼働サーバの足元でビルドして画面を壊した前例が 2 回ある）。
