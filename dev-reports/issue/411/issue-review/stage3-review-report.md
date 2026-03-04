# Issue #411 Stage 3 影響範囲レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3

## サマリー

影響範囲の分析の結果、7件の指摘を特定した。主な指摘は、Issueの影響範囲テーブルに未記載のコンポーネント（PromptPanel、MobilePromptSheet）の存在、テストファイルのmemo化後の互換性確認の具体化不足、leftPaneコンポーネント抽出方式でのprops数の多さによるリスクに関するものである。

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 3 |
| Nice to Have | 2 |

---

## Must Fix（必須対応）

### F3-001: PromptPanelが未memo化であり、影響範囲テーブルに記載がない

**カテゴリ**: scope
**場所**: 影響範囲テーブル（6行のみ記載）

**問題**:
`PromptPanel`（`/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/worktree/PromptPanel.tsx` L376）は `export function PromptPanel` として定義されておりReact.memoでラップされていない。WorktreeDetailRefactored内でデスクトップレイアウト（L2035-2043）から描画され、ターミナルポーリング（2秒間隔）のたびにWorktreeDetailRefactoredが再レンダーされると、PromptPanelも再レンダーされる。

FileViewerと同様のパターンで、visible=false時のearly returnがあるが、関数コンポーネント自体の評価コスト（props比較なし）は発生する。Issueの影響範囲テーブルには記載がない。

**証拠**:
- `PromptPanel.tsx` L376: `export function PromptPanel({`（memoなし）
- `WorktreeDetailRefactored.tsx` L2035-2043: デスクトップでのPromptPanel描画
- FileViewerと同等のパターン（非表示時にも親の再レンダーで評価される）

**推奨対応**:
影響範囲テーブルに `src/components/worktree/PromptPanel.tsx` を追加し、memoラップの実装タスクを追記する。PromptPanelは条件付き描画（visible && promptData）であるため効果は限定的だが、FileViewer（isOpen=false時のスキップ）と同様のパターンであり、一貫性の観点からもmemo化が望ましい。

---

### F3-002: WorktreeDetailRefactored.test.tsxのモック定義がmemo化後に不整合を起こすリスク

**カテゴリ**: test
**場所**: 実装タスクの「既存テストの動作確認」項目

**問題**:
`/Users/maenokota/share/work/github_kewton/commandmate-issue-411/tests/unit/components/WorktreeDetailRefactored.test.tsx`（L72-190）では、MessageInput、FileViewer、SlashCommandSelector等の子コンポーネントをvi.mockでモック化している。現在のモックは `export function` 形式を前提としている。

React.memoでラップされた場合、名前付きexportの型が `React.MemoExoticComponent<...>` に変わる。vi.mockは通常これを透過するが、テスト内でコンポーネント型を直接参照している箇所がある。

特に `MessageInput.test.tsx` では、`import { MessageInput } from '@/components/worktree/MessageInput'` を直接renderしており、memo化後もexport名が維持される設計を確認する必要がある。

**証拠**:
- `WorktreeDetailRefactored.test.tsx` L182-190: `vi.mock('@/components/worktree/FileViewer', ...)`
- `MessageInput.test.tsx` L13: `import { MessageInput } from '@/components/worktree/MessageInput'`
- `SlashCommandSelector.test.tsx` L9: `import { SlashCommandSelector } from '@/components/worktree/SlashCommandSelector'`

**推奨対応**:
実装タスクの「既存テストの動作確認」を以下のように具体化する：
1. `WorktreeDetailRefactored.test.tsx` - モック定義がmemo化コンポーネントを正しくモック化できることを確認
2. `MessageInput.test.tsx` - memo化後のコンポーネントが直接renderでテスト可能であることを確認
3. `SlashCommandSelector.test.tsx` / `MarkdownEditor.test.tsx` - 同上

memo化時には named export 形式（`export const MessageInput = memo(function MessageInput(...))` ）を採用し、exportシグネチャの互換性を維持する設計方針を明記する。

---

## Should Fix（推奨対応）

### F3-003: MobilePromptSheetが未memo化であり、モバイル環境でのポーリング影響が未評価

**カテゴリ**: scope
**場所**: 影響範囲テーブル（モバイルコンポーネントの記載なし）

**問題**:
`MobilePromptSheet`（`/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/mobile/MobilePromptSheet.tsx` L57）は `export function` として定義されmemo化されていない。WorktreeDetailRefactoredのモバイルレイアウト（L2282-2290）で描画される。

MobileHeader/MobileTabBarは既にmemo化済みだが、MobilePromptSheetはmemo化されていない。モバイルではCPU/メモリリソースがデスクトップより限られるため、ポーリング起因の不要な再レンダーの影響がより大きい。

**推奨対応**:
影響範囲テーブルに `src/components/mobile/MobilePromptSheet.tsx` を追加する。優先度はMessageInput/FileViewerより低いが、モバイル環境での一貫性のために含めることを推奨する。

---

### F3-004: MessageInputのuseCallback化後、IME関連テストの動作確認に特別な注意が必要

**カテゴリ**: test
**場所**: 実装タスクのMessageInput項目「handleCompositionEndのsetTimeout内ref更新パターン」注意点

**問題**:
`/Users/maenokota/share/work/github_kewton/commandmate-issue-411/tests/unit/components/worktree/MessageInput.test.tsx`（L179-282）にはIME composition関連のテストが5ケース含まれ、handleCompositionStart/handleCompositionEndの内部動作（compositionTimeoutRef、justFinishedComposingRef）に依存している。

特に「should allow submit after composition timeout expires」テストケース（L254-282）は `vi.useFakeTimers` でsetTimeoutの300ms遅延をテストしており、useCallback化でクロージャのキャプチャタイミングが変わった場合に影響を受ける可能性がある。

**推奨対応**:
Issueの実装タスクにIME関連テストの具体的な安全性根拠を追記する：
- handleCompositionEndのuseCallback化時、setTimeoutコールバック内の `justFinishedComposingRef.current` アクセスはref経由のためクロージャ問題なし
- handleCompositionStartのuseCallback化時、`compositionTimeoutRef.current` のclearTimeoutも同様にref経由で問題なし
- ただし `isComposing` (state)をuseCallbackの依存配列に含める必要がある（submitMessage関数が参照するため）

---

### F3-005: leftPaneのコンポーネント抽出方式でのprops drilling量が過大（推定20個超）

**カテゴリ**: risk
**場所**: 提案する解決策セクション - 3. inline JSX抽出 - leftPane部分

**問題**:
Issueでは「leftPaneはタブ切り替えにより描画内容が変わるためコンポーネント抽出方式を検討」と記載されている。しかしleftPane（L1935-1998）にはhistory/files/memoの3タブ分のpropsが必要で、既存の`MobileContent`コンポーネント（L824-941）が類似パターンを示している。MobileContentは29個のpropsを受け取っている。

leftPaneのコンポーネント抽出でも同様のprops数が予想される。特に `fileSearch` オブジェクト（useFileSearchの戻り値）は毎レンダーで新オブジェクトが生成される可能性があり、memo化の shallow comparison を無効化するリスクがある。

**推奨対応**:
leftPaneのコンポーネント抽出方式を採用する場合、以下のリスクを明記する：
1. props数が20個超になる見込みでshallow comparison負荷が増す
2. fileSearchオブジェクトの参照安定性確保のためuseMemoラップまたは個別プロパティ展開が必要
3. 代替案として **useMemo方式の方が依存配列の明示管理でオーバーヘッドを制御しやすい** 可能性がある

MobileContentのpropsパターンを参考に設計すること。

---

## Nice to Have（あれば良い）

### F3-006: handleAutoYesToggleのactiveCliTab依存がmemo化効果を間接的に阻害する可能性

**カテゴリ**: performance
**場所**: 実装タスク全般

**問題**:
`handleAutoYesToggle`（L1293-1314）は `activeCliTab` を依存配列に含んでいる。activeCliTabが変わるたびにhandleAutoYesToggleの参照が変わる。現在のコードではMessageInputへのprops（handleMessageSent）に直接影響しないが、将来の変更でactiveCliTab依存が追加された場合にmemo化が無効化されるリスクがある。

**推奨対応**:
本Issueのスコープ外として将来タスクに記載する程度で良い。handleAutoYesToggleでactiveCliTabをref経由で参照するパターンへの変更は、auto-yes機能の振る舞いに影響するため慎重な検討が必要。

---

### F3-007: SlashCommandListの連鎖memo化検討

**カテゴリ**: scope
**場所**: 影響範囲テーブル - SlashCommandSelector行

**問題**:
`SlashCommandSelector.tsx` 内で `SlashCommandList` をインポートして描画している。SlashCommandSelectorをmemo化する場合、SlashCommandListも含めた連鎖的な再レンダー防止が有効。ただしSlashCommandSelectorは `isOpen=false` でearly returnする可能性が高く、selectorが閉じている時の再レンダーコストは低い。

**推奨対応**:
SlashCommandListがmemo化されているか確認し、必要であれば影響範囲テーブルに追記する。ただし実質的な影響は軽微であるため、優先度は最低で良い。

---

## 参照ファイル

### 影響を受けるコード

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/worktree/PromptPanel.tsx` | F3-001: 未memo化、影響範囲テーブルへの追加が必要 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/mobile/MobilePromptSheet.tsx` | F3-003: 未memo化、モバイル環境への影響 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/worktree/SlashCommandSelector.tsx` | F3-007: 連鎖memo化の検討対象 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/worktree/WorktreeDetailRefactored.tsx` | F3-005: leftPaneのprops drilling量が過大 |

### 影響を受けるテスト

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/tests/unit/components/WorktreeDetailRefactored.test.tsx` | F3-002: モック定義のmemo化後互換性 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/tests/unit/components/worktree/MessageInput.test.tsx` | F3-002, F3-004: memo化後のrender互換性、IME関連テスト |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/tests/unit/components/SlashCommandSelector.test.tsx` | F3-002: memo化後のrender互換性 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/tests/unit/components/MarkdownEditor.test.tsx` | F3-002: memo化後のrender互換性 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/tests/helpers/message-input-test-utils.ts` | F3-004: テストヘルパーへの影響なし（UIインタラクションベースのため） |

### 既にmemo化済みのコンポーネント（変更不要）

以下のコンポーネントは既にmemo化されており、本Issueの影響を受けない：

| ファイル | memo化状況 |
|---------|-----------|
| `src/components/worktree/HistoryPane.tsx` | memo済み (L144) |
| `src/components/worktree/TerminalDisplay.tsx` | memo済み (L66) |
| `src/components/worktree/SearchBar.tsx` | memo済み (L114) |
| `src/components/worktree/FileTreeView.tsx` | memo済み (L526) |
| `src/components/worktree/LeftPaneTabSwitcher.tsx` | memo済み (L122) |
| `src/components/worktree/NotesAndLogsPane.tsx` | memo済み (L72) |
| `src/components/worktree/AutoYesToggle.tsx` | memo済み (L42) |
| `src/components/worktree/WorktreeDesktopLayout.tsx` | memo済み (L11のimport) |
| `src/components/mobile/MobileHeader.tsx` | memo済み (L12のimport, L51のIcon) |
| `src/components/mobile/MobileTabBar.tsx` | memo済み (L9のimport, L53のIcon) |

### SSR/RSC影響

全対象コンポーネントは `'use client'` ディレクティブを持つClient Componentsであり、Server Components環境への影響はない。React.memoはクライアントサイドのみで動作するため、SSRパスでの影響も発生しない。

### forwardRef関連

対象コンポーネント群にはforwardRefの使用箇所がないため、React.memo + forwardRefの組み合わせによる型エクスポート変更のリスクは存在しない。

### 破壊的変更

本Issueの変更は全て内部最適化（React.memoラップ、useCallback化）であり、外部APIやpropsインターフェースへの破壊的変更は発生しない。ただしmemo化後はpropsの参照等価性に依存するため、将来の変更でインラインオブジェクト/関数をpropsとして渡すコードが追加された場合、memo化の効果が無効化される点に注意が必要。
