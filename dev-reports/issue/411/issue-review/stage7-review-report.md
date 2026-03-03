# Issue #411 Stage 7 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 1 |

Stage 3の影響範囲指摘5件は全て適切に反映されている。更新後のIssueは影響範囲の記載が十分に網羅的であり、重大な見落としは検出されなかった。新規指摘2件はテストチェックリストの補完と既存問題の注記に関するものであり、いずれも軽微である。

---

## 前回指摘の反映状況

### F3-001: PromptPanelが影響範囲テーブルに未記載 -> **resolved**

影響範囲テーブルにPromptPanel.tsxが「memo（プロンプト表示中のポーリング起因再レンダースキップ）」として追加されている。Stage 5（F5-002）でデスクトップパスでは`state.prompt.visible && !autoYesEnabled`による条件付きレンダーでvisible=false時にアンマウントされる旨が正確に記載された。

実コード確認:
- `src/components/worktree/WorktreeDetailRefactored.tsx` L2032: `{state.prompt.visible && !autoYesEnabled && (` の条件付き描画を確認
- `src/components/worktree/PromptPanel.tsx` L376: `export function PromptPanel` （現状memo未適用）を確認

### F3-002: テストモック整合性リスク -> **resolved**

「既存テスト動作確認の詳細」セクションに4つの具体的テストファイルが列挙され、named export形式の設計方針が明記されている。

実コード確認:
- `tests/unit/components/WorktreeDetailRefactored.test.tsx` L101-108: PromptPanelのvi.mock定義を確認（`{ PromptPanel: ... }` 形式）
- `tests/unit/components/WorktreeDetailRefactored.test.tsx` L133-140: MobilePromptSheetのvi.mock定義を確認
- `tests/unit/components/WorktreeDetailRefactored.test.tsx` L182-190: FileViewerのvi.mock定義を確認

### F3-003: MobilePromptSheetが未記載 -> **resolved**

影響範囲テーブルにMobilePromptSheet.tsxが追加されている。

実コード確認:
- `src/components/worktree/WorktreeDetailRefactored.tsx` L2281-2290: MobilePromptSheetは`{!autoYesEnabled && (`で条件付き描画。autoYesEnabled=false（デフォルト）時はvisible値に関係なく常にマウントされる
- `src/components/mobile/MobilePromptSheet.tsx` L57: `export function MobilePromptSheet` （現状memo未適用）を確認

### F3-004: IME関連テストの動作確認リスク -> **resolved**

F5-001でIME関連useCallback注記が修正された。setIsComposingはuseStateセッター（安定参照）であるため依存配列は空配列`[]`で十分という分析は正確。

### F3-005: leftPaneのprops drilling量リスク -> **resolved**

「提案する解決策」セクションにリスク注記が追加されている。props数20個超、fileSearchの参照安定性リスク、MobileContentの29propsパターン参照が含まれている。

---

## handlePromptRespond/handlePromptDismissのuseCallback確認

コード実態を確認した結果:

**handlePromptRespond** (`src/components/worktree/WorktreeDetailRefactored.tsx` L1233-1259):
- `useCallback`でラップ済み
- 依存配列: `[worktreeId, actions, fetchCurrentOutput, activeCliTab, state.prompt.data]`
- `state.prompt.data`への依存があるため、プロンプトデータが変更されるたびに参照が変わる
- ただし、promptDataプロップ自体も同時に変わるため、memo化コンポーネント側ではどちらにしても再レンダーが必要であり、実質的な問題はない

**handlePromptDismiss** (`src/components/worktree/WorktreeDetailRefactored.tsx` L1262-1264):
- `useCallback`でラップ済み
- 依存配列: `[actions]`
- actionsはuseReducer由来で安定参照のため、事実上参照が変わらない

Issueの「実装前にonRespond（handlePromptRespond）/onDismiss（handlePromptDismiss）が呼び出し元でuseCallbackにより安定化されていることを確認すること」という記載は正確である。

---

## WorktreeDetailRefactored全コンポーネント描画パス確認

### デスクトップパス（isMobile=false時）

| コンポーネント | 行 | 条件 | memo済み | Issue対象 |
|--------------|-----|------|---------|----------|
| BranchMismatchAlert | L1927-1931 | worktree?.gitStatus | 未確認 | No |
| WorktreeDesktopLayout | L1934 | 常時 | 未確認 | No |
| LeftPaneTabSwitcher | L1937-1940 | 常時（leftPane内） | 未確認 | No |
| HistoryPane | L1943-1949 | leftPaneTab=history | 未確認 | No |
| SearchBar | L1955-1963 | leftPaneTab=files | 未確認 | No |
| FileTreeView | L1964-1979 | leftPaneTab=files | 未確認 | No |
| NotesAndLogsPane | L1985-1994 | leftPaneTab=memo | 未確認 | No |
| TerminalDisplay | L2001-2008 | 常時（rightPane内） | 未確認 | No |
| **MessageInput** | L2016-2021 | 常時 | **未memo** | **Yes** |
| AutoYesToggle | L2024-2030 | 常時 | 未確認 | No |
| **PromptPanel** | L2034-2042 | visible && !autoYesEnabled | **未memo** | **Yes** |
| InfoModal | L2046-2052 | 常時 | **memo済** | No |
| **FileViewer** | L2054-2059 | 常時 | **未memo** | **Yes** |
| **MarkdownEditor** | L2070-2076 | editorFilePath存在時 | **未memo** | **Yes** |

### モバイルパス（isMobile=true時）

| コンポーネント | 行 | 条件 | memo済み | Issue対象 |
|--------------|-----|------|---------|----------|
| MobileHeader | L2131 | 常時 | memo済 | No |
| BranchMismatchAlert | L2153-2157 | gitStatus && isBranchMismatch | 未確認 | No |
| AutoYesToggle | L2164-2171 | 常時 | 未確認 | No |
| MobileContent | L2227-2257 | 常時 | **memo済** | No (ただしfileSearch問題あり) |
| **MessageInput** | L2265-2270 | 常時 | **未memo** | **Yes** |
| MobileTabBar | L2273-2279 | 常時 | 未確認 | No |
| **MobilePromptSheet** | L2282-2289 | !autoYesEnabled | **未memo** | **Yes** |
| **FileViewer** | L2293-2298 | 常時 | **未memo** | **Yes** |
| **MarkdownEditor** | L2306-2312 | editorFilePath存在時 | **未memo** | **Yes** |

Issueの影響範囲テーブルに記載された全8コンポーネントは上記パスに全て含まれており、漏れはない。

---

## Should Fix（推奨対応）

### F7-001: PromptPanel.test.tsxとMobilePromptSheet.test.tsxがテスト動作確認チェックリストに未記載

**カテゴリ**: test
**場所**: 実装タスクの「既存テスト動作確認の詳細」セクション

**問題**:
テスト動作確認チェックリストにはWorktreeDetailRefactored.test.tsx、MessageInput.test.tsx、SlashCommandSelector.test.tsx、MarkdownEditor.test.tsxの4ファイルが記載されているが、PromptPanelとMobilePromptSheetのmemo化が実装タスクに含まれているにもかかわらず、以下のテストファイルが記載されていない:

- `tests/unit/components/PromptPanel.test.tsx` - `import { PromptPanel } from '@/components/worktree/PromptPanel'` を直接importしてrender
- `tests/unit/components/mobile/MobilePromptSheet.test.tsx` - `import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet'` を直接importしてrender

なお、InterruptButtonについては対応するテストファイルが存在しないため、チェックリスト追加は不要。

**推奨対応**:
テスト動作確認チェックリストに以下2行を追加する:
- `tests/unit/components/PromptPanel.test.tsx` - memo化後のrender確認
- `tests/unit/components/mobile/MobilePromptSheet.test.tsx` - memo化後のrender確認

---

## Nice to Have（あれば良い）

### F7-002: MobileContentのmemo無効化問題に関する注記追加

**カテゴリ**: scope
**場所**: 提案する解決策セクション - 3. inline JSX抽出 - leftPaneコンポーネント抽出時のリスク注記

**問題**:
`src/components/worktree/WorktreeDetailRefactored.tsx` L824で定義されたMobileContentは既にmemo()でラップされているが、`fileSearch` prop（`src/hooks/useFileSearch.ts` L243-254でuseMemoラップなしの新規オブジェクトとして返される）のために、shallow comparisonが常に新しい参照を検出し、memoが事実上無効化されている。

これはIssue #411のスコープ外の既存問題だが、leftPaneメモ化の設計判断に直接影響する前例として認知すべきである。

**推奨対応**:
リスク注記に以下を補足する：「MobileContent（L824、memo化済み）も同じfileSearchオブジェクトをpropとして受け取っており、同一の参照安定性問題でmemoが無効化されている。useFileSearchの戻り値をuseMemoでラップする修正はMobileContentとleftPaneの両方に効果がある」

---

## 参照ファイル

### コード
- `src/components/worktree/WorktreeDetailRefactored.tsx`: 主要変更対象（全描画パス確認済み）
- `src/components/worktree/PromptPanel.tsx`: memo化対象（L376: export function形式）
- `src/components/mobile/MobilePromptSheet.tsx`: memo化対象（L57: export function形式）
- `src/components/worktree/MessageInput.tsx`: memo化対象（L32: export function形式）
- `src/components/worktree/FileViewer.tsx`: memo化対象
- `src/components/worktree/MarkdownEditor.tsx`: memo化対象
- `src/hooks/useFileSearch.ts`: fileSearch参照安定性問題の根源（L243-254: useMemoなし）

### テスト
- `tests/unit/components/WorktreeDetailRefactored.test.tsx`: モック定義確認済み（PromptPanel L101, MobilePromptSheet L133, FileViewer L182）
- `tests/unit/components/PromptPanel.test.tsx`: チェックリスト追加推奨
- `tests/unit/components/mobile/MobilePromptSheet.test.tsx`: チェックリスト追加推奨
- `tests/unit/components/worktree/MessageInput.test.tsx`: チェックリスト記載済み
- `tests/unit/components/SlashCommandSelector.test.tsx`: チェックリスト記載済み
- `tests/unit/components/MarkdownEditor.test.tsx`: チェックリスト記載済み
