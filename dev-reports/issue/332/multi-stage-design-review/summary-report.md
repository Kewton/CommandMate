# マルチステージ設計レビュー完了報告

## Issue #332 - アクセス元 IP の制限オプション

### レビュー日時
- 実施日: 2026-02-22
- 対象設計方針書: `dev-reports/design/issue-332-ip-restriction-design-policy.md`

---

### ステージ別結果

| Stage | レビュー種別 | Must Fix | Should Fix | Nice to Have | 反映数 | ステータス |
|-------|------------|---------|-----------|-------------|-------|----------|
| 1 | 通常レビュー（設計原則） | 1 | 3 | 4 | 4 | ✅ |
| 2 | 整合性レビュー | 3 | 5 | 3 | 8 | ✅ |
| 3 | 影響分析レビュー | 2 | 4 | 3 | 6 | ✅ |
| 4 | セキュリティレビュー | 2 | 5 | 4 | 6 | ✅ |

---

### Stage 1: 通常レビュー（設計原則） ✅

**フォーカス**: SOLID/KISS/YAGNI/DRY 準拠確認

**主要指摘事項**:

| ID | 重要度 | 原則 | 内容 | 対応 |
|----|-------|------|------|------|
| S1-001 | Must Fix | DRY | ws-server.ts での `parseAllowedIps()` 毎回呼び出しによるキャッシュ戦略不整合 | `getAllowedRanges()` 関数追加、モジュールレベルキャッシュ統一 |
| S1-002 | Should Fix | YAGNI | `ip-restriction-config.ts` の過度なモジュール分離 | 廃止。定数を ip-restriction.ts 内の未export内部定数として統合 |
| S1-003 | Should Fix | SOLID | `isIpRestrictionEnabled()` の環境変数直接参照によるテスタビリティ低下 | auth.ts の `storedTokenHash` パターンに準拠したモジュールスコープ初期化 |
| S1-004 | Should Fix | SOLID | `getClientIp()` の責務境界明確化 | JSDoc コメントでリクエスト解析責務と将来の分離ポイントを明記 |

**反映結果**: 4件 / 4件（Must+Should）

---

### Stage 2: 整合性レビュー ✅

**フォーカス**: 設計方針書と既存コードベースの整合性確認

**主要指摘事項**:

| ID | 重要度 | カテゴリ | 内容 | 対応 |
|----|-------|---------|------|------|
| S2-001 | Must Fix | 行番号 | server.ts WebSocket upgrade スキップ行番号誤り（L121→L120） | Section 4.1 の行番号を正確に修正 |
| S2-002 | Must Fix | Env整合性 | `EnvインターフェースへのCM_ALLOWED_IPS/CM_TRUST_PROXY` 追加時の `getEnv()` 非包含方針が未明記 | 既存 `CM_AUTH_TOKEN_HASH` パターン準拠の注記を追加 |
| S2-003 | Must Fix | 命名 | `authEnvKeys` 変数名とIP制限機能の意味的乖離 | 命名維持の設計判断コメントを追加（IP制限もセキュリティ機能の一部） |
| S2-004 | Should Fix | パターン差異 | auth.ts（undefined無効化）vs ip-restriction.ts（fail-fast）の差異未記載 | Section 3.1 に差異の設計判断を明記 |
| S2-005 | Should Fix | 多層防御 | WebSocket upgrade の middleware.ts / ws-server.ts 二重チェックの意図未記載 | defense-in-depth として意図的な設計であることをコメント追加 |
| S2-006 | Should Fix | import | import パスのエイリアス vs 相対パスの非対称性 | `'../lib/ip-restriction'`（相対パス）に統一 |
| S2-007 | Should Fix | CLI | start.ts foreground モードでの環境変数設定コードが設計方針書に未記載 | Section 4.6 に foreground モードの `CM_ALLOWED_IPS/CM_TRUST_PROXY` 設定を追記 |
| S2-008 | Should Fix | WebSocket | ws-server.ts が `getClientIp()` を使用しない理由が未記載 | `socket.remoteAddress` 直接使用の理由（`server.ts requestHandler` バイパス）を注記 |

**反映結果**: 8件 / 8件（Must+Should）

---

### Stage 3: 影響分析レビュー ✅

**フォーカス**: 変更の波及効果分析、リグレッションリスク評価

**主要指摘事項**:

| ID | 重要度 | カテゴリ | 内容 | 対応 |
|----|-------|---------|------|------|
| S3-001 | Must Fix | テスト | ip-restriction.ts モジュールスコープキャッシュと `vi.resetModules()` の干渉パターンが未文書化 | Section 7.2 に `beforeEach` での env 削除、`vi.resetModules()` + dynamic import パターンを追加 |
| S3-002 | Must Fix | ビルド | tsconfig.server.json の `include` リストに ip-restriction.ts 追加漏れ | Section 11 に tsconfig.server.json を追加、ファイル数 18→19 に更新 |
| S3-003 | Should Fix | テスト | daemon.test.ts の authEnvKeys 転送テストへの波及影響未分析 | Section 7.2 に daemon.test.ts の CM_ALLOWED_IPS/CM_TRUST_PROXY ケース追加を記載 |
| S3-004 | Should Fix | 影響範囲 | Section 11 の 19 ファイル一覧の詳細テーブルが不足 | Section 11 にファイル別変更内容詳細テーブル（19ファイル分）を追加 |
| S3-005 | Should Fix | server.ts | WebSocket upgrade スキップ時の X-Real-IP 注入が HTTP 限定である旨の注記不足 | Section 4.1 に WebSocket upgrade では X-Real-IP が未使用になる旨の注記を追加 |
| S3-006 | Should Fix | CLIビルド | tsconfig.cli.json の制約（src/lib/ 非包含）への言及不足 | Section 3.1 に CLI ビルド互換性制約（auth.ts C001 準拠）の注記を追加 |

**反映結果**: 6件 / 6件（Must+Should）

---

### Stage 4: セキュリティレビュー ✅

**フォーカス**: OWASP Top 10 準拠確認

**主要指摘事項**:

| ID | 重要度 | OWASP | 内容 | 対応 |
|----|-------|-------|------|------|
| S4-001 | Must Fix | A01 Broken Access Control | X-Forwarded-For 先頭 IP 抽出の信頼チェーン不備（IP Spoofing リスク） | `getClientIp()` JSDoc に leftmost IP 使用警告を追加、Section 8 に運用要件を明記 |
| S4-002 | Must Fix | A05 Security Misconfiguration | CIDR エントリ数上限未定義（DoS攻撃ベクター） | `MAX_ALLOWED_IP_ENTRIES=256` を内部定数として追加、fail-fast 仕様を JSDoc に追記 |
| S4-003 | Should Fix | A01 Broken Access Control | IP制限と AUTH_EXCLUDED_PATHS の評価順序が未記載 | Section 4.2 に注記追加、Section 5.5「IP制限と認証の相互作用」を新設 |
| S4-004 | Should Fix | A09 Logging Failures | IP制限拒否ログにおける normalizeIp() 未適用とログインジェクション防止の欠如 | `normalizeIp()` 適用と `.substring(0, 45)` 切り詰めを Section 4.2 ログ出力に追加 |
| S4-005 | Should Fix | A03 Injection | CIDR エントリ長上限チェック不足 | `MAX_CIDR_ENTRY_LENGTH=18`（IPv4 CIDR 最大長）を内部定数として追加 |
| S4-006 | Should Fix | A07 Auth Failures | CM_TRUST_PROXY のブール値パース厳密性不足 | 有効値は文字列 `'true'` のみ、非準拠値への `console.warn` を Section 3.1 と Section 8 に追加 |

**反映結果**: 6件 / 7件（Must 2件 + Should 4件 / 5件）

> **注**: S4-007（WebSocket defense-in-depth 二重チェックの IP 不一致リスク）は S2-005 で既に二重チェックの設計意図が文書化されており、Section 5.1 の注記として将来検討事項として記録。

---

### 設計方針書の主要改善点サマリー

#### アーキテクチャ改善
1. **`getAllowedRanges()` 関数追加** - モジュールレベルキャッシュを middleware.ts / ws-server.ts 間で共有（DRY）
2. **`ip-restriction-config.ts` 廃止** - 定数を ip-restriction.ts 内部に統合（YAGNI）
3. **モジュールスコープ初期化パターン統一** - `const allowedIpsEnv = process.env.CM_ALLOWED_IPS?.trim() || ''`（auth.ts 準拠）

#### 整合性改善
4. **server.ts 行番号修正** - L121→L120（実装時の混乱防止）
5. **foreground モード環境変数設定追加** - start.ts の `CM_ALLOWED_IPS/CM_TRUST_PROXY` 設定ブロックを明記
6. **tsconfig.server.json への追加** - ビルドエラー防止（影響ファイル 18→19）

#### セキュリティ強化
7. **DoS 防止定数追加** - `MAX_ALLOWED_IP_ENTRIES=256`、`MAX_CIDR_ENTRY_LENGTH=18`
8. **ログインジェクション防止** - normalizeIp() 適用 + 45文字切り詰め
9. **CM_TRUST_PROXY 値検証** - 非準拠値への console.warn
10. **Section 5.5 新設** - IP制限と認証（AUTH_EXCLUDED_PATHS）の相互作用を文書化

#### テスト設計強化
11. **vi.resetModules() パターン** - モジュールスコープキャッシュとテストの干渉回避方法を追加
12. **ファイル別変更内容テーブル** - Section 11 に 19 ファイル全ての変更詳細を追加

---

### 最終検証結果

> **Note**: このコマンドはソースコードの変更・テスト実行は行いません。設計方針書のレビューと改善のみを実施しています。

| 検証項目 | 結果 |
|---------|------|
| TypeScript ビルド | - (設計フェーズ) |
| ESLint | - (設計フェーズ) |
| Unit Tests | - (設計フェーズ) |

---

### 統計サマリー

| 項目 | 件数 |
|-----|-----|
| 総指摘数 | 39件 |
| Must Fix（全Stage合計） | 8件 |
| Should Fix（全Stage合計） | 17件 |
| Nice to Have（全Stage合計） | 14件 |
| 設計方針書反映（Must+Should） | 24件 |
| スキップ（Nice to Have等） | 15件 |

---

### 生成ファイル一覧

| ファイル | 説明 |
|---------|------|
| `stage1-review-context.json` | Stage 1 レビューコンテキスト |
| `stage1-review-result.json` | Stage 1 レビュー結果（Must 1件, Should 3件, NTH 4件） |
| `stage1-apply-context.json` | Stage 1 反映コンテキスト |
| `stage1-apply-result.json` | Stage 1 反映結果（4件反映） |
| `stage2-review-context.json` | Stage 2 レビューコンテキスト |
| `stage2-review-result.json` | Stage 2 レビュー結果（Must 3件, Should 5件, NTH 3件） |
| `stage2-apply-context.json` | Stage 2 反映コンテキスト |
| `stage2-apply-result.json` | Stage 2 反映結果（8件反映） |
| `stage3-review-context.json` | Stage 3 レビューコンテキスト |
| `stage3-review-result.json` | Stage 3 レビュー結果（Must 2件, Should 4件, NTH 3件） |
| `stage3-apply-context.json` | Stage 3 反映コンテキスト |
| `stage3-apply-result.json` | Stage 3 反映結果（6件反映） |
| `stage4-review-context.json` | Stage 4 レビューコンテキスト |
| `stage4-review-result.json` | Stage 4 レビュー結果（Must 2件, Should 5件, NTH 4件） |
| `stage4-apply-context.json` | Stage 4 反映コンテキスト |
| `stage4-apply-result.json` | Stage 4 反映結果（6件反映） |
| `summary-report.md` | 本サマリーレポート |

---

### 設計方針書ステータス

**ファイル**: `dev-reports/design/issue-332-ip-restriction-design-policy.md`

全4ステージのレビューを経て、設計方針書は以下のセクション構成に更新されました:

1. 概要・設計原則
2. アーキテクチャ（モジュール依存関係図更新）
3. `src/lib/ip-restriction.ts` 設計（`getAllowedRanges()` 追加、内部定数統合、DoS防止定数追加）
4. 変更対象モジュール詳細（server.ts, middleware.ts, ws-server.ts, env.ts, daemon.ts, CLI群）
5. セキュリティ設計（5.5「IP制限と認証の相互作用」新設）
6. データフロー図
7. テスト設計（vi.resetModules() パターン追加）
8. CM_TRUST_PROXY 仕様（値検証・警告追加）
9. 設計上の決定事項とトレードオフ
10. 代替案との比較
11. 影響範囲サマリー（19ファイル詳細テーブル追加）
12. レビュー履歴
13. レビュー指摘事項サマリー
14. 実装チェックリスト

---

### 次のアクション

- [x] 設計方針書レビュー完了（全4ステージ）
- [x] 設計方針書を最新状態に更新
- [ ] **Phase 4**: 作業計画立案（`/work-plan 332`）
- [ ] **Phase 5**: TDD自動開発（`/pm-auto-dev 332`）
- [ ] PR作成（`/create-pr`）

---

*Generated by multi-stage-design-review command*
