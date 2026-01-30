# 作業計画書 - Issue #99 マークダウンエディタ表示機能改善

## Issue概要

**Issue番号**: #99
**タイトル**: マークダウンエディタの表示機能改善
**サイズ**: L（大規模）
**優先度**: Medium
**依存Issue**: #49（マークダウンエディタとビューワー）- 完了済み
**ラベル**: feature, enhancement

## 背景

現在のマークダウンエディタは固定レイアウトのため、以下の課題がある：
- 長文編集時に表示領域が狭く感じる
- Split View時のエディタ/プレビュー比率が固定
- モバイルデバイスでの操作性が考慮されていない

---

## 詳細タスク分解

### Phase 0: 事前確認

#### Task 0.1: 既存コード調査
- **内容**:
  - MarkdownEditor.tsxの現在の実装確認
  - PaneResizer.tsxのインターフェース確認
  - 既存フック（useIsMobile, useSwipeGesture, useVirtualKeyboard）のAPI確認
- **依存**: なし

---

### Phase 1: 基盤整備（型定義・設定・フック）

#### Task 1.1: 型定義拡張
- **成果物**: `src/types/markdown-editor.ts`
- **依存**: なし
- **内容**:
  - EditorLayoutState型追加
  - LOCAL_STORAGE_KEY_SPLIT_RATIO定数追加
  - LOCAL_STORAGE_KEY_MAXIMIZED定数追加
  - DEFAULT_LAYOUT_STATE定数追加

#### Task 1.2: z-index設定ファイル作成
- **成果物**: `src/config/z-index.ts`
- **依存**: なし
- **内容**:
  - Z_INDEX定数オブジェクト（DROPDOWN, MODAL, TOAST, CONTEXT_MENU, MAXIMIZED_EDITOR）
  - 既存コンポーネントとの競合回避

#### Task 1.3: useFullscreenフック作成
- **成果物**: `src/hooks/useFullscreen.ts`
- **依存**: なし
- **内容**:
  - Fullscreen API呼び出し
  - フォールバックモード（CSS fixed position）
  - エラーハンドリング（権限拒否等）
  - ユーザーアクション要件対応

#### Task 1.4: useLocalStorageStateフック作成
- **成果物**: `src/hooks/useLocalStorageState.ts`
- **依存**: なし
- **内容**:
  - localStorage永続化対応のstate hook
  - バリデーション関数対応（isValidSplitRatio, isValidBoolean）
  - 型安全なジェネリック実装

---

### Phase 2: コンポーネント拡張

#### Task 2.1: PaneResizer拡張
- **成果物**: `src/components/worktree/PaneResizer.tsx`
- **依存**: Task 1.1
- **内容**:
  - onDoubleClickプロパティ追加（オプショナル）
  - minRatioプロパティ追加（オプショナル、デフォルト0.1）
  - 後方互換性維持（既存使用箇所に影響なし）

#### Task 2.2: MarkdownEditor最大化機能追加
- **成果物**: `src/components/worktree/MarkdownEditor.tsx`
- **依存**: Task 1.1, Task 1.2, Task 1.3, Task 1.4
- **内容**:
  - isMaximized状態追加
  - 最大化ボタン追加
  - キーボードショートカット（Ctrl/Cmd+Shift+F）
  - ESCキーで解除
  - "Press ESC to exit"ヒント表示
  - スワイプダウンで解除（モバイル）

#### Task 2.3: MarkdownEditorリサイズ機能追加
- **成果物**: `src/components/worktree/MarkdownEditor.tsx`
- **依存**: Task 2.1
- **内容**:
  - splitRatio状態追加
  - PaneResizerコンポーネント統合
  - ダブルクリックで50:50リセット
  - localStorage永続化
  - requestAnimationFrameでスロットリング

#### Task 2.4: MarkdownEditorモバイル対応
- **成果物**: `src/components/worktree/MarkdownEditor.tsx`
- **依存**: Task 2.2, Task 2.3
- **内容**:
  - 縦向き時のタブ切替UI
  - ツールバー最適化（モバイル）
  - タッチ対応リサイズ
  - 仮想キーボード対応

---

### Phase 3: テスト

#### Task 3.1: useFullscreen単体テスト
- **成果物**: `tests/unit/hooks/useFullscreen.test.ts`
- **依存**: Task 1.3
- **内容**:
  - Fullscreen API呼び出しテスト
  - フォールバック動作テスト
  - エラーハンドリングテスト
  - ユーザーアクション要件テスト

#### Task 3.2: useLocalStorageState単体テスト
- **成果物**: `tests/unit/hooks/useLocalStorageState.test.ts`
- **依存**: Task 1.4
- **内容**:
  - 保存/読み込みテスト
  - バリデーションテスト
  - デフォルト値テスト

#### Task 3.3: PaneResizer拡張テスト
- **成果物**: `tests/unit/components/PaneResizer.test.tsx`
- **依存**: Task 2.1
- **内容**:
  - ダブルクリックリセットテスト
  - 最小幅制限テスト
  - 後方互換性テスト

#### Task 3.4: MarkdownEditor拡張テスト
- **成果物**: `tests/unit/components/MarkdownEditor.test.tsx`
- **依存**: Task 2.4
- **内容**:
  - 最大化切替テスト
  - キーボードショートカットテスト
  - リサイズ機能テスト
  - モバイルタブ切替テスト

#### Task 3.5: E2Eテスト（デスクトップ）
- **成果物**: `tests/e2e/markdown-editor.spec.ts`
- **依存**: Task 2.4
- **内容**:
  - 最大化ボタンクリック→全画面→ESCで解除
  - リサイズドラッグ→比率変更→リロード後復元
  - ショートカットCtrl+Shift+F→最大化切替

#### Task 3.6: E2Eテスト（モバイル）
- **成果物**: `tests/e2e/markdown-editor-mobile.spec.ts`
- **依存**: Task 2.4
- **内容**:
  - 縦向き時のタブ切替
  - 最大化状態からスワイプダウンで解除
  - 横向き時のリサイズハンドル操作

---

### Phase 4: ドキュメント

#### Task 4.1: CLAUDE.md更新
- **成果物**: `CLAUDE.md`
- **依存**: 全Phase完了
- **内容**:
  - 主要機能モジュールにuseFullscreen.ts, useLocalStorageState.ts追加
  - 「最近の実装機能」にIssue #99概要追加

---

## タスク依存関係

```
Phase 0: 事前確認
┌────────────────┐
│   Task 0.1     │ 既存コード調査
└───────┬────────┘
        │
Phase 1: 基盤整備
        │
┌───────▼────────┐  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│   Task 1.1     │  │   Task 1.2     │  │   Task 1.3     │  │   Task 1.4     │
│   型定義拡張   │  │  z-index設定   │  │ useFullscreen  │  │useLocalStorage │
└───────┬────────┘  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘
        │                   │                   │                   │
Phase 2: コンポーネント拡張
        │                   │                   │                   │
┌───────▼────────┐          │                   │                   │
│   Task 2.1     │          │                   │                   │
│ PaneResizer拡張│          │                   │                   │
└───────┬────────┘          │                   │                   │
        │                   │                   │                   │
        │   ┌───────────────┴───────────────────┴───────────────────┘
        │   │
┌───────▼───▼────┐
│   Task 2.2     │
│ 最大化機能追加 │
└───────┬────────┘
        │
┌───────▼────────┐
│   Task 2.3     │
│リサイズ機能追加│
└───────┬────────┘
        │
┌───────▼────────┐
│   Task 2.4     │
│ モバイル対応   │
└───────┬────────┘
        │
Phase 3: テスト
        │
┌───────┴───────────────────────────────────────────────────┐
│                                                           │
│ ┌────────────────┐  ┌────────────────┐  ┌────────────────┐│
│ │   Task 3.1     │  │   Task 3.2     │  │   Task 3.3     ││
│ │useFullscreen   │  │useLocalStorage │  │ PaneResizer    ││
│ │テスト          │  │テスト          │  │テスト          ││
│ └───────┬────────┘  └───────┬────────┘  └───────┬────────┘│
│         │                   │                   │         │
│ ┌───────▼───────────────────▼───────────────────▼────────┐│
│ │                    Task 3.4                            ││
│ │              MarkdownEditorテスト                       ││
│ └───────┬────────────────────────────────────────────────┘│
│         │                                                 │
│ ┌───────▼────────┐  ┌────────────────┐                    │
│ │   Task 3.5     │  │   Task 3.6     │                    │
│ │E2E(デスクトップ)│  │E2E(モバイル)  │                    │
│ └───────┬────────┘  └───────┬────────┘                    │
│         │                   │                             │
└─────────┼───────────────────┼─────────────────────────────┘
          │                   │
Phase 4: ドキュメント
          │                   │
  ┌───────▼───────────────────▼────────┐
  │           Task 4.1                 │
  │         CLAUDE.md更新              │
  └────────────────────────────────────┘
```

---

## 品質チェック項目

| チェック項目 | コマンド | 基準 |
|-------------|----------|------|
| ESLint | `npm run lint` | エラー0件 |
| TypeScript | `npx tsc --noEmit` | 型エラー0件 |
| Unit Test | `npm run test:unit` | 全テストパス |
| Integration Test | `npm run test:integration` | 全テストパス |
| E2E Test | `npm run test:e2e` | 全テストパス |
| Build | `npm run build` | 成功 |

---

## 成果物チェックリスト

### コード（新規作成）
- [ ] `src/types/markdown-editor.ts`（拡張）
- [ ] `src/config/z-index.ts`
- [ ] `src/hooks/useFullscreen.ts`
- [ ] `src/hooks/useLocalStorageState.ts`

### コード（変更）
- [ ] `src/components/worktree/PaneResizer.tsx`
- [ ] `src/components/worktree/MarkdownEditor.tsx`

### テスト（新規作成）
- [ ] `tests/unit/hooks/useFullscreen.test.ts`
- [ ] `tests/unit/hooks/useLocalStorageState.test.ts`
- [ ] `tests/e2e/markdown-editor-mobile.spec.ts`

### テスト（変更）
- [ ] `tests/unit/components/PaneResizer.test.tsx`
- [ ] `tests/unit/components/MarkdownEditor.test.tsx`
- [ ] `tests/e2e/markdown-editor.spec.ts`

### ドキュメント
- [ ] `CLAUDE.md`

---

## セキュリティチェックリスト

| 項目 | 対策 | 確認 |
|------|------|------|
| XSS保護 | 既存rehype-sanitize継続使用 | [ ] |
| キーボードショートカット | ブラウザデフォルトと非競合 | [ ] |
| localStorage | 機密情報非保存、バリデーション実装 | [ ] |
| Fullscreen API | ユーザーアクションから呼び出し | [ ] |
| z-index | 競合回避、ESCで解除可能 | [ ] |

---

## 後方互換性チェックリスト

| 項目 | 確認内容 | 確認 |
|------|---------|------|
| PaneResizer | 新規props全てオプショナル | [ ] |
| PaneResizer | WorktreeDesktopLayoutで動作確認 | [ ] |
| MarkdownEditor | 既存viewMode動作維持 | [ ] |
| localStorage | 既存キー（view-mode）互換 | [ ] |

---

## Definition of Done

Issue完了条件：
- [ ] 全タスク（Task 0.1 〜 Task 4.1）完了
- [ ] 単体テストカバレッジ80%以上
- [ ] CIチェック全パス（lint, type-check, test, build）
- [ ] セキュリティチェックリスト全項目確認
- [ ] 後方互換性チェックリスト全項目確認
- [ ] 受け入れ条件（11項目）全て満たす
- [ ] 設計方針書との整合性確認
- [ ] CLAUDE.md更新完了

---

## 受け入れ条件（Issueより）

### 必須機能
1. [ ] 最大化ボタンがエディタツールバーに表示される
2. [ ] 最大化時にエディタが画面全体を占有する
3. [ ] ESCキー/スワイプで最大化を解除できる
4. [ ] Split View時にドラッグで表示領域を変更できる（デスクトップ）
5. [ ] リサイズ位置がlocalStorageに保存・復元される
6. [ ] 最大化状態がlocalStorageに保存・復元される
7. [ ] モバイル縦向き時はタブ切替UIに変更される
8. [ ] タッチ操作でリサイズハンドルを操作できる（モバイル横向き）
9. [ ] Fullscreen API非対応ブラウザでもフォールバックが機能する
10. [ ] localStorageキーが一元管理されている
11. [ ] PaneResizerの新規propsが後方互換性を維持

### テスト
12. [ ] 単体テストが追加されている
13. [ ] E2Eテストが追加されている（デスクトップ）
14. [ ] モバイルE2Eテストが追加されている
15. [ ] 既存テストが全てパスする

---

## 次のアクション

作業計画承認後：

1. **ブランチ作成**
   ```bash
   git checkout -b feature/99-markdown-editor-display-improvement
   ```

2. **タスク実行**: 計画に従ってPhase順に実装

3. **進捗報告**: `/progress-report`で定期報告

4. **PR作成**: `/create-pr`で自動作成

---

## 関連ドキュメント

- **設計方針書**: `dev-reports/design/issue-99-markdown-editor-display-improvement-design-policy.md`
- **Issueレビュー結果**: `dev-reports/issue/99/issue-review/`
- **設計レビュー結果**: `dev-reports/issue/99/multi-stage-design-review/`
- **Issue URL**: https://github.com/Kewton/CommandMate/issues/99
- **依存Issue #49**: https://github.com/Kewton/CommandMate/issues/49（完了済み）

---

*作成日: 2026-01-30*
