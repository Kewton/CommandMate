# Issue #264 レビューレポート (Stage 5)

**レビュー日**: 2026-02-14
**フォーカス**: 通常レビュー（2回目）
**イテレーション**: 2回目
**ステージ**: 5

## Stage 1 指摘事項の対応状況

Stage 1（通常レビュー 1回目）で指摘した全12件は、すべて適切に対応されています。

| ID | カテゴリ | 対応状況 |
|----|---------|---------|
| MF-1 | gh CLI依存関係未登録 | 解決済み -- 実装タスク・受入条件に反映 |
| MF-2 | タイトル誤字 | 解決済み -- タイトル修正済み |
| MF-3 | CLI i18n方針未定義 | 解決済み -- 英語固定の方針と根拠を明記 |
| SF-1 | docsコマンド対象リスト欠落 | 解決済み -- cli-setup-guide.md, agents-guide.md追加 |
| SF-2 | issue createオプション曖昧 | 解決済み -- オプション一覧表を追加 |
| SF-3 | FeedbackSection配置先曖昧 | 解決済み -- ローカルmemoコンポーネントである旨と行番号を明記 |
| SF-4 | CLAUDE.md更新タスク欠落 | 解決済み -- 実装タスク・受入条件に追加 |
| SF-5 | URLテンプレートテスト欠落 | 解決済み -- 受入条件に追加 |
| NTH-1 | agents-guide.md欠落 | 解決済み -- 対象リストに追加 |
| NTH-2 | GitHub URL定数管理 | 解決済み -- GITHUB_REPO_BASE_URL設計を採用 |
| NTH-3 | addHelpText API未指定 | 解決済み -- 具体的なAPI名を記載 |
| NTH-4 | 関連Issue #124未リンク | 解決済み -- 関連Issueセクションに追加 |

## 新規指摘事項サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |

---

## Must Fix（必須対応）

### MF-1: gh CLI --template への引数マッピングが不正確

**カテゴリ**: 正確性
**場所**: ## 提案する解決策 > (2)CLIにissueコマンドを追加 > commandmate issue create のオプション一覧

**問題**:
オプション一覧表で `--bug` を `--template bug_report.md` にマッピングしていますが、gh CLI の `--template` フラグはテンプレートの**ファイル名**ではなく**テンプレート名**（front matter の `name` フィールド値）を受け取ります。

**証拠**:

gh CLI のヘルプ出力:
```
-T, --template name    Template name to use as starting body text
$ gh issue create --template "Bug Report"
```

各テンプレートファイルの front matter `name` フィールド:
- `.github/ISSUE_TEMPLATE/bug_report.md`: `name: Bug Report`
- `.github/ISSUE_TEMPLATE/feature_request.md`: `name: Feature Request`
- `.github/ISSUE_TEMPLATE/question.md`: `name: Question`

**現在のIssue記載（誤り）**:

| オプション | gh issue create への引数マッピング |
|-----------|----------------------------------|
| `--bug` | `--template bug_report.md` |
| `--feature` | `--template feature_request.md` |
| `--question` | `--template question.md` |

**推奨対応**:

| オプション | gh issue create への引数マッピング |
|-----------|----------------------------------|
| `--bug` | `--template "Bug Report"` |
| `--feature` | `--template "Feature Request"` |
| `--question` | `--template "Question"` |

なお、UI側のフィードバックリンクで使用する GitHub Issue URLパラメータ `template=bug_report.md` は**ファイル名指定が正しい**ため、UIとCLIで参照形式が異なることに注意が必要です。実装時の混同を防ぐため、この違いをIssue内に注記することを推奨します。

---

## Should Fix（推奨対応）

### SF-1: 影響範囲テーブルに security-messages.ts が欠落

**カテゴリ**: 完全性
**場所**: ## 影響範囲 > 変更対象ファイル / ## 実装タスク > UI

**問題**:
Issue本文の「主要な変更点」で「Security Guide URL をすべて `GITHUB_REPO_BASE_URL` から派生させる」と記載していますが、`src/cli/config/security-messages.ts` の line 26 に GitHub URL がハードコードされており、影響範囲テーブルに含まれていません。

**証拠**:
```typescript
// src/cli/config/security-messages.ts line 26
Details: https://github.com/Kewton/CommandMate/blob/main/docs/security-guide.md
```

**推奨対応**:
変更対象ファイルに `src/cli/config/security-messages.ts` を追加し、`REVERSE_PROXY_WARNING` 内の security-guide URL を `github-links.ts` の定数から派生させるタスクを追加してください。もしくは、今回のスコープ外とする場合はその旨を明記してください。

---

### SF-2: cli-dependencies.ts への gh CLI 追加時の versionArg が未指定

**カテゴリ**: 完全性
**場所**: ## 実装タスク > CLIコマンド > cli-dependencies.ts

**問題**:
実装タスクでは `gh` を `required: false` で追加すると記載していますが、`DependencyCheck` 型に必須の `versionArg` フィールドの値が定義されていません。

**証拠**:
```typescript
// src/cli/types/index.ts
export interface DependencyCheck {
  name: string;
  command: string;
  versionArg: string;  // 必須フィールド（optional指定なし）
  required: boolean;
  minVersion?: string;
}
```

既存5件の依存関係はすべて `versionArg` を指定しています（`-v`, `-V`, `--version`）。

**推奨対応**:
gh CLI の `DependencyCheck` エントリを具体的に記載してください:
```typescript
{
  name: 'gh CLI',
  command: 'gh',
  versionArg: '--version',
  required: false,
}
```

`gh --version` の出力形式は `gh version 2.86.0 (2026-01-21)` であり、既存の `extractVersion()` のパターン（`/version\s+(\d+\.\d+\.\d+)/i`）でバージョン抽出が可能です。

---

### SF-3: -i/--issue オプション description 更新の3箇所が未明示

**カテゴリ**: 明確性
**場所**: ## 実装タスク > CLIコマンド > src/cli/index.ts

**問題**:
実装タスクで「既存 `-i, --issue` オプションの description を 'Specify worktree by issue number' に明確化」と記載していますが、`-i, --issue` オプションは `start`, `stop`, `status` の3コマンドにそれぞれ定義されており、全3箇所の更新が必要です。

**証拠**:
```typescript
// src/cli/index.ts
// line 44: start コマンド
.option('-i, --issue <number>', 'Start worktree server for specific issue', parseInt)
// line 62: stop コマンド
.option('-i, --issue <number>', 'Stop worktree server for specific issue', parseInt)
// line 75: status コマンド
.option('-i, --issue <number>', 'Show status for specific issue worktree', parseInt)
```

**推奨対応**:
「`src/cli/index.ts` の start / stop / status 各コマンドの `-i, --issue` オプション description をすべて 'Specify worktree by issue number' に統一する（3箇所）」と明記してください。

---

## Nice to Have（あれば良い）

### NTH-1: GITHUB_API_URL の URL 一元管理方針が未記載

**カテゴリ**: 完全性
**場所**: ## 主要な変更点 / ## 実装タスク > UI > github-links.ts

**問題**:
`GITHUB_REPO_BASE_URL` から全 GitHub URL を派生させる設計を採用していますが、`version-checker.ts` の `GITHUB_API_URL`（`https://api.github.com/repos/Kewton/CommandMate/releases/latest`）にも `Kewton/CommandMate` が含まれています。セキュリティ上の理由（SEC-001 SSRF 防止）でハードコード維持とする場合、その判断根拠を注記するとよいです。

**推奨対応**:
`github-links.ts` のセクションに「`GITHUB_API_URL` は SSRF 防止（SEC-001）のため `version-checker.ts` 内にハードコード維持。`GITHUB_REPO_BASE_URL` からの派生対象外」と注記を追加してください。

---

### NTH-2: re-export 変更の実際の影響対象テストファイルが不正確

**カテゴリ**: 完全性
**場所**: ## 影響範囲 > 関連コンポーネント

**問題**:
関連コンポーネントで「`tests/unit/api/update-check.test.ts` -- `GITHUB_RELEASE_URL_PREFIX` の re-export 変更による影響確認が必要」と記載していますが、このテストファイルは `GITHUB_RELEASE_URL_PREFIX` を直接 import していません。実際に直接 import しているのは `tests/unit/lib/version-checker.test.ts`（line 22）です。

**証拠**:

`tests/unit/api/update-check.test.ts` の import:
```typescript
import { checkForUpdate, getCurrentVersion } from '@/lib/version-checker';
import type { UpdateCheckResult } from '@/lib/version-checker';
// GITHUB_RELEASE_URL_PREFIX のimportなし
```

`tests/unit/lib/version-checker.test.ts` の import:
```typescript
import {
  isNewerVersion,
  getCurrentVersion,
  validateReleaseUrl,
  sanitizeReleaseName,
  checkForUpdate,
  GITHUB_API_URL,
  GITHUB_RELEASE_URL_PREFIX,  // 直接import
  resetCacheForTesting,
} from '@/lib/version-checker';
```

**推奨対応**:
関連コンポーネントの記載を以下に修正してください:
- `tests/unit/lib/version-checker.test.ts` -- `GITHUB_RELEASE_URL_PREFIX` を直接 import（line 22）しているため、re-export が正しく機能することの確認が必要
- `tests/unit/api/update-check.test.ts` は `checkForUpdate` と `getCurrentVersion` のみを import しており、定数の re-export による影響なし

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/cli/config/security-messages.ts`: line 26 に GitHub URL がハードコード。GITHUB_REPO_BASE_URL 一元管理の対象漏れ（SF-1）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/cli/types/index.ts`: DependencyCheck 型の versionArg フィールドが必須（SF-2）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/cli/index.ts`: -i/--issue オプションが start(line 44), stop(line 62), status(line 75) の3箇所に定義（SF-3）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/.github/ISSUE_TEMPLATE/bug_report.md`: front matter name: 'Bug Report'（MF-1）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/.github/ISSUE_TEMPLATE/feature_request.md`: front matter name: 'Feature Request'（MF-1）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/.github/ISSUE_TEMPLATE/question.md`: front matter name: 'Question'（MF-1）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/lib/version-checker.ts`: GITHUB_API_URL(line 27), GITHUB_RELEASE_URL_PREFIX(line 33)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/tests/unit/lib/version-checker.test.ts`: GITHUB_RELEASE_URL_PREFIX を直接 import (line 22)（NTH-2）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/tests/unit/api/update-check.test.ts`: GITHUB_RELEASE_URL_PREFIX を import していない（NTH-2）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/CLAUDE.md`: DependencyCheck 型の構造確認
