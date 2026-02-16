# Architecture Review: Issue #288 - Stage 2 整合性レビュー

## Executive Summary

Issue #288 (フリー入力モードのセレクター再表示バグ修正) の設計方針書と現在の実装コードの整合性を検証した。設計方針書は全体的に現在のコード構造を正確に反映しており、提案される変更の影響範囲も適切に分析されている。ただし、モバイルコマンドボタン経由のセレクター表示経路が設計書の経路分析から漏れており、これが唯一の中程度の不整合として識別された。

**Status**: conditionally_approved
**Score**: 4/5

---

## 1. 整合性検証結果

### 1-1. 問題記述の整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| セレクター表示条件 | `newValue.startsWith('/') && !newValue.includes(' ')` | MessageInput.tsx L158: 同一条件 | なし |
| handleFreeInput の動作 | setShowCommandSelector(false), setMessage('/'), setTimeout focus | MessageInput.tsx L141-148: 同一 | なし |
| 根本原因の分析 | handleFreeInput後にhandleMessageChangeがセレクター表示条件に合致 | コードフロー確認済み: '/'プレフィックス入力で条件一致 | なし |

**判定**: 整合

---

### 1-2. コンポーネント関係図の整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| MI -> SCS 依存 | MessageInput -> SlashCommandSelector | L270-277: isOpen, groups, onSelect, onClose, isMobile, onFreeInput を渡す | なし |
| MI -> IB 依存 | MessageInput -> InterruptButton | L244-248: worktreeId, cliToolId, disabled を渡す | なし |
| MI -> API 依存 | worktreeApi.sendMessage 使用 | L9: import, L75: sendMessage 呼び出し | なし |
| MI -> USH 依存 | useSlashCommands 使用 | L46: groups を取得 | なし |
| MI -> UIM 依存 | useIsMobile 使用 | L45: isMobile を取得 | なし |
| WDR -> MI 依存 | WorktreeDetailRefactored -> MessageInput | L1802-1807, L2038-2043: 4つのprops | なし |

**判定**: 整合

---

### 1-3. Props インターフェースの整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| MessageInputProps 変更なし | props変更は加えない | L17-22: worktreeId, onMessageSent, cliToolId, isSessionRunning | なし |
| SlashCommandSelectorProps 変更なし | 既存の onFreeInput を使用 | L29: onFreeInput?: () => void 既存 | なし |
| 破壊的変更なし | isFreeInputMode は内部状態 | 確認済み: useState で管理、外部公開なし | なし |

**判定**: 整合

---

### 1-4. 状態遷移設計の整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| Normal -> FreeInput 遷移 | handleFreeInput() 呼び出し | L141-148: handleFreeInput 存在、SCS経由で呼び出し | なし |
| FreeInput -> Normal 遷移 (送信) | submitMessage() 完了 | L66-83: submitMessage でメッセージクリア | なし |
| FreeInput -> Normal 遷移 (空文字) | メッセージ空文字化 | L153-163: handleMessageChange 内で空文字判定可能 | なし |
| FreeInput -> Normal 遷移 (キャンセル) | handleCommandCancel() | L132-135: Escape 経由で呼び出し | なし |
| FreeInput中のセレクター表示 | SelectorAlwaysHidden | **不完全**: モバイルボタン(L218)による直接 setShowCommandSelector(true) が未考慮 | **SF-001** |

**判定**: 概ね整合 (1件の経路漏れ)

---

### 1-5. 関数別修正案の整合性

#### handleFreeInput() (Section 4-2)

| 設計書のコード | 現在の実装 (L141-148) | 差異 |
|--------------|---------------------|------|
| `setShowCommandSelector(false)` | `setShowCommandSelector(false)` (L142) | なし |
| `setIsFreeInputMode(true)` **追加** | 未実装 (設計段階) | 設計通り |
| `setMessage('/')` | `setMessage('/')` (L143) | なし |
| `setTimeout(() => focus(), 50)` | `setTimeout(() => focus(), 50)` (L145-147) | なし |

**判定**: 整合 (追加予定の変更は適切)

#### handleMessageChange() (Section 4-3)

| 設計書のコード | 現在の実装 (L153-163) | 差異 |
|--------------|---------------------|------|
| `setMessage(newValue)` | `setMessage(newValue)` (L155) | なし |
| 空文字チェック **追加** | 未実装 (設計段階) | 設計通り |
| isFreeInputMode 早期リターン **追加** | 未実装 (設計段階) | 設計通り |
| セレクター表示条件 | `newValue === '/' \|\| (...)` (L158) | なし |

**判定**: 整合

#### submitMessage() (Section 4-4)

| 設計書のコード | 現在の実装 (L66-83) | 差異 |
|--------------|---------------------|------|
| ガード条件 `isComposing \|\| !message.trim() \|\| sending` | L67: 同一 | なし |
| `setSending(true)` | L72: 同一 | なし |
| `setError(null)` | L73: 同一 | なし |
| `effectiveCliTool` 決定 | L74: 同一 | なし |
| `worktreeApi.sendMessage(...)` | L75: 同一 | なし |
| `setMessage('')` | L76: 同一 | なし |
| `setIsFreeInputMode(false)` **追加** | 未実装 (設計段階) | 設計通り |
| `onMessageSent?.(effectiveCliTool)` | L77: 同一 | なし |

**判定**: 整合

#### handleCommandCancel() (Section 4-5)

| 設計書のコード | 現在の実装 (L132-135) | 差異 |
|--------------|---------------------|------|
| `setShowCommandSelector(false)` | L133: 同一 | なし |
| `setIsFreeInputMode(false)` **追加** | 未実装 (設計段階) | 設計通り |
| `textareaRef.current?.focus()` | L134: 同一 | なし |

**判定**: 整合

---

### 1-6. 変更不要ファイルの整合性

| ファイル | 設計書の理由 | 検証結果 | 差異 |
|---------|------------|---------|------|
| SlashCommandSelector.tsx | isOpen=false により既存ガード (L95) で正常動作 | L95 は handleKeyDown の早期リターン。レンダリングガードは L131。両方とも isOpen=false で正常動作 | **SF-002**: 行番号が不正確 (L95 ではなく L131 がレンダリングガード) |
| WorktreeDetailRefactored.tsx | MessageInputProps 変更なし | L1802-1807, L2038-2043: 既存 props (worktreeId, onMessageSent, cliToolId, isSessionRunning) のみ使用 | なし |
| standard-commands.ts | コマンド定義に変更なし | src/lib/standard-commands.ts 確認: 変更不要 | なし |

**判定**: 概ね整合 (1件の行番号不正確)

---

### 1-7. テスト設計の整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| テストファイルパス | tests/unit/components/worktree/MessageInput.test.tsx | 既存ファイル確認済み | なし |
| モック構造 | useSlashCommands モックにグループを返す設定 | 既存テストでは groups: [] を返す。設計書でコマンドグループ追加方針は妥当 | なし |
| TC-1 ~ TC-6 | 新規テストケース追加 | 既存テストは Desktop/Mobile/IME/Accessibility/Basic の5カテゴリ。フリー入力テストは存在せず追加対象 | なし |

**判定**: 整合

---

## 2. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | モバイルコマンドボタン経由のセレクター再表示 (SF-001) | Low | Medium | P2 |
| 整合性リスク | SlashCommandSelector 行番号参照の不正確 (SF-002) | Low | Low | P3 |
| セキュリティリスク | なし (UIステート管理のみ) | - | - | - |
| 運用リスク | なし (内部状態追加、外部インターフェース不変) | - | - | - |

---

## 3. 改善推奨事項

### 必須改善項目 (Must Fix)

なし。

### 推奨改善項目 (Should Fix)

#### SF-001: モバイルコマンドボタンによる isFreeInputMode バイパス経路の未記載

**概要**: 設計書の経路分析で「フリー入力モード中に showCommandSelector が true になる経路は存在しない」と断言しているが、MessageInput.tsx L218 のモバイルコマンドボタンが isFreeInputMode を考慮せずに直接 `setShowCommandSelector(true)` を呼び出す。

**対象コード** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-288/src/components/worktree/MessageInput.tsx` L215-227):

```typescript
{isMobile && (
  <button
    type="button"
    onClick={() => setShowCommandSelector(true)}  // isFreeInputMode 未チェック
    className="..."
    aria-label="Show slash commands"
    data-testid="mobile-command-button"
  >
    ...
  </button>
)}
```

**推奨対応**:
1. 設計書 Section 3 の FreeInput 状態遷移図に、モバイルコマンドボタン経由の経路を追加する
2. 設計書 Section 4-3 の SF-002-response コメントにモバイルボタン経路の分析を追加する
3. 以下のいずれかの対応方針を設計書に明記する:
   - (A) モバイルボタン onClick で isFreeInputMode を false にリセットしてからセレクターを表示する (ユーザーが意図的にセレクター操作に切り替えたと判断)
   - (B) isFreeInputMode 中はモバイルボタンを無効化する
   - (C) 現状のままとし、モバイルボタンがフリー入力モードを暗黙的に解除する動作を許容する (最も KISS に沿う)

**重要度**: medium -- モバイル固有のエッジケースだが、設計書の経路分析の正確性に影響する。

#### SF-002: SlashCommandSelector ガード行番号の参照先不正確

**概要**: 設計書 Section 6 で「L95: `if (!isOpen) return`」と記載されているが、これは `handleKeyDown` コールバック内のガードである。コンポーネントレンダリングの主ガードは L131 の `if (!isOpen) { return null; }` である。

**対象コード** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-288/src/components/worktree/SlashCommandSelector.tsx`):

```typescript
// L95 (handleKeyDown 内の早期リターン)
const handleKeyDown = useCallback(
  (e: KeyboardEvent) => {
    if (!isOpen) return;  // <-- 設計書が参照している行
    ...

// L131 (レンダリングガード)
if (!isOpen) {
  return null;  // <-- 設計書が意図していると推測される行
}
```

**推奨対応**: 設計書の行番号を「L95 (handleKeyDown) / L131 (render guard)」に修正し、両方のガードが存在することを明記する。

**重要度**: low -- 実装上の問題はなく、ドキュメントの正確性のみの問題。

### 検討事項 (Consider)

#### C-001: FreeInput 状態での Enter キー処理フローのドキュメント化

設計書 Section 3 の状態遷移図は FreeInput 状態内部を「SelectorAlwaysHidden: 文字入力」のみで表現しているが、Enter キーによる送信フローについても記載があると、TC-2 (handleFreeInput 後に Enter キーで submitMessage が呼ばれる) の設計根拠が明確になる。handleKeyDown L192 の `!showCommandSelector` チェックにより、フリー入力モード中は Enter 送信が正常に機能する理由の説明が含まれるとよい。

#### C-002: コンポーネント関係図の import 精度

設計書 Section 2 の関係図で `MI -.-> API[worktreeApi.sendMessage]` とあるが、実際の import は `worktreeApi` と `handleApiError` の両方 (L9)。図の精度としては十分であり修正不要だが、記録として残す。

---

## 4. 総合判定

| カテゴリ | 評価 |
|---------|------|
| 問題記述の正確性 | 整合 |
| コンポーネント関係図 | 整合 |
| Props インターフェース | 整合 |
| 状態遷移設計 | 概ね整合 (モバイル経路1件漏れ) |
| 関数別修正案 | 整合 |
| 変更スコープ | 概ね整合 (行番号1件不正確) |
| テスト設計 | 整合 |
| セキュリティ考慮 | 整合 |

**総合ステータス**: conditionally_approved

設計方針書は現在のコード構造を高い精度で反映しており、提案される変更は実装可能である。SF-001 (モバイルコマンドボタン経路) の対応方針を設計書に追記した上で実装に進むことを推奨する。SF-002 は軽微な参照修正のみ。

---

*Architecture Review by architecture-review-agent*
*Issue #288 - Stage 2 整合性レビュー*
*Date: 2026-02-17*
