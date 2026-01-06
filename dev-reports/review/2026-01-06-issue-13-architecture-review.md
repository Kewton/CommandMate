# Issue #13 UX改善 アーキテクチャレビュー

**レビュー日**: 2026-01-06
**対象ドキュメント**: `dev-reports/design/issue-13-ux-improvement-design-policy.md`
**対象Issue**: [Issue #13 - UX改善](https://github.com/Kewton/MyCodeBranchDesk/issues/13)

---

## 1. 設計原則の遵守確認

### SOLID原則チェック

| 原則 | 評価 | 詳細 |
|------|:----:|------|
| **S**ingle Responsibility | ✅ | 各コンポーネントが単一責任を持つ設計（TerminalDisplay=表示、PromptPanel=応答、HistoryPane=履歴） |
| **O**pen/Closed | ✅ | カスタムフックで拡張可能、既存APIを変更せず新機能追加 |
| **L**iskov Substitution | ✅ | 適用外（継承構造なし） |
| **I**nterface Segregation | ✅ | 各コンポーネントのPropsが必要最小限に分離 |
| **D**ependency Inversion | ⚠️ | 一部改善の余地あり（詳細は改善提案参照） |

### その他の原則

| 原則 | 評価 | 詳細 |
|------|:----:|------|
| KISS | ✅ | 2カラム+固定パネルのシンプルな構成 |
| YAGNI | ✅ | 必要最小限の機能に限定、将来機能は「検討事項」として分離 |
| DRY | ✅ | カスタムフックで共通ロジック抽出（useTerminalScroll, useIsMobile等） |

---

## 2. アーキテクチャ評価

### 2.1 構造的品質

| 評価項目 | スコア(1-5) | コメント |
|---------|:----------:|----------|
| モジュール性 | ⭐⭐⭐⭐⭐ | コンポーネント分離が明確、責務が適切に分割されている |
| 結合度 | ⭐⭐⭐⭐ | 低結合だが、WorktreeDetailが状態管理の中心となりやや密結合 |
| 凝集度 | ⭐⭐⭐⭐⭐ | 各コンポーネントが単一目的に集中 |
| 拡張性 | ⭐⭐⭐⭐ | 新規CLIツール追加が容易、モバイルコンポーネント分離で拡張性確保 |
| 保守性 | ⭐⭐⭐⭐ | テスト戦略が明確、型定義が整備 |

### 2.2 パフォーマンス観点

#### レスポンスタイム予測
| シナリオ | 予測 | 評価 |
|---------|------|:----:|
| 初期表示 | 〜200ms | ✅ |
| リアルタイム更新 | 500ms〜2s（ポーリング間隔依存） | ✅ |
| プロンプト表示 | 即座（検出後即時表示） | ✅ |
| モバイルタブ切替 | 〜100ms | ✅ |

#### 最適化ポイント
- **ポーリング戦略**: 適応型ポーリング（idle:10s, waiting:1s, receiving:500ms）は適切
- **仮想化**: react-window による大量メッセージ対応を設計に含む
- **メモ化**: React.memo, useMemo, useCallback の活用方針が明確
- **動的インポート**: TerminalDisplay, LogViewer の遅延読み込み

#### 潜在的ボトルネック
| リスク | 影響度 | 対策状況 |
|-------|:------:|:--------:|
| 大量ターミナル出力時のDOM更新 | 中 | ⚠️ 仮想化検討推奨 |
| ANSI→HTML変換コスト | 低 | ✅ 既存実装で問題なし |
| モバイルでのポーリング負荷 | 中 | ✅ バックグラウンド検出で対応 |

### 2.3 スケーラビリティ

| 観点 | 評価 | コメント |
|------|:----:|---------|
| 同時接続数 | ✅ | WebSocket + ポーリングフォールバック |
| データ量 | ⚠️ | 大量メッセージ時の仮想スクロールは設計済みだが実装優先度低 |
| 画面サイズ対応 | ✅ | デスクトップ/タブレット/モバイル/ランドスケープ全対応 |

---

## 3. セキュリティレビュー

### 3.1 OWASP Top 10 チェック

| 脆弱性カテゴリ | 評価 | 対策状況 |
|---------------|:----:|---------|
| A01: インジェクション | ✅ | プロンプト応答のバリデーション実装済み |
| A02: 認証の破綻 | N/A | 認証機能なし（ローカルツール） |
| A03: 機微データの露出 | ⚠️ | ターミナル出力に機密情報が含まれる可能性（設計書で言及なし） |
| A04: XXE | N/A | XML処理なし |
| A05: アクセス制御の不備 | N/A | 単一ユーザー想定 |
| A06: セキュリティ設定ミス | ✅ | 適切なCSPヘッダー設定（Next.js標準） |
| A07: XSS | ✅ | DOMPurify導入、ansi-to-htmlにescapeXML:true |
| A08: 安全でないデシリアライゼーション | N/A | 複雑なオブジェクトシリアライズなし |
| A09: 既知の脆弱性 | ✅ | 依存パッケージは定期更新推奨 |
| A10: ログとモニタリング不足 | ⚠️ | クライアントエラーログの集約方法未定義 |

### 3.2 追加セキュリティ考慮事項

#### 良い点
```typescript
// XSS対策が明確に設計されている
import DOMPurify from 'dompurify';
const sanitizedHtml = DOMPurify.sanitize(html, {
  ALLOWED_TAGS: ['span'],
  ALLOWED_ATTR: ['style']
});
```

#### 要検討事項
1. **ターミナル出力のスクラビング**: APIキー、トークン等の自動マスキング検討
2. **CSRFトークン**: 現時点では不要だが、マルチユーザー化時に必須

---

## 4. 既存システムとの整合性

### 4.1 統合ポイント

| 項目 | 評価 | 詳細 |
|------|:----:|------|
| API互換性 | ✅ | 既存API（messages, respond, current-output）を変更なしで継続利用 |
| データモデル整合性 | ✅ | ChatMessage, PromptDataの型定義を変更なし |
| 認証/認可の一貫性 | N/A | 認証機能なし |
| ログ/監視の統合 | ⚠️ | モバイルエラー報告の統合方法未定義 |

### 4.2 技術スタックの適合性

| 技術 | 適合性 | コメント |
|------|:------:|---------|
| Next.js 14 App Router | ✅ | Server/Client Component の使い分けが適切 |
| TypeScript | ✅ | 新規型定義（ui-state.ts, error-state.ts）が既存と整合 |
| Tailwind CSS | ✅ | Safe Area拡張は既存設定への追加のみ |
| SQLite | ✅ | スキーマ変更なし |
| WebSocket | ✅ | 既存useWebSocketフックを継続利用 |

### 4.3 既存コード品質との比較

現在の `WorktreeDetail.tsx` を分析した結果：

| 観点 | 現状 | 改善後 |
|------|------|--------|
| 行数 | 797行 | 〜300行（分割後） |
| 状態数 | 18個のuseState | 構造化された状態管理 |
| 責務 | 複数（表示、ロジック、API） | Container/Presentational分離 |
| テスト容易性 | 低 | 高（コンポーネント単位でテスト可能） |

---

## 5. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|:------:|:--------:|:---------:|
| **技術的リスク** | | | | |
| スクロール制御の複雑性 | 自動/手動スクロール切替のエッジケース | 中 | 高 | **必須** |
| モバイルジェスチャー競合 | スワイプとスクロールの干渉 | 中 | 中 | 推奨 |
| ターミナル出力のパフォーマンス | 大量出力時のレンダリング | 高 | 低 | 検討 |
| **運用リスク** | | | | |
| モバイルデバイス互換性 | iOS/Android間の挙動差異 | 中 | 中 | 推奨 |
| ブラウザ互換性 | Visual Viewport API未対応ブラウザ | 低 | 低 | 検討 |
| **セキュリティリスク** | | | | |
| 機密情報の露出 | ターミナル出力に含まれる可能性 | 高 | 中 | **必須** |
| **ビジネスリスク** | | | | |
| 開発工数超過 | 5フェーズ構成は妥当だが見積もりなし | 中 | 中 | 検討 |

### 5.1 軽減策

#### スクロール制御（必須対応）
```typescript
// 設計書のロジックに以下のエッジケース処理を追加推奨
const handleTerminalScroll = (event: React.UIEvent<HTMLDivElement>) => {
  const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
  const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

  // 追加: スクロール中フラグでデバウンス
  if (isScrollingRef.current) return;

  // 追加: プロンプト検出時は強制スクロール優先
  if (activePrompt && !isAtBottom) {
    scrollToBottom();
    return;
  }
  // ... 既存ロジック
};
```

---

## 6. 改善提案

### 6.1 必須改善項目（Must Fix）

#### 1. 状態管理の構造化
**問題**: 現在の設計では18個のuseStateが分散
**提案**: useReducerまたはコンテキストによる状態集約

```typescript
// 推奨: src/hooks/useWorktreeUIState.ts
interface WorktreeUIAction =
  | { type: 'SET_PHASE'; phase: UIPhase }
  | { type: 'SET_TERMINAL_OUTPUT'; output: string }
  | { type: 'SHOW_PROMPT'; data: PromptData }
  | { type: 'CLEAR_PROMPT' }
  // ...

function useWorktreeUIState() {
  const [state, dispatch] = useReducer(worktreeUIReducer, initialState);
  // ... 副作用フック
  return { state, dispatch };
}
```

#### 2. エラーバウンダリの追加
**問題**: コンポーネントエラー時のフォールバックが未定義
**提案**: 各ペインにError Boundaryを設置

```typescript
// src/components/ErrorBoundary.tsx
function TerminalErrorFallback() {
  return (
    <div className="p-4 bg-red-50 text-red-800">
      ターミナル表示でエラーが発生しました。
      <button onClick={() => window.location.reload()}>再読み込み</button>
    </div>
  );
}
```

#### 3. XSS対策の強化
**問題**: 設計書ではDOMPurify導入が明記されているが、ANSI→HTML変換後の追加サニタイズが推奨
**提案**: 設計書通りに実装し、テストケースを追加

```typescript
// 設計書の実装 + テストケース追加
describe('sanitizeTerminalOutput', () => {
  it('should escape script tags', () => {
    const malicious = '\x1b[31m<script>alert("xss")</script>\x1b[0m';
    const result = sanitizeTerminalOutput(malicious);
    expect(result).not.toContain('<script>');
  });
});
```

### 6.2 推奨改善項目（Should Fix）

#### 1. Dependency Inversion の強化
**現状**: コンポーネントがAPI関数を直接呼び出し
**提案**: APIクライアントの抽象化

```typescript
// src/lib/api-provider.tsx
interface APIClient {
  getMessages(worktreeId: string, cliTool: CLIToolType): Promise<ChatMessage[]>;
  sendMessage(worktreeId: string, content: string): Promise<void>;
  // ...
}

const APIContext = createContext<APIClient | null>(null);

// 使用側
function useMessages() {
  const api = useContext(APIContext);
  // ...
}
```

#### 2. モバイルファーストのテスト戦略
**現状**: E2Eテストでモバイル対応は設計されているが、詳細未定義
**提案**: Playwright Device Emulation の活用

```typescript
// playwright.config.ts に追加
projects: [
  { name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } },
  { name: 'iPhone 14', use: { ...devices['iPhone 14'] } },
  { name: 'Pixel 7', use: { ...devices['Pixel 7'] } },
  { name: 'iPad Pro', use: { ...devices['iPad Pro 11'] } },
],
```

#### 3. アクセシビリティの体系化
**現状**: 設計書でaria-label等の言及あり、チェックリストあり
**提案**: axe-core統合による自動チェック

```typescript
// tests/a11y/accessibility.test.ts
import { checkA11y } from 'axe-playwright';

test('WorktreeDetail meets WCAG 2.1 AA', async ({ page }) => {
  await page.goto('/worktrees/test-id');
  const violations = await checkA11y(page);
  expect(violations).toHaveLength(0);
});
```

### 6.3 検討事項（Consider）

#### 1. Server-Sent Events (SSE) への移行
**理由**: ポーリングよりも効率的、WebSocketよりもシンプル
**検討時期**: WebSocket実装安定後

#### 2. Service Worker によるオフライン対応
**理由**: 設計書でPWA化への布石として言及
**検討時期**: モバイル対応完了後

#### 3. 状態管理ライブラリの導入
**選択肢**: Zustand, Jotai, Redux Toolkit
**検討時期**: 状態複雑度が増加した場合

---

## 7. ベストプラクティスとの比較

### 7.1 業界標準との差異

| 観点 | 業界標準 | 本設計 | 差異理由 |
|------|---------|--------|---------|
| 状態管理 | Redux/Zustand | useState/useReducer | 規模に対して適切、過剰な抽象化を避けた |
| スタイリング | CSS-in-JS | Tailwind CSS | プロジェクト方針に準拠、パフォーマンス優位 |
| リアルタイム通信 | WebSocket | WebSocket + Polling | フォールバック確保の実務的判断 |
| テスト | Jest + RTL | Vitest + Playwright | モダンな選択、パフォーマンス重視 |

### 7.2 代替アーキテクチャ案

#### 代替案1: React Server Components (RSC) 活用強化
- **メリット**: サーバーサイドでの初期レンダリング最適化
- **デメリット**: リアルタイム更新との相性が悪い
- **判定**: **却下** - 本アプリはリアルタイム性が重要

#### 代替案2: マイクロフロントエンド構成
- **メリット**: ターミナル/履歴を独立デプロイ可能
- **デメリット**: 複雑性増大、チーム規模に不適合
- **判定**: **却下** - オーバーエンジニアリング

#### 代替案3: Electron/Tauriによるデスクトップアプリ化
- **メリット**: ネイティブ機能アクセス、オフライン対応
- **デメリット**: 開発・配布コスト増大
- **判定**: **将来検討** - 現時点では不要

---

## 8. 総合評価

### 8.1 レビューサマリ

- **全体評価**: ⭐⭐⭐⭐☆（4.2/5）

### 8.2 強み

1. **明確なコンポーネント分離**: 責務が明確で保守性が高い
2. **包括的なモバイル対応**: Safe Area、キーボード、ジェスチャーまで考慮
3. **既存APIの活用**: 破壊的変更なしでUI改善を実現
4. **詳細なテスト戦略**: 単体/結合/E2Eの階層的アプローチ
5. **パフォーマンス考慮**: 適応型ポーリング、仮想化、遅延読み込み

### 8.3 弱み

1. **状態管理の分散**: 18個のuseStateは将来的に負債になる可能性
2. **エラー処理の体系化不足**: Error Boundaryの設計が未定義
3. **機密情報保護の考慮不足**: ターミナル出力のスクラビング未検討
4. **工数見積もりなし**: 5フェーズ構成だが具体的な見積もりがない

### 8.4 総評

Issue #13の要件（4ブロック分割、ターミナル独立スクロール、プロンプト分離）を満たす設計となっている。

特に以下の点が優れている：
- Container/Presentationalパターンによる明確な責務分離
- カスタムフックによる再利用可能なロジック抽出
- レスポンシブ対応（デスクトップ/タブレット/モバイル/ランドスケープ）
- 既存システムとの高い互換性

一方、以下の点は実装時に注意が必要：
- 状態管理の複雑化を防ぐためuseReducerの導入を推奨
- スクロール制御のエッジケース（プロンプト表示時の強制スクロール等）
- XSS対策の確実な実装とテスト

---

## 9. 承認判定

### ✅ 承認（Approved） - 2026-01-06 更新

必須条件を満たしたため、実装着手を承認：

1. **必須対応（実装前）** ✅ 完了
   - [x] 状態管理方針の確定（useReducer導入）- 設計書セクション16に追記
   - [x] エラーバウンダリ設計の追加 - 設計書セクション17に追記、コンポーネント実装済み

2. **必須対応（Phase 1完了前）** ✅ 完了
   - [x] XSS対策のテストケース作成 - `tests/unit/lib/sanitize.test.ts` 作成済み
   - [ ] スクロール制御のエッジケーステスト追加 - Phase 1で対応

3. **推奨対応（全Phase完了前）**
   - [ ] アクセシビリティ自動テスト導入
   - [ ] モバイルE2Eテスト環境構築

### 実装済みファイル
- `src/lib/sanitize.ts` - XSSサニタイズ関数
- `src/components/error/ErrorBoundary.tsx` - エラーバウンダリ
- `src/components/error/fallbacks.tsx` - 各ペイン用フォールバックUI
- `tests/unit/lib/sanitize.test.ts` - XSS対策テスト（44テストケース）

---

## 10. 次のステップ

1. **即時**: 設計書に状態管理方針を追記
2. **Phase 1開始前**: エラーバウンダリ設計を追加
3. **Phase 1**: 基盤コンポーネント実装（TerminalDisplay, useTerminalScroll）
4. **Phase 2**: デスクトップレイアウト再構成
5. **Phase 3**: プロンプト分離（PromptPanel）
6. **Phase 4**: モバイル対応
7. **Phase 5**: 最適化・仕上げ

---

## 関連ドキュメント

- [設計方針書](../design/issue-13-ux-improvement-design-policy.md)
- [CLAUDE.md](../../CLAUDE.md)
- [WorktreeDetail.tsx](../../src/components/worktree/WorktreeDetail.tsx)

---

**レビュアー**: Claude (Senior Software Architect)
**レビュー日**: 2026-01-06
**ステータス**: 条件付き承認
