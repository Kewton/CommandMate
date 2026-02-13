# Issue #257 レビューレポート

**レビュー日**: 2026-02-13
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目（Stage 1）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 3 |

Issue #257は「バージョンアップを知らせる機能」として、GitHub Releases APIを利用した新バージョン通知をInfoタブ/モーダルに追加する提案である。全体的に要件と実装タスクが明確に記述されているが、一部に文章の欠損や技術的記述の不正確さがある。仮説検証で指摘された`isGlobalInstall()`の説明修正に加え、GitHub API呼び出しに関する技術的考慮事項の補完が必要。

---

## Must Fix（必須対応）

### MF-1: isGlobalInstall()の判定方法の説明が不正確

**カテゴリ**: 正確性
**場所**: ## インストール方式別のアップデート方法 > ### 判定方法 テーブル

**問題**:
Issue内の説明「`__dirname`がnode_modules配下か」は、実際のコードロジックを正確に反映していない。

**証拠**:
`src/cli/utils/install-context.ts:39-44` の実装:

```typescript
const currentPath = dirname(__dirname);
return (
  currentPath.includes('/lib/node_modules/') ||
  currentPath.includes('\\node_modules\\') ||
  currentPath.includes('/node_modules/commandmate')
);
```

実際には `dirname(__dirname)` を使用し、3つのグローバルインストール固有パスパターンにマッチするかを判定している。単純に「node_modules配下か」ではなく、グローバルインストール特有のパスパターンに限定した判定であり、ローカルのnode_modules内での誤判定を防ぐ設計になっている。仮説検証レポートでも Partially Confirmed と判定済み。

**推奨対応**:
判定方法の記述を以下に修正:

| 判定対象 | 判定方法 | ファイル |
|---------|---------|---------|
| インストール方式 | `isGlobalInstall()` - `dirname(__dirname)`がグローバルnode_modulesパターンにマッチするか | `src/cli/utils/install-context.ts` |

---

### MF-2: 背景・課題セクションに文章の途切れ（欠損）がある

**カテゴリ**: 正確性
**場所**: ## 背景・課題 セクション 2つ目の箇条書き

**問題**:
以下の文章で、文意が途切れている:

> ユーザーは手動でGitHub ReleasesやnpmをチェックしないとアップデートのVSCodeのようにアプリ内で新バージョンの存在を通知することで、ユーザーが常に最新バージョンを利用できるようにしたい

「アップデートの」の直後で課題の記述が切れ、解決策の記述（「VSCodeのように...」）に飛んでいる。

**推奨対応**:
以下のように2文に分離して修正:

> - ユーザーは手動でGitHub Releasesやnpmをチェックしないとアップデートの有無を把握できない
> - VSCodeのようにアプリ内で新バージョンの存在を通知することで、ユーザーが常に最新バージョンを利用できるようにしたい

---

## Should Fix（推奨対応）

### SF-1: isGlobalInstall()のNext.js API Route内での動作保証についての考慮

**カテゴリ**: 技術的妥当性
**場所**: ## インストール方式別のアップデート方法 > 通知UI出し分け セクションの注記

**問題**:
`isGlobalInstall()`は`__dirname`ベースの判定であり、Next.js API Route（Server Component）内での動作が正しいかの考慮が必要。ビルド後のファイル配置（`.next/server/`）でのパス構造がCLIモジュール直接実行時と異なる可能性がある。

**証拠**:
`src/lib/db-path-resolver.ts:14` で既に `import { isGlobalInstall } from '../cli/utils/install-context'` として利用されているため、実績はある。ただし、新規APIエンドポイント `/api/app/update-check` から参照する場合のパスが期待通りになるかの検証は受け入れ条件に含まれていない。

**推奨対応**:
受け入れ条件に「グローバルインストール環境/ローカル環境の両方でインストール方式判定が正しく動作すること」を追加。または、実装タスクにインストール方式判定のユニットテストを明記。

---

### SF-2: GitHub APIレート制限対策の具体的な設計が未記載

**カテゴリ**: 完全性
**場所**: ## 実装タスク セクション「APIレート制限対策（キャッシュ、チェック間隔の制御）」

**問題**:
「キャッシュ、チェック間隔の制御」と記載されているが、具体的な設計値やキャッシュ戦略が不明。

**証拠**:
GitHub REST API の未認証リクエストのレート制限は60リクエスト/時間/IP。複数ブラウザタブの同時使用や頻繁なページリロードにより制限に到達するリスクがある。

**推奨対応**:
以下を検討・明記:
- サーバーサイドのインメモリキャッシュのTTL（例: 1時間）
- クライアント側のチェック頻度（例: ページロード時のみ or InfoModal開示時のみ）
- キャッシュの永続化要否（サーバー再起動でリセットされる前提で良いか）

---

### SF-3: GitHub Releases APIの具体的なエンドポイントが未記載

**カテゴリ**: 完全性
**場所**: ## 提案する解決策 セクション

**問題**:
「GitHub Releases APIを使用して」とあるが、具体的なAPIエンドポイントURLが記載されていない。

**証拠**:
`package.json` の `repository.url` は `https://github.com/Kewton/CommandMate.git` であり、対応するAPIエンドポイントは `GET https://api.github.com/repos/Kewton/CommandMate/releases/latest` と推測される。

**推奨対応**:
使用するAPIエンドポイントを明記し、ネットワーク制約環境（プロキシ、ファイアウォール）でアクセス不可の場合のフォールバック動作を記載（受け入れ条件の「静かに失敗」と整合）。

---

### SF-4: CSP（Content Security Policy）への影響考慮が不足

**カテゴリ**: 技術的妥当性
**場所**: ## 影響範囲 > ### 関連コンポーネント セクション

**問題**:
`next.config.js` の CSP `connect-src` ディレクティブが `'self' ws: wss:` のみであり、外部API（`api.github.com`）への接続が許可されていない。

**証拠**:
`next.config.js:64`:
```javascript
"connect-src 'self' ws: wss:", // Allow WebSocket connections
```

**推奨対応**:
API呼び出しがサーバーサイド（API Route内）のみで行われる場合はCSP変更不要（CSPはブラウザに適用されるため）。この設計意図を影響範囲セクションに明記:

> `next.config.js` - CSP変更不要（GitHub API呼び出しはサーバーサイドのAPI Routeのみで実行されるため）

---

## Nice to Have（あれば良い）

### NTH-1: 関連Issue #159への参照リンク

**カテゴリ**: 完全性
**場所**: Issue本文全体

**問題**:
本Issueは Issue #159（Infoタブにアプリバージョンを表示）で実装された`APP_VERSION_DISPLAY`、`NEXT_PUBLIC_APP_VERSION`環境変数、InfoModal/MobileInfoContentのバージョン表示UIを拡張するものだが、関連Issueへのリンクがない。

**推奨対応**:
背景セクションまたはIssue末尾に「Related: #159」を追加。

---

### NTH-2: semver比較の実装方針

**カテゴリ**: 明確性
**場所**: ## 実装タスク セクション 1番目のタスク

**問題**:
「semver比較」の実装方針（npmの`semver`パッケージ利用 vs 自前実装）が未記載。

**推奨対応**:
`semver`パッケージの利用を推奨。プレリリースバージョン（例: `1.0.0-beta.1`）の正しい比較が保証され、エッジケースへの対応が不要になる。

---

### NTH-3: 通知の再表示制御

**カテゴリ**: 完全性
**場所**: ## 受入条件 セクション

**問題**:
ユーザーが通知を確認した後の挙動（同じバージョンの通知を再表示するか、既読管理するか）が未記載。

**推奨対応**:
初回実装のスコープ外であれば「将来的な検討事項」として記載。スコープ内であれば、localStorageに既読バージョンを保存し同一バージョンの通知を抑制する仕様を追加。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/cli/utils/install-context.ts` (L33-45) | `isGlobalInstall()`の実装 - Issue内の説明と実際のロジックに乖離 |
| `src/lib/db-path-resolver.ts` (L14, 33, 82) | `isGlobalInstall()`をNext.jsモジュールから参照している既存パターン |
| `src/lib/db-instance.ts` (L30-50) | `runMigrations()`自動実行の実装 |
| `src/lib/db-migrations.ts` (L14) | `CURRENT_SCHEMA_VERSION = 16` の確認 |
| `server.ts` (L46) | `NODE_ENV`判定の実装 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` (L108-110, 335-351, 506-511) | 変更対象のInfoModal/MobileInfoContent |
| `next.config.js` (L10, 57-66) | `NEXT_PUBLIC_APP_VERSION`設定とCSP |
| `src/components/common/Toast.tsx` | info通知のToastコンポーネント（既存、活用可能） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト構成とモジュール一覧の整合性確認 |
| `CHANGELOG.md` | Issue #159でのNEXT_PUBLIC_APP_VERSION追加の履歴確認 |
