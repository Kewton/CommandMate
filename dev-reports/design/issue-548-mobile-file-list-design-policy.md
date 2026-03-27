# 設計方針書: Issue #548 スマホ版ファイル一覧表示修正

## 1. 概要

### 対象Issue
- **Issue #548**: スマホ版にてファイル一覧がすべて表示されない
- **種別**: バグ修正（CSS/レイアウト）

### 問題の要約
モバイル版のfilesタブでファイルツリーが途中までしか表示されず、スクロールできない。mainコンテナの`overflow-hidden`がFileTreeViewの`overflow-auto`を無効化していることが主因。

### 修正スコープ
CSS修正のみ。ロジック変更なし、API変更なし、DB変更なし。

## 2. アーキテクチャ設計

### 現状のモバイルレイアウト構造

```
┌──────────────────────────────────────────┐
│ MobileHeader (sticky top)                │
├──────────────────────────────────────────┤
│ BranchMismatchAlert (conditional)        │
├──────────────────────────────────────────┤
│ Auto Yes + CLI Tool Tabs (sticky)        │
├──────────────────────────────────────────┤
│ <main className="flex-1 pb-32            │  ← 問題箇所
│        overflow-hidden"                  │  ← overflow-hidden が主因
│   style="paddingBottom:                  │  ← pb-32 はデッドコード
│     calc(8rem + safe-area)">             │
│                                          │
│   MobileContent                          │
│     └─ FileTreeView (overflow-auto)      │  ← 親のoverflowに制約される
│                                          │
│ </main>                                  │
├──────────────────────────────────────────┤
│ MessageInput (fixed, z-30)               │
├──────────────────────────────────────────┤
│ MobileTabBar (fixed bottom, z-40)        │
└──────────────────────────────────────────┘
```

### 修正後のレイアウト構造

```
┌──────────────────────────────────────────┐
│ MobileHeader (sticky top)                │
├──────────────────────────────────────────┤
│ BranchMismatchAlert (conditional)        │
├──────────────────────────────────────────┤
│ Auto Yes + CLI Tool Tabs (sticky)        │
├──────────────────────────────────────────┤
│ <main className="flex-1                  │
│        overflow-y-auto"                  │  ← overflow-y-auto に変更
│   style="paddingBottom:                  │
│     calc(8rem + safe-area)">             │  ← pb-32 削除（デッドコード除去）
│                                          │
│   MobileContent                          │
│     └─ FileTreeView (overflow-auto)      │  ← スクロール可能に
│                                          │
│ </main>                                  │
├──────────────────────────────────────────┤
│ MessageInput (fixed, z-30)               │
├──────────────────────────────────────────┤
│ MobileTabBar (fixed bottom, z-40)        │
└──────────────────────────────────────────┘
```

## 3. 技術選定

| カテゴリ | 選定技術 | 理由 |
|---------|---------|------|
| スタイル | Tailwind CSS | 既存技術スタック。className変更のみ |
| テスト | Vitest + @testing-library/react | 既存テスト基盤 |

CSS修正のみのため、新規ライブラリ導入なし。

## 4. 設計パターン

### 適用パターン: なし（CSS修正のみ）

本修正はレイアウトCSSの変更であり、設計パターンの適用は不要。

### 修正の原則

- **KISS**: overflow-hiddenをoverflow-y-autoに置換、デッドコードpb-32を削除するだけ
- **最小変更**: 影響範囲を最小限に抑え、1ファイル1行の変更で解決

## 5. 変更対象ファイル

### 変更ファイル（1ファイル）

| ファイル | 行 | 変更内容 |
|---------|-----|---------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | L1762 | `className="flex-1 pb-32 overflow-hidden"` → `className="flex-1 overflow-y-auto"` |

### 変更詳細

```diff
- className="flex-1 pb-32 overflow-hidden"
+ className="flex-1 overflow-y-auto"
```

変更点:
1. `overflow-hidden` → `overflow-y-auto`: 縦スクロールを有効化（主因の修正）
2. `pb-32` 削除: デッドコード除去（inline style `paddingBottom` が優先されるため）

### 変更しないファイル

| ファイル | 理由 |
|---------|------|
| `WorktreeDetailSubComponents.tsx` | MobileContent内部のレイアウトは問題なし |
| `FileTreeView.tsx` | `overflow-auto`は正しい設定、親の制約解除で動作する |
| `MobileTabBar.tsx` | fixed positionのため影響なし |
| `SearchBar.tsx` | flex-col内の子要素であり影響なし |

## 6. 影響範囲分析

### 全5モバイルタブへの影響

mainコンテナは全タブ共通の親要素。overflow-y-autoへの変更は全タブに影響する。

| タブ | コンポーネント | 既存overflow | 影響度 | 期待される動作 |
|------|--------------|-------------|--------|-------------|
| terminal | TerminalDisplay | overflow-y-auto overflow-x-hidden | 中 | 内部スクロール継続、mainのスクロールは到達しない |
| history | HistoryPane/GitPane (wrapper div + sub-tab switcher) | overflow-y-auto (各サブコンポーネント内) | 中 | wrapper divにはoverflowなし、各サブコンポーネント内で内部スクロール継続 |
| files | FileTreeView | overflow-auto | 高（修正対象） | スクロール可能になる |
| memo | NotesAndLogsPane | overflow-hidden | 中 | 内部制約維持 |
| info | MobileInfoContent | overflow-y-auto | 低 | 独自のスクロールコンテナを持つため、mainのスクロールには到達しない |

### デスクトップへの影響

**影響なし**。デスクトップはL1512で別のrender pathを使用。

### ネストスクロール挙動

mainコンテナ（overflow-y-auto）と子コンポーネント（overflow-y-auto等）のネストスクロール:
- 子コンポーネントは`flex-1 min-h-0`で高さ制約されるため、長いコンテンツは子内部でスクロール
- mainのpaddingBottom領域までスクロールすると、mainコンテナ自体がスクロール
- これは意図された動作（ファイルツリー末尾をMessageInput上まで表示可能にする）

#### 各タブの高さ制約メカニズムと二重スクロール防止

mainコンテナ（`flex-1 overflow-y-auto`）の子としてタブコンテンツが配置される。各タブが二重スクロール（scroll chaining）を起こさない理由を以下に示す。

| タブ | 高さ制約 | 二重スクロール防止の根拠 |
|------|---------|----------------------|
| terminal | `h-full` | mainが`flex-1`のflex子要素であるため、その高さはビューポートから算出される。子要素に`h-full`を指定すると、mainの高さ（contentサイズではなくbox高さ）に制約される。これによりTerminalDisplayはmainの高さを超えず、TerminalDisplay内部の`overflow-y-auto`のみがスクロール対象となる。mainのコンテンツがmainの高さを超えないため、mainのスクロールバーは発生しない |
| history | 各サブコンポーネント内`overflow-y-auto` | wrapper divにoverflow設定はないが、各サブコンポーネント（HistoryPane/GitPane）が内部で`overflow-y-auto`を持ち、コンテンツを自身の領域内でスクロールする |
| files | `overflow-auto` | 修正対象。mainのスクロールが有効化されることでFileTreeViewの全体が表示可能になる |
| memo | `overflow-hidden` | 内部制約によりコンテンツがはみ出さないため、mainのスクロールは発生しない |
| info | `overflow-y-auto h-full` | `h-full`によりmainの高さに制約され、terminal同様に内部スクロールのみ発生する |

#### 動的オーバーレイコンポーネントへの影響

以下のコンポーネントはmainコンテナの外側に`fixed`または`absolute`ポジションで配置されるため、mainの`overflow-y-auto`変更の影響を受けない。

| コンポーネント | ポジション | 影響 |
|--------------|-----------|------|
| MobilePromptSheet | fixed/absolute (条件付き表示) | 影響なし。mainのスクロール状態に関わらず、オーバーレイとして独立描画される |
| FileViewer モーダル | fixed/absolute | 影響なし。モーダル表示はmainのoverflow設定とは無関係 |
| ToastContainer | fixed | 影響なし。画面端に固定表示されるため、mainのスクロールに依存しない |

## 7. セキュリティ設計

CSS修正のみのため、セキュリティ上の影響なし。

- XSS: 影響なし（DOM構造変更なし）
- CSRF: 影響なし（API変更なし）
- 入力バリデーション: 影響なし

## 8. パフォーマンス設計

CSS修正のみのため、パフォーマンスへの影響は最小。

- `overflow-y-auto`はブラウザのネイティブスクロールを使用するため追加コストなし
- レンダリングパス変更なし
- 再レンダリング頻度変更なし

## 9. テスト戦略

### ユニットテスト（必須）

| テストケース | 検証内容 |
|-------------|---------|
| mainコンテナのoverflow | `overflow-y-auto`クラスが適用されていること |
| pb-32の除去確認 | `pb-32`クラスが存在しないこと |
| デスクトップレイアウト非影響 | デスクトップrender pathに変更がないこと |

### 手動QA（必須）

- 全5タブのスクロール動作確認
- ダークモードでの表示確認
- NavigationButtons表示時のパディング確認
- iOS Safari safe-area確認
- 横向き（landscape）確認

#### タブ別スクロール確認手順

| タブ | 確認手順 | 合格基準 |
|------|---------|---------|
| files | ファイル20件以上のworktreeで表示し、ファイルツリー末尾までスクロール | 最後のファイルが視認でき、MessageInputと重ならないこと |
| terminal | 長い出力（100行以上）のあるセッションで表示 | TerminalDisplay内のみスクロールし、mainコンテナのスクロールバーが出現しないこと（単一スクロール） |
| history | メッセージ10件以上の会話履歴で表示 | サブコンポーネント内でスクロールが完結すること |
| memo | メモ5件以上で表示 | コンテンツがはみ出さないこと |
| info | 情報量の多いworktreeで表示 | info内でスクロールが完結し、mainのスクロールバーが出現しないこと |

#### 自動回帰テスト（推奨）

Playwrightによるモバイルビューポートでのスクロール回帰テストを推奨する。

| テストケース | 検証内容 |
|-------------|---------|
| filesタブのスクロール到達 | モバイルビューポート(375x667)でfilesタブを表示し、最後のファイルノードまでスクロール可能であること |
| terminalタブの単一スクロール | TerminalDisplay内スクロール時にmainのscrollTopが変化しないこと |
| タブ切り替え後のスクロール | filesタブでスクロール後、他タブに切り替えて戻った際にスクロール位置が維持されること |

## 10. 設計上の決定事項とトレードオフ

### 決定事項

| 決定 | 理由 | トレードオフ |
|------|------|-------------|
| overflow-y-auto採用 | プロジェクト内の慣例（TerminalDisplay等） | overflow-autoで横スクロールも許可する選択肢あり |
| pb-32削除 | デッドコード除去（inline styleが優先） | なし（機能的変化なし） |
| paddingBottom維持 | MessageInput/MobileTabBarとの重なり防止 | landscape時に約36%を占める可能性あり |

### 代替案

| 代替案 | メリット | デメリット | 採用判断 |
|--------|---------|-----------|---------|
| overflow-auto | 横スクロールも許可 | 意図しない横スクロール発生リスク | 不採用 |
| overflow-hidden削除のみ | 最小変更 | デフォルトoverflowはvisibleで意図と異なる | 不採用 |
| FileTreeViewにmax-height設定 | ピンポイント修正 | 他タブの問題が残る、動的高さ計算が必要 | 不採用 |

## 11. 制約条件

- CLAUDE.mdの原則に準拠（KISS, YAGNI）
- CSS修正のみ、ロジック変更なし
- 全5モバイルタブでリグレッションなし
- デスクトップレイアウトに影響なし

## 12. レビュー指摘対応履歴

### Stage 2: 整合性レビュー (2026-03-27)

**全体評価**: PASS_WITH_MINOR_ISSUES

| ID | カテゴリ | 指摘内容 | 対応 |
|----|---------|---------|------|
| SF-001 | 整合性 | infoタブのMobileInfoContentは実際には`overflow-y-auto h-full`を持つ。設計書の「なし」は不正確 | 影響分析テーブルを修正: 既存overflowを`overflow-y-auto`に、期待動作を「独自スクロールコンテナを持つ」に更新 |
| SF-002 | 整合性 | terminalタブのTerminalDisplayは`overflow-y-auto`に加えて`overflow-x-hidden`も持つ | 影響分析テーブルを修正: 既存overflowを`overflow-y-auto overflow-x-hidden`に更新 |
| SF-003 | 整合性 | historyタブはHistoryPaneを直接レンダリングするのではなく、wrapper divとsub-tab switcher (Message/Git)を介してHistoryPane/GitPaneを条件レンダリングする | 影響分析テーブルを修正: コンポーネント記述をwrapper構造含む形に更新、overflow-y-autoが各サブコンポーネント内にある旨を明記 |

### Stage 3: 影響分析レビュー (2026-03-27)

**全体評価**: PASS_WITH_MINOR_ISSUES

| ID | カテゴリ | 指摘内容 | 対応 |
|----|---------|---------|------|
| IA-001 | 影響範囲 | terminalタブのh-fullがflex-1 overflow-y-autoのmain下で二重スクロールを防ぐ根拠が不明確 | ネストスクロール挙動セクションに「各タブの高さ制約メカニズムと二重スクロール防止」テーブルを追加。h-fullがmainのbox高さに制約される仕組みを明記 |
| IA-002 | 影響範囲 | MobilePromptSheet、FileViewerモーダル、ToastContainerとの相互作用が分析対象外 | ネストスクロール挙動セクションに「動的オーバーレイコンポーネントへの影響」テーブルを追加。fixed/absoluteポジションにより影響なしであることを明記 |
| IA-003 | テスト戦略 | ネストスクロールの回帰検出が手動QAに依存しすぎている | 手動QAセクションにタブ別の具体的確認手順と合格基準を追加。Playwrightによる自動回帰テスト（推奨）セクションを追加 |

---

*Generated by design-policy command for Issue #548*
