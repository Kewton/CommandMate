# Issue #63 作業計画書

## Issue: auto yes モードにてオン時警告メッセージ
**Issue番号**: #63
**サイズ**: S
**優先度**: Medium
**依存Issue**: #61（auto yesモードの追加 — 完了済み）

---

## 1. 詳細タスク分解

### Phase 1: 実装

- [ ] **Task 1.1**: `AutoYesConfirmDialog` コンポーネント新規作成
  - 成果物: `src/components/worktree/AutoYesConfirmDialog.tsx`
  - 依存: なし
  - 内容:
    - 既存 `Modal`（`size="sm"`, `showCloseButton: true`）を利用
    - 警告メッセージ（機能説明・リスク説明）を表示
    - 免責事項を注意喚起ブロック（`bg-yellow-50 border-l-4 border-yellow-400`）で表示
    - 「同意して有効化」（`bg-yellow-600`）と「キャンセル」（`bg-gray-200`）ボタン配置
    - Props: `isOpen`, `onConfirm`, `onCancel`

- [ ] **Task 1.2**: `AutoYesToggle` にダイアログ統合
  - 成果物: `src/components/worktree/AutoYesToggle.tsx`（既存変更）
  - 依存: Task 1.1
  - 内容:
    - `showConfirmDialog` state を追加
    - `handleToggle` を分岐: ON操作→ダイアログ表示、OFF操作→直接実行
    - `handleConfirm` コールバック追加: ダイアログ閉じ→`onToggle(true)`呼び出し
    - `handleCancel` コールバック追加: ダイアログ閉じのみ
    - JSX末尾に `AutoYesConfirmDialog` を配置

### Phase 2: テスト

- [ ] **Task 2.1**: `AutoYesConfirmDialog` 単体テスト
  - 成果物: `tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx`
  - 依存: Task 1.1
  - テスト項目:
    - `isOpen=true` でダイアログが表示される
    - `isOpen=false` でダイアログが表示されない
    - 「同意して有効化」クリックで `onConfirm` が呼ばれる
    - 「キャンセル」クリックで `onCancel` が呼ばれる
    - 警告メッセージ・免責事項テキストが表示される

- [ ] **Task 2.2**: `AutoYesToggle` 単体テスト追加
  - 成果物: `tests/unit/components/worktree/AutoYesToggle.test.tsx`（新規作成）
  - 依存: Task 1.2
  - テスト項目:
    - OFF状態でトグルクリック→ダイアログが表示される（`onToggle`は呼ばれない）
    - ダイアログで同意→`onToggle(true)` が呼ばれる
    - ダイアログでキャンセル→`onToggle` が呼ばれない
    - ON状態でトグルクリック→ダイアログなしで `onToggle(false)` が呼ばれる

### Phase 3: 品質確認

- [ ] **Task 3.1**: CI品質チェック実行
  - 依存: Task 1.2
  - 内容: lint, type-check, test, build すべてパス

---

## 2. タスク依存関係

```
Task 1.1 (ConfirmDialog新規作成)
  ├──→ Task 1.2 (AutoYesToggleに統合)
  │      └──→ Task 2.2 (Toggle テスト)
  │             └──→ Task 3.1 (CI品質チェック)
  └──→ Task 2.1 (Dialog テスト)
```

---

## 3. 品質チェック項目

| チェック項目 | コマンド | 基準 |
|-------------|----------|------|
| ESLint | `npm run lint` | エラー0件 |
| TypeScript | `npx tsc --noEmit` | 型エラー0件 |
| Unit Test | `npm run test:unit` | 全テストパス |
| Build | `npm run build` | 成功 |

---

## 4. 成果物チェックリスト

### コード
- [ ] `src/components/worktree/AutoYesConfirmDialog.tsx`（新規）
- [ ] `src/components/worktree/AutoYesToggle.tsx`（変更）

### テスト
- [ ] `AutoYesConfirmDialog` 単体テスト
- [ ] `AutoYesToggle` 単体テスト（ダイアログ統合分）

---

## 5. Definition of Done

- [ ] すべてのタスク（Phase 1〜3）が完了
- [ ] CIチェック全パス（lint, type-check, test, build）
- [ ] 受け入れ条件10項目すべて充足
- [ ] モバイル・デスクトップ両方でダイアログ表示を確認

---

## 6. 次のアクション

1. **ブランチ作成**: `feature/63-auto-yes-warning-dialog`
2. **TDD実装**: `/tdd-impl` でTask 1.1 → 1.2を順次実行
3. **PR作成**: `/create-pr` で自動作成
