# 設計方針書: Issue #11 バグ原因調査目的のデータ収集機能強化

## 1. アーキテクチャ設計

### システム構成図

```mermaid
graph TD
    subgraph Client["クライアント（ブラウザ）"]
        LV[LogViewer.tsx<br>'use client']
        CB[clipboard-utils.ts<br>copyToClipboard]
    end

    subgraph Server["サーバー（Next.js API）"]
        LogAPI["/api/worktrees/[id]/logs/[filename]<br>route.ts"]
        LES[log-export-sanitizer.ts<br>パス・環境情報・機密データマスキング]
        AL[api-logger.ts<br>withLogging ヘルパー]
        ENV[env.ts<br>getEnv]
        LC[log-config.ts<br>LOG_DIR一元管理]
        FS[(ファイルシステム<br>data/logs/*.md)]
    end

    subgraph ExistingNoChange["既存モジュール（変更なし）"]
        Logger[logger.ts<br>createLogger]
        Sanitize[sanitize.ts<br>DOMPurify XSS防止]
        LM[log-manager.ts<br>会話ログCRUD]
        ClipUtil[clipboard-utils.ts]
    end

    LV -->|"GET ?sanitize=true"| LogAPI
    LogAPI -->|"fs.readFile()"| FS
    LogAPI -->|"サニタイズ実行"| LES
    LES -->|"CM_ROOT_DIR, CM_DB_PATH"| ENV
    LES -->|"process.env.HOME"| ENV
    LogAPI -->|"サニタイズ済みテキスト"| LV
    LV -->|"コピー"| CB
    LogAPI -->|"LOG_DIR取得"| LC
    LM -->|"LOG_DIR取得"| LC

    AL -->|"createLogger()"| Logger
    AL -.->|"各route.tsをラップ"| LogAPI
```

### レイヤー構成

| レイヤー | 責務 | 該当ファイル |
|---------|------|------------|
| **プレゼンテーション層** | UI表示、ユーザー操作 | `src/components/worktree/LogViewer.tsx` |
| **API層** | HTTPリクエスト処理、レスポンス整形 | `src/app/api/worktrees/[id]/logs/[filename]/route.ts` |
| **ビジネスロジック層** | サニタイズ、ログ整形 | `src/lib/log-export-sanitizer.ts`（新規）、`src/lib/api-logger.ts`（新規） |
| **共通設定層** | ログディレクトリ等の設定一元管理 | `src/config/log-config.ts`（新規） |
| **インフラストラクチャ層** | ファイルI/O、環境変数 | `src/lib/env.ts`、`fs/promises` |

### 新規モジュール配置

```
src/lib/
├── log-export-sanitizer.ts  <- 新規: エクスポート用パス・機密データサニタイズ
├── api-logger.ts            <- 新規: withLogging()ヘルパー
├── logger.ts                <- 既存: 変更なし
├── log-manager.ts           <- 既存: LOG_DIR定義を共通設定に移行
├── sanitize.ts              <- 既存: 変更なし（DOMPurify XSS防止）
├── clipboard-utils.ts       <- 既存: 変更なし
├── utils.ts                 <- 既存: escapeRegExp()が既に存在（再利用する）
└── env.ts                   <- 既存: 変更なし

src/config/
├── log-config.ts            <- 新規: LOG_DIR定数の一元管理（SF-004対応）
└── ...
```

> **[S2-MF-001対応] escapeRegExp()について**: `src/lib/utils.ts` には既に `escapeRegExp()` が同一ロジックで実装済みである。新規関数 `escapeRegex()` の追加は不要であり、`log-export-sanitizer.ts` から既存の `escapeRegExp()` をインポートして使用する。ただし、現在のJSDocコメントには "CLIENT-SIDE highlight rendering only" と記載されているため、サーバーサイドでの利用も想定している旨にコメントを更新する必要がある。

---

## 2. 技術選定

| カテゴリ | 選定技術 | 選定理由 |
|---------|---------|---------|
| サニタイズ | 正規表現ベースの文字列置換 | 外部依存なし、パスパターンマッチに最適。既存のlogger.tsのSENSITIVE_PATTERNSと同様のアプローチ |
| クリップボード | 既存`copyToClipboard()` | Clipboard API使用、ANSI除去済み、追加実装不要 |
| APIロギング | `createLogger()`ラッパー | 既存ログシステムを活用、logger.tsへの変更不要 |
| テスト | Vitest | 既存テストフレームワーク、モック機能が充実 |
| 正規表現エスケープ | 既存 `escapeRegExp()` in `src/lib/utils.ts` | 既に同一実装が存在するため再利用（S2-MF-001対応。旧SF-005の新規追加方針を撤回） |
| HTMLエスケープ | シンプルなエスケープユーティリティ関数 | dangerouslySetInnerHTMLへの挿入前にHTML特殊文字をエスケープ（S4-MF-001対応） |

### 代替案との比較

| 設計判断 | 採用案 | 代替案 | 不採用理由 |
|---------|-------|--------|-----------|
| サニタイズ実行場所 | **(A) サーバーサイドAPI** | クライアントサイド | getEnv()がサーバー専用、機密値のクライアント送信はセキュリティリスク |
| サニタイズAPI方式 | **(A) 既存APIにクエリパラメータ追加** | 新規エクスポートAPI | エンドポイント増加回避、api-client.tsの変更が最小限 |
| APIロギング方式 | **(A) withLogging()ヘルパー** | middleware.ts | Edge Runtimeの制約でレスポンスボディ読み取りが困難 |
| APIロギング方式 | **(A) withLogging()ヘルパー** | 各route.tsに直接実装 | 37ファイル48ハンドラーへの個別実装は保守性が低い |
| ログ永続化 | **スコープ外** | ファイル出力追加 | 会話ログ（Markdown）は既に永続化済み、構造化ログの永続化は別Issue |
| LOG_DIR管理 | **(A) 共通設定モジュール一元化** | 各ファイルで重複定義 | DRY原則違反回避、将来のパス変更時の整合性確保（SF-004対応） |
| highlightedContentのXSS対策 | **(A) HTMLエスケープ関数適用** | DOMPurify適用 | DOMPurifyはHTMLタグの完全除去用であり、`<mark>`タグ構築時のインラインエスケープには軽量なエスケープ関数が適切（S4-MF-001対応） |

---

## 3. 設計パターン

### 3-1. Decorator パターン -- withLogging()

APIハンドラーの前後にロギング処理を注入する。ハンドラー自体の変更は不要。

**[MF-001対応] ジェネリクスによる型安全なApiHandler定義**:

既存のroute.tsハンドラーは `{ params: { id: string } }` や `{ params: { id: string; filename: string } }` のように具体的なparams型を使用している。`Record<string, string>` では型安全性が失われるため、ジェネリクスで定義する。

**[S2-MF-002対応] params型のPromise/非Promise混在への対応方針**:

現在のコードベースでは、params型に2つのスタイルが混在している:
- **非Promise版**（多数派）: `worktrees/[id]` 配下の大半のハンドラーが `{ params: { id: string } }` を使用
- **Promise版**（一部）: `external-apps`, `interrupt`, `slash-commands` 等の新しいハンドラーが `{ params: Promise<{ id: string }> }` を使用

ApiHandler型は `P | Promise<P>` の union型で両方をカバーするが、**withLogging()内部ではparamsに直接アクセスしない方針**とする。ログにはリクエストURLのpathname（`request.nextUrl.pathname`）を使用することで、paramsの型解決を回避する。将来的にwithLogging()内部でparamsの値が必要になった場合は、`const resolvedParams = await Promise.resolve(context.params)` のパターンで統一的に解決する。

```typescript
// src/lib/api-logger.ts

type ApiHandler<P extends Record<string, string> = Record<string, string>> = (
  request: NextRequest,
  context: { params: P | Promise<P> }
) => Promise<NextResponse>;

interface WithLoggingOptions {
  logLevel?: 'debug' | 'info';   // デフォルト: 'info'
  maxResponseBodyLength?: number; // デフォルト: 1024 (1KB)
  skipResponseBody?: boolean;     // デフォルト: false（S4-SF-001対応: ファイルコンテンツを返すAPIではtrueを指定）
}

export function withLogging<P extends Record<string, string> = Record<string, string>>(
  handler: ApiHandler<P>,
  options?: WithLoggingOptions
): ApiHandler<P> {
  return async (request, context) => {
    if (process.env.NODE_ENV !== 'development') {
      return handler(request, context);
    }
    const logger = createLogger('api');
    const startTime = Date.now();
    // リクエストログではrequest.nextUrl.pathnameを使用（paramsには直接アクセスしない）
    // ... リクエストログ -> ハンドラー実行 -> レスポンスログ
    // S4-SF-001: skipResponseBody=trueの場合はレスポンスボディのログ出力を省略
  };
}
```

**設計根拠 (MF-001)**:
- ジェネリクス `P` により、各route.tsの具体的なparams型（`{ id: string }`, `{ id: string; filename: string }` など）をそのまま利用可能
- `P | Promise<P>` でNext.js App Routerの将来的なasync params仕様変更にも対応
- デフォルト型パラメータ `= Record<string, string>` により、型パラメータ省略時も後方互換性を維持

**設計根拠 (S2-MF-002)**:
- withLogging()の責務はリクエスト/レスポンスのログ出力であり、paramsの値を利用したビジネスロジックは含まない
- URLのpathnameからパスパラメータの値は十分に読み取れるため、params解決のオーバーヘッドを避ける
- paramsの型解決が不要なことで、Promise/非Promiseの混在による型の複雑さを回避できる

**設計根拠 (S4-SF-001)**:
- ログファイル取得APIのようにファイルコンテンツ全体を返すハンドラーでは、レスポンスボディに会話ログの全文が含まれ、その中にトークンやパスワード等の機密データが存在する可能性がある
- `response.clone().text()` で取得した文字列をログに渡した場合、`createLogger()` 経由のSENSITIVE_PATTERNSがJSONエンコード済みの改行を含む文字列（例：SSH鍵）に対して完全にはマッチしないケースがある
- `skipResponseBody: true` オプションにより、ファイルコンテンツを返すAPIではレスポンスボディのログ出力自体を省略し、機密データ漏洩リスクを排除する

**適用例**:
```typescript
// src/app/api/worktrees/route.ts
export const GET = withLogging(async (request, context) => {
  // 既存のハンドラーロジック
}, { logLevel: 'debug' }); // ポーリングAPIはdebugレベル

// src/app/api/worktrees/[id]/logs/[filename]/route.ts
// 型パラメータを明示的に指定、ファイルコンテンツを返すためskipResponseBody=true
export const GET = withLogging<{ id: string; filename: string }>(async (request, context) => {
  const params = await context.params; // Promise対応
  // 既存のハンドラーロジック
}, { skipResponseBody: true }); // S4-SF-001: レスポンスボディのログ出力を省略
```

### 3-2. ルールベースパターン -- サニタイズルール

> **[SF-002対応]**: 旧称「Strategyパターン」から改名。実態はSanitizeRule配列を順次適用するルールベース処理であり、アルゴリズムの切り替えを伴うStrategyパターンとは異なる。Strategyパターンはコンテキストに応じて異なるサニタイズ戦略を選択する場合（例：エクスポート先に応じた異なるマスキングレベル）に適用される。

サニタイズ対象を個別のルールとして定義し、拡張可能にする。

**[S4-MF-002対応] 機密データパターンの追加**:

パスとホスト名に加えて、会話ログ内に含まれる可能性のある機密データ（トークン、パスワード、SSH鍵等）もマスキング対象とする。既存の `logger.ts` の `SENSITIVE_PATTERNS` と同等のルールをエクスポート用サニタイズにも適用する。`logger.ts` の SENSITIVE_PATTERNS はログ出力時の即時マスキング用であるが、既にファイルに書き込まれた会話ログには適用されないため、`log-export-sanitizer.ts` 側でも同等のパターンを定義する必要がある。

```typescript
// src/lib/log-export-sanitizer.ts
import { escapeRegExp } from '@/lib/utils'; // S2-MF-001: 既存関数を再利用

interface SanitizeRule {
  pattern: RegExp;
  replacement: string;
  description: string;
}

function buildSanitizeRules(): SanitizeRule[] {
  const home = process.env.HOME ?? '';
  const env = getEnv();
  const hostname = os.hostname(); // S2-C-003: ホスト名取得

  const rules: SanitizeRule[] = [];

  // === パス・環境情報ルール ===

  // HOME パス置換（最長一致を先に）
  if (home) {
    rules.push({
      pattern: new RegExp(escapeRegExp(home), 'g'),
      replacement: '[HOME]',
      description: 'ホームディレクトリパスのマスキング'
    });
  }

  // CM_ROOT_DIR パス置換
  if (env.CM_ROOT_DIR) {
    rules.push({
      pattern: new RegExp(escapeRegExp(env.CM_ROOT_DIR), 'g'),
      replacement: '[PROJECT]',
      description: 'プロジェクトルートパスのマスキング'
    });
  }

  // CM_DB_PATH パス置換
  if (env.CM_DB_PATH) {
    rules.push({
      pattern: new RegExp(escapeRegExp(env.CM_DB_PATH), 'g'),
      replacement: '[DB_PATH]',
      description: 'データベースパスのマスキング'
    });
  }

  // ホスト名置換（S2-C-003対応: os.hostname()で取得）
  if (hostname) {
    rules.push({
      pattern: new RegExp(escapeRegExp(hostname), 'g'),
      replacement: '[HOST]',
      description: 'ホスト名のマスキング'
    });
  }

  // === 機密データパターン（S4-MF-002対応: logger.ts SENSITIVE_PATTERNSと同等） ===

  // Bearer トークン
  rules.push({
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    replacement: 'Bearer [REDACTED]',
    description: 'Bearer トークンのマスキング'
  });

  // Authorization ヘッダー値
  rules.push({
    pattern: /[Aa]uthorization:\s*\S+/g,
    replacement: 'Authorization: [REDACTED]',
    description: 'Authorization ヘッダーのマスキング'
  });

  // パスワード・トークン・シークレットのキーバリューペア
  rules.push({
    pattern: /(password|passwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)[=:]\s*\S+/gi,
    replacement: '$1=[REDACTED]',
    description: 'パスワード・トークン・シークレットのキーバリューペアのマスキング'
  });

  // SSH秘密鍵
  rules.push({
    pattern: /-----BEGIN\s+(RSA|DSA|EC|OPENSSH)?\s*PRIVATE KEY-----[\s\S]*?-----END\s+(RSA|DSA|EC|OPENSSH)?\s*PRIVATE KEY-----/g,
    replacement: '[SSH_PRIVATE_KEY_REDACTED]',
    description: 'SSH秘密鍵のマスキング'
  });

  // 環境変数形式の機密値（GITHUB_TOKEN=xxx, AWS_SECRET_ACCESS_KEY=xxx 等）
  rules.push({
    pattern: /(GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|OPENAI_API_KEY|ANTHROPIC_API_KEY|DATABASE_URL|REDIS_URL)[=:]\s*\S+/g,
    replacement: '$1=[REDACTED]',
    description: '既知の環境変数名に対応する機密値のマスキング'
  });

  // パスルールのみをパターン長の降順でソート（最長一致優先）
  // 注: 機密データパターンは固定正規表現のため、パス置換ルールのソートのみ必要
  const pathRules = rules.filter(r => ['[HOME]', '[PROJECT]', '[DB_PATH]', '[HOST]'].includes(r.replacement));
  const sensitiveRules = rules.filter(r => !['[HOME]', '[PROJECT]', '[DB_PATH]', '[HOST]'].includes(r.replacement));
  pathRules.sort((a, b) => b.pattern.source.length - a.pattern.source.length);

  return [...pathRules, ...sensitiveRules];
}
```

> **[S4-MF-002対応] SENSITIVE_PATTERNSとの関係**: `logger.ts` の SENSITIVE_PATTERNS はログ出力時（`createLogger()` 経由）の即時マスキングに使用されるが、会話ログファイル（`.md`）は `log-manager.ts` が直接書き込むため、SENSITIVE_PATTERNS は適用されない。エクスポート用サニタイズでは、ファイルに既に書き込まれた内容に対して機密データパターンを適用する必要がある。将来的に SENSITIVE_PATTERNS を共通モジュールに抽出してインポートする方式への移行を検討するが、初期実装では `log-export-sanitizer.ts` 側で同等のパターンを定義する。

> **[S2-MF-001対応] escapeRegExp()の利用について**: `src/lib/utils.ts` に既存の `escapeRegExp()` 関数が存在する。当初の設計では `escapeRegex()` を新規追加する方針（旧SF-005）であったが、同一ロジックの重複を避けるため既存関数を再利用する。なお、現在の `escapeRegExp()` のJSDocコメントには "CLIENT-SIDE highlight rendering only" と記載されているため、実装時にJSDocコメントを更新する。
>
> **[S3-SF-003対応] JSDocコメント更新時のセキュリティ注記保持**: 現在の `escapeRegExp()` のJSDocには "Server-side search MUST NOT use RegExp (ReDoS prevention - SEC-MF-001)" という重要なセキュリティ注記が含まれている。この注記はescapeRegExp()関数自体の制限ではなく、サーバーサイド検索でのユーザー入力に対するRegExp利用全般に対するガイドラインである。コメント更新時にこの注記を**必ず保持**し、以下のような記述とする:
> ```
> Used by both client-side (highlight rendering) and server-side (path sanitization).
> NOTE: Server-side search should still use indexOf/includes for user input matching (SEC-MF-001).
> NOTE: Building RegExp from trusted sources (e.g., environment variables via escapeRegExp) is safe
>       as ReDoS risk applies only to untrusted user input (S4-C-004).
> ```

> **[S2-SF-004対応] LogViewer.tsxの既知の技術的負債**: `LogViewer.tsx` (line 93) にはインラインの正規表現エスケープ処理が存在し、`escapeRegExp()` と全く同一のロジックである（`FileTreeView.tsx` は既に `escapeRegExp()` を使用している）。これは「将来課題」ではなく、**既知の技術的負債**として認識する。T5（LogViewer.tsx修正）の実施時に、インラインの正規表現エスケープを `escapeRegExp()` のインポートに置き換えることをチェックリストに含める。

> **[S4-SF-004対応] ホスト名マスキングの対象範囲**: `os.hostname()` で取得される値のみをマスキング対象とする。macOSでは `'MacBook-Pro.local'` 形式、Linuxでは短縮ホスト名やFQDNが異なる場合があるが、`os.hostname()` の返却値のみを対象とする。IPアドレス（ローカルIPやVPN IP: `192.168.x.x`、`10.x.x.x` 等）のマスキングは初期スコープ外とし、必要に応じて追加Issueで対応する。

### 3-3. APIクライアント拡張 -- エクスポートオプション

> **[C-002対応]**: 旧称「Facadeパターン」から改名。api-client.tsは単一のAPIラッパーであり、複数サブシステムの統一インターフェースを提供するFacadeパターンの本質とは異なる。ここではオプション引数によるAPI拡張として記述する。

既存のログ取得APIにサニタイズオプションを追加し、クライアントからの呼び出しをシンプルに保つ。

```typescript
// api-client.ts
getLogFile(id: string, filename: string, options?: { sanitize?: boolean }): Promise<LogFileResponse>
```

**[SF-001対応] ハンドラー内のSRP維持方針**:

`?sanitize=true` クエリパラメータの追加により1つのハンドラーが2つの責務（通常取得/サニタイズ取得）を持つことになるが、以下の設計指針でSRP違反を最小限に抑える:

1. **条件分岐は1行に限定**: ハンドラー内のサニタイズ呼び出しは `if (sanitize) content = sanitizeForExport(content);` の1行のみとする
2. **サニタイズロジックの完全分離**: 全てのサニタイズロジックは `log-export-sanitizer.ts` に閉じ込め、route.tsには一切のサニタイズ実装を置かない
3. **ハンドラー構造の明確化**: route.tsのGETハンドラーは「ファイル読み取り -> (オプション: サニタイズ) -> レスポンス構築」の直線的なフローを維持する

### 3-4. LogViewer.tsx highlightedContent構築時のXSS防止 (S4-MF-001対応)

**問題**: `LogViewer.tsx` (line 350) は `highlightedContent` を `dangerouslySetInnerHTML` で挿入している。`highlightedContent` は `fileContent`（APIから取得したログファイルの生Markdownテキスト）を正規表現で分割し、`<mark>` タグでラップして構築している。`searchQuery` は `escapeRegExp` 相当の処理を経ているが、`matchText`（`fileContent`由来の部分文字列）はHTMLエスケープされずにそのまま `<mark>` タグ内に埋め込まれている。

ログファイルのテキスト中に `<script>` や `<img onerror=>` 等のHTML特殊文字が含まれていた場合、XSSが成立する可能性がある。エクスポート用サニタイズ（`log-export-sanitizer.ts`）はパス情報のマスキングを目的としており、XSS対策は目的外である。

**対策**: `highlightedContent` 構築時に、`matchText` および非マッチ部分の `fileContent.substring()` 結果に対してHTMLエスケープ（`<` `>` `&` `"` `'` の変換）を適用してから `<mark>` タグで囲む。

```typescript
// HTMLエスケープユーティリティ（LogViewer.tsx内またはutils.tsに配置）
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// highlightedContent構築時の適用例
// Before (XSS脆弱):
//   `${matchText}` を直接 <mark> タグ内に埋め込み
// After (安全):
//   `${escapeHtml(matchText)}` をエスケープしてから <mark> タグ内に埋め込み
//   非マッチ部分も `escapeHtml(nonMatchText)` でエスケープ
```

**設計根拠 (S4-MF-001)**:
- 既存の `sanitize.ts` (DOMPurify) はHTMLタグの完全除去を行うが、`<mark>` タグを含むHTML文字列の構築には不適切（`<mark>` タグ自体も除去されてしまう）
- シンプルなHTMLエスケープ関数は5つの特殊文字（`& < > " '`）の置換のみであり、外部依存なしで実装可能
- `escapeHtml()` を `src/lib/utils.ts` に配置することで、他のコンポーネントからも再利用可能にする

---

## 4. データモデル設計

### 4-1. 既存データ構造（変更なし）

```
data/logs/
├── claude/
│   ├── {worktreeId}-2026-02-10.md
│   └── {worktreeId}-2026-02-09.md
├── codex/
│   └── {worktreeId}-2026-02-10.md
└── gemini/
    └── {worktreeId}-2026-02-10.md
```

### 4-2. ログファイルのMarkdown構造（既存）

> **[S2-SF-005対応]**: 以下の例は `log-manager.ts` の実際の出力形式に合わせて修正。

```markdown
# Claude Code Conversation Log: {worktreeId}

Created: {date} {time}

---

## {date} {time}

### User
{ユーザーの入力}

### Assistant
{Claudeの応答}

---
```

> **注記**: ヘッダーの `# {ToolName} Conversation Log: {worktreeId}` の `{ToolName}` 部分はCLIツール名（`Claude Code`, `Codex`, `Gemini` 等）に応じて動的に変わる。`Created:` 行はファイル新規作成時に1回のみ出力される。

### 4-3. サニタイズ済みログ出力例

```markdown
# Claude Code Conversation Log: abc123

Created: 2026-02-10 10:00:00

---

## 2026-02-10 10:30:00

### User
src/lib/logger.ts のエラーを修正して

### Assistant
[HOME]/projects/[PROJECT]/src/lib/logger.ts を確認しました...
エラー: [PROJECT]/node_modules/... で発生
DB path: [DB_PATH]
Authorization: [REDACTED]
GITHUB_TOKEN=[REDACTED]

---
```

**マスキングマッピング**:

| 元の値 | マスク後 | 例 |
|--------|---------|-----|
| `/Users/username` (HOME) | `[HOME]` | `/Users/john/work` -> `[HOME]/work` |
| CM_ROOT_DIR値 | `[PROJECT]` | `/Users/john/work/commandmate` -> `[PROJECT]` |
| CM_DB_PATH値 | `[DB_PATH]` | `/Users/john/.commandmate/db.sqlite` -> `[DB_PATH]` |
| ホスト名 | `[HOST]` | `johns-macbook.local` -> `[HOST]` |
| Bearerトークン | `Bearer [REDACTED]` | `Bearer ghp_xxx...` -> `Bearer [REDACTED]` |
| Authorizationヘッダー | `Authorization: [REDACTED]` | `Authorization: token xxx` -> `Authorization: [REDACTED]` |
| パスワード/トークン/シークレット | `{key}=[REDACTED]` | `password=secret123` -> `password=[REDACTED]` |
| SSH秘密鍵 | `[SSH_PRIVATE_KEY_REDACTED]` | `-----BEGIN RSA PRIVATE KEY-----...` -> `[SSH_PRIVATE_KEY_REDACTED]` |
| 既知の環境変数値 | `{ENV_NAME}=[REDACTED]` | `GITHUB_TOKEN=ghp_xxx` -> `GITHUB_TOKEN=[REDACTED]` |

> **[S2-C-003対応] ホスト名取得方法**: ホスト名は `os.hostname()` (Node.js標準モジュール) を使用して取得する。`buildSanitizeRules()` 内で `import os from 'node:os'` を使用し、実行時のホスト名を動的に検出する。

> **[S4-SF-004対応] ホスト名マスキングの制約**: `os.hostname()` で取得される値のみをマスキング対象とする。ネットワーク設定による短縮形・FQDN の差異は `os.hostname()` の返却値に依存する。IPアドレス（ローカルIP: `192.168.x.x`, `10.x.x.x` 等、VPN IP）のマスキングは初期スコープ外。将来の拡張としてローカルIPアドレスパターンのマスキングルール追加を検討する。

> **[C-003対応] ユーザー名パターンについての注記**: 当初設計にあった `/Users/john/` -> `/Users/[USER]/` のユーザー名個別ルールは、HOMEパスのマスキングで実質的にカバーされるため、初期実装では省略する。Linux環境（`/home/username/`）やカスタムホームディレクトリのケースも HOME 環境変数からの動的検出で対応できる。ユーザー名の独立ルールが必要になった場合は追加Issue で対応する。

---

## 5. API設計

### 5-1. 既存API拡張: ログファイル取得（サニタイズオプション追加）

```
GET /api/worktrees/:id/logs/:filename?sanitize=true
```

**リクエスト**:
| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `id` | string (path) | はい | ワークツリーID |
| `filename` | string (path) | はい | ログファイル名（.md） |
| `sanitize` | boolean (query) | いいえ | `true`の場合サニタイズ済みコンテンツを返す |

**レスポンス（200）**:
```typescript
{
  filename: string;
  cliToolId: string;   // APIレスポンスには既に含まれている（S2-SF-001対応: api-client.ts側の型定義のみ欠落）
  content: string;     // sanitize=trueの場合はマスク済み
  size: number;
  modifiedAt: string;  // ISO 8601
}
```

**エラーレスポンス**:
| ステータス | 条件 |
|-----------|------|
| 400 | 不正なファイル名（非.md、パストラバーサル） |
| 404 | ファイルまたはワークツリーが存在しない |
| 500 | ファイルシステムエラー |

> **[S4-SF-003対応] エラーレスポンスのセキュリティ方針**: 現在のエラーレスポンスでは `params.id` をエラーメッセージに含めている（例: `Worktree '${params.id}' not found`）。本Issueのスコープでは既存のエラーレスポンス形式を維持するが、エラーメッセージに内部パスや詳細なスタックトレースを含めないことを方針とする。将来的なセキュリティ強化として、全APIのエラーレスポンスを一般的なメッセージに統一することを検討事項として記録する。500エラー時の `console.error` でのerrorオブジェクト全体出力については、withLogging()のcreateLogger()経由でSENSITIVE_PATTERNSが適用されるため、Phase 1適用対象のAPIについてはリスクが軽減される。

**[SF-001対応] ハンドラー内の責務分離**:
- route.tsのGETハンドラー内では、サニタイズの判定・実行を以下の1行で完結させる:
  ```typescript
  if (sanitize) content = sanitizeForExport(content);
  ```
- サニタイズのビジネスロジック（ルール構築、正規表現適用、ソート）は全て `log-export-sanitizer.ts` 側に配置する

> **[S3-SF-002対応] getLogFile()の呼び出し元分析**: 現在 `api-client.ts` の `getLogFile()` を呼び出しているのは `LogViewer.tsx`（line 75）の1箇所のみである。T4でsanitizeオプション（オプショナルパラメータ）とcliToolIdフィールド（戻り値型への追加）を変更する際、影響を受けるのはこの1箇所のみ。オプショナルパラメータの追加は後方互換性があり、戻り値型へのフィールド追加もTypeScript上は既存コードに影響しない。ただし、テスト側でgetLogFile()をモックしている場合はcliToolIdフィールドの追加が必要になる点に留意する。

### 5-2. 既存API（変更なし）

```
GET /api/worktrees/:id/logs           - ログファイル一覧
GET /api/worktrees/:id/logs/:filename - ログファイル取得（既存）
```

---

## 6. セキュリティ設計

### 6-1. サニタイズによる情報漏洩防止

| リスク | 対策 | 実装箇所 | OWASP分類 |
|-------|------|---------|-----------|
| HOME/ユーザー名の漏洩 | パス文字列をマスクに置換 | `log-export-sanitizer.ts` | A02:2021 |
| CM_ROOT_DIR漏洩 | プロジェクトパスを`[PROJECT]`に置換 | `log-export-sanitizer.ts` | A02:2021 |
| DB絶対パス漏洩 | `[DB_PATH]`に置換 | `log-export-sanitizer.ts` | A02:2021 |
| ホスト名漏洩 | `os.hostname()`で検出し`[HOST]`に置換 | `log-export-sanitizer.ts` | A02:2021 |
| Bearerトークン・APIキー漏洩 | トークンパターンを`[REDACTED]`に置換 | `log-export-sanitizer.ts` | A02:2021 |
| パスワード・シークレット漏洩 | キーバリューペアの値を`[REDACTED]`に置換 | `log-export-sanitizer.ts` | A02:2021 |
| SSH秘密鍵漏洩 | PEMフォーマット全体を`[SSH_PRIVATE_KEY_REDACTED]`に置換 | `log-export-sanitizer.ts` | A02:2021 |
| 既知の環境変数値漏洩 | GITHUB_TOKEN等の既知変数名に対する値を`[REDACTED]`に置換 | `log-export-sanitizer.ts` | A02:2021 |
| 機密値のクライアント送信 | サニタイズをサーバーサイドで実行 | `route.ts`内 | A02:2021 |
| dangerouslySetInnerHTMLによるXSS | highlightedContent構築時にHTMLエスケープ適用 | `LogViewer.tsx` | A03:2021 |

> **[S4-SF-002対応] sanitizeパラメータのデフォルト仕様に関する注記**: デフォルト（`sanitize` パラメータなし）では非サニタイズの生データを返す仕様は**意図的な設計**である。通常の `LogViewer.tsx` 表示には生データが必要であり、サニタイズはエクスポート（外部共有）時のみ適用される。CommandMateはローカル開発ツールとして設計されており、APIは `127.0.0.1` にバインドされるため、同一ホスト上のユーザーのみがアクセス可能である。将来的に外部ユーザーがアクセス可能な環境で運用する場合は、認証/認可の導入と合わせてデフォルトサニタイズの検討が必要である。

> **[S4-SF-004対応] ホスト名マスキングの対象範囲制約**: `os.hostname()` で取得される値のみをマスキング対象とする。IPアドレスやFQDN全体のマスキングは初期スコープ外とし、必要に応じて追加Issueで対応する。将来の拡張として、ローカルIPアドレスパターン（`192.168.x.x`、`10.x.x.x` 等）のマスキングルール追加を検討事項に含める。

### 6-2. サニタイズルール適用順序

パス置換は**最長一致を優先**する。例えば`/Users/john/work/commandmate`が`HOME=/Users/john`かつ`CM_ROOT_DIR=/Users/john/work/commandmate`の場合：

1. `CM_ROOT_DIR`（より長い）を先に`[PROJECT]`に置換
2. `HOME`を`[HOME]`に置換

これにより`[HOME]/work/[PROJECT]`のような二重置換を防ぐ。

機密データパターン（S4-MF-002対応）はパス置換の後に適用される。パス置換ルールはパターン長の降順でソートされるが、機密データパターンは固定正規表現のためソート順に影響しない。

```typescript
// パスルールをパターン長の降順でソート後、機密データパターンを追加
const pathRules = rules.filter(r => isPathRule(r));
const sensitiveRules = rules.filter(r => !isPathRule(r));
pathRules.sort((a, b) => b.pattern.source.length - a.pattern.source.length);
return [...pathRules, ...sensitiveRules];
```

### 6-3. 既存セキュリティ機構との共存

| 機構 | 対象 | 本Issue変更 |
|------|------|-----------|
| `logger.ts` SENSITIVE_PATTERNS | パスワード、トークン、SSHキー（ログ出力時の即時マスキング） | 変更なし |
| `sanitize.ts` DOMPurify | XSS防止（HTMLタグ除去） | 変更なし |
| `log-export-sanitizer.ts`（新規） | パス、環境変数、ホスト名、機密データパターン（エクスポート時のマスキング） | 新規作成（S4-MF-002: 機密データパターン追加） |
| `route.ts` パストラバーサル検証 | ファイル名の`../`検出 | 変更なし |
| `LogViewer.tsx` HTMLエスケープ（新規） | dangerouslySetInnerHTMLによるXSS防止 | 新規追加（S4-MF-001） |

> **[S4-MF-002対応] logger.ts SENSITIVE_PATTERNS との役割分担**: `logger.ts` の SENSITIVE_PATTERNS はログ出力時（`createLogger()` 経由）に即時適用されるマスキングであり、既にファイルに書き込まれた会話ログには適用されない。`log-export-sanitizer.ts` のエクスポート用サニタイズは、ファイルに既に記録された会話ログを外部共有する際に適用される。両者は適用タイミングと対象が異なるため、同等のパターンを両方に持つ設計は意図的である。

### 6-4. APIロギングのセキュリティ

- **開発環境でのみ有効**: `NODE_ENV === 'development'` の場合のみログ出力を実行する。`test` 環境および `production` 環境ではバイパスされる（S2-SF-003対応）
- **レスポンスボディの制限**: 1KB超はtruncate（大量データのログ出力防止）
- **レスポンスボディの選択的省略**: ファイルコンテンツを返すAPIでは `skipResponseBody: true` を指定し、レスポンスボディのログ出力自体を省略する（S4-SF-001対応）
- **既存のsanitize()との連携**: withLogging()内でログ出力する際は`createLogger()`経由でSENSITIVE_PATTERNSが自動適用される

> **[C-001対応] 将来の拡張ポイント**: 現時点ではNODE_ENVチェックで十分だが、ステージング環境やデバッグが必要な本番環境でのログ取得手段として、将来的には環境変数（`CM_API_LOGGING=true`）による制御を検討する。現在の `WithLoggingOptions` インターフェースに `enabled?: boolean` フラグを追加するだけで対応可能な設計となっている。

### 6-5. XSS防止 (S4-MF-001対応)

| 箇所 | リスク | 対策 | OWASP分類 |
|------|-------|------|-----------|
| `LogViewer.tsx` highlightedContent | fileContent由来の未エスケープHTML文字列が `dangerouslySetInnerHTML` 経由でDOMに挿入される | `escapeHtml()` 関数で `< > & " '` をエスケープしてから `<mark>` タグで囲む | A03:2021 - Injection (XSS) |
| `LogViewer.tsx` 非マッチ部分 | searchQuery分割後の非マッチ部分テキストも同様にHTMLエスケープが必要 | 同上 | A03:2021 |

> **注記**: 既存の `sanitize.ts` (DOMPurify) は `TerminalDisplay` 等のコンポーネントでHTMLタグの完全除去に使用されているが、`LogViewer.tsx` の highlight パスでは `<mark>` タグを意図的に挿入する必要があるため、DOMPurify ではなくシンプルなHTMLエスケープ関数を使用する。

### 6-6. OWASP Top 10 チェックリスト (S4対応)

| OWASP カテゴリ | ステータス | 備考 |
|---------------|-----------|------|
| A01: Broken Access Control | acceptable | ローカルツール、127.0.0.1バインド。パストラバーサル対策済み。sanitizeパラメータのデフォルト非適用は意図的仕様（S4-SF-002） |
| A02: Cryptographic Failures | improved | パス・ホスト名に加えて機密データパターン（トークン、パスワード、SSH鍵等）のマスキングを追加（S4-MF-002）。IPアドレスは初期スコープ外（S4-SF-004） |
| A03: Injection (XSS) | improved | LogViewer.tsx highlightedContentのHTMLエスケープ追加（S4-MF-001）。CSP強化は将来課題（S4-C-003） |
| A04: Insecure Design | pass | サーバーサイドサニタイズ、ルールベース設計、既存機構との共存は適切 |
| A05: Security Misconfiguration | acceptable | NODE_ENVによるwithLogging()制御は適切。エラーメッセージの内部ID含有は軽微（S4-SF-003） |
| A06: Vulnerable Components | pass | 外部依存の追加なし |
| A07: Identification and Authentication | not_applicable | ローカル開発ツール、認証はスコープ外（S4-C-001） |
| A08: Software and Data Integrity | pass | サニタイズは読み取り専用、元のログファイルは変更されない |
| A09: Security Logging and Monitoring | improved | withLogging()導入でAPI監視改善。skipResponseBodyオプションで機密データ漏洩防止（S4-SF-001） |
| A10: SSRF | not_applicable | サーバーサイドHTTPリクエスト送信なし |

---

## 7. パフォーマンス設計

### 7-1. サニタイズ処理のパフォーマンス

| 考慮事項 | 対策 |
|---------|------|
| 大きなログファイル | サニタイズルール数は約10個程度（パス4 + 機密データ5-6）、正規表現のコンパイルは関数呼び出し時に1回のみ |
| 頻繁なエクスポート | エクスポートはユーザーのボタン操作時のみ発生、ポーリングなし |
| サーバー負荷 | 1リクエスト1ファイルの処理、並列実行の心配なし |
| SSH秘密鍵パターン | 複数行マッチ（`[\s\S]*?`）を使用するが、非貪欲マッチのためパフォーマンス影響は軽微 |

> **[S3-C-003対応] ルール数増加時のパフォーマンス考慮**: S4-MF-002対応によりサニタイズルール数が約10個に増加したが、各ルールの正規表現は単純なパターンマッチであり、パフォーマンス問題は発生しない。将来ルール数が大幅に増加する場合（20個超）には、パフォーマンス計測を実施し、必要に応じてルールの統合や最適化を検討する。

### 7-2. withLogging()のパフォーマンス

| 考慮事項 | 対策 |
|---------|------|
| ポーリングAPIの大量ログ | `logLevel: 'debug'`を指定、通常のinfoレベルでは出力しない |
| レスポンスボディの読み取り | `response.clone()`でストリームを複製してからボディを読み取る |
| レスポンスサイズ | 1KB超はtruncate、全体をメモリに保持しない。ファイルコンテンツAPIでは`skipResponseBody: true`でclone自体を省略（S4-SF-001, S4-C-002対応） |
| 本番環境オーバーヘッド | `NODE_ENV`チェックで即座にバイパス、ラッパー関数のオーバーヘッドのみ |

> **[S4-C-002対応] response.clone()のメモリ使用量**: `response.clone()` はレスポンス全体をバッファリングする必要があり、大きなログファイル（数MB級）のレスポンスではメモリ使用量が一時的に倍増する。`skipResponseBody: true` オプションを使用するAPIハンドラーでは clone() 自体を実行しないため、この問題は回避される。本番環境ではwithLogging()自体がバイパスされるため実害はないが、開発環境でのリソース使用量に留意する。

---

## 8. 設計上の決定事項とトレードオフ

### 採用した設計

| # | 決定事項 | 理由 | トレードオフ |
|---|---------|------|-------------|
| D-1 | サーバーサイドサニタイズ | getEnv()がサーバー専用、機密値のクライアント送信回避 | APIリクエストが1回増加（サニタイズ用） |
| D-2 | 既存APIへの`?sanitize=true`追加 | エンドポイント増加回避、変更量最小 | 1つのAPIに2つの責務（通常取得/サニタイズ取得）。ただしハンドラー内の条件分岐は1行に限定し、SRP違反を最小化（SF-001対応）。デフォルトが非サニタイズなのは意図的仕様（S4-SF-002対応） |
| D-3 | withLogging()のDecoratorパターン | 各route.tsの変更が1行で完結、段階的適用可能 | 全ハンドラーの型がジェネリクス付き`ApiHandler<P>`に統一される必要あり（MF-001対応）。withLogging()内部ではparamsに直接アクセスせずURLのpathnameを使用する（S2-MF-002対応） |
| D-4 | log-export-sanitizer.ts新規作成 | 既存sanitize.ts（XSS）との目的の違いを明確化 | モジュール数が1つ増加 |
| D-5 | ポーリングAPIはdebugレベル | 大量ログ出力の防止 | デフォルトのinfo設定では確認不可 |
| D-6 | logger.tsへの変更なし | 7モジュールへの影響を回避 | withLogging()内でcreateLogger()を直接利用 |
| D-7 | log-manager.tsへの変更なし | 既存APIがfs.readFile()で直接読み取り | サニタイズとログ管理のレイヤーが分離 |
| D-8 | LOG_DIR定数の共通設定モジュール一元化 | DRY原則遵守、パス変更時の整合性確保 | 新規ファイル（log-config.ts）の追加（SF-004対応） |
| D-9 | 既存escapeRegExp()をutils.tsから再利用 | 同一ロジックの重複回避、既存関数の活用 | JSDocコメントの更新が必要（S2-MF-001対応。旧方針のescapeRegex()新規追加を撤回） |
| D-10 | withLogging()のPhase 2を別Issueに切り出し | YAGNI原則に基づきスコープ限定 | 全APIへの統一的ロギング適用は遅延する（SF-003対応）。Phase 2では7箇所のPromise params型統一コストが発生する（S3-SF-004対応） |
| D-11 | Phase 1のwithLogging()適用対象を明示的に限定 | スコープクリープ防止、実装範囲の明確化 | ログ関連2ファイル3ハンドラーに限定し、拡張は別Issue（S3-MF-001対応） |
| D-12 | エクスポート用サニタイズに機密データパターンを追加 | 会話ログ内のトークン・パスワード・SSH鍵の漏洩防止 | サニタイズルール数が約10個に増加するが、パフォーマンス影響は軽微（S4-MF-002対応） |
| D-13 | LogViewer.tsx highlightedContentにHTMLエスケープ追加 | dangerouslySetInnerHTMLによるXSS脆弱性の排除 | escapeHtml()関数の追加が必要だが、5文字の置換のみで軽量（S4-MF-001対応） |
| D-14 | WithLoggingOptionsにskipResponseBodyオプション追加 | ファイルコンテンツAPIのレスポンスボディログ出力による機密データ漏洩防止 | ログの詳細度が低下するが、セキュリティを優先（S4-SF-001対応） |

### SOLID原則との整合

| 原則 | 適用 |
|------|------|
| **S**ingle Responsibility | log-export-sanitizer.ts: パス・機密データサニタイズのみ、api-logger.ts: APIロギングのみ。route.tsのサニタイズ呼び出しは1行に限定（SF-001） |
| **O**pen/Closed | withLogging()は既存ハンドラーを変更せずに機能追加。サニタイズルールは配列への追加で拡張可能（S4-MF-002） |
| **L**iskov Substitution | withLogging()でラップしても元のハンドラーと同じジェネリクス型インターフェースを維持（MF-001対応） |
| **I**nterface Segregation | サニタイズ（エクスポート用）とサニタイズ（XSS用）を別モジュールに分離 |
| **D**ependency Inversion | withLogging()はcreateLogger()インターフェースにのみ依存 |

---

## 9. テスト戦略

### テスト対象と種別

| テスト対象 | 種別 | 優先度 | テストファイル |
|-----------|------|--------|--------------|
| `log-export-sanitizer.ts` | Unit | 高 | `tests/unit/log-export-sanitizer.test.ts` |
| `api-logger.ts` (withLogging) | Unit | 高 | `tests/unit/api-logger.test.ts` |
| `api-logs.test.ts`（既存修正） | Integration | 高 | `tests/integration/api-logs.test.ts` |
| LogViewer.tsx エクスポートボタン | Component | 中 | `tests/unit/LogViewer-export.test.ts` |
| `log-manager.ts`（回帰テスト） | Unit | 中 | `tests/unit/log-manager.test.ts` |

### [MF-002対応] 統合テスト修正方針

既存の `tests/integration/api-logs.test.ts` が現行実装と大幅に乖離しているため、サニタイズ機能追加の**前提条件**として以下の修正を実施する:

#### 修正方針の詳細

1. **fsモジュールのモック戦略変更**:
   - **現状（問題）**: 同期APIモック（`fs.existsSync`, `fs.readdirSync`, `fs.readFileSync`）を使用
   - **修正後**: 非同期APIモック（`fs/promises` の `stat`, `readFile`, `readdir`）に統一
   - `vi.mock('fs/promises')` を使用し、各テストケースで `vi.mocked(fs.stat)` 等を設定

2. **[S2-SF-002対応] ログ一覧API (logs/route.ts) のモック戦略**:
   - **重要**: `logs/route.ts`（一覧取得）は `log-manager.ts` の `listLogs()` を経由してファイルシステムにアクセスしている。直接 `fs` を呼び出しているわけではない
   - **テスト戦略の選択肢**:
     - **(a) log-manager.tsをモック**: `vi.mock('@/lib/log-manager')` で `listLogs()` をモックする。route.tsのロジックのみをテスト対象とする場合に適切
     - **(b) fs/promisesをモック**: `vi.mock('fs/promises')` でファイルシステムをモックし、`log-manager.ts` 経由のアクセスもカバーする。統合テストとしてlog-manager.tsとroute.tsの連携もテストする場合に適切
   - **推奨**: 統合テストの目的に合致する **(b)** を採用し、log-manager.ts経由のfsアクセスも含めてテストする。ただし、`[filename]/route.ts`（個別取得）は直接 `fs/promises` を使用しているため、テストファイル内でAPIごとのモック対象の違いを明確にコメントで記載する

3. **ファイル拡張子の統一**:
   - **現状（問題）**: `.jsonl` 拡張子を期待するテストが存在
   - **修正後**: `.md` 拡張子に統一（実際のAPIが `.md` のみ受け付けるため）

4. **worktreeIdプレフィクス検証の追加**:
   - **現状（問題）**: ファイル名のバリデーションテストが不十分
   - **修正後**: `{worktreeId}-{date}.md` 形式のファイル名パターン検証テストを追加

5. **テスト構造の整理**:
   - パストラバーサル検証テスト（既存）の維持
   - 正常系テストの非同期API対応
   - サニタイズオプション（`?sanitize=true`）のテストケース追加（T3完了後）

### log-export-sanitizer.ts テストケース

> **[S3-C-001対応] os.hostname()モック方針**: `buildSanitizeRules()` は `os.hostname()` を呼び出してホスト名を取得する。テスト環境（CI/CD含む）ではホスト名が開発環境と異なり、Docker内では短縮ホスト名になることがある。テストでは `vi.mock('node:os')` で `os.hostname()` をモックし、固定値（例: `'test-host.local'`）を返すようにする。これにより、CI環境でのホスト名のバリエーションに依存しない安定したテストを実現する。

```typescript
describe('sanitizeForExport', () => {
  // os.hostname()はvi.mock('node:os')でモック（S3-C-001対応）
  it('HOMEディレクトリパスを[HOME]に置換する', () => {});
  it('CM_ROOT_DIRを[PROJECT]に置換する', () => {});
  it('CM_DB_PATHを[DB_PATH]に置換する', () => {});
  it('ホスト名を[HOST]に置換する', () => {});
  it('相対パス・ファイル名は保持する', () => {});
  it('エラーメッセージは保持する（パス部分のみマスク）', () => {});
  it('最長一致で二重置換を防ぐ', () => {});
  it('CM_ROOT_DIR未設定時はprocess.cwd()のフォールバック値でサニタイズする', () => {});
  it('HOME未設定時もエラーにならない', () => {});
  it('/Users/*, /home/*パターンが結果に含まれない', () => {});
  // S4-MF-002対応: 機密データパターンのテストケース
  it('Bearerトークンを[REDACTED]に置換する', () => {});
  it('Authorizationヘッダーの値を[REDACTED]に置換する', () => {});
  it('password=xxxパターンを[REDACTED]に置換する', () => {});
  it('token=xxxパターンを[REDACTED]に置換する', () => {});
  it('SSH秘密鍵全体を[SSH_PRIVATE_KEY_REDACTED]に置換する', () => {});
  it('GITHUB_TOKEN=xxxパターンを[REDACTED]に置換する', () => {});
  it('機密データとパスの両方を含むテキストで両方がマスキングされる', () => {});
});
```

### withLogging() テストケース

```typescript
describe('withLogging', () => {
  it('開発環境でリクエスト/レスポンスをログ出力する', () => {});
  it('本番環境ではログ出力しない', () => {});
  it('NODE_ENV=testではログ出力しない', () => {});
  it('debugレベル指定時はdebugでログ出力する', () => {});
  it('レスポンスボディが1KB超の場合はtruncateする', () => {});
  it('元のハンドラーのレスポンスをそのまま返す', () => {});
  it('ハンドラーのエラーを伝播する', () => {});
  it('ジェネリクス型パラメータが正しく推論される', () => {}); // MF-001対応
  it('ログにはURLのpathnameを使用しparamsに直接アクセスしない', () => {}); // S2-MF-002対応
  it('skipResponseBody=trueの場合レスポンスボディをログ出力しない', () => {}); // S4-SF-001対応
  it('skipResponseBody=trueの場合response.clone()を呼び出さない', () => {}); // S4-C-002対応
});
```

---

## 10. 実装順序と依存関係

```mermaid
graph TD
    T1["1. 既存統合テスト修正<br>api-logs.test.ts<br>(MF-002: fs/promises, .md統一)"] --> T3
    T2["2. log-export-sanitizer.ts<br>+ テスト<br>+ escapeRegExp JSDoc更新<br>+ 機密データパターン(S4-MF-002)"] --> T3
    T3[3. route.ts サニタイズオプション追加]
    T3 --> T4[4. api-client.ts 拡張<br>+ 型修正]
    T4 --> T5["5. LogViewer.tsx<br>エクスポートボタン<br>+ HTMLエスケープ(S4-MF-001)<br>+ インライン正規表現置換"]
    T6["6. api-logger.ts<br>withLogging + テスト<br>(MF-001: ジェネリクス型)<br>+ skipResponseBody(S4-SF-001)"] --> T7
    T0[0. log-config.ts<br>LOG_DIR一元化] --> T1
    T0 --> T2
    T7["7. Phase 1: ログ関連route.tsに適用<br>(SF-003: スコープ限定)<br>+ skipResponseBody指定"]
    T8[8. log-manager.ts 回帰テスト]
    T9[9. CLAUDE.md更新]

    style T0 fill:#99ff99
    style T1 fill:#ff9999
    style T2 fill:#ff9999
    style T3 fill:#ff9999
    style T6 fill:#99ccff
```

**凡例**: 赤=エクスポート機能系、青=APIロギング系、緑=共通基盤

**[SF-003対応] スコープ変更**: 旧Phase 2（残りroute.tsに適用）は本Issueのスコープから除外し、別Issueとして管理する。withLogging()の適用はPhase 1のログ関連APIに限定する。

**[S3-MF-001対応] Phase 1 withLogging()適用対象の明示的ファイルリスト**:

Phase 1では以下の**2ファイル3ハンドラー**のみにwithLogging()を適用する。これ以外のAPIへの適用はPhase 2（別Issue）として管理する。

| # | ファイルパス | ハンドラー | logLevel | skipResponseBody | 理由 |
|---|------------|-----------|----------|------------------|------|
| 1 | `src/app/api/worktrees/[id]/logs/route.ts` | GET | info | false | ログ一覧取得（エクスポート機能の関連API） |
| 2 | `src/app/api/worktrees/[id]/logs/[filename]/route.ts` | GET | info | true (S4-SF-001) | ログ個別取得（サニタイズオプション追加対象、ファイルコンテンツを返すためレスポンスボディログ省略） |
| 3 | `src/app/api/worktrees/[id]/logs/[filename]/route.ts` | DELETE | info | false | ログ削除（バグ調査時のデータ操作追跡） |

> **注記**: 当初「バグ調査に必要なAPI」として曖昧な範囲を設定していたが、スコープクリープ防止のためログ関連APIの3ハンドラーに限定した。バグ調査で追加のAPIロギングが必要になった場合は、Phase 2で対応する。

**[S3-SF-004対応] Phase 2別Issue起票時の前提条件**:

Phase 2（残り44-45ハンドラーへのwithLogging()適用）を別Issueとして起票する際、以下の情報を含める:

- **Promise params型の統一が必要なファイル（7箇所）**:
  - `src/app/api/external-apps/[id]/route.ts` (GET, PUT, DELETE: 3ハンドラー)
  - `src/app/api/external-apps/[id]/health/route.ts` (GET: 1ハンドラー)
  - `src/app/api/repositories/clone/[jobId]/route.ts` (GET: 1ハンドラー)
  - `src/app/api/worktrees/[id]/interrupt/route.ts` (POST: 1ハンドラー)
  - `src/app/api/worktrees/[id]/slash-commands/route.ts` (POST: 1ハンドラー)
- **型統一の作業量見積もり**: 7箇所のparams型を `P | Promise<P>` に統一するか、`await Promise.resolve(context.params)` パターンに移行する作業が必要
- **ハンドラー総数**: 全25ファイル48ハンドラーのうち、Phase 1で適用済みの3ハンドラーを除く45ハンドラーが対象

**[SF-004対応] 新規タスク追加**: T0（log-config.ts LOG_DIR一元化）を追加。route.tsとlog-manager.tsの重複定義を解消する前提タスク。

**[S3-SF-001対応] T0の依存チェーン分析と循環依存の排除確認**:

`log-config.ts` は `getEnvByKey()` を使用するため `env.ts` に依存する。この依存チェーンが循環依存を起こさないことを確認した:

```
log-config.ts -> env.ts -> db-path-resolver.ts
                        -> (process.env直接参照)
```

- `env.ts` は `log-config.ts` をインポートしない
- `db-path-resolver.ts` は `env.ts` / `log-config.ts` をインポートしない
- `log-manager.ts` は `log-config.ts` をインポートするが、`log-config.ts` は `log-manager.ts` をインポートしない
- `conversation-logger.ts` は `log-manager.ts` をインポートするが、`log-config.ts` を直接インポートしない

従って循環依存は発生しない。T0実施後に `npm run build` が成功することを検証ステップとして必須とする。

**[S2-MF-001対応] T2の変更**: escapeRegex()の新規追加ではなく、既存escapeRegExp()のJSDocコメント更新に変更。

**[S2-C-002対応] mermaidノードID修正**: ノードIDとラベル番号を一致させた（T8=回帰テスト、T9=CLAUDE.md更新）。

**並列実行可能なグループ**:
- 前提: T0（LOG_DIR一元化）
- Group A (エクスポート): T1 -> T2 -> T3 -> T4 -> T5
- Group B (APIロギング): T6 -> T7
- 独立タスク: T8（回帰テスト）, T9（CLAUDE.md更新）

### T1: 統合テスト修正の具体的方針 (MF-002対応)

| 修正項目 | 現状 | 修正後 |
|---------|------|--------|
| fsモック対象 | `fs.existsSync`, `fs.readdirSync`, `fs.readFileSync` | `fs/promises` の `stat`, `readFile`, `readdir`, `access`, `mkdir`（S3-MF-002対応で拡充） |
| logs/route.tsのアクセス経路 | （未考慮） | `log-manager.ts` の `listLogs()` 経由であることを認識（S2-SF-002対応） |
| ファイル拡張子 | `.jsonl` を含む | `.md` のみ |
| worktreeIdプレフィクス | 検証なし | `{worktreeId}-{date}.md` パターン検証追加 |
| パストラバーサル | 既存テストあり | 維持（変更なし） |

#### [S3-MF-002対応] fs/promisesモック対象関数の詳細

`logs/route.ts`（一覧取得）は `log-manager.ts` の `listLogs()` を経由しており、`log-manager.ts` 内部では `ensureLogDirectory()` によるディレクトリ作成も行われる。そのため、`fs/promises` のモックが不完全だとテストが予期しない挙動を示す。以下に、APIルートごとにモックが必要なfs/promises関数を整理する。

**logs/route.ts (一覧取得) -- log-manager.ts経由**:

| fs/promises関数 | 呼び出し元 | 用途 |
|----------------|-----------|------|
| `access` | `log-manager.ts` `ensureLogDirectory()` | ログディレクトリの存在確認 |
| `mkdir` | `log-manager.ts` `ensureLogDirectory()` | ログディレクトリの作成（存在しない場合） |
| `readdir` | `log-manager.ts` `listLogs()` | CLIツール別サブディレクトリの列挙 |
| `stat` | `log-manager.ts` `listLogs()` | ファイルのメタデータ取得（サイズ、更新日時） |

**logs/[filename]/route.ts (個別取得) -- 直接fsアクセス**:

| fs/promises関数 | 呼び出し元 | 用途 |
|----------------|-----------|------|
| `readFile` | `route.ts` 直接 | ログファイルの内容読み取り |
| `stat` | `route.ts` 直接 | ファイルのメタデータ取得 |

**テストケースごとのモック要件**:
- ログ一覧正常系: `access`(成功), `readdir`(ファイルリスト返却), `stat`(メタデータ返却)
- ログ一覧ディレクトリ未存在: `access`(ENOENT), `mkdir`(成功), `readdir`(空配列返却)
- ログ個別取得正常系: `readFile`(内容返却), `stat`(メタデータ返却)
- ログ個別取得サニタイズ: `readFile`(パス含む内容返却), `stat`(メタデータ返却)
- パストラバーサル: fsモック呼び出し前にバリデーションで拒否されるためモック不要

---

## 11. 制約事項

| # | 制約 | 影響 |
|---|------|------|
| C-1 | `getEnv()`にHOMEが含まれない | `process.env.HOME`を直接参照する必要がある |
| C-2 | LogViewer.tsxが`'use client'` | サニタイズをサーバーサイドAPI経由で実行 |
| C-3 | 既存統合テストがroute.tsと不整合 | サニタイズ追加前にテスト修正が必要（前提条件）。MF-002で修正方針を明確化済み。なおlogs/route.tsはlog-manager.ts経由のfsアクセスである点に留意（S2-SF-002対応） |
| C-4 | api-client.tsのgetLogFile()の戻り値型定義にcliToolIdフィールドが欠落（APIレスポンス自体には含まれている） | サニタイズオプション追加時に合わせて型定義を修正（S2-SF-001対応: 表現を正確化） |
| C-5 | Next.js App Routerにミドルウェア制約 | Edge Runtimeの制約でwithLogging()をヘルパー関数方式に |
| C-6 | VitestのNODE_ENVデフォルトが`test` | withLogging()はNODE_ENV === 'development'の場合のみログ出力するため、test環境では自動的にバイパスされる。開発環境のログ出力を検証するテストでは`process.env.NODE_ENV`を一時的に`'development'`に変更する必要がある（S2-SF-003対応） |
| C-7 | Next.js App RouterのparamsがPromise化する可能性 | ApiHandler型を`P \| Promise<P>`で定義して対応（MF-001対応）。現在のコードベースでは非Promise版（41ハンドラー）とPromise版（7ハンドラー: external-apps/[id] x3, external-apps/[id]/health, repositories/clone/[jobId], worktrees/[id]/interrupt, worktrees/[id]/slash-commands）が混在している。withLogging()内部ではparamsに直接アクセスせずURLのpathnameを使用することで、この混在の影響を回避する（S2-MF-002, S3-SF-004対応） |
| C-8 | log-config.tsの依存チェーン（log-config.ts -> env.ts -> db-path-resolver.ts）が循環依存を起こさないこと | 分析済み: 循環依存は発生しない。T0実施後にnpm run buildで検証必須（S3-SF-001対応） |
| C-9 | ローカル開発ツールとして認証/認可メカニズムが存在しない | 127.0.0.1バインドで外部アクセスをブロック。sanitizeパラメータのデフォルト非適用は意図的仕様。将来的にリモートアクセス対応時は認証導入が必要（S4-C-001, S4-SF-002対応） |
| C-10 | os.hostname()で取得される値のみをホスト名マスキング対象とする | IPアドレスやFQDN全体のマスキングは初期スコープ外（S4-SF-004対応） |
| C-11 | logger.ts SENSITIVE_PATTERNSは会話ログファイルには適用されない | log-export-sanitizer.tsで同等のパターンを別途定義する必要がある（S4-MF-002対応） |

---

## 12. レビュー指摘事項サマリー

### Stage 1: 通常レビュー (2026-02-10)

**ステータス**: conditionally_approved (スコア: 4/5)

#### Must Fix 項目

| ID | タイトル | 対応セクション | 状態 |
|----|---------|--------------|------|
| MF-001 | withLogging()のApiHandler型が既存route.tsのハンドラーシグネチャと不一致 | 3-1, 8, 9 | 反映済み |
| MF-002 | 統合テストが現行実装と大幅に乖離 | 9, 10 (T1) | 反映済み |

#### Should Fix 項目

| ID | タイトル | 対応セクション | 状態 |
|----|---------|--------------|------|
| SF-001 | sanitizeクエリパラメータによるSRP希薄化 | 3-3, 5-1, 8 (D-2) | 反映済み |
| SF-002 | SanitizeRuleのStrategyパターン命名が実態と乖離 | 3-2 | 反映済み |
| SF-003 | withLogging()段階的適用におけるYAGNI考慮 | 10 | 反映済み |
| SF-004 | LOG_DIRの重複定義 | 1, 2, 8 (D-8), 10 (T0) | 反映済み |
| SF-005 | escapeRegexユーティリティの所在が不明 | 2, 3-2, 8 (D-9), 9 | 反映済み |

#### Consider 項目

| ID | タイトル | 対応セクション | 状態 |
|----|---------|--------------|------|
| C-001 | withLogging()の本番環境バイパスがNODE_ENVのみに依存 | 6-4 | 注記追加 |
| C-002 | Facadeパターンの命名について | 3-3 | 反映済み |
| C-003 | サニタイズルールのユーザー名パターンの堅牢性 | 4-3 | 注記追加 |

### Stage 2: 整合性レビュー (2026-02-10)

**ステータス**: conditionally_approved (スコア: 4/5)

#### Must Fix 項目

| ID | タイトル | 対応セクション | 状態 |
|----|---------|--------------|------|
| S2-MF-001 | escapeRegex()と既存escapeRegExp()の命名不整合（重複関数の回避） | 1, 2, 3-2, 8 (D-9), 10 (T2), 13 | 反映済み |
| S2-MF-002 | withLogging()のApiHandler型におけるparams型のPromise/非Promise混在 | 3-1, 8 (D-3), 11 (C-7) | 反映済み |

#### Should Fix 項目

| ID | タイトル | 対応セクション | 状態 |
|----|---------|--------------|------|
| S2-SF-001 | api-client.ts getLogFile()のcliToolId欠落の記述が不正確（型定義のみ欠落） | 5-1, 11 (C-4), 13 | 反映済み |
| S2-SF-002 | 統合テストのfsモック戦略にlog-manager.ts経由の考慮が不足 | 9, 10 (T1), 11 (C-3) | 反映済み |
| S2-SF-003 | withLogging()のNODE_ENVチェック条件でtest環境の扱いが不明確 | 6-4, 11 (C-6) | 反映済み |
| S2-SF-004 | LogViewer.tsxのインライン正規表現エスケープが既知の技術的負債 | 3-2, 13 | 反映済み |
| S2-SF-005 | MarkdownログのヘッダーFormが実装と不一致 | 4-2, 4-3 | 反映済み |

#### Consider 項目

| ID | タイトル | 対応セクション | 状態 |
|----|---------|--------------|------|
| S2-C-001 | route.tsのhandler型の将来的統一（Phase 2前提条件） | 3-1, 10 | 注記追加 |
| S2-C-002 | mermaid図のタスク番号とチェックリスト内番号の不一致 | 10 | 反映済み |
| S2-C-003 | ホスト名マスキングの取得方法（os.hostname()）が未記載 | 3-2, 4-3, 6-1 | 反映済み |

### Stage 3: 影響分析レビュー (2026-02-10)

**ステータス**: conditionally_approved (スコア: 4/5)

#### Must Fix 項目

| ID | タイトル | 対応セクション | 状態 |
|----|---------|--------------|------|
| S3-MF-001 | withLogging()のPhase 1適用範囲が不明確 -- 具体的なroute.tsファイルリストが未記載 | 8 (D-11), 10 (T7), 13 | 反映済み |
| S3-MF-002 | 統合テスト修正(T1)の波及リスクの過小評価 -- log-manager.tsのfs/promises関数リスト未整理 | 9, 10 (T1), 13 | 反映済み |

#### Should Fix 項目

| ID | タイトル | 対応セクション | 状態 |
|----|---------|--------------|------|
| S3-SF-001 | log-config.ts導入(T0)によるモジュール初期化順序・循環依存リスク | 10 (T0), 11 (C-8), 13 | 反映済み |
| S3-SF-002 | api-client.tsのgetLogFile()呼び出し元の影響分析結果の明記 | 5-1, 10 (T4), 13 | 反映済み |
| S3-SF-003 | escapeRegExp()のJSDoc更新時にSEC-MF-001 ReDoS防止注記を保持すること | 3-2, 10 (T2), 13 | 反映済み |
| S3-SF-004 | Phase 2別Issue起票時のPromise params型統一コスト見積もり | 8 (D-10), 10 (T7), 11 (C-7) | 反映済み |

#### Consider 項目

| ID | タイトル | 対応セクション | 状態 |
|----|---------|--------------|------|
| S3-C-001 | os.hostname()のテスト環境（CI/CD含む）でのモック方針 | 9, 13 | 注記追加 |
| S3-C-002 | LogViewer.tsxエクスポートボタン追加時のモバイルUIレイアウト確認 | 13 (T5) | 注記追加 |
| S3-C-003 | サニタイズルール数増加時のパフォーマンス考慮 | 7-1 | 注記追加 |

### Stage 4: セキュリティレビュー (2026-02-10)

**ステータス**: conditionally_approved (スコア: 4/5)

#### Must Fix 項目

| ID | タイトル | 重大度 | OWASP分類 | 対応セクション | 状態 |
|----|---------|--------|-----------|--------------|------|
| S4-MF-001 | LogViewer.tsx の dangerouslySetInnerHTML による XSS リスク -- サニタイズ済みコンテンツ挿入時の未エスケープ | high | A03:2021 - Injection (XSS) | 2, 3-4, 6-1, 6-3, 6-5, 8 (D-13), 13 (T5) | 反映済み |
| S4-MF-002 | log-export-sanitizer.ts のサニタイズルール不足 -- 環境変数値やAPIキーが会話ログ内に残存する可能性 | high | A02:2021 - Sensitive Data Exposure | 1, 3-2, 4-3, 6-1, 6-3, 7-1, 8 (D-12), 9, 11 (C-11), 13 (T2) | 反映済み |

#### Should Fix 項目

| ID | タイトル | 重大度 | OWASP分類 | 対応セクション | 状態 |
|----|---------|--------|-----------|--------------|------|
| S4-SF-001 | withLogging() のレスポンスボディログ出力における機密データ漏洩リスク | medium | A09:2021 - Logging Failures | 3-1, 6-4, 7-2, 8 (D-14), 9, 10 (T6, T7), 13 | 反映済み |
| S4-SF-002 | sanitize クエリパラメータのバイパスリスク -- sanitize=false の明示的送信による情報漏洩 | low | A01:2021 - Broken Access Control | 6-1, 8 (D-2), 11 (C-9) | 反映済み |
| S4-SF-003 | エラーレスポンスにおける内部情報漏洩 | low | A05:2021 - Security Misconfiguration | 5-1 | 反映済み |
| S4-SF-004 | os.hostname() で取得するホスト名のサニタイズ対象の網羅性不足 | medium | A02:2021 - Sensitive Data Exposure | 3-2, 4-3, 6-1, 11 (C-10) | 反映済み |

#### Consider 項目

| ID | タイトル | OWASP分類 | 対応セクション | 状態 |
|----|---------|-----------|--------------|------|
| S4-C-001 | 認証/認可メカニズムの不在 | A07:2021 | 6-6, 11 (C-9) | 注記追加 |
| S4-C-002 | レスポンスボディ clone() によるメモリ使用量の二重化 | A06:2021 | 7-2 | 注記追加 |
| S4-C-003 | CSP ポリシーにおける unsafe-inline / unsafe-eval の存在 | A03:2021 | 6-6 | 注記追加 |
| S4-C-004 | サニタイズルールの正規表現 ReDoS リスク評価 | A03:2021 | 3-2 | 注記追加 |

### リスク評価

| カテゴリ | Stage 1 | Stage 2 | Stage 3 | Stage 4 |
|---------|---------|---------|---------|---------|
| 技術リスク | Medium | Medium | Medium | Medium |
| セキュリティリスク | Low | Low | Low | Medium |
| 運用リスク | Low | Low | Low | Low |

---

## 13. 実装チェックリスト

### 前提タスク

- [ ] **T0**: `src/config/log-config.ts` を新規作成し、LOG_DIR定数を一元管理する (SF-004)
- [ ] **T0**: `src/lib/log-manager.ts` のLOG_DIR定義を `log-config.ts` からのインポートに変更
- [ ] **T0**: `src/app/api/worktrees/[id]/logs/[filename]/route.ts` のLOG_DIR定義を `log-config.ts` からのインポートに変更
- [ ] **T0**: 循環依存が発生しないことを確認（log-config.ts -> env.ts -> db-path-resolver.ts チェーン）(S3-SF-001)
- [ ] **T0**: `npm run build` が成功することを検証 (S3-SF-001)

### エクスポート機能系 (Group A)

- [ ] **T1**: `tests/integration/api-logs.test.ts` のfsモックを `fs/promises` に変更（対象関数: stat, readFile, readdir, access, mkdir）(MF-002, S3-MF-002)
- [ ] **T1**: テスト内の `.jsonl` 拡張子を `.md` に統一 (MF-002)
- [ ] **T1**: worktreeIdプレフィクス検証テストを追加 (MF-002)
- [ ] **T1**: logs/route.tsがlog-manager.ts経由でfsにアクセスする点をテスト内コメントに記載 (S2-SF-002)
- [ ] **T1**: テストケースごとのモック要件を整理（ログ一覧: access/mkdir/readdir/stat、ログ個別: readFile/stat）(S3-MF-002)
- [ ] **T2**: `src/lib/utils.ts` の既存 `escapeRegExp()` のJSDocコメントを更新（サーバーサイド利用も想定する旨を追記、SEC-MF-001のReDoS防止注記は保持、環境変数値からの正規表現構築は安全である旨を追記）(S2-MF-001, S3-SF-003, S4-C-004)
- [ ] **T2**: `src/lib/log-export-sanitizer.ts` を新規作成（`escapeRegExp()` をインポートして使用）(S2-MF-001)
- [ ] **T2**: `buildSanitizeRules()` にホスト名ルール（`os.hostname()` 使用）を含める (S2-C-003)
- [ ] **T2**: `buildSanitizeRules()` に機密データパターン（Bearer トークン、Authorization ヘッダー、password/token/secret キーバリューペア、SSH秘密鍵、既知の環境変数名）を追加 (S4-MF-002)
- [ ] **T2**: 機密データパターンが `logger.ts` の SENSITIVE_PATTERNS と同等であることを確認 (S4-MF-002)
- [ ] **T2**: `tests/unit/log-export-sanitizer.test.ts` を作成（`vi.mock('node:os')` でos.hostname()をモック）(S3-C-001)
- [ ] **T2**: 機密データパターンのテストケースを追加（Bearerトークン、Authorizationヘッダー、password/token/secretパターン、SSH秘密鍵、GITHUB_TOKEN等、機密データ+パス混在ケース）(S4-MF-002)
- [ ] **T3**: `route.ts` に `?sanitize=true` クエリパラメータ対応を追加
- [ ] **T3**: サニタイズ呼び出しは条件分岐1行に限定 (SF-001)
- [ ] **T4**: `api-client.ts` の `getLogFile()` にsanitizeオプションを追加
- [ ] **T4**: `api-client.ts` の `LogFileResponse` 型定義に `cliToolId` フィールドを追加（APIレスポンスには既に含まれている）(S2-SF-001)
- [ ] **T4**: 変更前にgetLogFile()の呼び出し元がLogViewer.tsx (line 75) の1箇所のみであることをgrep等で確認 (S3-SF-002)
- [ ] **T5**: `LogViewer.tsx` にエクスポートボタンを追加
- [ ] **T5**: モバイル表示時のレスポンシブデザインを確認（CardHeaderにClose/検索コントロール+エクスポートボタンが収まること）(S3-C-002)
- [ ] **T5**: `LogViewer.tsx` のインライン正規表現エスケープを `escapeRegExp()` のインポートに置き換え (S2-SF-004)
- [ ] **T5**: `LogViewer.tsx` の `highlightedContent` 構築時に `escapeHtml()` を適用し、`matchText` および非マッチ部分の `fileContent.substring()` 結果をHTMLエスケープしてから `<mark>` タグで囲む (S4-MF-001)
- [ ] **T5**: `escapeHtml()` 関数を `src/lib/utils.ts` に配置（`< > & " '` の5文字をエスケープ）(S4-MF-001)
- [ ] **T5**: `highlightedContent` のXSS対策テストケースを追加（HTML特殊文字を含むログファイルでXSSが発生しないことを確認）(S4-MF-001)

### APIロギング系 (Group B)

- [ ] **T6**: `src/lib/api-logger.ts` を新規作成（ジェネリクス型 `ApiHandler<P>` を使用）(MF-001)
- [ ] **T6**: withLogging()内部ではparamsに直接アクセスせず、`request.nextUrl.pathname` を使用 (S2-MF-002)
- [ ] **T6**: `WithLoggingOptions` に `skipResponseBody?: boolean` オプションを追加（デフォルト: false）(S4-SF-001)
- [ ] **T6**: `skipResponseBody: true` の場合、`response.clone()` を呼び出さずレスポンスボディのログ出力を省略する実装 (S4-SF-001, S4-C-002)
- [ ] **T6**: `tests/unit/api-logger.test.ts` を作成（ジェネリクス型推論テスト、paramsアクセス不使用テスト、skipResponseBodyテスト含む）(MF-001, S2-MF-002, S4-SF-001)
- [ ] **T7**: 以下の2ファイル3ハンドラーのみに `withLogging()` を適用 (SF-003, S3-MF-001):
  - `src/app/api/worktrees/[id]/logs/route.ts` (GET)
  - `src/app/api/worktrees/[id]/logs/[filename]/route.ts` (GET, DELETE)
- [ ] **T7**: ログ個別取得API (GET) には `skipResponseBody: true` を指定（ファイルコンテンツを返すAPIのためレスポンスボディログ省略）(S4-SF-001)
- [ ] **T7**: 残りのAPIへの適用は別Issueとして起票。起票時にPromise params型の7箇所のファイルリストと型統一コスト見積もりを含める (SF-003, S2-C-001, S3-SF-004)

### 独立タスク

- [ ] **T8**: `log-manager.ts` の回帰テスト実施
- [ ] **T9**: `CLAUDE.md` を更新（新規モジュールの記載追加）

### 品質確認

- [ ] `npm run lint` パス
- [ ] `npx tsc --noEmit` パス
- [ ] `npm run test:unit` パス
- [ ] `npm run test:integration` パス
- [ ] `npm run build` パス

---

## 14. レビュー履歴

| 日付 | ステージ | ステータス | スコア | 主な変更点 |
|------|---------|----------|--------|-----------|
| 2026-02-10 | Stage 1: 通常レビュー | conditionally_approved | 4/5 | MF-001: ApiHandler型のジェネリクス化、MF-002: 統合テスト修正方針明記、SF-001-005: 各種改善反映 |
| 2026-02-10 | Stage 2: 整合性レビュー | conditionally_approved | 4/5 | S2-MF-001: escapeRegExp()既存関数再利用に方針変更、S2-MF-002: params混在対応方針（URL pathname使用）明記、S2-SF-001-005: 記述正確化・テスト戦略補強・Markdown構造修正 |
| 2026-02-10 | Stage 3: 影響分析レビュー | conditionally_approved | 4/5 | S3-MF-001: Phase 1 withLogging()適用対象の明示的ファイルリスト追加、S3-MF-002: 統合テストのfs/promisesモック対象関数リスト詳細化、S3-SF-001-004: 循環依存分析・呼び出し元分析・JSDocセキュリティ注記保持・Phase 2コスト見積もり |
| 2026-02-10 | Stage 4: セキュリティレビュー | conditionally_approved | 4/5 | S4-MF-001: LogViewer.tsx dangerouslySetInnerHTML XSS対策（HTMLエスケープ追加）、S4-MF-002: 機密データパターン（トークン・パスワード・SSH鍵等）のサニタイズルール追加、S4-SF-001: withLogging() skipResponseBodyオプション追加、S4-SF-002: sanitizeパラメータデフォルト仕様の明文化、S4-SF-003: エラーレスポンスセキュリティ方針、S4-SF-004: ホスト名マスキング対象範囲の制約明記、OWASP Top 10チェックリスト追加 |

---

*Generated by design-policy command for Issue #11*
*Date: 2026-02-10*
*Last updated: 2026-02-10 (Stage 4 security review findings applied)*
