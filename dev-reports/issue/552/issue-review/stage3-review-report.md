# Issue #552 影響範囲レビューレポート

**レビュー日**: 2026-03-27
**フォーカス**: 影響範囲レビュー（Stage 3 / 1回目）
**Issue**: infoのPathをコピペするアイコンを追加してほしい

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 5 |
| Nice to Have | 3 |
| **合計** | **8** |

Issue #552は小規模なUI改善であり、影響範囲は限定的。変更対象ファイルは実質1ファイル（WorktreeDetailSubComponents.tsx）のみ。破壊的変更なし、APIへの影響なし。主な考慮点はimport追加、アクセシビリティ、テスト作成の3点。

---

## 影響ファイル一覧

### 直接変更が必要なファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/components/worktree/WorktreeDetailSubComponents.tsx` | WorktreeInfoFieldsにコピーアイコン追加、useState x2追加、lucide-react/clipboard-utilsのimport追加 |

### 参照パターン（変更不要）

| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/FileViewer.tsx` | 既存コピーパターンの参照元（ClipboardCopy/Check切替、2秒フィードバック） |
| `src/lib/clipboard-utils.ts` | copyToClipboard関数（変更不要、importして使用） |

### 影響を受けるが変更不要なファイル

| ファイル | 理由 |
|---------|------|
| InfoModal（同ファイル内） | WorktreeInfoFieldsを使用するが、propsインターフェース変更なしのため変更不要 |
| MobileInfoContent（同ファイル内） | 同上 |
| MobileContent（同ファイル内） | MobileInfoContentを経由して間接的に影響するが変更不要 |
| WorktreeDetailRefactored.tsx | InfoModalを使用するが変更不要 |

### 影響なしの領域

- APIルート（src/app/api/）: 影響なし
- データベースレイヤー（src/lib/db/）: 影響なし
- CLIモジュール（src/cli/）: 影響なし
- サーバーサイドロジック: 影響なし

---

## Should Fix（推奨対応）

### F3-001: WorktreeInfoFieldsのmemoとstate追加の影響

**カテゴリ**: 影響ファイル

WorktreeInfoFieldsはReact.memoで最適化されている。コピー状態管理（useState x2: pathCopied, repoCopied）を内部に追加すると、コピーアイコンクリック時にWorktreeInfoFields全体が再レンダリングされる。InfoModal（デスクトップ）とMobileInfoContent（モバイル）の両方で使用されている。

ただし、memo境界の内側での状態変更であるため、親コンポーネントへの再レンダリング伝播はない。パフォーマンス上の懸念は軽微。

**推奨対応**: WorktreeInfoFields内にuseState(false)を2つ追加する形で実装する。

---

### F3-002: lucide-reactアイコンの新規import追加

**カテゴリ**: 依存関係

WorktreeDetailSubComponents.tsxは現在lucide-reactをimportしていない。`ClipboardCopy`と`Check`アイコンの新規importが必要。lucide-reactはプロジェクトの既存依存であるため、package.jsonの変更は不要。

**推奨対応**: `import { ClipboardCopy, Check } from 'lucide-react'` を追加する。

---

### F3-003: clipboard-utilsのimport追加

**カテゴリ**: 依存関係

copyToClipboard関数のimportを追加する必要がある。clipboard-utils.tsはクライアントサイドコードであり、WorktreeDetailSubComponents.tsxの`'use client'`ディレクティブと互換性がある。

**推奨対応**: `import { copyToClipboard } from '@/lib/clipboard-utils'` を追加する。

---

### F3-004: WorktreeInfoFieldsのテスト不足

**カテゴリ**: テスト範囲

WorktreeInfoFieldsコンポーネントの個別テストが存在しない。コピー機能追加後、以下のテストケースが必要:
1. コピーアイコンがPathフィールドとRepository Pathフィールドの横に表示されること
2. クリック時にcopyToClipboardが正しいパス文字列で呼び出されること
3. コピー成功後にCheckアイコンに切り替わること
4. 2秒後にClipboardCopyアイコンに復帰すること

clipboard-utils自体には既存テスト（`src/lib/__tests__/clipboard-utils.test.ts`）があるため、コンポーネント側のテストに集中すればよい。

**推奨対応**: WorktreeInfoFieldsのコピー機能に関する単体テストを作成する。

---

### F3-005: アクセシビリティ属性の追加

**カテゴリ**: テスト範囲

FileViewer.tsxの既存パターンでは`aria-label="Copy file path"`と`title="Copy path"`が設定されている。Issueの受け入れ条件にアクセシビリティ要件は明記されていないが、既存パターンとの一貫性のために同様の属性追加が必要。PathとRepository Pathで異なるaria-labelを設定すべき。

**推奨対応**:
- Pathフィールド: `aria-label="Copy worktree path"`, `title="Copy path"`
- Repository Pathフィールド: `aria-label="Copy repository path"`, `title="Copy repository path"`

---

## Nice to Have（あれば良い）

### F3-006: 破壊的変更なし確認

propsインターフェース（WorktreeInfoFieldsProps）の変更は不要。コピー機能は内部stateとして実装できるため、親コンポーネントへの影響なし。

### F3-007: APIルート・データレイヤーへの影響なし

純粋にフロントエンドのUI変更。copyToClipboardはブラウザのClipboard APIのみを使用。

### F3-008: ドキュメント更新不要

UIの小規模改善であり、ドキュメント更新は不要。

---

## 参照ファイル

### コード
- `src/components/worktree/WorktreeDetailSubComponents.tsx`: 変更対象（WorktreeInfoFields L185-330）
- `src/components/worktree/FileViewer.tsx`: 既存コピーパターン参照（L271-279, L548-558）
- `src/lib/clipboard-utils.ts`: copyToClipboard関数（変更不要）

### テスト
- `src/lib/__tests__/clipboard-utils.test.ts`: clipboard-utilsの既存テスト（変更不要）
- `tests/unit/components/WorktreeDetailRefactored.test.tsx`: 関連テスト（コピー機能テスト追加を検討）
