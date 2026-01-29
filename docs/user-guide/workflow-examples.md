# ワークフロー例

CommandMateのコマンドとエージェントを使った実践的なワークフロー例です。

---

## 1. 新機能開発フロー

新しいIssueを開発する際の標準的なワークフローです。

### Step 1: Issue確認

```bash
# Issue一覧を確認
gh issue list

# 対象Issueを確認
gh issue view 123
```

### Step 2: 作業計画立案

```
/work-plan 123
```

**出力例**:
```markdown
## Issue: ダークモード追加
**Issue番号**: #123
**サイズ**: M
**優先度**: High

### タスク分解
- [ ] Task 1.1: テーマ型定義
- [ ] Task 1.2: テーマコンテキスト作成
- [ ] Task 1.3: UIコンポーネント実装
- [ ] Task 2.1: 単体テスト
...
```

### Step 3: 自動開発

```
/pm-auto-dev 123
```

**実行内容**:
1. TDD実装（テスト作成 → 実装 → リファクタリング）
2. 受入テスト
3. コード品質改善
4. 進捗レポート作成

### Step 4: PR作成

```
/create-pr
```

**出力例**:
```markdown
## Summary

ダークモード機能を追加しました。

Closes #123

## Changes

### Added
- テーマ切り替えコンポーネント
- ダークモード用スタイル

## Test Results
- Unit Tests: 15/15 passed
- Coverage: 85%
```

---

## 2. バグ修正フロー

不具合を発見した際の修正ワークフローです。

### Step 1: バグ報告

ユーザーまたは自分でバグを発見。

### Step 2: 自動調査・修正

```
/bug-fix APIエラーが発生している
```

**実行フェーズ**:

**Phase 1: 不具合調査**
- エラーログ分析
- 根本原因特定

```markdown
## 調査結果サマリー

**根本原因**: タイムアウト設定が短すぎる
**影響範囲**: 全ユーザー
**重大度**: high
```

**Phase 2: 対策案提示**
```markdown
## 対策案（優先度順）

1. [High] タイムアウト設定の変更（30分）
2. [Medium] リトライ処理の追加（1時間）

どの対策案を実施しますか？
```

**Phase 3-6: 修正・テスト・報告**
- TDD修正実施
- 受入テスト
- 進捗報告

### Step 3: PR作成

```
/create-pr
```

---

## 3. リファクタリングフロー

コード品質を改善するワークフローです。

### Step 1: 対象特定

```
/refactoring src/lib/utils.ts
```

### Step 2: 分析・実行

**出力例**:
```
リファクタリング完了

## リファクタリング内容
- 長い関数の分割
- 重複コードの削除
- 命名の改善

## 品質メトリクス改善
| 指標 | Before | After | 改善 |
|------|--------|-------|------|
| Coverage | 75.0% | 85.0% | +10.0% |
| ESLint errors | 5 | 0 | -5 |
```

### Step 3: テスト確認

```bash
npm run test:unit
npm run lint
npx tsc --noEmit
```

---

## 4. 緊急対応フロー

本番環境で問題が発生した際の緊急対応ワークフローです。

### Step 1: 状況確認

```bash
# 最新のログを確認
tail -100 logs/error.log

# 環境変数を確認
cat .env.production
```

### Step 2: 緊急修正

```
/bug-fix 本番環境でAPIエラーが発生
```

**重大度をcriticalに設定**:
- 優先的に対策案1を実施
- テスト実行
- 即時デプロイ準備

### Step 3: hotfixブランチ作成

```bash
git checkout -b hotfix/critical-api-fix
```

### Step 4: PR作成（緊急マージ）

```
/create-pr
```

---

## 5. 完全自動開発フロー

Issue番号を指定するだけで、開発完了まで自動実行するフローです。

### 実行

```
/pm-auto-dev 166
```

### 自動実行内容

```
Phase 1: Issue情報収集完了
  - Issue #166: 新機能追加
  - 受入条件: 3件
  - 実装タスク: 5件

Phase 2: TDD実装 (イテレーション 1/3)
  - tdd-impl-agent を起動中...
  - カバレッジ: 85%
  - テスト: 15/15 passed

Phase 3: 受入テスト
  - acceptance-test-agent を起動中...
  - テストシナリオ: 3/3 passed

Phase 4: リファクタリング
  - refactoring-agent を起動中...
  - カバレッジ: 85% → 88%

Phase 5: 進捗報告
  - progress-report-agent を起動中...
  - レポート作成完了

Issue #166 の開発が完了しました！
```

### 完了後

```
/create-pr
```

---

## 6. TDD単独実行フロー

TDD実装のみを実行するフローです。

### 実行

```
/tdd-impl 新しいAPIエンドポイント
```

### TDDサイクル

**Red Phase**:
```typescript
// tests/unit/api.test.ts
it('should return data', async () => {
  const result = await fetchData()
  expect(result).toBeDefined()
})
```

**Green Phase**:
```typescript
// src/lib/api.ts
export async function fetchData() {
  return { data: 'test' }
}
```

**Refactor Phase**:
- コード改善
- テスト再実行

### 結果

```
TDD実装完了

## テスト結果
- Total: 5 tests
- Passed: 5
- Coverage: 90%

## 静的解析
- ESLint: 0 errors
- TypeScript: 0 errors
```

---

## コマンド使用のベストプラクティス

### 1. 計画から始める

```
/work-plan → /pm-auto-dev → /create-pr
```

### 2. 定期的に進捗確認

```
/progress-report 123
```

### 3. 品質チェックを徹底

```bash
npm run lint
npx tsc --noEmit
npm run test:unit
npm run build
```

### 4. コミットメッセージ規約

```
feat(scope): add new feature
fix(scope): fix bug
refactor(scope): refactor code
test(scope): add tests
docs(scope): update documentation
```

---

## 関連ドキュメント

- [クイックスタートガイド](./quick-start.md) - 5分で始める開発フロー
- [コマンド利用ガイド](./commands-guide.md) - コマンドの詳細
- [エージェント利用ガイド](./agents-guide.md) - エージェントの詳細
