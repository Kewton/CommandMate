# Architecture Review: Issue #321 - Stage 3 Impact Analysis

| Item | Detail |
|------|--------|
| **Issue** | #321 - メモのコピー機能 |
| **Stage** | 3 - 影響分析レビュー |
| **Focus** | 影響範囲 |
| **Status** | approved |
| **Score** | 5/5 |
| **Date** | 2026-02-20 |

---

## Executive Summary

Issue #321の設計方針書に対する影響範囲分析を実施した。MemoCardPropsに変更を加えない設計判断により、変更はMemoCardコンポーネント内部に完全に閉じ込められている。MemoPane、WorktreeDetailRefactored、既存テストへの波及影響はゼロであり、バンドルサイズ・パフォーマンスへの影響も無視可能である。破壊的変更は存在しない。Must Fix項目・Should Fix項目ともにゼロであり、3件のNice to Have指摘のみで承認とする。

---

## Impact Analysis

### 1. Direct Changes (直接変更ファイル)

| File | Change Type | Description | Risk |
|------|------------|-------------|------|
| `src/components/worktree/MemoCard.tsx` | 修正 | Copy/Checkアイコンimport追加、useState(copied)追加、useRef(timerRef)追加、useEffect cleanup追加、handleCopyコールバック追加（clearTimeout付き）、ヘッダー部にコピーボタンJSX追加 | Low |
| `tests/unit/components/worktree/MemoCard.test.tsx` | 修正 | clipboard-utilsモック追加、コピー機能テスト7件追加 | Low |
| `CLAUDE.md` | 修正 | MemoCard.tsxモジュール説明追加 | Low |

### 2. Indirect Impact Analysis (間接影響分析)

#### 2.1 MemoPane.tsx -> MemoCard影響

**結論: 影響なし**

`MemoPane.tsx` (L208-213) でMemoCardを利用しているが、渡しているpropsは `memo`, `onUpdate`, `onDelete` の3つのみ。

```tsx
// MemoPane.tsx L207-214 - 現状のMemoCard呼び出し
{memos.map((memo) => (
  <MemoCard
    key={memo.id}
    memo={memo}
    onUpdate={handleUpdateMemo}
    onDelete={handleDeleteMemo}
  />
))}
```

MemoCardPropsインタフェースに変更がないため、MemoPaneのコード修正は一切不要。コピー機能に必要な全ての状態（`copied`, `timerRef`）とロジック（`handleCopy`）はMemoCard内部で完結している。

#### 2.2 WorktreeDetailRefactored.tsx -> MemoPane -> MemoCard影響

**結論: 影響なし**

WorktreeDetailRefactoredはMemoCardを直接参照せず、MemoPaneを経由して利用する。

- Desktop: L1804-1809 (`leftPaneTab === 'memo'` 分岐でMemoPane描画)
- Mobile: L884-891 (`activeTab === 'memo'` 分岐でMobileContent経由MemoPane描画)

MemoPaneへのprops (`worktreeId`, `className`) に変更がないため、WorktreeDetailRefactoredへの間接影響もゼロ。

#### 2.3 clipboard-utils.ts

**結論: 影響なし**

既存の `copyToClipboard()` 関数をそのまま利用する。関数シグネチャ (`text: string`) => `Promise<void>`) に変更はない。空文字バリデーション（SF-S4-1）も既存機能として活用する。

### 3. Test Impact Analysis (テスト影響分析)

#### 3.1 MemoCard.test.tsx (既存テスト)

**結論: 影響なし**

既存テストの全クエリを精査した結果:

| Test Query | Pattern | Copy Button Match? |
|-----------|---------|-------------------|
| `getByRole('button', { name: /delete/i })` | aria-label="Delete memo" | No (`Copy memo content` は `/delete/i` にマッチしない) |
| `getByDisplayValue('Test Memo')` | input value | No (ボタンではない) |
| `getByTestId('memo-card')` | data-testid | No (カード全体) |
| `getByTestId('saving-indicator')` | data-testid | No (別要素) |

全ての既存テストは特定のaria-labelまたはdata-testidで要素を絞り込んでおり、コピーボタン追加による曖昧性の増加はない。

#### 3.2 MemoPane.test.tsx

**結論: 影響なし**

MemoPane.test.tsxの削除ボタン関連テスト (L215, L218, L233) は全て `getAllByRole('button', { name: /delete/i })` でフィルタリングしている。コピーボタンの `aria-label="Copy memo content"` は `/delete/i` パターンにマッチしないため、テスト結果に影響しない。

#### 3.3 clipboard-utils テスト

クリップボードユーティリティの専用テストファイルは現在存在しない（`tests/**/clipboard-utils*` 該当なし）。本変更は既存の `copyToClipboard()` 関数を呼び出すのみであり、新たなテスト追加の必要はない。

### 4. Bundle Size Impact (バンドルサイズ影響)

**結論: 無視可能**

| Factor | Assessment |
|--------|-----------|
| lucide-react パッケージ | 既存依存 (v0.554.0, package.json L59) |
| Copy アイコン | FileViewer.tsx (L27), MarkdownEditor.tsx (L35), ConversationPairCard.tsx (L11) で既にimport済み |
| Check アイコン | FileViewer.tsx (L27), MarkdownEditor.tsx (L35) で既にimport済み |
| tree-shaking | lucide-react対応済み。使用アイコン単位でバンドル |

MemoCardからの `import { Copy, Check } from 'lucide-react'` は、既に他のコンポーネントでバンドルに含まれているモジュールへの参照追加に過ぎず、実質的なバンドルサイズ増加はゼロである。

### 5. Performance Impact (パフォーマンス影響)

**結論: 無視可能**

追加されるReact hooks:

| Hook | Purpose | Cost |
|------|---------|------|
| `useState(copied)` | コピー状態管理 | boolean 1個のstate |
| `useRef(timerRef)` | タイマーID保持 | メモリ参照1個 |
| `useEffect(cleanup)` | アンマウント時タイマークリア | cleanup関数登録のみ |
| `useCallback(handleCopy)` | コピーハンドラ | 関数メモ化 |

MemoCardは `React.memo` でラップされており、propsが変わらない限り再レンダリングされない。コピー操作自体は `navigator.clipboard.writeText()` というブラウザネイティブAPIの呼び出しであり、マイクロ秒オーダーで完了する。

### 6. Breaking Changes (破壊的変更)

**結論: 破壊的変更なし**

| Category | Status |
|----------|--------|
| MemoCardProps interface | 変更なし |
| WorktreeMemo type | 変更なし |
| API endpoints | 追加・変更なし |
| Database schema | 変更なし |
| Export signatures | 変更なし |

---

## Risk Assessment

| Risk Category | Level | Description | Mitigation |
|--------------|-------|-------------|------------|
| Technical | Low | MemoCard内部の変更のみ。hooks追加は標準パターン | 設計書のテストケース7件で網羅的にカバー |
| Security | Low | copyToClipboard()の既存ANSI除去・バリデーションを利用。新たな攻撃面なし | clipboard-utils.tsの既存セキュリティ機構を活用 |
| Operational | Low | デプロイ手順の変更なし。DB移行なし | 通常のデプロイフローで対応可能 |

---

## Findings

### S3-001: モバイル狭幅端末でのヘッダー行レイアウト確認 [Nice to Have]

**Category**: mobile_ui_impact

MemoCardヘッダー行は `flex items-center gap-2` で [Title(flex-1)] [Saving...] [Copy] [Delete] の4要素を配置する。タイトル入力は `flex-1` で可変幅のため、Saving表示中でもボタン群は固定幅（p-1 + w-4 h-4 = 約24px x 2 + gap-2 x 3 = 約72px）に収まる。320px幅端末でもタイトル入力領域は約240px確保でき、実用上の問題はないと判断される。

**Recommendation**: 実装後にモバイル実機（320px幅）で、Saving表示中にタイトルが極端に短縮されないことを目視確認する。

### S3-002: 既存テストクエリへの間接影響 [Nice to Have]

**Category**: test_impact

既存のMemoCard.test.tsxでは `getByRole('button', { name: /delete/i })` で削除ボタンを特定しており、コピーボタン（`aria-label='Copy memo content'`）の追加によって影響を受けない。設計書Section 9の分析は正確である。

**Recommendation**: 実装後にMemoCard.test.tsxの全テストがパスすることを確認するだけで十分。追加対応不要。

### S3-003: FileViewer/MarkdownEditorとのクリーンアップ実装差分 [Nice to Have]

**Category**: future_consideration

MemoCardにはuseRef + useEffect cleanupによるsetTimeoutクリーンアップを追加するが、FileViewer.tsx (L66-74) およびMarkdownEditor.tsx (L321-325) には同様のクリーンアップが実装されていない。設計書Section 4の注記で明示されており、将来のS1-001カスタムフック抽出時に一括対応する方針は合理的である。

**Recommendation**: S1-001のフック抽出Issue作成時に、FileViewer/MarkdownEditorのクリーンアップ改善も含めることを推奨。

---

## Approval

| Criteria | Result |
|----------|--------|
| Must Fix items | 0 |
| Should Fix items | 0 |
| Nice to Have items | 3 |
| Breaking changes | None |
| Test regression risk | None |
| Bundle size impact | Negligible |
| Performance impact | Negligible |

**Verdict: APPROVED** - 影響範囲が極めて限定的であり、安全に実装を進行できる。

---

*Generated by architecture-review-agent for Issue #321 Stage 3*
*Date: 2026-02-20*
