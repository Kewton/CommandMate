# Issue #42 アーキテクチャレビュー

| 項目 | 内容 |
|------|------|
| Issue | #42 |
| 対象ドキュメント | `dev-reports/design/issue42-proxy-routing-design-policy.md` |
| レビュー日 | 2026-01-15 |
| レビュアー | Claude Code |

---

## 1. 設計原則の遵守確認

### SOLID原則チェック

| 原則 | 評価 | コメント |
|------|------|---------|
| **S**ingle Responsibility | ✅ | プロキシ処理、DB操作、UI表示が適切に分離 |
| **O**pen/Closed | ✅ | `app_type` による拡張が可能な設計 |
| **L**iskov Substitution | ⚠️ | 外部アプリ抽象化インターフェース未定義 |
| **I**nterface Segregation | ⚠️ | プロキシハンドラーのインターフェース定義が必要 |
| **D**ependency Inversion | ✅ | DB操作関数経由で依存性を分離 |

### その他の原則

| 原則 | 評価 | コメント |
|------|------|---------|
| KISS | ✅ | シンプルな単一テーブル設計 |
| YAGNI | ✅ | 必要最小限の機能に絞られている |
| DRY | ⚠️ | CLIToolManagerとの共通パターン抽出を検討すべき |

---

## 2. アーキテクチャ評価

### 構造的品質

| 評価項目 | スコア(1-5) | コメント |
|---------|------------|----------|
| モジュール性 | 4 | 新規ディレクトリ構成が明確 |
| 結合度 | 4 | DB層とAPI層の分離が適切 |
| 凝集度 | 4 | 外部アプリ関連機能が集約 |
| 拡張性 | 3 | 新アプリ種別追加時のインターフェース未定義 |
| 保守性 | 4 | 既存パターン（CLITool）との整合性あり |

### パフォーマンス観点

| 項目 | 評価 | コメント |
|------|------|---------|
| レスポンスタイム | ⚠️ | 毎リクエストのDB参照がボトルネックの可能性 |
| スループット | ✅ | http-proxyは高性能 |
| リソース効率 | ✅ | 軽量なプロキシ実装 |
| スケーラビリティ | ✅ | 設計上の制約なし |

**改善提案**: パスプレフィックス → アプリ設定のキャッシュ層追加を推奨

---

## 3. セキュリティレビュー

### OWASP Top 10 チェック

| 項目 | 評価 | コメント |
|------|------|---------|
| インジェクション対策 | ✅ | SQLiteパラメタライズドクエリ使用想定 |
| 認証の破綻対策 | ➖ | 認証は各アプリに委任（スコープ外） |
| 機微データの露出対策 | ⚠️ | 設定ファイル経由のポート/ホスト情報露出リスク |
| XXE対策 | ➖ | 該当なし |
| アクセス制御の不備対策 | ⚠️ | 内部ネットワーク前提、外部公開時は要対策 |
| セキュリティ設定ミス対策 | ✅ | デフォルトでlocalhost制限 |
| XSS対策 | ✅ | Reactの標準エスケープ |
| 安全でないデシリアライゼーション対策 | ✅ | JSON.parse使用想定 |
| 既知の脆弱性対策 | ⚠️ | http-proxyの定期更新が必要 |
| ログとモニタリング不足対策 | ⚠️ | プロキシログ設計が未記載 |

### セキュリティリスク詳細

#### リスク1: SSRF (Server-Side Request Forgery)
- **リスクレベル**: 中
- **内容**: `target_host` を外部から変更可能な場合、内部ネットワークへの不正アクセスリスク
- **対策**: ホワイトリスト制限（localhost / 127.0.0.1）は設計済み ✅

#### リスク2: オープンプロキシ化
- **リスクレベル**: 中
- **内容**: 未登録パスプレフィックスへのアクセス時の挙動
- **対策**: 登録済みプレフィックスのみ許可は設計済み ✅
- **追加提案**: アクセスログの記録

---

## 4. 既存システムとの整合性

### CLIToolManagerとの比較

| 項目 | CLIToolManager | 外部アプリ（提案） | 整合性 |
|------|---------------|-------------------|--------|
| パターン | Singleton + Strategy | DB + Route Handler | ⚠️ 不統一 |
| 設定保存 | ハードコード | SQLite | ✅ 動的対応 |
| ステータス確認 | `isRunning()` | `/health` API | ✅ 類似 |
| インターフェース | `ICLITool` | 未定義 | ⚠️ 要定義 |

### 改善提案: インターフェース定義の追加

```typescript
// src/lib/external-apps/types.ts（追加提案）
export interface IExternalApp {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly pathPrefix: string;
  readonly targetPort: number;
  readonly targetHost: string;
  readonly appType: ExternalAppType;

  isHealthy(): Promise<boolean>;
  getProxyTarget(): string;
}

export interface IExternalAppManager {
  getApp(pathPrefix: string): Promise<IExternalApp | null>;
  getAllApps(): Promise<IExternalApp[]>;
  registerApp(config: ExternalAppConfig): Promise<IExternalApp>;
  unregisterApp(id: string): Promise<void>;
}
```

### 技術スタックの適合性

| 項目 | 評価 | コメント |
|------|------|---------|
| Next.js 14との親和性 | ✅ | Route Handlers活用 |
| TypeScriptとの親和性 | ✅ | 型定義計画あり |
| SQLiteとの親和性 | ✅ | 既存マイグレーション機構活用 |
| Tailwind CSSとの親和性 | ✅ | 既存UIパターン踏襲 |

---

## 5. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|:------:|:--------:|:----------:|
| 技術的リスク | WebSocket対応の複雑性 | 中 | 高 | **高** |
| 技術的リスク | http-proxyとNext.js App Routerの統合 | 中 | 中 | 中 |
| 運用リスク | App2側のbasePath設定ミス | 低 | 高 | 中 |
| 運用リスク | ポート競合 | 低 | 中 | 低 |
| セキュリティリスク | 内部ネットワーク露出 | 高 | 低 | 中 |
| パフォーマンスリスク | DB参照のオーバーヘッド | 低 | 高 | 中 |

### 高優先度リスク対策

#### WebSocket対応の複雑性
- **問題**: Next.js App RouterでのWebSocket Upgradeハンドリングが非標準
- **対策案**:
  1. Custom Server (`server.ts`) を導入しWebSocketを別ハンドリング
  2. `/proxy/*` をNext.js外（Nginx）で処理
  3. `http-proxy`の`ws`オプションを活用（設計方針通り）
- **推奨**: 設計方針通り進め、問題発生時にCustom Server検討

---

## 6. 改善提案

### 必須改善項目（Must Fix）

#### 1. インターフェース定義の追加
**理由**: CLIToolManagerと同様のパターンで拡張性を確保

```typescript
// 追加ファイル: src/lib/external-apps/types.ts
export type ExternalAppType = 'sveltekit' | 'streamlit' | 'nextjs' | 'other';

export interface ExternalApp {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  pathPrefix: string;
  targetPort: number;
  targetHost: string;
  appType: ExternalAppType;
  websocketEnabled: boolean;
  websocketPathPattern?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
```

#### 2. キャッシュ層の追加
**理由**: 毎リクエストのDB参照を回避

```typescript
// src/lib/external-apps/cache.ts
class ExternalAppCache {
  private cache: Map<string, ExternalApp> = new Map();
  private lastRefresh: number = 0;
  private readonly TTL = 30000; // 30秒

  async getByPathPrefix(prefix: string): Promise<ExternalApp | null> {
    if (this.isStale()) {
      await this.refresh();
    }
    return this.cache.get(prefix) ?? null;
  }
}
```

#### 3. プロキシログ設計の追加
**理由**: トラブルシューティングとセキュリティ監査のため

```typescript
// ログ形式
interface ProxyLog {
  timestamp: number;
  pathPrefix: string;
  method: string;
  path: string;
  statusCode: number;
  responseTime: number;
  error?: string;
}
```

### 推奨改善項目（Should Fix）

#### 1. ヘルスチェックの定期実行
**提案**: ポーリングによる自動ステータス更新

```typescript
// 既存のサイドバーステータス監視と同様のパターン
setInterval(async () => {
  const apps = await getAllExternalApps();
  for (const app of apps) {
    const healthy = await checkHealth(app);
    updateStatus(app.id, healthy);
  }
}, 10000); // 10秒間隔
```

#### 2. エラーページのカスタマイズ
**提案**: App2が停止中の場合の専用エラーページ

```tsx
// src/app/proxy/[...path]/error.tsx
export default function ProxyErrorPage({ app, error }: Props) {
  return (
    <div className="flex flex-col items-center justify-center h-screen">
      <h1>サービス利用不可</h1>
      <p>{app.displayName} は現在停止中です</p>
      <p>ポート: {app.targetPort}</p>
    </div>
  );
}
```

### 検討事項（Consider）

#### 1. リトライ機構
- 上流接続失敗時の自動リトライ（最大3回、指数バックオフ）

#### 2. サーキットブレーカー
- 連続失敗時の一時的なプロキシ停止

#### 3. メトリクス収集
- リクエスト数、レスポンスタイム、エラー率の記録

---

## 7. ベストプラクティスとの比較

### 業界標準との差異

| 項目 | 業界標準 | 本設計 | 評価 |
|------|---------|--------|------|
| リバースプロキシ | Nginx / Traefik | Next.js Route Handler | ⚠️ 非標準だが要件に適合 |
| 設定管理 | 環境変数 / ConfigMap | SQLite | ✅ 動的変更要件に適合 |
| WebSocket | 専用サーバー | http-proxy統合 | ⚠️ 検証必要 |

### 代替アーキテクチャ案

#### 代替案1: Nginx サイドカー
```
Client → Nginx → App1 (Next.js)
              → App2 (SvelteKit)
              → App3 (Streamlit)
```

| 項目 | 評価 |
|------|------|
| メリット | WebSocket安定、高性能、業界標準 |
| デメリット | 動的設定変更にreload必要、構成複雑化 |
| 推奨度 | ⭐⭐⭐☆☆ |

#### 代替案2: Custom Server (server.ts)
```typescript
// server.ts
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import httpProxy from 'http-proxy';

const proxy = httpProxy.createProxyServer({ ws: true });
const app = next({ dev: process.env.NODE_ENV !== 'production' });
const handle = app.getRequestHandler();

createServer((req, res) => {
  const { pathname } = parse(req.url!, true);

  if (pathname?.startsWith('/proxy/')) {
    // プロキシ処理
    proxy.web(req, res, { target: getTarget(pathname) });
  } else {
    handle(req, res);
  }
}).listen(3000);
```

| 項目 | 評価 |
|------|------|
| メリット | WebSocket完全対応、柔軟な制御 |
| デメリット | Vercelデプロイ不可（オンプレなので問題なし）、実装コスト増 |
| 推奨度 | ⭐⭐⭐⭐☆ |

---

## 8. 総合評価

### レビューサマリ

| 項目 | 評価 |
|------|------|
| **全体評価** | ⭐⭐⭐⭐☆（4/5） |
| **強み** | 既存アーキテクチャとの整合性、シンプルなDB設計、明確な実装ロードマップ |
| **弱み** | WebSocket対応の不確実性、インターフェース抽象化不足、キャッシュ未考慮 |

### 総評

Issue #42の設計方針は、MyCodeBranchDeskの既存アーキテクチャを踏襲しつつ、動的なルーティング設定という要件に適切に対応しています。

特に以下の点が評価できます：
- SQLiteベースの設定管理による再起動不要の動的変更
- CLIToolManagerと類似したパターンによる一貫性
- 段階的な実装ロードマップ

一方、以下の点は実装時に注意が必要です：
- WebSocketプロキシのNext.js App Router上での動作検証
- パフォーマンス最適化（キャッシュ層）
- 運用監視（プロキシログ）

### 承認判定

- [ ] 承認（Approved）
- [x] **条件付き承認（Conditionally Approved）**
- [ ] 要再設計（Needs Major Changes）

### 承認条件

1. **必須**: インターフェース定義（`IExternalApp`, `ExternalApp`型）の追加
2. **必須**: キャッシュ層設計の追加
3. **推奨**: プロキシログ設計の追加

### 次のステップ

1. 上記承認条件を設計方針書に反映
2. WebSocket対応のPOC（Proof of Concept）実施
3. Issue分割（`/issue-split`）で段階的実装計画を策定
4. Phase 1（DBスキーマ）から実装開始

---

## 付録: チェックリスト

### 実装前確認事項

- [ ] `http-proxy` パッケージのインストール確認
- [ ] Next.js App RouterでのWebSocket Upgrade動作確認
- [ ] Streamlit WebSocket（`/_stcore/stream`）の疎通確認
- [ ] 既存のマイグレーション機構との互換性確認

### テスト計画

| テスト種別 | 対象 | 優先度 |
|-----------|------|--------|
| 単体テスト | DB操作関数 | 高 |
| 単体テスト | プロキシハンドラー | 高 |
| 結合テスト | HTTP プロキシ E2E | 高 |
| 結合テスト | WebSocket プロキシ | 高 |
| UIテスト | ExternalAppsManager | 中 |
