# 設計方針書: Issue #159 - infoタブにてアプリバージョン表示

## 1. 概要

### 目的
Worktree詳細画面のinfoタブ（デスクトップ: InfoModal、モバイル: MobileInfoContent）にCommandMateのアプリバージョンを表示する。

### 背景
現在、アプリのバージョンを確認する手段がCLI（`commandmate --version`）のみであり、WebUI上で確認できない。ユーザーがバグ報告やトラブルシューティング時にバージョンを確認しやすくする。

### スコープ
- `next.config.js` に `NEXT_PUBLIC_APP_VERSION` 環境変数を追加
- InfoModal（デスクトップ）にバージョン表示セクション追加
- MobileInfoContent（モバイル）にバージョン表示セクション追加

## 2. アーキテクチャ設計

### システム構成

```mermaid
graph LR
    PJ[package.json<br/>version: "0.1.12"] -->|ビルド時読込| NC[next.config.js<br/>NEXT_PUBLIC_APP_VERSION]
    NC -->|環境変数埋込| IM[InfoModal<br/>Desktop]
    NC -->|環境変数埋込| MIC[MobileInfoContent<br/>Mobile]
```

### 設計方針

**ビルド時環境変数方式**を採用する。

| 方式 | メリット | デメリット | 採否 |
|------|---------|-----------|------|
| ビルド時環境変数 | APIコール不要、DB変更不要、シンプル | ビルド時に値が固定される | **採用** |
| APIエンドポイント | 動的取得可能 | 不要な複雑性、サーバーリクエスト必要 | 不採用 |
| Server Component props | SSR時取得 | コンポーネント構造の大幅変更が必要 | 不採用 |

**理由**: バージョンはビルドごとに確定する値であり、動的取得の必要性がない。YAGNI原則・KISS原則に基づき、最もシンプルな方式を選択。

## 3. 技術選定

| カテゴリ | 選定技術 | 選定理由 |
|---------|---------|---------|
| バージョン取得 | `require('./package.json').version` | Next.js標準のビルド時環境変数 |
| 環境変数公開 | `NEXT_PUBLIC_APP_VERSION` | クライアントサイドアクセス可能 |
| UI表示 | `process.env.NEXT_PUBLIC_APP_VERSION` | Next.js標準API |

## 4. 実装設計

### 4-1. next.config.js 変更

```javascript
// Build-time version from package.json (not user-configurable, distinct from .env variables)
const packageJson = require('./package.json');

const nextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
  // ... existing config
}
```

**影響範囲**: ビルド時に `package.json` の `version` フィールドが `NEXT_PUBLIC_APP_VERSION` としてバンドルに埋め込まれる。既存の設定（reactStrictMode, eslint, experimental, headers）には影響しない。

**注記**: `.env` ファイルで設定されるユーザー設定値（`NEXT_PUBLIC_CM_AUTH_TOKEN` 等）とは異なり、ビルド時に `package.json` から自動導出される値のため `next.config.js` の `env` ブロックが適切な配置場所。

### 4-2. バージョン表示定数（DRY対応）

**変更箇所**: `src/components/worktree/WorktreeDetailRefactored.tsx` のモジュールレベル（コンポーネント外）

バージョン表示文字列をモジュールレベル定数として定義し、InfoModal・MobileInfoContent の両方から参照する。

```tsx
/** Build-time app version from package.json via next.config.js */
const APP_VERSION_DISPLAY = process.env.NEXT_PUBLIC_APP_VERSION
  ? `v${process.env.NEXT_PUBLIC_APP_VERSION}`
  : '-';
```

**理由**: InfoModal とMobileInfoContent でフォーマットロジック（`v` プレフィックス付与、フォールバック `-`）を重複させない（DRY原則）。

### 4-3. InfoModal（デスクトップ）変更

**変更箇所**: `src/components/worktree/WorktreeDetailRefactored.tsx` の InfoModal コンポーネント（Last Updated セクションの後）

**追加セクション**:
```tsx
{/* Version */}
<div className="bg-gray-50 rounded-lg p-4">
  <h2 className="text-sm font-medium text-gray-500 mb-1">Version</h2>
  <p className="text-sm text-gray-700">{APP_VERSION_DISPLAY}</p>
</div>
```

**スタイル**: 既存の情報項目と同一の `bg-gray-50 rounded-lg p-4` カードスタイル、ラベルは既存パターンに従い `<h2>` タグ + `mb-1` クラスを使用。

### 4-4. MobileInfoContent（モバイル）変更

**変更箇所**: `src/components/worktree/WorktreeDetailRefactored.tsx` の MobileInfoContent コンポーネント（Last Updated セクションの後）

**追加セクション**:
```tsx
{/* Version */}
<div className="bg-white rounded-lg border border-gray-200 p-4">
  <h2 className="text-sm font-medium text-gray-500 mb-1">Version</h2>
  <p className="text-sm text-gray-700">{APP_VERSION_DISPLAY}</p>
</div>
```

**スタイル**: モバイル版の既存項目と同一の `bg-white rounded-lg border border-gray-200 p-4` カードスタイル、ラベルは既存パターンに従い `<h2>` タグ + `mb-1` クラスを使用。

### 4-5. フォールバック処理

環境変数が未設定の場合（開発環境での直接起動等）に `-` を表示する。エラーを発生させず、UIの整合性を維持する。フォールバックロジックは `APP_VERSION_DISPLAY` 定数に集約される。

## 5. データモデル設計

**変更なし**。DBスキーマ変更、マイグレーション不要。

## 6. API設計

**変更なし**。新規APIエンドポイント不要。

## 7. セキュリティ設計

### 情報漏洩リスク
- **バージョン情報の公開**: `NEXT_PUBLIC_` プレフィックスによりクライアントバンドルに埋め込まれる
- **リスク評価**: 低。`package.json` のバージョンはnpmレジストリで公開済み情報。OSSプロジェクトのため秘匿性なし
- **緩和策**: バージョン番号のみ公開。ビルドハッシュやコミットSHA等は含めない

### XSS対策
- `process.env.NEXT_PUBLIC_APP_VERSION` はビルド時に文字列リテラルとして埋め込まれる
- React JSX内でのレンダリングにより自動エスケープが適用される
- ユーザー入力値ではないためXSSリスクは実質的にない

## 8. パフォーマンス設計

- **影響**: なし。ビルド時に静的文字列として埋め込まれるため、ランタイムコストはゼロ
- **バンドルサイズ**: バージョン文字列（数バイト）のみの増加。無視可能

## 9. テスト方針

### ユニットテスト

| テストケース | 対象 | 検証内容 |
|-------------|------|---------|
| バージョン表示（値あり） | InfoModal | `NEXT_PUBLIC_APP_VERSION` 設定時に `v{version}` が表示される |
| バージョン表示（値あり） | MobileInfoContent | 同上 |
| バージョン未設定フォールバック | InfoModal | 環境変数未設定時に `-` が表示される |
| バージョン未設定フォールバック | MobileInfoContent | 同上 |
| 空文字列フォールバック | 共通 | 環境変数が空文字列の場合に `-` が表示される |
| プレリリース版表示 | 共通 | `1.0.0-beta.1` のような値で `v1.0.0-beta.1` が表示される |

### テスト実装方針

**モジュールレベル定数 `APP_VERSION_DISPLAY` のテスト可能性**:

`APP_VERSION_DISPLAY` はモジュール読み込み時に評価されるため、テスト内で `process.env.NEXT_PUBLIC_APP_VERSION` を変更しても反映されない。以下のいずれかの方式でテストする：

**方式A（推奨）: `vi.resetModules()` + 動的import**
```tsx
beforeEach(() => {
  vi.resetModules();
});

it('displays version when set', async () => {
  process.env.NEXT_PUBLIC_APP_VERSION = '0.1.12';
  const { WorktreeDetailRefactored } = await import(
    '@/components/worktree/WorktreeDetailRefactored'
  );
  // render and assert
});
```

**方式B: インラインprocess.env参照に変更**

テスト容易性のため、モジュールレベル定数ではなくJSX内でインライン参照する。ただしDRY原則とのトレードオフがある。

**採用**: 方式A（DRY原則を維持しつつテスト可能性を確保）

- 既存の `tests/unit/components/WorktreeDetailRefactored.test.tsx` に新しい `describe` ブロックとして追加
- InfoModal・MobileInfoContent の両方のレンダリングテストを含める

## 10. 影響範囲

| カテゴリ | ファイル | 変更内容 |
|---------|---------|---------|
| 設定 | `next.config.js` | `env.NEXT_PUBLIC_APP_VERSION` 追加 |
| UIコンポーネント | `src/components/worktree/WorktreeDetailRefactored.tsx` | InfoModal・MobileInfoContent にバージョン表示追加 |
| テスト | `tests/unit/components/WorktreeDetailRefactored.test.tsx` | バージョン表示テスト追加 |

- **DBマイグレーション**: 不要
- **API変更**: 不要
- **破壊的変更**: なし
- **他コンポーネントへの影響**: なし

## 11. 設計上の決定事項とトレードオフ

| 決定事項 | 理由 | トレードオフ |
|---------|------|-------------|
| ビルド時環境変数方式 | シンプル、API不要 | リビルドなしではバージョン更新不可（許容範囲） |
| `v` プレフィックス付き表示 | semverの慣習的表記（`v0.1.12`）、ユーザーにバージョンであることが明確 | CLIの`commander`出力（`0.1.12`）とは異なるがUI表示としては適切 |
| フォールバック `-` 表示 | UIの整合性維持 | 環境変数未設定時にバージョン不明（開発環境のみ） |
| Last Updated の後に配置 | 情報の重要度順で自然な位置 | なし |

## 12. 実装順序

1. `next.config.js` に環境変数設定を追加
2. `WorktreeDetailRefactored.tsx` にモジュールレベル定数 `APP_VERSION_DISPLAY` を追加
3. InfoModal にバージョン表示セクション追加
4. MobileInfoContent にバージョン表示セクション追加
5. ユニットテスト作成
6. ビルド・リント・テスト検証

## 13. フォローアップ（技術的負債）

> 以下は本Issue（#159）のスコープ外だが、Stage 1 通常レビューで指摘された既存の技術的負債として記録する。

### 13-1. WorktreeDetailRefactored.tsx のファイル分割（SRP）

`WorktreeDetailRefactored.tsx` は1939行あり、`DesktopHeader`, `InfoModal`, `LoadingIndicator`, `ErrorDisplay`, `MobileInfoContent`, `MobileContent`, 及びメインコンポーネントを含む。SRP（単一責任原則）の観点から、以下の分割を推奨する：

- `src/components/worktree/InfoModal.tsx` - デスクトップ情報モーダル
- `src/components/worktree/MobileInfoContent.tsx` - モバイル情報タブ

### 13-2. Description編集ロジックの共通化（DRY）

InfoModal と MobileInfoContent の description 編集ロジック（state管理、handleSaveDescription、handleCancelDescription）は約40行以上の重複がある。`useDescriptionEditor` カスタムフックへの抽出を推奨する。
