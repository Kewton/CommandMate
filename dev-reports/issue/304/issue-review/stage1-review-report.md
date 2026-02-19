# Issue #304 レビューレポート

**レビュー日**: 2026-02-20
**フォーカス**: 通常レビュー
**イテレーション**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |
| **合計** | **8** |

Issue #304 の根本原因分析は正確であり、仮説検証でも両方の仮説が確認済みです。ただし、対策案の記述に実際のコードベースとの不一致が含まれており、影響範囲の網羅性にも改善が必要です。

---

## Must Fix（必須対応）

### R1-001: 対策1のスクリプト記述が実際のpackage.jsonと不一致

**カテゴリ**: 正確性
**場所**: 対策案 > 対策1

**問題**:
Issue記載の対策1では以下のスクリプトが提案されています。

```json
{
  "test:unit": "NODE_ENV=test vitest --project unit"
}
```

しかし、実際の `package.json` のスクリプトは以下の形式です。

```json
{
  "test:unit": "vitest run tests/unit"
}
```

`vitest --project unit` はvitest workspaces機能（`vitest.workspace.ts` を使用するプロジェクト）のオプションであり、本プロジェクトでは使用していません。このまま適用すると `vitest --project unit` が解決できずエラーになるか、意図しないテスト実行になります。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/package.json` L42: `"test:unit": "vitest run tests/unit"`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/vitest.config.ts`: `projects` 設定なし

**推奨対応**:
対策1のスクリプトを実際のpackage.jsonの形式に合わせて修正してください。

```json
{
  "test": "NODE_ENV=test vitest",
  "test:unit": "NODE_ENV=test vitest run tests/unit"
}
```

---

### R1-002: 変更対象にtest:integration等のスクリプトが含まれていない

**カテゴリ**: 完全性
**場所**: 影響範囲 > 変更対象ファイル

**問題**:
Issue記載の変更対象は `package.json` と `tests/unit/env.test.ts` の2ファイルのみですが、以下のテスト関連スクリプトも同様に `NODE_ENV` が未指定です。

| スクリプト | 現在の定義 |
|-----------|-----------|
| `test` | `vitest` |
| `test:ui` | `vitest --ui` |
| `test:coverage` | `vitest --coverage` |
| `test:integration` | `vitest run tests/integration` |
| `test:watch` | `vitest --watch` |

これらのスクリプトも `NODE_ENV=production` が残留した環境では同じ問題が発生します。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/package.json` L39-46

**推奨対応**:
全テスト関連スクリプトに `NODE_ENV=test` を追加する旨を変更内容に含めてください。

---

## Should Fix（推奨対応）

### R1-003: 対策2のdelete対象環境変数が不完全

**カテゴリ**: 完全性
**場所**: 対策案 > 対策2

**問題**:
対策2のコード例では `CM_ROOT_DIR` と `MCBD_ROOT_DIR` の2変数のみが記載されていますが、`.env` ファイルには以下の6変数が設定されています。

```
CM_ROOT_DIR=/Users/maenokota/share/work/github_kewton
CM_PORT=3002
CM_BIND=127.0.0.1
CM_DB_PATH=/Users/maenokota/.commandmate/data/cm.db
CM_LOG_LEVEL=info
CM_LOG_FORMAT=text
```

テストで環境変数を適切に分離するには、これら全てと対応する `MCBD_*` 変数、および `DATABASE_PATH` をdeleteする必要があります。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/.env` L4-9

**推奨対応**:
テスト前に関連する全 `CM_*` / `MCBD_*` / `DATABASE_PATH` 環境変数をdeleteするヘルパー関数の導入、または具体的なdelete対象の完全なリストを記載してください。

---

### R1-004: env.test.tsの問題点の因果関係が不明確

**カテゴリ**: 正確性
**場所**: 根本原因 > 2

**問題**:
Issue本文の根本原因2の記載は以下です。

> `env.test.ts` で `.env` ファイルの環境変数（`CM_ROOT_DIR` 等）がテスト内のモック値を上書きしている

この記載は症状の説明としては正しいですが、なぜそうなるのかという因果関係が不明確です。具体的には以下のメカニズムです。

1. vitest（Vite）がプロジェクトルートの `.env` ファイルを自動読み込みし、`process.env` に注入する
2. `env.test.ts` のモジュールスコープで `const originalEnv = process.env`（L19）が評価される時点で、既に `.env` の値が `process.env` に含まれている
3. `beforeEach` で `process.env = { ...originalEnv }` に復元しても、`.env` 由来の値はスプレッドコピーに含まれたまま
4. 結果として、`CM_ROOT_DIR` が未設定であることを前提とするテスト（例: "should return undefined when neither key is set"）が失敗する

**推奨対応**:
根本原因セクションに上記の因果関係を明記してください。

---

### R1-005: 受入条件にtest:integration等が含まれていない

**カテゴリ**: 受入条件
**場所**: 受入条件

**問題**:
受入条件は以下の3項目ですが、`test:integration` やその他のテストスクリプトに関する条件が含まれていません。

- `NODE_ENV=production` が設定されたシェルで `npm run test:unit` を実行しても全テストがパスすること
- `env.test.ts` のテストがシェル環境の `.env` に依存せずパスすること
- 既存テストに影響がないこと

**推奨対応**:
「全テストスクリプト（test, test:unit, test:integration, test:watch等）がシェル環境の `NODE_ENV` に依存せず正常に動作すること」と一般化するか、個別に `test:integration` の条件を追加してください。

---

### R1-006: CI環境のNODE_ENV設定への言及がない

**カテゴリ**: 影響範囲
**場所**: 影響範囲

**問題**:
CI設定（`.github/workflows/ci-pr.yml`）のtest-unitジョブでも `NODE_ENV` は明示的に設定されていません。

```yaml
      - name: Run unit tests
        run: npm run test:unit
        env:
          CI: 'true'
          NODE_OPTIONS: '--max-old-space-size=6144'
```

現在はGitHub Actionsのクリーン環境で実行されるため問題は顕在化しませんが、対策1でpackage.jsonのスクリプトに `NODE_ENV=test` を設定すればCIも同時にカバーされます。この点を明記すると影響範囲の理解が深まります。

**証拠**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/.github/workflows/ci-pr.yml` L68-72

**推奨対応**:
影響範囲セクションに、対策1がCI環境にも波及する旨を追記してください。CIワークフローファイル自体の変更は対策1で十分カバーされるため必須ではありません。

---

## Nice to Have（あれば良い）

### R1-007: vitest.config.tsのenvオプションによる代替アプローチ

**カテゴリ**: 完全性
**場所**: 対策案

**問題**:
vitest.config.ts の `test.env` オプションを利用した代替アプローチへの言及がありません。以下の設定により、package.jsonの全スクリプトに個別に `NODE_ENV=test` を追加する必要がなくなります。

```typescript
export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
    },
    // ...existing config
  },
});
```

この方法は一元的で漏れにくいメリットがあります。一方、package.jsonスクリプトの方がより明示的で、`npm run test:unit` を実行する人にとって分かりやすいというメリットもあります。

**推奨対応**:
代替アプローチとして記載し、採用・不採用の判断理由を添えるとIssueの議論が充実します。

---

### R1-008: Windows環境互換性への注記

**カテゴリ**: 完全性
**場所**: 対策案 > 対策1

**問題**:
`NODE_ENV=test vitest run tests/unit` はUnixシェル構文であり、Windowsのcmd.exeでは動作しません。ただし、本プロジェクトはtmux依存であり、既存の `start` スクリプト（`NODE_ENV=production node dist/server/server.js`）も同様のUnix構文を使用しているため、現時点ではスコープ外と考えられます。

**推奨対応**:
将来的にWindows対応が必要になった場合は `cross-env` パッケージの利用を検討する旨を補足的に記載するとよいでしょう。

---

## 参照ファイル

### コード
| ファイル | 関連 |
|---------|------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/package.json` (L39-46) | テストスクリプト定義 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/tests/unit/env.test.ts` (L19, L21-29) | originalEnv保存とbeforeEachパターン |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/vitest.config.ts` | vitest設定全体 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/.env` | 環境変数設定値 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/src/lib/env.ts` | テスト対象の環境変数関数群 |

### CI/CD
| ファイル | 関連 |
|---------|------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/.github/workflows/ci-pr.yml` (L52-72) | CIのtest-unitジョブ |

### ドキュメント
| ファイル | 関連 |
|---------|------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/CLAUDE.md` | 開発コマンドとテストスクリプトの記載 |
