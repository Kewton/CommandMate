# Issue #125 アーキテクチャレビュー - Stage 2: 整合性レビュー

**レビュー日**: 2026-02-02
**レビュー対象**: dev-reports/design/issue-125-global-install-env-loading-design-policy.md
**フォーカス**: 整合性（設計書と既存コードの整合性、セクション間の整合性）

---

## サマリー

| 指標 | 件数 |
|------|------|
| Must Fix | 3 |
| Should Fix | 4 |
| Good Practices | 5 |
| **総合評価** | **部分的適合** |

設計書はStage 1レビューの指摘を適切に反映しているが、整合性の観点から改善が必要な点がある。特にdaemon.tsでの.env読み込みエラーハンドリング、命名規則の統一、エラーメッセージパターンの一貫性について対応を推奨する。

---

## Must Fix（必須対応）

### MF-1: JSDocコメントの精度不足

**カテゴリ**: 設計書と既存コードの整合性
**重要度**: High
**該当箇所**: 設計書: セクション3「詳細設計」vs src/cli/utils/env-setup.ts

**問題**:
設計書のgetPidFilePath()関数のJSDocには「PIDファイルの絶対パス」と記載されているが、ローカルインストール時にprocess.cwd()を使用する場合、シンボリックリンクなどで相対パス的な挙動になる可能性がある。

**推奨対応**:
設計書のJSDocコメントを実態に合わせて修正する。

```typescript
/**
 * PIDファイルのパスを取得する
 * グローバルインストール時: ~/.commandmate/.commandmate.pid
 * ローカルインストール時: <cwd>/.commandmate.pid
 *
 * @returns PIDファイルのパス
 */
```

---

### MF-2: daemon.tsでのエラーハンドリング未設計

**カテゴリ**: 設計書内セクション間の整合性
**重要度**: High
**該当箇所**: 設計書: セクション2「start.ts の修正」vs セクション5「daemon.ts の修正」

**問題**:
設計書では「start.tsはenvPathの存在確認のみを行う」と記載しているが、daemon.tsでdotenvConfigを呼び出す際のエラーハンドリングが設計されていない。start.tsで存在確認済みでも、レースコンディションでファイルが消える可能性がある。

**推奨対応**:
daemon.tsの設計にenvResult.errorのチェックを追加する。

```typescript
const envResult = dotenvConfig({ path: envPath });
if (envResult.error) {
  // start.tsで確認済みのため通常は発生しないが、防御コードとして記録
  console.error(`Warning: Failed to load .env from ${envPath}: ${envResult.error.message}`);
}
```

---

### MF-3: DaemonManagerのシグネチャ検討不足

**カテゴリ**: APIシグネチャの整合性
**重要度**: High
**該当箇所**: 設計書: セクション5「daemon.ts」vs 既存src/cli/utils/daemon.ts

**問題**:
設計書ではgetEnvPath()をdaemon.ts内で呼び出す設計となっているが、DaemonManagerのコンストラクタまたはstart()メソッドのシグネチャ変更が必要か検討が不足している。

**推奨対応**:
設計書に以下を明記する。

```markdown
### DaemonManagerのシグネチャについて

現在のコンストラクタ`constructor(pidFilePath: string)`は変更せず、
start()メソッド内で`getEnvPath()`を呼び出す設計とする。

理由:
- pidFilePathは外部から注入する設計を維持（テスト容易性）
- envPathは内部で解決可能（グローバル/ローカルの判定ロジックは集約済み）
```

---

## Should Fix（推奨対応）

### SF-1: 命名規則の混在

**カテゴリ**: 命名規則の一貫性
**重要度**: Medium
**該当箇所**: 設計書全体 vs 既存コード

**問題**:
設計書では`pidFilePath`（camelCase）を使用しているが、既存コードでは`PID_FILE`（UPPER_SNAKE_CASE）を使用している。

**推奨対応**:
関数からの戻り値であるためcamelCaseに統一する。設計書に以下を明記。

```markdown
### 命名規則

修正後は関数呼び出しの戻り値として変数に格納するため、
定数命名規則（UPPER_SNAKE_CASE）からcamelCase変数に変更する。

変更前: const PID_FILE = join(process.cwd(), '.commandmate.pid');
変更後: const pidFilePath = getPidFilePath();
```

---

### SF-2: テスト検証方法の不明確さ

**カテゴリ**: テスト計画と実装の整合性
**重要度**: Medium
**該当箇所**: 設計書: セクション「テスト計画」

**問題**:
「.envの環境変数が子プロセスに渡ること」のテスト検証方法が不明確。

**推奨対応**:
テスト計画に具体的な検証方法を追記。

```markdown
### テスト方法の詳細

**daemon.tsの環境変数伝播テスト**:
1. spawnをモック化
2. spawn呼び出し時の第3引数(options.env)を検証
3. 以下を確認:
   - .envの値がenvオブジェクトに含まれること
   - コマンドラインオプションが.envの値をオーバーライドしていること
```

---

### SF-3: エラーメッセージパターンの不統一

**カテゴリ**: エラーハンドリングの整合性
**重要度**: Medium
**該当箇所**: 設計書: セクション6「エラーメッセージの改善」

**問題**:
.envファイルのエラーメッセージにはパス情報を含める改善がされているが、PIDファイル関連のエラーメッセージについては統一されていない。

**推奨対応**:
全コマンドで一貫したエラーメッセージ形式を定義する。

```markdown
### エラーメッセージ形式の標準化

設定ファイル系のエラーメッセージは以下の形式を使用:
- 「{ファイル種別} not found at {パス}」
- 「Failed to {操作} {ファイル種別} at {パス}: {エラー詳細}」

例:
- `.env file not found at ~/.commandmate/.env`
- `PID file not found at ~/.commandmate/.commandmate.pid`
```

---

### SF-4: 影響なしファイルの明記

**カテゴリ**: 設計書内の整合性
**重要度**: Medium
**該当箇所**: 設計書: 変更概要テーブル

**問題**:
init.tsが変更対象に含まれていないが、影響を受けないことが明示されていない。

**推奨対応**:
変更概要セクションに以下を追記。

```markdown
### 影響を受けないファイル

| ファイル | 理由 |
|---------|------|
| `src/cli/commands/init.ts` | 既にgetEnvPath()を使用しており変更不要 |
```

---

## Good Practices（良い設計）

### 1. Stage 1レビュー指摘への対応

設計書にStage 1レビューで指摘されたMF-1（getPidFilePath()のDRY）、MF-2（環境変数読み込み責務の一元化）への対応が反映されている。「レビュー履歴」セクションでトレーサビリティが確保されている。

### 2. 後方互換性の考慮

isGlobalInstall()がfalseを返す場合の既存動作維持が明記されており、ローカルインストール環境への影響が考慮されている。レガシーPIDファイルの警告表示も検討されている。

### 3. コード例の具体性

各ファイルについて「現状」と「修正後」のコード例が具体的に示されており、実装者が迷わず作業できる。import文の変更も明記されている。

### 4. テスト計画の網羅性

単体テスト（5項目）と統合テスト（2シナリオ）が定義されており、グローバル/ローカルインストールの両方のテストケースが含まれている。

### 5. 今後の検討事項の分離

Stage 1レビューのSF（should_fix）項目を「今後の検討事項」として設計書に取り込み、本Issueのスコープ外であることを明確化している。優先度も記載されており、判断の透明性が高い。

---

## 整合性チェック結果

| チェック項目 | ステータス | 備考 |
|-------------|-----------|------|
| 設計書 vs 既存コード | 部分的適合 | getEnvPath(), getConfigDir()との整合性は良好。命名規則の移行について明記が必要 |
| セクション間整合性 | 要改善 | start.tsとdaemon.tsの責務分担、エラーハンドリングの整合性に課題 |
| 命名規則の一貫性 | 部分的適合 | 関数名は一貫。定数から変数への移行について明記が必要 |
| APIシグネチャ | 要確認 | DaemonManagerのシグネチャ維持を明記すべき |
| エラーハンドリング | 部分的適合 | パス情報の追加は良い改善。全コマンドでの統一が未検討 |

---

## Stage 1レビュー指摘への対応状況

| Stage 1指摘 | 対応状況 | 備考 |
|-------------|---------|------|
| MF-1: getPidFilePath()の重複 | 対応済み | env-setup.tsへの集約が設計書に反映 |
| MF-2: 環境変数読み込み責務の重複 | 対応済み | daemon.tsへの一元化が設計書に反映 |

---

## 次のステップ

1. 設計書のMF-1〜MF-3を修正
2. SF-1〜SF-4の推奨対応を検討
3. Stage 3: 影響範囲分析レビューを実施

---

**レビュー結果ファイル**: `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/dev-reports/issue/125/multi-stage-design-review/stage2-review-result.json`
