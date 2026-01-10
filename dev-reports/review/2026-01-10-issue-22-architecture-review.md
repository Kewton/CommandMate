# アーキテクチャレビュー: Issue #22 マルチタスク強化

**レビュー日**: 2026-01-10
**対象設計書**: `dev-reports/design/issue-22-multitask-sidebar-design-policy.md`
**レビュアー**: Claude Code Architecture Review

---

## 1. 設計原則の遵守確認

### 1.1 SOLID原則チェック

| 原則 | 状態 | 評価 | コメント |
|------|------|------|----------|
| **S** - Single Responsibility | :white_check_mark: | 良好 | コンポーネント分離が適切（Sidebar, BranchListItem, BranchStatusIndicator） |
| **O** - Open/Closed | :white_check_mark: | 良好 | Compound Componentパターンで拡張性確保 |
| **L** - Liskov Substitution | N/A | - | 継承を使用しないため該当なし |
| **I** - Interface Segregation | :white_check_mark: | 良好 | SidebarContext / WorktreeSelectionContext の分離は適切 |
| **D** - Dependency Inversion | :white_check_mark: | 良好 | Custom Hook パターンで依存性を抽象化 |

### 1.2 その他の原則

| 原則 | 状態 | コメント |
|------|------|----------|
| KISS | :white_check_mark: | 既存パターン（Context + useReducer）を踏襲、最小限の新規依存 |
| YAGNI | :white_check_mark: | リサイズ機能は Phase 5 に後回し、必要最小限 |
| DRY | :white_check_mark: | 既存の Worktree型、useWebSocket、useSwipeGesture を再利用 |

---

## 2. アーキテクチャ評価

### 2.1 構造的品質

| 評価項目 | スコア (1-5) | コメント |
|---------|------------|----------|
| モジュール性 | 4 | コンポーネント分離は良好。ただしContext数の増加に注意 |
| 結合度 | 4 | Context による疎結合。Sidebar ↔ MainContent 間の直接依存なし |
| 凝集度 | 5 | 各コンポーネントが単一の責務を持つ |
| 拡張性 | 4 | Compound Component で柔軟。将来のCLIツール追加にも対応可 |
| 保守性 | 4 | 既存パターン踏襲で学習コスト低い |

**総合スコア: 4.2 / 5**

### 2.2 パフォーマンス観点

| 項目 | 評価 | 詳細 |
|------|------|------|
| レスポンスタイム | :warning: 注意 | ブランチ選択時のデータ取得遅延に注意。楽観的UI更新を推奨 |
| スループット | :white_check_mark: 良好 | 既存ポーリング（5秒）を活用、追加負荷なし |
| リソース効率 | :warning: 注意 | 全ブランチのステータスを常時保持。大量ブランチ時にメモリ考慮 |
| スケーラビリティ | :white_check_mark: 良好 | React Context のスケールで十分（100ブランチ程度想定） |

### 2.3 既存コードとの整合性

#### 統合ポイント評価

| 既存コンポーネント | 整合性 | コメント |
|-------------------|--------|----------|
| `useWebSocket` | :white_check_mark: | そのまま活用可能。`session_status_changed` で即時反映 |
| `useWorktreeUIState` | :white_check_mark: | 変更不要。WorktreeDetail 内で独立して使用 |
| `useSwipeGesture` | :white_check_mark: | `useSwipeDrawer` 経由で再利用 |
| `WorktreeDetailRefactored` | :white_check_mark: | 変更最小限。AppShell の children として利用 |
| `MobileTabBar` | :white_check_mark: | 既存機能維持。ドロワーとは役割分離 |
| `MobileHeader` | :warning: | 拡張必要（ハンバーガーメニュー追加）。後方互換性に注意 |

---

## 3. セキュリティレビュー

### 3.1 OWASP Top 10 チェック

| 脆弱性 | 状態 | コメント |
|--------|------|----------|
| インジェクション | :white_check_mark: | 該当なし（新規APIエンドポイントなし） |
| 認証の破綻 | N/A | 認証機能なし |
| 機微データの露出 | :white_check_mark: | localStorage には表示設定のみ保存 |
| XXE | N/A | XML 使用なし |
| アクセス制御の不備 | N/A | ローカルアプリケーション |
| セキュリティ設定ミス | :white_check_mark: | 問題なし |
| XSS | :white_check_mark: | React 標準のエスケープで対策済み |
| 安全でないデシリアライゼーション | :white_check_mark: | JSON.parse のみ使用 |
| 既知の脆弱性 | :white_check_mark: | 新規依存なし |
| ログとモニタリング不足 | :white_check_mark: | 既存ログ機構を活用 |

**セキュリティリスク: 低**

---

## 4. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | Context 数増加による状態管理複雑化 | 中 | 中 | 中 |
| 技術的リスク | ブランチ選択時のデータ取得遅延 | 中 | 高 | 高 |
| 技術的リスク | 大量ブランチでのメモリ使用量増加 | 低 | 低 | 低 |
| UXリスク | モバイルでのドロワー操作の発見しにくさ | 中 | 中 | 中 |
| UXリスク | ページ遷移なしによるディープリンク不可 | 低 | 低 | 低 |
| 運用リスク | 既存MobileHeader変更時の後方互換性 | 中 | 中 | 中 |

---

## 5. 改善提案

### 5.1 必須改善項目（Must Fix）

#### 1. 楽観的UI更新の実装

**問題**: ブランチ選択時、API 取得完了まで UI が固まる可能性

**提案**:
```typescript
// 選択直後に UI を即時更新、バックグラウンドでデータ取得
const selectWorktree = useCallback((id: string) => {
  // 即時: 選択状態を更新
  dispatch({ type: 'SELECT_WORKTREE', id });

  // バックグラウンド: 詳細データ取得
  fetchWorktreeDetail(id).then(data => {
    dispatch({ type: 'SET_WORKTREE_DATA', data });
  });
}, []);
```

#### 2. MobileHeader 拡張時の後方互換性確保

**問題**: 既存の MobileHeader 使用箇所への影響

**提案**:
```typescript
// onMenuClick をオプショナルにし、未指定時はハンバーガー非表示
interface MobileHeaderProps {
  worktreeName: string;
  status: WorktreeStatus;
  onBackClick?: () => void;
  onMenuClick?: () => void;  // オプショナル
}

export function MobileHeader({ onMenuClick, ...props }: MobileHeaderProps) {
  return (
    <header>
      {onMenuClick && (
        <button onClick={onMenuClick}>
          <MenuIcon />
        </button>
      )}
      {/* ... */}
    </header>
  );
}
```

### 5.2 推奨改善項目（Should Fix）

#### 1. ブランチ選択のURL同期（オプション）

**提案**: ディープリンク対応として、選択ブランチをURLクエリパラメータに反映

```typescript
// URL例: /?branch=feature-123
const [selectedId, setSelectedId] = useState(() => {
  const params = new URLSearchParams(window.location.search);
  return params.get('branch') || null;
});

useEffect(() => {
  const url = new URL(window.location.href);
  if (selectedId) {
    url.searchParams.set('branch', selectedId);
  } else {
    url.searchParams.delete('branch');
  }
  window.history.replaceState({}, '', url);
}, [selectedId]);
```

#### 2. Context Provider の階層整理

**提案**: Provider の過度なネストを避けるため、複合 Provider を検討

```typescript
// src/providers/AppProviders.tsx
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <WorktreeSelectionProvider>
        {children}
      </WorktreeSelectionProvider>
    </SidebarProvider>
  );
}
```

#### 3. モバイルドロワーの発見しやすさ向上

**提案**: 初回利用時にツールチップまたはオンボーディング表示

```typescript
// 初回のみ表示
const [showHint, setShowHint] = useState(() => {
  return !localStorage.getItem('drawer-hint-shown');
});

{showHint && (
  <Tooltip target="hamburger-menu">
    タップしてブランチを切り替え
  </Tooltip>
)}
```

### 5.3 検討事項（Consider）

#### 1. 仮想スクロールの導入

大量ブランチ（100+）対応として、`react-virtual` などの仮想スクロールライブラリを検討

#### 2. 状態管理ライブラリへの移行パス

将来的に Zustand/Jotai への移行を視野に入れた設計。現時点では不要だが、Context が 5+ になった場合に再検討

#### 3. アクセシビリティ強化

- キーボードナビゲーションの ARIA 対応
- スクリーンリーダー対応の追加ラベル

---

## 6. ベストプラクティスとの比較

### 6.1 採用されていないパターン

| パターン | 採用状況 | 理由 |
|---------|---------|------|
| URL ルーティング | 不採用 | SPA的UX優先のため意図的に不採用。妥当 |
| Server State | 不採用 | リアルタイム性要件のため。妥当 |
| CSS-in-JS | 不採用 | Tailwind CSS 統一のため。妥当 |
| 仮想スクロール | 不採用 | 想定ブランチ数では過剰。妥当 |

### 6.2 独自実装の妥当性評価

| 実装 | 評価 | コメント |
|------|------|----------|
| useSwipeDrawer | :white_check_mark: | 既存 useSwipeGesture の軽量ラッパー。適切 |
| SidebarContext | :white_check_mark: | 標準的な React Context パターン。適切 |
| MobileDrawer | :white_check_mark: | シンプルな CSS Transition 実装。ライブラリ不要 |

---

## 7. 総合評価

### 7.1 レビューサマリ

**全体評価**: :star::star::star::star::star: **4.5 / 5**

#### 強み
- 既存アーキテクチャとの高い整合性
- コンポーネント分離が適切で保守性が高い
- モバイル対応が詳細に設計されている
- 既存 hook / WebSocket インフラの効果的な再利用
- テスト戦略が具体的

#### 弱み
- ブランチ選択時のUI応答性に改善余地
- Context 数増加による将来的な複雑性リスク
- ディープリンク非対応（ただし意図的決定）

#### 総評

Issue #22 の設計は、既存アーキテクチャを尊重しながら新機能を追加する堅実なアプローチです。SOLID原則への準拠、既存コードの再利用、モバイル対応の詳細設計など、品質面で高い水準にあります。

必須改善項目（楽観的UI更新、MobileHeader後方互換性）を対応すれば、実装着手に問題ありません。

### 7.2 承認判定

:white_check_mark: **承認（Approved）** - 2026-01-10 更新

#### 承認条件（対応済み）
1. ~~楽観的UI更新のパターンを設計に追加~~ :white_check_mark: 対応済み（セクション7.2）
2. ~~MobileHeader 拡張時の後方互換性を設計に明記~~ :white_check_mark: 対応済み（セクション9.2.4）

#### 次のステップ
1. `/issue-split` で実装 Issue に分割
2. Phase 1 から TDD で実装開始

---

## 付録: レビュー対象ファイル

### 設計書
- `dev-reports/design/issue-22-multitask-sidebar-design-policy.md`

### 参照した既存コード
- `src/hooks/useWebSocket.ts` - WebSocket 接続管理
- `src/hooks/useWorktreeUIState.ts` - UI 状態管理パターン
- `src/hooks/useSwipeGesture.ts` - スワイプジェスチャー検出
- `src/components/worktree/WorktreeDetailRefactored.tsx` - 既存詳細画面
- `src/components/worktree/WorktreeList.tsx` - 既存一覧画面
- `src/types/models.ts` - データモデル定義
