# アーキテクチャレビュー: Issue #76 影響範囲分析

**レビュー日時**: 2026-01-29
**レビュー対象**: Issue #76 環境変数フォールバック実装
**レビュータイプ**: 影響範囲分析（Impact Scope Analysis）
**関連Issue**: #76, #74 (親Issue)

---

## 1. エグゼクティブサマリー

Issue #76（環境変数フォールバック実装）の影響範囲を詳細に分析した結果、以下が判明しました。

| 区分 | 件数 | 詳細 |
|------|------|------|
| **直接修正対象** | 11ファイル | コア実装＋API＋スクリプト |
| **新規作成** | 2ファイル | env.test.ts, CHANGELOG.md |
| **既存テスト更新** | 2ファイル | middleware.test.ts, logger.test.ts |
| **間接影響（確認のみ）** | 33+ API | 動作確認必要、修正不要 |

**結論**: 影響範囲は**限定的かつ管理可能**。フォールバック機能を`env.ts`に一元化することで、後方互換性を完全に維持。

---

## 2. 環境変数マッピング（フォールバック対象）

### 2.1 サーバー側（8種類）

| 新名称 | 旧名称 | 用途 | 影響度 |
|--------|--------|------|--------|
| `CM_ROOT_DIR` | `MCBD_ROOT_DIR` | ワークツリールートディレクトリ | **高** |
| `CM_PORT` | `MCBD_PORT` | サーバーポート | 中 |
| `CM_BIND` | `MCBD_BIND` | バインドアドレス（認証判定） | **高** |
| `CM_AUTH_TOKEN` | `MCBD_AUTH_TOKEN` | API認証トークン | **高** |
| `CM_LOG_LEVEL` | `MCBD_LOG_LEVEL` | ログレベル制御 | 中 |
| `CM_LOG_FORMAT` | `MCBD_LOG_FORMAT` | ログ出力形式 | 中 |
| `CM_LOG_DIR` | `MCBD_LOG_DIR` | ログファイル保存先 | 低 |
| `CM_DB_PATH` | `MCBD_DB_PATH` | データベースパス | 低 |

### 2.2 クライアント側（1種類）

| 新名称 | 旧名称 | 用途 | 影響度 |
|--------|--------|------|--------|
| `NEXT_PUBLIC_CM_AUTH_TOKEN` | `NEXT_PUBLIC_MCBD_AUTH_TOKEN` | クライアント認証 | 中 |

---

## 3. 直接修正対象ファイル詳細

### 3.1 コアライブラリ層（6ファイル）

#### `src/lib/env.ts` - **優先度: 最高**

| 項目 | 内容 |
|------|------|
| **行番号** | 45-46, 92-96, 113-120 |
| **参照環境変数** | MCBD_LOG_LEVEL, MCBD_LOG_FORMAT, MCBD_ROOT_DIR, MCBD_PORT, MCBD_BIND, MCBD_AUTH_TOKEN |
| **変更内容** | `ENV_MAPPING`定数、`getEnvWithFallback()`、`getEnvByKey()`、`resetWarnedKeys()`追加 |
| **依存元** | logger.ts, middleware.ts, worktrees.ts, 全APIエンドポイント |

#### `src/lib/logger.ts` - **優先度: 高**

| 項目 | 内容 |
|------|------|
| **行番号** | 21 (import), 82-83 (マスキングパターン) |
| **参照環境変数** | MCBD_AUTH_TOKEN（マスキング用） |
| **変更内容** | `CM_AUTH_TOKEN`マスキングパターン追加 |
| **依存元** | 全APIエンドポイント |

#### `src/lib/log-manager.ts` - **優先度: 中**

| 項目 | 内容 |
|------|------|
| **行番号** | 13 |
| **参照環境変数** | MCBD_LOG_DIR |
| **変更内容** | `getEnvByKey('CM_LOG_DIR')`使用 |
| **依存元** | ログファイル生成API |

#### `src/lib/worktrees.ts` - **優先度: 中**

| 項目 | 内容 |
|------|------|
| **行番号** | 110-134 |
| **参照環境変数** | MCBD_ROOT_DIR |
| **変更内容** | `getEnvByKey('CM_ROOT_DIR')`使用 |
| **依存元** | repositories/scan, repositories/sync |

#### `src/lib/api-client.ts` - **優先度: 中**

| 項目 | 内容 |
|------|------|
| **行番号** | 46 |
| **参照環境変数** | NEXT_PUBLIC_MCBD_AUTH_TOKEN |
| **変更内容** | `NEXT_PUBLIC_CM_AUTH_TOKEN`へのフォールバック対応、警告重複防止 |
| **依存元** | 全クライアントコンポーネント（60+） |

#### `src/lib/db-instance.ts` - **優先度: 低**

| 項目 | 内容 |
|------|------|
| **行番号** | 25 |
| **参照環境変数** | DATABASE_PATH（MCBDプレフィックスなし） |
| **変更内容** | `CM_DB_PATH` → `MCBD_DB_PATH` → `DATABASE_PATH`優先順位 |
| **依存元** | 全APIエンドポイント（33個） |

### 3.2 ミドルウェア層（1ファイル）

#### `src/middleware.ts` - **優先度: 最高**

| 項目 | 内容 |
|------|------|
| **行番号** | 25 (MCBD_BIND), 34 (MCBD_AUTH_TOKEN) |
| **参照環境変数** | MCBD_BIND, MCBD_AUTH_TOKEN |
| **変更内容** | `getEnvWithFallback()`使用（相対パスインポート） |
| **影響** | 全API認証判定ロジック |
| **依存元** | Next.js global middleware（全API呼び出し） |

### 3.3 APIエンドポイント層（2ファイル）

#### `src/app/api/repositories/sync/route.ts` - **優先度: 中**

| 項目 | 内容 |
|------|------|
| **行番号** | 17 |
| **変更内容** | エラーメッセージに`CM_ROOT_DIR (MCBD_ROOT_DIR)`を追加 |

#### `src/app/api/worktrees/[id]/logs/[filename]/route.ts` - **優先度: 中**

| 項目 | 内容 |
|------|------|
| **行番号** | 12 |
| **参照環境変数** | MCBD_LOG_DIR |
| **変更内容** | `getEnvByKey('CM_LOG_DIR')`使用 |

### 3.4 スクリプト層（2ファイル）

#### `scripts/migrate-cli-tool-id.ts`

| 項目 | 内容 |
|------|------|
| **行番号** | 13 |
| **参照環境変数** | MCBD_DB_PATH |
| **変更内容** | フォールバック対応 |

#### `scripts/clean-existing-messages.ts`

| 項目 | 内容 |
|------|------|
| **行番号** | 10 |
| **参照環境変数** | MCBD_DB_PATH |
| **変更内容** | フォールバック対応 |

---

## 4. テスト影響範囲

### 4.1 新規作成テスト

#### `tests/unit/env.test.ts` - **新規**

| テストケース | 説明 |
|------------|------|
| 新名称のみ設定 | CM_*で正常動作、警告なし |
| 旧名称のみ設定 | MCBD_*でフォールバック、警告1回 |
| 両方設定 | 新名称優先、警告なし |
| 両方未設定 | undefined返却 |
| 空文字列 | 有効値として扱う |
| 警告重複防止 | 同一キー複数回呼び出しで警告1回のみ |
| resetWarnedKeys | リセット後は再度警告 |
| ENV_MAPPING網羅性 | 8種類チェック |

### 4.2 既存テスト更新

#### `tests/unit/middleware.test.ts`

| 項目 | 内容 |
|------|------|
| **行番号** | 27-28, 66-67, 132-133, 154-180 |
| **参照環境変数** | MCBD_BIND, MCBD_AUTH_TOKEN |
| **テストケース数** | 12個 |
| **変更内容** | フォールバックテスト追加（#77スコープ） |

#### `tests/unit/logger.test.ts`

| 項目 | 内容 |
|------|------|
| **行番号** | 17-18, 49, 61, 71, 81, 91, 101 |
| **参照環境変数** | MCBD_LOG_LEVEL, MCBD_LOG_FORMAT |
| **テストケース数** | 10+個 |
| **変更内容** | フォールバックテスト追加（#77スコープ） |

---

## 5. 依存関係マップ

```
┌─────────────────────────────────────────────────────────────┐
│                    env.ts (コア)                             │
│  - ENV_MAPPING                                               │
│  - getEnvWithFallback()                                      │
│  - getEnvByKey()                                             │
│  - resetWarnedKeys()                                         │
└─────────────────────────────────────────────────────────────┘
         │
         ├──────────────────┬──────────────────┬──────────────────┐
         ▼                  ▼                  ▼                  ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  logger.ts  │    │middleware.ts│    │worktrees.ts │    │log-manager  │
│ (マスキング) │    │  (認証)     │    │ (パス取得)  │    │   .ts       │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
      │                  │                  │                  │
      ▼                  ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│                 全APIエンドポイント（33個）                   │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│               api-client.ts (クライアント認証)               │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│           全クライアントコンポーネント（60+）                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. リスク評価

| リスク項目 | 影響度 | 発生確率 | 対策 |
|-----------|--------|---------|------|
| **認証機能の破損** | 高 | 低 | middleware.ts単体テスト必須、E2Eテスト推奨 |
| **ログ出力停止** | 中 | 低 | logger.test.ts、log-manager動作確認 |
| **DB接続失敗** | 中 | 低 | 既存テストでカバー |
| **警告ログ重複** | 低 | 低 | `warnedKeys` Setで防止 |
| **クライアント認証エラー** | 中 | 低 | api-client.ts動作確認、E2Eテスト |

---

## 7. 実装順序（推奨）

### Phase 1: コア実装（必須）
1. `src/lib/env.ts` - フォールバック機能追加
2. `tests/unit/env.test.ts` - 新規テスト作成

### Phase 2: 認証・ログ層（高優先度）
3. `src/middleware.ts` - 認証フォールバック
4. `src/lib/logger.ts` - マスキングパターン追加
5. `src/lib/log-manager.ts` - LOG_DIRフォールバック

### Phase 3: データアクセス層（中優先度）
6. `src/lib/worktrees.ts` - ROOT_DIRフォールバック
7. `src/lib/api-client.ts` - クライアント認証フォールバック

### Phase 4: APIエンドポイント（中優先度）
8. `src/app/api/repositories/sync/route.ts` - エラーメッセージ更新
9. `src/app/api/worktrees/[id]/logs/[filename]/route.ts` - LOG_DIRフォールバック

### Phase 5: スクリプト・ドキュメント（低優先度）
10. `scripts/migrate-cli-tool-id.ts`
11. `scripts/clean-existing-messages.ts`
12. `CHANGELOG.md` - 新規作成

---

## 8. 間接影響（修正不要、確認のみ）

### 8.1 APIエンドポイント（33個）

以下は`getEnv()`経由で環境変数を取得しており、`env.ts`の修正により自動的にフォールバック対応される。

| パス | 依存 |
|------|------|
| `/api/worktrees/*` | db-instance.ts |
| `/api/repositories/*` | worktrees.ts, db-instance.ts |
| `/api/slash-commands` | db-instance.ts |

### 8.2 クライアントコンポーネント（60+）

`api-client.ts`経由で認証トークンを使用。`api-client.ts`の修正により自動的にフォールバック対応される。

---

## 9. テスト戦略

### 9.1 必須テスト（#76スコープ）

```
[x] getEnvWithFallback() - 新名称優先
[x] getEnvWithFallback() - 旧名称フォールバック
[x] getEnvWithFallback() - 両方undefined
[x] 警告ログ出力 - 最初の1回のみ
[x] resetWarnedKeys() - リセット後再警告
[x] ENV_MAPPING - 8種類網羅性
```

### 9.2 推奨テスト（#77スコープ）

```
[ ] middleware - CM_BIND使用時
[ ] middleware - MCBD_BIND使用時（警告あり）
[ ] logger - CM_LOG_LEVEL使用時
[ ] logger - MCBD_LOG_LEVEL使用時（警告あり）
```

### 9.3 動作確認（手動）

```
[ ] 旧名称のみの.envで起動確認
[ ] 新名称のみの.envで起動確認
[ ] 混在.envで起動確認
[ ] API認証動作確認
[ ] ログファイル出力確認
```

---

## 10. 総合評価

### レビューサマリ

- **全体評価**: ⭐⭐⭐⭐⭐（5/5）
- **影響範囲**: 限定的かつ管理可能
- **リスクレベル**: 低
- **後方互換性**: 完全維持

### 強み

1. `env.ts`への一元化により変更箇所を最小化
2. 既存の33個APIエンドポイントは修正不要
3. 60+クライアントコンポーネントは修正不要
4. 警告重複防止でログ汚染を回避

### 注意点

1. `middleware.ts`は認証の要 - 重点テスト必須
2. `api-client.ts`のビルド時環境変数埋め込みに注意
3. `scripts/`は直接DBパスを使用 - 個別対応必要

### 承認判定

- [x] **承認（Approved）** ✅

**判定理由**:
- 影響範囲が明確に把握され、管理可能
- フォールバック設計により後方互換性を完全維持
- テスト戦略が明確

---

## 11. 次のステップ

1. **設計書確認**: `issue-76-env-fallback-design-policy.md`の最終確認
2. **実装着手**: Phase 1（コア実装）から順次実装
3. **テスト実行**: 各Phase完了時にテスト実行
4. **動作確認**: 全Phase完了後に手動動作確認

---

**レビュー完了**: 2026-01-29
**承認者**: Architecture Review Agent
