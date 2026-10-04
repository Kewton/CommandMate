# リファクタリングコアプロンプト

**整理は振る舞いを変えない。既存のテストを書き換えずに通す。**

このプロンプトは、スラッシュコマンドとサブエージェントの両方から実行されます。

---

## 整理の決まり（下のどの手順よりも優先する）

- **振る舞いを変えない。** 新しい分岐・正規表現・文言・ログ名・待ち時間・キーの並びを足さない、変えない
- **既存のテストを書き換えずに通す。** テストを消さない。題名も変えない。
  テストを変えずに通らないときは、無理に通さない。変更を戻して、理由を報告する
- **カバレッジを上げるためのテストの追加は、整理とは別の PR にする。** カバレッジ 80% は、整理の目標ではない
- **整理と、振る舞いの変更を同じ PR に入れない。** 見つけた不具合や食い違いは、直さずに報告する

契約付きで整理を委任するときの決まり（新しいモジュールに置く、コメントを一緒に移す、採用の基準）は、
`.claude/commands/orchestrate.md` の 2-4-3 にある。

---

## 入力情報の取得

### スラッシュコマンドモードの場合

ユーザーから対話的に以下の情報を取得してください：

```bash
# Issue情報を取得
gh issue view {issue_number} --json number,title,body
```

- Issue番号
- リファクタリング対象（ファイル、クラス、関数など）
- 現在の品質メトリクス（カバレッジなど）
- 適用する設計パターン（あれば）

### サブエージェントモードの場合

コンテキストファイルから情報を取得してください：

```bash
# 最新のコンテキストファイルを探す
CONTEXT_FILE=$(find dev-reports/issue/*/pm-auto-dev/iteration-*/refactor-context.json 2>/dev/null | sort -V | tail -1)

if [ -z "$CONTEXT_FILE" ]; then
    echo "Error: refactor-context.json not found"
    exit 1
fi

echo "Context file: $CONTEXT_FILE"
cat "$CONTEXT_FILE"
```

コンテキストファイル構造:
```json
{
  "issue_number": 166,
  "refactor_targets": [
    "src/lib/xxx.ts",
    "src/components/xxx.tsx"
  ],
  "quality_metrics": {
    "before_coverage": 75.0
  },
  "improvement_goals": [
    "長い関数の分割",
    "重複コードの削除"
  ]
}
```

`improvement_goals` にカバレッジの目標（「カバレッジを80%以上に向上」など）が入っていても、整理の目標にはしない。
カバレッジは前後の値を記録するだけにする。テストの追加が要ると判断したら、足さずに、結果（ターミナルの表示、または結果ファイルの `message`）に書いて報告する。

---

## リファクタリング実行フロー

### Phase 1: コード品質分析

現在のコード品質を分析します。

#### カバレッジ測定
```bash
npm run test:unit -- --coverage
```

#### 静的解析
```bash
# ESLint
npm run lint

# TypeScript
npx tsc --noEmit
```

---

### Phase 2: リファクタリング計画

改善すべき箇所を特定し、リファクタリング計画を立てます。

#### コードスメルの特定
- 長いメソッド（50行以上）
- 大きなファイル（500行以上）
- 重複コード
- マジックナンバー
- 不適切な命名

#### 設計パターンの適用検討
- Repository Pattern（データアクセス層の抽象化）
- Factory Pattern（オブジェクト生成の集約）
- Strategy Pattern（アルゴリズムの切り替え）
- Dependency Injection（依存関係の注入）

---

### Phase 3: リファクタリング実行

**重要**: リファクタリングは小さなステップで行い、**各ステップごとにテストを実行**してください。

#### ステップ1: 関数抽出

長い関数を小さな関数に分割：

```typescript
// Before
function processData(data: Data): Result {
  // 50行の長い関数
  ...
}

// After
function processData(data: Data): Result {
  const validated = validateData(data)
  const transformed = transformData(validated)
  return createResult(transformed)
}

function validateData(data: Data): ValidatedData {
  ...
}
```

**テスト実行**:
```bash
npm run test:unit -- tests/unit/xxx.test.ts
```

#### ステップ2: コンポーネント分割

大きなコンポーネントを責任ごとに分割：

```typescript
// Before: 大きなコンポーネント
export function Dashboard() {
  // 多くの責任を持つ
}

// After: 責任ごとに分割
export function Dashboard() {
  return (
    <>
      <DashboardHeader />
      <DashboardContent />
      <DashboardFooter />
    </>
  )
}
```

#### ステップ3: 重複コード削除

共通処理をユーティリティ関数に抽出：

```typescript
// Before
function processA() {
  // 共通処理
}

function processB() {
  // 共通処理（重複）
}

// After
function commonProcess() {
  // 共通処理
}

function processA() {
  commonProcess()
}

function processB() {
  commonProcess()
}
```

---

### Phase 4: テスト追加は別の PR にする

整理の PR では、テストを追加しない。既存のテストは書き換えない。

- カバレッジを上げるためのテストの追加は、整理とは別の PR にする
- 目標カバレッジ（80%）は、整理の目標ではない
- カバーされていないコードを見つけたら、テストを足さずに、場所を結果（ターミナルの表示、または結果ファイルの `message`）に書いて報告する

```bash
# カバレッジ確認（前後の値を記録するため。上げるためではない）
npm run test:unit -- --coverage
```

---

### Phase 5: 品質メトリクス再測定

リファクタリング後の品質を測定します：

```bash
# カバレッジ
npm run test:unit -- --coverage

# 静的解析
npm run lint
npx tsc --noEmit
```

改善前後のメトリクスを比較します。
カバレッジは、前後の値を記録する。上げることは整理の目標ではない。

---

### Phase 6: Commit

リファクタリングをコミットします：

```bash
git add .
git commit -m "$(cat <<'EOF'
refactor(xxx): improve code quality

Apply refactoring to improve overall code maintainability.

Improvements:
- Split large functions into smaller, focused functions
- Remove code duplication
- Improve naming clarity

Quality Metrics:
- Coverage: 75% → 75% (tests unchanged)
- ESLint errors: 3 → 0
- TypeScript errors: 1 → 0

Resolves #166

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 出力

### スラッシュコマンドモードの場合

ターミナルに結果を表示してください：

```
リファクタリング完了

## リファクタリング内容
- 長い関数の分割
- 重複コードの削除
- 命名の改善

## 品質メトリクス改善
| 指標 | Before | After | 改善 |
|------|--------|-------|------|
| Coverage | 75.0% | 75.0% | ±0（テストは変えていない） |
| ESLint errors | 3 | 0 | -3 |
| TypeScript errors | 1 | 0 | -1 |

## ファイル変更
- src/lib/xxx.ts (リファクタリング)
- src/utils/helper.ts (新規)

## Commits
- abc1234: refactor(xxx): improve code quality
```

### サブエージェントモードの場合

結果ファイルをJSON形式で作成してください：

```bash
RESULT_FILE=$(dirname "$CONTEXT_FILE")/refactor-result.json
```

Write toolで以下の内容を作成:

```json
{
  "status": "success",
  "quality_metrics": {
    "before_coverage": 75.0,
    "after_coverage": 75.0
  },
  "refactorings_applied": [
    "長い関数の分割",
    "重複コードの削除",
    "命名の改善"
  ],
  "files_changed": [
    "src/lib/xxx.ts",
    "src/utils/helper.ts"
  ],
  "static_analysis": {
    "eslint_errors_before": 3,
    "eslint_errors_after": 0,
    "typescript_errors_before": 1,
    "typescript_errors_after": 0
  },
  "commits": [
    "abc1234: refactor(xxx): improve code quality"
  ],
  "message": "リファクタリング完了。品質メトリクス改善。"
}
```

---

## エラーハンドリング

### テストが失敗した場合

```json
{
  "status": "failed",
  "error": "リファクタリング後にテストが失敗しました",
  "failed_tests": ["test_xxx: AssertionError"],
  "message": "リファクタリングを見直してください"
}
```

---

## リファクタリング原則

1. **小さなステップで進める** - 各ステップでテストを実行
2. **既存のテストで確かめる** - 既存のテストを書き換えずに通す。テストの追加は別の PR にする
3. **SOLID原則を守る** - 単一責任、開放/閉鎖、リスコフ置換、インターフェース分離、依存性逆転
4. **KISS原則** - シンプルに保つ
5. **DRY原則** - 重複を避ける

---

## 完了条件

以下をすべて満たすこと：

- すべてのテストが成功（既存のテストを書き換えていない）
- 品質メトリクスが改善（重複・関数の長さ・静的解析。カバレッジを上げることは条件にしない）
- 静的解析エラーがゼロ
- コミットが完了（スラッシュコマンドモード）
- 結果ファイルが作成済み（サブエージェントモード）
