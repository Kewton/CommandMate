# Issue #504 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-16
**フォーカス**: 影響範囲レビュー（1回目）
**イテレーション**: 1

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 4 |
| **合計** | **6** |

## 影響範囲マップ

### 直接変更が必要なファイル（3件）

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/sidebar-utils.ts` | `generateRepositoryColor` 関数の追加 |
| `src/components/layout/Sidebar.tsx` | `GroupHeader` に色付きドット要素を追加 |
| `tests/unit/lib/sidebar-utils.test.ts` | 色生成関数のユニットテスト追加 |

### 変更不要だが確認済みのファイル（6件）

| ファイル | 確認結果 |
|---------|---------|
| `src/contexts/SidebarContext.tsx` | 型importのみ。状態変更不要 |
| `src/components/sidebar/BranchListItem.tsx` | CLIステータスドット(w-2 h-2)のデザイン参照。変更不要 |
| `src/components/sidebar/BranchStatusIndicator.tsx` | ステータスインジケーター(w-3 h-3)のデザイン参照。変更不要 |
| `src/components/sidebar/SortSelector.tsx` | 型importのみ。変更不要 |
| `src/components/layout/AppShell.tsx` | モバイルドロワーでSidebarをそのまま利用。変更不要 |
| `src/components/mobile/MobileHeader.tsx` | Sidebarとは独立。変更不要 |

### 破壊的変更: なし
### 新規依存ライブラリ: なし

---

## Should Fix（推奨対応）

### F3-001: 色生成関数のパフォーマンス考慮を記載すべき

**カテゴリ**: 影響範囲 - パフォーマンス

**問題**:
GroupHeaderコンポーネントはgroupedBranches配列のmap内でレンダリングされる。色生成関数は純粋関数で高速だが、再レンダリング時に毎回呼ばれる。現状のgroupedBranchesはuseMemoで保護されており実質的な問題は起きにくいが、パフォーマンス設計意図をIssueに明記しておくことが望ましい。

**推奨対応**:
Issueに「色生成は純粋関数であり、リポジトリ数が少ないためメモ化は不要。将来的にリポジトリ数が増加した場合はuseMemoでの最適化を検討」と注記する。

---

### F3-002: テスト追加先ファイルの具体化

**カテゴリ**: 影響範囲 - テスト

**問題**:
Issueでは「ユニットテスト追加」と記載されているが、既存のテストファイル `tests/unit/lib/sidebar-utils.test.ts` が存在する。具体的にどのファイルにどのようなテストケースを追加するかが不明確。

**証拠**:
- 既存テスト: `tests/unit/lib/sidebar-utils.test.ts` に `sortBranches` / `groupBranches` のテストが377行存在
- Issueの記載: 「同じリポジトリ名で同じ色が生成されることを確認」のみ

**推奨対応**:
実装タスクを以下に具体化する:
- テスト追加先: `tests/unit/lib/sidebar-utils.test.ts`
- テストケース: (1) 同一入力で同一出力の冪等性、(2) 異なる入力で異なるhue値、(3) 空文字列の処理、(4) 返却値が有効なHSL文字列であること

---

## Nice to Have（あれば良い）

### F3-003: モバイルドロワーでの視認性確認

GroupHeaderのflexレイアウトにドットが1要素追加される（chevron + dot + folder + text + count で5要素）。モバイルドロワー幅 w-72 (288px) で窮屈にならないか、特にリポジトリ名が長い場合のtruncate動作を実装時に目視確認する旨をIssueに記載するとよい。

### F3-004: SSR/ハイドレーション問題なし（確認済み）

Sidebar.tsxは `'use client'` ディレクティブ付き。色生成は決定論的な純粋関数のため、ハイドレーションミスマッチの懸念はない。対応不要。

### F3-005: i18n影響なし（確認済み）

色付きドットは非テキスト要素。翻訳対象外。aria-labelを付与する場合のi18nキー追加は低優先度。

### F3-006: エクスポートへの影響は最小限

sidebar-utils.tsへの新関数追加exportのみ。既存exportの変更なし。後方互換性は維持される。

---

## 参照ファイル

### コード
- `src/components/layout/Sidebar.tsx` (line 265-297): GroupHeader変更箇所
- `src/lib/sidebar-utils.ts`: generateRepositoryColor追加先
- `src/components/sidebar/BranchListItem.tsx` (line 34-55): CLIステータスドットのサイズ参照 (w-2 h-2)
- `src/components/sidebar/BranchStatusIndicator.tsx`: 既存ステータスインジケーターのサイズ参照 (w-3 h-3)

### テスト
- `tests/unit/lib/sidebar-utils.test.ts`: テスト追加先
