# Issue #549 レビューレポート

**レビュー日**: 2026-03-27
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |

Issue #549 は「スマホ版でmarkdownファイル表示時にビューワ（プレビュー）を初期表示にする」という要望である。概要とスクリーンショットにより意図は理解できるが、テンプレートの「背景・課題」「提案する解決策」「代替案」セクションが未記入のまま残されており、具体的な仕様・受け入れ条件が不足している。

---

## Must Fix（必須対応）

### MF-1: 受け入れ条件が未定義

**カテゴリ**: 完全性
**場所**: Issue本文全体

**問題**:
Issueには「あるべき」姿のスクリーンショットが添付されているものの、具体的な受け入れ条件が記載されていない。テンプレートの「背景・課題」「提案する解決策」「代替案」セクションもデフォルトテキストのまま未記入である。

**証拠**:
- 「背景・課題」セクション: 「この機能がなぜ必要か、どのような課題を解決するか。」（テンプレートのまま）
- 「提案する解決策」セクション: 「どのような形で実現するか（案があれば）。」（テンプレートのまま）

**推奨対応**:
以下のような受け入れ条件を追記する:
1. モバイル（viewport < 768px）でmarkdownファイルを選択した際、プレビュー表示が初期表示されること
2. プレビュー表示からエディタへの切替が引き続き可能であること
3. PC版（viewport >= 768px）の動作に影響がないこと
4. localStorageの既存viewMode設定との優先度が明確であること

---

## Should Fix（推奨対応）

### SF-1: 変更対象の画面フローが不明確

**カテゴリ**: 明確性
**場所**: Issue概要セクション

**問題**:
Issueでは「鉛筆マークタップ -> ビューワタップ」の2工程が煩わしいと記載しているが、実際のコードを確認すると以下の3段階のフローが存在する:

1. ファイル選択 -> `FileViewer` モーダル（構文ハイライト付きraw表示）
2. 鉛筆アイコンタップ -> `MarkdownEditor` モーダル（viewMode=split, mobileTab=editor）
3. MobileTabBar の「Preview」タブをタップ -> プレビュー表示

どの段階をどのように省略して直接プレビュー表示に到達するかの具体的な仕様が記載されていない。

**推奨対応**:
以下のいずれかの実装方針を明記する:
- (A) FileViewerを経由せず、モバイルでmarkdownファイル選択時にMarkdownEditorをpreviewモードで直接開く
- (B) FileViewer内でmarkdownファイルをプレビューレンダリング表示する
- (C) 現在のフローを維持しつつ、MarkdownEditorのmobileTab初期値をpreviewに変更する

### SF-2: localStorage永続化との競合仕様が未定義

**カテゴリ**: 技術的妥当性
**場所**: Issue本文（提案する解決策セクション未記入）

**問題**:
現在の `MarkdownEditor` は `localStorage`（キー: `commandmate:md-editor-view-mode`）にviewModeを保存し、次回開時に復元する仕組みがある。`getInitialViewMode()` 関数（MarkdownEditor.tsx:80-93）は `initialViewMode` props が指定されていればそれを優先し、未指定ならlocalStorageの値にフォールバックする。

モバイルでpreview初期表示にする場合、以下の競合が発生する:
- ユーザーがモバイルでeditorモードに切り替えた場合、その設定がlocalStorageに保存される
- 次回開時にlocalStorageから'editor'が復元され、previewが初期表示されなくなる可能性がある
- PC版とモバイル版でlocalStorageキーを共有しているため、片方での変更が他方に影響する

**推奨対応**:
以下のいずれかの方針を明記:
- (A) モバイル時は常にinitialViewMode='preview'をpropsで渡し、localStorageをオーバーライドする
- (B) モバイル専用のlocalStorageキーを用意して独立管理する
- (C) モバイル初回のみpreview、以降はユーザー選択を尊重する

### SF-3: mobileTab初期値に関する仕様不足

**カテゴリ**: 明確性
**場所**: Issue本文

**問題**:
`MarkdownEditor` の内部状態 `mobileTab` は常に `'editor'` で初期化されている（MarkdownEditor.tsx:134）。`viewMode` が `'split'` の場合にモバイルポートレートでは `MobileTabBar` が表示され、`mobileTab` の値に基づいてエディタまたはプレビューが切り替わる。

もし `viewMode` を `'preview'` に設定する方針であれば `MobileTabBar` は非表示になり問題ないが、`viewMode='split'` を維持したまま `mobileTab` のデフォルトを変更する方針の場合は追加の対応が必要になる。

**推奨対応**:
viewModeとmobileTabのどちらを変更するかを明示する。既存の `FilePanelContent` の `MarkdownWithSearch` コンポーネント（FilePanelContent.tsx:474-481）では `initialViewMode="preview"` を渡すパターンが既に存在しており、これを踏襲するのが最も整合性が高い。

---

## Nice to Have（あれば良い）

### NTH-1: MARPファイルのスコープ明確化

**カテゴリ**: 完全性
**場所**: Issue本文

**問題**:
MARPフロントマター付きmarkdownファイルの場合、現在の `FileViewer` ではスライドプレビューが行われる。フローを変更する場合にMARPファイルをどう扱うかの記載がない。

**推奨対応**:
MARPファイルの場合は従来通りFileViewer経由のフローを維持する等、スコープ外であることを明記する。

### NTH-2: スクリーンショットへの補足説明

**カテゴリ**: 完全性
**場所**: Issue概要セクション

**問題**:
スクリーンショットのみで画面名やUIフローの説明テキストがない。

**推奨対応**:
「現状」「あるべき」のスクリーンショットに、どの画面のスクリーンショットか・何が問題かのテキスト説明を追記する。

---

## 参照ファイル

### コード
- `src/components/worktree/MarkdownEditor.tsx`: viewMode初期化ロジック（getInitialViewMode）、mobileTab初期値、showMobileTabs条件
- `src/components/worktree/WorktreeDetailRefactored.tsx`: モバイルファイル選択フロー（handleFileSelect）とFileViewer/MarkdownEditor呼び出し
- `src/components/worktree/FileViewer.tsx`: 現在のモバイルmarkdown表示とpencilボタン経由のエディタ遷移ロジック
- `src/components/worktree/FilePanelContent.tsx`: デスクトップ版でinitialViewMode='preview'を渡している既存パターン（MarkdownWithSearch）
- `src/types/markdown-editor.ts`: ViewMode型定義、LOCAL_STORAGE_KEY定数
- `src/hooks/useIsMobile.ts`: モバイル判定ロジック（768px breakpoint）
