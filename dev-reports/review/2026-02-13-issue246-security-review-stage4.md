# Security Architecture Review - Issue #246

## Executive Summary

**Issue**: #246 - スマホにてバックグラウンド復帰時のError loading worktreeエラー自動回復
**Review Stage**: Stage 4 (セキュリティレビュー)
**Status**: Approved
**Score**: 5/5
**Reviewer**: Architecture Review Agent
**Date**: 2026-02-13

Issue #246の設計方針書に対するセキュリティレビューを実施した。本変更はクライアントサイドの`visibilitychange`イベントリスナー追加と既存APIのGET呼び出しのみで構成されており、新たなセキュリティリスクの導入は確認されなかった。既存のセキュリティ保護機構（セッション名バリデーション、SQLパラメータバインド、CSPヘッダー等）が引き続き有効であることを確認した。

---

## 1. OWASP Top 10 Compliance Checklist

### A01:2021 - Broken Access Control (アクセス制御の不備)

**評価**: PASS

- 本変更では新規APIエンドポイントを追加しない
- visibilitychange復帰時に呼び出されるAPIは全て既存のGETエンドポイント
  - `GET /api/worktrees/:id`
  - `GET /api/worktrees/:id/current-output`
  - `GET /api/worktrees/:id/messages`
  - `GET /api/worktrees`
- 既存の権限モデル（ローカル開発ツールとして同一ホスト内アクセス）は変更されない
- `worktreeId`はURL構築にのみ使用され、`fetch(/api/worktrees/${worktreeId})`の形式でNext.jsルーティングを経由する

**コード確認箇所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-246/src/components/worktree/WorktreeDetailRefactored.tsx` L984-998（fetchWorktree）

### A02:2021 - Cryptographic Failures (暗号化の失敗)

**評価**: NOT APPLICABLE

- 暗号化処理の変更なし
- 機密データの新規取り扱いなし
- WebSocket接続はwss:プロトコルをサポート（`next.config.js`のCSP connect-src設定で確認）

### A03:2021 - Injection (インジェクション)

**評価**: PASS

本変更で新たなインジェクションベクトルは導入されない。以下の既存保護機構を確認した。

**SQLインジェクション防止**:
- `better-sqlite3`のパラメータバインド（`db.prepare()` + `.get(id)`）を使用
- `getWorktreeById(db, params.id)` は直接的なSQL文字列結合を行わない

**コード確認箇所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-246/src/lib/db.ts` L288-303

```typescript
export function getWorktreeById(
  db: Database.Database,
  id: string
): Worktree | null {
  const stmt = db.prepare(`SELECT ... WHERE w.id = ?`);
  const row = stmt.get(id) as {...};
```

**コマンドインジェクション防止**:
- tmuxセッション名は`validateSessionName()`により`/^[a-zA-Z0-9_-]+$/`パターンで検証
- `worktreeId`はセッション名構築時にバリデーション済み（`mcbd-${this.id}-${worktreeId}`）

**コード確認箇所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-246/src/lib/cli-tools/validation.ts` L20-38

**XSSインジェクション防止**:
- visibilitychangeイベントハンドラはユーザー入力を一切受け取らない
- ブラウザネイティブAPIのイベントリスナーのみ
- ErrorDisplayコンポーネントでのエラーメッセージ表示はReact JSXのテキスト補間（`{message}`）を使用しており、自動エスケープされる

**コード確認箇所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-246/src/components/worktree/WorktreeDetailRefactored.tsx` L547-586

### A04:2021 - Insecure Design (安全でない設計)

**評価**: PASS

設計上のセキュリティ考慮が適切に行われている。

- **timestampガード**: visibilitychange連続発火を5秒間隔に制限し、API過負荷を防止
- **冪等性**: 全APIがGETリクエストで冪等。同時発火によるデータ破損リスクなし
- **DRY原則**: handleRetry()の直接呼び出しにより、セキュリティに関わる処理フローの重複を排除
- **最小変更原則**: 既存のAPIとデータフローをそのまま再利用し、新たな攻撃面を追加しない

### A05:2021 - Security Misconfiguration (セキュリティの設定ミス)

**評価**: PASS

既存のセキュリティヘッダーが全ルートに適用されている。

**コード確認箇所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-246/next.config.js` L23-71

| ヘッダー | 値 | 評価 |
|---------|-----|------|
| X-Frame-Options | DENY | 適切（クリックジャッキング防止） |
| X-Content-Type-Options | nosniff | 適切（MIMEスニッフィング防止） |
| X-XSS-Protection | 1; mode=block | 適切（ブラウザXSSフィルター有効化） |
| Referrer-Policy | strict-origin-when-cross-origin | 適切 |
| Permissions-Policy | camera=(), microphone=(), geolocation=() | 適切 |
| Content-Security-Policy | 複合設定 | 下記参照 |

**CSP詳細評価**:
- `frame-ancestors 'none'`: 適切（iframe埋め込み防止）
- `connect-src 'self' ws: wss:`: 適切（WebSocket接続許可）
- `script-src 'self' 'unsafe-inline' 'unsafe-eval'`: Next.js要件として許容されるが、将来的にnonceベース移行を検討（SEC-SF-002）
- `style-src 'self' 'unsafe-inline'`: Tailwind CSS要件として許容

本変更はセキュリティヘッダーに影響を与えない。

### A06:2021 - Vulnerable and Outdated Components (脆弱で古いコンポーネント)

**評価**: NOT APPLICABLE

- 新たな依存パッケージの追加なし
- `document.visibilitychange`はW3C Page Visibility APIのブラウザネイティブ機能
- 追加のnpmパッケージは不要

### A07:2021 - Identification and Authentication Failures (識別と認証の失敗)

**評価**: NOT APPLICABLE

- CommandMateはローカル開発ツールであり、認証機構は現在のアーキテクチャスコープ外
- visibilitychangeハンドラは認証フローに影響しない
- 既存APIへのリクエストは全てlocalhostからのアクセスを前提

### A08:2021 - Software and Data Integrity Failures (ソフトウェアとデータの整合性の不備)

**評価**: PASS

- 全APIがGETリクエストで冪等。データの変更・作成・削除操作は行わない
- visibilitychangeハンドラとsetIntervalの同時発火時でもデータ破損リスクなし
- handleRetry()経由のfetchWorktree()がsetState()のみを使用し、Reactの状態更新が整合性を保証

### A09:2021 - Security Logging and Monitoring Failures (セキュリティログとモニタリングの不備)

**評価**: PASS

- 既存のAPI層でconsole.errorによるエラーログが機能
- visibilitychangeイベントのthrottleスキップ時のログが設計に含まれている（Section 4-1: ガード不通過時「スキップ（ログのみ）」）
- セキュリティイベントロガー（`src/cli/utils/security-logger.ts`）が既存のCLI側で利用可能

### A10:2021 - Server-Side Request Forgery (サーバーサイドリクエストフォージェリ)

**評価**: NOT APPLICABLE

- visibilitychangeハンドラから外部URLへのリクエストは行わない
- 全てのAPIエンドポイントは自サーバー内（`/api/worktrees/...`）
- ユーザー制御のURL入力は存在しない

---

## 2. セキュリティ重点分析

### 2-1. 入力バリデーションとサニタイゼーション

**評価**: リスクなし

visibilitychangeイベントハンドラはユーザー入力を一切受け取らない。

```typescript
// 設計書 Section 4-1 の擬似コード
const handleVisibilityChange = useCallback(() => {
  if (document.visibilityState !== 'visible') return;
  // ... timestampガード
  handleRetry(); // 既存関数の直接呼び出し、外部入力なし
}, [handleRetry]);
```

- `document.visibilityState`はブラウザが管理するread-onlyプロパティ
- `Date.now()`はブラウザのシステムクロックから取得
- `handleRetry()`は引数なしの関数呼び出し
- 新たなURLパラメータ、リクエストボディ、ユーザー入力の処理は追加されない

### 2-2. 認証と認可

**評価**: 影響なし

- 既存のAPIアクセスパターンを変更なし
- visibilitychange復帰時に追加の認証トークンや認可チェックは不要
- ローカル開発ツールとして同一ホスト内アクセスの前提は維持

### 2-3. データ保護

**評価**: リスクなし

- 新たな機密データの取り扱いなし
- APIレスポンスは既存のworktreeメタデータ、メッセージ、ターミナル出力のみ
- localStorage/sessionStorageへの新規データ保存なし
- `lastRecoveryTimestampRef`はuseRef内のnumber型タイムスタンプのみ

### 2-4. API セキュリティ

**評価**: 適切

| 保護観点 | 現状 | Issue #246への影響 |
|---------|------|-------------------|
| CSRF防止 | GETリクエストのみ（状態変更なし） | 影響なし |
| レートリミット | timestampガード（5秒） | 適切に実装 |
| 入力検証 | 既存APIで実装済み（cliTool, limit等） | 新規入力なし |
| エラーハンドリング | try-catch + 適切なHTTPステータス | 既存パターン維持 |

APIエンドポイントの入力バリデーション確認結果。

`GET /api/worktrees/:id/messages`:
- `cliTool`パラメータ: ホワイトリスト検証（`['claude', 'codex', 'gemini']`）
- `limit`パラメータ: 数値範囲検証（1-100）

**コード確認箇所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-246/src/app/api/worktrees/[id]/messages/route.ts` L37-50

`GET /api/worktrees/:id/current-output`:
- `cliTool`パラメータ: `isCliTool()`関数によるホワイトリスト検証

**コード確認箇所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-246/src/app/api/worktrees/[id]/current-output/route.ts` L19-21

### 2-5. クライアントサイドセキュリティ

**評価**: 適切

- **XSS防止**: React JSXのテキスト補間による自動エスケープ。`dangerouslySetInnerHTML`の使用なし
- **イベントリスナー管理**: useEffect cleanup関数でremoveEventListenerを確実に実行（メモリリーク防止）
- **CSP準拠**: visibilitychangeはインラインイベントハンドラではなく、`addEventListener`による動的登録のため、CSPの`script-src`制約に影響されない

### 2-6. Denial of Service (DoS) 防御

**評価**: 適切

| 攻撃ベクトル | 防御機構 | 評価 |
|-------------|---------|------|
| visibilitychangeの連続発火 | timestampガード（5秒間隔） | 有効 |
| バックグラウンド/フォアグラウンド高速切替 | timestampガードで最大1回/5秒に制限 | 有効 |
| DevToolsからのイベント手動発火 | timestampガードで制限 | 有効 |
| visibilitychange + setInterval + WebSocket同時発火 | 最大7-9回の一時的集中、全てGET冪等 | 許容範囲 |

最悪ケースでも5秒あたり最大3回のAPIコール（fetchWorktree + fetchMessages + fetchCurrentOutput）に制限される。これは既存のポーリング頻度（ACTIVE_POLLING_INTERVAL_MS=2秒で3回/サイクル）と同等以下であり、サーバーへの追加負荷は最小限。

### 2-7. useAutoYes連動の安全性評価

**評価**: 適切

設計書Section 6のリスク分析が適切に行われている。

- `autoYesEnabled`はユーザー明示的ON時のみ有効
- バックグラウンド復帰時にプロンプトが検出された場合の自動応答は、ユーザーが有効化した機能の期待される動作
- `DUPLICATE_PREVENTION_WINDOW_MS`（3秒）による短時間重複防止
- サーバー側のauto-yesエンドポイントで独自のタイムスタンプ検証が機能
- 既に応答済みのプロンプトはサーバー側でクリア済み

**注記（IC-002）**: `lastServerResponseTimestamp`がクライアント側でuseAutoYesに渡されていない問題は、サーバー側の保護が機能しているため直接のセキュリティリスクではない。設計書で適切にスコープ外として記録されている。

---

## 3. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| セキュリティ | 新たな攻撃面の追加 | Low | Low | - (リスクなし) |
| セキュリティ | API過負荷 | Low | Low | P3 (timestampガードで制御済み) |
| セキュリティ | auto-yes誤発火 | Low | Low | P3 (既存保護機構で十分) |
| 技術的リスク | visibilitychange+setInterval競合 | Low | Medium | P3 (冪等性で安全) |
| 運用リスク | 既存CSPのunsafe-inline/unsafe-eval | Low | Low | P3 (将来検討) |

---

## 4. 改善推奨事項

### 4-1. 必須改善項目 (Must Fix)

なし。

### 4-2. 推奨改善項目 (Should Fix)

| ID | カテゴリ | タイトル | 説明 |
|----|---------|---------|------|
| SEC-SF-001 | 情報漏洩 | APIエラーレスポンスにおけるparams.id反映 | 既存APIの404レスポンスにparams.idをそのまま埋め込んでいる。React JSXの自動エスケープによりXSSリスクはないが、内部ID情報がクライアントに露出する。本Issue #246スコープ外。 |
| SEC-SF-002 | CSP設定 | unsafe-inline/unsafe-evalの将来的解消 | next.config.jsのCSPにおけるunsafe-inline/unsafe-evalについて、nonceベースCSPへの移行を将来的に検討。本Issue #246は影響なし。 |

### 4-3. 検討事項 (Consider)

| ID | カテゴリ | タイトル | 説明 |
|----|---------|---------|------|
| SEC-C-001 | DoS防御 | API側レートリミットの導入 | クライアント側のtimestampガードに加えて、API側での包括的なレートリミット導入を将来検討。現状はローカルツールのため優先度低。 |
| SEC-C-002 | auto-yes安全性 | lastServerResponseTimestampのクライアント側接続 | IC-002で記録された既存の不整合。サーバー側保護が機能しているため直接リスクなし。 |

---

## 5. 設計書セキュリティセクション（Section 8）の評価

設計書Section 8のセキュリティ設計を評価する。

| 設計書記載のリスク | 設計書の評価 | レビュー確認結果 |
|------------------|------------|----------------|
| API過負荷攻撃 | 低（timestampガードで抑制） | 妥当。5秒間隔のガードは既存ポーリング頻度と整合的 |
| XSS | なし（ブラウザネイティブAPI） | 妥当。ユーザー入力なし、React自動エスケープ |
| CSRF | なし（GETリクエストのみ） | 妥当。状態変更操作なし |
| 情報漏洩 | なし（既存API同一権限） | 妥当。新たなデータ露出なし |

**総評**: 設計書のセキュリティ設計セクションは適切かつ正確である。リスク評価は現実的であり、既存の保護機構を正しく理解した上での判断が示されている。

---

## 6. 承認判定

**Status: Approved (承認)**

本設計はセキュリティ観点から承認される。以下の理由による。

1. 新たなセキュリティリスクの導入がない
2. 既存のセキュリティ保護機構が引き続き有効
3. OWASP Top 10の全項目について適切な評価がなされている
4. timestampガードによるDoS防御が適切に設計されている
5. auto-yes連動の安全性が既存保護機構で十分にカバーされている
6. クライアントサイドの実装（visibilitychangeリスナー + handleRetry直接呼び出し）は最小限の変更で最大限の安全性を確保している

---

*Review completed: 2026-02-13*
*Reviewer: Architecture Review Agent*
*Design Policy: dev-reports/design/issue-246-visibility-recovery-design-policy.md*
