# Issue #411 レビューレポート - Stage 5

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（2回目）
**イテレーション**: Stage 5（1回目通常レビューの指摘反映確認 + 残存問題の特定）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 2 |
| Nice to Have | 1 |
| **合計** | **4** |

Stage 1（通常レビュー1回目）の指摘 6件（Must Fix 2件 + Should Fix 4件）は全て解決済み。Stage 3（影響範囲レビュー1回目）の指摘も適切に反映されている。Issue全体の記述品質は大幅に向上した。ただし、反映時に導入された新たな技術的不正確さが1件（Must Fix）確認された。

---

## 前回指摘の反映状況

| ID | 重要度 | ステータス | 概要 |
|----|--------|-----------|------|
| F1-001 | must_fix | **解決済** | 受入条件を具体的シナリオ+手動確認に改善 |
| F1-002 | must_fix | **解決済** | useCallbackハンドラ別効果分類を追記（ただし新規不正確さあり） |
| F1-003 | should_fix | **解決済** | MarkdownEditorの効果限定注記を追加 |
| F1-004 | should_fix | **解決済** | useMemo vs コンポーネント抽出の設計方針を明確化 |
| F1-005 | should_fix | **解決済** | SlashCommandSelector/InterruptButtonを影響範囲に追加 |
| F1-006 | should_fix | **解決済** | FileViewerのカスタム比較関数不要の旨に修正 |

---

## Must Fix（必須対応）

### F5-001: IME関連useCallback注記のisComposing依存配列に関する記述が技術的に不正確

**カテゴリ**: correctness
**場所**: 実装タスクセクション - IME関連useCallback注記

**問題**:

Issue本文の「IME関連useCallback注記」に以下の記述がある:

> ただし`isComposing`をstateとしてuseCallbackの依存配列に含める必要がある（setIsComposing呼び出しのため）

この記述は技術的に不正確である。Reactの`useState`が返すセッター関数（`setIsComposing`）は安定した参照であり、useCallbackの依存配列に含める必要がない。

**根拠**:

`src/components/worktree/MessageInput.tsx` L95-120を確認すると:

```typescript
const handleCompositionStart = () => {
  setIsComposing(true);           // setterのみ呼び出し
  justFinishedComposingRef.current = false;  // ref経由
  if (compositionTimeoutRef.current) {       // ref経由
    clearTimeout(compositionTimeoutRef.current);
  }
};

const handleCompositionEnd = () => {
  setIsComposing(false);          // setterのみ呼び出し
  justFinishedComposingRef.current = true;   // ref経由
  // ...timeout処理もref経由
};
```

両関数とも`isComposing`のstate値を**読み取っていない**。`setIsComposing`は安定参照であり、`compositionTimeoutRef`/`justFinishedComposingRef`はref経由のため、依存配列は空配列`[]`で十分である。

**影響**: この誤った記述に従って実装すると、`isComposing`が変化するたびにuseCallbackが再生成され、ハンドラの安定性が不必要に低下する。

**推奨対応**:

該当記述を以下に修正:

> handleCompositionStart/handleCompositionEndの依存配列は空配列`[]`で十分である（setIsComposingはuseStateのセッターであり安定参照、compositionTimeoutRef/justFinishedComposingRefはref経由のため依存不要）

---

## Should Fix（推奨対応）

### F5-002: PromptPanelのmemo化根拠「visible=false時のearly returnあり」がデスクトップ描画パスでは不正確

**カテゴリ**: correctness
**場所**: 実装タスクセクション - PromptPanel

**問題**:

Issue本文に以下の記述がある:

> PromptPanel: memo() ラップ（visible=false時のearly returnあり、FileViewerのisOpen=falseスキップと同パターン。ポーリング起因の再レンダー一貫防止）

しかし、`WorktreeDetailRefactored.tsx` L2032のデスクトップ描画パスでは:

```tsx
{state.prompt.visible && !autoYesEnabled && (
  <div className="fixed ...">
    <PromptPanel ... />
  </div>
)}
```

`state.prompt.visible`がfalseの場合、PromptPanelはそもそもマウントされない。よって「visible=false時のearly returnあり」というmemo化根拠はデスクトップパスでは不正確であり、FileViewerの`isOpen=false`パターン（FileViewerは常にマウントされ、isOpen=falseでも再レンダーが発生する）とは異なる。

一方、MobilePromptSheet（L2281）は`{!autoYesEnabled && (<MobilePromptSheet visible={...} />)}`であり、visibleに関係なく常にマウントされるため、そちらは「visible=false時スキップ」パターンが正しく適用される。

**推奨対応**:

PromptPanelの実装タスク説明を修正し、デスクトップパスでは条件付きレンダーによりvisible=false時はアンマウントされる旨を明記する。memo化の実際の効果は「プロンプト表示中のポーリング起因再レンダー時にprops不変であればスキップする」点にある。

---

### F5-003: handlePromptRespond/handlePromptDismissのuseCallback状況が未確認

**カテゴリ**: completeness
**場所**: 実装タスクセクション - PromptPanel / MobilePromptSheet

**問題**:

PromptPanelとMobilePromptSheetをmemo化する場合、propsとして渡される`onRespond`（handlePromptRespond）と`onDismiss`（handlePromptDismiss）が安定参照である必要がある。

Issue本文では、FileViewerの`onClose`については「呼び出し元でuseCallback済みのため安定」と明記されているが、PromptPanel/MobilePromptSheetの同等の確認が記載されていない。もしこれらのハンドラが毎レンダーで新しい参照を生成していれば、memo化の効果が無効化される。

**推奨対応**:

PromptPanel/MobilePromptSheetの実装タスクに「onRespond/onDismissが呼び出し元でuseCallbackで安定化されていることを確認する。未安定の場合はuseCallback化またはカスタム比較関数を検討する」旨の注記を追加する。

---

## Nice to Have（あれば良い）

### F5-004: rightPaneのprops数が「5個程度」と記載されているが実際は6個

**カテゴリ**: clarity
**場所**: 提案する解決策セクション - 3. inline JSX抽出 - 推奨

**問題**:

「rightPaneはprops数が少ない（5個程度）」と記載されているが、実際のrightPane（L2000-2008）のTerminalDisplayへの引数は以下の6個:

1. `output`
2. `isActive`
3. `isThinking`
4. `autoScroll`
5. `onScrollChange`
6. `disableAutoFollow`

大きな差ではないが、設計方針の判断根拠として使われている数値であるため、正確に記載すべき。

**推奨対応**:

「5個程度」を「6個」に修正する。

---

## 参照ファイル

### コード

| ファイル | 行 | 関連 |
|---------|-----|------|
| `src/components/worktree/MessageInput.tsx` | L95-120 | handleCompositionStart/End実装。F5-001根拠 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | L2032-2044 | デスクトップPromptPanel条件付きレンダー。F5-002根拠 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | L2281-2289 | モバイルMobilePromptSheet常時マウント |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | L2000-2008 | rightPane TerminalDisplay 6 props。F5-004根拠 |
| `src/components/worktree/PromptPanel.tsx` | L386-394 | shouldRender/animationClassとearly return |

---

## 総合評価

Stage 1の指摘事項は全て適切に反映されており、Issueの品質は大幅に向上している。新たに検出されたMust Fix（F5-001）はuseCallbackの依存配列に関する技術的不正確さであり、そのまま実装すると意図に反する結果（ハンドラの不必要な再生成）を招くため修正が必要である。Should Fix 2件は正確性と完全性の向上に寄与するが、実装時に気づいて対処できるレベルの問題である。
