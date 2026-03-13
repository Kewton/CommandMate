# Issue #480 レビューレポート

**レビュー日**: 2026-03-13
**フォーカス**: 通常レビュー
**イテレーション**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 3 |

**総合評価**: Good -- Issue の方針・構成は明確で実装可能。件数の不一致とスコープ定義の曖昧さを解消すれば、十分な品質となる。

---

## Should Fix（推奨対応）

### S1-001: サーバーサイド console.log 合計件数の不一致（209件 vs 159件）

**カテゴリ**: 正確性
**場所**: Issue概要セクション

**問題**:
Issue では「サーバーサイドの console.log 209件」と記載されているが、実測では src/cli/ を除外した .ts/.tsx ファイルの console.log は 159件である。親 Issue #475 でも同じ 209件という数字が使われている。

**証拠**:
- `grep -r "console\.log" src/ --include="*.ts" --include="*.tsx" | grep -v "src/cli/" | wc -l` の結果: 159件
- src/ 全体: 223件、src/cli/ 内: 64件

**推奨対応**:
合計件数を「約160件（CLI出力除く）」に更新するか、カウント基準を明記する。親 Issue #475 の数字も併せて更新する。

---

### S1-002: 上位10ファイル以外の43件（25ファイル）に対する方針が未記載

**カテゴリ**: 完全性
**場所**: console.log 多い順テーブル

**問題**:
上位10ファイルの方針は表にまとめられているが、残り25ファイルに散在する43件の console.log に対する方針が未記載。対象には API route ハンドラ、hooks、コンポーネントが含まれる。

**証拠**:
上位10ファイル以外の console.log 分布（抜粋）:
- `src/lib/cli-tools/opencode.ts`: 4件
- `src/lib/cli-tools/manager.ts`: 4件
- `src/app/api/worktrees/[id]/send/route.ts`: 3件
- `src/hooks/useSwipeGesture.ts`: 2件
- その他21ファイルに各1-3件

**推奨対応**:
上位10以外のファイルについて一括方針を記載する（例: 「その他のファイル（約43件/25ファイル）: 個別に logger 経由 or 削除を判断」）。

---

### S1-003: クライアントサイドの console.log のスコープ定義が曖昧

**カテゴリ**: 完全性
**場所**: Issue概要セクション（「サーバーサイドの console.log」）

**問題**:
「サーバーサイド」の定義が不明確。src/hooks/ や src/components/ のクライアントサイドコードにも console.log が存在する。スコープが「src/cli/ 以外の全 src/」なのか「Server Components / API routes のみ」なのかが判断できない。

**証拠**:
- `src/hooks/useSwipeGesture.ts`: 2件（クライアントサイド）
- `src/hooks/useFullscreen.ts`: 2件（クライアントサイド）
- `src/components/worktree/TerminalDisplay.tsx`: 1件（クライアントサイド）

**推奨対応**:
対象スコープを明確化する。例: 「対象: src/ 配下の全ファイル（src/cli/ を除く）」または「対象: src/lib/, src/app/api/ のみ」。

---

### S1-006: 「削除」方針のログに対する判断基準が不明確

**カテゴリ**: 実装可能性
**場所**: console.log 多い順テーブルの「方針」列

**問題**:
response-poller.ts と assistant-response-saver.ts の5件ずつは「デバッグログ → 削除」方針だが、「デバッグログ」と「運用ログ」の分類基準が示されていない。障害調査時に有用なログまで削除するリスクがある。

**推奨対応**:
判断基準を明記する。より安全な代替案として「削除」ではなく「logger.debug() に移行」を推奨する。logger は LOG_LEVEL 制御があるため、本番では出力を抑制しつつ必要時に有効化できる。

---

## Nice to Have（あれば良い）

### S1-004: logger モジュールの API 仕様への参照が不足

**カテゴリ**: 完全性
**場所**: Issue全体

**問題**:
logger モジュールの具体的な使い方（`createLogger()` の呼び出し方、ログレベルの選択基準）への言及がない。

**推奨対応**:
使用例や既に logger を導入済みのファイルへの参照を追加する。

---

### S1-005: cli-tools/gemini.ts が CLAUDE.md に未記載

**カテゴリ**: 整合性
**場所**: CLAUDE.md 主要モジュール一覧

**問題**:
Issue の上位10表に含まれる `cli-tools/gemini.ts` が CLAUDE.md の主要モジュール一覧に記載されていない。本 Issue 自体の問題ではないが、関連する整合性課題として記録。

**推奨対応**:
本 Issue の作業と併せて CLAUDE.md を更新するか、別途 Issue を起票する。

---

### S1-007: logger 導入済みファイルでの console.log 残存について未記載

**カテゴリ**: 完全性
**場所**: Issue全体

**問題**:
`claude-session.ts` は既に `createLogger` を使用しているが、console.log が12件残存している。logger 導入済みファイルでの混在状態の解消について Issue に言及がない。

**推奨対応**:
「既に logger 導入済みだが console.log が残存しているファイルは優先的に統一する」旨を追記する。

---

## 参照ファイル

### コード
- `src/lib/logger.ts`: 統一先の logger モジュール実装（createLogger, generateRequestId）
- `src/lib/db-migrations.ts`: 最多 console.log（53件）の対象ファイル
- `src/lib/claude-session.ts`: createLogger 導入済みだが console.log 12件が残存

### ドキュメント
- `CLAUDE.md`: 主要モジュール一覧との整合性確認（gemini.ts 未記載）
