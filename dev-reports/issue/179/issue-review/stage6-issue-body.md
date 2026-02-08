> **Note**: このIssueは 2026-02-08 にレビュー結果を反映して更新されました。（2回目通常レビュー反映済み）
> 詳細: dev-reports/issue/179/issue-review/

## 概要

現在の`CM_AUTH_TOKEN`による認証機能を削除し、外部公開時はリバースプロキシでの認証を推奨する方針に変更する。

関連: #174

## 背景

### 現在の認証方式の問題

現在の実装では`NEXT_PUBLIC_CM_AUTH_TOKEN`がクライアントJSに埋め込まれるため、**セキュリティとして機能していない**。

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  .env           │     │  ブラウザJS      │     │  サーバー   │
│  CM_AUTH_TOKEN  │ ──> │  (NEXT_PUBLIC_*) │ ──> │  検証       │
│  = "secret123"  │     │  = "secret123"   │     │             │
└─────────────────┘     └──────────────────┘     └─────────────┘
                               ↑
                        DevToolsで丸見え
```

| 攻撃者の行動 | 結果 |
|-------------|------|
| DevTools → Network → リクエストヘッダー確認 | トークン取得可能 |
| JSファイルを検索 | トークン取得可能 |
| ビルド済み.nextフォルダを確認 | トークン取得可能 |

**結論**: 現在のトークン方式は「セキュリティシアター」であり、悪意のある攻撃者には無力。

## 解決策

### 1. 認証機能を削除

- `src/middleware.ts`の認証ロジックを削除（**ファイル自体を削除する。将来必要になった時点で再作成する方針**）
- `CM_AUTH_TOKEN`/`NEXT_PUBLIC_CM_AUTH_TOKEN`環境変数を非推奨化
- `api-client.ts`のAuthorizationヘッダー送信を削除（clientAuthTokenWarned変数、authToken取得ロジック全体、deprecation警告ロジック含む）

### 2. リバースプロキシ認証を推奨

外部公開が必要な場合は、以下の方法をドキュメントで推奨：

#### Nginx + Basic認証の例

```nginx
server {
    listen 443 ssl;
    server_name commandmate.example.com;

    # Basic認証
    auth_basic "CommandMate";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

#### Cloudflare Access / Tailscale

- Cloudflare Access: ゼロトラストアクセス
- Tailscale: VPNメッシュネットワーク

### 3. commandmate init / start での警告メッセージ

`commandmate init`で外部公開設定（`CM_BIND=0.0.0.0`）を選択した場合、以下の警告メッセージを出力する：

```
⚠️  外部公開設定が有効です

CommandMateを外部ネットワークに公開する場合は、
リバースプロキシでの認証設定を強く推奨します。

推奨される認証方法:
  • Nginx + Basic認証
  • Cloudflare Access
  • Tailscale

詳細: https://github.com/Kewton/CommandMate/blob/main/docs/security-guide.md
```

また、`commandmate start`/`daemon`実行時にも`CM_BIND=0.0.0.0`の場合は同様のリバースプロキシ推奨警告を出力する（既存のセキュリティ警告ロジックを「AUTH_TOKEN未設定警告」から「リバースプロキシ推奨警告」に**置換**する方式）。

## 実装タスク

### サーバー側（認証ロジック削除）

- [ ] `src/middleware.ts` **ファイル自体を削除**（全89行が認証ロジックのみ。将来必要になった時点で再作成する）
- [ ] `src/lib/api-client.ts`からAuthorizationヘッダー送信を削除
  - `clientAuthTokenWarned`変数（行45）を削除
  - `authToken`取得ロジック（行54-55: `NEXT_PUBLIC_CM_AUTH_TOKEN`/`NEXT_PUBLIC_MCBD_AUTH_TOKEN`参照、およびその周辺のfallback/deprecation処理 行52-65全体）を削除
  - deprecation警告ロジック（行58-64）を削除
  - `Authorization`ヘッダー設定（行70-73）を削除
- [ ] `src/lib/env.ts`から`CM_AUTH_TOKEN`関連を削除
  - `ENV_MAPPING`定数からCM_AUTH_TOKENエントリ（行24-33内）を削除（EnvKey型に自動波及）
  - `Env` interfaceの`CM_AUTH_TOKEN`フィールド削除
  - `getEnvWithFallback()`のCM_AUTH_TOKEN/MCBD_AUTH_TOKEN処理削除
  - `CM_BIND=0.0.0.0`時の`CM_AUTH_TOKEN`必須チェック（行228-229のthrow）を削除
  - `isAuthRequired()`関数を削除
- [ ] `src/lib/logger.ts`からAUTH_TOKENマスキングパターンを削除
- [ ] `src/cli/utils/security-logger.ts`からAUTH_TOKENマスキング処理を削除

### CLI側（認証トークン設定削除）

- [ ] `src/cli/commands/init.ts`から認証トークン設定プロンプトを削除
  - 行90-100（enableExternal分岐内のauthToken生成・表示ロジック全体）を削除
- [ ] `src/cli/commands/init.ts`で`CM_BIND=0.0.0.0`選択時にリバースプロキシ推奨の警告メッセージを出力
- [ ] `src/cli/commands/start.ts`のCM_BIND=0.0.0.0セキュリティ警告（行168-174）を「リバースプロキシ推奨警告」に**置換**（削除ではなく置換）
- [ ] `src/cli/utils/daemon.ts`のCM_BIND=0.0.0.0セキュリティ警告（行78-84）を「リバースプロキシ推奨警告」に**置換**（削除ではなく置換）
- [ ] `src/cli/utils/env-setup.ts`から以下を削除:
  - `.env`ファイル生成時のCM_AUTH_TOKEN書き込み
  - `validateConfig()`内のCM_AUTH_TOKEN認証チェック（行300）
  - `generateAuthToken()`メソッド（行278-280）を削除
- [ ] `src/cli/types/index.ts`のEnvConfig interfaceからCM_AUTH_TOKENフィールドを削除

### 環境変数・設定ファイル

- [ ] `.env.example`から`CM_AUTH_TOKEN`行（行29）を削除し、`CM_BIND`説明コメント（行16-18）の「auth required」を「reverse proxy auth recommended」に更新
- [ ] `.env.production.example`から以下を更新:
  - `CM_AUTH_TOKEN`および`NEXT_PUBLIC_CM_AUTH_TOKEN`を削除
  - `CM_BIND`説明コメント（行17-18）の「auth required」を「reverse proxy auth recommended」に更新
  - 「Security (REQUIRED FOR PRODUCTION)」セクション（行23-34）をリバースプロキシ推奨に書き換え
  - Legacy Supportセクション（行74）から`MCBD_AUTH_TOKEN -> CM_AUTH_TOKEN`の行を削除
- [ ] `scripts/setup-env.sh`から`NEXT_PUBLIC_CM_AUTH_TOKEN`関連設定を削除

### ドキュメント更新

- [ ] 外部公開時のセキュリティガイド（`docs/security-guide.md`）を新規作成
- [ ] `docs/DEPLOYMENT.md`更新:
  - セキュリティセクション（行237-258）をリバースプロキシ認証推奨に書き換え
  - 必須環境変数一覧（行155）からCM_AUTH_TOKENを削除
- [ ] `docs/TRUST_AND_SAFETY.md`更新:
  - 「外部アクセス時の依存」セクション（行23-28）をリバースプロキシ認証推奨に書き換え
  - 「最小権限ガイド」セクション（行36-41）を更新
  - 旧名称MCBD_*を新名称CM_*に統一
- [ ] `docs/migration-to-commandmate.md`からNEXT_PUBLIC_MCBD_AUTH_TOKEN -> NEXT_PUBLIC_CM_AUTH_TOKENマッピングを削除
- [ ] `README.md`更新:
  - 「モバイルからのアクセス」セクション（行82-84）のCM_AUTH_TOKEN自動設定への言及を削除
  - 外部アクセス時のリバースプロキシ推奨を記載
- [ ] `docs/concept.md`更新: 行165のCM_AUTH_TOKEN参照を削除
- [ ] `docs/architecture.md`更新: 行77,451,469-470のMCBD_AUTH_TOKEN参照をリバースプロキシ方式に書き換え
- [ ] `docs/user-guide/webapp-guide.md`更新: 行262のCM_AUTH_TOKEN参照を削除
- [ ] `docs/internal/PRODUCTION_CHECKLIST.md`更新: 行30,112,330のCM_AUTH_TOKENチェック項目をリバースプロキシ推奨に更新
- [ ] `docs/internal/TESTING_GUIDE.md`更新: 行28,385のCM_AUTH_TOKEN参照を削除
- [ ] `docs/internal/swe-agents.md`更新: 行117,184,233のMCBD_AUTH_TOKEN参照を更新
- [ ] `docs/internal/requirements-design.md`更新: 行108,214のNFR-SEC-02要件をリバースプロキシ方式に更新
- [ ] CHANGELOG更新（破壊的変更として記載、Issue #76で導入されたCM_AUTH_TOKEN/MCBD_AUTH_TOKENフォールバック機能の削除を明記）

### テストファイル更新

- [ ] `tests/unit/env.test.ts` - CM_AUTH_TOKEN関連テストの削除・更新
- [ ] `tests/unit/middleware.test.ts` - **ファイル自体を削除**（全182行が認証テストのみ。middleware.ts削除に伴う）
- [ ] `tests/unit/logger.test.ts` - AUTH_TOKENマスキングテストの削除・更新
- [ ] `tests/unit/cli/utils/env-setup.test.ts` - CM_AUTH_TOKEN関連テストの削除・更新（generateAuthToken関連テスト含む）
- [ ] `tests/unit/cli/utils/daemon.test.ts` - セキュリティ警告テストをリバースプロキシ推奨警告テストに更新
- [ ] `tests/unit/cli/utils/security-logger.test.ts` - AUTH_TOKENマスキングテストの削除・更新

## 受け入れ条件

- [ ] `CM_BIND=0.0.0.0`設定時も認証なしでAPIアクセス可能
- [ ] 既存の`CM_AUTH_TOKEN`設定があっても動作に影響なし（無視される）
- [ ] `commandmate init`で外部公開設定時にリバースプロキシ認証推奨メッセージが表示される
- [ ] `commandmate start`で`CM_BIND=0.0.0.0`時にリバースプロキシ推奨警告が表示される
- [ ] 外部公開時のセキュリティガイド（`docs/security-guide.md`）がドキュメントに追加されている
- [ ] `DEPLOYMENT.md`と`TRUST_AND_SAFETY.md`のセキュリティセクションが更新されている
- [ ] AUTH_TOKEN関連の全ドキュメント（7件追加: concept.md, architecture.md, webapp-guide.md, PRODUCTION_CHECKLIST.md, TESTING_GUIDE.md, swe-agents.md, requirements-design.md）が更新されている
- [ ] AUTH_TOKEN関連のテストが全て更新され、`npm run test:unit`が通ること
- [ ] `npm run lint`と`npx tsc --noEmit`が通ること
- [ ] CHANGELOGに破壊的変更（BREAKING CHANGE）として記載されていること

## 影響範囲

### 影響ファイル一覧（合計31件）

| カテゴリ | 件数 | 影響度HIGH | 備考 |
|---------|------|-----------|------|
| ソースコード | 9 | middleware.ts, env.ts | |
| 型定義 | 2 | env.ts, cli/types/index.ts | env.tsはソースコードと重複カウント |
| テスト | 6 | middleware.test.ts | |
| 設定ファイル | 3 | .env.example, .env.production.example, setup-env.sh | |
| ドキュメント | 10 | DEPLOYMENT.md, TRUST_AND_SAFETY.md | |
| 新規ファイル | 1 | docs/security-guide.md | |

> ※ ユニークファイル数は30件（env.tsがソースコード/型定義で重複カウント）

### 破壊的変更の影響を受けるユーザー

| ユーザータイプ | 影響度 | 必要な対応 |
|--------------|--------|-----------|
| CM_BIND=0.0.0.0で運用中 | **CRITICAL** | リバースプロキシでの認証設定が必須。アップグレード前にリバースプロキシを設定する |
| CM_BIND=127.0.0.1で運用中 | NONE | 対応不要 |
| CI/CDでCM_AUTH_TOKENを設定 | LOW | 設定削除は任意（エラーにはならない） |

## 破壊的変更

- `CM_AUTH_TOKEN`/`NEXT_PUBLIC_CM_AUTH_TOKEN`は無視されるようになる
- 認証が必要な場合はリバースプロキシでの設定が必要
- Issue #76で導入されたCM_AUTH_TOKEN/MCBD_AUTH_TOKENフォールバック機能を削除

## セキュリティ考慮

- CommandMateは「信頼できるネットワーク内での使用」を前提とする
- 外部公開時はリバースプロキシでの認証を必須とする
- ドキュメントで明確に警告を記載
- `commandmate start`/`daemon`実行時のCM_BIND=0.0.0.0警告は削除せず、リバースプロキシ推奨警告に置換して維持する（既存ユーザーがinitを再実行せずにstartのみで運用を続けるケースへの対応）

---

## レビュー履歴

### イテレーション 1 - 通常レビュー (2026-02-08)
- MF-1: タイトルを「feat!: CM_AUTH_TOKEN認証機能を削除し、リバースプロキシ認証を推奨」に修正
- MF-2: NEXT_PUBLIC_CM_AUTH_TOKEN削除タスク（scripts/setup-env.sh等）を追加
- MF-3: env.tsのCM_BIND=0.0.0.0必須チェック削除を明記
- SF-1: logger.ts/security-logger.tsのAUTH_TOKENマスキング削除を追加
- SF-2: テストファイル更新セクションを新設（6ファイル）
- SF-3: TRUST_AND_SAFETY.md更新タスクを追加
- SF-4: 警告メッセージのドキュメントリンクを修正
- SF-5: DEPLOYMENT.md更新タスクを追加

### イテレーション 1 - 影響範囲レビュー (2026-02-08)
- ドキュメント7件の更新タスクを追加（concept.md, architecture.md等）
- 受け入れ条件にドキュメント更新確認を追加

### イテレーション 2 - 通常レビュー (2026-02-08)
- MF-4: .env.example/.env.production.exampleのCM_BIND説明コメント「auth required」を「reverse proxy auth recommended」に更新するタスクを追加
- SF-6: .env.production.exampleのLegacy Supportセクションから MCBD_AUTH_TOKEN -> CM_AUTH_TOKEN 行の削除を追加
- SF-7: 受け入れ条件にCHANGELOG破壊的変更記載の確認を追加
- SF-8: api-client.tsの行番号を「行54-55」に修正し、行52-65全体の意図を明確化
- NTH-4: 影響ファイル合計を「31件」に修正し、重複カウントの注記を追加
