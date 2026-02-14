# 設計方針書: Issue #270 - update-checkルート静的プリレンダリング修正

## 1. 概要

### 問題
`/api/app/update-check` ルートがNext.jsビルド時に静的にプリレンダリングされ、実行時にGitHub Releases APIが呼び出されない。ビルド時の結果がハードコードされ、新バージョンリリース後も `hasUpdate: false` が返り続ける。

### 根本原因
Next.js App Routerのルートハンドラに `export const dynamic = 'force-dynamic'` が未設定のため、ビルド時に静的ルート（`○` Static）として判定されている。

### 修正方針
対象ファイルに `export const dynamic = 'force-dynamic'` を追加し、動的ルート（`ƒ` Dynamic）として判定させる。

## 2. アーキテクチャ設計

### 変更対象

| ファイル | 変更内容 |
|---------|---------|
| `src/app/api/app/update-check/route.ts` | `export const dynamic = 'force-dynamic'` 追加 |

### 影響範囲

- **直接影響**: `/api/app/update-check` APIエンドポイントのみ
- **間接影響**: なし（他のルート・コンポーネントに影響しない）
- **既存テスト**: 影響なし（テストはモック経由でGET関数を直接呼び出し）

## 3. 技術選定

### `export const dynamic = 'force-dynamic'` 選定理由

| 代替案 | 評価 | 理由 |
|--------|------|------|
| `export const dynamic = 'force-dynamic'` | **採用** | Next.js公式の動的ルート指定方法。プロジェクト内で5箇所の先行事例あり |
| `export const revalidate = 0` | 不採用 | セマンティクスが異なる（ISR無効化であり動的ルート指定ではない） |
| `cookies()` / `headers()` 利用 | 不採用 | 副作用目的のダミー呼び出しは不適切 |
| `unstable_noStore()` | 不採用 | 非安定API、将来の互換性リスク |

### プロジェクト内先行事例

以下のルートで同一パターンが使用されている：

- `src/app/api/worktrees/route.ts`
- `src/app/api/external-apps/route.ts`
- `src/app/api/external-apps/[id]/route.ts`
- `src/app/api/external-apps/[id]/health/route.ts`
- `src/app/proxy/[...path]/route.ts`

## 4. 設計パターン

### 配置位置

既存プロジェクトの慣例に従い、import文の直後・型定義の前に配置する。

```typescript
import { NextResponse } from 'next/server';
import { checkForUpdate, getCurrentVersion } from '@/lib/version-checker';
import { isGlobalInstall } from '@/cli/utils/install-context';
import type { UpdateCheckResult } from '@/lib/version-checker';

// [FIX-270] Force dynamic route to prevent static prerendering at build time.
// Without this, Next.js caches the GitHub API response during `npm run build`
// and the route handler is never called at runtime.
export const dynamic = 'force-dynamic';
```

## 5. セキュリティ設計

### 変更による影響

- **セキュリティリスク**: なし
- **既存のセキュリティ対策は維持**: Cache-Controlヘッダー（SEC-SF-003）、SSRF防止（SEC-001）、レスポンスバリデーション（SEC-SF-001）は全て変更なし
- **パフォーマンス影響**: リクエストごとにルートハンドラが実行されるが、`version-checker.ts` 内のglobalThisキャッシュ（1時間TTL）により、GitHub APIへの実際のリクエストは1時間に1回に制限される

## 6. テスト戦略

### 既存テスト
- `tests/unit/api/update-check.test.ts` - 既存テストは全てGET関数のモックテストのため、`dynamic` エクスポート追加による影響なし

### 追加テスト
- `dynamic` エクスポートが `'force-dynamic'` であることを検証する単体テストを追加

### ビルド検証
- `npm run build` 実行後、ビルド出力で `/api/app/update-check` が `ƒ` (Dynamic) と表示されることを確認

## 7. 受入条件

- [ ] ビルド出力で `/api/app/update-check` が `ƒ` (Dynamic) になっていること
- [ ] `.next/server/app/api/app/update-check.body` がビルド後に存在しないこと
- [ ] 既存テストが全てパスすること
- [ ] `npx tsc --noEmit` エラーなし
- [ ] `npm run lint` エラーなし

## 8. 設計上の決定事項とトレードオフ

| 決定事項 | 理由 | トレードオフ |
|---------|------|-------------|
| `force-dynamic` 使用 | Next.js公式API、プロジェクト内先行事例5件 | なし（このルートは動的であるべき） |
| コメントでIssue番号記載 | 変更理由のトレーサビリティ確保 | なし |
| 配置位置をimport後に統一 | プロジェクト内の慣例に準拠 | なし |

## 9. CLAUDE.md準拠確認

- **KISS原則**: 1行の追加で問題解決。最小限の変更
- **YAGNI原則**: 必要な変更のみ実施。過剰な対策なし
- **DRY原則**: プロジェクト内の既存パターンを再利用

## 10. レビュー履歴

| ステージ | レビュー種別 | 日付 | 結果 | スコア |
|---------|------------|------|------|--------|
| Stage 4 | セキュリティレビュー | 2026-02-14 | approved | 5/5 |

## 11. レビュー指摘事項サマリー

### Stage 4: セキュリティレビュー

| ID | 種別 | タイトル | 重要度 | 対応方針 |
|----|------|---------|--------|---------|
| SEC-S4-001 | Should Fix | publishedAt field passes through without validation | low | Issue #270スコープ外（Issue #257由来の既存問題） |
| SEC-S4-002 | Should Fix | latestVersion field passes through without sanitization after v-prefix stripping | low | Issue #270スコープ外（Issue #257由来の既存問題） |
| SEC-S4-C01 | Consider | Content-Type/X-Content-Type-Options headers | - | 将来改善候補 |
| SEC-S4-C02 | Consider | dynamic exportのテスト追加 | - | セクション6で既に計画済み |

**Must Fix: 0件 / Should Fix: 2件（スコープ外） / Consider: 2件**

## 12. 既存の潜在的セキュリティ問題

以下の指摘はStage 4セキュリティレビューで検出されたが、Issue #270で導入された問題ではなく、Issue #257（バージョンアップ通知機能）で導入された既存の問題である。Issue #270の修正範囲（`export const dynamic = 'force-dynamic'` の1行追加）には含まれないため、別途改善を推奨する。

### SEC-S4-001: publishedAt フィールドのバリデーション欠如

- **OWASP分類**: A03:2021 - Injection
- **重要度**: low
- **導入Issue**: Issue #257
- **対象ファイル**: `src/lib/version-checker.ts`
- **問題の詳細**: GitHub APIレスポンスの `published_at` フィールドがフォーマットバリデーションやサニタイズなしにクライアントへ渡されている。ReactのテキストコンテンツはXSSに対して自動エスケープされるが、不正な文字列がDate解析時に予期しないクライアント側の動作を引き起こす可能性がある。
- **推奨対応**: `tag_name`、`html_url`、`name` と同様に、`published_at` に対してISO 8601日付フォーマットのバリデーションを追加する。
- **リスク評価**: ReactのXSS自動防御があるため実質的なリスクは非常に低い。防御的プログラミングとしての改善。

### SEC-S4-002: latestVersion フィールドのサニタイズ欠如

- **OWASP分類**: A03:2021 - Injection
- **重要度**: low
- **導入Issue**: Issue #257
- **対象ファイル**: `src/lib/version-checker.ts` (L205付近)
- **問題の詳細**: `latestVersion` は `data.tag_name.replace(/^v/, '')` で生成され、レスポンスに含まれる。`tag_name` は `isNewerVersion()` 内で `SEMVER_PATTERN` による検証が行われるが、`latestVersion` 自体はレスポンスに含める前の明示的なバリデーションがない。
- **推奨対応**: `latestVersion` をレスポンスに含める前に `SEMVER_PATTERN` による明示的なバリデーションを追加する。semverに一致しない場合は安全なフォールバック値を設定する。
- **リスク評価**: `isNewerVersion()` で間接的にsemverバリデーションされるため実質的なリスクは非常に低い。明示的なバリデーションの追加による防御の多層化。

### 将来改善候補（Consider）

#### SEC-S4-C01: Content-Type / X-Content-Type-Options ヘッダーの明示設定

`NextResponse.json()` がContent-Typeを自動設定するが、`X-Content-Type-Options: nosniff` を明示的に設定することでMIME type confusion攻撃への防御を多層化できる。

#### SEC-S4-C02: dynamic exportのテスト追加

Issue #270の核心である `export const dynamic = 'force-dynamic'` に対するリグレッション防止テストの追加。本設計書のセクション6「テスト戦略」で既に計画済み。

### 対応の優先度

これらの既存問題は全てリスクが「low」であり、即時対応は不要である。以下の方針を推奨する：

1. **Issue #270では対応しない** - スコープ外であり、最小変更原則（KISS）に反する
2. **別Issueとして起票を推奨** - `version-checker.ts` のバリデーション強化として、SEC-S4-001とSEC-S4-002をまとめて対応する
3. **Consider項目は任意** - SEC-S4-C01はヘッダー追加、SEC-S4-C02は既に計画済み
