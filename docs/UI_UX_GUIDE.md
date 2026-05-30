[English](./en/UI_UX_GUIDE.md)

# CommandMate UI/UX ガイド

本ドキュメントは、CommandMate の現在の UI/UX 実装について説明します。

## 目次

1. [概要](#概要)
2. [レスポンシブデザイン](#レスポンシブデザイン)
3. [デスクトップ UI](#デスクトップ-ui)
4. [モバイル UI](#モバイル-ui)
5. [共通機能](#共通機能)
6. [コンポーネント構成](#コンポーネント構成)

---

## 概要

CommandMate は、デスクトップとモバイルの両方に最適化されたレスポンシブ UI を提供します。

| 画面 | レイアウト | 特徴 |
|------|-----------|------|
| **デスクトップ** | 3カラム構成 (ActivityBar / ActivityPane / Right(TerminalContainer 内 History)) | VS Code 風 全高 Activity Bar、即時 Tooltip、History は Terminal 領域に内包、リサイズ可能なペイン |
| **モバイル** | タブベース | ボトムナビゲーション |

---

## レスポンシブデザイン

### 自動検出

`useIsMobile` フックにより、画面サイズに応じて自動的にレイアウトが切り替わります。

- **デスクトップ**: 768px 以上
- **モバイル**: 768px 未満

```
┌─────────────────────────────────────────┐
│  768px 以上 → デスクトップレイアウト     │
│  768px 未満 → モバイルレイアウト         │
└─────────────────────────────────────────┘
```

---

## デスクトップ UI

### レイアウト構成 (Issue #727 / #730)

VS Code 流の全高 Activity Bar を採用。History は Terminal 領域に内包され、画面下端まで貫通します。

```
┌───┬─────────────────────────────────────────────────┐
│   │  [←Back]  worktree-name                  [Info] │ ← Header
│ A │ ├─────────────────────────────────────────────┤  │
│ c │ │ BranchMismatchAlert (条件付き)                │
│ t │ ├──────────┬─────────────────┬──────────────────┤
│ B │ │          │                 │                  │
│ a │ │ Activity │ History         │ Terminal         │
│ r │ │ Pane     │ (TerminalContainer 内, 左サブパネル) │ + FilePanel │
│ ┃ │ │  - Files │ │  - Git        │                 │                  │
│ ┃ │ │  - Notes │ │  - Schedules  │                 │                  │
│ ┃ │ │  - Agent │ │  - Timer      │                 │                  │
│ ┃ │ ├──────────┴─────────────────┴──────────────────┤
│ ┃ │ │  NavigationButtons (条件付き, OpenCode TUI)    │
│ ┃ │ ├─────────────────────────────────────────────┤  │
│ ┃ │ │  [メッセージ入力]                      [送信] │
└───┴─────────────────────────────────────────────────┘
   ↑          ↑               ↑              ↑
ActivityBar 全高  ActivityPane  History (折りたたみ可)  FilePanel
(48px, Header下〜下端まで貫通)
```

### 機能詳細

#### 1. ヘッダー
- **Back ボタン**: トップページ（Worktree 一覧）へ戻る
- **Worktree 名**: 現在のブランチ/worktree 名を表示
- **Info ボタン**: Worktree 情報モーダルを開く

#### 2. ActivityBar (48px, 全高貫通)
- VS Code 流の縦型 Activity Bar
- 6 Activity: Files / Git / Notes / Schedules / Agent / Timer
- Header の下から画面下端まで貫通 (Issue #730)
- 各アイコンに即時 Tooltip (100ms, ダークテーマ, 右配置) (Issue #730)
- キーボード操作: ArrowUp/Down/Home/End/Enter/Space

#### 3. ActivityPane (選択 Activity の描画)
- 選択中の Activity の中身を表示
- ResizableColumn でドラッグ可変幅

#### 4. TerminalContainer (Right Pane, Issue #730)
- History (左サブパネル) + Terminal + FilePanel (右) を内包
- History は折りたたみ可 (`<` / `>` ボタン)
- History 幅はドラッグ可変 (10-60%、TerminalContainer 内基準で DEFAULT 40%)
- History / Terminal はそれぞれ ErrorBoundary 包含
- 内部 id `worktree-history-pane` は HistoryPane 外側 wrapper div に付与

#### 5. リサイズ機能
- ActivityPane と TerminalContainer の境界をドラッグして幅を調整
- TerminalContainer 内では History と Terminal の境界をドラッグ
- ドラッグ中は視覚的フィードバック

#### 5. Info モーダル
- Worktree の詳細情報を表示
  - パス
  - ブランチ名
  - CLI ツール
  - 作成日時
- **メモ編集機能**: ブランチごとにメモを保存可能

#### 6. プロンプトパネル
- CLI ツールからの確認プロンプトをオーバーレイ表示
- Yes/No 選択または複数選択に対応
- アニメーション付きの表示/非表示

---

## モバイル UI

### レイアウト構成

```
┌─────────────────────────────┐
│ [←] worktree-name    [状態] │  ← ヘッダー
├─────────────────────────────┤
│                             │
│                             │
│     コンテンツエリア          │
│     (選択したタブに応じて)    │
│                             │
│                             │
├─────────────────────────────┤
│ Terminal│History│Logs│Info  │  ← タブバー
└─────────────────────────────┘
```

### タブ構成

| タブ | アイコン | 内容 |
|------|---------|------|
| **Terminal** | 💻 | リアルタイムターミナル出力 + 入力欄 |
| **History** | 🕐 | メッセージ履歴 |
| **Logs** | 📄 | Markdown ログファイル一覧 |
| **Info** | ℹ️ | Worktree 情報 + メモ編集 |

### 機能詳細

#### 1. ヘッダー
- **Back ボタン**: トップページへ戻る
- **Worktree 名**: 現在のブランチ名（省略表示）
- **状態インジケーター**:
  - 🟢 Running（実行中）
  - 🟡 Waiting（プロンプト待ち）
  - ⚪ Idle（待機中）
  - 🔴 Error（エラー）

#### 2. タブバー
- 画面下部に固定表示
- Safe Area 対応（iPhone のノッチ/ホームバー）
- 通知バッジ:
  - 🟢 新しい出力あり
  - 🟡 プロンプト待ち

#### 3. プロンプトシート
- CLI プロンプト検出時にボトムシートで表示
- スワイプダウンで閉じる
- オーバーレイタップで閉じる
- Yes/No または複数選択に対応

#### 4. 仮想キーボード対応
- キーボード表示時にレイアウト自動調整
- 入力欄が常に見える位置を維持

---

## 共通機能

### 1. リアルタイムポーリング

```
アクティブ時:  2秒間隔でポーリング
アイドル時:    5秒間隔でポーリング
```

- CLI ツールの出力を定期的に取得
- プロンプト検出（Yes/No、複数選択）
- 思考中（Thinking）状態の検出

### 2. プロンプト検出・応答

CLI ツールが確認を求めた場合:

```
┌─────────────────────────────────┐
│  Claudeからの確認                │
│                                 │
│  Do you want to proceed?        │
│                                 │
│  [Yes]  [No]                    │
└─────────────────────────────────┘
```

- 自動的に UI に表示
- 選択した回答を CLI に送信

### 3. メモ機能

各 Worktree にメモを保存可能:
- デスクトップ: Info モーダル内
- モバイル: Info タブ内

### 4. エラーバウンダリー

各コンポーネントは ErrorBoundary でラップ:
- 一部のエラーが全体に影響しない
- エラー発生時はフォールバック UI を表示

---

## コンポーネント構成

### ディレクトリ構造

```
src/components/
├── mobile/
│   ├── MobileHeader.tsx      # モバイル用ヘッダー
│   ├── MobileTabBar.tsx      # ボトムタブバー
│   └── MobilePromptSheet.tsx # プロンプト用ボトムシート
├── common/
│   └── Tooltip.tsx              # 100ms 遅延カスタム Tooltip (Issue #730)
├── worktree/
│   ├── WorktreeDetailRefactored.tsx  # メインコンポーネント (ActivityBar 全高貫通: Issue #730)
│   ├── WorktreeDesktopLayout.tsx     # デスクトップ 2 カラム (ActivityPane + Right) — Issue #730 で簡素化
│   ├── ActivityBar.tsx               # VS Code 風 Activity Bar (Issue #727)、Tooltip ラップ (Issue #730)
│   ├── ActivityPane.tsx              # 選択 Activity の描画コンテナ (Issue #727)
│   ├── TerminalContainer.tsx         # History + Terminal 内包コンテナ (Issue #730)
│   ├── TerminalDisplay.tsx           # ターミナル表示
│   ├── HistoryPane.tsx               # 履歴ペイン（TerminalContainer 内に移譲、折りたたみ対応）
│   ├── PromptPanel.tsx               # デスクトップ用プロンプト
│   ├── PaneResizer.tsx               # ペインリサイザー
│   └── MessageInput.tsx              # メッセージ入力
├── error/
│   └── ErrorBoundary.tsx     # エラーバウンダリー
└── ui/
    └── Modal.tsx             # モーダルコンポーネント
```

### カスタムフック

```
src/hooks/
├── useIsMobile.ts          # モバイル判定
├── useWorktreeUIState.ts   # UI状態管理（useReducer）
├── usePromptAnimation.ts   # プロンプトアニメーション
├── useSwipeGesture.ts      # スワイプジェスチャー
├── useTerminalScroll.ts    # ターミナル自動スクロール
└── useVirtualKeyboard.ts   # 仮想キーボード対応
```

---

## 画面遷移フロー

```
┌─────────────────┐
│  トップページ    │
│  (Worktree一覧)  │
└────────┬────────┘
         │ タップ
         ▼
┌─────────────────┐
│  Worktree詳細    │◄──────────────┐
│  (チャット画面)   │               │
└────────┬────────┘               │
         │                        │
    ┌────┴────┐                   │
    ▼         ▼                   │
┌───────┐ ┌───────┐               │
│ Logs  │ │ Info  │               │
│ 画面  │ │ Modal │               │
└───────┘ └───────┘               │
                                  │
         [Back]───────────────────┘
```

---

## 技術的な特徴

### パフォーマンス最適化
- `memo` によるコンポーネントメモ化
- `useMemo` / `useCallback` による再計算防止
- 条件付きレンダリングで不要な DOM 生成を回避

### アクセシビリティ
- ARIA 属性の適切な設定
- キーボードナビゲーション対応
- スクリーンリーダー対応のラベル

### エラーハンドリング
- 各ペイン/コンポーネントに ErrorBoundary
- フォールバック UI の提供
- エラーログの出力

---

## 関連ドキュメント

- [README.md](../README.md) - プロジェクト概要
- [Webアプリ操作ガイド](./user-guide/webapp-guide.md) - 初めてのユーザー向け操作手順書
- [DEPLOYMENT.md](./DEPLOYMENT.md) - デプロイメントガイド
- [architecture.md](./architecture.md) - アーキテクチャ詳細
