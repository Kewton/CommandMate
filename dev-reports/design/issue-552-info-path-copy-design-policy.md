# 設計方針書: Issue #552 InfoモーダルPathコピー機能

## 1. 概要

Worktree詳細画面のInfoモーダル内の **Path** と **Repository Path** フィールドに、クリップボードコピーアイコンを追加する。

### スコープ
- 変更対象: `src/components/worktree/WorktreeDetailSubComponents.tsx` の `WorktreeInfoFields` コンポーネント
- 純粋なクライアントサイドUI変更（API/DB/CLI影響なし）

## 2. アーキテクチャ設計

### コンポーネント構成（変更前後）

```
InfoModal (desktop)  ──┐
                       ├─→ WorktreeInfoFields ──→ Path (text only)
MobileInfoContent ─────┘                     ──→ Repository Path (text only)

↓ 変更後

InfoModal (desktop)  ──┐
                       ├─→ WorktreeInfoFields ──→ Path + CopyButton
MobileInfoContent ─────┘                     ──→ Repository Path + CopyButton
```

### データフロー

```
ユーザークリック → handleCopyPath/handleCopyRepoPath
  → copyToClipboard(path) [clipboard-utils.ts]
  → setState(true) → アイコン切替(Check)
  → clearTimeout(timerRef.current)  [IA3-004: 前回タイマーをクリア]
  → timerRef.current = setTimeout(2000) → setState(false) → アイコン復帰(ClipboardCopy)

コンポーネントアンマウント時:
  → useEffect cleanup → clearTimeout(pathTimerRef) / clearTimeout(repoPathTimerRef)
```

## 3. 技術選定

| カテゴリ | 選定技術 | 選定理由 |
|---------|---------|---------|
| コピーユーティリティ | `copyToClipboard` (clipboard-utils.ts) | 既存ユーティリティ、ANSI除去・フォールバック済み |
| アイコン | `ClipboardCopy`, `Check` (lucide-react) | FileViewer.tsxと同一パターン |
| 状態管理 | `useState` + `useRef` (React) | コンポーネントローカル、2フィールド分 + タイマーref |
| フィードバック | 2秒タイマー (setTimeout) | FileViewer.tsxのコピーUIパターンをベースとし、タイマークリーンアップはFilePanelContent.tsxのuseRef + useEffect cleanupパターンを採用（CR2-004） |

## 4. 設計パターン

### 既存パターンの踏襲（FileViewer.tsx L271-279, L548-558）

```typescript
// ハンドラパターン
const handleCopyPath = useCallback(async () => {
  try {
    await copyToClipboard(path);
    setPathCopied(true);
    setTimeout(() => setPathCopied(false), 2000);
  } catch {
    // Silent failure
  }
}, [path]);

// UIパターン（既存FileViewer.tsx: type属性なし）
// 注: セクション5の実装では type="button" を明示的に追加（CR2-003: フォーム内での暗黙のsubmit防止）
<button
  onClick={handleCopyPath}
  className="flex-shrink-0 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
  aria-label="Copy worktree path"
  title="Copy path"
>
  {pathCopied ? (
    <Check className="w-3.5 h-3.5 text-green-600" />
  ) : (
    <ClipboardCopy className="w-3.5 h-3.5" />
  )}
</button>
```

### 設計原則

- **DRY**: FileViewer.tsx / FilePanelContent.tsx の確立されたパターンを踏襲。コピーボタンパターンはコードベース全体で4箇所に存在するため、将来的な共通コンポーネント抽出を検討する（DR1-001参照）。今回はインラインで実装し、TODO コメントで他の実装箇所を明記する
- **KISS**: useState + useCallback + setTimeout + useRef(cleanup) のシンプルな構成
- **YAGNI**: 今回のスコープでは共通コンポーネント抽出は行わない。ただしコードベース全体のDRY観点から将来課題として記録する

## 5. 変更詳細設計

### 5-1. WorktreeInfoFields コンポーネント変更

#### import追加

> **注**: `useRef` と `useEffect` は WorktreeDetailSubComponents.tsx L14 で既にインポート済み（CR2-002）。新規追加が必要なのは lucide-react アイコンと clipboard-utils のみ。

```typescript
// 既存import（L14）に useRef, useEffect は含まれている:
// import React, { useEffect, useCallback, useState, memo, useRef } from 'react';

// 新規import追加:
import { ClipboardCopy, Check } from 'lucide-react';
import { copyToClipboard } from '@/lib/clipboard-utils';
```

#### 新規state・ref追加（memo境界内）

```typescript
const [pathCopied, setPathCopied] = useState(false);
const [repoPathCopied, setRepoPathCopied] = useState(false);
const pathTimerRef = useRef<ReturnType<typeof setTimeout>>();
const repoPathTimerRef = useRef<ReturnType<typeof setTimeout>>();
```

#### setTimeout クリーンアップ（DR1-005: must_fix）

InfoModalは頻繁に開閉されるため、アンマウント時にsetTimeoutを確実にクリアする。

```typescript
useEffect(() => {
  return () => {
    if (pathTimerRef.current) clearTimeout(pathTimerRef.current);
    if (repoPathTimerRef.current) clearTimeout(repoPathTimerRef.current);
  };
}, []);
```

#### 新規ハンドラ追加

```typescript
// TODO: コピーボタンパターンはFileViewer.tsx, FilePanelContent.tsxにも存在（計4箇所）
// 将来的に src/components/common/CopyIconButton.tsx への共通化を検討
const handleCopyPath = useCallback(async () => {
  try {
    await copyToClipboard(worktree.path);
    setPathCopied(true);
    if (pathTimerRef.current) clearTimeout(pathTimerRef.current); // IA3-004: 連続クリック時の孤立タイマー防止
    pathTimerRef.current = setTimeout(() => setPathCopied(false), 2000);
  } catch {
    // Silent failure
  }
}, [worktree.path]);

const handleCopyRepoPath = useCallback(async () => {
  try {
    await copyToClipboard(worktree.repositoryPath);
    setRepoPathCopied(true);
    if (repoPathTimerRef.current) clearTimeout(repoPathTimerRef.current); // IA3-004: 連続クリック時の孤立タイマー防止
    repoPathTimerRef.current = setTimeout(() => setRepoPathCopied(false), 2000);
  } catch {
    // Silent failure
  }
}, [worktree.repositoryPath]);
```

#### Path フィールド変更（L210-214）

変更前:
```tsx
<div className={cardClassName}>
  <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Path</h2>
  <p className="text-sm text-gray-700 dark:text-gray-300 break-all font-mono">{worktree.path}</p>
</div>
```

変更後:
```tsx
<div className={cardClassName}>
  <div className="flex items-center justify-between mb-1">
    <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400">Path</h2>
    <button
      type="button"
      onClick={handleCopyPath}
      className="flex-shrink-0 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
      aria-label="Copy worktree path"
      title="Copy path"
    >
      {pathCopied ? (
        <Check className="w-3.5 h-3.5 text-green-600" />
      ) : (
        <ClipboardCopy className="w-3.5 h-3.5" />
      )}
    </button>
  </div>
  <p className="text-sm text-gray-700 dark:text-gray-300 break-all font-mono">{worktree.path}</p>
</div>
```

#### Repository Info フィールド変更（L203-208）

変更前:
```tsx
<div className={cardClassName}>
  <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Repository</h2>
  <p className="text-base text-gray-900 dark:text-gray-100">{worktree.repositoryName}</p>
  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 break-all">{worktree.repositoryPath}</p>
</div>
```

変更後:
```tsx
<div className={cardClassName}>
  <div className="flex items-center justify-between mb-1">
    <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400">Repository</h2>
    <button
      type="button"
      onClick={handleCopyRepoPath}
      className="flex-shrink-0 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
      aria-label="Copy repository path"
      title="Copy repository path"
    >
      {repoPathCopied ? (
        <Check className="w-3.5 h-3.5 text-green-600" />
      ) : (
        <ClipboardCopy className="w-3.5 h-3.5" />
      )}
    </button>
  </div>
  <p className="text-base text-gray-900 dark:text-gray-100">{worktree.repositoryName}</p>
  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 break-all">{worktree.repositoryPath}</p>
</div>
```

## 6. パフォーマンス設計

- `WorktreeInfoFields` は `React.memo` で最適化済み
- `useState` x2 はmemo境界の内側 → 親コンポーネントへの再レンダリング伝播なし
- `useCallback` でハンドラを安定化
- パフォーマンス影響: 無視可能（ボタンクリック時のみstate変更）

## 7. アクセシビリティ設計

| 属性 | Path | Repository Path |
|------|------|----------------|
| `aria-label` | "Copy worktree path" | "Copy repository path" |
| `title` | "Copy path" | "Copy repository path" |
| `type` | "button" | "button" |

- ボタンはキーボードフォーカス可能（デフォルトの`<button>`動作）
- アイコン切替で視覚フィードバックを提供

## 8. テスト設計

### テストファイル
`tests/unit/components/WorktreeInfoFields-copy.test.tsx`（新規作成）

### テストケース

| # | テストケース | 検証内容 |
|---|------------|---------|
| 1 | コピーアイコン表示 | PathとRepository Pathにコピーボタンが表示される |
| 2 | Pathコピー実行 | クリック時に`copyToClipboard(worktree.path)`が呼ばれる |
| 3 | Repo Pathコピー実行 | クリック時に`copyToClipboard(worktree.repositoryPath)`が呼ばれる |
| 4 | アイコン切替 | コピー成功後にCheckアイコンに切り替わる |
| 5 | アイコン復帰 | 2秒後にClipboardCopyアイコンに戻る（vi.useFakeTimers使用） |
| 6 | アクセシビリティ | aria-label, title属性が正しく設定されている |
| 7 | アンマウント時タイマークリーンアップ (DR1-005) | コピー後2秒以内にアンマウントしてもエラーが発生しない（clearTimeout呼び出し確認） |
| 8 | 連続クリック時のタイマー競合防止 (IA3-004) | 連続クリック時に前回タイマーがクリアされ、最後のクリックから2秒後にアイコンが復帰する |
| 9 | ベースラインレンダリング (IA3-001, 推奨) | 既存フィールド（worktree名、リポジトリ名、パステキスト、ステータスバッジ）がレイアウト変更後も正しく表示される |

### モック対象
- `@/lib/clipboard-utils` の `copyToClipboard` をvi.mockでモック

## 9. 影響範囲サマリー

| カテゴリ | 影響 |
|---------|------|
| 変更ファイル | `WorktreeDetailSubComponents.tsx` のみ |
| 新規ファイル | テストファイル1つ |
| API | なし |
| DB | なし |
| CLI | なし |
| 依存追加 | なし（既存のlucide-react, clipboard-utils） |
| 破壊的変更 | なし（propsインターフェース変更なし） |
| デスクトップ | 自動反映（WorktreeInfoFields共有） |
| モバイル | 自動反映（WorktreeInfoFields共有） |

## 10. 設計上の決定事項

| 決定事項 | 理由 | 代替案 |
|---------|------|--------|
| インラインコピーボタン（今回はヘルパー抽出なし） | 今回のスコープでは2箇所のみ。コードベース全体では4箇所（DR1-001）だが、今回はTODOコメントで記録し将来課題とする | CopyIconButton共通コンポーネント抽出 → 将来の検討課題として記録 |
| FileViewer.tsx/FilePanelContent.tsxのコピーボタンパターン踏襲（タイマークリーンアップはFilePanelContent.tsxの改良版パターンに準拠） | UI一貫性、検証済みパターン。FileViewer.tsxのhandleCopyPath (L271-279) はsetTimeoutをuseRefに保持していないが、FilePanelContent.tsxはuseRef+useEffect cleanupパターンを使用しており、後者を採用する（CR2-004） | 独自UIデザイン → 一貫性損失 |
| ヘッダー行にボタン配置 | ラベルと同じ行、省スペース | テキスト横配置 → レイアウト崩れリスク |
| Silent failure | FileViewer.tsxと同一、パスコピー失敗は致命的でない | Toast表示 → 過度な実装 |
| setTimeout cleanup (useRef + useEffect) | InfoModalは頻繁に開閉されるため、アンマウント時のstate更新を防止（DR1-005） | cleanupなし → アンマウント後のstate更新リスク |

## 11. レビュー指摘事項サマリー（Stage 1: 通常レビュー）

### must_fix

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| DR1-005 | KISS/Robustness | setTimeout cleanup missing on unmount | useRef でタイマーIDを保持し、useEffect cleanup で clearTimeout する。セクション5-1に反映済み |

### should_fix

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| DR1-001 | DRY | Copy button pattern duplicated across 4 instances (3 files) | 今回のスコープではインライン実装を維持。TODOコメントで他の実装箇所（FileViewer.tsx, FilePanelContent.tsx）を明記し、将来の共通コンポーネント抽出（src/components/common/CopyIconButton.tsx）の候補として記録 |

### nice_to_have

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| DR1-002 | DRY | handleCopyPath / handleCopyRepoPath の局所重複 | 2箇所の同一コンポーネント内重複であり許容範囲。今回は対応しない |
| DR1-003 | KISS | Silent failure に開発モードログ追加 | 既存FileViewer.tsxパターンとの一貫性を優先し、今回は対応しない |
| DR1-004 | SOLID/SRP | WorktreeInfoFields の責務肥大化傾向 | 現時点では問題なし。将来のIssueで追加のインタラクティブ機能が増えた場合にサブコンポーネント分割を検討 |

## 12. レビュー指摘事項サマリー（Stage 2: 整合性レビュー）

### must_fix

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| CR2-004 | 整合性/既存パターン不一致 | FileViewer.tsx handleCopyPath lacks useRef cleanup (design claims pattern consistency) | 設計書の「FileViewer.tsxパターン完全踏襲」を「FileViewer.tsx/FilePanelContent.tsxのコピーボタンパターン踏襲（タイマークリーンアップはFilePanelContent.tsxの改良版パターンに準拠）」に修正。セクション4, 10, 技術選定テーブルを更新済み。FileViewer.tsxのタイマークリーンアップ不足は将来課題として記録 |

### should_fix

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| CR2-001 | 整合性/行番号精度 | FileViewer.tsx line number reference off by one | セクション4見出しの行番号を L270-279 から L271-279 に修正（L270はJSDocコメント行） |

### nice_to_have

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| CR2-002 | 整合性/import記述 | useRef and useEffect already imported in target file | セクション5-1のimportセクションを更新し、useRef/useEffectが既存importに含まれている旨を注記追加 |
| CR2-003 | 整合性/参照パターン差異 | Design section 4 pattern lacks type='button' but section 5 includes it | セクション4のUIパターンにコメント注記を追加し、セクション5でtype="button"を改善として追加した旨を明記 |
| CR2-005 | 整合性/変更前コード検証 | Line numbers in section 5 match actual code exactly | 対応不要（整合性確認済み） |
| CR2-006 | 整合性/型検証 | Worktree type properties match design references | 対応不要（整合性確認済み） |
| CR2-007 | 整合性/コンポーネント構成 | WorktreeInfoFields correctly identified as memo component | 対応不要（整合性確認済み） |

### 将来課題

- FileViewer.tsx の handleCopyPath (L271-279) は setTimeout を useRef に保持しておらず、クリーンアップを行っていない。将来的に FilePanelContent.tsx と同様の useRef+useEffect cleanup パターンに統一することを推奨する（CR2-004関連）

## 14. レビュー指摘事項サマリー（Stage 3: 影響分析レビュー）

### should_fix

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| IA3-004 | 影響範囲/タイマー競合 | Multiple rapid clicks do not clear previous timer before starting new one | ハンドラ内で `clearTimeout(timerRef.current)` を setTimeout 代入前に追加。セクション2（データフロー）およびセクション5-1（ハンドラ実装）に反映済み |

### nice_to_have

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| IA3-001 | 影響範囲/テストカバレッジ | No existing unit tests for WorktreeInfoFields - regression risk | 新規テストファイルにベースラインレンダリングテスト（既存フィールドの表示確認）を1-2件追加することを推奨。セクション8のテストケースに追記 |
| IA3-002 | 影響範囲/新規import | First lucide-react import in WorktreeDetailSubComponents.tsx | 対応不要。lucide-reactはプロジェクト全体で広く使用されており、tree-shakingによりバンドル影響は無視可能 |
| IA3-003 | 影響範囲/モバイル表示 | Copy button touch target may be small on mobile (22x22px) | 今回は対応しない。モバイルではネイティブの長押しコピーも利用可能。将来的にp-2への拡大やmin-w/min-h制約の追加を検討 |
| IA3-005 | 影響範囲/レイアウト変更 | mb-1 removal from h2 when wrapping in flex container | 対応不要。mb-1はh2から親flexコンテナに移動しており、視覚的結果は同一。実装時の確認事項として認識 |

### 影響分析検証結果

| 検証項目 | 結果 | 根拠 |
|---------|------|------|
| 単一ファイル変更 | 確認済み | WorktreeInfoFieldsはWorktreeDetailSubComponents.tsx内でのみ定義・使用 |
| propsインターフェース変更なし | 確認済み | WorktreeInfoFieldsProps (L165-176) は未変更 |
| memo境界維持 | 確認済み | memo(function WorktreeInfoFields(...))で内部stateは親に伝播しない |
| デスクトップ・モバイル自動反映 | 確認済み | InfoModal (L554) と MobileInfoContent (L685) 双方が同一コンポーネントを使用 |
| 既存import確認 | 確認済み | useRef, useEffect, useState, useCallback, memoはL14で既にインポート済み |
| 行番号整合性 | 確認済み | Repository (L203-208), Path (L210-214) が設計書と一致 |

## 15. 実装チェックリスト

- [ ] **DR1-005 (must_fix)**: `useRef<ReturnType<typeof setTimeout>>` を pathTimerRef / repoPathTimerRef として追加
- [ ] **DR1-005 (must_fix)**: `useEffect` cleanup で両タイマーを clearTimeout
- [ ] **DR1-005 (must_fix)**: ハンドラ内で `timerRef.current = setTimeout(...)` に変更
- [ ] **IA3-004 (should_fix)**: ハンドラ内で `clearTimeout(timerRef.current)` を setTimeout 代入前に追加（連続クリック時の孤立タイマー防止）
- [ ] **DR1-001 (should_fix)**: ハンドラに TODO コメントを追加（他の実装箇所: FileViewer.tsx, FilePanelContent.tsx）
- [ ] **DR1-001 (should_fix)**: 将来の共通化候補パス `src/components/common/CopyIconButton.tsx` を TODO に明記
- [ ] `ClipboardCopy`, `Check` (lucide-react) と `copyToClipboard` (clipboard-utils) の import を追加（useRef/useEffectは既存importに含まれるため追加不要: CR2-002）
- [ ] テストケースに「アンマウント時のタイマークリーンアップ」を追加
- [ ] **(IA3-001 推奨)**: テストファイルにベースラインレンダリングテスト（既存フィールド表示確認）を追加

---

*Generated for Issue #552 - 2026-03-27*
*Updated with Stage 1 review findings - 2026-03-27*
*Updated with Stage 2 consistency review findings - 2026-03-27*
*Updated with Stage 3 impact analysis review findings - 2026-03-27*
