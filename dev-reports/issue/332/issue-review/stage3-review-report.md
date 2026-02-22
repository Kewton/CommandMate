# Issue #332 影響範囲レビューレポート (Stage 3)

**レビュー日**: 2026-02-22
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3/4

---

## 前回レビュー（Stage 1）指摘事項の解消状況

Stage 1で指摘された全11件（Must Fix: 3件、Should Fix: 5件、Nice to Have: 3件）は、Stage 2でIssue本文に反映され、**全て解消済み**。

| 指摘ID | 内容 | 状況 |
|--------|------|------|
| MF-001 | 機能要件の欠落 | 解消済み - 機能要件セクションが追加 |
| MF-002 | 受け入れ条件未定義 | 解消済み - 14項目の受け入れ条件が追加 |
| MF-003 | 既存認証との関係性未定義 | 解消済み - Issue #331との関係セクションが追加 |
| SF-001 | 環境変数設計未記載 | 解消済み - CM_ALLOWED_IPS/CM_TRUST_PROXY設計が追加 |
| SF-002 | セキュリティ考慮事項未記載 | 解消済み - セキュリティ考慮事項セクションが追加 |
| SF-003 | Edge Runtime互換性 | 解消済み - Edge Runtime互換性セクションが追加 |
| SF-004 | WebSocket対応未記載 | 解消済み - WebSocket対応セクションが追加 |
| SF-005 | CLIコマンド統合未記載 | 解消済み - CLIコマンド統合セクションが追加 |
| NTH-001 | ドキュメント更新計画 | 解消済み - ドキュメント更新計画セクションが追加 |
| NTH-002 | 関連Issue参照 | 解消済み - #331への参照が追加 |
| NTH-003 | ユースケース・動機 | 解消済み - ユースケースセクションが追加 |

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 5 |
| Nice to Have | 3 |

---

## 影響範囲マップ

### 変更が必要な既存ファイル（8件）

| ファイル | 変更規模 | リスク | 概要 |
|---------|---------|--------|------|
| `src/middleware.ts` | 大 | 高 | IP制限チェックロジック追加（Edge Runtime制約下） |
| `src/config/auth-config.ts` | 小 | 中 | IP制限関連の設定定数追加（Edge Runtime互換維持） |
| `src/lib/env.ts` | 中 | 低 | EnvインターフェースにCM_ALLOWED_IPS/CM_TRUST_PROXY追加 |
| `src/lib/ws-server.ts` | 中 | 中 | upgradeハンドラーにIP制限チェック追加 |
| `src/cli/commands/start.ts` | 中 | 低 | --allowed-ips/--trust-proxyオプション処理 |
| `src/cli/commands/init.ts` | 小 | 低 | 対話形式でのIP制限設定追加 |
| `src/cli/commands/status.ts` | 小 | 低 | IP制限設定の表示追加 |
| `src/cli/utils/daemon.ts` | 小 | 低 | authEnvKeysにCM_ALLOWED_IPS/CM_TRUST_PROXY追加 |

### 新規作成が必要なファイル（2件）

| ファイル | 概要 |
|---------|------|
| `src/lib/ip-restriction.ts` | CIDRマッチング、IPv4/IPv6正規化、CM_ALLOWED_IPSパース（Edge Runtime互換） |
| `tests/unit/ip-restriction.test.ts` | IP制限コアロジックの単体テスト |

### テスト影響（4件）

| ファイル | 概要 |
|---------|------|
| `tests/integration/auth-middleware.test.ts` | IP制限ありのmiddlewareテスト追加 |
| `tests/integration/ws-auth.test.ts` | WebSocket接続IP制限テスト追加 |
| `tests/unit/auth.test.ts` | rate limiterのIPキー変更時のテスト追加（スコープ次第） |
| `tests/unit/env.test.ts` | 新環境変数のテスト追加 |

### 追加変更が必要なファイル（7件）

| ファイル | 概要 |
|---------|------|
| `src/cli/types/index.ts` | StartOptions/EnvConfigインターフェース拡張 |
| `src/cli/index.ts` | startコマンドにオプション追加 |
| `src/cli/utils/env-setup.ts` | .envファイル出力行追加 |
| `src/cli/config/security-messages.ts` | IP制限関連の警告メッセージ追加候補 |
| `docs/security-guide.md` | IP制限セクション・チェックリスト更新 |
| `CLAUDE.md` | 新規モジュール・環境変数の追記 |
| `docs/en/DEPLOYMENT.md` | 環境変数リスト更新 |

---

## Must Fix（必須対応）

### IF-001: NextRequest.ipの利用可否とEdge RuntimeでのクライアントIP取得方法が未明確

**カテゴリ**: 技術的整合性
**影響箇所**: `src/middleware.ts` L65-106

**問題**:
Issueでは「`request.ip` またはソケットのリモートアドレスを使用」と記載しているが、Next.jsの`NextRequest`には`ip`プロパティが標準で存在しない（Vercelのデプロイ環境でのみ利用可能）。Edge RuntimeのmiddlewareではNextRequestオブジェクトからクライアントIPを直接取得する標準的な方法がない。

カスタムサーバーの場合、Next.jsのmiddlewareには接続元ソケット情報が渡されないため、`X-Forwarded-For`ヘッダーがリバースプロキシなしには存在せず、`CM_TRUST_PROXY=false`の環境ではクライアントIPを取得する手段がない。

**証拠**:
```typescript
// src/middleware.ts - NextRequestの型定義にipプロパティはない
import type { NextRequest } from 'next/server';
export async function middleware(request: NextRequest) {
  // request.ip は型エラーになる (Vercel専用)
}
```

**推奨対応**:
以下のいずれかの方針をIssueに明記すべき:
1. カスタムサーバー（server.ts）で全リクエストに`X-Real-IP`ヘッダーを注入し、middleware.tsで読み取る方式
2. middleware.tsではなくカスタムサーバーのリクエストハンドラーレベルでIP制限を実装する方式（`req.socket.remoteAddress`を直接取得可能）
3. `CM_TRUST_PROXY=false`かつカスタムサーバーの場合のIP取得方法を別途設計

---

### IF-002: daemon.tsの環境変数転送リスト(authEnvKeys)にCM_ALLOWED_IPS/CM_TRUST_PROXYの追加が必要

**カテゴリ**: 依存関係
**影響箇所**: `src/cli/utils/daemon.ts` L78-85

**問題**:
`daemon.ts`のauthEnvKeysリストは、startCommand()でprocess.envに設定された認証関連環境変数をデーモンプロセスに転送する仕組みである。Issue #332ではCLIオプション(`--allowed-ips`)からCM_ALLOWED_IPSへの設定を記載しているが、daemon.tsの転送リストへの追加について言及がない。

**証拠**:
```typescript
// src/cli/utils/daemon.ts L78-85
const authEnvKeys = [
  'CM_AUTH_TOKEN_HASH',
  'CM_AUTH_EXPIRE',
  'CM_HTTPS_CERT',
  'CM_HTTPS_KEY',
  'CM_ALLOW_HTTP'
] as const;
// CM_ALLOWED_IPS と CM_TRUST_PROXY が欠落している
```

これが漏れると、`commandmate start --daemon --allowed-ips '192.168.1.0/24'` でデーモンモード起動した場合にIP制限が機能しない。

**推奨対応**:
実装詳細として以下を追記:
- `src/cli/utils/daemon.ts`のauthEnvKeysリストに`CM_ALLOWED_IPS`と`CM_TRUST_PROXY`を追加
- デーモンモードでのIP制限動作を結合テストで確認

---

## Should Fix（推奨対応）

### IF-003: CIDRマッチングの網羅的テストケース定義が不足

**カテゴリ**: テスト範囲

CIDRマッチングはセキュリティ機能の根幹であり、自前実装の場合は以下のテストケースが必須:

| テストケース | 入力例 | 期待結果 |
|------------|--------|---------|
| IPv4 CIDRマッチ | IP: 192.168.1.50, CIDR: 192.168.1.0/24 | true |
| IPv4 CIDR不一致 | IP: 192.168.2.1, CIDR: 192.168.1.0/24 | false |
| IPv6 CIDRマッチ | IP: fe80::1, CIDR: fe80::/10 | true |
| IPv4-mapped IPv6 | IP: ::ffff:192.168.1.1, CIDR: 192.168.1.0/24 | true |
| 単一IPアドレス | IP: 10.0.0.1, CIDR: 10.0.0.1 | true |
| 境界値 /32 | IP: 10.0.0.1, CIDR: 10.0.0.1/32 | true |
| 境界値 /0 | IP: 任意, CIDR: 0.0.0.0/0 | true |
| 不正CIDR形式 | CIDR: "invalid" | エラー/false |
| 複数CIDR(OR判定) | IP: 10.0.0.1, CIDRs: [192.168.0.0/16, 10.0.0.0/8] | true |

**推奨対応**: 受け入れ条件に上記テストケースの具体的な項目を追加。

---

### IF-004: login/route.tsのrate limiterとCM_TRUST_PROXYの連携設計

**カテゴリ**: 既存コードとの整合性
**影響箇所**: `src/app/api/auth/login/route.ts` L22-35

`login/route.ts`のL33に「A future CM_TRUST_PROXY option could enable per-IP limiting behind a proxy」と記載されている。CM_TRUST_PROXYの導入はこのコメントの構想を実現する機会だが、rate limiterの変更がIP制限のスコープに含まれるかどうかが不明確。

**推奨対応**: rate limiterのIP化をスコープ内に含めるか、別Issueとして分離するかを明記。

---

### IF-005: CLI型定義・コマンド定義の更新が未記載

**カテゴリ**: 影響範囲

以下のファイルがIssueの影響範囲に含まれるべきだが未記載:
- `src/cli/types/index.ts`: StartOptionsに`allowedIps?: string`、`trustProxy?: boolean`を追加
- `src/cli/index.ts`: startコマンドに`--allowed-ips`/`--trust-proxy`オプション追加
- `src/cli/utils/env-setup.ts`: `.env`ファイルへのCM_ALLOWED_IPS/CM_TRUST_PROXY出力

---

### IF-006: Edge Runtimeからのセキュリティログ出力方針が不明確

**カテゴリ**: セキュリティ
**影響箇所**: `src/cli/utils/security-logger.ts`, `src/middleware.ts`

`security-logger.ts`はファイルベースのログ出力を行うCLIモジュールだが、Edge Runtimeからはファイルシステムにアクセスできない。middleware.tsでのIP制限拒否ログの出力先を明確にする必要がある。

**推奨対応**: middleware.tsでは`console.warn()`、ws-server.tsでは`security-logger.ts`を使用する方針を明記。

---

### IF-007: env-setup.tsのcreateEnvFile()更新が必要

**カテゴリ**: 設定ファイル影響
**影響箇所**: `src/cli/utils/env-setup.ts` L232-242

`commandmate init`で生成される`.env`ファイルにCM_ALLOWED_IPS/CM_TRUST_PROXYの行を追加する必要がある（コメントアウト状態の雛形含む）。EnvConfigインターフェースにもオプショナルフィールドの追加が必要。

---

## Nice to Have（あれば良い）

### IF-008: 既存テストのモック構造拡張

`tests/integration/auth-middleware.test.ts`のMockNextRequestにIP情報のモック機構が必要。テスト実装時にヘッダーモックまたはIPモックユーティリティの設計を検討。

### IF-009: CIDRマッチング実装方針の判断基準

自前実装とEdge互換ライブラリの選択基準を追記すると、実装判断が容易になる。IPv4のみの自前実装は50行程度、IPv6含めると200行超。

### IF-010: CM_BIND=127.0.0.1時のIP制限無効化通知

localhost限定の場合にIP制限が実質無効であることをCLI起動時にinfoメッセージとして表示すると、ユーザーの設定ミスを防止できる。

---

## 影響範囲の全体像

```
                    +------------------+
                    | Issue #332       |
                    | IP制限オプション   |
                    +--------+---------+
                             |
            +----------------+----------------+
            |                |                |
     +------+------+  +-----+------+  +------+------+
     | 新規作成     |  | 既存変更    |  | テスト      |
     +------+------+  +-----+------+  +------+------+
            |                |                |
  ip-restriction.ts   middleware.ts    ip-restriction.test.ts
                      auth-config.ts   auth-middleware.test.ts
                      env.ts          ws-auth.test.ts
                      ws-server.ts    env.test.ts
                      start.ts
                      init.ts
                      status.ts
                      daemon.ts
                             |
                    +--------+--------+
                    | 追加変更         |
                    +-----------------+
                    cli/types/index.ts
                    cli/index.ts
                    cli/utils/env-setup.ts
                    security-messages.ts
                    docs/security-guide.md
                    CLAUDE.md
                    docs/en/DEPLOYMENT.md
```

---

## 後方互換性

| 項目 | 影響 | 対応 |
|------|------|------|
| CM_ALLOWED_IPS未設定 | 影響なし | 従来通りIP制限なしで動作 |
| CM_TRUST_PROXY未設定 | 影響なし | デフォルトfalseで既存動作維持 |
| 既存.envファイル | 影響なし | 新環境変数なしでも起動可能 |
| トークン認証(CM_AUTH_TOKEN_HASH) | 影響なし | IP制限と独立して動作（AND条件） |
| 既存APIレスポンス | 影響なし | 403レスポンスは新規IP拒否時のみ |
| 既存テスト | 軽微な影響 | モック構造の拡張が必要な可能性あり |

---

## リスク評価

| リスクレベル | 対象 | 理由 |
|------------|------|------|
| **高** | middleware.ts | Edge RuntimeでのIP取得方法の技術的不確実性（IF-001） |
| **中** | ws-server.ts | IPv4-mapped IPv6の正規化が必要 |
| **中** | auth-config.ts | モジュール責務の拡大（認証設定 + IP制限設定） |
| **低** | CLI関連全般 | Issue #331のパターンに従った実装で対応可能 |
| **低** | env.ts | オプショナルフィールドの追加のみ |

---

## 参照ファイル

### コード
- `src/middleware.ts` (L65-106): IP制限の主要実装箇所
- `src/config/auth-config.ts` (L1-7): Edge Runtime互換制約
- `src/lib/env.ts` (L172-196): Envインターフェース
- `src/lib/ws-server.ts` (L63-95): WebSocket upgradeハンドラー
- `src/cli/utils/daemon.ts` (L78-85): authEnvKeys転送リスト
- `src/app/api/auth/login/route.ts` (L22-35): CM_TRUST_PROXY構想コメント
- `src/cli/types/index.ts` (L34-59): StartOptionsインターフェース
- `src/cli/index.ts` (L41-69): startコマンドcommander定義
- `src/cli/utils/env-setup.ts` (L232-242): .envファイル出力

### テスト
- `tests/integration/auth-middleware.test.ts`: middlewareテスト
- `tests/integration/ws-auth.test.ts`: WebSocket認証テスト
- `tests/unit/auth.test.ts`: 認証単体テスト
- `tests/unit/env.test.ts`: 環境変数テスト

### ドキュメント
- `docs/security-guide.md`: セキュリティガイド
- `CLAUDE.md`: プロジェクトガイドライン
- `docs/en/DEPLOYMENT.md`: デプロイメントガイド
