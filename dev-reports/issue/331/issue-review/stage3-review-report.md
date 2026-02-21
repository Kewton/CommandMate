# Issue #331 影響範囲レビューレポート

**レビュー日**: 2026-02-21
**フォーカス**: 影響範囲レビュー
**ステージ**: Stage 3（影響範囲レビュー 1回目）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 4 |
| Should Fix | 10 |
| Nice to Have | 3 |
| **合計** | **17** |

---

## 総合評価

Issue #331 は Stage 1 通常レビューを経て大幅に改善されており、認証フロー、責務境界（middleware.ts vs ws-server.ts）、セキュリティ対策（CSRF、ブルートフォース）が詳細に記載されている。しかし、影響範囲の観点では以下の課題が残っている。

1. **変更対象ファイルの漏れ**: tsconfig.server.json、src/i18n.ts、サイドバーコンポーネント等が変更対象に含まれておらず、ビルドエラーや翻訳の欠落につながる
2. **後方互換性の核心**: middleware.ts の認証無効時の動作保証が設計として十分に明記されていない
3. **ビルド/CI への影響**: テスト戦略、依存パッケージの追加判断が未確定
4. **間接的な影響**: status コマンド、server.ts のURL表示等、Issue で明示されていない箇所への波及

---

## Must Fix（必須対応）

### G001: tsconfig.server.json に auth.ts のインクルードが必要

**カテゴリ**: 影響範囲漏れ
**場所**: `tsconfig.server.json` の include 配列

**問題**:
server.ts から auth.ts モジュールをインポートして使用する設計だが、`tsconfig.server.json` の include 配列に `src/lib/auth.ts` が記載されていない。`npm run build:server` でコンパイルエラーとなる。

**証拠**:
現在の tsconfig.server.json の include:
```json
{
  "include": [
    "server.ts",
    "src/lib/env.ts",
    "src/lib/ws-server.ts",
    ...
  ]
}
```
`src/lib/auth.ts` が含まれていない。

**推奨対応**:
- 変更対象ファイル一覧に `tsconfig.server.json` を追加
- include に `src/lib/auth.ts` を追加
- auth.ts 内で使用する追加ユーティリティ（rate-limiter 等を別モジュールにする場合）も同様に追加

---

### G002: src/i18n.ts への auth 名前空間の追加が必要

**カテゴリ**: 影響範囲漏れ
**場所**: `src/i18n.ts`（変更対象ファイル一覧に含まれていない）

**問題**:
Issue では `locales/en/auth.json` と `locales/ja/auth.json` の新規作成は記載されているが、`src/i18n.ts` の getRequestConfig 内で auth 名前空間を import・merge する変更が記載されていない。

**証拠**:
現在の `src/i18n.ts` では 5 名前空間のみを import:
```typescript
const [common, worktree, autoYes, error, prompt] = await Promise.all([
  import(`../locales/${locale}/common.json`),
  import(`../locales/${locale}/worktree.json`),
  import(`../locales/${locale}/autoYes.json`),
  import(`../locales/${locale}/error.json`),
  import(`../locales/${locale}/prompt.json`),
]);
```
auth 名前空間が追加されないと、ログイン画面で翻訳が利用できない。

**推奨対応**:
- 変更対象ファイル一覧に `src/i18n.ts` を追加
- i18n タスクの「必要に応じて」という曖昧な表現を「必須」に変更

---

### G003: status コマンドの HTTPS URL 表示対応が不十分

**カテゴリ**: 影響範囲漏れ
**場所**: `src/cli/commands/status.ts` と `src/cli/utils/daemon.ts` の getStatus()

**問題**:
Issue では daemon.ts の `getStatus()` を HTTPS 対応に修正すると記載しているが、HTTPS 状態を判定する具体的な方法が不明確。`DaemonManager.getStatus()` は現在 `process.env` から直接ポートを取得しているが、HTTPS 環境変数（`CM_HTTPS_CERT`/`CM_HTTPS_KEY`）は start 時に子プロセスに渡す環境変数であり、status コマンド実行時に利用可能かの検討が不足。

**証拠**:
daemon.ts の getStatus() のURL生成（行171）:
```typescript
const url = `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}`;
```
http:// がハードコードされている。

**推奨対応**:
- HTTPS 状態を判定する方法（環境変数の読み取り or ファイルベースの状態保存）を明記
- status.ts への間接的影響について、変更不要であることの確認を記載

---

### G004: middleware.ts の認証無効時の動作保証が未記載

**カテゴリ**: 後方互換性
**場所**: `src/middleware.ts`（新規作成）の認証無効時の動作仕様

**問題**:
Next.js の middleware.ts はプロジェクトに存在するだけで全リクエストに対して実行される。`--auth` なしで起動した場合（従来の使い方）に middleware.ts が存在しても一切の影響がないことを保証する設計が明記されていない。これは後方互換性の核心部分であり、誤って認証チェックが有効化されると全 API ルートがブロックされる重大障害となる。

**推奨対応**:
middleware.ts の設計方針に以下を明記:
- `CM_AUTH_TOKEN_HASH` 環境変数が未設定の場合は即座に `NextResponse.next()` を返す
- `config.matcher` で静的アセットや認証不要パスを除外する設定を定義
- テスト計画に「認証無効時に全 API ルートが正常動作すること」のテストケースを追加

---

## Should Fix（推奨対応）

### G005: サイドバーコンポーネントが変更対象ファイルに未記載

**カテゴリ**: 影響範囲漏れ
**場所**: `src/components/sidebar/` 配下および `src/components/mobile/` 配下

**問題**:
実装タスクに「サイドバー下部にログアウトリンクを配置」とあるが、変更対象ファイル一覧にサイドバーコンポーネントが含まれていない。また、クライアント側で認証状態を判定する仕組み（API エンドポイントまたは Context）も未記載。

**推奨対応**:
- ログアウトボタンを配置するサイドバーコンポーネントのファイルを特定し変更対象に追加
- 認証状態の判定方法（`/api/auth/status` エンドポイント or サーバーコンポーネントでの環境変数判定）を設計に追記

---

### G006: npm 依存パッケージの追加判断が未確定

**カテゴリ**: 依存関係
**場所**: `package.json`、auth-expire フォーマット仕様セクション

**問題**:
auth-expire パースに「ms ライブラリの利用、またはシンプルな正規表現パーサーを検討」と記載されているが、どちらを採用するか未決定。ms ライブラリを使う場合は package.json への依存追加が必要。

**推奨対応**:
- パース方法を確定し、外部ライブラリ使用の場合は package.json を変更対象に追加
- Node.js 標準の crypto / https モジュールのみで追加パッケージ不要である旨を確認・記載

---

### G007: CI/CD パイプラインへの影響（テスト戦略）

**カテゴリ**: ビルド/テスト
**場所**: テスト計画セクション全体

**問題**:
統合テスト（auth-middleware.test.ts, ws-auth.test.ts）が Next.js サーバーの実起動を必要とするか、モックベースで実施するかの方針が記載されていない。CI 環境での実行可能性が不明。

**推奨対応**:
- auth-middleware.test.ts は NextRequest/NextResponse のモックベースで実施
- ws-auth.test.ts は WebSocketServer のモックまたは httpServer + ws の組み合わせで実施
- テスト戦略を明記し、CI での実行に追加設定が不要であることを確認

---

### G008: server.ts / start.ts の URL 表示が HTTPS 未対応

**カテゴリ**: 影響範囲漏れ
**場所**: `server.ts` 行130、`src/cli/commands/start.ts` 行103

**問題**:
server.ts の起動メッセージ（`> Ready on http://...`）と start.ts の URL 表示が http:// 固定。HTTPS モードでは https:// に変更が必要。

**証拠**:
```typescript
// server.ts line 130
console.log(`> Ready on http://${hostname}:${port}`);

// start.ts line 103
const url = `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${actualPort}`;
```

**推奨対応**:
server.ts の変更内容に「起動時の URL 表示を HTTPS 対応に修正」を追加

---

### G009: 旧 CM_AUTH_TOKEN 検知バリデーションの実装箇所が不明確

**カテゴリ**: 後方互換性
**場所**: 設計方針セクション（F005）

**問題**:
旧 CM_AUTH_TOKEN の検知ロジックの実装先が未定義。start.ts、env.ts、auth.ts のいずれかで影響範囲が変わる。

**推奨対応**:
start.ts の起動処理の早い段階（.env ロード後、サーバー起動前）で実施する方針を明記

---

### G010: startCommand() 内のトークン生成フローの詳細が不足

**カテゴリ**: 影響範囲漏れ
**場所**: `src/cli/commands/start.ts` のトークン生成・環境変数設定フロー

**問題**:
StartOptions 型に auth 関連フィールドを追加する記載はあるが、startCommand() 内でのトークン生成 -> ハッシュ計算 -> ターミナル表示 -> 環境変数設定の処理フローが start.ts セクションの実装タスクに十分記載されていない。

**推奨対応**:
foreground モードと daemon モードそれぞれで、トークン生成からサーバー起動までの処理順序を実装タスクに追記

---

### G011: セッション固定攻撃対策が未記載

**カテゴリ**: セキュリティ
**場所**: 認証フロー・セキュリティ対策セクション

**問題**:
ログイン成功時の Cookie 設定にセッション固定攻撃（Session Fixation）への対策が記載されていない。SameSite=Strict でリスクは低減されるが、明示的な対策方針の記載が望ましい。

**推奨対応**:
本設計がステートレストークン認証であり原理的にセッション固定が発生しないことの説明、またはログイン成功時のセッション再生成の明記

---

### G012: ログイン画面のレイアウト・ルーティング構成が未定義

**カテゴリ**: 影響範囲漏れ
**場所**: `src/app/login/page.tsx` および `src/app/login/layout.tsx`

**問題**:
ログイン画面が既存の RootLayout（AppProviders、i18n）をそのまま使用するか独自の layout.tsx を持つかが未定義。認証済みユーザーがログイン画面にアクセスした場合のリダイレクト処理も未記載。

**推奨対応**:
- ログイン画面のレイアウト方針を明記
- 認証済みユーザーの /login アクセス時のリダイレクトを受け入れ条件に追加

---

### G013: next.config.js の CSP 変更不要の確認

**カテゴリ**: 影響範囲漏れ
**場所**: `next.config.js` の headers() セクション

**問題**:
Issue では next.config.js は変更不要としているが、ログイン画面のフォーム送信方式（fetch vs form action）によっては form-action ディレクティブの追加が必要になる可能性がある。

**推奨対応**:
CSP の変更が不要であることを明示的に確認・記載。ログイン画面は fetch API でのリクエストとし、form-action は不要であることを設計に含める。

---

### G014: CLAUDE.md へのモジュール追記が変更対象に未記載

**カテゴリ**: 影響範囲漏れ
**場所**: CLAUDE.md の主要機能モジュール一覧

**問題**:
auth.ts、middleware.ts 等の新規モジュール追加に伴い CLAUDE.md の更新が必要だが、変更対象に含まれていない。

**推奨対応**:
変更対象ファイル一覧に CLAUDE.md を追加、またはドキュメントタスクに含める

---

## Nice to Have（あれば良い）

### G015: Issue #332（IP 制限オプション）との関連性

**カテゴリ**: その他

Issue #332 は「アクセス元 IP の制限オプション」であり、#331 のレート制限（IP ベース）やミドルウェア構成と機能的に近い。IP 取得ユーティリティの共通化を意識した設計が望ましい。

**推奨対応**: 関連 Issue セクションに #332 への言及を追加

---

### G016: middleware.ts による全リクエストへのオーバーヘッド

**カテゴリ**: パフォーマンス

認証無効時でも middleware.ts が全リクエストで呼び出される。config.matcher で静的アセットを除外し、認証無効時は環境変数チェックのみで即座に return する設計を推奨。

---

### G017: フェーズ分割案の Phase 間依存関係が不明確

**カテゴリ**: その他

Phase 1（認証コア）で Cookie の Secure 属性条件分岐を含めるか、Phase 2（HTTPS）まで待つかが不明。各 Phase の変更対象ファイルを詳細化すべき。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/tsconfig.server.json` | auth.ts のインクルード追加が必要 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/i18n.ts` | auth 名前空間の追加が必要 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/server.ts` | HTTP/HTTPS 切替、URL表示の HTTPS 対応 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/lib/ws-server.ts` | setupWebSocket() の型拡張、WebSocket 認証 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/cli/commands/start.ts` | CLI オプション追加、トークン生成フロー |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/cli/commands/status.ts` | HTTPS URL 表示の間接的影響 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/cli/utils/daemon.ts` | 認証・HTTPS オプション伝達、getStatus() |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/cli/types/index.ts` | StartOptions 型への追加 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/lib/env.ts` | Env interface へのフィールド追加 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/hooks/useWebSocket.ts` | wss:// 自動検出は対応済み（Cookie 送信確認） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/next.config.js` | CSP 変更不要の確認 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/app/layout.tsx` | ログイン画面のレイアウト共有確認 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/package.json` | 依存パッケージ追加の可能性 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/cli/config/security-messages.ts` | セキュリティ警告メッセージの条件分岐 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/docs/security-guide.md` | トークン認証+HTTPS 手順の追記対象 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/CLAUDE.md` | 新規モジュール一覧の追記が必要 |
