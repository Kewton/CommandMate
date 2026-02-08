# Issue #104 iPad全画面表示バグ修正 設計方針書

## 1. 概要

### 1.1 目的
iPad Chrome（横置き）でMarkdownエディタの全画面表示機能が正しく動作しない問題を修正する。

### 1.2 問題の概要
iPad Chrome（横置き）で全画面ボタンをクリックすると、ターミナルタブが前面に表示されてMarkdownエディタが見えなくなる。

### 1.3 スコープ

**本Issueで対応**:
- z-index条件の修正（案1）

**別Issue対応（スコープ外）**:
- オリエンテーション変更の検知追加（案2）
- タブレット判定の追加（案3）

### 1.4 関連Issue
- #99 マークダウンエディタ表示機能改善（全画面機能の元実装）

---

## 2. 原因分析

### 2.1 根本原因

Issue #99で実装された全画面機能において、z-index設定の条件が厳格すぎることが原因。

**問題箇所**: `src/components/worktree/MarkdownEditor.tsx:436-441`

```typescript
const containerStyle = useMemo(() => {
  if (isMaximized && isFallbackMode) {  // ← 両方trueが必要
    return { zIndex: Z_INDEX.MAXIMIZED_EDITOR };
  }
  return undefined;
}, [isMaximized, isFallbackMode]);
```

### 2.2 問題のメカニズム

1. iPad Chrome（横置き）でMarkdownファイルを開く
   - `isMobile = false`（幅 > 768px）
2. 全画面ボタンをクリック
   - `isMaximized = true`
   - `isFallbackMode = false`（Fullscreen API成功時）
3. z-indexが設定されない（`isFallbackMode`がfalseのため）
4. WorktreeDetailのタブ（Terminal等）が前面に表示される

### 2.3 Issue #99設計判断との関係

Issue #99設計書では、z-index設定を`isMaximized && isFallbackMode`の両方がtrueの場合のみに限定する設計判断がなされていた。

**設計時の意図**:
- Fullscreen API成功時はブラウザがフルスクリーン要素を最上位に配置するため、z-indexは不要
- z-indexが不必要に設定されることによるパフォーマンス影響を回避

**実際の問題**:
- iPad Chromeでは、Fullscreen APIが成功していても親要素のスタッキングコンテキストの影響で期待通りに動作しない
- 結果として、z-indexを明示的に設定する必要がある

---

## 3. 修正方針

### 3.1 採用案: z-index条件の緩和

```typescript
// 修正前
const containerStyle = useMemo(() => {
  if (isMaximized && isFallbackMode) {
    return { zIndex: Z_INDEX.MAXIMIZED_EDITOR };
  }
  return undefined;
}, [isMaximized, isFallbackMode]);

// 修正後
const containerStyle = useMemo(() => {
  if (isMaximized) {  // isFallbackMode条件を削除
    return { zIndex: Z_INDEX.MAXIMIZED_EDITOR };
  }
  return undefined;
}, [isMaximized]);
```

### 3.2 設計判断の根拠

| 観点 | 評価 |
|------|------|
| 影響範囲 | 最小（1行の条件変更のみ） |
| リスク | 低（z-index階層設計により競合なし） |
| 後方互換性 | 完全維持 |
| パフォーマンス | 軽微な影響（useMemoで計算済み） |

### 3.3 デスクトップへの影響

z-index条件を`isMaximized`のみに変更した場合:

- デスクトップのFullscreen API成功時にも不必要にz-indexが設定される
- ただし、z-index階層は `MAXIMIZED_EDITOR(40) < MODAL(50) < TOAST(60) < CONTEXT_MENU(70)` のため競合なし
- Fullscreen API成功時はブラウザが要素を最上位に配置するため視覚的問題なし
- useMemoで計算済みのためパフォーマンス影響は軽微

---

## 4. 影響ファイル一覧

### 4.1 変更対象

| ファイル | 行番号 | 変更種別 | リスク |
|---------|--------|----------|--------|
| `src/components/worktree/MarkdownEditor.tsx` | L436-441 | 条件修正 | 中 |

### 4.2 影響確認必要

| ファイル | 確認内容 |
|---------|---------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Modal内でのMarkdownEditor使用。Modal(z-50) > MaximizedEditor(z-40)の関係確認 |

### 4.3 変更不要

| ファイル | 理由 |
|---------|------|
| `src/hooks/useFullscreen.ts` | フック自体の動作は正常 |
| `src/hooks/useIsMobile.ts` | 案1では変更不要 |
| `src/config/z-index.ts` | MAXIMIZED_EDITOR=40は維持 |

---

## 5. テスト戦略

### 5.1 ユニットテスト

**追加テストケース**: `tests/unit/components/MarkdownEditor.test.tsx`

```typescript
describe('z-index behavior', () => {
  it('should set z-index when isMaximized=true regardless of isFallbackMode', () => {
    // isFallbackMode=false, isMaximized=true の場合
    // z-index=40が設定されることを確認
  });

  it('should set z-index when isMaximized=true and isFallbackMode=true', () => {
    // isFallbackMode=true, isMaximized=true の場合
    // z-index=40が設定されることを確認
  });

  it('should not set z-index when isMaximized=false', () => {
    // isMaximized=false の場合
    // z-indexが設定されないことを確認
  });
});
```

### 5.2 手動テスト（必須）

| テスト項目 | 環境 | 確認内容 |
|-----------|------|---------|
| iPad横置き全画面 | iPad Chrome | 全画面表示が正しく動作する |
| iPad縦置き全画面 | iPad Chrome | 全画面表示が正しく動作する |
| デスクトップ全画面 | Windows/Mac Chrome | 既存動作が維持される |
| iOS Safari | iOS Safari | フォールバックモードが正常動作する |

### 5.3 リグレッションテスト

| ID | 確認内容 | 環境 |
|----|---------|------|
| RR-1 | デスクトップでの最大化動作 | Windows/Mac Chrome/Safari |
| RR-2 | iOS Safari（縦向き）での動作 | iOS Safari |
| RR-3 | Modal内でのMaximize動作 | 全環境 |

---

## 6. セキュリティ考慮

### 6.1 影響なし

本修正はz-index条件の変更のみであり、セキュリティに関する変更は含まれない。

- XSS保護（rehype-sanitize）: 影響なし
- ファイル操作API: 影響なし
- 認証/認可: 影響なし

---

## 7. 設計原則への準拠

### 7.1 SOLID原則

| 原則 | 準拠状況 | 説明 |
|------|---------|------|
| SRP | ○ | containerStyleの責務は変わらない |
| OCP | ○ | 既存インターフェースを維持 |
| LSP | N/A | 継承関係なし |
| ISP | N/A | インターフェース変更なし |
| DIP | N/A | 依存関係変更なし |

### 7.2 KISS原則

条件を単純化（`isMaximized && isFallbackMode` → `isMaximized`）することで、より理解しやすいコードになる。

### 7.3 YAGNI原則

案2（オリエンテーション検知）と案3（タブレット判定）は本Issueのスコープ外として別Issue対応とし、不必要な変更を避ける。

---

## 8. 実装チェックリスト

### Phase 1: 修正実装
- [ ] `src/components/worktree/MarkdownEditor.tsx` L436-441のz-index条件を修正
- [ ] containerClassesとcontainerStyleの条件差異についてコード内コメントを追加

### Phase 2: テスト
- [ ] ユニットテスト追加（z-index設定のテストケース3件）
- [ ] iPad Chrome手動テスト
- [ ] デスクトップリグレッションテスト
- [ ] Modal内Maximize動作テスト

### Phase 3: ドキュメント
- [ ] Issue #99設計書の更新（z-index条件変更の経緯を追記）

---

## 9. レビュー履歴

### Stage 1: 設計原則レビュー（2026-02-01）

**レビュー結果**: APPROVED

**設計原則スコア**:
| 原則 | スコア |
|------|--------|
| SOLID | 5/5 |
| KISS | 5/5 |
| YAGNI | 5/5 |
| DRY | 4/5 |

**指摘事項**: Must Fix 0件、Should Fix 1件（設計書に既に記載済み）

**評価ポイント**:
- 条件の単純化（`isMaximized && isFallbackMode` -> `isMaximized`）はKISS原則に則った優れた設計
- 案2・案3をスコープ外とし最小限の変更でバグ修正するYAGNI原則への準拠
- z-index階層設計との整合性が確保されている

### Stage 2: 整合性レビュー（2026-02-01）

**レビュー結果**: APPROVED

**整合性スコア**: A-

**整合性チェック結果**:
| 項目 | 結果 |
|------|------|
| 行番号 | pass |
| 変数名 | pass |
| z-index値 | partial |
| 設計書参照 | partial |

**指摘事項**:
- SF-001: Issue #99設計書のz-index値（9999）と実装（40）の不整合
  - 本設計書は正しい値（40）を参照しているため対応不要

### Stage 3: 影響分析レビュー（2026-02-01）

**レビュー結果**: APPROVED

**影響スコア**: A

**影響範囲サマリ**:
- 高影響ファイル: 1件（MarkdownEditor.tsx L436-441）
- 中影響ファイル: 0件
- 変更不要ファイル: 4件

**リグレッションリスク**:
| ID | リスク | レベル |
|----|--------|--------|
| RR-1 | デスクトップでz-index設定 | 低 |
| RR-2 | useMemo依存配列変更 | 非常に低 |
| RR-3 | Modal内最大化 | 低 |
| RR-4 | iOS Safari動作 | 低 |

**承認条件**:
1. 設計書5.1記載のユニットテスト3件の追加
2. 手動テストMT-001（iPad Chrome横置き）の実施・確認

### Stage 4: セキュリティレビュー（2026-02-01）

**レビュー結果**: APPROVED

**セキュリティスコア**: A

**OWASP Top 10チェック結果**:
| 項目 | 結果 |
|------|------|
| A01-A10 | すべてpass/N/A |

**セキュリティ評価**:
- z-index値は定数定義（40）でユーザー入力介在なし
- XSS/クリックジャッキングリスクなし
- 既存セキュリティ対策（rehype-sanitize等）との整合性維持

---

*作成日: 2026-02-01*
*最終更新: 2026-02-01*
