# アーキテクチャレビュー: Issue #76 環境変数フォールバック実装

**レビュー日時**: 2026-01-29
**レビュー対象**: `dev-reports/design/issue-76-env-fallback-design-policy.md`
**関連Issue**: #76, #74 (親Issue)
**レビュータイプ**: 整合性フォーカスレビュー

---

## 1. 設計原則の遵守確認

### SOLID原則チェック

| 原則 | 状態 | 評価 |
|------|------|------|
| **S** Single Responsibility | ✅ OK | `getEnvWithFallback`は環境変数取得の単一責任を持つ |
| **O** Open/Closed | ✅ OK | `ENV_MAPPING`への追加のみで新環境変数対応可能 |
| **L** Liskov Substitution | N/A | 継承を使用していない |
| **I** Interface Segregation | ✅ OK | `Env`インターフェースは適切なサイズを維持 |
| **D** Dependency Inversion | ✅ OK | `getEnvWithFallback`は純粋関数で依存なし |

### その他の原則

| 原則 | 状態 | 評価 |
|------|------|------|
| KISS | ✅ OK | ヘルパー関数はシンプルな条件分岐のみ |
| YAGNI | ✅ OK | 必要最小限の機能（フォールバック + 警告出力） |
| DRY | ✅ OK | `ENV_MAPPING`で一元管理、`getEnvByKey`で活用 |

---

## 2. アーキテクチャ評価

### 構造的品質

| 評価項目 | スコア(1-5) | コメント |
|---------|------------|----------|
| モジュール性 | 5 | `env.ts`に集約、他ファイルはインポートのみ |
| 結合度 | 5 | 疎結合、`getEnvWithFallback`は依存関係なし |
| 凝集度 | 5 | 環境変数関連機能が適切に集約 |
| 拡張性 | 5 | `ENV_MAPPING`への追加のみで拡張可能 |
| 保守性 | 5 | `warnedKeys`で警告重複を防止、テスト用reset関数あり |

### パフォーマンス観点

| 項目 | 評価 |
|------|------|
| レスポンスタイム | 影響なし（同期処理、process.env参照のみ） |
| スループット | 影響なし |
| リソース使用効率 | 良好（追加メモリ消費は最小限） |
| スケーラビリティ | N/A（ローカル設定のみ） |

---

## 3. セキュリティレビュー

### OWASP Top 10 チェック（該当項目のみ）

| チェック項目 | 状態 | 備考 |
|-------------|------|------|
| 機微データの露出対策 | ✅ OK | deprecation警告には環境変数**名**のみ出力、**値**は出力されない |
| ログとモニタリング | ✅ OK | 警告ログで移行状況を把握可能 |

### セキュリティ上の対応状況

1. **認証トークンのログ出力**: 警告メッセージには環境変数**名**のみ出力 → 問題なし
2. **logger.tsのマスキング**: `MCBD_AUTH_TOKEN`はすでにリダクション対象（logger.ts:82-83）

---

## 4. 既存システムとの整合性

### 統合ポイント

| ポイント | 状態 | 詳細 |
|---------|------|------|
| API互換性 | 変更なし | API側の変更は不要 |
| データモデル整合性 | 変更なし | DBスキーマに影響なし |
| 認証/認可の一貫性 | ✅ OK | `CM_AUTH_TOKEN` / `MCBD_AUTH_TOKEN`両方で認証可能 |
| ログ/監視の統合 | ✅ OK | console.warnで標準的な警告出力 |

### 技術スタックの適合性

| 項目 | 評価 |
|------|------|
| Next.js 14との親和性 | 良好（process.env参照は標準的） |
| TypeScript | 良好（型安全性維持、`EnvKey`型導入） |
| テストフレームワーク | 良好（Vitestで十分テスト可能） |

---

## 5. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | middleware.tsのインポートパス | 低 | 低 | 対応済み（相対パス使用） |
| 運用リスク | 移行漏れ | 低 | 低 | テストでカバー |
| セキュリティリスク | 認証トークン名の露出 | 低 | 低 | 値は露出しない |
| ビジネスリスク | 後方互換性の破綻 | 中 | 極低 | 設計で対策済み |

---

## 6. 整合性検証結果

### 6.1 設計書 vs コードベース整合性

#### 環境変数マッピング検証（`src/`配下）

| 環境変数 | 設計書記載 | コード実測 | 整合性 |
|---------|-----------|-----------|--------|
| `MCBD_ROOT_DIR` | env.ts:92, worktrees.ts:134 | ✅ 存在（env.ts:92, worktrees.ts:134） | ✅ 一致 |
| `MCBD_PORT` | env.ts:93 | ✅ 存在（env.ts:93） | ✅ 一致 |
| `MCBD_BIND` | env.ts:94, middleware.ts:25 | ✅ 存在（env.ts:94, middleware.ts:25） | ✅ 一致 |
| `MCBD_AUTH_TOKEN` | env.ts:95, middleware.ts:34 | ✅ 存在（env.ts:95, middleware.ts:34） | ✅ 一致 |
| `MCBD_LOG_LEVEL` | env.ts:45 | ✅ 存在（env.ts:45） | ✅ 一致 |
| `MCBD_LOG_FORMAT` | env.ts:46 | ✅ 存在（env.ts:46） | ✅ 一致 |
| `MCBD_LOG_DIR` | log-manager.ts:13 | ✅ 存在（log-manager.ts:13） | ✅ 一致 |
| `MCBD_DB_PATH` | scripts/* | ✅ 存在（scripts/のみ） | ✅ 一致 |
| `NEXT_PUBLIC_MCBD_AUTH_TOKEN` | api-client.ts:46 | ✅ 存在（api-client.ts:46） | ✅ 一致 |

**結果**: 全9種類の環境変数が設計書記載通りに存在確認完了

#### フォールバック対象外の確認

| 環境変数 | 設計書記載 | コード実測 | 整合性 |
|---------|-----------|-----------|--------|
| `DATABASE_PATH` | フォールバック対象外 | ✅ env.ts:96, db-instance.ts | ✅ 一致 |
| `WORKTREE_REPOS` | フォールバック対象外 | ✅ worktrees.ts:125 | ✅ 一致 |
| `WORKTREE_BASE_PATH` | フォールバック対象外 | ✅ clone-manager.ts:193 | ✅ 一致 |

**結果**: フォールバック対象外の環境変数も正しく識別されている

### 6.2 追加発見事項

以下のファイルでも`MCBD_*`参照があることを確認:

| ファイル | 参照箇所 | 対応必要性 |
|---------|---------|-----------|
| `src/lib/logger.ts:82-83` | マスキングパターン定義 | 不要（マスキング用のため） |
| `src/app/api/repositories/scan/route.ts:26` | `getEnv()`経由 | 不要（getEnvで対応済み） |
| `src/app/api/repositories/sync/route.ts:17` | エラーメッセージ内 | **#77で対応**（メッセージ更新） |

### 6.3 Issue本文との整合性

| 項目 | Issue本文 | 設計書 | 整合性 |
|------|----------|--------|--------|
| 環境変数数 | 8種類 + クライアント1種類 | 8種類 + クライアント1種類 | ✅ 一致 |
| フォールバック対象外 | 3種類明記 | 3種類明記 | ✅ 一致 |
| テストケース数 | 8種類 | 8種類 | ✅ 一致 |

---

## 7. 改善提案

### 必須改善項目（Must Fix）

**なし** - 前回レビューの必須改善項目はすべて設計書に反映済み

### 推奨改善項目（Should Fix）

**すべて設計書に反映済み** ✅

#### 7.1 sync/route.tsのエラーメッセージ更新

**状態**: ✅ 設計書に反映済み（7.5.7節）

**変更内容**: エラーメッセージに新名称（`CM_ROOT_DIR`）を追加

```typescript
// 変更後
{ error: 'No repositories configured. Please set WORKTREE_REPOS or CM_ROOT_DIR (MCBD_ROOT_DIR) environment variable.' }
```

#### 7.2 logger.tsのマスキングパターン更新

**状態**: ✅ 設計書に反映済み（7.5.6節、9.1節）

**変更内容**: `CM_AUTH_TOKEN`マスキングパターンを追加

```typescript
{ pattern: /CM_AUTH_TOKEN=\S+/gi, replacement: 'CM_AUTH_TOKEN=[REDACTED]' },
{ pattern: /MCBD_AUTH_TOKEN=\S+/gi, replacement: 'MCBD_AUTH_TOKEN=[REDACTED]' },
```

### 検討事項（Consider）

なし - 設計は成熟しており、実装着手可能

---

## 8. テスト設計レビュー

### テストカバレッジ

| テストケース | カバレッジ | 評価 |
|------------|----------|------|
| 新名称のみ設定 | ✅ OK | 正常系 |
| 旧名称のみ設定 | ✅ OK | フォールバック動作 |
| 両方設定 | ✅ OK | 優先順位確認 |
| 両方未設定 | ✅ OK | エッジケース |
| 空文字列 | ✅ OK | 境界値 |
| 警告重複防止 | ✅ OK | パフォーマンス考慮 |
| warnedKeysリセット | ✅ OK | テストユーティリティ |
| ENV_MAPPING網羅性 | ✅ OK | 8種類チェック |

### テスト設計の優秀点

1. **resetWarnedKeys関数**: テスト間の独立性を確保
2. **警告出力のモック**: `vi.spyOn(console, 'warn')`で検証可能
3. **境界値テスト**: 空文字列の扱いを明確化

---

## 9. 総合評価

### レビューサマリ

- **全体評価**: ⭐⭐⭐⭐⭐（5/5）
- **強み**:
  - シンプルで理解しやすい設計
  - 後方互換性を完全に維持
  - テストケースが網羅的
  - ロールバック計画が明確
  - `ENV_MAPPING`による一元管理
  - 警告重複防止の実装
  - 設計書とコードベースの完全な整合性
- **弱み**:
  - なし（前回指摘事項はすべて解消済み）

### 承認判定

- [x] **承認（Approved）** ✅
- [ ] 条件付き承認（Conditionally Approved）
- [ ] 要再設計（Needs Major Changes）

**判定理由**:
- 設計書とコードベースの整合性が完全に確認された
- 前回レビューの必須改善項目がすべて反映済み
- テスト設計が十分に網羅的
- 後方互換性が確実に維持される設計

---

## 10. 実装時の注意事項

### 実装順序（推奨）

1. **Step 1**: `src/lib/env.ts` にフォールバック機能追加
   - `ENV_MAPPING`定数
   - `warnedKeys` Set
   - `resetWarnedKeys()`関数
   - `getEnvWithFallback()`関数
   - `getEnvByKey()`型安全版関数
   - `getLogConfig()`・`getEnv()`の更新

2. **Step 2**: 各ファイルの環境変数参照をフォールバック対応に更新
   - `src/middleware.ts` - 相対パス`./lib/env`でインポート
   - `src/lib/worktrees.ts` - `getEnvByKey`使用
   - `src/lib/log-manager.ts` - `getEnvByKey`使用
   - `src/lib/api-client.ts` - インライン実装（`clientAuthTokenWarned`フラグ）

3. **Step 3**: `tests/unit/env.test.ts` テスト追加

4. **Step 4**: `CHANGELOG.md` 新規作成

### 品質確認チェックリスト

- [ ] TypeScriptコンパイルエラーなし (`npx tsc --noEmit`)
- [ ] ESLintエラーなし (`npm run lint`)
- [ ] 既存テストがすべてパス (`npm run test:unit`)
- [ ] ビルド成功 (`npm run build`)

### #77への申し送り事項

1. `NEXT_PUBLIC_MCBD_AUTH_TOKEN`は`src/lib/api-client.ts:46`で使用確認済み → **#76でフォールバック対応**
2. ~~`src/app/api/repositories/sync/route.ts:17`のエラーメッセージに旧名称記載あり~~ → **#76で対応**
3. ~~`src/lib/logger.ts`のマスキングパターンに新名称追加が必要~~ → **#76で対応**

> **Note**: 項目2,3は当初#77スコープとしていたが、#76のスコープに変更された

---

## 付録: コード調査結果

### 現在の環境変数参照箇所（完全版）

```
# src/ 配下のMCBD_*参照
src/lib/env.ts:45,46,92-95,100,104,108,113,117-120,151
src/lib/api-client.ts:46
src/lib/logger.ts:82-83
src/lib/log-manager.ts:13
src/lib/worktrees.ts:110,119,133-134
src/middleware.ts:12,13,25,34
src/app/api/repositories/scan/route.ts:26,29,36
src/app/api/repositories/sync/route.ts:17

# scripts/ 配下のMCBD_*参照
scripts/clean-existing-messages.ts:10
scripts/migrate-cli-tool-id.ts:13
scripts/setup.sh:32,33
scripts/stop.sh:20
scripts/status.sh:26
scripts/health-check.sh:9
```

### フォールバック対応が必要なファイル一覧

| ファイル | 変更内容 | 優先度 |
|---------|---------|--------|
| `src/lib/env.ts` | ヘルパー追加、getEnv/getLogConfig更新 | 高 |
| `src/middleware.ts` | フォールバック対応 | 高 |
| `src/lib/worktrees.ts` | フォールバック対応 | 中 |
| `src/lib/log-manager.ts` | フォールバック対応 | 中 |
| `src/lib/api-client.ts` | クライアント側フォールバック | 中 |
| `src/lib/logger.ts` | `CM_AUTH_TOKEN`マスキングパターン追加 | 中 |
| `src/app/api/repositories/sync/route.ts` | エラーメッセージに新名称追加 | 中 |
| `tests/unit/env.test.ts` | 新規テスト | 高 |
| `CHANGELOG.md` | 新規作成 | 中 |

---

**レビュー完了**: 2026-01-29
**承認者**: Architecture Review Agent
**次回アクション**: 実装着手可能
