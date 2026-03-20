---
model: sonnet
description: "UAT不合格→featureブランチ修正→再PR→再マージ→再UATの修正ループを自動化"
---

# UAT修正ループ

## 概要
受入テスト（UAT）で不合格となったIssueについて、featureブランチでの修正→再PR→再マージ→再UATのサイクルを自動化します。全テストがPASSするか、最大リトライ回数に達するまでループを繰り返します。

## 使用方法
- `/uat-fix-loop [Issue番号1] [Issue番号2] ...`
- `/uat-fix-loop [Issue番号] --max-retry 5` （最大リトライ回数を指定）

## 前提条件
- developブランチ上で実行すること
- 直前に `/uat` が実行済みで、FAILしたテスト項目があること
- FAILしたIssueのfeatureブランチ worktreeが存在すること
- CommandMateサーバーが稼働していること

## 実行内容

あなたはQAマネージャーとして、UAT不合格項目の修正サイクルを統括します。

### パラメータ
- **issue_numbers**: 修正対象のIssue番号（スペース区切り）
- **--max-retry**: 最大リトライ回数（デフォルト: 3）

---

## Step 0: 初期設定

TodoWriteツールで作業計画を作成：

```
- [ ] Step 1: UAT結果の分析
- [ ] Step 2: 修正指示の送信
- [ ] Step 3: 修正完了待ち・品質確認
- [ ] Step 4: 再PR・再マージ
- [ ] Step 5: 再UAT
- [ ] Step 6: 結果判定（→ ループ or 完了）
```

---

## Step 1: UAT結果の分析

### 1-1. 直前のUATレポートを読み込む

各Issueについて、最新のUATレポートからFAIL項目を抽出：

```bash
for issue_num in {issue_numbers}; do
  # UATレポートを確認
  ls dev-reports/issue/${issue_num}/uat/
  cat dev-reports/issue/${issue_num}/uat/test-results.json 2>/dev/null
done
```

### 1-2. FAIL項目の整理

各FAIL項目について以下を記録：
- **テストID**: テスト項目の識別子
- **テスト項目名**: 何をテストしたか
- **期待結果**: 何が期待されていたか
- **実際の結果**: 何が起きたか
- **エビデンス**: テスト出力の関連部分

### 1-3. 修正対象のworktree特定

```bash
for issue_num in {issue_numbers}; do
  WT_ID=$(commandmatedev ls --branch "feature/${issue_num}" --quiet)
  echo "Issue #${issue_num} → Worktree: ${WT_ID}"
done
```

worktreeが見つからない場合はエラー報告して中断。

---

## Step 2: 修正指示の送信

各FAILしたIssueのワーカーに修正指示を送信。

### 2-1. 修正指示メッセージの構築

FAIL項目の情報を具体的に含めた修正指示を構築する：

```
受入テスト（UAT）で以下のテスト項目がFAILしました。修正してください。

## FAIL項目

### {テストID}: {テスト項目名}
- 期待結果: {期待されていた動作}
- 実際の結果: {実際に起きた動作}
- エビデンス: {テスト出力の関連部分}
- 推定原因: {ログから推定される原因}

## 修正後の確認事項

修正が完了したら、以下を順に実行してください:
1. npm run lint
2. npx tsc --noEmit
3. npm run test:unit
4. 修正内容をコミット
5. git push
```

### 2-2. 送信

```bash
for each fail_issue:
  commandmatedev send <worktree-id> "{修正指示メッセージ}" \
    --auto-yes --duration 2h
```

**修正指示が並列送信可能な場合**（独立したIssueのFAIL）は並列で送信する。

---

## Step 3: 修正完了待ち・品質確認

### 3-1. 完了待機

```bash
for each worktree:
  commandmatedev wait <worktree-id> --timeout 7200
  EXIT=$?
  if [ "$EXIT" -eq 10 ]; then
    # プロンプト検出 → 内容確認して応答
    commandmatedev respond <worktree-id> "yes"
    commandmatedev wait <worktree-id> --timeout 7200
  fi
```

### 3-2. 修正結果の確認

```bash
for each worktree:
  commandmatedev capture <worktree-id>
```

ワーカーの出力から以下を確認：
- 修正コミットが作成されていること
- ESLint / TypeScript エラー0件
- テスト全パス
- git push が完了していること

### 3-3. 品質NGの場合

追加の修正指示を送信：

```bash
commandmatedev send <worktree-id> \
  "品質チェックが不合格です。以下を修正してください: {具体的な問題}" \
  --auto-yes --duration 1h
```

---

## Step 4: 再PR・再マージ

### 4-1. 既存PRの状態確認

```bash
for issue_num in {issue_numbers}; do
  gh pr list --repo Kewton/MyCodeBranchDesk \
    --head "feature/${issue_num}-worktree" \
    --state all --json number,state -q '.[0] | "\(.number) \(.state)"'
done
```

### 4-2. PRの状態に応じた対応

- **OPEN**: pushで自動更新済み。CIの通過を待つ。
  ```bash
  gh pr checks <PR_NUM> --repo Kewton/MyCodeBranchDesk --watch
  ```

- **MERGED**: 修正コミットのための新規PR作成が必要。
  ```bash
  commandmatedev send <worktree-id> "/create-pr" --auto-yes --duration 1h
  commandmatedev wait <worktree-id> --timeout 600
  ```

- **CLOSED**: 再オープンまたは新規PR作成。
  ```bash
  commandmatedev send <worktree-id> "/create-pr" --auto-yes --duration 1h
  commandmatedev wait <worktree-id> --timeout 600
  ```

### 4-3. CI通過待ち

```bash
for each PR:
  gh pr checks <PR_NUM> --repo Kewton/MyCodeBranchDesk --watch
```

CI失敗時はワーカーに修正指示（最大3回）。

### 4-4. マージ（順次）

```bash
for each PR:
  # コンフリクト確認
  gh pr view <PR_NUM> --repo Kewton/MyCodeBranchDesk --json mergeable

  # コンフリクト時はワーカーに rebase 指示
  # （必要に応じて）

  # マージ
  gh pr merge <PR_NUM> --merge --repo Kewton/MyCodeBranchDesk

  # develop更新・ビルド検証
  git pull origin develop
  npm run lint && npx tsc --noEmit && npm run test:unit && npm run build
```

### 4-5. コンフリクト発生時

```bash
commandmatedev send <worktree-id> \
  "developの最新を取り込み、コンフリクトを解消してください:
  git fetch origin develop && git rebase origin/develop
  解消後 npm run lint && npm run test:unit で確認し、git push --force-with-lease してください" \
  --auto-yes --duration 1h

commandmatedev wait <worktree-id> --timeout 3600
```

---

## Step 5: 再UAT

### 5-1. develop更新

```bash
git pull origin develop
```

### 5-2. 受入テスト実行

修正したIssueのみ再テスト：

```bash
/uat {fail_issue_numbers}
```

回帰確認が必要な場合は全Issue:

```bash
/uat {all_issue_numbers}
```

判断基準:
- 修正が該当Issue内で完結 → 該当Issueのみ
- 共通モジュールに修正が入った → 全Issue

---

## Step 6: 結果判定

### 6-1. 全PASS → 完了

```
UAT修正ループ完了

  Issue #24: 4/4 PASS (100%) → ACCEPTED [第2回]
  Issue #25: 5/5 PASS (100%) → ACCEPTED [第1回]（修正不要だった）

  修正ループ回数: 1回
  修正内容: テスト項目の不具合を修正
```

### 6-2. FAILが残っている

**retry_count < max_retry の場合**: Step 1 に戻る

次のリトライでは前回との差分も含めて修正指示を強化：

| リトライ回数 | 修正指示の強化内容 |
|-------------|------------------|
| 1回目 | FAIL項目とエビデンスをそのまま伝える |
| 2回目 | 前回の修正内容と今回のFAIL差分を比較して伝える |
| 3回目 | 問題を詳細に分析し、具体的なコード修正方針まで指示する |

**retry_count >= max_retry の場合**: ユーザーに判断を仰ぐ

```
UAT修正ループが最大リトライ回数（{max_retry}回）に達しました。

残りのFAIL項目:
- {テストID}: {テスト項目名}
  - 3回の修正を試みましたが解消されていません
  - 推定原因: {分析結果}

対応オプション:
1. 手動で修正する
2. リトライ回数を増やして続行（/uat-fix-loop {N} --max-retry 5）
3. 該当テスト項目のスコープを縮小してIssueを分割する
4. 該当テスト項目をスキップして先に進む（受入基準の見直し）

どの対応を取りますか？
```

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| developブランチでない | エラー表示し中断 |
| UATレポートが見つからない | `/uat` の実行を案内 |
| worktreeが存在しない | `/worktree-setup` を案内 |
| ワーカーの修正が7200秒タイムアウト | captureで状況確認→ユーザーに報告 |
| コンフリクト解消失敗 | ユーザーに報告して中断 |
| 最大リトライ超過 | ユーザーに対応オプションを提示 |

---

## 完了条件

- [ ] 全FAILテスト項目が修正されている
- [ ] 修正後のPRがdevelopにマージ済み
- [ ] 再UATで全テストPASS
- [ ] developブランチでのビルド・テストが全パス
- [ ] UATレポートが更新されている
- [ ] GitHub Issueコメントに最終結果が記録されている
- [ ] 結果サマリーがユーザーに報告されている

## 関連コマンド

- `/uat`: 受入テスト実行（このコマンドの前提）
- `/pr-merge-pipeline`: PR作成→マージ（修正PR用に内部で使用）
- `/create-pr`: 単一ワーカーでのPR作成
- `/orchestrate`: 上位オーケストレーション（開発〜UAT全体統括）
