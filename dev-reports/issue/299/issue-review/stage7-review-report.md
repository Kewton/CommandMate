# Issue #299 レビューレポート - Stage 7

**レビュー日**: 2026-02-18
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目
**レビューステージ**: Stage 7（影響範囲レビュー 2回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 3 |

**総合評価**: **high**

Issue #299はStage 1からStage 6までの6回のレビュー・反映サイクルを経て、影響範囲の記載品質が大幅に向上している。Stage 3で指摘した全てのMust Fix（MF-1: Modal z-index波及効果、MF-2: useIsMobile波及範囲）およびShould Fix 4件（SF-1〜SF-4）が全て反映済みであり、Stage 5で指摘した全てのMust Fix 1件とShould Fix 3件もStage 6で反映済み。今回のStage 7レビューではMust Fixに該当する問題は発見されず、影響範囲の網羅性は十分な水準に達している。

---

## 前回指摘事項の反映状況

### Stage 3 指摘事項

| ID | 指摘内容 | 状態 |
|----|---------|------|
| MF-1 | Modal z-index変更の波及効果（8箇所のModal利用、z-40/z-50ハードコード） | **反映済み** |
| MF-2 | useIsMobile変更の波及範囲（5コンポーネント、SearchBar.tsx独自判定） | **反映済み** |
| SF-1 | AppShell.tsx Tailwind md:breakpointとの乖離リスク | **反映済み** |
| SF-2 | Portal脱出条件とz-index体系再設計の相互依存 | **反映済み** |
| SF-3 | テスト計画の不足（既存テスト更新・iPad E2E追加） | **反映済み** |
| SF-4 | z-40/z-50ハードコードコンポーネントの統一スコープ | **反映済み** |

### Stage 5 指摘事項（Stage 6で反映済み）

| ID | 指摘内容 | 状態 |
|----|---------|------|
| MF-1 | z-index.ts内部JSDocコメント(9999)と定数値(50)の不整合 | **反映済み** |
| SF-1 | Header.tsx, WorktreeDetailRefactored.tsxのz-50漏れ | **反映済み** |
| SF-2 | MAXIMIZED_EDITORコメントの実態矛盾 | **反映済み** |
| SF-3 | Portal(z-55)表現の不正確さ | **反映済み** |

---

## Should Fix（推奨対応）

### SF-1: SortSelector.tsxがz-40/z-50ハードコードテーブルに未記載

**カテゴリ**: 影響範囲
**場所**: 影響範囲 > z-40/z-50ハードコードコンポーネント

**問題**:
`src/components/sidebar/SortSelector.tsx`（L142）がz-50をハードコードしているが、Issueのz-40/z-50ハードコードコンポーネントテーブルに含まれていない。SortSelectorはサイドバー内のabsolute配置ドロップダウンであり、fixed配置コンポーネントよりスタッキング影響は限定的だが、z-index体系の完全な棚卸しの観点からは漏れている。

加えて、`WorktreeDetailRefactored.tsx`にはz-50（L1819）以外にもz-35（L1937）やz-30（L1947, L2035）がハードコードされているが、これらについてはIssueで言及がない。

**証拠**:
- `src/components/sidebar/SortSelector.tsx:142` - `absolute right-0 top-full mt-1 z-50`
- `src/components/worktree/WorktreeDetailRefactored.tsx:1937` - `z-35`（BranchMismatchAlert）
- `src/components/worktree/WorktreeDetailRefactored.tsx:1947` - `z-30`（AutoYes+CLITabs行）
- `src/components/worktree/WorktreeDetailRefactored.tsx:2035` - `z-30`（MessageInput fixed）

**推奨対応**:
SortSelector.tsx（z-50, L142, absolute配置ドロップダウン）をz-40/z-50テーブルに追加。備考にabsolute配置のため影響度は低いことを記載。WorktreeDetailRefactored.tsxのz-35/z-30については、Z_INDEX.SIDEBAR(30)付近の値でありModal(50)/MAXIMIZED_EDITOR(55)との直接的な競合は発生しにくいため、拡張スコープの認識事項として記載する程度で十分。

---

### SF-2: useVirtualKeyboardフックのiPad全画面+仮想キーボード時の影響

**カテゴリ**: 影響範囲
**場所**: 影響範囲 > 変更対象ファイル（候補）/ 関連コンポーネント

**問題**:
`useVirtualKeyboard`フック（`src/hooks/useVirtualKeyboard.ts`）がMarkdownEditor.tsx（L148）で使用されており、仮想キーボード表示時のレイアウト調整に関与しているが、Issueの影響範囲・関連コンポーネントのいずれにも含まれていない。

iPad Chrome横置きで全画面MarkdownEditorを使用中にテキスト入力すると仮想キーボードが表示され、`visualViewport.height`が変化する。この場合、useVirtualKeyboardの`isKeyboardVisible`/`keyboardHeight`がMarkdownEditorの全画面レイアウト（`fixed inset-0` + `z-55`）と相互作用する可能性がある。

**証拠**:
- `src/hooks/useVirtualKeyboard.ts:54-101` - visualViewport APIで高さ変化を検出
- `src/components/worktree/MarkdownEditor.tsx:148` - `const { isKeyboardVisible, keyboardHeight } = useVirtualKeyboard();`

**推奨対応**:
`useVirtualKeyboard.ts`を関連コンポーネントセクションに追加。useVirtualKeyboard自体の変更は不要だが、iPad全画面エディタ+仮想キーボード表示時の動作確認を、受け入れ条件のiPad E2Eテストまたは手動テスト項目に含めることを推奨。

---

## Nice to Have（あれば良い）

### NTH-1: PaneResizerコンポーネントの影響評価

**カテゴリ**: 影響範囲

`PaneResizer.tsx`はMarkdownEditor.tsx（L835）とWorktreeDesktopLayout.tsx（L189）で使用されている。z-indexやuseIsMobileに依存しないため、Issue #299の変更による直接的な影響はない。iPad横置きでの分割ビューリサイズ操作は手動テストで確認する程度で十分。

---

### NTH-2: z-index.tsコメント変更のテスト影響

**カテゴリ**: 影響範囲

z-index.tsのJSDocコメント変更（L17の9999修正）は純粋なコメント修正であり、exportされるZ_INDEX定数の値は変更されない。z-index.tsに対する既存テストは存在しないことを確認済み。テスト失敗のリスクはゼロ。

---

### NTH-3: SlashCommandSelector.tsx デスクトップ版z-50の未記載

**カテゴリ**: 影響範囲

SlashCommandSelector.tsx（L223）のデスクトップ版はabsolute配置でz-50を使用しているが、Issueのテーブルでは「z-40/z-50（L143/L151）」のモバイル版のみが記載されている。L223もz-50を使用しているため、完全性の観点からテーブルの行に含めると良い。

---

## 追加の影響範囲チェック結果

### z-index.tsコメント変更 -> テストファイルへの影響

**結果**: 影響なし。z-index.tsに対する既存テストファイルは存在しない（`tests/`ディレクトリ内を検索して確認済み）。コメント変更はexportされる値を変更しないため、他のテストへの間接影響もない。

### useVirtualKeyboardフック -> MarkdownEditorへの影響

**結果**: 間接影響あり（SF-2として記載）。useVirtualKeyboard自体の変更は不要だが、iPad全画面モードでの仮想キーボード表示時にvisualViewportの高さ変化がMarkdownEditorのレイアウトに影響する可能性があるため、動作確認が必要。

### PaneResizerコンポーネントへの影響

**結果**: 影響なし（NTH-1として記載）。PaneResizerはz-indexやuseIsMobileに依存せず、タッチイベントを独自に処理する純粋なUI部品。Issue #299の変更対象ファイルとの依存関係がない。

---

## 影響範囲の網羅性評価

### 変更対象ファイル（8ファイル）

Issueに記載された8ファイルは全て妥当であり、漏れは発見されなかった。

| ファイル | リスク | Issueの記載 |
|---------|--------|------------|
| `src/hooks/useIsMobile.ts` | 高 | 適切 |
| `src/hooks/useFullscreen.ts` | 中 | 適切 |
| `src/components/worktree/MarkdownEditor.tsx` | 中 | 適切 |
| `src/components/ui/Modal.tsx` | 高 | 適切 |
| `src/config/z-index.ts` | 高 | 適切 |
| `src/components/layout/AppShell.tsx` | 中 | 適切 |
| `src/components/worktree/WorktreeDesktopLayout.tsx` | 中 | 適切 |
| `src/hooks/useSwipeGesture.ts` | 低 | 適切 |

### 波及影響（useIsMobile依存：5コンポーネント）

Issueに記載された5コンポーネント全てが正確。SearchBar.tsxの独自breakpoint問題も注意事項として記載済み。

### 波及影響（Modal利用：8箇所）

Issueに記載された8箇所全てが正確。WorktreeDetailRefactored.tsxの4箇所、FileViewer.tsx、AutoYesConfirmDialog.tsx、MoveDialog.tsx、ExternalAppForm.tsxの全てが網羅されている。

### 波及影響（z-40/z-50ハードコード：9コンポーネント）

Issueに記載された9コンポーネント中、SortSelector.tsx（z-50, absolute配置）が漏れている（SF-1として指摘）。ただし、影響度は低い。

### テスト要件（5項目）

Issueに記載された5項目のテスト要件は妥当。useVirtualKeyboardのiPad全画面+仮想キーボード時の動作確認を手動テスト項目として追加することを推奨（SF-2）。

---

## 参照ファイル

### コード（直接影響）
- `src/config/z-index.ts`: z-index定数管理（JSDocコメント/定数値/MAXIMIZED_EDITORコメントの不整合がIssueに記載済み）
- `src/components/ui/Modal.tsx`: z-[9999]ハードコード（L86）
- `src/hooks/useIsMobile.ts`: MOBILE_BREAKPOINT=768（L15）、5コンポーネント依存
- `src/hooks/useFullscreen.ts`: isIOSDevice() navigator.platform依存（L67）
- `src/hooks/useSwipeGesture.ts`: scrollable要素判定なし（L104-110）
- `src/components/worktree/MarkdownEditor.tsx`: 全画面表示の統合ポイント（z-55, Portal, swipe, virtualKeyboard）

### コード（間接影響・新規発見）
- `src/hooks/useVirtualKeyboard.ts`: iPad全画面+仮想キーボード時の動作確認対象（**SF-2: 影響範囲に未記載**）
- `src/components/sidebar/SortSelector.tsx`: z-50ハードコード（L142, absolute配置）（**SF-1: テーブルに未記載**）
- `src/components/worktree/PaneResizer.tsx`: 直接影響なし（確認済み）
- `src/components/worktree/WorktreeDetailRefactored.tsx`: z-35(L1937), z-30(L1947, L2035)のハードコード（影響度低）

### ドキュメント
- `CLAUDE.md`: モジュール説明（z-index.ts、useFullscreen.ts、useVirtualKeyboard等）
