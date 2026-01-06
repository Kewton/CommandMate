# Claude CLI 性能改善 作業計画書

## 概要

| 項目 | 内容 |
|------|------|
| プロジェクト名 | Claude CLI 性能最適化 |
| 目的 | ポーリング処理の効率化とレスポンス時間の短縮 |
| 対象ファイル | `src/lib/response-poller.ts`, `src/lib/claude-session.ts`, `src/lib/tmux.ts` 等 |
| 推定期間 | 2-3週間 |
| 推定効果 | 応答時間80-95%改善、CPU使用率60-80%削減 |

---

## フェーズ構成

```
Phase 0: 設計方針検討・レビュー (2日)
    ↓
Phase 1: 緊急改善 (3日)
    ↓
Phase 2: 中程度改善 (5日)
    ↓
Phase 3: 最適化改善 (5日)
    ↓
Phase 4: 統合テスト・リリース (2日)
```

---

## Phase 0: 設計方針検討・レビュー

### 0.1 設計方針検討

#### 目的
性能改善の実装方針を明確化し、既存アーキテクチャとの整合性を確認する

#### 検討項目

| # | 検討事項 | 選択肢 | 決定基準 |
|---|----------|--------|----------|
| D1 | ポーリング停止戦略 | A) 即時停止 B) 遅延停止 C) 段階的停止 | 安定性 vs 応答性 |
| D2 | キャプチャ最適化方式 | A) 固定行数 B) 動的行数 C) 差分キャプチャ | 実装複雑度 vs 効果 |
| D3 | キャッシュ戦略 | A) メモリキャッシュ B) ファイルキャッシュ C) なし | メモリ制約 vs 速度 |
| D4 | ログ管理方式 | A) 環境変数制御 B) ログレベル制御 C) 外部設定 | 運用性 vs 実装コスト |
| D5 | 適応的ポーリング | A) 状態機械 B) ヒューリスティック C) ML予測 | 精度 vs 複雑度 |

#### 設計原則

1. **後方互換性**: 既存APIの破壊的変更を避ける
2. **段階的適用**: 各フェーズで独立してリリース可能にする
3. **テスト可能性**: 単体テストで性能改善を検証可能にする
4. **監視可能性**: 性能メトリクスを収集できるようにする

#### 成果物
- [ ] 設計方針ドキュメント (`workspace/claude-performance-design-policy.md`)
- [ ] アーキテクチャ図（変更箇所のハイライト）
- [ ] リスク評価表

### 0.2 設計方針レビュー

#### レビュー観点

| # | 観点 | チェック項目 |
|---|------|-------------|
| R1 | 整合性 | 既存コードとの整合性は取れているか |
| R2 | 保守性 | 将来の拡張・修正が容易か |
| R3 | テスト | テスト戦略は適切か |
| R4 | リスク | 想定されるリスクと対策は十分か |
| R5 | 性能 | 目標性能を達成できる見込みがあるか |

#### レビュープロセス
1. 設計ドキュメントの作成
2. セルフレビュー（チェックリスト確認）
3. 必要に応じてユーザー確認
4. レビュー指摘事項の反映

#### 成果物
- [ ] レビュー結果記録
- [ ] 設計方針の最終版

---

## Phase 1: 緊急改善（P1）

### 1.1 ポーリング自動停止の強化

#### 概要
レスポンス完了時に即座にポーリングを停止し、無駄な処理を削減

#### 変更対象
- `src/lib/response-poller.ts`

#### 実装内容
```typescript
// checkForResponse() 内に追加
if (result.isComplete && !promptDetection.isPrompt) {
  stopPolling(worktreeId, cliToolId);
  return true;
}
```

#### タスク
- [ ] 完了条件の明確化
- [ ] stopPolling呼び出しの追加
- [ ] 単体テスト作成
- [ ] 動作確認

#### 推定効果
- 無駄なポーリング: 150回 → 0回
- CPU時間: 約11秒削減/レスポンス

#### 工数: 0.5日

---

### 1.2 出力キャプチャ行数の最適化

#### 概要
固定10,000行から動的な行数計算に変更

#### 変更対象
- `src/lib/response-poller.ts`

#### 実装内容
```typescript
const calculateCaptureLines = (lastCapturedLine: number): number => {
  if (lastCapturedLine === 0) return 10000; // 初回
  return Math.min(Math.max(lastCapturedLine + 500, 100), 10000);
};
```

#### タスク
- [ ] 動的行数計算関数の実装
- [ ] checkForResponse()の修正
- [ ] 単体テスト作成
- [ ] 大量出力時のテスト

#### 推定効果
- 平均キャプチャ行数: 10,000 → 300
- tmux処理時間: 60-70%削減

#### 工数: 0.5日

---

### 1.3 リソースクリーンアップ

#### 概要
セッション終了時にポーリング関連リソースを確実に解放

#### 変更対象
- `src/lib/response-poller.ts`
- `src/app/api/worktrees/[id]/kill-session/route.ts`

#### 実装内容
```typescript
export function cleanupPollerResources(worktreeId: string): void {
  const cliToolIds: CLIToolType[] = ['claude', 'codex', 'gemini'];
  for (const cliToolId of cliToolIds) {
    stopPolling(worktreeId, cliToolId);
  }
  // Mapからの削除
  activePollers.delete(...);
  pollingStartTimes.delete(...);
}
```

#### タスク
- [ ] cleanupPollerResources関数の実装
- [ ] kill-session APIへの統合
- [ ] メモリリークテスト
- [ ] 長時間稼働テスト

#### 推定効果
- メモリリーク: 完全解決
- 長時間稼働安定性: 向上

#### 工数: 0.5日

---

### 1.4 ログ出力の最適化

#### 概要
本番環境での過剰ログ出力を抑制

#### 変更対象
- `src/lib/response-poller.ts`
- 新規: `src/lib/poller-logger.ts`

#### 実装内容
```typescript
// poller-logger.ts
const ENABLE_DETAILED_LOGGING = process.env.NODE_ENV === 'development';

export const pollerLog = {
  debug: (msg: string) => ENABLE_DETAILED_LOGGING && console.log(`[Poller] ${msg}`),
  info: (msg: string) => console.log(`[Poller] ${msg}`),
  warn: (msg: string) => console.warn(`[Poller] ${msg}`),
  error: (msg: string) => console.error(`[Poller] ${msg}`),
};
```

#### タスク
- [ ] ログユーティリティの作成
- [ ] 既存console.logの置換
- [ ] ログレベルの適切な設定
- [ ] 動作確認

#### 推定効果
- ログI/O: 95%削減（本番）
- CPU: 5-10%削減

#### 工数: 0.5日

---

## Phase 2: 中程度改善（P2）

### 2.1 正規表現マッチングの最適化

#### 概要
複雑な正規表現処理を簡易チェックと詳細チェックの2段階に分離

#### 変更対象
- `src/lib/cli-patterns.ts`
- `src/lib/response-poller.ts`

#### 実装内容
```typescript
// 簡易チェック（高速）
const quickCheck = {
  hasPromptIndicator: (text: string) => text.includes('>'),
  hasSeparator: (text: string) => text.includes('─'),
  isThinking: (text: string) => /[✻✽⏺]/.test(text),
};

// 詳細チェックは簡易チェック通過後のみ実行
```

#### タスク
- [ ] 簡易チェック関数の実装
- [ ] extractResponse()のリファクタリング
- [ ] パフォーマンステスト
- [ ] 回帰テスト

#### 推定効果
- マッチング時間: 30-40%削減
- CPU: 15-20%削減

#### 工数: 1.5日

---

### 2.2 ANSI削除処理の統一化

#### 概要
同一文字列への重複ANSI削除を排除

#### 変更対象
- `src/lib/response-poller.ts`

#### 実装内容
```typescript
// extractResponse()の開始時に一度だけ処理
const lines = output.split('\n');
const cleanLines = lines.map(stripAnsi);

// 以降はcleanLinesを使用
```

#### タスク
- [ ] cleanLines配列の導入
- [ ] 既存stripAnsi呼び出しの削除
- [ ] メモリ使用量の確認
- [ ] 単体テスト更新

#### 推定効果
- ANSI削除処理: 60-70%削減
- CPU: 5-10%削減

#### 工数: 0.5日

---

### 2.3 バッファリセット検出の簡素化

#### 概要
複雑な条件分岐を統計ベースの検出に変更

#### 変更対象
- `src/lib/response-poller.ts`

#### 実装内容
```typescript
interface PollingHistory {
  totalLines: number;
  timestamp: number;
}

const pollingHistories = new Map<string, PollingHistory[]>();

function detectBufferReset(
  key: string,
  currentLines: number
): boolean {
  const history = pollingHistories.get(key) || [];
  if (history.length < 2) return false;

  const avgLines = history.slice(-3).reduce((s, h) => s + h.totalLines, 0) / 3;
  return currentLines < avgLines * 0.5;
}
```

#### タスク
- [ ] PollingHistory型の定義
- [ ] 履歴管理の実装
- [ ] 既存ロジックの置換
- [ ] エッジケーステスト

#### 推定効果
- コード複雑度: 40%削減
- 保守性: 大幅向上

#### 工数: 1日

---

### 2.4 WebSocket配信の最適化

#### 概要
変更がない場合の不要な配信をスキップ

#### 変更対象
- `src/lib/response-poller.ts`
- `src/lib/ws-server.ts`

#### 実装内容
```typescript
const lastBroadcasts = new Map<string, string>(); // key -> contentHash

function shouldBroadcast(worktreeId: string, content: string): boolean {
  const key = worktreeId;
  const hash = hashContent(content);
  const lastHash = lastBroadcasts.get(key);

  if (hash === lastHash) return false;

  lastBroadcasts.set(key, hash);
  return true;
}
```

#### タスク
- [ ] コンテンツハッシュ関数の実装
- [ ] 配信前チェックの追加
- [ ] クライアント側の影響確認
- [ ] 統合テスト

#### 推定効果
- 不要な配信: 0-30%削減
- ネットワーク転送: 10-20%削減

#### 工数: 1.5日

---

## Phase 3: 最適化改善（P3）

### 3.1 適応的ポーリング間隔

#### 概要
状態に応じてポーリング間隔を動的に調整

#### 変更対象
- `src/lib/response-poller.ts`
- 新規: `src/lib/adaptive-polling.ts`

#### 実装内容
```typescript
// adaptive-polling.ts
type PollingState = 'idle' | 'thinking' | 'outputting' | 'complete';

interface AdaptivePollingConfig {
  idle: number;      // 2000ms
  thinking: number;  // 500ms
  outputting: number; // 1000ms
  complete: number;  // 停止
}

class AdaptivePoller {
  private state: PollingState = 'idle';
  private config: AdaptivePollingConfig;

  getInterval(): number {
    return this.config[this.state];
  }

  updateState(indicators: {
    hasNewOutput: boolean;
    isThinking: boolean;
    isComplete: boolean;
  }): void {
    // 状態遷移ロジック
  }
}
```

#### タスク
- [ ] AdaptivePollerクラスの実装
- [ ] 状態遷移ロジックの設計
- [ ] 既存ポーリングとの統合
- [ ] 性能ベンチマーク
- [ ] エッジケーステスト

#### 推定効果
- 応答時間: 20-30%短縮
- ユーザー体験: 大幅改善

#### 工数: 2日

---

### 3.2 セッション出力のキャッシング

#### 概要
変更がない場合の再処理をスキップ

#### 変更対象
- `src/lib/response-poller.ts`
- 新規: `src/lib/output-cache.ts`

#### 実装内容
```typescript
// output-cache.ts
interface CachedOutput {
  output: string;
  lineCount: number;
  timestamp: number;
  extractedResult: ExtractResult | null;
}

class OutputCache {
  private cache = new Map<string, CachedOutput>();
  private maxAge = 5000; // 5秒

  get(key: string, currentLineCount: number): CachedOutput | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (cached.lineCount !== currentLineCount) return null;
    if (Date.now() - cached.timestamp > this.maxAge) return null;
    return cached;
  }

  set(key: string, data: CachedOutput): void {
    this.cache.set(key, data);
    this.cleanup();
  }

  private cleanup(): void {
    // 古いエントリの削除
  }
}
```

#### タスク
- [ ] OutputCacheクラスの実装
- [ ] キャッシュキー設計
- [ ] TTL管理の実装
- [ ] checkForResponse()への統合
- [ ] キャッシュヒット率の計測

#### 推定効果
- キャプチャ処理: 30-50%削減
- 処理時間: 約40ms短縮

#### 工数: 1.5日

---

### 3.3 インクリメンタル出力処理

#### 概要
ストリーム形式で処理し、早期終了を可能にする

#### 変更対象
- `src/lib/response-poller.ts`
- 新規: `src/lib/incremental-processor.ts`

#### 実装内容
```typescript
// incremental-processor.ts
async function* processOutputIncrementally(
  output: string,
  patterns: CliToolPatterns
): AsyncGenerator<ProcessingResult> {
  const lines = output.split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = stripAnsi(lines[i]);

    // 完了パターンを検出したら即座にyield
    if (patterns.promptPattern.test(line)) {
      yield { type: 'complete', lineIndex: i };
      return;
    }

    yield { type: 'processing', lineIndex: i };
  }
}

// 使用例
for await (const result of processOutputIncrementally(output, patterns)) {
  if (result.type === 'complete') {
    // 早期終了
    break;
  }
}
```

#### タスク
- [ ] AsyncGeneratorの実装
- [ ] 逆順処理の最適化
- [ ] 既存ロジックとの統合
- [ ] メモリ使用量の計測
- [ ] パフォーマンステスト

#### 推定効果
- メモリ使用量: 30-50%削減
- 早期終了による時間短縮

#### 工数: 1.5日

---

## Phase 4: 統合テスト・リリース

### 4.1 統合テスト

#### テスト項目

| # | テスト項目 | 確認内容 |
|---|------------|----------|
| T1 | 基本動作 | 通常のClaude CLIレスポンスが正常に取得できる |
| T2 | 長時間稼働 | 1時間以上の連続稼働でメモリリークがない |
| T3 | 高負荷 | 複数worktreeの同時ポーリングが正常動作 |
| T4 | エッジケース | 大量出力、空出力、エラー時の動作 |
| T5 | 性能計測 | 改善前後の応答時間を計測 |

#### タスク
- [ ] 統合テストスイートの作成
- [ ] 性能ベンチマークの実施
- [ ] リグレッションテスト
- [ ] ドキュメント更新

#### 工数: 1.5日

---

### 4.2 リリース

#### リリースチェックリスト
- [ ] 全テストパス確認
- [ ] 性能目標達成確認
- [ ] PRの作成
- [ ] コードレビュー
- [ ] マージ・デプロイ

#### 工数: 0.5日

---

## スケジュール

```
Week 1
├── Day 1-2: Phase 0 (設計方針検討・レビュー)
├── Day 3-4: Phase 1.1-1.2 (ポーリング停止、キャプチャ最適化)
└── Day 5: Phase 1.3-1.4 (リソースクリーンアップ、ログ最適化)

Week 2
├── Day 1-2: Phase 2.1 (正規表現最適化)
├── Day 3: Phase 2.2-2.3 (ANSI削除、バッファリセット)
└── Day 4-5: Phase 2.4 (WebSocket最適化)

Week 3
├── Day 1-2: Phase 3.1 (適応的ポーリング)
├── Day 3-4: Phase 3.2-3.3 (キャッシング、インクリメンタル処理)
└── Day 5: Phase 4 (統合テスト・リリース)
```

---

## 成果物一覧

| Phase | 成果物 | 形式 |
|-------|--------|------|
| 0 | 設計方針ドキュメント | Markdown |
| 0 | レビュー結果 | Markdown |
| 1 | P1実装コード | TypeScript |
| 1 | P1単体テスト | TypeScript |
| 2 | P2実装コード | TypeScript |
| 2 | P2単体テスト | TypeScript |
| 3 | P3実装コード | TypeScript |
| 3 | P3単体テスト | TypeScript |
| 4 | 統合テスト | TypeScript |
| 4 | 性能レポート | Markdown |

---

## リスクと対策

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 既存機能の回帰 | 高 | 各フェーズで回帰テスト実施 |
| 性能目標未達成 | 中 | 段階的リリースで早期検証 |
| メモリリーク | 中 | 長時間稼働テスト実施 |
| 複雑度増加 | 低 | コードレビューで品質担保 |

---

## 次のアクション

1. **Phase 0開始**: 設計方針ドキュメントの作成
2. **ユーザー確認**: 設計方針のレビュー依頼
3. **Phase 1着手**: レビュー完了後に実装開始
