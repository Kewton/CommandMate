# Claude CLI 性能改善 設計方針書

## 文書情報

| 項目 | 内容 |
|------|------|
| 文書名 | Claude CLI 性能改善 設計方針書 |
| バージョン | 1.0 |
| 作成日 | 2026-01-05 |
| ステータス | レビュー待ち |

---

## 1. 背景と目的

### 1.1 現状の課題

現在のClaude CLI連携機能には以下の性能問題が存在する：

| # | 課題 | 影響 |
|---|------|------|
| 1 | レスポンス完了後も5分間ポーリング継続 | CPU無駄使用、約11秒/回のオーバーヘッド |
| 2 | 毎回10,000行のキャプチャ | 不要なI/O、メモリ消費 |
| 3 | 重複したANSI削除処理 | CPU無駄使用 |
| 4 | 固定ポーリング間隔（2秒） | 応答性の低下 |
| 5 | リソースクリーンアップ不足 | メモリリーク |

### 1.2 目標

| 指標 | 現状 | 目標 |
|------|------|------|
| 平均応答時間 | 2-5秒 | 200-500ms |
| CPU使用率（ポーリング中） | 100% | 20-40% |
| メモリリーク | あり | なし |
| 不要ポーリング回数 | 150回/レスポンス | 0回 |

---

## 2. 設計原則

### 2.1 基本原則

| 原則 | 説明 | 適用例 |
|------|------|--------|
| **後方互換性** | 既存APIの破壊的変更を避ける | 戻り値の型を維持 |
| **段階的適用** | 各フェーズで独立してリリース可能 | フェーズごとのPR |
| **テスト可能性** | 単体テストで性能改善を検証可能 | モック可能な設計 |
| **監視可能性** | 性能メトリクスを収集可能 | ログ・計測ポイント |
| **フェイルセーフ** | 最適化失敗時も基本機能は維持 | フォールバック実装 |

### 2.2 コーディング規約

- 既存の`CLAUDE.md`のコーディング規約に準拠
- TypeScript strict モード維持
- ESLint/Prettier ルール遵守

---

## 3. 設計決定

### 3.1 D1: ポーリング停止戦略

#### 選択肢

| オプション | 説明 | メリット | デメリット |
|------------|------|----------|------------|
| A) 即時停止 | 完了検出時に即座に停止 | 最大効率 | 誤検出リスク |
| B) 遅延停止 | 完了後N秒待機して停止 | 安全 | 効率低下 |
| C) 段階的停止 | 間隔を徐々に延長 | バランス | 実装複雑 |

#### 決定: **A) 即時停止**

**理由:**
1. 完了検出ロジックは十分に信頼性がある
2. 誤検出時は次回ポーリングで回復可能
3. 最大の性能効果を得られる

**実装方針:**
```typescript
// response-poller.ts
if (result.isComplete && !promptDetection.isPrompt) {
  pollerLog.info(`Response complete for ${worktreeId}, stopping polling`);
  stopPolling(worktreeId, cliToolId);
  return true;
}
```

**フォールバック:**
- 誤停止時のための手動再開API提供
- 30秒間出力がない場合は自動再開を検討

---

### 3.2 D2: キャプチャ最適化方式

#### 選択肢

| オプション | 説明 | メリット | デメリット |
|------------|------|----------|------------|
| A) 固定行数 | 常に一定行数を取得 | シンプル | 効率低 |
| B) 動的行数 | 前回位置から推定 | 効率的 | 状態管理必要 |
| C) 差分キャプチャ | 変更部分のみ取得 | 最高効率 | tmux依存 |

#### 決定: **B) 動的行数**

**理由:**
1. 既存の`lastCapturedLine`状態を活用可能
2. tmuxの既存機能で実現可能
3. 適度な効率と実装複雑度のバランス

**実装方針:**
```typescript
const calculateCaptureLines = (lastCapturedLine: number): number => {
  // 初回は全体をスキャン
  if (lastCapturedLine === 0) return 10000;

  // 2回目以降は前回位置 + バッファ
  const buffer = 500; // 新規出力の最大推定行数
  const minLines = 100; // 最小キャプチャ行数

  return Math.min(Math.max(lastCapturedLine + buffer, minLines), 10000);
};
```

**パラメータ:**
| パラメータ | 値 | 根拠 |
|------------|-----|------|
| buffer | 500行 | Claudeの1回の出力は通常100-300行 |
| minLines | 100行 | プロンプト検出に必要な最小行数 |
| maxLines | 10000行 | 既存の上限値を維持 |

---

### 3.3 D3: キャッシュ戦略

#### 選択肢

| オプション | 説明 | メリット | デメリット |
|------------|------|----------|------------|
| A) メモリキャッシュ | Map/LRUで保持 | 高速 | メモリ消費 |
| B) ファイルキャッシュ | ファイルに保存 | 永続性 | I/Oコスト |
| C) なし | キャッシュしない | シンプル | 効率低 |

#### 決定: **A) メモリキャッシュ（LRU方式）**

**理由:**
1. ポーリング間隔（2秒）より短いTTLで十分
2. ファイルI/Oは本末転倒
3. メモリ消費は制限可能

**実装方針:**
```typescript
// output-cache.ts
interface CacheEntry {
  output: string;
  lineCount: number;
  timestamp: number;
  hash: string;
}

class OutputCache {
  private cache = new Map<string, CacheEntry>();
  private maxEntries = 50;  // 最大50セッション分
  private ttl = 5000;       // 5秒

  get(key: string, currentLineCount: number): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.lineCount !== currentLineCount) return null;
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    this.cache.set(key, entry);
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    if (this.cache.size > this.maxEntries) {
      // LRU: 最も古いエントリを削除
      const oldest = [...this.cache.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
  }
}
```

**制約:**
- 最大50エントリ（約50セッション分）
- TTL: 5秒
- メモリ上限: 約50MB（1エントリ1MB想定）

---

### 3.4 D4: ログ管理方式

#### 選択肢

| オプション | 説明 | メリット | デメリット |
|------------|------|----------|------------|
| A) 環境変数制御 | NODE_ENVで切替 | シンプル | 粒度粗い |
| B) ログレベル制御 | DEBUG/INFO/WARN/ERROR | 柔軟 | 設定必要 |
| C) 外部ライブラリ | winston/pino等 | 高機能 | 依存追加 |

#### 決定: **A) 環境変数制御 + 軽量ログレベル**

**理由:**
1. 既存の依存関係を増やさない
2. シンプルで理解しやすい
3. 必要十分な機能

**実装方針:**
```typescript
// poller-logger.ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel =
  process.env.NODE_ENV === 'development' ? 'debug' : 'info';

export const pollerLog = {
  debug: (msg: string, ...args: unknown[]) => {
    if (LOG_LEVELS.debug >= LOG_LEVELS[currentLevel]) {
      console.log(`[Poller:DEBUG] ${msg}`, ...args);
    }
  },
  info: (msg: string, ...args: unknown[]) => {
    if (LOG_LEVELS.info >= LOG_LEVELS[currentLevel]) {
      console.log(`[Poller:INFO] ${msg}`, ...args);
    }
  },
  warn: (msg: string, ...args: unknown[]) => {
    if (LOG_LEVELS.warn >= LOG_LEVELS[currentLevel]) {
      console.warn(`[Poller:WARN] ${msg}`, ...args);
    }
  },
  error: (msg: string, ...args: unknown[]) => {
    console.error(`[Poller:ERROR] ${msg}`, ...args);
  },
};
```

**ログレベル設定:**
| 環境 | レベル | 出力内容 |
|------|--------|----------|
| development | debug | 全ログ |
| production | info | info以上 |
| （将来）POLLER_LOG_LEVEL | 任意 | カスタム |

---

### 3.5 D5: 適応的ポーリング戦略

#### 選択肢

| オプション | 説明 | メリット | デメリット |
|------------|------|----------|------------|
| A) 状態機械 | 明示的な状態遷移 | 予測可能 | 実装複雑 |
| B) ヒューリスティック | 経験則ベース | シンプル | 精度低 |
| C) ML予測 | 機械学習モデル | 高精度 | 過剰 |

#### 決定: **A) 状態機械**

**理由:**
1. 状態遷移が明確で予測可能
2. デバッグ・テストが容易
3. 将来の拡張にも対応

**状態定義:**
```
┌─────────┐
│  idle   │ ← 初期状態
└────┬────┘
     │ 出力検出
     ▼
┌─────────┐
│thinking │ ← スピナー表示中
└────┬────┘
     │ 実際の出力開始
     ▼
┌──────────┐
│outputting│ ← コンテンツ出力中
└────┬─────┘
     │ プロンプト検出
     ▼
┌─────────┐
│complete │ ← 完了（停止）
└─────────┘
```

**実装方針:**
```typescript
// adaptive-polling.ts
type PollingState = 'idle' | 'thinking' | 'outputting' | 'complete';

interface StateConfig {
  interval: number;
  timeout: number;
}

const STATE_CONFIGS: Record<PollingState, StateConfig> = {
  idle: { interval: 2000, timeout: 300000 },      // 2秒、5分タイムアウト
  thinking: { interval: 500, timeout: 60000 },    // 0.5秒、1分タイムアウト
  outputting: { interval: 1000, timeout: 120000 }, // 1秒、2分タイムアウト
  complete: { interval: 0, timeout: 0 },          // 停止
};

class AdaptivePoller {
  private state: PollingState = 'idle';
  private stateStartTime: number = Date.now();

  transition(newState: PollingState): void {
    if (this.state !== newState) {
      pollerLog.debug(`State transition: ${this.state} → ${newState}`);
      this.state = newState;
      this.stateStartTime = Date.now();
    }
  }

  getInterval(): number {
    return STATE_CONFIGS[this.state].interval;
  }

  isTimedOut(): boolean {
    const config = STATE_CONFIGS[this.state];
    return Date.now() - this.stateStartTime > config.timeout;
  }

  determineNextState(indicators: {
    hasSpinner: boolean;
    hasNewContent: boolean;
    hasPrompt: boolean;
  }): PollingState {
    if (indicators.hasPrompt) return 'complete';
    if (indicators.hasNewContent) return 'outputting';
    if (indicators.hasSpinner) return 'thinking';
    return 'idle';
  }
}
```

**状態遷移条件:**
| 現状態 | 条件 | 次状態 |
|--------|------|--------|
| idle | スピナー検出 | thinking |
| idle | コンテンツ検出 | outputting |
| thinking | コンテンツ検出 | outputting |
| thinking | プロンプト検出 | complete |
| outputting | プロンプト検出 | complete |
| any | タイムアウト | idle（リセット） |

---

## 4. アーキテクチャ変更

### 4.1 変更前

```
┌─────────────────────────────────────────────────┐
│                response-poller.ts               │
│  ┌──────────────────────────────────────────┐  │
│  │ checkForResponse() - 固定2秒ポーリング     │  │
│  │ ├─ captureSessionOutput(10000行)         │  │
│  │ ├─ extractResponse()                     │  │
│  │ │   ├─ stripAnsi() x 複数回              │  │
│  │ │   └─ 複雑な正規表現マッチング           │  │
│  │ └─ broadcastMessage()                    │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### 4.2 変更後

```
┌─────────────────────────────────────────────────┐
│                response-poller.ts               │
│  ┌──────────────────────────────────────────┐  │
│  │ checkForResponse()                        │  │
│  │ ├─ AdaptivePoller.getInterval()  [NEW]   │  │
│  │ ├─ OutputCache.get()             [NEW]   │  │
│  │ ├─ captureSessionOutput(動的行数) [MOD]   │  │
│  │ ├─ extractResponse()             [MOD]   │  │
│  │ │   ├─ stripAnsi() x 1回のみ     [MOD]   │  │
│  │ │   └─ 2段階マッチング           [MOD]   │  │
│  │ ├─ OutputCache.set()             [NEW]   │  │
│  │ ├─ AdaptivePoller.transition()   [NEW]   │  │
│  │ └─ broadcastIfChanged()          [MOD]   │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘

┌──────────────────┐  ┌──────────────────┐
│ adaptive-polling │  │   output-cache   │
│       .ts        │  │       .ts        │
│  [NEW FILE]      │  │  [NEW FILE]      │
└──────────────────┘  └──────────────────┘

┌──────────────────┐
│  poller-logger   │
│       .ts        │
│  [NEW FILE]      │
└──────────────────┘
```

### 4.3 新規ファイル

| ファイル | 責務 |
|----------|------|
| `src/lib/adaptive-polling.ts` | 適応的ポーリング状態機械 |
| `src/lib/output-cache.ts` | 出力キャッシュ管理 |
| `src/lib/poller-logger.ts` | ポーリングログユーティリティ |

### 4.4 変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `src/lib/response-poller.ts` | 主要な最適化ロジック統合 |
| `src/lib/cli-patterns.ts` | 2段階マッチング対応 |
| `src/app/api/worktrees/[id]/kill-session/route.ts` | リソースクリーンアップ追加 |

---

## 5. テスト戦略

### 5.1 単体テスト

| テスト対象 | テスト内容 |
|------------|------------|
| AdaptivePoller | 状態遷移の正確性 |
| OutputCache | キャッシュヒット/ミス/TTL |
| calculateCaptureLines | 動的行数計算 |
| pollerLog | ログレベルフィルタリング |

### 5.2 統合テスト

| テスト項目 | 確認内容 |
|------------|----------|
| 正常系 | 通常のClaude応答を取得できる |
| 長時間稼働 | 1時間以上メモリリークなし |
| 高負荷 | 複数セッション同時動作 |
| エラー回復 | セッション切断からの復帰 |

### 5.3 性能テスト

| メトリクス | 計測方法 |
|------------|----------|
| 応答時間 | `console.time()` / `performance.now()` |
| CPU使用率 | プロセス監視 |
| メモリ使用量 | `process.memoryUsage()` |
| キャッシュヒット率 | カスタムカウンター |

---

## 6. リスク評価

### 6.1 リスク一覧

| # | リスク | 影響度 | 発生確率 | 対策 |
|---|--------|--------|----------|------|
| R1 | ポーリング停止の誤検出 | 高 | 低 | フォールバック実装 |
| R2 | キャッシュによる古いデータ表示 | 中 | 低 | 短いTTL設定 |
| R3 | 状態機械の複雑化 | 低 | 中 | 十分なテスト |
| R4 | 既存機能の回帰 | 高 | 低 | 回帰テスト |
| R5 | パフォーマンス目標未達 | 中 | 低 | 段階的リリース |

### 6.2 対策詳細

#### R1: ポーリング停止の誤検出

**対策:**
1. 完了判定を複数条件で確認
2. 停止後30秒間の監視期間を設ける（オプション）
3. 手動再開APIを提供

```typescript
// 複数条件での完了判定
const isDefinitelyComplete =
  result.isComplete &&
  !promptDetection.isPrompt &&
  hasPromptPattern &&
  !isThinking;
```

#### R4: 既存機能の回帰

**対策:**
1. 各フェーズ後に全テスト実行
2. フィーチャーフラグで段階的有効化
3. ロールバック手順の準備

```typescript
// フィーチャーフラグ
const USE_ADAPTIVE_POLLING = process.env.ENABLE_ADAPTIVE_POLLING === 'true';

if (USE_ADAPTIVE_POLLING) {
  // 新しいロジック
} else {
  // 既存ロジック（フォールバック）
}
```

---

## 7. 移行計画

### 7.1 段階的リリース

```
Phase 1 リリース
    │
    ├── P1機能を有効化
    ├── 1週間モニタリング
    └── 問題なければ次フェーズへ
    │
Phase 2 リリース
    │
    ├── P2機能を有効化
    ├── 1週間モニタリング
    └── 問題なければ次フェーズへ
    │
Phase 3 リリース
    │
    ├── P3機能を有効化
    ├── 性能計測
    └── 完了
```

### 7.2 ロールバック手順

1. 問題検出時、該当フェーズのフィーチャーフラグをOFF
2. 環境変数で即座に切り替え可能
3. 緊急時は前バージョンのコードにリバート

---

## 8. 承認

### レビューチェックリスト

- [ ] 設計原則に準拠しているか
- [ ] 後方互換性が保たれているか
- [ ] テスト戦略は十分か
- [ ] リスク対策は妥当か
- [ ] 実装工数は現実的か

### 承認欄

| 役割 | 名前 | 日付 | 承認 |
|------|------|------|------|
| 作成者 | Claude | 2026-01-05 | - |
| レビュアー | | | |

---

## 変更履歴

| バージョン | 日付 | 変更内容 |
|------------|------|----------|
| 1.0 | 2026-01-05 | 初版作成 |
