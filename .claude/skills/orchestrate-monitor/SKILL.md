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
    ├── monitor-lib.sh       # 共有ヘルパー（JSON scalar 抽出・アンカー検出・違反カウント）
    ├── classify-state.sh    # capture --json 1 ポーリング → 状態トークン
    ├── verify-completion.sh # STARTED ガード付き完了判定（回帰#1）
    ├── verify-scope.sh      # 偽陽性しないスコープ検証（回帰#2）
    ├── quality-gate.sh      # exit code を実測する品質ゲート
    └── monitor.sh           # オペレータ用監視ループ（temp ファイル状態）
```

テスト: `tests/unit/skills/orchestrate-monitor/`（fixture は実 `capture --json` 形状に忠実）。
`npm run test:unit` に含まれ、`bash -n` 構文チェックも `syntax.test.ts` として同梱される。

## 使い方

```bash
# 1 つ以上の worktree-id を監督する
CM="npx commandmate@latest" \
  .claude/skills/orchestrate-monitor/scripts/monitor.sh \
  --interval 20 --idle-threshold 8 <worktree-id> [<worktree-id> ...]

# 中核だけを個別に使う（Claude が監督中に呼ぶのはこちら）
commandmate capture <id> --json > poll.json
.claude/skills/orchestrate-monitor/scripts/classify-state.sh --json poll.json
#   -> NOT_RUNNING | RATE_LIMIT | GENERATING | PROMPT | IDLE
```

`monitor.sh` の `count_commits` / `count_uncommitted` は運用の checkout に合わせて配線するフック。
既定は 0 を返す（ループ単体で動く）ので、実運用では worker の作業ツリーに向ける。

---

## 監視レシピと根拠（どの失敗から学んだか）

各ルールは実運用の失敗に紐づく。カッコ内はセッションメモリの出所。

### 状態検知（`classify-state.sh` / `monitor-lib.sh`）

1. **主シグナルは `commandmate capture <id> --json`**。参照フィールドは `content` / `realtimeSnippet`。
   `output` / `text` は**存在しない**（`src/lib/session/current-output-builder.ts` の payload で確認）。
2. **生成中アンカーは `↓ [0-9]`**（トークンカウンタ `↓ 1.4k tokens`）と `Waiting for [0-9]+ background agent`。
   - `[0-9]+m [0-9]+s` は**使わない**：完了後の集計行 `✻ Brewed for 8m 55s` に誤マッチし、
     終了済みセッションを永久に「生成中」と誤判定する（`feedback_orchestrate_monitor_recipe`）。
     → 回帰 fixture: `idle-brewed-summary.json` は IDLE に分類される。
   - **`isGenerating` フィールドに依存しない**：これは `sessionStatus==running && thinking_indicator` の
     狭い条件でしか true にならず、生成中でも false になりうる。だから text アンカーを一次シグナルにする
     （`feedback_orchestrate_monitor_started_guard`）。→ fixture `generating-bg-agent.json` は
     `isGenerating:false` でもアンカーで GENERATING。
3. **STARTED ガード**：生成アンカーを一度も観測していない idle を COMPLETE と誤報しない。
   `commits=0 かつ uncommitted=0` は**完了ではなく未起動の兆候**（`send` がタスクを composer に残し
   Enter 未確定で worker が起動しない）（`feedback_orchestrate_monitor_started_guard`）。
   → 回帰#1: `verify-completion.sh`、fixture 相当は `verify-completion.test.ts`。
4. **AskUserQuestion 停滞**：`❯ 1. Submit answers` は製品の prompt 検出（`isPromptWaiting`）に**非マッチ**。
   text marker `❯ [0-9]+\.` で PROMPT と判定する（`feedback_orchestrate_askuserquestion_and_ci_522`）。
   → fixture `prompt-submit-answers.json`（`isPromptWaiting:false` でも PROMPT）。

### 介入・自動復旧（`monitor.sh`）

5. **権限プロンプト自動承認**：worker 停滞の主因は Claude Code 権限プロンプト。Enter 自動承認を**サイレント＋
   カウンタ化**し、通知を氾濫させない（`feedback_worker_permission_prompt_autoapprove` /
   `feedback_orchestrate_monitor_recipe`）。承認は commit 必須ゲート（＝完了検証）とセットで扱う。
6. **Rate limit は待たず即 "a" 送信**で再開。「1M context credits 必須」ブロッカーは credits 有効化＋"a"
   （`feedback_rate_limit_immediate_retry` / `feedback_orchestrate_1m_context_credits`）。
7. **完了待機は `commandmate wait <id> --on-prompt human`**。既定は prompt 検出で即返るため監督ループが
   空回りする（`feedback_orchestrate_wait_on_prompt_human`）。

### 完了検証（`verify-completion.sh` / `verify-scope.sh`）

8. **merge 成否は state=MERGED を確認してから Issue close**（未マージ Issue の誤クローズ防止）
   （`feedback_orchestrate_changelog_conflict_close_guard`）。
9. **スコープ完遂は受入ゲートでなく grep 実数で検証**。NUL 混入ファイルで grep がバイナリ扱いするため
   `grep -a` を使う（`feedback_orchestrate_scope_completeness` / `reference_grep_blind_nul_test_file`）。
10. **検証ガード自身の偽陽性に注意**（回帰#2、`verify-scope.sh`）：
    - 禁止パターンが**散文・コメント中**に出現しただけで違反と数える誤報
      （bare `npx commandmate` が「なぜ @latest が必要か」を説明する文に一致した実例）。
      → コメント行（`^[[:space:]]*#`）を除外する。fixture `scope-clean.txt` は CLEAN。
    - `grep -c ... || echo 0` は無マッチ時に `0\n2` 相当の二行を作り数値テストを壊す
      （`feedback_sed_grep_guard_false_pass`）。→ `grep -c` の出力をそのまま使う。
    - grep 実数で under-delivery を疑ったら**必ず該当行を目視してから**差し戻す。

### スクリプト品質（実装制約）

11. **bash 3.2 互換**（macOS 既定の `/bin/bash` は 3.2.57）：連想配列 `declare -A` 不可・`mapfile` 不可・
    `${var,,}` 不可。状態は**整数 index の並列配列と temp ファイル**で持つ
    （`feedback_monitor_bash32_no_assoc_arrays`）。CI は `syntax.test.ts` が `bash -n` を回す。
12. **ループ変数に `path` 等の特殊名を使わない**：zsh/bash で `path` は `PATH` に tie され、curl/tmux が
    command not found 化して health check が偽陰性になる（`feedback_zsh_path_loop_var_clobbers_path`）。
13. **品質ゲートで exit code を隠さない**（`quality-gate.sh`）：`cmd | grep ...` は `$?` を grep に渡し
    非ゼロ終了を隠す。vitest は「全テスト緑・Unhandled Rejection で exit 1」を出しうる。
    `cmd > log 2>&1; echo $?` で実測する（`feedback_quality_gate_grep_hides_exit_code`）。

---

## 回帰テスト（red→green で固定した 2 パターン）

| # | 誤報 | 出所 | ガード | テスト |
|---|------|------|--------|--------|
| 1 | 未起動 idle を COMPLETE と誤報 | `feedback_orchestrate_monitor_started_guard` | `verify-completion.sh` の STARTED ガード | `verify-completion.test.ts` |
| 2 | 検証ガード自身の偽陽性（散文一致・`\|\| echo 0`） | 同上 / `feedback_sed_grep_guard_false_pass` | `verify-scope.sh` のコメント除外＋素の `grep -c` | `verify-scope.test.ts` |

いずれも naive 実装で red（本 Skill 初回コミット）→ ガード実装で green にした。

## fixture の作り方（実機採取）

fixture は**使い捨てセッションで capture** する。実 worker session は composer 残テキストで汚染され
流用不可（`feedback_orchestrate_sibling_fold_and_real_tui_capture`）。

```bash
commandmate capture <throwaway-id> --json | tee tests/unit/skills/orchestrate-monitor/fixtures/<name>.json
```
