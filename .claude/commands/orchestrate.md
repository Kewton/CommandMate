---
model: sonnet
description: "複数Issueを並列オーケストレーション（準備→開発→PR→マージ→UAT→修正ループ→完了）"
---

# 並列Issueオーケストレーション

## 概要
developブランチをオーケストレーターとして、複数Issueの並列開発からUAT合格までの全ライフサイクルを統括します。各Issueはfeatureブランチのworktreeで並列に開発され、commandmatedev CLIで制御します。

**原則**: オーケストレーターはコードに触れない。制御と判断のみ。

## 使用方法
- `/orchestrate [Issue番号1] [Issue番号2] ...`
- `/orchestrate [Issue番号1] [Issue番号2] --phase design` （設計フェーズまで）
- `/orchestrate [Issue番号1] [Issue番号2] --phase impl` （実装まで）
- `/orchestrate [Issue番号1] [Issue番号2] --full` （UAT合格まで全自動）
- `/orchestrate [Issue番号1] [Issue番号2] --assign 123=claude` （担当を Issue ごとに指定。1-2b の判定より優先）
- `/orchestrate [Issue番号1] [Issue番号2] --assign 123=claude-sonnet` （Claude のモデルまで指定する。`claude` と `claude-opus` は opus、`claude-sonnet` は sonnet）
- `/orchestrate [Issue番号1] [Issue番号2] --claude-only` （振り分けを止め、全 Issue を Claude（opus）に回す）

## 前提条件
- developブランチ上で実行すること
- CommandMateサーバーが稼働していること（`commandmatedev ls` で確認）
- GitHubリポジトリ（https://github.com/Kewton/CommandMate）にアクセス可能
- **契約系フラグが使えること**を最初に確認する。`--contract` / `--verify` は develop 系にのみ存在し、
  v0.16.0 リリースには含まれない。無ければ委任は素の send にフォールバックする（完了判定は目視に戻る）:
  ```bash
  commandmatedev send --help | grep -q -- --contract && commandmatedev wait --help | grep -q -- --verify \
    && echo "contract delegation: available" || echo "contract delegation: UNAVAILABLE (fallback to plain send)"
  ```
- 委任先リポジトリに `.commandmate/verify.yaml` があること（無ければ `/cmate-verify` で起案する）

## 実行内容

あなたはプロジェクトマネージャーとして、複数Issueの並列開発を統括します。

### パラメータ
- **issue_numbers**: 開発対象のIssue番号（スペース区切り、2つ以上）
- **--phase**: 実行範囲の制限（design, impl, pr, uat）。省略時はPRマージまで
- **--full**: UAT合格まで全自動で実行
- **--assign `<N>=<claude|claude-opus|claude-sonnet|antigravity>`**: Issue #N の開発担当を指定する（複数回指定可）。1-2b の判定より優先。
  `claude` と `claude-opus` は同じ意味（Claude・opus）。`claude-sonnet` は Claude・sonnet。
  **これは assign.tsv の 2 列目と 3 列目を決める書き方であって、`--instance` に渡す値ではない**（`--instance` は常に `claude`）
- **--claude-only**: 1-2b の振り分けを行わず、全 Issue を Claude（opus）に回す（従来の動作）

---

## Phase 0: 初期設定

TodoWriteツールで作業計画を作成：

```
- [ ] Phase 1: 依存関係分析・実行計画（ラベル分類・難易度判定と担当割当を含む）
- [ ] Phase 2: Worktree準備・実行契約の起案
- [ ] Phase 2: 2-4-4 新しい仕組みの設計の事前レビュー（試行中・対象の Issue のみ。バグは Phase 2.5 の後）
- [ ] Phase 2.5: 根本原因分析（バグIssueのみ、他エージェント経由）
- [ ] Phase 3: 並列開発（契約付き send → wait --verify）
- [ ] Phase 4: 設計突合（バリア）
- [ ] Phase 5: 品質確認
- [ ] Phase 6: PR作成・マージ（同時CIは2〜3本 / refresh→tsc→影響テスト→マージ / 断片の一本化）
- [ ] Phase 7: UAT（--full時のみ）
- [ ] Phase 8: 完了報告
```

**重要（エージェント指定ルール）**: `commandmatedev send` でワーカーにタスクを送信する際のエージェント指定は以下に従うこと：
- **開発タスク**: 担当は 1-2b の難易度判定で決める。**易 → `--instance antigravity`**
  （モデルは agy の既定。`--model` は渡さない）、**中 → `--instance claude`（sonnet＝Sonnet 5.5）**、**難 → `--instance claude`（opus）**
  - **Claude のモデルは `--instance` でも `--model` でも決まらない**（`send --model` は copilot / antigravity 専用で、claude に渡すと 400）。
    セッションの**起動時**に、worktree の `.claude/settings.local.json` から決まる。書くのは 3-1 の `set_claude_model`
  - **ワーカーに `/model` を送らない。** Enter が `~/.claude/settings.json` のグローバル既定を書き換える（#1495 / #2297）
  - sonnet 担当がワーカー起因で 2 回不合格になったら opus に格上げする（3-5b）
  - 送り先は `--instance` で指定し、**send / wait / capture / respond で同じ値を渡す**。
    `wait` には `--agent` が無く、worktree の既定エージェントは claude なので、
    antigravity のワーカーに `--instance antigravity` を付け忘れると Claude のセッションを待つことになる
  - Antigravity がワーカー起因で 2 回不合格になったら Claude に切り替える（3-5）
- **レビュー系**（仕様レビュー、設計レビュー等）: 一部 `--agent codex` に依頼可
- **バグ根本原因分析**（Phase 2.5）: `--agent copilot --model claude-sonnet-5` を指定

---

## Phase 1: 依存関係分析・実行計画

### 1-1. Issue情報の取得

各Issueの詳細を取得：

```bash
for issue_num in {issue_numbers}; do
  gh issue view "$issue_num" --repo Kewton/CommandMate --json number,title,body,labels
done
```

### 1-2. Issue種別の分類

各Issueのラベルを確認し、バグと機能追加を分類する：

```bash
for issue_num in {issue_numbers}; do
  labels=$(gh issue view "$issue_num" --repo Kewton/CommandMate --json labels -q '[.labels[].name] | join(",")')
  if echo "$labels" | grep -q "bug"; then
    echo "BUG: #${issue_num}"
  else
    echo "FEATURE: #${issue_num}"
  fi
done
```

分類結果を記録し、Phase 2.5 と Phase 3 で使用する：
- **BUG_ISSUES**: `bug` ラベルを持つIssue → Phase 2.5（根本原因分析）+ Phase 3（/bug-fix）
- **FEATURE_ISSUES**: それ以外 → Phase 3（/pm-auto-issue2dev）

#### 計測が起票した Issue

日次の計測が起票した Issue（ラベル `agent-health`/`metrics`）は、契約を書く前に **まず数え方を確かめる**。

1. 増分の内訳（どのファイルのどの行が数に入ったか）を出す
2. 本物の後退か、数え方の誤りかを分ける
3. 数え方の誤りなら、計測を直す Issue を先に立てる。この Issue の契約には「数え方を変えない」（2-4-3）を書く

実測（2026-10-06 #3270）: 「型安全の後退（any +1、eslint-disable +2）」を目標にしたワーカーは、コメントの英語の「any」を言い換え、
決まりどおりの `declare global { var … }` を別の書き方に戻した。数だけが合い、実際の改善は無かった。
原因は計測の誤りで（#3389 で修正）、契約の検証（lint・typecheck・unit-related）は通っていた。
PR の前に `node scripts/count-suppressions.mjs --base origin/develop` を走らせ、0 でなければ止める（verify.yaml のゲートにはしない）。

### 1-2b. 難易度判定と担当割当

各 Issue の本文（1-1 で取得済み）から難易度を判定し、開発担当を決める。
**優先順位**: `--claude-only` ＞ `--assign <N>=<agent>` ＞ 下の判定表。

**Claude に回す（1 つでも当てはまれば「難」）**

| 観点 | 条件 |
|---|---|
| 危険な領域 | `src/lib/tmux/**`・セッション・`src/lib/detection/**`・`src/lib/polling/**`（Auto-Yes）・hooks・`src/lib/security/**`・DB migration・`src/lib/cli-tools/**`・`ws-server` を変更する（2-5 の対象を含む） |
| 判断の余地 | **ワーカーが「どう直すか」を自分で決める箇所が 1 つでもある**（本文が `file:line` ＋置換後のコードまで確定していない変更がある）。**件数ではなく、決まっていない箇所の有無で見る**（下の実測を参照） |
| 設計 | **ワーカーが**新規のガード・テストを 1 本まるごと**設計して**書く（構造で対象を特定する、陽性/陰性対照を置く、など）。**本文にテスト全文があるなら転記であって設計ではないので、この行には当てはまらない**（下の実測を参照）。既存テストへの assert 追加・書き換えも含まない |
| 原因 | バグで、原因が file:line まで特定されていない |
| 未決事項 | 「要調査」「未決」「実機で決める」などが残っている、または設計書が必要 |
| 検証 | 受入基準の合否が、画面・実機でしか決まらない（e2e や描画結果のテストで代替できないもの。下の注を参照） |
| 依存 | 他の Issue と強依存（1-4）、または同じ関数の書き換えを伴う |
| 新規 export | 新しいモジュールや公開関数を作り、その呼び出し元の配線も必要 |

**Antigravity に回す（すべて満たせば「易」）**

- 上の条件に 1 つも当てはまらない
- **変更する全箇所が `file:line` ＋「置換後のコード」または「削除」まで確定している。件数は問わない**
- 受入基準の合否がすべて自動で決まる（lint / typecheck / unit / e2e）。実機の項目は、見た目の念押しだけなら残っていてよい
- バグなら、原因（file:line）と対策が本文に書かれている
- **逸脱時の退避路が本文に書いてある** — 「本文に無い指摘が出た場合は、そのファイルを変更せず、
  コミットメッセージ本文に『本文に無い指摘: `<file>:<line>` `<rule>`』と書いて報告すること（勝手に直さない）」。
  これが**規模を上げられる条件そのもの**である（下の実測を参照）

**退避路で報告された重複は、整理の Issue の候補として残す**: 退避路が決めているのは「直さずに報告する」までである。
報告の行き先が無いと、重複は残り続ける。ワーカーが「本文に無い指摘」で、同じ処理の写し（重複）を報告したら、次のようにする。

- その run では直させない（整理と、振る舞いの変更を同じ PR に入れない。2-4-3）
- オーケストレーターが、`workspace/orchestration/runs/$DATE/refactor-candidates.md` に 1 件 1 行で残す
  （報告した Issue・`file:line`・何と何が写しか）
- run の最後に、候補を整理の Issue として起票するかを利用者に訊く（8-4）

実測（#3208、2026-10-04 の集計）: 2026-09-01 以降に `src` を変えた fix・feat・refactor 322 本のうち、refactor は 12 本だった。
「重複は直さずに報告する」と決めていたが、報告された重複を整理の Issue にする段が、手順に無かった。

**確定 diff は、対象のコードを読んでから書く**: 起票で確定 diff を書くときは、対象の範囲を `sed -n '<開始>,<終了>p' <file>` などで
実際に読んでから書く。#2936（2026-09-28）は実コードを読まずに「既存の `else` ブロックを入れ子にする」修正案を書き、
契約の作成時に過大と気づいて `else if` 1 段に直した（Issue も更新）。確定 diff の誤りは、「易」の前提をそのまま崩す。

**Claude の中の振り分け（opus / sonnet）— 2026-09-30 改定（Sonnet 5.5）**

Claude の担当は、Issue の中で**ワーカーが自分で見つけなければならないもの**の大きさで opus と sonnet に分ける。
2026-09-30 に Sonnet 5.5（`sonnet` が指すモデル）が出たので、パイロットの「中」を「危険な領域・依存だけ」から「**選択肢か手順が本文で閉じている判断・設計**」まで広げた（根拠は下の実測）。

| 難易度 | 担当 | モデル | 条件 |
|---|---|---|---|
| 易 | antigravity | —（agy の既定） | 「Antigravity に回す」をすべて満たす |
| 中 | claude | sonnet | 「Claude に回す」の観点のうち当てはまるのが「危険な領域」「依存」と、次の「閉じた判断」「閉じた設計」**だけ**で、受入基準がすべて自動・逸脱時の退避路がある。**閉じた判断**＝直し方の候補が本文に列挙されている、または「置き場所・書き方はあなたが決めてよい」の範囲が 1 関数・1 節に収まる。**閉じた設計**＝新しいテストを書くが、確かめる項目と陽性/陰性対照が受入基準に列挙されている |
| 難 | claude | opus | 次のどれかに当てはまる: **原因**（バグで原因が file:line まで特定されていない）・**未決事項**（「要調査」「実機で決める」など、結論が作業の結果で変わる）・**検証**（合否が実機・画面でしか決まらない）・**新規 export**（新しいモジュールと呼び出し元の配線）・**開いた判断/設計**（候補も確かめる項目も本文に無い） |

- 「中」と「難」の境目は、**作業の前に結論が決まっているか**である。候補や手順が本文にあれば、ワーカーの仕事は選んで正確に書くことで、Sonnet 5.5 で足りる。
  結論が実機の結果や調査で変わる Issue（#2955 のような原因調査、#2997 のような「再現したら直す」）は opus に残す
- 「危険な領域」と「依存」は、**壊したときの被害**と**順序の調整**の話で、「どう直すかが決まっているか」とは別の軸である。これは改定前と同じ
- それでも Antigravity には上げない。過去の Antigravity の事故（#2605 / #2622）は道具に由来し、道具の事故がいちばん高くつくのが危険な領域だからである
- **迷ったら難（opus）にする**。sonnet がワーカー起因で 2 回不合格になったら opus へ格上げする（3-5b）ので、中に回した判断の誤りは往復 2 回で取り返せる
- `.claude/settings.local.json` の `{"model":"sonnet"}` は、claude 2.1.284 で `claude-sonnet-5-5` に解決する（#2955 の fixture `tests/fixtures/claude-session-start-2955/`、SessionStart の `model`）。
  版を固定したいときだけ `claude-sonnet-5-5` と書く

**実測（改定の根拠）**

- **Sonnet 5 の「中」は 17 件で、ワーカー起因の再指示 0・格上げ 0**（2026-09-21〜27: #2773 #2774 #2819 #2835 #2845 #2846 #2847 #2884〜#2888 #2890 #2901 #2903 #2904 #2915）。
  範囲を広げて再送した 4 件は、すべてオーケストレーターの契約 scope 漏れ（固定値テスト・型・文書）だった。
  逸脱は 1 件: #2819 が、禁じた `npm run test:unit` を実行した（2-4-2 の「差し替えの条件」）
- **2026-09-29 の run で opus に回した「閉じた判断・設計」の 4 件は、すべて 1 回目の検証で合格した**: #2995（抑止の粒度。候補 2 つが本文）、#2954（判定の置き場所を任せた。範囲は 1 関数）、#2996（リンク検査テスト。確かめる項目が受入基準に列挙）、#2956（本文の 5 項目を orchestrate.md の該当節へ）。
  どれも作業の前に結論が決まっていた。これらを改定後は「中」に回す
- 同じ run で opus が要ったのは、結論が作業で変わった 2 件: #2955（原因調査。hook の中継と画面の読み取りの 2 か所を実機で特定）、#2997（実機で再現を確かめ、再現しないと結論）
- **Sonnet 5.5 での実測はまだ無い（閉じた判断・閉じた設計への拡大はパイロット）。** 改定後の最初の run から、中の Issue ごとに再指示の回数・格上げの有無と、③④のどちらで中にしたかを 8-2 に記録し、8-3 で見直す

**「検証」の注**: 受入基準に実機・画面の項目があっても、それが**見た目の念押し**だけなら、この行では「難」にしない。
条件は、実装そのものが自動の受入基準（描画結果の class・DOM・e2e など）で一意に決まること。
実機の項目は、担当に関係なく UAT（Phase 7）で確かめる。

- 「難」にしない例: #2616（アイコンの差し替え）。描画された svg の class でテストに固定でき、実機の項目は「見分けやすいか」の確認だけだった。
  2026-09-17 にこの行で「難」にして Claude に回したが、変更は 6 ファイル・86 行で、コミットまで約 4.5 分だった
- 「難」にする例: 実機の CLI やブラウザの画面を見ないと、直し方や合否が決まらないもの（実画面の遷移に依存する検出の修正など）

**迷ったら Claude に回す。** 判定の根拠は 1 行で plan.md に残す（1-5）。
Phase 8 の改善案（8-3）は、この根拠と実際の結果を突き合わせて書く。

**「件数」をやめて「判断の余地」にした根拠（2026-09-20、Epic #2735 / #2740 の 9 Issue）**:
旧ルールの「影響ファイルが 4 件以上 → 難」は、**同じ run の中で 2 本を誤判定した**。

| Issue | 影響ファイル | 旧ルールの判定 | 実際（Antigravity） |
|---|---|---|---|
| #2733 | **7** | 難 | 再指示 0・全ゲート初回 PASS |
| #2737 | 4 | 難 | 再指示 0・全ゲート初回 PASS |
| #2739 | 3 | 易 | 再指示 0・全ゲート初回 PASS |

3 本とも確定 diff ＋ 退避路つきで、**3/3 が一度で通った**。一方、同じ run で唯一往復したのは
Claude 担当の #2734（4 ファイル）で、その原因も**起票時の前提の誤り**であってワーカーの実装ではない。
**ファイル数は難易度を予測していない**（逆相関すらしている）。#2616 の例（6 ファイルで「難」判定 → 実際 4.5 分）も同じ向きの反証である。

過去に Antigravity で起きた事故も規模由来ではない: #2605 はテスト全体をバックグラウンド実行してターンを閉じた（道具の問題）、
#2622 は受入基準に「確かめる場所」を書かなかったので本物の `$HOME` を消した（**仕様の書き方**の問題）。

**上げた境界と、上げていない境界**（2026-09-20 実測）:

- **上げた**: 確定 diff を N 件適用（件数無制限）、および**既存ガードへの assert 追加・書き換え**。
  #2739 は #2734 が完全一致で pin していた既存 assert を壊さずに書き換えており、これが成立した
- **上げていない**: 150〜280 行の**新規ガードを 1 本まるごと書く**（#2732 / #2734 / #2736 型）。
  override を構造で特定する・陽性/陰性対照を設計する、は設計判断であり根拠がない

**「設計」と「転記」の線引き（2026-09-20 実測、3/3）**: 上の「上げていない」境界は
**ワーカーが設計する**場合の話である。**本文にテスト全文が載っていれば、ワーカーがするのは
`git apply` か写経であって設計ではない**。実測:

| Issue | 新規ガードテスト | 担当 | 結果 |
|---|---|---|---|
| #2770 | 32 件（本文に全文） | antigravity | 再指示 0・全ゲート初回 PASS |
| #2780 | 7 件（確定パッチに全文） | antigravity | 再指示 0・全ゲート初回 PASS |
| #2781 | 13 件（確定パッチに全文） | antigravity | 再指示 0・全ゲート初回 PASS |

#2781 のワーカーは、変異注入 1 と 2 が**独立して fail すること**まで確かめている
（起票側がプロトタイプ段階で見つけて直した弱点そのもの）。指示どおりの検証ができている。

**全文を書くコストは起票側が負っている**ので、この線引きは判定を緩めるのではなく、
**コストの所在を判定に反映させる**ものである。全文が無い Issue は従来どおり「難」のままとする。

**運用メモ（Antigravity の送信時、2026-09-20 実測）**: 新規 worktree の 1 回目の send は
`exit 99`（`prompt not ready`）になることがある。原因は 2 系統あり、**画面を見て切り分ける**:

- **フォルダ信頼ダイアログ**（`Do you trust the contents of this project?` / `> Yes, I trust this folder`）—
  Auto-Yes は答えられない。`tmux send-keys -t "=mcbd-antigravity-<worktree-id>:" Enter` で確定してから再送する。
  **`-t` の末尾にコロンが要る**（`-t "=<name>"` だけだと `can't find pane` になる）
- **起動が 60 秒枠に間に合わないだけ**（Claude でも起きる）— 画面が既にプロンプトなら、そのまま 1 回再送すれば通る

どちらもワーカー起因ではないので、3-4 の再指示回数には数えない。

**新規 worktree では信頼ダイアログがほぼ必ず出る**（2026-09-20 の run、#2770 で実測）ので、
exit 99 を受けたら**待たずにまず画面を見る**。手順は 3-1 の「冷間起動の失敗」に書いてある。

判定の背景（2026-09-17 のパイロット、#2595 / PR #2602）: テスト 1 ファイル・原因と確定仕様あり・
受入基準がすべて自動、という Issue を Antigravity に回したところ、作業ルールをすべて守って
実装は 5 分で終わった。Antigravity は `.claude/commands` を読まないので、`/pm-auto-issue2dev`
のような多段ワークフローは使えない。Issue 本文だけで実装が決まる粒度のものに限る。

### 1-3. 依存関係の分析

各Issueについて以下を分析：
- **影響ファイル**: Issue本文の「影響ファイル」セクションから抽出
- **共通ファイル**: 複数Issueが同じファイルを変更する場合のコンフリクトリスク
- **依存関係**: Issue間の前後関係（A の成果物が B の入力になるか）

### 1-4. 並列実行可否の判定

```
独立:     共通ファイルなし → 完全並列
弱依存:   共通ファイルあるが変更箇所が異なる → 並列可（設計突合で確認）
強依存:   A の出力が B の入力 → 直列実行（A完了後にB開始）
```

### 1-5. 実行計画の記録

```bash
DATE=$(date +%Y-%m-%d)      # run の開始日。日付をまたいでも変えない（run のディレクトリは引数で渡す）
RUN_ISSUES=<最小>-<最大>     # run の Issue の範囲（例 3477-3481）。記録のファイル名に入れ、同じ日の別の run と分ける
mkdir -p workspace/orchestration/runs/$DATE
```

**run の記録**（#3477）: 各 Issue の段（`contract` / `send` / `verify` / `review`（5-2b）/ `findings`（5-3）/ `precheck` / `pr` / `ci` / `merge`。
この順が run の順で、整合性レビューと指摘の処置は PR の前、CI はゲートと並走（6-1-1））が終わるたびに、`scripts/orchestrate/run-log.mjs` で 1 行を追記する。置き場所は `workspace/orchestration/runs/$DATE/run-$RUN_ISSUES.jsonl`
（1 行 1 段の JSON。issue・段・結果・HEAD・task id・契約・担当とモデル・所要時間・時刻）。追記だけなので、同じフォルダの別の run の
ファイルは上書きしない。`verify` / `review` / `findings` / `precheck` / `ci` / `merge` は HEAD つきでしか記録できない（その HEAD にだけ効く）。
`status` の `next` は、**最新の HEAD について満たしていない最初の段**: 後の段が通った後で前の段が `fail` になればそこへ戻り、
HEAD が変われば検証・確認をやり直す（`skip` は通ったと数える。対象外の段も `skip` を記録する）。
`verify` は `scripts/orchestrate/wait-verify.mjs`（3-3）、`precheck` は `scripts/orchestrate/precheck.mjs`（6-1-1）が自分で書く。
**セッションが落ちたら、会話の記録ではなくこれを読んで再開する**:

```bash
node scripts/orchestrate/run-log.mjs append --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
  --issue <N> --stage verify --result ok --head <sha> --duration-sec <秒>
node scripts/orchestrate/run-log.mjs status --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES"
# → #<N>  reached=verify  next=review  head=<sha>  send=ok verify=ok  (review: no result for <sha>)   （次に行う段が next）
```

実行計画を `workspace/orchestration/runs/$DATE/plan.md` に出力：
- 対象Issue一覧（**難易度・担当・モデル・根拠**の列を含める。1-2b）

  ```markdown
  | Issue | 種別 | 難易度 | 担当 | モデル | 根拠 |
  |---|---|---|---|---|---|
  | #2595 | BUG | 易 | antigravity | — | テスト 1 ファイル／原因と確定仕様あり／受入基準すべて自動 |
  | #2760 | BUG | 中 | claude | sonnet | 当てはまる観点は「危険な領域」（`src/lib/tmux/**`）だけ／全変更が確定 diff／受入基準すべて自動／退避路あり |
  | #2598 | FEATURE | 難 | claude | opus | 影響ファイル 7 以上（新規 hook あり）／対応方針が Phase 2 段／合否が実機でしか決まらない項目あり |
  ```
- `workspace/orchestration/runs/$DATE/assign.tsv` も同時に書く。1 行 = `<issue>\t<claude|antigravity>\t<opus|sonnet|->`
  （3 列目は Claude のモデル。antigravity は `-`。`--assign 123=claude-sonnet` は `123\tclaude\tsonnet` になる）
- 依存関係グラフ
- 並列実行グループ
- マージ推奨順序

---

## Phase 2: Worktree準備

### 2-1. 既存worktreeの確認

```bash
commandmatedev ls --branch feature/
```

### 2-2. 不足worktreeの作成

各Issueについて、対応するworktreeが存在しない場合は作成：

```bash
# /worktree-setup を使用
/worktree-setup {issue_numbers}
```

または手動で:

```bash
git worktree add -b "feature/{N}-worktree" "../commandmate-issue-{N}" develop
cd "../commandmate-issue-{N}" && npm install --include=dev
```

`--include=dev` は省かないこと。シェルが `NODE_ENV=production` だと devDependencies（vitest / eslint など）が入らない。
そうなると、ワーカーの確認コマンドも検証ゲートも動かない。2026-09-17 の run では 3 つの worktree すべてで起き、
ワーカーが自力で補った（Claude は `npm install --include=dev`、Antigravity は main dir の `node_modules` をコピー）。

### 2-3. CommandMateへの登録確認

```bash
curl -s -X POST http://localhost:3000/api/repositories/sync
commandmatedev ls --branch feature/
```

全worktreeが表示されることを確認。

### 2-4. 実行契約の起案

各Issueについて、オーケストレーターが実行契約 `.commandmate/tasks/issue-<N>.yaml` を起案し、
**対象 worktree の中に**配置する。正準仕様は `docs/design/task-contract.md`（v1）、見本は
`.commandmate/tasks/example.yaml`。

```yaml
version: 1
title: "Issue #<N>: <Issueタイトル>"
goal: |
  https://github.com/Kewton/CommandMate/issues/<N> を実装する。
  <Issue本文の受入条件チェックリストをそのまま転記する>
scope:
  allow:               # Issueの影響範囲。requireScopeClean が true なら1件以上必須
    - "src/lib/<module>/**"
    - "tests/unit/<module>/**"
    - "changelog.d/<N>.md"   # CHANGELOG の断片。ワーカーが実装と同じコミットに含める（2-4-1）
  deny: []             # 共有ファイル（CHANGELOG.md / docs/module-reference.md）は入れない。2-4-1 参照
verify:
  # 既定は unit-related（変更に関係するテスト＋リポジトリのファイルを読むテスト）。テスト全体が必要な Issue だけ unit にする（#2639）
  gates: [lint, typecheck, unit-related]
  gateDefinitions:
    - id: unit-related
      command: "node scripts/run-related-unit-tests.mjs --base origin/develop"
      timeoutSec: 5400
      mutex: cpu.heavy
success:
  requireWorkEvidence: true
  requireCommit: true  # コミット前の状態を合格にしない（#3430: ワーカーが途中でターンを閉じ、未コミットのまま exit 0 になった）
  requireScopeClean: true
```

**契約は `scripts/orchestrate/contract.mjs` で作る**（#3477）。Issue ごとに設定ファイル（YAML か JSON）を 1 つ書き、
そこから上の形の契約を生成する。goal は `scripts/orchestrate/templates/` の雛形（2-4-1・2-4-2）から組み立てるので、
手で転記しない。

```bash
# 設定は run のディレクトリに置く（workspace/ は git に無視される）。Issue 本文は gh で取ってファイルにする
gh issue view <N> --json body -q .body > "workspace/orchestration/runs/$DATE/issue-<N>.md"
cat > "workspace/orchestration/runs/$DATE/contract-<N>.yaml" <<'YAML'
issue: <N>
key: "<N>"                # 契約のファイル名 issue-<key>.yaml。同じブランチの 2 本目は "<N>-opus" など（断片は <N> のまま）
title: "<Issueタイトル>"
kind: feature             # feature | bug | refactor | docs（CHANGELOG の節とコミットの type の既定）
agent: claude             # claude | antigravity
model: opus               # opus | sonnet（antigravity は書かない）
gates: [lint, typecheck, unit-related]
scope: ["src/lib/<module>/**", "tests/unit/<module>/**"]   # changelog.d/<N>.md は自動で足される
decisions: []             # Issue の「決めること」への答え（goal の「この契約での決定」になる）
changelog: { section: Added }   # 節の上書き（既定は kind から）。最低の版を上げるなら bump: minor を足す
commit: { type: feat, scope: <scope> }
issueBodyFile: issue-<N>.md     # 設定ファイルからの相対パス
# isolatedLiveCheck: [server, tmux]   # 隔離した実機の確認を許す（2-5 は tmux、2-6 は server）。起動の禁止の文が隔離の手順に置き換わる
# refactor: { mergesCopies: true }    # kind: refactor では必須（2-4-3）。写しをまとめる手順は true、長い関数を分ける手順は false
YAML
node scripts/orchestrate/contract.mjs generate \
  --config "workspace/orchestration/runs/$DATE/contract-<N>.yaml" --worktree "$WT_PATH"
```

- 生成器は、出力する契約を正準のパーサー（`src/lib/tasks/contract-parser.ts`）と同じ制約で検査する（title 200 文字・gate の形と重複・scope の形）。
- **goal が 8,000 文字を超えると生成が失敗する**（契約の上限）。Issue 本文を要点に縮めた `issueBodyFile` を渡し直す
- `scope` に `CHANGELOG.md` / `docs/module-reference.md` を書くと生成が失敗する（2-4-1）。`requireCommit: true` は常に入る
- 同じ設定で再実行しても契約は変わらない（`unchanged`）。中身の違う契約が既にあると止まる。送信前に直すときだけ `--force`
- 2-4-2 の差し替え（テスト全体）は雛形に入っていない。生成した契約に手で足す
- `kind: refactor` では 2-4-3 の整理の決まりが goal に入り、gates の既定が `[lint, typecheck]` になる。`tests/` の下の glob を scope に書くと生成が失敗する

- **`requireCommit: true` を外さない**（#3430）。外すと未コミットの変更も作業証跡に数え、ワーカーがコミット前に
  ターンを閉じたとき `wait --verify` が exit 0 を返す。契約の「1 つにコミットする」と裁定をそろえる。
- **契約は未コミットで配ってよい**。`work-evidence` / `scope` ゲートは変更集合から契約ファイル自身を
  除外する（#1580）ので、契約を置いただけの worktree が「作業済み」に見えることはない。
- `scope.allow` は**Issueが触ると宣言した範囲**を書く。広すぎる allow は scope ゲートを無力化し、
  狭すぎる allow は正当な変更を不合格にする。迷ったら Phase 1 の依存関係分析で洗い出した
  ファイル集合をそのまま使う。
- **同じブランチに契約を積むとき**（設計の契約の後の実装の契約、実装を 2 本に分けたときの 2 本目など）は、
  `scope.allow` を**前の契約の allow との和集合**にする。scope ゲートは origin/develop 比のブランチ全体の差分を
  見るので、その契約で触る範囲だけを書くと、前の契約で入れたファイルが範囲外になる
  （2026-10-04 #3184 で実測。19 件が範囲外になり exit 20）。
- `verify.gates` を絞ると**絞ったゲートしか裁定しない**。`unit-related` は、変更に関係するテストと、
  リポジトリのファイルを読むテストだけを実行する（`scripts/run-related-unit-tests.mjs`。import されない
  ファイルが変わったときはテスト全体に切り替わる）。テスト全体の合否は CI の `Unit Tests` で見るので、
  `unit-related` で裁定した PR は 6-2 の例外に従う。テストの共通設定・ヘルパーの変更や広い範囲の rename
  など、テスト全体が必要な Issue では `gates: [lint, typecheck, unit]` にする（#2639）。
- **`.sh` を触る Issue**（`scope.allow` に `.sh` が入りうる。`scripts/**` など）では、`gates` に `lint-sh` を足す
  （例: `gates: [lint, lint-sh, typecheck, unit-related]`）。`lint-sh` は `.sh` の変更が無ければ何もせず合格するので、
  迷ったら足してよい。`lint` は ESLint だけで、shellcheck（CI の Lint ジョブの `npm run lint:sh`）は見ない（#3478）。
- **`$HOME` 配下に新しい置き場所（ファイル・ディレクトリ・環境変数で移せる場所）を足す Issue** では、
  goal の受入基準に「`tests/setup.ts` に、その置き場所をテスト用の一時パスへ向ける既定を足す
  （`CM_OPENCODE_PORT_FILE` / `CM_OPENCODE_V2_DIR` と同じ形）」を書く。`scope.allow` に `tests/setup.ts` を入れ、
  共通設定の変更なので `gates` は `unit` にする。
  #2934 で `CM_OPENCODE_V2_DIR` を足したときにこれが無く、起動処理を走らせるテストが利用者の
  `~/.commandmate/opencode-v2/` を消していた（#2948 で修正）。`env-clean` は `~/.commandmate` **直下**の増減しか見ないので、
  その下の中身が消えても捕まらない。

#### 画面・CLI に見える変化を含む Issue

利用者に見える変化（画面・CLI の表示）を含む Issue は、部品だけを範囲にすると、文言が一度も描画されないまま検証に合格する。起案のとき、次の 3 点を契約に書く。

- **経路図を goal に書き、変更が要る段だけを `scope.allow` に入れる。** 値の出どころ → API／WebSocket → フック → 親のコンポーネント → 部品（CLI の表示なら API → CLI の型 → コマンドの出力）を goal に全段書く。`scope.allow` には、そのうち変更が要る段だけを入れる（読むだけの段は入れない）。段を漏らすと、ワーカーは「本文に無い指摘」としか報告できない。
- **経路ごとの表示の確認を受入基準に入れる。** 変化が届く経路ごとに（PC とスマホ、poll と push、HTTP と WebSocket など）、「その変化が起きる状態のまま、親から通して描画される（または出力される）」ことを確かめるテストを入れる（例: Auto-Yes 有効のまま、親を描画して文言を探す）。部品だけのテストでは足りない。
- **実際の応答とつなぐ。** 応答は手で作ったモックだけにしない。サーバーが実際に返す応答（実装が返す値）と表示がつながることを 1 本で固定する（2-4-3 の「実際の応答」と同じ方針）。

起案のとき、表示の条件（親が隠す条件・モード）を確かめる。2-4-2 の「表示されない条件」を探す。

例（#3397、2026-10-06）: 1 回目の契約はサーバー・API・部品（`PromptStuckHint`・`PromptPanel`・`MobilePromptSheet`）までで、画面のフック（`useWorktreeDetailController`・`useTerminalPanePolling`）を範囲から漏らし、文言が描画されないまま合格した。
さらに親（`TerminalSplitPaneContent`・`WorktreeDetailRefactored`）は Auto-Yes 中にプロンプト欄を出さず、つないでも見えなかった（3 回目の整合性レビューで発見）。

### 2-4-1. 共有ファイルはワーカーに書かせない（必須）

**`CHANGELOG.md` と `docs/module-reference.md` を `scope.allow` に入れてはならない。**
代わりに各ワーカーには**断片ファイル**を書かせる。2 つの扱いは次のように異なる:

- **CHANGELOG**: ワーカーが `changelog.d/<N>.md` を書き、**実装と同じコミットに含める**（2-4 の雛形のとおり
  `scope.allow` に `"changelog.d/<N>.md"` を入れる）。`CHANGELOG.md` へはリリース時に `/release` が
  `node scripts/changelog-fragments.mjs apply` で集約する。オーケストレーターは書き写さない（6-4）
- **module-reference**: ワーカーが `dev-reports/module-reference/issue-<N>.md` に書き（commit には入らない）、
  従来どおりオーケストレーターがマージ時に本体へ一本化する（6-4）

契約の「作業ルール（厳守）」に入る断片の書き方（実例つき）は **`scripts/orchestrate/templates/fragment-rules.md` が持つ**（#3477。ここには写さない）。
`scripts/orchestrate/contract.mjs`（2-4）が `<N>` を Issue 番号に置き換えて goal に入れるので、手で転記しない。

**なぜこうするか（2026-08-22 の実測）**: 全ワーカーが `CHANGELOG.md` の同じ節に追記すると、
**1 本マージするたびに残りの PR が全部 CONFLICTING になり、refresh → CI 全周やり直しが必要**になる。
CI は中央値 38 分（self-hosted 1 台・11 ジョブ、同時 5〜6 本なら 55 分）なので、
N 本のマージが N 回の直列 CI に化ける。実測では PR 21 本に対し CI 53 回（1 PR あたり 2.5 回）で、
やり直しの大半がこの結合に起因していた。断片方式なら PR 間の強制直列がほぼ消える。
2026-09-18 に、CHANGELOG の断片はコミットする方式に移った（#2640 / #2641）。オーケストレーターが 6-4 で `CHANGELOG.md` へ
書き写す方式では、書き写した PR をマージするたびに残りの PR が `## [Unreleased]` で衝突していた（2026-09-17〜18 の run で計 7 回、手で解消）。

`docs/module-reference.md` は **表**なので、両側保持で解決してはいけない（同じ行が 2 本になる）。
断片方式ならこの解決自体が不要になる。

**実例を丸ごと貼る理由（2026-08-22〜23 の実測）**: 形式を上の 1 行の抽象仕様だけで示していた Phase 4 では、
**4 ワーカー中 3 つが形式から外した**（#1930 は `- 構造化層の状態導出を…（Issue #1930、Epic #1921 Phase 4）`、
#1931 は `- opencode の SSE / REST 経路が…（Issue #1931）。`、#1933 は要約と Issue 番号をまとめて `**…**` の中へ入れた）。
規約どおりだったのは #1932 だけで、3 本ともオーケストレーターが一本化時に書き直している。一方、契約に実例を
丸ごと 1 本貼った #1994 の断片は初回から規約どおりだった。**抽象的な形式指定では守られず、実例なら守られる。**

module-reference 側は**実例だけでは足りない**（判断の根拠つき）。#1927 と #1932 の契約には既に
「`grep -n '^| \`<path>\`' docs/module-reference.md` で実在を確認してから書く」が入っていたのに、
**存在しない行への追記指示が #1927 で 4 件・#1932 で 1 件**出た（オーケストレーターが一本化時に裁定）。
CHANGELOG 側が**形式**の誤りで断片を見れば分かるのに対し、こちらは**事実**の誤りなので断片を読んでも分からない
──手本を足しても検出できる誤りが増えない。そこで指示を「確認する」から**「確認した出力（行番号つきの行キー）を
断片に書き写す」**へ変え、6-4 で断片を `cat` した時点で証拠の無い追記指示が目に見えるようにした
（**6-4 の手順自体は変更していない**。既存の `awk … uniq -d` は行が 2 本になった後しか捕まえられないが、
証拠の有無は写した瞬間に読めるので手順を足す必要が無い）。なお実在確認は**転記ブロックには入っていなかった**
（実測: 変更前の `.claude/commands/orchestrate.md` に `grep -n` は 1 箇所も無く、上記 2 本の契約は
オーケストレーターが手で足していた）ので、あわせて転記ブロックへ引き上げた。

### 2-4-2. 担当ごとの goal の書き方

**契約付き send では、goal の先頭にスラッシュコマンドを書いても起動しない。** 送信本文は
`## 実行契約`（変更可能パス・完了条件）から始まり、goal はその後ろの `## タスク` に入るため、
`/pm-auto-issue2dev 2598` は平文として届く（2026-09-17 #2598 で実測。ワーカーは skill を呼ばずに
直接実装した）。goal には**スラッシュコマンドに頼らず、実装に必要な指示をすべて書く**。

- **Claude 担当**: 従来どおり Issue 本文（事象・原因・対応方針・受入基準）と 2-4-1 の作業ルールを書く。
  Claude は指示が薄くても Issue レビューや設計相当の確認を自発的に行う。
  - **sonnet 担当（1-2b の「中」）の goal には、次の 1 行をそのまま足す**:
    ```
    Issue 本文に無い変更が必要に見えたら、そのファイルを変更せず、コミットメッセージ本文に「本文に無い指摘: <file>:<line> <内容>」と書いて報告すること。
    ```
    「中」に振り分けた前提（全変更が確定 diff）が崩れたときの退避路で、Antigravity の雛形と同じもの。
    サブエージェントについての指示は要らない: `.claude/agents/*.md` は `model: inherit` なので、ワーカーがサブエージェントを呼んでも
    セッションと同じモデル（sonnet）で走る（`model: opus` 固定だった頃は、その部分だけ opus で走っていた）
- **Antigravity 担当**: `.claude/commands` を読まない（`.agents/skills` だけを探す）。
  次の雛形の**すべての節**を書くこと。特に「確認を求めない」「`IMPL_COMPLETED`」「一時ファイルは `os.tmpdir()`」は
  省かない。ワーカーが質問を書いてターンを終えると、Auto-Yes は答えられない。wait はそれを完了と読むので、
  作業が途中のまま検証に進み、exit 20 か 21 になる。

goal の雛形は **`scripts/orchestrate/templates/goal.md` が持つ**（#3477。ここには写さない）。担当で雛形を分けず、
`scripts/orchestrate/contract.mjs`（2-4）が Issue ごとの設定から埋める（sonnet には上の 1 行も足す）。

実例: パイロットの契約（#2595）は、この雛形のとおりに書いて一度で通った（goal は 3,282 文字。上限は 8,000 文字）。
Antigravity は、雛形にあるルールのうち次のものをすべて守った:
1 コミット・指定したメッセージ・scope 内・断片の形式・push/PR をしない・`IMPL_COMPLETED`・一時ディレクトリでの陰性対照。

**「worktree の外の既存ファイルを消さない」を書く理由**（2026-09-17 #2622）: #2622 は、テストが `$HOME` と `/tmp` に
ファイルを残す不具合だった。Antigravity は修正を確かめるために、残っていた本物のファイル
（`rm -f ~/.commandmate/hooks/claude-wt-1933-…json`、`rm -rf /tmp/cm-1933-worktree`）を消し、テストを実行して
再び作られないことを見た。確認の手順としては筋が通っているが、worktree の外の既存ファイルを消す操作であり、
goal では頼んでいなかった（goal の受入基準に「`/tmp/cm-1933-worktree` に何も残らない」と書いたことが、消す動機になったとみられる）。
scope ゲートは worktree の外の操作を見ないので、こうした操作は検証では捕まらない。今回は、消したのが不具合の残骸だけだったので害は無かった。

- 受入基準に「どこそこに残らない」と書くときは、「private HOME（`os.tmpdir()` 配下）で実行したときに」と、確かめる場所も書く
- 本物の `$HOME` や `/tmp` の後始末が要るなら、ワーカーにはさせず、オーケストレーターが行う

**「既存のテストを消さない」を書く理由**（2026-09-28 #2936）: #2936 は検証ゲートをすべて通ったが、既存テスト
「rejects a model for a tool that does not support it」を新しいテストに置き換えて消していた（レビューで見つけて再指示 1 回）。
`unit-related` のゲートは「テストが消えたこと」を検出できないので、6-4 で機械的に確かめる。

**「実装の進め方」の 3・4 を書く理由**（2026-09-17 #2605）: 以前の雛形は「テスト全体は自分で回さなくてよい」だった。
Antigravity はコミットの後にテスト全体をバックグラウンドで起動し、その終了を待つ間、何度もターンを閉じた
（自分を後で起こす機能を使った）。結果は次のとおり:

- wait がそのターン終了を完了と読み、作業途中で検証を始めた（3-3 の「完了の合図」、#2614）
- ワーカーのテスト全体と検証ゲートのテスト全体が同時に走った
- 負荷で赤くなった別のテストを、ワーカーが調べ直した

書き方は次の方針にしている:

- **禁止は「テスト全体」に限る**。対のテスト・lint・tsc は数十秒で終わるので、ワーカーが自分で確かめられる
- **待ち方は肯定形で書く**。特定の機能名を出して禁じると、かえってその機能を意識させるおそれがあるため
- **守られる保証は無い**。3-3 の合図確認は、この指示の有無にかかわらず行う

**差し替えの条件（2026-09-20 の run で狭めた）**: 差し替えてよいのは
**対のテストでは破損が見えない Issue**（テストの共通設定・ヘルパーを変える、広い範囲の rename）**だけ**である。
**Issue の受入基準に `npm run test:unit` と書いてあることは、差し替えの理由にならない。**

理由は排他が片側にしか無いこと: `verify` の重いゲートは `mutex: cpu.heavy` を取るが、
**ワーカーが goal の指示で直接叩く `npm run test:unit` は mutex を取らない**。
両者が同じマシンで重なると、テストが全部通っているのにティアダウンの race でゲートが落ちる。

実測（2026-09-20、#2770 / #2771 の run）: #2771 の `integration` ゲートと #2770 のワーカーの
`npm run test:unit` が重なり、**`Test Files 117 passed / Tests 1532 passed` で失敗テストはゼロなのに exit 1**
（`EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`、load average 17 超）。
負荷が下がってから同じコミットで単独再実行すると exit 0 で再現しなかった。
このとき goal に `npm run test:unit` を書いたのはオーケストレーターで、理由は
**Issue の受入基準にそう書いてあったから**だった。

**このために起きる不利**:

- 対のテスト以外の破損は、検証ゲートまで見つからない。再指示の往復が 1 回増えることがある
- その再指示は、3-5 の「2 回で切替」の回数に数える

#### 対になる場所を探す（全担当共通・実装の**前**）

Issue と契約は「変える場所」を名指しし、ワーカーはそこを変え、テストは変えた場所を確かめ、オーケストレーターは差分を見る。
**変えるべきだったのに変えなかった場所**を見る段は、ここで入れないと無い。goal には、実装の前に次を探し、
結果（見つけた場所と、直す・直さないの判断）をコミットメッセージ本文に記録するよう書く。

- 同じ処理の写し（PC とスマホ、チャット面とターミナル、ルートどうし、ツールごとの実装、同じ関数を別の関数越しに呼ぶ経路）
- 同じ値・型の写し（サーバーの型と `src/cli/types/`、定数、辞書の ja / en）
- 説明（`docs/` の ja と en、コメント、JSDoc）
- 古い動きを固定しているテスト（回数・文言・タイミング）
- **表示されない条件**（親が隠す条件・モード。例: Auto-Yes 中はプロンプト欄を出さない）。変えた表示が、その条件で隠れないか
- 直した理由が、**同じ場所の別の条件**にも当てはまらないか

契約の範囲の中なら、一緒に直す。範囲の外なら直さず、「本文に無い指摘: <file>:<line> <内容>」として報告する（上の退避路と同じ）。
探した結果は、見つからなかったときも「探した対象と、無かったこと」を書かせる。

実測（2026-10-05、不具合 19 項目 #3289〜#3305）: 16 項目が「片方にだけ足された・直された」形だった。
#3295 は Issue の「6 本」が実際は 31 か所だった（整合性レビューが見つけた）。

### 2-4-3. 整理（refactor）の Issue の契約の型

整理（refactor）の Issue は、**振る舞いを変えないこと**を契約で縛る。2-4 の雛形に、次の 3 つの決まりを足す。

- **`scope.allow` に `tests/**` を入れない。** テストを書き換えると、scope ゲートが不合格にする。
  import 行の付け替えが要るテストだけを、ファイルを名指しで入れる
- **goal に「整理の決まり」を書く**（下の雛形。`contract.mjs` が `kind: refactor` で入れる）
- **整理と、振る舞いの変更を同じ PR に入れない。** 不具合の修正や機能の追加は、別の Issue・別の PR にする

```yaml
scope:
  allow:
    - "src/lib/<module>/**"
    - "tests/unit/<module>/<名指しのテスト>.test.ts"   # import 行の付け替えが要るときだけ。tests/** は入れない
    - "changelog.d/<N>.md"
  deny: []
verify:
  gates: [lint, typecheck]   # テスト全体は PR の CI で見る（下の「検証ゲート」）
success:
  requireWorkEvidence: true
  requireCommit: true  # 上の雛形と同じ（#3430: コミット前の状態を合格にしない）
  requireScopeClean: true
```

契約の「作業ルール（厳守）」に入る「整理の決まり」は **`scripts/orchestrate/templates/refactor-rules.md` が持つ**（#3477。ここには写さない）。
`scripts/orchestrate/contract.mjs`（2-4）が、設定の `kind: refactor` のときに `<N>` を Issue 番号に置き換えて goal に入れるので、手で転記しない。
設定には `refactor: { mergesCopies: true }`（写しをまとめる手順）か `false`（長い関数を分ける手順）を必ず書く。
決まりの見出し（本文は雛形）: 振る舞いを変えない／`tests/` の下のファイルは変えない／写しは新しいモジュールに置く／循環を作らない／
コメントは書き換えずに移す／`await` を足さない／見つけた食い違いや不具合は直さない／テストを変えずには通らないなら `IMPL_BLOCKED`／
`git diff --shortstat` で行が減らないなら採用しない（`mergesCopies: true` のときだけ）／
数え方を変えない（計測のコード・除外の一覧・抑止のコメントを足して数字を下げない）／
どう届いたかを書く（言い換え・書き方の変更だけで数が変わった箇所は、そう書く）。

**数字だけの変更を止める確認（#3483）**: 整理・計測の Issue の PR を出す前に、オーケストレーターが
PR の前の確認（6-1-1 の `scripts/orchestrate/precheck.mjs`）を `--kind refactor`（計測の Issue は `--metrics`）で走らせる。
その中で `node scripts/count-suppressions.mjs --base origin/develop` が走る。追加された抑止のコメントと、計測の設定
（`src/lib/agent-health/metrics*.ts`・`scripts/agent-health/metrics*.ts`）の変更が 0 でなければ、PR の前に止めて再指示する。
雛形の 2 つの決まり（数え方を変えない・どう届いたかを書く）は、すべての整理の契約に入る。

`git diff --shortstat` の 1 行は、写しをまとめる手順の契約（`mergesCopies: true`）にだけ入る。長い関数を分ける手順（`false`）には入らない（下の「採用の基準」）。

ワーカーが `IMPL_BLOCKED` で終わったら、オーケストレーターは理由のファイルを読む。
置き場所などの指示を変えてやり直すか、その手順を採用しないと決めて Issue に書く。

**決まりと実測（Epic #3207、2026-10-04〜05）**: 23 列・約 90 手順を、約 50 本の PR で行った。
手順の名前（D-1 など）は、Epic の列（A〜W。Issue は #3209〜#3231）と、列の中の順番である。
契約は手順ごとに 1 つ書いた（`issue-<N>-s<k>.yaml`。goal の先頭に「この契約で行うこと（これだけ）」を置いた）。

**採用の基準**: 写しが 1 つになって行が減るか、長い関数が短くなるなら採用する。
行が増えて、重複が引数の受け渡しに置き換わるだけなら採用しない。
写しをまとめる手順の契約は `mergesCopies: true` にして（`git diff --shortstat` の 1 行が入る）、ワーカーに行数で判定させる。
実測: 採用しなかった手順は 9 つ。

| 手順 | 採用しなかった理由 |
|---|---|
| D-1 | 52 行増。props が 22 個 |
| C-3・C-4 | 128 行増。引数が 19 個 |
| N-3・N-4 | 42 行増。別のツールの形式を束ねる |
| M-5 | 17 行増 |
| Q-3 | 4 行増 |
| G-7 | 2 つの並びの途中の処理が違う |
| O-5 | 重複をテストが固定済み |

**新しいモジュールに置く理由**: テストは、モジュールをパスで差し替えている。
部分的な `vi.mock` は、同じモジュールの中の呼び出しには効かない。
既存のモジュールの中に共通の関数を置くと、テストを変えずには通らないことがある。
`NextResponse` を返す関数のように、依存が増える関数は、その依存を持ってよい層だけが import する新しいファイルに置く。
実測: 既存のモジュールの中に置くよう Issue に書いた 2 つ（P-1、Q-1）は、ワーカーが止まり、新しいファイルに置き直した。止まった理由は別である。

- P-1 は、部分的な `vi.mock` に当たった。`resolveInstanceTarget` だけを差し替えるテスト
  （`tests/unit/cli/commands/respond-opencode-v2-2945.test.ts`）である。置き直した先は `src/cli/commands/command-target.ts`
- Q-1 は、依存の向きで置けなかった。共通の関数を `src/lib/session/resolve-session-target.ts` の中に置くと、
  そのモジュールが `next/server` に依存する。そのモジュールは、API ルート以外（`src/lib/push` と `src/lib/relay`）からも import されている。
  置き直した先は `src/lib/session/session-target-conflict-response.ts`

**`await` を足さない理由**: 「無いと確かめてから入れる」処理の間に `await` を足すと、同時に走った処理が二重に入れる隙ができる。
実測: E-5 と M-5 の契約に、この決まりを書いた。M-5 の契約では、共通の関数を同期にし、`db` などは呼び出し側から引数で渡すと決めた。

**ファイルを消す手順**: 消す前に、`docs/` の設計文書がそのファイルを名指ししていないかを確かめる（`grep -rn '<ファイルのパス>' docs/`）。
名指しされているファイルは消さない。文書を直すかどうかは、別の Issue で決める。
実測: R-3 は、CI の `tests/unit/docs/design-doc-identifier-audit.test.ts` で落ちた。設計文書が名指しする 2 ファイルを元に戻した。

**関数や定数などの名前を消す手順**: ファイルを消す手順と同じ決まりを、関数・定数・型などの名前を消すときにも使う。
消す前に、設計文書がその名前を名指ししていないかを確かめる（`grep -rn '<名前>' docs/design/`）。名指しされている名前は消さない。
PR を出す前に `npx vitest run tests/unit/docs/design-doc-identifier-audit.test.ts` を実行する。
実測: N-5 は、消した未使用の関数 `readCopilotSettings` を設計文書が名指ししていて、同じテストで落ちた。その関数は元に戻した。

**コメント**: 書き換えずに移す。整理の結果、説明が合わなくなったコメントは、その PR では直さない。
オーケストレーターが一覧に残し、最後にコメントだけの PR で直す。

**同じ列の手順を 1 本の PR にまとめる**: 同じ列（同じ Issue）の手順は、同じブランチにコミットを積んでよい。CI の周回が減る。
後の手順の契約の `scope.allow` には、前の手順が作ったファイル（`changelog.d/<N>.md` など）を入れる。
実測: W-2 は入れ忘れて、scope ゲートが不合格と出た。

**テストが自分どうしの比較になる変更**: 互換の関数を消すと、それを確かめていたテストは、同じ関数どうしを比べることになる。
テストを消したり、題名を変えたりしない。PR に書いて、利用者に訊く。実測: 列 T（#3228）。

**範囲外の食い違い**: ワーカーは直さずに報告する（雛形の「本文に無い指摘」）。
オーケストレーターは、仕分け用の Issue 1 本に、番号を付けて集める。実測: #3232 に 48 件（2026-10-05 07:20 時点）。
写し（重複）の報告は、整理の Issue の候補として残す（1-2b、8-4）。

**検証ゲート**: 契約のゲートは `lint` と `typecheck` にする。テスト全体は PR の CI で見る。
`unit-related` は 1 回 13〜22 分かかり、`cpu.heavy` で直列になるためである。
ローカルの裁定がテストを含まないので、マージは CI の `Unit Tests` が `pass` になってから行う（6-2 の例外と同じ扱い）。

### 2-4-4. 新しい仕組みの設計の事前レビュー（試行中の段、2026-11-06 まで）

5-2b の整合性レビューはマージの前の段で、設計の穴を実装の後に見つける。#3397（読めない選択画面に Auto-Yes が Enter を送る）は
整合性レビューを 3 回受け（3 件 → 2 件 → 3 件）、1 往復で約 45 分かかった。指摘はコードの書き方ではなく設計の穴だった
（画面のキャッシュの寿命 5 秒と確認の間隔 2 秒、停止を通らないセッションの作り直しの経路、Auto-Yes 中は親がプロンプト欄を出さないこと）。
そこで、最終の契約をワーカーに送る**前**に、設計の要点を Codex に 1 回見せる。**期限つきの試行**で、常設しない。

- **期限:** 2026-11-06 まで（4 週間）。期限の日に、下の記録を集計して、続ける・入れる・やめるの判断案を書き、Codex のレビューを受けてから利用者に伺う
- **対象の条件:** 危険な領域（hook・セッション・検出・ポーリング／Auto-Yes・tmux・security・応答の形・隔離）で、**状態・副作用・寿命を変える** Issue。
  新しい自動の動作・新しい状態や記録だけでなく、**既存の動作の修正で新しい経路や状態の遷移を生むもの**も含む。接頭辞（feat / fix）では判定しない。
  対象でないもの（表示だけの変更・docs だけ・テストだけ・状態や寿命に触れない修正）は飛ばし、飛ばした理由を plan.md に 1 行残す
- **置き場所:** 実行契約の起案（2-4）の後、最終の契約を送る（3-1）前。**バグは Phase 2.5（原因の分析）の後**に行う。
  レビューで変わった scope と受入基準は、最終の契約に反映してから送る
- **書くもの（半ページ）:** 「何が・いつ・どの経路で起きるか」。入力の取り方、状態の寿命と消える条件、同じ値を読む他の経路、画面に出る条件。
  **事実と見立てを分け、参照したコード（file:line）と未確認の事項を必ず書く**
- **Codex への依頼の形:** `--agent codex` に 1 本ずつ（セッションは直列）。半ページの文書を渡し、「設計の穴（寿命・経路・競合・他の読み手）を、
  守るべき条件・全経路・対照のテストの形で挙げてほしい」と頼む。コードの書き方の指摘は求めない
- **指摘の契約への入れ方:** 指摘を契約の goal に「守るべき条件」「全経路の一覧」「対照のテスト（陽性・陰性）」として書き、
  scope と受入基準を直す。採らない指摘は理由を plan.md に残す
- **依頼文は送る前に利用者に見せる**（高難易度の意思決定の既存の決まりと同じ）。承認を得てから送る
- **5-2b は残す。** 事前レビューをした Issue も 5-2b の対象に含める
- **記録（総時間と再レビューの回数の比較）:** 5-2b と同じ run のフォルダの `consistency-review.md` の表に「事前レビューの有無」の列を足して記録する（新しい表は作らない）。
  事前レビューの待ち時間を含む 1 本あたりの総時間と、5-2b の再レビューの回数を、有無で比べる
- **期限の集計の手順:** 1. 各 run の `consistency-review.md` を、事前レビューの有無で分けて合計する（総時間・再レビュー回数・独自の発見）
  2. 続ける・入れる・やめるの判断案を書く 3. Codex のレビューを受ける 4. 利用者に伺う

### 2-5. tmux / セッションに触れる Issue の追加ルール（必須）

`src/lib/tmux/**`・セッション名・`tmux` コマンドそのものを扱う Issue（#1163 / #1621 Phase 3 /
#1623 / #1624 など）では、**次の 4 項目を契約の「作業ルール（厳守）」にそのまま転記する**。
契約を `contract.mjs` で作るときは、設定に `isolatedLiveCheck: [tmux]` を書く（下の 4 項目が起動の禁止の文と置き換わって入る。手で転記しない）。

> - **実 tmux を触る検証は必ず `tmux -L <専用socket>` で行う。** `-L` / `-S` は `$TMUX` より優先される。
>   ワーカーは tmux ペインの中で動いていて `$TMUX` が既定サーバを指しているため、フラグ無しの
>   `tmux` 呼び出しは全て**ユーザーの本番サーバ**に届く。
> - **`kill-server` を `-L` 無しで書かない。** 後始末は `kill-session -t '=<name>:'`（完全一致）で行う。
> - **`TMUX_TMPDIR` を隔離手段に使わない。** `$TMUX` が設定されていると完全に無視される。
>   socket 引数を取らない本番コード（`src/lib/tmux/tmux.ts`）を動かすときは `process.env.TMUX` を
>   私設サーバへ向け、**転送が効いていることをテスト内で assert する**。
> - **`bind-key` / `unbind-key` / `set-option -g` を既定サーバへ撃たない。** サーバグローバルなので
>   他の全セッションに波及する。

2026-08-02 の実害に基づく。live tmux テストが `TMUX_TMPDIR` で隔離したつもりのまま `kill-server` を
撃ち、**稼働中の全 `mcbd-*` セッションを消して並列ワーカーを即死させた**。テストは 3/3 緑で、CI は
tmux 非導入で skip するため誰も気付かない。`tests/unit/config/tmux-live-test-safety.test.ts` が
unit ゲートで同型を弾くが、契約側にも明示すること。

### 2-6. 実機でエージェント CLI / サーバーを動かす Issue の隔離の雛形（必須）

実機でエージェント CLI や CommandMate のサーバーを動かして確かめる Issue では、**次の項目を契約の「作業ルール（厳守）」に転記する**
（tmux を触るなら 2-5 の 4 項目も一緒に転記する）。
契約を `contract.mjs` で作るときは、設定に `isolatedLiveCheck: [server]`（tmux も触るなら `[server, tmux]`）を書く（下の項目が起動の禁止の文と置き換わって入る）。

> - **CommandMate のサーバーは別ポート（`CM_PORT`）・一時データベースで動かす。** `CM_DB_PATH` は worktree の `data/` 配下などに置く
>   （`/tmp` は検証で拒まれる）。起動後に `lsof -p <pid> | grep '\.db'` で、本番のデータベースを掴んでいないことを確かめる。
> - **エージェント CLI の状態の置き場所を一時ディレクトリへ向ける。** `XDG_STATE_HOME`（必要なら `XDG_DATA_HOME` / `XDG_CONFIG_HOME` /
>   `XDG_CACHE_HOME`）と、OpenCode V2 の記録（`CM_OPENCODE_V2_DIR`）。**環境変数を書いただけで済ませず、
>   プロセスの環境に実際に効いていることを `ps eww <pid>` などで確かめる。**
> - **tmux は `-L <専用socket>` で使う**（2-5）。
> - **作ったものを後始末する。** 作ったエージェントのセッション（opencode なら `DELETE /api/session/{id}`）、サーバー、ポート、一時ファイル。
> - **利用者の状態を前後で比べる。** `service.json`・`~/.commandmate/*`・`~/.local/state/*` の一覧（`ls -la`）を作業の前後で取り、
>   変わっていないことを結果（コミットメッセージ本文か報告）に書く。

**理由**（2026-09-28）: #2944 / #2945 は、契約に隔離の手順を具体的に書いたことで、ワーカーが本番に触れずに実機確認できた。
一方 #2937 では、実装の途中で隔離が効かないまま走った実行があり、利用者の `~/.commandmate/opencode-v2/` の記録が消えたとみられる。
`env-clean` は `~/.commandmate` 直下の増減しか見ないので、下の階層が消えても捕まらない。

---

## Phase 2.5: 根本原因分析（バグIssueのみ）

Phase 1-2 で `bug` ラベルと分類されたIssueに対して、他エージェント経由で根本原因分析を実行する。
機能Issue（FEATURE_ISSUES）はこのフェーズをスキップする。

**`bug` ラベルでも、本文に原因（`file:line`）と対策が既に書かれているならスキップする。**
判定は 1-2b の「原因」の観点と同じ基準（`バグで、原因が file:line まで特定されていない`）で行う。
2.5 が生む成果物は「再現パスの特定・根本原因・対策案」の 3 つで、**それが本文に既にあるなら、
委譲しても同じものを書き直させるだけ**である。スキップしたことと理由は plan.md に 1 行残す。
（2026-09-20 の run で #2780 / #2781 の 2 件をこの理由でスキップした。どちらも原因を file:line の表で
特定し、実測と検証済みの確定パッチまで本文に載せていた）

### 2.5-1. 他エージェントに分析依頼

**このフェーズは契約を使わない（素の send のまま）。** 分析はコードを変更しない依頼であり、
`--verify` は必ず `work-evidence` ゲートを含む（`--gates` で外そうとしても `wait --verify` は
全ゲート要求になる）ため、成功した分析ほど exit 21 になる。契約付き委任は**変更を伴う委任**にだけ使う。

develop worktree上でバグIssueごとに根本原因分析を実行する：

```bash
WORKTREE_ID="mycodebranchdesk-develop"

for bug_issue in $BUG_ISSUES; do
  ISSUE_BODY=$(gh issue view "$bug_issue" --repo Kewton/CommandMate --json body -q '.body')

  # 必ず --agent copilot 等でclaude以外のエージェントを指定
  commandmatedev send "$WORKTREE_ID" "Issue #${bug_issue} の根本原因分析を実施してください。コードを変更せず分析のみ行い、結果をテキストで出力してください。

## Issue内容
${ISSUE_BODY}

## 分析要求
1. 事象の再現パスをコード上で特定
2. 根本原因を特定（直接原因、設計上の問題、類似リスク）
3. 対策案を策定（即座対策、恒久対策、予防策）" \
    --agent copilot --model claude-sonnet-5 --auto-yes --duration 1h

  commandmatedev capture "$WORKTREE_ID" --instance copilot --pane --tail 20
  # 画面のモデル表記を確認し、想定外のモデルで動いていないかを確かめる

  commandmatedev wait "$WORKTREE_ID" --instance copilot --timeout 3600 --on-prompt agent
  commandmatedev capture "$WORKTREE_ID" --instance copilot
done
```

### 2.5-2. 分析結果のIssue追記

分析結果をオーケストレーターが検証し、Issue本文に追記する：

```bash
gh issue edit "$bug_issue" --repo Kewton/CommandMate --body "${CURRENT_BODY}${ANALYSIS_SECTION}"
```

### 2.5-3. 複数バグIssueの場合

バグIssueが複数ある場合は**順次実行**する（develop worktree 1つで共有するため）。

### 2.5-4. 直す前に整える（対策の形を見る）

対策案を Issue に追記する前に、オーケストレーターは対策の形を 2 つの点で見る。
2.5 をスキップした Issue（原因と対策が本文にある）でも、本文の対策に同じ判断をする。

- **修正が「同じ処理の写しの片方だけを直す」形になるとき**: 先に整理の PR で写しを 1 つにする。その後で修正する。
  整理は別の Issue・別の PR にし、契約は 2-4-3 の型で書く。修正は、整理の PR がマージされてから始める（1-4 の強依存）
- **修正が「分岐を 1 つ足す」形になるとき**: なぜ今の仕組みで扱えないかを、Issue に書く

- **写しが要るとき（1 つにできないとき）**: ずれを検出するテストを足す。**欄の名前の一致だけでは足りない。**
  必須・省略可、値の型まで比べる。テストは、手で作った応答ではなく、**実際の応答**（実装が返す値）を使う
  （#3300: 欄の名前は同じで、必須か省略可かが違った。テストは、サーバーが返さない形の応答を手で作っていた）
- **「全部の場所が同じ決まりを守る」とき**: **同じ事例を各経路に当てるテスト**で固定する
  （例: 別サーバーのセッションを各ルートに当て、409 が返ることと、送信されないことを確かめる）。
  名前の grep の列挙を、取りこぼしの検査にしない（#3290: grep の語に掛からない経路が 1 本漏れた）。
  import があることだけで合格にしない

写しがあるかは、分析結果の「類似リスク」と、直す箇所の関数名・文言の grep で確かめる。
判断の結果は、Issue への追記（2.5-2）に含め、plan.md にも 1 行残す。

**理由（#3208、2026-10-04 の集計）**: 2026-09-01 以降の fix 198 本は、中央値で 94 行を足し、9 行を消していた。
足した以上に消した fix は 5 本だった。原因が分かる回帰 66 件のうち、35 件は bug の修正が原因だった。
同じ処理が 2 か所以上にあると、片方だけが直されて食い違う。

---

## Phase 3: 並列開発

### 3-1. 各ワーカーにタスク送信（契約付き）

**標準経路は契約付き send。** 契約は Phase 2-4 で worktree に配置済み。
`--contract` は goal を送信メッセージ本文として組み立てるので、**メッセージ引数は渡さない**
（両方渡すと exit 2）。stdout に task id が出るので控える（stderr の `Task created:` は人間向け）。

```bash
# Claude のモデルは「セッションの起動時」に、worktree の .claude/settings.local.json から決まる。
# sonnet は {"model":"sonnet"} を書く。opus は model キーを「書かない」＝ ~/.claude/settings.json の既定（opus[1m]）を継ぐ
# （"opus" と書くと 1M コンテキストが外れる。既定が opus でない環境でだけ jq '.model = "opus"' にする）。
set_claude_model() {  # <worktree-path> <opus|sonnet>
  f="$1/.claude/settings.local.json"
  # このファイルが git に無視されていること（diff にも scope ゲートにも出ないこと）を先に確かめる。無視されていなければ書かない
  git -C "$1" check-ignore -q .claude/settings.local.json || { echo "NOT ignored: $f" >&2; return 1; }
  mkdir -p "$1/.claude"; [ -s "$f" ] || echo '{}' > "$f"
  if [ "$2" = sonnet ]; then jq '.model = "sonnet"' "$f" > "$f.tmp"; else jq 'del(.model)' "$f" > "$f.tmp"; fi
  mv "$f.tmp" "$f"
}

# assign.tsv は 1-2b の結果（1 行 = "<issue>\t<claude|antigravity>\t<opus|sonnet|->"）。3 列目は Claude のモデル
# assign.tsv は fd 3 から読む（stdin にすると、ループの中の commandmatedev が残りの行を読み尽くす。下の注を参照）
while IFS="$(printf '\t')" read -r issue AGENT MODEL <&3; do
  WT=$(commandmatedev ls --branch "feature/${issue}" --quiet)
  if [ "$AGENT" = claude ]; then
    WT_PATH=$(commandmatedev ls --json | jq -r --arg id "$WT" '.[] | select(.id == $id) | .path')
    # モデルは起動時に固定される。既に Claude のセッションが動いていたら、task を作る「前」に止める
    commandmatedev instances "$WT" --json | jq -e '.[] | select(.instanceId == "claude" and .running)' > /dev/null \
      && commandmatedev instances "$WT" kill claude
    set_claude_model "$WT_PATH" "$MODEL" || { echo "exit=skip issue=${issue} (model not set)"; continue; }
  fi
  commandmatedev send "$WT" \
    --contract ".commandmate/tasks/issue-${issue}.yaml" \
    --instance "$AGENT" --auto-yes --duration 3h \
    > "workspace/orchestration/runs/$DATE/send-${issue}.out" 2> "workspace/orchestration/runs/$DATE/send-${issue}.err"
  echo "exit=$? issue=${issue}"
  TASK_ID=$(head -1 "workspace/orchestration/runs/$DATE/send-${issue}.out")
  # 送れたことは exit code ではなく、サーバーに task ができたことで確かめる
  if curl -s "http://localhost:3000/api/worktrees/$WT/tasks" \
    | jq -e --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' > /dev/null; then
    SENT=ok; echo "task ok issue=${issue} id=${TASK_ID}"
  else
    SENT=fail; echo "task MISSING issue=${issue}"
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$issue" "$WT" "$AGENT" "$TASK_ID" "$MODEL" >> "workspace/orchestration/runs/$DATE/tasks.tsv"
  # run の記録（1-5）。送った HEAD を残す。再開時は status の next=send の Issue だけ送り直す
  WT_DIR=$(commandmatedev ls --json | jq -r --arg id "$WT" '.[] | select(.id == $id) | .path')
  node scripts/orchestrate/run-log.mjs append --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
    --issue "$issue" --stage send --result "$SENT" --head "$(git -C "$WT_DIR" rev-parse HEAD)" --task "$TASK_ID" \
    --contract ".commandmate/tasks/issue-${issue}.yaml" --agent "$AGENT" --model "$MODEL"
  if [ "$AGENT" = claude ]; then
    # 起動したセッションが実際にどのモデルで動いているかを確かめる（SessionStart の hook とバナーから読まれる）
    GOT=$(commandmatedev capture "$WT" --instance claude --json | jq -r '.model // ""' | tr 'A-Z' 'a-z')
    case "$GOT" in
      *"$MODEL"*) echo "model ok issue=${issue} want=${MODEL} got=${GOT}" ;;
      "")         echo "model UNKNOWN issue=${issue} want=${MODEL}" ;;
      *)          echo "model MISMATCH issue=${issue} want=${MODEL} got=${GOT}" ;;
    esac
  fi
done 3< "workspace/orchestration/runs/$DATE/assign.tsv"
```

**assign.tsv を stdin で読まない**（2026-09-30 実測）: `while read …; done < assign.tsv` にすると、
ループの中の `commandmatedev`（`ls` / `send` / `capture`）が stdin を読み、残りの行を消費する。
その run では 1 件目の `send` の前でループが止まり、**約 90 分、ワーカーが 1 人も起動していないのに「送信中」と報告した**
（send の出力ファイルは 1 つも作られず、`GET /api/worktrees/<WT>/tasks` は空だった）。
上の雛形は fd 3 から読むので、ループの中のコマンドに `</dev/null` を付けなくてよい。雛形を書き換えて使うときも、
stdin で読む形に戻さないこと。ループを使わずに 1 件ずつ送るときは、各 `commandmatedev` に `</dev/null` を付ける。
`task MISSING` が出たら、その Issue は送れていない。`send-<issue>.err` を読み、3-1 の「冷間起動の失敗」に従って再送する。

**モデルの確認結果の扱い**:

- `model ok`: そのまま 3-2 へ
- `model UNKNOWN`: 20 秒おいて capture をもう一度読む。それでも空なら止めずに進め、8-2 のモデル欄に「未確認」と書く
- `model MISMATCH`: **1 回だけやり直す**。`commandmatedev instances "$WT" kill claude` → `cat "$WT_PATH/.claude/settings.local.json"` で中身を確かめる →
  同じ契約で再送し、tasks.tsv の task id を差し替える（exit 99 の再送と同じ扱い）。2 回目も MISMATCH なら、そのモデルのまま進めて 8-3 に書く
- tasks.tsv は 5 列になった（`issue` / `WT` / `AGENT` / `TASK_ID` / `MODEL`）。**`--instance` に渡すのは 3 列目の `AGENT`**（`claude`）で、5 列目ではない

stdout はパイプで切らずファイルに落とす（`| head` で切ると task が pending のまま残る）。
send の後に task が `cliToolId` / `instanceId` = 担当に紐づいていることを
`GET /api/worktrees/<WT>/tasks` で確かめる。

契約の goal だけでは足りない Issue（`/bug-fix` の調査手順、Phase 2.5 の分析結果の参照など）は、
**goal 本文にその指示を書く**。契約は送信メッセージそのものなので、素の send で送っていた文面は
すべて goal に入る。goal の先頭にスラッシュコマンドを書いても起動しないので、
必要な手順は goal に書き下す（2-4-2）。

- **冷間起動の失敗**: send が exit 99 で、stderr に `prompt not ready` と出たら、メッセージは送られていない
  （Codex / Command Code で実測。Antigravity は 2026-09-20 の run、#2770 で再発）。
  **待つ前に画面を見る。** 待ってから再送する手順だと、新規 worktree でほぼ必ず出る信頼ダイアログに
  2 分を払ったうえで 2 回目も同じ exit 99 になる（#2770 で実測）。

  ```bash
  SCREEN=$(commandmatedev capture "$WT" --instance "$AGENT" --pane --tail 30)
  ```

  | 画面 | 対応 |
  |---|---|
  | 信頼ダイアログ（`Do you trust the contents of this project?`） | `tmux send-keys -t "=mcbd-<agent>-<worktree-id>:" Enter` で確定 → **待たずに再送** |
  | 既にプロンプト（入力欄の枠が出ている） | **待たずに再送**（送信枠に間に合わなかっただけ） |
  | まだ起動中（バナーも入力欄も無い） | 約 2 分待ってから 1 回だけ再送する |

  再送では task が作り直されるので、tasks.tsv の task id を差し替える。
  再送も exit 99 なら、もう一度画面を見る（同じ表で分岐する）。再指示回数には数えない（3-4）。

- **スラッシュコマンドは CommandMate リポジトリの worktree でのみ有効**。外部リポジトリの worker に
  送ると `Unknown command` で無反応になる（send は exit 0、composer も空なので気づけない）。
  外部リポジトリには素のプロンプトを書く。
- 独立したIssueは並列で送信する。強依存のIssueは直列実行（先行Issue完了後に送信）。
- **送信後 `started=1`（＝ワーカーが実際に生成を開始したこと）を確認する**。send が exit 0 でも
  composer に本文が残って Enter 未確定のことがある。確認は `commandmatedev capture "$WT"` か
  orchestrate-monitor skill の `classify-state.sh`。

### 3-2. 進捗監視

定期的にステータスを確認：

```bash
commandmatedev ls --branch feature/
```

より詳細な監視は orchestrate-monitor skill を使う。契約付き委任では**タスク状態を一次ソース**に
できるので、`hooks-task.sh` を併せて読み込む:

```bash
MONITOR_HOOKS_BASE=origin/develop \
.claude/skills/orchestrate-monitor/scripts/monitor.sh \
  --verbose \
  --hooks .claude/skills/orchestrate-monitor/scripts/hooks-git.sh \
  --hooks .claude/skills/orchestrate-monitor/scripts/hooks-task.sh \
  --interval 20 --idle-threshold 8 <worktree-id> ... 2>&1 | tee monitor.log
```

介入先の tmux セッションは capture の `cliToolId` から導出されるので**指定は不要**（#1601）。
既定インスタンス以外を見るときだけ `<worktree-id>@<instance-id>`（例 `w1@codex-2`）で指定する。
**Antigravity のワーカーは `<worktree-id>@antigravity` で渡す**（worktree の既定は claude なので、
付けないと Claude のペインを見る）。

**Antigravity のワーカーも monitor の画面判定で読める（#2606 で修正）。** 修正前は、生成中の目印
（`↓ N` / `esc to interrupt`）とプロンプトの目印（`❯ N.`）が Claude の画面の文言だけで、agy の画面
（`esc to cancel`・点字スピナー・`Run this command?`）には当たらなかった。しかも agy のペインは上端寄せ
（200x1000）なので、判定が読んでいた `realtimeSnippet`（末尾 100 行）は空行ばかりだった。2026-09-17 の
パイロットでは 59 回のポーリングがすべて `IDLE started=0` で、裁定に届いたのは `hooks-task.sh` の task 状態を
読んでいたからである。現在の `classify-state.sh` は、capture の `cliToolId` が `antigravity` のときだけ
agy 用の目印を使い、`realtimeSnippet` と `content` の長い方から空行を除いた末尾を読む:

- 生成中: ステータス行の `esc to cancel`、または点字スピナー。ただし `↑/↓ Navigate` フッターがある画面では
  生成中と読まない（agy のダイアログもステータス行に `esc to cancel` を出すため）
- プロンプト: `↑/↓ Navigate` フッター＋番号つきの選択肢（`> 1. Yes` など）
- 待機中: 入力欄の枠（罫線 / `>` / 罫線 / ステータス行）。`? for shortcuts` には頼らない（#2478）

Antigravity のワーカーについては次のように扱う:

- `hooks-task.sh` は引き続き**必ず**付け、完了の一次ソースにする。ポーラーのカーソルが画面の最終行を
  越えていると、`realtimeSnippet` にも `content` にもペインの行が無く、そのポーリングは `IDLE` になる
- 着手の確認は `GENERATING` / `PROMPT` の行で行える。補助として
  `commandmatedev capture "$WT" --instance antigravity --prompts --limit 5`（Auto-Yes が応答した
  許可ダイアログが時刻つきで並ぶ）や commits / uncommitted の増加も使える
- レート制限・API エラー（再送）の目印は Claude の文言のままで、agy の画面では当てにしない
  （agy のその画面は実機キャプチャが無い）
- 画面を見るときは `commandmatedev capture "$WT" --instance antigravity --pane --tail 30` を使う
  （`--json` の `realtimeSnippet` / `content` は agy の画面では空行ばかりになることがある）

**起動直後に `monitor hooks ERROR` が出ていないことを確認する（#1728）。** 出ていたら
worktree-id が checkout に解決できておらず、`commits` / `uncommitted` は**測定値ではなく恒久 0** で、
「未起動 idle を COMPLETE と誤報しない」STARTED ガードが実質的に無効になっている。
その場合は checkout の親ディレクトリを渡して回避する:

```bash
MONITOR_WORKTREE_ROOT=.. MONITOR_HOOKS_BASE=origin/develop \
.claude/skills/orchestrate-monitor/scripts/monitor.sh ... # 以下同じ
```

**ログを `grep` で絞るときは `ERROR|WARN|alive` をパターンに必ず含めること。** 上の
`| tee` なら全部残るが、実運用でよくやる
`| grep -Ei "STALL|IDLE|BLOCKED|PROMPT|COMPLETE|NOT_STARTED|ERROR|FAIL"` 形だと、
フック側の診断（上記）と監視自身の生存報告（`monitor: alive (poll=N, …)`、既定 10 ポーリングごと）が
落ちる。2026-08-06 に監視が **exit 144 で沈黙終了**し、ワーカー 2 本が約 25 分間無監視のまま
走り続けたのはこれが理由である。`alive` が途切れた所が最後に生きていたポーリングで、
異常終了時は `caught SIG…` / `exiting on poll round …` が stderr に出る。

**monitor の COMPLETE 判定をマージ可否の裁定に使わないこと。** 裁定は 3-3 の
`wait --verify` の exit code である。

### 3-3. 完了待機と検証（`wait --verify`）

**`scripts/orchestrate/wait-verify.mjs` で待つ**（#3477）。`commandmatedev wait --verify` を呼び、裁定が**作業の終わりの状態のもの**だと
確かめてから（下の「完了の合図」と「合図の前に始まった検証」をスクリプトが行う）Auto-Yes を切り、判定の行（`GATE` / `RESULT` / `Completed`）を
1 行に要約して、run の記録（1-5）の `verify` 段に、検証が見た HEAD つきで書く。
exit code は裁定（0 / 20 / 21）か wait のもの（10 / 124 …）なので、3-4 の表がそのまま使える。
**3 は「裁定を作業の終わりに結び付けられない」**（合図が `--signal-timeout`（既定 1800 秒）の間に出ない・検証の開始の後にコミットがあり `--task` が無い・
再検証の最中にコミットされた・合格なのに作業ツリーに未コミットの変更がある）。記録は `fail`。capture で状況を見て、待ち直すか再指示する。
1 は記録の失敗、2 は引数の誤り。

```bash
# tasks.tsv（3-1）は 1 行 = "<issue>\t<WT>\t<AGENT>\t<TASK_ID>\t<MODEL>"。fd 3 から読む（3-1 の注と同じ理由）
while IFS="$(printf '\t')" read -r issue WT AGENT TASK_ID MODEL <&3; do
  WT_DIR=$(commandmatedev ls --json | jq -r --arg id "$WT" '.[] | select(.id == $id) | .path')
  node scripts/orchestrate/wait-verify.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
    --issue "$issue" --wt "$WT" --worktree "$WT_DIR" --instance "$AGENT" --task "$TASK_ID" --model "$MODEL"
  echo "exit=$? issue=${issue}"   # wait のログは runs/$DATE/wait-<issue>.log
done 3< "workspace/orchestration/runs/$DATE/tasks.tsv"
```

- スクリプトは `wait` に `--instance "$AGENT"` を必ず付ける（`wait` に `--agent` は無い。付けないと既定の claude を待つ）。
- `--on-prompt human` も必ず付ける。既定（`agent`）はプロンプト検出で即 exit 10 を返すため、
  監督ループが空回りする。
- **裁定が作業の終わりのものだと確かめてから Auto-Yes を切る**（`auto-yes "$WT" --disable --instance "$AGENT"`）。ワーカーが
  `/create-pr` などを composer に残していると、生きた Auto-Yes の Enter で確定してしまう。exit 124 / 10 と exit 3 の「作業中かもしれない」側では切らない。
  切った後に `capture --json` の `autoYes.enabled` を読み直し、切れていなければ 3 回まで再試行する。切れなかったら警告を出し、
  記録の要約に `auto-yes=NOT-disabled` と残す。切り直しだけをするときは `wait-verify.mjs --auto-yes-off --wt "$WT" --instance "$AGENT"`（切れなければ exit 1）。
  20 の再指示（3-4）の send には `--auto-yes --duration 3h` を付け直す
- **完了の確定**（下の 2 つの手順と同じことをスクリプトが行う）: Antigravity（と `--require-signal` を付けた担当）は、
  行全体が `IMPL_COMPLETED` の行が画面に出るまで 30 秒ごとに待つ。次に、直近の検証の開始時刻（`verify history`）と
  最後のターン終了（`capture --json` の `lastStopEventAt`）と最後のコミットの時刻と作業ツリーを比べる。検証の開始の後にコミットがあるか、
  最後のターン終了より前に始まって作業ツリーに変更があれば、検証は途中の状態を見ているので `verify "$WT" --task "$TASK_ID"` でやり直し、
  その結果を記録する。時刻が読めないときは推測せず、記録の要約に `run-start=unknown` / `last-stop=unknown` と残す
- **合格の記録は再利用しない。** 合格は task・契約（そのゲートの定義）・その task の開始時の env-clean の基準に結び付いていて、
  HEAD だけでは同じ確認と言えない（同じブランチに次の契約を送った直後も HEAD は同じ）。呼ぶたびに待って検証する。
  落ちた後の再開では、`run-log.mjs status` で `verify=ok` の Issue を呼び直さない（終わった task を `wait --verify` で裁定し直すと、
  紐づかない再検証になり #3118 の形で exit 20 になる）。裁定をやり直すときは `--after-reinstruct --task "$TASK_ID"`
- 再指示の後（3-4）は `--after-reinstruct --task "$TASK_ID"` を付ける。`--verify` を付けない wait → `verify --task` の 2 段になる
- Antigravity のワーカーでは、Auto-Yes が許可ダイアログに応答している間も、wait のログに
  `Prompt detected … Waiting for human response...` が繰り返し出る。応答済みかどうかは
  `capture --prompts` の `[answered:auto]` で確かめる。このログだけを見て介入しないこと。
- `--verify` は完了検出**後**に全ゲート（`work-evidence` ＋ `scope` ＋ verify.yaml の宣言ゲート）を
  実行し、その結果を exit code にする。ここが「完了したが壊れていた」を目視から exit code へ
  移す一点である。
- 契約の `gates` が `unit-related` のとき、`--verify` の裁定はテスト全体を含まない。テスト全体の合否は CI の `Unit Tests` で見る（6-2 の例外）。

**Antigravity 担当は、完了の合図（`IMPL_COMPLETED`）を確かめてから裁定する。** agy は作業の途中でも
ターンを閉じることがある。例えば、バックグラウンドで起動したコマンドの終了を `schedule`（数十秒後に自分を起こす）で待つとき。
wait はそのターン終了を完了（`basis=hook_stop`）と読むので、作業が終わる前に検証が走る。

2026-09-17 #2605 の実測（`logs/server.log`）:
- 01:28:34 `schedule` の許可 → 01:28:36 stop → wait が完了と読んで検証を開始
- その後 4 回、`schedule` で起き直しては閉じる、をくり返した
- 最後の stop は 01:33:41 で、`IMPL_COMPLETED` もこのとき出た

検証が途中の成果物ですべて通ると、未完成の変更がマージに進む。wait が返ったら、まず合図を確かめる:

```bash
commandmatedev capture "$WT" --instance antigravity --pane --tail 40 \
  | perl -pe 's/\e\[[0-9;]*m//g' \
  | grep -qE '^[[:space:]]*IMPL_COMPLETED[[:space:]]*$' && echo "signal: done" || echo "signal: not yet"
```

- **行全体が `IMPL_COMPLETED` である行だけ**を合図として数える。goal の文面（「最後に `IMPL_COMPLETED` とだけ出力する」）も
  画面に表示されるので、部分一致では誤判定する
- `not yet` なら、合図が出るまで待つ。作業が続いているかは、`capture --prompts` と commits の増加で確かめる
- 合図が出たら、wait の検証が合図より前に始まっていないかを確かめる。
  比べるのは、「wait が起動した直近の検証の開始時刻」と「最後のターン終了の時刻」（合図を出したターンの終了）の 2 つ:

  ```bash
  RUN_STARTED=$(curl -s "http://localhost:3000/api/worktrees/$WT/verify/runs" \
    | jq -r '[.runs[] | select(.trigger == "wait")][0].startedAt')          # 例 2026-09-17T01:28:40.776Z
  LAST_STOP=$(commandmatedev capture "$WT" --instance antigravity --json | jq -r '.lastStopEventAt')   # epoch ms
  node -e "console.log(Date.parse(process.argv[1]) < Number(process.argv[2]) ? 'before-signal' : 'after-signal')" \
    "$RUN_STARTED" "$LAST_STOP"
  git -C "../commandmate-issue-${issue}" log -1 --format=%cI   # 最後のコミット時刻
  git -C "../commandmate-issue-${issue}" status --porcelain    # 契約ファイル以外の変更が無いこと
  ```

  - **`after-signal`**: wait の exit code をそのまま使う
  - **`before-signal`**: 最後のコミットが検証の開始より後か、作業ツリーに変更があれば、検証は途中の状態を見ている。
    `commandmatedev verify "$WT" --task "$TASK_ID" --json` で全ゲートを検証し直し、その結果で裁定する。
    どちらも無ければ、検証は最終状態を見ている。exit 0 はそのまま採用し、exit 20 は 3-4 の「合図の前に始まった検証」に従う
- #2605 の値: 検証の開始が 01:28:40.776Z、最後のターン終了が 01:33:41.574Z（`before-signal`）。
  最後のワーカーのコミットは 01:27:47 で、作業ツリーはクリーンだった

**完了検出が壊れているときは `verify --gates` へ退避する。** `wait --verify` はゲートの前に
完了検出を通すので、検出層の欠陥が裁定そのものを止める。2026-08-24 に #2011（`isUnclassifiedActive`
の回帰）でこれが起き、**3 ワーカーの `wait --verify` が `Unclassified interactive frame …
Waiting for human response...` を並べたまま 18 分空転した**（`--on-prompt human` なので
exit 10 にもならない）。退避手順:

```bash
# 完了検出を経由せずゲートだけ回す（--gates を渡すと scope が選択されず exit 99 に落ちない）
commandmatedev verify "$WT" --gates token-discipline,control-chars,claudemd-size,route-exports,\
build-cli,build-server,lint,lint-sh,build,typecheck,integration,unit
```

この一覧は `.commandmate/verify.yaml` の宣言ゲートと同じ集合にする（`tests/unit/tasks/orchestrate-lint-sh-gate-3478.test.ts` が固定。入れないゲートは理由つきでそのテストの除外に書く）。

このとき `work-evidence` と `scope` は落ちるので、**オーケストレーターが手で照合する**
（commits ≥ 1 かつ作業ツリークリーン／`git diff --name-only origin/develop...HEAD` を契約の
`allow` と `deny` に突き合わせる）。ワーカーが完了しているかは commits と作業ツリーの状態で見る。

### 3-4. exit code 分岐

| exit | 意味 | 対応 |
|------|------|------|
| `0` | 完了・検証合格 | Phase 4（設計突合）／Phase 6（マージ）へ進む |
| `20` | 検証不合格（ゲートが落ちた） | 下記「20 の対応」。**再指示は上限2回**。超えたら Antigravity 担当は Claude（opus）へ切替（3-5）、Claude（sonnet）担当は opus へ格上げ（3-5b）、Claude（opus）担当は人間へエスカレーション |
| `21` | 作業証跡ゼロ（未着手） | 下記「21 の対応」 |
| `10` | プロンプト検出 | `commandmatedev capture <WT> --instance "$AGENT"` で内容確認 → `commandmatedev respond <WT> "<番号>" --instance "$AGENT"` → 再度 wait |
| `124` | タイムアウト | capture で状況確認 → 追加指示 or ユーザーに報告 |
| `3` | 裁定を作業の終わりに結び付けられない（`wait-verify.mjs`、3-3） | 記録の要約の `unconfirmed:` の理由を読む。作業中なら待ち直し、未コミットなら再指示 |

以降の `capture` / `respond` / `send` にも、すべて `--instance "$AGENT"` を付ける。

**20 の対応**（検証不合格）:

```bash
# 1 回目の run を読む（再実行しない）。直近の run id を取り、gates[] から失敗したゲートを読む
RUN_ID=$(commandmatedev verify history --worktree "$WT" --limit 1 --json | jq -r '.[0].id')
commandmatedev verify show "$RUN_ID" --json | jq '.gates[] | select(.status != "passed") | {gateId, status, logTail}'
```

`wait --verify` のログの `GATE <id> FAIL` 行で失敗したゲートを読んでもよい。
`--task` を付けずに `verify "$WT"` を再実行すると、task に紐づかない別の run になり、全ゲートが走る（scope は SKIP・env-clean は「ベースライン無し」）ので、ここでは再実行しない。

**先に、不合格がワーカー起因かを判定する。** 再指示と切替の回数に数えるのは、ワーカー起因の不合格だけである。

- **ワーカー起因**: `lint` / `typecheck` / `unit` など宣言ゲートの失敗、`scope` 違反、`work-evidence` の不足、
  および `env-clean` の違反のうちワーカーのコマンドが作ったもの
- **ワーカー起因ではない**: 宣言ゲートが落ちたが、**そのゲートの出力で失敗したテストが 0 件**のもの
  （ティアダウンの race。`Test Files N passed / Tests M passed` なのに exit 1 で、原因が
  `EnvironmentTeardownError` などの未処理 rejection 1 件だけ）。**負荷が下がってから
  `commandmatedev verify "$WT" --task "$TASK_ID" --gates <落ちたゲート>` で単独再実行し、再現しなければワーカー起因ではない**（契約で定義したゲートは task に紐づかないと見つからないので `--task` を付ける）
  （2026-09-20 の #2771 で実測。原因は 2-4-2 の「差し替えの条件」にある mutex の非対称）
- **ワーカー起因ではない**: `scope` の違反が、すべて同じブランチの前の契約のコミットで入ったファイルであるもの
  （契約の書き方の誤り。`git show --name-only <この契約のコミット>` がすべて allow の中なら、ワーカー起因ではない。2-4 の和集合を参照）
- **ワーカー起因ではない**: `env-clean` の違反のうち、ワーカーの作業と結び付かないもの。
  2026-09-17 のパイロットでは、`env-clean` だけが FAIL して exit 20 になった。違反は次の 3 件で、いずれもワーカーと無関係だった:
  - 別リポジトリの orchestrate が消した `mcbd-*` セッション（`-`）
  - 別プロセスの TCP listener（`-`）
  - ワーカーの最初のツール呼び出しより前の時刻が名前に入った `~/.commandmate-test-<ms>`（`+`）

  `~/.commandmate-demo-vitest-<pid>`（`+`）は、#3479 より前のコードの `env-scripts.test.ts` だけが作る
  （#3479 から作業場所は OS の一時ディレクトリで、`$HOME` には作らない）。base が #3479 より古いブランチの
  テストが並行で動いていると現れ、このワーカー起因ではないことがある（2026-09-28 の 2 本並行の run。別の worktree の
  生きたテストのものは #2954 で `other` に分かれる）。`[unattributed]` で残ったら、
  `commandmatedev verify "$WT" --task "$TASK_ID" --gates env-clean` を再実行して、その項目が消えていれば合格として扱う。

  帰属は次の 3 つで確かめる:
  - ワーカーが実行したコマンド: `capture --prompts --limit 100` の `Run this command?` と、そこに書かれた `start with '<cmd>'`
  - 最初のツール呼び出しの時刻
  - 違反項目の時刻（`~/.commandmate-test-<ms>` の `<ms>` など）

  ワーカー起因でないと判定した場合の扱い:
  - 残りのゲートがすべて PASS なら、オーケストレーターの裁定で合格として扱う
  - 裁定の根拠は PR の Test plan と summary に書く
  - ワーカーには再指示しない

**合図の前に始まった検証**（Antigravity 担当。3-3 の「完了の合図」）で `env-clean` だけが落ちたとき:

- 違反は、ワーカー自身がまだ動かしていたもの（バックグラウンドのテスト実行の listener `[self]`、
  テストが作って後で消す `$HOME` 直下のエントリなど）であることが多い。`~/.commandmate-demo-vitest-*` は
  #3479 から作られない（#3395 はこの形で、ワーカー自身のまだ動いていたテストが作ったものだった）
- 合図の後に `commandmatedev verify "$WT" --task "$TASK_ID" --gates env-clean` を再実行する
  （`work-evidence` と `scope` も一緒に走る）
- 再実行が PASS で、かつ 3-3 の確認で「最後のコミットが検証の開始より前・作業ツリーに変更なし」なら、合格として扱う。
  **再指示・切替の回数には数えない**。裁定の根拠は PR の Test plan と summary に書く
- 再実行でも落ちたら、残っている違反について、下のワーカー起因の判定に戻る
- #2605 がこの形だった: 検証の開始は 01:28、合図は 01:33。再実行は PASS で、コミットも変わっていなかった

ワーカー起因なら、失敗ゲートと `logTail` を添えて同じ worker に再指示する（契約は据え置き。再送は素の send でよく、
`--instance "$AGENT"` を付ける）。再指示は **同一 worktree につき最大2回**。
3回目に到達したら、**Antigravity 担当は 3-5 の手順で Claude に切り替える**。**Claude 担当は** worker を止め、ユーザーに判断を仰ぐ。

**再指示の後の裁定は `wait --verify` ではなく、`wait` → `verify --task` の 2 段で行う。**

```bash
# 1. 完了を待つ（--verify を付けない）
commandmatedev wait "$WT" --instance "$AGENT" --on-prompt human --timeout 10800
# 2. 契約の task を名指しして裁定する。$TASK_ID は tasks.tsv の 4 列目
commandmatedev verify "$WT" --task "$TASK_ID" --json
```

`--task` を付ければゲートは契約の `verify.gates` ＋必須の builtin（work-evidence / scope / env-clean）になるので `--gates` は要らない。

exit code の読み方は上の表と同じ。理由:
- `wait --verify` は進行中（running / waiting_input / verifying）の task にしか紐づかない（`IN_FLIGHT_TASK_STATUSES`）。1 回目の検証で task は終了済みになる
- 紐づかないと scope は SKIP、env-clean は「ベースライン無し」の ERROR で exit 20 になり、ゲートも契約ではなく verify.yaml 全部になる
- 2026-10-03 #3099 の実測: 宣言ゲートは unit 全体 1283 秒を含めて全 PASS なのに exit 20 になった

**21 の対応**（作業証跡ゼロ）: ワーカーは1行も書いていない。ほぼ常に起動側の問題なので capture で切り分ける。

```bash
commandmatedev capture "$WT" --instance "$AGENT" --pane --tail 30
```

- **composer に本文が残っている** → Enter 未確定。`tmux send-keys -t "mcbd-${AGENT}-$WT" Enter` で確定させる
  （`commandmatedev respond` は空文字を受け付けず exit 2 になるのでここでは使えない）。
  tmux セッション名は `mcbd-<エージェント>-<worktree-id>` である（Antigravity なら `mcbd-antigravity-<worktree-id>`）
- **Antigravity のアンケート画面**（`How's the CLI experience so far? [1] Good … [0] Skip`）で止まっている →
  Auto-Yes は答えず、`respond "0"` は `prompt_no_longer_active` になる。
  `tmux send-keys -t "mcbd-antigravity-$WT" -l -- 0` で閉じる（2026-09-09 実測。2026-09-17 のパイロットでは出なかった）
- **権限プロンプトで停止** → Enter で承認。monitor.sh に自動承認させる場合、送信先は
  capture の `cliToolId` から `mcbd-<cliToolId>-<worktree-id>[-<suffix>]` が導出されるので
  **オプション指定は要らない**（#1601）。`--session-prefix` は導出できないセッションを見るための
  escape hatch で、渡すと導出を丸ごとバイパスするため**混在フリートでは使わない**
  （例えば `mcbd-claude` を渡すと codex / copilot のワーカーまで claude 扱いに固定され、
  存在しないペインへ撃つことになる）。届かなかった介入は stderr に `NOT delivered` と出る
- **セッションが起動していない** → `commandmatedev ls` で存在確認、必要なら再送
- 判別のための知見は orchestrate-monitor skill の STARTED ガード（`verify-completion.sh`）を参照

### 3-5. Antigravity から Claude への切り替え

Antigravity 担当の Issue が、ワーカー起因の不合格を 2 回再指示しても合格しなかったとき（3-4 の 3 回目）に行う。
ユーザーには確認しない（2026-09-17 合意）。切り替えたことは 8-2 と 8-3 に必ず書く。

1. **Antigravity のセッションだけを止める**。他のインスタンスは止めない。
   ```bash
   commandmatedev instances "$WT" kill antigravity
   commandmatedev instances "$WT"        # antigravity の RUNNING が no であること
   ```
   止めるのは、次の task を作る**前**にする。env-clean のベースラインは task を作った時点で採られ、
   ベースラインにあったセッションが後から消えると違反になるため。
2. **Claude 用の契約** `.commandmate/tasks/issue-<N>-claude.yaml` を作る。
   - `scope` / `verify` / `success` は元の契約と同じにする
   - goal には、Claude 担当の通常の goal（2-4-2）に次の「引き継ぎ」節を足す
     ```markdown
     ## 引き継ぎ（前任: Antigravity、検証不合格 N 回）
     - 前任のコミット: <git log --oneline origin/develop..HEAD の出力>
     - 不合格だったゲートと logTail: <verify --json の該当部分。2 回分>
     - 前任の変更を読み、正しい部分は残し、誤っている部分は直すこと。作り直してもよい。
     - コミットは前任のコミットに追加してよい（1 つにまとめなくてよい）。
     ```
   - 前任のコミットがあるため、`work-evidence` は Claude が何もしなくても PASS する。
     Claude が実際に作業したかは、commits の増加と 3-3 のゲートで確かめる
3. **Claude に送る**。tasks.tsv の担当を `claude` に更新する（元の行は残し、切替の行を追記する）。
   ```bash
   AGENT=claude; MODEL=opus          # 切替先は常に opus。sonnet には切り替えない
   set_claude_model "$WT_PATH" opus  # 3-1 の関数。前の run の sonnet 指定が残っていても消える
   commandmatedev send "$WT" --contract ".commandmate/tasks/issue-${issue}-claude.yaml" \
     --instance claude --auto-yes --duration 3h \
     > "workspace/orchestration/runs/$DATE/send-${issue}-claude.out" 2>&1
   commandmatedev wait "$WT" --instance claude --on-prompt human --verify --timeout 10800
   ```
4. 以降は通常の Claude 担当として 3-4 に従う（ワーカー起因の不合格 2 回で人間へエスカレーション）。

### 3-5b. sonnet から opus への格上げ

Claude（sonnet）担当の Issue が、ワーカー起因の不合格を 2 回再指示しても合格しなかったとき（3-4 の 3 回目）に行う。
ユーザーには確認しない。格上げしたことは 8-2 と 8-3 に必ず書く。**モデルは起動時に固定されるので、セッションを作り直す以外に上げる方法は無い。**

1. **Claude のセッションだけを止める**（task を作る**前**に。理由は 3-5 の手順 1 と同じ）。
   ```bash
   commandmatedev instances "$WT" kill claude
   commandmatedev instances "$WT"        # claude の RUNNING が no であること
   ```
2. **モデルの指定を外す**: `set_claude_model "$WT_PATH" opus`（3-1 の関数。`model` キーを消して既定の opus に戻す）
3. **opus 用の契約** `.commandmate/tasks/issue-<N>-opus.yaml` を作る。`scope` / `verify` / `success` は元の契約と同じ。
   goal は Claude 担当の通常の goal（2-4-2。**sonnet 用の 2 行は外す**）に、3-5 と同じ形の「引き継ぎ」節を足す（見出しは `## 引き継ぎ（前任: Claude sonnet、検証不合格 N 回）`）
4. **送って、モデルを確かめてから待つ**。tasks.tsv には切替の行を追記する（元の行は残す）。
   ```bash
   AGENT=claude; MODEL=opus
   commandmatedev send "$WT" --contract ".commandmate/tasks/issue-${issue}-opus.yaml" \
     --instance claude --auto-yes --duration 3h \
     > "workspace/orchestration/runs/$DATE/send-${issue}-opus.out" 2>&1
   commandmatedev capture "$WT" --instance claude --json | jq -r '.model'   # opus を含むこと
   commandmatedev wait "$WT" --instance claude --on-prompt human --verify --timeout 10800
   ```
5. 以降は通常の Claude（opus）担当として 3-4 に従う（ワーカー起因の不合格 2 回で人間へエスカレーション）。

**`--phase design` 指定時**: 全ワーカーの設計フェーズ完了を確認して終了。

---

## Phase 4: 設計突合（バリア）

弱依存のIssueがある場合、設計書をクロスチェックする。

### 4-1. 各ワーカーの設計書を取得

```bash
commandmatedev capture <worktree-id>
```

各worktreeの `dev-reports/design/issue-{N}-*-design-policy.md` を確認。

### 4-2. クロスチェック観点

- **影響ファイルの重複**: 同じファイルを変更する場合のコンフリクトリスク
- **型定義の整合性**: 共通型への変更が矛盾しないか
- **アーキテクチャの一貫性**: 設計方針が相反しないか
- **モジュール境界**: 新規モジュールの責務が重複しないか

### 4-3. 問題がある場合

該当ワーカーに修正指示を送信：

```bash
commandmatedev send <worktree-id> "設計書の以下の点を修正してください: {具体的な指摘}" \
  --instance "$AGENT" --auto-yes --duration 1h
```

修正指示は**契約を作り直さない**（契約は Issue 単位の宣言であり、1往復の指摘ではない）。
指示の反映は、3-4 の同じ手順（`wait` → `verify --task "$TASK_ID"`）で裁定する。

**`--phase impl` 指定時**: 全ワーカーの実装完了を確認して終了。

---

## Phase 5: 品質確認

### 5-1. 検証ゲートの実行

Phase 3 の `scripts/orchestrate/wait-verify.mjs`（3-3）が exit 0 を返し、run の記録にその HEAD の `verify=ok` があれば
（`run-log.mjs status` で確かめる）、そのワーカーの品質は**既に裁定済み**なのでこのフェーズは飛ばしてよい。
契約無しで委任した場合（`--contract` が使えない CLI など）だけ、オーケストレーターが直接ゲートを回し、結果を run の記録に書く:

```bash
while IFS="$(printf '\t')" read -r issue WT AGENT TASK_ID MODEL <&3; do
  WT_DIR=$(commandmatedev ls --json | jq -r --arg id "$WT" '.[] | select(.id == $id) | .path')
  commandmatedev verify "$WT" --json > "workspace/orchestration/runs/$DATE/verify-${issue}.json"; RC=$?; echo "exit=$RC"
  node scripts/orchestrate/run-log.mjs append --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
    --issue "$issue" --stage verify --result "$([ "$RC" = 0 ] && echo ok || echo fail)" \
    --head "$(git -C "$WT_DIR" rev-parse HEAD)" --agent "$AGENT" --note "exit=$RC (verify without a contract)"
done 3< "workspace/orchestration/runs/$DATE/tasks.tsv"
```

**CI にあって手元のゲートに無い手順は、`tests/unit/guards/ci-steps-local-coverage-3478.test.ts` の除外の一覧（理由つき）にだけ置く**（#3478）。
shellcheck は `lint-sh` ゲート（`scripts/run-lint-sh-if-changed.mjs`。`.sh` を変えたときだけ `npm run lint:sh`）が見る。
orchestrate の道具の置き場所は #3477 で `scripts/orchestrate/`（`lint:sh` の走査の中）に決まったので、`.claude/skills/**` は走査に足さない。

**ワーカーに「lint/tsc/test を実行して結果を報告して」と送らないこと。** 報告文の解析は
「全部 Pass です」という散文を信じることであり、`wait --verify` / `verify` の exit code が
置き換えた当のもの。exit code は `0`=合格 / `20`=不合格 / `21`=作業証跡ゼロ。

### 5-2. 品質NGの場合

`--json` の失敗ゲートと `logTail` を添えてワーカーに修正を指示し、再度 `verify`。
最大3回まで自動リトライ。

### 5-2b. 整合性レビュー（試行中の段、2026-10-20 まで）

#3308 の試行（整合性レビュー、30 回・22 本）を受けた利用者の判断（2026-10-06）により、**対象を絞って、期限付きで続ける。** 常設はしない。期限の後に、数えた結果で続ける・入れる・やめるを決める。

- **期限:** 2026-10-20 まで（2 週間）。期限の日に、下の数え方で集計し、Codex のレビューを受けてから利用者に伺う
- **対象（変更の影響で選ぶ。接頭辞の一律の除外はしない）:** 危険な変更（hook・セッション・検出・ポーリング・tmux・security・応答の形・隔離）と、対になる場所がある変更。refactor でも、共有の処理を動かすもの・検証の条件を変えるものは対象に残す。docs だけ・テストだけは除く。**除外した PR からも、run ごとに 1 本を抜き出してレビューし、偏りを確かめる**
- **段:** ワーカーの完了の後・PR の前。依頼したときの HEAD を記録し、その後の変更と区別する。ワーカーの「対になる場所を探した結果」（2-4-2）を入力に使い、レビューの独自の発見を見分ける
- **担当:** Codex（暫定。優位が実証されたとは扱わない）。Claude を足すのは、重大な変更・ワーカーが「未確認」と書いた所・判断が割れた所（隔離・所有・security に限らない）
- **再レビュー:** 自動は 3 回まで。3 回目の後に重大な指摘が残ったら、**止めて人の判断へ**（別の Issue に送ってマージしない）
- **Codex のセッション:** 1 つを直列で使う。依頼は 1 本ずつ（ロック）。待ち時間を記録する
- **数え方（期限の集計で使う）:** 延べではなく、重複・既報（ワーカーが報告済み・5-3 で処置できた）を除いた「レビューの独自の発見」を、**動作／説明／テスト** と **新規／既存** の 2 軸で数える。指摘の正しさは、一部を別の判定者（Codex と Claude の相互）で再判定する。費用は 1 本あたり、待ち時間・再指示・修正を含めた総時間で測る。後の段（CI・ガード・実機・UAT）で見つかった漏れも記録する

**記録の様式。** 置き場所は `workspace/orchestration/runs/<date>/consistency-review.md`。1 レビュー 1 行の表にする。

```
| # | Issue | 担当 | 依頼した HEAD | 時間（待ちを含む） | 指摘 | 独自の発見（重複・既報を除く） | 種類（動作／説明／テスト） | 新規／既存 | 再判定 | 処置 | 事前レビューの有無 |
```

**再指示の書き方（#3397 で前回の指摘の一部の未対応が続いた）。** 整合性レビューの指摘で再指示するときは、指摘の文をそのまま貼らず、
**守るべき条件・全経路・対照のテストに言い換えて**契約に書く。守るべき条件は 1 文で、全経路は直す場所の一覧で、対照のテストは陽性と陰性の組で示す。

**再レビューでは、前回の指摘が解消したかを先に確かめる。** 新しい指摘を探す前に、前回の指摘を 1 件ずつ「解消／一部未対応／未対応」に判定して記録する。

**2026-10-20 の集計の手順。**

1. 各 run の `consistency-review.md` の表を合計する（独自の発見を 動作／説明／テスト × 新規／既存 で数え、1 本あたりの総時間を出す）
2. 続ける・入れる・やめるの判断案を書く
3. 判断案について Codex のレビューを受ける
4. 利用者に伺う（#3308 と同じ流れ）

前の記録（`runs/2026-10-05/consistency-review-trial.md`）を基準線として参照する。

### 5-3. 「本文に無い指摘」を処置する（Phase 6 の前・マージの条件）

ワーカーが報告した「本文に無い指摘」を、オーケストレーターが 1 件ずつ、次のどれかに決めて、run の記録（8-2）に書く。

- 再指示する（契約の範囲を広げて、同じ PR で直す）
- 追跡する Issue にする（8-4）
- 対応しない（理由を書く）

計測の誤り（数え方の穴）の報告は、ワーカーに直させない。計測の誤りは、別の Issue にして計測を直す（#3270 → #3389）。

**未処置の指摘が残っている PR は、マージしない。** 報告を一覧に残すだけでは、指摘は最後まで処置されない
（#2011 のコミット文は「`api-responses.ts` は scope 外なので直していない。要追随」と書いたが、追跡する Issue にならず、
後に #3298 として出た。#1899 の「hook を受ける側は直していない」も #3289 になった）。

PR を出す前に、次も確かめる:

- **ガードのテスト（`tests/unit/guards`）を全部通す。** 実測（2026-10-05 #3291）: レビューを通った後に CI のガードで落ちた
- **検証の順番待ちの間に、オーケストレーターが worktree にコミットしない。** 実測（2026-10-05 #3292・#3295）:
  コミットした結果、変更が scope の外に出て scope ゲートが落ちた

---

## Phase 6: PR作成・マージ

PR の作成とマージは、次の 2 本のスクリプトを呼ぶ（#3477）。`/pr-merge-pipeline`（ワーカーに `/create-pr` を送る流れ）は
並列オーケストレーションでは使わない。止まる条件と run の記録を持たないためである。

- `scripts/orchestrate/publish-pr.mjs`（6-1）: push・module-reference の断片の控え（`runs/$DATE/module-reference-<N>.md`）・PR の作成。記録の `pr` 段
- `scripts/orchestrate/merge-pr.mjs`（6-2・6-3）: develop が進んでいれば試しのマージ・CI の待ち（落ちたジョブは HEAD ごとに 1 回だけ再実行）・
  squash でマージ・Issue のクローズ（`--close -` なら閉じない。1 本の Issue を複数の PR に分けたときの途中の PR など）。記録の `ci`・`merge` 段

**止まる条件。** どちらも、作業の HEAD について run の記録に `verify=ok`（3-3・5-1）・`review=ok`（5-2b）・`findings=ok`（5-3）・`precheck=ok`（6-1-1）が
無ければ、何も公開せずに止まり、欠けたものを出す（exit 1）。**5-2b の対象でない Issue は `review` 段に `skip` を記録しておく**
（忘れたレビューと、対象でないレビューを区別するため）。記録は、ワーカーの最後のコミットのものを、その上の develop の取り込み（6-2）と
module-reference の一本化だけのコミット（6-4）を越えて使う。`changelog.d/<N>.md` がコミットに無い・module-reference の断片が無いときも止まる（6-4）。

**二重に実行しない。** ブランチに開いた PR があれば作らない（push だけして、その PR を記録する）。別のブランチの開いた PR の題名に `(#<N>)` があれば止まる。
マージ済みの PR はマージしない（記録が無ければ記録し、Issue が開いていれば閉じるだけ）。どちらも、途中で落ちた後に同じ引数で再実行すると続きから同じ結果になる。

ただし**並列オーケストレーションでは次を守る**。

### 6-1. 同時 CI は 3〜4 本。**1 本に落とすのも失敗である**

CI は使い捨ての self-hosted ランナー 8 台（2026-09-18 時点）で、PR あたり 14 ジョブを回すので
（#2638 で Unit Tests を 4 本に分割）、同時本数を上げると 1 本あたりが
伸びる。**が、伸び始めるのは 4 本を超えてからで、3〜4 本まではほぼ無償である。**

分割前の実測（CI 実行 118 本、2026-08-21〜24）:

| 同時実行ピーク | CI 中央値 | 最大 |
|---|---|---|
| 1 | 10.8 分 | 12.3 分 |
| 3 | 11.6 分 | 15.5 分 |
| 4 | 14.7 分 | 28.6 分 |
| **20** | **49.2 分** | **162.4 分** |

分割後は 1 本あたりのジョブ数が増えるので、同時本数の推奨は分割後の実測で見直す（#2638）。

**3〜4 本までは +8〜36% で、スループットはほぼ線形に伸びる。** 20 本は 4.5 倍の劣化で、
増やした分を食い潰す（この帯では 1 マージあたりの CI 実行回数も 3.7 回まで膨らんでいた＝
refresh のやり直し）。

**逆方向の失敗の方が高くつく。** 2026-08-23〜24 に同時 1 本で回した帯では、CI 単体は
10.8 分と最速だったのに**スループットは 2.50 → 0.50 PR/h（5 分の 1）**まで落ちた。
1 本あたりの品質指標（CI 実行回数 3.7 → 2.0、PR 作成→マージ 最長 6 時間 → 11〜13 分）は
すべて改善していたので、落ちたのは並列度だけである。**「丁寧にやる」を「1 本ずつやる」と
取り違えないこと。**

裁定が終わったワーカーが 5 本目以降になったら、PR を作らずに待たせる。worktree は残してよい。

PR は 6-1-1 の確認（precheck）が通ってから出す:

```bash
node scripts/orchestrate/publish-pr.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
  --issue "$issue" --worktree "$WT_DIR" --label feature   # ラベルは種類に応じて feature / bug / documentation / refactor
echo "exit=$?"   # 0 → PR がある（作った・既に開いていた・マージ済み） / 1 → 出力の欠けた記録・断片を埋めて再実行 / 2 → 作業ツリーが汚れている
```

### 6-1-1. PR はゲートの**前**に出す（CI とローカルゲートを並走させる）

`wait --verify` / `verify --gates` のローカルゲートと CI は**同じテストを見ている**。
順に回すと 1 issue あたり約 22 分（ローカル 10.8 分 ＋ CI 10.8 分）を直列で払う。

**PR の前は速い確認（`scripts/orchestrate/precheck.mjs`、#3477）だけを通して PR を出し、
残りのゲート（`integration` / `unit` / `build`）は CI と並走させる。** 実測でローカルゲートの
85〜90% は `unit` 単独（545〜584 秒）なので、**1 issue あたり約 10 分が消える。**

```bash
# 段の順: verify（3-3）→ review（5-2b）→ findings（5-3）→ precheck → PR → CI（残りのゲートと並走）→ merge
node scripts/orchestrate/precheck.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
  --issue "$issue" --worktree "$WT_DIR"            # 整理の Issue は --kind refactor、計測の Issue は --metrics を足す
echo "exit=$?"   # 0 → PR を出す / 1 → runs/$DATE/precheck-<issue>-<sha>.log で落ちた段を読み、再指示 / 2 → 作業ツリーが汚れている
```

- 段: 断片の検査（`node scripts/changelog-fragments.mjs check`）・削除した `it` / `describe` の数（0 でなければ落とす。契約の決定が許したときだけ `--allow-removed-tests`）・
  変更したファイルの ESLint・`.sh` を変えたら `node scripts/run-lint-sh-if-changed.mjs`・整理と計測の Issue だけ `node scripts/count-suppressions.mjs`（2-4-3）・
  `tsc --noEmit`・関係するテスト（`vitest related` ＋ 変更したテスト・変更したパスを名指しするテスト・`tests/unit/guards`・`tests/unit/docs`）
- 結果は run の記録の `precheck` 段に HEAD つきで書く。**同じ HEAD・同じ引数（`--base` / `--kind` / `--metrics` / `--allow-removed-tests` / `--build`）の `ok` があれば
  走らせずに再利用する**（どの段も、コミットされた木と引数だけを読む。落ちた後の再実行でも同じテストを 2 回走らせない）。
  同じ HEAD の `verify=ok` が通した verify.yaml のゲートのうち、同じ確認になるもの（`lint` → ESLint、`typecheck` → tsc、`lint-sh` → lint-sh）の段も走らせない。
  契約が定義したゲート（`<id>@contract`）と、テストのゲート（`unit` / `unit-related`。選ぶテストが違う）は、どの段の代わりにもならない
- 関係するテストは `tests/unit` に限る（`vitest related --dir tests/unit`）。integration / e2e は CI が見る
- **build は PR の前の確認に入れない（CI の `Build` と並走させる）。** その代わり、マージの前に CI の `Build` が `pass` であること、
  または同じ HEAD の precheck の記録に `build=ok` があること（`--build` を付けて走らせたとき）を確かめる（6-2・6-3）
- 作業ツリーに契約（`.commandmate/tasks/`）と `dev-reports/` 以外の変更があると、その HEAD の結果にならないので exit 2 で止まる

壊れた PR で CI を焼くリスクは、先に通す確認でほぼ潰せる。両方が緑になってからマージするので
裁定の強さは変わらない。

### 6-2. マージは「先行をマージ → 後続を refresh → tsc ＋ 影響テスト → マージ」

**`gh pr view --json mergeable` の `MERGEABLE` は「テキスト衝突が無い」しか意味しない。
組み合わせがコンパイルできる証拠ではない。** 2026-08-22 に、単独でどちらも全ゲート緑・CI 11/11 の
2 本を続けてマージして develop の `tsc` と `test:unit` を壊した（一方が関数を rename し、
他方のテストが旧名を使っていた）。同型の統合破壊はこの run で 2 件あり、**どちらも
`npx tsc --noEmit` と影響テストのローカル実行で捕まった**。

マージの条件の 1 つとして、**未処置の指摘（5-3）が残っている PR はマージしない**。

1 本マージするたびに、残りの各 PR で `merge-pr.mjs` を呼ぶ。develop が進んでいれば、次を順に行ってからマージする:
`git fetch` と `git merge origin/develop`（衝突したら `git merge --abort` して止まる）→ 衝突の印の走査（全追跡ファイル）→
`npx tsc --noEmit`（実際の統合破壊はここで出る）→ `CI=true npx vitest run <PR が変えたテストと、PR が変えたパスを名指しするテスト>`
（型に出ない相互作用はここで出る）→ `git push`。どれかが落ちたら push せずに止まる（記録の `merge` 段に `fail`）。

```bash
node scripts/orchestrate/merge-pr.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
  --issue "$issue" --worktree "$WT_DIR"            # 最後の 1 本は --last。Issue を閉じないときは --close -
echo "exit=$?"   # 0 → マージ済み / 1 → 出力の欠けたもの・落ちた段を読む / 2 → 作業ツリーが汚れている / 124 → CI が --ci-timeout（既定 3600 秒）に収まらない
```

衝突で止まったときは、意味を見て解消（機械解決は module-reference などの共有ファイルだけ）してコミットし、同じ引数で再実行する。

機械的に解決してよい衝突は、`docs/module-reference.md` などの共有ファイルでだけ起こりうる。CHANGELOG の断片は
Issue ごとに別ファイル（`changelog.d/<N>.md`）で、`CHANGELOG.md` はリリースまで書き換えないので、ここでは衝突しない（2-4-1）。

**マーカー走査を共有ファイル（`docs/module-reference.md` など）の決め打ちにしないこと。** 2026-08-22 に JSDoc ブロックコメントの
内側へ落ちた衝突マーカーをコミットした事例がある（**コメント内なので `tsc` は exit 0、
関連テストも緑**だった）。

上記が通れば**フル CI の完走を待たずにマージしてよい**。develop 側の CI（12〜25 分）が安全網に
なる。**最後の 1 本だけ**はフル CI を待つ。

**例外: 契約の `gates` が `unit-related` の PR は、CI の `Unit Tests` が `pass` になってからマージする**（#2639）。
ローカルの裁定がテスト全体を含まないため。

**例外: build。CI の `Build` が `pass` になってからマージする**（#3477）。6-1-1 で build を PR の前の確認から外し、契約の既定のゲートにも
precheck にも build が無いので、ローカルのどの裁定もビルドを見ていない。ただし、マージする HEAD（refresh の後の HEAD）の precheck の記録に
`build=ok` があれば（`precheck.mjs --build`）、`Build` の `pending` は待たなくてよい。ほかのジョブの扱いは上のとおり。

マージ（または close）すると、**その PR の `pull_request` run は
`.github/workflows/cancel-pr-runs-on-close.yml` が自動で止める**（Issue #2330）。**手でキャンセル
しないこと。** マージ後に PR のチェックが `cancelled` と表示されるのは**正常であって失敗の証拠では
ない** — 裁定を出すのは develop 側の push run のほうである。この自動キャンセルは
`--event pull_request` と PR の head ref で絞るので、**develop / main の push run には構造的に
届かない**（＝安全網は止まらない）。

### 6-3. マージ前に `fail` / `cancel` が無いことを機械的に確認する

`gh pr checks <PR> --json name,bucket` を読み、**`bucket` に `fail` / `cancel` が 1 つでも
あればマージしない**。2026-08-22 に「10 pass / 1 fail（Build）」の PR を、fail を目視で見落として
マージし develop のビルドを壊した。判定は目視ではなくスクリプトで行うこと。

`merge-pr.mjs` がこの判定を行う（落ちたジョブは HEAD ごとに 1 回だけ `gh run rerun --failed` で再実行し、それでも落ちればマージしない）。
`pending` の扱いは 6-2 に従う: **6-2 のローカルゲート（refresh → マーカー走査 → `tsc` →
影響テスト）を通していれば `pending` は待たなくてよい**。develop 側の CI が安全網になるからで、
待つと 1 issue あたり 12〜25 分が消える。**最後の 1 本だけ**は全 `pass` を待つ。

`unit-related` で裁定した PR では、`Unit Tests` のチェックが `pass` になってからマージする（6-2 の例外）。
`Build` のチェックも `pass` になってからマージする（6-2 の例外。マージする HEAD の precheck の記録に `build=ok` があるときだけ、その `pending` は待たなくてよい）。

`merge-pr.mjs` が `Build` について見る条件は次と同じ（手で確かめるときもこれを使う）:

```bash
# Build が pass か、マージする HEAD に build=ok の precheck の記録があるか。どちらも無ければマージしない
gh pr checks "$PR" --json name,bucket | jq -e '.[] | select(.name == "Build" and .bucket == "pass")' > /dev/null \
  || jq -e --arg h "$(git -C "$WT_DIR" rev-parse HEAD)" --argjson n "$issue" \
       'select(.issue == $n and .stage == "precheck" and .head == $h and .result == "ok" and (.note | test("(^| )build=ok( |$)")))' \
       "workspace/orchestration/runs/$DATE/run-$RUN_ISSUES.jsonl" > /dev/null \
  || echo "NOT mergeable: Build is not pass and there is no build=ok precheck for this HEAD"
```

### 6-4. module-reference の断片を本体へ一本化する（オーケストレーターの仕事）

2-4-1 でワーカーに書かせた module-reference の断片を、**オーケストレーターが PR ブランチ上で
本体へ写してから push する**（マージの直前、6-2 の refresh と同じタイミング）。
CHANGELOG は書き写さない。ワーカーがコミットした `changelog.d/<N>.md` を、リリース時に `/release` が
`CHANGELOG.md` へ集約する（2-4-1）。

```bash
# module-reference: 行キーごとに既存行の注記セルへ追記（行を増やさない）。
# publish-pr.mjs が PR を出すときに run のディレクトリへ控えている（dev-reports/ は worktree と一緒に消える）
cat "workspace/orchestration/runs/$DATE/module-reference-<N>.md"
```

一本化のコミットは `docs/module-reference.md` だけを変える。`merge-pr.mjs` はこのコミットを越えてワーカーのコミットの記録を使う
（ほかのファイルも変えたコミットを足すと、記録はその HEAD のものではなくなり、止まる）。

一本化したら**必ず機械的に検証する**:

```bash
# module-reference: 同じ行キーが 2 本になっていない
awk -F'|' '/^\| `/{print $2}' docs/module-reference.md | sort | uniq -d
```

CHANGELOG の断片は、同じタイミングで PR ブランチ上で次を確認する:

```bash
# changelog.d/<N>.md がこの PR のコミットに含まれている（未コミットの断片は出ない）
git diff --name-status origin/develop...HEAD -- changelog.d/   # 状態 A（追加）の changelog.d/<N>.md の 1 行だけであること
# 断片の書式が通る（他の断片も含めて全件を検証する）
node scripts/changelog-fragments.mjs check; echo "CHECK=$?"     # CHECK=0 であること
```

既存のテストが消えていないことも、同じタイミングで確認する（`unit-related` のゲートはテストが消えたことを検出できない。2-4-2 の #2936）:

```bash
# 削除された it / describe / test の行数。0 であること
git diff origin/develop...HEAD -- 'tests/**' | grep -cE '^-\s*(it|describe|test)\('
```

0 でなければ、差分を読んで意図を確かめる（名前の変更・移動なら理由が本文かコミットメッセージにあるか）。

**断片が無い PR はマージしない**（`publish-pr.mjs`・`merge-pr.mjs` が止まる）。`changelog.d/<N>.md` がコミットに含まれていない PR も、
module-reference の断片が無い PR も同じ扱いにする。リリースノートに載らない Issue が出る
（過去に実際に発生し、後追いで docs PR が必要になった）。`check` が exit 0 にならない PR もマージしない
（リリース時の `apply` は、1 つでも不正な断片があると何も書かずに止まる）。

**`--phase pr` 指定時**: PR作成・マージ完了を確認して終了。

---

## Phase 7: UAT（--full時のみ）

### 7-1. 受入テスト実行

developブランチ（オーケストレーター自身）で実行：

```bash
git pull origin develop
/uat {issue_numbers}
```

### 7-2. UAT結果判定

- **全PASS**: Phase 8（完了）へ
- **FAILあり**: `/uat-fix-loop` を実行

```
/uat-fix-loop {fail_issue_numbers}
```

詳細は `/uat-fix-loop` コマンドを参照。

---

## Phase 8: 完了報告

### 8-1. 最終検証

```bash
npm run lint
npx tsc --noEmit
npm run test:unit
npm run build
```

### 8-2. 結果レポート

`workspace/orchestration/runs/$DATE/summary.md` に統合サマリーを出力：

```markdown
## オーケストレーション完了報告

### 対象Issue

| Issue | タイトル | ステータス |
|-------|---------|-----------|
| #{N} | {title} | 完了 |
| #{M} | {title} | 完了 |

### 担当と結果（1-2b / 3-5）

| Issue | 難易度 | 担当 | モデル（実測） | 判定の根拠 | 再指示 | 切替 | 実装時間 | 検証 | 帰属の裁定 |
|-------|--------|------|---------------|-----------|--------|------|---------|------|-----------|
| #{N} | 易 | antigravity | — | {plan.md の根拠} | 0 | なし | 5 分 | exit 20 → 合格扱い | env-clean の違反はワーカー起因でない（{根拠}） |
| #{M} | 易 | antigravity → claude | opus | {根拠} | 2 | 切替（{失敗ゲート}） | {分} | exit 0 | — |
| #{L} | 中 | claude | sonnet（`claude-sonnet-5-5`） | {根拠} | 0 | なし | {分} | exit 0 | — |
| #{K} | 中 | claude | sonnet → opus | {根拠} | 2 | 格上げ（{失敗ゲート}） | {分} | exit 0 | — |

「モデル（実測）」には、3-1 で `capture --json` の `.model` から読んだ値を書く（指定した値ではなく、動いていた値）。

### 実行フェーズ結果

| Phase | 内容 | ステータス |
|-------|------|-----------|
| 1 | 依存関係分析 | 完了 |
| 2 | Worktree準備 | 完了 |
| 3 | 並列開発 | 完了 |
| 4 | 設計突合 | 完了（問題なし） |
| 5 | 品質確認 | 完了（全Pass） |
| 6 | PR・マージ | 完了（PR #XX, #YY） |
| 7 | UAT | 完了（全PASS） |

### 品質チェック

| チェック項目 | 結果 |
|-------------|------|
| npm run lint | Pass |
| npx tsc --noEmit | Pass |
| npm run test:unit | Pass |
| npm run build | Pass |

### 成果物

- 設計書: dev-reports/design/issue-{N}-*-design-policy.md
- 作業計画: dev-reports/issue/{N}/work-plan.md
- 進捗報告: dev-reports/issue/{N}/pm-auto-dev/iteration-1/progress-report.md
- UATレポート: dev-reports/issue/{N}/uat/acceptance-test-report.html
- 統合サマリー: workspace/orchestration/runs/{DATE}/summary.md
```

### 8-3. 振り分けの改善案

summary.md の末尾に「振り分けの改善案」節を書き、完了報告でユーザーにも示す。
**次のどれかが起きた run では必須**（何も起きなかった run でも、気付いた点があれば書く）:

- Antigravity から Claude への切り替え（3-5）
- sonnet から opus への格上げ（3-5b）、または sonnet 担当が再指示を要した（1-2b の「中」の条件が甘い証拠になる）
- `model MISMATCH` / `model UNKNOWN` のまま進めた（3-1）
- ワーカー起因でない不合格を、オーケストレーターの裁定で合格扱いにした（3-4）
- 判定表と実際の結果が食い違った（「易」と判定したのに再指示が要った／「難」と判定したが小さい変更で終わった）
- Antigravity 固有の停止（アンケート画面、冷間起動の失敗、monitor の誤判定など）

各項目には次の 3 つを書く:

1. **事実**: Issue、担当、何が起きたか（ゲート名・時刻・コマンド）
2. **原因の見立て**: 判定表のどの観点が外れたか。または、道具のどの欠陥か
3. **改善案**: 判定表の条件の足し引き、goal の雛形（2-4-2。`scripts/orchestrate/templates/goal.md`）の追記、道具の Issue 起票の要否。
   起票はユーザーの了承を得てから行う

**起票の前に、同じ不具合の開いている Issue を探す**（UAT の指摘・ワーカーの報告・8-3 の改善案のどれでも）。
日次確認（`agent-health`）は、毎朝 07:00 の Schedule が `<!-- agent-health:<tool>:<checkId> -->` を本文に入れた Issue を自動で起票する。
並行する別のセッションやワーカーが、先に起票していることもある。

```bash
gh issue list --repo Kewton/CommandMate --state open --label agent-health --json number,title,createdAt
gh issue list --repo Kewton/CommandMate --state open --search "<ファイル名か関数名> in:body" --json number,title,createdAt
```

見つかったら新しく起票せず、その Issue に追加の事実をコメントする。自動起票の Issue は残す
（翌朝の Schedule は `agent-health:<tool>:<checkId>` を本文に持つ開いた Issue を探してコメントするので、手で起票した別の Issue では重複を防げない）。
2026-09-30 に 2 回、この確認をせずに重複を起票した: #3024（日次確認が 36 分前に #3021 / #3022 を起票済み）と
#3031（同じ朝に別のセッションかワーカーが #3026 を起票済み）。

**bug として新しく起票するときの「分類」節**:

不具合を bug Issue として起票するとき（`gh issue create --label bug --body …` でテンプレートを通らないときも）、本文の末尾に次の「分類」節を置く。
値は決まった語から選ぶ（`.github/ISSUE_TEMPLATE/bug_report.md` と同じ語。日次メトリクスの `bug-flow` がこの節を数える）。

```markdown
## 分類
- 原因の PR: #<番号> / 不明 / なし（以前から）/ 上流（<CLI> <版>）
- 発見経路: uat / review / orchestrate / daily-use / automated
- 影響する経路: chat / terminal / cli / mobile / auto-yes / push / なし（内部）
```

- 各行は 1 つを選んで書き換える（例: `- 原因の PR: #3191`、`- 原因の PR: 上流（codex 0.50.0）`、`- 発見経路: uat`）。
  影響する経路だけは複数を `, ` で区切って書ける（例: `- 影響する経路: chat, mobile`）。選択肢を残したままの行は「未記入」に数えられる
- 影響する経路は取りこぼしを防ぐ欄。直す人は、挙げた経路すべてを確かめる
- 影響する経路が `なし（内部）`（テスト・CI・開発用スキル・agent-health・orchestrate）なら、`bug` に加えて `internal` ラベルも付ける
  （`gh issue create … --label bug --label internal`）

### 8-4. 整理の Issue の候補

ワーカーが報告した重複（1-2b の退避路の「本文に無い指摘」）を、整理の Issue の候補として利用者に示す。
報告を一覧に残すだけでは、重複は減らない。run の最後に、起票するかを必ず訊く。

1. `workspace/orchestration/runs/$DATE/refactor-candidates.md` の一覧を、summary.md の末尾の「整理の Issue の候補」節に写す。
   1 件 1 行で、報告した Issue・`file:line`・何と何が写しかを書く。候補が無ければ「候補なし」と書く
2. 完了報告で、候補を整理の Issue として起票するかを、利用者に訊く。起票は了承を得てから行う（8-3 と同じ）
3. 起票の前に、同じ内容の開いている Issue を探す（8-3 の手順）。見つかったら新しく起票せず、その Issue にコメントする
4. 起票する Issue には、まとめる写しの場所（`file:line`）と、振る舞いを変えないことを書く。契約は 2-4-3 の型で書く

5. 意図して残した制限を、追跡する Issue にする。「この PR では直さなかった」「この条件のときは誤る」と分かっているものは、
   コードのコメントやコミット文に書くだけで済ませない。1 件 1 Issue で、残した場所（`file:line`）・誤る条件・直さなかった理由を書く
   （起票は 2 と同じく了承を得てから行う）。5-3 で「追跡する Issue にする」と決めた指摘も、ここで起票する

写しどうしに食い違いがある報告は、整理の候補に混ぜない。振る舞いを変えずには、1 つにできないからである。
仕分け用の Issue に集める（2-4-3 の「範囲外の食い違い」）。

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| developブランチでない | エラー表示し中断 |
| CommandMateサーバー未起動 | `commandmatedev start --daemon` を案内 |
| worktree作成失敗 | エラー表示、手動作成を案内 |
| ワーカーのタイムアウト（exit 124） | captureで状況確認→追加指示 or ユーザーに報告 |
| 検証不合格（exit 20） | `verify --json` で失敗ゲートを特定し、先にワーカー起因かを判定（3-4）。ワーカー起因なら再指示。上限2回で、Antigravity 担当は Claude（opus）へ切替（3-5）、Claude（sonnet）担当は opus へ格上げ（3-5b）、Claude（opus）担当は人間へエスカレーション |
| env-clean だけが FAIL（exit 20） | `capture --prompts` と違反項目の時刻で帰属を判定。ワーカー起因でなければ合格扱いにし、根拠を PR と summary に書く（3-4） |
| 再指示の後の検証で scope が SKIP（`was not attached to it`）／env-clean が `no baseline snapshot exists for this run` | task に紐づいていない。`verify --task <task id>` で検証し直す（3-4） |
| 作業証跡ゼロ（exit 21） | captureでcomposer未確定・権限プロンプト・未起動を切り分け（Phase 3-4） |
| send が exit 99（`prompt not ready`） | 未送信。**待つ前に capture で画面を見て**、信頼ダイアログ / 既にプロンプト / まだ起動中で分岐する（3-1 の表）。task id は再送のたびに差し替える |
| Antigravity がアンケート画面で停止 | `tmux send-keys -t "mcbd-antigravity-$WT" -l -- 0` で閉じる（3-4） |
| monitor が Antigravity を `IDLE` / `NOT_STARTED` と表示 | #2606 以降は agy 用の目印で読むので、生成中なら `GENERATING` になる。それでも出るのは、capture の `--json` にペインの行が無いポーリング。task 状態と `capture --prompts` で判断する（3-2） |
| 契約エラー（send が exit 2） | 契約の全エラーが一度に出るので、`docs/design/task-contract.md` と突き合わせて修正し再送 |
| 品質チェック3回連続失敗 | ユーザーに報告して中断 |
| コンフリクト解消失敗 | ユーザーに報告して中断 |
| UAT 4回連続FAIL | ユーザーに判断を仰ぐ |

---

## 完了条件

- [ ] 全Issueの開発が完了している（契約付き委任は `wait --verify` が exit 0）
- [ ] 品質チェック全パス（ESLint, TypeScript, テスト, ビルド）
- [ ] 全IssueのPRがdevelopにマージ済み
- [ ] 各Issueの `changelog.d/<N>.md` がコミットに含まれ（`check` が exit 0）、module-reference の注記が本体に一本化されている（6-4）
- [ ] developブランチでの統合ビルド・テストが全パス
- [ ] （--full時）UAT全テストPASS
- [ ] 統合サマリーが出力されている（「担当と結果」表を含む。3-5 の切替か 3-4 の帰属裁定があった run では「振り分けの改善案」も含む）

## 関連コマンド

- `/pm-auto-issue2dev`: Issue単位の全自動開発（機能Issueに送信）
- `/bug-fix`: バグ調査→修正→テスト（バグIssueに送信）
- `/cause-analysis`: 根本原因分析（他エージェント経由、バグIssueのPhase 2.5で使用）
- `/current-situation`: 不具合事象の整理とIssue登録
- `/pr-merge-pipeline`: PR作成からマージ完了まで
- `/uat`: 受入テスト
- `/uat-fix-loop`: UAT不合格時の修正ループ
- `/issues-exec-plan`: 複数Issueの実行計画策定
- `/worktree-setup`: worktree個別作成
- `/worktree-cleanup`: worktree個別削除
