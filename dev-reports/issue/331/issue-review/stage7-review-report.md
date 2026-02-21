# Issue #331 Stage 7 影響範囲レビュー（2回目）レポート

**レビュー日**: 2026-02-21
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: Stage 7 / 7

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 8 |
| Nice to Have | 2 |
| **合計** | **10** |

---

## 前回指摘（Stage 3: G001-G004 Must Fix）の対応確認

### G001: tsconfig.server.json に auth.ts のインクルードが必要 -- **対応済み**

tsconfig.server.json が変更対象ファイル一覧に追加されている。include 配列に `src/lib/auth.ts`（および auth.ts 内で使用する追加ユーティリティ）を追加する旨が明記されている。現在の tsconfig.server.json の include 配列を実コードで確認し、auth.ts が未含であることを確認した。

### G002: src/i18n.ts への auth 名前空間の追加が必要 -- **対応済み**

src/i18n.ts が変更対象ファイル一覧に追加されている。現在の i18n.ts は 5 名前空間（common, worktree, autoYes, error, prompt）を Promise.all でインポートしており、auth 名前空間の追加が**必須**であることが太字で強調されている。

### G003: status.ts の URL 表示が HTTPS に対応していない -- **対応済み**

`src/cli/commands/status.ts` が変更対象ファイル一覧に追加されている。HTTPS 判定方法として `CM_HTTPS_CERT` 環境変数の有無を使用する方針が設計方針に明記されている。daemon.ts の `getStatus()` で `http://` がハードコードされている問題（171行目）も認識・対応されている。

### G004: middleware.ts 新規作成による既存ルートへの影響リスク -- **対応済み**

middleware.ts の認証無効時の動作保証が Issue 内の**設計方針**、**実装タスク**、**受入条件**の 3 箇所に明記されている。`CM_AUTH_TOKEN_HASH` 未設定時は即座に `NextResponse.next()` を返す設計と、`config.matcher` で静的アセット（`/_next/static`, `/favicon.ico` 等）を除外する方針が記載されている。

---

## Stage 5/6 追加内容の影響確認

### H001-H006（Stage 5 Should Fix）の反映状況

Stage 6 の反映結果を確認した。7 件中 5 件が反映、2 件（H008: 証明書ホットリロード、H009: ログインAPIレスポンス形式）がスコープ外として妥当にスキップされている。

追加された主要な内容:
- **CLIオプション組み合わせルール**: `--auth` と `--https` の関係性がルールと具体例テーブルで明示化されている
- **/api/auth/status エンドポイント**: 独立した実装タスクとして追加、変更対象ファイルにも追加
- **Cookie格納値の設計**: トークン平文をCookieに格納し、リクエストごとにSHA-256ハッシュ計算して検証する方式が明記
- **auth-expire有効期限管理**: expireAt 計算方法、Cookie maxAge 計算ロジックが設計方針に追記

これらの追加内容は変更対象ファイル一覧にも適切に反映されている。

---

## Should Fix（推奨対応）

### I001: tsconfig.cli.json への auth.ts 関連のビルド影響が未考慮

**カテゴリ**: 影響範囲漏れ
**場所**: `tsconfig.cli.json` / 実装タスク > auth.ts

**問題**:
`start.ts` からトークン生成のために `src/lib/auth.ts` をインポートする設計だが、`tsconfig.cli.json` の include は `src/cli/**/*` のみ。`rootDir: './src'` の設定により cross-boundary import は動作する（Issue #264 C-CONS-002 の前例あり）が、auth.ts が Next.js 固有の依存を含むと CLI ビルドが失敗する制約が明記されていない。

**証拠**:
```json
// tsconfig.cli.json
{
  "include": ["src/cli/**/*"],
  "compilerOptions": { "rootDir": "./src" }
}
```

auth.ts は CLI からもインポートされるため、Node.js 標準モジュール（crypto, fs）のみに依存する必要がある。

**推奨対応**:
auth.ts の設計制約として「CLI ビルド（tsconfig.cli.json）からもインポートされるため、Next.js 固有のモジュール（next/headers, next/server 等）への依存を含めてはならない」ことを実装タスクに追記する。

---

### I002: .env.example への認証・HTTPS関連設定例の追記内容が未定義

**カテゴリ**: 影響範囲漏れ
**場所**: 変更対象ファイル > `.env.example`

**問題**:
変更対象ファイル一覧に `.env.example` が含まれているが、具体的な追記内容が未定義。認証は CLI オプション（`--auth`）で有効化する設計であり、`CM_AUTH_TOKEN_HASH` 等は CLI が自動設定する環境変数。`.env.example` に環境変数のテンプレートを含めるとユーザーが手動設定しようとして混乱する可能性がある。

**証拠**:
現在の `.env.example` のセキュリティセクション（22-26行目）:
```
# ===================================
# Security
# ===================================
# When CM_BIND=0.0.0.0, use a reverse proxy (e.g., Nginx) with authentication.
# See: docs/security-guide.md
```

**推奨対応**:
セキュリティセクションにコメントのみを追加する方針を明記する。環境変数テンプレートは含めず、CLI の `--auth` オプション使用を案内する。

---

### I003: server.ts の import 変更と ws-server.ts の型拡張の依存順序

**カテゴリ**: 依存関係
**場所**: `server.ts` / 実装タスク > HTTPS対応

**問題**:
HTTPS 対応で `http.createServer` と `https.createServer` を条件分岐する場合、server 変数の型が `http.Server | https.Server` になる。`setupWebSocket(server)` 呼び出しで型不一致が発生するため、ws-server.ts の型拡張が前提条件。この依存順序が実装タスクに明示されていない。

**証拠**:
```typescript
// 現在の server.ts 56行目
const server = createServer(async (req, res) => { ... });
// 現在の ws-server.ts 38行目
export function setupWebSocket(server: HTTPServer): void {
```

**推奨対応**:
ws-server.ts の型拡張が server.ts の HTTPS 対応の前提条件であることを実装タスクに明記する。

---

### I004: vitest.config.ts の test.environment と統合テストの互換性

**カテゴリ**: ビルド/テスト
**場所**: テスト計画セクション / `vitest.config.ts`

**問題**:
vitest.config.ts は `test.environment: 'node'` に設定されている。auth-middleware.test.ts で NextRequest/NextResponse をモックする際、Edge Runtime 用オブジェクトの node 環境での互換性に注意が必要。テスト計画にモック方法の具体的な記載がない。

**推奨対応**:
テスト計画に `vi.mock('next/server')` を使用する方針を明記する。

---

### I005: AppProviders への認証 Context 追加の可能性

**カテゴリ**: 影響範囲漏れ
**場所**: `src/components/providers/AppProviders.tsx` / `src/contexts/`

**問題**:
サイドバー（デスクトップ/モバイル）の複数コンポーネントが個別に `/api/auth/status` を呼び出すとリクエストが重複する。AuthContext を追加する場合、AppProviders.tsx と contexts ディレクトリが変更対象になるが、変更対象ファイル一覧に含まれていない。

**証拠**:
```typescript
// 現在の AppProviders.tsx
export function AppProviders({ children, locale, messages }: AppProvidersProps) {
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <SidebarProvider>
        <WorktreeSelectionProvider>
          {children}
        </WorktreeSelectionProvider>
      </SidebarProvider>
    </NextIntlClientProvider>
  );
}
```

**推奨対応**:
初回実装では各コンポーネントが `/api/auth/status` を個別に呼び出すシンプルな方式を採用し、必要に応じて AuthContext に移行する方針を明記する。または、useAuthStatus() カスタムフックを作成する場合は hooks ディレクトリを変更対象に追加する。

---

### I006: レート制限のメモリ管理タイマーと gracefulShutdown の影響

**カテゴリ**: セキュリティ
**場所**: 実装タスク > ブルートフォース対策 / `server.ts` の gracefulShutdown

**問題**:
レート制限の「古いエントリの自動クリーンアップ（メモリリーク防止）」のクリーンアップ戦略（タイミング、対象）が未定義。定期タイマーを使用する場合、server.ts の gracefulShutdown でクリアする必要がある。

**証拠**:
```typescript
// server.ts 140-170行目: gracefulShutdown
function gracefulShutdown(signal: string) {
  // ... 既存のクリーンアップ
  stopAllPolling();
  stopAllAutoYesPolling();
  closeWebSocket();
  // レート制限のクリーンアップタイマーは？
}
```

**推奨対応**:
レート制限のクリーンアップ戦略（setInterval + clearInterval）を設計方針に追記する。gracefulShutdown への影響も認識する。

---

### I007: StartOptions フィールドと環境変数のマッピング一覧性

**カテゴリ**: 後方互換性
**場所**: `src/cli/commands/start.ts` / `src/cli/utils/daemon.ts`

**問題**:
StartOptions の新フィールドと環境変数のマッピングが Issue 内の複数箇所に分散して記載されており、一覧性が低い。実装者が start.ts と daemon.ts を整合的に修正するためのガイダンスが不足。

**推奨対応**:
マッピング一覧表を追記する: auth -> CM_AUTH_TOKEN_HASH, authExpire -> CM_AUTH_EXPIRE, cert -> CM_HTTPS_CERT, key -> CM_HTTPS_KEY, allowHttp -> CM_ALLOW_HTTP。

---

### I008: middleware.ts の認証除外パスの完全リストが未記載

**カテゴリ**: 影響範囲漏れ
**場所**: 実装タスク > middleware.ts

**問題**:
「/api/auth/* と静的リソースは認証除外」と記載されているが、`/login` ページ自体の除外が明示されていない。未認証ユーザーが `/login` にアクセスした際にリダイレクトループが発生するリスクがある。

**推奨対応**:
除外パスの完全リストを明記する: `/login`, `/api/auth/*`, `/_next/static/*`, `/_next/image/*`, `/favicon.ico`。

---

## Nice to Have（あれば良い）

### I009: CLIオプションパーステストの内容範囲が不明確

**カテゴリ**: ビルド/テスト
**場所**: テスト計画 > `tests/unit/cli-auth-options.test.ts`

**問題**:
テスト内容の範囲（commander オプション定義テスト vs バリデーションロジックテスト）が不明確。

**推奨対応**:
テスト内容を具体化する。

---

### I010: .gitignore での証明書ファイルの既存カバー状況

**カテゴリ**: その他
**場所**: `.gitignore` / ドキュメントタスク > security-guide.md

**問題**:
.gitignore に `*.pem` が既に含まれている（25行目）。ドキュメントタスクの「.gitignore への追加」記載が冗長。

**推奨対応**:
.gitignore の `*.pem` 既存設定を確認済みであることを Issue に記載し、他の証明書フォーマットへの対応を推奨する。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/tsconfig.cli.json` | include: 'src/cli/**/*' のみ。auth.ts の CLI ビルド互換性制約（I001） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/.env.example` | 認証・HTTPS関連設定例の追記内容が未定義（I002） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/server.ts` | HTTPS対応、setupWebSocket の型依存、gracefulShutdown（I003, I006） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/lib/ws-server.ts` | 38行目: setupWebSocket の HTTPServer 型制限（I003） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/vitest.config.ts` | test.environment: 'node'。NextRequest/NextResponse モック互換性（I004） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/components/providers/AppProviders.tsx` | 認証状態 Context 追加の可能性（I005） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/cli/commands/start.ts` | daemonManager.start() 呼び出しのフィールド追加（I007） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/cli/types/index.ts` | StartOptions 型の拡張（I007） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/.gitignore` | *.pem が既に含まれている（I010） |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/docs/security-guide.md` | 証明書管理の .gitignore 既存設定情報（I010） |

---

## 総合評価

Issue #331 は 6 回のレビューステージを経て影響範囲の網羅性が大幅に向上している。Stage 3 の Must Fix 4 件（G001-G004）は全て適切に反映されている。Stage 5/6 で追加された `/api/auth/status` エンドポイント、CLI オプション組み合わせルール、Cookie 格納値の設計、auth-expire 有効期限管理も変更対象ファイルと実装タスクに正しく反映されている。

**今回の Stage 7 では Must Fix レベルの指摘はゼロ**であり、残る 8 件の Should Fix はいずれも実装段階で対応可能な詳細レベルの改善事項である。特に重要なのは I001（auth.ts の CLI ビルド互換性制約）と I008（middleware.ts の除外パス完全リスト）であり、これらは実装時のバグを未然に防ぐための注意点として有用である。

変更対象ファイル一覧（約 30 ファイル）は十分に網羅されており、テストファイル（5 ファイル）もカバレッジが適切。セキュリティ設計（SHA-256 ハッシュ比較、SameSite=Strict Cookie、レート制限）が他の既存システムに悪影響を及ぼす設計上のリスクは確認されなかった。

**結論**: Issue #331 は影響範囲の観点から実装着手に十分な品質に達している。
