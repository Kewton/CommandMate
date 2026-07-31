---
name: orchestrate-monitor
description: /orchestrate のワーカー監視レシピ（capture 解析・状態判定・介入判断・完了検証）を、bash 3.2 互換の実行可能スクリプトと fixture ベーステストとして資産化したもの。並列ワーカーを監督するときに使う。
allowed-tools: Bash(.claude/skills/orchestrate-monitor/scripts/*), Bash(git worktree list), Bash(tmux *)
---

# orchestrate-monitor

`/orchestrate`（`/pm-auto-issue2dev` の並列運用）で実証済みの**ワーカー監視レシピ**を、
オペレータ／セッションメモリに滞留していた暗黙知から取り出し、**テスト済みスクリプト**にしたもの。
判定ロジック（生成中判定・STARTED ガード・prompt 分類・完了検証）は fixture ベースの単体テストで
固定されているので、プロンプトから再発明するのではなく、この中核を移植して使える。

> **なぜ Skill 化するか**: 監視ノウハウは実運用の失敗から学ばれたが、バージョン管理外にあり再現・移転不能だった。
> 同種の誤報（未起動 idle の COMPLETE 誤報／検証ガード自身の偽陽性）が複数回再発したため、テストで封じる。

## 構成

```
.claude/skills/orchestrate-monitor/
├── SKILL.md
└── scripts/
    ├── monitor-lib.sh       # 共有ヘルパー（JSON scalar 抽出・ANSI 正規化・アンカー検出・違反カウント）
    ├── classify-state.sh    # capture --json 1 ポーリング → 状態トークン
    ├── verify-completion.sh # タスク状態を一次ソースとする完了判定（＋STARTED ガード、回帰#1）
    ├── verify-scope.sh      # 偽陽性しないスコープ検証（回帰#2）
    ├── quality-gate.sh      # exit code を実測する品質ゲート
    ├── monitor.sh           # オペレータ用監視ループ（temp ファイル状態）
    ├── hooks-git.sh         # 作業量フックの参考実装（worktree-id → 実 checkout の commit / 変更数）
    └── hooks-task.sh        # タスク状態フック（worktree-id → 実行契約の裁定済みステータス）
```

テスト: `tests/unit/skills/orchestrate-monitor/`。fixture は**実 `capture --json` を採取した生 payload
（ANSI エスケープを含む）**で、`fixture-fidelity.test.ts` が ANSI の残存を CI で強制する
（ANSI を剥がした fixture は「製品が出力しない形」を検証してしまう＝回帰#3 の再生産）。
`npm run test:unit` に含まれ、`bash -n` 構文チェックも `syntax.test.ts` として同梱される。

## 使い方

```bash
# 1 つ以上の worktree-id を監督する
CM="npx commandmate@latest" \
  .claude/skills/orchestrate-monitor/scripts/monitor.sh \
  --session-prefix mcbd-claude \
  --interval 20 --idle-threshold 8 <worktree-id> [<worktree-id> ...]

# 中核だけを個別に使う（Claude が監督中に呼ぶのはこちら）
commandmate capture <id> --json > poll.json
.claude/skills/orchestrate-monitor/scripts/classify-state.sh --json poll.json
#   -> NOT_RUNNING | RATE_LIMIT | GENERATING | PROMPT | IDLE
```

判定順（`classify-state.sh`）。**順序自体がガード**であり、各分岐は入力注入か抑止のどちらかを
引き起こすので、早すぎる発火は健全なセッションを壊す:

```
NOT_RUNNING → is_retrying(→GENERATING) → PROMPT → GENERATING → RATE_LIMIT → IDLE
```

**`--session-prefix` は実測して渡すこと。** 介入（承認 Enter / rate limit の `a` / 再送）は
`tmux send-keys -t <prefix>-<worktree-id>` で撃つが、CommandMate の実セッション名は
`mcbd-<エージェント>-<worktree-id>` である（`src/lib/session/claude-session.ts` の `getSessionName()`）。
既定の `cm` は一致しないうえ `tmux send-keys` の失敗は握り潰されるので、**介入が 1 回も届かないまま
監視が続く**。`tmux ls` で実名を確認してから渡す。

`--resend-message` / `--max-resends` はリトライ枯渇死からの再送設定（既定 `continue` / 2 回）。
`--max-polls N` は N 回ポーリングしたら（ワーカーが未完了でも）exit 0 で抜ける停止条件。既定 0 =
全ワーカーが COMPLETE になるまで回り続ける（運用時の挙動は従来どおり）。判定ロジックには一切
関与せず、ループを外部から kill せずに決定論的に終わらせるためのもの（#1527 の単体テストと、
`--max-polls 1` の 1 回だけ様子を見るプローブで使う）。

### `--verbose`: ポーリングごとの状態ログ（#1533）

既定の stdout は**介入・capture 失敗・終局判定（COMPLETE / VERIFY_FAILED / NOT_STARTED）・起動/停止**だけで、
「何回ポーリングして各状態が何回出たか」は残らない。`--verbose` を付けると 1 ポーリング 1 行の
固定フォーマットが追加される（**opt-in。付けない限り既定出力は 1 バイトも変わらない**）:

```
monitor[<wid>]: poll <N> -> <STATE> started=<0|1> streak=<n> commits=<n> uncommitted=<n> task=<status|-> verdict=<VERDICT>
```

`<STATE>` は `classify-state.sh` の出力、`<VERDICT>` は `verify-completion.sh` の出力、間の
key=value は**その判定に実際に渡した入力**。だから「なぜ COMPLETE にならないのか」を
verdict だけでなく根拠つきで読める。集計はそのまま awk / sort に流せる:

```bash
# 状態分類の分布
grep -oE 'poll [0-9]+ -> [A-Z_]+' monitor.log | awk '{print $4}' | sort | uniq -c
# 総ポーリング数（worker 別）
grep -cE '^monitor\[w1\]: poll ' monitor.log
```

### `--hooks` / `MONITOR_HOOKS`: 完了フックの配線（#1533）

`monitor.sh` の `count_commits` / `count_uncommitted` は**既定でスタブ（常に 0）**。ループ単体で
動かすための既定値だが、`verify-completion.sh` は `commits=0 かつ uncommitted=0` を
**「タスクが送られていない」兆候**として扱う（STARTED ガード、下記 7）ため、**素の実行では
COMPLETE 分岐に到達しない**。実運用では必ずフックを供給する:

```bash
# 同梱の参考実装をそのまま使う
MONITOR_HOOKS_BASE=origin/develop \
  .claude/skills/orchestrate-monitor/scripts/monitor.sh \
  --hooks .claude/skills/orchestrate-monitor/scripts/hooks-git.sh <worktree-id> ...

# env でも指定できる（両方あればフラグが勝つ）
MONITOR_HOOKS=.../hooks-git.sh .../monitor.sh <worktree-id> ...
```

指定されたファイルは**スタブ定義の後に source** される。定義した関数だけが上書きされ、片方だけ
定義したファイルでももう片方はスタブのまま動く。指定したのにファイルが無い場合は
**exit 2 で即座に失敗**する（黙ってスタブに落ちると「全 worker が NOT_STARTED」という
一見もっともらしい嘘の観測になるため）。

**`--hooks` は繰り返し指定でき、左から順に source される**（フラグを1つでも与えると
`MONITOR_HOOKS` の既定は捨てられる）。契約付き委任では作業量とタスク状態の両方が要るので、
`hooks-git.sh` と `hooks-task.sh` を並べて渡す（下記「タスク状態を一次ソースにする」）。

`hooks-git.sh` は worktree-id を `git worktree list --porcelain` から実 checkout に解決し
（id = `<repo>-<branch>` の slug ＝ `generateWorktreeId()` と同じ正規化。`<repo>` はメイン
worktree のディレクトリ名）、`git -C <path> log --oneline <base>..HEAD` と
`git -C <path> status --porcelain` で数える。`MONITOR_HOOKS_BASE`（既定 `origin/develop`）/
`MONITOR_HOOKS_REPO`（既定 `.`）/ `MONITOR_WORKTREE_ROOT` で調整する。base ref が解決できない
場合は起動時に stderr へ警告する（黙って 0 を返すと、全部コミット済みの worker が
uncommitted=0 と合わさって最後に NOT_STARTED と誤報されるため）。

### タスク状態を一次ソースにする（#1581）

`send --contract` で委任した worktree では、サーバが検証ゲートを回してタスクに**終局ステータス**を
記録する。これは裁定結果であって推定ではないので、**完了判定の一次ソースはこちら**であり、
capture のテキスト解析は契約無しの委任と未終局タスクのためのフォールバックに降格する
（#1539 設計原則 4「文字列解析の降格」）。

```bash
.claude/skills/orchestrate-monitor/scripts/monitor.sh \
  --hooks .../hooks-git.sh --hooks .../hooks-task.sh <worktree-id> ...
```

`hooks-task.sh` は `commandmate task list <worktree-id> --limit 1` を引く。**task id は要らない**
（`send --contract` が stdout に出す id を監視ループへ渡す必要がない）: `task list` は worktree だけで
答えられ、新しい順に返すので 1 行目が実行中の契約である。API（`GET /api/worktrees/:id/tasks`）でも
同じ情報は取れるが、シェルからは CLI の方が素直（base URL と認証トークンの解決を CLI が持っている）。

| タスク状態 | verdict | 意味 |
|---|---|---|
| `succeeded` | `COMPLETE` | ゲート合格。work-evidence もサーバ側で済んでいるので commit 数の裏取りは不要 |
| `failed` / `cancelled` | `VERIFY_FAILED` | 終局だが**マージ不可**。`commandmate verify <id> --json` で失敗ゲートを見て再指示 |
| `not_started` | `NOT_STARTED` | 作業証跡ゼロ |
| `pending` / `running` / `waiting_input` / `verifying` | （フォールバック） | 未終局。capture ヒューリスティクスが判定する |
| 空 / 未知 | （フォールバック） | 契約無し・ledger 無し・旧 CLI。**必ず従来動作に落ちる**（勝手な verdict を作らない） |

2 つの落とし穴を明示的に塞いでいる:

- **`COMPLETE` ≠ 「終わった」**。`VERIFY_FAILED` を別トークンにしたのは、「ワーカーが止まった」と
  「成果物が正しい」を同じ信号として読まないため。これが #1539 が exit code に移した当のもの。
- **生存中のペインは終局ステータスに勝つ**。`task list --limit 1` は最新のタスクを返すので、
  過去の契約のあとに素の send をした worktree では古い裁定を読みうる。`verify-completion.sh` は
  `GENERATING` / `PROMPT` / `RATE_LIMIT` を**タスク状態より先に**評価してこれを拒否する。

> **monitor の COMPLETE をマージ可否の裁定に使わないこと。** 契約付き委任の最終裁定は
> `commandmate wait <id> --on-prompt human --verify` の exit code（`0` 合格 / `20` 検証不合格 /
> `21` 作業証跡ゼロ）である。monitor は「いつ見に行くか」を決める道具であって、合否を決める道具ではない。

### #1513 G2 の証拠採取レシピ

G2（「監視の誤報 0 を実運用で示す」）が要求する 4 点 —— **総ポーリング数・状態分類の分布・介入全件・
完了判定の根拠** —— は、この 1 コマンドで 1 本のログに揃う:

```bash
MONITOR_HOOKS_BASE=origin/develop \
.claude/skills/orchestrate-monitor/scripts/monitor.sh \
  --verbose \
  --hooks .claude/skills/orchestrate-monitor/scripts/hooks-git.sh \
  --session-prefix mcbd-claude \
  --interval 20 --idle-threshold 8 \
  <worktree-id> ... 2>&1 | tee monitor.log
```

| G2 の要求 | ログからの取り出し方 |
|---|---|
| 総ポーリング数 | `grep -cE '^monitor\[<wid>\]: poll ' monitor.log` |
| 状態分類の分布 | `grep -oE 'poll [0-9]+ -> [A-Z_]+' monitor.log \| awk '{print $4}' \| sort \| uniq -c` |
| 介入全件 | `grep -E "sending 'a'\|resending\|resend budget spent" monitor.log`（承認 Enter はサイレント。総数は COMPLETE 行の `approvals=` に出る） |
| 完了判定の根拠 | poll 行の `started= / streak= / commits= / uncommitted= / task= / verdict=`。COMPLETE した poll 行がその worker の判定根拠そのもの |
| capture 失敗 | `grep -c 'capture failed' monitor.log`（poll 行は出ないので、総ポーリング数と別に数える） |

**`--hooks` を付け忘れると誤報 0 は測れない**：commits/uncommitted が常に 0 になり、完走した
worker まで NOT_STARTED として記録される。G2 のログは必ずフック付きで採ること。

---

## 監視レシピと根拠（どの失敗から学んだか）

各ルールは実運用の失敗に紐づく。カッコ内はセッションメモリの出所。

### 状態検知（`classify-state.sh` / `monitor-lib.sh`）

1. **主シグナルは `commandmate capture <id> --json`**。参照フィールドは `content` / `realtimeSnippet`。
   `output` / `text` は**存在しない**（`src/lib/session/current-output-builder.ts` の payload で確認）。
2. **アンカー照合は ANSI 除去後に行う**（`ml_strip_ansi`）。実 TUI は矢印と数値の間に色リセットを挟む:
   `(4m 25s · ↓\u001b[39m \u001b[38;5;246m14.9k tokens`（`\u001b` は生 JSON 中の 6 文字） → 生 JSON への `↓ [0-9]` grep は**実機で一度も
   発火しない**。#1512 の初版は ANSI を除去済みの手書き fixture を持っていたため単体テストだけが緑で、
   実運用では**全ワーカーが IDLE 誤分類**され `NOT_STARTED` を鳴らし続けた（Issue #1522 / 回帰#3）。
   TUI がマーカーと値の間に挟む**ノーブレークスペース**（`❯` の直後、`\u00a0`）も同じ理由で正規化する。
3. **アンカーは「いま画面に出ているもの」＝`realtimeSnippet` に限定する**（`ml_pane_text`）。
   `content` は *lastCapturedLine 以降の差分*なので、ループの初回ポーリングは**バッファ全体**＝
   orchestrator が送ったタスク指示文まで返す。その指示文に識別子 `ml_has_rate_limit` が含まれていたため
   `rate.?limit` が一致し、**健全な生成中ワーカー2件に `a` が撃ち込まれた**（Issue #1522 / 回帰#7）。
   逆向きの事故も同時に防ぐ：履歴に流れた spinner 行（`↓ 14.9k tokens`）を拾うと終了済みセッションを
   永久に GENERATING と誤判定する。
4. **生成中アンカーは 3 つ**：トークンカウンタ `↓ 14.9k tokens` / `Waiting for [0-9]+ background agent` /
   フッタヒント `esc to interrupt`。
   - `esc to interrupt` は**ターン実行中のみ**表示される（idle 時は `? for shortcuts`）。トークン出力前に
     数分思考するワーカー（`✳ Cascading… (19s)` にはカウンタが無い）を拾うための唯一の手段
     （回帰#4）。
   - `[0-9]+m [0-9]+s` は**使わない**：完了後の集計行 `✻ Brewed for 8m 55s` に誤マッチし、
     終了済みセッションを永久に「生成中」と誤判定する（`feedback_orchestrate_monitor_recipe`）。
     → 回帰 fixture: `idle-brewed-summary.json` は IDLE に分類される。
   - **`isGenerating` フィールドに依存しない**：これは `sessionStatus==running && thinking_indicator` の
     狭い条件でしか true にならず、生成中でも false になりうる。だから text アンカーを一次シグナルにする
     （`feedback_orchestrate_monitor_started_guard`）。→ fixture `generating-bg-agent.json` は
     `isGenerating:false` でもアンカーで GENERATING。
5. **CLI 自身のリトライ中（`ml_is_retrying`）は「生存」＝ GENERATING**。
   `✻ 529 Overloaded · Retrying in 4s · attempt 7/10` の間セッションは生きているので、介入は**再開でなく
   queue** される（実測: `❯ a` が composer に残り `Press up to edit queued messages`。リトライ成功後に
   配信され、ワーカーが契約外の作業を始めうる）。`rate-limit` 分岐より**前**に評価する（回帰#5）。
   - `attempt 10/10` は枯渇後も画面に残るため、**idle フッタ（`? for shortcuts`）を veto** に使う。
     これが無いと死んだセッションが永久に「生存」と読まれ、再送経路に到達できない。
6. **`RATE_LIMIT` は生成中を否定してから最後に評価し、アンカーはバナー固有の言い回しに限定する**。
   本物の usage limit は**ターンを停止させる**ので、`esc to interrupt` が出ているフレームのバナー風文字列は
   定義上ワーカーが読み書きしているコード／散文である。裸の `rate.?limit` は削除した：`rate_limit` /
   `rate-limit` を含むソースや散文に一致して**健全なワーカーへ入力を注入した**（Issue #1522）。これは
   `ml_count_violations` について既に明記していた「散文一致の誤報」と同型の失敗（回帰#7）。
7. **STARTED ガード**：生成アンカーを一度も観測していない idle を COMPLETE と誤報しない。
   `commits=0 かつ uncommitted=0` は**完了ではなく未起動の兆候**（`send` がタスクを composer に残し
   Enter 未確定で worker が起動しない）（`feedback_orchestrate_monitor_started_guard`）。
   → 回帰#1: `verify-completion.sh`、fixture 相当は `verify-completion.test.ts`。
8. **AskUserQuestion 停滞**：`❯ 1. Submit answers` は製品の prompt 検出（`isPromptWaiting`）に**非マッチ**。
   text marker `❯ [0-9]+\.` で PROMPT と判定する（`feedback_orchestrate_askuserquestion_and_ci_522`）。
   → fixture `prompt-submit-answers.json`（`isPromptWaiting:false` でも PROMPT）。
   **`PROMPT` は `GENERATING` より先に評価する**：権限プロンプト表示中もフッタは `esc to interrupt` のままで
   `isPromptWaiting` / `isSelectionListActive` は false（実測）。逆順だとプロンプトが永久に承認されない。

### 介入・自動復旧（`monitor.sh`）

9. **権限プロンプト自動承認**：worker 停滞の主因は Claude Code 権限プロンプト。Enter 自動承認を**サイレント＋
   カウンタ化**し、通知を氾濫させない（`feedback_worker_permission_prompt_autoapprove` /
   `feedback_orchestrate_monitor_recipe`）。承認は commit 必須ゲート（＝完了検証）とセットで扱う。
10. **Rate limit は待たず即 "a" 送信**で再開。「1M context credits 必須」ブロッカーは credits 有効化＋"a"
    （`feedback_rate_limit_immediate_retry` / `feedback_orchestrate_1m_context_credits`）。
    ただし**撃つ前に GENERATING を否定する**こと（上記 6）。
11. **リトライ枯渇死からは再送で復帰する**（`--resend-message` / `--max-resends`）。`attempt 10/10` 失敗後は
    idle プロンプトに落ち、誰も再送しないので放置される。放置より悪いのは、作業途中の uncommitted 変更が
    残った状態で idle streak が閾値を超え **COMPLETE と誤報**されることなので、完了判定より前に再送する。
    入力を注入する分岐なので条件は最小に絞る（Issue #1522）:
    - `IDLE` のみ（＝リトライ中 `GENERATING` とプロンプトには絶対に触らない）
    - idle 閾値に到達済み（一瞬のフレームでは撃たない）
    - `ml_has_terminal_api_error` は**現在のペインのみ**を見る（再開後に画面外へ流れたエラーは対象外）
    - `--max-resends` で打ち切り、以後はオペレータへエスカレーション
12. **完了待機は `commandmate wait <id> --on-prompt human`**。既定は prompt 検出で即返るため監督ループが
    空回りする（`feedback_orchestrate_wait_on_prompt_human`）。

### 完了検証（`verify-completion.sh` / `verify-scope.sh`）

13. **契約付き委任では完了判定の一次ソースはタスク状態**（`hooks-task.sh`）で、capture 解析は
    フォールバック。マージ可否の最終裁定は `wait --verify` の exit code であり、monitor の
    `COMPLETE` ではない。詳細は上記「タスク状態を一次ソースにする（#1581）」。
14. **merge 成否は state=MERGED を確認してから Issue close**（未マージ Issue の誤クローズ防止）
    （`feedback_orchestrate_changelog_conflict_close_guard`）。
15. **スコープ完遂は受入ゲートでなく grep 実数で検証**。NUL 混入ファイルで grep がバイナリ扱いするため
    `grep -a` を使う（`feedback_orchestrate_scope_completeness` / `reference_grep_blind_nul_test_file`）。
16. **検証ガード自身の偽陽性に注意**（回帰#2、`verify-scope.sh`）：
    - 禁止パターンが**散文・コメント中**に出現しただけで違反と数える誤報
      （bare `npx commandmate` が「なぜ @latest が必要か」を説明する文に一致した実例）。
      → コメント行（`^[[:space:]]*#`）を除外する。fixture `scope-clean.txt` は CLEAN。
    - `grep -c ... || echo 0` は無マッチ時に `0\n2` 相当の二行を作り数値テストを壊す
      （`feedback_sed_grep_guard_false_pass`）。→ `grep -c` の出力をそのまま使う。
    - grep 実数で under-delivery を疑ったら**必ず該当行を目視してから**差し戻す。

### スクリプト品質（実装制約）

17. **bash 3.2 互換**（macOS 既定の `/bin/bash` は 3.2.57）：連想配列 `declare -A` 不可・`mapfile` 不可・
    `${var,,}` 不可。状態は**整数 index の並列配列と temp ファイル**で持つ
    （`feedback_monitor_bash32_no_assoc_arrays`）。CI は `syntax.test.ts` が `bash -n` を回す。
18. **ループ変数に `path` 等の特殊名を使わない**：zsh/bash で `path` は `PATH` に tie され、curl/tmux が
    command not found 化して health check が偽陰性になる（`feedback_zsh_path_loop_var_clobbers_path`）。
19. **品質ゲートで exit code を隠さない**（`quality-gate.sh`）：`cmd | grep ...` は `$?` を grep に渡し
    非ゼロ終了を隠す。vitest は「全テスト緑・Unhandled Rejection で exit 1」を出しうる。
    `cmd > log 2>&1; echo $?` で実測する（`feedback_quality_gate_grep_hides_exit_code`）。
20. **`sed` は `LC_ALL=C` で回す**：ペイン capture には途中で切れたマルチバイト文字が混じりうる。
    UTF-8 ロケールの BSD sed はそこで `illegal byte sequence` を吐いて停止する。

---

## 回帰テスト（red→green で固定したパターン）

| # | 誤報／実害 | 出所 | ガード | テスト |
|---|------|------|--------|--------|
| 1 | 未起動 idle を COMPLETE と誤報 | `feedback_orchestrate_monitor_started_guard` | `verify-completion.sh` の STARTED ガード | `verify-completion.test.ts` |
| 2 | 検証ガード自身の偽陽性（散文一致・`\|\| echo 0`） | 同上 / `feedback_sed_grep_guard_false_pass` | `verify-scope.sh` のコメント除外＋素の `grep -c` | `verify-scope.test.ts` |
| 3 | ANSI 除去済み手書き fixture が「製品が出ない形」を検証し、生成中を全て IDLE 誤分類 | #1522 | `ml_strip_ansi` ＋ 生 capture fixture | `fixture-fidelity.test.ts` / `live-generating-token.json` |
| 4 | トークン出力前の生成中を IDLE 誤分類 | #1522 | 生成中アンカーに `esc to interrupt` | `live-generating-pre-token.json` |
| 5 | CLI 自身の 5xx バックオフを停止と誤認し、介入が queue される | #1522 | `ml_is_retrying`（idle フッタ veto つき）を最優先 | `live-retrying-529.json` / `monitor-lib.test.ts` |
| 6 | リトライ枯渇死が放置される／半端な作業で COMPLETE 誤報 | #1522 | `ml_has_terminal_api_error` ＋ `monitor.sh` の再送 | `live-api-error-exhausted.json` / `monitor-resend.test.ts` |
| 7 | `rate.?limit` が散文・ソースに一致し**健全なワーカーへ `a` を注入** | #1522 | バナー限定アンカー ＋ `RATE_LIMIT` を最後に評価 ＋ `ml_pane_text` | `live-idle-rate-limit-source.json` / `live-generating-task-text-scrollback.json` |
| 8 | `count_commits`/`count_uncommitted` がスタブ固定で、**COMPLETE 分岐が実運用で一度も発火しない**（完走した worker まで NOT_STARTED と記録される） | #1533 | `--hooks` / `MONITOR_HOOKS` で供給、参考実装 `hooks-git.sh` を同梱 | `monitor-observability.test.ts`（フック無しで COMPLETE 到達不能 ⇄ フック有りで到達、を両方向で固定） |
| 9 | **ゲート不合格の worker を COMPLETE と報告**（commit も idle streak も「完了」に見えるので、capture 由来の信号だけでは検証不合格と区別できない） | #1581 | タスク状態を一次ソースにし、`failed` / `cancelled` を `VERIFY_FAILED` として分離 | `verify-completion.test.ts` / `monitor-task-source.test.ts` |
| 10 | 古い契約の終局ステータスを現在の裁定として読み、**生成中の worker を COMPLETE と誤報** | #1581 | 生存ペイン（`GENERATING`/`PROMPT`/`RATE_LIMIT`）をタスク状態より先に評価 | `verify-completion.test.ts`（stale veto）/ `monitor-task-source.test.ts` |

いずれも naive 実装で red → ガード実装で green にした（#3〜#7 は #1512 の初版実装に対して red）。
#8 は両方向テスト（対照＋変異注入）で固定している：`--verbose` を既定 ON にする / フックをスタブより
先に source する / poll 行の書式を変える / 参考フックの commit 数を 0 固定にする、のいずれの変異でも
該当テストが実際に赤くなることを確認済み。

## fixture の作り方（実機採取）

fixture は**使い捨てセッションで capture** する。実 worker session は composer 残テキストで汚染され
流用不可（`feedback_orchestrate_sibling_fold_and_real_tui_capture`）。

```bash
commandmate capture <throwaway-id> --json | tee tests/unit/skills/orchestrate-monitor/fixtures/<name>.json
```

**手で書かないこと。ANSI を剥がさないこと。** これが本 Skill 唯一の致命的な失敗モードで、#1512 の初版は
実際にこれを踏んだ（単体テスト全 green のまま実運用では 1 度もアンカーが発火しなかった）。

- ステータス行・フッタ行・composer 行の ANSI エスケープと NBSP は**そのまま残す**。1 つ剥がすと fixture は
  「製品が出力しない形」になり、テストの意味が消える。`fixture-fidelity.test.ts` が CI で残存を強制する。
- 実 capture には**作業指示文・絶対パス・セッション ID** が載る。コミット前に無関係な本文だけを短いダミーへ
  置換する（ANSI を壊さないよう、値の文字列単位で差し替える）。
- 派生 fixture（実フレームの一部を差し替えて作った異常系）は、テスト側のコメントに**何を差し替えたか**を書く。
