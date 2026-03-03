# Architecture Review Report: Issue #411 - Stage 2 整合性レビュー

## Executive Summary

| 項目 | 内容 |
|------|------|
| **Issue** | #411 - Reactコンポーネントのmemo化・useCallback最適化 |
| **Stage** | Stage 2: 整合性レビュー |
| **日付** | 2026-03-03 |
| **ステータス** | conditionally_approved |
| **スコア** | 4/5 |
| **指摘数** | must_fix: 0, should_fix: 4, nice_to_have: 4 (合計: 8) |

設計方針書はコンポーネントのProps定義、memo化パターン、実装順序について実コードとの高い整合性を維持している。全8コンポーネントのProps定義は実装と完全一致しており、D1パターン(memo化形式)、D2パターン(useCallback適用)、D3パターン(rightPane useMemo)の設計も正確である。

ただし、依存配列の安定性根拠テーブル(Section D4)で複数のハンドラの依存配列記述が実コードと不一致であり、特にfetchCurrentOutputの`state.prompt.visible`依存とhandleDeleteの`editorFilePath`依存が設計書で言及されていない点は修正が必要。

---

## Detailed Findings

### R2-001 [should_fix] fetchCurrentOutputの依存配列にstate.prompt.visibleが含まれることが設計書に未記載

**カテゴリ**: consistency

**場所**: 設計方針書 Section 4.1 [R1-008] テーブル: fetchCurrentOutput行

**説明**:

設計方針書Section 4.1 [R1-008]のテーブルでは、fetchCurrentOutputの依存配列を`[worktreeId, actions]`と記述している。

しかし、実際のコード(`/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/worktree/WorktreeDetailRefactored.tsx` L1122)では:

```typescript
}, [worktreeId, actions, state.prompt.visible]);
```

`state.prompt.visible`はプロンプト表示/非表示時に変化するため、fetchCurrentOutputの参照が変わり、それに依存する`handleMessageSent`(L1289: `[fetchMessages, fetchCurrentOutput]`)も再生成される。これによりMessageInputの`onMessageSent` propsが変化し、プロンプト表示/非表示遷移時にmemo化が一時的に無効化される。

プロンプト遷移はユーザー操作起点であり2秒ポーリング起因ではないため、最適化の主目的(ポーリング時の不要レンダー防止)には影響しない。しかし設計書の正確性として記載すべき。

**改善提案**: fetchCurrentOutputの依存配列を`[worktreeId, actions, state.prompt.visible]`に修正し、カスケード影響を安定性根拠テーブルに追記する。

---

### R2-002 [should_fix] D4テーブルのhandleDeleteが安定参照と記載されているがeditorFilePathに依存

**カテゴリ**: consistency

**場所**: 設計方針書 Section D4 依存配列安定性根拠テーブル: handleDelete行

**説明**:

設計方針書ではhandleDeleteを「useCallback | stable dependencies only」と記載しているが、実際のコード(L1460)では:

```typescript
}, [worktreeId, editorFilePath, tCommon, tError]);
```

`editorFilePath`はMarkdownEditorの開閉に伴い`null <-> string`で変化するstate値であり、エディタ操作のたびにhandleDeleteの参照が変わる。これによりleftPaneMemoのuseMemoが再計算される。

ポーリングサイクルでは`editorFilePath`は変化しないため、主目的の最適化効果は維持される。

**改善提案**: handleDeleteの安定性種別を「useCallback (editorFilePath依存)」に変更し、エディタ開閉時の再計算は意図された動作として注記する。

---

### R2-003 [should_fix] D4テーブルのhandleLeftPaneTabChangeが空依存配列と記載されているが実際は[actions]

**カテゴリ**: consistency

**場所**: 設計方針書 Section D4 依存配列安定性根拠テーブル: handleLeftPaneTabChange行

**説明**:

設計方針書ではhandleLeftPaneTabChangeを「useCallback | 空依存配列(安定)」と記載しているが、実コード(L1210-1214)では:

```typescript
const handleLeftPaneTabChange = useCallback(
    (tab: LeftPaneTab) => {
      actions.setLeftPaneTab(tab);
    },
    [actions]
  );
```

`actions`はuseReducerのdispatchでReactが安定参照を保証するため動作上は安定だが、設計書の記述が実装と不一致。

**改善提案**: 依存配列の記述を`[actions]`に修正し、安定性根拠を「useReducer dispatchはReact保証により安定参照」と記載する。

---

### R2-007 [should_fix] MobilePromptSheetのmount条件が設計書Section 4.5と実装で不一致

**カテゴリ**: consistency

**場所**: 設計方針書 Section 4.5 備考欄

**説明**:

設計方針書Section 4.5では「visibleに関係なくマウントされるため、visible=false時のprops不変スキップ効果あり」と記載しているが、実際のコード(L2281-2289)では:

```tsx
{!autoYesEnabled && (
  <MobilePromptSheet
    promptData={state.prompt.data}
    visible={state.prompt.visible}
    answering={state.prompt.answering}
    onRespond={handlePromptRespond}
    onDismiss={handlePromptDismiss}
    cliToolName={getCliToolDisplayName(activeCliTab)}
  />
)}
```

`autoYesEnabled=true`時はMobilePromptSheetは完全にアンマウントされる。R1-005のnice_to_have記録で一部言及されているが、Section 4.5の本文記述自体が不正確なまま残っている。

**改善提案**: Section 4.5の備考を「autoYesEnabled=false時にマウントされ、visible=false時のprops不変スキップ効果がある。autoYesEnabled=true時は完全にアンマウントされるためmemo化効果はない」に修正する。

---

### R2-004 [nice_to_have] FileViewerのisOpen propsの表記が実装と微妙に異なる

**カテゴリ**: correctness

**場所**: 設計方針書 Section 4.7 [R1-004] テーブル: isOpen行

**説明**: 設計書では`!!fileViewerPath`、実装では`fileViewerPath !== null`。動作は同等だが正確性のため一致させるべき。

---

### R2-005 [nice_to_have] D4テーブルの複数ハンドラの依存配列が実際より簡略化されている

**カテゴリ**: consistency

**場所**: 設計方針書 Section D4 テーブル: handleNewFile, handleNewDirectory, handleRename, handleCmateSetup

**説明**: 各ハンドラの実際の依存配列:
- handleNewFile: `[worktreeId, tError]`
- handleNewDirectory: `[worktreeId, tError]`
- handleRename: `[worktreeId, tError]`
- handleCmateSetup: `[worktreeId, showToast, tSchedule]`

全て安定参照であるため結論は正しいが、根拠の詳細を記載する方が正確。

---

### R2-006 [nice_to_have] disableAutoFollowのuseMemo依存配列における安定性注記の不足

**カテゴリ**: completeness

**場所**: 設計方針書 Section D3 (rightPaneMemo)

**説明**: rightPaneMemoの依存配列6項目について、ポーリング起点で変化する項目(state.terminal.*)とユーザー操作起点で変化する項目(handleAutoScrollChange, disableAutoFollow)の区別が明示されていない。

---

### R2-008 [nice_to_have] 実装チェックリスト(Section 13)にD4テーブル修正反映の検証項目がない

**カテゴリ**: completeness

**場所**: 設計方針書 Section 13 実装チェックリスト

**改善提案**: チェックリストに以下を追加:
- `[ ] [R2-002/R2-003] D4テーブルの全依存配列エントリが実装コードのuseCallback依存配列と一致していることを確認`

---

## 整合性マトリクス

| 設計セクション | 設計書の記載 | 実装状況 | 一致 |
|--------------|------------|---------|------|
| Section 4.1 MessageInput Props | worktreeId, onMessageSent?, cliToolId?, isSessionRunning? | MessageInputProps: 4 props完全一致 | OK |
| Section 4.1 ハンドラ数 | 9個のハンドラuseCallback化 | 9個のハンドラ確認 | OK |
| Section 4.2 SlashCommandSelector Props | isOpen, groups, onSelect, onClose, isMobile?, position?, onFreeInput? | SlashCommandSelectorProps: 7 props完全一致 | OK |
| Section 4.3 InterruptButton Props | worktreeId, cliToolId, disabled?, onInterrupt? | InterruptButtonProps: 4 props完全一致 | OK |
| Section 4.4 PromptPanel Props | promptData, messageId, visible, answering, onRespond, onDismiss?, cliToolName? | PromptPanelProps: 7 props完全一致 | OK |
| Section 4.5 MobilePromptSheet Props | promptData, visible, answering, onRespond, onDismiss?, cliToolName? | MobilePromptSheetProps: 6 props完全一致 | OK |
| Section 4.6 MarkdownEditor Props | worktreeId, filePath, onClose?, onSave?, initialViewMode?, onMaximizedChange? | EditorProps: 6 props完全一致 | OK |
| Section 4.7 FileViewer Props | isOpen, onClose, worktreeId, filePath | FileViewerProps: 4 props完全一致 | OK |
| Section D3 rightPane | TerminalDisplay 6 props | 6 props完全一致 | OK |
| Section D4 leftPane依存配列27項目 | 全項目がinline JSXで参照 | ハンドラ安定性記述に一部不正確あり | NG |
| Section [R1-008] fetchCurrentOutput | [worktreeId, actions] | [worktreeId, actions, state.prompt.visible] | NG |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 依存配列の不正確な記述による実装時の混乱 | Low | Medium | P2 |
| セキュリティ | なし (パフォーマンス最適化のみ) | - | - | - |
| 運用リスク | なし | - | - | - |

技術的リスクは低い。設計書の依存配列記述が実装と異なる箇所があるが、全て動作上の結論(安定性)は正しく、ポーリングサイクルでのmemo化効果は設計通りに機能する。主な差異はプロンプト遷移やエディタ開閉といったユーザー操作起点のイベントに限定される。

---

## Improvement Recommendations

### 推奨改善項目 (Should Fix) - 4件

1. **R2-001**: fetchCurrentOutputの依存配列を設計書で正確に記載し、state.prompt.visible変化時のカスケード影響を明示
2. **R2-002**: handleDeleteのeditorFilePath依存を安定性テーブルに反映
3. **R2-003**: handleLeftPaneTabChangeの依存配列を[actions]に修正
4. **R2-007**: MobilePromptSheetのmount条件記述を実装に合わせて修正

### 検討事項 (Consider) - 4件

5. **R2-004**: FileViewerのisOpen表記を実装に一致させる
6. **R2-005**: 各ハンドラの実際の依存配列を詳細に記載
7. **R2-006**: rightPaneMemo依存配列の変化トリガー区分注記
8. **R2-008**: チェックリストにD4テーブル検証項目を追加

---

## Approval Status

**conditionally_approved** -- should_fix 4件の修正を条件として承認。全てのshould_fix項目は設計書の記述修正であり、コード変更は不要。設計書のProps定義、コンポーネント構造、設計パターン(D1/D2/D3)は実装と高い整合性を持ち、memo化最適化の主目的(2秒ポーリングによる不要再レンダー防止)は正しく設計されている。

---

## Reviewed Files

| ファイル | 確認内容 |
|---------|---------|
| `dev-reports/design/issue-411-react-memo-optimization-design-policy.md` | 設計方針書全体 |
| `src/components/worktree/MessageInput.tsx` | Props, ハンドラ定義, export形式 |
| `src/components/worktree/SlashCommandSelector.tsx` | Props, 既存useCallback/useMemo |
| `src/components/worktree/InterruptButton.tsx` | Props, handleInterrupt useCallback |
| `src/components/worktree/PromptPanel.tsx` | Props, 内部コンポーネント構成 |
| `src/components/mobile/MobilePromptSheet.tsx` | Props, mount条件 |
| `src/components/worktree/FileViewer.tsx` | Props, 内部hooks |
| `src/components/worktree/MarkdownEditor.tsx` | Props (EditorProps型) |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | ハンドラ定義, 依存配列, inline JSX, FileViewer/MobilePromptSheet使用箇所 |
| `src/hooks/useFileSearch.ts` | 戻り値構造, useCallback使用状況 |
| `src/components/common/Toast.tsx` | showToastのuseCallback安定性 |
| `src/types/markdown-editor.ts` | EditorProps interface定義 |
