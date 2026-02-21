> **Note**: このIssueは 2026-02-21 にStage 1レビュー結果を反映して更新されました。
> 詳細: dev-reports/issue/331/issue-review/

## 概要

サーバー起動時にオプションでトークン認証を有効化し、全APIルート・WebSocket接続にアクセス制御を追加する。CLIでトークンを有効期限付きで発行し、フロントエンドにシンプルなトークン入力画面を提供する。デフォルトは認証なし（後方互換性維持）。

また、HTTPS直接配信モードを追加し、トークン認証使用時はデフォルトでHTTPS通信のみを許可する。通常起動（認証なし）はHTTPのまま。

## 背景・課題

- ngrokなどのトンネリングサービス利用時に認証なしでAPIが公開されるリスクがある
- スマホから同一WiFi経由で利用する際にも認証機能がない
- Issue #179で旧CM_AUTH_TOKEN（クライアント側環境変数に公開されていた問題）を削除し、リバースプロキシ推奨方式に移行したが、リバースプロキシ設定はユーザーの負担が大きい
- アプリケーション内蔵の軽量な認証機能があれば、リバースプロキシなしでも安全に外部アクセスが可能になる
- トークン認証をHTTP上で使用するとトークンが平文で流れるため、HTTPS直接配信によるトークン保護が必要

## 提案する解決策

### 認証フロー

```
1. CLI起動時にトークン生成
   commandmate start --auth --cert ./cert.pem --key ./key.pem [--auth-expire 48h]
   → crypto.randomBytesでランダムトークンを生成
   → ターミナルに表示
   → 環境変数CM_AUTH_TOKEN_HASH（ハッシュ値）としてサーバープロセスに渡す
   → server.ts起動時にprocess.env.CM_AUTH_TOKEN_HASHからauth.tsモジュールにロード
   → auth.tsがメモリ上でトークンハッシュを保持し検証関数を提供
   → HTTPSサーバーとして起動

2. ユーザーがブラウザでアクセス（https://）
   → 未認証の場合、ログイン画面にリダイレクト
   → トークン入力画面を表示

3. トークン入力・認証
   → サーバー側でトークン検証
   → 成功時にHttpOnly Secure Cookieでセッション管理（有効期限はトークンと連動）
   → 全APIルート・WebSocket（wss://）で認証チェック
```

### トークンのCLI-サーバー間データフロー

<!-- F004: トークンの具体的な共有メカニズムを明記 -->

トークンがCLIからサーバーに渡るまでの流れを以下に示す。

1. **CLIでのトークン生成** (`src/lib/auth.ts`): `crypto.randomBytes(32)` でランダムトークンを生成
2. **ターミナル表示**: 生成したトークンをそのままターミナルに表示（ユーザーがブラウザにコピー＆ペーストする用途）
3. **環境変数経由でサーバープロセスに伝達**:
   - **foregroundモード**: `start.ts` が `npm run start` をspawnする際に `CM_AUTH_TOKEN_HASH=<ハッシュ値>` を `env` に設定
   - **daemonモード**: `DaemonManager.start()` がspawnする際に同様に `env` に設定（`daemon.ts` の修正が必要）
4. **server.ts起動時のロード**: `process.env.CM_AUTH_TOKEN_HASH` から `auth.ts` モジュールにハッシュをロードし、メモリ上で保持
5. **検証**: リクエスト/WebSocket接続時に `auth.ts` の検証関数を呼び出してトークンをチェック

> **注意**: トークン自体（平文）は環境変数に含めず、ハッシュ値のみを渡す。これにより `/proc/<pid>/environ` 等からのトークン漏洩リスクを軽減する。

### 認証の責務境界

<!-- F003: middleware.tsとws-server.tsの認証責務を明確化 -->

| 認証レイヤー | 担当モジュール | 対象 | 備考 |
|-------------|---------------|------|------|
| **HTTPリクエスト認証** | `src/middleware.ts` | APIルート、ページアクセス | Next.jsリクエストハンドリングパイプライン内で動作 |
| **WebSocket接続認証** | `src/lib/ws-server.ts` | WebSocket upgradeリクエスト | middleware.tsとは独立して実装 |

**重要**: Next.js middleware.tsはNext.jsのリクエストハンドリングパイプライン内でのみ動作する。WebSocket upgradeリクエストはNext.jsのパイプラインを通らないため、WebSocket認証はmiddleware.tsに依存せず、ws-server.tsのupgradeハンドラー内で独立して実装する。server.ts内のcreateServerのrequestハンドラーはnext()のhandle()を呼ぶため、通常のAPIルートへのリクエストはmiddleware.tsを通る（これは正しい）。

### HTTPS動作モード

| 起動方法 | プロトコル | 認証 | 用途 |
|----------|-----------|------|------|
| `commandmate start` | HTTP | なし | ローカル開発（従来通り） |
| `commandmate start --auth` | HTTP（警告表示） | あり | 証明書なしでの簡易認証 |
| `commandmate start --auth --allow-http` | HTTP（警告抑制） | あり | HTTP認証を明示的に許可 |
| `commandmate start --auth --cert ./cert.pem --key ./key.pem` | **HTTPS** | あり | **推奨**: 外部アクセス時 |
| `commandmate start --https --cert ./cert.pem --key ./key.pem` | HTTPS | なし | 認証なしHTTPS（特殊用途） |

### 証明書の準備（mkcert推奨）

ローカル開発・WiFi経由アクセス用の証明書生成にはmkcertを推奨する。

```bash
# mkcertのインストール
brew install mkcert   # macOS
mkcert -install       # ローカルCAをシステムに登録

# 証明書生成（localhostとローカルIPを含める）
mkcert localhost 192.168.x.x
# → localhost+1.pem（証明書）と localhost+1-key.pem（秘密鍵）が生成される

# 起動例
commandmate start --auth --cert ./localhost+1.pem --key ./localhost+1-key.pem
```

### 主要な変更点

- **CLI**: `--auth` オプション追加。`--auth-expire` で有効期限指定（デフォルト24時間）
- **CLI**: `--https`, `--cert`, `--key`, `--allow-http` オプション追加
- **HTTPS対応**: server.tsで`https.createServer()`を条件分岐で使用
- **認証ミドルウェア**: Next.js middleware.tsを新規作成。全APIルート・ページに認証チェック適用（HTTPリクエストのみ担当）
- **WebSocket認証**: ws-server.tsのupgradeハンドラー内でCookieからトークン検証（middleware.tsとは独立）
- **ログイン画面**: トークン入力テキストボックス＋ログインボタンのシンプルUI
- **トークン管理**: サーバー側はメモリ保持（サーバー停止で失効）、クライアント側はHttpOnly Cookie
- **ブルートフォース対策**: ログインAPIにIPベースのレート制限を実装

### 設計方針

- `--auth` なしの起動は従来と完全に同じ動作（後方互換性維持）
- `--auth` 指定時、証明書（`--cert`/`--key`）があればHTTPS起動。なければ警告を出してHTTP起動
- `--allow-http` で `--auth` 時のHTTP警告を抑制
- トークンはサーバーメモリに保持し、サーバー停止で自動失効
- Issue #179の教訓を踏まえ、クライアント側環境変数にトークンを含めない

<!-- F005: 環境変数名の衝突回避 -->
- **環境変数名**: Issue #179で削除された旧`CM_AUTH_TOKEN`/`NEXT_PUBLIC_CM_AUTH_TOKEN`との混同を避けるため、新しい環境変数名は`CM_AUTH_TOKEN_HASH`を使用する。旧`.env`に`CM_AUTH_TOKEN`が残っている場合に備え、起動時にバリデーションを行い「旧CM_AUTH_TOKENは使用されません。--auth オプションを使用してください」等の警告を表示する
- HTTPS時: HttpOnly + Secure + SameSite=Strict Cookie
- HTTP時: HttpOnly + SameSite=Strict Cookie（Secureなし）
- Cookieの有効期限はトークンの有効期限に連動（トークンが24hならCookieも24hで失効）
- クライアント側WebSocket（useWebSocket.ts）は既にwss://自動検出対応済み
- CSP（next.config.js）は既にws:/wss:両方許可済み

<!-- F001: ws-server.tsのHTTPS Server型互換性 -->
- **setupWebSocket()の型互換性**: `ws-server.ts` の `setupWebSocket()` 関数の引数型は、現在 `http.Server` (`HTTPServer`) に限定されているが、HTTPS対応に伴い `http.Server | https.Server`（または共通の親型 `net.Server`）に拡張する。Node.jsの実行時には `https.Server` は `http.Server` を継承しているため動作するが、TypeScriptの厳密な型チェックでエラーとなる可能性があるため、明示的に型を拡張する

<!-- F002: DaemonManagerへのオプション伝達 -->
- **デーモンモードでのオプション伝達**: `DaemonManager.start()` (`daemon.ts`) が子プロセスをspawnする際に、認証・HTTPS関連オプションを環境変数経由で子プロセスに渡す。対象環境変数: `CM_AUTH_TOKEN_HASH`, `CM_AUTH_EXPIRE`, `CM_HTTPS_CERT`, `CM_HTTPS_KEY`, `CM_ALLOW_HTTP`。`DaemonManager.getStatus()` のURL生成もHTTPS対応（`http://` -> `https://`）に修正する

<!-- F008: WebSocket Cookieパースのセキュリティ -->
- **WebSocket Cookieパース**: ws-server.tsのupgradeハンドラーでは `IncomingMessage` の `headers.cookie` から手動でCookieをパースする必要がある（wsパッケージは自動パースしない）。`auth.ts` にCookieパース用ユーティリティ関数を追加し、パースエラー時は接続を拒否する。`next/headers` の `cookies()` はEdge Runtimeのため使用不可

<!-- F009: security-messages.tsとの整合性 -->
- **セキュリティ警告メッセージの更新**: `security-messages.ts` の `REVERSE_PROXY_WARNING` を `--auth` 有効時に応じて更新する。認証有効+HTTPS時は適切なメッセージに変更し、認証有効+HTTP時は「WARNING: Token authentication without HTTPS. Token may be intercepted.」等の警告に変更する

<!-- F011: auth-expireのパース仕様 -->
- **--auth-expire フォーマット仕様**: 以下のフォーマットをサポートする
  - `Nh`: N時間（例: `24h`, `48h`）
  - `Nd`: N日（例: `1d`, `7d`）
  - `Nm`: N分（例: `30m`）- テスト用途向け
  - 最小値: `1h`、最大値: `30d`
  - 無効な値の場合: バリデーションエラーメッセージを表示して起動中断
  - パース実装: `ms` npmライブラリの利用、またはシンプルな正規表現パーサーを検討

<!-- F012: 証明書パスのバリデーション方針 -->
- **証明書パスのバリデーション方針**: 証明書ファイルは任意の場所に配置可能であるため、`resolveSecurePath()` のようなallowedBaseDir制限は不適切。代わりに以下のバリデーションを実施する:
  1. `fs.existsSync()` による存在確認
  2. `fs.accessSync(path, fs.constants.R_OK)` による読み取り権限の確認
  3. `fs.realpathSync()` によるシンボリックリンクの解決
  4. ファイルサイズの上限チェック（例: 1MB）で不正なファイル指定を防止

<!-- F014: Env interfaceへのフィールド追加方針 -->
- **env.tsのフィールド追加方針**: 認証・HTTPS関連のフィールドはオプショナルとして `Env` interface に追加する。例: `CM_AUTH_TOKEN_HASH?: string`, `CM_AUTH_EXPIRE?: string`, `CM_HTTPS_CERT?: string`, `CM_HTTPS_KEY?: string`。`ENV_MAPPING` への旧名フォールバックは不要（新規フィールドのため）

### セキュリティ対策

#### CSRF対策

`SameSite=Strict` Cookieにより、外部サイトからのクロスオリジンリクエストにCookieが送信されないため、CSRFを防止する。追加のCSRFトークンは不要と判断する。

**根拠**:
- `SameSite=Strict` は最も厳格なSameSiteポリシーであり、異なるオリジンからのリクエストにはCookieが一切付与されない
- ログインAPI（`POST /api/auth/login`）はJSONボディでトークン文字列を送信する形式のため、攻撃者がトークンを知らない限りCSRFは成立しない
- 全APIがJSONベースのため、HTMLフォームによるクロスオリジンPOST攻撃のリスクも低い

#### ブルートフォース対策

ログインAPI（`POST /api/auth/login`）にIPベースのレート制限を実装し、トークンの総当たり攻撃を防止する。

**方針**:
- IPアドレスごとにログイン試行回数をメモリ上でカウント（Map管理）
- 一定回数（例: 5回）の認証失敗後、一定時間（例: 15分）そのIPからのログイン試行をブロック
- ブロック中は `429 Too Many Requests` を返却
- レート制限状態はサーバーメモリ上で管理（サーバー再起動でリセット）
- ログイン画面にも残り試行回数やロックアウト中のメッセージを表示

<!-- F018: IPアドレス取得方針 -->
- **IPアドレス取得方針**: ビルトイン認証の主な用途はリバースプロキシなしでの直接接続であるため、初回実装では `req.socket.remoteAddress` を使用する。リバースプロキシ経由（X-Forwarded-For / X-Real-IP）への対応は将来課題とする

## 実装タスク

### トークン認証

- [ ] トークン生成ユーティリティの実装（`src/lib/auth.ts`）
  - ランダムトークン生成（crypto.randomBytes）
  - 有効期限管理（メモリ上）
  - トークン検証関数
  - WebSocket用Cookieパースユーティリティ関数（パースエラー時は接続拒否）
- [ ] CLIオプション追加（`src/cli/commands/start.ts`）
  - `--auth` フラグ
  - `--auth-expire <duration>` オプション（デフォルト24h）
    - サポートフォーマット: `Nh`（時間）, `Nd`（日）, `Nm`（分）
    - 最小値: 1h、最大値: 30d
    - バリデーションエラー時は起動中断
  - 起動時にトークンをターミナル表示
<!-- F004: CLIがトークンを生成し、ハッシュ値を環境変数で渡す -->
  - トークン生成後、ハッシュ値を `CM_AUTH_TOKEN_HASH` 環境変数として設定
- [ ] CLIオプション追加: commander設定（`src/cli/index.ts`）
<!-- F007: CLI index.tsのcommander設定 -->
  - startコマンドのcommander option定義追加（`--auth`, `--auth-expire`, `--https`, `--cert`, `--key`, `--allow-http`）
- [ ] Next.js認証ミドルウェアの実装（`src/middleware.ts`新規作成）
  - Cookie/Authorizationヘッダーからトークン取得
  - 未認証時はログインページにリダイレクト
  - `/api/auth/*` と静的リソースは認証除外
  - **対象はHTTPリクエスト（APIルート・ページ）のみ。WebSocket upgradeリクエストは対象外**
- [ ] ログインAPI実装（`src/app/api/auth/login/route.ts`新規作成）
  - トークン検証
  - HttpOnly Cookie設定（HTTPS時はSecure属性付与、有効期限はトークンの残り有効期限と連動）
- [ ] ログアウトAPI実装（`src/app/api/auth/logout/route.ts`新規作成）
  - Cookie削除
<!-- F015: ログアウトUXフロー -->
  - ログアウト後はログインページにリダイレクト
- [ ] ログイン画面の実装（`src/app/login/page.tsx`新規作成）
  - トークン入力テキストボックス
  - ログインボタン
  - エラー表示（残り試行回数、ロックアウト中メッセージを含む）
  - i18n対応
<!-- F015: ログアウトボタンの配置 -->
- [ ] ログアウトボタンの配置
  - サイドバー下部にログアウトリンクを配置（認証有効時のみ表示）
- [ ] WebSocket認証チェック追加（`src/lib/ws-server.ts`）
  - **upgradeハンドラー内**でCookieからトークン検証（middleware.tsとは独立）
  - 認証失敗時は接続拒否
  - `IncomingMessage` の `headers.cookie` を `auth.ts` のCookieパースユーティリティで解析
<!-- F001: setupWebSocket()の型修正 -->
  - `setupWebSocket()` の引数型を `http.Server | https.Server`（または `net.Server`）に拡張

### ブルートフォース対策

- [ ] レート制限ユーティリティの実装（`src/lib/auth.ts` 内、またはrate-limiter専用モジュール）
  - IPアドレスベースの試行回数カウント（Mapで管理）
  - 失敗回数上限（デフォルト: 5回）
  - ロックアウト時間（デフォルト: 15分）
  - ロックアウト中は `429 Too Many Requests` レスポンス
  - 認証成功時にカウントリセット
  - 古いエントリの自動クリーンアップ（メモリリーク防止）
  - IPアドレス取得: `req.socket.remoteAddress` を使用（リバースプロキシ対応は将来課題）
- [ ] ログインAPIにレート制限を組み込み（`src/app/api/auth/login/route.ts`）
  - 認証チェック前にレート制限チェック
  - レスポンスに `Retry-After` ヘッダーを含める
- [ ] ログイン画面にレート制限状態を表示（`src/app/login/page.tsx`）
  - 429レスポンス時のロックアウトメッセージ表示
  - 残り待機時間の表示

### HTTPS対応

- [ ] server.tsのHTTPS対応（`server.ts`）
  - `https.createServer()` による条件分岐サーバー作成
  - 証明書ファイル読み込み（fs.readFileSync）
  - 証明書パスのバリデーション（存在確認、読み取り権限確認、realpathSyncによるシンボリックリンク解決、ファイルサイズ上限チェック）
- [ ] CLIオプション追加（`src/cli/commands/start.ts`）
  - `--https` フラグ（認証なしHTTPS用）
  - `--cert <path>` 証明書ファイルパス
  - `--key <path>` 秘密鍵ファイルパス
  - `--allow-http` フラグ（`--auth`時のHTTP警告抑制）
  - `--auth`指定時に証明書未設定の場合の警告メッセージ（mkcertによる生成コマンド例を含む）
    ```
    WARNING: --auth is enabled without HTTPS. Token will be sent in plaintext.
    To enable HTTPS, generate certificates with mkcert:
      brew install mkcert && mkcert -install
      mkcert localhost 192.168.x.x
      commandmate start --auth --cert ./localhost+1.pem --key ./localhost+1-key.pem
    To suppress this warning: --allow-http
    ```
- [ ] 環境変数追加（`src/lib/env.ts`, `src/cli/utils/env-setup.ts`）
  - `CM_HTTPS_CERT` / `CM_HTTPS_KEY` 環境変数対応
  - 認証・HTTPS状態をサーバー内で共有する仕組み
  - Env interfaceにオプショナルフィールド追加: `CM_AUTH_TOKEN_HASH?`, `CM_AUTH_EXPIRE?`, `CM_HTTPS_CERT?`, `CM_HTTPS_KEY?`
  - 旧 `CM_AUTH_TOKEN` が `.env` に残っている場合の警告バリデーション

<!-- F002: DaemonManagerへのオプション伝達 -->
### デーモンモード対応

- [ ] DaemonManagerへの認証・HTTPSオプション伝達（`src/cli/utils/daemon.ts`）
  - `DaemonManager.start()` のenvに `CM_AUTH_TOKEN_HASH`, `CM_AUTH_EXPIRE`, `CM_HTTPS_CERT`, `CM_HTTPS_KEY`, `CM_ALLOW_HTTP` を追加
  - `DaemonManager.getStatus()` のURL生成をHTTPS対応に修正（`http://` -> `https://`）
  - `StartOptions` interface（`src/cli/types/index.ts`）に `auth`, `authExpire`, `cert`, `key`, `allowHttp` フィールドを追加

<!-- F009: セキュリティ警告メッセージ更新 -->
### セキュリティメッセージ更新

- [ ] security-messages.tsの更新（`src/cli/config/security-messages.ts`）
  - `--auth` 有効時の `REVERSE_PROXY_WARNING` メッセージを条件分岐で変更
  - 認証有効+HTTPS時: 適切な確認メッセージ
  - 認証有効+HTTP時: トークン平文流出リスクの警告

<!-- F010: i18n翻訳ファイル -->
### i18n対応

- [ ] 認証関連の翻訳ファイル追加
  - `locales/en/auth.json` 新規作成（ログイン画面タイトル、トークン入力プレースホルダー、エラーメッセージ、ロックアウトメッセージ等）
  - `locales/ja/auth.json` 新規作成
  - `src/i18n.ts` の名前空間マージ設定にauthを追加（必要に応じて）

<!-- F013: テスト計画 -->
### テスト計画

- [ ] auth.tsのユニットテスト（`tests/unit/auth.test.ts`）
  - トークン生成の一意性・長さ検証
  - トークン検証（正当トークン、不正トークン、期限切れトークン）
  - Cookieパースユーティリティのテスト
  - auth-expireフォーマットパースのテスト
- [ ] レート制限のユニットテスト（`tests/unit/rate-limiter.test.ts`）
  - 試行回数カウントの動作
  - ロックアウトの発動と解除
  - 成功時のカウントリセット
  - 古いエントリのクリーンアップ
- [ ] 認証ミドルウェアの統合テスト（`tests/integration/auth-middleware.test.ts`）
  - 未認証リクエストのリダイレクト
  - 認証済みリクエストの通過
  - 認証除外パスの動作
- [ ] WebSocket認証の統合テスト（`tests/integration/ws-auth.test.ts`）
  - 認証済みCookie付きWebSocket接続の成功
  - 未認証WebSocket接続の拒否
- [ ] CLIオプションパースのテスト（`tests/unit/cli-auth-options.test.ts`）
  - `--auth`, `--auth-expire`, `--cert`, `--key`, `--allow-http` のパース
  - 無効なauth-expireフォーマットのバリデーション
  - 証明書パスの存在確認バリデーション

### ドキュメント

- [ ] セキュリティガイド更新（`docs/security-guide.md`）
  - トークン認証+HTTPSの使用方法（クイックスタート形式）
  - 「Migration from CM_AUTH_TOKEN」セクションの更新（新しいビルトイン認証との違いの説明追加）
  - Security Checklistの更新（ビルトイン認証の選択肢追加）
  - **macOS環境でのmkcert手順**
    - `brew install mkcert && mkcert -install`
    - `mkcert localhost 192.168.x.x` でローカルIP含む証明書生成
    - 同一マシンのブラウザから即座に利用可能
  - **Linux（Ubuntuサーバー等）環境でのmkcert手順**
    - mkcertインストール方法（apt / go install / バイナリ直接配置）
    - `mkcert -install && mkcert localhost <サーバーIP>` で証明書生成
    - **CA証明書の配布手順**: サーバーで生成したCAを別デバイスのブラウザに信頼させる手順
      - `mkcert -CAROOT` でrootCA.pemの場所を確認
      - rootCA.pemをクライアント端末に転送（scp等）
      - PC: ブラウザ/OSの証明書ストアにインポート
      - スマホ: プロファイルインストール（iOS）/ 証明書インストール（Android）
    - CA配布が困難な場合はOpenSSL自己署名証明書（ブラウザ警告あり）を代替として案内
  - **OpenSSLによる自己署名証明書の手順**（mkcertが使えない環境向け）
    - `openssl req -x509 -newkey rsa:2048 ...` コマンド例
    - ブラウザ警告が出る旨の注意書き
  - **Let's Encrypt証明書の手順**（ドメインを持つ公開サーバー向け、参考情報）
  - 証明書ファイルの管理上の注意（.gitignoreへの追加、パーミッション600推奨）

## 受入条件

### 後方互換性
- [ ] `commandmate start` で認証なし・HTTPで起動でき、従来と同じ動作をすること

### トークン認証
- [ ] `commandmate start --auth` で認証有効のサーバーが起動し、トークンがターミナルに表示されること
- [ ] `--auth-expire 48h` で有効期限を指定でき、デフォルトは24時間であること
- [ ] `--auth-expire` に無効なフォーマットを指定した場合、エラーメッセージが表示され起動が中断されること
- [ ] 未認証時にログイン画面が表示されること
- [ ] 正しいトークンでログインでき、Cookieが設定されること
- [ ] 不正なトークンでログインが拒否されること
- [ ] 認証済みの場合、全APIルートにアクセスできること
- [ ] 認証済みの場合、WebSocket接続が成功すること
- [ ] 未認証の場合、APIルートが401を返すこと
- [ ] 未認証の場合、WebSocket接続が拒否されること
- [ ] サーバー停止でトークンが失効すること
- [ ] Cookieの有効期限がトークンの残り有効期限と一致すること（トークン残り12hならCookieも12hで失効）
- [ ] 旧CM_AUTH_TOKENが.envに残っている場合、起動時に警告メッセージが表示されること

### セキュリティ
- [ ] CookieにSameSite=Strict属性が設定されていること（CSRF対策）
- [ ] ログイン失敗を5回繰り返すと、そのIPからのログインが15分間ブロックされること（ブルートフォース対策）
- [ ] ブロック中にログインを試みると429ステータスが返却されること
- [ ] 認証成功後に失敗カウントがリセットされること
- [ ] ログイン画面にロックアウト状態が表示されること

### HTTPS
- [ ] `--auth` 指定時に `--cert`/`--key` がない場合、mkcertコマンド例を含む警告メッセージが表示されHTTPで起動すること
- [ ] `--auth --allow-http` 指定時に警告が抑制されること
- [ ] `--auth --cert ./cert.pem --key ./key.pem` でHTTPSサーバーとして起動すること
- [ ] `--https --cert ./cert.pem --key ./key.pem` で認証なしHTTPSサーバーとして起動すること
- [ ] HTTPS起動時にWebSocketがwss://で接続できること
- [ ] HTTPS起動時にCookieにSecure属性が付与されること
- [ ] 証明書ファイルが存在しない場合、エラーメッセージが表示されること

### デーモンモード
<!-- F002: デーモンモードの受入条件追加 -->
- [ ] `commandmate start --auth --daemon` でデーモンモード起動時に認証オプションが子プロセスに正しく伝達されること
- [ ] デーモンモードでHTTPS起動時に `commandmate status` がHTTPS URLで状態確認できること

### テスト
<!-- F013: テストの受入条件追加 -->
- [ ] auth.tsのトークン生成・検証のユニットテストが全てパスすること
- [ ] レート制限のユニットテストが全てパスすること
- [ ] 認証ミドルウェアの統合テストが全てパスすること
- [ ] WebSocket認証の統合テストが全てパスすること
- [ ] CLIオプションパースのテストが全てパスすること

### ドキュメント
- [ ] セキュリティガイドにmkcertによる証明書生成手順が記載されていること（macOS / Linux両方）
- [ ] セキュリティガイドにLinuxサーバー環境でのCA証明書配布手順が記載されていること
- [ ] セキュリティガイドにトークン認証+HTTPSのクイックスタート手順が記載されていること
- [ ] セキュリティガイドにmkcert以外の代替手段（OpenSSL、Let's Encrypt）が記載されていること
- [ ] セキュリティガイドの「Migration from CM_AUTH_TOKEN」セクションが更新されていること

## 影響範囲

### 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `server.ts` | HTTP/HTTPS条件分岐サーバー作成、証明書読み込み |
| `src/middleware.ts` | 新規作成: 認証ミドルウェア（HTTPリクエストのみ担当） |
| `src/lib/auth.ts` | 新規作成: トークン生成・検証・レート制限・Cookieパースユーティリティ |
| `src/app/api/auth/login/route.ts` | 新規作成: ログインAPI（Secure Cookie対応、レート制限） |
| `src/app/api/auth/logout/route.ts` | 新規作成: ログアウトAPI |
| `src/app/login/page.tsx` | 新規作成: ログイン画面（レート制限状態表示対応） |
| `src/cli/commands/start.ts` | `--auth`, `--auth-expire`, `--https`, `--cert`, `--key`, `--allow-http` オプション追加 |
| `src/cli/index.ts` | startコマンドのcommander option定義追加 |
| `src/cli/types/index.ts` | StartOptions型に認証・HTTPSオプション追加（auth, authExpire, cert, key, allowHttp） |
| `src/lib/ws-server.ts` | WebSocket接続時の認証チェック追加、`setupWebSocket()` 引数型を `http.Server \| https.Server` に拡張 |
| `src/lib/env.ts` | 認証・HTTPS関連のオプショナルフィールド追加（CM_AUTH_TOKEN_HASH, CM_AUTH_EXPIRE, CM_HTTPS_CERT, CM_HTTPS_KEY） |
| `src/cli/utils/env-setup.ts` | `CM_HTTPS_CERT`, `CM_HTTPS_KEY` 環境変数対応 |
| `src/cli/utils/daemon.ts` | DaemonManager.start()への認証・HTTPSオプション環境変数伝達、getStatus()のHTTPS URL対応 |
| `src/cli/config/security-messages.ts` | `--auth` 有効時のセキュリティ警告メッセージ条件分岐追加 |
| `locales/en/auth.json` | 新規作成: 認証関連の英語翻訳キー |
| `locales/ja/auth.json` | 新規作成: 認証関連の日本語翻訳キー |
| `docs/security-guide.md` | トークン認証+HTTPS使用方法、macOS/Linux別mkcert手順、CA配布手順、代替手段追記、Migration from CM_AUTH_TOKENセクション更新 |
| `.env.example` | 認証・HTTPS関連の設定例追記 |

### テストファイル（新規作成）

| ファイル | テスト内容 |
|---------|---------|
| `tests/unit/auth.test.ts` | トークン生成・検証・Cookieパース・auth-expireパース |
| `tests/unit/rate-limiter.test.ts` | レート制限ロジック |
| `tests/integration/auth-middleware.test.ts` | 認証ミドルウェアの統合テスト |
| `tests/integration/ws-auth.test.ts` | WebSocket認証の統合テスト |
| `tests/unit/cli-auth-options.test.ts` | CLIオプションパース |

### 関連コンポーネント

- CLIモジュール（起動フロー）
- server.ts（HTTP/HTTPSサーバー作成）
- Next.js ミドルウェア（HTTPリクエストフィルタ）
- WebSocketサーバー（接続認証、wss://対応 - middleware.tsとは独立）
- フロントエンド（ログイン画面、認証状態管理、ログアウトボタン）
- i18n（ログイン画面の多言語対応）
- DaemonManager（デーモンモードでの認証・HTTPSオプション伝達）

### 変更不要（既に対応済み）

- `src/hooks/useWebSocket.ts` - wss://自動検出済み
- `next.config.js` - CSPでws:/wss:両方許可済み

### 関連Issue

- Issue #179: 旧トークン認証削除（教訓: クライアント側環境変数にトークンを含めない。新環境変数名 `CM_AUTH_TOKEN_HASH` で旧 `CM_AUTH_TOKEN` との衝突を回避）

---

## フェーズ分割案（参考）

<!-- F019: Issue分割の検討 -->
本Issueは影響範囲が広いため、以下のフェーズ分割での段階的実装を推奨する。

| フェーズ | 内容 | 主要ファイル |
|---------|------|-------------|
| Phase 1 | 認証コア（auth.ts, middleware.ts, login API/UI, WebSocket認証） | auth.ts, middleware.ts, ws-server.ts, login/ |
| Phase 2 | HTTPS対応（server.ts, CLI cert/key options） | server.ts, start.ts, daemon.ts |
| Phase 3 | ブルートフォース対策・テスト・ドキュメント | rate-limiter, tests/, security-guide.md |

分割は任意であり、1つのPRで実装しても構わない。ただし、レビュー負荷軽減のためフェーズ分割を推奨する。

---

## レビュー履歴

### Stage 1: 通常レビュー (2026-02-21)

| ID | 重要度 | 対応 | 概要 |
|----|-------|------|------|
| F001 | must_fix | 反映済 | setupWebSocket()のHTTPS Server型互換性を設計方針・影響範囲に追記 |
| F002 | must_fix | 反映済 | DaemonManagerへの認証・HTTPSオプション伝達フローを設計方針・タスク・影響範囲に追記 |
| F003 | must_fix | 反映済 | middleware.tsとws-server.tsの認証責務境界を明確化 |
| F004 | must_fix | 反映済 | トークンのCLI-サーバー間データフローを認証フローセクションに詳細記載 |
| F005 | should_fix | 反映済 | CM_AUTH_TOKEN_HASH環境変数名で旧CM_AUTH_TOKENとの衝突回避、バリデーション追加 |
| F006 | should_fix | 反映済 | daemon.tsを変更対象ファイルに追加 |
| F007 | should_fix | 反映済 | src/cli/index.tsを変更対象ファイル・タスクに追加 |
| F008 | should_fix | 反映済 | WebSocket Cookieパースのセキュリティ方針を設計方針・タスクに追記 |
| F009 | should_fix | 反映済 | security-messages.tsの更新を変更対象・タスクに追加 |
| F010 | should_fix | 反映済 | i18n翻訳ファイル(locales/*/auth.json)を変更対象・タスクに追加 |
| F011 | should_fix | 反映済 | auth-expireのフォーマット仕様を設計方針・タスクに明記 |
| F012 | should_fix | 反映済 | 証明書パスのバリデーション方針を具体化 |
| F013 | should_fix | 反映済 | テスト計画セクションとテストファイル一覧を追加 |
| F014 | should_fix | 反映済 | Env interfaceへのフィールド追加方針を明記 |
| F015 | nice_to_have | 反映済 | ログアウトUXフロー（リダイレクト先、ボタン配置）を追記 |
| F016 | nice_to_have | スキップ | トークン再表示機能は便利だが、セキュリティリスク増加のため初回実装では見送り |
| F017 | nice_to_have | 反映済 | security-guide.mdのMigration from CM_AUTH_TOKENセクション更新をドキュメントタスクに追記 |
| F018 | nice_to_have | 反映済 | IPアドレス取得方針（req.socket.remoteAddress優先）を追記 |
| F019 | nice_to_have | 反映済 | フェーズ分割案を参考セクションとして追加 |
