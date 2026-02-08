# Issue #125 通常レビュー報告書（Stage 1）

## レビュー概要

| 項目 | 内容 |
|------|------|
| Issue番号 | #125 |
| タイトル | fix(cli): グローバルインストール時に start コマンドが ~/.commandmate/.env を読み込まない |
| レビュー日 | 2026-02-02 |
| レビュー種別 | 通常レビュー（1回目） |

## レビュー結果サマリ

Issue #125 の内容は技術的に正確であり、根本原因の特定も正しいです。ただし、以下の点を補足・修正することで、より完全なIssueになります。

### 指摘件数

| 分類 | 件数 |
|------|------|
| Must Fix（必須修正） | 2件 |
| Should Fix（推奨修正） | 3件 |
| Nice to Have（改善提案） | 4件 |

---

## Must Fix（必須修正）

### MF-001: 根本原因の記載が正確

**カテゴリ**: 技術的正確性
**ステータス**: 確認済み

Issue記載の根本原因は正確です。`start.ts:25`で `join(process.cwd(), '.env')` を使用しており、`init.ts`で使用している `getEnvPath()` と不整合があります。

**エビデンス**:
```typescript
// src/cli/commands/start.ts:25
const envPath = join(process.cwd(), '.env');  // 常にカレントディレクトリを参照

// src/cli/commands/init.ts:190
const envPath = getEnvPath();  // グローバルインストール時は ~/.commandmate/.env を使用
```

---

### MF-002: PIDファイルパスも同様の問題あり

**カテゴリ**: 整合性
**ステータス**: Issueに記載なし

`start.ts:17`で `PID_FILE = join(process.cwd(), '.commandmate.pid')` も同様に `process.cwd()` を使用しています。グローバルインストール時は PID ファイルも `~/.commandmate/` に配置すべきです。

**エビデンス**:
```typescript
// src/cli/commands/start.ts:17
const PID_FILE = join(process.cwd(), '.commandmate.pid');
```

**推奨対応**: 修正案にPIDファイルパスの修正も追加すべき

---

## Should Fix（推奨修正）

### SF-001: daemon.ts への .env パス伝播方法が不明確

**カテゴリ**: 修正案の実現可能性

修正案2「daemon.ts を更新し、正しい .env パスを子プロセスに渡す」について、具体的な実装方法が不明確です。Next.jsは自動的にcwd()から.envを読むため、対応方針を明確にすべきです。

**推奨対応**: 以下のいずれかの方針を明記
1. spawn時の cwd を ~/.commandmate に変更
2. .env の内容を環境変数として子プロセスに渡す
3. dotenv-cliまたはdotenvパッケージでロード後にNext.js起動

**エビデンス**:
```typescript
// src/cli/utils/daemon.ts:47-52
const child = spawn('npm', ['run', npmScript], {
  cwd: packageRoot,  // ここでcwdを設定中
  env,
  detached: true,
  stdio: 'ignore',
});
```

---

### SF-002: Next.js の .env 読み込み動作の補足が必要

**カテゴリ**: 技術的正確性

修正案3「Next.js が正しい場所から .env を読み込むようにする」について、Next.jsは実行ディレクトリ（cwd）の.envを自動読み込みするため、packageRoot で実行する限り別途対応が必要です。

**推奨対応**: Next.jsの.env読み込み仕様への言及を追加

---

### SF-003: 再現手順の前提条件を明記

**カテゴリ**: 再現手順の妥当性

再現手順は妥当ですが、「カレントディレクトリに.envが存在しない状態」という前提条件を明記すると、再現性が向上します。

**推奨対応**: 再現手順の前提条件として「カレントディレクトリに.envが存在しない状態」を追加

---

## Nice to Have（改善提案）

### NH-001: 回避策の記載は有用

3つの回避策（シンボリックリンク、コピー、ホームディレクトリ実行）の記載は有用です。ユーザーが即座に問題を回避できます。

### NH-002: Issue #96 との関連は適切

Issue #96（npm install CLI サポート）との関連付けは適切です。同Issueの設計で考慮漏れがあった問題として認識できます。

### NH-003: テストケースの追加を推奨

修正後の受け入れ条件として、以下のテストケースを追加することを推奨します：
1. グローバルインストール時に任意のディレクトリから start できること
2. `~/.commandmate/.env` の設定が正しく読み込まれること

### NH-004: エラーメッセージの改善提案

現在のエラーメッセージ「.env file not found」に、期待されるパスを表示すると診断が容易になります。

**例**: `.env file not found at ${envPath}`

---

## コード確認結果

### src/cli/commands/start.ts

| 行番号 | 問題 | 修正案 |
|--------|------|--------|
| 17 | PIDファイルがcwdに作成される | `getConfigDir()`を使用 |
| 25 | .envパスがcwd固定 | `getEnvPath()`を使用 |

### src/cli/utils/daemon.ts

| 行番号 | 問題 | 修正案 |
|--------|------|--------|
| 41-52 | .envファイルの内容が子プロセスに渡らない | dotenvで読み込み後、環境変数に設定してspawn |

### src/cli/utils/env-setup.ts

ステータス: **正常**

`getEnvPath()`と`isGlobalInstall()`は正しく実装されています。

---

## 総合評価と推奨事項

Issue内容は概ね正確で、実装に進める状態です。ただし、以下の対応を推奨します：

1. **MF-002を追記**: PIDファイルパスの問題をIssueに追加
2. **SF-001を明確化**: daemon.tsでの.envロード方法を具体的に記載
3. **テストケース追加**: 受け入れ条件としてテストケースを定義

これらの対応後、実装フェーズに進むことを推奨します。

---

## 出力ファイル

- 結果JSON: `dev-reports/issue/125/issue-review/stage1-review-result.json`
- 報告書MD: `dev-reports/issue/125/issue-review/stage1-review-report.md`
