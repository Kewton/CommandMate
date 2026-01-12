# アーキテクチャレビュー: Issue #41 ステータス管理のログ強化

**レビュー日**: 2026-01-12
**対象**: `dev-reports/design/issue41-structured-logging-design-policy.md`
**レビュアー**: Claude (Architecture Review)

---

## 1. 設計原則の遵守確認

### SOLID原則チェック

| 原則 | 準拠状況 | コメント |
|------|---------|---------|
| **S**ingle Responsibility | :white_check_mark: | Logger は「構造化ログ出力」という単一責任を持つ |
| **O**pen/Closed | :white_check_mark: | フォーマッタは Strategy パターンで拡張可能 |
| **L**iskov Substitution | N/A | 継承を使用しないため該当なし |
| **I**nterface Segregation | :white_check_mark: | Logger インターフェースは最小限のメソッドのみ |
| **D**ependency Inversion | :warning: | 直接 `console.*` に依存（後述） |

### その他の原則

| 原則 | 準拠状況 | コメント |
|------|---------|---------|
| KISS | :white_check_mark: | 外部依存なし、console ベースでシンプル |
| YAGNI | :white_check_mark: | ファイル出力等の将来機能は未実装 |
| DRY | :white_check_mark: | createLogger() で共通化 |

---

## 2. アーキテクチャ評価

### 構造的品質

| 評価項目 | スコア(1-5) | コメント |
|---------|------------|----------|
| モジュール性 | 4 | Logger は独立したユーティリティとして設計 |
| 結合度 | 4 | 各モジュールは Logger のみに依存 |
| 凝集度 | 5 | Logger 内の機能は高い凝集度を持つ |
| 拡張性 | 4 | withContext、フォーマット切替は良設計 |
| 保守性 | 4 | シンプルな実装で保守しやすい |

### パフォーマンス観点

| 項目 | 評価 | コメント |
|------|------|---------|
| レスポンスタイム | :white_check_mark: | ログレベルによる早期リターンで影響最小化 |
| スループット | :white_check_mark: | 同期出力だが console は十分高速 |
| リソース使用効率 | :white_check_mark: | メモリ使用は最小限 |
| スケーラビリティ | :warning: | 大量ログ時のバッファリング未考慮（後述） |

---

## 3. セキュリティレビュー

### OWASP Top 10 チェック

| 項目 | 状態 | コメント |
|------|------|---------|
| インジェクション対策 | :white_check_mark: | ログ出力のみ、入力処理なし |
| 認証の破綻対策 | N/A | 認証機能なし |
| 機微データの露出対策 | :warning: | **要注意**: ログに機密情報が含まれる可能性（後述） |
| XXE対策 | N/A | XML処理なし |
| アクセス制御の不備対策 | N/A | アクセス制御なし |
| セキュリティ設定ミス対策 | :white_check_mark: | デフォルト値が安全側 |
| XSS対策 | N/A | HTMLレンダリングなし |
| 安全でないデシリアライゼーション対策 | N/A | デシリアライゼーションなし |
| 既知の脆弱性対策 | :white_check_mark: | 外部依存なし |
| ログとモニタリング不足対策 | :white_check_mark: | 本設計の主目的 |

### 機密情報の漏洩リスク

設計書の例に `lastFewLines` としてターミナル出力の一部を記録する箇所がある:

```typescript
log.debug('captureSessionOutput:success', {
  actualLines,
  lastFewLines: output.split('\n').slice(-3).join(' | '),
});
```

**リスク**: ターミナル出力に認証情報や機密データが含まれる可能性がある。

---

## 4. 既存システムとの整合性

### 統合ポイント

| 項目 | 状態 | コメント |
|------|------|---------|
| API互換性 | :white_check_mark: | 既存APIへの影響なし |
| データモデル整合性 | :white_check_mark: | データモデルへの変更なし |
| 認証/認可の一貫性 | N/A | 認証機能なし |
| ログ/監視の統合 | :white_check_mark: | 既存 console.* との互換性維持 |

### 技術スタックの適合性

| 項目 | 状態 | コメント |
|------|------|---------|
| Next.js 14 との親和性 | :white_check_mark: | Server/Client 両方で動作可能 |
| TypeScript との親和性 | :white_check_mark: | 完全な型定義 |
| 既存環境変数パターン | :white_check_mark: | `MCBD_*` 命名規則に準拠 |

### 環境変数の一貫性

既存の `src/lib/env.ts` との整合性を確認:

| 既存パターン | 新規変数 | 整合性 |
|-------------|---------|--------|
| `MCBD_ROOT_DIR` | `MCBD_LOG_LEVEL` | :white_check_mark: プレフィックス一致 |
| `MCBD_PORT` | `MCBD_LOG_FORMAT` | :white_check_mark: プレフィックス一致 |

**推奨**: 新しい環境変数を `src/lib/env.ts` の `Env` インターフェースに追加することを検討。

---

## 5. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 大量ログによるパフォーマンス低下 | 中 | 低 | 中 |
| 技術的リスク | Next.js SSR/SSG でのログ出力混乱 | 中 | 中 | 高 |
| セキュリティリスク | 機密情報のログ出力 | 高 | 中 | 高 |
| 運用リスク | ログレベル設定漏れ | 低 | 中 | 低 |
| 運用リスク | 既存 console.* との混在による混乱 | 中 | 高 | 中 |

---

## 6. 改善提案

### 6.1 必須改善項目（Must Fix）

#### MF-1: 機密情報フィルタリングの追加

**問題**: ターミナル出力を直接ログに出力すると、認証トークンやパスワードが漏洩する可能性がある。

**対策**: センシティブデータのマスキング機能を追加。

```typescript
// 提案: センシティブパターンのマスキング
const SENSITIVE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,  // Bearer トークン
  /password[=:]\s*\S+/gi,              // パスワード
  /token[=:]\s*\S+/gi,                 // トークン
  /MCBD_AUTH_TOKEN=\S+/gi,             // 環境変数
];

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...data };
  for (const key in sanitized) {
    if (typeof sanitized[key] === 'string') {
      let value = sanitized[key] as string;
      for (const pattern of SENSITIVE_PATTERNS) {
        value = value.replace(pattern, '[REDACTED]');
      }
      sanitized[key] = value;
    }
  }
  return sanitized;
}
```

#### MF-2: Server/Client ログの分離

**問題**: Next.js では Server Components と Client Components でログの扱いが異なる。

**対策**: 実行環境を検出してログ出力先を適切に選択。

```typescript
function isServer(): boolean {
  return typeof window === 'undefined';
}

function log(level: LogLevel, ...): void {
  // ...
  const entry = formatLogEntry(...);

  // Server側のみ構造化ログを出力
  if (isServer()) {
    switch (level) {
      case 'error': console.error(entry); break;
      case 'warn': console.warn(entry); break;
      default: console.log(entry);
    }
  } else {
    // Client側は開発時のみ出力（本番では抑制）
    if (process.env.NODE_ENV === 'development') {
      console[level](entry);
    }
  }
}
```

### 6.2 推奨改善項目（Should Fix）

#### SF-1: 環境変数の型安全な取得

**現状**: `process.env.MCBD_LOG_LEVEL?.toLowerCase()` で直接アクセス。

**改善**: 既存の `src/lib/env.ts` パターンに統合。

```typescript
// src/lib/env.ts に追加
export interface Env {
  // ... 既存
  MCBD_LOG_LEVEL?: LogLevel;
  MCBD_LOG_FORMAT?: 'json' | 'text';
}

export function getEnv(): Env {
  // ... 既存のバリデーションロジック
  const logLevel = process.env.MCBD_LOG_LEVEL?.toLowerCase();
  const logFormat = process.env.MCBD_LOG_FORMAT?.toLowerCase();

  return {
    // ... 既存
    MCBD_LOG_LEVEL: isValidLogLevel(logLevel) ? logLevel : undefined,
    MCBD_LOG_FORMAT: logFormat === 'json' ? 'json' : 'text',
  };
}
```

#### SF-2: ログエントリへの一意識別子追加

**提案**: 関連するログをグループ化するためのリクエストIDを追加。

```typescript
interface LogEntry {
  // ... 既存
  requestId?: string;  // リクエスト単位でのトレース用
}

// 使用例
const requestId = crypto.randomUUID();
const log = logger.withContext({ worktreeId, cliToolId, requestId });
```

#### SF-3: ログ出力の同期/非同期選択

**現状**: 同期出力のみ。

**改善案**: 高負荷時のバッファリングオプションを検討。

```typescript
interface LoggerOptions {
  async?: boolean;  // 非同期バッファリング
  batchSize?: number;  // バッチサイズ
  flushInterval?: number;  // フラッシュ間隔
}
```

**判断**: 現時点では YAGNI に基づき不採用。将来課題として記録。

### 6.3 検討事項（Consider）

#### C-1: 構造化ログクエリツールの検討

将来的にログ分析が必要になった場合に備え、以下を検討:

- `jq` による JSON ログのフィルタリング
- ログビューワーUI の追加
- Grafana Loki 等への連携

#### C-2: ログローテーションの検討

ファイル出力を追加する場合:

- ファイルサイズ制限
- 日次ローテーション
- 圧縮・アーカイブ

#### C-3: エラートラッキングサービス連携

本番運用時の検討項目:

- Sentry 等との連携
- エラー通知の自動化

---

## 7. ベストプラクティスとの比較

### 業界標準との差異

| 標準パターン | 本設計 | 差異の妥当性 |
|-------------|--------|------------|
| winston/pino 等の専用ライブラリ | console ベース | :white_check_mark: シンプルさ優先、妥当 |
| 構造化ログ (JSON) | JSON/テキスト切替 | :white_check_mark: 開発・運用で最適化、妥当 |
| ログレベル制御 | 環境変数で制御 | :white_check_mark: 標準的 |
| コンテキスト伝播 | withContext() | :white_check_mark: 適切な実装 |
| センシティブデータマスキング | 未実装 | :warning: 追加推奨 |

### 代替アーキテクチャ案

#### 代替案1: pino 採用

- **メリット**: 高性能、豊富な機能、エコシステム
- **デメリット**: 外部依存追加、学習コスト
- **評価**: 現時点では過剰。将来的にログ要件が増えた場合に再検討。

#### 代替案2: 集中型ログサービス

- **メリット**: スケーラビリティ、分析機能
- **デメリット**: コスト、複雑性、ネットワーク依存
- **評価**: ローカルツールとしては不適切。

---

## 8. 総合評価

### レビューサマリ

| 項目 | スコア |
|------|-------|
| 設計原則準拠 | 4.5/5 |
| 構造的品質 | 4.2/5 |
| セキュリティ | 3.5/5 |
| 既存システム整合性 | 4.5/5 |
| 拡張性 | 4.0/5 |
| **総合スコア** | **4.1/5** |

### 強み

1. **シンプルさ**: 外部依存なし、理解しやすい実装
2. **柔軟性**: withContext() による柔軟なコンテキスト管理
3. **互換性**: 既存の MCBD_* 環境変数パターンに準拠
4. **パフォーマンス**: ログレベルによる早期リターンで影響最小化
5. **テスト容易性**: console のモック化で容易にテスト可能

### 弱み

1. **セキュリティ**: 機密情報マスキングが未実装
2. **Server/Client 分離**: Next.js の SSR/CSR でのログ混在
3. **依存性逆転**: console への直接依存（テスト時の課題）
4. **環境変数管理**: env.ts との統合が未考慮

### 総評

本設計は Issue #41 の要件を満たす適切な設計となっている。KISS/YAGNI 原則に基づきシンプルな実装を維持しながら、必要な機能（構造化ログ、レベル制御、コンテキスト管理）を提供している。

ただし、**機密情報のマスキング** は本番運用前に必須の改善項目である。また、Next.js 固有の課題（Server/Client ログ分離）についても実装時に考慮が必要。

---

## 9. 承認判定

### 判定: :white_check_mark: 条件付き承認（Conditionally Approved）

### 承認条件

| # | 条件 | 優先度 |
|---|------|--------|
| 1 | MF-1: 機密情報フィルタリングの実装 | 必須 |
| 2 | MF-2: Server/Client ログ分離の考慮 | 必須 |
| 3 | SF-1: env.ts との統合 | 推奨 |

### 次のステップ

1. **即時**: 必須改善項目（MF-1, MF-2）を設計書に追記
2. **実装フェーズ**: Phase 1（ロガー基盤）で改善項目を含めて実装
3. **テスト**: 機密情報マスキングのテストケースを追加
4. **ドキュメント**: .env.example、README の更新

---

## 10. 補足: 具体的な改善コード案

### 機密情報マスキング実装案

```typescript
// src/lib/logger.ts

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: 'Bearer [REDACTED]' },
  { pattern: /(password|passwd|pwd)[=:]\s*\S+/gi, replacement: '$1=[REDACTED]' },
  { pattern: /(token|secret|key|api_key)[=:]\s*\S+/gi, replacement: '$1=[REDACTED]' },
  { pattern: /MCBD_AUTH_TOKEN=\S+/gi, replacement: 'MCBD_AUTH_TOKEN=[REDACTED]' },
];

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') {
    let sanitized = value;
    for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
      sanitized = sanitized.replace(pattern, replacement);
    }
    return sanitized;
  }
  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      return value.map(sanitize);
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = sanitize(v);
    }
    return result;
  }
  return value;
}

function log(
  level: LogLevel,
  module: string,
  action: string,
  data?: Record<string, unknown>,
  context?: { worktreeId?: string; cliToolId?: string }
): void {
  // ... ログレベルチェック

  const entry: LogEntry = {
    level,
    module,
    action,
    timestamp: new Date().toISOString(),
    ...context,
    // データをサニタイズ
    ...(data && { data: sanitize(data) as Record<string, unknown> }),
  };

  // ... 出力
}
```

---

**レビュー完了**: 2026-01-12
