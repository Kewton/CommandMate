# アーキテクチャレビュー: Issue #54 セッション状態管理の改善

**レビュー日時**: 2026-01-15
**対象**: `dev-reports/design/issue54-session-state-management-design-policy.md`
**レビュアー**: Claude Code (Architecture Review)

---

## 1. 設計原則の遵守確認

### SOLID原則チェック

| 原則 | 評価 | コメント |
|------|------|----------|
| **S**ingle Responsibility | :white_check_mark: | `message-sync.ts`、`status-detector.ts`の分離は適切 |
| **O**pen/Closed | :white_check_mark: | WebSocketメッセージタイプの拡張が容易な設計 |
| **L**iskov Substitution | N/A | 継承関係なし |
| **I**nterface Segregation | :white_check_mark: | `StatusDetectionResult`インターフェースが適切に分離 |
| **D**ependency Inversion | :warning: | フロントエンドがAPIに直接依存（後述） |

### その他の原則

| 原則 | 評価 | コメント |
|------|------|----------|
| KISS原則 | :white_check_mark: | 楽観的UI更新とWebSocketの組み合わせはシンプル |
| YAGNI原則 | :warning: | Phase 4の「無限スクロール」は現時点で必要か要検討 |
| DRY原則 | :white_check_mark: | `mergeMessages()`によるロジックの集約は良好 |

---

## 2. アーキテクチャ評価

### 構造的品質

| 評価項目 | スコア(1-5) | コメント |
|---------|------------|----------|
| モジュール性 | 4 | 新規ファイル`message-sync.ts`、`status-detector.ts`の分離は適切 |
| 結合度 | 3 | WebSocketとHTTP APIの二重通信が結合度を上げている |
| 凝集度 | 4 | 各モジュールの責務が明確 |
| 拡張性 | 4 | 状態遷移図の定義により将来の状態追加が容易 |
| 保守性 | 4 | 型定義とテスト計画が整備されている |

### パフォーマンス観点

| 項目 | 評価 | コメント |
|------|------|----------|
| レスポンスタイム | :white_check_mark: 改善 | 楽観的UI更新により体感速度向上 |
| スループット | :white_check_mark: 改善 | WebSocket活用でポーリング頻度削減 |
| リソース使用効率 | :warning: 懸念 | インクリメンタル更新によるメモリ増加（後述） |
| スケーラビリティ | :white_check_mark: | WebSocketルームベースの設計で水平スケール可能 |

---

## 3. セキュリティレビュー

### OWASP Top 10 チェック

| チェック項目 | 評価 | コメント |
|-------------|------|----------|
| インジェクション対策 | :white_check_mark: | SQLite準備済みステートメント使用 |
| 認証の破綻対策 | N/A | 認証機能なし（ローカルツール） |
| 機微データの露出対策 | :white_check_mark: | ローカル通信のみ |
| XXE対策 | N/A | XML処理なし |
| アクセス制御の不備対策 | N/A | シングルユーザー想定 |
| セキュリティ設定ミス対策 | :white_check_mark: | デフォルト設定が安全 |
| XSS対策 | :warning: | WebSocketメッセージのサニタイズ要確認 |
| 安全でないデシリアライゼーション対策 | :warning: | `JSON.parse()`のエラーハンドリング要確認 |
| 既知の脆弱性対策 | :white_check_mark: | 依存関係は最新 |
| ログとモニタリング不足対策 | :white_check_mark: | console.logによる追跡可能 |

---

## 4. 既存システムとの整合性

### 統合ポイント

| ポイント | 評価 | コメント |
|---------|------|----------|
| API互換性 | :white_check_mark: | 後方互換性あり（`assistantMessage`はオプショナル） |
| データモデル整合性 | :white_check_mark: | `ALTER TABLE`による拡張で既存データ保持 |
| 認証/認可の一貫性 | N/A | 認証機能なし |
| ログ/監視の統合 | :white_check_mark: | 既存のconsole.logパターンに準拠 |

### 技術スタックの適合性

| 項目 | 評価 | コメント |
|------|------|----------|
| 既存技術との親和性 | :white_check_mark: | Next.js 14、TypeScript、SQLiteとの親和性良好 |
| チームのスキルセット | :white_check_mark: | 既存パターンの延長線上 |
| 運用負荷への影響 | :white_check_mark: | 既存のWebSocket基盤を活用 |

---

## 5. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| **技術的リスク** | 楽観的UI更新とサーバー状態の不整合 | 中 | 中 | 高 |
| **技術的リスク** | WebSocket切断時のフォールバック未定義 | 中 | 低 | 中 |
| **運用リスク** | メモリリーク（メッセージ配列の肥大化） | 高 | 中 | 高 |
| **セキュリティリスク** | WebSocketメッセージの検証不足 | 低 | 低 | 低 |
| **ビジネスリスク** | 実装工数の見積もり誤差 | 低 | 中 | 低 |

---

## 6. 改善提案

### 必須改善項目（Must Fix）

#### 6.1 楽観的UI更新のロールバック機構

**問題**: サーバーエラー時に楽観的に追加したメッセージが残り続ける

**修正案**:
```typescript
const handleMessageSent = useCallback(
  async (sentMessage: ChatMessage) => {
    const tempId = `temp-${Date.now()}`;

    // 楽観的UI更新
    actions.addOptimisticMessage(sentMessage, tempId);

    try {
      const response = await worktreeApi.sendMessage(...);
      // 成功: 一時IDを実IDに置換
      actions.confirmMessage(tempId, response.userMessage.id);
    } catch (error) {
      // 失敗: 楽観的メッセージを削除
      actions.removeMessage(tempId);
      // エラー通知
      actions.showError('メッセージ送信に失敗しました');
    }
  },
  [actions]
);
```

#### 6.2 メモリリーク対策

**問題**: `mergeMessages()`でメッセージが無限に増加する可能性

**修正案**:
```typescript
export function mergeMessages(
  existing: ChatMessage[],
  incoming: ChatMessage[],
  maxMessages: number = 200  // 上限を設定
): ChatMessage[] {
  const existingIds = new Set(existing.map(m => m.id));
  const newMessages = incoming.filter(m => !existingIds.has(m.id));

  const merged = [...existing, ...newMessages]
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // 古いメッセージを削除して上限を維持
  if (merged.length > maxMessages) {
    return merged.slice(-maxMessages);
  }
  return merged;
}
```

### 推奨改善項目（Should Fix）

#### 6.3 WebSocket切断時のフォールバック

**提案**: WebSocket切断時にポーリングにフォールバック

```typescript
useEffect(() => {
  let ws: WebSocket | null = null;
  let fallbackInterval: NodeJS.Timeout | null = null;

  const connect = () => {
    ws = new WebSocket(`ws://${window.location.host}/ws`);

    ws.onclose = () => {
      // フォールバック: ポーリング再開
      fallbackInterval = setInterval(() => {
        void fetchMessages();
      }, ACTIVE_POLLING_INTERVAL_MS);

      // 再接続試行
      setTimeout(connect, 5000);
    };

    ws.onopen = () => {
      // WebSocket復帰: ポーリング停止
      if (fallbackInterval) {
        clearInterval(fallbackInterval);
        fallbackInterval = null;
      }
    };
  };

  connect();

  return () => {
    ws?.close();
    if (fallbackInterval) clearInterval(fallbackInterval);
  };
}, [worktreeId]);
```

#### 6.4 状態検出の信頼度表示

**提案**: `confidence: 'low'`の場合、UIで視覚的フィードバック

```typescript
// ステータスインジケーターに信頼度を反映
const statusIndicatorClass = confidence === 'low'
  ? 'status-indicator status-indicator--uncertain'
  : 'status-indicator';
```

### 検討事項（Consider）

#### 6.5 Server-Sent Events (SSE) の検討

**理由**: WebSocketより軽量で、Next.js App Routerとの親和性が高い

**トレードオフ**:
- メリット: 接続管理がシンプル、HTTP/2対応
- デメリット: 双方向通信不可（現在はブロードキャストのみなので問題なし）

#### 6.6 React Query / SWR の導入検討

**理由**: キャッシュ管理、楽観的更新、エラーリトライが標準装備

```typescript
// React Query での実装例
const { data: messages, mutate } = useMutation({
  mutationFn: worktreeApi.sendMessage,
  onMutate: async (newMessage) => {
    // 楽観的更新
    await queryClient.cancelQueries(['messages', worktreeId]);
    const previous = queryClient.getQueryData(['messages', worktreeId]);
    queryClient.setQueryData(['messages', worktreeId], (old) => [...old, newMessage]);
    return { previous };
  },
  onError: (err, newMessage, context) => {
    // ロールバック
    queryClient.setQueryData(['messages', worktreeId], context.previous);
  },
});
```

---

## 7. ベストプラクティスとの比較

### 業界標準との差異

| パターン | 業界標準 | 本設計 | 評価 |
|---------|---------|--------|------|
| 状態管理 | Redux/Zustand | useReducer | :white_check_mark: 適切（コンポーネントローカル） |
| データフェッチ | React Query/SWR | カスタムフック | :warning: 検討の余地あり |
| リアルタイム通信 | WebSocket/SSE | WebSocket | :white_check_mark: 適切 |
| 楽観的UI | 標準パターン | カスタム実装 | :warning: ロールバック機構が不足 |

### 代替アーキテクチャ案

#### 代替案1: Event Sourcing

**説明**: メッセージをイベントとして扱い、状態を再構築

**メリット**:
- 完全な履歴追跡
- 状態の再現性

**デメリット**:
- 実装コストが高い
- オーバーエンジニアリングの可能性

**判断**: 不採用（現在のスケールでは過剰）

#### 代替案2: CRDT (Conflict-free Replicated Data Type)

**説明**: 衝突解決を自動化するデータ構造

**メリット**:
- オフライン対応
- マルチクライアント同期

**デメリット**:
- 学習コストが高い
- ライブラリ依存

**判断**: 不採用（シングルユーザー想定では不要）

---

## 8. 総合評価

### レビューサマリ

| 項目 | 評価 |
|------|------|
| **全体評価** | :star::star::star::star: (4/5) |
| **強み** | 問題の根本原因を正確に特定、段階的な実装計画、既存システムとの整合性 |
| **弱み** | 楽観的UI更新のエラーハンドリング不足、メモリリーク対策の欠如 |

### 詳細評価

| カテゴリ | スコア | コメント |
|---------|-------|----------|
| 問題分析 | 5/5 | レースコンディションの特定が正確 |
| 設計方針 | 4/5 | 方向性は適切、詳細に改善の余地 |
| 実装計画 | 4/5 | フェーズ分けが明確、工数見積もりは妥当 |
| テスト計画 | 3/5 | ユニットテストは良好、E2Eテストが薄い |
| リスク管理 | 3/5 | トレードオフの記載はあるが対策が不足 |

### 承認判定

:white_check_mark: **条件付き承認（Conditionally Approved）**

以下の条件を満たすこと:
1. 楽観的UI更新のロールバック機構を追加
2. メモリリーク対策（メッセージ上限）を実装
3. WebSocket切断時のフォールバック戦略を定義

---

## 9. 次のステップ

### 必須対応（実装前）

1. [ ] 設計方針書に「楽観的UI更新のロールバック」セクションを追加
2. [ ] `mergeMessages()`にメッセージ上限パラメータを追加
3. [ ] WebSocket切断時の動作仕様を明記

### 実装時の注意点

1. Phase 1完了後に動作確認を実施し、Phase 2に進む前にレビュー
2. E2Eテストケースを拡充（特にセッション切り替えシナリオ）
3. パフォーマンス計測（メモリ使用量の監視）

### ドキュメント更新

1. 設計方針書の改訂（本レビュー指摘事項の反映）
2. `CLAUDE.md`への機能追加記載
3. ユーザーガイドの更新（新しい動作の説明）

---

## 10. 参考資料

- [React公式: 楽観的UI更新](https://react.dev/reference/react/useOptimistic)
- [WebSocket接続管理のベストプラクティス](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [Issue #53 設計方針書](./issue53-assistant-response-save-design-policy.md)
