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
| **デスクトップ** | 1 行のヘッダー + 2 段目の操作バー + 本文（TerminalContainer。ActivityPane は右から重ねて開く） | 道具はヘッダーの右、Verification は 2 段目の札、即時 Tooltip、History は Terminal 領域に内包、ピン留めで横に並ぶペイン |
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

> Issue #3589〜#3594 で現在の形になりました。縦の全高 Activity Bar（48px）は PC にはもうありません（スマホは下部のタブバーのままです）。

見出しは 1 行で、worktree の道具はその右に並びます。2 段目は分割の操作バーです。パネル（ActivityPane）は既定で閉じており、開くと右から本文の上に重ねて出ます（ピンで固定すると本文の横に並び、本文が狭くなります）。

```
┌────────────────────────────────────────────────────────────────────┐
│ ● worktree-name  repo  [今のセッション][ほか N ▾][＋] [Info] [道具…] │ ← ヘッダー（1 行）
├────────────────────────────────────────────────────────────────────┤
│ [▢][▥][▥▥][▦]  [Verification 札]  （分割 1 つ: 分割の見出し） [⤢] [履歴][開いているファイル] │ ← 2 段目（操作バー）
├────────────────────────────────────────────────────────────────────┤
│ BranchMismatchAlert (条件付き)                                       │
├──────────────┬───────────────────────────────┬──────────────────────┤
│ History      │ Terminal / Chat               │ FilePanel  ┌────────┐│
│ (split 内,   │                               │            │Activity││
│  折りたたみ可) │                               │            │Pane    ││
│              ├───────────────────────────────┤            │(重ねて ││
│              │ [メッセージ入力]        [送信] │            │ 開く)  ││
└──────────────┴───────────────────────────────┴────────────┴────────┘
```

### 機能詳細

#### 1. ヘッダー
- **状態のドット・Worktree 名**: 名前の横にリポジトリ名（押すと Repositories 画面）。未コミットの変更があれば `*`
- **セッションの欄**: ［今のセッション］［ほか N ▾］［＋］。進み具合（worktree の Status）はここではなく、サイドバーの行の「…」→ Status で変える
- **Info ボタン**: Worktree 情報モーダルを開く
- **道具**（右端）: 下記の Activity のうち `verification` 以外のアイコン。ヘッダーが狭いと末尾から「…」の一覧へ畳まれる

#### 2. 道具（HeaderToolBar）と Verification の札
- 以前の縦型 Activity Bar の中身を、ヘッダー右のアイコン（`HeaderToolBar`）と 2 段目の Verification の札（`VerificationStatusChip`）に分けた (Issue #3591)
- 10 Activity。**唯一の出所は `src/config/activity-bar-config.ts` の `ACTIVITIES`** で、下記はその写しです。並び順はヘッダーの道具の表示順であり、←/→ の移動順でもあります（新しい Activity は末尾に追加すること。挿入すると既存のキーボード順序が黙って繰り上がります）。`tests/unit/docs/ui-ux-guide-activities-2062.test.ts` がこの一覧と `ACTIVITIES` の一致を固定しているので、Activity を増やしたらここも直してください。
  1. `files` — ファイルツリー（Issue #2259: 操作バーの「開いているファイル」と区別するため改称。id は `files` のまま）
  2. `git` — Git
  3. `notes` — メモ
  4. `schedules` — スケジュール
  5. `agent` — エージェント
  6. `timer` — タイマー
  7. `todo` — ToDo (Issue #1015)
  8. `skills` — スキル (Issue #1441)
  9. `verification` — 検証 (Issue #1816)。ヘッダーの道具には出ず、2 段目の札を押して開閉する
  10. `env` — 環境変数 (Issue #1968)
- 各アイコンに即時 Tooltip (100ms, 下配置)
- キーボード操作: ←/→/Home/End で移動、Enter/Space で開閉。「…」では Enter/Space/↓ で一覧を開き、一覧の中は ↑/↓、Esc で「…」へ戻る
- 開いている道具をもう一度押すとペインが閉じる

#### 3. ActivityPane (選択 Activity の描画)
- 選択中の Activity の中身を表示。既定では閉じている（初めて開く worktree も閉じた状態で始まる、Issue #3589）
- 右から本文の上に重ねて開き、本文の幅は変わらない。Esc・×・同じ道具の再クリック・外側のクリック・ファイルを開く操作で閉じる
- ピンで固定すると本文の横に並び（以前の形）、境界をドラッグして幅を変えられる。ピンの有無は worktree をまたいで共通

#### 4. TerminalContainer (Right Pane, Issue #730)
- History (左サブパネル) + Terminal + FilePanel (右) を内包
- History は折りたたみ可 (`<` / `>` ボタン)
- History 幅はドラッグ可変 (10-60%、TerminalContainer 内基準で DEFAULT 40%)
- History / Terminal はそれぞれ ErrorBoundary 包含
- 内部 id `worktree-history-pane` は HistoryPane 外側 wrapper div に付与

#### 5. リサイズ機能
- ピンで固定した ActivityPane と TerminalContainer の境界をドラッグして幅を調整
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
│   ├── WorktreeDetailRefactored.tsx  # メインコンポーネント（PC は WorktreeDetailDesktop へ委譲）
│   ├── WorktreeDesktopLayout.tsx     # 本文 + ActivityPane（重ねる / ピン留めで横に並ぶ、Issue #3589 / #3591）
│   ├── HeaderToolBar.tsx             # ヘッダー右の道具 (Issue #3591。旧 ActivityBar.tsx は未マウント)
│   ├── VerificationStatusChip.tsx    # 2 段目の Verification の札 (Issue #1816 / #2064 / #3590)
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
