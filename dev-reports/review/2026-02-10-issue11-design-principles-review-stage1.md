# Architecture Review: Issue #11 - Design Principles (Stage 1)

**Issue**: #11 - バグ原因調査目的のデータ収集機能強化
**Focus Area**: 設計原則 (Design Principles)
**Stage**: 1 - 通常レビュー
**Date**: 2026-02-10
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

Issue #11 の設計方針書は、ログエクスポートサニタイズ機能と API ロギング機能の2つを主要スコープとする。全体として設計品質は高く、既存アーキテクチャとの整合性が十分に考慮されている。SOLID 原則への意識的な配慮が見られ、セクション8でトレードオフが明示されている点は特に評価できる。

ただし、2件の必須改善項目（withLogging() の型定義の不整合、統合テストの修正方針の欠如）と、5件の推奨改善項目が検出された。特に、デザインパターンの命名が実態と乖離している箇所が複数あり、開発者の理解を妨げるリスクがある。

---

## Detailed Findings

### SOLID Principles Compliance

#### [PASS] Single Responsibility Principle (SRP)

新規モジュールの責務分離は適切である。

| モジュール | 責務 | 評価 |
|-----------|------|------|
| `log-export-sanitizer.ts` | エクスポート用パスサニタイズ | 明確に単一責務 |
| `api-logger.ts` | API ロギングデコレーター | 明確に単一責務 |
| 既存 `sanitize.ts` | XSS 防止 | 変更なし、責務分離が維持される |
| 既存 `logger.ts` | 構造化ログ出力 | 変更なし |

**注意点 (SF-001)**: `GET /api/worktrees/:id/logs/:filename` ハンドラーに `?sanitize=true` を追加することで、通常取得とサニタイズ取得の2つの責務が1つのハンドラーに混在する。設計書 D-2 でトレードオフとして認識されているが、ハンドラー内の条件分岐を最小限に留める設計指針の明記が望ましい。

#### [PASS with Note] Open/Closed Principle (OCP)

withLogging() の Decorator パターンは OCP に準拠しており、既存ハンドラーを変更せずにロギング機能を追加できる。

```typescript
// 既存ハンドラーを変更せずに機能追加（OCP準拠）
export const GET = withLogging(existingHandler, { logLevel: 'debug' });
```

SanitizeRule 配列も新しいルール追加が容易であり、拡張に対して開いている。

#### [CAUTION] Liskov Substitution Principle (LSP) - MF-001

**withLogging() の ApiHandler 型定義に問題がある。**

設計書で定義された型:
```typescript
type ApiHandler = (
  request: NextRequest,
  context: { params: Record<string, string> }
) => Promise<NextResponse>;
```

既存の route.ts ハンドラーの実際の型:
```typescript
// logs/[filename]/route.ts
async function GET(
  request: NextRequest,
  { params }: { params: { id: string; filename: string } }
)

// messages/route.ts
async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
)
```

`Record<string, string>` は `{ id: string; filename: string }` のスーパータイプではあるが、withLogging() でラップした場合にハンドラー内で `params.id` にアクセスする際の型安全性が失われる。LSP に基づき、ラップ後のハンドラーは元のハンドラーと置換可能でなければならないが、型情報が失われることで実質的な互換性に問題が生じる。

#### [PASS] Interface Segregation Principle (ISP)

サニタイズ機能（エクスポート用 / XSS用）が別モジュールに分離されており、クライアントは自分が必要とするインターフェースのみに依存する設計になっている。WithLoggingOptions のインターフェースも最小限（logLevel, maxResponseBodyLength）に抑えられている。

#### [PASS] Dependency Inversion Principle (DIP)

withLogging() は `createLogger()` のインターフェースにのみ依存し、ログ出力の具体実装（console.log / ファイル等）には依存しない。log-export-sanitizer.ts は `getEnv()` インターフェースに依存する設計で、環境変数の取得方法の詳細から切り離されている。

---

### KISS / YAGNI / DRY Compliance

#### KISS (Keep It Simple, Stupid)

| 項目 | 評価 | 詳細 |
|------|------|------|
| サニタイズルール | PASS | 正規表現ベースの文字列置換はシンプルで理解しやすい |
| API拡張方式 | PASS | 既存エンドポイントへのクエリパラメータ追加は最小変更 |
| デザインパターン命名 | CAUTION | Strategy / Facade の命名が実態と乖離（SF-002, C-002） |

**SF-002 詳細**: セクション3-2で SanitizeRule の配列処理を「Strategy パターン」と称しているが、Strategy パターンは「アルゴリズムの実行時切り替え」を本質とする。現在の設計は固定的なルール配列を順次適用するものであり、切り替えの概念がない。「ルールベースパターン」が実態に即した表現である。

**C-002 詳細**: セクション3-3で api-client.ts のオプション引数追加を「Facade パターン」と称しているが、既存の api-client.ts は単一のバックエンドに対する薄いラッパーであり、複数のサブシステムを隠蔽する Facade の本質と異なる。

#### YAGNI (You Aren't Gonna Need It)

| 項目 | 評価 | 詳細 |
|------|------|------|
| Phase 2 の全 route.ts 適用 | CAUTION (SF-003) | 48ハンドラーへの一括適用は Issue #11 のスコープ超過の可能性 |
| ユーザー名個別マスキング | CONSIDER (C-003) | HOME マスキングで十分なケースが多い |
| ログ永続化のスコープ外判定 | PASS | 適切にスコープを限定している |

#### DRY (Don't Repeat Yourself)

| 項目 | 評価 | 詳細 |
|------|------|------|
| LOG_DIR 定義 | CAUTION (SF-004) | route.ts と log-manager.ts で重複定義 |
| escapeRegex | CAUTION (SF-005) | 定義場所が不明、LogViewer.tsx にインラインの同等処理あり |
| CLI tool ID リスト | PASS | `['claude', 'codex', 'gemini']` は複数箇所で使用されるが、これは定数として既存管理されている |

**SF-004 詳細**: 以下の2ファイルで同一ロジックが重複している。

`src/app/api/worktrees/[id]/logs/[filename]/route.ts` (L14):
```typescript
const LOG_DIR = getEnvByKey('CM_LOG_DIR') || path.join(process.cwd(), 'data', 'logs');
```

`src/lib/log-manager.ts` (L14):
```typescript
const LOG_DIR = getEnvByKey('CM_LOG_DIR') || path.join(process.cwd(), 'data', 'logs');
```

サニタイズ機能追加時に LOG_DIR を参照する箇所がさらに増える可能性があり、一元化が望ましい。

---

### Design Pattern Appropriateness

| パターン | 適用箇所 | 適切性 | コメント |
|---------|---------|--------|---------|
| Decorator | withLogging() | 適切 | 既存ハンドラーを変更せずに機能を追加する用途に合致 |
| Strategy | SanitizeRule | 不適切（命名） | 実態はルール配列の逐次適用。Strategy パターンではない |
| Facade | api-client.ts拡張 | 不適切（命名） | 単なるAPIクライアントのオプション追加。Facade ではない |
| Singleton | (既存) CLIToolManager | 参考 | 既存パターンとの一貫性は維持されている |

---

### Architectural Consistency

既存アーキテクチャとの整合性は概ね良好。

| 観点 | 評価 | 詳細 |
|------|------|------|
| レイヤー構成 | PASS | プレゼンテーション / API / ビジネスロジック / インフラの4層に沿っている |
| モジュール配置 | PASS | `src/lib/` への新規モジュール追加は既存パターンに従っている |
| 命名規則 | PASS | `log-export-sanitizer.ts`, `api-logger.ts` は既存の命名規則と一貫性がある |
| テスト構成 | PASS | `tests/unit/`, `tests/integration/` の既存ディレクトリ構成に従っている |
| 既存モジュールへの影響 | PASS | logger.ts, sanitize.ts, log-manager.ts への変更なし方針は適切 |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | withLogging() 型定義が既存ハンドラーと不整合 | Medium | High | P1 |
| 技術的リスク | 統合テストの修正方針が不明確 | Medium | High | P1 |
| 技術的リスク | Phase 2 のスコープ肥大化 | Low | Medium | P2 |
| セキュリティ | サニタイズ漏れ（新規パス形式の見落とし） | Medium | Low | P2 |
| 運用リスク | パターン名の誤用による開発者の混乱 | Low | Medium | P3 |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix)

#### MF-001: withLogging() の ApiHandler 型をジェネリクス化

既存ハンドラーの型安全性を維持するため、ApiHandler 型にジェネリクスパラメータを追加する。

```typescript
type ApiHandler<P extends Record<string, string> = Record<string, string>> = (
  request: NextRequest,
  context: { params: P }
) => Promise<NextResponse>;

export function withLogging<P extends Record<string, string>>(
  handler: ApiHandler<P>,
  options?: WithLoggingOptions
): ApiHandler<P> {
  // ...
}
```

#### MF-002: 統合テスト修正方針の明記

設計書セクション10のT1に以下の具体的方針を追記:
- `fs` モックを `fs/promises` モックに変更
- ファイル拡張子を `.jsonl` から `.md` に統一
- worktreeId プレフィクス検証テストの追加
- CLI tool サブディレクトリ構造のモック追加

### 推奨改善項目 (Should Fix)

- **SF-001**: route.ts 内のサニタイズ呼び出しを1行の条件分岐に留める設計指針を明記
- **SF-002**: セクション3-2のパターン名を「ルールベースパターン」に修正
- **SF-003**: Phase 2 (T8) をスコープ外として別 Issue 化する方針を明記
- **SF-004**: LOG_DIR を log-manager.ts に一元化し、route.ts は log-manager.ts 経由でアクセスする方針を記載
- **SF-005**: escapeRegex() の定義場所を src/lib/utils.ts と明記

### 検討事項 (Consider)

- **C-001**: 将来の拡張として CM_API_LOGGING 環境変数による制御を検討
- **C-002**: セクション3-3のパターン名を「APIクライアント拡張」に修正
- **C-003**: ユーザー名個別マスキングルールの必要性を再検討

---

## Approval Status

**Conditionally Approved** - 必須改善項目 2件の対応後、実装を開始可能。

特に MF-001（型定義の不整合）は実装段階でコンパイルエラーを引き起こす可能性があるため、設計修正を先行させることを推奨する。MF-002（テスト修正方針）は実装の第一ステップ（T1）に直接関わるため、方針の明確化が不可欠。

---

*Reviewed by: architecture-review-agent*
*Review type: Stage 1 Design Principles Review*
