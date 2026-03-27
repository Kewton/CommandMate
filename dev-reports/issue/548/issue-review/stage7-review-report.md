# Issue #548 レビューレポート

**レビュー日**: 2026-03-27
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目（Stage 7）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |

## 前回指摘事項の検証

### Stage 3 影響範囲レビュー（1回目）の指摘 -- 全件解決済み

| ID | 指摘内容 | 状態 |
|----|---------|------|
| MF-1 | overflow-hidden削除は全5タブに影響 | RESOLVED: タブ別影響テーブル追加、overflow-y-auto置換に修正 |
| SF-1 | NavigationButtons表示時のパディング不足リスク | RESOLVED: クリアランス要件を文書化 |
| SF-2 | モバイルCSSテスト未整備 | RESOLVED: テスト方針セクション追加 |
| SF-3 | ダークモードQA推奨 | RESOLVED: 受入条件・テスト計画に追加 |
| NTH-1 | SearchBar影響の明記 | RESOLVED: 影響なしを明記 |
| NTH-2 | iOS Safari safe-area検証 | RESOLVED: テスト計画に追加 |

### Stage 5 通常レビュー（2回目）の修正 -- 全件反映済み

| ID | 指摘内容 | 状態 |
|----|---------|------|
| MF-1 | pb-32はデッドコード（加算ではない） | RESOLVED: 概要・原因分析を正確に修正 |
| SF-1 | HistoryPaneのoverflow設定誤記 | RESOLVED: 正しい値に修正 |
| NTH-1 | overflow-auto vs overflow-y-auto判断基準 | RESOLVED: overflow-y-auto推奨に変更 |
| NTH-2 | Stage 1レビュー履歴欠落 | RESOLVED: 全ステージの履歴を記載 |

## 修正アプローチの技術検証

### overflow-hidden から overflow-y-auto への変更

**結論: 安全に適用可能**

検証した技術的根拠:

1. **CSS Flexbox仕様との整合性**: CSS仕様上、`overflow`が`visible`以外のflex itemは自動最小サイズが`0`となる。`overflow-hidden`を`overflow-y-auto`に変更しても、`flex-1`の動作（残りスペースへの拡張）は変わらない。`min-h-0`を追加する必要はない。

2. **子コンポーネントとの互換性**: 各タブの子コンポーネント（TerminalDisplay, HistoryPane, FileTreeView, MemoPane）は自身で`overflow-y-auto`を持っており、`h-full`または`flex-1 min-h-0`で親のサイズに従う設計。親のoverflow変更による破壊的影響はない。

3. **paddingBottomとの相互作用**: `calc(8rem + env(safe-area-inset-bottom))`のpaddingBottomにより、mainコンテナの内容領域（子コンポーネント + パディング）がflex-1割当高さを超え、mainコンテナ自体がスクロール可能となる。これは固定位置のMessageInput/MobileTabBarの背後のコンテンツを表示するための正しい動作。

4. **デスクトップへの影響**: なし。デスクトップはL1512の完全に別のrenderパスを使用。

---

## Should Fix（推奨対応）

### SF-1: ネストされたスクロールコンテナの動作に関する実装者向け注記

**カテゴリ**: 影響ファイル
**場所**: src/components/worktree/WorktreeDetailRefactored.tsx L1761-1766

**問題**:
Issueでは、mainコンテナと子コンポーネントの両方にoverflow-y-autoが適用される「入れ子スクロール」の動作について言及がない。overflow-y-autoをmainに適用すると、paddingBottomによりmainコンテナ自体がスクロール可能になる。子コンポーネント（例: TerminalDisplay）は`h-full`で親を埋めるため、内部スクロールは引き続き機能する。しかし、実装者がこの挙動を理解していないと、テスト時に混乱する可能性がある。

**証拠**:
- mainコンテナ: `flex-1 overflow-y-auto` + `paddingBottom: calc(8rem + safe-area)`
- TerminalDisplay: `h-full overflow-y-auto`
- FileTreeView: `flex-1 min-h-0 overflow-auto`
- paddingBottomによりmainのコンテンツ高がflex割当を超え、外側スクロールが発生する

**推奨対応**:
修正方針セクションに「mainコンテナのスクロールはpaddingBottom分のみ発生し、各タブの内部スクロールは子コンポーネントのoverflow設定で処理される」旨の簡潔な実装ノートを追加する。

---

## Nice to Have（あれば良い）

### NTH-1: 横画面・タブレット・分割表示のテスト追加

**カテゴリ**: テスト範囲
**場所**: テスト方針セクション

**問題**:
現在のテスト計画には、横画面（landscape）、タブレット、Androidの画面分割モードが含まれていない。横画面ではビューポート高が大幅に減少し、paddingBottom（~130px以上）がビューポートの約36%を占める可能性がある。

**推奨対応**:
手動QAチェックリストに以下を追加:
- 横画面でのファイル一覧スクロール確認
- タブレットでの下部余白の適切さ確認
- Android分割表示モードでの動作確認

---

### NTH-2: infoタブ影響度の根拠を改善

**カテゴリ**: 依存関係
**場所**: 原因分析 > タブ別の影響詳細テーブル, info行

**問題**:
infoタブの影響度が「低: コンテンツ量が少ない」と記載されているが、これはコンテンツ量に依存した脆い根拠。MobileInfoContentは独自のoverflow設定を持たず、mainコンテナのoverflowに依存する。

**推奨対応**:
「低: mainコンテナのスクロールに依存、現時点ではコンテンツがビューポート内に収まる」のように、仕組みを説明する根拠に変更する。

---

## 参照ファイル

### コード
| ファイル | 行 | 関連性 |
|---------|-----|--------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | L1661-1766, L1805-1838 | mainコンテナ（修正対象）と固定位置要素 |
| `src/components/worktree/WorktreeDetailSubComponents.tsx` | L756-921 | MobileContent - 5タブの描画 |
| `src/components/worktree/FileTreeView.tsx` | L443-449 | overflow-auto設定 |
| `src/components/worktree/NotesAndLogsPane.tsx` | L117 | 内部overflow-hidden |
| `src/components/worktree/HistoryPane.tsx` | L119-120 | overflow-y-auto + overflow-x-hidden |
| `src/components/worktree/TerminalDisplay.tsx` | L161-162 | overflow-y-auto + overflow-x-hidden |

## 総合評価

Issueは6段階のレビューを経て十分に成熟している。根本原因（overflow-hiddenによるスクロール抑制）と副次的な整理対象（pb-32デッドコード削除）の区別が正確に記述されており、修正アプローチ（overflow-y-autoへの置換）は技術的に妥当である。全5タブへの影響、デスクトップ非影響、ダークモード、safe-area、固定要素との関係が網羅的に分析されている。残存する指摘はブロッカーではなく、実装時の意識事項と追加QA項目に留まる。
