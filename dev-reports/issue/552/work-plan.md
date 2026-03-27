# 作業計画書: Issue #552

## Issue: infoのPathをコピペするアイコンを追加してほしい
**Issue番号**: #552
**サイズ**: S
**優先度**: Medium
**依存Issue**: なし

## 詳細タスク分解

### Phase 1: 実装タスク

- [ ] **Task 1.1**: WorktreeInfoFieldsコンポーネントにコピー機能を追加
  - 成果物: `src/components/worktree/WorktreeDetailSubComponents.tsx`
  - 依存: なし
  - 作業内容:
    1. `ClipboardCopy`, `Check` を lucide-react からimport
    2. `copyToClipboard` を `@/lib/clipboard-utils` からimport
    3. `useState` x2（pathCopied, repoPathCopied）追加
    4. `useRef` x2（pathTimerRef, repoPathTimerRef）追加
    5. `useEffect` cleanup でアンマウント時にタイマークリア（DR1-005）
    6. `handleCopyPath` / `handleCopyRepoPath` ハンドラ追加（clearTimeout + setTimeout、IA3-004）
    7. Pathフィールド（L210-214）にコピーボタン追加
    8. Repository Infoフィールド（L203-208）にコピーボタン追加
    9. アクセシビリティ属性（aria-label, title, type="button"）付与

### Phase 2: テストタスク

- [ ] **Task 2.1**: WorktreeInfoFieldsコピー機能の単体テスト作成
  - 成果物: `tests/unit/components/WorktreeInfoFields-copy.test.tsx`
  - 依存: Task 1.1
  - テストケース:
    1. PathとRepository Pathにコピーアイコンが表示される
    2. Pathコピーアイコンクリック時に`copyToClipboard(worktree.path)`が呼ばれる
    3. Repo Pathコピーアイコンクリック時に`copyToClipboard(worktree.repositoryPath)`が呼ばれる
    4. コピー成功後にCheckアイコンに切り替わる
    5. 2秒後にClipboardCopyアイコンに復帰する（vi.useFakeTimers）
    6. aria-label, title属性が正しく設定されている
    7. アンマウント時にタイマーがクリアされる（DR1-005）
    8. 連続クリック時に前回タイマーがクリアされる（IA3-004）

### Phase 3: 品質チェック

- [ ] **Task 3.1**: 静的解析・ビルド検証
  - `npx tsc --noEmit` → 型エラー0件
  - `npm run lint` → ESLintエラー0件
  - `npm run test:unit` → 全テストパス
  - `npm run build` → ビルド成功

## タスク依存関係

```
Task 1.1 (コンポーネント実装)
    │
    ▼
Task 2.1 (単体テスト)
    │
    ▼
Task 3.1 (品質チェック)
```

全タスクは直列実行。合計3タスク。

## 品質チェック項目

| チェック項目 | コマンド | 基準 |
|-------------|----------|------|
| TypeScript | `npx tsc --noEmit` | 型エラー0件 |
| ESLint | `npm run lint` | エラー0件 |
| Unit Test | `npm run test:unit` | 全テストパス |
| Build | `npm run build` | 成功 |

## 成果物チェックリスト

### コード
- [ ] `src/components/worktree/WorktreeDetailSubComponents.tsx` - コピーボタン追加

### テスト
- [ ] `tests/unit/components/WorktreeInfoFields-copy.test.tsx` - 新規作成

## Definition of Done

- [ ] Task 1.1〜3.1すべて完了
- [ ] 受け入れ条件8項目すべて充足
- [ ] CIチェック全パス（lint, type-check, test, build）

## 次のアクション

1. `/pm-auto-dev 552` でTDD実装開始
2. `/create-pr` でPR作成

---

*Generated for Issue #552 - 2026-03-27*
