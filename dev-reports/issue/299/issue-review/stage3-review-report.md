# Issue #299 Stage 3 レビューレポート: 影響範囲分析

**レビュー日**: 2026-02-18
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: Stage 3（影響範囲分析）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 3 |

**総合評価**: medium

Issue #299はStage 1/2のレビューにより記載内容の正確性が大幅に改善されているが、影響範囲の分析において、変更の波及効果と具体的なリグレッションリスクの記載が不足している。特に、Modal z-index変更の8箇所への波及とuseIsMobile変更の5コンポーネント+1独自判定への影響が過小評価されている。

---

## Must Fix（必須対応）

### MF-1: Modal z-index変更の波及効果が未記載

**カテゴリ**: 影響範囲
**場所**: 影響範囲 > 変更対象ファイル（候補） / 対策案 > 症状3

**問題**:
z-index体系再設計時にModal.tsxのz-[9999]を変更した場合の波及先が記載されていない。Modalは以下の8箇所で使用されており、全てに影響が及ぶ:

1. `src/components/worktree/WorktreeDetailRefactored.tsx` L1847 -- デスクトップ版MarkdownEditorモーダル
2. `src/components/worktree/WorktreeDetailRefactored.tsx` L2073 -- モバイル版MarkdownEditorモーダル
3. `src/components/worktree/WorktreeDetailRefactored.tsx` L1875 -- デスクトップ版killConfirmモーダル
4. `src/components/worktree/WorktreeDetailRefactored.tsx` L2101 -- モバイル版killConfirmモーダル
5. `src/components/worktree/FileViewer.tsx` L112 -- ファイルプレビューモーダル
6. `src/components/worktree/AutoYesConfirmDialog.tsx` -- Auto-Yes確認ダイアログ
7. `src/components/worktree/MoveDialog.tsx` -- 移動先選択ダイアログ
8. `src/components/external-apps/ExternalAppForm.tsx` -- 外部アプリ登録ダイアログ

さらに、z-40/z-50をハードコードしている以下のコンポーネントとのスタッキング順序検証も必要:

| ファイル | 現在のz-index | 用途 |
|---------|-------------|------|
| `src/components/common/Toast.tsx` | z-50 | 通知トースト |
| `src/components/mobile/MobilePromptSheet.tsx` | z-50 | プロンプトシート |
| `src/components/mobile/MobileHeader.tsx` | z-40 | モバイルヘッダー |
| `src/components/mobile/MobileTabBar.tsx` | z-40 | モバイルタブバー |
| `src/components/worktree/SlashCommandSelector.tsx` | z-40/z-50 | コマンドセレクター |
| `src/components/worktree/ContextMenu.tsx` | z-50 | コンテキストメニュー |
| `src/components/layout/AppShell.tsx` | z-40/z-50 | ドロワーオーバーレイ |

**推奨対応**:
Issueの影響範囲セクションにModal利用箇所8件とz-index.tsを使用していないハードコードコンポーネント群をリストアップし、z-index変更時のスタッキング順序検証を受け入れ条件に追加すべき。

---

### MF-2: useIsMobile変更の波及範囲が過小評価

**カテゴリ**: 波及効果
**場所**: 影響範囲 > 変更対象ファイル（候補）

**問題**:
useIsMobileは5つのコンポーネントで使用されており、breakpoint変更やタブレット判定追加はそのすべてに影響する:

| コンポーネント | useIsMobileの利用方法 | 影響内容 |
|-------------|---------------------|---------|
| `AppShell.tsx` L59 | モバイル/デスクトップレイアウト切替 | ドロワー vs 固定サイドバー |
| `WorktreeDesktopLayout.tsx` L238 | 2カラム/タブ切替 | 履歴/ターミナルのレイアウト |
| `WorktreeDetailRefactored.tsx` L920 | layoutMode(tabs/split) | 全体レイアウトモード |
| `MarkdownEditor.tsx` L145 | モバイルタブ表示・スワイプ有効化 | エディタUI |
| `MessageInput.tsx` L46 | Enterキー動作・UIテキスト・スラッシュコマンドUI | 入力操作全般 |

さらに、**`SearchBar.tsx` L158 は `window.innerWidth < 768` と独自にbreakpointをハードコード**しており、useIsMobileを使用していない。breakpoint変更時にSearchBar.tsxの独自判定も同時修正しなければ不整合が発生する。

**証拠**:
```typescript
// src/components/worktree/SearchBar.tsx:158
const isMobile = window.innerWidth < 768;
```

**推奨対応**:
Issueの影響範囲にuseIsMobileの全利用箇所5ファイルと、SearchBar.tsxの独自breakpointを明記。SearchBar.tsxはuseIsMobile使用に統一するか同時修正する必要がある。

---

## Should Fix（推奨対応）

### SF-1: Tailwind breakpointとの乖離リスク

**カテゴリ**: リグレッション
**場所**: 対策案 > 症状1・2

**問題**:
`AppShell.tsx` L120は Tailwindの `md:pl-72` を使用しており、`md:` breakpointは768px。もしuseIsMobileのbreakpointを1024pxに変更した場合、768px-1024pxの範囲で以下の矛盾が発生する:

- JavaScript: `isMobile = true` (1024px未満) -> モバイルレイアウト(ドロワー)
- CSS: `md:pl-72` 適用(768px以上) -> サイドバー分のpadding-left

```typescript
// src/components/layout/AppShell.tsx:118-121
<main className={`
  flex-1 min-w-0 h-full overflow-hidden
  transition-[padding] duration-300 ease-out
  ${isOpen ? 'md:pl-72' : 'md:pl-0'}
`}>
```

**推奨対応**:
対策案にTailwind breakpointとの整合性確保を明記。(A) breakpointを768pxのまま維持しCSS側で対応、(B) Tailwind設定も同時変更、のいずれかの方針を記載。

---

### SF-2: Portal脱出条件とz-index設計の相互依存

**カテゴリ**: リグレッション
**場所**: 対策案 > 症状3

**問題**:
MarkdownEditorのPortal脱出は `isMaximized && isFallbackMode && portalContainer` の場合のみ有効(L886)。z-index体系の再設計方法によって以下のシナリオが発生しうる:

- **パターンA**: MODAL値をMAXIMIZED_EDITOR(55)未満に維持(例: 50) + Modal.tsxをZ_INDEX.MODAL使用に変更 -> Portal脱出なしでも全画面が見える。ただしContextMenu(70)やToast(60)がModalの上に表示されてしまう可能性。
- **パターンB**: MODAL値を高い値に設定(例: 100) + MAXIMIZED_EDITOR値も引き上げ -> Portal脱出が依然として必要。
- **パターンC**: MODAL値据え置き(50) + Modal.tsxの9999を50に変更 -> 現行のz-index.ts設計意図どおり。ただしContextMenu(z-50ハードコード)とMODAL(z-50)が同値で競合。

**推奨対応**:
z-index体系再設計の具体的な方針をIssueに記載すべき。推奨: z-index.tsのヒエラルキー(MODAL:50 < MAXIMIZED_EDITOR:55 < TOAST:60 < CONTEXT_MENU:70)を維持し、Modal.tsxのz-[9999]をZ_INDEX.MODALに置換する。

---

### SF-3: テスト計画の不足

**カテゴリ**: テスト範囲
**場所**: 受け入れ条件

**問題**:
影響範囲に対する具体的なテスト計画が不足している:

| テスト | 既存テスト | 必要な追加 |
|-------|----------|----------|
| useIsMobile | `tests/unit/hooks/useIsMobile.test.ts` | iPad 768px/1024px境界値テスト |
| useFullscreen | `tests/unit/hooks/useFullscreen.test.ts` | navigator.platform代替実装テスト |
| useSwipeGesture | `tests/unit/hooks/useSwipeGesture.test.ts` | scrollable要素内スワイプ抑制テスト |
| z-index体系 | なし | Z_INDEX定数のスタッキング順序テスト |
| Modal + MarkdownEditor | なし | Portal脱出 + z-index統合テスト |
| iPad E2E | なし | Playwright iPad viewport エミュレーション |

**推奨対応**:
Issueに上記テスト要件を追記。特にiPad viewportでのE2Eテスト(Playwright device emulation)を受け入れ条件に追加することを推奨。

---

### SF-4: z-50/z-40ハードコードコンポーネントの統一スコープ

**カテゴリ**: 影響範囲
**場所**: 対策案 > 症状3 > z-index管理の統一

**問題**:
現在z-40/z-50をハードコードしているコンポーネントが多数存在し、z-index.tsの定数を使用していない。Issue #299のスコープとしてどこまで統一するかが不明確:

- **最小スコープ**: Modal.tsxのz-[9999]をZ_INDEX.MODALに置換 + z-index.tsの値調整のみ
- **拡張スコープ**: z-40/z-50ハードコードの全コンポーネントもZ_INDEX定数に統一

**推奨対応**:
Issue #299のスコープを明確にし、z-index全面統一は別Issueに分割するかの判断を記載すべき。

---

## Nice to Have（あれば良い）

### NTH-1: WorktreeListグリッドのiPad表示確認

iPad横置き(1024px以上)でlg:grid-cols-3、縦置き(768px)でmd:grid-cols-2が適用される。iPad対応を行う際の確認対象として認識しておくべき。

**ファイル**: `src/components/worktree/WorktreeList.tsx` L508

---

### NTH-2: ExternalAppForm.tsxの関連コンポーネント追記

ExternalAppForm.tsxもModalを使用しているが、Issueの関連コンポーネント一覧に含まれていない。

**ファイル**: `src/components/external-apps/ExternalAppForm.tsx` L12

---

### NTH-3: navigator.userAgentData移行時のSafari非対応考慮

navigator.userAgentDataはChromium系ブラウザのみサポート。Safari(WebKit)ではフォールバックが必要。ただし報告環境がiPad Chrome限定のため優先度は低い。

---

## リグレッションリスク一覧

| ID | リスク | 確率 | 影響度 | 緩和策 |
|----|--------|------|--------|--------|
| RR-1 | useIsMobile breakpoint変更でデスクトップレイアウト崩れ | medium | high | 768px-1024px幅での表示確認、Tailwind md:との整合性 |
| RR-2 | Modal z-index変更でToast/ContextMenuのスタッキング崩れ | medium | medium | 全レイヤーの視覚的スタッキング検証 |
| RR-3 | useSwipeGesture変更で通常スワイプ操作への影響 | low | low | enabled条件(isMaximized && isMobile)の維持確認 |
| RR-4 | useFullscreen iOS検出変更でデスクトップMacの誤判定 | low | high | maxTouchPoints判定の維持、デスクトップMacテスト |
| RR-5 | Portal脱出条件変更で非iPad環境への意図せぬ影響 | low | medium | 変更条件の明確化、全環境テスト |

---

## 影響範囲マップ

```
useIsMobile.ts (MOBILE_BREAKPOINT変更)
  |-- AppShell.tsx (レイアウト切替) -- md:pl-72 (Tailwind)
  |-- WorktreeDesktopLayout.tsx (2カラム/タブ)
  |-- WorktreeDetailRefactored.tsx (layoutMode)
  |-- MarkdownEditor.tsx (モバイルタブ/スワイプ)
  |-- MessageInput.tsx (Enter動作/UI)
  |-- SearchBar.tsx (*独自判定: window.innerWidth < 768)

z-index.ts + Modal.tsx (z-index体系変更)
  |-- WorktreeDetailRefactored.tsx (MarkdownEditorモーダル x2, killConfirmモーダル x2)
  |-- FileViewer.tsx (プレビューモーダル)
  |-- AutoYesConfirmDialog.tsx (確認ダイアログ)
  |-- MoveDialog.tsx (移動ダイアログ)
  |-- ExternalAppForm.tsx (登録ダイアログ)
  |-- Toast.tsx (z-50 -- スタッキング検証)
  |-- MobilePromptSheet.tsx (z-50 -- スタッキング検証)
  |-- MobileHeader.tsx (z-40 -- スタッキング検証)
  |-- MobileTabBar.tsx (z-40 -- スタッキング検証)
  |-- SlashCommandSelector.tsx (z-40/z-50 -- スタッキング検証)
  |-- ContextMenu.tsx (z-50 -- スタッキング検証)

useFullscreen.ts (iOS検出変更)
  |-- MarkdownEditor.tsx (全画面モード/Portal脱出)

useSwipeGesture.ts (scrollable判定追加)
  |-- MarkdownEditor.tsx (全画面スワイプ)
```

---

## 参照ファイル

### 直接変更対象（8ファイル）

| ファイル | 変更内容 |
|---------|---------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/hooks/useIsMobile.ts` | breakpoint/タブレット判定 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/hooks/useFullscreen.ts` | navigator.platform代替 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/hooks/useSwipeGesture.ts` | scrollable判定追加 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/config/z-index.ts` | MODAL/MAXIMIZED_EDITOR再設計 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/ui/Modal.tsx` | z-[9999]解消 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/worktree/MarkdownEditor.tsx` | 全画面/Portal/スワイプ修正 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/layout/AppShell.tsx` | iPad向けレイアウト |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/worktree/WorktreeDesktopLayout.tsx` | タブレットレイアウト |

### 間接影響対象（14ファイル）

| ファイル | 影響理由 |
|---------|---------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/worktree/MessageInput.tsx` | useIsMobile依存 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/worktree/WorktreeDetailRefactored.tsx` | useIsMobile + Modal依存 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/worktree/SearchBar.tsx` | 独自breakpoint判定 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/worktree/FileViewer.tsx` | Modal依存 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/worktree/AutoYesConfirmDialog.tsx` | Modal依存 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/worktree/MoveDialog.tsx` | Modal依存 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/external-apps/ExternalAppForm.tsx` | Modal依存 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/common/Toast.tsx` | z-50ハードコード |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/mobile/MobilePromptSheet.tsx` | z-50ハードコード |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/mobile/MobileHeader.tsx` | z-40ハードコード |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/mobile/MobileTabBar.tsx` | z-40ハードコード |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/worktree/SlashCommandSelector.tsx` | z-40/z-50ハードコード |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/worktree/ContextMenu.tsx` | z-50ハードコード |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/src/components/layout/Header.tsx` | z-50ハードコード |

### 既存テスト（更新必要）

| テストファイル | 更新内容 |
|-------------|---------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/tests/unit/hooks/useIsMobile.test.ts` | iPad境界値テスト追加 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/tests/unit/hooks/useFullscreen.test.ts` | navigator.platform代替テスト |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-299/tests/unit/hooks/useSwipeGesture.test.ts` | scrollable要素テスト追加 |
