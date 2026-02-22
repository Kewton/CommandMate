# Issue #331 Stage 1 レビューレポート

**レビュー日**: 2026-02-21
**フォーカス**: 通常レビュー（整合性・正確性・完全性）
**イテレーション**: 1回目
**Issue**: トークン認証によるログイン機能の追加

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 4 |
| Should Fix | 10 |
| Nice to Have | 5 |
| **合計** | **19** |

### 総合評価

Issue #331はCommandMateに軽量なビルトイン認証とHTTPS直接配信を追加する包括的な提案であり、動機・背景・CSRF/ブルートフォース対策の設計は全体として妥当である。仮説検証で全8項目がConfirmedとなっており、現在のコードベースの状態認識は正確。

しかし、以下の4つの必須修正事項を含む合計19件の指摘がある:
1. `setupWebSocket()`の型互換性問題
2. DaemonManagerへの認証/HTTPSオプション伝達フローの未設計
3. Next.js middleware.tsとWebSocket認証の境界の明確化
4. トークンのCLI-サーバー間共有メカニズムの未定義

これらを実装前に解決しないと設計の手戻りが発生するリスクがある。

---

## Must Fix（必須対応）

### F001: setupWebSocket()のHTTPSサーバー型互換性が未考慮

**カテゴリ**: 設計
**場所**: 影響範囲 > 変更対象ファイル

**問題**:
`ws-server.ts`の`setupWebSocket()`関数は`Server as HTTPServer`を`http`モジュールからimportしており、引数型が`HTTPServer`に限定されている。

```typescript
// src/lib/ws-server.ts:6
import { Server as HTTPServer } from 'http';

// src/lib/ws-server.ts:38
export function setupWebSocket(server: HTTPServer): void {
```

HTTPS対応で`https.createServer()`を使用した場合、返却されるのは`https.Server`インスタンスであり、型が異なる。Node.jsの実装上`https.Server`は`http.Server`を継承しているため実行時の問題は起きにくいが、TypeScriptの厳密な型チェックで問題が発生する可能性がある。

**推奨対応**:
変更対象ファイルに`ws-server.ts`の型修正を明記する。具体的には、引数型を`http.Server | https.Server`または共通の`net.Server`に変更する設計を記載する。

---

### F002: DaemonManager.start()へのauth/HTTPS関連オプション伝播が未設計

**カテゴリ**: 整合性
**場所**: 実装タスク > CLIオプション追加

**問題**:
現在の`DaemonManager.start()`は`StartOptions`を受け取り、`dev`/`port`/`dbPath`のみをenvに設定している。

```typescript
// src/cli/utils/daemon.ts:69-76
if (options.port) {
  env.CM_PORT = String(options.port);
}
if (options.dbPath) {
  env.CM_DB_PATH = options.dbPath;
}
```

`--auth`, `--cert`, `--key`, `--allow-http`, `--auth-expire`等のCLIオプションがデーモンモード起動時にどのように子プロセスに伝達されるかの設計がIssueに記載されていない。デーモンモードでは`spawn`で子プロセスを起動するため、環境変数経由で渡す仕組みが必須。

**推奨対応**:
`DaemonManager.start()`に認証・HTTPS関連オプションの環境変数伝達を明記する。例:
- `CM_AUTH_ENABLED=true`
- `CM_AUTH_TOKEN=<generated>`
- `CM_AUTH_EXPIRE=24h`
- `CM_HTTPS_CERT=<path>`
- `CM_HTTPS_KEY=<path>`

また、`src/cli/utils/daemon.ts`を変更対象ファイルに追加する。

---

### F003: Next.js middleware.tsとWebSocket認証の責務境界が不明確

**カテゴリ**: 設計
**場所**: 実装タスク > Next.js認証ミドルウェアの実装

**問題**:
`server.ts`はカスタムサーバーであり、Next.jsの`middleware.ts`は`next()`のリクエストハンドリングパイプライン内でのみ動作する。WebSocket upgrade requestはNext.jsのパイプラインを通らないため、`middleware.ts`では認証できない。Issueでは「WebSocket認証: connection時にCookieからトークン検証」と別途記載されているが、middleware.tsの認証範囲とws-server.tsの認証範囲の明確な境界が設計方針に書かれていない。

**推奨対応**:
設計方針に以下を追記する:
- `src/middleware.ts`: Next.jsのリクエストパイプライン内で動作。全ページ・APIルートの認証を担当。
- `src/lib/ws-server.ts`: WebSocket upgradeリクエストの認証を担当（middleware.tsとは独立）。
- 認証ロジック（トークン検証、Cookie解析）は`src/lib/auth.ts`に集約し、両者から呼び出す。

---

### F004: トークンのサーバー内共有メカニズムが未定義

**カテゴリ**: 完全性
**場所**: 設計方針 / 実装タスク > トークン生成ユーティリティの実装

**問題**:
Issueでは「サーバーのメモリ上にトークンを保持」と記載しているが、CLIプロセスがトークンを生成してserver.tsプロセスがそれを検証するまでのデータフローが未定義。

- フォアグラウンドモード: CLIから`npm run start`をspawnするため、トークンを環境変数経由で渡す
- デーモンモード: DaemonManagerが`spawn`するため同様

しかし、server.ts側でトークンをどこから読み込み、`auth.ts`のメモリにロードするかのフローが明記されていない。

**推奨対応**:
トークンのライフサイクルを明記する:
1. CLI: `crypto.randomBytes()`でトークン生成
2. CLI: 環境変数`CM_AUTH_TOKEN`としてspawnのenvに設定
3. server.ts: 起動時に`process.env.CM_AUTH_TOKEN`を読み込み
4. auth.ts: メモリ上でトークン+有効期限を保持、検証関数を提供

---

## Should Fix（推奨対応）

### F005: トークンの環境変数名がIssue #179の旧CM_AUTH_TOKENと衝突の可能性

**カテゴリ**: セキュリティ
**場所**: 設計方針 / 関連Issue > Issue #179

**問題**:
Issue #179で`CM_AUTH_TOKEN`/`NEXT_PUBLIC_CM_AUTH_TOKEN`を削除した経緯がある（`docs/security-guide.md:122-148`）。新しいトークン認証で同じ環境変数名を使用すると混乱や意図しない動作の原因になる可能性がある。

**推奨対応**:
新しい環境変数には明確に区別できる名前を使用する（例: `CM_SESSION_TOKEN`）か、旧設定との衝突防止バリデーションを含める。

---

### F006: daemon.tsが変更対象ファイルに含まれていない

**カテゴリ**: 完全性
**場所**: 影響範囲 > 変更対象ファイル

**問題**:
`DaemonManager.start()`（`src/cli/utils/daemon.ts:35-114`）は子プロセス起動時の環境変数設定を担当している。認証・HTTPSオプションの環境変数伝達にはdaemon.tsの修正が必須。また、`getStatus()`（155-182行目）のURL生成もhttp://からhttps://への対応が必要。

**推奨対応**:
変更対象ファイルに`src/cli/utils/daemon.ts`を追加する。

---

### F007: CLI index.tsが変更対象ファイルに含まれていない

**カテゴリ**: 完全性
**場所**: 影響範囲 > 変更対象ファイル

**問題**:
`src/cli/index.ts`のstartコマンド定義（38-56行目）に新オプションを追加するcommander設定が必要だが、変更対象に含まれていない。

**推奨対応**:
変更対象ファイルに`src/cli/index.ts`を追加する。

---

### F008: WebSocket Cookie手動パースのセキュリティ考慮事項が未記載

**カテゴリ**: セキュリティ
**場所**: 実装タスク > WebSocket認証チェック追加

**問題**:
`ws`パッケージはHTTPのCookieヘッダーを自動パースしない。`IncomingMessage`からのCookieパース方法、使用ライブラリ、パースエラー時の処理が未定義。

**推奨対応**:
Cookieパース用のユーティリティ関数を`auth.ts`に追加し、使用ライブラリ（例: `cookie` npmパッケージ）の選択を明記する。

---

### F009: security-messages.tsのREVERSE_PROXY_WARNINGとの整合性

**カテゴリ**: 整合性
**場所**: 設計方針

**問題**:
現在`CM_BIND=0.0.0.0`時にREVERSE_PROXY_WARNINGが表示される（`start.ts:168-169`, `daemon.ts:82-83`）。`--auth`導入後、認証有効時にもこの「リバースプロキシ推奨」メッセージがそのまま表示されるのは不適切。

```typescript
// src/cli/config/security-messages.ts
export const REVERSE_PROXY_WARNING = `
WARNING: Server is exposed to external networks without authentication
...
Recommended authentication methods:
  - Nginx + Basic Auth
  - Cloudflare Access
  - Tailscale
`;
```

**推奨対応**:
`security-messages.ts`を変更対象に追加し、`--auth`有効時のメッセージを分岐する。

---

### F010: i18n名前空間ファイルの追加が未記載

**カテゴリ**: 完全性
**場所**: 影響範囲 > 変更対象ファイル

**問題**:
ログイン画面のi18n対応が実装タスクに含まれているが、`locales/en/auth.json`, `locales/ja/auth.json`の追加が変更対象に記載されていない。

**推奨対応**:
変更対象ファイルに翻訳ファイルを追加する。

---

### F011: auth-expire期間のパース仕様が未定義

**カテゴリ**: 正確性
**場所**: 実装タスク > CLIオプション追加 > --auth-expire

**問題**:
`--auth-expire <duration>`の文字列フォーマット仕様（対応する単位、最小/最大値、バリデーション）が定義されていない。

**推奨対応**:
フォーマット仕様を定義する。例: `Nh`（N時間）、`Nd`（N日）をサポート。最小1h、最大30dなどの制約を設ける。

---

### F012: 証明書パスのパストラバーサル防止策の具体的方法が未定義

**カテゴリ**: 設計
**場所**: 実装タスク > server.tsのHTTPS対応

**問題**:
「パストラバーサル防止」と記載されているが、証明書ファイルはプロジェクトディレクトリ外に配置されることが一般的であり、既存の`resolveSecurePath()`のallowedBaseDirベースの検証は適さない。

**推奨対応**:
証明書パスのバリデーション方針を明確化する:
1. ファイル存在確認
2. 読み取り権限確認
3. シンボリックリンク解決（`realpathSync`）
4. ファイルサイズ上限チェック

---

### F013: テスト計画が含まれていない

**カテゴリ**: 完全性
**場所**: 実装タスク

**問題**:
トークン認証、レート制限、HTTPS切替、WebSocket認証等の機能についてのテスト計画が欠如している。

**推奨対応**:
テスト計画セクションを追加し、以下のテストを含める:
- `auth.ts`のトークン生成・検証のユニットテスト
- レート制限ロジックのユニットテスト
- 認証ミドルウェアの統合テスト
- WebSocket認証の統合テスト
- CLIオプションパースのテスト

---

### F014: Env interfaceへのHTTPS関連フィールド追加の設計が不明確

**カテゴリ**: 整合性
**場所**: 実装タスク > 環境変数追加

**問題**:
`env.ts`のEnv interface（172-184行目）にどのフィールドを追加するかが不明確。認証・HTTPSフィールドはオプショナルであるべきだが、既存フィールドは全て必須。

**推奨対応**:
追加するフィールドを明確にする。別interfaceとしてAuthConfig/HttpsConfigを定義するか、Envにオプショナルフィールドを追加するかの判断を記載する。

---

## Nice to Have（あれば良い）

### F015: ログアウト機能のUXフローが未記載

**カテゴリ**: 完全性

ログアウトボタンの配置場所（サイドバー下部、ヘッダー等）とログアウト後のフロー（ログインページリダイレクト）を記載すると実装がスムーズになる。

---

### F016: トークンの再表示・コピー機能が未考慮

**カテゴリ**: 完全性

ターミナルのスクロールバックで見失った場合の再表示手段がない。`commandmate status --show-token`のようなオプションを検討する。

---

### F017: セキュリティガイドの既存構造との整合性

**カテゴリ**: 整合性

`docs/security-guide.md`の「Migration from CM_AUTH_TOKEN」セクションの更新、Security Checklistへのビルトイン認証の選択肢追加を含めると良い。

---

### F018: レート制限のIPアドレス取得方法が未考慮

**カテゴリ**: 設計

リバースプロキシ経由のアクセスでは`req.socket.remoteAddress`がプロキシのIPになる。ビルトイン認証の主用途はリバースプロキシなし利用であるため、初回は`remoteAddress`優先で良いが、将来の拡張を考慮して設計指針を記載すると良い。

---

### F019: Issueのサイズが大きく分割の検討余地がある

**カテゴリ**: 完全性

新規ファイル6件、変更ファイル7件以上の大規模変更。Phase分割（Phase 1: 認証コア、Phase 2: HTTPS、Phase 3: UI/UX改善）を検討するとレビューとテストの負荷が下がる。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `server.ts` | HTTPS対応の主要変更対象。現在はhttp.createServerのみ使用（29行目） |
| `src/lib/ws-server.ts` | WebSocket認証追加対象。setupWebSocket()の引数型がHTTPServer限定（6, 38行目） |
| `src/cli/utils/daemon.ts` | DaemonManager.start()のenv伝達（59-76行目）。**変更対象として漏れている** |
| `src/cli/index.ts` | startコマンドのcommander option定義（38-56行目）。**変更対象として漏れている** |
| `src/cli/types/index.ts` | StartOptions interface（33-46行目）。auth/cert/key等のフィールド追加が必要 |
| `src/lib/env.ts` | Env interface（172-184行目）、ENV_MAPPING（24-33行目）。認証状態管理の追加先 |
| `src/cli/config/security-messages.ts` | REVERSE_PROXY_WARNING定数。--auth有効時のメッセージ変更が必要 |
| `src/hooks/useWebSocket.ts` | wss://自動検出済み（107行目）。変更不要であることを確認 |
| `next.config.js` | CSPでws:/wss:両方許可済み（65行目）。変更不要であることを確認 |
| `.env.example` | 環境変数設定例。認証・HTTPS関連変数の追加先 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクトガイドライン。新規モジュール追加時に更新が必要 |
| `docs/security-guide.md` | セキュリティガイド。トークン認証+HTTPS手順の追加先、Migration from CM_AUTH_TOKENセクションの更新が必要 |

---

*レビュー実施: Stage 1 通常レビュー（1回目）*
