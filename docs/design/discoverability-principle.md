# 設計原則: 判定の可観測性（discoverability 原則）

- **Issue**: [#1686](https://github.com/Kewton/CommandMate/issues/1686)（出典 [#1678](https://github.com/Kewton/CommandMate/issues/1678) の実運用フィードバック検証）
- **ステータス**: Accepted
- **棚卸し基準日**: 2026-08-04（コード実測。関数名・ファイルパスで参照する — 行番号は腐るため書かない）

## 原則

> **サーバー側が下した判定・抑止・自動アクションは、理由コードつきで、運用者が実際に読む層
> （`capture --json` / `wait` の stdout / `task show` / `verify` の GATE・RESULT 行 /
> Web UI の Verification ペイン）に露出する。**

サーバーログ・DB・契約 schema にしか存在しない判定は「存在しない」のと同じに扱われる。
#1678 の実運用フィードバック 11 件中 4 件（A-2 / A-4 / A-5 / B-5）は、機能・情報は既に存在するのに
運用者が到達できなかったケースだった。運用者は表層のアフォーダンスで「存在しない」と判断し、
回避策の自作や誤った一般化に進む。本書はその構造への恒久対策である。

## 層の定義

| 層 | 具体例 | 性質 |
|---|---|---|
| **運用者が読む層**（表層） | `capture --json` / `wait` の stdout / `task show` / `verify` の GATE・RESULT 行 / `--help` / docs の冒頭サンプル / skill の report / **Web UI の worktree ヘッダチップと Verification ペイン**（#1816） | 運用者・監督スクリプト・skill が実際に参照する。ここに無い情報は運用上「存在しない」 |
| **実行時の深い層** | サーバーログ（`logger.*`）/ DB / 契約 schema の 3 層目 / gate logTail の全文 | デバッグ・監査には残るが、運用判断のループには入らない |

## 構造問題の 4 機構（#1678 実例）

| 実例 | 機構 |
|---|---|
| A-2: allow-listed モードに到達できず safe の穴と誤認 | **冒頭サンプルの既定路線化** — docs 冒頭サンプルがコピペされる運用になる。抑止事実がサーバーログにしか出なかった |
| A-5: `--stop-pattern` をコマンド抑止に誤用 | **アフォーダンス勾配** — `--help` に見える引数が手前にあり、正しい道具（契約 `autoYes.denyPatterns`）は YAML の 3 層目 |
| A-4: `wait` exit 10 の stdout ペイロードを見落とし | **exit code 分岐によるペイロード破棄** — 監督定石が「exit code 分岐 → capture で取り直す」で stdout の JSON が捨てられる |
| B-5: GATE 行が report に届かない | **層の吸収** — ラッパ（dispatch runner）が exit code と要約だけを転記し、中間 stdout の情報が報告層で消える |

## 実装規約

新しい判定・抑止・自動アクションを実装するとき、および既存のものをレビューするときは以下に従う。

1. **理由コードを持たせて運用者層へ出す**: 判定の結果だけでなく「なぜそうなったか」を
   機械可読な理由フィールド（例: `autoYes.lastSuppression.reason`、`stopReason`）として
   `capture --json` / `wait` / `task show` のいずれかに露出する。サーバーログのみの判定を作らない。
2. **exit code に載せた情報は、同じ情報を機械可読な stdout（JSON）でも必ず出す**:
   上位層（skill / 監督スクリプト）は CLI の stdout を吸収して report を作る。exit code は分岐にしか
   使えないため、ペイロードを伴わない exit code は情報を運びきれない。
   `wait` exit 10 の `WaitPromptOutput`（`src/cli/types/api-responses.ts`）は準拠例。
   仕様上ペイロードが空になるケース（selection_list 型の `options: []` 等）は、空である理由を
   判別できるフィールド（`type` / `question` に載せた `sessionStatusReason` 等）を必ず載せる。
3. **`--help` のクロスリファレンス規約**: 誤用されやすいフラグの help 文には
   「この用途ならこちら」を 1 行添える（例: `--stop-pattern` → 契約の `autoYes.denyPatterns`）。
   正しい道具が別の層（契約 YAML 等）にある場合ほど必須。
4. **docs の冒頭サンプル＝コピペされる運用**: 各設計書・ガイドの最初のサンプルは推奨運用を示す。
   「最小の例」を冒頭に置くと、それが既定路線になる（A-2 の機構）。
5. **新しい判定は CLI と Web UI の両方に出す**（#1816 で追加）:
   本書は 2026-08-04 時点で運用者層を CLI の出力に限定していたが、それは
   「CLI しか露出していなかった」という当時の実測をそのまま原則にしていたに過ぎない。
   Mission の「誰でも」に対しては、CLI を開かない運用者にとって CLI だけの判定は
   サーバーログと同じ「深い層」である。したがって新しい判定・抑止・自動アクションは、
   CLI の stdout（規約 1・2）に加えて **Web UI にも露出する**。
   現在の Web UI 側の受け皿は worktree ヘッダの状態チップと Verification ペイン
   （`src/components/worktree/VerificationPane.tsx`）であり、**理由**も
   `aria-label` / tooltip とゲート表に出す。
   露出先を増やせない事情がある場合は、その理由を Issue と設計書に書き残す。
6. **CLI の JSON 出力は安定インターフェース**: `capture --json` / `verify --json` /
   `wait` exit 10 の JSON 構造は、上位層が転写する前提の公開インターフェースとして扱う。
   正準の型は `src/cli/types/api-responses.ts`、運用者向け仕様は
   [cli-operations-guide.md](../user-guide/cli-operations-guide.md) に記載する。
   変更は追加的（additive）に行い、既存フィールドの削除・意味変更は互換性破壊として扱う。

## 判定点の棚卸し（2026-08-04 実測）

### 露出済み

| 判定点 | 露出層 | 対応 |
|---|---|---|
| Auto-Yes ポリシー抑止（`suppressedBy`） | `capture --json` の `autoYes.lastSuppression`（reason / mode / promptType / pattern / at） | #1684 / PR #1691 で対応済み |
| Auto-Yes 自動応答の事実と回答内容 | `capture --prompts [--json]` の監査証跡（question / options / answer / `answeredBy`） | #1685 / PR #1692 で対応済み |
| verify の scope 違反 path | 不合格ゲートの logTail に違反 path 一覧（最大 100 件）＋復旧ガイダンス | #1683 / PR #1688 で対応済み |
| `--stop-pattern` の照合対象と限界 | `auto-yes` / `send` の `--help`、`commandmate docs agent-operations`、cli-operations-guide.md | #1682 / PR #1687 で対応済み |
| `wait` のプロンプト検出ペイロード | exit 10 と同時に `WaitPromptOutput` JSON を stdout へ出力（`src/cli/commands/wait.ts`）。selection_list 型は `type: selection_list` ＋ `question` に `sessionStatusReason` を載せ、`options: []` が仕様であることを判別可能 | 準拠済み（実装規約 2 の準拠例） |
| verify の GATE 行の report 転記 | commandmate-skills 側 dispatch report にゲート結果を転記 | commandmate-skills#47 / skills PR #48 で対応済み |
| 実行契約と検証ランの Web UI 露出 | worktree ヘッダの状態チップ（task title / TaskStatus / 直近ランの RESULT、理由は `aria-label` と tooltip）＋ Verification ペイン（契約・ラン一覧・ゲート表・logTail 末尾 40 行） | #1816 で対応済み（規約 5 の準拠例） |
| stop-pattern 発火の事実 | `capture --json` の `autoYes.stopReason`（`stop_pattern_matched`。`src/lib/session/current-output-builder.ts` が露出） | #314 で対応済み（マッチ内容は #1694 で追加） |
| stop-pattern 発火時に**何にマッチしたか** | `capture --json` の `autoYes.stopMatchedText`（マッチ行＋前後 `STOP_MATCH_EXCERPT_CONTEXT_LINES`=1 行の抜粋。`checkStopCondition`（`src/lib/auto-yes-state.ts`）が発火時のみ状態に保存し、`stopReason` 以外の disable 経路では持ち越さない。上限 `STOP_MATCH_EXCERPT_MAX_BYTES`=400 UTF-8 バイトで切り詰め、切り詰めた場合は末尾に `…[truncated]` を付けるので「これが全部」と読み違えない） | #1694 で対応済み |
| プロンプト dedup スキップ | `capture --json` の `promptDedup`（`skippedCount` / `lastSkippedAt`。`src/lib/polling/prompt-dedup-state.ts` が記録し `src/lib/session/current-output-builder.ts` が露出）。`skippedCount > 0` かつ `lastSkippedAt` が直近なら dedup が原因、`0` なら検出漏れ（#1676）側 | #1695 で対応済み（response 側 dedup `isDuplicateResponse` はサーバーログ `duplicate-response-skipped` のみ — 下記注記参照） |

> **注記（#1695）**: response 側 dedup（`isDuplicateResponse`、Issue #1268）はログ追加のみで `capture --json` への露出を見送った。
> prompt 側と違い、この guard は「今のターンで既に保存済みの内容」しか落とさない（hash cache は `stopPolling()` が
> ターンごとに破棄する）ため、スキップは**正常系の定常状態**であり「保存されなかった」の原因説明にならない。
> カウンタを露出すると健全なセッションほど数値が大きくなる。

### 未露出（対応候補）

実装対応は #1686 の範囲外。新規 Issue の起票はオーケストレーターが判断する。

2026-08-04 の棚卸しで挙がっていた 2 件 —— stop-pattern のマッチ内容と、プロンプト dedup の
スキップ —— はいずれも v0.26.0 で露出済みになった（それぞれ #1694 / #1695、上表）。
現時点で未露出の候補は無い。

## 開発プロセスへの組み込み

- 設計レビュー（`/multi-stage-design-review` Stage 1）のレビュー観点に**発見可能性（discoverability）**を追加済み:
  「この機能・この判定結果を、運用者はどの層で・どのコマンドで知るか？ ログにしか出ない判定はないか？」
  （[.claude/commands/multi-stage-design-review.md](../../.claude/commands/multi-stage-design-review.md)）
- 本原則は CLAUDE.md には書かない（CLAUDE.md はモジュール詳細・原則本文を持たない方針）。

## 関連

- [#1678](https://github.com/Kewton/CommandMate/issues/1678)（出典）/ #1682 / #1683 / #1684 / #1685 / commandmate-skills#47
- [task-contract.md](./task-contract.md) — 冒頭レシピは無人実行推奨（allow-listed ＋ denyPatterns）を併記済み（#1684）
- [cli-operations-guide.md](../user-guide/cli-operations-guide.md) — 無人実行の推奨契約テンプレート
- #1676 — 検出層の沈黙（「判定すら行われない」ケース）は本書の範囲外。運用者から見た症状は同型だが、機構が異なる
