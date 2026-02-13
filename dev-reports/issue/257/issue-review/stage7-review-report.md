# Issue #257 レビューレポート

**レビュー日**: 2026-02-13
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目（Stage 7）
**前回レビュー**: Stage 3（影響範囲レビュー 1回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

## Stage 3 指摘事項の解消状況

| ID | 分類 | 指摘内容 | 状態 |
|----|------|---------|------|
| MF-1 | 影響ファイル | i18n対応が影響範囲に未記載 | **解消** |
| SF-1 | テスト範囲 | テスト計画の具体性不足 | **解消** |
| SF-2 | 依存関係 | api-client.tsの変更が影響範囲に未記載 | **解消** |
| SF-3 | ドキュメント更新 | CLAUDE.md/implementation-history.md更新が未記載 | **解消** |
| SF-4 | 影響ファイル | 開発モードキャッシュ挙動が未考慮 | **解消** |
| NTH-1 | テスト範囲 | E2Eテスト考慮 | **解消** |
| NTH-2 | 移行考慮 | 環境変数による無効化オプション | 未解消（スコープ外として妥当） |
| NTH-3 | 影響ファイル | 型定義ファイルの追加 | **解消** |

Stage 3のMust Fix 1件、Should Fix 4件、Nice to Have 2件が解消済み。NTH-2のみ未解消だが、スコープ外として合理的。

---

## Should Fix（推奨対応）

### SF-1: 新規i18n名前空間追加時のsrc/i18n.ts変更が影響範囲に含まれていない

**カテゴリ**: 影響ファイル
**場所**: ## i18n対応 > ### 対象ファイル

**問題**:
Issue本文のi18n対応セクションでは、翻訳ファイル（`locales/en/worktree.json` or `locales/en/update.json`）のみが影響ファイルとして記載されている。しかし、新規名前空間（`update.json`）を作成する方式を選択した場合、`src/i18n.ts` の名前空間読み込み処理への変更が必要になる。

**証拠**:
`src/i18n.ts` の行25-31で名前空間ごとにdynamic importが行われている:

```typescript
const [common, worktree, autoYes, error, prompt] = await Promise.all([
  import(`../locales/${locale}/common.json`),
  import(`../locales/${locale}/worktree.json`),
  import(`../locales/${locale}/autoYes.json`),
  import(`../locales/${locale}/error.json`),
  import(`../locales/${locale}/prompt.json`),
]);
```

行33-42のmessagesオブジェクトにも同じ5つのキーが設定されている:

```typescript
return {
  locale,
  messages: {
    common: common.default,
    worktree: worktree.default,
    autoYes: autoYes.default,
    error: error.default,
    prompt: prompt.default,
  },
};
```

新規名前空間（`update`）を追加する場合、この両箇所に `update` のimportとキーの追加が必要になる。

**推奨対応**:
影響範囲テーブルに `src/i18n.ts`（新規名前空間方式選択時）を追加するか、i18n対応セクション内で方式選択による影響差分を明記する。具体的には:
- 方式A: 既存の `worktree` 名前空間に `update.*` キーを追加 -> `src/i18n.ts` の変更不要
- 方式B: 新規 `update` 名前空間を作成 -> `src/i18n.ts` への import追加・messagesオブジェクトへのキー追加が必要

---

### SF-2: globalThisパターン適用時の技術的詳細が不足

**カテゴリ**: 影響ファイル
**場所**: ## GitHub APIレート制限対策 > ### 開発モードでのキャッシュ挙動

**問題**:
開発モード対策の3つ目の選択肢として「`globalThis`を使用してホットリロード耐性のあるキャッシュを実装する（`db-instance.ts`のシングルトンパターン参照）」と記載されているが、実際にはdb-instance.tsはglobalThisを使用していない（モジュールレベル変数のみ）。globalThisパターンを使用しているのは `src/lib/auto-yes-manager.ts` である。

**証拠**:
`src/lib/auto-yes-manager.ts` の行99-112:

```typescript
declare global {
  // eslint-disable-next-line no-var
  var __autoYesStates: Map<string, AutoYesState> | undefined;
  // eslint-disable-next-line no-var
  var __autoYesPollerStates: Map<string, AutoYesPollerState> | undefined;
}

const autoYesStates = globalThis.__autoYesStates ??
  (globalThis.__autoYesStates = new Map<string, AutoYesState>());
```

一方、`src/lib/db-instance.ts` は行14で `let dbInstance: Database.Database | null = null;` のモジュールレベル変数を使用しており、globalThisは使用していない。

**推奨対応**:
- 開発モード対策セクションのglobalThisの参照先を `auto-yes-manager.ts` に修正する
- globalThisパターン採用時に必要な `declare global` 型宣言と `eslint-disable-next-line no-var` の追記が必要であることを明記する

---

## Nice to Have（あれば良い）

### NTH-1: InfoModal/MobileInfoContent既存ハードコード文字列とi18n方針の整合性

**カテゴリ**: 影響ファイル
**場所**: ## i18n対応 セクション

**問題**:
現在のInfoModal/MobileInfoContent内には多数のハードコードされた英語文字列が存在する:

- `WorktreeDetailRefactored.tsx:509` - `"Version"` (h2タグ)
- `WorktreeDetailRefactored.tsx:432` - `"Description"` (h2タグ)
- `WorktreeDetailRefactored.tsx:439` - `"Edit"` (ボタン)
- `WorktreeDetailRefactored.tsx:459` - `"Saving..."` / `"Save"` (ボタン)
- `WorktreeDetailRefactored.tsx:467` - `"Cancel"` (ボタン)
- `WorktreeDetailRefactored.tsx:476` - `"No description added yet"` (プレースホルダー)
- `WorktreeDetailRefactored.tsx:516` - `"Logs"` (h2タグ)
- `WorktreeDetailRefactored.tsx:522` - `"Show"` / `"Hide"` (ボタン)

一方、同コンポーネントの行943-945では `useTranslations('worktree')`, `useTranslations('error')`, `useTranslations('common')` がインポートされており、i18n基盤は既に存在する。

**推奨対応**:
本Issueのスコープ外ではあるが、新規追加するアップデート通知文字列だけがi18n化されて既存のInfoModal文字列がハードコードのままだとコンポーネント内で混在状態になる。この状況を認識した上で実装するか、あるいは将来的な既存文字列のi18n化を別Issueとして起票する旨を記載すると良い。

---

### NTH-2: withLogging()パターンの新規APIルートへの適用

**カテゴリ**: テスト範囲
**場所**: ## 影響範囲 > ### 変更対象ファイル テーブル

**問題**:
既存のAPIルートでは `src/lib/api-logger.ts` の `withLogging()` 高階関数でリクエスト/レスポンスロギングをラップするパターンが使用されている。新規の `/api/app/update-check/route.ts` でも同様にwithLogging()を使用するかの方針が未記載。

**推奨対応**:
バージョンチェックAPIは外部API（GitHub）への呼び出しを含むため、withLogging()適用時にはレスポンスボディにGitHub APIのレスポンス情報が含まれる点を考慮する必要がある。`skipResponseBody` オプション（`api-logger.ts:42`）の利用を検討すると良い。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/i18n.ts` (行25-42) | 影響候補 - 新規i18n名前空間追加時のdynamic import配列とmessagesオブジェクトへの追加 |
| `src/lib/auto-yes-manager.ts` (行83-112) | 先行パターン - globalThisによるホットリロード耐性キャッシュ。declare global + eslint-disable |
| `src/components/worktree/WorktreeDetailRefactored.tsx` (行418-526, 693-789, 943-945) | 変更対象 - InfoModal/MobileInfoContent内のハードコード文字列とuseTranslationsの混在 |
| `src/lib/api-logger.ts` (行28-43, 55-60) | 参照対象 - withLogging()パターンとskipResponseBodyオプション |
| `src/lib/api-client.ts` (行1-500) | 影響候補 - 方式(a)選択時にupdateCheckApi追加 |
| `src/lib/db-path-resolver.ts` (行14) | 先行事例 - isGlobalInstall()のlib/配下からのimportパターン |
| `tests/unit/components/app-version-display.test.tsx` (行1-329) | 拡張対象 - mockFetchの拡張が必要（/api/app/update-check レスポンス追加） |
| `locales/en/worktree.json` | 変更対象 - 既存は session/status/output/errors の4グループ構成 |
| `locales/ja/worktree.json` | 変更対象 - 同上の日本語翻訳 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | 更新対象 - 主要機能モジュールテーブルへのversion-checker.tsエントリ追加 |
| `docs/implementation-history.md` | 更新対象 - Issue #257のエントリ追加 |

---

## 全体評価

Stage 3の影響範囲レビュー指摘は全て適切に反映されている。特にMF-1（i18n対応の欠如）は「i18n対応」セクションの新設、翻訳キーの定義例、対象ファイルの明記により完全に解消されている。SF-1-4の技術的指摘（テスト計画、api-client.ts、ドキュメント更新、開発モードキャッシュ）も全て対処済み。

2回目の影響範囲レビューで新たに発見された指摘は、src/i18n.tsの名前空間読み込み処理（SF-1）とglobalThisパターンの参照先誤り（SF-2）の2点のみで、いずれもShould Fixレベルの補足的な指摘である。

影響範囲の網羅性は高く、新規ファイル・変更ファイル・変更不要ファイルの分類が適切に行われている。方式選択（i18n名前空間の新規作成 vs 既存拡張、API呼び出しクライアントの方式(a)/(c)）に応じた影響ファイルの分岐も記載されており、実装者が判断しやすい構成になっている。

Issueは実装可能な品質に十分達している。
